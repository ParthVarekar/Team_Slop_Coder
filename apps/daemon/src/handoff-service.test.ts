import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WeftConfigSchema } from '@weft/core';
import {
  makeId,
  ulid,
  PROTOCOL_VERSION,
  type StoredEvent,
  type TaskSnapshot,
} from '@weft/protocol';
import { Daemon } from './daemon.js';
import { createApiServer } from './api.js';
import { draftEvent } from './events.js';
import { HandoffService } from './handoff-service.js';
import type { CoordinationRpc } from './coordination-rpc.js';

const NOW = Date.parse('2026-11-25T12:00:00.000Z');
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function solo() {
  const dir = mkdtempSync(join(tmpdir(), 'weft-handoff-'));
  dirs.push(dir);
  const daemon = new Daemon({
    config: WeftConfigSchema.parse({ dataDir: dir, logLevel: 'fatal' }),
  });
  return daemon;
}

function event(
  taskId: string,
  repoId: string,
  type: string,
  payload: Record<string, unknown>,
  ts = new Date(NOW - 1000).toISOString(),
): StoredEvent {
  return {
    v: PROTOCOL_VERSION,
    event_id: ulid(),
    device_id: makeId('device'),
    project_id: makeId('project'),
    repo_id: repoId,
    task_id: taskId,
    ts,
    type,
    actor: { user_id: 'user', agent: null },
    privacy: 'metadata',
    payload,
    global_seq: 1,
    received_at: ts,
  };
}

