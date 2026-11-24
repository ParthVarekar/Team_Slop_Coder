import { randomUUID } from 'node:crypto';
import type { Client, Pool } from 'pg';
import { z } from 'zod';
import { metrics, type Logger } from '@weft/core';
import type { Actor, EventEnvelope } from '@weft/protocol';
import { recordAudit } from './audit.js';
import { clientExecutor, withTransaction } from './pg.js';
import {
  decryptWebhookSecret,
  encryptWebhookSecret,
  generateWebhookSecret,
  WebhookCryptoError,
} from './webhook-crypto.js';
import { buildWebhookPayload, redactWebhookText, WEBHOOK_EVENT_TYPE } from './webhook-payload.js';
import {
  parseWebhookEndpoint,
  WebhookEndpointError,
  WebhookTransportError,
} from './webhook-transport.js';

const enqueueFailed = metrics.counter(
  'weft_server_webhook_delivery_enqueue_failed_total',
  'Webhook delivery enqueue failures isolated from event ingest',
);

export const CreateWebhookBodySchema = z.object({
  projectId: z.string().min(1),
  endpoint: z.string().min(1).max(2048),
  eventTypes: z.array(z.literal(WEBHOOK_EVENT_TYPE)).min(1).max(1).default([WEBHOOK_EVENT_TYPE]),
  kinds: z.array(z.string().min(1).max(100)).max(100).default([]),
  enabled: z.boolean().default(true),
});

export const UpdateWebhookBodySchema = z.object({
  projectId: z.string().min(1),
  endpoint: z.string().min(1).max(2048).optional(),
  kinds: z.array(z.string().min(1).max(100)).max(100).optional(),
  enabled: z.boolean().optional(),
});

export type CreateWebhookInput = z.infer<typeof CreateWebhookBodySchema>;
export type UpdateWebhookInput = z.infer<typeof UpdateWebhookBodySchema>;

export interface WebhookInfo {
  id: string;
  project_id: string;
  endpoint: string;
  secret_version: number;
  enabled: boolean;
  revoked: boolean;
  revoked_at: string | null;
  event_types: string[];
  kinds: string[];
  created_at: string;
  updated_at: string;
  created_by: string | null;
}

