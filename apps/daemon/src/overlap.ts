import { createHash } from 'node:crypto';
import { metrics, type Logger } from '@weft/core';
import {
  canonicalConflictKey,
  normalizeConflictPath,
  type Actor,
  type ConflictSeverity,
} from '@weft/protocol';
import type { EventDraft } from './events.js';
import type { EnqueueResult } from './pipeline.js';
import type { RepoRecord, RepoRegistry } from './repos.js';
import type { BranchIndexState, LocalStore, StoredSymbol } from './store.js';
import type { Indexer } from './indexer.js';
import {
  diffSymbols,
  intersection,
  modificationIdentity,
  type SymbolChangeKind,
  type SymbolModification,
} from './symbol-diff.js';
import type { DetectedConflict, DetectOptions, TaskBranch } from './conflicts.js';

const symbolOverlapTotal = metrics.counter(
  'weft_conflicts_symbol_overlap_total',
  'Symbol-level overlaps detected (both branches modified the same symbol)',
);
const signatureImpactTotal = metrics.counter(
  'weft_conflicts_signature_impact_total',
  'Signature-change impacts detected (name-based call sites)',
);
const sweepLatency = metrics.histogram(
  'weft_overlap_sweep_ms',
  'Symbol overlap sweep latency (ms)',
);

export interface SymbolOverlapDetail {
  file_path: string;
  name: string;
  kind: string;
  container: string;
  change_a: SymbolChangeKind;
  change_b: SymbolChangeKind;
  signature_a: string | null;
  signature_b: string | null;
}

export interface SymbolOverlap {
  canonical_key: string;
  task_ids: string[];
  branch_a: string;
  branch_b: string;
  paths: string[];
  symbols: SymbolOverlapDetail[];
  severity: ConflictSeverity;
}

export interface CallSite {
  file_path: string;
  from_symbol: string;
  line: number;
}

export interface SignatureImpact {
  canonical_key: string;
  task_id: string;
  branch: string;
  file_path: string;
  name: string;
  kind: string;
  container: string;
  old_signature: string | null;
  new_signature: string | null;
  callers: CallSite[];
  affected_task_ids: string[];
  precision: 'name_based';
  severity: ConflictSeverity;
}

export interface OverlapResult {
  repo_id: string;
  base_ref: string;
  base_oid: string | null;
  epoch: number;
  overlaps: SymbolOverlap[];
  impacts: SignatureImpact[];
  conflicts: DetectedConflict[];
  indexed_branches: number;
  cached_branches: number;
  emitted: number;
  duration_ms: number;
}

export type OverlapErrorCode = 'not_found' | 'not_indexed';

export class OverlapError extends Error {
  constructor(
    readonly code: OverlapErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'OverlapError';
  }
}

export interface OverlapEngineOptions {
  deviceId: string;
  registry: RepoRegistry;
  store: LocalStore;
  indexer: Indexer;
  emit: (draft: EventDraft) => EnqueueResult;
  actor: Actor;
  logger?: Logger | undefined;
}

interface BranchMods {
  token: string;
  mods: Map<string, SymbolModification>;
  changedFiles: Set<string>;
}

interface RepoCache {
  baseRef: string;
  baseToken: string;
  baseByFile: Map<string, StoredSymbol[]>;
  baseFileHashes: Map<string, string>;
  branches: Map<string, BranchMods>;
  taskSignature: string;
  epoch: number;
  result: OverlapResult | null;
  emitted: Map<string, { digest: string; epoch: number }>;
}

function tokenOf(m: BranchIndexState): string {
  return `${m.head_oid}:${m.file_count}:${m.symbol_count}:${m.last_indexed_at ?? ''}`;
}

function groupByFile(symbols: StoredSymbol[]): Map<string, StoredSymbol[]> {
  const map = new Map<string, StoredSymbol[]>();
  for (const s of symbols) {
    const bucket = map.get(s.file_path);
    if (bucket) bucket.push(s);
    else map.set(s.file_path, [s]);
  }
  return map;
}

