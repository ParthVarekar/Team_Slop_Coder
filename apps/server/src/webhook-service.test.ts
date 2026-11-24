import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import type { Logger } from '@weft/core';
import { makeId, ulid, PROTOCOL_VERSION, type EventEnvelope } from '@weft/protocol';
import { openCentralDatabase, type CentralDatabase } from './db.js';
import { IngestService } from './ingest.js';
import { NotificationService } from './notifications-service.js';
import { WebhookService } from './webhook-service.js';
import { decryptWebhookSecret } from './webhook-crypto.js';
import { serializeWebhookPayload } from './webhook-payload.js';
import { startEmbeddedPostgres, type EmbeddedCluster } from '../test/embedded.js';
import { seedWorld, type World } from '../test/identity.js';

let cluster: EmbeddedCluster;
let db: CentralDatabase;
let pool: Pool;
let world: World;
let ingest: IngestService;
let webhooks: WebhookService;
let diagnostics: string[] = [];
const masterKey = Buffer.alloc(32, 7);
const actor = { system: 'weft-test' } as const;

beforeAll(async () => {
  cluster = await startEmbeddedPostgres();
  db = await openCentralDatabase(cluster.databaseUrl);
  pool = db.pool;
  world = await seedWorld(pool);
  const notifications = new NotificationService(pool, {
    error: (...args: unknown[]) => {
      diagnostics.push(JSON.stringify(args));
    },
  } as unknown as Logger);
  ingest = new IngestService(pool, undefined, undefined, undefined, notifications);
  webhooks = new WebhookService(pool, masterKey, false);
}, 120_000);

beforeEach(async () => {
  await pool.query('TRUNCATE notification_webhooks CASCADE');
  diagnostics = [];
});

afterAll(async () => {
  await db?.close();
  await cluster?.stop();
});

function notice(
  kind: string,
  fields: Record<string, unknown> = {},
  projectId = world.projectA,
): EventEnvelope {
  return {
    v: PROTOCOL_VERSION,
    event_id: ulid(),
    device_id: world.deviceId,
    project_id: projectId,
    ts: new Date().toISOString(),
    type: 'notification.created',
    actor: { user_id: world.memberUser, agent: null },
    privacy: 'metadata',
    payload: { kind, target_user_id: world.memberUser, ...fields },
  };
}

async function createHook(kinds: string[] = [], enabled = true, projectId = world.projectA) {
  return webhooks.create(
    projectId,
    {
      projectId,
      endpoint: 'https://example.com/weft-hook',
      eventTypes: ['notification.created'],
      kinds,
      enabled,
    },
    actor,
    'test-admin',
  );
}

