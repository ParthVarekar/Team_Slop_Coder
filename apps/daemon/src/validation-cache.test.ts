import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DAEMON_MIGRATIONS,
  migrate,
  openSqlite,
  type SqliteDatabase,
  type ValidationCheckConfig,
} from '@weft/core';
import { makeId, parseEvent } from '@weft/protocol';
import { draftEvent } from './events.js';
import { RepoRegistry } from './repos.js';
import { ValidationSupervisor } from './validation.js';
import { ValidationCache } from './validation-cache.js';

const dirs: string[] = [];
const dbs: SqliteDatabase[] = [];

function g(repo: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true }).trim();
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'weft-cache-repo-'));
  dirs.push(dir);
  g(dir, ['init', '-q', '-b', 'main']);
  g(dir, ['config', 'user.name', 'Test']);
  g(dir, ['config', 'user.email', 'test@example.com']);
  g(dir, ['config', 'commit.gpgsign', 'false']);
  g(dir, ['config', 'core.autocrlf', 'false']);
  writeFileSync(join(dir, 'base.txt'), 'base\n');
  g(dir, ['add', 'base.txt']);
  g(dir, ['commit', '-q', '-m', 'base']);
  return dir;
}

function freshDb(): SqliteDatabase {
  const db = openSqlite(':memory:');
  migrate(db, DAEMON_MIGRATIONS);
  dbs.push(db);
  return db;
}

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'weft-cache-scratch-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const db of dbs.splice(0)) {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  }
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      /* Windows transient handles */
    }
  }
});

const KEY = { inputHash: 'h1', toolchainFingerprint: 'fp1' };
const sampleChecks = [
  {
    check_id: 'unit',
    command_display: 'node -e ok',
    exit_code: 0,
    duration_ms: 5,
    log_digest: 'd'.repeat(64),
    log_excerpt: 'ok',
    selection: 'full' as const,
    timed_out: false,
    truncated: false,
  },
];

describe('ValidationCache keying, TTL, and quarantine', () => {
  it('serves a cached pass for the exact key and misses on fingerprint/hash mismatch', () => {
    const cache = new ValidationCache(freshDb());
    cache.put({
      ...KEY,
      repoId: 'r',
      treeOid: 't'.repeat(40),
      state: 'passed',
      checks: sampleChecks,
    });
    expect(cache.get(KEY)?.state).toBe('passed');
    expect(cache.get({ ...KEY, toolchainFingerprint: 'other' })).toBeNull();
    expect(cache.get({ ...KEY, inputHash: 'other' })).toBeNull();
  });

  it('expires entries at the TTL boundary', () => {
    let clock = 1_000_000;
    const cache = new ValidationCache(freshDb(), { ttlMs: 5000, now: () => clock });
    cache.put({
      ...KEY,
      repoId: 'r',
      treeOid: 't'.repeat(40),
      state: 'passed',
      checks: sampleChecks,
    });
    clock += 4999;
    expect(cache.get(KEY)).not.toBeNull();
    clock += 1;
    expect(cache.get(KEY)).toBeNull();
  });

  it('quarantine invalidates a cached pass and writes a tombstone when absent', () => {
    const cache = new ValidationCache(freshDb());
    cache.put({
      ...KEY,
      repoId: 'r',
      treeOid: 't'.repeat(40),
      state: 'passed',
      checks: sampleChecks,
    });
    cache.quarantine(KEY);
    expect(cache.get(KEY)).toBeNull();
    const absent = { inputHash: 'h2', toolchainFingerprint: 'fp2' };
    cache.quarantine(absent);
    expect(cache.get(absent)).toBeNull();
  });

  it('never serves a non-passed result', () => {
    const cache = new ValidationCache(freshDb());
    cache.put({
      ...KEY,
      repoId: 'r',
      treeOid: 't'.repeat(40),
      state: 'failed',
      checks: sampleChecks,
    });
    expect(cache.get(KEY)).toBeNull();
  });
});

interface HarnessOpts {
  checks: ValidationCheckConfig[];
  fingerprint?: string;
  ttlMs?: number;
  now?: () => number;
}

function harness(opts: HarnessOpts) {
  const db = freshDb();
  const deviceId = makeId('device');
  const projectId = makeId('project');
  const registry = new RepoRegistry(db, { deviceId, projectId });
  const worktreeRoot = scratch();
  const cache = new ValidationCache(db, {
    ...(opts.ttlMs !== undefined ? { ttlMs: opts.ttlMs } : {}),
    ...(opts.now ? { now: opts.now } : {}),
  });
  const source = { deviceId, projectId };
  const supervisor = new ValidationSupervisor(db, {
    deviceId,
    projectId,
    worktreeRoot,
    registry,
    actor: { user_id: makeId('user'), agent: null },
    validation: {
      timeoutMs: 5000,
      outputCapBytes: 1_048_576,
      excerptBytes: 4096,
      checks: opts.checks,
    },
    cache,
    ...(opts.fingerprint ? { toolchainFingerprint: opts.fingerprint } : {}),
    emit: (draft) => {
      const env = draftEvent(source, draft);
      parseEvent(env);
      return { accepted: true, event_id: env.event_id };
    },
  });
  return { db, registry, supervisor, cache, deviceId };
}

