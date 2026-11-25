import { describe, expect, it } from 'vitest';
import type { Actor, TaskSnapshot } from '@weft/protocol';
import { CoordinationRpc, CoordinationRpcError } from './coordination-rpc.js';

const claimant: Actor = { user_id: 'user_test', agent: null };

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
}

function harness(handler: (call: Call) => { status: number; body: unknown }) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const call: Call = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers,
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null,
    };
    calls.push(call);
    const { status, body } = handler(call);
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  const rpc = new CoordinationRpc({
    baseUrl: 'http://team.test/',
    token: 'tok',
    projectId: 'proj_1',
    fetchImpl,
  });
  return { rpc, calls };
}

const snapshot = { id: 'task_1', version: 4, state: 'claimed' } as unknown as TaskSnapshot;
const reservation = {
  id: 'resv_1',
  project_id: 'proj_1',
  repo_id: 'repo_1',
  task_id: 'task_1',
  session_id: null,
  path_glob: 'src/**',
  mode: 'hard',
  holder_device_id: 'dev_1',
  expires_at: '2026-11-16T12:02:00.000Z',
  renewed_at: null,
  grace_until: '2026-11-16T12:02:30.000Z',
  state: 'active',
  lease_epoch: 1,
  created_at: '2026-11-16T12:00:00.000Z',
  released_reason: null,
};

describe('CoordinationRpc — request shaping', () => {
  it('stamps Bearer auth, projectId query and body, and strips the trailing base slash', async () => {
    const { rpc, calls } = harness(() => ({ status: 200, body: { task: snapshot } }));
    await rpc.getTask('task_1');
    const call = calls[0]!;
    expect(call.url).toBe('http://team.test/v1/tasks/task_1?projectId=proj_1');
    expect(call.headers.authorization).toBe('Bearer tok');
    expect(call.headers['content-type']).toBeUndefined(); // GET has no body
    expect(call.method).toBe('GET');
  });

  it('encodes task ids and sends claim CAS fields with a JSON content-type', async () => {
    const { rpc, calls } = harness(() => ({
      status: 200,
      body: { ok: true, snapshot, provisional: false },
    }));
    const result = await rpc.claimTask('task/odd id', {
      baseVersion: 4,
      claimant,
      provisional: true,
    });
    expect(result).toMatchObject({ ok: true, provisional: false });
    const call = calls[0]!;
    expect(call.url).toContain('/v1/tasks/task%2Fodd%20id/claim');
    expect(call.headers['content-type']).toBe('application/json');
    expect(call.body).toMatchObject({
      projectId: 'proj_1',
      baseVersion: 4,
      claimant,
      provisional: true,
    });
  });
});

describe('CoordinationRpc — task reads & claims', () => {
  it('returns null on 404 instead of throwing', async () => {
    const { rpc } = harness(() => ({ status: 404, body: { error: 'not_found' } }));
    expect(await rpc.getTask('missing')).toBeNull();
  });

  it('surfaces a lost claim with the winner and version', async () => {
    const winner: Actor = { user_id: 'rival', agent: null };
    const { rpc } = harness(() => ({
      status: 200,
      body: { ok: false, reason: 'version conflict', version: 5, winner_claimant: winner },
    }));
    const result = await rpc.claimTask('task_1', { baseVersion: 4, claimant });
    expect(result).toEqual({
      ok: false,
      reason: 'version conflict',
      version: 5,
      winner_claimant: winner,
    });
  });

  it('releases a task and returns the new snapshot', async () => {
    const { rpc, calls } = harness(() => ({
      status: 200,
      body: { task: { ...snapshot, state: 'ready' } },
    }));
    const next = await rpc.releaseTask('task_1', 4);
    expect(next.state).toBe('ready');
    expect(calls[0]?.body).toMatchObject({ baseVersion: 4, projectId: 'proj_1' });
  });
});

