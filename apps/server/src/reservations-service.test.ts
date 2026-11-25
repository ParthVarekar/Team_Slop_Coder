import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeId } from '@weft/protocol';
import { openCentralDatabase, type CentralDatabase } from './db.js';
import {
  ReservationService,
  ReservationError,
  type AcquireReservationInput,
} from './reservations-service.js';
import type { Origin } from './tasks-service.js';
import { startEmbeddedPostgres, type EmbeddedCluster } from '../test/embedded.js';
import { seedWorld, type World } from '../test/identity.js';

let cluster: EmbeddedCluster;
let db: CentralDatabase;
let reservations: ReservationService;
let world: World;
let origin: Origin;
const serverDeviceId = makeId('device');
const GRACE_MS = 400;

beforeAll(async () => {
  cluster = await startEmbeddedPostgres();
  db = await openCentralDatabase(cluster.databaseUrl);
  world = await seedWorld(db.pool);
  reservations = new ReservationService(db.pool, serverDeviceId, undefined, GRACE_MS);
  origin = { actor: { user_id: world.memberUser, agent: null }, deviceId: world.deviceId };
}, 120_000);

afterAll(async () => {
  await db?.close();
  await cluster?.stop();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function input(
  taskId: string,
  repoId: string,
  glob: string,
  extra: Partial<AcquireReservationInput> = {},
): AcquireReservationInput {
  return { repo_id: repoId, task_id: taskId, path_glob: glob, ...extra };
}

async function eventCount(type: string, repoId: string): Promise<number> {
  const r = await db.pool.query(
    `SELECT COUNT(*)::int AS c FROM coordination_events
       WHERE project_id=$1 AND device_id=$2 AND type=$3 AND repo_id=$4`,
    [world.projectA, serverDeviceId, type, repoId],
  );
  return Number(r.rows[0]?.c ?? 0);
}

async function auditCount(action: string, subject: string): Promise<number> {
  const r = await db.pool.query(
    `SELECT COUNT(*)::int AS c FROM audit_records
       WHERE project_id=$1 AND action=$2 AND subject=$3`,
    [world.projectA, action, subject],
  );
  return Number(r.rows[0]?.c ?? 0);
}

async function activeLeases(repoId: string, glob: string): Promise<number> {
  const r = await db.pool.query(
    `SELECT COUNT(*)::int AS c FROM file_reservations
       WHERE project_id=$1 AND repo_id=$2 AND path_glob=$3 AND state='active'`,
    [world.projectA, repoId, glob],
  );
  return Number(r.rows[0]?.c ?? 0);
}

describe('ReservationService leases', () => {
  it('acquires a lease, emits reservation.acquired + audit, and renews in place on holder re-acquire', async () => {
    const repo = makeId('repo');
    const task = makeId('task');
    const glob = 'src/a.ts';
    const res = await reservations.acquire(
      world.projectA,
      input(task, repo, glob, { mode: 'hard', ttl_ms: 60_000 }),
      origin,
    );
    expect(res.status).toBe('acquired');
    expect(res.reservation.mode).toBe('hard');
    expect(res.reservation.state).toBe('active');
    expect(res.reservation.lease_epoch).toBe(1);
    expect(res.reservation.holder_device_id).toBe(world.deviceId);
    expect(res.reservation.task_id).toBe(task);
    expect(res.reservation.expires_at).not.toBeNull();
    expect(res.reservation.grace_until).not.toBeNull();
    expect(Date.parse(res.reservation.grace_until!)).toBeGreaterThan(
      Date.parse(res.reservation.expires_at!),
    );

    expect(await eventCount('reservation.acquired', repo)).toBe(1);
    expect(await auditCount('reservation.acquired', `reservation:${res.reservation.id}`)).toBe(1);

    const payload = await db.pool.query(
      `SELECT payload FROM coordination_events
         WHERE project_id=$1 AND repo_id=$2 AND type='reservation.acquired'`,
      [world.projectA, repo],
    );
    const p = payload.rows[0]?.payload as Record<string, unknown>;
    expect(p.mode).toBe('hard');
    expect(p.path_glob).toBe(glob);
    expect(p.holder_task_id).toBe(task);
    expect(p.lease_epoch).toBe(1);

    // Holder re-acquiring its own glob extends in place (idempotent renew).
    const again = await reservations.acquire(
      world.projectA,
      input(task, repo, glob, { mode: 'hard', ttl_ms: 60_000 }),
      origin,
    );
    expect(again.status).toBe('renewed');
    expect(again.reservation.id).toBe(res.reservation.id);
    expect(again.reservation.lease_epoch).toBe(2);
    expect(await eventCount('reservation.renewed', repo)).toBe(1);
    expect(await activeLeases(repo, glob)).toBe(1);
  });

  it('denies a competing task while active AND through the expiry grace (no mid-edit steal)', async () => {
    const repo = makeId('repo');
    const holder = makeId('task');
    const rival = makeId('task');
    const glob = 'src/locked.ts';
    // expires_at = now+100, grace_until = now+500.
    const held = await reservations.acquire(
      world.projectA,
      input(holder, repo, glob, { mode: 'hard', ttl_ms: 100 }),
      origin,
    );
    expect(held.status).toBe('acquired');

    const immediate = await reservations.acquire(
      world.projectA,
      input(rival, repo, glob, { mode: 'hard' }),
      origin,
    );
    expect(immediate.status).toBe('denied');
    expect(immediate.reason).toBe('held');
    expect(immediate.reservation.id).toBe(held.reservation.id);

    // Past expires_at but inside grace: the lock must STILL block the rival.
    await sleep(200);
    const inGrace = await reservations.acquire(
      world.projectA,
      input(rival, repo, glob, { mode: 'hard' }),
      origin,
    );
    expect(inGrace.status).toBe('denied');
    const still = await reservations.get(world.projectA, held.reservation.id);
    expect(still?.state).toBe('active');
    expect(await eventCount('reservation.denied', repo)).toBe(2);
    expect(await activeLeases(repo, glob)).toBe(1);
  });

  it('reclaims a lease lapsed past grace; the holder cannot renew past grace', async () => {
    const repo = makeId('repo');
    const holder = makeId('task');
    const rival = makeId('task');
    const glob = 'src/lapsed.ts';
    // expires_at = now+50, grace_until = now+450.
    const held = await reservations.acquire(
      world.projectA,
      input(holder, repo, glob, { mode: 'hard', ttl_ms: 50 }),
      origin,
    );
    await sleep(600); // past grace

    await expect(
      reservations.renew(world.projectA, held.reservation.id, holder, origin, 60_000),
    ).rejects.toMatchObject({ code: 'invalid_transition' });

    const reclaimed = await reservations.acquire(
      world.projectA,
      input(rival, repo, glob, { mode: 'hard' }),
      origin,
    );
    expect(reclaimed.status).toBe('acquired');
    expect(reclaimed.reservation.id).not.toBe(held.reservation.id);
    const old = await reservations.get(world.projectA, held.reservation.id);
    expect(old?.state).toBe('released');
    expect(old?.released_reason).toBe('expired');
    expect(await eventCount('reservation.released', repo)).toBeGreaterThanOrEqual(1);
    expect(await activeLeases(repo, glob)).toBe(1);
  });

  it('holder renew within grace extends the lease and bumps the epoch', async () => {
    const repo = makeId('repo');
    const holder = makeId('task');
    const rival = makeId('task');
    const glob = 'src/renew.ts';
    const held = await reservations.acquire(
      world.projectA,
      input(holder, repo, glob, { mode: 'hard', ttl_ms: 100 }),
      origin,
    );
    await sleep(200); // inside grace (expires 100, grace 500)
    const renewed = await reservations.renew(
      world.projectA,
      held.reservation.id,
      holder,
      origin,
      100,
    );
    expect(renewed.state).toBe('active');
    expect(renewed.lease_epoch).toBe(2);
    expect(Date.parse(renewed.expires_at!)).toBeGreaterThan(
      Date.parse(held.reservation.expires_at!),
    );
    expect(await eventCount('reservation.renewed', repo)).toBe(1);

    const rivalRes = await reservations.acquire(
      world.projectA,
      input(rival, repo, glob, { mode: 'hard' }),
      origin,
    );
    expect(rivalRes.status).toBe('denied');
  });

  it('concurrent acquires of one glob yield exactly one winner (CAS race)', async () => {
    const repo = makeId('repo');
    const glob = 'src/race.ts';
    const tasks = Array.from({ length: 8 }, () => makeId('task'));
    const results = await Promise.all(
      tasks.map((t) =>
        reservations.acquire(
          world.projectA,
          input(t, repo, glob, { mode: 'hard', ttl_ms: 60_000 }),
          origin,
        ),
      ),
    );
    const winners = results.filter((r) => r.status === 'acquired');
    const losers = results.filter((r) => r.status === 'denied');
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(7);
    expect(await activeLeases(repo, glob)).toBe(1);
    expect(await eventCount('reservation.acquired', repo)).toBe(1);
    expect(await eventCount('reservation.denied', repo)).toBe(7);
  });

  it('release is holder-only and idempotent; a released glob is re-acquirable', async () => {
    const repo = makeId('repo');
    const holder = makeId('task');
    const rival = makeId('task');
    const glob = 'src/release.ts';
    const held = await reservations.acquire(
      world.projectA,
      input(holder, repo, glob, { ttl_ms: 60_000 }),
      origin,
    );

    await expect(
      reservations.release(world.projectA, held.reservation.id, rival, origin),
    ).rejects.toMatchObject({ code: 'forbidden' });

    const released = await reservations.release(
      world.projectA,
      held.reservation.id,
      holder,
      origin,
      'done',
    );
    expect(released.state).toBe('released');
    expect(released.released_reason).toBe('done');
    const again = await reservations.release(world.projectA, held.reservation.id, holder, origin);
    expect(again.state).toBe('released');
    expect(await eventCount('reservation.released', repo)).toBe(1); // idempotent: no second event

    const reacquired = await reservations.acquire(
      world.projectA,
      input(rival, repo, glob, { ttl_ms: 60_000 }),
      origin,
    );
    expect(reacquired.status).toBe('acquired');
    expect(reacquired.reservation.id).not.toBe(held.reservation.id);
  });

  it('renew by a non-holder is forbidden', async () => {
    const repo = makeId('repo');
    const holder = makeId('task');
    const rival = makeId('task');
    const held = await reservations.acquire(
      world.projectA,
      input(holder, repo, 'src/forbid.ts', { ttl_ms: 60_000 }),
      origin,
    );
    await expect(
      reservations.renew(world.projectA, held.reservation.id, rival, origin),
    ).rejects.toBeInstanceOf(ReservationError);
    await expect(
      reservations.renew(world.projectA, held.reservation.id, rival, origin),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('sweepExpired releases only leases lapsed past grace', async () => {
    const repo = makeId('repo');
    const shortTask = makeId('task');
    const longTask = makeId('task');
    const short = await reservations.acquire(
      world.projectA,
      input(shortTask, repo, 'src/short.ts', { ttl_ms: 50 }),
      origin,
    );
    const long = await reservations.acquire(
      world.projectA,
      input(longTask, repo, 'src/long.ts', { ttl_ms: 60_000 }),
      origin,
    );
    await sleep(600);
    const released = await reservations.sweepExpired(world.projectA);
    expect(released).toBeGreaterThanOrEqual(1);
    expect((await reservations.get(world.projectA, short.reservation.id))?.state).toBe('released');
    expect((await reservations.get(world.projectA, long.reservation.id))?.state).toBe('active');
  });

  it('project isolation: the same glob in two projects are independent leases', async () => {
    const repo = makeId('repo');
    const glob = 'src/shared.ts';
    const taskA = makeId('task');
    const taskB = makeId('task');
    const a = await reservations.acquire(
      world.projectA,
      input(taskA, repo, glob, { mode: 'hard', ttl_ms: 60_000 }),
      origin,
    );
    const b = await reservations.acquire(
      world.projectB,
      input(taskB, repo, glob, { mode: 'hard', ttl_ms: 60_000 }),
      origin,
    );
    expect(a.status).toBe('acquired');
    expect(b.status).toBe('acquired');
    expect(a.reservation.id).not.toBe(b.reservation.id);
    expect(a.reservation.project_id).toBe(world.projectA);
    expect(b.reservation.project_id).toBe(world.projectB);
  });

  it('defaults mode to soft and lists with state/repo/task filters', async () => {
    const repo = makeId('repo');
    const t1 = makeId('task');
    const t2 = makeId('task');
    const soft = await reservations.acquire(
      world.projectA,
      input(t1, repo, 'src/soft.ts', { ttl_ms: 60_000 }),
      origin,
    );
    expect(soft.reservation.mode).toBe('soft');
    const second = await reservations.acquire(
      world.projectA,
      input(t2, repo, 'src/other.ts', { ttl_ms: 60_000 }),
      origin,
    );
    await reservations.release(world.projectA, soft.reservation.id, t1, origin);

    const active = await reservations.list(world.projectA, { repoId: repo, state: 'active' });
    expect(active.map((r) => r.id)).toEqual([second.reservation.id]);
    const byTask = await reservations.list(world.projectA, { repoId: repo, taskId: t1 });
    expect(byTask.map((r) => r.id)).toEqual([soft.reservation.id]);
    const all = await reservations.list(world.projectA, { repoId: repo });
    expect(all).toHaveLength(2);
  });

  it('rejects an invalid acquire body', async () => {
    await expect(
      reservations.acquire(
        world.projectA,
        { repo_id: '', task_id: 't', path_glob: 'x' } as AcquireReservationInput,
        origin,
      ),
    ).rejects.toMatchObject({ code: 'validation' });
  });
});
