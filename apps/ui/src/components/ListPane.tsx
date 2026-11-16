import { useState, type FormEvent, type ReactNode } from 'react';
import { api } from '../api/client.js';
import { useStore } from '../store/useStore.js';
import {
  priorityColor,
  taskStateColor,
  type Repo,
  type Session,
  type Task,
} from '../lib/types.js';
import { basename, formatRelative, shortId } from '../lib/format.js';
import { sessionDeveloperLabel } from '../lib/sessions.js';
import { ArchiveIcon, CameraIcon, PlusIcon, RefreshIcon, ReposIcon } from './icons.js';
import { InboxList } from './InboxList.js';

const SESSION_STATUS_COLOR: Record<string, string> = {
  active: 'bg-success',
  running: 'bg-success',
  idle: 'bg-attention',
  waiting: 'bg-attention',
  ended: 'bg-fg-subtle',
  completed: 'bg-fg-subtle',
  error: 'bg-danger',
  failed: 'bg-danger',
};

function sessionDot(status: string): string {
  return SESSION_STATUS_COLOR[status] ?? 'bg-fg-subtle';
}

function ErrorNote({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div className="mx-3 mb-2 rounded border border-danger/40 bg-danger/10 px-2 py-1 text-[11px] text-danger">
      {message}
    </div>
  );
}

