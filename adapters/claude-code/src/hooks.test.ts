import { describe, expect, it } from 'vitest';
import { ulid, makeId, parseEvent, type EventEnvelope } from '@weft/protocol';
import {
  translateHook,
  AdapterError,
  denyPreToolUse,
  type AdapterContext,
  type AdapterEvent,
} from './hooks.js';
import { CAPABILITY_MANIFEST } from './manifest.js';

const ctx: AdapterContext = {
  deviceId: makeId('device'),
  projectId: makeId('project'),
  userId: makeId('user'),
  cwd: '/repo',
  model: 'claude-opus-4-6',
};

function hook(event: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session_id: 'native-abc',
    transcript_path: '/t.jsonl',
    cwd: '/repo',
    hook_event_name: event,
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

describe('Claude hook translation', () => {
  it('maps SessionStart to session.started with high fidelity', () => {
    const events = translateHook(
      hook('SessionStart', { source: 'startup', model: 'claude-opus-4-6' }),
      ctx,
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('session.started');
    expect(events[0]?.payload).toMatchObject({
      cwd: '/repo',
      fidelity: 'high',
      model: 'claude-opus-4-6',
    });
    expect(events[0]?.agent).toMatchObject({ provider: 'claude-code', adapter: 'hooks@0.0.0' });
    expect(events[0]?.providerSessionId).toBe('native-abc');
  });

  it('maps UserPromptSubmit to a truncated, hashed prompt.submitted', () => {
    const longPrompt = 'x'.repeat(1000);
    const events = translateHook(hook('UserPromptSubmit', { prompt: longPrompt }), ctx);
    expect(events[0]?.type).toBe('prompt.submitted');
    const payload = events[0]?.payload as Record<string, unknown>;
    expect(String(payload.prompt_summary).length).toBeLessThanOrEqual(401);
    expect(payload.prompt_hash).toMatch(/^sha256:/);
  });

  it('maps PreToolUse to tool.pre with a compact input summary', () => {
    const events = translateHook(
      hook('PreToolUse', {
        tool_name: 'Edit',
        tool_input: { file_path: '/repo/a.ts', old_string: 'a', new_string: 'b' },
      }),
      ctx,
    );
    expect(events[0]?.type).toBe('tool.pre');
    expect(events[0]?.payload.tool_input_summary).toMatchObject({ file_path: '/repo/a.ts' });
  });

  it('derives tool.post + file.changed(modify) from a PostToolUse Edit', () => {
    const events = translateHook(
      hook('PostToolUse', {
        tool_name: 'Edit',
        tool_input: { file_path: '/repo/a.ts' },
        tool_response: { filePath: '/repo/a.ts', success: true },
      }),
      ctx,
    );
    expect(events.map((e) => e.type)).toEqual(['tool.post', 'file.changed']);
    expect(events[1]?.payload).toMatchObject({
      path: '/repo/a.ts',
      change_kind: 'modify',
      source: 'agent_tool',
    });
  });

  it('marks Write as file.changed(add)', () => {
    const events = translateHook(
      hook('PostToolUse', {
        tool_name: 'Write',
        tool_input: { file_path: '/repo/new.ts' },
        tool_response: { success: true },
      }),
      ctx,
    );
    expect(events[1]?.payload).toMatchObject({ change_kind: 'add' });
  });

  it('derives command.executed from a PostToolUse Bash', () => {
    const events = translateHook(
      hook('PostToolUse', {
        tool_name: 'Bash',
        tool_input: { command: 'pnpm test' },
        tool_response: { stdout: 'ok', exitCode: 0 },
      }),
      ctx,
    );
    expect(events.map((e) => e.type)).toEqual(['tool.post', 'command.executed']);
    expect(events[1]?.payload).toMatchObject({ command_display: 'pnpm test', exit_code: 0 });
  });

  it('maps a failed tool response to tool.failed', () => {
    const events = translateHook(
      hook('PostToolUse', {
        tool_name: 'Bash',
        tool_input: { command: 'false' },
        tool_response: { success: false, error: 'command failed' },
      }),
      ctx,
    );
    expect(events[0]?.type).toBe('tool.failed');
    expect(events[0]?.payload.error_excerpt).toContain('command failed');
  });

  it('maps Notification to waiting_permission and Stop to idle', () => {
    expect(
      translateHook(hook('Notification', { message: 'needs permission' }), ctx)[0]?.payload,
    ).toMatchObject({ status: 'waiting_permission', detail: 'needs permission' });
    expect(translateHook(hook('Stop'), ctx)[0]?.payload).toMatchObject({ status: 'idle' });
  });

  it('maps SessionEnd reasons to protocol end reasons', () => {
    expect(
      translateHook(hook('SessionEnd', { reason: 'prompt_input_exit' }), ctx)[0]?.payload.reason,
    ).toBe('interrupted');
    expect(translateHook(hook('SessionEnd', { reason: 'logout' }), ctx)[0]?.payload.reason).toBe(
      'completed',
    );
  });

  it('emits nothing for unknown hooks (no fabricated activity)', () => {
    expect(translateHook(hook('SomeFutureHook'), ctx)).toEqual([]);
  });

  it('throws AdapterError on malformed input', () => {
    expect(() => translateHook({ hook_event_name: 'Stop' }, ctx)).toThrowError(AdapterError);
    expect(() => translateHook(null, ctx)).toThrowError(AdapterError);
  });
});

describe('adapter contract guarantees', () => {
  const fixtures: Record<string, unknown>[] = [
    hook('SessionStart', { source: 'startup' }),
    hook('UserPromptSubmit', { prompt: 'refactor auth' }),
    hook('PreToolUse', { tool_name: 'Read', tool_input: { file_path: '/repo/a.ts' } }),
    hook('PostToolUse', {
      tool_name: 'Edit',
      tool_input: { file_path: '/repo/a.ts' },
      tool_response: { success: true },
    }),
    hook('PostToolUse', {
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
      tool_response: { stdout: 'a.ts' },
    }),
    hook('PostToolUse', {
      tool_name: 'Bash',
      tool_input: { command: 'x' },
      tool_response: { success: false, error: 'boom' },
    }),
    hook('Notification', { message: 'permission' }),
    hook('Stop'),
    hook('SessionEnd', { reason: 'logout' }),
  ];

  it('every translated event validates against the protocol catalog', () => {
    for (const fixture of fixtures) {
      for (const event of translateHook(fixture, ctx)) {
        expect(() => parseEvent(toEnvelope(event))).not.toThrow();
      }
    }
  });

  it('only emits types declared in the capability manifest', () => {
    const declared = new Set(CAPABILITY_MANIFEST.emittedTypes);
    for (const fixture of fixtures) {
      for (const event of translateHook(fixture, ctx)) {
        expect(declared.has(event.type)).toBe(true);
      }
    }
    expect(CAPABILITY_MANIFEST.fidelity).toBe('high');
    expect(CAPABILITY_MANIFEST.enforcement).toMatchObject({
      preToolUse: true,
      mode: 'sync',
      hardBlock: true,
    });
  });

  it('builds a Claude Code PreToolUse deny response (hard enforcement boundary)', () => {
    const decision = denyPreToolUse('reserved by another task');
    expect(decision).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'reserved by another task',
      },
    });
  });
});
