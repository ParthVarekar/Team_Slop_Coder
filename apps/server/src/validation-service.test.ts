import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeId, ulid, PROTOCOL_VERSION, type EventEnvelope } from '@weft/protocol';
import { openCentralDatabase, type CentralDatabase } from './db.js';
import { ValidationService } from './validation-service.js';
import { IngestService } from './ingest.js';
import { TaskService, TaskError, type Origin } from './tasks-service.js';
import { startEmbeddedPostgres, type EmbeddedCluster } from '../test/embedded.js';
import { seedWorld, type World } from '../test/identity.js';

let cluster: EmbeddedCluster;
let db: CentralDatabase;
let validation: ValidationService;
let ingest: IngestService;
let tasks: TaskService;
let world: World;
let origin: Origin;

const CANDIDATE = 'a'.repeat(40);
const TREE = 'b'.repeat(40);
const DIGEST = 'c'.repeat(64);

beforeAll(async () => {
  cluster = await startEmbeddedPostgres();
  db = await openCentralDatabase(cluster.databaseUrl);
  world = await seedWorld(db.pool);
  validation = new ValidationService(db.pool);
  ingest = new IngestService(db.pool, undefined, undefined, validation);
  tasks = new TaskService(db.pool);
  origin = { actor: { user_id: world.memberUser, agent: null }, deviceId: world.deviceId };
}, 120_000);

afterAll(async () => {
  await db?.close();
  await cluster?.stop();
});

interface EnvOpts {
  projectId?: string;
  deviceId?: string;
  repoId?: string;
  taskId?: string;
  sessionId?: string;
}

function envelope(type: string, payload: Record<string, unknown>, o: EnvOpts = {}): EventEnvelope {
  return {
    v: PROTOCOL_VERSION,
    event_id: ulid(),
    device_id: o.deviceId ?? world.deviceId,
    project_id: o.projectId ?? world.projectA,
    ...(o.repoId ? { repo_id: o.repoId } : {}),
    ...(o.taskId ? { task_id: o.taskId } : {}),
    ...(o.sessionId ? { session_id: o.sessionId } : {}),
    ts: new Date().toISOString(),
    type,
    actor: { user_id: world.memberUser, agent: null },
    privacy: 'metadata',
    payload,
  };
}

function started(runId: string, o: EnvOpts = {}): EventEnvelope {
  return envelope(
    'validation.started',
    {
      run_id: runId,
      trigger: 'task',
      candidate_oid: CANDIDATE,
      checks: ['typecheck'],
      selection: 'full',
      tree_oid: TREE,
      runner_device_id: o.deviceId ?? world.deviceId,
      claimant_device_id: o.deviceId ?? world.deviceId,
      independence: 'self',
    },
    o,
  );
}

interface CheckFields {
  check_id: string;
  exit_code: number;
  command_display?: string;
  log_excerpt?: string;
  log_digest?: string;
  duration_ms?: number;
  selection?: string;
  newly_failing?: boolean;
}

function check(runId: string, c: CheckFields, o: EnvOpts = {}): EventEnvelope {
  return envelope(
    'check.completed',
    {
      run_id: runId,
      check_id: c.check_id,
      exit_code: c.exit_code,
      duration_ms: c.duration_ms ?? 10,
      log_digest: c.log_digest ?? DIGEST,
      command_display: c.command_display ?? 'node -e process.exit(0)',
      log_excerpt: c.log_excerpt ?? 'ok',
      selection: c.selection ?? 'full',
      newly_failing: c.newly_failing ?? false,
    },
    o,
  );
}

function completed(
  runId: string,
  state: 'passed' | 'failed' | 'error',
  o: EnvOpts = {},
): EventEnvelope {
  return envelope(
    'validation.completed',
    {
      run_id: runId,
      state,
      candidate_oid: CANDIDATE,
      input_hash: DIGEST,
      cache_hit: false,
      tree_oid: TREE,
      runner_device_id: o.deviceId ?? world.deviceId,
      independence: 'self',
    },
    o,
  );
}

function claim(taskId: string, text: string, o: EnvOpts = {}): EventEnvelope {
  return envelope(
    'task.completion_claimed',
    { claim_text: text, evidence_state: 'unverified' },
    { ...o, taskId },
  );
}

