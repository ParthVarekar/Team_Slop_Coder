import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { performance } from 'node:perf_hooks';
import { makeId, type Actor } from '@weft/protocol';
import { openCentralDatabase, type CentralDatabase } from './db.js';
import { TaskService, TaskError, type Origin } from './tasks-service.js';
import { startEmbeddedPostgres, type EmbeddedCluster } from '../test/embedded.js';
import { seedWorld, type World } from '../test/identity.js';

let cluster: EmbeddedCluster;
let db: CentralDatabase;
let service: TaskService;
let world: World;
let origin: Origin;

beforeAll(async () => {
  cluster = await startEmbeddedPostgres();
  db = await openCentralDatabase(cluster.databaseUrl);
  world = await seedWorld(db.pool);
  service = new TaskService(db.pool);
  origin = { actor: { user_id: world.memberUser, agent: null }, deviceId: world.deviceId };
}, 120_000);

afterAll(async () => {
  await db?.close();
  await cluster?.stop();
});

function claimant(): { actor: Actor; deviceId: string } {
  return { actor: { user_id: makeId('user'), agent: null }, deviceId: makeId('device') };
}

async function readyTask(title = 'Task'): Promise<{ id: string; version: number }> {
  const t = await service.create(world.projectA, { title }, origin);
  const r = await service.transition(t.id, world.projectA, 0, 'ready', undefined, origin);
  return { id: r.id, version: r.version };
}

