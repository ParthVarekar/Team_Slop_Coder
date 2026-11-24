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
  type RetentionSequenceRange,
} from '@weft/core';
import {
  PROTOCOL_VERSION,
  isKnownEventType,
  makeId,
  ulid,
  type EventEnvelope,
} from '@weft/protocol';
import type { LocalStore, OutboxPressure, StoredLocalEvent } from './store.js';

const DAY_MS = 86_400_000;

interface SelectionRow {
  rowid: number;
  event_id: string;
  device_id: string;
  project_id: string;
  ts: string;
  received_at: string;
  type: string;
  actor: string;
  payload: string;
  privacy: string;
  payload_bytes: number;
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

export interface LocalRetentionPreview {
  sequenceKind: 'rowid';
  projectId: string | null;
  cutoff: string;
  policy: RetentionPolicy;
  policyVersion: typeof RETENTION_POLICY_VERSION;
  allowlist: readonly string[];
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
  pendingOutboxExclusions: number;
  summaryCount: number;
  rangeCount: number;
  ranges: RetentionSequenceRange[];
  fingerprint: string;
  generatedAt: string;
  measurements: RetentionMeasurements;
  dryRun: true;
}

export interface LocalRetentionResult extends Omit<LocalRetentionPreview, 'dryRun'> {
  dryRun: false;
  runId: string;
  committed: true;
  committedAt: string;
  idempotent: boolean;
  summaryEventIds: string[];
}

export interface LocalRetentionStatus {
  policyVersion: typeof RETENTION_POLICY_VERSION;
  allowlist: readonly string[];
  defaultTelemetryDays: number;
  batchLimit: number;
  scheduler: {
    enabled: boolean;
    running: boolean;
    destructiveApply: false;
    lastPreviewAt: string | null;
    nextRunAt: string | null;
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
  outbox: OutboxPressure;
  partitions: null;
  byteMetrics: RetentionMeasurements;
  limitations: readonly string[];
}

export interface LocalRetentionOptions {
  projectId?: string | null;
  telemetryDays?: number;
  batchLimit?: number;
  schedulerEnabled?: boolean;
  intervalMs?: number;
  onCommit?: () => void;
  logger?: Logger;
}

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function number(value: unknown): number {
  return Number(value);
}

/** Local received_at/rowid retention. All destructive work is explicit and manual. */
export class LocalRetentionService {
  private readonly summaryDeviceId = makeId('device');
  private readonly projectId: string | null;
  private readonly telemetryDays: number;
  private readonly batchLimit: number;
  private readonly schedulerEnabled: boolean;
  private readonly intervalMs: number;
  private readonly onCommit: (() => void) | undefined;
  private readonly logger: Logger | undefined;
  private timer: NodeJS.Timeout | null = null;
  private nextRunAt: string | null = null;
  private lastPreviewAt: string | null = null;

  constructor(
    private readonly store: LocalStore,
    options: LocalRetentionOptions = {},
  ) {
    this.projectId = options.projectId ?? null;
    this.telemetryDays = options.telemetryDays ?? 90;
    this.batchLimit = options.batchLimit ?? DEFAULT_RETENTION_BATCH_LIMIT;
    this.schedulerEnabled = options.schedulerEnabled ?? false;
    this.intervalMs = options.intervalMs ?? DAY_MS;
    this.onCommit = options.onCommit;
    this.logger = options.logger;
  }

  private defaultCutoff(): string {
    return new Date(Date.now() - this.telemetryDays * DAY_MS).toISOString();
  }

  private projectClause(alias = 'e'): { sql: string; params: unknown[] } {
    return this.projectId
      ? { sql: ` AND ${alias}.project_id = ?`, params: [this.projectId] }
      : { sql: '', params: [] };
  }

