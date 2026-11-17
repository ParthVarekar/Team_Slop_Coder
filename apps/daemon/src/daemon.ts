import { hostname, platform, release } from 'node:os';
import { join } from 'node:path';
import {
  loadWeftConfig,
  createLogger,
  detectGitCapabilities,
  redactor,
  type WeftConfig,
  type Logger,
  type GitCapabilities,
} from '@weft/core';
import { makeId, type Actor, type StoredEvent } from '@weft/protocol';
import { LocalStore, type StoredLocalEvent } from './store.js';
import { EventPipeline, type EnqueueResult } from './pipeline.js';
import { LocalTaskStore } from './tasks.js';
import { loadOrCreateIdentity, type DeviceIdentity } from './identity.js';
import { draftEvent, type EventSource } from './events.js';
import { RepoRegistry, type RepoRecord } from './repos.js';
import { Watcher } from './watcher.js';
import { WorktreeManager } from './worktrees.js';
import { ConflictDetector } from './conflicts.js';
import { ValidationSupervisor } from './validation.js';
import { OutboxShipper } from './shipper.js';
import { CoordinationClient } from './coordination.js';
import { EnforcementCache } from './enforcement.js';
import { TaskCache } from './task-cache.js';
import { ChangeCache } from './change-cache.js';
import { CoordinationRpc } from './coordination-rpc.js';
import { DaemonMcpBackend } from './mcp-backend.js';
import { Indexer } from './indexer.js';
import { OverlapEngine } from './overlap.js';
import { ResolverClient } from './resolver.js';
import { ModuleGraphService } from './module-graph.js';

const DAEMON_VERSION = '0.0.0';

export type FlushListener = (events: StoredLocalEvent[]) => void;

export interface DaemonOptions {
  config?: WeftConfig;
  onFlush?: FlushListener;
}

/**
 * Per-machine daemon: owns config, identity, the local store, the ingest
 * pipeline and the local task store. Offline-capable; team mode additionally
 * fills the outbox for the shipper (M2). The API server and watcher attach here.
 */
export class Daemon {
  readonly config: WeftConfig;
  readonly logger: Logger;
  readonly identity: DeviceIdentity;
  readonly store: LocalStore;
  readonly pipeline: EventPipeline;
  readonly tasks: LocalTaskStore;
  readonly repos: RepoRegistry;
  readonly indexer: Indexer;
  readonly overlap: OverlapEngine;
  readonly resolver: ResolverClient;
  readonly moduleGraph: ModuleGraphService;
  readonly watcher: Watcher;
  readonly worktrees: WorktreeManager;
  readonly conflicts: ConflictDetector;
  readonly validation: ValidationSupervisor;
  readonly source: EventSource;
  readonly actor: Actor;
  /** Team-mode sync: null in solo mode or when no server url/token is configured. */
  readonly enforcement: EnforcementCache | null = null;
  readonly taskCache: TaskCache | null = null;
  readonly shipper: OutboxShipper | null = null;
  readonly coordination: CoordinationClient | null = null;
  readonly changeCache: ChangeCache | null = null;
  readonly rpc: CoordinationRpc | null = null;
  /** MCP coordination backend (always present; team mutations use rpc when configured). */
  readonly mcp: DaemonMcpBackend;
  gitCapabilities: GitCapabilities | null = null;

  private readonly flushListeners = new Set<FlushListener>();
  private readonly coordinationListeners = new Set<(event: StoredEvent) => void>();
  private readonly sessionCache = new Map<string, string>();
  private started = false;

