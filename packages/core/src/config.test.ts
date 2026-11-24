import { describe, expect, it } from 'vitest';
import {
  WeftConfigSchema,
  loadConfig,
  loadWeftConfig,
  mergeConfig,
  WEFT_ENV_MAP,
} from '@weft/core';

describe('mergeConfig', () => {
  it('deep-merges objects and replaces arrays/scalars', () => {
    const base = { a: 1, nested: { x: 1, y: 2 }, list: [1, 2] };
    const override = { nested: { y: 9 }, list: [3] };
    expect(mergeConfig(base, override)).toEqual({ a: 1, nested: { x: 1, y: 9 }, list: [3] });
  });
});

describe('loadConfig layering', () => {
  it('applies defaults when nothing else is provided', () => {
    const cfg = loadConfig(WeftConfigSchema, WeftConfigSchema.parse({}), { env: {} });
    expect(cfg.hooks.port).toBe(7421);
    expect(cfg.privacy.syncScope).toBe('metadata');
    expect(cfg.mode).toBe('solo');
  });

  it('file overrides defaults', () => {
    const cfg = loadConfig(WeftConfigSchema, WeftConfigSchema.parse({}), {
      file: { hooks: { port: 9000 } },
      env: {},
    });
    expect(cfg.hooks.port).toBe(9000);
    expect(cfg.hooks.host).toBe('127.0.0.1');
  });

  it('env overrides file and coerces types', () => {
    const cfg = loadConfig(WeftConfigSchema, WeftConfigSchema.parse({}), {
      file: { hooks: { port: 9000 }, retention: { telemetryDays: 30 } },
      env: { WEFT_HOOK_PORT: '1234', WEFT_REDACT_SECRETS: 'false', WEFT_TELEMETRY_DAYS: '7' },
    });
    expect(cfg.hooks.port).toBe(1234);
    expect(cfg.privacy.redactSecrets).toBe(false);
    expect(cfg.retention.telemetryDays).toBe(7);
    expect(cfg.retention.schedulerEnabled).toBe(false);
    expect(cfg.retention.batchLimit).toBe(1000);
  });

  it('rejects invalid values', () => {
    expect(() =>
      loadConfig(WeftConfigSchema, WeftConfigSchema.parse({}), {
        env: { WEFT_HOOK_PORT: '99999' },
      }),
    ).toThrow();
    expect(() =>
      loadConfig(WeftConfigSchema, WeftConfigSchema.parse({}), { file: { mode: 'cloud' } }),
    ).toThrow();
  });

  it('loadWeftConfig uses the canonical env map', () => {
    const cfg = loadWeftConfig({ env: { WEFT_MODE: 'team', WEFT_SYNC_SCOPE: 'diffs' } });
    expect(cfg.mode).toBe('team');
    expect(cfg.privacy.syncScope).toBe('diffs');
    expect(WEFT_ENV_MAP.WEFT_MODE).toBe('mode');
  });
});
