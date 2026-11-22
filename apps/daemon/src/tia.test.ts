import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DAEMON_MIGRATIONS, migrate, openSqlite, type SqliteDatabase } from '@weft/core';
import { makeId } from '@weft/protocol';
import { RepoRegistry } from './repos.js';
import { type ModuleGraph } from './module-graph.js';
import { isTestFile, selectAffectedTests, TiaSelector } from './tia.js';

const dirs: string[] = [];
const dbs: SqliteDatabase[] = [];

function g(repo: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true }).trim();
}

function makeRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'weft-tia-repo-'));
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
  return { db, registry, selector: new TiaSelector({ registry }) };
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

// util <- util.test, util <- __tests__/integration; other.test is isolated.
const FILES: Record<string, string> = {
  'src/util.ts': 'export const util = 1;\n',
  'src/util.test.ts': "import { util } from './util.js';\nexport const t = util;\n",
  'src/other.test.ts': 'export const o = 1;\n',
  'src/__tests__/integration.ts': "import { util } from '../util.js';\nexport const i = util;\n",
};

function synthetic(): ModuleGraph {
  return {
    repo_id: 'repo_x',
    root: '/x',
    modules: [
      { path: 'src/a.ts', dependencies: [], dependents: [] },
      { path: 'src/a.test.ts', dependencies: ['src/a.ts'], dependents: [] },
      { path: 'src/b.ts', dependencies: ['src/a.ts'], dependents: [] },
      { path: 'src/b.test.ts', dependencies: ['src/b.ts'], dependents: [] },
      { path: 'src/c.test.ts', dependencies: [], dependents: [] },
      { path: '__tests__/integration.ts', dependencies: ['src/a.ts'], dependents: [] },
    ],
    edges: 4,
    duration_ms: 0,
  };
}

describe('isTestFile', () => {
  it('matches .test/.spec and __tests__ across extensions and separators', () => {
    expect(isTestFile('src/a.test.ts')).toBe(true);
    expect(isTestFile('src/a.spec.tsx')).toBe(true);
    expect(isTestFile('src/__tests__/x.js')).toBe(true);
    expect(isTestFile('src\\a.test.ts')).toBe(true);
    expect(isTestFile('src/a.ts')).toBe(false);
    expect(isTestFile('src/testing.ts')).toBe(false);
  });
});

describe('selectAffectedTests (pure)', () => {
  it('selects transitive test dependents of a changed source module', () => {
    expect(selectAffectedTests(synthetic(), ['src/a.ts'])).toEqual([
      '__tests__/integration.ts',
      'src/a.test.ts',
      'src/b.test.ts',
    ]);
  });

  it('includes a directly changed test file even with no dependents', () => {
    expect(selectAffectedTests(synthetic(), ['src/c.test.ts'])).toEqual(['src/c.test.ts']);
  });

  it('ignores unknown paths and normalizes leading ./ and backslashes', () => {
    expect(selectAffectedTests(synthetic(), ['src/nope.ts'])).toEqual([]);
    expect(selectAffectedTests(synthetic(), ['./src/a.ts', 'src\\a.ts'])).toEqual([
      '__tests__/integration.ts',
      'src/a.test.ts',
      'src/b.test.ts',
    ]);
  });

  it('is deterministic and order-independent', () => {
    const graph = synthetic();
    const a = selectAffectedTests(graph, ['src/a.ts', 'src/c.test.ts']);
    const b = selectAffectedTests(graph, ['src/c.test.ts', 'src/a.ts']);
    expect(a).toEqual(b);
    expect(a).toEqual(['__tests__/integration.ts', 'src/a.test.ts', 'src/b.test.ts', 'src/c.test.ts']);
  });

  it('honors a custom test matcher', () => {
    expect(
      selectAffectedTests(synthetic(), ['src/a.ts'], { isTest: (p) => p.endsWith('.test.ts') }),
    ).toEqual(['src/a.test.ts', 'src/b.test.ts']);
  });
});

describe('TiaSelector over a real module graph', () => {
  it('selects the tests that import a changed module', async () => {
    const { registry, selector } = harness();
    const repo = await registry.register(makeRepo(FILES));
    expect(await selector.affectedTests(repo.repo_id, ['src/util.ts'])).toEqual([
      'src/__tests__/integration.ts',
      'src/util.test.ts',
    ]);
  });

  it('selects a changed test directly and nothing for an unrelated change', async () => {
    const { registry, selector } = harness();
    const repo = await registry.register(makeRepo(FILES));
    expect(await selector.affectedTests(repo.repo_id, ['src/other.test.ts'])).toEqual(['src/other.test.ts']);
    expect(await selector.affectedTests(repo.repo_id, ['README.md'])).toEqual([]);
  });
});