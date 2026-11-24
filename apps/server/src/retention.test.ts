import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeId, ulid, type EventEnvelope } from '@weft/protocol';
import { openCentralDatabase, type CentralDatabase } from './db.js';
import { IngestService } from './ingest.js';
import { CentralRetentionService } from './retention.js';
import { readAudit } from './audit.js';
import { startEmbeddedPostgres, type EmbeddedCluster } from '../test/embedded.js';

let cluster: EmbeddedCluster;
let db: CentralDatabase;
let retention: CentralRetentionService;
let ingest: IngestService;
const OLD = '2020-01-01T00:00:00.000Z';
const CUTOFF = '2026-01-01T00:00:00.000Z';

beforeAll(async () => {
  cluster = await startEmbeddedPostgres();
  db = await openCentralDatabase(cluster.databaseUrl);
  retention = new CentralRetentionService(db.pool);
  ingest = new IngestService(db.pool);
  await retention.ensureMonthlyPartitions();
}, 90_000);
afterAll(async () => {
  await retention?.stop();
  await db?.close();
  await cluster?.stop();
});

async function seed(
  projectId: string,
  rows: { type: string; old?: boolean; mirrored?: boolean }[],
) {
  let seq = 0;
  const refs: { event: EventEnvelope; seq: number; receivedAt: string }[] = [];
  for (const row of rows) {
    seq += 1;
    const receivedAt = row.old === false ? '2099-01-01T00:00:00.000Z' : OLD;
    const payloads: Record<string, Record<string, unknown>> = {
      'tool.post': { tool_name: 'Read', success: true, output_excerpt: 'héllo' },
      'tool.pre': { tool_name: 'Read', tool_input_summary: { index: seq } },
      'session.status': { status: 'idle' },
      'command.executed': { command_display: 'pwd', exit_code: 0 },
      'task.created': { version: 0 },
      'commit.created': { oid: 'a'.repeat(40), branch: 'main', parents: [] },
    };
    const event: EventEnvelope = {
      v: 1,
      event_id: ulid(),
      device_id: makeId('device'),
      project_id: projectId,
      ts: row.old === false ? OLD : '2099-01-01T00:00:00.000Z',
      type: row.type,
      actor: { user_id: 'user_test', agent: null },
      privacy: 'metadata',
      payload: payloads[row.type] ?? { text: 'héllo', index: seq },
    };
    await db.pool.query(
      `INSERT INTO events(event_id,v,device_id,project_id,global_seq,ts,received_at,type,actor,payload,privacy)
       VALUES($1,1,$2,$3,$4,$5,$6,$7,$8,$9,'metadata')`,
      [
        event.event_id,
        event.device_id,
        projectId,
        seq,
        event.ts,
        receivedAt,
        event.type,
        JSON.stringify(event.actor),
        JSON.stringify(event.payload),
      ],
    );
    if (row.mirrored)
      await db.pool.query(
        `INSERT INTO coordination_events(event_id,v,device_id,project_id,global_seq,ts,received_at,type,actor,payload,privacy)
       VALUES($1,1,$2,$3,$4,$5,$6,$7,$8,$9,'metadata')`,
        [
          event.event_id,
          event.device_id,
          projectId,
          seq,
          event.ts,
          receivedAt,
          event.type,
          JSON.stringify(event.actor),
          JSON.stringify(event.payload),
        ],
      );
    refs.push({ event, seq, receivedAt });
  }
  await db.pool.query(
    'INSERT INTO project_stream_seq(project_id,last_seq,min_seq) VALUES($1,$2,0) ON CONFLICT(project_id) DO UPDATE SET last_seq=GREATEST(project_stream_seq.last_seq,$2)',
    [projectId, seq],
  );
  return refs;
}
async function input(projectId: string, batchLimit = 100) {
  const preview = await retention.preview(projectId, { cutoff: CUTOFF, batchLimit });
  return {
    projectId,
    runId: `ret_${ulid()}`,
    fingerprint: preview.fingerprint,
    cutoff: CUTOFF,
    policy: preview.policy,
    confirm: true as const,
  };
}
async function count(sql: string, params: unknown[] = []): Promise<number> {
  return Number((await db.pool.query(sql, params)).rows[0].c);
}

