// Weft M2 dogfood: TWO REAL daemon processes + the team server, end to end.
// Run: pnpm build && pnpm test:e2e:twodaemon
//
// Unlike the in-process Playwright suites, this spawns two actual `weft daemon`
// CLI processes (node apps/daemon/dist/cli.js start --mode team) against a real
// embedded Postgres 16 + team server, on a scratch committed git fixture. It
// proves the production wiring across process boundaries:
//   1. shared visibility      — hook -> adapter -> pipeline -> SQLite outbox ->
//                               shipper -> server ingest -> both devices' events
//                               queryable on the server (incl. watcher file.changed)
//   2. coordination propagate — a server reservation.acquired reaches BOTH daemons'
//                               enforcement caches over the coordination SSE link
//   3. no double-claims       — concurrent server claims yield one winner, and BOTH
//                               daemons' task caches fold the authoritative state
//   4. outbox drain           — both daemons' durable outboxes drain to zero
// The scratch repo is a throwaway fixture (own initial commit); the user's real
// repository is never registered, so no auto-WIP commits touch it.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { createServer as netServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const serverDist = join(root, 'apps', 'server', 'dist', 'server.js');
const cliDist = join(root, 'apps', 'daemon', 'dist', 'cli.js');
const req = createRequire(join(root, 'apps', 'server', 'package.json'));

const temp = mkdtempSync(join(tmpdir(), 'weft-twodaemon-e2e-'));
const pgTemp = mkdtempSync(join(tmpdir(), 'weft-twodaemon-pg-'));
let cluster;
let server;
const daemons = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, label, timeoutMs = 60_000) {
  const start = Date.now();
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      /* retry */
    }
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await sleep(200);
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = netServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

async function teardown() {
  for (const d of daemons) {
    try {
      await fetch(`${d.baseUrl}/v1/shutdown`, {
        method: 'POST',
        headers: { authorization: `Bearer ${d.secret ?? ''}` },
      });
    } catch {
      /* already down */
    }
  }
  await Promise.all(daemons.map((d) => Promise.race([d.exited, sleep(8000)]).catch(() => {})));
  for (const d of daemons) {
    try {
      d.proc.kill();
    } catch {
      /* already exited */
    }
  }
  await server?.close().catch(() => {});
  await cluster?.stop().catch(() => {});
  await sleep(500);
  for (const dir of [temp, pgTemp]) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      /* best-effort: Windows may briefly lock files */
    }
  }
}

