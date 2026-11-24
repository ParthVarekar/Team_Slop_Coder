import { create } from 'zustand';
import { api, bootstrap, type CreateTaskInput } from '../api/client.js';
import { teamClient } from '../api/team.js';
import { SseClient } from '../api/sse.js';
import { categoryOf, eventSummary } from '../lib/format.js';
import { clearConnection, loadConnection, saveConnection } from '../lib/connection.js';
import { deriveSessions } from '../lib/sessions.js';
import {
  str,
  type Bootstrap,
  type CompactionNotice,
  type ConnectionStatus,
  type DirectoryEntry,
  type Mode,
  type Notification,
  type NotificationState,
  type Repo,
  type Session,
  type Task,
  type TeamConnection,
  type WeftEvent,
} from '../lib/types.js';

const EVENT_CAP = 5000;
const INGEST_BATCH_MS = 50;
const LIST_REFRESH_MS = 4000;

export type ListTab = 'sessions' | 'tasks' | 'repos' | 'inbox';

export interface Filters {
  category: string | null;
  session: string | null;
  repo: string | null;
  task: string | null;
  search: string;
}

export interface StoreState {
  ready: boolean;
  error: string | null;
  mode: Mode;
  connection: TeamConnection | null;
  bootstrap: Bootstrap | null;
  status: ConnectionStatus;
  events: WeftEvent[];
  cursor: number;
  sessions: Session[];
  tasks: Task[];
  repos: Repo[];
  directory: DirectoryEntry[];
  notifications: Notification[];
  inboxState: NotificationState;
  backend: string | null;
  filters: Filters;
  listTab: ListTab;
  selectedEventId: string | null;
  selectedSessionId: string | null;
  selectedTaskId: string | null;
  selectedNotificationId: string | null;
  paletteOpen: boolean;
  settingsOpen: boolean;
  retentionOpen: boolean;
  compactionNotice: CompactionNotice | null;
  init: () => Promise<void>;
  connectLocal: () => Promise<void>;
  connectTeam: (connection: TeamConnection) => Promise<void>;
  disconnectTeam: () => Promise<void>;
  ingest: (event: WeftEvent) => void;
  setStatus: (status: ConnectionStatus) => void;
  refreshLists: () => Promise<void>;
  createTask: (input: CreateTaskInput) => Promise<void>;
  transitionTask: (id: string, version: number, to: string) => Promise<void>;
  triageNotification: (id: string, state: NotificationState) => Promise<void>;
  setInboxState: (state: NotificationState) => void;
  setFilter: (patch: Partial<Filters>) => void;
  clearFilters: () => void;
  setListTab: (tab: ListTab) => void;
  selectEvent: (id: string | null) => void;
  selectSession: (id: string | null) => void;
  selectTask: (id: string | null) => void;
  selectNotification: (id: string | null) => void;
  setPaletteOpen: (open: boolean) => void;
  setSettingsOpen: (open: boolean) => void;
  setRetentionOpen: (open: boolean) => void;
  noticeCompaction: (notice: CompactionNotice) => void;
  clearCompactionNotice: () => void;
}

const EMPTY_FILTERS: Filters = {
  category: null,
  session: null,
  repo: null,
  task: null,
  search: '',
};
const seen = new Set<string>();
let pendingEvents: WeftEvent[] = [];
let ingestTimer: ReturnType<typeof setTimeout> | null = null;
let sse: SseClient | null = null;
let refreshTimer: ReturnType<typeof setInterval> | null = null;
let initialized = false;

function resetPendingEvents(): void {
  if (ingestTimer) clearTimeout(ingestTimer);
  ingestTimer = null;
  pendingEvents = [];
}

