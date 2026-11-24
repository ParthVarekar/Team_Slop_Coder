import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeId, type Actor } from '@weft/protocol';
import { LocalStore, type StoredLocalEvent } from './store.js';
import { OutboxShipper } from './shipper.js';
import { draftEvent, type EventSource } from './events.js';

let dir: string;
const stores: LocalStore[] = [];
function openStore(): LocalStore {
  const store = LocalStore.open(dir);
  stores.push(store);
  return store;
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'weft-shipper-'));
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
    /* Windows WAL lock */
  }
});

const actor: Actor = { user_id: makeId('user'), agent: null };
function source(): EventSource {
  return { deviceId: makeId('device'), projectId: makeId('project') };
}
function event(src: EventSource, type: string, payload: Record<string, unknown>): StoredLocalEvent {
  return { ...draftEvent(src, { type, actor, payload }), received_at: new Date().toISOString() };
}

type Mode = 'ok' | 'network' | 'http500' | 'http401';

/** In-memory stand-in for the server ingest endpoint with real dedup semantics. */
function fakeServer() {
  const seen = new Map<string, { seq: number; count: number }>();
  const rejectIds = new Set<string>();
  let mode: Mode = 'ok';
  let seq = 0;
  const fetchImpl: typeof fetch = async (_input, init) => {
    if (mode === 'network') throw new Error('ECONNREFUSED simulated');
    if (mode === 'http500')
      return new Response(JSON.stringify({ error: 'internal' }), { status: 500 });
    if (mode === 'http401')
      return new Response(JSON.stringify({ error: 'unauthorized', reason: 'unknown_token' }), {
        status: 401,
      });
    const body = JSON.parse(String((init as RequestInit).body)) as {
      events: { event_id: string; device_id: string }[];
    };
    const accepted: { event_id: string; global_seq: number; received_at: string }[] = [];
    const duplicates: typeof accepted = [];
    const rejected: { event_id: string; error: string }[] = [];
    for (const e of body.events) {
      const key = `${e.device_id}:${e.event_id}`;
      if (rejectIds.has(e.event_id)) {
        rejected.push({ event_id: e.event_id, error: 'invalid' });
        continue;
      }
      const prior = seen.get(key);
      if (prior) {
        prior.count += 1;
        duplicates.push({
          event_id: e.event_id,
          global_seq: prior.seq,
          received_at: new Date().toISOString(),
        });
      } else {
        seq += 1;
        seen.set(key, { seq, count: 1 });
        accepted.push({
          event_id: e.event_id,
          global_seq: seq,
          received_at: new Date().toISOString(),
        });
      }
    }
    return new Response(JSON.stringify({ accepted, duplicates, rejected, streams: {} }), {
      status: 202,
    });
  };
  return {
    fetchImpl,
    seen,
    rejectIds,
    setMode: (m: Mode) => {
      mode = m;
    },
  };
}

function shipper(
  store: LocalStore,
  server: ReturnType<typeof fakeServer>,
  opts: Partial<ConstructorParameters<typeof OutboxShipper>[0]> = {},
) {
  return new OutboxShipper({
    baseUrl: 'http://server.test',
    token: 'weft_test',
    store,
    fetchImpl: server.fetchImpl,
    intervalMs: 60_000,
    backoffMs: 1,
    maxBackoffMs: 5,
    ...opts,
  });
}

