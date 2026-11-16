// M3.1 acceptance gate: full index of a large fixture repo, incremental
// invalidation, and index memory. Run with --expose-gc for stable RSS deltas.
//   node --expose-gc apps/daemon/e2e/symbol-index-perf.mjs
// Override size with WEFT_INDEX_FILES (default 10000).
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSqlite, migrate, DAEMON_MIGRATIONS, metrics } from '@weft/core';
import { makeId } from '@weft/protocol';
import { LocalStore } from '../dist/store.js';
import { RepoRegistry } from '../dist/repos.js';
import { Indexer } from '../dist/indexer.js';

const FILE_COUNT = Number(process.env.WEFT_INDEX_FILES ?? 10_000);
const FULL_GATE_MS = 60_000;
const P95_GATE_MS = 50;
const MEM_GATE_MB = 80;
const INCREMENTAL_FILES = 200;

const git = (cwd, args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024 * 1024 });
const gc = () => {
  if (globalThis.gc) globalThis.gc();
};
const mb = (bytes) => bytes / 1024 / 1024;

const dir = mkdtempSync(join(tmpdir(), 'weft-index-perf-'));
const db = openSqlite(':memory:');
migrate(db, DAEMON_MIGRATIONS);
const store = new LocalStore(db);
const registry = new RepoRegistry(db, { deviceId: makeId('device'), projectId: makeId('project') });
const indexer = new Indexer({ registry, store });

try {
  mkdirSync(join(dir, 'src'), { recursive: true });
  const tGen = performance.now();
  for (let i = 0; i < FILE_COUNT; i++) {
    writeFileSync(
      join(dir, 'src', `mod${i}.ts`),
      `export function fn${i}(x: number): number {\n  return x + ${i};\n}\n` +
        `export class C${i} { run(y: number): number { return y * 2; } }\n`,
    );
  }
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'perf-fixture', version: '0.0.0' }));
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.name', 'Perf']);
  git(dir, ['config', 'user.email', 'perf@example.com']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  git(dir, ['config', 'core.autocrlf', 'false']);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'fixture']);
  const genMs = performance.now() - tGen;
  const repo = await registry.register(dir);

  gc();
  const rssBefore = process.memoryUsage().rss;
  const hist = metrics.histogram('weft_index_file_ms');
  hist.reset();
  const tFull = performance.now();
  const full = await indexer.indexRepo(repo.repo_id);
  const fullMs = performance.now() - tFull;
  gc();
  const rssAfter = process.memoryUsage().rss;
  const marginalMb = mb(rssAfter - rssBefore);
  const fullP95 = hist.snapshot().p95;

  assert.equal(full.indexed, FILE_COUNT, `expected ${FILE_COUNT} indexed, got ${full.indexed}`);
  assert.ok(fullMs <= FULL_GATE_MS, `full index ${fullMs.toFixed(0)}ms exceeds ${FULL_GATE_MS}ms gate`);
  assert.ok(fullP95 <= P95_GATE_MS, `full per-file p95 ${fullP95}ms exceeds ${P95_GATE_MS}ms gate`);
  assert.ok(marginalMb <= MEM_GATE_MB, `index marginal RSS ${marginalMb.toFixed(1)}MB exceeds ${MEM_GATE_MB}MB gate`);

  const changed = [];
  for (let i = 0; i < INCREMENTAL_FILES; i++) {
    const p = `src/mod${i}.ts`;
    writeFileSync(join(dir, p), `export function fn${i}(x: number): number { return x - ${i}; }\n`);
    changed.push(p);
  }
  hist.reset();
  const tInc = performance.now();
  const inc = await indexer.invalidate(repo.repo_id, changed, []);
  const incMs = performance.now() - tInc;
  assert.equal(inc.indexed, INCREMENTAL_FILES, `expected ${INCREMENTAL_FILES} re-indexed`);
  const incP95 = hist.snapshot().p95;
  assert.ok(incP95 <= P95_GATE_MS, `incremental p95 ${incP95}ms exceeds ${P95_GATE_MS}ms gate`);

  // A second full sweep must skip everything (content-hash invalidation).
  const again = await indexer.indexRepo(repo.repo_id);
  assert.equal(again.indexed, 0, `unchanged sweep re-indexed ${again.indexed} files`);
  assert.equal(again.skipped, FILE_COUNT, `unchanged sweep skipped ${again.skipped}`);

  console.log(
    JSON.stringify(
      {
        fileCount: FILE_COUNT,
        fixtureGenMs: +genMs.toFixed(0),
        fullIndexMs: +fullMs.toFixed(0),
        fullPerFileP95Ms: +fullP95.toFixed(3),
        symbols: full.symbols,
        indexMarginalRssMb: +marginalMb.toFixed(1),
        processAbsoluteRssMb: +mb(rssAfter).toFixed(1),
        incremental: { files: INCREMENTAL_FILES, ms: +incMs.toFixed(0), p95Ms: +incP95.toFixed(3) },
        unchangedSweep: { indexed: again.indexed, skipped: again.skipped },
        gates: { fullMs: FULL_GATE_MS, p95Ms: P95_GATE_MS, marginalMemMb: MEM_GATE_MB },
      },
      null,
      2,
    ),
  );
  console.log('symbol-index perf gates: PASS');
} finally {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}