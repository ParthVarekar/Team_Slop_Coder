import { createHash } from 'node:crypto';
import type { Client, Pool } from 'pg';
import { metrics, type Logger } from '@weft/core';
import { safeParseEvent, isCoordinationEvent, type EventEnvelope, type StoredEvent } from '@weft/protocol';
import { clientExecutor, withTransaction } from './pg.js';
import { recordAudit } from './audit.js';
import type { ConflictProjection } from './conflicts-service.js';
import type { ValidationProjection } from './validation-service.js';
import type { NotificationProjection } from './notifications-service.js';

export const MAX_INGEST_BATCH = 1000;

const ingested = metrics.counter('weft_server_events_ingested_total', 'Events durably ingested');
const duplicated = metrics.counter('weft_server_events_duplicate_total', 'Replays deduplicated');
const rejected = metrics.counter('weft_server_events_rejected_total', 'Events rejected at ingest');
const batchMs = metrics.histogram('weft_server_ingest_batch_ms', 'Ingest batch latency');

export interface IngestedRef {
  event_id: string;
  global_seq: number;
  received_at: string;
}

export interface RejectedRef {
  event_id?: string;
  error: string;
}

export interface StreamCursor {
  last_seq: number;
  min_seq: number;
}

export interface IngestResult {
  accepted: IngestedRef[];
  duplicates: IngestedRef[];
  rejected: RejectedRef[];
  streams: Record<string, StreamCursor>;
}

interface PendingEvent {
  event: EventEnvelope;
  global_seq: number;
  received_at: string;
}

function keyOf(e: EventEnvelope): string {
  return `${e.device_id}:${e.event_id}`;
}

function toIso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function oneRow(rows: Record<string, unknown>[]): Record<string, unknown> {
  const row = rows[0];
  if (!row) throw new Error('ingest: expected a row from RETURNING/lookup');
  return row;
}

const EVENT_COLS = 16;
const COORD_COLS = 15;

function placeholders(cols: number, offset: number): string {
  const parts: string[] = [];
  for (let j = 0; j < cols; j++) parts.push(`$${offset + j + 1}`);
  return `(${parts.join(',')})`;
}

async function insertEvents(client: Client, items: PendingEvent[]): Promise<void> {
  const values: unknown[] = [];
  const tuples: string[] = [];
  items.forEach((ne, i) => {
    const e = ne.event;
    values.push(
      e.event_id, e.v, e.device_id, e.project_id,
      e.repo_id ?? null, e.session_id ?? null, e.provider_session_id ?? null,
      e.task_id ?? null, e.seq ?? null, ne.global_seq, e.ts, ne.received_at,
      e.type, JSON.stringify(e.actor), JSON.stringify(e.payload), e.privacy,
    );
    tuples.push(placeholders(EVENT_COLS, i * EVENT_COLS));
  });
  await client.query(
    `INSERT INTO events
       (event_id, v, device_id, project_id, repo_id, session_id, provider_session_id,
        task_id, seq, global_seq, ts, received_at, type, actor, payload, privacy)
     VALUES ${tuples.join(',')}`,
    values,
  );
}

async function insertCoordination(client: Client, items: PendingEvent[]): Promise<void> {
  const values: unknown[] = [];
  const tuples: string[] = [];
  items.forEach((ne, i) => {
    const e = ne.event;
    values.push(
      e.event_id, e.v, e.device_id, e.project_id, e.repo_id ?? null,
      e.session_id ?? null, e.task_id ?? null, e.seq ?? null, ne.global_seq,
      e.ts, ne.received_at, e.type, JSON.stringify(e.actor), JSON.stringify(e.payload), e.privacy,
    );
    tuples.push(placeholders(COORD_COLS, i * COORD_COLS));
  });
  await client.query(
    `INSERT INTO coordination_events
       (event_id, v, device_id, project_id, repo_id, session_id, task_id, seq,
        global_seq, ts, received_at, type, actor, payload, privacy)
     VALUES ${tuples.join(',')}
     ON CONFLICT (event_id) DO NOTHING`,
    values,
  );
}

