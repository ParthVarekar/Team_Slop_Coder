import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { metrics, type Logger } from '@weft/core';
import type { WebhookConfig } from './config.js';
import { recordAudit } from './audit.js';
import { clientExecutor, withTransaction } from './pg.js';
import { decryptWebhookSecret, WebhookCryptoError } from './webhook-crypto.js';
import {
  buildWebhookHeaders,
  serializeWebhookPayload,
  type WebhookNotificationPayload,
} from './webhook-payload.js';
import { safeWebhookError } from './webhook-service.js';
import {
  createSafeWebhookTransport,
  WebhookEndpointError,
  type WebhookTransport,
} from './webhook-transport.js';

const claimed = metrics.counter(
  'weft_server_webhook_deliveries_claimed_total',
  'Webhook delivery attempts claimed',
);
const succeeded = metrics.counter(
  'weft_server_webhook_deliveries_succeeded_total',
  'Webhook deliveries succeeded',
);
const retried = metrics.counter(
  'weft_server_webhook_deliveries_retried_total',
  'Webhook deliveries scheduled for retry',
);
const dead = metrics.counter(
  'weft_server_webhook_deliveries_dead_total',
  'Webhook deliveries dead-lettered',
);

export interface ClaimedWebhookDelivery {
  id: string;
  projectId: string;
  webhookId: string;
  eventId: string;
  kind: string;
  endpoint: string;
  payload: WebhookNotificationPayload;
  secretCiphertext: Buffer;
  secretVersion: number;
  attemptNo: number;
  leaseToken: string;
  createdAt: Date;
}

export interface WebhookDispatcherOptions {
  pool: Pool;
  config: WebhookConfig;
  masterKey: Buffer;
  transport?: WebhookTransport;
  logger?: Logger;
  now?: () => Date;
}

type DeliveryOutcome = 'succeeded' | 'retry' | 'dead';

interface FinalizeInput {
  delivery: ClaimedWebhookDelivery;
  outcome: DeliveryOutcome;
  status?: number | undefined;
  retryAfter?: string | undefined;
  error?: unknown;
  sensitiveValues?: readonly string[];
}

function asDate(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

/** Deterministic full jitter: same delivery + attempt always yields the same delay. */
export function webhookBackoffMs(
  deliveryId: string,
  attemptNo: number,
  baseMs: number,
  capMs: number,
): number {
  const exponent = Math.min(Math.max(0, attemptNo - 1), 30);
  const ceiling = Math.min(capMs, baseMs * 2 ** exponent);
  const digest = createHash('sha256').update(`${deliveryId}:${attemptNo}`).digest();
  const fraction = digest.readUInt32BE(0) / 0x1_0000_0000;
  return Math.floor(fraction * ceiling);
}

export function parseRetryAfter(value: string | undefined, now: Date): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  return Number.isFinite(at) ? Math.max(0, at - now.getTime()) : null;
}

export function classifyWebhookStatus(status: number): DeliveryOutcome {
  if (status >= 200 && status < 300) return 'succeeded';
  if (status === 408 || status === 429 || status >= 500) return 'retry';
  return 'dead'; // all 3xx and other 4xx are terminal; redirects are never followed
}

/**
 * PostgreSQL-backed at-least-once dispatcher. Claim/finalize transactions are
 * short and fenced by random lease tokens; transport runs without a DB client.
 */
export class WebhookDispatcher {
  private readonly pool: Pool;
  private readonly config: WebhookConfig;
  private readonly masterKey: Buffer;
  private readonly transport: WebhookTransport;
  private readonly logger: Logger | undefined;
  private readonly now: () => Date;
  private readonly active = new Set<Promise<void>>();
  private timer: NodeJS.Timeout | null = null;
  private loop: Promise<void> | null = null;
  private wakePending = false;
  private stopped = false;
  private stopPromise: Promise<void> | null = null;

  constructor(options: WebhookDispatcherOptions) {
    this.pool = options.pool;
    this.config = options.config;
    this.masterKey = options.masterKey;
    this.logger = options.logger;
    this.now = options.now ?? (() => new Date());
    this.transport =
      options.transport ??
      createSafeWebhookTransport({
        allowPrivateEndpoints: options.config.allowPrivateEndpoints,
        timeoutMs: options.config.timeoutMs,
        responseCapBytes: options.config.responseCapBytes,
      });
  }

