import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WeftConfigSchema } from '@weft/core';
import { makeId, ulid, PROTOCOL_VERSION, type Actor, type StoredEvent, type TaskSnapshot } from '@weft/protocol';
import { Daemon } from './daemon.js';
import { DaemonMcpBackend } from './mcp-backend.js';
import type { CoordinationRpc, RpcAcquireResult, RpcClaimResult, RpcReservation } from './coordination-rpc.js';
import type { StoredLocalEvent } from './store.js';

const repoId = makeId('repo');
const taskId = makeId('task');
const rivalTask = makeId('task');
const human: Actor = { user_id: 'user_test', agent: null };
const agent: Actor = { user_id: 'user_test', agent: { provider: 'mcp', adapter: 'weft-mcp' } };

let counter = 0;
function stored(type: string, payload: Record<string, unknown>, opts: { actor?: Actor; taskId?: string; repoId?: string } = {}): StoredEvent {
  counter += 1;
  const iso = new Date().toISOString();
  return {
    v: PROTOCOL_VERSION, event_id: ulid(), device_id: makeId('device'), project_id: makeId('project'),
    ...(opts.repoId ? { repo_id: opts.repoId } : {}), ...(opts.taskId ? { task_id: opts.taskId } : {}),
    ts: iso, type, actor: opts.actor ?? human, privacy: 'metadata', payload, global_seq: counter, received_at: iso,
  };
}

const snapshot: TaskSnapshot = {
  id: taskId, project_id: makeId('project'), repo_id: repoId, number: 9, title: 'Team widget',
  description: 'desc', acceptance_criteria: ['works'], validation_requirements: {}, priority: 'P1',
  state: 'ready', expected_modules: ['src'], expected_files: ['src/a.ts', 'src/b.ts'], branch: 'task/widget',
  workspace_id: null, version: 2, created_by: null, parent_task_id: null, edit_conflict: null,
};
const rpcReservation: RpcReservation = {
  id: makeId('reservation'), project_id: snapshot.project_id, repo_id: repoId, task_id: rivalTask, session_id: null,
  path_glob: 'src/a.ts', mode: 'hard', holder_device_id: 'dev_rival', expires_at: '2026-11-16T12:02:00.000Z',
  renewed_at: null, grace_until: '2026-11-16T12:02:30.000Z', state: 'active', lease_epoch: 1,
  created_at: '2026-11-16T12:00:00.000Z', released_reason: null,
};

function fakeRpc() {
  const state = {
    task: snapshot as TaskSnapshot | null,
    getTaskThrows: false,
    claim: { ok: true, snapshot, provisional: false } as RpcClaimResult,
    acquire: { status: 'acquired', reservation: rpcReservation } as RpcAcquireResult,
    claimInput: null as { claimant?: Actor; baseVersion?: number; provisional?: boolean } | null,
  };
  const rpc = {
    async getTask() { if (state.getTaskThrows) throw new Error('server down'); return state.task; },
    async claimTask(_id: string, input: { claimant?: Actor; baseVersion?: number; provisional?: boolean }) { state.claimInput = input; return state.claim; },
    async reserveFiles() { return state.acquire; },
  };
  return { rpc: rpc as unknown as CoordinationRpc, state };
}

