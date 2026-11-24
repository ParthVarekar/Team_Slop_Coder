import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { metrics, type Logger } from '@weft/core';
import type { Actor, StoredEvent } from '@weft/protocol';

const HEARTBEAT_MS = 15_000;
const DRAIN_LIMIT = 5_000;
const RETRY_MS = 2_000;
const FRAME_CACHE_LIMIT = 10_000;

/** Enforcement-relevant prefixes pushed on the server→daemon coordination channel. */
const COORDINATION_PREFIXES = ['task.', 'reservation.', 'conflict.', 'merge.'];
const COORDINATION_FILTER = COORDINATION_PREFIXES.map((p) => `type LIKE '${p}%'`).join(' OR ');

const clients = metrics.gauge('weft_server_stream_clients', 'Connected SSE clients');
const sent = metrics.counter('weft_server_stream_events_sent_total', 'SSE events delivered');
const resyncs = metrics.counter('weft_server_stream_resync_total', 'Forced resyncs below watermark');

export type Channel = 'team' | 'coordination';

function isoStr(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

/** Map an events/coordination_events row to the protocol StoredEvent shape. */
export function mapStoredEvent(r: Record<string, unknown>): StoredEvent {
  return {
    v: Number(r.v) as 1,
    event_id: String(r.event_id),
    device_id: String(r.device_id),
    project_id: String(r.project_id),
    ...(r.repo_id ? { repo_id: String(r.repo_id) } : {}),
    ...(r.session_id ? { session_id: String(r.session_id) } : {}),
    ...(r.provider_session_id ? { provider_session_id: String(r.provider_session_id) } : {}),
    ...(r.task_id ? { task_id: String(r.task_id) } : {}),
    ...(r.seq != null ? { seq: Number(r.seq) } : {}),
    ts: isoStr(r.ts),
    type: String(r.type),
    actor: r.actor as Actor,
    privacy: r.privacy as 'metadata' | 'full',
    payload: r.payload as Record<string, unknown>,
    global_seq: Number(r.global_seq),
    received_at: isoStr(r.received_at),
  };
}

const TEAM_COLS = `event_id, v, device_id, project_id, repo_id, session_id, provider_session_id,
  task_id, seq, global_seq, ts, received_at, type, actor, payload, privacy`;
const COORD_COLS = `event_id, v, device_id, project_id, repo_id, session_id,
  task_id, seq, global_seq, ts, received_at, type, actor, payload, privacy`;

interface FrameCache {
  frames: Map<number, string>;
  latest: number;
}

export interface CachedFrames {
  frames: string[];
  complete: boolean;
}

/**
 * In-process wake signal (single process, no broker). The DB remains the source
 * of truth: a notify only tells subscribers to drain. Per-project listener sets
 * avoid EventEmitter max-listener limits and scope wakes to the right stream.
 * Committed ingest batches are serialized once and shared by team subscribers;
 * the bounded cache is only a fast path, never the durable source of truth.
 */
export class StreamHub {
  private readonly listeners = new Map<string, Set<() => void>>();
  private readonly cache = new Map<string, FrameCache>();

  publish(events: StoredEvent[]): void {
    const byProject = new Map<string, StoredEvent[]>();
    for (const event of events) {
      const list = byProject.get(event.project_id) ?? [];
      list.push(event);
      byProject.set(event.project_id, list);
    }
    for (const [projectId, list] of byProject) {
      const entry = this.cache.get(projectId) ?? { frames: new Map<number, string>(), latest: 0 };
      for (const event of list) {
        entry.frames.set(event.global_seq, `id: ${event.global_seq}\ndata: ${JSON.stringify(event)}\n\n`);
        entry.latest = Math.max(entry.latest, event.global_seq);
      }
      while (entry.frames.size > FRAME_CACHE_LIMIT) {
        const oldest = entry.frames.keys().next().value;
        if (oldest === undefined) break;
        entry.frames.delete(oldest);
      }
      this.cache.set(projectId, entry);
      this.notify(projectId);
    }
  }

  cachedAfter(projectId: string, after: number): CachedFrames {
    const entry = this.cache.get(projectId);
    if (!entry) return { frames: [], complete: false };
    const frames: string[] = [];
    let seq = after + 1;
    while (frames.length < DRAIN_LIMIT) {
      const frame = entry.frames.get(seq);
      if (frame === undefined) break;
      frames.push(frame);
      seq += 1;
    }
    return { frames, complete: seq > entry.latest };
  }

  notify(projectId: string): void {
    const set = this.listeners.get(projectId);
    if (set) for (const cb of set) cb();
  }

  notifyMany(projectIds: Iterable<string>): void {
    for (const id of projectIds) this.notify(id);
  }

  subscribe(projectId: string, cb: () => void): () => void {
    const set = this.listeners.get(projectId) ?? new Set<() => void>();
    this.listeners.set(projectId, set);
    set.add(cb);
    return () => {
      set.delete(cb);
      if (set.size === 0 && this.listeners.get(projectId) === set) this.listeners.delete(projectId);
    };
  }

  listenerCount(projectId: string): number {
    return this.listeners.get(projectId)?.size ?? 0;
  }

  close(): void {
    this.listeners.clear();
    this.cache.clear();
  }
}

export interface StreamOptions {
  pool: Pool;
  hub: StreamHub;
  projectId: string;
  channel: Channel;
  /** Resume cursor (global_seq) from Last-Event-ID or ?after. */
  cursor: number;
  logger?: Logger;
  /** Server-tracked cleanups so shutdown can force-end persistent connections. */
  activeStreams?: Set<() => void>;
}

/**
 * Hijack the response into an SSE stream: catch-up drain ordered by global_seq,
 * in-process wake on ingest, heartbeat, and Last-Event-ID resume. A cursor below
 * the project's min_seq watermark forces an explicit resync (never a silent
 * skip). Drains are serialized per connection so concurrent wakes cannot
 * interleave writes or duplicate events.
 */
export async function streamEvents(
  req: FastifyRequest,
  reply: FastifyReply,
  opts: StreamOptions,
): Promise<FastifyReply> {
  const { pool, hub, projectId, channel } = opts;
  reply.hijack();
  // Carry headers already set by plugins (notably @fastify/cors) onto the raw
  // response; hijack + writeHead bypasses Fastify's normal header serialization,
  // so without this the browser blocks the cross-origin stream body.
  const prepared: Record<string, string | number | string[]> = {};
  for (const [name, value] of Object.entries(reply.getHeaders())) {
    if (value !== undefined) prepared[name] = value;
  }
  reply.raw.writeHead(200, {
    ...prepared,
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  reply.raw.write(`retry: ${RETRY_MS}\n\n`);

  let closed = false;
  let lastSent = opts.cursor;

  if (channel === 'team') {
    const stream = await pool.query(
      'SELECT last_seq, min_seq FROM project_stream_seq WHERE project_id = $1',
      [projectId],
    );
    const row = stream.rows[0];
    const minSeq = row ? Number(row.min_seq) : 0;
    const lastSeq = row ? Number(row.last_seq) : 0;
    if (lastSent < minSeq) {
      resyncs.inc();
      reply.raw.write(`event: resync\ndata: ${JSON.stringify({ min_seq: minSeq, last_seq: lastSeq })}\n\n`);
      lastSent = Math.max(0, minSeq - 1);
    }
  }

  const table = channel === 'team' ? 'events' : 'coordination_events';
  const cols = channel === 'team' ? TEAM_COLS : COORD_COLS;
  const filter = channel === 'team' ? '' : ` AND (${COORDINATION_FILTER})`;

  const fetchAfter = async (after: number): Promise<Record<string, unknown>[]> => {
    const res = await pool.query(
      `SELECT ${cols} FROM ${table}
        WHERE project_id = $1 AND global_seq > $2${filter}
        ORDER BY global_seq ASC LIMIT $3`,
      [projectId, after, DRAIN_LIMIT],
    );
    return res.rows;
  };

  let draining = false;
  let queued = false;
  const drain = async (): Promise<void> => {
    if (closed) return;
    if (draining) {
      queued = true;
      return;
    }
    draining = true;
    try {
      for (;;) {
        queued = false;
        let progressed = false;
        if (channel === 'team') {
          const cached = hub.cachedAfter(projectId, lastSent);
          if (cached.frames.length > 0) {
            reply.raw.write(cached.frames.join(''));
            lastSent += cached.frames.length;
            sent.inc(cached.frames.length);
            progressed = true;
          }
          if (cached.complete && !queued) break;
        }
        const rows = await fetchAfter(lastSent);
        if (closed) return;
        if (rows.length > 0) {
          const frames = rows.map((r) => {
            const event = mapStoredEvent(r);
            return `id: ${event.global_seq}\ndata: ${JSON.stringify(event)}\n\n`;
          });
          reply.raw.write(frames.join(''));
          lastSent = Number(rows[rows.length - 1]?.global_seq);
          sent.inc(rows.length);
          progressed = true;
        }
        if (rows.length === 0) break;
        if (rows.length < DRAIN_LIMIT && !queued && channel !== 'team') break;
        if (!progressed) break;
      }
    } catch (err) {
      opts.logger?.debug({ err, projectId }, 'stream drain ended');
      cleanup();
    } finally {
      draining = false;
    }
  };

  const heartbeat = setInterval(() => {
    if (!closed) reply.raw.write(': hb\n\n');
  }, HEARTBEAT_MS);

  const unsubscribe = hub.subscribe(projectId, () => {
    void drain();
  });

  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
    opts.activeStreams?.delete(cleanup);
    clients.add(-1);
    try {
      reply.raw.end();
    } catch {
      /* already closed */
    }
  };

  clients.add(1);
  opts.activeStreams?.add(cleanup);
  req.raw.on('close', cleanup);
  reply.raw.on('error', cleanup);

  await drain();
  return reply;
}