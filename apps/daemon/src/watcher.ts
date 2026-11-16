import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createAutoWip,
  headOid,
  statusPorcelain,
  type AutoWipResult,
  type Logger,
} from '@weft/core';
import type { Actor } from '@weft/protocol';
import type { EventDraft } from './events.js';
import type { EnqueueResult } from './pipeline.js';
import { RepoError, RepoRegistry, type RepoRecord } from './repos.js';

export interface WatchSubscription {
  close(): Promise<void> | void;
}

export interface WatchBackend {
  readonly name: 'parcel' | 'poll';
  subscribe(dir: string, onHint: () => void): Promise<WatchSubscription>;
}

interface ParcelSubscription {
  unsubscribe(): Promise<void>;
}
interface ParcelModule {
  subscribe(
    dir: string,
    fn: (err: Error | null, events: unknown[]) => void,
    opts?: { ignore?: string[] },
  ): Promise<ParcelSubscription>;
}

/** Native fs hints (best-effort) + a safety poll; git status remains the truth. */
export class ParcelBackend implements WatchBackend {
  readonly name = 'parcel' as const;
  constructor(
    private readonly mod: ParcelModule,
    private readonly pollMs: number,
  ) {}

  async subscribe(dir: string, onHint: () => void): Promise<WatchSubscription> {
    const sub = await this.mod.subscribe(
      dir,
      (err, events) => {
        // On overflow/error, fall through to a reconcile (git status = truth).
        if (err || events.length > 0) onHint();
      },
      { ignore: ['**/.git/**', '**/node_modules/**', '**/dist/**'] },
    );
    const timer = setInterval(onHint, this.pollMs);
    timer.unref?.();
    return {
      close: async () => {
        clearInterval(timer);
        await sub.unsubscribe();
      },
    };
  }
}

/** Zero-native-dependency fallback: reconcile on a fixed interval. */
export class PollBackend implements WatchBackend {
  readonly name = 'poll' as const;
  constructor(private readonly pollMs: number) {}

  async subscribe(_dir: string, onHint: () => void): Promise<WatchSubscription> {
    const timer = setInterval(onHint, this.pollMs);
    timer.unref?.();
    return { close: () => clearInterval(timer) };
  }
}

/** Load @parcel/watcher if present; otherwise poll. Optional native dep. */
export async function detectBackend(pollMs: number, logger?: Logger): Promise<WatchBackend> {
  try {
    // Non-literal specifier keeps this optional dep out of static type resolution.
    const specifier = '@parcel/watcher';
    const mod = (await import(specifier)) as { default?: ParcelModule } & ParcelModule;
    const resolved = mod.default ?? mod;
    if (typeof resolved.subscribe !== 'function') throw new Error('subscribe missing');
    return new ParcelBackend(resolved, pollMs);
  } catch (err) {
    logger?.info({ err }, '@parcel/watcher unavailable; using polling backend');
    return new PollBackend(pollMs);
  }
}

export interface WatcherDeps {
  registry: RepoRegistry;
  emit: (draft: EventDraft) => EnqueueResult;
  actor: Actor;
  binary?: string | undefined;
  logger?: Logger | undefined;
  /** Trailing debounce for fs hints (contract: <= 2s). */
  debounceMs?: number;
  /** Hard cap so continuous churn cannot starve reconciliation. */
  maxWaitMs?: number;
  /** Poll interval / parcel safety-net interval. */
  pollMs?: number;
  /** Minimum spacing between automatic WIP snapshots. */
  wipIntervalMs?: number;
  autoWip?: boolean;
  /** Backend override (tests inject a fake). */
  backend?: WatchBackend | undefined;
}

export interface ReconcileResult {
  emitted: number;
  dirty: number;
  wip: AutoWipResult | null;
}

interface RepoWatchState {
  repo: RepoRecord;
  sub: WatchSubscription | null;
  timer: NodeJS.Timeout | null;
  firstHintAt: number | null;
  lastWipAt: number | null;
}

const MAX_HASH_BYTES = 16 * 1024 * 1024;

