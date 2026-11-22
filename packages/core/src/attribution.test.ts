import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  failureFingerprint,
  rankSuspects,
  type AttributionInput,
  type SuspectChange,
} from '@weft/core';

function oid(label: string): string {
  return createHash('sha1').update(label).digest('hex');
}

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const BASE_TIME = Date.parse('2026-01-01T00:00:00Z');

/**
 * A planted regression: a culprit commit touches the broken module + its test
 * (overlap 2), surrounded by noise commits touching unrelated files (overlap 0)
 * or only the test (overlap 1). Every 10th fixture adds an equal-overlap noise
 * commit NEWER than the culprit — genuinely ambiguous by path alone, resolved
 * only by a revert-test. Those 4/40 are the expected ranking misses.
 */
function fixture(i: number): { culprit: string; ambiguous: boolean; input: AttributionInput } {
  const rnd = lcg(i + 1);
  const mod = `src/mod${i}.ts`;
  const test = `src/mod${i}.test.ts`;
  const failingChecks = [{ check_id: `test-mod${i}`, paths: [mod, test] }];
  const culpritOid = oid(`culprit-${i}`);
  const culpritTime = BASE_TIME + Math.floor(rnd() * 1000) * 60_000;
  const changes: SuspectChange[] = [
    {
      oid: culpritOid,
      subject: `break mod${i}`,
      author_name: 'dev',
      authored_at: new Date(culpritTime).toISOString(),
      paths: [mod, test],
      task_id: `task-${i}`,
    },
  ];
  const noiseCount = 5 + Math.floor(rnd() * 10);
  for (let j = 0; j < noiseCount; j++) {
    const t = BASE_TIME + Math.floor(rnd() * 2000) * 60_000;
    const overlapOne = rnd() < 0.3;
    changes.push({
      oid: oid(`noise-${i}-${j}`),
      subject: `noise ${j}`,
      author_name: 'dev',
      authored_at: new Date(t).toISOString(),
      paths: overlapOne ? [test] : [`src/other${i}_${j}.ts`],
    });
  }
  const ambiguous = i % 10 === 9;
  if (ambiguous) {
    changes.push({
      oid: oid(`ambiguous-${i}`),
      subject: 'equal overlap, newer',
      author_name: 'dev',
      authored_at: new Date(culpritTime + 5_000_000).toISOString(),
      paths: [mod, test],
    });
  }
  return { culprit: culpritOid, ambiguous, input: { changes, failingChecks } };
}

describe('rankSuspects planted-regression fixture suite', () => {
  it('ranks the true culprit first in >=90% of 40 planted regressions', () => {
    let correct = 0;
    const misses: number[] = [];
    for (let i = 0; i < 40; i++) {
      const { culprit, ambiguous, input } = fixture(i);
      const ranked = rankSuspects(input);
      if (ranked[0]?.oid === culprit) correct++;
      else misses.push(i);
      // The only acceptable misses are the deliberately ambiguous fixtures.
      if (ranked[0]?.oid !== culprit) expect(ambiguous).toBe(true);
    }
    expect(correct / 40).toBeGreaterThanOrEqual(0.9);
    expect(misses.every((i) => i % 10 === 9)).toBe(true);
  });

  it('is deterministic and independent of input order', () => {
    const { input } = fixture(3);
    const a = rankSuspects(input);
    const b = rankSuspects(input);
    expect(a).toEqual(b);
    const shuffled = rankSuspects({ ...input, changes: [...input.changes].reverse() });
    expect(shuffled).toEqual(a);
    expect(a.map((r) => r.rank)).toEqual(a.map((_, i) => i + 1));
  });

  it('breaks equal-overlap ties by recency (newer commit ranks first)', () => {
    const paths = ['src/a.ts'];
    const older: SuspectChange = {
      oid: oid('older'),
      subject: 'older',
      author_name: 'dev',
      authored_at: new Date(BASE_TIME).toISOString(),
      paths,
    };
    const newer: SuspectChange = {
      oid: oid('newer'),
      subject: 'newer',
      author_name: 'dev',
      authored_at: new Date(BASE_TIME + 60_000).toISOString(),
      paths,
    };
    const ranked = rankSuspects({
      changes: [older, newer],
      failingChecks: [{ check_id: 't', paths }],
    });
    expect(ranked[0]?.oid).toBe(newer.oid);
    expect(ranked[0]?.overlap).toBe(1);
    expect(ranked[1]?.oid).toBe(older.oid);
  });

  it('reports matched paths and task attribution for the top suspect', () => {
    const { culprit, input } = fixture(7);
    const top = rankSuspects(input)[0];
    expect(top?.oid).toBe(culprit);
    expect(top?.task_id).toBe('task-7');
    expect(top?.overlap).toBe(2);
    expect(top?.matched_paths.sort()).toEqual(['src/mod7.test.ts', 'src/mod7.ts']);
  });

  it('sweeps 40 changes well under the 2s attribution budget', () => {
    const changes: SuspectChange[] = Array.from({ length: 40 }, (_, i) => ({
      oid: oid(`perf-${i}`),
      subject: `change ${i}`,
      author_name: 'dev',
      authored_at: new Date(BASE_TIME + i * 60_000).toISOString(),
      paths: Array.from({ length: 20 }, (_, j) => `src/f${i}_${j}.ts`),
      task_id: `task-${i}`,
    }));
    const failingChecks = Array.from({ length: 5 }, (_, i) => ({
      check_id: `check-${i}`,
      paths: Array.from({ length: 10 }, (_, j) => `src/f${i}_${j}.ts`),
    }));
    const started = performance.now();
    const ranked = rankSuspects({ changes, failingChecks });
    const elapsed = performance.now() - started;
    expect(ranked).toHaveLength(40);
    expect(elapsed).toBeLessThan(2000);
  });
});

describe('failureFingerprint', () => {
  it('is order-independent and deduplicates check ids', () => {
    expect(failureFingerprint(['b', 'a', 'a'])).toBe(failureFingerprint(['a', 'b']));
  });

  it('distinguishes different failing sets', () => {
    expect(failureFingerprint(['a', 'b'])).not.toBe(failureFingerprint(['a', 'c']));
    expect(failureFingerprint(['a'])).toMatch(/^[0-9a-f]{32}$/);
  });
});