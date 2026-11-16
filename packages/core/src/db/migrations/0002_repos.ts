import type { Migration } from '../migrate.js';

const up = `
CREATE TABLE repos (
  repo_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  name TEXT NOT NULL,
  root_path TEXT NOT NULL,
  remote_url TEXT,
  default_branch TEXT,
  head_oid TEXT,
  wip_ref TEXT NOT NULL,
  watcher_backend TEXT NOT NULL DEFAULT 'poll',
  last_scan_at TEXT,
  last_wip_oid TEXT,
  last_wip_at TEXT,
  state TEXT NOT NULL DEFAULT 'active',
  registered_at TEXT NOT NULL,
  UNIQUE (device_id, root_path)
);
CREATE INDEX repos_project ON repos (project_id, state);

CREATE TABLE repo_files (
  repo_id TEXT NOT NULL,
  path TEXT NOT NULL,
  change_kind TEXT NOT NULL,
  untracked INTEGER NOT NULL DEFAULT 0,
  content_hash TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (repo_id, path)
);
`;

const down = `
DROP TABLE IF EXISTS repo_files;
DROP TABLE IF EXISTS repos;
`;

export const reposMigration: Migration = { id: '0002_repos', up, down };