  private selectCandidates(policy: RetentionPolicy): SelectionRow[] {
    const project = this.projectClause();
    return this.store.db
      .prepare(
        `SELECT e.rowid, e.event_id, e.device_id, e.project_id, e.ts, e.received_at,
                e.type, e.actor, e.payload, e.privacy,
                length(CAST(e.payload AS BLOB)) AS payload_bytes
           FROM events e
          WHERE julianday(e.received_at) <= julianday(?)
            AND e.type IN (${RETENTION_ALLOWLIST.map(() => '?').join(',')})
            AND NOT EXISTS (SELECT 1 FROM event_receipts r WHERE r.event_id = e.event_id)
            AND NOT EXISTS (SELECT 1 FROM outbox o WHERE o.event_id = e.event_id AND o.shipped_at IS NULL)
            AND NOT EXISTS (SELECT 1 FROM coordination_events c WHERE c.event_id = e.event_id)
            ${project.sql}
          ORDER BY e.rowid ASC LIMIT ?`,
      )
      .all(
        policy.cutoff,
        ...RETENTION_ALLOWLIST,
        ...project.params,
        policy.batchLimit,
      ) as SelectionRow[];
  }

  private candidate(row: SelectionRow): RetentionCandidate {
    return {
      eventId: row.event_id,
      deviceId: row.device_id,
      sequence: row.rowid,
      type: row.type,
      receivedAt: row.received_at,
      payloadBytes: row.payload_bytes,
      digest: sha256(
        canonicalJson({
          event_id: row.event_id,
          device_id: row.device_id,
          project_id: row.project_id,
          ts: row.ts,
          received_at: row.received_at,
          type: row.type,
          actor: JSON.parse(row.actor),
          payload: JSON.parse(row.payload),
          privacy: row.privacy,
        }),
      ),
    };
  }

  private eligibleTotals(policy: RetentionPolicy): { rows: number; payloadBytes: number } {
    const project = this.projectClause();
    const row = this.store.db
      .prepare(
        `SELECT COUNT(*) AS rows,
                COALESCE(SUM(length(CAST(e.payload AS BLOB))), 0) AS payload_bytes
           FROM events e
          WHERE julianday(e.received_at) <= julianday(?)
            AND e.type IN (${RETENTION_ALLOWLIST.map(() => '?').join(',')})
            AND NOT EXISTS (SELECT 1 FROM event_receipts r WHERE r.event_id = e.event_id)
            AND NOT EXISTS (SELECT 1 FROM outbox o WHERE o.event_id = e.event_id AND o.shipped_at IS NULL)
            AND NOT EXISTS (SELECT 1 FROM coordination_events c WHERE c.event_id = e.event_id)
            ${project.sql}`,
      )
      .get(policy.cutoff, ...RETENTION_ALLOWLIST, ...project.params) as {
      rows: number;
      payload_bytes: number;
    };
    return { rows: row.rows, payloadBytes: row.payload_bytes };
  }

  private exclusions(policy: RetentionPolicy): {
    exclusions: LocalRetentionPreview['exclusions'];
    pendingOutboxExclusions: number;
    eligibleRows: number;
    eligiblePayloadBytes: number;
    tooNew: number;
  } {
    const project = this.projectClause();
    const grouped = this.store.db
      .prepare(
        `SELECT e.type, COUNT(*) AS count,
                SUM(CASE WHEN EXISTS (
                  SELECT 1 FROM event_receipts r WHERE r.event_id = e.event_id
                ) THEN 1 ELSE 0 END) AS receipted,
                SUM(CASE WHEN EXISTS (
                  SELECT 1 FROM outbox o WHERE o.event_id = e.event_id AND o.shipped_at IS NULL
                ) THEN 1 ELSE 0 END) AS pending_outbox,
                SUM(CASE WHEN EXISTS (
                  SELECT 1 FROM coordination_events c WHERE c.event_id = e.event_id
                ) THEN 1 ELSE 0 END) AS coordination,
                SUM(length(CAST(e.payload AS BLOB))) AS payload_bytes
           FROM events e
          WHERE julianday(e.received_at) <= julianday(?) ${project.sql}
          GROUP BY e.type`,
      )
      .all(policy.cutoff, ...project.params) as {
      type: string;
      count: number;
      receipted: number;
      pending_outbox: number;
      coordination: number;
      payload_bytes: number;
    }[];
    const exclusions = {
      protectedCoordination: 0,
      protectedUnknown: 0,
      protectedOrNonAllowlisted: 0,
      protectedReceipts: 0,
      tooNew: 0,
    };
    let pendingOutboxExclusions = 0;
    const eligibleTotals = this.eligibleTotals(policy);
    for (const row of grouped) {
      let remaining = row.count;
      const coordination = Math.min(remaining, row.coordination);
      exclusions.protectedCoordination += coordination;
      remaining -= coordination;
      const receipted = Math.min(remaining, row.receipted);
      exclusions.protectedReceipts += receipted;
      remaining -= receipted;
      if (isRetentionTelemetryType(row.type)) {
        const pending = Math.min(remaining, row.pending_outbox);
        pendingOutboxExclusions += pending;
        remaining -= pending;
      } else if (isKnownEventType(row.type)) {
        exclusions.protectedOrNonAllowlisted += remaining;
      } else {
        exclusions.protectedUnknown += remaining;
      }
    }
    const tooNew = this.store.db
      .prepare(
        `SELECT COUNT(*) AS c FROM events e
          WHERE julianday(e.received_at) > julianday(?) ${project.sql}`,
      )
      .get(policy.cutoff, ...project.params) as { c: number };
    exclusions.tooNew = tooNew.c;
    return {
      exclusions,
      pendingOutboxExclusions,
      eligibleRows: eligibleTotals.rows,
      eligiblePayloadBytes: eligibleTotals.payloadBytes,
      tooNew: tooNew.c,
    };
  }

