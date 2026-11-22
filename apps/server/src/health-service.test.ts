import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeId } from '@weft/protocol';
import type { SuspectChange } from '@weft/core';
import { openCentralDatabase, type CentralDatabase } from './db.js';
import { HealthService, HealthError } from './health-service.js';
import type { Origin } from './tasks-service.js';
import { startEmbeddedPostgres, type EmbeddedCluster } from '../test/embedded.js';
import { seedWorld, type World } from '../test/identity.js';

let cluster: EmbeddedCluster;
let db: CentralDatabase;
let health: HealthService;
let world: World;
let origin: Origin;
const serverDeviceId = makeId('device');
const COMMIT = 'a'.repeat(40);

beforeAll(async () => {
  cluster = await startEmbeddedPostgres();
  db = await openCentralDatabase(cluster.databaseUrl);
  world = await seedWorld(db.pool);
  health = new HealthService(db.pool, serverDeviceId);
  origin = { actor: { user_id: world.memberUser, agent: null }, deviceId: world.deviceId };
}, 120_000);

afterAll(async () => {
  await db?.close();
  await cluster?.stop();
});

async function insertRun(repoId: string, state: string): Promise<string> {
  const id = makeId('validation');
  await db.pool.query(
    `INSERT INTO validation_runs (id, project_id, repo_id, trigger, state, finished_at)
     VALUES ($1,$2,$3,'baseline',$4, now())`,
    [id, world.projectA, repoId, state],
  );
  return id;
}

