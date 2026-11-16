import { createHash } from 'node:crypto';
import type { Client, Pool } from 'pg';
import { z } from 'zod';
import { metrics, type Logger } from '@weft/core';
import {
  makeId,
  isSystemActor,
  canonicalConflictKey,
  normalizeConflictPath,
  ConflictKindSchema,
  ConflictSeveritySchema,
  type Actor,
  type EventEnvelope,
  type ConflictKind,
  type ConflictSeverity,
  type ConflictState,
} from '@weft/protocol';
import { withTransaction, clientExecutor } from './pg.js';
import { appendCoordinationEvent } from './emit.js';
import { recordAudit } from './audit.js';
import type { Origin } from './tasks-service.js';

const created = metrics.counter('weft_server_conflicts_created_total', 'Conflict cards minted');
const reopened = metrics.counter('weft_server_conflicts_reopened_total', 'Conflict cards reopened');
const resolved = metrics.counter('weft_server_conflicts_resolved_total', 'Conflicts resolved');
const dismissed = metrics.counter('weft_server_conflicts_dismissed_total', 'Conflicts dismissed');
const evidenceAdded = metrics.counter('weft_server_conflicts_evidence_total', 'Evidence records unioned');

const SEVERITY_RANK: Record<ConflictSeverity, number> = { info: 0, warning: 1, blocking: 2 };

function maxSeverity(a: ConflictSeverity, b: ConflictSeverity): ConflictSeverity {
  return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;
}

/** Key-order-independent JSON so evidence from two devices dedups by content. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

function evidenceDigest(record: Record<string, unknown>): string {
  return createHash('sha256').update(canonicalJson(record)).digest('hex').slice(0, 16);
}

/** Append-only union: existing evidence is never dropped or reordered. */
function unionEvidence(
  existing: Record<string, unknown>[],
  incoming: Record<string, unknown>[],
): { merged: Record<string, unknown>[]; added: Record<string, unknown>[] } {
  const seen = new Set(existing.map(evidenceDigest));
  const merged = [...existing];
  const added: Record<string, unknown>[] = [];
  for (const record of incoming) {
    const digest = evidenceDigest(record);
    if (seen.has(digest)) continue;
    seen.add(digest);
    merged.push(record);
    added.push(record);
  }
  return { merged, added };
}

function strArr(value: unknown): string[] {
  return Array.isArray(value) ? value.map((v) => String(v)) : [];
}

function objArr(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
}

