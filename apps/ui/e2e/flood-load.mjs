import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { createServer as netServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const req = createRequire(join(root, 'apps', 'server', 'package.json'));
const serverDist = join(root, 'apps', 'server', 'dist', 'server.js');
const viteBin = join(root, 'apps', 'ui', 'node_modules', 'vite', 'bin', 'vite.js');
const rate = Number(process.env.WEFT_UI_FLOOD_RATE ?? 500);
const seconds = Number(process.env.WEFT_UI_FLOOD_SECONDS ?? 60);
const total = rate * seconds;
const allowShort = process.env.WEFT_UI_FLOOD_ALLOW_SHORT === '1';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const temp = mkdtempSync(join(tmpdir(), 'weft-ui-flood-'));
const pgTemp = mkdtempSync(join(tmpdir(), 'weft-ui-flood-pg-'));
let cluster;
let server;
let vite;
let browser;

function freePort() {
  return new Promise((resolve, reject) => {
    const listener = netServer();
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => {
      const address = listener.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      listener.close(() => resolve(port));
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

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))] ?? 0;
}

async function teardown() {
  await browser?.close().catch(() => {});
  vite?.kill();
  await server?.close().catch(() => {});
  await cluster?.stop().catch(() => {});
  await sleep(300);
  for (const dir of [temp, pgTemp]) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      /* best-effort */
    }
  }
}

