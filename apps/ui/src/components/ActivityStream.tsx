import { useEffect, useRef } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import type { StreamGroup } from '../lib/group.js';
import { ActivityIcon } from './icons.js';
import { StreamGroupRow } from './StreamGroupRow.js';

export function ActivityStream({
  groups,
  selectedEventId,
  onSelect,
  paused,
  onPausedChange,
}: {
  groups: StreamGroup[];
  selectedEventId: string | null;
  onSelect: (id: string) => void;
  paused: boolean;
  onPausedChange: (paused: boolean) => void;
}) {
  const virtuoso = useRef<VirtuosoHandle>(null);
  useEffect(() => {
    if (!paused) virtuoso.current?.scrollToIndex({ index: 'LAST', behavior: 'auto' });
  }, [groups, paused]);
  if (groups.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
        <ActivityIcon size={32} className="text-fg-subtle" />
        <div className="text-sm font-medium text-fg-muted">No activity matches</div>
        <p className="max-w-xs text-[11px] leading-relaxed text-fg-subtle">
          Events stream here in real time as agents work. Adjust filters or register a repository
          and run an agent to see activity.
        </p>
      </div>
    );
  }

  return (
    <div
      className="relative h-full"
      onWheelCapture={(event) => {
        if (!(event.target as HTMLElement).closest('button') && event.deltaY < 0)
          onPausedChange(true);
      }}
      onTouchMoveCapture={(event) => {
        const touch = event.touches[0];
        const previous = event.changedTouches[0];
        if (touch && previous && touch.clientY > previous.clientY) onPausedChange(true);
      }}
      onKeyDownCapture={(event) => {
        if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) onPausedChange(true);
      }}
      onPointerDownCapture={(event) => {
        const target = event.target as HTMLElement;
        const scroller = target.closest('[data-virtuoso-scroller]');
        if (scroller && event.clientX >= scroller.getBoundingClientRect().right - 20)
          onPausedChange(true);
      }}
    >
      <button
        type="button"
        aria-pressed={paused}
        onClick={() => onPausedChange(!paused)}
        className="absolute right-3 top-2 z-10 rounded-md border border-line bg-canvas px-2 py-1 text-[11px] text-fg-muted shadow-sm hover:border-accent"
      >
        {paused ? 'Stream paused · Resume' : 'Pause stream'}
      </button>
      <Virtuoso
        ref={virtuoso}
        className="h-full"
        data={groups}
        initialTopMostItemIndex={groups.length - 1}
        computeItemKey={(_index, group) => group.id}
        itemContent={(_index, group) => (
          <StreamGroupRow group={group} selectedEventId={selectedEventId} onSelect={onSelect} />
        )}
      />
    </div>
  );
}
