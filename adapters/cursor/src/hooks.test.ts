import { describe, expect, it } from 'vitest';
import { ulid, makeId, parseEvent, type EventEnvelope } from '@weft/protocol';
import { translateHook, AdapterError, type AdapterContext, type AdapterEvent } from './hooks.js';
import { CAPABILITY_MANIFEST } from './manifest.js';

const ctx: AdapterContext = {
  deviceId: makeId('device'),
  projectId: makeId('project'),
  userId: makeId('user'),
  cwd: '/workspace',
  model: 'cursor-model',
};

function hook(event: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    conversation_id: 'conversation_123',
    cwd: '/workspace',
    hook_event_name: event,
    model: 'cursor-model',
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

describe('Cursor hook translation', () => {
  it('maps sessionStart conservatively with medium fidelity and conversation_id', () => {
    const events = translateHook(hook('sessionStart'), ctx);
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({ cwd: '/workspace', fidelity: 'medium' });
    expect(events[0]?.providerSessionId).toBe('conversation_123');
    expect(events[0]?.agent).toMatchObject({ provider: 'cursor', adapter: 'hooks@0.0.0' });
  });

  it('accepts session_id as a fallback identifier', () => {
    const events = translateHook({ session_id: 'session_abc', hook_event_name: 'stop' }, ctx);
    expect(events[0]?.providerSessionId).toBe('session_abc');
    expect(events[0]?.payload).toEqual({ status: 'idle' });
  });

  it('maps preToolUse to tool.pre with a compact input summary', () => {
    const events = translateHook(
      hook('preToolUse', {
        tool_name: 'Read',
        tool_use_id: 'call_1',
        tool_input: { file_path: 'src/a.ts', extra: 'omitted' },
      }),
      ctx,
    );
    expect(events[0]?.type).toBe('tool.pre');
    expect(events[0]?.payload).toMatchObject({
      tool_name: 'Read',
      tool_use_id: 'call_1',
      tool_input_summary: { file_path: 'src/a.ts' },
    });
  });

  it('maps beforeShellExecution to a Shell tool.pre', () => {
    const events = translateHook(hook('beforeShellExecution', { command: 'pnpm test' }), ctx);
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({
      tool_name: 'Shell',
      tool_input_summary: { command: 'pnpm test' },
    });
  });

  it('derives tool.post and command.executed from successful afterShellExecution', () => {
    const events = translateHook(
      hook('afterShellExecution', { command: 'pnpm test', exit_code: 0, output: 'ok' }),
      ctx,
    );
    expect(events.map((e) => e.type)).toEqual(['tool.post', 'command.executed']);
    expect(events[1]?.payload).toMatchObject({
      command_display: 'pnpm test',
      exit_code: 0,
      cwd: '/workspace',
    });
  });

  it('maps postToolUseFailure to tool.failed', () => {
    const events = translateHook(
      hook('postToolUseFailure', {
        tool_name: 'Read',
        tool_input: { file_path: 'missing.ts' },
        output: 'not found',
      }),
      ctx,
    );
    expect(events.map((e) => e.type)).toEqual(['tool.failed']);
    expect(events[0]?.payload).toMatchObject({ tool_name: 'Read', error_excerpt: 'not found' });
  });

  it('maps a non-zero postToolUse shell exit to failure without claiming command success', () => {
    const events = translateHook(
      hook('postToolUse', {
        tool_name: 'Shell',
        tool_input: { command: 'false' },
        tool_response: { stdout: '', stderr: 'boom', exit_code: 1 },
      }),
      ctx,
    );
    expect(events.map((e) => e.type)).toEqual(['tool.failed']);
    expect(events[0]?.payload.error_excerpt).toContain('boom');
  });

  it('maps afterFileEdit to an agent-attributed file.changed', () => {
    const events = translateHook(
      hook('afterFileEdit', { file_path: 'src/new.ts', edits: [{ old: '', new: 'x' }] }),
      ctx,
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toEqual({
      path: 'src/new.ts',
      change_kind: 'modify',
      source: 'agent_tool',
    });
  });

  it('preserves a reported change_kind and emits nothing when the path is absent', () => {
    expect(
      translateHook(
        hook('afterFileEdit', { file_path: 'src/gone.ts', change_kind: 'delete' }),
        ctx,
      )[0]?.payload,
    ).toMatchObject({ change_kind: 'delete' });
    expect(translateHook(hook('afterFileEdit', { edits: [] }), ctx)).toEqual([]);
  });

  it('maps sessionEnd reasons without inventing unsupported states', () => {
    expect(translateHook(hook('sessionEnd', { reason: 'completed' }), ctx)[0]?.payload).toEqual({
      reason: 'completed',
    });
    expect(translateHook(hook('sessionEnd', { reason: 'failed' }), ctx)[0]?.payload).toEqual({
      reason: 'failed',
    });
    expect(translateHook(hook('sessionEnd'), ctx)[0]?.payload).toEqual({ reason: 'completed' });
  });

  it('emits nothing for subagent and unknown hooks', () => {
    expect(translateHook(hook('subagentStart', { subagent_id: 'sub_1' }), ctx)).toEqual([]);
    expect(translateHook(hook('SomeFutureHook'), ctx)).toEqual([]);
  });

  it('throws AdapterError when identity or hook name is missing', () => {
    expect(() => translateHook({ hook_event_name: 'stop' }, ctx)).toThrowError(AdapterError);
    expect(() => translateHook({ conversation_id: 'c1' }, ctx)).toThrowError(AdapterError);
    expect(() => translateHook(null, ctx)).toThrowError(AdapterError);
  });
});

describe('Cursor adapter contract guarantees', () => {
  const fixtures = [
    hook('sessionStart'),
    hook('stop'),
    hook('sessionEnd', { reason: 'completed' }),
    hook('preToolUse', { tool_name: 'Read', tool_input: { file_path: 'src/a.ts' } }),
    hook('beforeShellExecution', { command: 'ls' }),
    hook('afterShellExecution', { command: 'ls', exit_code: 0, output: 'a.ts' }),
    hook('afterShellExecution', { command: 'false', exit_code: 1, output: 'boom' }),
    hook('postToolUseFailure', { tool_name: 'Read', output: 'missing' }),
    hook('afterFileEdit', { file_path: 'src/a.ts' }),
    hook('subagentStart'),
    hook('SomeFutureHook'),
  ];

  it('every emitted event validates against the protocol catalog', () => {
    for (const fixture of fixtures) {
      for (const event of translateHook(fixture, ctx))
        expect(() => parseEvent(toEnvelope(event))).not.toThrow();
    }
  });

  it('declares only real mappings, medium fidelity, and fail-open enforcement', () => {
    const declared = new Set(CAPABILITY_MANIFEST.emittedTypes);
    for (const fixture of fixtures) {
      for (const event of translateHook(fixture, ctx)) expect(declared.has(event.type)).toBe(true);
    }
    expect(CAPABILITY_MANIFEST).toMatchObject({
      provider: 'cursor',
      fidelity: 'medium',
      transport: ['http', 'command'],
      enforcement: { preToolUse: true, mode: 'sync', hardBlock: false },
    });
  });
});
