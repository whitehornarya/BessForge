/**
 * Prove resolved PCS/BESS never also emit the addRotatedRect neutral fallback
 * on the canonical drawEquipment path (site plan / PDF display list).
 *
 * Run: npx tsx --tsconfig scripts/tsconfig.test.json scripts/check-equipment-fallback.ts
 */
import { DOMParser } from '@xmldom/xmldom';
(globalThis as any).DOMParser = DOMParser;

import { readFileSync } from 'fs';
import path from 'path';
import JSZip from 'jszip';
import { parseKmlText } from '../client/src/lib/nextera/kmz';
import { generateSiteDesign } from '../client/src/lib/nextera/layoutEngine';
import { getEffectiveConfiguration } from '../client/src/lib/nextera/catalog';
import { DxfWriter, addBaseLayers, drawEquipment } from '../client/src/lib/nextera/dxfExport';

const HONDO_KMZ = path.join('client', 'public', 'samples', 'hondo-100mw.kmz');

async function loadKmzBoundary(filePath: string) {
  const buf = readFileSync(filePath);
  const zip = await JSZip.loadAsync(buf);
  const kmlName = Object.keys(zip.files).find(n => n.toLowerCase().endsWith('.kml'));
  if (!kmlName) throw new Error(`No KML in ${filePath}`);
  const kmlText = await zip.file(kmlName)!.async('string');
  return parseKmlText(kmlText, path.basename(filePath, '.kmz'));
}

async function main() {
  const hondo = await loadKmzBoundary(HONDO_KMZ);

  for (const configId of ['ge-aux-400', 'pe-aux-200'] as const) {
    const config = getEffectiveConfiguration(configId, 3);
    const design = generateSiteDesign(hondo, config, 100, 400, { hotClimate: true });
    const pcsBess = design.equipment.filter(e =>
      (e.kind === 'inverter' || e.kind === 'bess') && !e.augmented && !e.future);
    if (!pcsBess.length) throw new Error(`${configId}: no built PCS/BESS`);

    const dxf = new DxfWriter();
    addBaseLayers(dxf);
    drawEquipment(dxf, design, config, false, true);

    const leaked = pcsBess.filter(eq =>
      dxf.ops.some(op =>
        op.provenance?.equipmentId === eq.id &&
        op.provenance.role === 'neutral-equipment-outline' &&
        op.provenance.symbolResolution === 'neutral-fallback'));
    const resolved = pcsBess.filter(eq =>
      dxf.ops.some(op =>
        op.provenance?.equipmentId === eq.id &&
        op.provenance.role === 'resolved-symbol'));

    console.log(`${configId}: PCS/BESS=${pcsBess.length} resolved=${resolved.length} leakedFallback=${leaked.length}`);
    if (resolved.length !== pcsBess.length) {
      throw new Error(`${configId}: expected all PCS/BESS resolved, got ${resolved.length}/${pcsBess.length}`);
    }
    if (leaked.length) {
      throw new Error(`${configId}: addRotatedRect fallback leaked for ${leaked.map(e => e.id).join(',')}`);
    }
  }
  console.log('OK — no addRotatedRect fallback under resolved PCS/BESS symbols');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
