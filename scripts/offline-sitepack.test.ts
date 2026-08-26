import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { importSitePack } from '../client/src/lib/offline/sitePack';

function findSignatures(bytes: Uint8Array, signature: number): number[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const offsets: number[] = [];
  for (let offset = 0; offset + 4 <= bytes.byteLength; offset++) {
    if (view.getUint32(offset, true) === signature) offsets.push(offset);
  }
  return offsets;
}

function replaceAscii(bytes: Uint8Array, from: string, to: string): Uint8Array {
  assert.equal(from.length, to.length);
  const result = bytes.slice();
  const source = new TextEncoder().encode(from);
  const replacement = new TextEncoder().encode(to);
  let replacements = 0;
  for (let offset = 0; offset + source.length <= result.length; offset++) {
    if (source.every((byte, index) => result[offset + index] === byte)) {
      result.set(replacement, offset);
      replacements++;
      offset += source.length - 1;
    }
  }
  assert.ok(replacements >= 2, 'expected to replace local and central filenames');
  return result;
}

async function emptyPack(): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file('manifest.json', JSON.stringify({
    format: 'bessforge-site-pack', version: 1, createdAt: new Date(0).toISOString(),
    site: { lat: 35, lon: -100 }, entries: [],
  }));
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

const normal = await importSitePack(await emptyPack());
assert.deepEqual(normal, { imported: 0, site: { lat: 35, lon: -100 } });

const traversal = new JSZip();
traversal.file('manifest.json', JSON.stringify({
  format: 'bessforge-site-pack', version: 1, createdAt: new Date(0).toISOString(),
  site: { lat: 35, lon: -100 }, entries: [],
}));
traversal.file('../escape.json', '{}');
const traversalBytes = await traversal.generateAsync({ type: 'uint8array' });
await assert.rejects(
  () => importSitePack(traversalBytes),
  /unsafe or excessive entries/,
);

const duplicate = new JSZip();
duplicate.file('manifest.json', '{}');
duplicate.file('data/000.json', '{}');
duplicate.file('data/001.json', '{}');
const duplicateBytes = replaceAscii(
  await duplicate.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }),
  'data/001.json',
  'data/000.json',
);
await assert.rejects(
  () => importSitePack(duplicateBytes),
  /duplicate entry/,
);

const forgedSize = new JSZip();
forgedSize.file('manifest.json', JSON.stringify({
  format: 'bessforge-site-pack', version: 1, createdAt: new Date(0).toISOString(),
  site: { lat: 35, lon: -100 },
  entries: [{ path: 'data/000.json', sha256: '0'.repeat(64), size: 1, key: 'https://api.example/api/geocode?lat=35&lon=-100' }],
}));
forgedSize.file('data/000.json', 'A'.repeat(2 * 1024 * 1024));
const forgedSizeBytes = await forgedSize.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 9 } });
const forgedSizeView = new DataView(forgedSizeBytes.buffer, forgedSizeBytes.byteOffset, forgedSizeBytes.byteLength);
const forgedCentral = findSignatures(forgedSizeBytes, 0x02014b50)
  .find(offset => new TextDecoder().decode(forgedSizeBytes.subarray(offset + 46, offset + 59)) === 'data/000.json');
assert.notEqual(forgedCentral, undefined);
const forgedLocal = forgedSizeView.getUint32(forgedCentral! + 42, true);
forgedSizeView.setUint32(forgedCentral! + 24, 1, true);
forgedSizeView.setUint32(forgedLocal + 22, 1, true);
await assert.rejects(
  () => importSitePack(forgedSizeBytes),
  /exceeded its declared or permitted size/,
);

const badCrcBytes = await emptyPack();
const badCrcView = new DataView(badCrcBytes.buffer, badCrcBytes.byteOffset, badCrcBytes.byteLength);
const badCrcCentral = findSignatures(badCrcBytes, 0x02014b50)[0];
assert.notEqual(badCrcCentral, undefined);
const badCrcLocal = badCrcView.getUint32(badCrcCentral + 42, true);
const forgedCrc = (badCrcView.getUint32(badCrcCentral + 16, true) ^ 0xffffffff) >>> 0;
badCrcView.setUint32(badCrcCentral + 16, forgedCrc, true);
badCrcView.setUint32(badCrcLocal + 14, forgedCrc, true);
await assert.rejects(
  () => importSitePack(badCrcBytes),
  /ZIP integrity check failed/,
);

const badHash = new JSZip();
badHash.file('manifest.json', JSON.stringify({
  format: 'bessforge-site-pack', version: 1, createdAt: new Date(0).toISOString(),
  site: { lat: 35, lon: -100 },
  entries: [{ path: 'data/000.json', sha256: '0'.repeat(64), size: 2, key: 'https://api.example/api/geocode?lat=35&lon=-100' }],
}));
badHash.file('data/000.json', '{}');
const badHashBytes = await badHash.generateAsync({ type: 'uint8array' });
await assert.rejects(
  () => importSitePack(badHashBytes),
  /integrity check failed/,
);

console.log('offline-sitepack.test.ts: all assertions passed');