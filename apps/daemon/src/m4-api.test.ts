import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WeftConfigSchema } from '@weft/core';
import { makeId } from '@weft/protocol';
import { Daemon } from './daemon.js';
import { createApiServer, type ApiServer } from './api.js';

let dir: string;
let daemon: Daemon;
let api: ApiServer;
let secret: string;
const gitDirs: string[] = [];

// A real check that fails only when app.txt contains BUG; tolerant of repos
// without app.txt so it never spuriously fails unrelated fixtures.
const bugCheck = {
  check_id: 'bugcheck',
  command: process.execPath,
  args: ['-e', "const fs=require('fs');process.exit(fs.existsSync('app.txt')&&fs.readFileSync('app.txt','utf8').includes('BUG')?1:0)"],
  selection: 'full',
};

function g(repo: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true }).trim();
}

function initRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'weft-m4api-repo-'));
  gitDirs.push(repo);
  g(repo, ['init', '-q', '-b', 'main']);
  g(repo, ['config', 'user.name', 'Test']);
  g(repo, ['config', 'user.email', 'test@example.com']);
  g(repo, ['config', 'commit.gpgsign', 'false']);
  g(repo, ['config', 'core.autocrlf', 'false']);
  return repo;
}

function makeRepo(files: Record<string, string>): string {
  const repo = initRepo();
  for (const [path, content] of Object.entries(files)) {
    const abs = join(repo, path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  g(repo, ['add', '-A']);
  g(repo, ['commit', '-q', '-m', 'base']);
  return repo;
}

function makeRegressionRepo(): { repo: string; baselineOid: string; culpritOid: string } {
  const repo = initRepo();
  writeFileSync(join(repo, 'app.txt'), 'clean\n');
  writeFileSync(join(repo, 'other.txt'), 'keep\n');
  g(repo, ['add', '-A']);
  g(repo, ['commit', '-q', '-m', 'healthy baseline']);
  const baselineOid = g(repo, ['rev-parse', 'HEAD']);
  writeFileSync(join(repo, 'app.txt'), 'BUG\n');
  g(repo, ['add', 'app.txt']);
  g(repo, ['commit', '-q', '-m', 'introduce bug']);
  const culpritOid = g(repo, ['rev-parse', 'HEAD']);
  return { repo, baselineOid, culpritOid };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'weft-m4api-'));
  const config = WeftConfigSchema.parse({ dataDir: dir, logLevel: 'fatal', validation: { checks: [bugCheck] } });
  daemon = new Daemon({ config });
  await daemon.start();
  api = createApiServer(daemon);
  secret = daemon.identity.hook_secret;
});
afterEach(async () => {
  await api.close();
  await daemon.stop();
  rmSync(dir, { recursive: true, force: true });
  for (const repo of gitDirs.splice(0)) {
    try {
      rmSync(repo, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      /* Windows transient handles */
    }
  }
});

const auth = () => ({ authorization: `Bearer ${secret}` });
const post = (url: string, payload: unknown) =>
  api.app.inject({ method: 'POST', url, headers: auth(), payload });

const TIA_FILES: Record<string, string> = {
  'src/util.ts': 'export const util = 1;\n',
  'src/util.test.ts': "import { util } from './util.js';\nexport const t = util;\n",
  'src/other.test.ts': 'export const o = 1;\n',
  'src/__tests__/integration.ts': "import { util } from '../util.js';\nexport const i = util;\n",
};

describe('daemon M4 API — solo mode merge queue is unavailable', () => {
  it('merge/tick, merge/enqueue and merge/entries all fail closed with 409 solo_mode', async () => {
    const repo = await daemon.registerRepo(makeRepo({ 'a.txt': 'a\n' }));
    const tick = await post(`/v1/repos/${repo.repo_id}/merge/tick`, {});
    expect(tick.statusCode).toBe(409);
    expect(tick.json()).toMatchObject({ error: 'solo_mode' });
    const enqueue = await post(`/v1/repos/${repo.repo_id}/merge/enqueue`, { task_id: makeId('task'), branch: 'weft/x' });
    expect(enqueue.statusCode).toBe(409);
    const entries = await api.app.inject({ method: 'GET', url: `/v1/repos/${repo.repo_id}/merge/entries`, headers: auth() });
    expect(entries.statusCode).toBe(409);
  });

  it('rejects unauthenticated M4 calls', async () => {
    const res = await api.app.inject({ method: 'POST', url: `/v1/repos/${makeId('repo')}/merge/tick`, payload: {} });
    expect(res.statusCode).toBe(401);
  });
});

describe('daemon M4 API — test impact analysis', () => {
  it('selects the tests that import a changed module', async () => {
    const repo = await daemon.registerRepo(makeRepo(TIA_FILES));
    const res = await post(`/v1/repos/${repo.repo_id}/affected-tests`, { changed_paths: ['src/util.ts'] });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      repo_id: repo.repo_id,
      affected_tests: ['src/__tests__/integration.ts', 'src/util.test.ts'],
    });
  });

  it('404s an unknown repo and 400s an empty change set', async () => {
    const missing = await post(`/v1/repos/${makeId('repo')}/affected-tests`, { changed_paths: ['src/util.ts'] });
    expect(missing.statusCode).toBe(404);
    const repo = await daemon.registerRepo(makeRepo(TIA_FILES));
    const bad = await post(`/v1/repos/${repo.repo_id}/affected-tests`, { changed_paths: [] });
    expect(bad.statusCode).toBe(400);
  });
});

