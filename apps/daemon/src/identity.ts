import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeId, DeviceIdSchema, ProjectIdSchema, UserIdSchema } from '@weft/protocol';

/** Stable per-machine identity, persisted once and reused across restarts. */
export interface DeviceIdentity {
  device_id: string;
  project_id: string;
  user_id: string;
  /** Shared secret authenticating local hook POSTs (never leaves the machine). */
  hook_secret: string;
  created_at: string;
}

export interface IdentityOverrides {
  deviceId?: string | null;
  projectId?: string | null;
}

const FILENAME = 'identity.json';

/**
 * Load the persisted identity, generating any missing fields on first run.
 * Config overrides (team mode) take precedence over stored values. The hook
 * secret is generated locally and is never derived from config or transmitted.
 */
export function loadOrCreateIdentity(
  dataDir: string,
  overrides: IdentityOverrides = {},
): DeviceIdentity {
  mkdirSync(dataDir, { recursive: true });
  const path = join(dataDir, FILENAME);
  let existing: Partial<DeviceIdentity> = {};
  if (existsSync(path)) {
    existing = JSON.parse(readFileSync(path, 'utf8')) as Partial<DeviceIdentity>;
  }
  const identity: DeviceIdentity = {
    device_id: overrides.deviceId ?? existing.device_id ?? makeId('device'),
    project_id: overrides.projectId ?? existing.project_id ?? makeId('project'),
    user_id: existing.user_id ?? makeId('user'),
    hook_secret: existing.hook_secret ?? randomBytes(32).toString('hex'),
    created_at: existing.created_at ?? new Date().toISOString(),
  };
  DeviceIdSchema.parse(identity.device_id);
  ProjectIdSchema.parse(identity.project_id);
  UserIdSchema.parse(identity.user_id);
  writeFileSync(path, JSON.stringify(identity, null, 2), { mode: 0o600 });
  return identity;
}
