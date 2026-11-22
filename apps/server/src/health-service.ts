import type { Client, Pool } from 'pg';
import { z } from 'zod';
import {
  failureFingerprint,
  metrics,
  rankSuspects,
  type FailingCheck,
  type Logger,
  type RankedSuspect,
  type SuspectChange,
} from '@weft/core';
import { makeId, type Actor } from '@weft/protocol';
import { withTransaction, clientExecutor } from './pg.js';
import { appendCoordinationEvent } from './emit.js';
import { recordAudit } from './audit.js';
import type { Origin } from './tasks-service.js';

const baselinesEstablished = metrics.counter(
  'weft_server_health_baselines_total',
  'Healthy baselines established',
);
const regressionsRecorded = metrics.counter(
  'weft_server_health_regressions_total',
  'Regressions recorded (newly-failing fingerprints)',
);
const regressionsConfirmed = metrics.counter(
  'weft_server_health_regressions_confirmed_total',
  'Regressions confirmed by revert-test',
);

function toIso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}
function toIsoOrNull(value: unknown): string | null {
  return value == null ? null : toIso(value);
}
function strOrNull(value: unknown): string | null {
  return value == null ? null : String(value);
}

export interface HealthBaseline {
  id: string;
  project_id: string;
  repo_id: string;
  branch: string;
  commit_oid: string;
  state: string;
  validation_run_id: string | null;
  check_results_summary: Record<string, unknown> | null;
  established_at: string;
}

export interface Regression {
  id: string;
  project_id: string;
  repo_id: string;
  baseline_id: string;
  failure_fingerprint: string;
  state: string;
  failing_checks: FailingCheck[] | null;
  suspected_changes: RankedSuspect[] | null;
  confirmed_change_id: string | null;
  revert_oid: string | null;
  first_seen: string;
  confirmed_at: string | null;
}

const BASELINE_COLS = `id, project_id, repo_id, branch, commit_oid, state, validation_run_id,
  check_results_summary, established_at`;
const REGRESSION_COLS = `id, project_id, repo_id, baseline_id, failure_fingerprint, state,
  failing_checks, suspected_changes, confirmed_change_id, revert_oid, first_seen, confirmed_at`;

function rowToBaseline(r: Record<string, unknown>): HealthBaseline {
  return {
    id: String(r.id),
    project_id: String(r.project_id),
    repo_id: String(r.repo_id),
    branch: String(r.branch),
    commit_oid: String(r.commit_oid),
    state: String(r.state),
    validation_run_id: strOrNull(r.validation_run_id),
    check_results_summary: (r.check_results_summary as Record<string, unknown> | null) ?? null,
    established_at: toIso(r.established_at),
  };
}

function rowToRegression(r: Record<string, unknown>): Regression {
  return {
    id: String(r.id),
    project_id: String(r.project_id),
    repo_id: String(r.repo_id),
    baseline_id: String(r.baseline_id),
    failure_fingerprint: String(r.failure_fingerprint),
    state: String(r.state),
    failing_checks: (r.failing_checks as FailingCheck[] | null) ?? null,
    suspected_changes: (r.suspected_changes as RankedSuspect[] | null) ?? null,
    confirmed_change_id: strOrNull(r.confirmed_change_id),
    revert_oid: strOrNull(r.revert_oid),
    first_seen: toIso(r.first_seen),
    confirmed_at: toIsoOrNull(r.confirmed_at),
  };
}

export type HealthErrorCode = 'not_found' | 'validation' | 'invalid_transition' | 'evidence_required';

export class HealthError extends Error {
  constructor(
    readonly code: HealthErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'HealthError';
  }
}

const FailingCheckSchema = z.object({
  check_id: z.string().min(1),
  paths: z.array(z.string()),
});
export const SuspectChangeSchema = z.object({
  oid: z.string().min(1),
  subject: z.string(),
  author_name: z.string(),
  authored_at: z.string(),
  paths: z.array(z.string()),
  task_id: z.string().optional(),
});

export const EstablishBaselineSchema = z.object({
  repo_id: z.string().min(1),
  branch: z.string().min(1),
  commit_oid: z.string().min(1),
  validation_run_id: z.string().min(1).optional(),
  check_results_summary: z.record(z.unknown()).optional(),
});
export type EstablishBaselineInput = z.input<typeof EstablishBaselineSchema>;

