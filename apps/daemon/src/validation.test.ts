import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DAEMON_MIGRATIONS,
  migrate,
  openSqlite,
  type SqliteDatabase,
  type ValidationCheckConfig,
  type ValidationConfig,
} from '@weft/core';
import { makeId, parseEvent, type EventEnvelope } from '@weft/protocol';
import { draftEvent } from './events.js';
import { RepoRegistry } from './repos.js';
import { LocalTaskStore, TaskError } from './tasks.js';
import { ValidationRunError, ValidationSupervisor } from './validation.js';

const dirs: string[] = [];
const dbs: SqliteDatabase[] = [];

function g(repo: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true }).trim();
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'weft-val-repo-'));
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

function nodeCheck(checkId: string, script: string, timeoutMs?: number): ValidationCheckConfig {
  return {
    check_id: checkId,
    command: process.execPath,
    args: ['-e', script],
    selection: 'full',
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  };
}

interface HarnessOptions {
  checks?: ValidationCheckConfig[];
  timeoutMs?: number;
  excerptBytes?: number;
  outputCapBytes?: number;
  concurrency?: number;
}

function harness(opts: HarnessOptions = {}) {
  const db = freshDb();
  const deviceId = makeId('device');
  const projectId = makeId('project');
  const registry = new RepoRegistry(db, { deviceId, projectId });
  const worktreeRoot = mkdtempSync(join(tmpdir(), 'weft-val-root-'));
  dirs.push(worktreeRoot);
  const source = { deviceId, projectId };
  const actor = { user_id: makeId('user'), agent: null };
  const captured: EventEnvelope[] = [];
  const emit = (draft: Parameters<typeof draftEvent>[1]) => {
    const env = draftEvent(source, draft);
    parseEvent(env); // every emitted event must be protocol-valid
    captured.push(env);
    return { accepted: true, event_id: env.event_id };
  };
  const validation: ValidationConfig = {
    timeoutMs: opts.timeoutMs ?? 5_000,
    outputCapBytes: opts.outputCapBytes ?? 1_048_576,
    excerptBytes: opts.excerptBytes ?? 4096,
    checks: opts.checks ?? [nodeCheck('ok', 'process.exit(0)')],
    ...(opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {}),
  };
  const supervisor = new ValidationSupervisor(db, {
    deviceId,
    projectId,
    worktreeRoot,
    registry,
    actor,
    validation,
    emit,
  });
  const tasks = new LocalTaskStore(db, {
    source,
    actor,
    emit: (env) => {
      parseEvent(env);
      captured.push(env);
    },
  });
  return { db, registry, supervisor, tasks, captured, deviceId, projectId, worktreeRoot };
}

