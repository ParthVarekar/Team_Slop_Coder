import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createAutoWip,
  headOid,
  repoTopLevel,
  statusPorcelain,
  mergeTreeWriteTree,
  diffNameOnly,
  mergeBase,
  metrics,
} from '@weft/core';

const dirs: string[] = [];

function g(repo: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true }).trim();
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'weft-plumbing-'));
  dirs.push(dir);
  g(dir, ['init', '-q']);
  g(dir, ['config', 'user.name', 'Test']);
  g(dir, ['config', 'user.email', 'test@example.com']);
  g(dir, ['config', 'commit.gpgsign', 'false']);
  g(dir, ['config', 'core.autocrlf', 'false']);
  writeFileSync(join(dir, 'base.txt'), 'base\n');
  g(dir, ['add', 'base.txt']);
  g(dir, ['commit', '-q', '-m', 'base']);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      // Windows may hold transient handles; best-effort cleanup.
    }
  }
});

describe('repoTopLevel', () => {
  it('resolves the top-level from a nested directory', async () => {
    const repo = makeRepo();
    mkdirSync(join(repo, 'nested', 'deep'), { recursive: true });
    const top = await repoTopLevel(join(repo, 'nested', 'deep'));
    // git may return a POSIX-style or symlink-resolved path; compare basenames via headOid instead.
    expect(top.length).toBeGreaterThan(0);
    expect(await headOid(top)).toBe(await headOid(repo));
  });

  it('throws outside a repository', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'weft-norepo-'));
    dirs.push(dir);
    await expect(repoTopLevel(dir)).rejects.toThrow();
  });
});

describe('headOid', () => {
  it('returns the HEAD oid for a committed repo', async () => {
    const repo = makeRepo();
    const oid = await headOid(repo);
    expect(oid).toMatch(/^[0-9a-f]{40}$/);
    expect(oid).toBe(g(repo, ['rev-parse', 'HEAD']));
  });

  it('returns null for a repo with no commits', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'weft-empty-'));
    dirs.push(dir);
    g(dir, ['init', '-q']);
    expect(await headOid(dir)).toBeNull();
  });
});

describe('statusPorcelain', () => {
  it('reports a clean tree as empty', async () => {
    const repo = makeRepo();
    expect(await statusPorcelain(repo)).toEqual([]);
  });

  it('detects a modified tracked file', async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, 'base.txt'), 'changed\n');
    const files = await statusPorcelain(repo);
    expect(files).toEqual([{ path: 'base.txt', changeKind: 'modify', untracked: false }]);
  });

  it('detects an untracked file', async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, 'new.txt'), 'new\n');
    const files = await statusPorcelain(repo);
    expect(files).toEqual([{ path: 'new.txt', changeKind: 'add', untracked: true }]);
  });

  it('detects a deleted tracked file', async () => {
    const repo = makeRepo();
    rmSync(join(repo, 'base.txt'));
    const files = await statusPorcelain(repo);
    expect(files).toEqual([{ path: 'base.txt', changeKind: 'delete', untracked: false }]);
  });

  it('detects a staged add', async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, 'staged.txt'), 'staged\n');
    g(repo, ['add', 'staged.txt']);
    const files = await statusPorcelain(repo);
    expect(files).toContainEqual({ path: 'staged.txt', changeKind: 'add', untracked: false });
  });

  it('detects a rename and consumes the original-path token', async () => {
    const repo = makeRepo();
    g(repo, ['mv', 'base.txt', 'renamed.txt']);
    const files = await statusPorcelain(repo);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ path: 'renamed.txt', changeKind: 'rename' });
  });

  it('handles paths with spaces and unicode', async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, 'a file with spaces.txt'), 'x\n');
    writeFileSync(join(repo, 'café.txt'), 'y\n');
    const paths = (await statusPorcelain(repo)).map((f) => f.path).sort();
    expect(paths).toEqual(['a file with spaces.txt', 'café.txt']);
  });
});

