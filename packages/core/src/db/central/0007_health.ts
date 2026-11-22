import type { PgMigration } from '../postgres.js';

const up = `
-- Project-scope health baselines and regressions. The init schema keyed these by
-- repo only; a multi-team server needs per-project isolation. A baseline records
-- the last known-healthy commit (and the passing validation run that proved it);
-- a regression records a newly-failing fingerprint, the ranked suspect changes,
-- and — once confirmed by a revert-test — the culprit and the revert commit.
ALTER TABLE health_baselines ADD COLUMN project_id TEXT NOT NULL DEFAULT 'proj_legacy';
ALTER TABLE health_baselines ALTER COLUMN project_id DROP DEFAULT;
ALTER TABLE health_baselines ADD COLUMN validation_run_id TEXT;
CREATE INDEX health_baselines_project_repo ON health_baselines (project_id, repo_id, branch, established_at DESC);

ALTER TABLE regressions ADD COLUMN project_id TEXT NOT NULL DEFAULT 'proj_legacy';
ALTER TABLE regressions ALTER COLUMN project_id DROP DEFAULT;
ALTER TABLE regressions ADD COLUMN failing_checks JSONB;
ALTER TABLE regressions ADD COLUMN revert_oid TEXT;
ALTER TABLE regressions ADD COLUMN confirmed_at TIMESTAMPTZ;
CREATE INDEX regressions_project_repo ON regressions (project_id, repo_id, state);
CREATE UNIQUE INDEX regressions_open_fingerprint
  ON regressions (project_id, repo_id, baseline_id, failure_fingerprint)
  WHERE state = 'open';
`;

const down = `
DROP INDEX IF EXISTS regressions_open_fingerprint;
DROP INDEX IF EXISTS regressions_project_repo;
ALTER TABLE regressions DROP COLUMN IF EXISTS confirmed_at;
ALTER TABLE regressions DROP COLUMN IF EXISTS revert_oid;
ALTER TABLE regressions DROP COLUMN IF EXISTS failing_checks;
ALTER TABLE regressions DROP COLUMN IF EXISTS project_id;
DROP INDEX IF EXISTS health_baselines_project_repo;
ALTER TABLE health_baselines DROP COLUMN IF EXISTS validation_run_id;
ALTER TABLE health_baselines DROP COLUMN IF EXISTS project_id;
`;

export const centralHealthMigration: PgMigration = {
  id: '0007_health',
  up,
  down,
};