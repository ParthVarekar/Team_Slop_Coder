import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  openSqlite,
  migrate,
  DAEMON_MIGRATIONS,
  makeRetentionPolicy,
  type SqliteDatabase,
} from '@weft/core';
import { makeId, safeParseEvent, type Actor } from '@weft/protocol';
import { LocalStore, type StoredLocalEvent } from './store.js';
import { LocalRetentionService } from './retention.js';

const OLD = '2020-01-01T00:00:00.000Z';
const RECENT = '2099-01-01T00:00:00.000Z';
const CUTOFF = '2026-01-01T00:00:00.000Z';
const PROJECT_ID = makeId('project');
const actor: Actor = { user_id: 'user_test', agent: null };
const databases: SqliteDatabase[] = [];
const dirs: string[] = [];

function memory(): { db: SqliteDatabase; store: LocalStore; retention: LocalRetentionService } {
  const db = openSqlite(':memory:');
  migrate(db, DAEMON_MIGRATIONS);
  databases.push(db);
  const store = new LocalStore(db);
  return { db, store, retention: new LocalRetentionService(store, { projectId: PROJECT_ID }) };
}

function event(
  type: string,
  options: { receivedAt?: string; ts?: string; eventId?: string; projectId?: string } = {},
): StoredLocalEvent {
  return {
    v: 1,
    event_id: options.eventId ?? makeId('event'),
    device_id: 'dev_test',
    project_id: options.projectId ?? PROJECT_ID,
    ts: options.ts ?? OLD,
    type,
    actor,
    privacy: 'metadata',
    payload:
      type === 'task.created'
        ? { version: 0 }
        : type === 'summary.compacted'
          ? { seq_start: 1, seq_end: 2, dropped_types: ['tool.post'] }
          : { tool_name: 'Read', success: true },
    received_at: options.receivedAt ?? OLD,
  };
}

function applyInput(retention: LocalRetentionService, batchLimit = 100) {
  const preview = retention.preview({ cutoff: CUTOFF, batchLimit });
  return {
    runId: makeId('run'),
    fingerprint: preview.fingerprint,
    cutoff: preview.cutoff,
    policy: preview.policy,
    confirm: true as const,
  };
}

function count(db: SqliteDatabase, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
}

function hashTable(db: SqliteDatabase, table: string): string {
  return JSON.stringify(db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
}

afterEach(() => {
  for (const db of databases.splice(0)) {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  }
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      /* Windows transient handles */
    }
  }
});

