import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { metrics } from './metrics.js';

const execFileAsync = promisify(execFile);

const gateLatency = metrics.histogram(
  'weft_conflict_gate_ms',
  'git merge-tree --write-tree textual conflict gate latency (ms)',
);

const OID_RE = /^[0-9a-f]{40,64}$/;

export interface GitExecOptions {
  cwd: string;
  binary?: string | undefined;
  env?: Record<string, string> | undefined;
}

async function git(args: string[], options: GitExecOptions): Promise<string> {
  const { stdout } = await execFileAsync(options.binary ?? 'git', args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  return stdout;
}

/** Resolve the repository top-level for a path (throws if not a git repo). */
export async function repoTopLevel(path: string, binary?: string): Promise<string> {
  return (await git(['rev-parse', '--show-toplevel'], { cwd: path, binary })).trim();
}

export async function headOid(repo: string, binary?: string): Promise<string | null> {
  try {
    return (await git(['rev-parse', '--verify', 'HEAD'], { cwd: repo, binary })).trim();
  } catch {
    return null;
  }
}

/** origin remote URL, or null when the repo has no origin configured. */
export async function remoteUrl(repo: string, binary?: string): Promise<string | null> {
  try {
    const url = (await git(['config', '--get', 'remote.origin.url'], { cwd: repo, binary })).trim();
    return url.length > 0 ? url : null;
  } catch {
    return null;
  }
}

/** Current branch name, or null on a detached HEAD / unborn branch. */
export async function currentBranch(repo: string, binary?: string): Promise<string | null> {
  try {
    const name = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo, binary })).trim();
    return name.length > 0 && name !== 'HEAD' ? name : null;
  } catch {
    return null;
  }
}

export type ChangeKind = 'add' | 'modify' | 'delete' | 'rename';

export interface FileStatus {
  path: string;
  changeKind: ChangeKind;
  untracked: boolean;
}

function classify(xy: string): { kind: ChangeKind; untracked: boolean } | null {
  if (xy === '??') return { kind: 'add', untracked: true };
  if (xy === '!!') return null;
  const code = xy[1] !== ' ' && xy[1] !== undefined ? xy[1] : xy[0];
  switch (code) {
    case 'A':
      return { kind: 'add', untracked: false };
    case 'D':
      return { kind: 'delete', untracked: false };
    case 'R':
      return { kind: 'rename', untracked: false };
    case 'M':
    case 'T':
      return { kind: 'modify', untracked: false };
    default:
      return { kind: 'modify', untracked: false };
  }
}

/**
 * Parse `git status --porcelain=v1 -z` (NUL-separated, rename-aware) into the
 * current dirty set. git status is the source of truth; watcher events are hints.
 */
export async function statusPorcelain(repo: string, binary?: string): Promise<FileStatus[]> {
  const out = await git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
    cwd: repo,
    binary,
  });
  const tokens = out.split('\0').filter((t) => t.length > 0);
  const files: FileStatus[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const entry = tokens[i] as string;
    const xy = entry.slice(0, 2);
    const path = entry.slice(3);
    const classified = classify(xy);
    if (!classified) continue;
    if (xy[0] === 'R' || xy[0] === 'C') i++; // consume the original-path token
    files.push({ path, changeKind: classified.kind, untracked: classified.untracked });
  }
  return files;
}

export interface AutoWipResult {
  commit: string;
  tree: string;
  ref: string;
}

/**
 * Snapshot all uncommitted work (tracked + untracked) into a hidden, device-
 * namespaced ref using a temporary index — never touching the user's index,
 * HEAD, or working tree. Returns null when there is nothing to snapshot. The
 * commit is durable, diffable, and reflog-recoverable; stash is deliberately
 * avoided (shared refs/stash interleaves across worktrees).
 */
export async function createAutoWip(
  repo: string,
  ref: string,
  message: string,
  binary?: string,
): Promise<AutoWipResult | null> {
  const tempIndex = join(tmpdir(), `weft-wip-${randomUUID()}.idx`);
  const env = {
    GIT_INDEX_FILE: tempIndex,
    GIT_AUTHOR_NAME: 'Weft Auto-WIP',
    GIT_AUTHOR_EMAIL: 'weft@localhost',
    GIT_COMMITTER_NAME: 'Weft Auto-WIP',
    GIT_COMMITTER_EMAIL: 'weft@localhost',
  };
  try {
    const head = await headOid(repo, binary);
    if (head) await git(['read-tree', 'HEAD'], { cwd: repo, binary, env });
    await git(['add', '-A'], { cwd: repo, binary, env });
    const tree = (await git(['write-tree'], { cwd: repo, binary, env })).trim();
    if (head) {
      const headTree = (await git(['rev-parse', 'HEAD^{tree}'], { cwd: repo, binary })).trim();
      if (tree === headTree) return null;
    }
    const parents = head ? ['-p', head] : [];
    const commit = (
      await git(['commit-tree', tree, ...parents, '-m', message], { cwd: repo, binary, env })
    ).trim();
    await git(['update-ref', ref, commit], { cwd: repo, binary });
    return { commit, tree, ref };
  } finally {
    rmSync(tempIndex, { force: true });
  }
}

