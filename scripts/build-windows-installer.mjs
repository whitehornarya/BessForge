/**
 * Build the BESSForge Windows installer.
 *
 * Produces a self-contained Setup executable and a portable Windows ZIP:
 *   dist/installer/BESSForge-Setup-<version>.exe
 *   dist/portable/BESSForge_Portable_<version>_Windows_x64.zip
 *
 * Steps:
 *   1. build the static web bundle (unless --skip-build)
 *   2. unpack the Windows Electron runtime
 *   3. stage the payload (runtime + app resources)
 *   4. compile the NSIS script against that payload
 *
 * Runs on Linux (native `makensis`) and on Windows (NSIS install). Set
 * MAKENSIS to point at a specific compiler binary.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VERSION = PKG.version;

const BUILD_DIR = path.join(ROOT, 'dist', 'installer-build');
const PAYLOAD_DIR = path.join(BUILD_DIR, 'payload');
const OUT_DIR = path.join(ROOT, 'dist', 'installer');
const OUT_FILE = path.join(OUT_DIR, `BESSForge-Setup-${VERSION}.exe`);
const PORTABLE_DIR = path.join(ROOT, 'dist', 'portable');
const PORTABLE_ROOT = `BESSForge_Portable_${VERSION}_Windows_x64`;
const PORTABLE_FILE = path.join(PORTABLE_DIR, `${PORTABLE_ROOT}.zip`);
const NSI_SCRIPT = path.join(ROOT, 'build', 'installer', 'bessforge.nsi');
const ELECTRON_VERSION = JSON.parse(
  readFileSync(path.join(ROOT, 'electron', 'package.json'), 'utf8')
).devDependencies.electron.replace(/^[^\d]*/, '');
const DESKTOP_API_BUNDLE = path.join(ROOT, 'dist', 'desktop-api.cjs');
const DESKTOP_CONFIG = `${JSON.stringify({
  apiBase: 'http://127.0.0.1:53117',
}, null, 2)}\n`;

const args = new Set(process.argv.slice(2));

function log(message) {
  console.log(`[installer] ${message}`);
}

function die(message) {
  console.error(`\n[installer] FAILED: ${message}\n`);
  process.exit(1);
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, { stdio: 'inherit', cwd: ROOT, ...options });
  if (result.error) die(`${command}: ${result.error.message}`);
  if (result.status !== 0) die(`${command} exited with code ${result.status}`);
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

async function extractZip(archive, destination) {
  const zip = await JSZip.loadAsync(readFileSync(archive));
  const root = path.resolve(destination);
  for (const [name, entry] of Object.entries(zip.files)) {
    const target = path.resolve(destination, name);
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
      die(`runtime archive contains an unsafe path: ${name}`);
    }
    if (entry.dir) {
      mkdirSync(target, { recursive: true });
      continue;
    }
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, Buffer.from(await entry.async('uint8array')));
  }
}

/** Locate an NSIS compiler on this machine. */
function findMakensis() {
  if (process.env.MAKENSIS) return process.env.MAKENSIS;

  const candidates = ['makensis'];
  if (process.platform === 'win32') {
    candidates.push(
      path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'NSIS', 'makensis.exe'),
      path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'NSIS', 'makensis.exe')
    );
  }
  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ['-VERSION'], { stdio: 'pipe' });
      return candidate;
    } catch {
      // try the next candidate
    }
  }

  // Nix store fallback (this workspace ships NSIS without putting it on PATH).
  try {
    const store = '/nix/store';
    const hit = readdirSync(store)
      .filter(name => /^[a-z0-9]+-nsis-[\d.]+$/.test(name))
      .map(name => path.join(store, name, 'bin', 'makensis'))
      .find(existsSync);
    if (hit) return hit;
  } catch {
    // not a nix machine
  }

  die(
    'NSIS compiler not found.\n' +
    '  Windows: install NSIS (https://nsis.sourceforge.io) or `winget install NSIS.NSIS`\n' +
    '  Linux:   install the `nsis` package, or set MAKENSIS=/path/to/makensis'
  );
}

/** Find the cached Windows Electron runtime archive. */
function findElectronZip() {
  const wanted = `electron-v${ELECTRON_VERSION}-win32-x64.zip`;
  const roots = [
    path.join(ROOT, '.cache', 'electron'),
    path.join(process.env.HOME ?? '', '.cache', 'electron'),
    path.join(process.env.LOCALAPPDATA ?? '', 'electron', 'Cache'),
  ].filter(Boolean);

  for (const root of roots) {
    if (!existsSync(root)) continue;
    const direct = path.join(root, wanted);
    if (existsSync(direct)) return direct;
    for (const name of readdirSync(root)) {
      const nested = path.join(root, name, wanted);
      if (existsSync(nested)) return nested;
    }
  }
  die(
    `Windows Electron runtime not found (${wanted}).\n` +
    '  Run `npx @electron/get --version=' + ELECTRON_VERSION + ' --platform=win32 --arch=x64`\n' +
    '  or place the archive in .cache/electron/.'
  );
}

