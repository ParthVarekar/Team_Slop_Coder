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
import { openCentralDatabase, type CentralDatabase } from '../../server/src/db.js';
import { MergeQueueService } from '../../server/src/merge-queue-service.js';
import { TaskService } from '../../server/src/tasks-service.js';
import { ValidationService } from '../../server/src/validation-service.js';
import { withTransaction } from '../../server/src/pg.js';
import { startEmbeddedPostgres, type EmbeddedCluster } from '../../server/test/embedded.js';
import { seedWorld, type World } from '../../server/test/identity.js';
import { draftEvent } from './events.js';
import { RepoRegistry } from './repos.js';
import { ValidationSupervisor } from './validation.js';
import { MergeExecutor, type MergeQueueClient } from './merge-executor.js';

let cluster: EmbeddedCluster;
let db: CentralDatabase;
let pool: Pool;
let queue: MergeQueueService;
let tasks: TaskService;
let validationService: ValidationService;
let world: World;
const dirs: string[] = [];
const dbs: SqliteDatabase[] = [];
const actor: Actor = { user_id: 'user_mq', agent: null };

beforeAll(async () => {
  cluster = await startEmbeddedPostgres();
  db = await openCentralDatabase(cluster.databaseUrl);
  pool = db.pool;
  world = await seedWorld(pool);
  queue = new MergeQueueService(pool, makeId('device'));
  tasks = new TaskService(pool);
  validationService = new ValidationService(pool);
}, 120_000);

