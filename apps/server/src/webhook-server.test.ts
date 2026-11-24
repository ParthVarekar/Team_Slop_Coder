import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ulid, PROTOCOL_VERSION } from '@weft/protocol';
import { createServer, type TeamServer } from './server.js';
import { ServerConfigSchema } from './config.js';
import type { WebhookTransport, WebhookTransportResponse } from './webhook-transport.js';
import { startEmbeddedPostgres, freePort, type EmbeddedCluster } from '../test/embedded.js';
import { seedWorld, type World } from '../test/identity.js';

let cluster: EmbeddedCluster;
let server: TeamServer;
let baseUrl: string;
let world: World;
let dataDir: string;
let adminToken: string;
let memberToken: string;
let blockTransport = false;
let rejectTransport = false;
let transportGate:
  | {
      promise: Promise<WebhookTransportResponse>;
      resolve: (value: WebhookTransportResponse) => void;
    }
  | undefined;
let transportCalls = 0;
const adminSecret = 'webhook-admin-test';
const masterKey = 'ab'.repeat(32);

const transport: WebhookTransport = {
  send: async () => {
    transportCalls++;
    if (rejectTransport) throw new Error('receiver unavailable');
    if (blockTransport && transportGate) return transportGate.promise;
    return { status: 200 };
  },
};

beforeAll(async () => {
  cluster = await startEmbeddedPostgres();
  dataDir = mkdtempSync(join(tmpdir(), 'weft-webhook-server-'));
  const config = ServerConfigSchema.parse({
    dataDir,
    host: '127.0.0.1',
    port: await freePort(),
    databaseUrl: cluster.databaseUrl,
    logLevel: 'fatal',
    corsOrigin: '*',
    webhooks: {
      enabled: true,
      masterKey,
      pollIntervalMs: 60_000,
      allowPrivateEndpoints: false,
    },
  });
  server = await createServer(config, { adminSecret, webhookTransport: transport });
  baseUrl = await server.listen();
  world = await seedWorld(server.db.pool);
  adminToken = await issue(world.adminUser, 'admin');
  memberToken = await issue(world.memberUser, 'member');
}, 120_000);

beforeEach(async () => {
  await server.db.pool.query('TRUNCATE notification_webhooks CASCADE');
  transportCalls = 0;
  blockTransport = false;
  rejectTransport = false;
  transportGate = undefined;
});

afterAll(async () => {
  await server?.close();
  await cluster?.stop();
  if (dataDir) rmSync(dataDir, { recursive: true, force: true, maxRetries: 5 });
});

