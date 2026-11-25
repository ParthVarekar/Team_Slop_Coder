import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import {
  DAEMON_MIGRATIONS,
  migrate,
  openSqlite,
  type SqliteDatabase,
  type ValidationCheckConfig,
} from '@weft/core';
import { makeId, parseEvent, type Actor, type EventEnvelope } from '@weft/protocol';
import { createServer, type TeamServer } from '../../server/src/server.js';
import type { ServerConfig } from '../../server/src/config.js';
import { openCentralDatabase, type CentralDatabase } from '../../server/src/db.js';
import { TaskService } from '../../server/src/tasks-service.js';
import {
  startEmbeddedPostgres,
  freePort,
  type EmbeddedCluster,
} from '../../server/test/embedded.js';
import { seedWorld, type World } from '../../server/test/identity.js';
import { draftEvent } from './events.js';
import { RepoRegistry } from './repos.js';
import { ValidationSupervisor } from './validation.js';
import { AttributionEngine } from './attribution.js';
import { MergeExecutor, type MergeQueueClient } from './merge-executor.js';
import { CoordinationRpc } from './coordination-rpc.js';

let cluster: EmbeddedCluster;
let db: CentralDatabase;
let server: TeamServer;
let pool: Pool;
let baseUrl: string;
let token: string;
let rpc: CoordinationRpc;
let tasks: TaskService;
let world: World;
let serverDataDir: string;
const adminSecret = 'm4-admin-secret';
const dirs: string[] = [];
const dbs: SqliteDatabase[] = [];
const actor: Actor = { user_id: 'user_m4', agent: null };

beforeAll(async () => {
  cluster = await startEmbeddedPostgres();
  db = await openCentralDatabase(cluster.databaseUrl);
  pool = db.pool;
  serverDataDir = mkdtempSync(join(tmpdir(), 'weft-m4-server-'));
  const config: ServerConfig = {
    dataDir: serverDataDir,
    host: '127.0.0.1',
    port: await freePort(),
    databaseUrl: cluster.databaseUrl,
    logLevel: 'fatal',
    corsOrigin: '*',
  };
  server = await createServer(config, { adminSecret });
  baseUrl = await server.listen();
  world = await seedWorld(pool);
  tasks = new TaskService(pool);
  const res = await fetch(`${baseUrl}/v1/admin/tokens`, {
    method: 'POST',
    headers: { authorization: `Bearer ${adminSecret}`, 'content-type': 'application/json' },
    body: JSON.stringify({ projectId: world.projectA, userId: world.memberUser, role: 'member' }),
  });
  expect(res.status).toBe(201);
  token = ((await res.json()) as { token: string }).token;
  rpc = new CoordinationRpc({ baseUrl, token, projectId: world.projectA });
}, 120_000);

afterAll(async () => {
  await server?.close();
  await db?.close();
  await cluster?.stop();
  if (serverDataDir) {
    try {
      rmSync(serverDataDir, { recursive: true, force: true, maxRetries: 5 });
    } catch {
      /* best-effort */
    }
  }
});

afterEach(() => {
  for (const d of dbs.splice(0)) {
    try {
      d.close();
    } catch {
      /* already closed */
    }
  }
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      /* Windows transient handles */
    }
  }
});

function g(repo: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true }).trim();
}

function makeRepoWithOrigin(): { work: string; originDir: string } {
  const originDir = mkdtempSync(join(tmpdir(), 'weft-m4-origin-'));
  dirs.push(originDir);
  g(originDir, ['init', '-q', '--bare', '-b', 'main']);
  const work = mkdtempSync(join(tmpdir(), 'weft-m4-work-'));
  dirs.push(work);
  g(work, ['init', '-q', '-b', 'main']);
  g(work, ['config', 'user.name', 'Test']);
  g(work, ['config', 'user.email', 'test@example.com']);
  g(work, ['config', 'commit.gpgsign', 'false']);
  g(work, ['config', 'core.autocrlf', 'false']);
  g(work, ['remote', 'add', 'origin', originDir]);
  writeFileSync(join(work, 'base.txt'), 'base\n');
  g(work, ['add', 'base.txt']);
  g(work, ['commit', '-q', '-m', 'base']);
  g(work, ['push', '-q', 'origin', 'main']);
  return { work, originDir };
}

