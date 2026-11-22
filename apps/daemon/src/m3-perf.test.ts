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
import { OverlapEngine } from './overlap.js';
import type { EventDraft } from './events.js';
import type { EnqueueResult } from './pipeline.js';
// The resolver forks a real compiled worker; exercise the built artifact.
import { ResolverClient } from '../dist/resolver.js';

const dirs: string[] = [];
const dbs: SqliteDatabase[] = [];
const clients: ResolverClient[] = [];

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

function initRepo(dir: string): void {
  g(dir, ['init', '-q', '-b', 'main']);
  g(dir, ['config', 'user.name', 'Test']);
  g(dir, ['config', 'user.email', 'test@example.com']);
  g(dir, ['config', 'commit.gpgsign', 'false']);
  g(dir, ['config', 'core.autocrlf', 'false']);
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
  const actor = { user_id: makeId('user'), agent: null };
  const overlap = new OverlapEngine({
    deviceId,
    registry,
    store,
    indexer,
    actor,
    emit: (_draft: EventDraft): EnqueueResult => ({ accepted: true }),
  });
  return { db, store, registry, indexer, overlap };
}

afterEach(async () => {
  for (const c of clients.splice(0)) {
    try {
      await c.stop();
    } catch {
      /* already stopped */
    }
  }
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

const FILE_COUNT = 10_000;
const PACKAGES = 20;
const PER_PACKAGE = FILE_COUNT / PACKAGES;

/** A 10k-file monorepo sim: 20 packages x 500 tiny TS modules, committed to git. */
function monorepoFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'weft-m3-scale-'));
  dirs.push(dir);
  initRepo(dir);
  for (let p = 0; p < PACKAGES; p++) {
    for (let i = 0; i < PER_PACKAGE; i++) {
      const n = p * PER_PACKAGE + i;
      const rel = `packages/p${p}/src/mod${i}.ts`;
      const abs = join(dir, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, `export function fn${n}(x: number): number {\n  return x + ${n};\n}\n`);
    }
  }
  writeFileSync(
    join(dir, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2020',
        module: 'commonjs',
        moduleResolution: 'node',
        strict: false,
        skipLibCheck: true,
        noEmit: true,
      },
      include: ['packages/*/src/**/*.ts'],
    }),
  );
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'monorepo-sim', version: '0.0.0' }));
  g(dir, ['add', '-A']);
  g(dir, ['commit', '-q', '-m', 'base']);
  return dir;
}

describe('M3 scale gates: 10k-file monorepo sim', () => {
  it('full index of 10k files completes <=60s with <=80MB heap growth', async () => {
    const { registry, indexer } = harness();
    const dir = monorepoFixture();
    const repo = await registry.register(dir);

    const before = process.memoryUsage().heapUsed;
    const full = await indexer.indexRepo(repo.repo_id);
    const heapGrowthMb = (process.memoryUsage().heapUsed - before) / (1024 * 1024);

    expect(full.indexed).toBe(FILE_COUNT);
    expect(full.duration_ms).toBeLessThan(60_000);
    // The index lives in SQLite (native); the daemon JS heap must not balloon.
    expect(heapGrowthMb).toBeLessThan(80);
  }, 180_000);

  it('resolver worker RSS stays <=1GB at 10k files and exits cleanly', async () => {
    const dir = monorepoFixture();
    const c = new ResolverClient({
      enabled: true,
      maxMemoryMb: 1024,
      idleTimeoutMs: 600_000,
      requestTimeoutMs: 240_000,
    });
    clients.push(c);

    const result = await c.resolve(dir, {
      filePath: 'packages/p0/src/mod0.ts',
      name: 'fn0',
      kind: 'function',
    });
    expect(result.precision).toBe('exact');
    expect(result.references.some((r) => r.is_definition)).toBe(true);

    const stats = await c.stats();
    expect(stats.services).toBe(1);
    expect(stats.rss).toBeLessThanOrEqual(1024 * 1024 * 1024);

    // Exit benchmark: the worker shuts down on request and a subsequent call is
    // rejected rather than silently resurrecting a stopped supervisor.
    await c.stop();
    await expect(c.resolve(dir, { filePath: 'packages/p0/src/mod0.ts', name: 'fn0' })).rejects.toMatchObject({
      code: 'crashed',
    });
  }, 300_000);
});

