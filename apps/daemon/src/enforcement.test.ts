import { describe, expect, it } from 'vitest';
import { makeId, ulid, PROTOCOL_VERSION, type StoredEvent } from '@weft/protocol';
import { EnforcementCache, globMatch } from './enforcement.js';

const deviceId = makeId('device');
const projectId = makeId('project');

function coord(
  seq: number,
  type: string,
  payload: Record<string, unknown>,
  extra: Partial<StoredEvent> = {},
): StoredEvent {
  return {
    v: PROTOCOL_VERSION,
    event_id: ulid(),
    device_id: deviceId,
    project_id: projectId,
    ts: new Date().toISOString(),
    type,
    actor: { user_id: makeId('user'), agent: null },
    privacy: 'metadata',
    payload,
    global_seq: seq,
    received_at: new Date().toISOString(),
    ...extra,
  };
}

describe('globMatch', () => {
  it('matches ** across directories and * within a segment', () => {
    expect(globMatch('src/**', 'src/a.ts')).toBe(true);
    expect(globMatch('src/**', 'src/sub/deep/a.ts')).toBe(true);
    expect(globMatch('src/*.ts', 'src/a.ts')).toBe(true);
    expect(globMatch('src/*.ts', 'src/sub/a.ts')).toBe(false);
    expect(globMatch('**/*.ts', 'a.ts')).toBe(true);
    expect(globMatch('**/*.ts', 'src/sub/a.ts')).toBe(true);
  });

  it('matches ? as a single non-separator char and escapes regex specials', () => {
    expect(globMatch('a?.ts', 'ab.ts')).toBe(true);
    expect(globMatch('a?.ts', 'a/b.ts')).toBe(false);
    expect(globMatch('file.name.ts', 'file.name.ts')).toBe(true);
    expect(globMatch('file.name.ts', 'fileXnameXts')).toBe(false);
  });

  it('normalizes windows separators and matches a bare **', () => {
    expect(globMatch('src/**', 'src\\sub\\a.ts')).toBe(true);
    expect(globMatch('**', 'anything/at/all.ts')).toBe(true);
  });
});

describe('EnforcementCache reservations', () => {
  it('blocks another task on a hard reservation and passes the holder', () => {
    const cache = new EnforcementCache();
    cache.setStale(false);
    cache.applyEvent(
      coord(1, 'reservation.acquired', {
        path_glob: 'src/**',
        mode: 'hard',
        holder_task_id: 'task_owner',
      }),
    );
    expect(cache.checkReservation('src/a.ts', 'task_other')).toBe('blocked');
    expect(cache.checkReservation('src/a.ts', 'task_owner')).toBe('pass');
    expect(cache.checkReservation('docs/a.md', 'task_other')).toBe('pass');
  });

  it('warns on a soft reservation when fresh but fails open when stale', () => {
    const cache = new EnforcementCache();
    cache.applyEvent(
      coord(1, 'reservation.acquired', {
        path_glob: 'src/**',
        mode: 'soft',
        holder_task_id: 'task_owner',
      }),
    );
    cache.setStale(false);
    expect(cache.checkReservation('src/a.ts', 'task_other')).toBe('warn');
    cache.setStale(true);
    expect(cache.checkReservation('src/a.ts', 'task_other')).toBe('pass');
  });

  it('hard reservations fail closed when stale (ignore unconfirmed expiry)', () => {
    const cache = new EnforcementCache();
    const past = new Date(Date.now() - 60_000).toISOString();
    cache.applyEvent(
      coord(1, 'reservation.acquired', {
        path_glob: 'src/**',
        mode: 'hard',
        holder_task_id: 'task_owner',
        expires_at: past,
      }),
    );
    cache.setStale(false);
    expect(cache.checkReservation('src/a.ts', 'task_other')).toBe('pass'); // expired + fresh
    cache.setStale(true);
    expect(cache.checkReservation('src/a.ts', 'task_other')).toBe('blocked'); // fail closed
  });

  it('ignores released and expired soft reservations', () => {
    const cache = new EnforcementCache();
    cache.setStale(false);
    cache.applyEvent(
      coord(1, 'reservation.acquired', {
        path_glob: 'src/**',
        mode: 'soft',
        holder_task_id: 'task_owner',
      }),
    );
    cache.applyEvent(coord(2, 'reservation.released', { path_glob: 'src/**', mode: 'soft' }));
    expect(cache.checkReservation('src/a.ts', 'task_other')).toBe('pass');
  });

  it('renew reactivates a reservation with a new expiry', () => {
    const cache = new EnforcementCache();
    cache.setStale(false);
    cache.applyEvent(
      coord(1, 'reservation.acquired', {
        path_glob: 'src/**',
        mode: 'hard',
        holder_task_id: 'task_owner',
      }),
    );
    cache.applyEvent(coord(2, 'reservation.released', { path_glob: 'src/**', mode: 'hard' }));
    expect(cache.checkReservation('src/a.ts', 'task_other')).toBe('pass');
    cache.applyEvent(
      coord(3, 'reservation.renewed', {
        path_glob: 'src/**',
        mode: 'hard',
        holder_task_id: 'task_owner',
      }),
    );
    expect(cache.checkReservation('src/a.ts', 'task_other')).toBe('blocked');
  });
});

