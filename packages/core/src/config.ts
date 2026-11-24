import { z } from 'zod';

export const LogLevelSchema = z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);
export const ModeSchema = z.enum(['solo', 'team']);
export const SyncScopeSchema = z.enum(['metadata', 'diffs', 'full']);
export const ValidationSelectionSchema = z.enum(['full', 'affected']);

/**
 * A project-configured validation check. Commands are operator-authored local
 * config (never supplied by a remote request) and run with shell:false, so the
 * executable + argv are executed directly without shell metacharacter injection.
 */
export const ValidationCheckConfigSchema = z.object({
  check_id: z.string().min(1).max(100),
  command: z.string().min(1).max(1000),
  args: z.array(z.string().max(2000)).max(200).default([]),
  timeoutMs: z.number().int().positive().max(3_600_000).optional(),
  selection: ValidationSelectionSchema.default('full'),
});
export type ValidationCheckConfig = z.infer<typeof ValidationCheckConfigSchema>;

/** Canonical Weft daemon/server configuration. Validated once at startup. */
export const WeftConfigSchema = z.object({
  dataDir: z.string().min(1).default('.weft'),
  logLevel: LogLevelSchema.default('info'),
  mode: ModeSchema.default('solo'),
  server: z
    .object({
      url: z.string().url().nullable().default(null),
      projectId: z.string().nullable().default(null),
      deviceId: z.string().nullable().default(null),
      /** Project-scoped API token authenticating the daemon to the team server. */
      token: z.string().nullable().default(null),
    })
    .default({}),
  hooks: z
    .object({
      host: z.string().min(1).default('127.0.0.1'),
      port: z.number().int().min(1).max(65535).default(7421),
    })
    .default({}),
  privacy: z
    .object({
      syncScope: SyncScopeSchema.default('metadata'),
      redactSecrets: z.boolean().default(true),
    })
    .default({}),
  git: z.object({ binary: z.string().min(1).default('git') }).default({}),
  validation: z
    .object({
      /** Max concurrent validation runs; defaults to cpuCount-1 at runtime. */
      concurrency: z.number().int().min(1).max(64).optional(),
      timeoutMs: z.number().int().positive().max(3_600_000).default(120_000),
      outputCapBytes: z
        .number()
        .int()
        .positive()
        .max(64 * 1024 * 1024)
        .default(1_048_576),
      excerptBytes: z.number().int().positive().max(1_048_576).default(4096),
      checks: z.array(ValidationCheckConfigSchema).max(50).default([]),
    })
    .default({}),
  retention: z
    .object({
      telemetryDays: z.number().int().positive().default(90),
      /** Preview scheduling may be enabled; destructive apply is always manual. */
      schedulerEnabled: z.boolean().default(false),
      batchLimit: z.number().int().min(1).max(1000).default(1000),
    })
    .default({}),
  recap: z
    .object({
      enabled: z.boolean().default(false),
      endpoint: z.string().url().nullable().default(null),
      token: z.string().nullable().default(null),
      model: z.string().min(1).max(200).nullable().default(null),
      maxChars: z.number().int().min(1).max(400).default(400),
      timeoutMs: z.number().int().min(100).max(10_000).default(3000),
    })
    .default({}),
  resolver: z
    .object({
      /** Exact reference resolution runs in a separate process with its own budget. */
      enabled: z.boolean().default(true),
      maxMemoryMb: z.number().int().min(128).max(8192).default(1024),
      idleTimeoutMs: z.number().int().positive().max(3_600_000).default(600_000),
      requestTimeoutMs: z.number().int().positive().max(120_000).default(30_000),
    })
    .default({}),
});

export type WeftConfig = z.infer<typeof WeftConfigSchema>;
export type WeftConfigInput = z.input<typeof WeftConfigSchema>;
export type ValidationConfig = WeftConfig['validation'];
export type ResolverConfig = WeftConfig['resolver'];

