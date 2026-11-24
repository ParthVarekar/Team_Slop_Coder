import { createHash } from 'node:crypto';

/**
 * M5.4 is deliberately a positive, versioned allowlist. New event types are
 * protected by default; broadening deletion requires a reviewed policy change.
 */
export const RETENTION_POLICY_VERSION = 'retention-allowlist-v1' as const;
export const RETENTION_ALLOWLIST = [
  'prompt.submitted',
  'tool.pre',
  'tool.post',
  'tool.failed',
  'command.executed',
  'session.started',
  'session.status',
  'session.ended',
] as const;

export type RetentionTelemetryType = (typeof RETENTION_ALLOWLIST)[number];
export type RetentionSequenceKind = 'rowid' | 'global_seq' | 'outbox_id';
export const DEFAULT_RETENTION_BATCH_LIMIT = 1000;
export const MAX_RETENTION_BATCH_LIMIT = 1000;

export interface RetentionPolicy {
  readonly version: typeof RETENTION_POLICY_VERSION;
  /** Inclusive server-received cutoff. Client event ts is never consulted. */
  readonly cutoff: string;
  readonly batchLimit: number;
  readonly allowlist: readonly RetentionTelemetryType[];
}

export interface RetentionApplyInput {
  readonly projectId?: string;
  readonly runId: string;
  readonly fingerprint: string;
  readonly cutoff: string;
  readonly policy: RetentionPolicy;
  readonly confirm: true;
}

export interface RetentionCandidate {
  readonly eventId: string;
  readonly deviceId: string;
  readonly sequence: number;
  readonly type: string;
  readonly receivedAt: string;
  readonly payloadBytes: number;
  readonly digest: string;
}

export interface RetentionSequenceRange {
  readonly sequenceKind: RetentionSequenceKind;
  readonly seqStart: number;
  readonly seqEnd: number;
}

export interface RetentionRange extends RetentionSequenceRange {
  readonly runId: string;
  readonly summaryEventId: string | null;
}

export type RetentionErrorCode = 'validation' | 'stale_preview' | 'run_conflict';

export class RetentionError extends Error {
  constructor(
    readonly code: RetentionErrorCode,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'RetentionError';
  }
}

const ALLOWLIST_SET: ReadonlySet<string> = new Set(RETENTION_ALLOWLIST);

/** Unknown, coordination and evidence types fail closed. */
export function isRetentionTelemetryType(type: string): type is RetentionTelemetryType {
  return ALLOWLIST_SET.has(type);
}

function validCutoff(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

export function makeRetentionPolicy(
  cutoff: unknown,
  batchLimit: unknown = DEFAULT_RETENTION_BATCH_LIMIT,
): RetentionPolicy {
  return validateRetentionPolicy({
    version: RETENTION_POLICY_VERSION,
    cutoff,
    batchLimit,
    allowlist: RETENTION_ALLOWLIST,
  });
}

/** Validate the complete client-supplied policy; no implicit widening/defaulting. */
export function validateRetentionPolicy(value: unknown): RetentionPolicy {
  if (!value || typeof value !== 'object') {
    throw new RetentionError('validation', 'retention policy is required', 400);
  }
  const raw = value as Record<string, unknown>;
  if (raw.version !== RETENTION_POLICY_VERSION) {
    throw new RetentionError('validation', 'unsupported retention policy version', 400);
  }
  if (!validCutoff(raw.cutoff)) {
    throw new RetentionError('validation', 'cutoff must be an ISO timestamp with timezone', 400);
  }
  const batchLimit = raw.batchLimit;
  if (
    typeof batchLimit !== 'number' ||
    !Number.isInteger(batchLimit) ||
    batchLimit < 1 ||
    batchLimit > MAX_RETENTION_BATCH_LIMIT
  ) {
    throw new RetentionError(
      'validation',
      `batchLimit must be an integer from 1 to ${MAX_RETENTION_BATCH_LIMIT}`,
      400,
    );
  }
  if (
    !Array.isArray(raw.allowlist) ||
    raw.allowlist.length !== RETENTION_ALLOWLIST.length ||
    raw.allowlist.some((type, index) => type !== RETENTION_ALLOWLIST[index])
  ) {
    throw new RetentionError(
      'validation',
      'allowlist must exactly match the fixed telemetry policy',
      400,
    );
  }
  return {
    version: RETENTION_POLICY_VERSION,
    cutoff: raw.cutoff,
    batchLimit,
    allowlist: [...RETENTION_ALLOWLIST],
  };
}

/** Stable JSON for hashing JSONB/text payloads independent of object key order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Exact UTF-8 byte count of the stored JSON serialization, not a disk estimate. */
export function jsonPayloadBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? 'null', 'utf8');
}

/**
 * Bind a preview to its exact ordered selection and policy. generated_at and
 * aggregate counters are intentionally excluded so they cannot cause false stale
 * previews. Apply must recompute this under its transaction lock.
 */
export function retentionSelectionFingerprint(input: {
  readonly sequenceKind: RetentionSequenceKind;
  readonly projectId: string | null;
  readonly policy: RetentionPolicy;
  readonly candidates: readonly RetentionCandidate[];
}): string {
  return sha256(
    canonicalJson({
      version: RETENTION_POLICY_VERSION,
      sequenceKind: input.sequenceKind,
      projectId: input.projectId,
      cutoff: input.policy.cutoff,
      batchLimit: input.policy.batchLimit,
      allowlist: input.policy.allowlist,
      candidates: input.candidates.map((candidate) => ({
        event_id: candidate.eventId,
        device_id: candidate.deviceId,
        sequence: candidate.sequence,
        type: candidate.type,
        received_at: candidate.receivedAt,
        payload_bytes: candidate.payloadBytes,
        digest: candidate.digest,
      })),
    }),
  );
}

/**
 * Split sorted sequence numbers into maximal exact contiguous ranges. This never
 * fills gaps: protected rows between selected telemetry rows remain explicit.
 */
export function splitRetentionRanges(
  sequenceKind: RetentionSequenceKind,
  sequences: readonly number[],
): RetentionSequenceRange[] {
  const sorted = [...sequences].sort((a, b) => a - b);
  const ranges: RetentionSequenceRange[] = [];
  for (const sequence of sorted) {
    if (!Number.isSafeInteger(sequence) || sequence < 0) {
      throw new RetentionError(
        'validation',
        'retention sequences must be non-negative integers',
        400,
      );
    }
    const previous = ranges.at(-1);
    if (previous && sequence === previous.seqEnd + 1) {
      ranges[ranges.length - 1] = {
        sequenceKind,
        seqStart: previous.seqStart,
        seqEnd: sequence,
      };
    } else if (previous && sequence <= previous.seqEnd) {
      throw new RetentionError('validation', 'retention sequences must be unique', 400);
    } else {
      ranges.push({ sequenceKind, seqStart: sequence, seqEnd: sequence });
    }
  }
  return ranges;
}