function flushPendingEvents(): void {
  ingestTimer = null;
  if (pendingEvents.length === 0) return;
  const incoming = pendingEvents;
  pendingEvents = [];
  const events = [...useStore.getState().events, ...incoming];
  let cursor = useStore.getState().cursor;
  for (const event of incoming) {
    const seq = event.global_seq ?? event.rowid;
    if (seq !== undefined && seq > cursor) cursor = seq;
  }
  if (events.length > EVENT_CAP) {
    const dropped = events.splice(0, events.length - EVENT_CAP);
    for (const event of dropped) seen.delete(event.event_id);
  }
  if (
    useStore.getState().mode === 'team' &&
    incoming.some((event) => event.type.startsWith('session.'))
  ) {
    useStore.setState({ events, cursor, sessions: deriveSessions(events) });
  } else {
    useStore.setState({ events, cursor });
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export const useStore = create<StoreState>((set, get) => ({
  ready: false,
  error: null,
  mode: 'local',
  connection: null,
  bootstrap: null,
  status: 'connecting',
  events: [],
  cursor: 0,
  sessions: [],
  tasks: [],
  repos: [],
  directory: [],
  notifications: [],
  inboxState: 'inbox',
  backend: null,
  filters: EMPTY_FILTERS,
  listTab: 'sessions',
  selectedEventId: null,
  selectedSessionId: null,
  selectedTaskId: null,
  selectedNotificationId: null,
  paletteOpen: false,
  settingsOpen: false,
  retentionOpen: false,
  compactionNotice: null,

  async init() {
    if (initialized) return;
    initialized = true;
    const saved = loadConnection();
    if (saved) await get().connectTeam(saved);
    else await get().connectLocal();
  },

  async connectLocal() {
    sse?.stop();
    resetPendingEvents();
    seen.clear();
    if (refreshTimer) clearInterval(refreshTimer);
    set({
      mode: 'local',
      connection: null,
      bootstrap: null,
      ready: false,
      error: null,
      status: 'connecting',
      events: [],
      cursor: 0,
      sessions: [],
      tasks: [],
      repos: [],
      directory: [],
      notifications: [],
      backend: null,
      listTab: 'sessions',
      selectedEventId: null,
      selectedSessionId: null,
      selectedTaskId: null,
      selectedNotificationId: null,
    });
    sse = new SseClient(
      {
        onEvent: (e) => get().ingest(e),
        onStatus: (s) => get().setStatus(s),
      },
      { onCompaction: (notice) => get().noticeCompaction(notice) },
    );
    try {
      const b = await bootstrap();
      set({ bootstrap: b, ready: true, error: null });
      await get().refreshLists();
      sse.start(0);
      refreshTimer = setInterval(() => void get().refreshLists(), LIST_REFRESH_MS);
    } catch (err) {
      set({ error: errorMessage(err), status: 'offline' });
    }
  },

  async connectTeam(connection) {
    sse?.stop();
    resetPendingEvents();
    seen.clear();
    if (refreshTimer) clearInterval(refreshTimer);
    saveConnection(connection);
    set({
      mode: 'team',
      connection,
      bootstrap: null,
      ready: false,
      error: null,
      status: 'connecting',
      events: [],
      cursor: 0,
      sessions: [],
      tasks: [],
      repos: [],
      directory: [],
      notifications: [],
      backend: null,
      listTab: 'sessions',
      selectedEventId: null,
      selectedSessionId: null,
      selectedTaskId: null,
      selectedNotificationId: null,
    });
    const team = teamClient(connection);
    try {
      // Probe an authenticated, project-scoped read so a bad token/URL fails fast.
      const m = await team.members();
      set({ directory: m.members, ready: true, error: null });
      await get().refreshLists();
      sse = new SseClient(
        {
          onEvent: (e) => get().ingest(e),
          onStatus: (s) => get().setStatus(s),
        },
        {
          baseUrl: connection.serverUrl,
          projectId: connection.projectId,
          headers: { authorization: `Bearer ${connection.token}` },
          onResync: () => void get().refreshLists(),
          onCompaction: (notice) => get().noticeCompaction(notice),
        },
      );
      sse.start(0);
      refreshTimer = setInterval(() => void get().refreshLists(), LIST_REFRESH_MS);
    } catch (err) {
      set({ error: errorMessage(err), status: 'offline' });
    }
  },

  async disconnectTeam() {
    clearConnection();
    await get().connectLocal();
  },

  ingest(event) {
    if (seen.has(event.event_id)) return;
    seen.add(event.event_id);
    pendingEvents.push(event);
    if (pendingEvents.length >= EVENT_CAP) flushPendingEvents();
    else if (!ingestTimer) ingestTimer = setTimeout(flushPendingEvents, INGEST_BATCH_MS);
  },

  setStatus(status) {
    set({ status });
  },

  async refreshLists() {
    const { mode, connection } = get();
    if (mode === 'team' && connection) {
      try {
        const team = teamClient(connection);
        const [t, n, m] = await Promise.all([
          team.tasks(),
          team.notifications(get().inboxState),
          team.members(),
        ]);
        set({
          tasks: t.tasks,
          notifications: n.notifications,
          directory: m.members,
          sessions: deriveSessions(get().events),
          repos: [],
          backend: null,
        });
      } catch {
        /* server unreachable; retain last-known lists */
      }
      return;
    }
    try {
      const [s, t, r] = await Promise.all([api.sessions(), api.tasks(), api.repos()]);
      set({ sessions: s.sessions, tasks: t.tasks, repos: r.repos, backend: r.backend });
    } catch {
      /* daemon unreachable; retain last-known lists */
    }
  },

  async createTask(input) {
    const { mode, connection } = get();
    if (mode === 'team' && connection) await teamClient(connection).createTask(input);
    else await api.createTask(input);
    await get().refreshLists();
  },

  async transitionTask(id, version, to) {
    const { mode, connection } = get();
    if (mode === 'team' && connection) await teamClient(connection).transitionTask(id, version, to);
    else await api.transitionTask(id, version, to);
    await get().refreshLists();
  },

  async triageNotification(id, state) {
    const connection = get().connection;
    if (!connection) return;
    await teamClient(connection).setNotificationState(id, state);
    await get().refreshLists();
    if (!get().notifications.some((n) => n.id === id)) set({ selectedNotificationId: null });
  },

  setInboxState(inboxState) {
    set({ inboxState, selectedNotificationId: null });
    void get().refreshLists();
  },

  setFilter(patch) {
    set({ filters: { ...get().filters, ...patch } });
  },

  clearFilters() {
    set({ filters: EMPTY_FILTERS });
  },

  setListTab(listTab) {
    set({ listTab });
  },

  selectEvent(selectedEventId) {
    set({ selectedEventId });
  },

  selectSession(selectedSessionId) {
    set({
      selectedSessionId,
      selectedEventId: null,
      selectedTaskId: null,
      selectedNotificationId: null,
      filters: { ...get().filters, session: selectedSessionId },
    });
  },

  selectTask(selectedTaskId) {
    set({
      selectedTaskId,
      selectedEventId: null,
      selectedNotificationId: null,
      filters: { ...get().filters, task: selectedTaskId },
    });
  },

  selectNotification(selectedNotificationId) {
    set({
      selectedNotificationId,
      selectedEventId: null,
      selectedTaskId: null,
      selectedSessionId: null,
    });
  },

  setPaletteOpen(paletteOpen) {
    set({ paletteOpen });
  },

  setSettingsOpen(settingsOpen) {
    set({ settingsOpen });
  },

  setRetentionOpen(retentionOpen) {
    set({ retentionOpen });
  },

  noticeCompaction(notice) {
    set({ compactionNotice: notice });
  },

  clearCompactionNotice() {
    set({ compactionNotice: null });
  },
}));

/** Pure filter used with useMemo in the stream workspace. */
export function filterEvents(events: WeftEvent[], filters: Filters): WeftEvent[] {
  const { category, session, repo, task, search } = filters;
  const q = search.trim().toLowerCase();
  if (!category && !session && !repo && !task && !q) return events;
  return events.filter((e) => {
    if (session && e.session_id !== session) return false;
    if (repo && e.repo_id !== repo) return false;
    if (task && e.task_id !== task) return false;
    if (category && categoryOf(e.type) !== category) return false;
    if (q) {
      const haystack = `${e.type} ${eventSummary(e)} ${str(e.payload, 'path') ?? ''}`.toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });
}
