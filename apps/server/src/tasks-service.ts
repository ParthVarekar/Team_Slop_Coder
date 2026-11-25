import { createHash } from 'node:crypto';
import type { Client, Pool } from 'pg';
import { z } from 'zod';
import { metrics, redact, type Logger } from '@weft/core';
import {
  makeId,
  ulid,
  canTransition,
  isSystemActor,
  applyTaskEvent,
  TaskStateSchema,
  ActorSchema,
  type Actor,
  type TaskState,
  type TaskSnapshot,
  type TaskEvent,
  type EditConflict,
} from '@weft/protocol';
import { withTransaction, clientExecutor } from './pg.js';
import { appendCoordinationEvent } from './emit.js';
import { recordAudit } from './audit.js';

export const TaskPrioritySchema = z.enum(['P0', 'P1', 'P2', 'P3']);

const created = metrics.counter('weft_server_tasks_created_total', 'Tasks created');
const claimedOk = metrics.counter('weft_server_tasks_claimed_total', 'Claims granted');
const claimRejected = metrics.counter('weft_server_tasks_claim_rejected_total', 'Claims rejected');
const editConflicts = metrics.counter(
  'weft_server_tasks_edit_conflicts_total',
  'Field merge conflicts',
);
const claimsRecorded = metrics.counter(
  'weft_server_tasks_completion_claims_total',
  'Completion claims recorded',
);

// ---------------------------------------------------------------------------
// Snapshot helpers (the fold reducer + types live in @weft/protocol)
// ---------------------------------------------------------------------------
const EDITABLE_COLUMNS = [
  'title',
  'description',
  'acceptance_criteria',
  'validation_requirements',
  'priority',
  'expected_modules',
  'expected_files',
  'branch',
] as const;
type EditableColumn = (typeof EDITABLE_COLUMNS)[number];

function digest(snapshot: TaskSnapshot): string {
  return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex').slice(0, 16);
}

function arr(value: unknown): string[] {
  return Array.isArray(value) ? value.map((v) => String(v)) : [];
}

function rowToSnapshot(r: Record<string, unknown>): TaskSnapshot {
  return {
    id: String(r.id),
    project_id: String(r.project_id),
    repo_id: r.repo_id == null ? null : String(r.repo_id),
    number: Number(r.number),
    title: String(r.title),
    description: r.description == null ? null : String(r.description),
    acceptance_criteria: arr(r.acceptance_criteria),
    validation_requirements: (r.validation_requirements as Record<string, unknown>) ?? {},
    priority: String(r.priority),
    state: String(r.state) as TaskState,
    expected_modules: arr(r.expected_modules),
    expected_files: arr(r.expected_files),
    branch: r.branch == null ? null : String(r.branch),
    workspace_id: r.workspace_id == null ? null : String(r.workspace_id),
    version: Number(r.version),
    created_by: r.created_by == null ? null : String(r.created_by),
    parent_task_id: r.parent_task_id == null ? null : String(r.parent_task_id),
    edit_conflict: (r.edit_conflict as EditConflict | null) ?? null,
  };
}

const SNAPSHOT_COLS = `id, project_id, repo_id, number, title, description, acceptance_criteria,
  validation_requirements, priority, state, expected_modules, expected_files, branch,
  workspace_id, version, created_by, parent_task_id, edit_conflict`;

async function lockSnapshot(
  client: Client,
  taskId: string,
  projectId: string,
): Promise<TaskSnapshot> {
  const res = await client.query(
    `SELECT ${SNAPSHOT_COLS} FROM tasks WHERE id = $1 AND project_id = $2 FOR UPDATE`,
    [taskId, projectId],
  );
  const row = res.rows[0];
  if (!row) throw new TaskError('not_found', `task ${taskId} not found`);
  return rowToSnapshot(row);
}

