import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  diffSymbols,
  intersection,
  modificationIdentity,
  normalizeSignature,
  symbolIdentity,
  type DiffSymbol,
} from './symbol-diff.js';

function sym(partial: Partial<DiffSymbol> & { name: string }): DiffSymbol {
  return {
    kind: 'function',
    container: '',
    signature: `${partial.name}(): void`,
    content_hash: 'hash-' + partial.name,
    start_line: 1,
    ...partial,
  };
}

describe('normalizeSignature', () => {
  it('collapses whitespace and trims', () => {
    expect(normalizeSignature('  foo( x: number,   y?: string ):  boolean ')).toBe(
      'foo( x: number, y?: string ): boolean',
    );
  });

  it('is idempotent (property)', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const once = normalizeSignature(s);
        expect(normalizeSignature(once)).toBe(once);
      }),
    );
  });
});

describe('symbolIdentity', () => {
  it('excludes line numbers so a shifted symbol keeps identity', () => {
    expect(symbolIdentity('a.ts', 'function', '', 'foo')).toBe(
      symbolIdentity('a.ts', 'function', '', 'foo'),
    );
    expect(symbolIdentity('a.ts', 'function', 'C', 'foo')).not.toBe(
      symbolIdentity('a.ts', 'function', '', 'foo'),
    );
  });
});

describe('diffSymbols', () => {
  it('returns nothing for identical snapshots', () => {
    const s = [sym({ name: 'foo' }), sym({ name: 'bar', start_line: 5 })];
    expect(diffSymbols('a.ts', s, s)).toEqual([]);
  });

  it('classifies a body-only edit as body, not signature', () => {
    const base = [sym({ name: 'foo', content_hash: 'h1' })];
    const branch = [sym({ name: 'foo', content_hash: 'h2' })];
    const mods = diffSymbols('a.ts', base, branch);
    expect(mods).toHaveLength(1);
    expect(mods[0]?.change_kind).toBe('body');
    expect(mods[0]?.old_signature).toBe(mods[0]?.new_signature);
  });

  it('classifies a signature edit as signature', () => {
    const base = [sym({ name: 'foo', signature: 'foo(x: number): void' })];
    const branch = [sym({ name: 'foo', signature: 'foo(x: string): void' })];
    const mods = diffSymbols('a.ts', base, branch);
    expect(mods[0]?.change_kind).toBe('signature');
    expect(mods[0]?.old_signature).toBe('foo(x: number): void');
    expect(mods[0]?.new_signature).toBe('foo(x: string): void');
  });

  it('detects added and removed symbols', () => {
    const base = [sym({ name: 'gone' })];
    const branch = [sym({ name: 'fresh' })];
    const mods = diffSymbols('a.ts', base, branch);
    const byName = new Map(mods.map((m) => [m.name, m.change_kind]));
    expect(byName.get('gone')).toBe('removed');
    expect(byName.get('fresh')).toBe('added');
  });

  it('matches a symbol whose lines shifted but content is unchanged', () => {
    const base = [sym({ name: 'foo', start_line: 10, content_hash: 'h' })];
    const branch = [sym({ name: 'foo', start_line: 40, content_hash: 'h' })];
    expect(diffSymbols('a.ts', base, branch)).toEqual([]);
  });

  it('inserting a symbol above only reports the addition', () => {
    const base = [sym({ name: 'foo', start_line: 1, content_hash: 'h' })];
    const branch = [
      sym({ name: 'newTop', start_line: 1 }),
      sym({ name: 'foo', start_line: 8, content_hash: 'h' }),
    ];
    const mods = diffSymbols('a.ts', base, branch);
    expect(mods).toHaveLength(1);
    expect(mods[0]?.name).toBe('newTop');
    expect(mods[0]?.change_kind).toBe('added');
  });

  it('pairs overloads positionally by start line', () => {
    const base = [
      sym({ name: 'f', signature: 'f(x: number): void', start_line: 1, content_hash: 'a' }),
      sym({ name: 'f', signature: 'f(x: string): void', start_line: 5, content_hash: 'b' }),
    ];
    const branch = [
      sym({ name: 'f', signature: 'f(x: number): void', start_line: 1, content_hash: 'a2' }),
      sym({ name: 'f', signature: 'f(x: string): void', start_line: 5, content_hash: 'b' }),
    ];
    const mods = diffSymbols('a.ts', base, branch);
    expect(mods).toHaveLength(1);
    expect(mods[0]?.change_kind).toBe('body');
    expect(mods[0]?.old_hash).toBe('a');
  });

  it('is deterministic regardless of input order', () => {
    const base = [sym({ name: 'b' }), sym({ name: 'a' })];
    const branch = [sym({ name: 'a', content_hash: 'x' }), sym({ name: 'c' })];
    const m1 = diffSymbols('a.ts', base, branch);
    const m2 = diffSymbols('a.ts', [...base].reverse(), [...branch].reverse());
    expect(m1).toEqual(m2);
  });

  it('self-diff is always empty (property)', () => {
    const arb = fc.array(
      fc.record({
        name: fc.stringMatching(/^[a-z][a-z0-9]{0,5}$/),
        kind: fc.constantFrom('function', 'class', 'method', 'variable'),
        container: fc.constantFrom('', 'C'),
        signature: fc.string(),
        content_hash: fc.hexaString({ minLength: 4, maxLength: 8 }),
        start_line: fc.integer({ min: 1, max: 500 }),
      }),
      { maxLength: 12 },
    );
    fc.assert(
      fc.property(arb, (symbols) => {
        expect(diffSymbols('a.ts', symbols, symbols)).toEqual([]);
      }),
    );
  });

  it('a pure hash change is always body, never signature (property)', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z][a-z0-9]{0,5}$/),
        fc.string(),
        fc.hexaString({ minLength: 4, maxLength: 8 }),
        fc.hexaString({ minLength: 4, maxLength: 8 }),
        (name, signature, h1, h2) => {
          fc.pre(h1 !== h2);
          const base = [sym({ name, signature, content_hash: h1 })];
          const branch = [sym({ name, signature, content_hash: h2 })];
          const mods = diffSymbols('a.ts', base, branch);
          expect(mods).toHaveLength(1);
          expect(mods[0]?.change_kind).toBe('body');
        },
      ),
    );
  });
});

