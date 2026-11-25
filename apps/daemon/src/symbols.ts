import { createHash } from 'node:crypto';
import ts from 'typescript';

export type SymbolKind =
  'function' | 'class' | 'method' | 'property' | 'interface' | 'type' | 'enum' | 'variable';

export interface ExtractedSymbol {
  name: string;
  kind: SymbolKind;
  /** Enclosing class/interface name; '' for top-level declarations. */
  container: string;
  /** Whitespace-normalized syntactic signature (type-aware resolution is M3.3). */
  signature: string;
  exported: boolean;
  start_line: number;
  end_line: number;
  start_byte: number;
  end_byte: number;
  content_hash: string;
}

export interface ExtractedEdge {
  from_symbol: string;
  to_name: string;
  kind: 'calls' | 'imports';
  module_specifier: string | null;
  line: number;
}

export interface ExtractionResult {
  symbols: ExtractedSymbol[];
  edges: ExtractedEdge[];
}

const hash = (s: string): string => createHash('sha1').update(s).digest('hex');
const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim();

function scriptKindOf(filePath: string): ts.ScriptKind {
  if (filePath.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (filePath.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (/\.(js|mjs|cjs)$/.test(filePath)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function isExported(node: ts.Node): boolean {
  const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

function typeText(node: ts.TypeNode | undefined, sf: ts.SourceFile): string {
  return node ? collapse(node.getText(sf)) : '';
}

function fnSignature(
  name: string,
  params: ts.NodeArray<ts.ParameterDeclaration>,
  retType: ts.TypeNode | undefined,
  sf: ts.SourceFile,
): string {
  const ps = params
    .map((p) => {
      const rest = p.dotDotDotToken ? '...' : '';
      const opt = p.questionToken ? '?' : '';
      const ty = p.type ? `: ${typeText(p.type, sf)}` : '';
      return `${rest}${p.name.getText(sf)}${opt}${ty}`;
    })
    .join(', ');
  const ret = retType ? `: ${typeText(retType, sf)}` : '';
  return `${name}(${ps})${ret}`;
}

function calleeName(expr: ts.LeftHandSideExpression, sf: ts.SourceFile): string | null {
  if (ts.isIdentifier(expr)) return expr.getText(sf);
  if (ts.isPropertyAccessExpression(expr)) return expr.name.getText(sf);
  if (ts.isElementAccessExpression(expr)) return calleeName(expr.expression, sf);
  if (ts.isCallExpression(expr)) return calleeName(expr.expression, sf);
  return null;
}

/**
 * Extract symbols + call/import edges from one TS/JS file using the TypeScript
 * parser (syntactic, no program — fast enough for incremental indexing). Pure:
 * identical input always yields identical output, so content hashing drives
 * git-diff invalidation. Never executes or evaluates the source.
 */
export function extractSymbols(filePath: string, text: string): ExtractionResult {
  const sf = ts.createSourceFile(
    filePath,
    text,
    ts.ScriptTarget.Latest,
    true,
    scriptKindOf(filePath),
  );
  const symbols: ExtractedSymbol[] = [];
  const edges: ExtractedEdge[] = [];
  const lineOf = (pos: number): number => sf.getLineAndCharacterOfPosition(pos).line + 1;

  const add = (
    node: ts.Node,
    name: string,
    kind: SymbolKind,
    container: string,
    signature: string,
    exported: boolean,
  ): void => {
    const start = node.getStart(sf);
    const end = node.getEnd();
    symbols.push({
      name,
      kind,
      container,
      signature,
      exported,
      start_line: lineOf(start),
      end_line: lineOf(end),
      start_byte: start,
      end_byte: end,
      content_hash: hash(node.getText(sf)),
    });
  };

  const walkChildren = (
    node: ts.Node,
    container: string,
    enclosing: string,
    exp: boolean,
  ): void => {
    node.forEachChild((child) => walk(child, container, enclosing, exp));
  };

  function walk(node: ts.Node, container: string, enclosing: string, parentExp: boolean): void {
    if (ts.isFunctionDeclaration(node)) {
      const name = node.name?.getText(sf) ?? 'default';
      const exp = parentExp || isExported(node);
      add(
        node,
        name,
        'function',
        container,
        fnSignature(name, node.parameters, node.type, sf),
        exp,
      );
      if (node.body) walkChildren(node.body, container, name, exp);
      return;
    }
    if (ts.isClassDeclaration(node)) {
      const name = node.name?.getText(sf) ?? 'default';
      const exp = parentExp || isExported(node);
      add(node, name, 'class', container, `class ${name}`, exp);
      for (const member of node.members) walk(member, name, name, exp);
      return;
    }
    if (ts.isMethodDeclaration(node) || ts.isMethodSignature(node)) {
      const name = node.name.getText(sf);
      add(
        node,
        name,
        'method',
        container,
        fnSignature(name, node.parameters, node.type, sf),
        parentExp,
      );
      if (ts.isMethodDeclaration(node) && node.body)
        walkChildren(node.body, container, name, parentExp);
      return;
    }
    if (ts.isConstructorDeclaration(node)) {
      add(
        node,
        'constructor',
        'method',
        container,
        fnSignature('constructor', node.parameters, undefined, sf),
        parentExp,
      );
      if (node.body) walkChildren(node.body, container, 'constructor', parentExp);
      return;
    }
    if (ts.isGetAccessor(node) || ts.isSetAccessor(node)) {
      const name = node.name.getText(sf);
      add(
        node,
        name,
        'method',
        container,
        fnSignature(name, node.parameters, node.type, sf),
        parentExp,
      );
      if (node.body) walkChildren(node.body, container, name, parentExp);
      return;
    }
    if (ts.isPropertyDeclaration(node) || ts.isPropertySignature(node)) {
      const name = node.name.getText(sf);
      const ty = node.type ? `: ${typeText(node.type, sf)}` : '';
      add(node, name, 'property', container, `${name}${ty}`, parentExp);
      if (ts.isPropertyDeclaration(node) && node.initializer) {
        walk(node.initializer, container, name, parentExp);
      }
      return;
    }
    if (ts.isInterfaceDeclaration(node)) {
      const name = node.name.getText(sf);
      const exp = parentExp || isExported(node);
      add(node, name, 'interface', container, `interface ${name}`, exp);
      for (const member of node.members) walk(member, name, name, exp);
      return;
    }
    if (ts.isTypeAliasDeclaration(node)) {
      const name = node.name.getText(sf);
      const exp = parentExp || isExported(node);
      add(node, name, 'type', container, `type ${name} = ${typeText(node.type, sf)}`, exp);
      return;
    }
    if (ts.isEnumDeclaration(node)) {
      const name = node.name.getText(sf);
      const exp = parentExp || isExported(node);
      add(node, name, 'enum', container, `enum ${name}`, exp);
      return;
    }
    if (ts.isVariableStatement(node)) {
      const exp = parentExp || isExported(node);
      for (const decl of node.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name)) continue;
        const name = decl.name.getText(sf);
        const init = decl.initializer;
        const fnLike = init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init));
        const sig = fnLike
          ? fnSignature(name, init.parameters, init.type, sf)
          : `${name}${decl.type ? `: ${typeText(decl.type, sf)}` : ''}`;
        add(decl, name, 'variable', container, sig, exp);
        if (init) walk(init, container, name, exp);
      }
      return;
    }
    if (ts.isImportDeclaration(node)) {
      const spec = ts.isStringLiteral(node.moduleSpecifier)
        ? node.moduleSpecifier.text
        : node.moduleSpecifier.getText(sf);
      const line = lineOf(node.getStart(sf));
      const clause = node.importClause;
      const push = (to: string): void => {
        edges.push({
          from_symbol: '<module>',
          to_name: to,
          kind: 'imports',
          module_specifier: spec,
          line,
        });
      };
      if (clause?.name) push(clause.name.getText(sf));
      const bindings = clause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) push(`* as ${bindings.name.getText(sf)}`);
      else if (bindings && ts.isNamedImports(bindings)) {
        for (const el of bindings.elements) push(el.name.getText(sf));
      }
      if (!clause) push(spec);
      return;
    }
    if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      const spec = ts.isStringLiteral(node.moduleSpecifier)
        ? node.moduleSpecifier.text
        : node.moduleSpecifier.getText(sf);
      edges.push({
        from_symbol: '<module>',
        to_name: spec,
        kind: 'imports',
        module_specifier: spec,
        line: lineOf(node.getStart(sf)),
      });
      return;
    }
    if (ts.isCallExpression(node)) {
      const callee = calleeName(node.expression, sf);
      if (callee) {
        edges.push({
          from_symbol: enclosing || '<module>',
          to_name: callee,
          kind: 'calls',
          module_specifier: null,
          line: lineOf(node.getStart(sf)),
        });
      }
      walkChildren(node, container, enclosing, parentExp);
      return;
    }
    walkChildren(node, container, enclosing, parentExp);
  }

  sf.forEachChild((node) => walk(node, '', '', false));
  return { symbols, edges };
}
