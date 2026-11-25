import type { Migration } from '../migrate.js';

const up = `
CREATE TABLE worktrees (
  worktree_id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  branch TEXT NOT NULL,
  path TEXT NOT NULL,
  base_oid TEXT,
  device_id TEXT NOT NULL,
  wip_ref TEXT NOT NULL,
  quarantine INTEGER NOT NULL DEFAULT 0,
  locked INTEGER NOT NULL DEFAULT 0,
  owner_pid INTEGER,
  state TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  discarded_at TEXT
);
CREATE UNIQUE INDEX worktrees_active_branch
  ON worktrees (repo_id, branch) WHERE state IN ('active', 'quarantined');
CREATE INDEX worktrees_task ON worktrees (task_id, device_id, state);
CREATE INDEX worktrees_repo ON worktrees (repo_id, state);
`;

const down = `
DROP TABLE IF EXISTS worktrees;
`;

export const worktreesMigration: Migration = { id: '0004_worktrees', up, down };
