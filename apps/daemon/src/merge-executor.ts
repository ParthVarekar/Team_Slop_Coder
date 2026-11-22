import {
  commitTree,
  fetch,
  mergeTreeWriteTree,
  metrics,
  pushWithPrecondition,
  revParse,
  type Logger,
} from '@weft/core';
import type { RepoRecord, RepoRegistry } from './repos.js';
import type { ValidationSupervisor } from './validation.js';

const mergesLanded = metrics.counter('weft_merge_executor_landed_total', 'Merges landed by the queue executor');
const mergesEjected = metrics.counter('weft_merge_executor_ejected_total', 'Queue entries ejected by the executor');
const pushStale = metrics.counter('weft_merge_executor_push_stale_total', 'CAS pushes rejected as stale');

/** Minimal lease view the executor needs (structurally matches the server lease). */
export interface ExecutorLeaseView {
  holder_device_id: string | null;
  lease_epoch: number;
  state: 'idle' | 'held';
}

export interface LeaseOutcome {
  status: 'acquired' | 'renewed' | 'denied';
  lease: ExecutorLeaseView;
  reason?: string;
}

/** Minimal entry view the executor drives (structurally matches the server entry). */
export interface MergeEntryView {
  id: string;
  repo_id: string;
  task_id: string;
  branch: string | null;
  candidate_oid: string | null;
  target_branch: string;
  claimant_device_id: string | null;
  speculative_tree_oid: string | null;
  base_oid: string | null;
  push_precondition_oid: string | null;
  state: string;
  lease_epoch: number;
}

export interface SpeculativeTreeView {
  speculative_tree_oid: string;
  base_oid: string;
  push_precondition_oid: string;
  candidate_oid?: string;
}

/**
 * The authoritative queue surface the executor round-trips to. In team mode this
 * is backed by CoordinationRpc → server CAS endpoints; the executor itself never
 * decides queue state, only performs git work and reports evidence.
 */
export interface MergeQueueClient {
  acquireLease(repoId: string, deviceId: string, ttlMs?: number): Promise<LeaseOutcome>;
  claimNext(repoId: string, deviceId: string, leaseEpoch: number): Promise<MergeEntryView | null>;
  recordSpeculativeTree(
    entryId: string,
    input: SpeculativeTreeView,
    deviceId: string,
    leaseEpoch: number,
  ): Promise<MergeEntryView>;
  attachValidation(entryId: string, validationRunId: string, deviceId: string, leaseEpoch: number): Promise<MergeEntryView>;
  advance(entryId: string, mergedOid: string, deviceId: string, leaseEpoch: number): Promise<MergeEntryView>;
  eject(entryId: string, reason: string, deviceId: string, leaseEpoch: number): Promise<MergeEntryView>;
}

export type MergeExecutorErrorCode = 'not_found' | 'git';

export class MergeExecutorError extends Error {
  constructor(
    readonly code: MergeExecutorErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'MergeExecutorError';
  }
}

export type MergeOutcome =
  | { status: 'not_executor' }
  | { status: 'idle' }
  | { status: 'merged'; entryId: string; mergedOid: string; treeOid: string }
  | { status: 'ejected'; entryId: string; reason: string };

export interface MergeExecutorOptions {
  deviceId: string;
  registry: RepoRegistry;
  client: MergeQueueClient;
  validation: ValidationSupervisor;
  binary?: string | undefined;
  logger?: Logger | undefined;
  leaseTtlMs?: number | undefined;
}

/**
 * Lease-elected merge-queue executor. One daemon per (project, repo) holds the
 * executor lease and drives the head entry through a fully in-memory git merge:
 *
 *   fetch → resolve target tip → merge-tree gate → commit-tree (dangling) →
 *   record speculative tree → INDEPENDENT validation of the exact tree →
 *   attach evidence → CAS push (--force-with-lease old-OID) → report advance.
 *
 * Nothing touches the user's HEAD, index, or working tree: merge-tree and
 * commit-tree are object-store only, validation runs in a detached worktree, and
 * the push lands only if origin still equals the recorded precondition. A stale
 * push (another writer advanced the target) ejects without overwriting; a failed
 * or self-only validation ejects so an unvalidated tree is never merged. The
 * server re-checks the independent-passing evidence gate on advance.
 */
export class MergeExecutor {
  constructor(private readonly options: MergeExecutorOptions) {}

  private get binary(): string | undefined {
    return this.options.binary;
  }

