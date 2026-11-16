import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  ulid,
  ulidFactory,
  ulidTime,
  isUlid,
  ULID_LEN,
  makeId,
  DeviceIdSchema,
  parseEvent,
  safeParseEvent,
  isKnownEventType,
  isCoordinationEvent,
  KNOWN_EVENT_TYPES,
  PAYLOAD_SCHEMAS,
  type EventEnvelope,
  type KnownEventType,
} from '@weft/protocol';

function baseEnvelope(type: string, payload: Record<string, unknown>): EventEnvelope {
  return {
    v: 1,
    event_id: ulid(),
    device_id: makeId('device'),
    project_id: makeId('project'),
    repo_id: makeId('repo'),
    session_id: makeId('session'),
    task_id: makeId('task'),
    seq: 1,
    ts: new Date().toISOString(),
    type,
    actor: {
      user_id: makeId('user'),
      agent: { provider: 'claude-code', model: 'claude-opus-4-6', adapter: 'hooks@1.4.0' },
    },
    privacy: 'metadata',
    payload,
  };
}

const MINIMAL_PAYLOADS: Record<KnownEventType, Record<string, unknown>> = {
  'session.started': { cwd: '/repo', fidelity: 'high' },
  'session.status': { status: 'running' },
  'session.ended': { reason: 'completed' },
  'prompt.submitted': { prompt_summary: 'do x', prompt_hash: 'sha256:abc' },
  'tool.pre': { tool_name: 'Edit' },
  'tool.post': { tool_name: 'Edit', success: true },
  'tool.failed': { tool_name: 'Edit' },
  'command.executed': { command_display: 'pnpm test' },
  'file.changed': { path: 'src/a.ts', change_kind: 'modify', source: 'agent_tool' },
  'symbols.changed': {
    path: 'src/a.ts',
    content_hash: 'sha256:abc',
    symbols: [{ name: 'foo', kind: 'function', change_kind: 'signature' }],
  },
  'commit.created': { oid: 'abc123', branch: 'main', parents: [] },
  'branch.created': { name: 'task/x', head_oid: 'abc' },
  'branch.updated': { name: 'task/x', head_oid: 'abc' },
  'worktree.created': { path: '/wt', branch: 'task/x' },
  'worktree.removed': { path: '/wt', branch: 'task/x' },
  'task.created': { version: 1 },
  'task.updated': { version: 1 },
  'task.assigned': { version: 1 },
  'task.claimed': { version: 1 },
  'task.released': { version: 1 },
  'task.claim_rejected': { version: 1 },
  'task.state_changed': { from: 'ready', to: 'claimed', version: 2 },
  'task.progress': { summary: 'working' },
  'task.completion_claimed': { claim_text: 'done', evidence_state: 'unverified' },
  'task.commented': { author: { system: 'daemon' }, body: 'hi' },
  'task.handed_off': { author: { system: 'daemon' }, handoff_bundle: {} },
  'reservation.acquired': { path_glob: 'src/**', mode: 'hard' },
  'reservation.renewed': { path_glob: 'src/**', mode: 'hard' },
  'reservation.released': { path_glob: 'src/**', mode: 'hard' },
  'reservation.denied': { path_glob: 'src/**', mode: 'hard' },
  'conflict.detected': { canonical_key: 'file_overlap:a:b:src/a.ts' },
  'conflict.resolved': { canonical_key: 'file_overlap:a:b:src/a.ts' },
  'conflict.dismissed': { canonical_key: 'file_overlap:a:b:src/a.ts' },
  'merge.queued': { entry_id: 'mq_1' },
  'merge.testing': { entry_id: 'mq_1' },
  'merge.merged': { entry_id: 'mq_1' },
  'merge.ejected': { entry_id: 'mq_1' },
  'summary.compacted': { seq_start: 1, seq_end: 10, dropped_types: ['tool.post'] },
  'validation.started': {
    run_id: 'val_1',
    trigger: 'task',
    checks: ['typecheck'],
    selection: 'full',
  },
  'check.completed': { run_id: 'val_1', check_id: 'typecheck', exit_code: 0 },
  'validation.completed': { run_id: 'val_1', state: 'passed' },
  'health.baseline_established': { branch: 'main', commit_oid: 'abc' },
  'health.regression': { baseline_id: 'base_1', failure_fingerprint: 'fp', suspected_changes: [] },
  'notification.created': { kind: 'conflict' },
};

