import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { createServer as netServer } from 'node:net';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const serverCli = join(root, 'apps', 'server', 'dist', 'cli.js');
const req = createRequire(join(root, 'apps', 'server', 'package.json'));
const EmbeddedPostgres = (await import(pathToFileURL(req.resolve('embedded-postgres')).href))
  .default;
const pgModule = await import(pathToFileURL(req.resolve('pg')).href);
const Pool = pgModule.default?.Pool ?? pgModule.Pool;
const { makeId, ulid } = await import(
  pathToFileURL(join(root, 'packages', 'protocol', 'dist', 'index.js')).href
);
const { DAEMON_MIGRATIONS, migrate, openSqlite } = await import(
  pathToFileURL(join(root, 'packages', 'core', 'dist', 'index.js')).href
);
const { LocalStore } = await import(
  pathToFileURL(join(root, 'apps', 'daemon', 'dist', 'store.js')).href
);
const { OutboxShipper } = await import(
  pathToFileURL(join(root, 'apps', 'daemon', 'dist', 'shipper.js')).href
);

const total = Number(process.env.WEFT_OUTBOX_EVENTS ?? 10_000);
const batchSize = 1000;
const gateMs = Number(process.env.WEFT_OUTBOX_GATE_MS ?? 10_000);
assert.ok(Number.isInteger(total) && total > 0, 'invalid outbox event count');
assert.ok(Number.isFinite(gateMs) && gateMs > 0, 'invalid outbox gate');

