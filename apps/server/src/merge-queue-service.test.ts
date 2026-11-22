import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeId } from '@weft/protocol';
import { openCentralDatabase, type CentralDatabase } from './db.js';
import { MergeQueueService, MergeQueueError, type EnqueueMergeInput } from './merge-queue-service.js';
import { TaskService } from './tasks-service.js';
import type { Origin } from './tasks-service.js';
import { startEmbeddedPostgres, type EmbeddedCluster } from '../test/embedded.js';
import { seedWorld, type World } from '../test/identity.js';

let cluster: EmbeddedCluster;
let db: CentralDatabase;
let queue: MergeQueueService;
let tasks: TaskService;
let world: World;
let origin: Origin;
const serverDeviceId = makeId('device');
const GRACE_MS = 400;

const TREE = '1'.repeat(40);
const WRONG_TREE = '2'.repeat(40);
const BASE = '3'.repeat(40);
const PRECONDITION = '4'.repeat(40);
const MERGED = '5'.repeat(40);

beforeAll(async () => {
  cluster = await startEmbeddedPostgres();
  db = await openCentralDatabase(cluster.databaseUrl);
  world = await seedWorld(db.pool);
  queue = new MergeQueueService(db.pool, serverDeviceId, undefined, GRACE_MS);
  tasks = new TaskService(db.pool);
  origin = { actor: { user_id: world.memberUser, agent: null }, deviceId: world.deviceId };
}, 120_000);

