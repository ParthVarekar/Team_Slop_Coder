import { createHmac, timingSafeEqual } from 'node:crypto';
import { Redactor, SECRET_RULES } from '@weft/core';

export const WEBHOOK_EVENT_TYPE = 'notification.created' as const;

// User-controlled strings can contain token-shaped secrets inside identifiers
// (for example `user_ghp_...`). Core redaction requires word boundaries, which
// intentionally avoid surprising matches; outbound webhooks must instead remove
// known secret patterns even when an adjacent underscore makes no boundary.
const webhookRedactor = new Redactor({
  rules: SECRET_RULES.map((rule) => {
    const relaxed = {
      ...rule,
      regex: new RegExp(
        rule.regex.source.replace(/^\\b/, '').replace(/\\b$/, ''),
        rule.regex.flags,
      ),
    };
    delete relaxed.hint;
    return relaxed;
  }),
});

export function redactWebhookText(text: string): string {
  return webhookRedactor.redactString(text);
}

export interface WebhookNotificationPayload {
  delivery_id: string;
  event_type: typeof WEBHOOK_EVENT_TYPE;
  occurred_at: string;
  notification: {
    id: string;
    kind: string;
    title: string;
    body: string | null;
    target_user_id: string;
  };
}

export function buildWebhookPayload(input: {
  deliveryId: string;
  occurredAt: string;
  notificationId: string;
  kind: string;
  title: string;
  body: string | null;
  targetUserId: string;
}): WebhookNotificationPayload {
  return {
    delivery_id: input.deliveryId,
    event_type: WEBHOOK_EVENT_TYPE,
    occurred_at: input.occurredAt,
    notification: {
      id: input.notificationId,
      kind: redactWebhookText(input.kind),
      title: redactWebhookText(input.title),
      body: input.body === null ? null : redactWebhookText(input.body),
      target_user_id: redactWebhookText(input.targetUserId),
    },
  };
}

/** Fixed key order makes bytes stable even after a Postgres JSONB round-trip. */
export function serializeWebhookPayload(payload: WebhookNotificationPayload): string {
  const safe = buildWebhookPayload({
    deliveryId: payload.delivery_id,
    occurredAt: payload.occurred_at,
    notificationId: payload.notification.id,
    kind: payload.notification.kind,
    title: payload.notification.title,
    body: payload.notification.body,
    targetUserId: payload.notification.target_user_id,
  });
  return JSON.stringify(safe);
}

export function webhookSignature(secret: Buffer, timestampSeconds: string, body: Buffer): string {
  return createHmac('sha256', secret)
    .update(`${timestampSeconds}.`, 'utf8')
    .update(body)
    .digest('hex');
}

export const WEBHOOK_SIGNATURE_TOLERANCE_SECONDS = 300;

/**
 * Receiver-side verification helper for the outbound wire contract. Signature
 * bytes are compared in constant time and timestamps outside the +/-5 minute
 * freshness window are rejected. Receivers must additionally deduplicate
 * x-weft-delivery-id to reject replays inside that window.
 */
export function verifyWebhookSignature(input: {
  secret: Buffer;
  timestampSeconds: string;
  body: Buffer;
  signature: string;
  now?: Date;
  toleranceSeconds?: number;
}): boolean {
  const tolerance = input.toleranceSeconds ?? WEBHOOK_SIGNATURE_TOLERANCE_SECONDS;
  if (
    !Number.isSafeInteger(tolerance) ||
    tolerance < 0 ||
    !/^\d+$/.test(input.timestampSeconds) ||
    !/^v1=[0-9a-f]{64}$/.test(input.signature)
  ) {
    return false;
  }
  const timestamp = Number(input.timestampSeconds);
  if (!Number.isSafeInteger(timestamp)) return false;
  const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1000);
  if (!Number.isSafeInteger(nowSeconds) || Math.abs(nowSeconds - timestamp) > tolerance) {
    return false;
  }
  const expected = Buffer.from(
    webhookSignature(input.secret, input.timestampSeconds, input.body),
    'hex',
  );
  const provided = Buffer.from(input.signature.slice(3), 'hex');
  return expected.length === provided.length && timingSafeEqual(expected, provided);
}

export function buildWebhookHeaders(input: {
  secret: Buffer;
  body: Buffer;
  timestampSeconds: string;
  deliveryId: string;
  eventId: string;
  attempt: number;
}): Record<string, string> {
  return {
    'content-type': 'application/json',
    'x-weft-timestamp': input.timestampSeconds,
    'x-weft-signature': `v1=${webhookSignature(input.secret, input.timestampSeconds, input.body)}`,
    'x-weft-delivery-id': input.deliveryId,
    'x-weft-event-id': input.eventId,
    'x-weft-attempt': String(input.attempt),
  };
}
