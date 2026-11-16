import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  branchCreate,
  branchExists,
  createAutoWip,
  metrics,
  revParse,
  worktreeAdd,
  worktreeList,
  worktreePrune,
  worktreeRemove,
  worktreeUnlock,
  type AutoWipResult,
  type Logger,
  type SqliteDatabase,
} from '@weft/core';
import { makeId, type Actor } from '@weft/protocol';
import type { EventDraft } from './events.js';
import type { EnqueueResult } from './pipeline.js';
import type { RepoRecord, RepoRegistry } from './repos.js';

/**
 * Authority for provisioning a task worktree. The daemon has no claim RPC of its
 * own; the caller supplies the grant it observed from the server's coordination
 * channel. confirmed = server acked this device's claim (agent-assignable);
 * provisional = offline/optimistic claim (quarantined, never agent-assignable).
 */
export interface ClaimGrant {
  taskId: string;
  confirmed: boolean;
  provisional: boolean;
}

export type WorktreeState = 'active' | 'quarantined' | 'discarded' | 'removed';

export interface WorktreeRecord {
  worktree_id: string;
  repo_id: string;
  task_id: string;
  branch: string;
  path: string;
  base_oid: string | null;
  device_id: string;
  wip_ref: string;
  quarantine: boolean;
  locked: boolean;
  owner_pid: number | null;
  state: WorktreeState;
  created_at: string;
  discarded_at: string | null;
}

export type WorktreeErrorCode =
  | 'not_found'
  | 'not_claimed'
  | 'branch_busy'
  | 'quarantined'
  | 'already_assigned'
  | 'invalid_base';

export class WorktreeError extends Error {
  constructor(
    readonly code: WorktreeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'WorktreeError';
  }
}

export interface WorktreeManagerOptions {
  deviceId: string;
  projectId: string;
  /** Root directory under which per-repo/per-task worktrees are created. */
  worktreeRoot: string;
  registry: RepoRegistry;
  emit: (draft: EventDraft) => EnqueueResult;
  actor: Actor;
  binary?: string | undefined;
  logger?: Logger | undefined;
}

export interface ProvisionOptions {
  /** Base ref to branch from (default: the repo's default branch, else HEAD). */
  baseRef?: string | undefined;
  /** Agent pid to assign immediately (only honored for confirmed grants). */
  ownerPid?: number | undefined;
}

export interface DiscardResult {
  discarded: string[];
  wip: AutoWipResult[];
}

interface WorktreeRow {
  worktree_id: string;
  repo_id: string;
  task_id: string;
  branch: string;
  path: string;
  base_oid: string | null;
  device_id: string;
  wip_ref: string;
  quarantine: number;
  locked: number;
  owner_pid: number | null;
  state: string;
  created_at: string;
  discarded_at: string | null;
}

function toRecord(row: WorktreeRow): WorktreeRecord {
  return {
    ...row,
    quarantine: row.quarantine !== 0,
    locked: row.locked !== 0,
    state: row.state as WorktreeState,
  };
}

/** Git on Windows emits forward-slash paths; compare case-insensitively there. */
function normalizePath(path: string): string {
  const slashed = path.replace(/\\/g, '/');
  return process.platform === 'win32' ? slashed.toLowerCase() : slashed;
}

const provisioned = metrics.counter('weft_worktrees_provisioned_total', 'Confirmed worktrees provisioned');
const quarantined = metrics.counter('weft_worktrees_quarantined_total', 'Provisional worktrees quarantined');
const discardedTotal = metrics.counter('weft_worktrees_discarded_total', 'Worktrees discarded (work preserved)');
const staleRecovered = metrics.counter('weft_worktrees_stale_recovered_total', 'Stale worktree locks recovered');
const activeGauge = metrics.gauge('weft_worktrees_active', 'Worktrees currently active or quarantined');

/**
 * Provisions claim-gated, branch-per-task git worktrees off a shared clone.
 * Shared-ref operations are serialized per repo (promise-chain mutex); git also
 * enforces one writer per branch. Agent worktrees are git-locked; stale locks
 * (directory gone / prunable) are unlocked and pruned. Uncommitted work is
 * snapshotted to a device-namespaced ref refs/wip/<task>/<device> before any
 * removal, and the branch + WIP ref are always preserved — work is never
 * silently destroyed, even when a provisional claim loses.
 */
export class WorktreeManager {
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(
    private readonly db: SqliteDatabase,
    private readonly options: WorktreeManagerOptions,
  ) {}