  start(): void {
    if (this.stopped || this.timer) return;
    this.timer = setInterval(() => this.notify(), this.config.pollIntervalMs);
    this.timer.unref?.();
    this.notify();
  }

  notify(): void {
    if (this.stopped) return;
    if (this.loop) {
      this.wakePending = true;
      return;
    }
    void this.kick();
  }

  /** Run one coalesced drain; useful for deterministic tests and shutdown. */
  drain(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return this.kick();
  }

  private kick(): Promise<void> {
    if (this.loop) return this.loop;
    const run = this.drainLoop().catch((error: unknown) => {
      this.logger?.error(
        { errorClass: safeWebhookError(error).errorClass },
        'webhook dispatcher drain failed',
      );
    });
    this.loop = run;
    void run.finally(() => {
      if (this.loop === run) this.loop = null;
      if (this.wakePending && !this.stopped) {
        this.wakePending = false;
        void this.kick();
      }
    });
    return run;
  }

  private async drainLoop(): Promise<void> {
    try {
      while (!this.stopped) {
        const slots = this.config.concurrency - this.active.size;
        if (slots <= 0) {
          await Promise.race(this.active);
          continue;
        }
        const deliveries = await this.claim(slots);
        for (const delivery of deliveries) {
          const task = this.process(delivery)
            .catch((error: unknown) => {
              // Finalization can fail after the HTTP request completes. Keep the
              // lease intact so expiry recovery records an interrupted attempt
              // and retries; never turn a transient database error into a
              // premature dead letter or an immediate duplicate send.
              const safe = safeWebhookError(error, [delivery.endpoint]);
              this.logger?.error(
                {
                  deliveryId: delivery.id,
                  projectId: delivery.projectId,
                  webhookId: delivery.webhookId,
                  ...safe,
                },
                'webhook delivery processing failed; lease retained for recovery',
              );
            })
            .finally(() => {
              this.active.delete(task);
            });
          this.active.add(task);
        }
        if (deliveries.length === 0) {
          if (this.active.size === 0) break;
          await Promise.race(this.active);
        } else if (deliveries.length < slots && this.active.size > 0) {
          await Promise.race(this.active);
        }
      }
    } finally {
      await Promise.allSettled([...this.active]);
    }
  }

  private async claim(limit: number): Promise<ClaimedWebhookDelivery[]> {
    return withTransaction(this.pool, async (client) => {
      const now = this.now();
      const result = await client.query(
        `SELECT d.id, d.project_id, d.webhook_id, d.event_id, d.kind, d.payload,
                d.state, d.attempt_count, d.lease_token, d.created_at,
                w.endpoint, w.secret_ciphertext, w.secret_version
           FROM notification_deliveries d
           JOIN notification_webhooks w ON w.id = d.webhook_id AND w.project_id = d.project_id
          WHERE w.enabled = TRUE AND w.revoked = FALSE
            AND ((d.state IN ('pending','retry') AND d.next_attempt_at <= $1)
              OR (d.state = 'in_flight' AND d.lease_until <= $1))
          ORDER BY COALESCE(d.next_attempt_at, d.created_at), d.created_at, d.id
          LIMIT $2
          FOR UPDATE OF d SKIP LOCKED`,
        [now, limit],
      );
      const deliveries: ClaimedWebhookDelivery[] = [];
      for (const row of result.rows) {
        const id = String(row.id);
        const projectId = String(row.project_id);
        const webhookId = String(row.webhook_id);
        const attemptCount = Number(row.attempt_count);
        const createdAt = asDate(row.created_at);
        const previousLease = row.state === 'in_flight' ? row.lease_token : null;
        if (previousLease) {
          await client.query(
            `UPDATE webhook_delivery_attempts
                SET outcome = 'interrupted', finished_at = $3
              WHERE delivery_id = $1 AND lease_token = $2 AND outcome = 'started'`,
            [id, String(previousLease), now],
          );
        }
        const exhaustedByAge = now.getTime() - createdAt.getTime() >= this.config.maxDeliveryAgeMs;
        const exhaustedByAttempts = attemptCount >= this.config.maxAttempts;
        if (exhaustedByAge || exhaustedByAttempts) {
          const errorClass = exhaustedByAge ? 'max_age' : 'max_attempts';
          await client.query(
            `UPDATE notification_deliveries
                SET state = 'dead', completed_at = $2, lease_until = NULL, lease_token = NULL,
                    error_class = $3, error_excerpt = $4, next_attempt_at = $2
              WHERE id = $1`,
            [
              id,
              now,
              errorClass,
              errorClass === 'max_age' ? 'delivery age limit reached' : 'attempt limit reached',
            ],
          );
          await recordAudit(clientExecutor(client), {
            projectId,
            actor: { system: 'weft-server' },
            action: 'webhook.delivery_dead',
            subject: `webhook-delivery:${id}`,
          });
          dead.inc();
          continue;
        }
        const attemptNo = attemptCount + 1;
        const leaseToken = `lease_${randomUUID()}`;
        // The transport has one total deadline; leave a scheduling margin before
        // another worker may recover an apparently abandoned lease.
        const leaseUntil = new Date(now.getTime() + this.config.timeoutMs + 1000);
        await client.query(
          `UPDATE notification_deliveries
              SET state = 'in_flight', attempt_count = $2, next_attempt_at = $3,
                  lease_until = $4, lease_token = $5, last_attempt_at = $3
            WHERE id = $1`,
          [id, attemptNo, now, leaseUntil, leaseToken],
        );
        await client.query(
          `INSERT INTO webhook_delivery_attempts
             (delivery_id, attempt_no, lease_token, started_at, outcome, secret_version)
           VALUES ($1,$2,$3,$4,'started',$5)`,
          [id, attemptNo, leaseToken, now, Number(row.secret_version)],
        );
        claimed.inc();
        deliveries.push({
          id,
          projectId,
          webhookId,
          eventId: String(row.event_id),
          kind: String(row.kind),
          endpoint: String(row.endpoint),
          payload: row.payload as WebhookNotificationPayload,
          secretCiphertext: Buffer.from(row.secret_ciphertext as Uint8Array),
          secretVersion: Number(row.secret_version),
          attemptNo,
          leaseToken,
          createdAt,
        });
      }
      return deliveries;
    });
  }

