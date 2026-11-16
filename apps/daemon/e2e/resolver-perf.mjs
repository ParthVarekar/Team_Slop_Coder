// M3.3 acceptance gate: exact reference resolver process RSS at 10k files.
// findReferences is a whole-program scan, so a single resolve materializes the
// typed program across every file. Run with the daemon built (dist present):
//   node apps/daemon/e2e/resolver-perf.mjs
// Override size with WEFT_RESOLVER_FILES (default 10000).
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ResolverClient } from '../dist/resolver.js';

const FILE_COUNT = Number(process.env.WEFT_RESOLVER_FILES ?? 10_000);
const MEM_GATE_MB = 1024;
const RESOLVE_SANITY_MS = 120_000;
const mb = (bytes) => bytes / 1024 / 1024;

const dir = mkdtempSync(join(tmpdir(), 'weft-resolver-perf-'));
const client = new ResolverClient({
  enabled: true,
  maxMemoryMb: 1024,
  idleTimeoutMs: 600_000,
  requestTimeoutMs: 120_000,
});

try {
  mkdirSync(join(dir, 'src'), { recursive: true });
  const tGen = performance.now();
  for (let i = 0; i < FILE_COUNT; i++) {
    writeFileSync(
      join(dir, 'src', `mod${i}.ts`),
      `export function fn${i}(x: number): number {\n  return x + ${i};\n}\n`,
    );
  }
  const genMs = performance.now() - tGen;

  const tResolve = performance.now();
  const result = await client.resolve(dir, { filePath: 'src/mod0.ts', name: 'fn0', kind: 'function' });
  const resolveMs = performance.now() - tResolve;
  assert.ok(result.references.length >= 1, 'expected at least the fn0 definition');
  assert.ok(resolveMs <= RESOLVE_SANITY_MS, `first resolve ${resolveMs.toFixed(0)}ms exceeds sanity gate`);

  // Exercise the warm program across the repo (early, middle, late files).
  for (const i of [1, 2, 3, Math.floor(FILE_COUNT / 2), FILE_COUNT - 1]) {
    await client.resolve(dir, { filePath: `src/mod${i}.ts`, name: `fn${i}`, kind: 'function' });
  }

  const stats = await client.stats();
  const rssMb = mb(stats.rss);
  assert.ok(
    rssMb <= MEM_GATE_MB,
    `resolver RSS ${rssMb.toFixed(1)}MB exceeds ${MEM_GATE_MB}MB gate @${FILE_COUNT} files`,
  );

  console.log(
    JSON.stringify(
      {
        fileCount: FILE_COUNT,
        fixtureGenMs: +genMs.toFixed(0),
        firstResolveMs: +resolveMs.toFixed(0),
        references: result.references.length,
        resolverRssMb: +rssMb.toFixed(1),
        resolverHeapMb: +mb(stats.heapUsed).toFixed(1),
        services: stats.services,
        gates: { memMb: MEM_GATE_MB, resolveSanityMs: RESOLVE_SANITY_MS },
      },
      null,
      2,
    ),
  );
  console.log('resolver perf gates: PASS');
} finally {
  await client.stop();
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}