describe('server-authoritative tasks (real Postgres 16)', () => {
  it('creates with sequential numbers, version 0, and a deterministic fold', async () => {
    const a = await service.create(world.projectA, { title: 'A', priority: 'P1' }, origin);
    const b = await service.create(world.projectA, { title: 'B' }, origin);
    expect(a.version).toBe(0);
    expect(a.state).toBe('backlog');
    expect(b.number).toBe(a.number + 1);
    const rebuilt = await service.rebuildSnapshot(a.id, world.projectA);
    expect(rebuilt).toEqual(a);
  });

  it('rejects a transition with a stale base version (CAS)', async () => {
    const t = await service.create(world.projectA, { title: 'CAS' }, origin);
    await service.transition(t.id, world.projectA, 0, 'ready', undefined, origin);
    await expect(
      service.transition(t.id, world.projectA, 0, 'claimed', undefined, origin),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('rejects an illegal lifecycle edge', async () => {
    const t = await service.create(world.projectA, { title: 'Illegal' }, origin);
    await expect(
      service.transition(t.id, world.projectA, 0, 'completed', undefined, origin),
    ).rejects.toMatchObject({ code: 'invalid_transition' });
  });

  it('commutes disjoint field edits from the same stale base', async () => {
    const t = await service.create(
      world.projectA,
      { title: 'original', description: 'd0' },
      origin,
    );
    const a = await service.update(t.id, world.projectA, 0, { title: 'A-title' }, origin);
    const b = await service.update(t.id, world.projectA, 0, { description: 'B-desc' }, origin);
    expect(a.version).toBe(1);
    expect(b.version).toBe(2);
    expect(b.title).toBe('A-title');
    expect(b.description).toBe('B-desc');
    expect(b.edit_conflict).toBeNull();
    expect(await service.rebuildSnapshot(t.id, world.projectA)).toEqual(b);
  });

  it('records edit_conflict on same-field same-base edits without silent loss', async () => {
    const t = await service.create(world.projectA, { title: 'original' }, origin);
    await service.update(t.id, world.projectA, 0, { title: 'A' }, origin);
    const b = await service.update(t.id, world.projectA, 0, { title: 'B' }, origin);
    expect(b.version).toBe(2);
    expect(b.title).toBe('A'); // winner's value preserved, not overwritten
    expect(b.edit_conflict).not.toBeNull();
    expect(b.edit_conflict?.title).toMatchObject({ current: 'A', incoming: 'B', base_version: 0 });
    expect(await service.rebuildSnapshot(t.id, world.projectA)).toEqual(b);
  });

  it('applies non-conflicting fields while preserving a conflict', async () => {
    const t = await service.create(world.projectA, { title: 'original', priority: 'P2' }, origin);
    await service.update(t.id, world.projectA, 0, { title: 'A' }, origin);
    const b = await service.update(t.id, world.projectA, 0, { title: 'B', priority: 'P0' }, origin);
    expect(b.title).toBe('A');
    expect(b.priority).toBe('P0'); // disjoint field commutes
    expect(b.edit_conflict?.title).toMatchObject({ incoming: 'B' });
  });

  it('resolves an edit conflict with a chosen value and clears it', async () => {
    const t = await service.create(world.projectA, { title: 'original' }, origin);
    await service.update(t.id, world.projectA, 0, { title: 'A' }, origin);
    const conflicted = await service.update(t.id, world.projectA, 0, { title: 'B' }, origin);
    const resolved = await service.resolveEditConflict(
      t.id,
      world.projectA,
      conflicted.version,
      { title: 'merged' },
      origin,
    );
    expect(resolved.title).toBe('merged');
    expect(resolved.edit_conflict).toBeNull();
    expect(await service.rebuildSnapshot(t.id, world.projectA)).toEqual(resolved);
  });

  it('grants exactly one winner under concurrent claims (atomic CAS)', async () => {
    const { id } = await readyTask('Race');
    const contenders = Array.from({ length: 6 }, () => claimant());
    const results = await Promise.all(
      contenders.map((c) =>
        service.claim(id, world.projectA, { claimant: c.actor, deviceId: c.deviceId }, origin),
      ),
    );
    const winners = results.filter((r) => r.ok);
    expect(winners).toHaveLength(1);
    const winner = winners[0];
    if (!winner?.ok) throw new Error('expected a winner');
    expect(winner.snapshot.state).toBe('claimed');
    const losers = results.filter((r) => !r.ok);
    expect(losers).toHaveLength(5);
    for (const loser of losers) {
      if (loser.ok) continue;
      expect(loser.reason).toContain('claimed');
      expect(loser.winner_claimant).not.toBeNull();
    }
    const final = await service.get(id, world.projectA);
    expect(final?.state).toBe('claimed');
    expect(final?.version).toBe(2);
  });

  it('rejects a claim when the task is not ready', async () => {
    const t = await service.create(world.projectA, { title: 'Backlog' }, origin);
    const c = claimant();
    const res = await service.claim(
      t.id,
      world.projectA,
      { claimant: c.actor, deviceId: c.deviceId },
      origin,
    );
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('expected rejection');
    expect(res.reason).toContain('backlog');
    expect((await service.get(t.id, world.projectA))?.state).toBe('backlog');
  });

  it('deterministically rejects a losing offline provisional claim', async () => {
    const { id } = await readyTask('Offline race');
    const a = claimant();
    const b = claimant();
    const first = await service.claim(
      id,
      world.projectA,
      { claimant: a.actor, deviceId: a.deviceId, provisional: true },
      origin,
    );
    const second = await service.claim(
      id,
      world.projectA,
      { claimant: b.actor, deviceId: b.deviceId, provisional: true },
      origin,
    );
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('expected first to win');
    expect(first.provisional).toBe(true);
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error('expected second to lose');
    expect(second.winner_claimant).toMatchObject({
      user_id: (a.actor as { user_id: string }).user_id,
    });
    const rejection = await db.pool.query(
      `SELECT payload FROM coordination_events WHERE task_id=$1 AND type='task.claim_rejected'`,
      [id],
    );
    expect(rejection.rows).toHaveLength(1);
    expect(rejection.rows[0].payload.provisional).toBe(true);
    expect(rejection.rows[0].payload.device_id).toBe(b.deviceId);
  });

  it('release returns a claimed task to ready so it can be re-claimed', async () => {
    const { id, version } = await readyTask('Release');
    const c = claimant();
    const claimed = await service.claim(
      id,
      world.projectA,
      { claimant: c.actor, deviceId: c.deviceId },
      origin,
    );
    if (!claimed.ok) throw new Error('expected claim');
    const released = await service.release(id, world.projectA, claimed.snapshot.version, origin);
    expect(released.state).toBe('ready');
    const again = await service.claim(id, world.projectA, claimant(), origin);
    expect(again.ok).toBe(true);
    expect(version).toBe(1);
  });

  it('rejects dependency cycles and self-dependencies (DAG)', async () => {
    const a = await service.create(world.projectA, { title: 'A' }, origin);
    const b = await service.create(world.projectA, { title: 'B' }, origin);
    const c = await service.create(world.projectA, { title: 'C' }, origin);
    await service.addDependency(b.id, world.projectA, a.id, origin);
    await service.addDependency(c.id, world.projectA, b.id, origin);
    await expect(service.addDependency(a.id, world.projectA, c.id, origin)).rejects.toMatchObject({
      code: 'cycle',
    });
    await expect(service.addDependency(a.id, world.projectA, a.id, origin)).rejects.toMatchObject({
      code: 'cycle',
    });
    expect(await service.listDependencies(c.id, world.projectA)).toEqual([b.id]);
  });

  it('computes READY from dependency satisfaction and promotes on completion', async () => {
    const a = await service.create(world.projectA, { title: 'Dep-A' }, origin);
    const b = await service.create(world.projectA, { title: 'Dep-B' }, origin);
    await service.addDependency(b.id, world.projectA, a.id, origin);
    const promoted = await service.computeReady(world.projectA, origin);
    expect(promoted.some((t) => t.id === a.id && t.state === 'ready')).toBe(true);
    expect((await service.get(b.id, world.projectA))?.state).toBe('backlog');

    // Walk A to completed; B should auto-promote to ready.
    const ver = (await service.get(a.id, world.projectA))?.version ?? 0;
    const claimed = await service.claim(a.id, world.projectA, claimant(), origin);
    if (!claimed.ok) throw new Error('expected claim');
    // COMPLETED requires passing evidence: seed a self-validation run for A.
    await db.pool.query(
      `INSERT INTO validation_runs (id, project_id, repo_id, task_id, trigger, state, independence)
       VALUES ($1,$2,$3,$4,'task','passed','self')`,
      [makeId('validation'), world.projectA, makeId('repo'), a.id],
    );
    let v = claimed.snapshot.version;
    for (const to of ['in_progress', 'review', 'validation', 'completed'] as const) {
      const next = await service.transition(a.id, world.projectA, v, to, undefined, origin);
      v = next.version;
    }
    expect(ver).toBeGreaterThanOrEqual(1);
    expect((await service.get(b.id, world.projectA))?.state).toBe('ready');
  });

  it('demotes a ready task when an incomplete dependency is added', async () => {
    const a = await service.create(world.projectA, { title: 'Blocker' }, origin);
    const b = await service.create(world.projectA, { title: 'Dependent' }, origin);
    await service.computeReady(world.projectA, origin);
    expect((await service.get(b.id, world.projectA))?.state).toBe('ready');
    await service.addDependency(b.id, world.projectA, a.id, origin);
    expect((await service.get(b.id, world.projectA))?.state).toBe('backlog');
  });

  it('emits durable coordination events with contiguous global_seq', async () => {
    const t = await service.create(world.projectA, { title: 'Stream' }, origin);
    await service.transition(t.id, world.projectA, 0, 'ready', undefined, origin);
    await service.claim(t.id, world.projectA, claimant(), origin);
    const rows = await db.pool.query(
      `SELECT type, global_seq, payload FROM coordination_events WHERE task_id=$1 ORDER BY global_seq`,
      [t.id],
    );
    expect(rows.rows.map((r) => r.type)).toEqual([
      'task.created',
      'task.state_changed',
      'task.claimed',
    ]);
    const seqs = rows.rows.map((r) => Number(r.global_seq));
    expect(seqs).toEqual([seqs[0], seqs[0] + 1, seqs[0] + 2]);
    expect(rows.rows[2].payload.claimant).toBeTruthy();
    expect(rows.rows[2].payload.device_id).toBeTruthy();
  });

  it('isolates tasks per project', async () => {
    const t = await service.create(world.projectA, { title: 'Scoped' }, origin);
    expect(await service.get(t.id, world.projectB)).toBeUndefined();
    await expect(service.claim(t.id, world.projectB, claimant(), origin)).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(service.rebuildSnapshot(t.id, world.projectB)).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('rebuild equals the live snapshot after a mixed mutation sequence', async () => {
    const t = await service.create(world.projectA, { title: 'Mixed', description: 'd' }, origin);
    await service.update(t.id, world.projectA, 0, { priority: 'P0' }, origin);
    await service.transition(t.id, world.projectA, 1, 'ready', undefined, origin);
    const c = await service.claim(t.id, world.projectA, claimant(), origin);
    if (!c.ok) throw new Error('expected claim');
    await service.update(t.id, world.projectA, c.snapshot.version, { description: 'd2' }, origin);
    await service.release(t.id, world.projectA, c.snapshot.version + 1, origin);
    const live = await service.get(t.id, world.projectA);
    const rebuilt = await service.rebuildSnapshot(t.id, world.projectA);
    expect(rebuilt).toEqual(live);
    expect(rebuilt?.state).toBe('ready');
  });

  it('validates input and reports a TaskError', async () => {
    await expect(service.create(world.projectA, { title: '' }, origin)).rejects.toBeInstanceOf(
      TaskError,
    );
    await expect(
      service.update(makeId('task'), world.projectA, 0, { title: 'x' }, origin),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('task claim CAS performance (real Postgres 16)', () => {
  it('keeps claim CAS p95 <= 20ms across many ready tasks', async () => {
    const samples: number[] = [];
    const claimOne = async (): Promise<void> => {
      const { id } = await readyTask('Perf');
      const c = claimant();
      const t0 = performance.now();
      const res = await service.claim(
        id,
        world.projectA,
        { claimant: c.actor, deviceId: c.deviceId },
        origin,
      );
      samples.push(performance.now() - t0);
      expect(res.ok).toBe(true);
    };
    // Warmup absorbs JIT + PG plan-cache cost; only steady-state claims count.
    for (let i = 0; i < 8; i++) await claimOne();
    samples.length = 0;
    for (let i = 0; i < 60; i++) await claimOne();
    const sorted = [...samples].sort((a, b) => a - b);
    const p95 = sorted[
      Math.min(sorted.length - 1, Math.floor(0.95 * (sorted.length - 1)))
    ] as number;
    expect(p95).toBeLessThanOrEqual(20);
  }, 30_000);
});
