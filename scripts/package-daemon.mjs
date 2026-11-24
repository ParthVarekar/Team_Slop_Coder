import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const daemonDir = join(root, 'apps', 'daemon');
const outputDir = join(root, 'dist', 'packages');
const pnpmCli = process.env.npm_execpath;
if (!pnpmCli) throw new Error('Run this script with: pnpm package:daemon');

const readManifest = (dir) => JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
const cloneManifest = (manifest) => JSON.parse(JSON.stringify(manifest));
const daemon = readManifest(daemonDir);
const workspace = new Map();
for (const group of ['packages', 'adapters']) {
  for (const entry of readdirSync(join(root, group), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, group, entry.name);
    if (!existsSync(join(dir, 'package.json'))) continue;
    const manifest = readManifest(dir);
    workspace.set(manifest.name, { dir, manifest });
  }
}

const stage = mkdtempSync(join(tmpdir(), 'weft-daemon-pack-'));
const copied = new Set();
const manifest = cloneManifest(daemon);
delete manifest.private;
delete manifest.scripts.build;
delete manifest.scripts.dev;

// npm does not install the external dependencies of bundled packages. Keep
// those dependencies on the daemon itself so a clean npm install resolves them.
function hoistRuntimeDependencies(source) {
  for (const section of ['dependencies', 'optionalDependencies']) {
    for (const [dependency, range] of Object.entries(source[section] ?? {})) {
      if (range.startsWith('workspace:')) continue;
      for (const target of ['dependencies', 'optionalDependencies']) {
        const existing = manifest[target]?.[dependency];
        if (existing === undefined) continue;
        if (target !== section || existing !== range) {
          throw new Error(`Conflicting runtime dependency ${dependency}: ${existing} vs ${range}`);
        }
      }
      if (!manifest[section]) manifest[section] = {};
      manifest[section][dependency] = range;
    }
  }
}

function copyWorkspacePackage(name) {
  if (copied.has(name)) return;
  const source = workspace.get(name);
  if (!source) throw new Error(`Unknown workspace dependency: ${name}`);
  copied.add(name);

  const bundledManifest = cloneManifest(source.manifest);
  hoistRuntimeDependencies(bundledManifest);
  delete bundledManifest.private;
  delete bundledManifest.devDependencies;
  delete bundledManifest.scripts;
  for (const section of ['dependencies', 'optionalDependencies']) {
    for (const [dependency, range] of Object.entries(bundledManifest[section] ?? {})) {
      if (range.startsWith('workspace:')) continue;
      delete bundledManifest[section][dependency];
    }
    if (Object.keys(bundledManifest[section] ?? {}).length === 0) delete bundledManifest[section];
  }
  const bundled = [];
  for (const section of ['dependencies', 'optionalDependencies']) {
    for (const dependency of Object.keys(bundledManifest[section] ?? {})) {
      const target = workspace.get(dependency);
      if (!target) throw new Error(`Unknown workspace dependency: ${dependency}`);
      bundledManifest[section][dependency] = target.manifest.version;
      bundled.push(dependency);
      copyWorkspacePackage(dependency);
    }
  }
  if (bundled.length > 0) bundledManifest.bundleDependencies = bundled;
  if (JSON.stringify(bundledManifest).includes('workspace:')) {
    throw new Error(`Unresolved workspace dependency in ${name}`);
  }

  const destination = join(stage, 'node_modules', ...name.split('/'));
  mkdirSync(destination, { recursive: true });
  cpSync(join(source.dir, 'dist'), join(destination, 'dist'), { recursive: true });
  writeFileSync(join(destination, 'package.json'), `${JSON.stringify(bundledManifest, null, 2)}\n`);
}

try {
  const bundled = [];
  for (const section of ['dependencies', 'optionalDependencies']) {
    for (const [dependency, range] of Object.entries(manifest[section] ?? {})) {
      if (!range.startsWith('workspace:')) continue;
      const target = workspace.get(dependency);
      if (!target) throw new Error(`Unknown workspace dependency: ${dependency}`);
      manifest[section][dependency] = target.manifest.version;
      bundled.push(dependency);
      copyWorkspacePackage(dependency);
    }
  }
  manifest.bundleDependencies = bundled;
  if (JSON.stringify(manifest).includes('workspace:')) {
    throw new Error('Unresolved workspace dependency in @weft/daemon');
  }

  mkdirSync(outputDir, { recursive: true });
  cpSync(join(daemonDir, 'dist'), join(stage, 'dist'), { recursive: true });
  cpSync(join(root, 'README.md'), join(stage, 'README.md'));
  writeFileSync(join(stage, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  const packed = spawnSync(
    process.execPath,
    [pnpmCli, '--config.node-linker=hoisted', 'pack', '--pack-destination', outputDir, '--json'],
    { cwd: stage, encoding: 'utf8' },
  );
  if (packed.status !== 0) {
    process.stderr.write(packed.stderr || packed.stdout || 'pnpm pack failed\n');
    throw new Error(`pnpm pack exited with status ${packed.status ?? 'unknown'}`);
  }
  const archive = JSON.parse(packed.stdout);
  process.stdout.write(
    `Packed ${archive.name}@${archive.version}: ${archive.filename} (${archive.files.length} files)\n`,
  );
} finally {
  rmSync(stage, { recursive: true, force: true });
}
