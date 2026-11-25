import type { PgMigration } from '../postgres.js';

const up = `
-- Project-scope reservation leases. The init schema had no project/holder column;
-- a multi-team server needs per-project identity and the holder device for the
-- "no mid-edit lock steal" rule (only the holder may renew within expiry grace).
ALTER TABLE file_reservations ADD COLUMN project_id TEXT NOT NULL DEFAULT 'proj_legacy';
ALTER TABLE file_reservations ALTER COLUMN project_id DROP DEFAULT;
ALTER TABLE file_reservations ADD COLUMN holder_device_id TEXT;
ALTER TABLE file_reservations ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE file_reservations ADD COLUMN lease_epoch INTEGER NOT NULL DEFAULT 0;
ALTER TABLE file_reservations ADD COLUMN released_reason TEXT;
CREATE INDEX file_reservations_project_repo ON file_reservations (project_id, repo_id, state);
`;

const down = `
DROP INDEX IF EXISTS file_reservations_project_repo;
ALTER TABLE file_reservations DROP COLUMN IF EXISTS released_reason;
ALTER TABLE file_reservations DROP COLUMN IF EXISTS lease_epoch;
ALTER TABLE file_reservations DROP COLUMN IF EXISTS created_at;
ALTER TABLE file_reservations DROP COLUMN IF EXISTS holder_device_id;
ALTER TABLE file_reservations DROP COLUMN IF EXISTS project_id;
`;

export const centralReservationLeaseMigration: PgMigration = {
  id: '0005_reservation_lease',
  up,
  down,
};
