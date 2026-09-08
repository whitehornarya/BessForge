// Feeder comb invariants across yard shapes.
//
// This deliberately asserts PROPERTIES rather than coordinates. The comb had
// been tuned against one customer drawing, so every regression it grew was
// phrased as "Area 2 looks right"; a lane-ordering bug that reversed the
// whole bundle still passed, because the fixtures were the same shape as the
// drawing that motivated them.
//
// The matrix is rotation x station side x row count x can facing. What is
// guaranteed, and therefore checked, is tiered:
//
//   ordering  (every case)  rows read across the bundle in distance order
//                           from the station, never interleaved
//   pad cuts  (every case)  no home run trenches a pad that is not its own
//   crossings (axis-aligned only)
//                           home runs never properly cross
//
// Crossings are NOT asserted on a rotated yard on purpose. Home-run legs are
// required to be axis-parallel (see the parallel-bundle check in
// nextera.test.ts), so on a tilted row an orthogonal comb cannot follow the
// drive aisle. Serving rotated sites cleanly needs angled trenches, which is
// a separate feature; until then the ordering and pad-cut guarantees are the
// ones that hold, and this test pins them so they cannot silently regress.
import { generateFeeders } from '../client/src/lib/nextera/feeders';
import type { Pt } from '../client/src/lib/nextera/types';

type Eq = {
  id: string; kind: 'inverter' | 'bess'; label: string;
  x: number; y: number; rotation: number; length: number; width: number;
};

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
};

const properCross = (a: Pt, b: Pt, c: Pt, d: Pt) => {
  const o = (p: Pt, q: Pt, r: Pt) =>
    Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
  const o1 = o(a, b, c), o2 = o(a, b, d), o3 = o(c, d, a), o4 = o(c, d, b);
  return o1 !== 0 && o2 !== 0 && o3 !== 0 && o4 !== 0 && o1 !== o2 && o3 !== o4;
};

const inRect = (p: Pt, e: Eq, inset: number) => {
  const c = Math.cos(-e.rotation), s = Math.sin(-e.rotation);
  const dx = p.x - e.x, dy = p.y - e.y;
  const lx = dx * c - dy * s, ly = dx * s + dy * c;
  return Math.abs(lx) < e.length / 2 - inset && Math.abs(ly) < e.width / 2 - inset;
};

const spin = (p: Pt, c: Pt, t: number): Pt => {
  const co = Math.cos(t), si = Math.sin(t);
  const dx = p.x - c.x, dy = p.y - c.y;
  return { x: c.x + dx * co - dy * si, y: c.y + dx * si + dy * co };
};

interface Case {
  theta: number;
  rows: number;
  station: 'N' | 'S';
  facing: 'S' | 'N' | 'alt';
}

const ROW_PITCH = 110;
const PCS_XS = [0, 120];
const cansNorthFor = (c: Case, r: number) =>
  c.facing === 'N' ? true : c.facing === 'S' ? false : r % 2 === 0;

const build = (c: Case) => {
  const pcs: Eq[] = [];
  const bess: Eq[] = [];
  for (let r = 0; r < c.rows; r++) {
    const y = r * ROW_PITCH;
    for (const x of PCS_XS) {
      const id = `inv-r${r}-x${x}`;
      pcs.push({ id, kind: 'inverter', label: id, x, y, rotation: 0, length: 22, width: 8 });
      const cy = y + (cansNorthFor(c, r) ? 26 : -26);
      for (let k = 0; k < 2; k++) {
        bess.push({
          id: `bess-${id}-${k}`, kind: 'bess', label: 'CON',
          x: x + (k ? 9 : -9), y: cy, rotation: 0, length: 16, width: 8,
        });
      }
    }
  }
  const midX = (PCS_XS[0] + PCS_XS[PCS_XS.length - 1]) / 2;
  const midY = ((c.rows - 1) * ROW_PITCH) / 2;
  const centre: Pt = { x: midX, y: midY };
  const reach = c.rows * ROW_PITCH + 500;
  const subRaw: Pt = { x: midX, y: c.station === 'N' ? midY + reach : midY - reach };
  const fenceRaw: Pt[] = [
    { x: midX - 700, y: midY - reach - 120 }, { x: midX + 700, y: midY - reach - 120 },
    { x: midX + 700, y: midY + reach + 120 }, { x: midX - 700, y: midY + reach + 120 },
  ];
  const turn = <T extends Eq>(e: T): T => {
    const p = spin(e, centre, c.theta);
    return { ...e, x: p.x, y: p.y, rotation: e.rotation + c.theta };
  };
  return {
    equipment: [...pcs.map(turn), ...bess.map(turn)],
    substation: spin(subRaw, centre, c.theta),
    fence: fenceRaw.map(p => spin(p, centre, c.theta)),
    pcs: pcs.map(turn),
  };
};

