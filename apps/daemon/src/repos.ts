import { basename } from 'node:path';
import {
  currentBranch,
  headOid,
  remoteUrl,
  repoTopLevel,
  type FileStatus,
  type SqliteDatabase,
} from '@weft/core';
import { makeId } from '@weft/protocol';

export interface RepoRecord {
  repo_id: string;
  project_id: string;
  device_id: string;
  name: string;
  root_path: string;
  remote_url: string | null;
  default_branch: string | null;
  head_oid: string | null;
  wip_ref: string;
  watcher_backend: string;
  last_scan_at: string | null;
  last_wip_oid: string | null;
  last_wip_at: string | null;
  state: string;
  registered_at: string;
}

export interface RepoFileState {
  path: string;
  change_kind: string;
  untracked: boolean;
  content_hash: string | null;
}

export type RepoErrorCode = 'not_found' | 'not_a_repo';

export class RepoError extends Error {
  constructor(
    readonly code: RepoErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RepoError';
  }
}

export interface RepoRegistryOptions {
  deviceId: string;
  projectId: string;
  binary?: string | undefined;
}

/**
 * Local registry of git repositories observed by this device. Registration is
 * idempotent per (device, canonical top-level path); metadata is refreshed from
 * git on each register. The hidden auto-WIP ref is device-namespaced so snapshots
 * never collide across machines or worktrees.
 */
export class RepoRegistry {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly options: RepoRegistryOptions,
  ) {}

  private get binary(): string | undefined {
    return this.options.binary;
  }

  async register(path: string): Promise<RepoRecord> {
    let root: string;
    try {
      root = await repoTopLevel(path, this.binary);
    } catch {
      throw new RepoError('not_a_repo', `not a git repository: ${path}`);
    }
    const [remote, branch, head] = await Promise.all([
      remoteUrl(root, this.binary),
      currentBranch(root, this.binary),
      headOid(root, this.binary),
    ]);
    const existing = this.getByPath(root);
    if (existing) {
      this.db
        .prepare(
          `UPDATE repos SET remote_url = ?, default_branch = ?, head_oid = ?, state = 'active'
           WHERE repo_id = ?`,
        )
        .run(remote, branch, head, existing.repo_id);
      return this.get(existing.repo_id) as RepoRecord;
    }
    const repoId = makeId('repo');
    const record: RepoRecord = {
      repo_id: repoId,
      project_id: this.options.projectId,
      device_id: this.options.deviceId,
      name: basename(root) || repoId,
      root_path: root,
      remote_url: remote,
      default_branch: branch,
      head_oid: head,
      wip_ref: `refs/wip/${this.options.deviceId}/${repoId}`,
      watcher_backend: 'poll',
      last_scan_at: null,
      last_wip_oid: null,
      last_wip_at: null,
      state: 'active',
      registered_at: new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT INTO repos
           (repo_id, project_id, device_id, name, root_path, remote_url, default_branch, head_oid,
            wip_ref, watcher_backend, last_scan_at, last_wip_oid, last_wip_at, state, registered_at)
         VALUES
           (@repo_id, @project_id, @device_id, @name, @root_path, @remote_url, @default_branch, @head_oid,
            @wip_ref, @watcher_backend, @last_scan_at, @last_wip_oid, @last_wip_at, @state, @registered_at)`,
      )
      .run(record);
    return record;
  }

  get(repoId: string): RepoRecord | undefined {
    return this.db.prepare('SELECT * FROM repos WHERE repo_id = ?').get(repoId) as
      RepoRecord | undefined;
  }

  getByPath(rootPath: string): RepoRecord | undefined {
    return this.db
      .prepare('SELECT * FROM repos WHERE device_id = ? AND root_path = ?')
      .get(this.options.deviceId, rootPath) as RepoRecord | undefined;
  }

  list(opts: { projectId?: string; state?: string; limit?: number } = {}): RepoRecord[] {
    const clauses: string[] = ['device_id = @device'];
    const params: Record<string, unknown> = {
      device: this.options.deviceId,
      limit: opts.limit ?? 200,
    };
    if (opts.projectId) {
      clauses.push('project_id = @project');
      params.project = opts.projectId;
    }
    if (opts.state) {
      clauses.push('state = @state');
      params.state = opts.state;
    }
    return this.db
      .prepare(
        `SELECT * FROM repos WHERE ${clauses.join(' AND ')} ORDER BY registered_at DESC LIMIT @limit`,
      )
      .all(params) as RepoRecord[];
  }

  archive(repoId: string): boolean {
    const result = this.db
      .prepare(`UPDATE repos SET state = 'archived' WHERE repo_id = ?`)
      .run(repoId);
    return result.changes > 0;
  }

  setBackend(repoId: string, backend: string): void {
    this.db.prepare('UPDATE repos SET watcher_backend = ? WHERE repo_id = ?').run(backend, repoId);
  }

  recordScan(repoId: string, head: string | null): void {
    this.db
      .prepare('UPDATE repos SET head_oid = ?, last_scan_at = ? WHERE repo_id = ?')
      .run(head, new Date().toISOString(), repoId);
  }

  recordWip(repoId: string, oid: string): void {
    this.db
      .prepare('UPDATE repos SET last_wip_oid = ?, last_wip_at = ? WHERE repo_id = ?')
      .run(oid, new Date().toISOString(), repoId);
  }

  getFileState(repoId: string): RepoFileState[] {
    const rows = this.db
      .prepare(
        'SELECT path, change_kind, untracked, content_hash FROM repo_files WHERE repo_id = ?',
      )
      .all(repoId) as {
      path: string;
      change_kind: string;
      untracked: number;
      content_hash: string | null;
    }[];
    return rows.map((r) => ({
      path: r.path,
      change_kind: r.change_kind,
      untracked: r.untracked !== 0,
      content_hash: r.content_hash,
    }));
  }

  replaceFileState(repoId: string, files: RepoFileState[]): void {
    const del = this.db.prepare('DELETE FROM repo_files WHERE repo_id = ?');
    const ins = this.db.prepare(
      `INSERT INTO repo_files (repo_id, path, change_kind, untracked, content_hash, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const now = new Date().toISOString();
    const tx = this.db.transaction((batch: RepoFileState[]) => {
      del.run(repoId);
      for (const f of batch) {
        ins.run(repoId, f.path, f.change_kind, f.untracked ? 1 : 0, f.content_hash, now);
      }
    });
    tx(files);
  }

  /** Convert git plumbing status rows into persisted file-state rows. */
  static toFileState(files: FileStatus[], hashes: Map<string, string | null>): RepoFileState[] {
    return files.map((f) => ({
      path: f.path,
      change_kind: f.changeKind,
      untracked: f.untracked,
      content_hash: hashes.get(f.path) ?? null,
    }));
  }
}
