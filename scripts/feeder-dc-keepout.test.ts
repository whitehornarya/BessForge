// Direct DC is not an MV keep-out. Under-PCS hops stay on the skid
// centerline even when a Direct-style DC fan occupies the same channel.
import { generateCableRouting } from '../client/src/lib/nextera/cableRouting';
import { generateFeeders } from '../client/src/lib/nextera/feeders';
import type { Pt } from '../client/src/lib/nextera/types';

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
};

const fence: Pt[] = [
  { x: -200, y: -200 }, { x: 400, y: -200 },
  { x: 400, y: 200 }, { x: -200, y: 200 },
];

const pcs = (id: string, x: number, traced: boolean) => ({
  id, kind: 'inverter' as const, label: id,
  x, y: 0, rotation: 0, length: 40, width: 10,
  ...(traced ? { traceSourcePose: { x, y: 0, rotationDeg: 0, lengthFt: 40, widthFt: 10 } } : {}),
});

console.log('feeder DC keep-out / under-PCS joins');

for (const traced of [false, true]) {
  const equipment = [pcs('inv-a', 0, traced), pcs('inv-b', 80, traced)];
  const routing = generateCableRouting(equipment as never, [], fence);
  const drops = routing.cables.filter(c => c.id.startsWith('mv-drop-'));
  const centerline = drops.length === 2 && drops.every(d => {
    const join = d.pts[d.pts.length - 1];
    const inv = equipment.find(e => d.id === `mv-drop-${e.id}`)!;
    return Math.abs(join.y - inv.y) < 1e-6 && Math.abs(join.x - (inv.x + (inv.length / 2 - 1.2))) < 1e-4;
  });
  check(`${traced ? 'traced' : 'auto-row'} mv-drop collector lands on PCS centerline`,
    centerline, `drops=${drops.length}`);
}

const dcFan: Pt[] = [
  { x: 0, y: -8 }, { x: 40, y: 8 }, { x: 80, y: -8 },
];
const drop = (id: string, x: number) => ({
  id: `mv-drop-${id}`, class: 'MV' as const,
  pts: [{ x: x + 18.8, y: 5 }, { x: x + 18.8, y: 0 }],
});

for (const [label, tracedPcsUnits] of [['scan', 2], ['prescan', 0]] as const) {
  const design = {
    fence, boundary: { polygon: fence },
    equipment: [pcs('inv-a', 0, false), pcs('inv-b', 80, false)],
    cables: [
      drop('inv-a', 0), drop('inv-b', 80),
      { id: 'dc-fan-pos', class: 'DC' as const, pts: dcFan, polarity: 'pos' as const },
    ],
    aisles: [], roads: [], tracedPcsUnits,
  } as any;
  const feeders = generateFeeders(design, { x: 200, y: 80 }, 5, { maxPerFeeder: 2 });
  const hops = feeders.flatMap(f => f.segments.slice(0, -1));
  const under = hops.length >= 1 && hops.every(seg =>
    seg.pts.length === 2 &&
    seg.pts.every(p => Math.abs(p.y) < 1e-6));
  check(`${label}: under-row hop stays 2-point on PCS y with Direct DC present`,
    under, `feeders=${feeders.length} hops=${hops.length}`);
}

if (failures) {
  console.log(`\n${failures} feeder DC keep-out check(s) FAILED`);
  process.exit(1);
}
console.log('\nfeeder DC keep-out / under-PCS joins OK');
