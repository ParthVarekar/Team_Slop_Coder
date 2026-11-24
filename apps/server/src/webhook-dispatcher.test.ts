import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { ulid, PROTOCOL_VERSION, type EventEnvelope } from '@weft/protocol';
import type { Logger } from '@weft/core';
import { openCentralDatabase, type CentralDatabase } from './db.js';
import { IngestService } from './ingest.js';
import { NotificationService } from './notifications-service.js';
import { WebhookService } from './webhook-service.js';
import { WebhookConfigSchema, type WebhookConfig } from './config.js';
import { WebhookDispatcher, webhookBackoffMs } from './webhook-dispatcher.js';
import { serializeWebhookPayload, webhookSignature } from './webhook-payload.js';
import type {
  WebhookTransport,
  WebhookTransportRequest,
  WebhookTransportResponse,
} from './webhook-transport.js';
import { startEmbeddedPostgres, type EmbeddedCluster } from '../test/embedded.js';
import { seedWorld, type World } from '../test/identity.js';

let cluster: EmbeddedCluster;
let db: CentralDatabase;
let pool: Pool;
let world: World;
let ingest: IngestService;
let webhooks: WebhookService;
const masterKey = Buffer.alloc(32, 11);
const actor = { system: 'weft-test' } as const;
const dispatchers: WebhookDispatcher[] = [];

beforeAll(async () => {
  cluster = await startEmbeddedPostgres();
  db = await openCentralDatabase(cluster.databaseUrl);
  pool = db.pool;
  world = await seedWorld(pool);
  const notifications = new NotificationService(pool);
  ingest = new IngestService(pool, undefined, undefined, undefined, notifications);
  webhooks = new WebhookService(pool, masterKey, true);
}, 120_000);

beforeEach(async () => {
  await pool.query('TRUNCATE notification_webhooks CASCADE');
});

afterEach(async () => {
  await Promise.all(dispatchers.splice(0).map((dispatcher) => dispatcher.stop()));
});

afterAll(async () => {
  await db?.close();
  await cluster?.stop();
});

function notice(kind = 'approval'): EventEnvelope {
  return {
    v: PROTOCOL_VERSION,
    event_id: ulid(),
    device_id: world.deviceId,
    project_id: world.projectA,
    ts: new Date().toISOString(),
    type: 'notification.created',
    actor: { user_id: world.memberUser, agent: null },
    privacy: 'metadata',
    payload: {
      kind,
      subject: 'Review this',
      title: 'Please review',
      target_user_id: world.memberUser,
    },
  };
}

async function createHook(endpoint = 'https://example.com/hook') {
  return webhooks.create(
    world.projectA,
    {
      projectId: world.projectA,
      endpoint,
      eventTypes: ['notification.created'],
      kinds: [],
      enabled: true,
    },
    actor,
    'test-admin',
  );
}

function config(overrides: Partial<WebhookConfig> = {}): WebhookConfig {
  return WebhookConfigSchema.parse({
    enabled: true,
    masterKey: masterKey.toString('hex'),
    allowPrivateEndpoints: true,
    pollIntervalMs: 60_000,
    ...overrides,
  });
}

function dispatcher(
  transport: WebhookTransport,
  overrides: Partial<WebhookConfig> = {},
  now: () => Date = () => new Date(),
  logger?: Logger,
): WebhookDispatcher {
  const value = new WebhookDispatcher({
    pool,
    config: config(overrides),
    masterKey,
    transport,
    now,
    ...(logger ? { logger } : {}),
  });
  dispatchers.push(value);
  return value;
}

async function deliveryFor(eventId: string): Promise<Record<string, unknown>> {
  const result = await pool.query('SELECT * FROM notification_deliveries WHERE event_id = $1', [
    eventId,
  ]);
  expect(result.rowCount).toBe(1);
  return result.rows[0] as Record<string, unknown>;
}

async function attemptRows(deliveryId: string): Promise<Record<string, unknown>[]> {
  return (
    await pool.query(
      'SELECT * FROM webhook_delivery_attempts WHERE delivery_id = $1 ORDER BY attempt_no',
      [deliveryId],
    )
  ).rows;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition timed out');
    await new Promise((done) => setTimeout(done, 5));
  }
}