const LICENSE_TEXT = `BESSForge ${VERSION}
Copyright (c) 2026 ECI Electrical Consultants, Inc. All rights reserved.

PROPRIETARY AND CONFIDENTIAL — UNLICENSED

No right to use, copy, modify, or distribute BESSForge is granted except under
a separate written agreement with ECI Electrical Consultants, Inc.

Bundled third-party components remain subject to their own license notices.
Those notices do not license BESSForge.
`;

// ------------------------------------------------------------------ build
log(`BESSForge ${VERSION} — Windows installer`);

const makensis = findMakensis();
log(`NSIS compiler: ${makensis}`);

if (!args.has('--skip-build')) {
  log('Building the static web bundle...');
  run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build:static']);
}
log('Bundling the local API companion...');
run(process.platform === 'win32' ? 'npx.cmd' : 'npx', [
  '--no-install',
  'esbuild',
  path.join(ROOT, 'server', 'desktop-api.ts'),
  '--bundle',
  '--platform=node',
  '--target=node20',
  '--format=cjs',
  `--outfile=${DESKTOP_API_BUNDLE}`,
]);
run(process.platform === 'win32' ? 'node.exe' : 'node', [path.join('electron', 'copy-app.cjs')]);

const electronZip = findElectronZip();
log(`Electron runtime: ${path.basename(electronZip)}`);

log('Staging the payload...');
rmSync(BUILD_DIR, { recursive: true, force: true });
mkdirSync(PAYLOAD_DIR, { recursive: true });

const runtimeDir = path.join(BUILD_DIR, 'runtime');
mkdirSync(runtimeDir, { recursive: true });
await extractZip(electronZip, runtimeDir);

cpSync(runtimeDir, PAYLOAD_DIR, { recursive: true });
// The default app shows Electron's placeholder window; the real app replaces it.
rmSync(path.join(PAYLOAD_DIR, 'resources', 'default_app.asar'), { force: true });

// Brand the executable.
const stagedExe = path.join(PAYLOAD_DIR, 'BESSForge.exe');
cpSync(path.join(PAYLOAD_DIR, 'electron.exe'), stagedExe);
rmSync(path.join(PAYLOAD_DIR, 'electron.exe'), { force: true });

// Application resources: main process, preload, icon and the web bundle.
const appDir = path.join(PAYLOAD_DIR, 'resources', 'app');
mkdirSync(path.join(appDir, 'build'), { recursive: true });
cpSync(path.join(ROOT, 'electron', 'main.cjs'), path.join(appDir, 'main.cjs'));
cpSync(path.join(ROOT, 'electron', 'preload.cjs'), path.join(appDir, 'preload.cjs'));
cpSync(path.join(ROOT, 'electron', 'token-preload.cjs'), path.join(appDir, 'token-preload.cjs'));
cpSync(path.join(ROOT, 'electron', 'token-setup.html'), path.join(appDir, 'token-setup.html'));
cpSync(path.join(ROOT, 'electron', 'token-setup.js'), path.join(appDir, 'token-setup.js'));
cpSync(path.join(ROOT, 'electron', 'build', 'icon.ico'), path.join(appDir, 'build', 'icon.ico'));
cpSync(path.join(ROOT, 'electron', 'app'), path.join(appDir, 'app'), { recursive: true });
cpSync(DESKTOP_API_BUNDLE, path.join(PAYLOAD_DIR, 'resources', 'desktop-api.cjs'));
const provenanceFile = path.join(ROOT, 'BUILD-PROVENANCE.json');
if (!existsSync(provenanceFile)) die('BUILD-PROVENANCE.json is required; use npm run package:complete');
cpSync(provenanceFile, path.join(PAYLOAD_DIR, 'BUILD-PROVENANCE.json'));
// Kept beside BESSForge.exe so portable users can change endpoints without
// rebuilding. Installed builds also create a writable per-user copy on launch.
writeFileSync(path.join(PAYLOAD_DIR, 'bessforge.config.json'), DESKTOP_CONFIG);

writeFileSync(
  path.join(appDir, 'package.json'),
  `${JSON.stringify({
    name: 'bessforge',
    productName: 'BESSForge',
    version: VERSION,
    private: true,
    description: 'BESSForge — battery energy storage system preliminary design tool',
    author: 'ECI Electrical Consultants, Inc.',
    license: 'UNLICENSED',
    main: 'main.cjs',
  }, null, 2)}\n`
);

