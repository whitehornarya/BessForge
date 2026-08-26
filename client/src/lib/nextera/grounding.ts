// Grounding system screening layout (10% design level).
//
// Pure geometry module: derives a perimeter ground loop just inside the
// fence, ground rods at loop corners / regular spacing / the gate, and
// bonding tap stubs from the loop to each major equipment item. All outputs
// are deterministic functions of the design, so previews, DXF exports and
// tests always agree.
//
// SCREENING ONLY — this is a conductor-quantity takeoff (loop LF, rod count,
// tap count), NOT an IEEE-80 grid study. Touch/step potentials and soil
// resistivity are detailed-design scope.

import { SiteDesign, PlacedEquipment, Pt } from './types';
import { insetPolygon, pointInPolygon, distanceToPolygonEdge } from './kmz';

// Loop offset inside the fence line. 3 ft keeps the buried loop clear of
// fence post foundations while staying inside the graded yard.
// Matches the issued 90% package: CAR-D-B009-1A dimensions the perimeter
// ground conductor 3'-0" inside the BESS fence on all sides.
export const GROUND_LOOP_INSET_FT = 3;

// Material specs per the 90% package grounding BOM (CAR-D-B009-0):
//   item 0020 — grid conductor, and item 0940 — ground rods.
export const GROUND_CONDUCTOR_SPEC = '#4/0 AWG BARE CU';
export const GROUND_ROD_SPEC = '3/4" X 10\'-0" COPPERBONDED';

// Interior grid conductors follow the equipment lattice (CAR-D-B009-1A/1B:
// E-W runs along each container row, N-S ties along each container column,
// all terminating on the perimeter loop). Container centers closer than this
// collapse into one grid line.
const GRID_CLUSTER_TOL_FT = 6;

// Reference grounding sheet (CAR-D-B009-1 family): the lattice is a full
// grid over the yard — bays between adjacent runs range ~15'–50' and the
// grid continues across open areas (future/aug zones are gridded too).
// Any gap between adjacent lattice lines (or between a lattice line and the
// loop extent) wider than this gets evenly spaced fill runs.
export const MAX_GRID_BAY_FT = 50;

// Test wells (circled rod symbol on the reference sheet) sit on the
// perimeter loop at roughly this arc-length interval; each snaps to the
// nearest perimeter rod so wells are always a subset of driven rods.
export const TEST_WELL_SPACING_FT = 200;

// Per-container bonding (reference sheet pigtails): BESS containers and PCS
// get one bond stub near each end of the long axis; aux gear / FJBs keep a
// single center bond.
const MULTI_TAP_KINDS = new Set<PlacedEquipment['kind']>(['bess', 'inverter']);

// Ground rod spacing along the loop (configurable). 50 ft is the common
// screening default; corners and the gate always get a rod regardless.
export const ROD_SPACING_OPTIONS = [25, 50, 100] as const;
export const DEFAULT_ROD_SPACING_FT = 50;

// Two rods closer than this are merged (corner + spaced rod collisions).
const ROD_MERGE_FT = 2;

// Equipment kinds that get a bonding tap stub to the ground loop.
const TAP_KINDS = new Set<PlacedEquipment['kind']>([
  'bess', 'inverter', 'auxTransformer', 'auxSwitchgear', 'feederJunctionBox',
]);

export interface GroundingTap {
  equipId: string;
  from: Pt; // point on the ground loop
  to: Pt;   // bonding point on the equipment footprint edge
}

export interface GroundingSummary {
  loopLengthFt: number;
  gridLengthFt: number;
  rodCount: number;          // driven rods (on the perimeter loop)
  crossingCount: number;     // exothermic (cadweld) grid crossing connections
  testWellCount: number;     // inspection test wells (subset of perimeter rods)
  tapCount: number;
  tapLengthFt: number;
  totalConductorFt: number;
  gridAreaSqFt: number;
  rodSpacingFt: number;
}

export interface GroundingPlan {
  loop: Pt[];          // primary (largest) perimeter loop — kept for consumers
                       // that only need one representative polygon
  loops: Pt[][];       // ALL closed perimeter loops (one per equipment island
                       // envelope; single fence-inset loop in legacy fallback)
  grid: [Pt, Pt][];    // interior grid conductor segments (row/column lattice)
  rods: Pt[];          // ground rod positions on the loop
  crossings: Pt[];     // lattice crossing connections (exothermic welds)
  testWells: Pt[];     // test-well positions (each coincides with a loop rod)
  taps: GroundingTap[];
  summary: GroundingSummary;
}

function polyLength(poly: Pt[], closed: boolean): number {
  let s = 0;
  const n = poly.length;
  for (let i = 0; i < (closed ? n : n - 1); i++) {
    const a = poly[i], b = poly[(i + 1) % n];
    s += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return s;
}

function polyAreaAbs(poly: Pt[]): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    s += a.x * b.y - b.x * a.y;
  }
  return Math.abs(s) / 2;
}