describe('server validation projection (real Postgres 16)', () => {
  it('materializes a run, its checks, and completion atomically from one daemon batch', async () => {
    const runId = makeId('validation');
    const repoId = makeId('repo');
    const res = await ingest.ingestBatch([
      started(runId, { repoId }),
      check(
        runId,
        { check_id: 'typecheck', exit_code: 0, log_excerpt: 'all good', duration_ms: 12 },
        { repoId },
      ),
      completed(runId, 'passed', { repoId }),
    ]);
    expect(res.rejected).toHaveLength(0);
    expect(res.accepted).toHaveLength(3);

    const run = await validation.getRun(runId, world.projectA);
    expect(run).toBeTruthy();
    expect(run?.state).toBe('passed');
    expect(run?.repo_id).toBe(repoId);
    expect(run?.candidate_oid).toBe(CANDIDATE);
    expect(run?.tree_oid).toBe(TREE);
    expect(run?.independence).toBe('self');
    expect(run?.runner_device_id).toBe(world.deviceId);
    expect(run?.cache_hit).toBe(false);
    expect(run?.finished_at).not.toBeNull();
    expect(run?.checks).toHaveLength(1);
    const c = run?.checks[0];
    expect(c?.check_id).toBe('typecheck');
    expect(c?.exit_code).toBe(0);
    expect(c?.log_excerpt).toBe('all good');
    expect(c?.log_digest).toBe(DIGEST);
    expect(c?.duration_ms).toBe(12);
    expect(c?.selection).toBe('full');
    expect(c?.newly_failing).toBe(false);

    expect(await validation.listRuns(world.projectA, { repoId })).toHaveLength(1);
    expect(
      await validation.listRuns(world.projectA, {
        repoId,
        until: new Date(Date.parse(run!.started_at) - 1).toISOString(),
      }),
    ).toHaveLength(0);
    expect(
      await validation.listRuns(world.projectA, { repoId, until: run!.started_at }),
    ).toHaveLength(1);
    // The evidence is mirrored into the durable coordination trail.
    const coord = await db.pool.query(
      `SELECT type FROM coordination_events WHERE payload->>'run_id' = $1 ORDER BY global_seq`,
      [runId],
    );
    expect(coord.rows.map((r) => r.type)).toEqual([
      'validation.started',
      'check.completed',
      'validation.completed',
    ]);
  });

  it('tolerates check.completed arriving before started; real metadata still wins', async () => {
    const runId = makeId('validation');
    const repoId = makeId('repo');
    const res = await ingest.ingestBatch([
      check(runId, { check_id: 'typecheck', exit_code: 0 }, { repoId }),
      started(runId, { repoId }),
      completed(runId, 'passed', { repoId }),
    ]);
    expect(res.rejected).toHaveLength(0);
    const run = await validation.getRun(runId, world.projectA);
    expect(run?.trigger).toBe('task'); // started metadata overwrote the defensive shell
    expect(run?.candidate_oid).toBe(CANDIDATE);
    expect(run?.state).toBe('passed');
    expect(run?.checks).toHaveLength(1);
    expect(run?.checks[0].exit_code).toBe(0);
  });

  it('stores the -1 exit-code sentinel (timeout/spawn) as null', async () => {
    const runId = makeId('validation');
    const repoId = makeId('repo');
    await ingest.ingestBatch([
      started(runId, { repoId }),
      check(runId, { check_id: 'hang', exit_code: -1 }, { repoId }),
      completed(runId, 'error', { repoId }),
    ]);
    const run = await validation.getRun(runId, world.projectA);
    expect(run?.state).toBe('error');
    expect(run?.checks[0].exit_code).toBeNull();
  });

  it('redacts secrets in log_excerpt before persisting', async () => {
    const runId = makeId('validation');
    const repoId = makeId('repo');
    const secret = `ghp_${'a'.repeat(40)}`;
    await ingest.ingestBatch([
      started(runId, { repoId }),
      check(runId, { check_id: 'leak', exit_code: 0, log_excerpt: `pat=${secret}` }, { repoId }),
      completed(runId, 'passed', { repoId }),
    ]);
    const run = await validation.getRun(runId, world.projectA);
    expect(run?.checks[0].log_excerpt).not.toContain(secret);
    expect(run?.checks[0].log_excerpt).toContain('[REDACTED:');
  });

  it('preserves the newly_failing flag and a failed state', async () => {
    const runId = makeId('validation');
    const repoId = makeId('repo');
    await ingest.ingestBatch([
      started(runId, { repoId }),
      check(runId, { check_id: 'unit', exit_code: 1, newly_failing: true }, { repoId }),
      completed(runId, 'failed', { repoId }),
    ]);
    const run = await validation.getRun(runId, world.projectA);
    expect(run?.state).toBe('failed');
    expect(run?.checks[0].newly_failing).toBe(true);
    expect(await validation.listRuns(world.projectA, { repoId, state: 'failed' })).toHaveLength(1);
  });

  it('isolates runs per project even for the same repo', async () => {
    const repoId = makeId('repo');
    const runA = makeId('validation');
    const runB = makeId('validation');
    await ingest.ingestBatch([
      started(runA, { projectId: world.projectA, repoId }),
      completed(runA, 'passed', { projectId: world.projectA, repoId }),
      started(runB, { projectId: world.projectB, repoId }),
      completed(runB, 'passed', { projectId: world.projectB, repoId }),
    ]);
    expect(await validation.getRun(runA, world.projectB)).toBeUndefined();
    expect(await validation.getRun(runA, world.projectA)).toBeTruthy();
    expect(await validation.listRuns(world.projectA, { repoId })).toHaveLength(1);
    expect(await validation.listRuns(world.projectB, { repoId })).toHaveLength(1);
  });

  it('skips validation events for an unknown project without rolling back the batch', async () => {
    const unknownProject = makeId('project');
    const repoId = makeId('repo');
    const runUnknown = makeId('validation');
    const runKnown = makeId('validation');
    const res = await ingest.ingestBatch([
      started(runUnknown, { projectId: unknownProject, repoId }),
      completed(runUnknown, 'passed', { projectId: unknownProject, repoId }),
      started(runKnown, { projectId: world.projectA, repoId }),
      completed(runKnown, 'passed', { projectId: world.projectA, repoId }),
    ]);
    expect(res.rejected).toHaveLength(0);
    expect(res.accepted).toHaveLength(4); // events are durable even when projection skips
    expect(await validation.getRun(runUnknown, unknownProject)).toBeUndefined();
    expect(await validation.getRun(runKnown, world.projectA)).toBeTruthy();
  });
});

