import type { Migration } from '../migrate.js';

const up = `
CREATE TABLE completion_claims (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  session_id TEXT,
  claimed_at TEXT NOT NULL,
  claim_text TEXT,
  evidence_state TEXT NOT NULL DEFAULT 'unverified'
);
CREATE INDEX completion_claims_task ON completion_claims (task_id, claimed_at);
`;

const down = `
DROP TABLE IF EXISTS completion_claims;
`;

export const claimsMigration: Migration = { id: '0005_claims', up, down };