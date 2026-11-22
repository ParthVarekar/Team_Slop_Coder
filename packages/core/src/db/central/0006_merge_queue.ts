import type { PgMigration } from '../postgres.js';

const up = `
-- Lease-elected queue executor: one daemon per (project, repo) drives the merge
-- queue. lease_epoch is a fencing token — a stale executor (after failover) can
-- never claim/advance an entry under an old epoch. Grace mirrors reservations:
-- past expiry only the holder may renew; past grace the lease is reclaimable.
CREATE TABLE merge_queue_leases (
  project_id TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  holder_device_id TEXT,
  lease_epoch BIGINT NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ,
  renewed_at TIMESTAMPTZ,
  grace_until TIMESTAMPTZ,
  state TEXT NOT NULL DEFAULT 'idle',
  PRIMARY KEY (project_id, repo_id)
);

-- The init merge_queue_entries lacked the branch/candidate the executor merges,
-- the protected target branch, the landed merge oid, and a requeue counter.
ALTER TABLE merge_queue_entries ADD COLUMN branch TEXT;
ALTER TABLE merge_queue_entries ADD COLUMN candidate_oid TEXT;
ALTER TABLE merge_queue_entries ADD COLUMN target_branch TEXT NOT NULL DEFAULT 'main';
ALTER TABLE merge_queue_entries ADD COLUMN merged_oid TEXT;
ALTER TABLE merge_queue_entries ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE merge_queue_entries ADD COLUMN claimant_device_id TEXT;
CREATE INDEX merge_queue_entries_repo_state ON merge_queue_entries (project_id, repo_id, state, position);
`;

const down = `
DROP INDEX IF EXISTS merge_queue_entries_repo_state;
ALTER TABLE merge_queue_entries DROP COLUMN IF EXISTS claimant_device_id;
ALTER TABLE merge_queue_entries DROP COLUMN IF EXISTS attempts;
ALTER TABLE merge_queue_entries DROP COLUMN IF EXISTS merged_oid;
ALTER TABLE merge_queue_entries DROP COLUMN IF EXISTS target_branch;
ALTER TABLE merge_queue_entries DROP COLUMN IF EXISTS candidate_oid;
ALTER TABLE merge_queue_entries DROP COLUMN IF EXISTS branch;
DROP TABLE IF EXISTS merge_queue_leases;
`;

export const centralMergeQueueMigration: PgMigration = {
  id: '0006_merge_queue',
  up,
  down,
};