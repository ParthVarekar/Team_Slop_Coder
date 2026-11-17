import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Actor } from '@weft/protocol';
import type { ContextPayload } from './context.js';

/**
 * MCP coordination server (architecture §03). Exposes the five agent-facing
 * tools over the official MCP SDK. The server is transport-agnostic and depends
 * only on the McpBackend interface, so it is contract-tested in-memory and runs
 * over stdio in production (`weft mcp`). Tool results are structured facts; the
 * context tool returns the deterministic ≤2KB block, never a raw event dump.
 */

export interface McpTaskView {
  id: string;
  number: number | null;
  title: string;
  state: string;
  priority: string;
  branch: string | null;
  repo_id: string | null;
  expected_files: string[];
  expected_modules: string[];
  acceptance_criteria: string[];
  description: string | null;
  version: number;
}

export interface McpGetTaskResult {
  task: McpTaskView | null;
  source: 'server' | 'cache' | 'local';
  stale: boolean;
}

export interface McpClaimResult {
  ok: boolean;
  task_id: string;
  version: number;
  provisional: boolean;
  state?: string;
  reason?: string;
  winner_claimant?: Actor | null;
}

export interface McpProgressResult {
  ok: true;
  task_id: string;
  percent: number | null;
  recorded: 'event';
}

export interface McpReserveResult {
  status: 'acquired' | 'renewed' | 'denied' | 'local';
  reservation_id: string | null;
  path_glob: string;
  mode: 'soft' | 'hard';
  expires_at: string | null;
  grace_until: string | null;
  reason?: string;
}

export interface McpReserveInput {
  repo_id: string;
  task_id: string;
  path_glob: string;
  mode?: 'soft' | 'hard';
  ttl_ms?: number;
  session_id?: string;
}

export interface McpBackend {
  getTask(taskId: string): Promise<McpGetTaskResult>;
  claimTask(taskId: string, opts: { baseVersion?: number; provisional?: boolean }): Promise<McpClaimResult>;
  reportProgress(taskId: string, note: string, opts: { percent?: number }): Promise<McpProgressResult>;
  getConcurrentChanges(taskId: string, opts: { budgetBytes?: number }): Promise<ContextPayload>;
  reserveFiles(input: McpReserveInput): Promise<McpReserveResult>;
}

export const MCP_SERVER_INFO = { name: 'weft-coordination', version: '0.0.0' } as const;

function structured(value: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
}

