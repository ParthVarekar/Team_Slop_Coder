import type { Migration } from '../migrate.js';

const up = `
-- Validation result cache. A passed run is reusable only for the exact input
-- (tree + check config) AND toolchain fingerprint, until TTL expiry. A flake
-- quarantine marks a key distrusted so a cached pass cannot mask a later failure.
CREATE TABLE validation_cache (
  input_hash TEXT NOT NULL,
  toolchain_fingerprint TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  tree_oid TEXT NOT NULL,
  state TEXT NOT NULL,
  checks_json TEXT NOT NULL,
  cached_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  quarantined INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (input_hash, toolchain_fingerprint)
);
CREATE INDEX validation_cache_repo ON validation_cache (repo_id, expires_at);
`;

const down = `
DROP INDEX IF EXISTS validation_cache_repo;
DROP TABLE IF EXISTS validation_cache;
`;

export const validationCacheMigration: Migration = { id: '0008_validation_cache', up, down };