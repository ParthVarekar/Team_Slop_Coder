import { createHash } from 'node:crypto';
import { z } from 'zod';
import { redact, type SqliteDatabase } from '@weft/core';
import {
  makeId,
  ulid,
  isSystemActor,
  canTransition,
  TaskStateSchema,
  type TaskState,
  type Actor,
  type EventEnvelope,
} from '@weft/protocol';
import { draftEvent, type EventSource } from './events.js';

export const TaskPrioritySchema = z.enum(['P0', 'P1', 'P2', 'P3']);
export type TaskPriority = z.infer<typeof TaskPrioritySchema>;

// The lifecycle machine is shared with the server via @weft/protocol so both
// deployments agree on legal edges; re-exported here for existing callers.
export { TASK_TRANSITIONS, canTransition } from '@weft/protocol';

export type TaskErrorCode =
  'not_found' | 'conflict' | 'invalid_transition' | 'validation' | 'evidence_required';

export class TaskError extends Error {
  constructor(
    readonly code: TaskErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'TaskError';
  }
}

export interface TaskRecord {
  task_id: string;
  project_id: string;
  repo_id: string | null;
  number: number | null;
  title: string;
  description: string | null;
  acceptance_criteria: string | null;
  validation_requirements: string | null;
  priority: string;
  state: TaskState;
  expected_modules: string | null;
  expected_files: string | null;
  branch: string | null;
  workspace_id: string | null;
  version: number;
  created_by: string | null;
  parent_task_id: string | null;
  edit_conflict: string | null;
  updated_at: string;
}

export interface CompletionClaimRecord {
  id: string;
  task_id: string;
  session_id: string | null;
  claimed_at: string;
  claim_text: string | null;
  evidence_state: string;
}

export const CreateTaskInputSchema = z.object({
  title: z.string().min(1).max(500),
  description: z.string().max(8000).optional(),
  acceptanceCriteria: z.string().max(8000).optional(),
  validationRequirements: z.string().max(8000).optional(),
  priority: TaskPrioritySchema.default('P2'),
  repoId: z.string().min(1).optional(),
  expectedModules: z.array(z.string().min(1)).max(200).optional(),
  expectedFiles: z.array(z.string().min(1)).max(2000).optional(),
  branch: z.string().min(1).optional(),
  parentTaskId: z.string().min(1).optional(),
  state: TaskStateSchema.default('backlog'),
});
export type CreateTaskInput = z.input<typeof CreateTaskInputSchema>;

export const UpdateTaskInputSchema = z
  .object({
    title: z.string().min(1).max(500).optional(),
    description: z.string().max(8000).nullable().optional(),
    acceptanceCriteria: z.string().max(8000).nullable().optional(),
    validationRequirements: z.string().max(8000).nullable().optional(),
    priority: TaskPrioritySchema.optional(),
    expectedModules: z.array(z.string().min(1)).max(200).nullable().optional(),
    expectedFiles: z.array(z.string().min(1)).max(2000).nullable().optional(),
    branch: z.string().min(1).nullable().optional(),
  })
  .strict();
export type UpdateTaskInput = z.input<typeof UpdateTaskInputSchema>;

const FIELD_COLUMNS: Record<keyof UpdateTaskInput, string> = {
  title: 'title',
  description: 'description',
  acceptanceCriteria: 'acceptance_criteria',
  validationRequirements: 'validation_requirements',
  priority: 'priority',
  expectedModules: 'expected_modules',
  expectedFiles: 'expected_files',
  branch: 'branch',
};

const JSON_FIELDS = new Set<keyof UpdateTaskInput>(['expectedModules', 'expectedFiles']);

export interface TaskStoreOptions {
  source: EventSource;
  actor: Actor;
  /** Sink for coordination events (wired to the pipeline by the daemon). */
  emit?: (event: EventEnvelope) => void;
}

export interface ListTasksOptions {
  state?: TaskState;
  limit?: number;
}

function parseInput<S extends z.ZodTypeAny>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new TaskError('validation', result.error.issues.map((i) => i.message).join('; '));
  }
  return result.data;
}