// Closest point on a closed polygon boundary to p.
export function nearestPointOnLoop(p: Pt, loop: Pt[]): Pt {
  let best: Pt = loop[0];
  let bestD = Infinity;
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i], b = loop[(i + 1) % loop.length];
    const dx = b.x - a.x, dy = b.y - a.y;
    const L2 = dx * dx + dy * dy;
    const t = L2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2)) : 0;
    const q = { x: a.x + t * dx, y: a.y + t * dy };
    const d = Math.hypot(q.x - p.x, q.y - p.y);
    if (d < bestD) { bestD = d; best = q; }
  }
  return best;
}

// Point where the segment from `outside` toward a local anchor inside the
// equipment footprint crosses the (rotated) rectangle edge — the bonding
// point on the enclosure. anchor defaults to the center; per-container
// bonding uses anchors near each end of the long axis.
function rectEdgePointToward(eq: PlacedEquipment, outside: Pt, anchor: Pt = { x: 0, y: 0 }): Pt {
  const c = Math.cos(-eq.rotation), s = Math.sin(-eq.rotation);
  // Outside point in the rect's local frame
  const lx = (outside.x - eq.x) * c - (outside.y - eq.y) * s;
  const ly = (outside.x - eq.x) * s + (outside.y - eq.y) * c;
  const hx = eq.length / 2, hy = eq.width / 2;
  // Ray from the local point toward the local anchor; smallest t in [0,1]
  // where the point is inside the rect on both axes.
  const axisT = (l: number, a: number, h: number) => {
    if (Math.abs(l) <= h) return 0;
    const d = l - a;
    if (Math.abs(d) < 1e-9) return 0;
    return (l - Math.sign(l) * h) / d;
  };
  const t = Math.max(axisT(lx, anchor.x, hx), axisT(ly, anchor.y, hy), 0);
  const ex = lx + (anchor.x - lx) * t, ey = ly + (anchor.y - ly) * t;
  // Back to world frame
  const cw = Math.cos(eq.rotation), sw = Math.sin(eq.rotation);
  return { x: eq.x + ex * cw - ey * sw, y: eq.y + ex * sw + ey * cw };
}

// Local->world for a point in the rect's frame.
function rectLocalToWorld(eq: PlacedEquipment, l: Pt): Pt {
  const cw = Math.cos(eq.rotation), sw = Math.sin(eq.rotation);
  return { x: eq.x + l.x * cw - l.y * sw, y: eq.y + l.x * sw + l.y * cw };
}

// Nearest point to p on a single segment a-b.
function nearestOnSegment(p: Pt, a: Pt, b: Pt): Pt {
  const dx = b.x - a.x, dy = b.y - a.y;
  const L2 = dx * dx + dy * dy;
  const t = L2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2)) : 0;
  return { x: a.x + t * dx, y: a.y + t * dy };
}

// Nearest point to p on the whole conductor network: the perimeter loop
// edges plus every interior grid segment. Bond stubs run to the closest
// buried conductor (reference sheet: short pigtails to the adjacent run).
function nearestPointOnConductors(p: Pt, loops: Pt[][], grid: [Pt, Pt][]): Pt {
  let best = nearestPointOnLoop(p, loops[0]);
  let bestD = Math.hypot(best.x - p.x, best.y - p.y);
  for (let i = 1; i < loops.length; i++) {
    const q = nearestPointOnLoop(p, loops[i]);
    const d = Math.hypot(q.x - p.x, q.y - p.y);
    if (d < bestD) { bestD = d; best = q; }
  }
  for (const [a, b] of grid) {
    const q = nearestOnSegment(p, a, b);
    const d = Math.hypot(q.x - p.x, q.y - p.y);
    if (d < bestD) { bestD = d; best = q; }
  }
  return best;
}

const round2 = (v: number) => Math.round(v * 100) / 100;

// Cluster sorted 1-D values into groups no wider than tol; returns the mean
// of each group. Deterministic for a deterministic input order.
function cluster1d(vals: number[], tol: number): number[] {
  const sorted = [...vals].sort((a, b) => a - b);
  const out: number[] = [];
  let group: number[] = [];
  for (const v of sorted) {
    if (group.length && v - group[group.length - 1] > tol) {
      out.push(group.reduce((s, x) => s + x, 0) / group.length);
      group = [];
    }
    group.push(v);
  }
  if (group.length) out.push(group.reduce((s, x) => s + x, 0) / group.length);
  return out;
}

// Clip an infinite axis-aligned line (x = c vertical, or y = c horizontal)
// against a closed polygon; returns the interior spans as segment pairs.
function clipAxisLineToPoly(c: number, vertical: boolean, poly: Pt[]): [Pt, Pt][] {
  const ts: number[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const a1 = vertical ? a.x : a.y, b1 = vertical ? b.x : b.y;
    const a2 = vertical ? a.y : a.x, b2 = vertical ? b.y : b.x;
    if ((a1 <= c && b1 > c) || (b1 <= c && a1 > c)) {
      const t = (c - a1) / (b1 - a1);
      ts.push(a2 + t * (b2 - a2));
    }
  }
  ts.sort((x, y) => x - y);
  const spans: [Pt, Pt][] = [];
  for (let i = 0; i + 1 < ts.length; i += 2) {
    if (ts[i + 1] - ts[i] < 1) continue; // degenerate sliver
    const mid = (ts[i] + ts[i + 1]) / 2;
    const midPt = vertical ? { x: c, y: mid } : { x: mid, y: c };
    if (!pointInPolygon(midPt, poly)) continue;
    const p = (v: number): Pt => vertical
      ? { x: round2(c), y: round2(v) } : { x: round2(v), y: round2(c) };
    spans.push([p(ts[i]), p(ts[i + 1])]);
  }
  return spans;
}