/**
 * Server ingest: effectively-once persistence of client envelopes. Dedup is
 * keyed on (device_id, event_id); per-event advisory locks serialize concurrent
 * replays so the unique (device_id, event_id, received_at) constraint never has
 * to fire. New events reserve a contiguous per-project global_seq range via an
 * atomic project_stream_seq increment, mirror coordination types into the
 * never-expiring trail, and append a tamper-evident audit record. The whole
 * batch is one transaction: any failure rolls back (including seq reservation)
 * and the shipper retries. Client `ts` is never mutated.
 */
export class IngestService {
  constructor(
    private readonly pool: Pool,
    private readonly logger?: Logger,
    private readonly conflicts?: ConflictProjection,
    private readonly validation?: ValidationProjection,
    private readonly notifications?: NotificationProjection,
    private readonly onCommit?: (events: StoredEvent[]) => void,
  ) {}

  async ingestBatch(rawEvents: unknown[]): Promise<IngestResult> {
    const start = performance.now();
    const result: IngestResult = { accepted: [], duplicates: [], rejected: [], streams: {} };
    if (rawEvents.length > MAX_INGEST_BATCH) {
      result.rejected.push({ error: `batch exceeds ${MAX_INGEST_BATCH} events` });
      return result;
    }

    // Validate + collapse intra-batch replays (first occurrence wins).
    const candidates = new Map<string, EventEnvelope>();
    const intraBatch: string[] = [];
    for (const raw of rawEvents) {
      const parsed = safeParseEvent(raw);
      if (!parsed.success) {
        rejected.inc();
        const eid = (raw as { event_id?: unknown } | null)?.event_id;
        result.rejected.push({
          ...(typeof eid === 'string' ? { event_id: eid } : {}),
          error: parsed.error.message,
        });
        continue;
      }
      const key = keyOf(parsed.data);
      if (candidates.has(key)) intraBatch.push(key);
      else candidates.set(key, parsed.data);
    }

    const list = [...candidates.values()];
    if (list.length > 0) {
      const tx = await withTransaction(this.pool, (client) =>
        this.persist(client, list, [...candidates.keys()].sort()),
      );

      const refByKey = new Map<string, IngestedRef>();
      for (const ne of tx.inserted) {
        const ref: IngestedRef = {
          event_id: ne.event.event_id,
          global_seq: ne.global_seq,
          received_at: ne.received_at,
        };
        result.accepted.push(ref);
        refByKey.set(keyOf(ne.event), ref);
      }
      for (const [key, ref] of tx.existing) {
        result.duplicates.push(ref);
        refByKey.set(key, ref);
      }
      for (const key of intraBatch) {
        const ref = refByKey.get(key);
        if (ref) result.duplicates.push(ref);
      }
      result.streams = tx.streams;
      this.onCommit?.(
        tx.inserted.map((ne) => ({
          ...ne.event,
          ts: new Date(ne.event.ts).toISOString(),
          global_seq: ne.global_seq,
          received_at: ne.received_at,
        })),
      );
      ingested.inc(tx.inserted.length);
      duplicated.inc(tx.existing.size + intraBatch.length);
    }

    batchMs.observe(performance.now() - start);
    this.logger?.debug(
      { accepted: result.accepted.length, duplicates: result.duplicates.length, rejected: result.rejected.length },
      'ingest batch',
    );
    return result;
  }