describe('OutboxShipper', () => {
  it('ships pending events and acks (deletes) accepted rows', async () => {
    const store = openStore();
    const src = source();
    store.insertEvents(
      [
        event(src, 'tool.post', { tool_name: 'Read', success: true }),
        event(src, 'task.created', { version: 0 }),
      ],
      true,
    );
    expect(store.pendingOutboxCount()).toBe(2);
    const server = fakeServer();
    const s = shipper(store, server);
    const result = await s.drain();
    expect(result.shipped).toBe(2);
    expect(result.error).toBeUndefined();
    expect(store.pendingOutboxCount()).toBe(0);
    expect(server.seen.size).toBe(2);
    await s.stop();
    store.close();
  });

  it('treats server duplicates as acked (idempotent replay, no re-ship loop)', async () => {
    const store = openStore();
    const src = source();
    const e = event(src, 'task.created', { version: 0 });
    store.insertEvents([e], true);
    const server = fakeServer();
    // Pretend the server already durably has this event (crash after POST, before ack).
    server.seen.set(`${e.device_id}:${e.event_id}`, { seq: 1, count: 1 });
    const s = shipper(store, server);
    const result = await s.drain();
    expect(result.shipped).toBe(0);
    expect(result.duplicates).toBe(1);
    expect(store.pendingOutboxCount()).toBe(0);
    await s.stop();
    store.close();
  });

  it('retains the outbox on network failure and recovers with zero loss', async () => {
    const store = openStore();
    const src = source();
    const batch = Array.from({ length: 5 }, () =>
      event(src, 'tool.post', { tool_name: 'Read', success: true }),
    );
    store.insertEvents(batch, true);
    const server = fakeServer();
    server.setMode('network');
    const s = shipper(store, server);
    const failed = await s.drain();
    expect(failed.error).toBeDefined();
    expect(store.pendingOutboxCount()).toBe(5);
    const attempts = store.pendingOutbox(5).map((r) => r.attempts);
    expect(attempts.every((a) => a >= 1)).toBe(true);
    // Network restored: the durable outbox drains exactly once.
    server.setMode('ok');
    const ok = await s.drain();
    expect(ok.shipped).toBe(5);
    expect(store.pendingOutboxCount()).toBe(0);
    expect(server.seen.size).toBe(5);
    expect([...server.seen.values()].every((v) => v.count === 1)).toBe(true);
    await s.stop();
    store.close();
  });

  it('retains the outbox on auth failure (does not drop on 401)', async () => {
    const store = openStore();
    const src = source();
    store.insertEvents([event(src, 'task.created', { version: 0 })], true);
    const server = fakeServer();
    server.setMode('http401');
    const s = shipper(store, server);
    const result = await s.drain();
    expect(result.error).toBe('unknown_token');
    expect(store.pendingOutboxCount()).toBe(1);
    await s.stop();
    store.close();
  });

  it('removes permanently-invalid poison pills so they cannot block the queue', async () => {
    const store = openStore();
    const src = source();
    const bad = event(src, 'tool.post', { tool_name: 'Read', success: true });
    const good = event(src, 'task.created', { version: 0 });
    store.insertEvents([bad, good], true);
    const server = fakeServer();
    server.rejectIds.add(bad.event_id);
    const s = shipper(store, server);
    const result = await s.drain();
    expect(result.rejected).toBe(1);
    expect(result.shipped).toBe(1);
    expect(store.pendingOutboxCount()).toBe(0);
    expect(server.seen.has(`${good.device_id}:${good.event_id}`)).toBe(true);
    await s.stop();
    store.close();
  });

  it('compacts oldest telemetry first but never drops coordination rows', async () => {
    const store = openStore();
    const src = source();
    const telemetry = Array.from({ length: 10 }, () =>
      event(src, 'tool.post', { tool_name: 'Read', success: true }),
    );
    const coordination = Array.from({ length: 3 }, () =>
      event(src, 'task.created', { version: 0 }),
    );
    store.insertEvents([...telemetry, ...coordination], true);
    expect(store.pendingOutboxCount()).toBe(13);
    // Budget 5: excess 8 removed from oldest telemetry; coordination untouched.
    expect(store.compactOutbox(5)).toBe(8);
    expect(store.pendingOutboxCount()).toBe(5);
    const remaining = store.pendingOutbox(100);
    expect(remaining.filter((r) => r.kind === 'coordination')).toHaveLength(3);
    // Budget below the coordination floor: telemetry exhausted, coordination kept.
    expect(store.compactOutbox(2)).toBe(2);
    expect(store.pendingOutboxCount()).toBe(3);
    expect(store.pendingOutbox(100).every((r) => r.kind === 'coordination')).toBe(true);
    store.close();
  });

  it('bounds the outbox during shipping while preserving every coordination event', async () => {
    const store = openStore();
    const src = source();
    const telemetry = Array.from({ length: 10 }, () =>
      event(src, 'tool.post', { tool_name: 'Read', success: true }),
    );
    const coordination = Array.from({ length: 3 }, () =>
      event(src, 'task.created', { version: 0 }),
    );
    store.insertEvents([...telemetry, ...coordination], true);
    const server = fakeServer();
    const s = shipper(store, server, { batchSize: 2, maxOutboxRows: 3 });
    await s.drain();
    expect(store.pendingOutboxCount()).toBe(0);
    // All 3 coordination events reached the server; telemetry was partly compacted.
    const coordSeen = coordination.filter((e) => server.seen.has(`${e.device_id}:${e.event_id}`));
    expect(coordSeen).toHaveLength(3);
    expect(server.seen.size).toBeLessThan(13);
    await s.stop();
    store.close();
  });

  it('survives a daemon restart: durable outbox resumes with zero loss/dup', async () => {
    const src = source();
    const batch = Array.from({ length: 4 }, () => event(src, 'task.created', { version: 0 }));
    const store = openStore();
    store.insertEvents(batch, true);
    const server = fakeServer();
    // Simulate a network outage and close before anything was acknowledged.
    server.setMode('network');
    const s1 = shipper(store, server, { batchSize: 2 });
    await s1.drain();
    expect(store.pendingOutboxCount()).toBe(4);
    await s1.stop();
    store.close();
    const reopened = openStore();
    expect(reopened.pendingOutboxCount()).toBe(4);
    server.setMode('ok');
    const s2 = shipper(reopened, server, { batchSize: 2 });
    const result = await s2.drain();
    expect(result.shipped).toBe(4);
    expect(result.duplicates).toBe(0);
    expect(reopened.pendingOutboxCount()).toBe(0);
    expect([...server.seen.values()].every((v) => v.count === 1)).toBe(true);
    // Replay of acknowledged hot events neither resurrects them nor refills outbox.
    reopened.insertEvents(batch, true);
    expect(reopened.pendingOutboxCount()).toBe(0);
    await s2.stop();
    reopened.close();
  });

  it('notify() wakes an idle shipper to drain new events', async () => {
    const store = openStore();
    const src = source();
    const server = fakeServer();
    const s = shipper(store, server);
    store.insertEvents([event(src, 'task.created', { version: 0 })], true);
    s.notify();
    await s.drain();
    expect(server.seen.size).toBe(1);
    expect(store.pendingOutboxCount()).toBe(0);
    await s.stop();
    store.close();
  });
});
