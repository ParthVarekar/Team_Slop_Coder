import { describe, expect, it } from 'vitest';
import { ulid, makeId, parseEvent, type EventEnvelope } from '@weft/protocol';
import { translateEvent, AdapterError, type AdapterContext, type AdapterEvent } from './events.js';
import { CAPABILITY_MANIFEST } from './manifest.js';

// Fixtures mirror the normalized payload a thin external wrapper POSTs for an
// arbitrary CLI agent: session_id + kind, plus optional cwd/model/command/
// exit_code/files/reason/detail. There are no native hooks, so the wrapper only
// reports lifecycle, executed commands, and detected file changes.
const ctx: AdapterContext = {
  deviceId: makeId('device'),
  projectId: makeId('project'),
  userId: makeId('user'),
  cwd: '/workspace',
  model: 'cli-model',
};

function wrap(kind: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session_id: 'cli_123',
    kind,
    cwd: '/workspace',
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

describe('generic-cli wrapper translation', () => {
  it('maps start to session.started with low fidelity', () => {
    const events = translateEvent(wrap('start', { model: 'cli-model' }), ctx);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('session.started');
    expect(events[0]?.payload).toMatchObject({
      cwd: '/workspace',
      fidelity: 'low',
      model: 'cli-model',
    });
    expect(events[0]?.agent).toMatchObject({ provider: 'generic', adapter: 'wrap@0.0.0' });
    expect(events[0]?.providerSessionId).toBe('cli_123');
  });

  it('falls back to ctx.cwd then "." for start, and omits model when unknown', () => {
    const fromCtx = translateEvent({ session_id: 'cli_123', kind: 'start' }, ctx);
    expect(fromCtx[0]?.payload).toMatchObject({
      cwd: '/workspace',
      fidelity: 'low',
      model: 'cli-model',
    });

    const bareCtx: AdapterContext = {
      deviceId: ctx.deviceId,
      projectId: ctx.projectId,
      userId: ctx.userId,
    };
    const dot = translateEvent({ session_id: 'cli_123', kind: 'start' }, bareCtx);
    expect(dot[0]?.payload).toMatchObject({ cwd: '.', fidelity: 'low' });
    expect(dot[0]?.payload.model).toBeUndefined();
    expect(dot[0]?.agent).toMatchObject({ provider: 'generic', adapter: 'wrap@0.0.0' });
  });

  it('maps command with exit_code + files to command.executed then file.changed per path', () => {
    const events = translateEvent(
      wrap('command', {
        command: 'pnpm test',
        exit_code: 0,
        files: [
          { path: 'src/a.ts', change_kind: 'modify' },
          { path: 'src/b.ts', change_kind: 'add' },
          { path: 'src/old.ts' },
        ],
      }),
      ctx,
    );
    expect(events.map((e) => e.type)).toEqual([
      'command.executed',
      'file.changed',
      'file.changed',
      'file.changed',
    ]);
    expect(events[0]?.payload).toMatchObject({
      command_display: 'pnpm test',
      cwd: '/workspace',
      exit_code: 0,
    });
    expect(events.slice(1).map((e) => e.payload)).toMatchObject([
      { path: 'src/a.ts', change_kind: 'modify', source: 'agent_tool' },
      { path: 'src/b.ts', change_kind: 'add', source: 'agent_tool' },
      { path: 'src/old.ts', change_kind: 'modify', source: 'agent_tool' },
    ]);
  });

  it('keeps a non-zero exit to command.executed only (no fabricated session.status)', () => {
    const events = translateEvent(wrap('command', { command: 'false', exit_code: 1 }), ctx);
    expect(events.map((e) => e.type)).toEqual(['command.executed']);
    expect(events[0]?.payload).toMatchObject({ command_display: 'false', exit_code: 1 });
  });

  it('preserves a rename change_kind reported by the wrapper', () => {
    const events = translateEvent(
      wrap('command', { command: 'mv a b', files: [{ path: 'b.ts', change_kind: 'rename' }] }),
      ctx,
    );
    expect(events[1]?.payload).toMatchObject({
      path: 'b.ts',
      change_kind: 'rename',
      source: 'agent_tool',
    });
  });

  it('truncates a long command_display', () => {
    const events = translateEvent(wrap('command', { command: 'x'.repeat(1000) }), ctx);
    const payload = events[0]?.payload as Record<string, unknown>;
    expect(String(payload.command_display).length).toBeLessThanOrEqual(201);
  });

  it('omits exit_code when the wrapper did not report one', () => {
    const events = translateEvent(wrap('command', { command: 'ls' }), ctx);
    expect(events[0]?.type).toBe('command.executed');
    expect(events[0]?.payload.exit_code).toBeUndefined();
  });

  it('maps idle to session.status idle, with optional detail', () => {
    const withDetail = translateEvent(wrap('idle', { detail: 'Done.' }), ctx);
    expect(withDetail[0]?.type).toBe('session.status');
    expect(withDetail[0]?.payload).toMatchObject({ status: 'idle', detail: 'Done.' });

    const noDetail = translateEvent(wrap('idle'), ctx);
    expect(noDetail[0]?.payload).toMatchObject({ status: 'idle' });
    expect(noDetail[0]?.payload.detail).toBeUndefined();
  });

  it('maps end reasons onto the protocol enum (default completed)', () => {
    expect(translateEvent(wrap('end', { reason: 'failed' }), ctx)[0]?.type).toBe('session.ended');
    expect(translateEvent(wrap('end', { reason: 'failed' }), ctx)[0]?.payload).toMatchObject({
      reason: 'failed',
    });
    expect(translateEvent(wrap('end', { reason: 'interrupted' }), ctx)[0]?.payload).toMatchObject({
      reason: 'interrupted',
    });
    expect(translateEvent(wrap('end', { reason: 'crashed' }), ctx)[0]?.payload).toMatchObject({
      reason: 'crashed',
    });
    expect(translateEvent(wrap('end', { reason: 'completed' }), ctx)[0]?.payload).toMatchObject({
      reason: 'completed',
    });
    expect(translateEvent(wrap('end', { reason: 'other' }), ctx)[0]?.payload).toMatchObject({
      reason: 'completed',
    });
    expect(translateEvent(wrap('end'), ctx)[0]?.payload).toMatchObject({ reason: 'completed' });
  });

  it('emits nothing for a command kind without a non-empty command (no fabrication)', () => {
    expect(translateEvent(wrap('command'), ctx)).toEqual([]);
    expect(translateEvent(wrap('command', { command: '' }), ctx)).toEqual([]);
    expect(translateEvent(wrap('command', { files: [{ path: 'a.ts' }] }), ctx)).toEqual([]);
  });

  it('emits nothing for unknown kinds (no fabricated activity)', () => {
    expect(translateEvent(wrap('some_future_kind'), ctx)).toEqual([]);
  });

  it('throws AdapterError on malformed input', () => {
    expect(() => translateEvent({ kind: 'start' }, ctx)).toThrowError(AdapterError);
    expect(() => translateEvent(null, ctx)).toThrowError(AdapterError);
    expect(() => translateEvent({ session_id: '', kind: 'start' }, ctx)).toThrowError(AdapterError);
    expect(() => translateEvent({ session_id: 'cli_123', kind: '' }, ctx)).toThrowError(
      AdapterError,
    );
    expect(() =>
      translateEvent(wrap('command', { command: 'ls', files: [{ path: '' }] }), ctx),
    ).toThrowError(AdapterError);
  });

  it('uses the invalid_event error code', () => {
    try {
      translateEvent(null, ctx);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AdapterError);
      expect((err as AdapterError).code).toBe('invalid_event');
    }
  });
});

