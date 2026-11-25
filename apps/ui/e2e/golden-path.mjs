// Weft M1 golden path E2E + perf gate.
// Run: pnpm build && pnpm test:e2e
// Optional: WEFT_CHROME_PATH=<chrome.exe> to reuse an installed Chromium.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const daemonCli = join(root, 'apps', 'daemon', 'dist', 'cli.js');
const PORT = 7421;
const BASE = `http://127.0.0.1:${PORT}`;
const UI = 'http://localhost:5173';
const fwd = (p) => p.replace(/\\/g, '/');

const temp = mkdtempSync(join(tmpdir(), 'weft-e2e-'));
const dataDir = join(temp, '.weft');
const repoDir = join(temp, 'repo');
let daemon;
let vite;
let browser;
let secret = '';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, label, timeoutMs = 30_000) {
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

function git(args) {
  execFileSync('git', args, { cwd: repoDir, stdio: 'ignore' });
}

function postHook(body) {
  return fetch(`${BASE}/v1/hooks/claude`, {
    method: 'POST',
    headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))];
}

function sampleProcess(pid) {
  if (process.platform === 'win32') {
    const out = execFileSync('powershell', [
      '-NoProfile',
      '-Command',
      `(Get-Process -Id ${pid} | Select-Object WorkingSet64,CPU | ConvertTo-Json)`,
    ]).toString();
    const j = JSON.parse(out);
    return { rssMB: j.WorkingSet64 / 1e6, cpuSeconds: j.CPU ?? 0 };
  }
  if (process.platform === 'linux') {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8').split(' ');
    const ticks = Number(stat[13]) + Number(stat[14]);
    const rssPages = Number(stat[23]);
    return { rssMB: (rssPages * 4096) / 1e6, cpuSeconds: ticks / 100 };
  }
  const out = execFileSync('ps', ['-o', 'rss=,time=', '-p', String(pid)])
    .toString()
    .trim();
  const [rss, time] = out.split(/\s+/);
  const [m, s] = time.split(':');
  return { rssMB: Number(rss) / 1024, cpuSeconds: Number(m) * 60 + Number(s) };
}

async function teardown() {
  await browser?.close().catch(() => {});
  if (secret) {
    await fetch(`${BASE}/v1/shutdown`, {
      method: 'POST',
      headers: { authorization: `Bearer ${secret}` },
    }).catch(() => {});
  }
  daemon?.kill();
  vite?.kill();
  await sleep(500);
  try {
    rmSync(temp, { recursive: true, force: true, maxRetries: 5 });
  } catch {
    /* best-effort */
  }
}