async function main() {
  assert.ok(existsSync(serverDist), 'server dist missing — run pnpm build first');
  assert.ok(rate > 0 && seconds > 0, 'invalid UI flood settings');
  if (seconds < 60 && !allowShort)
    throw new Error('short UI flood requires WEFT_UI_FLOOD_ALLOW_SHORT=1');

  const EmbeddedPostgres = (await import(pathToFileURL(req.resolve('embedded-postgres')).href))
    .default;
  const { createServer } = await import(pathToFileURL(serverDist).href);
  const { makeId, ulid, PROTOCOL_VERSION } = await import(
    pathToFileURL(join(root, 'packages', 'protocol', 'dist', 'index.js')).href
  );

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
  const adminSecret = 'ui-flood-admin-secret';
  server = await createServer(
    {
      dataDir: join(temp, 'server'),
      host: '127.0.0.1',
      port: await freePort(),
      databaseUrl,
      logLevel: 'fatal',
      corsOrigin: '*',
    },
    { adminSecret, onShutdown: () => {} },
  );
  const baseUrl = await server.listen();
  const pool = server.db.pool;
  const orgId = makeId('organization');
  const teamId = makeId('team');
  const projectId = makeId('project');
  const userId = makeId('user');
  const deviceId = makeId('device');
  await pool.query('INSERT INTO organizations (id,name,slug) VALUES ($1,$2,$3)', [
    orgId,
    'UI Flood',
    'ui-flood',
  ]);
  await pool.query('INSERT INTO teams (id,org_id,name,slug) VALUES ($1,$2,$3,$4)', [
    teamId,
    orgId,
    'UI Flood',
    'ui-flood',
  ]);
  await pool.query('INSERT INTO projects (id,team_id,name,slug) VALUES ($1,$2,$3,$4)', [
    projectId,
    teamId,
    'UI Flood',
    'ui-flood',
  ]);
  await pool.query('INSERT INTO users (id,org_id,email,display_name) VALUES ($1,$2,$3,$4)', [
    userId,
    orgId,
    'flood@example.test',
    'Flood',
  ]);
  await pool.query('INSERT INTO project_members (project_id,user_id,role) VALUES ($1,$2,$3)', [
    projectId,
    userId,
    'member',
  ]);
  await pool.query('INSERT INTO devices (id,user_id,hostname,os) VALUES ($1,$2,$3,$4)', [
    deviceId,
    userId,
    'flood-host',
    process.platform,
  ]);
  const tokenResponse = await fetch(`${baseUrl}/v1/admin/tokens`, {
    method: 'POST',
    headers: { authorization: `Bearer ${adminSecret}`, 'content-type': 'application/json' },
    body: JSON.stringify({ projectId, userId, role: 'member' }),
  });
  assert.equal(tokenResponse.status, 201);
  const { token } = await tokenResponse.json();
  const sessionId = makeId('session');
  const event = (index) => ({
    v: PROTOCOL_VERSION,
    event_id: ulid(),
    device_id: deviceId,
    project_id: projectId,
    session_id: sessionId,
    ts: new Date().toISOString(),
    type: 'tool.post',
    actor: { user_id: userId, agent: { provider: 'Flood', model: 'load', adapter: 'e2e' } },
    privacy: 'metadata',
    payload: { tool_name: `Flood_${index}`, success: true, duration_ms: 1 },
  });
  const seedResponse = await fetch(`${baseUrl}/v1/ingest`, {
    method: 'POST',
    headers: { authorization: `Bearer ${adminSecret}`, 'content-type': 'application/json' },
    body: JSON.stringify({ events: [event(-1)] }),
  });
  assert.equal(seedResponse.status, 202);

  const uiPort = await freePort();
  vite = spawn(
    process.execPath,
    [viteBin, 'preview', '--host', '127.0.0.1', '--port', String(uiPort), '--strictPort'],
    {
      cwd: join(root, 'apps', 'ui'),
      stdio: 'ignore',
    },
  );
  const uiUrl = `http://127.0.0.1:${uiPort}`;
  await waitFor(async () => (await fetch(uiUrl)).ok, 'production UI');

  const launch = { headless: true, args: ['--no-sandbox'] };
  if (process.env.WEFT_CHROME_PATH) launch.executablePath = process.env.WEFT_CHROME_PATH;
  browser = await chromium.launch(launch);
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  await page.addInitScript(() => {
    const state = { frames: [], longTasks: [], shifts: [], interactions: [] };
    globalThis.__weftPerf = state;
    const observe = (type, callback) => {
      try {
        new PerformanceObserver((list) => callback(list.getEntries())).observe({
          type,
          buffered: true,
        });
      } catch {
        /* unsupported browser metric */
      }
    };
    observe('longtask', (entries) =>
      state.longTasks.push(...entries.map((entry) => entry.duration)),
    );
    observe('layout-shift', (entries) => {
      for (const entry of entries) {
        if (!entry.hadRecentInput) state.shifts.push(entry.value);
      }
    });
    observe('event', (entries) => {
      for (const entry of entries) {
        if (entry.interactionId > 0) state.interactions.push(entry.duration);
      }
    });
    for (const type of ['pointerup', 'keydown']) {
      globalThis.addEventListener(
        type,
        (event) => {
          if (!event.isTrusted) return;
          requestAnimationFrame(() =>
            state.interactions.push(Math.max(0, performance.now() - event.timeStamp)),
          );
        },
        { capture: true },
      );
    }
    const frame = (now) => {
      state.frames.push(now);
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });

  await page.goto(uiUrl, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Connection settings', exact: true }).first().waitFor();
  await page.getByRole('button', { name: 'Connection settings', exact: true }).first().click();
  await page.getByLabel('Server URL').fill(baseUrl);
  await page.getByLabel('Project ID').fill(projectId);
  await page.getByLabel('API token').fill(token);
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await page.getByRole('heading', { name: 'Team activity' }).waitFor();
  await page.getByRole('button', { name: 'Pause stream', exact: true }).waitFor();

  let accepted = 0;
  let rejected = 0;
  const traffic = (async () => {
    const batchSize = 10;
    const intervalMs = (batchSize / rate) * 1000;
    const started = performance.now();
    let next = started;
    for (let offset = 0; offset < total; offset += batchSize) {
      const wait = next - performance.now();
      if (wait > 0) await sleep(wait);
      next += intervalMs;
      const size = Math.min(batchSize, total - offset);
      const response = await fetch(`${baseUrl}/v1/ingest`, {
        method: 'POST',
        headers: { authorization: `Bearer ${adminSecret}`, 'content-type': 'application/json' },
        body: JSON.stringify({ events: Array.from({ length: size }, (_, i) => event(offset + i)) }),
      });
      const body = await response.json();
      assert.equal(response.status, 202, JSON.stringify(body));
      accepted += body.accepted.length;
      rejected += body.rejected.length;
    }
    return (performance.now() - started) / 1000;
  })();
  void traffic.catch(() => {});

  const perfStarted = await page.evaluate(() => performance.now());
  await sleep(3000);
  const scroller = page.locator('[data-virtuoso-scroller]').first();
  const scrollBox = await scroller.boundingBox();
  assert.ok(scrollBox, 'stream scroller has no bounding box');
  await page.mouse.move(scrollBox.x + scrollBox.width / 2, scrollBox.y + scrollBox.height / 2);
  await page.mouse.wheel(0, -100_000);
  await page
    .getByRole('button', { name: 'Stream paused · Resume', exact: true })
    .waitFor({ timeout: 10_000 });
  const pausedScrollTop = await scroller.evaluate((element) => element.scrollTop);
  await sleep(1500);
  assert.ok(
    Math.abs((await scroller.evaluate((element) => element.scrollTop)) - pausedScrollTop) < 2,
    'auto-pause did not hold scroll position',
  );

  await page.getByRole('button', { name: 'Stream paused · Resume', exact: true }).click();
  await page
    .getByRole('button', { name: 'Pause stream', exact: true })
    .waitFor({ timeout: 10_000 });
  await sleep(2000);
  await page.getByRole('button', { name: 'Pause stream', exact: true }).click();
  await page.getByRole('button', { name: 'Stream paused · Resume', exact: true }).waitFor();
  const explicitScrollTop = await scroller.evaluate((element) => element.scrollTop);
  await sleep(1500);
  const explicitScrollAfter = await scroller.evaluate((element) => element.scrollTop);
  const explicitButton = await page
    .getByRole('button', { name: /Stream paused|Pause stream/ })
    .first()
    .getAttribute('aria-pressed');
  assert.ok(
    Math.abs(explicitScrollAfter - explicitScrollTop) < 2,
    `explicit pause moved scrollTop ${explicitScrollTop} → ${explicitScrollAfter}; aria-pressed=${explicitButton}`,
  );
  await page.getByRole('button', { name: 'Stream paused · Resume', exact: true }).click();
  await page
    .getByRole('button', { name: 'Pause stream', exact: true })
    .waitFor({ timeout: 10_000 });

  const trafficSeconds = await traffic;
  await sleep(1000);
  const finalDebug = await page.evaluate(
    (lastIndex) => ({
      header: document.querySelector('main h1')?.parentElement?.textContent,
      button: document.querySelector('button[aria-pressed]')?.textContent,
      scrollTop: document.querySelector('[data-virtuoso-scroller]')?.scrollTop,
      scrollHeight: document.querySelector('[data-virtuoso-scroller]')?.scrollHeight,
      clientHeight: document.querySelector('[data-virtuoso-scroller]')?.clientHeight,
      lastVisible: document.body.innerText.includes(`Flood_${lastIndex}`),
    }),
    total - 1,
  );
  console.log('final stream state', finalDebug);
  assert.ok(
    finalDebug.lastVisible,
    `latest flood event is not visible: ${JSON.stringify(finalDebug)}`,
  );
  await sleep(500);
  const perf = await page.evaluate(() => globalThis.__weftPerf);
  const perfEnded = await page.evaluate(() => performance.now());
  const frames = perf.frames.filter(
    (timestamp) => timestamp >= perfStarted && timestamp <= perfEnded,
  );
  const frameDeltas = frames.slice(1).map((timestamp, index) => timestamp - frames[index]);
  const fps =
    frameDeltas.length > 0
      ? (frameDeltas.length / frameDeltas.reduce((sum, value) => sum + value, 0)) * 1000
      : 0;
  const artifact = {
    timestamp: new Date().toISOString(),
    benchmark: 'ui_event_flood',
    targetRate: rate,
    durationSeconds: seconds,
    attempted: total,
    accepted,
    rejected,
    actualEventsPerSecond: accepted / trafficSeconds,
    trafficSeconds,
    fps,
    frameP95Ms: percentile(frameDeltas, 0.95),
    inpP98Ms: percentile(perf.interactions, 0.98),
    interactionCount: perf.interactions.length,
    interactionMeasurement:
      'Event Timing API when available; trusted input to next animation frame otherwise',
    longTaskMaxMs: Math.max(0, ...perf.longTasks),
    longTaskTotalMs: perf.longTasks.reduce((sum, value) => sum + value, 0),
    layoutShift: perf.shifts.reduce((sum, value) => sum + value, 0),
    autoPauseVerified: true,
    explicitPauseVerified: true,
    pageErrors,
    shortSmoke: seconds < 60,
    scope:
      'production UI in headless Chromium; real team server, Postgres, HTTP ingest and SSE; excludes daemon and watcher',
  };
  const artifacts = join(root, 'bench', 'artifacts', 'runs');
  mkdirSync(artifacts, { recursive: true });
  const artifactPath = join(
    artifacts,
    `ui-flood-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
  );
  writeFileSync(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);
  console.log(JSON.stringify({ ...artifact, artifact: artifactPath }, null, 2));

  assert.equal(accepted, total);
  assert.equal(rejected, 0);
  assert.ok(
    artifact.actualEventsPerSecond >= rate * 0.95,
    'UI flood ingest rate below 95% of target',
  );
  assert.ok(fps >= 60, `UI frame rate ${fps.toFixed(2)} below 60fps`);
  assert.ok(artifact.inpP98Ms <= 200, `UI INP ${artifact.inpP98Ms.toFixed(2)}ms exceeds 200ms`);
  assert.ok(artifact.interactionCount > 0, 'no real interactions measured');
  assert.deepEqual(pageErrors, []);
  console.log('UI flood load gate: PASS');
}

main()
  .then(teardown)
  .catch(async (error) => {
    console.error('UI flood FAILED:', error);
    await teardown();
    process.exitCode = 1;
  });
