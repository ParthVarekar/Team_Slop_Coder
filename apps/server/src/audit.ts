import type { PgExecutor } from '@weft/core';
import type { Actor } from '@weft/protocol';

export interface AuditEntry {
  projectId: string;
  actor: Actor;
  action: string;
  subject?: string;
  beforeHash?: string;
  afterHash?: string;
}

/**
 * Append-only audit trail. audit_records has no UPDATE/DELETE path; every
 * auth, RBAC, token and mutation decision is recorded here. Callers pass an
 * executor bound to their transaction so the audit row commits atomically with
 * the change it describes.
 */
export async function recordAudit(exec: PgExecutor, entry: AuditEntry): Promise<void> {
  await exec.query(
    `INSERT INTO audit_records (project_id, actor, action, subject, before_hash, after_hash)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      entry.projectId,
      JSON.stringify(entry.actor),
      entry.action,
      entry.subject ?? null,
      entry.beforeHash ?? null,
      entry.afterHash ?? null,
    ],
  );
}

export interface AuditRecord {
  id: number;
  project_id: string;
  actor: Actor;
  action: string;
  subject: string | null;
  before_hash: string | null;
  after_hash: string | null;
  ts: string;
}

/** Read the recent audit trail for one project (newest first). */
export async function readAudit(
  exec: PgExecutor,
  projectId: string,
  limit = 100,
): Promise<AuditRecord[]> {
  const { rows } = await exec.query(
    `SELECT id, project_id, actor, action, subject, before_hash, after_hash, ts
       FROM audit_records
      WHERE project_id = $1
      ORDER BY id DESC
      LIMIT $2`,
    [projectId, limit],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    project_id: String(r.project_id),
    actor: (typeof r.actor === 'string' ? JSON.parse(r.actor) : r.actor) as Actor,
    action: String(r.action),
    subject: r.subject === null ? null : String(r.subject),
    before_hash: r.before_hash === null ? null : String(r.before_hash),
    after_hash: r.after_hash === null ? null : String(r.after_hash),
    ts: r.ts instanceof Date ? r.ts.toISOString() : String(r.ts),
  }));
}