async function issue(userId: string, role: 'admin' | 'member'): Promise<string> {
  const response = await fetch(`${baseUrl}/v1/admin/tokens`, {
    method: 'POST',
    headers: { authorization: `Bearer ${adminSecret}`, 'content-type': 'application/json' },
    body: JSON.stringify({ projectId: world.projectA, userId, role }),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { token: string }).token;
}

async function request(
  path: string,
  options: RequestInit = {},
  token = adminSecret,
): Promise<Response> {
  const headers = new Headers(options.headers);
  headers.set('authorization', `Bearer ${token}`);
  if (options.body) headers.set('content-type', 'application/json');
  return fetch(`${baseUrl}${path}`, { ...options, headers });
}

async function createWebhook(kinds: string[] = []) {
  const response = await request('/v1/admin/webhooks', {
    method: 'POST',
    body: JSON.stringify({
      projectId: world.projectA,
      endpoint: 'https://example.com/hook',
      kinds,
    }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as {
    webhook: { id: string; secret_version: number };
    signing_secret: string;
  };
}

function notification(eventId: string, kind: string) {
  return {
    v: PROTOCOL_VERSION,
    event_id: eventId,
    device_id: world.deviceId,
    project_id: world.projectA,
    ts: new Date().toISOString(),
    type: 'notification.created',
    actor: { user_id: world.memberUser, agent: null },
    privacy: 'metadata',
    payload: { kind, title: 'Review', subject: 'Details', target_user_id: world.memberUser },
  };
}

async function waitForDelivery(eventId: string, state: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const result = await server.db.pool.query(
      'SELECT * FROM notification_deliveries WHERE event_id = $1',
      [eventId],
    );
    if (result.rows[0]?.state === state) return result.rows[0] as Record<string, unknown>;
    if (Date.now() > deadline) throw new Error(`delivery did not reach ${state}`);
    await new Promise((done) => setTimeout(done, 10));
  }
}

describe('webhook admin API and project isolation (real Postgres 16)', () => {
  it('creates with a one-time secret, lists/gets ciphertext-free metadata, and audits ids only', async () => {
    const created = await createWebhook(['approval']);
    expect(Buffer.from(created.signing_secret, 'base64url')).toHaveLength(32);
    const list = await request(`/v1/admin/webhooks?projectId=${world.projectA}`);
    expect(list.status).toBe(200);
    const listBody = await list.text();
    expect(listBody).not.toContain(created.signing_secret);
    expect(listBody).not.toContain('secret_ciphertext');
    const get = await request(
      `/v1/admin/webhooks/${created.webhook.id}?projectId=${world.projectA}`,
    );
    expect(get.status).toBe(200);
    expect(await get.text()).not.toContain(created.signing_secret);
    const stored = await server.db.pool.query(
      'SELECT secret_ciphertext FROM notification_webhooks WHERE id = $1',
      [created.webhook.id],
    );
    expect((stored.rows[0]?.secret_ciphertext as Buffer).toString('base64')).not.toContain(
      created.signing_secret,
    );
    const audit = await request(`/v1/admin/audit?projectId=${world.projectA}`);
    const auditText = await audit.text();
    expect(auditText).toContain('webhook.created');
    expect(auditText).toContain(created.webhook.id);
    expect(auditText).not.toContain(created.signing_secret);
    expect(auditText).not.toContain('example.com/hook');
  });

  it('requires admin scope and prevents cross-project reads/writes', async () => {
    const created = await createWebhook();
    const denied = await request(`/v1/admin/webhooks?projectId=${world.projectA}`, {}, memberToken);
    expect(denied.status).toBe(403);
    const cross = await request(
      `/v1/admin/webhooks/${created.webhook.id}?projectId=${world.projectB}`,
      {},
      adminToken,
    );
    expect(cross.status).toBe(403);
    const bootstrapCross = await request(
      `/v1/admin/webhooks/${created.webhook.id}?projectId=${world.projectB}`,
    );
    expect(bootstrapCross.status).toBe(404);
    const otherList = await request(`/v1/admin/webhooks?projectId=${world.projectB}`);
    expect(((await otherList.json()) as { webhooks: unknown[] }).webhooks).toHaveLength(0);
  });

  it('rejects invalid/private endpoints before persistence', async () => {
    for (const endpoint of [
      'http://example.com/hook',
      'https://127.0.0.1/hook',
      'https://user:pass@example.com/hook',
    ]) {
      const response = await request('/v1/admin/webhooks', {
        method: 'POST',
        body: JSON.stringify({ projectId: world.projectA, endpoint }),
      });
      expect(response.status).toBe(400);
    }
  });

  it('patches filters, rotates once, delivers, exposes attempt history, and revokes with history', async () => {
    const created = await createWebhook(['approval']);
    const patched = await request(`/v1/admin/webhooks/${created.webhook.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ projectId: world.projectA, kinds: ['approval'], enabled: true }),
    });
    expect(patched.status).toBe(200);
    const rotated = await request(
      `/v1/admin/webhooks/${created.webhook.id}/rotate?projectId=${world.projectA}`,
      { method: 'POST' },
    );
    expect(rotated.status).toBe(200);
    const rotatedBody = (await rotated.json()) as {
      signing_secret: string;
      webhook: { secret_version: number };
    };
    expect(rotatedBody.signing_secret).not.toBe(created.signing_secret);
    expect(rotatedBody.webhook.secret_version).toBe(2);

    const eventId = ulid();
    const ingested = await request(
      '/v1/ingest',
      {
        method: 'POST',
        body: JSON.stringify({ events: [notification(eventId, 'approval')] }),
      },
      adminToken,
    );
    expect(ingested.status).toBe(202);
    const delivery = await waitForDelivery(eventId, 'succeeded');
    const list = await request(
      `/v1/admin/webhooks/${created.webhook.id}/deliveries?projectId=${world.projectA}`,
    );
    expect(list.status).toBe(200);
    expect(((await list.json()) as { deliveries: unknown[] }).deliveries).toHaveLength(1);
    const history = await request(
      `/v1/admin/webhook-deliveries/${delivery.id}?projectId=${world.projectA}`,
    );
    expect(history.status).toBe(200);
    const historyBody = (await history.json()) as {
      attempts: { outcome: string; secret_version: number }[];
    };
    expect(historyBody.attempts[0]).toMatchObject({ outcome: 'succeeded', secret_version: 2 });
    expect(JSON.stringify(historyBody)).not.toContain('lease_token');
    const cross = await request(
      `/v1/admin/webhook-deliveries/${delivery.id}?projectId=${world.projectB}`,
      {},
      adminToken,
    );
    expect(cross.status).toBe(403);
    const bootstrapCross = await request(
      `/v1/admin/webhook-deliveries/${delivery.id}?projectId=${world.projectB}`,
    );
    expect(bootstrapCross.status).toBe(404);

    const revoked = await request(
      `/v1/admin/webhooks/${created.webhook.id}?projectId=${world.projectA}`,
      { method: 'DELETE' },
    );
    expect(revoked.status).toBe(200);
    const historyAfter = await request(
      `/v1/admin/webhook-deliveries/${delivery.id}?projectId=${world.projectA}`,
    );
    expect(historyAfter.status).toBe(200);
  });

  it('sends nothing when the global dispatcher is disabled', async () => {
    const before = transportCalls;
    const config = ServerConfigSchema.parse({
      dataDir,
      host: '127.0.0.1',
      port: await freePort(),
      databaseUrl: cluster.databaseUrl,
      logLevel: 'fatal',
      corsOrigin: '*',
      webhooks: { enabled: false, masterKey },
    });
    const disabled = await createServer(config, { adminSecret, webhookTransport: transport });
    try {
      const created = await disabled.app.inject({
        method: 'POST',
        url: '/v1/admin/webhooks',
        headers: { authorization: `Bearer ${adminSecret}` },
        payload: { projectId: world.projectA, endpoint: 'https://example.com/disabled' },
      });
      expect(created.statusCode).toBe(201);
      const eventId = ulid();
      const ingested = await disabled.app.inject({
        method: 'POST',
        url: '/v1/ingest',
        headers: { authorization: `Bearer ${adminSecret}` },
        payload: { events: [notification(eventId, 'approval')] },
      });
      expect(ingested.statusCode).toBe(202);
      await new Promise((done) => setTimeout(done, 50));
      expect(transportCalls).toBe(before);
      const rows = await disabled.db.pool.query(
        'SELECT state FROM notification_deliveries WHERE event_id = $1',
        [eventId],
      );
      expect(rows.rows[0]?.state).toBe('pending');
    } finally {
      await disabled.close();
    }
  });

  it('keeps event ingest successful when outbound transport fails', async () => {
    await createWebhook();
    rejectTransport = true;
    const eventId = ulid();
    const ingested = await request(
      '/v1/ingest',
      {
        method: 'POST',
        body: JSON.stringify({ events: [notification(eventId, 'approval')] }),
      },
      adminToken,
    );
    expect(ingested.status).toBe(202);
    expect(((await ingested.json()) as { accepted: unknown[] }).accepted).toHaveLength(1);
    const delivery = await waitForDelivery(eventId, 'retry');
    expect(delivery.error_class).toBe('transport_error');
    expect(
      (await server.db.pool.query('SELECT id FROM notifications WHERE id = $1', [eventId]))
        .rowCount,
    ).toBe(1);
    expect(transportCalls).toBeGreaterThan(0);
  });

  it('stops and awaits active transport work before closing Postgres', async () => {
    const created = await createWebhook();
    blockTransport = true;
    let release!: (value: WebhookTransportResponse) => void;
    transportGate = {
      promise: new Promise<WebhookTransportResponse>((resolve) => {
        release = resolve;
      }),
      resolve: (value) => release(value),
    };
    const eventId = ulid();
    await request('/v1/ingest', {
      method: 'POST',
      body: JSON.stringify({ events: [notification(eventId, 'approval')] }),
    });
    const deadline = Date.now() + 5000;
    while (transportGate && transportCalls >= 0) {
      const row = await server.db.pool.query(
        'SELECT state FROM notification_deliveries WHERE event_id = $1',
        [eventId],
      );
      if (row.rows[0]?.state === 'in_flight') break;
      if (Date.now() > deadline) throw new Error('delivery was not claimed');
      await new Promise((done) => setTimeout(done, 10));
    }
    let closed = false;
    const closing = server.close().then(() => {
      closed = true;
    });
    await new Promise((done) => setTimeout(done, 30));
    expect(closed).toBe(false);
    transportGate.resolve({ status: 200 });
    await closing;
    await expect(server.db.pool.query('SELECT 1')).rejects.toThrow();
    expect(created.webhook.id).toBeTruthy();
  });
});
