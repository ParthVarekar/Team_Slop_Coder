import { z } from 'zod';
import {
  ActorSchema,
  FidelitySchema,
  EventEnvelopeSchema,
  type EventEnvelope,
} from './envelope.js';

/** Payload objects preserve unknown additive fields (minor-version forward compat). */
const obj = <T extends z.ZodRawShape>(shape: T) => z.object(shape).passthrough();

const int = z.number().int();
const nonneg = z.number().int().nonnegative();
const hash = z.string().min(1);
const summary = z.string().max(400);

// ---------------------------------------------------------------------------
// Shared enums
// ---------------------------------------------------------------------------
export const SessionStatusSchema = z.enum(['running', 'idle', 'waiting_permission']);
export const SessionEndReasonSchema = z.enum(['completed', 'failed', 'interrupted', 'crashed']);
export const ReservationCheckSchema = z.enum(['pass', 'blocked', 'warn']);
export const FileChangeKindSchema = z.enum(['add', 'modify', 'delete', 'rename']);
export const FileChangeSourceSchema = z.enum(['agent_tool', 'watcher', 'git']);
export const SymbolKindSchema = z.enum([
  'function',
  'class',
  'method',
  'type',
  'interface',
  'const',
]);
export const SymbolChangeKindSchema = z.enum(['added', 'removed', 'signature', 'body']);
export const ReservationModeSchema = z.enum(['soft', 'hard']);
export const ConflictKindSchema = z.enum([
  'textual',
  'file_overlap',
  'symbol_overlap',
  'signature_impact',
  'contract',
  'schema',
]);
export const ConflictSeveritySchema = z.enum(['info', 'warning', 'blocking']);
export const ConflictStateSchema = z.enum(['open', 'resolved', 'dismissed']);
export const MergeStateSchema = z.enum(['queued', 'testing', 'merged', 'ejected']);
export const ValidationTriggerSchema = z.enum(['task', 'queue', 'manual', 'baseline']);
export const ValidationSelectionSchema = z.enum(['full', 'affected']);
export const ValidationStateSchema = z.enum(['passed', 'failed', 'error']);
export const TaskStateSchema = z.enum([
  'backlog',
  'ready',
  'claimed',
  'in_progress',
  'review',
  'validation',
  'completed',
  'blocked',
  'failed',
  'cancelled',
]);

export type TaskState = z.infer<typeof TaskStateSchema>;

/**
 * Canonical task lifecycle shared by daemon and server so both agree on legal
 * edges. Happy path: backlog→ready→claimed→in_progress→review→validation→
 * completed; blocked/failed/cancelled are reachable from active states with
 * explicit recovery edges. The server is authoritative in team mode.
 */
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

