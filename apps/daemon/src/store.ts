import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { openSqlite, migrate, DAEMON_MIGRATIONS, type SqliteDatabase } from '@weft/core';
import { isCoordinationEvent, type EventEnvelope } from '@weft/protocol';
import type { ExtractedEdge, ExtractedSymbol } from './symbols.js';

export type StoredLocalEvent = EventEnvelope & { received_at: string; rowid?: number };

export interface EventQuery {
  projectId?: string;
  sessionId?: string;
  afterRowId?: number;
  taskId?: string;
  repoId?: string;
  types?: string[];
  since?: string;
  until?: string;
  newestFirst?: boolean;
  deterministicRecent?: boolean;
  limit?: number;
}

export interface SessionRecord {
  session_id: string;
  device_id: string;
  provider_id: string | null;
  provider_session_id: string;
  task_id: string | null;
  developer_id: string | null;
  cwd: string | null;
  status: string;
  started_at: string;
  ended_at: string | null;
  model: string | null;
  prompt_summary: string | null;
  fidelity: string;
}

export interface OutboxRow {
  outbox_id: number;
  event_id: string;
  kind: string;
  envelope: string;
  created_at: string;
  attempts: number;
  last_error: string | null;
}

export interface StoredSymbol {
  symbol_id: number;
  repo_id: string;
  branch: string;
  file_path: string;
  name: string;
  kind: string;
  container: string;
  signature: string;
  exported: boolean;
  start_line: number;
  end_line: number;
  start_byte: number;
  end_byte: number;
  content_hash: string;
  indexed_at: string;
}

export interface StoredSymbolEdge {
  edge_id: number;
  repo_id: string;
  branch: string;
  file_path: string;
  from_symbol: string;
  to_name: string;
  kind: string;
  module_specifier: string | null;
  line: number;
}

export interface FileIndexState {
  content_hash: string;
  symbol_count: number;
  indexed_at: string;
}

export interface BranchIndexState {
  repo_id: string;
  branch: string;
  head_oid: string;
  file_count: number;
  symbol_count: number;
  last_indexed_at: string | null;
}

export interface FileIndexRow extends FileIndexState {
  file_path: string;
}

const EVENT_COLUMNS = `event_id, v, device_id, project_id, repo_id, session_id, provider_session_id,
  task_id, seq, ts, type, actor, payload, privacy, received_at`;
const EVENT_COLUMN_COUNT = 15;
const COORDINATION_COLUMN_COUNT = 14;
const INSERT_CHUNK_SIZE = 100;
type Statement = ReturnType<SqliteDatabase['prepare']>;

function eventParams(e: StoredLocalEvent): unknown[] {
  return [
    e.event_id,
    e.v,
    e.device_id,
    e.project_id,
    e.repo_id ?? null,
    e.session_id ?? null,
    e.provider_session_id ?? null,
    e.task_id ?? null,
    e.seq ?? null,
    e.ts,
    e.type,
    JSON.stringify(e.actor),
    JSON.stringify(e.payload),
    e.privacy,
    e.received_at ?? new Date().toISOString(),
  ];
}

function insertRows(
  db: SqliteDatabase,
  statements: Map<number, Statement>,
  prefix: string,
  columnCount: number,
  rows: unknown[][],
): void {
  for (let offset = 0; offset < rows.length; offset += INSERT_CHUNK_SIZE) {
    const chunk = rows.slice(offset, offset + INSERT_CHUNK_SIZE);
    let statement = statements.get(chunk.length);
    if (!statement) {
      const placeholders = `(${Array(columnCount).fill('?').join(',')})`;
      statement = db.prepare(
        `${prefix} VALUES ${Array(chunk.length).fill(placeholders).join(',')}`,
      );
      statements.set(chunk.length, statement);
    }
    statement.run(chunk.flat());
  }
}

interface EventRow {
  rowid: number;
  event_id: string;
  v: number;
  device_id: string;
  project_id: string;
  repo_id: string | null;
  session_id: string | null;
  provider_session_id: string | null;
  task_id: string | null;
  seq: number | null;
  ts: string;
  type: string;
  actor: string;
  payload: string;
  privacy: string;
  received_at: string;
}

