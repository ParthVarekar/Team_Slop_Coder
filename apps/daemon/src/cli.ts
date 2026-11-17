#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { loadWeftConfig, mergeConfig, WeftConfigSchema, type WeftConfig } from '@weft/core';
import { Daemon } from './daemon.js';
import { createApiServer } from './api.js';

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

function resolveConfig(flags: Record<string, string>): WeftConfig {
  const file = flags.config ? JSON.parse(readFileSync(flags.config, 'utf8')) : undefined;
  const base = loadWeftConfig(file ? { file } : {});
  const overrides: Record<string, unknown> = {};
  if (flags['data-dir']) overrides.dataDir = flags['data-dir'];
  if (flags.mode) overrides.mode = flags.mode;
  if (flags['log-level']) overrides.logLevel = flags['log-level'];
  const hooks: Record<string, unknown> = {};
  if (flags.host) hooks.host = flags.host;
  if (flags.port) hooks.port = Number(flags.port);
  if (Object.keys(hooks).length) overrides.hooks = hooks;
  return WeftConfigSchema.parse(mergeConfig(base as unknown as Record<string, unknown>, overrides));
}

const HELP = `weft — local multi-agent coordination daemon

Usage: weft <command> [flags]

Commands:
  start      Run the daemon + local API in the foreground
  stop       Stop a running daemon (via pidfile)
  status     Query a running daemon's /healthz
  mcp        Run the MCP coordination server over stdio (agent integration;
             requires a running daemon: weft start)
  repo       Manage watched repositories against a running daemon:
               repo add <path>    Register + watch a git repository
               repo list          List active repositories
               repo scan <id>     Force a git-status reconciliation
               repo wip <id>      Snapshot uncommitted work to the auto-WIP ref

Flags:
  --config <file>    JSON config file
  --data-dir <dir>   Data directory (default .weft)
  --host <host>      API bind host (default 127.0.0.1)
  --port <port>      API bind port (default 7421)
  --mode <mode>      solo | team (default solo)
  --log-level <lvl>  trace|debug|info|warn|error|fatal
`;

async function start(flags: Record<string, string>): Promise<void> {
  const config = resolveConfig(flags);
  const daemon = new Daemon({ config });
  await daemon.start();
  const pidPath = join(config.dataDir, 'daemon.pid');

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    daemon.logger.info({ signal }, 'shutting down');
    await api.close();
    await daemon.stop();
    if (existsSync(pidPath)) rmSync(pidPath);
    process.exit(0);
  };
  const api = createApiServer(daemon, { onShutdown: () => void shutdown('http-request') });
  const address = await api.listen();
  writeFileSync(pidPath, String(process.pid));
  daemon.logger.info({ address, pid: process.pid }, 'weft listening');
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

async function status(flags: Record<string, string>): Promise<void> {
  const config = resolveConfig(flags);
  const url = `http://${config.hooks.host}:${config.hooks.port}/healthz`;
  try {
    const res = await fetch(url);
    console.log(JSON.stringify(await res.json(), null, 2));
  } catch {
    console.error(`weft daemon not reachable at ${url}`);
    process.exitCode = 1;
  }
}