function change(oid: string, paths: string, minutes: number, taskId?: string): SuspectChange {
  return {
    oid,
    subject: `change ${oid.slice(0, 6)}`,
    author_name: 'dev',
    authored_at: new Date(Date.parse('2026-01-01T00:00:00Z') + minutes * 60_000).toISOString(),
    paths: paths.split(','),
    ...(taskId ? { task_id: taskId } : {}),
  };
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

async function baseline(repoId: string, extra: Record<string, unknown> = {}): Promise<string> {
  const b = await health.establishBaseline(
    world.projectA,
    { repo_id: repoId, branch: 'main', commit_oid: COMMIT, ...extra },
    origin,
  );
  return b.id;
}

describe('HealthService baselines', () => {
  it('establishes a healthy baseline, emits the event, and reads it back as latest', async () => {
    const repo = makeId('repo');
    const id = await baseline(repo);
    const latest = await health.latestBaseline(world.projectA, repo, 'main');
    expect(latest?.id).toBe(id);
    expect(latest?.state).toBe('healthy');
    expect(latest?.commit_oid).toBe(COMMIT);
    expect(await eventCount('health.baseline_established', repo)).toBe(1);
    expect(await auditCount('health.baseline_established', `health:${id}`)).toBe(1);
  });

  it('requires a passing validation run when one is cited as evidence', async () => {
    const repo = makeId('repo');
    const passed = await insertRun(repo, 'passed');
    const b = await health.establishBaseline(
      world.projectA,
      { repo_id: repo, branch: 'main', commit_oid: COMMIT, validation_run_id: passed },
      origin,
    );
    expect(b.validation_run_id).toBe(passed);

    const failed = await insertRun(repo, 'failed');
    await expect(
      health.establishBaseline(
        world.projectA,
        { repo_id: repo, branch: 'main', commit_oid: COMMIT, validation_run_id: failed },
        origin,
      ),
    ).rejects.toMatchObject({ code: 'evidence_required' });
    await expect(
      health.establishBaseline(
        world.projectA,
        { repo_id: repo, branch: 'main', commit_oid: COMMIT, validation_run_id: 'no-such-run' },
        origin,
      ),
    ).rejects.toBeInstanceOf(HealthError);
  });
});

describe('HealthService regression attribution', () => {
  it('records a regression once per fingerprint and ranks the culprit first', async () => {
    const repo = makeId('repo');
    const base = await baseline(repo);
    const culprit = 'c'.repeat(40);
    const changes = [
      change('1'.repeat(40), 'src/unrelated.ts', 1),
      change(culprit, 'src/broken.ts,src/broken.test.ts', 2, 'task-culprit'),
      change('2'.repeat(40), 'src/other.ts', 3),
    ];
    const failingChecks = [{ check_id: 'test-broken', paths: ['src/broken.ts', 'src/broken.test.ts'] }];
    const reg = await health.recordRegression(
      world.projectA,
      { repo_id: repo, baseline_id: base, failing_checks: failingChecks, changes },
      origin,
    );
    expect(reg.state).toBe('open');
    expect(reg.suspected_changes?.[0]?.oid).toBe(culprit);
    expect(reg.suspected_changes?.[0]?.task_id).toBe('task-culprit');
    expect(await eventCount('health.regression', repo)).toBe(1);
    expect(await auditCount('health.regression', `health:${reg.id}`)).toBe(1);

    // Same fingerprint → idempotent: same row, no second event.
    const again = await health.recordRegression(
      world.projectA,
      { repo_id: repo, baseline_id: base, failing_checks: failingChecks },
      origin,
    );
    expect(again.id).toBe(reg.id);
    expect(await eventCount('health.regression', repo)).toBe(1);
  });

  it('re-ranks suspects on attributeRegression and persists the ranking', async () => {
    const repo = makeId('repo');
    const base = await baseline(repo);
    const failingChecks = [{ check_id: 't', paths: ['src/x.ts'] }];
    const reg = await health.recordRegression(
      world.projectA,
      { repo_id: repo, baseline_id: base, failing_checks: failingChecks },
      origin,
    );
    expect(reg.suspected_changes).toBeNull();
    const culprit = 'd'.repeat(40);
    const ranked = await health.attributeRegression(
      world.projectA,
      reg.id,
      [change('3'.repeat(40), 'src/y.ts', 1), change(culprit, 'src/x.ts', 2)],
      origin,
    );
    expect(ranked[0]?.oid).toBe(culprit);
    const stored = await health.getRegression(world.projectA, reg.id);
    expect(stored?.suspected_changes?.[0]?.oid).toBe(culprit);
  });

  it('confirms a culprit with revert evidence and refuses a second confirmation', async () => {
    const repo = makeId('repo');
    const base = await baseline(repo);
    const reg = await health.recordRegression(
      world.projectA,
      {
        repo_id: repo,
        baseline_id: base,
        failing_checks: [{ check_id: 't', paths: ['src/x.ts'] }],
      },
      origin,
    );
    const culprit = 'e'.repeat(40);
    const revertOid = 'f'.repeat(40);
    const confirmed = await health.confirmRegression(
      world.projectA,
      reg.id,
      { confirmed_change_id: culprit, revert_oid: revertOid },
      origin,
    );
    expect(confirmed.state).toBe('confirmed');
    expect(confirmed.confirmed_change_id).toBe(culprit);
    expect(confirmed.revert_oid).toBe(revertOid);
    expect(confirmed.confirmed_at).toBeTruthy();
    expect(await auditCount('health.regression_confirmed', `health:${reg.id}`)).toBe(1);
    await expect(
      health.confirmRegression(world.projectA, reg.id, { confirmed_change_id: culprit }, origin),
    ).rejects.toMatchObject({ code: 'invalid_transition' });
  });

  it('rejects an unknown baseline with not_found', async () => {
    const repo = makeId('repo');
    await expect(
      health.recordRegression(
        world.projectA,
        {
          repo_id: repo,
          baseline_id: 'no-such-baseline',
          failing_checks: [{ check_id: 't', paths: ['src/x.ts'] }],
        },
        origin,
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('HealthService project isolation', () => {
  it('does not leak baselines or regressions across projects', async () => {
    const repo = makeId('repo');
    const base = await baseline(repo);
    const reg = await health.recordRegression(
      world.projectA,
      { repo_id: repo, baseline_id: base, failing_checks: [{ check_id: 't', paths: ['src/x.ts'] }] },
      origin,
    );
    expect(await health.getRegression(world.projectB, reg.id)).toBeUndefined();
    expect(await health.getBaseline(world.projectB, base)).toBeUndefined();
    expect(await health.listRegressions(world.projectB, { repoId: repo })).toHaveLength(0);
    // A baseline from project A cannot anchor a regression in project B.
    await expect(
      health.recordRegression(
        world.projectB,
        { repo_id: repo, baseline_id: base, failing_checks: [{ check_id: 't', paths: ['src/x.ts'] }] },
        { actor: { user_id: world.adminUser, agent: null }, deviceId: world.deviceId },
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});