describe('CoordinationRpc — reservations', () => {
  it('acquires a hard lease (201) and maps the reservation', async () => {
    const { rpc, calls } = harness(() => ({
      status: 201,
      body: { status: 'acquired', reservation },
    }));
    const result = await rpc.reserveFiles({
      repo_id: 'repo_1',
      task_id: 'task_1',
      path_glob: 'src/**',
      mode: 'hard',
      ttl_ms: 60_000,
    });
    expect(result.status).toBe('acquired');
    expect(result.reservation.id).toBe('resv_1');
    expect(calls[0]?.body).toMatchObject({
      repo_id: 'repo_1',
      task_id: 'task_1',
      path_glob: 'src/**',
      mode: 'hard',
      ttl_ms: 60_000,
    });
  });

  it('treats 409 as a normal denied outcome, not an error', async () => {
    const { rpc } = harness(() => ({
      status: 409,
      body: { status: 'denied', reservation, reason: 'held by rival' },
    }));
    const result = await rpc.reserveFiles({
      repo_id: 'repo_1',
      task_id: 'task_1',
      path_glob: 'src/**',
      mode: 'hard',
    });
    expect(result).toMatchObject({ status: 'denied', reason: 'held by rival' });
  });

  it('defaults mode to soft and omits absent optional fields', async () => {
    const { rpc, calls } = harness(() => ({
      status: 200,
      body: { status: 'acquired', reservation: { ...reservation, mode: 'soft' } },
    }));
    await rpc.reserveFiles({ repo_id: 'repo_1', task_id: 'task_1', path_glob: 'docs/**' });
    expect(calls[0]?.body).toMatchObject({ mode: 'soft' });
    expect(calls[0]?.body).not.toHaveProperty('ttl_ms');
    expect(calls[0]?.body).not.toHaveProperty('session_id');
  });

  it('renews and releases leases', async () => {
    const { rpc, calls } = harness(() => ({ status: 200, body: { reservation } }));
    expect((await rpc.renewReservation('resv_1', 'task_1', 90_000)).id).toBe('resv_1');
    expect(calls[0]?.url).toContain('/v1/reservations/resv_1/renew');
    expect(calls[0]?.body).toMatchObject({ task_id: 'task_1', ttl_ms: 90_000 });
    await rpc.releaseReservation('resv_1', 'task_1', 'done');
    expect(calls[1]?.url).toContain('/v1/reservations/resv_1/release');
    expect(calls[1]?.body).toMatchObject({ task_id: 'task_1', reason: 'done' });
  });

  it('lists reservations with repo/task/state filters', async () => {
    const { rpc, calls } = harness(() => ({ status: 200, body: { reservations: [reservation] } }));
    const list = await rpc.listReservations({
      repoId: 'repo_1',
      taskId: 'task_1',
      state: 'active',
    });
    expect(list).toHaveLength(1);
    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get('repoId')).toBe('repo_1');
    expect(url.searchParams.get('taskId')).toBe('task_1');
    expect(url.searchParams.get('state')).toBe('active');
  });
});

describe('CoordinationRpc — error mapping', () => {
  it('throws CoordinationRpcError with status/code/message on a disallowed status', async () => {
    const { rpc } = harness(() => ({
      status: 403,
      body: { error: 'forbidden', message: 'role lacks claim' },
    }));
    await expect(rpc.claimTask('task_1', { claimant })).rejects.toMatchObject({
      name: 'CoordinationRpcError',
      status: 403,
      code: 'forbidden',
      message: 'role lacks claim',
    });
  });

  it('falls back to a generic code/message when the error body is empty', async () => {
    const { rpc } = harness(() => ({ status: 500, body: {} }));
    const err = await rpc.getTask('task_1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CoordinationRpcError);
    expect((err as CoordinationRpcError).status).toBe(500);
    expect((err as CoordinationRpcError).code).toBe('rpc_error');
  });
});
