import type { TeamConnection } from './types.js';

const KEY = 'weft.team.connection';

/**
 * Persist the team connection so a reload resumes the same server/project. The
 * token is a project-scoped, revocable API credential (never a password); all
 * access is guarded by try/catch so a storage-disabled browser degrades to
 * in-memory local mode rather than crashing.
 */
export function loadConnection(): TeamConnection | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const c = JSON.parse(raw) as Partial<TeamConnection>;
    if (
      typeof c.serverUrl === 'string' &&
      c.serverUrl &&
      typeof c.token === 'string' &&
      c.token &&
      typeof c.projectId === 'string' &&
      c.projectId
    ) {
      return { serverUrl: c.serverUrl, token: c.token, projectId: c.projectId };
    }
    return null;
  } catch {
    return null;
  }
}

export function saveConnection(connection: TeamConnection): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(connection));
  } catch {
    /* storage unavailable; connection lives in memory for this session */
  }
}

export function clearConnection(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable */
  }
}
