import type { Client, Pool } from 'pg';
import { z } from 'zod';
import { metrics, type Logger } from '@weft/core';
import { makeId, type Actor, type MergeState } from '@weft/protocol';
import { withTransaction, clientExecutor } from './pg.js';
import { appendCoordinationEvent } from './emit.js';
import { recordAudit } from './audit.js';
import type { Origin } from './tasks-service.js';

const queued = metrics.counter('weft_server_merge_queued_total', 'Merge queue entries enqueued');
const merged = metrics.counter('weft_server_merge_merged_total', 'Merge queue entries merged');
const ejected = metrics.counter('weft_server_merge_ejected_total', 'Merge queue entries ejected');
const requeued = metrics.counter('weft_server_merge_requeued_total', 'Merge queue entries requeued');
const leaseAcquired = metrics.counter('weft_server_merge_lease_acquired_total', 'Executor leases acquired');
const leaseDenied = metrics.counter('weft_server_merge_lease_denied_total', 'Executor lease acquires denied');
const unvalidatedBlocked = metrics.counter(
  'weft_server_merge_unvalidated_blocked_total',
  'Advance attempts blocked for lacking passing independent validation',
);

export const DEFAULT_EXECUTOR_TTL_MS = 60_000;
export const DEFAULT_EXECUTOR_GRACE_MS = 15_000;

