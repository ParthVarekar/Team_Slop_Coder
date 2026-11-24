import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeId, ulid, PROTOCOL_VERSION } from '@weft/protocol';
import { createServer, type TeamServer } from './server.js';
import type { ServerConfig } from './config.js';
import { startEmbeddedPostgres, freePort, type EmbeddedCluster } from '../test/embedded.js';
import { seedWorld } from '../test/identity.js';

let cluster: EmbeddedCluster;
let server: TeamServer;
let baseUrl: string;
let dataDir: string;
const adminSecret = 'test-admin-secret';
let shutdownCalled = false;

beforeAll(async () => {
  cluster = await startEmbeddedPostgres();
  dataDir = mkdtempSync(join(tmpdir(), 'weft-server-'));
  const config: ServerConfig = {
    dataDir,
    host: '127.0.0.1',
    port: await freePort(),
    databaseUrl: cluster.databaseUrl,
    logLevel: 'fatal',
    corsOrigin: '*',
  };
  server = await createServer(config, {
    adminSecret,
    onShutdown: () => {
      shutdownCalled = true;
    },
  });
  baseUrl = await server.listen();
}, 90_000);

afterAll(async () => {
  await server?.close();
  await cluster?.stop();
  if (dataDir) {
    try {
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 5 });
    } catch {
      /* best-effort: Windows may briefly lock files */
    }
  }
});

