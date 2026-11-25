import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  makeId,
  ulid,
  PROTOCOL_VERSION,
  canonicalConflictKey,
  type EventEnvelope,
  type ConflictKind,
  type ConflictSeverity,
} from '@weft/protocol';
import { openCentralDatabase, type CentralDatabase } from './db.js';
import { ConflictService, ConflictError, type DetectConflictInput } from './conflicts-service.js';
import { IngestService } from './ingest.js';
import type { Origin } from './tasks-service.js';
import { startEmbeddedPostgres, type EmbeddedCluster } from '../test/embedded.js';
import { seedWorld, type World } from '../test/identity.js';

let cluster: EmbeddedCluster;
let db: CentralDatabase;
let conflicts: ConflictService;
let ingest: IngestService;
let world: World;
let origin: Origin;
const serverDeviceId = makeId('device');

beforeAll(async () => {
  cluster = await startEmbeddedPostgres();
  db = await openCentralDatabase(cluster.databaseUrl);
  world = await seedWorld(db.pool);
  conflicts = new ConflictService(db.pool, serverDeviceId);
  ingest = new IngestService(db.pool, undefined, conflicts);
  origin = { actor: { user_id: world.memberUser, agent: null }, deviceId: world.deviceId };
}, 120_000);

afterAll(async () => {
  await db?.close();
  await cluster?.stop();
});

interface DetectionOpts {
  projectId?: string;
  deviceId?: string;
  repoId?: string;
  kind?: ConflictKind;
  severity?: ConflictSeverity;
  taskIds?: string[];
  paths?: string[];
  epoch?: number;
  evidence?: Record<string, unknown>[];
  /** A bogus client-supplied key the server must ignore and recompute. */
  advisoryKey?: string;
}

/** Build a daemon-shaped conflict.detected envelope (mirrors ConflictDetector.emitConflict). */
function detectionEnvelope(opts: DetectionOpts = {}): EventEnvelope {
  const deviceId = opts.deviceId ?? makeId('device');
  const kind = opts.kind ?? 'textual';
  const taskIds = opts.taskIds ?? [makeId('task')];
  const paths = opts.paths ?? ['src/a.ts'];
  const repoId = opts.repoId ?? makeId('repo');
  const key = opts.advisoryKey ?? canonicalConflictKey(kind, taskIds, paths);
  return {
    v: PROTOCOL_VERSION,
    event_id: ulid(),
    device_id: deviceId,
    project_id: opts.projectId ?? world.projectA,
    repo_id: repoId,
    ts: new Date().toISOString(),
    type: 'conflict.detected',
    actor: { user_id: world.memberUser, agent: null },
    privacy: 'metadata',
    payload: {
      canonical_key: key,
      kind,
      severity: opts.severity ?? 'blocking',
      state: 'open',
      detection_epoch: opts.epoch ?? 0,
      task_ids: taskIds,
      paths,
      repo_id: repoId,
      evidence: opts.evidence ?? [{ kind: 'merge-tree', detector_device_id: deviceId }],
    },
  };
}

async function serverEmitted(repoId: string, type = 'conflict.detected'): Promise<number> {
  const r = await db.pool.query(
    `SELECT COUNT(*)::int AS c FROM coordination_events
       WHERE repo_id=$1 AND device_id=$2 AND type=$3`,
    [repoId, serverDeviceId, type],
  );
  return r.rows[0].c as number;
}

