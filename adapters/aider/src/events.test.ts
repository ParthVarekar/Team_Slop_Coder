import { describe, expect, it } from 'vitest';
import { ulid, makeId, parseEvent, type EventEnvelope } from '@weft/protocol';
import { translateEvent, AdapterError, type AdapterContext, type AdapterEvent } from './events.js';
import { CAPABILITY_MANIFEST } from './manifest.js';

const ctx: AdapterContext = {
  deviceId: makeId('device'),
  projectId: makeId('project'),
  userId: makeId('user'),
  cwd: '/workspace',
};

function event(kind: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { session_id: 'aider_123', kind, cwd: '/workspace', ...extra };
}

const COMMIT = {
  commit_oid: 'a'.repeat(40),
  branch: 'feature/aider',
  parents: ['b'.repeat(40)],
  message: 'aider: update source',
  files: [
    { path: 'src/a.ts', change_kind: 'modify' },
    { path: 'src/b.ts', change_kind: 'add' },
  ],
};

function toEnvelope(e: AdapterEvent): EventEnvelope {
  return {
    v: 1,
    event_id: ulid(),
    device_id: ctx.deviceId,
    project_id: ctx.projectId,
    session_id: makeId('session'),
    provider_session_id: e.providerSessionId,
    ts: new Date().toISOString(),
    type: e.type,
    actor: { user_id: ctx.userId, agent: e.agent },
    privacy: e.privacy ?? 'metadata',
    payload: e.payload,
  };
}

describe('Aider wrap translation', () => {
  it('maps session_start to low-fidelity session.started', () => {
    const events = translateEvent(event('session_start'), ctx);
    expect(events[0]?.type).toBe('session.started');
    expect(events[0]?.payload).toMatchObject({ cwd: '/workspace', fidelity: 'low' });
    expect(events[0]?.agent).toMatchObject({ provider: 'aider', adapter: 'wrap@0.0.0' });
    expect(events[0]?.providerSessionId).toBe('aider_123');
  });

  it('maps a reported commit to commit.created plus file.changed per path', () => {
    const events = translateEvent(event('commit', COMMIT), ctx);
    expect(events.map((e) => e.type)).toEqual(['commit.created', 'file.changed', 'file.changed']);
    expect(events[0]?.payload).toMatchObject({
      oid: COMMIT.commit_oid,
      branch: COMMIT.branch,
      parents: COMMIT.parents,
      message_summary: 'aider: update source',
      files_changed_count: 2,
    });
    expect(events.slice(1).map((e) => e.payload)).toMatchObject([
      { path: 'src/a.ts', change_kind: 'modify', source: 'git' },
      { path: 'src/b.ts', change_kind: 'add', source: 'git' },
    ]);
  });

  it('does not invent commit metadata: missing oid/branch/parents emits nothing', () => {
    expect(translateEvent(event('commit', { ...COMMIT, commit_oid: undefined }), ctx)).toEqual([]);
    expect(translateEvent(event('commit', { ...COMMIT, branch: undefined }), ctx)).toEqual([]);
    expect(translateEvent(event('commit', { ...COMMIT, parents: undefined }), ctx)).toEqual([]);
  });

  it('maps session_end reasons onto the protocol enum', () => {
    expect(
      translateEvent(event('session_end', { reason: 'failed' }), ctx)[0]?.payload,
    ).toMatchObject({ reason: 'failed' });
    expect(
      translateEvent(event('session_end', { reason: 'interrupted' }), ctx)[0]?.payload,
    ).toMatchObject({ reason: 'interrupted' });
    expect(translateEvent(event('session_end'), ctx)[0]?.payload).toMatchObject({
      reason: 'completed',
    });
  });

  it('emits nothing for unknown kinds', () => {
    expect(translateEvent(event('future_kind'), ctx)).toEqual([]);
  });

  it('throws AdapterError on malformed input', () => {
    expect(() => translateEvent({ kind: 'session_start' }, ctx)).toThrowError(AdapterError);
    expect(() => translateEvent(null, ctx)).toThrowError(AdapterError);
    expect(() => translateEvent({ session_id: '', kind: 'session_start' }, ctx)).toThrowError(
      AdapterError,
    );
    expect(() =>
      translateEvent(event('commit', { ...COMMIT, files: [{ path: '' }] }), ctx),
    ).toThrowError(AdapterError);
  });
});

describe('adapter contract guarantees', () => {
  const fixtures: Record<string, unknown>[] = [
    event('session_start'),
    event('commit', COMMIT),
    event('commit', { ...COMMIT, files: [{ path: 'src/a.ts' }] }),
    event('session_end', { reason: 'failed' }),
    event('session_end'),
  ];

  it('every translated event validates against the protocol catalog', () => {
    for (const fixture of fixtures) {
      for (const translated of translateEvent(fixture, ctx)) {
        expect(() => parseEvent(toEnvelope(translated))).not.toThrow();
      }
    }
  });

  it('only emits declared types and declares low-fidelity observe-only capability', () => {
    const declared = new Set(CAPABILITY_MANIFEST.emittedTypes);
    for (const fixture of fixtures) {
      for (const translated of translateEvent(fixture, ctx))
        expect(declared.has(translated.type)).toBe(true);
    }
    expect(CAPABILITY_MANIFEST.fidelity).toBe('low');
    expect(CAPABILITY_MANIFEST.transport).toEqual(['command', 'http']);
    expect(CAPABILITY_MANIFEST.enforcement).toMatchObject({
      preToolUse: false,
      mode: 'none',
      hardBlock: false,
    });
  });
});
