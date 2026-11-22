import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { cpus } from 'node:os';
import { dirname, join } from 'node:path';
import {
  metrics,
  redact,
  revParse,
  runCheck,
  scrubEnv,
  treeOid,
  worktreeAddDetached,
  worktreePrune,
  worktreeRemove,
  worktreeUnlock,
  type Logger,
  type SqliteDatabase,
  type ValidationConfig,
} from '@weft/core';
import { makeId, type Actor } from '@weft/protocol';
import type { EventDraft } from './events.js';
import type { EnqueueResult } from './pipeline.js';
import type { RepoRecord, RepoRegistry } from './repos.js';

const runsStarted = metrics.counter('weft_validation_runs_total', 'Validation runs started');
const runsPassed = metrics.counter('weft_validation_runs_passed_total', 'Validation runs passed');
const runsFailed = metrics.counter('weft_validation_runs_failed_total', 'Validation runs failed');
const runsErrored = metrics.counter('weft_validation_runs_error_total', 'Validation runs errored');
const activeGauge = metrics.gauge('weft_validation_active', 'Validation runs currently executing');

export type ValidationTrigger = 'task' | 'queue' | 'manual' | 'baseline';
export type ValidationSelection = 'full' | 'affected';
export type ValidationRunState = 'running' | 'passed' | 'failed' | 'error';
export type Independence = 'self' | 'independent';

export interface RunValidationInput {
  taskId?: string | undefined;
  /** Commit/ref to validate (default HEAD). Checked out detached — never a branch. */
  candidate?: string | undefined;
  trigger?: ValidationTrigger | undefined;
  selection?: ValidationSelection | undefined;
  /**
   * Device that authored/claimed the work being validated. When it differs from
   * this runner the run is labeled independence='independent' — the merge queue
   * only lands a tree validated on a device other than the claimant's.
   */
  claimantDeviceId?: string | undefined;
}

export interface CheckEvidence {
  check_id: string;
  command_display: string;
  exit_code: number | null;
  duration_ms: number;
  log_digest: string;
  log_excerpt: string;
  selection: ValidationSelection;
  timed_out: boolean;
  truncated: boolean;
}

export interface ValidationRunRecord {
  run_id: string;
  repo_id: string;
  task_id: string | null;
  trigger: ValidationTrigger;
  candidate_oid: string | null;
  tree_oid: string | null;
  runner_device_id: string;
  claimant_device_id: string | null;
  state: ValidationRunState;
  started_at: string;
  finished_at: string | null;
  input_hash: string | null;
  independence: Independence;
  checks: CheckEvidence[];
}

export type ValidationRunErrorCode = 'not_found' | 'not_configured' | 'invalid_candidate';

export class ValidationRunError extends Error {
  constructor(
    readonly code: ValidationRunErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ValidationRunError';
  }
}

export interface ValidationSupervisorOptions {
  deviceId: string;
  projectId: string;
  /** Root under which per-run detached validation worktrees are created. */
  worktreeRoot: string;
  registry: RepoRegistry;
  actor: Actor;
  validation: ValidationConfig;
  emit: (draft: EventDraft) => EnqueueResult;
  binary?: string | undefined;
  logger?: Logger | undefined;
}

interface RunRow {
  run_id: string;
  repo_id: string;
  task_id: string | null;
  trigger: string;
  candidate_oid: string | null;
  tree_oid: string | null;
  runner_device_id: string | null;
  claimant_device_id: string | null;
  state: string;
  started_at: string;
  finished_at: string | null;
  input_hash: string | null;
  independence: string;
}

interface CheckRow {
  validation_run_id: string;
  check_id: string;
  command_display: string | null;
  exit_code: number | null;
  duration_ms: number | null;
  log_digest: string | null;
  log_excerpt: string | null;
  selection: string | null;
}

/** Counting semaphore; a released slot is transferred directly to the next waiter. */
class Semaphore {
  private active = 0;
  private readonly queue: (() => void)[] = [];

  constructor(private readonly limit: number) {}