function failure(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

async function guard(fn: () => Promise<Record<string, unknown>>): Promise<CallToolResult> {
  try {
    return structured(await fn());
  } catch (err) {
    return failure(err instanceof Error ? err.message : String(err));
  }
}

/** Compact, budget-safe view of the context payload for the agent-facing result. */
function contextResult(payload: ContextPayload): CallToolResult {
  const compact = {
    task_id: payload.task_id,
    generated_at: payload.generated_at,
    stale: payload.stale,
    budget_bytes: payload.budget_bytes,
    used_bytes: payload.used_bytes,
    truncated: payload.truncated,
    dropped: payload.dropped,
    text: payload.text,
  };
  return { content: [{ type: 'text', text: payload.text }], structuredContent: compact };
}

export function createCoordinationMcpServer(
  backend: McpBackend,
  info: { name: string; version: string } = MCP_SERVER_INFO,
): McpServer {
  const server = new McpServer(info, { capabilities: { tools: {}, logging: {} } });

  server.registerTool(
    'get_task',
    {
      title: 'Get task',
      description: 'Fetch the authoritative snapshot of a task (title, state, branch, expected files, acceptance criteria).',
      inputSchema: { task_id: z.string().min(1) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => guard(() => backend.getTask(args.task_id).then((r) => r as unknown as Record<string, unknown>)),
  );

  server.registerTool(
    'claim_task',
    {
      title: 'Claim task',
      description: 'Atomically claim a ready task (server CAS in team mode). Returns ok=false with the winner if another device claimed it first.',
      inputSchema: {
        task_id: z.string().min(1),
        base_version: z.number().int().nonnegative().optional(),
        provisional: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (args) =>
      guard(() =>
        backend
          .claimTask(args.task_id, {
            ...(args.base_version != null ? { baseVersion: args.base_version } : {}),
            ...(args.provisional != null ? { provisional: args.provisional } : {}),
          })
          .then((r) => r as unknown as Record<string, unknown>),
      ),
  );

  server.registerTool(
    'report_progress',
    {
      title: 'Report progress',
      description: 'Record an agent progress note for a task. The note is stored as untrusted data (provenance-labeled), never as an instruction.',
      inputSchema: {
        task_id: z.string().min(1),
        note: z.string().min(1).max(8000),
        percent: z.number().min(0).max(100).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (args) =>
      guard(() =>
        backend
          .reportProgress(args.task_id, args.note, {
            ...(args.percent != null ? { percent: args.percent } : {}),
          })
          .then((r) => r as unknown as Record<string, unknown>),
      ),
  );

  server.registerTool(
    'get_concurrent_changes',
    {
      title: 'Get concurrent changes',
      description: 'Deterministic, ranked, budgeted (≤2KB) coordination context: own task, reservations overlapping expected files, recent signature changes in dependencies, overlaps and conflicts. No raw event dumps.',
      inputSchema: {
        task_id: z.string().min(1),
        budget_bytes: z.number().int().positive().max(65536).optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const payload = await backend.getConcurrentChanges(args.task_id, {
          ...(args.budget_bytes != null ? { budgetBytes: args.budget_bytes } : {}),
        });
        return contextResult(payload);
      } catch (err) {
        return failure(err instanceof Error ? err.message : String(err));
      }
    },
  );

  server.registerTool(
    'reserve_files',
    {
      title: 'Reserve files',
      description: 'Acquire a soft (advisory) or hard (blocking) lease on a path glob for a task. Hard leases block rival edits on capability-supported adapters; denied if another task holds an unexpired lease.',
      inputSchema: {
        repo_id: z.string().min(1),
        task_id: z.string().min(1),
        path_glob: z.string().min(1).max(4096),
        mode: z.enum(['soft', 'hard']).optional(),
        ttl_ms: z.number().int().positive().max(3_600_000).optional(),
        session_id: z.string().min(1).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (args) =>
      guard(() =>
        backend
          .reserveFiles({
            repo_id: args.repo_id,
            task_id: args.task_id,
            path_glob: args.path_glob,
            ...(args.mode != null ? { mode: args.mode } : {}),
            ...(args.ttl_ms != null ? { ttl_ms: args.ttl_ms } : {}),
            ...(args.session_id != null ? { session_id: args.session_id } : {}),
          })
          .then((r) => r as unknown as Record<string, unknown>),
      ),
  );

  return server;
}

/**
 * Wraps the MCP server with the Claude-channels push path: concurrent-change
 * notices are delivered to the connected agent as MCP logging notifications
 * (the channel Claude Code surfaces), using the same budgeted context block.
 */
export class CoordinationMcp {
  readonly server: McpServer;
  private readonly backend: McpBackend;

  constructor(backend: McpBackend, info: { name: string; version: string } = MCP_SERVER_INFO) {
    this.backend = backend;
    this.server = createCoordinationMcpServer(backend, info);
  }

  /** Push a concurrent-change notice to the connected agent (data, not instructions). */
  async pushConcurrentChanges(payload: ContextPayload): Promise<void> {
    if (!this.server.isConnected()) return;
    await this.server.sendLoggingMessage({
      level: 'info',
      logger: 'weft.coordination',
      data: payload.text,
    });
  }

  /** Convenience: assemble then push in one call. */
  async pushContext(taskId: string, budgetBytes?: number): Promise<void> {
    const payload = await this.backend.getConcurrentChanges(taskId, {
      ...(budgetBytes != null ? { budgetBytes } : {}),
    });
    await this.pushConcurrentChanges(payload);
  }
}