describe('completion claims: unverified evidence, never auto-completed', () => {
  it('materializes a daemon claim for a known task and skips an unknown task in the same batch', async () => {
    const repoId = makeId('repo');
    const task = await tasks.create(world.projectA, { title: 'Claim target' }, origin);
    const unknownTask = makeId('task');
    const secret = `ghp_${'a'.repeat(40)}`;
    const res = await ingest.ingestBatch([
      claim(task.id, `done ${secret}`, { repoId }),
      claim(unknownTask, 'nope', { repoId }),
    ]);
    expect(res.rejected).toHaveLength(0);
    expect(res.accepted).toHaveLength(2);

    const claims = await validation.listClaims(task.id, world.projectA);
    expect(claims).toHaveLength(1); // unknown-task skip did not roll back the known claim
    expect(claims[0]?.evidence_state).toBe('unverified');
    expect(claims[0]?.claim_text).not.toContain(secret);
    expect(claims[0]?.claim_text).toContain('[REDACTED:');
    expect(await validation.listClaims(unknownTask, world.projectA)).toHaveLength(0);
    // A claim never changes the task state.
    expect((await tasks.get(task.id, world.projectA))?.state).toBe('backlog');
  });

  it('RPC claim is unverified and completion stays blocked until a passing run is ingested', async () => {
    const task = await tasks.create(
      world.projectA,
      { title: 'Verify me', state: 'validation' },
      origin,
    );
    const secret = `ghp_${'b'.repeat(40)}`;
    const recorded = await tasks.claimCompletion(
      task.id,
      world.projectA,
      `finished ${secret}`,
      origin,
    );
    expect(recorded.evidence_state).toBe('unverified');
    expect(recorded.claim_text).not.toContain(secret);

    const after = await tasks.get(task.id, world.projectA);
    expect(after?.state).toBe('validation');
    expect(after?.version).toBe(0); // a claim does not bump the version
    expect(await tasks.listClaims(task.id, world.projectA)).toHaveLength(1);

    const blocked = await tasks
      .transition(task.id, world.projectA, 0, 'completed', undefined, origin)
      .catch((e: unknown) => e);
    expect(blocked).toBeInstanceOf(TaskError);
    expect(blocked).toMatchObject({ code: 'evidence_required' });

    // Daemon ships a passing run tied to this central task.
    const runId = makeId('validation');
    const repoId = makeId('repo');
    await ingest.ingestBatch([
      started(runId, { repoId, taskId: task.id }),
      check(runId, { check_id: 'typecheck', exit_code: 0 }, { repoId, taskId: task.id }),
      completed(runId, 'passed', { repoId, taskId: task.id }),
    ]);
    const run = await validation.getRun(runId, world.projectA);
    expect(run?.state).toBe('passed');
    expect(run?.task_id).toBe(task.id);

    const done = await tasks.transition(task.id, world.projectA, 0, 'completed', undefined, origin);
    expect(done.state).toBe('completed');
    expect(done.version).toBe(1);
  });

  it('a failed run does not satisfy the completion guard', async () => {
    const task = await tasks.create(
      world.projectA,
      { title: 'Failing', state: 'validation' },
      origin,
    );
    const runId = makeId('validation');
    const repoId = makeId('repo');
    await ingest.ingestBatch([
      started(runId, { repoId, taskId: task.id }),
      check(runId, { check_id: 'unit', exit_code: 1 }, { repoId, taskId: task.id }),
      completed(runId, 'failed', { repoId, taskId: task.id }),
    ]);
    await expect(
      tasks.transition(task.id, world.projectA, 0, 'completed', undefined, origin),
    ).rejects.toMatchObject({ code: 'evidence_required' });
  });
});
