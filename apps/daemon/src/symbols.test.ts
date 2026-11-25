import { describe, expect, it } from 'vitest';
import { extractSymbols, type ExtractedSymbol } from './symbols.js';

const FIXTURE = `import { helper } from './util';
import * as ns from './ns';

export function greet(name: string, loud?: boolean): string {
  return helper(name);
}

export const add = (a: number, b: number): number => a + b;

export class Calculator {
  private value: number = 0;
  constructor(seed: number) {
    this.value = seed;
  }
  add(x: number): number {
    return helper(this.value + x);
  }
  get current(): number {
    return this.value;
  }
}

export interface Shape {
  area(): number;
}

export type ID = string | number;

export enum Color {
  Red,
  Green,
}

const internal = 42;
`;

function byName(symbols: ExtractedSymbol[], name: string, container = ''): ExtractedSymbol {
  const found = symbols.find((s) => s.name === name && s.container === container);
  if (!found) throw new Error(`symbol not found: ${container ? container + '.' : ''}${name}`);
  return found;
}

describe('extractSymbols golden fixtures', () => {
  const { symbols, edges } = extractSymbols('sample.ts', FIXTURE);

  it('extracts every declaration kind with normalized signatures', () => {
    expect(byName(symbols, 'greet')).toMatchObject({
      kind: 'function',
      container: '',
      signature: 'greet(name: string, loud?: boolean): string',
      exported: true,
    });
    expect(byName(symbols, 'add')).toMatchObject({
      kind: 'variable',
      signature: 'add(a: number, b: number): number',
      exported: true,
    });
    expect(byName(symbols, 'Calculator')).toMatchObject({
      kind: 'class',
      signature: 'class Calculator',
      exported: true,
    });
    expect(byName(symbols, 'Shape')).toMatchObject({
      kind: 'interface',
      signature: 'interface Shape',
    });
    expect(byName(symbols, 'ID')).toMatchObject({
      kind: 'type',
      signature: 'type ID = string | number',
    });
    expect(byName(symbols, 'Color')).toMatchObject({ kind: 'enum', signature: 'enum Color' });
    expect(byName(symbols, 'internal')).toMatchObject({ kind: 'variable', exported: false });
  });

  it('scopes class members to their container and captures methods/accessors/constructor', () => {
    expect(byName(symbols, 'value', 'Calculator')).toMatchObject({
      kind: 'property',
      signature: 'value: number',
    });
    expect(byName(symbols, 'constructor', 'Calculator')).toMatchObject({
      kind: 'method',
      signature: 'constructor(seed: number)',
    });
    expect(byName(symbols, 'add', 'Calculator')).toMatchObject({
      kind: 'method',
      signature: 'add(x: number): number',
    });
    expect(byName(symbols, 'current', 'Calculator')).toMatchObject({
      kind: 'method',
      signature: 'current(): number',
    });
    expect(byName(symbols, 'area', 'Shape')).toMatchObject({
      kind: 'method',
      signature: 'area(): number',
    });
  });

  it('records 1-based line ranges and byte offsets within the file', () => {
    const greet = byName(symbols, 'greet');
    expect(greet.start_line).toBe(4);
    expect(greet.end_line).toBe(6);
    expect(greet.start_byte).toBe(FIXTURE.indexOf('export function greet'));
    expect(greet.end_byte).toBeGreaterThan(greet.start_byte);
  });

  it('captures import edges with module specifiers', () => {
    const imports = edges.filter((e) => e.kind === 'imports');
    expect(imports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          to_name: 'helper',
          module_specifier: './util',
          from_symbol: '<module>',
        }),
        expect.objectContaining({ to_name: '* as ns', module_specifier: './ns' }),
      ]),
    );
  });

  it('attributes call edges to the enclosing symbol', () => {
    const calls = edges.filter((e) => e.kind === 'calls');
    expect(calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from_symbol: 'greet', to_name: 'helper' }),
        expect.objectContaining({ from_symbol: 'add', to_name: 'helper' }),
      ]),
    );
    // The class method `add` calls helper; the top-level arrow `add` does not.
    const methodCalls = calls.filter((c) => c.from_symbol === 'add');
    expect(methodCalls).toHaveLength(1);
  });

  it('is deterministic: identical input yields identical output and hashes', () => {
    const again = extractSymbols('sample.ts', FIXTURE);
    expect(again).toEqual({ symbols, edges });
  });

  it('changes content_hash but not signature when only the body changes', () => {
    const a = extractSymbols('f.ts', 'export function f(x: number): number {\n  return x;\n}\n');
    const b = extractSymbols(
      'f.ts',
      'export function f(x: number): number {\n  return x + 1;\n}\n',
    );
    expect(byName(a.symbols, 'f').signature).toBe(byName(b.symbols, 'f').signature);
    expect(byName(a.symbols, 'f').content_hash).not.toBe(byName(b.symbols, 'f').content_hash);
  });

  it('normalizes whitespace in signatures', () => {
    const spaced = extractSymbols(
      'f.ts',
      'export function f( x : number ,  y?:string ) :  boolean { return true; }',
    );
    expect(byName(spaced.symbols, 'f').signature).toBe('f(x: number, y?: string): boolean');
  });
});

describe('extractSymbols JS/JSX handling', () => {
  it('parses plain JS without type annotations', () => {
    const { symbols } = extractSymbols(
      'm.js',
      'export function run(a, b) { return a + b; }\nconst x = 1;',
    );
    expect(byName(symbols, 'run')).toMatchObject({
      kind: 'function',
      signature: 'run(a, b)',
      exported: true,
    });
    expect(byName(symbols, 'x')).toMatchObject({ kind: 'variable', exported: false });
  });

  it('parses JSX/TSX components', () => {
    const { symbols } = extractSymbols(
      'c.tsx',
      'export const App = () => <div className="x">hi</div>;',
    );
    expect(byName(symbols, 'App')).toMatchObject({ kind: 'variable', exported: true });
  });

  it('handles rest and optional parameters', () => {
    const { symbols } = extractSymbols(
      'r.ts',
      'export function f(a: string, ...rest: number[]): void {}',
    );
    expect(byName(symbols, 'f').signature).toBe('f(a: string, ...rest: number[]): void');
  });

  it('returns empty results for an empty file', () => {
    expect(extractSymbols('empty.ts', '')).toEqual({ symbols: [], edges: [] });
  });
});
