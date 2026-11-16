import { z } from 'zod';
import { LogLevelSchema, loadConfig, type LoadConfigOptions } from '@weft/core';

/** Team-server configuration. databaseUrl is required (Postgres 16+). */
export const ServerConfigSchema = z.object({
  dataDir: z.string().min(1).default('.weft-server'),
  host: z.string().min(1).default('127.0.0.1'),
  port: z.number().int().min(1).max(65535).default(7420),
  databaseUrl: z.string().min(1),
  logLevel: LogLevelSchema.default('info'),
  /** Browser origins allowed to call the API. '*' (default) suits the
   * bearer-token model (the token, not a cookie, is the secret); set a
   * comma-separated allowlist to lock the API to specific UI origins. */
  corsOrigin: z.string().min(1).default('*'),
});

export type ServerConfig = z.infer<typeof ServerConfigSchema>;
export type ServerConfigInput = z.input<typeof ServerConfigSchema>;

export const SERVER_ENV_MAP: Record<string, string> = {
  WEFT_SERVER_DATA_DIR: 'dataDir',
  WEFT_SERVER_HOST: 'host',
  WEFT_SERVER_PORT: 'port',
  WEFT_DATABASE_URL: 'databaseUrl',
  WEFT_LOG_LEVEL: 'logLevel',
  WEFT_SERVER_CORS_ORIGIN: 'corsOrigin',
};

const DEFAULTS: ServerConfigInput = {
  dataDir: '.weft-server',
  host: '127.0.0.1',
  port: 7420,
  databaseUrl: '',
  logLevel: 'info',
  corsOrigin: '*',
};

export function loadServerConfig(options: LoadConfigOptions = {}): ServerConfig {
  return loadConfig(ServerConfigSchema, DEFAULTS, { ...options, envMap: SERVER_ENV_MAP });
}