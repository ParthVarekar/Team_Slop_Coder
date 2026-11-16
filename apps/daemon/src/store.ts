import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { openSqlite, migrate, DAEMON_MIGRATIONS, type SqliteDatabase } from '@weft/core';
import { isCoordinationEvent, type EventEnvelope } from '@weft/protocol';

export type StoredLocalEvent = EventEnvelope & { received_at: string; rowid?: number };

export interface EventQuery {
  projectId?: string;
  sessionId?: string;
  afterRowId?: number;
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

const EVENT_COLUMNS = `event_id, v, device_id, project_id, repo_id, session_id, provider_session_id,
  task_id, seq, ts, type, actor, payload, privacy, received_at`;

function eventParams(e: StoredLocalEvent): Record<string, unknown> {
  return {
    event_id: e.event_id,
    v: e.v,
    device_id: e.device_id,
    project_id: e.project_id,
    repo_id: e.repo_id ?? null,
    session_id: e.session_id ?? null,
    provider_session_id: e.provider_session_id ?? null,
    task_id: e.task_id ?? null,
    seq: e.seq ?? null,
    ts: e.ts,
    type: e.type,
    actor: JSON.stringify(e.actor),
    payload: JSON.stringify(e.payload),
    privacy: e.privacy,
    received_at: e.received_at ?? new Date().toISOString(),
  };
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
    const insertEvent = this.db.prepare(
      `INSERT OR IGNORE INTO events (${EVENT_COLUMNS})
       VALUES (@event_id, @v, @device_id, @project_id, @repo_id, @session_id, @provider_session_id,
               @task_id, @seq, @ts, @type, @actor, @payload, @privacy, @received_at)`,
    );
    const insertCoord = this.db.prepare(
      `INSERT OR IGNORE INTO coordination_events
         (event_id, v, device_id, project_id, repo_id, session_id, task_id, seq, ts, type, actor, payload, privacy, received_at)
       VALUES (@event_id, @v, @device_id, @project_id, @repo_id, @session_id, @task_id, @seq, @ts, @type, @actor, @payload, @privacy, @received_at)`,
    );
    const insertOutbox = this.db.prepare(
      `INSERT OR IGNORE INTO outbox (event_id, kind, envelope, created_at) VALUES (?, ?, ?, ?)`,
    );
    const tx = this.db.transaction((batch: StoredLocalEvent[]) => {
      for (const e of batch) {
        const params = eventParams(e);
        insertEvent.run(params);
        const durable = isCoordinationEvent(e.type);
        if (durable) insertCoord.run(params);
        if (teamMode) {
          insertOutbox.run(
            e.event_id,
            durable ? 'coordination' : 'telemetry',
            JSON.stringify(e),
            e.received_at,
          );
        }
      }
    });
    tx(events);
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
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT rowid, * FROM events ${where} ORDER BY rowid ASC LIMIT @limit`)
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

  close(): void {
    this.db.close();
  }
}
