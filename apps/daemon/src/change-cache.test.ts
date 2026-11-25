import { beforeEach, describe, expect, it } from 'vitest';
import { makeId, ulid, PROTOCOL_VERSION, type Actor, type StoredEvent } from '@weft/protocol';
import { ChangeCache } from './change-cache.js';

const deviceId = makeId('device');
const projectId = makeId('project');
const repoId = makeId('repo');
const otherRepo = makeId('repo');
const taskA = makeId('task');
const taskB = makeId('task');

const human: Actor = { user_id: 'user_test', agent: null };
const agent: Actor = {
  user_id: 'user_test',
  agent: { provider: 'claude-code', adapter: 'claude-code' },
};

let counter = 0;
function stored(
  type: string,
  payload: Record<string, unknown>,
  opts: { actor?: Actor; taskId?: string; repoId?: string; globalSeq?: number } = {},
): StoredEvent {
  counter += 1;
  const iso = new Date().toISOString();
  return {
    v: PROTOCOL_VERSION,
    event_id: ulid(),
    device_id: deviceId,
    project_id: projectId,
    ...(opts.repoId ? { repo_id: opts.repoId } : {}),
    ...(opts.taskId ? { task_id: opts.taskId } : {}),
    ts: iso,
    type,
    actor: opts.actor ?? human,
    privacy: 'metadata',
    payload,
    global_seq: opts.globalSeq ?? counter,
    received_at: iso,
  };
}

function signatureImpact(key: string, affected: string[], repo = repoId) {
  return stored(
    'conflict.detected',
    {
      canonical_key: key,
      kind: 'signature_impact',
      severity: 'warning',
      paths: ['src/a.ts'],
      task_ids: [taskB],
      repo_id: repo,
      evidence: [
        {
          branch: 'task/b',
          file_path: 'src/a.ts',
          name: 'parse',
          symbol_kind: 'function',
          old_signature: '(s: string) => number',
          new_signature: '(s: string, opts?: O) => number',
          affected_task_ids: affected,
          callers: [
            { file_path: 'src/c.ts', name: 'run' },
            { file_path: 'src/d.ts', name: 'main' },
          ],
        },
      ],
    },
    { repoId: repo },
  );
}

function symbolOverlap(key: string, taskIds: string[], repo = repoId) {
  return stored(
    'conflict.detected',
    {
      canonical_key: key,
      kind: 'symbol_overlap',
      severity: 'warning',
      paths: ['src/b.ts'],
      task_ids: taskIds,
      repo_id: repo,
      evidence: [
        {
          symbols: [
            { name: 'Widget', file_path: 'src/b.ts' },
            { name: '', file_path: 'x' },
          ],
        },
      ],
    },
    { repoId: repo },
  );
}

let cache: ChangeCache;
beforeEach(() => {
  cache = new ChangeCache();
  cache.setStale(false);
});

describe('ChangeCache — signature impacts', () => {
  it('projects conflict.detected evidence into an impact for affected tasks', () => {
    cache.applyEvent(signatureImpact('sig:1', [taskA, taskB]));
    const mine = cache.impactsFor(taskA);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      canonical_key: 'sig:1',
      task_id: taskB,
      name: 'parse',
      kind: 'function',
      callers_count: 2,
      old_signature: '(s: string) => number',
      new_signature: '(s: string, opts?: O) => number',
      state: 'open',
    });
    expect(mine[0]?.affected_task_ids).toEqual([taskA, taskB]);
    expect(cache.impactsFor(makeId('task'))).toHaveLength(0);
  });

  it('filters impacts by repo', () => {
    cache.applyEvent(signatureImpact('sig:1', [taskA], repoId));
    cache.applyEvent(signatureImpact('sig:2', [taskA], otherRepo));
    expect(cache.impactsFor(taskA, repoId).map((i) => i.canonical_key)).toEqual(['sig:1']);
    expect(cache.impactsFor(taskA)).toHaveLength(2);
  });

  it('drops resolved/dismissed impacts from open queries', () => {
    cache.applyEvent(signatureImpact('sig:1', [taskA]));
    cache.applyEvent(stored('conflict.resolved', { canonical_key: 'sig:1' }, { repoId }));
    expect(cache.impactsFor(taskA)).toHaveLength(0);
    expect(cache.openConflicts()).toHaveLength(0);
    expect(cache.snapshot().impacts[0]?.state).toBe('resolved');
  });
});