describe('durable dispatcher retries (real Postgres 16)', () => {
  it('retries across restart with stable id/body and a fresh attempt header', async () => {
    await createHook();
    const event = notice();
    await ingest.ingestBatch([event]);
    let clock = new Date();
    const requests: WebhookTransportRequest[] = [];
    const diagnostics: string[] = [];
    const diagnosticLogger = {
      warn: (...args: unknown[]) => {
        diagnostics.push(JSON.stringify(args));
      },
      error: (...args: unknown[]) => {
        diagnostics.push(JSON.stringify(args));
      },
    } as unknown as Logger;
    const first = dispatcher(
      {
        send: async (request) => {
          requests.push(request);
          return { status: 503 };
        },
      },
      {},
      () => clock,
      diagnosticLogger,
    );
    await first.drain();
    const retry = await deliveryFor(event.event_id);
    expect(retry.state, diagnostics.join('\n')).toBe('retry');
    expect(retry.attempt_count).toBe(1);
    expect(new Date(retry.next_attempt_at as string).getTime()).toBeGreaterThan(clock.getTime());
    await first.stop();

    clock = new Date(clock.getTime() + 60_000);
    const second = dispatcher(
      {
        send: async (request) => {
          requests.push(request);
          return { status: 200 };
        },
      },
      {},
      () => clock,
    );
    await second.drain();
    expect((await deliveryFor(event.event_id)).state).toBe('succeeded');
    expect((await deliveryFor(event.event_id)).error_class).toBeNull();
    expect(requests).toHaveLength(2);
    expect(requests[0]?.body.equals(requests[1]?.body)).toBe(true);
    expect(requests.map((request) => request.headers['x-weft-delivery-id'])).toEqual([
      retry.id,
      retry.id,
    ]);
    expect(requests.map((request) => request.headers['x-weft-attempt'])).toEqual(['1', '2']);
    expect((await attemptRows(retry.id as string)).map((row) => row.outcome)).toEqual([
      'retry',
      'succeeded',
    ]);
  });

  it('persists deterministic jitter bounds and clamps Retry-After to the cap', async () => {
    await createHook();
    const jittered = notice('question');
    const throttled = notice('mention');
    await ingest.ingestBatch([jittered, throttled]);
    const clock = new Date();
    const value = dispatcher(
      {
        send: async (request) => {
          const payload = JSON.parse(request.body.toString('utf8')) as {
            notification: { id: string };
          };
          return payload.notification.id === throttled.event_id
            ? { status: 429, retryAfter: '120' }
            : { status: 500 };
        },
      },
      { backoffBaseMs: 500, backoffCapMs: 30_000 },
      () => clock,
    );
    await value.drain();
    const jitterRow = await deliveryFor(jittered.event_id);
    const jitterDelay = new Date(jitterRow.next_attempt_at as string).getTime() - clock.getTime();
    expect(jitterDelay).toBeGreaterThanOrEqual(0);
    expect(jitterDelay).toBeLessThanOrEqual(500);
    expect(jitterDelay).toBe(webhookBackoffMs(jitterRow.id as string, 1, 500, 30_000));
    const throttleRow = await deliveryFor(throttled.event_id);
    expect(new Date(throttleRow.next_attempt_at as string).getTime() - clock.getTime()).toBe(
      30_000,
    );
  });

  it('dead-letters at attempt and age limits without another request', async () => {
    const { webhook } = await createHook();
    const attemptsEvent = notice('failure');
    const ageEvent = notice('regression');
    await ingest.ingestBatch([attemptsEvent, ageEvent]);
    const clock = new Date();
    await pool.query(
      `UPDATE notification_deliveries SET created_at = $2, next_attempt_at = $2
        WHERE webhook_id = $1 AND event_id = $3`,
      [webhook.id, new Date(clock.getTime() - 5000), ageEvent.event_id],
    );
    let calls = 0;
    const value = dispatcher(
      {
        send: async () => {
          calls++;
          return { status: 503 };
        },
      },
      { maxAttempts: 1, maxDeliveryAgeMs: 1000 },
      () => clock,
    );
    await value.drain();
    expect(calls).toBe(1);
    expect(await deliveryFor(attemptsEvent.event_id)).toMatchObject({
      state: 'dead',
      error_class: 'max_attempts',
    });
    expect(await deliveryFor(ageEvent.event_id)).toMatchObject({
      state: 'dead',
      error_class: 'max_age',
    });
  });

  it('treats redirects as terminal and never asks the transport to follow them', async () => {
    await createHook();
    const event = notice();
    await ingest.ingestBatch([event]);
    let calls = 0;
    const diagnostics: string[] = [];
    const diagnosticLogger = {
      warn: (...args: unknown[]) => {
        diagnostics.push(JSON.stringify(args));
      },
      error: (...args: unknown[]) => {
        diagnostics.push(JSON.stringify(args));
      },
    } as unknown as Logger;
    const value = dispatcher(
      {
        send: async () => {
          calls++;
          return { status: 302 };
        },
      },
      {},
      undefined,
      diagnosticLogger,
    );
    await value.drain();
    expect(calls, diagnostics.join('\n')).toBe(1);
    expect(await deliveryFor(event.event_id)).toMatchObject({
      state: 'dead',
      last_http_status: 302,
    });
  });
});

