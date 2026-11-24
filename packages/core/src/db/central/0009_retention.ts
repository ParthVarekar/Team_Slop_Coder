import type { PgMigration } from '../postgres.js';

const up = `
CREATE TABLE event_receipts (
  device_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  original_global_seq BIGINT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL,
  event_type TEXT NOT NULL,
  payload_bytes BIGINT NOT NULL,
  event_hash TEXT NOT NULL,
  run_id TEXT NOT NULL,
  summary_event_id TEXT NOT NULL,
  compacted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (device_id, event_id)
);
CREATE INDEX event_receipts_project ON event_receipts (project_id, compacted_at);
CREATE INDEX event_receipts_run ON event_receipts (run_id);

CREATE TABLE retention_runs (
  project_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('manual', 'outbox_overflow')),
  state TEXT NOT NULL CHECK (state IN ('completed', 'failed')),
  policy_json JSONB NOT NULL,
  fingerprint TEXT,
  cutoff TIMESTAMPTZ NOT NULL,
  batch_limit INTEGER NOT NULL,
  eligible_count BIGINT NOT NULL DEFAULT 0,
  eligible_payload_bytes BIGINT NOT NULL DEFAULT 0,
  protected_coordination BIGINT NOT NULL DEFAULT 0,
  protected_unknown BIGINT NOT NULL DEFAULT 0,
  protected_other BIGINT NOT NULL DEFAULT 0,
  protected_receipts BIGINT NOT NULL DEFAULT 0,
  too_new BIGINT NOT NULL DEFAULT 0,
  selected_count BIGINT NOT NULL DEFAULT 0,
  payload_bytes BIGINT NOT NULL DEFAULT 0,
  range_count INTEGER NOT NULL DEFAULT 0,
  summary_count INTEGER NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  error TEXT,
  PRIMARY KEY (project_id, run_id)
);
CREATE INDEX retention_runs_started ON retention_runs (project_id, started_at DESC);

CREATE TABLE retention_ranges (
  id BIGSERIAL PRIMARY KEY,
  project_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  sequence_kind TEXT NOT NULL CHECK (sequence_kind IN ('global_seq', 'outbox_id')),
  seq_start BIGINT NOT NULL,
  seq_end BIGINT NOT NULL,
  summary_event_id TEXT,
  selected_count BIGINT NOT NULL,
  payload_bytes BIGINT NOT NULL,
  type_counts JSONB NOT NULL,
  CHECK (seq_end >= seq_start),
  UNIQUE (project_id, run_id, sequence_kind, seq_start, seq_end)
);
CREATE INDEX retention_ranges_lookup ON retention_ranges
  (project_id, sequence_kind, seq_end, seq_start);
CREATE INDEX retention_ranges_run ON retention_ranges (project_id, run_id);

CREATE TABLE event_summaries (
  id BIGSERIAL PRIMARY KEY,
  project_id TEXT NOT NULL,
  event_id TEXT NOT NULL UNIQUE,
  run_id TEXT NOT NULL,
  sequence_kind TEXT NOT NULL CHECK (sequence_kind = 'global_seq'),
  seq_start BIGINT NOT NULL,
  seq_end BIGINT NOT NULL,
  summary_kind TEXT NOT NULL,
  type_counts JSONB NOT NULL,
  payload_bytes BIGINT NOT NULL,
  event_digest TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (seq_end >= seq_start)
);
CREATE INDEX event_summaries_project ON event_summaries (project_id, created_at DESC);
CREATE INDEX event_summaries_run ON event_summaries (project_id, run_id);
CREATE INDEX event_summaries_range ON event_summaries
  (project_id, sequence_kind, seq_end, seq_start);
`;

// Never destroy replay/audit evidence during a schema rollback.
const down = `SELECT 1;`;

export const centralRetentionMigration: PgMigration = { id: '0009_retention', up, down };