describe('daemon M4 API — contract gates', () => {
  it('runs gates and partitions blocking failures from passes', async () => {
    const repo = await daemon.registerRepo(makeRepo({ 'api.yaml': 'openapi: 3.0.0\n' }));
    const res = await post(`/v1/repos/${repo.repo_id}/contract-gates`, {
      gates: [
        { gate_id: 'pass', tool: 'custom', command: process.execPath, args: ['-e', 'process.exit(0)'] },
        { gate_id: 'fail', tool: 'custom', command: process.execPath, args: ['-e', 'process.exit(1)'], blocking: true },
      ],
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; blocking: { gate_id: string }[]; passed: { gate_id: string }[] };
    expect(body.ok).toBe(false);
    expect(body.blocking.map((r) => r.gate_id)).toEqual(['fail']);
    expect(body.passed.map((r) => r.gate_id)).toEqual(['pass']);
  });

  it('404s an unknown repo', async () => {
    const res = await post(`/v1/repos/${makeId('repo')}/contract-gates`, {
      gates: [{ gate_id: 'x', tool: 'custom', command: process.execPath, args: ['-e', 'process.exit(0)'] }],
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('daemon M4 API — attribution + safe revert-test', () => {
  it('ranks the culprit first and confirms it by a real revert-test', async () => {
    const { repo, baselineOid, culpritOid } = makeRegressionRepo();
    const registered = await daemon.registerRepo(repo);
    const attr = await post(`/v1/repos/${registered.repo_id}/attribution`, {
      baseline_oid: baselineOid,
      failing_checks: [{ check_id: 'bugcheck', paths: ['app.txt'] }],
    });
    expect(attr.statusCode).toBe(200);
    const suspects = (attr.json() as { suspects: { oid: string }[] }).suspects;
    expect(suspects[0]?.oid).toBe(culpritOid);

    const revert = await post(`/v1/repos/${registered.repo_id}/revert-test`, { suspect_oid: culpritOid });
    expect(revert.statusCode).toBe(200);
    const body = revert.json() as { confirmed: boolean; revertOid?: string };
    expect(body.confirmed).toBe(true);
    expect(body.revertOid).toBeTruthy();
    // The user's HEAD is untouched; the revert is a dangling object.
    expect(g(repo, ['rev-parse', 'HEAD'])).toBe(culpritOid);
    expect(g(repo, ['show', `${body.revertOid}:other.txt`])).toBe('keep');
  });

  it('404s attribution on an unknown repo and 400s a malformed revert-test body', async () => {
    const missing = await post(`/v1/repos/${makeId('repo')}/attribution`, {
      baseline_oid: 'a'.repeat(40),
      failing_checks: [{ check_id: 'bugcheck', paths: ['app.txt'] }],
    });
    expect(missing.statusCode).toBe(404);
    const repo = await daemon.registerRepo(makeRepo({ 'a.txt': 'a\n' }));
    const bad = await post(`/v1/repos/${repo.repo_id}/revert-test`, {});
    expect(bad.statusCode).toBe(400);
  });
});