/** Resolve a revision to a commit oid, or null when it does not exist. */
export async function revParse(repo: string, rev: string, binary?: string): Promise<string | null> {
  try {
    const out = await git(['rev-parse', '--verify', '--quiet', `${rev}^{commit}`], {
      cwd: repo,
      binary,
    });
    const oid = out.trim();
    return oid.length > 0 ? oid : null;
  } catch {
    return null;
  }
}

/** Resolve a revision to its tree oid, or null when it does not exist. */
export async function treeOid(repo: string, rev: string, binary?: string): Promise<string | null> {
  try {
    const out = await git(['rev-parse', '--verify', '--quiet', `${rev}^{tree}`], {
      cwd: repo,
      binary,
    });
    const oid = out.trim();
    return oid.length > 0 ? oid : null;
  } catch {
    return null;
  }
}

export async function branchExists(repo: string, name: string, binary?: string): Promise<boolean> {
  return (await revParse(repo, `refs/heads/${name}`, binary)) !== null;
}

/** Create a branch at startPoint. Fails if the branch already exists. */
export async function branchCreate(
  repo: string,
  name: string,
  startPoint: string,
  binary?: string,
): Promise<void> {
  await git(['branch', name, startPoint], { cwd: repo, binary });
}

export interface WorktreeInfo {
  path: string;
  head: string | null;
  /** Short branch name (refs/heads/ stripped), or null on a detached HEAD. */
  branch: string | null;
  detached: boolean;
  locked: boolean;
  lockReason: string | null;
  prunable: boolean;
  pruneReason: string | null;
}

/** Parse `git worktree list --porcelain` (blank-line separated records). */
export async function worktreeList(repo: string, binary?: string): Promise<WorktreeInfo[]> {
  const out = await git(['worktree', 'list', '--porcelain'], { cwd: repo, binary });
  const infos: WorktreeInfo[] = [];
  for (const block of out.split('\n\n')) {
    if (block.trim().length === 0) continue;
    const info: WorktreeInfo = {
      path: '',
      head: null,
      branch: null,
      detached: false,
      locked: false,
      lockReason: null,
      prunable: false,
      pruneReason: null,
    };
    for (const line of block.split('\n')) {
      if (line.startsWith('worktree ')) info.path = line.slice(9);
      else if (line.startsWith('HEAD ')) info.head = line.slice(5);
      else if (line.startsWith('branch ')) {
        const ref = line.slice(7);
        info.branch = ref.startsWith('refs/heads/') ? ref.slice(11) : ref;
      } else if (line === 'detached') info.detached = true;
      else if (line === 'locked') info.locked = true;
      else if (line.startsWith('locked ')) {
        info.locked = true;
        info.lockReason = line.slice(7);
      } else if (line === 'prunable') info.prunable = true;
      else if (line.startsWith('prunable ')) {
        info.prunable = true;
        info.pruneReason = line.slice(9);
      }
    }
    if (info.path) infos.push(info);
  }
  return infos;
}

export interface WorktreeAddOptions {
  lock?: boolean;
  lockReason?: string | undefined;
  binary?: string | undefined;
}

/** Check out an existing branch into a new linked worktree (optionally locked). */
export async function worktreeAdd(
  repo: string,
  path: string,
  branch: string,
  options: WorktreeAddOptions = {},
): Promise<void> {
  const args = ['worktree', 'add'];
  if (options.lock) {
    args.push('--lock');
    if (options.lockReason) args.push('--reason', options.lockReason);
  }
  args.push(path, branch);
  await git(args, { cwd: repo, binary: options.binary });
}

/** Check out a commit into a new linked worktree on a detached HEAD (no branch). */
export async function worktreeAddDetached(
  repo: string,
  path: string,
  commit: string,
  options: WorktreeAddOptions = {},
): Promise<void> {
  const args = ['worktree', 'add', '--detach'];
  if (options.lock) {
    args.push('--lock');
    if (options.lockReason) args.push('--reason', options.lockReason);
  }
  args.push(path, commit);
  await git(args, { cwd: repo, binary: options.binary });
}

/** Remove a linked worktree. force is required when the working tree is dirty. */
export async function worktreeRemove(
  repo: string,
  path: string,
  options: { force?: boolean; binary?: string | undefined } = {},
): Promise<void> {
  const args = ['worktree', 'remove'];
  if (options.force) args.push('--force');
  args.push(path);
  await git(args, { cwd: repo, binary: options.binary });
}

