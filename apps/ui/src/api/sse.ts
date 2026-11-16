import type { ConnectionStatus, WeftEvent } from '../lib/types.js';
import { authHeaders } from './client.js';

export interface SseHandlers {
  onEvent: (event: WeftEvent) => void;
  onStatus: (status: ConnectionStatus) => void;
}

export interface SseOptions {
  /** Team-server origin. Omit for the local daemon (relative /v1 paths). */
  baseUrl?: string;
  /** Required for the team stream; the local daemon infers its own project. */
  projectId?: string;
  /** Team Bearer headers. Omit to use the local bootstrapped hook secret. */
  headers?: Record<string, string>;
  /** Fired when the server forces a resync below the retention watermark. */
  onResync?: (info: { min_seq: number; last_seq: number }) => void;
}

const MAX_BACKOFF_MS = 15_000;

/**
 * fetch-based SSE client (EventSource cannot send the Authorization header).
 * Tracks a numeric resume cursor — the daemon's rowid or the server's global_seq,
 * both delivered as `id:` frames — and resumes with Last-Event-ID on reconnect
 * with exponential backoff. Heartbeat/retry frames are ignored; a server `resync`
 * event is surfaced separately so its payload is never ingested as an event.
 */
export class SseClient {
  private controller: AbortController | null = null;
  private cursor = 0;
  private stopped = false;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly handlers: SseHandlers,
    private readonly options: SseOptions = {},
  ) {}

  start(after = 0): void {
    this.cursor = after;
    this.stopped = false;
    this.attempt = 0;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.controller?.abort();
    this.handlers.onStatus('offline');
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    this.handlers.onStatus(this.attempt === 0 ? 'connecting' : 'reconnecting');
    this.controller = new AbortController();
    try {
      const base = this.options.baseUrl ?? '';
      const query = new URLSearchParams({ after: String(this.cursor) });
      if (this.options.projectId) query.set('projectId', this.options.projectId);
      const res = await fetch(`${base}/v1/stream?${query.toString()}`, {
        headers: {
          ...(this.options.headers ?? authHeaders()),
          ...(this.cursor > 0 ? { 'last-event-id': String(this.cursor) } : {}),
        },
        signal: this.controller.signal,
      });
      if (!res.ok || !res.body) throw new Error(`stream → ${res.status}`);
      this.handlers.onStatus('live');
      this.attempt = 0;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        buffer = this.parse(buffer);
      }
    } catch {
      /* aborted or network error; fall through to reconnect */
    }
    if (this.stopped) return;
    this.attempt += 1;
    this.handlers.onStatus('reconnecting');
    const delay = Math.min(1000 * 2 ** this.attempt, MAX_BACKOFF_MS);
    this.timer = setTimeout(() => void this.connect(), delay);
  }

  private parse(buffer: string): string {
    let boundary = buffer.indexOf('\n\n');
    while (boundary !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      let id = '';
      let data = '';
      let name = '';
      for (const line of frame.split('\n')) {
        if (line.startsWith('id:')) id = line.slice(3).trim();
        else if (line.startsWith('event:')) name = line.slice(6).trim();
        else if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (id) {
        const parsed = Number(id);
        if (Number.isFinite(parsed)) this.cursor = parsed;
      }
      if (data) {
        try {
          const value = JSON.parse(data) as Record<string, unknown>;
          if (name === 'resync') {
            this.options.onResync?.({
              min_seq: Number(value.min_seq) || 0,
              last_seq: Number(value.last_seq) || 0,
            });
          } else {
            this.handlers.onEvent(value as unknown as WeftEvent);
          }
        } catch {
          /* ignore malformed frame */
        }
      }
      boundary = buffer.indexOf('\n\n');
    }
    return buffer;
  }
}