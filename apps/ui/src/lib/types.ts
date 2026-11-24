export interface AgentInfo {
  provider: string;
  adapter?: string;
  model?: string;
}

export type Actor = { user_id: string; agent: AgentInfo | null } | { system: string };

/** Wire-format event envelope (protocol v1) as served by the local API. */
export interface WeftEvent {
  event_id: string;
  v: number;
  device_id: string;
  project_id: string;
  repo_id?: string;
  session_id?: string;
  provider_session_id?: string;
  task_id?: string;
  seq?: number;
  global_seq?: number;
  ts: string;
  type: string;
  actor: Actor;
  privacy: string;
  payload: Record<string, unknown>;
  received_at?: string;
  rowid?: number;
}

export interface Session {
  session_id: string;
  device_id: string;
  provider_id: string | null;
  provider_session_id: string;
  task_id: string | null;
  developer_id: string | null;
  cwd: string | null;
  status: string;
  started_at: string;
  ended_at: string | null;
  model: string | null;
  prompt_summary: string | null;
  fidelity: string;
}

export interface Task {
  task_id: string;
  project_id: string;
  repo_id: string | null;
  number: number | null;
  title: string;
  description: string | null;
  priority: string;
  state: string;
  branch: string | null;
  version: number;
  /** Null for server snapshots, which expose no modification time. */
  updated_at: string | null;
}

export interface Repo {
  repo_id: string;
  name: string;
  root_path: string;
  remote_url: string | null;
  default_branch: string | null;
  head_oid: string | null;
  wip_ref: string;
  watcher_backend: string;
  last_scan_at: string | null;
  last_wip_oid: string | null;
  state: string;
}

export interface Bootstrap {
  device_id: string;
  project_id: string;
  user_id: string;
  hook_secret: string;
  mode: string;
  protocol_version: number;
}

/** Which backend the UI is connected to: the local daemon or a team server. */
export type Mode = 'local' | 'team';

/** Persisted team-server connection (server origin + project-scoped API token). */
export interface TeamConnection {
  serverUrl: string;
  token: string;
  projectId: string;
}

export type NotificationState = 'inbox' | 'saved' | 'done';

/** Server inbox card (mirrors NotificationSnapshot). */
export interface Notification {
  id: string;
  user_id: string;
  project_id: string;
  kind: string;
  title: string;
  body: string | null;
  subject_type: string | null;
  subject_id: string | null;
  state: NotificationState;
  created_at: string;
}

/** Read-scoped team directory entry for developer attribution. */
export interface DirectoryEntry {
  userId: string;
  displayName: string;
  role: string;
}

export type ConnectionStatus = 'connecting' | 'live' | 'reconnecting' | 'offline';

export interface RetentionPolicy {
  version: 'retention-allowlist-v1';
  cutoff: string;
  batchLimit: number;
  allowlist: string[];
}

export interface RetentionPreview {
  sequenceKind: 'rowid' | 'global_seq';
  projectId: string | null;
  cutoff: string;
  policy: RetentionPolicy;
  policyVersion: string;
  allowlist: string[];
  dryRun: boolean;
  batchLimit: number;
  eligibleRows: number;
  eligiblePayloadBytes: number;
  selectedRows: number;
  selectedPayloadBytes: number;
  remainingAfterBatch: number;
  exclusions: {
    protectedCoordination: number;
    protectedUnknown: number;
    protectedOrNonAllowlisted: number;
    protectedReceipts: number;
    tooNew: number;
  };
  summaryCount: number;
  rangeCount: number;
  ranges: { sequenceKind: string; seqStart: number; seqEnd: number }[];
  fingerprint: string;
  generatedAt: string;
  measurements: {
    payloadBytes: { value: number | null; label: string; scope: string };
    storedTupleEstimateBytes: { value: number | null; label: string; scope: string };
    allocatedRelationBytes: { value: number | null; label: string; scope: string };
    freePagesBytes: { value: number | null; label: string; scope: string };
  };
}

export interface RetentionResult extends RetentionPreview {
  runId: string;
  committed: true;
  committedAt: string;
  idempotent: boolean;
  summaryEventIds: string[];
}

export interface RetentionStatus {
  policyVersion: string;
  allowlist: string[];
  defaultTelemetryDays: number;
  batchLimit: number;
  scheduler: {
    enabled?: boolean;
    running?: boolean;
    destructiveApply: false;
    partitionAutomation?: {
      enabled: boolean;
      running: boolean;
      lastRunAt: string | null;
      nextRunAt: string | null;
    };
  };
  exactCounts: {
    events: number;
    coordinationEvents: number;
    receipts: number;
    summaries: number;
    ranges: number;
    completedRuns: number;
  };
  lastRun: { runId: string; completedAt: string; selectedCount: number } | null;
  outbox?: { pending: number; coordinationPending: number; backpressure: boolean };
  partitions: null | {
    current: string;
    next: string;
    retained: string[];
    defaultRetained: boolean;
    destructiveOperations: false;
  };
  byteMetrics: RetentionPreview['measurements'];
  limitations: string[];
}

export interface CompactionNotice {
  sequenceKind: 'rowid' | 'global_seq';
  seqStart: number;
  seqEnd: number;
  runId?: string;
  summaryEventId?: string | null;
  receivedAt: number;
}

export function isSystemActor(actor: Actor): actor is { system: string } {
  return 'system' in actor;
}

export function actorLabel(actor: Actor): string {
  if (isSystemActor(actor)) return 'system';
  return actor.agent ? actor.agent.provider : 'developer';
}

/** Safe payload string accessor (payload is untrusted additive JSON). */
export function str(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === 'string' ? value : undefined;
}

export function num(payload: Record<string, unknown>, key: string): number | undefined {
  const value = payload[key];
  return typeof value === 'number' ? value : undefined;
}

export type TaskState =
  | 'backlog'
  | 'ready'
  | 'claimed'
  | 'in_progress'
  | 'review'
  | 'validation'
  | 'blocked'
  | 'failed'
  | 'completed'
  | 'cancelled';

/** Mirrors the daemon's local lifecycle so the UI offers only legal edges. */
export const TASK_TRANSITIONS: Record<TaskState, readonly TaskState[]> = {
  backlog: ['ready', 'cancelled'],
  ready: ['claimed', 'backlog', 'cancelled'],
  claimed: ['in_progress', 'ready', 'blocked', 'cancelled'],
  in_progress: ['review', 'blocked', 'failed', 'cancelled'],
  review: ['validation', 'in_progress', 'blocked', 'cancelled'],
  validation: ['completed', 'failed', 'in_progress', 'cancelled'],
  blocked: ['ready', 'in_progress', 'cancelled'],
  failed: ['ready', 'in_progress', 'cancelled'],
  completed: ['ready'],
  cancelled: ['ready'],
};

export function nextStates(state: string): readonly TaskState[] {
  return TASK_TRANSITIONS[state as TaskState] ?? [];
}

export const TASK_STATE_COLOR: Record<string, string> = {
  backlog: '#8b949e',
  ready: '#4493f8',
  claimed: '#79c0ff',
  in_progress: '#d29922',
  review: '#a371f7',
  validation: '#56d364',
  blocked: '#f85149',
  failed: '#f85149',
  completed: '#3fb950',
  cancelled: '#6e7681',
};

export function taskStateColor(state: string): string {
  return TASK_STATE_COLOR[state] ?? '#8b949e';
}

export function priorityColor(priority: string): string {
  switch (priority) {
    case 'P0':
      return '#f85149';
    case 'P1':
      return '#d29922';
    case 'P2':
      return '#4493f8';
    default:
      return '#8b949e';
  }
}
