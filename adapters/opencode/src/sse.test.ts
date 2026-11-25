import { describe, expect, it } from 'vitest';
import { ulid, makeId, parseEvent, type EventEnvelope } from '@weft/protocol';
import {
  OpenCodeTranslator,
  translateEvent,
  AdapterError,
  type AdapterContext,
  type AdapterEvent,
} from './sse.js';
import { CAPABILITY_MANIFEST } from './manifest.js';

// Fixtures mirror the authoritative OpenCode durable session-event schema
// (opencode packages/schema/src/session-event.ts). Wire frame:
// { id, type, created, data: { sessionID, ... }, durable: { aggregateID, seq, version } }.
// Tool name lives in session.tool.input.started; input in session.tool.called;
// result in session.tool.success/failed — correlated by the tool-call id.
const ctx: AdapterContext = {
  deviceId: makeId('device'),
  projectId: makeId('project'),
  userId: makeId('user'),
  cwd: '/workspace',
  model: 'anthropic/claude-sonnet-4-5',
};

const SID = 'ses_opencode_7f3a';

function frame(type: string, data: Record<string, unknown> = {}, seq = 1): Record<string, unknown> {
  return {
    id: ulid(),
    type,
    created: '2026-11-07T21:31:10.001Z',
    data: { sessionID: SID, ...data },
    durable: { aggregateID: SID, seq, version: 1 },
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

describe('OpenCode SSE translation', () => {
  it('maps session.created to session.started with high fidelity and model ref', () => {
    const events = translateEvent(
      frame('session.created', {
        projectID: 'proj_1',
        location: { directory: '/workspace' },
        slug: 'fix-auth',
        model: { providerID: 'anthropic', modelID: 'claude-sonnet-4-5' },
        version: '0.15.0',
      }),
      ctx,
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('session.started');
    expect(events[0]?.payload).toMatchObject({
      cwd: '/workspace',
      fidelity: 'high',
      model: 'anthropic/claude-sonnet-4-5',
      provider_version: '0.15.0',
    });
    expect(events[0]?.agent).toMatchObject({ provider: 'opencode', adapter: 'sse@0.0.0' });
    expect(events[0]?.providerSessionId).toBe(SID);
  });

  it('maps execution lifecycle to running / idle / error / interrupted status', () => {
    const t = new OpenCodeTranslator(ctx);
    expect(t.translate(frame('session.execution.started'))[0]?.payload).toMatchObject({
      status: 'running',
    });
    expect(t.translate(frame('session.execution.succeeded'))[0]?.payload).toMatchObject({
      status: 'idle',
    });
    expect(
      t.translate(
        frame('session.execution.failed', { error: { name: 'APIError', message: 'rate limited' } }),
      )[0]?.payload,
    ).toMatchObject({ status: 'idle', detail: 'error: rate limited' });
    expect(
      t.translate(frame('session.execution.interrupted', { reason: 'user' }))[0]?.payload,
    ).toMatchObject({ status: 'idle', detail: 'interrupted:user' });
  });

  it('maps session.deleted to session.ended(completed)', () => {
    const events = translateEvent(frame('session.deleted'), ctx);
    expect(events[0]?.type).toBe('session.ended');
    expect(events[0]?.payload.reason).toBe('completed');
  });

  it('correlates tool name across input.started -> called -> success', () => {
    const t = new OpenCodeTranslator(ctx);
    // input.started carries the name but emits nothing (no complete input yet).
    expect(
      t.translate(
        frame('session.tool.input.started', {
          id: 'tool_1',
          name: 'edit',
          assistantMessageID: 'msg_1',
        }),
      ),
    ).toEqual([]);
    const pre = t.translate(
      frame('session.tool.called', {
        id: 'tool_1',
        assistantMessageID: 'msg_1',
        input: { filePath: 'src/dashboard/UserCard.tsx', oldString: 'a', newString: 'b' },
        executed: true,
      }),
    );
    expect(pre).toHaveLength(1);
    expect(pre[0]?.type).toBe('tool.pre');
    expect(pre[0]?.payload).toMatchObject({
      tool_name: 'edit',
      tool_use_id: 'tool_1',
      tool_input_summary: { filePath: 'src/dashboard/UserCard.tsx' },
    });
    // Source-bearing keys (oldString/newString) are never summarized.
    expect(pre[0]?.payload.tool_input_summary).not.toHaveProperty('oldString');

    const post = t.translate(
      frame('session.tool.success', {
        id: 'tool_1',
        assistantMessageID: 'msg_1',
        content: [{ type: 'text', text: 'Edited src/dashboard/UserCard.tsx' }],
        executed: true,
      }),
    );
    expect(post.map((e) => e.type)).toEqual(['tool.post', 'file.changed']);
    expect(post[0]?.payload).toMatchObject({
      tool_name: 'edit',
      success: true,
      tool_use_id: 'tool_1',
    });
    expect(post[1]?.payload).toMatchObject({
      path: 'src/dashboard/UserCard.tsx',
      change_kind: 'modify',
      source: 'agent_tool',
    });
  });

  it('derives tool.post + command.executed from a bash tool success', () => {
    const t = new OpenCodeTranslator(ctx);
    t.translate(frame('session.tool.input.started', { id: 'tool_2', name: 'bash' }));
    t.translate(
      frame('session.tool.called', {
        id: 'tool_2',
        input: { command: 'pnpm test' },
        executed: true,
      }),
    );
    const events = t.translate(
      frame('session.tool.success', {
        id: 'tool_2',
        content: [{ type: 'text', text: 'ok' }],
        metadata: { exitCode: 0 },
        executed: true,
      }),
    );
    expect(events.map((e) => e.type)).toEqual(['tool.post', 'command.executed']);
    expect(events[1]?.payload).toMatchObject({
      command_display: 'pnpm test',
      exit_code: 0,
      cwd: '/workspace',
    });
  });

  it('maps session.tool.failed to tool.failed with the error message', () => {
    const t = new OpenCodeTranslator(ctx);
    t.translate(frame('session.tool.input.started', { id: 'tool_3', name: 'bash' }));
    t.translate(
      frame('session.tool.called', { id: 'tool_3', input: { command: 'false' }, executed: true }),
    );
    const events = t.translate(
      frame('session.tool.failed', {
        id: 'tool_3',
        error: { name: 'ToolError', message: 'boom' },
        executed: true,
      }),
    );
    expect(events.map((e) => e.type)).toEqual(['tool.failed']);
    expect(events[0]?.payload).toMatchObject({ tool_name: 'bash', error_class: 'tool_error' });
    expect(events[0]?.payload.error_excerpt).toContain('boom');
  });

  it('falls back to unknown tool name when input.started was missed (no fabrication)', () => {
    const t = new OpenCodeTranslator(ctx);
    const pre = t.translate(
      frame('session.tool.called', { id: 'orphan', input: { command: 'ls' }, executed: true }),
    );
    expect(pre[0]?.payload.tool_name).toBe('unknown');
    const post = t.translate(
      frame('session.tool.success', { id: 'orphan', content: [{ type: 'text', text: 'a.ts' }] }),
    );
    expect(post[0]?.payload.tool_name).toBe('unknown');
    // No bash command derivation without a known name.
    expect(post.map((e) => e.type)).toEqual(['tool.post']);
  });

  it('caps output_excerpt at the protocol 2048-byte ceiling', () => {
    const t = new OpenCodeTranslator(ctx);
    const huge = 'x'.repeat(10_000);
    t.translate(frame('session.tool.input.started', { id: 'big', name: 'read' }));
    t.translate(
      frame('session.tool.called', { id: 'big', input: { filePath: 'a.ts' }, executed: true }),
    );
    const post = t.translate(
      frame('session.tool.success', { id: 'big', content: [{ type: 'text', text: huge }] }),
    );
    expect(String(post[0]?.payload.output_excerpt).length).toBeLessThanOrEqual(2048);
  });

  it('tracks model.selected for subsequent event provenance', () => {
    const t = new OpenCodeTranslator(ctx);
    t.translate(frame('session.created', { location: { directory: '/workspace' } }));
    expect(
      t.translate(
        frame('session.model.selected', { model: { providerID: 'openai', modelID: 'gpt-5' } }),
      ),
    ).toEqual([]);
    const status = t.translate(frame('session.execution.started'));
    expect(status[0]?.agent).toMatchObject({ model: 'openai/gpt-5' });
  });

  it('emits nothing for diagnostic-only events (no fabricated activity)', () => {
    const t = new OpenCodeTranslator(ctx);
    for (const type of [
      'session.tool.input.ended',
      'session.tool.input.delta',
      'session.tool.progress',
      'session.text.started',
      'session.text.delta',
      'session.reasoning.delta',
      'session.step.started',
      'session.step.ended',
      'session.compaction.started',
      'session.usage.recorded',
      'session.shell.started',
      'session.shell.ended',
      'session.revert.staged',
      'session.skill.activated',
      'session.viewed',
      'session.renamed',
      'session.archived',
      'session.permissions',
    ]) {
      expect(
        t.translate(frame(type, { id: 'x', name: 'edit', text: 'hi', files: ['a.ts'] })),
      ).toEqual([]);
    }
  });

  it('emits nothing for unknown future events', () => {
    expect(translateEvent(frame('session.some.future.event'), ctx)).toEqual([]);
  });

  it('throws AdapterError on malformed frames', () => {
    const t = new OpenCodeTranslator(ctx);
    expect(() => t.translate({ type: 'session.created' })).toThrowError(AdapterError);
    expect(() => t.translate(null)).toThrowError(AdapterError);
    expect(() => t.translate(frame('session.created', { sessionID: '' }))).toThrowError(
      AdapterError,
    );
    expect(() => t.translate({ type: '', data: { sessionID: SID } })).toThrowError(AdapterError);
  });

  it('evicts per-tool state on completion and per-session state on deletion', () => {
    const t = new OpenCodeTranslator(ctx);
    t.translate(frame('session.created', { location: { directory: '/workspace' } }));
    t.translate(frame('session.tool.input.started', { id: 'tool_9', name: 'edit' }));
    t.translate(
      frame('session.tool.called', { id: 'tool_9', input: { filePath: 'a.ts' }, executed: true }),
    );
    t.translate(
      frame('session.tool.success', { id: 'tool_9', content: [{ type: 'text', text: 'ok' }] }),
    );
    // A late success for the same id must not resurrect the remembered name.
    const late = t.translate(
      frame('session.tool.success', { id: 'tool_9', content: [{ type: 'text', text: 'ok' }] }),
    );
    expect(late[0]?.payload.tool_name).toBe('unknown');
    t.translate(frame('session.deleted'));
    const afterDelete = t.translate(frame('session.execution.started'));
    expect(afterDelete[0]?.agent?.model).toBe(ctx.model);
  });
});

describe('adapter contract guarantees', () => {
  // A realistic ordered stream exercising every emitted type.
  const stream: Record<string, unknown>[] = [
    frame(
      'session.created',
      {
        location: { directory: '/workspace' },
        model: { providerID: 'anthropic', modelID: 'claude-sonnet-4-5' },
        version: '0.15.0',
      },
      1,
    ),
    frame('session.execution.started', {}, 2),
    frame('session.tool.input.started', { id: 't1', name: 'edit', assistantMessageID: 'm1' }, 3),
    frame(
      'session.tool.called',
      {
        id: 't1',
        assistantMessageID: 'm1',
        input: { filePath: 'src/a.ts', oldString: 'x', newString: 'y' },
        executed: true,
      },
      4,
    ),
    frame(
      'session.tool.success',
      {
        id: 't1',
        assistantMessageID: 'm1',
        content: [{ type: 'text', text: 'edited' }],
        executed: true,
      },
      5,
    ),
    frame('session.tool.input.started', { id: 't2', name: 'bash', assistantMessageID: 'm1' }, 6),
    frame(
      'session.tool.called',
      { id: 't2', assistantMessageID: 'm1', input: { command: 'pnpm test' }, executed: true },
      7,
    ),
    frame(
      'session.tool.success',
      {
        id: 't2',
        assistantMessageID: 'm1',
        content: [{ type: 'text', text: 'ok' }],
        metadata: { exitCode: 0 },
        executed: true,
      },
      8,
    ),
    frame('session.tool.input.started', { id: 't3', name: 'bash', assistantMessageID: 'm1' }, 9),
    frame(
      'session.tool.called',
      { id: 't3', assistantMessageID: 'm1', input: { command: 'false' }, executed: true },
      10,
    ),
    frame(
      'session.tool.failed',
      { id: 't3', assistantMessageID: 'm1', error: { message: 'boom' }, executed: true },
      11,
    ),
    frame('session.execution.succeeded', {}, 12),
    frame('session.deleted', {}, 13),
  ];

  it('every translated event validates against the protocol catalog', () => {
    const t = new OpenCodeTranslator(ctx);
    for (const f of stream) {
      for (const event of t.translate(f)) {
        expect(() => parseEvent(toEnvelope(event))).not.toThrow();
      }
    }
  });

  it('only emits types declared in the capability manifest', () => {
    const declared = new Set(CAPABILITY_MANIFEST.emittedTypes);
    const t = new OpenCodeTranslator(ctx);
    for (const f of stream) {
      for (const event of t.translate(f)) {
        expect(declared.has(event.type)).toBe(true);
      }
    }
    expect(CAPABILITY_MANIFEST.fidelity).toBe('high');
    // Observe-only SSE: never a hard enforcement boundary.
    expect(CAPABILITY_MANIFEST.enforcement).toMatchObject({
      preToolUse: false,
      mode: 'none',
      hardBlock: false,
    });
    expect(CAPABILITY_MANIFEST.transport).toContain('sse');
  });
});
