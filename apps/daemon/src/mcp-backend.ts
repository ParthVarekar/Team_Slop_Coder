import { makeId, type Actor, type TaskSnapshot } from '@weft/protocol';
import type { Daemon } from './daemon.js';
import { TaskError, type TaskRecord } from './tasks.js';
import { draftEvent } from './events.js';
import type { CoordinationRpc, RpcAcquireResult } from './coordination-rpc.js';
import type { ChangeCache } from './change-cache.js';
import {
  assembleContext,
  type ContextConflict,
  type ContextPayload,
  type ContextReservation,
  type ContextTask,
} from './context.js';
import type {
  McpBackend,
  McpClaimResult,
  McpGetTaskResult,
  McpProgressResult,
  McpReserveInput,
  McpReserveResult,
  McpTaskView,
} from './mcp.js';

const DEFAULT_LEASE_TTL_MS = 120_000;
const DEFAULT_LEASE_GRACE_MS = 30_000;

function jsonArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function snapshotToView(s: TaskSnapshot): McpTaskView {
  return {
    id: s.id,
    number: s.number,
    title: s.title,
    state: s.state,
    priority: s.priority,
    branch: s.branch,
    repo_id: s.repo_id,
    expected_files: s.expected_files,
    expected_modules: s.expected_modules,
    acceptance_criteria: s.acceptance_criteria,
    description: s.description,
    version: s.version,
  };
}

function recordToView(r: TaskRecord): McpTaskView {
  return {
    id: r.task_id,
    number: r.number,
    title: r.title,
    state: r.state,
    priority: r.priority,
    branch: r.branch,
    repo_id: r.repo_id,
    expected_files: jsonArray(r.expected_files),
    expected_modules: jsonArray(r.expected_modules),
    acceptance_criteria: r.acceptance_criteria ? [r.acceptance_criteria] : [],
    description: r.description,
    version: r.version,
  };
}

function viewToContextTask(v: McpTaskView): ContextTask {
  return {
    id: v.id,
    number: v.number,
    title: v.title,
    state: v.state,
    priority: v.priority,
    branch: v.branch,
    repo_id: v.repo_id,
    expected_files: v.expected_files,
    expected_modules: v.expected_modules,
    description: v.description,
    acceptance_criteria: v.acceptance_criteria,
    description_provenance: 'human',
  };
}

/**
 * In-process MCP backend over the daemon. Team mode round-trips authoritative
 * mutations to the server (claim/reserve) and reads the volatile coordination
 * projections (task/enforcement/change caches); solo mode uses the local task
 * store and emits advisory events. Context is always assembled deterministically
 * from structured facts — never raw events, never an LLM call.
 */
export class DaemonMcpBackend implements McpBackend {
  constructor(
    private readonly daemon: Daemon,
    private readonly rpc: CoordinationRpc | null,
    private readonly changeCache: ChangeCache | null,
  ) {}

  private get team(): boolean {
    return this.daemon.config.mode === 'team' && this.daemon.taskCache != null;
  }

  private agentActor(): Actor {
    return { user_id: this.daemon.identity.user_id, agent: { provider: 'mcp', adapter: 'weft-mcp' } };
  }

  async getTask(taskId: string): Promise<McpGetTaskResult> {
    if (this.team) {
      if (this.rpc) {
        try {
          const s = await this.rpc.getTask(taskId);
          if (s) return { task: snapshotToView(s), source: 'server', stale: this.daemon.taskCache?.isStale() ?? false };
        } catch {
          /* server unreachable; fall back to the last-known projection */
        }
      }
      const cached = this.daemon.taskCache?.getTask(taskId);
      const stale = this.daemon.taskCache?.isStale() ?? true;
      return { task: cached ? snapshotToView(cached) : null, source: 'cache', stale };
    }
    const rec = this.daemon.tasks.getTask(taskId);
    return { task: rec ? recordToView(rec) : null, source: 'local', stale: false };
  }

  async claimTask(taskId: string, opts: { baseVersion?: number; provisional?: boolean }): Promise<McpClaimResult> {
    const provisional = opts.provisional ?? false;
    if (this.team) {
      if (!this.rpc) throw new Error('claim_task requires a configured team server');
      const result = await this.rpc.claimTask(taskId, {
        ...(opts.baseVersion != null ? { baseVersion: opts.baseVersion } : {}),
        claimant: this.daemon.actor,
        provisional,
      });
      if (result.ok) {
        return { ok: true, task_id: taskId, version: result.snapshot.version, provisional: result.provisional, state: result.snapshot.state };
      }
      return { ok: false, task_id: taskId, version: result.version, provisional, reason: result.reason, winner_claimant: result.winner_claimant };
    }
    const rec = this.daemon.tasks.getTask(taskId);
    if (!rec) return { ok: false, task_id: taskId, version: 0, provisional, reason: 'task not found' };
    try {
      const next = this.daemon.tasks.transition(taskId, opts.baseVersion ?? rec.version, 'claimed');
      return { ok: true, task_id: taskId, version: next.version, provisional, state: next.state };
    } catch (err) {
      if (err instanceof TaskError) return { ok: false, task_id: taskId, version: rec.version, provisional, reason: err.message };
      throw err;
    }
  }