  private get binary(): string | undefined {
    return this.options.binary;
  }

  private get deviceId(): string {
    return this.options.deviceId;
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

  async provision(
    repoId: string,
    grant: ClaimGrant,
    opts: ProvisionOptions = {},
  ): Promise<WorktreeRecord> {
    if (!grant.confirmed && !grant.provisional) {
      throw new WorktreeError(
        'not_claimed',
        `task ${grant.taskId} has neither a confirmed nor a provisional claim`,
      );
    }
    return this.serialize(repoId, () => this.provisionOnce(repoId, grant, opts));
  }

  private async provisionOnce(
    repoId: string,
    grant: ClaimGrant,
    opts: ProvisionOptions,
  ): Promise<WorktreeRecord> {
    const repo = this.requireRepo(repoId);
    const taskId = grant.taskId;
    const branch = `weft/task/${taskId}`;

    const existing = this.getActive(repoId, taskId);
    if (existing) {
      if (grant.confirmed && existing.quarantine) return this.promote(existing);
      return existing;
    }
    const writer = this.branchWriter(repoId, branch);
    if (writer) {
      throw new WorktreeError(
        'branch_busy',
        `branch ${branch} already has a worktree (${writer.worktree_id})`,
      );
    }

    const baseRef = opts.baseRef ?? repo.default_branch ?? 'HEAD';
    const baseOid = await revParse(repo.root_path, baseRef, this.binary);
    if (!baseOid) throw new WorktreeError('invalid_base', `base ref not resolvable: ${baseRef}`);

    if (!(await branchExists(repo.root_path, branch, this.binary))) {
      await branchCreate(repo.root_path, branch, baseOid, this.binary);
      this.emitBranch(repo, branch, baseOid, taskId);
    }

    const path = join(this.options.worktreeRoot, repoId, taskId);
    mkdirSync(dirname(path), { recursive: true });
    const quarantine = grant.provisional || !grant.confirmed;
    await worktreeAdd(repo.root_path, path, branch, {
      lock: true,
      lockReason: `weft:${quarantine ? 'quarantine' : 'task'}:${taskId}`,
      binary: this.binary,
    });

    const record: WorktreeRecord = {
      worktree_id: makeId('workspace'),
      repo_id: repoId,
      task_id: taskId,
      branch,
      path,
      base_oid: baseOid,
      device_id: this.deviceId,
      wip_ref: `refs/wip/${taskId}/${this.deviceId}`,
      quarantine,
      locked: true,
      owner_pid: !quarantine && opts.ownerPid !== undefined ? opts.ownerPid : null,
      state: quarantine ? 'quarantined' : 'active',
      created_at: new Date().toISOString(),
      discarded_at: null,
    };
    this.insert(record);
    this.emitWorktree(repo, record, 'worktree.created');
    activeGauge.add(1);
    if (quarantine) quarantined.inc();
    else provisioned.inc();
    this.options.logger?.info(
      { worktreeId: record.worktree_id, taskId, branch, quarantine },
      'worktree provisioned',
    );
    return record;
  }

  /** Flip a quarantined worktree to active once its claim is confirmed. */
  private promote(existing: WorktreeRecord): WorktreeRecord {
    this.db
      .prepare(`UPDATE worktrees SET quarantine = 0, state = 'active' WHERE worktree_id = ?`)
      .run(existing.worktree_id);
    this.options.logger?.info(
      { worktreeId: existing.worktree_id, taskId: existing.task_id },
      'quarantined worktree promoted to active',
    );
    return { ...existing, quarantine: false, state: 'active' };
  }

  /** Assign an agent pid. Quarantined worktrees are never agent-assignable. */
  async assignAgent(worktreeId: string, pid: number): Promise<WorktreeRecord> {
    const rec = this.get(worktreeId);
    if (!rec) throw new WorktreeError('not_found', `unknown worktree: ${worktreeId}`);
    return this.serialize(rec.repo_id, async () => {
      const current = this.get(worktreeId);
      if (!current) throw new WorktreeError('not_found', `unknown worktree: ${worktreeId}`);
      if (current.quarantine || current.state !== 'active') {
        throw new WorktreeError(
          'quarantined',
          `worktree ${worktreeId} is ${current.state}; agent assignment requires a confirmed claim`,
        );
      }
      if (current.owner_pid !== null && current.owner_pid !== pid) {
        throw new WorktreeError(
          'already_assigned',
          `worktree ${worktreeId} is already assigned to pid ${current.owner_pid}`,
        );
      }
      this.db
        .prepare('UPDATE worktrees SET owner_pid = ?, locked = 1 WHERE worktree_id = ?')
        .run(pid, worktreeId);
      return { ...current, owner_pid: pid, locked: true };
    });
  }

  /** Snapshot uncommitted work to the device-namespaced WIP ref (never force). */
  async snapshotWip(worktreeId: string): Promise<AutoWipResult | null> {
    const rec = this.get(worktreeId);
    if (!rec) throw new WorktreeError('not_found', `unknown worktree: ${worktreeId}`);
    return this.serialize(rec.repo_id, async () => {
      const current = this.get(worktreeId);
      if (!current) throw new WorktreeError('not_found', `unknown worktree: ${worktreeId}`);
      if (!existsSync(current.path)) return null;
      const message = `Weft auto-WIP ${current.task_id} ${new Date().toISOString()}`;
      return createAutoWip(current.path, current.wip_ref, message, this.binary);
    });
  }

  /** Recover worktrees whose directory is gone or git marks prunable. */
  async recoverStale(repoId: string): Promise<{ recovered: string[] }> {
    return this.serialize(repoId, () => this.recoverStaleOnce(repoId));
  }

  private async recoverStaleOnce(repoId: string): Promise<{ recovered: string[] }> {
    const repo = this.requireRepo(repoId);
    const list = await worktreeList(repo.root_path, this.binary);
    const byPath = new Map(list.map((w) => [normalizePath(w.path), w]));
    const records = this.list({ repoId, limit: 1000 }).filter(
      (r) => r.state === 'active' || r.state === 'quarantined',
    );
    const stale = records.filter((r) => {
      const info = byPath.get(normalizePath(r.path));
      return !existsSync(r.path) || info?.prunable === true;
    });
    if (stale.length === 0) return { recovered: [] };

    for (const rec of stale) {
      // Unlock first: `git worktree prune` deliberately skips locked entries.
      try {
        await worktreeUnlock(repo.root_path, rec.path, this.binary);
      } catch {
        /* already unlocked or admin entry gone */
      }
    }
    await worktreePrune(repo.root_path, this.binary);

    const recovered: string[] = [];
    const now = new Date().toISOString();
    for (const rec of stale) {
      this.db
        .prepare(
          `UPDATE worktrees SET state = 'removed', locked = 0, owner_pid = NULL, discarded_at = ?
           WHERE worktree_id = ?`,
        )
        .run(now, rec.worktree_id);
      this.emitWorktree(repo, { ...rec, state: 'removed' }, 'worktree.removed');
      activeGauge.add(-1);
      staleRecovered.inc();
      recovered.push(rec.worktree_id);
    }
    this.options.logger?.warn({ repoId, recovered }, 'recovered stale worktree locks');
    return { recovered };
  }

  /**
   * Discard every worktree this device holds for a task (losing claim). Work is
   * snapshotted to the WIP ref first; the branch and ref are preserved so the
   * provisional work stays recoverable and never overwrites the winner.
   */
  async discardQuarantine(taskId: string): Promise<DiscardResult> {
    const rows = this.db
      .prepare(
        `SELECT * FROM worktrees
         WHERE task_id = ? AND device_id = ? AND state IN ('active', 'quarantined')`,
      )
      .all(taskId, this.deviceId) as WorktreeRow[];
    const discarded: string[] = [];
    const wip: AutoWipResult[] = [];
    for (const row of rows) {
      const rec = toRecord(row);
      const result = await this.serialize(rec.repo_id, () => this.removeOnce(rec, 'discarded'));
      if (result.removed) discarded.push(rec.worktree_id);
      if (result.wip) wip.push(result.wip);
    }
    return { discarded, wip };
  }

  /** Explicitly retire a worktree, preserving its branch + WIP ref. */
  async remove(worktreeId: string): Promise<{ removed: boolean; wip: AutoWipResult | null }> {
    const rec = this.get(worktreeId);
    if (!rec) throw new WorktreeError('not_found', `unknown worktree: ${worktreeId}`);
    return this.serialize(rec.repo_id, () => this.removeOnce(rec, 'removed'));
  }

  private async removeOnce(
    rec: WorktreeRecord,
    finalState: 'discarded' | 'removed',
  ): Promise<{ removed: boolean; wip: AutoWipResult | null }> {
    const repo = this.requireRepo(rec.repo_id);
    const current = this.get(rec.worktree_id);
    if (!current || current.state === 'discarded' || current.state === 'removed') {
      return { removed: false, wip: null };
    }
    let wip: AutoWipResult | null = null;
    if (existsSync(current.path)) {
      const message = `Weft ${finalState} ${current.task_id} ${new Date().toISOString()}`;
      wip = await createAutoWip(current.path, current.wip_ref, message, this.binary);
      try {
        await worktreeUnlock(repo.root_path, current.path, this.binary);
      } catch {
        /* not locked */
      }
      // Force is safe only because the dirty work was just snapshotted to a ref.
      await worktreeRemove(repo.root_path, current.path, { force: true, binary: this.binary });
    } else {
      try {
        await worktreeUnlock(repo.root_path, current.path, this.binary);
      } catch {
        /* admin entry gone */
      }
      await worktreePrune(repo.root_path, this.binary);
    }
    this.db
      .prepare(
        `UPDATE worktrees SET state = ?, locked = 0, owner_pid = NULL, discarded_at = ?
         WHERE worktree_id = ?`,
      )
      .run(finalState, new Date().toISOString(), current.worktree_id);
    this.emitWorktree(repo, { ...current, state: finalState }, 'worktree.removed');
    activeGauge.add(-1);
    discardedTotal.inc();
    return { removed: true, wip };
  }

  get(worktreeId: string): WorktreeRecord | undefined {
    const row = this.db.prepare('SELECT * FROM worktrees WHERE worktree_id = ?').get(worktreeId) as
      | WorktreeRow
      | undefined;
    return row ? toRecord(row) : undefined;
  }

  list(
    opts: { repoId?: string; taskId?: string; state?: WorktreeState; limit?: number } = {},
  ): WorktreeRecord[] {
    const clauses: string[] = ['device_id = @device'];
    const params: Record<string, unknown> = { device: this.deviceId, limit: opts.limit ?? 200 };
    if (opts.repoId) {
      clauses.push('repo_id = @repo');
      params.repo = opts.repoId;
    }
    if (opts.taskId) {
      clauses.push('task_id = @task');
      params.task = opts.taskId;
    }
    if (opts.state) {
      clauses.push('state = @state');
      params.state = opts.state;
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM worktrees WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC LIMIT @limit`,
      )
      .all(params) as WorktreeRow[];
    return rows.map(toRecord);
  }

  private getActive(repoId: string, taskId: string): WorktreeRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM worktrees
         WHERE repo_id = ? AND task_id = ? AND device_id = ? AND state IN ('active', 'quarantined')`,
      )
      .get(repoId, taskId, this.deviceId) as WorktreeRow | undefined;
    return row ? toRecord(row) : undefined;
  }

  private branchWriter(repoId: string, branch: string): WorktreeRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT * FROM worktrees WHERE repo_id = ? AND branch = ? AND state IN ('active', 'quarantined')`,
      )
      .get(repoId, branch) as WorktreeRow | undefined;
    return row ? toRecord(row) : undefined;
  }

  private requireRepo(repoId: string): RepoRecord {
    const repo = this.options.registry.get(repoId);
    if (!repo) throw new WorktreeError('not_found', `unknown repo: ${repoId}`);
    return repo;
  }

  private insert(rec: WorktreeRecord): void {
    this.db
      .prepare(
        `INSERT INTO worktrees
           (worktree_id, repo_id, task_id, branch, path, base_oid, device_id, wip_ref,
            quarantine, locked, owner_pid, state, created_at, discarded_at)
         VALUES
           (@worktree_id, @repo_id, @task_id, @branch, @path, @base_oid, @device_id, @wip_ref,
            @quarantine, @locked, @owner_pid, @state, @created_at, @discarded_at)`,
      )
      .run({ ...rec, quarantine: rec.quarantine ? 1 : 0, locked: rec.locked ? 1 : 0 });
  }

  private emitWorktree(
    repo: RepoRecord,
    rec: WorktreeRecord,
    type: 'worktree.created' | 'worktree.removed',
  ): void {
    this.options.emit({
      type,
      actor: this.options.actor,
      repoId: repo.repo_id,
      taskId: rec.task_id,
      privacy: 'metadata',
      payload: { path: rec.path, branch: rec.branch, task_id: rec.task_id },
    });
  }

  private emitBranch(
    repo: RepoRecord,
    branch: string,
    headOid: string,
    taskId: string,
  ): void {
    this.options.emit({
      type: 'branch.created',
      actor: this.options.actor,
      repoId: repo.repo_id,
      taskId,
      privacy: 'metadata',
      payload: { name: branch, head_oid: headOid, task_id: taskId, kind: 'task' },
    });
  }
}