afterAll(async () => {
  await db?.close();
  await cluster?.stop();
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
  const originDir = mkdtempSync(join(tmpdir(), 'weft-mq-origin-'));
  dirs.push(originDir);
  g(originDir, ['init', '-q', '--bare', '-b', 'main']);
  const work = mkdtempSync(join(tmpdir(), 'weft-mq-work-'));
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

/** Commit a new file on a fresh branch off main and push it to origin. */
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

interface ScenarioOptions {
  checks?: ValidationCheckConfig[];
  sameDevice?: boolean;
  /** Invoked right after the speculative tree is recorded — inject a concurrent writer. */
  onRecorded?: (work: string) => void | Promise<void>;
}

async function scenario(opts: ScenarioOptions = {}) {
  const { work, originDir } = makeRepoWithOrigin();
  const sqlite = freshDb();
  const projectId = world.projectA;
  const executorDevice = makeId('device');
  const claimantDevice = opts.sameDevice ? executorDevice : makeId('device');
  const registry = new RepoRegistry(sqlite, { deviceId: executorDevice, projectId });
  const repo = await registry.register(work);
  const worktreeRoot = mkdtempSync(join(tmpdir(), 'weft-mq-wt-'));
  dirs.push(worktreeRoot);
  const source = { deviceId: executorDevice, projectId };

  const captured: EventEnvelope[] = [];
  const toProject: EventEnvelope[] = [];
  const emit = (draft: Parameters<typeof draftEvent>[1]) => {
    const env = draftEvent(source, draft);
    parseEvent(env);
    captured.push(env);
    if (env.type === 'validation.started' || env.type === 'check.completed' || env.type === 'validation.completed')
      toProject.push(env);
    return { accepted: true, event_id: env.event_id };
  };
  // Models the outbox→ingest path: validation evidence is projected into the
  // server's validation_runs (real projection logic) before the executor reports.
  const flush = async () => {
    const batch = toProject.splice(0);
    if (batch.length === 0) return;
    await withTransaction(pool, async (c) => {
      for (const e of batch) await validationService.project(c, e);
    });
  };

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

  const origin = { actor, deviceId: executorDevice };
  const client: MergeQueueClient = {
    acquireLease: (repoId, deviceId, ttlMs) => queue.acquireExecutorLease(projectId, repoId, deviceId, origin, ttlMs),
    claimNext: (repoId, deviceId, epoch) => queue.claimNext(projectId, repoId, deviceId, epoch, origin),
    recordSpeculativeTree: async (entryId, input, deviceId, epoch) => {
      const res = await queue.recordSpeculativeTree(projectId, entryId, input, deviceId, epoch, origin);
      if (opts.onRecorded) await opts.onRecorded(work);
      return res;
    },
    attachValidation: async (entryId, runId, deviceId, epoch) => {
      await flush();
      return queue.attachValidation(projectId, entryId, runId, deviceId, epoch, origin);
    },
    advance: async (entryId, oid, deviceId, epoch) => {
      await flush();
      return queue.advance(projectId, entryId, oid, deviceId, epoch, origin);
    },
    eject: async (entryId, reason, deviceId, epoch) => {
      await flush();
      return queue.eject(projectId, entryId, reason, deviceId, epoch, origin);
    },
  };
  const executor = new MergeExecutor({ deviceId: executorDevice, registry, client, validation });

  const task = await tasks.create(projectId, { title: 'merge work', repoId: repo.repo_id, state: 'ready' }, { actor, deviceId: claimantDevice });
  const enqueue = (branch: string) =>
    queue.enqueue(
      projectId,
      { repo_id: repo.repo_id, task_id: task.id, branch, claimant_device_id: claimantDevice },
      { actor, deviceId: claimantDevice },
    );

  return { work, originDir, repo, executor, claimantDevice, executorDevice, enqueue, captured };
}

describe('MergeExecutor happy path', () => {
  it('merges a clean branch after independent validation and lands it via CAS push', async () => {
    const s = await scenario();
    addCandidate(s.work, 'feature/clean', 'feature.txt', 'new feature\n');
    const entry = await s.enqueue('feature/clean');
    const mainBefore = g(s.originDir, ['rev-parse', 'main']);

    const outcome = await s.executor.tick(s.repo.repo_id);
    expect(outcome.status).toBe('merged');
    if (outcome.status !== 'merged') return;

    // origin/main advanced to the speculative merge commit (CAS landed).
    expect(g(s.originDir, ['rev-parse', 'main'])).toBe(outcome.mergedOid);
    expect(outcome.mergedOid).not.toBe(mainBefore);
    // The merge commit has two parents: the old target tip and the candidate tip.
    const parents = g(s.work, ['rev-list', '--parents', '-n', '1', outcome.mergedOid]).split(' ').slice(1);
    expect(parents).toHaveLength(2);
    expect(parents[0]).toBe(mainBefore);
    // The merged tree carries both base and the new feature file.
    const files = g(s.work, ['ls-tree', '-r', '--name-only', outcome.mergedOid]).split('\n');
    expect(files).toContain('base.txt');
    expect(files).toContain('feature.txt');

    const stored = await queue.get(world.projectA, entry.id);
    expect(stored?.state).toBe('merged');
    expect(stored?.merged_oid).toBe(outcome.mergedOid);
    expect(stored?.speculative_tree_oid).toBe(outcome.treeOid);

    // The gating validation was independent (runner != claimant) and passed.
    const run = s.captured.find((e) => e.type === 'validation.completed');
    expect(run?.payload.state).toBe('passed');
    expect(run?.payload.independence).toBe('independent');
    const serverRun = await validationService.getRun(String(run?.payload.run_id), world.projectA);
    expect(serverRun?.independence).toBe('independent');
    expect(serverRun?.tree_oid).toBe(outcome.treeOid);
  });

  it('returns idle when the queue is empty', async () => {
    const s = await scenario();
    expect((await s.executor.tick(s.repo.repo_id)).status).toBe('idle');
  });

  it('returns not_executor when another device holds the lease', async () => {
    const s = await scenario();
    const other = makeId('device');
    const held = await queue.acquireExecutorLease(world.projectA, s.repo.repo_id, other, { actor, deviceId: other }, 60_000);
    expect(held.status).toBe('acquired');
    addCandidate(s.work, 'feature/x', 'x.txt', 'x\n');
    await s.enqueue('feature/x');
    expect((await s.executor.tick(s.repo.repo_id)).status).toBe('not_executor');
    // The entry is untouched while another device is the executor.
    const stored = await queue.list(world.projectA, { repoId: s.repo.repo_id });
    expect(stored[0]?.state).toBe('queued');
  });
});

describe('MergeExecutor never merges unsafe work', () => {
  it('ejects a textual conflict without touching origin/main', async () => {
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

    await s.enqueue('feature/conflict');
    const outcome = await s.executor.tick(s.repo.repo_id);
    expect(outcome.status).toBe('ejected');
    if (outcome.status === 'ejected') expect(outcome.reason).toContain('merge_conflict');
    expect(g(s.originDir, ['rev-parse', 'main'])).toBe(mainBefore);
  });

  it('ejects when validation fails; origin/main is never advanced', async () => {
    const s = await scenario({ checks: [nodeCheck('unit', 'process.exit(1)')] });
    addCandidate(s.work, 'feature/fail', 'f.txt', 'f\n');
    await s.enqueue('feature/fail');
    const mainBefore = g(s.originDir, ['rev-parse', 'main']);
    const outcome = await s.executor.tick(s.repo.repo_id);
    expect(outcome.status).toBe('ejected');
    if (outcome.status === 'ejected') expect(outcome.reason).toBe('validation_failed');
    expect(g(s.originDir, ['rev-parse', 'main'])).toBe(mainBefore);
  });

  it('ejects when the only validation is self (executor == claimant): cross-device gate', async () => {
    const s = await scenario({ sameDevice: true });
    addCandidate(s.work, 'feature/self', 's.txt', 's\n');
    await s.enqueue('feature/self');
    const mainBefore = g(s.originDir, ['rev-parse', 'main']);
    const outcome = await s.executor.tick(s.repo.repo_id);
    expect(outcome.status).toBe('ejected');
    if (outcome.status === 'ejected') expect(outcome.reason).toBe('independent_validation_required');
    expect(g(s.originDir, ['rev-parse', 'main'])).toBe(mainBefore);
    const run = s.captured.find((e) => e.type === 'validation.completed');
    expect(run?.payload.independence).toBe('self');
  });

  it('a stale CAS push (concurrent writer advanced the target) ejects without overwriting', async () => {
    let otherTip = '';
    const s = await scenario({
      onRecorded: (work) => {
        // Another writer lands a commit on origin/main after the precondition was recorded.
        writeFileSync(join(work, 'other.txt'), 'other writer\n');
        g(work, ['add', 'other.txt']);
        g(work, ['commit', '-q', '-m', 'concurrent writer']);
        g(work, ['push', '-q', 'origin', 'main']);
        otherTip = g(work, ['rev-parse', 'main']);
      },
    });
    addCandidate(s.work, 'feature/race', 'r.txt', 'r\n');
    await s.enqueue('feature/race');
    const outcome = await s.executor.tick(s.repo.repo_id);
    expect(outcome.status).toBe('ejected');
    if (outcome.status === 'ejected') expect(outcome.reason).toBe('push_stale');
    // origin/main still points at the concurrent writer's commit — never clobbered.
    expect(g(s.originDir, ['rev-parse', 'main'])).toBe(otherTip);
    const stored = await queue.list(world.projectA, { repoId: s.repo.repo_id });
    expect(stored[0]?.state).toBe('ejected');
    expect(stored[0]?.merged_oid).toBeNull();
  });
});