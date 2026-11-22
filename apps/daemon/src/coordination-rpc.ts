import type { Logger } from '@weft/core';
import type { Actor, TaskSnapshot } from '@weft/protocol';
import type {
  LeaseOutcome,
  MergeEntryView,
  MergeQueueClient,
  SpeculativeTreeView,
} from './merge-executor.js';

/**
 * Outbound daemon→server coordination RPC (team mode). The SSE coordination
 * link is server→daemon projection only; authoritative mutations (claim a task,
 * reserve files) must round-trip to the server's CAS endpoints. Authenticates
 * with the device's project token exactly like the outbox shipper. Solo mode has
 * no server, so this client is absent and the MCP backend uses local stores.
 */

export interface RpcReservation {
  id: string;
  project_id: string;
  repo_id: string;
  task_id: string | null;
  session_id: string | null;
  path_glob: string;
  mode: 'soft' | 'hard';
  holder_device_id: string | null;
  expires_at: string | null;
  renewed_at: string | null;
  grace_until: string | null;
  state: 'active' | 'released';
  lease_epoch: number;
  created_at: string;
  released_reason: string | null;
}

export type RpcClaimResult =
  | { ok: true; snapshot: TaskSnapshot; provisional: boolean }
  | { ok: false; reason: string; version: number; winner_claimant: Actor | null };

export interface RpcAcquireResult {
  status: 'acquired' | 'renewed' | 'denied';
  reservation: RpcReservation;
  reason?: string;
}

export interface RpcClaimInput {
  baseVersion?: number;
  claimant?: Actor;
  provisional?: boolean;
}

export interface RpcReserveInput {
  repo_id: string;
  task_id: string;
  path_glob: string;
  mode?: 'soft' | 'hard';
  ttl_ms?: number;
  session_id?: string;
}

export class CoordinationRpcError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'CoordinationRpcError';
  }
}

export interface RpcEnqueueInput {
  repo_id: string;
  task_id: string;
  branch: string;
  candidate_oid?: string;
  target_branch?: string;
  claimant_device_id?: string;
}

export interface RpcBaseline {
  id: string;
  project_id: string;
  repo_id: string;
  branch: string;
  commit_oid: string;
  state: string;
  validation_run_id: string | null;
  established_at: string;
}

export interface RpcRegression {
  id: string;
  project_id: string;
  repo_id: string;
  baseline_id: string;
  failure_fingerprint: string;
  state: string;
  suspected_changes: RpcRankedSuspect[] | null;
  confirmed_change_id: string | null;
  revert_oid: string | null;
}

export interface RpcRankedSuspect {
  rank: number;
  oid: string;
  task_id: string | null;
  subject: string;
  author_name: string;
  overlap: number;
  matched_paths: string[];
  score: number;
}

export interface RpcSuspectChange {
  oid: string;
  subject: string;
  author_name: string;
  authored_at: string;
  paths: string[];
  task_id?: string;
}

export interface RpcEstablishBaselineInput {
  repo_id: string;
  branch: string;
  commit_oid: string;
  validation_run_id?: string;
  check_results_summary?: Record<string, unknown>;
}

export interface RpcRecordRegressionInput {
  repo_id: string;
  baseline_id: string;
  failing_checks: { check_id: string; paths: string[] }[];
  changes?: RpcSuspectChange[];
}

export interface CoordinationRpcOptions {
  baseUrl: string;
  token: string;
  projectId: string;
  fetchImpl?: typeof fetch;
  logger?: Logger;
}