function rowToEvent(row: EventRow): StoredLocalEvent {
  return {
    v: row.v as 1,
    event_id: row.event_id,
    device_id: row.device_id,
    project_id: row.project_id,
    ...(row.repo_id ? { repo_id: row.repo_id } : {}),
    ...(row.session_id ? { session_id: row.session_id } : {}),
    ...(row.provider_session_id ? { provider_session_id: row.provider_session_id } : {}),
    ...(row.task_id ? { task_id: row.task_id } : {}),
    ...(row.seq !== null ? { seq: row.seq } : {}),
    ts: row.ts,
    type: row.type,
    actor: JSON.parse(row.actor),
    privacy: row.privacy as 'metadata' | 'full',
    payload: JSON.parse(row.payload),
    received_at: row.received_at,
    rowid: row.rowid,
  };
}

export class LocalStore {
  private readonly eventStatements = new Map<number, Statement>();
  private readonly coordinationStatements = new Map<number, Statement>();
  private readonly outboxStatements = new Map<number, Statement>();

  constructor(readonly db: SqliteDatabase) {}

  static open(dataDir: string): LocalStore {
    mkdirSync(dataDir, { recursive: true });
    const db = openSqlite(join(dataDir, 'weft.sqlite'));
    migrate(db, DAEMON_MIGRATIONS);
    return new LocalStore(db);
  }

  /** Atomically persist a batch; durable types mirrored to coordination_events. */
  insertEvents(events: StoredLocalEvent[], teamMode: boolean): void {
    if (events.length === 0) return;
    const rows = events.map(eventParams);
    const durableRows = events.flatMap((event, index) =>
      isCoordinationEvent(event.type) ? [rows[index]!.filter((_, column) => column !== 6)] : [],
    );
    const outboxRows = teamMode
      ? events.map((event) => [
          event.event_id,
          isCoordinationEvent(event.type) ? 'coordination' : 'telemetry',
          JSON.stringify(event),
          event.received_at,
        ])
      : [];
    const tx = this.db.transaction(() => {
      insertRows(
        this.db,
        this.eventStatements,
        `INSERT OR IGNORE INTO events (${EVENT_COLUMNS})`,
        EVENT_COLUMN_COUNT,
        rows,
      );
      if (durableRows.length > 0) {
        insertRows(
          this.db,
          this.coordinationStatements,
          `INSERT OR IGNORE INTO coordination_events
             (event_id, v, device_id, project_id, repo_id, session_id, task_id, seq, ts, type,
              actor, payload, privacy, received_at)`,
          COORDINATION_COLUMN_COUNT,
          durableRows,
        );
      }
      if (outboxRows.length > 0) {
        insertRows(
          this.db,
          this.outboxStatements,
          'INSERT OR IGNORE INTO outbox (event_id, kind, envelope, created_at)',
          4,
          outboxRows,
        );
      }
    });
    tx();
  }

  getEvents(query: EventQuery = {}): StoredLocalEvent[] {
    const clauses: string[] = [];
    const params: Record<string, unknown> = { limit: query.limit ?? 200 };
    if (query.afterRowId !== undefined) {
      clauses.push('rowid > @after');
      params.after = query.afterRowId;
    }
    if (query.projectId) {
      clauses.push('project_id = @project');
      params.project = query.projectId;
    }
    if (query.sessionId) {
      clauses.push('session_id = @session');
      params.session = query.sessionId;
    }
    if (query.taskId && query.repoId) {
      clauses.push('(task_id = @task OR repo_id = @repo)');
      params.task = query.taskId;
      params.repo = query.repoId;
    } else {
      if (query.taskId) {
        clauses.push('task_id = @task');
        params.task = query.taskId;
      }
      if (query.repoId) {
        clauses.push('repo_id = @repo');
        params.repo = query.repoId;
      }
    }
    if (query.types?.length) {
      clauses.push('type IN (SELECT value FROM json_each(@types))');
      params.types = JSON.stringify(query.types);
    }
    if (query.since) {
      clauses.push('julianday(ts) >= julianday(@since)');
      params.since = query.since;
    }
    if (query.until) {
      clauses.push('julianday(ts) <= julianday(@until)');
      params.until = query.until;
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const order = query.deterministicRecent
      ? 'julianday(ts) DESC, event_id DESC'
      : `rowid ${query.newestFirst ? 'DESC' : 'ASC'}`;
    const rows = this.db
      .prepare(`SELECT rowid, * FROM events ${where} ORDER BY ${order} LIMIT @limit`)
      .all(params) as EventRow[];
    return rows.map(rowToEvent);
  }

  maxRowId(): number {
    const row = this.db.prepare('SELECT COALESCE(MAX(rowid), 0) AS m FROM events').get() as {
      m: number;
    };
    return row.m;
  }

  countEvents(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS c FROM events').get() as { c: number };
    return row.c;
  }

  // --- Outbox (team-mode shipping) -----------------------------------------

  /** Oldest unshipped rows first; the shipper drains these in batches. */
  pendingOutbox(limit: number): OutboxRow[] {
    return this.db
      .prepare(
        `SELECT outbox_id, event_id, kind, envelope, created_at, attempts, last_error
           FROM outbox WHERE shipped_at IS NULL ORDER BY outbox_id ASC LIMIT ?`,
      )
      .all(limit) as OutboxRow[];
  }

  pendingOutboxCount(): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS c FROM outbox WHERE shipped_at IS NULL')
      .get() as { c: number };
    return row.c;
  }

