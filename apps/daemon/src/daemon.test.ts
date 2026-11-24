import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { redactor } from '@weft/core';
import { makeId, type Actor, type EventEnvelope } from '@weft/protocol';
import { LocalStore, type StoredLocalEvent } from './store.js';
import { EventPipeline } from './pipeline.js';
import { LocalTaskStore, TaskError, canTransition } from './tasks.js';
import { loadOrCreateIdentity } from './identity.js';
import { draftEvent, type EventSource } from './events.js';

let dir: string;
const stores: LocalStore[] = [];
function openStore(): LocalStore {
  const store = LocalStore.open(dir);
  stores.push(store);
  return store;
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'weft-daemon-'));
});
afterEach(() => {
  for (const store of stores) {
    try {
      store.close();
    } catch {
      /* already closed */
    }
  }
  stores.length = 0;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows may briefly lock WAL files; best-effort cleanup */
  }
});

function source(): EventSource {
  return { deviceId: makeId('device'), projectId: makeId('project') };
}
const actor: Actor = { user_id: makeId('user'), agent: null };

function event(
  src: EventSource,
  type: string,
  payload: Record<string, unknown>,
  extra: Partial<EventEnvelope> = {},
): StoredLocalEvent {
  return {
    ...draftEvent(src, { type, actor, payload }),
    received_at: new Date().toISOString(),
    ...extra,
  };
}

describe('LocalStore', () => {
  it('persists batches and reads them back with a rowid cursor', () => {
    const store = openStore();
    const src = source();
    const batch = [
      event(src, 'session.started', { cwd: '/repo', fidelity: 'high' }),
      event(src, 'tool.post', { tool_name: 'Read', success: true }),
    ];
    store.insertEvents(batch, false);
    expect(store.countEvents()).toBe(2);
    const all = store.getEvents();
    expect(all).toHaveLength(2);
    expect(all[0]?.rowid).toBe(1);
    const after = store.getEvents({ afterRowId: 1 });
    expect(after).toHaveLength(1);
    expect(after[0]?.type).toBe('tool.post');
    expect(store.maxRowId()).toBe(2);
    store.close();
  });

  it('mirrors durable coordination events but only fills outbox in team mode', () => {
    const store = openStore();
    const src = source();
    store.insertEvents(
      [
        event(src, 'task.created', { version: 0 }),
        event(src, 'tool.post', { tool_name: 'Read', success: true }),
      ],
      false,
    );
    const coord = store.db.prepare('SELECT COUNT(*) AS c FROM coordination_events').get() as {
      c: number;
    };
    const outboxSolo = store.db.prepare('SELECT COUNT(*) AS c FROM outbox').get() as { c: number };
    expect(coord.c).toBe(1);
    expect(outboxSolo.c).toBe(0);
    store.insertEvents([event(src, 'task.updated', { version: 1 })], true);
    const outboxTeam = store.db.prepare('SELECT COUNT(*) AS c FROM outbox').get() as { c: number };
    expect(outboxTeam.c).toBe(1);
    store.close();
  });

  it('is idempotent on duplicate event_id', () => {
    const store = openStore();
    const src = source();
    const e = event(src, 'tool.post', { tool_name: 'Read', success: true });
    store.insertEvents([e], false);
    store.insertEvents([e], false);
    expect(store.countEvents()).toBe(1);
    store.close();
  });

  it('survives reopen (durability)', () => {
    const src = source();
    const store = openStore();
    store.insertEvents([event(src, 'session.started', { cwd: '/repo', fidelity: 'high' })], false);
    store.close();
    const reopened = openStore();
    expect(reopened.countEvents()).toBe(1);
    reopened.close();
  });
});

