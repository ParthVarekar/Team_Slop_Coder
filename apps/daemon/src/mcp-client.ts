import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { StoredEvent } from '@weft/protocol';
import type { ContextPayload } from './context.js';
import {
  CoordinationMcp,
  type McpBackend,
  type McpClaimResult,
  type McpGetTaskResult,
  type McpProgressResult,
  type McpReserveInput,
  type McpReserveResult,
} from './mcp.js';

/**
 * MCP backend that talks to the running daemon over its loopback HTTP API. The
 * `weft mcp` stdio process is intentionally stateless: the daemon owns the store,
 * the coordination projections and the server RPC, so two processes never open
 * the same WAL database or double-run the sync loops.
 */
export interface HttpMcpBackendOptions {
  baseUrl: string;
  secret: string;
  fetchImpl?: typeof fetch;
}

export class HttpMcpBackend implements McpBackend {
  private readonly baseUrl: string;
  private readonly secret: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HttpMcpBackendOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.secret = options.secret;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async call(method: string, path: string, body?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.secret}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const message = typeof json.message === 'string' ? json.message : `${method} ${path} failed: ${res.status}`;
      throw new Error(message);
    }
    return json;
  }

  async getTask(taskId: string): Promise<McpGetTaskResult> {
    return (await this.call('GET', `/v1/mcp/task/${encodeURIComponent(taskId)}`)) as unknown as McpGetTaskResult;
  }

  async claimTask(taskId: string, opts: { baseVersion?: number; provisional?: boolean }): Promise<McpClaimResult> {
    const json = await this.call('POST', '/v1/mcp/claim', {
      task_id: taskId,
      ...(opts.baseVersion != null ? { base_version: opts.baseVersion } : {}),
      ...(opts.provisional != null ? { provisional: opts.provisional } : {}),
    });
    return json as unknown as McpClaimResult;
  }

  async reportProgress(taskId: string, note: string, opts: { percent?: number }): Promise<McpProgressResult> {
    const json = await this.call('POST', '/v1/mcp/progress', {
      task_id: taskId,
      note,
      ...(opts.percent != null ? { percent: opts.percent } : {}),
    });
    return json as unknown as McpProgressResult;
  }

  async getConcurrentChanges(taskId: string, opts: { budgetBytes?: number }): Promise<ContextPayload> {
    const query = new URLSearchParams({ task_id: taskId });
    if (opts.budgetBytes != null) query.set('budget_bytes', String(opts.budgetBytes));
    return (await this.call('GET', `/v1/context?${query.toString()}`)) as unknown as ContextPayload;
  }

  async reserveFiles(input: McpReserveInput): Promise<McpReserveResult> {
    const json = await this.call('POST', '/v1/mcp/reserve', {
      repo_id: input.repo_id,
      task_id: input.task_id,
      path_glob: input.path_glob,
      ...(input.mode != null ? { mode: input.mode } : {}),
      ...(input.ttl_ms != null ? { ttl_ms: input.ttl_ms } : {}),
      ...(input.session_id != null ? { session_id: input.session_id } : {}),
    });
    return json as unknown as McpReserveResult;
  }
}

const PUSH_TYPES = new Set([
  'reservation.acquired',
  'reservation.renewed',
  'reservation.released',
  'conflict.detected',
  'conflict.resolved',
  'conflict.dismissed',
  'task.progress',
  'task.claimed',
  'task.released',
]);
const PUSH_DEBOUNCE_MS = 250;

function affectedTaskId(e: StoredEvent): string | null {
  if (e.task_id) return e.task_id;
  const p = e.payload as Record<string, unknown>;
  if (typeof p.holder_task_id === 'string') return p.holder_task_id;
  if (typeof p.task_id === 'string') return p.task_id;
  if (Array.isArray(p.task_ids) && typeof p.task_ids[0] === 'string') return p.task_ids[0];
  return null;
}

/**
 * Claude-channels push: subscribe to the daemon's live coordination stream and
 * deliver a budgeted context notice (MCP logging notification) whenever a change
 * affects a task. Bursts are coalesced per task. Diagnostics go to stderr only —
 * stdout is reserved for the MCP JSON-RPC transport.
 */
export async function subscribePush(
  mcp: CoordinationMcp,
  options: HttpMcpBackendOptions,
  signal: AbortSignal,
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/$/, '');
  const timers = new Map<string, NodeJS.Timeout>();
  const schedule = (taskId: string): void => {
    const existing = timers.get(taskId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      timers.delete(taskId);
      void mcp.pushContext(taskId).catch((err) => process.stderr.write(`weft mcp push failed: ${String(err)}\n`));
    }, PUSH_DEBOUNCE_MS);
    timer.unref?.();
    timers.set(taskId, timer);
  };

  while (!signal.aborted) {
    try {
      const res = await fetchImpl(`${baseUrl}/v1/coordination/stream`, {
        headers: { authorization: `Bearer ${options.secret}`, accept: 'text/event-stream' },
        signal,
      });
      if (res.status !== 200 || !res.body) {
        await res.body?.cancel().catch(() => undefined);
        throw new Error(`coordination stream failed: ${res.status}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          for (const line of block.split('\n')) {
            if (!line.startsWith('data:')) continue;
            try {
              const event = JSON.parse(line.slice(5).trim()) as StoredEvent;
              if (!PUSH_TYPES.has(event.type)) continue;
              const taskId = affectedTaskId(event);
              if (taskId) schedule(taskId);
            } catch {
              /* ignore malformed frame */
            }
          }
        }
      }
    } catch {
      /* reconnect below unless aborted */
    }
    if (signal.aborted) break;
    await new Promise((resolve) => {
      const t = setTimeout(resolve, 1000);
      t.unref?.();
      signal.addEventListener('abort', () => { clearTimeout(t); resolve(undefined); }, { once: true });
    });
  }
  for (const timer of timers.values()) clearTimeout(timer);
}

export interface StdioMcpHandle {
  mcp: CoordinationMcp;
  close(): Promise<void>;
}

/** Connect the coordination MCP server over stdio and start the push channel. */
export async function connectStdioMcp(options: HttpMcpBackendOptions): Promise<StdioMcpHandle> {
  const backend = new HttpMcpBackend(options);
  const mcp = new CoordinationMcp(backend);
  await mcp.server.connect(new StdioServerTransport());
  const controller = new AbortController();
  void subscribePush(mcp, options, controller.signal);
  return {
    mcp,
    close: async () => {
      controller.abort();
      await mcp.server.close();
    },
  };
}