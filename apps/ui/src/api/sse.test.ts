import { describe, expect, it, vi } from 'vitest';
import { SseClient } from './sse.js';
import type { WeftEvent } from '../lib/types.js';

function parser(
  handlers: ConstructorParameters<typeof SseClient>[0],
  options: ConstructorParameters<typeof SseClient>[1],
) {
  const client = new SseClient(handlers, options) as unknown as {
    parse(buffer: string): string;
    cursor: number;
  };
  return { parse: client.parse.bind(client), cursor: () => client.cursor };
}

describe('SSE control frames', () => {
  it('keeps compacted and resync separate from ordinary events and advances numeric ids', () => {
    const onEvent = vi.fn();
    const onCompaction = vi.fn();
    const onResync = vi.fn();
    const { parse, cursor } = parser({ onEvent, onStatus: vi.fn() }, { onCompaction, onResync });
    const event = { event_id: 'e1', type: 'tool.post' } as WeftEvent;
    const remainder = parse(
      'id: 4\nevent: compacted\ndata: {"sequence_kind":"global_seq","seq_start":2,"seq_end":4}\n\n' +
        'event: resync\ndata: {"min_seq":5,"last_seq":8}\n\n' +
        `id: 6\ndata: ${JSON.stringify(event)}\n\n`,
    );
    expect(remainder).toBe('');
    expect(onCompaction).toHaveBeenCalledWith(
      expect.objectContaining({ sequenceKind: 'global_seq', seqStart: 2, seqEnd: 4 }),
    );
    expect(onResync).toHaveBeenCalledWith({ min_seq: 5, last_seq: 8 });
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent).toHaveBeenCalledWith(event);
    expect(cursor()).toBe(6); // the compacted frame's accidental id: 4 is ignored
  });

  it('buffers partial frames and ignores malformed control data', () => {
    const onCompaction = vi.fn();
    const { parse } = parser({ onEvent: vi.fn(), onStatus: vi.fn() }, { onCompaction });
    const partial = parse('event: compacted\ndata: {"sequence_kind":"rowid",');
    expect(partial).toContain('compacted');
    expect(parse(partial + '"seq_start":1,"seq_end":2}\n\n')).toBe('');
    expect(onCompaction).toHaveBeenCalledWith(
      expect.objectContaining({ sequenceKind: 'rowid', seqStart: 1, seqEnd: 2 }),
    );
    expect(() => parse('event: compacted\ndata: nope\n\n')).not.toThrow();
    expect(() =>
      parse('event: compacted\ndata: {"sequence_kind":"mystery","seq_start":1,"seq_end":2}\n\n'),
    ).not.toThrow();
    expect(onCompaction).toHaveBeenCalledTimes(1);
  });
});
