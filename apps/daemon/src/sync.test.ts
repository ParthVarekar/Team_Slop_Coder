import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { performance } from 'node:perf_hooks';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool } from 'pg';
import type { FastifyInstance } from 'fastify';
import { makeId, type Actor } from '@weft/protocol';
import { createServer, type TeamServer } from '../../server/src/server.js';
import type { ServerConfig } from '../../server/src/config.js';
import {
  startEmbeddedPostgres,
  freePort,
  type EmbeddedCluster,
} from '../../server/test/embedded.js';
import { seedWorld, type World } from '../../server/test/identity.js';
import { LocalStore, type StoredLocalEvent } from './store.js';
import { OutboxShipper } from './shipper.js';
import { CoordinationClient } from './coordination.js';
import { EnforcementCache } from './enforcement.js';
import { TaskCache } from './task-cache.js';
import { draftEvent, type EventSource } from './events.js';

const adminSecret = 'sync-admin-secret';
let cluster: EmbeddedCluster;
let server: TeamServer;
let app: FastifyInstance;
let pool: Pool;
let baseUrl: string;
let world: World;
const dirs: string[] = [];
const stores: LocalStore[] = [];

beforeAll(async () => {
  cluster = await startEmbeddedPostgres();
  const dir = mkdtempSync(join(tmpdir(), 'weft-sync-'));
  dirs.push(dir);
  const config: ServerConfig = {
    dataDir: dir,
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
}, 120_000);

afterAll(async () => {
  for (const store of stores) {
    try {
      store.close();
    } catch {
      /* already closed */
    }
  }
  await server?.close();
  await cluster?.stop();
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    } catch {
      /* best-effort */
    }
  }
});

const actor: Actor = { user_id: 'user_sync', agent: null };

function ev(
  src: EventSource,
  type: string,
  payload: Record<string, unknown>,
  extra: Partial<StoredLocalEvent> = {},
): StoredLocalEvent {
  return {
    ...draftEvent(src, { type, actor, payload }),
    received_at: new Date().toISOString(),
    ...extra,
  };
}

