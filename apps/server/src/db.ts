import pg from 'pg';
import type { Pool } from 'pg';
import { migratePostgres, SERVER_MIGRATIONS, type Logger } from '@weft/core';
import { clientExecutor } from './pg.js';

export interface CentralDatabase {
  pool: Pool;
  close(): Promise<void>;
}

/**
 * Connect a Postgres pool and apply the central migrations on a dedicated
 * client (so each migration's BEGIN/COMMIT stays on one connection).
 */
export async function openCentralDatabase(
  databaseUrl: string,
  logger?: Logger,
): Promise<CentralDatabase> {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });
  const client = await pool.connect();
  try {
    const { applied } = await migratePostgres(clientExecutor(client), SERVER_MIGRATIONS);
    if (applied.length > 0) logger?.info({ applied }, 'central migrations applied');
  } catch (err) {
    client.release();
    await pool.end();
    throw err;
  }
  client.release();
  return { pool, close: () => pool.end() };
}