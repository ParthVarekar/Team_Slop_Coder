import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DAEMON_MIGRATIONS, migrate, openSqlite, type SqliteDatabase } from '@weft/core';
import { makeId } from '@weft/protocol';
import { RepoRegistry } from './repos.js';
import { LocalStore } from './store.js';
import { Indexer } from './indexer.js';
import { OverlapEngine, OverlapError } from './overlap.js';
import type { EventDraft } from './events.js';
import type { EnqueueResult } from './pipeline.js';

const dirs: string[] = [];
const dbs: SqliteDatabase[] = [];

function g(repo: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true }).trim();
}

function writeFiles(dir: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    const abs = join(dir, path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
}

function makeRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'weft-ovl-repo-'));
  dirs.push(dir);
  g(dir, ['init', '-q', '-b', 'main']);
  g(dir, ['config', 'user.name', 'Test']);
  g(dir, ['config', 'user.email', 'test@example.com']);
  g(dir, ['config', 'commit.gpgsign', 'false']);
  g(dir, ['config', 'core.autocrlf', 'false']);
  writeFiles(dir, files);
  g(dir, ['add', '-A']);
  g(dir, ['commit', '-q', '-m', 'base']);
  return dir;
}

function branchRepo(
  base: Record<string, string>,
  branches: Record<string, Record<string, string>>,
): string {
  const dir = makeRepo(base);
  for (const [name, files] of Object.entries(branches)) {
    g(dir, ['checkout', '-q', '-b', name]);
    writeFiles(dir, files);
    g(dir, ['add', '-A']);
    g(dir, ['commit', '-q', '-m', name]);
    g(dir, ['checkout', '-q', 'main']);
  }
  return dir;
}

function harness() {
  const db = openSqlite(':memory:');
  migrate(db, DAEMON_MIGRATIONS);
  dbs.push(db);
  const store = new LocalStore(db);
  const deviceId = makeId('device');
  const projectId = makeId('project');
  const registry = new RepoRegistry(db, { deviceId, projectId });
  const indexer = new Indexer({ registry, store });
  const events: EventDraft[] = [];
  const actor = { user_id: makeId('user'), agent: null };
  const overlap = new OverlapEngine({
    deviceId,
    registry,
    store,
    indexer,
    actor,
    emit: (draft): EnqueueResult => {
      events.push(draft);
      return { accepted: true };
    },
  });
  return { db, store, registry, indexer, overlap, events };
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

const LIB = 'export function foo(): number {\n  const a = 1;\n  const b = 2;\n  return a + b;\n}\n';

describe('OverlapEngine symbol overlap (L1)', () => {
  it('warns when two tasks both modify the same symbol, even on a clean merge', async () => {
    const { registry, overlap, events } = harness();
    const dir = branchRepo(
      { 'src/lib.ts': LIB },
      {
        taskA: { 'src/lib.ts': LIB.replace('const a = 1;', 'const a = 10;') },
        taskB: { 'src/lib.ts': LIB.replace('const b = 2;', 'const b = 20;') },
      },
    );
    const repo = await registry.register(dir);
    const result = await overlap.sweep(repo.repo_id, [
      { taskId: 'tA', branch: 'taskA' },
      { taskId: 'tB', branch: 'taskB' },
    ]);

    expect(result.overlaps).toHaveLength(1);
    const ov = result.overlaps[0];
    expect(ov?.task_ids).toEqual(['tA', 'tB']);
    expect(ov?.paths).toEqual(['src/lib.ts']);
    expect(ov?.symbols[0]).toMatchObject({ name: 'foo', change_a: 'body', change_b: 'body' });
    expect(ov?.severity).toBe('warning');

    const emitted = events.filter((e) => e.type === 'conflict.detected');
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.payload.kind).toBe('symbol_overlap');
    expect(Array.isArray(emitted[0]?.payload.symbol_ids)).toBe(true);
  });

  it('does not warn when tasks touch different symbols', async () => {
    const { registry, overlap } = harness();
    const dir = branchRepo(
      { 'src/lib.ts': 'export function foo(): number { return 1; }\nexport function bar(): number { return 2; }\n' },
      {
        taskA: { 'src/lib.ts': 'export function foo(): number { return 9; }\nexport function bar(): number { return 2; }\n' },
        taskB: { 'src/lib.ts': 'export function foo(): number { return 1; }\nexport function bar(): number { return 8; }\n' },
      },
    );
    const repo = await registry.register(dir);
    const result = await overlap.sweep(repo.repo_id, [
      { taskId: 'tA', branch: 'taskA' },
      { taskId: 'tB', branch: 'taskB' },
    ]);
    expect(result.overlaps).toHaveLength(0);
  });

  it('auto-indexes branches that were never indexed', async () => {
    const { registry, store, overlap } = harness();
    const dir = branchRepo(
      { 'src/lib.ts': LIB },
      {
        taskA: { 'src/lib.ts': LIB.replace('const a = 1;', 'const a = 5;') },
        taskB: { 'src/lib.ts': LIB.replace('const b = 2;', 'const b = 6;') },
      },
    );
    const repo = await registry.register(dir);
    expect(store.getBranchIndexState(repo.repo_id, 'taskA')).toBeUndefined();
    const result = await overlap.sweep(repo.repo_id, [
      { taskId: 'tA', branch: 'taskA' },
      { taskId: 'tB', branch: 'taskB' },
    ]);
    expect(result.overlaps).toHaveLength(1);
    expect(store.getBranchIndexState(repo.repo_id, 'taskA')).toBeDefined();
  });

  it('throws not_found for an unknown repo', async () => {
    const { overlap } = harness();
    await expect(overlap.sweep('repo_missing', [])).rejects.toBeInstanceOf(OverlapError);
  });
});

