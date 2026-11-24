import type { Migration } from '../migrate.js';

const up = `
CREATE TABLE event_receipts (
  event_id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  original_rowid INTEGER NOT NULL,
  received_at TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_bytes INTEGER NOT NULL,
  event_digest TEXT NOT NULL,
  run_id TEXT NOT NULL,
  summary_event_id TEXT NOT NULL,
  compacted_at TEXT NOT NULL
);
CREATE INDEX event_receipts_project ON event_receipts (project_id, compacted_at);
CREATE INDEX event_receipts_run ON event_receipts (run_id);

CREATE TABLE outbox_compactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  outbox_id INTEGER NOT NULL UNIQUE,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_bytes INTEGER NOT NULL,
  envelope_digest TEXT NOT NULL,
  compacted_at TEXT NOT NULL
);
CREATE INDEX outbox_compactions_run ON outbox_compactions (run_id);

CREATE TABLE retention_runs (
  run_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('manual', 'outbox_overflow')),
  state TEXT NOT NULL CHECK (state IN ('completed', 'failed')),
  policy_json TEXT NOT NULL,
  fingerprint TEXT,
  cutoff TEXT NOT NULL,
  batch_limit INTEGER NOT NULL,
  eligible_count INTEGER NOT NULL DEFAULT 0,
  eligible_payload_bytes INTEGER NOT NULL DEFAULT 0,
  protected_coordination INTEGER NOT NULL DEFAULT 0,
  protected_unknown INTEGER NOT NULL DEFAULT 0,
  protected_other INTEGER NOT NULL DEFAULT 0,
  protected_receipts INTEGER NOT NULL DEFAULT 0,
  too_new INTEGER NOT NULL DEFAULT 0,
  pending_outbox_exclusions INTEGER NOT NULL DEFAULT 0,
  selected_count INTEGER NOT NULL DEFAULT 0,
  payload_bytes INTEGER NOT NULL DEFAULT 0,
  range_count INTEGER NOT NULL DEFAULT 0,
  summary_count INTEGER NOT NULL DEFAULT 0,
  started_at TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  error TEXT
);
CREATE INDEX retention_runs_project ON retention_runs (project_id, started_at DESC);

CREATE TABLE retention_ranges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  sequence_kind TEXT NOT NULL CHECK (sequence_kind IN ('rowid', 'outbox_id')),
  seq_start INTEGER NOT NULL,
  seq_end INTEGER NOT NULL,
  summary_event_id TEXT,
  selected_count INTEGER NOT NULL,
  payload_bytes INTEGER NOT NULL,
  type_counts_json TEXT NOT NULL,
  CHECK (seq_end >= seq_start),
  UNIQUE (run_id, sequence_kind, seq_start, seq_end)
);
CREATE INDEX retention_ranges_lookup ON retention_ranges
  (project_id, sequence_kind, seq_end, seq_start);
CREATE INDEX retention_ranges_run ON retention_ranges (run_id);

-- The pre-existing summaries table is extended, not replaced. Legacy summary
-- rows remain readable; M5.4 writes one row per exact compacted range.
ALTER TABLE event_summaries ADD COLUMN summary_kind TEXT;
ALTER TABLE event_summaries ADD COLUMN event_id TEXT;
ALTER TABLE event_summaries ADD COLUMN run_id TEXT;
ALTER TABLE event_summaries ADD COLUMN sequence_kind TEXT;
ALTER TABLE event_summaries ADD COLUMN seq_start INTEGER;
ALTER TABLE event_summaries ADD COLUMN seq_end INTEGER;
ALTER TABLE event_summaries ADD COLUMN type_counts_json TEXT;
ALTER TABLE event_summaries ADD COLUMN payload_bytes INTEGER;
ALTER TABLE event_summaries ADD COLUMN event_digest TEXT;
ALTER TABLE event_summaries ADD COLUMN created_at TEXT;
CREATE UNIQUE INDEX event_summaries_event ON event_summaries (event_id) WHERE event_id IS NOT NULL;
CREATE INDEX event_summaries_run ON event_summaries (run_id);
CREATE INDEX event_summaries_range ON event_summaries
  (project_id, sequence_kind, seq_end, seq_start);
`;

// Retention evidence is intentionally durable. Rollback removes the migration
// marker but never drops receipts, summaries, ranges or audit-adjacent runs.
const down = `SELECT 1;`;

export const retentionMigration: Migration = { id: '0009_retention', up, down };
