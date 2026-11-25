import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeId, ulid, PROTOCOL_VERSION, type Actor, type EventEnvelope } from '@weft/protocol';
import { openCentralDatabase, type CentralDatabase } from './db.js';
import { NotificationService, NotificationError } from './notifications-service.js';
import { IngestService } from './ingest.js';
import { AuthService } from './auth.js';
import type { Origin } from './tasks-service.js';
import { startEmbeddedPostgres, type EmbeddedCluster } from '../test/embedded.js';
import { seedWorld, type World } from '../test/identity.js';

let cluster: EmbeddedCluster;
let db: CentralDatabase;
let notifications: NotificationService;
let ingest: IngestService;
let auth: AuthService;
let world: World;
let origin: Origin;

beforeAll(async () => {
  cluster = await startEmbeddedPostgres();
  db = await openCentralDatabase(cluster.databaseUrl);
  world = await seedWorld(db.pool);
  notifications = new NotificationService(db.pool);
  ingest = new IngestService(db.pool, undefined, undefined, undefined, notifications);
  auth = new AuthService(db.pool);
  origin = { actor: { user_id: world.memberUser, agent: null }, deviceId: world.deviceId };
}, 120_000);

afterAll(async () => {
  await db?.close();
  await cluster?.stop();
});

interface EnvOpts {
  projectId?: string;
  deviceId?: string;
  repoId?: string;
  taskId?: string;
  sessionId?: string;
  actor?: Actor;
}

function envelope(type: string, payload: Record<string, unknown>, o: EnvOpts = {}): EventEnvelope {
  return {
    v: PROTOCOL_VERSION,
    event_id: ulid(),
    device_id: o.deviceId ?? world.deviceId,
    project_id: o.projectId ?? world.projectA,
    ...(o.repoId ? { repo_id: o.repoId } : {}),
    ...(o.taskId ? { task_id: o.taskId } : {}),
    ...(o.sessionId ? { session_id: o.sessionId } : {}),
    ts: new Date().toISOString(),
    type,
    actor: o.actor ?? { user_id: world.memberUser, agent: null },
    privacy: 'metadata',
    payload,
  };
}

interface NoticeFields {
  subject?: string;
  title?: string;
  target_user_id?: string;
  subject_type?: string;
  subject_id?: string;
}

function notice(kind: string, fields: NoticeFields = {}, o: EnvOpts = {}): EventEnvelope {
  return envelope('notification.created', { kind, ...fields }, o);
}