  constructor(options: DaemonOptions = {}) {
    this.config = options.config ?? loadWeftConfig();
    this.logger = createLogger({ level: this.config.logLevel, name: 'weft-daemon' });
    this.identity = loadOrCreateIdentity(this.config.dataDir, {
      deviceId: this.config.server.deviceId,
      projectId: this.config.server.projectId,
    });
    this.store = LocalStore.open(this.config.dataDir);
    if (options.onFlush) this.flushListeners.add(options.onFlush);
    this.pipeline = new EventPipeline(this.store, {
      teamMode: this.config.mode === 'team',
      ...(this.config.privacy.redactSecrets ? { redactor } : {}),
      logger: this.logger,
      onFlush: (events) => {
        for (const listener of this.flushListeners) listener(events);
      },
    });
    this.source = { deviceId: this.identity.device_id, projectId: this.identity.project_id };
    this.actor = { user_id: this.identity.user_id, agent: null };
    this.tasks = new LocalTaskStore(this.store.db, {
      source: this.source,
      actor: this.actor,
      emit: (event) => {
        this.pipeline.enqueue(event);
      },
    });
    this.repos = new RepoRegistry(this.store.db, {
      deviceId: this.identity.device_id,
      projectId: this.identity.project_id,
      binary: this.config.git.binary,
    });
    this.indexer = new Indexer({
      registry: this.repos,
      store: this.store,
      binary: this.config.git.binary,
      logger: this.logger,
    });
    this.overlap = new OverlapEngine({
      deviceId: this.identity.device_id,
      registry: this.repos,
      store: this.store,
      indexer: this.indexer,
      actor: this.actor,
      emit: (draft) => this.pipeline.enqueue(draftEvent(this.source, draft)),
      logger: this.logger,
    });
    this.resolver = new ResolverClient(this.config.resolver, this.logger);
    this.moduleGraph = new ModuleGraphService({ registry: this.repos, logger: this.logger });
    this.watcher = new Watcher({
      registry: this.repos,
      actor: this.actor,
      binary: this.config.git.binary,
      logger: this.logger,
      emit: (draft) => this.pipeline.enqueue(draftEvent(this.source, draft)),
      onReconcile: async (repoId, changed, deleted) => {
        await this.indexer.invalidate(repoId, changed, deleted);
      },
    });
    this.worktrees = new WorktreeManager(this.store.db, {
      deviceId: this.identity.device_id,
      projectId: this.identity.project_id,
      worktreeRoot: join(this.config.dataDir, 'worktrees'),
      registry: this.repos,
      actor: this.actor,
      binary: this.config.git.binary,
      logger: this.logger,
      emit: (draft) => this.pipeline.enqueue(draftEvent(this.source, draft)),
    });
    this.conflicts = new ConflictDetector({
      deviceId: this.identity.device_id,
      projectId: this.identity.project_id,
      registry: this.repos,
      actor: this.actor,
      binary: this.config.git.binary,
      logger: this.logger,
      emit: (draft) => this.pipeline.enqueue(draftEvent(this.source, draft)),
    });
    this.validation = new ValidationSupervisor(this.store.db, {
      deviceId: this.identity.device_id,
      projectId: this.identity.project_id,
      worktreeRoot: join(this.config.dataDir, 'worktrees'),
      registry: this.repos,
      actor: this.actor,
      validation: this.config.validation,
      binary: this.config.git.binary,
      logger: this.logger,
      emit: (draft) => this.pipeline.enqueue(draftEvent(this.source, draft)),
    });

    const { url, token } = this.config.server;
    if (this.config.mode === 'team' && url && token) {
      this.enforcement = new EnforcementCache();
      this.changeCache = new ChangeCache();
      this.taskCache = new TaskCache({
        onClaimRejected: (rejection) => {
          this.logger.warn(
            { taskId: rejection.task_id, provisional: rejection.provisional, winner: rejection.winner_claimant },
            'task claim rejected; discarding quarantined worktree (work preserved in WIP ref)',
          );
          void this.worktrees
            .discardQuarantine(rejection.task_id)
            .then((result) => {
              this.taskCache?.clearClaimRejection(rejection.task_id);
              this.logger.info(
                {
                  taskId: rejection.task_id,
                  discarded: result.discarded,
                  wip: result.wip.map((w) => w.ref),
                },
                'quarantined worktree discarded',
              );
            })
            .catch((err) => {
              this.logger.error({ err, taskId: rejection.task_id }, 'quarantine discard failed');
            });
        },
      });
      this.shipper = new OutboxShipper({
        baseUrl: url,
        token,
        store: this.store,
        logger: this.logger,
      });
      this.rpc = new CoordinationRpc({
        baseUrl: url,
        token,
        projectId: this.identity.project_id,
        logger: this.logger,
      });
      this.coordination = new CoordinationClient({
        baseUrl: url,
        token,
        projectId: this.identity.project_id,
        cache: this.enforcement,
        taskCache: this.taskCache,
        changeCache: this.changeCache,
        store: this.store,
        logger: this.logger,
        onEvent: (event) => {
          for (const listener of this.coordinationListeners) listener(event);
        },
      });
      this.flushListeners.add(() => this.shipper?.notify());
    }
    this.mcp = new DaemonMcpBackend(this, this.rpc, this.changeCache);
  }

