import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WeftConfigSchema } from '@weft/core';
import { makeId } from '@weft/protocol';
import { Daemon } from './daemon.js';
import { createApiServer, type ApiServer } from './api.js';
import { draftEvent } from './events.js';

let dir: string;
let daemon: Daemon;
let api: ApiServer;
let secret: string;
const gitDirs: string[] = [];

function makeGitRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'weft-api-repo-'));
  gitDirs.push(repo);
  const g = (args: string[]) =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true });
  g(['init', '-q', '-b', 'main']);
  g(['config', 'user.name', 'Test']);
  g(['config', 'user.email', 'test@example.com']);
  g(['config', 'commit.gpgsign', 'false']);
  g(['config', 'core.autocrlf', 'false']);
  writeFileSync(join(repo, 'base.txt'), 'base\n');
  g(['add', 'base.txt']);
  g(['commit', '-q', '-m', 'base']);
  return repo;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'weft-api-'));
  const config = WeftConfigSchema.parse({ dataDir: dir, logLevel: 'fatal' });
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

function sampleEvent(type = 'tool.post') {
  return draftEvent(daemon.source, {
    type,
    actor: daemon.actor,
    payload:
      type === 'session.started'
        ? { cwd: '/repo', fidelity: 'high' }
        : { tool_name: 'Read', success: true },
  });
}

