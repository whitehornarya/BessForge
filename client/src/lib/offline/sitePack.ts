import JSZip from 'jszip';
import { apiFetchJson } from '../api/fetch';
import { listCacheRecords, importCacheRecord, sha256Hex, type OfflineCacheRecord } from './cache';

export const SITE_PACK_VERSION = 1;
const MAX_ENTRIES = 400;
const MAX_ENTRY_BYTES = 48 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
const MAX_TOTAL_UNCOMPRESSED_BYTES = 128 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;

export interface SitePackSite {
  lat: number;
  lon: number;
  satelliteBbox?: { west: number; east: number; south: number; north: number };
  terrainBbox?: { west: number; east: number; south: number; north: number };
}
interface ManifestEntry { path: string; sha256: string; size: number; key: string }
interface SitePackManifest {
  format: 'bessforge-site-pack';
  version: 1;
  createdAt: string;
  site: { lat: number; lon: number };
  entries: ManifestEntry[];
}

function validSite(site: SitePackSite): void {
  if (!Number.isFinite(site.lat) || Math.abs(site.lat) > 90 ||
      !Number.isFinite(site.lon) || Math.abs(site.lon) > 180) throw new Error('Site coordinates are invalid');
}

export async function prefetchSiteData(site: SitePackSite): Promise<void> {
  validSite(site);
  const calls: Promise<unknown>[] = [
    apiFetchJson('/api/geocode', { lat: site.lat, lon: site.lon }, { provenance: 'US Census TIGERweb' }),
    apiFetchJson('/api/vicinity', { lat: site.lat, lon: site.lon }, { provenance: 'US Census TIGERweb' }),
    apiFetchJson('/api/rainfall', { lat: site.lat, lon: site.lon }, { provenance: 'NOAA Atlas 14' }),
  ];
  if (site.terrainBbox) calls.push(apiFetchJson('/api/elevation', { ...site.terrainBbox, size: 96 }, { provenance: 'USGS 3DEP' }));
  if (site.satelliteBbox) calls.push(apiFetchJson('/api/satellite', {
    lat: site.lat, lon: site.lon, west: site.satelliteBbox.west, east: site.satelliteBbox.east,
    north: site.satelliteBbox.north, south: site.satelliteBbox.south,
  }, { provenance: 'Cesium ion / Bing proxy' }));
  const results = await Promise.allSettled(calls);
  const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failures.length) throw new Error(`Site prefetch incomplete: ${failures.map(f => f.reason instanceof Error ? f.reason.message : String(f.reason)).join('; ')}`);
}

export async function exportSitePack(site: SitePackSite): Promise<Blob> {
  validSite(site);
  const candidates = (await listCacheRecords()).filter(r => {
    try {
      const u = new URL(r.key);
      const lat = Number(u.searchParams.get('lat'));
      const lon = Number(u.searchParams.get('lon'));
      if (Number.isFinite(lat) && Number.isFinite(lon)) return Math.abs(lat - site.lat) < 1e-7 && Math.abs(lon - site.lon) < 1e-7;
      return !!site.terrainBbox && r.endpoint === '/api/elevation' &&
        ['west', 'east', 'south', 'north'].every(k => u.searchParams.get(k) === String(site.terrainBbox![k as keyof typeof site.terrainBbox]));
    } catch { return false; }
  });
  const records = [];
  for (const record of candidates) {
    if (record.size === new TextEncoder().encode(record.body).byteLength &&
        await sha256Hex(record.body) === record.sha256) records.push(record);
  }
  if (!records.length) throw new Error('No cached data exists for this site; prefetch it first');
  const zip = new JSZip();
  const entries: ManifestEntry[] = [];
  for (let i = 0; i < records.length; i++) {
    const path = `data/${i.toString().padStart(3, '0')}.json`;
    const text = JSON.stringify(records[i]);
    zip.file(path, text);
    entries.push({ path, sha256: await sha256Hex(text), size: new TextEncoder().encode(text).byteLength, key: records[i].key });
  }
  const manifest: SitePackManifest = {
    format: 'bessforge-site-pack', version: SITE_PACK_VERSION,
    createdAt: new Date().toISOString(), site: { lat: site.lat, lon: site.lon }, entries,
  };
  zip.file('manifest.json', JSON.stringify(manifest, null, 2));
  return zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}

function safePath(path: string): boolean {
  return /^(manifest\.json|data\/[A-Za-z0-9._-]+\.json)$/.test(path) && !path.includes('..') && !path.startsWith('/');
}

