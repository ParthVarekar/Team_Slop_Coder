import { diffNameOnly, mergeTreeWriteTree, metrics, revParse, type Logger } from '@weft/core';
import {
  canonicalConflictKey,
  normalizeConflictPath,
  type Actor,
  type ConflictKind,
  type ConflictSeverity,
} from '@weft/protocol';
import type { EventDraft } from './events.js';
import type { EnqueueResult } from './pipeline.js';
import type { RepoRecord, RepoRegistry } from './repos.js';

const textualTotal = metrics.counter(
  'weft_conflicts_textual_total',
  'Textual merge-tree conflicts detected',
);
const overlapTotal = metrics.counter(
  'weft_conflicts_overlap_total',
  'Pairwise file overlaps detected',
);

export interface TaskBranch {
  taskId: string;
  branch: string;
}

export interface DetectOptions {
  /** Integration base ref (default: the repo's default branch, else HEAD). */
  baseRef?: string | undefined;
  /** Monotonic detection epoch; a later epoch reopens resolved cards server-side. */
  epoch?: number | undefined;
}

export interface GateResult {
  task_id: string;
  branch: string;
  clean: boolean;
  tree_oid: string | null;
  conflicted_paths: string[];
  error: string | null;
}

export interface DetectedConflict {
  canonical_key: string;
  kind: ConflictKind;
  severity: ConflictSeverity;
  task_ids: string[];
  paths: string[];
  branch_a: string | null;
  branch_b: string | null;
}

export interface DetectionResult {
  repo_id: string;
  base_ref: string;
  base_oid: string | null;
  epoch: number;
  gate: GateResult[];
  conflicts: DetectedConflict[];
}

export type ConflictDetectorErrorCode = 'not_found';

export class ConflictDetectorError extends Error {
  constructor(
    readonly code: ConflictDetectorErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ConflictDetectorError';
  }
}

export interface ConflictDetectorOptions {
  deviceId: string;
  projectId: string;
  registry: RepoRegistry;
  emit: (draft: EventDraft) => EnqueueResult;
  actor: Actor;
  binary?: string | undefined;
  logger?: Logger | undefined;
}

/**
 * Local conflict detection (L0). Two complementary signals, both read-only:
 *  - textual gate: `git merge-tree --write-tree` of each task branch against the
 *    integration base, entirely in memory (blocking when it cannot auto-merge);
 *  - file overlap: pairwise intersection of the branches' change sets against the
 *    base (an early warning that two developers are editing the same files).
 * Each finding is emitted as a conflict.detected event carrying a canonical key
 * (kind + sorted tasks + normalized paths). The server is authoritative: it mints
 * one card per key and unions evidence across devices, so duplicate detections
 * from multiple daemons collapse rather than flapping.
 */
export class ConflictDetector {
  constructor(private readonly options: ConflictDetectorOptions) {}

  private get binary(): string | undefined {
    return this.options.binary;
  }