  async reportProgress(taskId: string, note: string, opts: { percent?: number }): Promise<McpProgressResult> {
    const percent = opts.percent ?? null;
    this.daemon.pipeline.enqueue(
      draftEvent(this.daemon.source, {
        type: 'task.progress',
        actor: this.agentActor(),
        taskId,
        privacy: 'metadata',
        payload: { summary: note, ...(percent != null ? { percent } : {}) },
      }),
    );
    return { ok: true, task_id: taskId, percent, recorded: 'event' };
  }

  async getConcurrentChanges(taskId: string, opts: { budgetBytes?: number }): Promise<ContextPayload> {
    const { task, stale } = await this.contextTask(taskId);
    const repoId = task?.repo_id ?? null;
    const repoFilter = repoId ?? undefined;

    const reservations: ContextReservation[] = this.team
      ? (this.daemon.enforcement?.snapshot().reservations ?? [])
          .filter((r) => r.state === 'active')
          .map((r) => ({
            path_glob: r.path_glob,
            mode: r.mode,
            holder_task_id: r.holder_task_id,
            holder_device_id: r.holder_device_id,
            expires_at: r.expires_at,
            grace_until: r.grace_until,
          }))
      : [];

    const conflicts: ContextConflict[] = (this.changeCache?.openConflicts(repoFilter) ?? []).map((c) => ({
      canonical_key: c.canonical_key,
      kind: c.kind,
      severity: c.severity,
      paths: c.paths,
    }));
    const progress = this.changeCache?.progressFor(taskId);

    return assembleContext(
      {
        task,
        reservations,
        impacts: this.changeCache?.impactsFor(taskId, repoFilter) ?? [],
        overlaps: this.changeCache?.overlapsFor(taskId, repoFilter) ?? [],
        conflicts,
        progress: progress ? [progress] : [],
        stale,
      },
      { ...(opts.budgetBytes != null ? { budgetBytes: opts.budgetBytes } : {}) },
    );
  }

  private async contextTask(taskId: string): Promise<{ task: ContextTask | null; stale: boolean }> {
    if (this.team) {
      const cached = this.daemon.taskCache?.getTask(taskId);
      if (cached) return { task: viewToContextTask(snapshotToView(cached)), stale: this.daemon.taskCache?.isStale() ?? true };
      if (this.rpc) {
        try {
          const s = await this.rpc.getTask(taskId);
          if (s) return { task: viewToContextTask(snapshotToView(s)), stale: this.daemon.taskCache?.isStale() ?? true };
        } catch {
          /* fall through to empty context */
        }
      }
      return { task: null, stale: this.daemon.taskCache?.isStale() ?? true };
    }
    const rec = this.daemon.tasks.getTask(taskId);
    return { task: rec ? viewToContextTask(recordToView(rec)) : null, stale: false };
  }

  async reserveFiles(input: McpReserveInput): Promise<McpReserveResult> {
    const mode = input.mode ?? 'soft';
    if (this.team) {
      if (!this.rpc) throw new Error('reserve_files requires a configured team server');
      const result = await this.rpc.reserveFiles({
        repo_id: input.repo_id,
        task_id: input.task_id,
        path_glob: input.path_glob,
        mode,
        ...(input.ttl_ms != null ? { ttl_ms: input.ttl_ms } : {}),
        ...(input.session_id != null ? { session_id: input.session_id } : {}),
      });
      return acquireToResult(result, input.path_glob, mode);
    }
    // Solo: advisory local lease recorded in the durable trail (no rival to block).
    const ttl = input.ttl_ms ?? DEFAULT_LEASE_TTL_MS;
    const now = Date.now();
    const expiresAt = new Date(now + ttl).toISOString();
    const graceUntil = mode === 'hard' ? new Date(now + ttl + DEFAULT_LEASE_GRACE_MS).toISOString() : null;
    const reservationId = makeId('reservation');
    this.daemon.pipeline.enqueue(
      draftEvent(this.daemon.source, {
        type: 'reservation.acquired',
        actor: this.agentActor(),
        taskId: input.task_id,
        repoId: input.repo_id,
        ...(input.session_id != null ? { sessionId: input.session_id } : {}),
        privacy: 'metadata',
        payload: {
          reservation_id: reservationId,
          path_glob: input.path_glob,
          mode,
          holder_task_id: input.task_id,
          holder_device_id: this.daemon.identity.device_id,
          expires_at: expiresAt,
          ...(graceUntil != null ? { grace_until: graceUntil } : {}),
          lease_epoch: 0,
          state: 'active',
        },
      }),
    );
    return { status: 'local', reservation_id: reservationId, path_glob: input.path_glob, mode, expires_at: expiresAt, grace_until: graceUntil };
  }
}

function acquireToResult(result: RpcAcquireResult, pathGlob: string, mode: 'soft' | 'hard'): McpReserveResult {
  const r = result.reservation;
  return {
    status: result.status,
    reservation_id: r.id,
    path_glob: r.path_glob ?? pathGlob,
    mode: r.mode ?? mode,
    expires_at: r.expires_at,
    grace_until: r.grace_until,
    ...(result.reason != null ? { reason: result.reason } : {}),
  };
}