function grabError(fn: () => unknown): unknown {
  try {
    fn();
    return undefined;
  } catch (err) {
    return err;
  }
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

describe('ValidationSupervisor evidence', () => {
  it('runs checks in a detached validation worktree, attaches evidence, and cleans up', async () => {
    const { registry, supervisor, captured, worktreeRoot } = harness({
      checks: [nodeCheck('cwd', 'process.stdout.write(process.cwd()); process.exit(0)')],
    });
    const repo = await registry.register(makeRepo());
    const run = await supervisor.run(repo.repo_id);

    expect(run.state).toBe('passed');
    expect(run.independence).toBe('self');
    expect(run.candidate_oid).toBe(repo.head_oid);
    expect(run.tree_oid).toMatch(/^[0-9a-f]{40}$/);
    expect(run.runner_device_id).toBeTruthy();
    expect(run.checks).toHaveLength(1);
    const check = run.checks[0];
    expect(check.check_id).toBe('cwd');
    expect(check.exit_code).toBe(0);
    expect(check.timed_out).toBe(false);
    expect(check.truncated).toBe(false);
    expect(check.selection).toBe('full');
    expect(check.duration_ms).toBeGreaterThanOrEqual(0);
    expect(check.log_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(check.command_display).toContain('-e');
    // The check ran inside the per-run detached worktree, never the user's tree.
    expect(check.log_excerpt).toContain('validation');

    // Evidence reads back identically from SQLite.
    expect(supervisor.getRun(run.run_id)).toEqual(run);
    expect(supervisor.listRuns({ repoId: repo.repo_id })).toHaveLength(1);

    const types = captured.map((e) => e.type);
    expect(types.indexOf('validation.started')).toBeGreaterThanOrEqual(0);
    expect(types.indexOf('validation.started')).toBeLessThan(types.indexOf('check.completed'));
    expect(types.indexOf('check.completed')).toBeLessThan(types.indexOf('validation.completed'));

    // The temporary validation worktree is removed after the run.
    expect(existsSync(join(worktreeRoot, 'validation', run.run_id))).toBe(false);
  });

  it('records a non-zero exit as failed with the exit code preserved', async () => {
    const { registry, supervisor } = harness({
      checks: [nodeCheck('unit', 'process.stdout.write("boom\\n"); process.exit(2)')],
    });
    const repo = await registry.register(makeRepo());
    const run = await supervisor.run(repo.repo_id);
    expect(run.state).toBe('failed');
    expect(run.checks[0].exit_code).toBe(2);
    expect(run.checks[0].timed_out).toBe(false);
    expect(run.checks[0].log_excerpt).toContain('boom');
  });

  it('records a spawn failure as error with a null exit code', async () => {
    const { registry, supervisor } = harness({
      checks: [{ check_id: 'missing', command: 'weft-no-such-binary-xyz', args: [], selection: 'full' }],
    });
    const repo = await registry.register(makeRepo());
    const run = await supervisor.run(repo.repo_id);
    expect(run.state).toBe('error');
    expect(run.checks[0].exit_code).toBeNull();
  });

  it('attaches evidence for every check and lets failure dominate a pass', async () => {
    const { registry, supervisor } = harness({
      checks: [
        nodeCheck('a', 'process.exit(0)'),
        nodeCheck('b', 'process.exit(1)'),
      ],
    });
    const repo = await registry.register(makeRepo());
    const run = await supervisor.run(repo.repo_id);
    expect(run.state).toBe('failed');
    expect(run.checks.map((c) => c.check_id)).toEqual(['a', 'b']);
    expect(run.checks.map((c) => c.exit_code)).toEqual([0, 1]);
    expect(supervisor.getRun(run.run_id)?.checks).toHaveLength(2);
  });

  it('kills a hung check on timeout and reads back timed_out=true with a null exit code', async () => {
    const { registry, supervisor } = harness({
      timeoutMs: 300,
      checks: [nodeCheck('hang', 'setTimeout(() => {}, 30000)')],
    });
    const repo = await registry.register(makeRepo());
    const run = await supervisor.run(repo.repo_id);
    expect(run.state).toBe('error');
    expect(run.checks[0].timed_out).toBe(true);
    expect(run.checks[0].exit_code).toBeNull();
    expect(run.checks[0].duration_ms).toBeLessThan(10_000);

    // The persisted exit code is null so the read-back mapper infers timed_out.
    const readBack = supervisor.getRun(run.run_id);
    expect(readBack?.state).toBe('error');
    expect(readBack?.checks[0].exit_code).toBeNull();
    expect(readBack?.checks[0].timed_out).toBe(true);
  });

  it('redacts secrets from command_display, log_excerpt, and the emitted event', async () => {
    const secret = `ghp_${'a'.repeat(40)}`;
    const { registry, supervisor, captured } = harness({
      checks: [nodeCheck('leak', `process.stdout.write("pat=${secret}"); process.exit(0)`)],
    });
    const repo = await registry.register(makeRepo());
    const run = await supervisor.run(repo.repo_id);
    expect(run.state).toBe('passed');
    const check = run.checks[0];
    expect(check.command_display).not.toContain(secret);
    expect(check.command_display).toContain('[REDACTED:');
    expect(check.log_excerpt).not.toContain(secret);
    expect(check.log_excerpt).toContain('[REDACTED:');

    const event = captured.find((e) => e.type === 'check.completed');
    expect(event?.payload.log_excerpt).not.toContain(secret);
    expect(event?.payload.command_display).not.toContain(secret);
    // The digest is over raw output, so it never leaks the secret either.
    expect(check.log_digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('caps the excerpt and flags truncation when output exceeds the byte budget', async () => {
    const { registry, supervisor } = harness({
      excerptBytes: 64,
      outputCapBytes: 100,
      checks: [nodeCheck('big', 'process.stdout.write("x".repeat(5000)); process.exit(0)')],
    });
    const repo = await registry.register(makeRepo());
    const run = await supervisor.run(repo.repo_id);
    expect(run.checks[0].log_excerpt.length).toBeLessThanOrEqual(64);
    expect(run.checks[0].truncated).toBe(true);
  });
});

describe('ValidationSupervisor input guards', () => {
  it('rejects an unknown repo with not_found', async () => {
    const { supervisor } = harness();
    await expect(supervisor.run('repo_missing')).rejects.toBeInstanceOf(ValidationRunError);
    await expect(supervisor.run('repo_missing')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('rejects a project with no configured checks as not_configured', async () => {
    const { registry, supervisor } = harness({ checks: [] });
    const repo = await registry.register(makeRepo());
    await expect(supervisor.run(repo.repo_id)).rejects.toMatchObject({ code: 'not_configured' });
  });

  it('rejects an unresolvable candidate ref as invalid_candidate', async () => {
    const { registry, supervisor } = harness();
    const repo = await registry.register(makeRepo());
    await expect(
      supervisor.run(repo.repo_id, { candidate: 'refs/heads/does-not-exist' }),
    ).rejects.toMatchObject({ code: 'invalid_candidate' });
  });
});

describe('completion is a claim, not a verified fact', () => {
  it('records an unverified redacted claim without completing or bumping the task', () => {
    const { tasks, captured } = harness();
    const task = tasks.create({ title: 'Claim me', state: 'validation' });
    const secret = `ghp_${'b'.repeat(40)}`;
    const claim = tasks.claimCompletion(task.task_id, `done ${secret}`);

    expect(claim.evidence_state).toBe('unverified');
    expect(claim.claim_text).not.toContain(secret);
    expect(claim.claim_text).toContain('[REDACTED:');

    const after = tasks.getTask(task.task_id);
    expect(after?.state).toBe('validation');
    expect(after?.version).toBe(0);
    expect(tasks.listClaims(task.task_id)).toHaveLength(1);
    expect(
      captured.some((e) => e.type === 'task.completion_claimed' && e.payload.evidence_state === 'unverified'),
    ).toBe(true);

    // A claim is not evidence: completion stays blocked.
    const err = grabError(() => tasks.transition(task.task_id, 0, 'completed'));
    expect(err).toBeInstanceOf(TaskError);
    expect(err).toMatchObject({ code: 'evidence_required' });
  });

  it('unlocks completion only after a passing validation run exists for the task', async () => {
    const { registry, supervisor, tasks } = harness();
    const repo = await registry.register(makeRepo());
    const task = tasks.create({ title: 'Verify me', state: 'validation' });

    expect(grabError(() => tasks.transition(task.task_id, 0, 'completed'))).toMatchObject({
      code: 'evidence_required',
    });

    const run = await supervisor.run(repo.repo_id, { taskId: task.task_id });
    expect(run.state).toBe('passed');
    expect(run.task_id).toBe(task.task_id);

    const done = tasks.transition(task.task_id, 0, 'completed');
    expect(done.state).toBe('completed');
    expect(done.version).toBe(1);
  });

  it('a failed validation run does not satisfy the completion guard', async () => {
    const { registry, supervisor, tasks } = harness({
      checks: [nodeCheck('unit', 'process.exit(1)')],
    });
    const repo = await registry.register(makeRepo());
    const task = tasks.create({ title: 'Still failing', state: 'validation' });
    const run = await supervisor.run(repo.repo_id, { taskId: task.task_id });
    expect(run.state).toBe('failed');
    expect(grabError(() => tasks.transition(task.task_id, 0, 'completed'))).toMatchObject({
      code: 'evidence_required',
    });
  });
});