describe('adapter contract guarantees', () => {
  const fixtures: Record<string, unknown>[] = [
    wrap('start', { model: 'cli-model' }),
    wrap('start'),
    wrap('command', {
      command: 'pnpm test',
      exit_code: 0,
      files: [
        { path: 'src/a.ts', change_kind: 'modify' },
        { path: 'src/b.ts', change_kind: 'add' },
        { path: 'src/old.ts', change_kind: 'delete' },
        { path: 'src/moved.ts', change_kind: 'rename' },
      ],
    }),
    wrap('command', { command: 'false', exit_code: 1, stdout: '', stderr: 'boom' }),
    wrap('command', { command: 'ls' }),
    wrap('idle', { detail: 'Done.' }),
    wrap('idle'),
    wrap('end', { reason: 'failed' }),
    wrap('end', { reason: 'interrupted' }),
    wrap('end', { reason: 'crashed' }),
    wrap('end', { reason: 'other' }),
    wrap('end'),
  ];

  it('every translated event validates against the protocol catalog', () => {
    for (const fixture of fixtures) {
      for (const event of translateEvent(fixture, ctx)) {
        expect(() => parseEvent(toEnvelope(event))).not.toThrow();
      }
    }
  });

  it('only emits types declared in the capability manifest', () => {
    const declared = new Set(CAPABILITY_MANIFEST.emittedTypes);
    for (const fixture of fixtures) {
      for (const event of translateEvent(fixture, ctx)) {
        expect(declared.has(event.type)).toBe(true);
      }
    }
    expect(CAPABILITY_MANIFEST.fidelity).toBe('low');
    // Observe-only wrapper: no PreToolUse participation, no enforcement boundary.
    expect(CAPABILITY_MANIFEST.enforcement).toMatchObject({
      preToolUse: false,
      mode: 'none',
      hardBlock: false,
    });
  });
});
