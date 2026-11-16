import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DAEMON_MIGRATIONS, migrate, openSqlite, type SqliteDatabase } from '@weft/core';
import { makeId, parseEvent, type EventEnvelope } from '@weft/protocol';
import { draftEvent } from './events.js';
import { RepoRegistry } from './repos.js';
import { ConflictDetector, ConflictDetectorError } from './conflicts.js';

const dirs: string[] = [];
const dbs: SqliteDatabase[] = [];

function g(repo: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true }).trim();
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'weft-conf-repo-'));
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

function harness(deviceId = makeId('device')) {
  const db = freshDb();
  const projectId = makeId('project');
  const registry = new RepoRegistry(db, { deviceId, projectId });
  const source = { deviceId, projectId };
  const actor = { user_id: makeId('user'), agent: null };
  const captured: EventEnvelope[] = [];
  const emit = (draft: Parameters<typeof draftEvent>[1]) => {
    const env = draftEvent(source, draft);
    parseEvent(env);
    captured.push(env);
    return { accepted: true, event_id: env.event_id };
  };
  const detector = new ConflictDetector({ deviceId, projectId, registry, emit, actor });
  return { db, registry, detector, captured, deviceId, projectId };
}

/** Create a branch off start, write files, commit; return to main afterwards. */
function taskBranch(repo: string, branch: string, start: string, files: Record<string, string>): void {
  g(repo, ['checkout', '-q', '-b', branch, start]);
  for (const [path, content] of Object.entries(files)) writeFileSync(join(repo, path), content);
  g(repo, ['add', '-A']);
  g(repo, ['commit', '-q', '-m', branch]);
  g(repo, ['checkout', '-q', 'main']);
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

describe('ConflictDetector textual gate', () => {
  it('emits a blocking textual conflict when a task branch cannot merge into base', async () => {
    const { registry, detector, captured } = harness();
    const repoPath = makeRepo();
    const repo = await registry.register(repoPath);
    const base = g(repoPath, ['rev-parse', 'HEAD']);
    // Integration base advances...
    writeFileSync(join(repoPath, 'base.txt'), 'main-change\n');
    g(repoPath, ['commit', '-qam', 'main advances']);
    // ...while the task branch edits the same line from the original base.
    taskBranch(repoPath, 'weft/task/T1', base, { 'base.txt': 'task-change\n' });

    const result = await detector.detect(repo.repo_id, [{ taskId: 'T1', branch: 'weft/task/T1' }], {
      baseRef: 'main',
    });
    expect(result.gate[0]).toMatchObject({ clean: false, conflicted_paths: ['base.txt'], error: null });
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]).toMatchObject({
      kind: 'textual',
      severity: 'blocking',
      task_ids: ['T1'],
      paths: ['base.txt'],
    });
    const event = captured.find((e) => e.type === 'conflict.detected');
    expect(event).toBeDefined();
    expect(event?.payload['canonical_key']).toBe(result.conflicts[0]?.canonical_key);
    expect(event?.repo_id).toBe(repo.repo_id);
  });

  it('reports no conflict for a branch that merges cleanly into base', async () => {
    const { registry, detector, captured } = harness();
    const repoPath = makeRepo();
    const repo = await registry.register(repoPath);
    const base = g(repoPath, ['rev-parse', 'HEAD']);
    taskBranch(repoPath, 'weft/task/T1', base, { 'a.txt': 'disjoint\n' });
    const result = await detector.detect(repo.repo_id, [{ taskId: 'T1', branch: 'weft/task/T1' }], {
      baseRef: 'main',
    });
    expect(result.gate[0]?.clean).toBe(true);
    expect(result.conflicts).toHaveLength(0);
    expect(captured.filter((e) => e.type === 'conflict.detected')).toHaveLength(0);
  });

  it('records a gate error for an unresolvable branch without throwing', async () => {
    const { registry, detector } = harness();
    const repo = await registry.register(makeRepo());
    const result = await detector.detect(repo.repo_id, [{ taskId: 'T1', branch: 'no-such-branch' }]);
    expect(result.gate[0]?.error).toBeTruthy();
    expect(result.conflicts).toHaveLength(0);
  });

  it('throws not_found for an unknown repo', async () => {
    const { detector } = harness();
    await expect(detector.detect('repo_missing', [])).rejects.toBeInstanceOf(ConflictDetectorError);
  });
});

