import { useMemo } from 'react';
import { useStore } from '../store/useStore.js';
import { categoryLabel, categoryOf, shortId } from '../lib/format.js';
import { CloseIcon, SearchIcon } from './icons.js';

function Chip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <span className="flex items-center gap-1 rounded-full border border-accent/40 bg-accent/10 py-0.5 pl-2 pr-1 text-[10px] text-accent">
      <span className="max-w-[140px] truncate">{label}</span>
      <button
        type="button"
        aria-label={`Remove ${label} filter`}
        onClick={onRemove}
        className="flex h-3.5 w-3.5 items-center justify-center rounded-full hover:bg-accent/20"
      >
        <CloseIcon size={9} />
      </button>
    </span>
  );
}

export function Filters() {
  const filters = useStore((s) => s.filters);
  const setFilter = useStore((s) => s.setFilter);
  const clearFilters = useStore((s) => s.clearFilters);
  const events = useStore((s) => s.events);
  const sessions = useStore((s) => s.sessions);
  const repos = useStore((s) => s.repos);
  const tasks = useStore((s) => s.tasks);

  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const e of events) set.add(categoryOf(e.type));
    return [...set].sort();
  }, [events]);

  const sessionLabel = filters.session
    ? (sessions.find((s) => s.session_id === filters.session)?.provider_id ??
      shortId(filters.session))
    : null;
  const repoLabel = filters.repo
    ? (repos.find((r) => r.repo_id === filters.repo)?.name ?? shortId(filters.repo))
    : null;
  const taskLabel = filters.task
    ? (tasks.find((t) => t.task_id === filters.task)?.title ?? shortId(filters.task))
    : null;

  const hasFilters =
    filters.category || filters.session || filters.repo || filters.task || filters.search;

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line bg-canvas px-3 py-2">
      <div className="relative flex min-w-[180px] flex-1 items-center">
        <SearchIcon size={13} className="pointer-events-none absolute left-2 text-fg-subtle" />
        <input
          value={filters.search}
          onChange={(e) => setFilter({ search: e.target.value })}
          placeholder="Search events…"
          className="w-full rounded-md border border-line bg-canvas-inset py-1 pl-7 pr-2 text-xs text-fg outline-none placeholder:text-fg-subtle focus:border-accent"
        />
      </div>

      <select
        value={filters.category ?? ''}
        onChange={(e) => setFilter({ category: e.target.value || null })}
        className="rounded-md border border-line bg-canvas-inset px-2 py-1 text-[11px] text-fg outline-none focus:border-accent"
      >
        <option value="">All categories</option>
        {categories.map((c) => (
          <option key={c} value={c}>
            {categoryLabel(c)}
          </option>
        ))}
      </select>

      {sessionLabel && (
        <Chip label={`session: ${sessionLabel}`} onRemove={() => setFilter({ session: null })} />
      )}
      {repoLabel && <Chip label={`repo: ${repoLabel}`} onRemove={() => setFilter({ repo: null })} />}
      {taskLabel && <Chip label={`task: ${taskLabel}`} onRemove={() => setFilter({ task: null })} />}

      {hasFilters && (
        <button
          type="button"
          onClick={clearFilters}
          className="rounded px-2 py-1 text-[11px] text-fg-muted hover:text-fg"
        >
          Clear
        </button>
      )}
    </div>
  );
}