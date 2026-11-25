import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { createServer as netServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { clearTimeout } from 'node:timers';
import { makeId, ulid } from '@weft/protocol';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const daemonCli = join(root, 'apps', 'daemon', 'dist', 'cli.js');
const gcBridge = join(here, 'gc-bridge.mjs');
const durationMs = Number(process.env.WEFT_SOAK_MS ?? 24 * 60 * 60 * 1000);
const sampleMs = Number(process.env.WEFT_SOAK_SAMPLE_MS ?? 60_000);
const warmupMs = Number(process.env.WEFT_SOAK_WARMUP_MS ?? Math.min(300_000, durationMs / 20));
const rate = Number(process.env.WEFT_SOAK_RATE ?? 10);
const sessionsCount = Number(process.env.WEFT_SOAK_SESSIONS ?? 40);
const availableCpus = availableParallelism();
assert.ok(
  durationMs > 0 && sampleMs > 0 && warmupMs >= 0 && warmupMs < durationMs && rate > 0,
  'invalid soak settings',
);
assert.ok(Number.isInteger(sessionsCount) && sessionsCount > 0, 'invalid soak session count');

const temp = mkdtempSync(join(tmpdir(), 'weft-soak-'));
const dataDir = join(temp, '.weft');
const repoDir = join(temp, 'repo');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let child;
let secret;
let port;
let failed;
let generated = 0;
let inspectorUrl;
let inspector;
let gcDone = null;
let gcRequestId = 0;
let baselineSnapshot;
let finalSnapshot;
const heapSnapshots = process.env.WEFT_SOAK_HEAP_SNAPSHOTS === '1';

function freePort() {
  return new Promise((resolve, reject) => {
    const server = netServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const value = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(value));
    });
  });
}

function cpuSeconds(pid) {
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
  const output = execFileSync('ps', ['-o', 'time=', '-p', String(pid)], {
    encoding: 'utf8',
  }).trim();
  const match = output.match(/(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)/);
  if (!match) throw new Error(`cannot parse process CPU: ${output}`);
  return Number(match[1] ?? 0) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

function fdCount(pid) {
  try {
    if (process.platform === 'linux') return readdirSync(`/proc/${pid}/fd`).length;
    if (process.platform === 'win32') {
      const output = execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `(Get-Process -Id ${pid} -ErrorAction Stop).HandleCount`,
        ],
        { encoding: 'utf8', windowsHide: true },
      );
      return Number(output.trim());
    }
    const output = execFileSync('lsof', ['-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return Math.max(0, output.trim().split('\n').length - 1);
  } catch {
    return null;
  }
}

function median(values) {
  const valid = values.filter((value) => value != null).sort((a, b) => a - b);
  if (valid.length === 0) return 0;
  const middle = Math.floor(valid.length / 2);
  return valid.length % 2 ? valid[middle] : (valid[middle - 1] + valid[middle]) / 2;
}

function growth(before, after) {
  return before === 0 ? (after === 0 ? 0 : 1) : (after - before) / before;
}

async function waitFor(fn, label, timeoutMs = 30_000) {
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

class InspectorClient {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.pending = new Map();
    this.nextId = 1;
    this.ws.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      if (message.error) request.reject(new Error(JSON.stringify(message.error)));
      else request.resolve(message.result);
    });
  }

  async open() {
    if (this.ws.readyState === WebSocket.OPEN) return;
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
    });
  }

  async call(method, params = {}) {
    const id = this.nextId++;
    const result = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.ws.send(JSON.stringify({ id, method, params }));
    return result;
  }

  close() {
    this.ws.close();
  }
}

async function post(path, body) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(`${path} failed ${response.status}: ${JSON.stringify(value)}`);
  return value;
}

async function health() {
  const response = await fetch(`http://127.0.0.1:${port}/healthz`);
  if (!response.ok) throw new Error(`health ${response.status}`);
  return response.json();
}

async function collectGarbage() {
  const requestId = ++gcRequestId;
  await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      gcDone = null;
      if (error) reject(error);
      else resolve();
    };
    const timeout = setTimeout(() => finish(new Error('daemon GC request timed out')), 30_000);
    gcDone = () => finish();
    child.send({ type: 'weft:gc', request_id: requestId }, (error) => {
      if (error) finish(error);
    });
  });
}

async function takeHeapSnapshot(label, timestamp) {
  const dir = join(root, 'bench', 'artifacts', 'runs', 'heap');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `daemon-${label}-${timestamp.replace(/[:.]/g, '-')}.heapsnapshot`);
  const result = await inspector.call('Runtime.evaluate', {
    expression: `process.getBuiltinModule('v8').writeHeapSnapshot(${JSON.stringify(path)})`,
    returnByValue: true,
  });
  if (result.exceptionDetails)
    throw new Error(`heap snapshot failed: ${JSON.stringify(result.exceptionDetails)}`);
  console.log(`heap snapshot ${label}: ${path}`);
  return path;
}

