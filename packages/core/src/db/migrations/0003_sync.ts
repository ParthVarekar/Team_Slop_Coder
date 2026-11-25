import type { Migration } from '../migrate.js';

const up = `
CREATE TABLE sync_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

const down = `
DROP TABLE IF EXISTS sync_state;
`;

export const syncMigration: Migration = { id: '0003_sync', up, down };
