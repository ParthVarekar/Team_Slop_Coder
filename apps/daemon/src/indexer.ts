import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  currentBranch,
  lsFiles,
  lsTree,
  metrics,
  revParse,
  showFile,
  type Logger,
} from '@weft/core';
import { extractSymbols } from './symbols.js';
import type { LocalStore } from './store.js';
import type { RepoRegistry } from './repos.js';

const fileLatency = metrics.histogram(
  'weft_index_file_ms',
  'Per-file symbol extraction + persist latency (ms)',
);
const symbolsIndexed = metrics.counter(
  'weft_symbols_indexed_total',
  'Symbols written to the index',
);
const filesIndexed = metrics.counter('weft_index_files_total', 'Files (re)indexed');

const SOURCE_RE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const IGNORE_RE = /(^|\/)(node_modules|dist|build|out|coverage|\.git|\.next|vendor)\//;

const sha1 = (s: string): string => createHash('sha1').update(s).digest('hex');

export type IndexErrorCode = 'not_found';

export class IndexerError extends Error {
  constructor(
    readonly code: IndexErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'IndexerError';
  }
}

export interface IndexOptions {
  /** Branch to index (default: repo default branch, else the checked-out branch). */
  branch?: string | undefined;
  /** Read from the git ref even when it matches the working tree (detached snapshots). */
  fromRef?: boolean | undefined;
}

export interface IndexResult {
  repo_id: string;
  branch: string;
  source: 'worktree' | 'ref';
  indexed: number;
  skipped: number;
  deleted: number;
  symbols: number;
  duration_ms: number;
}

export interface InvalidateResult {
  indexed: number;
  skipped: number;
  deleted: number;
}

export interface IndexerOptions {
  registry: RepoRegistry;
  store: LocalStore;
  binary?: string | undefined;
  logger?: Logger | undefined;
}

type FileOutcome = 'indexed' | 'skipped' | 'deleted';

/**
 * Daemon-local symbol index. Branch-scoped (two branches never overwrite each
 * other) and incremental: a file whose content hash matches file_index_state is
 * skipped, so a git-diff invalidation only re-parses what actually changed. Reads
 * the working tree when indexing the checked-out branch (fast disk path) and the
 * git ref otherwise (no checkout required). Pure extraction; never runs the code.
 */
export class Indexer {
  constructor(private readonly options: IndexerOptions) {}

  private get binary(): string | undefined {
    return this.options.binary;
  }

  private get store(): LocalStore {
    return this.options.store;
  }

  private repo(repoId: string) {
    const repo = this.options.registry.get(repoId);
    if (!repo) throw new IndexerError('not_found', `unknown repo: ${repoId}`);
    return repo;
  }

  private readDisk(root: string, file: string): string | null {
    try {
      return readFileSync(join(root, file), 'utf8');
    } catch {
      return null;
    }
  }

  private async readRef(root: string, branch: string, file: string): Promise<string | null> {
    try {
      return await showFile(root, branch, file, this.binary);
    } catch {
      return null;
    }
  }

  /** Refresh the per-branch manifest the overlap engine uses as a cache fingerprint. */
  private async recordManifest(repoId: string, branch: string, root: string): Promise<void> {
    const headOid = (await revParse(root, branch, this.binary)) ?? '';
    const agg = this.store.getBranchIndexAggregate(repoId, branch);
    this.store.setBranchIndexState(
      repoId,
      branch,
      headOid,
      agg.file_count,
      agg.symbol_count,
      agg.last_indexed_at,
    );
  }

  private async indexOne(
    repoId: string,
    branch: string,
    root: string,
    file: string,
    useWorktree: boolean,
  ): Promise<FileOutcome> {
    const content = useWorktree
      ? this.readDisk(root, file)
      : await this.readRef(root, branch, file);
    if (content === null) {
      this.store.deleteFileSymbols(repoId, branch, file);
      return 'deleted';
    }
    const hash = sha1(content);
    const state = this.store.getFileIndexState(repoId, branch, file);
    if (state?.content_hash === hash) return 'skipped';
    const started = performance.now();
    const { symbols, edges } = extractSymbols(file, content);
    this.store.replaceFileSymbols(repoId, branch, file, symbols, edges, hash);
    fileLatency.observe(performance.now() - started);
    symbolsIndexed.inc(symbols.length);
    filesIndexed.inc();
    return 'indexed';
  }

