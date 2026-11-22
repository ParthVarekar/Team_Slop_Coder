import { dependentsOf, type ModuleGraph, type ModuleGraphOptions, ModuleGraphService } from './module-graph.js';
import type { RepoRegistry } from './repos.js';

const TEST_FILE_RE = /(^|\/)(?:__tests__\/|[^/]*\.(?:test|spec)\.[jt]sx?$)/;

export function isTestFile(path: string): boolean {
  return TEST_FILE_RE.test(path.replace(/\\/g, '/'));
}

function normalize(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

export interface TiaOptions {
  /** Override the test-file matcher (default: *.test/*.spec/*__tests__*). */
  isTest?: ((path: string) => boolean) | undefined;
}

/**
 * Test Impact Analysis: the tests affected by a set of changed files. A test is
 * affected if it is itself changed or it (transitively) imports a changed module
 * — the reverse-dependency closure of the change set, filtered to test files.
 * This is Jest's --findRelatedTests semantics over the whole-repo module graph.
 * Pure + deterministic (sorted, deduped); unknown paths contribute nothing.
 */
export function selectAffectedTests(
  graph: ModuleGraph,
  changedPaths: readonly string[],
  options: TiaOptions = {},
): string[] {
  const isTest = options.isTest ?? isTestFile;
  const impacted = new Set<string>(dependentsOf(graph, changedPaths));
  for (const raw of changedPaths) impacted.add(normalize(raw));
  return [...impacted].filter(isTest).sort();
}

export interface TiaSelectorOptions {
  registry: RepoRegistry;
  graph?: ModuleGraphService | undefined;
}

/** Builds the module graph on demand and selects the affected tests. */
export class TiaSelector {
  private readonly graph: ModuleGraphService;

  constructor(options: TiaSelectorOptions) {
    this.graph = options.graph ?? new ModuleGraphService({ registry: options.registry });
  }

  async affectedTests(
    repoId: string,
    changedPaths: readonly string[],
    options: TiaOptions & ModuleGraphOptions = {},
  ): Promise<string[]> {
    const graph = await this.graph.build(repoId, options);
    return selectAffectedTests(graph, changedPaths, options);
  }
}