// Envelope border beyond the outermost equipment footprint in an island
// group (reference sheet: perimeter conductor runs a ~5 ft border bay just
// outside the container rows, NOT out at the yard fence).
export const ENVELOPE_BORDER_FT = 5;

// Equipment islands separated by less than this gap share one envelope loop;
// larger gaps (open yard, roads to a far-away aux pad) split into separate
// loops joined by interconnecting conductor.
export const ENVELOPE_CLUSTER_GAP_FT = 60;

interface Rect { minX: number; minY: number; maxX: number; maxY: number }

// Sutherland–Hodgman clip of a (possibly concave) polygon against an
// axis-aligned rectangle. Consecutive duplicate vertices are dropped.
function clipPolyToRect(poly: Pt[], r: Rect): Pt[] {
  type Edge = { inside: (p: Pt) => boolean; cross: (a: Pt, b: Pt) => Pt };
  const edges: Edge[] = [
    { inside: p => p.x >= r.minX, cross: (a, b) => ({ x: r.minX, y: a.y + (b.y - a.y) * (r.minX - a.x) / (b.x - a.x) }) },
    { inside: p => p.x <= r.maxX, cross: (a, b) => ({ x: r.maxX, y: a.y + (b.y - a.y) * (r.maxX - a.x) / (b.x - a.x) }) },
    { inside: p => p.y >= r.minY, cross: (a, b) => ({ y: r.minY, x: a.x + (b.x - a.x) * (r.minY - a.y) / (b.y - a.y) }) },
    { inside: p => p.y <= r.maxY, cross: (a, b) => ({ y: r.maxY, x: a.x + (b.x - a.x) * (r.maxY - a.y) / (b.y - a.y) }) },
  ];
  let out = poly;
  for (const e of edges) {
    const input = out;
    out = [];
    for (let i = 0; i < input.length; i++) {
      const a = input[i], b = input[(i + 1) % input.length];
      const ain = e.inside(a), bin = e.inside(b);
      if (ain) out.push(a);
      if (ain !== bin) out.push(e.cross(a, b));
    }
    if (out.length < 3) return [];
  }
  // Drop consecutive (near-)duplicates.
  const clean: Pt[] = [];
  for (const p of out) {
    const prev = clean[clean.length - 1];
    if (!prev || Math.hypot(prev.x - p.x, prev.y - p.y) > 0.05) clean.push(p);
  }
  while (clean.length > 1 && Math.hypot(clean[0].x - clean[clean.length - 1].x, clean[0].y - clean[clean.length - 1].y) <= 0.05) {
    clean.pop();
  }
  return clean;
}

function rectGap(a: Rect, b: Rect): number {
  const gx = Math.max(a.minX - b.maxX, b.minX - a.maxX, 0);
  const gy = Math.max(a.minY - b.maxY, b.minY - a.maxY, 0);
  return Math.hypot(gx, gy);
}

// World AABB of a (possibly rotated) placed equipment rectangle.
function equipRect(eq: PlacedEquipment): Rect {
  const c = Math.abs(Math.cos(eq.rotation)), s = Math.abs(Math.sin(eq.rotation));
  const hx = (eq.length / 2) * c + (eq.width / 2) * s;
  const hy = (eq.length / 2) * s + (eq.width / 2) * c;
  return { minX: eq.x - hx, minY: eq.y - hy, maxX: eq.x + hx, maxY: eq.y + hy };
}

// One island group: envelope loop + the BESS centers that drive its lattice.
interface EnvelopeCluster {
  loop: Pt[];
  minX: number; minY: number; maxX: number; maxY: number;
  bessXs: number[];
  bessYs: number[];
}