describe('central retention (real Postgres 16)', () => {
  it('previews without writes, uses received_at, and reports exact labeled exclusions', async () => {
    const p = makeId('project');
    await seed(p, [
      { type: 'tool.post' },
      { type: 'task.created', mirrored: true },
      { type: 'future.unknown' },
      { type: 'tool.pre', old: false },
      { type: 'tool.post' },
    ]);
    const before = await count('SELECT count(*) AS c FROM event_receipts');
    const preview = await retention.preview(p, { cutoff: CUTOFF, batchLimit: 1 });
    expect(preview.dryRun).toBe(true);
    expect(preview.eligibleRows).toBe(2);
    expect(preview.selectedRows).toBe(1);
    expect(preview.selectedPayloadBytes).toBeGreaterThan(0);
    expect(preview.ranges).toEqual([{ sequenceKind: 'global_seq', seqStart: 1, seqEnd: 1 }]);
    expect(preview.exclusions.protectedCoordination).toBe(1);
    expect(preview.exclusions.protectedUnknown).toBe(1);
    expect(preview.exclusions.tooNew).toBe(1);
    expect(preview.measurements.payloadBytes.label).toBe('exact');
    expect(preview.measurements.storedTupleEstimateBytes.label).toBe('estimate');
    expect(await count('SELECT count(*) AS c FROM event_receipts')).toBe(before);
  });

  it('atomically deletes exact keys, preserves protected gaps, mirrors no summary, and replays original refs', async () => {
    const p = makeId('project');
    const rows = await seed(p, [
      { type: 'tool.post' },
      { type: 'task.created', mirrored: true },
      { type: 'tool.pre' },
      { type: 'commit.created', mirrored: true },
      { type: 'command.executed' },
      { type: 'future.unknown' },
    ]);
    const protectedHash = JSON.stringify(
      (
        await db.pool.query(
          'SELECT * FROM coordination_events WHERE project_id=$1 ORDER BY global_seq',
          [p],
        )
      ).rows,
    );
    const apply = await input(p);
    const result = await retention.apply(apply);
    expect(result.committed).toBe(true);
    expect(result.selectedRows).toBe(3);
    expect(result.ranges).toEqual([
      { sequenceKind: 'global_seq', seqStart: 1, seqEnd: 1 },
      { sequenceKind: 'global_seq', seqStart: 3, seqEnd: 3 },
      { sequenceKind: 'global_seq', seqStart: 5, seqEnd: 5 },
    ]);
    expect(await count('SELECT count(*) AS c FROM events WHERE project_id=$1', [p])).toBe(6); // 3 protected + 3 summaries
    expect(await count('SELECT count(*) AS c FROM event_receipts WHERE project_id=$1', [p])).toBe(
      3,
    );
    expect(await count('SELECT count(*) AS c FROM retention_ranges WHERE project_id=$1', [p])).toBe(
      3,
    );
    expect(await count('SELECT count(*) AS c FROM event_summaries WHERE project_id=$1', [p])).toBe(
      3,
    );
    expect(
      await count(
        `SELECT count(*) AS c FROM coordination_events WHERE project_id=$1 AND type='summary.compacted'`,
        [p],
      ),
    ).toBe(0);
    expect(
      JSON.stringify(
        (
          await db.pool.query(
            'SELECT * FROM coordination_events WHERE project_id=$1 ORDER BY global_seq',
            [p],
          )
        ).rows,
      ),
    ).toBe(protectedHash);
    const replay = await ingest.ingestBatch(
      rows.filter((_, i) => [0, 2, 4].includes(i)).map((r) => r.event),
    );
    expect(replay.accepted).toHaveLength(0);
    expect(replay.duplicates.map((r) => [r.event_id, r.global_seq, r.received_at]).sort()).toEqual(
      rows
        .filter((_, i) => [0, 2, 4].includes(i))
        .map((r) => [r.event.event_id, r.seq, r.receivedAt])
        .sort(),
    );
    expect(replay.streams[p].last_seq).toBe(9); // six originals + three summaries, no replay allocation
    expect(await count('SELECT count(*) AS c FROM events WHERE project_id=$1', [p])).toBe(6);
    expect(
      (
        await readAudit(
          { query: async (sql, params) => ({ rows: (await db.pool.query(sql, params)).rows }) },
          p,
        )
      ).some((r) => r.action === 'retention.applied'),
    ).toBe(true);
  });

  it('is idempotent per run, rejects conflicts and stale previews without writes', async () => {
    const p = makeId('project');
    await seed(p, [{ type: 'tool.post' }, { type: 'tool.pre' }]);
    const apply = await input(p);
    const first = await retention.apply(apply);
    const again = await retention.apply(apply);
    expect(again.idempotent).toBe(true);
    expect(again.summaryEventIds).toEqual(first.summaryEventIds);
    expect(again.remainingAfterBatch).toBe(first.remainingAfterBatch);
    expect(again.exclusions).toEqual(first.exclusions);
    await expect(
      retention.apply({ ...apply, cutoff: '2025-01-01T00:00:00.000Z' }),
    ).rejects.toMatchObject({ code: 'validation' });
    await expect(retention.apply({ ...apply, fingerprint: '0'.repeat(64) })).rejects.toMatchObject({
      code: 'run_conflict',
    });
    const p2 = makeId('project');
    await seed(p2, [{ type: 'tool.post' }]);
    const stale = await input(p2);
    await seed(p2, [{ type: 'tool.pre' }]);
    const before = await count('SELECT count(*) AS c FROM retention_runs');
    await expect(retention.apply(stale)).rejects.toMatchObject({ code: 'stale_preview' });
    expect(await count('SELECT count(*) AS c FROM retention_runs')).toBe(before);

    const p3 = makeId('project');
    await seed(p3, [{ type: 'tool.post' }]);
    const edited = await input(p3);
    await db.pool.query(`UPDATE events SET actor=$1::jsonb, privacy='full' WHERE project_id=$2`, [
      JSON.stringify({ system: 'edited-after-preview' }),
      p3,
    ]);
    await expect(retention.apply(edited)).rejects.toMatchObject({ code: 'stale_preview' });
    expect(await count('SELECT count(*) AS c FROM retention_runs')).toBe(before);
  });

  it('replays an offset cutoff idempotently after Postgres normalizes the timestamp', async () => {
    const p = makeId('project');
    await seed(p, [{ type: 'tool.post' }]);
    const cutoff = '2026-01-01T01:00:00+01:00';
    const preview = await retention.preview(p, { cutoff });
    const apply = {
      projectId: p,
      runId: `ret_${ulid()}`,
      fingerprint: preview.fingerprint,
      cutoff,
      policy: preview.policy,
      confirm: true as const,
    };
    const first = await retention.apply(apply);
    const replay = await retention.apply(apply);
    expect(replay.idempotent).toBe(true);
    expect(replay.committedAt).toBe(first.committedAt);
    expect(replay.summaryEventIds).toEqual(first.summaryEventIds);
  });

  it('rolls back deletion, summaries, receipts, ranges, sequence and audit on evidence failure', async () => {
    const p = makeId('project');
    await seed(p, [{ type: 'tool.post' }, { type: 'tool.pre' }]);
    const apply = await input(p);
    await db.pool
      .query(
        `CREATE TRIGGER fail_retention_audit BEFORE INSERT ON audit_records
      FOR EACH ROW WHEN (NEW.action='retention.applied') EXECUTE FUNCTION fail_retention_audit()`,
      )
      .catch(() => {});
    await db.pool.query(
      `CREATE OR REPLACE FUNCTION fail_retention_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit failure'; END $$`,
    );
    // Function must exist before trigger creation; replace the harmless no-op trigger.
    await db.pool.query('DROP TRIGGER IF EXISTS fail_retention_audit ON audit_records');
    await db.pool.query(`CREATE TRIGGER fail_retention_audit BEFORE INSERT ON audit_records
      FOR EACH ROW WHEN (NEW.action='retention.applied') EXECUTE FUNCTION fail_retention_audit()`);
    await expect(retention.apply(apply)).rejects.toThrow('audit failure');
    expect(await count('SELECT count(*) AS c FROM events WHERE project_id=$1', [p])).toBe(2);
    expect(await count('SELECT count(*) AS c FROM event_receipts WHERE project_id=$1', [p])).toBe(
      0,
    );
    expect(await count('SELECT count(*) AS c FROM retention_runs WHERE project_id=$1', [p])).toBe(
      0,
    );
    expect(
      Number(
        (await db.pool.query('SELECT last_seq FROM project_stream_seq WHERE project_id=$1', [p]))
          .rows[0].last_seq,
      ),
    ).toBe(2);
    await db.pool.query('DROP TRIGGER fail_retention_audit ON audit_records');
  });

  it('serializes concurrent ingest and compaction without losing or resurrecting rows', async () => {
    const p = makeId('project');
    const old = await seed(p, [{ type: 'tool.post' }, { type: 'tool.pre' }]);
    const apply = await input(p);
    const fresh: EventEnvelope = {
      ...old[0]!.event,
      event_id: ulid(),
      ts: new Date().toISOString(),
    };
    const [compacted, received] = await Promise.all([
      retention.apply(apply),
      ingest.ingestBatch([fresh]),
    ]);
    expect(compacted.selectedRows).toBe(2);
    expect(received.accepted).toHaveLength(1);
    expect(
      await count('SELECT count(*) AS c FROM events WHERE project_id=$1 AND event_id=$2', [
        p,
        fresh.event_id,
      ]),
    ).toBe(1);
    expect(
      await count(
        "SELECT count(*) AS c FROM events WHERE project_id=$1 AND type IN ('tool.post','tool.pre')",
        [p],
      ),
    ).toBe(1);
  });

  it('locks before replay lookup so a replay queued behind compaction cannot resurrect its hot row', async () => {
    const p = makeId('project');
    const old = await seed(p, [{ type: 'tool.post' }]);
    const apply = await input(p);
    const lock = await db.pool.connect();
    try {
      await lock.query('BEGIN');
      await lock.query('SELECT last_seq FROM project_stream_seq WHERE project_id=$1 FOR UPDATE', [
        p,
      ]);
      const applying = retention.apply(apply);
      await new Promise<void>((resolve) => setImmediate(resolve));
      const replaying = ingest.ingestBatch([old[0]!.event]);
      await new Promise<void>((resolve) => setImmediate(resolve));
      await lock.query('COMMIT');
      const [compacted, replay] = await Promise.all([applying, replaying]);
      expect(compacted.selectedRows).toBe(1);
      expect(replay.accepted).toHaveLength(0);
      expect(replay.duplicates).toEqual([
        { event_id: old[0]!.event.event_id, global_seq: 1, received_at: OLD },
      ]);
      expect(
        await count('SELECT count(*) AS c FROM events WHERE project_id=$1 AND event_id=$2', [
          p,
          old[0]!.event.event_id,
        ]),
      ).toBe(0);
      expect(await count('SELECT count(*) AS c FROM event_receipts WHERE project_id=$1', [p])).toBe(
        1,
      );
    } finally {
      await lock.query('ROLLBACK').catch(() => undefined);
      lock.release();
    }
  });

  it('enforces one project, bounded batches and safe prefix min_seq', async () => {
    const p = makeId('project');
    await seed(p, [{ type: 'tool.post' }, { type: 'tool.pre' }, { type: 'session.status' }]);
    const apply = await input(p, 2);
    await retention.apply(apply);
    const cursor = (
      await db.pool.query('SELECT last_seq,min_seq FROM project_stream_seq WHERE project_id=$1', [
        p,
      ])
    ).rows[0];
    expect(cursor.min_seq).toBe(3);
    expect(cursor.last_seq).toBe(4);
    await expect(retention.apply({ ...apply, projectId: makeId('project') })).rejects.toMatchObject(
      { code: 'stale_preview' },
    );
    const status = await retention.status(p);
    expect(status.partitions.defaultRetained).toBe(true);
    expect(status.partitions.destructiveOperations).toBe(false);
    expect(status.byteMetrics.freePagesBytes.label).toBe('unavailable');
  });

  it('creates current/next monthly partitions idempotently and retains default', async () => {
    const first = await retention.ensureMonthlyPartitions(new Date('2026-11-25T12:00:00Z'));
    const second = await retention.ensureMonthlyPartitions(new Date('2026-11-25T12:00:00Z'));
    expect(first).toEqual(second);
    expect(first).toEqual(
      expect.arrayContaining(['events_2026_11', 'events_2026_12', 'events_default']),
    );
    const children = await count(
      `SELECT count(*) AS c FROM pg_inherits WHERE inhparent='events'::regclass`,
    );
    expect(children).toBe(3);
  });
});
