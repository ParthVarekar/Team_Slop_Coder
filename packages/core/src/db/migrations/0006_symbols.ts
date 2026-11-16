import type { Migration } from '../migrate.js';

// Replaces the unused M0 tree_oid-keyed symbol scaffold from 0001_init with the
// working branch-scoped index. DROP IF EXISTS also clears the scaffold on dev
// databases that already applied 0001 before this migration existed.
const up = `
DROP TABLE IF EXISTS symbol_edges;
DROP TABLE IF EXISTS symbols;

CREATE TABLE symbols (
  symbol_id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id TEXT NOT NULL,
  branch TEXT NOT NULL,
  file_path TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  container TEXT NOT NULL DEFAULT '',
  signature TEXT NOT NULL,
  exported INTEGER NOT NULL DEFAULT 0,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  start_byte INTEGER NOT NULL,
  end_byte INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  indexed_at TEXT NOT NULL
);
CREATE UNIQUE INDEX symbols_identity
  ON symbols (repo_id, branch, file_path, kind, name, container, start_line);
CREATE INDEX symbols_repo_branch ON symbols (repo_id, branch);
CREATE INDEX symbols_name ON symbols (repo_id, branch, name);

CREATE TABLE symbol_edges (
  edge_id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id TEXT NOT NULL,
  branch TEXT NOT NULL,
  file_path TEXT NOT NULL,
  from_symbol TEXT NOT NULL,
  to_name TEXT NOT NULL,
  kind TEXT NOT NULL,
  module_specifier TEXT,
  line INTEGER NOT NULL
);
CREATE INDEX symbol_edges_file ON symbol_edges (repo_id, branch, file_path);
CREATE INDEX symbol_edges_to ON symbol_edges (repo_id, branch, to_name);

CREATE TABLE file_index_state (
  repo_id TEXT NOT NULL,
  branch TEXT NOT NULL,
  file_path TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  symbol_count INTEGER NOT NULL DEFAULT 0,
  indexed_at TEXT NOT NULL,
  PRIMARY KEY (repo_id, branch, file_path)
);
`;

const down = `
DROP TABLE IF EXISTS file_index_state;
DROP TABLE IF EXISTS symbol_edges;
DROP TABLE IF EXISTS symbols;
`;

export const symbolsMigration: Migration = { id: '0006_symbols', up, down };