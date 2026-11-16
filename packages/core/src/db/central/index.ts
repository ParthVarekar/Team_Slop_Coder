import type { PgMigration } from '../postgres.js';
import { centralInitMigration } from './0001_init.js';
import { centralAuthMigration } from './0002_auth.js';
import { centralConflictsMigration } from './0003_conflicts.js';
import { centralNotificationsMigration } from './0004_notifications.js';
import { centralReservationLeaseMigration } from './0005_reservation_lease.js';

/** Server-central Postgres migrations, applied in lexical order. */
export const SERVER_MIGRATIONS: PgMigration[] = [
  centralInitMigration,
  centralAuthMigration,
  centralConflictsMigration,
  centralNotificationsMigration,
  centralReservationLeaseMigration,
];
