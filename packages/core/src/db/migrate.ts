import type { SqliteDatabase } from './sqlite.js';

export interface Migration {
  /** Lexically ordered unique id, e.g. "0001_init". */
  id: string;
  up: string;
  down: string;
}

export interface MigrateResult {
  applied: string[];
}

export interface MigrationStatus {
  id: string;
  applied: boolean;
}

function ensureMigrationsTable(db: SqliteDatabase): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       id TEXT PRIMARY KEY,
       applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
     )`,
  );
}

function appliedIds(db: SqliteDatabase): Set<string> {
  const rows = db.prepare('SELECT id FROM schema_migrations').all() as { id: string }[];
  return new Set(rows.map((r) => r.id));
}

function ordered(migrations: Migration[]): Migration[] {
  return [...migrations].sort((a, b) => a.id.localeCompare(b.id));
}

/** Apply all pending migrations in order, each in its own transaction. */
export function migrate(db: SqliteDatabase, migrations: Migration[]): MigrateResult {
  ensureMigrationsTable(db);
  const applied = appliedIds(db);
  const insert = db.prepare('INSERT INTO schema_migrations (id) VALUES (?)');
  const newlyApplied: string[] = [];
  for (const migration of ordered(migrations)) {
    if (applied.has(migration.id)) continue;
    const run = db.transaction(() => {
      db.exec(migration.up);
      insert.run(migration.id);
    });
    run();
    newlyApplied.push(migration.id);
  }
  return { applied: newlyApplied };
}

/** Roll back the most recently applied `steps` migrations (reverse order). */
export function rollback(
  db: SqliteDatabase,
  migrations: Migration[],
  steps = 1,
): { rolledBack: string[] } {
  ensureMigrationsTable(db);
  const applied = appliedIds(db);
  const target = ordered(migrations)
    .filter((m) => applied.has(m.id))
    .reverse()
    .slice(0, steps);
  const del = db.prepare('DELETE FROM schema_migrations WHERE id = ?');
  const rolledBack: string[] = [];
  for (const migration of target) {
    const run = db.transaction(() => {
      db.exec(migration.down);
      del.run(migration.id);
    });
    run();
    rolledBack.push(migration.id);
  }
  return { rolledBack };
}

export function migrationStatus(db: SqliteDatabase, migrations: Migration[]): MigrationStatus[] {
  ensureMigrationsTable(db);
  const applied = appliedIds(db);
  return ordered(migrations).map((m) => ({ id: m.id, applied: applied.has(m.id) }));
}
