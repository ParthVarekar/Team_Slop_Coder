import { metrics } from '@weft/core';
import { isSystemActor, type StoredEvent } from '@weft/protocol';
import type { ContextImpact, ContextOverlap, ContextProgress, Provenance } from './context.js';

export interface ChangeConflict {
  canonical_key: string;
  kind: string | null;
  severity: string | null;
  state: 'open' | 'resolved' | 'dismissed';
  paths: string[];
  task_ids: string[];
  repo_id: string | null;
  seq: number;
}

export interface StoredImpact extends ContextImpact {
  state: 'open' | 'resolved' | 'dismissed';
  repo_id: string | null;
  seq: number;
}

export interface StoredOverlap extends ContextOverlap {
  state: 'open' | 'resolved' | 'dismissed';
  repo_id: string | null;
  seq: number;
}

export interface ChangeCacheSnapshot {
  cursor: number;
  stale: boolean;
  conflicts: ChangeConflict[];
  impacts: StoredImpact[];
  overlaps: StoredOverlap[];
  progress: ContextProgress[];
}

const applied = metrics.counter(
  'weft_change_cache_events_applied_total',
  'Concurrent-change events projected',
);

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function strArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function provenanceOf(e: StoredEvent): Provenance {
  return !isSystemActor(e.actor) && e.actor.agent != null ? 'agent' : 'human';
}

/**
 * Volatile projection of concurrent-change facts (conflicts, signature impacts,
 * symbol overlaps, progress notes) rebuilt from the coordination SSE channel.
 * Feeds the deterministic context assembler with "recent signature changes in
 * dependencies" without re-running git or dumping raw events. The server stays
 * authoritative; resolved/dismissed conflicts drop out of agent context.
 */
export class ChangeCache {
  private readonly conflicts = new Map<string, ChangeConflict>();
  private readonly impacts = new Map<string, StoredImpact>();
  private readonly overlaps = new Map<string, StoredOverlap>();
  private readonly progress = new Map<string, ContextProgress>();
  private cursor = 0;
  private stale = true;

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
    this.conflicts.clear();
    this.impacts.clear();
    this.overlaps.clear();
    this.progress.clear();
    this.cursor = 0;
  }

  applyEvent(e: StoredEvent): void {
    if (e.global_seq <= this.cursor) return; // idempotent replay guard
    this.cursor = e.global_seq;
    const payload = e.payload as Record<string, unknown>;

    if (e.type === 'task.progress') {
      if (!e.task_id) return;
      const summary = str(payload.summary);
      if (summary == null) return;
      const prev = this.progress.get(e.task_id);
      if (prev && prev.seq >= e.global_seq) return;
      this.progress.set(e.task_id, {
        task_id: e.task_id,
        summary,
        percent: typeof payload.percent === 'number' ? payload.percent : null,
        provenance: provenanceOf(e),
        seq: e.global_seq,
      });
      applied.inc();
      return;
    }

    if (e.type === 'conflict.detected') {
      const key = str(payload.canonical_key);
      if (!key) return;
      const kind = str(payload.kind);
      const severity = str(payload.severity);
      const paths = strArray(payload.paths);
      const taskIds = strArray(payload.task_ids);
      const repoId = str(payload.repo_id) ?? e.repo_id ?? null;
      this.conflicts.set(key, {
        canonical_key: key,
        kind,
        severity,
        state: 'open',
        paths,
        task_ids: taskIds,
        repo_id: repoId,
        seq: e.global_seq,
      });
      const evidence = Array.isArray(payload.evidence)
        ? (payload.evidence[0] as Record<string, unknown> | undefined)
        : undefined;
      if (kind === 'signature_impact' && evidence) {
        const callers = Array.isArray(evidence.callers) ? evidence.callers : [];
        this.impacts.set(key, {
          canonical_key: key,
          task_id: taskIds[0] ?? '',
          branch: str(evidence.branch) ?? '',
          file_path: str(evidence.file_path) ?? '',
          name: str(evidence.name) ?? '',
          kind: str(evidence.symbol_kind) ?? 'symbol',
          old_signature: str(evidence.old_signature),
          new_signature: str(evidence.new_signature),
          affected_task_ids: strArray(evidence.affected_task_ids),
          callers_count: callers.length,
          severity: severity ?? 'info',
          state: 'open',
          repo_id: repoId,
          seq: e.global_seq,
        });
      } else if (kind === 'symbol_overlap' && evidence) {
        const symbols = Array.isArray(evidence.symbols)
          ? (evidence.symbols as Record<string, unknown>[])
              .map((s) => ({ name: str(s.name) ?? '', file_path: str(s.file_path) ?? '' }))
              .filter((s) => s.name.length > 0)
          : [];
        this.overlaps.set(key, {
          canonical_key: key,
          task_ids: taskIds,
          paths,
          symbols,
          severity: severity ?? 'warning',
          state: 'open',
          repo_id: repoId,
          seq: e.global_seq,
        });
      }
      applied.inc();
      return;
    }

    if (e.type === 'conflict.resolved' || e.type === 'conflict.dismissed') {
      const key = str(payload.canonical_key);
      if (!key) return;
      const state = e.type === 'conflict.resolved' ? 'resolved' : 'dismissed';
      const c = this.conflicts.get(key);
      if (c) this.conflicts.set(key, { ...c, state, seq: e.global_seq });
      const i = this.impacts.get(key);
      if (i) this.impacts.set(key, { ...i, state, seq: e.global_seq });
      const o = this.overlaps.get(key);
      if (o) this.overlaps.set(key, { ...o, state, seq: e.global_seq });
      applied.inc();
    }
  }

  openConflicts(repoId?: string): ChangeConflict[] {
    return [...this.conflicts.values()]
      .filter((c) => c.state === 'open' && (repoId == null || c.repo_id === repoId))
      .sort((a, b) => (a.canonical_key < b.canonical_key ? -1 : 1));
  }

  impactsFor(taskId: string, repoId?: string): ContextImpact[] {
    return [...this.impacts.values()]
      .filter(
        (i) =>
          i.state === 'open' &&
          i.affected_task_ids.includes(taskId) &&
          (repoId == null || i.repo_id === repoId),
      )
      .sort((a, b) => (a.canonical_key < b.canonical_key ? -1 : 1));
  }

  overlapsFor(taskId: string, repoId?: string): ContextOverlap[] {
    return [...this.overlaps.values()]
      .filter(
        (o) =>
          o.state === 'open' &&
          o.task_ids.includes(taskId) &&
          (repoId == null || o.repo_id === repoId),
      )
      .sort((a, b) => (a.canonical_key < b.canonical_key ? -1 : 1));
  }

  progressFor(taskId: string): ContextProgress | undefined {
    return this.progress.get(taskId);
  }

  snapshot(): ChangeCacheSnapshot {
    return {
      cursor: this.cursor,
      stale: this.stale,
      conflicts: [...this.conflicts.values()],
      impacts: [...this.impacts.values()],
      overlaps: [...this.overlaps.values()],
      progress: [...this.progress.values()],
    };
  }
}