// Cluster all grounded footprints (equipment + aug bays + future-aug zones)
// into island groups and build a rectangular envelope loop per group,
// confined to the equipment area per CAR-D-B009 (grid does NOT extend across
// the open yard). Returns null when any envelope fails fence containment —
// caller falls back to the legacy fence-inset loop.
function deriveEnvelopeClusters(
  design: Pick<SiteDesign, 'fence' | 'equipment'>
    & Partial<Pick<SiteDesign, 'augmentationZones' | 'reservedZones'>>,
): EnvelopeCluster[] | null {
  const fence = design.fence;
  const items: { rect: Rect; bess: Pt | null }[] = [];
  for (const eq of design.equipment) {
    if (!TAP_KINDS.has(eq.kind)) continue;
    items.push({ rect: equipRect(eq), bess: eq.kind === 'bess' ? { x: eq.x, y: eq.y } : null });
  }
  for (const z of design.augmentationZones ?? []) {
    items.push({
      rect: {
        minX: z.x - z.length / 2, minY: z.y - z.width / 2,
        maxX: z.x + z.length / 2, maxY: z.y + z.width / 2,
      }, bess: null,
    });
  }
  for (const z of design.reservedZones ?? []) {
    if (z.kind !== 'futureAug') continue;
    items.push({
      rect: {
        minX: z.x - z.length / 2, minY: z.y - z.width / 2,
        maxX: z.x + z.length / 2, maxY: z.y + z.width / 2,
      }, bess: null,
    });
  }
  if (!items.length) return null;

  // Union-find over item rects by adjacency gap.
  const parent = items.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (rectGap(items[i].rect, items[j].rect) <= ENVELOPE_CLUSTER_GAP_FT) {
        parent[find(i)] = find(j);
      }
    }
  }
  const groups = new Map<number, { rect: Rect; bess: Pt[] }>();
  for (let i = 0; i < items.length; i++) {
    const root = find(i);
    const g = groups.get(root)
      ?? { rect: { ...items[i].rect }, bess: [] };
    g.rect.minX = Math.min(g.rect.minX, items[i].rect.minX);
    g.rect.minY = Math.min(g.rect.minY, items[i].rect.minY);
    g.rect.maxX = Math.max(g.rect.maxX, items[i].rect.maxX);
    g.rect.maxY = Math.max(g.rect.maxY, items[i].rect.maxY);
    if (items[i].bess) g.bess.push(items[i].bess!);
    groups.set(root, g);
  }

  // Envelope per group: border bay beyond the outermost footprint. Where the
  // rectangle would leave the fence (concave parcels, islands hugging the
  // fence line) it is clipped against the fence-inset polygon so the loop
  // always keeps the design inset clearance.
  const insetLoop = insetPolygon(fence, GROUND_LOOP_INSET_FT);
  if (insetLoop.length < 3) return null;
  const insetValid = insetLoop.every(
    p => pointInPolygon(p, fence) && distanceToPolygonEdge(p, fence) >= GROUND_LOOP_INSET_FT * 0.5
  );
  if (!insetValid) return null;
  const clusters: EnvelopeCluster[] = [];
  for (const g of Array.from(groups.values())) {
    const rect: Rect = {
      minX: g.rect.minX - ENVELOPE_BORDER_FT,
      minY: g.rect.minY - ENVELOPE_BORDER_FT,
      maxX: g.rect.maxX + ENVELOPE_BORDER_FT,
      maxY: g.rect.maxY + ENVELOPE_BORDER_FT,
    };
    const loop = clipPolyToRect(insetLoop, rect).map(p => ({ x: round2(p.x), y: round2(p.y) }));
    // Degenerate clip for THIS island only -> skip the cluster (its
    // equipment still bonds to the nearest remaining conductor); other
    // islands keep their envelope. Legacy full-yard fallback only happens
    // when NO cluster survives (see below).
    if (loop.length < 3) continue;
    const lxs = loop.map(p => p.x), lys = loop.map(p => p.y);
    const minX = Math.min(...lxs), maxX = Math.max(...lxs);
    const minY = Math.min(...lys), maxY = Math.max(...lys);
    if (maxX - minX < 2 || maxY - minY < 2) continue;
    // Loop vertices AND edge interiors must stay inside the fence —
    // Sutherland–Hodgman on a concave subject can emit bridging edges
    // through excluded space (e.g. across a fence notch); sampling edge
    // interiors catches those so the bad cluster is skipped, not shipped.
    const insideFence = (p: Pt) => pointInPolygon(p, fence);
    let ok = loop.every(insideFence);
    if (ok) {
      outer: for (let i = 0; i < loop.length; i++) {
        const a = loop[i], b = loop[(i + 1) % loop.length];
        for (const t of [0.25, 0.5, 0.75]) {
          if (!insideFence({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })) {
            ok = false; break outer;
          }
        }
      }
    }
    if (!ok) continue;
    clusters.push({
      loop, minX, minY, maxX, maxY,
      bessXs: g.bess.map(b => b.x),
      bessYs: g.bess.map(b => b.y),
    });
  }
  // Legacy full-yard fallback only when NO island envelope survived.
  if (!clusters.length) return null;
  // Deterministic order: south-west-most group first.
  clusters.sort((a, b) => a.minY - b.minY || a.minX - b.minX);
  return clusters;
}

// Clearance around equipment pads for the interconnect route check: samples
// inside a pad inflated by this margin count as blocked. Small enough that
// loop endpoints (5 ft border bay off the footprint) never self-block.
const INTERCONNECT_PAD_CLEAR_FT = 2;
// Detour legs run at the pad edge plus this margin.
const INTERCONNECT_DETOUR_FT = 4;
// Roads are NOT hard obstacles — interconnects between islands often have to
// cross them. Instead the route is only allowed to cross a road strip
// perpendicular (shortest crossing, like cable trenches): the length of any
// single conductor leg inside a road's clear zone must not exceed the road
// width plus the edge clearance on both sides (+ a small slack). Longitudinal
// runs down a road / its clear zone are rejected in the clear tiers and the
// Z-detour shifts the crossing leg outside the road instead.
const ROAD_EDGE_CLEAR_FT = 3;      // clear zone beyond the road edge
const ROAD_CROSS_SLACK_FT = 1;     // tolerance on the perpendicular crossing length

// Interconnecting conductor between two island loops: nearest points on the
// facing edges, orthogonal (L-elbow) when the points don't line up. Candidate
// legs are sampled against placed equipment footprints (aux gear, substation,
// laydown pads between islands) as well as the fence; a clear route is
// preferred, with axis-aligned Z-detours around blocking pads. Falls back to
// the never-drop straight run when no clear route exists (same rule as cable
// reroutes). Segments are ordinary grid conductor so every consumer
// counts/draws them.
type RoadStrip = { x: number; y: number; length: number; width: number; rotation: number };

