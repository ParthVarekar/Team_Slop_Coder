// Weft M2 team-view E2E smoke.
// Run: pnpm build && pnpm test:e2e:team
// Optional: WEFT_CHROME_PATH=<chrome.exe> to reuse an installed Chromium.
//
// Boots a real embedded Postgres 16 cluster + the team server in-process, seeds
// two developers, then drives the browser UI: connect to the team server, verify
// the shared global_seq stream, cross-developer session attribution, live SSE
// fan-out, and inbox triage (inbox → done) round-tripping through the server.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { createServer as netServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const serverDist = join(root, 'apps', 'server', 'dist', 'server.js');
const UI = 'http://localhost:5173';
const req = createRequire(join(root, 'apps', 'server', 'package.json'));

const temp = mkdtempSync(join(tmpdir(), 'weft-team-e2e-'));
const pgTemp = mkdtempSync(join(tmpdir(), 'weft-team-pg-'));
let cluster;
let server;
let vite;
let browser;

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
    await sleep(250);
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

async function teardown() {
  await browser?.close().catch(() => {});
  vite?.kill();
  await server?.close().catch(() => {});
  await cluster?.stop().catch(() => {});
  await sleep(400);
  for (const dir of [temp, pgTemp]) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      /* best-effort: Windows may briefly lock files */
    }
  }
}