describe('intersection (overlap math)', () => {
  it('is commutative and sorted', () => {
    const a = new Set(['k3', 'k1', 'k2']);
    const b = new Set(['k2', 'k4', 'k3']);
    expect(intersection(a, b)).toEqual(['k2', 'k3']);
    expect(intersection(b, a)).toEqual(['k2', 'k3']);
  });

  it('self-intersection equals the sorted set', () => {
    const a = new Set(['b', 'a']);
    expect(intersection(a, a)).toEqual(['a', 'b']);
  });

  it('disjoint sets intersect to empty', () => {
    expect(intersection(new Set(['a']), new Set(['b']))).toEqual([]);
  });

  it('commutativity + subset laws (property)', () => {
    const arbSet = fc
      .array(fc.stringMatching(/^[a-z0-9]{1,4}$/), { maxLength: 20 })
      .map((arr) => new Set(arr));
    fc.assert(
      fc.property(arbSet, arbSet, (a, b) => {
        const ab = intersection(a, b);
        const ba = intersection(b, a);
        expect(ab).toEqual(ba);
        expect(ab).toEqual([...ab].sort());
        for (const k of ab) {
          expect(a.has(k)).toBe(true);
          expect(b.has(k)).toBe(true);
        }
      }),
    );
  });

  it('modificationIdentity round-trips through symbolIdentity', () => {
    const base = [sym({ name: 'foo', content_hash: 'h1' })];
    const branch = [sym({ name: 'foo', content_hash: 'h2' })];
    const mod = diffSymbols('a.ts', base, branch)[0];
    expect(mod).toBeDefined();
    if (mod) {
      expect(modificationIdentity(mod)).toBe(
        symbolIdentity('a.ts', mod.kind, mod.container, mod.name),
      );
    }
  });
});
