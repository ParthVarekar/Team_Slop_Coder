import {
  commitChangedPaths,
  logRange,
  metrics,
  rankSuspects,
  revertCommit,
  type FailingCheck,
  type Logger,
  type RankedSuspect,
  type SuspectChange,
} from '@weft/core';
import type { RepoRegistry } from './repos.js';
import type { ValidationSupervisor } from './validation.js';

const sweeps = metrics.counter('weft_attribution_sweeps_total', 'Attribution sweeps run');
const revertTests = metrics.counter('weft_attribution_revert_tests_total', 'Revert-tests run');
const confirmed = metrics.counter(
  'weft_attribution_confirmed_total',
  'Suspects confirmed by revert-test',
);

export type AttributionErrorCode = 'not_found' | 'git';

export class AttributionError extends Error {
  constructor(
    readonly code: AttributionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AttributionError';
  }
}

export interface AttributeInput {
  baselineOid: string;
  head?: string | undefined;
  failingChecks: FailingCheck[];
}

export type RevertTestResult =
  | { confirmed: true; revertOid: string; runId: string; revertedPaths: string[] }
  | {
      confirmed: false;
      reason: 'conflict' | 'error' | 'validation_failed';
      conflictedPaths?: string[];
      revertOid?: string;
      runId?: string;
      state?: string;
    };

export interface AttributionEngineOptions {
  registry: RepoRegistry;
  validation: ValidationSupervisor;
  /** Root under which isolated revert worktrees are created. */
  worktreeRoot: string;
  binary?: string | undefined;
  logger?: Logger | undefined;
}

/**
 * Daemon-side failure attribution. Enumerates the changes since the last healthy
 * baseline straight from git (logRange + per-commit changed paths), ranks them
 * with the pure core engine, and CONFIRMS a suspect by a real revert-test: revert
 * the culprit in an isolated worktree and re-run the project's checks on the
 * reverted tree. A suspect is only confirmed when the checks pass again — ranking
 * alone is a guess, the revert-test is evidence. The revert object is left
 * dangling for the queue to land; the user's HEAD/branch is never touched and
 * unrelated work is preserved.
 */
export class AttributionEngine {
  constructor(private readonly options: AttributionEngineOptions) {}

  async buildSuspects(
    repoId: string,
    baselineOid: string,
    head?: string,
  ): Promise<SuspectChange[]> {
    const repo = this.options.registry.get(repoId);
    if (!repo) throw new AttributionError('not_found', `repo ${repoId} not found`);
    const commits = await logRange(
      repo.root_path,
      baselineOid,
      head ?? 'HEAD',
      this.options.binary,
    );
    const suspects: SuspectChange[] = [];
    for (const commit of commits) {
      const paths = await commitChangedPaths(repo.root_path, commit.oid, this.options.binary);
      suspects.push({
        oid: commit.oid,
        subject: commit.subject,
        author_name: commit.author_name,
        authored_at: commit.authored_at,
        paths,
      });
    }
    return suspects;
  }

  async attribute(repoId: string, input: AttributeInput): Promise<RankedSuspect[]> {
    const changes = await this.buildSuspects(repoId, input.baselineOid, input.head);
    sweeps.inc();
    return rankSuspects({ changes, failingChecks: input.failingChecks });
  }

  /**
   * Revert-test a suspect: apply its inverse in an isolated worktree, then run the
   * configured checks on the reverted tree. Confirmed only if they pass. A revert
   * that conflicts with later work is reported, never forced.
   */
  async revertTest(repoId: string, suspectOid: string, head?: string): Promise<RevertTestResult> {
    const repo = this.options.registry.get(repoId);
    if (!repo) throw new AttributionError('not_found', `repo ${repoId} not found`);
    revertTests.inc();
    const revert = await revertCommit(repo.root_path, suspectOid, {
      worktreeRoot: this.options.worktreeRoot,
      ...(head ? { from: head } : {}),
      ...(this.options.binary ? { binary: this.options.binary } : {}),
    });
    if (!revert.ok) {
      this.options.logger?.warn(
        { repoId, suspectOid, reason: revert.reason },
        'revert-test could not apply cleanly',
      );
      return {
        confirmed: false,
        reason: revert.reason,
        conflictedPaths: revert.conflictedPaths,
      };
    }
    const run = await this.options.validation.run(repoId, {
      candidate: revert.revertOid,
      trigger: 'manual',
    });
    if (run.state !== 'passed') {
      return {
        confirmed: false,
        reason: 'validation_failed',
        revertOid: revert.revertOid,
        runId: run.run_id,
        state: run.state,
      };
    }
    confirmed.inc();
    return {
      confirmed: true,
      revertOid: revert.revertOid,
      runId: run.run_id,
      revertedPaths: revert.revertedPaths,
    };
  }
}
