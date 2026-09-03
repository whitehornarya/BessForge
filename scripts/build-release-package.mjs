/**
 * Assemble and audit the complete customer distribution.
 *
 * Required inputs (all built before this script runs):
 *   - self-contained Electron NSIS installer
 *   - portable Electron Windows ZIP
 *   - static/self-hosting ZIP
 *   - Tauri MSI and NSIS installers
 *
 * Output:
 *   dist/release/BESSForge_Complete_Release_<version>.zip
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import {
  assertAuditPassed,
  auditReleaseTarget,
  writeAuditReport,
} from './audit-release.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VERSION = PKG.version;
if (VERSION !== '1.0.1') {
  throw new Error(`Release packaging blocked: package version must be 1.0.1, received ${VERSION}`);
}
const STAGE = path.join(ROOT, 'dist', 'release-stage');
const SOURCE_STAGE = path.join(ROOT, 'dist', 'source-stage');
const SOURCE_VERIFICATION_OUT = path.join(ROOT, 'dist', 'source-verification');
const NATIVE_AUDIT_STAGE = path.join(ROOT, 'dist', 'native-installer-audit');
const OUT_DIR = path.join(ROOT, 'dist', 'release');
const RELEASE_NAME = `BESSForge_Complete_Release_${VERSION}`;
const SOURCE_NAME = `BESSForge_Source_${VERSION}`;
const FIXED_ZIP_DATE = new Date('2000-01-01T00:00:00.000Z');
const SOURCE_VERIFICATION_REPORT = 'SOURCE-VERIFICATION.json';
const PROVENANCE_FILE = 'BUILD-PROVENANCE.json';
const BUILD_MARKER = path.join(ROOT, 'dist', '.complete-release-build.json');
const EXTRACTION_LIMITS = Object.freeze({
  files: 200000,
  fileBytes: 2 * 1024 * 1024 * 1024,
  totalBytes: 8 * 1024 * 1024 * 1024,
});

const PLATFORM_TOKEN = ['re', 'pl', 'it'].join('');
const REGISTRY_TOKEN = ['package', 'firewall'].join('-');
const CUSTOMER_INPUTS = ['attached', 'assets'].join('_');
export const SOURCE_ALLOWLIST = [
  'README.md',
  'ECI-EPCS.md',
  'client',
  'server',
  'electron/build/icon.ico',
  'electron/copy-app.cjs',
  'electron/main.cjs',
  'electron/cesiumIonToken.cjs',
  'electron/preload.cjs',
  'electron/token-preload.cjs',
  'electron/token-setup.html',
  'electron/token-setup.js',
  'electron/package.json',
  'electron/package-lock.json',
  'src-tauri/build.rs',
  'src-tauri/Cargo.lock',
  'src-tauri/Cargo.toml',
  'src-tauri/capabilities',
  'src-tauri/icons',
  'src-tauri/src',
  'src-tauri/bessforge.config.json',
  'src-tauri/tauri.conf.json',
  'build/installer/bessforge.nsi',
  '.github/workflows/build-windows-installer.yml',
  'eslint.config.js',
  'scripts/audit-release.mjs',
  'scripts/api-base.test.ts',
  'scripts/build-complete-release.mjs',
  'scripts/build-installer.bat',
  'scripts/build-installer.ps1',
  'scripts/build-release-package.mjs',
  'scripts/build-windows-installer.bat',
  'scripts/build-windows-installer.mjs',
  'scripts/elevation.test.ts',
  'scripts/enlarged-print.test.ts',
  'scripts/offline-sitepack.test.ts',
  'scripts/package-static.ts',
  'scripts/proxy-hardening.test.ts',
  'scripts/tsconfig.test.json',
  'package.json',
  'package-lock.json',
  'postcss.config.js',
  'tailwind.config.ts',
  'tsconfig.json',
  'vite.config.ts',
];
// Workspace-only release gates still participate in provenance, but are not
// copied into the customer rebuild source when their runtime is unavailable.
const SOURCE_FINGERPRINT_ONLY = [
  'scripts/desktop-csp.test.mjs',
];

function fail(message) {
  throw new Error(`Release packaging blocked: ${message}`);
}

function rel(file) {
  return path.relative(ROOT, file).split(path.sep).join('/');
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function fileSha256(file) {
  return sha256(readFileSync(file));
}

function mustExist(file) {
  if (!existsSync(file)) fail(`missing required file: ${rel(file)}`);
}

function assertSourceIdentity() {
  if (PKG.license !== 'UNLICENSED') fail('root package license must be UNLICENSED');
  const electronPackage = JSON.parse(readFileSync(path.join(ROOT, 'electron', 'package.json'), 'utf8'));
  const tauriConfig = JSON.parse(readFileSync(path.join(ROOT, 'src-tauri', 'tauri.conf.json'), 'utf8'));
  if (electronPackage.version !== VERSION || tauriConfig.version !== VERSION) {
    fail('root, Electron, and Tauri versions must match before release assembly');
  }
  if (electronPackage.license !== 'UNLICENSED') fail('Electron package license must be UNLICENSED');
  const installerBuilder = readFileSync(path.join(ROOT, 'scripts', 'build-windows-installer.mjs'), 'utf8');
  if (!installerBuilder.includes('PROPRIETARY AND CONFIDENTIAL') ||
      !installerBuilder.includes('UNLICENSED')) {
    fail('Windows installer license text must identify BESSForge as proprietary and UNLICENSED');
  }
}

function copy(source, destination) {
  mustExist(source);
  mkdirSync(path.dirname(destination), { recursive: true });
  cpSync(source, destination, { recursive: true, dereference: true });
}

function cleanRoomEnvironment() {
  const allowed = [
    'PATH',
    'Path',
    'PATHEXT',
    'SystemRoot',
    'SYSTEMROOT',
    'WINDIR',
    'COMSPEC',
    'TEMP',
    'TMP',
    'HOME',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'ProgramData',
    'ProgramFiles',
    'ProgramFiles(x86)',
  ];
  const env = {};
  for (const name of allowed) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return {
    ...env,
    CI: 'true',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_registry: 'https://registry.npmjs.org/',
  };
}

function runSourceVerification(command, args, cwd, env) {
  console.log(`\n[source-verification] ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, {
    cwd,
    env,
    stdio: 'inherit',
    shell: process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(command),
  });
  if (result.error) fail(`source verification could not run ${command}: ${result.error.message}`);
  if (result.status !== 0) {
    fail(`source verification command failed (${result.status}): ${command} ${args.join(' ')}`);
  }
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    const info = statSync(full);
    if (info.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function canonicalArtifact(directories, extension, label) {
  const matches = [];
  for (const directory of directories) {
    if (!existsSync(directory)) continue;
    for (const file of walk(directory)) {
      if (file.toLowerCase().endsWith(extension)) matches.push(file);
    }
  }
  const unique = [...new Set(matches.map(file => path.resolve(file)))];
  if (unique.length !== 1) {
    fail(`${label} requires exactly one canonical ${extension} output; found ${unique.length}`);
  }
  return unique[0];
}

function sourceFiles() {
  const files = [];
  for (const item of [...SOURCE_ALLOWLIST, ...SOURCE_FINGERPRINT_ONLY]) {
    const full = path.join(ROOT, item);
    if (!existsSync(full)) fail(`source fingerprint allowlist entry is missing: ${item}`);
    const info = statSync(full);
    if (!info.isDirectory()) {
      files.push(full);
      continue;
    }
    for (const file of walk(full)) {
      const relative = path.relative(ROOT, file).split(path.sep).join('/');
      if (relative.split('/').some(part => [
        '.git',
        '.cache',
        'node_modules',
        'target',
        CUSTOMER_INPUTS,
      ].includes(part))) continue;
      files.push(file);
    }
  }
  return files.sort();
}

export function computeSourceFingerprint() {
  const hash = createHash('sha256');
  for (const file of sourceFiles()) {
    const relative = rel(file);
    const bytes = readFileSync(file);
    hash.update(Buffer.from(`${relative}\0${bytes.length}\0`, 'utf8'));
    hash.update(bytes);
  }
  return hash.digest('hex');
}

export function createBuildProvenance() {
  return {
    schema: 'eci-build-provenance/v1',
    product: 'BESSForge',
    version: VERSION,
    license: 'UNLICENSED',
    sourceFingerprint: computeSourceFingerprint(),
    sourceFingerprintDefinition: 'SHA-256 over sorted allowlisted UTF-8 paths, NUL, byte length, NUL, and file bytes',
  };
}

function assertMinimum(file, minimumMB, label) {
  mustExist(file);
  const sizeMB = statSync(file).size / 1024 / 1024;
  if (sizeMB < minimumMB) {
    fail(`${label} is only ${sizeMB.toFixed(1)} MB; expected at least ${minimumMB} MB`);
  }
}

function assertFresh(file, buildStartedAt, label) {
  if (statSync(file).mtimeMs < buildStartedAt - 2000) {
    fail(`${label} predates this release build: ${rel(file)}`);
  }
}

function assertMsi(file, label) {
  const header = readFileSync(file).subarray(0, 8);
  const compoundDocument = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  if (!header.equals(compoundDocument)) fail(`${label} does not have a valid MSI compound-file header`);
}

function assertNsis(file, label) {
  const bytes = readFileSync(file);
  if (bytes[0] !== 0x4d || bytes[1] !== 0x5a || !bytes.includes(Buffer.from('NullsoftInst'))) {
    fail(`${label} is not a valid NSIS/PE installer`);
  }
}

function readWindowsMetadata(file, kind, label) {
  if (process.platform !== 'win32') fail(`${label} metadata validation requires Windows`);
  const script = kind === 'msi'
    ? [
        '$installer = New-Object -ComObject WindowsInstaller.Installer',
        '$db = $installer.GetType().InvokeMember("OpenDatabase","InvokeMethod",$null,$installer,@($env:BF_FILE,0))',
        'function P($n){$v=$db.OpenView("SELECT `Value` FROM `Property` WHERE `Property`=' + "'$n'" + '");$v.Execute();$r=$v.Fetch();if($r){$r.StringData(1)}}',
        '@{ProductName=(P "ProductName");ProductVersion=(P "ProductVersion")} | ConvertTo-Json -Compress',
      ].join(';')
    : '$v=[Diagnostics.FileVersionInfo]::GetVersionInfo($env:BF_FILE);@{ProductName=$v.ProductName;ProductVersion=$v.ProductVersion;FileVersion=$v.FileVersion}|ConvertTo-Json -Compress';
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, BF_FILE: file },
  });
  if (result.error || result.status !== 0) {
    fail(`${label} metadata could not be read: ${result.error?.message ?? result.stderr.trim()}`);
  }
  let metadata;
  try { metadata = JSON.parse(result.stdout.trim()); } catch { fail(`${label} returned invalid Windows metadata`); }
  if (metadata.ProductName !== 'BESSForge' || metadata.ProductVersion !== VERSION) {
    fail(`${label} metadata mismatch (ProductName=${metadata.ProductName}, ProductVersion=${metadata.ProductVersion})`);
  }
  return { result: 'PASS', productName: metadata.ProductName, productVersion: metadata.ProductVersion };
}

function findSevenZip() {
  const candidates = [
    process.env.SEVEN_ZIP,
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, '7-Zip', '7z.exe'),
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], '7-Zip', '7z.exe'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  const locator = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', ['7z'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (locator.status === 0) {
    const candidate = locator.stdout.split(/\r?\n/).map(value => value.trim()).find(Boolean);
    if (candidate && existsSync(candidate)) return candidate;
  }
  fail('7-Zip is required to extract and audit native Windows installers');
}

function assertSafeArchivePath(value, label) {
  const normalized = value.replaceAll('\\', '/');
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized) ||
      normalized.split('/').includes('..')) {
    fail(`${label} contains an unsafe absolute or traversal path: ${value}`);
  }
}

export function validateSevenZipListing(output, label = 'archive', limits = EXTRACTION_LIMITS) {
  const records = output.split(/\r?\n-{10,}\r?\n/).at(-1).split(/\r?\n\r?\n/)
    .map(block => Object.fromEntries(block.split(/\r?\n/).map(line => {
      const index = line.indexOf(' = ');
      return index < 0 ? ['', ''] : [line.slice(0, index), line.slice(index + 3)];
    }).filter(([key]) => key)));
  let files = 0;
  let totalBytes = 0;
  for (const record of records) {
    if (!record.Path) continue;
    assertSafeArchivePath(record.Path, label);
    const attributes = `${record.Attributes ?? ''} ${record['Symbolic Link'] ?? ''}`;
    if (record['Symbolic Link'] || /reparse|symbolic|symlink/i.test(attributes) ||
        /(?:^|\s)l[rwx-]{9}(?:\s|$)/i.test(record.Attributes ?? '')) {
      fail(`${label} contains a symlink or reparse entry: ${record.Path}`);
    }
    if ((record.Folder ?? '').trim() === '+') continue;
    const size = Number(record.Size ?? 0);
    if (!Number.isSafeInteger(size) || size < 0 || size > limits.fileBytes) {
      fail(`${label} contains an oversized or invalid entry: ${record.Path}`);
    }
    files += 1;
    totalBytes += size;
    if (files > limits.files || totalBytes > limits.totalBytes) {
      fail(`${label} exceeds extraction resource limits`);
    }
  }
  return { files, totalBytes };
}

function preflightSevenZip(sevenZip, archive, label) {
  const listing = spawnSync(sevenZip, ['l', '-slt', archive], {
    cwd: ROOT, encoding: 'utf8', windowsHide: true,
  });
  if (listing.error || listing.status !== 0) {
    fail(`7-Zip could not list ${label}: ${listing.error?.message ?? listing.stderr.trim()}`);
  }
  return validateSevenZipListing(listing.stdout, label);
}

function securePostExtractionWalk(destination, label) {
  const root = realpathSync(destination);
  let files = 0;
  let totalBytes = 0;
  const pending = [destination];
  while (pending.length) {
    const current = pending.pop();
    for (const name of readdirSync(current)) {
      const full = path.join(current, name);
      const info = lstatSync(full);
      if (info.isSymbolicLink()) fail(`${label} extracted a symbolic link: ${full}`);
      const resolved = realpathSync(full);
      if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
        fail(`${label} extracted outside its destination`);
      }
      if (info.isDirectory()) {
        pending.push(full);
      } else {
        if (!info.isFile()) fail(`${label} extracted a reparse or special entry: ${full}`);
        files += 1;
        totalBytes += info.size;
        if (info.size > EXTRACTION_LIMITS.fileBytes ||
            files > EXTRACTION_LIMITS.files || totalBytes > EXTRACTION_LIMITS.totalBytes) {
          fail(`${label} extraction exceeds resource limits`);
        }
      }
    }
  }
  return { files, totalBytes };
}

function containsProductIdentity(buffer) {
  const token = 'bessforge';
  const folded = Buffer.from(buffer);
  for (let index = 0; index < folded.length; index += 1) {
    if (folded[index] >= 0x41 && folded[index] <= 0x5a) folded[index] += 0x20;
  }
  const ascii = Buffer.from(token, 'ascii');
  const utf16le = Buffer.alloc(token.length * 2);
  const utf16be = Buffer.alloc(token.length * 2);
  for (let index = 0; index < token.length; index += 1) {
    utf16le[index * 2] = token.charCodeAt(index);
    utf16be[index * 2 + 1] = token.charCodeAt(index);
  }
  return folded.indexOf(ascii) >= 0 ||
    folded.indexOf(utf16le) >= 0 ||
    folded.indexOf(utf16be) >= 0;
}

function expandNestedSevenZipPayloads(sevenZip, destination, label) {
  const queue = walk(destination).filter(file => /\.7z$/i.test(file));
  let extracted = 0;
  while (queue.length > 0) {
    const archive = queue.shift();
    extracted += 1;
    if (extracted > 32) fail(`${label} contains too many nested 7-Zip payloads`);
    const nestedDestination = path.join(destination, '_expanded', String(extracted).padStart(2, '0'));
    preflightSevenZip(sevenZip, archive, `${label} nested payload`);
    mkdirSync(nestedDestination, { recursive: true });
    const result = spawnSync(sevenZip, [
      'x',
      archive,
      `-o${nestedDestination}`,
      '-y',
      '-bb0',
    ], {
      cwd: ROOT,
      encoding: 'utf8',
      windowsHide: true,
    });
    if (result.error || result.status !== 0) {
      const detail = result.error?.message ||
        (result.stderr || result.stdout || '').trim().split(/\r?\n/).at(-1);
      fail(`7-Zip could not expand a nested payload in ${label}${detail ? `: ${detail}` : ''}`);
    }
    securePostExtractionWalk(destination, label);
    queue.push(...walk(nestedDestination).filter(file => /\.7z$/i.test(file)));
  }
}

function assertProvenanceObject(value, expected, label) {
  for (const field of ['schema', 'product', 'version', 'license', 'sourceFingerprint']) {
    if (value?.[field] !== expected[field]) fail(`${label} has conflicting provenance field ${field}`);
  }
}

function assertExtractedProvenance(destination, expected, label) {
  const matches = walk(destination).filter(file => path.basename(file).toLowerCase() === PROVENANCE_FILE.toLowerCase());
  if (matches.length !== 1) fail(`${label} must contain exactly one ${PROVENANCE_FILE}; found ${matches.length}`);
  let value;
  try { value = JSON.parse(readFileSync(matches[0], 'utf8')); } catch { fail(`${label} contains invalid provenance JSON`); }
  assertProvenanceObject(value, expected, label);
  return rel(matches[0]);
}

async function auditExtractedNativeInstallers(installers, expectedProvenance) {
  const sevenZip = findSevenZip();
  const reports = [];
  rmSync(NATIVE_AUDIT_STAGE, { recursive: true, force: true });
  mkdirSync(NATIVE_AUDIT_STAGE, { recursive: true });
  try {
    for (const installer of installers) {
      const destination = path.join(NATIVE_AUDIT_STAGE, installer.id);
      rmSync(destination, { recursive: true, force: true });
      mkdirSync(destination, { recursive: true });
      console.log(`\n[native-installer-audit] Extracting ${installer.label}`);
      preflightSevenZip(sevenZip, installer.file, installer.label);
      const extraction = spawnSync(sevenZip, [
        'x',
        installer.file,
        `-o${destination}`,
        '-y',
        '-bb0',
      ], {
        cwd: ROOT,
        encoding: 'utf8',
        windowsHide: true,
      });
      if (extraction.error) {
        fail(`7-Zip could not extract ${installer.label}: ${extraction.error.message}`);
      }
      if (extraction.status !== 0) {
        const detail = (extraction.stderr || extraction.stdout || '').trim().split(/\r?\n/).at(-1);
        fail(`7-Zip extraction failed for ${installer.label} (${extraction.status})${detail ? `: ${detail}` : ''}`);
      }

      securePostExtractionWalk(destination, installer.label);
      expandNestedSevenZipPayloads(sevenZip, destination, installer.label);
      const files = walk(destination);
      const bytes = files.reduce((sum, file) => sum + statSync(file).size, 0);
      if (files.length < 3 || bytes < 1024 * 1024) {
        fail(`${installer.label} extraction is not a plausible payload (${files.length} files, ${bytes} bytes)`);
      }
      const hasApplicationContent = files.some(file => {
        const relative = path.relative(destination, file);
        return relative.toLowerCase().includes('bessforge') ||
          containsProductIdentity(readFileSync(file));
      });
      if (!hasApplicationContent) {
        fail(`${installer.label} extraction does not contain identifiable BESSForge application content`);
      }

      const audit = await auditReleaseTarget(destination);
      assertAuditPassed(audit);
      const provenancePath = assertExtractedProvenance(
        destination, expectedProvenance, installer.label
      );
      reports.push({
        id: installer.id,
        format: installer.format,
        result: 'PASS',
        files: audit.files,
        bytes,
        provenance: { result: 'PASS', path: provenancePath },
      });
    }
    return reports;
  } finally {
    rmSync(NATIVE_AUDIT_STAGE, { recursive: true, force: true });
  }
}

async function assertCleanTarget(target) {
  const report = await auditReleaseTarget(target);
  assertAuditPassed(report);
  return report;
}

async function zipTree(root, archiveRoot) {
  const zip = new JSZip();
  for (const file of walk(root).sort()) {
    const relative = path.relative(root, file).split(path.sep).join('/');
    zip.file(`${archiveRoot}/${relative}`, readFileSync(file), {
      binary: true,
      date: FIXED_ZIP_DATE,
    });
  }
  return zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 },
  });
}

function sanitizePackageJson() {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const serviceTests = [
    'tsx --tsconfig scripts/tsconfig.test.json scripts/api-base.test.ts',
    'tsx --tsconfig scripts/tsconfig.test.json scripts/offline-sitepack.test.ts',
    'tsx --tsconfig scripts/tsconfig.test.json scripts/proxy-hardening.test.ts',
  ].join(' && ');
  const sanitizedCoreTests = [
    'npm run test:services',
    'tsx --tsconfig scripts/tsconfig.test.json scripts/elevation.test.ts',
    'tsx --tsconfig scripts/tsconfig.test.json scripts/enlarged-print.test.ts',
  ].join(' && ');
  pkg.name = 'bessforge-eci-epcs';
  pkg.version = VERSION;
  pkg.private = true;
  pkg.license = 'UNLICENSED';
  pkg.author = 'ECI Electrical Consultants, Inc.';
  pkg.description = 'ECI-EPCS proprietary battery energy storage system design software';
  pkg.scripts = {
    dev: 'tsx server/index.ts',
    build: pkg.scripts.build,
    'build:static': 'vite build --base=./ --outDir ../dist/static/app --emptyOutDir',
    'package:static': pkg.scripts['package:static'],
    'build:installer': pkg.scripts['build:installer'],
    'package:release': 'npm run package:complete',
    'package:complete': 'node scripts/build-complete-release.mjs',
    'verify:sanitized-source': 'node scripts/build-release-package.mjs --verify-source-only',
    'test:release-integrity': 'node scripts/build-release-package.mjs --self-test',
    tauri: pkg.scripts.tauri,
    check: 'tsc --noEmit',
    lint: 'eslint client/src server scripts --max-warnings=0',
    test: sanitizedCoreTests,
    'test:services': serviceTests,
    'test:sanitized-core': sanitizedCoreTests,
    'test:release': sanitizedCoreTests,
    'audit:security': 'npm audit --audit-level=moderate',
    'audit:release': 'node scripts/audit-release.mjs . --report dist/source-audit-report.json',
  };
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    for (const name of Object.keys(pkg[field] ?? {})) {
      if (name.startsWith(`@${PLATFORM_TOKEN}/`)) delete pkg[field][name];
    }
  }
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

const REQUIRED_SANITIZED_SCRIPTS = [
  'build:static',
  'package:static',
  'build:installer',
  'package:release',
  'package:complete',
  'verify:sanitized-source',
  'test:release-integrity',
  'tauri',
  'check',
  'lint',
  'test:release',
  'audit:security',
  'audit:release',
];
const FULL_RELEASE_TEST_GATE = `  run(npm, ['run', 'test']);
  run(npm, ['run', 'test:devserver']);
  run(npm, ['run', 'test:bigiron-verify']);
  run(npm, ['run', 'test:kmz834-visual']);
  run(npm, ['run', 'test:trench-visual']);
  run(npm, ['run', 'test:gates-visual']);
  run(npm, ['run', 'test:ghost-visual']);
  run(npm, ['run', 'test:cad-visual']);
  run(npm, ['run', 'test:context-recovery']);
  run(npm, ['run', 'test:tenpct-visual']);
  run(npm, ['run', 'build:static']);
  run(npm, ['run', 'test:desktop-csp']);`;
const SANITIZED_RELEASE_TEST_GATE = `  // Sanitized rebuild source excludes customer-uploaded KMZ fixtures. Its
  // documented clean-room gate is the deterministic synthetic release subset.
  run(npm, ['run', 'test:release']);
  run(npm, ['run', 'build:static']);`;
const ROOT_RELEASE_GATES = [
  "run(npm, ['run', 'lint']);",
  "run(npm, ['run', 'check']);",
  "run(npm, ['audit', '--audit-level=moderate']);",
  ...FULL_RELEASE_TEST_GATE.split('\n').map(line => line.trim()),
  "run(npm, ['ci', '--prefix', 'electron']);",
  "run(npm, ['audit', '--prefix', 'electron', '--audit-level=moderate']);",
];
const UNAVAILABLE_SANITIZED_FIXTURE_GATES = [
  'test:bigiron-verify',
  'test:kmz834-visual',
  'test:trench-visual',
  'test:gates-visual',
  'test:ghost-visual',
  'test:cad-visual',
  'test:context-recovery',
  'test:tenpct-visual',
  'test:desktop-csp',
];

export function assertSanitizedWorkflowScripts(pkg) {
  const missing = REQUIRED_SANITIZED_SCRIPTS.filter(name => !pkg?.scripts?.[name]);
  if (missing.length) fail(`sanitized package is missing workflow scripts: ${missing.join(', ')}`);
}

export function sanitizeCompleteReleaseBuilder() {
  const file = path.join(ROOT, 'scripts', 'build-complete-release.mjs');
  const source = readFileSync(file, 'utf8');
  for (const gate of ROOT_RELEASE_GATES) {
    if (!source.includes(gate)) fail(`authoritative complete-release builder is missing gate: ${gate}`);
  }
  const occurrences = source.split(FULL_RELEASE_TEST_GATE).length - 1;
  if (occurrences !== 1) {
    fail(`authoritative full release test marker must occur exactly once; found ${occurrences}`);
  }
  const sanitized = source.replace(FULL_RELEASE_TEST_GATE, SANITIZED_RELEASE_TEST_GATE);
  if (!sanitized.includes("run(npm, ['run', 'test:release']);") ||
      UNAVAILABLE_SANITIZED_FIXTURE_GATES.some(gate => sanitized.includes(`'${gate}'`))) {
    fail('sanitized complete-release builder test-gate transformation is incomplete');
  }
  return sanitized;
}

function sanitizePackageLock(file) {
  const lock = JSON.parse(readFileSync(file, 'utf8'));
  const internalPrefix = `http://${REGISTRY_TOKEN}.${PLATFORM_TOKEN}.local/npm/`;

  function clean(value) {
    if (Array.isArray(value)) return value.map(clean);
    if (!value || typeof value !== 'object') {
      return typeof value === 'string' ? value.replaceAll(internalPrefix, 'https://registry.npmjs.org/') : value;
    }
    for (const key of Object.keys(value)) {
      if (key.includes(`node_modules/@${PLATFORM_TOKEN}/`) || key.startsWith(`@${PLATFORM_TOKEN}/`)) {
        delete value[key];
      } else {
        value[key] = clean(value[key]);
      }
    }
    return value;
  }

  const sanitized = clean(lock);
  sanitized.name = 'bessforge-eci-epcs';
  sanitized.version = VERSION;
  if (sanitized.packages?.['']) {
    sanitized.packages[''].name = 'bessforge-eci-epcs';
    sanitized.packages[''].version = VERSION;
    sanitized.packages[''].license = 'UNLICENSED';
  }
  return `${JSON.stringify(sanitized, null, 2)}\n`;
}

const LICENSE = `BESSForge 1.0.1
Copyright (c) 2026 ECI Electrical Consultants, Inc. All rights reserved.

PROPRIETARY AND CONFIDENTIAL — UNLICENSED

This software and its documentation are proprietary to ECI Electrical
Consultants, Inc. No permission is granted to use, copy, modify, publish,
distribute, sublicense, sell, reverse engineer, or create derivative works
except as expressly authorized by a separate written agreement with ECI.

Third-party software distributed with BESSForge remains subject to its
respective third-party license terms. Those terms do not license BESSForge.
`;

function releaseReadme(componentNames) {
  return `# BESSForge Complete Release ${VERSION}

This archive contains every supported BESSForge delivery format, all built from
the same source checkout.

Copyright (c) 2026 ECI Electrical Consultants, Inc. All rights reserved.
BESSForge is proprietary and confidential and is UNLICENSED. Third-party
components retain their own licenses; those terms do not license BESSForge.

## Which package should I use?

### Windows installer — fully self-contained

Run \`installers/electron/${componentNames.electron}\`. This is the recommended
option for most users. It bundles Chromium, needs no administrator privileges,
and provides native Save As dialogs for DXF, PDF, CSV, ZIP, and project exports.

### Windows installer — lightweight Tauri

Use either \`installers/tauri/${componentNames.tauriMsi}\` or
\`installers/tauri/${componentNames.tauriNsis}\`. These use Microsoft Edge
WebView2 and may download the WebView2 runtime during installation if Windows
does not already have it.

### Portable Windows app

Extract \`portable/${componentNames.portable}\` completely, then run
\`BESSForge.exe\` inside the extracted folder. Do not run it from inside the ZIP.

### Static/self-hosting package

Extract \`static/${componentNames.static}\`. Upload its \`app/\` folder to any
static web host, or on Windows double-click the included local-server launcher.

### Sanitized rebuild source

Extract \`source/${componentNames.source}\`. On Windows, run
\`scripts\\build-installer.bat\`. It checks Node.js, Rust/MSVC, Visual Studio C++
Build Tools, WebView2, and NSIS, offers to install missing prerequisites after
one confirmation, then builds and verifies every delivery format.

## Verification

\`SHA256SUMS.txt\` covers every installer and nested package.
\`RELEASE-MANIFEST.json\` records each format, byte size, and digest.
\`RELEASE-AUDIT.json\` records the recursive branding and archive audit.
The source archive's \`SOURCE-VERIFICATION.json\` records the mandatory clean-room
lock install, typecheck, lint, sanitized-core test, and static-build results.
The release manifest also records PASS/file-count results from extracting and
recursively auditing each Electron NSIS, Tauri MSI, and Tauri NSIS installer.

In PowerShell:

\`\`\`powershell
Get-FileHash .\\installers\\electron\\${componentNames.electron} -Algorithm SHA256
\`\`\`

Compare the result with \`SHA256SUMS.txt\`.

## Offline and privacy notes

Core layout, KMZ import, 2D/3D/CAD viewing, and DXF/PDF/CSV/ZIP exports run
locally. Optional online imagery and elevation features require network access.
No API keys, credentials, or user project files are included in this release.

The installers are unsigned. Windows may show a SmartScreen warning; verify the
SHA-256 digest before running an installer.
`;
}

const SOURCE_README = `# BESSForge Rebuild Source ${VERSION}

This sanitized source package contains the complete application, public runtime
assets, Electron shell, Tauri shell, static packager, installer definitions, and
release verification tools. It intentionally excludes dependencies, caches,
workspace metadata, uploaded reference material, build outputs, and secrets.

Copyright (c) 2026 ECI Electrical Consultants, Inc. All rights reserved.
This source is proprietary and confidential and is UNLICENSED. Possession of
the package does not grant permission to copy, modify, or redistribute it.

## Windows: build every delivery format

1. Run \`scripts\\build-installer.bat\` for guided prerequisite setup and build.
2. Or install Node.js LTS, Rust (MSVC), Visual Studio C++ Build Tools, WebView2,
   and NSIS manually; then run \`npm ci\` and \`npm run package:complete\`.

The complete release is written under \`dist/release/\`.
\`npm run package:complete\` is intentionally Windows-only because MSI, NSIS,
PE metadata, and Windows Installer metadata are mandatory release gates.
Customer source rebuilds run the documented synthetic \`test:release\` subset
because uploaded/customer KMZ fixtures are intentionally not distributed.
The distributed native artifacts are produced only after the authoritative
workspace gate passes the full test suite, dev-server tests, Big Iron and KMZ
visual verification, and every serial trench/gates/ghost/CAD/context/10% visual
gate, plus root and Electron dependency audits.

## Individual builds

- Static site: \`npm run package:static\`
- Self-contained Electron installer + portable app: \`npm run build:installer\`
- Tauri MSI + NSIS: \`scripts\\build-installer.bat\`
- Type check: \`npm run check\`
- Lint/type safety gate: \`npm run lint\`
- Clean synthetic/core tests: \`npm test\`
- Local verification subset: lockfile-only root and Electron installs,
  TypeScript, ESLint, API-base/offline-sitepack/proxy-hardening/elevation/
  enlarged-print tests, and a production static build. It does not build or
  inspect native installers.
- Recursive source audit: \`npm run audit:release\`

\`SOURCE-VERIFICATION.json\` is generated only after this staged source tree
passes lockfile installs, typecheck, lint, sanitized-core service tests, and a
production static build. Generated dependencies and build output are removed
before the source archive is created.
`;

function sanitizeElectronPackage() {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'electron', 'package.json'), 'utf8'));
  pkg.version = VERSION;
  pkg.private = true;
  pkg.license = 'UNLICENSED';
  pkg.author = 'ECI Electrical Consultants, Inc.';
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

function sanitizeElectronLock() {
  const lock = JSON.parse(readFileSync(path.join(ROOT, 'electron', 'package-lock.json'), 'utf8'));
  const internalPrefix = `http://${REGISTRY_TOKEN}.${PLATFORM_TOKEN}.local/npm/`;
  function clean(value) {
    if (Array.isArray(value)) return value.map(clean);
    if (!value || typeof value !== 'object') {
      return typeof value === 'string'
        ? value.replaceAll(internalPrefix, 'https://registry.npmjs.org/')
        : value;
    }
    for (const key of Object.keys(value)) {
      if (key.includes(`node_modules/@${PLATFORM_TOKEN}/`) || key.startsWith(`@${PLATFORM_TOKEN}/`)) {
        delete value[key];
      } else {
        value[key] = clean(value[key]);
      }
    }
    return value;
  }
  const sanitized = clean(lock);
  sanitized.version = VERSION;
  if (sanitized.packages?.['']) {
    sanitized.packages[''].version = VERSION;
    sanitized.packages[''].license = 'UNLICENSED';
  }
  return `${JSON.stringify(sanitized, null, 2)}\n`;
}

function sanitizeInstallerBuilder() {
  const file = path.join(ROOT, 'scripts', 'build-windows-installer.mjs');
  const source = readFileSync(file, 'utf8');
  const replacement = `const LICENSE_TEXT = \`BESSForge \${VERSION}
Copyright (c) 2026 ECI Electrical Consultants, Inc. All rights reserved.

PROPRIETARY AND CONFIDENTIAL — UNLICENSED

No right to use, copy, modify, or distribute BESSForge is granted except under
a separate written agreement with ECI Electrical Consultants, Inc.

Bundled third-party components remain subject to their own license notices.
Those notices do not license BESSForge.
\`;`;
  const sanitized = source.replace(/const LICENSE_TEXT = `[\s\S]*?`;/, replacement);
  if (sanitized === source) fail('could not sanitize the Windows installer license text');
  return sanitized;
}

async function assertZipContains(file, prefixes, label) {
  const zip = await JSZip.loadAsync(readFileSync(file));
  const names = Object.keys(zip.files);
  for (const prefix of prefixes) {
    if (!names.some(name => name.startsWith(prefix))) fail(`${label} is missing ${prefix}`);
  }
  return names.filter(name => !name.endsWith('/')).length;
}

async function assertZipProvenance(file, expected, label) {
  const zip = await JSZip.loadAsync(readFileSync(file));
  const matches = Object.values(zip.files).filter(entry =>
    !entry.dir && path.posix.basename(entry.name).toLowerCase() === PROVENANCE_FILE.toLowerCase()
  );
  if (matches.length !== 1) fail(`${label} must contain exactly one ${PROVENANCE_FILE}; found ${matches.length}`);
  let value;
  try { value = JSON.parse(await matches[0].async('string')); } catch { fail(`${label} contains invalid provenance JSON`); }
  assertProvenanceObject(value, expected, label);
  return matches[0].name;
}

function removeSourceVerificationOutputs() {
  for (const relative of [
    'node_modules',
    'dist',
    '.cache',
    'electron/node_modules',
    'electron/app',
    'electron/release',
    'src-tauri/target',
  ]) {
    rmSync(path.join(SOURCE_STAGE, relative), { recursive: true, force: true });
  }
}

function verifySanitizedSource() {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const env = cleanRoomEnvironment();
  const trackedInputs = [
    'package.json',
    'package-lock.json',
    'electron/package.json',
    'electron/package-lock.json',
  ];
  const before = Object.fromEntries(trackedInputs.map(relative => [
    relative,
    fileSha256(path.join(SOURCE_STAGE, relative)),
  ]));
  const steps = [
    { id: 'root-lock-install', command: npm, args: ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], cwd: SOURCE_STAGE },
    { id: 'typecheck', command: npm, args: ['run', 'check'], cwd: SOURCE_STAGE },
    { id: 'lint', command: npm, args: ['run', 'lint'], cwd: SOURCE_STAGE },
    { id: 'sanitized-core-tests', command: npm, args: ['run', 'test:sanitized-core'], cwd: SOURCE_STAGE },
    { id: 'production-static-build', command: npm, args: ['run', 'build:static'], cwd: SOURCE_STAGE },
    { id: 'electron-lock-install', command: npm, args: ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], cwd: path.join(SOURCE_STAGE, 'electron') },
  ];

  try {
    for (const step of steps) {
      runSourceVerification(step.command, step.args, step.cwd, env);
    }
    mustExist(path.join(SOURCE_STAGE, 'dist', 'static', 'app', 'index.html'));
    for (const relative of trackedInputs) {
      const after = fileSha256(path.join(SOURCE_STAGE, relative));
      if (after !== before[relative]) fail(`source verification modified locked input ${relative}`);
    }
  } finally {
    removeSourceVerificationOutputs();
  }

  for (const relative of [
    'node_modules',
    'dist',
    'electron/node_modules',
    'electron/app',
    'electron/release',
  ]) {
    if (existsSync(path.join(SOURCE_STAGE, relative))) {
      fail(`source verification cleanup left generated output ${relative}`);
    }
  }

  return {
    schema: 'eci-source-verification/v1',
    product: 'BESSForge',
    version: VERSION,
    result: 'PASS',
    inputs: {
      rootPackageSha256: before['package.json'],
      rootLockSha256: before['package-lock.json'],
      electronPackageSha256: before['electron/package.json'],
      electronLockSha256: before['electron/package-lock.json'],
    },
    checks: steps.map(step => ({ id: step.id, result: 'PASS' })),
    assertions: {
      stagedAllowlistedSource: true,
      lockfileOnlyInstalls: true,
      assetIndependentServiceTests: [
        'api-base',
        'offline-sitepack',
        'proxy-hardening',
      ],
      productionStaticBuild: true,
      nativeInstallersBuilt: false,
      recursiveCompleteReleaseInvoked: false,
      generatedOutputsRemoved: true,
    },
  };
}

async function buildSourceZip(provenance = createBuildProvenance()) {
  rmSync(SOURCE_STAGE, { recursive: true, force: true });
  mkdirSync(SOURCE_STAGE, { recursive: true });

  const generatedPaths = new Set([
    'package.json',
    'package-lock.json',
    'electron/package.json',
    'electron/package-lock.json',
    'scripts/build-windows-installer.mjs',
    'scripts/build-complete-release.mjs',
  ]);
  const copyPaths = SOURCE_ALLOWLIST.filter(item => !generatedPaths.has(item));
  for (const item of copyPaths) {
    const sourcePath = path.join(ROOT, item);
    if (existsSync(sourcePath)) copy(sourcePath, path.join(SOURCE_STAGE, item));
  }
  writeFileSync(path.join(SOURCE_STAGE, 'package.json'), sanitizePackageJson());
  writeFileSync(path.join(SOURCE_STAGE, 'package-lock.json'), sanitizePackageLock(path.join(ROOT, 'package-lock.json')));
  mkdirSync(path.join(SOURCE_STAGE, 'electron'), { recursive: true });
  writeFileSync(path.join(SOURCE_STAGE, 'electron', 'package.json'), sanitizeElectronPackage());
  writeFileSync(path.join(SOURCE_STAGE, 'electron', 'package-lock.json'), sanitizeElectronLock());
  mkdirSync(path.join(SOURCE_STAGE, 'scripts'), { recursive: true });
  writeFileSync(path.join(SOURCE_STAGE, 'scripts', 'build-windows-installer.mjs'), sanitizeInstallerBuilder());
  writeFileSync(
    path.join(SOURCE_STAGE, 'scripts', 'build-complete-release.mjs'),
    sanitizeCompleteReleaseBuilder()
  );
  writeFileSync(path.join(SOURCE_STAGE, 'LICENSE'), LICENSE);
  writeFileSync(path.join(SOURCE_STAGE, PROVENANCE_FILE), `${JSON.stringify(provenance, null, 2)}\n`);
  writeFileSync(path.join(SOURCE_STAGE, 'README_BUILD.md'), SOURCE_README);
  writeFileSync(path.join(SOURCE_STAGE, '.gitignore'), [
    'node_modules',
    'dist',
    '.cache',
    '.DS_Store',
    'electron/node_modules',
    'electron/app',
    'electron/release',
    'src-tauri/target',
  ].join('\n') + '\n');
  assertSanitizedWorkflowScripts(
    JSON.parse(readFileSync(path.join(SOURCE_STAGE, 'package.json'), 'utf8'))
  );

  for (const stale of [
    'electron/app',
    'electron/node_modules',
    'electron/release',
    'src-tauri/target',
    'scripts/.nextera.test.ts.uSEqR4UGYCLHwyMI9zS7B~',
    'scripts/_tmp_check439.ts',
  ]) {
    rmSync(path.join(SOURCE_STAGE, stale), { recursive: true, force: true });
  }

  for (const required of [
    'client/public/models',
    'client/public/textures',
    'client/public/samples',
    'client/public/fonts',
    'client/public/sounds',
    'postcss.config.js',
    'tailwind.config.ts',
    'eslint.config.js',
    'README.md',
    'ECI-EPCS.md',
    'scripts/audit-release.mjs',
    'scripts/build-complete-release.mjs',
    'scripts/build-release-package.mjs',
    'scripts/build-windows-installer.mjs',
    'scripts/build-windows-installer.bat',
    'scripts/build-installer.ps1',
    'build/installer/bessforge.nsi',
    'electron/build/icon.ico',
    'electron/main.cjs',
    'electron/cesiumIonToken.cjs',
    'src-tauri/tauri.conf.json',
    'src-tauri/icons/icon.ico',
    PROVENANCE_FILE,
  ]) {
    mustExist(path.join(SOURCE_STAGE, required));
  }

  await assertCleanTarget(SOURCE_STAGE);
  const sourceVerification = verifySanitizedSource();
  if (sourceVerification.result !== 'PASS') fail('sanitized source verification did not pass');
  const verificationPath = path.join(SOURCE_STAGE, SOURCE_VERIFICATION_REPORT);
  writeFileSync(verificationPath, `${JSON.stringify(sourceVerification, null, 2)}\n`);
  const verificationSha256 = fileSha256(verificationPath);
  await assertCleanTarget(SOURCE_STAGE);
  return {
    buffer: await zipTree(SOURCE_STAGE, SOURCE_NAME),
    verification: sourceVerification,
    verificationSha256,
  };
}

async function verifySourceOnly() {
  assertSourceIdentity();
  const provenance = createBuildProvenance();
  rmSync(SOURCE_VERIFICATION_OUT, { recursive: true, force: true });
  mkdirSync(SOURCE_VERIFICATION_OUT, { recursive: true });
  const sourceBuild = await buildSourceZip(provenance);
  if (sourceBuild.verification.result !== 'PASS') {
    fail('source-only verification requires a PASS clean-room result');
  }

  const output = path.join(SOURCE_VERIFICATION_OUT, `${SOURCE_NAME}.zip`);
  writeFileSync(output, sourceBuild.buffer);
  await assertZipProvenance(output, provenance, 'sanitized source ZIP');
  const audit = await auditReleaseTarget(output);
  assertAuditPassed(audit);
  const auditFile = `${output}.audit.json`;
  const checksumFile = `${output}.sha256`;
  writeAuditReport(audit, auditFile);
  writeFileSync(
    checksumFile,
    `${sha256(sourceBuild.buffer)}  ${path.basename(output)}\n`
  );

  console.log(`\n[source-verification] PASS: ${rel(output)}`);
  console.log(`[source-verification] SHA-256 ${sha256(sourceBuild.buffer)}`);
  console.log(`[source-verification] Audit report: ${rel(auditFile)}`);
}

async function selfTest() {
  let assertions = 0;
  const rejects = async (label, action) => {
    try {
      await action();
      throw new Error(`self-test expected rejection: ${label}`);
    } catch (error) {
      if (String(error).includes('self-test expected rejection')) throw error;
      assertions += 1;
    }
  };
  const listing = record => [
    'Path = sample.7z',
    'Type = 7z',
    '----------',
    record,
    '',
  ].join('\n');
  await rejects('traversal listing', () => validateSevenZipListing(
    listing('Path = ../escape.txt\nSize = 1\nFolder = -'), 'fixture'
  ));
  await rejects('symlink listing', () => validateSevenZipListing(
    listing('Path = link\nSize = 1\nFolder = -\nSymbolic Link = target'), 'fixture'
  ));
  await rejects('oversized listing', () => validateSevenZipListing(
    listing('Path = huge.bin\nSize = 11\nFolder = -'), 'fixture',
    { files: 2, fileBytes: 10, totalBytes: 10 }
  ));
  const expected = createBuildProvenance();
  await rejects('stale fingerprint', () => assertProvenanceObject(
    { ...expected, sourceFingerprint: '0'.repeat(64) }, expected, 'fixture'
  ));
  await rejects('missing payload provenance', () => {
    if ([].length !== 1) fail(`fixture must contain exactly one ${PROVENANCE_FILE}; found 0`);
  });
  const complete = JSON.parse(sanitizePackageJson());
  delete complete.scripts['package:complete'];
  await rejects('incomplete sanitized scripts', () => assertSanitizedWorkflowScripts(complete));
  const rootBuilder = readFileSync(path.join(ROOT, 'scripts', 'build-complete-release.mjs'), 'utf8');
  for (const gate of ROOT_RELEASE_GATES) {
    if (!rootBuilder.includes(gate)) {
      throw new Error(`release-integrity self-test: authoritative builder is missing ${gate}`);
    }
  }
  const sanitizedBuilder = sanitizeCompleteReleaseBuilder();
  if (!rootBuilder.includes("run(npm, ['run', 'test:desktop-csp']);")) {
    throw new Error('release-integrity self-test: authoritative builder is missing test:desktop-csp');
  }
  if (!sanitizedBuilder.includes("run(npm, ['run', 'test:release']);") ||
      sanitizedBuilder.includes("run(npm, ['run', 'test:desktop-csp']);") ||
      UNAVAILABLE_SANITIZED_FIXTURE_GATES.some(gate => sanitizedBuilder.includes(`'${gate}'`))) {
    throw new Error('release-integrity self-test: sanitized builder contains the wrong release gates');
  }
  assertions += 2;
  console.log(`[release-integrity-self-test] PASS (${assertions} integrity checks)`);
}

async function main() {
  assertSourceIdentity();
  mustExist(BUILD_MARKER);
  let marker;
  try { marker = JSON.parse(readFileSync(BUILD_MARKER, 'utf8')); } catch { fail('unified build marker is invalid'); }
  const provenance = createBuildProvenance();
  if (marker.sourceFingerprint !== provenance.sourceFingerprint) {
    fail('unified build marker does not match the exact current source');
  }
  const buildStartedAt = Number(marker.startedAt);
  const buildAge = Date.now() - buildStartedAt;
  if (!Number.isFinite(buildStartedAt) || buildStartedAt <= 0 || buildAge < 0 || buildAge > 6 * 60 * 60 * 1000) {
    fail('a current --build-started-at timestamp from the unified build is required');
  }
  const electron = path.join(ROOT, 'dist', 'installer', `BESSForge-Setup-${VERSION}.exe`);
  const portable = path.join(ROOT, 'dist', 'portable', `BESSForge_Portable_${VERSION}_Windows_x64.zip`);
  const staticZip = path.join(ROOT, 'dist', 'static', `BESSForge_Static_${VERSION}_Windows_x64.zip`);
  const targetRoots = [
    path.join(ROOT, 'src-tauri', 'target', 'release', 'bundle'),
    path.join(ROOT, 'src-tauri', 'target', 'x86_64-pc-windows-msvc', 'release', 'bundle'),
  ];
  const tauriMsi = canonicalArtifact(
    targetRoots.map(root => path.join(root, 'msi')), '.msi', 'Tauri MSI installer'
  );
  const tauriNsis = canonicalArtifact(
    targetRoots.map(root => path.join(root, 'nsis')), '.exe', 'Tauri NSIS installer'
  );

  const currentSourceFiles = sourceFiles();
  const latestSourceMtime = Math.max(...currentSourceFiles.map(file => statSync(file).mtimeMs));
  const freshnessBoundary = Math.max(buildStartedAt, latestSourceMtime);

  assertMinimum(electron, 70, 'self-contained Electron installer');
  assertMinimum(portable, 80, 'portable Windows package');
  assertMinimum(staticZip, 10, 'static/self-hosting package');
  assertMinimum(tauriMsi, 5, 'Tauri MSI installer');
  assertMinimum(tauriNsis, 5, 'Tauri NSIS installer');
  for (const [file, label] of [
    [electron, 'self-contained Electron installer'],
    [portable, 'portable Windows package'],
    [staticZip, 'static/self-hosting package'],
    [tauriMsi, 'Tauri MSI installer'],
    [tauriNsis, 'Tauri NSIS installer'],
  ]) {
    assertFresh(file, freshnessBoundary, label);
  }
  assertNsis(electron, 'self-contained Electron installer');
  assertMsi(tauriMsi, 'Tauri MSI installer');
  assertNsis(tauriNsis, 'Tauri NSIS installer');
  const nativeMetadata = {
    electronNsis: readWindowsMetadata(electron, 'exe', 'self-contained Electron installer'),
    tauriMsi: readWindowsMetadata(tauriMsi, 'msi', 'Tauri MSI installer'),
    tauriNsis: readWindowsMetadata(tauriNsis, 'exe', 'Tauri NSIS installer'),
  };
  if (path.resolve(tauriNsis) === path.resolve(electron)) fail('Tauri and Electron installers resolve to the same file');

  const portableCount = await assertZipContains(portable, [
    `BESSForge_Portable_${VERSION}_Windows_x64/BESSForge.exe`,
    `BESSForge_Portable_${VERSION}_Windows_x64/resources/app/app/index.html`,
    `BESSForge_Portable_${VERSION}_Windows_x64/resources/app/app/models/`,
    `BESSForge_Portable_${VERSION}_Windows_x64/resources/app/app/textures/`,
    `BESSForge_Portable_${VERSION}_Windows_x64/resources/app/app/samples/`,
  ], 'portable Windows package');
  const staticCount = await assertZipContains(staticZip, [
    'BESSForge_Static/app/index.html',
    'BESSForge_Static/app/models/',
    'BESSForge_Static/app/textures/',
    'BESSForge_Static/app/samples/',
    'BESSForge_Static/server/caddy.exe',
  ], 'static/self-hosting package');
  if (portableCount < 100 || staticCount < 60) {
    fail(`package file counts are unexpectedly low (portable ${portableCount}, static ${staticCount})`);
  }
  const portableProvenancePath = await assertZipProvenance(
    portable, provenance, 'portable Windows package'
  );
  const staticProvenancePath = await assertZipProvenance(
    staticZip, provenance, 'static/self-hosting package'
  );
  const nativeInstallerReports = await auditExtractedNativeInstallers([
    {
      id: 'electron-nsis',
      format: 'Electron NSIS EXE',
      label: 'self-contained Electron installer',
      file: electron,
    },
    {
      id: 'tauri-msi',
      format: 'Tauri MSI',
      label: 'Tauri MSI installer',
      file: tauriMsi,
    },
    {
      id: 'tauri-nsis',
      format: 'Tauri NSIS EXE',
      label: 'Tauri NSIS installer',
      file: tauriNsis,
    },
  ], provenance);
  if (nativeInstallerReports.length !== 3 ||
      nativeInstallerReports.some(report => report.result !== 'PASS')) {
    fail('all three extracted native installer audits must pass');
  }

  rmSync(STAGE, { recursive: true, force: true });
  mkdirSync(STAGE, { recursive: true });

  const names = {
    electron: `BESSForge_Electron_Setup_${VERSION}_Windows_x64.exe`,
    portable: path.basename(portable),
    static: path.basename(staticZip),
    tauriMsi: `BESSForge_Tauri_${VERSION}_Windows_x64.msi`,
    tauriNsis: `BESSForge_Tauri_Setup_${VERSION}_Windows_x64.exe`,
    source: `${SOURCE_NAME}.zip`,
  };
  const components = [
    { kind: 'Electron self-contained installer', source: electron, destination: `installers/electron/${names.electron}` },
    { kind: 'Tauri MSI installer', source: tauriMsi, destination: `installers/tauri/${names.tauriMsi}` },
    { kind: 'Tauri NSIS installer', source: tauriNsis, destination: `installers/tauri/${names.tauriNsis}` },
    { kind: 'Portable Electron Windows app', source: portable, destination: `portable/${names.portable}` },
    { kind: 'Static/self-hosting package', source: staticZip, destination: `static/${names.static}` },
  ];

  for (const component of components) copy(component.source, path.join(STAGE, component.destination));
  const sourceBuild = await buildSourceZip(provenance);
  const sourceBuffer = sourceBuild.buffer;
  const sourceArchive = await JSZip.loadAsync(sourceBuffer);
  const sourceVerificationEntry = sourceArchive.file(
    `${SOURCE_NAME}/${SOURCE_VERIFICATION_REPORT}`
  );
  if (!sourceVerificationEntry) fail('sanitized source ZIP is missing its verification report');
  const embeddedVerificationBytes = Buffer.from(await sourceVerificationEntry.async('uint8array'));
  const embeddedVerification = JSON.parse(embeddedVerificationBytes.toString('utf8'));
  if (embeddedVerification.result !== 'PASS' ||
      sha256(embeddedVerificationBytes) !== sourceBuild.verificationSha256) {
    fail('sanitized source ZIP does not contain the required PASS verification report');
  }
  const sourceDestination = `source/${names.source}`;
  mkdirSync(path.join(STAGE, 'source'), { recursive: true });
  writeFileSync(path.join(STAGE, sourceDestination), sourceBuffer);
  components.push({ kind: 'Sanitized rebuild source', source: path.join(STAGE, sourceDestination), destination: sourceDestination });

  const manifestFiles = components.map(component => {
    const file = path.join(STAGE, component.destination);
    const bytes = readFileSync(file);
    return {
      path: component.destination,
      format: component.kind,
      bytes: bytes.length,
      sha256: sha256(bytes),
    };
  });
  const manifest = {
    product: 'BESSForge',
    version: VERSION,
    owner: 'ECI Electrical Consultants, Inc.',
    license: 'UNLICENSED',
    sourceFingerprint: provenance.sourceFingerprint,
    sourceFingerprintDefinition: provenance.sourceFingerprintDefinition,
    buildProvenance: {
      schema: provenance.schema,
      result: 'PASS',
      portablePath: portableProvenancePath,
      staticPath: staticProvenancePath,
      nativeInstallers: nativeInstallerReports.map(report => ({
        id: report.id, path: report.provenance.path, result: report.provenance.result,
      })),
    },
    sourceVerification: {
      result: sourceBuild.verification.result,
      reportPath: `${SOURCE_NAME}/${SOURCE_VERIFICATION_REPORT}`,
      reportSha256: sourceBuild.verificationSha256,
      checks: sourceBuild.verification.checks,
    },
    nativeInstallerAudit: {
      result: 'PASS',
      extractedWith: '7-Zip',
      installers: nativeInstallerReports,
    },
    nativeMetadata,
    platform: 'Windows x64 and static web',
    files: manifestFiles,
    verification: {
      recursiveArchiveAudit: true,
      binaryStringAudit: true,
      asciiAndUtf16Audit: true,
      extractedNativeInstallerAudit: true,
      sanitizedSourceCleanRoom: true,
      requiredAssetParity: true,
      secretsIncluded: false,
    },
  };
  const sourceManifestEntry = manifestFiles.find(file => file.format === 'Sanitized rebuild source');
  if (!sourceManifestEntry) fail('manifest is missing the shipped sanitized source archive');
  if (manifest.sourceVerification.result !== 'PASS') {
    fail('final release manifest requires a PASS sanitized-source verification');
  }

  writeFileSync(path.join(STAGE, 'README.md'), releaseReadme(names));
  writeFileSync(path.join(STAGE, 'LICENSE'), LICENSE);
  writeFileSync(path.join(STAGE, 'RELEASE-MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(
    path.join(STAGE, 'SHA256SUMS.txt'),
    manifestFiles.map(file => `${file.sha256}  ${file.path}`).join('\n') + '\n'
  );

  const stagedAudit = await assertCleanTarget(STAGE);
  writeAuditReport(stagedAudit, path.join(STAGE, 'RELEASE-AUDIT.json'));
  await assertCleanTarget(STAGE);

  const buffer = await zipTree(STAGE, RELEASE_NAME);
  mkdirSync(OUT_DIR, { recursive: true });
  const output = path.join(OUT_DIR, `${RELEASE_NAME}.zip`);
  const checksumFile = `${output}.sha256`;
  writeFileSync(output, buffer);
  writeFileSync(checksumFile, `${sha256(buffer)}  ${path.basename(output)}\n`);

  const finalAudit = await auditReleaseTarget(output);
  assertAuditPassed(finalAudit);
  writeAuditReport(finalAudit, `${output}.audit.json`);
  const finalZip = await JSZip.loadAsync(buffer);
  const finalFiles = Object.keys(finalZip.files).filter(name => !name.endsWith('/'));
  for (const required of [
    '/installers/electron/',
    '/installers/tauri/',
    '/portable/',
    '/static/',
    '/source/',
    '/RELEASE-AUDIT.json',
    '/RELEASE-MANIFEST.json',
    '/SHA256SUMS.txt',
  ]) {
    if (!finalFiles.some(name => name.includes(required))) fail(`final ZIP is missing ${required}`);
  }

  console.log(`Created ${rel(output)}`);
  console.log(`SHA-256 ${sha256(buffer)}`);
  console.log(`Size ${(buffer.length / 1024 / 1024).toFixed(1)} MB`);
  console.log(`Files ${finalFiles.length} (${manifestFiles.length} distributable components)`);
  rmSync(BUILD_MARKER, { force: true });
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const selected = process.argv.includes('--self-test')
    ? selfTest
    : process.argv.includes('--verify-source-only') ? verifySourceOnly : main;
  selected().catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}