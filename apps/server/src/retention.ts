import type { Client, Pool } from 'pg';
import {
  DEFAULT_RETENTION_BATCH_LIMIT,
  RETENTION_ALLOWLIST,
  RETENTION_POLICY_VERSION,
  RetentionError,
  canonicalJson,
  isRetentionTelemetryType,
  makeRetentionPolicy,
  retentionSelectionFingerprint,
  sha256,
  splitRetentionRanges,
  validateRetentionPolicy,
  type Logger,
  type RetentionApplyInput,
  type RetentionCandidate,
  type RetentionPolicy,
  type RetentionRange,
  type RetentionSequenceRange,
} from '@weft/core';
import {
  PROTOCOL_VERSION,
  isKnownEventType,
  makeId,
  ulid,
  type EventEnvelope,
} from '@weft/protocol';
import { clientExecutor, withTransaction } from './pg.js';
import { recordAudit } from './audit.js';

const DAY_MS = 86_400_000;
const ALLOWLIST_SQL = RETENTION_ALLOWLIST.map((_, i) => `$${i + 1}`).join(',');
const ELIGIBLE = `e.received_at <= $${RETENTION_ALLOWLIST.length + 1}::timestamptz
  AND e.type IN (${ALLOWLIST_SQL})
  AND NOT EXISTS (SELECT 1 FROM event_receipts r
                  WHERE r.device_id=e.device_id AND r.event_id=e.event_id)
  AND NOT EXISTS (SELECT 1 FROM coordination_events c
                  WHERE c.device_id=e.device_id AND c.event_id=e.event_id)`;

interface SelectionRow extends Record<string, unknown> {
  event_id: string;
  v: number;
  device_id: string;
  project_id: string;
  repo_id: string | null;
  session_id: string | null;
  provider_session_id: string | null;
  task_id: string | null;
  seq: number | null;
  global_seq: number;
  ts: string;
  received_at: string;
  type: string;
  actor: unknown;
  payload: unknown;
  privacy: string;
  payload_bytes: number;
}

export interface CentralRetentionPreview {
  sequenceKind: 'global_seq';
  projectId: string;
  cutoff: string;
  policy: RetentionPolicy;
  policyVersion: typeof RETENTION_POLICY_VERSION;
  allowlist: readonly string[];
  dryRun: true;
  batchLimit: number;
  eligibleRows: number;
  eligiblePayloadBytes: number;
  selectedRows: number;
  selectedPayloadBytes: number;
  remainingAfterBatch: number;
  exclusions: {
    protectedCoordination: number;
    protectedUnknown: number;
    protectedOrNonAllowlisted: number;
    protectedReceipts: number;
    tooNew: number;
  };
  summaryCount: number;
  rangeCount: number;
  ranges: RetentionSequenceRange[];
  fingerprint: string;
  generatedAt: string;
  measurements: RetentionMeasurements;
}

export interface RetentionMeasurements {
  payloadBytes: { value: number; label: 'exact'; scope: string };
  storedTupleEstimateBytes: {
    value: number | null;
    label: 'estimate' | 'unavailable';
    scope: string;
  };
  allocatedRelationBytes: { value: number | null; label: 'exact' | 'unavailable'; scope: string };
  freePagesBytes: { value: number | null; label: 'exact' | 'unavailable'; scope: string };
}

export interface CentralRetentionResult extends Omit<CentralRetentionPreview, 'dryRun'> {
  dryRun: false;
  runId: string;
  committed: true;
  committedAt: string;
  idempotent: boolean;
  summaryEventIds: string[];
}

export interface CentralRetentionStatus {
  policyVersion: typeof RETENTION_POLICY_VERSION;
  allowlist: readonly string[];
  defaultTelemetryDays: number;
  batchLimit: number;
  scheduler: {
    partitionAutomation: {
      enabled: true;
      running: boolean;
      lastRunAt: string | null;
      nextRunAt: string | null;
    };
    destructiveApply: false;
  };
  exactCounts: {
    events: number;
    coordinationEvents: number;
    receipts: number;
    summaries: number;
    ranges: number;
    completedRuns: number;
  };
  lastRun: { runId: string; completedAt: string; selectedCount: number } | null;
  partitions: {
    current: string;
    next: string;
    retained: string[];
    defaultRetained: boolean;
    destructiveOperations: false;
  };
  byteMetrics: RetentionMeasurements;
  limitations: readonly string[];
}