describe('createAutoWip', () => {
  const ref = 'refs/wip/device-test/repo-test';

  it('returns null on a clean tree and creates no ref', async () => {
    const repo = makeRepo();
    const result = await createAutoWip(repo, ref, 'snapshot');
    expect(result).toBeNull();
    expect(() => g(repo, ['rev-parse', ref])).toThrow();
  });

  it('snapshots uncommitted work to a recoverable ref without touching HEAD/index/worktree', async () => {
    const repo = makeRepo();
    const headBefore = g(repo, ['rev-parse', 'HEAD']);
    writeFileSync(join(repo, 'base.txt'), 'modified for wip\n');
    writeFileSync(join(repo, 'untracked.txt'), 'untracked content\n');

    const result = await createAutoWip(repo, ref, 'auto-wip snapshot');
    expect(result).not.toBeNull();
    expect(result?.ref).toBe(ref);
    expect(result?.commit).toMatch(/^[0-9a-f]{40}$/);

    // Working tree, HEAD, and the user's index are untouched.
    expect(g(repo, ['rev-parse', 'HEAD'])).toBe(headBefore);
    expect(readFileSync(join(repo, 'base.txt'), 'utf8')).toBe('modified for wip\n');
    expect(g(repo, ['status', '--porcelain=v1', '--untracked-files=all'])).toContain('base.txt');
    // Nothing staged in the real index.
    expect(g(repo, ['diff', '--cached', '--name-only'])).toBe('');

    // The WIP commit contains the modification and the untracked file.
    expect(g(repo, ['show', `${ref}:base.txt`])).toBe('modified for wip');
    expect(g(repo, ['show', `${ref}:untracked.txt`])).toBe('untracked content');
    // Parent is the original HEAD.
    expect(g(repo, ['rev-parse', `${ref}^`])).toBe(headBefore);
  });

  it('updates the ref in place on a subsequent snapshot', async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, 'base.txt'), 'first\n');
    const first = await createAutoWip(repo, ref, 'first');
    writeFileSync(join(repo, 'base.txt'), 'second\n');
    const second = await createAutoWip(repo, ref, 'second');
    expect(second?.commit).not.toBe(first?.commit);
    expect(g(repo, ['rev-parse', ref])).toBe(second?.commit);
    expect(g(repo, ['show', `${ref}:base.txt`])).toBe('second');
  });

  it('snapshots a repo with no commits (orphan WIP)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'weft-orphan-'));
    dirs.push(dir);
    g(dir, ['init', '-q']);
    g(dir, ['config', 'user.name', 'Test']);
    g(dir, ['config', 'user.email', 'test@example.com']);
    writeFileSync(join(dir, 'only.txt'), 'orphan\n');
    const result = await createAutoWip(dir, ref, 'orphan snapshot');
    expect(result).not.toBeNull();
    expect(g(dir, ['show', `${ref}:only.txt`])).toBe('orphan');
    // A parentless commit has no parent.
    expect(() => g(dir, ['rev-parse', `${ref}^`])).toThrow();
  });
});

/** Branch `name` off `start`, write `files`, and commit. Returns the new oid. */
function branchWith(repo: string, name: string, start: string, files: Record<string, string>): string {
  g(repo, ['checkout', '-q', '-b', name, start]);
  for (const [path, content] of Object.entries(files)) writeFileSync(join(repo, path), content);
  g(repo, ['add', '-A']);
  g(repo, ['commit', '-q', '-m', name]);
  return g(repo, ['rev-parse', 'HEAD']);
}