describe('OverlapEngine signature impact (L2 name-based)', () => {
  const BASE = {
    'src/lib.ts': 'export function getUser(id: string): string { return id; }\n',
    'src/caller.ts':
      "import { getUser } from './lib';\nexport function run(): string { return getUser('x'); }\n",
  };

  it('surfaces call sites and the affected task when a signature changes', async () => {
    const { registry, overlap, events } = harness();
    const dir = branchRepo(BASE, {
      taskA: { 'src/lib.ts': 'export function getUser(id: number): string { return String(id); }\n' },
      taskB: { 'src/caller.ts': "import { getUser } from './lib';\nexport function run(): string { return getUser('y'); }\n" },
    });
    const repo = await registry.register(dir);
    const result = await overlap.sweep(repo.repo_id, [
      { taskId: 'tA', branch: 'taskA' },
      { taskId: 'tB', branch: 'taskB' },
    ]);

    expect(result.impacts).toHaveLength(1);
    const impact = result.impacts[0];
    expect(impact?.name).toBe('getUser');
    expect(impact?.old_signature).toBe('getUser(id: string): string');
    expect(impact?.new_signature).toBe('getUser(id: number): string');
    expect(impact?.precision).toBe('name_based');
    expect(impact?.callers.some((c) => c.file_path === 'src/caller.ts' && c.from_symbol === 'run')).toBe(true);
    expect(impact?.affected_task_ids).toContain('tB');
    expect(impact?.severity).toBe('warning');

    const emitted = events.filter((e) => e.payload.kind === 'signature_impact');
    expect(emitted).toHaveLength(1);
  });

  it('labels an impact info when no other task touches the callers', async () => {
    const { registry, overlap } = harness();
    const dir = branchRepo(BASE, {
      taskA: { 'src/lib.ts': 'export function getUser(id: number): string { return String(id); }\n' },
    });
    const repo = await registry.register(dir);
    const result = await overlap.sweep(repo.repo_id, [{ taskId: 'tA', branch: 'taskA' }]);
    expect(result.impacts).toHaveLength(1);
    expect(result.impacts[0]?.affected_task_ids).toEqual([]);
    expect(result.impacts[0]?.severity).toBe('info');
  });
});

describe('OverlapEngine incrementality + dedup', () => {
  it('reuses cache and emits nothing on an unchanged sweep', async () => {
    const { registry, overlap, events } = harness();
    const dir = branchRepo(
      { 'src/lib.ts': LIB },
      {
        taskA: { 'src/lib.ts': LIB.replace('const a = 1;', 'const a = 10;') },
        taskB: { 'src/lib.ts': LIB.replace('const b = 2;', 'const b = 20;') },
      },
    );
    const repo = await registry.register(dir);
    const tasks = [
      { taskId: 'tA', branch: 'taskA' },
      { taskId: 'tB', branch: 'taskB' },
    ];
    const first = await overlap.sweep(repo.repo_id, tasks);
    expect(first.emitted).toBeGreaterThan(0);
    const countAfterFirst = events.length;

    const second = await overlap.sweep(repo.repo_id, tasks);
    expect(second.emitted).toBe(0);
    expect(second.indexed_branches).toBe(0);
    expect(second.cached_branches).toBe(2);
    expect(second.overlaps).toHaveLength(1);
    expect(events.length).toBe(countAfterFirst);
  });

  it('re-emits when the detection epoch advances (server reopen signal)', async () => {
    const { registry, overlap } = harness();
    const dir = branchRepo(
      { 'src/lib.ts': LIB },
      {
        taskA: { 'src/lib.ts': LIB.replace('const a = 1;', 'const a = 10;') },
        taskB: { 'src/lib.ts': LIB.replace('const b = 2;', 'const b = 20;') },
      },
    );
    const repo = await registry.register(dir);
    const tasks = [
      { taskId: 'tA', branch: 'taskA' },
      { taskId: 'tB', branch: 'taskB' },
    ];
    await overlap.sweep(repo.repo_id, tasks, { epoch: 0 });
    const next = await overlap.sweep(repo.repo_id, tasks, { epoch: 1 });
    expect(next.emitted).toBeGreaterThan(0);
    expect(next.epoch).toBe(1);
  });

  it('recomputes only the changed branch after a new commit', async () => {
    const { registry, indexer, overlap } = harness();
    const dir = branchRepo(
      { 'src/lib.ts': LIB },
      {
        taskA: { 'src/lib.ts': LIB.replace('const a = 1;', 'const a = 10;') },
        taskB: { 'src/lib.ts': LIB.replace('const b = 2;', 'const b = 20;') },
      },
    );
    const repo = await registry.register(dir);
    const tasks = [
      { taskId: 'tA', branch: 'taskA' },
      { taskId: 'tB', branch: 'taskB' },
    ];
    await overlap.sweep(repo.repo_id, tasks);

    // Advance taskA with a fresh commit on its branch, then re-index just it.
    g(dir, ['checkout', '-q', 'taskA']);
    writeFiles(dir, { 'src/lib.ts': LIB.replace('const a = 1;', 'const a = 99;') });
    g(dir, ['add', '-A']);
    g(dir, ['commit', '-q', '-m', 'taskA again']);
    g(dir, ['checkout', '-q', 'main']);
    await indexer.indexRepo(repo.repo_id, { branch: 'taskA' });

    const result = await overlap.sweep(repo.repo_id, tasks);
    expect(result.indexed_branches).toBe(1);
    expect(result.cached_branches).toBe(1);
    expect(result.overlaps).toHaveLength(1);
  });
});