  private async process(delivery: ClaimedWebhookDelivery): Promise<void> {
    let secretText: string;
    let secret: Buffer;
    try {
      secretText = decryptWebhookSecret(
        this.masterKey,
        delivery.webhookId,
        delivery.projectId,
        delivery.secretVersion,
        delivery.secretCiphertext,
      ).toString('utf8');
      if (!/^[A-Za-z0-9_-]{43}$/.test(secretText)) {
        throw new WebhookCryptoError('invalid webhook signing secret');
      }
      secret = Buffer.from(secretText, 'base64url');
      if (secret.length !== 32 || secret.toString('base64url') !== secretText) {
        throw new WebhookCryptoError('invalid webhook signing secret');
      }
    } catch (error) {
      await this.finalize({ delivery, outcome: 'dead', error });
      return;
    }
    let body: Buffer;
    let headers: Record<string, string>;
    try {
      body = Buffer.from(serializeWebhookPayload(delivery.payload), 'utf8');
      const timestampSeconds = String(Math.floor(this.now().getTime() / 1000));
      headers = buildWebhookHeaders({
        secret,
        body,
        timestampSeconds,
        deliveryId: delivery.id,
        eventId: delivery.eventId,
        attempt: delivery.attemptNo,
      });
    } catch (error) {
      await this.finalize({ delivery, outcome: 'dead', error, sensitiveValues: [secretText] });
      return;
    }
    let response: Awaited<ReturnType<WebhookTransport['send']>>;
    try {
      response = await this.transport.send({
        endpoint: delivery.endpoint,
        body,
        headers,
        timeoutMs: this.config.timeoutMs,
        responseCapBytes: this.config.responseCapBytes,
      });
    } catch (error) {
      const terminal = error instanceof WebhookEndpointError || error instanceof WebhookCryptoError;
      await this.finalize({
        delivery,
        outcome: terminal ? 'dead' : 'retry',
        error,
        sensitiveValues: [secretText],
      });
      return;
    }
    // Keep finalization outside the transport try/catch: a database failure must
    // not be mistaken for an HTTP failure and converted into a duplicate retry.
    await this.finalize({
      delivery,
      outcome: classifyWebhookStatus(response.status),
      status: response.status,
      ...(response.retryAfter !== undefined ? { retryAfter: response.retryAfter } : {}),
    });
  }