describe('atomic webhook enqueue (real Postgres 16)', () => {
  it('redacts title/body, allowlists the payload, and commits notification + outbox together', async () => {
    const secret = `ghp_${'b'.repeat(40)}`;
    const { webhook } = await createHook();
    const event = notice('approval', {
      title: `Approve ${secret}`,
      subject: `Details ${secret}`,
      raw_source: 'private source',
      endpoint: 'https://do-not-forward.invalid',
    });
    const result = await ingest.ingestBatch([event]);
    expect(result.accepted).toHaveLength(1);

    const card = await pool.query('SELECT title, body FROM notifications WHERE id = $1', [
      event.event_id,
    ]);
    expect(card.rows[0]?.title).not.toContain(secret);
    expect(card.rows[0]?.body).not.toContain(secret);
    const delivery = await pool.query(
      'SELECT payload, state, webhook_id FROM notification_deliveries WHERE notification_id = $1',
      [event.event_id],
    );
    expect(delivery.rows).toHaveLength(1);
    expect(delivery.rows[0]).toMatchObject({ state: 'pending', webhook_id: webhook.id });
    const raw = JSON.stringify(delivery.rows[0]?.payload);
    expect(raw).not.toContain(secret);
    expect(raw).not.toContain('private source');
    expect(raw).not.toContain('do-not-forward');
    expect(serializeWebhookPayload(delivery.rows[0]?.payload)).toContain('"delivery_id"');
  });

  it('isolates a webhook enqueue failure without rolling back event ingest or healthy hooks', async () => {
    const bad = await createHook();
    const good = await createHook();
    const secret = `ghp_${'d'.repeat(40)}`;
    await pool.query(`
      CREATE FUNCTION weft_test_fail_delivery() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.webhook_id = '${bad.webhook.id}' THEN
          RAISE EXCEPTION 'forced delivery failure secret=%', '${secret}';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER weft_test_fail_delivery BEFORE INSERT ON notification_deliveries
      FOR EACH ROW EXECUTE FUNCTION weft_test_fail_delivery();
    `);
    const event = notice('failure', { subject: 'must remain durable' });
    try {
      const result = await ingest.ingestBatch([event]);
      expect(result.accepted).toHaveLength(1);
      expect(result.rejected).toHaveLength(0);
      expect(
        (await pool.query('SELECT 1 FROM events WHERE event_id = $1', [event.event_id])).rowCount,
      ).toBe(1);
      expect(
        (await pool.query('SELECT 1 FROM notifications WHERE id = $1', [event.event_id])).rowCount,
      ).toBe(1);
      expect(
        (
          await pool.query('SELECT 1 FROM audit_records WHERE subject = $1', [
            `notification:${event.event_id}`,
          ])
        ).rowCount,
      ).toBe(1);
      expect(
        (
          await pool.query('SELECT 1 FROM notification_deliveries WHERE webhook_id = $1', [
            bad.webhook.id,
          ])
        ).rowCount,
      ).toBe(0);
      expect(
        (
          await pool.query('SELECT 1 FROM notification_deliveries WHERE webhook_id = $1', [
            good.webhook.id,
          ])
        ).rowCount,
      ).toBe(1);
      expect(diagnostics.join('\n')).toContain('webhook delivery enqueue failed');
      expect(diagnostics.join('\n')).not.toContain(secret);
    } finally {
      await pool.query('DROP TRIGGER IF EXISTS weft_test_fail_delivery ON notification_deliveries');
      await pool.query('DROP FUNCTION IF EXISTS weft_test_fail_delivery()');
    }
  });

  it('does not duplicate an outbox row on replay', async () => {
    await createHook();
    const event = notice('mention', { subject: 'replay once' });
    expect((await ingest.ingestBatch([event])).accepted).toHaveLength(1);
    expect((await ingest.ingestBatch([event])).duplicates).toHaveLength(1);
    const rows = await pool.query(
      'SELECT id FROM notification_deliveries WHERE notification_id = $1',
      [event.event_id],
    );
    expect(rows.rowCount).toBe(1);
  });

  it('filters by kind and project while empty kinds means all', async () => {
    const approvals = await createHook(['approval']);
    const regressions = await createHook(['regression']);
    const all = await createHook([]);
    const otherProject = await createHook([], true, world.projectB);
    const approval = notice('approval');
    const regression = notice('regression');
    const question = notice('question');
    await ingest.ingestBatch([approval, regression, question]);
    const forEvent = async (event: EventEnvelope) => {
      const rows = await pool.query(
        'SELECT webhook_id FROM notification_deliveries WHERE notification_id = $1 ORDER BY webhook_id',
        [event.event_id],
      );
      return rows.rows.map((row) => row.webhook_id).sort();
    };
    expect(await forEvent(approval)).toEqual([approvals.webhook.id, all.webhook.id].sort());
    expect(await forEvent(regression)).toEqual([regressions.webhook.id, all.webhook.id].sort());
    expect(await forEvent(question)).toEqual([all.webhook.id]);
    expect(await forEvent(question)).not.toContain(otherProject.webhook.id);
  });

  it('does not enqueue for an individually disabled webhook', async () => {
    const { webhook } = await createHook([], false);
    const event = notice('question');
    await ingest.ingestBatch([event]);
    expect(
      (
        await pool.query('SELECT 1 FROM notification_deliveries WHERE webhook_id = $1', [
          webhook.id,
        ])
      ).rowCount,
    ).toBe(0);
  });
});

