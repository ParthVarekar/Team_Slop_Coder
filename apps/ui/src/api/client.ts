import type { Bootstrap, Repo, Session, Task, WeftEvent } from '../lib/types.js';

let secret = '';

export async function bootstrap(): Promise<Bootstrap> {
  const res = await fetch('/v1/bootstrap');
  if (!res.ok) throw new Error(`bootstrap failed: ${res.status}`);
  const data = (await res.json()) as Bootstrap;
  secret = data.hook_secret;
  return data;
}

export function authHeaders(): Record<string, string> {
  return secret ? { authorization: `Bearer ${secret}` } : {};
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: authHeaders() });
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return (await res.json()) as T;
}

async function sendJson<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: {
      ...authHeaders(),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`${path} → ${res.status}${detail ? `: ${detail}` : ''}`);
  }
  return (await res.json()) as T;
}

export interface Health {
  ok: boolean;
  mode: string;
  device_id: string;
  project_id: string;
  events: number;
  pending: number;
}

export interface CreateTaskInput {
  title: string;
  description?: string;
  priority?: 'P0' | 'P1' | 'P2' | 'P3';
  repoId?: string;
  branch?: string;
}

export const api = {
  health: () => getJson<Health>('/healthz'),
  events: (after = 0) =>
    getJson<{ events: WeftEvent[]; cursor: number }>(`/v1/events?after=${after}&limit=1000`),
  sessions: () => getJson<{ sessions: Session[] }>('/v1/sessions'),
  tasks: () => getJson<{ tasks: Task[] }>('/v1/tasks'),
  repos: () => getJson<{ repos: Repo[]; backend: string | null }>('/v1/repos'),
  createTask: (input: CreateTaskInput) => sendJson<{ task: Task }>('POST', '/v1/tasks', input),
  transitionTask: (id: string, version: number, to: string, reason?: string) =>
    sendJson<{ task: Task }>('POST', `/v1/tasks/${id}/transition`, {
      version,
      to,
      ...(reason ? { reason } : {}),
    }),
  registerRepo: (path: string) => sendJson<{ repo: Repo }>('POST', '/v1/repos', { path }),
  scanRepo: (id: string) => sendJson<unknown>('POST', `/v1/repos/${id}/scan`),
  wipRepo: (id: string) => sendJson<unknown>('POST', `/v1/repos/${id}/wip`),
  archiveRepo: (id: string) => sendJson<{ ok: boolean }>('DELETE', `/v1/repos/${id}`),
};