/**
 * Symbol-overlap engine (L1/L2). Compares each task branch's indexed symbols against
 * the integration base, then intersects the modified-symbol sets pairwise: when two
 * tasks both touched the same symbol it emits a `symbol_overlap` warning even if the
 * textual merge is clean. A signature change (or removal) additionally surfaces its
 * name-based call sites and the other tasks editing those files as `signature_impact`
 * (precision labelled name_based; exact Compiler-API resolution is M3.3).
 *
 * Incremental by construction: per-branch modified sets are cached against the index
 * manifest fingerprint, and conflicts are only re-emitted when their evidence digest
 * changes or the detection epoch advances. A steady-state sweep does no git, no
 * re-index and no duplicate cards. Read-only; never blocks a merge (warnings only).
 */
export class OverlapEngine {
  private readonly caches = new Map<string, RepoCache>();

  constructor(private readonly options: OverlapEngineOptions) {}

  private get store(): LocalStore {
    return this.options.store;
  }

  clearCache(repoId?: string): void {
    if (repoId) this.caches.delete(repoId);
    else this.caches.clear();
  }

  async sweep(
    repoId: string,
    tasks: TaskBranch[],
    opts: DetectOptions = {},
  ): Promise<OverlapResult> {
    const started = performance.now();
    const repo = this.options.registry.get(repoId);
    if (!repo) throw new OverlapError('not_found', `unknown repo: ${repoId}`);
    const baseRef = opts.baseRef ?? repo.default_branch ?? 'HEAD';
    const epoch = opts.epoch ?? 0;

    let cache = this.caches.get(repoId);
    if (!cache || cache.baseRef !== baseRef) {
      cache = {
        baseRef,
        baseToken: '',
        baseByFile: new Map(),
        baseFileHashes: new Map(),
        branches: new Map(),
        taskSignature: '',
        epoch: -1,
        result: null,
        emitted: new Map(),
      };
      this.caches.set(repoId, cache);
    }

    const baseManifest = await this.ensureIndexed(repoId, baseRef);
    const baseToken = tokenOf(baseManifest);
    const baseChanged = baseToken !== cache.baseToken;
    if (baseChanged) {
      cache.baseToken = baseToken;
      cache.baseByFile = groupByFile(this.store.getSymbols(repoId, baseRef));
      cache.baseFileHashes = new Map(
        this.store.listFileIndexState(repoId, baseRef).map((r) => [r.file_path, r.content_hash]),
      );
      cache.branches.clear();
    }

    const entries: { task: TaskBranch; token: string }[] = [];
    for (const task of tasks) {
      try {
        const manifest = await this.ensureIndexed(repoId, task.branch);
        entries.push({ task, token: tokenOf(manifest) });
      } catch (err) {
        this.options.logger?.warn(
          { repoId, branch: task.branch, err },
          'overlap sweep skipped unindexable branch',
        );
      }
    }

    const taskSignature =
      JSON.stringify(
        entries
          .map((e) => [e.task.taskId, e.task.branch, e.token])
          .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
      ) + `|${baseToken}`;

    if (cache.result && cache.taskSignature === taskSignature && cache.epoch === epoch) {
      const duration_ms = performance.now() - started;
      sweepLatency.observe(duration_ms);
      return {
        ...cache.result,
        duration_ms,
        emitted: 0,
        indexed_branches: 0,
        cached_branches: entries.length,
      };
    }

    const active = new Set(entries.map((e) => e.task.branch));
    for (const branch of [...cache.branches.keys()]) {
      if (!active.has(branch)) cache.branches.delete(branch);
    }
    let recomputed = 0;
    for (const { task, token } of entries) {
      const existing = cache.branches.get(task.branch);
      if (existing && existing.token === token && !baseChanged) continue;
      cache.branches.set(task.branch, this.computeBranchMods(repoId, task.branch, cache));
      recomputed++;
    }

    let emitted = 0;
    const conflicts: DetectedConflict[] = [];
    const overlaps: SymbolOverlap[] = [];
    const impacts: SignatureImpact[] = [];
    const usable = entries.filter((e) => cache.branches.has(e.task.branch));

    for (let i = 0; i < usable.length; i++) {
      for (let j = i + 1; j < usable.length; j++) {
        const a = usable[i];
        const b = usable[j];
        if (!a || !b) continue;
        const ma = cache.branches.get(a.task.branch);
        const mb = cache.branches.get(b.task.branch);
        if (!ma || !mb) continue;
        const shared = intersection(new Set(ma.mods.keys()), new Set(mb.mods.keys()));
        if (shared.length === 0) continue;
        const symbols: SymbolOverlapDetail[] = shared.map((key) => {
          const x = ma.mods.get(key);
          const y = mb.mods.get(key);
          return {
            file_path: x?.file_path ?? '',
            name: x?.name ?? '',
            kind: x?.kind ?? '',
            container: x?.container ?? '',
            change_a: x?.change_kind ?? 'body',
            change_b: y?.change_kind ?? 'body',
            signature_a: x?.new_signature ?? null,
            signature_b: y?.new_signature ?? null,
          };
        });
        const paths = [...new Set(symbols.map((s) => normalizeConflictPath(s.file_path)))].sort();
        const [branchA, branchB] = [a.task.branch, b.task.branch].sort();
        const signatureCollision = symbols.some(
          (s) => s.change_a === 'signature' && s.change_b === 'signature',
        );
        const evidence = {
          kind: 'symbol-overlap',
          base_ref: baseRef,
          base_oid: baseManifest.head_oid,
          branch_a: a.task.branch,
          branch_b: b.task.branch,
          symbols,
          signature_collision: signatureCollision,
          precision: 'name_based',
          detector_device_id: this.options.deviceId,
        };
        const rec = this.record(cache, repo, {
          kind: 'symbol_overlap',
          severity: 'warning',
          taskIds: [a.task.taskId, b.task.taskId],
          paths,
          symbolIds: shared,
          branchA: branchA ?? null,
          branchB: branchB ?? null,
          epoch,
          evidence,
        });
        if (rec.didEmit) emitted++;
        conflicts.push(rec.conflict);
        overlaps.push({
          canonical_key: rec.conflict.canonical_key,
          task_ids: rec.conflict.task_ids,
          branch_a: branchA ?? '',
          branch_b: branchB ?? '',
          paths,
          symbols,
          severity: 'warning',
        });
        symbolOverlapTotal.inc();
      }
    }

    const callerCache = new Map<string, CallSite[]>();
    for (const { task } of usable) {
      const bm = cache.branches.get(task.branch);
      if (!bm) continue;
      for (const mod of bm.mods.values()) {
        if (mod.change_kind !== 'signature' && mod.change_kind !== 'removed') continue;
        let callers = callerCache.get(mod.name);
        if (!callers) {
          callers = this.store
            .getSymbolEdges(repoId, baseRef, { toName: mod.name, kind: 'calls' })
            .map((e) => ({ file_path: e.file_path, from_symbol: e.from_symbol, line: e.line }));
          callerCache.set(mod.name, callers);
        }
        if (callers.length === 0) continue;
        const callerPaths = [
          ...new Set(callers.map((c) => normalizeConflictPath(c.file_path))),
        ].sort();
        const affected = usable
          .filter((e) => e.task.taskId !== task.taskId && e.task.branch !== task.branch)
          .filter((e) => {
            const set = cache.branches.get(e.task.branch)?.changedFiles;
            return set ? callerPaths.some((p) => set.has(p)) : false;
          })
          .map((e) => e.task.taskId);
        const severity: ConflictSeverity = affected.length > 0 ? 'warning' : 'info';
        const evidence = {
          kind: 'signature-impact',
          base_ref: baseRef,
          branch: task.branch,
          file_path: mod.file_path,
          name: mod.name,
          symbol_kind: mod.kind,
          container: mod.container,
          change_kind: mod.change_kind,
          old_signature: mod.old_signature,
          new_signature: mod.new_signature,
          callers,
          affected_task_ids: affected,
          precision: 'name_based',
          detector_device_id: this.options.deviceId,
        };
        const rec = this.record(cache, repo, {
          kind: 'signature_impact',
          severity,
          taskIds: [task.taskId, ...affected],
          paths: callerPaths,
          symbolIds: [modificationIdentity(mod)],
          branchA: task.branch,
          branchB: null,
          epoch,
          evidence,
        });
        if (rec.didEmit) emitted++;
        conflicts.push(rec.conflict);
        impacts.push({
          canonical_key: rec.conflict.canonical_key,
          task_id: task.taskId,
          branch: task.branch,
          file_path: mod.file_path,
          name: mod.name,
          kind: mod.kind,
          container: mod.container,
          old_signature: mod.old_signature,
          new_signature: mod.new_signature,
          callers,
          affected_task_ids: affected,
          precision: 'name_based',
          severity,
        });
        signatureImpactTotal.inc();
      }
    }

    const duration_ms = performance.now() - started;
    const result: OverlapResult = {
      repo_id: repoId,
      base_ref: baseRef,
      base_oid: baseManifest.head_oid,
      epoch,
      overlaps,
      impacts,
      conflicts,
      indexed_branches: recomputed,
      cached_branches: usable.length - recomputed,
      emitted,
      duration_ms,
    };
    cache.taskSignature = taskSignature;
    cache.epoch = epoch;
    cache.result = result;
    sweepLatency.observe(duration_ms);
    this.options.logger?.debug(
      { repoId, baseRef, epoch, overlaps: overlaps.length, impacts: impacts.length, emitted, duration_ms },
      'symbol overlap sweep',
    );
    return result;
  }

