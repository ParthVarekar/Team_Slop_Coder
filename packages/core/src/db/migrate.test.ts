import { describe, expect, it } from 'vitest';
import {
  openSqlite,
  migrate,
  rollback,
  migrationStatus,
  DAEMON_MIGRATIONS,
  SERVER_MIGRATIONS,
  migratePostgres,
  rollbackPostgres,
  type Migration,
  type PgExecutor,
  type PgMigration,
} from '@weft/core';

function tableNames(db: ReturnType<typeof openSqlite>): string[] {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {
    name: string;
  }[];
  return rows.map((r) => r.name);
}

describe('SQLite migrations', () => {
  it('bounds the native page cache for writable databases', () => {
    const db = openSqlite(':memory:');
    expect(db.pragma('cache_size', { simple: true })).toBe(-4096);
    db.close();
  });

  it('applies the initial schema and is idempotent', () => {
    const db = openSqlite(':memory:');
    const first = migrate(db, DAEMON_MIGRATIONS);
    expect(first.applied).toEqual(DAEMON_MIGRATIONS.map((m) => m.id));
    const tables = tableNames(db);
    for (const t of [
      'events',
      'outbox',
      'coordination_events',
      'tasks',
      'symbols',
      'validation_runs',
      'repos',
      'repo_files',
      'sync_state',
    ]) {
      expect(tables).toContain(t);
    }
    expect(migrate(db, DAEMON_MIGRATIONS).applied).toEqual([]);
    db.close();
  });

  it('rolls back the schema', () => {
    const db = openSqlite(':memory:');
    migrate(db, DAEMON_MIGRATIONS);
    const result = rollback(db, DAEMON_MIGRATIONS, DAEMON_MIGRATIONS.length);
    expect(result.rolledBack).toEqual([...DAEMON_MIGRATIONS].reverse().map((m) => m.id));
    expect(tableNames(db)).not.toContain('events');
    expect(tableNames(db)).not.toContain('repos');
    expect(tableNames(db)).not.toContain('sync_state');
    expect(migrationStatus(db, DAEMON_MIGRATIONS)[0]?.applied).toBe(false);
    db.close();
  });

  it('a failing migration is atomic and not recorded', () => {
    const db = openSqlite(':memory:');
    const bad: Migration[] = [
      { id: '0001_bad', up: 'CREATE TABLE ok (x); THIS IS NOT SQL;', down: 'DROP TABLE ok;' },
    ];
    expect(() => migrate(db, bad)).toThrow();
    expect(tableNames(db)).not.toContain('ok');
    expect(migrationStatus(db, bad)[0]?.applied).toBe(false);
    db.close();
  });

  it('supports up/down round-trip across multiple migrations', () => {
    const db = openSqlite(':memory:');
    const migs: Migration[] = [
      { id: '0001_a', up: 'CREATE TABLE a (x);', down: 'DROP TABLE a;' },
      { id: '0002_b', up: 'CREATE TABLE b (x);', down: 'DROP TABLE b;' },
    ];
    expect(migrate(db, migs).applied).toEqual(['0001_a', '0002_b']);
    expect(rollback(db, migs, 1).rolledBack).toEqual(['0002_b']);
    expect(tableNames(db)).toContain('a');
    expect(tableNames(db)).not.toContain('b');
    expect(migrate(db, migs).applied).toEqual(['0002_b']);
    db.close();
  });
});

class FakePg implements PgExecutor {
  applied = new Set<string>();
  log: string[] = [];
  failOn: string | null = null;

  async query(sql: string, params: unknown[] = []): Promise<{ rows: Record<string, unknown>[] }> {
    const trimmed = sql.trim();
    this.log.push(trimmed.split('\n')[0] as string);
    if (trimmed.startsWith('CREATE TABLE IF NOT EXISTS schema_migrations')) return { rows: [] };
    if (trimmed.startsWith('SELECT id FROM schema_migrations')) {
      return { rows: [...this.applied].map((id) => ({ id })) };
    }
    if (trimmed.startsWith('INSERT INTO schema_migrations')) {
      this.applied.add(params[0] as string);
      return { rows: [] };
    }
    if (trimmed.startsWith('DELETE FROM schema_migrations')) {
      this.applied.delete(params[0] as string);
      return { rows: [] };
    }
    if (trimmed === 'BEGIN' || trimmed === 'COMMIT' || trimmed === 'ROLLBACK') return { rows: [] };
    if (this.failOn && trimmed.includes(this.failOn)) throw new Error('boom');
    return { rows: [] };
  }
}

describe('Postgres migrations (mock executor)', () => {
  const migs: PgMigration[] = [
    { id: '0001_a', up: 'CREATE TABLE a;', down: 'DROP TABLE a;' },
    { id: '0002_b', up: 'CREATE TABLE b;', down: 'DROP TABLE b;' },
  ];

  it('applies in order, idempotently, within transactions', async () => {
    const pg = new FakePg();
    expect((await migratePostgres(pg, migs)).applied).toEqual(['0001_a', '0002_b']);
    expect((await migratePostgres(pg, migs)).applied).toEqual([]);
    expect(pg.log.filter((l) => l === 'BEGIN')).toHaveLength(2);
    expect(pg.log.filter((l) => l === 'COMMIT')).toHaveLength(2);
  });

  it('rolls back on failure and does not record the migration', async () => {
    const pg = new FakePg();
    pg.failOn = 'CREATE TABLE a';
    await expect(migratePostgres(pg, migs)).rejects.toThrow('boom');
    expect(pg.applied.has('0001_a')).toBe(false);
    expect(pg.log).toContain('ROLLBACK');
  });

  it('rolls back applied migrations in reverse', async () => {
    const pg = new FakePg();
    await migratePostgres(pg, migs);
    expect((await rollbackPostgres(pg, migs, 1)).rolledBack).toEqual(['0002_b']);
    expect(pg.applied.has('0002_b')).toBe(false);
    expect(pg.applied.has('0001_a')).toBe(true);
  });

  it('central migration set is non-empty and ordered', () => {
    expect(SERVER_MIGRATIONS.length).toBeGreaterThan(0);
    expect(SERVER_MIGRATIONS[0]?.id).toBe('0001_init');
  });
});