interface CentralDirectoryEntry {
  name: string;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  method: number;
  flags: number;
}

function readUint16(view: DataView, offset: number): number {
  if (offset < 0 || offset + 2 > view.byteLength) throw new Error('Site pack ZIP structure is truncated');
  return view.getUint16(offset, true);
}

function readUint32(view: DataView, offset: number): number {
  if (offset < 0 || offset + 4 > view.byteLength) throw new Error('Site pack ZIP structure is truncated');
  return view.getUint32(offset, true);
}

function equalBytes(a: Uint8Array, aOffset: number, b: Uint8Array): boolean {
  if (aOffset < 0 || aOffset + b.byteLength > a.byteLength) return false;
  for (let i = 0; i < b.byteLength; i++) if (a[aOffset + i] !== b[i]) return false;
  return true;
}

function decodeZipName(bytes: Uint8Array, utf8: boolean): string {
  if (!utf8 && bytes.some(byte => byte > 0x7f)) throw new Error('Site pack contains an unsupported filename encoding');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('Site pack contains an invalid filename');
  }
}

function validateExtraFields(bytes: Uint8Array): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  while (offset < bytes.byteLength) {
    if (offset + 4 > bytes.byteLength) throw new Error('Site pack ZIP extra field is malformed');
    const id = readUint16(view, offset);
    const size = readUint16(view, offset + 2);
    offset += 4;
    if (offset + size > bytes.byteLength) throw new Error('Site pack ZIP extra field is malformed');
    if (id === 0x0001) throw new Error('ZIP64 site packs are not supported');
    offset += size;
  }
}

