import type { WeftEvent } from './types.js';

export function categoryOf(type: string): string {
  const dot = type.indexOf('.');
  return dot === -1 ? type : type.slice(0, dot);
}

const CATEGORY_LABELS: Record<string, string> = {
  session: 'Session',
  prompt: 'Prompt',
  tool: 'Tool',
  command: 'Command',
  file: 'File',
  symbols: 'Symbols',
  commit: 'Commit',
  branch: 'Branch',
  worktree: 'Worktree',
  task: 'Task',
  reservation: 'Reservation',
  conflict: 'Conflict',
  merge: 'Merge',
  summary: 'Summary',
  validation: 'Validation',
  check: 'Check',
  health: 'Health',
  notification: 'Notice',
};

export function categoryLabel(category: string): string {
  return CATEGORY_LABELS[category] ?? category;
}

/** Primer-derived accent per event category (dark theme). */
export const CATEGORY_COLOR: Record<string, string> = {
  session: '#a371f7',
  prompt: '#a371f7',
  tool: '#79c0ff',
  command: '#79c0ff',
  file: '#7ee787',
  symbols: '#7ee787',
  commit: '#ffa657',
  branch: '#ffa657',
  worktree: '#ffa657',
  task: '#f778ba',
  reservation: '#f778ba',
  conflict: '#ff7b72',
  merge: '#d2a8ff',
  validation: '#56d364',
  check: '#56d364',
  health: '#56d364',
  summary: '#8b949e',
  notification: '#e3b341',
};

export function categoryColor(category: string): string {
  return CATEGORY_COLOR[category] ?? '#8b949e';
}

const NOTIFICATION_KIND_LABEL: Record<string, string> = {
  approval: 'Approval',
  question: 'Question',
  failure: 'Failure',
  conflict: 'Conflict',
  mention: 'Mention',
};

export function notificationKindLabel(kind: string): string {
  return NOTIFICATION_KIND_LABEL[kind] ?? kind;
}

const NOTIFICATION_KIND_COLOR: Record<string, string> = {
  approval: '#d29922',
  question: '#4493f8',
  failure: '#f85149',
  conflict: '#ff7b72',
  mention: '#a371f7',
};

export function notificationKindColor(kind: string): string {
  return NOTIFICATION_KIND_COLOR[kind] ?? '#8b949e';
}

export function formatClock(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '--:--:--';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function formatRelative(ts: string, now: number = Date.now()): string {
  const t = new Date(ts).getTime();
  if (Number.isNaN(t)) return '';
  const delta = Math.max(0, now - t);
  const s = Math.floor(delta / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function shortId(id: string | undefined | null): string {
  if (!id) return '—';
  const underscore = id.indexOf('_');
  const tail = underscore === -1 ? id : id.slice(underscore + 1);
  return tail.slice(-8);
}

export function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? path;
}

/** One-line human summary of an event for rows and grouping labels. */
export function eventSummary(e: WeftEvent): string {
  const p = e.payload;
  switch (e.type) {
    case 'session.started':
      return `Session started${typeof p.model === 'string' ? ` · ${p.model}` : ''}`;
    case 'session.status':
      return `Status → ${String(p.status ?? 'unknown')}`;
    case 'session.ended':
      return `Session ended · ${String(p.reason ?? 'completed')}`;
    case 'prompt.submitted':
      return typeof p.prompt_summary === 'string' ? p.prompt_summary : 'Prompt submitted';
    case 'tool.pre':
    case 'tool.post':
    case 'tool.failed':
      return `${String(p.tool_name ?? 'tool')}${e.type === 'tool.failed' ? ' failed' : ''}`;
    case 'command.executed':
      return typeof p.command_display === 'string' ? p.command_display : 'Command';
    case 'file.changed':
      return `${String(p.change_kind ?? 'modify')} ${String(p.path ?? '')}`.trim();
    case 'task.created':
    case 'task.updated':
      return `Task ${e.type.split('.')[1]}`;
    case 'task.state_changed':
      return `Task ${String(p.from ?? '?')} → ${String(p.to ?? '?')}`;
    case 'commit.created':
      return `Commit ${typeof p.oid === 'string' ? p.oid.slice(0, 8) : ''}`;
    default:
      return e.type;
  }
}