  async acquire(): Promise<() => void> {
    if (this.active < this.limit) {
      this.active++;
      return () => this.release();
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
    return () => this.release();
  }

  private release(): void {
    const next = this.queue.shift();
    if (next) next();
    else this.active--;
  }
}

function tail(text: string, n: number): string {
  return text.length <= n ? text : text.slice(text.length - n);
}

function toCheck(row: CheckRow): CheckEvidence {
  return {
    check_id: row.check_id,
    command_display: row.command_display ?? '',
    exit_code: row.exit_code,
    duration_ms: row.duration_ms ?? 0,
    log_digest: row.log_digest ?? '',
    log_excerpt: row.log_excerpt ?? '',
    selection: (row.selection ?? 'full') as ValidationSelection,
    timed_out: row.exit_code === null,
    truncated: false,
  };
}

/**
 * Runs project-configured checks (typecheck/lint/unit/build) as child processes
 * inside a dedicated detached worktree at the candidate tree — never the user's
 * working tree or branch. Concurrency is bounded (cores-1 by default); each check
 * has a timeout, a scrubbed environment, and capped+redacted output. Evidence
 * (exit code, duration, log digest, redacted excerpt) is persisted to check_results
 * and a validation_runs row, and emitted as validation.* coordination events.
 *
 * The supervisor NEVER completes a task: it only produces evidence. Completion is
 * a separate, guarded transition (see LocalTaskStore) so an unverified claim can
 * never silently become COMPLETED. Solo runs are labeled independence='self'.
 */
export class ValidationSupervisor {
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly semaphore: Semaphore;

  constructor(
    private readonly db: SqliteDatabase,
    private readonly options: ValidationSupervisorOptions,
  ) {
    const limit = options.validation.concurrency ?? Math.max(1, cpus().length - 1);
    this.semaphore = new Semaphore(limit);
  }

  private get binary(): string | undefined {
    return this.options.binary;
  }

  async run(repoId: string, input: RunValidationInput = {}): Promise<ValidationRunRecord> {
    const repo = this.options.registry.get(repoId);
    if (!repo) throw new ValidationRunError('not_found', `unknown repo: ${repoId}`);
    const checks = this.options.validation.checks;
    if (checks.length === 0)
      throw new ValidationRunError('not_configured', 'no validation checks configured for this project');
    const candidateRef = input.candidate ?? 'HEAD';
    const candidateOid = await revParse(repo.root_path, candidateRef, this.binary);
    if (!candidateOid)
      throw new ValidationRunError('invalid_candidate', `candidate not resolvable: ${candidateRef}`);

    const release = await this.semaphore.acquire();
    activeGauge.add(1);
    try {
      return await this.runOnce(
        repo,
        candidateOid,
        input.trigger ?? 'manual',
        input.selection ?? 'full',
        input.taskId,
        input.claimantDeviceId,
      );
    } finally {
      activeGauge.add(-1);
      release();
    }
  }