function addCandidate(work: string, branch: string, file: string, content: string): void {
  g(work, ['checkout', '-q', '-b', branch]);
  writeFileSync(join(work, file), content);
  g(work, ['add', file]);
  g(work, ['commit', '-q', '-m', `work on ${branch}`]);
  g(work, ['push', '-q', 'origin', branch]);
  g(work, ['checkout', '-q', 'main']);
}

function nodeCheck(checkId: string, script: string): ValidationCheckConfig {
  return { check_id: checkId, command: process.execPath, args: ['-e', script], selection: 'full' };
}

function freshDb(): SqliteDatabase {
  const d = openSqlite(':memory:');
  migrate(d, DAEMON_MIGRATIONS);
  dbs.push(d);
  return d;
}

const authJson = () => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });

async function ingest(events: EventEnvelope[]): Promise<void> {
  if (events.length === 0) return;
  const res = await fetch(`${baseUrl}/v1/ingest`, {
    method: 'POST',
    headers: authJson(),
    body: JSON.stringify({ events }),
  });
  if (res.status !== 202) throw new Error(`ingest failed: ${res.status} ${await res.text()}`);
}

async function serverRun(
  runId: string,
): Promise<{ independence: string; tree_oid: string; state: string } | null> {
  const res = await fetch(`${baseUrl}/v1/validation/runs/${runId}?projectId=${world.projectA}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (res.status === 404) return null;
  const body = (await res.json()) as {
    run: { independence: string; tree_oid: string; state: string };
  };
  return body.run;
}

interface ScenarioOptions {
  checks?: ValidationCheckConfig[];
  sameDevice?: boolean;
}

async function scenario(opts: ScenarioOptions = {}) {
  const { work, originDir } = makeRepoWithOrigin();
  const sqlite = freshDb();
  const projectId = world.projectA;
  const executorDevice = makeId('device');
  const claimantDevice = opts.sameDevice ? executorDevice : makeId('device');
  const registry = new RepoRegistry(sqlite, { deviceId: executorDevice, projectId });
  const repo = await registry.register(work);
  const worktreeRoot = mkdtempSync(join(tmpdir(), 'weft-m4-wt-'));
  dirs.push(worktreeRoot);
  const source = { deviceId: executorDevice, projectId };

  const captured: EventEnvelope[] = [];
  const pending: EventEnvelope[] = [];
  const emit = (draft: Parameters<typeof draftEvent>[1]) => {
    const env = draftEvent(source, draft);
    parseEvent(env);
    captured.push(env);
    pending.push(env);
    return { accepted: true, event_id: env.event_id };
  };
  // Models the outbox→ingest path over real HTTP: validation evidence is
  // projected into the server's validation_runs before the executor reports.
  const flush = () => ingest(pending.splice(0));

  const validation = new ValidationSupervisor(sqlite, {
    deviceId: executorDevice,
    projectId,
    worktreeRoot,
    registry,
    actor,
    validation: {
      timeoutMs: 5_000,
      outputCapBytes: 1_048_576,
      excerptBytes: 4096,
      checks: opts.checks ?? [nodeCheck('ok', 'process.exit(0)')],
    },
    emit,
  });
  const attribution = new AttributionEngine({ registry, validation, worktreeRoot });

  const client: MergeQueueClient = {
    acquireLease: (r, d, t) => rpc.acquireLease(r, d, t),
    claimNext: (r, d, e) => rpc.claimNext(r, d, e),
    recordSpeculativeTree: (id, input, d, e) => rpc.recordSpeculativeTree(id, input, d, e),
    attachValidation: async (id, runId, d, e) => {
      await flush();
      return rpc.attachValidation(id, runId, d, e);
    },
    advance: async (id, oid, d, e) => {
      await flush();
      return rpc.advance(id, oid, d, e);
    },
    eject: async (id, reason, d, e) => {
      await flush();
      return rpc.eject(id, reason, d, e);
    },
  };
  const executor = new MergeExecutor({ deviceId: executorDevice, registry, client, validation });

  const task = await tasks.create(
    projectId,
    { title: 'merge work', repoId: repo.repo_id, state: 'ready' },
    { actor, deviceId: claimantDevice },
  );
  const enqueue = (branch: string) =>
    rpc.enqueue({
      repo_id: repo.repo_id,
      task_id: task.id,
      branch,
      claimant_device_id: claimantDevice,
    });

  return {
    work,
    originDir,
    repo,
    executor,
    attribution,
    claimantDevice,
    executorDevice,
    enqueue,
    captured,
  };
}

describe('M4 end-to-end over HTTP: merge queue', () => {
  it('a clean branch is independently validated and merged via CAS push', async () => {
    const s = await scenario();
    addCandidate(s.work, 'feature/clean', 'feature.txt', 'new feature\n');
    const entry = await s.enqueue('feature/clean');
    const mainBefore = g(s.originDir, ['rev-parse', 'main']);

    const outcome = await s.executor.tick(s.repo.repo_id);
    expect(outcome.status).toBe('merged');
    if (outcome.status !== 'merged') return;
    expect(g(s.originDir, ['rev-parse', 'main'])).toBe(outcome.mergedOid);
    expect(outcome.mergedOid).not.toBe(mainBefore);

    const stored = await rpc.getEntry(entry.id);
    expect(stored?.state).toBe('merged');
    expect(stored?.merged_oid).toBe(outcome.mergedOid);

    const completed = s.captured.find((e) => e.type === 'validation.completed');
    expect(completed?.payload.independence).toBe('independent');
    const projected = await serverRun(String(completed?.payload.run_id));
    expect(projected?.independence).toBe('independent');
    expect(projected?.state).toBe('passed');
    expect(projected?.tree_oid).toBe(outcome.treeOid);
  });

  it('two agents editing the same file: the merge gate warns (ejects) and never clobbers origin', async () => {
    const s = await scenario();
    const { work } = s;
    writeFileSync(join(work, 'shared.txt'), 'orig\n');
    g(work, ['add', 'shared.txt']);
    g(work, ['commit', '-q', '-m', 'shared']);
    g(work, ['push', '-q', 'origin', 'main']);
    g(work, ['checkout', '-q', '-b', 'feature/conflict']);
    writeFileSync(join(work, 'shared.txt'), 'candidate\n');
    g(work, ['add', 'shared.txt']);
    g(work, ['commit', '-q', '-m', 'candidate side']);
    g(work, ['push', '-q', 'origin', 'feature/conflict']);
    g(work, ['checkout', '-q', 'main']);
    writeFileSync(join(work, 'shared.txt'), 'main\n');
    g(work, ['add', 'shared.txt']);
    g(work, ['commit', '-q', '-m', 'main side']);
    g(work, ['push', '-q', 'origin', 'main']);
    const mainBefore = g(s.originDir, ['rev-parse', 'main']);

    const entry = await s.enqueue('feature/conflict');
    const outcome = await s.executor.tick(s.repo.repo_id);
    expect(outcome.status).toBe('ejected');
    if (outcome.status === 'ejected') expect(outcome.reason).toContain('merge_conflict');
    expect(g(s.originDir, ['rev-parse', 'main'])).toBe(mainBefore);
    expect((await rpc.getEntry(entry.id))?.state).toBe('ejected');
  });

  it('a failed validation ejects; the server advance gate independently rejects unvalidated evidence', async () => {
    const s = await scenario({ checks: [nodeCheck('unit', 'process.exit(1)')] });
    addCandidate(s.work, 'feature/fail', 'f.txt', 'f\n');
    const entry = await s.enqueue('feature/fail');
    const mainBefore = g(s.originDir, ['rev-parse', 'main']);
    const outcome = await s.executor.tick(s.repo.repo_id);
    expect(outcome.status).toBe('ejected');
    if (outcome.status === 'ejected') expect(outcome.reason).toBe('validation_failed');
    expect(g(s.originDir, ['rev-parse', 'main'])).toBe(mainBefore);

    // Directly exercise the HTTP never-merge-unvalidated gate on a testing entry.
    const repo = makeId('repo');
    const device = makeId('device');
    const task = await tasks.create(
      world.projectA,
      { title: 'gate', repoId: repo, state: 'ready' },
      { actor, deviceId: device },
    );
    const lease = await rpc.acquireLease(repo, device, 60_000);
    const queued = await rpc.enqueue({ repo_id: repo, task_id: task.id, branch: 'weft/gate' });
    const claimed = await rpc.claimNext(repo, device, lease.lease.lease_epoch);
    expect(claimed?.id).toBe(queued.id);
    await rpc.recordSpeculativeTree(
      queued.id,
      {
        speculative_tree_oid: 'a'.repeat(40),
        base_oid: 'b'.repeat(40),
        push_precondition_oid: 'b'.repeat(40),
      },
      device,
      lease.lease.lease_epoch,
    );
    await expect(
      rpc.advance(queued.id, 'c'.repeat(40), device, lease.lease.lease_epoch),
    ).rejects.toMatchObject({ code: 'evidence_required', status: 422 });
    expect((await rpc.getEntry(queued.id))?.state).toBe('testing');
    expect(entry.id).toBeTruthy();
  });
});

describe('M4 end-to-end over HTTP: regression attribution + safe revert', () => {
  it('plants a regression, ranks the culprit, confirms by revert-test, and records it', async () => {
    const { work } = makeRepoWithOrigin();
    const sqlite = freshDb();
    const projectId = world.projectA;
    const device = makeId('device');
    const registry = new RepoRegistry(sqlite, { deviceId: device, projectId });
    // Healthy baseline: app.txt clean + an unrelated file that must survive the revert.
    writeFileSync(join(work, 'app.txt'), 'clean\n');
    writeFileSync(join(work, 'other.txt'), 'keep\n');
    g(work, ['add', 'app.txt', 'other.txt']);
    g(work, ['commit', '-q', '-m', 'healthy baseline']);
    const baselineOid = g(work, ['rev-parse', 'HEAD']);
    g(work, ['push', '-q', 'origin', 'main']);
    // The culprit introduces a bug that fails the project check.
    writeFileSync(join(work, 'app.txt'), 'BUG\n');
    g(work, ['add', 'app.txt']);
    g(work, ['commit', '-q', '-m', 'introduce bug']);
    const culpritOid = g(work, ['rev-parse', 'HEAD']);
    g(work, ['push', '-q', 'origin', 'main']);

    const repo = await registry.register(work);
    const worktreeRoot = mkdtempSync(join(tmpdir(), 'weft-m4-revert-'));
    dirs.push(worktreeRoot);
    const source = { deviceId: device, projectId };
    const pending: EventEnvelope[] = [];
    const validation = new ValidationSupervisor(sqlite, {
      deviceId: device,
      projectId,
      worktreeRoot,
      registry,
      actor,
      validation: {
        timeoutMs: 5_000,
        outputCapBytes: 1_048_576,
        excerptBytes: 4096,
        checks: [
          nodeCheck(
            'bugcheck',
            "process.exit(require('fs').readFileSync('app.txt','utf8').includes('BUG')?1:0)",
          ),
        ],
      },
      emit: (draft) => {
        const env = draftEvent(source, draft);
        parseEvent(env);
        pending.push(env);
        return { accepted: true, event_id: env.event_id };
      },
    });
    const attribution = new AttributionEngine({ registry, validation, worktreeRoot });

    const baseline = await rpc.establishBaseline({
      repo_id: repo.repo_id,
      branch: 'main',
      commit_oid: baselineOid,
    });
    expect(baseline.state).toBe('healthy');

    const failingChecks = [{ check_id: 'bugcheck', paths: ['app.txt'] }];
    const suspects = await attribution.attribute(repo.repo_id, { baselineOid, failingChecks });
    expect(suspects[0]?.oid).toBe(culpritOid);

    const changes = await attribution.buildSuspects(repo.repo_id, baselineOid);
    const regression = await rpc.recordRegression({
      repo_id: repo.repo_id,
      baseline_id: baseline.id,
      failing_checks: failingChecks,
      changes,
    });
    expect(regression.state).toBe('open');
    expect(regression.suspected_changes?.[0]?.oid).toBe(culpritOid);

    // Confirmation is evidence: reverting the culprit makes the check pass again.
    const revert = await attribution.revertTest(repo.repo_id, culpritOid);
    expect(revert.confirmed).toBe(true);
    if (!revert.confirmed) return;
    await ingest(pending.splice(0));

    const confirmed = await rpc.confirmRegression(regression.id, culpritOid, revert.revertOid);
    expect(confirmed.state).toBe('confirmed');
    expect(confirmed.confirmed_change_id).toBe(culpritOid);
    expect(confirmed.revert_oid).toBe(revert.revertOid);

    // The revert preserved unrelated work and never touched the user's HEAD.
    expect(g(work, ['show', `${revert.revertOid}:other.txt`])).toBe('keep');
    expect(g(work, ['show', `${revert.revertOid}:app.txt`])).toBe('clean');
    expect(g(work, ['rev-parse', 'HEAD'])).toBe(culpritOid);
    expect((await rpc.getRegression(regression.id))?.state).toBe('confirmed');
  });
});

describe('M4 queue coordination overhead (excluding checks)', () => {
  it('lease + enqueue + claim + tree + attach + advance round-trips stay <= 200ms', async () => {
    const repo = makeId('repo');
    const device = makeId('device');
    const claimant = makeId('device');
    const runner = makeId('device');
    const TREE = 'a'.repeat(40);
    const BASE = 'b'.repeat(40);
    const MERGED = 'c'.repeat(40);
    const task = await tasks.create(
      world.projectA,
      { title: 'perf', repoId: repo, state: 'ready' },
      { actor, deviceId: claimant },
    );
    const runId = makeId('validation');
    await pool.query(
      `INSERT INTO validation_runs
         (id, project_id, repo_id, task_id, trigger, tree_oid, state, independence,
          runner_device_id, claimant_device_id, finished_at)
       VALUES ($1,$2,$3,$4,'queue',$5,'passed','independent',$6,$7, now())`,
      [runId, world.projectA, repo, task.id, TREE, runner, claimant],
    );
    // Warm the connection pool / JIT so the measurement reflects steady-state.
    await rpc.acquireLease(makeId('repo'), device, 60_000);

    const t0 = performance.now();
    const lease = await rpc.acquireLease(repo, device, 60_000);
    const epoch = lease.lease.lease_epoch;
    const entry = await rpc.enqueue({
      repo_id: repo,
      task_id: task.id,
      branch: 'weft/perf',
      claimant_device_id: claimant,
    });
    const claimed = await rpc.claimNext(repo, device, epoch);
    expect(claimed?.id).toBe(entry.id);
    await rpc.recordSpeculativeTree(
      entry.id,
      { speculative_tree_oid: TREE, base_oid: BASE, push_precondition_oid: BASE },
      device,
      epoch,
    );
    await rpc.attachValidation(entry.id, runId, device, epoch);
    const landed = await rpc.advance(entry.id, MERGED, device, epoch);
    const elapsed = performance.now() - t0;
    expect(landed.state).toBe('merged');
    expect(elapsed).toBeLessThan(200);
  });
});
