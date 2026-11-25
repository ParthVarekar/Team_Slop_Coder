import { describe, expect, it } from 'vitest';
import { GROUP_WINDOW_MS, MAX_GROUP_SIZE, groupEvents } from './group.js';
import type { WeftEvent } from './types.js';

let counter = 0;
function ev(type: string, opts: Partial<WeftEvent> = {}): WeftEvent {
  counter += 1;
  return {
    event_id: `evt_${String(counter).padStart(6, '0')}`,
    v: 1,
    device_id: 'dev_test',
    project_id: 'proj_test',
    ts: new Date(Date.UTC(2026, 0, 1, 0, 0, counter)).toISOString(),
    type,
    actor: { user_id: 'user_test', agent: null },
    privacy: 'metadata',
    payload: {},
    ...opts,
  };
}

describe('groupEvents', () => {
  it('returns no groups for empty input', () => {
    expect(groupEvents([])).toEqual([]);
  });

  it('wraps a single event in a group labelled by its summary', () => {
    const groups = groupEvents([
      ev('file.changed', { payload: { path: 'a.ts', change_kind: 'modify' } }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.events).toHaveLength(1);
    expect(groups[0]?.label).toBe('modify a.ts');
    expect(groups[0]?.id).toBe(groups[0]?.events[0]?.event_id);
  });

  it('groups consecutive same-tool events within one session', () => {
    const events = [
      ev('tool.post', { session_id: 's1', payload: { tool_name: 'Edit' } }),
      ev('tool.post', { session_id: 's1', payload: { tool_name: 'Edit' } }),
      ev('tool.post', { session_id: 's1', payload: { tool_name: 'Edit' } }),
    ];
    const groups = groupEvents(events);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.events).toHaveLength(3);
    expect(groups[0]?.label).toBe('Edit × 3');
    expect(groups[0]?.sessionId).toBe('s1');
  });

  it('splits on session change', () => {
    const events = [
      ev('tool.post', { session_id: 's1', payload: { tool_name: 'Edit' } }),
      ev('tool.post', { session_id: 's2', payload: { tool_name: 'Edit' } }),
    ];
    expect(groupEvents(events)).toHaveLength(2);
  });

  it('splits on category change', () => {
    const events = [
      ev('tool.post', { session_id: 's1', payload: { tool_name: 'Edit' } }),
      ev('file.changed', { session_id: 's1', payload: { path: 'a.ts' } }),
    ];
    expect(groupEvents(events)).toHaveLength(2);
  });

  it('splits on sub-key change within a category', () => {
    const events = [
      ev('file.changed', { payload: { path: 'a.ts' } }),
      ev('file.changed', { payload: { path: 'b.ts' } }),
    ];
    expect(groupEvents(events)).toHaveLength(2);
  });

  it('splits when the time window is exceeded', () => {
    const base = Date.UTC(2026, 0, 1, 0, 0, 0);
    const events = [
      ev('tool.post', { ts: new Date(base).toISOString(), payload: { tool_name: 'Edit' } }),
      ev('tool.post', {
        ts: new Date(base + GROUP_WINDOW_MS + 1000).toISOString(),
        payload: { tool_name: 'Edit' },
      }),
    ];
    expect(groupEvents(events)).toHaveLength(2);
  });

  it('only groups consecutive events (interleaving breaks the run)', () => {
    const events = [
      ev('tool.post', { payload: { tool_name: 'Edit' } }),
      ev('tool.post', { payload: { tool_name: 'Read' } }),
      ev('tool.post', { payload: { tool_name: 'Edit' } }),
    ];
    expect(groupEvents(events)).toHaveLength(3);
  });

  it('caps group size', () => {
    const ts = new Date(Date.UTC(2026, 0, 1, 0, 0, 0)).toISOString();
    const events = Array.from({ length: MAX_GROUP_SIZE + 5 }, () =>
      ev('tool.post', { ts, payload: { tool_name: 'Edit' } }),
    );
    const groups = groupEvents(events);
    expect(groups).toHaveLength(2);
    expect(groups[0]?.events).toHaveLength(MAX_GROUP_SIZE);
    expect(groups[1]?.events).toHaveLength(5);
  });

  it('is deterministic across runs', () => {
    const events = [
      ev('session.started', { session_id: 's1', payload: { cwd: '/r', fidelity: 'high' } }),
      ev('tool.post', { session_id: 's1', payload: { tool_name: 'Edit' } }),
      ev('tool.post', { session_id: 's1', payload: { tool_name: 'Edit' } }),
      ev('file.changed', { session_id: 's1', payload: { path: 'a.ts' } }),
    ];
    expect(groupEvents(events)).toEqual(groupEvents(events));
  });
});