const licenseFile = path.join(BUILD_DIR, 'LICENSE.txt');
// NSIS renders the license page with CRLF line endings.
writeFileSync(licenseFile, LICENSE_TEXT.replace(/\r?\n/g, '\r\n'));

const payloadFiles = walk(PAYLOAD_DIR);
const payloadMB = Math.round(
  payloadFiles.reduce((sum, file) => sum + statSync(file).size, 0) / 1024 / 1024
);
for (const required of [
  'BESSForge.exe',
  'resources/app/main.cjs',
  'resources/app/preload.cjs',
  'resources/app/token-preload.cjs',
  'resources/app/token-setup.html',
  'resources/app/token-setup.js',
  'resources/desktop-api.cjs',
  'resources/app/app/index.html',
  'bessforge.config.json',
  'BUILD-PROVENANCE.json',
]) {
  if (!existsSync(path.join(PAYLOAD_DIR, required))) {
    die(`portable/installer payload is missing ${required}`);
  }
}
for (const assetDir of ['fonts', 'geometries', 'models', 'samples', 'sounds', 'textures']) {
  if (!existsSync(path.join(PAYLOAD_DIR, 'resources', 'app', 'app', assetDir))) {
    die(`static payload is missing required asset directory: ${assetDir}`);
  }
}
if (payloadFiles.length < 100 || payloadMB < 150) {
  die(`payload is unexpectedly small (${payloadFiles.length} files, ${payloadMB} MB)`);
}
log(`Payload staged: ${payloadFiles.length} files, ${payloadMB} MB`);

if (!args.has('--skip-portable')) {
  log('Writing the portable Windows package...');
  rmSync(PORTABLE_DIR, { recursive: true, force: true });
  mkdirSync(PORTABLE_DIR, { recursive: true });
  const portableZip = new JSZip();
  for (const file of payloadFiles) {
    const relative = path.relative(PAYLOAD_DIR, file).split(path.sep).join('/');
    portableZip.file(`${PORTABLE_ROOT}/${relative}`, readFileSync(file), { binary: true });
  }
  portableZip.file(
    `${PORTABLE_ROOT}/README.txt`,
    [
      `BESSForge ${VERSION} — Portable Windows x64`,
      '',
      'No installation is required. Extract this entire folder, then run BESSForge.exe.',
      'Keep every file and subfolder together. Windows 10 or newer (64-bit) is required.',
      'Designs and exports remain on the local computer unless you deliberately share them.',
      '',
      'Local API and Cesium: BESSForge starts its bundled loopback API automatically.',
      'On first launch, enter your Cesium ion token in the secure setup window.',
      'Windows encrypts the token for your user; it is not stored in this ZIP or browser files.',
      'To replace it later, run: BESSForge.exe --configure-cesium-token',
      '',
      'API configuration: edit bessforge.config.json beside BESSForge.exe.',
      'Only HTTPS remote endpoints or loopback HTTP endpoints are accepted.',
      'This public endpoint file must never contain credentials or tokens.',
      '',
    ].join('\r\n')
  );
  const portableBuffer = await portableZip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
  writeFileSync(PORTABLE_FILE, portableBuffer);
}
if (!existsSync(PORTABLE_FILE)) die('portable package was not produced');
const portableMB = statSync(PORTABLE_FILE).size / 1024 / 1024;
if (portableMB < 80) {
  die(`portable package is only ${portableMB.toFixed(1)} MB — runtime files are missing`);
}
log(`Portable: ${path.relative(ROOT, PORTABLE_FILE)} (${portableMB.toFixed(1)} MB)`);

log('Compiling the installer...');
mkdirSync(OUT_DIR, { recursive: true });
rmSync(OUT_FILE, { force: true });

const posix = p => p.split(path.sep).join('/');
const payloadGlob = process.platform === 'win32'
  ? `${PAYLOAD_DIR}\\*.*`
  : `${posix(PAYLOAD_DIR)}/*.*`;
run(makensis, [
  '-V2',
  `-DAPP_VERSION=${VERSION}`,
  `-DPAYLOAD_GLOB=${payloadGlob}`,
  `-DLICENSE_FILE=${posix(licenseFile)}`,
  `-DOUT_FILE=${posix(OUT_FILE)}`,
  posix(NSI_SCRIPT),
]);

if (!existsSync(OUT_FILE)) die('the compiler reported success but produced no installer');

const sizeMB = (statSync(OUT_FILE).size / 1024 / 1024).toFixed(1);
// A working installer embeds the whole payload; a stub would be a few hundred KB.
if (Number(sizeMB) < 70) {
  die(`installer is only ${sizeMB} MB — the payload was not embedded. Do not ship this file.`);
}

log('');
log(`Installer: ${path.relative(ROOT, OUT_FILE)}`);
log(`Size:      ${sizeMB} MB`);
log('Done.');