async function insertSnapshot(client: Client, s: TaskSnapshot): Promise<void> {
  await client.query(
    `INSERT INTO tasks
       (id, project_id, repo_id, number, title, description, acceptance_criteria,
        validation_requirements, priority, state, expected_modules, expected_files,
        branch, workspace_id, version, created_by, parent_task_id, edit_conflict)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
    [
      s.id,
      s.project_id,
      s.repo_id,
      s.number,
      s.title,
      s.description,
      JSON.stringify(s.acceptance_criteria),
      JSON.stringify(s.validation_requirements),
      s.priority,
      s.state,
      JSON.stringify(s.expected_modules),
      JSON.stringify(s.expected_files),
      s.branch,
      s.workspace_id,
      s.version,
      s.created_by,
      s.parent_task_id,
      s.edit_conflict ? JSON.stringify(s.edit_conflict) : null,
    ],
  );
}

async function writeSnapshot(client: Client, s: TaskSnapshot): Promise<void> {
  await client.query(
    `UPDATE tasks SET repo_id=$2, title=$3, description=$4, acceptance_criteria=$5,
        validation_requirements=$6, priority=$7, state=$8, expected_modules=$9,
        expected_files=$10, branch=$11, workspace_id=$12, version=$13, created_by=$14,
        parent_task_id=$15, edit_conflict=$16, updated_at=now()
      WHERE id=$1`,
    [
      s.id,
      s.repo_id,
      s.title,
      s.description,
      JSON.stringify(s.acceptance_criteria),
      JSON.stringify(s.validation_requirements),
      s.priority,
      s.state,
      JSON.stringify(s.expected_modules),
      JSON.stringify(s.expected_files),
      s.branch,
      s.workspace_id,
      s.version,
      s.created_by,
      s.parent_task_id,
      s.edit_conflict ? JSON.stringify(s.edit_conflict) : null,
    ],
  );
}

async function appendTaskEvent(client: Client, taskId: string, event: TaskEvent): Promise<void> {
  await client.query(
    `INSERT INTO task_events (task_id, version, type, actor, payload) VALUES ($1,$2,$3,$4,$5)`,
    [taskId, event.version, event.type, JSON.stringify(event.actor), JSON.stringify(event.payload)],
  );
}

// ---------------------------------------------------------------------------
// Errors + inputs
// ---------------------------------------------------------------------------
export type TaskErrorCode =
  'not_found' | 'conflict' | 'invalid_transition' | 'validation' | 'cycle' | 'evidence_required';

export class TaskError extends Error {
  constructor(
    readonly code: TaskErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'TaskError';
  }
}

export const CreateTaskSchema = z.object({
  title: z.string().min(1).max(500),
  description: z.string().max(8000).optional(),
  acceptanceCriteria: z.array(z.string().min(1)).max(200).default([]),
  validationRequirements: z.record(z.unknown()).default({}),
  priority: TaskPrioritySchema.default('P2'),
  repoId: z.string().min(1).optional(),
  expectedModules: z.array(z.string().min(1)).max(200).default([]),
  expectedFiles: z.array(z.string().min(1)).max(2000).default([]),
  branch: z.string().min(1).optional(),
  parentTaskId: z.string().min(1).optional(),
  state: TaskStateSchema.default('backlog'),
});
export type CreateTaskInput = z.input<typeof CreateTaskSchema>;

export const TaskFieldsSchema = z
  .object({
    title: z.string().min(1).max(500).optional(),
    description: z.string().max(8000).nullable().optional(),
    acceptanceCriteria: z.array(z.string().min(1)).max(200).optional(),
    validationRequirements: z.record(z.unknown()).nullable().optional(),
    priority: TaskPrioritySchema.optional(),
    expectedModules: z.array(z.string().min(1)).max(200).nullable().optional(),
    expectedFiles: z.array(z.string().min(1)).max(2000).nullable().optional(),
    branch: z.string().min(1).nullable().optional(),
  })
  .strict();
export type TaskFields = z.input<typeof TaskFieldsSchema>;

export const ClaimSchema = z.object({
  baseVersion: z.number().int().nonnegative().optional(),
  claimant: ActorSchema.optional(),
  deviceId: z.string().min(1).optional(),
  provisional: z.boolean().default(false),
});
export type ClaimInput = z.input<typeof ClaimSchema>;

export type ClaimResult =
  | { ok: true; snapshot: TaskSnapshot; provisional: boolean }
  | { ok: false; reason: string; version: number; winner_claimant: Actor | null };

const FIELD_TO_COLUMN: Record<keyof TaskFields, EditableColumn> = {
  title: 'title',
  description: 'description',
  acceptanceCriteria: 'acceptance_criteria',
  validationRequirements: 'validation_requirements',
  priority: 'priority',
  expectedModules: 'expected_modules',
  expectedFiles: 'expected_files',
  branch: 'branch',
};

function parse<S extends z.ZodTypeAny>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new TaskError('validation', result.error.issues.map((i) => i.message).join('; '));
  return result.data;
}

function columnValue(column: EditableColumn, value: unknown): unknown {
  if (
    column === 'acceptance_criteria' ||
    column === 'expected_modules' ||
    column === 'expected_files'
  ) {
    return value == null ? [] : value;
  }
  if (column === 'validation_requirements') return value == null ? {} : value;
  return value;
}

export interface Origin {
  actor: Actor;
  deviceId: string;
}

export interface CompletionClaim {
  id: string;
  task_id: string;
  session_id: string | null;
  claimed_at: string;
  claim_text: string | null;
  evidence_state: string;
}

export interface ListOptions {
  state?: TaskState;
  limit?: number;
}

/**
 * Server-authoritative task store. Every mutation locks the task row, folds a
 * single event onto the current snapshot to derive the next one (so the live
 * row equals the event fold by construction), bumps the version, and appends
 * both the task_events trail and a coordination fan-out event in one transaction.
 * Claims are atomic CAS on state under the row lock: concurrent claims serialize
 * and exactly one wins; losers receive a deterministic task.claim_rejected.
 */
export class TaskService {
  constructor(
    private readonly pool: Pool,
    private readonly logger?: Logger,
  ) {}

  async create(projectId: string, input: CreateTaskInput, origin: Origin): Promise<TaskSnapshot> {
    const parsed = parse(CreateTaskSchema, input);
    const snapshot = await withTransaction(this.pool, async (client) => {
      const proj = await client.query('SELECT 1 FROM projects WHERE id = $1', [projectId]);
      if (proj.rows.length === 0)
        throw new TaskError('not_found', `project ${projectId} not found`);
      // Serialize per-project numbering so concurrent creates never collide on
      // the UNIQUE (project_id, number) constraint.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `${projectId}:task-number`,
      ]);
      const numRes = await client.query(
        'SELECT COALESCE(MAX(number), 0) + 1 AS n FROM tasks WHERE project_id = $1',
        [projectId],
      );
      const number = Number(numRes.rows[0]?.n);
      const s: TaskSnapshot = {
        id: makeId('task'),
        project_id: projectId,
        repo_id: parsed.repoId ?? null,
        number,
        title: parsed.title,
        description: parsed.description ?? null,
        acceptance_criteria: parsed.acceptanceCriteria,
        validation_requirements: parsed.validationRequirements,
        priority: parsed.priority,
        state: parsed.state,
        expected_modules: parsed.expectedModules,
        expected_files: parsed.expectedFiles,
        branch: parsed.branch ?? null,
        workspace_id: null,
        version: 0,
        created_by: isSystemActor(origin.actor) ? null : origin.actor.user_id,
        parent_task_id: parsed.parentTaskId ?? null,
        edit_conflict: null,
      };
      await insertSnapshot(client, s);
      const payload = {
        version: 0,
        changed_fields: [...EDITABLE_COLUMNS, 'state', 'priority'],
        snapshot_digest: digest(s),
        snapshot: s,
      };
      await appendTaskEvent(client, s.id, {
        type: 'task.created',
        version: 0,
        actor: origin.actor,
        payload,
      });
      await appendCoordinationEvent(client, {
        projectId,
        deviceId: origin.deviceId,
        type: 'task.created',
        actor: origin.actor,
        payload,
        taskId: s.id,
        ...(s.repo_id ? { repoId: s.repo_id } : {}),
      });
      await recordAudit(clientExecutor(client), {
        projectId,
        actor: origin.actor,
        action: 'task.created',
        subject: `task:${s.id}`,
        afterHash: digest(s),
      });
      return s;
    });
    created.inc();
    this.logger?.debug({ taskId: snapshot.id, projectId }, 'task created');
    return snapshot;
  }

  async get(taskId: string, projectId: string): Promise<TaskSnapshot | undefined> {
    const res = await this.pool.query(
      `SELECT ${SNAPSHOT_COLS} FROM tasks WHERE id = $1 AND project_id = $2`,
      [taskId, projectId],
    );
    return res.rows[0] ? rowToSnapshot(res.rows[0]) : undefined;
  }

  async list(projectId: string, options: ListOptions = {}): Promise<TaskSnapshot[]> {
    const params: unknown[] = [projectId];
    let where = 'project_id = $1';
    if (options.state) {
      params.push(options.state);
      where += ` AND state = $${params.length}`;
    }
    params.push(options.limit ?? 200);
    const res = await this.pool.query(
      `SELECT ${SNAPSHOT_COLS} FROM tasks WHERE ${where}
        ORDER BY priority ASC, number ASC LIMIT $${params.length}`,
      params,
    );
    return res.rows.map(rowToSnapshot);
  }

  /**
   * Field-level merge. Disjoint fields commute onto the current snapshot even
   * from a stale base; a field changed since the base by another writer is NOT
   * silently overwritten — both values are preserved in edit_conflict for human
   * resolution while non-conflicting fields still apply.
   */
  async update(
    taskId: string,
    projectId: string,
    baseVersion: number,
    fields: TaskFields,
    origin: Origin,
  ): Promise<TaskSnapshot> {
    const parsed = parse(TaskFieldsSchema, fields);
    const entries = Object.entries(parsed) as [keyof TaskFields, unknown][];
    return withTransaction(this.pool, async (client) => {
      const current = await lockSnapshot(client, taskId, projectId);
      if (baseVersion > current.version)
        throw new TaskError(
          'conflict',
          `base version ${baseVersion} is ahead of ${current.version}`,
        );
      if (entries.length === 0) return current;

      const changed = await client.query(
        `SELECT payload->'changed_fields' AS fields FROM task_events
          WHERE task_id = $1 AND type = 'task.updated' AND version > $2`,
        [taskId, baseVersion],
      );
      const changedSinceBase = new Set<string>();
      for (const row of changed.rows) {
        for (const f of (row.fields as string[] | null) ?? []) changedSinceBase.add(f);
      }

      const values: Record<string, unknown> = {};
      const conflicts: EditConflict = {};
      const appliedColumns: string[] = [];
      for (const [field, raw] of entries) {
        const column = FIELD_TO_COLUMN[field];
        const value = columnValue(column, raw);
        if (changedSinceBase.has(column)) {
          conflicts[column] = {
            current: current[column],
            incoming: value,
            base_version: baseVersion,
            detected_at_version: current.version,
          };
        } else {
          values[column] = value;
          appliedColumns.push(column);
        }
      }

      const merged: EditConflict = { ...(current.edit_conflict ?? {}), ...conflicts };
      const editConflict = Object.keys(merged).length > 0 ? merged : null;
      const version = current.version + 1;
      const payload = {
        version,
        changed_fields: appliedColumns,
        snapshot_digest: '',
        values,
        edit_conflict: editConflict,
      };
      const next = applyTaskEvent(current, {
        type: 'task.updated',
        version,
        actor: origin.actor,
        payload,
      }) as TaskSnapshot;
      payload.snapshot_digest = digest(next);
      await writeSnapshot(client, next);
      await appendTaskEvent(client, taskId, {
        type: 'task.updated',
        version,
        actor: origin.actor,
        payload,
      });
      await appendCoordinationEvent(client, {
        projectId,
        deviceId: origin.deviceId,
        type: 'task.updated',
        actor: origin.actor,
        payload,
        taskId,
        ...(next.repo_id ? { repoId: next.repo_id } : {}),
      });
      await recordAudit(clientExecutor(client), {
        projectId,
        actor: origin.actor,
        action: 'task.updated',
        subject: `task:${taskId}`,
        afterHash: digest(next),
      });
      if (Object.keys(conflicts).length > 0) {
        editConflicts.inc(Object.keys(conflicts).length);
        this.logger?.warn(
          { taskId, fields: Object.keys(conflicts) },
          'task edit conflict recorded',
        );
      }
      return next;
    });
  }

  async transition(
    taskId: string,
    projectId: string,
    baseVersion: number,
    to: TaskState,
    reason: string | undefined,
    origin: Origin,
  ): Promise<TaskSnapshot> {
    const target = parse(TaskStateSchema, to);
    return withTransaction(this.pool, async (client) => {
      const current = await lockSnapshot(client, taskId, projectId);
      if (baseVersion !== current.version)
        throw new TaskError('conflict', `task ${taskId} changed since version ${baseVersion}`);
      if (!canTransition(current.state, target))
        throw new TaskError('invalid_transition', `cannot move ${current.state} → ${target}`);
      if (target === 'completed' && !(await this.hasPassingValidation(client, projectId, taskId)))
        throw new TaskError(
          'evidence_required',
          `task ${taskId} cannot complete without a passing validation run; completion is a claim, not a fact`,
        );
      const version = current.version + 1;
      const payload = { from: current.state, to: target, version, ...(reason ? { reason } : {}) };
      const next = applyTaskEvent(current, {
        type: 'task.state_changed',
        version,
        actor: origin.actor,
        payload,
      }) as TaskSnapshot;
      await writeSnapshot(client, next);
      await appendTaskEvent(client, taskId, {
        type: 'task.state_changed',
        version,
        actor: origin.actor,
        payload,
      });
      await appendCoordinationEvent(client, {
        projectId,
        deviceId: origin.deviceId,
        type: 'task.state_changed',
        actor: origin.actor,
        payload,
        taskId,
        ...(next.repo_id ? { repoId: next.repo_id } : {}),
      });
      await recordAudit(clientExecutor(client), {
        projectId,
        actor: origin.actor,
        action: 'task.state_changed',
        subject: `task:${taskId}`,
        afterHash: digest(next),
      });
      if (target === 'completed') await this.promoteDependents(client, projectId, taskId, origin);
      return next;
    });
  }

  /**
   * Record a completion CLAIM (evidence_state='unverified') — never a completed
   * state. The claim is appended to the task trail and fanned out as a durable
   * coordination event in one transaction; COMPLETED still requires a passing
   * validation run via the transition guard, so a claim cannot become fact alone.
   */
  async claimCompletion(
    taskId: string,
    projectId: string,
    claimText: string,
    origin: Origin,
    sessionId?: string,
  ): Promise<CompletionClaim> {
    return withTransaction(this.pool, async (client) => {
      const current = await lockSnapshot(client, taskId, projectId);
      const id = ulid();
      const text = redact(claimText);
      const claimedAt = new Date().toISOString();
      await client.query(
        `INSERT INTO completion_claims (id, task_id, session_id, claimed_at, claim_text, evidence_state)
         VALUES ($1,$2,$3,$4,$5,'unverified')`,
        [id, taskId, sessionId ?? null, claimedAt, text],
      );
      const payload = { claim_text: text, evidence_state: 'unverified' };
      await appendTaskEvent(client, taskId, {
        type: 'task.completion_claimed',
        version: current.version,
        actor: origin.actor,
        payload,
      });
      await appendCoordinationEvent(client, {
        projectId,
        deviceId: origin.deviceId,
        type: 'task.completion_claimed',
        actor: origin.actor,
        payload,
        taskId,
        ...(current.repo_id ? { repoId: current.repo_id } : {}),
        ...(sessionId ? { sessionId } : {}),
      });
      await recordAudit(clientExecutor(client), {
        projectId,
        actor: origin.actor,
        action: 'task.completion_claimed',
        subject: `task:${taskId}`,
      });
      claimsRecorded.inc();
      return {
        id,
        task_id: taskId,
        session_id: sessionId ?? null,
        claimed_at: claimedAt,
        claim_text: text,
        evidence_state: 'unverified',
      };
    });
  }

  async listClaims(taskId: string, projectId: string): Promise<CompletionClaim[]> {
    await this.requireTaskPool(taskId, projectId);
    const res = await this.pool.query(
      `SELECT id, task_id, session_id, claimed_at, claim_text, evidence_state
         FROM completion_claims WHERE task_id = $1 ORDER BY claimed_at DESC`,
      [taskId],
    );
    return res.rows.map((r) => ({
      id: String(r.id),
      task_id: String(r.task_id),
      session_id: r.session_id == null ? null : String(r.session_id),
      claimed_at: r.claimed_at instanceof Date ? r.claimed_at.toISOString() : String(r.claimed_at),
      claim_text: r.claim_text == null ? null : String(r.claim_text),
      evidence_state: String(r.evidence_state),
    }));
  }

  /**
   * Atomic claim CAS. The row lock serializes concurrent claims: the first to
   * commit moves ready→claimed and wins; every later claim sees a non-ready state
   * and is deterministically rejected with the winner recorded. Offline claims
   * pass provisional=true so a losing daemon can discard its quarantined worktree.
   */
  async claim(
    taskId: string,
    projectId: string,
    input: ClaimInput,
    origin: Origin,
  ): Promise<ClaimResult> {
    const parsed = parse(ClaimSchema, input);
    const claimant = parsed.claimant ?? origin.actor;
    const deviceId = parsed.deviceId ?? origin.deviceId;
    const result = await withTransaction(this.pool, async (client): Promise<ClaimResult> => {
      const current = await lockSnapshot(client, taskId, projectId);
      if (current.state !== 'ready') {
        const winner = await this.primaryClaimant(client, taskId);
        const payload = {
          version: current.version,
          ...(winner ? { winner_claimant: winner } : {}),
          reason: `task is ${current.state}, not ready`,
          claimant,
          device_id: deviceId,
          provisional: parsed.provisional,
        };
        await appendTaskEvent(client, taskId, {
          type: 'task.claim_rejected',
          version: current.version,
          actor: claimant,
          payload,
        });
        await appendCoordinationEvent(client, {
          projectId,
          deviceId,
          type: 'task.claim_rejected',
          actor: claimant,
          payload,
          taskId,
        });
        claimRejected.inc();
        return {
          ok: false,
          reason: payload.reason,
          version: current.version,
          winner_claimant: winner,
        };
      }
      const version = current.version + 1;
      const payload = { version, claimant, provisional: parsed.provisional, device_id: deviceId };
      const next = applyTaskEvent(current, {
        type: 'task.claimed',
        version,
        actor: claimant,
        payload,
      }) as TaskSnapshot;
      await writeSnapshot(client, next);
      await client.query(`DELETE FROM task_assignees WHERE task_id = $1 AND role = 'primary'`, [
        taskId,
      ]);
      await client.query(
        `INSERT INTO task_assignees (task_id, user_id, agent_provider, role) VALUES ($1,$2,$3,'primary')`,
        [
          taskId,
          isSystemActor(claimant) ? null : claimant.user_id,
          isSystemActor(claimant) ? null : (claimant.agent?.provider ?? null),
        ],
      );
      await appendTaskEvent(client, taskId, {
        type: 'task.claimed',
        version,
        actor: claimant,
        payload,
      });
      await appendCoordinationEvent(client, {
        projectId,
        deviceId,
        type: 'task.claimed',
        actor: claimant,
        payload,
        taskId,
        ...(next.repo_id ? { repoId: next.repo_id } : {}),
      });
      await recordAudit(clientExecutor(client), {
        projectId,
        actor: claimant,
        action: 'task.claimed',
        subject: `task:${taskId}`,
        afterHash: digest(next),
      });
      claimedOk.inc();
      return { ok: true, snapshot: next, provisional: parsed.provisional };
    });
    return result;
  }

  async release(
    taskId: string,
    projectId: string,
    baseVersion: number,
    origin: Origin,
  ): Promise<TaskSnapshot> {
    return withTransaction(this.pool, async (client) => {
      const current = await lockSnapshot(client, taskId, projectId);
      if (baseVersion !== current.version)
        throw new TaskError('conflict', `task ${taskId} changed since version ${baseVersion}`);
      if (current.state !== 'claimed')
        throw new TaskError('invalid_transition', `cannot release a ${current.state} task`);
      const version = current.version + 1;
      const payload = { version, to: 'ready', device_id: origin.deviceId };
      const next = applyTaskEvent(current, {
        type: 'task.released',
        version,
        actor: origin.actor,
        payload,
      }) as TaskSnapshot;
      await writeSnapshot(client, next);
      await client.query(`DELETE FROM task_assignees WHERE task_id = $1 AND role = 'primary'`, [
        taskId,
      ]);
      await appendTaskEvent(client, taskId, {
        type: 'task.released',
        version,
        actor: origin.actor,
        payload,
      });
      await appendCoordinationEvent(client, {
        projectId,
        deviceId: origin.deviceId,
        type: 'task.released',
        actor: origin.actor,
        payload,
        taskId,
      });
      await recordAudit(clientExecutor(client), {
        projectId,
        actor: origin.actor,
        action: 'task.released',
        subject: `task:${taskId}`,
        afterHash: digest(next),
      });
      return next;
    });
  }

  /** Apply chosen values for conflicted fields and clear edit_conflict (no silent loss). */
  async resolveEditConflict(
    taskId: string,
    projectId: string,
    baseVersion: number,
    resolutions: TaskFields,
    origin: Origin,
  ): Promise<TaskSnapshot> {
    const parsed = parse(TaskFieldsSchema, resolutions);
    return withTransaction(this.pool, async (client) => {
      const current = await lockSnapshot(client, taskId, projectId);
      if (baseVersion !== current.version)
        throw new TaskError('conflict', `task ${taskId} changed since version ${baseVersion}`);
      const values: Record<string, unknown> = {};
      const appliedColumns: string[] = [];
      for (const [field, raw] of Object.entries(parsed) as [keyof TaskFields, unknown][]) {
        const column = FIELD_TO_COLUMN[field];
        values[column] = columnValue(column, raw);
        appliedColumns.push(column);
      }
      const version = current.version + 1;
      const payload = {
        version,
        changed_fields: appliedColumns,
        snapshot_digest: '',
        values,
        edit_conflict: null,
        resolved_conflict: true,
      };
      const next = applyTaskEvent(current, {
        type: 'task.updated',
        version,
        actor: origin.actor,
        payload,
      }) as TaskSnapshot;
      payload.snapshot_digest = digest(next);
      await writeSnapshot(client, next);
      await appendTaskEvent(client, taskId, {
        type: 'task.updated',
        version,
        actor: origin.actor,
        payload,
      });
      await appendCoordinationEvent(client, {
        projectId,
        deviceId: origin.deviceId,
        type: 'task.updated',
        actor: origin.actor,
        payload,
        taskId,
      });
      await recordAudit(clientExecutor(client), {
        projectId,
        actor: origin.actor,
        action: 'task.conflict_resolved',
        subject: `task:${taskId}`,
        afterHash: digest(next),
      });
      return next;
    });
  }

  // -------------------------------------------------------------------------
  // Dependencies (DAG) + READY computation
  // -------------------------------------------------------------------------
  async addDependency(
    taskId: string,
    projectId: string,
    dependsOn: string,
    origin: Origin,
  ): Promise<void> {
    if (taskId === dependsOn) throw new TaskError('cycle', 'a task cannot depend on itself');
    await withTransaction(this.pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `${projectId}:task-deps`,
      ]);
      await this.requireTask(client, taskId, projectId);
      await this.requireTask(client, dependsOn, projectId);
      if (await this.reaches(client, dependsOn, taskId))
        throw new TaskError('cycle', `dependency ${taskId} → ${dependsOn} would create a cycle`);
      await client.query(
        `INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES ($1,$2)
         ON CONFLICT (task_id, depends_on_task_id) DO NOTHING`,
        [taskId, dependsOn],
      );
      await appendTaskEvent(client, taskId, {
        type: 'task.dependency_added',
        version: 0,
        actor: origin.actor,
        payload: { depends_on: dependsOn },
      });
      await recordAudit(clientExecutor(client), {
        projectId,
        actor: origin.actor,
        action: 'task.dependency_added',
        subject: `task:${taskId}`,
      });
      await this.syncReadiness(client, projectId, taskId, origin);
    });
  }

  async removeDependency(
    taskId: string,
    projectId: string,
    dependsOn: string,
    origin: Origin,
  ): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `${projectId}:task-deps`,
      ]);
      await client.query(
        `DELETE FROM task_dependencies WHERE task_id = $1 AND depends_on_task_id = $2`,
        [taskId, dependsOn],
      );
      await appendTaskEvent(client, taskId, {
        type: 'task.dependency_removed',
        version: 0,
        actor: origin.actor,
        payload: { depends_on: dependsOn },
      });
      await this.syncReadiness(client, projectId, taskId, origin);
    });
  }

  async listDependencies(taskId: string, projectId: string): Promise<string[]> {
    await this.requireTaskPool(taskId, projectId);
    const res = await this.pool.query(
      `SELECT depends_on_task_id FROM task_dependencies WHERE task_id = $1 ORDER BY depends_on_task_id`,
      [taskId],
    );
    return res.rows.map((r) => String(r.depends_on_task_id));
  }

  /** Promote every eligible backlog task (all dependencies completed) to ready. */
  async computeReady(projectId: string, origin: Origin): Promise<TaskSnapshot[]> {
    return withTransaction(this.pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `${projectId}:task-deps`,
      ]);
      const res = await client.query(
        `SELECT id FROM tasks WHERE project_id = $1 AND state IN ('backlog','ready') ORDER BY id`,
        [projectId],
      );
      const changed: TaskSnapshot[] = [];
      for (const row of res.rows) {
        const next = await this.syncReadiness(client, projectId, String(row.id), origin);
        if (next) changed.push(next);
      }
      return changed;
    });
  }

  /** Rebuild the snapshot purely from the task_events fold (verification/recovery). */
  async rebuildSnapshot(taskId: string, projectId: string): Promise<TaskSnapshot | null> {
    await this.requireTaskPool(taskId, projectId);
    const res = await this.pool.query(
      `SELECT type, version, actor, payload FROM task_events WHERE task_id = $1 ORDER BY id ASC`,
      [taskId],
    );
    let snapshot: TaskSnapshot | null = null;
    for (const row of res.rows) {
      snapshot = applyTaskEvent(snapshot, {
        type: String(row.type),
        version: Number(row.version),
        actor: row.actor as Actor,
        payload: row.payload as Record<string, unknown>,
      });
    }
    return snapshot;
  }

  // -------------------------------------------------------------------------
  // Internal helpers (operate on a locked client within a transaction)
  // -------------------------------------------------------------------------
  private async hasPassingValidation(
    client: Client,
    projectId: string,
    taskId: string,
  ): Promise<boolean> {
    const res = await client.query(
      `SELECT 1 FROM validation_runs WHERE project_id = $1 AND task_id = $2 AND state = 'passed' LIMIT 1`,
      [projectId, taskId],
    );
    return res.rows.length > 0;
  }

  private async requireTask(client: Client, taskId: string, projectId: string): Promise<void> {
    const res = await client.query('SELECT 1 FROM tasks WHERE id = $1 AND project_id = $2', [
      taskId,
      projectId,
    ]);
    if (res.rows.length === 0) throw new TaskError('not_found', `task ${taskId} not found`);
  }

  private async requireTaskPool(taskId: string, projectId: string): Promise<void> {
    const res = await this.pool.query('SELECT 1 FROM tasks WHERE id = $1 AND project_id = $2', [
      taskId,
      projectId,
    ]);
    if (res.rows.length === 0) throw new TaskError('not_found', `task ${taskId} not found`);
  }

  private async primaryClaimant(client: Client, taskId: string): Promise<Actor | null> {
    const res = await client.query(
      `SELECT user_id, agent_provider FROM task_assignees WHERE task_id = $1 AND role = 'primary'`,
      [taskId],
    );
    const row = res.rows[0];
    if (!row) return null;
    if (row.user_id != null)
      return {
        user_id: String(row.user_id),
        agent: row.agent_provider
          ? { provider: String(row.agent_provider), adapter: 'server' }
          : null,
      };
    return null;
  }

  /** DFS over task_dependencies: is `target` reachable from `start`? */
  private async reaches(client: Client, start: string, target: string): Promise<boolean> {
    const seen = new Set<string>();
    const stack = [start];
    while (stack.length > 0) {
      const node = stack.pop() as string;
      if (node === target) return true;
      if (seen.has(node)) continue;
      seen.add(node);
      const res = await client.query(
        `SELECT depends_on_task_id FROM task_dependencies WHERE task_id = $1`,
        [node],
      );
      for (const row of res.rows) stack.push(String(row.depends_on_task_id));
    }
    return false;
  }

  private async depsCompleted(client: Client, taskId: string): Promise<boolean> {
    const res = await client.query(
      `SELECT COUNT(*)::int AS c FROM task_dependencies d
         JOIN tasks t ON t.id = d.depends_on_task_id
        WHERE d.task_id = $1 AND t.state <> 'completed'`,
      [taskId],
    );
    return Number(res.rows[0]?.c) === 0;
  }

  /** Adjust a single task between backlog/ready based on dependency satisfaction. */
  private async syncReadiness(
    client: Client,
    projectId: string,
    taskId: string,
    origin: Origin,
  ): Promise<TaskSnapshot | null> {
    const current = await lockSnapshot(client, taskId, projectId);
    const satisfied = await this.depsCompleted(client, taskId);
    let target: TaskState | null = null;
    if (current.state === 'backlog' && satisfied) target = 'ready';
    else if (current.state === 'ready' && !satisfied) target = 'backlog';
    if (!target || !canTransition(current.state, target)) return null;
    const version = current.version + 1;
    const payload = { from: current.state, to: target, version, reason: 'dependency readiness' };
    const next = applyTaskEvent(current, {
      type: 'task.state_changed',
      version,
      actor: origin.actor,
      payload,
    }) as TaskSnapshot;
    await writeSnapshot(client, next);
    await appendTaskEvent(client, taskId, {
      type: 'task.state_changed',
      version,
      actor: origin.actor,
      payload,
    });
    await appendCoordinationEvent(client, {
      projectId,
      deviceId: origin.deviceId,
      type: 'task.state_changed',
      actor: origin.actor,
      payload,
      taskId,
    });
    return next;
  }

  /** After a task completes, promote any dependents whose deps are now satisfied. */
  private async promoteDependents(
    client: Client,
    projectId: string,
    completedTaskId: string,
    origin: Origin,
  ): Promise<void> {
    const res = await client.query(
      `SELECT task_id FROM task_dependencies WHERE depends_on_task_id = $1 ORDER BY task_id`,
      [completedTaskId],
    );
    for (const row of res.rows) {
      await this.syncReadiness(client, projectId, String(row.task_id), origin);
    }
  }
}