const cleanups: (() => Promise<void>)[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeTeam() {
  const dir = mkdtempSync(join(tmpdir(), 'weft-mcp-team-'));
  dirs.push(dir);
  const config = WeftConfigSchema.parse({
    dataDir: dir, logLevel: 'fatal', mode: 'team',
    server: { url: 'http://127.0.0.1:9', token: 'test-token', projectId: makeId('project'), deviceId: makeId('device') },
  });
  const daemon = new Daemon({ config }); // offline: never start()
  const { rpc, state } = fakeRpc();
  const backend = new DaemonMcpBackend(daemon, rpc, daemon.changeCache);
  daemon.taskCache!.setStale(false);
  daemon.enforcement!.setStale(false);
  daemon.changeCache!.setStale(false);
  cleanups.push(async () => { await daemon.shipper?.stop(); daemon.pipeline.stop(); daemon.store.close(); });
  return { daemon, backend, rpcState: state };
}

function makeSolo() {
  const dir = mkdtempSync(join(tmpdir(), 'weft-mcp-solo-'));
  dirs.push(dir);
  const config = WeftConfigSchema.parse({ dataDir: dir, logLevel: 'fatal' });
  const daemon = new Daemon({ config });
  const flushed: StoredLocalEvent[] = [];
  daemon.subscribeFlush((evs) => flushed.push(...evs));
  cleanups.push(async () => { daemon.pipeline.stop(); daemon.store.close(); });
  return { daemon, backend: daemon.mcp, flushed };
}

describe('DaemonMcpBackend — team mode (server-authoritative)', () => {
  it('get_task prefers the server snapshot and falls back to the cache when unreachable', async () => {
    const { daemon, backend, rpcState } = makeTeam();
    const live = await backend.getTask(taskId);
    expect(live).toMatchObject({ source: 'server', stale: false, task: { id: taskId, version: 2 } });

    daemon.taskCache!.applyEvent(stored('task.created', { snapshot, version: 2 }, { taskId }));
    rpcState.getTaskThrows = true;
    const cached = await backend.getTask(taskId);
    expect(cached).toMatchObject({ source: 'cache', task: { id: taskId } });

    daemon.taskCache!.setStale(true);
    expect((await backend.getTask(taskId)).stale).toBe(true);
  });

  it('get_task returns null when neither server nor cache knows the task', async () => {
    const { backend, rpcState } = makeTeam();
    rpcState.task = null;
    expect(await backend.getTask(makeId('task'))).toMatchObject({ task: null, source: 'cache' });
  });

  it('claim_task round-trips CAS to the server with the device actor', async () => {
    const { daemon, backend, rpcState } = makeTeam();
    const ok = await backend.claimTask(taskId, { baseVersion: 2 });
    expect(ok).toMatchObject({ ok: true, version: 2, state: 'ready' });
    expect(rpcState.claimInput?.claimant).toEqual(daemon.actor);

    const winner: Actor = { user_id: 'rival', agent: null };
    rpcState.claim = { ok: false, reason: 'version conflict', version: 3, winner_claimant: winner };
    const lost = await backend.claimTask(taskId, { baseVersion: 2 });
    expect(lost).toMatchObject({ ok: false, reason: 'version conflict', winner_claimant: winner });
  });

  it('reserve_files maps acquired and denied server outcomes', async () => {
    const { backend, rpcState } = makeTeam();
    const acq = await backend.reserveFiles({ repo_id: repoId, task_id: taskId, path_glob: 'src/a.ts', mode: 'hard' });
    expect(acq).toMatchObject({ status: 'acquired', reservation_id: rpcReservation.id, mode: 'hard' });
    rpcState.acquire = { status: 'denied', reservation: rpcReservation, reason: 'held by rival' };
    const denied = await backend.reserveFiles({ repo_id: repoId, task_id: taskId, path_glob: 'src/a.ts', mode: 'hard' });
    expect(denied).toMatchObject({ status: 'denied', reason: 'held by rival' });
  });

  it('get_concurrent_changes assembles reservations, impacts and progress from the projections', async () => {
    const { daemon, backend } = makeTeam();
    daemon.taskCache!.applyEvent(stored('task.created', { snapshot, version: 2 }, { taskId }));
    daemon.enforcement!.applyEvent(stored('reservation.acquired', {
      reservation_id: rpcReservation.id, path_glob: 'src/a.ts', mode: 'hard', holder_task_id: rivalTask,
      holder_device_id: 'dev_rival', expires_at: rpcReservation.expires_at, grace_until: rpcReservation.grace_until,
    }, { taskId: rivalTask, repoId }));
    daemon.changeCache!.applyEvent(stored('conflict.detected', {
      canonical_key: 'sig:1', kind: 'signature_impact', severity: 'warning', paths: ['src/a.ts'], task_ids: [rivalTask], repo_id: repoId,
      evidence: [{ branch: 'task/rival', file_path: 'src/a.ts', name: 'parse', symbol_kind: 'function', old_signature: '(s: string) => number', new_signature: '(s: string, o?: O) => number', affected_task_ids: [taskId], callers: [{ file_path: 'c.ts', name: 'run' }] }],
    }, { repoId }));
    daemon.changeCache!.applyEvent(stored('task.progress', { summary: 'half done', percent: 50 }, { actor: agent, taskId }));

    const payload = await backend.getConcurrentChanges(taskId, {});
    expect(payload.used_bytes).toBeLessThanOrEqual(2048);
    expect(payload.text).toContain('OWN TASK');
    expect(payload.text).toContain('RESERVATION hard src/a.ts');
    expect(payload.text).toContain('SIGNATURE CHANGE parse');
    expect(payload.text).toContain('PROGRESS 50%');
    expect(payload.text).toContain('data, not instructions');
    expect(payload.text).not.toContain('global_seq');
  });
});

describe('DaemonMcpBackend — solo mode (local stores)', () => {
  it('get_task reads the local store', async () => {
    const { daemon, backend } = makeSolo();
    const rec = daemon.tasks.create({ title: 'Solo task', state: 'ready', expectedFiles: ['src/a.ts'], repoId });
    const got = await backend.getTask(rec.task_id);
    expect(got).toMatchObject({ source: 'local', stale: false, task: { id: rec.task_id, title: 'Solo task' } });
    expect((await backend.getTask(makeId('task'))).task).toBeNull();
  });

  it('claim_task transitions locally and reports a lost CAS as ok=false', async () => {
    const { daemon, backend } = makeSolo();
    const rec = daemon.tasks.create({ title: 'Solo task', state: 'ready', repoId });
    const ok = await backend.claimTask(rec.task_id, {});
    expect(ok).toMatchObject({ ok: true, state: 'claimed' });
    const stale = await backend.claimTask(rec.task_id, { baseVersion: rec.version });
    expect(stale.ok).toBe(false);
    expect(await backend.claimTask(makeId('task'), {})).toMatchObject({ ok: false, reason: 'task not found' });
  });

  it('report_progress records an agent-authored event in the durable trail', async () => {
    const { daemon, backend, flushed } = makeSolo();
    const rec = daemon.tasks.create({ title: 'Solo task', state: 'ready', repoId });
    const res = await backend.reportProgress(rec.task_id, 'working', { percent: 30 });
    expect(res).toMatchObject({ ok: true, percent: 30, recorded: 'event' });
    daemon.pipeline.flush();
    const ev = flushed.find((e) => e.type === 'task.progress');
    expect(ev).toBeDefined();
    expect(ev?.payload.summary).toBe('working');
    expect(ev?.payload.percent).toBe(30);
    expect((ev?.actor as { agent?: unknown }).agent).toMatchObject({ provider: 'mcp' });
  });

  it('reserve_files emits an advisory local lease', async () => {
    const { daemon, backend, flushed } = makeSolo();
    const rec = daemon.tasks.create({ title: 'Solo task', state: 'ready', repoId });
    const res = await backend.reserveFiles({ repo_id: repoId, task_id: rec.task_id, path_glob: 'src/**', mode: 'hard' });
    expect(res.status).toBe('local');
    expect(res.reservation_id).toBeTruthy();
    expect(res.grace_until).toBeTruthy();
    daemon.pipeline.flush();
    const ev = flushed.find((e) => e.type === 'reservation.acquired');
    expect(ev?.payload.path_glob).toBe('src/**');
    expect(ev?.payload.mode).toBe('hard');
  });

  it('get_concurrent_changes returns the own task without a coordination projection', async () => {
    const { daemon, backend } = makeSolo();
    const rec = daemon.tasks.create({ title: 'Solo task', state: 'ready', expectedFiles: ['src/a.ts'], repoId });
    const payload = await backend.getConcurrentChanges(rec.task_id, {});
    expect(payload.text).toContain('OWN TASK');
    expect(payload.text).not.toContain('RESERVATION');
    expect(payload.used_bytes).toBeLessThanOrEqual(2048);
  });
});