describe('local API', () => {
  it('reports health without auth', async () => {
    const res = await api.app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, mode: 'solo' });
  });

  it('bootstraps the local secret', async () => {
    const res = await api.app.inject({ method: 'GET', url: '/v1/bootstrap' });
    expect(res.statusCode).toBe(200);
    expect(res.json().hook_secret).toBe(secret);
  });

  it('rejects unauthenticated ingest and reads', async () => {
    const ingest = await api.app.inject({
      method: 'POST',
      url: '/v1/events',
      payload: sampleEvent(),
    });
    expect(ingest.statusCode).toBe(401);
    const read = await api.app.inject({ method: 'GET', url: '/v1/events' });
    expect(read.statusCode).toBe(401);
  });

  it('rejects a wrong secret', async () => {
    const res = await api.app.inject({
      method: 'POST',
      url: '/v1/events',
      headers: { authorization: 'Bearer nope' },
      payload: sampleEvent(),
    });
    expect(res.statusCode).toBe(401);
  });

  it('ingests an event and serves it back over the query API', async () => {
    const ingest = await api.app.inject({
      method: 'POST',
      url: '/v1/events',
      headers: auth(),
      payload: sampleEvent(),
    });
    expect(ingest.statusCode).toBe(202);
    expect(ingest.json().accepted).toBe(true);
    daemon.pipeline.flush();
    const res = await api.app.inject({ method: 'GET', url: '/v1/events', headers: auth() });
    expect(res.statusCode).toBe(200);
    expect(res.json().events).toHaveLength(1);
    expect(res.json().cursor).toBe(1);
  });

  it('rejects a malformed envelope with 422', async () => {
    const res = await api.app.inject({
      method: 'POST',
      url: '/v1/events',
      headers: auth(),
      payload: { bogus: true },
    });
    expect(res.statusCode).toBe(422);
  });

  it('requires auth for shutdown and invokes the shutdown hook', async () => {
    let called = 0;
    const shutdownApi = createApiServer(daemon, { onShutdown: () => called++ });
    try {
      const denied = await shutdownApi.app.inject({ method: 'POST', url: '/v1/shutdown' });
      expect(denied.statusCode).toBe(401);
      const ok = await shutdownApi.app.inject({
        method: 'POST',
        url: '/v1/shutdown',
        headers: auth(),
      });
      expect(ok.statusCode).toBe(202);
      await new Promise((resolve) => setImmediate(resolve));
      expect(called).toBe(1);
    } finally {
      await shutdownApi.close();
    }
  });

  it('translates Claude hooks into events with a stable session mapping', async () => {
    const start = await api.app.inject({
      method: 'POST',
      url: '/v1/hooks/claude',
      headers: auth(),
      payload: {
        session_id: 'native-xyz',
        cwd: '/repo',
        hook_event_name: 'SessionStart',
        source: 'startup',
        model: 'claude',
      },
    });
    expect(start.statusCode).toBe(202);
    expect(start.json().accepted).toBe(1);
    const post = await api.app.inject({
      method: 'POST',
      url: '/v1/hooks/claude',
      headers: auth(),
      payload: {
        session_id: 'native-xyz',
        cwd: '/repo',
        hook_event_name: 'PostToolUse',
        tool_name: 'Edit',
        tool_input: { file_path: '/repo/a.ts' },
        tool_response: { success: true },
      },
    });
    expect(post.json().accepted).toBe(2);
    daemon.pipeline.flush();
    const events = await api.app.inject({ method: 'GET', url: '/v1/events', headers: auth() });
    expect(events.json().events.map((e: { type: string }) => e.type)).toEqual([
      'session.started',
      'tool.post',
      'file.changed',
    ]);
    const sessionIds = new Set(
      events.json().events.map((e: { session_id: string }) => e.session_id),
    );
    expect(sessionIds.size).toBe(1);
    const sessions = await api.app.inject({ method: 'GET', url: '/v1/sessions', headers: auth() });
    expect(sessions.json().sessions).toHaveLength(1);
    expect(sessions.json().sessions[0].provider_session_id).toBe('native-xyz');
    expect(sessions.json().sessions[0].provider_id).toBe('claude-code');
  });

  it('rejects malformed Claude hooks with 422', async () => {
    const res = await api.app.inject({
      method: 'POST',
      url: '/v1/hooks/claude',
      headers: auth(),
      payload: { hook_event_name: 'Stop' },
    });
    expect(res.statusCode).toBe(422);
  });

  it('translates Codex hooks into events with a codex session mapping', async () => {
    const start = await api.app.inject({
      method: 'POST',
      url: '/v1/hooks/codex',
      headers: auth(),
      payload: {
        session_id: 'thr_codex',
        cwd: '/repo',
        hook_event_name: 'SessionStart',
        source: 'startup',
        model: 'gpt-5-codex',
      },
    });
    expect(start.statusCode).toBe(202);
    expect(start.json().accepted).toBe(1);
    const post = await api.app.inject({
      method: 'POST',
      url: '/v1/hooks/codex',
      headers: auth(),
      payload: {
        session_id: 'thr_codex',
        cwd: '/repo',
        hook_event_name: 'PostToolUse',
        tool_name: 'apply_patch',
        tool_input: {
          command: '*** Begin Patch\n*** Update File: a.ts\n@@\n-x\n+y\n*** End Patch',
        },
        tool_response: { success: true },
      },
    });
    expect(post.json().accepted).toBe(2);
    daemon.pipeline.flush();
    const events = await api.app.inject({ method: 'GET', url: '/v1/events', headers: auth() });
    expect(events.json().events.map((e: { type: string }) => e.type)).toEqual([
      'session.started',
      'tool.post',
      'file.changed',
    ]);
    const sessions = await api.app.inject({ method: 'GET', url: '/v1/sessions', headers: auth() });
    expect(sessions.json().sessions).toHaveLength(1);
    expect(sessions.json().sessions[0].provider_session_id).toBe('thr_codex');
    expect(sessions.json().sessions[0].provider_id).toBe('codex');
  });

  it('rejects malformed Codex hooks with 422', async () => {
    const res = await api.app.inject({
      method: 'POST',
      url: '/v1/hooks/codex',
      headers: auth(),
      payload: { hook_event_name: 'Stop' },
    });
    expect(res.statusCode).toBe(422);
  });

  it('ingests Codex legacy notify as a low-fidelity idle status on the mapped session', async () => {
    await api.app.inject({
      method: 'POST',
      url: '/v1/hooks/codex',
      headers: auth(),
      payload: { session_id: 'thr_n', cwd: '/repo', hook_event_name: 'SessionStart', source: 'startup' },
    });
    const notify = await api.app.inject({
      method: 'POST',
      url: '/v1/notify/codex',
      headers: auth(),
      payload: { type: 'agent-turn-complete', 'thread-id': 'thr_n', 'last-assistant-message': 'Done.' },
    });
    expect(notify.statusCode).toBe(202);
    expect(notify.json().accepted).toBe(1);
    daemon.pipeline.flush();
    const sessions = await api.app.inject({ method: 'GET', url: '/v1/sessions', headers: auth() });
    expect(sessions.json().sessions).toHaveLength(1);
    expect(sessions.json().sessions[0].status).toBe('idle');
    const events = await api.app.inject({ method: 'GET', url: '/v1/events', headers: auth() });
    const status = events.json().events.find((e: { type: string }) => e.type === 'session.status');
    expect(status.payload).toMatchObject({ status: 'idle', fidelity: 'low' });
  });

  it('rejects malformed Codex notify with 422', async () => {
    const res = await api.app.inject({
      method: 'POST',
      url: '/v1/notify/codex',
      headers: auth(),
      payload: { type: 'agent-turn-complete' },
    });
    expect(res.statusCode).toBe(422);
  });

  it('creates, reads, updates and transitions a task', async () => {
    const create = await api.app.inject({
      method: 'POST',
      url: '/v1/tasks',
      headers: auth(),
      payload: { title: 'API task' },
    });
    expect(create.statusCode).toBe(201);
    const task = create.json().task;
    expect(task.state).toBe('backlog');

    const stale = await api.app.inject({
      method: 'PATCH',
      url: `/v1/tasks/${task.task_id}`,
      headers: auth(),
      payload: { version: 99, fields: { title: 'x' } },
    });
    expect(stale.statusCode).toBe(409);

    const patch = await api.app.inject({
      method: 'PATCH',
      url: `/v1/tasks/${task.task_id}`,
      headers: auth(),
      payload: { version: 0, fields: { title: 'Renamed' } },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json().task.version).toBe(1);

    const badTransition = await api.app.inject({
      method: 'POST',
      url: `/v1/tasks/${task.task_id}/transition`,
      headers: auth(),
      payload: { version: 1, to: 'completed' },
    });
    expect(badTransition.statusCode).toBe(422);

    const transition = await api.app.inject({
      method: 'POST',
      url: `/v1/tasks/${task.task_id}/transition`,
      headers: auth(),
      payload: { version: 1, to: 'ready' },
    });
    expect(transition.statusCode).toBe(200);
    expect(transition.json().task.state).toBe('ready');

    const missing = await api.app.inject({
      method: 'GET',
      url: '/v1/tasks/task_doesnotexist',
      headers: auth(),
    });
    expect(missing.statusCode).toBe(404);
  });
});