const evaluate = (c: Case) => {
  const { equipment, substation, fence, pcs } = build(c);
  // Derive the take-off letter from where the station actually ended up:
  // at theta ~ 90 the same template is a COLUMN yard whose station has
  // swung round to the east/west.
  const gx = pcs.reduce((s, e) => s + e.x, 0) / pcs.length;
  const gy = pcs.reduce((s, e) => s + e.y, 0) / pcs.length;
  const ddx = substation.x - gx, ddy = substation.y - gy;
  const approach = Math.abs(ddx) >= Math.abs(ddy)
    ? (ddx > 0 ? 'E' : 'W') : (ddy > 0 ? 'N' : 'S');
  const feeders: any[] = generateFeeders({
    fence, boundary: { polygon: fence }, equipment,
    cables: pcs.map(p => ({
      id: `mv-drop-${p.id}`, class: 'MV' as const,
      pts: [{ x: p.x, y: p.y }, { x: p.x, y: p.y - 5 }],
    })),
    aisles: [], roads: [], tracedPcsUnits: pcs.length,
  } as any, substation, 5, { maxPerFeeder: 1, approach });

  const homes: Pt[][] = feeders.map(f => f.segments[f.segments.length - 1].pts);

  let crossings = 0;
  for (let i = 0; i < homes.length; i++)
    for (let j = i + 1; j < homes.length; j++)
      for (let p = 0; p + 1 < homes[i].length; p++)
        for (let q = 0; q + 1 < homes[j].length; q++)
          if (properCross(homes[i][p], homes[i][p + 1], homes[j][q], homes[j][q + 1])) crossings++;

  // Bundle axis is perpendicular to (yard centre -> station), so the read
  // order is well defined at any rotation.
  const cx = equipment.reduce((s, e) => s + e.x, 0) / equipment.length;
  const cy = equipment.reduce((s, e) => s + e.y, 0) / equipment.length;
  const ax = substation.x - cx, ay = substation.y - cy;
  const alen = Math.hypot(ax, ay) || 1;
  const perp = { x: -ay / alen, y: ax / alen };
  const u = { x: Math.cos(c.theta), y: Math.sin(c.theta) };
  const info = feeders.map((f, i) => {
    const pts = homes[i];
    const t = pts[pts.length - 2] ?? pts[0];
    const own = pcs.find(p => f.inverterIds.includes(p.id))!;
    return {
      bundle: t.x * perp.x + t.y * perp.y,
      row: Math.round((-own.x * u.y + own.y * u.x) / 40),
      dist: Math.hypot(own.x - substation.x, own.y - substation.y),
    };
  });
  const seq: number[] = [];
  for (const o of [...info].sort((a, b) => a.bundle - b.bundle))
    if (seq[seq.length - 1] !== o.row) seq.push(o.row);
  const contiguous = seq.length === new Set(seq).size;
  const rowDist = new Map<number, number>();
  for (const o of info) rowDist.set(o.row, Math.min(rowDist.get(o.row) ?? Infinity, o.dist));
  const ds = seq.map(r => rowDist.get(r)!);
  const monotone =
    ds.every((d, i) => i === 0 || ds[i - 1] >= d - 1) ||
    ds.every((d, i) => i === 0 || ds[i - 1] <= d + 1);

  let padHits = 0;
  feeders.forEach((f, i) => {
    const ownIds = new Set<string>(f.inverterIds);
    const foreign = equipment.filter(e =>
      !ownIds.has(e.id) && ![...ownIds].some(id => e.id.includes(id)));
    const pts = homes[i];
    for (let k = 0; k + 1 < pts.length; k++) {
      const a = pts[k], b = pts[k + 1];
      const steps = Math.max(2, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 3));
      for (let m = 1; m < steps; m++) {
        const t = m / steps;
        const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
        if (foreign.some(e => inRect(p, e as Eq, 1))) padHits++;
      }
    }
  });

  return { count: feeders.length, expected: pcs.length, crossings, contiguous, monotone, padHits };
};

// 0 deg  = rows of skids, station across them  (Big Iron Area 2)
// 90 deg = columns of skids, station across them (Areas 3/4)
// The +10/20/30 tilts probe rotation tolerance in both orientations.
const cases: Case[] = [];
for (const deg of [0, 10, 20, 30, 90, 100, 110, 120])
  for (const rows of [2, 3, 4])
    for (const station of ['N', 'S'] as const)
      for (const facing of ['S', 'N', 'alt'] as const)
        cases.push({ theta: (deg * Math.PI) / 180, rows, station, facing });

const axisAligned = (c: Case) => {
  const deg = Math.round((c.theta * 180) / Math.PI) % 90;
  return deg === 0;
};

console.log('feeder comb invariants');
const bad = { order: [] as string[], pads: [] as string[], cross: [] as string[] };
for (const c of cases) {
  const deg = Math.round((c.theta * 180) / Math.PI);
  const id = `rot=${deg} lines=${c.rows} sub=${c.station} cans=${c.facing}`;
  let r: ReturnType<typeof evaluate>;
  try {
    r = evaluate(c);
  } catch (e) {
    bad.order.push(`${id} threw ${(e as Error).message}`);
    continue;
  }
  if (r.count !== r.expected) bad.order.push(`${id} built ${r.count}/${r.expected} feeders`);
  if (!r.contiguous || !r.monotone) bad.order.push(id);
  if (r.padHits) bad.pads.push(`${id} (${r.padHits})`);
  if (axisAligned(c) && r.crossings) bad.cross.push(`${id} (${r.crossings})`);
}

const nAligned = cases.filter(axisAligned).length;
check(`lines read across the bundle in station-distance order (${cases.length} layouts)`,
  bad.order.length === 0, bad.order.slice(0, 4).join('; '));
check(`no home run trenches a foreign pad (${cases.length} layouts)`,
  bad.pads.length === 0, bad.pads.slice(0, 4).join('; '));
check(`axis-aligned yards route with zero home-run crossings (${nAligned} layouts)`,
  bad.cross.length === 0, bad.cross.slice(0, 6).join('; '));

if (failures) {
  console.log(`\n${failures} feeder comb invariant(s) FAILED`);
  process.exit(1);
}
console.log('\nfeeder comb invariants OK');
