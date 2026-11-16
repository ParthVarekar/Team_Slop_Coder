import Database from 'better-sqlite3';

export type SqliteDatabase = Database.Database;

export interface OpenSqliteOptions {
  readonly?: boolean;
  fileMustExist?: boolean;
  /** Enable WAL + NORMAL synchronous (default true for writable databases). */
  wal?: boolean;
  busyTimeoutMs?: number;
}

/**
 * Open a SQLite database tuned for the daemon hot path: WAL for concurrent
 * read/write, NORMAL synchronous (batched txns amortize fsync), foreign keys on.
 */
export function openSqlite(path: string, options: OpenSqliteOptions = {}): SqliteDatabase {
  const db = new Database(path, {
    readonly: options.readonly ?? false,
    fileMustExist: options.fileMustExist ?? false,
  });
  if (!options.readonly) {
    if (options.wal !== false) {
      db.pragma('journal_mode = WAL');
      db.pragma('synchronous = NORMAL');
    }
    db.pragma('foreign_keys = ON');
    db.pragma(`busy_timeout = ${options.busyTimeoutMs ?? 5000}`);
  }
  return db;
}
