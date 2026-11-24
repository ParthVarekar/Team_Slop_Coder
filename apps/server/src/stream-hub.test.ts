import { describe, expect, it, vi } from 'vitest';
import { makeId, ulid, type StoredEvent } from '@weft/protocol';
import { StreamHub } from './stream.js';

function event(projectId: string, globalSeq: number): StoredEvent {
  return {
    v: 1,
    event_id: ulid(),
    device_id: makeId('device'),
    project_id: projectId,
    ts: '2026-01-01T00:00:00.000Z',
    type: 'tool.post',
    actor: { user_id: 'user_test', agent: null },
    privacy: 'metadata',
    payload: { tool_name: 'Read' },
    global_seq: globalSeq,
    received_at: '2026-01-01T00:00:00.001Z',
  };
}

describe('StreamHub committed-frame cache', () => {
  it('shares ordered frames only with the matching project', () => {
    const hub = new StreamHub();
    const projectA = makeId('project');
    const projectB = makeId('project');
    const wakeA = vi.fn();
    const wakeB = vi.fn();
    hub.subscribe(projectA, wakeA);
    hub.subscribe(projectB, wakeB);

    hub.publish([event(projectA, 1), event(projectB, 1), event(projectA, 2)]);

    expect(wakeA).toHaveBeenCalledOnce();
    expect(wakeB).toHaveBeenCalledOnce();
    const cached = hub.cachedAfter(projectA, 0);
    expect(cached.complete).toBe(true);
    expect(cached.frames).toHaveLength(2);
    expect(cached.frames[0]).toMatch(/^id: 1\ndata: /);
    expect(cached.frames[1]).toMatch(/^id: 2\ndata: /);
    expect(JSON.parse(cached.frames[0]!.split('\ndata: ')[1]!)).toMatchObject({
      project_id: projectA,
      global_seq: 1,
    });
  });

  it('falls back across an interior cache gap instead of skipping sequences', () => {
    const hub = new StreamHub();
    const projectId = makeId('project');
    hub.publish([event(projectId, 2)]);
    expect(hub.cachedAfter(projectId, 0)).toEqual({ frames: [], complete: false });

    hub.publish([event(projectId, 1)]);
    const cached = hub.cachedAfter(projectId, 0);
    expect(cached.complete).toBe(true);
    expect(cached.frames.map((frame) => frame.slice(4, frame.indexOf('\n')))).toEqual(['1', '2']);
  });

  it('bounds cached frames while preserving a contiguous recent catch-up path', () => {
    const hub = new StreamHub();
    const projectId = makeId('project');
    hub.publish(Array.from({ length: 10_001 }, (_, index) => event(projectId, index + 1)));

    expect(hub.cachedAfter(projectId, 0)).toEqual({ frames: [], complete: false });
    const recent = hub.cachedAfter(projectId, 5_001);
    expect(recent.frames).toHaveLength(5_000);
    expect(recent.complete).toBe(true);
    expect(recent.frames[0]).toMatch(/^id: 5002\n/);
    expect(recent.frames[4_999]).toMatch(/^id: 10001\n/);
  });
});