  /** Acquire the lease and process at most one head entry. */
  async tick(repoId: string): Promise<MergeOutcome> {
    const repo = this.options.registry.get(repoId);
    if (!repo) throw new MergeExecutorError('not_found', `unknown repo: ${repoId}`);
    const device = this.options.deviceId;
    const lease = await this.options.client.acquireLease(repoId, device, this.options.leaseTtlMs);
    if (lease.status === 'denied') return { status: 'not_executor' };
    const epoch = lease.lease.lease_epoch;
    const entry = await this.options.client.claimNext(repoId, device, epoch);
    if (!entry) return { status: 'idle' };
    return this.process(repo, entry, epoch);
  }

  private async process(repo: RepoRecord, entry: MergeEntryView, epoch: number): Promise<MergeOutcome> {
    const device = this.options.deviceId;
    await fetch(repo.root_path, { prune: true, binary: this.binary });

    const targetTip = await revParse(repo.root_path, `refs/remotes/origin/${entry.target_branch}`, this.binary);
    if (!targetTip) return this.eject(entry, epoch, 'target_branch_missing');

    const candidateTip = await this.resolveCandidate(repo, entry);
    if (!candidateTip) return this.eject(entry, epoch, 'candidate_unresolvable');

    const merge = await mergeTreeWriteTree(repo.root_path, targetTip, candidateTip, this.binary);
    if (!merge.clean)
      return this.eject(entry, epoch, `merge_conflict:${merge.conflictedPaths.join(',')}`);

    const mergeCommit = await commitTree(repo.root_path, merge.treeOid, {
      parents: [targetTip, candidateTip],
      message: `weft: merge ${entry.branch ?? entry.task_id} into ${entry.target_branch}`,
      binary: this.binary,
    });

    await this.options.client.recordSpeculativeTree(
      entry.id,
      {
        speculative_tree_oid: merge.treeOid,
        base_oid: targetTip,
        push_precondition_oid: targetTip,
        candidate_oid: candidateTip,
      },
      device,
      epoch,
    );

    const run = await this.options.validation.run(repo.repo_id, {
      candidate: mergeCommit,
      trigger: 'queue',
      taskId: entry.task_id,
      ...(entry.claimant_device_id ? { claimantDeviceId: entry.claimant_device_id } : {}),
    });
    if (run.state !== 'passed') return this.eject(entry, epoch, `validation_${run.state}`);
    if (run.independence !== 'independent')
      return this.eject(entry, epoch, 'independent_validation_required');

    await this.options.client.attachValidation(entry.id, run.run_id, device, epoch);

    const push = await pushWithPrecondition(repo.root_path, {
      source: mergeCommit,
      destination: entry.target_branch,
      expectedOldOid: targetTip,
      binary: this.binary,
    });
    if (!push.ok) {
      if (push.reason === 'stale') pushStale.inc();
      return this.eject(entry, epoch, `push_${push.reason ?? 'error'}`);
    }

    const mergedOid = push.newOid ?? mergeCommit;
    await this.options.client.advance(entry.id, mergedOid, device, epoch);
    mergesLanded.inc();
    this.options.logger?.info(
      { entryId: entry.id, repoId: repo.repo_id, mergedOid, treeOid: merge.treeOid },
      'merge queue entry landed',
    );
    return { status: 'merged', entryId: entry.id, mergedOid, treeOid: merge.treeOid };
  }

  /** Prefer the recorded candidate oid, then the remote branch, then a local branch. */
  private async resolveCandidate(repo: RepoRecord, entry: MergeEntryView): Promise<string | null> {
    if (entry.candidate_oid) {
      const oid = await revParse(repo.root_path, entry.candidate_oid, this.binary);
      if (oid) return oid;
    }
    if (entry.branch) {
      const remote = await revParse(repo.root_path, `refs/remotes/origin/${entry.branch}`, this.binary);
      if (remote) return remote;
      const local = await revParse(repo.root_path, `refs/heads/${entry.branch}`, this.binary);
      if (local) return local;
    }
    return null;
  }

  private async eject(entry: MergeEntryView, epoch: number, reason: string): Promise<MergeOutcome> {
    await this.options.client.eject(entry.id, reason, this.options.deviceId, epoch);
    mergesEjected.inc();
    this.options.logger?.warn({ entryId: entry.id, reason }, 'merge queue entry ejected');
    return { status: 'ejected', entryId: entry.id, reason };
  }
}