export class CoordinationRpc implements MergeQueueClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly projectId: string;
  private readonly fetchImpl: typeof fetch;
  private readonly logger: Logger | undefined;

  constructor(options: CoordinationRpcOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.token = options.token;
    this.projectId = options.projectId;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.logger = options.logger;
  }

  private async call(
    method: string,
    path: string,
    opts: { body?: Record<string, unknown>; query?: Record<string, string>; allow?: number[] } = {},
  ): Promise<{ status: number; json: Record<string, unknown> }> {
    const url = new URL(`${this.baseUrl}${path}`);
    url.searchParams.set('projectId', this.projectId);
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
    const hasBody = opts.body !== undefined;
    const res = await this.fetchImpl(url.toString(), {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(hasBody ? { 'content-type': 'application/json' } : {}),
      },
      ...(hasBody ? { body: JSON.stringify({ ...opts.body, projectId: this.projectId }) } : {}),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const allow = opts.allow ?? [200, 201];
    if (!allow.includes(res.status)) {
      const code = typeof json.error === 'string' ? json.error : 'rpc_error';
      const message = typeof json.message === 'string' ? json.message : `${method} ${path} failed: ${res.status}`;
      this.logger?.debug({ status: res.status, code, path }, 'coordination rpc error');
      throw new CoordinationRpcError(res.status, code, message);
    }
    return { status: res.status, json };
  }

  async getTask(taskId: string): Promise<TaskSnapshot | null> {
    const { status, json } = await this.call('GET', `/v1/tasks/${encodeURIComponent(taskId)}`, {
      allow: [200, 404],
    });
    if (status === 404) return null;
    return (json.task as TaskSnapshot) ?? null;
  }

  async claimTask(taskId: string, input: RpcClaimInput = {}): Promise<RpcClaimResult> {
    const { json } = await this.call('POST', `/v1/tasks/${encodeURIComponent(taskId)}/claim`, {
      body: {
        ...(input.baseVersion != null ? { baseVersion: input.baseVersion } : {}),
        ...(input.claimant != null ? { claimant: input.claimant } : {}),
        provisional: input.provisional ?? false,
      },
    });
    return json as unknown as RpcClaimResult;
  }

  async releaseTask(taskId: string, baseVersion: number): Promise<TaskSnapshot> {
    const { json } = await this.call('POST', `/v1/tasks/${encodeURIComponent(taskId)}/release`, {
      body: { baseVersion },
    });
    return json.task as TaskSnapshot;
  }

  async reserveFiles(input: RpcReserveInput): Promise<RpcAcquireResult> {
    const { json } = await this.call('POST', '/v1/reservations', {
      body: {
        repo_id: input.repo_id,
        task_id: input.task_id,
        path_glob: input.path_glob,
        mode: input.mode ?? 'soft',
        ...(input.ttl_ms != null ? { ttl_ms: input.ttl_ms } : {}),
        ...(input.session_id != null ? { session_id: input.session_id } : {}),
      },
      allow: [200, 201, 409],
    });
    return json as unknown as RpcAcquireResult;
  }

  async renewReservation(id: string, taskId: string, ttlMs?: number): Promise<RpcReservation> {
    const { json } = await this.call('POST', `/v1/reservations/${encodeURIComponent(id)}/renew`, {
      body: { task_id: taskId, ...(ttlMs != null ? { ttl_ms: ttlMs } : {}) },
    });
    return json.reservation as RpcReservation;
  }

  async releaseReservation(id: string, taskId: string, reason?: string): Promise<RpcReservation> {
    const { json } = await this.call('POST', `/v1/reservations/${encodeURIComponent(id)}/release`, {
      body: { task_id: taskId, ...(reason != null ? { reason } : {}) },
    });
    return json.reservation as RpcReservation;
  }

  async listReservations(opts: { repoId?: string; taskId?: string; state?: 'active' | 'released' } = {}): Promise<RpcReservation[]> {
    const query: Record<string, string> = {};
    if (opts.repoId) query.repoId = opts.repoId;
    if (opts.taskId) query.taskId = opts.taskId;
    if (opts.state) query.state = opts.state;
    const { json } = await this.call('GET', '/v1/reservations', { query });
    return (json.reservations as RpcReservation[]) ?? [];
  }

  // --- Merge queue (MergeQueueClient: the executor's authoritative surface) ---
  async acquireLease(repoId: string, deviceId: string, ttlMs?: number): Promise<LeaseOutcome> {
    const { json } = await this.call('POST', '/v1/merge/lease', {
      body: { repo_id: repoId, device_id: deviceId, ...(ttlMs != null ? { ttl_ms: ttlMs } : {}) },
      allow: [200, 201, 409],
    });
    return json as unknown as LeaseOutcome;
  }

  async renewLease(repoId: string, deviceId: string, ttlMs?: number): Promise<LeaseOutcome['lease']> {
    const { json } = await this.call('POST', '/v1/merge/lease/renew', {
      body: { repo_id: repoId, device_id: deviceId, ...(ttlMs != null ? { ttl_ms: ttlMs } : {}) },
    });
    return json.lease as LeaseOutcome['lease'];
  }

  async releaseLease(repoId: string, deviceId: string): Promise<LeaseOutcome['lease']> {
    const { json } = await this.call('POST', '/v1/merge/lease/release', {
      body: { repo_id: repoId, device_id: deviceId },
    });
    return json.lease as LeaseOutcome['lease'];
  }

  async getLease(repoId: string): Promise<LeaseOutcome['lease'] | null> {
    const { json } = await this.call('GET', '/v1/merge/lease', { query: { repoId } });
    return (json.lease as LeaseOutcome['lease']) ?? null;
  }

  async enqueue(input: RpcEnqueueInput): Promise<MergeEntryView> {
    const { json } = await this.call('POST', '/v1/merge/enqueue', {
      body: {
        repo_id: input.repo_id,
        task_id: input.task_id,
        branch: input.branch,
        ...(input.candidate_oid != null ? { candidate_oid: input.candidate_oid } : {}),
        ...(input.target_branch != null ? { target_branch: input.target_branch } : {}),
        ...(input.claimant_device_id != null ? { claimant_device_id: input.claimant_device_id } : {}),
      },
    });
    return json.entry as MergeEntryView;
  }

  async claimNext(repoId: string, deviceId: string, leaseEpoch: number): Promise<MergeEntryView | null> {
    const { json } = await this.call('POST', '/v1/merge/claim', {
      body: { repo_id: repoId, device_id: deviceId, lease_epoch: leaseEpoch },
    });
    return (json.entry as MergeEntryView) ?? null;
  }

  async recordSpeculativeTree(
    entryId: string,
    input: SpeculativeTreeView,
    deviceId: string,
    leaseEpoch: number,
  ): Promise<MergeEntryView> {
    const { json } = await this.call('POST', `/v1/merge/entries/${encodeURIComponent(entryId)}/speculative-tree`, {
      body: { ...input, device_id: deviceId, lease_epoch: leaseEpoch },
    });
    return json.entry as MergeEntryView;
  }

  async attachValidation(entryId: string, validationRunId: string, deviceId: string, leaseEpoch: number): Promise<MergeEntryView> {
    const { json } = await this.call('POST', `/v1/merge/entries/${encodeURIComponent(entryId)}/attach-validation`, {
      body: { validation_run_id: validationRunId, device_id: deviceId, lease_epoch: leaseEpoch },
    });
    return json.entry as MergeEntryView;
  }

  async advance(entryId: string, mergedOid: string, deviceId: string, leaseEpoch: number): Promise<MergeEntryView> {
    const { json } = await this.call('POST', `/v1/merge/entries/${encodeURIComponent(entryId)}/advance`, {
      body: { merged_oid: mergedOid, device_id: deviceId, lease_epoch: leaseEpoch },
    });
    return json.entry as MergeEntryView;
  }

  async eject(entryId: string, reason: string, deviceId: string, leaseEpoch: number): Promise<MergeEntryView> {
    const { json } = await this.call('POST', `/v1/merge/entries/${encodeURIComponent(entryId)}/eject`, {
      body: { reason, device_id: deviceId, lease_epoch: leaseEpoch },
    });
    return json.entry as MergeEntryView;
  }

  async requeue(entryId: string): Promise<MergeEntryView> {
    const { json } = await this.call('POST', `/v1/merge/entries/${encodeURIComponent(entryId)}/requeue`, { body: {} });
    return json.entry as MergeEntryView;
  }

  async getEntry(entryId: string): Promise<MergeEntryView | null> {
    const { status, json } = await this.call('GET', `/v1/merge/entries/${encodeURIComponent(entryId)}`, { allow: [200, 404] });
    if (status === 404) return null;
    return (json.entry as MergeEntryView) ?? null;
  }

  async listEntries(opts: { repoId?: string; state?: string } = {}): Promise<MergeEntryView[]> {
    const query: Record<string, string> = {};
    if (opts.repoId) query.repoId = opts.repoId;
    if (opts.state) query.state = opts.state;
    const { json } = await this.call('GET', '/v1/merge/entries', { query });
    return (json.entries as MergeEntryView[]) ?? [];
  }

  // --- Repo health (baselines + regression attribution/confirmation) ---
  async establishBaseline(input: RpcEstablishBaselineInput): Promise<RpcBaseline> {
    const { json } = await this.call('POST', '/v1/health/baselines', {
      body: {
        repo_id: input.repo_id,
        branch: input.branch,
        commit_oid: input.commit_oid,
        ...(input.validation_run_id != null ? { validation_run_id: input.validation_run_id } : {}),
        ...(input.check_results_summary != null ? { check_results_summary: input.check_results_summary } : {}),
      },
    });
    return json.baseline as RpcBaseline;
  }

  async latestBaseline(repoId: string, branch: string): Promise<RpcBaseline | null> {
    const { json } = await this.call('GET', '/v1/health/baselines/latest', { query: { repoId, branch } });
    return (json.baseline as RpcBaseline) ?? null;
  }

  async recordRegression(input: RpcRecordRegressionInput): Promise<RpcRegression> {
    const { json } = await this.call('POST', '/v1/health/regressions', {
      body: {
        repo_id: input.repo_id,
        baseline_id: input.baseline_id,
        failing_checks: input.failing_checks,
        ...(input.changes != null ? { changes: input.changes } : {}),
      },
    });
    return json.regression as RpcRegression;
  }

  async attributeRegression(regressionId: string, changes: RpcSuspectChange[]): Promise<RpcRankedSuspect[]> {
    const { json } = await this.call('POST', `/v1/health/regressions/${encodeURIComponent(regressionId)}/attribute`, {
      body: { changes },
    });
    return (json.suspects as RpcRankedSuspect[]) ?? [];
  }

  async confirmRegression(regressionId: string, confirmedChangeId: string, revertOid?: string): Promise<RpcRegression> {
    const { json } = await this.call('POST', `/v1/health/regressions/${encodeURIComponent(regressionId)}/confirm`, {
      body: { confirmed_change_id: confirmedChangeId, ...(revertOid != null ? { revert_oid: revertOid } : {}) },
    });
    return json.regression as RpcRegression;
  }

  async getRegression(regressionId: string): Promise<RpcRegression | null> {
    const { status, json } = await this.call('GET', `/v1/health/regressions/${encodeURIComponent(regressionId)}`, { allow: [200, 404] });
    if (status === 404) return null;
    return (json.regression as RpcRegression) ?? null;
  }
}