const temp = mkdtempSync(join(tmpdir(), 'weft-outbox-'));
const pgDir = mkdtempSync(join(tmpdir(), 'weft-outbox-pg-'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let cluster;
let child;
let pool;
let store;
let shipper;
let serverSecret;

function freePort() {
  return new Promise((resolve, reject) => {
    const server = netServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function waitFor(fn, label, timeoutMs = 60_000) {
  const started = Date.now();
  for (;;) {
    try {
      const value = await fn();
      if (value) return value;
    } catch {
      /* retry */
    }
    if (Date.now() - started > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await sleep(100);
  }
}

async function teardown() {
  await shipper?.stop().catch(() => {});
  store?.db.close();
  if (serverSecret) {
    const statePath = join(temp, 'server', 'server.json');
    if (existsSync(statePath)) {
      const state = JSON.parse(readFileSync(statePath, 'utf8'));
      await fetch(`http://127.0.0.1:${state.port}/v1/shutdown`, {
        method: 'POST',
        headers: { authorization: `Bearer ${serverSecret}` },
      }).catch(() => {});
    }
  }
  if (child && child.exitCode == null) {
    await Promise.race([new Promise((resolve) => child.once('exit', resolve)), sleep(8000)]);
    if (child.exitCode == null) child.kill();
  }
  await pool?.end().catch(() => {});
  await cluster?.stop().catch(() => {});
  await sleep(300);
  rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  rmSync(pgDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

async function main() {
  assert.ok(existsSync(serverCli), 'server dist missing — run pnpm build first');
  const pgPort = await freePort();
  cluster = new EmbeddedPostgres({
    databaseDir: join(pgDir, 'db'),
    port: pgPort,
    user: 'weft',
    password: 'weft',
    persistent: true,
    initdbFlags: ['--locale=C', '--encoding=UTF8'],
    onLog: () => {},
    onError: () => {},
  });
  await cluster.initialise();
  await cluster.start();
  const databaseUrl = `postgres://weft:weft@127.0.0.1:${pgPort}/postgres`;
  const port = await freePort();
  const dataDir = join(temp, 'server');
  child = spawn(
    process.execPath,
    [
      serverCli,
      'start',
      '--data-dir',
      dataDir,
      '--database-url',
      databaseUrl,
      '--port',
      String(port),
      '--log-level',
      'fatal',
    ],
    { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] },
  );
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk.toString()).slice(-32_768);
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitFor(async () => (await fetch(`${baseUrl}/healthz`)).ok, 'server health');
  const state = JSON.parse(readFileSync(join(dataDir, 'server.json'), 'utf8'));
  serverSecret = state.admin_secret;
  pool = new Pool({ connectionString: databaseUrl, max: 20 });

  const orgId = makeId('organization');
  const teamId = makeId('team');
  const projectId = makeId('project');
  const userId = makeId('user');
  const deviceId = makeId('device');
  await pool.query('INSERT INTO organizations (id,name,slug) VALUES ($1,$2,$3)', [
    orgId,
    'Outbox Org',
    `org-${orgId}`,
  ]);
  await pool.query('INSERT INTO teams (id,org_id,name,slug) VALUES ($1,$2,$3,$4)', [
    teamId,
    orgId,
    'Outbox Team',
    `team-${teamId}`,
  ]);
  await pool.query('INSERT INTO projects (id,team_id,name,slug) VALUES ($1,$2,$3,$4)', [
    projectId,
    teamId,
    'Outbox Project',
    `project-${projectId}`,
  ]);
  await pool.query('INSERT INTO users (id,org_id,email,display_name) VALUES ($1,$2,$3,$4)', [
    userId,
    orgId,
    'outbox@example.test',
    'Outbox',
  ]);
  await pool.query('INSERT INTO project_members (project_id,user_id,role) VALUES ($1,$2,$3)', [
    projectId,
    userId,
    'member',
  ]);
  await pool.query('INSERT INTO devices (id,user_id,hostname,os) VALUES ($1,$2,$3,$4)', [
    deviceId,
    userId,
    'outbox-host',
    process.platform,
  ]);
  const tokenResponse = await fetch(`${baseUrl}/v1/admin/tokens`, {
    method: 'POST',
    headers: { authorization: `Bearer ${serverSecret}`, 'content-type': 'application/json' },
    body: JSON.stringify({ projectId, userId, role: 'member' }),
  });
  assert.equal(tokenResponse.status, 201);
  const { token } = await tokenResponse.json();

  mkdirSync(join(temp, 'daemon'), { recursive: true });
  const db = openSqlite(join(temp, 'daemon', 'events.sqlite'));
  migrate(db, DAEMON_MIGRATIONS);
  store = new LocalStore(db);
  const actor = {
    user_id: userId,
    agent: { provider: 'Claude Code', model: 'sonnet', adapter: 'hooks@1.4.0' },
  };
  const events = Array.from({ length: total }, () => ({
    v: 1,
    event_id: ulid(),
    device_id: deviceId,
    project_id: projectId,
    ts: new Date().toISOString(),
    received_at: new Date().toISOString(),
    type: 'tool.post',
    actor,
    privacy: 'metadata',
    payload: { tool_name: 'Read', success: true, duration_ms: 1 },
  }));
  store.insertEvents(events, true);
  assert.equal(store.pendingOutboxCount(), total);

  let offline = true;
  const fetchImpl = async (input, init) => {
    if (offline) throw new Error('simulated network outage');
    return fetch(input, init);
  };
  shipper = new OutboxShipper({
    baseUrl,
    token,
    store,
    fetchImpl,
    batchSize,
    intervalMs: 60_000,
    requestTimeoutMs: 10_000,
  });
  const failed = await shipper.drain();
  assert.ok(failed.error, 'offline drain unexpectedly succeeded');
  assert.equal(shipper.pending, total, 'offline drain lost pending rows');

  offline = false;
  const started = performance.now();
  const drained = await shipper.drain();
  const drainMs = performance.now() - started;
  assert.equal(drained.error, undefined, `reconnect drain failed: ${drained.error}`);
  assert.equal(drained.shipped, total);
  assert.equal(drained.duplicates, 0);
  assert.equal(drained.rejected, 0);
  assert.equal(shipper.pending, 0);
  const persisted = await pool.query(
    'SELECT count(*)::int AS count FROM events WHERE project_id=$1',
    [projectId],
  );
  assert.equal(persisted.rows[0].count, total);

  const artifact = {
    timestamp: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    benchmark: 'daemon_outbox_reconnect_drain',
    events: total,
    batchSize,
    offlinePending: total,
    shipped: drained.shipped,
    duplicates: drained.duplicates,
    rejected: drained.rejected,
    batches: drained.batches,
    drainMs: +drainMs.toFixed(2),
    gateMs,
    persistedEvents: persisted.rows[0].count,
    scope:
      'real SQLite outbox and OutboxShipper against real team server/Postgres after a forced offline attempt; excludes daemon HTTP ingest and watcher',
    stderr: stderr.trim() || undefined,
  };
  const runs = join(root, 'bench', 'artifacts', 'runs');
  mkdirSync(runs, { recursive: true });
  const path = join(runs, `daemon-outbox-${artifact.timestamp.replace(/[:.]/g, '-')}.json`);
  writeFileSync(path, JSON.stringify(artifact, null, 2));
  console.log(JSON.stringify({ ...artifact, artifact: path }, null, 2));
  assert.ok(drainMs <= gateMs, `outbox drain ${drainMs.toFixed(0)}ms exceeds ${gateMs}ms`);
  console.log('outbox reconnect drain gate: PASS');
}

main()
  .then(teardown)
  .catch(async (error) => {
    console.error('outbox drain FAILED:', error);
    await teardown();
    process.exitCode = 1;
  });
