import type { PgMigration } from '../postgres.js';

const up = `
-- Project-scoped outbound notification webhooks. Signing secrets are generated
-- per webhook and stored only as AES-256-GCM ciphertext; the master key lives in
-- server configuration, never in Postgres.
CREATE TABLE notification_webhooks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL,
  secret_ciphertext BYTEA NOT NULL,
  secret_version INTEGER NOT NULL DEFAULT 1 CHECK (secret_version > 0),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  revoked BOOLEAN NOT NULL DEFAULT FALSE,
  revoked_at TIMESTAMPTZ,
  event_types TEXT[] NOT NULL DEFAULT ARRAY['notification.created']::TEXT[],
  kinds TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by TEXT
);
CREATE INDEX notification_webhooks_project ON notification_webhooks (project_id, enabled, revoked);
CREATE INDEX notification_webhooks_project_created ON notification_webhooks (project_id, created_at DESC, id DESC);

-- Durable outbox. The allowlisted wire payload is materialized at enqueue time;
-- retries reuse it verbatim. UNIQUE(webhook_id, notification_id) is the final
-- idempotency fence in addition to ingest replay filtering.
CREATE TABLE notification_deliveries (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  webhook_id TEXT NOT NULL REFERENCES notification_webhooks(id) ON DELETE CASCADE,
  notification_id TEXT NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload JSONB NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'in_flight', 'retry', 'succeeded', 'dead')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_until TIMESTAMPTZ,
  lease_token TEXT,
  last_attempt_at TIMESTAMPTZ,
  last_http_status INTEGER,
  error_class TEXT,
  error_excerpt TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  UNIQUE (webhook_id, notification_id)
);
CREATE INDEX notification_deliveries_due
  ON notification_deliveries (next_attempt_at, id)
  WHERE state IN ('pending', 'retry');
CREATE INDEX notification_deliveries_lease
  ON notification_deliveries (lease_until, id)
  WHERE state = 'in_flight';
CREATE INDEX notification_deliveries_project
  ON notification_deliveries (project_id, created_at DESC, id DESC);
CREATE INDEX notification_deliveries_webhook
  ON notification_deliveries (webhook_id, created_at DESC, id DESC);

-- One row per claimed HTTP attempt. A started row with no finish after its lease
-- expires is recovery evidence (outcome interrupted), not a silently lost try.
CREATE TABLE webhook_delivery_attempts (
  delivery_id TEXT NOT NULL REFERENCES notification_deliveries(id) ON DELETE CASCADE,
  attempt_no INTEGER NOT NULL CHECK (attempt_no > 0),
  lease_token TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  outcome TEXT NOT NULL DEFAULT 'started'
    CHECK (outcome IN ('started', 'succeeded', 'retry', 'dead', 'interrupted')),
  http_status INTEGER,
  error_class TEXT,
  error_excerpt TEXT,
  secret_version INTEGER NOT NULL CHECK (secret_version > 0),
  PRIMARY KEY (delivery_id, attempt_no),
  UNIQUE (delivery_id, lease_token)
);
CREATE INDEX webhook_delivery_attempts_delivery
  ON webhook_delivery_attempts (delivery_id, attempt_no DESC);
`;

const down = `
DROP TABLE IF EXISTS webhook_delivery_attempts;
DROP TABLE IF EXISTS notification_deliveries;
DROP TABLE IF EXISTS notification_webhooks;
`;

export const centralWebhooksMigration: PgMigration = { id: '0008_webhooks', up, down };
