import { redactPayload, metrics, type Logger, type Redactor } from '@weft/core';
import { safeParseEvent, isSystemActor, type EventEnvelope } from '@weft/protocol';
import type { LocalStore, SessionRecord, StoredLocalEvent } from './store.js';

const ingested = metrics.counter('weft_events_ingested_total', 'Events persisted locally');
const rejected = metrics.counter('weft_events_rejected_total', 'Events rejected at ingest');
const flushMs = metrics.histogram('weft_pipeline_flush_ms', 'Batch flush latency');
const buffered = metrics.gauge('weft_pipeline_buffered', 'Events awaiting flush');

export interface PipelineOptions {
  teamMode?: boolean;
  batchSize?: number;
  flushIntervalMs?: number;
  maxBufferedEvents?: number;
  redactor?: Redactor;
  logger?: Logger;
  /** Notified after a batch is durably written (drives local SSE). */
  onFlush?: (events: StoredLocalEvent[]) => void;
}

export interface EnqueueResult {
  accepted: boolean;
  event_id?: string;
  error?: string;
  reason?: 'invalid' | 'closed' | 'backpressure';
}

/**
 * Collector → redact → batched SQLite transaction. The hook path only enqueues
 * (sub-millisecond); a timer/full-batch trigger performs the durable write.
 */
export class EventPipeline {
  private buffer: StoredLocalEvent[] = [];
  private timer: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private readonly batchSize: number;
  private readonly flushIntervalMs: number;
  private readonly maxBufferedEvents: number;
  private readonly teamMode: boolean;
  private readonly redactor: Redactor | undefined;
  private readonly logger: Logger | undefined;
  private readonly onFlush: ((events: StoredLocalEvent[]) => void) | undefined;
  private closed = false;

  constructor(
    private readonly store: LocalStore,
    options: PipelineOptions = {},
  ) {
    this.batchSize = options.batchSize ?? 100;
    this.flushIntervalMs = options.flushIntervalMs ?? 50;
    this.maxBufferedEvents = options.maxBufferedEvents ?? 10_000;
    if (this.batchSize < 1 || this.flushIntervalMs < 1 || this.maxBufferedEvents < this.batchSize) {
      throw new RangeError(
        'pipeline capacities and intervals must be positive and max >= batch size',
      );
    }
    this.teamMode = options.teamMode ?? false;
    this.redactor = options.redactor;
    this.logger = options.logger;
    this.onFlush = options.onFlush;
  }

  enqueue(raw: unknown): EnqueueResult {
    if (this.closed) return { accepted: false, error: 'pipeline closed', reason: 'closed' };
    if (this.buffer.length >= this.maxBufferedEvents) {
      rejected.inc();
      return {
        accepted: false,
        error: 'pipeline buffer full',
        reason: 'backpressure',
      };
    }
    const result = safeParseEvent(raw);
    if (!result.success) {
      rejected.inc();
      return { accepted: false, error: result.error.message, reason: 'invalid' };
    }
    const event = result.data;
    const stored: StoredLocalEvent = {
      ...event,
      payload: redactPayload(event.payload, this.redactor),
      received_at: new Date().toISOString(),
    };
    this.buffer.push(stored);
    buffered.set(this.buffer.length);
    if (this.buffer.length >= this.batchSize) {
      this.flush();
    } else if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), this.flushIntervalMs);
      this.timer.unref?.();
    }
    return { accepted: true, event_id: event.event_id };
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.buffer.length === 0) return;
    const batch = this.buffer;
    this.buffer = [];
    buffered.set(0);
    const start = performance.now();
    try {
      this.store.insertEvents(batch, this.teamMode);
      for (const event of batch) this.projectSession(event);
      ingested.inc(batch.length);
      flushMs.observe(performance.now() - start);
      this.onFlush?.(batch);
    } catch (err) {
      this.logger?.error({ err }, 'pipeline flush failed; re-buffering batch');
      this.buffer.unshift(...batch);
      buffered.set(this.buffer.length);
      if (!this.closed) {
        this.retryTimer = setTimeout(() => this.flush(), Math.max(50, this.flushIntervalMs));
        this.retryTimer.unref?.();
      }
    }
  }

  private projectSession(e: EventEnvelope): void {
    if (!e.session_id) return;
    const payload = e.payload as Record<string, unknown>;
    if (e.type === 'session.started') {
      const agent = isSystemActor(e.actor) ? null : e.actor.agent;
      const record: SessionRecord = {
        session_id: e.session_id,
        device_id: e.device_id,
        provider_id: agent?.provider ?? null,
        provider_session_id: e.provider_session_id ?? e.session_id,
        task_id: e.task_id ?? null,
        developer_id: isSystemActor(e.actor) ? null : e.actor.user_id,
        cwd: typeof payload.cwd === 'string' ? payload.cwd : null,
        status: 'running',
        started_at: e.ts,
        ended_at: null,
        model: typeof payload.model === 'string' ? payload.model : null,
        prompt_summary: typeof payload.prompt_summary === 'string' ? payload.prompt_summary : null,
        fidelity: typeof payload.fidelity === 'string' ? payload.fidelity : 'high',
      };
      this.store.upsertSession(record);
    } else if (e.type === 'session.status' || e.type === 'session.ended') {
      const existing = this.store.getSession(e.session_id);
      if (!existing) return;
      const status =
        e.type === 'session.ended'
          ? typeof payload.reason === 'string'
            ? payload.reason
            : 'completed'
          : typeof payload.status === 'string'
            ? payload.status
            : existing.status;
      this.store.upsertSession({
        ...existing,
        status,
        ended_at: e.type === 'session.ended' ? e.ts : existing.ended_at,
      });
    }
  }

  get pending(): number {
    return this.buffer.length;
  }

  stop(): void {
    this.closed = true;
    this.flush();
  }
}
