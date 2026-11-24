import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { filterEvents, useStore, type Filters } from './useStore.js';
import type { WeftEvent } from '../lib/types.js';

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
    actor: { user_id: 'user_test', agent: null },
    privacy: 'metadata',
    payload: {},
    ...extra,
  };
}

const EMPTY: Filters = { category: null, session: null, repo: null, task: null, search: '' };

beforeEach(() => {
  vi.useFakeTimers();
  useStore.setState({
    events: [],
    cursor: 0,
    filters: EMPTY,
    selectedEventId: null,
    compactionNotice: null,
    selectedSessionId: null,
    selectedTaskId: null,
  });
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

describe('store ingest (render-count guarantees)', () => {
  it('coalesces a burst into one bounded render batch', () => {
    let renders = 0;
    const unsubscribe = useStore.subscribe((state, previous) => {
      if (state.events !== previous.events) renders++;
    });
    for (let i = 0; i < 100; i++) useStore.getState().ingest(ev('tool.post'));
    expect(renders).toBe(0);
    vi.advanceTimersByTime(50);
    expect(renders).toBe(1);
    expect(useStore.getState().events).toHaveLength(100);
    unsubscribe();
  });

  it('deduplicates by event_id so an event renders once', () => {
    const e = ev('tool.post');
    useStore.getState().ingest(e);
    useStore.getState().ingest(e);
    vi.advanceTimersByTime(50);
    expect(useStore.getState().events).toHaveLength(1);
  });

  it('advances the resume cursor from the highest rowid', () => {
    useStore.getState().ingest(ev('tool.post', { rowid: 5 }));
    useStore.getState().ingest(ev('tool.post', { rowid: 3 }));
    useStore.getState().ingest(ev('tool.post', { rowid: 9 }));
    vi.advanceTimersByTime(50);
    expect(useStore.getState().cursor).toBe(9);
  });

  it('caps the buffer at 5000 and evicts the oldest events', () => {
    const ingest = useStore.getState().ingest;
    let firstId = '';
    for (let i = 0; i < 5001; i++) {
      const e = ev('tool.post');
      if (i === 0) firstId = e.event_id;
      ingest(e);
    }
    vi.advanceTimersByTime(50);
    const events = useStore.getState().events;
    expect(events).toHaveLength(5000);
    expect(events.some((e) => e.event_id === firstId)).toBe(false);
  });
});

describe('compaction notices', () => {
  it('records a control notice without ingesting a fake event or moving the cursor', () => {
    useStore
      .getState()
      .noticeCompaction({ sequenceKind: 'rowid', seqStart: 2, seqEnd: 4, receivedAt: 1 });
    expect(useStore.getState().compactionNotice).toMatchObject({ seqStart: 2, seqEnd: 4 });
    expect(useStore.getState().events).toEqual([]);
    expect(useStore.getState().cursor).toBe(0);
    useStore.getState().clearCompactionNotice();
    expect(useStore.getState().compactionNotice).toBeNull();
  });
});

describe('filterEvents', () => {
  const events = [
    ev('tool.post', { session_id: 's1', repo_id: 'r1', payload: { tool_name: 'Read' } }),
    ev('file.changed', { session_id: 's1', repo_id: 'r1', payload: { path: 'src/a.ts' } }),
    ev('task.created', { session_id: 's2', task_id: 't1' }),
    ev('commit.created', { repo_id: 'r2' }),
  ];

  it('returns the same reference when no filters are active', () => {
    expect(filterEvents(events, EMPTY)).toBe(events);
  });

  it('filters by category prefix', () => {
    expect(filterEvents(events, { ...EMPTY, category: 'tool' })).toHaveLength(1);
    expect(filterEvents(events, { ...EMPTY, category: 'file' })[0]?.type).toBe('file.changed');
  });

  it('filters by session, repo and task', () => {
    expect(filterEvents(events, { ...EMPTY, session: 's1' })).toHaveLength(2);
    expect(filterEvents(events, { ...EMPTY, repo: 'r2' })).toHaveLength(1);
    expect(filterEvents(events, { ...EMPTY, task: 't1' })).toHaveLength(1);
  });

  it('searches type, summary and path case-insensitively', () => {
    expect(filterEvents(events, { ...EMPTY, search: 'SRC/A.TS' })).toHaveLength(1);
    expect(filterEvents(events, { ...EMPTY, search: 'read' })).toHaveLength(1);
    expect(filterEvents(events, { ...EMPTY, search: 'nomatch' })).toHaveLength(0);
  });

  it('combines filters conjunctively', () => {
    expect(filterEvents(events, { ...EMPTY, session: 's1', category: 'file' })).toHaveLength(1);
    expect(filterEvents(events, { ...EMPTY, session: 's2', category: 'file' })).toHaveLength(0);
  });
});

describe('selection side-effects', () => {
  it('selectSession scopes the stream and clears event/task selection', () => {
    useStore.setState({ selectedEventId: 'e', selectedTaskId: 't' });
    useStore.getState().selectSession('s1');
    const s = useStore.getState();
    expect(s.filters.session).toBe('s1');
    expect(s.selectedSessionId).toBe('s1');
    expect(s.selectedEventId).toBeNull();
    expect(s.selectedTaskId).toBeNull();
  });

  it('selectTask scopes the stream by task_id', () => {
    useStore.getState().selectTask('t1');
    expect(useStore.getState().filters.task).toBe('t1');
    expect(useStore.getState().selectedTaskId).toBe('t1');
  });

  it('setFilter merges and clearFilters resets', () => {
    useStore.getState().setFilter({ category: 'tool', search: 'read' });
    expect(useStore.getState().filters).toMatchObject({ category: 'tool', search: 'read' });
    useStore.getState().clearFilters();
    expect(useStore.getState().filters).toEqual(EMPTY);
  });
});
