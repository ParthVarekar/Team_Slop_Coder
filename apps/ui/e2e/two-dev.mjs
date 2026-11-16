// Weft M2 two-developer coordination E2E + perf gate.
// Run: pnpm build && pnpm test:e2e:twodev
// Optional: WEFT_CHROME_PATH=<chrome.exe> to reuse an installed Chromium.
//
// Boots a real embedded Postgres 16 cluster + the team server in-process and
// seeds two developers (Claude Code + Codex) working one shared repo. Proves the
// M2 coordination guarantees through the authoritative API and the browser UI:
//   1. shared visibility      — both developers' sessions + live cross-dev fan-out
//   2. no double-claims       — concurrent claims yield exactly one winner
//   3. file-conflict warning  — an overlap card surfaces to the team before merge
//   4. completion = evidence  — COMPLETED is refused until a validation run passes
// and gates event→team-UI p95 <= 250ms over the live SSE path.
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

const temp = mkdtempSync(join(tmpdir(), 'weft-twodev-e2e-'));
const pgTemp = mkdtempSync(join(tmpdir(), 'weft-twodev-pg-'));
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

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))];
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

  const EmbeddedPostgres = (await import(pathToFileURL(req.resolve('embedded-postgres')).href)).default;
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
  const adminSecret = 'twodev-admin-secret';
  server = await createServer(
    { dataDir: join(temp, 'server'), host: '127.0.0.1', port, databaseUrl, logLevel: 'fatal', corsOrigin: '*' },
    { adminSecret, onShutdown: () => {} },
  );
  const baseUrl = await server.listen();
  const pool = server.db.pool;
  await waitFor(async () => (await fetch(`${baseUrl}/healthz`)).ok, 'server healthz');

  // Identity graph: one project, two developers, one shared repo, two devices.
  const orgId = makeId('organization');
  const teamId = makeId('team');
  const projectId = makeId('project');
  const repoId = makeId('repo');
  const priya = makeId('user');
  const marcus = makeId('user');
  const devicePriya = makeId('device');
  const deviceMarcus = makeId('device');
  const sesPriya = makeId('session');
  const sesMarcus = makeId('session');
  await pool.query('INSERT INTO organizations (id, name, slug) VALUES ($1,$2,$3)', [orgId, 'TwoDev Org', `org-${orgId}`]);
  await pool.query('INSERT INTO teams (id, org_id, name, slug) VALUES ($1,$2,$3,$4)', [teamId, orgId, 'TwoDev Team', `team-${teamId}`]);
  await pool.query('INSERT INTO projects (id, team_id, name, slug) VALUES ($1,$2,$3,$4)', [projectId, teamId, 'Shared Repo Project', `proj-${projectId}`]);
  await pool.query('INSERT INTO users (id, org_id, email, display_name) VALUES ($1,$2,$3,$4)', [priya, orgId, 'priya@twodev.local', 'Priya']);
  await pool.query('INSERT INTO users (id, org_id, email, display_name) VALUES ($1,$2,$3,$4)', [marcus, orgId, 'marcus@twodev.local', 'Marcus']);
  await pool.query('INSERT INTO project_members (project_id, user_id, role) VALUES ($1,$2,$3)', [projectId, priya, 'member']);
  await pool.query('INSERT INTO project_members (project_id, user_id, role) VALUES ($1,$2,$3)', [projectId, marcus, 'member']);
  await pool.query('INSERT INTO devices (id, user_id, hostname, os) VALUES ($1,$2,$3,$4)', [devicePriya, priya, 'priya-host', 'linux']);
  await pool.query('INSERT INTO devices (id, user_id, hostname, os) VALUES ($1,$2,$3,$4)', [deviceMarcus, marcus, 'marcus-host', 'darwin']);

  const admin = { authorization: `Bearer ${adminSecret}`, 'content-type': 'application/json' };
  const ingest = (events) =>
    fetch(`${baseUrl}/v1/ingest`, { method: 'POST', headers: admin, body: JSON.stringify({ events }) });
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
    fetch(`${baseUrl}${path}${path.includes('?') ? '&' : '?'}projectId=${encodeURIComponent(projectId)}`, {
      headers: { authorization: `Bearer ${token}` },
    });
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

  const priyaAgent = { user_id: priya, agent: { provider: 'Claude Code', model: 'opus', adapter: 'hooks@1.4.0' } };
  const marcusAgent = { user_id: marcus, agent: { provider: 'Codex', model: 'gpt-5', adapter: 'hooks@1.4.0' } };

  // --- Phase 1: shared visibility (two providers, one repo) ------------------
  const seeded = await ingest([
    event('session.started', priyaAgent, { session_id: sesPriya, repo_id: repoId, payload: { cwd: '/repo', prompt_summary: 'Implement the team stream', fidelity: 'high' } }),
    event('session.started', marcusAgent, { session_id: sesMarcus, repo_id: repoId, device_id: deviceMarcus, payload: { cwd: '/repo', prompt_summary: 'Fix the parser', fidelity: 'high' } }),
  ]);
  assert.equal(seeded.status, 202);
  const seededBody = await seeded.json();
  assert.equal(seededBody.accepted.length, 2, JSON.stringify(seededBody.rejected));
  console.log('✓ seeded two developers on one shared repo (Claude Code + Codex)');

  // Vite dev server. Team mode talks to the server cross-origin (CORS).
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
  await page.getByRole('button', { name: 'Connection settings', exact: true }).first().waitFor();
  await page.getByRole('button', { name: 'Connection settings', exact: true }).first().click();
  await page.getByRole('dialog', { name: 'Team server connection' }).waitFor();
  await page.getByLabel('Server URL').fill(baseUrl);
  await page.getByLabel('Project ID').fill(projectId);
  await page.getByLabel('API token').fill(priyaToken);
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await page.getByRole('heading', { name: 'Team activity' }).waitFor();

  await page.getByRole('button', { name: 'Sessions', exact: true }).click();
  await page.getByText('Claude Code for Priya').waitFor();
  await page.getByText('Codex for Marcus').waitFor();
  // A live event from Marcus reaches Priya's UI without a reload.
  const live = await ingest([
    event('session.status', marcusAgent, { session_id: sesMarcus, device_id: deviceMarcus, payload: { status: 'idle' } }),
  ]);
  assert.equal(live.status, 202);
  await page.waitForFunction(() => document.body.innerText.includes('Status → idle'), null, { polling: 50, timeout: 10_000 });
  console.log('✓ shared visibility: both developers visible + live cross-developer SSE fan-out');

  // --- Phase 2: no double-claims (atomic CAS, exactly one winner) ------------
  const created = await post('/v1/tasks', priyaToken, { title: 'Shared integration task', repoId });
  assert.equal(created.status, 201);
  const sharedTask = (await created.json()).task;
  const ready = await post(`/v1/tasks/${sharedTask.id}/transition`, priyaToken, { baseVersion: 0, to: 'ready' });
  assert.equal(ready.status, 200);
  const readyVersion = (await ready.json()).task.version;

  const [resPriya, resMarcus] = await Promise.all([
    post(`/v1/tasks/${sharedTask.id}/claim`, priyaToken, { baseVersion: readyVersion, claimant: priyaAgent, deviceId: devicePriya }),
    post(`/v1/tasks/${sharedTask.id}/claim`, marcusToken, { baseVersion: readyVersion, claimant: marcusAgent, deviceId: deviceMarcus }),
  ]);
  const bodyPriya = await resPriya.json();
  const bodyMarcus = await resMarcus.json();
  const winners = [bodyPriya, bodyMarcus].filter((b) => b.ok);
  const losers = [bodyPriya, bodyMarcus].filter((b) => !b.ok);
  assert.equal(winners.length, 1, `expected exactly one claim winner: ${JSON.stringify([bodyPriya, bodyMarcus])}`);
  assert.equal(losers.length, 1);
  assert.ok(losers[0].winner_claimant, 'loser must record the winner');
  assert.match(losers[0].reason, /claimed/);
  const winnerName = winners[0].snapshot.state === 'claimed' ? 'exactly one winner' : 'unexpected';
  assert.equal(winnerName, 'exactly one winner');

  // The winning state is visible to the team in the Tasks pane.
  await page.getByRole('button', { name: 'Tasks', exact: true }).click();
  await page.getByRole('button', { name: 'Refresh lists' }).click();
  const taskRow = page.getByRole('button', { name: /Shared integration task/ }).filter({ hasText: 'claimed' });
  await taskRow.waitFor();
  assert.ok((await taskRow.innerText()).toLowerCase().includes('claimed'), 'task row should show claimed');
  console.log('✓ no double-claims: concurrent claims → exactly one winner, loser rejected, state shared in UI');

  // --- Phase 3: file-conflict warning surfaced before merge ------------------
  const mkTask = async (title, branch, token) => {
    const res = await post('/v1/tasks', token, { title, repoId, branch, expectedFiles: ['src/shared.ts'] });
    assert.equal(res.status, 201);
    return (await res.json()).task.id;
  };
  const taskA = await mkTask('Priya edits shared.ts', 'priya/shared-ts', priyaToken);
  const taskB = await mkTask('Marcus edits shared.ts', 'marcus/shared-ts', marcusToken);
  // A daemon-style detection ships through ingest: it lands in the shared team
  // stream AND folds into a canonical server card (one card per logical conflict).
  const conflictEvent = event('conflict.detected', marcusAgent, {
    repo_id: repoId,
    device_id: deviceMarcus,
    payload: {
      canonical_key: 'advisory-key',
      kind: 'file_overlap',
      severity: 'warning',
      state: 'open',
      detection_epoch: 0,
      task_ids: [taskA, taskB],
      paths: ['src/shared.ts'],
      repo_id: repoId,
      branch_a: 'marcus/shared-ts',
      branch_b: 'priya/shared-ts',
      evidence: [{ kind: 'diff-overlap', paths: ['src/shared.ts'], detector_device_id: deviceMarcus }],
    },
  });
  const conflictRes = await ingest([conflictEvent]);
  assert.equal(conflictRes.status, 202);
  const conflictBody = await conflictRes.json();
  assert.equal(conflictBody.accepted.length, 1, JSON.stringify(conflictBody.rejected));

  const cardsRes = await get('/v1/conflicts', priyaToken);
  assert.equal(cardsRes.status, 200);
  const cards = (await cardsRes.json()).conflicts;
  const overlap = cards.find((c) => c.kind === 'file_overlap');
  assert.ok(overlap, 'expected a file_overlap conflict card');
  assert.equal(overlap.state, 'open');
  assert.equal(overlap.severity, 'warning');
  assert.ok(overlap.paths.includes('src/shared.ts'));
  assert.deepEqual([...overlap.task_ids].sort(), [taskA, taskB].sort());
  // The warning is visible to the whole team in the shared activity stream.
  await page.waitForFunction(() => document.body.innerText.includes('conflict.detected'), null, { polling: 50, timeout: 10_000 });
  console.log('✓ file-conflict warning before merge: canonical open card + shared stream visibility');

  // --- Phase 4: completion requires passing validation evidence --------------
  const evidenceCreated = await post('/v1/tasks', priyaToken, { title: 'Evidence-gated task', repoId });
  assert.equal(evidenceCreated.status, 201);
  const evidenceTask = (await evidenceCreated.json()).task;
  let v = evidenceTask.version;
  for (const to of ['ready', 'claimed', 'in_progress', 'review', 'validation']) {
    const res = await post(`/v1/tasks/${evidenceTask.id}/transition`, priyaToken, { baseVersion: v, to });
    const body = await res.json();
    assert.equal(res.status, 200, `transition ${to} failed: ${JSON.stringify(body)}`);
    v = body.task.version;
  }

  await page.getByRole('button', { name: 'Tasks', exact: true }).click();
  await page.getByRole('button', { name: 'Refresh lists' }).click();
  await page.getByRole('button', { name: /Evidence-gated task/ }).filter({ hasText: 'validation' }).click();
  await page.locator('aside').getByText('validation', { exact: true }).waitFor();
  // COMPLETED without evidence is refused; the UI surfaces the server's reason.
  await page.locator('aside').getByRole('button', { name: 'completed', exact: true }).click();
  await page.locator('aside').getByText(/cannot complete without a passing validation run/).waitFor();
  const refused = await post(`/v1/tasks/${evidenceTask.id}/transition`, priyaToken, { baseVersion: v, to: 'completed' });
  assert.equal(refused.status, 422);
  assert.equal((await refused.json()).error, 'evidence_required');
  console.log('✓ completion refused without evidence (UI error + HTTP 422 evidence_required)');

  // Ship a passing validation run (daemon evidence), then completion succeeds.
  const runId = makeId('validation');
  const evidenceRes = await ingest([
    event('validation.started', priyaAgent, { repo_id: repoId, task_id: evidenceTask.id, payload: { run_id: runId, trigger: 'task', checks: ['build'], selection: 'full' } }),
    event('validation.completed', priyaAgent, { repo_id: repoId, task_id: evidenceTask.id, payload: { run_id: runId, state: 'passed', checks: [{ check_id: 'build', exit_code: 0 }] } }),
  ]);
  assert.equal(evidenceRes.status, 202);
  const evidenceBody = await evidenceRes.json();
  assert.equal(evidenceBody.accepted.length, 2, JSON.stringify(evidenceBody.rejected));
  const runsRes = await get(`/v1/validation/runs?taskId=${evidenceTask.id}`, priyaToken);
  const runs = (await runsRes.json()).runs;
  assert.ok(runs.some((r) => r.state === 'passed'), 'expected a passing validation run');

  await page.locator('aside').getByRole('button', { name: 'completed', exact: true }).click();
  // Wait for the post-completion 'ready' button: getByText('completed') would also
  // match the transition button itself and race the async server commit.
  await page.locator('aside').getByRole('button', { name: 'ready', exact: true }).waitFor();
  const completed = await get(`/v1/tasks/${evidenceTask.id}`, priyaToken);
  assert.equal((await completed.json()).task.state, 'completed');
  console.log('✓ completion granted only after passing evidence (UI + server state completed)');

  // --- Phase 5: perf gate — event→team-UI p95 <= 250ms -----------------------
  await page.getByRole('button', { name: 'Clear', exact: true }).click();
  const perfSession = makeId('session');
  const uiLatencies = [];
  for (let i = 0; i < 15; i++) {
    const marker = `TeamProbe_${i}`;
    const t0 = performance.now();
    const res = await ingest([event('tool.pre', priyaAgent, { session_id: perfSession, payload: { tool_name: marker } })]);
    assert.equal(res.status, 202);
    const ingested = await res.json();
    assert.equal(ingested.accepted.length, 1, `probe rejected: ${JSON.stringify(ingested.rejected)}`);
    await page.waitForFunction((m) => document.body.innerText.includes(m), marker, { polling: 16, timeout: 5000 });
    uiLatencies.push(performance.now() - t0);
  }
  const uiP95 = percentile(uiLatencies, 0.95);
  console.log(`  event→team-UI p95=${uiP95.toFixed(2)}ms`);
  assert.ok(uiP95 <= 250, `event→team-UI p95 ${uiP95.toFixed(2)}ms exceeds 250ms budget`);

  assert.deepEqual(pageErrors, [], `page errors: ${pageErrors.join('; ')}`);
  console.log('\nTwo-developer coordination + perf gate PASSED');
}

main()
  .then(teardown)
  .catch(async (err) => {
    console.error('\nE2E FAILED:', err);
    await teardown();
    process.exit(1);
  });