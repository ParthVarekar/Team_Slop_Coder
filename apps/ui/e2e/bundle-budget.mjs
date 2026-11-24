import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const assets = join(root, 'apps', 'ui', 'dist', 'assets');
const html = readFileSync(join(root, 'apps', 'ui', 'dist', 'index.html'), 'utf8');
const budget = Number(process.env.WEFT_UI_GZIP_BUDGET ?? 307200);
const initial = new Set();
for (const match of html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)) initial.add(match[1]);
for (const match of html.matchAll(/<link\b[^>]*rel="modulepreload"[^>]*\bhref="([^"]+)"/g))
  initial.add(match[1]);

const files = [...initial].map((url) => {
  const name = url.replace(/^\//, '');
  const path = join(root, 'apps', 'ui', 'dist', name);
  assert.ok(statSync(path).isFile(), `initial asset missing: ${name}`);
  return { name, gzipBytes: gzipSync(readFileSync(path)).length };
});
const total = files.reduce((sum, file) => sum + file.gzipBytes, 0);
const lazy = readdirSync(assets)
  .filter((name) => name.endsWith('.js'))
  .map((name) => name.replace(/^\//, ''))
  .filter((name) => !initial.has(name) && !initial.has(`/${name}`));
const artifact = {
  timestamp: new Date().toISOString(),
  benchmark: 'ui_initial_js_gzip',
  budgetBytes: budget,
  initialGzipBytes: total,
  initialFiles: files,
  lazyChunkCount: lazy.length,
  scope:
    'scripts and modulepreload assets in built index.html; excludes CSS, images, fonts and lazy chunks',
  passed: total <= budget,
};
writeFileSync(
  join(
    root,
    'bench',
    'artifacts',
    'runs',
    `ui-bundle-${artifact.timestamp.replace(/[:.]/g, '-')}.json`,
  ),
  JSON.stringify(artifact, null, 2),
);
console.log(JSON.stringify(artifact, null, 2));
assert.ok(total <= budget, `initial JS ${total} bytes exceeds ${budget}-byte gzip budget`);
console.log('UI bundle budget gate: PASS');
