import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@weft/protocol': r('./packages/protocol/src/index.ts'),
      '@weft/core': r('./packages/core/src/index.ts'),
      '@weft/adapter-claude-code': r('./adapters/claude-code/src/index.ts'),
      '@weft/adapter-codex': r('./adapters/codex/src/index.ts'),
      '@weft/adapter-opencode': r('./adapters/opencode/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    // Integration-heavy suite: real git subprocesses + embedded Postgres clusters
    // run in parallel, so individual tests need headroom against CPU/disk contention.
    testTimeout: 30_000,
    hookTimeout: 120_000,
    include: [
      'packages/**/src/**/*.test.ts',
      'apps/**/src/**/*.test.ts',
      'adapters/**/src/**/*.test.ts',
      'bench/**/*.test.ts',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['packages/**/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/index.ts'],
    },
  },
});