async function teardown() {
  inspector?.close();
  if (secret) {
    await fetch(`http://127.0.0.1:${port}/v1/shutdown`, {
      method: 'POST',
      headers: { authorization: `Bearer ${secret}` },
    }).catch(() => {});
  }
  if (child && child.exitCode == null) {
    await Promise.race([new Promise((resolve) => child.once('exit', resolve)), sleep(8000)]);
    if (child.exitCode == null) child.kill();
  }
  await sleep(200);
  rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

async function main() {
  assert.ok(existsSync(daemonCli), 'daemon dist missing — run pnpm build first');
  execFileSync('git', ['init', '-q', '-b', 'main', repoDir], { stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'soak@weft.local'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.name', 'Weft Soak'], { cwd: repoDir });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: repoDir });
  writeFileSync(join(repoDir, 'README.txt'), 'soak fixture\n');
  execFileSync('git', ['add', '-A'], { cwd: repoDir });
  execFileSync('git', ['commit', '-q', '-m', 'fixture'], { cwd: repoDir });

  port = await freePort();
  child = spawn(
    process.execPath,
    [
      '--expose-gc',
      '--import',
      pathToFileURL(gcBridge).href,
      ...(heapSnapshots ? ['--inspect=127.0.0.1:0'] : []),
      daemonCli,
      'start',
      '--data-dir',
      dataDir,
      '--port',
      String(port),
      '--log-level',
      'fatal',
    ],
    {
      cwd: root,
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    },
  );
  child.on('message', (message) => {
    if (message?.type === 'weft:gc:done' && message.request_id === gcRequestId) gcDone?.();
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    stderr = (stderr + text).slice(-32_768);
    const match = stderr.match(/Debugger listening on (ws:\/\/\S+)/);
    if (match) inspectorUrl = match[1];
  });
  const exited = new Promise((resolve) =>
    child.once('exit', (code, signal) => resolve({ code, signal })),
  );
  await waitFor(async () => (await fetch(`http://127.0.0.1:${port}/healthz`)).ok, 'daemon health');
  if (heapSnapshots) {
    try {
      inspectorUrl = await waitFor(() => inspectorUrl, 'daemon inspector');
    } catch (error) {
      throw new Error(`${String(error)}; daemon stderr: ${stderr}`);
    }
    inspector = new InspectorClient(inspectorUrl);
    await inspector.open();
  }
  secret = JSON.parse(readFileSync(join(dataDir, 'identity.json'), 'utf8')).hook_secret;
  await post('/v1/repos', { path: repoDir.replace(/\\/g, '/') });
  const identity = JSON.parse(readFileSync(join(dataDir, 'identity.json'), 'utf8'));
  const sessionIds = Array.from({ length: sessionsCount }, () => makeId('session'));
  const base = {
    v: 1,
    device_id: identity.device_id,
    project_id: identity.project_id,
    session_id: sessionIds[0],
    actor: {
      user_id: identity.user_id,
      agent: { provider: 'Claude Code', model: 'sonnet', adapter: 'hooks@1.4.0' },
    },
    privacy: 'metadata',
  };
  for (const sessionId of sessionIds) {
    await post('/v1/events', {
      ...base,
      session_id: sessionId,
      event_id: ulid(),
      ts: new Date().toISOString(),
      type: 'session.started',
      payload: { cwd: repoDir.replace(/\\/g, '/'), fidelity: 'high' },
    });
  }

  const samples = [];
  const started = performance.now();
  const cpuBefore = cpuSeconds(child.pid);
  let nextSample = started;
  let nextEvent = started;
  const eventInterval = 1000 / rate;
  const totalEvents = Math.floor((durationMs / 1000) * rate);
  const runs = join(root, 'bench', 'artifacts', 'runs');
  mkdirSync(runs, { recursive: true });
  const timestamp = new Date().toISOString();
  const samplePath = join(runs, `daemon-soak-samples-${timestamp.replace(/[:.]/g, '-')}.jsonl`);
  const sampleStream = await import('node:fs').then(({ createWriteStream }) =>
    createWriteStream(samplePath),
  );

  try {
    while (performance.now() - started < durationMs) {
      if (child.exitCode != null)
        throw new Error(`daemon exited early: ${JSON.stringify(await exited)}`);
      const now = performance.now();
      if (now >= nextEvent && generated < totalEvents) {
        const due = Math.min(
          totalEvents - generated,
          Math.floor((now - nextEvent) / eventInterval) + 1,
        );
        for (let i = 0; i < due; i++) {
          try {
            await post('/v1/events', {
              ...base,
              session_id: sessionIds[generated % sessionIds.length],
              event_id: ulid(),
              ts: new Date().toISOString(),
              type: generated % 3 === 0 ? 'tool.pre' : 'tool.post',
              payload:
                generated % 3 === 0
                  ? {
                      tool_name: 'Read',
                      tool_input_summary: { file_path: `src/${generated % 100}.ts` },
                    }
                  : { tool_name: 'Read', success: true, duration_ms: generated % 13 },
            });
            generated++;
          } catch (error) {
            failed = String(error);
          }
          nextEvent += eventInterval;
        }
      }
      if (now >= nextSample) {
        try {
          const uncollected = await health();
          await collectGarbage();
          await sleep(25);
          const status = await health();
          if (heapSnapshots && !baselineSnapshot && now - started >= warmupMs) {
            baselineSnapshot = await takeHeapSnapshot('baseline', timestamp);
          }
          const sample = {
            elapsed_ms: Math.round(now - started),
            ...status.runtime,
            uncollected_rss_bytes: uncollected.runtime.rss_bytes,
            uncollected_heap_used_bytes: uncollected.runtime.heap_used_bytes,
            events: status.events,
            pending: status.pending,
            fd_count: fdCount(child.pid),
            cpu_seconds: +(cpuSeconds(child.pid) - cpuBefore).toFixed(3),
          };
          samples.push(sample);
          sampleStream.write(`${JSON.stringify(sample)}\n`);
          console.log(
            `soak ${(sample.elapsed_ms / 1000).toFixed(0)}s rss=${(sample.rss_bytes / 1048576).toFixed(1)}MB heap=${(sample.heap_used_bytes / 1048576).toFixed(1)}MB events=${sample.events} pending=${sample.pending}`,
          );
        } catch (error) {
          failed = String(error);
        }
        nextSample += sampleMs;
      }
      const until = Math.min(nextSample, nextEvent, started + durationMs);
      await sleep(Math.max(1, Math.min(250, until - performance.now())));
    }
  } finally {
    sampleStream.end();
    await new Promise((resolve) => sampleStream.once('finish', resolve));
  }

  await collectGarbage();
  await sleep(25);
  if (heapSnapshots) finalSnapshot = await takeHeapSnapshot('final', timestamp);
  await sleep(250);
  const finalHealth = await health();
  const finalCpu = cpuSeconds(child.pid) - cpuBefore;
  const baselineEnd = warmupMs * 2;
  const finalWindow = Math.max(sampleMs * 5, Math.min(300_000, durationMs * 0.05));
  const baseline = samples.filter(
    (sample) => sample.elapsed_ms >= warmupMs && sample.elapsed_ms <= baselineEnd,
  );
  const final = samples.filter((sample) => sample.elapsed_ms >= durationMs - finalWindow);
  const usableBaseline =
    baseline.length > 0 ? baseline : samples.slice(0, Math.max(1, Math.floor(samples.length / 3)));
  const usableFinal =
    final.length > 0 ? final : samples.slice(-Math.max(1, Math.floor(samples.length / 3)));
  const result = {
    timestamp,
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    benchmark: 'daemon_soak',
    requestedDurationMs: durationMs,
    actualDurationMs: +(performance.now() - started).toFixed(0),
    sampleMs,
    memorySampleMode: 'post-gc',
    warmupMs,
    finalWindowMs: finalWindow,
    rate,
    sessions: sessionsCount,
    availableCpus,
    generated,
    persistedEvents: finalHealth.events,
    pending: finalHealth.pending,
    samples: samples.length,
    baseline: {
      rssBytes: median(usableBaseline.map((sample) => sample.rss_bytes)),
      heapUsedBytes: median(usableBaseline.map((sample) => sample.heap_used_bytes)),
      heapTotalBytes: median(usableBaseline.map((sample) => sample.heap_total_bytes)),
      externalBytes: median(usableBaseline.map((sample) => sample.external_bytes)),
      arrayBuffersBytes: median(usableBaseline.map((sample) => sample.array_buffers_bytes)),
      uncollectedRssBytes: median(usableBaseline.map((sample) => sample.uncollected_rss_bytes)),
      uncollectedHeapUsedBytes: median(
        usableBaseline.map((sample) => sample.uncollected_heap_used_bytes),
      ),
      activeResources: median(usableBaseline.map((sample) => sample.active_resources)),
      handles: median(usableBaseline.map((sample) => sample.fd_count)),
    },
    final: {
      rssBytes: median(usableFinal.map((sample) => sample.rss_bytes)),
      heapUsedBytes: median(usableFinal.map((sample) => sample.heap_used_bytes)),
      heapTotalBytes: median(usableFinal.map((sample) => sample.heap_total_bytes)),
      externalBytes: median(usableFinal.map((sample) => sample.external_bytes)),
      arrayBuffersBytes: median(usableFinal.map((sample) => sample.array_buffers_bytes)),
      uncollectedRssBytes: median(usableFinal.map((sample) => sample.uncollected_rss_bytes)),
      uncollectedHeapUsedBytes: median(
        usableFinal.map((sample) => sample.uncollected_heap_used_bytes),
      ),
      activeResources: median(usableFinal.map((sample) => sample.active_resources)),
      handles: median(usableFinal.map((sample) => sample.fd_count)),
    },
    rssGrowthPercent: 0,
    heapGrowthPercent: 0,
    averageCpuSystemPercent: 0,
    averageCpuOneCorePercent: 0,
    peakRssBytes: Math.max(...samples.map((sample) => sample.rss_bytes)),
    postWarmupPeakRssBytes: Math.max(
      ...samples
        .filter((sample) => sample.elapsed_ms >= warmupMs)
        .map((sample) => sample.rss_bytes),
    ),
    peakPending: Math.max(...samples.map((sample) => sample.pending)),
    fullAcceptanceRun: durationMs >= 24 * 60 * 60 * 1000,
    ...(baselineSnapshot ? { baselineHeapSnapshot: baselineSnapshot } : {}),
    ...(finalSnapshot ? { finalHeapSnapshot: finalSnapshot } : {}),
    failure: failed,
    stderr: stderr.trim() || undefined,
    sampleArtifact: samplePath,
  };
  result.rssGrowthPercent = +(
    growth(result.baseline.rssBytes, result.final.rssBytes) * 100
  ).toFixed(3);
  result.heapGrowthPercent = +(
    growth(result.baseline.heapUsedBytes, result.final.heapUsedBytes) * 100
  ).toFixed(3);
  result.averageCpuOneCorePercent = +((finalCpu / (result.actualDurationMs / 1000)) * 100).toFixed(
    3,
  );
  result.averageCpuSystemPercent = +(result.averageCpuOneCorePercent / availableCpus).toFixed(3);
  const activeLoad = rate >= 100;
  result.cpuBudgetSystemPercent = activeLoad ? 15 : 1;
  result.rssBudgetBytes = (activeLoad ? 300 : 150) * 1048576;
  const artifactPath = join(runs, `daemon-soak-${timestamp.replace(/[:.]/g, '-')}.json`);
  writeFileSync(artifactPath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ ...result, artifact: artifactPath }, null, 2));

  assert.equal(failed, undefined, `soak transport/storage failure: ${failed}`);
  assert.equal(finalHealth.pending, 0, 'pipeline did not drain');
  assert.ok(
    finalHealth.events >= generated + sessionsCount,
    'durable event count is below generated input',
  );
  assert.ok(result.rssGrowthPercent <= 5, `RSS growth ${result.rssGrowthPercent}% exceeds 5%`);
  assert.ok(result.heapGrowthPercent <= 5, `heap growth ${result.heapGrowthPercent}% exceeds 5%`);
  assert.ok(
    result.averageCpuSystemPercent <= result.cpuBudgetSystemPercent,
    `average CPU ${result.averageCpuSystemPercent}% exceeds ${result.cpuBudgetSystemPercent}% budget`,
  );
  assert.ok(
    result.final.rssBytes < result.rssBudgetBytes,
    `final RSS ${(result.final.rssBytes / 1048576).toFixed(1)}MB exceeds ${activeLoad ? 300 : 150}MB budget`,
  );
  assert.ok(
    result.postWarmupPeakRssBytes < result.rssBudgetBytes,
    `post-warmup peak RSS ${(result.postWarmupPeakRssBytes / 1048576).toFixed(1)}MB exceeds ${activeLoad ? 300 : 150}MB budget`,
  );
  if (!result.fullAcceptanceRun) {
    assert.equal(
      process.env.WEFT_SOAK_ALLOW_SHORT,
      '1',
      'short soak is smoke-only; set WEFT_SOAK_ALLOW_SHORT=1',
    );
    console.log('short daemon soak smoke PASS (not the 24-hour acceptance run)');
  } else {
    console.log('24-hour daemon soak gate: PASS');
  }
}

main()
  .then(teardown)
  .catch(async (error) => {
    console.error('daemon soak FAILED:', error);
    await teardown();
    process.exitCode = 1;
  });