  private byteMetrics(payloadBytes?: number): RetentionMeasurements {
    const db = this.store.db;
    const payload =
      payloadBytes ??
      number(
        (
          this.store.db
            .prepare(
              `SELECT COALESCE(SUM(length(CAST(payload AS BLOB))), 0) AS c FROM events e
                ${this.projectId ? 'WHERE e.project_id = ?' : ''}`,
            )
            .get(...(this.projectId ? [this.projectId] : [])) as { c: number }
        ).c,
      );
    let allocated: number | null = null;
    const tupleEstimate = number(
      (
        db
          .prepare(
            `SELECT COALESCE(SUM(
           length(CAST(e.event_id AS BLOB)) + length(CAST(e.v AS BLOB)) +
           length(CAST(e.device_id AS BLOB)) + length(CAST(e.project_id AS BLOB)) +
           length(CAST(COALESCE(e.repo_id, '') AS BLOB)) +
           length(CAST(COALESCE(e.session_id, '') AS BLOB)) +
           length(CAST(COALESCE(e.provider_session_id, '') AS BLOB)) +
           length(CAST(COALESCE(e.task_id, '') AS BLOB)) +
           length(CAST(COALESCE(e.seq, '') AS BLOB)) + length(CAST(e.ts AS BLOB)) +
           length(CAST(e.type AS BLOB)) + length(CAST(e.actor AS BLOB)) +
           length(CAST(e.payload AS BLOB)) + length(CAST(e.privacy AS BLOB)) +
           length(CAST(e.received_at AS BLOB))
         ), 0) AS c FROM events e
           ${this.projectId ? 'WHERE e.project_id = ?' : ''}`,
          )
          .get(...(this.projectId ? [this.projectId] : [])) as { c: number }
      ).c,
    );
    try {
      allocated = number(
        (
          db
            .prepare(
              `SELECT COALESCE(SUM(pgsize), 0) AS c FROM dbstat
                WHERE name IN ('events', 'sqlite_autoindex_events_1')`,
            )
            .get() as { c: number }
        ).c,
      );
    } catch {
      allocated = null;
    }
    const freePages = number(db.pragma('freelist_count', { simple: true }) as number);
    const pageSize = number(db.pragma('page_size', { simple: true }) as number);
    return {
      payloadBytes: {
        value: payload,
        label: 'exact',
        scope:
          payloadBytes === undefined
            ? 'all hot rows for scope; UTF-8 bytes of stored JSON payload text'
            : 'selected rows; UTF-8 bytes of stored JSON payload text',
      },
      storedTupleEstimateBytes: {
        value: tupleEstimate,
        label: 'estimate',
        scope:
          'all hot rows for scope; sum of stored column-value bytes, excluding record headers, b-tree overhead and indexes',
      },
      allocatedRelationBytes: {
        value: allocated,
        label: allocated === null ? 'unavailable' : 'exact',
        scope: 'events table and primary-key index pages; not reclaimed disk',
      },
      freePagesBytes: {
        value: freePages * pageSize,
        label: 'exact',
        scope: 'whole-database freelist pages; not attributable to retention',
      },
    };
  }