export interface DeliveryInfo {
  id: string;
  project_id: string;
  webhook_id: string;
  notification_id: string;
  event_id: string;
  event_type: string;
  kind: string;
  state: string;
  attempt_count: number;
  next_attempt_at: string | null;
  lease_until: string | null;
  last_attempt_at: string | null;
  last_http_status: number | null;
  error_class: string | null;
  error_excerpt: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface DeliveryAttemptInfo {
  delivery_id: string;
  attempt_no: number;
  started_at: string;
  finished_at: string | null;
  outcome: string;
  http_status: number | null;
  error_class: string | null;
  error_excerpt: string | null;
  secret_version: number;
}

export type WebhookErrorCode = 'validation' | 'not_found' | 'configuration';

export class WebhookError extends Error {
  constructor(
    readonly code: WebhookErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'WebhookError';
  }
}

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function isoOrNull(value: unknown): string | null {
  return value == null ? null : iso(value);
}

function str(value: unknown): string {
  return String(value);
}

function strOrNull(value: unknown): string | null {
  return value == null ? null : String(value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function rowToWebhook(row: Record<string, unknown>): WebhookInfo {
  return {
    id: str(row.id),
    project_id: str(row.project_id),
    endpoint: str(row.endpoint),
    secret_version: Number(row.secret_version),
    enabled: Boolean(row.enabled),
    revoked: Boolean(row.revoked),
    revoked_at: isoOrNull(row.revoked_at),
    event_types: stringArray(row.event_types),
    kinds: stringArray(row.kinds),
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
    created_by: strOrNull(row.created_by),
  };
}

function rowToDelivery(row: Record<string, unknown>): DeliveryInfo {
  return {
    id: str(row.id),
    project_id: str(row.project_id),
    webhook_id: str(row.webhook_id),
    notification_id: str(row.notification_id),
    event_id: str(row.event_id),
    event_type: str(row.event_type),
    kind: str(row.kind),
    state: str(row.state),
    attempt_count: Number(row.attempt_count),
    next_attempt_at: isoOrNull(row.next_attempt_at),
    lease_until: isoOrNull(row.lease_until),
    last_attempt_at: isoOrNull(row.last_attempt_at),
    last_http_status: row.last_http_status == null ? null : Number(row.last_http_status),
    error_class: strOrNull(row.error_class),
    error_excerpt: strOrNull(row.error_excerpt),
    created_at: iso(row.created_at),
    completed_at: isoOrNull(row.completed_at),
  };
}

function rowToAttempt(row: Record<string, unknown>): DeliveryAttemptInfo {
  return {
    delivery_id: str(row.delivery_id),
    attempt_no: Number(row.attempt_no),
    started_at: iso(row.started_at),
    finished_at: isoOrNull(row.finished_at),
    outcome: str(row.outcome),
    http_status: row.http_status == null ? null : Number(row.http_status),
    error_class: strOrNull(row.error_class),
    error_excerpt: strOrNull(row.error_excerpt),
    secret_version: Number(row.secret_version),
  };
}

export function safeWebhookError(
  error: unknown,
  sensitiveValues: readonly string[] = [],
): { errorClass: string; errorExcerpt: string } {
  const known = error as { errorClass?: unknown; name?: unknown; message?: unknown } | null;
  const candidate = typeof known?.errorClass === 'string' ? known.errorClass : undefined;
  const candidateIsSafe =
    candidate !== undefined &&
    /^[a-z][a-z0-9_]{0,79}$/.test(candidate) &&
    !sensitiveValues.some((value) => value.length >= 8 && candidate.includes(value));
  const errorClass = candidateIsSafe
    ? candidate
    : error instanceof WebhookCryptoError
      ? 'crypto_error'
      : error instanceof WebhookEndpointError
        ? 'endpoint_error'
        : error instanceof WebhookTransportError
          ? error.errorClass
          : 'transport_error';
  let message = error instanceof Error ? error.message : String(error);
  for (const value of sensitiveValues) {
    if (value.length >= 8) message = message.split(value).join('[REDACTED:webhook]');
  }
  return {
    errorClass,
    errorExcerpt: redactWebhookText(message).replace(/\s+/g, ' ').slice(0, 256),
  };
}

function normalizeEndpoint(raw: string, allowPrivateEndpoints: boolean): string {
  try {
    return parseWebhookEndpoint(raw, allowPrivateEndpoints).url.toString();
  } catch (error) {
    if (error instanceof WebhookEndpointError) {
      throw new WebhookError('validation', error.message);
    }
    throw error;
  }
}

/**
 * Atomically materialize one durable outbox row per active matching webhook.
 * Called only by NotificationService.project() on the ingest Client; no HTTP,
 * DNS, timers, or other network work happens in this transaction.
 *
 * Each webhook gets a savepoint so a webhook-specific enqueue failure cannot
 * abort the surrounding event/notification transaction or block healthy hooks.
 */
export async function enqueueNotificationDeliveries(
  client: Client,
  event: EventEnvelope,
  notification: { id: string; kind: string; title: string; body: string | null; user_id: string },
  logger?: Logger,
): Promise<number> {
  const matched = await client.query(
    `SELECT id FROM notification_webhooks
      WHERE project_id = $1 AND enabled = TRUE AND revoked = FALSE
        AND $2 = ANY(event_types)
        AND (cardinality(kinds) = 0 OR $3 = ANY(kinds))
      ORDER BY id`,
    [event.project_id, WEBHOOK_EVENT_TYPE, notification.kind],
  );
  let enqueued = 0;
  for (const row of matched.rows) {
    const webhookId = String(row.id);
    await client.query('SAVEPOINT weft_webhook_enqueue');
    try {
      const deliveryId = `dlv_${randomUUID()}`;
      const payload = buildWebhookPayload({
        deliveryId,
        occurredAt: event.ts,
        notificationId: notification.id,
        kind: notification.kind,
        title: notification.title,
        body: notification.body,
        targetUserId: notification.user_id,
      });
      const inserted = await client.query(
        `INSERT INTO notification_deliveries
           (id, project_id, webhook_id, notification_id, event_id, event_type, kind, payload)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
         ON CONFLICT (webhook_id, notification_id) DO NOTHING`,
        [
          deliveryId,
          event.project_id,
          webhookId,
          notification.id,
          event.event_id,
          WEBHOOK_EVENT_TYPE,
          notification.kind,
          JSON.stringify(payload),
        ],
      );
      if (inserted.rowCount !== 0) enqueued++;
      await client.query('RELEASE SAVEPOINT weft_webhook_enqueue');
    } catch (error) {
      await client.query('ROLLBACK TO SAVEPOINT weft_webhook_enqueue');
      await client.query('RELEASE SAVEPOINT weft_webhook_enqueue');
      const safe = safeWebhookError(error);
      enqueueFailed.inc();
      logger?.error(
        {
          projectId: event.project_id,
          eventId: event.event_id,
          webhookId,
          ...safe,
        },
        'webhook delivery enqueue failed',
      );
    }
  }
  return enqueued;
}

export class WebhookService {
  constructor(
    private readonly pool: Pool,
    private readonly masterKey: Buffer | undefined,
    private readonly allowPrivateEndpoints: boolean,
  ) {}

  private requireKey(): Buffer {
    if (!this.masterKey) {
      throw new WebhookError(
        'configuration',
        'webhook signing requires WEFT_SERVER_WEBHOOK_MASTER_KEY',
      );
    }
    return this.masterKey;
  }

  async create(
    projectId: string,
    input: CreateWebhookInput,
    actor: Actor,
    createdBy: string | null,
  ): Promise<{ webhook: WebhookInfo; signing_secret: string }> {
    const project = await this.pool.query('SELECT 1 FROM projects WHERE id = $1', [projectId]);
    if (project.rows.length === 0) throw new WebhookError('not_found', 'project not found');
    const masterKey = this.requireKey();
    const endpoint = normalizeEndpoint(input.endpoint, this.allowPrivateEndpoints);
    const id = `whk_${randomUUID()}`;
    const secret = generateWebhookSecret();
    const secretVersion = 1;
    const ciphertext = encryptWebhookSecret(masterKey, id, projectId, secretVersion, secret);
    return withTransaction(this.pool, async (client) => {
      const result = await client.query(
        `INSERT INTO notification_webhooks
           (id, project_id, endpoint, secret_ciphertext, secret_version, enabled, event_types, kinds, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING id, project_id, endpoint, secret_version, enabled, revoked, revoked_at,
                   event_types, kinds, created_at, updated_at, created_by`,
        [
          id,
          projectId,
          endpoint,
          ciphertext,
          secretVersion,
          input.enabled,
          input.eventTypes,
          input.kinds,
          createdBy,
        ],
      );
      await recordAudit(clientExecutor(client), {
        projectId,
        actor,
        action: 'webhook.created',
        subject: `webhook:${id}`,
      });
      return {
        webhook: rowToWebhook(result.rows[0] as Record<string, unknown>),
        signing_secret: secret,
      };
    });
  }

  async list(projectId: string, limit = 200): Promise<WebhookInfo[]> {
    const result = await this.pool.query(
      `SELECT id, project_id, endpoint, secret_version, enabled, revoked, revoked_at,
              event_types, kinds, created_at, updated_at, created_by
         FROM notification_webhooks WHERE project_id = $1
        ORDER BY created_at DESC, id DESC LIMIT $2`,
      [projectId, limit],
    );
    return result.rows.map((row) => rowToWebhook(row));
  }

  async get(id: string, projectId: string): Promise<WebhookInfo | undefined> {
    const result = await this.pool.query(
      `SELECT id, project_id, endpoint, secret_version, enabled, revoked, revoked_at,
              event_types, kinds, created_at, updated_at, created_by
         FROM notification_webhooks WHERE id = $1 AND project_id = $2`,
      [id, projectId],
    );
    return result.rows[0] ? rowToWebhook(result.rows[0]) : undefined;
  }

  async update(
    id: string,
    projectId: string,
    input: UpdateWebhookInput,
    actor: Actor,
  ): Promise<WebhookInfo> {
    const endpoint =
      input.endpoint === undefined
        ? undefined
        : normalizeEndpoint(input.endpoint, this.allowPrivateEndpoints);
    return withTransaction(this.pool, async (client) => {
      const current = await client.query(
        'SELECT id FROM notification_webhooks WHERE id = $1 AND project_id = $2 FOR UPDATE',
        [id, projectId],
      );
      if (current.rows.length === 0) throw new WebhookError('not_found', 'webhook not found');
      const result = await client.query(
        `UPDATE notification_webhooks
            SET endpoint = COALESCE($3, endpoint),
                kinds = COALESCE($4, kinds),
                enabled = COALESCE($5, enabled),
                updated_at = now()
          WHERE id = $1 AND project_id = $2
        RETURNING id, project_id, endpoint, secret_version, enabled, revoked, revoked_at,
                  event_types, kinds, created_at, updated_at, created_by`,
        [id, projectId, endpoint ?? null, input.kinds ?? null, input.enabled ?? null],
      );
      await recordAudit(clientExecutor(client), {
        projectId,
        actor,
        action: 'webhook.updated',
        subject: `webhook:${id}`,
      });
      return rowToWebhook(result.rows[0] as Record<string, unknown>);
    });
  }

  async rotate(
    id: string,
    projectId: string,
    actor: Actor,
  ): Promise<{ webhook: WebhookInfo; signing_secret: string }> {
    const masterKey = this.requireKey();
    const secret = generateWebhookSecret();
    return withTransaction(this.pool, async (client) => {
      const current = await client.query(
        `SELECT id, secret_version FROM notification_webhooks
          WHERE id = $1 AND project_id = $2 FOR UPDATE`,
        [id, projectId],
      );
      if (current.rows.length === 0) throw new WebhookError('not_found', 'webhook not found');
      const version = Number(current.rows[0]?.secret_version) + 1;
      const ciphertext = encryptWebhookSecret(masterKey, id, projectId, version, secret);
      const result = await client.query(
        `UPDATE notification_webhooks
            SET secret_ciphertext = $3, secret_version = $4, updated_at = now()
          WHERE id = $1 AND project_id = $2
        RETURNING id, project_id, endpoint, secret_version, enabled, revoked, revoked_at,
                  event_types, kinds, created_at, updated_at, created_by`,
        [id, projectId, ciphertext, version],
      );
      await recordAudit(clientExecutor(client), {
        projectId,
        actor,
        action: 'webhook.rotated',
        subject: `webhook:${id}`,
      });
      return {
        webhook: rowToWebhook(result.rows[0] as Record<string, unknown>),
        signing_secret: secret,
      };
    });
  }

  async revoke(id: string, projectId: string, actor: Actor): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      const result = await client.query(
        `UPDATE notification_webhooks
            SET enabled = FALSE, revoked = TRUE, revoked_at = now(), updated_at = now()
          WHERE id = $1 AND project_id = $2 AND revoked = FALSE`,
        [id, projectId],
      );
      if (result.rowCount === 0) {
        const existing = await client.query(
          'SELECT 1 FROM notification_webhooks WHERE id = $1 AND project_id = $2',
          [id, projectId],
        );
        if (existing.rows.length === 0) throw new WebhookError('not_found', 'webhook not found');
        return;
      }
      // Lock deliveries before touching attempts, matching finalize's lock order.
      // In-flight requests may already have reached the receiver, but revocation
      // fences their finalization and prevents every future retry.
      const affected = await client.query(
        `SELECT id FROM notification_deliveries
          WHERE webhook_id = $1 AND project_id = $2
            AND state IN ('pending', 'retry', 'in_flight')
          FOR UPDATE`,
        [id, projectId],
      );
      const deliveryIds = affected.rows.map((row) => String(row.id));
      if (deliveryIds.length > 0) {
        await client.query(
          `UPDATE webhook_delivery_attempts
              SET outcome = 'interrupted', finished_at = now()
            WHERE delivery_id = ANY($1::text[]) AND outcome = 'started'`,
          [deliveryIds],
        );
        await client.query(
          `UPDATE notification_deliveries
              SET state = 'dead', completed_at = now(), error_class = 'webhook_revoked',
                  error_excerpt = 'webhook revoked', lease_until = NULL, lease_token = NULL,
                  next_attempt_at = now()
            WHERE id = ANY($1::text[])`,
          [deliveryIds],
        );
      }
      await recordAudit(clientExecutor(client), {
        projectId,
        actor,
        action: 'webhook.revoked',
        subject: `webhook:${id}`,
      });
    });
  }

