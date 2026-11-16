import type { PgMigration } from '../postgres.js';

const up = `
-- Identity and topology -----------------------------------------------------
CREATE TABLE organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE teams (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  UNIQUE (org_id, slug)
);
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id),
  email TEXT NOT NULL,
  display_name TEXT,
  role_global TEXT NOT NULL DEFAULT 'member',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE memberships (
  user_id TEXT NOT NULL REFERENCES users(id),
  team_id TEXT NOT NULL REFERENCES teams(id),
  role TEXT NOT NULL DEFAULT 'member',
  PRIMARY KEY (user_id, team_id)
);
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id),
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  settings JSONB NOT NULL DEFAULT '{}',
  UNIQUE (team_id, slug)
);
CREATE TABLE project_members (
  project_id TEXT NOT NULL REFERENCES projects(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL DEFAULT 'member',
  PRIMARY KEY (project_id, user_id)
);
CREATE TABLE repositories (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  name TEXT NOT NULL,
  origin_url TEXT,
  default_branch TEXT NOT NULL DEFAULT 'main',
  local_path_hint TEXT
);
CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id),
  hostname TEXT,
  os TEXT,
  pubkey TEXT,
  last_seen TIMESTAMPTZ,
  daemon_version TEXT
);
CREATE TABLE api_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id),
  device_id TEXT REFERENCES devices(id),
  project_id TEXT REFERENCES projects(id),
  scope JSONB NOT NULL DEFAULT '[]',
  hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ
);
CREATE TABLE agent_providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  adapter_version TEXT,
  capability_manifest JSONB NOT NULL DEFAULT '{}'
);

-- Event log (monthly range partitions on received_at) -----------------------
CREATE TABLE events (
  event_id TEXT NOT NULL,
  v INTEGER NOT NULL DEFAULT 1,
  device_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  repo_id TEXT,
  session_id TEXT,
  provider_session_id TEXT,
  task_id TEXT,
  seq BIGINT,
  global_seq BIGINT NOT NULL,
  ts TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL,
  type TEXT NOT NULL,
  actor JSONB NOT NULL,
  payload JSONB NOT NULL,
  privacy TEXT NOT NULL DEFAULT 'metadata',
  PRIMARY KEY (event_id, received_at),
  UNIQUE (device_id, event_id, received_at)
) PARTITION BY RANGE (received_at);
CREATE INDEX events_project_seq ON events (project_id, global_seq);
CREATE INDEX events_session_seq ON events (session_id, seq);
CREATE TABLE events_default PARTITION OF events DEFAULT;

CREATE TABLE project_stream_seq (
  project_id TEXT PRIMARY KEY,
  last_seq BIGINT NOT NULL DEFAULT 0,
  min_seq BIGINT NOT NULL DEFAULT 0
);

-- Durable coordination trail (never expires) --------------------------------
CREATE TABLE coordination_events (
  event_id TEXT PRIMARY KEY,
  v INTEGER NOT NULL DEFAULT 1,
  device_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  repo_id TEXT,
  session_id TEXT,
  task_id TEXT,
  seq BIGINT,
  global_seq BIGINT NOT NULL,
  ts TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  type TEXT NOT NULL,
  actor JSONB NOT NULL,
  payload JSONB NOT NULL,
  privacy TEXT NOT NULL DEFAULT 'metadata'
);
CREATE INDEX coordination_events_project ON coordination_events (project_id, global_seq);
CREATE INDEX coordination_events_task ON coordination_events (task_id);

-- Sessions and file activity ------------------------------------------------
CREATE TABLE agent_sessions (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  provider_id TEXT,
  provider_session_id TEXT NOT NULL,
  task_id TEXT,
  developer_id TEXT,
  cwd TEXT,
  workspace_id TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ,
  model TEXT,
  prompt_summary TEXT,
  fidelity TEXT NOT NULL DEFAULT 'high',
  UNIQUE (device_id, provider_session_id)
);
CREATE TABLE file_modifications (
  id BIGSERIAL PRIMARY KEY,
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
  symbols_touched JSONB
);
CREATE INDEX file_modifications_overlap ON file_modifications (repo_id, task_id, path);

-- Tasks (server-authoritative, event-sourced) -------------------------------
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  repo_id TEXT,
  number INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  acceptance_criteria JSONB NOT NULL DEFAULT '[]',
  validation_requirements JSONB NOT NULL DEFAULT '{}',
  priority TEXT NOT NULL DEFAULT 'P2',
  state TEXT NOT NULL DEFAULT 'backlog',
  expected_modules JSONB NOT NULL DEFAULT '[]',
  expected_files JSONB NOT NULL DEFAULT '[]',
  branch TEXT,
  workspace_id TEXT,
  version INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  parent_task_id TEXT,
  edit_conflict JSONB,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, number)
);
CREATE INDEX tasks_project_state ON tasks (project_id, state, priority);
CREATE TABLE task_assignees (
  task_id TEXT NOT NULL REFERENCES tasks(id),
  user_id TEXT,
  agent_provider TEXT,
  role TEXT NOT NULL DEFAULT 'collaborator'
);
CREATE UNIQUE INDEX task_one_primary ON task_assignees (task_id) WHERE role = 'primary';
CREATE TABLE task_comments (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  author JSONB NOT NULL,
  body TEXT NOT NULL,
  handoff_bundle JSONB,
  ts TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE task_dependencies (
  task_id TEXT NOT NULL REFERENCES tasks(id),
  depends_on_task_id TEXT NOT NULL REFERENCES tasks(id),
  PRIMARY KEY (task_id, depends_on_task_id)
);
CREATE INDEX task_dependencies_reverse ON task_dependencies (depends_on_task_id);
CREATE TABLE task_events (
  id BIGSERIAL PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  version INTEGER NOT NULL,
  type TEXT NOT NULL,
  actor JSONB NOT NULL,
  payload JSONB NOT NULL,
  ts TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Reservations, conflicts, merge queue --------------------------------------
CREATE TABLE file_reservations (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  task_id TEXT,
  session_id TEXT,
  path_glob TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'soft',
  expires_at TIMESTAMPTZ,
  renewed_at TIMESTAMPTZ,
  grace_until TIMESTAMPTZ,
  state TEXT NOT NULL DEFAULT 'active'
);
CREATE INDEX file_reservations_repo ON file_reservations (repo_id, state);
CREATE TABLE conflicts (
  id TEXT PRIMARY KEY,
  canonical_key TEXT NOT NULL UNIQUE,
  repo_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  task_ids JSONB NOT NULL DEFAULT '[]',
  branch_a TEXT,
  branch_b TEXT,
  paths JSONB NOT NULL DEFAULT '[]',
  symbol_ids JSONB NOT NULL DEFAULT '[]',
  evidence JSONB NOT NULL DEFAULT '[]',
  detection_epoch INTEGER NOT NULL DEFAULT 0,
  severity TEXT NOT NULL DEFAULT 'warning',
  state TEXT NOT NULL DEFAULT 'open',
  resolved_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE merge_queue_entries (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  repo_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued',
  speculative_tree_oid TEXT,
  base_oid TEXT,
  validation_run_id TEXT,
  ejected_reason TEXT,
  executor_device_id TEXT,
  lease_epoch BIGINT NOT NULL DEFAULT 0,
  push_precondition_oid TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX merge_queue_project_pos ON merge_queue_entries (project_id, position);

-- Verification and health ---------------------------------------------------
CREATE TABLE validation_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  repo_id TEXT NOT NULL,
  task_id TEXT,
  trigger TEXT NOT NULL,
  candidate_oid TEXT,
  tree_oid TEXT,
  runner_device_id TEXT,
  claimant_device_id TEXT,
  state TEXT NOT NULL DEFAULT 'running',
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  input_hash TEXT,
  toolchain_fingerprint TEXT,
  cache_hit BOOLEAN NOT NULL DEFAULT FALSE,
  cache_expires_at TIMESTAMPTZ,
  independence TEXT NOT NULL DEFAULT 'self'
);
CREATE INDEX validation_runs_cache ON validation_runs (repo_id, input_hash, state);
CREATE INDEX validation_runs_project_task ON validation_runs (project_id, task_id, state);
CREATE TABLE check_results (
  id BIGSERIAL PRIMARY KEY,
  validation_run_id TEXT NOT NULL REFERENCES validation_runs(id),
  check_id TEXT NOT NULL,
  command_display TEXT,
  exit_code INTEGER,
  duration_ms INTEGER,
  log_digest TEXT,
  log_excerpt TEXT,
  artifacts JSONB,
  selection TEXT,
  newly_failing BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX check_results_run ON check_results (validation_run_id, newly_failing);
CREATE TABLE completion_claims (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  session_id TEXT,
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  claim_text TEXT,
  evidence_state TEXT NOT NULL DEFAULT 'unverified'
);
CREATE TABLE health_baselines (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  branch TEXT NOT NULL,
  commit_oid TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'healthy',
  check_results_summary JSONB,
  established_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE regressions (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  baseline_id TEXT REFERENCES health_baselines(id),
  failure_fingerprint TEXT NOT NULL,
  first_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
  suspected_changes JSONB,
  confirmed_change_id TEXT,
  state TEXT NOT NULL DEFAULT 'open'
);

-- Governance ----------------------------------------------------------------
CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  subject_type TEXT,
  subject_id TEXT,
  state TEXT NOT NULL DEFAULT 'inbox',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_state ON notifications (user_id, state);
CREATE TABLE audit_records (
  id BIGSERIAL PRIMARY KEY,
  project_id TEXT NOT NULL,
  actor JSONB NOT NULL,
  action TEXT NOT NULL,
  subject TEXT,
  before_hash TEXT,
  after_hash TEXT,
  ts TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_records_project ON audit_records (project_id, ts);
`;