function counterCheck(counterPath: string): ValidationCheckConfig {
  return {
    check_id: 'count',
    command: process.execPath,
    args: ['-e', `require('fs').appendFileSync(${JSON.stringify(counterPath)},'x')`],
    selection: 'full',
  };
}

function flagCheck(flagPath: string): ValidationCheckConfig {
  return {
    check_id: 'flaky',
    command: process.execPath,
    args: [
      '-e',
      `process.exit(require('fs').readFileSync(${JSON.stringify(flagPath)},'utf8').trim()==='pass'?0:1)`,
    ],
    selection: 'full',
  };
}

describe('ValidationSupervisor cache integration', () => {
  it('a cache hit skips re-execution and reads back cache_hit=true with evidence', async () => {
    const counter = join(scratch(), 'count.txt');
    const { registry, supervisor } = harness({ checks: [counterCheck(counter)] });
    const repo = await registry.register(makeRepo());

    const first = await supervisor.run(repo.repo_id, { trigger: 'task' });
    expect(first.cache_hit).toBe(false);
    expect(first.state).toBe('passed');
    expect(readFileSync(counter, 'utf8')).toBe('x');

    const second = await supervisor.run(repo.repo_id, { trigger: 'task' });
    expect(second.cache_hit).toBe(true);
    expect(second.state).toBe('passed');
    expect(second.checks).toHaveLength(1);
    // The check command did NOT run again.
    expect(readFileSync(counter, 'utf8')).toBe('x');
    expect(supervisor.getRun(second.run_id)?.cache_hit).toBe(true);
    expect(supervisor.getRun(second.run_id)?.checks[0]?.check_id).toBe('count');
  });

  it('queue-trigger runs always execute fresh (independence bypasses cache)', async () => {
    const counter = join(scratch(), 'count.txt');
    const { registry, supervisor } = harness({ checks: [counterCheck(counter)] });
    const repo = await registry.register(makeRepo());
    await supervisor.run(repo.repo_id, { trigger: 'task' });
    const queued = await supervisor.run(repo.repo_id, { trigger: 'queue' });
    expect(queued.cache_hit).toBe(false);
    expect(readFileSync(counter, 'utf8')).toBe('xx');
  });

  it('a toolchain fingerprint change forces a fresh run', async () => {
    const counter = join(scratch(), 'count.txt');
    const db = freshDb();
    const deviceId = makeId('device');
    const projectId = makeId('project');
    const registry = new RepoRegistry(db, { deviceId, projectId });
    const worktreeRoot = scratch();
    const cache = new ValidationCache(db);
    const source = { deviceId, projectId };
    const checks = [counterCheck(counter)];
    const mk = (fingerprint: string) =>
      new ValidationSupervisor(db, {
        deviceId,
        projectId,
        worktreeRoot,
        registry,
        actor: { user_id: makeId('user'), agent: null },
        validation: { timeoutMs: 5000, outputCapBytes: 1_048_576, excerptBytes: 4096, checks },
        cache,
        toolchainFingerprint: fingerprint,
        emit: (draft) => {
          const env = draftEvent(source, draft);
          parseEvent(env);
          return { accepted: true, event_id: env.event_id };
        },
      });
    const repo = await registry.register(makeRepo());
    const a = await mk('toolchain-A').run(repo.repo_id, { trigger: 'task' });
    expect(a.cache_hit).toBe(false);
    const b = await mk('toolchain-B').run(repo.repo_id, { trigger: 'task' });
    expect(b.cache_hit).toBe(false);
    expect(readFileSync(counter, 'utf8')).toBe('xx');
  });

  it('flake quarantine invalidates a cached pass after an identical input fails', async () => {
    const flag = join(scratch(), 'flag.txt');
    writeFileSync(flag, 'pass');
    const { registry, supervisor, cache } = harness({
      checks: [flagCheck(flag)],
      fingerprint: 'fp-flaky',
    });
    const repo = await registry.register(makeRepo());

    const pass = await supervisor.run(repo.repo_id, { trigger: 'task' });
    expect(pass.state).toBe('passed');
    expect(pass.cache_hit).toBe(false);
    const key = { inputHash: pass.input_hash!, toolchainFingerprint: 'fp-flaky' };
    expect(cache.get(key)?.state).toBe('passed');

    // Same input, but the flaky check now fails; a queue run executes fresh.
    writeFileSync(flag, 'fail');
    const fail = await supervisor.run(repo.repo_id, { trigger: 'queue' });
    expect(fail.state).toBe('failed');
    expect(fail.input_hash).toBe(pass.input_hash);
    expect(cache.get(key)).toBeNull();

    // The cached pass is now distrusted: a task run re-executes instead of hitting.
    const after = await supervisor.run(repo.repo_id, { trigger: 'task' });
    expect(after.cache_hit).toBe(false);
    expect(after.state).toBe('failed');
    expect(existsSync(flag)).toBe(true);
  });
});