  private async runOnce(
    repo: RepoRecord,
    candidateOid: string,
    trigger: ValidationTrigger,
    selection: ValidationSelection,
    taskId?: string,
    claimantDeviceId?: string,
  ): Promise<ValidationRunRecord> {
    const checks = this.options.validation.checks;
    const runId = makeId('validation');
    const tree = await treeOid(repo.root_path, candidateOid, this.binary);
    const startedAt = new Date().toISOString();
    const runnerDevice = this.options.deviceId;
    const claimantDevice = claimantDeviceId ?? runnerDevice;
    const independence: Independence = claimantDevice !== runnerDevice ? 'independent' : 'self';
    const inputHash = createHash('sha256')
      .update(
        JSON.stringify({
          tree,
          checks: checks.map((c) => ({ command: c.command, args: c.args, selection: c.selection })),
        }),
      )
      .digest('hex');

    this.db
      .prepare(
        `INSERT INTO validation_runs
           (run_id, repo_id, task_id, trigger, candidate_oid, tree_oid, runner_device_id,
            claimant_device_id, state, started_at, input_hash, independence)
         VALUES
           (@run_id, @repo_id, @task_id, @trigger, @candidate_oid, @tree_oid, @runner_device_id,
            @claimant_device_id, 'running', @started_at, @input_hash, @independence)`,
      )
      .run({
        run_id: runId,
        repo_id: repo.repo_id,
        task_id: taskId ?? null,
        trigger,
        candidate_oid: candidateOid,
        tree_oid: tree,
        runner_device_id: runnerDevice,
        claimant_device_id: claimantDevice,
        started_at: startedAt,
        input_hash: inputHash,
        independence,
      });
    runsStarted.inc();

    const path = join(this.options.worktreeRoot, 'validation', runId);
    mkdirSync(dirname(path), { recursive: true });
    await this.serialize(repo.repo_id, () =>
      worktreeAddDetached(repo.root_path, path, candidateOid, {
        lock: true,
        lockReason: `weft:validation:${runId}`,
        binary: this.binary,
      }),
    );

    this.emit(repo, runId, taskId, 'validation.started', {
      run_id: runId,
      trigger,
      candidate_oid: candidateOid,
      checks: checks.map((c) => c.check_id),
      selection,
      tree_oid: tree,
      runner_device_id: runnerDevice,
      claimant_device_id: claimantDevice,
      independence,
    });

    const evidence: CheckEvidence[] = [];
    let anyError = false;
    let anyFailed = false;
    try {
      const env = scrubEnv();
      for (const check of checks) {
        const result = await runCheck({
          cwd: path,
          command: check.command,
          args: check.args,
          env,
          timeoutMs: check.timeoutMs ?? this.options.validation.timeoutMs,
          outputCapBytes: this.options.validation.outputCapBytes,
        });
        const durationMs = Math.round(result.durationMs);
        const commandDisplay = redact([check.command, ...check.args].join(' '));
        const excerpt = redact(tail(result.output, this.options.validation.excerptBytes));
        // A timed-out check has no meaningful exit code (Windows taskkill reports
        // 1); normalize to null so persisted evidence reads back timed_out=true.
        const exitCode = result.timedOut ? null : result.exitCode;
        const errored = exitCode === null || result.spawnError !== null;
        if (errored) anyError = true;
        else if (exitCode !== 0) anyFailed = true;

        const ev: CheckEvidence = {
          check_id: check.check_id,
          command_display: commandDisplay,
          exit_code: exitCode,
          duration_ms: durationMs,
          log_digest: result.outputDigest,
          log_excerpt: excerpt,
          selection: check.selection,
          timed_out: result.timedOut,
          truncated: result.truncated,
        };
        evidence.push(ev);
        this.db
          .prepare(
            `INSERT INTO check_results
               (validation_run_id, check_id, command_display, exit_code, duration_ms,
                log_digest, log_excerpt, selection, newly_failing)
             VALUES
               (@run_id, @check_id, @command_display, @exit_code, @duration_ms,
                @log_digest, @log_excerpt, @selection, 0)`,
          )
          .run({
            run_id: runId,
            check_id: check.check_id,
            command_display: commandDisplay,
            exit_code: exitCode,
            duration_ms: durationMs,
            log_digest: result.outputDigest,
            log_excerpt: excerpt,
            selection: check.selection,
          });
        this.emit(repo, runId, taskId, 'check.completed', {
          run_id: runId,
          check_id: check.check_id,
          exit_code: exitCode ?? -1,
          duration_ms: durationMs,
          log_digest: result.outputDigest,
          command_display: commandDisplay,
          log_excerpt: excerpt,
          selection: check.selection,
          timed_out: result.timedOut,
          truncated: result.truncated,
        });
      }
    } finally {
      await this.cleanup(repo, path);
    }

    const state: ValidationRunState = anyError ? 'error' : anyFailed ? 'failed' : 'passed';
    const finishedAt = new Date().toISOString();
    this.db
      .prepare('UPDATE validation_runs SET state = ?, finished_at = ? WHERE run_id = ?')
      .run(state, finishedAt, runId);
    if (state === 'passed') runsPassed.inc();
    else if (state === 'failed') runsFailed.inc();
    else runsErrored.inc();

    this.emit(repo, runId, taskId, 'validation.completed', {
      run_id: runId,
      state,
      candidate_oid: candidateOid,
      input_hash: inputHash,
      cache_hit: false,
      checks: evidence.map((e) => ({
        check_id: e.check_id,
        exit_code: e.exit_code ?? -1,
        duration_ms: e.duration_ms,
        selection: e.selection,
      })),
      tree_oid: tree,
      runner_device_id: runnerDevice,
      independence,
    });
    this.options.logger?.info(
      { runId, repoId: repo.repo_id, taskId, state, checks: evidence.length },
      'validation run finished',
    );

    return {
      run_id: runId,
      repo_id: repo.repo_id,
      task_id: taskId ?? null,
      trigger,
      candidate_oid: candidateOid,
      tree_oid: tree,
      runner_device_id: runnerDevice,
      claimant_device_id: claimantDevice,
      state,
      started_at: startedAt,
      finished_at: finishedAt,
      input_hash: inputHash,
      independence,
      checks: evidence,
    };
  }

