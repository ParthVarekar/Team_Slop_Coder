/**
 * Minimal in-process metrics. Bounded memory, no external dependency, cheap
 * enough for hot paths (counter increment / histogram bucket bump only).
 */

export class Counter {
  private value = 0;
  constructor(
    readonly name: string,
    readonly help = '',
  ) {}
  inc(delta = 1): void {
    this.value += delta;
  }
  get(): number {
    return this.value;
  }
  reset(): void {
    this.value = 0;
  }
}

export class Gauge {
  private value = 0;
  constructor(
    readonly name: string,
    readonly help = '',
  ) {}
  set(value: number): void {
    this.value = value;
  }
  add(delta: number): void {
    this.value += delta;
  }
  get(): number {
    return this.value;
  }
}

const DEFAULT_BUCKETS = [
  0.1,
  0.5,
  1,
  2,
  5,
  10,
  25,
  50,
  100,
  250,
  500,
  1000,
  2500,
  5000,
  10000,
  Infinity,
];

export interface HistogramSnapshot {
  count: number;
  sum: number;
  p50: number;
  p95: number;
  p99: number;
  buckets: { le: number; count: number }[];
}

export class Histogram {
  private readonly bounds: number[];
  private readonly counts: number[];
  private count = 0;
  private sum = 0;

  constructor(
    readonly name: string,
    readonly help = '',
    buckets: number[] = DEFAULT_BUCKETS,
  ) {
    this.bounds = [...buckets].sort((a, b) => a - b);
    this.counts = new Array<number>(this.bounds.length).fill(0);
  }

  observe(value: number): void {
    this.count += 1;
    this.sum += value;
    for (let i = 0; i < this.bounds.length; i++) {
      if (value <= (this.bounds[i] as number)) {
        this.counts[i] = (this.counts[i] as number) + 1;
        return;
      }
    }
  }

  private percentile(p: number): number {
    if (this.count === 0) return 0;
    const target = (p / 100) * this.count;
    let cumulative = 0;
    for (let i = 0; i < this.bounds.length; i++) {
      cumulative += this.counts[i] as number;
      if (cumulative >= target) {
        const upper = this.bounds[i] as number;
        return Number.isFinite(upper) ? upper : this.sum / this.count;
      }
    }
    return this.sum / this.count;
  }

  snapshot(): HistogramSnapshot {
    let cumulative = 0;
    const buckets = this.bounds.map((le, i) => {
      cumulative += this.counts[i] as number;
      return { le, count: cumulative };
    });
    return {
      count: this.count,
      sum: this.sum,
      p50: this.percentile(50),
      p95: this.percentile(95),
      p99: this.percentile(99),
      buckets,
    };
  }

  reset(): void {
    this.count = 0;
    this.sum = 0;
    this.counts.fill(0);
  }
}

export type Metric = Counter | Gauge | Histogram;

export interface MetricsSnapshot {
  counters: Record<string, number>;
  gauges: Record<string, number>;
  histograms: Record<string, HistogramSnapshot>;
}

export class MetricsRegistry {
  private readonly metrics = new Map<string, Metric>();

  counter(name: string, help = ''): Counter {
    return this.getOrCreate(name, () => new Counter(name, help)) as Counter;
  }
  gauge(name: string, help = ''): Gauge {
    return this.getOrCreate(name, () => new Gauge(name, help)) as Gauge;
  }
  histogram(name: string, help = '', buckets?: number[]): Histogram {
    return this.getOrCreate(name, () => new Histogram(name, help, buckets)) as Histogram;
  }

  private getOrCreate(name: string, factory: () => Metric): Metric {
    let metric = this.metrics.get(name);
    if (!metric) {
      metric = factory();
      this.metrics.set(name, metric);
    }
    return metric;
  }

  snapshot(): MetricsSnapshot {
    const counters: Record<string, number> = {};
    const gauges: Record<string, number> = {};
    const histograms: Record<string, HistogramSnapshot> = {};
    for (const metric of this.metrics.values()) {
      if (metric instanceof Counter) counters[metric.name] = metric.get();
      else if (metric instanceof Gauge) gauges[metric.name] = metric.get();
      else histograms[metric.name] = metric.snapshot();
    }
    return { counters, gauges, histograms };
  }
}

/** Process-wide default registry. */
export const metrics = new MetricsRegistry();
