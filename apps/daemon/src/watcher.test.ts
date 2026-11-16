import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DAEMON_MIGRATIONS, migrate, openSqlite, type SqliteDatabase } from '@weft/core';
import { makeId, parseEvent, type EventEnvelope } from '@weft/protocol';
import { draftEvent } from './events.js';
import { RepoError, RepoRegistry } from './repos.js';
import {
  PollBackend,
  Watcher,
  detectBackend,
  type WatchBackend,
  type WatchSubscription,
} from './watcher.js';

const dirs: string[] = [];
const dbs: SqliteDatabase[] = [];

function g(repo: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true }).trim();
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'weft-watch-'));
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

class FakeBackend implements WatchBackend {
  readonly name = 'poll' as const;
  readonly hints = new Map<string, () => void>();
  readonly closed: string[] = [];
  failSubscribe = false;

  async subscribe(dir: string, onHint: () => void): Promise<WatchSubscription> {
    if (this.failSubscribe) throw new Error('native subscribe boom');
    this.hints.set(dir, onHint);
    return {
      close: () => {
        this.closed.push(dir);
        this.hints.delete(dir);
      },
    };
  }

  fire(dir: string): void {
    this.hints.get(dir)?.();
  }
}

function harness(
  backend: WatchBackend,
  opts: { autoWip?: boolean; wipIntervalMs?: number; debounceMs?: number } = {},
) {
  const db = freshDb();
  const deviceId = makeId('device');
  const projectId = makeId('project');
  const registry = new RepoRegistry(db, { deviceId, projectId });
  const source = { deviceId, projectId };
  const actor = { user_id: makeId('user'), agent: null };
  const captured: EventEnvelope[] = [];
  const emit = (draft: Parameters<typeof draftEvent>[1]) => {
    const env = draftEvent(source, draft);
    parseEvent(env); // protocol fidelity: every emitted event must validate
    captured.push(env);
    return { accepted: true, event_id: env.event_id };
  };
  const watcher = new Watcher({
    registry,
    emit,
    actor,
    backend,
    autoWip: opts.autoWip ?? false,
    ...(opts.wipIntervalMs !== undefined ? { wipIntervalMs: opts.wipIntervalMs } : {}),
    debounceMs: opts.debounceMs ?? 50,
    maxWaitMs: 10_000,
    pollMs: 10_000,
  });
  return { db, registry, watcher, captured, deviceId, projectId };
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

describe('RepoRegistry', () => {
  it('registers a repo with canonical root, name, wip ref and head', async () => {
    const { registry } = harness(new FakeBackend());
    const dir = makeRepo();
    const repo = await registry.register(dir);
    expect(repo.repo_id).toMatch(/^repo_/);
    expect(repo.name).toBe(dir.split(/[\\/]/).pop());
    expect(repo.root_path.length).toBeGreaterThan(0);
    expect(repo.head_oid).toMatch(/^[0-9a-f]{40}$/);
    expect(repo.default_branch).toBe('main');
    expect(repo.wip_ref).toBe(`refs/wip/${repo.device_id}/${repo.repo_id}`);
    expect(repo.state).toBe('active');
  });

  it('is idempotent per canonical path and resolves nested dirs', async () => {
    const { registry } = harness(new FakeBackend());
    const dir = makeRepo();
    const a = await registry.register(dir);
    const b = await registry.register(dir);
    expect(b.repo_id).toBe(a.repo_id);
    expect(registry.list()).toHaveLength(1);
  });

  it('captures the origin remote url', async () => {
    const { registry } = harness(new FakeBackend());
    const dir = makeRepo();
    g(dir, ['remote', 'add', 'origin', 'https://example.com/team/repo.git']);
    const repo = await registry.register(dir);
    expect(repo.remote_url).toBe('https://example.com/team/repo.git');
  });

  it('rejects a non-repository path', async () => {
    const { registry } = harness(new FakeBackend());
    const dir = mkdtempSync(join(tmpdir(), 'weft-norepo-'));
    dirs.push(dir);
    await expect(registry.register(dir)).rejects.toBeInstanceOf(RepoError);
    await expect(registry.register(dir)).rejects.toMatchObject({ code: 'not_a_repo' });
  });

  it('archives repos out of the active list', async () => {
    const { registry } = harness(new FakeBackend());
    const repo = await registry.register(makeRepo());
    expect(registry.list({ state: 'active' })).toHaveLength(1);
    expect(registry.archive(repo.repo_id)).toBe(true);
    expect(registry.list({ state: 'active' })).toHaveLength(0);
    expect(registry.list({ state: 'archived' })).toHaveLength(1);
    expect(registry.archive('repo_missing')).toBe(false);
  });

  it('round-trips file state and records scan/wip metadata', async () => {
    const { registry } = harness(new FakeBackend());
    const repo = await registry.register(makeRepo());
    registry.replaceFileState(repo.repo_id, [
      { path: 'a.txt', change_kind: 'modify', untracked: false, content_hash: 'h1' },
      { path: 'b.txt', change_kind: 'add', untracked: true, content_hash: null },
    ]);
    const state = registry.getFileState(repo.repo_id);
    expect(state).toHaveLength(2);
    expect(state.find((f) => f.path === 'a.txt')).toMatchObject({
      content_hash: 'h1',
      untracked: false,
    });
    registry.replaceFileState(repo.repo_id, []);
    expect(registry.getFileState(repo.repo_id)).toEqual([]);
    registry.recordScan(repo.repo_id, 'abc123');
    registry.recordWip(repo.repo_id, 'def456');
    const updated = registry.get(repo.repo_id);
    expect(updated?.head_oid).toBe('abc123');
    expect(updated?.last_scan_at).not.toBeNull();
    expect(updated?.last_wip_oid).toBe('def456');
  });
});

describe('Watcher reconciliation', () => {
  it('emits protocol-valid file.changed for dirty files and dedups unchanged state', async () => {
    const { registry, watcher, captured } = harness(new FakeBackend());
    const dir = makeRepo();
    const repo = await registry.register(dir);
    writeFileSync(join(dir, 'base.txt'), 'edited\n');
    writeFileSync(join(dir, 'new.txt'), 'new\n');

    const first = await watcher.reconcile(repo.repo_id);
    expect(first.emitted).toBe(2);
    expect(first.dirty).toBe(2);
    expect(captured).toHaveLength(2);
    for (const e of captured) {
      expect(e.type).toBe('file.changed');
      expect(e.repo_id).toBe(repo.repo_id);
      expect(e.payload).toMatchObject({ source: 'watcher' });
    }
    expect(captured.map((e) => e.payload.path).sort()).toEqual(['base.txt', 'new.txt']);

    // Second reconcile with no changes emits nothing (dedup against persisted state).
    const second = await watcher.reconcile(repo.repo_id);
    expect(second.emitted).toBe(0);
    expect(captured).toHaveLength(2);
  });

  it('re-emits with old/new hash when a dirty file is edited again', async () => {
    const { registry, watcher, captured } = harness(new FakeBackend());
    const dir = makeRepo();
    const repo = await registry.register(dir);
    writeFileSync(join(dir, 'base.txt'), 'v1\n');
    await watcher.reconcile(repo.repo_id);
    const firstHash = captured[0]?.payload.new_hash;
    expect(firstHash).toMatch(/^[0-9a-f]{64}$/);

    writeFileSync(join(dir, 'base.txt'), 'v2\n');
    const second = await watcher.reconcile(repo.repo_id);
    expect(second.emitted).toBe(1);
    expect(captured[1]?.payload).toMatchObject({
      path: 'base.txt',
      change_kind: 'modify',
      old_hash: firstHash,
    });
    expect(captured[1]?.payload.new_hash).not.toBe(firstHash);
  });

  it('detects a deletion and stops re-emitting once recorded', async () => {
    const { registry, watcher, captured } = harness(new FakeBackend());
    const dir = makeRepo();
    const repo = await registry.register(dir);
    rmSync(join(dir, 'base.txt'));
    const r1 = await watcher.reconcile(repo.repo_id);
    expect(r1.emitted).toBe(1);
    expect(captured[0]?.payload).toMatchObject({ path: 'base.txt', change_kind: 'delete' });
    const r2 = await watcher.reconcile(repo.repo_id);
    expect(r2.emitted).toBe(0);
  });

  it('drops resolved files from state without emitting a spurious change', async () => {
    const { registry, watcher, captured } = harness(new FakeBackend());
    const dir = makeRepo();
    const repo = await registry.register(dir);
    writeFileSync(join(dir, 'base.txt'), 'edited\n');
    await watcher.reconcile(repo.repo_id);
    expect(captured).toHaveLength(1);
    // Commit the change: working tree becomes clean.
    g(dir, ['add', '-A']);
    g(dir, ['commit', '-q', '-m', 'commit edit']);
    const r = await watcher.reconcile(repo.repo_id);
    expect(r.emitted).toBe(0);
    expect(r.dirty).toBe(0);
    expect(registry.getFileState(repo.repo_id)).toEqual([]);
    expect(captured).toHaveLength(1);
  });

  it('throws not_found for an unknown repo', async () => {
    const { watcher } = harness(new FakeBackend());
    await expect(watcher.reconcile('repo_missing')).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('Watcher auto-WIP', () => {
  it('snapshots dirty work to the hidden ref and records it', async () => {
    const { registry, watcher } = harness(new FakeBackend(), { autoWip: true, wipIntervalMs: 0 });
    const dir = makeRepo();
    const repo = await registry.register(dir);
    writeFileSync(join(dir, 'base.txt'), 'precious uncommitted work\n');
    const result = await watcher.reconcile(repo.repo_id);
    expect(result.wip).not.toBeNull();
    expect(result.wip?.ref).toBe(repo.wip_ref);
    expect(g(dir, ['show', `${repo.wip_ref}:base.txt`])).toBe('precious uncommitted work');
    expect(registry.get(repo.repo_id)?.last_wip_oid).toBe(result.wip?.commit);
    // HEAD untouched.
    expect(g(dir, ['rev-parse', 'HEAD'])).toBe(repo.head_oid);
  });

  it('throttles automatic snapshots within the interval', async () => {
    const backend = new FakeBackend();
    const { registry, watcher } = harness(backend, { autoWip: true, wipIntervalMs: 60_000 });
    const dir = makeRepo();
    const repo = await registry.register(dir);
    writeFileSync(join(dir, 'base.txt'), 'dirty\n');
    await watcher.watch(repo); // initial reconcile snapshots (lastWipAt null)
    const firstOid = registry.get(repo.repo_id)?.last_wip_oid;
    expect(firstOid).toBeTruthy();
    writeFileSync(join(dir, 'base.txt'), 'dirty again\n');
    const r = await watcher.reconcile(repo.repo_id); // within 60s → throttled
    expect(r.wip).toBeNull();
    expect(registry.get(repo.repo_id)?.last_wip_oid).toBe(firstOid);
  });

  it('force snapshot returns null on a clean tree', async () => {
    const { registry, watcher } = harness(new FakeBackend(), { autoWip: true });
    const repo = await registry.register(makeRepo());
    expect(await watcher.snapshotWip(repo.repo_id)).toBeNull();
  });
});

describe('Watcher backend + lifecycle', () => {
  it('detects the native parcel backend when available', async () => {
    const backend = await detectBackend(1000);
    expect(backend.name).toBe('parcel');
  });

  it('falls back to poll when native subscribe fails', async () => {
    const backend = new FakeBackend();
    backend.failSubscribe = true;
    const { registry, watcher } = harness(backend);
    const repo = await registry.register(makeRepo());
    await watcher.watch(repo);
    expect(registry.get(repo.repo_id)?.watcher_backend).toBe('poll');
    expect(watcher.watched).toContain(repo.repo_id);
    await watcher.stop();
  });

  it('coalesces rapid hints into a single debounced reconcile', async () => {
    const backend = new FakeBackend();
    const { registry, watcher, captured } = harness(backend, { debounceMs: 60 });
    const dir = makeRepo();
    const repo = await registry.register(dir);
    await watcher.watch(repo); // clean baseline
    const spy = vi.spyOn(watcher, 'reconcile');
    writeFileSync(join(dir, 'base.txt'), 'changed\n');
    for (let i = 0; i < 5; i++) backend.fire(repo.root_path);
    await new Promise((r) => setTimeout(r, 400));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(captured.some((e) => e.payload.path === 'base.txt')).toBe(true);
    await watcher.stop();
  });

  it('stop closes subscriptions and clears watched repos', async () => {
    const backend = new FakeBackend();
    const { registry, watcher } = harness(backend);
    const repo = await registry.register(makeRepo());
    await watcher.watch(repo);
    expect(watcher.watched).toHaveLength(1);
    await watcher.stop();
    expect(watcher.watched).toHaveLength(0);
    expect(backend.closed).toContain(repo.root_path);
  });

  it('end-to-end: native watch picks up an out-of-band file edit', async () => {
    const db = freshDb();
    const deviceId = makeId('device');
    const projectId = makeId('project');
    const registry = new RepoRegistry(db, { deviceId, projectId });
    const captured: EventEnvelope[] = [];
    const source = { deviceId, projectId };
    const watcher = new Watcher({
      registry,
      actor: { user_id: makeId('user'), agent: null },
      autoWip: false,
      debounceMs: 150,
      pollMs: 400,
      emit: (draft) => {
        const env = draftEvent(source, draft);
        parseEvent(env);
        captured.push(env);
        return { accepted: true, event_id: env.event_id };
      },
    });
    const dir = makeRepo();
    const repo = await registry.register(dir);
    await watcher.watch(repo);
    expect(watcher.backendName).toBe('parcel');
    writeFileSync(join(dir, 'base.txt'), 'out of band edit\n');
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && !captured.some((e) => e.payload.path === 'base.txt')) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(
      captured.some((e) => e.payload.path === 'base.txt' && e.payload.source === 'watcher'),
    ).toBe(true);
    await watcher.stop();
  }, 15_000);
});

describe('PollBackend', () => {
  it('fires hints on an interval and stops on close', async () => {
    const backend = new PollBackend(20);
    let count = 0;
    const sub = await backend.subscribe('/unused', () => count++);
    await new Promise((r) => setTimeout(r, 90));
    await sub.close();
    const after = count;
    await new Promise((r) => setTimeout(r, 60));
    expect(count).toBeGreaterThan(0);
    expect(count).toBe(after);
  });
});
