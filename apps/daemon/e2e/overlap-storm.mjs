// M3.2 acceptance gate: conflict storm. 40 task branches, ~20% file overlap and
// signature changes. The INCREMENTAL overlap sweep (steady state, and after a single
// branch advances) must stay <=100ms and never mint duplicate conflict cards.
//   node apps/daemon/e2e/overlap-storm.mjs
// Override size with WEFT_STORM_FILES (default 200) / WEFT_STORM_TASKS (default 40).
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSqlite, migrate, DAEMON_MIGRATIONS } from '@weft/core';
import { makeId } from '@weft/protocol';
import { LocalStore } from '../dist/store.js';
import { RepoRegistry } from '../dist/repos.js';
import { Indexer } from '../dist/indexer.js';
import { OverlapEngine } from '../dist/overlap.js';

const FILE_COUNT = Number(process.env.WEFT_STORM_FILES ?? 200);
const TASKS = Number(process.env.WEFT_STORM_TASKS ?? 40);
const OVERLAP_MOD = 5; // each task touches 1/5 of files; tasks sharing t%5 collide
const SWEEP_GATE_MS = 100;
const FULL_SANITY_MS = 4000;

const git = (cwd, args) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 256 * 1024 * 1024,
  });

const dir = mkdtempSync(join(tmpdir(), 'weft-overlap-storm-'));
const db = openSqlite(':memory:');
migrate(db, DAEMON_MIGRATIONS);
const store = new LocalStore(db);
const registry = new RepoRegistry(db, { deviceId: makeId('device'), projectId: makeId('project') });
const indexer = new Indexer({ registry, store });
const events = [];
const overlap = new OverlapEngine({
  deviceId: makeId('device'),
  registry,
  store,
  indexer,
  actor: { user_id: makeId('user'), agent: null },
  emit: (draft) => {
    events.push(draft);
    return { accepted: true };
  },
});

const baseFile = (i) =>
  `export function fn${i}(x: number): number {\n  return x + ${i};\n}\n` +
  `export class C${i} { run(y: number): number { return y * 2; } }\n`;
const bodyEdit = (i, t) =>
  `export function fn${i}(x: number): number {\n  return x + ${i + t};\n}\n` +
  `export class C${i} { run(y: number): number { return y * 2; } }\n`;
const sigEdit = (i) =>
  `export function fn${i}(x: number, y: number): number {\n  return x + y + ${i};\n}\n` +
  `export class C${i} { run(y: number): number { return y * 2; } }\n`;

try {
  mkdirSync(join(dir, 'src'), { recursive: true });
  const tSetup = performance.now();
  for (let i = 0; i < FILE_COUNT; i++) {
    writeFileSync(join(dir, 'src', `mod${i}.ts`), baseFile(i));
  }
  writeFileSync(
    join(dir, 'src', 'caller.ts'),
    "import { fn0 } from './mod0';\nexport function call(): number { return fn0(1); }\n",
  );
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'storm-fixture', version: '0.0.0' }),
  );
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.name', 'Perf']);
  git(dir, ['config', 'user.email', 'perf@example.com']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  git(dir, ['config', 'core.autocrlf', 'false']);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'fixture']);
  const repo = await registry.register(dir);
  await indexer.indexRepo(repo.repo_id); // base, worktree

  const tasks = [];
  for (let t = 0; t < TASKS; t++) {
    const branch = `task${t}`;
    git(dir, ['checkout', '-q', '-b', branch]);
    for (let i = 0; i < FILE_COUNT; i++) {
      if (i % OVERLAP_MOD !== t % OVERLAP_MOD) continue;
      writeFileSync(join(dir, 'src', `mod${i}.ts`), i % 7 === 0 ? sigEdit(i) : bodyEdit(i, t));
    }
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', branch]);
    await indexer.indexRepo(repo.repo_id, { branch }); // current === branch -> worktree
    git(dir, ['checkout', '-q', 'main']);
    tasks.push({ taskId: `t${t}`, branch });
  }
  const setupMs = performance.now() - tSetup;

  // Full sweep: computes every branch's modified-symbol set (not the 100ms gate).
  const tFull = performance.now();
  const full = await overlap.sweep(repo.repo_id, tasks);
  const fullMs = performance.now() - tFull;
  assert.ok(full.overlaps.length > 0, 'expected symbol overlaps in the storm');
  assert.ok(
    fullMs <= FULL_SANITY_MS,
    `full sweep ${fullMs.toFixed(0)}ms exceeds sanity ${FULL_SANITY_MS}ms`,
  );

  // No duplicate cards: every emitted conflict key is unique within the sweep.
  const keys = events
    .filter((e) => e.type === 'conflict.detected')
    .map((e) => e.payload.canonical_key);
  assert.equal(new Set(keys).size, keys.length, 'duplicate conflict cards emitted');
  const emittedAfterFull = events.length;

  // Incremental steady state: nothing changed -> cache hit, zero re-emit.
  const tIdle = performance.now();
  const idle = await overlap.sweep(repo.repo_id, tasks);
  const idleMs = performance.now() - tIdle;
  assert.ok(
    idleMs <= SWEEP_GATE_MS,
    `idle incremental sweep ${idleMs.toFixed(1)}ms exceeds ${SWEEP_GATE_MS}ms gate`,
  );
  assert.equal(idle.emitted, 0, 'idle sweep re-emitted conflicts');
  assert.equal(idle.indexed_branches, 0, 'idle sweep recomputed branches');
  assert.equal(idle.cached_branches, TASKS, 'idle sweep did not reuse all branches');
  assert.equal(events.length, emittedAfterFull, 'idle sweep minted new cards');

  // Advance ONE branch, re-index it, then sweep: only that branch recomputes.
  git(dir, ['checkout', '-q', 'task0']);
  writeFileSync(join(dir, 'src', 'mod0.ts'), bodyEdit(0, 999));
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'task0 advance']);
  await indexer.indexRepo(repo.repo_id, { branch: 'task0' });
  git(dir, ['checkout', '-q', 'main']);

  const tOne = performance.now();
  const one = await overlap.sweep(repo.repo_id, tasks);
  const oneMs = performance.now() - tOne;
  assert.ok(
    oneMs <= SWEEP_GATE_MS,
    `single-branch incremental sweep ${oneMs.toFixed(1)}ms exceeds ${SWEEP_GATE_MS}ms gate`,
  );
  assert.equal(one.indexed_branches, 1, 'expected exactly one branch recomputed');
  assert.equal(one.cached_branches, TASKS - 1, 'expected remaining branches cached');

  console.log(
    JSON.stringify(
      {
        fileCount: FILE_COUNT,
        tasks: TASKS,
        setupMs: +setupMs.toFixed(0),
        fullSweepMs: +fullMs.toFixed(1),
        overlaps: full.overlaps.length,
        impacts: full.impacts.length,
        cardsEmitted: keys.length,
        idleIncrementalMs: +idleMs.toFixed(2),
        singleBranchIncrementalMs: +oneMs.toFixed(2),
        gateMs: SWEEP_GATE_MS,
      },
      null,
      2,
    ),
  );
  console.log('overlap-storm perf gates: PASS');
} finally {
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