async function waitUntil(pred: () => boolean, timeout = 10_000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeout) throw new Error('wait timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Fresh project + registered device + member device-token + local store. */
async function freshDaemon() {
  const projectId = makeId('project');
  const deviceId = makeId('device');
  await pool.query('INSERT INTO projects (id, team_id, name, slug) VALUES ($1,$2,$3,$4)', [
    projectId,
    world.teamId,
    'Sync Project',
    `p-${projectId}`,
  ]);
  await pool.query('INSERT INTO project_members (project_id, user_id, role) VALUES ($1,$2,$3)', [
    projectId,
    world.memberUser,
    'member',
  ]);
  const dev = await app.inject({
    method: 'POST',
    url: '/v1/admin/devices',
    headers: { authorization: `Bearer ${adminSecret}` },
    payload: { projectId, deviceId, userId: world.memberUser },
  });
  expect(dev.statusCode).toBe(201);
  const tok = await app.inject({
    method: 'POST',
    url: '/v1/admin/tokens',
    headers: { authorization: `Bearer ${adminSecret}` },
    payload: { projectId, deviceId, role: 'member' },
  });
  expect(tok.statusCode).toBe(201);
  const token = (tok.json() as { token: string }).token;
  const dir = mkdtempSync(join(tmpdir(), 'weft-sync-d-'));
  dirs.push(dir);
  const store = LocalStore.open(dir);
  stores.push(store);
  const src: EventSource = { deviceId, projectId };
  return { projectId, deviceId, token, store, src, dir };
}

function makeShipper(
  d: Awaited<ReturnType<typeof freshDaemon>>,
  fetchImpl?: typeof fetch,
  baseUrlOverride?: string,
) {
  return new OutboxShipper({
    baseUrl: baseUrlOverride ?? baseUrl,
    token: d.token,
    store: d.store,
    ...(fetchImpl ? { fetchImpl } : {}),
    intervalMs: 60_000,
    backoffMs: 1,
    maxBackoffMs: 5,
  });
}

/** Toggleable network partition in front of the real fetch. */
function gate() {
  let down = false;
  let calls = 0;
  let failAfter = Infinity;
  const impl: typeof fetch = (input, init) => {
    calls += 1;
    if (down || calls > failAfter) return Promise.reject(new Error('network partition'));
    return fetch(input as string, init);
  };
  return {
    impl,
    setDown: (v: boolean) => {
      down = v;
    },
    setFailAfter: (n: number) => {
      failAfter = n;
    },
  };
}

async function countEvents(projectId: string): Promise<number> {
  const res = await pool.query('SELECT COUNT(*)::int AS c FROM events WHERE project_id = $1', [
    projectId,
  ]);
  return res.rows[0].c as number;
}

async function makeServer(port: number): Promise<TeamServer> {
  const dir = mkdtempSync(join(tmpdir(), 'weft-sync-srv-'));
  dirs.push(dir);
  return createServer(
    {
      dataDir: dir,
      host: '127.0.0.1',
      port,
      databaseUrl: cluster.databaseUrl,
      logLevel: 'fatal',
      corsOrigin: '*',
    },
    { adminSecret },
  );
}

describe('daemon↔server sync (real Postgres 16)', () => {
  it('ships the outbox and projects coordination into the enforcement cache', async () => {
    const d = await freshDaemon();
    const taskId = makeId('task');
    d.store.insertEvents(
      [
        ev(d.src, 'reservation.acquired', {
          path_glob: 'src/**',
          mode: 'hard',
          holder_task_id: 'task_owner',
        }),
        ev(d.src, 'task.claimed', { version: 0 }, { task_id: taskId }),
        ev(d.src, 'conflict.detected', { canonical_key: 'k1', kind: 'file_overlap' }),
        ev(d.src, 'tool.post', { tool_name: 'Read', success: true }),
      ],
      true,
    );
    const s = makeShipper(d);
    const result = await s.drain();
    expect(result.shipped).toBe(4);
    expect(await countEvents(d.projectId)).toBe(4);

    const cache = new EnforcementCache();
    const client = new CoordinationClient({
      baseUrl,
      token: d.token,
      projectId: d.projectId,
      cache,
      store: d.store,
      reconnectMs: 50,
      maxReconnectMs: 200,
    });
    client.start();
    try {
      await waitUntil(() => cache.getCursor() >= 3);
      // tool.post (seq 4) is excluded from the coordination channel.
      expect(cache.getCursor()).toBe(3);
      expect(cache.checkReservation('src/a.ts', 'task_other')).toBe('blocked');
      expect(cache.getClaim(taskId)?.state).toBe('claimed');
      expect(cache.getConflict('k1')?.state).toBe('open');
      expect(cache.isStale()).toBe(false);
      const coord = await pool.query(
        'SELECT COUNT(*)::int AS c FROM coordination_events WHERE project_id=$1',
        [d.projectId],
      );
      expect(coord.rows[0].c).toBe(3);
    } finally {
      await client.stop();
      await s.stop();
    }
  }, 20_000);

  it('survives a network partition with zero loss and zero duplication', async () => {
    const d = await freshDaemon();
    const g = gate();
    const s = makeShipper(d, g.impl);
    const batch = Array.from({ length: 6 }, () => ev(d.src, 'task.created', { version: 0 }));
    d.store.insertEvents(batch, true);
    g.setDown(true);
    const failed = await s.drain();
    expect(failed.error).toBeDefined();
    expect(d.store.pendingOutboxCount()).toBe(6);
    expect(await countEvents(d.projectId)).toBe(0);
    // Partition heals: the durable outbox drains exactly once.
    g.setDown(false);
    const ok = await s.drain();
    expect(ok.shipped).toBe(6);
    expect(d.store.pendingOutboxCount()).toBe(0);
    expect(await countEvents(d.projectId)).toBe(6);
    // Acknowledged replays neither refill the outbox nor duplicate server rows.
    d.store.insertEvents(batch, true);
    const replay = await s.drain();
    expect(replay.duplicates).toBe(0);
    expect(d.store.pendingOutboxCount()).toBe(0);
    expect(await countEvents(d.projectId)).toBe(6);
    expect(
      Number(
        (
          await pool.query(
            'SELECT count(*)::int AS c FROM coordination_events WHERE project_id=$1',
            [d.projectId],
          )
        ).rows[0].c,
      ),
    ).toBe(6);
    await s.stop();
  }, 20_000);

  it('resumes the durable outbox after a daemon crash mid-shipping', async () => {
    const d = await freshDaemon();
    const g = gate();
    g.setFailAfter(1); // first batch succeeds, then the link "crashes"
    const batch = Array.from({ length: 6 }, () => ev(d.src, 'task.created', { version: 0 }));
    d.store.insertEvents(batch, true);
    const s1 = new OutboxShipper({
      baseUrl,
      token: d.token,
      store: d.store,
      fetchImpl: g.impl,
      batchSize: 2,
      intervalMs: 60_000,
      backoffMs: 1,
      maxBackoffMs: 5,
    });
    const partial = await s1.drain();
    expect(partial.shipped).toBe(2);
    expect(partial.error).toBeDefined();
    expect(d.store.pendingOutboxCount()).toBe(4);
    await s1.stop();
    d.store.close(); // crash
    // Reopen: the un-acked outbox is durable.
    const reopened = LocalStore.open(d.dir);
    stores.push(reopened);
    expect(reopened.pendingOutboxCount()).toBe(4);
    const s2 = new OutboxShipper({
      baseUrl,
      token: d.token,
      store: reopened,
      intervalMs: 60_000,
      backoffMs: 1,
      maxBackoffMs: 5,
    });
    const ok = await s2.drain();
    expect(ok.shipped).toBe(4);
    expect(reopened.pendingOutboxCount()).toBe(0);
    expect(await countEvents(d.projectId)).toBe(6);
    await s2.stop();
    reopened.close();
  }, 20_000);

  it('retries through a server kill/restart with zero loss and zero duplication', async () => {
    const port = await freePort();
    let srv = await makeServer(port);
    const url = await srv.listen();
    const d = await freshDaemon();
    const s = makeShipper(d, undefined, url);
    d.store.insertEvents(
      Array.from({ length: 3 }, () => ev(d.src, 'task.created', { version: 0 })),
      true,
    );
    expect((await s.drain()).shipped).toBe(3);
    expect(await countEvents(d.projectId)).toBe(3);
    // Kill the server; new events cannot ship and stay durable.
    await srv.close();
    d.store.insertEvents(
      Array.from({ length: 3 }, () => ev(d.src, 'task.created', { version: 0 })),
      true,
    );
    const failed = await s.drain();
    expect(failed.error).toBeDefined();
    expect(d.store.pendingOutboxCount()).toBe(3);
    // Restart on the same port + database; the token still authenticates.
    srv = await makeServer(port);
    await srv.listen();
    const ok = await s.drain();
    expect(ok.shipped).toBe(3);
    expect(d.store.pendingOutboxCount()).toBe(0);
    expect(await countEvents(d.projectId)).toBe(6);
    await s.stop();
    await srv.close();
  }, 30_000);

  it('rebuilds the enforcement cache from the durable trail after a client restart', async () => {
    const d = await freshDaemon();
    const s = makeShipper(d);
    const cache = new EnforcementCache();
    const client = new CoordinationClient({
      baseUrl,
      token: d.token,
      projectId: d.projectId,
      cache,
      store: d.store,
      reconnectMs: 50,
      maxReconnectMs: 200,
    });
    client.start();
    d.store.insertEvents(
      [
        ev(d.src, 'reservation.acquired', {
          path_glob: 'src/**',
          mode: 'hard',
          holder_task_id: 'task_owner',
        }),
      ],
      true,
    );
    await s.drain();
    await waitUntil(() => cache.getCursor() >= 1);
    expect(cache.checkReservation('src/a.ts', 'task_other')).toBe('blocked');
    await client.stop();
    expect(cache.isStale()).toBe(true);
    // Hard reservation fails closed while the link is stale.
    expect(cache.checkReservation('src/a.ts', 'task_other')).toBe('blocked');
    // More coordination arrives while the client is down.
    d.store.insertEvents(
      [
        ev(d.src, 'reservation.acquired', {
          path_glob: 'docs/**',
          mode: 'soft',
          holder_task_id: 'task_owner',
        }),
      ],
      true,
    );
    await s.drain();
    // A fresh client replays from seq 0 and rebuilds the full volatile cache.
    const cache2 = new EnforcementCache();
    const client2 = new CoordinationClient({
      baseUrl,
      token: d.token,
      projectId: d.projectId,
      cache: cache2,
      store: d.store,
      reconnectMs: 50,
      maxReconnectMs: 200,
    });
    client2.start();
    try {
      await waitUntil(() => cache2.getCursor() >= 2);
      expect(cache2.snapshot().reservations).toHaveLength(2);
      expect(cache2.checkReservation('src/a.ts', 'task_other')).toBe('blocked');
      expect(cache2.checkReservation('docs/a.md', 'task_other')).toBe('warn');
      expect(d.store.getSyncState('coordination_cursor')).toBe('2');
    } finally {
      await client2.stop();
      await s.stop();
    }
  }, 20_000);

  it('projects server-authoritative task mutations and claim rejections into the task cache', async () => {
    const d = await freshDaemon();
    const auth = { authorization: `Bearer ${d.token}` };
    const cache = new EnforcementCache();
    const taskCache = new TaskCache();
    const client = new CoordinationClient({
      baseUrl,
      token: d.token,
      projectId: d.projectId,
      cache,
      taskCache,
      store: d.store,
      reconnectMs: 50,
      maxReconnectMs: 200,
    });
    client.start();
    try {
      const created = await app.inject({
        method: 'POST',
        url: '/v1/tasks',
        headers: auth,
        payload: { title: 'Synced task' },
      });
      expect(created.statusCode).toBe(201);
      const task = (created.json() as { task: { id: string; version: number } }).task;
      const ready = await app.inject({
        method: 'POST',
        url: `/v1/tasks/${task.id}/transition`,
        headers: auth,
        payload: { baseVersion: 0, to: 'ready' },
      });
      expect(ready.statusCode).toBe(200);
      const claimed = await app.inject({
        method: 'POST',
        url: `/v1/tasks/${task.id}/claim`,
        headers: auth,
        payload: { claimant: { user_id: world.memberUser, agent: null }, deviceId: d.deviceId },
      });
      expect(claimed.statusCode).toBe(200);
      expect((claimed.json() as { ok: boolean }).ok).toBe(true);

      await waitUntil(() => taskCache.getTask(task.id)?.state === 'claimed');
      const live = await app.inject({ method: 'GET', url: `/v1/tasks/${task.id}`, headers: auth });
      expect(taskCache.getTask(task.id)).toEqual((live.json() as { task: unknown }).task);
      expect(taskCache.isStale()).toBe(false);

      // A second claim loses deterministically and surfaces as a rejection.
      const loser = await app.inject({
        method: 'POST',
        url: `/v1/tasks/${task.id}/claim`,
        headers: auth,
        payload: {
          claimant: { user_id: makeId('user'), agent: null },
          deviceId: d.deviceId,
          provisional: true,
        },
      });
      expect((loser.json() as { ok: boolean }).ok).toBe(false);
      await waitUntil(() => taskCache.getClaimRejection(task.id) !== undefined);
      expect(taskCache.getClaimRejection(task.id)?.provisional).toBe(true);
      expect(taskCache.getClaimRejection(task.id)?.winner_claimant).toMatchObject({
        user_id: world.memberUser,
      });
    } finally {
      await client.stop();
    }
  }, 20_000);
});

describe('daemon↔server sync performance (real Postgres 16)', () => {
  it('propagates coordination to the enforcement cache within 1s p95', async () => {
    const d = await freshDaemon();
    const s = makeShipper(d);
    const cache = new EnforcementCache();
    const client = new CoordinationClient({
      baseUrl,
      token: d.token,
      projectId: d.projectId,
      cache,
      store: d.store,
      reconnectMs: 50,
      maxReconnectMs: 200,
    });
    client.start();
    const samples: number[] = [];
    try {
      // Warmup establishes the SSE link and cursor before timing steady-state.
      d.store.insertEvents(
        [
          ev(d.src, 'reservation.acquired', {
            path_glob: 'warm/**',
            mode: 'soft',
            holder_task_id: 'task_owner',
          }),
        ],
        true,
      );
      await s.drain();
      await waitUntil(() => cache.getCursor() >= 1);
      for (let i = 0; i < 12; i++) {
        const before = cache.getCursor();
        const t0 = performance.now();
        d.store.insertEvents(
          [
            ev(d.src, 'reservation.acquired', {
              path_glob: `p${i}/**`,
              mode: 'hard',
              holder_task_id: 'task_owner',
            }),
          ],
          true,
        );
        await s.drain();
        await waitUntil(() => cache.getCursor() > before, 5000);
        samples.push(performance.now() - t0);
        expect(cache.checkReservation(`p${i}/a.ts`, 'task_other')).toBe('blocked');
      }
      const sorted = [...samples].sort((a, b) => a - b);
      const p95 = sorted[
        Math.min(sorted.length - 1, Math.floor(0.95 * (sorted.length - 1)))
      ] as number;
      expect(p95).toBeLessThanOrEqual(1000);
    } finally {
      await client.stop();
      await s.stop();
    }
  }, 30_000);

  it('drains a 10k-event outbox after reconnect within 10s with zero loss or duplication', async () => {
    const d = await freshDaemon();
    const g = gate();
    const s = new OutboxShipper({
      baseUrl,
      token: d.token,
      store: d.store,
      fetchImpl: g.impl,
      batchSize: 500,
      intervalMs: 60_000,
      backoffMs: 1,
      maxBackoffMs: 5,
    });
    const batch = Array.from({ length: 10_000 }, () =>
      ev(d.src, 'tool.post', { tool_name: 'Read', success: true }),
    );
    d.store.insertEvents(batch, true);
    expect(d.store.pendingOutboxCount()).toBe(10_000);
    // Partition: nothing ships, everything stays durable.
    g.setDown(true);
    const failed = await s.drain();
    expect(failed.error).toBeDefined();
    expect(d.store.pendingOutboxCount()).toBe(10_000);
    expect(await countEvents(d.projectId)).toBe(0);
    // Heal: the full backlog drains within the 10s SLO, exactly once.
    g.setDown(false);
    const t0 = performance.now();
    const ok = await s.drain();
    const elapsed = performance.now() - t0;
    expect(ok.shipped).toBe(10_000);
    expect(d.store.pendingOutboxCount()).toBe(0);
    expect(await countEvents(d.projectId)).toBe(10_000);
    console.log(`  outbox drain 10k events in ${elapsed.toFixed(0)}ms`);
    expect(elapsed).toBeLessThanOrEqual(10_000);
    // Acknowledged replays stay acknowledged; the durable outbox is not refilled.
    d.store.insertEvents(batch, true);
    const replay = await s.drain();
    expect(replay.duplicates).toBe(0);
    expect(d.store.pendingOutboxCount()).toBe(0);
    expect(await countEvents(d.projectId)).toBe(10_000);
    await s.stop();
  }, 60_000);
});