describe('webhook secret lifecycle and audit (real Postgres 16)', () => {
  it('persists ciphertext only and returns a one-time secret only from create/rotate', async () => {
    const created = await createHook();
    const firstSecret = created.signing_secret;
    expect(Buffer.from(firstSecret, 'base64url')).toHaveLength(32);
    const stored = await pool.query(
      'SELECT secret_ciphertext, secret_version FROM notification_webhooks WHERE id = $1',
      [created.webhook.id],
    );
    expect(stored.rows[0]?.secret_version).toBe(1);
    expect(stored.rowCount).toBe(1);
    const ciphertext = stored.rows[0]?.secret_ciphertext as Buffer;
    expect(ciphertext.toString('base64')).not.toContain(firstSecret);
    expect(
      decryptWebhookSecret(masterKey, created.webhook.id, world.projectA, 1, ciphertext).toString(),
    ).toBe(firstSecret);
    expect(JSON.stringify(await webhooks.list(world.projectA))).not.toContain(firstSecret);
    expect(JSON.stringify(await webhooks.get(created.webhook.id, world.projectA))).not.toContain(
      firstSecret,
    );

    const rotated = await webhooks.rotate(created.webhook.id, world.projectA, actor);
    expect(rotated.signing_secret).not.toBe(firstSecret);
    expect(rotated.webhook.secret_version).toBe(2);
    const after = await pool.query(
      'SELECT secret_ciphertext, secret_version FROM notification_webhooks WHERE id = $1',
      [created.webhook.id],
    );
    expect(after.rows[0]?.secret_version).toBe(2);
    expect((after.rows[0]?.secret_ciphertext as Buffer).toString('base64')).not.toContain(
      rotated.signing_secret,
    );
    expect(
      decryptWebhookSecret(
        masterKey,
        created.webhook.id,
        world.projectA,
        2,
        after.rows[0]?.secret_ciphertext as Buffer,
      ).toString(),
    ).toBe(rotated.signing_secret);
    // The old ciphertext snapshot remains decryptable with its bound version.
    expect(
      decryptWebhookSecret(masterKey, created.webhook.id, world.projectA, 1, ciphertext).toString(),
    ).toBe(firstSecret);

    const audit = await pool.query(
      'SELECT action, subject FROM audit_records WHERE project_id = $1 AND subject LIKE $2 ORDER BY id',
      [world.projectA, `webhook:${created.webhook.id}`],
    );
    expect(audit.rows.map((row) => row.action)).toEqual(['webhook.created', 'webhook.rotated']);
    expect(JSON.stringify(audit.rows)).not.toContain(firstSecret);
    expect(JSON.stringify(audit.rows)).not.toContain(rotated.signing_secret);
  });

  it('revokes without deleting history and isolates reads by project', async () => {
    const created = await createHook();
    const event = notice('approval');
    await ingest.ingestBatch([event]);
    await expect(webhooks.get(created.webhook.id, world.projectB)).resolves.toBeUndefined();
    await expect(webhooks.revoke(created.webhook.id, world.projectB, actor)).rejects.toMatchObject({
      code: 'not_found',
    });
    const pending = await pool.query(
      'SELECT id FROM notification_deliveries WHERE webhook_id = $1',
      [created.webhook.id],
    );
    await pool.query(
      `UPDATE notification_deliveries
          SET state = 'in_flight', attempt_count = 1, lease_token = 'lease_revoked',
              lease_until = now() + interval '1 minute'
        WHERE id = $1`,
      [pending.rows[0]?.id],
    );
    await pool.query(
      `INSERT INTO webhook_delivery_attempts
         (delivery_id, attempt_no, lease_token, started_at, outcome, secret_version)
       VALUES ($1,1,'lease_revoked',now(),'started',1)`,
      [pending.rows[0]?.id],
    );
    await webhooks.revoke(created.webhook.id, world.projectA, actor);
    expect((await webhooks.get(created.webhook.id, world.projectA))?.revoked).toBe(true);
    const deliveries = await webhooks.listDeliveries(created.webhook.id, world.projectA);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({ state: 'dead', error_class: 'webhook_revoked' });
    const history = await webhooks.getDelivery(deliveries[0]?.id as string, world.projectA);
    expect(history?.delivery.notification_id).toBe(event.event_id);
    expect(history?.attempts[0]).toMatchObject({ outcome: 'interrupted', attempt_no: 1 });
    expect(history?.attempts[0]).not.toHaveProperty('lease_token');
    await expect(
      webhooks.getDelivery(deliveries[0]?.id as string, world.projectB),
    ).resolves.toBeUndefined();
  });

  it('creates stable project-scoped ids and rejects non-HTTPS endpoints', async () => {
    const a = await createHook();
    const b = await createHook([], true, world.projectB);
    expect(a.webhook.id).not.toBe(b.webhook.id);
    expect(a.webhook.project_id).toBe(world.projectA);
    expect(b.webhook.project_id).toBe(world.projectB);
    await expect(
      webhooks.create(
        world.projectA,
        {
          projectId: world.projectA,
          endpoint: 'http://127.0.0.1/hook',
          eventTypes: ['notification.created'],
          kinds: [],
          enabled: true,
        },
        actor,
        null,
      ),
    ).rejects.toMatchObject({ code: 'validation' });
    await expect(
      webhooks.create(
        makeId('project'),
        {
          projectId: makeId('project'),
          endpoint: 'https://example.com/hook',
          eventTypes: ['notification.created'],
          kinds: [],
          enabled: true,
        },
        actor,
        null,
      ),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});