describe('mergeTreeWriteTree (textual conflict gate)', () => {
  it('merges disjoint adds cleanly and writes a tree oid', async () => {
    const repo = makeRepo();
    const base = g(repo, ['rev-parse', 'HEAD']);
    branchWith(repo, 'A', base, { 'a.txt': 'a\n' });
    branchWith(repo, 'B', base, { 'b.txt': 'b\n' });
    const result = await mergeTreeWriteTree(repo, 'A', 'B');
    expect(result.clean).toBe(true);
    expect(result.conflictedPaths).toEqual([]);
    expect(result.treeOid).toMatch(/^[0-9a-f]{40}$/);
  });

  it('auto-merges disjoint edits to different lines of the same file', async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, 'base.txt'), 'l1\nl2\nl3\nl4\nl5\n');
    g(repo, ['commit', '-qam', 'lines']);
    const base = g(repo, ['rev-parse', 'HEAD']);
    branchWith(repo, 'A', base, { 'base.txt': 'L1\nl2\nl3\nl4\nl5\n' });
    branchWith(repo, 'B', base, { 'base.txt': 'l1\nl2\nl3\nl4\nL5\n' });
    const result = await mergeTreeWriteTree(repo, 'A', 'B');
    expect(result.clean).toBe(true);
    expect(result.conflictedPaths).toEqual([]);
  });

  it('flags a textual conflict on the same line and reports the path', async () => {
    const repo = makeRepo();
    const base = g(repo, ['rev-parse', 'HEAD']);
    branchWith(repo, 'A', base, { 'base.txt': 'A-change\n' });
    branchWith(repo, 'B', base, { 'base.txt': 'B-change\n' });
    const result = await mergeTreeWriteTree(repo, 'A', 'B');
    expect(result.clean).toBe(false);
    expect(result.conflictedPaths).toEqual(['base.txt']);
    expect(result.treeOid).toMatch(/^[0-9a-f]{40}$/);
  });

  it('flags a rename/rename conflict and reports both target paths', async () => {
    const repo = makeRepo();
    const base = g(repo, ['rev-parse', 'HEAD']);
    g(repo, ['checkout', '-q', '-b', 'A', base]);
    g(repo, ['mv', 'base.txt', 'a.txt']);
    g(repo, ['commit', '-qm', 'renameA']);
    g(repo, ['checkout', '-q', '-b', 'B', base]);
    g(repo, ['mv', 'base.txt', 'b.txt']);
    g(repo, ['commit', '-qm', 'renameB']);
    const result = await mergeTreeWriteTree(repo, 'A', 'B');
    expect(result.clean).toBe(false);
    expect(result.conflictedPaths).toContain('a.txt');
    expect(result.conflictedPaths).toContain('b.txt');
  });

  it('never mutates HEAD, index, or working tree (in-memory merge)', async () => {
    const repo = makeRepo();
    const base = g(repo, ['rev-parse', 'HEAD']);
    branchWith(repo, 'A', base, { 'base.txt': 'A\n' });
    branchWith(repo, 'B', base, { 'base.txt': 'B\n' });
    const headBefore = g(repo, ['rev-parse', 'HEAD']);
    await mergeTreeWriteTree(repo, 'A', 'B');
    expect(g(repo, ['rev-parse', 'HEAD'])).toBe(headBefore);
    expect(g(repo, ['status', '--porcelain'])).toBe('');
    expect(g(repo, ['diff', '--cached', '--name-only'])).toBe('');
    expect(() => g(repo, ['rev-parse', '--verify', 'MERGE_HEAD'])).toThrow();
  });

  it('throws on an unresolvable ref rather than reporting a false conflict', async () => {
    const repo = makeRepo();
    await expect(mergeTreeWriteTree(repo, 'HEAD', 'no-such-branch')).rejects.toThrow();
  });

  it('keeps the gate p95 <= 500ms over repeated merges', async () => {
    const repo = makeRepo();
    const base = g(repo, ['rev-parse', 'HEAD']);
    branchWith(repo, 'A', base, { 'base.txt': 'A\n' });
    branchWith(repo, 'B', base, { 'base.txt': 'B\n' });
    const hist = metrics.histogram('weft_conflict_gate_ms');
    hist.reset();
    for (let i = 0; i < 20; i++) await mergeTreeWriteTree(repo, 'A', 'B');
    const snap = hist.snapshot();
    expect(snap.count).toBe(20);
    expect(snap.p95).toBeLessThanOrEqual(500);
  });
});

describe('diffNameOnly', () => {
  it('lists files changed on a branch since it diverged from base', async () => {
    const repo = makeRepo();
    const base = g(repo, ['rev-parse', 'HEAD']);
    branchWith(repo, 'A', base, { 'base.txt': 'changed\n', 'a.txt': 'a\n' });
    const files = await diffNameOnly(repo, base, 'A');
    expect(files.sort()).toEqual(['a.txt', 'base.txt']);
  });

  it('uses three-dot semantics: excludes changes made only on base after divergence', async () => {
    const repo = makeRepo();
    const defaultBranch = g(repo, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const base = g(repo, ['rev-parse', 'HEAD']);
    branchWith(repo, 'A', base, { 'a.txt': 'a\n' });
    g(repo, ['checkout', '-q', defaultBranch]);
    writeFileSync(join(repo, 'main-only.txt'), 'm\n');
    g(repo, ['add', '-A']);
    g(repo, ['commit', '-qm', 'main advances']);
    const files = await diffNameOnly(repo, defaultBranch, 'A');
    expect(files).toEqual(['a.txt']);
  });
});

describe('mergeBase', () => {
  it('returns the common ancestor of two diverged branches', async () => {
    const repo = makeRepo();
    const base = g(repo, ['rev-parse', 'HEAD']);
    branchWith(repo, 'A', base, { 'a.txt': 'a\n' });
    branchWith(repo, 'B', base, { 'b.txt': 'b\n' });
    expect(await mergeBase(repo, 'A', 'B')).toBe(base);
  });

  it('returns null for unrelated histories', async () => {
    const repo = makeRepo();
    const base = g(repo, ['rev-parse', 'HEAD']);
    branchWith(repo, 'A', base, { 'a.txt': 'a\n' });
    g(repo, ['checkout', '-q', '--orphan', 'orphan']);
    g(repo, ['rm', '-rfq', '.']);
    writeFileSync(join(repo, 'o.txt'), 'o\n');
    g(repo, ['add', '-A']);
    g(repo, ['commit', '-qm', 'orphan']);
    expect(await mergeBase(repo, 'A', 'orphan')).toBeNull();
  });
});