function interconnectSegments(
  loopA: Pt[], loopB: Pt[], fence: Pt[], obstacles: Rect[] = [], roads: RoadStrip[] = []
): [Pt, Pt][] {
  const centroid = (poly: Pt[]): Pt => ({
    x: poly.reduce((s, p) => s + p.x, 0) / poly.length,
    y: poly.reduce((s, p) => s + p.y, 0) / poly.length,
  });
  let p = nearestPointOnLoop(centroid(loopB), loopA);
  let q = nearestPointOnLoop(p, loopB);
  p = nearestPointOnLoop(q, loopA);
  q = nearestPointOnLoop(p, loopB);
  const P = { x: round2(p.x), y: round2(p.y) };
  const Q = { x: round2(q.x), y: round2(q.y) };
  const insideFence = (pt: Pt) => pointInPolygon(pt, fence) && distanceToPolygonEdge(pt, fence) >= 1;
  const inPad = (pt: Pt) => obstacles.some(r =>
    pt.x > r.minX - INTERCONNECT_PAD_CLEAR_FT && pt.x < r.maxX + INTERCONNECT_PAD_CLEAR_FT &&
    pt.y > r.minY - INTERCONNECT_PAD_CLEAR_FT && pt.y < r.maxY + INTERCONNECT_PAD_CLEAR_FT);
  // Validate a candidate route by sampling each segment's interior every
  // ~10 ft — an endpoint check alone can miss a leg crossing a fence notch
  // or an equipment pad. checkPads=false relaxes to the legacy fence-only
  // check for the never-drop fallback tiers.
  const sample = (segs: [Pt, Pt][], test: (pt: Pt) => boolean) => segs.every(([a, b]) => {
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const n = Math.max(2, Math.ceil(len / 10));
    for (let k = 1; k < n; k++) {
      const t = k / n;
      if (!test({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })) return false;
    }
    return true;
  });
  const fenceOk = (segs: [Pt, Pt][]) => sample(segs, insideFence);
  // Road rule: a leg may pass through a road strip, but only as a short
  // perpendicular crossing — its run length inside the road's clear zone
  // (road strip inflated by ROAD_EDGE_CLEAR_FT) must not exceed the strip's
  // short dimension + both clear margins + slack. Legs are transformed into
  // each road's local frame so the rule also applies to angled strips (an
  // AABB of a rotated road would over-block the corridor); the run inside
  // the clear zone is a Liang-Barsky clip of the leg against the inflated
  // local rect.
  const roadsOk = (segs: [Pt, Pt][]) => segs.every(([a, b]) => roads.every(rd => {
    const cos = Math.cos(rd.rotation), sin = Math.sin(rd.rotation);
    const local = (pt: Pt): Pt => ({
      x: (pt.x - rd.x) * cos + (pt.y - rd.y) * sin,
      y: -(pt.x - rd.x) * sin + (pt.y - rd.y) * cos,
    });
    const A = local(a), B = local(b);
    const hx = rd.length / 2 + ROAD_EDGE_CLEAR_FT;
    const hy = rd.width / 2 + ROAD_EDGE_CLEAR_FT;
    const dx = B.x - A.x, dy = B.y - A.y;
    let t0 = 0, t1 = 1;
    const clip = (p: number, q: number): boolean => {
      if (Math.abs(p) < 1e-9) return q >= 0;
      const t = q / p;
      if (p < 0) { if (t > t1) return false; if (t > t0) t0 = t; }
      else { if (t < t0) return false; if (t < t1) t1 = t; }
      return true;
    };
    if (!clip(-dx, A.x + hx) || !clip(dx, hx - A.x) ||
        !clip(-dy, A.y + hy) || !clip(dy, hy - A.y)) return true; // no overlap
    const overlap = (t1 - t0) * Math.hypot(dx, dy);
    const maxRun = Math.min(rd.length, rd.width)
      + 2 * ROAD_EDGE_CLEAR_FT + ROAD_CROSS_SLACK_FT;
    return overlap <= maxRun;
  }));
  const clearOk = (segs: [Pt, Pt][]) =>
    sample(segs, pt => insideFence(pt) && !inPad(pt)) && roadsOk(segs);
  const straight: [Pt, Pt][] = [[P, Q]];
  const aligned = Math.abs(P.x - Q.x) < 0.5 || Math.abs(P.y - Q.y) < 0.5;
  // Tier 1: straight / single L-elbow clear of both fence and pads.
  if (aligned && clearOk(straight)) return straight;
  const elbows: Pt[] = aligned ? [] : [{ x: P.x, y: Q.y }, { x: Q.x, y: P.y }];
  for (const e of elbows) {
    const cand: [Pt, Pt][] = [[P, e], [e, Q]];
    if (insideFence(e) && !inPad(e) && clearOk(cand)) return cand;
  }
  // Tier 2: axis-aligned Z-detour around a blocking pad. Candidate detour
  // coordinates come from every obstacle edge (± margin); shortest clear
  // route wins, ties broken by coordinate for determinism.
  let bestZ: [Pt, Pt][] | null = null;
  let bestLen = Infinity;
  const tryZ = (e1: Pt, e2: Pt) => {
    if (!insideFence(e1) || inPad(e1) || !insideFence(e2) || inPad(e2)) return;
    const segs: [Pt, Pt][] = [[P, e1], [e1, e2], [e2, Q]];
    if (!clearOk(segs)) return;
    const len = segs.reduce((s, [a, b]) => s + Math.hypot(b.x - a.x, b.y - a.y), 0);
    if (len < bestLen - 0.01) { bestLen = len; bestZ = segs; }
  };
  const xs: number[] = [];
  const ys: number[] = [];
  for (const r of obstacles) {
    xs.push(round2(r.minX - INTERCONNECT_DETOUR_FT), round2(r.maxX + INTERCONNECT_DETOUR_FT));
    ys.push(round2(r.minY - INTERCONNECT_DETOUR_FT), round2(r.maxY + INTERCONNECT_DETOUR_FT));
  }
  // Detour candidates for roads come from the strip's AABB — over-wide for
  // angled roads, but candidates are only suggestions: each is still
  // validated by clearOk (which uses the exact rotated-frame road rule).
  for (const rd of roads) {
    const c = Math.abs(Math.cos(rd.rotation)), s = Math.abs(Math.sin(rd.rotation));
    const hx = (rd.length / 2) * c + (rd.width / 2) * s;
    const hy = (rd.length / 2) * s + (rd.width / 2) * c;
    xs.push(round2(rd.x - hx - INTERCONNECT_DETOUR_FT), round2(rd.x + hx + INTERCONNECT_DETOUR_FT));
    ys.push(round2(rd.y - hy - INTERCONNECT_DETOUR_FT), round2(rd.y + hy + INTERCONNECT_DETOUR_FT));
  }
  xs.sort((a, b) => a - b);
  ys.sort((a, b) => a - b);
  for (const x of xs) tryZ({ x, y: P.y }, { x, y: Q.y });
  for (const y of ys) tryZ({ x: P.x, y }, { x: Q.x, y });
  if (bestZ) return bestZ;
  // Tier 3: legacy fence-only routing (pads unavoidable — buried conductor
  // through a pad beats a broken ground grid).
  if (aligned) return straight;
  for (const e of elbows) {
    const cand: [Pt, Pt][] = [[P, e], [e, Q]];
    if (insideFence(e) && fenceOk(cand)) return cand;
  }
  // Last resort: keep the loops electrically joined rather than dropping
  // the interconnect (same never-drop rule as cable reroutes).
  return straight;
}

