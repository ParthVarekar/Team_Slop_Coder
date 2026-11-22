import { timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import { z } from 'zod';
import { PROTOCOL_VERSION, TaskStateSchema, type AgentInfo, type Privacy } from '@weft/protocol';
import { translateHook, AdapterError, denyPreToolUse, CAPABILITY_MANIFEST as CLAUDE_MANIFEST, type CapabilityManifest } from '@weft/adapter-claude-code';
import {
  translateHook as translateCodexHook,
  translateNotify as translateCodexNotify,
  AdapterError as CodexAdapterError,
  CAPABILITY_MANIFEST as CODEX_MANIFEST,
} from '@weft/adapter-codex';
import {
  OpenCodeTranslator,
  AdapterError as OpenCodeAdapterError,
} from '@weft/adapter-opencode';
import type { Daemon } from './daemon.js';
import { TaskError, UpdateTaskInputSchema } from './tasks.js';
import { RepoError } from './repos.js';
import { WorktreeError } from './worktrees.js';
import { ConflictDetectorError } from './conflicts.js';
import { IndexerError } from './indexer.js';
import { OverlapError } from './overlap.js';
import { ResolverError } from './resolver.js';
import { ModuleGraphError, dependentsOf } from './module-graph.js';
import { ValidationRunError } from './validation.js';
import { AttributionError } from './attribution.js';
import { MergeExecutorError } from './merge-executor.js';
import { evaluateContractGates, type ContractGateConfig } from './contract-gates.js';
import { draftEvent } from './events.js';
import { CoordinationRpcError } from './coordination-rpc.js';
import type { StoredLocalEvent } from './store.js';

const HEARTBEAT_MS = 15_000;
const CATCH_UP_LIMIT = 100_000;

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function writeEvent(reply: FastifyReply, event: StoredLocalEvent): void {
  reply.raw.write(`id: ${event.rowid ?? 0}\ndata: ${JSON.stringify(event)}\n\n`);
}

function taskErrorReply(reply: FastifyReply, err: TaskError): FastifyReply {
  const status =
    err.code === 'not_found'
      ? 404
      : err.code === 'conflict'
        ? 409
        : err.code === 'invalid_transition' || err.code === 'evidence_required'
          ? 422
          : 400;
  return reply.code(status).send({ error: err.code, message: err.message });
}

const PatchTaskBody = z.object({
  version: z.number().int().nonnegative(),
  fields: UpdateTaskInputSchema,
});
const TransitionBody = z.object({
  version: z.number().int().nonnegative(),
  to: TaskStateSchema,
  reason: z.string().max(2000).optional(),
});
const RegisterRepoBody = z.object({ path: z.string().min(1).max(4096) });
const ReservationCheckBody = z.object({
  path: z.string().min(1).max(4096),
  task_id: z.string().min(1).optional(),
});
const ContextQuery = z.object({
  task_id: z.string().min(1),
  budget_bytes: z.coerce.number().int().positive().max(65536).optional(),
});
const McpClaimBody = z.object({
  task_id: z.string().min(1),
  base_version: z.number().int().nonnegative().optional(),
  provisional: z.boolean().optional(),
});
const McpProgressBody = z.object({
  task_id: z.string().min(1),
  note: z.string().min(1).max(8000),
  percent: z.number().min(0).max(100).optional(),
});
const McpReserveBody = z.object({
  repo_id: z.string().min(1),
  task_id: z.string().min(1),
  path_glob: z.string().min(1).max(4096),
  mode: z.enum(['soft', 'hard']).optional(),
  ttl_ms: z.number().int().positive().max(3_600_000).optional(),
  session_id: z.string().min(1).optional(),
});

function mcpErrorReply(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof CoordinationRpcError) {
    const status = err.status >= 400 && err.status < 600 ? err.status : 502;
    return reply.code(status).send({ error: err.code, message: err.message });
  }
  return reply.code(422).send({ error: 'mcp_error', message: err instanceof Error ? err.message : String(err) });
}

function repoErrorReply(reply: FastifyReply, err: RepoError): FastifyReply {
  const status = err.code === 'not_found' ? 404 : 422;
  return reply.code(status).send({ error: err.code, message: err.message });
}

const ProvisionWorktreeBody = z.object({
  task_id: z.string().min(1),
  confirmed: z.boolean().default(false),
  provisional: z.boolean().default(false),
  base_ref: z.string().min(1).optional(),
  owner_pid: z.number().int().positive().optional(),
});
const AssignAgentBody = z.object({ pid: z.number().int().positive() });
const DetectConflictsBody = z.object({
  tasks: z.array(z.object({ task_id: z.string().min(1), branch: z.string().min(1) })).min(1).max(200),
  base_ref: z.string().min(1).optional(),
  epoch: z.number().int().nonnegative().optional(),
});
const IndexRepoBody = z.object({
  branch: z.string().min(1).max(255).optional(),
  from_ref: z.boolean().optional(),
});
const ReferencesBody = z.object({
  file_path: z.string().min(1).max(4096),
  name: z.string().min(1).max(255),
  container: z.string().max(255).optional(),
  kind: z.string().max(64).optional(),
  start_line: z.number().int().positive().optional(),
});
const ModuleGraphBody = z.object({
  path: z.string().min(1).max(4096).optional(),
  exclude: z.string().min(1).max(2000).optional(),
  changed_paths: z.array(z.string().min(1).max(4096)).max(5000).optional(),
});