  /** Subscribe to durable batch flushes (drives local SSE). Returns unsubscribe. */
  subscribeFlush(listener: FlushListener): () => void {
    this.flushListeners.add(listener);
    return () => {
      this.flushListeners.delete(listener);
    };
  }

  /** Subscribe to projected coordination events (drives the MCP push channel). */
  subscribeCoordination(listener: (event: StoredEvent) => void): () => void {
    this.coordinationListeners.add(listener);
    return () => {
      this.coordinationListeners.delete(listener);
    };
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.registerDevice();
    try {
      this.gitCapabilities = await detectGitCapabilities({ binary: this.config.git.binary });
    } catch (err) {
      this.logger.warn({ err }, 'git not detected; running in observe-only mode');
    }
    await this.watcher.start();
    this.shipper?.start();
    this.coordination?.start();
    this.started = true;
    this.logger.info(
      {
        device_id: this.identity.device_id,
        project_id: this.identity.project_id,
        mode: this.config.mode,
        dataDir: this.config.dataDir,
        git: this.gitCapabilities?.version ?? null,
        mergeTree: this.gitCapabilities?.mergeTreeWriteTree ?? false,
      },
      'daemon started',
    );
  }

  ingest(raw: unknown): EnqueueResult {
    return this.pipeline.enqueue(raw);
  }

  /** Register a git repo and begin watching it (idempotent per canonical path). */
  async registerRepo(path: string): Promise<RepoRecord> {
    const repo = await this.repos.register(path);
    await this.watcher.watch(repo);
    return this.repos.get(repo.repo_id) ?? repo;
  }

  /**
   * Map a provider-native session id to a stable Weft session_id. The in-memory
   * cache keeps ids consistent before the first batch flushes; the store lookup
   * recovers the mapping across restarts.
   */
  resolveSession(providerSessionId: string): string {
    const cached = this.sessionCache.get(providerSessionId);
    if (cached) return cached;
    const existing = this.store.getSessionByProvider(this.identity.device_id, providerSessionId);
    const sessionId = existing?.session_id ?? makeId('session');
    this.sessionCache.set(providerSessionId, sessionId);
    return sessionId;
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    await this.watcher.stop();
    this.pipeline.stop();
    await this.coordination?.stop();
    await this.shipper?.stop();
    await this.resolver.stop();
    this.store.close();
    this.started = false;
    this.logger.info('daemon stopped');
  }

  private registerDevice(): void {
    this.store.db
      .prepare(
        `INSERT INTO devices (device_id, user_id, hostname, os, last_seen, daemon_version)
         VALUES (@device_id, @user_id, @hostname, @os, @last_seen, @daemon_version)
         ON CONFLICT (device_id) DO UPDATE SET
           last_seen = excluded.last_seen, daemon_version = excluded.daemon_version`,
      )
      .run({
        device_id: this.identity.device_id,
        user_id: this.identity.user_id,
        hostname: hostname(),
        os: `${platform()} ${release()}`,
        last_seen: new Date().toISOString(),
        daemon_version: DAEMON_VERSION,
      });
  }
}
