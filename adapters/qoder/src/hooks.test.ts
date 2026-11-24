import { describe, expect, it } from 'vitest';
import { ulid, makeId, parseEvent, type EventEnvelope } from '@weft/protocol';
import { translateHook, AdapterError, type AdapterContext, type AdapterEvent } from './hooks.js';
import { CAPABILITY_MANIFEST } from './manifest.js';

const ctx: AdapterContext = {
  deviceId: makeId('device'),
  projectId: makeId('project'),
  userId: makeId('user'),
  cwd: '/workspace',
  model: 'claude-sonnet-4-5',
};

function hook(event: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session_id: 'qoder_session_1',
    cwd: '/workspace',
    hook_event_name: event,
    model: 'claude-sonnet-4-5',
    ...extra,
  };
}

const PATCH = [
  '*** Begin Patch',
  '*** Update File: src/a.ts',
  '@@',
  '-old',
  '+new',
  '*** Add File: src/b.ts',
  '+export const b = 1;',
  '*** Delete File: src/old.ts',
  '*** End Patch',
].join('\n');

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

describe('Qoder hook translation', () => {
  it('maps SessionStart to high-fidelity session.started', () => {
    const events = translateHook(hook('SessionStart', { source: 'startup' }), ctx);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('session.started');
    expect(events[0]?.payload).toMatchObject({ cwd: '/workspace', fidelity: 'high' });
    expect(events[0]?.agent).toMatchObject({ provider: 'qoder', adapter: 'hooks@0.0.0' });
    expect(events[0]?.providerSessionId).toBe('qoder_session_1');
  });

  it('truncates and hashes submitted prompts', () => {
    const prompt = 'secret prompt '.repeat(100);
    const events = translateHook(hook('UserPromptSubmit', { prompt }), ctx);
    expect(events[0]?.type).toBe('prompt.submitted');
    expect(String(events[0]?.payload.prompt_summary).length).toBeLessThanOrEqual(401);
    expect(events[0]?.payload.prompt_hash).toMatch(/^sha256:/);
  });

  it('maps PreToolUse to tool.pre with a compact summary', () => {
    const events = translateHook(
      hook('PreToolUse', {
        tool_name: 'Bash',
        tool_use_id: 'call_1',
        tool_input: { command: 'pnpm test', environment: 'secret' },
      }),
      ctx,
    );
    expect(events[0]?.payload).toMatchObject({
      tool_name: 'Bash',
      tool_use_id: 'call_1',
      tool_input_summary: { command: 'pnpm test' },
    });
  });

  it('maps PermissionRequest to waiting_permission', () => {
    const events = translateHook(
      hook('PermissionRequest', {
        tool_name: 'Write',
        tool_input: { file_path: 'src/a.ts', description: 'Approve write' },
      }),
      ctx,
    );
    expect(events[0]?.type).toBe('session.status');
    expect(events[0]?.payload).toMatchObject({
      status: 'waiting_permission',
      detail: 'Approve write',
    });
  });

  it('derives tool.post and command.executed from a successful Bash hook', () => {
    const events = translateHook(
      hook('PostToolUse', {
        tool_name: 'Bash',
        tool_input: { command: 'pnpm test' },
        tool_response: { stdout: 'ok', exit_code: 0 },
      }),
      ctx,
    );
    expect(events.map((e) => e.type)).toEqual(['tool.post', 'command.executed']);
    expect(events[1]?.payload).toMatchObject({
      command_display: 'pnpm test',
      exit_code: 0,
      cwd: '/workspace',
    });
  });

  it('derives file changes from apply_patch without inventing paths', () => {
    const events = translateHook(
      hook('PostToolUse', {
        tool_name: 'apply_patch',
        tool_input: { command: PATCH },
        tool_response: { success: true },
      }),
      ctx,
    );
    expect(events.map((e) => e.type)).toEqual([
      'tool.post',
      'file.changed',
      'file.changed',
      'file.changed',
    ]);
    expect(events.slice(1).map((e) => e.payload)).toMatchObject([
      { path: 'src/a.ts', change_kind: 'modify', source: 'agent_tool' },
      { path: 'src/b.ts', change_kind: 'add', source: 'agent_tool' },
      { path: 'src/old.ts', change_kind: 'delete', source: 'agent_tool' },
    ]);
  });

  it('maps a reported file_path to one file.changed', () => {
    const events = translateHook(
      hook('PostToolUse', {
        tool_name: 'Write',
        file_path: 'src/c.ts',
        tool_response: { success: true },
      }),
      ctx,
    );
    expect(events.map((e) => e.type)).toEqual(['tool.post', 'file.changed']);
    expect(events[1]?.payload).toMatchObject({
      path: 'src/c.ts',
      change_kind: 'modify',
      source: 'agent_tool',
    });
  });

  it('emits tool.failed, but no command success, for a non-zero Bash exit', () => {
    const events = translateHook(
      hook('PostToolUse', {
        tool_name: 'Bash',
        tool_input: { command: 'false' },
        tool_response: { stdout: '', stderr: 'boom', exit_code: 1 },
      }),
      ctx,
    );
    expect(events.map((e) => e.type)).toEqual(['tool.failed']);
    expect(events[0]?.payload.error_excerpt).toContain('boom');
  });

  it('maps Stop, Interrupt, and SessionEnd to honest lifecycle states', () => {
    expect(
      translateHook(hook('Stop', { last_assistant_message: 'Done.' }), ctx)[0]?.payload,
    ).toMatchObject({ status: 'idle', detail: 'Done.' });
    expect(translateHook(hook('Interrupt'), ctx)[0]?.payload).toMatchObject({
      status: 'idle',
      detail: 'interrupted',
    });
    expect(translateHook(hook('SessionEnd', { reason: 'failed' }), ctx)[0]?.payload).toEqual({
      reason: 'failed',
    });
  });

  it('emits nothing for diagnostic, subagent, and unknown hooks', () => {
    expect(translateHook(hook('SubagentStop'), ctx)).toEqual([]);
    expect(translateHook(hook('PreCompact'), ctx)).toEqual([]);
    expect(translateHook(hook('SomeFutureHook'), ctx)).toEqual([]);
  });

  it('throws AdapterError for malformed hooks', () => {
    expect(() => translateHook({ hook_event_name: 'Stop' }, ctx)).toThrowError(AdapterError);
    expect(() => translateHook(null, ctx)).toThrowError(AdapterError);
  });
});