describe('ChangeCache — symbol overlaps & conflicts', () => {
  it('projects overlaps, dropping empty symbol names', () => {
    cache.applyEvent(symbolOverlap('ov:1', [taskA, taskB]));
    const mine = cache.overlapsFor(taskA);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.symbols).toEqual([{ name: 'Widget', file_path: 'src/b.ts' }]);
    expect(mine[0]?.task_ids).toEqual([taskA, taskB]);
    expect(cache.overlapsFor(taskB)).toHaveLength(1);
  });

  it('tracks generic conflicts without evidence and resolves them', () => {
    cache.applyEvent(
      stored(
        'conflict.detected',
        {
          canonical_key: 'cf:1',
          kind: 'file_overlap',
          severity: 'warning',
          paths: ['src/a.ts'],
          task_ids: [taskA, taskB],
          repo_id: repoId,
        },
        { repoId },
      ),
    );
    expect(cache.openConflicts().map((c) => c.canonical_key)).toEqual(['cf:1']);
    expect(cache.impactsFor(taskA)).toHaveLength(0);
    cache.applyEvent(stored('conflict.dismissed', { canonical_key: 'cf:1' }, { repoId }));
    expect(cache.openConflicts()).toHaveLength(0);
    expect(cache.snapshot().conflicts[0]?.state).toBe('dismissed');
  });

  it('sorts open conflicts deterministically by canonical key', () => {
    for (const key of ['cf:z', 'cf:a', 'cf:m']) {
      cache.applyEvent(
        stored(
          'conflict.detected',
          { canonical_key: key, kind: 'file_overlap', paths: [], task_ids: [], repo_id: repoId },
          { repoId },
        ),
      );
    }
    expect(cache.openConflicts().map((c) => c.canonical_key)).toEqual(['cf:a', 'cf:m', 'cf:z']);
  });
});

describe('ChangeCache — progress provenance', () => {
  it('labels agent-authored notes as agent and human notes as human', () => {
    cache.applyEvent(
      stored(
        'task.progress',
        { summary: 'agent note', percent: 40 },
        { actor: agent, taskId: taskA },
      ),
    );
    cache.applyEvent(
      stored('task.progress', { summary: 'human note' }, { actor: human, taskId: taskB }),
    );
    expect(cache.progressFor(taskA)).toMatchObject({
      summary: 'agent note',
      percent: 40,
      provenance: 'agent',
    });
    expect(cache.progressFor(taskB)).toMatchObject({
      summary: 'human note',
      percent: null,
      provenance: 'human',
    });
  });

  it('keeps only the latest progress per task and ignores missing summaries', () => {
    cache.applyEvent(
      stored('task.progress', { summary: 'first' }, { actor: agent, taskId: taskA }),
    );
    const latest = stored(
      'task.progress',
      { summary: 'second', percent: 90 },
      { actor: agent, taskId: taskA },
    );
    cache.applyEvent(latest);
    cache.applyEvent(stored('task.progress', { percent: 10 }, { actor: agent, taskId: taskA }));
    expect(cache.progressFor(taskA)?.summary).toBe('second');
    expect(cache.progressFor(taskA)?.seq).toBe(latest.global_seq);
  });
});

describe('ChangeCache — replay, staleness, reset', () => {
  it('is idempotent under replay and ignores stale seq', () => {
    const e = signatureImpact('sig:1', [taskA]);
    cache.applyEvent(e);
    const cursor = cache.getCursor();
    cache.applyEvent(e); // same seq → ignored
    cache.applyEvent(signatureImpact('sig:2', [taskA], repoId));
    const higher = cache.getCursor();
    cache.applyEvent({ ...e, global_seq: cursor - 1 }); // lower seq → ignored
    expect(cache.getCursor()).toBe(higher);
    expect(cache.impactsFor(taskA).map((i) => i.canonical_key)).toEqual(['sig:1', 'sig:2']);
  });

  it('tracks staleness and clears all projections', () => {
    cache.applyEvent(signatureImpact('sig:1', [taskA]));
    expect(cache.isStale()).toBe(false);
    cache.setStale(true);
    expect(cache.isStale()).toBe(true);
    cache.clear();
    expect(cache.getCursor()).toBe(0);
    expect(cache.snapshot()).toMatchObject({
      conflicts: [],
      impacts: [],
      overlaps: [],
      progress: [],
    });
  });

  it('ignores unrelated event types', () => {
    cache.applyEvent(stored('tool.post', { tool_name: 'Read' }, { taskId: taskA }));
    cache.applyEvent(stored('session.started', { cwd: '/repo' }));
    expect(cache.snapshot().conflicts).toHaveLength(0);
    expect(cache.progressFor(taskA)).toBeUndefined();
  });
});
