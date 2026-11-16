import type { Migration } from '../migrate.js';

// Per-branch index manifest: a cheap fingerprint (head oid + counts + last write)
// the overlap engine reads to decide whether a branch's modified-symbol set can be
// reused from cache. Lets a conflict-storm sweep skip unchanged branches entirely.
const up = `
CREATE TABLE branch_index_state (
  repo_id TEXT NOT NULL,
  branch TEXT NOT NULL,
  head_oid TEXT NOT NULL,
  file_count INTEGER NOT NULL DEFAULT 0,
  symbol_count INTEGER NOT NULL DEFAULT 0,
  last_indexed_at TEXT,
  PRIMARY KEY (repo_id, branch)
);
`;

const down = `DROP TABLE IF EXISTS branch_index_state;`;

export const branchIndexMigration: Migration = { id: '0007_branch_index', up, down };