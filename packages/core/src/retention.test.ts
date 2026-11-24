import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  DEFAULT_RETENTION_BATCH_LIMIT,
  RETENTION_ALLOWLIST,
  RETENTION_POLICY_VERSION,
  RetentionError,
  isRetentionTelemetryType,
  makeRetentionPolicy,
  retentionSelectionFingerprint,
  splitRetentionRanges,
  validateRetentionPolicy,
  type RetentionCandidate,
} from './retention.js';

const CUTOFF = '2026-10-01T00:00:00.000Z';

function candidate(sequence: number, type = 'tool.post'): RetentionCandidate {
  return {
    eventId: `evt_${sequence}`,
    deviceId: 'dev_test',
    sequence,
    type,
    receivedAt: '2026-09-01T00:00:00.000Z',
    payloadBytes: 12,
    digest: 'a'.repeat(64),
  };
}

describe('retention policy', () => {
  it('uses the fixed positive allowlist and safe defaults', () => {
    const policy = makeRetentionPolicy(CUTOFF);
    expect(policy).toEqual({
      version: RETENTION_POLICY_VERSION,
      cutoff: CUTOFF,
      batchLimit: DEFAULT_RETENTION_BATCH_LIMIT,
      allowlist: RETENTION_ALLOWLIST,
    });
    expect(RETENTION_ALLOWLIST).toHaveLength(8);
  });

  it('excludes every unknown, coordination, evidence and summary type', () => {
    for (const type of RETENTION_ALLOWLIST) expect(isRetentionTelemetryType(type)).toBe(true);
    for (const type of [
      'future.telemetry',
      'unknown',
      'task.created',
      'validation.completed',
      'check.completed',
      'commit.created',
      'health.regression',
      'notification.created',
      'file.changed',
      'symbols.changed',
      'branch.updated',
      'worktree.created',
      'summary.compacted',
    ]) {
      expect(isRetentionTelemetryType(type)).toBe(false);
    }
  });

  it('rejects policy widening, narrowing, bad cutoffs and unbounded batches', () => {
    const base = makeRetentionPolicy(CUTOFF, 10);
    for (const policy of [
      { ...base, version: 'v2' },
      { ...base, cutoff: '2026-10-01' },
      { ...base, cutoff: 'not-a-date' },
      { ...base, batchLimit: 0 },
      { ...base, batchLimit: 1001 },
      { ...base, batchLimit: 1.5 },
      { ...base, allowlist: [...RETENTION_ALLOWLIST, 'future.telemetry'] },
      { ...base, allowlist: RETENTION_ALLOWLIST.slice(1) },
    ]) {
      expect(() => validateRetentionPolicy(policy)).toThrow(RetentionError);
    }
  });
});

describe('retention fingerprint', () => {
  it('is deterministic and binds the exact ordered selection and policy', () => {
    const policy = makeRetentionPolicy(CUTOFF, 2);
    const input = {
      sequenceKind: 'global_seq' as const,
      projectId: 'proj_a',
      policy,
      candidates: [candidate(4), candidate(7)],
    };
    const first = retentionSelectionFingerprint(input);
    expect(retentionSelectionFingerprint(input)).toBe(first);
    expect(
      retentionSelectionFingerprint({ ...input, candidates: [...input.candidates].reverse() }),
    ).not.toBe(first);
    expect(retentionSelectionFingerprint({ ...input, candidates: [candidate(4)] })).not.toBe(first);
    expect(
      retentionSelectionFingerprint({
        ...input,
        policy: makeRetentionPolicy('2026-09-01T00:00:00Z', 2),
      }),
    ).not.toBe(first);
    expect(
      retentionSelectionFingerprint({ ...input, candidates: [candidate(4, 'future.telemetry')] }),
    ).not.toBe(first);
  });
});

describe('exact retention ranges', () => {
  it('splits only contiguous selected sequences and never fills protected gaps', () => {
    expect(splitRetentionRanges('global_seq', [8, 2, 3, 7, 10, 11])).toEqual([
      { sequenceKind: 'global_seq', seqStart: 2, seqEnd: 3 },
      { sequenceKind: 'global_seq', seqStart: 7, seqEnd: 8 },
      { sequenceKind: 'global_seq', seqStart: 10, seqEnd: 11 },
    ]);
    expect(splitRetentionRanges('rowid', [])).toEqual([]);
  });

  it('rejects duplicate and invalid sequences', () => {
    expect(() => splitRetentionRanges('rowid', [1, 1])).toThrow(RetentionError);
    expect(() => splitRetentionRanges('outbox_id', [-1])).toThrow(RetentionError);
    expect(() => splitRetentionRanges('global_seq', [1.2])).toThrow(RetentionError);
  });

  it('property: ranges are sorted, maximal, disjoint and reconstruct the exact set', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.integer({ min: 1, max: 500 }), { maxLength: 100 }),
        (values) => {
          const ranges = splitRetentionRanges('rowid', values);
          const reconstructed: number[] = [];
          for (let i = 0; i < ranges.length; i++) {
            const range = ranges[i]!;
            expect(range.sequenceKind).toBe('rowid');
            if (i > 0) expect(range.seqStart).toBeGreaterThan(ranges[i - 1]!.seqEnd + 1);
            for (let seq = range.seqStart; seq <= range.seqEnd; seq++) reconstructed.push(seq);
          }
          expect(reconstructed).toEqual([...values].sort((a, b) => a - b));
        },
      ),
      { numRuns: 100 },
    );
  });
});
