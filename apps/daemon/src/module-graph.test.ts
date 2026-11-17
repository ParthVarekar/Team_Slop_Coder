import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DAEMON_MIGRATIONS, migrate, openSqlite, type SqliteDatabase } from '@weft/core';
import { makeId } from '@weft/protocol';
import { RepoRegistry } from './repos.js';
import { ModuleGraphService, ModuleGraphError, dependentsOf, type ModuleGraph } from './module-graph.js';

const dirs: string[] = [];
const dbs: SqliteDatabase[] = [];

function g(repo: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true }).trim();
}

function makeRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'weft-mg-repo-'));
  dirs.push(dir);
  g(dir, ['init', '-q', '-b', 'main']);
  g(dir, ['config', 'user.name', 'Test']);
  g(dir, ['config', 'user.email', 'test@example.com']);
  g(dir, ['config', 'commit.gpgsign', 'false']);
  g(dir, ['config', 'core.autocrlf', 'false']);
  for (const [path, content] of Object.entries(files)) {
    const abs = join(dir, path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  g(dir, ['add', '-A']);
  g(dir, ['commit', '-q', '-m', 'base']);
  return dir;
}

function harness() {
  const db = openSqlite(':memory:');
  migrate(db, DAEMON_MIGRATIONS);
  dbs.push(db);
  const registry = new RepoRegistry(db, { deviceId: makeId('device'), projectId: makeId('project') });
  const service = new ModuleGraphService({ registry });
  return { db, registry, service };
}

afterEach(() => {
  for (const db of dbs.splice(0)) {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  }
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      /* Windows transient handles */
    }
  }
});

// a -> b -> c chain plus a leaf d importing c, and an isolated orphan.
const CHAIN: Record<string, string> = {
  'src/a.ts': "import { b } from './b.js';\nexport const a = b + 1;\n",
  'src/b.ts': "import { c } from './c.js';\nexport const b = c + 1;\n",
  'src/c.ts': 'export const c = 1;\n',
  'src/d.ts': "import { c } from './c.js';\nexport const d = c + 2;\n",
  'src/orphan.ts': 'export const orphan = 0;\n',
  'README.md': '# not source\n',
  'node_modules/dep/index.ts': "import { c } from '../../src/c.js';\nexport const ignored = 1;\n",
};

describe('ModuleGraphService.build', () => {
  it('projects the import graph to local source modules with forward/reverse edges', async () => {
    const { registry, service } = harness();
    const repo = await registry.register(makeRepo(CHAIN));
    const graph = await service.build(repo.repo_id);

    const paths = graph.modules.map((m) => m.path);
    expect(paths).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/orphan.ts']);
    expect(graph.modules.find((m) => m.path === 'src/a.ts')?.dependencies).toEqual(['src/b.ts']);
    expect(graph.modules.find((m) => m.path === 'src/b.ts')?.dependents).toEqual(['src/a.ts']);
    expect(graph.modules.find((m) => m.path === 'src/c.ts')?.dependents).toEqual(['src/b.ts', 'src/d.ts']);
    expect(graph.modules.find((m) => m.path === 'src/orphan.ts')?.dependencies).toEqual([]);
    // a->b, b->c, d->c = 3 local edges; npm/core/non-source excluded.
    expect(graph.edges).toBe(3);
    expect(graph.repo_id).toBe(repo.repo_id);
    expect(graph.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('is deterministic across builds', async () => {
    const { registry, service } = harness();
    const repo = await registry.register(makeRepo(CHAIN));
    const first = await service.build(repo.repo_id);
    const second = await service.build(repo.repo_id);
    expect(second.modules).toEqual(first.modules);
    expect(second.edges).toBe(first.edges);
  });

  it('restricts the cruise to a subdirectory via path', async () => {
    const { registry, service } = harness();
    const repo = await registry.register(
      makeRepo({
        'src/a.ts': "import { b } from './b.js';\nexport const a = b;\n",
        'src/b.ts': 'export const b = 1;\n',
        'other/x.ts': "import { a } from '../src/a.js';\nexport const x = a;\n",
      }),
    );
    const graph = await service.build(repo.repo_id, { path: 'src' });
    expect(graph.modules.map((m) => m.path)).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('throws not_found for an unregistered repo', async () => {
    const { service } = harness();
    await expect(service.build('repo_missing')).rejects.toBeInstanceOf(ModuleGraphError);
    await expect(service.build('repo_missing')).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('dependentsOf (transitive reverse closure)', () => {
  it('returns every module that directly or indirectly imports a changed leaf', async () => {
    const { registry, service } = harness();
    const repo = await registry.register(makeRepo(CHAIN));
    const graph = await service.build(repo.repo_id);
    // c is imported by b and d; b is imported by a => closure {a,b,d}.
    expect(dependentsOf(graph, ['src/c.ts'])).toEqual(['src/a.ts', 'src/b.ts', 'src/d.ts']);
    expect(dependentsOf(graph, ['src/b.ts'])).toEqual(['src/a.ts']);
    expect(dependentsOf(graph, ['src/a.ts'])).toEqual([]);
    expect(dependentsOf(graph, ['src/orphan.ts'])).toEqual([]);
  });

  it('normalizes leading ./ and backslashes, dedupes seeds, ignores unknown paths', async () => {
    const { registry, service } = harness();
    const repo = await registry.register(makeRepo(CHAIN));
    const graph = await service.build(repo.repo_id);
    expect(dependentsOf(graph, ['./src/c.ts', 'src\\c.ts', 'src/c.ts'])).toEqual([
      'src/a.ts',
      'src/b.ts',
      'src/d.ts',
    ]);
    expect(dependentsOf(graph, ['src/does-not-exist.ts'])).toEqual([]);
    expect(dependentsOf(graph, [])).toEqual([]);
  });

  it('terminates on import cycles and excludes the seed itself', async () => {
    const { registry, service } = harness();
    const repo = await registry.register(
      makeRepo({
        'src/x.ts': "import { y } from './y.js';\nexport const x = y;\n",
        'src/y.ts': "import { x } from './x.js';\nexport const y = x;\n",
        'src/z.ts': "import { x } from './x.js';\nexport const z = x;\n",
      }),
    );
    const graph = await service.build(repo.repo_id);
    // x <-> y cycle, z imports x. Changing x impacts y (cycle) and z, never x itself.
    expect(dependentsOf(graph, ['src/x.ts'])).toEqual(['src/y.ts', 'src/z.ts']);
  });

  it('works on a hand-built graph without cruising (pure function)', () => {
    const graph: ModuleGraph = {
      repo_id: 'repo_x',
      root: '/x',
      modules: [
        { path: 'a', dependencies: ['b'], dependents: [] },
        { path: 'b', dependencies: ['c'], dependents: ['a'] },
        { path: 'c', dependencies: [], dependents: ['b'] },
      ],
      edges: 2,
      duration_ms: 0,
    };
    expect(dependentsOf(graph, ['c'])).toEqual(['a', 'b']);
  });
});

describe('ModuleGraphService.impactedModules', () => {
  it('builds and returns the impact closure in one call', async () => {
    const { registry, service } = harness();
    const repo = await registry.register(makeRepo(CHAIN));
    expect(await service.impactedModules(repo.repo_id, ['src/c.ts'])).toEqual([
      'src/a.ts',
      'src/b.ts',
      'src/d.ts',
    ]);
  });
});