describe('local retention', () => {
  it('dry-run writes nothing and reports exact exclusions and labels', () => {
    const { db, store, retention } = memory();
    store.insertEvents(
      [
        event('tool.post'),
        event('task.created'),
        event('future.unknown'),
        event('tool.pre', { receivedAt: RECENT, ts: OLD }),
        event('tool.post', { ts: RECENT, receivedAt: OLD }),
      ],
      true,
    );
    const before = [
      'events',
      'outbox',
      'event_receipts',
      'event_summaries',
      'retention_runs',
      'retention_ranges',
    ].map((table) => hashTable(db, table));
    const preview = retention.preview({ cutoff: CUTOFF, batchLimit: 1 });
    expect(preview.dryRun).toBe(true);
    expect(preview.eligibleRows).toBe(0); // both old allowlisted rows are pending outbox
    expect(preview.pendingOutboxExclusions).toBe(2);
    expect(preview.exclusions.protectedCoordination).toBe(1);
    expect(preview.exclusions.protectedUnknown).toBe(1);
    expect(preview.exclusions.protectedOrNonAllowlisted).toBe(0);
    expect(preview.exclusions.tooNew).toBe(1);
    expect(preview.measurements.payloadBytes.label).toBe('exact');
    expect(preview.measurements.allocatedRelationBytes.label).not.toBe('reclaimed');
    expect(
      [
        'events',
        'outbox',
        'event_receipts',
        'event_summaries',
        'retention_runs',
        'retention_ranges',
      ].map((table) => hashTable(db, table)),
    ).toEqual(before);
  });

  it('excludes pending outbox rows and receipted hot rows from preview and apply', () => {
    const { db, store, retention } = memory();
    const pending = event('tool.post');
    store.insertEvents([pending], true);
    expect(retention.preview({ cutoff: CUTOFF }).selectedRows).toBe(0);
    store.ackOutbox([pending.event_id]);
    const input = applyInput(retention);
    expect(input.fingerprint).toBeTruthy();

    db.prepare(
      `INSERT INTO event_receipts
      (event_id, device_id, project_id, original_rowid, received_at, event_type,
       payload_bytes, event_digest, run_id, summary_event_id, compacted_at)
      VALUES (?, ?, ?, 1, ?, ?, 12, ?, 'prior_run', 'prior_summary', ?)`,
    ).run(
      pending.event_id,
      pending.device_id,
      pending.project_id,
      pending.received_at,
      pending.type,
      'a'.repeat(64),
      RECENT,
    );
    const preview = retention.preview({ cutoff: CUTOFF });
    expect(preview.selectedRows).toBe(0);
    expect(preview.exclusions.protectedReceipts).toBe(1);
    expect(() => retention.apply(input)).toThrow(/stale/i);
    expect(count(db, 'events')).toBe(1);
    expect(count(db, 'retention_runs')).toBe(0);
    expect(count(db, 'event_summaries')).toBe(0);
  });

  it('uses received_at despite client ts manipulation and preserves protected rows', () => {
    const { db, store, retention } = memory();
    const protectedTables = [
      'coordination_events',
      'tasks',
      'validation_runs',
      'check_results',
      'file_modifications',
      'branches',
      'worktrees',
      'agent_sessions',
    ];
    store.insertEvents(
      [
        event('tool.post', { ts: RECENT, receivedAt: OLD }),
        event('tool.pre', { ts: OLD, receivedAt: RECENT }),
        event('task.created'),
        event('file.changed'),
        event('symbols.changed'),
        event('branch.updated'),
        event('worktree.created'),
        event('commit.created'),
        event('health.regression'),
        event('notification.created'),
        event('summary.compacted', { eventId: 'evt_existing_summary' }),
        event('unknown.future'),
      ],
      false,
    );
    const before = protectedTables.map((table) => hashTable(db, table));
    const input = applyInput(retention);
    const result = retention.apply(input);
    expect(result.selectedRows).toBe(1);
    expect(count(db, 'events')).toBe(12); // 13 inserted, one compacted, one summary added
    expect(protectedTables.map((table) => hashTable(db, table))).toEqual(before);
    expect(count(db, 'event_receipts')).toBe(1);
    expect(count(db, 'event_summaries')).toBe(1); // new range evidence only summary
    expect(count(db, 'retention_ranges')).toBe(1);
    expect(count(db, 'retention_runs')).toBe(1);
    expect(result.summaryEventIds).toHaveLength(1);
    const summary = store
      .getEvents({ limit: 100 })
      .find((row) => row.event_id === result.summaryEventIds[0]);
    expect(summary).toBeDefined();
    expect(safeParseEvent(summary).success).toBe(true);
  });

  it('deletes exact rowids, splits around protected gaps, and enforces a bounded batch', () => {
    const { db, store, retention } = memory();
    store.insertEvents(
      [
        event('tool.post'),
        event('task.created'),
        event('tool.pre'),
        event('tool.post'),
        event('unknown.future'),
        event('tool.failed'),
      ],
      false,
    );
    const preview = retention.preview({ cutoff: CUTOFF, batchLimit: 3 });
    expect(preview.selectedRows).toBe(3);
    expect(preview.remainingAfterBatch).toBe(1);
    expect(preview.ranges).toEqual([
      { sequenceKind: 'rowid', seqStart: 1, seqEnd: 1 },
      { sequenceKind: 'rowid', seqStart: 3, seqEnd: 4 },
    ]);
    const result = retention.apply({
      runId: makeId('run'),
      fingerprint: preview.fingerprint,
      cutoff: preview.cutoff,
      policy: preview.policy,
      confirm: true,
    });
    expect(result.selectedRows).toBe(3);
    expect(result.remainingAfterBatch).toBe(1);
    expect(result.exclusions).toEqual(preview.exclusions);
    expect(result.measurements.storedTupleEstimateBytes.label).toBe('estimate');
    expect(result.rangeCount).toBe(2);
    expect(result.summaryCount).toBe(2);
    expect(count(db, 'events')).toBe(5); // 3 protected + 1 eligible + 2 summaries
    expect(count(db, 'event_receipts')).toBe(3);
  });

  it.each(['events', 'event_summaries', 'event_receipts', 'retention_ranges', 'retention_runs'])(
    'rolls back every write when %s evidence insertion fails',
    (table) => {
      const { db, store, retention } = memory();
      store.insertEvents([event('tool.post'), event('tool.pre')], false);
      const condition = table === 'events' ? "WHEN NEW.type = 'summary.compacted'" : '';
      db.exec(`CREATE TRIGGER fail_${table} BEFORE INSERT ON ${table} ${condition}
               BEGIN SELECT RAISE(ABORT, 'evidence failure'); END`);
      const input = applyInput(retention);
      expect(() => retention.apply(input)).toThrow('evidence failure');
      expect(count(db, 'events')).toBe(2);
      expect(count(db, 'event_receipts')).toBe(0);
      expect(count(db, 'event_summaries')).toBe(0);
      expect(count(db, 'retention_ranges')).toBe(0);
      expect(count(db, 'retention_runs')).toBe(0);
    },
  );

  it('rejects a stale fingerprint without writes', () => {
    const { db, store, retention } = memory();
    store.insertEvents([event('tool.post'), event('tool.pre')], false);
    const input = applyInput(retention);
    db.prepare('UPDATE events SET payload = ? WHERE rowid = 1').run(
      JSON.stringify({ tool_name: 'Changed', success: true }),
    );
    expect(() => retention.apply(input)).toThrow(/stale/i);
    expect(count(db, 'events')).toBe(2);
    expect(count(db, 'retention_runs')).toBe(0);
  });

  it('makes a committed run id idempotent and rejects run-id conflicts', () => {
    const { db, store, retention } = memory();
    store.insertEvents([event('tool.post')], false);
    const input = applyInput(retention);
    const first = retention.apply(input);
    const replay = retention.apply(input);
    expect(replay.idempotent).toBe(true);
    expect(replay.committedAt).toBe(first.committedAt);
    expect(count(db, 'retention_runs')).toBe(1);
    expect(count(db, 'event_summaries')).toBe(1);
    expect(() => retention.apply({ ...input, fingerprint: 'different' })).toThrow(/already used/i);
    expect(() => retention.apply({ ...input, confirm: false as unknown as true })).toThrow(
      /confirm/i,
    );
  });

  it('does not resurrect compacted hot rows or acknowledged/dropped outbox rows on replay', () => {
    const { db, store, retention } = memory();
    const compacted = event('tool.post');
    const coordination = event('task.created');
    store.insertEvents([compacted, coordination], true);
    store.ackOutbox([compacted.event_id, coordination.event_id]);
    retention.apply(applyInput(retention));
    const hotBefore = store.getEvents({ limit: 100 }).length;
    // A replay also repairs a missing durable mirror without refilling outbox.
    db.prepare('DELETE FROM coordination_events WHERE event_id = ?').run(coordination.event_id);
    store.insertEvents([compacted, coordination], true);
    expect(store.getEvents({ limit: 100 }).some((row) => row.event_id === compacted.event_id)).toBe(
      false,
    );
    expect(
      store.getEvents({ limit: 100 }).some((row) => row.event_id === coordination.event_id),
    ).toBe(true);
    expect(store.pendingOutboxCount()).toBe(0);
    expect(count(db, 'coordination_events')).toBe(1);
    expect(hotBefore).toBe(2); // protected coordination + synthetic summary

    const dropped = event('tool.pre');
    store.insertEvents([dropped], true);
    expect(store.compactOutbox(0)).toBe(1);
    store.insertEvents([dropped], true);
    expect(store.pendingOutboxCount()).toBe(0);
    expect(count(db, 'outbox_compactions')).toBe(1);
  });

  it('preserves the rowid high-water mark after max-rowid deletion and reopen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'weft-retention-reopen-'));
    dirs.push(dir);
    const first = LocalStore.open(dir);
    databases.push(first.db);
    first.insertEvents([event('tool.post'), event('tool.pre'), event('tool.post')], false);
    const oldMax = first.maxRowId();
    const retention = new LocalRetentionService(first, { projectId: PROJECT_ID });
    retention.apply(applyInput(retention));
    const summaryMax = first.maxRowId();
    expect(summaryMax).toBeGreaterThan(oldMax);
    first.close();
    databases.splice(databases.indexOf(first.db), 1);
    const reopened = LocalStore.open(dir);
    databases.push(reopened.db);
    reopened.insertEvents([event('tool.failed')], false);
    expect(reopened.maxRowId()).toBeGreaterThan(summaryMax);
  });

  it('compacts only allowlisted outbox telemetry, records evidence, and exposes coordination backpressure', () => {
    const { db, store } = memory();
    const tools = Array.from({ length: 4 }, () => event('tool.post'));
    const coordination = Array.from({ length: 3 }, () => event('task.created'));
    const unknown = event('future.unknown');
    store.insertEvents([...tools, ...coordination, unknown], true);
    expect(store.compactOutbox(3)).toBe(4);
    const pending = store.pendingOutbox(100);
    expect(pending.map((row) => row.event_id).sort()).toEqual(
      [...coordination, unknown].map((row) => row.event_id).sort(),
    );
    expect(count(db, 'outbox_compactions')).toBe(4);
    expect(count(db, 'retention_runs')).toBe(1);
    expect(count(db, 'retention_ranges')).toBe(1);
    expect(store.outboxPressure(3).backpressure).toBe(true);
    expect(store.outboxPressure(3).coordinationPending).toBe(3);
  });

  it('rolls back outbox evidence and exact deletion together', () => {
    const { db, store } = memory();
    store.insertEvents([event('tool.post'), event('tool.pre')], true);
    db.exec(`CREATE TRIGGER fail_outbox_evidence BEFORE INSERT ON outbox_compactions
             BEGIN SELECT RAISE(ABORT, 'outbox evidence failure'); END`);
    expect(() => store.compactOutbox(1)).toThrow('outbox evidence failure');
    expect(store.pendingOutboxCount()).toBe(2);
    expect(count(db, 'outbox_compactions')).toBe(0);
    expect(count(db, 'retention_runs')).toBe(0);
    expect(count(db, 'retention_ranges')).toBe(0);
  });

  it('scheduler is disabled by default and stops idempotently', () => {
    const { store } = memory();
    const disabled = new LocalRetentionService(store, {
      projectId: PROJECT_ID,
      intervalMs: 60_000,
    });
    disabled.start();
    expect(disabled.status().scheduler.running).toBe(false);
    const enabled = new LocalRetentionService(store, {
      projectId: PROJECT_ID,
      intervalMs: 60_000,
      schedulerEnabled: true,
    });
    enabled.start();
    enabled.start();
    expect(enabled.status().scheduler.running).toBe(true);
    expect(enabled.status().scheduler.nextRunAt).not.toBeNull();
    expect(enabled.status().scheduler.destructiveApply).toBe(false);
    enabled.stop();
    enabled.stop();
    expect(enabled.status().scheduler.running).toBe(false);
    expect(enabled.status().scheduler.nextRunAt).toBeNull();
  });

  it('rejects policy widening and mismatched exact cutoff', () => {
    const { retention } = memory();
    const input = applyInput(retention);
    expect(() =>
      retention.apply({
        ...input,
        policy: {
          ...input.policy,
          allowlist: [...input.policy.allowlist, 'future.unknown'] as never,
        },
      }),
    ).toThrow(/allowlist/i);
    expect(() => retention.apply({ ...input, cutoff: '2025-01-01T00:00:00.000Z' })).toThrow(
      /cutoff/i,
    );
    expect(makeRetentionPolicy(CUTOFF).cutoff).toBe(CUTOFF);
  });
});