function parseCentralDirectory(bytes: Uint8Array): CentralDirectoryEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const minimumEocd = 22;
  let eocd = -1;
  const searchStart = Math.max(0, bytes.byteLength - minimumEocd - 0xffff);
  for (let offset = bytes.byteLength - minimumEocd; offset >= searchStart; offset--) {
    if (readUint32(view, offset) === 0x06054b50 &&
        offset + minimumEocd + readUint16(view, offset + 20) === bytes.byteLength) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new Error('Site pack ZIP central directory is missing or malformed');
  if ((eocd >= 20 && readUint32(view, eocd - 20) === 0x07064b50) ||
      readUint16(view, eocd + 8) === 0xffff || readUint16(view, eocd + 10) === 0xffff ||
      readUint32(view, eocd + 12) === 0xffffffff || readUint32(view, eocd + 16) === 0xffffffff) {
    throw new Error('ZIP64 site packs are not supported');
  }
  const diskEntries = readUint16(view, eocd + 8);
  const entryCount = readUint16(view, eocd + 10);
  if (readUint16(view, eocd + 4) !== 0 || readUint16(view, eocd + 6) !== 0 || diskEntries !== entryCount) {
    throw new Error('Multi-disk site packs are not supported');
  }
  if (entryCount > MAX_ENTRIES + 1) throw new Error('Site pack contains unsafe or excessive entries');
  const centralSize = readUint32(view, eocd + 12);
  const centralOffset = readUint32(view, eocd + 16);
  if (centralOffset + centralSize !== eocd || centralOffset > eocd) {
    throw new Error('Site pack ZIP central directory bounds are inconsistent');
  }

  const entries: CentralDirectoryEntry[] = [];
  const names = new Set<string>();
  let offset = centralOffset;
  let declaredTotal = 0;
  for (let index = 0; index < entryCount; index++) {
    if (readUint32(view, offset) !== 0x02014b50 || offset + 46 > eocd) {
      throw new Error('Site pack ZIP central directory is malformed');
    }
    const versionMadeBy = readUint16(view, offset + 4);
    const flags = readUint16(view, offset + 8);
    const method = readUint16(view, offset + 10);
    const crc32 = readUint32(view, offset + 16);
    const compressedSize = readUint32(view, offset + 20);
    const uncompressedSize = readUint32(view, offset + 24);
    const nameLength = readUint16(view, offset + 28);
    const extraLength = readUint16(view, offset + 30);
    const commentLength = readUint16(view, offset + 32);
    const diskStart = readUint16(view, offset + 34);
    const externalAttributes = readUint32(view, offset + 38);
    const localOffset = readUint32(view, offset + 42);
    const end = offset + 46 + nameLength + extraLength + commentLength;
    if (end > eocd || diskStart !== 0) throw new Error('Site pack ZIP central directory bounds are inconsistent');
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new Error('ZIP64 site packs are not supported');
    }
    if ((flags & 0x0001) !== 0 || (flags & ~(0x0006 | 0x0008 | 0x0800)) !== 0) {
      throw new Error('Encrypted or unsupported ZIP entries are not allowed');
    }
    if (method !== 0 && method !== 8) throw new Error('Site pack contains an unsupported compression method');
    if (method === 0 && (flags & 0x0006) !== 0) throw new Error('Site pack contains unsupported ZIP flags');
    const nameBytes = bytes.subarray(offset + 46, offset + 46 + nameLength);
    const name = decodeZipName(nameBytes, (flags & 0x0800) !== 0);
    validateExtraFields(bytes.subarray(offset + 46 + nameLength, offset + 46 + nameLength + extraLength));
    if (names.has(name)) throw new Error(`Site pack contains a duplicate entry: ${name}`);
    names.add(name);
    const isDirectory = name.endsWith('/');
    const unixMode = versionMadeBy >>> 8 === 3 ? externalAttributes >>> 16 : 0;
    if ((unixMode & 0xf000) === 0xa000) throw new Error('Site pack contains a symbolic link');
    if ((externalAttributes & 0x10) !== 0 && !isDirectory) throw new Error('Site pack contains inconsistent directory attributes');
    if ((isDirectory && name !== 'data/') || (!isDirectory && !safePath(name))) {
      throw new Error('Site pack contains unsafe or excessive entries');
    }
    if (isDirectory && (uncompressedSize !== 0 || compressedSize !== 0)) {
      throw new Error('Site pack contains an invalid directory entry');
    }
    if (uncompressedSize > MAX_ENTRY_BYTES) throw new Error(`Site pack entry is too large: ${name}`);
    declaredTotal += uncompressedSize;
    if (declaredTotal > MAX_TOTAL_UNCOMPRESSED_BYTES) throw new Error('Site pack uncompressed contents are too large');

    if (localOffset + 30 > centralOffset || readUint32(view, localOffset) !== 0x04034b50) {
      throw new Error('Site pack ZIP local header is missing or out of bounds');
    }
    const localFlags = readUint16(view, localOffset + 6);
    const localMethod = readUint16(view, localOffset + 8);
    const localNameLength = readUint16(view, localOffset + 26);
    const localExtraLength = readUint16(view, localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    if (localFlags !== flags || localMethod !== method ||
        !equalBytes(bytes, localOffset + 30, nameBytes) ||
        dataOffset > centralOffset || compressedSize > centralOffset - dataOffset) {
      throw new Error('Site pack ZIP local and central headers are inconsistent');
    }
    validateExtraFields(bytes.subarray(localOffset + 30 + localNameLength, dataOffset));
    if ((flags & 0x0008) === 0 &&
        (readUint32(view, localOffset + 14) !== crc32 ||
         readUint32(view, localOffset + 18) !== compressedSize ||
         readUint32(view, localOffset + 22) !== uncompressedSize)) {
      throw new Error('Site pack ZIP local and central sizes are inconsistent');
    }
    entries.push({ name, crc32, compressedSize, uncompressedSize, method, flags });
    offset = end;
  }
  if (offset !== centralOffset + centralSize) throw new Error('Site pack ZIP central directory count is inconsistent');
  return entries;
}

