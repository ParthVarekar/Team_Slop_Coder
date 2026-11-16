import { describe, expect, it } from 'vitest';
import { MetricsRegistry, Counter, Gauge, Histogram } from '@weft/core';

describe('metrics', () => {
  it('counter increments and resets', () => {
    const c = new Counter('c');
    c.inc();
    c.inc(4);
    expect(c.get()).toBe(5);
    c.reset();
    expect(c.get()).toBe(0);
  });

  it('gauge sets and adds', () => {
    const g = new Gauge('g');
    g.set(10);
    g.add(-3);
    expect(g.get()).toBe(7);
  });

  it('histogram computes bounded percentiles', () => {
    const h = new Histogram('h', '', [1, 10, 100, Infinity]);
    for (let i = 0; i < 100; i++) h.observe(i);
    const snap = h.snapshot();
    expect(snap.count).toBe(100);
    expect(snap.p50).toBeGreaterThan(0);
    expect(snap.p95).toBeGreaterThanOrEqual(snap.p50);
    expect(snap.buckets[snap.buckets.length - 1]?.count).toBe(100);
  });

  it('registry returns stable instances and snapshots', () => {
    const reg = new MetricsRegistry();
    const c1 = reg.counter('x');
    const c2 = reg.counter('x');
    expect(c1).toBe(c2);
    c1.inc(2);
    reg.gauge('g').set(1);
    reg.histogram('h').observe(5);
    const snap = reg.snapshot();
    expect(snap.counters.x).toBe(2);
    expect(snap.gauges.g).toBe(1);
    expect(snap.histograms.h?.count).toBe(1);
  });
});
