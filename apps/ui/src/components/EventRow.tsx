import { actorLabel, type WeftEvent } from '../lib/types.js';
import { categoryColor, categoryOf, eventSummary, formatClock } from '../lib/format.js';

export function EventRow({
  event,
  selected,
  onSelect,
}: {
  event: WeftEvent;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const category = categoryOf(event.type);
  return (
    <button
      type="button"
      onClick={() => onSelect(event.event_id)}
      className={`flex w-full items-center gap-2.5 px-3 py-1.5 text-left transition-colors ${
        selected ? 'bg-accent/15' : 'hover:bg-canvas-subtle/70'
      }`}
    >
      <span className="w-[68px] shrink-0 font-mono text-[10px] tabular-nums text-fg-subtle">
        {formatClock(event.ts)}
      </span>
      <span
        className="h-1.5 w-1.5 shrink-0 rounded-full"
        style={{ backgroundColor: categoryColor(category) }}
      />
      <span className="w-[110px] shrink-0 truncate font-mono text-[11px] text-fg-muted">
        {event.type}
      </span>
      <span className="min-w-0 flex-1 truncate text-[12px] text-fg">{eventSummary(event)}</span>
      <span className="shrink-0 rounded bg-canvas-inset px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-fg-subtle">
        {actorLabel(event.actor)}
      </span>
    </button>
  );
}