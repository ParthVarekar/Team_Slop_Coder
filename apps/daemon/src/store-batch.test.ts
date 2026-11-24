import { describe, expect, it } from 'vitest';
import { migrate, openSqlite, DAEMON_MIGRATIONS } from '@weft/core';
import { makeId, ulid } from '@weft/protocol';
import { LocalStore, type StoredLocalEvent } from './store.js';

function event(type: string, seq: number): StoredLocalEvent {
  const ts = new Date(1_700_000_000_000 + seq).toISOString();
  return {
    v: 1,
    event_id: ulid(),
    device_id: makeId('device'),
    project_id: makeId('project'),
    repo_id: makeId('repo'),
    session_id: makeId('session'),
    seq,
    ts,
    type,
    actor: { user_id: makeId('user'), agent: null },
    privacy: 'metadata',
    payload: type === 'task.created' ? { version: 0 } : { tool_name: 'Edit', success: true },
    received_at: ts,
  };
}

describe('LocalStore batched inserts', () => {
  it('persists mixed durable and telemetry rows across chunk boundaries', () => {
    const db = openSqlite(':memory:');
    migrate(db, DAEMON_MIGRATIONS);
    const store = new LocalStore(db);
    const events = Array.from({ length: 205 }, (_, i) =>
      event(i % 2 === 0 ? 'tool.post' : 'task.created', i),
    );

    store.insertEvents(events, true);

    expect(store.countEvents()).toBe(205);
    expect(store.pendingOutboxCount()).toBe(205);
    expect(
      (db.prepare('SELECT COUNT(*) AS count FROM coordination_events').get() as { count: number })
        .count,
    ).toBe(102);
    store.insertEvents(events, true);
    expect(store.countEvents()).toBe(205);
    expect(store.pendingOutboxCount()).toBe(205);
    db.close();
  });

  it('rolls back events and coordination rows when a later outbox write fails', () => {
    const db = openSqlite(':memory:');
    migrate(db, DAEMON_MIGRATIONS);
    db.exec(`CREATE TRIGGER reject_outbox BEFORE INSERT ON outbox
             BEGIN SELECT RAISE(ABORT, 'outbox unavailable'); END`);
    const store = new LocalStore(db);

    expect(() =>
      store.insertEvents([event('task.created', 1), event('tool.post', 2)], true),
    ).toThrow('outbox unavailable');
    expect(store.countEvents()).toBe(0);
    expect(
      (db.prepare('SELECT COUNT(*) AS count FROM coordination_events').get() as { count: number })
        .count,
    ).toBe(0);
    db.close();
  });
});
