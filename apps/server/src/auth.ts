import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Pool } from 'pg';
import { metrics, type Logger } from '@weft/core';
import { ulid, makeId, type Actor } from '@weft/protocol';
import { poolExecutor } from './pg.js';
import { recordAudit } from './audit.js';

// ---------------------------------------------------------------------------
// Role / scope model
// ---------------------------------------------------------------------------
export const SCOPES = ['read', 'ingest', 'mutate', 'admin'] as const;
export type Scope = (typeof SCOPES)[number];

export const ROLES = ['viewer', 'member', 'admin'] as const;
export type Role = (typeof ROLES)[number];

const ROLE_RANK: Record<Role, number> = { viewer: 0, member: 1, admin: 2 };
export const ROLE_SCOPES: Record<Role, readonly Scope[]> = {
  viewer: ['read'],
  member: ['read', 'ingest', 'mutate'],
  admin: ['read', 'ingest', 'mutate', 'admin'],
};

const authDenied = metrics.counter('weft_server_auth_denied_total', 'Authentication/authorization denials');
const tokensIssued = metrics.counter('weft_server_tokens_issued_total', 'API tokens issued');
const tokensRevoked = metrics.counter('weft_server_tokens_revoked_total', 'API tokens revoked');

// ---------------------------------------------------------------------------
// Token crypto — only the sha256 hash is ever persisted.
// ---------------------------------------------------------------------------
export function generateToken(): string {
  return `weft_${randomBytes(32).toString('base64url')}`;
}

export function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function parseScope(raw: unknown): Scope[] {
  const arr = Array.isArray(raw) ? raw : typeof raw === 'string' ? (JSON.parse(raw) as unknown[]) : [];
  return arr.filter((s): s is Scope => typeof s === 'string' && (SCOPES as readonly string[]).includes(s));
}

function capScope(stored: Scope[], role: Role): Scope[] {
  const allowed = ROLE_SCOPES[role];
  return stored.filter((s) => allowed.includes(s));
}

// ---------------------------------------------------------------------------
// Auth context
// ---------------------------------------------------------------------------
export interface AuthContext {
  kind: 'bootstrap' | 'token';
  tokenId: string | null;
  /** null only for the bootstrap admin secret (global superuser). */
  projectId: string | null;
  userId: string | null;
  deviceId: string | null;
  role: Role | null;
  scope: ReadonlySet<Scope>;
}

export function hasScope(ctx: AuthContext, scope: Scope): boolean {
  return ctx.scope.has(scope);
}

export function actorOf(ctx: AuthContext): Actor {
  if (ctx.kind === 'bootstrap') return { system: 'weft-admin' };
  if (ctx.userId) return { user_id: ctx.userId, agent: null };
  if (ctx.deviceId) return { system: `device:${ctx.deviceId}` };
  return { system: 'weft-server' };
}

export type AuthResult =
  | { ok: true; context: AuthContext }
  | { ok: false; status: 401; reason: string; projectId?: string; tokenId?: string };

/** Expected, client-facing authorization failure mapped to an HTTP status. */
export class AuthError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
    message?: string,
  ) {
    super(message ?? reason);
    this.name = 'AuthError';
  }
}

// ---------------------------------------------------------------------------
// Admin store shapes
// ---------------------------------------------------------------------------
export interface IssueTokenInput {
  projectId: string;
  userId?: string | undefined;
  deviceId?: string | undefined;
  role: Role;
  name?: string | undefined;
  expiresInDays?: number | undefined;
  actor: Actor;
}

export interface IssuedToken {
  id: string;
  /** Raw secret — returned exactly once, never persisted. */
  token: string;
  projectId: string;
  userId: string | null;
  deviceId: string | null;
  role: Role;
  scope: Scope[];
  name: string | null;
  expiresAt: string | null;
}

export interface TokenInfo {
  id: string;
  projectId: string;
  userId: string | null;
  deviceId: string | null;
  scope: Scope[];
  name: string | null;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
}

