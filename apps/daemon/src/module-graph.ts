import { cruise, type ICruiseResult, type IModule } from 'dependency-cruiser';
import { metrics, type Logger } from '@weft/core';
import type { RepoRegistry } from './repos.js';

const graphLatency = metrics.histogram('weft_module_graph_ms', 'Module graph build latency (ms)');
const graphTotal = metrics.counter('weft_module_graph_builds_total', 'Module graph builds');

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
const DEFAULT_EXCLUDE = '(^|/)(node_modules|dist|build|out|coverage|\\.git|\\.next|vendor)(/|$)';

export type ModuleGraphErrorCode = 'not_found' | 'cruise_failed';

export class ModuleGraphError extends Error {
  constructor(
    readonly code: ModuleGraphErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ModuleGraphError';
  }
}

/** A source module (repo-relative posix path) and its local import edges. */
export interface ModuleNode {
  path: string;
  dependencies: string[];
  dependents: string[];
}

export interface ModuleGraph {
  repo_id: string;
  root: string;
  modules: ModuleNode[];
  edges: number;
  duration_ms: number;
}

export interface ModuleGraphOptions {
  /** Subdirectory to cruise, relative to the repo root (default: whole repo). */
  path?: string | undefined;
  /** Regex of paths to exclude (default: node_modules/dist/build/.git/...). */
  exclude?: string | undefined;
  /** Include TypeScript type-only imports as edges (default: true). */
  tsPreCompilationDeps?: boolean | undefined;
}

export interface ModuleGraphServiceOptions {
  registry: RepoRegistry;
  logger?: Logger | undefined;
}

/** Strip a leading './' so changed paths and graph sources compare equal. */
function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * Transitive reverse-dependency closure: every module that (directly or
 * indirectly) imports one of `changedPaths`. This is the coarse module-level
 * impact tier — which modules are potentially affected by a change — feeding
 * affected-test selection and cross-task impact warnings. The exact symbol-level
 * call sites come from the resolver (M3.3); this is the cheap, whole-repo tier.
 *
 * Deterministic: seeds are processed in sorted order and the result is sorted.
 * Cycles terminate (visited set). Unknown changed paths contribute nothing.
 */
export function dependentsOf(graph: ModuleGraph, changedPaths: readonly string[]): string[] {
  const reverse = new Map<string, string[]>();
  for (const m of graph.modules) {
    for (const dep of m.dependencies) {
      const list = reverse.get(dep);
      if (list) list.push(m.path);
      else reverse.set(dep, [m.path]);
    }
  }
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const raw of changedPaths) {
    const p = normalizePath(raw);
    if (!seen.has(p)) {
      seen.add(p);
      queue.push(p);
    }
  }
  const impacted = new Set<string>();
  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const dependent of reverse.get(current) ?? []) {
      if (!seen.has(dependent)) {
        seen.add(dependent);
        impacted.add(dependent);
        queue.push(dependent);
      }
    }
  }
  return [...impacted].sort();
}

function toResult(raw: ICruiseResult | string): ICruiseResult {
  return typeof raw === 'string' ? (JSON.parse(raw) as ICruiseResult) : raw;
}

/** Keep only local, resolved source modules (drop npm/core/unresolved noise). */
function isLocalSource(m: IModule): boolean {
  if (m.coreModule) return false;
  const types = m.dependencyTypes ?? [];
  if (types.length > 0 && !types.some((t) => t === 'local' || t === 'localmodule')) return false;
  return SOURCE_EXTENSIONS.some((ext) => m.source.endsWith(ext));
}

/**
 * Daemon-local module graph via dependency-cruiser (architecture §03). Cruises a
 * repo's import graph using the installed TypeScript transpiler and projects it
 * to local source modules with forward/reverse edges. On-demand and read-only —
 * it never mutates the repo or the symbol index. Other languages are out of scope
 * here (per-language LSP, P2).
 */
export class ModuleGraphService {
  private readonly registry: RepoRegistry;
  private readonly logger: Logger | undefined;

  constructor(options: ModuleGraphServiceOptions) {
    this.registry = options.registry;
    this.logger = options.logger;
  }

  async build(repoId: string, options: ModuleGraphOptions = {}): Promise<ModuleGraph> {
    const repo = this.registry.get(repoId);
    if (!repo) throw new ModuleGraphError('not_found', `repo ${repoId} is not registered`);
    const root = repo.root_path;
    const start = performance.now();
    const scanPath = options.path ? normalizePath(options.path) : '.';
    const exclude = options.exclude ?? DEFAULT_EXCLUDE;

    let result: ICruiseResult;
    try {
      const res = await cruise(
        [scanPath],
        {
          baseDir: root,
          outputType: 'json',
          tsPreCompilationDeps: options.tsPreCompilationDeps ?? true,
          doNotFollow: 'node_modules',
          exclude,
          moduleSystems: ['es6', 'cjs'],
          progress: { type: 'none' },
          validate: false,
        },
        { extensions: SOURCE_EXTENSIONS },
      );
      result = toResult(res.output);
    } catch (err) {
      this.logger?.warn({ err, repoId }, 'module graph cruise failed');
      throw new ModuleGraphError('cruise_failed', err instanceof Error ? err.message : String(err));
    }

    const local = result.modules.filter(isLocalSource);
    const present = new Set(local.map((m) => m.source));
    const modules: ModuleNode[] = local
      .map((m) => ({
        path: m.source,
        dependencies: m.dependencies
          .map((d) => d.resolved)
          .filter((r) => present.has(r) && r !== m.source)
          .sort(),
        dependents: m.dependents.filter((d) => present.has(d) && d !== m.source).sort(),
      }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

    const edges = modules.reduce((sum, m) => sum + m.dependencies.length, 0);
    const duration_ms = Math.round(performance.now() - start);
    graphLatency.observe(duration_ms);
    graphTotal.inc();
    return { repo_id: repoId, root, modules, edges, duration_ms };
  }

  /** Build the graph and return the transitive dependents of the changed paths. */
  async impactedModules(repoId: string, changedPaths: readonly string[], options: ModuleGraphOptions = {}): Promise<string[]> {
    const graph = await this.build(repoId, options);
    return dependentsOf(graph, changedPaths);
  }
}