import { metrics } from '@weft/core';
import type { Actor, StoredEvent } from '@weft/protocol';

export type ReservationMode = 'soft' | 'hard';
export type ReservationCheck = 'pass' | 'blocked' | 'warn';

export interface Reservation {
  key: string;
  path_glob: string;
  mode: ReservationMode;
  holder_task_id: string | null;
  holder_device_id: string;
  expires_at: string | null;
  grace_until: string | null;
  state: 'active' | 'released';
  seq: number;
}

export interface Claim {
  task_id: string;
  claimant: Actor | null;
  device_id: string;
  version: number;
  state: 'claimed' | 'released';
  seq: number;
}

export interface Conflict {
  canonical_key: string;
  conflict_id: string | null;
  kind: string | null;
  severity: string | null;
  state: 'open' | 'resolved' | 'dismissed';
  seq: number;
}

export interface EnforcementSnapshot {
  stale: boolean;
  cursor: number;
  reservations: Reservation[];
  claims: Claim[];
  conflicts: Conflict[];
}

const applied = metrics.counter(
  'weft_enforcement_events_applied_total',
  'Coordination events projected',
);
const blocked = metrics.counter(
  'weft_enforcement_checks_blocked_total',
  'Reservation checks blocked',
);

const regexCache = new Map<string, RegExp>();