export function canTransition(from: TaskState, to: TaskState): boolean {
  return TASK_TRANSITIONS[from].includes(to);
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------
const SessionStartedPayload = obj({
  cwd: z.string().min(1),
  workspace_id: z.string().optional(),
  model: z.string().optional(),
  prompt_summary: summary.optional(),
  provider_version: z.string().optional(),
  fidelity: FidelitySchema,
});
const SessionStatusPayload = obj({
  status: SessionStatusSchema,
  detail: z.string().optional(),
});
const SessionEndedPayload = obj({
  reason: SessionEndReasonSchema,
  duration_ms: nonneg.optional(),
  tool_counts: z.record(nonneg).optional(),
  files_touched_count: nonneg.optional(),
});
const PromptSubmittedPayload = obj({
  prompt_summary: summary,
  prompt_hash: hash,
});

// ---------------------------------------------------------------------------
// Tool and command activity
// ---------------------------------------------------------------------------
const ToolPrePayload = obj({
  tool_name: z.string().min(1),
  tool_input_summary: z.record(z.unknown()).optional(),
  tool_use_id: z.string().optional(),
  reservation_check: ReservationCheckSchema.optional(),
});
const ToolPostPayload = obj({
  tool_name: z.string().min(1),
  tool_use_id: z.string().optional(),
  duration_ms: nonneg.optional(),
  success: z.boolean(),
  output_digest: z.string().optional(),
  output_excerpt: z.string().max(2048).optional(),
});
const ToolFailedPayload = obj({
  tool_name: z.string().min(1),
  tool_use_id: z.string().optional(),
  error_class: z.string().optional(),
  error_excerpt: z.string().optional(),
});
const CommandExecutedPayload = obj({
  command_display: z.string().min(1),
  exit_code: int.optional(),
  duration_ms: nonneg.optional(),
  cwd: z.string().optional(),
});

// ---------------------------------------------------------------------------
// File and symbol activity
// ---------------------------------------------------------------------------
const FileChangedPayload = obj({
  path: z.string().min(1),
  change_kind: FileChangeKindSchema,
  old_hash: z.string().optional(),
  new_hash: z.string().optional(),
  lines_added: nonneg.optional(),
  lines_removed: nonneg.optional(),
  source: FileChangeSourceSchema,
});
const SymbolChangeSchema = obj({
  name: z.string().min(1),
  kind: SymbolKindSchema,
  change_kind: SymbolChangeKindSchema,
  old_signature: z.string().optional(),
  new_signature: z.string().optional(),
});
const SymbolsChangedPayload = obj({
  path: z.string().min(1),
  content_hash: hash,
  symbols: z.array(SymbolChangeSchema),
});
const CommitCreatedPayload = obj({
  oid: z.string().min(1),
  branch: z.string().min(1),
  parents: z.array(z.string()),
  message_summary: z.string().optional(),
  files_changed_count: nonneg.optional(),
  task_trailer: z.string().optional(),
});
const BranchPayload = obj({
  name: z.string().min(1),
  head_oid: z.string().min(1),
  task_id: z.string().optional(),
  kind: z.string().optional(),
});
const WorktreePayload = obj({
  path: z.string().min(1),
  branch: z.string().min(1),
  task_id: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Coordination (durable)
// ---------------------------------------------------------------------------
const TaskMutationPayload = obj({
  version: nonneg,
  changed_fields: z.array(z.string()).optional(),
  snapshot_digest: z.string().optional(),
});
const TaskClaimPayload = obj({
  version: nonneg,
  claimant: ActorSchema.optional(),
  provisional: z.boolean().optional(),
});
const TaskClaimRejectedPayload = obj({
  version: nonneg,
  winner_claimant: ActorSchema.optional(),
  reason: z.string().optional(),
});
const TaskStateChangedPayload = obj({
  from: TaskStateSchema,
  to: TaskStateSchema,
  version: nonneg,
  reason: z.string().optional(),
});
const TaskProgressPayload = obj({
  summary,
  percent: z.number().min(0).max(100).optional(),
  evidence_refs: z.array(z.string()).optional(),
});
const TaskCompletionClaimedPayload = obj({
  claim_text: z.string(),
  evidence_state: z.literal('unverified'),
});
const TaskCommentedPayload = obj({
  author: ActorSchema,
  body: z.string(),
});
const TaskHandedOffPayload = obj({
  author: ActorSchema,
  handoff_bundle: z.record(z.unknown()),
});
const ReservationPayload = obj({
  path_glob: z.string().min(1),
  mode: ReservationModeSchema,
  expires_at: z.string().datetime({ offset: true }).optional(),
  grace_until: z.string().datetime({ offset: true }).optional(),
  holder_task_id: z.string().optional(),
});
const ConflictPayload = obj({
  canonical_key: z.string().min(1),
  conflict_id: z.string().optional(),
  kind: ConflictKindSchema.optional(),
  severity: ConflictSeveritySchema.optional(),
  state: ConflictStateSchema.optional(),
  evidence: z.array(z.record(z.unknown())).optional(),
  detection_epoch: nonneg.optional(),
});
const MergePayload = obj({
  entry_id: z.string().min(1),
  position: nonneg.optional(),
  base_oid: z.string().optional(),
  tree_oid: z.string().optional(),
  executor_device_id: z.string().optional(),
  lease_epoch: nonneg.optional(),
  reason: z.string().optional(),
});
const SummaryCompactedPayload = obj({
  seq_start: nonneg,
  seq_end: nonneg,
  dropped_types: z.array(z.string()),
  reason: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Verification and health
// ---------------------------------------------------------------------------
const ValidationStartedPayload = obj({
  run_id: z.string().min(1),
  trigger: ValidationTriggerSchema,
  candidate_oid: z.string().optional(),
  checks: z.array(z.string()),
  selection: ValidationSelectionSchema,
});
const CheckCompletedPayload = obj({
  run_id: z.string().min(1),
  check_id: z.string().min(1),
  exit_code: int,
  duration_ms: nonneg.optional(),
  log_digest: z.string().optional(),
  newly_failing: z.boolean().optional(),
});
const ValidationCheckSchema = obj({
  check_id: z.string().min(1),
  exit_code: int,
  duration_ms: nonneg.optional(),
  selection: ValidationSelectionSchema.optional(),
});
const ValidationCompletedPayload = obj({
  run_id: z.string().min(1),
  state: ValidationStateSchema,
  candidate_oid: z.string().optional(),
  input_hash: z.string().optional(),
  cache_hit: z.boolean().optional(),
  checks: z.array(ValidationCheckSchema).optional(),
});
const HealthBaselinePayload = obj({
  branch: z.string().min(1),
  commit_oid: z.string().min(1),
  checks_summary: z.record(z.unknown()).optional(),
});
const HealthRegressionPayload = obj({
  baseline_id: z.string().min(1),
  failure_fingerprint: z.string().min(1),
  suspected_changes: z.array(z.record(z.unknown())),
});
const NotificationCreatedPayload = obj({
  kind: z.string().min(1),
  subject: z.string().optional(),
  target_user_id: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Catalog registry
// ---------------------------------------------------------------------------
export const PAYLOAD_SCHEMAS = {
  'session.started': SessionStartedPayload,
  'session.status': SessionStatusPayload,
  'session.ended': SessionEndedPayload,
  'prompt.submitted': PromptSubmittedPayload,
  'tool.pre': ToolPrePayload,
  'tool.post': ToolPostPayload,
  'tool.failed': ToolFailedPayload,
  'command.executed': CommandExecutedPayload,
  'file.changed': FileChangedPayload,
  'symbols.changed': SymbolsChangedPayload,
  'commit.created': CommitCreatedPayload,
  'branch.created': BranchPayload,
  'branch.updated': BranchPayload,
  'worktree.created': WorktreePayload,
  'worktree.removed': WorktreePayload,
  'task.created': TaskMutationPayload,
  'task.updated': TaskMutationPayload,
  'task.assigned': TaskMutationPayload,
  'task.claimed': TaskClaimPayload,
  'task.released': TaskClaimPayload,
  'task.claim_rejected': TaskClaimRejectedPayload,
  'task.state_changed': TaskStateChangedPayload,
  'task.progress': TaskProgressPayload,
  'task.completion_claimed': TaskCompletionClaimedPayload,
  'task.commented': TaskCommentedPayload,
  'task.handed_off': TaskHandedOffPayload,
  'reservation.acquired': ReservationPayload,
  'reservation.renewed': ReservationPayload,
  'reservation.released': ReservationPayload,
  'reservation.denied': ReservationPayload,
  'conflict.detected': ConflictPayload,
  'conflict.resolved': ConflictPayload,
  'conflict.dismissed': ConflictPayload,
  'merge.queued': MergePayload,
  'merge.testing': MergePayload,
  'merge.merged': MergePayload,
  'merge.ejected': MergePayload,
  'summary.compacted': SummaryCompactedPayload,
  'validation.started': ValidationStartedPayload,
  'check.completed': CheckCompletedPayload,
  'validation.completed': ValidationCompletedPayload,
  'health.baseline_established': HealthBaselinePayload,
  'health.regression': HealthRegressionPayload,
  'notification.created': NotificationCreatedPayload,
} as const satisfies Record<string, z.ZodTypeAny>;

export type KnownEventType = keyof typeof PAYLOAD_SCHEMAS;
export type PayloadOf<T extends KnownEventType> = z.infer<(typeof PAYLOAD_SCHEMAS)[T]>;

export const KNOWN_EVENT_TYPES = Object.keys(PAYLOAD_SCHEMAS) as KnownEventType[];
export const EventTypeSchema = z.enum(KNOWN_EVENT_TYPES as [KnownEventType, ...KnownEventType[]]);

/** Coordination event types are durable (never expire / never compacted away). */
export const COORDINATION_EVENT_TYPES: ReadonlySet<string> = new Set(
  KNOWN_EVENT_TYPES.filter(
    (t) =>
      t.startsWith('task.') ||
      t.startsWith('reservation.') ||
      t.startsWith('conflict.') ||
      t.startsWith('merge.') ||
      t.startsWith('validation.') ||
      t === 'check.completed' ||
      t === 'commit.created',
  ),
);

export function isCoordinationEvent(type: string): boolean {
  return COORDINATION_EVENT_TYPES.has(type);
}

export function isKnownEventType(type: string): type is KnownEventType {
  return Object.prototype.hasOwnProperty.call(PAYLOAD_SCHEMAS, type);
}

export type ParseResult =
  { success: true; data: EventEnvelope } | { success: false; error: z.ZodError };

/**
 * Validate an envelope and, for known types, its payload. Unknown event types
 * are accepted and their payload preserved verbatim (forward compatibility).
 * The returned payload is the original object — additive fields are not stripped.
 */
export function safeParseEvent(raw: unknown): ParseResult {
  const envResult = EventEnvelopeSchema.safeParse(raw);
  if (!envResult.success) return { success: false, error: envResult.error };
  const env = envResult.data;
  if (isKnownEventType(env.type)) {
    const payloadResult = PAYLOAD_SCHEMAS[env.type].safeParse(env.payload);
    if (!payloadResult.success) return { success: false, error: payloadResult.error };
  }
  return { success: true, data: env };
}

export function parseEvent(raw: unknown): EventEnvelope {
  const result = safeParseEvent(raw);
  if (!result.success) throw result.error;
  return result.data;
}
