import { readFileSync } from 'fs';
import path from 'path';
import JSZip from 'jszip';
import {
  parseKmlAreas, parseKmlDrawing, listKmlBoundaryOptions, inferAreaKind, pointInPolygon,
} from '../client/src/lib/nextera/kmz';
import { analyzeReferenceDrawing } from '../client/src/lib/nextera/referenceTrace';
import { generateSiteDesign, equipmentForRouting } from '../client/src/lib/nextera/layoutEngine';
import { getConfiguration } from '../client/src/lib/nextera/catalog';
import { generateFeeders } from '../client/src/lib/nextera/feeders';
import { feederColor } from '../client/src/lib/nextera/feederColors';
import type { Pt } from '../client/src/lib/nextera/types';

async function main() {
  const kmz = path.resolve('assets/BIG_IRON_BESS_LAYOUT_-_03_v10 1.kmz');
  const zip = await JSZip.loadAsync(readFileSync(kmz));
  const entry = Object.values(zip.files).find(f => f.name.toLowerCase().endsWith('.kml'));
  const kml = await entry!.async('text');
  const options = listKmlBoundaryOptions(kml);
  const areas = parseKmlAreas(kml, 'BIG IRON BESS', options.map(o => o.index));
  const drawing = parseKmlDrawing(kml, 'BIG IRON BESS', areas[0].origin);
  const plan = analyzeReferenceDrawing(drawing);
  const config = getConfiguration('ge-aux-400');
  let bad = 0;
  for (const area of areas.filter(a => inferAreaKind(a.name) === 'bess')) {
    const items = plan.items.filter(it => pointInPolygon({ x: it.pose.cx, y: it.pose.cy }, area.polygon));
    const pcs = items.filter(i => i.kind === 'inverter' && !i.augmented && !i.future);
    if (!pcs.length) continue;
    const placedEquipment = items.map((it, i) => ({
      id: `peq-${i + 1}`, kind: it.kind, label: it.kind,
      x: it.pose.cx, y: it.pose.cy,
      lengthFt: it.pose.lengthFt, widthFt: it.pose.widthFt,
      rotationDeg: it.pose.rotationDeg, source: 'trace' as const,
    }));
    const customRoads: { id: string; pts: Pt[]; width?: number; traced?: boolean }[] = [];
    let ri = 1;
    for (const road of plan.roads) {
      for (const s of road.strips) {
        const mid = s.pts[Math.floor(s.pts.length / 2)];
        if (!mid || !pointInPolygon(mid, area.polygon)) continue;
        customRoads.push({ id: `troad-${ri++}`, pts: s.pts, width: s.widthFt, traced: true });
      }
    }
    const cx = pcs.reduce((s, p) => s + p.pose.cx, 0) / pcs.length;
    const cy = pcs.reduce((s, p) => s + p.pose.cy, 0) / pcs.length;
    const sub = (plan.substations.map(s => ({ x: s.pose.cx, y: s.pose.cy }))
      .sort((a, b) => Math.hypot(a.x - cx, a.y - cy) - Math.hypot(b.x - cx, b.y - cy))[0])
      ?? { x: cx, y: cy };
    const design = generateSiteDesign(area, config, 125, 500, {
      hotClimate: true, multiArea: true, autoRoadWrap: false,
      fencePlacement: 'property-line',
      constraints: { placedEquipment, customRoads },
    });
    const approach = /AREA\s*4/i.test(area.name) ? 'W' as const
      : /AREA\s*1/i.test(area.name) ? 'S' as const
      : 'N' as const;
    const feeders = generateFeeders(
      { ...design, equipment: equipmentForRouting(design.equipment),
        tracedPcsUnits: design.tracedPcsUnits || pcs.length },
      sub, config.blockMW, { maxPerFeeder: 5, approach });
    const bessBoxes = design.equipment
      .filter(e => e.kind === 'bess' && !e.augmented && !e.future)
      .map(e => ({
        x1: e.x - e.length / 2, y1: e.y - e.width / 2,
        x2: e.x + e.length / 2, y2: e.y + e.width / 2,
      }));
    const want = new Set(
      /AREA\s*4/i.test(area.name) ? [6, 8] :
      /AREA\s*1/i.test(area.name) ? [5, 3] :
      /AREA\s*3/i.test(area.name) ? [3, 6] : [3, 5, 6, 8]);
    for (const f of feeders) {
      const home = f.segments[f.segments.length - 1]?.pts ?? [];
      let hits = 0;
      for (let i = 0; i < home.length - 1; i++) {
        const a = home[i], b = home[i + 1];
        const samples = Math.max(2, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 3));
        for (let s = 1; s < samples; s++) {
          const t = s / samples;
          const x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t;
          if (bessBoxes.some(r => x > r.x1 + 0.5 && x < r.x2 - 0.5 && y > r.y1 + 0.5 && y < r.y2 - 0.5)) hits++;
        }
      }
      if (want.has(f.idx) || hits > 0) {
        console.log(`${area.name} F${f.idx} ${feederColor(f.idx).hex} can=${hits} ` +
          home.slice(0, 6).map(p => `${p.x.toFixed(0)},${p.y.toFixed(0)}`).join('→'));
      }
      bad += hits;
    }
  }
  console.log(`totalCanHits=${bad}`);
  if (bad > 0) process.exit(1);
}
main().catch(e => { console.error(e); process.exit(1); });