describe('lease recovery and fencing (real Postgres 16)', () => {
  it('marks an expired claim interrupted and recovers it', async () => {
    const { webhook } = await createHook();
    const event = notice();
    await ingest.ingestBatch([event]);
    const row = await deliveryFor(event.event_id);
    const oldLease = 'lease_crashed';
    const now = new Date();
    await pool.query(
      `UPDATE notification_deliveries
          SET state = 'in_flight', attempt_count = 1, lease_token = $2,
              lease_until = $3, last_attempt_at = $3
        WHERE id = $1`,
      [row.id, oldLease, new Date(now.getTime() - 1000)],
    );
    await pool.query(
      `INSERT INTO webhook_delivery_attempts
         (delivery_id, attempt_no, lease_token, started_at, outcome, secret_version)
       VALUES ($1,1,$2,$3,'started',1)`,
      [row.id, oldLease, now],
    );
    const value = dispatcher({ send: async () => ({ status: 200 }) });
    await value.drain();
    expect(await deliveryFor(event.event_id)).toMatchObject({
      state: 'succeeded',
      attempt_count: 2,
    });
    expect((await attemptRows(row.id as string)).map((attempt) => attempt.outcome)).toEqual([
      'interrupted',
      'succeeded',
    ]);
    expect(row.webhook_id).toBe(webhook.id);
  });

  it('fences stale finalization by lease token', async () => {
    await createHook();
    const event = notice();
    await ingest.ingestBatch([event]);
    const gate = deferred<WebhookTransportResponse>();
    let called = false;
    const value = dispatcher({
      send: async () => {
        called = true;
        return gate.promise;
      },
    });
    const draining = value.drain();
    await waitFor(() => called);
    const row = await deliveryFor(event.event_id);
    await pool.query(
      `UPDATE notification_deliveries SET lease_token = 'lease_new_owner', lease_until = $2
        WHERE id = $1`,
      [row.id, new Date(Date.now() + 60_000)],
    );
    gate.resolve({ status: 200 });
    await draining;
    const after = await deliveryFor(event.event_id);
    expect(after).toMatchObject({ state: 'in_flight', lease_token: 'lease_new_owner' });
    expect((await attemptRows(row.id as string))[0]?.outcome).toBe('started');
    const audits = await pool.query('SELECT action FROM audit_records WHERE subject = $1', [
      `webhook-delivery:${row.id as string}`,
    ]);
    expect(audits.rowCount).toBe(0);
  });

  it('re-delivers after crash-after-success at least once with the same body/id', async () => {
    await createHook();
    const event = notice();
    await ingest.ingestBatch([event]);
    const row = await deliveryFor(event.event_id);
    const now = new Date();
    await pool.query(
      `UPDATE notification_deliveries
          SET state = 'in_flight', attempt_count = 1, lease_token = 'lease_after_success',
              lease_until = $2, last_attempt_at = $2
        WHERE id = $1`,
      [row.id, new Date(now.getTime() - 1000)],
    );
    await pool.query(
      `INSERT INTO webhook_delivery_attempts
         (delivery_id, attempt_no, lease_token, started_at, outcome, secret_version)
       VALUES ($1,1,'lease_after_success',$2,'started',1)`,
      [row.id, now],
    );
    const expectedBody = Buffer.from(
      serializeWebhookPayload(row.payload as Parameters<typeof serializeWebhookPayload>[0]),
    );
    const requests: WebhookTransportRequest[] = [];
    const value = dispatcher({
      send: async (request) => {
        requests.push(request);
        return { status: 200 };
      },
    });
    await value.drain();
    expect(requests).toHaveLength(1); // plus the receiver success simulated above
    expect(requests[0]?.body.equals(expectedBody)).toBe(true);
    expect(requests[0]?.headers['x-weft-delivery-id']).toBe(row.id);
    expect(requests[0]?.headers['x-weft-attempt']).toBe('2');
    expect((await attemptRows(row.id as string)).map((attempt) => attempt.outcome)).toEqual([
      'interrupted',
      'succeeded',
    ]);
  });

  it('retains the lease for recovery when delivery finalization fails', async () => {
    await createHook();
    const event = notice();
    await ingest.ingestBatch([event]);
    const clock = new Date();
    let calls = 0;
    const value = dispatcher(
      {
        send: async () => {
          calls++;
          return { status: calls === 1 ? 503 : 200 };
        },
      },
      {},
      () => clock,
    );
    const internals = value as unknown as {
      finalize: (input: unknown) => Promise<boolean>;
    };
    const finalize = internals.finalize.bind(value);
    let failOnce = true;
    internals.finalize = async (input: unknown) => {
      if (failOnce) {
        failOnce = false;
        throw new Error('temporary finalization failure');
      }
      return finalize(input);
    };
    await value.drain();
    const interrupted = await deliveryFor(event.event_id);
    expect(interrupted).toMatchObject({ state: 'in_flight', attempt_count: 1 });
    expect((await attemptRows(interrupted.id as string))[0]?.outcome).toBe('started');
    expect(calls).toBe(1);

    internals.finalize = finalize;
    clock.setTime(clock.getTime() + config().timeoutMs + 1001);
    await value.drain();
    expect(await deliveryFor(event.event_id)).toMatchObject({
      state: 'succeeded',
      attempt_count: 2,
    });
    expect((await attemptRows(interrupted.id as string)).map((attempt) => attempt.outcome)).toEqual(
      ['interrupted', 'succeeded'],
    );
    expect(calls).toBe(2);
  });

  it('uses concurrent SKIP LOCKED claims without duplicate sends', async () => {
    await createHook();
    const events = Array.from({ length: 6 }, () => notice());
    await ingest.ingestBatch(events);
    const seen: string[] = [];
    let active = 0;
    let maxActive = 0;
    const transport: WebhookTransport = {
      send: async (request) => {
        active++;
        maxActive = Math.max(maxActive, active);
        seen.push(request.headers['x-weft-delivery-id'] as string);
        await new Promise((done) => setTimeout(done, 20));
        active--;
        return { status: 200 };
      },
    };
    const first = dispatcher(transport, { concurrency: 2 });
    const second = dispatcher(transport, { concurrency: 2 });
    await Promise.all([first.drain(), second.drain()]);
    expect(seen).toHaveLength(6);
    expect(new Set(seen).size).toBe(6);
    expect(maxActive).toBeGreaterThan(1);
    expect(maxActive).toBeLessThanOrEqual(4);
  });
});