describe('handoff daemon API', () => {
  it('keeps recap disabled by default', () => {
    expect(WeftConfigSchema.parse({}).recap.enabled).toBe(false);
  });

  it('requires authentication', async () => {
    const daemon = solo();
    const api = createApiServer(daemon);
    try {
      const res = await api.app.inject({
        method: 'GET',
        url: `/v1/tasks/${makeId('task')}/handoff`,
      });
      expect(res.statusCode).toBe(401);
    } finally {
      await api.close();
      daemon.pipeline.stop();
      daemon.store.close();
    }
  });

  it('returns the same digest and text for the same durable inputs and cutoff', async () => {
    const daemon = solo();
    const api = createApiServer(daemon);
    const secret = daemon.identity.hook_secret;
    try {
      const task = daemon.tasks.create({
        title: 'Deterministic handoff',
        state: 'in_progress',
        repoId: makeId('repo'),
      });
      daemon.tasks.claimCompletion(task.task_id, 'Implementation is believed complete');
      daemon.pipeline.enqueue(
        draftEvent(daemon.source, {
          type: 'file.changed',
          actor: daemon.actor,
          taskId: task.task_id,
          ts: new Date(NOW - 1000).toISOString(),
          ...(task.repo_id ? { repoId: task.repo_id } : {}),
          payload: { path: 'src/a.ts', change_kind: 'modify', source: 'agent_tool' },
        }),
      );
      daemon.pipeline.flush();
      const url = `/v1/tasks/${task.task_id}/handoff?as_of=${NOW}&recent_since=${NOW - 60_000}`;
      const headers = { authorization: `Bearer ${secret}` };
      const a = await api.app.inject({ method: 'GET', url, headers });
      const b = await api.app.inject({ method: 'GET', url, headers });
      expect(a.statusCode).toBe(200);
      expect(a.json().bundle.digest).toBe(b.json().bundle.digest);
      expect(a.json().text).toBe(b.json().text);
      expect(a.json().bundle.completion_claims[0].evidence_state).toBe('unverified');
      expect(a.json().bundle.recent_changes).toHaveLength(1);
      expect(a.json().recap).toBeNull();
      expect(a.json().bundle.coverage.changes).toBe('local_events');
    } finally {
      await api.close();
      daemon.pipeline.stop();
      daemon.store.close();
    }
  });

  it('applies the change-type filter before the combined task/repo limit', () => {
    const daemon = solo();
    try {
      const task = daemon.tasks.create({ title: 'Bounded changes', repoId: makeId('repo') });
      const enqueue = (type: string, ts: number | string, payload: Record<string, unknown>) =>
        daemon.pipeline.enqueue(
          draftEvent(daemon.source, {
            type,
            actor: daemon.actor,
            taskId: task.task_id,
            ...(task.repo_id ? { repoId: task.repo_id } : {}),
            ts: typeof ts === 'number' ? new Date(ts).toISOString() : ts,
            payload,
          }),
        );
      enqueue('file.changed', '2026-11-25T13:59:00.000+02:00', {
        path: 'src/a.ts',
        change_kind: 'modify',
        source: 'watcher',
      });
      enqueue('task.updated', NOW - 10, { fields: { title: 'Newer noise' } });
      enqueue('tool.post', NOW - 20, { tool_name: 'Bash', success: true });
      daemon.pipeline.flush();
      const changes = daemon.store.getEvents({
        projectId: daemon.identity.project_id,
        taskId: task.task_id,
        ...(task.repo_id ? { repoId: task.repo_id } : {}),
        types: ['file.changed', 'symbols.changed', 'commit.created'],
        since: new Date(NOW - 60_000).toISOString(),
        until: new Date(NOW).toISOString(),
        deterministicRecent: true,
        limit: 1,
      });
      expect(changes).toHaveLength(1);
      expect(changes[0]?.type).toBe('file.changed');
    } finally {
      daemon.pipeline.stop();
      daemon.store.close();
    }
  });

  it('includes active peer leases in the same repo and omits released leases', async () => {
    const daemon = solo();
    try {
      const task = daemon.tasks.create({ title: 'Peer leases', repoId: makeId('repo') });
      const repoId = task.repo_id;
      if (!repoId) throw new Error('expected repo');
      const peer = makeId('task');
      const releasedPeer = makeId('task');
      const enqueue = (
        reservationId: string,
        holderTaskId: string,
        type: 'reservation.acquired' | 'reservation.released',
        ts: number,
      ) =>
        daemon.pipeline.enqueue(
          draftEvent(daemon.source, {
            type,
            actor: daemon.actor,
            taskId: holderTaskId,
            repoId,
            ts: new Date(ts).toISOString(),
            payload: {
              reservation_id: reservationId,
              holder_task_id: holderTaskId,
              holder_device_id: makeId('device'),
              path_glob: `src/${reservationId}/**`,
              mode: 'hard',
              expires_at: new Date(NOW + 60_000).toISOString(),
              grace_until: new Date(NOW + 90_000).toISOString(),
            },
          }),
        );
      enqueue('active', peer, 'reservation.acquired', NOW - 2000);
      enqueue('released', releasedPeer, 'reservation.acquired', NOW - 3000);
      enqueue('released', releasedPeer, 'reservation.released', NOW - 1000);
      daemon.pipeline.flush();

      const result = await daemon.handoff.get(task.task_id, { now: NOW });
      expect(result.bundle.reservations).toHaveLength(1);
      expect(result.bundle.reservations[0]).toMatchObject({
        key: 'active',
        holder_task_id: peer,
        path_glob: 'src/active/**',
        state: 'active',
      });
    } finally {
      daemon.pipeline.stop();
      daemon.store.close();
    }
  });

  it('rejects invalid cutoff ordering and missing tasks', async () => {
    const daemon = solo();
    const api = createApiServer(daemon);
    const headers = { authorization: `Bearer ${daemon.identity.hook_secret}` };
    try {
      const bad = await api.app.inject({
        method: 'GET',
        url: `/v1/tasks/x/handoff?as_of=100&recent_since=200`,
        headers,
      });
      expect(bad.statusCode).toBe(400);
      const missing = await api.app.inject({ method: 'GET', url: '/v1/tasks/x/handoff', headers });
      expect(missing.statusCode).toBe(404);
    } finally {
      await api.close();
      daemon.pipeline.stop();
      daemon.store.close();
    }
  });

  it('includes bounded handoff metadata in MCP context without invoking a recap', async () => {
    const daemon = solo();
    try {
      const task = daemon.tasks.create({ title: 'Context handoff', state: 'ready' });
      const context = await daemon.mcp.getConcurrentChanges(task.task_id, {});
      expect(context.text).toContain('HANDOFF as_of=');
      expect(context.text).toContain('digest=');
      expect(context.used_bytes).toBeLessThanOrEqual(2048);
    } finally {
      daemon.pipeline.stop();
      daemon.store.close();
    }
  });
  it('requires per-request opt-in even when a recap provider is configured', async () => {
    const daemon = solo();
    const fetchImpl = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ output_text: 'Generated recap' }), { status: 200 }),
    );
    daemon.config.recap = {
      enabled: true,
      endpoint: 'https://recap.example/v1/responses',
      token: null,
      model: 'small',
      maxChars: 400,
      timeoutMs: 3000,
    };
    try {
      const task = daemon.tasks.create({ title: 'Recap opt-in' });
      const service = new HandoffService(daemon, fetchImpl);
      const normal = await service.get(task.task_id, { asOf: NOW, now: NOW });
      expect(normal.recap).toBeNull();
      expect(fetchImpl).not.toHaveBeenCalled();
      const optedIn = await service.get(task.task_id, { asOf: NOW, now: NOW, recap: true });
      expect(optedIn.recap).toMatchObject({
        status: 'generated',
        authoritative: false,
        generated_by: 'external_provider',
      });
      expect(fetchImpl).toHaveBeenCalledOnce();
      expect(optedIn.bundle.digest).toBe(normal.bundle.digest);
    } finally {
      daemon.pipeline.stop();
      daemon.store.close();
    }
  });
});

