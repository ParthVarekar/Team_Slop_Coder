import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { openSqlite, migrate, DAEMON_MIGRATIONS } from '@weft/core';
import { makeId, ulid } from '@weft/protocol';
import { LocalStore } from '../dist/store.js';

const totalEvents = Number(process.env.WEFT_BATCH_EVENTS ?? 50_000);
const batchSize = 100;
const teamMode = process.env.WEFT_BATCH_TEAM !== '0';
const device = makeId('device');
const project = makeId('project');
const repo = makeId('repo');
const session = makeId('session');
const user = makeId('user');
const types = ['tool.post', 'file.changed', 'command.executed', 'session.status', 'tool.pre'];
const payloads = [
  { tool_name: 'Edit', success: true, duration_ms: 12 },
  { path: 'src/auth/token.ts', change_kind: 'modify', source: 'agent_tool', lines_added: 4 },
  { command_display: 'pnpm test', exit_code: 0 },
  { status: 'running' },
  { tool_name: 'Bash', tool_input_summary: { command: 'ls' } },
];

const events = Array.from({ length: totalEvents }, (_, i) => {
  const sample = i % types.length;
  const event = {
    v: 1,
    event_id: ulid(),
    device_id: device,
    project_id: project,
    repo_id: repo,
    session_id: session,
    seq: i,
    ts: new Date().toISOString(),
    type: types[sample],
    actor: {
      user_id: user,
      agent: { provider: 'claude-code', model: 'claude-opus-4-6', adapter: 'hooks@1.4.0' },
    },
    privacy: 'metadata',
    payload: payloads[sample],
  };
  return { ...event, received_at: event.ts };
});

const db = openSqlite(':memory:');
migrate(db, DAEMON_MIGRATIONS);
const store = new LocalStore(db);
try {
  for (let i = 0; i < 25; i++) store.insertEvents(events.slice(0, batchSize), teamMode);
  db.prepare('DELETE FROM outbox').run();
  db.prepare('DELETE FROM events').run();

  const start = performance.now();
  for (let i = 0; i < events.length; i += batchSize) {
    store.insertEvents(events.slice(i, i + batchSize), teamMode);
  }
  const totalMs = performance.now() - start;
  const count = store.countEvents();
  const outbox = teamMode ? store.pendingOutboxCount() : 0;
  assert.equal(count, totalEvents);
  assert.equal(outbox, teamMode ? totalEvents : 0);

  const artifact = {
    timestamp: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    benchmark: 'local_store_batch_insert',
    totalEvents,
    batchSize,
    teamMode,
    totalMs: +totalMs.toFixed(2),
    eventsPerSecond: +((totalEvents / totalMs) * 1000).toFixed(0),
    persistedEvents: count,
    pendingOutbox: outbox,
  };
  const here = dirname(fileURLToPath(import.meta.url));
  const runs = join(here, '../../../bench/artifacts/runs');
  mkdirSync(runs, { recursive: true });
  const path = join(runs, `store-batch-${artifact.timestamp.replace(/[:.]/g, '-')}.json`);
  writeFileSync(path, JSON.stringify(artifact, null, 2));
  console.log(JSON.stringify({ ...artifact, artifact: path }, null, 2));
} finally {
  db.close();
}
