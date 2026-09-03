// Cable routing per NextEra guidance Sheets 3-4:
//   DC (green):    each BESS container -> its block's inverter/PCS, orthogonal
//                  runs with parallel corridor offsets inside the PCS gap
//   MV (cyan):     inverter drops onto a per-row MV bus, rows daisy-chain down
//                  a central spine to the aux switchgear (or a POI stub)
//   LVAC (blue):   480V feed from the aux transformer / aux switch panel up the
//                  spine onto per-row LVAC buses with drops to each inverter
//   FIBER (orange): fiber patch panel up the spine onto per-row fiber buses
//                  with drops to each inverter; fire control panel tied in
// The spine runs inside the "480V Aux and Fiber Trench" band placed in a gap
// between block columns. Augmentation equipment gets reference-only DC stubs
// that stop AT the exclusion-zone edge (no BOL conduit inside zones, key note 1).
// ALL COORDINATES IN FEET.

import { CLEARANCES, LG_JF2 } from './catalog';
import { PlacedEquipment, AugmentationZone, ReservedZone, CableRun, TrenchBand, CorridorTrench, Pt, IslandInfo } from './types';
import { pointInPolygon, distanceToPolygonEdge } from './kmz';
import { exclusionRects, pointInExclusion } from './areaZones';

export interface CableRoutingResult {
  cables: CableRun[];
  trench: TrenchBand | null;
  // Per-island horizontal 480V aux & fiber corridor trench bands (mirrored
  // mode only; empty otherwise).
  corridorTrenches: CorridorTrench[];
  warnings: string[];
}

// PCS connection compartments per sheet 3: all DC exits pass through one
// DC cable compartment at the LEFT end of the container-facing (south) face
// (exit x offsets 1.5 + i*1.1 from the end), and MV / LVAC / fiber tie in at
// the MV-and-aux-transformer end at the RIGHT of the north face (offsets
// 1.2 / 2.6 / 4.0 from the end). Rects are axis-aligned in plan and mirror
// end-for-end with the same rotation-derived sign the exit points use.
export interface PcsCompartment {
  kind: 'dc' | 'aux';
  x: number;      // rect center (plan feet)
  y: number;
  length: number; // plan x extent
  width: number;  // plan y extent
}

export function pcsCompartments(inv: PlacedEquipment): PcsCompartment[] {
  const m = Math.cos(inv.rotation) >= 0 ? 1 : -1; // same sign as mirrorOf()
  // Container-facing side of the PCS: sheet-3 blocks always face south (-1);
  // mirrored-pair blocks store the inward direction on doorEnd (set by
  // placeMirroredPair) since north-side blocks face their containers south.
  // Traced yards get doorEnd from the drawn container geometry (the trace
  // commit / regenerate-time facing pass), so the compartment lands on the
  // face the drawing actually serves.
  const f = inv.doorEnd ?? -1;
  const halfL = inv.length / 2;
  const halfW = inv.width / 2;
  // DC compartment: spans exit offsets 1.5..4.8 (up to 4 containers) + margin
  const dcNear = 0.6, dcFar = 5.6, dcDepth = 2.0;
  // Aux/MV transformer connection box: spans exit offsets 1.2..4.0 + margin
  const auxNear = 0.4, auxFar = 4.8, auxDepth = 2.4;
  // Compartment centers in the PCS local frame (length along local x).
  const dcLx = -m * (halfL - (dcNear + dcFar) / 2);
  const dcLy = f * (halfW - dcDepth / 2);
  const auxLx = m * (halfL - (auxNear + auxFar) / 2);
  const auxLy = -f * (halfW - auxDepth / 2);
  if (Math.abs(Math.sin(inv.rotation)) > 0.5) {
    // Vertical PCS (traced yards keep the drawing's ~90° rotation): the long
    // axis runs along plan Y, so the sheet-3 compartment layout rotates with
    // the body. Without this the boxes land OUTSIDE the footprint and the
    // symbol flip logic (eciSymbolPlacement) mis-orients the glyph.
    const cs = Math.cos(inv.rotation), sn = Math.sin(inv.rotation);
    const rot = (lx: number, ly: number): Pt => ({
      x: inv.x + lx * cs - ly * sn,
      y: inv.y + lx * sn + ly * cs,
    });
    const dc = rot(dcLx, dcLy), aux = rot(auxLx, auxLy);
    return [
      { kind: 'dc', x: dc.x, y: dc.y, length: dcDepth, width: dcFar - dcNear },
      { kind: 'aux', x: aux.x, y: aux.y, length: auxDepth, width: auxFar - auxNear },
    ];
  }
  return [
    { kind: 'dc', x: inv.x + dcLx, y: inv.y + dcLy, length: dcFar - dcNear, width: dcDepth },
    { kind: 'aux', x: inv.x + auxLx, y: inv.y + auxLy, length: auxFar - auxNear, width: auxDepth },
  ];
}

// Vertical clearances of the yard buses above each inverter row (ft)
const MV_BUS_OFF = 4;     // above inverter top, clears the aug-zone edge (+3)
const LVAC_BUS_OFF = 5.5;
const FIBER_BUS_OFF = 7;
const TRENCH_WIDTH = 6;
// Per-island 480V aux & fiber corridor trench width — narrower than the yard
// trench because it lives inside the 10 ft island aux corridor.
const CORRIDOR_TRENCH_WIDTH = 4;

// Total routed length in feet per cable class plus the trench band length.
// Reference-only augmentation stubs (ref) are excluded: no BOL conduit/cable
// is installed in exclusion zones, so they don't count toward estimates.
export interface CableClassStats {
  total: number;   // total routed LF
  runs: number;    // number of discrete runs (pull count basis)
  longest: number; // longest single run LF
}

export interface CableLengthSummary {
  DC: CableClassStats;
  MV: CableClassStats;
  LVAC: CableClassStats;
  AUXPWR: CableClassStats;
  FIBER: CableClassStats;
  FIBER_TRUNK: CableClassStats;
  CATL: CableClassStats;
  trench: number;
}

const emptyStats = (): CableClassStats => ({ total: 0, runs: 0, longest: 0 });

export function summarizeCableLengths(
  cables: CableRun[],
  trench: TrenchBand | null,
  corridorTrenches: CorridorTrench[] = [],
): CableLengthSummary {
  const sum: CableLengthSummary = {
    DC: emptyStats(), MV: emptyStats(), LVAC: emptyStats(), AUXPWR: emptyStats(),
    FIBER: emptyStats(), FIBER_TRUNK: emptyStats(), CATL: emptyStats(), trench: 0,
  };
  for (const run of cables) {
    if (run.ref) continue;
    let len = 0;
    for (let i = 1; i < run.pts.length; i++) {
      len += Math.hypot(run.pts[i].x - run.pts[i - 1].x, run.pts[i].y - run.pts[i - 1].y);
    }
    const s = sum[run.class];
    s.total += len;
    s.runs += 1;
    if (len > s.longest) s.longest = len;
  }
  if (trench) sum.trench = Math.max(0, trench.yTop - trench.yBottom);
  // A shared LVAC/FIRE-FIBER corridor is one physical civil run even though
  // two cable landing graphs copy its centerline.  CorridorTrench is the
  // canonical physical-leg list, so count each record once.
  sum.trench += corridorTrenches.reduce(
    (total, c) => total + Math.max(0, c.length ?? (c.maxX - c.minX)),
    0,
  );
  return sum;
}

interface Block {
  n: string;
  inv: PlacedEquipment;
  containers: PlacedEquipment[];
}

export interface Rect { x1: number; y1: number; x2: number; y2: number }

// Fallback grid router: when a straight orthogonal run would leave the fence
// (concave / L-shaped / comb parcels), find an orthogonal detour that stays
// inside the fence and avoids equipment. BFS with a bend penalty on a coarse
// grid, then collinear simplification. Returns null when genuinely impossible.
// `usedCells` (grid-cell indices of previously routed detours) get a step-cost
// discount so later detours are pulled onto shared corridors instead of each
// finding its own independent path; the caller then separates the parallel
// runs with small class offsets (like the 0.7 ft DC bundle offsets).
export function rerouteOrthogonal(
  start: Pt,
  end: Pt,
  fence: Pt[],
  obstacles: Rect[],
  insideFence: (pts: Pt[], margin?: number) => boolean,
  usedCells?: Set<number>
): { path: Pt[]; cells: number[] } | null {
  const STEP = 3;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of fence) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  const nx = Math.ceil((maxX - minX) / STEP) + 1;
  const ny = Math.ceil((maxY - minY) / STEP) + 1;
  if (nx * ny > 500000 || nx < 2 || ny < 2) return null;

  const toIdx = (ix: number, iy: number) => iy * nx + ix;
  const gx = (ix: number) => minX + ix * STEP;
  const gy = (iy: number) => minY + iy * STEP;

  const nearEndpoint = (x: number, y: number) =>
    Math.hypot(x - start.x, y - start.y) < 6 || Math.hypot(x - end.x, y - end.y) < 6;

  const blocked = (ix: number, iy: number): boolean => {
    const x = gx(ix), y = gy(iy);
    if (!insideFence([{ x, y }], 1.5)) return true;
    if (nearEndpoint(x, y)) return false; // allow launching from equipment edges
    for (const r of obstacles) {
      if (x > r.x1 && x < r.x2 && y > r.y1 && y < r.y2) return true;
    }
    return false;
  };

  const snap = (p: Pt): [number, number] | null => {
    const ix0 = Math.round((p.x - minX) / STEP);
    const iy0 = Math.round((p.y - minY) / STEP);
    // search a small neighborhood for an unblocked cell
    for (let rad = 0; rad <= 3; rad++) {
      for (let dx = -rad; dx <= rad; dx++) {
        for (let dy = -rad; dy <= rad; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== rad) continue;
          const ix = ix0 + dx, iy = iy0 + dy;
          if (ix < 0 || iy < 0 || ix >= nx || iy >= ny) continue;
          if (!blocked(ix, iy)) return [ix, iy];
        }
      }
    }
    return null;
  };

  const s = snap(start), t = snap(end);
  if (!s || !t) return null;

  // Dijkstra-lite: cost = steps + 10 per bend, dirs encoded per state.
  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const N = nx * ny * 4;
  const dist = new Float64Array(N).fill(Infinity);
  const prev = new Int32Array(N).fill(-1);
  const stateOf = (ix: number, iy: number, d: number) => toIdx(ix, iy) * 4 + d;
  // simple binary-ish bucket queue via array of [cost, state]
  const heap: [number, number][] = [];
  const push = (c: number, st: number) => {
    heap.push([c, st]);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p][0] <= heap[i][0]) break;
      [heap[p], heap[i]] = [heap[i], heap[p]]; i = p;
    }
  };
  const pop = (): [number, number] | undefined => {
    if (!heap.length) return undefined;
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]]; i = m;
      }
    }
    return top;
  };

  const blockCache = new Int8Array(nx * ny); // 0 unknown, 1 free, 2 blocked
  const isBlocked = (ix: number, iy: number) => {
    const k = toIdx(ix, iy);
    if (blockCache[k] === 0) blockCache[k] = blocked(ix, iy) ? 2 : 1;
    return blockCache[k] === 2;
  };

  for (let d = 0; d < 4; d++) {
    const st = stateOf(s[0], s[1], d);
    dist[st] = 0;
    push(0, st);
  }
  const goalIdx = toIdx(t[0], t[1]);
  let goalState = -1;
  let popped: [number, number] | undefined;
  while ((popped = pop())) {
    const [c, st] = popped;
    if (c > dist[st]) continue;
    const cell = st >> 2, d = st & 3;
    if (cell === goalIdx) { goalState = st; break; }
    const ix = cell % nx, iy = (cell / nx) | 0;
    for (let nd = 0; nd < 4; nd++) {
      const jx = ix + DIRS[nd][0], jy = iy + DIRS[nd][1];
      if (jx < 0 || jy < 0 || jx >= nx || jy >= ny) continue;
      if (isBlocked(jx, jy)) continue;
      const stepCost = usedCells && usedCells.has(toIdx(jx, jy)) ? 0.25 : 1;
      const nc = c + stepCost + (nd === d ? 0 : 10);
      const nst = stateOf(jx, jy, nd);
      if (nc < dist[nst]) { dist[nst] = nc; prev[nst] = st; push(nc, nst); }
    }
  }
  if (goalState < 0) return null;

  // Reconstruct grid path
  const cells: Pt[] = [];
  const cellIdxs: number[] = [];
  for (let st = goalState; st >= 0; st = prev[st]) {
    const cell = st >> 2;
    const ix = cell % nx, iy = (cell / nx) | 0;
    const p = { x: gx(ix), y: gy(iy) };
    const last = cells[cells.length - 1];
    if (!last || last.x !== p.x || last.y !== p.y) { cells.push(p); cellIdxs.push(cell); }
    if (prev[st] < 0) break;
  }
  cells.reverse();

  // Stitch true endpoints on orthogonally (via corner points if needed)
  const path: Pt[] = [start];
  const first = cells[0];
  if (Math.abs(first.x - start.x) > 0.01 && Math.abs(first.y - start.y) > 0.01) {
    path.push({ x: start.x, y: first.y });
  }
  path.push(...cells);
  const lastCell = cells[cells.length - 1];
  if (Math.abs(lastCell.x - end.x) > 0.01 && Math.abs(lastCell.y - end.y) > 0.01) {
    path.push({ x: end.x, y: lastCell.y });
  }
  path.push(end);

  // Collinear simplification — AXIS-based, never area-based. Every leg here
  // is axis-parallel by construction (grid steps + orthogonal stitch
  // corners), but a cross-product tolerance reads a sub-0.1-ft orthogonal
  // stitch corner as "collinear" and welds it into a true diagonal sliver,
  // which downstream axis-parallel invariants (and DXF output) reject. A
  // middle point is redundant only when all three points share an axis line.
  const simp: Pt[] = [];
  for (const p of path) {
    while (simp.length >= 2) {
      const a = simp[simp.length - 2], b = simp[simp.length - 1];
      const sameX = Math.abs(a.x - b.x) < 0.01 && Math.abs(b.x - p.x) < 0.01;
      const sameY = Math.abs(a.y - b.y) < 0.01 && Math.abs(b.y - p.y) < 0.01;
      if (sameX || sameY) simp.pop(); else break;
    }
    simp.push(p);
  }
  return { path: simp, cells: cellIdxs };
}

// Offset an orthogonal polyline sideways by `delta` (interior vertices shift
// by (delta, delta), which moves horizontal segments vertically and vertical
// segments horizontally) while keeping the true endpoints anchored via small
// orthogonal jogs. Used to keep parallel rerouted detours visually separated.
export function offsetOrthogonal(path: Pt[], delta: number): Pt[] {
  if (path.length < 3 || Math.abs(delta) < 0.01) return path;
  const mid = path.slice(1, -1).map(p => ({ x: p.x + delta, y: p.y + delta }));
  const out: Pt[] = [path[0]];
  const a = path[0], b = path[1];
  if (Math.abs(b.x - a.x) < 0.01) out.push({ x: a.x, y: mid[0].y });
  else out.push({ x: mid[0].x, y: a.y });
  out.push(...mid);
  const y2 = path[path.length - 2], z = path[path.length - 1];
  const pn = mid[mid.length - 1];
  if (Math.abs(z.x - y2.x) < 0.01) out.push({ x: z.x, y: pn.y });
  else out.push({ x: pn.x, y: z.y });
  out.push(z);
  return out;
}

function dedupe(pts: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) > 0.01) out.push(p);
  }
  return out;
}

// DC container-run routing method. 'orthogonal' (default) = the sheet-3
// 90° trench legs; 'direct' = straight-line (any-angle) runs from the PCS
// DC compartment to each container entry, per the direct-trench guidance
// drawing. Direct runs that would cross equipment or leave the fence keep
// their orthogonal path (aggregated into one warning).
export type DcRoutingMode = 'orthogonal' | 'direct';

// Per-block DC routing overrides, keyed by the stable block number (the
// "N" in inv-N / bess-N-*). An entry overrides the design-wide dcRouting
// default for just that block's container runs; absent blocks follow the
// default. Overrides for block numbers not present in the current layout go
// dormant with a warning (stable identity across regenerations).

