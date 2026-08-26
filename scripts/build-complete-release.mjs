/**
 * Build every supported distribution format and assemble one audited release.
 *
 * On Windows this is the one-command customer release build:
 *   npm run package:complete
 *
 * MSI creation is Windows-only, so the complete build fails closed elsewhere.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeSourceFingerprint, createBuildProvenance } from './build-release-package.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = JSON.parse(
  await import('node:fs/promises').then(fs => fs.readFile(path.join(ROOT, 'package.json'), 'utf8'))
).version;
if (VERSION !== '1.0.1') {
  throw new Error(`Complete release build failed: package version must be 1.0.1, received ${VERSION}`);
}
const STARTED_AT = Date.now();
const IS_WINDOWS = process.platform === 'win32';
const npm = IS_WINDOWS ? 'npm.cmd' : 'npm';
const npx = IS_WINDOWS ? 'npx.cmd' : 'npx';
const PROVENANCE_PATH = path.join(ROOT, 'BUILD-PROVENANCE.json');
const BUILD_MARKER = path.join(ROOT, 'dist', '.complete-release-build.json');

function fail(message) {
  throw new Error(`Complete release build failed: ${message}`);
}

function run(command, args) {
  console.log(`\n[complete-release] ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: 'inherit',
    env: process.env,
    shell: IS_WINDOWS && /\.(?:cmd|bat)$/i.test(command),
  });
  if (result.error) fail(`${command}: ${result.error.message}`);
  if (result.status !== 0) fail(`${command} exited with code ${result.status}`);
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function newestFile(directories, extension) {
  const matches = directories.flatMap(directory => walk(directory))
    .filter(file => file.toLowerCase().endsWith(extension));
  return matches.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}

function assertFresh(file, label) {
  if (!file || !existsSync(file)) fail(`${label} was not produced`);
  if (statSync(file).mtimeMs < STARTED_AT - 2000) {
    fail(`${label} is stale: ${path.relative(ROOT, file)}`);
  }
}

function assertReleaseIdentity() {
  const rootPackage = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const electronPackage = JSON.parse(readFileSync(path.join(ROOT, 'electron', 'package.json'), 'utf8'));
  const tauriConfig = JSON.parse(readFileSync(path.join(ROOT, 'src-tauri', 'tauri.conf.json'), 'utf8'));
  for (const [label, value] of [
    ['root package version', rootPackage.version],
    ['Electron package version', electronPackage.version],
    ['Tauri package version', tauriConfig.version],
  ]) {
    if (value !== VERSION) fail(`${label} must be ${VERSION}, received ${String(value)}`);
  }
  if (rootPackage.license !== 'UNLICENSED' || electronPackage.license !== 'UNLICENSED') {
    fail('root and Electron package licenses must both be UNLICENSED');
  }
  const installerBuilder = readFileSync(path.join(ROOT, 'scripts', 'build-windows-installer.mjs'), 'utf8');
  if (!installerBuilder.includes('PROPRIETARY AND CONFIDENTIAL') ||
      !installerBuilder.includes('UNLICENSED')) {
    fail('Windows installer license text must identify BESSForge as proprietary and UNLICENSED');
  }
}

async function main() {
  if (!IS_WINDOWS) fail('Tauri MSI creation requires Windows. Run the included Windows workflow.');
  assertReleaseIdentity();
  const provenance = createBuildProvenance();
  if (provenance.sourceFingerprint !== computeSourceFingerprint()) {
    fail('independent current-source fingerprint computations disagree');
  }
  writeFileSync(PROVENANCE_PATH, `${JSON.stringify(provenance, null, 2)}\n`);
  mkdirSync(path.dirname(BUILD_MARKER), { recursive: true });
  writeFileSync(BUILD_MARKER, `${JSON.stringify({
    schema: 'eci-complete-release-build/v1',
    startedAt: STARTED_AT,
    sourceFingerprint: provenance.sourceFingerprint,
  }, null, 2)}\n`);

  for (const output of [
    'dist/installer',
    'dist/installer-build',
    'dist/portable',
    'dist/release',
    'dist/release-stage',
    'dist/source-stage',
    'dist/native-installer-audit',
    'src-tauri/target/release/bundle',
    'src-tauri/target/x86_64-pc-windows-msvc/release/bundle',
  ]) {
    rmSync(path.join(ROOT, output), { recursive: true, force: true });
  }
  if (existsSync(path.join(ROOT, 'dist', 'static'))) {
    for (const file of readdirSync(path.join(ROOT, 'dist', 'static'))) {
      if (file.toLowerCase().endsWith('.zip')) {
        rmSync(path.join(ROOT, 'dist', 'static', file), { force: true });
      }
    }
  }

  run(npm, ['run', 'lint']);
  run(npm, ['run', 'check']);
  run(npm, ['audit', '--audit-level=moderate']);
  // Sanitized rebuild source excludes customer-uploaded KMZ fixtures. Its
  // documented clean-room gate is the deterministic synthetic release subset.
  run(npm, ['run', 'test:release']);
  run(npm, ['run', 'build:static']);
  run(npm, ['ci', '--prefix', 'electron']);
  run(npm, ['audit', '--prefix', 'electron', '--audit-level=moderate']);

  // Tauri regenerates files under src-tauri/gen during its build. Build it
  // first, then rebuild every other format so all artifacts are newer than
  // the final curated source state used by the release freshness gate.
  run(npx, ['tauri', 'build', '--ci']);
  const targetRoots = [
    path.join(ROOT, 'src-tauri', 'target', 'release', 'bundle'),
    path.join(ROOT, 'src-tauri', 'target', 'x86_64-pc-windows-msvc', 'release', 'bundle'),
  ];
  const tauriMsi = newestFile(targetRoots.map(root => path.join(root, 'msi')), '.msi');
  const tauriNsis = newestFile(targetRoots.map(root => path.join(root, 'nsis')), '.exe');
  assertFresh(tauriMsi, 'Tauri MSI installer');
  assertFresh(tauriNsis, 'Tauri NSIS installer');

  run(npx, ['tsx', 'scripts/package-static.ts']);
  run(process.execPath, ['scripts/build-windows-installer.mjs', '--skip-build']);

  const electron = path.join(ROOT, 'dist', 'installer', `BESSForge-Setup-${VERSION}.exe`);
  const portable = path.join(ROOT, 'dist', 'portable', `BESSForge_Portable_${VERSION}_Windows_x64.zip`);
  const staticZip = path.join(ROOT, 'dist', 'static', `BESSForge_Static_${VERSION}_Windows_x64.zip`);
  assertFresh(electron, 'Electron installer');
  assertFresh(portable, 'portable Windows package');
  assertFresh(staticZip, 'static/self-hosting package');

  run(process.execPath, [
    'scripts/build-release-package.mjs',
  ]);
  const release = path.join(ROOT, 'dist', 'release', `BESSForge_Complete_Release_${VERSION}.zip`);
  assertFresh(release, 'complete release ZIP');
  run(process.execPath, [
    'scripts/audit-release.mjs',
    release,
    '--report',
    `${release}.audit.json`,
  ]);
  assertFresh(`${release}.audit.json`, 'complete release recursive audit report');
  console.log(`\n[complete-release] Ready: ${path.relative(ROOT, release)}`);
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});