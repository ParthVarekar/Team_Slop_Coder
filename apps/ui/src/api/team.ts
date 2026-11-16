import type {
  DirectoryEntry,
  Notification,
  NotificationState,
  Task,
  TeamConnection,
  WeftEvent,
} from '../lib/types.js';

/** Server TaskSnapshot uses `id`; the UI Task uses `task_id` and has no mtime. */
interface ServerTask {
  id: string;
  project_id: string;
  repo_id: string | null;
  number: number | null;
  title: string;
  description: string | null;
  priority: string;
  state: string;
  branch: string | null;
  version: number;
}

function mapTask(t: ServerTask): Task {
  return {
    task_id: t.id,
    project_id: t.project_id,
    repo_id: t.repo_id,
    number: t.number,
    title: t.title,
    description: t.description,
    priority: t.priority,
    state: t.state,
    branch: t.branch,
    version: t.version,
    updated_at: null,
  };
}

export interface CreateTeamTaskInput {
  title: string;
  description?: string;
  priority?: string;
  repoId?: string;
}

/**
 * Team-server HTTP client. Unlike the local daemon client (relative paths + a
 * bootstrapped hook secret), this addresses an absolute server origin with a
 * project-scoped Bearer token and stamps projectId on every request. Task
 * transitions use the server's optimistic-concurrency `baseVersion` field.
 */
export function teamClient(connection: TeamConnection) {
  const base = connection.serverUrl.replace(/\/+$/, '');
  const headers = { authorization: `Bearer ${connection.token}` };
  const project = `projectId=${encodeURIComponent(connection.projectId)}`;

  async function get<T>(path: string): Promise<T> {
    const res = await fetch(`${base}${path}`, { headers });
    if (!res.ok) throw new Error(`${path} → ${res.status}`);
    return (await res.json()) as T;
  }

  async function send<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { ...headers, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`${path} → ${res.status}${detail ? `: ${detail}` : ''}`);
    }
    return (await res.json()) as T;
  }

  return {
    health: () => get<{ ok: boolean; database: string }>('/healthz'),
    events: (after = 0) =>
      get<{ events: WeftEvent[]; cursor: { last_seq: number; min_seq: number }; resync: boolean }>(
        `/v1/events?${project}&afterSeq=${after}&limit=1000`,
      ),
    async tasks(): Promise<{ tasks: Task[] }> {
      const r = await get<{ tasks: ServerTask[] }>(`/v1/tasks?${project}`);
      return { tasks: r.tasks.map(mapTask) };
    },
    async createTask(input: CreateTeamTaskInput): Promise<{ task: Task }> {
      const r = await send<{ task: ServerTask }>('POST', '/v1/tasks', {
        projectId: connection.projectId,
        ...input,
      });
      return { task: mapTask(r.task) };
    },
    async transitionTask(id: string, baseVersion: number, to: string, reason?: string): Promise<{ task: Task }> {
      const r = await send<{ task: ServerTask }>('POST', `/v1/tasks/${id}/transition`, {
        projectId: connection.projectId,
        baseVersion,
        to,
        ...(reason ? { reason } : {}),
      });
      return { task: mapTask(r.task) };
    },
    notifications: (state?: NotificationState) =>
      get<{ notifications: Notification[] }>(
        `/v1/notifications?${project}${state ? `&state=${state}` : ''}`,
      ),
    setNotificationState: (id: string, state: NotificationState) =>
      send<{ notification: Notification }>('POST', `/v1/notifications/${id}/state`, {
        projectId: connection.projectId,
        state,
      }),
    members: () => get<{ members: DirectoryEntry[] }>(`/v1/members?${project}`),
  };
}

export type TeamClient = ReturnType<typeof teamClient>;