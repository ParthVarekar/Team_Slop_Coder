import type { Client, Pool } from 'pg';
import { z } from 'zod';
import { metrics, redact, type Logger } from '@weft/core';
import { isSystemActor, type EventEnvelope } from '@weft/protocol';
import { withTransaction, clientExecutor } from './pg.js';
import { recordAudit } from './audit.js';
import type { Origin } from './tasks-service.js';

const projected = metrics.counter(
  'weft_server_notifications_projected_total',
  'Notifications materialized into inboxes',
);
const triaged = metrics.counter(
  'weft_server_notifications_triaged_total',
  'Notification inbox state transitions',
);

export const NotificationStateSchema = z.enum(['inbox', 'saved', 'done']);
export type NotificationState = z.infer<typeof NotificationStateSchema>;

export interface NotificationSnapshot {
  id: string;
  user_id: string;
  project_id: string;
  kind: string;
  title: string;
  body: string | null;
  subject_type: string | null;
  subject_id: string | null;
  state: NotificationState;
  created_at: string;
}

export interface NotificationListOptions {
  userId?: string;
  state?: NotificationState;
  kind?: string;
  limit?: number;
}

export type NotificationErrorCode = 'not_found' | 'validation';

export class NotificationError extends Error {
  constructor(
    readonly code: NotificationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'NotificationError';
  }
}

/** Structural projection hook consumed by IngestService (no import cycle). */
export interface NotificationProjection {
  project(client: Client, event: EventEnvelope): Promise<void>;
}

const KIND_LABEL: Record<string, string> = {
  approval: 'Approval requested',
  question: 'Question',
  failure: 'Failure',
  conflict: 'Conflict',
  mention: 'Mention',
};

function kindLabel(kind: string): string {
  return KIND_LABEL[kind] ?? kind;
}

function str(value: unknown): string {
  return value == null ? '' : String(value);
}

function strOrNull(value: unknown): string | null {
  return value == null || value === '' ? null : String(value);
}

function toIso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

const COLS = `id, user_id, project_id, kind, title, body, subject_type, subject_id, state, created_at`;

function rowToNotification(r: Record<string, unknown>): NotificationSnapshot {
  return {
    id: str(r.id),
    user_id: str(r.user_id),
    project_id: str(r.project_id),
    kind: str(r.kind),
    title: str(r.title),
    body: strOrNull(r.body),
    subject_type: strOrNull(r.subject_type),
    subject_id: strOrNull(r.subject_id),
    state: (str(r.state) || 'inbox') as NotificationState,
    created_at: toIso(r.created_at),
  };
}

/**
 * Server-side inbox materialization. Daemons (or the server itself) emit
 * notification.created targeting a developer; this projection folds it into a
 * per-user inbox card inside the ingest transaction, using the creating event's
 * id as the card id so a replay never duplicates. The detail body is redacted at
 * rest. Unknown projects and notifications with no determinable recipient are
 * skipped (never roll back the batch). Triage moves a card between inbox/saved/
 * done; a user token may only triage its own inbox.
 */
export class NotificationService implements NotificationProjection {
  constructor(
    private readonly pool: Pool,
    private readonly logger?: Logger,
  ) {}

  async project(client: Client, event: EventEnvelope): Promise<void> {
    if (event.type !== 'notification.created') return;
    if (!(await this.projectExists(client, event.project_id))) {
      this.logger?.warn(
        { projectId: event.project_id, eventId: event.event_id },
        'notification for unknown project skipped',
      );
      return;
    }
    const p = event.payload;
    const kind = str(p['kind']);
    if (!kind) return;
    const userId =
      strOrNull(p['target_user_id']) ??
      (isSystemActor(event.actor) ? null : event.actor.user_id);
    if (!userId) {
      this.logger?.warn(
        { projectId: event.project_id, eventId: event.event_id },
        'notification with no recipient skipped',
      );
      return;
    }
    const subject = str(p['subject']);
    const subjectType =
      strOrNull(p['subject_type']) ??
      (event.task_id ? 'task' : event.repo_id ? 'repo' : event.session_id ? 'session' : null);
    const subjectId =
      strOrNull(p['subject_id']) ?? event.task_id ?? event.repo_id ?? event.session_id ?? null;
    await client.query(
      `INSERT INTO notifications
         (id, user_id, project_id, kind, title, body, subject_type, subject_id, state, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'inbox',$9)
       ON CONFLICT (id) DO NOTHING`,
      [
        event.event_id,
        userId,
        event.project_id,
        kind,
        str(p['title']) || kindLabel(kind),
        subject ? redact(subject) : null,
        subjectType,
        subjectId,
        event.ts,
      ],
    );
    projected.inc();
    await recordAudit(clientExecutor(client), {
      projectId: event.project_id,
      actor: event.actor,
      action: 'notification.created',
      subject: `notification:${event.event_id}`,
    });
  }

  private async projectExists(client: Client, projectId: string): Promise<boolean> {
    const res = await client.query('SELECT 1 FROM projects WHERE id = $1', [projectId]);
    return res.rows.length > 0;
  }

  async get(id: string, projectId: string): Promise<NotificationSnapshot | undefined> {
    const res = await this.pool.query(
      `SELECT ${COLS} FROM notifications WHERE id = $1 AND project_id = $2`,
      [id, projectId],
    );
    return res.rows[0] ? rowToNotification(res.rows[0]) : undefined;
  }

  async list(projectId: string, options: NotificationListOptions = {}): Promise<NotificationSnapshot[]> {
    const params: unknown[] = [projectId];
    let where = 'project_id = $1';
    if (options.userId) {
      params.push(options.userId);
      where += ` AND user_id = $${params.length}`;
    }
    if (options.state) {
      params.push(options.state);
      where += ` AND state = $${params.length}`;
    }
    if (options.kind) {
      params.push(options.kind);
      where += ` AND kind = $${params.length}`;
    }
    params.push(options.limit ?? 200);
    const res = await this.pool.query(
      `SELECT ${COLS} FROM notifications WHERE ${where}
        ORDER BY created_at DESC, id DESC LIMIT $${params.length}`,
      params,
    );
    return res.rows.map(rowToNotification);
  }

  /**
   * Move a card to inbox/saved/done. When userId is supplied (a user token), the
   * update is additionally scoped to that user so one developer cannot triage
   * another's inbox. Idempotent: re-setting the current state is a no-op.
   */
  async setState(
    id: string,
    projectId: string,
    state: NotificationState,
    origin: Origin,
    userId?: string,
  ): Promise<NotificationSnapshot> {
    return withTransaction(this.pool, async (client) => {
      const params: unknown[] = [state, id, projectId];
      let where = 'id = $2 AND project_id = $3';
      if (userId) {
        params.push(userId);
        where += ` AND user_id = $${params.length}`;
      }
      const res = await client.query(
        `UPDATE notifications SET state = $1 WHERE ${where} RETURNING ${COLS}`,
        params,
      );
      const row = res.rows[0];
      if (!row) throw new NotificationError('not_found', `notification ${id} not found`);
      const next = rowToNotification(row);
      await recordAudit(clientExecutor(client), {
        projectId,
        actor: origin.actor,
        action: `notification.${state}`,
        subject: `notification:${id}`,
      });
      triaged.inc();
      return next;
    });
  }
}