export const RecordRegressionSchema = z.object({
  repo_id: z.string().min(1),
  baseline_id: z.string().min(1),
  failing_checks: z.array(FailingCheckSchema).min(1),
  changes: z.array(SuspectChangeSchema).optional(),
});
export type RecordRegressionInput = z.input<typeof RecordRegressionSchema>;

export const ConfirmRegressionSchema = z.object({
  confirmed_change_id: z.string().min(1),
  revert_oid: z.string().min(1).optional(),
});
export type ConfirmRegressionInput = z.input<typeof ConfirmRegressionSchema>;

export interface HealthListOptions {
  repoId?: string;
  state?: string;
  limit?: number;
}

/**
 * Server-authoritative repo health. A baseline records the last known-healthy
 * commit (optionally proven by a passing validation run). When checks that passed
 * at the baseline now fail, a regression is recorded once per failure fingerprint
 * and the changes-since-healthy are ranked by failing-check path overlap (the pure
 * core engine). Ranking yields SUSPECTS; confirmation is a separate git-level
 * revert-test performed by a daemon, recorded here with the culprit + revert oid.
 * The server never executes git or checks itself — it materializes evidence and
 * coordinates. All mutations + their fan-out events commit atomically.
 */
export class HealthService {
  constructor(
    private readonly pool: Pool,
    private readonly serverDeviceId: string,
    private readonly logger?: Logger,
  ) {}

