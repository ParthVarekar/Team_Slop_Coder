import { describe, expect, it } from 'vitest';
import { ulid, makeId, parseEvent, type EventEnvelope } from '@weft/protocol';
import { translateEvent, AdapterError, type AdapterContext, type AdapterEvent } from './events.js';
import { CAPABILITY_MANIFEST } from './manifest.js';

const ctx: AdapterContext = {
  deviceId: makeId('device'),
  projectId: makeId('project'),
  userId: makeId('user'),
  cwd: '/workspace',
  model: 'cline-model',
};

function event(kind: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { session_id: 'cline_123', kind, cwd: '/workspace', ...extra };
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

describe('Cline push translation', () => {
  it('maps task.started to a medium-fidelity session.started', () => {
    const events = translateEvent(event('task.started', { model: 'cline-model' }), ctx);
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({
      cwd: '/workspace',
      fidelity: 'medium',
      model: 'cline-model',
    });
    expect(events[0]?.agent).toMatchObject({ provider: 'cline', adapter: 'push@0.0.0' });
    expect(events[0]?.providerSessionId).toBe('cline_123');
  });

  it('accepts task_id as the provider session id and falls back to ctx.cwd', () => {
    const events = translateEvent({ task_id: 'task_1', kind: 'task.started' }, ctx);
    expect(events[0]?.providerSessionId).toBe('task_1');
    expect(events[0]?.payload).toMatchObject({ cwd: '/workspace', fidelity: 'medium' });
  });

  it('maps tool.called to tool.pre with a compact input summary', () => {
    const events = translateEvent(
      event('tool.called', { tool_name: 'read_file', tool_input: { path: 'src/a.ts' } }),
      ctx,
    );
    expect(events[0]?.type).toBe('tool.pre');
    expect(events[0]?.payload).toMatchObject({
      tool_name: 'read_file',
      tool_input_summary: { path: 'src/a.ts' },
    });
  });

  it('emits nothing for a tool event without a tool name (no fabrication)', () => {
    expect(translateEvent(event('tool.called'), ctx)).toEqual([]);
    expect(translateEvent(event('tool.completed', { output: 'ok' }), ctx)).toEqual([]);
  });

  it('maps successful tool.completed to tool.post plus a reported file change', () => {
    const events = translateEvent(
      event('tool.completed', {
        tool_name: 'write_file',
        output: 'wrote',
        success: true,
        path: 'src/a.ts',
        change_kind: 'add',
      }),
      ctx,
    );
    expect(events.map((e) => e.type)).toEqual(['tool.post', 'file.changed']);
    expect(events[0]?.payload).toMatchObject({
      tool_name: 'write_file',
      success: true,
      output_excerpt: 'wrote',
    });
    expect(events[0]?.payload.output_digest).toMatch(/^sha256:/);
    expect(events[1]?.payload).toMatchObject({
      path: 'src/a.ts',
      change_kind: 'add',
      source: 'agent_tool',
    });
  });

  it('maps non-zero exit or success:false to tool.failed and still records a reported file change', () => {
    for (const extra of [{ exit_code: 1 }, { success: false }]) {
      const events = translateEvent(
        event('tool.completed', { tool_name: 'run', output: 'boom', path: 'a.ts', ...extra }),
        ctx,
      );
      expect(events.map((e) => e.type)).toEqual(['tool.failed', 'file.changed']);
      expect(events[0]?.payload).toMatchObject({
        tool_name: 'run',
        error_class: 'tool_error',
        error_excerpt: 'boom',
      });
    }
  });

  it('maps task.completed reasons and message activity onto the protocol enum', () => {
    expect(
      translateEvent(event('task.completed', { reason: 'failed' }), ctx)[0]?.payload,
    ).toMatchObject({ reason: 'failed' });
    expect(
      translateEvent(event('task.completed', { reason: 'crashed' }), ctx)[0]?.payload,
    ).toMatchObject({ reason: 'crashed' });
    expect(translateEvent(event('task.completed'), ctx)[0]?.payload).toMatchObject({
      reason: 'completed',
    });
    expect(translateEvent(event('message'), ctx)[0]?.payload).toMatchObject({ status: 'running' });
  });

  it('emits nothing for unknown kinds', () => {
    expect(translateEvent(event('future_kind'), ctx)).toEqual([]);
  });

  it('throws AdapterError when neither session_id nor task_id is present or input is malformed', () => {
    expect(() => translateEvent({ kind: 'task.started' }, ctx)).toThrowError(AdapterError);
    expect(() => translateEvent(null, ctx)).toThrowError(AdapterError);
    expect(() => translateEvent({ session_id: '', kind: 'task.started' }, ctx)).toThrowError(
      AdapterError,
    );
  });
});

describe('adapter contract guarantees', () => {
  const fixtures: Record<string, unknown>[] = [
    event('task.started'),
    { task_id: 'task_1', kind: 'task.started' },
    event('tool.called', { tool_name: 'read_file', tool_input: { path: 'src/a.ts' } }),
    event('tool.completed', {
      tool_name: 'write_file',
      output: 'ok',
      path: 'src/a.ts',
      change_kind: 'add',
    }),
    event('tool.completed', { tool_name: 'run', output: 'boom', exit_code: 1, path: 'a.ts' }),
    event('task.completed', { reason: 'failed' }),
    event('task.completed'),
    event('message'),
  ];

  it('every translated event validates against the protocol catalog', () => {
    for (const fixture of fixtures) {
      for (const translated of translateEvent(fixture, ctx)) {
        expect(() => parseEvent(toEnvelope(translated))).not.toThrow();
      }
    }
  });

  it('only emits declared types and declares honest observe-only capability', () => {
    const declared = new Set(CAPABILITY_MANIFEST.emittedTypes);
    for (const fixture of fixtures) {
      for (const translated of translateEvent(fixture, ctx))
        expect(declared.has(translated.type)).toBe(true);
    }
    expect(CAPABILITY_MANIFEST.fidelity).toBe('medium');
    expect(CAPABILITY_MANIFEST.transport).toEqual(['http']);
    expect(CAPABILITY_MANIFEST.enforcement).toMatchObject({
      preToolUse: false,
      mode: 'none',
      hardBlock: false,
    });
  });
});
