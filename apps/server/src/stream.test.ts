import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { performance } from 'node:perf_hooks';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool } from 'pg';
import type { FastifyInstance } from 'fastify';
import { makeId, ulid, PROTOCOL_VERSION } from '@weft/protocol';
import { createServer, type TeamServer } from './server.js';
import type { ServerConfig } from './config.js';
import { startEmbeddedPostgres, freePort, type EmbeddedCluster } from '../test/embedded.js';
import { seedWorld, type World } from '../test/identity.js';

let cluster: EmbeddedCluster;
let server: TeamServer;
let app: FastifyInstance;
let pool: Pool;
let baseUrl: string;
let world: World;
let dataDir: string;
const adminSecret = 'test-admin-secret';

beforeAll(async () => {
  cluster = await startEmbeddedPostgres();
  dataDir = mkdtempSync(join(tmpdir(), 'weft-stream-'));
  const config: ServerConfig = {
    dataDir,
    host: '127.0.0.1',
    port: await freePort(),
    databaseUrl: cluster.databaseUrl,
    logLevel: 'fatal',
    corsOrigin: '*',
  };
  server = await createServer(config, { adminSecret });
  app = server.app;
  pool = server.db.pool;
  baseUrl = await server.listen();
  world = await seedWorld(pool);
}, 90_000);

afterAll(async () => {
  await server?.close();
  await cluster?.stop();
  if (dataDir) {
    try {
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 5 });
    } catch {
      /* best-effort */
    }
  }
});

interface Frame {
  id?: string;
  event?: string;
  data: string;
}

/** Minimal SSE client: parses frames, ignores heartbeats/retry, polls for frames. */
class SseClient {
  private buffer = '';
  private reader!: ReadableStreamDefaultReader<Uint8Array>;
  private readonly controller = new AbortController();
  readonly frames: Frame[] = [];

  static async connect(path: string, token: string, cursor?: number): Promise<SseClient> {
    const client = new SseClient();
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    if (cursor != null) headers['last-event-id'] = String(cursor);
    const res = await fetch(`${baseUrl}${path}`, { headers, signal: client.controller.signal });
    if (res.status !== 200 || !res.body) throw new Error(`SSE connect failed: ${res.status}`);
    client.reader = res.body.getReader();
    void client.pump();
    return client;
  }

  private async pump(): Promise<void> {
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await this.reader.read();
        if (done) break;
        this.buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = this.buffer.indexOf('\n\n')) >= 0) {
          const block = this.buffer.slice(0, idx);
          this.buffer = this.buffer.slice(idx + 2);
          this.parse(block);
        }
      }
    } catch {
      /* aborted */
    }
  }

  private parse(block: string): void {
    let id: string | undefined;
    let event: string | undefined;
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith(':')) continue;
      if (line.startsWith('id:')) id = line.slice(3).trim();
      else if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).trim());
    }
    if (data.length === 0 && !event) return;
    this.frames.push({ ...(id !== undefined ? { id } : {}), ...(event !== undefined ? { event } : {}), data: data.join('\n') });
  }

  dataEvents(): { global_seq: number; type: string; project_id: string }[] {
    return this.frames
      .filter((f) => !f.event && f.data)
      .map((f) => JSON.parse(f.data) as { global_seq: number; type: string; project_id: string });
  }

  async waitUntil(pred: () => boolean, timeout = 8000): Promise<void> {
    const start = Date.now();
    while (!pred()) {
      if (Date.now() - start > timeout) throw new Error('SSE wait timeout');
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  close(): void {
    this.controller.abort();
  }
}

function ev(projectId: string, type: string, payload: Record<string, unknown>) {
  return {
    v: PROTOCOL_VERSION,
    event_id: ulid(),
    device_id: world.deviceId,
    project_id: projectId,
    ts: new Date().toISOString(),
    type,
    actor: { user_id: 'user_test', agent: null },
    privacy: 'metadata',
    payload,
  };
}

async function ingest(projectId: string, token: string, events: unknown[]): Promise<void> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/ingest',
    headers: { authorization: `Bearer ${token}` },
    payload: { events },
  });
  expect(res.statusCode).toBe(202);
}

/** Fresh project + member token so global_seq starts deterministically at 1. */
async function freshProject(): Promise<{ projectId: string; token: string }> {
  const projectId = makeId('project');
  await pool.query('INSERT INTO projects (id, team_id, name, slug) VALUES ($1, $2, $3, $4)', [
    projectId, world.teamId, 'Stream Project', `p-${projectId}`,
  ]);
  await pool.query('INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, $3)', [
    projectId, world.memberUser, 'member',
  ]);
  const res = await app.inject({
    method: 'POST',
    url: '/v1/admin/tokens',
    headers: { authorization: `Bearer ${adminSecret}` },
    payload: { projectId, role: 'member', userId: world.memberUser },
  });
  expect(res.statusCode).toBe(201);
  return { projectId, token: (res.json() as { token: string }).token };
}

const toolPost = { tool_name: 'Bash', success: true };

