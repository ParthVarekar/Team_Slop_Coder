import type { Migration } from '../migrate.js';
import { initMigration } from './0001_init.js';
import { reposMigration } from './0002_repos.js';
import { syncMigration } from './0003_sync.js';
import { worktreesMigration } from './0004_worktrees.js';
import { claimsMigration } from './0005_claims.js';
import { symbolsMigration } from './0006_symbols.js';
import { branchIndexMigration } from './0007_branch_index.js';

/** Daemon-local SQLite migrations, applied in lexical order. */
export const DAEMON_MIGRATIONS: Migration[] = [
  initMigration,
  reposMigration,
  syncMigration,
  worktreesMigration,
  claimsMigration,
  symbolsMigration,
  branchIndexMigration,
];