  getRun(runId: string): ValidationRunRecord | undefined {
    const row = this.db.prepare('SELECT * FROM validation_runs WHERE run_id = ?').get(runId) as
      | RunRow
      | undefined;
    if (!row) return undefined;
    const checks = this.db
      .prepare('SELECT * FROM check_results WHERE validation_run_id = ? ORDER BY id ASC')
      .all(runId) as CheckRow[];
    return this.toRecord(row, checks.map(toCheck));
  }

  listRuns(opts: { repoId?: string; taskId?: string; limit?: number } = {}): ValidationRunRecord[] {
    const clauses: string[] = ['runner_device_id = @device'];
    const params: Record<string, unknown> = { device: this.options.deviceId, limit: opts.limit ?? 200 };
    if (opts.repoId) {
      clauses.push('repo_id = @repo');
      params.repo = opts.repoId;
    }
    if (opts.taskId) {
      clauses.push('task_id = @task');
      params.task = opts.taskId;
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM validation_runs WHERE ${clauses.join(' AND ')}
         ORDER BY started_at DESC LIMIT @limit`,
      )
      .all(params) as RunRow[];
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.run_id);
    const placeholders = ids.map(() => '?').join(',');
    const checks = this.db
      .prepare(
        `SELECT * FROM check_results WHERE validation_run_id IN (${placeholders}) ORDER BY id ASC`,
      )
      .all(...ids) as CheckRow[];
    const byRun = new Map<string, CheckEvidence[]>();
    for (const c of checks) {
      const arr = byRun.get(c.validation_run_id) ?? [];
      arr.push(toCheck(c));
      byRun.set(c.validation_run_id, arr);
    }
    return rows.map((r) => this.toRecord(r, byRun.get(r.run_id) ?? []));
  }

  private toRecord(row: RunRow, checks: CheckEvidence[]): ValidationRunRecord {
    return {
      run_id: row.run_id,
      repo_id: row.repo_id,
      task_id: row.task_id,
      trigger: row.trigger as ValidationTrigger,
      candidate_oid: row.candidate_oid,
      tree_oid: row.tree_oid,
      runner_device_id: row.runner_device_id ?? this.options.deviceId,
      claimant_device_id: row.claimant_device_id,
      state: row.state as ValidationRunState,
      started_at: row.started_at,
      finished_at: row.finished_at,
      input_hash: row.input_hash,
      independence: row.independence as Independence,
      checks,
    };
  }

  private async cleanup(repo: RepoRecord, path: string): Promise<void> {
    await this.serialize(repo.repo_id, async () => {
      if (existsSync(path)) {
        try {
          await worktreeUnlock(repo.root_path, path, this.binary);
        } catch {
          /* already unlocked */
        }
        try {
          await worktreeRemove(repo.root_path, path, { force: true, binary: this.binary });
        } catch {
          /* best-effort; prune below sweeps the admin entry */
        }
      }
      try {
        await worktreePrune(repo.root_path, this.binary);
      } catch {
        /* nothing to prune */
      }
    });
  }

  private serialize<T>(repoId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(repoId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.chains.set(
      repoId,
      next.catch(() => undefined),
    );
    return next;
  }

  private emit(
    repo: RepoRecord,
    runId: string,
    taskId: string | undefined,
    type: string,
    payload: Record<string, unknown>,
  ): void {
    this.options.emit({
      type,
      actor: this.options.actor,
      repoId: repo.repo_id,
      ...(taskId ? { taskId } : {}),
      privacy: 'metadata',
      payload: { run_id: runId, ...payload },
    });
  }
}