function SessionList() {
  const sessions = useStore((s) => s.sessions);
  const selectedSessionId = useStore((s) => s.selectedSessionId);
  const selectSession = useStore((s) => s.selectSession);
  const mode = useStore((s) => s.mode);
  const directory = useStore((s) => s.directory);

  if (sessions.length === 0) {
    return (
      <EmptyHint
        title="No sessions yet"
        body={
          mode === 'team'
            ? 'Sessions from every developer on the team server appear here as their agents start.'
            : 'Run a Claude Code agent with the Weft hooks installed. Sessions appear here as they start.'
        }
      />
    );
  }
  return (
    <ul className="flex flex-col">
      {sessions.map((s: Session) => {
        const active = selectedSessionId === s.session_id;
        const label = mode === 'team' ? sessionDeveloperLabel(s, directory) : (s.provider_id ?? 'agent');
        return (
          <li key={s.session_id}>
            <button
              type="button"
              onClick={() => selectSession(active ? null : s.session_id)}
              className={`flex w-full flex-col gap-1 border-b border-line-muted px-3 py-2.5 text-left transition-colors ${
                active ? 'bg-canvas-subtle' : 'hover:bg-canvas-subtle/60'
              }`}
            >
              <div className="flex items-center gap-2">
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${sessionDot(s.status)}`} />
                <span className="truncate font-medium text-fg">
                  {label}
                </span>
                <span className="ml-auto shrink-0 font-mono text-[10px] text-fg-subtle">
                  {shortId(s.session_id)}
                </span>
              </div>
              <div className="truncate text-[11px] text-fg-muted">
                {s.prompt_summary ?? s.model ?? s.cwd ?? '—'}
              </div>
              <div className="flex items-center gap-2 text-[10px] text-fg-subtle">
                <span className="rounded bg-canvas-inset px-1.5 py-0.5 uppercase tracking-wide">
                  {s.status}
                </span>
                <span className="ml-auto">{formatRelative(s.started_at)}</span>
              </div>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function TaskList() {
  const tasks = useStore((s) => s.tasks);
  const selectedTaskId = useStore((s) => s.selectedTaskId);
  const selectTask = useStore((s) => s.selectTask);

  if (tasks.length === 0) {
    return <EmptyHint title="No tasks" body="Create a task to coordinate work across agents." />;
  }
  return (
    <ul className="flex flex-col">
      {tasks.map((t: Task) => {
        const active = selectedTaskId === t.task_id;
        return (
          <li key={t.task_id}>
            <button
              type="button"
              onClick={() => selectTask(active ? null : t.task_id)}
              className={`flex w-full flex-col gap-1 border-b border-line-muted px-3 py-2.5 text-left transition-colors ${
                active ? 'bg-canvas-subtle' : 'hover:bg-canvas-subtle/60'
              }`}
            >
              <div className="flex items-center gap-2">
                <span
                  className="h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ backgroundColor: taskStateColor(t.state) }}
                />
                <span className="shrink-0 font-mono text-[10px] text-fg-subtle">
                  {t.number !== null ? `#${t.number}` : shortId(t.task_id)}
                </span>
                <span className="truncate font-medium text-fg">{t.title}</span>
              </div>
              <div className="flex items-center gap-2 text-[10px] text-fg-subtle">
                <span
                  className="rounded px-1.5 py-0.5 font-medium"
                  style={{ color: priorityColor(t.priority), backgroundColor: '#ffffff0d' }}
                >
                  {t.priority}
                </span>
                <span className="rounded bg-canvas-inset px-1.5 py-0.5 uppercase tracking-wide">
                  {t.state.replace('_', ' ')}
                </span>
                {t.branch && <span className="truncate font-mono">{t.branch}</span>}
                <span className="ml-auto shrink-0">{t.updated_at ? formatRelative(t.updated_at) : ''}</span>
              </div>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function RepoList() {
  const repos = useStore((s) => s.repos);
  const filters = useStore((s) => s.filters);
  const setFilter = useStore((s) => s.setFilter);
  const refreshLists = useStore((s) => s.refreshLists);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (id: string, fn: () => Promise<unknown>) => {
    setBusy(id);
    setError(null);
    try {
      await fn();
      await refreshLists();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  if (repos.length === 0) {
    return (
      <EmptyHint
        title="No repositories"
        body="Register a local git repository to watch file changes and capture auto-WIP snapshots."
      />
    );
  }
  return (
    <>
      <ErrorNote message={error} />
      <ul className="flex flex-col">
        {repos.map((r: Repo) => {
          const active = filters.repo === r.repo_id;
          return (
            <li key={r.repo_id} className="border-b border-line-muted">
              <div
                className={`flex flex-col gap-1 px-3 py-2.5 transition-colors ${
                  active ? 'bg-canvas-subtle' : 'hover:bg-canvas-subtle/60'
                }`}
              >
                <button
                  type="button"
                  onClick={() => setFilter({ repo: active ? null : r.repo_id })}
                  className="flex items-center gap-2 text-left"
                >
                  <ReposIcon size={14} className="shrink-0 text-fg-subtle" />
                  <span className="truncate font-medium text-fg">{r.name}</span>
                  <span className="ml-auto shrink-0 rounded bg-canvas-inset px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-fg-subtle">
                    {r.watcher_backend}
                  </span>
                </button>
                <div className="flex items-center gap-2 pl-6 text-[10px] text-fg-subtle">
                  <span className="truncate font-mono">{r.default_branch ?? 'detached'}</span>
                  <span className="font-mono">{shortId(r.head_oid)}</span>
                  <span className="ml-auto flex shrink-0 items-center gap-1">
                    <IconAction
                      title="Scan now"
                      disabled={busy === r.repo_id}
                      onClick={() => run(r.repo_id, () => api.scanRepo(r.repo_id))}
                    >
                      <RefreshIcon size={13} />
                    </IconAction>
                    <IconAction
                      title="Snapshot WIP"
                      disabled={busy === r.repo_id}
                      onClick={() => run(r.repo_id, () => api.wipRepo(r.repo_id))}
                    >
                      <CameraIcon size={13} />
                    </IconAction>
                    <IconAction
                      title="Archive repository"
                      disabled={busy === r.repo_id}
                      onClick={() => run(r.repo_id, () => api.archiveRepo(r.repo_id))}
                    >
                      <ArchiveIcon size={13} />
                    </IconAction>
                  </span>
                </div>
                <div className="truncate pl-6 font-mono text-[10px] text-fg-subtle" title={r.root_path}>
                  {r.root_path}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}

function IconAction({
  title,
  disabled,
  onClick,
  children,
}: {
  title: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      className="flex h-5 w-5 items-center justify-center rounded text-fg-subtle hover:bg-canvas-inset hover:text-fg disabled:opacity-40"
    >
      {children}
    </button>
  );
}

function EmptyHint({ title, body }: { title: string; body: string }) {
  return (
    <div className="px-4 py-8 text-center">
      <div className="mb-1 text-xs font-medium text-fg-muted">{title}</div>
      <p className="text-[11px] leading-relaxed text-fg-subtle">{body}</p>
    </div>
  );
}

function TaskForm({ onDone }: { onDone: () => void }) {
  const createTask = useStore((s) => s.createTask);
  const repos = useStore((s) => s.repos);
  const [title, setTitle] = useState('');
  const [priority, setPriority] = useState<'P0' | 'P1' | 'P2' | 'P3'>('P2');
  const [repoId, setRepoId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await createTask({
        title: title.trim(),
        priority,
        ...(repoId ? { repoId } : {}),
      });
      setTitle('');
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="border-b border-line bg-canvas-inset px-3 py-2.5">
      <input
        autoFocus
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Task title"
        className="mb-2 w-full rounded border border-line bg-canvas px-2 py-1 text-xs text-fg outline-none focus:border-accent"
      />
      <div className="flex items-center gap-2">
        <select
          value={priority}
          onChange={(e) => setPriority(e.target.value as 'P0' | 'P1' | 'P2' | 'P3')}
          className="rounded border border-line bg-canvas px-1.5 py-1 text-[11px] text-fg outline-none"
        >
          <option value="P0">P0</option>
          <option value="P1">P1</option>
          <option value="P2">P2</option>
          <option value="P3">P3</option>
        </select>
        <select
          value={repoId}
          onChange={(e) => setRepoId(e.target.value)}
          className="min-w-0 flex-1 rounded border border-line bg-canvas px-1.5 py-1 text-[11px] text-fg outline-none"
        >
          <option value="">No repo</option>
          {repos.map((r) => (
            <option key={r.repo_id} value={r.repo_id}>
              {r.name}
            </option>
          ))}
        </select>
        <button
          type="submit"
          disabled={busy || !title.trim()}
          className="rounded bg-accent-emphasis px-2.5 py-1 text-[11px] font-medium text-white hover:bg-accent disabled:opacity-40"
        >
          {busy ? '…' : 'Create'}
        </button>
      </div>
      <ErrorNote message={error} />
    </form>
  );
}

function RepoForm({ onDone }: { onDone: () => void }) {
  const refreshLists = useStore((s) => s.refreshLists);
  const [path, setPath] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!path.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.registerRepo(path.trim());
      await refreshLists();
      setPath('');
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="border-b border-line bg-canvas-inset px-3 py-2.5">
      <input
        autoFocus
        value={path}
        onChange={(e) => setPath(e.target.value)}
        placeholder="Absolute path to git repo"
        className="mb-2 w-full rounded border border-line bg-canvas px-2 py-1 font-mono text-[11px] text-fg outline-none focus:border-accent"
      />
      <div className="flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onDone}
          className="rounded px-2 py-1 text-[11px] text-fg-muted hover:text-fg"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={busy || !path.trim()}
          className="rounded bg-accent-emphasis px-2.5 py-1 text-[11px] font-medium text-white hover:bg-accent disabled:opacity-40"
        >
          {busy ? '…' : 'Register'}
        </button>
      </div>
      <ErrorNote message={error} />
    </form>
  );
}

const TAB_TITLE = { sessions: 'Sessions', tasks: 'Tasks', repos: 'Repositories', inbox: 'Inbox' } as const;

export function ListPane() {
  const listTab = useStore((s) => s.listTab);
  const mode = useStore((s) => s.mode);
  const connection = useStore((s) => s.connection);
  const sessions = useStore((s) => s.sessions);
  const tasks = useStore((s) => s.tasks);
  const repos = useStore((s) => s.repos);
  const notifications = useStore((s) => s.notifications);
  const refreshLists = useStore((s) => s.refreshLists);
  const [creating, setCreating] = useState(false);

  const count =
    listTab === 'sessions'
      ? sessions.length
      : listTab === 'tasks'
        ? tasks.length
        : listTab === 'inbox'
          ? notifications.length
          : repos.length;
  const canCreate = listTab === 'tasks' || listTab === 'repos';

  return (
    <section className="flex w-[300px] shrink-0 flex-col border-r border-line bg-canvas">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-3">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-fg-muted">
          {TAB_TITLE[listTab]}
        </h2>
        <span className="rounded-full bg-canvas-subtle px-1.5 py-0.5 font-mono text-[10px] text-fg-subtle">
          {count}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            title="Refresh"
            aria-label="Refresh lists"
            onClick={() => void refreshLists()}
            className="flex h-6 w-6 items-center justify-center rounded text-fg-subtle hover:bg-canvas-subtle hover:text-fg"
          >
            <RefreshIcon size={14} />
          </button>
          {canCreate && (
            <button
              type="button"
              title={listTab === 'tasks' ? 'New task' : 'Register repository'}
              aria-label={listTab === 'tasks' ? 'New task' : 'Register repository'}
              onClick={() => setCreating((v) => !v)}
              className={`flex h-6 w-6 items-center justify-center rounded hover:bg-canvas-subtle ${
                creating ? 'text-accent' : 'text-fg-subtle hover:text-fg'
              }`}
            >
              <PlusIcon size={15} />
            </button>
          )}
        </div>
      </header>

      {creating && listTab === 'tasks' && <TaskForm onDone={() => setCreating(false)} />}
      {creating && listTab === 'repos' && <RepoForm onDone={() => setCreating(false)} />}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {listTab === 'sessions' && <SessionList />}
        {listTab === 'tasks' && <TaskList />}
        {listTab === 'repos' && <RepoList />}
        {listTab === 'inbox' && <InboxList />}
      </div>

      <footer className="shrink-0 truncate border-t border-line px-3 py-1.5 text-[10px] text-fg-subtle">
        {mode === 'team'
          ? (connection?.serverUrl ?? 'Team server')
          : listTab === 'repos' && repos[0]
            ? basename(repos[0].root_path)
            : 'Local-first · loopback only'}
      </footer>
    </section>
  );
}