function snapshotDigest(record: TaskRecord): string {
  return createHash('sha256').update(JSON.stringify(record)).digest('hex').slice(0, 16);
}

/** Local, event-sourced task store with optimistic-concurrency (version CAS). */
export class LocalTaskStore {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly options: TaskStoreOptions,
  ) {}

  create(input: CreateTaskInput): TaskRecord {
    const parsed = parseInput(CreateTaskInputSchema, input);
    const now = new Date().toISOString();
    const taskId = makeId('task');
    const tx = this.db.transaction(() => {
      const row = this.db
        .prepare('SELECT COALESCE(MAX(number), 0) + 1 AS n FROM tasks WHERE project_id = ?')
        .get(this.options.source.projectId) as { n: number };
      this.db
        .prepare(
          `INSERT INTO tasks
             (task_id, project_id, repo_id, number, title, description, acceptance_criteria,
              validation_requirements, priority, state, expected_modules, expected_files,
              branch, version, created_by, parent_task_id, updated_at)
           VALUES
             (@task_id, @project_id, @repo_id, @number, @title, @description, @acceptance_criteria,
              @validation_requirements, @priority, @state, @expected_modules, @expected_files,
              @branch, 0, @created_by, @parent_task_id, @updated_at)`,
        )
        .run({
          task_id: taskId,
          project_id: this.options.source.projectId,
          repo_id: parsed.repoId ?? this.options.source.repoId ?? null,
          number: row.n,
          title: parsed.title,
          description: parsed.description ?? null,
          acceptance_criteria: parsed.acceptanceCriteria ?? null,
          validation_requirements: parsed.validationRequirements ?? null,
          priority: parsed.priority,
          state: parsed.state,
          expected_modules: parsed.expectedModules ? JSON.stringify(parsed.expectedModules) : null,
          expected_files: parsed.expectedFiles ? JSON.stringify(parsed.expectedFiles) : null,
          branch: parsed.branch ?? null,
          created_by: isSystemActor(this.options.actor) ? null : this.options.actor.user_id,
          parent_task_id: parsed.parentTaskId ?? null,
          updated_at: now,
        });
    });
    tx();
    const record = this.requireTask(taskId);
    this.emit('task.created', record, {
      version: record.version,
      changed_fields: Object.keys(parsed),
      snapshot_digest: snapshotDigest(record),
    });
    return record;
  }

  getTask(taskId: string): TaskRecord | undefined {
    return this.db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId) as
      TaskRecord | undefined;
  }

  listTasks(projectId: string, options: ListTasksOptions = {}): TaskRecord[] {
    const params: Record<string, unknown> = { project: projectId, limit: options.limit ?? 200 };
    let where = 'project_id = @project';
    if (options.state) {
      where += ' AND state = @state';
      params.state = options.state;
    }
    return this.db
      .prepare(
        `SELECT * FROM tasks WHERE ${where} ORDER BY priority ASC, updated_at DESC LIMIT @limit`,
      )
      .all(params) as TaskRecord[];
  }

  /** Field-level update guarded by base version; disjoint fields commute in M2. */
  update(taskId: string, baseVersion: number, fields: UpdateTaskInput): TaskRecord {
    const parsed = parseInput(UpdateTaskInputSchema, fields);
    const existing = this.requireTask(taskId);
    const entries = Object.entries(parsed) as [keyof UpdateTaskInput, unknown][];
    if (entries.length === 0) return existing;
    const sets: string[] = ['version = version + 1', 'updated_at = @updated_at'];
    const params: Record<string, unknown> = {
      task_id: taskId,
      base: baseVersion,
      updated_at: new Date().toISOString(),
    };
    const changed: string[] = [];
    for (const [field, value] of entries) {
      const column = FIELD_COLUMNS[field];
      sets.push(`${column} = @${column}`);
      params[column] = JSON_FIELDS.has(field) && value !== null ? JSON.stringify(value) : value;
      changed.push(column);
    }
    const result = this.db
      .prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE task_id = @task_id AND version = @base`)
      .run(params);
    if (result.changes === 0) {
      throw new TaskError('conflict', `task ${taskId} changed since version ${baseVersion}`);
    }
    const record = this.requireTask(taskId);
    this.emit('task.updated', record, {
      version: record.version,
      changed_fields: changed,
      snapshot_digest: snapshotDigest(record),
    });
    return record;
  }

  transition(taskId: string, baseVersion: number, to: TaskState, reason?: string): TaskRecord {
    const target = parseInput(TaskStateSchema, to);
    const existing = this.requireTask(taskId);
    if (!canTransition(existing.state, target)) {
      throw new TaskError('invalid_transition', `cannot move ${existing.state} → ${target}`);
    }
    if (target === 'completed' && !this.hasPassingValidation(taskId)) {
      throw new TaskError(
        'evidence_required',
        `task ${taskId} cannot complete without a passing validation run; completion is a claim, not a fact`,
      );
    }
    const result = this.db
      .prepare(
        `UPDATE tasks SET state = @to, version = version + 1, updated_at = @updated_at
         WHERE task_id = @task_id AND version = @base`,
      )
      .run({
        to: target,
        updated_at: new Date().toISOString(),
        task_id: taskId,
        base: baseVersion,
      });
    if (result.changes === 0) {
      throw new TaskError('conflict', `task ${taskId} changed since version ${baseVersion}`);
    }
    const record = this.requireTask(taskId);
    this.emit('task.state_changed', record, {
      from: existing.state,
      to: target,
      version: record.version,
      ...(reason ? { reason } : {}),
    });
    return record;
  }

  /**
   * Record a completion CLAIM — never a completed state. The claim is stored as
   * evidence_state='unverified' and emitted as task.completion_claimed; moving to
   * COMPLETED still requires a passing validation run (see transition guard).
   */
  claimCompletion(taskId: string, claimText: string, sessionId?: string): CompletionClaimRecord {
    const task = this.requireTask(taskId);
    const id = ulid();
    const claimedAt = new Date().toISOString();
    const text = redact(claimText);
    this.db
      .prepare(
        `INSERT INTO completion_claims (id, task_id, session_id, claimed_at, claim_text, evidence_state)
         VALUES (@id, @task_id, @session_id, @claimed_at, @claim_text, 'unverified')`,
      )
      .run({
        id,
        task_id: taskId,
        session_id: sessionId ?? null,
        claimed_at: claimedAt,
        claim_text: text,
      });
    const claim: CompletionClaimRecord = {
      id,
      task_id: taskId,
      session_id: sessionId ?? null,
      claimed_at: claimedAt,
      claim_text: text,
      evidence_state: 'unverified',
    };
    this.emit('task.completion_claimed', task, { claim_text: text, evidence_state: 'unverified' });
    return claim;
  }

  listClaims(taskId: string): CompletionClaimRecord[] {
    return this.db
      .prepare('SELECT * FROM completion_claims WHERE task_id = ? ORDER BY claimed_at DESC')
      .all(taskId) as CompletionClaimRecord[];
  }

  private hasPassingValidation(taskId: string): boolean {
    const row = this.db
      .prepare(`SELECT 1 AS ok FROM validation_runs WHERE task_id = ? AND state = 'passed' LIMIT 1`)
      .get(taskId) as { ok: number } | undefined;
    return row !== undefined;
  }

  private requireTask(taskId: string): TaskRecord {
    const record = this.getTask(taskId);
    if (!record) throw new TaskError('not_found', `task ${taskId} not found`);
    return record;
  }

  private emit(type: string, task: TaskRecord, payload: Record<string, unknown>): void {
    if (!this.options.emit) return;
    this.options.emit(
      draftEvent(this.options.source, {
        type,
        actor: this.options.actor,
        taskId: task.task_id,
        ...(task.repo_id ? { repoId: task.repo_id } : {}),
        payload,
        privacy: 'metadata',
      }),
    );
  }
}
