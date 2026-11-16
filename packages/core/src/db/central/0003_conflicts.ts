import type { PgMigration } from '../postgres.js';

const up = `
-- Project-scope conflict cards. The init schema made canonical_key globally
-- unique with no project column; a multi-team server needs per-project identity
-- so the same logical conflict in two projects stays two cards.
ALTER TABLE conflicts ADD COLUMN project_id TEXT NOT NULL DEFAULT 'proj_legacy';
ALTER TABLE conflicts ALTER COLUMN project_id DROP DEFAULT;
ALTER TABLE conflicts ADD COLUMN last_detected_at TIMESTAMPTZ;
ALTER TABLE conflicts ADD COLUMN resolved_at TIMESTAMPTZ;
ALTER TABLE conflicts ADD COLUMN reopen_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE conflicts DROP CONSTRAINT IF EXISTS conflicts_canonical_key_key;
CREATE UNIQUE INDEX conflicts_project_key ON conflicts (project_id, canonical_key);
CREATE INDEX conflicts_project_state ON conflicts (project_id, state, severity);

-- Append-only history. The conflicts row is the current projection; this trail
-- records every detection/reopen/resolution with linked prior state so a later
-- epoch re-opening a resolved card is auditable and never silently flaps.
CREATE TABLE conflict_events (
  id BIGSERIAL PRIMARY KEY,
  conflict_id TEXT NOT NULL REFERENCES conflicts(id),
  type TEXT NOT NULL,
  actor JSONB NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  detection_epoch INTEGER NOT NULL DEFAULT 0,
  ts TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX conflict_events_conflict ON conflict_events (conflict_id, id);
`;

const down = `
DROP TABLE IF EXISTS conflict_events;
DROP INDEX IF EXISTS conflicts_project_state;
DROP INDEX IF EXISTS conflicts_project_key;
ALTER TABLE conflicts DROP COLUMN IF EXISTS reopen_count;
ALTER TABLE conflicts DROP COLUMN IF EXISTS resolved_at;
ALTER TABLE conflicts DROP COLUMN IF EXISTS last_detected_at;
ALTER TABLE conflicts DROP COLUMN IF EXISTS project_id;
ALTER TABLE conflicts ADD CONSTRAINT conflicts_canonical_key_key UNIQUE (canonical_key);
`;

export const centralConflictsMigration: PgMigration = { id: '0003_conflicts', up, down };