// Build the grounding screening plan. The conductor grid is confined to the
// BESS island envelope(s) per the issued sheet (CAR-D-B009 family): a
// rectangular perimeter loop with a ~5 ft border bay around each equipment
// island group, interior lattice only inside the envelope, and
// interconnecting conductor between separate island groups. Falls back to
// the legacy fence-inset loop when no envelope can be derived (no grounded
// equipment, or a concave fence rejects the envelope rectangle). Returns
// null when the design has no usable fence or no valid loop exists.
export function buildGroundingPlan(
  design: Pick<SiteDesign, 'fence' | 'gate' | 'equipment'>
    & Partial<Pick<SiteDesign, 'augmentationZones' | 'reservedZones' | 'roads' | 'aisles'>>,
  opts?: { rodSpacingFt?: number }
): GroundingPlan | null {
  const fence = design.fence;
  if (!fence || fence.length < 3) return null;
  const spacing = opts?.rodSpacingFt && opts.rodSpacingFt > 0
    ? opts.rodSpacingFt
    : DEFAULT_ROD_SPACING_FT;

  let clusters = deriveEnvelopeClusters(design);
  if (!clusters) {
    // Legacy fallback: single loop inset from the fence line.
    const loop = insetPolygon(fence, GROUND_LOOP_INSET_FT).map(p => ({
      x: round2(p.x), y: round2(p.y),
    }));
    if (loop.length < 3) return null;
    // Loop must sit inside the fence with (approximately) the design inset —
    // concave fences can make centroid-shrink insets fail, so verify.
    const loopValid = loop.every(
      p => pointInPolygon(p, fence) && distanceToPolygonEdge(p, fence) >= GROUND_LOOP_INSET_FT * 0.5
    );
    if (!loopValid) return null;
    const bess = design.equipment.filter(e => e.kind === 'bess');
    const lxs = loop.map(p => p.x), lys = loop.map(p => p.y);
    clusters = [{
      loop,
      minX: Math.min(...lxs), minY: Math.min(...lys),
      maxX: Math.max(...lxs), maxY: Math.max(...lys),
      bessXs: bess.map(e => e.x), bessYs: bess.map(e => e.y),
    }];
  }
  const loops = clusters.map(c => c.loop);

  // Rods: every loop corner + evenly spaced along each edge so no gap
  // exceeds `spacing`, + one at the loop point nearest the gate.
  const rods: Pt[] = [];
  const addRod = (p: Pt) => {
    const q = { x: round2(p.x), y: round2(p.y) };
    if (!rods.some(r0 => Math.hypot(r0.x - q.x, r0.y - q.y) < ROD_MERGE_FT)) rods.push(q);
  };
  for (const loop of loops) {
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i], b = loop[(i + 1) % loop.length];
      addRod(a);
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      const n = Math.floor(len / spacing);
      for (let k = 1; k <= n; k++) {
        const t = k / (n + 1);
        addRod({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      }
    }
  }
  if (design.gate) {
    const g = { x: design.gate.x, y: design.gate.y };
    let best = nearestPointOnLoop(g, loops[0]);
    let bestD = Math.hypot(best.x - g.x, best.y - g.y);
    for (let i = 1; i < loops.length; i++) {
      const q = nearestPointOnLoop(g, loops[i]);
      const d = Math.hypot(q.x - g.x, q.y - g.y);
      if (d < bestD) { bestD = d; best = q; }
    }
    addRod(best);
  }

  // Interior grid conductors along the container lattice (CAR-D-B009-1A/1B),
  // confined to each island envelope: runs at each container row/column of
  // that island, plus evenly spaced fill runs so no bay between adjacent
  // runs (or between a run and the envelope edge) exceeds MAX_GRID_BAY_FT.
  // Future-aug bays inside an envelope stay gridded; the open yard outside
  // the envelopes carries no lattice.
  const fillBays = (clusterVals: number[], lo: number, hi: number): number[] => {
    if (hi - lo <= MAX_GRID_BAY_FT) return clusterVals.filter(c => c > lo + 1 && c < hi - 1);
    const anchors = [lo, ...clusterVals.filter(c => c > lo + 1 && c < hi - 1).sort((a, b) => a - b), hi];
    const lines: number[] = [];
    for (let i = 0; i + 1 < anchors.length; i++) {
      if (i > 0) lines.push(anchors[i]);
      const gap = anchors[i + 1] - anchors[i];
      const nFill = Math.ceil(gap / MAX_GRID_BAY_FT) - 1;
      for (let k = 1; k <= nFill; k++) {
        lines.push(round2(anchors[i] + (gap * k) / (nFill + 1)));
      }
    }
    return lines;
  };
  const grid: [Pt, Pt][] = [];
  const crossings: Pt[] = [];
  for (const c of clusters) {
    const rowYs = fillBays(cluster1d(c.bessYs, GRID_CLUSTER_TOL_FT), c.minY, c.maxY);
    const colXs = fillBays(cluster1d(c.bessXs, GRID_CLUSTER_TOL_FT), c.minX, c.maxX);
    const hSpans = new Map<number, [Pt, Pt][]>(); // y -> E-W spans
    const vSpans = new Map<number, [Pt, Pt][]>(); // x -> N-S spans
    for (const y of rowYs) {
      const spans = clipAxisLineToPoly(y, false, c.loop);
      if (spans.length) hSpans.set(y, spans);
      grid.push(...spans);
    }
    for (const x of colXs) {
      const spans = clipAxisLineToPoly(x, true, c.loop);
      if (spans.length) vSpans.set(x, spans);
      grid.push(...spans);
    }
    // Lattice crossings (filled dots on the reference sheet): an exothermic
    // (cadweld) connection wherever an E-W run and a N-S run actually cross
    // inside the loop. These are connections, NOT driven rods — the issued
    // package BOM counts ~50 rods, all on the perimeter loop.
    for (const [y, hs] of Array.from(hSpans.entries())) {
      for (const [x, vs] of Array.from(vSpans.entries())) {
        const onH = hs.some(([a, b]) => x >= Math.min(a.x, b.x) - 0.01 && x <= Math.max(a.x, b.x) + 0.01);
        const onV = vs.some(([a, b]) => y >= Math.min(a.y, b.y) - 0.01 && y <= Math.max(a.y, b.y) + 0.01);
        if (onH && onV) crossings.push({ x: round2(x), y: round2(y) });
      }
    }
  }

  // Interconnecting conductor between separate island loops (spanning tree
  // over loop centroids, nearest-first) — plain grid segments so lengths,
  // drawings and BOM quantities all pick them up automatically.
  if (loops.length > 1) {
    // Obstacles for the route check: every placed equipment footprint plus
    // laydown pads — anything sitting between two island groups that a
    // drafter would expect the buried interconnect to respect.
    const obstacles: Rect[] = design.equipment.map(equipRect);
    for (const z of design.reservedZones ?? []) {
      if (z.kind !== 'laydown') continue;
      obstacles.push({
        minX: z.x - z.length / 2, minY: z.y - z.width / 2,
        maxX: z.x + z.length / 2, maxY: z.y + z.width / 2,
      });
    }
    // Road strips (perimeter roads + drive aisles): crossing-constrained, not
    // hard obstacles — interconnects may only take short perpendicular
    // crossings through them (see roadsOk in interconnectSegments). Strips
    // are passed as oriented rectangles so the rule also holds for angled
    // road segments (legs are checked in each road's local frame).
    const roadStrips: RoadStrip[] = [...(design.roads ?? []), ...(design.aisles ?? [])]
      .map(rd => ({ x: rd.x, y: rd.y, length: rd.length, width: rd.width, rotation: rd.rotation }));
    const connected = new Set<number>([0]);
    const centroidOf = (poly: Pt[]): Pt => ({
      x: poly.reduce((s, p) => s + p.x, 0) / poly.length,
      y: poly.reduce((s, p) => s + p.y, 0) / poly.length,
    });
    const cents = loops.map(centroidOf);
    while (connected.size < loops.length) {
      let bi = -1, bj = -1, bd = Infinity;
      for (const i of Array.from(connected)) {
        for (let j = 0; j < loops.length; j++) {
          if (connected.has(j)) continue;
          const d = Math.hypot(cents[i].x - cents[j].x, cents[i].y - cents[j].y);
          if (d < bd) { bd = d; bi = i; bj = j; }
        }
      }
      grid.push(...interconnectSegments(loops[bi], loops[bj], fence, obstacles, roadStrips));
      connected.add(bj);
    }
  }

  // Test wells: every ~TEST_WELL_SPACING_FT of loop arc length (per loop),
  // snapped to the nearest perimeter rod (circled rod symbol — always a
  // driven rod).
  const testWells: Pt[] = [];
  for (const loop of loops) {
    const loopLen = polyLength(loop, true);
    const nWells = Math.max(1, Math.floor(loopLen / TEST_WELL_SPACING_FT));
    // Walk the loop accumulating arc length; target stations at k*spacing.
    const stations: Pt[] = [];
    let acc = 0;
    let nextK = 0;
    for (let i = 0; i < loop.length && nextK < nWells; i++) {
      const a = loop[i], b = loop[(i + 1) % loop.length];
      const segLen = Math.hypot(b.x - a.x, b.y - a.y);
      while (nextK < nWells && nextK * TEST_WELL_SPACING_FT <= acc + segLen) {
        const t = (nextK * TEST_WELL_SPACING_FT - acc) / Math.max(segLen, 1e-9);
        stations.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
        nextK++;
      }
      acc += segLen;
    }
    for (const st of stations) {
      let best = rods[0], bestD = Infinity;
      for (const r of rods) {
        const d = Math.hypot(r.x - st.x, r.y - st.y);
        if (d < bestD) { bestD = d; best = r; }
      }
      if (best && !testWells.some(w => Math.hypot(w.x - best.x, w.y - best.y) < ROD_MERGE_FT)) {
        testWells.push({ x: best.x, y: best.y });
      }
    }
  }

  // Bonding taps: per-container multi-point bonds (reference sheet
  // pigtails). BESS containers and PCS bond near each end of the long axis;
  // aux gear / FJBs keep one center bond. Each stub runs to the NEAREST
  // buried conductor — loop or interior grid run — never a long straight
  // shot to the loop. Ordered by the (stable) equipment array so output is
  // deterministic.
  const taps: GroundingTap[] = [];
  for (const eq of design.equipment) {
    if (!TAP_KINDS.has(eq.kind)) continue;
    // Bond points sit ON the enclosure long edges (local x = ±length/4,
    // y = ±width/2); each pigtail runs from the edge to the nearest buried
    // conductor. The side (front/back long edge) with the shorter pigtail
    // wins — deterministic tie-break toward -width/2.
    const axs = MULTI_TAP_KINDS.has(eq.kind)
      ? [-eq.length / 4, eq.length / 4]
      : [0];
    for (const ax of axs) {
      let bestTo: Pt | null = null, bestFrom: Pt | null = null, bestD = Infinity;
      for (const sy of [-1, 1]) {
        const to = rectLocalToWorld(eq, { x: ax, y: sy * eq.width / 2 });
        const from = nearestPointOnConductors(to, loops, grid);
        const d = Math.hypot(from.x - to.x, from.y - to.y);
        if (d < bestD - 0.01) { bestD = d; bestTo = to; bestFrom = from; }
      }
      if (!bestTo || !bestFrom) continue;
      taps.push({
        equipId: eq.id,
        from: { x: round2(bestFrom.x), y: round2(bestFrom.y) },
        to: { x: round2(bestTo.x), y: round2(bestTo.y) },
      });
    }
  }

  const loopLengthFt = loops.reduce((s, l) => s + polyLength(l, true), 0);
  const gridLengthFt = grid.reduce(
    (s, [a, b]) => s + Math.hypot(b.x - a.x, b.y - a.y), 0
  );
  const tapLengthFt = taps.reduce(
    (s, t) => s + Math.hypot(t.to.x - t.from.x, t.to.y - t.from.y), 0
  );
  // Primary loop = largest-area loop (representative polygon for consumers
  // that only handle one; all drawing/export paths iterate `loops`).
  const primary = loops.reduce((a, b) => (polyAreaAbs(b) > polyAreaAbs(a) ? b : a), loops[0]);
  return {
    loop: primary,
    loops,
    grid,
    rods,
    crossings,
    testWells,
    taps,
    summary: {
      loopLengthFt: round2(loopLengthFt),
      gridLengthFt: round2(gridLengthFt),
      rodCount: rods.length,
      crossingCount: crossings.length,
      testWellCount: testWells.length,
      tapCount: taps.length,
      tapLengthFt: round2(tapLengthFt),
      totalConductorFt: round2(loopLengthFt + gridLengthFt + tapLengthFt),
      gridAreaSqFt: round2(loops.reduce((s, l) => s + polyAreaAbs(l), 0)),
      rodSpacingFt: spacing,
    },
  };
}
