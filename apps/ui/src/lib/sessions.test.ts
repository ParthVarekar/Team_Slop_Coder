import { describe, expect, it } from 'vitest';
import { deriveSessions, sessionDeveloperLabel } from './sessions.js';
import type { Actor, WeftEvent } from './types.js';

let counter = 0;
function ev(type: string, extra: Partial<WeftEvent> = {}): WeftEvent {
  counter += 1;
  return {
    event_id: `evt_${counter}`,
    v: 1,
    device_id: 'dev_test',
    project_id: 'proj_test',
    ts: new Date(1_700_000_000_000 + counter * 1000).toISOString(),
    type,
    actor: { user_id: 'user_priya', agent: { provider: 'Claude Code', model: 'opus' } },
    privacy: 'metadata',
    payload: {},
    ...extra,
  };
}

const PRIYA: Actor = { user_id: 'user_priya', agent: { provider: 'Claude Code', model: 'opus' } };
const MARCUS: Actor = { user_id: 'user_marcus', agent: { provider: 'Codex', model: 'gpt-5' } };

describe('deriveSessions', () => {
  it('folds a started event into a running session attributed to its developer', () => {
    const sessions = deriveSessions([
      ev('session.started', {
        session_id: 's1',
        actor: PRIYA,
        payload: { cwd: '/repo', prompt_summary: 'Fix the parser', fidelity: 'high' },
      }),
    ]);
    expect(sessions).toHaveLength(1);
    const s = sessions[0]!;
    expect(s.session_id).toBe('s1');
    expect(s.provider_id).toBe('Claude Code');
    expect(s.developer_id).toBe('user_priya');
    expect(s.model).toBe('opus');
    expect(s.cwd).toBe('/repo');
    expect(s.prompt_summary).toBe('Fix the parser');
    expect(s.status).toBe('running');
    expect(s.ended_at).toBeNull();
  });

  it('applies status then ended in stream order', () => {
    const sessions = deriveSessions([
      ev('session.started', { session_id: 's1', actor: PRIYA }),
      ev('session.status', { session_id: 's1', actor: PRIYA, payload: { status: 'waiting_permission' } }),
      ev('session.ended', { session_id: 's1', actor: PRIYA, payload: { reason: 'completed' } }),
    ]);
    const s = sessions[0]!;
    expect(s.status).toBe('ended');
    expect(s.ended_at).not.toBeNull();
  });

  it('keeps the latest status when no ended event arrives', () => {
    const sessions = deriveSessions([
      ev('session.started', { session_id: 's1', actor: PRIYA }),
      ev('session.status', { session_id: 's1', actor: PRIYA, payload: { status: 'idle' } }),
    ]);
    expect(sessions[0]!.status).toBe('idle');
    expect(sessions[0]!.ended_at).toBeNull();
  });

  it('attributes sessions from different developers independently', () => {
    const sessions = deriveSessions([
      ev('session.started', { session_id: 's1', actor: PRIYA }),
      ev('session.started', { session_id: 's2', actor: MARCUS }),
    ]);
    expect(sessions).toHaveLength(2);
    const byId = new Map(sessions.map((s) => [s.session_id, s]));
    expect(byId.get('s1')!.developer_id).toBe('user_priya');
    expect(byId.get('s1')!.provider_id).toBe('Claude Code');
    expect(byId.get('s2')!.developer_id).toBe('user_marcus');
    expect(byId.get('s2')!.provider_id).toBe('Codex');
  });

  it('ignores status/ended whose started event was evicted', () => {
    const sessions = deriveSessions([
      ev('session.status', { session_id: 'gone', payload: { status: 'idle' } }),
      ev('session.ended', { session_id: 'gone', payload: { reason: 'completed' } }),
    ]);
    expect(sessions).toHaveLength(0);
  });

  it('ignores non-session events and events without a session_id', () => {
    const sessions = deriveSessions([
      ev('tool.post', { session_id: 's1' }),
      ev('session.started'),
      ev('file.changed', { session_id: 's1' }),
    ]);
    expect(sessions).toHaveLength(0);
  });

  it('falls back to payload provider_id and null developer for a system actor', () => {
    const sessions = deriveSessions([
      ev('session.started', {
        session_id: 's1',
        actor: { system: 'watcher' },
        payload: { provider_id: 'OpenCode', cwd: '/repo' },
      }),
    ]);
    const s = sessions[0]!;
    expect(s.provider_id).toBe('OpenCode');
    expect(s.developer_id).toBeNull();
    expect(s.model).toBeNull();
  });

  it('returns sessions sorted by started_at descending', () => {
    const sessions = deriveSessions([
      ev('session.started', { session_id: 'old', ts: '2026-01-01T00:00:00.000Z' }),
      ev('session.started', { session_id: 'new', ts: '2026-02-01T00:00:00.000Z' }),
      ev('session.started', { session_id: 'mid', ts: '2026-01-15T00:00:00.000Z' }),
    ]);
    expect(sessions.map((s) => s.session_id)).toEqual(['new', 'mid', 'old']);
  });

  it('is order-stable: identical input yields identical rows', () => {
    const events = [
      ev('session.started', { session_id: 's1', actor: PRIYA }),
      ev('session.status', { session_id: 's1', actor: PRIYA, payload: { status: 'idle' } }),
    ];
    expect(deriveSessions(events)).toEqual(deriveSessions(events));
  });
});

describe('sessionDeveloperLabel', () => {
  const directory = [
    { userId: 'user_priya', displayName: 'Priya' },
    { userId: 'user_marcus', displayName: 'Marcus' },
  ];
  const base = deriveSessions([ev('session.started', { session_id: 's1', actor: PRIYA })])[0]!;

  it('renders "provider for name" when the directory resolves the developer', () => {
    expect(sessionDeveloperLabel(base, directory)).toBe('Claude Code for Priya');
  });

  it('renders the provider alone when the developer is unknown to the directory', () => {
    expect(sessionDeveloperLabel(base, [{ userId: 'someone_else', displayName: 'Else' }])).toBe(
      'Claude Code',
    );
  });

  it('falls back to "agent" as the provider but still attributes the developer', () => {
    expect(sessionDeveloperLabel({ ...base, provider_id: null }, directory)).toBe('agent for Priya');
  });

  it('renders the provider alone when the session has no developer_id', () => {
    expect(sessionDeveloperLabel({ ...base, developer_id: null }, directory)).toBe('Claude Code');
  });
});