describe('server-authoritative conflicts (real Postgres 16)', () => {
  it('collapses two devices detecting one logical conflict into one card with unioned evidence', async () => {
    const repoId = makeId('repo');
    const taskIds = [makeId('task'), makeId('task')].sort();
    const paths = ['src/shared.ts'];
    const deviceA = makeId('device');
    const deviceB = makeId('device');
    const res = await ingest.ingestBatch([
      detectionEnvelope({
        deviceId: deviceA,
        repoId,
        taskIds,
        paths,
        kind: 'file_overlap',
        severity: 'warning',
        evidence: [
          { kind: 'diff-overlap', detector_device_id: deviceA, branch_a: 'a', branch_b: 'b' },
        ],
      }),
      detectionEnvelope({
        deviceId: deviceB,
        repoId,
        taskIds,
        paths,
        kind: 'file_overlap',
        severity: 'warning',
        evidence: [
          { kind: 'diff-overlap', detector_device_id: deviceB, branch_a: 'a', branch_b: 'b' },
        ],
      }),
    ]);
    expect(res.rejected).toHaveLength(0);
    expect(res.accepted).toHaveLength(2);

    const cards = await conflicts.list(world.projectA, { repoId });
    expect(cards).toHaveLength(1);
    const card = cards[0];
    if (!card) throw new Error('expected one card');
    expect(card.canonical_key).toBe(canonicalConflictKey('file_overlap', taskIds, paths));
    expect(card.state).toBe('open');
    expect(card.reopen_count).toBe(0);
    // Evidence is unioned append-only and attributed to both detectors.
    expect(card.evidence).toHaveLength(2);
    expect(card.evidence.map((e) => e.detector_device_id).sort()).toEqual(
      [deviceA, deviceB].sort(),
    );
    // Exactly one server fan-out (the create); the second detection only unioned.
    expect(await serverEmitted(repoId)).toBe(1);
  });

  it('does not flap state or re-emit on same-epoch re-detection', async () => {
    const repoId = makeId('repo');
    const taskIds = [makeId('task')];
    const paths = ['src/x.ts'];
    await ingest.ingestBatch([detectionEnvelope({ repoId, taskIds, paths })]);
    const card = (await conflicts.list(world.projectA, { repoId }))[0];
    if (!card) throw new Error('expected a card');

    // Re-ship identical content under a fresh event_id (a different sweep).
    await ingest.ingestBatch([
      detectionEnvelope({ repoId, taskIds, paths, evidence: card.evidence }),
    ]);
    const after = await conflicts.list(world.projectA, { repoId });
    expect(after).toHaveLength(1);
    const again = after[0];
    if (!again) throw new Error('expected the same card');
    expect(again.id).toBe(card.id);
    expect(again.state).toBe('open');
    expect(again.reopen_count).toBe(0);
    expect(again.evidence).toHaveLength(card.evidence.length);
    expect(await serverEmitted(repoId)).toBe(1); // no second fan-out
    const history = await conflicts.history(card.id, world.projectA);
    expect(history.map((h) => h.type)).toEqual(['detected']); // pure replay wrote nothing
  });

  it('reopens a resolved card only in a strictly later epoch, with linked history', async () => {
    const repoId = makeId('repo');
    const taskIds = [makeId('task')];
    const paths = ['src/y.ts'];
    await ingest.ingestBatch([detectionEnvelope({ repoId, taskIds, paths, epoch: 1 })]);
    const card = (await conflicts.list(world.projectA, { repoId }))[0];
    if (!card) throw new Error('expected a card');
    expect(card.detection_epoch).toBe(1);

    const resolved = await conflicts.resolve(card.id, world.projectA, origin, 'merged manually');
    expect(resolved.state).toBe('resolved');
    expect(resolved.resolved_by).toBe(world.memberUser);
    expect(resolved.resolved_at).not.toBeNull();

    // Same epoch must NOT reopen — it only unions evidence, preserving resolution.
    await ingest.ingestBatch([
      detectionEnvelope({
        repoId,
        taskIds,
        paths,
        epoch: 1,
        evidence: [{ kind: 'merge-tree', detector_device_id: 'dev_same' }],
      }),
    ]);
    const still = await conflicts.get(card.id, world.projectA);
    expect(still?.state).toBe('resolved');
    expect(still?.reopen_count).toBe(0);
    expect(await serverEmitted(repoId)).toBe(1); // still only the original create

    // A strictly later epoch reopens once and records the prior state.
    await ingest.ingestBatch([
      detectionEnvelope({
        repoId,
        taskIds,
        paths,
        epoch: 2,
        evidence: [{ kind: 'merge-tree', detector_device_id: 'dev_later' }],
      }),
    ]);
    const reopened = await conflicts.get(card.id, world.projectA);
    expect(reopened?.state).toBe('open');
    expect(reopened?.reopen_count).toBe(1);
    expect(reopened?.detection_epoch).toBe(2);
    expect(reopened?.resolved_by).toBeNull();
    expect(reopened?.resolved_at).toBeNull();
    expect(await serverEmitted(repoId)).toBe(2); // create + one reopen fan-out

    const history = await conflicts.history(card.id, world.projectA);
    const reopenEvent = history.find((h) => h.type === 'reopened');
    expect(reopenEvent).toBeTruthy();
    expect(reopenEvent?.payload).toMatchObject({
      previous_state: 'resolved',
      previous_epoch: 1,
      new_epoch: 2,
    });
    expect(reopenEvent?.detection_epoch).toBe(2);
    expect(history.map((h) => h.type)).toContain('resolved');
  });

  it('recomputes the canonical key, ignoring a client advisory key and task order', async () => {
    const repoId = makeId('repo');
    const taskIds = [makeId('task'), makeId('task')];
    const paths = ['src/z.ts'];
    await ingest.ingestBatch([
      detectionEnvelope({ repoId, taskIds, paths, advisoryKey: 'bogus-A' }),
      detectionEnvelope({ repoId, taskIds: [...taskIds].reverse(), paths, advisoryKey: 'bogus-B' }),
    ]);
    const cards = await conflicts.list(world.projectA, { repoId });
    expect(cards).toHaveLength(1);
    expect(cards[0]?.canonical_key).toBe(canonicalConflictKey('textual', taskIds, paths));
    expect(cards[0]?.canonical_key).not.toBe('bogus-A');
    expect(cards[0]?.task_ids).toEqual([...taskIds].sort());
  });

  it('isolates cards per project even for an identical canonical key', async () => {
    const repoId = makeId('repo');
    const taskIds = [makeId('task')];
    const paths = ['src/iso.ts'];
    await ingest.ingestBatch([
      detectionEnvelope({ projectId: world.projectA, repoId, taskIds, paths }),
    ]);
    await ingest.ingestBatch([
      detectionEnvelope({ projectId: world.projectB, repoId, taskIds, paths }),
    ]);
    const a = await conflicts.list(world.projectA, { repoId });
    const b = await conflicts.list(world.projectB, { repoId });
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0]?.canonical_key).toBe(b[0]?.canonical_key);
    expect(a[0]?.id).not.toBe(b[0]?.id);
    const idA = a[0]?.id;
    if (!idA) throw new Error('expected card A');
    expect(await conflicts.get(idA, world.projectB)).toBeUndefined();
  });

  it('resolve and dismiss are idempotent and write a single history entry', async () => {
    const repoId = makeId('repo');
    await ingest.ingestBatch([detectionEnvelope({ repoId })]);
    const card = (await conflicts.list(world.projectA, { repoId }))[0];
    if (!card) throw new Error('expected a card');

    const r1 = await conflicts.resolve(card.id, world.projectA, origin, 'note');
    const r2 = await conflicts.resolve(card.id, world.projectA, origin, 'note again');
    expect(r2.state).toBe('resolved');
    expect(r2.resolved_at).toBe(r1.resolved_at); // second call is a no-op
    expect(
      (await conflicts.history(card.id, world.projectA)).filter((h) => h.type === 'resolved'),
    ).toHaveLength(1);
    expect(await serverEmitted(repoId, 'conflict.resolved')).toBe(1);

    const dismissRepo = makeId('repo');
    await ingest.ingestBatch([detectionEnvelope({ repoId: dismissRepo })]);
    const dCard = (await conflicts.list(world.projectA, { repoId: dismissRepo }))[0];
    if (!dCard) throw new Error('expected a card');
    const d1 = await conflicts.dismiss(dCard.id, world.projectA, origin, 'false positive');
    expect(d1.state).toBe('dismissed');
    const d2 = await conflicts.dismiss(dCard.id, world.projectA, origin);
    expect(d2.resolved_at).toBe(d1.resolved_at);
    expect(await serverEmitted(dismissRepo, 'conflict.dismissed')).toBe(1);
  });

  it('serializes concurrent detect RPCs for one logical conflict into a single card', async () => {
    const repoId = makeId('repo');
    const taskIds = [makeId('task')];
    const paths = ['src/race.ts'];
    const devices = Array.from({ length: 5 }, () => makeId('device'));
    const results = await Promise.all(
      devices.map((d) =>
        conflicts.detect(
          world.projectA,
          {
            repo_id: repoId,
            kind: 'textual',
            task_ids: taskIds,
            paths,
            severity: 'blocking',
            evidence: [{ kind: 'merge-tree', detector_device_id: d }],
          },
          { actor: { user_id: world.memberUser, agent: null }, deviceId: d },
        ),
      ),
    );
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    const cards = await conflicts.list(world.projectA, { repoId });
    expect(cards).toHaveLength(1);
    expect(cards[0]?.evidence).toHaveLength(5);
    expect(cards[0]?.reopen_count).toBe(0);
    expect(await serverEmitted(repoId)).toBe(1);
  });

  it('detect RPC validates input and reports not_found for unknown cards', async () => {
    const repoId = makeId('repo');
    const input: DetectConflictInput = {
      repo_id: repoId,
      kind: 'textual',
      task_ids: [makeId('task')],
      paths: ['src/r.ts'],
      severity: 'blocking',
      evidence: [{ kind: 'merge-tree' }],
    };
    const card = await conflicts.detect(world.projectA, input, origin);
    expect(card.state).toBe('open');
    expect(card.repo_id).toBe(repoId);
    await expect(
      conflicts.detect(world.projectA, { ...input, task_ids: [] }, origin),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(await conflicts.get(makeId('conflict'), world.projectA)).toBeUndefined();
    await expect(
      conflicts.resolve(makeId('conflict'), world.projectA, origin),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(conflicts.history(makeId('conflict'), world.projectA)).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('property: any number of devices detecting one logical conflict yields exactly one card', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 2, max: 6 }),
        fc.constantFrom<ConflictKind>('textual', 'file_overlap', 'symbol_overlap'),
        async (deviceCount, kind) => {
          const repoId = makeId('repo');
          const taskIds = [makeId('task'), makeId('task')].sort();
          const paths = ['src/prop.ts'];
          const devices = Array.from({ length: deviceCount }, () => makeId('device'));
          const envs = devices.map((d) =>
            detectionEnvelope({
              deviceId: d,
              repoId,
              taskIds,
              paths,
              kind,
              severity: kind === 'textual' ? 'blocking' : 'warning',
              evidence: [{ kind: 'detector', detector_device_id: d }],
            }),
          );
          // Concurrent separate batches exercise cross-transaction dedup + locking.
          await Promise.all(envs.map((env) => ingest.ingestBatch([env])));
          const cards = await conflicts.list(world.projectA, { repoId });
          expect(cards).toHaveLength(1);
          expect(cards[0]?.canonical_key).toBe(canonicalConflictKey(kind, taskIds, paths));
          expect(cards[0]?.evidence).toHaveLength(deviceCount);
          expect(cards[0]?.reopen_count).toBe(0);
          expect(cards[0]?.state).toBe('open');
          expect(await serverEmitted(repoId)).toBe(1);
        },
      ),
      { numRuns: 12 },
    );
  }, 60_000);
});
