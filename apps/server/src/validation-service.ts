import type { Client, Pool } from 'pg';
import { metrics, redact, type Logger } from '@weft/core';
import { ulid, type EventEnvelope } from '@weft/protocol';
import { clientExecutor } from './pg.js';
import { recordAudit } from './audit.js';

const runsProjected = metrics.counter(
  'weft_server_validation_runs_projected_total',
  'Validation runs materialized from daemon evidence',
);
const checksProjected = metrics.counter(
  'weft_server_validation_checks_projected_total',
  'Check results materialized from daemon evidence',
);
const claimsProjected = metrics.counter(
  'weft_server_completion_claims_total',
  'Completion claims recorded (unverified)',
);

export type ValidationTrigger = 'task' | 'queue' | 'manual' | 'baseline';
export type ValidationSelection = 'full' | 'affected';
export type ValidationRunState = 'running' | 'passed' | 'failed' | 'error';
export type Independence = 'self' | 'independent';

export interface CheckEvidence {
  check_id: string;
  command_display: string;
  exit_code: number | null;
  duration_ms: number;
  log_digest: string;
  log_excerpt: string;
  selection: ValidationSelection;
  newly_failing: boolean;
}

export interface ValidationRunSnapshot {
  id: string;
  project_id: string;
  repo_id: string;
  task_id: string | null;
  trigger: ValidationTrigger;
  candidate_oid: string | null;
  tree_oid: string | null;
  runner_device_id: string | null;
  claimant_device_id: string | null;
  state: ValidationRunState;
  started_at: string;
  finished_at: string | null;
  input_hash: string | null;
  cache_hit: boolean;
  independence: Independence;
  checks: CheckEvidence[];
}

export interface CompletionClaimSnapshot {
  id: string;
  task_id: string;
  session_id: string | null;
  claimed_at: string;
  claim_text: string | null;
  evidence_state: string;
}

export interface ValidationListOptions {
  repoId?: string;
  taskId?: string;
  state?: ValidationRunState;
  until?: string;
  limit?: number;
}

function str(value: unknown): string {
  return value == null ? '' : String(value);
}

function strOrNull(value: unknown): string | null {
  return value == null ? null : String(value);
}

