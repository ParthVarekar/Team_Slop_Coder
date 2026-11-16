import type { PgMigration } from '../postgres.js';

const up = `
-- Inbox display text. The init schema captured only kind/subject_type/subject_id;
-- a triage inbox needs a human headline and a redacted detail body. The projection
-- uses the creating event's id as the notification id, so the primary key doubles
-- as the idempotency key (a replayed notification.created never duplicates a card).
ALTER TABLE notifications ADD COLUMN title TEXT NOT NULL DEFAULT '';
ALTER TABLE notifications ADD COLUMN body TEXT;
CREATE INDEX notifications_project_user_state ON notifications (project_id, user_id, state, created_at);
`;

const down = `
DROP INDEX IF EXISTS notifications_project_user_state;
ALTER TABLE notifications DROP COLUMN IF EXISTS body;
ALTER TABLE notifications DROP COLUMN IF EXISTS title;
`;

export const centralNotificationsMigration: PgMigration = { id: '0004_notifications', up, down };