  private async ensureIndexed(repoId: string, branch: string): Promise<BranchIndexState> {
    const existing = this.store.getBranchIndexState(repoId, branch);
    if (existing) return existing;
    await this.options.indexer.indexRepo(repoId, { branch });
    const after = this.store.getBranchIndexState(repoId, branch);
    if (!after) throw new OverlapError('not_indexed', `branch could not be indexed: ${branch}`);
    return after;
  }

  private computeBranchMods(repoId: string, branch: string, cache: RepoCache): BranchMods {
    const branchHashes = new Map(
      this.store.listFileIndexState(repoId, branch).map((r) => [r.file_path, r.content_hash]),
    );
    const changedFiles = new Set<string>();
    for (const [file, hash] of branchHashes) {
      if (cache.baseFileHashes.get(file) !== hash) changedFiles.add(file);
    }
    for (const file of cache.baseFileHashes.keys()) {
      if (!branchHashes.has(file)) changedFiles.add(file);
    }
    const branchByFile = groupByFile(this.store.getSymbols(repoId, branch));
    const mods = new Map<string, SymbolModification>();
    for (const file of changedFiles) {
      const baseSyms = cache.baseByFile.get(file) ?? [];
      const branchSyms = branchByFile.get(file) ?? [];
      for (const m of diffSymbols(file, baseSyms, branchSyms)) {
        mods.set(modificationIdentity(m), m);
      }
    }
    const manifest = this.store.getBranchIndexState(repoId, branch);
    return { token: manifest ? tokenOf(manifest) : '', mods, changedFiles };
  }