  async listDeliveries(webhookId: string, projectId: string, limit = 200): Promise<DeliveryInfo[]> {
    const webhook = await this.get(webhookId, projectId);
    if (!webhook) throw new WebhookError('not_found', 'webhook not found');
    const result = await this.pool.query(
      `SELECT id, project_id, webhook_id, notification_id, event_id, event_type, kind, state,
              attempt_count, next_attempt_at, lease_until, last_attempt_at, last_http_status,
              error_class, error_excerpt, created_at, completed_at
         FROM notification_deliveries
        WHERE webhook_id = $1 AND project_id = $2
        ORDER BY created_at DESC, id DESC LIMIT $3`,
      [webhookId, projectId, limit],
    );
    return result.rows.map((row) => rowToDelivery(row));
  }

  async getDelivery(
    deliveryId: string,
    projectId: string,
  ): Promise<{ delivery: DeliveryInfo; attempts: DeliveryAttemptInfo[] } | undefined> {
    const result = await this.pool.query(
      `SELECT id, project_id, webhook_id, notification_id, event_id, event_type, kind, state,
              attempt_count, next_attempt_at, lease_until, last_attempt_at, last_http_status,
              error_class, error_excerpt, created_at, completed_at
         FROM notification_deliveries WHERE id = $1 AND project_id = $2`,
      [deliveryId, projectId],
    );
    if (!result.rows[0]) return undefined;
    const attempts = await this.pool.query(
      `SELECT delivery_id, attempt_no, started_at, finished_at, outcome,
              http_status, error_class, error_excerpt, secret_version
         FROM webhook_delivery_attempts WHERE delivery_id = $1
        ORDER BY attempt_no DESC`,
      [deliveryId],
    );
    return {
      delivery: rowToDelivery(result.rows[0]),
      attempts: attempts.rows.map((row) => rowToAttempt(row)),
    };
  }

  /** Decrypt a ciphertext snapshot claimed from Postgres (rotation-safe). */
  decryptClaimedSecret(
    webhookId: string,
    projectId: string,
    version: number,
    ciphertext: Buffer,
  ): Buffer {
    return decryptWebhookSecret(this.requireKey(), webhookId, projectId, version, ciphertext);
  }
}
