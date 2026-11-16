import type { Migration } from '../migrate.js';

const up = `
CREATE TABLE events (
  event_id TEXT PRIMARY KEY,
  v INTEGER NOT NULL DEFAULT 1,
  device_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  repo_id TEXT,
  session_id TEXT,
  provider_session_id TEXT,
  task_id TEXT,
  seq INTEGER,
  ts TEXT NOT NULL,
  type TEXT NOT NULL,
  actor TEXT NOT NULL,
  payload TEXT NOT NULL,
  privacy TEXT NOT NULL DEFAULT 'metadata',
  received_at TEXT NOT NULL,
  global_seq INTEGER
);
CREATE INDEX events_session_seq ON events (session_id, seq);
CREATE INDEX events_project_ts ON events (project_id, ts);
CREATE INDEX events_type ON events (type);

CREATE TABLE coordination_events (
  event_id TEXT PRIMARY KEY,
  v INTEGER NOT NULL DEFAULT 1,
  device_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  repo_id TEXT,
  session_id TEXT,
  task_id TEXT,
  seq INTEGER,
  ts TEXT NOT NULL,
  type TEXT NOT NULL,
  actor TEXT NOT NULL,
  payload TEXT NOT NULL,
  privacy TEXT NOT NULL DEFAULT 'metadata',
  received_at TEXT NOT NULL,
  global_seq INTEGER
);
CREATE INDEX coordination_events_project ON coordination_events (project_id, ts);
CREATE INDEX coordination_events_task ON coordination_events (task_id);

CREATE TABLE outbox (
  outbox_id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL DEFAULT 'telemetry',
  envelope TEXT NOT NULL,
  created_at TEXT NOT NULL,
  shipped_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);
CREATE INDEX outbox_pending ON outbox (shipped_at, created_at);

CREATE TABLE agent_sessions (
  session_id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  provider_id TEXT,
  provider_session_id TEXT NOT NULL,
  task_id TEXT,
  developer_id TEXT,
  cwd TEXT,
  workspace_id TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  started_at TEXT NOT NULL,
  ended_at TEXT,
  model TEXT,
  prompt_summary TEXT,
  fidelity TEXT NOT NULL DEFAULT 'high',
  UNIQUE (device_id, provider_session_id)
);

CREATE TABLE tasks (
  task_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  repo_id TEXT,
  number INTEGER,
  title TEXT NOT NULL,
  description TEXT,
  acceptance_criteria TEXT,
  validation_requirements TEXT,
  priority TEXT NOT NULL DEFAULT 'P2',
  state TEXT NOT NULL DEFAULT 'backlog',
  expected_modules TEXT,
  expected_files TEXT,
  branch TEXT,
  workspace_id TEXT,
  version INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  parent_task_id TEXT,
  edit_conflict TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX tasks_project_state ON tasks (project_id, state, priority);

CREATE TABLE file_modifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  session_id TEXT,
  task_id TEXT,
  path TEXT NOT NULL,
  change_kind TEXT NOT NULL,
  old_hash TEXT,
  new_hash TEXT,
  lines_added INTEGER,
  lines_removed INTEGER,
  symbols_touched TEXT
);
CREATE INDEX file_modifications_overlap ON file_modifications (repo_id, task_id, path);

CREATE TABLE symbols (
  repo_id TEXT NOT NULL,
  tree_oid TEXT NOT NULL,
  file_path TEXT NOT NULL,
  qualified_name TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  signature_normalized TEXT,
  exported INTEGER NOT NULL DEFAULT 0,
  start_line INTEGER,
  end_line INTEGER,
  content_hash TEXT NOT NULL,
  body_hash TEXT,
  owner_device_id TEXT,
  PRIMARY KEY (repo_id, tree_oid, file_path, qualified_name)
);
CREATE INDEX symbols_content ON symbols (repo_id, tree_oid, content_hash);
CREATE INDEX symbols_name ON symbols (repo_id, name);

CREATE TABLE symbol_edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id TEXT NOT NULL,
  tree_oid TEXT NOT NULL,
  from_symbol TEXT NOT NULL,
  to_symbol_name TEXT NOT NULL,
  to_file_hint TEXT,
  kind TEXT NOT NULL,
  precision TEXT NOT NULL DEFAULT 'name_based',
  resolver TEXT NOT NULL DEFAULT 'tree_sitter',
  source_hash TEXT
);
CREATE INDEX symbol_edges_target ON symbol_edges (repo_id, tree_oid, to_symbol_name);

CREATE TABLE workspaces (
  workspace_id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  task_id TEXT,
  device_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  path TEXT NOT NULL,
  branch TEXT,
  head_oid TEXT,
  state TEXT NOT NULL DEFAULT 'active',
  locked INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE commits (
  repo_id TEXT NOT NULL,
  oid TEXT NOT NULL,
  branch_ids TEXT,
  author_user_id TEXT,
  session_id TEXT,
  task_id TEXT,
  parents TEXT,
  message_summary TEXT,
  ts TEXT,
  PRIMARY KEY (repo_id, oid)
);
CREATE INDEX commits_repo_ts ON commits (repo_id, ts);

CREATE TABLE branches (
  repo_id TEXT NOT NULL,
  name TEXT NOT NULL,
  head_oid TEXT,
  task_id TEXT,
  kind TEXT,
  protected INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (repo_id, name)
);

CREATE TABLE file_reservations (
  reservation_id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  task_id TEXT,
  session_id TEXT,
  path_glob TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'soft',
  expires_at TEXT,
  renewed_at TEXT,
  grace_until TEXT,
  state TEXT NOT NULL DEFAULT 'active'
);
CREATE INDEX file_reservations_repo ON file_reservations (repo_id, state);

CREATE TABLE validation_runs (
  run_id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  task_id TEXT,
  trigger TEXT NOT NULL,
  candidate_oid TEXT,
  tree_oid TEXT,
  runner_device_id TEXT,
  claimant_device_id TEXT,
  state TEXT NOT NULL DEFAULT 'running',
  started_at TEXT NOT NULL,
  finished_at TEXT,
  input_hash TEXT,
  toolchain_fingerprint TEXT,
  cache_hit INTEGER NOT NULL DEFAULT 0,
  cache_expires_at TEXT,
  independence TEXT NOT NULL DEFAULT 'self'
);
CREATE INDEX validation_runs_cache ON validation_runs (repo_id, input_hash, state);

CREATE TABLE check_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  validation_run_id TEXT NOT NULL,
  check_id TEXT NOT NULL,
  command_display TEXT,
  exit_code INTEGER,
  duration_ms INTEGER,
  log_digest TEXT,
  log_excerpt TEXT,
  artifacts TEXT,
  selection TEXT,
  newly_failing INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX check_results_run ON check_results (validation_run_id, newly_failing);

CREATE TABLE event_summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  session_id TEXT,
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL,
  group_key TEXT NOT NULL,
  template_id TEXT NOT NULL,
  params TEXT,
  event_ids TEXT
);
CREATE INDEX event_summaries_project ON event_summaries (project_id, window_end);

CREATE TABLE devices (
  device_id TEXT PRIMARY KEY,
  user_id TEXT,
  hostname TEXT,
  os TEXT,
  pubkey TEXT,
  last_seen TEXT,
  daemon_version TEXT
);
`;

const down = `
DROP TABLE IF EXISTS devices;
DROP TABLE IF EXISTS event_summaries;
DROP TABLE IF EXISTS check_results;
DROP TABLE IF EXISTS validation_runs;
DROP TABLE IF EXISTS file_reservations;
DROP TABLE IF EXISTS branches;
DROP TABLE IF EXISTS commits;
DROP TABLE IF EXISTS workspaces;
DROP TABLE IF EXISTS symbol_edges;
DROP TABLE IF EXISTS symbols;
DROP TABLE IF EXISTS file_modifications;
DROP TABLE IF EXISTS tasks;
DROP TABLE IF EXISTS agent_sessions;
DROP TABLE IF EXISTS outbox;
DROP TABLE IF EXISTS coordination_events;
DROP TABLE IF EXISTS events;
`;

export const initMigration: Migration = { id: '0001_init', up, down };
