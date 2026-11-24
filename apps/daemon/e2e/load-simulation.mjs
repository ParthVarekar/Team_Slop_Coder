import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { DAEMON_MIGRATIONS, Redactor, migrate, openSqlite } from '@weft/core';
import { makeId, ulid } from '@weft/protocol';
import { LocalStore } from '../dist/store.js';
import { EventPipeline } from '../dist/pipeline.js';

const rate = Number(process.env.WEFT_LOAD_RATE ?? 500);
const durationSeconds = Number(process.env.WEFT_LOAD_SECONDS ?? 60);
const sessions = Number(process.env.WEFT_LOAD_SESSIONS ?? 40);
const total = rate * durationSeconds;
assert.ok(Number.isInteger(total) && total > 0 && sessions > 0, 'invalid load settings');

const dir = mkdtempSync(join(tmpdir(), 'weft-load-'));
const db = openSqlite(join(dir, 'events.sqlite'));
migrate(db, DAEMON_MIGRATIONS);
const store = new LocalStore(db);
const pipeline = new EventPipeline(store, {
  batchSize: 100,
  flushIntervalMs: 50,
  redactor: new Redactor(),
});
const deviceId = makeId('device');
const projectId = makeId('project');
const userId = makeId('user');
const sessionIds = Array.from({ length: sessions }, () => makeId('session'));
const actor = {
  user_id: userId,
  agent: { provider: 'Claude Code', model: 'sonnet', adapter: 'hooks@1.4.0' },
};
const latencies = [];
let maxPending = 0;
let rejected = 0;

function envelope(i, type, payload, sessionId = sessionIds[i % sessions]) {
  return {
    v: 1,
    event_id: ulid(),
    device_id: deviceId,
    project_id: projectId,
    ...(sessionId ? { session_id: sessionId } : {}),
    ts: new Date().toISOString(),
    type,
    actor,
    privacy: 'metadata',
    payload,
  };
}

function enqueue(event) {
  const start = performance.now();
  const result = pipeline.enqueue(event);
  latencies.push(performance.now() - start);
  maxPending = Math.max(maxPending, pipeline.pending);
  if (!result.accepted) rejected++;
  return result;
}

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))] ?? 0;
}

try {
  for (let i = 0; i < sessions; i++) {
    assert.ok(
      enqueue(envelope(i, 'session.started', { cwd: dir, fidelity: 'high' }, sessionIds[i]))
        .accepted,
      'session seed rejected',
    );
  }
  pipeline.flush();
  const started = performance.now();
  const intervalMs = 1000 / rate;
  let next = started;
  for (let i = 0; i < total; i++) {
    const wait = next - performance.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    next += intervalMs;
    const type = i % 5 === 0 ? 'tool.pre' : 'tool.post';
    const payload =
      type === 'tool.pre'
        ? { tool_name: 'Read', tool_input_summary: { file_path: `src/file-${i % 200}.ts` } }
        : { tool_name: 'Read', success: true, duration_ms: i % 17 };
    enqueue(envelope(i, type, payload));
  }
  const elapsedSeconds = (performance.now() - started) / 1000;
  pipeline.stop();
  const persisted = store.countEvents();
  const p50 = percentile(latencies, 0.5);
  const p99 = percentile(latencies, 0.99);
  const artifact = {
    timestamp: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    benchmark: 'daemon_pipeline_burst',
    rate,
    durationSeconds: +elapsedSeconds.toFixed(3),
    sessions,
    attempted: total + sessions,
    persisted,
    rejected,
    maxPending,
    actualEventsPerSecond: +(total / elapsedSeconds).toFixed(1),
    enqueueP50Ms: +p50.toFixed(3),
    enqueueP99Ms: +p99.toFixed(3),
    harnessRssMb: +(process.memoryUsage().rss / 1024 / 1024).toFixed(1),
    scope: 'pipeline and SQLite only; excludes HTTP, watcher, indexer, UI and validation children',
  };
  const here = dirname(fileURLToPath(import.meta.url));
  const runs = join(here, '../../../bench/artifacts/runs');
  mkdirSync(runs, { recursive: true });
  const path = join(runs, `daemon-load-${artifact.timestamp.replace(/[:.]/g, '-')}.json`);
  writeFileSync(path, JSON.stringify(artifact, null, 2));
  console.log(JSON.stringify({ ...artifact, artifact: path }, null, 2));
  assert.equal(rejected, 0, 'load produced rejected events');
  assert.equal(persisted, total + sessions, 'persisted event count does not match accepted input');
  assert.ok(p99 <= 25, `enqueue p99 ${p99.toFixed(2)}ms exceeds 25ms`);
  assert.ok(
    artifact.actualEventsPerSecond >= rate * 0.95,
    'load generator fell behind target rate',
  );
  console.log('daemon burst load gate: PASS');
} finally {
  pipeline.stop();
  db.close();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