  /** Full sweep: index every source file, skip unchanged, drop files that vanished. */
  async indexRepo(repoId: string, opts: IndexOptions = {}): Promise<IndexResult> {
    const started = performance.now();
    const repo = this.repo(repoId);
    const root = repo.root_path;
    const current = await currentBranch(root, this.binary);
    const branch = opts.branch ?? repo.default_branch ?? current ?? 'HEAD';
    const useWorktree = !opts.fromRef && current !== null && branch === current;
    const source = useWorktree ? 'worktree' : 'ref';
    const all = useWorktree
      ? await lsFiles(root, [], this.binary)
      : await lsTree(root, branch, this.binary);
    const files = all.filter((p) => SOURCE_RE.test(p) && !IGNORE_RE.test(p));
    const present = new Set(files);

    let indexed = 0;
    let skipped = 0;
    let symbols = 0;
    for (const file of files) {
      const outcome = await this.indexOne(repoId, branch, root, file, useWorktree);
      if (outcome === 'indexed') {
        indexed++;
        symbols += this.store.getFileIndexState(repoId, branch, file)?.symbol_count ?? 0;
      } else if (outcome === 'skipped') {
        skipped++;
        symbols += this.store.getFileIndexState(repoId, branch, file)?.symbol_count ?? 0;
      }
    }

    let deleted = 0;
    for (const prev of this.store.listIndexedFiles(repoId, branch)) {
      if (!present.has(prev)) {
        this.store.deleteFileSymbols(repoId, branch, prev);
        deleted++;
      }
    }

    await this.recordManifest(repoId, branch, root);
    const duration_ms = performance.now() - started;
    this.options.logger?.debug(
      { repoId, branch, source, indexed, skipped, deleted, symbols, duration_ms },
      'symbol index sweep',
    );
    return { repo_id: repoId, branch, source, indexed, skipped, deleted, symbols, duration_ms };
  }

  /** Incremental: re-index one file (or drop it when unreadable). Branch explicit. */
  async indexFile(
    repoId: string,
    branch: string,
    filePath: string,
    fromRef = false,
  ): Promise<FileOutcome> {
    const repo = this.repo(repoId);
    const current = await currentBranch(repo.root_path, this.binary);
    const useWorktree = !fromRef && current !== null && branch === current;
    return this.indexOne(repoId, branch, repo.root_path, filePath, useWorktree);
  }

  /**
   * git-diff invalidation: re-index changed paths, drop deleted paths. Non-source
   * paths are ignored. Resolves the branch once so a large change set costs one
   * git invocation, not one per file.
   */
  async invalidate(
    repoId: string,
    changed: string[],
    deleted: string[],
    opts: IndexOptions = {},
  ): Promise<InvalidateResult> {
    const repo = this.repo(repoId);
    const root = repo.root_path;
    const current = await currentBranch(root, this.binary);
    const branch = opts.branch ?? repo.default_branch ?? current ?? 'HEAD';
    const useWorktree = !opts.fromRef && current !== null && branch === current;
    let indexed = 0;
    let skipped = 0;
    let removed = 0;
    for (const file of changed) {
      if (!SOURCE_RE.test(file) || IGNORE_RE.test(file)) continue;
      const outcome = await this.indexOne(repoId, branch, root, file, useWorktree);
      if (outcome === 'indexed') indexed++;
      else if (outcome === 'skipped') skipped++;
      else removed++;
    }
    for (const file of deleted) {
      this.store.deleteFileSymbols(repoId, branch, file);
      removed++;
    }
    await this.recordManifest(repoId, branch, root);
    return { indexed, skipped, deleted: removed };
  }
}
