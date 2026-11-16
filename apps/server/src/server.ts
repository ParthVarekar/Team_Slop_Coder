import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import { z } from 'zod';
import {
  PROTOCOL_VERSION,
  makeId,
  TaskStateSchema,
  ConflictStateSchema,
  ConflictSeveritySchema,
  ConflictKindSchema,
} from '@weft/protocol';
import { createLogger, type Logger } from '@weft/core';
import { openCentralDatabase, type CentralDatabase } from './db.js';
import { IngestService, MAX_INGEST_BATCH } from './ingest.js';
import {
  AuthService,
  AuthError,
  actorOf,
  hasScope,
  ROLES,
  type AuthContext,
  type Scope,
} from './auth.js';
import { readAudit } from './audit.js';
import { StreamHub, streamEvents, mapStoredEvent, type Channel } from './stream.js';
import { poolExecutor } from './pg.js';
import {
  TaskService,
  TaskError,
  CreateTaskSchema,
  TaskFieldsSchema,
  ClaimSchema,
  type Origin,
} from './tasks-service.js';
import {
  ConflictService,
  ConflictError,
  DetectConflictSchema,
} from './conflicts-service.js';
import { ValidationService } from './validation-service.js';
import {
  NotificationService,
  NotificationError,
  NotificationStateSchema,
} from './notifications-service.js';
import type { ServerConfig } from './config.js';

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthContext;
  }
}

const SERVER_VERSION = '0.0.0';
const IngestBody = z.object({ events: z.array(z.unknown()).max(MAX_INGEST_BATCH) });
const IssueTokenBody = z.object({
  projectId: z.string().min(1),
  userId: z.string().min(1).optional(),
  deviceId: z.string().min(1).optional(),
  role: z.enum(ROLES),
  name: z.string().max(200).optional(),
  expiresInDays: z.number().int().min(1).max(3650).optional(),
});
const MemberBody = z.object({
  projectId: z.string().min(1),
  userId: z.string().min(1),
  role: z.enum(ROLES),
});
const DeviceBody = z.object({
  projectId: z.string().min(1),
  deviceId: z.string().min(1).optional(),
  userId: z.string().min(1).optional(),
  hostname: z.string().max(200).optional(),
  os: z.string().max(100).optional(),
});
const EventsQuery = z.object({
  projectId: z.string().min(1).optional(),
  afterSeq: z.coerce.number().int().nonnegative().default(0),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
});
const CreateTaskBody = CreateTaskSchema.extend({ projectId: z.string().min(1).optional() });
const UpdateTaskBody = z.object({
  projectId: z.string().min(1).optional(),
  baseVersion: z.number().int().nonnegative(),
  fields: TaskFieldsSchema,
});
const TransitionBody = z.object({
  projectId: z.string().min(1).optional(),
  baseVersion: z.number().int().nonnegative(),
  to: TaskStateSchema,
  reason: z.string().max(2000).optional(),
});
const ClaimBody = ClaimSchema.extend({ projectId: z.string().min(1).optional() });
const ReleaseBody = z.object({
  projectId: z.string().min(1).optional(),
  baseVersion: z.number().int().nonnegative(),
});
const ResolveConflictBody = z.object({
  projectId: z.string().min(1).optional(),
  baseVersion: z.number().int().nonnegative(),
  fields: TaskFieldsSchema,
});
const DependencyBody = z.object({
  projectId: z.string().min(1).optional(),
  dependsOn: z.string().min(1),
});
const ReadyBody = z.object({ projectId: z.string().min(1).optional() });
const TasksQuery = z.object({
  projectId: z.string().min(1).optional(),
  state: TaskStateSchema.optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
});
const DetectConflictBody = DetectConflictSchema.extend({ projectId: z.string().min(1).optional() });
const ConflictsQuery = z.object({
  projectId: z.string().min(1).optional(),
  state: ConflictStateSchema.optional(),
  severity: ConflictSeveritySchema.optional(),
  kind: ConflictKindSchema.optional(),
  repoId: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
});
const ConflictDecisionBody = z.object({
  projectId: z.string().min(1).optional(),
  note: z.string().max(2000).optional(),
});
const ClaimCompletionBody = z.object({
  projectId: z.string().min(1).optional(),
  claim_text: z.string().min(1).max(8000),
  session_id: z.string().min(1).optional(),
});
const ValidationRunsQuery = z.object({
  projectId: z.string().min(1).optional(),
  repoId: z.string().min(1).optional(),
  taskId: z.string().min(1).optional(),
  state: z.enum(['running', 'passed', 'failed', 'error']).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
});
const NotificationsQuery = z.object({
  projectId: z.string().min(1).optional(),
  userId: z.string().min(1).optional(),
  state: NotificationStateSchema.optional(),
  kind: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
});
const NotificationStateBody = z.object({
  projectId: z.string().min(1).optional(),
  state: NotificationStateSchema,
});
const MembersQuery = z.object({ projectId: z.string().min(1).optional() });