export interface MemberInfo {
  userId: string;
  role: Role;
}

export interface DirectoryEntry {
  userId: string;
  displayName: string;
  role: Role;
}

export interface RegisterDeviceInput {
  projectId: string;
  deviceId?: string | undefined;
  userId?: string | undefined;
  hostname?: string | undefined;
  os?: string | undefined;
  actor: Actor;
}

export interface DeviceInfo {
  id: string;
  userId: string | null;
  hostname: string | null;
  os: string | null;
}

function iso(value: unknown): string | null {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function str(value: unknown): string | null {
  return value == null ? null : String(value);
}

/**
 * Project-scoped authentication and RBAC. The bootstrap admin secret is a
 * global superuser used only for management; every other credential is a
 * hashed, expiring, revocable API token bound to one project. Membership is
 * re-checked on each authentication so removing a member (or downgrading their
 * role) takes effect immediately, and a token's effective scope is the
 * intersection of its grant with the principal's current project role.
 */
export class AuthService {
  constructor(
    private readonly pool: Pool,
    private readonly adminSecret?: string,
    private readonly logger?: Logger,
  ) {}

  async authenticate(bearer: string): Promise<AuthResult> {
    if (!bearer) return { ok: false, status: 401, reason: 'no_token' };
    if (this.adminSecret && safeEqual(bearer, this.adminSecret)) {
      return {
        ok: true,
        context: {
          kind: 'bootstrap',
          tokenId: null,
          projectId: null,
          userId: null,
          deviceId: null,
          role: 'admin',
          scope: new Set<Scope>(SCOPES),
        },
      };
    }

    const { rows } = await this.pool.query(
      `SELECT t.id, t.project_id, t.user_id, t.device_id, t.scope, t.expires_at, t.revoked_at,
              d.user_id AS device_user_id, pm.role AS member_role
         FROM api_tokens t
         LEFT JOIN devices d ON d.id = t.device_id
         LEFT JOIN project_members pm
           ON pm.project_id = t.project_id AND pm.user_id = COALESCE(t.user_id, d.user_id)
        WHERE t.hash = $1`,
      [hashToken(bearer)],
    );
    const row = rows[0];
    if (!row) return { ok: false, status: 401, reason: 'unknown_token' };

    const projectId = String(row.project_id);
    const tokenId = String(row.id);
    if (row.revoked_at != null)
      return { ok: false, status: 401, reason: 'revoked', projectId, tokenId };
    if (row.expires_at != null && (row.expires_at as Date).getTime() <= Date.now())
      return { ok: false, status: 401, reason: 'expired', projectId, tokenId };

    const userId = str(row.user_id);
    const deviceId = str(row.device_id);
    const principalUserId = userId ?? str(row.device_user_id);
    const memberRole = row.member_role != null ? (String(row.member_role) as Role) : null;
    // A token whose principal is a known user requires live project membership.
    // Ownerless devices (e.g. shared CI) are exempt and keep their stored scope.
    if (principalUserId && !memberRole)
      return { ok: false, status: 401, reason: 'membership_revoked', projectId, tokenId };

    const stored = parseScope(row.scope);
    const scope = memberRole ? capScope(stored, memberRole) : stored;
    return {
      ok: true,
      context: {
        kind: 'token',
        tokenId,
        projectId,
        userId,
        deviceId,
        role: memberRole,
        scope: new Set(scope),
      },
    };
  }

  /** Append an auth.denied audit row (only when a project context is known). */
  async recordDenial(projectId: string, reason: string, actor: Actor, tokenId?: string): Promise<void> {
    authDenied.inc();
    await recordAudit(poolExecutor(this.pool), {
      projectId,
      actor,
      action: 'auth.denied',
      subject: tokenId ? `${reason}:${tokenId}` : reason,
    });
    this.logger?.warn({ projectId, reason, tokenId }, 'auth denied');
  }

  private async requireProject(projectId: string): Promise<void> {
    const { rows } = await this.pool.query('SELECT 1 FROM projects WHERE id = $1', [projectId]);
    if (rows.length === 0) throw new AuthError(404, 'project_not_found');
  }

  private async memberRole(projectId: string, userId: string): Promise<Role | null> {
    const { rows } = await this.pool.query(
      'SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2',
      [projectId, userId],
    );
    return rows[0] ? (String(rows[0].role) as Role) : null;
  }

  private assertNoEscalation(requested: Role, current: Role | null): void {
    if (current && ROLE_RANK[requested] > ROLE_RANK[current])
      throw new AuthError(403, 'escalation', `cannot grant ${requested} to a ${current}`);
  }

  async issueToken(input: IssueTokenInput): Promise<IssuedToken> {
    await this.requireProject(input.projectId);
    if (!input.userId && !input.deviceId)
      throw new AuthError(400, 'principal_required', 'userId or deviceId is required');

    let userId: string | null = input.userId ?? null;
    const deviceId: string | null = input.deviceId ?? null;

    if (input.userId) {
      const role = await this.memberRole(input.projectId, input.userId);
      if (!role) throw new AuthError(400, 'not_a_member', 'user is not a project member');
      this.assertNoEscalation(input.role, role);
    }
    if (deviceId) {
      const { rows } = await this.pool.query('SELECT user_id FROM devices WHERE id = $1', [deviceId]);
      if (rows.length === 0) throw new AuthError(404, 'device_not_found');
      const owner = str(rows[0].user_id);
      if (owner) {
        const role = await this.memberRole(input.projectId, owner);
        if (!role) throw new AuthError(400, 'not_a_member', 'device owner is not a project member');
        this.assertNoEscalation(input.role, role);
        userId = userId ?? owner;
      }
    }

    const id = `tok_${ulid()}`;
    const raw = generateToken();
    const scope = [...ROLE_SCOPES[input.role]];
    const expiresAt =
      input.expiresInDays != null
        ? new Date(Date.now() + input.expiresInDays * 86_400_000)
        : null;
    await this.pool.query(
      `INSERT INTO api_tokens (id, user_id, device_id, project_id, scope, hash, expires_at, name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, userId, deviceId, input.projectId, JSON.stringify(scope), hashToken(raw), expiresAt, input.name ?? null],
    );
    await recordAudit(poolExecutor(this.pool), {
      projectId: input.projectId,
      actor: input.actor,
      action: 'token.created',
      subject: `token:${id}`,
      afterHash: sha256(`${input.role}:${scope.join(',')}`),
    });
    tokensIssued.inc();
    return {
      id,
      token: raw,
      projectId: input.projectId,
      userId,
      deviceId,
      role: input.role,
      scope,
      name: input.name ?? null,
      expiresAt: expiresAt ? expiresAt.toISOString() : null,
    };
  }

  async revokeToken(
    projectId: string | null,
    tokenId: string,
    actor: Actor,
  ): Promise<{ alreadyRevoked: boolean }> {
    const { rows } = await this.pool.query(
      'SELECT project_id, revoked_at FROM api_tokens WHERE id = $1',
      [tokenId],
    );
    const row = rows[0];
    if (!row) throw new AuthError(404, 'token_not_found');
    const ownerProject = String(row.project_id);
    if (projectId != null && ownerProject !== projectId)
      throw new AuthError(403, 'cross_project');
    if (row.revoked_at != null) return { alreadyRevoked: true };
    await this.pool.query('UPDATE api_tokens SET revoked_at = now() WHERE id = $1', [tokenId]);
    await recordAudit(poolExecutor(this.pool), {
      projectId: ownerProject,
      actor,
      action: 'token.revoked',
      subject: `token:${tokenId}`,
    });
    tokensRevoked.inc();
    return { alreadyRevoked: false };
  }

  async listTokens(projectId: string): Promise<TokenInfo[]> {
    const { rows } = await this.pool.query(
      `SELECT id, project_id, user_id, device_id, scope, name, created_at, expires_at, revoked_at
         FROM api_tokens WHERE project_id = $1 ORDER BY created_at DESC, id DESC`,
      [projectId],
    );
    return rows.map((r) => ({
      id: String(r.id),
      projectId: String(r.project_id),
      userId: str(r.user_id),
      deviceId: str(r.device_id),
      scope: parseScope(r.scope),
      name: str(r.name),
      createdAt: iso(r.created_at) ?? '',
      expiresAt: iso(r.expires_at),
      revokedAt: iso(r.revoked_at),
    }));
  }

  async upsertMember(
    projectId: string,
    userId: string,
    role: Role,
    actor: Actor,
  ): Promise<{ before: Role | null; after: Role }> {
    await this.requireProject(projectId);
    const users = await this.pool.query('SELECT 1 FROM users WHERE id = $1', [userId]);
    if (users.rows.length === 0) throw new AuthError(404, 'user_not_found');
    const before = await this.memberRole(projectId, userId);
    await this.pool.query(
      `INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, $3)
       ON CONFLICT (project_id, user_id) DO UPDATE SET role = excluded.role`,
      [projectId, userId, role],
    );
    await recordAudit(poolExecutor(this.pool), {
      projectId,
      actor,
      action: before ? 'member.role_changed' : 'member.added',
      subject: `member:${userId}`,
      ...(before ? { beforeHash: sha256(before) } : {}),
      afterHash: sha256(role),
    });
    return { before, after: role };
  }

  async listMembers(projectId: string): Promise<MemberInfo[]> {
    const { rows } = await this.pool.query(
      'SELECT user_id, role FROM project_members WHERE project_id = $1 ORDER BY user_id',
      [projectId],
    );
    return rows.map((r) => ({ userId: String(r.user_id), role: String(r.role) as Role }));
  }

  /**
   * Read-scoped team directory for developer attribution in the team UI. Unlike
   * listMembers (admin), any project member may resolve a user_id to a display
   * name so sessions can be labelled "Claude Code for Priya". Falls back to the
   * email local-part, then the raw id, when no display name is set.
   */
  async listDirectory(projectId: string): Promise<DirectoryEntry[]> {
    const { rows } = await this.pool.query(
      `SELECT pm.user_id, pm.role, u.display_name, u.email
         FROM project_members pm JOIN users u ON u.id = pm.user_id
        WHERE pm.project_id = $1 ORDER BY pm.user_id`,
      [projectId],
    );
    return rows.map((r) => {
      const userId = String(r.user_id);
      const email = str(r.email) ?? '';
      const displayName = str(r.display_name) || email.split('@')[0] || userId;
      return { userId, displayName, role: String(r.role) as Role };
    });
  }

  async registerDevice(input: RegisterDeviceInput): Promise<DeviceInfo> {
    await this.requireProject(input.projectId);
    const id = input.deviceId ?? makeId('device');
    if (input.userId) {
      const users = await this.pool.query('SELECT 1 FROM users WHERE id = $1', [input.userId]);
      if (users.rows.length === 0) throw new AuthError(404, 'user_not_found');
    }
    await this.pool.query(
      `INSERT INTO devices (id, user_id, hostname, os, last_seen)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (id) DO UPDATE SET
         user_id = COALESCE(excluded.user_id, devices.user_id),
         hostname = COALESCE(excluded.hostname, devices.hostname),
         os = COALESCE(excluded.os, devices.os),
         last_seen = now()`,
      [id, input.userId ?? null, input.hostname ?? null, input.os ?? null],
    );
    await recordAudit(poolExecutor(this.pool), {
      projectId: input.projectId,
      actor: input.actor,
      action: 'device.registered',
      subject: `device:${id}`,
    });
    return {
      id,
      userId: input.userId ?? null,
      hostname: input.hostname ?? null,
      os: input.os ?? null,
    };
  }
}