/** Environment variable → dotted config path. */
export const WEFT_ENV_MAP: Record<string, string> = {
  WEFT_DATA_DIR: 'dataDir',
  WEFT_LOG_LEVEL: 'logLevel',
  WEFT_MODE: 'mode',
  WEFT_SERVER_URL: 'server.url',
  WEFT_PROJECT_ID: 'server.projectId',
  WEFT_DEVICE_ID: 'server.deviceId',
  WEFT_SERVER_TOKEN: 'server.token',
  WEFT_HOOK_HOST: 'hooks.host',
  WEFT_HOOK_PORT: 'hooks.port',
  WEFT_SYNC_SCOPE: 'privacy.syncScope',
  WEFT_REDACT_SECRETS: 'privacy.redactSecrets',
  WEFT_GIT_BINARY: 'git.binary',
  WEFT_VALIDATION_TIMEOUT_MS: 'validation.timeoutMs',
  WEFT_VALIDATION_CONCURRENCY: 'validation.concurrency',
  WEFT_TELEMETRY_DAYS: 'retention.telemetryDays',
  WEFT_RETENTION_SCHEDULER: 'retention.schedulerEnabled',
  WEFT_RETENTION_BATCH_LIMIT: 'retention.batchLimit',
  WEFT_RECAP_ENABLED: 'recap.enabled',
  WEFT_RECAP_ENDPOINT: 'recap.endpoint',
  WEFT_RECAP_TOKEN: 'recap.token',
  WEFT_RECAP_MODEL: 'recap.model',
  WEFT_RESOLVER_ENABLED: 'resolver.enabled',
  WEFT_RESOLVER_MAX_MB: 'resolver.maxMemoryMb',
  WEFT_RESOLVER_IDLE_MS: 'resolver.idleTimeoutMs',
  WEFT_RESOLVER_REQUEST_TIMEOUT_MS: 'resolver.requestTimeoutMs',
};

type Plain = Record<string, unknown>;

function isPlainObject(value: unknown): value is Plain {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Recursively merge override into base; arrays and scalars replace wholesale. */
export function mergeConfig(base: Plain, override: Plain): Plain {
  const out: Plain = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const existing = out[key];
    out[key] =
      isPlainObject(existing) && isPlainObject(value) ? mergeConfig(existing, value) : value;
  }
  return out;
}

function getPath(obj: Plain, path: string): unknown {
  let current: unknown = obj;
  for (const part of path.split('.')) {
    if (!isPlainObject(current)) return undefined;
    current = current[part];
  }
  return current;
}

function setPath(obj: Plain, path: string, value: unknown): void {
  const parts = path.split('.');
  let current: Plain = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i] as string;
    const next = current[part];
    if (!isPlainObject(next)) {
      current[part] = {};
    }
    current = current[part] as Plain;
  }
  current[parts[parts.length - 1] as string] = value;
}

function coerceLike(raw: string, sample: unknown): unknown {
  if (typeof sample === 'number') {
    const n = Number(raw);
    return Number.isNaN(n) ? raw : n;
  }
  if (typeof sample === 'boolean') {
    return raw === 'true' || raw === '1';
  }
  if (sample === null) {
    if (raw === 'null' || raw === '') return null;
    return raw;
  }
  return raw;
}

export interface LoadConfigOptions {
  /** Parsed config file contents (JSON), if any. */
  file?: unknown;
  /** Environment lookup (defaults to process.env). */
  env?: Record<string, string | undefined>;
  /** Env var → config path mapping (defaults to WEFT_ENV_MAP). */
  envMap?: Record<string, string>;
}

/**
 * Layered configuration: defaults < file < environment, then zod-validated.
 * The defaults object supplies both fallback values and env-coercion types.
 */
export function loadConfig<S extends z.ZodTypeAny>(
  schema: S,
  defaults: z.input<S>,
  options: LoadConfigOptions = {},
): z.output<S> {
  const env = options.env ?? process.env;
  const envMap = options.envMap ?? WEFT_ENV_MAP;
  let merged = mergeConfig({}, defaults as Plain);
  if (isPlainObject(options.file)) {
    merged = mergeConfig(merged, options.file);
  }
  for (const [envVar, path] of Object.entries(envMap)) {
    const raw = env[envVar];
    if (raw === undefined) continue;
    setPath(merged, path, coerceLike(raw, getPath(merged, path)));
  }
  return schema.parse(merged);
}

export function loadWeftConfig(options: LoadConfigOptions = {}): WeftConfig {
  return loadConfig(WeftConfigSchema, WeftConfigSchema.parse({}), options);
}
