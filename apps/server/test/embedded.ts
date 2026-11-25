import EmbeddedPostgres from 'embedded-postgres';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

export interface EmbeddedCluster {
  databaseUrl: string;
  port: number;
  stop(): Promise<void>;
}

/**
 * Dev/test-only: spin up a real, isolated Postgres 16 cluster on a free port
 * with a throwaway data dir. Never imported by production server code.
 */
export async function startEmbeddedPostgres(): Promise<EmbeddedCluster> {
  const dir = mkdtempSync(join(tmpdir(), 'weft-pg-'));
  const port = await freePort();
  const user = 'weft';
  const password = 'weft';
  const cluster = new EmbeddedPostgres({
    databaseDir: join(dir, 'db'),
    port,
    user,
    password,
    // We own data-dir removal (retried rmSync below). The library's persistent:false
    // path rm's the dir without retries right after taskkill, which EBUSYs on Windows.
    persistent: true,
    initdbFlags: ['--locale=C', '--encoding=UTF8'],
    onLog: () => {},
    onError: () => {},
  });
  await cluster.initialise();
  await cluster.start();
  return {
    databaseUrl: `postgres://${user}:${password}@127.0.0.1:${port}/postgres`,
    port,
    async stop() {
      try {
        await cluster.stop();
      } finally {
        try {
          rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
        } catch {
          /* best-effort: Windows may briefly lock files */
        }
      }
    },
  };
}
