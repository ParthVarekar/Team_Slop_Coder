import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  makeId,
  ulid,
  PROTOCOL_VERSION,
  isCoordinationEvent,
  type EventEnvelope,
} from '@weft/protocol';
import { openCentralDatabase, type CentralDatabase } from './db.js';
import { IngestService, MAX_INGEST_BATCH } from './ingest.js';
import { startEmbeddedPostgres, type EmbeddedCluster } from '../test/embedded.js';

let cluster: EmbeddedCluster;
let db: CentralDatabase;
let service: IngestService;

beforeAll(async () => {
  cluster = await startEmbeddedPostgres();
  db = await openCentralDatabase(cluster.databaseUrl);
  service = new IngestService(db.pool);
}, 90_000);

afterAll(async () => {
  await db?.close();
  await cluster?.stop();
});

const PAYLOADS: Record<string, Record<string, unknown>> = {
  'tool.post': { tool_name: 'Bash', success: true },
  'file.changed': { path: 'src/x.ts', change_kind: 'modify', source: 'agent_tool' },
  'task.claimed': { version: 0 },
  'commit.created': { oid: 'a1b2c3d4', branch: 'main', parents: [] },
};

function envelope(
  opts: { projectId?: string; deviceId?: string; type?: string; ts?: string } = {},
): EventEnvelope {
  const type = opts.type ?? 'tool.post';
  return {
    v: PROTOCOL_VERSION,
    event_id: ulid(),
    device_id: opts.deviceId ?? makeId('device'),
    project_id: opts.projectId ?? makeId('project'),
    ts: opts.ts ?? new Date().toISOString(),
    type,
    actor: { user_id: 'user_test', agent: null },
    privacy: 'metadata',
    payload: PAYLOADS[type] ?? { note: 'forward-compatible unknown type' },
  };
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function countEvents(projectId: string): Promise<number> {
  const r = await db.pool.query('SELECT COUNT(*)::int AS c FROM events WHERE project_id=$1', [
    projectId,
  ]);
  return r.rows[0].c as number;
}

describe('server ingest (real Postgres 16)', () => {
  it('assigns contiguous per-project global_seq in batch order', async () => {
    const projectId = makeId('project');
    const deviceId = makeId('device');
    const events = [
      envelope({ projectId, deviceId }),
      envelope({ projectId, deviceId }),
      envelope({ projectId, deviceId }),
    ];
    const res = await service.ingestBatch(events);
    expect(res.rejected).toHaveLength(0);
    expect(res.accepted.map((a) => a.event_id)).toEqual(events.map((e) => e.event_id));
    expect(res.accepted.map((a) => a.global_seq)).toEqual([1, 2, 3]);
    expect(res.streams[projectId]).toEqual({ last_seq: 3, min_seq: 0 });
    const rows = await db.pool.query(
      'SELECT event_id, global_seq FROM events WHERE project_id=$1 ORDER BY global_seq',
      [projectId],
    );
    expect(rows.rows.map((r) => Number(r.global_seq))).toEqual([1, 2, 3]);
  });

  it('treats a sequential replay as effectively-once (no new seq)', async () => {
    const projectId = makeId('project');
    const events = [envelope({ projectId }), envelope({ projectId })];
    await service.ingestBatch(events);
    const replay = await service.ingestBatch(events);
    expect(replay.accepted).toHaveLength(0);
    expect(replay.duplicates.map((d) => d.global_seq).sort((a, b) => a - b)).toEqual([1, 2]);
    expect(await countEvents(projectId)).toBe(2);
    const seq = await db.pool.query(
      'SELECT last_seq FROM project_stream_seq WHERE project_id=$1',
      [projectId],
    );
    expect(Number(seq.rows[0].last_seq)).toBe(2);
  });

  it('collapses intra-batch duplicates', async () => {
    const projectId = makeId('project');
    const e = envelope({ projectId });
    const res = await service.ingestBatch([e, e, e]);
    expect(res.accepted).toHaveLength(1);
    expect(res.duplicates).toHaveLength(2);
    expect(await countEvents(projectId)).toBe(1);
  });

  it('mirrors only coordination types into the never-expiring trail', async () => {
    const projectId = makeId('project');
    await service.ingestBatch([
      envelope({ projectId, type: 'tool.post' }),
      envelope({ projectId, type: 'file.changed' }),
      envelope({ projectId, type: 'task.claimed' }),
      envelope({ projectId, type: 'commit.created' }),
    ]);
    expect(await countEvents(projectId)).toBe(4);
    const coord = await db.pool.query(
      'SELECT type, global_seq FROM coordination_events WHERE project_id=$1 ORDER BY global_seq',
      [projectId],
    );
    expect(coord.rows.map((r) => r.type)).toEqual(['task.claimed', 'commit.created']);
    expect(coord.rows.map((r) => Number(r.global_seq))).toEqual([3, 4]);
  });

  it('keeps client ts immutable and orders late offline arrivals by receipt', async () => {
    const projectId = makeId('project');
    await service.ingestBatch([envelope({ projectId, ts: new Date().toISOString() })]);
    const before = Date.now();
    const old = envelope({ projectId, ts: '2020-01-01T00:00:00.000Z' });
    const res = await service.ingestBatch([old]);
    expect(res.accepted[0].global_seq).toBe(2);
    const row = await db.pool.query('SELECT ts, received_at FROM events WHERE event_id=$1', [
      old.event_id,
    ]);
    expect(new Date(row.rows[0].ts).toISOString()).toBe('2020-01-01T00:00:00.000Z');
    expect(new Date(row.rows[0].received_at).getTime()).toBeGreaterThanOrEqual(before);
  });

  it('isolates global_seq per project', async () => {
    const a = makeId('project');
    const b = makeId('project');
    await service.ingestBatch([envelope({ projectId: a }), envelope({ projectId: b }), envelope({ projectId: a })]);
    const sa = await db.pool.query('SELECT last_seq FROM project_stream_seq WHERE project_id=$1', [a]);
    const sb = await db.pool.query('SELECT last_seq FROM project_stream_seq WHERE project_id=$1', [b]);
    expect(Number(sa.rows[0].last_seq)).toBe(2);
    expect(Number(sb.rows[0].last_seq)).toBe(1);
  });

  it('rejects invalid envelopes but accepts valid ones in the same batch', async () => {
    const projectId = makeId('project');
    const good = envelope({ projectId });
    const bad = { ...envelope({ projectId }), ts: 'not-a-datetime' };
    const res = await service.ingestBatch([bad, good]);
    expect(res.accepted).toHaveLength(1);
    expect(res.accepted[0].event_id).toBe(good.event_id);
    expect(res.rejected).toHaveLength(1);
    expect(res.rejected[0].event_id).toBe(bad.event_id);
    expect(await countEvents(projectId)).toBe(1);
  });

  it('appends a tamper-evident audit record per ingested project', async () => {
    const projectId = makeId('project');
    await service.ingestBatch([envelope({ projectId }), envelope({ projectId })]);
    const audit = await db.pool.query(
      'SELECT action, subject, after_hash, actor FROM audit_records WHERE project_id=$1',
      [projectId],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].action).toBe('events.ingested');
    expect(audit.rows[0].after_hash).toHaveLength(64);
    expect(audit.rows[0].actor).toEqual({ system: 'weft-server' });
  });

  it('preserves the min_seq watermark (ingest never regresses it)', async () => {
    const projectId = makeId('project');
    await service.ingestBatch([envelope({ projectId })]);
    await db.pool.query('UPDATE project_stream_seq SET min_seq=1 WHERE project_id=$1', [projectId]);
    const res = await service.ingestBatch([envelope({ projectId })]);
    expect(res.streams[projectId]).toEqual({ last_seq: 2, min_seq: 1 });
  });

  it('rejects an oversized batch without persisting anything', async () => {
    const projectId = makeId('project');
    const tooMany = Array.from({ length: MAX_INGEST_BATCH + 1 }, () => envelope({ projectId }));
    const res = await service.ingestBatch(tooMany);
    expect(res.accepted).toHaveLength(0);
    expect(res.rejected).toHaveLength(1);
    expect(res.rejected[0].error).toContain(String(MAX_INGEST_BATCH));
    expect(await countEvents(projectId)).toBe(0);
  });

  it('property: concurrent at-least-once delivery is effectively-once with contiguous seqs', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            type: fc.constantFrom('tool.post', 'file.changed', 'task.claimed', 'commit.created'),
            replays: fc.integer({ min: 1, max: 3 }),
          }),
          { minLength: 1, maxLength: 20 },
        ),
        async (spec) => {
          const projectId = makeId('project');
          const deviceId = makeId('device');
          const events = spec.map((s) => envelope({ projectId, deviceId, type: s.type }));
          const deliveries = spec.flatMap((s, i) =>
            Array.from({ length: s.replays }, () => events[i]),
          );
          await Promise.all(chunk(deliveries, 5).map((b) => service.ingestBatch(b)));

          const rows = await db.pool.query(
            'SELECT event_id, global_seq FROM events WHERE project_id=$1',
            [projectId],
          );
          expect(rows.rows.length).toBe(events.length);
          const seqs = rows.rows.map((r) => Number(r.global_seq)).sort((a, b) => a - b);
          expect(seqs).toEqual(events.map((_, i) => i + 1));
          const coordExpected = events.filter((e) => isCoordinationEvent(e.type)).length;
          const coord = await db.pool.query(
            'SELECT COUNT(*)::int AS c FROM coordination_events WHERE project_id=$1',
            [projectId],
          );
          expect(coord.rows[0].c).toBe(coordExpected);
        },
      ),
      { numRuns: 25 },
    );
  }, 40_000);

  it('property: repeated sequential delivery converges to a single durable copy', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom('tool.post', 'task.claimed', 'commit.created'), {
          minLength: 1,
          maxLength: 10,
        }),
        fc.integer({ min: 2, max: 5 }),
        async (types, times) => {
          const projectId = makeId('project');
          const events = types.map((t) => envelope({ projectId, type: t }));
          let last = await service.ingestBatch(events);
          for (let i = 1; i < times; i++) last = await service.ingestBatch(events);
          expect(await countEvents(projectId)).toBe(events.length);
          expect(last.accepted).toHaveLength(0);
          expect(last.duplicates).toHaveLength(events.length);
        },
      ),
      { numRuns: 20 },
    );
  }, 40_000);
});