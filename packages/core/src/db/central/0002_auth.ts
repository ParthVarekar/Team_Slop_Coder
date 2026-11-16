import type { PgMigration } from '../postgres.js';

const up = `
-- Project-scoped API tokens: hashed only, revocable, expiring. The raw secret
-- is returned once at issuance and never stored. hash is unique for O(1) lookup.
ALTER TABLE api_tokens ADD COLUMN revoked_at TIMESTAMPTZ;
ALTER TABLE api_tokens ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE api_tokens ADD COLUMN name TEXT;
CREATE UNIQUE INDEX api_tokens_hash ON api_tokens (hash);
CREATE INDEX api_tokens_project ON api_tokens (project_id);
`;

const down = `
DROP INDEX IF EXISTS api_tokens_project;
DROP INDEX IF EXISTS api_tokens_hash;
ALTER TABLE api_tokens DROP COLUMN IF EXISTS name;
ALTER TABLE api_tokens DROP COLUMN IF EXISTS created_at;
ALTER TABLE api_tokens DROP COLUMN IF EXISTS revoked_at;
`;

export const centralAuthMigration: PgMigration = { id: '0002_auth', up, down };