async function hashFile(path: string): Promise<string | null> {
  try {
    const st = await stat(path);
    if (!st.isFile() || st.size > MAX_HASH_BYTES) return null;
    const buf = await readFile(path);
    return createHash('sha256').update(buf).digest('hex');
  } catch {
    return null;
  }
}

/**
 * Watches registered repositories: native/poll hints trigger a debounced git
 * status reconciliation (the source of truth), emitting file.changed only for
 * newly-dirty or content-changed paths, and periodically snapshotting uncommitted
 * work to a hidden device-namespaced auto-WIP ref. Per-repo work is serialized.
 */
export class Watcher {
  private readonly registry: RepoRegistry;
  private readonly emit: (draft: EventDraft) => EnqueueResult;
  private readonly actor: Actor;
  private readonly binary: string | undefined;
  private readonly logger: Logger | undefined;
  private readonly debounceMs: number;
  private readonly maxWaitMs: number;
  private readonly pollMs: number;
  private readonly wipIntervalMs: number;
  private readonly autoWip: boolean;
  private readonly injectedBackend: WatchBackend | undefined;

  private backend: WatchBackend | null = null;
  private readonly states = new Map<string, RepoWatchState>();
  private readonly chains = new Map<string, Promise<unknown>>();
  private stopped = false;

  constructor(deps: WatcherDeps) {
    this.registry = deps.registry;
    this.emit = deps.emit;
    this.actor = deps.actor;
    this.binary = deps.binary;
    this.logger = deps.logger;
    this.debounceMs = deps.debounceMs ?? 1500;
    this.maxWaitMs = deps.maxWaitMs ?? 5000;
    this.pollMs = deps.pollMs ?? 3000;
    this.wipIntervalMs = deps.wipIntervalMs ?? 60_000;
    this.autoWip = deps.autoWip ?? true;
    this.injectedBackend = deps.backend;
  }

  get backendName(): 'parcel' | 'poll' | null {
    return this.backend?.name ?? null;
  }

  get watched(): string[] {
    return [...this.states.keys()];
  }

  private async getBackend(): Promise<WatchBackend> {
    if (this.injectedBackend) return (this.backend = this.injectedBackend);
    if (!this.backend) this.backend = await detectBackend(this.pollMs, this.logger);
    return this.backend;
  }

  /** Watch all active repos (full rescan baseline). Called on daemon start. */
  async start(): Promise<void> {
    if (this.stopped) return;
    for (const repo of this.registry.list({ state: 'active' })) {
      await this.watch(repo);
    }
  }

  async watch(repo: RepoRecord): Promise<void> {
    if (this.stopped || this.states.has(repo.repo_id)) return;
    const backend = await this.getBackend();
    const state: RepoWatchState = {
      repo,
      sub: null,
      timer: null,
      firstHintAt: null,
      lastWipAt: repo.last_wip_at ? Date.parse(repo.last_wip_at) : null,
    };
    this.states.set(repo.repo_id, state);
    let sub: WatchSubscription;
    let actualName: 'parcel' | 'poll' = backend.name;
    try {
      sub = await backend.subscribe(repo.root_path, () => this.hint(repo.repo_id));
    } catch (err) {
      this.logger?.warn(
        { err, repo: repo.repo_id },
        'native subscribe failed; falling back to poll',
      );
      const fallback = new PollBackend(this.pollMs);
      sub = await fallback.subscribe(repo.root_path, () => this.hint(repo.repo_id));
      actualName = 'poll';
    }
    state.sub = sub;
    state.repo = { ...repo, watcher_backend: actualName };
    if (repo.watcher_backend !== actualName) this.registry.setBackend(repo.repo_id, actualName);
    await this.reconcile(repo.repo_id);
  }

  async unwatch(repoId: string): Promise<void> {
    const state = this.states.get(repoId);
    if (!state) return;
    if (state.timer) clearTimeout(state.timer);
    this.states.delete(repoId);
    await state.sub?.close();
  }

  /** Force a reconciliation now (API scan). Serialized per repo. */
  async reconcile(repoId: string): Promise<ReconcileResult> {
    return this.serialize(repoId, () => {
      const repo = this.requireRepo(repoId);
      return this.reconcileOnce(repo);
    });
  }

