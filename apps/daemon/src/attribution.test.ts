import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DAEMON_MIGRATIONS,
  migrate,
  openSqlite,
  showFile,
  headOid,
  type SqliteDatabase,
  type ValidationCheckConfig,
} from '@weft/core';
import { makeId, parseEvent } from '@weft/protocol';
import { AttributionEngine } from './attribution.js';
import { draftEvent } from './events.js';
import { RepoRegistry } from './repos.js';
import { ValidationSupervisor } from './validation.js';

const dirs: string[] = [];
const dbs: SqliteDatabase[] = [];

function g(repo: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true }).trim();
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'weft-attr-repo-'));
  dirs.push(dir);
  g(dir, ['init', '-q', '-b', 'main']);
  g(dir, ['config', 'user.name', 'Test']);
  g(dir, ['config', 'user.email', 'test@example.com']);
  g(dir, ['config', 'commit.gpgsign', 'false']);
  g(dir, ['config', 'core.autocrlf', 'false']);
  writeFileSync(join(dir, 'fileA.txt'), 'clean\n');
  writeFileSync(join(dir, 'fileB.txt'), 'v1\n');
  g(dir, ['add', '.']);
  g(dir, ['commit', '-q', '-m', 'base']);
  return dir;
}

function commitFile(repo: string, file: string, content: string, message: string): string {
  writeFileSync(join(repo, file), content);
  g(repo, ['add', file]);
  g(repo, ['commit', '-q', '-m', message]);
  return g(repo, ['rev-parse', 'HEAD']);
}

// A check that fails iff fileA.txt contains the planted regression marker.
const bugCheck: ValidationCheckConfig = {
  check_id: 'unit',
  command: process.execPath,
  args: [
    '-e',
    "const fs=require('fs'); process.exit(fs.readFileSync('fileA.txt','utf8').includes('BUG')?1:0)",
  ],
  selection: 'full',
};

function harness(checks: ValidationCheckConfig[] = [bugCheck]) {
  const db = openSqlite(':memory:');
  migrate(db, DAEMON_MIGRATIONS);
  dbs.push(db);
  const deviceId = makeId('device');
  const projectId = makeId('project');
  const registry = new RepoRegistry(db, { deviceId, projectId });
  const worktreeRoot = mkdtempSync(join(tmpdir(), 'weft-attr-root-'));
  dirs.push(worktreeRoot);
  const source = { deviceId, projectId };
  const actor = { user_id: makeId('user'), agent: null };
  const supervisor = new ValidationSupervisor(db, {
    deviceId,
    projectId,
    worktreeRoot,
    registry,
    actor,
    validation: { timeoutMs: 5000, outputCapBytes: 1_048_576, excerptBytes: 4096, checks },
    emit: (draft) => {
      const env = draftEvent(source, draft);
      parseEvent(env);
      return { accepted: true, event_id: env.event_id };
    },
  });
  const engine = new AttributionEngine({ registry, validation: supervisor, worktreeRoot });
  return { registry, supervisor, engine, worktreeRoot };
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

describe('AttributionEngine changes-since-healthy', () => {
  it('enumerates commits since the baseline and ranks the planted culprit first', async () => {
    const { registry, engine } = harness();
    const repoPath = makeRepo();
    const repo = await registry.register(repoPath);
    const baseline = (await headOid(repoPath))!;
    const culprit = commitFile(repoPath, 'fileA.txt', 'BUG\n', 'culprit: plant regression');
    commitFile(repoPath, 'fileB.txt', 'v2\n', 'unrelated: improve fileB');

    const suspects = await engine.buildSuspects(repo.repo_id, baseline);
    expect(suspects.map((s) => s.oid)).toEqual([culprit, (await headOid(repoPath))!]);

    const ranked = await engine.attribute(repo.repo_id, {
      baselineOid: baseline,
      failingChecks: [{ check_id: 'unit', paths: ['fileA.txt'] }],
    });
    expect(ranked[0]?.oid).toBe(culprit);
    expect(ranked[0]?.overlap).toBe(1);
  });

  it('confirms the culprit by revert-test and preserves unrelated work', async () => {
    const { registry, supervisor, engine } = harness();
    const repoPath = makeRepo();
    const repo = await registry.register(repoPath);
    const baseline = (await headOid(repoPath))!;

    // Healthy at baseline; broken after the culprit lands.
    expect((await supervisor.run(repo.repo_id, { candidate: baseline })).state).toBe('passed');
    const culprit = commitFile(repoPath, 'fileA.txt', 'BUG\n', 'culprit');
    commitFile(repoPath, 'fileB.txt', 'v2\n', 'unrelated');
    expect((await supervisor.run(repo.repo_id)).state).toBe('failed');

    const result = await engine.revertTest(repo.repo_id, culprit);
    expect(result.confirmed).toBe(true);
    if (!result.confirmed) return;
    expect(result.revertedPaths).toContain('fileA.txt');
    // Reverted tree: culprit undone, unrelated work intact.
    expect(await showFile(repoPath, result.revertOid, 'fileA.txt')).toBe('clean\n');
    expect(await showFile(repoPath, result.revertOid, 'fileB.txt')).toBe('v2\n');
    // The user's HEAD is untouched (the revert is a dangling object for the queue).
    expect(await showFile(repoPath, 'HEAD', 'fileA.txt')).toBe('BUG\n');
  });

  it('does not confirm a suspect whose revert leaves the checks failing', async () => {
    const { registry, engine } = harness();
    const repoPath = makeRepo();
    const repo = await registry.register(repoPath);
    commitFile(repoPath, 'fileA.txt', 'BUG\n', 'culprit');
    const unrelated = commitFile(repoPath, 'fileB.txt', 'v2\n', 'unrelated');

    // Reverting the unrelated commit does not remove the BUG → not confirmed.
    const result = await engine.revertTest(repo.repo_id, unrelated);
    expect(result.confirmed).toBe(false);
    if (result.confirmed) return;
    expect(result.reason).toBe('validation_failed');
  });

  it('rejects an unknown repo with not_found', async () => {
    const { engine } = harness();
    await expect(engine.buildSuspects('repo_missing', 'x'.repeat(40))).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});