describe('repo API', () => {
  it('registers, lists and reads a repository', async () => {
    const repoPath = makeGitRepo();
    const denied = await api.app.inject({
      method: 'POST',
      url: '/v1/repos',
      payload: { path: repoPath },
    });
    expect(denied.statusCode).toBe(401);

    const create = await api.app.inject({
      method: 'POST',
      url: '/v1/repos',
      headers: auth(),
      payload: { path: repoPath },
    });
    expect(create.statusCode).toBe(201);
    const repo = create.json().repo;
    expect(repo.repo_id).toMatch(/^repo_/);
    expect(repo.wip_ref).toContain('refs/wip/');

    const list = await api.app.inject({ method: 'GET', url: '/v1/repos', headers: auth() });
    expect(list.statusCode).toBe(200);
    expect(list.json().repos).toHaveLength(1);
    expect(['parcel', 'poll']).toContain(list.json().backend);

    const read = await api.app.inject({
      method: 'GET',
      url: `/v1/repos/${repo.repo_id}`,
      headers: auth(),
    });
    expect(read.statusCode).toBe(200);
    expect(read.json().repo.repo_id).toBe(repo.repo_id);
    expect(read.json().files).toEqual([]);
  });

  it('rejects a non-repository path with 422', async () => {
    const notRepo = mkdtempSync(join(tmpdir(), 'weft-api-notrepo-'));
    gitDirs.push(notRepo);
    const res = await api.app.inject({
      method: 'POST',
      url: '/v1/repos',
      headers: auth(),
      payload: { path: notRepo },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe('not_a_repo');
  });

  it('scans dirty work into file.changed events and snapshots auto-WIP', async () => {
    const repoPath = makeGitRepo();
    const create = await api.app.inject({
      method: 'POST',
      url: '/v1/repos',
      headers: auth(),
      payload: { path: repoPath },
    });
    const repo = create.json().repo;
    writeFileSync(join(repoPath, 'base.txt'), 'uncommitted edit\n');

    const scan = await api.app.inject({
      method: 'POST',
      url: `/v1/repos/${repo.repo_id}/scan`,
      headers: auth(),
    });
    expect(scan.statusCode).toBe(200);
    expect(scan.json().emitted).toBe(1);
    expect(scan.json().dirty).toBe(1);
    daemon.pipeline.flush();
    const events = await api.app.inject({ method: 'GET', url: '/v1/events', headers: auth() });
    const changed = events.json().events.find((e: { type: string }) => e.type === 'file.changed');
    expect(changed.payload).toMatchObject({ path: 'base.txt', source: 'watcher' });
    expect(changed.repo_id).toBe(repo.repo_id);

    const wip = await api.app.inject({
      method: 'POST',
      url: `/v1/repos/${repo.repo_id}/wip`,
      headers: auth(),
    });
    expect(wip.statusCode).toBe(200);
    expect(wip.json().wip.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(wip.json().wip.ref).toBe(repo.wip_ref);
    const shown = execFileSync('git', ['show', `${repo.wip_ref}:base.txt`], {
      cwd: repoPath,
      encoding: 'utf8',
      windowsHide: true,
    }).trim();
    expect(shown).toBe('uncommitted edit');
  });

  it('archives a repo and 404s unknown repos', async () => {
    const repoPath = makeGitRepo();
    const create = await api.app.inject({
      method: 'POST',
      url: '/v1/repos',
      headers: auth(),
      payload: { path: repoPath },
    });
    const repo = create.json().repo;
    const del = await api.app.inject({
      method: 'DELETE',
      url: `/v1/repos/${repo.repo_id}`,
      headers: auth(),
    });
    expect(del.statusCode).toBe(200);
    const list = await api.app.inject({ method: 'GET', url: '/v1/repos', headers: auth() });
    expect(list.json().repos).toHaveLength(0);

    for (const [method, url] of [
      ['GET', '/v1/repos/repo_missing'],
      ['POST', '/v1/repos/repo_missing/scan'],
      ['POST', '/v1/repos/repo_missing/wip'],
      ['DELETE', '/v1/repos/repo_missing'],
    ] as const) {
      const res = await api.app.inject({ method, url, headers: auth() });
      expect(res.statusCode).toBe(404);
    }
  });

  it('indexes symbols and keeps them fresh across scans', async () => {
    const repoPath = makeGitRepo();
    const g = (args: string[]) =>
      execFileSync('git', args, { cwd: repoPath, encoding: 'utf8', windowsHide: true });
    writeFileSync(join(repoPath, 'sym.ts'), 'export function hello(name: string): string { return name; }\n');
    g(['add', '-A']);
    g(['commit', '-qm', 'sym']);
    const create = await api.app.inject({
      method: 'POST',
      url: '/v1/repos',
      headers: auth(),
      payload: { path: repoPath },
    });
    const repo = create.json().repo;

    const idx = await api.app.inject({
      method: 'POST',
      url: `/v1/repos/${repo.repo_id}/index`,
      headers: auth(),
      payload: {},
    });
    expect(idx.statusCode).toBe(200);
    expect(idx.json()).toMatchObject({ branch: 'main', indexed: 1, source: 'worktree' });

    const sym = await api.app.inject({
      method: 'GET',
      url: `/v1/repos/${repo.repo_id}/symbols?edges=true`,
      headers: auth(),
    });
    expect(sym.statusCode).toBe(200);
    expect(sym.json().symbols.map((s: { name: string }) => s.name)).toEqual(['hello']);
    expect(sym.json().symbols[0].signature).toBe('hello(name: string): string');
    expect(Array.isArray(sym.json().edges)).toBe(true);

    // A dirty edit + scan must incrementally refresh the index via the watcher hook.
    writeFileSync(
      join(repoPath, 'sym.ts'),
      'export function hello(name: string): string { return name; }\nexport function bye(): void {}\n',
    );
    const scan = await api.app.inject({
      method: 'POST',
      url: `/v1/repos/${repo.repo_id}/scan`,
      headers: auth(),
    });
    expect(scan.statusCode).toBe(200);
    const sym2 = await api.app.inject({
      method: 'GET',
      url: `/v1/repos/${repo.repo_id}/symbols`,
      headers: auth(),
    });
    expect(sym2.json().symbols.map((s: { name: string }) => s.name)).toEqual(['hello', 'bye']);

    const missing = await api.app.inject({
      method: 'POST',
      url: '/v1/repos/repo_missing/index',
      headers: auth(),
      payload: {},
    });
    expect(missing.statusCode).toBe(404);
    const missingSym = await api.app.inject({
      method: 'GET',
      url: '/v1/repos/repo_missing/symbols',
      headers: auth(),
    });
    expect(missingSym.statusCode).toBe(404);
  });

  it('detects symbol overlaps across task branches', async () => {
    const repoPath = makeGitRepo();
    const g = (args: string[]) =>
      execFileSync('git', args, { cwd: repoPath, encoding: 'utf8', windowsHide: true });
    const lib = 'export function foo(): number {\n  const a = 1;\n  const b = 2;\n  return a + b;\n}\n';
    writeFileSync(join(repoPath, 'lib.ts'), lib);
    g(['add', '-A']);
    g(['commit', '-qm', 'lib']);
    g(['checkout', '-q', '-b', 'taskA']);
    writeFileSync(join(repoPath, 'lib.ts'), lib.replace('const a = 1;', 'const a = 10;'));
    g(['add', '-A']);
    g(['commit', '-qm', 'a']);
    g(['checkout', '-q', 'main']);
    g(['checkout', '-q', '-b', 'taskB']);
    writeFileSync(join(repoPath, 'lib.ts'), lib.replace('const b = 2;', 'const b = 20;'));
    g(['add', '-A']);
    g(['commit', '-qm', 'b']);
    g(['checkout', '-q', 'main']);

    const create = await api.app.inject({
      method: 'POST',
      url: '/v1/repos',
      headers: auth(),
      payload: { path: repoPath },
    });
    const repo = create.json().repo;
    const res = await api.app.inject({
      method: 'POST',
      url: `/v1/repos/${repo.repo_id}/overlaps`,
      headers: auth(),
      payload: { tasks: [{ task_id: 'tA', branch: 'taskA' }, { task_id: 'tB', branch: 'taskB' }] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().overlaps).toHaveLength(1);
    expect(res.json().overlaps[0].symbols[0].name).toBe('foo');
    expect(res.json().overlaps[0].severity).toBe('warning');

    const missing = await api.app.inject({
      method: 'POST',
      url: '/v1/repos/repo_missing/overlaps',
      headers: auth(),
      payload: { tasks: [{ task_id: 'tA', branch: 'taskA' }] },
    });
    expect(missing.statusCode).toBe(404);
  });
});

describe('worktree API', () => {
  async function registerRepo() {
    const repoPath = makeGitRepo();
    const create = await api.app.inject({
      method: 'POST',
      url: '/v1/repos',
      headers: auth(),
      payload: { path: repoPath },
    });
    return { repoPath, repo: create.json().repo };
  }

  it('provisions a confirmed worktree, assigns an agent, and snapshots WIP', async () => {
    const { repoPath, repo } = await registerRepo();
    const taskId = makeId('task');
    const provision = await api.app.inject({
      method: 'POST',
      url: `/v1/repos/${repo.repo_id}/worktrees`,
      headers: auth(),
      payload: { task_id: taskId, confirmed: true },
    });
    expect(provision.statusCode).toBe(201);
    const wt = provision.json().worktree;
    expect(wt.state).toBe('active');
    expect(wt.branch).toBe(`weft/task/${taskId}`);

    const assign = await api.app.inject({
      method: 'POST',
      url: `/v1/worktrees/${wt.worktree_id}/assign`,
      headers: auth(),
      payload: { pid: 4242 },
    });
    expect(assign.statusCode).toBe(200);
    expect(assign.json().worktree.owner_pid).toBe(4242);

    writeFileSync(join(wt.path, 'base.txt'), 'worktree edit\n');
    const wip = await api.app.inject({
      method: 'POST',
      url: `/v1/worktrees/${wt.worktree_id}/wip`,
      headers: auth(),
    });
    expect(wip.statusCode).toBe(200);
    expect(wip.json().wip.ref).toBe(`refs/wip/${taskId}/${repo.device_id}`);
    const shown = execFileSync('git', ['show', `${wip.json().wip.ref}:base.txt`], {
      cwd: repoPath,
      encoding: 'utf8',
      windowsHide: true,
    }).trim();
    expect(shown).toBe('worktree edit');

    const list = await api.app.inject({
      method: 'GET',
      url: `/v1/repos/${repo.repo_id}/worktrees`,
      headers: auth(),
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().worktrees).toHaveLength(1);
    const read = await api.app.inject({
      method: 'GET',
      url: `/v1/worktrees/${wt.worktree_id}`,
      headers: auth(),
    });
    expect(read.json().worktree.worktree_id).toBe(wt.worktree_id);
  });

  it('quarantines a provisional claim and refuses assignment with 409', async () => {
    const { repo } = await registerRepo();
    const provision = await api.app.inject({
      method: 'POST',
      url: `/v1/repos/${repo.repo_id}/worktrees`,
      headers: auth(),
      payload: { task_id: makeId('task'), provisional: true },
    });
    expect(provision.statusCode).toBe(201);
    const wt = provision.json().worktree;
    expect(wt.state).toBe('quarantined');
    const assign = await api.app.inject({
      method: 'POST',
      url: `/v1/worktrees/${wt.worktree_id}/assign`,
      headers: auth(),
      payload: { pid: 1 },
    });
    expect(assign.statusCode).toBe(409);
    expect(assign.json().error).toBe('quarantined');
  });

  it('rejects an unclaimed provision with 409 not_claimed', async () => {
    const { repo } = await registerRepo();
    const res = await api.app.inject({
      method: 'POST',
      url: `/v1/repos/${repo.repo_id}/worktrees`,
      headers: auth(),
      payload: { task_id: makeId('task') },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('not_claimed');
  });

  it('recovers stale worktrees and removes a worktree preserving its branch', async () => {
    const { repoPath, repo } = await registerRepo();
    const taskId = makeId('task');
    const provision = await api.app.inject({
      method: 'POST',
      url: `/v1/repos/${repo.repo_id}/worktrees`,
      headers: auth(),
      payload: { task_id: taskId, confirmed: true },
    });
    const wt = provision.json().worktree;
    writeFileSync(join(wt.path, 'base.txt'), 'preserve me\n');
    const del = await api.app.inject({
      method: 'DELETE',
      url: `/v1/worktrees/${wt.worktree_id}`,
      headers: auth(),
    });
    expect(del.statusCode).toBe(200);
    expect(del.json().removed).toBe(true);
    expect(del.json().wip.ref).toBe(`refs/wip/${taskId}/${repo.device_id}`);
    const shown = execFileSync('git', ['show', `${del.json().wip.ref}:base.txt`], {
      cwd: repoPath,
      encoding: 'utf8',
      windowsHide: true,
    }).trim();
    expect(shown).toBe('preserve me');

    // A second worktree whose directory vanishes is recovered via the repo route.
    const t2 = makeId('task');
    const p2 = await api.app.inject({
      method: 'POST',
      url: `/v1/repos/${repo.repo_id}/worktrees`,
      headers: auth(),
      payload: { task_id: t2, confirmed: true },
    });
    const wt2 = p2.json().worktree;
    rmSync(wt2.path, { recursive: true, force: true });
    const recover = await api.app.inject({
      method: 'POST',
      url: `/v1/repos/${repo.repo_id}/worktrees/recover`,
      headers: auth(),
    });
    expect(recover.statusCode).toBe(200);
    expect(recover.json().recovered).toContain(wt2.worktree_id);
  });

  it('404s unknown worktree and repo ids', async () => {
    for (const [method, url] of [
      ['GET', '/v1/worktrees/ws_missing'],
      ['POST', '/v1/worktrees/ws_missing/wip'],
      ['POST', '/v1/worktrees/ws_missing/assign'],
      ['DELETE', '/v1/worktrees/ws_missing'],
      ['GET', '/v1/repos/repo_missing/worktrees'],
      ['POST', '/v1/repos/repo_missing/worktrees/recover'],
    ] as const) {
      const res = await api.app.inject({
        method,
        url,
        headers: auth(),
        ...(method === 'POST' && url.endsWith('/assign') ? { payload: { pid: 1 } } : {}),
      });
      expect(res.statusCode).toBe(404);
    }
  });
});

describe('SSE stream', () => {
  it('delivers catch-up events and resumes from Last-Event-ID', async () => {
    const address = await api.app.listen({ host: '127.0.0.1', port: 0 });
    daemon.ingest(sampleEvent('session.started'));
    daemon.ingest(sampleEvent('tool.post'));
    daemon.pipeline.flush();
    const max = daemon.store.maxRowId();
    expect(max).toBe(2);

    const controller = new AbortController();
    const res = await fetch(`${address}/v1/stream?after=0`, {
      headers: auth(),
      signal: controller.signal,
    });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body?.getReader();
    if (!reader) throw new Error('no stream body');
    const decoder = new TextDecoder();
    let text = '';
    try {
      while (!text.includes(`id: ${max}`)) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value);
      }
    } finally {
      controller.abort();
    }
    expect(text).toContain('id: 1');
    expect(text).toContain(`id: ${max}`);
    expect(text).toContain('session.started');

    // Resume after rowid 1 → only the second event is replayed.
    const resumeController = new AbortController();
    const resumed = await fetch(`${address}/v1/stream`, {
      headers: { ...auth(), 'last-event-id': '1' },
      signal: resumeController.signal,
    });
    const resumeReader = resumed.body?.getReader();
    if (!resumeReader) throw new Error('no stream body');
    let resumeText = '';
    try {
      while (!resumeText.includes(`id: ${max}`)) {
        const { value, done } = await resumeReader.read();
        if (done) break;
        resumeText += decoder.decode(value);
      }
    } finally {
      resumeController.abort();
    }
    expect(resumeText).not.toContain('id: 1\n');
    expect(resumeText).toContain(`id: ${max}`);
  });
});