  preview(input: { cutoff?: unknown; batchLimit?: unknown } = {}): LocalRetentionPreview {
    const policy = makeRetentionPolicy(
      input.cutoff ?? this.defaultCutoff(),
      input.batchLimit ?? this.batchLimit,
    );
    const selected = this.selectCandidates(policy);
    const candidates = selected.map((row) => this.candidate(row));
    const counts = this.exclusions(policy);
    const ranges = splitRetentionRanges(
      'rowid',
      candidates.map((candidate) => candidate.sequence),
    );
    const selectedPayloadBytes = candidates.reduce(
      (total, candidate) => total + candidate.payloadBytes,
      0,
    );
    return {
      sequenceKind: 'rowid',
      projectId: this.projectId,
      cutoff: policy.cutoff,
      policy,
      policyVersion: RETENTION_POLICY_VERSION,
      allowlist: [...RETENTION_ALLOWLIST],
      batchLimit: policy.batchLimit,
      eligibleRows: counts.eligibleRows,
      eligiblePayloadBytes: counts.eligiblePayloadBytes,
      selectedRows: selected.length,
      selectedPayloadBytes,
      remainingAfterBatch: Math.max(0, counts.eligibleRows - selected.length),
      exclusions: counts.exclusions,
      pendingOutboxExclusions: counts.pendingOutboxExclusions,
      summaryCount: ranges.length,
      rangeCount: ranges.length,
      ranges,
      fingerprint: retentionSelectionFingerprint({
        sequenceKind: 'rowid',
        projectId: this.projectId,
        policy,
        candidates,
      }),
      generatedAt: new Date().toISOString(),
      measurements: this.byteMetrics(selectedPayloadBytes),
      dryRun: true,
    };
  }

  private existingRun(runId: string): Record<string, unknown> | undefined {
    return this.store.db
      .prepare(`SELECT * FROM retention_runs WHERE run_id = ? AND kind = 'manual'`)
      .get(runId) as Record<string, unknown> | undefined;
  }

  private resultForRun(row: Record<string, unknown>, idempotent: boolean): LocalRetentionResult {
    const policy = validateRetentionPolicy(JSON.parse(String(row.policy_json)));
    const ranges = this.store.db
      .prepare(
        `SELECT sequence_kind, seq_start, seq_end, summary_event_id
           FROM retention_ranges WHERE run_id = ? AND sequence_kind = 'rowid' ORDER BY seq_start`,
      )
      .all(String(row.run_id)) as {
      sequence_kind: 'rowid';
      seq_start: number;
      seq_end: number;
      summary_event_id: string | null;
    }[];
    const summaryEventIds = ranges.flatMap((range) =>
      range.summary_event_id ? [range.summary_event_id] : [],
    );
    return {
      sequenceKind: 'rowid',
      projectId: String(row.project_id),
      cutoff: iso(row.cutoff),
      policy,
      policyVersion: RETENTION_POLICY_VERSION,
      allowlist: [...RETENTION_ALLOWLIST],
      batchLimit: number(row.batch_limit),
      eligibleRows: number(row.eligible_count),
      eligiblePayloadBytes: number(row.eligible_payload_bytes),
      selectedRows: number(row.selected_count),
      selectedPayloadBytes: number(row.payload_bytes),
      remainingAfterBatch: Math.max(0, number(row.eligible_count) - number(row.selected_count)),
      exclusions: {
        protectedCoordination: number(row.protected_coordination),
        protectedUnknown: number(row.protected_unknown),
        protectedOrNonAllowlisted: number(row.protected_other),
        protectedReceipts: number(row.protected_receipts),
        tooNew: number(row.too_new),
      },
      pendingOutboxExclusions: number(row.pending_outbox_exclusions),
      summaryCount: number(row.summary_count),
      rangeCount: ranges.length,
      ranges: ranges.map((range) => ({
        sequenceKind: 'rowid',
        seqStart: range.seq_start,
        seqEnd: range.seq_end,
      })),
      fingerprint: String(row.fingerprint),
      generatedAt: iso(row.completed_at),
      measurements: this.byteMetrics(number(row.payload_bytes)),
      dryRun: false,
      runId: String(row.run_id),
      committed: true,
      committedAt: iso(row.completed_at),
      idempotent,
      summaryEventIds,
    };
  }

