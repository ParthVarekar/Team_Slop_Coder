import type { Actor } from './envelope.js';
import type { TaskState } from './catalog.js';

export interface FieldConflict {
  current: unknown;
  incoming: unknown;
  base_version: number;
  detected_at_version: number;
}

/** Unresolved same-field edits keyed by column; both values preserved (no silent loss). */
export type EditConflict = Record<string, FieldConflict>;

/** The authoritative task snapshot minus wall-clock updated_at (excluded from the fold). */
export interface TaskSnapshot {
  id: string;
  project_id: string;
  repo_id: string | null;
  number: number;
  title: string;
  description: string | null;
  acceptance_criteria: string[];
  validation_requirements: Record<string, unknown>;
  priority: string;
  state: TaskState;
  expected_modules: string[];
  expected_files: string[];
  branch: string | null;
  workspace_id: string | null;
  version: number;
  created_by: string | null;
  parent_task_id: string | null;
  edit_conflict: EditConflict | null;
}

export interface TaskEvent {
  type: string;
  version: number;
  actor: Actor;
  payload: Record<string, unknown>;
}

/**
 * Pure, deterministic reducer shared by the server (authoritative fold of
 * task_events) and the daemon (projection of the coordination channel) so both
 * derive identical snapshots. task.created carries the full initial snapshot;
 * task.updated carries applied field values + the resulting edit_conflict;
 * state/claim events carry the transition. claim_rejected and dependency edges
 * do not mutate the snapshot (rejection is a notice; edges surface via READY).
 */
export function applyTaskEvent(snapshot: TaskSnapshot | null, event: TaskEvent): TaskSnapshot | null {
  const p = event.payload;
  switch (event.type) {
    case 'task.created':
      return p.snapshot ? { ...(p.snapshot as TaskSnapshot) } : null;
    case 'task.updated': {
      if (!snapshot) return null;
      const values = (p.values ?? {}) as Partial<TaskSnapshot>;
      const next = { ...snapshot, ...values, version: event.version } as TaskSnapshot;
      if ('edit_conflict' in p) next.edit_conflict = (p.edit_conflict as EditConflict | null) ?? null;
      return next;
    }
    case 'task.state_changed': {
      if (!snapshot) return null;
      return { ...snapshot, state: p.to as TaskState, version: event.version };
    }
    case 'task.claimed': {
      if (!snapshot) return null;
      return { ...snapshot, state: 'claimed', version: event.version };
    }
    case 'task.released': {
      if (!snapshot) return null;
      return { ...snapshot, state: (p.to as TaskState | undefined) ?? 'ready', version: event.version };
    }
    default:
      return snapshot;
  }
}