export function generateCableRouting(
  equipment: PlacedEquipment[],
  augmentationZones: AugmentationZone[],
  fence: Pt[],
  pinnedTrenchX?: number | null,
  reservedZones: ReservedZone[] = [],
  islands: IslandInfo[] | null = null,
  dcRouting: DcRoutingMode = 'orthogonal',
  dcRoutingOverrides?: Record<string, DcRoutingMode> | null,
  exclusionZones?: import('./areaZones').AreaZone[] | null
): CableRoutingResult {
  const cables: CableRun[] = [];
  const corridorTrenches: CorridorTrench[] = [];
  const warnings: string[] = [];

  const inverters = equipment.filter(e => e.kind === 'inverter');
  if (!inverters.length || fence.length < 3) {
    return { cables, trench: null, corridorTrenches, warnings };
  }

  // ---- group blocks -------------------------------------------------------
  const blocks: Block[] = inverters.map(inv => {
    const n = inv.id.replace('inv-', '');
    return {
      n,
      inv,
      containers: equipment.filter(e => e.kind === 'bess' && e.id.startsWith(`bess-${n}-`)),
    };
  });

  // Traced / hand-placed yards: their containers carry no auto block ids
  // (`peq-*`, drawing-derived ids), so the id-pattern match above finds
  // nothing and the whole DC + LVAC container service silently vanished.
  // Associate every unclaimed BUILT container with a PCS by deterministic
  // LOCAL QTY3-slot fit, then distance. Traced yards repeat mirrored groups
  // closely enough that world-nearest alone can let one PCS steal a sibling's
  // A-3 container. The visible normalization already places each traced QTY3
  // group on the same standard slots as an auto island, so matching those
  // local slots recovers the customer's intended ownership without ids.
  // Each PCS is capped at the yard-wide containers-per-PCS ratio (three for
  // Big Iron QTY3); aug/future units remain unassociated. Auto layouts are
  // byte-identical because every auto container id matches its block pattern
  // and the orphan list is empty.
  // Orphan assignments stay in their own per-block list — `b.containers`
  // keeps ONLY id-pattern (auto) containers so auto fan geometry, lane
  // indices and cable ids are byte-identical whether or not a hand-placed
  // container also joins the block.
  const blockOrphans = new Map<string, PlacedEquipment[]>();
  {
    const claimed = new Set<string>();
    for (const b of blocks) for (const c of b.containers) claimed.add(c.id);
    const orphans = equipment.filter(e =>
      e.kind === 'bess' && !claimed.has(e.id) && !e.augmented && !e.future);
    if (orphans.length) {
      const hosts = blocks.filter(b => !b.inv.augmented && !b.inv.future);
      const ORPHAN_REACH_FT = 400; // farther than any real container-to-PCS service run
      if (hosts.length) {
        const cap = Math.max(1, Math.ceil(
          (orphans.length + hosts.reduce((s, b) => s + b.containers.length, 0)) / hosts.length));
        const orderedHosts = [...hosts].sort((a, b) => a.n.localeCompare(b.n));
        const orderedOrphans = [...orphans].sort((a, b) => a.id.localeCompare(b.id));
        const load = new Map<string, number>(orderedHosts.map(b => [b.n, b.containers.length]));
        const pairBias =
          (LG_JF2.length - (2 * LG_JF2.width + 3)) / 2;
        const dxPair = (3 + LG_JF2.width) / 2;
        const qty3Fit = (c: PlacedEquipment, inv: PlacedEquipment): number => {
          if (cap !== 3) return Infinity;
          const cs = Math.cos(inv.rotation), sn = Math.sin(inv.rotation);
          const dx = c.x - inv.x, dy = c.y - inv.y;
          const local = { x: dx * cs + dy * sn, y: -dx * sn + dy * cs };
          const rel = c.rotation - inv.rotation;
          const parallel = Math.abs(Math.cos(rel)) >= Math.abs(Math.sin(rel));
          let best = Infinity;
          for (const inward of [1, -1] as const) {
            for (const clearance of [
              CLEARANCES.pcsStandard,
              CLEARANCES.pcsHotClimate,
            ]) {
              const pairY = inward * (
                inv.width / 2 + clearance + LG_JF2.length / 2);
              const a3Y = inward * (
                inv.width / 2 + clearance + LG_JF2.length +
                3 + LG_JF2.width / 2);
              const slots = parallel
                ? [{ x: 0, y: a3Y }]
                : [
                    { x: -inward * pairBias - inward * dxPair, y: pairY },
                    { x: -inward * pairBias + inward * dxPair, y: pairY },
                  ];
              for (const slot of slots) {
                best = Math.min(best,
                  (local.x - slot.x) ** 2 + (local.y - slot.y) ** 2);
              }
            }
          }
          return best;
        };
        const pairs: {
          c: PlacedEquipment; b: Block; d: number; fit: number;
        }[] = [];
        for (const c of orderedOrphans) {
          for (const b of orderedHosts) {
            const d = Math.hypot(c.x - b.inv.x, c.y - b.inv.y);
            if (d <= ORPHAN_REACH_FT) {
              pairs.push({ c, b, d, fit: qty3Fit(c, b.inv) });
            }
          }
        }
        pairs.sort((p, q) =>
          p.fit - q.fit || p.d - q.d ||
          p.c.id.localeCompare(q.c.id) || p.b.n.localeCompare(q.b.n));
        const assigned = new Set<string>();
        const give = (c: PlacedEquipment, b: Block) => {
          assigned.add(c.id);
          blockOrphans.set(b.n, [...(blockOrphans.get(b.n) ?? []), c]);
          load.set(b.n, (load.get(b.n) ?? 0) + 1);
        };
        for (const { c, b } of pairs) {
          if (assigned.has(c.id) || (load.get(b.n) ?? 0) >= cap) continue;
          give(c, b);
        }
        const inReach = new Set(pairs.map(p => p.c.id));
        const unassigned = orphans.filter(c => !assigned.has(c.id));
        const unreachable = unassigned.filter(c => !inReach.has(c.id));
        const overCapacity = unassigned.filter(c => inReach.has(c.id));
        if (unreachable.length) {
          warnings.push(
            `${unreachable.length} BESS container${unreachable.length === 1 ? '' : 's'} ` +
            `sit${unreachable.length === 1 ? 's' : ''} more than ${ORPHAN_REACH_FT} ft from every PCS — ` +
            `no DC/480V container service routed; review equipment placement in detailed design.`);
        }
        if (overCapacity.length) {
          warnings.push(
            `${overCapacity.length} BESS container${overCapacity.length === 1 ? '' : 's'} ` +
            `could not be assigned without exceeding the calculated QTY${cap} PCS ownership cap — ` +
            `no DC/480V container service routed; review the traced equipment grouping.`);
        }
      } else {
        warnings.push(
          `${orphans.length} BESS container${orphans.length === 1 ? '' : 's'} have no PCS available ` +
          `for DC/480V container service — review equipment placement in detailed design.`);
      }
    }
  }

  // Dangling per-block DC routing overrides (block number no longer in the
  // layout) go dormant with a warning — they revive if the block returns.
  if (dcRoutingOverrides) {
    const present = new Set(blocks.map(b => b.n));
    const dangling = Object.keys(dcRoutingOverrides).filter(k => !present.has(k));
    if (dangling.length) {
      warnings.push(
        `Per-block DC routing override${dangling.length === 1 ? '' : 's'} for ` +
        `block${dangling.length === 1 ? '' : 's'} ${dangling.join(', ')} match no current block — ` +
        `kept dormant until the layout includes ${dangling.length === 1 ? 'it' : 'them'} again.`
      );
    }
  }

  // Underground exclusion areas are hard keep-outs for every buried run:
  // folding them into the "inside fence" predicate makes the straight-path
  // check, the reroute cell validity AND the detour re-validation all avoid
  // them with one shared rule. No zones drawn => predicate (and every route)
  // is byte-identical to before.
  const exclRects = exclusionRects(exclusionZones);
  const insideFence = (pts: Pt[], margin = 1) =>
    pts.every(p => pointInPolygon(p, fence) && distanceToPolygonEdge(p, fence) >= margin &&
      !pointInExclusion(p, exclRects));
  const insideFenceOnly = (pts: Pt[], margin = 1) =>
    pts.every(p => pointInPolygon(p, fence) && distanceToPolygonEdge(p, fence) >= margin);

  // Equipment bodies used by the shared acceptance gate below. Manholes and
  // FJBs are deliberate pass-through points (same exemption as G-RT-1); every
  // other body is a routing obstacle. Keep the unexpanded body so a terminal
  // endpoint can be associated with exactly ONE piece of served equipment,
  // then expand per run (a corridor centerline needs more clearance than an
  // individual conductor).
  const equipmentObstacles = equipment
    .filter(e => e.kind !== 'manhole' && e.kind !== 'feederJunctionBox')
    .map(e => {
      const rot = Math.abs(Math.sin(e.rotation)) > 0.5;
      const hx = (rot ? e.width : e.length) / 2;
      const hy = (rot ? e.length : e.width) / 2;
      return {
        id: e.id,
        x: e.x,
        y: e.y,
        cos: Math.cos(e.rotation),
        sin: Math.sin(e.rotation),
        hl: e.length / 2,
        hw: e.width / 2,
        body: { x1: e.x - hx, y1: e.y - hy, x2: e.x + hx, y2: e.y + hy },
      };
    })
    .filter(o => o.body.x2 > o.body.x1 && o.body.y2 > o.body.y1);
  const expandedEquipmentRects = (clearance: number): Rect[] =>
    equipmentObstacles.map(o => ({
      x1: o.body.x1 - clearance, y1: o.body.y1 - clearance,
      x2: o.body.x2 + clearance, y2: o.body.y2 + clearance,
    }));
  const inRect = (p: Pt, r: Rect, eps = 1e-6): boolean =>
    p.x >= r.x1 - eps && p.x <= r.x2 + eps &&
    p.y >= r.y1 - eps && p.y <= r.y2 + eps;
  const equipmentLocalPoint = (
    p: Pt,
    o: (typeof equipmentObstacles)[number],
  ): Pt => {
    const dx = p.x - o.x, dy = p.y - o.y;
    return {
      x: dx * o.cos + dy * o.sin,
      y: -dx * o.sin + dy * o.cos,
    };
  };
  const pointInEquipment = (
    p: Pt,
    o: (typeof equipmentObstacles)[number],
    grow = 0,
  ): boolean => {
    const q = equipmentLocalPoint(p, o);
    return Math.abs(q.x) <= o.hl + grow + 1e-6 &&
      Math.abs(q.y) <= o.hw + grow + 1e-6;
  };
  const endpointOwner = (p: Pt): string | null => {
    // Endpoint-on-edge is normal. If malformed/overlapping equipment gives
    // more than one candidate, the nearest center owns the terminal; being
    // near one terminal must never exempt a different enclosure.
    const owners = equipmentObstacles.filter(o => pointInEquipment(p, o));
    if (!owners.length) return null;
    owners.sort((a, b) =>
      Math.hypot(p.x - a.x, p.y - a.y) - Math.hypot(p.x - b.x, p.y - b.y) ||
      a.id.localeCompare(b.id));
    return owners[0].id;
  };
  const segmentRectSpan = (a: Pt, b: Pt, r: Rect): [number, number] | null => {
    // Liang-Barsky interval against the rect interior. Returning the exact
    // interval (rather than point-sampling) catches short corner clips too.
    const dx = b.x - a.x, dy = b.y - a.y;
    let lo = 0, hi = 1;
    const p = [-dx, dx, -dy, dy];
    const q = [a.x - r.x1, r.x2 - a.x, a.y - r.y1, r.y2 - a.y];
    for (let i = 0; i < 4; i++) {
      if (Math.abs(p[i]) < 1e-12) {
        if (q[i] <= 1e-9) return null;
        continue;
      }
      const t = q[i] / p[i];
      if (p[i] < 0) lo = Math.max(lo, t);
      else hi = Math.min(hi, t);
      if (lo >= hi - 1e-9) return null;
    }
    return [lo, hi];
  };
  const segmentEquipmentSpan = (
    a: Pt,
    b: Pt,
    o: (typeof equipmentObstacles)[number],
    grow = 0,
  ): [number, number] | null => {
    const al = equipmentLocalPoint(a, o);
    const bl = equipmentLocalPoint(b, o);
    const pad = grow + 1e-6;
    return segmentRectSpan(al, bl, {
      x1: -o.hl - pad, y1: -o.hw - pad,
      x2: o.hl + pad, y2: o.hw + pad,
    });
  };
  const transitsEquipment = (
    pts: Pt[],
    routeRects: Rect[],
    explicitOwners?: readonly [string | null, string | null],
  ): boolean => {
    if (pts.length < 2) return false;
    const startOwner = explicitOwners?.[0] ?? endpointOwner(pts[0]);
    const endOwner = explicitOwners?.[1] ?? endpointOwner(pts[pts.length - 1]);
    const segBase: number[] = [0];
    for (let i = 0; i + 1 < pts.length; i++) {
      segBase.push(segBase[i] + Math.hypot(
        pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y));
    }
    const total = segBase[segBase.length - 1];
    for (let oi = 0; oi < routeRects.length; oi++) {
      const spans: Array<[number, number]> = [];
      for (let i = 0; i + 1 < pts.length; i++) {
        const len = segBase[i + 1] - segBase[i];
        if (len <= 1e-9) continue;
        const hit = segmentRectSpan(pts[i], pts[i + 1], routeRects[oi]);
        if (hit) spans.push([segBase[i] + hit[0] * len, segBase[i] + hit[1] * len]);
      }
      if (!spans.length) continue;
      spans.sort((a, b) => a[0] - b[0]);
      const merged: Array<[number, number]> = [];
      for (const span of spans) {
        const last = merged[merged.length - 1];
        if (last && span[0] <= last[1] + 0.01) last[1] = Math.max(last[1], span[1]);
        else merged.push([...span]);
      }
      const ownId = equipmentObstacles[oi]?.id;
      for (const [lo, hi] of merged) {
        const startStub = ownId === startOwner && lo <= 0.01;
        const endStub = ownId === endOwner && hi >= total - 0.01;
        // A terminal may penetrate only the short contiguous landing stub,
        // not gain immunity for a later/whole-body transit of the same unit.
        const unexemptLo = startStub ? Math.max(lo, 6) : lo;
        const unexemptHi = endStub ? Math.min(hi, total - 6) : hi;
        if (unexemptHi - unexemptLo > 0.05) return true;
      }
    }
    return false;
  };

  // Sample each segment so mid-segment fence exits are caught too
  const sampled = (pts: Pt[]): Pt[] => {
    const out: Pt[] = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 5));
      for (let s2 = 0; s2 < steps; s2++) {
        out.push({ x: a.x + ((b.x - a.x) * s2) / steps, y: a.y + ((b.y - a.y) * s2) / steps });
      }
    }
    out.push(pts[pts.length - 1]);
    return out;
  };

  // Shared-corridor state for rerouted detours: cells used by earlier detours
  // are discounted in the router so later detours snap onto the same corridor,
  // then each rerouted run gets a small parallel offset (per class, plus a
  // within-class increment) so the bundled runs stay visually separated.
  const usedCells = new Set<number>();
  const rerouteCount: Record<CableRun['class'], number> =
    { DC: 0, MV: 0, LVAC: 0, AUXPWR: 0, FIBER: 0, FIBER_TRUNK: 0, CATL: 0 };
  const CLASS_OFFSET: Record<CableRun['class'], number> =
    { DC: 0, MV: 0.7, LVAC: 1.4, AUXPWR: 1.75, FIBER: 2.1, FIBER_TRUNK: 2.45, CATL: 2.8 };
  // Offsets actually applied to rerouted runs. Fallback candidates (half /
  // negated deltas) from DIFFERENT detour groups can otherwise land within a
  // pen width of each other in a shared corridor; every applied offset must
  // keep >= 0.3 ft from all previously applied ones so bundled runs stay
  // readable in CAD.
  const usedDeltas: number[] = [];
  const MIN_PARALLEL_SEP = 0.3;

  const addRun = (
    id: string, cls: CableRun['class'], pts: Pt[], ref = false,
    polarity?: CableRun['polarity'],
    equipmentClearance = 0.75,
    failClosedOnEquipment = false,
    explicitOwners?: readonly [string | null, string | null],
  ): CableRun | null => {
    const clean = dedupe(pts);
    if (clean.length < 2) return null;
    const routeObstacleRects = expandedEquipmentRects(equipmentClearance);
    const cleanSamples = sampled(clean);
    const cleanInside = insideFence(cleanSamples);
    // Task 902's shared corridor discipline applies to traced 480V/fiber.
    // MV feeder home runs use the stricter feeder router; legacy MV row buses
    // have separately anchored drops and must not be moved independently.
    // Scope the new obstacle pass to drawing-derived service ids and the
    // explicit strict collector calls below. A mixed auto block may contain
    // one peq-* addition; that must not perturb its existing bess-* runs.
    const equipmentAware =
      (failClosedOnEquipment || id.includes('peq-')) &&
      (cls === 'LVAC' || cls === 'FIBER');
    const cleanEquipment = !equipmentAware ||
      !transitsEquipment(clean, routeObstacleRects, explicitOwners);
    if (!cleanInside || !cleanEquipment) {
      // A path that leaves the fence/exclusion envelope OR crosses equipment
      // gets one shared equipment-aware reroute. Previously an in-fence
      // traced-yard collector skipped this branch and silently crossed pads.
      const detour = rerouteOrthogonal(
        clean[0], clean[clean.length - 1], fence, routeObstacleRects, insideFence, usedCells
      );
      if (detour && detour.path.length >= 2 && insideFence(sampled(detour.path))) {
        const delta = CLASS_OFFSET[cls] + rerouteCount[cls] * 0.35;
        let final: Pt[] | null = null;
        let finalDelta: number | null = null;
        const candidates = [delta, -delta, delta / 2, -delta / 2];
        for (let k = 1; k <= 8; k++) {
          candidates.push(delta + k * 0.35, -(delta + k * 0.35));
        }
        // Two contracts share this reroute: (a) bundled runs in a shared
        // corridor keep >= 0.3 ft parallel separation (comb-parcel check),
        // and (b) traced-yard service corridors must keep their TRENCH BAND
        // — wider than the cable line — clear of container pads (G-RT-9,
        // task 902). The offset recheck only validates the cable line, so
        // for equipment-aware traced service runs the unshifted grid path
        // (whose band the router provably cleared) stays the first choice;
        // for everything else (auto-layout bus detours), offsets come first
        // and the unshifted path is the fail-safe of last resort.
        const base = dedupe(detour.path);
        if (equipmentAware && base.length >= 2 &&
            !transitsEquipment(base, routeObstacleRects, explicitOwners)) final = base;
        for (const dTry of candidates) {
          if (final) break;
          if (usedDeltas.some(u => Math.abs(u - dTry) < MIN_PARALLEL_SEP)) continue;
          const cand = dedupe(offsetOrthogonal(detour.path, dTry));
          if (cand.length >= 2 && insideFence(sampled(cand)) &&
              !transitsEquipment(cand, routeObstacleRects, explicitOwners)) {
            final = cand;
            finalDelta = dTry;
            break;
          }
        }
        if (!final && base.length >= 2 &&
            !transitsEquipment(base, routeObstacleRects, explicitOwners)) {
          final = base;
        }
        if (final) {
          for (const c of detour.cells) usedCells.add(c);
          rerouteCount[cls]++;
          if (finalDelta !== null) usedDeltas.push(finalDelta);
          const run = { id, class: cls, pts: final, ref: ref || undefined, polarity };
          cables.push(run);
          return run;
        }
      }
      // A heavily reused corridor can make the shared-cell discount prefer a
      // stitched endpoint approach that clips a pad even though an independent
      // clear route exists. Retry once without the bundle bias before failing
      // a traced service conductor closed.
      if (equipmentAware) {
        const independent = rerouteOrthogonal(
          clean[0], clean[clean.length - 1],
          fence, routeObstacleRects, insideFence,
        );
        const independentPath = independent && dedupe(independent.path);
        if (independent && independentPath && independentPath.length >= 2 &&
            insideFence(sampled(independentPath)) &&
            !transitsEquipment(independentPath, routeObstacleRects, explicitOwners)) {
          for (const c of independent.cells) usedCells.add(c);
          const run = {
            id, class: cls, pts: independentPath,
            ref: ref || undefined, polarity,
          };
          cables.push(run);
          return run;
        }
      }
      // Traced yards may keep equipment AS DRAWN partly or wholly outside
      // the fence (warn-only placement — the reference geometry wins). Its
      // service run then necessarily leaves the fence to reach that
      // equipment, so no in-fence detour can ever exist. Never silently drop
      // the conductor: when an endpoint lands on equipment that itself sits
      // outside the fence, keep the drawn route and warn loudly.
      {
        const onEquip = (p: Pt) => routeObstacleRects.some(r =>
          p.x >= r.x1 && p.x <= r.x2 && p.y >= r.y1 && p.y <= r.y2);
        const outsideOwners = new Set<number>();
        for (const p of [clean[0], clean[clean.length - 1]]) {
          if (pointInPolygon(p, fence)) continue;
          const owner = routeObstacleRects.findIndex(r =>
            p.x >= r.x1 && p.x <= r.x2 && p.y >= r.y1 && p.y <= r.y2);
          if (owner >= 0) outsideOwners.add(owner);
        }
        const clearOfForeignEquipment = routeObstacleRects.every((r, ri) =>
          outsideOwners.has(ri) ||
          clean.every((p, i) => i === clean.length - 1 ||
            segmentRectSpan(p, clean[i + 1], r) === null));
        const samples = cleanSamples;
        const servesOutsideEquip = [clean[0], clean[clean.length - 1]]
          .some(p => !pointInPolygon(p, fence) && onEquip(p));
        if (servesOutsideEquip && clearOfForeignEquipment &&
            samples.every(p => onEquip(p) || !pointInExclusion(p, exclRects))) {
          warnings.push(`Cable run ${id} serves equipment kept as drawn outside the fence line — route kept as drawn; review the fence or the equipment position.`);
          const run = { id, class: cls, pts: clean, ref: ref || undefined, polarity };
          cables.push(run);
          return run;
        }
      }
      if (insideFenceOnly(cleanSamples)) {
        // A traced 480V/fiber collector is export geometry, not reference
        // linework. If its equipment-aware router cannot find a clear path,
        // fail closed: never draw a known equipment transit or derive a trench
        // band from it. The warning keeps the missing service visible.
        if (failClosedOnEquipment && !cleanEquipment) {
          warnings.push(
            `Cable run ${id} crosses equipment and no compliant detour was found — ` +
            `route omitted; resolve the conflict before issue.`);
          return null;
        }
        // Other cable classes retain their historical keep-and-warn behavior.
        // Name every unresolved keep-out class so it cannot remain silent.
        const conflicts: string[] = [];
        if (!cleanEquipment) conflicts.push('equipment');
        if (!cleanInside) conflicts.push('an UNDERGROUND EXCLUSION AREA');
        warnings.push(
          `Cable run ${id} crosses ${conflicts.join(' and ')} and no compliant detour was found — ` +
          `route kept; resolve the conflict before issue.`);
        const run = { id, class: cls, pts: clean, ref: ref || undefined, polarity };
        cables.push(run);
        return run;
      }
      warnings.push(`Cable run ${id} would leave the fenced yard — omitted, review in detailed design.`);
      return null;
    }
    const run = { id, class: cls, pts: clean, ref: ref || undefined, polarity };
    cables.push(run);
    return run;
  };

  // Traced row/column collectors carry 480V and fiber in ONE physical trench.
  // Route the shared spine once with full band-edge clearance, copy both cable
  // classes onto that accepted geometry, and derive one trench record per
  // orthogonal leg. Thus a reroute can never leave a stale straight band
  // behind while the cable bends elsewhere.
  const appendTracedTrenchLegs = (run: CableRun, islandBase: number): void => {
    let legN = 0;
    for (let i = 0; i + 1 < run.pts.length; i++) {
      const a = run.pts[i], b = run.pts[i + 1];
      // A cable terminal may occupy a short owner-equipment landing stub, but
      // the civil trench band must stop at the enclosure clearance line.  If
      // the whole cable leg were published as a centered band, its first two
      // feet would be drawn back through the source pad.  Subtract exact
      // rotation-aware equipment spans before publishing the physical pieces.
      const blocked = equipmentObstacles
        .map(o => segmentEquipmentSpan(a, b, o, CORRIDOR_TRENCH_WIDTH / 2))
        .filter((span): span is [number, number] => !!span)
        .sort((x, y) => x[0] - y[0]);
      const merged: Array<[number, number]> = [];
      for (const span of blocked) {
        const last = merged[merged.length - 1];
        if (last && span[0] <= last[1] + 1e-9) last[1] = Math.max(last[1], span[1]);
        else merged.push([...span]);
      }
      const clear: Array<[number, number]> = [];
      let cursor = 0;
      for (const [lo, hi] of merged) {
        if (lo > cursor + 1e-9) clear.push([cursor, lo]);
        cursor = Math.max(cursor, hi);
      }
      if (cursor < 1 - 1e-9) clear.push([cursor, 1]);
      for (const [lo, hi] of clear) {
        const p = {
          x: a.x + (b.x - a.x) * lo,
          y: a.y + (b.y - a.y) * lo,
        };
        const q = {
          x: a.x + (b.x - a.x) * hi,
          y: a.y + (b.y - a.y) * hi,
        };
        const length = Math.hypot(q.x - p.x, q.y - p.y);
        if (length < 0.1) continue;
        const vertical = Math.abs(q.x - p.x) < 0.05;
        corridorTrenches.push({
          islandN: islandBase + legN++,
          y: vertical ? (p.x + q.x) / 2 : (p.y + q.y) / 2,
          minX: vertical ? Math.min(p.y, q.y) : Math.min(p.x, q.x),
          maxX: vertical ? Math.max(p.y, q.y) : Math.max(p.x, q.x),
          width: CORRIDOR_TRENCH_WIDTH,
          section: 'AUX_FIBER',
          cx: (p.x + q.x) / 2,
          cy: (p.y + q.y) / 2,
          // Orthogonal trench bands are unoriented physical rectangles. Store
          // canonical 0°/90° rather than direction-sensitive 180°/-90°.
          angleDeg: vertical ? 90 : 0,
          length,
          vertical: vertical || undefined,
          sideLane: true,
        });
      }
    }
  };
  const addTracedCorridor = (
    suffix: string, pts: Pt[], islandBase: number,
  ): CableRun | null => {
    const clearance = CORRIDOR_TRENCH_WIDTH / 2 + 0.5;
    const lvac = addRun(
      `lvac-${suffix}`, 'LVAC', pts, false, undefined, clearance, true);
    if (!lvac) return null;
    // This is one accepted physical path.  Do not independently route fiber:
    // a second acceptance pass could bend it differently and leave cable and
    // civil geometry disagreeing.  Landing drops remain separate below.
    cables.push({ id: `fiber-${suffix}`, class: 'FIBER', pts: lvac.pts.map(p => ({ ...p })) });
    appendTracedTrenchLegs(lvac, islandBase);
    return lvac;
  };
  const addTracedSourceLead = (
    id: string, cls: 'LVAC' | 'FIBER', pts: Pt[], islandBase: number,
  ): CableRun | null => {
    const run = addRun(id, cls, pts, false, undefined, 0.75, true);
    if (run) appendTracedTrenchLegs(run, islandBase);
    return run;
  };

  // A collector may bend away from its requested row/column line to clear an
  // enclosure. Service stubs must land on that accepted path, not the stale
  // requested baseline, or the visible cable ends a few feet short of its bus.
  const closestPointOnRun = (p: Pt, pts: Pt[]): Pt => {
    let best = pts[0] ?? p;
    let bestD2 = Infinity;
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i], b = pts[i + 1];
      const dx = b.x - a.x, dy = b.y - a.y;
      const len2 = dx * dx + dy * dy;
      const t = len2 > 1e-9
        ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2))
        : 0;
      const q = { x: a.x + t * dx, y: a.y + t * dy };
      const d2 = (p.x - q.x) ** 2 + (p.y - q.y) ** 2;
      if (d2 < bestD2) { best = q; bestD2 = d2; }
    }
    return best;
  };

  // ---- DC (+)/(−) conductor pairs -------------------------------------------
  // Reference detail B006-1 (DC CABLE (+) red / DC CABLE (−) blue): every
  // PCS→BESS compartment DC connection is TWO conductors with visibly
  // DIFFERENT paths — red fans on the near corridor straight to the entry
  // terminal; blue departs the adjacent compartment position (+0.55 ft along
  // the stagger), rides its own corridor one 1.1 ft pitch further out, and
  // lands 0.6 ft inboard of red on the container face. The per-run corridor
  // pitch doubles (2× base) so red/blue lanes interleave with the full base
  // spacing between EVERY adjacent trench line across the fan, preserving
  // the nested no-crossing guarantee.
  const addDcPair = (id: string, posPts: Pt[], negPts: Pt[]) => {
    addRun(`${id}-pos`, 'DC', posPts, false, 'pos');
    addRun(`${id}-neg`, 'DC', negPts, false, 'neg');
  };

  // Direct DC routing: collapse a planned orthogonal container PAIR to two
  // straight 0.6-ft-apart chords only when BOTH chords pass every keep-out
  // the structured paths would face in addRun — equipment bodies (endpoint
  // exemption scoped to the rects that OWN each endpoint, so a third
  // container near an endpoint still blocks), the fence (traced equipment
  // drawn outside the fence stays warn-only, mirroring addRun's keep
  // policy), and underground exclusion areas (hard keep-outs everywhere
  // except on the equipment footprint itself). The collapse is ONE decision
  // for the pair: if either conductor's chord fails a check, BOTH keep
  // their structured orthogonal paths. Blocked pairs are counted for one
  // aggregated warning.
  let dcDirectBlocked = 0;
  const dcModeOf = (blockN: string): DcRoutingMode =>
    dcRoutingOverrides?.[blockN] ?? dcRouting;
  const pointSegmentDistance = (p: Pt, a: Pt, b: Pt): number => {
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 <= 1e-12 ? 0 : Math.max(0, Math.min(1,
      ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  };
  const segmentsTouch = (a: Pt, b: Pt, c: Pt, d: Pt): boolean => {
    const cross = (p: Pt, q: Pt, r: Pt) =>
      (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
    const on = (p: Pt, q: Pt, r: Pt) =>
      Math.abs(cross(p, q, r)) <= 1e-9 &&
      r.x >= Math.min(p.x, q.x) - 1e-9 && r.x <= Math.max(p.x, q.x) + 1e-9 &&
      r.y >= Math.min(p.y, q.y) - 1e-9 && r.y <= Math.max(p.y, q.y) + 1e-9;
    const abC = cross(a, b, c), abD = cross(a, b, d);
    const cdA = cross(c, d, a), cdB = cross(c, d, b);
    if (((abC > 1e-9 && abD < -1e-9) || (abC < -1e-9 && abD > 1e-9)) &&
        ((cdA > 1e-9 && cdB < -1e-9) || (cdA < -1e-9 && cdB > 1e-9))) return true;
    return on(a, b, c) || on(a, b, d) || on(c, d, a) || on(c, d, b);
  };
  const segmentDistance = (a: Pt, b: Pt, c: Pt, d: Pt): number =>
    segmentsTouch(a, b, c, d) ? 0 : Math.min(
      pointSegmentDistance(a, c, d),
      pointSegmentDistance(b, c, d),
      pointSegmentDistance(c, a, b),
      pointSegmentDistance(d, a, b),
    );
  const segmentInsideFence = (a: Pt, b: Pt, margin = 1): boolean => {
    if (!pointInPolygon(a, fence) || !pointInPolygon(b, fence)) return false;
    for (let i = 0; i < fence.length; i++) {
      const c = fence[i], d = fence[(i + 1) % fence.length];
      if (segmentDistance(a, b, c, d) < margin - 1e-9) return false;
    }
    return true;
  };
  const spanCoveredByEquipment = (
    a: Pt,
    b: Pt,
    span: [number, number],
  ): boolean => {
    const covers = equipmentObstacles
      .map(o => segmentEquipmentSpan(a, b, o))
      .filter((s): s is [number, number] => !!s)
      .sort((x, y) => x[0] - y[0]);
    let end = span[0];
    for (const [lo, hi] of covers) {
      if (lo > end + 1e-9) break;
      if (hi > end) end = hi;
      if (end >= span[1] - 1e-9) return true;
    }
    return false;
  };
  const straightDcOk = (
    a: Pt,
    b: Pt,
    ownA: Pt,
    ownB: Pt,
    explicitOwners?: readonly [string, string],
  ): boolean => {
    const total = Math.hypot(b.x - a.x, b.y - a.y);
    if (total <= 1e-9) return false;
    const startOwner = explicitOwners?.[0] ?? endpointOwner(ownA);
    const endOwner = explicitOwners?.[1] ?? endpointOwner(ownB);
    for (const o of equipmentObstacles) {
      const hit = segmentEquipmentSpan(a, b, o, 0.75);
      if (!hit) continue;
      const lo = hit[0] * total, hi = hit[1] * total;
      const startStub = o.id === startOwner && lo <= 0.01;
      const endStub = o.id === endOwner && hi >= total - 0.01;
      const unexemptLo = startStub ? Math.max(lo, 6) : lo;
      const unexemptHi = endStub ? Math.min(hi, total - 6) : hi;
      if (unexemptHi - unexemptLo > 0.05) return false;
    }
    for (const r of exclRects) {
      const hit = segmentRectSpan(a, b, {
        x1: r.x1 - 1e-6, y1: r.y1 - 1e-6,
        x2: r.x2 + 1e-6, y2: r.y2 + 1e-6,
      });
      if (hit && !spanCoveredByEquipment(a, b, hit)) return false;
    }
    return segmentInsideFence(a, b);
  };
  const dcPairPaths = (
    blockN: string,
    pos: Pt[],
    neg: Pt[],
    faceAligned = false,
    explicitOwners?: readonly [string, string],
  ): [Pt[], Pt[]] => {
    if (dcModeOf(blockN) !== 'direct' || pos.length <= 2) return [pos, neg];
    const a = pos[0], b = pos[pos.length - 1];
    if (straightDcOk(a, b, a, b, explicitOwners)) {
      let a2: Pt, b2: Pt;
      if (faceAligned) {
        // Traced/hand-placed yards draw equipment at arbitrary angles, so a
        // collapsed chord can run nearly ALONG a face; a chord-perpendicular
        // offset there would push the (−) terminal inside the equipment
        // body. Offset ALONG each face instead — the sheet-3 stagger
        // direction. The first/last structured legs leave/enter
        // perpendicular to their faces, so each face direction is that
        // leg's perpendicular.
        const faceOffset = (origin: Pt, legTo: Pt, toward: Pt): Pt => {
          let fx = -(legTo.y - origin.y), fy = legTo.x - origin.x;
          const l = Math.hypot(fx, fy) || 1;
          fx /= l; fy /= l;
          if (fx * (toward.x - origin.x) + fy * (toward.y - origin.y) < 0) { fx = -fx; fy = -fy; }
          return { x: origin.x + fx * 0.6, y: origin.y + fy * 0.6 };
        };
        a2 = faceOffset(a, pos[1], neg[0]);
        b2 = faceOffset(b, pos[pos.length - 2], neg[neg.length - 1]);
      } else {
        // Fallback chord-perpendicular offset (unused by current auto/island/
        // traced callers, which all pass faceAligned). Kept for callers that
        // collapse without structured first/last face legs.
        const dx = b.x - a.x, dy = b.y - a.y, l = Math.hypot(dx, dy) || 1;
        let nx = -dy / l, ny = dx / l;
        if (nx * (neg[0].x - a.x) + ny * (neg[0].y - a.y) < 0) { nx = -nx; ny = -ny; }
        a2 = { x: a.x + nx * 0.6, y: a.y + ny * 0.6 };
        b2 = { x: b.x + nx * 0.6, y: b.y + ny * 0.6 };
      }
      // Blue must pass the SAME keep-out checks, with its endpoint
      // exemptions anchored to the pair's owning equipment.
      if (straightDcOk(a2, b2, a, b, explicitOwners)) return [[a, b], [a2, b2]];
    }
    dcDirectBlocked++;
    return [pos, neg];
  };

  // One canonical QTY3 PCS/container topology, expressed in whichever frame
  // the caller supplies. Auto islands pass world/local-island coordinates;
  // traced yards pass the PCS's own de-rotated frame and map the result back.
  // Sharing this planner prevents traced direct mode from falling back to the
  // generic rectangular fan that disagrees with CAR-D-B005-1.
  const planQty3Block = (
    inv: PlacedEquipment,
    containers: PlacedEquipment[],
    corridorY: number,
  ): {
    routes: Array<{
      c: PlacedEquipment;
      pos: Pt[];
      neg: Pt[];
      lvac: Pt[];
      dropX: number;
    }>;
    drops: number[];
  } => {
    const m: 1 | -1 = Math.cos(inv.rotation) >= 0 ? 1 : -1;
    const midY = containers.reduce((s, c) => s + c.y, 0) /
      Math.max(containers.length, 1);
    const sgn = (Math.sign(midY - inv.y) || 1) as 1 | -1;
    const invFace = inv.y + sgn * (inv.width / 2);
    const plans = containers.map(c => {
      const rot = Math.abs(Math.sin(c.rotation - inv.rotation)) > 0.5;
      if (rot) {
        const s2 = c.epanel === 'left' ? -1 : 1;
        return {
          c, rot, s2,
          destX: c.x + s2 * (LG_JF2.width / 2 - 1.0),
          destY: c.y - sgn * (LG_JF2.length / 2),
        };
      }
      const endSgn = c.epanel === 'left' ? -1 : 1;
      const endX = c.x + endSgn * (LG_JF2.length / 2);
      return {
        c, rot, s2: endSgn,
        destX: endX - endSgn * 1.0,
        destY: c.y + sgn * (LG_JF2.width / 2 - 1.0),
      };
    });
    const crossers = plans.filter(p => !p.rot).map(p => ({
      minX: p.c.x - LG_JF2.length / 2,
      maxX: p.c.x + LG_JF2.length / 2,
    }));
    const clearRiserX = (x: number): number => {
      for (const cr of crossers) {
        if (x > cr.minX - 0.3 && x < cr.maxX + 0.3) {
          const west = cr.minX - 1.2;
          const east = cr.maxX + 1.2;
          return Math.abs(x - west) <= Math.abs(x - east) ? west : east;
        }
      }
      return x;
    };
    const exitXs = plans
      .map((_, i) => inv.x - m * (inv.length / 2 - 1.5 - i * 1.1))
      .sort((a, b) => a - b);
    const ordered = [...plans].sort((a, b) => a.destX - b.destX);
    const byReach = ordered
      .map((p, idx) => ({ idx, reach: Math.abs(p.destX - exitXs[idx]) }))
      .sort((a, b) => b.reach - a.reach);
    const corridorOf: number[] = new Array(ordered.length);
    byReach.forEach((r, k) => { corridorOf[r.idx] = k; });
    const routes = ordered.map((p, idx) => {
      const buildDc = (
        exitX: number, corY: number, destX: number, destY: number,
      ): Pt[] =>
        Math.abs(exitX - destX) < 0.05
          ? [{ x: exitX, y: invFace }, { x: destX, y: destY }]
          : [
              { x: exitX, y: invFace },
              { x: exitX, y: corY },
              { x: destX, y: corY },
              { x: destX, y: destY },
            ];
      const exitX = exitXs[idx];
      const corYPos = invFace + sgn * (1.5 + corridorOf[idx] * 2.2);
      const corYNeg = corYPos + sgn * 1.1;
      const negDestX = p.destX - p.s2 * 0.6;
      let lvac: Pt[];
      let dropX: number;
      if (p.rot) {
        const ox = clearRiserX(
          p.c.x - p.s2 * (LG_JF2.width / 2 + 1.2));
        const hookY = p.destY - sgn * 1.5;
        lvac = [
          { x: p.destX, y: p.destY },
          { x: p.destX, y: hookY },
          { x: ox, y: hookY },
          { x: ox, y: corridorY },
        ];
        dropX = ox;
      } else {
        lvac = [
          { x: p.destX, y: p.destY },
          { x: p.destX, y: corridorY },
        ];
        dropX = p.destX;
      }
      return {
        c: p.c,
        pos: buildDc(exitX, corYPos, p.destX, p.destY),
        neg: buildDc(exitX + m * 0.55, corYNeg, negDestX, p.destY),
        lvac,
        dropX,
      };
    });
    return { routes, drops: routes.map(r => r.dropX) };
  };

  // ---- generic container fan for traced / hand-placed blocks ---------------
  // Proximity-associated blocks (drawing-traced yards) carry arbitrary
  // orientations and drawn dimensions. The fan below is the sheet-3 corridor
  // pattern expressed in the PCS's own frame (the drawing's rotation): DC
  // exits stagger along the container-facing face from the DC-compartment
  // end at the 1.1 ft pitch, corridors nest at the 2.2 ft pitch with the
  // (−) lane one 1.1 ft pitch further out and 0.6 ft inboard at the
  // container — so both the 90° and the direct (collapsed) modes match the
  // non-compact design rules. Containers drawn beside a PCS END (not off a
  // face) keep the legacy orientation-agnostic L. Every run still passes
  // the shared fence/exclusion validation in addRun.
  const clampf = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), lo > hi ? lo : hi);
  const facePoint = (e: PlacedEquipment, toward: Pt, lateral: number): { p: Pt; axis: 'x' | 'y' } => {
    const rot = Math.abs(Math.sin(e.rotation)) > 0.5;
    const hx = (rot ? e.width : e.length) / 2;
    const hy = (rot ? e.length : e.width) / 2;
    const dx = toward.x - e.x, dy = toward.y - e.y;
    if (Math.abs(dx) * hy >= Math.abs(dy) * hx) {
      // exit through an east/west face; lateral offset runs along y
      return {
        p: { x: e.x + (dx >= 0 ? hx : -hx), y: clampf(e.y + lateral, e.y - hy + 0.5, e.y + hy - 0.5) },
        axis: 'x',
      };
    }
    return {
      p: { x: clampf(e.x + lateral, e.x - hx + 0.5, e.x + hx - 0.5), y: e.y + (dy >= 0 ? hy : -hy) },
      axis: 'y',
    };
  };
  const lPath = (a: Pt, b: Pt, exitAxis: 'x' | 'y'): Pt[] => {
    // First leg leaves perpendicular to the exit face so the run clears its
    // own equipment before turning.
    const elbow = exitAxis === 'x' ? { x: b.x, y: a.y } : { x: a.x, y: b.y };
    if ((Math.abs(elbow.x - a.x) < 0.1 && Math.abs(elbow.y - a.y) < 0.1) ||
        (Math.abs(elbow.x - b.x) < 0.1 && Math.abs(elbow.y - b.y) < 0.1)) return [a, b];
    return [a, elbow, b];
  };
  // Traced/hand-placed yards carry their own aux transformers or switch
  // panels imported as part of the yard drawing. When any such gear exists
  // (non-island-specific), orphan container LVAC feeds should originate from
  // the nearest one instead of the row-bus approximation — the one-line and
  // BOM then reflect the actual aux topology rather than a virtual bus.
  // Island-aux-xfmr-<n> units are per-island corridor gear; they serve the
  // island collector, not individual container runs.
  const tracedAuxSources = equipment.filter(e =>
    (e.kind === 'auxTransformer' && !e.id.startsWith('island-aux-')) ||
    e.kind === 'auxSwitchPanel');
  // Traced container LVAC landing paths are planned with the DC fan, but are
  // not published until their physical AUX_FIBER corridor has passed the
  // shared acceptance gate.  Publishing early and subsequently moving one
  // endpoint could create an unvalidated diagonal or leave a drop tied to a
  // corridor that was rejected.
  const plannedTracedLvac = new Map<string, Pt[]>();
  const attemptedTracedLvac = new Set<string>();
  const routeGenericContainers = (
    b: Block,
    list: PlacedEquipment[],
    lvacPathFor: (entry: { p: Pt; axis: 'x' | 'y' }, c: PlacedEquipment) => Pt[],
    deferLvac = false,
  ) => {
    const inv = b.inv;
    const same = (a: Pt, bb: Pt) => Math.abs(a.x - bb.x) < 0.05 && Math.abs(a.y - bb.y) < 0.05;
    const cs = Math.cos(inv.rotation), sn = Math.sin(inv.rotation);
    const halfL = inv.length / 2, halfW = inv.width / 2;
    // Local-frame DC end is always body-left (sheet-3). World 180°/270° yaw
    // is applied by toWorld — folding mirrorOf(inv.rotation) into m here
    // double-flips exits onto the local bottom-right.
    const m = 1;
    const toLocal = (p: Pt): Pt => {
      const dx = p.x - inv.x, dy = p.y - inv.y;
      return { x: dx * cs + dy * sn, y: -dx * sn + dy * cs };
    };
    const toWorld = (l: Pt): Pt => ({
      x: inv.x + l.x * cs - l.y * sn,
      y: inv.y + l.x * sn + l.y * cs,
    });
    // Legacy orientation-agnostic L (kept for containers drawn beside a PCS
    // END or too close to the face for the corridor lanes to fit).
    const legacyFan = (c: PlacedEquipment, i: number) => {
      const lane = i === 0 ? 0 : (i % 2 ? 1 : -1) * Math.ceil(i / 2) * 1.8;
      const pcsDc = facePoint(inv, c, lane);
      const boxDc = facePoint(c, inv, -0.6);
      let pcsNeg = facePoint(inv, c, lane - 0.6);
      if (same(pcsNeg.p, pcsDc.p)) pcsNeg = facePoint(inv, c, lane + 0.6);
      let boxNeg = facePoint(c, inv, 0);
      if (same(boxNeg.p, boxDc.p)) boxNeg = facePoint(c, inv, 0.6);
      // Preserve the traced orthogonal fan as the canonical plan, then let the
      // same pair-level direct gate used by auto blocks collapse it only when
      // both face-aligned chords clear every keep-out.
      addDcPair(`dc-${c.id}`, ...dcPairPaths(
        b.n,
        lPath(pcsDc.p, boxDc.p, pcsDc.axis),
        lPath(pcsNeg.p, boxNeg.p, pcsNeg.axis),
        true,
        [inv.id, c.id],
      ));
      let boxLv = facePoint(c, inv, 0.6);
      if (same(boxLv.p, boxNeg.p)) boxLv = facePoint(c, inv, 1.2);
      const id = `lvac-${c.id}`;
      const pts = lvacPathFor(boxLv, c);
      if (deferLvac) plannedTracedLvac.set(id, pts);
      else addRun(id, 'LVAC', pts);
    };
    // Local-frame descriptors, sorted along the face so exit/entry orders
    // match and the fan stays crossing-free.
    const items = list.map(c => {
      const cl = toLocal(c);
      // Container rotation in the PCS frame: sin(θc − θ) decides the swap.
      const relSn = Math.sin(c.rotation) * cs - Math.cos(c.rotation) * sn;
      const cRot = Math.abs(relSn) > 0.5;
      return {
        c, cl,
        hx: (cRot ? c.width : c.length) / 2,
        hy: (cRot ? c.length : c.width) / 2,
        side: (cl.y >= 0 ? 1 : -1) as 1 | -1,
      };
    }).sort((a, b2) => a.cl.x - b2.cl.x || a.c.id.localeCompare(b2.c.id));
    // Standard normalized QTY3 groups use the same issued-plan topology as
    // auto islands. Work in the PCS frame so 90°/180° rotations and mirrors
    // reverse terminal faces naturally instead of relying on world-axis signs.
    const pairItems = items.filter(it =>
      Math.abs(Math.sin(it.c.rotation - inv.rotation)) > 0.5);
    const a3Items = items.filter(it =>
      Math.abs(Math.sin(it.c.rotation - inv.rotation)) <= 0.5);
    const sameSide = items.length > 0 &&
      items.every(it => it.side === items[0].side);
    const standardQty3 =
      list.length >= 2 && list.length <= 3 && sameSide &&
      pairItems.length >= 2 && a3Items.length <= 1 &&
      items.every(it => Math.abs(it.cl.y) - it.hy >= halfW + 3);
    const issuedQty3 = new Map<string, { pos: Pt[]; neg: Pt[] }>();
    if (standardQty3) {
      // De-rotated clone MUST stay rotation 0 so planQty3Block's m stays
      // +1 (body-left). Passing the world yaw would apply mirrorOf twice
      // once here and again in toWorld.
      const localInv: PlacedEquipment = {
        ...inv, x: 0, y: 0, rotation: 0,
      };
      const originalById = new Map(list.map(c => [c.id, c]));
      const localContainers = items.map(it => ({
        ...it.c,
        x: it.cl.x,
        y: it.cl.y,
        rotation: it.c.rotation - inv.rotation,
      }));
      const plannedQty3 = planQty3Block(localInv, localContainers, 0);
      for (const route of plannedQty3.routes) {
        const original = originalById.get(route.c.id)!;
        issuedQty3.set(original.id, {
          pos: route.pos,
          neg: route.neg,
        });
      }
    }
    // Structured fan needs the container off a FACE with room for at least
    // the first corridor lane between the PCS face and the container face.
    const faced = items.filter(it => Math.abs(it.cl.y) - it.hy >= halfW + 3);
    const endSide = items.filter(it => !faced.includes(it));
    endSide.forEach((it, i) => legacyFan(it.c, i));
    // Local-frame obstacle rects of every OTHER equipment item. Traced yards
    // can pack container columns two deep off a PCS face; a straight outward
    // leg to the far column must thread the near column's gaps, never cut
    // through a container body (the auto lattice never needs this — its
    // geometry keeps every fan leg clear by construction).
    const localRects = equipment
      .filter(e => e.id !== inv.id)
      .map(e => {
        const ce = toLocal(e);
        const eSn = Math.sin(e.rotation) * cs - Math.cos(e.rotation) * sn;
        const eRot = Math.abs(eSn) > 0.5;
        const ehx = (eRot ? e.width : e.length) / 2 + 0.75;
        const ehy = (eRot ? e.length : e.width) / 2 + 0.75;
        return { id: e.id, x1: ce.x - ehx, y1: ce.y - ehy, x2: ce.x + ehx, y2: ce.y + ehy };
      });
    const segClearLocal = (a: Pt, b2: Pt, allowId: string): boolean => {
      const steps = Math.max(1, Math.ceil(Math.hypot(b2.x - a.x, b2.y - a.y)));
      const x0 = Math.min(a.x, b2.x), x1 = Math.max(a.x, b2.x);
      const y0 = Math.min(a.y, b2.y), y1 = Math.max(a.y, b2.y);
      for (const r of localRects) {
        if (r.id === allowId) continue;
        if (r.x2 < x0 || r.x1 > x1 || r.y2 < y0 || r.y1 > y1) continue;
        for (let s = 0; s <= steps; s++) {
          const px = a.x + (b2.x - a.x) * s / steps, py = a.y + (b2.y - a.y) * s / steps;
          if (px > r.x1 && px < r.x2 && py > r.y1 && py < r.y2) return false;
        }
      }
      return true;
    };
    for (const side of [1, -1] as const) {
      const group = faced.filter(it => it.side === side);
      if (!group.length) continue;
      const faceY = side * halfW;
      // Entries: the container's PCS-facing face, at the compartment corner
      // on the DC-compartment-end side (sheet-3 corner convention).
      const planned = group.map(it => ({
        it,
        enX: it.cl.x - m * Math.max(it.hx - 1.0, 0),
        enY: it.cl.y - side * it.hy,
      })).sort((a, b2) => a.enX - b2.enX || a.it.c.id.localeCompare(b2.it.c.id));
      // Exits staggered along the face from the DC-compartment end at the
      // 1.1 ft pitch, then matched order-preserving to the sorted entries.
      const exXs = planned
        .map((_, i) => clampf(-m * (halfL - 1.5 - i * 1.1), -(halfL - 1), halfL - 1))
        .sort((a, b2) => a - b2);
      // Nested corridors: the longest horizontal reach rides the innermost
      // lane (same convention as the mirrored-pair fan).
      const laneOrder = planned
        .map((_, i) => i)
        .sort((a, b2) =>
          Math.abs(planned[b2].enX - exXs[b2]) - Math.abs(planned[a].enX - exXs[a]) ||
          planned[a].it.c.id.localeCompare(planned[b2].it.c.id));
      const laneOf = new Map<number, number>();
      laneOrder.forEach((gi, k) => laneOf.set(gi, k));
      // The nearest equipment face on this side caps corridor nesting depth —
      // a lane landing inside the near container column would cross pads.
      let innerFace = Infinity;
      for (const r of localRects) {
        const cy = (r.y1 + r.y2) / 2;
        if (Math.sign(cy) !== side || Math.abs(cy) <= halfW + 0.5) continue;
        innerFace = Math.min(innerFace, side > 0 ? r.y1 : -r.y2);
      }
      const laneCap = Number.isFinite(innerFace)
        ? Math.max(halfW + 1.2, innerFace - 1.5) : Infinity;
      const laneCapN = Number.isFinite(innerFace)
        ? Math.max(halfW + 1.2, innerFace - 0.4) : Infinity;
      planned.forEach((p, i) => {
        const k = laneOf.get(i)!;
        const exX = exXs[i], enX = p.enX, enY = p.enY;
        const corY = side * Math.min(halfW + 1.5 + k * 2.2, laneCap);
        let pos: Pt[] = [
          { x: exX, y: faceY },
          { x: exX, y: corY },
          { x: enX, y: corY },
          { x: enX, y: enY },
        ];
        // (−) conductor: adjacent compartment position (+0.55 along the
        // stagger), own corridor one 1.1 ft pitch further out, lands 0.6 ft
        // inboard of (+) on the container face.
        const exXN = exX + m * 0.55, enXN = enX + m * 0.6;
        const corYN = side * Math.min(Math.abs(corY) + 1.1, laneCapN);
        let neg: Pt[] = [
          { x: exXN, y: faceY },
          { x: exXN, y: corYN },
          { x: enXN, y: corYN },
          { x: enXN, y: enY },
        ];
        // Two-deep container columns: if any leg of the planned pair cuts
        // through another body, thread the run through a near-column gap —
        // corridor to a clear riser, out into the inter-column aisle, then
        // back along the far face to the compartment corner.
        let lvGap: Pt | null = null;
        const plannedClear =
          segClearLocal(pos[0], pos[1], p.it.c.id) &&
          segClearLocal(pos[1], pos[2], p.it.c.id) &&
          segClearLocal(pos[2], pos[3], p.it.c.id) &&
          segClearLocal(neg[0], neg[1], p.it.c.id) &&
          segClearLocal(neg[1], neg[2], p.it.c.id) &&
          segClearLocal(neg[2], neg[3], p.it.c.id);
        if (!plannedClear) {
          const riserOk =
            segClearLocal(pos[0], pos[1], p.it.c.id) &&
            segClearLocal(neg[0], neg[1], p.it.c.id);
          if (riserOk) {
            const aisleY = enY - side * 1.0, aisleYN = enY - side * 1.6;
            let chosen: number | null = null;
            for (let step = 0; step <= 80 && chosen === null; step++) {
              for (const dir of (step === 0 ? [0] : [1, -1]) as number[]) {
                const rx = enX - m * dir * step * 0.5;
                const rxN = rx + m * 0.6;
                if (!segClearLocal({ x: exX, y: corY }, { x: rx, y: corY }, p.it.c.id)) continue;
                if (!segClearLocal({ x: exXN, y: corYN }, { x: rxN, y: corYN }, p.it.c.id)) continue;
                if (!segClearLocal({ x: rx, y: corY }, { x: rx, y: aisleY }, p.it.c.id)) continue;
                if (!segClearLocal({ x: rxN, y: corYN }, { x: rxN, y: aisleYN }, p.it.c.id)) continue;
                chosen = rx;
                break;
              }
            }
            if (chosen !== null) {
              const rx = chosen, rxN = rx + m * 0.6;
              pos = [pos[0], { x: exX, y: corY }, { x: rx, y: corY },
                { x: rx, y: aisleY }, { x: enX, y: aisleY }, pos[3]];
              neg = [neg[0], { x: exXN, y: corYN }, { x: rxN, y: corYN },
                { x: rxN, y: aisleYN }, { x: enXN, y: aisleYN }, neg[3]];
              lvGap = { x: rx + m * 1.2, y: enY };
            }
          }
        }
        const issued = issuedQty3.get(p.it.c.id);
        const clearIssued = issued &&
          issued.pos.slice(0, -1).every((a, j) =>
            segClearLocal(a, issued.pos[j + 1], p.it.c.id)) &&
          issued.neg.slice(0, -1).every((a, j) =>
            segClearLocal(a, issued.neg[j + 1], p.it.c.id));
        const plannedPair = clearIssued
          ? [issued.pos.map(toWorld), issued.neg.map(toWorld)] as const
          : [pos.map(toWorld), neg.map(toWorld)] as const;
        // Drawing tracing changes ownership discovery, not the routing-mode
        // contract. Keep this canonical QTY3 plan for orthogonal mode and
        // apply direct mode only through the shared pair-level safety gate.
        addDcPair(`dc-${p.it.c.id}`,
          ...dcPairPaths(
            b.n, plannedPair[0], plannedPair[1], true, [inv.id, p.it.c.id]));
        // 480V feed lands at the same compartment corner, one lane further
        // out — through the same near-column gap when the run threaded one —
        // then follows the corridor/aux tie-in the caller supplies, so the
        // AC trench leaves the container WITH the DC pair instead of from an
        // unrelated face point.
        const lvEntry = toWorld({ x: enX + m * 1.2, y: enY });
        const id = `lvac-${p.it.c.id}`;
        if (lvGap) {
          const tie = lvacPathFor({ p: toWorld(lvGap), axis: 'y' }, p.it.c);
          const pts = [...tie, lvEntry];
          if (deferLvac) plannedTracedLvac.set(id, pts);
          else addRun(id, 'LVAC', pts);
        } else {
          const pts = lvacPathFor({ p: lvEntry, axis: 'y' }, p.it.c);
          if (deferLvac) plannedTracedLvac.set(id, pts);
          else addRun(id, 'LVAC', pts);
        }
      });
    }
  };

  // ---- DC + LVAC service per sheet 3 ---------------------------------------
  // Every container lands both cables at its cable-compartment corner: the
  // corner of the front (door) end wall on the E-panel side (EPNL-1200A =
  // left / EPNL-1200C = right). Back row fronts face the PCS (north); front
  // row fronts face south, away from the PCS.
  //   DC (green): exits the PCS from its container-facing face as a nested
  //   parallel bundle, one cable peeling off to each compartment corner.
  //   LVAC (dark blue): originates at the ROW LVAC BUS (fed from the 480V aux
  //   trench), drops down the block's side past the PCS, then descends the
  //   container gaps and hooks into each compartment corner. LVAC container
  //   feeds never touch the inverter.
  // `lvacBusDrops` records each drop's tie-in x so the row buses are extended
  // to cover them.
  // inverter id -> drop tie-ins; `side` marks which side of the PCS row the
  // container sits on so traced yards (containers on BOTH sides of a row)
  // tie each feed into a corridor it can reach without crossing the PCS.
  const lvacBusDrops = new Map<string, { x: number; side: 1 | -1 }[]>();
  // Traced yards arrange the drawn PCS/container groups in world-Y columns
  // even when the PCS symbol itself is horizontal. Their 480V corridors run
  // ALONG those columns (world x = const), never across the equipment rows.
  const vertLvacDrops: { x: number; y: number; side: 1 | -1; invId: string; cableId: string }[] = [];
  // Traced clusters whose containers run BESIDE their PCS in world-X get a
  // horizontal row corridor instead (R-TR-1 edge lanes follow the cluster
  // axis); registered here and emitted as `lvac-bus-h<n>` lanes below.
  const horzLvacDrops: { x: number; y: number; side: 1 | -1; invId: string; cableId: string }[] = [];
  // Block mirror sign, derived from the PCS placement rotation: +1 = sheet-3
  // orientation (DC compartment at the LEFT end of the PCS container-facing
  // face, MV transformer / aux transformer at the RIGHT end); a block flipped
  // 180 deg mirrors all fixed PCS connection points to the opposite ends.
  const mirrorOf = (e: PlacedEquipment): 1 | -1 =>
    Math.cos(e.rotation) >= 0 ? 1 : -1;

  // ---- mirrored-pair (island) DC + 480V aux service --------------------------
  // Puma reference: DC runs are straight orthogonal segments from the PCS to
  // each of its three containers; 480V aux drops leave each container toward
  // the island's central 10 ft aux corridor, where a collector run picks them
  // up. The sheet-3 per-row LVAC buses are not drawn in this mode.
  const mirroredMode = !!(islands && islands.length);
  // ---- rotated drag-placed islands -----------------------------------------
  // A placed island at any non-zero angle is routed in its LOCAL horizontal
  // frame on de-rotated equipment clones, then maps the emitted points back to
  // world via a 2-D CCW rotation about the anchor (cx, cy):
  //   world = W(local) = { x: cx + lx·cosθ - ly·sinθ, y: cy + lx·sinθ + ly·cosθ }
  //   local = W⁻¹(eq)  = { x: (wx-cx)·cosθ + (wy-cy)·sinθ,  y: -(wx-cx)·sinθ + (wy-cy)·cosθ }
  // At θ=90° this reduces to the old vertical formula: world=(cx-ly, cy+lx).
  // Blocks resolve their island by MEMBERSHIP (inverterIds), never
  // nearest-corridor distance — horizontal islands keep the historical
  // nearest-y assignment byte-identically.
  const islAngleRad = (isl: IslandInfo): number => {
    if (isl.angleDeg != null) return (((isl.angleDeg % 360) + 360) % 360) * Math.PI / 180;
    if (isl.vertical) return Math.PI / 2;
    return 0;
  };
  const rotatedIslands = mirroredMode ? islands!.filter(i => islAngleRad(i) !== 0) : [];
  const horizIslands   = mirroredMode ? islands!.filter(i => islAngleRad(i) === 0) : [];
  const rotIslandOfInv = new Map<string, IslandInfo>();
  for (const isl of rotatedIslands) for (const id of isl.inverterIds) rotIslandOfInv.set(id, isl);

  // ---- rows of inverters ----------------------------------------------------
  // Computed BEFORE the block loops so traced container feeds can tie into
  // their row's aux corridor at its exact emitted height.
  const rowMap = new Map<number, PlacedEquipment[]>();
  for (const inv of inverters) {
    // Rotated placed-island inverters get their buses/drops from the
    // dedicated local-frame pass below — grouping them into y-rows would
    // fabricate one junk row per PCS.
    if (rotIslandOfInv.has(inv.id)) continue;
    // Cluster on the RAW y with a 6 ft band: traced yards carry stepped
    // rows (the drawing steps a row's elevation mid-run), and the old
    // round-then-2 ft test split one stepped row whenever the step
    // straddled a rounding boundary (round(937.3)=937 vs round(938.6)=939
    // fails |939-937|<2). Auto rows share one exact y, so their grouping
    // is unchanged.
    const near = Array.from(rowMap.keys()).find(k => Math.abs(k - inv.y) < 6);
    if (near !== undefined) rowMap.get(near)!.push(inv);
    else rowMap.set(inv.y, [inv]);
  }
  const invRows = Array.from(rowMap.values()).sort(
    (a, b2) => a[0].y - b2[0].y
  );
  const rowOfInv = new Map<string, PlacedEquipment[]>();
  for (const row of invRows) for (const inv of row) rowOfInv.set(inv.id, row);
  // Row aux-corridor height on a given side of the row — the NextEra row-bus
  // offset, mirrored for south-side containers in traced yards.
  const rowCorridorY = (inv: PlacedEquipment, side: 1 | -1): number => {
    const row = rowOfInv.get(inv.id);
    const ry = row ? row[0].y : inv.y;
    const rw2 = row ? row[0].width : inv.width;
    return ry + side * (rw2 / 2 + LVAC_BUS_OFF);
  };
  const islToWorld = (isl: IslandInfo, p: Pt): Pt => {
    const θ = islAngleRad(isl);
    const c = Math.cos(θ), s = Math.sin(θ);
    return { x: isl.cx! + p.x * c - p.y * s, y: isl.cy! + p.x * s + p.y * c };
  };
  const islToLocalEq = (isl: IslandInfo, e: PlacedEquipment): PlacedEquipment => {
    const θ = islAngleRad(isl);
    const c = Math.cos(θ), s = Math.sin(θ);
    const dx = e.x - isl.cx!, dy = e.y - isl.cy!;
    return { ...e, x: dx * c + dy * s, y: -dx * s + dy * c, rotation: e.rotation - θ };
  };
  // island corridor y -> aux drop tie-in xs (for collector extents, horizontal islands)
  const islandDrops = new Map<number, number[]>();
  // rotated island n -> LOCAL drop tie-in xs
  const rotDrops = new Map<number, number[]>();
  if (mirroredMode) {
    // Guard: a yard whose islands are ALL rotated has no horizontal island to
    // reduce over — fall back to the nearest island by center so routing keeps
    // working instead of throwing "Reduce of empty array with no initial value".
    const nearestIsland = (y: number): IslandInfo =>
      (horizIslands.length ? horizIslands : islands!)
        .reduce((best, i) => Math.abs(i.y - y) < Math.abs(best.y - y) ? i : best);
    // Shared island-block DC + 480V body (local or world frame — the frame is
    // whatever `inv`/`containers` are expressed in; emitters map if needed).
    const routePairBlock = (
      inv: PlacedEquipment,
      containers: PlacedEquipment[],
      corridorY: number,
      emitDc: (id: string, posPts: Pt[], negPts: Pt[]) => void,
      emitLvac: (id: string, pts: Pt[]) => void
    ): number[] => {
      const m = mirrorOf(inv);
      const midY = containers.reduce((s, c) => s + c.y, 0) / Math.max(containers.length, 1);
      const sgn = Math.sign(midY - inv.y) || 1;   // PCS -> containers direction
      const invFace = inv.y + sgn * (inv.width / 2);
      const drops: number[] = [];
      // Plan every container's DC entry point first, then assign PCS
      // compartment exits IN THE SAME X ORDER as the entries (reference
      // drawing: first cable peels right, then the second, then the last)
      // and give each run its own nested jog corridor inside the PCS
      // clearance strip. Matched monotone ordering + distinct corridors
      // means the three runs fan out without ever crossing each other.
      const plans = containers.map(c => {
        const rot = Math.abs(Math.sin(c.rotation)) > 0.5;
        if (rot) {
          // A-1 / A-2: long axis along y, cable-entry corner at the PCS end
          // on the E-panel (inner gap) side.
          const s2 = c.epanel === 'left' ? -1 : 1;       // E-panel (inner gap) side
          return {
            c, rot, s2,
            destX: c.x + s2 * (LG_JF2.width / 2 - 1.0),
            destY: c.y - sgn * (LG_JF2.length / 2),
          };
        }
        // A-3: perpendicular at the corridor edge, cable-entry corner at
        // the LANE end on the corridor side. The pair bias leaves an open
        // cable lane beside the pair (south block: pair flush west => lane
        // east; north block mirrored => lane west), so the DC run stays
        // orthogonal and NEVER trenches under the A-1/A-2 pair.
        const endSgn = c.epanel === 'left' ? -1 : 1;     // lane end: +x or -x
        const endX = c.x + endSgn * (LG_JF2.length / 2);
        return {
          c, rot, s2: endSgn,
          destX: endX - endSgn * 1.0,
          destY: c.y + sgn * (LG_JF2.width / 2 - 1.0),
        };
      });
      // The perpendicular A-3 container lies ACROSS the top of the pair, so a
      // 480V riser that climbs the pair's outer side to the corridor can pass
      // straight under it (the A-3 overhangs the pair on the lane side). Push
      // any such riser into the open lane just beyond the A-3 end instead —
      // a cable is never trenched under a container.
      const crossers = plans.filter(p => !p.rot).map(p => ({
        minX: p.c.x - LG_JF2.length / 2,
        maxX: p.c.x + LG_JF2.length / 2,
      }));
      const clearRiserX = (x: number): number => {
        for (const cr of crossers) {
          if (x > cr.minX - 0.3 && x < cr.maxX + 0.3) {
            const west = cr.minX - 1.2;
            const east = cr.maxX + 1.2;
            return Math.abs(x - west) <= Math.abs(x - east) ? west : east;
          }
        }
        return x;
      };
      // Compartment exits (mirror-aware stagger at the left end of the
      // container-facing face), sorted left-to-right and matched to the
      // entries sorted left-to-right — cables leave in destination order.
      const exitXs = plans
        .map((_, i) => inv.x - m * (inv.length / 2 - 1.5 - i * 1.1))
        .sort((a, b2) => a - b2);
      const ordered = [...plans].sort((a, b2) => a.destX - b2.destX);
      // Longest horizontal reach hugs the PCS (innermost corridor) so the
      // shorter fans below it never intersect its span.
      const byReach = ordered
        .map((p, idx) => ({ idx, reach: Math.abs(p.destX - exitXs[idx]) }))
        .sort((a, b2) => b2.reach - a.reach);
      const corridorOf: number[] = new Array(ordered.length);
      byReach.forEach((r, k) => { corridorOf[r.idx] = k; });
      ordered.forEach((p, idx) => {
        // Per-polarity geometry (reference detail B006-1): red (+) fans on
        // the near corridor straight to the entry terminal; blue (−) departs
        // the adjacent compartment position, rides its own corridor one full
        // 1.1 ft pitch further out and lands 0.6 ft inboard on the face. The
        // per-run corridor pitch doubles to 2.2 ft so red/blue lanes
        // interleave with the base 1.1 ft between every adjacent trench.
        const buildDc = (exitX: number, corY: number, destX: number, destY: number): Pt[] =>
          Math.abs(exitX - destX) < 0.05
            ? [{ x: exitX, y: invFace }, { x: destX, y: destY }]
            : [
                { x: exitX, y: invFace },
                { x: exitX, y: corY },
                { x: destX, y: corY },
                { x: destX, y: destY },
              ];
        const exitX = exitXs[idx];
        const corYPos = invFace + sgn * (1.5 + corridorOf[idx] * 2.2);
        const corYNeg = corYPos + sgn * 1.1;
        const negDestX = p.destX - p.s2 * 0.6;
        emitDc(p.c.id,
          buildDc(exitX, corYPos, p.destX, p.destY),
          buildDc(exitX + m * 0.55, corYNeg, negDestX, p.destY));
        if (p.rot) {
          // 480V aux lands at the SAME entry box as the DC: wrap around the
          // container's outer side (A-3 blocks the tight inner gap), hook in
          // across the PCS-clearance strip, then run to the corridor.
          const ox = clearRiserX(p.c.x - p.s2 * (LG_JF2.width / 2 + 1.2));
          const hookY = p.destY - sgn * 1.5;
          emitLvac(p.c.id, [
            { x: p.destX, y: p.destY },
            { x: p.destX, y: hookY },
            { x: ox, y: hookY },
            { x: ox, y: corridorY },
          ]);
          drops.push(ox);
        } else {
          // A-3 aux rises straight from the corridor into the same entry corner.
          emitLvac(p.c.id, [
            { x: p.destX, y: p.destY },
            { x: p.destX, y: corridorY },
          ]);
          drops.push(p.destX);
        }
      });
      return drops;
    };
    for (const b of blocks) {
      // Hand-placed/traced containers associated with this block: generic
      // fan for DC, 480V feed dropped from the island aux corridor collector
      // (registered in islandDrops so the collector extends to cover it).
      const orphans = blockOrphans.get(b.n);
      if (orphans) {
        routeGenericContainers(b, orphans, (entry, c) => {
          // Traced aux gear in the yard feeds traced containers directly;
          // fall back to the island corridor collector when none is present.
          if (tracedAuxSources.length) {
            const src = tracedAuxSources.reduce((best, e) =>
              Math.hypot(e.x - c.x, e.y - c.y) < Math.hypot(best.x - c.x, best.y - c.y) ? e : best);
            const dst = facePoint(src, entry.p, 0);
            return lPath(dst.p, entry.p, dst.axis);
          }
          const isl = nearestIsland(c.y);
          islandDrops.set(isl.y, [...(islandDrops.get(isl.y) ?? []), entry.p.x]);
          return [{ x: entry.p.x, y: isl.y }, entry.p];
        });
        if (!b.containers.length) continue;
      }
      const rIsl = rotIslandOfInv.get(b.inv.id);
      if (rIsl) {
        // Rotated placed island: route in the island's local frame on
        // de-rotated clones, map every emitted point back to world.
        const mapPts = (pts: Pt[]) => pts.map(p => islToWorld(rIsl, p));
        const drops = routePairBlock(
          islToLocalEq(rIsl, b.inv),
          b.containers.map(c => islToLocalEq(rIsl, c)),
          0,
          (id, pos, neg) => addDcPair(`dc-${id}`,
            ...dcPairPaths(b.n, mapPts(pos), mapPts(neg), true)),
          (id, pts) => addRun(`lvac-${id}`, 'LVAC', mapPts(pts))
        );
        rotDrops.set(rIsl.n, [...(rotDrops.get(rIsl.n) ?? []), ...drops]);
        continue;
      }
      const midY = b.containers.reduce((s, c) => s + c.y, 0) / Math.max(b.containers.length, 1);
      const isl = nearestIsland(midY);
      const drops = routePairBlock(
        b.inv, b.containers, isl.y,
        (id, pos, neg) => addDcPair(`dc-${id}`,
          ...dcPairPaths(b.n, pos, neg, true)),
        (id, pts) => addRun(`lvac-${id}`, 'LVAC', pts)
      );
      islandDrops.set(isl.y, [...(islandDrops.get(isl.y) ?? []), ...drops]);
    }
  }
  if (!mirroredMode) for (const b of blocks) {
    const inv = b.inv;
    const invBottom = inv.y - inv.width / 2;
    const invLeft = inv.x - inv.length / 2;
    const busY = inv.y + inv.width / 2 + LVAC_BUS_OFF; // row LVAC bus height
    const count = b.containers.length;
    const midY = b.containers.reduce((s, c) => s + c.y, 0) / Math.max(count, 1);
    const backTopY = Math.max(...b.containers.map(c => c.y + LG_JF2.length / 2));
    const dropXs: { x: number; side: 1 | -1 }[] = [];
    b.containers.forEach((c, i) => {
      // Nested DC corridors: red (+) lanes at a doubled 2.2 ft pitch, blue
      // (−) one base 1.1 ft pitch beyond its red — every adjacent trench
      // line across the fan keeps the base spacing (reference B006-1).
      const corridorY = invBottom - 1.5 - i * 2.2;
      const corridorYNeg = corridorY - 1.1;
      const lvacCorY = backTopY + 1.4 + i * 0.5;     // LVAC corridors nearer the containers
      // Single DC cable compartment per sheet 3: all DC runs exit the PCS
      // through one compartment offset toward the left end of the
      // container-facing face (mirrored when the block is flipped); small
      // in-compartment stagger keeps the bundled exits distinguishable.
      const tx = inv.x - mirrorOf(inv) * (inv.length / 2 - 1.5 - i * 1.1);
      // containers rotated 90 deg: plan half-width along x = LG_JF2.width/2,
      // half-length along y = LG_JF2.length/2
      const s2 = c.epanel === 'left' ? -1 : 1;       // E-panel / compartment side
      // Back row = larger y; a single container sits in the front row (its
      // door/compartment end faces south, away from the PCS).
      const isBack = count > 1 && c.y > midY + 0.1;
      const endY = isBack ? c.y + LG_JF2.length / 2 : c.y - LG_JF2.length / 2;
      const dcX = c.x + s2 * (LG_JF2.width / 2 - 1.0);   // compartment corner box:
      const lvX = c.x + s2 * (LG_JF2.width / 2 - 2.2);   // DC + LVAC land side by side
      const dropX = invLeft - 2 - i * 1.2;           // bus drop, clear of the PCS
      dropXs.push({ x: dropX, side: 1 });            // sheet-3 containers sit north of the row bus
      const txNeg = tx + mirrorOf(inv) * 0.55;       // blue departs the adjacent position
      const dcXNeg = dcX - s2 * 0.6;                 // blue lands 0.6 ft inboard of red
      if (isBack) {
        // back row: compartment end faces the PCS — direct fan from the bundle
        addDcPair(`dc-${c.id}`, ...dcPairPaths(b.n, [
          { x: tx, y: invBottom },
          { x: tx, y: corridorY },
          { x: dcX, y: corridorY },
          { x: dcX, y: endY },
        ], [
          { x: txNeg, y: invBottom },
          { x: txNeg, y: corridorYNeg },
          { x: dcXNeg, y: corridorYNeg },
          { x: dcXNeg, y: endY },
        ], true));
        addRun(`lvac-${c.id}`, 'LVAC', [
          { x: dropX, y: busY },
          { x: dropX, y: lvacCorY },
          { x: lvX, y: lvacCorY },
          { x: lvX, y: endY },
        ]);
      } else {
        // front row: compartment end faces south — wrap around the outside of
        // the column (DC) / descend the E-panel gap (LVAC) and hook in from
        // below the end wall
        const riserX = c.x - s2 * (LG_JF2.width / 2 + 1.2); // outer column side
        const riserXNeg = riserX - s2 * 1.2;                // blue wraps one lane wider
        const gapX = c.x + s2 * (LG_JF2.width / 2 + 0.8);   // E-panel gap side
        addDcPair(`dc-${c.id}`, ...dcPairPaths(b.n, [
          { x: tx, y: invBottom },
          { x: tx, y: corridorY },
          { x: riserX, y: corridorY },
          { x: riserX, y: endY - 2.0 },
          { x: dcX, y: endY - 2.0 },
          { x: dcX, y: endY },
        ], [
          { x: txNeg, y: invBottom },
          { x: txNeg, y: corridorYNeg },
          { x: riserXNeg, y: corridorYNeg },
          { x: riserXNeg, y: endY - 2.6 },
          { x: dcXNeg, y: endY - 2.6 },
          { x: dcXNeg, y: endY },
        ], true));
        addRun(`lvac-${c.id}`, 'LVAC', [
          { x: dropX, y: busY },
          { x: dropX, y: lvacCorY },
          { x: gapX, y: lvacCorY },
          { x: gapX, y: endY - 1.0 },
          { x: lvX, y: endY - 1.0 },
          { x: lvX, y: endY },
        ]);
      }
    });
    // Hand-placed/traced containers associated with this block: generic fan
    // for DC, 480V feed sourced from the nearest traced aux transformer/switch
    // panel when one exists in the yard — the one-line then reflects the actual
    // aux topology. Without such gear the feed drops from this block's ROW LVAC
    // BUS (tie-in x registered so the bus extends to cover it), matching the
    // sheet-3 drops with orientation-agnostic geometry.
    const orphans = blockOrphans.get(b.n);
    if (orphans) {
      // Physical corridor orientation follows the PCS body long axis, not a
      // sum of container world offsets.  This makes rotation-180 Area 2 rows
      // horizontal and rotation-90 Areas 1/3/4 columns vertical.
      const horizontalCluster = Math.abs(Math.cos(inv.rotation)) > 0.5;
      // Resolve both the clear side and bank extent in the PCS local frame.
      // The former world-Y-only calculation worked at 0° but a quarter-turn
      // used only the PCS half-width and put lvac-bus-v1 through the rotated
      // container bank.  Projecting each oriented body onto the PCS local
      // normal makes the same construction invariant at 0/90/180/270°.
      const normal = { x: -Math.sin(inv.rotation), y: Math.cos(inv.rotation) };
      const laneOff: { [s in 1 | -1]: number } =
        { 1: inv.width / 2, [-1]: inv.width / 2 };
      for (const c2 of orphans) {
        const dx = c2.x - inv.x, dy = c2.y - inv.y;
        const across = dx * normal.x + dy * normal.y;
        const cu = { x: Math.cos(c2.rotation), y: Math.sin(c2.rotation) };
        const cv = { x: -cu.y, y: cu.x };
        const halfProjection =
          Math.abs(cu.x * normal.x + cu.y * normal.y) * c2.length / 2 +
          Math.abs(cv.x * normal.x + cv.y * normal.y) * c2.width / 2;
        const side: 1 | -1 = across >= 0 ? 1 : -1;
        laneOff[side] = Math.max(laneOff[side], Math.abs(across) + halfProjection);
      }
      routeGenericContainers(b, orphans, (entry, c) => {
        // Every traced container group lands on a row/column corridor first.
        // A traced aux source is tied into that corridor by the shared spine;
        // it must never draw one direct source→container L through the yard.
        // Auto containers never enter blockOrphans, so their historical row
        // buses remain byte-identical.
        const across =
          (c.x - inv.x) * normal.x + (c.y - inv.y) * normal.y;
        const localSide: 1 | -1 = across >= 0 ? 1 : -1;
        const corridorPoint = {
          x: inv.x + normal.x * localSide * (laneOff[localSide] + LVAC_BUS_OFF),
          y: inv.y + normal.y * localSide * (laneOff[localSide] + LVAC_BUS_OFF),
        };
        if (horizontalCluster) {
          // Cluster runs BESIDE its PCS in world-X: the edge lane follows the
          // cluster axis (R-TR-1), horizontal past the side's cluster extent.
          const sy: 1 | -1 = corridorPoint.y >= inv.y ? 1 : -1;
          const corY = corridorPoint.y;
          horzLvacDrops.push({
            x: entry.p.x, y: corY, side: sy, invId: inv.id, cableId: `lvac-${c.id}`,
          });
          return [{ x: entry.p.x, y: corY }, entry.p];
        }
        const sx: 1 | -1 = corridorPoint.x >= inv.x ? 1 : -1;
        const corX = corridorPoint.x;
        vertLvacDrops.push({
          x: corX, y: entry.p.y, side: sx, invId: inv.id, cableId: `lvac-${c.id}`,
        });
        return [{ x: corX, y: entry.p.y }, entry.p];
      }, true);
    }
    lvacBusDrops.set(inv.id, dropXs);
  }

  // ---- rotated placed-island collectors, buses and drops --------------------
  // Everything a horizontal island gets (480V collector + tap, corridor
  // trench, per-side MV/fiber buses and drops), computed in the island's
  // local frame and mapped to world. Corridor trench entries carry angleDeg
  // (and backward-compat vertical=true at exactly 90°) with approximate
  // world-AABB extents for legacy consumers.
  const routeRotatedIslandExtras = () => {
    for (const isl of rotatedIslands) {
      const θ = islAngleRad(isl);
      const drops = rotDrops.get(isl.n);
      if (drops && drops.length) {
        const ownXfmr = equipment.find(e => e.id === `island-aux-xfmr-${isl.n}`);
        const xfmrLx = ownXfmr ? islToLocalEq(isl, ownXfmr).x : null;
        const xs = xfmrLx !== null ? [...drops, xfmrLx] : drops;
        addRun(`lvac-corridor-${isl.n}`, 'LVAC', [
          islToWorld(isl, { x: Math.min(...xs), y: 0 }),
          islToWorld(isl, { x: Math.max(...xs), y: 0 }),
        ]);
        if (ownXfmr && xfmrLx !== null) {
          const l = islToLocalEq(isl, ownXfmr);
          const rot = Math.abs(Math.sin(l.rotation)) > 0.5;
          const hy = (rot ? l.length : l.width) / 2;
          const edgeY = l.y > 0 ? l.y - hy : l.y + hy;
          addRun(`lvac-corridor-${isl.n}-tap`, 'LVAC', [
            islToWorld(isl, { x: xfmrLx, y: 0 }),
            islToWorld(isl, { x: xfmrLx, y: edgeY }),
          ]);
        } else if (isl.auxGear === false) {
          // Deliberate core-only placement: the engineer opted out of the
          // island aux cluster, so this is a design choice to report, not a
          // defect to flag.
          warnings.push(`Placed island ${isl.n} was placed as core equipment only — its 480V aux collector has no island transformer to feed it; add one or route it to another aux source.`);
        } else {
          warnings.push(`Placed island ${isl.n} has no mid-island aux transformer — connect its 480V aux collector to an aux source manually.`);
        }
        // Fiber daisy chain through the island's FJB(s): corridor run/taps
        // through the local frame like the LVAC.
        const fjbsV = equipment.filter(e =>
          e.kind === 'feederJunctionBox' && new RegExp(`^fjb-${isl.n}(?:-\\d+)?$`).test(e.id));
        const fjbLxs = fjbsV.map(f => islToLocalEq(isl, f).x);
        const fiberXsV = [...xs, ...fjbLxs];
        const corridorW = islToWorld(isl, { x: Math.min(...fiberXsV), y: 0 });
        const corridorE = islToWorld(isl, { x: Math.max(...fiberXsV), y: 0 });
        addRun(`fiber-corridor-${isl.n}`, 'FIBER', [corridorW, corridorE]);
        fjbsV.forEach((f, fi) => {
          const l = islToLocalEq(isl, f);
          const rotF = Math.abs(Math.sin(l.rotation)) > 0.5;
          const hyF = (rotF ? l.length : l.width) / 2;
          const edgeYF = l.y > 0 ? l.y - hyF : l.y + hyF;
          addRun(`fiber-fjb-${f.id}`, 'FIBER', [
            islToWorld(isl, { x: fjbLxs[fi], y: 0 }),
            islToWorld(isl, { x: fjbLxs[fi], y: edgeYF }),
          ]);
        });
        // Corridor trench: compute world-AABB from the endpoints for legacy
        // consumers; carry cx/cy/angleDeg/length for angle-aware rendering/export.
        const allWorldPts = fiberXsV.map(x => islToWorld(isl, { x, y: 0 }));
        const wMinX = Math.min(...allWorldPts.map(p => p.x));
        const wMaxX = Math.max(...allWorldPts.map(p => p.x));
        const wMinY = Math.min(...allWorldPts.map(p => p.y));
        const wMaxY = Math.max(...allWorldPts.map(p => p.y));
        const isExact90 = Math.abs(Math.abs(θ % Math.PI) - Math.PI / 2) < 0.001;
        // Length = span in local X (the corridor strip direction).
        const corridorLength = Math.max(...fiberXsV) - Math.min(...fiberXsV);
        corridorTrenches.push({
          islandN: isl.n,
          // Legacy fields: y = world corridor center (X for vertical), minX/maxX along the band axis
          y: isExact90 ? isl.cx! : (wMinY + wMaxY) / 2,
          minX: isExact90 ? wMinY : wMinX, maxX: isExact90 ? wMaxY : wMaxX,
          width: CORRIDOR_TRENCH_WIDTH,
          section: 'AUX_FIBER',
          // Angle-aware fields for modern consumers
          cx: (corridorW.x + corridorE.x) / 2,
          cy: (corridorW.y + corridorE.y) / 2,
          angleDeg: isl.angleDeg ?? (isl.vertical ? 90 : 0),
          length: corridorLength,
          ...(isExact90 ? { vertical: true } : {}),
        });
      }
      // Per-side MV + fiber buses and drops (same offsets as the row pass).
      const sides: [string, string[]][] = [[`s`, isl.southIds], [`n`, isl.northIds]];
      for (const [tag, ids] of sides) {
        const row = ids
          .map(id => equipment.find(e => e.id === id))
          .filter((e): e is PlacedEquipment => !!e)
          .map(e => islToLocalEq(isl, e));
        if (!row.length) continue;
        const invTop = row[0].y + row[0].width / 2;
        const mvY = invTop + MV_BUS_OFF;
        const fiberY = invTop + FIBER_BUS_OFF;
        const mvXs = row.map(i => i.x + mirrorOf(i) * (i.length / 2 - 1.2));
        const fbXs = row.map(i => i.x + mirrorOf(i) * (i.length / 2 - 4.0));
        addRun(`mv-bus-p${isl.n}${tag}`, 'MV', [
          islToWorld(isl, { x: Math.min(...mvXs), y: mvY }),
          islToWorld(isl, { x: Math.max(...mvXs), y: mvY }),
        ]);
        addRun(`fiber-bus-p${isl.n}${tag}`, 'FIBER', [
          islToWorld(isl, { x: Math.min(...fbXs), y: fiberY }),
          islToWorld(isl, { x: Math.max(...fbXs), y: fiberY }),
        ]);
        for (const i of row) {
          const mvX = i.x + mirrorOf(i) * (i.length / 2 - 1.2);
          const fiberX = i.x + mirrorOf(i) * (i.length / 2 - 4.0);
          addRun(`mv-drop-${i.id}`, 'MV', [
            islToWorld(isl, { x: mvX, y: invTop }), islToWorld(isl, { x: mvX, y: mvY }),
          ]);
          addRun(`fiber-drop-${i.id}`, 'FIBER', [
            islToWorld(isl, { x: fiberX, y: invTop }), islToWorld(isl, { x: fiberX, y: fiberY }),
          ]);
        }
      }
    }
  };
  // Nothing but rotated placed islands: no horizontal rows exist, so the
  // yard-level spine/trench machinery has nothing to anchor to. Emit the
  // rotated island routing and stop — the trench band is omitted with a
  // warning instead of crashing on an empty row list.
  if (!invRows.length) {
    routeRotatedIslandExtras();
    warnings.push('Layout has only rotated placed islands — the 480V aux & fiber trench spine is omitted; review aux distribution in detailed design.');
    if (dcDirectBlocked > 0) {
      warnings.push(`${dcDirectBlocked} DC pair${dcDirectBlocked === 1 ? '' : 's'} kept 90° trench routing — a straight run would cross equipment, the fence, or an underground exclusion area.`);
    }
    return { cables, trench: null, corridorTrenches, warnings };
  }


  // ---- spine placement: gap between block columns --------------------------
  // Block footprint x-extent per block = its equipment plus its aug zone
  const blockExtent = (b: Block): { lo: number; hi: number } => {
    let lo = Infinity, hi = -Infinity;
    for (const e of [b.inv, ...b.containers]) {
      const rot = Math.abs(Math.sin(e.rotation)) > 0.5;
      const hx = (rot ? e.width : e.length) / 2;
      lo = Math.min(lo, e.x - hx);
      hi = Math.max(hi, e.x + hx);
    }
    const z = augmentationZones.find(z2 => z2.id === `aug-${b.n}`);
    if (z) { lo = Math.min(lo, z.x - z.length / 2); hi = Math.max(hi, z.x + z.length / 2); }
    return { lo, hi };
  };

  // Unique columns by center x
  const colMap = new Map<number, { lo: number; hi: number }>();
  for (const b of blocks) {
    const ext = blockExtent(b);
    const key = Math.round((ext.lo + ext.hi) / 2);
    const cur = colMap.get(key);
    if (cur) { cur.lo = Math.min(cur.lo, ext.lo); cur.hi = Math.max(cur.hi, ext.hi); }
    else colMap.set(key, { ...ext });
  }
  const cols = Array.from(colMap.values()).sort((a, b2) => a.lo - b2.lo);

  // Candidate spine x positions: every inter-column gap (middle gaps first,
  // matching the reference sheets), then positions just outside the outer
  // columns. A candidate is only usable when the whole vertical spine corridor
  // — every row's bus height — stays inside the fence, so concave parcels
  // (like Hondo's notched boundary) never put the spine in a notch.
  const rowBusYs = invRows.map(row => row[0].y + row[0].width / 2 + FIBER_BUS_OFF);
  const spineCorridorOk = (x: number) =>
    rowBusYs.every(y =>
      pointInPolygon({ x, y }, fence) && distanceToPolygonEdge({ x, y }, fence) >= 2
    );

  const gapCandidates: number[] = [];
  const order: number[] = [];
  for (let i = 0; i + 1 < cols.length; i++) order.push(i);
  order.sort((a, b2) =>
    Math.abs(a - (cols.length / 2 - 1)) - Math.abs(b2 - (cols.length / 2 - 1))
  );
  for (const i of order) {
    const gap = cols[i + 1].lo - cols[i].hi;
    if (gap > TRENCH_WIDTH - 2) gapCandidates.push((cols[i].hi + cols[i + 1].lo) / 2);
  }
  const outer = [
    cols[cols.length - 1].hi + 6, cols[cols.length - 1].hi + 3,
    cols[0].lo - 6, cols[0].lo - 3,
  ];

  // Pinned trench corridor: the drafter can lock the 480V aux + fiber trench
  // (LVAC spine) to a chosen x. Honor it only when the whole corridor passes
  // the same fence-clearance checks as automatic candidates AND stays clear of
  // the equipment columns (a pin through a block column would run the trench
  // straight through containers); otherwise warn and fall back to automatic
  // placement.
  const trenchHalf = TRENCH_WIDTH / 2;
  const clearOfColumns = (x: number) =>
    cols.every(c => x + trenchHalf <= c.lo + 1 || x - trenchHalf >= c.hi - 1);
  const clearOfVisibleEquipment = (x: number) => equipment.every(e => {
    const cs = Math.cos(e.rotation), sn = Math.sin(e.rotation);
    const halfX =
      Math.abs(cs) * e.length / 2 + Math.abs(sn) * e.width / 2;
    return x + trenchHalf + 0.5 <= e.x - halfX ||
      x - trenchHalf - 0.5 >= e.x + halfX;
  });
  const spineCandidateOk = (x: number) =>
    spineCorridorOk(x) && clearOfColumns(x) && clearOfVisibleEquipment(x);
  let pinnedSpineX: number | null = null;
  if (pinnedTrenchX !== undefined && pinnedTrenchX !== null) {
    if (spineCandidateOk(pinnedTrenchX)) {
      pinnedSpineX = pinnedTrenchX;
    } else if (!clearOfColumns(pinnedTrenchX)) {
      warnings.push(
        `Pinned trench corridor rejected: x = ${pinnedTrenchX.toFixed(1)} ft runs through an ` +
        'equipment column — using automatic trench placement.'
      );
    } else {
      warnings.push(
        `Pinned trench corridor rejected: x = ${pinnedTrenchX.toFixed(1)} ft does not keep the ` +
        'full spine corridor inside the fence with clearance — using automatic trench placement.'
      );
    }
  }

  let spineX: number | null =
    pinnedSpineX ??
    gapCandidates.find(spineCandidateOk) ??
    outer.find(spineCandidateOk) ??
    null;
  let spineEquipmentClear = spineX !== null;
  if (spineX === null) {
    const preferred = gapCandidates[0] ?? outer[0];
    for (let step = 1; step <= 400 && spineX === null; step++) {
      const d = step * 0.5;
      if (spineCandidateOk(preferred + d)) spineX = preferred + d;
      else if (spineCandidateOk(preferred - d)) spineX = preferred - d;
    }
  }
  if (spineX !== null) spineEquipmentClear = true;
  if (spineX === null) {
    spineEquipmentClear = false;
    warnings.push(
      'No full-width equipment-clear 480V/fiber spine exists inside the fence — shared auxiliary spine failed closed; resolve the yard corridor before issue.',
    );
    // Keep generating independent MV row collectors and feeder drops.  A
    // missing auxiliary spine is not grounds to erase those legal circuits.
    // The fallback coordinate only lets downstream class-specific addRun
    // validation fail unsafe aux/fiber runs closed; it must never emit a
    // physical trench band.
    spineX =
      gapCandidates.find(spineCorridorOk) ??
      outer.find(spineCorridorOk) ??
      gapCandidates[0] ??
      outer[0];
  }

  // ---- panels / aux endpoints ----------------------------------------------
  // Primary endpoint of each kind — selected exactly as before (bare `.find`)
  // so legacy/default designs stay byte-identical.
  const auxSwgr = equipment.find(e => e.kind === 'auxSwitchgear') ?? null;
  const auxXfmr = equipment.find(e => e.kind === 'auxTransformer') ?? null;
  const auxPanel = equipment.find(e => e.kind === 'auxSwitchPanel') ?? null;
  const fiberPanel = equipment.find(e => e.kind === 'fiberPatchPanel') ?? null;
  const firePanel = equipment.find(e => e.kind === 'fireControlPanel') ?? null;
  if (blockOrphans.size) {
    if (!auxXfmr && !auxPanel) {
      warnings.push(
        'Drawing-traced AUX_FIBER corridors have no auxiliary transformer or switch-panel source — corridor drops are shown but the source tie requires detailed design.',
      );
    }
    if (!fiberPanel && !firePanel &&
        !equipment.some(e => e.kind === 'feederJunctionBox')) {
      warnings.push(
        'Drawing-traced FIRE FIBER corridors have no fiber panel, fire-control panel, or FJB source — corridor drops are shown but the source tie requires detailed design.',
      );
    }
  }
  // Additional endpoints of each kind beyond the primary, each of which needs
  // its own tap to the existing spine/trench (task 816). Previously the bare
  // `.find` above kept only the first, silently leaving manually placed extras
  // unwired. Only explicit `peq-*` records are additive here: derived island
  // clusters and any other automatic endpoint keep their historical routing.
  // Extras also exclude whichever unit the primary already claimed, so a
  // manual item remains correctly served when it is the only endpoint of its
  // kind. All three lists are empty for legacy/default designs, making the tap
  // block below a byte-identical no-op there.
  const isManualEndpoint = (e: PlacedEquipment) => e.id.startsWith('peq-');
  const auxSwgrExtra = equipment.filter(e =>
    e.kind === 'auxSwitchgear' && isManualEndpoint(e) && e !== auxSwgr);
  const auxXfmrExtra = equipment.filter(e =>
    e.kind === 'auxTransformer' && isManualEndpoint(e) && e !== auxXfmr);
  const firePanelExtra = equipment.filter(e =>
    e.kind === 'fireControlPanel' && isManualEndpoint(e) && e !== firePanel);

  const topEdge = (e: PlacedEquipment) => {
    const rot = Math.abs(Math.sin(e.rotation)) > 0.5;
    return e.y + (rot ? e.length : e.width) / 2;
  };

  // A spine's horizontal jog leg (panel -> spine column) must never be
  // trenched UNDER equipment. In island (QTY3) layouts the aux/fiber panels
  // sit in the island gap column, so the historical fixed offset can cross a
  // container row; search outward from the preferred y for the nearest clear
  // corridor. When the preferred y is already clear (the legacy grid) the
  // result is unchanged, so QTY4 routing stays byte-identical.
  const clearJoinY = (
    xA: number, xB: number, preferred: number,
    exclude: (PlacedEquipment | null)[] = []
  ): number => {
    const lo = Math.min(xA, xB), hi = Math.max(xA, xB);
    const skip = new Set(exclude.filter((e): e is PlacedEquipment => !!e).map(e => e.id));
    const rects = equipment.filter(e => !skip.has(e.id)).map(e => {
      const rot = Math.abs(Math.sin(e.rotation)) > 0.5;
      const hx = (rot ? e.width : e.length) / 2 + 0.75;
      const hy = (rot ? e.length : e.width) / 2 + 0.75;
      return { x1: e.x - hx, y1: e.y - hy, x2: e.x + hx, y2: e.y + hy };
    });
    const clearAt = (y: number) =>
      rects.every(r => y <= r.y1 || y >= r.y2 || hi <= r.x1 || lo >= r.x2);
    if (clearAt(preferred)) return preferred;
    for (let d = 0.5; d <= 80; d += 0.5) {
      if (clearAt(preferred + d)) return preferred + d;
      if (clearAt(preferred - d)) return preferred - d;
    }
    return preferred;
  };

  // Trench extents: from just below the lowest endpoint up to the top row's
  // fiber bus.
  const topRow = invRows[invRows.length - 1];
  const bottomRow = invRows[0];
  const topFiberY = topRow[0].y + topRow[0].width / 2 + FIBER_BUS_OFF;
  const endpointYs = [
    auxSwgr, auxXfmr, auxPanel, fiberPanel, firePanel,
    ...auxSwgrExtra, ...auxXfmrExtra, ...firePanelExtra,
  ]
    .filter((e): e is PlacedEquipment => !!e)
    .map(e => e.y);
  let yBottom = endpointYs.length
    ? Math.min(...endpointYs) - 4
    : bottomRow[0].y - bottomRow[0].width / 2 - LG_JF2.length * 2 - CLEARANCES.rearToRear - 20;
  // Clamp the spine's bottom end inside the fence (concave parcels can put
  // the naive extent below the fence line at the spine x).
  {
    const yCap = bottomRow[0].y + bottomRow[0].width / 2 + MV_BUS_OFF;
    let guard = 0;
    while (
      yBottom < yCap && guard < 300 &&
      !(pointInPolygon({ x: spineX!, y: yBottom }, fence) &&
        distanceToPolygonEdge({ x: spineX!, y: yBottom }, fence) >= 2)
    ) {
      yBottom += 2;
      guard++;
    }
  }

  // ---- per-row buses + drops -------------------------------------------------
  // A row bus emitted to the full traced extent can end past the fence line
  // (traced gear sits as drawn, sometimes partly outside); addRun would then
  // omit the whole corridor. Walk each end inward to the fence interior so
  // the corridor survives and still covers every in-fence drop. No-op when
  // both ends already sit inside — auto layouts stay byte-identical.
  const clampRowBus = (a: Pt, b: Pt): Pt[] => {
    let guard = 0;
    while (a.x < b.x - 1 && guard++ < 400 && !insideFenceOnly([a], 2)) a = { x: a.x + 2, y: a.y };
    guard = 0;
    while (b.x > a.x + 1 && guard++ < 400 && !insideFenceOnly([b], 2)) b = { x: b.x - 2, y: b.y };
    return [a, b];
  };
  // Row MV bus extents, kept for the reference-only stubs to future BESS blocks
  const mvBusSegs: { y: number; minX: number; maxX: number }[] = [];
  // A block owns orphan containers only for hand-placed/traced equipment.
  // Intersect that ownership with the PCS rotation instead of depending on
  // LVAC's corridor implementation: traced yards with an explicit aux source
  // still need their MV/fiber taps rotated, while auto blocks have no orphans
  // and therefore remain byte-identical.
  const tracedInvIds = new Set(
    blocks
      .filter(b => blockOrphans.has(b.n) || !!b.inv.traceSourcePose)
      .map(b => b.inv.id)
  );
  const verticalTracedInvIds = new Set(
    blocks
      .filter(b => blockOrphans.has(b.n) && Math.abs(Math.sin(b.inv.rotation)) > 0.5)
      .map(b => b.inv.id)
  );
  // MV and fiber both terminate at the PCS aux/MV face. Horizontal layouts
  // retain their legacy world-axis points below; traced vertical columns must
  // rotate that same local-frame face and outward stub with the drawn PCS.
  // The traced-only membership guard above keeps auto output byte-identical.
  const pcsAuxTap = (inv: PlacedEquipment, endOffset: number, busOffset: number): [Pt, Pt] => {
    const m = mirrorOf(inv);
    const f = inv.doorEnd ?? -1;
    const lx = m * (inv.length / 2 - endOffset);
    const faceLy = -f * inv.width / 2;
    const cs = Math.cos(inv.rotation), sn = Math.sin(inv.rotation);
    const world = (ly: number): Pt => ({
      x: inv.x + lx * cs - ly * sn,
      y: inv.y + lx * sn + ly * cs,
    });
    return [world(faceLy), world(faceLy - f * busOffset)];
  };
  // MV attach: aux-face tap → under-skid near the aux long edge (away from
  // the container / doorEnd face). Centerline joins sit next to the battery
  // courtyard, so feeder hops L-bend around bess/cluster keep-outs; an
  // aux-edge collector keeps the trunk on the free side of the PCS.
  const pcsUnderTap = (inv: PlacedEquipment, endOffset: number): [Pt, Pt] => {
    const m = mirrorOf(inv);
    const f = inv.doorEnd ?? -1;
    const lx = m * (inv.length / 2 - endOffset);
    const faceLy = -f * inv.width / 2;
    const EDGE_INSET_FT = 0.5;
    const underLy = -f * (inv.width / 2 - EDGE_INSET_FT);
    const cs = Math.cos(inv.rotation), sn = Math.sin(inv.rotation);
    const world = (ly: number): Pt => ({
      x: inv.x + lx * cs - ly * sn,
      y: inv.y + lx * sn + ly * cs,
    });
    return [world(faceLy), world(underLy)];
  };
  invRows.forEach((row, r) => {
    const invTop = row[0].y + row[0].width / 2;
    const mvY = invTop + MV_BUS_OFF;
    const lvacY = invTop + LVAC_BUS_OFF;
    const fiberY = invTop + FIBER_BUS_OFF;
    // Traced columns carry their 480V on corridors running ALONG each column
    // (emitted from vertLvacDrops below) — suppress the legacy horizontal row
    // bus/drops that cut across equipment in the drawing-derived yards.
    // Once a drawing-derived yard has orphan-associated containers, ALL of
    // its 480V/fiber service belongs to the side-corridor tree below. Keeping
    // even one legacy horizontal row bus (for a mixed aug/future row) revives
    // the exact across-equipment trench this path is meant to eliminate.
    const tracedYard = blockOrphans.size > 0;
    const rowVerticalTraced = tracedYard;
    // Extend the row buses to the spine only when the tie-in point is inside
    // the fence at bus height; otherwise trim the bus to the row's inverters
    // (concave parcels — the row still ties in through the nearest valid bus x).
    const spineTieOk =
      pointInPolygon({ x: spineX!, y: fiberY }, fence) &&
      distanceToPolygonEdge({ x: spineX!, y: fiberY }, fence) >= 2;
    // Per-class bus extents: each bus must reach its own drop tie-in x's
    // (drops now land at the MV/aux-transformer end of each PCS, and LVAC
    // additionally covers the container-feed drops beside each PCS).
    const spineXs = spineTieOk ? [spineX!] : [];
    const legacyMvInvs = row.filter(i => !tracedInvIds.has(i.id));
    const mvXs = [
      ...spineXs,
      ...legacyMvInvs.map(i => i.x + mirrorOf(i) * (i.length / 2 - 1.2)),
    ];
    const lvacDropRecs = row.flatMap(i => lvacBusDrops.get(i.id) ?? []);
    const lvXs = [
      ...spineXs,
      ...row.map(i => i.x + mirrorOf(i) * (i.length / 2 - 2.6)),
      ...lvacDropRecs.filter(d => d.side > 0).map(d => d.x),
    ];
    const fbXs = [
      ...spineXs,
      ...row.map(i => verticalTracedInvIds.has(i.id)
        ? pcsAuxTap(i, 4.0, FIBER_BUS_OFF)[1].x
        : i.x + mirrorOf(i) * (i.length / 2 - 4.0)),
    ];
    if (legacyMvInvs.length) {
      mvBusSegs.push({ y: mvY, minX: Math.min(...mvXs), maxX: Math.max(...mvXs) });
      addRun(`mv-bus-${r + 1}`, 'MV', [{ x: Math.min(...mvXs), y: mvY }, { x: Math.max(...mvXs), y: mvY }]);
    }
    if (!mirroredMode && !tracedYard) {
      const lvacBusPts = clampRowBus({ x: Math.min(...lvXs), y: lvacY }, { x: Math.max(...lvXs), y: lvacY });
      addRun(`lvac-bus-${r + 1}`, 'LVAC', lvacBusPts);
      // South-side aux corridor: traced yards pack containers on BOTH sides
      // of a PCS row. Each side's 480V feeds tie into a corridor they can
      // reach without crossing a PCS box — the NextEra row-bus rule mirrored
      // to the row's south face.
      const southXs = lvacDropRecs.filter(d => d.side < 0).map(d => d.x);
      let southBusPts: Pt[] | null = null;
      if (southXs.length) {
        const lvacYS = row[0].y - row[0].width / 2 - LVAC_BUS_OFF;
        const sXs = [...row.map(i => i.x + mirrorOf(i) * (i.length / 2 - 2.6)), ...southXs];
        southBusPts = clampRowBus({ x: Math.min(...sXs), y: lvacYS }, { x: Math.max(...sXs), y: lvacYS });
        addRun(`lvac-bus-${r + 1}-s`, 'LVAC', southBusPts);
      }
      // Corridor trench bands so the 3D/DXF trench visuals match the cables —
      // previously only mirrored islands drew one.
      if (blockOrphans.size) {
        const pushRowCorr = (pts: Pt[], n: number) => {
          const x0 = Math.min(...pts.map(p => p.x)), x1 = Math.max(...pts.map(p => p.x));
          const cy2 = pts[0].y;
          corridorTrenches.push({
            islandN: n, y: cy2, minX: x0, maxX: x1,
            width: CORRIDOR_TRENCH_WIDTH, section: 'AUX_FIBER' as const,
            cx: (x0 + x1) / 2, cy: cy2, angleDeg: 0, length: x1 - x0,
          });
        };
        pushRowCorr(lvacBusPts, 9000 + (r + 1) * 2);
        if (southBusPts) pushRowCorr(southBusPts, 9000 + (r + 1) * 2 + 1);
      }
    }
    if (!tracedYard) {
      addRun(`fiber-bus-${r + 1}`, 'FIBER',
        [{ x: Math.min(...fbXs), y: fiberY }, { x: Math.max(...fbXs), y: fiberY }]);
    }
    for (const inv of row) {
      // Sheet 3: MV feeds from the MV transformer end of the PCS skid and
      // LVAC lands at the aux transformer connection — both at the RIGHT end
      // of the PCS (opposite the DC compartment; mirrored when the block is
      // flipped). Fiber ties in alongside with a small stagger for legibility.
      const lvacX = inv.x + mirrorOf(inv) * (inv.length / 2 - 2.6);
      const fiberX = inv.x + mirrorOf(inv) * (inv.length / 2 - 4.0);
      if (verticalTracedInvIds.has(inv.id)) {
        // A vertical traced PCS has its long axis along plan Y. Its old
        // horizontal-row stub started at world-Y "top", which can fall beyond
        // the short end wall. Rotate the sheet-3 connection face instead.
        if (!tracedYard) {
          const [fiberTap, fiberBusTap] = pcsAuxTap(inv, 4.0, FIBER_BUS_OFF);
          addRun(`fiber-drop-${inv.id}`, 'FIBER',
            [fiberTap, fiberBusTap, { x: fiberBusTap.x, y: fiberY }]);
        }
      } else if (!tracedInvIds.has(inv.id)) {
        // Same aux-edge under-skid join as traced pcsUnderTap — landing at
        // inv.y (centerline) puts the feeder hop next to the battery yard.
        const [mvTap, mvUnder] = pcsUnderTap(inv, 1.2);
        addRun(`mv-drop-${inv.id}`, 'MV', [mvTap, mvUnder]);
        if (!rowVerticalTraced) {
          addRun(`fiber-drop-${inv.id}`, 'FIBER',
            [{ x: fiberX, y: invTop }, { x: fiberX, y: fiberY }]);
        }
      }
      if (!mirroredMode && !tracedYard) {
        addRun(`lvac-drop-${inv.id}`, 'LVAC', [{ x: lvacX, y: invTop }, { x: lvacX, y: lvacY }]);
      }
    }
  });

  // Drawing-traced PCS MV starts on the local aux/MV end opposite the DC fan
  // and joins a collector under the PCS near the aux long edge (not the
  // centerline, and not a parallel offset beside the aux face). This pass
  // replaces the legacy world-Y row buses only for orphan-owned/traced blocks.
  {
    type MvTap = {
      inv: PlacedEquipment;
      tap: Pt;
      under: Pt;
      angleKey: number;
      angleRad: number;
      u: Pt;
      v: Pt;
    };
    const taps: MvTap[] = blocks
      // The energized row collector stops at the final BUILT PCS. Planned
      // augmentation/future skids reserve the row end but do not extend the
      // present-day MV trunk or receive an energized mv-drop.
      .filter(b =>
        tracedInvIds.has(b.inv.id) &&
        !b.inv.augmented &&
        !b.inv.future)
      .map(b => {
        const [tap, under] = pcsUnderTap(b.inv, 1.2);
        const normalized = ((b.inv.rotation % Math.PI) + Math.PI) % Math.PI;
        // Group only numerically identical row orientations (microradian
        // tolerance), but keep the full-precision representative angle for
        // geometry. Rounding the basis to whole degrees tilts valid 31.4°
        // collectors away from their PCS row.
        const angleKey = Math.round(normalized * 1e6);
        const θ = normalized;
        return {
          inv: b.inv,
          tap,
          under,
          angleKey,
          angleRad: normalized,
          u: { x: Math.cos(θ), y: Math.sin(θ) },
          v: { x: -Math.sin(θ), y: Math.cos(θ) },
        };
      });
    const angleKeys = Array.from(new Set(taps.map(t => t.angleKey))).sort((a, b) => a - b);
    for (const angleKey of angleKeys) {
      const oriented = taps.filter(t => t.angleKey === angleKey);
      const basis = oriented[0];
      // Use an explicitly translated row frame. Projecting absolute world
      // points against an orthonormal basis is algebraically equivalent, but
      // hiding the origin makes it dangerously easy for a future edit to
      // treat these coordinates as local and reconstruct the collector near
      // (0,0). Keep the full-precision row axes and carry the physical PCS
      // origin through both halves of the transform.
      const origin = { x: basis.inv.x, y: basis.inv.y };
      const along = (p: Pt) =>
        (p.x - origin.x) * basis.u.x + (p.y - origin.y) * basis.u.y;
      const across = (p: Pt) =>
        (p.x - origin.x) * basis.v.x + (p.y - origin.y) * basis.v.y;
      const sorted = oriented.sort((a, b) =>
        across(a.under) - across(b.under) ||
        along(a.under) - along(b.under) ||
        a.inv.id.localeCompare(b.inv.id));
      const lanes: MvTap[][] = [];
      for (const tap of sorted) {
        const last = lanes[lanes.length - 1];
        const laneCoord = (t: MvTap) => across(t.under);
        if (last && Math.abs(laneCoord(tap) - laneCoord(last[last.length - 1])) <= 15) last.push(tap);
        else lanes.push([tap]);
      }
      lanes.forEach(physicalRow => {
        const world = (s: number, c: number): Pt => ({
          x: origin.x + basis.u.x * s + basis.v.x * c,
          y: origin.y + basis.u.y * s + basis.v.y * c,
        });
        // Cable routing owns only the perpendicular PCS drops. The resolved
        // FeederCircuit membership owns the straight row collector itself
        // (its chain-hop segments), so max-per-feeder settings and approved
        // manual assignments cannot diverge from a separately chunked bus.
        // All drops on one physical row land on the same aux-edge under-skid
        // axis; any valid contiguous subset therefore forms one straight
        // collector clear of the container courtyard, while a cross-row
        // assignment fails the feeder route gate.
        physicalRow.sort((a, b) =>
          along(a.under) - along(b.under) || a.inv.id.localeCompare(b.inv.id));
        const coord = physicalRow.reduce(
          (sum, t) => sum + across(t.under), 0) / physicalRow.length;
        physicalRow.forEach(t => {
          const join = world(along(t.under), coord);
          addRun(`mv-drop-${t.inv.id}`, 'MV', [t.tap, t.under, join]);
        });
      });
    }
  }

  // Traced columns: one 480V corridor per column side, running ALONG the
  // column (world x = const) and covering every registered container-feed
  // drop. Ends walk inward to the fence interior like clampRowBus so corridors
  // survive gear kept as drawn outside the fence.
  const tracedFiberDrops = new Set<string>();
  const tracedFiberCorridors = new Map<string, CableRun[]>();
  const acceptedVerticalCorridors: CableRun[] = [];
  const acceptedHorizontalCorridors: CableRun[] = [];
  const tracedCorridorLandingY = new Map<string, number>();
  const registerFiberCorridor = (invId: string, corridor: CableRun) => {
    const list = tracedFiberCorridors.get(invId) ?? [];
    if (!list.some(r => r.id === corridor.id)) list.push(corridor);
    tracedFiberCorridors.set(invId, list);
  };
  if (vertLvacDrops.length) {
    type VerticalDrop = (typeof vertLvacDrops)[number];
    type VerticalDraftLane = {
      side: 1 | -1;
      x: number;
      drops: VerticalDrop[];
      y0: number;
      y1: number;
    };
    const draftLanes: VerticalDraftLane[] = [];
    for (const side of [1, -1] as const) {
      const sideDrops = vertLvacDrops
        .filter(d => d.side === side)
        .sort((a, b) => a.x - b.x || a.y - b.y || a.cableId.localeCompare(b.cableId));
      const groups: VerticalDrop[][] = [];
      for (const drop of sideDrops) {
        const last = groups[groups.length - 1];
        if (last && Math.abs(drop.x - last[last.length - 1].x) <= 6) {
          last.push(drop);
        } else {
          groups.push([drop]);
        }
      }
      for (const drops of groups) {
        draftLanes.push({
          side,
          x: drops.reduce((sum, d) => sum + d.x, 0) / drops.length,
          drops,
          y0: Math.min(...drops.map(d => d.y)),
          y1: Math.max(...drops.map(d => d.y)),
        });
      }
    }
    // Two opposing PCS columns form one equipment bank. Their near-side lane
    // candidates face each other (+ lane west, - lane east) and overlap for
    // most of their longitudinal span. Collapse that pair to the east/right
    // accepted strip so Area 3 gets one constructible service corridor per
    // bank (plus the standalone west bank), not two parallel duplicates.
    const laneX = new Map<string, number>();
    const usedMinus = new Set<VerticalDraftLane>();
    for (const plus of draftLanes
      .filter(l => l.side === 1)
      .sort((a, b) => a.x - b.x)) {
      const match = draftLanes
        .filter(l => l.side === -1 && l.x > plus.x && !usedMinus.has(l))
        .map(minus => {
          const overlap = Math.max(0,
            Math.min(plus.y1, minus.y1) - Math.max(plus.y0, minus.y0));
          const shorter = Math.max(1,
            Math.min(plus.y1 - plus.y0, minus.y1 - minus.y0));
          return { minus, overlapRatio: overlap / shorter };
        })
        .filter(x => x.overlapRatio >= 0.6 && x.minus.x - plus.x <= 150)
        .sort((a, b) =>
          a.minus.x - plus.x - (b.minus.x - plus.x) ||
          a.minus.x - b.minus.x)[0]?.minus;
      if (!match) continue;
      usedMinus.add(match);
      for (const drop of [...plus.drops, ...match.drops]) {
        laneX.set(drop.cableId, match.x);
      }
      const southY = Math.min(plus.y0, match.y0) - 25;
      const northY = Math.max(plus.y1, match.y1) + 25;
      for (const drop of plus.drops) {
        tracedCorridorLandingY.set(
          drop.cableId,
          Math.abs(drop.y - southY) <= Math.abs(drop.y - northY)
            ? southY
            : northY,
        );
      }
    }
    let vn = 0;
    const drops = vertLvacDrops
      .map(d => ({ ...d, x: laneX.get(d.cableId) ?? d.x }))
      .sort((a, b) => a.x - b.x || a.y - b.y || a.cableId.localeCompare(b.cableId));
    const lanes: {
      side: 1 | -1;
      xs: number[]; ys: number[]; invIds: string[]; cableIds: string[];
    }[] = [];
    for (const drop of drops) {
      const last = lanes[lanes.length - 1];
      if (last && Math.abs(drop.x - last.xs[last.xs.length - 1]) <= 6) {
        last.xs.push(drop.x);
        last.ys.push(drop.y);
        last.invIds.push(drop.invId);
        last.cableIds.push(drop.cableId);
      } else {
        lanes.push({
          side: drop.side,
          xs: [drop.x], ys: [drop.y],
          invIds: [drop.invId], cableIds: [drop.cableId],
        });
      }
    }
    // Climate normalization can move the two opposing near-side candidates
    // for one physical bank just beyond the 6 ft per-side grouping tolerance.
    // They remain a single inter-bank corridor: collapse adjacent draft lanes
    // to their centerline before obstacle acceptance, rather than attempting
    // two routes along the normalized equipment faces (both can clip bodies).
    const normalizedLanes: typeof lanes = [];
    for (let i = 0; i < lanes.length; i++) {
      const left = lanes[i], right = lanes[i + 1];
      const lx = left.xs.reduce((s, v) => s + v, 0) / left.xs.length;
      const rx = right
        ? right.xs.reduce((s, v) => s + v, 0) / right.xs.length
        : Infinity;
      if (!right || right.side === left.side || rx - lx > 15) {
        normalizedLanes.push(left);
        continue;
      }
      const center = (lx + rx) / 2;
      normalizedLanes.push({
        side: left.side,
        xs: [center],
        ys: [...left.ys, ...right.ys],
        invIds: [...left.invIds, ...right.invIds],
        cableIds: [...left.cableIds, ...right.cableIds],
      });
      i++;
    }
    for (const lane of normalizedLanes) {
      const x = lane.xs.reduce((s, v) => s + v, 0) / lane.xs.length;
        const taps = Array.from(new Set(lane.invIds))
          .map(id => equipment.find(e => e.id === id))
          .filter((e): e is PlacedEquipment => !!e)
          .map(inv => {
            const [tap, out] = pcsAuxTap(inv, 4.0, FIBER_BUS_OFF);
            return { inv, tap, out };
          });
        const landingYs = lane.cableIds
          .map(id => tracedCorridorLandingY.get(id))
          .filter((y): y is number => y !== undefined);
        let y0 = Math.min(...lane.ys, ...taps.map(t => t.tap.y), ...landingYs);
        let y1 = Math.max(...lane.ys, ...taps.map(t => t.tap.y), ...landingYs);
        if (y1 - y0 < 2) { y0 -= 1; y1 += 1; }
        let guard = 0;
        while (y0 < y1 - 1 && guard++ < 400 && !insideFenceOnly([{ x, y: y0 }], 2)) y0 += 2;
        guard = 0;
        while (y1 > y0 + 1 && guard++ < 400 && !insideFenceOnly([{ x, y: y1 }], 2)) y1 -= 2;
        if (y1 - y0 < 1) continue;
        vn++;
        const corridorClearance = CORRIDOR_TRENCH_WIDTH / 2 + 0.5;
        const corridorRects = expandedEquipmentRects(corridorClearance);
        const verticalAt = (cx: number): Pt[] => [{ x: cx, y: y0 }, { x: cx, y: y1 }];
        const clearVertical = (pts: Pt[]) =>
          insideFence(sampled(pts)) && !transitsEquipment(pts, corridorRects);
        let corridorPts = verticalAt(x);
        if (!clearVertical(corridorPts)) {
          // Normalization can move a standard container footprint onto the
          // trace-derived bank centerline. Keep one physical bank corridor,
          // but slide it to the nearest fully visible-pose-clear parallel
          // alignment before invoking the general detour router. Endpoints,
          // cable line and trench band are all checked at the same clearance.
          for (let step = 1; step <= 160 && !clearVertical(corridorPts); step++) {
            const d = step * 0.5;
            const plus = verticalAt(x + d);
            const minus = verticalAt(x - d);
            if (clearVertical(plus)) corridorPts = plus;
            else if (clearVertical(minus)) corridorPts = minus;
          }
        }
        const accepted = addTracedCorridor(
          `bus-v${vn}`, corridorPts, 95000 + vn * 20);
        if (!accepted) continue;
        acceptedVerticalCorridors.push(accepted);
        for (const cableId of lane.cableIds) {
          const planned = plannedTracedLvac.get(cableId);
          if (!planned?.length) continue;
          attemptedTracedLvac.add(cableId);
          const landingY = tracedCorridorLandingY.get(cableId);
          const land = closestPointOnRun(
            landingY === undefined
              ? planned[0]
              : { x: planned[0].x, y: landingY },
            accepted.pts,
          );
          const feed = addRun(cableId, 'LVAC',
            landingY === undefined
              ? [
                  land,
                  { x: land.x, y: planned[0].y },
                  ...planned,
                ]
              : [
                  land,
                  { x: planned[0].x, y: land.y },
                  ...planned,
                ],
            false, undefined, 0.75, true,
            [null, cableId.slice('lvac-'.length)]);
        }
        for (const { inv } of taps) registerFiberCorridor(inv.id, accepted);
    }
  }

  // Horizontal 480V row corridors for traced clusters that run beside their
  // PCS in world-X: same clustering/fence-trim rules as the vertical lanes.
  if (horzLvacDrops.length) {
    let hn = 0;
    for (const sideSign of [1, -1] as const) {
      const drops = horzLvacDrops
        .filter(d2 => d2.side === sideSign)
        .sort((a, b2) => a.y - b2.y || a.x - b2.x);
      // A new lane starts when the corridor y jumps more than 6 ft
      // (separate PCS rows in the same yard).
      const lanes: { ys: number[]; xs: number[]; invIds: string[]; cableIds: string[] }[] = [];
      for (const d2 of drops) {
        const last = lanes[lanes.length - 1];
        if (last && Math.abs(d2.y - last.ys[last.ys.length - 1]) <= 6) {
          last.ys.push(d2.y); last.xs.push(d2.x); last.invIds.push(d2.invId);
          last.cableIds.push(d2.cableId);
        } else lanes.push({
          ys: [d2.y], xs: [d2.x], invIds: [d2.invId], cableIds: [d2.cableId],
        });
      }
      for (const lane of lanes) {
        const y = lane.ys.reduce((s, v) => s + v, 0) / lane.ys.length;
        const taps = Array.from(new Set(lane.invIds))
          .map(id => equipment.find(e => e.id === id))
          .filter((e): e is PlacedEquipment => !!e)
          .map(inv => {
            const [tap, out] = pcsAuxTap(inv, 4.0, FIBER_BUS_OFF);
            return { inv, tap, out };
          });
        let x0 = Math.min(...lane.xs, ...taps.map(t => t.tap.x));
        let x1 = Math.max(...lane.xs, ...taps.map(t => t.tap.x));
        // Keep the physical corridor alongside this assigned row.  Extending
        // every row lane to a global spine can span and cut adjacent rows.
        if (x1 - x0 < 2) { x0 -= 1; x1 += 1; }
        let guard = 0;
        while (x0 < x1 - 1 && guard++ < 400 && !insideFenceOnly([{ x: x0, y }], 2)) x0 += 2;
        guard = 0;
        while (x1 > x0 + 1 && guard++ < 400 && !insideFenceOnly([{ x: x1, y }], 2)) x1 -= 2;
        if (x1 - x0 < 1) continue;
        hn++;
        const accepted = addTracedCorridor(
          `bus-h${hn}`, [{ x: x0, y }, { x: x1, y }], 96000 + hn * 20);
        if (!accepted) continue;
        acceptedHorizontalCorridors.push(accepted);
        for (const cableId of lane.cableIds) {
          const planned = plannedTracedLvac.get(cableId);
          if (!planned?.length) continue;
          attemptedTracedLvac.add(cableId);
          const land = closestPointOnRun(planned[0], accepted.pts);
          const feed = addRun(cableId, 'LVAC', [
            land,
            { x: planned[0].x, y: land.y },
            ...planned,
          ], false, undefined, 0.75, true,
          [null, cableId.slice('lvac-'.length)]);
        }
        for (const { inv } of taps) registerFiberCorridor(inv.id, accepted);
      }
    }
  }

  // A declared source may join the accepted row/column corridors through one
  // physical yard manifold. Source-less traced yards intentionally keep their
  // bank corridors independent: drawing a global cross-yard trunk in that
  // case invents topology and, in Area 3, puts a trench through the road.
  const acceptedTracedCorridors = [
    ...acceptedVerticalCorridors,
    ...acceptedHorizontalCorridors,
  ];
  const tracedFiberSource = fiberPanel ?? firePanel ??
    equipment.find(e =>
      e.kind === 'feederJunctionBox' && !e.augmented && !e.future) ?? null;
  const hasTracedSource = !!(auxXfmr || auxPanel || tracedFiberSource);
  let tracedSharedTrunk: CableRun | null = null;
  if (acceptedTracedCorridors.length && hasTracedSource) {
    const horizontal = acceptedTracedCorridors.every(c => {
      const xs = c.pts.map(p => p.x), ys = c.pts.map(p => p.y);
      return Math.max(...xs) - Math.min(...xs) >= Math.max(...ys) - Math.min(...ys);
    });
    const vertical = acceptedTracedCorridors.every(c => {
      const xs = c.pts.map(p => p.x), ys = c.pts.map(p => p.y);
      return Math.max(...ys) - Math.min(...ys) > Math.max(...xs) - Math.min(...xs);
    });
    const xs = acceptedTracedCorridors.flatMap(c => c.pts.map(p => p.x));
    const ys = acceptedTracedCorridors.flatMap(c => c.pts.map(p => p.y));
    const xRanges = acceptedTracedCorridors.map(c => ({
      lo: Math.min(...c.pts.map(p => p.x)),
      hi: Math.max(...c.pts.map(p => p.x)),
    }));
    const yRanges = acceptedTracedCorridors.map(c => ({
      lo: Math.min(...c.pts.map(p => p.y)),
      hi: Math.max(...c.pts.map(p => p.y)),
    }));
    const unique = (values: number[]) => Array.from(new Set(
      values.filter(Number.isFinite).map(v => Math.round(v * 1000) / 1000),
    ));
    // A customer row corridor ties into a vertical edge spine; a customer
    // column corridor ties into a horizontal edge spine. Try both field edges
    // before an interior common coordinate so the trunk stays outside the
    // equipment rows. Mixed-orientation drawings retain the legacy vertical
    // candidate as a deterministic fallback.
    const candidates: Pt[][] = horizontal
      ? unique([
          Math.min(...xs), Math.max(...xs),
          Math.max(...xRanges.map(r => r.lo)),
          Math.min(...xRanges.map(r => r.hi)),
          ...(spineX == null ? [] : [spineX]),
        ]).map(x => {
          let y0 = Math.min(...ys), y1 = Math.max(...ys);
          if (y1 - y0 < 2) { y0 -= 1; y1 += 1; }
          return [{ x, y: y0 }, { x, y: y1 }];
        })
      : vertical
        ? unique([
            Math.min(...ys), Math.max(...ys),
            Math.max(...yRanges.map(r => r.lo)),
            Math.min(...yRanges.map(r => r.hi)),
          ]).map(y => {
            let x0 = Math.min(...xs), x1 = Math.max(...xs);
            if (x1 - x0 < 2) { x0 -= 1; x1 += 1; }
            return [{ x: x0, y }, { x: x1, y }];
          })
        : (spineX == null ? [] : [[
            { x: spineX, y: Math.min(...ys) },
            { x: spineX, y: Math.max(...ys) },
          ]]);
    for (const trunkPts of candidates) {
      const cableBase = cables.length;
      const trenchBase = corridorTrenches.length;
      const warningBase = warnings.length;
      const trunk = addTracedCorridor('trunk', trunkPts, 97000);
      if (!trunk) {
        warnings.length = warningBase;
        continue;
      }
      let allJoined = true;
      let linkN = 0;
      for (const corridor of acceptedTracedCorridors) {
        const trunkMid = trunk.pts[Math.floor(trunk.pts.length / 2)];
        const from = closestPointOnRun(trunkMid, corridor.pts);
        const onTrunk = closestPointOnRun(from, trunk.pts);
        if (Math.hypot(from.x - onTrunk.x, from.y - onTrunk.y) <= 0.1) continue;
        const link = addTracedCorridor(
          `link-${++linkN}`,
          horizontal
            ? [from, { x: onTrunk.x, y: from.y }, onTrunk]
            : [from, { x: from.x, y: onTrunk.y }, onTrunk],
          97200 + linkN * 20);
        if (!link) { allJoined = false; break; }
      }
      if (allJoined) {
        tracedSharedTrunk = trunk;
        break;
      }
      cables.splice(cableBase);
      corridorTrenches.splice(trenchBase);
      warnings.length = warningBase;
    }
    if (tracedSharedTrunk) {
      const addSource = (
        id: 'lvac-spine' | 'fiber-source-traced',
        cls: 'LVAC' | 'FIBER',
        source: PlacedEquipment | null,
        islandBase: number,
      ) => {
        if (!source || !tracedSharedTrunk) return;
        const joinFromCenter = closestPointOnRun(source, tracedSharedTrunk.pts);
        const alongY = horizontal;
        const sign = Math.sign(alongY
          ? joinFromCenter.y - source.y
          : joinFromCenter.x - source.x) || 1;
        // Intersect a centerline ray with the ACTUAL rotated enclosure, rather
        // than using its world AABB top edge.  The first point is therefore a
        // real transformer/panel face terminal at every quarter-turn.
        const c = Math.cos(source.rotation), s = Math.sin(source.rotation);
        const halfL = source.length / 2, halfW = source.width / 2;
        const faceOffset = alongY
          ? 1 / (Math.abs(s) / halfL + Math.abs(c) / halfW)
          : 1 / (Math.abs(c) / halfL + Math.abs(s) / halfW);
        const start = alongY
          ? { x: source.x, y: source.y + sign * faceOffset }
          : { x: source.x + sign * faceOffset, y: source.y };
        const join = closestPointOnRun(start, tracedSharedTrunk.pts);
        // Leave the enclosure normal to its selected face before making the
        // manifold turn.  This short clearance jog must follow (not replace)
        // the exact face terminal.
        const clear = alongY
          ? { x: start.x, y: start.y + sign * 4 }
          : { x: start.x + sign * 4, y: start.y };
        addTracedSourceLead(id, cls, [
          start,
          clear,
          horizontal
            ? { x: clear.x, y: join.y }
            : { x: join.x, y: clear.y },
          join,
        ], islandBase);
      };
      addSource('lvac-spine', 'LVAC', auxXfmr ?? auxPanel, 98000);
      addSource(
        'fiber-source-traced', 'FIBER', tracedFiberSource, 98200,
      );
    } else {
      warnings.push(
        'Drawing-traced AUX_FIBER corridors could not be joined to one equipment-clear yard trunk — source leads omitted; resolve the conflict before issue.',
      );
    }
  }

  // Publish each traced PCS fiber landing only after all of its candidate
  // physical corridors are accepted.  Try nearest candidates deterministically
  // and fail closed on equipment so a rejected first-side lane does not either
  // suppress the PCS entirely or leave a crossing run behind.
  for (const inv of blocks
    .map(b => b.inv)
    .filter(inv => tracedInvIds.has(inv.id) && !inv.augmented && !inv.future)
    .sort((a, b) => a.id.localeCompare(b.id))) {
    const [tap, out] = pcsAuxTap(inv, 4.0, FIBER_BUS_OFF);
    const horizontal = Math.abs(Math.cos(inv.rotation)) > 0.5;
    const orientationCorridors = horizontal
      ? acceptedHorizontalCorridors
      : acceptedVerticalCorridors;
    const candidates = Array.from(new Map([
      ...(tracedFiberCorridors.get(inv.id) ?? []),
      ...orientationCorridors,
    ].map(c => [c.id, c])).values())
      .map(corridor => ({
        corridor,
        land: closestPointOnRun(out, corridor.pts),
      }))
      .sort((a, b) =>
        Math.hypot(a.land.x - out.x, a.land.y - out.y) -
          Math.hypot(b.land.x - out.x, b.land.y - out.y) ||
        a.corridor.id.localeCompare(b.corridor.id));
    for (const { corridor, land } of candidates) {
      // Search deterministic landing points along the accepted corridor.  A
      // nearest-point-only choice can put the perpendicular drop behind a
      // sibling enclosure even though a clear tie exists a few feet along the
      // same physical trench.
      const landings: Pt[] = [land];
      for (let i = 0; i + 1 < corridor.pts.length; i++) {
        const a = corridor.pts[i], b = corridor.pts[i + 1];
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        const steps = Math.max(1, Math.ceil(len / 2));
        for (let s = 0; s <= steps; s++) {
          landings.push({
            x: a.x + (b.x - a.x) * s / steps,
            y: a.y + (b.y - a.y) * s / steps,
          });
        }
      }
      const uniqueLandings = dedupe(landings.sort((a, b) =>
        Math.hypot(a.x - out.x, a.y - out.y) -
          Math.hypot(b.x - out.x, b.y - out.y) ||
        a.x - b.x || a.y - b.y));
      for (const q of uniqueLandings) {
        const elbows = horizontal
          ? [{ x: out.x, y: q.y }, { x: q.x, y: out.y }]
          : [{ x: q.x, y: out.y }, { x: out.x, y: q.y }];
        for (const elbow of elbows) {
          const pts = dedupe([tap, out, elbow, q]);
          if (pts.length < 2 ||
              transitsEquipment(pts, expandedEquipmentRects(0.75)) ||
              sampled(pts).some(p => pointInExclusion(p, exclRects))) continue;
          cables.push({ id: `fiber-drop-${inv.id}`, class: 'FIBER', pts });
          if (!insideFence(sampled(pts))) {
            warnings.push(
              `Fiber drop for traced PCS ${inv.id} serves drawing-traced equipment outside the fence envelope — equipment-clear route kept as drawn.`,
            );
          }
          tracedFiberDrops.add(inv.id);
          break;
        }
        if (tracedFiberDrops.has(inv.id)) break;
      }
      if (tracedFiberDrops.has(inv.id)) break;
    }
    if (!tracedFiberDrops.has(inv.id)) {
      warnings.push(
        `Fiber drop for traced PCS ${inv.id} has no equipment-clear tie to an accepted AUX_FIBER corridor — omitted; resolve the conflict before issue.`,
      );
    }
  }

  // ---- island aux collectors (mirrored mode) --------------------------------
  // One 480V collector run along each island's corridor centerline covering
  // every container drop. Islands with their own mid-island aux cluster
  // (island-aux-xfmr-<n>, per the reference island detail) feed straight from
  // that cluster — the collector simply extends to cover the transformer x
  // and no trench-spine tie is needed. Islands WITHOUT a cluster fall back to
  // the historical behavior: extend to the trench spine when the tie-in point
  // is routable and run a corridor spine leg down to the yard-level aux
  // transformer / switch panel via the trench band.
  if (mirroredMode) {
    routeRotatedIslandExtras();
    const corridorYs: number[] = [];
    let untied = false;
    islands!.forEach(isl => {
      if (islAngleRad(isl) !== 0) return; // handled by the rotated-island pass above
      const drops = islandDrops.get(isl.y);
      if (!drops || !drops.length) return;
      const ownXfmr = equipment.find(e => e.id === `island-aux-xfmr-${isl.n}`);
      let xs: number[];
      if (ownXfmr) {
        xs = [...drops, ownXfmr.x];
      } else {
        const spineOk =
          pointInPolygon({ x: spineX!, y: isl.y }, fence) &&
          distanceToPolygonEdge({ x: spineX!, y: isl.y }, fence) >= 2;
        xs = spineOk ? [...drops, spineX!] : drops;
        if (spineOk) corridorYs.push(isl.y);
        else untied = true;
      }
      // Fiber daisy chain THROUGH the island's junction box(es): per
      // reference CAR-D-B005-0 the FJBs carry the fiber-optic comms loop
      // (the 34.5 kV feeders bypass them). The corridor fiber run extends
      // to cover every box x, with a short tap into each box edge.
      const fjbs = equipment.filter(e =>
        e.kind === 'feederJunctionBox' && new RegExp(`^fjb-${isl.n}(?:-\\d+)?$`).test(e.id));
      const fiberXs = [...xs, ...fjbs.map(f => f.x)];
      addRun(`fiber-corridor-${isl.n}`, 'FIBER', [
        { x: Math.min(...fiberXs), y: isl.y },
        { x: Math.max(...fiberXs), y: isl.y },
      ]);
      for (const f of fjbs) {
        const rotF = Math.abs(Math.sin(f.rotation)) > 0.5;
        const hyF = (rotF ? f.length : f.width) / 2;
        const edgeYF = f.y > isl.y ? f.y - hyF : f.y + hyF;
        addRun(`fiber-fjb-${f.id}`, 'FIBER', [
          { x: f.x, y: isl.y },
          { x: f.x, y: edgeYF },
        ]);
      }
      addRun(`lvac-corridor-${isl.n}`, 'LVAC', [
        { x: Math.min(...xs), y: isl.y },
        { x: Math.max(...xs), y: isl.y },
      ]);
      if (ownXfmr) {
        // Short tap from the corridor centerline into the mid-island aux
        // cluster (the gear stacks down the gap column just off the
        // corridor band, clear of the feeder approach highway).
        const rot = Math.abs(Math.sin(ownXfmr.rotation)) > 0.5;
        const hy = (rot ? ownXfmr.length : ownXfmr.width) / 2;
        const edgeY = ownXfmr.y > isl.y ? ownXfmr.y - hy : ownXfmr.y + hy;
        addRun(`lvac-corridor-${isl.n}-tap`, 'LVAC', [
          { x: ownXfmr.x, y: isl.y },
          { x: ownXfmr.x, y: edgeY },
        ]);
      }
      corridorTrenches.push({
        islandN: isl.n, y: isl.y,
        minX: Math.min(...fiberXs), maxX: Math.max(...fiberXs),
        width: CORRIDOR_TRENCH_WIDTH,
        section: 'AUX_FIBER',
        // Angle-aware fields for modern consumers (horizontal = 0°)
        cx: (Math.min(...fiberXs) + Math.max(...fiberXs)) / 2,
        cy: isl.y,
        angleDeg: 0,
        length: Math.max(...fiberXs) - Math.min(...fiberXs),
      });
    });
    const lvacSrcM = equipment.find(e => e.kind === 'auxTransformer' && !e.id.startsWith('island-aux-'))
      ?? equipment.find(e => e.kind === 'auxSwitchPanel');
    if (untied || (corridorYs.length > 0 && !lvacSrcM)) {
      warnings.push('480V aux corridor collectors could not be tied to the trench spine — connect the island aux corridors to the aux power source manually.');
    }
    if (lvacSrcM && corridorYs.length) {
      const srcTop = lvacSrcM.y + (Math.abs(Math.sin(lvacSrcM.rotation)) > 0.5 ? lvacSrcM.length : lvacSrcM.width) / 2;
      const joinY = srcTop + 4;
      addRun('lvac-spine', 'LVAC', [
        { x: lvacSrcM.x, y: srcTop },
        { x: lvacSrcM.x, y: joinY },
        { x: spineX! - 1.5, y: joinY },
        { x: spineX! - 1.5, y: Math.max(...corridorYs) },
      ]);
    }

    // ---- island aux power links (AUXPWR, spec §2) --------------------------
    // Each mid-island aux cluster stacks the distribution center on one side
    // of the corridor and the transformer on the other; the LV aux power
    // link crosses between their facing edges perpendicular to the corridor,
    // in the island's own frame so placed/rotated islands stay correct.
    for (const isl of islands!) {
      const xf = equipment.find(e => e.id === `island-aux-xfmr-${isl.n}`);
      const ds = equipment.find(e => e.id === `island-aux-dist-${isl.n}`);
      if (!xf || !ds) continue;
      const rotI = islAngleRad(isl) !== 0 && isl.cx != null && isl.cy != null;
      const L = (e: PlacedEquipment) => (rotI ? islToLocalEq(isl, e) : e);
      const Wp = (p: Pt) => (rotI ? islToWorld(isl, p) : p);
      const lx = L(xf), ld = L(ds);
      const hyOf = (e: { rotation: number; length: number; width: number }) =>
        (Math.abs(Math.sin(e.rotation)) > 0.5 ? e.length : e.width) / 2;
      const sgn = Math.sign(ld.y - lx.y) || 1;
      const x = (lx.x + ld.x) / 2;
      addRun(`auxpwr-island-${isl.n}`, 'AUXPWR', [
        Wp({ x, y: lx.y + sgn * hyOf(lx) }),
        Wp({ x, y: ld.y - sgn * hyOf(ld) }),
      ]);
    }
  }

  // ---- spine verticals ---------------------------------------------------------
  const topMvY = topRow[0].y + topRow[0].width / 2 + MV_BUS_OFF;
  const topLvacY = topRow[0].y + topRow[0].width / 2 + LVAC_BUS_OFF;

  // On concave parcels the spine x can sit in a notch outside the fence at
  // bus height. Pick a valid anchor x on the class's own top-row bus instead
  // (nearest routable drop tie-in x to a target x), so the spine still lands
  // on the bus segment it ties into. Candidates are the same per-class drop
  // x's the bus extents were built from — never bare inverter centers, which
  // may lie outside the trimmed bus.
  const topDropXs = (off: number) =>
    topRow.map(i => i.x + mirrorOf(i) * (i.length / 2 - off));
  const spineAnchorX = (busY: number, targetX: number, candidates: number[]): number => {
    if (insideFence([{ x: spineX!, y: busY }])) return spineX!;
    const xs = candidates
      .filter(x => insideFence([{ x, y: busY }]))
      .sort((a, b2) => Math.abs(a - targetX) - Math.abs(b2 - targetX));
    return xs[0] ?? spineX!;
  };

  // MV: spine down to aux switchgear (or POI stub south of the yard)
  if (auxSwgr && !blockOrphans.size) {
    const ax0 = spineAnchorX(topMvY, auxSwgr.x, topDropXs(1.2));
    const joinY = clearJoinY(ax0, auxSwgr.x, topEdge(auxSwgr) + 6, [auxSwgr]);
    const ax = ax0;
    addRun('mv-spine', 'MV', [
      { x: ax, y: topMvY },
      { x: ax, y: joinY },
      { x: auxSwgr.x, y: joinY },
      { x: auxSwgr.x, y: topEdge(auxSwgr) },
    ]);
  } else if (!blockOrphans.size) {
    const ax = spineAnchorX(topMvY, spineX!, topDropXs(1.2));
    addRun('mv-spine', 'MV', [
      { x: ax, y: topMvY },
      { x: ax, y: yBottom },
    ]);
  }

  // LVAC: from aux transformer (or aux switch panel) up the spine
  // (mirrored mode draws its own corridor spine above instead)
  const lvacSrc = auxXfmr ?? auxPanel;
  if (lvacSrc && !mirroredMode && !blockOrphans.size) {
    const joinY = topEdge(lvacSrc) + 4;
    const ax = spineAnchorX(topLvacY, lvacSrc.x, topDropXs(2.6)) - 1.5;
    addRun('lvac-spine', 'LVAC', [
      { x: lvacSrc.x, y: topEdge(lvacSrc) },
      { x: lvacSrc.x, y: joinY },
      { x: ax, y: joinY },
      { x: ax, y: topLvacY },
    ]);
  }
  // Aux switch panel ties to the aux transformer when both exist. The legacy
  // grid places them side by side, so the historical shape (up over both
  // tops, across, down) is clear and stays byte-identical. Island (QTY3)
  // layouts can land the panel cluster tens of feet from the transformer —
  // there the naive tie sweeps its legs THROUGH container rows, so search
  // for a join elevation where all three legs (both verticals + the
  // horizontal) are clear of equipment, attaching to the transformer's
  // bottom edge when the clear corridor runs below it.
  if (auxXfmr && auxPanel) {
    const bottomEdge = (e: PlacedEquipment) => {
      const rot = Math.abs(Math.sin(e.rotation)) > 0.5;
      return e.y - (rot ? e.length : e.width) / 2;
    };
    const skip = new Set([auxXfmr.id, auxPanel.id]);
    const rects = equipment.filter(e => !skip.has(e.id)).map(e => {
      const rot = Math.abs(Math.sin(e.rotation)) > 0.5;
      const hx = (rot ? e.width : e.length) / 2 + 0.75;
      const hy = (rot ? e.length : e.width) / 2 + 0.75;
      return { x1: e.x - hx, y1: e.y - hy, x2: e.x + hx, y2: e.y + hy };
    });
    const hClear = (y: number, xa: number, xb: number) => {
      const lo = Math.min(xa, xb), hi = Math.max(xa, xb);
      return rects.every(r => y <= r.y1 || y >= r.y2 || hi <= r.x1 || lo >= r.x2);
    };
    const vClear = (x: number, ya: number, yb: number) => {
      const lo = Math.min(ya, yb), hi = Math.max(ya, yb);
      return rects.every(r => x <= r.x1 || x >= r.x2 || hi <= r.y1 || lo >= r.y2);
    };
    const tieAt = (joinY: number) => {
      const xfAttach = joinY >= topEdge(auxXfmr) ? topEdge(auxXfmr)
        : joinY <= bottomEdge(auxXfmr) ? bottomEdge(auxXfmr) : null;
      if (xfAttach === null) return null;
      if (!vClear(auxPanel.x, topEdge(auxPanel), joinY)) return null;
      if (!hClear(joinY, auxPanel.x, auxXfmr.x)) return null;
      if (!vClear(auxXfmr.x, joinY, xfAttach)) return null;
      return [
        { x: auxPanel.x, y: topEdge(auxPanel) },
        { x: auxPanel.x, y: joinY },
        { x: auxXfmr.x, y: joinY },
        { x: auxXfmr.x, y: xfAttach },
      ];
    };
    const preferred = Math.max(topEdge(auxXfmr), topEdge(auxPanel)) + 2;
    let pts = tieAt(preferred);
    for (let d = 0.5; d <= 120 && !pts; d += 0.5) {
      pts = tieAt(preferred - d) ?? tieAt(preferred + d);
    }
    // Panel tie is the aux DISTRIBUTION-side LV power link (spec §2 AUXPWR
    // class); run id stays stable for waypoint overrides / schedules.
    addRun('lvac-panel-tie', 'AUXPWR', pts ?? [
      { x: auxPanel.x, y: topEdge(auxPanel) },
      { x: auxPanel.x, y: preferred },
      { x: auxXfmr.x, y: preferred },
      { x: auxXfmr.x, y: topEdge(auxXfmr) },
    ]);
  }

  // FIBER: from fiber patch panel up the spine; fire control panel tie-in
  if (fiberPanel && !blockOrphans.size) {
    const topFbY = topRow[0].y + topRow[0].width / 2 + FIBER_BUS_OFF;
    const ax = spineAnchorX(topFbY, fiberPanel.x, topDropXs(4.0)) + 1.5;
    const joinY = clearJoinY(ax, fiberPanel.x, topEdge(fiberPanel) + 3, [fiberPanel, firePanel]);
    addRun('fiber-spine', 'FIBER', [
      { x: fiberPanel.x, y: topEdge(fiberPanel) },
      { x: fiberPanel.x, y: joinY },
      { x: ax, y: joinY },
      { x: ax, y: topFbY },
    ]);
    if (firePanel) {
      const tieY = Math.max(topEdge(firePanel), topEdge(fiberPanel)) + 1.5;
      addRun('fiber-fcp-tie', 'FIBER', [
        { x: firePanel.x, y: topEdge(firePanel) },
        { x: firePanel.x, y: tieY },
        { x: fiberPanel.x, y: tieY },
        { x: fiberPanel.x, y: topEdge(fiberPanel) },
      ]);
    }
  } else if (!blockOrphans.size && firePanel?.id.startsWith('peq-')) {
    // A manually placed FACP must still be wired when no separately placed
    // fiber patch panel exists. Route the primary one to the shared fiber
    // spine; firePanelExtra below handles every subsequent FACP.
    const ax = spineX! + 1.5;
    const joinY = clearJoinY(ax, firePanel.x, topEdge(firePanel) + 4, [firePanel]);
    addRun(`fiber-fcp-tie-${firePanel.id}`, 'FIBER', [
      { x: firePanel.x, y: topEdge(firePanel) },
      { x: firePanel.x, y: joinY },
      { x: ax, y: joinY },
    ]);
  }

  // ---- additional aux endpoints (task 816) ----------------------------------
  // Legacy/default designs have exactly one endpoint of each kind, wired by the
  // primary spine logic above (byte-identical). Any manually placed EXTRAS were
  // previously dropped by the `.find(...)` selection, leaving them unwired.
  // Each extra now taps onto the SAME yard spine column at a clear join
  // elevation next to its own body — a short L from the equipment top edge,
  // across at a clear corridor, then down/up the spine column. Run ids are keyed
  // on the equipment id so they stay stable across regenerations. This block is
  // a no-op whenever the extra lists are empty (default designs), so nothing in
  // the historical output changes. The trench extents already grew to cover
  // these endpoints via `endpointYs` above.
  const spineTap = (
    id: string, cls: CableRun['class'], e: PlacedEquipment,
    spineOffset: number,
  ): void => {
    // Tap column: the spine x nudged by the same per-class offset the primary
    // spine uses (MV on-center, LVAC -1.5, FIBER +1.5) so the extra rides the
    // same channel as its class without overlapping the primary run.
    const ax = spineX! + (blockOrphans.size ? 0 : spineOffset);
    const joinY = clearJoinY(ax, e.x, topEdge(e) + 4, [e]);
    addRun(id, cls, [
      { x: e.x, y: topEdge(e) },
      { x: e.x, y: joinY },
      { x: ax, y: joinY },
    ]);
  };
  // Every additional aux switchgear gets an MV tap to the existing spine.
  for (const e of auxSwgrExtra) spineTap(`mv-spine-${e.id}`, 'MV', e, 0);
  // Every additional aux transformer gets an LVAC tap to the existing spine.
  for (const e of auxXfmrExtra) spineTap(`lvac-spine-${e.id}`, 'LVAC', e, -1.5);
  // Every additional fire control panel gets a fiber connection: to the fiber
  // patch panel when one exists, otherwise the fiber spine column.
  for (const e of firePanelExtra) {
    if (fiberPanel) {
      const tieY = Math.max(topEdge(e), topEdge(fiberPanel)) + 1.5;
      addRun(`fiber-fcp-tie-${e.id}`, 'FIBER', [
        { x: e.x, y: topEdge(e) },
        { x: e.x, y: tieY },
        { x: fiberPanel.x, y: tieY },
        { x: fiberPanel.x, y: topEdge(fiberPanel) },
      ]);
    } else {
      spineTap(`fiber-fcp-tie-${e.id}`, 'FIBER', e, 1.5);
    }
  }

  // ---- 144-ct fiber trunks (R-FB-1/2) ------------------------------------------
  // One 144-ct trunk from the control enclosure (fiber patch panel) to ONE
  // FJB per island; the island's 6-ct fiber corridor daisy-chains onward from
  // that box. Trunks ride a channel beside the 6-ct fiber spine with a small
  // per-trunk stagger, then the island corridor line offset 0.7 ft so trunk
  // and 6-ct corridor read as separate conductors. Non-island layouts keep
  // fiber-spine/row buses as the head-end path (no trunks, byte-identical).
  if (mirroredMode && fiberPanel) {
    const targets = islands!.flatMap(isl => {
      const list = equipment
        .filter(e => e.kind === 'feederJunctionBox' &&
          new RegExp(`^fjb-${isl.n}(?:-\\d+)?$`).test(e.id))
        .sort((a, b2) => a.id.localeCompare(b2.id));
      return list.length ? [{ isl, fjb: list[0] }] : [];
    }).sort((a, b2) => a.isl.n - b2.isl.n);
    if (targets.length) {
      const topFbY2 = topRow[0].y + topRow[0].width / 2 + FIBER_BUS_OFF;
      const ax0 = spineAnchorX(topFbY2, fiberPanel.x, topDropXs(4.0));
      // The fixed channel offset can land on an island-end aux cluster (a
      // transformer straddling ax0+2.4 pierced trunk 2 on Hondo). Scan a
      // small deterministic candidate ladder per trunk — current offset
      // first so clear yards keep their geometry, then east, then west of
      // the anchor — and take the first channel whose FULL path clears
      // every non-junction equipment body. Junction boxes and the patch
      // panel remain legal pass-throughs; if no candidate is fully clear,
      // keep the least-crossing one (never worse than the fixed offset).
      const trunkHits = (pts: Pt[]): number => {
        let hits = 0;
        for (const e of equipment) {
          if (e.kind === 'feederJunctionBox' || e.kind === 'fiberPatchPanel') continue;
          const rotE = Math.abs(Math.sin(e.rotation)) > 0.5;
          const hx = (rotE ? e.width : e.length) / 2 + 0.3;
          const hy = (rotE ? e.length : e.width) / 2 + 0.3;
          const x1 = e.x - hx, x2 = e.x + hx, y1 = e.y - hy, y2 = e.y + hy;
          const near = (p: Pt) =>
            p.x >= x1 - 3 && p.x <= x2 + 3 && p.y >= y1 - 3 && p.y <= y2 + 3;
          if (near(pts[0]) || near(pts[pts.length - 1])) continue;
          let hit = false;
          for (let i = 0; i + 1 < pts.length && !hit; i++) {
            const a = pts[i], b = pts[i + 1];
            const steps = Math.max(2, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y)));
            for (let s = 1; s < steps; s++) {
              const px = a.x + ((b.x - a.x) * s) / steps;
              const py = a.y + ((b.y - a.y) * s) / steps;
              if (px > x1 && px < x2 && py > y1 && py < y2) { hit = true; break; }
            }
          }
          if (hit) hits++;
        }
        return hits;
      };
      const chosenXs: number[] = [];
      targets.forEach(({ isl, fjb }, k) => {
        const rotI = islAngleRad(isl) !== 0 && isl.cx != null && isl.cy != null;
        const buildPts = (trunkX: number): Pt[] => {
          const joinY = clearJoinY(trunkX, fiberPanel.x,
            topEdge(fiberPanel) + 4.2, [fiberPanel, firePanel]);
          const head: Pt[] = [
            { x: fiberPanel.x, y: topEdge(fiberPanel) },
            { x: fiberPanel.x, y: joinY },
            { x: trunkX, y: joinY },
          ];
          if (!rotI) {
            const laneY = isl.y + 0.7;
            const boxRot = Math.abs(Math.sin(fjb.rotation)) > 0.5;
            const hyB = (boxRot ? fjb.length : fjb.width) / 2;
            const edgeY = fjb.y > isl.y ? fjb.y - hyB : fjb.y + hyB;
            return [
              ...head,
              { x: trunkX, y: laneY },
              { x: fjb.x, y: laneY },
              { x: fjb.x, y: edgeY },
            ];
          }
          // Rotated island: descend to the corridor entry end nearest the
          // trunk channel, then follow the corridor line in the island frame
          // to the box (the entry leg may be a world diagonal, matching the
          // rotated LVAC corridor precedent).
          const fl = islToLocalEq(isl, fjb);
          const boxRot = Math.abs(Math.sin(fl.rotation)) > 0.5;
          const hyB = (boxRot ? fl.length : fl.width) / 2;
          const edgeLy = fl.y > 0 ? fl.y - hyB : fl.y + hyB;
          const memberXs = equipment
            .filter(e => /^inv-\d+$/.test(e.id) && rotIslandOfInv.get(e.id) === isl)
            .map(e => islToLocalEq(isl, e).x);
          const loX = Math.min(...memberXs, fl.x), hiX = Math.max(...memberXs, fl.x);
          const endW = islToWorld(isl, { x: loX, y: 0.7 });
          const endE = islToWorld(isl, { x: hiX, y: 0.7 });
          const entry =
            Math.hypot(endW.x - trunkX, endW.y - joinY) <=
            Math.hypot(endE.x - trunkX, endE.y - joinY) ? endW : endE;
          return [
            ...head,
            { x: trunkX, y: entry.y },
            entry,
            islToWorld(isl, { x: fl.x, y: 0.7 }),
            islToWorld(isl, { x: fl.x, y: edgeLy }),
          ];
        };
        const base = ax0 + 2.0 + k * 0.4; // clear of the 6-ct spine at +1.5
        const candidates = [
          base, base + 1.2, base + 2.4,
          ax0 - 0.6 - k * 0.4, ax0 - 1.8 - k * 0.4, ax0 - 3.0 - k * 0.4,
        ].filter(x => chosenXs.every(cx => Math.abs(cx - x) >= 0.3));
        if (!candidates.length) candidates.push(base);
        let bestX = candidates[0];
        let bestPts = buildPts(bestX);
        let bestHits = trunkHits(bestPts);
        for (let ci = 1; ci < candidates.length && bestHits > 0; ci++) {
          const pts = buildPts(candidates[ci]);
          const hits = trunkHits(pts);
          if (hits < bestHits) { bestX = candidates[ci]; bestHits = hits; bestPts = pts; }
        }
        chosenXs.push(bestX);
        if (bestHits > 0) {
          // Keep-and-warn (house rule: never silently ship a compromised
          // route) — every candidate channel crossed equipment, so the
          // least-crossing one is kept and flagged for detailed design.
          warnings.push(
            `Fiber trunk to FJB ${isl.n} crosses ${bestHits} equipment footprint${bestHits === 1 ? '' : 's'} — ` +
            `no clear channel among the candidate offsets; route kept, review the trunk corridor in detailed design.`);
        }
        addRun(`fiber-trunk-${isl.n}`, 'FIBER_TRUNK', bestPts);
      });
    }
  }

  // ---- CATL container comms rings (R-FB-3) ---------------------------------------
  // One 6-ct CATL fiber ring encloses each block's BUILT container cluster,
  // tapped once toward its PCS. Rings hug the cluster at a 1.5 ft standoff
  // and pull individual sides in when another unit shares a tighter aisle.
  // Spatially split associations (traced overflow wiring, QTY4 front/back
  // rows) get one ring per contiguous group, so a ring never reaches across
  // foreign equipment to enclose a far-away container.
  {
    const CATL_STANDOFF = 1.5;
    const CATL_MIN = 0.4;
    const GROUP_GAP = 8; // container rects within this gap share a ring
    const zoneRectsW = reservedZones
      .filter(z => z.kind === 'futureAug')
      .map(z => ({
        x1: z.x - z.length / 2, y1: z.y - z.width / 2,
        x2: z.x + z.length / 2, y2: z.y + z.width / 2,
      }));
    const rectOfL = (e: { x: number; y: number; rotation: number; length: number; width: number }) => {
      const rot = Math.abs(Math.sin(e.rotation)) > 0.5;
      const hx = (rot ? e.width : e.length) / 2, hy = (rot ? e.length : e.width) / 2;
      return { x1: e.x - hx, y1: e.y - hy, x2: e.x + hx, y2: e.y + hy };
    };
    for (const b of blocks) {
      const members = [...b.containers, ...(blockOrphans.get(b.n) ?? [])]
        .filter(c => !c.future);
      if (!members.length) continue;
      const rIsl = rotIslandOfInv.get(b.inv.id);
      const toL = (e: PlacedEquipment) => (rIsl ? islToLocalEq(rIsl, e) : e);
      const toW = (p: Pt) => (rIsl ? islToWorld(rIsl, p) : p);
      const rects = members.map(c => rectOfL(toL(c)));
      // Contiguous groups by rect proximity (union-find in the block frame).
      const groupOf = members.map((_, i) => i);
      const find = (i: number): number =>
        groupOf[i] === i ? i : (groupOf[i] = find(groupOf[i]));
      for (let i = 0; i < rects.length; i++) {
        for (let j = i + 1; j < rects.length; j++) {
          const a = rects[i], r2 = rects[j];
          const near =
            a.x1 <= r2.x2 + GROUP_GAP && r2.x1 <= a.x2 + GROUP_GAP &&
            a.y1 <= r2.y2 + GROUP_GAP && r2.y1 <= a.y2 + GROUP_GAP;
          if (near) groupOf[find(i)] = find(j);
        }
      }
      const groups = new Map<number, number[]>();
      members.forEach((_, i) => {
        const g = find(i);
        groups.set(g, [...(groups.get(g) ?? []), i]);
      });
      // Obstacles in the block frame: every non-member unit + future-aug zones.
      const memberIds = new Set(members.map(m2 => m2.id));
      const obs: { x1: number; y1: number; x2: number; y2: number }[] = [];
      for (const e of equipment) {
        if (memberIds.has(e.id)) continue;
        obs.push(rectOfL(toL(e)));
      }
      for (const z of zoneRectsW) {
        if (!rIsl) { obs.push(z); continue; }
        const th = islAngleRad(rIsl), cz = Math.cos(th), sz = Math.sin(th);
        const cs2 = [
          { x: z.x1, y: z.y1 }, { x: z.x2, y: z.y1 },
          { x: z.x1, y: z.y2 }, { x: z.x2, y: z.y2 },
        ].map(p => {
          const dx = p.x - rIsl.cx!, dy = p.y - rIsl.cy!;
          return { x: dx * cz + dy * sz, y: -dx * sz + dy * cz };
        });
        obs.push({
          x1: Math.min(...cs2.map(p => p.x)), y1: Math.min(...cs2.map(p => p.y)),
          x2: Math.max(...cs2.map(p => p.x)), y2: Math.max(...cs2.map(p => p.y)),
        });
      }
      const groupList = Array.from(groups.values())
        .map((idxs: number[]) => idxs.sort((a, b2) => a - b2));
      groupList.sort((a, b2) => a[0] - b2[0]);
      const invL = toL(b.inv);
      const invRect = rectOfL(invL);
      groupList.forEach((idxs, gi) => {
        let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
        for (const i of idxs) {
          x1 = Math.min(x1, rects[i].x1); y1 = Math.min(y1, rects[i].y1);
          x2 = Math.max(x2, rects[i].x2); y2 = Math.max(y2, rects[i].y2);
        }
        // Per-side standoff, pulled in when an obstacle sits inside the band.
        const offFor = (dir: 1 | -1, axis: 'x' | 'y'): number => {
          let off = CATL_STANDOFF;
          const [sLo, sHi] = axis === 'y'
            ? [x1 - CATL_STANDOFF, x2 + CATL_STANDOFF]
            : [y1 - CATL_STANDOFF, y2 + CATL_STANDOFF];
          const face = axis === 'y' ? (dir > 0 ? y2 : y1) : (dir > 0 ? x2 : x1);
          for (const r of obs) {
            const [oLo, oHi] = axis === 'y' ? [r.x1, r.x2] : [r.y1, r.y2];
            if (oHi < sLo || oLo > sHi) continue;
            const oFace = axis === 'y'
              ? (dir > 0 ? r.y1 : r.y2)
              : (dir > 0 ? r.x1 : r.x2);
            const gap = dir > 0 ? oFace - face : face - oFace;
            if (gap <= 0) continue; // behind/overlapping the cluster — not in the band
            if (gap < off * 2) off = Math.max(CATL_MIN, Math.min(off, gap / 2));
          }
          return off;
        };
        const rx1 = x1 - offFor(-1, 'x'), rx2 = x2 + offFor(1, 'x');
        const ry1 = y1 - offFor(-1, 'y'), ry2 = y2 + offFor(1, 'y');
        const suffix = gi === 0 ? '' : `-${gi + 1}`;
        // Closed loop: pushed directly — addRun's fence detour would tear a
        // ring open, and traced clusters may legitimately sit outside the
        // fence (warn-only, like their placement).
        cables.push({
          id: `catl-ring-${b.n}${suffix}`, class: 'CATL',
          pts: [
            { x: rx1, y: ry1 }, { x: rx2, y: ry1 }, { x: rx2, y: ry2 },
            { x: rx1, y: ry2 }, { x: rx1, y: ry1 },
          ].map(p => toW(p)),
        });
        // Single tap from the PCS face nearest the ring, perpendicular onto
        // the ring edge; falls back to the other axis when the preferred face
        // has no overlap or the leg would cross a member container.
        const ccx = (rx1 + rx2) / 2, ccy = (ry1 + ry2) / 2;
        const tapY = (): [Pt, Pt] | null => {
          const lo = Math.max(invRect.x1 + 0.3, rx1 + 0.3);
          const hi = Math.min(invRect.x2 - 0.3, rx2 - 0.3);
          if (lo > hi) return null;
          const fx = Math.min(hi, Math.max(lo, invL.x));
          const sgn = (Math.sign(ccy - invL.y) || 1);
          const fy0 = sgn > 0 ? invRect.y2 : invRect.y1;
          const cands = [ry1, ry2].filter(v => (v - fy0) * sgn > 0);
          const ty = cands.length
            ? (sgn > 0 ? Math.min(...cands) : Math.max(...cands))
            : (Math.abs(ry1 - fy0) <= Math.abs(ry2 - fy0) ? ry1 : ry2);
          return [{ x: fx, y: fy0 }, { x: fx, y: ty }];
        };
        const tapX = (): [Pt, Pt] | null => {
          const lo = Math.max(invRect.y1 + 0.3, ry1 + 0.3);
          const hi = Math.min(invRect.y2 - 0.3, ry2 - 0.3);
          if (lo > hi) return null;
          const fy = Math.min(hi, Math.max(lo, invL.y));
          const sgn = (Math.sign(ccx - invL.x) || 1);
          const fx0 = sgn > 0 ? invRect.x2 : invRect.x1;
          const cands = [rx1, rx2].filter(v => (v - fx0) * sgn > 0);
          const tx = cands.length
            ? (sgn > 0 ? Math.min(...cands) : Math.max(...cands))
            : (Math.abs(rx1 - fx0) <= Math.abs(rx2 - fx0) ? rx1 : rx2);
          return [{ x: fx0, y: fy }, { x: tx, y: fy }];
        };
        const grpRects = idxs.map(i => rects[i]);
        const crosses = (a: Pt, b3: Pt) => grpRects.some(r => {
          const lo1 = Math.min(a.x, b3.x), hi1 = Math.max(a.x, b3.x);
          const lo2 = Math.min(a.y, b3.y), hi2 = Math.max(a.y, b3.y);
          return hi1 > r.x1 + 0.05 && lo1 < r.x2 - 0.05 &&
                 hi2 > r.y1 + 0.05 && lo2 < r.y2 - 0.05;
        });
        const preferY = Math.abs(ccy - invL.y) >= Math.abs(ccx - invL.x);
        const t1 = preferY ? tapY() : tapX();
        const t2 = preferY ? tapX() : tapY();
        const tap =
          (t1 && !crosses(t1[0], t1[1])) ? t1 :
          (t2 && !crosses(t2[0], t2[1])) ? t2 : (t1 ?? t2);
        if (tap) addRun(`catl-tap-${b.n}${suffix}`, 'CATL', tap.map(p => toW(p)));
      });
    }
  }

  // ---- reference-only augmentation stubs (stop AT the zone edge) --------------
  for (const b of blocks) {
    const z = augmentationZones.find(z2 => z2.id === `aug-${b.n}`);
    if (!z) continue;
    const invRight = b.inv.x + b.inv.length / 2;
    const zoneLeft = z.x - z.length / 2;
    if (zoneLeft - invRight > 0.5) {
      addRun(`dc-aug-${b.n}`, 'DC', [
        { x: invRight, y: b.inv.y },
        { x: zoneLeft, y: b.inv.y },
      ], true);
    }
  }

  // ---- reference-only MV stubs to future BESS augmentation blocks -------------
  // Future blocks (site-level augmentation reserves) will tie into the MV
  // collection when built; a dashed reference-only stub is drawn from the
  // nearest row MV bus to the zone edge (stopping AT the edge — no BOL
  // conduit or cable is installed in reserved areas). Excluded from all
  // cable/conduit quantity summaries via ref=true.
  if (mvBusSegs.length) {
    for (const z of reservedZones) {
      if (z.kind !== 'futureAug') continue;
      const hl = z.length / 2, hw = z.width / 2;
      // Nearest row MV bus (by vertical distance to the zone center)
      const seg = mvBusSegs.reduce((best, s3) =>
        Math.abs(s3.y - z.y) < Math.abs(best.y - z.y) ? s3 : best
      );
      const sy = seg.y;
      let pts: Pt[];
      if (sy <= z.y - hw || sy >= z.y + hw) {
        // Bus clears the zone vertically: run along the bus, then drop/rise
        // to the nearest horizontal edge of the zone.
        const sx = Math.min(seg.maxX, Math.max(seg.minX, z.x));
        const tx = Math.min(z.x + hl - 2, Math.max(z.x - hl + 2, sx));
        const ty = sy <= z.y - hw ? z.y - hw : z.y + hw;
        pts = [{ x: sx, y: sy }, { x: tx, y: sy }, { x: tx, y: ty }];
      } else {
        // Bus height falls inside the zone's vertical span: approach the
        // nearest vertical edge horizontally at bus height. The source must
        // sit strictly OUTSIDE the zone on the bus — never inside it (no BOL
        // conduit inside reserved areas, and the stub must stop AT the edge).
        const leftEdge = z.x - hl, rightEdge = z.x + hl;
        const canLeft = seg.minX <= leftEdge - 0.5;
        const canRight = seg.maxX >= rightEdge + 0.5;
        if (!canLeft && !canRight) {
          warnings.push(
            `Reference MV stub mv-future-${z.id} skipped — the row MV bus lies inside the reserved zone footprint; tie-in shown in detailed design.`
          );
          continue;
        }
        // Prefer the side with the larger bus overhang past the zone edge
        const useLeft = canLeft && (!canRight || (leftEdge - seg.minX) >= (seg.maxX - rightEdge));
        const sx = useLeft
          ? Math.max(seg.minX, leftEdge - 4)
          : Math.min(seg.maxX, rightEdge + 4);
        const tx = useLeft ? leftEdge : rightEdge;
        pts = [{ x: sx, y: sy }, { x: tx, y: sy }];
      }
      // Skip degenerate stubs (bus already touches the zone edge)
      const len = pts.reduce((s3, p, i) =>
        i ? s3 + Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y) : 0, 0);
      if (len < 0.5) continue;
      addRun(`mv-future-${z.id}`, 'MV', pts, true);
    }
  }

  // ---- trench band ---------------------------------------------------------------
  // If the full extent pokes outside the fence (endpoints sit close to the
  // fence line), shrink the band from either end until it fits.
  let trench: TrenchBand | null = null;
  {
    let lo = yBottom;
    // Extra aux endpoints (task 816) tap into the spine column at their own
    // join elevation (topEdge + 4). One placed above the top fiber bus must
    // still ride the trench, so grow the band top to cover its join. No-op for
    // default designs (no extras) and for extras below the yard — byte-identical.
    const extraTopY = [
      ...auxSwgrExtra,
      ...auxXfmrExtra,
      ...(fiberPanel
        ? firePanelExtra
        : [
            ...(firePanel?.id.startsWith('peq-') ? [firePanel] : []),
            ...firePanelExtra,
          ]),
    ]
      .reduce((m, e) => Math.max(m, topEdge(e) + 4), -Infinity);
    let hi = Math.max(topFiberY, extraTopY);
    const bandPts = (a: number, b: number) => [
      { x: spineX! - TRENCH_WIDTH / 2, y: a },
      { x: spineX! + TRENCH_WIDTH / 2, y: a },
      { x: spineX! - TRENCH_WIDTH / 2, y: b },
      { x: spineX! + TRENCH_WIDTH / 2, y: b },
    ];
    let guard = 0;
    while (hi - lo > 10 && !insideFence(bandPts(lo, hi)) && guard < 200) {
      if (!insideFence(bandPts(lo, lo))) lo += 2;
      else hi -= 2;
      guard++;
    }
    if (spineEquipmentClear && hi - lo > 10 && insideFence(bandPts(lo, hi))) {
      trench = { x: spineX!, yBottom: lo, yTop: hi, width: TRENCH_WIDTH, section: 'AUX_FIBER' };
    } else if (spineEquipmentClear) {
      warnings.push('480V aux & fiber trench band would leave the fenced yard — omitted, review in detailed design.');
    }
  }

  if (dcDirectBlocked > 0) {
    warnings.push(`${dcDirectBlocked} DC pair${dcDirectBlocked === 1 ? '' : 's'} kept 90° trench routing — a straight run would cross equipment, the fence, or an underground exclusion area.`);
  }
  const acceptedTracedLvac = new Set(cables
    .filter(c => c.class === 'LVAC' && /^lvac-peq-/.test(c.id))
    .map(c => c.id.slice('lvac-'.length)));
  for (const e of equipment
    .filter(e => e.kind === 'bess' && e.id.startsWith('peq-') &&
      !e.augmented && !e.future)
    .sort((a, b) => a.id.localeCompare(b.id))) {
    if (acceptedTracedLvac.has(e.id)) continue;
    const cableId = `lvac-${e.id}`;
    const dispositionReason = !plannedTracedLvac.has(cableId)
      ? 'was not registered with a normalized visible-yard corridor'
      : !attemptedTracedLvac.has(cableId)
        ? 'had no accepted normalized corridor on which to attempt its tie'
        : 'has no accepted equipment-clear route';
    warnings.push(
      `1 traced container LVAC feed for ${e.id} ${dispositionReason} — omitted; resolve the conflict before issue.`,
    );
  }
  return { cables, trench, corridorTrenches, warnings };
}