describe('M3 conflict storm: incremental L1/L2 sweep <=100ms', () => {
  const TASKS = 40;

  function stormFixture(): { dir: string; tasks: { taskId: string; branch: string }[] } {
    const dir = mkdtempSync(join(tmpdir(), 'weft-m3-storm-'));
    dirs.push(dir);
    initRepo(dir);
    // A shared library with one symbol per task plus a hot symbol everyone touches.
    const libLines = ['export function hot(x: number): number { return x; }'];
    for (let i = 0; i < TASKS; i++) {
      libLines.push(`export function sym${i}(x: number): number { return x + ${i}; }`);
    }
    writeFiles(dir, {
      'src/lib.ts': `${libLines.join('\n')}\n`,
      'src/caller.ts':
        "import { hot } from './lib';\nexport function callHot(): number { return hot(1); }\n",
    });
    g(dir, ['add', '-A']);
    g(dir, ['commit', '-q', '-m', 'base']);

    const tasks: { taskId: string; branch: string }[] = [];
    for (let i = 0; i < TASKS; i++) {
      const branch = `task${i}`;
      g(dir, ['checkout', '-q', '-b', branch]);
      // Each task edits its own symbol AND the hot symbol -> a dense overlap storm.
      // task0 also changes hot's SIGNATURE, so the caller file becomes an L2 impact.
      const edited = libLines
        .map((line) => {
          if (line.includes('function hot(')) {
            return i === 0
              ? 'export function hot(x: number, y: number): number { return x + y; }'
              : 'export function hot(x: number): number { return x + 1; }';
          }
          if (line.includes(`function sym${i}(`)) return `export function sym${i}(x: number): number { return x + ${i + 100}; }`;
          return line;
        })
        .join('\n');
      const files: Record<string, string> = {
        'src/lib.ts': `${edited}\n`,
        [`src/own${i}.ts`]: `export const own${i} = ${i};\n`,
      };
      // task1 edits the caller file, so it is an affected task for hot's signature change.
      if (i === 1) {
        files['src/caller.ts'] =
          "import { hot } from './lib';\nexport function callHot(): number { return hot(2); }\n";
      }
      writeFiles(dir, files);
      g(dir, ['add', '-A']);
      g(dir, ['commit', '-q', '-m', branch]);
      g(dir, ['checkout', '-q', 'main']);
      tasks.push({ taskId: `t${i}`, branch });
    }
    return { dir, tasks };
  }

  it('steady-state and single-branch incremental sweeps stay under 100ms', async () => {
    const { registry, indexer, overlap } = harness();
    const { dir, tasks } = stormFixture();
    const repo = await registry.register(dir);

    // Warm pass: indexes every branch (setup cost, not gated).
    const warm = await overlap.sweep(repo.repo_id, tasks);
    expect(warm.overlaps.length).toBeGreaterThan(0);
    expect(warm.impacts.length).toBeGreaterThan(0);

    // Steady state: no git, no re-index, no duplicate cards.
    const steady = await overlap.sweep(repo.repo_id, tasks);
    expect(steady.indexed_branches).toBe(0);
    expect(steady.emitted).toBe(0);
    expect(steady.duration_ms).toBeLessThan(100);

    // Advance one branch, re-index just it, then sweep: only that branch recomputes.
    g(dir, ['checkout', '-q', 'task0']);
    writeFileSync(join(dir, 'src/own0.ts'), 'export const own0 = 999;\n');
    g(dir, ['add', '-A']);
    g(dir, ['commit', '-q', '-m', 'task0 again']);
    g(dir, ['checkout', '-q', 'main']);
    await indexer.indexRepo(repo.repo_id, { branch: 'task0' });

    const incremental = await overlap.sweep(repo.repo_id, tasks);
    expect(incremental.indexed_branches).toBe(1);
    expect(incremental.duration_ms).toBeLessThan(100);
  }, 120_000);
});