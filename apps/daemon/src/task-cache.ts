import { metrics } from '@weft/core';
import { applyTaskEvent, type Actor, type StoredEvent, type TaskSnapshot } from '@weft/protocol';

export interface ClaimRejection {
  task_id: string;
  version: number;
  winner_claimant: Actor | null;
  reason: string | null;
  claimant: Actor | null;
  device_id: string;
  provisional: boolean;
  seq: number;
}

export interface TaskCacheSnapshot {
  cursor: number;
  stale: boolean;
  tasks: TaskSnapshot[];
  claimRejections: ClaimRejection[];
}

export interface TaskCacheOptions {
  /**
   * Fired when a claim this device made is deterministically rejected. M2.8 wires
   * this to discard the provisional (quarantined) worktree so a losing offline
   * claim never silently overwrites the winner's work.
   */
  onClaimRejected?: (rejection: ClaimRejection) => void;
}

const applied = metrics.counter('weft_task_cache_events_applied_total', 'Task coordination events projected');
const rejections = metrics.counter('weft_task_cache_claim_rejections_total', 'Claim rejections observed');

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * Volatile projection of the server's authoritative task state, rebuilt from the
 * coordination SSE channel using the same deterministic fold the server applies.
 * The server remains the source of truth; this cache lets a disconnected daemon
 * show last-known task state and detect lost provisional claims. Claim rejections
 * are retained until the consumer clears them (after quarantine discard).
 */
export class TaskCache {
  private readonly tasks = new Map<string, TaskSnapshot>();
  private readonly rejections = new Map<string, ClaimRejection>();
  private readonly onClaimRejected: ((rejection: ClaimRejection) => void) | undefined;
  private cursor = 0;
  private stale = true;

  constructor(options: TaskCacheOptions = {}) {
    this.onClaimRejected = options.onClaimRejected;
  }

  setStale(value: boolean): void {
    this.stale = value;
  }

  isStale(): boolean {
    return this.stale;
  }

  getCursor(): number {
    return this.cursor;
  }

  clear(): void {
    this.tasks.clear();
    this.rejections.clear();
    this.cursor = 0;
  }

  applyEvent(e: StoredEvent): void {
    if (e.global_seq <= this.cursor) return; // idempotent replay guard
    this.cursor = e.global_seq;
    if (!e.type.startsWith('task.')) return;
    applied.inc();
    const payload = e.payload as Record<string, unknown>;

    if (e.type === 'task.claim_rejected') {
      if (!e.task_id) return;
      const rejection: ClaimRejection = {
        task_id: e.task_id,
        version: typeof payload.version === 'number' ? payload.version : 0,
        winner_claimant: (payload.winner_claimant as Actor | undefined) ?? null,
        reason: str(payload.reason),
        claimant: (payload.claimant as Actor | undefined) ?? null,
        device_id: str(payload.device_id) ?? e.device_id,
        provisional: payload.provisional === true,
        seq: e.global_seq,
      };
      this.rejections.set(e.task_id, rejection);
      rejections.inc();
      this.onClaimRejected?.(rejection);
      return;
    }

    if (!e.task_id) return;
    const current = this.tasks.get(e.task_id) ?? null;
    const next = applyTaskEvent(current, {
      type: e.type,
      version: typeof payload.version === 'number' ? payload.version : 0,
      actor: e.actor,
      payload,
    });
    if (next) this.tasks.set(e.task_id, next);
  }

  getTask(taskId: string): TaskSnapshot | undefined {
    return this.tasks.get(taskId);
  }

  listTasks(): TaskSnapshot[] {
    return [...this.tasks.values()];
  }

  getClaimRejection(taskId: string): ClaimRejection | undefined {
    return this.rejections.get(taskId);
  }

  /** Acknowledge a rejection once its quarantined work has been discarded. */
  clearClaimRejection(taskId: string): void {
    this.rejections.delete(taskId);
  }

  snapshot(): TaskCacheSnapshot {
    return {
      cursor: this.cursor,
      stale: this.stale,
      tasks: [...this.tasks.values()],
      claimRejections: [...this.rejections.values()],
    };
  }
}