describe('server notification projection (real Postgres 16)', () => {
  it('materializes an inbox card from ingest and is idempotent on replay', async () => {
    const taskId = makeId('task');
    const event = notice(
      'approval',
      { subject: 'Merge task #12?', title: 'Approve merge' },
      { taskId },
    );
    const res = await ingest.ingestBatch([event]);
    expect(res.rejected).toHaveLength(0);
    expect(res.accepted).toHaveLength(1);

    const card = await notifications.get(event.event_id, world.projectA);
    expect(card).toBeTruthy();
    expect(card?.id).toBe(event.event_id);
    expect(card?.user_id).toBe(world.memberUser);
    expect(card?.project_id).toBe(world.projectA);
    expect(card?.kind).toBe('approval');
    expect(card?.title).toBe('Approve merge');
    expect(card?.body).toBe('Merge task #12?');
    expect(card?.subject_type).toBe('task');
    expect(card?.subject_id).toBe(taskId);
    expect(card?.state).toBe('inbox');
    expect(card?.created_at).toBe(event.ts);

    // Replaying the same event must not duplicate the card.
    const replay = await ingest.ingestBatch([event]);
    expect(replay.accepted).toHaveLength(0);
    expect(replay.duplicates).toHaveLength(1);
    expect(
      await notifications.list(world.projectA, { userId: world.memberUser, kind: 'approval' }),
    ).toHaveLength(1);
  });

  it('derives a kind label when no title is supplied', async () => {
    const event = notice('conflict', { subject: 'src/a.ts overlap' });
    await ingest.ingestBatch([event]);
    const card = await notifications.get(event.event_id, world.projectA);
    expect(card?.title).toBe('Conflict');
    expect(card?.body).toBe('src/a.ts overlap');
  });

  it('attributes to target_user_id over the actor, and falls back to the actor user', async () => {
    const targeted = notice('mention', { target_user_id: world.viewerUser });
    const fallback = notice('question', { subject: 'Which approach?' });
    await ingest.ingestBatch([targeted, fallback]);
    expect((await notifications.get(targeted.event_id, world.projectA))?.user_id).toBe(
      world.viewerUser,
    );
    expect((await notifications.get(fallback.event_id, world.projectA))?.user_id).toBe(
      world.memberUser,
    );
  });

  it('skips a notification with no determinable recipient without rolling back the batch', async () => {
    const orphan = notice('failure', { subject: 'CI red' }, { actor: { system: 'device:ci' } });
    const good = notice('failure', { subject: 'build broke', target_user_id: world.memberUser });
    const res = await ingest.ingestBatch([orphan, good]);
    expect(res.rejected).toHaveLength(0);
    expect(res.accepted).toHaveLength(2); // events durable even when a card is skipped
    expect(await notifications.get(orphan.event_id, world.projectA)).toBeUndefined();
    expect(await notifications.get(good.event_id, world.projectA)).toBeTruthy();
  });

  it('redacts secrets in the body before persisting', async () => {
    const secret = `ghp_${'a'.repeat(40)}`;
    const event = notice('failure', { subject: `token=${secret}` });
    await ingest.ingestBatch([event]);
    const card = await notifications.get(event.event_id, world.projectA);
    expect(card?.body).not.toContain(secret);
    expect(card?.body).toContain('[REDACTED:');
  });

  it('skips notifications for an unknown project without rolling back the batch', async () => {
    const unknownProject = makeId('project');
    const unknown = notice(
      'mention',
      { target_user_id: world.memberUser },
      { projectId: unknownProject },
    );
    const known = notice('mention', { target_user_id: world.memberUser });
    const res = await ingest.ingestBatch([unknown, known]);
    expect(res.rejected).toHaveLength(0);
    expect(res.accepted).toHaveLength(2);
    expect(await notifications.get(unknown.event_id, unknownProject)).toBeUndefined();
    expect(await notifications.get(known.event_id, world.projectA)).toBeTruthy();
  });

  it('isolates cards per project and filters the list by user, state and kind', async () => {
    const a = notice(
      'isolation_probe',
      { target_user_id: world.memberUser },
      { projectId: world.projectA },
    );
    const b = notice(
      'isolation_probe',
      { target_user_id: world.memberUser },
      { projectId: world.projectB },
    );
    await ingest.ingestBatch([a, b]);
    expect(await notifications.get(a.event_id, world.projectB)).toBeUndefined();
    expect(
      await notifications.list(world.projectA, {
        userId: world.memberUser,
        kind: 'isolation_probe',
      }),
    ).toHaveLength(1);
    expect(
      await notifications.list(world.projectB, {
        userId: world.memberUser,
        kind: 'isolation_probe',
      }),
    ).toHaveLength(1);
    await notifications.setState(a.event_id, world.projectA, 'done', origin);
    expect(
      await notifications.list(world.projectA, {
        userId: world.memberUser,
        kind: 'isolation_probe',
        state: 'inbox',
      }),
    ).toHaveLength(0);
    expect(
      await notifications.list(world.projectA, {
        userId: world.memberUser,
        kind: 'isolation_probe',
        state: 'done',
      }),
    ).toHaveLength(1);
  });
});

describe('inbox triage', () => {
  it('moves a card inbox → saved → done and is idempotent', async () => {
    const event = notice('question', {
      subject: 'Review please',
      target_user_id: world.memberUser,
    });
    await ingest.ingestBatch([event]);
    const saved = await notifications.setState(event.event_id, world.projectA, 'saved', origin);
    expect(saved.state).toBe('saved');
    const done = await notifications.setState(event.event_id, world.projectA, 'done', origin);
    expect(done.state).toBe('done');
    const again = await notifications.setState(event.event_id, world.projectA, 'done', origin);
    expect(again.state).toBe('done');
    const inbox = await notifications.setState(event.event_id, world.projectA, 'inbox', origin);
    expect(inbox.state).toBe('inbox');
  });

  it('throws not_found for an unknown card', async () => {
    const missing = ulid();
    const err = await notifications
      .setState(missing, world.projectA, 'done', origin)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotificationError);
    expect(err).toMatchObject({ code: 'not_found' });
  });

  it('a user token cannot triage another user’s inbox', async () => {
    const event = notice('approval', { subject: 'Only mine', target_user_id: world.memberUser });
    await ingest.ingestBatch([event]);
    const err = await notifications
      .setState(event.event_id, world.projectA, 'done', origin, world.viewerUser)
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'not_found' });
    expect((await notifications.get(event.event_id, world.projectA))?.state).toBe('inbox');
    const ok = await notifications.setState(
      event.event_id,
      world.projectA,
      'done',
      origin,
      world.memberUser,
    );
    expect(ok.state).toBe('done');
  });
});

describe('team directory (developer attribution)', () => {
  it('resolves display names with email local-part fallback', async () => {
    await db.pool.query('UPDATE users SET display_name = $2 WHERE id = $1', [
      world.memberUser,
      'Priya',
    ]);
    const directory = await auth.listDirectory(world.projectA);
    const priya = directory.find((d) => d.userId === world.memberUser);
    expect(priya?.displayName).toBe('Priya');
    expect(priya?.role).toBe('member');
    const viewer = directory.find((d) => d.userId === world.viewerUser);
    expect(viewer?.displayName).toBe(world.viewerUser); // email local-part == id in the fixture
    expect(directory.map((d) => d.userId)).toContain(world.adminUser);
  });
});
