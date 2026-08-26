/**
 * Standalone, recursive customer-delivery audit.
 *
 * Forbidden branding is assembled from fragments because this scanner is also
 * included in the sanitized rebuild source that it audits.
 */
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const FIXED_REPORT_SCHEMA = 'eci-release-audit/v1';
const MAX_DEPTH = 8;
const MAX_ENTRIES = 200_000;
const MAX_EXPANDED_BYTES = 16 * 1024 * 1024 * 1024;

const HOST_BRAND = ['re', 'pl', 'it'].join('');
const SHORT_HOST = ['re', 'pl', '.', 'co'].join('');
const PRIVATE_REGISTRY = ['package', 'firewall'].join('-');
const CUSTOMER_INPUTS = ['attached', 'assets'].join('_');
const FORBIDDEN = [HOST_BRAND, SHORT_HOST, PRIVATE_REGISTRY];
const ROOT_EXCLUDES = new Set([
  '.git',
  `.${HOST_BRAND}`,
  `${HOST_BRAND}.nix`,
  '.agents',
  '.local',
  '.cache',
  '.config',
  '.pythonlibs',
  '.upm',
  '.breakpoints',
  'node_modules',
  CUSTOMER_INPUTS,
  'dist',
  'exports',
  'screenshots',
  'verification-shots',
]);

function foldAscii(buffer) {
  const folded = Buffer.from(buffer);
  for (let index = 0; index < folded.length; index += 1) {
    if (folded[index] >= 0x41 && folded[index] <= 0x5a) folded[index] += 0x20;
  }
  return folded;
}

function encodedNeedles(token) {
  const ascii = Buffer.from(token, 'ascii');
  const littleEndian = Buffer.alloc(token.length * 2);
  const bigEndian = Buffer.alloc(token.length * 2);
  for (let index = 0; index < token.length; index += 1) {
    littleEndian[index * 2] = token.charCodeAt(index);
    bigEndian[index * 2 + 1] = token.charCodeAt(index);
  }
  return [
    { bytes: ascii, encoding: 'ascii' },
    { bytes: littleEndian, encoding: 'utf16le' },
    { bytes: bigEndian, encoding: 'utf16be' },
  ];
}

const NEEDLES = FORBIDDEN.flatMap((token, tokenIndex) =>
  encodedNeedles(token).map(needle => ({ tokenIndex, ...needle })));

function asciiWordByte(value) {
  return (value >= 0x30 && value <= 0x39) ||
    (value >= 0x61 && value <= 0x7a) ||
    value === 0x5f;
}

function shortHostHasBoundaries(buffer, index, needle) {
  const beforeIndex = needle.encoding === 'utf16be' ? index - 1 :
    needle.encoding === 'utf16le' ? index - 2 : index - 1;
  const afterIndex = needle.encoding === 'utf16be' ? index + needle.bytes.length + 1 :
    index + needle.bytes.length;
  const before = beforeIndex >= 0 ? buffer[beforeIndex] : undefined;
  const after = afterIndex < buffer.length ? buffer[afterIndex] : undefined;
  return (before === undefined || !asciiWordByte(before)) &&
    (after === undefined || !asciiWordByte(after));
}

function containsForbiddenBytes(buffer) {
  const folded = foldAscii(buffer);
  for (const needle of NEEDLES) {
    let index = folded.indexOf(needle.bytes);
    while (index >= 0) {
      if (FORBIDDEN[needle.tokenIndex] !== SHORT_HOST ||
          shortHostHasBoundaries(folded, index, needle)) {
        return needle.tokenIndex;
      }
      index = folded.indexOf(needle.bytes, index + 1);
    }
  }
  return -1;
}

function forbiddenPath(name) {
  const lower = name.replaceAll('\\', '/').toLowerCase();
  return FORBIDDEN.findIndex(token => lower.includes(token));
}

function looksLikeZip(buffer, name) {
  return /\.zip$/i.test(name) ||
    (buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b &&
      [0x03, 0x05, 0x07].includes(buffer[2]) && [0x04, 0x06, 0x08].includes(buffer[3]));
}

function walk(root, relative = '', output = [], excludeRootMetadata = false) {
  for (const name of readdirSync(path.join(root, relative))) {
    if (!relative && excludeRootMetadata && ROOT_EXCLUDES.has(name.toLowerCase())) continue;
    const itemRelative = relative ? `${relative}/${name}` : name;
    const full = path.join(root, itemRelative);
    const info = lstatSync(full);
    if (info.isSymbolicLink()) {
      output.push({ relative: itemRelative, full, symbolicLink: true, size: 0 });
    } else if (info.isDirectory()) {
      walk(root, itemRelative, output, false);
    } else {
      output.push({ relative: itemRelative, full, symbolicLink: false, size: info.size });
    }
  }
  return output;
}

function newState(target) {
  return {
    target,
    files: 0,
    archives: 0,
    archiveEntries: 0,
    bytesScanned: 0,
    expandedBytesScanned: 0,
    maxArchiveDepth: 0,
    findings: [],
  };
}

