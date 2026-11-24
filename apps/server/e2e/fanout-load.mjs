import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { availableParallelism, cpus, tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { createServer as netServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

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

const clientsCount = Number(process.env.WEFT_FANOUT_CLIENTS ?? 100);
const rate = Number(process.env.WEFT_FANOUT_RATE ?? 500);
const seconds = Number(process.env.WEFT_FANOUT_SECONDS ?? 10);
const catchupGateMs = Number(process.env.WEFT_FANOUT_CATCHUP_GATE_MS ?? 0);
const batchSize = Math.min(500, rate);
const total = rate * seconds;
assert.ok(
  clientsCount > 0 && total > 0 && batchSize > 0 && catchupGateMs >= 0,
  'invalid fan-out settings',
);

const temp = mkdtempSync(join(tmpdir(), 'weft-fanout-'));
const pgDir = mkdtempSync(join(tmpdir(), 'weft-fanout-pg-'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let cluster;
let child;
let pool;
let serverSecret;
const connectedClients = [];

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

async function waitFor(fn, label, timeoutMs = 60_000, pollMs = 100) {
  const started = Date.now();
  for (;;) {
    try {
      const value = await fn();
      if (value) return value;
    } catch {
      /* retry */
    }
    if (Date.now() - started > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await sleep(pollMs);
  }
}

function processCpuSeconds(pid) {
  if (process.platform === 'win32') {
    const output = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-Process -Id ${pid} -ErrorAction Stop).TotalProcessorTime.TotalMilliseconds`,
      ],
      { encoding: 'utf8', windowsHide: true },
    );
    return Number(output.trim()) / 1000;
  }
  if (process.platform === 'linux') {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return (Number(fields[11]) + Number(fields[12])) / 100;
  }
  const output = execFileSync('ps', ['-o', 'time=', '-p', String(pid)], { encoding: 'utf8' });
  const match = output.trim().match(/(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)/);
  if (!match) throw new Error(`cannot parse process CPU for ${pid}: ${output}`);
  return Number(match[1] ?? 0) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))] ?? 0;
}

class SseClient {
  constructor(totalEvents) {
    this.totalEvents = totalEvents;
    this.seen = new Uint32Array(totalEvents + 1);
    this.count = 0;
    this.errors = [];
    this.connectMs = 0;
    this.firstChunkMs = 0;
    this.controller = new AbortController();
  }

  async connect(baseUrl, projectId, token) {
    const started = performance.now();
    const response = await fetch(
      `${baseUrl}/v1/stream?projectId=${encodeURIComponent(projectId)}&after=0`,
      {
        headers: { authorization: `Bearer ${token}` },
        signal: this.controller.signal,
      },
    );
    this.connectMs = performance.now() - started;
    assert.equal(response.status, 200, 'SSE connection failed');
    assert.ok(response.body, 'SSE response has no body');
    void this.pump(response.body);
  }

  async pump(body) {
    const started = performance.now();
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (this.firstChunkMs === 0) this.firstChunkMs = performance.now() - started;
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let offset = 0;
        let index;
        while ((index = buffer.indexOf('\n\n', offset)) >= 0) {
          const block = buffer.slice(offset, index);
          offset = index + 2;
          if (!block.startsWith('id: ')) continue;
          const lineEnd = block.indexOf('\n');
          const seq = Number(block.slice(4, lineEnd < 0 ? undefined : lineEnd));
          if (!Number.isInteger(seq) || seq < 1 || seq > this.totalEvents) {
            this.errors.push(`unexpected sequence ${seq}`);
            continue;
          }
          this.seen[seq]++;
          this.count++;
        }
        buffer = buffer.slice(offset);
      }
    } catch (error) {
      if (!this.controller.signal.aborted) this.errors.push(String(error));
    }
  }

  close() {
    this.controller.abort();
  }
}

async function teardown() {
  for (const client of connectedClients) client.close();
  if (serverSecret && child) {
    try {
      const state = JSON.parse(readFileSync(join(temp, 'server', 'server.json'), 'utf8'));
      await fetch(`http://127.0.0.1:${state.port}/v1/shutdown`, {
        method: 'POST',
        headers: { authorization: `Bearer ${serverSecret}` },
      }).catch(() => {});
    } catch {
      /* server already stopped */
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
    {
      cwd: root,
      stdio: ['ignore', 'ignore', 'pipe'],
    },
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
    'Fanout Org',
    `org-${orgId}`,
  ]);
  await pool.query('INSERT INTO teams (id,org_id,name,slug) VALUES ($1,$2,$3,$4)', [
    teamId,
    orgId,
    'Fanout Team',
    `team-${teamId}`,
  ]);
  await pool.query('INSERT INTO projects (id,team_id,name,slug) VALUES ($1,$2,$3,$4)', [
    projectId,
    teamId,
    'Fanout Project',
    `project-${projectId}`,
  ]);
  await pool.query('INSERT INTO users (id,org_id,email,display_name) VALUES ($1,$2,$3,$4)', [
    userId,
    orgId,
    'fanout@example.test',
    'Fanout',
  ]);
  await pool.query('INSERT INTO project_members (project_id,user_id,role) VALUES ($1,$2,$3)', [
    projectId,
    userId,
    'member',
  ]);
  await pool.query('INSERT INTO devices (id,user_id,hostname,os) VALUES ($1,$2,$3,$4)', [
    deviceId,
    userId,
    'fanout-host',
    process.platform,
  ]);
  const tokenResponse = await fetch(`${baseUrl}/v1/admin/tokens`, {
    method: 'POST',
    headers: { authorization: `Bearer ${serverSecret}`, 'content-type': 'application/json' },
    body: JSON.stringify({ projectId, userId, role: 'member' }),
  });
  assert.equal(tokenResponse.status, 201);
  const { token } = await tokenResponse.json();

  const clients = Array.from({ length: clientsCount }, () => new SseClient(total));
  connectedClients.push(...clients);
  await Promise.all(clients.map((client) => client.connect(baseUrl, projectId, token)));
  const actor = {
    user_id: userId,
    agent: { provider: 'Claude Code', model: 'sonnet', adapter: 'hooks@1.4.0' },
  };
  const event = () => ({
    v: 1,
    event_id: ulid(),
    device_id: deviceId,
    project_id: projectId,
    ts: new Date().toISOString(),
    type: 'tool.post',
    actor,
    privacy: 'metadata',
    payload: { tool_name: 'Read', success: true, duration_ms: 1 },
  });
  const latencies = [];
  const batches = Math.ceil(total / batchSize);
  const intervalMs = (seconds * 1000) / batches;
  const cpuBefore = processCpuSeconds(child.pid);
  const started = performance.now();
  let next = started;
  let sent = 0;
  for (let batch = 0; batch < batches; batch++) {
    const wait = next - performance.now();
    if (wait > 0) await sleep(wait);
    next += intervalMs;
    const size = Math.min(batchSize, total - sent);
    const events = Array.from({ length: size }, event);
    const before = performance.now();
    const response = await fetch(`${baseUrl}/v1/ingest`, {
      method: 'POST',
      headers: { authorization: `Bearer ${serverSecret}`, 'content-type': 'application/json' },
      body: JSON.stringify({ events }),
    });
    const body = await response.json();
    latencies.push(performance.now() - before);
    assert.equal(response.status, 202, JSON.stringify(body));
    assert.equal(body.accepted.length, size, JSON.stringify(body.rejected));
    assert.equal(body.rejected.length, 0, JSON.stringify(body.rejected));
    sent += size;
  }
  const ingestSeconds = (performance.now() - started) / 1000;
  await waitFor(
    () => clients.every((client) => client.count >= total),
    'all SSE clients to converge',
    60_000,
  );
  const wallSeconds = (performance.now() - started) / 1000;
  const cpuAfter = processCpuSeconds(child.pid);
  const cpuSeconds = cpuAfter - cpuBefore;
  const parallelism = availableParallelism();
  const invalidClients = clients.filter(
    (client) =>
      client.errors.length > 0 ||
      Array.from(client.seen).some((count, seq) => seq > 0 && count !== 1),
  ).length;
  let catchup;
  if (catchupGateMs > 0) {
    const client = new SseClient(total);
    connectedClients.push(client);
    const catchupStarted = performance.now();
    await client.connect(baseUrl, projectId, token);
    await waitFor(() => client.count >= total, 'catch-up client to converge', 60_000, 1);
    catchup = {
      events: total,
      elapsedMs: +(performance.now() - catchupStarted).toFixed(2),
      connectMs: +client.connectMs.toFixed(2),
      firstChunkMs: +client.firstChunkMs.toFixed(2),
      gateMs: catchupGateMs,
      invalid:
        client.errors.length > 0 ||
        Array.from(client.seen).some((count, seq) => seq > 0 && count !== 1),
      scope: 'loopback SSE connect plus complete 10k-event frame catch-up and sequence validation',
    };
  }
  const artifact = {
    timestamp: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    benchmark: 'server_sse_fanout',
    clients: clientsCount,
    targetRate: rate,
    events: total,
    batchSize,
    batches,
    ingestSeconds: +ingestSeconds.toFixed(3),
    convergenceSeconds: +wallSeconds.toFixed(3),
    actualEventsPerSecond: +(total / ingestSeconds).toFixed(1),
    ingestAckP95Ms: +percentile(latencies, 0.95).toFixed(3),
    serverCpuSeconds: +cpuSeconds.toFixed(3),
    serverCpuOneCorePercent: +((cpuSeconds / wallSeconds) * 100).toFixed(3),
    serverCpuSystemPercent: +((cpuSeconds / (wallSeconds * parallelism)) * 100).toFixed(3),
    parallelism: { cpus: cpus().length, available: parallelism },
    invalidClients,
    deliveries: clientsCount * total,
    ...(catchup ? { catchup } : {}),
    scope:
      'team server Node process CPU; excludes embedded Postgres and load generator; system percent normalizes by available CPUs',
    stderr: stderr.trim() || undefined,
  };
  const runs = join(root, 'bench', 'artifacts', 'runs');
  mkdirSync(runs, { recursive: true });
  const path = join(runs, `server-fanout-${artifact.timestamp.replace(/[:.]/g, '-')}.json`);
  writeFileSync(path, JSON.stringify(artifact, null, 2));
  console.log(JSON.stringify({ ...artifact, artifact: path }, null, 2));
  assert.equal(invalidClients, 0, 'SSE clients lost, duplicated, reordered, or errored');
  assert.ok(
    artifact.actualEventsPerSecond >= rate * 0.95,
    'fan-out load generator fell behind target',
  );
  assert.ok(
    artifact.serverCpuSystemPercent <= 1,
    `server CPU ${artifact.serverCpuSystemPercent.toFixed(2)}% exceeds 1% system budget`,
  );
  if (catchup) {
    assert.equal(catchup.invalid, false, 'catch-up client lost, duplicated, reordered, or errored');
    assert.ok(
      catchup.elapsedMs <= catchup.gateMs,
      `catch-up ${catchup.elapsedMs.toFixed(0)}ms exceeds ${catchup.gateMs}ms`,
    );
  }
  console.log('server fan-out load gate: PASS');
}

main()
  .then(teardown)
  .catch(async (error) => {
    console.error('fan-out load FAILED:', error);
    await teardown();
    process.exitCode = 1;
  });
