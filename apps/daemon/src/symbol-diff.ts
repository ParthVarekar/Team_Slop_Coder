/**
 * Pure symbol snapshot diffing (L1). Compares the indexed symbols of one file on
 * two branches and classifies each change as added / removed / signature / body.
 * Identity is (kind, container, name) — deliberately NOT start_line — so a body
 * edit that shifts lines below still matches the same symbol instead of looking
 * like a removal + addition. Signatures are compared in canonical normalized form.
 * No git, no IO, no TypeScript program: deterministic and property-testable.
 */

export type SymbolChangeKind = 'added' | 'removed' | 'signature' | 'body';

/** Minimal structural shape satisfied by both ExtractedSymbol and StoredSymbol. */
export interface DiffSymbol {
  name: string;
  kind: string;
  container: string;
  signature: string;
  content_hash: string;
  start_line: number;
}

export interface SymbolModification {
  file_path: string;
  name: string;
  kind: string;
  container: string;
  change_kind: SymbolChangeKind;
  old_signature: string | null;
  new_signature: string | null;
  old_hash: string | null;
  new_hash: string | null;
  start_line: number;
}

/** Canonical signature form: collapse runs of whitespace, trim. Idempotent. */
export function normalizeSignature(signature: string): string {
  return signature.replace(/\s+/g, ' ').trim();
}

const SEP = String.fromCharCode(0);

/** Stable cross-branch identity of a symbol within a file (excludes line numbers). */
export function symbolIdentity(
  filePath: string,
  kind: string,
  container: string,
  name: string,
): string {
  return [filePath, kind, container, name].join(SEP);
}

export function modificationIdentity(m: SymbolModification): string {
  return symbolIdentity(m.file_path, m.kind, m.container, m.name);
}

/** Sorted intersection of two key sets — the core overlap math (commutative). */
export function intersection(a: ReadonlySet<string>, b: ReadonlySet<string>): string[] {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  const out: string[] = [];
  for (const key of small) if (large.has(key)) out.push(key);
  return out.sort();
}

function groupKey(s: DiffSymbol): string {
  return [s.kind, s.container, s.name].join(SEP);
}

function group(symbols: readonly DiffSymbol[]): Map<string, DiffSymbol[]> {
  const map = new Map<string, DiffSymbol[]>();
  for (const s of symbols) {
    const key = groupKey(s);
    const bucket = map.get(key);
    if (bucket) bucket.push(s);
    else map.set(key, [s]);
  }
  for (const bucket of map.values()) bucket.sort((x, y) => x.start_line - y.start_line);
  return map;
}

/**
 * Diff one file's symbols between a base snapshot and a branch snapshot. Overloads
 * (same kind/container/name) are paired positionally by start line. Returns only
 * actual modifications, ordered deterministically by identity then change kind.
 */
export function diffSymbols(
  filePath: string,
  base: readonly DiffSymbol[],
  branch: readonly DiffSymbol[],
): SymbolModification[] {
  const baseGroups = group(base);
  const branchGroups = group(branch);
  const keys = new Set([...baseGroups.keys(), ...branchGroups.keys()]);
  const mods: SymbolModification[] = [];

  for (const key of keys) {
    const old = baseGroups.get(key) ?? [];
    const next = branchGroups.get(key) ?? [];
    const pairs = Math.max(old.length, next.length);
    for (let i = 0; i < pairs; i++) {
      const b = old[i];
      const n = next[i];
      if (b && n) {
        const sigOld = normalizeSignature(b.signature);
        const sigNew = normalizeSignature(n.signature);
        let change: SymbolChangeKind | null = null;
        if (sigOld !== sigNew) change = 'signature';
        else if (b.content_hash !== n.content_hash) change = 'body';
        if (!change) continue;
        mods.push({
          file_path: filePath,
          name: n.name,
          kind: n.kind,
          container: n.container,
          change_kind: change,
          old_signature: sigOld,
          new_signature: sigNew,
          old_hash: b.content_hash,
          new_hash: n.content_hash,
          start_line: n.start_line,
        });
      } else if (n) {
        mods.push({
          file_path: filePath,
          name: n.name,
          kind: n.kind,
          container: n.container,
          change_kind: 'added',
          old_signature: null,
          new_signature: normalizeSignature(n.signature),
          old_hash: null,
          new_hash: n.content_hash,
          start_line: n.start_line,
        });
      } else if (b) {
        mods.push({
          file_path: filePath,
          name: b.name,
          kind: b.kind,
          container: b.container,
          change_kind: 'removed',
          old_signature: normalizeSignature(b.signature),
          new_signature: null,
          old_hash: b.content_hash,
          new_hash: null,
          start_line: b.start_line,
        });
      }
    }
  }

  mods.sort(
    (x, y) =>
      modificationIdentity(x).localeCompare(modificationIdentity(y)) ||
      x.change_kind.localeCompare(y.change_kind) ||
      x.start_line - y.start_line,
  );
  return mods;
}
