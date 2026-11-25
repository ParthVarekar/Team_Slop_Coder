/**
 * Exact reference resolver worker (M3.3, L2). Runs in a SEPARATE process forked by
 * the daemon so the typed AST (~30x source size) never lives inside the daemon's
 * memory budget. One TypeScript LanguageService per repo root, cached; idle
 * self-eviction; restart on demand by the parent. Pure read-only analysis — it
 * never executes the indexed source. Communicates with the parent over IPC.
 */
import { readFileSync, statSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

interface ResolveRequest {
  id: number;
  type: 'resolve';
  repoRoot: string;
  filePath: string;
  name: string;
  container?: string;
  kind?: string;
  startLine?: number;
}
interface StatsRequest {
  id: number;
  type: 'stats';
}
interface ShutdownRequest {
  id: number;
  type: 'shutdown';
}
type Request = ResolveRequest | StatsRequest | ShutdownRequest;

export interface Reference {
  file_path: string;
  line: number;
  kind: string;
  is_definition: boolean;
  is_write: boolean;
}

const IGNORE = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  '.git',
  '.next',
  'vendor',
]);
const SOURCE_RE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;

const services = new Map<string, ts.LanguageService>();
const idleMs = Number(process.env.WEFT_RESOLVER_IDLE_MS ?? 600_000);
let idleTimer: NodeJS.Timeout | null = null;

function armIdle(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => process.exit(0), idleMs);
}

function send(message: unknown): void {
  if (process.send) process.send(message);
}

function collectSourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (IGNORE.has(entry.name)) continue;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (SOURCE_RE.test(entry.name)) out.push(abs);
    }
  };
  walk(root);
  return out;
}

function readSafe(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

function createService(repoRoot: string): ts.LanguageService {
  const configPath = ts.findConfigFile(repoRoot, ts.sys.fileExists, 'tsconfig.json');
  let fileNames: string[];
  let options: ts.CompilerOptions;
  if (configPath) {
    const cfg = ts.readConfigFile(configPath, ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(cfg.config ?? {}, ts.sys, repoRoot);
    fileNames = parsed.fileNames;
    options = parsed.options;
  } else {
    fileNames = collectSourceFiles(repoRoot);
    options = {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      allowJs: true,
      strict: false,
    };
  }
  options.skipLibCheck = true;
  options.noEmit = true;

  const host: ts.LanguageServiceHost = {
    getScriptFileNames: () => fileNames,
    getScriptVersion: (fn) => {
      try {
        return String(statSync(fn).mtimeMs);
      } catch {
        return '0';
      }
    },
    getScriptSnapshot: (fn) => {
      const text = readSafe(fn);
      return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
    },
    getCurrentDirectory: () => repoRoot,
    getCompilationSettings: () => options,
    getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
  };
  return ts.createLanguageService(host, ts.createDocumentRegistry());
}

function serviceFor(repoRoot: string): ts.LanguageService {
  let svc = services.get(repoRoot);
  if (!svc) {
    svc = createService(repoRoot);
    services.set(repoRoot, svc);
  }
  return svc;
}

/** Locate the name identifier of the declaration matching the symbol identity. */
function findPosition(
  sf: ts.SourceFile,
  name: string,
  container: string,
  kind: string | undefined,
  startLine: number | undefined,
): number | null {
  let best: number | null = null;
  let bestDelta = Infinity;
  const consider = (nameNode: ts.Node, nodeKind: string, nodeContainer: string): void => {
    if (kind && nodeKind !== kind) return;
    if (container && nodeContainer !== container) return;
    const pos = nameNode.getStart(sf);
    const line = sf.getLineAndCharacterOfPosition(pos).line + 1;
    const delta = startLine === undefined ? 0 : Math.abs(line - startLine);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = pos;
    }
  };
  const visit = (node: ts.Node, enclosing: string): void => {
    let nextEnclosing = enclosing;
    if (ts.isFunctionDeclaration(node) && node.name) {
      if (node.name.text === name) consider(node.name, 'function', enclosing);
      nextEnclosing = node.name.text;
    } else if (ts.isClassDeclaration(node) && node.name) {
      if (node.name.text === name) consider(node.name, 'class', enclosing);
      nextEnclosing = node.name.text;
    } else if (ts.isInterfaceDeclaration(node)) {
      if (node.name.text === name) consider(node.name, 'interface', enclosing);
      nextEnclosing = node.name.text;
    } else if (ts.isTypeAliasDeclaration(node)) {
      if (node.name.text === name) consider(node.name, 'type', enclosing);
    } else if (ts.isEnumDeclaration(node)) {
      if (node.name.text === name) consider(node.name, 'enum', enclosing);
      nextEnclosing = node.name.text;
    } else if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) {
      if (node.name.text === name) consider(node.name, 'method', enclosing);
    } else if (ts.isPropertyDeclaration(node) && ts.isIdentifier(node.name)) {
      if (node.name.text === name) consider(node.name, 'property', enclosing);
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      if (node.name.text === name) consider(node.name, 'variable', enclosing);
    }
    ts.forEachChild(node, (child) => visit(child, nextEnclosing));
  };
  ts.forEachChild(sf, (child) => visit(child, ''));
  return best;
}

function handleResolve(req: ResolveRequest): void {
  try {
    const svc = serviceFor(req.repoRoot);
    const program = svc.getProgram();
    const abs = join(req.repoRoot, req.filePath);
    const sf = program?.getSourceFile(abs) ?? program?.getSourceFile(req.filePath);
    if (!program || !sf) {
      send({
        id: req.id,
        ok: true,
        references: [],
        precision: 'exact',
        note: 'file_not_in_program',
      });
      return;
    }
    const position = findPosition(sf, req.name, req.container ?? '', req.kind, req.startLine);
    if (position === null) {
      send({ id: req.id, ok: true, references: [], precision: 'exact', note: 'symbol_not_found' });
      return;
    }
    const found = svc.findReferences(sf.fileName, position);
    const references: Reference[] = [];
    if (found) {
      for (const group of found) {
        const kind = String(group.definition.kind);
        for (const ref of group.references) {
          const refSf = program.getSourceFile(ref.fileName);
          const line = refSf ? refSf.getLineAndCharacterOfPosition(ref.textSpan.start).line + 1 : 0;
          references.push({
            file_path: relative(req.repoRoot, ref.fileName).replace(/\\/g, '/'),
            line,
            kind,
            is_definition: ref.isDefinition === true,
            is_write: ref.isWriteAccess === true,
          });
        }
      }
    }
    references.sort((a, b) => a.file_path.localeCompare(b.file_path) || a.line - b.line);
    send({
      id: req.id,
      ok: true,
      references,
      precision: 'exact',
      rss: process.memoryUsage().rss,
    });
  } catch (err) {
    send({ id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}

process.on('message', (raw: unknown) => {
  const req = raw as Request;
  if (req.type === 'resolve') handleResolve(req);
  else if (req.type === 'stats') {
    const mem = process.memoryUsage();
    send({ id: req.id, ok: true, rss: mem.rss, heapUsed: mem.heapUsed, services: services.size });
  } else if (req.type === 'shutdown') {
    send({ id: req.id, ok: true });
    process.exit(0);
  }
  // Re-arm after completing work so a slow program build is never evicted mid-flight.
  armIdle();
});

process.on('disconnect', () => process.exit(0));
armIdle();
send({ type: 'ready', pid: process.pid });