const down = `
DROP TABLE IF EXISTS audit_records;
DROP TABLE IF EXISTS notifications;
DROP TABLE IF EXISTS regressions;
DROP TABLE IF EXISTS health_baselines;
DROP TABLE IF EXISTS completion_claims;
DROP TABLE IF EXISTS check_results;
DROP TABLE IF EXISTS validation_runs;
DROP TABLE IF EXISTS merge_queue_entries;
DROP TABLE IF EXISTS conflicts;
DROP TABLE IF EXISTS file_reservations;
DROP TABLE IF EXISTS task_events;
DROP TABLE IF EXISTS task_dependencies;
DROP TABLE IF EXISTS task_comments;
DROP TABLE IF EXISTS task_assignees;
DROP TABLE IF EXISTS tasks;
DROP TABLE IF EXISTS file_modifications;
DROP TABLE IF EXISTS agent_sessions;
DROP TABLE IF EXISTS coordination_events;
DROP TABLE IF EXISTS project_stream_seq;
DROP TABLE IF EXISTS events_default;
DROP TABLE IF EXISTS events;
DROP TABLE IF EXISTS agent_providers;
DROP TABLE IF EXISTS api_tokens;
DROP TABLE IF EXISTS devices;
DROP TABLE IF EXISTS repositories;
DROP TABLE IF EXISTS project_members;
DROP TABLE IF EXISTS projects;
DROP TABLE IF EXISTS memberships;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS teams;
DROP TABLE IF EXISTS organizations;
`;

export const centralInitMigration: PgMigration = { id: '0001_init', up, down };