describe('EventPipeline', () => {
  it('accepts valid events, rejects malformed ones, and flushes durably', () => {
    const store = openStore();
    const pipeline = new EventPipeline(store, { batchSize: 100, flushIntervalMs: 1000 });
    const src = source();
    expect(
      pipeline.enqueue(event(src, 'tool.post', { tool_name: 'Read', success: true })).accepted,
    ).toBe(true);
    expect(pipeline.enqueue({ not: 'an event' }).accepted).toBe(false);
    expect(pipeline.pending).toBe(1);
    pipeline.flush();
    expect(store.countEvents()).toBe(1);
    expect(pipeline.pending).toBe(0);
    pipeline.stop();
    store.close();
  });

  it('redacts secrets in free-text payload fields but preserves structure', () => {
    const store = openStore();
    const pipeline = new EventPipeline(store, { redactor, flushIntervalMs: 1000 });
    const src = source();
    const secret = 'sk-ant-api03-' + 'A'.repeat(40);
    pipeline.enqueue(
      event(src, 'tool.post', {
        tool_name: 'Bash',
        success: true,
        output_excerpt: `key=${secret}`,
        output_digest: 'abc123',
      }),
    );
    pipeline.flush();
    const stored = store.getEvents()[0];
    const payload = stored?.payload as Record<string, unknown>;
    expect(String(payload.output_excerpt)).not.toContain(secret);
    expect(String(payload.output_excerpt)).toContain('[REDACTED');
    expect(payload.output_digest).toBe('abc123');
    pipeline.stop();
    store.close();
  });

  it('auto-flushes when the batch size is reached', () => {
    const store = openStore();
    const pipeline = new EventPipeline(store, { batchSize: 3, flushIntervalMs: 1000 });
    const src = source();
    for (let i = 0; i < 3; i++)
      pipeline.enqueue(event(src, 'tool.post', { tool_name: 'Read', success: true }));
    expect(store.countEvents()).toBe(3);
    expect(pipeline.pending).toBe(0);
    pipeline.stop();
    store.close();
  });

  it('flushes pending events on stop (no loss on shutdown)', () => {
    const store = openStore();
    const pipeline = new EventPipeline(store, { batchSize: 100, flushIntervalMs: 60_000 });
    const src = source();
    pipeline.enqueue(event(src, 'tool.post', { tool_name: 'Read', success: true }));
    expect(store.countEvents()).toBe(0);
    pipeline.stop();
    expect(store.countEvents()).toBe(1);
    expect(
      pipeline.enqueue(event(src, 'tool.post', { tool_name: 'Read', success: true })).accepted,
    ).toBe(false);
    store.close();
  });

  it('projects session lifecycle into agent_sessions', () => {
    const store = openStore();
    const pipeline = new EventPipeline(store, { flushIntervalMs: 1000 });
    const src = source();
    const sessionId = makeId('session');
    pipeline.enqueue(
      event(
        src,
        'session.started',
        { cwd: '/repo', fidelity: 'high', model: 'claude' },
        { session_id: sessionId, provider_session_id: 'prov-1' },
      ),
    );
    pipeline.flush();
    expect(store.getSession(sessionId)?.status).toBe('running');
    pipeline.enqueue(
      event(src, 'session.ended', { reason: 'completed' }, { session_id: sessionId }),
    );
    pipeline.flush();
    const ended = store.getSession(sessionId);
    expect(ended?.status).toBe('completed');
    expect(ended?.ended_at).not.toBeNull();
    pipeline.stop();
    store.close();
  });

  it('notifies onFlush after durable write', () => {
    const store = openStore();
    const flushed: number[] = [];
    const pipeline = new EventPipeline(store, {
      flushIntervalMs: 1000,
      onFlush: (batch) => flushed.push(batch.length),
    });
    const src = source();
    pipeline.enqueue(event(src, 'tool.post', { tool_name: 'Read', success: true }));
    pipeline.flush();
    expect(flushed).toEqual([1]);
    pipeline.stop();
    store.close();
  });

  it('re-buffers a batch when the durable write fails, then recovers without loss', () => {
    const store = openStore();
    const flushed: number[] = [];
    vi.spyOn(store, 'insertEvents').mockImplementationOnce(() => {
      throw new Error('simulated transient write failure');
    });
    const pipeline = new EventPipeline(store, {
      batchSize: 100,
      flushIntervalMs: 60_000,
      onFlush: (batch) => flushed.push(batch.length),
    });
    const src = source();
    pipeline.enqueue(event(src, 'tool.post', { tool_name: 'Read', success: true }));
    pipeline.flush();
    // Failed write: nothing persisted, nothing announced to SSE, batch retained.
    expect(store.countEvents()).toBe(0);
    expect(flushed).toEqual([]);
    expect(pipeline.pending).toBe(1);
    // Retry succeeds: the original event is recovered exactly once.
    pipeline.flush();
    expect(pipeline.pending).toBe(0);
    expect(store.countEvents()).toBe(1);
    expect(flushed).toEqual([1]);
    pipeline.stop();
    store.close();
  });

  it('bounds the buffer and retries a failed write without accepting overflow', () => {
    vi.useFakeTimers();
    try {
      const store = openStore();
      vi.spyOn(store, 'insertEvents').mockImplementationOnce(() => {
        throw new Error('simulated transient write failure');
      });
      const pipeline = new EventPipeline(store, {
        batchSize: 1,
        flushIntervalMs: 50,
        maxBufferedEvents: 1,
      });
      const src = source();
      expect(
        pipeline.enqueue(event(src, 'tool.post', { tool_name: 'Read', success: true })).accepted,
      ).toBe(true);
      expect(pipeline.pending).toBe(1);
      expect(
        pipeline.enqueue(event(src, 'tool.post', { tool_name: 'Read', success: true })),
      ).toMatchObject({
        accepted: false,
        reason: 'backpressure',
      });
      vi.advanceTimersByTime(50);
      expect(pipeline.pending).toBe(0);
      expect(store.countEvents()).toBe(1);
      pipeline.stop();
      store.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('replays a recovered batch idempotently after reopen (crash recovery)', () => {
    const src = source();
    const store = openStore();
    const pipeline = new EventPipeline(store, { batchSize: 100, flushIntervalMs: 60_000 });
    const e = event(src, 'task.created', { version: 0 });
    pipeline.enqueue(e);
    pipeline.flush();
    pipeline.stop();
    store.close();
    // Simulate a restart that re-ingests the same durable event_id.
    const reopened = openStore();
    reopened.insertEvents([e], false);
    expect(reopened.countEvents()).toBe(1);
    reopened.close();
  });
});

describe('LocalTaskStore', () => {
  function setup() {
    const store = openStore();
    const emitted: EventEnvelope[] = [];
    const src = source();
    const tasks = new LocalTaskStore(store.db, {
      source: src,
      actor,
      emit: (e) => emitted.push(e),
    });
    return { store, tasks, emitted, src };
  }

  it('creates a task at version 0 with an incrementing number and emits task.created', () => {
    const { store, tasks, emitted } = setup();
    const a = tasks.create({ title: 'First' });
    const b = tasks.create({ title: 'Second' });
    expect(a.version).toBe(0);
    expect(a.state).toBe('backlog');
    expect(a.number).toBe(1);
    expect(b.number).toBe(2);
    expect(emitted.map((e) => e.type)).toEqual(['task.created', 'task.created']);
    expect(emitted[0]?.task_id).toBe(a.task_id);
    store.close();
  });

  it('updates only provided fields and bumps version with CAS', () => {
    const { store, tasks } = setup();
    const task = tasks.create({ title: 'Original', description: 'keep me' });
    const updated = tasks.update(task.task_id, 0, { title: 'Renamed' });
    expect(updated.title).toBe('Renamed');
    expect(updated.description).toBe('keep me');
    expect(updated.version).toBe(1);
    expect(() => tasks.update(task.task_id, 0, { title: 'Stale' })).toThrowError(TaskError);
    try {
      tasks.update(task.task_id, 0, { title: 'Stale' });
    } catch (err) {
      expect((err as TaskError).code).toBe('conflict');
    }
    store.close();
  });

  it('enforces the state machine and rejects invalid transitions', () => {
    const { store, tasks } = setup();
    const task = tasks.create({ title: 'Flow' });
    expect(canTransition('backlog', 'ready')).toBe(true);
    expect(canTransition('backlog', 'completed')).toBe(false);
    expect(() => tasks.transition(task.task_id, 0, 'completed')).toThrowError(TaskError);
    const ready = tasks.transition(task.task_id, 0, 'ready');
    const claimed = tasks.transition(task.task_id, ready.version, 'claimed');
    const active = tasks.transition(task.task_id, claimed.version, 'in_progress');
    expect(active.state).toBe('in_progress');
    expect(active.version).toBe(3);
    store.close();
  });

  it('rejects a transition on a stale base version', () => {
    const { store, tasks } = setup();
    const task = tasks.create({ title: 'Race' });
    tasks.transition(task.task_id, 0, 'ready');
    try {
      tasks.transition(task.task_id, 0, 'claimed');
      expect.unreachable();
    } catch (err) {
      expect((err as TaskError).code).toBe('conflict');
    }
    store.close();
  });

  it('emits task.state_changed with from/to/version', () => {
    const { store, tasks, emitted } = setup();
    const task = tasks.create({ title: 'Emit' });
    emitted.length = 0;
    tasks.transition(task.task_id, 0, 'ready', 'triaged');
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.type).toBe('task.state_changed');
    expect(emitted[0]?.payload).toMatchObject({
      from: 'backlog',
      to: 'ready',
      version: 1,
      reason: 'triaged',
    });
    store.close();
  });

  it('lists tasks filtered by state', () => {
    const { store, tasks } = setup();
    const a = tasks.create({ title: 'A' });
    tasks.create({ title: 'B' });
    tasks.transition(a.task_id, 0, 'ready');
    expect(tasks.listTasks(a.project_id)).toHaveLength(2);
    expect(tasks.listTasks(a.project_id, { state: 'ready' })).toHaveLength(1);
    store.close();
  });

  it('rejects invalid input as a validation error', () => {
    const { store, tasks } = setup();
    try {
      tasks.create({ title: '' });
      expect.unreachable();
    } catch (err) {
      expect((err as TaskError).code).toBe('validation');
    }
    store.close();
  });
});

describe('identity', () => {
  it('generates and persists a stable identity across reloads', () => {
    const first = loadOrCreateIdentity(dir);
    expect(first.device_id).toMatch(/^dev_/);
    expect(first.hook_secret).toHaveLength(64);
    expect(existsSync(join(dir, 'identity.json'))).toBe(true);
    const second = loadOrCreateIdentity(dir);
    expect(second.device_id).toBe(first.device_id);
    expect(second.hook_secret).toBe(first.hook_secret);
  });

  it('honors config overrides for device and project', () => {
    loadOrCreateIdentity(dir);
    const deviceId = makeId('device');
    const projectId = makeId('project');
    const overridden = loadOrCreateIdentity(dir, { deviceId, projectId });
    expect(overridden.device_id).toBe(deviceId);
    expect(overridden.project_id).toBe(projectId);
    const persisted = JSON.parse(readFileSync(join(dir, 'identity.json'), 'utf8'));
    expect(persisted.device_id).toBe(deviceId);
  });
});
