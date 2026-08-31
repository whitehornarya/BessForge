/**
 * Assert drawSurfacing no longer strokes equipment-pad gravel holes
 * (the light-gray "outer shell" under PCS/BESS symbols).
 */
import { DOMParser } from '@xmldom/xmldom';
(globalThis as any).DOMParser = DOMParser;

import { readFileSync } from 'fs';
import path from 'path';
import JSZip from 'jszip';
import { parseKmlText } from '../client/src/lib/nextera/kmz';
import { generateSiteDesign } from '../client/src/lib/nextera/layoutEngine';
import { getEffectiveConfiguration } from '../client/src/lib/nextera/catalog';
import { DxfWriter, LAYERS, drawSurfacing } from '../client/src/lib/nextera/dxfExport';

function near(a: number, b: number, eps = 0.05) {
  return Math.abs(a - b) < eps;
}

async function main() {
  const buf = readFileSync(path.join('client', 'public', 'samples', 'hondo-100mw.kmz'));
  const zip = await JSZip.loadAsync(buf);
  const kml = Object.values(zip.files).find(f => f.name.toLowerCase().endsWith('.kml'));
  if (!kml) throw new Error('no kml');
  const hondo = parseKmlText(await kml.async('text'), 'hondo');
  const config = getEffectiveConfiguration('ge-aux-400', 3);
  const design = generateSiteDesign(hondo, config, 100, 400, { hotClimate: true });
  if (!design.surfacing?.regions.length) throw new Error('no surfacing regions');

  const holeCount = design.surfacing.regions.reduce((n, r) => n + r.holes.length, 0);
  if (holeCount < 10) throw new Error(`expected many pad holes, got ${holeCount}`);

  const dxf = new DxfWriter();
  drawSurfacing(dxf, design, false);

  const gravelPolys = dxf.ops.filter(
    (op): op is Extract<typeof op, { kind: 'poly' }> =>
      op.kind === 'poly' && op.layer === LAYERS.GRAVEL
  );
  const outerCount = design.surfacing.regions.length;
  if (gravelPolys.length !== outerCount) {
    throw new Error(
      `expected ${outerCount} GRAVEL outer polylines, got ${gravelPolys.length} ` +
      `(pad hole strokes should be gone; holes in data=${holeCount})`
    );
  }

  // No GRAVEL polyline should match an equipment footprint (4-corner pad).
  for (const eq of design.equipment.filter(e => e.kind === 'bess' || e.kind === 'inverter')) {
    const hl = eq.length / 2, hw = eq.width / 2;
    const c = Math.cos(eq.rotation), s = Math.sin(eq.rotation);
    const corners = ([[-hl, -hw], [hl, -hw], [hl, hw], [-hl, hw]] as [number, number][])
      .map(([px, py]) => [eq.x + px * c - py * s, eq.y + px * s + py * c] as [number, number]);
    for (const op of gravelPolys) {
      if (op.pts.length < 4) continue;
      const hit = corners.every(corner =>
        op.pts.some(p => near(p[0], corner[0]) && near(p[1], corner[1]))
      );
      if (hit) {
        throw new Error(`GRAVEL polyline still traces ${eq.kind} pad at (${eq.x.toFixed(1)},${eq.y.toFixed(1)})`);
      }
    }
  }

  // mesh=true still hatches with holes (even-odd), still no hole strokes.
  const dxfMesh = new DxfWriter();
  drawSurfacing(dxfMesh, design, true);
  const meshPolys = dxfMesh.ops.filter(op => op.kind === 'poly' && op.layer === LAYERS.GRAVEL);
  const meshHatches = dxfMesh.ops.filter(op => op.kind === 'hatch' && op.layer === LAYERS.GRAVEL);
  if (meshPolys.length !== outerCount) {
    throw new Error(`mesh mode: expected ${outerCount} polylines, got ${meshPolys.length}`);
  }
  if (!meshHatches.length) throw new Error('mesh mode: expected GRAVEL hatches');
  for (const h of meshHatches) {
    if (h.kind !== 'hatch') continue;
    if (h.loops.length < 2) throw new Error('mesh hatch should include pad holes for even-odd');
  }

  console.log('ok', {
    regions: outerCount,
    padHolesInData: holeCount,
    gravelPolylines: gravelPolys.length,
    meshHatches: meshHatches.length,
  });
}

main().catch(e => { console.error(e); process.exit(1); });