  private async persist(
    client: Client,
    list: EventEnvelope[],
    sortedKeys: string[],
  ): Promise<{
    inserted: PendingEvent[];
    existing: Map<string, IngestedRef>;
    streams: Record<string, StreamCursor>;
  }> {
    // Serialize concurrent replays of the same event; sorted order avoids deadlock.
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtextextended(k, 0)) FROM unnest($1::text[]) AS k',
      [sortedKeys],
    );

    // Bulk existence lookup (uses the unique index prefix on device_id,event_id).
    const existing = new Map<string, IngestedRef>();
    const found = await client.query(
      `SELECT e.device_id, e.event_id, e.global_seq, e.received_at
         FROM events e
         JOIN unnest($1::text[], $2::text[]) AS t(device_id, event_id)
           ON e.device_id = t.device_id AND e.event_id = t.event_id`,
      [list.map((e) => e.device_id), list.map((e) => e.event_id)],
    );
    for (const row of found.rows) {
      const key = `${String(row.device_id)}:${String(row.event_id)}`;
      existing.set(key, {
        event_id: String(row.event_id),
        global_seq: Number(row.global_seq),
        received_at: toIso(row.received_at),
      });
    }

    const fresh = list.filter((e) => !existing.has(keyOf(e)));
    const receivedAt = new Date().toISOString();
    const byProject = new Map<string, PendingEvent[]>();
    for (const e of fresh) {
      const ne: PendingEvent = { event: e, global_seq: 0, received_at: receivedAt };
      const arr = byProject.get(e.project_id) ?? [];
      arr.push(ne);
      byProject.set(e.project_id, arr);
    }

    // Atomically reserve a contiguous seq range per project (row lock = CAS).
    for (const [projectId, arr] of byProject) {
      const res = await client.query(
        `INSERT INTO project_stream_seq (project_id, last_seq, min_seq)
         VALUES ($1, $2, 0)
         ON CONFLICT (project_id) DO UPDATE SET last_seq = project_stream_seq.last_seq + $2
         RETURNING last_seq, min_seq`,
        [projectId, arr.length],
      );
      const last = Number(oneRow(res.rows).last_seq);
      let seq = last - arr.length + 1;
      for (const ne of arr) ne.global_seq = seq++;
    }

    const inserted = [...byProject.values()].flat();
    if (inserted.length > 0) {
      await insertEvents(client, inserted);
      const coord = inserted.filter((ne) => isCoordinationEvent(ne.event.type));
      if (coord.length > 0) await insertCoordination(client, coord);
      // Fold fresh conflict detections into canonical cards in the same tx, so
      // the card, its history, and any server fan-out commit atomically with the
      // ingested evidence. Replays never reach here (deduped above).
      if (this.conflicts) {
        for (const ne of inserted) {
          if (ne.event.type === 'conflict.detected')
            await this.conflicts.projectDetection(client, ne.event);
        }
      }
      // Materialize daemon validation evidence + completion claims in the same tx,
      // in raw event order (started → checks → completed) so FK shells exist first.
      if (this.validation) {
        for (const ne of inserted) {
          const t = ne.event.type;
          if (
            t === 'validation.started' ||
            t === 'check.completed' ||
            t === 'validation.completed' ||
            t === 'task.completion_claimed'
          )
            await this.validation.project(client, ne.event);
        }
      }
      // Fold notification.created into per-user inbox cards in the same tx, so
      // the card and its audit commit atomically with the ingested event. The
      // card id is the event id, making replays idempotent (deduped above anyway).
      if (this.notifications) {
        for (const ne of inserted) {
          if (ne.event.type === 'notification.created')
            await this.notifications.project(client, ne.event);
        }
      }
      for (const [projectId, arr] of byProject) {
        const digest = createHash('sha256')
          .update(arr.map((ne) => `${ne.event.event_id}:${ne.global_seq}`).join(','))
          .digest('hex');
        await recordAudit(clientExecutor(client), {
          projectId,
          actor: { system: 'weft-server' },
          action: 'events.ingested',
          subject: `stream:${projectId}`,
          afterHash: digest,
        });
      }
    }

    // Report cursors for every project touched (new or replayed).
    const streams: Record<string, StreamCursor> = {};
    const projectIds = [...new Set(list.map((e) => e.project_id))];
    for (const projectId of projectIds) {
      const res = await client.query(
        'SELECT last_seq, min_seq FROM project_stream_seq WHERE project_id = $1',
        [projectId],
      );
      const row = oneRow(res.rows);
      streams[projectId] = { last_seq: Number(row.last_seq), min_seq: Number(row.min_seq) };
    }

    return { inserted, existing, streams };
  }
}