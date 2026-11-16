import { useMemo } from 'react';
import { filterEvents, useStore } from '../store/useStore.js';
import { groupEvents } from '../lib/group.js';
import { ActivityStream } from './ActivityStream.js';
import { Filters } from './Filters.js';

export function StreamWorkspace() {
  const events = useStore((s) => s.events);
  const filters = useStore((s) => s.filters);
  const selectedEventId = useStore((s) => s.selectedEventId);
  const selectEvent = useStore((s) => s.selectEvent);
  const status = useStore((s) => s.status);
  const mode = useStore((s) => s.mode);

  const filtered = useMemo(() => filterEvents(events, filters), [events, filters]);
  const groups = useMemo(() => groupEvents(filtered), [filtered]);

  return (
    <main className="flex min-w-0 flex-1 flex-col bg-canvas">
      <header className="flex h-11 shrink-0 items-center gap-3 border-b border-line px-4">
        <h1 className="text-sm font-semibold text-fg">{mode === 'team' ? 'Team activity' : 'Activity'}</h1>
        <span className="font-mono text-[11px] text-fg-subtle">
          {filtered.length} events · {groups.length} groups
        </span>
        <span className="ml-auto flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-fg-subtle">
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              status === 'live' ? 'bg-success' : status === 'offline' ? 'bg-danger' : 'bg-attention'
            }`}
          />
          {status === 'live' ? 'streaming' : status}
        </span>
      </header>
      <Filters />
      <div className="min-h-0 flex-1">
        <ActivityStream groups={groups} selectedEventId={selectedEventId} onSelect={selectEvent} />
      </div>
    </main>
  );
}