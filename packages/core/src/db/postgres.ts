/**
 * Postgres migration runner. Decoupled from any specific client so M2 can wire
 * `pg` while M0 tests the ordering/transaction logic against a mock executor.
 */
export interface PgExecutor {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface PgMigration {
  id: string;
  up: string;
  down: string;
}

function ordered(migrations: PgMigration[]): PgMigration[] {
  return [...migrations].sort((a, b) => a.id.localeCompare(b.id));
}

async function appliedIds(exec: PgExecutor): Promise<Set<string>> {
  const { rows } = await exec.query('SELECT id FROM schema_migrations');
  return new Set(rows.map((r) => r.id as string));
}

export async function migratePostgres(
  exec: PgExecutor,
  migrations: PgMigration[],
): Promise<{ applied: string[] }> {
  await exec.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       id TEXT PRIMARY KEY,
       applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
  );
  const applied = await appliedIds(exec);
  const newlyApplied: string[] = [];
  for (const migration of ordered(migrations)) {
    if (applied.has(migration.id)) continue;
    await exec.query('BEGIN');
    try {
      await exec.query(migration.up);
      await exec.query('INSERT INTO schema_migrations (id) VALUES ($1)', [migration.id]);
      await exec.query('COMMIT');
    } catch (err) {
      await exec.query('ROLLBACK');
      throw err;
    }
    newlyApplied.push(migration.id);
  }
  return { applied: newlyApplied };
}

export async function rollbackPostgres(
  exec: PgExecutor,
  migrations: PgMigration[],
  steps = 1,
): Promise<{ rolledBack: string[] }> {
  await exec.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       id TEXT PRIMARY KEY,
       applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
  );
  const applied = await appliedIds(exec);
  const target = ordered(migrations)
    .filter((m) => applied.has(m.id))
    .reverse()
    .slice(0, steps);
  const rolledBack: string[] = [];
  for (const migration of target) {
    await exec.query('BEGIN');
    try {
      await exec.query(migration.down);
      await exec.query('DELETE FROM schema_migrations WHERE id = $1', [migration.id]);
      await exec.query('COMMIT');
    } catch (err) {
      await exec.query('ROLLBACK');
      throw err;
    }
    rolledBack.push(migration.id);
  }
  return { rolledBack };
}