async function stop(flags: Record<string, string>): Promise<void> {
  const config = resolveConfig(flags);
  const identityPath = join(config.dataDir, 'identity.json');
  const pidPath = join(config.dataDir, 'daemon.pid');
  // Prefer the authenticated HTTP shutdown: it runs the final flush + cleanup on
  // every platform (process.kill signals are unreliable on Windows).
  if (existsSync(identityPath)) {
    const identity = JSON.parse(readFileSync(identityPath, 'utf8')) as { hook_secret?: string };
    if (identity.hook_secret) {
      try {
        const res = await fetch(`http://${config.hooks.host}:${config.hooks.port}/v1/shutdown`, {
          method: 'POST',
          headers: { authorization: `Bearer ${identity.hook_secret}` },
        });
        if (res.ok) {
          console.log('daemon shutting down gracefully');
          return;
        }
      } catch {
        /* not reachable over HTTP; fall back to signalling the pidfile */
      }
    }
  }
  if (!existsSync(pidPath)) {
    console.error('no running daemon (pidfile absent)');
    process.exitCode = 1;
    return;
  }
  const pid = Number(readFileSync(pidPath, 'utf8'));
  try {
    process.kill(pid, 'SIGTERM');
    console.log(`sent SIGTERM to daemon pid ${pid}`);
  } catch (err) {
    console.error(`could not signal pid ${pid}: ${String(err)}`);
    rmSync(pidPath);
    process.exitCode = 1;
  }
}

async function repoCommand(positionals: string[], flags: Record<string, string>): Promise<void> {
  const config = resolveConfig(flags);
  const sub = positionals[0] ?? 'list';
  const arg = positionals[1];
  const identityPath = join(config.dataDir, 'identity.json');
  if (!existsSync(identityPath)) {
    console.error('no daemon identity found; start the daemon first (weft start)');
    process.exitCode = 1;
    return;
  }
  const identity = JSON.parse(readFileSync(identityPath, 'utf8')) as { hook_secret?: string };
  const base = `http://${config.hooks.host}:${config.hooks.port}`;
  const authHeader = { authorization: `Bearer ${identity.hook_secret ?? ''}` };
  const call = async (
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Record<string, unknown> | null> => {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...authHeader,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      console.error(`${res.status} ${JSON.stringify(json)}`);
      process.exitCode = 1;
      return null;
    }
    return json;
  };
  try {
    switch (sub) {
      case 'add': {
        if (!arg) {
          console.error('usage: weft repo add <path>');
          process.exitCode = 1;
          return;
        }
        const r = await call('POST', '/v1/repos', { path: arg });
        if (r) console.log(JSON.stringify(r.repo, null, 2));
        break;
      }
      case 'list': {
        const r = await call('GET', '/v1/repos');
        if (r) console.log(JSON.stringify(r, null, 2));
        break;
      }
      case 'scan':
      case 'wip': {
        if (!arg) {
          console.error(`usage: weft repo ${sub} <repo_id>`);
          process.exitCode = 1;
          return;
        }
        const r = await call('POST', `/v1/repos/${arg}/${sub}`);
        if (r) console.log(JSON.stringify(r, null, 2));
        break;
      }
      default:
        console.error(`unknown repo subcommand: ${sub}`);
        process.exitCode = 1;
    }
  } catch {
    console.error(`weft daemon not reachable at ${base}`);
    process.exitCode = 1;
  }
}

async function mcpCommand(flags: Record<string, string>): Promise<void> {
  const config = resolveConfig(flags);
  const identityPath = join(config.dataDir, 'identity.json');
  if (!existsSync(identityPath)) {
    console.error('no daemon identity found; start the daemon first (weft start)');
    process.exitCode = 1;
    return;
  }
  const identity = JSON.parse(readFileSync(identityPath, 'utf8')) as { hook_secret?: string };
  const baseUrl = `http://${config.hooks.host}:${config.hooks.port}`;
  // Lazy-load the MCP SDK so `weft start` never pays for it. stdout is reserved
  // for the JSON-RPC transport; all diagnostics go to stderr.
  const { connectStdioMcp } = await import('./mcp-client.js');
  const handle = await connectStdioMcp({ baseUrl, secret: identity.hook_secret ?? '' });
  const shutdown = async (): Promise<void> => {
    await handle.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

async function main(): Promise<void> {
  const { command, positionals, flags } = parseArgs(process.argv.slice(2));
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
    case 'mcp':
      await mcpCommand(flags);
      break;
    case 'repo':
      await repoCommand(positionals, flags);
      break;
    default:
      console.log(HELP);
  }
}

void main();