async function main() {
  assert.ok(existsSync(serverDist), 'server dist missing — run pnpm build first');

  const EmbeddedPostgres = (await import(pathToFileURL(req.resolve('embedded-postgres')).href))
    .default;
  const { createServer } = await import(pathToFileURL(serverDist).href);
  const { makeId, ulid, PROTOCOL_VERSION } = await import(
    pathToFileURL(join(root, 'packages', 'protocol', 'dist', 'index.js')).href
  );

  // Real, isolated Postgres 16 cluster.
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

  // Team server in-process (applies central migrations on boot).
  const port = await freePort();
  const adminSecret = 'e2e-admin-secret';
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

  // Seed a minimal identity graph: one project, two developers, one device.
  const orgId = makeId('organization');
  const teamId = makeId('team');
  const projectId = makeId('project');
  const priya = makeId('user');
  const marcus = makeId('user');
  const deviceId = makeId('device');
  const sesPriya = makeId('session');
  const sesMarcus = makeId('session');
  await pool.query('INSERT INTO organizations (id, name, slug) VALUES ($1,$2,$3)', [
    orgId,
    'E2E Org',
    `org-${orgId}`,
  ]);
  await pool.query('INSERT INTO teams (id, org_id, name, slug) VALUES ($1,$2,$3,$4)', [
    teamId,
    orgId,
    'E2E Team',
    `team-${teamId}`,
  ]);
  await pool.query('INSERT INTO projects (id, team_id, name, slug) VALUES ($1,$2,$3,$4)', [
    projectId,
    teamId,
    'Team Project',
    `proj-${projectId}`,
  ]);
  await pool.query('INSERT INTO users (id, org_id, email, display_name) VALUES ($1,$2,$3,$4)', [
    priya,
    orgId,
    'priya@e2e.local',
    'Priya',
  ]);
  await pool.query('INSERT INTO users (id, org_id, email, display_name) VALUES ($1,$2,$3,$4)', [
    marcus,
    orgId,
    'marcus@e2e.local',
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
    deviceId,
    priya,
    'e2e-host',
    'linux',
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
    device_id: deviceId,
    project_id: projectId,
    ts: new Date().toISOString(),
    type,
    actor,
    privacy: 'metadata',
    payload: {},
    ...extra,
  });

  // Issue a project-scoped member token for Priya (the UI connects as Priya).
  const tokRes = await fetch(`${baseUrl}/v1/admin/tokens`, {
    method: 'POST',
    headers: admin,
    body: JSON.stringify({ projectId, userId: priya, role: 'member' }),
  });
  assert.equal(tokRes.status, 201);
  const { token } = await tokRes.json();

  // Two developers' sessions + an approval notification addressed to Priya.
  const priyaAgent = {
    user_id: priya,
    agent: { provider: 'Claude Code', model: 'opus', adapter: 'hooks@1.4.0' },
  };
  const marcusAgent = {
    user_id: marcus,
    agent: { provider: 'Codex', model: 'gpt-5', adapter: 'hooks@1.4.0' },
  };
  const seeded = await ingest([
    event('session.started', priyaAgent, {
      session_id: sesPriya,
      payload: { cwd: '/repo', prompt_summary: 'Implement the team stream', fidelity: 'high' },
    }),
    event('session.started', marcusAgent, {
      session_id: sesMarcus,
      payload: { cwd: '/repo', prompt_summary: 'Fix the parser', fidelity: 'high' },
    }),
    event(
      'notification.created',
      { user_id: marcus, agent: null },
      {
        payload: {
          kind: 'approval',
          title: 'Review the merge queue',
          subject: 'Please review the merge',
          target_user_id: priya,
        },
      },
    ),
  ]);
  assert.equal(seeded.status, 202);
  const seededBody = await seeded.json();
  assert.equal(seededBody.accepted.length, 3, JSON.stringify(seededBody.rejected));
  // global_seq is monotonic across the batch — the shared stream ordering key.
  assert.deepEqual(
    seededBody.accepted.map((a) => a.global_seq),
    [1, 2, 3],
  );
  console.log('✓ seeded team world (2 developers, 3 events, global_seq 1..3)');

  // Vite dev server. Team mode talks to the server cross-origin (CORS), not the proxy.
  const viteBin = join(root, 'apps', 'ui', 'node_modules', 'vite', 'bin', 'vite.js');
  vite = spawn(process.execPath, [viteBin, '--port', '5173', '--strictPort'], {
    cwd: join(root, 'apps', 'ui'),
    stdio: 'ignore',
  });
  await waitFor(async () => (await fetch(UI)).ok, 'vite dev server');

  const launch = { headless: true, args: ['--no-sandbox'] };
  if (process.env.WEFT_CHROME_PATH) launch.executablePath = process.env.WEFT_CHROME_PATH;
  browser = await chromium.launch(launch);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));

  await page.goto(UI, { waitUntil: 'domcontentloaded' });

  // 1. Open connection settings (from the error gate or the rail) and connect.
  await page.getByRole('button', { name: 'Connection settings', exact: true }).first().waitFor();
  await page.getByRole('button', { name: 'Connection settings', exact: true }).first().click();
  await page.getByRole('dialog', { name: 'Team server connection' }).waitFor();
  await page.getByLabel('Server URL').fill(baseUrl);
  await page.getByLabel('Project ID').fill(projectId);
  await page.getByLabel('API token').fill(token);
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await page.getByRole('heading', { name: 'Team activity' }).waitFor();
  console.log('✓ connected to team server via UI (cross-origin CORS + Bearer token)');

  // 2. Shared stream renders the seeded events.
  await page.locator('[data-item-index]').first().waitFor();
  const groups = await page.locator('[data-item-index]').count();
  assert.ok(groups >= 1, `expected shared stream activity, got ${groups} groups`);
  console.log(`✓ shared team stream renders (${groups} groups)`);

  // 3. Live SSE fan-out: a new event reaches the connected UI without a reload.
  const live = await ingest([
    event('session.status', priyaAgent, { session_id: sesPriya, payload: { status: 'idle' } }),
  ]);
  assert.equal(live.status, 202);
  await page.waitForFunction(() => document.body.innerText.includes('Status → idle'), null, {
    polling: 50,
    timeout: 10_000,
  });
  console.log('✓ live event fanned out over SSE to the connected UI');

  // 4. Cross-developer sessions carry developer attribution from the directory.
  await page.getByRole('button', { name: 'Sessions', exact: true }).click();
  await page.getByText('Claude Code for Priya').waitFor();
  await page.getByText('Codex for Marcus').waitFor();
  console.log('✓ cross-developer session labels (Claude Code for Priya / Codex for Marcus)');

  // 5. Inbox triage round-trips through the server: inbox → done.
  await page.getByRole('button', { name: 'Inbox', exact: true }).click();
  await page.getByText('Review the merge queue').waitFor();
  await page.getByRole('button', { name: /Review the merge queue/ }).click();
  await page.locator('aside').getByRole('button', { name: 'Mark done', exact: true }).click();
  await page.getByText('Inbox zero').waitFor();
  console.log('✓ inbox triage inbox → done via UI');

  // Verify the server actually persisted the triage (not just local state).
  const inboxRes = await fetch(`${baseUrl}/v1/notifications?projectId=${projectId}&state=inbox`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal((await inboxRes.json()).notifications.length, 0);
  const doneRes = await fetch(`${baseUrl}/v1/notifications?projectId=${projectId}&state=done`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal((await doneRes.json()).notifications.length, 1);
  console.log('✓ triage persisted server-side (inbox 0, done 1)');

  assert.deepEqual(pageErrors, [], `page errors: ${pageErrors.join('; ')}`);
  console.log('\nTeam-view smoke PASSED');
}

main()
  .then(teardown)
  .catch(async (err) => {
    console.error('\nE2E FAILED:', err);
    await teardown();
    process.exit(1);
  });