function worktreeErrorReply(reply: FastifyReply, err: WorktreeError): FastifyReply {
  const status = err.code === 'not_found' ? 404 : err.code === 'invalid_base' ? 422 : 409;
  return reply.code(status).send({ error: err.code, message: err.message });
}

const RunValidationBody = z.object({
  task_id: z.string().min(1).optional(),
  candidate: z.string().min(1).optional(),
  trigger: z.enum(['task', 'queue', 'manual', 'baseline']).optional(),
  selection: z.enum(['full', 'affected']).optional(),
});
const ClaimCompletionBody = z.object({
  claim_text: z.string().min(1).max(8000),
  session_id: z.string().min(1).optional(),
});

function validationErrorReply(reply: FastifyReply, err: ValidationRunError): FastifyReply {
  const status = err.code === 'not_found' ? 404 : 422;
  return reply.code(status).send({ error: err.code, message: err.message });
}

/** Structural shape shared by every adapter's translated event draft. */
interface TranslatedEvent {
  type: string;
  payload: Record<string, unknown>;
  providerSessionId: string;
  agent: AgentInfo | null;
  privacy?: Privacy;
}

/** Resolve sessions, stamp adapter drafts into protocol-v1 envelopes, ingest. */
function ingestDrafts(daemon: Daemon, events: readonly TranslatedEvent[]): { accepted: number; count: number } {
  let accepted = 0;
  for (const event of events) {
    const sessionId = daemon.resolveSession(event.providerSessionId);
    const envelope = draftEvent(daemon.source, {
      type: event.type,
      actor: { user_id: daemon.identity.user_id, agent: event.agent },
      payload: event.payload,
      sessionId,
      providerSessionId: event.providerSessionId,
      ...(event.privacy ? { privacy: event.privacy } : {}),
    });
    if (daemon.ingest(envelope).accepted) accepted++;
  }
  return { accepted, count: events.length };
}

function ingestAdapterEvents(
  daemon: Daemon,
  events: readonly TranslatedEvent[],
  reply: FastifyReply,
): FastifyReply {
  return reply.code(202).send(ingestDrafts(daemon, events));
}

const FILE_EDIT_PATH_KEYS = ['file_path', 'notebook_path'];