async function main() {
  assert.ok(existsSync(daemonCli), 'daemon dist missing — run pnpm build first');

  // Git fixture.
  execFileSync('git', ['init', '-q', repoDir], { stdio: 'ignore' });
  git(['config', 'user.email', 'e2e@weft.local']);
  git(['config', 'user.name', 'Weft E2E']);
  git(['config', 'commit.gpgsign', 'false']);
  git(['config', 'core.autocrlf', 'false']);
  execFileSync('git', ['commit', '--allow-empty', '-qm', 'base'], {
    cwd: repoDir,
    stdio: 'ignore',
  });

  // Daemon.
  daemon = spawn(
    process.execPath,
    [daemonCli, 'start', '--data-dir', fwd(dataDir), '--port', String(PORT), '--log-level', 'warn'],
    { cwd: root, stdio: 'ignore' },
  );
  await waitFor(async () => (await fetch(`${BASE}/healthz`)).ok, 'daemon healthz');
  secret = JSON.parse(readFileSync(join(dataDir, 'identity.json'), 'utf8')).hook_secret;

  // Vite dev server (proxies /v1 → daemon). Spawn the bin via node to avoid a
  // shell wrapper; cwd is the UI package so vite.config.ts is picked up.
  const viteBin = join(root, 'apps', 'ui', 'node_modules', 'vite', 'bin', 'vite.js');
  vite = spawn(process.execPath, [viteBin, '--port', String(5173), '--strictPort'], {
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
  await page.getByRole('button', { name: 'Sessions', exact: true }).waitFor();

  // 1. Register the repository through the UI.
  await page.getByRole('button', { name: 'Repositories' }).click();
  await page.getByRole('button', { name: 'Register repository' }).click();
  await page.getByPlaceholder('Absolute path to git repo').fill(fwd(repoDir));
  await page.getByRole('button', { name: 'Register', exact: true }).click();
  await page.getByTitle('Scan now').waitFor();
  console.log('✓ register repo via UI');

  // 2. Drive a real Claude Code session through the hooks adapter.
  const sid = 'e2e-session';
  const cwd = fwd(repoDir);
  for (const h of [
    {
      hook_event_name: 'SessionStart',
      session_id: sid,
      cwd,
      model: 'claude-sonnet-4',
      source: 'startup',
    },
    { hook_event_name: 'UserPromptSubmit', session_id: sid, prompt: 'Implement the golden path' },
    {
      hook_event_name: 'PreToolUse',
      session_id: sid,
      tool_name: 'Write',
      tool_use_id: 'w1',
      tool_input: { file_path: 'src/a.ts' },
    },
    {
      hook_event_name: 'PostToolUse',
      session_id: sid,
      tool_name: 'Write',
      tool_use_id: 'w1',
      tool_input: { file_path: 'src/a.ts' },
      tool_response: { success: true },
    },
    {
      hook_event_name: 'PreToolUse',
      session_id: sid,
      tool_name: 'Bash',
      tool_use_id: 'b1',
      tool_input: { command: 'pnpm test' },
    },
    {
      hook_event_name: 'PostToolUse',
      session_id: sid,
      tool_name: 'Bash',
      tool_use_id: 'b1',
      tool_input: { command: 'pnpm test' },
      tool_response: { stdout: 'ok', exitCode: 0 },
    },
    { hook_event_name: 'Stop', session_id: sid },
  ]) {
    assert.equal((await postHook(h)).status, 202);
  }

  // 3. Grouped activity renders in the virtualized stream.
  await page.locator('[data-item-index]').first().waitFor();
  await page.getByRole('button', { name: 'Refresh lists' }).click();
  await page.getByText('Write × 2').waitFor();
  const groupCount = await page.locator('[data-item-index]').count();
  assert.ok(groupCount >= 4, `expected grouped activity, got ${groupCount} items`);
  console.log(`✓ grouped activity renders (${groupCount} groups)`);

  // 4. Create a task through the UI.
  await page.getByRole('button', { name: 'Tasks' }).click();
  await page.getByRole('button', { name: 'New task' }).click();
  await page.getByPlaceholder('Task title').fill('Golden path task');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.getByText('Golden path task').first().waitFor();
  console.log('✓ create task via UI');

  // 5. Transition the task through the Inspector lifecycle.
  await page.getByRole('button', { name: /Golden path task/ }).click();
  await page.locator('aside').getByRole('button', { name: 'ready', exact: true }).click();
  // State badge text is lower-case in the DOM (CSS uppercases it visually); after
  // the move the "ready" transition button is gone, so this matches the badge.
  await page.locator('aside').getByText('ready', { exact: true }).waitFor();
  console.log('✓ transition task backlog → ready via UI');

  // Clear the task filter so the perf probe events (which carry no task_id) are
  // visible in the activity stream rather than filtered out.
  await page.getByRole('button', { name: 'Clear', exact: true }).click();

  // 6. Perf: hook HTTP hot path p50 ≤ 5ms.
  const hookLatencies = [];
  for (let i = 0; i < 200; i++) {
    const t0 = performance.now();
    const res = await postHook({
      hook_event_name: 'PreToolUse',
      session_id: 'perf',
      tool_name: 'Read',
      tool_input: { file_path: `f${i}.ts` },
    });
    await res.text();
    hookLatencies.push(performance.now() - t0);
  }
  const hookP50 = percentile(hookLatencies, 0.5);
  const hookP95 = percentile(hookLatencies, 0.95);
  console.log(`  hook ingest p50=${hookP50.toFixed(2)}ms p95=${hookP95.toFixed(2)}ms`);
  assert.ok(hookP50 <= 5, `hook p50 ${hookP50.toFixed(2)}ms exceeds 5ms budget`);

  // 7. Perf: event → UI p95 ≤ 100ms.
  const uiLatencies = [];
  for (let i = 0; i < 15; i++) {
    const marker = `Probe_${i}`;
    const t0 = performance.now();
    await postHook({
      hook_event_name: 'PreToolUse',
      session_id: 'ui-perf',
      tool_name: marker,
      tool_input: {},
    });
    await page.waitForFunction((m) => document.body.innerText.includes(m), marker, {
      polling: 16,
      timeout: 5000,
    });
    uiLatencies.push(performance.now() - t0);
  }
  const uiP95 = percentile(uiLatencies, 0.95);
  console.log(`  event→UI p95=${uiP95.toFixed(2)}ms`);
  assert.ok(uiP95 <= 100, `event→UI p95 ${uiP95.toFixed(2)}ms exceeds 100ms budget`);

  // 8. Perf: idle daemon < 1% CPU / < 150MB RSS.
  const idleWindowMs = 10_000;
  const before = sampleProcess(daemon.pid);
  await sleep(idleWindowMs);
  const after = sampleProcess(daemon.pid);
  const idleCpu = ((after.cpuSeconds - before.cpuSeconds) / (idleWindowMs / 1000)) * 100;
  console.log(`  idle cpu=${idleCpu.toFixed(2)}% rss=${after.rssMB.toFixed(1)}MB`);
  assert.ok(after.rssMB < 150, `idle RSS ${after.rssMB.toFixed(1)}MB exceeds 150MB budget`);
  assert.ok(idleCpu < 1, `idle CPU ${idleCpu.toFixed(2)}% exceeds 1% budget`);

  await page.getByRole('button', { name: 'Command palette' }).click();
  await page.getByPlaceholder('Search commands, sessions, tasks, repos…').fill('retention');
  await page.getByRole('option', { name: 'Retention and compaction…' }).click();
  const retention = page.getByRole('dialog', { name: 'Retention and compaction' });
  await retention.getByRole('heading', { name: 'Local database' }).waitFor();
  await retention.getByText('Hot events (exact)', { exact: true }).waitFor();
  await retention.getByRole('button', { name: 'Dry run (writes nothing)' }).click();
  await retention.getByText('Dry-run selection', { exact: true }).waitFor();
  await retention.getByRole('button', { name: 'Done' }).click();
  console.log('✓ retention status and non-destructive dry run');

  assert.deepEqual(pageErrors, [], `page errors: ${pageErrors.join('; ')}`);
  console.log('\nGolden path + perf gate PASSED');
}

main()
  .then(teardown)
  .catch(async (err) => {
    console.error('\nE2E FAILED:', err);
    await teardown();
    process.exit(1);
  });
