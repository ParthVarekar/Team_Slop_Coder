import { performance } from 'node:perf_hooks';
import { Histogram } from '@weft/core';

export interface BenchResult {
  name: string;
  iterations: number;
  totalMs: number;
  opsPerSec: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  unit: string;
}

/**
 * Time `iterations` calls of `fn`, recording per-call latency. `scale` converts
 * call-rate to logical op-rate (e.g. 100 events per batch insert call).
 */
export function measure(
  name: string,
  iterations: number,
  fn: (i: number) => void,
  options: { scale?: number; unit?: string } = {},
): BenchResult {
  const scale = options.scale ?? 1;
  const hist = new Histogram(name);
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    fn(i);
    hist.observe(performance.now() - t0);
  }
  const totalMs = performance.now() - start;
  const snap = hist.snapshot();
  return {
    name,
    iterations,
    totalMs,
    opsPerSec: (iterations * scale) / (totalMs / 1000),
    p50Ms: snap.p50,
    p95Ms: snap.p95,
    p99Ms: snap.p99,
    unit: options.unit ?? 'ops/s',
  };
}
