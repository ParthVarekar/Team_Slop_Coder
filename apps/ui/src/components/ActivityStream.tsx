import { Virtuoso } from 'react-virtuoso';
import type { StreamGroup } from '../lib/group.js';
import { ActivityIcon } from './icons.js';
import { StreamGroupRow } from './StreamGroupRow.js';

export function ActivityStream({
  groups,
  selectedEventId,
  onSelect,
}: {
  groups: StreamGroup[];
  selectedEventId: string | null;
  onSelect: (id: string) => void;
}) {
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
    <Virtuoso
      className="h-full"
      data={groups}
      followOutput="smooth"
      alignToBottom
      computeItemKey={(_index, group) => group.id}
      itemContent={(_index, group) => (
        <StreamGroupRow group={group} selectedEventId={selectedEventId} onSelect={onSelect} />
      )}
    />
  );
}