afterAll(async () => {
  await db?.close();
  await cluster?.stop();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function makeTask(repoId: string): Promise<string> {
  const snap = await tasks.create(world.projectA, { title: 'merge work', repoId, state: 'ready' }, origin);
  return snap.id;
}

function enqueueInput(taskId: string, repoId: string, extra: Partial<EnqueueMergeInput> = {}): EnqueueMergeInput {
  return { repo_id: repoId, task_id: taskId, branch: `weft/${taskId}`, ...extra };
}

async function insertRun(opts: {
  repoId: string;
  taskId: string;
  treeOid: string;
  state: string;
  independence: string;
  runner: string;
  claimant: string;
}): Promise<string> {
  const id = makeId('validation');
  await db.pool.query(
    `INSERT INTO validation_runs
       (id, project_id, repo_id, task_id, trigger, tree_oid, state, independence,
        runner_device_id, claimant_device_id, finished_at)
     VALUES ($1,$2,$3,$4,'queue',$5,$6,$7,$8,$9, now())`,
    [id, world.projectA, opts.repoId, opts.taskId, opts.treeOid, opts.state, opts.independence, opts.runner, opts.claimant],
  );
  return id;
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

/** Drive an entry to testing under a fresh lease held by `device`, returning the epoch. */
async function claimHead(repoId: string, taskId: string, device: string): Promise<{ entryId: string; epoch: number }> {
  const lease = await queue.acquireExecutorLease(world.projectA, repoId, device, origin, 60_000);
  await queue.enqueue(world.projectA, enqueueInput(taskId, repoId), origin);
  const claimed = await queue.claimNext(world.projectA, repoId, device, lease.lease.lease_epoch, origin);
  if (!claimed) throw new Error('expected a claimable head');
  return { entryId: claimed.id, epoch: lease.lease.lease_epoch };
}

describe('MergeQueueService executor lease election', () => {
  it('concurrent acquires of one repo yield exactly one executor (CAS race)', async () => {
    const repo = makeId('repo');
    const devices = Array.from({ length: 8 }, () => makeId('device'));
    const results = await Promise.all(
      devices.map((d) => queue.acquireExecutorLease(world.projectA, repo, d, origin, 60_000)),
    );
    const winners = results.filter((r) => r.status === 'acquired');
    const losers = results.filter((r) => r.status === 'denied');
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(7);
    expect(losers.every((r) => r.reason === 'held')).toBe(true);
    const lease = await queue.getExecutorLease(world.projectA, repo);
    expect(lease?.state).toBe('held');
    expect(lease?.lease_epoch).toBe(1);
    expect(lease?.holder_device_id).toBe(winners[0]?.lease.holder_device_id);
    expect(await auditCount('merge.lease_acquired', `merge:${repo}`)).toBe(1);
  });

  it('holder re-acquire renews in place (epoch bumps); a rival is denied while held', async () => {
    const repo = makeId('repo');
    const holder = makeId('device');
    const rival = makeId('device');
    const first = await queue.acquireExecutorLease(world.projectA, repo, holder, origin, 60_000);
    expect(first.status).toBe('acquired');
    const again = await queue.acquireExecutorLease(world.projectA, repo, holder, origin, 60_000);
    expect(again.status).toBe('renewed');
    expect(again.lease.lease_epoch).toBe(2);
    const denied = await queue.acquireExecutorLease(world.projectA, repo, rival, origin, 60_000);
    expect(denied.status).toBe('denied');
    expect(denied.lease.holder_device_id).toBe(holder);
  });

  it('release is holder-only; a released repo is re-acquirable by a successor', async () => {
    const repo = makeId('repo');
    const holder = makeId('device');
    const rival = makeId('device');
    await queue.acquireExecutorLease(world.projectA, repo, holder, origin, 60_000);
    await expect(
      queue.releaseExecutorLease(world.projectA, repo, rival, origin),
    ).rejects.toMatchObject({ code: 'forbidden' });
    const released = await queue.releaseExecutorLease(world.projectA, repo, holder, origin);
    expect(released.state).toBe('idle');
    expect(released.holder_device_id).toBeNull();
    const next = await queue.acquireExecutorLease(world.projectA, repo, rival, origin, 60_000);
    expect(next.status).toBe('acquired');
    expect(next.lease.holder_device_id).toBe(rival);
    expect(next.lease.lease_epoch).toBe(2);
  });

  it('a lease lapsed past grace is reclaimed by a new executor at a higher epoch', async () => {
    const repo = makeId('repo');
    const dead = makeId('device');
    const successor = makeId('device');
    // expires_at = now+100, grace_until = now+500.
    await queue.acquireExecutorLease(world.projectA, repo, dead, origin, 100);
    await sleep(600); // past grace
    const reclaimed = await queue.acquireExecutorLease(world.projectA, repo, successor, origin, 60_000);
    expect(reclaimed.status).toBe('acquired');
    expect(reclaimed.lease.holder_device_id).toBe(successor);
    expect(reclaimed.lease.lease_epoch).toBe(2);
    await expect(
      queue.renewExecutorLease(world.projectA, repo, dead, origin, 60_000),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('MergeQueueService queue lifecycle', () => {
  it('enqueue requires a real task, assigns tail position, emits merge.queued + audit', async () => {
    const repo = makeId('repo');
    await expect(
      queue.enqueue(world.projectA, enqueueInput(makeId('task'), repo), origin),
    ).rejects.toMatchObject({ code: 'not_found' });

    const t1 = await makeTask(repo);
    const t2 = await makeTask(repo);
    const e1 = await queue.enqueue(world.projectA, enqueueInput(t1, repo), origin);
    const e2 = await queue.enqueue(world.projectA, enqueueInput(t2, repo), origin);
    expect(e1.state).toBe('queued');
    expect(e1.position).toBe(1);
    expect(e2.position).toBe(2);
    expect(e1.target_branch).toBe('main');
    expect(await eventCount('merge.queued', repo)).toBe(2);
    expect(await auditCount('merge.queued', `merge:${e1.id}`)).toBe(1);
    const listed = await queue.list(world.projectA, { repoId: repo, state: 'queued' });
    expect(listed.map((e) => e.id)).toEqual([e1.id, e2.id]);
  });

  it('claimNext requires the lease and fences the head under the holder epoch', async () => {
    const repo = makeId('repo');
    const device = makeId('device');
    const task = await makeTask(repo);
    await queue.enqueue(world.projectA, enqueueInput(task, repo), origin);
    // No lease held yet.
    await expect(
      queue.claimNext(world.projectA, repo, device, 1, origin),
    ).rejects.toMatchObject({ code: 'lease_required' });

    const lease = await queue.acquireExecutorLease(world.projectA, repo, device, origin, 60_000);
    const claimed = await queue.claimNext(world.projectA, repo, device, lease.lease.lease_epoch, origin);
    expect(claimed?.state).toBe('testing');
    expect(claimed?.executor_device_id).toBe(device);
    expect(claimed?.lease_epoch).toBe(lease.lease.lease_epoch);
    expect(await eventCount('merge.testing', repo)).toBe(1);
    // Head consumed: nothing left to claim.
    const empty = await queue.claimNext(world.projectA, repo, device, lease.lease.lease_epoch, origin);
    expect(empty).toBeNull();
  });

  it('recordSpeculativeTree + attachValidation reject a stale fencing epoch', async () => {
    const repo = makeId('repo');
    const device = makeId('device');
    const task = await makeTask(repo);
    const { entryId, epoch } = await claimHead(repo, task, device);
    await expect(
      queue.recordSpeculativeTree(
        world.projectA, entryId,
        { speculative_tree_oid: TREE, base_oid: BASE, push_precondition_oid: PRECONDITION },
        device, epoch + 99, origin,
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });

    const recorded = await queue.recordSpeculativeTree(
      world.projectA, entryId,
      { speculative_tree_oid: TREE, base_oid: BASE, push_precondition_oid: PRECONDITION },
      device, epoch, origin,
    );
    expect(recorded.speculative_tree_oid).toBe(TREE);
    expect(recorded.push_precondition_oid).toBe(PRECONDITION);

    const runId = await insertRun({
      repoId: repo, taskId: task, treeOid: TREE, state: 'passed',
      independence: 'independent', runner: makeId('device'), claimant: device,
    });
    const attached = await queue.attachValidation(world.projectA, entryId, runId, device, epoch, origin);
    expect(attached.validation_run_id).toBe(runId);
    await expect(
      queue.attachValidation(world.projectA, entryId, makeId('validation'), device, epoch, origin),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('MergeQueueService never-merge-unvalidated gate', () => {
  it('advance only lands a passing INDEPENDENT run for the exact speculative tree', async () => {
    const repo = makeId('repo');
    const claimant = makeId('device');
    const runner = makeId('device');
    const task = await makeTask(repo);
    const { entryId, epoch } = await claimHead(repo, task, claimant);
    await queue.recordSpeculativeTree(
      world.projectA, entryId,
      { speculative_tree_oid: TREE, base_oid: BASE, push_precondition_oid: PRECONDITION },
      claimant, epoch, origin,
    );

    // 1. No validation attached at all.
    await expect(
      queue.advance(world.projectA, entryId, MERGED, claimant, epoch, origin),
    ).rejects.toMatchObject({ code: 'evidence_required' });

    // 2. A FAILED independent run for the exact tree.
    const failed = await insertRun({
      repoId: repo, taskId: task, treeOid: TREE, state: 'failed',
      independence: 'independent', runner, claimant,
    });
    await queue.attachValidation(world.projectA, entryId, failed, claimant, epoch, origin);
    await expect(
      queue.advance(world.projectA, entryId, MERGED, claimant, epoch, origin),
    ).rejects.toMatchObject({ code: 'evidence_required' });

    // 3. A PASSED independent run for the WRONG tree.
    const wrongTree = await insertRun({
      repoId: repo, taskId: task, treeOid: WRONG_TREE, state: 'passed',
      independence: 'independent', runner, claimant,
    });
    await queue.attachValidation(world.projectA, entryId, wrongTree, claimant, epoch, origin);
    await expect(
      queue.advance(world.projectA, entryId, MERGED, claimant, epoch, origin),
    ).rejects.toMatchObject({ code: 'evidence_required' });

    // 4. A PASSED but SELF run (runner == claimant) for the exact tree.
    const self = await insertRun({
      repoId: repo, taskId: task, treeOid: TREE, state: 'passed',
      independence: 'self', runner: claimant, claimant,
    });
    await queue.attachValidation(world.projectA, entryId, self, claimant, epoch, origin);
    await expect(
      queue.advance(world.projectA, entryId, MERGED, claimant, epoch, origin),
    ).rejects.toMatchObject({ code: 'evidence_required' });
    expect((await queue.get(world.projectA, entryId))?.state).toBe('testing');
    expect(await eventCount('merge.merged', repo)).toBe(0);

    // 5. A PASSED INDEPENDENT run (runner != claimant) for the EXACT tree.
    const good = await insertRun({
      repoId: repo, taskId: task, treeOid: TREE, state: 'passed',
      independence: 'independent', runner, claimant,
    });
    await queue.attachValidation(world.projectA, entryId, good, claimant, epoch, origin);
    const landed = await queue.advance(world.projectA, entryId, MERGED, claimant, epoch, origin);
    expect(landed.state).toBe('merged');
    expect(landed.merged_oid).toBe(MERGED);
    expect(await eventCount('merge.merged', repo)).toBe(1);
    expect(await auditCount('merge.merged', `merge:${entryId}`)).toBe(1);
  });
});

describe('MergeQueueService executor failover', () => {
  it('a dead executor is fenced out; the successor re-claims and merges once (no double-merge)', async () => {
    const repo = makeId('repo');
    const dead = makeId('device');
    const successor = makeId('device');
    const task = await makeTask(repo);

    // Dead executor acquires a short lease and claims the head under epoch 1.
    const leaseA = await queue.acquireExecutorLease(world.projectA, repo, dead, origin, 100);
    const epochA = leaseA.lease.lease_epoch;
    const entry = await queue.enqueue(world.projectA, enqueueInput(task, repo), origin);
    const claimed = await queue.claimNext(world.projectA, repo, dead, epochA, origin);
    expect(claimed?.id).toBe(entry.id);
    await queue.recordSpeculativeTree(
      world.projectA, entry.id,
      { speculative_tree_oid: TREE, base_oid: BASE, push_precondition_oid: PRECONDITION },
      dead, epochA, origin,
    );

    // The executor dies; its lease lapses past grace.
    await sleep(600);
    const leaseB = await queue.acquireExecutorLease(world.projectA, repo, successor, origin, 60_000);
    const epochB = leaseB.lease.lease_epoch;
    expect(epochB).toBeGreaterThan(epochA);

    // A stale advance from the dead executor (old epoch) can never land the merge.
    await expect(
      queue.advance(world.projectA, entry.id, MERGED, dead, epochA, origin),
    ).rejects.toBeInstanceOf(MergeQueueError);
    expect((await queue.get(world.projectA, entry.id))?.state).toBe('testing');

    // The successor re-claims the orphaned testing entry under the new epoch.
    const recovered = await queue.claimNext(world.projectA, repo, successor, epochB, origin);
    expect(recovered?.id).toBe(entry.id);
    expect(recovered?.executor_device_id).toBe(successor);
    expect(recovered?.lease_epoch).toBe(epochB);
    // The speculative tree survived the failover (work preserved, re-read from origin).
    expect(recovered?.speculative_tree_oid).toBe(TREE);

    // Still fenced: the dead executor cannot advance even after recovery.
    await expect(
      queue.advance(world.projectA, entry.id, MERGED, dead, epochA, origin),
    ).rejects.toBeInstanceOf(MergeQueueError);

    const runId = await insertRun({
      repoId: repo, taskId: task, treeOid: TREE, state: 'passed',
      independence: 'independent', runner: successor, claimant: dead,
    });
    await queue.attachValidation(world.projectA, entry.id, runId, successor, epochB, origin);
    const landed = await queue.advance(world.projectA, entry.id, MERGED, successor, epochB, origin);
    expect(landed.state).toBe('merged');
    expect(await eventCount('merge.merged', repo)).toBe(1);

    // Idempotent: a duplicate report (successor retry) does not re-emit.
    const dup = await queue.advance(world.projectA, entry.id, MERGED, successor, epochB, origin);
    expect(dup.state).toBe('merged');
    expect(await eventCount('merge.merged', repo)).toBe(1);

    // A late stale report from the dead executor returns the merged entry without re-emitting.
    const late = await queue.advance(world.projectA, entry.id, MERGED, dead, epochA, origin);
    expect(late.state).toBe('merged');
    expect(await eventCount('merge.merged', repo)).toBe(1);
    expect(await auditCount('merge.merged', `merge:${entry.id}`)).toBe(1);
  });
});

describe('MergeQueueService eject + requeue', () => {
  it('an ejected entry requeues at the tail with a fresh attempt, work fields cleared', async () => {
    const repo = makeId('repo');
    const device = makeId('device');
    const t1 = await makeTask(repo);
    const t2 = await makeTask(repo);
    const e1 = await queue.enqueue(world.projectA, enqueueInput(t1, repo), origin);
    const e2 = await queue.enqueue(world.projectA, enqueueInput(t2, repo), origin);
    const lease = await queue.acquireExecutorLease(world.projectA, repo, device, origin, 60_000);
    const epoch = lease.lease.lease_epoch;
    await queue.claimNext(world.projectA, repo, device, epoch, origin);
    await queue.recordSpeculativeTree(
      world.projectA, e1.id,
      { speculative_tree_oid: TREE, base_oid: BASE, push_precondition_oid: PRECONDITION },
      device, epoch, origin,
    );

    const ejected = await queue.eject(world.projectA, e1.id, 'validation failed', device, epoch, origin);
    expect(ejected.state).toBe('ejected');
    expect(ejected.ejected_reason).toBe('validation failed');
    expect(await eventCount('merge.ejected', repo)).toBe(1);

    // A queued entry cannot be requeued.
    await expect(queue.requeue(world.projectA, e2.id, origin)).rejects.toMatchObject({ code: 'invalid_transition' });

    const requeued = await queue.requeue(world.projectA, e1.id, origin);
    expect(requeued.state).toBe('queued');
    expect(requeued.attempts).toBe(1);
    expect(requeued.position).toBeGreaterThan(e2.position); // tail
    expect(requeued.speculative_tree_oid).toBeNull();
    expect(requeued.validation_run_id).toBeNull();
    expect(requeued.executor_device_id).toBeNull();
    expect(requeued.lease_epoch).toBe(0);

    const order = await queue.list(world.projectA, { repoId: repo });
    expect(order.map((e) => e.id)).toEqual([e2.id, e1.id]);
    const payload = await db.pool.query(
      `SELECT payload FROM coordination_events
         WHERE project_id=$1 AND repo_id=$2 AND type='merge.queued'
         ORDER BY global_seq DESC LIMIT 1`,
      [world.projectA, repo],
    );
    const p = payload.rows[0]?.payload as Record<string, unknown>;
    expect(p.requeued).toBe(true);
    expect(p.attempts).toBe(1);
  });
});

describe('MergeQueueService project isolation', () => {
  it('the same repo in two projects has independent leases and queues', async () => {
    const repo = makeId('repo');
    const deviceA = makeId('device');
    const deviceB = makeId('device');
    const a = await queue.acquireExecutorLease(world.projectA, repo, deviceA, origin, 60_000);
    const b = await queue.acquireExecutorLease(world.projectB, repo, deviceB, origin, 60_000);
    expect(a.status).toBe('acquired');
    expect(b.status).toBe('acquired');
    expect(a.lease.holder_device_id).toBe(deviceA);
    expect(b.lease.holder_device_id).toBe(deviceB);
    expect(a.lease.project_id).toBe(world.projectA);
    expect(b.lease.project_id).toBe(world.projectB);
  });
});