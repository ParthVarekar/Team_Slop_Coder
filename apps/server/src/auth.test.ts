import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool } from 'pg';
import type { FastifyInstance } from 'fastify';
import { ulid, PROTOCOL_VERSION } from '@weft/protocol';
import { createServer, type TeamServer } from './server.js';
import { hashToken, type Role } from './auth.js';
import type { ServerConfig } from './config.js';
import { startEmbeddedPostgres, freePort, type EmbeddedCluster } from '../test/embedded.js';
import { seedWorld, type World } from '../test/identity.js';

let cluster: EmbeddedCluster;
let server: TeamServer;
let app: FastifyInstance;
let pool: Pool;
let world: World;
let dataDir: string;
const adminSecret = 'test-admin-secret';

beforeAll(async () => {
  cluster = await startEmbeddedPostgres();
  dataDir = mkdtempSync(join(tmpdir(), 'weft-auth-'));
  const config: ServerConfig = {
    dataDir,
    host: '127.0.0.1',
    port: await freePort(),
    databaseUrl: cluster.databaseUrl,
    logLevel: 'fatal',
    corsOrigin: '*',
  };
  server = await createServer(config, { adminSecret });
  app = server.app;
  pool = server.db.pool;
  world = await seedWorld(pool);
}, 90_000);

afterAll(async () => {
  await server?.close();
  await cluster?.stop();
  if (dataDir) {
    try {
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 5 });
    } catch {
      /* best-effort */
    }
  }
});

type Method = 'GET' | 'POST';
function call(method: Method, url: string, token?: string, payload?: unknown) {
  return app.inject({
    method,
    url,
    ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });
}

function event(projectId: string, deviceId: string, type = 'tool.post') {
  return {
    v: PROTOCOL_VERSION,
    event_id: ulid(),
    device_id: deviceId,
    project_id: projectId,
    ts: new Date().toISOString(),
    type,
    actor: { user_id: 'user_test', agent: null },
    privacy: 'metadata',
    payload: { tool_name: 'Bash', success: true },
  };
}

interface Issued {
  id: string;
  token: string;
  projectId: string;
  role: Role;
  scope: string[];
  userId: string | null;
  deviceId: string | null;
}

async function issue(
  projectId: string,
  role: Role,
  principal: { userId?: string; deviceId?: string } = {},
  bearer = adminSecret,
): Promise<Issued> {
  const res = await call('POST', '/v1/admin/tokens', bearer, { projectId, role, ...principal });
  expect(res.statusCode).toBe(201);
  return res.json() as Issued;
}

async function setMemberRole(projectId: string, userId: string, role: Role): Promise<void> {
  await pool.query('UPDATE project_members SET role = $3 WHERE project_id = $1 AND user_id = $2', [
    projectId, userId, role,
  ]);
}