export interface TeamServer {
  readonly config: ServerConfig;
  readonly logger: Logger;
  readonly db: CentralDatabase;
  readonly app: FastifyInstance;
  listen(): Promise<string>;
  close(): Promise<void>;
}

export interface CreateServerOptions {
  logger?: Logger;
  /**
   * Bootstrap admin secret: a global superuser credential guarding management
   * routes and shutdown. Requests fail closed with 401 when no credential is
   * presented. Project-scoped API tokens (issued via /v1/admin/tokens) are the
   * normal credential for daemons and UI users.
   */
  adminSecret?: string;
  /** Invoked after an authenticated POST /v1/shutdown is acknowledged. */
  onShutdown?: () => void;
}

/**
 * Team-server bootstrap: connect Postgres, apply central migrations, and expose
 * a loopback-bound Fastify app. Single process + Postgres; no external broker.
 * Every /v1 route is authenticated; every data query is project-scoped.
 */
export async function createServer(
  config: ServerConfig,
  options: CreateServerOptions = {},
): Promise<TeamServer> {
  const logger = options.logger ?? createLogger({ level: config.logLevel, name: 'weft-server' });
  const db = await openCentralDatabase(config.databaseUrl, logger);
  const app = Fastify({ logger: false, bodyLimit: 1_048_576 });
  // The browser UI calls this API cross-origin with a Bearer token (no cookies),
  // so CORS is required for both the RPC routes and the SSE stream. Preflight is
  // answered at onRequest, ahead of the auth preHandler hook below.
  await app.register(cors, {
    origin:
      config.corsOrigin === '*'
        ? '*'
        : config.corsOrigin.split(',').map((s) => s.trim()).filter(Boolean),
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['authorization', 'content-type', 'last-event-id'],
    maxAge: 86_400,
  });
  const auth = new AuthService(db.pool, options.adminSecret, logger);
  const serverDeviceId = makeId('device');
  const conflicts = new ConflictService(db.pool, serverDeviceId, logger);
  const validation = new ValidationService(db.pool, logger);
  const notifications = new NotificationService(db.pool, logger);
  const ingest = new IngestService(db.pool, logger, conflicts, validation, notifications);
  const tasks = new TaskService(db.pool, logger);
  const hub = new StreamHub();
  const activeStreams = new Set<() => void>();

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AuthError) return reply.code(err.status).send({ error: err.reason });
    if (err instanceof TaskError) {
      const status =
        err.code === 'not_found'
          ? 404
          : err.code === 'conflict'
            ? 409
            : err.code === 'invalid_transition' || err.code === 'cycle' || err.code === 'evidence_required'
              ? 422
              : 400;
      return reply.code(status).send({ error: err.code, message: err.message });
    }
    if (err instanceof ConflictError) {
      const status = err.code === 'not_found' ? 404 : err.code === 'invalid_transition' ? 422 : 400;
      return reply.code(status).send({ error: err.code, message: err.message });
    }
    if (err instanceof NotificationError) {
      const status = err.code === 'not_found' ? 404 : 400;
      return reply.code(status).send({ error: err.code, message: err.message });
    }
    const e = err as { statusCode?: number; message?: string };
    const status = e.statusCode ?? 500;
    if (status >= 500) {
      logger.error({ err }, 'request failed');
      return reply.code(500).send({ error: 'internal' });
    }
    return reply.code(status).send({ error: 'bad_request', message: e.message ?? 'bad request' });
  });

  app.get('/healthz', async () => {
    let database = 'down';
    try {
      const res = await db.pool.query('SELECT 1 AS ok');
      if (res.rows[0]?.ok === 1) database = 'up';
    } catch {
      /* healthz must report status, never throw */
    }
    return {
      ok: database === 'up',
      role: 'team-server',
      version: PROTOCOL_VERSION,
      server_version: SERVER_VERSION,
      database,
    };
  });

  // Authenticate every /v1 request. Denials with a known project are audited;
  // unknown/absent credentials are not (no project to scope, avoids audit flood).
  app.addHook('preHandler', async (req, reply) => {
    const path = req.url.split('?')[0] ?? '';
    if (!path.startsWith('/v1/')) return;
    const header = req.headers.authorization ?? '';
    const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
    const result = await auth.authenticate(bearer);
    if (!result.ok) {
      if (result.projectId)
        await auth.recordDenial(result.projectId, result.reason, { system: 'weft-server' }, result.tokenId);
      return reply.code(result.status).send({ error: 'unauthorized', reason: result.reason });
    }
    req.auth = result.context;
  });

  /**
   * Scope + project guard. Returns the resolved project (null = bootstrap
   * superuser, must be supplied explicitly by the route) or null after sending
   * a 403. A project token can never address another project's data.
   */
  async function guard(
    req: FastifyRequest,
    reply: FastifyReply,
    scope: Scope,
    requestedProjectId?: string,
  ): Promise<{ ctx: AuthContext; projectId: string | null } | null> {
    const ctx = req.auth;
    if (!ctx) {
      await reply.code(401).send({ error: 'unauthorized' });
      return null;
    }
    if (!hasScope(ctx, scope)) {
      const pid = ctx.projectId ?? requestedProjectId ?? null;
      if (pid) await auth.recordDenial(pid, 'scope', actorOf(ctx), ctx.tokenId ?? undefined);
      await reply.code(403).send({ error: 'forbidden', reason: 'scope', required: scope });
      return null;
    }
    if (ctx.kind === 'token') {
      if (requestedProjectId != null && requestedProjectId !== ctx.projectId) {
        await auth.recordDenial(ctx.projectId as string, 'cross_project', actorOf(ctx), ctx.tokenId ?? undefined);
        await reply.code(403).send({ error: 'forbidden', reason: 'cross_project' });
        return null;
      }
      return { ctx, projectId: ctx.projectId };
    }
    return { ctx, projectId: requestedProjectId ?? null };
  }

  // Cross-platform graceful shutdown (Windows signals are unreliable).
  app.post('/v1/shutdown', async (req, reply) => {
    if (req.auth?.kind !== 'bootstrap')
      return reply.code(403).send({ error: 'forbidden', reason: 'bootstrap_only' });
    setImmediate(() => options.onShutdown?.());
    return reply.code(202).send({ ok: true });
  });

  app.post('/v1/ingest', async (req, reply) => {
    const g = await guard(req, reply, 'ingest');
    if (!g) return;
    const parsed = IngestBody.safeParse(req.body);
    if (!parsed.success)
      return reply.code(400).send({ error: 'validation', message: parsed.error.message });
    // A project token may only write events stamped with its own project_id.
    if (g.projectId != null) {
      for (const raw of parsed.data.events) {
        const pid = (raw as { project_id?: unknown } | null)?.project_id;
        if (typeof pid === 'string' && pid !== g.projectId) {
          await auth.recordDenial(g.projectId, 'cross_project', actorOf(g.ctx), g.ctx.tokenId ?? undefined);
          return reply.code(403).send({ error: 'forbidden', reason: 'cross_project' });
        }
      }
    }
    const result = await ingest.ingestBatch(parsed.data.events);
    // Wake SSE subscribers after the batch is durably committed.
    if (result.accepted.length > 0) hub.notifyMany(Object.keys(result.streams));
    return reply.code(202).send(result);
  });

  app.get('/v1/events', async (req, reply) => {
    const q = EventsQuery.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'validation', message: q.error.message });
    const g = await guard(req, reply, 'read', q.data.projectId);
    if (!g) return;
    const projectId = g.projectId;
    if (!projectId)
      return reply.code(400).send({ error: 'validation', message: 'projectId is required' });
    const stream = await db.pool.query(
      'SELECT last_seq, min_seq FROM project_stream_seq WHERE project_id = $1',
      [projectId],
    );
    const srow = stream.rows[0];
    const lastSeq = srow ? Number(srow.last_seq) : 0;
    const minSeq = srow ? Number(srow.min_seq) : 0;
    const resync = q.data.afterSeq < minSeq;
    const after = resync ? Math.max(0, minSeq - 1) : q.data.afterSeq;
    const rows = await db.pool.query(
      `SELECT event_id, v, device_id, project_id, repo_id, session_id, provider_session_id,
              task_id, seq, global_seq, ts, received_at, type, actor, payload, privacy
         FROM events
        WHERE project_id = $1 AND global_seq > $2
        ORDER BY global_seq ASC LIMIT $3`,
      [projectId, after, q.data.limit],
    );
    return reply.send({
      events: rows.rows.map(mapStoredEvent),
      cursor: { last_seq: lastSeq, min_seq: minSeq },
      resync,
    });
  });

  // SSE fan-out: team stream (all events) and coordination channel (durable
  // task/reservation/conflict/merge for daemon enforcement). Last-Event-ID
  // resumes from a global_seq cursor; below-watermark cursors force a resync.
  const sseRoute = (channel: Channel) => async (req: FastifyRequest, reply: FastifyReply) => {
    const q = req.query as { projectId?: string; after?: string };
    const g = await guard(req, reply, 'read', q.projectId);
    if (!g) return;
    const projectId = g.projectId;
    if (!projectId)
      return reply.code(400).send({ error: 'validation', message: 'projectId is required' });
    const lastHeader = req.headers['last-event-id'];
    const cursor = Number(lastHeader ?? q.after ?? 0) || 0;
    return streamEvents(req, reply, {
      pool: db.pool,
      hub,
      projectId,
      channel,
      cursor,
      logger,
      activeStreams,
    });
  };
  app.get('/v1/stream', sseRoute('team'));
  app.get('/v1/coordination', sseRoute('coordination'));

  // --- Tasks (server-authoritative; mutate scope writes, read scope queries) ---
  // Every mutation folds one event onto the locked snapshot and emits a durable
  // coordination event in the same transaction; the hub is woken only after commit.
  const originOf = (ctx: AuthContext): Origin => ({
    actor: actorOf(ctx),
    deviceId: ctx.deviceId ?? serverDeviceId,
  });

  app.post('/v1/tasks', async (req, reply) => {
    const body = CreateTaskBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'validation', message: body.error.message });
    const g = await guard(req, reply, 'mutate', body.data.projectId);
    if (!g) return;
    if (!g.projectId) return reply.code(400).send({ error: 'validation', message: 'projectId is required' });
    const snapshot = await tasks.create(g.projectId, body.data, originOf(g.ctx));
    hub.notify(g.projectId);
    return reply.code(201).send({ task: snapshot });
  });

  app.get('/v1/tasks', async (req, reply) => {
    const q = TasksQuery.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'validation', message: q.error.message });
    const g = await guard(req, reply, 'read', q.data.projectId);
    if (!g) return;
    if (!g.projectId) return reply.code(400).send({ error: 'validation', message: 'projectId is required' });
    const list = await tasks.list(g.projectId, {
      ...(q.data.state ? { state: q.data.state } : {}),
      limit: q.data.limit,
    });
    return reply.send({ tasks: list });
  });

  app.post('/v1/tasks/ready', async (req, reply) => {
    const body = ReadyBody.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'validation', message: body.error.message });
    const g = await guard(req, reply, 'mutate', body.data.projectId);
    if (!g) return;
    if (!g.projectId) return reply.code(400).send({ error: 'validation', message: 'projectId is required' });
    const promoted = await tasks.computeReady(g.projectId, originOf(g.ctx));
    if (promoted.length > 0) hub.notify(g.projectId);
    return reply.send({ promoted });
  });

  app.get('/v1/tasks/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = req.query as { projectId?: string };
    const g = await guard(req, reply, 'read', q.projectId);
    if (!g) return;
    if (!g.projectId) return reply.code(400).send({ error: 'validation', message: 'projectId is required' });
    const snapshot = await tasks.get(id, g.projectId);
    if (!snapshot) return reply.code(404).send({ error: 'not_found', message: `task ${id} not found` });
    return reply.send({ task: snapshot });
  });

  app.get('/v1/tasks/:id/rebuild', async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = req.query as { projectId?: string };
    const g = await guard(req, reply, 'read', q.projectId);
    if (!g) return;
    if (!g.projectId) return reply.code(400).send({ error: 'validation', message: 'projectId is required' });
    const snapshot = await tasks.rebuildSnapshot(id, g.projectId);
    if (!snapshot) return reply.code(404).send({ error: 'not_found', message: `task ${id} not found` });
    return reply.send({ task: snapshot });
  });

  app.patch('/v1/tasks/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = UpdateTaskBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'validation', message: body.error.message });
    const g = await guard(req, reply, 'mutate', body.data.projectId);
    if (!g) return;
    if (!g.projectId) return reply.code(400).send({ error: 'validation', message: 'projectId is required' });
    const snapshot = await tasks.update(id, g.projectId, body.data.baseVersion, body.data.fields, originOf(g.ctx));
    hub.notify(g.projectId);
    return reply.send({ task: snapshot });
  });

  app.post('/v1/tasks/:id/transition', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = TransitionBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'validation', message: body.error.message });
    const g = await guard(req, reply, 'mutate', body.data.projectId);
    if (!g) return;
    if (!g.projectId) return reply.code(400).send({ error: 'validation', message: 'projectId is required' });
    const snapshot = await tasks.transition(id, g.projectId, body.data.baseVersion, body.data.to, body.data.reason, originOf(g.ctx));
    hub.notify(g.projectId);
    return reply.send({ task: snapshot });
  });

  // Completion is a claim (evidence_state='unverified'), never an auto-COMPLETED
  // state. The transition guard separately requires a passing validation run.
  app.post('/v1/tasks/:id/claim-completion', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = ClaimCompletionBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'validation', message: body.error.message });
    const g = await guard(req, reply, 'mutate', body.data.projectId);
    if (!g) return;
    if (!g.projectId) return reply.code(400).send({ error: 'validation', message: 'projectId is required' });
    const claim = await tasks.claimCompletion(id, g.projectId, body.data.claim_text, originOf(g.ctx), body.data.session_id);
    hub.notify(g.projectId);
    return reply.code(201).send({ claim });
  });

  app.get('/v1/tasks/:id/claims', async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = req.query as { projectId?: string };
    const g = await guard(req, reply, 'read', q.projectId);
    if (!g) return;
    if (!g.projectId) return reply.code(400).send({ error: 'validation', message: 'projectId is required' });
    return reply.send({ claims: await tasks.listClaims(id, g.projectId) });
  });

  app.post('/v1/tasks/:id/claim', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = ClaimBody.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'validation', message: body.error.message });
    const g = await guard(req, reply, 'mutate', body.data.projectId);
    if (!g) return;
    if (!g.projectId) return reply.code(400).send({ error: 'validation', message: 'projectId is required' });
    const result = await tasks.claim(id, g.projectId, body.data, originOf(g.ctx));
    hub.notify(g.projectId);
    return reply.send(result);
  });

  app.post('/v1/tasks/:id/release', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = ReleaseBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'validation', message: body.error.message });
    const g = await guard(req, reply, 'mutate', body.data.projectId);
    if (!g) return;
    if (!g.projectId) return reply.code(400).send({ error: 'validation', message: 'projectId is required' });
    const snapshot = await tasks.release(id, g.projectId, body.data.baseVersion, originOf(g.ctx));
    hub.notify(g.projectId);
    return reply.send({ task: snapshot });
  });

  app.post('/v1/tasks/:id/resolve-conflict', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = ResolveConflictBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'validation', message: body.error.message });
    const g = await guard(req, reply, 'mutate', body.data.projectId);
    if (!g) return;
    if (!g.projectId) return reply.code(400).send({ error: 'validation', message: 'projectId is required' });
    const snapshot = await tasks.resolveEditConflict(id, g.projectId, body.data.baseVersion, body.data.fields, originOf(g.ctx));
    hub.notify(g.projectId);
    return reply.send({ task: snapshot });
  });

  app.get('/v1/tasks/:id/dependencies', async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = req.query as { projectId?: string };
    const g = await guard(req, reply, 'read', q.projectId);
    if (!g) return;
    if (!g.projectId) return reply.code(400).send({ error: 'validation', message: 'projectId is required' });
    return reply.send({ dependsOn: await tasks.listDependencies(id, g.projectId) });
  });

  app.post('/v1/tasks/:id/dependencies', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = DependencyBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'validation', message: body.error.message });
    const g = await guard(req, reply, 'mutate', body.data.projectId);
    if (!g) return;
    if (!g.projectId) return reply.code(400).send({ error: 'validation', message: 'projectId is required' });
    await tasks.addDependency(id, g.projectId, body.data.dependsOn, originOf(g.ctx));
    hub.notify(g.projectId);
    return reply.code(201).send({ ok: true, taskId: id, dependsOn: body.data.dependsOn });
  });

  app.delete('/v1/tasks/:id/dependencies/:dep', async (req, reply) => {
    const { id, dep } = req.params as { id: string; dep: string };
    const q = req.query as { projectId?: string };
    const g = await guard(req, reply, 'mutate', q.projectId);
    if (!g) return;
    if (!g.projectId) return reply.code(400).send({ error: 'validation', message: 'projectId is required' });
    await tasks.removeDependency(id, g.projectId, dep, originOf(g.ctx));
    hub.notify(g.projectId);
    return reply.send({ ok: true });
  });

  // --- Conflicts (server-authoritative cards; detection dedup + epoch reopen) ---
  app.post('/v1/conflicts/detect', async (req, reply) => {
    const body = DetectConflictBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'validation', message: body.error.message });
    const g = await guard(req, reply, 'mutate', body.data.projectId);
    if (!g) return;
    if (!g.projectId) return reply.code(400).send({ error: 'validation', message: 'projectId is required' });
    const card = await conflicts.detect(g.projectId, body.data, originOf(g.ctx));
    hub.notify(g.projectId);
    return reply.code(201).send({ conflict: card });
  });

  app.get('/v1/conflicts', async (req, reply) => {
    const q = ConflictsQuery.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'validation', message: q.error.message });
    const g = await guard(req, reply, 'read', q.data.projectId);
    if (!g) return;
    if (!g.projectId) return reply.code(400).send({ error: 'validation', message: 'projectId is required' });
    const list = await conflicts.list(g.projectId, {
      ...(q.data.state ? { state: q.data.state } : {}),
      ...(q.data.severity ? { severity: q.data.severity } : {}),
      ...(q.data.kind ? { kind: q.data.kind } : {}),
      ...(q.data.repoId ? { repoId: q.data.repoId } : {}),
      limit: q.data.limit,
    });
    return reply.send({ conflicts: list });
  });

  app.get('/v1/conflicts/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = req.query as { projectId?: string };
    const g = await guard(req, reply, 'read', q.projectId);
    if (!g) return;
    if (!g.projectId) return reply.code(400).send({ error: 'validation', message: 'projectId is required' });
    const card = await conflicts.get(id, g.projectId);
    if (!card) return reply.code(404).send({ error: 'not_found', message: `conflict ${id} not found` });
    return reply.send({ conflict: card });
  });

  app.get('/v1/conflicts/:id/history', async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = req.query as { projectId?: string };
    const g = await guard(req, reply, 'read', q.projectId);
    if (!g) return;
    if (!g.projectId) return reply.code(400).send({ error: 'validation', message: 'projectId is required' });
    return reply.send({ history: await conflicts.history(id, g.projectId) });
  });

  app.post('/v1/conflicts/:id/resolve', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = ConflictDecisionBody.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'validation', message: body.error.message });
    const g = await guard(req, reply, 'mutate', body.data.projectId);
    if (!g) return;
    if (!g.projectId) return reply.code(400).send({ error: 'validation', message: 'projectId is required' });
    const card = await conflicts.resolve(id, g.projectId, originOf(g.ctx), body.data.note);
    hub.notify(g.projectId);
    return reply.send({ conflict: card });
  });

  app.post('/v1/conflicts/:id/dismiss', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = ConflictDecisionBody.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'validation', message: body.error.message });
    const g = await guard(req, reply, 'mutate', body.data.projectId);
    if (!g) return;
    if (!g.projectId) return reply.code(400).send({ error: 'validation', message: 'projectId is required' });
    const card = await conflicts.dismiss(id, g.projectId, originOf(g.ctx), body.data.note);
    hub.notify(g.projectId);
    return reply.send({ conflict: card });
  });

  // --- Validation evidence (project-scoped reads; the server never runs checks) ---
  app.get('/v1/validation/runs', async (req, reply) => {
    const q = ValidationRunsQuery.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'validation', message: q.error.message });
    const g = await guard(req, reply, 'read', q.data.projectId);
    if (!g) return;
    if (!g.projectId) return reply.code(400).send({ error: 'validation', message: 'projectId is required' });
    const runs = await validation.listRuns(g.projectId, {
      ...(q.data.repoId ? { repoId: q.data.repoId } : {}),
      ...(q.data.taskId ? { taskId: q.data.taskId } : {}),
      ...(q.data.state ? { state: q.data.state } : {}),
      limit: q.data.limit,
    });
    return reply.send({ runs });
  });

  app.get('/v1/validation/runs/:runId', async (req, reply) => {
    const { runId } = req.params as { runId: string };
    const q = req.query as { projectId?: string };
    const g = await guard(req, reply, 'read', q.projectId);
    if (!g) return;
    if (!g.projectId) return reply.code(400).send({ error: 'validation', message: 'projectId is required' });
    const run = await validation.getRun(runId, g.projectId);
    if (!run) return reply.code(404).send({ error: 'not_found', message: `validation run ${runId} not found` });
    return reply.send({ run });
  });

  // --- Inbox / triage (read scope queries; mutate scope triages your own cards) ---
  // A user token only ever sees and triages its own inbox; the bootstrap
  // superuser (userId null) may address any user in the project explicitly.
  app.get('/v1/notifications', async (req, reply) => {
    const q = NotificationsQuery.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'validation', message: q.error.message });
    const g = await guard(req, reply, 'read', q.data.projectId);
    if (!g) return;
    if (!g.projectId) return reply.code(400).send({ error: 'validation', message: 'projectId is required' });
    const userId = g.ctx.userId ?? q.data.userId;
    const list = await notifications.list(g.projectId, {
      ...(userId ? { userId } : {}),
      ...(q.data.state ? { state: q.data.state } : {}),
      ...(q.data.kind ? { kind: q.data.kind } : {}),
      limit: q.data.limit,
    });
    return reply.send({ notifications: list });
  });

  app.post('/v1/notifications/:id/state', async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = NotificationStateBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'validation', message: body.error.message });
    const g = await guard(req, reply, 'mutate', body.data.projectId);
    if (!g) return;
    if (!g.projectId) return reply.code(400).send({ error: 'validation', message: 'projectId is required' });
    const notification = await notifications.setState(
      id, g.projectId, body.data.state, originOf(g.ctx), g.ctx.userId ?? undefined,
    );
    return reply.send({ notification });
  });

  // Read-scoped team directory so any member can attribute sessions to developers.
  app.get('/v1/members', async (req, reply) => {
    const q = MembersQuery.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: 'validation', message: q.error.message });
    const g = await guard(req, reply, 'read', q.data.projectId);
    if (!g) return;
    if (!g.projectId) return reply.code(400).send({ error: 'validation', message: 'projectId is required' });
    return reply.send({ members: await auth.listDirectory(g.projectId) });
  });

  // --- Management (admin scope; bootstrap superuser or project admin token) ---
  app.post('/v1/admin/tokens', async (req, reply) => {
    const body = IssueTokenBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'validation', message: body.error.message });
    const g = await guard(req, reply, 'admin', body.data.projectId);
    if (!g) return;
    const issued = await auth.issueToken({ ...body.data, actor: actorOf(g.ctx) });
    return reply.code(201).send(issued);
  });

  app.get('/v1/admin/tokens', async (req, reply) => {
    const query = req.query as { projectId?: string };
    const g = await guard(req, reply, 'admin', query.projectId);
    if (!g) return;
    if (!g.projectId)
      return reply.code(400).send({ error: 'validation', message: 'projectId is required' });
    return reply.send({ tokens: await auth.listTokens(g.projectId) });
  });

  app.post('/v1/admin/tokens/:id/revoke', async (req, reply) => {
    const { id } = req.params as { id: string };
    const query = req.query as { projectId?: string };
    const g = await guard(req, reply, 'admin', query.projectId);
    if (!g) return;
    const result = await auth.revokeToken(g.projectId, id, actorOf(g.ctx));
    return reply.send({ ok: true, id, ...result });
  });

  app.post('/v1/admin/members', async (req, reply) => {
    const body = MemberBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'validation', message: body.error.message });
    const g = await guard(req, reply, 'admin', body.data.projectId);
    if (!g) return;
    const result = await auth.upsertMember(body.data.projectId, body.data.userId, body.data.role, actorOf(g.ctx));
    return reply.send({ ok: true, ...result });
  });

  app.get('/v1/admin/members', async (req, reply) => {
    const query = req.query as { projectId?: string };
    const g = await guard(req, reply, 'admin', query.projectId);
    if (!g) return;
    if (!g.projectId)
      return reply.code(400).send({ error: 'validation', message: 'projectId is required' });
    return reply.send({ members: await auth.listMembers(g.projectId) });
  });

  app.post('/v1/admin/devices', async (req, reply) => {
    const body = DeviceBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: 'validation', message: body.error.message });
    const g = await guard(req, reply, 'admin', body.data.projectId);
    if (!g) return;
    const device = await auth.registerDevice({ ...body.data, actor: actorOf(g.ctx) });
    return reply.code(201).send(device);
  });

  app.get('/v1/admin/audit', async (req, reply) => {
    const query = req.query as { projectId?: string; limit?: string };
    const g = await guard(req, reply, 'admin', query.projectId);
    if (!g) return;
    if (!g.projectId)
      return reply.code(400).send({ error: 'validation', message: 'projectId is required' });
    const limit = query.limit ? Math.min(1000, Math.max(1, Number(query.limit) || 100)) : 100;
    return reply.send({ records: await readAudit(poolExecutor(db.pool), g.projectId, limit) });
  });

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    // Force-end persistent SSE connections so app.close() does not hang.
    for (const cleanup of [...activeStreams]) cleanup();
    activeStreams.clear();
    hub.close();
    await app.close();
    await db.close();
    logger.info('server stopped');
  };

  return {
    config,
    logger,
    db,
    app,
    async listen() {
      const address = await app.listen({ host: config.host, port: config.port });
      logger.info({ address, pid: process.pid }, 'weft server listening');
      return address;
    },
    close,
  };
}