  private async finalize(input: FinalizeInput): Promise<boolean> {
    const now = this.now();
    const safe =
      input.error === undefined
        ? null
        : safeWebhookError(input.error, [
            input.delivery.endpoint,
            ...(input.sensitiveValues ?? []),
          ]);
    let outcome = input.outcome;
    let errorClass =
      outcome === 'succeeded'
        ? null
        : (safe?.errorClass ?? (input.status === undefined ? null : 'http_status'));
    let errorExcerpt = safe?.errorExcerpt ?? null;
    if (outcome === 'retry') {
      if (input.delivery.attemptNo >= this.config.maxAttempts) {
        outcome = 'dead';
        errorClass = 'max_attempts';
        errorExcerpt = 'attempt limit reached';
      } else if (
        now.getTime() - input.delivery.createdAt.getTime() >=
        this.config.maxDeliveryAgeMs
      ) {
        outcome = 'dead';
        errorClass = 'max_age';
        errorExcerpt = 'delivery age limit reached';
      }
    }
    let nextAttemptAt = now;
    if (outcome === 'retry') {
      const retryAfter = parseRetryAfter(input.retryAfter, now);
      const delay = Math.min(
        this.config.backoffCapMs,
        retryAfter ??
          webhookBackoffMs(
            input.delivery.id,
            input.delivery.attemptNo,
            this.config.backoffBaseMs,
            this.config.backoffCapMs,
          ),
      );
      nextAttemptAt = new Date(now.getTime() + Math.max(0, delay));
      const deadline = input.delivery.createdAt.getTime() + this.config.maxDeliveryAgeMs;
      if (nextAttemptAt.getTime() > deadline) nextAttemptAt = new Date(deadline);
    }
    const applied = await withTransaction(this.pool, async (client) => {
      const current = await client.query(
        `SELECT state, lease_token FROM notification_deliveries
          WHERE id = $1 FOR UPDATE`,
        [input.delivery.id],
      );
      if (
        current.rows[0]?.state !== 'in_flight' ||
        current.rows[0]?.lease_token !== input.delivery.leaseToken
      ) {
        return false; // stale worker: a recovered lease owns the delivery now
      }
      const attempt = await client.query(
        `UPDATE webhook_delivery_attempts
            SET finished_at = $3, outcome = $4, http_status = $5,
                error_class = $6, error_excerpt = $7
          WHERE delivery_id = $1 AND attempt_no = $2 AND lease_token = $8 AND outcome = 'started'`,
        [
          input.delivery.id,
          input.delivery.attemptNo,
          now,
          outcome,
          input.status ?? null,
          errorClass,
          errorExcerpt,
          input.delivery.leaseToken,
        ],
      );
      if (attempt.rowCount === 0) throw new Error('webhook attempt lease fencing failed');
      await client.query(
        `UPDATE notification_deliveries
            SET state = $3, next_attempt_at = $4, lease_until = NULL, lease_token = NULL,
                last_http_status = $5, error_class = $6, error_excerpt = $7,
                completed_at = CASE WHEN $3::text IN ('succeeded','dead') THEN $2::timestamptz ELSE NULL END
          WHERE id = $1`,
        [
          input.delivery.id,
          now,
          outcome,
          nextAttemptAt,
          input.status ?? null,
          errorClass,
          errorExcerpt,
        ],
      );
      if (outcome === 'succeeded' || outcome === 'dead') {
        await recordAudit(clientExecutor(client), {
          projectId: input.delivery.projectId,
          actor: { system: 'weft-server' },
          action: outcome === 'succeeded' ? 'webhook.delivery_succeeded' : 'webhook.delivery_dead',
          subject: `webhook-delivery:${input.delivery.id}`,
        });
      }
      return true;
    });
    if (!applied) return false;
    if (outcome === 'succeeded') succeeded.inc();
    else if (outcome === 'retry') retried.inc();
    else dead.inc();
    this.logger?.warn(
      {
        deliveryId: input.delivery.id,
        projectId: input.delivery.projectId,
        webhookId: input.delivery.webhookId,
        attempt: input.delivery.attemptNo,
        status: input.status ?? null,
        errorClass,
        errorExcerpt,
      },
      outcome === 'succeeded' ? 'webhook delivered' : 'webhook delivery finalized',
    );
    return true;
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.stopPromise = (async () => {
      if (this.loop) await this.loop;
      await Promise.allSettled([...this.active]);
    })();
    return this.stopPromise;
  }
}