describe('EnforcementCache lease grace', () => {
  it('hard lock blocks through the expiry grace (no mid-edit steal), reclaims past grace', () => {
    const cache = new EnforcementCache();
    cache.setStale(false);
    const now = Date.now();
    cache.applyEvent(
      coord(1, 'reservation.acquired', {
        path_glob: 'src/**',
        mode: 'hard',
        holder_task_id: 'task_owner',
        expires_at: new Date(now - 1_000).toISOString(), // already expired
        grace_until: new Date(now + 60_000).toISOString(), // but still in grace
      }),
    );
    // Inside grace: expires_at has passed yet the lock must STILL block rivals.
    expect(cache.checkReservation('src/a.ts', 'task_other', now)).toBe('blocked');
    expect(cache.checkReservation('src/a.ts', 'task_owner', now)).toBe('pass');
    // Past grace: reclaimable.
    expect(cache.checkReservation('src/a.ts', 'task_other', now + 120_000)).toBe('pass');
  });

  it('hard lock with no grace reclaims at expires_at when fresh', () => {
    const cache = new EnforcementCache();
    cache.setStale(false);
    const now = Date.now();
    cache.applyEvent(
      coord(1, 'reservation.acquired', {
        path_glob: 'src/**',
        mode: 'hard',
        holder_task_id: 'task_owner',
        expires_at: new Date(now - 1_000).toISOString(),
      }),
    );
    expect(cache.checkReservation('src/a.ts', 'task_other', now)).toBe('pass');
  });

  it('soft reservation uses expires_at, not grace_until (advisory, no grace extension)', () => {
    const cache = new EnforcementCache();
    cache.setStale(false);
    const now = Date.now();
    cache.applyEvent(
      coord(1, 'reservation.acquired', {
        path_glob: 'src/**',
        mode: 'soft',
        holder_task_id: 'task_owner',
        expires_at: new Date(now - 1_000).toISOString(),
        grace_until: new Date(now + 60_000).toISOString(),
      }),
    );
    expect(cache.checkReservation('src/a.ts', 'task_other', now)).toBe('pass');
  });

  it('stale hard lock fails closed past grace but still blocks inside grace', () => {
    const cache = new EnforcementCache();
    cache.setStale(true);
    const now = Date.now();
    cache.applyEvent(
      coord(1, 'reservation.acquired', {
        path_glob: 'src/**',
        mode: 'hard',
        holder_task_id: 'task_owner',
        expires_at: new Date(now - 1_000).toISOString(),
        grace_until: new Date(now + 60_000).toISOString(),
      }),
    );
    expect(cache.checkReservation('src/a.ts', 'task_other', now)).toBe('blocked');
    // Past grace + stale: cannot confirm reclaim, so fail closed.
    expect(cache.checkReservation('src/a.ts', 'task_other', now + 120_000)).toBe('blocked');
  });

  it('projects holder_device_id from the payload, not the emitting server device', () => {
    const cache = new EnforcementCache();
    cache.applyEvent(
      coord(1, 'reservation.acquired', {
        path_glob: 'src/**',
        mode: 'hard',
        holder_task_id: 'task_owner',
        holder_device_id: 'device_holder',
      }),
    );
    expect(cache.snapshot().reservations[0]?.holder_device_id).toBe('device_holder');
  });
});

describe('EnforcementCache claims and conflicts', () => {
  it('projects task claims and releases', () => {
    const cache = new EnforcementCache();
    cache.applyEvent(coord(1, 'task.claimed', { version: 2 }, { task_id: 'task_1' }));
    expect(cache.getClaim('task_1')?.state).toBe('claimed');
    expect(cache.getClaim('task_1')?.version).toBe(2);
    cache.applyEvent(coord(2, 'task.released', { version: 3 }, { task_id: 'task_1' }));
    expect(cache.getClaim('task_1')?.state).toBe('released');
  });

  it('projects conflict lifecycle by canonical key', () => {
    const cache = new EnforcementCache();
    cache.applyEvent(
      coord(1, 'conflict.detected', {
        canonical_key: 'k1',
        kind: 'file_overlap',
        severity: 'blocking',
      }),
    );
    expect(cache.getConflict('k1')?.state).toBe('open');
    cache.applyEvent(coord(2, 'conflict.resolved', { canonical_key: 'k1' }));
    expect(cache.getConflict('k1')?.state).toBe('resolved');
    expect(cache.getConflict('k1')?.kind).toBe('file_overlap');
  });
});

describe('EnforcementCache replay safety', () => {
  it('ignores events at or below the applied cursor (idempotent replay)', () => {
    const cache = new EnforcementCache();
    cache.applyEvent(
      coord(5, 'reservation.acquired', {
        path_glob: 'src/**',
        mode: 'hard',
        holder_task_id: 'task_owner',
      }),
    );
    cache.setStale(false);
    // A stale replay must not regress the cursor or re-add a released reservation.
    cache.applyEvent(coord(2, 'reservation.released', { path_glob: 'src/**', mode: 'hard' }));
    expect(cache.getCursor()).toBe(5);
    expect(cache.checkReservation('src/a.ts', 'task_other')).toBe('blocked');
  });

  it('clear() resets the projection for a forced resync', () => {
    const cache = new EnforcementCache();
    cache.applyEvent(
      coord(1, 'reservation.acquired', {
        path_glob: 'src/**',
        mode: 'hard',
        holder_task_id: 'task_owner',
      }),
    );
    cache.applyEvent(coord(2, 'task.claimed', { version: 0 }, { task_id: 'task_1' }));
    cache.clear();
    expect(cache.getCursor()).toBe(0);
    expect(cache.snapshot().reservations).toHaveLength(0);
    expect(cache.getClaim('task_1')).toBeUndefined();
  });
});
