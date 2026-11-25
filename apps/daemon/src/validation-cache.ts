import type { SqliteDatabase } from '@weft/core';
import type { CheckEvidence, ValidationRunState } from './validation.js';

export const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export interface CacheKey {
  inputHash: string;
  toolchainFingerprint: string;
}

export interface CachePutInput extends CacheKey {
  repoId: string;
  treeOid: string;
  state: ValidationRunState;
  checks: CheckEvidence[];
}

export interface CacheEntry extends CacheKey {
  repo_id: string;
  tree_oid: string;
  state: ValidationRunState;
  checks: CheckEvidence[];
  cached_at: string;
  expires_at: string;
  quarantined: boolean;
}

interface CacheRow {
  input_hash: string;
  toolchain_fingerprint: string;
  repo_id: string;
  tree_oid: string;
  state: string;
  checks_json: string;
  cached_at: string;
  expires_at: string;
  quarantined: number;
}

export interface ValidationCacheOptions {
  ttlMs?: number | undefined;
  /** Injectable clock (ms) for deterministic TTL tests. */
  now?: (() => number) | undefined;
}

/**
 * Reuses a passing validation result only for the exact input (tree + check
 * config, captured by input_hash) AND the same toolchain fingerprint, until TTL
 * expiry. A different fingerprint or tree is a different key → miss (no false
 * reuse across toolchain upgrades or content changes). A flake quarantine marks
 * a key distrusted: once an identical input fails, its cached pass can no longer
 * mask the failure. Only 'passed' results are ever served from cache.
 */
export class ValidationCache {
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(
    private readonly db: SqliteDatabase,
    options: ValidationCacheOptions = {},
  ) {
    this.ttlMs = options.ttlMs ?? DEFAULT_CACHE_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  get(key: CacheKey): CacheEntry | null {
    const row = this.db
      .prepare(`SELECT * FROM validation_cache WHERE input_hash = ? AND toolchain_fingerprint = ?`)
      .get(key.inputHash, key.toolchainFingerprint) as CacheRow | undefined;
    if (!row) return null;
    if (row.quarantined !== 0) return null;
    if (row.state !== 'passed') return null;
    if (Date.parse(row.expires_at) <= this.now()) return null;
    return {
      inputHash: row.input_hash,
      toolchainFingerprint: row.toolchain_fingerprint,
      repo_id: row.repo_id,
      tree_oid: row.tree_oid,
      state: row.state as ValidationRunState,
      checks: JSON.parse(row.checks_json) as CheckEvidence[],
      cached_at: row.cached_at,
      expires_at: row.expires_at,
      quarantined: false,
    };
  }

  put(input: CachePutInput): void {
    const now = this.now();
    const cachedAt = new Date(now).toISOString();
    const expiresAt = new Date(now + this.ttlMs).toISOString();
    this.db
      .prepare(
        `INSERT INTO validation_cache
           (input_hash, toolchain_fingerprint, repo_id, tree_oid, state, checks_json,
            cached_at, expires_at, quarantined)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
         ON CONFLICT (input_hash, toolchain_fingerprint) DO UPDATE SET
           repo_id = excluded.repo_id, tree_oid = excluded.tree_oid, state = excluded.state,
           checks_json = excluded.checks_json, cached_at = excluded.cached_at,
           expires_at = excluded.expires_at, quarantined = 0`,
      )
      .run(
        input.inputHash,
        input.toolchainFingerprint,
        input.repoId,
        input.treeOid,
        input.state,
        JSON.stringify(input.checks),
        cachedAt,
        expiresAt,
      );
  }

  /**
   * Distrust a key after a failure (flake quarantine). Invalidates any cached pass
   * immediately; a tombstone is written even when no pass was cached so a later
   * identical failure keeps the key distrusted until a fresh pass re-establishes it.
   */
  quarantine(key: CacheKey): void {
    const now = this.now();
    const updated = this.db
      .prepare(
        `UPDATE validation_cache SET quarantined = 1 WHERE input_hash = ? AND toolchain_fingerprint = ?`,
      )
      .run(key.inputHash, key.toolchainFingerprint);
    if (updated.changes === 0) {
      const at = new Date(now).toISOString();
      this.db
        .prepare(
          `INSERT INTO validation_cache
             (input_hash, toolchain_fingerprint, repo_id, tree_oid, state, checks_json,
              cached_at, expires_at, quarantined)
           VALUES (?, ?, '', '', 'failed', '[]', ?, ?, 1)
           ON CONFLICT (input_hash, toolchain_fingerprint) DO UPDATE SET quarantined = 1`,
        )
        .run(key.inputHash, key.toolchainFingerprint, at, new Date(now + this.ttlMs).toISOString());
    }
  }
}
