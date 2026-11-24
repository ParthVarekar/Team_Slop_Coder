#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { z } from 'zod';
import { loadConfig, mergeConfig } from '@weft/core';
import {
  loadServerConfig,
  ServerConfigSchema,
  SERVER_ENV_MAP,
  type ServerConfig,
} from './config.js';
import { createServer } from './server.js';

interface ParsedArgs {
  command: string;
  positionals: string[];
  flags: Record<string, string>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command = 'help', ...rest] = argv;
  const flags: Record<string, string> = {};
  const positionals: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] as string;
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = rest[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = 'true';
    }
  }
  return { command, positionals, flags };
}

function readFileFlag(flags: Record<string, string>): unknown {
  return flags.config ? JSON.parse(readFileSync(flags.config, 'utf8')) : undefined;
}

function resolveConfig(flags: Record<string, string>): ServerConfig {
  const file = readFileFlag(flags);
  const overrides: Record<string, unknown> = {};
  if (flags['data-dir']) overrides.dataDir = flags['data-dir'];
  if (flags['database-url']) overrides.databaseUrl = flags['database-url'];
  if (flags.host) overrides.host = flags.host;
  if (flags.port) overrides.port = Number(flags.port);
  if (flags['log-level']) overrides.logLevel = flags['log-level'];
  if (flags['cors-origin']) overrides.corsOrigin = flags['cors-origin'];
  // Fold flags into the file layer so required fields (databaseUrl) validate,
  // then re-apply them last so flags win over the environment.
  const fileObj =
    file && typeof file === 'object' && !Array.isArray(file)
      ? (file as Record<string, unknown>)
      : {};
  const base = loadServerConfig({ file: mergeConfig(fileObj, overrides) });
  return ServerConfigSchema.parse(
    mergeConfig(base as unknown as Record<string, unknown>, overrides),
  );
}

// status/stop only need the endpoint + data dir, not a database URL.
const ConnectionSchema = ServerConfigSchema.pick({ host: true, port: true, dataDir: true });
type Connection = z.infer<typeof ConnectionSchema>;

function resolveConnection(flags: Record<string, string>): Connection {
  const file = readFileFlag(flags);
  const base = loadConfig(ConnectionSchema, ConnectionSchema.parse({}), {
    ...(file ? { file } : {}),
    envMap: SERVER_ENV_MAP,
  });
  const overrides: Record<string, unknown> = {};
  if (flags['data-dir']) overrides.dataDir = flags['data-dir'];
  if (flags.host) overrides.host = flags.host;
  if (flags.port) overrides.port = Number(flags.port);
  return ConnectionSchema.parse(mergeConfig(base as unknown as Record<string, unknown>, overrides));
}

interface ServerState {
  pid: number;
  admin_secret: string;
  host: string;
  port: number;
}

function readState(dataDir: string): ServerState | null {
  const statePath = join(dataDir, 'server.json');
  if (!existsSync(statePath)) return null;
  return JSON.parse(readFileSync(statePath, 'utf8')) as ServerState;
}

const HELP = `weft-server — self-hosted team coordination server (one process + Postgres)

Usage: weft-server <command> [flags]

Commands:
  start      Run the team server in the foreground (applies central migrations)
  stop       Stop a running server (authenticated HTTP shutdown, pidfile fallback)
  status     Query a running server's /healthz

Flags:
  --config <file>        JSON config file
  --data-dir <dir>       State directory (default .weft-server)
  --database-url <url>   Postgres connection URL (required for start)
  --host <host>          API bind host (default 127.0.0.1)
  --port <port>          API bind port (default 7420)
  --log-level <lvl>      trace|debug|info|warn|error|fatal
  --cors-origin <list>   Browser origins allowed to call the API (default *;
                         comma-separated allowlist to restrict)

Environment:
  WEFT_DATABASE_URL, WEFT_SERVER_HOST, WEFT_SERVER_PORT,
  WEFT_SERVER_DATA_DIR, WEFT_LOG_LEVEL, WEFT_SERVER_CORS_ORIGIN
  WEFT_SERVER_WEBHOOKS_ENABLED, WEFT_SERVER_WEBHOOK_MASTER_KEY,
  WEFT_SERVER_WEBHOOK_POLL_INTERVAL_MS, WEFT_SERVER_WEBHOOK_TIMEOUT_MS,
  WEFT_SERVER_WEBHOOK_CONCURRENCY, WEFT_SERVER_WEBHOOK_BACKOFF_BASE_MS,
  WEFT_SERVER_WEBHOOK_BACKOFF_CAP_MS, WEFT_SERVER_WEBHOOK_MAX_ATTEMPTS,
  WEFT_SERVER_WEBHOOK_MAX_DELIVERY_AGE_MS, WEFT_SERVER_WEBHOOK_RESPONSE_CAP_BYTES,
  WEFT_SERVER_WEBHOOK_ALLOW_PRIVATE_ENDPOINTS
  The webhook master key is environment-only (32-byte hex or base64).
`;

async function start(flags: Record<string, string>): Promise<void> {
  const config = resolveConfig(flags);
  const adminSecret = randomBytes(32).toString('hex');
  const statePath = join(config.dataDir, 'server.json');

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    server.logger.info({ signal }, 'shutting down');
    await server.close();
    if (existsSync(statePath)) rmSync(statePath);
    process.exit(0);
  };

  const server = await createServer(config, {
    adminSecret,
    onShutdown: () => void shutdown('http-request'),
  });
  const address = await server.listen();
  mkdirSync(config.dataDir, { recursive: true });
  writeFileSync(
    statePath,
    JSON.stringify(
      { pid: process.pid, admin_secret: adminSecret, host: config.host, port: config.port },
      null,
      2,
    ),
  );
  server.logger.info({ address, pid: process.pid, dataDir: config.dataDir }, 'weft server ready');
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

async function status(flags: Record<string, string>): Promise<void> {
  const conn = resolveConnection(flags);
  const state = readState(conn.dataDir);
  const host = state?.host ?? conn.host;
  const port = state?.port ?? conn.port;
  const url = `http://${host}:${port}/healthz`;
  try {
    const res = await fetch(url);
    console.log(JSON.stringify(await res.json(), null, 2));
  } catch {
    console.error(`weft server not reachable at ${url}`);
    process.exitCode = 1;
  }
}

async function stop(flags: Record<string, string>): Promise<void> {
  const conn = resolveConnection(flags);
  const state = readState(conn.dataDir);
  if (!state) {
    console.error('no running server (server.json absent); start it first (weft-server start)');
    process.exitCode = 1;
    return;
  }
  const statePath = join(conn.dataDir, 'server.json');
  const base = `http://${state.host}:${state.port}`;
  // Prefer the authenticated HTTP shutdown: it runs cleanup on every platform
  // (process.kill signals are unreliable on Windows).
  try {
    const res = await fetch(`${base}/v1/shutdown`, {
      method: 'POST',
      headers: { authorization: `Bearer ${state.admin_secret}` },
    });
    if (res.ok) {
      console.log('server shutting down gracefully');
      return;
    }
  } catch {
    /* not reachable over HTTP; fall back to signalling the pidfile */
  }
  try {
    process.kill(state.pid, 'SIGTERM');
    console.log(`sent SIGTERM to server pid ${state.pid}`);
  } catch (err) {
    console.error(`could not signal pid ${state.pid}: ${String(err)}`);
    rmSync(statePath);
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv.slice(2));
  try {
    switch (command) {
      case 'start':
        await start(flags);
        break;
      case 'stop':
        await stop(flags);
        break;
      case 'status':
        await status(flags);
        break;
      default:
        console.log(HELP);
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

void main();