function spawnDaemon(name, dataDir, cfgPath, port) {
  const proc = spawn(process.execPath, [cliDist, 'start', '--config', cfgPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  proc.stderr.on('data', (b) => {
    stderr += b.toString();
  });
  proc.stdout.on('data', () => {});
  const exited = new Promise((resolve) => proc.on('exit', (code) => resolve(code)));
  const d = {
    name,
    dataDir,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    proc,
    exited,
    secret: null,
    get stderr() {
      return stderr;
    },
  };
  daemons.push(d);
  return d;
}

const dPost = (d, path, body) =>
  fetch(`${d.baseUrl}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${d.secret}`, 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
const dGet = (d, path) =>
  fetch(`${d.baseUrl}${path}`, { headers: { authorization: `Bearer ${d.secret}` } });

async function main() {
  assert.ok(existsSync(serverDist), 'server dist missing — run pnpm build first');
  assert.ok(existsSync(cliDist), 'daemon dist missing — run pnpm build first');

  const EmbeddedPostgres = (await import(pathToFileURL(req.resolve('embedded-postgres')).href))
    .default;
  const { createServer } = await import(pathToFileURL(serverDist).href);
  const { makeId, ulid, PROTOCOL_VERSION } = await import(
    pathToFileURL(join(root, 'packages', 'protocol', 'dist', 'index.js')).href
  );

  // Real, isolated Postgres 16 cluster + team server (applies central migrations).
  const pgPort = await freePort();
  cluster = new EmbeddedPostgres({
    databaseDir: join(pgTemp, 'db'),
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
  const adminSecret = 'twodaemon-admin-secret';
  server = await createServer(
    {
      dataDir: join(temp, 'server'),
      host: '127.0.0.1',
      port,
      databaseUrl,
      logLevel: 'fatal',
      corsOrigin: '*',
    },
    { adminSecret, onShutdown: () => {} },
  );
  const baseUrl = await server.listen();
  const pool = server.db.pool;
  await waitFor(async () => (await fetch(`${baseUrl}/healthz`)).ok, 'server healthz');

  // Identity graph: one project, two developers, two devices.
  const orgId = makeId('organization');
  const teamId = makeId('team');
  const projectId = makeId('project');
  const repoId = makeId('repo');
  const priya = makeId('user');
  const marcus = makeId('user');
  const devicePriya = makeId('device');
  const deviceMarcus = makeId('device');
  await pool.query('INSERT INTO organizations (id, name, slug) VALUES ($1,$2,$3)', [
    orgId,
    'Dogfood Org',
    `org-${orgId}`,
  ]);
  await pool.query('INSERT INTO teams (id, org_id, name, slug) VALUES ($1,$2,$3,$4)', [
    teamId,
    orgId,
    'Dogfood Team',
    `team-${teamId}`,
  ]);
  await pool.query('INSERT INTO projects (id, team_id, name, slug) VALUES ($1,$2,$3,$4)', [
    projectId,
    teamId,
    'Dogfood Project',
    `proj-${projectId}`,
  ]);
  await pool.query('INSERT INTO users (id, org_id, email, display_name) VALUES ($1,$2,$3,$4)', [
    priya,
    orgId,
    'priya@dogfood.local',
    'Priya',
  ]);
  await pool.query('INSERT INTO users (id, org_id, email, display_name) VALUES ($1,$2,$3,$4)', [
    marcus,
    orgId,
    'marcus@dogfood.local',
    'Marcus',
  ]);
  await pool.query('INSERT INTO project_members (project_id, user_id, role) VALUES ($1,$2,$3)', [
    projectId,
    priya,
    'member',
  ]);
  await pool.query('INSERT INTO project_members (project_id, user_id, role) VALUES ($1,$2,$3)', [
    projectId,
    marcus,
    'member',
  ]);
  await pool.query('INSERT INTO devices (id, user_id, hostname, os) VALUES ($1,$2,$3,$4)', [
    devicePriya,
    priya,
    'priya-host',
    'win32',
  ]);
  await pool.query('INSERT INTO devices (id, user_id, hostname, os) VALUES ($1,$2,$3,$4)', [
    deviceMarcus,
    marcus,
    'marcus-host',
    'darwin',
  ]);

  const admin = { authorization: `Bearer ${adminSecret}`, 'content-type': 'application/json' };
  const ingest = (events) =>
    fetch(`${baseUrl}/v1/ingest`, {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ events }),
    });
  const event = (type, actor, extra = {}) => ({
    v: PROTOCOL_VERSION,
    event_id: ulid(),
    device_id: devicePriya,
    project_id: projectId,
    ts: new Date().toISOString(),
    type,
    actor,
    privacy: 'metadata',
    payload: {},
    ...extra,
  });
  const post = (path, token, body) =>
    fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ projectId, ...body }),
    });
  const get = (path, token) =>
    fetch(
      `${baseUrl}${path}${path.includes('?') ? '&' : '?'}projectId=${encodeURIComponent(projectId)}`,
      {
        headers: { authorization: `Bearer ${token}` },
      },
    );
  const issueToken = async (userId) => {
    const res = await fetch(`${baseUrl}/v1/admin/tokens`, {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ projectId, userId, role: 'member' }),
    });
    assert.equal(res.status, 201);
    return (await res.json()).token;
  };
  const priyaToken = await issueToken(priya);
  const marcusToken = await issueToken(marcus);
  const priyaAgent = {
    user_id: priya,
    agent: { provider: 'Claude Code', model: 'opus', adapter: 'hooks@1.4.0' },
  };
  const marcusAgent = {
    user_id: marcus,
    agent: { provider: 'Codex', model: 'gpt-5', adapter: 'hooks@1.4.0' },
  };

  // Scratch git fixture: own initial commit, clean tree. Never the user's repo.
  const repoDir = join(temp, 'repo');
  mkdirSync(join(repoDir, 'src'), { recursive: true });
  git(['init', '-b', 'main'], repoDir);
  git(['config', 'user.email', 'fixture@weft.local'], repoDir);
  git(['config', 'user.name', 'Weft Fixture'], repoDir);
  writeFileSync(join(repoDir, 'src', 'shared.ts'), 'export const shared = 1;\n');
  git(['add', '-A'], repoDir);
  git(['commit', '-m', 'fixture: initial shared module'], repoDir);

  // Two real daemon processes, each with its own data dir + loopback port.
  const portA = await freePort();
  const portB = await freePort();
  const dirA = join(temp, 'daemonA');
  const dirB = join(temp, 'daemonB');
  const cfgA = join(temp, 'cfgA.json');
  const cfgB = join(temp, 'cfgB.json');
  writeFileSync(
    cfgA,
    JSON.stringify({
      mode: 'team',
      dataDir: dirA,
      logLevel: 'fatal',
      server: { url: baseUrl, token: priyaToken, projectId, deviceId: devicePriya },
      hooks: { host: '127.0.0.1', port: portA },
    }),
  );
  writeFileSync(
    cfgB,
    JSON.stringify({
      mode: 'team',
      dataDir: dirB,
      logLevel: 'fatal',
      server: { url: baseUrl, token: marcusToken, projectId, deviceId: deviceMarcus },
      hooks: { host: '127.0.0.1', port: portB },
    }),
  );
  const A = spawnDaemon('priya', dirA, cfgA, portA);
  const B = spawnDaemon('marcus', dirB, cfgB, portB);

  for (const d of [A, B]) {
    await waitFor(async () => {
      const r = await fetch(`${d.baseUrl}/healthz`);
      if (!r.ok) return false;
      return (await r.json()).mode === 'team';
    }, `${d.name} daemon healthz (team)`);
    d.secret = JSON.parse(readFileSync(join(d.dataDir, 'identity.json'), 'utf8')).hook_secret;
    const boot = await (await fetch(`${d.baseUrl}/v1/bootstrap`)).json();
    assert.equal(boot.project_id, projectId);
    console.log(
      `✓ daemon ${d.name} up (pid ${d.proc.pid}, device ${boot.device_id}, mode ${boot.mode})`,
    );
  }
  assert.equal((await (await dGet(A, '/healthz')).json()).device_id, devicePriya);
  assert.equal((await (await dGet(B, '/healthz')).json()).device_id, deviceMarcus);

  // Register + watch the scratch repo on daemon A (watcher/git reconciliation path).
  const reg = await dPost(A, '/v1/repos', { path: repoDir });
  const regBody = await reg.json().catch(() => ({}));
  assert.equal(reg.status, 201, `repo register failed: ${JSON.stringify(regBody)}`);
  A.repoId = regBody.repo.repo_id;

  // --- Drive real provider hooks through each daemon's adapter ---------------
  const hookA = async (body) => {
    const r = await dPost(A, '/v1/hooks/claude', body);
    const j = await r.json().catch(() => ({}));
    assert.equal(r.status, 202, `claude hook rejected: ${JSON.stringify(j)}`);
  };
  const hookB = async (body) => {
    const r = await dPost(B, '/v1/hooks/codex', body);
    const j = await r.json().catch(() => ({}));
    assert.equal(r.status, 202, `codex hook rejected: ${JSON.stringify(j)}`);
  };
  const tShip = performance.now();
  await hookA({
    hook_event_name: 'SessionStart',
    session_id: 'sess-priya',
    cwd: repoDir,
    model: 'claude-sonnet-4',
    source: 'startup',
  });
  await hookA({
    hook_event_name: 'UserPromptSubmit',
    session_id: 'sess-priya',
    prompt: 'Implement the shared module',
  });
  await hookA({
    hook_event_name: 'PreToolUse',
    session_id: 'sess-priya',
    tool_name: 'Write',
    tool_use_id: 'w1',
    tool_input: { file_path: 'src/shared.ts' },
  });
  await hookA({
    hook_event_name: 'PostToolUse',
    session_id: 'sess-priya',
    tool_name: 'Write',
    tool_use_id: 'w1',
    tool_input: { file_path: 'src/shared.ts' },
    tool_response: { success: true },
  });
  await hookB({
    hook_event_name: 'SessionStart',
    session_id: 'sess-marcus',
    cwd: repoDir,
    model: 'gpt-5',
    source: 'startup',
  });
  await hookB({
    hook_event_name: 'PreToolUse',
    session_id: 'sess-marcus',
    tool_name: 'apply_patch',
    tool_use_id: 'p1',
    tool_input: {
      command:
        '*** Update File: src/shared.ts\n@@\n-export const shared = 1;\n+export const shared = 2;\n',
    },
  });

  // Modify the working tree and force a reconciliation -> watcher file.changed.
  writeFileSync(join(repoDir, 'src', 'shared.ts'), 'export const shared = 2;\n');
  const scan = await dPost(A, `/v1/repos/${A.repoId}/scan`, {});
  const scanBody = await scan.json().catch(() => ({}));
  assert.ok(scan.ok, `scan failed: ${JSON.stringify(scanBody)}`);

  // --- 1. shared visibility: both devices' events durable on the server ------
  const visible = await waitFor(async () => {
    const j = await (await get('/v1/events?limit=1000', priyaToken)).json();
    const devs = new Set(j.events.map((e) => e.device_id));
    return devs.has(devicePriya) && devs.has(deviceMarcus) ? j.events : false;
  }, 'both devices visible on server');
  const shipMs = performance.now() - tShip;
  const providers = new Set(
    visible.filter((e) => e.type === 'session.started').map((e) => e.actor?.agent?.provider),
  );
  assert.ok(providers.has('claude-code'), 'expected a claude-code session on the server');
  assert.ok(providers.has('codex'), 'expected a codex session on the server');
  assert.ok(
    visible.some((e) => e.type === 'file.changed' && e.device_id === devicePriya),
    'expected watcher file.changed from daemon A',
  );
  console.log(
    `✓ shared visibility: both daemons shipped to server (claude-code + codex + watcher file.changed) in ${shipMs.toFixed(0)}ms`,
  );

  // --- 2. coordination propagation: server reservation reaches both caches ---
  const holderTask = makeId('task');
  const tProp = performance.now();
  const resv = await ingest([
    event('reservation.acquired', priyaAgent, {
      repo_id: repoId,
      task_id: holderTask,
      payload: { path_glob: 'src/**', mode: 'hard', holder_task_id: holderTask },
    }),
  ]);
  assert.equal(resv.status, 202);
  assert.equal((await resv.json()).accepted.length, 1, 'reservation rejected');
  for (const d of [A, B]) {
    await waitFor(async () => {
      const j = await (await dPost(d, '/v1/enforcement/check', { path: 'src/shared.ts' })).json();
      return j.result === 'blocked';
    }, `${d.name} enforcement cache blocked by server reservation`);
  }
  const propMs = performance.now() - tProp;
  assert.ok(propMs <= 5000, `coordination propagation ${propMs.toFixed(0)}ms too slow`);
  console.log(
    `✓ coordination propagation: server hard reservation blocked BOTH daemons' enforcement in ${propMs.toFixed(0)}ms`,
  );

  // --- 3. no double-claims: one winner, both task caches fold the state ------
  const created = await post('/v1/tasks', priyaToken, { title: 'Dogfood shared task', repoId });
  assert.equal(created.status, 201);
  const task = (await created.json()).task;
  const ready = await post(`/v1/tasks/${task.id}/transition`, priyaToken, {
    baseVersion: 0,
    to: 'ready',
  });
  assert.equal(ready.status, 200);
  const readyVersion = (await ready.json()).task.version;
  const [rA, rB] = await Promise.all([
    post(`/v1/tasks/${task.id}/claim`, priyaToken, {
      baseVersion: readyVersion,
      claimant: priyaAgent,
      deviceId: devicePriya,
    }),
    post(`/v1/tasks/${task.id}/claim`, marcusToken, {
      baseVersion: readyVersion,
      claimant: marcusAgent,
      deviceId: deviceMarcus,
    }),
  ]);
  const bA = await rA.json();
  const bB = await rB.json();
  const winners = [bA, bB].filter((b) => b.ok);
  const losers = [bA, bB].filter((b) => !b.ok);
  assert.equal(winners.length, 1, `expected exactly one claim winner: ${JSON.stringify([bA, bB])}`);
  assert.equal(losers.length, 1);
  assert.ok(losers[0].winner_claimant, 'loser must record the winner');
  for (const d of [A, B]) {
    await waitFor(async () => {
      const j = await (await dGet(d, '/v1/team/tasks')).json();
      const t = j.tasks.find((x) => x.id === task.id);
      return t && t.state === 'claimed';
    }, `${d.name} task cache reflects authoritative claim`);
  }
  console.log(
    '✓ no double-claims: exactly one winner; BOTH daemon task caches folded the claimed state',
  );

  // --- 4. outbox drain: both durable outboxes reach zero ---------------------
  for (const d of [A, B]) {
    await waitFor(async () => {
      const j = await (await dGet(d, '/v1/enforcement')).json();
      return j.outbox_pending === 0 && j.connected === true;
    }, `${d.name} outbox drained + coordination connected`);
  }
  console.log('✓ outbox drain: both daemons fully shipped (pending=0) and coordination connected');

  console.log('\nTwo-daemon dogfood PASSED (real processes, real Postgres, real git fixture)');
}

main()
  .then(teardown)
  .catch(async (err) => {
    console.error('\nDOGFOOD FAILED:', err);
    for (const d of daemons) {
      if (d.stderr) console.error(`--- daemon ${d.name} stderr ---\n${d.stderr.slice(-2000)}`);
    }
    await teardown();
    process.exit(1);
  });
