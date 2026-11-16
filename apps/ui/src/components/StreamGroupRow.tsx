import { useState } from 'react';
import type { StreamGroup } from '../lib/group.js';
import { categoryColor, categoryLabel, formatClock } from '../lib/format.js';
import { actorLabel } from '../lib/types.js';
import { ChevronIcon } from './icons.js';
import { EventRow } from './EventRow.js';

export function StreamGroupRow({
  group,
  selectedEventId,
  onSelect,
}: {
  group: StreamGroup;
  selectedEventId: string | null;
  onSelect: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const single = group.events.length === 1;
  const first = group.events[0];
  const color = categoryColor(group.category);

  if (single && first) {
    return (
      <div className="border-l-2" style={{ borderColor: color }}>
        <EventRow
          event={first}
          selected={selectedEventId === first.event_id}
          onSelect={onSelect}
        />
      </div>
    );
  }

  const containsSelected = group.events.some((e) => e.event_id === selectedEventId);

  return (
    <div className="border-l-2" style={{ borderColor: color }}>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className={`flex w-full items-center gap-2.5 px-3 py-1.5 text-left transition-colors ${
          containsSelected ? 'bg-accent/10' : 'hover:bg-canvas-subtle/70'
        }`}
      >
        <ChevronIcon
          size={12}
          className={`shrink-0 text-fg-subtle transition-transform ${expanded ? 'rotate-90' : ''}`}
        />
        <span className="w-[68px] shrink-0 font-mono text-[10px] tabular-nums text-fg-subtle">
          {formatClock(group.startTs)}
        </span>
        <span
          className="shrink-0 rounded px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide"
          style={{ color, backgroundColor: '#ffffff0d' }}
        >
          {categoryLabel(group.category)}
        </span>
        <span className="min-w-0 flex-1 truncate text-[12px] text-fg">{group.label}</span>
        <span className="shrink-0 rounded-full bg-canvas-inset px-1.5 py-0.5 font-mono text-[10px] text-fg-muted">
          {group.events.length}
        </span>
        {first && (
          <span className="shrink-0 text-[9px] uppercase tracking-wide text-fg-subtle">
            {actorLabel(first.actor)}
          </span>
        )}
      </button>
      {expanded && (
        <div className="border-t border-line-muted bg-canvas-inset/40">
          {group.events.map((e) => (
            <EventRow
              key={e.event_id}
              event={e}
              selected={selectedEventId === e.event_id}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </div>
  );
}