  /** Force an auto-WIP snapshot now (API). Serialized per repo. */
  async snapshotWip(repoId: string): Promise<AutoWipResult | null> {
    return this.serialize(repoId, () => this.wipOnce(this.requireRepo(repoId)));
  }

  async scanAll(): Promise<ReconcileResult[]> {
    const results: ReconcileResult[] = [];
    for (const repoId of this.states.keys()) results.push(await this.reconcile(repoId));
    return results;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const repoId of [...this.states.keys()]) await this.unwatch(repoId);
    this.chains.clear();
  }

  private requireRepo(repoId: string): RepoRecord {
    const repo = this.states.get(repoId)?.repo ?? this.registry.get(repoId);
    if (!repo) throw new RepoError('not_found', `unknown repo: ${repoId}`);
    return repo;
  }

  private serialize<T>(repoId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(repoId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.chains.set(
      repoId,
      next.catch(() => undefined),
    );
    return next;
  }

  private hint(repoId: string): void {
    const state = this.states.get(repoId);
    if (!state || this.stopped) return;
    const now = Date.now();
    if (state.firstHintAt === null) state.firstHintAt = now;
    if (state.timer) clearTimeout(state.timer);
    const delay = Math.max(
      0,
      Math.min(this.debounceMs, this.maxWaitMs - (now - state.firstHintAt)),
    );
    state.timer = setTimeout(() => {
      state.timer = null;
      state.firstHintAt = null;
      void this.reconcile(repoId).catch((err) =>
        this.logger?.warn({ err, repo: repoId }, 'reconcile failed'),
      );
    }, delay);
    state.timer.unref?.();
  }

  private async reconcileOnce(repo: RepoRecord): Promise<ReconcileResult> {
    const files = await statusPorcelain(repo.root_path, this.binary);
    const hashes = new Map<string, string | null>();
    for (const f of files) {
      hashes.set(
        f.path,
        f.changeKind === 'delete' ? null : await hashFile(join(repo.root_path, f.path)),
      );
    }
    const previous = new Map(this.registry.getFileState(repo.repo_id).map((s) => [s.path, s]));
    let emitted = 0;
    for (const f of files) {
      const prev = previous.get(f.path);
      const newHash = hashes.get(f.path) ?? null;
      const changed =
        !prev ||
        prev.change_kind !== f.changeKind ||
        prev.untracked !== f.untracked ||
        (newHash !== null && prev.content_hash !== newHash);
      if (!changed) continue;
      this.emit({
        type: 'file.changed',
        actor: this.actor,
        repoId: repo.repo_id,
        privacy: 'metadata',
        payload: {
          path: f.path,
          change_kind: f.changeKind,
          source: 'watcher',
          ...(prev?.content_hash ? { old_hash: prev.content_hash } : {}),
          ...(newHash ? { new_hash: newHash } : {}),
        },
      });
      emitted++;
    }
    this.registry.replaceFileState(repo.repo_id, RepoRegistry.toFileState(files, hashes));
    this.registry.recordScan(repo.repo_id, await headOid(repo.root_path, this.binary));

    let wip: AutoWipResult | null = null;
    const state = this.states.get(repo.repo_id);
    if (this.autoWip && files.length > 0) {
      const last = state?.lastWipAt ?? 0;
      if (Date.now() - last >= this.wipIntervalMs) wip = await this.wipOnce(repo);
    }
    return { emitted, dirty: files.length, wip };
  }

  private async wipOnce(repo: RepoRecord): Promise<AutoWipResult | null> {
    const message = `Weft auto-WIP ${repo.name} ${new Date().toISOString()}`;
    const result = await createAutoWip(repo.root_path, repo.wip_ref, message, this.binary);
    if (result) {
      this.registry.recordWip(repo.repo_id, result.commit);
      const state = this.states.get(repo.repo_id);
      if (state) {
        state.lastWipAt = Date.now();
        state.repo = {
          ...state.repo,
          last_wip_oid: result.commit,
          last_wip_at: new Date().toISOString(),
        };
      }
    }
    return result;
  }
}
