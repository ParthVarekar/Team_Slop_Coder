import { metrics, type Logger } from '@weft/core';
import type { StoredEvent } from '@weft/protocol';
import type { EnforcementCache } from './enforcement.js';
import type { TaskCache } from './task-cache.js';
import type { ChangeCache } from './change-cache.js';
import type { LocalStore } from './store.js';

const received = metrics.counter(
  'weft_coordination_events_received_total',
  'Coordination events applied',
);
const reconnects = metrics.counter(
  'weft_coordination_reconnects_total',
  'Coordination reconnect attempts',
);
const resyncs = metrics.counter('weft_coordination_resyncs_total', 'Forced coordination resyncs');
const connectedGauge = metrics.gauge(
  'weft_coordination_connected',
  'Coordination link up (1) or stale (0)',
);

const CURSOR_KEY = 'coordination_cursor';

export interface CoordinationOptions {
  baseUrl: string;
  token: string;
  projectId: string;
  cache: EnforcementCache;
  taskCache?: TaskCache;
  changeCache?: ChangeCache;
  store?: LocalStore;
  fetchImpl?: typeof fetch;
  logger?: Logger;
  reconnectMs?: number;
  maxReconnectMs?: number;
  onEvent?: (event: StoredEvent) => void;
}

/**
 * Server→daemon coordination link. Authenticates with the device's project
 * token, resumes from a global_seq cursor (Last-Event-ID) across reconnects,
 * and projects the durable trail into the enforcement cache. The cache is
 * volatile, so a fresh process replays from seq 0 to rebuild authoritative
 * state; the persisted cursor is a durable progress marker. While disconnected
 * the cache is marked stale (hard reservations fail closed, soft fail open).
 */
export class CoordinationClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly projectId: string;
  private readonly cache: EnforcementCache;
  private readonly taskCache: TaskCache | undefined;
  private readonly changeCache: ChangeCache | undefined;
  private readonly store: LocalStore | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly logger: Logger | undefined;
  private readonly baseReconnect: number;
  private readonly maxReconnect: number;
  private readonly onEvent: ((event: StoredEvent) => void) | undefined;

  private cursor = 0;
  private backoff: number;
  private closed = false;
  private connected = false;
  private controller: AbortController | null = null;
  private running: Promise<void> | null = null;
  private sleepResolve: (() => void) | null = null;

  constructor(options: CoordinationOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.token = options.token;
    this.projectId = options.projectId;
    this.cache = options.cache;
    this.taskCache = options.taskCache;
    this.changeCache = options.changeCache;
    this.store = options.store;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.logger = options.logger;
    this.baseReconnect = options.reconnectMs ?? 1000;
    this.maxReconnect = options.maxReconnectMs ?? 30_000;
    this.onEvent = options.onEvent;
    this.backoff = this.baseReconnect;
  }

  start(): void {
    if (this.closed || this.running) return;
    this.running = this.run().finally(() => {
      this.running = null;
    });
  }

  getCursor(): number {
    return this.cursor;
  }

  isConnected(): boolean {
    return this.connected;
  }

  private async run(): Promise<void> {
    while (!this.closed) {
      try {
        await this.connectOnce();
      } catch (err) {
        this.logger?.debug({ err }, 'coordination link ended');
      }
      this.connected = false;
      connectedGauge.set(0);
      this.cache.setStale(true);
      this.taskCache?.setStale(true);
      this.changeCache?.setStale(true);
      if (this.closed) break;
      reconnects.inc();
      await this.sleep(this.backoff);
      this.backoff = Math.min(this.maxReconnect, this.backoff * 2);
    }
  }

  private async connectOnce(): Promise<void> {
    this.controller = new AbortController();
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.token}`,
      accept: 'text/event-stream',
    };
    if (this.cursor > 0) headers['last-event-id'] = String(this.cursor);
    const url = `${this.baseUrl}/v1/coordination?projectId=${encodeURIComponent(this.projectId)}`;
    const res = await this.fetchImpl(url, { headers, signal: this.controller.signal });
    if (res.status !== 200 || !res.body) {
      await res.body?.cancel().catch(() => undefined);
      throw new Error(`coordination connect failed: ${res.status}`);
    }
    this.backoff = this.baseReconnect;
    this.connected = true;
    connectedGauge.set(1);
    this.cache.setStale(false);
    this.taskCache?.setStale(false);
    this.changeCache?.setStale(false);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          this.handleFrame(block);
        }
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* stream already closed */
      }
    }
  }

  private handleFrame(block: string): void {
    let event: string | undefined;
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith(':')) continue;
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).trim());
    }
    if (data.length === 0) return;
    const payload = data.join('\n');

    if (event === 'resync') {
      const parsed = JSON.parse(payload) as { min_seq?: number };
      const minSeq = typeof parsed.min_seq === 'number' ? parsed.min_seq : 0;
      this.cache.clear();
      this.taskCache?.clear();
      this.changeCache?.clear();
      this.cursor = Math.max(0, minSeq - 1);
      this.persistCursor();
      resyncs.inc();
      this.logger?.warn({ min_seq: minSeq }, 'coordination forced resync; rebuilding cache');
      return;
    }

    const stored = JSON.parse(payload) as StoredEvent;
    if (typeof stored.global_seq !== 'number') return;
    this.cache.applyEvent(stored);
    this.taskCache?.applyEvent(stored);
    this.changeCache?.applyEvent(stored);
    if (stored.global_seq > this.cursor) {
      this.cursor = stored.global_seq;
      this.persistCursor();
    }
    received.inc();
    this.onEvent?.(stored);
  }

  private persistCursor(): void {
    this.store?.setSyncState(CURSOR_KEY, String(this.cursor));
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.sleepResolve = null;
        resolve();
      }, ms);
      timer.unref?.();
      this.sleepResolve = () => {
        clearTimeout(timer);
        this.sleepResolve = null;
        resolve();
      };
    });
  }

  async stop(): Promise<void> {
    this.closed = true;
    this.controller?.abort();
    this.sleepResolve?.();
    if (this.running) await this.running.catch(() => undefined);
    this.connected = false;
    connectedGauge.set(0);
    this.cache.setStale(true);
    this.taskCache?.setStale(true);
    this.changeCache?.setStale(true);
  }
}
