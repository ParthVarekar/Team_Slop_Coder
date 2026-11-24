import { z } from 'zod';
import { LogLevelSchema, loadConfig, type LoadConfigOptions } from '@weft/core';
import { parseWebhookMasterKey, WebhookCryptoError } from './webhook-crypto.js';

export const WebhookConfigSchema = z.object({
  enabled: z.boolean().default(false),
  pollIntervalMs: z.number().int().min(100).max(60_000).default(1000),
  timeoutMs: z.number().int().min(100).max(120_000).default(10_000),
  concurrency: z.number().int().min(1).max(64).default(4),
  backoffBaseMs: z.number().int().min(1).max(300_000).default(500),
  backoffCapMs: z.number().int().min(1).max(3_600_000).default(30_000),
  maxAttempts: z.number().int().min(1).max(100).default(8),
  maxDeliveryAgeMs: z.number().int().min(1000).max(2_592_000_000).default(86_400_000),
  responseCapBytes: z.number().int().min(1024).max(1_048_576).default(16_384),
  /** Only WEFT_SERVER_WEBHOOK_MASTER_KEY should supply this in production. */
  masterKey: z.string().min(1).optional(),
  /** Explicit test/dev escape hatch; never enable for untrusted endpoints. */
  allowPrivateEndpoints: z.boolean().default(false),
});

export type WebhookConfig = z.infer<typeof WebhookConfigSchema>;
export const DEFAULT_WEBHOOK_CONFIG: WebhookConfig = WebhookConfigSchema.parse({});

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
  /** Optional for backwards-compatible programmatic config; loadServerConfig
   * always materializes the complete nested defaults. */
  webhooks: WebhookConfigSchema.optional(),
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
  WEFT_SERVER_WEBHOOKS_ENABLED: 'webhooks.enabled',
  WEFT_SERVER_WEBHOOK_POLL_INTERVAL_MS: 'webhooks.pollIntervalMs',
  WEFT_SERVER_WEBHOOK_TIMEOUT_MS: 'webhooks.timeoutMs',
  WEFT_SERVER_WEBHOOK_CONCURRENCY: 'webhooks.concurrency',
  WEFT_SERVER_WEBHOOK_BACKOFF_BASE_MS: 'webhooks.backoffBaseMs',
  WEFT_SERVER_WEBHOOK_BACKOFF_CAP_MS: 'webhooks.backoffCapMs',
  WEFT_SERVER_WEBHOOK_MAX_ATTEMPTS: 'webhooks.maxAttempts',
  WEFT_SERVER_WEBHOOK_MAX_DELIVERY_AGE_MS: 'webhooks.maxDeliveryAgeMs',
  WEFT_SERVER_WEBHOOK_RESPONSE_CAP_BYTES: 'webhooks.responseCapBytes',
  WEFT_SERVER_WEBHOOK_MASTER_KEY: 'webhooks.masterKey',
  WEFT_SERVER_WEBHOOK_ALLOW_PRIVATE_ENDPOINTS: 'webhooks.allowPrivateEndpoints',
};

const DEFAULTS: ServerConfigInput = {
  dataDir: '.weft-server',
  host: '127.0.0.1',
  port: 7420,
  databaseUrl: '',
  logLevel: 'info',
  corsOrigin: '*',
  webhooks: DEFAULT_WEBHOOK_CONFIG,
};

export function resolveWebhookConfig(config: ServerConfig | ServerConfigInput): WebhookConfig {
  const webhooks = WebhookConfigSchema.parse(config.webhooks ?? {});
  if (webhooks.backoffCapMs < webhooks.backoffBaseMs) {
    throw new WebhookCryptoError('webhook backoffCapMs must be at least backoffBaseMs');
  }
  if (webhooks.masterKey !== undefined) parseWebhookMasterKey(webhooks.masterKey);
  if (webhooks.enabled && webhooks.masterKey === undefined) {
    throw new WebhookCryptoError(
      'outbound webhooks are enabled but WEFT_SERVER_WEBHOOK_MASTER_KEY is not configured',
    );
  }
  return webhooks;
}

function omitFileWebhookMasterKey(file: unknown): unknown {
  if (typeof file !== 'object' || file === null || Array.isArray(file)) return file;
  const root = { ...(file as Record<string, unknown>) };
  const webhooks = root['webhooks'];
  if (typeof webhooks !== 'object' || webhooks === null || Array.isArray(webhooks)) return root;
  const safeWebhooks = { ...(webhooks as Record<string, unknown>) };
  delete safeWebhooks['masterKey'];
  root['webhooks'] = safeWebhooks;
  return root;
}

export function loadServerConfig(options: LoadConfigOptions = {}): ServerConfig {
  // The decryption master key is deliberately not accepted from config files.
  // Clone nested defaults for every load: loadConfig applies nested environment
  // paths in place, so sharing DEFAULT_WEBHOOK_CONFIG would retain a secret from
  // one invocation and leak it into later invocations.
  const config = loadConfig(
    ServerConfigSchema,
    {
      ...DEFAULTS,
      webhooks: { ...DEFAULT_WEBHOOK_CONFIG },
    },
    {
      ...options,
      file: omitFileWebhookMasterKey(options.file),
      envMap: SERVER_ENV_MAP,
    },
  );
  resolveWebhookConfig(config);
  return config;
}