/** Compile a path glob (`**`, `*`, `?`) to an anchored regex; cached. */
export function globToRegex(glob: string): RegExp {
  const cached = regexCache.get(glob);
  if (cached) return cached;
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('\\^$+.|()[]{}'.includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  const compiled = new RegExp(`^${re}$`);
  regexCache.set(glob, compiled);
  return compiled;
}

export function globMatch(glob: string, path: string): boolean {
  return globToRegex(glob).test(path.replace(/\\/g, '/'));
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function reservationKey(e: StoredEvent, pathGlob: string): string {
  const explicit = str((e.payload as Record<string, unknown>).reservation_id);
  return explicit ?? `${e.device_id}:${pathGlob}`;
}

/**
 * In-memory projection of the server's durable coordination trail. Rebuilt by
 * replaying the coordination SSE channel; the server remains authoritative.
 * When the link is stale, hard reservations fail closed (block, ignoring expiry
 * we cannot confirm) and soft reservations fail open (pass) so a disconnected
 * agent is never nagged by advisory locks it cannot verify.
 */
export class EnforcementCache {
  private readonly reservations = new Map<string, Reservation>();
  private readonly claims = new Map<string, Claim>();
  private readonly conflicts = new Map<string, Conflict>();
  private stale = true;
  private cursor = 0;

  setStale(value: boolean): void {
    this.stale = value;
  }

  isStale(): boolean {
    return this.stale;
  }

  getCursor(): number {
    return this.cursor;
  }

  /** Reset the projection (forced resync below the watermark). */
  clear(): void {
    this.reservations.clear();
    this.claims.clear();
    this.conflicts.clear();
    this.cursor = 0;
  }

  applyEvent(e: StoredEvent): void {
    if (e.global_seq <= this.cursor) return; // idempotent replay guard
    this.cursor = e.global_seq;
    applied.inc();
    const payload = e.payload as Record<string, unknown>;
    switch (e.type) {
      case 'reservation.acquired':
      case 'reservation.renewed': {
        const pathGlob = str(payload.path_glob);
        if (!pathGlob) break;
        const key = reservationKey(e, pathGlob);
        this.reservations.set(key, {
          key,
          path_glob: pathGlob,
          mode: payload.mode === 'hard' ? 'hard' : 'soft',
          holder_task_id: str(payload.holder_task_id) ?? e.task_id ?? null,
          holder_device_id: str(payload.holder_device_id) ?? e.device_id,
          expires_at: str(payload.expires_at),
          grace_until: str(payload.grace_until),
          state: 'active',
          seq: e.global_seq,
        });
        break;
      }
      case 'reservation.released': {
        const pathGlob = str(payload.path_glob);
        const key = pathGlob ? reservationKey(e, pathGlob) : null;
        const existing = key ? this.reservations.get(key) : undefined;
        if (existing)
          this.reservations.set(existing.key, {
            ...existing,
            state: 'released',
            seq: e.global_seq,
          });
        break;
      }
      case 'reservation.denied':
        break;
      case 'task.claimed': {
        if (!e.task_id) break;
        this.claims.set(e.task_id, {
          task_id: e.task_id,
          claimant: (payload.claimant as Actor | undefined) ?? e.actor,
          device_id: e.device_id,
          version: typeof payload.version === 'number' ? payload.version : 0,
          state: 'claimed',
          seq: e.global_seq,
        });
        break;
      }
      case 'task.released': {
        if (!e.task_id) break;
        const existing = this.claims.get(e.task_id);
        if (existing)
          this.claims.set(e.task_id, { ...existing, state: 'released', seq: e.global_seq });
        break;
      }
      case 'conflict.detected': {
        const key = str(payload.canonical_key);
        if (!key) break;
        this.conflicts.set(key, {
          canonical_key: key,
          conflict_id: str(payload.conflict_id),
          kind: str(payload.kind),
          severity: str(payload.severity),
          state: 'open',
          seq: e.global_seq,
        });
        break;
      }
      case 'conflict.resolved':
      case 'conflict.dismissed': {
        const key = str(payload.canonical_key);
        if (!key) break;
        const existing = this.conflicts.get(key);
        const state = e.type === 'conflict.resolved' ? 'resolved' : 'dismissed';
        this.conflicts.set(key, {
          canonical_key: key,
          conflict_id: str(payload.conflict_id) ?? existing?.conflict_id ?? null,
          kind: str(payload.kind) ?? existing?.kind ?? null,
          severity: str(payload.severity) ?? existing?.severity ?? null,
          state,
          seq: e.global_seq,
        });
        break;
      }
      default:
        break;
    }
  }

  /**
   * Check whether `path` may be edited under `taskId`. Another task's active
   * hard reservation blocks through its expiry grace (grace_until ?? expires_at)
   * so a lease is never stolen mid-edit; a soft reservation warns while fresh
   * (expires_at) and passes when stale (fail open). Own reservations always pass.
   */
  checkReservation(path: string, taskId?: string, now: number = Date.now()): ReservationCheck {
    let hardBlock = false;
    let softWarn = false;
    for (const r of this.reservations.values()) {
      if (r.state !== 'active') continue;
      if (taskId && r.holder_task_id === taskId) continue;
      if (!globMatch(r.path_glob, path)) continue;
      if (r.mode === 'hard') {
        // Hard locks hold through the grace window; only past grace are they reclaimable.
        const hardEnd = r.grace_until ?? r.expires_at;
        const lapsed = hardEnd != null && Date.parse(hardEnd) <= now;
        // Fail closed when stale: do not trust an expiry we cannot confirm.
        if (lapsed && !this.stale) continue;
        hardBlock = true;
      } else {
        const expired = r.expires_at != null && Date.parse(r.expires_at) <= now;
        if (expired) continue;
        softWarn = true;
      }
    }
    if (hardBlock) {
      blocked.inc();
      return 'blocked';
    }
    if (softWarn) return this.stale ? 'pass' : 'warn';
    return 'pass';
  }

  getClaim(taskId: string): Claim | undefined {
    return this.claims.get(taskId);
  }

  getConflict(canonicalKey: string): Conflict | undefined {
    return this.conflicts.get(canonicalKey);
  }

  snapshot(): EnforcementSnapshot {
    return {
      stale: this.stale,
      cursor: this.cursor,
      reservations: [...this.reservations.values()],
      claims: [...this.claims.values()],
      conflicts: [...this.conflicts.values()],
    };
  }
}