describe('server auth/RBAC penetration (real Postgres 16)', () => {
  it('stores only the token hash, never the raw secret', async () => {
    const tok = await issue(world.projectA, 'member', { userId: world.memberUser });
    const row = await pool.query('SELECT hash FROM api_tokens WHERE id = $1', [tok.id]);
    expect(row.rows[0].hash).toBe(hashToken(tok.token));
    expect(row.rows[0].hash).not.toBe(tok.token);
    const all = await pool.query('SELECT hash FROM api_tokens');
    expect(all.rows.every((r) => r.hash !== tok.token)).toBe(true);
  });

  it('member token can ingest and read its own project', async () => {
    const tok = await issue(world.projectA, 'member', { userId: world.memberUser });
    const ing = await call('POST', '/v1/ingest', tok.token, {
      events: [event(world.projectA, world.deviceId)],
    });
    expect(ing.statusCode).toBe(202);
    const read = await call('GET', `/v1/events?projectId=${world.projectA}`, tok.token);
    expect(read.statusCode).toBe(200);
    expect(read.json().events.length).toBeGreaterThan(0);
    // projectId is implied by the token when omitted
    const implied = await call('GET', '/v1/events', tok.token);
    expect(implied.statusCode).toBe(200);
    expect(implied.json().events.every((e: { project_id: string }) => e.project_id === world.projectA)).toBe(true);
  });

  it('viewer token can read but not ingest (scope enforcement)', async () => {
    const tok = await issue(world.projectA, 'viewer', { userId: world.viewerUser });
    expect((await call('GET', '/v1/events', tok.token)).statusCode).toBe(200);
    const ing = await call('POST', '/v1/ingest', tok.token, {
      events: [event(world.projectA, world.deviceId)],
    });
    expect(ing.statusCode).toBe(403);
    expect(ing.json().reason).toBe('scope');
  });

  it('denies cross-project ingest, read, and admin for a project-bound token', async () => {
    const tok = await issue(world.projectA, 'admin', { userId: world.adminUser });
    const ing = await call('POST', '/v1/ingest', tok.token, {
      events: [event(world.projectB, world.deviceId)],
    });
    expect(ing.statusCode).toBe(403);
    expect(ing.json().reason).toBe('cross_project');
    const read = await call('GET', `/v1/events?projectId=${world.projectB}`, tok.token);
    expect(read.statusCode).toBe(403);
    expect(read.json().reason).toBe('cross_project');
    // adminUser is also admin of B, but this token is bound to A
    const admin = await call('GET', `/v1/admin/tokens?projectId=${world.projectB}`, tok.token);
    expect(admin.statusCode).toBe(403);
    expect(admin.json().reason).toBe('cross_project');
  });

  it('member token cannot reach management routes (scope)', async () => {
    const tok = await issue(world.projectA, 'member', { userId: world.memberUser });
    const res = await call('POST', '/v1/admin/tokens', tok.token, {
      projectId: world.projectA, role: 'viewer', userId: world.viewerUser,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().reason).toBe('scope');
    expect((await call('GET', `/v1/admin/audit?projectId=${world.projectA}`, tok.token)).statusCode).toBe(403);
  });

  it('rejects unknown and absent credentials with 401', async () => {
    expect((await call('GET', '/v1/events', 'bogus-token')).statusCode).toBe(401);
    const none = await call('GET', '/v1/events');
    expect(none.statusCode).toBe(401);
    expect(none.json().reason).toBe('no_token');
  });

  it('denies a revoked token', async () => {
    const tok = await issue(world.projectA, 'member', { userId: world.memberUser });
    const rev = await call('POST', `/v1/admin/tokens/${tok.id}/revoke?projectId=${world.projectA}`, adminSecret);
    expect(rev.statusCode).toBe(200);
    const res = await call('GET', '/v1/events', tok.token);
    expect(res.statusCode).toBe(401);
    expect(res.json().reason).toBe('revoked');
    // revocation is idempotent
    const again = await call('POST', `/v1/admin/tokens/${tok.id}/revoke?projectId=${world.projectA}`, adminSecret);
    expect(again.statusCode).toBe(200);
    expect(again.json().alreadyRevoked).toBe(true);
  });

  it('denies an expired token', async () => {
    const tok = await issue(world.projectA, 'member', { userId: world.memberUser });
    await pool.query("UPDATE api_tokens SET expires_at = now() - interval '1 hour' WHERE id = $1", [tok.id]);
    const res = await call('GET', '/v1/events', tok.token);
    expect(res.statusCode).toBe(401);
    expect(res.json().reason).toBe('expired');
  });

  it('denies a token whose principal lost project membership', async () => {
    const tok = await issue(world.projectA, 'member', { userId: world.memberUser });
    await pool.query('DELETE FROM project_members WHERE project_id = $1 AND user_id = $2', [
      world.projectA, world.memberUser,
    ]);
    try {
      const res = await call('GET', '/v1/events', tok.token);
      expect(res.statusCode).toBe(401);
      expect(res.json().reason).toBe('membership_revoked');
    } finally {
      await pool.query('INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, $3)', [
        world.projectA, world.memberUser, 'member',
      ]);
    }
  });

  it('caps effective scope when the principal role is downgraded', async () => {
    const tok = await issue(world.projectA, 'admin', { userId: world.adminUser });
    await setMemberRole(world.projectA, world.adminUser, 'viewer');
    try {
      const ing = await call('POST', '/v1/ingest', tok.token, {
        events: [event(world.projectA, world.deviceId)],
      });
      expect(ing.statusCode).toBe(403);
      expect((await call('GET', '/v1/events', tok.token)).statusCode).toBe(200);
    } finally {
      await setMemberRole(world.projectA, world.adminUser, 'admin');
    }
  });

  it('refuses to escalate a token beyond the principal role', async () => {
    const res = await call('POST', '/v1/admin/tokens', adminSecret, {
      projectId: world.projectA, role: 'admin', userId: world.viewerUser,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('escalation');
  });

  it('issues a working device token bound to the owner membership', async () => {
    const tok = await issue(world.projectA, 'member', { deviceId: world.deviceId });
    expect(tok.deviceId).toBe(world.deviceId);
    expect(tok.userId).toBe(world.memberUser);
    const ing = await call('POST', '/v1/ingest', tok.token, {
      events: [event(world.projectA, world.deviceId)],
    });
    expect(ing.statusCode).toBe(202);
  });

  it('denies a device token when the owner loses membership', async () => {
    const tok = await issue(world.projectA, 'member', { deviceId: world.deviceId });
    await pool.query('DELETE FROM project_members WHERE project_id = $1 AND user_id = $2', [
      world.projectA, world.memberUser,
    ]);
    try {
      const res = await call('GET', '/v1/events', tok.token);
      expect(res.statusCode).toBe(401);
      expect(res.json().reason).toBe('membership_revoked');
    } finally {
      await pool.query('INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, $3)', [
        world.projectA, world.memberUser, 'member',
      ]);
    }
  });

  it('records an append-only audit trail for token and auth events', async () => {
    const tok = await issue(world.projectA, 'member', { userId: world.memberUser });
    await call('POST', `/v1/admin/tokens/${tok.id}/revoke?projectId=${world.projectA}`, adminSecret);
    await call('GET', '/v1/events', tok.token); // revoked -> auth.denied
    const audit = await call('GET', `/v1/admin/audit?projectId=${world.projectA}`, adminSecret);
    expect(audit.statusCode).toBe(200);
    const actions = (audit.json().records as { action: string }[]).map((r) => r.action);
    expect(actions).toContain('token.created');
    expect(actions).toContain('token.revoked');
    expect(actions).toContain('auth.denied');
  });

  it('lists token metadata without exposing hash or raw secret', async () => {
    await issue(world.projectA, 'member', { userId: world.memberUser });
    const res = await call('GET', `/v1/admin/tokens?projectId=${world.projectA}`, adminSecret);
    expect(res.statusCode).toBe(200);
    const tokens = res.json().tokens as Record<string, unknown>[];
    expect(tokens.length).toBeGreaterThan(0);
    for (const t of tokens) {
      expect(t).not.toHaveProperty('hash');
      expect(t).not.toHaveProperty('token');
    }
  });

  it('bootstrap superuser ingests any project; project tokens cannot shutdown', async () => {
    const ing = await call('POST', '/v1/ingest', adminSecret, {
      events: [event(world.projectB, world.deviceId)],
    });
    expect(ing.statusCode).toBe(202);
    const tok = await issue(world.projectA, 'admin', { userId: world.adminUser });
    expect((await call('POST', '/v1/shutdown', tok.token)).statusCode).toBe(403);
  });

  it('manages project members and registers devices via admin routes', async () => {
    const add = await call('POST', '/v1/admin/members', adminSecret, {
      projectId: world.projectB, userId: world.memberUser, role: 'member',
    });
    expect(add.statusCode).toBe(200);
    expect(add.json().after).toBe('member');
    const list = await call('GET', `/v1/admin/members?projectId=${world.projectB}`, adminSecret);
    expect(
      (list.json().members as { userId: string; role: string }[]).some(
        (m) => m.userId === world.memberUser && m.role === 'member',
      ),
    ).toBe(true);
    const dev = await call('POST', '/v1/admin/devices', adminSecret, {
      projectId: world.projectA, userId: world.memberUser, hostname: 'h2', os: 'win32',
    });
    expect(dev.statusCode).toBe(201);
    expect(dev.json().id).toMatch(/^dev_/);
  });

  it('rejects token issuance for a non-member principal', async () => {
    const res = await call('POST', '/v1/admin/tokens', adminSecret, {
      projectId: world.projectB, role: 'member', userId: world.viewerUser,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('not_a_member');
  });

  it('requires a principal when issuing a token', async () => {
    const res = await call('POST', '/v1/admin/tokens', adminSecret, {
      projectId: world.projectA, role: 'member',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('principal_required');
  });
});