let crcTable: Uint32Array | undefined;
function updateCrc32(crc: number, bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let value = n;
      for (let bit = 0; bit < 8; bit++) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      crcTable[n] = value >>> 0;
    }
  }
  let value = crc ^ 0xffffffff;
  for (let index = 0; index < bytes.byteLength; index++) {
    value = crcTable[(value ^ bytes[index]) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

interface InternalStreamEntry extends JSZip.JSZipObject {
  internalStream(type: 'uint8array'): JSZip.JSZipStreamHelper<Uint8Array>;
}

async function extractBounded(
  file: JSZip.JSZipObject,
  declaration: CentralDirectoryEntry,
  total: { value: number },
): Promise<Uint8Array> {
  const output = new Uint8Array(declaration.uncompressedSize);
  const stream = (file as InternalStreamEntry).internalStream('uint8array');
  return new Promise((resolve, reject) => {
    let length = 0;
    let crc = 0;
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      stream.pause();
      reject(error);
    };
    stream.on('data', chunk => {
      if (settled) return;
      const nextLength = length + chunk.byteLength;
      const nextTotal = total.value + chunk.byteLength;
      if (nextLength > declaration.uncompressedSize || nextLength > MAX_ENTRY_BYTES ||
          nextTotal > MAX_TOTAL_UNCOMPRESSED_BYTES) {
        fail(new Error(`Site pack entry exceeded its declared or permitted size: ${declaration.name}`));
        return;
      }
      length = nextLength;
      total.value = nextTotal;
      crc = updateCrc32(crc, chunk);
      output.set(chunk, length - chunk.byteLength);
    });
    stream.on('error', error => fail(error));
    stream.on('end', () => {
      if (settled) return;
      settled = true;
      if (length !== declaration.uncompressedSize || crc !== declaration.crc32) {
        reject(new Error(`Site pack ZIP integrity check failed: ${declaration.name}`));
      } else {
        resolve(output);
      }
    });
    stream.resume();
  });
}

export async function importSitePack(input: Blob | ArrayBuffer | Uint8Array): Promise<{ imported: number; site: { lat: number; lon: number } }> {
  const inputSize = input instanceof Blob ? input.size : input.byteLength;
  if (inputSize > MAX_ARCHIVE_BYTES) throw new Error('Site pack is too large');
  const bytes = input instanceof Blob
    ? new Uint8Array(await input.arrayBuffer())
    : input instanceof Uint8Array ? input : new Uint8Array(input);
  const centralEntries = parseCentralDirectory(bytes);
  const declarations = new Map(centralEntries.map(entry => [entry.name, entry]));
  const zip = await JSZip.loadAsync(bytes);
  const files = Object.values(zip.files).filter(f => !f.dir);
  if (files.length > MAX_ENTRIES || files.some(f => !safePath(f.name)) ||
      centralEntries.filter(entry => !entry.name.endsWith('/')).length !== files.length) {
    throw new Error('Site pack contains unsafe or excessive entries');
  }
  const mf = zip.file('manifest.json');
  if (!mf) throw new Error('Site pack manifest is missing');
  const manifestDeclaration = declarations.get('manifest.json');
  if (!manifestDeclaration) throw new Error('Site pack manifest declaration is missing');
  if (manifestDeclaration.uncompressedSize > MAX_MANIFEST_BYTES) throw new Error('Site pack manifest is too large');
  const extractedTotal = { value: 0 };
  const manifestBytes = await extractBounded(mf, manifestDeclaration, extractedTotal);
  const manifestText = new TextDecoder().decode(manifestBytes);
  let manifest: SitePackManifest;
  try { manifest = JSON.parse(manifestText); } catch { throw new Error('Site pack manifest is invalid JSON'); }
  if (manifest.format !== 'bessforge-site-pack' || manifest.version !== SITE_PACK_VERSION ||
      !Array.isArray(manifest.entries) || manifest.entries.length > MAX_ENTRIES) throw new Error('Unsupported site pack format or version');
  validSite(manifest.site);
  const allowed = new Set(['manifest.json', ...manifest.entries.map(e => e.path)]);
  if (files.some(f => !allowed.has(f.name)) || allowed.size !== files.length) throw new Error('Site pack entries do not match its manifest');
  let total = 0;
  const records: OfflineCacheRecord[] = [];
  for (const entry of manifest.entries) {
    if (!safePath(entry.path) || !Number.isInteger(entry.size) || entry.size < 0 || entry.size > MAX_ENTRY_BYTES ||
        !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error('Site pack manifest contains an invalid entry');
    const file = zip.file(entry.path);
    if (!file) throw new Error(`Site pack entry is missing: ${entry.path}`);
    const declaration = declarations.get(entry.path);
    if (!declaration) throw new Error(`Site pack entry declaration is missing: ${entry.path}`);
    const entryBytes = await extractBounded(file, declaration, extractedTotal);
    total += entryBytes.byteLength;
    if (entryBytes.byteLength !== entry.size || total > MAX_TOTAL_UNCOMPRESSED_BYTES || await sha256Hex(entryBytes) !== entry.sha256) {
      throw new Error(`Site pack integrity check failed: ${entry.path}`);
    }
    let record: OfflineCacheRecord;
    try { record = JSON.parse(new TextDecoder().decode(entryBytes)); } catch { throw new Error(`Site pack entry is invalid: ${entry.path}`); }
    if (record.key !== entry.key) throw new Error(`Site pack cache key mismatch: ${entry.path}`);
    records.push(record);
  }
  for (const record of records) await importCacheRecord(record);
  return { imported: records.length, site: manifest.site };
}