describe('Qoder adapter contract guarantees', () => {
  const fixtures = [
    hook('SessionStart'),
    hook('UserPromptSubmit', { prompt: 'fix tests' }),
    hook('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } }),
    hook('PermissionRequest', { tool_input: { description: 'approve' } }),
    hook('PostToolUse', {
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
      tool_response: { stdout: 'a', exit_code: 0 },
    }),
    hook('PostToolUse', {
      tool_name: 'apply_patch',
      tool_input: { command: PATCH },
      tool_response: { success: true },
    }),
    hook('PostToolUse', {
      tool_name: 'Bash',
      tool_input: { command: 'false' },
      tool_response: { stderr: 'boom', exit_code: 1 },
    }),
    hook('Stop'),
    hook('Interrupt'),
    hook('SessionEnd'),
  ];

  it('every emitted event validates against the protocol catalog', () => {
    for (const fixture of fixtures) {
      for (const event of translateHook(fixture, ctx))
        expect(() => parseEvent(toEnvelope(event))).not.toThrow();
    }
  });

  it('declares only real mappings and a fail-open pre-tool guardrail', () => {
    const declared = new Set(CAPABILITY_MANIFEST.emittedTypes);
    for (const fixture of fixtures) {
      for (const event of translateHook(fixture, ctx)) expect(declared.has(event.type)).toBe(true);
    }
    expect(CAPABILITY_MANIFEST).toMatchObject({
      provider: 'qoder',
      fidelity: 'high',
      transport: ['http', 'command'],
      enforcement: { preToolUse: true, mode: 'sync', hardBlock: false },
    });
  });
});
