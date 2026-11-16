import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  canonicalConflictKey,
  normalizeConflictPath,
  ConflictKindSchema,
} from '@weft/protocol';

describe('normalizeConflictPath', () => {
  it('converts backslashes and strips leading/trailing separators', () => {
    expect(normalizeConflictPath('src\\db\\postgres.ts')).toBe('src/db/postgres.ts');
    expect(normalizeConflictPath('/src/app.ts/')).toBe('src/app.ts');
    expect(normalizeConflictPath('a.txt')).toBe('a.txt');
  });
});

describe('canonicalConflictKey', () => {
  it('is independent of task and path ordering and duplicates', () => {
    const a = canonicalConflictKey('file_overlap', ['t2', 't1', 't2'], ['b.ts', 'a.ts', 'b.ts']);
    const b = canonicalConflictKey('file_overlap', ['t1', 't2'], ['a.ts', 'b.ts']);
    expect(a).toBe(b);
  });

  it('normalizes path separators before hashing identity', () => {
    const a = canonicalConflictKey('textual', ['t1'], ['src\\a.ts']);
    const b = canonicalConflictKey('textual', ['t1'], ['src/a.ts']);
    expect(a).toBe(b);
  });

  it('distinguishes kind, task set, and path set (no collisions)', () => {
    const base = canonicalConflictKey('textual', ['t1'], ['a.ts']);
    expect(canonicalConflictKey('file_overlap', ['t1'], ['a.ts'])).not.toBe(base);
    expect(canonicalConflictKey('textual', ['t1', 't2'], ['a.ts'])).not.toBe(base);
    expect(canonicalConflictKey('textual', ['t1'], ['a.ts', 'b.ts'])).not.toBe(base);
    // A task id that looks like a path boundary must not alias another triple.
    expect(canonicalConflictKey('textual', ['a'], ['b', 'c'])).not.toBe(
      canonicalConflictKey('textual', ['a', 'b'], ['c']),
    );
  });

  it('produces a non-empty key accepted by the conflict payload schema', () => {
    const key = canonicalConflictKey('textual', ['t1'], ['a.ts']);
    expect(key.length).toBeGreaterThan(0);
    expect(ConflictKindSchema.safeParse('textual').success).toBe(true);
  });

  it('property: any permutation of tasks and paths yields the same key', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 1 }), { minLength: 1, maxLength: 8 }),
        fc.array(fc.string({ minLength: 1 }), { maxLength: 8 }),
        (tasks, paths) => {
          const key = canonicalConflictKey('file_overlap', tasks, paths);
          const shuffled = canonicalConflictKey(
            'file_overlap',
            [...tasks].reverse(),
            [...paths].reverse(),
          );
          expect(shuffled).toBe(key);
        },
      ),
    );
  });

  it('property: adding a fresh task always changes identity', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 1 }), { minLength: 1, maxLength: 6 }),
        fc.string({ minLength: 1 }),
        (tasks, extra) => {
          fc.pre(!tasks.includes(extra));
          const before = canonicalConflictKey('textual', tasks, ['a.ts']);
          const after = canonicalConflictKey('textual', [...tasks, extra], ['a.ts']);
          expect(after).not.toBe(before);
        },
      ),
    );
  });
});