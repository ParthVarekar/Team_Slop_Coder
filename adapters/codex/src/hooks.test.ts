import { describe, expect, it } from 'vitest';
import { ulid, makeId, parseEvent, type EventEnvelope } from '@weft/protocol';
import { translateHook, AdapterError, type AdapterContext, type AdapterEvent } from './hooks.js';
import { CAPABILITY_MANIFEST } from './manifest.js';

// Fixtures mirror the official Codex Hooks wire format (ChatGPT Learn → Hooks:
// "Common input fields" + per-event tables). Codex's schema is Claude-compatible:
// session_id, cwd, hook_event_name, tool_name, tool_input, tool_use_id,
// tool_response, plus Codex extensions model/turn_id/permission_mode.
const ctx: AdapterContext = {
  deviceId: makeId('device'),
  projectId: makeId('project'),
  userId: makeId('user'),
  cwd: '/workspace',
  model: 'gpt-5-codex',
};

function hook(event: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session_id: 'thr_123',
    transcript_path: '/workspace/.codex/rollout.jsonl',
    cwd: '/workspace',
    hook_event_name: event,
    model: 'gpt-5-codex',
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

describe('Codex hook translation', () => {
  it('maps SessionStart to session.started with high fidelity', () => {
    const events = translateHook(
      hook('SessionStart', { source: 'startup', permission_mode: 'default' }),
      ctx,
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('session.started');
    expect(events[0]?.payload).toMatchObject({
      cwd: '/workspace',
      fidelity: 'high',
      model: 'gpt-5-codex',
      source: 'startup',
      permission_mode: 'default',
    });
    expect(events[0]?.agent).toMatchObject({ provider: 'codex', adapter: 'hooks@0.0.0' });
    expect(events[0]?.providerSessionId).toBe('thr_123');
  });

  it('maps UserPromptSubmit to a truncated, hashed prompt.submitted', () => {
    const longPrompt = 'x'.repeat(1000);
    const events = translateHook(
      hook('UserPromptSubmit', { prompt: longPrompt, turn_id: 'turn_1' }),
      ctx,
    );
    expect(events[0]?.type).toBe('prompt.submitted');
    const payload = events[0]?.payload as Record<string, unknown>;
    expect(String(payload.prompt_summary).length).toBeLessThanOrEqual(401);
    expect(payload.prompt_hash).toMatch(/^sha256:/);
  });

  it('maps PreToolUse to tool.pre with a compact input summary', () => {
    const events = translateHook(
      hook('PreToolUse', {
        tool_name: 'Bash',
        tool_use_id: 'call_1',
        turn_id: 'turn_1',
        tool_input: { command: 'pnpm test' },
      }),
      ctx,
    );
    expect(events[0]?.type).toBe('tool.pre');
    expect(events[0]?.payload).toMatchObject({
      tool_name: 'Bash',
      tool_use_id: 'call_1',
      turn_id: 'turn_1',
      tool_input_summary: { command: 'pnpm test' },
    });
  });

  it('maps PermissionRequest to waiting_permission with the approval reason', () => {
    const events = translateHook(
      hook('PermissionRequest', {
        tool_name: 'Bash',
        turn_id: 'turn_1',
        tool_input: { command: 'rm -rf build', description: 'Delete the build directory' },
      }),
      ctx,
    );
    expect(events[0]?.type).toBe('session.status');
    expect(events[0]?.payload).toMatchObject({
      status: 'waiting_permission',
      detail: 'Delete the build directory',
      tool_name: 'Bash',
    });
  });

  it('derives tool.post + command.executed from a PostToolUse Bash', () => {
    const events = translateHook(
      hook('PostToolUse', {
        tool_name: 'Bash',
        tool_use_id: 'call_1',
        tool_input: { command: 'pnpm test' },
        tool_response: { stdout: 'ok', exit_code: 0 },
      }),
      ctx,
    );
    expect(events.map((e) => e.type)).toEqual(['tool.post', 'command.executed']);
    expect(events[1]?.payload).toMatchObject({ command_display: 'pnpm test', exit_code: 0 });
  });

  it('derives tool.post + file.changed per path from a PostToolUse apply_patch', () => {
    const events = translateHook(
      hook('PostToolUse', {
        tool_name: 'apply_patch',
        tool_use_id: 'call_2',
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

  it('marks a non-zero Bash exit as tool.failed (PostToolUse fires on failure)', () => {
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

  it('maps an explicit failure response to tool.failed', () => {
    const events = translateHook(
      hook('PostToolUse', {
        tool_name: 'apply_patch',
        tool_input: { command: PATCH },
        tool_response: { success: false, error: 'patch did not apply' },
      }),
      ctx,
    );
    expect(events[0]?.type).toBe('tool.failed');
    expect(events[0]?.payload.error_excerpt).toContain('patch did not apply');
  });

  it('maps Stop to idle and Interrupt to idle with an interrupted detail', () => {
    expect(
      translateHook(
        hook('Stop', {
          turn_id: 'turn_1',
          stop_hook_active: false,
          last_assistant_message: 'Done.',
        }),
        ctx,
      )[0]?.payload,
    ).toMatchObject({ status: 'idle', detail: 'Done.' });
    expect(translateHook(hook('Interrupt', { turn_id: 'turn_1' }), ctx)[0]?.payload).toMatchObject({
      status: 'idle',
      detail: 'interrupted',
    });
  });

  it('maps the documented SessionEnd example (reason "other") to completed', () => {
    // Verbatim payload from the official Codex Hooks docs.
    const events = translateHook(
      {
        session_id: 'thr_123',
        transcript_path: '/workspace/.codex/rollout.jsonl',
        cwd: '/workspace',
        hook_event_name: 'SessionEnd',
        reason: 'other',
      },
      ctx,
    );
    expect(events[0]?.type).toBe('session.ended');
    expect(events[0]?.payload.reason).toBe('completed');
  });

  it('emits nothing for subagent hooks (parent session_id must not be misrepresented)', () => {
    expect(
      translateHook(hook('SubagentStop', { agent_type: 'reviewer', agent_id: 'sub_1' }), ctx),
    ).toEqual([]);
    expect(
      translateHook(hook('SubagentStart', { agent_type: 'reviewer', agent_id: 'sub_1' }), ctx),
    ).toEqual([]);
  });

  it('emits nothing for diagnostic-only compaction/model hooks (no protocol mapping)', () => {
    expect(translateHook(hook('PreCompact', { trigger: 'auto' }), ctx)).toEqual([]);
    expect(translateHook(hook('PostCompact', { trigger: 'manual' }), ctx)).toEqual([]);
    expect(translateHook(hook('PreModelRequest', { turn_id: 'turn_1' }), ctx)).toEqual([]);
    expect(
      translateHook(
        hook('PostModelRequest', { status: 'completed', token_usage: { total: 10 } }),
        ctx,
      ),
    ).toEqual([]);
  });

  it('emits nothing for unknown hooks (no fabricated activity)', () => {
    expect(translateHook(hook('SomeFutureHook'), ctx)).toEqual([]);
  });

  it('throws AdapterError on malformed input', () => {
    expect(() => translateHook({ hook_event_name: 'Stop' }, ctx)).toThrowError(AdapterError);
    expect(() => translateHook(null, ctx)).toThrowError(AdapterError);
    expect(() => translateHook({ session_id: '', hook_event_name: 'Stop' }, ctx)).toThrowError(
      AdapterError,
    );
  });
});

describe('adapter contract guarantees', () => {
  const fixtures: Record<string, unknown>[] = [
    hook('SessionStart', { source: 'startup' }),
    hook('UserPromptSubmit', { prompt: 'refactor auth', turn_id: 'turn_1' }),
    hook('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } }),
    hook('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'ls' } }),
    hook('PostToolUse', {
      tool_name: 'apply_patch',
      tool_input: { command: PATCH },
      tool_response: { success: true },
    }),
    hook('PostToolUse', {
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
      tool_response: { stdout: 'a.ts', exit_code: 0 },
    }),
    hook('PostToolUse', {
      tool_name: 'Bash',
      tool_input: { command: 'x' },
      tool_response: { stderr: 'boom', exit_code: 1 },
    }),
    hook('Stop', { last_assistant_message: 'Done.' }),
    hook('Interrupt', {}),
    hook('SessionEnd', { reason: 'other' }),
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
    // Fail-open guardrail: participates in PreToolUse but is NOT a hard boundary.
    expect(CAPABILITY_MANIFEST.enforcement).toMatchObject({
      preToolUse: true,
      mode: 'sync',
      hardBlock: false,
    });
  });
});