function toIso(value: unknown): string | null {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

export interface MergeQueueEntry {
  id: string;
  project_id: string;
  repo_id: string;
  task_id: string;
  position: number;
  state: MergeState;
  branch: string | null;
  candidate_oid: string | null;
  target_branch: string;
  speculative_tree_oid: string | null;
  base_oid: string | null;
  push_precondition_oid: string | null;
  validation_run_id: string | null;
  merged_oid: string | null;
  ejected_reason: string | null;
  executor_device_id: string | null;
  lease_epoch: number;
  attempts: number;
  created_at: string;
}

const ENTRY_COLS = `id, project_id, repo_id, task_id, position, state, branch, candidate_oid,
  target_branch, speculative_tree_oid, base_oid, push_precondition_oid, validation_run_id,
  merged_oid, ejected_reason, executor_device_id, lease_epoch, attempts, created_at`;

function rowToEntry(r: Record<string, unknown>): MergeQueueEntry {
  return {
    id: String(r.id),
    project_id: String(r.project_id),
    repo_id: String(r.repo_id),
    task_id: String(r.task_id),
    position: Number(r.position),
    state: String(r.state) as MergeState,
    branch: r.branch == null ? null : String(r.branch),
    candidate_oid: r.candidate_oid == null ? null : String(r.candidate_oid),
    target_branch: String(r.target_branch),
    speculative_tree_oid: r.speculative_tree_oid == null ? null : String(r.speculative_tree_oid),
    base_oid: r.base_oid == null ? null : String(r.base_oid),
    push_precondition_oid: r.push_precondition_oid == null ? null : String(r.push_precondition_oid),
    validation_run_id: r.validation_run_id == null ? null : String(r.validation_run_id),
    merged_oid: r.merged_oid == null ? null : String(r.merged_oid),
    ejected_reason: r.ejected_reason == null ? null : String(r.ejected_reason),
    executor_device_id: r.executor_device_id == null ? null : String(r.executor_device_id),
    lease_epoch: Number(r.lease_epoch),
    attempts: Number(r.attempts),
    created_at: String(toIso(r.created_at)),
  };
}

export interface ExecutorLease {
  project_id: string;
  repo_id: string;
  holder_device_id: string | null;
  lease_epoch: number;
  expires_at: string | null;
  renewed_at: string | null;
  grace_until: string | null;
  state: 'idle' | 'held';
}

const LEASE_COLS = `project_id, repo_id, holder_device_id, lease_epoch, expires_at, renewed_at, grace_until, state`;

function rowToLease(r: Record<string, unknown>): ExecutorLease {
  return {
    project_id: String(r.project_id),
    repo_id: String(r.repo_id),
    holder_device_id: r.holder_device_id == null ? null : String(r.holder_device_id),
    lease_epoch: Number(r.lease_epoch),
    expires_at: toIso(r.expires_at),
    renewed_at: toIso(r.renewed_at),
    grace_until: toIso(r.grace_until),
    state: String(r.state) as 'idle' | 'held',
  };
}

function leaseExpiry(lease: ExecutorLease): number | null {
  const end = lease.grace_until ?? lease.expires_at;
  return end == null ? null : Date.parse(end);
}

export type MergeQueueErrorCode =
  | 'not_found'
  | 'validation'
  | 'invalid_transition'
  | 'forbidden'
  | 'lease_required'
  | 'evidence_required';

export class MergeQueueError extends Error {
  constructor(
    readonly code: MergeQueueErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'MergeQueueError';
  }
}

export const EnqueueMergeSchema = z.object({
  repo_id: z.string().min(1),
  task_id: z.string().min(1),
  branch: z.string().min(1),
  candidate_oid: z.string().min(1).optional(),
  target_branch: z.string().min(1).default('main'),
});
export type EnqueueMergeInput = z.input<typeof EnqueueMergeSchema>;

export const SpeculativeTreeSchema = z.object({
  speculative_tree_oid: z.string().min(1),
  base_oid: z.string().min(1),
  push_precondition_oid: z.string().min(1),
  candidate_oid: z.string().min(1).optional(),
});
export type SpeculativeTreeInput = z.input<typeof SpeculativeTreeSchema>;

export interface LeaseResult {
  status: 'acquired' | 'renewed' | 'denied';
  lease: ExecutorLease;
  reason?: string;
}

export interface MergeListOptions {
  repoId?: string;
  state?: MergeState;
  limit?: number;
}

/**
 * Server-authoritative merge queue. One lease-elected executor daemon per
 * (project, repo) drives entries queued→testing→merged. The lease_epoch is a
 * fencing token: after a failover the successor re-claims orphaned testing
 * entries under a new epoch, and a stale executor can never advance under an old
 * one. advance() is the never-merge-unvalidated gate — it requires a passing
 * INDEPENDENT validation run (runner device ≠ claimant) for the exact speculative
 * tree, and is idempotent so a double-report after failover never re-emits. The
 * actual git CAS push happens on the executor; the server records the landed oid.
 */
export class MergeQueueService {
  constructor(
    private readonly pool: Pool,
    private readonly serverDeviceId: string,
    private readonly logger?: Logger,
    private readonly graceMs: number = DEFAULT_EXECUTOR_GRACE_MS,
  ) {}

  // -------------------------------------------------------------------------
  // Executor lease election (CAS, epoch-fenced)
  // -------------------------------------------------------------------------
  async acquireExecutorLease(
    projectId: string,
    repoId: string,
    deviceId: string,
    origin: Origin,
    ttlMs: number = DEFAULT_EXECUTOR_TTL_MS,
  ): Promise<LeaseResult> {
    return withTransaction(this.pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `${projectId}:merge-lease:${repoId}`,
      ]);
      const lease = await this.lockLease(client, projectId, repoId);
      const now = Date.now();
      const end = leaseExpiry(lease);
      if (lease.state === 'held' && lease.holder_device_id === deviceId && (end == null || now < end)) {
        const next = this.extendLease(lease, deviceId, now, ttlMs);
        await this.writeLease(client, next);
        await this.audit(client, projectId, origin.actor, 'merge.lease_renewed', repoId);
        return { status: 'renewed', lease: next };
      }
      if (lease.state === 'held' && end != null && now < end) {
        leaseDenied.inc();
        return { status: 'denied', lease, reason: 'held' };
      }
      const next = this.extendLease(lease, deviceId, now, ttlMs);
      await this.writeLease(client, next);
      await this.audit(client, projectId, origin.actor, 'merge.lease_acquired', repoId);
      leaseAcquired.inc();
      this.logger?.debug({ projectId, repoId, deviceId, epoch: next.lease_epoch }, 'merge executor lease acquired');
      return { status: 'acquired', lease: next };
    });
  }

  async renewExecutorLease(
    projectId: string,
    repoId: string,
    deviceId: string,
    origin: Origin,
    ttlMs: number = DEFAULT_EXECUTOR_TTL_MS,
  ): Promise<ExecutorLease> {
    return withTransaction(this.pool, async (client) => {
      const lease = await this.lockLease(client, projectId, repoId);
      if (lease.state !== 'held' || lease.holder_device_id !== deviceId)
        throw new MergeQueueError('forbidden', 'only the lease holder may renew');
      const now = Date.now();
      const end = leaseExpiry(lease);
      if (end != null && now >= end)
        throw new MergeQueueError('invalid_transition', 'executor lease lapsed past grace');
      const next = this.extendLease(lease, deviceId, now, ttlMs);
      await this.writeLease(client, next);
      await this.audit(client, projectId, origin.actor, 'merge.lease_renewed', repoId);
      return next;
    });
  }

  async releaseExecutorLease(projectId: string, repoId: string, deviceId: string, origin: Origin): Promise<ExecutorLease> {
    return withTransaction(this.pool, async (client) => {
      const lease = await this.lockLease(client, projectId, repoId);
      if (lease.holder_device_id !== deviceId)
        throw new MergeQueueError('forbidden', 'only the lease holder may release');
      const next: ExecutorLease = { ...lease, holder_device_id: null, state: 'idle', expires_at: null, grace_until: null };
      await this.writeLease(client, next);
      await this.audit(client, projectId, origin.actor, 'merge.lease_released', repoId);
      return next;
    });
  }

  async getExecutorLease(projectId: string, repoId: string): Promise<ExecutorLease | undefined> {
    const res = await this.pool.query(
      `SELECT ${LEASE_COLS} FROM merge_queue_leases WHERE project_id=$1 AND repo_id=$2`,
      [projectId, repoId],
    );
    return res.rows[0] ? rowToLease(res.rows[0]) : undefined;
  }

  // -------------------------------------------------------------------------
  // Queue entries
  // -------------------------------------------------------------------------
  async enqueue(projectId: string, input: EnqueueMergeInput, origin: Origin): Promise<MergeQueueEntry> {
    const parsed = EnqueueMergeSchema.safeParse(input);
    if (!parsed.success)
      throw new MergeQueueError('validation', parsed.error.issues.map((i) => i.message).join('; '));
    const data = parsed.data;
    return withTransaction(this.pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `${projectId}:merge-queue:${data.repo_id}`,
      ]);
      const task = await client.query('SELECT 1 FROM tasks WHERE id=$1 AND project_id=$2', [data.task_id, projectId]);
      if (task.rows.length === 0) throw new MergeQueueError('not_found', `task ${data.task_id} not found`);
      const pos = await client.query(
        'SELECT COALESCE(MAX(position), 0) + 1 AS p FROM merge_queue_entries WHERE project_id=$1 AND repo_id=$2',
        [projectId, data.repo_id],
      );
      const entry: MergeQueueEntry = {
        id: makeId('merge'),
        project_id: projectId,
        repo_id: data.repo_id,
        task_id: data.task_id,
        position: Number(pos.rows[0]?.p),
        state: 'queued',
        branch: data.branch,
        candidate_oid: data.candidate_oid ?? null,
        target_branch: data.target_branch,
        speculative_tree_oid: null,
        base_oid: null,
        push_precondition_oid: null,
        validation_run_id: null,
        merged_oid: null,
        ejected_reason: null,
        executor_device_id: null,
        lease_epoch: 0,
        attempts: 0,
        created_at: new Date().toISOString(),
      };
      await this.insertEntry(client, entry);
      await this.emit(client, projectId, 'merge.queued', entry, origin.actor, {
        branch: entry.branch,
        target_branch: entry.target_branch,
        ...(entry.candidate_oid ? { candidate_oid: entry.candidate_oid } : {}),
      });
      await this.audit(client, projectId, origin.actor, 'merge.queued', entry.id);
      queued.inc();
      return entry;
    });
  }

  /**
   * Claim the head entry for the lease holder. Recovers orphaned testing entries
   * fenced under an older epoch (a dead executor's in-flight work) so a failover
   * successor re-reads origin and resumes — never a second concurrent executor.
   */
  async claimNext(
    projectId: string,
    repoId: string,
    deviceId: string,
    leaseEpoch: number,
    origin: Origin,
  ): Promise<MergeQueueEntry | null> {
    return withTransaction(this.pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `${projectId}:merge-queue:${repoId}`,
      ]);
      await this.requireLease(client, projectId, repoId, deviceId, leaseEpoch);
      const found = await client.query(
        `SELECT ${ENTRY_COLS} FROM merge_queue_entries
          WHERE project_id=$1 AND repo_id=$2
            AND (state='queued' OR (state='testing' AND lease_epoch < $3))
          ORDER BY position ASC LIMIT 1 FOR UPDATE`,
        [projectId, repoId, leaseEpoch],
      );
      const row = found.rows[0];
      if (!row) return null;
      const entry = rowToEntry(row);
      const next: MergeQueueEntry = {
        ...entry,
        state: 'testing',
        executor_device_id: deviceId,
        lease_epoch: leaseEpoch,
      };
      await this.writeEntry(client, next);
      await this.emit(client, projectId, 'merge.testing', next, origin.actor, {
        executor_device_id: deviceId,
        lease_epoch: leaseEpoch,
        ...(next.base_oid ? { base_oid: next.base_oid } : {}),
        ...(next.speculative_tree_oid ? { tree_oid: next.speculative_tree_oid } : {}),
      });
      await this.audit(client, projectId, origin.actor, 'merge.testing', next.id);
      return next;
    });
  }

  async recordSpeculativeTree(
    projectId: string,
    entryId: string,
    input: SpeculativeTreeInput,
    deviceId: string,
    leaseEpoch: number,
    origin: Origin,
  ): Promise<MergeQueueEntry> {
    const parsed = SpeculativeTreeSchema.safeParse(input);
    if (!parsed.success)
      throw new MergeQueueError('validation', parsed.error.issues.map((i) => i.message).join('; '));
    const data = parsed.data;
    return withTransaction(this.pool, async (client) => {
      const entry = await this.lockTestingEntry(client, projectId, entryId, deviceId, leaseEpoch);
      const next: MergeQueueEntry = {
        ...entry,
        speculative_tree_oid: data.speculative_tree_oid,
        base_oid: data.base_oid,
        push_precondition_oid: data.push_precondition_oid,
        candidate_oid: data.candidate_oid ?? entry.candidate_oid,
      };
      await this.writeEntry(client, next);
      await this.audit(client, projectId, origin.actor, 'merge.speculative_tree', next.id);
      return next;
    });
  }

  async attachValidation(
    projectId: string,
    entryId: string,
    validationRunId: string,
    deviceId: string,
    leaseEpoch: number,
    origin: Origin,
  ): Promise<MergeQueueEntry> {
    return withTransaction(this.pool, async (client) => {
      const entry = await this.lockTestingEntry(client, projectId, entryId, deviceId, leaseEpoch);
      const run = await client.query(
        'SELECT 1 FROM validation_runs WHERE id=$1 AND project_id=$2',
        [validationRunId, projectId],
      );
      if (run.rows.length === 0) throw new MergeQueueError('not_found', `validation run ${validationRunId} not found`);
      const next: MergeQueueEntry = { ...entry, validation_run_id: validationRunId };
      await this.writeEntry(client, next);
      await this.audit(client, projectId, origin.actor, 'merge.validation_attached', next.id);
      return next;
    });
  }

  /**
   * Record a landed merge. The never-merge-unvalidated gate: requires a passing
   * INDEPENDENT validation run for the exact speculative tree. Idempotent — a
   * second report (e.g. a failover successor confirming an already-landed push)
   * returns the merged entry without re-emitting.
   */
  async advance(
    projectId: string,
    entryId: string,
    mergedOid: string,
    deviceId: string,
    leaseEpoch: number,
    origin: Origin,
  ): Promise<MergeQueueEntry> {
    return withTransaction(this.pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `${projectId}:merge-queue:${entryId}`,
      ]);
      const entry = await this.lockEntry(client, projectId, entryId);
      if (entry.state === 'merged') return entry;
      if (entry.state !== 'testing')
        throw new MergeQueueError('invalid_transition', `cannot advance a ${entry.state} entry`);
      await this.requireLease(client, projectId, entry.repo_id, deviceId, leaseEpoch);
      if (entry.executor_device_id !== deviceId || entry.lease_epoch !== leaseEpoch)
        throw new MergeQueueError('forbidden', 'stale executor: entry fenced under a different epoch');
      if (!entry.speculative_tree_oid || !entry.validation_run_id)
        throw new MergeQueueError('evidence_required', 'entry has no speculative tree / validation run');
      const evidence = await client.query(
        `SELECT 1 FROM validation_runs
          WHERE id=$1 AND project_id=$2 AND state='passed'
            AND tree_oid=$3 AND independence='independent'`,
        [entry.validation_run_id, projectId, entry.speculative_tree_oid],
      );
      if (evidence.rows.length === 0) {
        unvalidatedBlocked.inc();
        throw new MergeQueueError(
          'evidence_required',
          'queue never merges an unvalidated tree: no passing independent validation for the exact speculative tree',
        );
      }
      const next: MergeQueueEntry = { ...entry, state: 'merged', merged_oid: mergedOid };
      await this.writeEntry(client, next);
      await this.emit(client, projectId, 'merge.merged', next, origin.actor, {
        executor_device_id: deviceId,
        lease_epoch: leaseEpoch,
        merged_oid: mergedOid,
        ...(next.base_oid ? { base_oid: next.base_oid } : {}),
        ...(next.speculative_tree_oid ? { tree_oid: next.speculative_tree_oid } : {}),
      });
      await this.audit(client, projectId, origin.actor, 'merge.merged', next.id);
      merged.inc();
      this.logger?.info({ entryId, projectId, mergedOid }, 'merge queue entry merged');
      return next;
    });
  }

  async eject(
    projectId: string,
    entryId: string,
    reason: string,
    deviceId: string,
    leaseEpoch: number,
    origin: Origin,
  ): Promise<MergeQueueEntry> {
    return withTransaction(this.pool, async (client) => {
      const entry = await this.lockTestingEntry(client, projectId, entryId, deviceId, leaseEpoch);
      const next: MergeQueueEntry = { ...entry, state: 'ejected', ejected_reason: reason };
      await this.writeEntry(client, next);
      await this.emit(client, projectId, 'merge.ejected', next, origin.actor, {
        reason,
        executor_device_id: deviceId,
        lease_epoch: leaseEpoch,
      });
      await this.audit(client, projectId, origin.actor, 'merge.ejected', next.id);
      ejected.inc();
      return next;
    });
  }

  /** Requeue an ejected entry at the tail with a fresh attempt (work preserved). */
  async requeue(projectId: string, entryId: string, origin: Origin): Promise<MergeQueueEntry> {
    return withTransaction(this.pool, async (client) => {
      const entry = await this.lockEntry(client, projectId, entryId);
      if (entry.state !== 'ejected')
        throw new MergeQueueError('invalid_transition', `cannot requeue a ${entry.state} entry`);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `${projectId}:merge-queue:${entry.repo_id}`,
      ]);
      const pos = await client.query(
        'SELECT COALESCE(MAX(position), 0) + 1 AS p FROM merge_queue_entries WHERE project_id=$1 AND repo_id=$2',
        [projectId, entry.repo_id],
      );
      const next: MergeQueueEntry = {
        ...entry,
        state: 'queued',
        position: Number(pos.rows[0]?.p),
        attempts: entry.attempts + 1,
        speculative_tree_oid: null,
        base_oid: null,
        push_precondition_oid: null,
        validation_run_id: null,
        merged_oid: null,
        ejected_reason: null,
        executor_device_id: null,
        lease_epoch: 0,
      };
      await this.writeEntry(client, next);
      await this.emit(client, projectId, 'merge.queued', next, origin.actor, {
        branch: next.branch,
        target_branch: next.target_branch,
        requeued: true,
        attempts: next.attempts,
      });
      await this.audit(client, projectId, origin.actor, 'merge.requeued', next.id);
      requeued.inc();
      return next;
    });
  }

  async get(projectId: string, entryId: string): Promise<MergeQueueEntry | undefined> {
    const res = await this.pool.query(
      `SELECT ${ENTRY_COLS} FROM merge_queue_entries WHERE project_id=$1 AND id=$2`,
      [projectId, entryId],
    );
    return res.rows[0] ? rowToEntry(res.rows[0]) : undefined;
  }

  async list(projectId: string, options: MergeListOptions = {}): Promise<MergeQueueEntry[]> {
    const params: unknown[] = [projectId];
    let where = 'project_id = $1';
    if (options.repoId) {
      params.push(options.repoId);
      where += ` AND repo_id = $${params.length}`;
    }
    if (options.state) {
      params.push(options.state);
      where += ` AND state = $${params.length}`;
    }
    params.push(options.limit ?? 200);
    const res = await this.pool.query(
      `SELECT ${ENTRY_COLS} FROM merge_queue_entries WHERE ${where}
        ORDER BY position ASC LIMIT $${params.length}`,
      params,
    );
    return res.rows.map(rowToEntry);
  }

  // -------------------------------------------------------------------------
  // Internal helpers (locked client within a transaction)
  // -------------------------------------------------------------------------
  private extendLease(lease: ExecutorLease, deviceId: string, now: number, ttl: number): ExecutorLease {
    return {
      ...lease,
      holder_device_id: deviceId,
      state: 'held',
      lease_epoch: lease.lease_epoch + 1,
      expires_at: new Date(now + ttl).toISOString(),
      grace_until: new Date(now + ttl + this.graceMs).toISOString(),
      renewed_at: new Date(now).toISOString(),
    };
  }

  private async lockLease(client: Client, projectId: string, repoId: string): Promise<ExecutorLease> {
    const found = await client.query(
      `SELECT ${LEASE_COLS} FROM merge_queue_leases WHERE project_id=$1 AND repo_id=$2 FOR UPDATE`,
      [projectId, repoId],
    );
    const row = found.rows[0];
    if (row) return rowToLease(row);
    const lease: ExecutorLease = {
      project_id: projectId,
      repo_id: repoId,
      holder_device_id: null,
      lease_epoch: 0,
      expires_at: null,
      renewed_at: null,
      grace_until: null,
      state: 'idle',
    };
    await client.query(
      `INSERT INTO merge_queue_leases (${LEASE_COLS}) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [projectId, repoId, null, 0, null, null, null, 'idle'],
    );
    return lease;
  }

  private async writeLease(client: Client, lease: ExecutorLease): Promise<void> {
    await client.query(
      `UPDATE merge_queue_leases SET holder_device_id=$3, lease_epoch=$4, expires_at=$5,
          renewed_at=$6, grace_until=$7, state=$8 WHERE project_id=$1 AND repo_id=$2`,
      [
        lease.project_id, lease.repo_id, lease.holder_device_id, lease.lease_epoch,
        lease.expires_at, lease.renewed_at, lease.grace_until, lease.state,
      ],
    );
  }

  /** Verify the caller holds a live lease at the given fencing epoch. */
  private async requireLease(client: Client, projectId: string, repoId: string, deviceId: string, leaseEpoch: number): Promise<void> {
    const lease = await this.lockLease(client, projectId, repoId);
    if (lease.state !== 'held' || lease.holder_device_id !== deviceId)
      throw new MergeQueueError('lease_required', 'caller does not hold the executor lease');
    if (lease.lease_epoch !== leaseEpoch)
      throw new MergeQueueError('forbidden', 'stale lease epoch');
    const end = leaseExpiry(lease);
    if (end != null && Date.now() >= end)
      throw new MergeQueueError('lease_required', 'executor lease lapsed past grace');
  }

  private async lockEntry(client: Client, projectId: string, entryId: string): Promise<MergeQueueEntry> {
    const res = await client.query(
      `SELECT ${ENTRY_COLS} FROM merge_queue_entries WHERE project_id=$1 AND id=$2 FOR UPDATE`,
      [projectId, entryId],
    );
    const row = res.rows[0];
    if (!row) throw new MergeQueueError('not_found', `merge entry ${entryId} not found`);
    return rowToEntry(row);
  }

  private async lockTestingEntry(client: Client, projectId: string, entryId: string, deviceId: string, leaseEpoch: number): Promise<MergeQueueEntry> {
    const entry = await this.lockEntry(client, projectId, entryId);
    if (entry.state !== 'testing')
      throw new MergeQueueError('invalid_transition', `entry is ${entry.state}, not testing`);
    await this.requireLease(client, projectId, entry.repo_id, deviceId, leaseEpoch);
    if (entry.executor_device_id !== deviceId || entry.lease_epoch !== leaseEpoch)
      throw new MergeQueueError('forbidden', 'stale executor: entry fenced under a different epoch');
    return entry;
  }

  private async insertEntry(client: Client, e: MergeQueueEntry): Promise<void> {
    await client.query(
      `INSERT INTO merge_queue_entries
         (id, project_id, repo_id, task_id, position, state, branch, candidate_oid, target_branch,
          speculative_tree_oid, base_oid, push_precondition_oid, validation_run_id, merged_oid,
          ejected_reason, executor_device_id, lease_epoch, attempts)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
      [
        e.id, e.project_id, e.repo_id, e.task_id, e.position, e.state, e.branch, e.candidate_oid,
        e.target_branch, e.speculative_tree_oid, e.base_oid, e.push_precondition_oid,
        e.validation_run_id, e.merged_oid, e.ejected_reason, e.executor_device_id, e.lease_epoch, e.attempts,
      ],
    );
  }

  private async writeEntry(client: Client, e: MergeQueueEntry): Promise<void> {
    await client.query(
      `UPDATE merge_queue_entries SET position=$3, state=$4, branch=$5, candidate_oid=$6,
          target_branch=$7, speculative_tree_oid=$8, base_oid=$9, push_precondition_oid=$10,
          validation_run_id=$11, merged_oid=$12, ejected_reason=$13, executor_device_id=$14,
          lease_epoch=$15, attempts=$16
        WHERE project_id=$1 AND id=$2`,
      [
        e.project_id, e.id, e.position, e.state, e.branch, e.candidate_oid, e.target_branch,
        e.speculative_tree_oid, e.base_oid, e.push_precondition_oid, e.validation_run_id,
        e.merged_oid, e.ejected_reason, e.executor_device_id, e.lease_epoch, e.attempts,
      ],
    );
  }

  private async emit(
    client: Client,
    projectId: string,
    type: string,
    e: MergeQueueEntry,
    actor: Actor,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    await appendCoordinationEvent(client, {
      projectId,
      deviceId: this.serverDeviceId,
      type,
      actor,
      repoId: e.repo_id,
      taskId: e.task_id,
      payload: { entry_id: e.id, position: e.position, ...extra },
    });
  }

  private async audit(client: Client, projectId: string, actor: Actor, action: string, subjectId: string): Promise<void> {
    await recordAudit(clientExecutor(client), {
      projectId,
      actor,
      action,
      subject: `merge:${subjectId}`,
    });
  }
}