  async establishBaseline(
    projectId: string,
    input: EstablishBaselineInput,
    origin: Origin,
  ): Promise<HealthBaseline> {
    const parsed = EstablishBaselineSchema.safeParse(input);
    if (!parsed.success)
      throw new HealthError('validation', parsed.error.issues.map((i) => i.message).join('; '));
    const data = parsed.data;
    return withTransaction(this.pool, async (client) => {
      await this.requireProject(client, projectId);
      if (data.validation_run_id) {
        const run = await client.query(
          `SELECT 1 FROM validation_runs
            WHERE id=$1 AND project_id=$2 AND repo_id=$3 AND state='passed'`,
          [data.validation_run_id, projectId, data.repo_id],
        );
        if (run.rows.length === 0)
          throw new HealthError('evidence_required', 'baseline requires a passing validation run');
      }
      const baseline: HealthBaseline = {
        id: makeId('baseline'),
        project_id: projectId,
        repo_id: data.repo_id,
        branch: data.branch,
        commit_oid: data.commit_oid,
        state: 'healthy',
        validation_run_id: data.validation_run_id ?? null,
        check_results_summary: data.check_results_summary ?? null,
        established_at: new Date().toISOString(),
      };
      await client.query(
        `INSERT INTO health_baselines
           (id, project_id, repo_id, branch, commit_oid, state, validation_run_id, check_results_summary)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          baseline.id, projectId, baseline.repo_id, baseline.branch, baseline.commit_oid,
          baseline.state, baseline.validation_run_id,
          baseline.check_results_summary ? JSON.stringify(baseline.check_results_summary) : null,
        ],
      );
      await appendCoordinationEvent(client, {
        projectId,
        deviceId: this.serverDeviceId,
        type: 'health.baseline_established',
        actor: origin.actor,
        repoId: baseline.repo_id,
        payload: {
          branch: baseline.branch,
          commit_oid: baseline.commit_oid,
          ...(baseline.check_results_summary ? { checks_summary: baseline.check_results_summary } : {}),
        },
      });
      await this.audit(client, projectId, origin.actor, 'health.baseline_established', baseline.id);
      baselinesEstablished.inc();
      return baseline;
    });
  }

  async recordRegression(
    projectId: string,
    input: RecordRegressionInput,
    origin: Origin,
  ): Promise<Regression> {
    const parsed = RecordRegressionSchema.safeParse(input);
    if (!parsed.success)
      throw new HealthError('validation', parsed.error.issues.map((i) => i.message).join('; '));
    const data = parsed.data;
    const fingerprint = failureFingerprint(data.failing_checks.map((c) => c.check_id));
    const ranked = data.changes
      ? rankSuspects({ changes: data.changes, failingChecks: data.failing_checks })
      : null;
    return withTransaction(this.pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `${projectId}:health:${data.repo_id}`,
      ]);
      await this.requireProject(client, projectId);
      const baseline = await client.query(
        `SELECT 1 FROM health_baselines WHERE id=$1 AND project_id=$2 AND repo_id=$3`,
        [data.baseline_id, projectId, data.repo_id],
      );
      if (baseline.rows.length === 0)
        throw new HealthError('not_found', `baseline ${data.baseline_id} not found`);
      const existing = await client.query(
        `SELECT ${REGRESSION_COLS} FROM regressions
          WHERE project_id=$1 AND repo_id=$2 AND baseline_id=$3 AND failure_fingerprint=$4 AND state='open'`,
        [projectId, data.repo_id, data.baseline_id, fingerprint],
      );
      if (existing.rows[0]) return rowToRegression(existing.rows[0]);
      const regression: Regression = {
        id: makeId('regression'),
        project_id: projectId,
        repo_id: data.repo_id,
        baseline_id: data.baseline_id,
        failure_fingerprint: fingerprint,
        state: 'open',
        failing_checks: data.failing_checks,
        suspected_changes: ranked,
        confirmed_change_id: null,
        revert_oid: null,
        first_seen: new Date().toISOString(),
        confirmed_at: null,
      };
      await this.insertRegression(client, regression);
      await this.emitRegression(client, projectId, regression, origin.actor);
      await this.audit(client, projectId, origin.actor, 'health.regression', regression.id);
      regressionsRecorded.inc();
      return regression;
    });
  }

  /** Re-rank the changes-since-healthy for an open regression (pure core engine). */
  async attributeRegression(
    projectId: string,
    regressionId: string,
    changes: SuspectChange[],
    origin: Origin,
  ): Promise<RankedSuspect[]> {
    return withTransaction(this.pool, async (client) => {
      const regression = await this.lockRegression(client, projectId, regressionId);
      const ranked = rankSuspects({
        changes,
        failingChecks: regression.failing_checks ?? [],
      });
      await client.query(
        `UPDATE regressions SET suspected_changes=$3 WHERE project_id=$1 AND id=$2`,
        [projectId, regressionId, JSON.stringify(ranked)],
      );
      await this.emitRegression(
        client,
        projectId,
        { ...regression, suspected_changes: ranked },
        origin.actor,
      );
      await this.audit(client, projectId, origin.actor, 'health.regression_attributed', regressionId);
      return ranked;
    });
  }

  /**
   * Record a confirmed culprit (proven by a daemon revert-test) and the revert oid.
   * Confirmation is evidence, not a guess: the caller supplies the change whose
   * revert made the failing checks pass again.
   */
  async confirmRegression(
    projectId: string,
    regressionId: string,
    input: ConfirmRegressionInput,
    origin: Origin,
  ): Promise<Regression> {
    const parsed = ConfirmRegressionSchema.safeParse(input);
    if (!parsed.success)
      throw new HealthError('validation', parsed.error.issues.map((i) => i.message).join('; '));
    const data = parsed.data;
    return withTransaction(this.pool, async (client) => {
      const regression = await this.lockRegression(client, projectId, regressionId);
      if (regression.state !== 'open')
        throw new HealthError('invalid_transition', `regression is ${regression.state}, not open`);
      const next: Regression = {
        ...regression,
        state: 'confirmed',
        confirmed_change_id: data.confirmed_change_id,
        revert_oid: data.revert_oid ?? null,
        confirmed_at: new Date().toISOString(),
      };
      await client.query(
        `UPDATE regressions
            SET state='confirmed', confirmed_change_id=$3, revert_oid=$4, confirmed_at=now()
          WHERE project_id=$1 AND id=$2`,
        [projectId, regressionId, next.confirmed_change_id, next.revert_oid],
      );
      await this.emitRegression(client, projectId, next, origin.actor);
      await this.audit(client, projectId, origin.actor, 'health.regression_confirmed', regressionId);
      regressionsConfirmed.inc();
      this.logger?.debug(
        { projectId, regressionId, culprit: next.confirmed_change_id },
        'regression confirmed',
      );
      return next;
    });
  }

  async getBaseline(projectId: string, baselineId: string): Promise<HealthBaseline | undefined> {
    const res = await this.pool.query(
      `SELECT ${BASELINE_COLS} FROM health_baselines WHERE project_id=$1 AND id=$2`,
      [projectId, baselineId],
    );
    return res.rows[0] ? rowToBaseline(res.rows[0]) : undefined;
  }

  async latestBaseline(projectId: string, repoId: string, branch: string): Promise<HealthBaseline | undefined> {
    const res = await this.pool.query(
      `SELECT ${BASELINE_COLS} FROM health_baselines
        WHERE project_id=$1 AND repo_id=$2 AND branch=$3 AND state='healthy'
        ORDER BY established_at DESC LIMIT 1`,
      [projectId, repoId, branch],
    );
    return res.rows[0] ? rowToBaseline(res.rows[0]) : undefined;
  }

  async getRegression(projectId: string, regressionId: string): Promise<Regression | undefined> {
    const res = await this.pool.query(
      `SELECT ${REGRESSION_COLS} FROM regressions WHERE project_id=$1 AND id=$2`,
      [projectId, regressionId],
    );
    return res.rows[0] ? rowToRegression(res.rows[0]) : undefined;
  }

  async listBaselines(projectId: string, options: HealthListOptions = {}): Promise<HealthBaseline[]> {
    const params: unknown[] = [projectId];
    let where = 'project_id=$1';
    if (options.repoId) {
      params.push(options.repoId);
      where += ` AND repo_id=$${params.length}`;
    }
    params.push(options.limit ?? 100);
    const res = await this.pool.query(
      `SELECT ${BASELINE_COLS} FROM health_baselines WHERE ${where}
        ORDER BY established_at DESC LIMIT $${params.length}`,
      params,
    );
    return res.rows.map(rowToBaseline);
  }

  async listRegressions(projectId: string, options: HealthListOptions = {}): Promise<Regression[]> {
    const params: unknown[] = [projectId];
    let where = 'project_id=$1';
    if (options.repoId) {
      params.push(options.repoId);
      where += ` AND repo_id=$${params.length}`;
    }
    if (options.state) {
      params.push(options.state);
      where += ` AND state=$${params.length}`;
    }
    params.push(options.limit ?? 100);
    const res = await this.pool.query(
      `SELECT ${REGRESSION_COLS} FROM regressions WHERE ${where}
        ORDER BY first_seen DESC LIMIT $${params.length}`,
      params,
    );
    return res.rows.map(rowToRegression);
  }

  // -------------------------------------------------------------------------
  private async requireProject(client: Client, projectId: string): Promise<void> {
    const res = await client.query('SELECT 1 FROM projects WHERE id=$1', [projectId]);
    if (res.rows.length === 0) throw new HealthError('not_found', `project ${projectId} not found`);
  }

  private async lockRegression(client: Client, projectId: string, regressionId: string): Promise<Regression> {
    const res = await client.query(
      `SELECT ${REGRESSION_COLS} FROM regressions WHERE project_id=$1 AND id=$2 FOR UPDATE`,
      [projectId, regressionId],
    );
    const row = res.rows[0];
    if (!row) throw new HealthError('not_found', `regression ${regressionId} not found`);
    return rowToRegression(row);
  }

  private async insertRegression(client: Client, r: Regression): Promise<void> {
    await client.query(
      `INSERT INTO regressions
         (id, project_id, repo_id, baseline_id, failure_fingerprint, state,
          failing_checks, suspected_changes, confirmed_change_id, revert_oid)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        r.id, r.project_id, r.repo_id, r.baseline_id, r.failure_fingerprint, r.state,
        r.failing_checks ? JSON.stringify(r.failing_checks) : null,
        r.suspected_changes ? JSON.stringify(r.suspected_changes) : null,
        r.confirmed_change_id, r.revert_oid,
      ],
    );
  }

  private async emitRegression(client: Client, projectId: string, r: Regression, actor: Actor): Promise<void> {
    await appendCoordinationEvent(client, {
      projectId,
      deviceId: this.serverDeviceId,
      type: 'health.regression',
      actor,
      repoId: r.repo_id,
      payload: {
        baseline_id: r.baseline_id,
        failure_fingerprint: r.failure_fingerprint,
        suspected_changes: (r.suspected_changes ?? []) as unknown as Record<string, unknown>[],
        state: r.state,
        ...(r.confirmed_change_id ? { confirmed_change_id: r.confirmed_change_id } : {}),
        ...(r.revert_oid ? { revert_oid: r.revert_oid } : {}),
      },
    });
  }

  private async audit(client: Client, projectId: string, actor: Actor, action: string, subjectId: string): Promise<void> {
    await recordAudit(clientExecutor(client), {
      projectId,
      actor,
      action,
      subject: `health:${subjectId}`,
    });
  }
}