import { metrics, type Logger } from '@weft/core';
import type { LocalStore } from './store.js';

const shipped = metrics.counter('weft_shipper_shipped_total', 'Events accepted by the server');
const duplicated = metrics.counter(
  'weft_shipper_duplicates_total',
  'Replays deduplicated by the server',
);
const rejected = metrics.counter(
  'weft_shipper_rejected_total',
  'Events rejected (poison pills removed)',
);
const batches = metrics.counter('weft_shipper_batches_total', 'Ingest batches shipped');
const errors = metrics.counter(
  'weft_shipper_errors_total',
  'Shipping failures (network/server/auth)',
);
const compacted = metrics.counter(
  'weft_shipper_compacted_total',
  'Telemetry rows compacted from the outbox',
);
const pendingGauge = metrics.gauge('weft_outbox_pending', 'Unshipped outbox rows');

interface IngestedRef {
  event_id: string;
  global_seq: number;
  received_at: string;
}
interface ServerIngestResult {
  accepted: IngestedRef[];
  duplicates: IngestedRef[];
  rejected: { event_id?: string; error: string }[];
}

export interface DrainResult {
  shipped: number;
  duplicates: number;
  rejected: number;
  batches: number;
  error?: string;
}

export interface ShipperOptions {
  baseUrl: string;
  token: string;
  store: LocalStore;
  fetchImpl?: typeof fetch;
  logger?: Logger;
  /** Events per ingest POST (server cap is 1000). */
  batchSize?: number;
  /** Soft pending-row budget; oldest telemetry compacted first. */
  maxOutboxRows?: number;
  /** Idle poll interval. */
  intervalMs?: number;
  requestTimeoutMs?: number;
  backoffMs?: number;
  maxBackoffMs?: number;
}

type PostResult =
  { ok: true; data: ServerIngestResult } | { ok: false; status: number; error: string };

/**
 * Drains the durable SQLite outbox to the team server. Each batch is a single
 * idempotent POST (event_id is the dedup key); accepted AND duplicate refs are
 * acked (deleted), so a crash between POST and ack replays safely without loss
 * or duplication. Network/server/auth failures back off and retain the rows.
 * The pending outbox is bounded by compacting oldest telemetry first; durable
 * coordination rows are never dropped.
 */
export class OutboxShipper {
  private readonly store: LocalStore;
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly logger: Logger | undefined;
  private readonly batchSize: number;
  private readonly maxOutboxRows: number;
  private readonly intervalMs: number;
  private readonly requestTimeoutMs: number;
  private readonly baseBackoff: number;
  private readonly maxBackoff: number;

  private backoff: number;
  private timer: NodeJS.Timeout | null = null;
  private inflight: Promise<DrainResult> | null = null;
  private wakePending = false;
  private closed = false;

  constructor(options: ShipperOptions) {
    this.store = options.store;
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.logger = options.logger;
    this.batchSize = Math.min(options.batchSize ?? 200, 1000);
    this.maxOutboxRows = options.maxOutboxRows ?? 50_000;
    this.intervalMs = options.intervalMs ?? 1000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    this.baseBackoff = options.backoffMs ?? 500;
    this.maxBackoff = options.maxBackoffMs ?? 30_000;
    this.backoff = this.baseBackoff;
  }

  start(): void {
    if (this.closed || this.timer) return;
    this.timer = setInterval(() => void this.kick(), this.intervalMs);
    this.timer.unref?.();
    void this.kick();
  }

  /** Wake the shipper after a durable flush (coalesces into a running drain). */
  notify(): void {
    if (this.closed) return;
    if (this.inflight) {
      this.wakePending = true;
      return;
    }
    void this.kick();
  }

  /** Drain everything pending now; resolves when the queue empties or errors. */
  drain(): Promise<DrainResult> {
    return this.kick();
  }

  get pending(): number {
    return this.store.pendingOutboxCount();
  }

  private kick(): Promise<DrainResult> {
    if (this.inflight) return this.inflight;
    this.inflight = this.drainLoop().finally(() => {
      this.inflight = null;
      if (this.wakePending && !this.closed) {
        this.wakePending = false;
        void this.kick();
      }
    });
    return this.inflight;
  }

  private async drainLoop(): Promise<DrainResult> {
    const total: DrainResult = { shipped: 0, duplicates: 0, rejected: 0, batches: 0 };
    try {
      for (;;) {
        if (this.closed) break;
        // Enforce the cap before every post, including when HTTP fails. The
        // finally path also bounds a queue left by an interrupted earlier drain.
        const removed = this.store.compactOutbox(this.maxOutboxRows);
        if (removed > 0) compacted.inc(removed);
        const rows = this.store.pendingOutbox(this.batchSize);
        if (rows.length === 0) break;
        const ids = rows.map((r) => r.event_id);
        const events = rows.map((r) => JSON.parse(r.envelope) as unknown);

        let result: PostResult;
        try {
          result = await this.post(events);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.store.markOutboxAttempt(ids, message);
          errors.inc();
          this.backoff = Math.min(this.maxBackoff, this.backoff * 2);
          this.logger?.warn({ err, pending: ids.length }, 'shipper network failure; backing off');
          total.error = message;
          break;
        }

        if (!result.ok) {
          this.store.markOutboxAttempt(ids, result.error);
          errors.inc();
          this.backoff = Math.min(this.maxBackoff, this.backoff * 2);
          this.logger?.warn(
            { status: result.status, error: result.error, pending: ids.length },
            'shipper rejected by server; backing off',
          );
          total.error = result.error;
          break;
        }

        const data = result.data;
        const ackIds = [
          ...data.accepted.map((r) => r.event_id),
          ...data.duplicates.map((r) => r.event_id),
          ...data.rejected
            .map((r) => r.event_id)
            .filter((id): id is string => typeof id === 'string'),
        ];
        // A batch-level rejection (no per-event ids) cannot be acked; retain + back off.
        if (ackIds.length === 0 && data.rejected.length > 0) {
          const message = data.rejected[0]?.error ?? 'batch rejected';
          this.store.markOutboxAttempt(ids, message);
          errors.inc();
          this.backoff = Math.min(this.maxBackoff, this.backoff * 2);
          total.error = message;
          break;
        }
        if (data.rejected.length > 0) {
          this.logger?.error({ rejected: data.rejected }, 'shipper dropping invalid events');
        }
        this.store.ackOutbox(ackIds);
        total.shipped += data.accepted.length;
        total.duplicates += data.duplicates.length;
        total.rejected += data.rejected.length;
        total.batches += 1;
        shipped.inc(data.accepted.length);
        duplicated.inc(data.duplicates.length);
        rejected.inc(data.rejected.length);
        batches.inc();
        this.backoff = this.baseBackoff;
      }
    } finally {
      const finalRemoved = this.store.compactOutbox(this.maxOutboxRows);
      if (finalRemoved > 0) compacted.inc(finalRemoved);
      pendingGauge.set(this.store.pendingOutboxCount());
    }
    return total;
  }

  private async post(events: unknown[]): Promise<PostResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    timeout.unref?.();
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/v1/ingest`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ events }),
        signal: controller.signal,
      });
      if (res.status === 202 || res.status === 200) {
        return { ok: true, data: (await res.json()) as ServerIngestResult };
      }
      const body = (await res.json().catch(() => ({}))) as { error?: string; reason?: string };
      return {
        ok: false,
        status: res.status,
        error: body.reason ?? body.error ?? `http ${res.status}`,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  async stop(): Promise<void> {
    this.closed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.inflight) await this.inflight.catch(() => undefined);
  }
}
