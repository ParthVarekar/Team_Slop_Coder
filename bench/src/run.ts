import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { redact, openSqlite, migrate, DAEMON_MIGRATIONS, type SqliteDatabase } from '@weft/core';
import { parseEvent, type EventEnvelope } from '@weft/protocol';
import { measure, type BenchResult } from './measure.js';
import { syntheticEvent, syntheticEvents, SAMPLE_TEXTS } from './fixtures.js';

const here = dirname(fileURLToPath(import.meta.url));
const benchRoot = join(here, '..');
const args = new Set(process.argv.slice(2));
const smoke = args.has('--smoke');
const updateBaseline = args.has('--update-baseline');
const gate = args.has('--gate');

const N = smoke ? 2_000 : 50_000;
const results: BenchResult[] = [];

// 1. Redaction throughput ----------------------------------------------------
results.push(
  measure('redact_strings', N, (i) => {
    redact(SAMPLE_TEXTS[i % SAMPLE_TEXTS.length] as string);
  }),
);

// 2. Protocol validation + serialization ------------------------------------
const poolSize = Math.min(N, 5_000);
const pool = syntheticEvents(poolSize);
const protoIters = smoke ? 4_000 : 100_000;
results.push(
  measure('protocol_parse', protoIters, (i) => {
    parseEvent(pool[i % poolSize]);
  }),
);
results.push(
  measure('protocol_json_roundtrip', protoIters, (i) => {
    JSON.parse(JSON.stringify(pool[i % poolSize]));
  }),
);

// 3. Hook hot path: validate + redact + enqueue ------------------------------
const queue: string[] = [];
results.push(
  measure('hook_path_enqueue', N, (i) => {
    const event = syntheticEvent(i);
    parseEvent(event);
    queue.push(redact(JSON.stringify(event.payload)));
    if (queue.length > 10_000) queue.length = 0;
  }),
);

// 4. SQLite batched insert ---------------------------------------------------
function benchSqlite(): BenchResult {
  const db: SqliteDatabase = openSqlite(':memory:');
  migrate(db, DAEMON_MIGRATIONS);
  const insert = db.prepare(
    `INSERT INTO events
       (event_id, v, device_id, project_id, repo_id, session_id, seq, ts, type, actor, payload, privacy, received_at)
     VALUES
       (@event_id, @v, @device_id, @project_id, @repo_id, @session_id, @seq, @ts, @type, @actor, @payload, @privacy, @received_at)`,
  );
  const batchSize = 100;
  const totalEvents = smoke ? 5_000 : 100_000;
  const batches = Math.ceil(totalEvents / batchSize);
  const insertBatch = db.transaction((batch: EventEnvelope[]) => {
    for (const e of batch) {
      insert.run({
        event_id: e.event_id,
        v: e.v,
        device_id: e.device_id,
        project_id: e.project_id,
        repo_id: e.repo_id ?? null,
        session_id: e.session_id ?? null,
        seq: e.seq ?? null,
        ts: e.ts,
        type: e.type,
        actor: JSON.stringify(e.actor),
        payload: JSON.stringify(e.payload),
        privacy: e.privacy,
        received_at: new Date().toISOString(),
      });
    }
  });
  const all = syntheticEvents(totalEvents);
  const result = measure(
    'sqlite_batch_insert',
    batches,
    (b) => {
      insertBatch(all.slice(b * batchSize, (b + 1) * batchSize));
    },
    { scale: batchSize, unit: 'events/s' },
  );
  db.close();
  return result;
}
results.push(benchSqlite());

// Report ---------------------------------------------------------------------
const baselinePath = join(benchRoot, 'baseline.json');
// Smoke runs use far fewer iterations (JIT warmup dominates), so they neither
// compare against nor overwrite the full-run baseline.
const baseline: Record<string, number> =
  !smoke && existsSync(baselinePath)
    ? (JSON.parse(readFileSync(baselinePath, 'utf8')) as Record<string, number>)
    : {};

const regressions: string[] = [];
console.log(`\nWeft benchmark${smoke ? ' (smoke)' : ''} — node ${process.version}\n`);
console.log('name                          ops/s        p50ms     p95ms     p99ms     vs baseline');
for (const r of results) {
  const base = baseline[r.name];
  let delta = 'n/a';
  if (base !== undefined) {
    const change = (r.opsPerSec - base) / base;
    delta = `${change >= 0 ? '+' : ''}${(change * 100).toFixed(1)}%`;
    if (change < -0.1) regressions.push(`${r.name}: ${(change * 100).toFixed(1)}%`);
  }
  console.log(
    `${r.name.padEnd(28)} ${r.opsPerSec.toFixed(0).padStart(10)} ${r.p50Ms.toFixed(3).padStart(9)} ${r.p95Ms.toFixed(3).padStart(9)} ${r.p99Ms.toFixed(3).padStart(9)}   ${delta}`,
  );
}

const artifact = {
  timestamp: new Date().toISOString(),
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
  smoke,
  durationMs: performance.now(),
  results,
  regressions,
};
const runsDir = join(benchRoot, 'artifacts', 'runs');
mkdirSync(runsDir, { recursive: true });
const artifactPath = join(runsDir, `${artifact.timestamp.replace(/[:.]/g, '-')}.json`);
writeFileSync(artifactPath, JSON.stringify(artifact, null, 2));
console.log(`\nArtifact: ${artifactPath}`);

if (!smoke && (updateBaseline || Object.keys(baseline).length === 0)) {
  const next: Record<string, number> = {};
  for (const r of results) next[r.name] = r.opsPerSec;
  writeFileSync(baselinePath, JSON.stringify(next, null, 2));
  console.log(`Baseline written: ${baselinePath}`);
}

if (regressions.length > 0) {
  console.warn(`\nRegression(s) >10%: ${regressions.join(', ')}`);
  if (gate) process.exit(1);
}