describe('ulid', () => {
  it('produces 26-char canonical ids', () => {
    const id = ulid();
    expect(id).toHaveLength(ULID_LEN);
    expect(isUlid(id)).toBe(true);
  });

  it('is monotonic within the same millisecond', () => {
    const gen = ulidFactory(() => 1700000000000);
    const ids = Array.from({ length: 1000 }, () => gen());
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('encodes a decodable timestamp', () => {
    const t = 1700000000123;
    const id = ulidFactory(() => t)();
    expect(ulidTime(id)).toBe(t);
  });

  it('rejects malformed ids', () => {
    expect(isUlid('too-short')).toBe(false);
    expect(isUlid('0'.repeat(26).replace('0', 'I'))).toBe(false);
    expect(() => ulidTime('nope')).toThrow();
  });
});

describe('ids', () => {
  it('makes prefixed ids that validate', () => {
    const id = makeId('device');
    expect(id.startsWith('dev_')).toBe(true);
    expect(DeviceIdSchema.safeParse(id).success).toBe(true);
    expect(DeviceIdSchema.safeParse('dev_nope').success).toBe(false);
  });
});

describe('catalog completeness', () => {
  it('has a valid minimal payload for every known type', () => {
    for (const type of KNOWN_EVENT_TYPES) {
      const schema = PAYLOAD_SCHEMAS[type];
      const result = schema.safeParse(MINIMAL_PAYLOADS[type]);
      expect(result.success, `payload for ${type}`).toBe(true);
    }
  });

  it('classifies coordination events as durable', () => {
    expect(isCoordinationEvent('task.claimed')).toBe(true);
    expect(isCoordinationEvent('commit.created')).toBe(true);
    expect(isCoordinationEvent('validation.completed')).toBe(true);
    expect(isCoordinationEvent('tool.post')).toBe(false);
    expect(isCoordinationEvent('file.changed')).toBe(false);
  });
});

describe('parseEvent', () => {
  it('accepts a valid known event', () => {
    const env = baseEnvelope('tool.post', MINIMAL_PAYLOADS['tool.post']);
    expect(parseEvent(env).type).toBe('tool.post');
  });

  it('accepts and preserves unknown event types', () => {
    const env = baseEnvelope('future.thing', { arbitrary: true, nested: { a: 1 } });
    const parsed = parseEvent(env);
    expect(parsed.type).toBe('future.thing');
    expect(parsed.payload).toEqual({ arbitrary: true, nested: { a: 1 } });
  });

  it('preserves additive payload fields on known types', () => {
    const env = baseEnvelope('tool.post', { ...MINIMAL_PAYLOADS['tool.post'], x_new: 'kept' });
    expect(parseEvent(env).payload.x_new).toBe('kept');
  });

  it('rejects a bad envelope', () => {
    const env = baseEnvelope('tool.post', MINIMAL_PAYLOADS['tool.post']);
    expect(safeParseEvent({ ...env, v: 2 }).success).toBe(false);
    expect(safeParseEvent({ ...env, event_id: 'bad' }).success).toBe(false);
    expect(safeParseEvent({ ...env, ts: 'not-a-date' }).success).toBe(false);
    expect(safeParseEvent({ ...env, privacy: 'secret' }).success).toBe(false);
    const { event_id: _omit, ...withoutId } = env;
    expect(safeParseEvent(withoutId).success).toBe(false);
  });

  it('rejects an invalid payload for a known type', () => {
    const env = baseEnvelope('tool.post', { tool_name: 'Edit' });
    expect(safeParseEvent(env).success).toBe(false);
  });
});

describe('property: round-trip', () => {
  const knownTypeArb = fc.constantFrom(...KNOWN_EVENT_TYPES);

  it('serialize -> parse is identity for known types', () => {
    const eventArb = knownTypeArb.chain((type) =>
      fc
        .record({
          note: fc.string(),
          count: fc.integer(),
          privacy: fc.constantFrom('metadata' as const, 'full' as const),
        })
        .map(({ note, count, privacy }) => {
          const env = baseEnvelope(type, {
            ...MINIMAL_PAYLOADS[type],
            _additive: { note, count },
          });
          env.privacy = privacy;
          return env;
        }),
    );

    fc.assert(
      fc.property(eventArb, (env) => {
        const parsed = parseEvent(env);
        const round = parseEvent(JSON.parse(JSON.stringify(parsed)));
        expect(round).toEqual(parsed);
        expect(round.payload._additive).toEqual(env.payload._additive);
      }),
      { numRuns: 300 },
    );
  });

  it('unknown types round-trip with payload intact', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }).filter((s) => !isKnownEventType(s)),
        fc.integer(),
        (type, n) => {
          const env = baseEnvelope(type, { arbitrary: true, n });
          const round = parseEvent(JSON.parse(JSON.stringify(env)));
          expect(round.type).toBe(type);
          expect(round.payload).toEqual({ arbitrary: true, n });
        },
      ),
      { numRuns: 200 },
    );
  });
});
