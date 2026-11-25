import { useStore, type ListTab } from '../store/useStore.js';
import type { ConnectionStatus } from '../lib/types.js';
import {
  CommandIcon,
  InboxIcon,
  ReposIcon,
  SessionsIcon,
  SettingsIcon,
  TasksIcon,
} from './icons.js';

const LOCAL_NAV: { tab: ListTab; label: string; Icon: typeof SessionsIcon }[] = [
  { tab: 'sessions', label: 'Sessions', Icon: SessionsIcon },
  { tab: 'tasks', label: 'Tasks', Icon: TasksIcon },
  { tab: 'repos', label: 'Repositories', Icon: ReposIcon },
];

const TEAM_NAV: { tab: ListTab; label: string; Icon: typeof SessionsIcon }[] = [
  { tab: 'sessions', label: 'Sessions', Icon: SessionsIcon },
  { tab: 'tasks', label: 'Tasks', Icon: TasksIcon },
  { tab: 'inbox', label: 'Inbox', Icon: InboxIcon },
];

const STATUS_COLOR: Record<ConnectionStatus, string> = {
  live: 'bg-success',
  connecting: 'bg-attention',
  reconnecting: 'bg-attention',
  offline: 'bg-danger',
};

const STATUS_LABEL: Record<ConnectionStatus, string> = {
  live: 'Live',
  connecting: 'Connecting',
  reconnecting: 'Reconnecting',
  offline: 'Offline',
};

export function ScopeRail() {
  const listTab = useStore((s) => s.listTab);
  const setListTab = useStore((s) => s.setListTab);
  const status = useStore((s) => s.status);
  const mode = useStore((s) => s.mode);
  const connection = useStore((s) => s.connection);
  const bootstrap = useStore((s) => s.bootstrap);
  const notifications = useStore((s) => s.notifications);
  const inboxState = useStore((s) => s.inboxState);
  const setPaletteOpen = useStore((s) => s.setPaletteOpen);
  const setSettingsOpen = useStore((s) => s.setSettingsOpen);

  const nav = mode === 'team' ? TEAM_NAV : LOCAL_NAV;
  const inboxCount = inboxState === 'inbox' ? notifications.length : 0;
  const statusDetail =
    mode === 'team' ? (connection?.serverUrl ?? '') : (bootstrap?.device_id ?? '');

  return (
    <nav className="flex w-13 shrink-0 flex-col items-center border-r border-line bg-canvas-inset py-3">
      <div
        className={`mb-1 flex h-8 w-8 items-center justify-center rounded-md font-mono text-sm font-bold text-white ${
          mode === 'team' ? 'bg-done' : 'bg-accent-emphasis'
        }`}
        title={`Weft · ${mode} mode`}
      >
        W
      </div>
      <span className="mb-3 text-[8px] uppercase tracking-widest text-fg-subtle">
        {mode === 'team' ? 'team' : 'local'}
      </span>

      <div className="flex flex-col gap-1">
        {nav.map(({ tab, label, Icon }) => {
          const active = listTab === tab;
          return (
            <button
              key={tab}
              type="button"
              title={label}
              aria-label={label}
              aria-current={active ? 'page' : undefined}
              onClick={() => setListTab(tab)}
              className={`relative flex h-9 w-9 items-center justify-center rounded-md transition-colors ${
                active
                  ? 'bg-canvas-subtle text-accent'
                  : 'text-fg-subtle hover:bg-canvas-subtle hover:text-fg'
              }`}
            >
              {active && <span className="absolute -left-3 h-5 w-0.5 rounded-r bg-accent" />}
              <Icon size={18} />
              {tab === 'inbox' && inboxCount > 0 && (
                <span className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-attention px-0.5 font-mono text-[8px] font-bold text-canvas-inset">
                  {inboxCount > 99 ? '99+' : inboxCount}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div className="mt-auto flex flex-col items-center gap-3">
        <button
          type="button"
          title="Connection settings"
          aria-label="Connection settings"
          onClick={() => setSettingsOpen(true)}
          className="flex h-9 w-9 items-center justify-center rounded-md text-fg-subtle hover:bg-canvas-subtle hover:text-fg"
        >
          <SettingsIcon size={18} />
        </button>
        <button
          type="button"
          title="Command palette (Ctrl/Cmd+K)"
          aria-label="Command palette"
          onClick={() => setPaletteOpen(true)}
          className="flex h-9 w-9 items-center justify-center rounded-md text-fg-subtle hover:bg-canvas-subtle hover:text-fg"
        >
          <CommandIcon size={18} />
        </button>
        <div
          className="flex flex-col items-center gap-1"
          title={`${STATUS_LABEL[status]} · ${statusDetail}`}
        >
          <span className={`h-2 w-2 rounded-full ${STATUS_COLOR[status]}`} />
          <span className="text-[9px] uppercase tracking-wide text-fg-subtle">
            {STATUS_LABEL[status]}
          </span>
        </div>
      </div>
    </nav>
  );
}