export interface CentralRetentionOptions {
  telemetryDays?: number;
  batchLimit?: number;
  intervalMs?: number;
  logger?: Logger;
  onCommit?: (projectId: string) => void | Promise<void>;
}

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}
function n(value: unknown): number {
  return Number(value);
}
function one(rows: Record<string, unknown>[]): Record<string, unknown> {
  if (!rows[0]) throw new Error('retention: expected one database row');
  return rows[0];
}
function monthBounds(date: Date): {
  current: string;
  next: string;
  currentStart: string;
  currentEnd: string;
  nextEnd: string;
} {
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  const end = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
  const nextEnd = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 2, 1));
  const name = (d: Date) =>
    `events_${d.getUTCFullYear()}_${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  return {
    current: name(start),
    next: name(end),
    currentStart: start.toISOString(),
    currentEnd: end.toISOString(),
    nextEnd: nextEnd.toISOString(),
  };
}

/** Central received_at/global_seq retention. Destructive apply is always manual. */
export class CentralRetentionService {
  private readonly summaryDeviceId = makeId('device');
  private readonly telemetryDays: number;
  private readonly batchLimit: number;
  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private nextRunAt: string | null = null;
  private lastPartitionRunAt: string | null = null;
  private partitionTask: Promise<string[]> | null = null;
  private readonly active = new Set<Promise<unknown>>();
  private stopping = false;

  constructor(
    private readonly pool: Pool,
    private readonly options: CentralRetentionOptions = {},
  ) {
    this.telemetryDays = options.telemetryDays ?? 90;
    this.batchLimit = options.batchLimit ?? DEFAULT_RETENTION_BATCH_LIMIT;
    this.intervalMs = options.intervalMs ?? DAY_MS;
  }

  /** Current and next month only. No detach, drop, vacuum, or old-partition GC. */
  async ensureMonthlyPartitions(now = new Date()): Promise<string[]> {
    const task = (async () => {
      const client = await this.pool.connect();
      try {
        await client.query('SELECT pg_advisory_lock(742910001)');
        const m = monthBounds(now);
        await client.query(`CREATE TABLE IF NOT EXISTS ${m.current} PARTITION OF events
          FOR VALUES FROM ('${m.currentStart}') TO ('${m.currentEnd}')`);
        await client.query(`CREATE TABLE IF NOT EXISTS ${m.next} PARTITION OF events
          FOR VALUES FROM ('${m.currentEnd}') TO ('${m.nextEnd}')`);
        const found = await client.query(
          `SELECT relname FROM pg_class WHERE relkind='r' AND relname LIKE 'events_%' ORDER BY relname`,
        );
        this.lastPartitionRunAt = new Date().toISOString();
        return found.rows.map((r) => String(r.relname));
      } finally {
        await client.query('SELECT pg_advisory_unlock(742910001)').catch(() => {});
        client.release();
      }
    })();
    this.partitionTask = task;
    try {
      return await task;
    } finally {
      if (this.partitionTask === task) this.partitionTask = null;
    }
  }

  start(): void {
    if (this.timer) return;
    void this.ensureMonthlyPartitions().catch((err) =>
      this.options.logger?.error({ err }, 'partition automation failed'),
    );
    this.nextRunAt = new Date(Date.now() + this.intervalMs).toISOString();
    this.timer = setInterval(() => {
      void this.ensureMonthlyPartitions().catch((err) =>
        this.options.logger?.error({ err }, 'partition automation failed'),
      );
    }, this.intervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.nextRunAt = null;
    await this.partitionTask?.catch(() => {});
    await Promise.allSettled([...this.active]);
  }

  private candidate(row: Record<string, unknown>): RetentionCandidate {
    return {
      eventId: String(row.event_id),
      deviceId: String(row.device_id),
      sequence: n(row.global_seq),
      type: String(row.type),
      receivedAt: iso(row.received_at),
      payloadBytes: n(row.payload_bytes),
      // Bind the complete stored envelope, not only its payload, so edits to
      // actor, ts, privacy, routing metadata or protocol version stale a preview.
      digest: sha256(
        canonicalJson({
          event_id: row.event_id,
          v: row.v,
          device_id: row.device_id,
          project_id: row.project_id,
          repo_id: row.repo_id ?? null,
          session_id: row.session_id ?? null,
          provider_session_id: row.provider_session_id ?? null,
          task_id: row.task_id ?? null,
          seq: row.seq ?? null,
          global_seq: row.global_seq,
          ts: iso(row.ts),
          received_at: iso(row.received_at),
          type: row.type,
          actor: row.actor,
          payload: row.payload,
          privacy: row.privacy,
        }),
      ),
    };
  }

  private async select(
    client: Client,
    projectId: string,
    policy: RetentionPolicy,
  ): Promise<SelectionRow[]> {
    const result = await client.query(
      `SELECT e.event_id,e.v,e.device_id,e.project_id,e.repo_id,e.session_id,
              e.provider_session_id,e.task_id,e.seq,e.global_seq,e.ts,e.received_at,
              e.type,e.actor,e.payload,e.privacy,
              octet_length(e.payload::text) AS payload_bytes
         FROM events e WHERE e.project_id=$${RETENTION_ALLOWLIST.length + 2} AND ${ELIGIBLE}
        ORDER BY e.global_seq ASC LIMIT $${RETENTION_ALLOWLIST.length + 3}`,
      [...RETENTION_ALLOWLIST, policy.cutoff, projectId, policy.batchLimit],
    );
    return result.rows as SelectionRow[];
  }

  private async counts(
    client: Client,
    projectId: string,
    policy: RetentionPolicy,
  ): Promise<{
    eligibleRows: number;
    eligiblePayloadBytes: number;
    exclusions: CentralRetentionPreview['exclusions'];
  }> {
    const p = [...RETENTION_ALLOWLIST, policy.cutoff, projectId];
    const eligible = one(
      (
        await client.query(
          `SELECT count(*)::bigint AS rows, coalesce(sum(octet_length(e.payload::text)),0)::bigint AS bytes
         FROM events e WHERE e.project_id=$${p.length} AND ${ELIGIBLE}`,
          p,
        )
      ).rows,
    );
    const grouped = (
      await client.query(
        `SELECT e.type, count(*)::bigint AS count,
              count(*) FILTER (WHERE EXISTS (
                SELECT 1 FROM coordination_events c
                 WHERE c.device_id=e.device_id AND c.event_id=e.event_id
              ))::bigint AS coordination,
              count(*) FILTER (WHERE EXISTS (
                SELECT 1 FROM event_receipts r
                 WHERE r.device_id=e.device_id AND r.event_id=e.event_id
              ))::bigint AS receipted
         FROM events e WHERE e.project_id=$1 AND e.received_at <= $2::timestamptz
        GROUP BY e.type`,
        [projectId, policy.cutoff],
      )
    ).rows;
    const exclusions: CentralRetentionPreview['exclusions'] = {
      protectedCoordination: 0,
      protectedUnknown: 0,
      protectedOrNonAllowlisted: 0,
      protectedReceipts: 0,
      tooNew: 0,
    };
    for (const row of grouped) {
      let remaining = n(row.count);
      const coordination = Math.min(remaining, n(row.coordination));
      exclusions.protectedCoordination += coordination;
      remaining -= coordination;
      const receipted = Math.min(remaining, n(row.receipted));
      exclusions.protectedReceipts += receipted;
      remaining -= receipted;
      const type = String(row.type);
      if (isRetentionTelemetryType(type)) continue;
      if (isKnownEventType(type)) exclusions.protectedOrNonAllowlisted += remaining;
      else exclusions.protectedUnknown += remaining;
    }
    exclusions.tooNew = n(
      one(
        (
          await client.query(
            'SELECT count(*)::bigint AS count FROM events WHERE project_id=$1 AND received_at > $2::timestamptz',
            [projectId, policy.cutoff],
          )
        ).rows,
      ).count,
    );
    return {
      eligibleRows: n(eligible.rows),
      eligiblePayloadBytes: n(eligible.bytes),
      exclusions,
    };
  }

  private fingerprint(projectId: string, policy: RetentionPolicy, rows: SelectionRow[]): string {
    return retentionSelectionFingerprint({
      sequenceKind: 'global_seq',
      projectId,
      policy,
      candidates: rows.map((r) => this.candidate(r)),
    });
  }

  async preview(
    projectId: string,
    input: { cutoff?: string; batchLimit?: number } = {},
  ): Promise<CentralRetentionPreview> {
    if (!projectId) throw new RetentionError('validation', 'projectId is required', 400);
    const policy = makeRetentionPolicy(
      input.cutoff ?? new Date(Date.now() - this.telemetryDays * DAY_MS).toISOString(),
      input.batchLimit ?? this.batchLimit,
    );
    const client = await this.pool.connect();
    try {
      // A read-only transaction gives counts and selection one consistent snapshot.
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const selected = await this.select(client, projectId, policy);
      const counts = await this.counts(client, projectId, policy);
      await client.query('COMMIT');
      const ranges = splitRetentionRanges(
        'global_seq',
        selected.map((r) => n(r.global_seq)),
      );
      const payloadBytes = selected.reduce((sum, r) => sum + n(r.payload_bytes), 0);
      return {
        sequenceKind: 'global_seq',
        projectId,
        cutoff: policy.cutoff,
        policy,
        policyVersion: RETENTION_POLICY_VERSION,
        allowlist: [...RETENTION_ALLOWLIST],
        dryRun: true,
        batchLimit: policy.batchLimit,
        eligibleRows: counts.eligibleRows,
        eligiblePayloadBytes: counts.eligiblePayloadBytes,
        selectedRows: selected.length,
        selectedPayloadBytes: payloadBytes,
        remainingAfterBatch: Math.max(0, counts.eligibleRows - selected.length),
        exclusions: counts.exclusions,
        summaryCount: ranges.length,
        rangeCount: ranges.length,
        ranges,
        fingerprint: this.fingerprint(projectId, policy, selected),
        generatedAt: new Date().toISOString(),
        measurements: await this.measurements(client, projectId, payloadBytes),
      };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  private async measurements(
    client: Client,
    projectId: string,
    payloadBytes: number | null,
  ): Promise<RetentionMeasurements> {
    const size = one(
      (
        await client.query(
          `SELECT coalesce(sum(pg_column_size(e)),0)::bigint AS tuple_bytes,
              coalesce(sum(octet_length(e.payload::text)),0)::bigint AS payload_bytes,
              pg_total_relation_size('events')::bigint AS relation_bytes
         FROM events e WHERE e.project_id=$1`,
          [projectId],
        )
      ).rows,
    );
    return {
      payloadBytes: {
        value: payloadBytes ?? n(size.payload_bytes),
        label: 'exact',
        scope:
          'UTF-8 bytes of the current PostgreSQL JSONB text representation for the reported selection or project; original wire bytes are not retained',
      },
      storedTupleEstimateBytes: {
        value: n(size.tuple_bytes),
        label: 'estimate',
        scope: 'all hot rows for project; PostgreSQL pg_column_size, not reclaimed bytes',
      },
      allocatedRelationBytes: {
        value: n(size.relation_bytes),
        label: 'exact',
        scope:
          'whole partitioned events relation and indexes; not project-attributable or reclaimed',
      },
      freePagesBytes: {
        value: null,
        label: 'unavailable',
        scope:
          'Postgres does not expose safely reclaimable per-project free pages; no VACUUM is performed',
      },
    };
  }

  async status(projectId: string): Promise<CentralRetentionStatus> {
    if (!projectId) throw new RetentionError('validation', 'projectId is required', 400);
    const client = await this.pool.connect();
    try {
      const c = one(
        (
          await client.query(
            `SELECT (SELECT count(*)::bigint FROM events WHERE project_id=$1) AS events,
                (SELECT count(*)::bigint FROM coordination_events WHERE project_id=$1) AS coordination,
                (SELECT count(*)::bigint FROM event_receipts WHERE project_id=$1) AS receipts,
                (SELECT count(*)::bigint FROM event_summaries WHERE project_id=$1) AS summaries,
                (SELECT count(*)::bigint FROM retention_ranges WHERE project_id=$1) AS ranges,
                (SELECT count(*)::bigint FROM retention_runs WHERE project_id=$1 AND state='completed') AS runs`,
            [projectId],
          )
        ).rows,
      );
      const last = (
        await client.query(
          `SELECT run_id,completed_at,selected_count FROM retention_runs WHERE project_id=$1 AND state='completed'
          ORDER BY completed_at DESC LIMIT 1`,
          [projectId],
        )
      ).rows[0];
      const partitions = (
        await client.query(
          `SELECT c.relname FROM pg_class c JOIN pg_inherits i ON i.inhrelid=c.oid
          WHERE i.inhparent='events'::regclass AND c.relispartition ORDER BY c.relname`,
        )
      ).rows.map((r) => String(r.relname));
      const m = monthBounds(new Date());
      return {
        policyVersion: RETENTION_POLICY_VERSION,
        allowlist: [...RETENTION_ALLOWLIST],
        defaultTelemetryDays: this.telemetryDays,
        batchLimit: this.batchLimit,
        scheduler: {
          partitionAutomation: {
            enabled: true,
            running: this.timer !== null,
            lastRunAt: this.lastPartitionRunAt,
            nextRunAt: this.nextRunAt,
          },
          destructiveApply: false,
        },
        exactCounts: {
          events: n(c.events),
          coordinationEvents: n(c.coordination),
          receipts: n(c.receipts),
          summaries: n(c.summaries),
          ranges: n(c.ranges),
          completedRuns: n(c.runs),
        },
        lastRun: last
          ? {
              runId: String(last.run_id),
              completedAt: iso(last.completed_at),
              selectedCount: n(last.selected_count),
            }
          : null,
        partitions: {
          current: m.current,
          next: m.next,
          retained: partitions,
          defaultRetained: partitions.includes('events_default'),
          destructiveOperations: false,
        },
        byteMetrics: await this.measurements(client, projectId, null),
        limitations: [
          'Raw payloads are not recoverable from receipts or ranges.',
          'Deletion does not reclaim physical disk; no VACUUM, partition DROP, or GC is performed.',
        ],
      };
    } finally {
      client.release();
    }
  }

  private async existingResult(
    client: Client,
    projectId: string,
    runId: string,
    fingerprint: string,
    policy: RetentionPolicy,
  ): Promise<CentralRetentionResult | null> {
    const run = (
      await client.query('SELECT * FROM retention_runs WHERE project_id=$1 AND run_id=$2', [
        projectId,
        runId,
      ])
    ).rows[0];
    if (!run) return null;
    // Postgres normalizes timestamptz offsets; compare the instant while the
    // fingerprint continues to bind the client's exact policy representation.
    if (
      run.fingerprint !== fingerprint ||
      Date.parse(iso(run.cutoff)) !== Date.parse(policy.cutoff)
    )
      throw new RetentionError('run_conflict', 'runId was already used for another selection', 409);
    const ranges = (
      await client.query(
        'SELECT * FROM retention_ranges WHERE project_id=$1 AND run_id=$2 ORDER BY seq_start',
        [projectId, runId],
      )
    ).rows;
    const summaries = (
      await client.query(
        'SELECT event_id FROM event_summaries WHERE project_id=$1 AND run_id=$2 ORDER BY seq_start',
        [projectId, runId],
      )
    ).rows;
    return {
      sequenceKind: 'global_seq',
      projectId,
      cutoff: policy.cutoff,
      policy,
      policyVersion: RETENTION_POLICY_VERSION,
      allowlist: [...RETENTION_ALLOWLIST],
      dryRun: false,
      batchLimit: n(run.batch_limit),
      eligibleRows: n(run.eligible_count),
      eligiblePayloadBytes: n(run.eligible_payload_bytes),
      selectedRows: n(run.selected_count),
      selectedPayloadBytes: n(run.payload_bytes),
      remainingAfterBatch: Math.max(0, n(run.eligible_count) - n(run.selected_count)),
      exclusions: {
        protectedCoordination: n(run.protected_coordination),
        protectedUnknown: n(run.protected_unknown),
        protectedOrNonAllowlisted: n(run.protected_other),
        protectedReceipts: n(run.protected_receipts),
        tooNew: n(run.too_new),
      },
      summaryCount: n(run.summary_count),
      rangeCount: n(run.range_count),
      ranges: ranges.map((r) => ({
        sequenceKind: 'global_seq' as const,
        seqStart: n(r.seq_start),
        seqEnd: n(r.seq_end),
      })),
      fingerprint,
      generatedAt: iso(run.started_at),
      measurements: await this.measurements(client, projectId, n(run.payload_bytes)),
      runId,
      committed: true,
      committedAt: iso(run.completed_at),
      idempotent: true,
      summaryEventIds: summaries.map((r) => String(r.event_id)),
    };
  }

  async apply(input: RetentionApplyInput & { projectId: string }): Promise<CentralRetentionResult> {
    if (this.stopping) throw new RetentionError('validation', 'retention service is stopping', 503);
    const projectId = input.projectId;
    if (!projectId || input.confirm !== true || !input.runId || !input.fingerprint)
      throw new RetentionError(
        'validation',
        'projectId, runId, fingerprint and confirm=true are required',
        400,
      );
    const policy = validateRetentionPolicy(input.policy);
    if (input.cutoff !== policy.cutoff)
      throw new RetentionError('validation', 'cutoff must exactly match policy.cutoff', 400);
    const task = withTransaction(this.pool, async (client) => {
      // Same row lock as ingest's sequence reservation serializes selection,
      // summary sequence allocation, deletion, and all incoming project events.
      await client.query(
        'INSERT INTO project_stream_seq(project_id,last_seq,min_seq) VALUES($1,0,0) ON CONFLICT(project_id) DO UPDATE SET project_id=EXCLUDED.project_id',
        [projectId],
      );
      await client.query('SELECT last_seq FROM project_stream_seq WHERE project_id=$1 FOR UPDATE', [
        projectId,
      ]);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,742910002))', [
        `retention:${projectId}`,
      ]);
      const prior = await this.existingResult(
        client,
        projectId,
        input.runId,
        input.fingerprint,
        policy,
      );
      if (prior) return { result: prior, wake: false };
      const selected = await this.select(client, projectId, policy);
      const fingerprint = this.fingerprint(projectId, policy, selected);
      if (fingerprint !== input.fingerprint)
        throw new RetentionError('stale_preview', 'retention preview is stale; preview again', 409);
      const counts = await this.counts(client, projectId, policy);
      const ranges = splitRetentionRanges(
        'global_seq',
        selected.map((r) => n(r.global_seq)),
      );
      const now = new Date().toISOString();
      const payloadBytes = selected.reduce((sum, r) => sum + n(r.payload_bytes), 0);
      let firstSummarySeq = 0;
      if (ranges.length) {
        const stream = one(
          (
            await client.query(
              `INSERT INTO project_stream_seq(project_id,last_seq,min_seq) VALUES($1,$2,0)
           ON CONFLICT(project_id) DO UPDATE SET last_seq=project_stream_seq.last_seq+$2 RETURNING last_seq,min_seq`,
              [projectId, ranges.length],
            )
          ).rows,
        );
        firstSummarySeq = n(stream.last_seq) - ranges.length + 1;
      } else {
        firstSummarySeq =
          n(
            one(
              (
                await client.query(
                  'SELECT last_seq,min_seq FROM project_stream_seq WHERE project_id=$1',
                  [projectId],
                )
              ).rows,
            ).last_seq,
          ) + 1;
      }
      const summaryEventIds: string[] = [];
      for (const [index, range] of ranges.entries()) {
        const rows = selected.filter(
          (r) => n(r.global_seq) >= range.seqStart && n(r.global_seq) <= range.seqEnd,
        );
        const typeCounts: Record<string, number> = {};
        for (const r of rows) typeCounts[r.type] = (typeCounts[r.type] ?? 0) + 1;
        const eventId = ulid();
        summaryEventIds.push(eventId);
        const summaryPayload = {
          seq_start: range.seqStart,
          seq_end: range.seqEnd,
          dropped_types: Object.keys(typeCounts),
          reason: 'manual_retention',
          run_id: input.runId,
          sequence_kind: 'global_seq',
          selected_count: rows.length,
          type_counts: typeCounts,
          raw_payload_recoverable: false,
        };
        const event: EventEnvelope = {
          v: PROTOCOL_VERSION,
          event_id: eventId,
          device_id: this.summaryDeviceId,
          project_id: projectId,
          ts: now,
          type: 'summary.compacted',
          actor: { system: 'weft-retention' },
          privacy: 'metadata',
          payload: summaryPayload,
        };
        await client.query(
          `INSERT INTO events(event_id,v,device_id,project_id,global_seq,ts,received_at,type,actor,payload,privacy)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [
            eventId,
            1,
            event.device_id,
            projectId,
            firstSummarySeq + index,
            now,
            now,
            event.type,
            JSON.stringify(event.actor),
            JSON.stringify(event.payload),
            event.privacy,
          ],
        );
        await client.query(
          `INSERT INTO event_summaries(project_id,event_id,run_id,sequence_kind,seq_start,seq_end,summary_kind,type_counts,payload_bytes,event_digest,created_at)
           VALUES($1,$2,$3,'global_seq',$4,$5,'retention_range',$6,$7,$8,$9)`,
          [
            projectId,
            eventId,
            input.runId,
            range.seqStart,
            range.seqEnd,
            JSON.stringify(typeCounts),
            rows.reduce((s, r) => s + n(r.payload_bytes), 0),
            sha256(canonicalJson(event)),
            now,
          ],
        );
        await client.query(
          `INSERT INTO retention_ranges(project_id,run_id,sequence_kind,seq_start,seq_end,summary_event_id,selected_count,payload_bytes,type_counts)
           VALUES($1,$2,'global_seq',$3,$4,$5,$6,$7,$8)`,
          [
            projectId,
            input.runId,
            range.seqStart,
            range.seqEnd,
            eventId,
            rows.length,
            rows.reduce((s, r) => s + n(r.payload_bytes), 0),
            JSON.stringify(typeCounts),
          ],
        );
      }
      for (const row of selected) {
        const rangeIndex = ranges.findIndex(
          (r) => n(row.global_seq) >= r.seqStart && n(row.global_seq) <= r.seqEnd,
        );
        await client.query(
          `INSERT INTO event_receipts(device_id,event_id,project_id,original_global_seq,received_at,event_type,payload_bytes,event_hash,run_id,summary_event_id,compacted_at)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [
            row.device_id,
            row.event_id,
            projectId,
            n(row.global_seq),
            row.received_at,
            row.type,
            n(row.payload_bytes),
            this.candidate(row).digest,
            input.runId,
            summaryEventIds[rangeIndex],
            now,
          ],
        );
      }
      await client.query(
        `INSERT INTO retention_runs(project_id,run_id,kind,state,policy_json,fingerprint,cutoff,batch_limit,eligible_count,eligible_payload_bytes,protected_coordination,protected_unknown,protected_other,protected_receipts,too_new,selected_count,payload_bytes,range_count,summary_count,started_at,completed_at)
         VALUES($1,$2,'manual','completed',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$18)`,
        [
          projectId,
          input.runId,
          JSON.stringify(policy),
          fingerprint,
          policy.cutoff,
          policy.batchLimit,
          counts.eligibleRows,
          counts.eligiblePayloadBytes,
          counts.exclusions.protectedCoordination,
          counts.exclusions.protectedUnknown,
          counts.exclusions.protectedOrNonAllowlisted,
          counts.exclusions.protectedReceipts,
          counts.exclusions.tooNew,
          selected.length,
          payloadBytes,
          ranges.length,
          ranges.length,
          now,
        ],
      );
      if (selected.length) {
        const values: unknown[] = [];
        const tuples = selected.map((r, i) => {
          values.push(r.project_id, r.device_id, r.event_id, r.received_at);
          return `($${i * 4 + 1},$${i * 4 + 2},$${i * 4 + 3},$${i * 4 + 4}::timestamptz)`;
        });
        const deleted = await client.query(
          `WITH exact(project_id,device_id,event_id,received_at) AS (VALUES ${tuples.join(',')}), gone AS (
             DELETE FROM events e USING exact x
              WHERE e.project_id=x.project_id AND e.device_id=x.device_id
                AND e.event_id=x.event_id AND e.received_at=x.received_at
              RETURNING e.global_seq)
           SELECT count(*)::bigint AS count FROM gone`,
          values,
        );
        if (n(one(deleted.rows).count) !== selected.length)
          throw new Error('central retention deletion verification failed');
        const remaining = await client.query(
          `SELECT count(*)::bigint AS count FROM events e
            WHERE (e.project_id,e.device_id,e.event_id,e.received_at) IN (VALUES ${tuples.join(',')})`,
          values,
        );
        if (n(one(remaining.rows).count) !== 0)
          throw new Error('central retention rows remain after deletion');
      }
      const minimum = one(
        (
          await client.query(
            'SELECT coalesce(min(global_seq), (SELECT last_seq+1 FROM project_stream_seq WHERE project_id=$1))::bigint AS seq FROM events WHERE project_id=$1',
            [projectId],
          )
        ).rows,
      );
      await client.query(
        'UPDATE project_stream_seq SET min_seq=GREATEST(min_seq,$1) WHERE project_id=$2',
        [n(minimum.seq), projectId],
      );
      await recordAudit(clientExecutor(client), {
        projectId,
        actor: { system: 'weft-retention' },
        action: 'retention.applied',
        subject: `retention:${input.runId}`,
        afterHash: fingerprint,
      });
      const result: CentralRetentionResult = {
        sequenceKind: 'global_seq' as const,
        projectId,
        cutoff: policy.cutoff,
        policy,
        policyVersion: RETENTION_POLICY_VERSION,
        allowlist: [...RETENTION_ALLOWLIST],
        dryRun: false as const,
        batchLimit: policy.batchLimit,
        eligibleRows: counts.eligibleRows,
        eligiblePayloadBytes: counts.eligiblePayloadBytes,
        selectedRows: selected.length,
        selectedPayloadBytes: payloadBytes,
        remainingAfterBatch: Math.max(0, counts.eligibleRows - selected.length),
        exclusions: counts.exclusions,
        summaryCount: ranges.length,
        rangeCount: ranges.length,
        ranges,
        fingerprint,
        generatedAt: now,
        runId: input.runId,
        committed: true,
        committedAt: now,
        idempotent: false,
        summaryEventIds,
        measurements: await this.measurements(client, projectId, payloadBytes),
      };
      return { result, wake: true };
    });
    this.active.add(task);
    try {
      const committed = await task;
      if (committed.wake) {
        try {
          await this.options.onCommit?.(projectId);
        } catch (err) {
          this.options.logger?.warn({ err, projectId }, 'retention committed; wake failed');
        }
      }
      return committed.result;
    } finally {
      this.active.delete(task);
    }
  }

  /** Exact overlapping ranges for REST/SSE gap notices; never infer deleted rows. */
  async ranges(
    projectId: string,
    afterSeq = 0,
    beforeSeq = Number.MAX_SAFE_INTEGER,
  ): Promise<RetentionRange[]> {
    if (
      !projectId ||
      !Number.isSafeInteger(afterSeq) ||
      !Number.isSafeInteger(beforeSeq) ||
      afterSeq < 0 ||
      beforeSeq < afterSeq
    )
      throw new RetentionError('validation', 'invalid retention range cursor', 400);
    const rows = (
      await this.pool.query(
        `SELECT run_id,sequence_kind,seq_start,seq_end,summary_event_id FROM retention_ranges
        WHERE project_id=$1 AND sequence_kind='global_seq' AND seq_end>$2 AND seq_start<=$3
        ORDER BY seq_start`,
        [projectId, afterSeq, beforeSeq],
      )
    ).rows;
    return rows.map((r) => ({
      runId: String(r.run_id),
      sequenceKind: 'global_seq' as const,
      seqStart: n(r.seq_start),
      seqEnd: n(r.seq_end),
      summaryEventId: r.summary_event_id === null ? null : String(r.summary_event_id),
    }));
  }
}
