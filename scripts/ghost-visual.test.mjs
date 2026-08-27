/**
 * Focused ghost-material regression from the realistic-3D handoff.
 * Ghost models share cached GLTF materials with live instances; clones must
 * restore pre-tint shader hooks instead of inheriting aFeederTint.
 *
 * Run: npm run test:ghost-visual
 */
import * as THREE from 'three';
import {
  cloneMaterialWithoutFeederTint,
  patchMaterialWithFeederTint,
} from '../client/src/lib/feederTint';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

const realisticSrc = readFileSync(
  path.join(ROOT, 'client/src/components/RealisticEquipment.tsx'),
  'utf8',
);
if (!/cloneMaterialWithoutFeederTint\(/.test(realisticSrc)) {
  fail('RealisticEquipment must clone ghost materials without feeder tint');
}

const tintedMaterial = new THREE.MeshStandardMaterial();
const sourceCompile = tintedMaterial.onBeforeCompile;
tintedMaterial.customProgramCacheKey = () => 'source-material';
patchMaterialWithFeederTint(tintedMaterial);
const ghostMaterial = cloneMaterialWithoutFeederTint(tintedMaterial);
if (
  ghostMaterial.userData.feederTintPatched === true ||
  ghostMaterial.onBeforeCompile !== sourceCompile ||
  ghostMaterial.customProgramCacheKey() !== 'source-material' ||
  ghostMaterial.customProgramCacheKey().includes('feederTint')
) {
  fail('ghost material clone must restore original shader hooks without feeder tint');
}
ghostMaterial.dispose();
tintedMaterial.dispose();
console.log('PASS ghost-visual: untinted ghost material clone');
