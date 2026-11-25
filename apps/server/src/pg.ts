import pg from 'pg';
import type { Client, Pool } from 'pg';
import type { PgExecutor } from '@weft/core';

// BIGINT (int8) arrives as a string by default. global_seq/seq stay well within
// Number.MAX_SAFE_INTEGER at team scale, so parse to number for downstream use.
pg.types.setTypeParser(20, (value) => Number(value));

/** Single-connection executor: keeps BEGIN/COMMIT on one client (migrations). */
export function clientExecutor(client: Client): PgExecutor {
  return {
    async query(sql, params) {
      const res = await client.query(sql, params);
      return { rows: res.rows as Record<string, unknown>[] };
    },
  };
}

/** Pool executor for autocommit reads/writes. */
export function poolExecutor(pool: Pool): PgExecutor {
  return {
    async query(sql, params) {
      const res = await pool.query(sql, params);
      return { rows: res.rows as Record<string, unknown>[] };
    },
  };
}

/** Run `fn` inside a transaction on a dedicated client; rolls back on error. */
export async function withTransaction<T>(
  pool: Pool,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
