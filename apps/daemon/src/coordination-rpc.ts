import type { Logger } from '@weft/core';
import type { Actor, TaskSnapshot } from '@weft/protocol';

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

export interface CoordinationRpcOptions {
  baseUrl: string;
  token: string;
  projectId: string;
  fetchImpl?: typeof fetch;
  logger?: Logger;
}

export class CoordinationRpc {
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
}