  /** Delete shipped (accepted or deduplicated) rows. Returns rows removed. */
  ackOutbox(eventIds: string[]): number {
    if (eventIds.length === 0) return 0;
    const del = this.db.prepare('DELETE FROM outbox WHERE event_id = ?');
    const tx = this.db.transaction((ids: string[]) => {
      let removed = 0;
      for (const id of ids) removed += del.run(id).changes;
      return removed;
    });
    return tx(eventIds) as number;
  }

  /** Record a failed shipping attempt for backoff/diagnostics (rows retained). */
  markOutboxAttempt(eventIds: string[], error: string): void {
    if (eventIds.length === 0) return;
    const upd = this.db.prepare(
      'UPDATE outbox SET attempts = attempts + 1, last_error = ? WHERE event_id = ?',
    );
    const tx = this.db.transaction((ids: string[]) => {
      for (const id of ids) upd.run(error, id);
    });
    tx(eventIds);
  }

  /**
   * Bound the pending outbox by compacting the oldest telemetry first.
   * Coordination rows are NEVER dropped (durable trail). Returns rows removed.
   */
  compactOutbox(maxRows: number): number {
    const pending = this.pendingOutboxCount();
    const excess = pending - maxRows;
    if (excess <= 0) return 0;
    const res = this.db
      .prepare(
        `DELETE FROM outbox WHERE outbox_id IN (
           SELECT outbox_id FROM outbox
            WHERE shipped_at IS NULL AND kind = 'telemetry'
            ORDER BY outbox_id ASC LIMIT ?
         )`,
      )
      .run(excess);
    return res.changes;
  }

  // --- Sync state (durable cursors / markers) ------------------------------

  getSyncState(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM sync_state WHERE key = ?').get(key) as
      { value: string } | undefined;
    return row?.value;
  }