describe('team server bootstrap (real Postgres 16)', () => {
  it('serves /healthz with the database up', async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, role: 'team-server', database: 'up' });
  });

  it('rejects unauthenticated and wrong-token shutdown', async () => {
    const noAuth = await fetch(`${baseUrl}/v1/shutdown`, { method: 'POST' });
    expect(noAuth.status).toBe(401);
    const wrong = await fetch(`${baseUrl}/v1/shutdown`, {
      method: 'POST',
      headers: { authorization: 'Bearer nope' },
    });
    expect(wrong.status).toBe(401);
    expect(shutdownCalled).toBe(false);
  });

  it('acknowledges an authenticated shutdown and invokes the callback', async () => {
    const res = await fetch(`${baseUrl}/v1/shutdown`, {
      method: 'POST',
      headers: { authorization: `Bearer ${adminSecret}` },
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ ok: true });
    await new Promise((resolve) => setImmediate(resolve));
    expect(shutdownCalled).toBe(true);
  });

  it('ingests a batch over HTTP and dedups a replay', async () => {
    const projectId = makeId('project');
    const event = {
      v: PROTOCOL_VERSION,
      event_id: ulid(),
      device_id: makeId('device'),
      project_id: projectId,
      ts: new Date().toISOString(),
      type: 'tool.post',
      actor: { user_id: 'user_test', agent: null },
      privacy: 'metadata',
      payload: { tool_name: 'Bash', success: true },
    };
    const post = () =>
      fetch(`${baseUrl}/v1/ingest`, {
        method: 'POST',
        headers: { authorization: `Bearer ${adminSecret}`, 'content-type': 'application/json' },
        body: JSON.stringify({ events: [event] }),
      });
    const first = await post();
    expect(first.status).toBe(202);
    const body = (await first.json()) as {
      accepted: { global_seq: number }[];
      duplicates: unknown[];
      streams: Record<string, { last_seq: number }>;
    };
    expect(body.accepted).toHaveLength(1);
    expect(body.accepted[0].global_seq).toBe(1);
    expect(body.streams[projectId].last_seq).toBe(1);

    const replay = await post();
    expect(replay.status).toBe(202);
    const replayBody = (await replay.json()) as { accepted: unknown[]; duplicates: unknown[] };
    expect(replayBody.accepted).toHaveLength(0);
    expect(replayBody.duplicates).toHaveLength(1);
  });

  it('serves a user-scoped inbox, triage, and directory over HTTP with RBAC', async () => {
    const world = await seedWorld(server.db.pool);
    const admin = { authorization: `Bearer ${adminSecret}`, 'content-type': 'application/json' };
    const issue = async (userId: string, role: 'member' | 'viewer') => {
      const res = await fetch(`${baseUrl}/v1/admin/tokens`, {
        method: 'POST',
        headers: admin,
        body: JSON.stringify({ projectId: world.projectA, userId, role }),
      });
      expect(res.status).toBe(201);
      return (await res.json()) as { token: string };
    };
    const member = await issue(world.memberUser, 'member');
    const viewer = await issue(world.viewerUser, 'viewer');
    const asMember = {
      authorization: `Bearer ${member.token}`,
      'content-type': 'application/json',
    };
    const asViewer = {
      authorization: `Bearer ${viewer.token}`,
      'content-type': 'application/json',
    };

    const eventId = ulid();
    const ingest = await fetch(`${baseUrl}/v1/ingest`, {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({
        events: [
          {
            v: PROTOCOL_VERSION,
            event_id: eventId,
            device_id: world.deviceId,
            project_id: world.projectA,
            ts: new Date().toISOString(),
            type: 'notification.created',
            actor: { user_id: world.memberUser, agent: null },
            privacy: 'metadata',
            payload: {
              kind: 'approval',
              subject: 'Please review the merge',
              target_user_id: world.memberUser,
            },
          },
        ],
      }),
    });
    expect(ingest.status).toBe(202);

    const inbox = await fetch(`${baseUrl}/v1/notifications?projectId=${world.projectA}`, {
      headers: asMember,
    });
    expect(inbox.status).toBe(200);
    const cards = (await inbox.json()) as {
      notifications: { id: string; state: string; user_id: string }[];
    };
    expect(cards.notifications).toHaveLength(1);
    expect(cards.notifications[0]).toMatchObject({
      id: eventId,
      state: 'inbox',
      user_id: world.memberUser,
    });

    const triage = await fetch(`${baseUrl}/v1/notifications/${eventId}/state`, {
      method: 'POST',
      headers: asMember,
      body: JSON.stringify({ projectId: world.projectA, state: 'done' }),
    });
    expect(triage.status).toBe(200);
    expect((await triage.json()) as { notification: { state: string } }).toMatchObject({
      notification: { state: 'done' },
    });

    const empty = await fetch(
      `${baseUrl}/v1/notifications?projectId=${world.projectA}&state=inbox`,
      { headers: asMember },
    );
    expect(((await empty.json()) as { notifications: unknown[] }).notifications).toHaveLength(0);

    // A viewer only ever sees its own (empty) inbox and cannot triage.
    const viewerInbox = await fetch(`${baseUrl}/v1/notifications?projectId=${world.projectA}`, {
      headers: asViewer,
    });
    expect(((await viewerInbox.json()) as { notifications: unknown[] }).notifications).toHaveLength(
      0,
    );
    const viewerTriage = await fetch(`${baseUrl}/v1/notifications/${eventId}/state`, {
      method: 'POST',
      headers: asViewer,
      body: JSON.stringify({ projectId: world.projectA, state: 'done' }),
    });
    expect(viewerTriage.status).toBe(403);

    const directory = await fetch(`${baseUrl}/v1/members?projectId=${world.projectA}`, {
      headers: asMember,
    });
    expect(directory.status).toBe(200);
    const members = (await directory.json()) as {
      members: { userId: string; displayName: string }[];
    };
    expect(members.members.map((m) => m.userId)).toContain(world.memberUser);
    expect(members.members.find((m) => m.userId === world.memberUser)?.displayName).toBeTruthy();

    // A project-A token can never address project B's inbox.
    const cross = await fetch(`${baseUrl}/v1/notifications?projectId=${world.projectB}`, {
      headers: asMember,
    });
    expect(cross.status).toBe(403);
    expect((await cross.json()) as { reason: string }).toMatchObject({ reason: 'cross_project' });
  });

  it('answers browser CORS preflight and exposes the allow-origin header', async () => {
    const preflight = await fetch(`${baseUrl}/v1/tasks`, {
      method: 'OPTIONS',
      headers: {
        origin: 'http://localhost:5173',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'authorization,content-type',
      },
    });
    expect([200, 204]).toContain(preflight.status);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('*');
    expect(preflight.headers.get('access-control-allow-headers')).toContain('authorization');

    const simple = await fetch(`${baseUrl}/healthz`, {
      headers: { origin: 'http://localhost:5173' },
    });
    expect(simple.status).toBe(200);
    expect(simple.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('carries CORS headers onto the hijacked SSE stream response', async () => {
    const world = await seedWorld(server.db.pool);
    const tokRes = await fetch(`${baseUrl}/v1/admin/tokens`, {
      method: 'POST',
      headers: { authorization: `Bearer ${adminSecret}`, 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: world.projectA, userId: world.memberUser, role: 'member' }),
    });
    const { token } = (await tokRes.json()) as { token: string };
    const controller = new AbortController();
    const res = await fetch(`${baseUrl}/v1/stream?projectId=${world.projectA}&after=0`, {
      headers: { authorization: `Bearer ${token}`, origin: 'http://localhost:5173' },
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    controller.abort();
    await res.body?.cancel().catch(() => {});
  });

  it('serves bounded handoff changes with task/repo scoping and cutoff filters', async () => {
    const projectId = makeId('project');
    const repoId = makeId('repo');
    const taskId = makeId('task');
    const since = '2026-11-25T11:00:00.000Z';
    const until = '2026-11-25T12:00:00.000Z';
    const fileEvent = (id: string, eventRepo: string, eventTask: string | null, ts: string) => ({
      v: PROTOCOL_VERSION,
      event_id: id,
      device_id: makeId('device'),
      project_id: projectId,
      repo_id: eventRepo,
      ...(eventTask ? { task_id: eventTask } : {}),
      ts,
      type: 'file.changed',
      actor: { user_id: 'user_test', agent: null },
      privacy: 'metadata',
      payload: { path: 'src/a.ts', change_kind: 'modify', source: 'watcher' },
    });
    const target = ulid();
    const repoChange = ulid();
    const excludedTask = ulid();
    const excludedRepo = ulid();
    const future = ulid();
    const old = ulid();
    const newestNoise = ulid();
    const nextNoise = ulid();
    const noise = (id: string, ts: string) => ({
      ...fileEvent(id, repoId, taskId, ts),
      type: 'task.updated',
      payload: { fields: { title: 'Not a file change' } },
    });
    const ingest = await fetch(`${baseUrl}/v1/ingest`, {
      method: 'POST',
      headers: { authorization: `Bearer ${adminSecret}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        events: [
          fileEvent(target, repoId, taskId, '2026-11-25T11:30:00.000Z'),
          fileEvent(repoChange, repoId, null, '2026-11-25T11:31:00.000Z'),
          fileEvent(excludedRepo, makeId('repo'), excludedTask, '2026-11-25T11:32:00.000Z'),
          fileEvent(future, repoId, taskId, '2026-11-25T13:00:00.000Z'),
          fileEvent(old, repoId, taskId, '2026-11-25T10:00:00.000Z'),
          noise(newestNoise, '2026-11-25T11:59:00.000Z'),
          noise(nextNoise, '2026-11-25T11:58:00.000Z'),
        ],
      }),
    });
    expect(ingest.status).toBe(202);
    const query = new URLSearchParams({ projectId, taskId, repoId, since, until, limit: '2' });
    const denied = await fetch(`${baseUrl}/v1/handoff/changes?${query}`);
    expect(denied.status).toBe(401);
    const res = await fetch(`${baseUrl}/v1/handoff/changes?${query}`, {
      headers: { authorization: `Bearer ${adminSecret}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      events: { event_id: string; task_id?: string }[];
      history_complete: boolean;
    };
    expect(body.events.map((event) => event.event_id)).toEqual([repoChange, target]);
    expect(body.events[1]?.task_id).toBe(taskId);
    expect(body.history_complete).toBe(false);
    expect(body.events.map((event) => event.event_id)).not.toContain(excludedTask);
    expect(body.events.map((event) => event.event_id)).not.toContain(newestNoise);
    expect(body.events.map((event) => event.event_id)).not.toContain(nextNoise);

    const invalidWindow = await fetch(
      `${baseUrl}/v1/handoff/changes?${new URLSearchParams({ projectId, taskId, repoId, since: until, until: since })}`,
      { headers: { authorization: `Bearer ${adminSecret}` } },
    );
    expect(invalidWindow.status).toBe(400);
  });

  it('closes gracefully and idempotently, releasing the port', async () => {
    await server.close();
    await server.close();
    await expect(fetch(`${baseUrl}/healthz`)).rejects.toThrow();
  });

  it('fails closed on /v1 routes when no admin secret is configured', async () => {
    const bare = await createServer({
      dataDir,
      host: '127.0.0.1',
      port: await freePort(),
      databaseUrl: cluster.databaseUrl,
      logLevel: 'fatal',
      corsOrigin: '*',
    });
    try {
      const shutdown = await bare.app.inject({ method: 'POST', url: '/v1/shutdown' });
      expect(shutdown.statusCode).toBe(401);
      const ingest = await bare.app.inject({
        method: 'POST',
        url: '/v1/ingest',
        payload: { events: [] },
      });
      expect(ingest.statusCode).toBe(401);
      const health = await bare.app.inject({ method: 'GET', url: '/healthz' });
      expect(health.statusCode).toBe(200);
    } finally {
      await bare.close();
    }
  });
});