describe('ConflictDetector pairwise file overlap', () => {
  it('warns when two task branches touch the same file', async () => {
    const { registry, detector } = harness();
    const repoPath = makeRepo();
    writeFileSync(join(repoPath, 'shared.txt'), 'l1\nl2\nl3\nl4\nl5\n');
    g(repoPath, ['add', '-A']);
    g(repoPath, ['commit', '-qm', 'shared']);
    const repo = await registry.register(repoPath);
    const base = g(repoPath, ['rev-parse', 'HEAD']);
    taskBranch(repoPath, 'weft/task/A', base, { 'shared.txt': 'L1\nl2\nl3\nl4\nl5\n' });
    taskBranch(repoPath, 'weft/task/B', base, { 'shared.txt': 'l1\nl2\nl3\nl4\nL5\n' });

    const result = await detector.detect(
      repo.repo_id,
      [
        { taskId: 'A', branch: 'weft/task/A' },
        { taskId: 'B', branch: 'weft/task/B' },
      ],
      { baseRef: 'main' },
    );
    // Disjoint lines merge cleanly into base, so no textual conflict...
    expect(result.conflicts.filter((c) => c.kind === 'textual')).toHaveLength(0);
    // ...but both edited shared.txt → one overlap warning with a sorted task pair.
    const overlap = result.conflicts.filter((c) => c.kind === 'file_overlap');
    expect(overlap).toHaveLength(1);
    expect(overlap[0]).toMatchObject({
      severity: 'warning',
      task_ids: ['A', 'B'],
      paths: ['shared.txt'],
    });
  });

  it('does not warn when task branches touch disjoint files', async () => {
    const { registry, detector } = harness();
    const repoPath = makeRepo();
    const repo = await registry.register(repoPath);
    const base = g(repoPath, ['rev-parse', 'HEAD']);
    taskBranch(repoPath, 'weft/task/A', base, { 'a.txt': 'a\n' });
    taskBranch(repoPath, 'weft/task/B', base, { 'b.txt': 'b\n' });
    const result = await detector.detect(
      repo.repo_id,
      [
        { taskId: 'A', branch: 'weft/task/A' },
        { taskId: 'B', branch: 'weft/task/B' },
      ],
      { baseRef: 'main' },
    );
    expect(result.conflicts).toHaveLength(0);
  });
});

describe('ConflictDetector canonical identity + epoch', () => {
  it('produces the same canonical key from two devices for one logical conflict', async () => {
    const repoPath = makeRepo();
    const base = g(repoPath, ['rev-parse', 'HEAD']);
    writeFileSync(join(repoPath, 'base.txt'), 'main-change\n');
    g(repoPath, ['commit', '-qam', 'main advances']);
    taskBranch(repoPath, 'weft/task/T1', base, { 'base.txt': 'task-change\n' });

    const a = harness();
    const b = harness();
    const repoA = await a.registry.register(repoPath);
    const repoB = await b.registry.register(repoPath);
    const tasks = [{ taskId: 'T1', branch: 'weft/task/T1' }];
    const ra = await a.detector.detect(repoA.repo_id, tasks, { baseRef: 'main', epoch: 1 });
    const rb = await b.detector.detect(repoB.repo_id, tasks, { baseRef: 'main', epoch: 1 });
    expect(ra.conflicts[0]?.canonical_key).toBe(rb.conflicts[0]?.canonical_key);
    // Evidence is device-attributed so the server can union both observations.
    const ea = a.captured.find((e) => e.type === 'conflict.detected')?.payload['evidence'] as Record<string, unknown>[];
    const eb = b.captured.find((e) => e.type === 'conflict.detected')?.payload['evidence'] as Record<string, unknown>[];
    expect(ea[0]?.['detector_device_id']).toBe(a.deviceId);
    expect(eb[0]?.['detector_device_id']).toBe(b.deviceId);
  });

  it('stamps the supplied detection epoch onto emitted events', async () => {
    const { registry, detector, captured } = harness();
    const repoPath = makeRepo();
    const repo = await registry.register(repoPath);
    const base = g(repoPath, ['rev-parse', 'HEAD']);
    writeFileSync(join(repoPath, 'base.txt'), 'main-change\n');
    g(repoPath, ['commit', '-qam', 'main advances']);
    taskBranch(repoPath, 'weft/task/T1', base, { 'base.txt': 'task-change\n' });
    const result = await detector.detect(repo.repo_id, [{ taskId: 'T1', branch: 'weft/task/T1' }], {
      baseRef: 'main',
      epoch: 7,
    });
    expect(result.epoch).toBe(7);
    const event = captured.find((e) => e.type === 'conflict.detected');
    expect(event?.payload['detection_epoch']).toBe(7);
  });
});