  apply(input: RetentionApplyInput): LocalRetentionResult {
    if (input.confirm !== true) {
      throw new RetentionError('validation', 'explicit confirm=true is required', 400);
    }
    if (!input.runId || typeof input.runId !== 'string') {
      throw new RetentionError('validation', 'runId is required', 400);
    }
    const policy = validateRetentionPolicy(input.policy);
    if (input.cutoff !== policy.cutoff) {
      throw new RetentionError('validation', 'cutoff must exactly match policy.cutoff', 400);
    }
    if (this.projectId && input.projectId && input.projectId !== this.projectId) {
      throw new RetentionError('validation', 'projectId does not match this daemon', 400);
    }
    const prior = this.existingRun(input.runId);
    if (prior) {
      if (prior.fingerprint !== input.fingerprint || iso(prior.cutoff) !== policy.cutoff) {
        throw new RetentionError(
          'run_conflict',
          'runId was already used for another selection',
          409,
        );
      }
      return this.resultForRun(prior, true);
    }

    const applyTx = this.store.db.transaction(() => {
      // SQLite's write transaction serializes selection, evidence and deletion.
      const selected = this.selectCandidates(policy);
      const candidates = selected.map((row) => this.candidate(row));
      const fingerprint = retentionSelectionFingerprint({
        sequenceKind: 'rowid',
        projectId: this.projectId,
        policy,
        candidates,
      });
      if (fingerprint !== input.fingerprint) {
        throw new RetentionError('stale_preview', 'retention preview is stale; preview again', 409);
      }
      const counts = this.exclusions(policy);
      const now = new Date().toISOString();
      const sequenceRanges = splitRetentionRanges(
        'rowid',
        candidates.map((candidate) => candidate.sequence),
      );
      const summaryEventIds: string[] = [];
      const payloadBytes = candidates.reduce(
        (total, candidate) => total + candidate.payloadBytes,
        0,
      );

      // Summaries are inserted before deletion. Besides being atomic evidence,
      // the final synthetic row preserves SQLite's max-rowid resume high-water
      // mark even when the old maximum-rowid event is compacted.
      for (const range of sequenceRanges) {
        const rangeRows = selected.filter(
          (row) => row.rowid >= range.seqStart && row.rowid <= range.seqEnd,
        );
        const typeCounts: Record<string, number> = {};
        for (const row of rangeRows) typeCounts[row.type] = (typeCounts[row.type] ?? 0) + 1;
        const summaryEventId = ulid();
        summaryEventIds.push(summaryEventId);
        const projectId = rangeRows[0]?.project_id ?? this.projectId ?? '';
        const summaryPayload = {
          seq_start: range.seqStart,
          seq_end: range.seqEnd,
          dropped_types: Object.keys(typeCounts),
          reason: 'manual_retention',
          run_id: input.runId,
          sequence_kind: 'rowid',
          selected_count: rangeRows.length,
          type_counts: typeCounts,
          raw_payload_recoverable: false,
        };
        const summary: EventEnvelope = {
          v: PROTOCOL_VERSION,
          event_id: summaryEventId,
          device_id: this.summaryDeviceId,
          project_id: projectId,
          ts: now,
          type: 'summary.compacted',
          actor: { system: 'weft-retention' },
          privacy: 'metadata',
          payload: summaryPayload,
        };
        const stored: StoredLocalEvent = { ...summary, received_at: now };
        this.store.insertEvents([stored], false);
        const rangeBytes = rangeRows.reduce((total, row) => total + row.payload_bytes, 0);
        this.store.db
          .prepare(
            `INSERT INTO event_summaries
               (project_id, session_id, window_start, window_end, group_key, template_id, params, event_ids,
                summary_kind, event_id, run_id, sequence_kind, seq_start, seq_end,
                type_counts_json, payload_bytes, event_digest, created_at)
             VALUES (?, NULL, ?, ?, ?, 'retention.v1', ?, ?, 'retention_range', ?, ?, 'rowid', ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            projectId,
            policy.cutoff,
            policy.cutoff,
            `retention:${input.runId}:${range.seqStart}-${range.seqEnd}`,
            JSON.stringify(summaryPayload),
            JSON.stringify(rangeRows.map((row) => row.event_id)),
            summaryEventId,
            input.runId,
            range.seqStart,
            range.seqEnd,
            JSON.stringify(typeCounts),
            rangeBytes,
            sha256(canonicalJson(summary)),
            now,
          );
      }

      const receipt = this.store.db.prepare(
        `INSERT INTO event_receipts
           (event_id, device_id, project_id, original_rowid, received_at, event_type,
            payload_bytes, event_digest, run_id, summary_event_id, compacted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const rangeEvidence = this.store.db.prepare(
        `INSERT INTO retention_ranges
           (project_id, run_id, sequence_kind, seq_start, seq_end, summary_event_id,
            selected_count, payload_bytes, type_counts_json)
         VALUES (?, ?, 'rowid', ?, ?, ?, ?, ?, ?)`,
      );
      for (const [index, row] of selected.entries()) {
        const rangeIndex = sequenceRanges.findIndex(
          (range) => row.rowid >= range.seqStart && row.rowid <= range.seqEnd,
        );
        receipt.run(
          row.event_id,
          row.device_id,
          row.project_id,
          row.rowid,
          row.received_at,
          row.type,
          row.payload_bytes,
          candidates[index]!.digest,
          input.runId,
          summaryEventIds[rangeIndex]!,
          now,
        );
      }
      for (const [index, range] of sequenceRanges.entries()) {
        const rangeRows = selected.filter(
          (row) => row.rowid >= range.seqStart && row.rowid <= range.seqEnd,
        );
        const typeCounts: Record<string, number> = {};
        for (const row of rangeRows) typeCounts[row.type] = (typeCounts[row.type] ?? 0) + 1;
        rangeEvidence.run(
          rangeRows[0]?.project_id ?? this.projectId ?? '',
          input.runId,
          range.seqStart,
          range.seqEnd,
          summaryEventIds[index]!,
          rangeRows.length,
          rangeRows.reduce((total, row) => total + row.payload_bytes, 0),
          JSON.stringify(typeCounts),
        );
      }
      this.store.db
        .prepare(
          `INSERT INTO retention_runs
             (run_id, project_id, kind, state, policy_json, fingerprint, cutoff, batch_limit,
              eligible_count, eligible_payload_bytes, protected_coordination, protected_unknown,
              protected_other, protected_receipts, too_new, pending_outbox_exclusions,
              selected_count, payload_bytes, range_count, summary_count, started_at, completed_at)
           VALUES (?, ?, 'manual', 'completed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.runId,
          this.projectId ?? selected[0]?.project_id ?? '',
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
          counts.pendingOutboxExclusions,
          selected.length,
          payloadBytes,
          sequenceRanges.length,
          summaryEventIds.length,
          now,
          now,
        );
      if (selected.length > 0) {
        const placeholders = selected.map(() => '?').join(',');
        const rowids = selected.map((row) => row.rowid);
        const deleted = this.store.db
          .prepare(`DELETE FROM events WHERE rowid IN (${placeholders})`)
          .run(rowids).changes;
        const remaining = this.store.db
          .prepare(`SELECT COUNT(*) AS c FROM events WHERE rowid IN (${placeholders})`)
          .get(rowids) as { c: number };
        if (deleted !== selected.length || remaining.c !== 0) {
          throw new Error('local retention deletion verification failed');
        }
      }
      return {
        selected,
        candidates,
        fingerprint,
        counts,
        sequenceRanges,
        summaryEventIds,
        payloadBytes,
        now,
      };
    });

    const committed = applyTx();
    try {
      this.onCommit?.();
    } catch (err) {
      // The DB transaction is already durable. Wake/notification failures are
      // reported honestly and can never turn a committed apply into a failure.
      this.logger?.warn(
        { err, runId: input.runId },
        'retention committed; post-commit wake failed',
      );
    }
    return {
      sequenceKind: 'rowid',
      projectId: this.projectId,
      cutoff: policy.cutoff,
      policy,
      policyVersion: RETENTION_POLICY_VERSION,
      allowlist: [...RETENTION_ALLOWLIST],
      dryRun: false,
      batchLimit: policy.batchLimit,
      eligibleRows: committed.counts.eligibleRows,
      eligiblePayloadBytes: committed.counts.eligiblePayloadBytes,
      selectedRows: committed.selected.length,
      selectedPayloadBytes: committed.payloadBytes,
      remainingAfterBatch: Math.max(0, committed.counts.eligibleRows - committed.selected.length),
      exclusions: committed.counts.exclusions,
      pendingOutboxExclusions: committed.counts.pendingOutboxExclusions,
      summaryCount: committed.sequenceRanges.length,
      rangeCount: committed.sequenceRanges.length,
      ranges: committed.sequenceRanges,
      fingerprint: committed.fingerprint,
      generatedAt: committed.now,
      measurements: this.byteMetrics(committed.payloadBytes),
      runId: input.runId,
      committed: true,
      committedAt: committed.now,
      idempotent: false,
      summaryEventIds: committed.summaryEventIds,
    };
  }

  status(outbox?: OutboxPressure): LocalRetentionStatus {
    const project = this.projectClause();
    const one = (sql: string, params: unknown[] = []): number =>
      number((this.store.db.prepare(sql).get(...params) as { c: number }).c);
    const last = this.store.db
      .prepare(
        `SELECT run_id, completed_at, selected_count FROM retention_runs
          WHERE kind = 'manual' ${this.projectId ? 'AND project_id = ?' : ''}
          ORDER BY completed_at DESC LIMIT 1`,
      )
      .get(...(this.projectId ? [this.projectId] : [])) as
      { run_id: string; completed_at: string; selected_count: number } | undefined;
    return {
      policyVersion: RETENTION_POLICY_VERSION,
      allowlist: [...RETENTION_ALLOWLIST],
      defaultTelemetryDays: this.telemetryDays,
      batchLimit: this.batchLimit,
      scheduler: {
        enabled: this.schedulerEnabled,
        running: this.timer !== null,
        destructiveApply: false,
        lastPreviewAt: this.lastPreviewAt,
        nextRunAt: this.nextRunAt,
      },
      exactCounts: {
        events: one(`SELECT COUNT(*) AS c FROM events e WHERE 1=1 ${project.sql}`, project.params),
        coordinationEvents: one(
          `SELECT COUNT(*) AS c FROM coordination_events c WHERE 1=1 ${this.projectId ? 'AND c.project_id = ?' : ''}`,
          this.projectId ? [this.projectId] : [],
        ),
        receipts: one(
          `SELECT COUNT(*) AS c FROM event_receipts r ${this.projectId ? 'WHERE r.project_id = ?' : ''}`,
          this.projectId ? [this.projectId] : [],
        ),
        summaries: one(
          `SELECT COUNT(*) AS c FROM event_summaries s ${this.projectId ? 'WHERE s.project_id = ?' : ''}`,
          this.projectId ? [this.projectId] : [],
        ),
        ranges: one(
          `SELECT COUNT(*) AS c FROM retention_ranges r ${this.projectId ? 'WHERE r.project_id = ?' : ''}`,
          this.projectId ? [this.projectId] : [],
        ),
        completedRuns: one(
          `SELECT COUNT(*) AS c FROM retention_runs r WHERE r.state = 'completed' ${this.projectId ? 'AND r.project_id = ?' : ''}`,
          this.projectId ? [this.projectId] : [],
        ),
      },
      lastRun: last
        ? { runId: last.run_id, completedAt: last.completed_at, selectedCount: last.selected_count }
        : null,
      outbox: outbox ?? this.store.outboxPressure(),
      partitions: null,
      byteMetrics: this.byteMetrics(),
      limitations: [
        'Raw payload recovery is not claimed.',
        'Physical disk reclamation is not claimed; SQLite does not VACUUM in this slice.',
        'Git worktrees, WIP refs, quarantines, reflogs and uncommitted work are untouched.',
        'The in-memory pipeline buffer is not bounded.',
      ],
    };
  }

  /** Optional non-destructive preview scheduler. It can never call apply(). */
  start(): void {
    if (this.timer || !this.schedulerEnabled) return;
    const tick = (): void => {
      try {
        this.preview();
        this.lastPreviewAt = new Date().toISOString();
      } catch (err) {
        this.logger?.warn({ err }, 'scheduled retention preview failed');
      }
      this.nextRunAt = new Date(Date.now() + this.intervalMs).toISOString();
    };
    tick();
    this.timer = setInterval(tick, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.nextRunAt = null;
  }
}