  async detect(
    repoId: string,
    tasks: TaskBranch[],
    opts: DetectOptions = {},
  ): Promise<DetectionResult> {
    const repo = this.options.registry.get(repoId);
    if (!repo) throw new ConflictDetectorError('not_found', `unknown repo: ${repoId}`);
    const baseRef = opts.baseRef ?? repo.default_branch ?? 'HEAD';
    const epoch = opts.epoch ?? 0;
    const baseOid = await revParse(repo.root_path, baseRef, this.binary);
    const gate: GateResult[] = [];
    const conflicts: DetectedConflict[] = [];

    // Textual gate: each task branch vs the integration base.
    for (const task of tasks) {
      const branchOid = await revParse(repo.root_path, task.branch, this.binary);
      try {
        const merge = await mergeTreeWriteTree(repo.root_path, baseRef, task.branch, this.binary);
        gate.push({
          task_id: task.taskId,
          branch: task.branch,
          clean: merge.clean,
          tree_oid: merge.treeOid,
          conflicted_paths: merge.conflictedPaths,
          error: null,
        });
        if (!merge.clean && merge.conflictedPaths.length > 0) {
          const paths = merge.conflictedPaths.map(normalizeConflictPath).sort();
          conflicts.push(
            this.emitConflict(repo, {
              kind: 'textual',
              severity: 'blocking',
              taskIds: [task.taskId],
              paths,
              branchA: baseRef,
              branchB: task.branch,
              epoch,
              evidence: {
                kind: 'merge-tree',
                base_ref: baseRef,
                base_oid: baseOid,
                branch: task.branch,
                branch_oid: branchOid,
                tree_oid: merge.treeOid,
                conflicted_paths: paths,
                detector_device_id: this.options.deviceId,
              },
            }),
          );
          textualTotal.inc();
        }
      } catch (err) {
        gate.push({
          task_id: task.taskId,
          branch: task.branch,
          clean: false,
          tree_oid: null,
          conflicted_paths: [],
          error: err instanceof Error ? err.message : String(err),
        });
        this.options.logger?.warn(
          { repoId, branch: task.branch, err },
          'merge-tree gate unavailable for branch',
        );
      }
    }

    // Pairwise file overlap: intersect each branch's change set against the base.
    const changeSets = new Map<string, Set<string>>();
    for (const task of tasks) {
      try {
        const files = await diffNameOnly(repo.root_path, baseRef, task.branch, this.binary);
        changeSets.set(task.taskId, new Set(files.map(normalizeConflictPath)));
      } catch {
        changeSets.set(task.taskId, new Set());
      }
    }
    for (let i = 0; i < tasks.length; i++) {
      for (let j = i + 1; j < tasks.length; j++) {
        const a = tasks[i];
        const b = tasks[j];
        if (!a || !b) continue;
        const setA = changeSets.get(a.taskId) ?? new Set<string>();
        const setB = changeSets.get(b.taskId) ?? new Set<string>();
        const paths = [...setA].filter((p) => setB.has(p)).sort();
        if (paths.length === 0) continue;
        const [branchA, branchB] = [a.branch, b.branch].sort();
        conflicts.push(
          this.emitConflict(repo, {
            kind: 'file_overlap',
            severity: 'warning',
            taskIds: [a.taskId, b.taskId],
            paths,
            branchA: branchA ?? null,
            branchB: branchB ?? null,
            epoch,
            evidence: {
              kind: 'diff-overlap',
              base_ref: baseRef,
              branch_a: a.branch,
              branch_b: b.branch,
              paths,
              detector_device_id: this.options.deviceId,
            },
          }),
        );
        overlapTotal.inc();
      }
    }

    this.options.logger?.debug(
      { repoId, baseRef, epoch, conflicts: conflicts.length },
      'conflict detection sweep',
    );
    return { repo_id: repoId, base_ref: baseRef, base_oid: baseOid, epoch, gate, conflicts };
  }

  private emitConflict(
    repo: RepoRecord,
    input: {
      kind: ConflictKind;
      severity: ConflictSeverity;
      taskIds: string[];
      paths: string[];
      branchA: string | null;
      branchB: string | null;
      epoch: number;
      evidence: Record<string, unknown>;
    },
  ): DetectedConflict {
    const taskIds = [...new Set(input.taskIds)].sort();
    const key = canonicalConflictKey(input.kind, taskIds, input.paths);
    const conflict: DetectedConflict = {
      canonical_key: key,
      kind: input.kind,
      severity: input.severity,
      task_ids: taskIds,
      paths: input.paths,
      branch_a: input.branchA,
      branch_b: input.branchB,
    };
    this.options.emit({
      type: 'conflict.detected',
      actor: this.options.actor,
      repoId: repo.repo_id,
      privacy: 'metadata',
      payload: {
        canonical_key: key,
        kind: input.kind,
        severity: input.severity,
        state: 'open',
        detection_epoch: input.epoch,
        task_ids: taskIds,
        paths: input.paths,
        repo_id: repo.repo_id,
        ...(input.branchA ? { branch_a: input.branchA } : {}),
        ...(input.branchB ? { branch_b: input.branchB } : {}),
        evidence: [input.evidence],
      },
    });
    return conflict;
  }
}
