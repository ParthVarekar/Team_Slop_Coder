import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DAEMON_MIGRATIONS,
  migrate,
  openSqlite,
  worktreeList,
  type SqliteDatabase,
} from '@weft/core';
import { makeId, parseEvent, type EventEnvelope } from '@weft/protocol';
import { draftEvent } from './events.js';
import { RepoRegistry } from './repos.js';
import { WorktreeError, WorktreeManager } from './worktrees.js';

const dirs: string[] = [];
const dbs: SqliteDatabase[] = [];

function g(repo: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true }).trim();
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'weft-wt-repo-'));
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
  const worktreeRoot = mkdtempSync(join(tmpdir(), 'weft-wt-root-'));
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
  const manager = new WorktreeManager(db, {
    deviceId,
    projectId,
    worktreeRoot,
    registry,
    emit,
    actor,
  });
  return { db, registry, manager, captured, deviceId, projectId, worktreeRoot };
}

afterEach(async () => {
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

describe('WorktreeManager provisioning gate', () => {
  it('rejects a grant with neither confirmed nor provisional claim', async () => {
    const { registry, manager } = harness();
    const repo = await registry.register(makeRepo());
    await expect(
      manager.provision(repo.repo_id, {
        taskId: makeId('task'),
        confirmed: false,
        provisional: false,
      }),
    ).rejects.toMatchObject({ code: 'not_claimed' });
  });

  it('quarantines a provisional claim and blocks agent assignment', async () => {
    const { registry, manager, captured } = harness();
    const repo = await registry.register(makeRepo());
    const taskId = makeId('task');
    const wt = await manager.provision(repo.repo_id, {
      taskId,
      confirmed: false,
      provisional: true,
    });
    expect(wt.state).toBe('quarantined');
    expect(wt.quarantine).toBe(true);
    expect(wt.locked).toBe(true);
    expect(wt.owner_pid).toBeNull();
    await expect(manager.assignAgent(wt.worktree_id, 4242)).rejects.toMatchObject({
      code: 'quarantined',
    });
    expect(captured.some((e) => e.type === 'worktree.created' && e.task_id === taskId)).toBe(true);
  });

  it('provisions a confirmed claim as active and assignable', async () => {
    const { registry, manager } = harness();
    const repo = await registry.register(makeRepo());
    const taskId = makeId('task');
    const wt = await manager.provision(repo.repo_id, {
      taskId,
      confirmed: true,
      provisional: false,
    });
    expect(wt.state).toBe('active');
    expect(wt.quarantine).toBe(false);
    const assigned = await manager.assignAgent(wt.worktree_id, 4242);
    expect(assigned.owner_pid).toBe(4242);
    expect(manager.get(wt.worktree_id)?.owner_pid).toBe(4242);
  });

  it('assigns immediately when a confirmed grant carries an owner pid', async () => {
    const { registry, manager } = harness();
    const repo = await registry.register(makeRepo());
    const wt = await manager.provision(
      repo.repo_id,
      { taskId: makeId('task'), confirmed: true, provisional: false },
      { ownerPid: 99 },
    );
    expect(wt.owner_pid).toBe(99);
    expect(wt.state).toBe('active');
  });

  it('refuses to reassign a worktree already owned by another pid', async () => {
    const { registry, manager } = harness();
    const repo = await registry.register(makeRepo());
    const wt = await manager.provision(
      repo.repo_id,
      { taskId: makeId('task'), confirmed: true, provisional: false },
      { ownerPid: 1 },
    );
    await expect(manager.assignAgent(wt.worktree_id, 2)).rejects.toMatchObject({
      code: 'already_assigned',
    });
  });

  it('promotes a quarantined worktree to active when the claim is later confirmed', async () => {
    const { registry, manager } = harness();
    const repo = await registry.register(makeRepo());
    const taskId = makeId('task');
    const q = await manager.provision(repo.repo_id, {
      taskId,
      confirmed: false,
      provisional: true,
    });
    expect(q.state).toBe('quarantined');
    const active = await manager.provision(repo.repo_id, {
      taskId,
      confirmed: true,
      provisional: false,
    });
    expect(active.worktree_id).toBe(q.worktree_id);
    expect(active.state).toBe('active');
    expect(active.quarantine).toBe(false);
    await expect(manager.assignAgent(active.worktree_id, 7)).resolves.toMatchObject({
      owner_pid: 7,
    });
  });

  it('throws not_found for an unknown repo and invalid_base for a bad ref', async () => {
    const { registry, manager } = harness();
    await expect(
      manager.provision('repo_missing', {
        taskId: makeId('task'),
        confirmed: true,
        provisional: false,
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
    const repo = await registry.register(makeRepo());
    await expect(
      manager.provision(
        repo.repo_id,
        { taskId: makeId('task'), confirmed: true, provisional: false },
        { baseRef: 'refs/heads/does-not-exist' },
      ),
    ).rejects.toMatchObject({ code: 'invalid_base' });
  });
});

describe('WorktreeManager branch-per-task + one writer', () => {
  it('creates a task branch off the shared clone and emits branch + worktree events', async () => {
    const { registry, manager, captured } = harness();
    const dir = makeRepo();
    const repo = await registry.register(dir);
    const taskId = makeId('task');
    const wt = await manager.provision(repo.repo_id, {
      taskId,
      confirmed: true,
      provisional: false,
    });
    expect(wt.branch).toBe(`weft/task/${taskId}`);
    expect(wt.base_oid).toBe(repo.head_oid);
    expect(existsSync(wt.path)).toBe(true);
    expect(g(wt.path, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(wt.branch);

    const branchEvent = captured.find((e) => e.type === 'branch.created');
    expect(branchEvent?.payload).toMatchObject({
      name: wt.branch,
      head_oid: repo.head_oid,
      kind: 'task',
    });
    const wtEvent = captured.find((e) => e.type === 'worktree.created');
    expect(wtEvent?.payload).toMatchObject({ path: wt.path, branch: wt.branch, task_id: taskId });

    const list = await worktreeList(dir);
    const linked = list.find((w) => w.branch === wt.branch);
    expect(linked?.path).toBeTruthy();
    expect(linked?.locked).toBe(true);
    expect(linked?.lockReason).toContain(taskId);
  });

  it('is idempotent per task and keeps a single writer on the branch', async () => {
    const { registry, manager } = harness();
    const dir = makeRepo();
    const repo = await registry.register(dir);
    const taskId = makeId('task');
    const grant = { taskId, confirmed: true, provisional: false };
    const a = await manager.provision(repo.repo_id, grant);
    const b = await manager.provision(repo.repo_id, grant);
    expect(b.worktree_id).toBe(a.worktree_id);
    expect(manager.list({ repoId: repo.repo_id })).toHaveLength(1);
    const list = await worktreeList(dir);
    expect(list.filter((w) => w.branch === a.branch)).toHaveLength(1);
  });

  it('serializes concurrent provisions of the same task into one worktree', async () => {
    const { registry, manager } = harness();
    const repo = await registry.register(makeRepo());
    const taskId = makeId('task');
    const grant = { taskId, confirmed: true, provisional: false };
    const results = await Promise.all([
      manager.provision(repo.repo_id, grant),
      manager.provision(repo.repo_id, grant),
      manager.provision(repo.repo_id, grant),
    ]);
    const ids = new Set(results.map((r) => r.worktree_id));
    expect(ids.size).toBe(1);
    expect(manager.list({ repoId: repo.repo_id })).toHaveLength(1);
  });

  it('allows distinct tasks to branch independently off the same clone', async () => {
    const { registry, manager } = harness();
    const dir = makeRepo();
    const repo = await registry.register(dir);
    const t1 = makeId('task');
    const t2 = makeId('task');
    const a = await manager.provision(repo.repo_id, {
      taskId: t1,
      confirmed: true,
      provisional: false,
    });
    const b = await manager.provision(repo.repo_id, {
      taskId: t2,
      confirmed: true,
      provisional: false,
    });
    expect(a.branch).not.toBe(b.branch);
    expect(a.path).not.toBe(b.path);
    const list = await worktreeList(dir);
    expect(list.filter((w) => w.branch === a.branch)).toHaveLength(1);
    expect(list.filter((w) => w.branch === b.branch)).toHaveLength(1);
  });
});

describe('WorktreeManager stale-lock recovery', () => {
  it('unlocks and prunes a locked worktree whose directory is gone', async () => {
    const { registry, manager, captured } = harness();
    const dir = makeRepo();
    const repo = await registry.register(dir);
    const wt = await manager.provision(repo.repo_id, {
      taskId: makeId('task'),
      confirmed: true,
      provisional: false,
    });
    expect((await worktreeList(dir)).find((w) => w.branch === wt.branch)?.locked).toBe(true);

    rmSync(wt.path, { recursive: true, force: true });
    expect(existsSync(wt.path)).toBe(false);

    const { recovered } = await manager.recoverStale(repo.repo_id);
    expect(recovered).toContain(wt.worktree_id);
    expect(manager.get(wt.worktree_id)?.state).toBe('removed');
    const list = await worktreeList(dir);
    expect(list.some((w) => w.branch === wt.branch)).toBe(false);
    expect(
      captured.some((e) => e.type === 'worktree.removed' && e.payload.branch === wt.branch),
    ).toBe(true);
    // The branch survives recovery (work is never destroyed).
    expect(g(dir, ['rev-parse', '--verify', `refs/heads/${wt.branch}`])).toBe(wt.base_oid);
  });

  it('reports nothing recovered when all worktrees are healthy', async () => {
    const { registry, manager } = harness();
    const repo = await registry.register(makeRepo());
    await manager.provision(repo.repo_id, {
      taskId: makeId('task'),
      confirmed: true,
      provisional: false,
    });
    expect(await manager.recoverStale(repo.repo_id)).toEqual({ recovered: [] });
  });
});

describe('WorktreeManager device-namespaced auto-WIP', () => {
  it('snapshots dirty work to refs/wip/<task>/<device> without touching HEAD', async () => {
    const { registry, manager, deviceId } = harness();
    const dir = makeRepo();
    const repo = await registry.register(dir);
    const taskId = makeId('task');
    const wt = await manager.provision(repo.repo_id, {
      taskId,
      confirmed: true,
      provisional: false,
    });
    expect(wt.wip_ref).toBe(`refs/wip/${taskId}/${deviceId}`);
    writeFileSync(join(wt.path, 'base.txt'), 'precious worktree work\n');
    const wip = await manager.snapshotWip(wt.worktree_id);
    expect(wip?.ref).toBe(wt.wip_ref);
    expect(g(dir, ['show', `${wt.wip_ref}:base.txt`])).toBe('precious worktree work');
    expect(g(wt.path, ['rev-parse', 'HEAD'])).toBe(wt.base_oid);
  });

  it('returns null on a clean worktree', async () => {
    const { registry, manager } = harness();
    const repo = await registry.register(makeRepo());
    const wt = await manager.provision(repo.repo_id, {
      taskId: makeId('task'),
      confirmed: true,
      provisional: false,
    });
    expect(await manager.snapshotWip(wt.worktree_id)).toBeNull();
  });

  it('keeps separate WIP refs for distinct tasks in one clone', async () => {
    const { registry, manager, deviceId } = harness();
    const dir = makeRepo();
    const repo = await registry.register(dir);
    const t1 = makeId('task');
    const t2 = makeId('task');
    const a = await manager.provision(repo.repo_id, {
      taskId: t1,
      confirmed: true,
      provisional: false,
    });
    const b = await manager.provision(repo.repo_id, {
      taskId: t2,
      confirmed: true,
      provisional: false,
    });
    writeFileSync(join(a.path, 'base.txt'), 'work A\n');
    writeFileSync(join(b.path, 'base.txt'), 'work B\n');
    await manager.snapshotWip(a.worktree_id);
    await manager.snapshotWip(b.worktree_id);
    expect(g(dir, ['show', `refs/wip/${t1}/${deviceId}:base.txt`])).toBe('work A');
    expect(g(dir, ['show', `refs/wip/${t2}/${deviceId}:base.txt`])).toBe('work B');
  });

  it('preserves divergent work per device on the same task (no cross-device overwrite)', async () => {
    const deviceA = makeId('device');
    const deviceB = makeId('device');
    const a = harness(deviceA);
    const b = harness(deviceB);
    const taskId = makeId('task');
    const repoA = await a.registry.register(makeRepo());
    const repoB = await b.registry.register(makeRepo());
    const wtA = await a.manager.provision(repoA.repo_id, {
      taskId,
      confirmed: true,
      provisional: false,
    });
    const wtB = await b.manager.provision(repoB.repo_id, {
      taskId,
      confirmed: true,
      provisional: false,
    });
    expect(wtA.wip_ref).toBe(`refs/wip/${taskId}/${deviceA}`);
    expect(wtB.wip_ref).toBe(`refs/wip/${taskId}/${deviceB}`);
    expect(wtA.wip_ref).not.toBe(wtB.wip_ref);

    writeFileSync(join(wtA.path, 'base.txt'), 'device A divergence\n');
    writeFileSync(join(wtB.path, 'base.txt'), 'device B divergence\n');
    await a.manager.snapshotWip(wtA.worktree_id);
    await b.manager.snapshotWip(wtB.worktree_id);

    expect(g(repoA.root_path, ['show', `${wtA.wip_ref}:base.txt`])).toBe('device A divergence');
    expect(g(repoB.root_path, ['show', `${wtB.wip_ref}:base.txt`])).toBe('device B divergence');
    // Neither clone carries the other device's namespaced ref.
    expect(() => g(repoA.root_path, ['rev-parse', '--verify', wtB.wip_ref])).toThrow();
    expect(() => g(repoB.root_path, ['rev-parse', '--verify', wtA.wip_ref])).toThrow();
  });
});

describe('WorktreeManager quarantine discard + removal', () => {
  it('discards a losing provisional worktree but preserves its branch and WIP', async () => {
    const { registry, manager, captured, deviceId } = harness();
    const dir = makeRepo();
    const repo = await registry.register(dir);
    const taskId = makeId('task');
    const wt = await manager.provision(repo.repo_id, {
      taskId,
      confirmed: false,
      provisional: true,
    });
    writeFileSync(join(wt.path, 'base.txt'), 'provisional work that must survive\n');

    const result = await manager.discardQuarantine(taskId);
    expect(result.discarded).toContain(wt.worktree_id);
    expect(result.wip).toHaveLength(1);
    expect(manager.get(wt.worktree_id)?.state).toBe('discarded');
    expect(existsSync(wt.path)).toBe(false);

    // Branch + device-namespaced WIP ref are recoverable, never destroyed.
    expect(g(dir, ['rev-parse', '--verify', `refs/heads/${wt.branch}`])).toBe(wt.base_oid);
    expect(g(dir, ['show', `refs/wip/${taskId}/${deviceId}:base.txt`])).toBe(
      'provisional work that must survive',
    );
    expect(captured.some((e) => e.type === 'worktree.removed' && e.task_id === taskId)).toBe(true);
    expect((await worktreeList(dir)).some((w) => w.branch === wt.branch)).toBe(false);
  });

  it('is idempotent: discarding an already-discarded task removes nothing further', async () => {
    const { registry, manager } = harness();
    const repo = await registry.register(makeRepo());
    const taskId = makeId('task');
    await manager.provision(repo.repo_id, { taskId, confirmed: false, provisional: true });
    const first = await manager.discardQuarantine(taskId);
    expect(first.discarded).toHaveLength(1);
    const second = await manager.discardQuarantine(taskId);
    expect(second.discarded).toEqual([]);
  });

  it('explicit removal snapshots work and keeps the branch + WIP ref', async () => {
    const { registry, manager, deviceId } = harness();
    const dir = makeRepo();
    const repo = await registry.register(dir);
    const taskId = makeId('task');
    const wt = await manager.provision(repo.repo_id, {
      taskId,
      confirmed: true,
      provisional: false,
    });
    writeFileSync(join(wt.path, 'base.txt'), 'active work in progress\n');
    const result = await manager.remove(wt.worktree_id);
    expect(result.removed).toBe(true);
    expect(result.wip?.ref).toBe(`refs/wip/${taskId}/${deviceId}`);
    expect(manager.get(wt.worktree_id)?.state).toBe('removed');
    expect(existsSync(wt.path)).toBe(false);
    expect(g(dir, ['show', `refs/wip/${taskId}/${deviceId}:base.txt`])).toBe(
      'active work in progress',
    );
    expect(g(dir, ['rev-parse', '--verify', `refs/heads/${wt.branch}`])).toBe(wt.base_oid);
  });

  it('throws not_found for unknown worktree operations', async () => {
    const { manager } = harness();
    expect(manager.get('ws_missing')).toBeUndefined();
    await expect(manager.assignAgent('ws_missing', 1)).rejects.toBeInstanceOf(WorktreeError);
    await expect(manager.snapshotWip('ws_missing')).rejects.toMatchObject({ code: 'not_found' });
    await expect(manager.remove('ws_missing')).rejects.toMatchObject({ code: 'not_found' });
  });
});
