import { fork, type ChildProcess } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { metrics, type Logger, type ResolverConfig } from '@weft/core';
import type { Reference } from './resolver-worker.js';

const resolveLatency = metrics.histogram(
  'weft_resolver_resolve_ms',
  'Exact reference resolution latency (ms)',
);
const resolveTotal = metrics.counter('weft_resolver_resolves_total', 'Exact resolution requests');
const restartTotal = metrics.counter('weft_resolver_restarts_total', 'Resolver worker (re)starts');

export interface ResolveSymbol {
  filePath: string;
  name: string;
  container?: string | undefined;
  kind?: string | undefined;
  startLine?: number | undefined;
}

export interface ReferenceResult {
  references: Reference[];
  precision: 'exact';
  rss?: number | undefined;
  note?: string | undefined;
}

export interface ResolverStats {
  rss: number;
  heapUsed: number;
  services: number;
}

export type ResolverErrorCode = 'disabled' | 'timeout' | 'crashed' | 'worker_error';

export class ResolverError extends Error {
  constructor(
    readonly code: ResolverErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ResolverError';
  }
}

interface Pending {
  resolve: (msg: WorkerMessage) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

interface WorkerMessage {
  id?: number;
  type?: string;
  ok?: boolean;
  references?: Reference[];
  precision?: 'exact';
  rss?: number;
  heapUsed?: number;
  services?: number;
  note?: string;
  error?: string;
}

/**
 * Daemon-side supervisor for the exact reference resolver. Forks a separate worker
 * process (own --max-old-space-size budget) on demand, multiplexes request/response
 * over IPC, enforces a per-request timeout, and transparently restarts after the
 * worker idle-evicts or crashes. The typed program never enters the daemon heap.
 */
export class ResolverClient {
  private child: ChildProcess | null = null;
  private starting: Promise<ChildProcess> | null = null;
  private readyResolve: (() => void) | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private stopped = false;

  constructor(
    private readonly config: ResolverConfig,
    private readonly logger?: Logger | undefined,
  ) {}

  private workerPath(): string {
    return join(dirname(fileURLToPath(import.meta.url)), 'resolver-worker.js');
  }

  private ensureChild(): Promise<ChildProcess> {
    if (this.child?.connected) return Promise.resolve(this.child);
    if (this.starting) return this.starting;
    this.starting = new Promise<ChildProcess>((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = fork(this.workerPath(), [], {
          execArgv: [`--max-old-space-size=${this.config.maxMemoryMb}`],
          env: { ...process.env, WEFT_RESOLVER_IDLE_MS: String(this.config.idleTimeoutMs) },
          stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        });
      } catch (err) {
        this.starting = null;
        reject(err instanceof Error ? err : new ResolverError('crashed', String(err)));
        return;
      }
      restartTotal.inc();
      this.readyResolve = () => {
        this.child = child;
        this.starting = null;
        this.readyResolve = null;
        resolve(child);
      };
      child.on('message', (raw: unknown) => this.onMessage(raw as WorkerMessage));
      child.on('exit', () => this.onExit());
      child.on('error', (err) => {
        this.starting = null;
        this.readyResolve = null;
        reject(new ResolverError('crashed', err.message));
      });
      child.stderr?.on('data', (d) => this.logger?.debug({ worker: 'resolver' }, String(d)));
      const t = setTimeout(() => {
        if (this.starting) {
          this.starting = null;
          this.readyResolve = null;
          try {
            child.kill();
          } catch {
            /* already gone */
          }
          reject(new ResolverError('crashed', 'resolver startup timeout'));
        }
      }, 15_000);
      t.unref?.();
    });
    return this.starting;
  }

  private onMessage(msg: WorkerMessage): void {
    if (msg.type === 'ready') {
      this.readyResolve?.();
      return;
    }
    const id = msg.id;
    if (typeof id !== 'number') return;
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    clearTimeout(p.timer);
    if (msg.ok) {
      p.resolve(msg);
    } else {
      p.reject(new ResolverError('worker_error', msg.error ?? 'resolver error'));
    }
  }

  private onExit(): void {
    this.child = null;
    this.starting = null;
    this.readyResolve = null;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new ResolverError('crashed', 'resolver worker exited'));
    }
    this.pending.clear();
  }

  private request<T>(payload: Record<string, unknown>, map: (msg: WorkerMessage) => T): Promise<T> {
    if (!this.config.enabled)
      return Promise.reject(new ResolverError('disabled', 'resolver disabled'));
    if (this.stopped) return Promise.reject(new ResolverError('crashed', 'resolver stopped'));
    return this.ensureChild().then(
      (child) =>
        new Promise<T>((resolve, reject) => {
          const id = this.nextId++;
          const timer = setTimeout(() => {
            this.pending.delete(id);
            reject(
              new ResolverError(
                'timeout',
                `resolver request timed out after ${this.config.requestTimeoutMs}ms`,
              ),
            );
          }, this.config.requestTimeoutMs);
          timer.unref?.();
          this.pending.set(id, {
            resolve: (msg) => resolve(map(msg)),
            reject,
            timer,
          });
          child.send({ id, ...payload }, (err) => {
            if (err) {
              this.pending.delete(id);
              clearTimeout(timer);
              reject(new ResolverError('crashed', err.message));
            }
          });
        }),
    );
  }

  async resolve(repoRoot: string, symbol: ResolveSymbol): Promise<ReferenceResult> {
    const started = performance.now();
    resolveTotal.inc();
    const result = await this.request<ReferenceResult>(
      {
        type: 'resolve',
        repoRoot,
        filePath: symbol.filePath,
        name: symbol.name,
        ...(symbol.container !== undefined ? { container: symbol.container } : {}),
        ...(symbol.kind !== undefined ? { kind: symbol.kind } : {}),
        ...(symbol.startLine !== undefined ? { startLine: symbol.startLine } : {}),
      },
      (msg) => ({
        references: msg.references ?? [],
        precision: 'exact',
        rss: msg.rss,
        note: msg.note,
      }),
    );
    resolveLatency.observe(performance.now() - started);
    return result;
  }

  async stats(): Promise<ResolverStats> {
    return this.request<ResolverStats>({ type: 'stats' }, (msg) => ({
      rss: msg.rss ?? 0,
      heapUsed: msg.heapUsed ?? 0,
      services: msg.services ?? 0,
    }));
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const child = this.child;
    this.child = null;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new ResolverError('crashed', 'resolver stopped'));
    }
    this.pending.clear();
    if (child?.connected) {
      try {
        child.send({ id: 0, type: 'shutdown' });
      } catch {
        /* ignore */
      }
      setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* already gone */
        }
      }, 500).unref?.();
    }
  }
}
