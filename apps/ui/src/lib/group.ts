import { categoryLabel, categoryOf, eventSummary } from './format.js';
import { str, type WeftEvent } from './types.js';

export interface StreamGroup {
  /** Deterministic id: the first event's event_id. */
  id: string;
  category: string;
  key: string;
  label: string;
  sessionId?: string;
  repoId?: string;
  events: WeftEvent[];
  startTs: string;
  endTs: string;
}

export const GROUP_WINDOW_MS = 45_000;
export const MAX_GROUP_SIZE = 100;

function subKeyOf(e: WeftEvent): string {
  switch (categoryOf(e.type)) {
    case 'tool':
      return str(e.payload, 'tool_name') ?? e.type;
    case 'file':
    case 'symbols':
      return str(e.payload, 'path') ?? e.type;
    case 'task':
      return e.task_id ?? 'task';
    case 'commit':
      return str(e.payload, 'branch') ?? 'commit';
    case 'branch':
      return str(e.payload, 'name') ?? 'branch';
    case 'command':
      return 'command';
    case 'prompt':
      return 'prompt';
    default:
      return e.type;
  }
}

function sameGroup(group: StreamGroup, e: WeftEvent, windowMs: number): boolean {
  if (group.events.length >= MAX_GROUP_SIZE) return false;
  if ((group.sessionId ?? null) !== (e.session_id ?? null)) return false;
  if (group.category !== categoryOf(e.type)) return false;
  if (group.key !== subKeyOf(e)) return false;
  const t = new Date(e.ts).getTime();
  const start = new Date(group.startTs).getTime();
  return Number.isFinite(t) && Number.isFinite(start) && t - start <= windowMs;
}

function groupLabel(group: StreamGroup): string {
  const first = group.events[0];
  if (!first) return categoryLabel(group.category);
  if (group.events.length === 1) return eventSummary(first);
  return `${group.key} × ${group.events.length}`;
}

/**
 * Collapse consecutive related events into deterministic groups: same session,
 * category and sub-key within a bounded time window. Pure and order-stable —
 * identical input always yields identical groups (ids derive from event_ids).
 */
export function groupEvents(
  events: WeftEvent[],
  windowMs: number = GROUP_WINDOW_MS,
): StreamGroup[] {
  const groups: StreamGroup[] = [];
  for (const e of events) {
    const current = groups[groups.length - 1];
    if (current && sameGroup(current, e, windowMs)) {
      current.events.push(e);
      current.endTs = e.ts;
    } else {
      groups.push({
        id: e.event_id,
        category: categoryOf(e.type),
        key: subKeyOf(e),
        label: '',
        ...(e.session_id ? { sessionId: e.session_id } : {}),
        ...(e.repo_id ? { repoId: e.repo_id } : {}),
        events: [e],
        startTs: e.ts,
        endTs: e.ts,
      });
    }
  }
  for (const g of groups) g.label = groupLabel(g);
  return groups;
}