function toIso(value: unknown): string | null {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

export interface ConflictSnapshot {
  id: string;
  project_id: string;
  canonical_key: string;
  repo_id: string;
  kind: ConflictKind;
  task_ids: string[];
  branch_a: string | null;
  branch_b: string | null;
  paths: string[];
  symbol_ids: string[];
  evidence: Record<string, unknown>[];
  detection_epoch: number;
  severity: ConflictSeverity;
  state: ConflictState;
  resolved_by: string | null;
  reopen_count: number;
  created_at: string;
  last_detected_at: string | null;
  resolved_at: string | null;
}

export interface ConflictEventRecord {
  id: number;
  conflict_id: string;
  type: string;
  actor: Actor;
  payload: Record<string, unknown>;
  detection_epoch: number;
  ts: string;
}

const CARD_COLS = `id, project_id, canonical_key, repo_id, kind, task_ids, branch_a, branch_b,
  paths, symbol_ids, evidence, detection_epoch, severity, state, resolved_by, reopen_count,
  created_at, last_detected_at, resolved_at`;

function rowToCard(r: Record<string, unknown>): ConflictSnapshot {
  return {
    id: String(r.id),
    project_id: String(r.project_id),
    canonical_key: String(r.canonical_key),
    repo_id: String(r.repo_id),
    kind: String(r.kind) as ConflictKind,
    task_ids: strArr(r.task_ids),
    branch_a: r.branch_a == null ? null : String(r.branch_a),
    branch_b: r.branch_b == null ? null : String(r.branch_b),
    paths: strArr(r.paths),
    symbol_ids: strArr(r.symbol_ids),
    evidence: objArr(r.evidence),
    detection_epoch: Number(r.detection_epoch),
    severity: String(r.severity) as ConflictSeverity,
    state: String(r.state) as ConflictState,
    resolved_by: r.resolved_by == null ? null : String(r.resolved_by),
    reopen_count: Number(r.reopen_count),
    created_at: String(toIso(r.created_at)),
    last_detected_at: toIso(r.last_detected_at),
    resolved_at: toIso(r.resolved_at),
  };
}

function rowToHistory(r: Record<string, unknown>): ConflictEventRecord {
  return {
    id: Number(r.id),
    conflict_id: String(r.conflict_id),
    type: String(r.type),
    actor: r.actor as Actor,
    payload: (r.payload as Record<string, unknown>) ?? {},
    detection_epoch: Number(r.detection_epoch),
    ts: String(toIso(r.ts)),
  };
}

function cardDigest(card: ConflictSnapshot): string {
  return createHash('sha256').update(JSON.stringify(card)).digest('hex').slice(0, 16);
}

async function insertCard(client: Client, c: ConflictSnapshot): Promise<void> {
  await client.query(
    `INSERT INTO conflicts
       (id, project_id, canonical_key, repo_id, kind, task_ids, branch_a, branch_b,
        paths, symbol_ids, evidence, detection_epoch, severity, state, resolved_by,
        reopen_count, created_at, last_detected_at, resolved_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
    [
      c.id, c.project_id, c.canonical_key, c.repo_id, c.kind, JSON.stringify(c.task_ids),
      c.branch_a, c.branch_b, JSON.stringify(c.paths), JSON.stringify(c.symbol_ids),
      JSON.stringify(c.evidence), c.detection_epoch, c.severity, c.state, c.resolved_by,
      c.reopen_count, c.created_at, c.last_detected_at, c.resolved_at,
    ],
  );
}

async function updateCard(client: Client, c: ConflictSnapshot): Promise<void> {
  await client.query(
    `UPDATE conflicts SET branch_a=$2, branch_b=$3, evidence=$4, detection_epoch=$5,
        severity=$6, state=$7, resolved_by=$8, reopen_count=$9, last_detected_at=$10,
        resolved_at=$11
      WHERE id=$1`,
    [
      c.id, c.branch_a, c.branch_b, JSON.stringify(c.evidence), c.detection_epoch,
      c.severity, c.state, c.resolved_by, c.reopen_count, c.last_detected_at, c.resolved_at,
    ],
  );
}

async function appendHistory(
  client: Client,
  conflictId: string,
  type: string,
  actor: Actor,
  payload: Record<string, unknown>,
  epoch: number,
): Promise<void> {
  await client.query(
    `INSERT INTO conflict_events (conflict_id, type, actor, payload, detection_epoch)
     VALUES ($1,$2,$3,$4,$5)`,
    [conflictId, type, JSON.stringify(actor), JSON.stringify(payload), epoch],
  );
}

export type ConflictErrorCode = 'not_found' | 'validation' | 'invalid_transition';

export class ConflictError extends Error {
  constructor(
    readonly code: ConflictErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ConflictError';
  }
}

export const DetectConflictSchema = z.object({
  repo_id: z.string().min(1),
  kind: ConflictKindSchema,
  severity: ConflictSeveritySchema.default('warning'),
  detection_epoch: z.number().int().nonnegative().default(0),
  task_ids: z.array(z.string().min(1)).min(1).max(64),
  paths: z.array(z.string().min(1)).max(5000).default([]),
  symbol_ids: z.array(z.string().min(1)).max(5000).default([]),
  branch_a: z.string().min(1).optional(),
  branch_b: z.string().min(1).optional(),
  evidence: z.array(z.record(z.unknown())).max(500).default([]),
  /** Advisory only — the server recomputes identity from kind+tasks+paths. */
  canonical_key: z.string().min(1).optional(),
});
export type DetectConflictInput = z.input<typeof DetectConflictSchema>;
type ParsedDetection = z.output<typeof DetectConflictSchema>;

export interface ConflictListOptions {
  state?: ConflictState;
  severity?: ConflictSeverity;
  kind?: ConflictKind;
  repoId?: string;
  limit?: number;
}

/** Structural projection hook consumed by IngestService (no import cycle). */
export interface ConflictProjection {
  projectDetection(client: Client, event: EventEnvelope): Promise<void>;
}

/**
 * Server-authoritative conflict cards. Daemons submit raw detections (via ingest
 * or the detect RPC); the server recomputes the canonical key, mints one card per
 * (project, key), and unions evidence append-only. Re-detection in the same epoch
 * never flaps state or re-emits; a strictly later epoch re-opening a resolved or
 * dismissed card records linked history and re-emits once. Every mutation writes
 * the conflict_events trail, an audit record, and (on create/reopen/resolve/
 * dismiss) a coordination fan-out event in the same transaction.
 */
export class ConflictService implements ConflictProjection {
  constructor(
    private readonly pool: Pool,
    private readonly serverDeviceId: string,
    private readonly logger?: Logger,
  ) {}

  async detect(projectId: string, input: DetectConflictInput, origin: Origin): Promise<ConflictSnapshot> {
    const parsed = DetectConflictSchema.safeParse(input);
    if (!parsed.success)
      throw new ConflictError('validation', parsed.error.issues.map((i) => i.message).join('; '));
    return withTransaction(this.pool, (client) =>
      this.applyDetection(client, projectId, parsed.data, origin),
    );
  }

  /** Ingest projection: fold a freshly-persisted client detection into a card. */
  async projectDetection(client: Client, event: EventEnvelope): Promise<void> {
    if (event.type !== 'conflict.detected') return;
    const payload = event.payload;
    const raw = { ...payload, repo_id: event.repo_id ?? payload['repo_id'] };
    const parsed = DetectConflictSchema.safeParse(raw);
    if (!parsed.success) {
      this.logger?.warn(
        { eventId: event.event_id, issues: parsed.error.issues.map((i) => i.message) },
        'conflict detection payload rejected',
      );
      return;
    }
    await this.applyDetection(client, event.project_id, parsed.data, {
      actor: event.actor,
      deviceId: event.device_id,
    });
  }

  private async applyDetection(
    client: Client,
    projectId: string,
    parsed: ParsedDetection,
    origin: Origin,
  ): Promise<ConflictSnapshot> {
    const key = canonicalConflictKey(parsed.kind, parsed.task_ids, parsed.paths);
    // Serialize concurrent detections of the same logical conflict across devices.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `${projectId}:conflict:${key}`,
    ]);
    const found = await client.query(
      `SELECT ${CARD_COLS} FROM conflicts WHERE project_id=$1 AND canonical_key=$2 FOR UPDATE`,
      [projectId, key],
    );
    const now = new Date().toISOString();
    const row = found.rows[0];
    const paths = [...new Set(parsed.paths.map(normalizeConflictPath))].sort();
    const taskIds = [...new Set(parsed.task_ids)].sort();

    if (!row) {
      const evidence = unionEvidence([], parsed.evidence).merged;
      const card: ConflictSnapshot = {
        id: makeId('conflict'),
        project_id: projectId,
        canonical_key: key,
        repo_id: parsed.repo_id,
        kind: parsed.kind,
        task_ids: taskIds,
        branch_a: parsed.branch_a ?? null,
        branch_b: parsed.branch_b ?? null,
        paths,
        symbol_ids: [...new Set(parsed.symbol_ids)].sort(),
        evidence,
        detection_epoch: parsed.detection_epoch,
        severity: parsed.severity,
        state: 'open',
        resolved_by: null,
        reopen_count: 0,
        created_at: now,
        last_detected_at: now,
        resolved_at: null,
      };
      await insertCard(client, card);
      await appendHistory(client, card.id, 'detected', origin.actor, {
        detection_epoch: card.detection_epoch,
        detector_device_id: origin.deviceId,
        evidence_count: evidence.length,
      }, card.detection_epoch);
      await recordAudit(clientExecutor(client), {
        projectId, actor: origin.actor, action: 'conflict.detected',
        subject: `conflict:${card.id}`, afterHash: cardDigest(card),
      });
      await this.emitDetected(client, projectId, card, origin.actor, false);
      created.inc();
      evidenceAdded.inc(evidence.length);
      this.logger?.debug({ conflictId: card.id, kind: card.kind, projectId }, 'conflict card minted');
      return card;
    }

    const card = rowToCard(row);
    const { merged, added } = unionEvidence(card.evidence, parsed.evidence);
    const epoch = Math.max(card.detection_epoch, parsed.detection_epoch);
    const severity = maxSeverity(card.severity, parsed.severity);
    const shouldReopen =
      (card.state === 'resolved' || card.state === 'dismissed') &&
      parsed.detection_epoch > card.detection_epoch;

    if (shouldReopen) {
      const next: ConflictSnapshot = {
        ...card,
        evidence: merged,
        detection_epoch: epoch,
        severity,
        state: 'open',
        resolved_by: null,
        resolved_at: null,
        reopen_count: card.reopen_count + 1,
        last_detected_at: now,
        branch_a: card.branch_a ?? parsed.branch_a ?? null,
        branch_b: card.branch_b ?? parsed.branch_b ?? null,
      };
      await updateCard(client, next);
      await appendHistory(client, card.id, 'reopened', origin.actor, {
        previous_state: card.state,
        previous_epoch: card.detection_epoch,
        new_epoch: epoch,
        detector_device_id: origin.deviceId,
        evidence_added: added.length,
      }, epoch);
      await recordAudit(clientExecutor(client), {
        projectId, actor: origin.actor, action: 'conflict.reopened',
        subject: `conflict:${card.id}`, afterHash: cardDigest(next),
      });
      await this.emitDetected(client, projectId, next, origin.actor, true);
      reopened.inc();
      evidenceAdded.inc(added.length);
      this.logger?.info({ conflictId: card.id, epoch, projectId }, 'conflict reopened in later epoch');
      return next;
    }

    // Same-epoch re-detection: union evidence, never flap state or re-emit.
    const changed = added.length > 0 || epoch !== card.detection_epoch || severity !== card.severity;
    if (!changed) return card;
    const next: ConflictSnapshot = {
      ...card,
      evidence: merged,
      detection_epoch: epoch,
      severity,
      last_detected_at: now,
      branch_a: card.branch_a ?? parsed.branch_a ?? null,
      branch_b: card.branch_b ?? parsed.branch_b ?? null,
    };
    await updateCard(client, next);
    if (added.length > 0) {
      await appendHistory(client, card.id, 'evidence', origin.actor, {
        detection_epoch: epoch,
        detector_device_id: origin.deviceId,
        evidence_added: added.length,
      }, epoch);
      evidenceAdded.inc(added.length);
    }
    return next;
  }

  private async emitDetected(
    client: Client,
    projectId: string,
    card: ConflictSnapshot,
    actor: Actor,
    didReopen: boolean,
  ): Promise<void> {
    await appendCoordinationEvent(client, {
      projectId,
      deviceId: this.serverDeviceId,
      type: 'conflict.detected',
      actor,
      repoId: card.repo_id,
      payload: {
        canonical_key: card.canonical_key,
        conflict_id: card.id,
        kind: card.kind,
        severity: card.severity,
        state: card.state,
        detection_epoch: card.detection_epoch,
        task_ids: card.task_ids,
        paths: card.paths,
        evidence_count: card.evidence.length,
        ...(didReopen ? { reopened: true, reopen_count: card.reopen_count } : {}),
      },
    });
  }

  async get(conflictId: string, projectId: string): Promise<ConflictSnapshot | undefined> {
    const res = await this.pool.query(
      `SELECT ${CARD_COLS} FROM conflicts WHERE id=$1 AND project_id=$2`,
      [conflictId, projectId],
    );
    return res.rows[0] ? rowToCard(res.rows[0]) : undefined;
  }

  async list(projectId: string, options: ConflictListOptions = {}): Promise<ConflictSnapshot[]> {
    const params: unknown[] = [projectId];
    let where = 'project_id = $1';
    if (options.state) {
      params.push(options.state);
      where += ` AND state = $${params.length}`;
    }
    if (options.severity) {
      params.push(options.severity);
      where += ` AND severity = $${params.length}`;
    }
    if (options.kind) {
      params.push(options.kind);
      where += ` AND kind = $${params.length}`;
    }
    if (options.repoId) {
      params.push(options.repoId);
      where += ` AND repo_id = $${params.length}`;
    }
    params.push(options.limit ?? 200);
    const res = await this.pool.query(
      `SELECT ${CARD_COLS} FROM conflicts WHERE ${where}
        ORDER BY severity DESC, created_at ASC LIMIT $${params.length}`,
      params,
    );
    return res.rows.map(rowToCard);
  }

  async history(conflictId: string, projectId: string): Promise<ConflictEventRecord[]> {
    await this.requireCard(conflictId, projectId);
    const res = await this.pool.query(
      `SELECT id, conflict_id, type, actor, payload, detection_epoch, ts
         FROM conflict_events WHERE conflict_id=$1 ORDER BY id ASC`,
      [conflictId],
    );
    return res.rows.map(rowToHistory);
  }

  async resolve(
    conflictId: string,
    projectId: string,
    origin: Origin,
    note?: string,
  ): Promise<ConflictSnapshot> {
    return this.setState(conflictId, projectId, origin, 'resolved', note);
  }

  async dismiss(
    conflictId: string,
    projectId: string,
    origin: Origin,
    reason?: string,
  ): Promise<ConflictSnapshot> {
    return this.setState(conflictId, projectId, origin, 'dismissed', reason);
  }

  private async setState(
    conflictId: string,
    projectId: string,
    origin: Origin,
    target: 'resolved' | 'dismissed',
    note?: string,
  ): Promise<ConflictSnapshot> {
    return withTransaction(this.pool, async (client) => {
      const card = await this.lockCard(client, conflictId, projectId);
      if (card.state === target) return card;
      const now = new Date().toISOString();
      const resolvedBy = isSystemActor(origin.actor) ? null : origin.actor.user_id;
      const next: ConflictSnapshot = {
        ...card,
        state: target,
        resolved_by: resolvedBy,
        resolved_at: now,
      };
      await updateCard(client, next);
      await appendHistory(client, conflictId, target, origin.actor, {
        previous_state: card.state,
        ...(note ? { note } : {}),
      }, card.detection_epoch);
      await recordAudit(clientExecutor(client), {
        projectId, actor: origin.actor, action: `conflict.${target}`,
        subject: `conflict:${conflictId}`, afterHash: cardDigest(next),
      });
      await appendCoordinationEvent(client, {
        projectId,
        deviceId: this.serverDeviceId,
        type: `conflict.${target}`,
        actor: origin.actor,
        repoId: card.repo_id,
        payload: {
          canonical_key: card.canonical_key,
          conflict_id: conflictId,
          state: target,
          ...(resolvedBy ? { resolved_by: resolvedBy } : {}),
          ...(note ? { note } : {}),
        },
      });
      if (target === 'resolved') resolved.inc();
      else dismissed.inc();
      return next;
    });
  }

  private async lockCard(client: Client, conflictId: string, projectId: string): Promise<ConflictSnapshot> {
    const res = await client.query(
      `SELECT ${CARD_COLS} FROM conflicts WHERE id=$1 AND project_id=$2 FOR UPDATE`,
      [conflictId, projectId],
    );
    const row = res.rows[0];
    if (!row) throw new ConflictError('not_found', `conflict ${conflictId} not found`);
    return rowToCard(row);
  }

  private async requireCard(conflictId: string, projectId: string): Promise<void> {
    const res = await this.pool.query('SELECT 1 FROM conflicts WHERE id=$1 AND project_id=$2', [
      conflictId, projectId,
    ]);
    if (res.rows.length === 0) throw new ConflictError('not_found', `conflict ${conflictId} not found`);
  }
}