describe('server SSE fan-out (real Postgres 16)', () => {
  it('delivers catch-up then live events ordered by global_seq', async () => {
    const { projectId, token } = await freshProject();
    await ingest(projectId, token, [ev(projectId, 'tool.post', toolPost)]);
    const client = await SseClient.connect('/v1/stream', token);
    try {
      await client.waitUntil(() => client.dataEvents().length >= 1);
      expect(client.dataEvents()[0].global_seq).toBe(1);
      // Live fan-out: a new ingest wakes the connected subscriber.
      await ingest(projectId, token, [ev(projectId, 'tool.post', toolPost), ev(projectId, 'tool.post', toolPost)]);
      await client.waitUntil(() => client.dataEvents().length >= 3);
      expect(client.dataEvents().map((e) => e.global_seq)).toEqual([1, 2, 3]);
      expect(client.dataEvents().every((e) => e.project_id === projectId)).toBe(true);
    } finally {
      client.close();
    }
  });

  it('resumes from a Last-Event-ID cursor', async () => {
    const { projectId, token } = await freshProject();
    await ingest(projectId, token, [
      ev(projectId, 'tool.post', toolPost),
      ev(projectId, 'tool.post', toolPost),
      ev(projectId, 'tool.post', toolPost),
    ]);
    const client = await SseClient.connect('/v1/stream', token, 1);
    try {
      await client.waitUntil(() => client.dataEvents().length >= 2);
      expect(client.dataEvents().map((e) => e.global_seq)).toEqual([2, 3]);
    } finally {
      client.close();
    }
  });

  it('forces an explicit resync when the cursor is below the min_seq watermark', async () => {
    const { projectId, token } = await freshProject();
    await ingest(projectId, token, Array.from({ length: 5 }, () => ev(projectId, 'tool.post', toolPost)));
    // Simulate retention advancing the watermark past the client's cursor.
    await pool.query('UPDATE project_stream_seq SET min_seq = 4 WHERE project_id = $1', [projectId]);
    const client = await SseClient.connect('/v1/stream', token, 2);
    try {
      await client.waitUntil(() => client.dataEvents().length >= 2);
      const resync = client.frames.find((f) => f.event === 'resync');
      expect(resync).toBeDefined();
      expect(JSON.parse(resync!.data)).toMatchObject({ min_seq: 4 });
      // Never a silent skip: resumes at the earliest available event (seq 4).
      expect(client.dataEvents().map((e) => e.global_seq)).toEqual([4, 5]);
    } finally {
      client.close();
    }
  });

  it('coordination channel pushes only durable enforcement types', async () => {
    const { projectId, token } = await freshProject();
    await ingest(projectId, token, [
      ev(projectId, 'tool.post', toolPost),
      ev(projectId, 'task.claimed', { version: 0 }),
      ev(projectId, 'file.changed', { path: 'a.ts', change_kind: 'modify', source: 'watcher' }),
      ev(projectId, 'conflict.detected', { canonical_key: 'k1' }),
      ev(projectId, 'commit.created', { oid: 'abc123', branch: 'main', parents: [] }),
      ev(projectId, 'reservation.acquired', { path_glob: 'src/**', mode: 'soft' }),
    ]);
    const coord = await SseClient.connect('/v1/coordination', token);
    const team = await SseClient.connect('/v1/stream', token);
    try {
      await coord.waitUntil(() => coord.dataEvents().length >= 3);
      await team.waitUntil(() => team.dataEvents().length >= 6);
      expect(coord.dataEvents().map((e) => e.type)).toEqual([
        'task.claimed', 'conflict.detected', 'reservation.acquired',
      ]);
      expect(team.dataEvents()).toHaveLength(6);
    } finally {
      coord.close();
      team.close();
    }
  });

  it('fans out one ingest to many concurrent clients', async () => {
    const { projectId, token } = await freshProject();
    const clients = await Promise.all(
      Array.from({ length: 5 }, () => SseClient.connect('/v1/stream', token)),
    );
    try {
      await ingest(projectId, token, [ev(projectId, 'tool.post', toolPost)]);
      await Promise.all(clients.map((c) => c.waitUntil(() => c.dataEvents().length >= 1)));
      for (const c of clients) {
        expect(c.dataEvents()[0].global_seq).toBe(1);
        expect(c.dataEvents()[0].project_id).toBe(projectId);
      }
    } finally {
      for (const c of clients) c.close();
    }
  });

  it('denies a stream subscription across projects', async () => {
    const { token } = await freshProject();
    const res = await fetch(`${baseUrl}/v1/stream?projectId=${world.projectB}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
    await res.body?.cancel();
  });

  it('fans out a burst to 100 concurrent clients with zero loss or duplication', async () => {
    const { projectId, token } = await freshProject();
    const clients = await Promise.all(
      Array.from({ length: 100 }, () => SseClient.connect('/v1/stream', token)),
    );
    try {
      const burst = Array.from({ length: 20 }, () => ev(projectId, 'tool.post', toolPost));
      const t0 = performance.now();
      await ingest(projectId, token, burst);
      await Promise.all(clients.map((c) => c.waitUntil(() => c.dataEvents().length >= 20, 15_000)));
      const elapsed = performance.now() - t0;
      const expected = Array.from({ length: 20 }, (_, i) => i + 1);
      for (const c of clients) {
        // Every listener converges to the exact ordered sequence: no loss, no dup.
        expect(c.dataEvents().map((e) => e.global_seq)).toEqual(expected);
        expect(c.dataEvents().every((e) => e.project_id === projectId)).toBe(true);
      }
      console.log(`  fan-out 100 clients × 20 events converged in ${elapsed.toFixed(0)}ms`);
      expect(elapsed).toBeLessThan(10_000);
    } finally {
      for (const c of clients) c.close();
    }
  }, 30_000);
});