  private record(
    cache: RepoCache,
    repo: RepoRecord,
    input: {
      kind: 'symbol_overlap' | 'signature_impact';
      severity: ConflictSeverity;
      taskIds: string[];
      paths: string[];
      symbolIds: string[];
      branchA: string | null;
      branchB: string | null;
      epoch: number;
      evidence: Record<string, unknown>;
    },
  ): { conflict: DetectedConflict; didEmit: boolean } {
    const taskIds = [...new Set(input.taskIds)].sort();
    const paths = [...new Set(input.paths.map(normalizeConflictPath))].sort();
    const key = canonicalConflictKey(input.kind, taskIds, paths);
    const conflict: DetectedConflict = {
      canonical_key: key,
      kind: input.kind,
      severity: input.severity,
      task_ids: taskIds,
      paths,
      branch_a: input.branchA,
      branch_b: input.branchB,
    };
    const digest = createHash('sha256')
      .update(JSON.stringify(input.evidence))
      .digest('hex')
      .slice(0, 16);
    const prev = cache.emitted.get(key);
    const didEmit = !prev || prev.digest !== digest || input.epoch > prev.epoch;
    if (didEmit) {
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
          paths,
          symbol_ids: [...new Set(input.symbolIds)].sort(),
          repo_id: repo.repo_id,
          ...(input.branchA ? { branch_a: input.branchA } : {}),
          ...(input.branchB ? { branch_b: input.branchB } : {}),
          evidence: [input.evidence],
        },
      });
      cache.emitted.set(key, { digest, epoch: input.epoch });
    }
    return { conflict, didEmit };
  }
}