describe('team handoff collection', () => {
  it('uses server-authoritative sources and discloses server event coverage', async () => {
    const repoId = makeId('repo');
    const taskId = makeId('task');
    const snapshot: TaskSnapshot = {
      id: taskId,
      project_id: makeId('project'),
      repo_id: repoId,
      number: 1,
      title: 'Team task',
      description: null,
      acceptance_criteria: ['done'],
      validation_requirements: {},
      priority: 'P1',
      state: 'in_progress',
      expected_modules: [],
      expected_files: ['src/a.ts'],
      branch: 'task/a',
      workspace_id: null,
      version: 2,
      created_by: null,
      parent_task_id: null,
      edit_conflict: null,
    };
    const rpc = {
      getTask: vi.fn(async () => snapshot),
      listCompletionClaims: vi.fn(async () => [
        {
          id: 'claim',
          task_id: taskId,
          session_id: null,
          claimed_at: new Date(NOW - 2000).toISOString(),
          claim_text: 'claimed',
          evidence_state: 'unverified',
        },
      ]),
      listReservations: vi.fn(async () => []),
      listValidationRuns: vi.fn(async () => []),
      getHandoffChanges: vi.fn(async () => ({
        events: [
          event(taskId, repoId, 'file.changed', { path: 'src/a.ts', change_kind: 'modify' }),
        ],
        history_complete: false,
      })),
    };
    const daemon = {
      config: { mode: 'team', recap: { enabled: false } },
      rpc: rpc as unknown as CoordinationRpc,
      taskCache: { getTask: () => undefined },
      identity: { project_id: snapshot.project_id },
      store: { getEvents: () => [] },
    } as unknown as Daemon;
    const result = await new HandoffService(daemon).get(taskId, { asOf: NOW, now: NOW });
    expect(result.bundle.coverage).toMatchObject({
      task: 'authoritative',
      claims: 'authoritative',
      reservations: 'server',
      validation: 'server',
      changes: 'server_events',
    });
    expect(rpc.listValidationRuns).toHaveBeenCalledWith(taskId, 6, new Date(NOW).toISOString());
    expect(result.bundle.recent_changes).toHaveLength(1);
    expect(result.recap).toBeNull();
  });

  it('falls back to the task cache and labels unavailable authoritative sources', async () => {
    const repoId = makeId('repo');
    const taskId = makeId('task');
    const snapshot: TaskSnapshot = {
      id: taskId,
      project_id: makeId('project'),
      repo_id: repoId,
      number: 1,
      title: 'Cached task',
      description: null,
      acceptance_criteria: [],
      validation_requirements: {},
      priority: 'P2',
      state: 'ready',
      expected_modules: [],
      expected_files: [],
      branch: null,
      workspace_id: null,
      version: 1,
      created_by: null,
      parent_task_id: null,
      edit_conflict: null,
    };
    const rpc = {
      getTask: vi.fn(async () => {
        throw new Error('offline');
      }),
      listCompletionClaims: vi.fn(async () => {
        throw new Error('offline');
      }),
      listReservations: vi.fn(async () => {
        throw new Error('offline');
      }),
      listValidationRuns: vi.fn(async () => {
        throw new Error('offline');
      }),
      getHandoffChanges: vi.fn(async () => {
        throw new Error('offline');
      }),
    };
    const daemon = {
      config: { mode: 'team', recap: { enabled: false } },
      rpc: rpc as unknown as CoordinationRpc,
      taskCache: { getTask: () => snapshot },
      identity: { project_id: snapshot.project_id },
      store: { getEvents: () => [] },
    } as unknown as Daemon;
    const result = await new HandoffService(daemon).get(taskId, { asOf: NOW, now: NOW });
    expect(result.bundle.coverage.task).toBe('cache');
    expect(result.bundle.coverage.claims).toBe('unavailable');
    expect(result.bundle.coverage.reservations).toBe('unavailable');
    expect(result.bundle.coverage.validation).toBe('unavailable');
    expect(result.bundle.coverage.changes).toBe('local_events');
    expect(result.bundle.coverage.reasons.join(' ')).toContain('cache may be stale');
  });
});
