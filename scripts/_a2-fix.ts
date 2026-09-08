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

const properCross = (a: Pt, b: Pt, c: Pt, d: Pt) => {
  const o = (p: Pt, q: Pt, r: Pt) =>
    Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
  const o1 = o(a, b, c), o2 = o(a, b, d), o3 = o(c, d, a), o4 = o(c, d, b);
  return o1 !== 0 && o2 !== 0 && o3 !== 0 && o4 !== 0 && o1 !== o2 && o3 !== o4;
};

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
  const area = areas.find(a => /AREA\s*2/i.test(a.name))!;
  const items = plan.items.filter(it => pointInPolygon({ x: it.pose.cx, y: it.pose.cy }, area.polygon));
  const pcs = items.filter(i => i.kind === 'inverter' && !i.augmented && !i.future);
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
  const feeders = generateFeeders(
    { ...design, equipment: equipmentForRouting(design.equipment),
      tracedPcsUnits: design.tracedPcsUnits || pcs.length },
    sub, config.blockMW, { maxPerFeeder: 5, approach: 'N' });

  const invs = design.equipment.filter(e => e.kind === 'inverter');
  const xs = invs.map(e => e.x).sort((a, b) => a - b);
  const midX = (xs[0] + xs[xs.length - 1]) / 2;
  const leftMax = Math.max(...invs.filter(e => e.x < midX).map(e => e.x));
  const rightMin = Math.min(...invs.filter(e => e.x >= midX).map(e => e.x));
  const leftXs = invs.filter(e => e.x < midX).map(e => e.x);
  const rightXs = invs.filter(e => e.x >= midX).map(e => e.x);
  const gap = {
    x1: Math.max(...leftXs) + 25,
    x2: Math.min(...rightXs) - 25,
  };
  const yLo = Math.min(...invs.map(e => e.y)) + 10;
  const yHi = Math.max(...invs.map(e => e.y)) - 10;
  console.log('sub', sub.x.toFixed(0), sub.y.toFixed(0), 'n', feeders.length,
    'gap', gap.x1.toFixed(0), gap.x2.toFixed(0), 'y', yLo.toFixed(0), yHi.toFixed(0));

  const homes = feeders.map(f => {
    const home = f.segments[f.segments.length - 1]?.pts ?? [];
    const launch = invs.find(e => f.inverterIds.includes(e.id));
    return { f, home, launch };
  });

  for (const h of homes) {
    let gapHits = 0;
    for (let i = 0; i < h.home.length - 1; i++) {
      const a = h.home[i], b = h.home[i + 1];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      const n = Math.max(2, Math.ceil(len / 4));
      for (let s = 1; s < n; s++) {
        const t = s / n;
        const x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t;
        if (x > gap.x1 && x < gap.x2 && y > yLo && y < yHi) gapHits++;
      }
    }
    const tail = h.home.slice(-5).map(p => `${p.x.toFixed(0)},${p.y.toFixed(0)}`).join('→');
    console.log(`F${h.f.idx} ${feederColor(h.f.idx).hex} launch=${h.launch?.x.toFixed(0)},${h.launch?.y.toFixed(0)} gap=${gapHits} ${tail}`);
  }

  let crosses = 0;
  for (let i = 0; i < homes.length; i++) {
    for (let j = i + 1; j < homes.length; j++) {
      const A = homes[i].home, B = homes[j].home;
      for (let p = 0; p < A.length - 1; p++) {
        for (let q = 0; q < B.length - 1; q++) {
          if (properCross(A[p], A[p + 1], B[q], B[q + 1])) {
            crosses++;
            console.log(`CROSS F${homes[i].f.idx}xF${homes[j].f.idx}`,
              `${A[p].x.toFixed(0)},${A[p].y.toFixed(0)}-${A[p + 1].x.toFixed(0)},${A[p + 1].y.toFixed(0)}`,
              `${B[q].x.toFixed(0)},${B[q].y.toFixed(0)}-${B[q + 1].x.toFixed(0)},${B[q + 1].y.toFixed(0)}`);
          }
        }
      }
    }
  }
  console.log('crosses', crosses);
}
main().catch(e => { console.error(e); process.exit(1); });