function numOrNull(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

function toIso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function toIsoOrNull(value: unknown): string | null {
  return value == null ? null : toIso(value);
}

/** The protocol carries -1 for "no exit code" (timeout/spawn error); store null. */
function exitCodeOrNull(value: unknown): number | null {
  return typeof value === 'number' && value !== -1 ? value : null;
}

const RUN_COLS = `id, project_id, repo_id, task_id, trigger, candidate_oid, tree_oid,
  runner_device_id, claimant_device_id, state, started_at, finished_at, input_hash,
  cache_hit, independence`;

function rowToRun(r: Record<string, unknown>, checks: CheckEvidence[]): ValidationRunSnapshot {
  return {
    id: str(r.id),
    project_id: str(r.project_id),
    repo_id: str(r.repo_id),
    task_id: strOrNull(r.task_id),
    trigger: (str(r.trigger) || 'manual') as ValidationTrigger,
    candidate_oid: strOrNull(r.candidate_oid),
    tree_oid: strOrNull(r.tree_oid),
    runner_device_id: strOrNull(r.runner_device_id),
    claimant_device_id: strOrNull(r.claimant_device_id),
    state: (str(r.state) || 'running') as ValidationRunState,
    started_at: toIso(r.started_at),
    finished_at: toIsoOrNull(r.finished_at),
    input_hash: strOrNull(r.input_hash),
    cache_hit: r.cache_hit === true,
    independence: (str(r.independence) || 'self') as Independence,
    checks,
  };
}

function rowToCheck(r: Record<string, unknown>): CheckEvidence {
  return {
    check_id: str(r.check_id),
    command_display: str(r.command_display),
    exit_code: numOrNull(r.exit_code),
    duration_ms: r.duration_ms == null ? 0 : Number(r.duration_ms),
    log_digest: str(r.log_digest),
    log_excerpt: str(r.log_excerpt),
    selection: (str(r.selection) || 'full') as ValidationSelection,
    newly_failing: r.newly_failing === true,
  };
}

function rowToClaim(r: Record<string, unknown>): CompletionClaimSnapshot {
  return {
    id: str(r.id),
    task_id: str(r.task_id),
    session_id: strOrNull(r.session_id),
    claimed_at: toIso(r.claimed_at),
    claim_text: strOrNull(r.claim_text),
    evidence_state: str(r.evidence_state),
  };
}

/** Structural projection hook consumed by IngestService (no import cycle). */
export interface ValidationProjection {
  project(client: Client, event: EventEnvelope): Promise<void>;
}

/**
 * Server-side materialization of daemon-produced validation evidence. The server
 * NEVER executes checks itself — commands come only from each machine's local
 * config (no uncontrolled remote execution). Daemons run checks in a detached
 * worktree and emit validation.started / check.completed / validation.completed;
 * this projection folds that evidence into project-scoped validation_runs and
 * check_results inside the ingest transaction, so the run, its checks, and the
 * coordination fan-out commit atomically with the ingested events.
 *
 * Completion claims are materialized as evidence_state='unverified' — a claim is
 * never a completed state. The TaskService transition guard independently requires
 * a passing validation run before COMPLETED, so an unverified claim cannot silently
 * become fact. Unknown projects/tasks are skipped (never roll back the batch).
 */
export class ValidationService implements ValidationProjection {
  constructor(
    private readonly pool: Pool,
    private readonly logger?: Logger,
  ) {}

  async project(client: Client, event: EventEnvelope): Promise<void> {
    const t = event.type;
    if (t === 'task.completion_claimed') return this.projectClaim(client, event);
    if (t !== 'validation.started' && t !== 'check.completed' && t !== 'validation.completed')
      return;
    if (!(await this.projectExists(client, event.project_id))) {
      this.logger?.warn(
        { projectId: event.project_id, type: t, eventId: event.event_id },
        'validation event for unknown project skipped',
      );
      return;
    }
    if (t === 'validation.started') return this.projectStarted(client, event);
    if (t === 'check.completed') return this.projectCheck(client, event);
    return this.projectCompleted(client, event);
  }

  private async projectExists(client: Client, projectId: string): Promise<boolean> {
    const res = await client.query('SELECT 1 FROM projects WHERE id = $1', [projectId]);
    return res.rows.length > 0;
  }

  private async projectStarted(client: Client, event: EventEnvelope): Promise<void> {
    const p = event.payload;
    const runId = str(p['run_id']);
    if (!runId) return;
    await client.query(
      `INSERT INTO validation_runs
         (id, project_id, repo_id, task_id, trigger, candidate_oid, tree_oid,
          runner_device_id, claimant_device_id, state, independence)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'running',$10)
       ON CONFLICT (id) DO UPDATE SET
         repo_id = EXCLUDED.repo_id, task_id = EXCLUDED.task_id, trigger = EXCLUDED.trigger,
         candidate_oid = EXCLUDED.candidate_oid, tree_oid = EXCLUDED.tree_oid,
         runner_device_id = EXCLUDED.runner_device_id,
         claimant_device_id = EXCLUDED.claimant_device_id, independence = EXCLUDED.independence`,
      [
        runId,
        event.project_id,
        event.repo_id ?? '',
        event.task_id ?? null,
        str(p['trigger']) || 'manual',
        strOrNull(p['candidate_oid']),
        strOrNull(p['tree_oid']),
        strOrNull(p['runner_device_id']) ?? event.device_id,
        strOrNull(p['claimant_device_id']),
        str(p['independence']) || 'self',
      ],
    );
    runsProjected.inc();
    await recordAudit(clientExecutor(client), {
      projectId: event.project_id,
      actor: event.actor,
      action: 'validation.started',
      subject: `validation:${runId}`,
    });
  }

  private async projectCheck(client: Client, event: EventEnvelope): Promise<void> {
    const p = event.payload;
    const runId = str(p['run_id']);
    const checkId = str(p['check_id']);
    if (!runId || !checkId) return;
    // Defensive shell: check.completed must never FK-fail the batch if the run
    // row is absent (e.g. started shipped in a prior, already-projected batch).
    await client.query(
      `INSERT INTO validation_runs (id, project_id, repo_id, trigger, state)
       VALUES ($1,$2,$3,'manual','running') ON CONFLICT (id) DO NOTHING`,
      [runId, event.project_id, event.repo_id ?? ''],
    );
    await client.query(
      `INSERT INTO check_results
         (validation_run_id, check_id, command_display, exit_code, duration_ms,
          log_digest, log_excerpt, selection, newly_failing)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        runId,
        checkId,
        strOrNull(p['command_display']),
        exitCodeOrNull(p['exit_code']),
        numOrNull(p['duration_ms']),
        strOrNull(p['log_digest']),
        redact(str(p['log_excerpt'])),
        strOrNull(p['selection']),
        p['newly_failing'] === true,
      ],
    );
    checksProjected.inc();
  }

  private async projectCompleted(client: Client, event: EventEnvelope): Promise<void> {
    const p = event.payload;
    const runId = str(p['run_id']);
    if (!runId) return;
    await client.query(
      `INSERT INTO validation_runs (id, project_id, repo_id, trigger, state)
       VALUES ($1,$2,$3,'manual','running') ON CONFLICT (id) DO NOTHING`,
      [runId, event.project_id, event.repo_id ?? ''],
    );
    const state = str(p['state']) || 'error';
    await client.query(
      `UPDATE validation_runs
          SET state = $2, finished_at = now(), input_hash = $3, cache_hit = $4,
              candidate_oid = COALESCE($5, candidate_oid), tree_oid = COALESCE($6, tree_oid),
              runner_device_id = COALESCE($7, runner_device_id),
              independence = COALESCE($8, independence)
        WHERE id = $1`,
      [
        runId,
        state,
        strOrNull(p['input_hash']),
        p['cache_hit'] === true,
        strOrNull(p['candidate_oid']),
        strOrNull(p['tree_oid']),
        strOrNull(p['runner_device_id']),
        strOrNull(p['independence']),
      ],
    );
    await recordAudit(clientExecutor(client), {
      projectId: event.project_id,
      actor: event.actor,
      action: 'validation.completed',
      subject: `validation:${runId}`,
    });
    this.logger?.debug({ runId, projectId: event.project_id, state }, 'validation run projected');
  }

  private async projectClaim(client: Client, event: EventEnvelope): Promise<void> {
    const taskId = event.task_id;
    if (!taskId) return;
    // completion_claims.task_id REFERENCES tasks(id): skip unknown tasks rather
    // than roll back the whole ingest batch (daemon-local ids may not be central).
    const exists = await client.query('SELECT 1 FROM tasks WHERE id = $1 AND project_id = $2', [
      taskId,
      event.project_id,
    ]);
    if (exists.rows.length === 0) {
      this.logger?.warn(
        { taskId, projectId: event.project_id, eventId: event.event_id },
        'completion claim for unknown task skipped',
      );
      return;
    }
    const id = ulid();
    await client.query(
      `INSERT INTO completion_claims (id, task_id, session_id, claim_text, evidence_state)
       VALUES ($1,$2,$3,$4,'unverified')`,
      [id, taskId, event.session_id ?? null, redact(str(event.payload['claim_text']))],
    );
    claimsProjected.inc();
    await recordAudit(clientExecutor(client), {
      projectId: event.project_id,
      actor: event.actor,
      action: 'task.completion_claimed',
      subject: `task:${taskId}`,
    });
  }

  // -------------------------------------------------------------------------
  // Queries (project-scoped reads)
  // -------------------------------------------------------------------------
  async getRun(runId: string, projectId: string): Promise<ValidationRunSnapshot | undefined> {
    const res = await this.pool.query(
      `SELECT ${RUN_COLS} FROM validation_runs WHERE id = $1 AND project_id = $2`,
      [runId, projectId],
    );
    const row = res.rows[0];
    if (!row) return undefined;
    return rowToRun(row, await this.checksFor(runId));
  }

  async listRuns(
    projectId: string,
    options: ValidationListOptions = {},
  ): Promise<ValidationRunSnapshot[]> {
    const params: unknown[] = [projectId];
    let where = 'project_id = $1';
    if (options.repoId) {
      params.push(options.repoId);
      where += ` AND repo_id = $${params.length}`;
    }
    if (options.taskId) {
      params.push(options.taskId);
      where += ` AND task_id = $${params.length}`;
    }
    if (options.state) {
      params.push(options.state);
      where += ` AND state = $${params.length}`;
    }
    if (options.until) {
      params.push(options.until);
      where += ` AND date_trunc('milliseconds', started_at) <= $${params.length}`;
    }
    params.push(options.limit ?? 200);
    const res = await this.pool.query(
      `SELECT ${RUN_COLS} FROM validation_runs WHERE ${where}
        ORDER BY started_at DESC LIMIT $${params.length}`,
      params,
    );
    if (res.rows.length === 0) return [];
    const ids = res.rows.map((r) => str(r.id));
    const checks = await this.pool.query(
      `SELECT validation_run_id, check_id, command_display, exit_code, duration_ms,
              log_digest, log_excerpt, selection, newly_failing
         FROM check_results WHERE validation_run_id = ANY($1::text[]) ORDER BY id ASC`,
      [ids],
    );
    const byRun = new Map<string, CheckEvidence[]>();
    for (const row of checks.rows) {
      const runId = str(row.validation_run_id);
      const arr = byRun.get(runId) ?? [];
      arr.push(rowToCheck(row));
      byRun.set(runId, arr);
    }
    return res.rows.map((r) => rowToRun(r, byRun.get(str(r.id)) ?? []));
  }

  async listClaims(taskId: string, projectId: string): Promise<CompletionClaimSnapshot[]> {
    const res = await this.pool.query(
      `SELECT c.id, c.task_id, c.session_id, c.claimed_at, c.claim_text, c.evidence_state
         FROM completion_claims c JOIN tasks t ON t.id = c.task_id
        WHERE c.task_id = $1 AND t.project_id = $2
        ORDER BY c.claimed_at DESC`,
      [taskId, projectId],
    );
    return res.rows.map(rowToClaim);
  }

  private async checksFor(runId: string): Promise<CheckEvidence[]> {
    const res = await this.pool.query(
      `SELECT check_id, command_display, exit_code, duration_ms, log_digest,
              log_excerpt, selection, newly_failing
         FROM check_results WHERE validation_run_id = $1 ORDER BY id ASC`,
      [runId],
    );
    return res.rows.map(rowToCheck);
  }
}
