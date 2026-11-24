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
import type { ValidationCache } from './validation-cache.js';

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
  cache_hit: boolean;
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
  /** Optional result cache; when absent every run executes fresh. */
  cache?: ValidationCache | undefined;
  /** Toolchain identity for cache keying; defaults to node version + check commands. */
  toolchainFingerprint?: string | undefined;
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
  cache_hit: number;
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

interface RunContext {
  repo: RepoRecord;
  runId: string;
  candidateOid: string;
  tree: string | null;
  taskId: string | undefined;
  trigger: ValidationTrigger;
  startedAt: string;
  runnerDevice: string;
  claimantDevice: string;
  independence: Independence;
  inputHash: string;
}

/** Default toolchain identity: node version + the exact check commands. */
function defaultFingerprint(checks: ValidationConfig['checks']): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        node: process.version,
        commands: checks.map((c) => [c.command, ...c.args]),
      }),
    )
    .digest('hex')
    .slice(0, 32);
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
      throw new ValidationRunError(
        'not_configured',
        'no validation checks configured for this project',
      );
    const candidateRef = input.candidate ?? 'HEAD';
    const candidateOid = await revParse(repo.root_path, candidateRef, this.binary);
    if (!candidateOid)
      throw new ValidationRunError(
        'invalid_candidate',
        `candidate not resolvable: ${candidateRef}`,
      );

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
    const fingerprint = this.options.toolchainFingerprint ?? defaultFingerprint(checks);

    this.db
      .prepare(
        `INSERT INTO validation_runs
           (run_id, repo_id, task_id, trigger, candidate_oid, tree_oid, runner_device_id,
            claimant_device_id, state, started_at, input_hash, toolchain_fingerprint, independence)
         VALUES
           (@run_id, @repo_id, @task_id, @trigger, @candidate_oid, @tree_oid, @runner_device_id,
            @claimant_device_id, 'running', @started_at, @input_hash, @fingerprint, @independence)`,
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
        fingerprint,
        independence,
      });
    runsStarted.inc();

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

    // Cache hit: reuse the prior passing evidence without re-executing any check.
    // Queue-trigger runs always execute fresh (independence requires real work).
    const cache = this.options.cache;
    const cached =
      cache && trigger !== 'queue'
        ? cache.get({ inputHash, toolchainFingerprint: fingerprint })
        : null;
    if (cached) {
      for (const ev of cached.checks) this.persistCheck(repo, runId, taskId, ev);
      return this.finishRun(
        {
          repo,
          runId,
          candidateOid,
          tree,
          taskId,
          trigger,
          startedAt,
          runnerDevice,
          claimantDevice,
          independence,
          inputHash,
        },
        'passed',
        cached.checks,
        true,
        cached.expires_at,
      );
    }

    const path = join(this.options.worktreeRoot, 'validation', runId);
    mkdirSync(dirname(path), { recursive: true });
    await this.serialize(repo.repo_id, () =>
      worktreeAddDetached(repo.root_path, path, candidateOid, {
        lock: true,
        lockReason: `weft:validation:${runId}`,
        binary: this.binary,
      }),
    );

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
        this.persistCheck(repo, runId, taskId, ev);
      }
    } finally {
      await this.cleanup(repo, path);
    }

    const state: ValidationRunState = anyError ? 'error' : anyFailed ? 'failed' : 'passed';
    if (cache) {
      if (state === 'passed' && tree) {
        cache.put({
          inputHash,
          toolchainFingerprint: fingerprint,
          repoId: repo.repo_id,
          treeOid: tree,
          state,
          checks: evidence,
        });
      } else if (state !== 'passed') {
        // A failure on an identical input distrusts any cached pass (flake quarantine).
        cache.quarantine({ inputHash, toolchainFingerprint: fingerprint });
      }
    }
    return this.finishRun(
      {
        repo,
        runId,
        candidateOid,
        tree,
        taskId,
        trigger,
        startedAt,
        runnerDevice,
        claimantDevice,
        independence,
        inputHash,
      },
      state,
      evidence,
      false,
      null,
    );
  }

  private persistCheck(
    repo: RepoRecord,
    runId: string,
    taskId: string | undefined,
    ev: CheckEvidence,
  ): void {
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
        check_id: ev.check_id,
        command_display: ev.command_display,
        exit_code: ev.exit_code,
        duration_ms: ev.duration_ms,
        log_digest: ev.log_digest,
        log_excerpt: ev.log_excerpt,
        selection: ev.selection,
      });
    this.emit(repo, runId, taskId, 'check.completed', {
      run_id: runId,
      check_id: ev.check_id,
      exit_code: ev.exit_code ?? -1,
      duration_ms: ev.duration_ms,
      log_digest: ev.log_digest,
      command_display: ev.command_display,
      log_excerpt: ev.log_excerpt,
      selection: ev.selection,
      timed_out: ev.timed_out,
      truncated: ev.truncated,
    });
  }

  private finishRun(
    ctx: RunContext,
    state: ValidationRunState,
    evidence: CheckEvidence[],
    cacheHit: boolean,
    cacheExpiresAt: string | null,
  ): ValidationRunRecord {
    const {
      repo,
      runId,
      candidateOid,
      tree,
      taskId,
      trigger,
      startedAt,
      runnerDevice,
      claimantDevice,
      independence,
      inputHash,
    } = ctx;
    const finishedAt = new Date().toISOString();
    this.db
      .prepare(
        'UPDATE validation_runs SET state = ?, finished_at = ?, cache_hit = ?, cache_expires_at = ? WHERE run_id = ?',
      )
      .run(state, finishedAt, cacheHit ? 1 : 0, cacheExpiresAt, runId);
    if (state === 'passed') runsPassed.inc();
    else if (state === 'failed') runsFailed.inc();
    else runsErrored.inc();

    this.emit(repo, runId, taskId, 'validation.completed', {
      run_id: runId,
      state,
      candidate_oid: candidateOid,
      input_hash: inputHash,
      cache_hit: cacheHit,
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
      { runId, repoId: repo.repo_id, taskId, state, cacheHit, checks: evidence.length },
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
      cache_hit: cacheHit,
      checks: evidence,
    };
  }

  getRun(runId: string): ValidationRunRecord | undefined {
    const row = this.db.prepare('SELECT * FROM validation_runs WHERE run_id = ?').get(runId) as
      RunRow | undefined;
    if (!row) return undefined;
    const checks = this.db
      .prepare('SELECT * FROM check_results WHERE validation_run_id = ? ORDER BY id ASC')
      .all(runId) as CheckRow[];
    return this.toRecord(row, checks.map(toCheck));
  }

  listRuns(
    opts: { repoId?: string; taskId?: string; until?: string; limit?: number } = {},
  ): ValidationRunRecord[] {
    const clauses: string[] = ['runner_device_id = @device'];
    const params: Record<string, unknown> = {
      device: this.options.deviceId,
      limit: opts.limit ?? 200,
    };
    if (opts.repoId) {
      clauses.push('repo_id = @repo');
      params.repo = opts.repoId;
    }
    if (opts.taskId) {
      clauses.push('task_id = @task');
      params.task = opts.taskId;
    }
    if (opts.until) {
      clauses.push('julianday(started_at) <= julianday(@until)');
      params.until = opts.until;
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM validation_runs WHERE ${clauses.join(' AND ')}
         ORDER BY julianday(started_at) DESC, run_id DESC LIMIT @limit`,
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
      cache_hit: row.cache_hit !== 0,
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