describe('rotation, failure isolation, and lifecycle (real Postgres 16)', () => {
  it('keeps the claimed secret snapshot during rotation and signs the retry with the new version', async () => {
    const created = await createHook();
    const event = notice();
    await ingest.ingestBatch([event]);
    const clock = new Date();
    const gate = deferred<WebhookTransportResponse>();
    const requests: WebhookTransportRequest[] = [];
    const first = dispatcher(
      {
        send: async (request) => {
          requests.push(request);
          return gate.promise;
        },
      },
      {},
      () => clock,
    );
    const draining = first.drain();
    await waitFor(() => requests.length === 1);
    const rotated = await webhooks.rotate(created.webhook.id, world.projectA, actor);
    gate.resolve({ status: 503 });
    await draining;
    const row = await deliveryFor(event.event_id);
    clock.setTime(clock.getTime() + 60_000);
    const second = dispatcher(
      {
        send: async (request) => {
          requests.push(request);
          return { status: 200 };
        },
      },
      {},
      () => clock,
    );
    await second.drain();
    expect(requests).toHaveLength(2);
    expect(requests[0]?.headers['x-weft-signature']).toBe(
      `v1=${webhookSignature(Buffer.from(created.signing_secret, 'base64url'), requests[0]?.headers['x-weft-timestamp'] as string, requests[0]?.body as Buffer)}`,
    );
    expect(requests[1]?.headers['x-weft-signature']).toBe(
      `v1=${webhookSignature(Buffer.from(rotated.signing_secret, 'base64url'), requests[1]?.headers['x-weft-timestamp'] as string, requests[1]?.body as Buffer)}`,
    );
    expect((await attemptRows(row.id as string)).map((attempt) => attempt.secret_version)).toEqual([
      1, 2,
    ]);
  });

  it('isolates one failing webhook, redacts errors/logs, and never rolls back notifications', async () => {
    const bad = await createHook('https://bad.example.com/hook');
    const good = await createHook('https://good.example.com/hook');
    const events = [notice('approval'), notice('regression')];
    await ingest.ingestBatch(events);
    const secret = `ghp_${'c'.repeat(40)}`;
    const logs: string[] = [];
    const logger = {
      warn: (...args: unknown[]) => {
        logs.push(JSON.stringify(args));
      },
      error: (...args: unknown[]) => {
        logs.push(JSON.stringify(args));
      },
    } as unknown as Logger;
    const value = dispatcher(
      {
        send: async (request) => {
          if (request.endpoint.includes('bad.example.com')) {
            throw new Error(`network secret=${secret} signing=${bad.signing_secret}`);
          }
          return { status: 200 };
        },
      },
      { maxAttempts: 1, concurrency: 4 },
      undefined,
      logger,
    );
    await value.drain();
    const cards = await pool.query(
      'SELECT id FROM notifications WHERE project_id = $1 AND id = ANY($2)',
      [world.projectA, events.map((event) => event.event_id)],
    );
    expect(cards.rowCount).toBe(2);
    const badRows = await pool.query(
      'SELECT state, error_excerpt FROM notification_deliveries WHERE webhook_id = $1',
      [bad.webhook.id],
    );
    expect(badRows.rowCount).toBe(2);
    for (const row of badRows.rows) {
      expect(row.state).toBe('dead');
      expect(row.error_excerpt).not.toContain(secret);
      expect(row.error_excerpt).not.toContain(bad.signing_secret);
      expect((row.error_excerpt as string).length).toBeLessThanOrEqual(256);
    }
    const goodRows = await pool.query(
      'SELECT state FROM notification_deliveries WHERE webhook_id = $1',
      [good.webhook.id],
    );
    expect(goodRows.rows.every((row) => row.state === 'succeeded')).toBe(true);
    expect(logs.join('\n')).not.toContain(secret);
    expect(logs.join('\n')).not.toContain(createdSecret(bad));
  });

  it('coalesces wake/drain, starts/stops idempotently, and awaits active work', async () => {
    await createHook();
    const event = notice();
    await ingest.ingestBatch([event]);
    const gate = deferred<WebhookTransportResponse>();
    let calls = 0;
    const value = dispatcher({
      send: async () => {
        calls++;
        return gate.promise;
      },
    });
    const firstDrain = value.drain();
    const overlappingDrain = value.drain();
    expect(overlappingDrain).toBe(firstDrain);
    await waitFor(() => calls === 1);
    value.start();
    value.start();
    value.notify();
    value.notify();
    expect(calls).toBe(1);
    const stopping = value.stop();
    const alsoStopping = value.stop();
    gate.resolve({ status: 200 });
    await Promise.all([stopping, alsoStopping]);
    expect(calls).toBe(1);
    expect((await deliveryFor(event.event_id)).state).toBe('succeeded');
    value.notify();
    value.start();
    await value.drain();
    expect(calls).toBe(1);
  });

  it('sends nothing for disabled webhooks', async () => {
    const created = await webhooks.create(
      world.projectA,
      {
        projectId: world.projectA,
        endpoint: 'https://example.com/hook',
        eventTypes: ['notification.created'],
        kinds: [],
        enabled: false,
      },
      actor,
      null,
    );
    const event = notice();
    await ingest.ingestBatch([event]);
    let calls = 0;
    const value = dispatcher({
      send: async () => {
        calls++;
        return { status: 200 };
      },
    });
    await value.drain();
    expect(calls).toBe(0);
    expect(
      (
        await pool.query('SELECT 1 FROM notification_deliveries WHERE webhook_id = $1', [
          created.webhook.id,
        ])
      ).rowCount,
    ).toBe(0);
  });
});

function createdSecret(value: { signing_secret: string }): string {
  return value.signing_secret;
}
