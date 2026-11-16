import type { Client, Pool } from 'pg';
import { z } from 'zod';
import { metrics, type Logger } from '@weft/core';
import { makeId, ReservationModeSchema, type Actor, type ReservationMode } from '@weft/protocol';
import { withTransaction, clientExecutor } from './pg.js';
import { appendCoordinationEvent } from './emit.js';
import { recordAudit } from './audit.js';
import type { Origin } from './tasks-service.js';

const acquired = metrics.counter('weft_server_reservations_acquired_total', 'Reservation leases acquired');
const renewed = metrics.counter('weft_server_reservations_renewed_total', 'Reservation leases renewed');
const released = metrics.counter('weft_server_reservations_released_total', 'Reservation leases released');
const denied = metrics.counter('weft_server_reservations_denied_total', 'Reservation acquires denied');
const expired = metrics.counter('weft_server_reservations_expired_total', 'Reservation leases expired past grace');

/** Default lease TTL and post-expiry grace. During grace only the holder may renew;
 *  the lock still blocks others (no mid-edit steal). Past grace it is reclaimable. */
export const DEFAULT_LEASE_TTL_MS = 120_000;
export const DEFAULT_LEASE_GRACE_MS = 30_000;

function toIso(value: unknown): string | null {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

export interface ReservationSnapshot {
  id: string;
  project_id: string;
  repo_id: string;
  task_id: string | null;
  session_id: string | null;
  path_glob: string;
  mode: ReservationMode;
  holder_device_id: string | null;
  expires_at: string | null;
  renewed_at: string | null;
  grace_until: string | null;
  state: 'active' | 'released';
  lease_epoch: number;
  created_at: string;
  released_reason: string | null;
}

const COLS = `id, project_id, repo_id, task_id, session_id, path_glob, mode, holder_device_id,
  expires_at, renewed_at, grace_until, state, lease_epoch, created_at, released_reason`;

function rowToReservation(r: Record<string, unknown>): ReservationSnapshot {
  return {
    id: String(r.id),
    project_id: String(r.project_id),
    repo_id: String(r.repo_id),
    task_id: r.task_id == null ? null : String(r.task_id),
    session_id: r.session_id == null ? null : String(r.session_id),
    path_glob: String(r.path_glob),
    mode: String(r.mode) as ReservationMode,
    holder_device_id: r.holder_device_id == null ? null : String(r.holder_device_id),
    expires_at: toIso(r.expires_at),
    renewed_at: toIso(r.renewed_at),
    grace_until: toIso(r.grace_until),
    state: String(r.state) as 'active' | 'released',
    lease_epoch: Number(r.lease_epoch),
    created_at: String(toIso(r.created_at)),
    released_reason: r.released_reason == null ? null : String(r.released_reason),
  };
}

/** The instant a lease stops blocking others: grace_until if set, else expires_at. */
function effectiveExpiry(r: ReservationSnapshot): number | null {
  const end = r.grace_until ?? r.expires_at;
  return end == null ? null : Date.parse(end);
}

export type ReservationErrorCode = 'not_found' | 'validation' | 'invalid_transition' | 'forbidden';

export class ReservationError extends Error {
  constructor(
    readonly code: ReservationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ReservationError';
  }
}

export const AcquireReservationSchema = z.object({
  repo_id: z.string().min(1),
  task_id: z.string().min(1),
  session_id: z.string().min(1).optional(),
  path_glob: z.string().min(1).max(4096),
  mode: ReservationModeSchema.default('soft'),
  ttl_ms: z.number().int().positive().max(3_600_000).optional(),
});
export type AcquireReservationInput = z.input<typeof AcquireReservationSchema>;

export const RenewReservationSchema = z.object({
  task_id: z.string().min(1),
  ttl_ms: z.number().int().positive().max(3_600_000).optional(),
});
export const ReleaseReservationSchema = z.object({
  task_id: z.string().min(1),
  reason: z.string().max(500).optional(),
});

export interface AcquireResult {
  status: 'acquired' | 'renewed' | 'denied';
  reservation: ReservationSnapshot;
  reason?: string;
}

export interface ReservationListOptions {
  repoId?: string;
  state?: 'active' | 'released';
  taskId?: string;
  limit?: number;
}

/**
 * Server-authoritative reservation leases. Acquire is a CAS keyed by
 * (project, repo, path_glob): an active lease held by another task blocks a new
 * acquire until it is released or lapses past its expiry grace. Only the holder
 * may renew, and only while within expiry-or-grace — so a lease is never stolen
 * mid-edit. Every mutation emits a reservation.* coordination event and an audit
 * record in the same transaction; daemons project these into enforcement copies.
 */
export class ReservationService {
  constructor(
    private readonly pool: Pool,
    private readonly serverDeviceId: string,
    private readonly logger?: Logger,
    private readonly graceMs: number = DEFAULT_LEASE_GRACE_MS,
  ) {}

  async acquire(projectId: string, input: AcquireReservationInput, origin: Origin): Promise<AcquireResult> {
    const parsed = AcquireReservationSchema.safeParse(input);
    if (!parsed.success)
      throw new ReservationError('validation', parsed.error.issues.map((i) => i.message).join('; '));
    const data = parsed.data;
    return withTransaction(this.pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `${projectId}:reservation:${data.repo_id}:${data.path_glob}`,
      ]);
      const found = await client.query(
        `SELECT ${COLS} FROM file_reservations
          WHERE project_id=$1 AND repo_id=$2 AND path_glob=$3 AND state='active' FOR UPDATE`,
        [projectId, data.repo_id, data.path_glob],
      );
      const now = Date.now();
      const nowIso = new Date(now).toISOString();
      const ttl = data.ttl_ms ?? DEFAULT_LEASE_TTL_MS;

      for (const row of found.rows) {
        const existing = rowToReservation(row);
        if (existing.task_id === data.task_id) {
          // Holder re-acquiring its own glob: extend in place (idempotent renew).
          const next = this.extend(existing, now, ttl);
          await this.update(client, next);
          await this.emit(client, projectId, 'reservation.renewed', next, origin.actor);
          await this.audit(client, projectId, origin.actor, 'reservation.renewed', next);
          renewed.inc();
          return { status: 'renewed', reservation: next };
        }
        const end = effectiveExpiry(existing);
        if (end == null || now < end) {
          // Another task holds an unexpired (or in-grace) lease: deny, never steal.
          await this.emit(client, projectId, 'reservation.denied', existing, origin.actor, {
            requesting_task_id: data.task_id,
            reason: 'held',
          });
          await this.audit(client, projectId, origin.actor, 'reservation.denied', existing);
          denied.inc();
          return { status: 'denied', reservation: existing, reason: 'held' };
        }
        // Lapsed past grace: release it so the new acquire can proceed.
        await this.markReleased(client, existing, 'expired');
        await this.emit(client, projectId, 'reservation.released', existing, origin.actor, { reason: 'expired' });
        expired.inc();
      }

      const expiresAt = new Date(now + ttl).toISOString();
      const reservation: ReservationSnapshot = {
        id: makeId('reservation'),
        project_id: projectId,
        repo_id: data.repo_id,
        task_id: data.task_id,
        session_id: data.session_id ?? null,
        path_glob: data.path_glob,
        mode: data.mode,
        holder_device_id: origin.deviceId,
        expires_at: expiresAt,
        renewed_at: nowIso,
        grace_until: new Date(now + ttl + this.graceMs).toISOString(),
        state: 'active',
        lease_epoch: 1,
        created_at: nowIso,
        released_reason: null,
      };
      await client.query(
        `INSERT INTO file_reservations
           (id, project_id, repo_id, task_id, session_id, path_glob, mode, holder_device_id,
            expires_at, renewed_at, grace_until, state, lease_epoch, created_at, released_reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [
          reservation.id, projectId, reservation.repo_id, reservation.task_id, reservation.session_id,
          reservation.path_glob, reservation.mode, reservation.holder_device_id, reservation.expires_at,
          reservation.renewed_at, reservation.grace_until, reservation.state, reservation.lease_epoch,
          reservation.created_at, reservation.released_reason,
        ],
      );
      await this.emit(client, projectId, 'reservation.acquired', reservation, origin.actor);
      await this.audit(client, projectId, origin.actor, 'reservation.acquired', reservation);
      acquired.inc();
      this.logger?.debug({ reservationId: reservation.id, projectId }, 'reservation lease acquired');
      return { status: 'acquired', reservation };
    });
  }

  async renew(projectId: string, id: string, taskId: string, origin: Origin, ttlMs?: number): Promise<ReservationSnapshot> {
    return withTransaction(this.pool, async (client) => {
      const r = await this.lock(client, projectId, id);
      if (r.state !== 'active') throw new ReservationError('invalid_transition', 'lease is not active');
      if (r.task_id !== taskId) throw new ReservationError('forbidden', 'only the holder task may renew');
      const now = Date.now();
      const end = effectiveExpiry(r);
      if (end != null && now >= end)
        throw new ReservationError('invalid_transition', 'lease lapsed past grace; cannot renew');
      const next = this.extend(r, now, ttlMs ?? DEFAULT_LEASE_TTL_MS);
      await this.update(client, next);
      await this.emit(client, projectId, 'reservation.renewed', next, origin.actor);
      await this.audit(client, projectId, origin.actor, 'reservation.renewed', next);
      renewed.inc();
      return next;
    });
  }

  async release(projectId: string, id: string, taskId: string, origin: Origin, reason?: string): Promise<ReservationSnapshot> {
    return withTransaction(this.pool, async (client) => {
      const r = await this.lock(client, projectId, id);
      if (r.task_id !== taskId) throw new ReservationError('forbidden', 'only the holder task may release');
      if (r.state === 'released') return r;
      await this.markReleased(client, r, reason ?? 'released');
      const next = { ...r, state: 'released' as const, released_reason: reason ?? 'released' };
      await this.emit(client, projectId, 'reservation.released', next, origin.actor, { reason: next.released_reason });
      await this.audit(client, projectId, origin.actor, 'reservation.released', next);
      released.inc();
      return next;
    });
  }

  /** Release every active lease that has lapsed past its grace. Idempotent. */
  async sweepExpired(projectId: string, now: number = Date.now()): Promise<number> {
    return withTransaction(this.pool, async (client) => {
      const found = await client.query(
        `SELECT ${COLS} FROM file_reservations WHERE project_id=$1 AND state='active' FOR UPDATE`,
        [projectId],
      );
      let count = 0;
      for (const row of found.rows) {
        const r = rowToReservation(row);
        const end = effectiveExpiry(r);
        if (end == null || now < end) continue;
        await this.markReleased(client, r, 'expired');
        await this.emit(client, projectId, 'reservation.released', r, { system: 'weft-server' }, { reason: 'expired' });
        count++;
      }
      if (count > 0) expired.inc(count);
      return count;
    });
  }

  async get(projectId: string, id: string): Promise<ReservationSnapshot | undefined> {
    const res = await this.pool.query(
      `SELECT ${COLS} FROM file_reservations WHERE project_id=$1 AND id=$2`,
      [projectId, id],
    );
    return res.rows[0] ? rowToReservation(res.rows[0]) : undefined;
  }

  async list(projectId: string, options: ReservationListOptions = {}): Promise<ReservationSnapshot[]> {
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
    if (options.taskId) {
      params.push(options.taskId);
      where += ` AND task_id = $${params.length}`;
    }
    params.push(options.limit ?? 200);
    const res = await this.pool.query(
      `SELECT ${COLS} FROM file_reservations WHERE ${where}
        ORDER BY created_at ASC LIMIT $${params.length}`,
      params,
    );
    return res.rows.map(rowToReservation);
  }

  private extend(r: ReservationSnapshot, now: number, ttl: number): ReservationSnapshot {
    const expiresAt = new Date(now + ttl).toISOString();
    return {
      ...r,
      expires_at: expiresAt,
      grace_until: new Date(now + ttl + this.graceMs).toISOString(),
      renewed_at: new Date(now).toISOString(),
      lease_epoch: r.lease_epoch + 1,
    };
  }

  private async lock(client: Client, projectId: string, id: string): Promise<ReservationSnapshot> {
    const res = await client.query(
      `SELECT ${COLS} FROM file_reservations WHERE project_id=$1 AND id=$2 FOR UPDATE`,
      [projectId, id],
    );
    const row = res.rows[0];
    if (!row) throw new ReservationError('not_found', `reservation ${id} not found`);
    return rowToReservation(row);
  }

  private async update(client: Client, r: ReservationSnapshot): Promise<void> {
    await client.query(
      `UPDATE file_reservations SET expires_at=$2, renewed_at=$3, grace_until=$4, lease_epoch=$5
        WHERE id=$1`,
      [r.id, r.expires_at, r.renewed_at, r.grace_until, r.lease_epoch],
    );
  }

  private async markReleased(client: Client, r: ReservationSnapshot, reason: string): Promise<void> {
    await client.query(
      `UPDATE file_reservations SET state='released', released_reason=$2 WHERE id=$1`,
      [r.id, reason],
    );
  }

  private async emit(
    client: Client,
    projectId: string,
    type: string,
    r: ReservationSnapshot,
    actor: Actor,
    extra?: Record<string, unknown>,
  ): Promise<void> {
    await appendCoordinationEvent(client, {
      projectId,
      deviceId: this.serverDeviceId,
      type,
      actor,
      repoId: r.repo_id,
      ...(r.task_id != null ? { taskId: r.task_id } : {}),
      ...(r.session_id != null ? { sessionId: r.session_id } : {}),
      payload: {
        reservation_id: r.id,
        path_glob: r.path_glob,
        mode: r.mode,
        holder_task_id: r.task_id ?? undefined,
        holder_device_id: r.holder_device_id ?? undefined,
        expires_at: r.expires_at ?? undefined,
        grace_until: r.grace_until ?? undefined,
        renewed_at: r.renewed_at ?? undefined,
        lease_epoch: r.lease_epoch,
        state: r.state,
        ...extra,
      },
    });
  }

  private async audit(
    client: Client,
    projectId: string,
    actor: Actor,
    action: string,
    r: ReservationSnapshot,
  ): Promise<void> {
    await recordAudit(clientExecutor(client), {
      projectId,
      actor,
      action,
      subject: `reservation:${r.id}`,
    });
  }
}