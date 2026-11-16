import { describe, expect, it } from 'vitest';
import { ulid, makeId, parseEvent, type EventEnvelope } from '@weft/protocol';
import { translateNotify } from './notify.js';
import { AdapterError, type AdapterContext, type AdapterEvent } from './hooks.js';
import { NOTIFY_MANIFEST } from './manifest.js';

const ctx: AdapterContext = {
  deviceId: makeId('device'),
  projectId: makeId('project'),
  userId: makeId('user'),
  model: 'gpt-5-codex',
};

// Real legacy notify argv blob: Codex passes one JSON argument with hyphenated
// keys and fires only on agent-turn-complete (OpenAI codex config reference).
function notify(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'agent-turn-complete',
    'thread-id': 'thr_123',
    'turn-id': 'turn_1',
    cwd: '/workspace',
    'input-messages': ['list the files'],
    'last-assistant-message': 'Listed 14 files.',
    ...extra,
  };
}

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

describe('Codex legacy notify translation', () => {
  it('maps agent-turn-complete to a low-fidelity idle status keyed by thread-id', () => {
    const events = translateNotify(notify(), ctx);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('session.status');
    expect(events[0]?.providerSessionId).toBe('thr_123');
    expect(events[0]?.agent).toMatchObject({ provider: 'codex', adapter: 'notify@0.0.0' });
    expect(events[0]?.payload).toMatchObject({ status: 'idle', fidelity: 'low' });
    expect(events[0]?.payload.message_hash).toMatch(/^sha256:/);
  });

  it('falls back to turn-id when thread-id is absent', () => {
    const events = translateNotify(notify({ 'thread-id': undefined }), ctx);
    expect(events[0]?.providerSessionId).toBe('turn_1');
  });

  it('truncates a long last-assistant-message detail', () => {
    const events = translateNotify(notify({ 'last-assistant-message': 'y'.repeat(1000) }), ctx);
    expect(String(events[0]?.payload.detail).length).toBeLessThanOrEqual(201);
  });

  it('emits nothing for unknown notify types (no fabricated activity)', () => {
    expect(translateNotify(notify({ type: 'approval-requested' }), ctx)).toEqual([]);
  });

  it('throws AdapterError when no session key is present', () => {
    expect(() =>
      translateNotify(notify({ 'thread-id': undefined, 'turn-id': undefined }), ctx),
    ).toThrowError(AdapterError);
  });

  it('throws AdapterError on malformed input', () => {
    expect(() => translateNotify(null, ctx)).toThrowError(AdapterError);
    expect(() => translateNotify({ 'thread-id': 'thr_1' }, ctx)).toThrowError(AdapterError);
  });

  it('every translated event validates and is manifest-declared', () => {
    const declared = new Set(NOTIFY_MANIFEST.emittedTypes);
    for (const event of translateNotify(notify(), ctx)) {
      expect(() => parseEvent(toEnvelope(event))).not.toThrow();
      expect(declared.has(event.type)).toBe(true);
    }
    expect(NOTIFY_MANIFEST.fidelity).toBe('low');
    expect(NOTIFY_MANIFEST.enforcement).toMatchObject({ preToolUse: false, mode: 'none' });
  });
});