function addFinding(state, location, kind, detail) {
  state.findings.push({ location, kind, detail });
}

async function inspectBytes(buffer, location, state, depth = 0) {
  state.bytesScanned += buffer.length;
  if (depth > 0) state.expandedBytesScanned += buffer.length;
  if (containsForbiddenBytes(buffer) >= 0) {
    addFinding(state, location, 'forbidden-content', 'case-insensitive ASCII or UTF-16 branding match');
  }
  if (!looksLikeZip(buffer, location)) return;
  if (depth >= MAX_DEPTH) {
    addFinding(state, location, 'archive-depth', `nested archive depth exceeds ${MAX_DEPTH}`);
    return;
  }

  let archive;
  try {
    archive = await JSZip.loadAsync(buffer, { checkCRC32: true });
  } catch (error) {
    addFinding(state, location, 'unreadable-archive',
      error instanceof Error ? error.message : String(error));
    return;
  }
  state.archives += 1;
  state.maxArchiveDepth = Math.max(state.maxArchiveDepth, depth + 1);
  const entries = Object.entries(archive.files);
  state.archiveEntries += entries.length;
  if (state.archiveEntries > MAX_ENTRIES) {
    addFinding(state, location, 'archive-entry-limit', `expanded entry count exceeds ${MAX_ENTRIES}`);
    return;
  }

  for (const [entryName, entry] of entries) {
    const nestedLocation = `${location}!/${entryName}`;
    if (forbiddenPath(entryName) >= 0) {
      addFinding(state, nestedLocation, 'forbidden-path', 'case-insensitive branding match');
    }
    if (entry.dir) continue;
    let bytes;
    try {
      bytes = Buffer.from(await entry.async('uint8array'));
    } catch (error) {
      addFinding(state, nestedLocation, 'unreadable-entry',
        error instanceof Error ? error.message : String(error));
      continue;
    }
    if (state.expandedBytesScanned + bytes.length > MAX_EXPANDED_BYTES) {
      addFinding(state, nestedLocation, 'expanded-size-limit',
        `expanded content exceeds ${MAX_EXPANDED_BYTES} bytes`);
      return;
    }
    await inspectBytes(bytes, nestedLocation, state, depth + 1);
  }
}

export async function auditReleaseTarget(target, options = {}) {
  const absolute = path.resolve(target);
  if (!existsSync(absolute)) throw new Error(`Audit target does not exist: ${target}`);
  const state = newState(path.basename(absolute));
  const info = statSync(absolute);
  if (info.isDirectory()) {
    const files = walk(absolute, '', [], options.excludeRootMetadata === true);
    for (const file of files) {
      state.files += 1;
      if (file.symbolicLink) {
        addFinding(state, file.relative, 'symbolic-link', 'customer trees must contain regular files only');
        continue;
      }
      if (forbiddenPath(file.relative) >= 0) {
        addFinding(state, file.relative, 'forbidden-path', 'case-insensitive branding match');
      }
      await inspectBytes(readFileSync(file.full), file.relative, state);
    }
  } else {
    state.files = 1;
    if (forbiddenPath(path.basename(absolute)) >= 0) {
      addFinding(state, path.basename(absolute), 'forbidden-path', 'case-insensitive branding match');
    }
    await inspectBytes(readFileSync(absolute), path.basename(absolute), state);
  }
  return {
    schema: FIXED_REPORT_SCHEMA,
    product: 'BESSForge',
    version: '1.0.1',
    owner: 'ECI Electrical Consultants, Inc.',
    result: state.findings.length === 0 ? 'PASS' : 'FAIL',
    ...state,
  };
}

export function writeAuditReport(report, destination) {
  const stable = `${JSON.stringify(report, null, 2)}\n`;
  writeFileSync(destination, stable);
  return createHash('sha256').update(stable).digest('hex');
}

export function assertAuditPassed(report) {
  if (report.result !== 'PASS') {
    const first = report.findings[0];
    throw new Error(`Release audit failed with ${report.findings.length} finding(s); first: ` +
      `${first?.kind ?? 'unknown'} at ${first?.location ?? 'unknown'}`);
  }
}

async function cli() {
  const target = process.argv[2] ? path.resolve(process.argv[2]) : ROOT;
  const reportIndex = process.argv.indexOf('--report');
  const destination = reportIndex >= 0
    ? path.resolve(process.argv[reportIndex + 1])
    : path.join(ROOT, 'dist', 'release-audit-report.json');
  const report = await auditReleaseTarget(target, {
    excludeRootMetadata: target === ROOT,
  });
  writeAuditReport(report, destination);
  console.log(`${report.result}: audited ${report.files} files and ${report.archiveEntries} archive entries`);
  console.log(`Report: ${path.relative(ROOT, destination)}`);
  assertAuditPassed(report);
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  cli().catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}