  setSyncState(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO sync_state (key, value) VALUES (?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  upsertSession(session: SessionRecord): void {
    this.db
      .prepare(
        `INSERT INTO agent_sessions
           (session_id, device_id, provider_id, provider_session_id, task_id, developer_id, cwd, status, started_at, ended_at, model, prompt_summary, fidelity)
         VALUES
           (@session_id, @device_id, @provider_id, @provider_session_id, @task_id, @developer_id, @cwd, @status, @started_at, @ended_at, @model, @prompt_summary, @fidelity)
         ON CONFLICT (session_id) DO UPDATE SET
           status = excluded.status,
           ended_at = excluded.ended_at,
           task_id = COALESCE(excluded.task_id, agent_sessions.task_id),
           model = COALESCE(excluded.model, agent_sessions.model),
           prompt_summary = COALESCE(excluded.prompt_summary, agent_sessions.prompt_summary)`,
      )
      .run(session);
  }

  getSessions(limit = 100): SessionRecord[] {
    return this.db
      .prepare('SELECT * FROM agent_sessions ORDER BY started_at DESC LIMIT ?')
      .all(limit) as SessionRecord[];
  }

  getSession(sessionId: string): SessionRecord | undefined {
    return this.db.prepare('SELECT * FROM agent_sessions WHERE session_id = ?').get(sessionId) as
      SessionRecord | undefined;
  }

  getSessionByProvider(deviceId: string, providerSessionId: string): SessionRecord | undefined {
    return this.db
      .prepare('SELECT * FROM agent_sessions WHERE device_id = ? AND provider_session_id = ?')
      .get(deviceId, providerSessionId) as SessionRecord | undefined;
  }

  // --- Symbol index (M3, branch-scoped, daemon-local) -----------------------

  /**
   * Atomically replace one file's symbols + edges and record its content hash.
   * Branch-scoped: indexing branch B never touches branch A's rows. The hash in
   * file_index_state drives git-diff invalidation (unchanged files are skipped).
   */
  replaceFileSymbols(
    repoId: string,
    branch: string,
    filePath: string,
    symbols: ExtractedSymbol[],
    edges: ExtractedEdge[],
    contentHash: string,
    indexedAt = new Date().toISOString(),
  ): void {
    const delSym = this.db.prepare(
      'DELETE FROM symbols WHERE repo_id = ? AND branch = ? AND file_path = ?',
    );
    const delEdge = this.db.prepare(
      'DELETE FROM symbol_edges WHERE repo_id = ? AND branch = ? AND file_path = ?',
    );
    const insSym = this.db.prepare(
      `INSERT INTO symbols
         (repo_id, branch, file_path, name, kind, container, signature, exported,
          start_line, end_line, start_byte, end_byte, content_hash, indexed_at)
       VALUES
         (@repo_id, @branch, @file_path, @name, @kind, @container, @signature, @exported,
          @start_line, @end_line, @start_byte, @end_byte, @content_hash, @indexed_at)`,
    );
    const insEdge = this.db.prepare(
      `INSERT INTO symbol_edges
         (repo_id, branch, file_path, from_symbol, to_name, kind, module_specifier, line)
       VALUES (@repo_id, @branch, @file_path, @from_symbol, @to_name, @kind, @module_specifier, @line)`,
    );
    const upsertState = this.db.prepare(
      `INSERT INTO file_index_state (repo_id, branch, file_path, content_hash, symbol_count, indexed_at)
       VALUES (@repo_id, @branch, @file_path, @content_hash, @symbol_count, @indexed_at)
       ON CONFLICT (repo_id, branch, file_path) DO UPDATE SET
         content_hash = excluded.content_hash,
         symbol_count = excluded.symbol_count,
         indexed_at = excluded.indexed_at`,
    );
    const tx = this.db.transaction(() => {
      delSym.run(repoId, branch, filePath);
      delEdge.run(repoId, branch, filePath);
      for (const s of symbols) {
        insSym.run({
          repo_id: repoId,
          branch,
          file_path: filePath,
          name: s.name,
          kind: s.kind,
          container: s.container,
          signature: s.signature,
          exported: s.exported ? 1 : 0,
          start_line: s.start_line,
          end_line: s.end_line,
          start_byte: s.start_byte,
          end_byte: s.end_byte,
          content_hash: s.content_hash,
          indexed_at: indexedAt,
        });
      }
      for (const e of edges) {
        insEdge.run({
          repo_id: repoId,
          branch,
          file_path: filePath,
          from_symbol: e.from_symbol,
          to_name: e.to_name,
          kind: e.kind,
          module_specifier: e.module_specifier,
          line: e.line,
        });
      }
      upsertState.run({
        repo_id: repoId,
        branch,
        file_path: filePath,
        content_hash: contentHash,
        symbol_count: symbols.length,
        indexed_at: indexedAt,
      });
    });
    tx();
  }

  deleteFileSymbols(repoId: string, branch: string, filePath: string): void {
    const tx = this.db.transaction(() => {
      this.db
        .prepare('DELETE FROM symbols WHERE repo_id = ? AND branch = ? AND file_path = ?')
        .run(repoId, branch, filePath);
      this.db
        .prepare('DELETE FROM symbol_edges WHERE repo_id = ? AND branch = ? AND file_path = ?')
        .run(repoId, branch, filePath);
      this.db
        .prepare('DELETE FROM file_index_state WHERE repo_id = ? AND branch = ? AND file_path = ?')
        .run(repoId, branch, filePath);
    });
    tx();
  }

  getFileIndexState(repoId: string, branch: string, filePath: string): FileIndexState | undefined {
    return this.db
      .prepare(
        'SELECT content_hash, symbol_count, indexed_at FROM file_index_state WHERE repo_id = ? AND branch = ? AND file_path = ?',
      )
      .get(repoId, branch, filePath) as FileIndexState | undefined;
  }

  listIndexedFiles(repoId: string, branch: string): string[] {
    const rows = this.db
      .prepare(
        'SELECT file_path FROM file_index_state WHERE repo_id = ? AND branch = ? ORDER BY file_path',
      )
      .all(repoId, branch) as { file_path: string }[];
    return rows.map((r) => r.file_path);
  }

  getSymbols(repoId: string, branch: string, filePath?: string): StoredSymbol[] {
    const rows = filePath
      ? (this.db
          .prepare(
            'SELECT * FROM symbols WHERE repo_id = ? AND branch = ? AND file_path = ? ORDER BY start_line, name',
          )
          .all(repoId, branch, filePath) as (Omit<StoredSymbol, 'exported'> & {
          exported: number;
        })[])
      : (this.db
          .prepare(
            'SELECT * FROM symbols WHERE repo_id = ? AND branch = ? ORDER BY file_path, start_line, name',
          )
          .all(repoId, branch) as (Omit<StoredSymbol, 'exported'> & { exported: number })[]);
    return rows.map((r) => ({ ...r, exported: r.exported !== 0 }));
  }

  getSymbolEdges(
    repoId: string,
    branch: string,
    opts: { filePath?: string; toName?: string; kind?: string } = {},
  ): StoredSymbolEdge[] {
    const clauses = ['repo_id = @repo', 'branch = @branch'];
    const params: Record<string, unknown> = { repo: repoId, branch };
    if (opts.filePath) {
      clauses.push('file_path = @file');
      params.file = opts.filePath;
    }
    if (opts.toName) {
      clauses.push('to_name = @to');
      params.to = opts.toName;
    }
    if (opts.kind) {
      clauses.push('kind = @kind');
      params.kind = opts.kind;
    }
    return this.db
      .prepare(`SELECT * FROM symbol_edges WHERE ${clauses.join(' AND ')} ORDER BY file_path, line`)
      .all(params) as StoredSymbolEdge[];
  }

  countSymbols(repoId: string, branch: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS c FROM symbols WHERE repo_id = ? AND branch = ?')
      .get(repoId, branch) as { c: number };
    return row.c;
  }

  listFileIndexState(repoId: string, branch: string): FileIndexRow[] {
    return this.db
      .prepare(
        'SELECT file_path, content_hash, symbol_count, indexed_at FROM file_index_state WHERE repo_id = ? AND branch = ? ORDER BY file_path',
      )
      .all(repoId, branch) as FileIndexRow[];
  }

  getBranchIndexAggregate(
    repoId: string,
    branch: string,
  ): { file_count: number; symbol_count: number; last_indexed_at: string | null } {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS file_count, COALESCE(SUM(symbol_count), 0) AS symbol_count,
                MAX(indexed_at) AS last_indexed_at
           FROM file_index_state WHERE repo_id = ? AND branch = ?`,
      )
      .get(repoId, branch) as {
      file_count: number;
      symbol_count: number;
      last_indexed_at: string | null;
    };
    return row;
  }

  setBranchIndexState(
    repoId: string,
    branch: string,
    headOid: string,
    fileCount: number,
    symbolCount: number,
    lastIndexedAt: string | null,
  ): void {
    this.db
      .prepare(
        `INSERT INTO branch_index_state
           (repo_id, branch, head_oid, file_count, symbol_count, last_indexed_at)
         VALUES (@repo_id, @branch, @head_oid, @file_count, @symbol_count, @last_indexed_at)
         ON CONFLICT (repo_id, branch) DO UPDATE SET
           head_oid = excluded.head_oid,
           file_count = excluded.file_count,
           symbol_count = excluded.symbol_count,
           last_indexed_at = excluded.last_indexed_at`,
      )
      .run({
        repo_id: repoId,
        branch,
        head_oid: headOid,
        file_count: fileCount,
        symbol_count: symbolCount,
        last_indexed_at: lastIndexedAt,
      });
  }

  getBranchIndexState(repoId: string, branch: string): BranchIndexState | undefined {
    return this.db
      .prepare('SELECT * FROM branch_index_state WHERE repo_id = ? AND branch = ?')
      .get(repoId, branch) as BranchIndexState | undefined;
  }

  close(): void {
    this.db.close();
  }
}
