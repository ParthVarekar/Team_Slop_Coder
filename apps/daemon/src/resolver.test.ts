import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { metrics, type ResolverConfig } from '@weft/core';
// The resolver forks a real compiled worker, so exercise the built artifact (the
// daemon runs from dist in production). import.meta.url then resolves the worker.
import { ResolverClient, ResolverError } from '../dist/resolver.js';
import type { Reference } from './resolver-worker.js';

const dirs: string[] = [];
const clients: ResolverClient[] = [];

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function cfg(over: Partial<ResolverConfig> = {}): ResolverConfig {
  return {
    enabled: true,
    maxMemoryMb: 1024,
    idleTimeoutMs: 600_000,
    requestTimeoutMs: 30_000,
    ...over,
  };
}

function client(over: Partial<ResolverConfig> = {}): ResolverClient {
  const c = new ResolverClient(cfg(over));
  clients.push(c);
  return c;
}

function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'weft-resolver-'));
  dirs.push(dir);
  const all: Record<string, string> = {
    'tsconfig.json': JSON.stringify({
      compilerOptions: {
        target: 'ES2020',
        module: 'commonjs',
        moduleResolution: 'node',
        strict: false,
        allowJs: true,
        skipLibCheck: true,
        noEmit: true,
      },
      include: ['src/**/*.ts'],
    }),
    ...files,
  };
  for (const [path, content] of Object.entries(all)) {
    const abs = join(dir, path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
}

/**
 * Signature-change fixture with a SAME-NAME decoy in another module. Ground truth
 * is labeled inline: every line referencing lib.getUser carries `// REF`; decoy
 * references carry `// DECOY` and must be excluded by type-based resolution.
 */
function precisionFixture(): { dir: string; truth: Set<string> } {
  const files: Record<string, string> = {
    'src/lib.ts': 'export function getUser(id: number): string {\n  return String(id);\n}\n',
    'src/decoy.ts': 'export function getUser(id: string): number {\n  return Number(id);\n}\n',
    'src/callerA.ts':
      "import { getUser } from './lib'; // REF\n" +
      'export function a(): string {\n' +
      '  const u = getUser(1); // REF\n' +
      '  const v = getUser(2); // REF\n' +
      '  return u + v;\n' +
      '}\n',
    'src/callerB.ts':
      "import { getUser } from './lib'; // REF\n" +
      'export function b(): string {\n' +
      '  return getUser(3); // REF\n' +
      '}\n',
    'src/callerDecoy.ts':
      "import { getUser } from './decoy'; // DECOY\n" +
      'export function c(): number {\n' +
      "  return getUser('x'); // DECOY\n" +
      '}\n',
  };
  const dir = fixture(files);
  const truth = new Set<string>();
  for (const [path, content] of Object.entries(files)) {
    content.split('\n').forEach((line, i) => {
      if (line.includes('// REF')) truth.add(`${path}:${i + 1}`);
    });
  }
  return { dir, truth };
}

const key = (r: Reference): string => `${r.file_path}:${r.line}`;

afterEach(async () => {
  for (const c of clients.splice(0)) {
    try {
      await c.stop();
    } catch {
      /* already stopped */
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

describe('ResolverClient exact references', () => {
  it('resolves type-based call sites with >=95% precision and labeled recall (decoy excluded)', async () => {
    const { dir, truth } = precisionFixture();
    const c = client();
    const result = await c.resolve(dir, {
      filePath: 'src/lib.ts',
      name: 'getUser',
      kind: 'function',
    });

    expect(result.precision).toBe('exact');
    const returned = new Set(result.references.filter((r) => !r.is_definition).map(key));
    const hit = new Set([...returned].filter((k) => truth.has(k)));
    const precision = returned.size === 0 ? 0 : hit.size / returned.size;
    const recall = truth.size === 0 ? 0 : hit.size / truth.size;

    expect(truth.size).toBeGreaterThan(0);
    expect(returned.size).toBeGreaterThan(0);
    expect(precision).toBeGreaterThanOrEqual(0.95);
    expect(recall).toBeGreaterThanOrEqual(0.95);

    // Type-based precision: the same-name decoy module's references are never returned.
    for (const r of result.references) {
      expect(r.file_path).not.toBe('src/decoy.ts');
      expect(r.file_path).not.toBe('src/callerDecoy.ts');
    }
    // The real call sites are present.
    expect(returned.has('src/callerA.ts:3')).toBe(true);
    expect(returned.has('src/callerA.ts:4')).toBe(true);
    expect(returned.has('src/callerB.ts:3')).toBe(true);
    // The declaration itself is reported as a definition.
    expect(result.references.some((r) => r.is_definition && r.file_path === 'src/lib.ts')).toBe(
      true,
    );
  });

  it('returns symbol_not_found for an unknown symbol', async () => {
    const { dir } = precisionFixture();
    const c = client();
    const result = await c.resolve(dir, { filePath: 'src/lib.ts', name: 'noSuchSymbol' });
    expect(result.note).toBe('symbol_not_found');
    expect(result.references).toEqual([]);
  });

  it('returns file_not_in_program for a file outside the program', async () => {
    const { dir } = precisionFixture();
    const c = client();
    const result = await c.resolve(dir, { filePath: 'src/missing.ts', name: 'getUser' });
    expect(result.note).toBe('file_not_in_program');
    expect(result.references).toEqual([]);
  });

  it('reports worker RSS and service count via stats', async () => {
    const { dir } = precisionFixture();
    const c = client();
    await c.resolve(dir, { filePath: 'src/lib.ts', name: 'getUser' });
    const stats = await c.stats();
    expect(stats.rss).toBeGreaterThan(0);
    expect(stats.heapUsed).toBeGreaterThan(0);
    expect(stats.services).toBe(1);
  });

  it('idle-evicts the worker and transparently restarts on the next request', async () => {
    const restarts = metrics.counter('weft_resolver_restarts_total', 'Resolver worker (re)starts');
    const { dir } = precisionFixture();
    const c = client({ idleTimeoutMs: 400 });
    const before = restarts.get();

    const first = await c.resolve(dir, { filePath: 'src/lib.ts', name: 'getUser' });
    expect(first.references.length).toBeGreaterThan(0);
    expect(restarts.get()).toBe(before + 1);

    // No activity for longer than the idle window: the worker self-evicts.
    await sleep(900);

    const second = await c.resolve(dir, { filePath: 'src/lib.ts', name: 'getUser' });
    expect(second.references.length).toBeGreaterThan(0);
    expect(restarts.get()).toBe(before + 2);
  });

  it('rejects with disabled when the resolver is turned off', async () => {
    const c = client({ enabled: false });
    await expect(
      c.resolve('/tmp/whatever', { filePath: 'a.ts', name: 'x' }),
    ).rejects.toBeInstanceOf(ResolverError);
    await expect(c.resolve('/tmp/whatever', { filePath: 'a.ts', name: 'x' })).rejects.toMatchObject(
      {
        code: 'disabled',
      },
    );
  });

  it('surfaces a per-request timeout as ResolverError timeout', async () => {
    const { dir } = precisionFixture();
    const c = client({ requestTimeoutMs: 1 });
    await expect(c.resolve(dir, { filePath: 'src/lib.ts', name: 'getUser' })).rejects.toMatchObject(
      {
        code: 'timeout',
      },
    );
  });
});
