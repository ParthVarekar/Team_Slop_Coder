import { createHash } from 'node:crypto';

/** A commit landed since the last healthy baseline — a candidate regression cause. */
export interface SuspectChange {
  oid: string;
  subject: string;
  author_name: string;
  /** ISO timestamp; used only as a deterministic tiebreak. */
  authored_at: string;
  paths: string[];
  task_id?: string | undefined;
}

/** A check that passed at the baseline but now fails, with the paths it exercises. */
export interface FailingCheck {
  check_id: string;
  /** Files/modules implicated by the failure (test file + its dependency closure). */
  paths: string[];
}

export interface RankedSuspect {
  rank: number;
  oid: string;
  task_id: string | null;
  subject: string;
  author_name: string;
  /** Number of implicated paths this change touched (primary signal). */
  overlap: number;
  matched_paths: string[];
  score: number;
}

export interface AttributionInput {
  changes: SuspectChange[];
  failingChecks: FailingCheck[];
}

/**
 * Stable fingerprint of a failure: the sorted, deduped set of failing check ids.
 * Two runs failing the same checks share a fingerprint, so a regression is
 * recorded once rather than per run.
 */
export function failureFingerprint(failingCheckIds: string[]): string {
  const unique = [...new Set(failingCheckIds)].sort();
  return createHash('sha256').update(unique.join('\u0000')).digest('hex').slice(0, 32);
}

/**
 * Rank changes-since-healthy by how strongly each implicates the failing checks.
 * Primary signal is path overlap: a change touching the module a failing check
 * exercises is the prime suspect. Recency breaks ties (later commits favored),
 * then oid for full determinism. Pure — no git, no I/O, no clock — so the same
 * input always yields the same ranking and the sweep is cheap enough to run on
 * every regression. Confirmation (revert-test) is a separate, git-level step.
 */
export function rankSuspects(input: AttributionInput): RankedSuspect[] {
  const implicated = new Set<string>();
  for (const check of input.failingChecks) for (const p of check.paths) implicated.add(p);

  const ordered = [...input.changes].sort((a, b) => {
    const t = Date.parse(a.authored_at) - Date.parse(b.authored_at);
    return t !== 0 ? t : a.oid < b.oid ? -1 : a.oid > b.oid ? 1 : 0;
  });
  const recencyRank = new Map<string, number>();
  ordered.forEach((c, i) => recencyRank.set(c.oid, i));

  const scored = input.changes.map((change) => {
    const matched = change.paths.filter((p) => implicated.has(p));
    const overlap = matched.length;
    const recency = recencyRank.get(change.oid) ?? 0;
    // Overlap dominates; recency only separates changes with equal overlap.
    const score = overlap * 1_000_000 + recency;
    return { change, matched, overlap, score };
  });

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.change.oid < b.change.oid ? -1 : a.change.oid > b.change.oid ? 1 : 0;
  });

  return scored.map((s, i) => ({
    rank: i + 1,
    oid: s.change.oid,
    task_id: s.change.task_id ?? null,
    subject: s.change.subject,
    author_name: s.change.author_name,
    overlap: s.overlap,
    matched_paths: s.matched,
    score: s.score,
  }));
}
