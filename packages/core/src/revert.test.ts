import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  commitParents,
  currentBranch,
  headOid,
  revertCommit,
  showFile,
  worktreeList,
} from '@weft/core';

const dirs: string[] = [];

function g(repo: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true }).trim();
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'weft-revert-'));
  dirs.push(dir);
  g(dir, ['init', '-q', '-b', 'main']);
  g(dir, ['config', 'user.name', 'Test']);
  g(dir, ['config', 'user.email', 'test@example.com']);
  g(dir, ['config', 'commit.gpgsign', 'false']);
  g(dir, ['config', 'core.autocrlf', 'false']);
  writeFileSync(join(dir, 'fileA.txt'), 'v1\n');
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

function worktreeRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'weft-revert-root-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      /* Windows transient handles */
    }
  }
});

describe('revertCommit preserves unrelated work', () => {
  it('inverts only the culprit, keeps later commits, and never touches HEAD/branch', async () => {
    const repo = makeRepo();
    const culprit = commitFile(repo, 'fileA.txt', 'v2\n', 'culprit: break fileA');
    const unrelated = commitFile(repo, 'fileB.txt', 'v2\n', 'unrelated: improve fileB');
    const headBefore = await headOid(repo);
    const branchBefore = await currentBranch(repo);

    const result = await revertCommit(repo, culprit, {
      worktreeRoot: worktreeRoot(),
      from: 'HEAD',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The revert commit's parent is the current tip; unrelated work is preserved.
    expect(await commitParents(repo, result.revertOid)).toEqual([unrelated]);
    expect(await showFile(repo, result.revertOid, 'fileA.txt')).toBe('v1\n');
    expect(await showFile(repo, result.revertOid, 'fileB.txt')).toBe('v2\n');
    expect(result.revertedPaths).toContain('fileA.txt');

    // The user's HEAD, branch, and working tree are untouched (revert is dangling).
    expect(await headOid(repo)).toBe(headBefore);
    expect(await currentBranch(repo)).toBe(branchBefore);
    expect(await showFile(repo, 'HEAD', 'fileA.txt')).toBe('v2\n');
  });

  it('removes the isolated revert worktree after landing the revert object', async () => {
    const repo = makeRepo();
    const culprit = commitFile(repo, 'fileA.txt', 'v2\n', 'culprit');
    commitFile(repo, 'fileB.txt', 'v2\n', 'unrelated');
    const root = worktreeRoot();
    const result = await revertCommit(repo, culprit, { worktreeRoot: root, from: 'HEAD' });
    expect(result.ok).toBe(true);
    const trees = await worktreeList(repo);
    expect(trees).toHaveLength(1);
    expect(readdirSync(root).filter((n) => n.startsWith('revert-'))).toHaveLength(0);
  });
});

describe('revertCommit never forces over conflicting later work', () => {
  it('reports a conflict and leaves HEAD unchanged when later work rewrote the same lines', async () => {
    const repo = makeRepo();
    const culprit = commitFile(repo, 'fileA.txt', 'v2\n', 'culprit: fileA v2');
    commitFile(repo, 'fileA.txt', 'v3\n', 'later: fileA v3 (rewrites culprit lines)');
    const headBefore = await headOid(repo);

    const result = await revertCommit(repo, culprit, {
      worktreeRoot: worktreeRoot(),
      from: 'HEAD',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('conflict');
    expect(result.conflictedPaths).toContain('fileA.txt');
    expect(await headOid(repo)).toBe(headBefore);
    expect(await showFile(repo, 'HEAD', 'fileA.txt')).toBe('v3\n');
    // No revert worktree is left behind after a conflict.
    const trees = await worktreeList(repo);
    expect(trees).toHaveLength(1);
  });

  it('throws on an invalid culprit oid', async () => {
    const repo = makeRepo();
    await expect(
      revertCommit(repo, 'not-an-oid', { worktreeRoot: worktreeRoot() }),
    ).rejects.toThrow(/invalid oid/);
  });

  it('returns error when the from ref cannot be resolved', async () => {
    const repo = makeRepo();
    const culprit = commitFile(repo, 'fileA.txt', 'v2\n', 'culprit');
    const result = await revertCommit(repo, culprit, {
      worktreeRoot: worktreeRoot(),
      from: 'refs/heads/does-not-exist',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('error');
  });
});
