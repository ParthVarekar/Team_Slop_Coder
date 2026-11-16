import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DAEMON_MIGRATIONS, metrics, migrate, openSqlite, type SqliteDatabase } from '@weft/core';
import { makeId } from '@weft/protocol';
import { RepoRegistry } from './repos.js';
import { LocalStore } from './store.js';
import { Indexer, IndexerError } from './indexer.js';

const dirs: string[] = [];
const dbs: SqliteDatabase[] = [];

function g(repo: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true }).trim();
}

function makeRepo(files: Record<string, string> = { 'src/a.ts': 'export const a = 1;\n' }): string {
  const dir = mkdtempSync(join(tmpdir(), 'weft-idx-repo-'));
  dirs.push(dir);
  g(dir, ['init', '-q', '-b', 'main']);
  g(dir, ['config', 'user.name', 'Test']);
  g(dir, ['config', 'user.email', 'test@example.com']);
  g(dir, ['config', 'commit.gpgsign', 'false']);
  g(dir, ['config', 'core.autocrlf', 'false']);
  for (const [path, content] of Object.entries(files)) {
    const abs = join(dir, path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  g(dir, ['add', '-A']);
  g(dir, ['commit', '-q', '-m', 'base']);
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
  return { db, store, registry, indexer };
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

describe('Indexer full sweep', () => {
  it('indexes tracked TS/JS files and records per-file state', async () => {
    const { store, registry, indexer } = harness();
    const repoPath = makeRepo({
      'src/a.ts': 'export function alpha(x: number): number { return x; }\n',
      'src/b.js': 'export const beta = 2;\n',
      'README.md': '# not source\n',
      'node_modules/dep/index.ts': 'export const ignored = 1;\n',
    });
    const repo = await registry.register(repoPath);

    const result = await indexer.indexRepo(repo.repo_id);
    expect(result.branch).toBe('main');
    expect(result.source).toBe('worktree');
    expect(result.indexed).toBe(2); // a.ts + b.js; README and node_modules excluded
    expect(result.symbols).toBe(2);
    expect(store.listIndexedFiles(repo.repo_id, 'main')).toEqual(['src/a.ts', 'src/b.js']);
    expect(store.getSymbols(repo.repo_id, 'main', 'src/a.ts')[0]).toMatchObject({
      name: 'alpha',
      kind: 'function',
      signature: 'alpha(x: number): number',
    });
    expect(store.getFileIndexState(repo.repo_id, 'main', 'src/a.ts')?.symbol_count).toBe(1);
  });

  it('skips unchanged files on a second sweep (content-hash invalidation)', async () => {
    const { registry, indexer } = harness();
    const repo = await registry.register(makeRepo());
    const first = await indexer.indexRepo(repo.repo_id);
    expect(first.indexed).toBe(1);
    const second = await indexer.indexRepo(repo.repo_id);
    expect(second.indexed).toBe(0);
    expect(second.skipped).toBe(1);
  });

  it('throws not_found for an unknown repo', async () => {
    const { indexer } = harness();
    await expect(indexer.indexRepo('repo_missing')).rejects.toBeInstanceOf(IndexerError);
  });
});

describe('Indexer git-diff invalidation', () => {
  it('re-indexes only changed files and leaves others untouched', async () => {
    const { store, registry, indexer } = harness();
    const repoPath = makeRepo({
      'src/a.ts': 'export const a = 1;\n',
      'src/b.ts': 'export const b = 2;\n',
    });
    const repo = await registry.register(repoPath);
    await indexer.indexRepo(repo.repo_id);
    const bBefore = store.getFileIndexState(repo.repo_id, 'main', 'src/b.ts')?.indexed_at;

    writeFileSync(join(repoPath, 'src/a.ts'), 'export const a = 1;\nexport function added(): void {}\n');
    const res = await indexer.invalidate(repo.repo_id, ['src/a.ts', 'src/b.ts'], []);
    expect(res.indexed).toBe(1);
    expect(res.skipped).toBe(1);
    expect(store.getSymbols(repo.repo_id, 'main', 'src/a.ts').map((s) => s.name)).toEqual(['a', 'added']);
    expect(store.getFileIndexState(repo.repo_id, 'main', 'src/b.ts')?.indexed_at).toBe(bBefore);
  });

  it('drops symbols for deleted files', async () => {
    const { store, registry, indexer } = harness();
    const repoPath = makeRepo({ 'src/a.ts': 'export const a = 1;\n', 'src/gone.ts': 'export const g = 1;\n' });
    const repo = await registry.register(repoPath);
    await indexer.indexRepo(repo.repo_id);
    expect(store.countSymbols(repo.repo_id, 'main')).toBe(2);

    unlinkSync(join(repoPath, 'src/gone.ts'));
    const res = await indexer.invalidate(repo.repo_id, [], ['src/gone.ts']);
    expect(res.deleted).toBe(1);
    expect(store.countSymbols(repo.repo_id, 'main')).toBe(1);
    expect(store.listIndexedFiles(repo.repo_id, 'main')).toEqual(['src/a.ts']);
  });

  it('full sweep removes files that vanished since the last index', async () => {
    const { store, registry, indexer } = harness();
    const repoPath = makeRepo({ 'src/a.ts': 'export const a = 1;\n', 'src/gone.ts': 'export const g = 1;\n' });
    const repo = await registry.register(repoPath);
    await indexer.indexRepo(repo.repo_id);
    unlinkSync(join(repoPath, 'src/gone.ts'));
    g(repoPath, ['add', '-A']);
    g(repoPath, ['commit', '-qm', 'remove']);
    const res = await indexer.indexRepo(repo.repo_id);
    expect(res.deleted).toBe(1);
    expect(store.listIndexedFiles(repo.repo_id, 'main')).toEqual(['src/a.ts']);
  });

  it('ignores non-source paths in a change set', async () => {
    const { registry, indexer } = harness();
    const repo = await registry.register(makeRepo());
    await indexer.indexRepo(repo.repo_id);
    const res = await indexer.invalidate(repo.repo_id, ['README.md', 'package.json'], []);
    expect(res).toEqual({ indexed: 0, skipped: 0, deleted: 0 });
  });
});

describe('Indexer branch-scoped isolation', () => {
  it('keeps two branches independent — indexing one never overwrites the other', async () => {
    const { store, registry, indexer } = harness();
    const repoPath = makeRepo({ 'src/shared.ts': 'export const v = 1;\n' });
    const repo = await registry.register(repoPath);
    await indexer.indexRepo(repo.repo_id, { branch: 'main' });

    g(repoPath, ['checkout', '-q', '-b', 'feature']);
    writeFileSync(join(repoPath, 'src/shared.ts'), 'export const v = 2;\nexport function extra(): void {}\n');
    g(repoPath, ['add', '-A']);
    g(repoPath, ['commit', '-qm', 'feature']);
    await indexer.indexRepo(repo.repo_id, { branch: 'feature' });

    const main = store.getSymbols(repo.repo_id, 'main', 'src/shared.ts');
    const feature = store.getSymbols(repo.repo_id, 'feature', 'src/shared.ts');
    expect(main.map((s) => s.name)).toEqual(['v']);
    expect(feature.map((s) => s.name)).toEqual(['v', 'extra']);
    expect(store.countSymbols(repo.repo_id, 'main')).toBe(1);
    expect(store.countSymbols(repo.repo_id, 'feature')).toBe(2);

    // Re-indexing feature again must not disturb main.
    await indexer.indexRepo(repo.repo_id, { branch: 'feature' });
    expect(store.getSymbols(repo.repo_id, 'main', 'src/shared.ts').map((s) => s.name)).toEqual(['v']);
  });

  it('reads a non-checked-out branch from the git ref (no checkout required)', async () => {
    const { store, registry, indexer } = harness();
    const repoPath = makeRepo({ 'src/shared.ts': 'export const v = 1;\n' });
    const repo = await registry.register(repoPath);
    g(repoPath, ['checkout', '-q', '-b', 'feature']);
    writeFileSync(join(repoPath, 'src/shared.ts'), 'export const v = 1;\nexport function extra(): void {}\n');
    g(repoPath, ['add', '-A']);
    g(repoPath, ['commit', '-qm', 'feature']);
    g(repoPath, ['checkout', '-q', 'main']);

    // Still on main; index feature purely from the ref.
    const res = await indexer.indexRepo(repo.repo_id, { branch: 'feature', fromRef: true });
    expect(res.source).toBe('ref');
    expect(store.getSymbols(repo.repo_id, 'feature', 'src/shared.ts').map((s) => s.name)).toEqual(['v', 'extra']);
    // main was never indexed in this pass.
    expect(store.countSymbols(repo.repo_id, 'main')).toBe(0);
  });
});

describe('Indexer performance gates', () => {
  it('indexes a few hundred files quickly and keeps per-file p95 under 50ms', async () => {
    const { registry, indexer } = harness();
    const files: Record<string, string> = {};
    for (let i = 0; i < 250; i++) {
      files[`src/f${i}.ts`] =
        `export function fn${i}(a: number, b: string): boolean { return a > 0; }\n` +
        `export class C${i} { run(x: number): number { return x + 1; } }\n` +
        `export const k${i} = ${i};\n`;
    }
    const repoPath = makeRepo(files);
    const repo = await registry.register(repoPath);

    const hist = metrics.histogram('weft_index_file_ms');
    hist.reset();
    const full = await indexer.indexRepo(repo.repo_id);
    expect(full.indexed).toBe(250);
    expect(full.duration_ms).toBeLessThan(20_000);

    // Incremental: modify each file once and invalidate the whole change set.
    hist.reset();
    const changed: string[] = [];
    for (let i = 0; i < 250; i++) {
      const p = `src/f${i}.ts`;
      writeFileSync(join(repoPath, p), `export function fn${i}(a: number): number { return a + ${i}; }\n`);
      changed.push(p);
    }
    const inc = await indexer.invalidate(repo.repo_id, changed, []);
    expect(inc.indexed).toBe(250);
    const p95 = hist.snapshot().p95;
    expect(p95).toBeLessThan(50);
  }, 60_000);
});