export async function worktreeLock(
  repo: string,
  path: string,
  reason?: string,
  binary?: string,
): Promise<void> {
  const args = ['worktree', 'lock'];
  if (reason) args.push('--reason', reason);
  args.push(path);
  await git(args, { cwd: repo, binary });
}

export async function worktreeUnlock(repo: string, path: string, binary?: string): Promise<void> {
  await git(['worktree', 'unlock', path], { cwd: repo, binary });
}

/** Drop admin entries for worktrees whose directories are gone (skips locked). */
export async function worktreePrune(repo: string, binary?: string): Promise<void> {
  await git(['worktree', 'prune'], { cwd: repo, binary });
}

/** Common ancestor commit of two refs, or null when they share no history. */
export async function mergeBase(
  repo: string,
  a: string,
  b: string,
  binary?: string,
): Promise<string | null> {
  try {
    const oid = (await git(['merge-base', a, b], { cwd: repo, binary })).trim();
    return oid.length > 0 ? oid : null;
  } catch {
    return null;
  }
}

/**
 * Files changed on `branch` since it diverged from `base` (three-dot diff against
 * the merge base). NUL-delimited so paths are never C-quoted. Used for pairwise
 * file-overlap detection: intersect the change sets of two task branches.
 */
export async function diffNameOnly(
  repo: string,
  base: string,
  branch: string,
  binary?: string,
): Promise<string[]> {
  const out = await git(['diff', '--name-only', '-z', `${base}...${branch}`], { cwd: repo, binary });
  return out.split('\0').filter((p) => p.length > 0);
}

/** Tracked files in the index/working tree, optionally filtered by pathspec. NUL-delimited. */
export async function lsFiles(
  repo: string,
  pathspecs: string[] = [],
  binary?: string,
): Promise<string[]> {
  const args = ['ls-files', '-z'];
  if (pathspecs.length > 0) args.push('--', ...pathspecs);
  const out = await git(args, { cwd: repo, binary });
  return out.split('\0').filter((p) => p.length > 0);
}

/** Every blob path at a ref (recursive). NUL-delimited so paths are never C-quoted. */
export async function lsTree(repo: string, ref: string, binary?: string): Promise<string[]> {
  const out = await git(['ls-tree', '-r', '--name-only', '-z', ref], { cwd: repo, binary });
  return out.split('\0').filter((p) => p.length > 0);
}

/** UTF-8 content of a file at a ref. Throws when the path is absent at that ref. */
export async function showFile(
  repo: string,
  ref: string,
  path: string,
  binary?: string,
): Promise<string> {
  return git(['show', `${ref}:${path}`], { cwd: repo, binary });
}

export interface MergeTreeResult {
  /** True when the in-memory merge produced no conflicts. */
  clean: boolean;
  /** OID of the merged toplevel tree (present even on conflict). */
  treeOid: string;
  /** Paths git could not auto-merge (empty when clean). */
  conflictedPaths: string[];
}

/**
 * Textual conflict gate: run `git merge-tree --write-tree` (git >= 2.38) to merge
 * `branch` into `base` entirely in memory — no index, HEAD, or working-tree
 * mutation. Exit 0 = clean; exit 1 with a tree OID = conflicts; any other failure
 * (bad ref, unrelated histories) throws. Latency is observed for the p95 gate.
 */
export async function mergeTreeWriteTree(
  repo: string,
  base: string,
  branch: string,
  binary?: string,
): Promise<MergeTreeResult> {
  const started = performance.now();
  const args = ['merge-tree', '--write-tree', '--name-only', '-z', base, branch];
  const opts = {
    cwd: repo,
    env: { ...process.env },
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  };
  try {
    let stdout: string;
    let clean: boolean;
    try {
      stdout = (await execFileAsync(binary ?? 'git', args, opts)).stdout;
      clean = true;
    } catch (err) {
      const e = err as { code?: number; stdout?: string; stderr?: string };
      const out = e.stdout ?? '';
      const oid = out.split('\0')[0]?.trim() ?? '';
      // Exit 1 is ambiguous: conflicts (tree OID present) vs bad ref (no OID).
      if (e.code !== 1 || !OID_RE.test(oid)) {
        throw new Error(`git merge-tree failed (exit ${e.code ?? '?'}): ${(e.stderr ?? '').trim()}`);
      }
      stdout = out;
      clean = false;
    }
    const tokens = stdout.split('\0');
    const treeOid = tokens[0]?.trim() ?? '';
    const conflictedPaths: string[] = [];
    for (let i = 1; i < tokens.length; i++) {
      const token = tokens[i];
      if (token === undefined || token.length === 0) break;
      conflictedPaths.push(token);
    }
    return { clean, treeOid, conflictedPaths };
  } finally {
    gateLatency.observe(performance.now() - started);
  }
}
