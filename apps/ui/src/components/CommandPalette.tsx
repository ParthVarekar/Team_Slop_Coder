import { useMemo } from 'react';
import { Command } from 'cmdk';
import { useStore, type ListTab } from '../store/useStore.js';
import {
  categoryLabel,
  categoryOf,
  notificationKindColor,
  notificationKindLabel,
  shortId,
} from '../lib/format.js';
import { sessionDeveloperLabel } from '../lib/sessions.js';
import {
  InboxIcon,
  ReposIcon,
  SearchIcon,
  SessionsIcon,
  SettingsIcon,
  TasksIcon,
} from './icons.js';

const ITEM =
  'flex cursor-pointer items-center gap-2.5 rounded-md px-3 py-2 text-[12px] text-fg-muted data-[selected=true]:bg-accent/15 data-[selected=true]:text-fg';
const HEADING =
  'px-3 pb-1 pt-3 text-[10px] font-medium uppercase tracking-wide text-fg-subtle [&:not(:first-child)]:pt-4';

export function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const mode = useStore((s) => s.mode);
  const directory = useStore((s) => s.directory);
  const setListTab = useStore((s) => s.setListTab);
  const setFilter = useStore((s) => s.setFilter);
  const clearFilters = useStore((s) => s.clearFilters);
  const refreshLists = useStore((s) => s.refreshLists);
  const selectSession = useStore((s) => s.selectSession);
  const selectTask = useStore((s) => s.selectTask);
  const selectNotification = useStore((s) => s.selectNotification);
  const setSettingsOpen = useStore((s) => s.setSettingsOpen);
  const setRetentionOpen = useStore((s) => s.setRetentionOpen);
  const sessions = useStore((s) => s.sessions);
  const tasks = useStore((s) => s.tasks);
  const repos = useStore((s) => s.repos);
  const notifications = useStore((s) => s.notifications);
  const events = useStore((s) => s.events);

  const team = mode === 'team';

  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const e of events) set.add(categoryOf(e.type));
    return [...set].sort();
  }, [events]);

  const run = (fn: () => void) => () => {
    fn();
    onOpenChange(false);
  };
  const nav = (tab: ListTab) => run(() => setListTab(tab));
  const sessionLabel = (s: (typeof sessions)[number]) =>
    team ? sessionDeveloperLabel(s, directory) : (s.provider_id ?? 'agent');

  return (
    <Command.Dialog
      open={open}
      onOpenChange={onOpenChange}
      label="Command palette"
      overlayClassName="fixed inset-0 z-50 bg-black/60 backdrop-blur-[2px]"
      contentClassName="fixed left-1/2 top-[12%] z-50 w-[min(560px,92vw)] -translate-x-1/2 overflow-hidden rounded-xl border border-line bg-canvas-subtle shadow-2xl"
    >
      <div className="flex items-center gap-2 border-b border-line px-3">
        <SearchIcon size={15} className="text-fg-subtle" />
        <Command.Input
          placeholder={
            team
              ? 'Search commands, sessions, tasks, inbox…'
              : 'Search commands, sessions, tasks, repos…'
          }
          className="w-full bg-transparent py-3 text-[13px] text-fg outline-none placeholder:text-fg-subtle"
        />
      </div>
      <Command.List className="max-h-[360px] overflow-y-auto p-2">
        <Command.Empty className="px-3 py-6 text-center text-[12px] text-fg-subtle">
          No results found.
        </Command.Empty>

        <Command.Group heading="Navigate" className={HEADING}>
          <Command.Item className={ITEM} value="navigate sessions" onSelect={nav('sessions')}>
            <SessionsIcon size={15} /> Sessions
          </Command.Item>
          <Command.Item className={ITEM} value="navigate tasks" onSelect={nav('tasks')}>
            <TasksIcon size={15} /> Tasks
          </Command.Item>
          {team ? (
            <Command.Item
              className={ITEM}
              value="navigate inbox notifications"
              onSelect={nav('inbox')}
            >
              <InboxIcon size={15} /> Inbox
            </Command.Item>
          ) : (
            <Command.Item
              className={ITEM}
              value="navigate repositories repos"
              onSelect={nav('repos')}
            >
              <ReposIcon size={15} /> Repositories
            </Command.Item>
          )}
        </Command.Group>

        <Command.Group heading="Actions" className={HEADING}>
          <Command.Item className={ITEM} value="clear filters reset" onSelect={run(clearFilters)}>
            Clear all filters
          </Command.Item>
          <Command.Item
            className={ITEM}
            value="refresh reload lists"
            onSelect={run(() => void refreshLists())}
          >
            Refresh lists
          </Command.Item>
          <Command.Item className={ITEM} value="new task create" onSelect={nav('tasks')}>
            New task…
          </Command.Item>
          {!team && (
            <Command.Item
              className={ITEM}
              value="register repository add repo"
              onSelect={nav('repos')}
            >
              Register repository…
            </Command.Item>
          )}
          <Command.Item
            className={ITEM}
            value="retention compaction database storage telemetry"
            onSelect={run(() => setRetentionOpen(true))}
          >
            Retention and compaction…
          </Command.Item>
          <Command.Item
            className={ITEM}
            value="connection settings team server configure"
            onSelect={run(() => setSettingsOpen(true))}
          >
            <SettingsIcon size={14} /> Connection settings…
          </Command.Item>
        </Command.Group>

        {categories.length > 0 && (
          <Command.Group heading="Filter by category" className={HEADING}>
            {categories.map((c) => (
              <Command.Item
                key={c}
                className={ITEM}
                value={`category ${categoryLabel(c)} ${c}`}
                onSelect={run(() => setFilter({ category: c }))}
              >
                {categoryLabel(c)}
              </Command.Item>
            ))}
          </Command.Group>
        )}

        {sessions.length > 0 && (
          <Command.Group heading="Sessions" className={HEADING}>
            {sessions.slice(0, 30).map((s) => (
              <Command.Item
                key={s.session_id}
                className={ITEM}
                value={`session ${sessionLabel(s)} ${s.prompt_summary ?? ''} ${shortId(s.session_id)}`}
                onSelect={run(() => selectSession(s.session_id))}
              >
                <SessionsIcon size={14} className="text-fg-subtle" />
                <span className="truncate">{sessionLabel(s)}</span>
                <span className="ml-auto font-mono text-[10px] text-fg-subtle">
                  {shortId(s.session_id)}
                </span>
              </Command.Item>
            ))}
          </Command.Group>
        )}

        {!team && repos.length > 0 && (
          <Command.Group heading="Repositories" className={HEADING}>
            {repos.map((r) => (
              <Command.Item
                key={r.repo_id}
                className={ITEM}
                value={`repo repository ${r.name} ${r.root_path}`}
                onSelect={run(() => setFilter({ repo: r.repo_id }))}
              >
                <ReposIcon size={14} className="text-fg-subtle" />
                <span className="truncate">{r.name}</span>
              </Command.Item>
            ))}
          </Command.Group>
        )}

        {tasks.length > 0 && (
          <Command.Group heading="Tasks" className={HEADING}>
            {tasks.slice(0, 30).map((t) => (
              <Command.Item
                key={t.task_id}
                className={ITEM}
                value={`task ${t.number ?? ''} ${t.title} ${t.state}`}
                onSelect={run(() => selectTask(t.task_id))}
              >
                <TasksIcon size={14} className="text-fg-subtle" />
                <span className="truncate">{t.title}</span>
                <span className="ml-auto shrink-0 text-[10px] uppercase text-fg-subtle">
                  {t.state.replace('_', ' ')}
                </span>
              </Command.Item>
            ))}
          </Command.Group>
        )}

        {team && notifications.length > 0 && (
          <Command.Group heading="Notifications" className={HEADING}>
            {notifications.slice(0, 30).map((n) => (
              <Command.Item
                key={n.id}
                className={ITEM}
                value={`notification inbox ${notificationKindLabel(n.kind)} ${n.kind} ${n.title}`}
                onSelect={run(() => selectNotification(n.id))}
              >
                <span
                  className="h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ backgroundColor: notificationKindColor(n.kind) }}
                />
                <span className="truncate">{n.title}</span>
                <span className="ml-auto shrink-0 text-[10px] uppercase text-fg-subtle">
                  {notificationKindLabel(n.kind)}
                </span>
              </Command.Item>
            ))}
          </Command.Group>
        )}
      </Command.List>
    </Command.Dialog>
  );
}