/** The target path of a file-edit tool.pre, or null for non-file tools (e.g. Bash). */
function preToolUsePath(event: TranslatedEvent): string | null {
  const summary = event.payload.tool_input_summary;
  if (!summary || typeof summary !== 'object') return null;
  const rec = summary as Record<string, unknown>;
  for (const key of FILE_EDIT_PATH_KEYS) {
    const value = rec[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

/**
 * PreToolUse hard-lock enforcement. On a file-edit tool.pre, consult the team
 * enforcement projection: a 'blocked' hard reservation denies the tool ONLY when
 * the adapter manifest declares hardBlock (Claude Code). Fail-open adapters
 * (Codex) auto-downgrade the hard block to a labeled soft warning and never deny.
 * Solo mode (no enforcement cache) and non-file tools pass through unchanged. The
 * attempt is always ingested for observability, annotated with reservation_check.
 */
function ingestWithEnforcement(
  daemon: Daemon,
  events: readonly TranslatedEvent[],
  manifest: CapabilityManifest,
  reply: FastifyReply,
): FastifyReply {
  const pre = events.find((e) => e.type === 'tool.pre');
  const path = pre ? preToolUsePath(pre) : null;
  if (!pre || !path || !daemon.enforcement) return ingestAdapterEvents(daemon, events, reply);

  const sessionId = daemon.resolveSession(pre.providerSessionId);
  const taskId = daemon.store.getSession(sessionId)?.task_id ?? undefined;
  let check = daemon.enforcement.checkReservation(path, taskId);
  if (check === 'blocked' && !manifest.enforcement.hardBlock) {
    // Fail-open adapter: downgrade the hard block to a soft warning, labeled.
    check = 'warn';
    pre.payload.reservation_downgraded = true;
  }
  pre.payload.reservation_check = check;
  if (check === 'blocked' && manifest.enforcement.hardBlock) {
    ingestDrafts(daemon, events); // record the blocked attempt before denying
    return reply
      .code(200)
      .send(denyPreToolUse(`File '${path}' is hard-reserved by another task; edit blocked by Weft team coordination.`));
  }
  return ingestAdapterEvents(daemon, events, reply);
}

export interface ApiServer {
  app: FastifyInstance;
  listen(): Promise<string>;
  close(): Promise<void>;
}

export interface ApiServerOptions {
  /** Invoked after an authenticated POST /v1/shutdown is acknowledged. */
  onShutdown?: () => void;
}

/**
 * Loopback-only local API. Ingest and mutations require the per-machine hook
 * secret; reads/SSE are loopback-bound and carry no CORS headers, so a
 * cross-origin browser cannot read them. The UI bootstraps the secret once.
 */
export function createApiServer(daemon: Daemon, options: ApiServerOptions = {}): ApiServer {
  const app = Fastify({ logger: false, bodyLimit: 1_048_576 });
  const secret = daemon.identity.hook_secret;
  const adapterContext = {
    deviceId: daemon.identity.device_id,
    projectId: daemon.identity.project_id,
    userId: daemon.identity.user_id,
  };
  // OpenCode tool name/input/result are split across SSE frames correlated by
  // tool-call id, so one stateful translator serves the whole daemon.
  const opencodeTranslator = new OpenCodeTranslator(adapterContext);

  app.addHook('preHandler', async (req, reply) => {
    const path = req.url.split('?')[0] ?? '';
    if (!path.startsWith('/v1/') || path === '/v1/bootstrap') return;
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!safeEqual(token, secret)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
  });

  app.get('/healthz', async () => ({
    ok: true,
    version: PROTOCOL_VERSION,
    mode: daemon.config.mode,
    device_id: daemon.identity.device_id,
    project_id: daemon.identity.project_id,
    events: daemon.store.countEvents(),
    pending: daemon.pipeline.pending,
  }));

  app.get('/v1/bootstrap', async () => ({
    device_id: daemon.identity.device_id,
    project_id: daemon.identity.project_id,
    user_id: daemon.identity.user_id,
    hook_secret: secret,
    mode: daemon.config.mode,
    protocol_version: PROTOCOL_VERSION,
  }));

  // Graceful shutdown trigger (cross-platform; signals are unreliable on Windows).
  app.post('/v1/shutdown', async (_req, reply) => {
    setImmediate(() => options.onShutdown?.());
    return reply.code(202).send({ ok: true });
  });

  // Direct protocol-v1 ingest (synthetic adapters, generic agents, bench).
  app.post('/v1/events', async (req, reply) => {
    const result = daemon.ingest(req.body);
    if (!result.accepted) return reply.code(422).send({ error: 'rejected', message: result.error });
    return reply.code(202).send({ accepted: true, event_id: result.event_id });
  });

  // Claude Code native hooks → translated protocol-v1 events.
  app.post('/v1/hooks/claude', async (req, reply) => {
    let events;
    try {
      events = translateHook(req.body, adapterContext);
    } catch (err) {
      if (err instanceof AdapterError)
        return reply.code(422).send({ error: err.code, message: err.message });
      throw err;
    }
    return ingestWithEnforcement(daemon, events, CLAUDE_MANIFEST, reply);
  });

  // Codex Hooks framework (hooks.json / [hooks] in config.toml) → protocol-v1.
  app.post('/v1/hooks/codex', async (req, reply) => {
    let events;
    try {
      events = translateCodexHook(req.body, adapterContext);
    } catch (err) {
      if (err instanceof CodexAdapterError)
        return reply.code(422).send({ error: err.code, message: err.message });
      throw err;
    }
    return ingestWithEnforcement(daemon, events, CODEX_MANIFEST, reply);
  });

  // Codex legacy notify program hook (agent-turn-complete) → low-fidelity events.
  app.post('/v1/notify/codex', async (req, reply) => {
    let events;
    try {
      events = translateCodexNotify(req.body, adapterContext);
    } catch (err) {
      if (err instanceof CodexAdapterError)
        return reply.code(422).send({ error: err.code, message: err.message });
      throw err;
    }
    return ingestAdapterEvents(daemon, events, reply);
  });

  // OpenCode durable session-event stream (SSE frames bridged via POST). Observe-
  // only: no PreToolUse enforcement. Accepts a single frame or a batch of frames.
  app.post('/v1/opencode/event', async (req, reply) => {
    const frames = Array.isArray(req.body) ? req.body : [req.body];
    const events: TranslatedEvent[] = [];
    try {
      for (const frame of frames) events.push(...opencodeTranslator.translate(frame));
    } catch (err) {
      if (err instanceof OpenCodeAdapterError)
        return reply.code(422).send({ error: err.code, message: err.message });
      throw err;
    }
    return ingestAdapterEvents(daemon, events, reply);
  });

  app.get('/v1/events', async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const events = daemon.store.getEvents({
      ...(q.after ? { afterRowId: Number(q.after) } : {}),
      ...(q.session_id ? { sessionId: q.session_id } : {}),
      ...(q.project_id ? { projectId: q.project_id } : {}),
      limit: q.limit ? Math.min(Number(q.limit), 1000) : 200,
    });
    return { events, cursor: daemon.store.maxRowId() };
  });

  app.get('/v1/sessions', async () => ({ sessions: daemon.store.getSessions() }));
  app.get('/v1/sessions/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = daemon.store.getSession(id);
    if (!session) return reply.code(404).send({ error: 'not_found' });
    return { session };
  });

  // Team-mode enforcement projection (null in solo mode).
  app.get('/v1/enforcement', async (_req, reply) => {
    if (!daemon.enforcement) return reply.code(404).send({ error: 'not_team_mode' });
    return {
      ...daemon.enforcement.snapshot(),
      connected: daemon.coordination?.isConnected() ?? false,
      outbox_pending: daemon.shipper?.pending ?? 0,
    };
  });

  app.post('/v1/enforcement/check', async (req, reply) => {
    if (!daemon.enforcement) return reply.code(404).send({ error: 'not_team_mode' });
    const parsed = ReservationCheckBody.safeParse(req.body);
    if (!parsed.success)
      return reply.code(400).send({ error: 'validation', message: parsed.error.message });
    const result = daemon.enforcement.checkReservation(parsed.data.path, parsed.data.task_id);
    return { result, stale: daemon.enforcement.isStale() };
  });

  // MCP coordination surface (M3.5). The `weft mcp` stdio process is a thin HTTP
  // client of these endpoints; the daemon owns coordination + server RPC. Context
  // is the deterministic ≤2KB block (full ranked facts included here for the UI).
  app.get('/v1/context', async (req, reply) => {
    const q = ContextQuery.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'validation', message: q.error.message });
    try {
      return await daemon.mcp.getConcurrentChanges(q.data.task_id, {
        ...(q.data.budget_bytes != null ? { budgetBytes: q.data.budget_bytes } : {}),
      });
    } catch (err) {
      return mcpErrorReply(reply, err);
    }
  });

  app.get('/v1/mcp/task/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return await daemon.mcp.getTask(id);
    } catch (err) {
      return mcpErrorReply(reply, err);
    }
  });

  app.post('/v1/mcp/claim', async (req, reply) => {
    const b = McpClaimBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'validation', message: b.error.message });
    try {
      return await daemon.mcp.claimTask(b.data.task_id, {
        ...(b.data.base_version != null ? { baseVersion: b.data.base_version } : {}),
        ...(b.data.provisional != null ? { provisional: b.data.provisional } : {}),
      });
    } catch (err) {
      return mcpErrorReply(reply, err);
    }
  });

  app.post('/v1/mcp/progress', async (req, reply) => {
    const b = McpProgressBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'validation', message: b.error.message });
    try {
      return await daemon.mcp.reportProgress(b.data.task_id, b.data.note, {
        ...(b.data.percent != null ? { percent: b.data.percent } : {}),
      });
    } catch (err) {
      return mcpErrorReply(reply, err);
    }
  });

  app.post('/v1/mcp/reserve', async (req, reply) => {
    const b = McpReserveBody.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: 'validation', message: b.error.message });
    try {
      return await daemon.mcp.reserveFiles({
        repo_id: b.data.repo_id,
        task_id: b.data.task_id,
        path_glob: b.data.path_glob,
        ...(b.data.mode != null ? { mode: b.data.mode } : {}),
        ...(b.data.ttl_ms != null ? { ttl_ms: b.data.ttl_ms } : {}),
        ...(b.data.session_id != null ? { session_id: b.data.session_id } : {}),
      });
    } catch (err) {
      return mcpErrorReply(reply, err);
    }
  });

  // Live coordination events for the MCP push channel (Claude channels). Team
  // mode only emits; solo subscribers idle. Loopback + hook-secret gated.
  app.get('/v1/coordination/stream', async (req, reply) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    reply.raw.write('retry: 2000\n\n');
    const unsubscribe = daemon.subscribeCoordination((event) => {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    });
    const heartbeat = setInterval(() => reply.raw.write(': hb\n\n'), HEARTBEAT_MS);
    const cleanup = (): void => {
      clearInterval(heartbeat);
      unsubscribe();
    };
    req.raw.on('close', cleanup);
    reply.raw.on('error', cleanup);
    return reply;
  });

  // Team-mode authoritative task projection (null in solo mode). The server is
  // the source of truth; these read the daemon's folded coordination cache.
  app.get('/v1/team/tasks', async (_req, reply) => {
    if (!daemon.taskCache) return reply.code(404).send({ error: 'not_team_mode' });
    return { ...daemon.taskCache.snapshot(), connected: daemon.coordination?.isConnected() ?? false };
  });

  app.get('/v1/team/tasks/:id', async (req, reply) => {
    if (!daemon.taskCache) return reply.code(404).send({ error: 'not_team_mode' });
    const { id } = req.params as { id: string };
    const task = daemon.taskCache.getTask(id);
    if (!task) return reply.code(404).send({ error: 'not_found' });
    return { task, stale: daemon.taskCache.isStale() };
  });

  app.get('/v1/team/claim-rejections', async (_req, reply) => {
    if (!daemon.taskCache) return reply.code(404).send({ error: 'not_team_mode' });
    return { rejections: daemon.taskCache.snapshot().claimRejections };
  });

  app.post('/v1/team/claim-rejections/:id/ack', async (req, reply) => {
    if (!daemon.taskCache) return reply.code(404).send({ error: 'not_team_mode' });
    const { id } = req.params as { id: string };
    daemon.taskCache.clearClaimRejection(id);
    return { ok: true };
  });

  // SSE activity stream with Last-Event-ID resume + catch-up + heartbeat.
  app.get('/v1/stream', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const lastHeader = req.headers['last-event-id'];
    const cursor = Number(lastHeader ?? q.after ?? 0) || 0;

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    reply.raw.write('retry: 2000\n\n');

    let lastSent = cursor;
    const drain = (): void => {
      const fresh = daemon.store.getEvents({ afterRowId: lastSent, limit: CATCH_UP_LIMIT });
      for (const event of fresh) {
        writeEvent(reply, event);
        if (event.rowid !== undefined) lastSent = event.rowid;
      }
    };
    drain();

    const unsubscribe = daemon.subscribeFlush(() => drain());
    const heartbeat = setInterval(() => reply.raw.write(': hb\n\n'), HEARTBEAT_MS);
    const cleanup = (): void => {
      clearInterval(heartbeat);
      unsubscribe();
    };
    req.raw.on('close', cleanup);
    reply.raw.on('error', cleanup);
    return reply;
  });

  app.get('/v1/tasks', async (req) => {
    const q = req.query as Record<string, string | undefined>;
    const state = q.state ? TaskStateSchema.parse(q.state) : undefined;
    return {
      tasks: daemon.tasks.listTasks(daemon.identity.project_id, {
        ...(state ? { state } : {}),
        limit: q.limit ? Math.min(Number(q.limit), 1000) : 200,
      }),
    };
  });

  app.post('/v1/tasks', async (req, reply) => {
    try {
      const task = daemon.tasks.create(req.body as Parameters<typeof daemon.tasks.create>[0]);
      return reply.code(201).send({ task });
    } catch (err) {
      if (err instanceof TaskError) return taskErrorReply(reply, err);
      throw err;
    }
  });

  app.get('/v1/tasks/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const task = daemon.tasks.getTask(id);
    if (!task) return reply.code(404).send({ error: 'not_found' });
    return { task };
  });

  app.patch('/v1/tasks/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = PatchTaskBody.safeParse(req.body);
    if (!parsed.success)
      return reply.code(400).send({ error: 'validation', message: parsed.error.message });
    try {
      const task = daemon.tasks.update(id, parsed.data.version, parsed.data.fields);
      return { task };
    } catch (err) {
      if (err instanceof TaskError) return taskErrorReply(reply, err);
      throw err;
    }
  });

  app.post('/v1/tasks/:id/transition', async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = TransitionBody.safeParse(req.body);
    if (!parsed.success)
      return reply.code(400).send({ error: 'validation', message: parsed.error.message });
    try {
      const task = daemon.tasks.transition(
        id,
        parsed.data.version,
        parsed.data.to,
        parsed.data.reason,
      );
      return { task };
    } catch (err) {
      if (err instanceof TaskError) return taskErrorReply(reply, err);
      throw err;
    }
  });

  // Completion is a claim, not a fact: records evidence_state='unverified' and
  // never transitions to COMPLETED. The transition guard requires passing evidence.
  app.post('/v1/tasks/:id/claim-completion', async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = ClaimCompletionBody.safeParse(req.body);
    if (!parsed.success)
      return reply.code(400).send({ error: 'validation', message: parsed.error.message });
    try {
      const claim = daemon.tasks.claimCompletion(id, parsed.data.claim_text, parsed.data.session_id);
      return reply.code(201).send({ claim });
    } catch (err) {
      if (err instanceof TaskError) return taskErrorReply(reply, err);
      throw err;
    }
  });

  app.get('/v1/tasks/:id/claims', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!daemon.tasks.getTask(id)) return reply.code(404).send({ error: 'not_found' });
    return { claims: daemon.tasks.listClaims(id) };
  });

  // Repository registration + watcher control (M1.6).
  app.post('/v1/repos', async (req, reply) => {
    const parsed = RegisterRepoBody.safeParse(req.body);
    if (!parsed.success)
      return reply.code(400).send({ error: 'validation', message: parsed.error.message });
    try {
      const repo = await daemon.registerRepo(parsed.data.path);
      return reply.code(201).send({ repo });
    } catch (err) {
      if (err instanceof RepoError) return repoErrorReply(reply, err);
      throw err;
    }
  });

  app.get('/v1/repos', async (req) => {
    const q = req.query as Record<string, string | undefined>;
    return {
      repos: daemon.repos.list({
        ...(q.state ? { state: q.state } : { state: 'active' }),
        ...(q.project_id ? { projectId: q.project_id } : {}),
      }),
      backend: daemon.watcher.backendName,
    };
  });

  app.get('/v1/repos/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const repo = daemon.repos.get(id);
    if (!repo) return reply.code(404).send({ error: 'not_found' });
    return { repo, files: daemon.repos.getFileState(id) };
  });

  app.post('/v1/repos/:id/scan', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const result = await daemon.watcher.reconcile(id);
      return result;
    } catch (err) {
      if (err instanceof RepoError) return repoErrorReply(reply, err);
      throw err;
    }
  });

  app.post('/v1/repos/:id/wip', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const wip = await daemon.watcher.snapshotWip(id);
      return { wip };
    } catch (err) {
      if (err instanceof RepoError) return repoErrorReply(reply, err);
      throw err;
    }
  });

  app.delete('/v1/repos/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!daemon.repos.get(id)) return reply.code(404).send({ error: 'not_found' });
    await daemon.watcher.unwatch(id);
    daemon.repos.archive(id);
    return { ok: true };
  });

  // Claim-gated worktree provisioning + lifecycle (M2.8).
  app.post('/v1/repos/:id/worktrees', async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = ProvisionWorktreeBody.safeParse(req.body);
    if (!parsed.success)
      return reply.code(400).send({ error: 'validation', message: parsed.error.message });
    try {
      const worktree = await daemon.worktrees.provision(
        id,
        {
          taskId: parsed.data.task_id,
          confirmed: parsed.data.confirmed,
          provisional: parsed.data.provisional,
        },
        {
          ...(parsed.data.base_ref ? { baseRef: parsed.data.base_ref } : {}),
          ...(parsed.data.owner_pid !== undefined ? { ownerPid: parsed.data.owner_pid } : {}),
        },
      );
      return reply.code(201).send({ worktree });
    } catch (err) {
      if (err instanceof WorktreeError) return worktreeErrorReply(reply, err);
      throw err;
    }
  });

  app.get('/v1/repos/:id/worktrees', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!daemon.repos.get(id)) return reply.code(404).send({ error: 'not_found' });
    return { worktrees: daemon.worktrees.list({ repoId: id }) };
  });

  app.post('/v1/repos/:id/worktrees/recover', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return await daemon.worktrees.recoverStale(id);
    } catch (err) {
      if (err instanceof WorktreeError) return worktreeErrorReply(reply, err);
      throw err;
    }
  });

  app.get('/v1/worktrees/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const worktree = daemon.worktrees.get(id);
    if (!worktree) return reply.code(404).send({ error: 'not_found' });
    return { worktree };
  });

  app.post('/v1/worktrees/:id/wip', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const wip = await daemon.worktrees.snapshotWip(id);
      return { wip };
    } catch (err) {
      if (err instanceof WorktreeError) return worktreeErrorReply(reply, err);
      throw err;
    }
  });

  app.post('/v1/worktrees/:id/assign', async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = AssignAgentBody.safeParse(req.body);
    if (!parsed.success)
      return reply.code(400).send({ error: 'validation', message: parsed.error.message });
    try {
      const worktree = await daemon.worktrees.assignAgent(id, parsed.data.pid);
      return { worktree };
    } catch (err) {
      if (err instanceof WorktreeError) return worktreeErrorReply(reply, err);
      throw err;
    }
  });

  app.delete('/v1/worktrees/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return await daemon.worktrees.remove(id);
    } catch (err) {
      if (err instanceof WorktreeError) return worktreeErrorReply(reply, err);
      throw err;
    }
  });

  // Local conflict detection (M2.9): textual merge-tree gate + pairwise overlap.
  app.post('/v1/repos/:id/conflicts/detect', async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = DetectConflictsBody.safeParse(req.body);
    if (!parsed.success)
      return reply.code(400).send({ error: 'validation', message: parsed.error.message });
    try {
      const result = await daemon.conflicts.detect(
        id,
        parsed.data.tasks.map((t) => ({ taskId: t.task_id, branch: t.branch })),
        {
          ...(parsed.data.base_ref ? { baseRef: parsed.data.base_ref } : {}),
          ...(parsed.data.epoch !== undefined ? { epoch: parsed.data.epoch } : {}),
        },
      );
      return reply.send(result);
    } catch (err) {
      if (err instanceof ConflictDetectorError)
        return reply.code(404).send({ error: err.code, message: err.message });
      throw err;
    }
  });

  // Symbol index (M3.1): branch-scoped, incremental. Full sweep is idempotent —
  // unchanged files are skipped by content hash; the watcher keeps it fresh.
  app.post('/v1/repos/:id/index', async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = IndexRepoBody.safeParse(req.body ?? {});
    if (!parsed.success)
      return reply.code(400).send({ error: 'validation', message: parsed.error.message });
    try {
      const result = await daemon.indexer.indexRepo(id, {
        ...(parsed.data.branch ? { branch: parsed.data.branch } : {}),
        ...(parsed.data.from_ref !== undefined ? { fromRef: parsed.data.from_ref } : {}),
      });
      return reply.send(result);
    } catch (err) {
      if (err instanceof IndexerError)
        return reply.code(404).send({ error: err.code, message: err.message });
      throw err;
    }
  });

  app.get('/v1/repos/:id/symbols', async (req, reply) => {
    const { id } = req.params as { id: string };
    const repo = daemon.repos.get(id);
    if (!repo) return reply.code(404).send({ error: 'not_found' });
    const q = req.query as Record<string, string | undefined>;
    const branch = q.branch ?? repo.default_branch ?? 'HEAD';
    const symbols = daemon.store.getSymbols(id, branch, q.path);
    const includeEdges = q.edges === 'true' || q.edges === '1';
    return {
      repo_id: id,
      branch,
      count: symbols.length,
      symbols,
      ...(includeEdges
        ? { edges: daemon.store.getSymbolEdges(id, branch, q.path ? { filePath: q.path } : {}) }
        : {}),
    };
  });

  // Symbol overlap (M3.2): L1/L2 semantic warnings across task branches. Reads the
  // branch-scoped index (auto-indexing missing branches), intersects modified-symbol
  // sets, and surfaces signature-change call sites. Incremental + deduped server-side.
  app.post('/v1/repos/:id/overlaps', async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = DetectConflictsBody.safeParse(req.body);
    if (!parsed.success)
      return reply.code(400).send({ error: 'validation', message: parsed.error.message });
    try {
      const result = await daemon.overlap.sweep(
        id,
        parsed.data.tasks.map((t) => ({ taskId: t.task_id, branch: t.branch })),
        {
          ...(parsed.data.base_ref ? { baseRef: parsed.data.base_ref } : {}),
          ...(parsed.data.epoch !== undefined ? { epoch: parsed.data.epoch } : {}),
        },
      );
      return reply.send(result);
    } catch (err) {
      if (err instanceof OverlapError)
        return reply.code(404).send({ error: err.code, message: err.message });
      throw err;
    }
  });

  // Exact reference resolution (M3.3, L2): TS Compiler API findReferences in a
  // separate, memory-budgeted resolver process. On-demand — never in the overlap
  // hot path. Returns precise, type-based call sites (vs the name-based fast tier).
  app.post('/v1/repos/:id/references', async (req, reply) => {
    const { id } = req.params as { id: string };
    const repo = daemon.repos.get(id);
    if (!repo) return reply.code(404).send({ error: 'not_found' });
    const parsed = ReferencesBody.safeParse(req.body);
    if (!parsed.success)
      return reply.code(400).send({ error: 'validation', message: parsed.error.message });
    try {
      const result = await daemon.resolver.resolve(repo.root_path, {
        filePath: parsed.data.file_path,
        name: parsed.data.name,
        ...(parsed.data.container ? { container: parsed.data.container } : {}),
        ...(parsed.data.kind ? { kind: parsed.data.kind } : {}),
        ...(parsed.data.start_line !== undefined ? { startLine: parsed.data.start_line } : {}),
      });
      return reply.send({ repo_id: id, ...result });
    } catch (err) {
      if (err instanceof ResolverError) {
        const status = err.code === 'disabled' ? 503 : err.code === 'timeout' ? 504 : 500;
        return reply.code(status).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  // Module graph (M3.6): dependency-cruiser import graph projected to local source
  // modules. With changed_paths, returns the transitive reverse-dependency closure
  // (coarse module-level impact tier); otherwise the full graph. On-demand, read-only.
  app.post('/v1/repos/:id/module-graph', async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = ModuleGraphBody.safeParse(req.body ?? {});
    if (!parsed.success)
      return reply.code(400).send({ error: 'validation', message: parsed.error.message });
    try {
      const graph = await daemon.moduleGraph.build(id, {
        ...(parsed.data.path ? { path: parsed.data.path } : {}),
        ...(parsed.data.exclude ? { exclude: parsed.data.exclude } : {}),
      });
      if (parsed.data.changed_paths) {
        return reply.send({
          repo_id: id,
          changed_paths: parsed.data.changed_paths,
          impacted: dependentsOf(graph, parsed.data.changed_paths),
          modules: graph.modules.length,
          edges: graph.edges,
          duration_ms: graph.duration_ms,
        });
      }
      return reply.send(graph);
    } catch (err) {
      if (err instanceof ModuleGraphError) {
        const status = err.code === 'not_found' ? 404 : 500;
        return reply.code(status).send({ error: err.code, message: err.message });
      }
      throw err;
    }
  });

  // Validation supervisor (M2.10): run configured checks in a detached worktree
  // at the candidate tree; produces evidence, never completes a task.
  app.post('/v1/repos/:id/validation/run', async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = RunValidationBody.safeParse(req.body ?? {});
    if (!parsed.success)
      return reply.code(400).send({ error: 'validation', message: parsed.error.message });
    try {
      const run = await daemon.validation.run(id, {
        ...(parsed.data.task_id ? { taskId: parsed.data.task_id } : {}),
        ...(parsed.data.candidate ? { candidate: parsed.data.candidate } : {}),
        ...(parsed.data.trigger ? { trigger: parsed.data.trigger } : {}),
        ...(parsed.data.selection ? { selection: parsed.data.selection } : {}),
      });
      return reply.code(201).send({ run });
    } catch (err) {
      if (err instanceof ValidationRunError) return validationErrorReply(reply, err);
      throw err;
    }
  });

  app.get('/v1/validation/runs', async (req) => {
    const q = req.query as Record<string, string | undefined>;
    return {
      runs: daemon.validation.listRuns({
        ...(q.repo_id ? { repoId: q.repo_id } : {}),
        ...(q.task_id ? { taskId: q.task_id } : {}),
        limit: q.limit ? Math.min(Number(q.limit), 1000) : 200,
      }),
    };
  });

  app.get('/v1/validation/runs/:runId', async (req, reply) => {
    const { runId } = req.params as { runId: string };
    const run = daemon.validation.getRun(runId);
    if (!run) return reply.code(404).send({ error: 'not_found' });
    return { run };
  });

  // --- M4: test impact analysis, contract gates, attribution, merge queue ---
  const AffectedTestsBody = z.object({
    changed_paths: z.array(z.string().min(1)).min(1),
    path: z.string().min(1).optional(),
    exclude: z.string().min(1).optional(),
  });
  app.post('/v1/repos/:id/affected-tests', async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = AffectedTestsBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'validation', message: parsed.error.message });
    try {
      const tests = await daemon.tia.affectedTests(id, parsed.data.changed_paths, {
        ...(parsed.data.path ? { path: parsed.data.path } : {}),
        ...(parsed.data.exclude ? { exclude: parsed.data.exclude } : {}),
      });
      return reply.send({ repo_id: id, changed_paths: parsed.data.changed_paths, affected_tests: tests });
    } catch (err) {
      if (err instanceof ModuleGraphError)
        return reply.code(err.code === 'not_found' ? 404 : 500).send({ error: err.code, message: err.message });
      throw err;
    }
  });

  const ContractGatesBody = z.object({
    gates: z.array(z.object({
      gate_id: z.string().min(1),
      tool: z.enum(['oasdiff', 'buf', 'squawk', 'prisma', 'custom']),
      command: z.string().min(1),
      args: z.array(z.string()).optional(),
      blocking: z.boolean().optional(),
      timeoutMs: z.number().int().positive().optional(),
    })).min(1),
  });
  app.post('/v1/repos/:id/contract-gates', async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = ContractGatesBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'validation', message: parsed.error.message });
    const repo = daemon.repos.get(id);
    if (!repo) return reply.code(404).send({ error: 'not_found', message: `repo ${id} not found` });
    const gates: ContractGateConfig[] = parsed.data.gates.map((gate) => ({
      gate_id: gate.gate_id,
      tool: gate.tool,
      command: gate.command,
      ...(gate.args ? { args: gate.args } : {}),
      ...(gate.blocking !== undefined ? { blocking: gate.blocking } : {}),
      ...(gate.timeoutMs !== undefined ? { timeoutMs: gate.timeoutMs } : {}),
    }));
    const results = await daemon.contractGates.run(gates, repo.root_path);
    return reply.send({ repo_id: id, results, ...evaluateContractGates(results) });
  });

  const AttributeBody = z.object({
    baseline_oid: z.string().min(1),
    head: z.string().min(1).optional(),
    failing_checks: z.array(z.object({ check_id: z.string().min(1), paths: z.array(z.string()) })).min(1),
  });
  app.post('/v1/repos/:id/attribution', async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = AttributeBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'validation', message: parsed.error.message });
    try {
      const suspects = await daemon.attribution.attribute(id, {
        baselineOid: parsed.data.baseline_oid,
        ...(parsed.data.head ? { head: parsed.data.head } : {}),
        failingChecks: parsed.data.failing_checks,
      });
      return reply.send({ repo_id: id, suspects });
    } catch (err) {
      if (err instanceof AttributionError)
        return reply.code(err.code === 'not_found' ? 404 : 500).send({ error: err.code, message: err.message });
      throw err;
    }
  });

  const RevertTestBody = z.object({
    suspect_oid: z.string().min(1),
    head: z.string().min(1).optional(),
  });
  app.post('/v1/repos/:id/revert-test', async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = RevertTestBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'validation', message: parsed.error.message });
    try {
      const result = await daemon.attribution.revertTest(id, parsed.data.suspect_oid, parsed.data.head);
      return reply.send({ repo_id: id, ...result });
    } catch (err) {
      if (err instanceof AttributionError)
        return reply.code(err.code === 'not_found' ? 404 : 500).send({ error: err.code, message: err.message });
      throw err;
    }
  });

  app.post('/v1/repos/:id/merge/tick', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!daemon.mergeExecutor)
      return reply.code(409).send({ error: 'solo_mode', message: 'merge executor requires team mode' });
    try {
      return reply.send(await daemon.mergeExecutor.tick(id));
    } catch (err) {
      if (err instanceof MergeExecutorError)
        return reply.code(err.code === 'not_found' ? 404 : 500).send({ error: err.code, message: err.message });
      if (err instanceof CoordinationRpcError)
        return reply.code(err.status).send({ error: err.code, message: err.message });
      throw err;
    }
  });

  const EnqueueMergeBody = z.object({
    task_id: z.string().min(1),
    branch: z.string().min(1),
    candidate_oid: z.string().min(1).optional(),
    target_branch: z.string().min(1).optional(),
    claimant_device_id: z.string().min(1).optional(),
  });
  app.post('/v1/repos/:id/merge/enqueue', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!daemon.rpc) return reply.code(409).send({ error: 'solo_mode', message: 'merge queue requires team mode' });
    const parsed = EnqueueMergeBody.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'validation', message: parsed.error.message });
    try {
      const entry = await daemon.rpc.enqueue({
        repo_id: id,
        task_id: parsed.data.task_id,
        branch: parsed.data.branch,
        ...(parsed.data.candidate_oid ? { candidate_oid: parsed.data.candidate_oid } : {}),
        ...(parsed.data.target_branch ? { target_branch: parsed.data.target_branch } : {}),
        ...(parsed.data.claimant_device_id ? { claimant_device_id: parsed.data.claimant_device_id } : {}),
      });
      return reply.code(201).send({ entry });
    } catch (err) {
      if (err instanceof CoordinationRpcError)
        return reply.code(err.status).send({ error: err.code, message: err.message });
      throw err;
    }
  });

  app.get('/v1/repos/:id/merge/entries', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!daemon.rpc) return reply.code(409).send({ error: 'solo_mode', message: 'merge queue requires team mode' });
    const q = req.query as { state?: string };
    try {
      const entries = await daemon.rpc.listEntries({ repoId: id, ...(q.state ? { state: q.state } : {}) });
      return reply.send({ entries });
    } catch (err) {
      if (err instanceof CoordinationRpcError)
        return reply.code(err.status).send({ error: err.code, message: err.message });
      throw err;
    }
  });

  return {
    app,
    async listen() {
      return app.listen({ host: daemon.config.hooks.host, port: daemon.config.hooks.port });
    },
    async close() {
      await app.close();
    },
  };
}
