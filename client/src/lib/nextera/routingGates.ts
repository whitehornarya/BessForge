// ---------------------------------------------------------------------------
// Feeder-routing validation gates G-RT-1..G-RT-12 (routing intelligence spec
// §9). PURE verification: the gates never change routing — they re-derive the
// discipline the router promises and surface violations with the stable
// `Routing gate G-RT-<n>:` prefix so the drafter (and the exports) can never
// silently ship a route that broke the rules.
//
// Runs at two points, both through runRoutingGates():
//  - generate time: the store's feeder recompute appends the results to
//    design.warnings (stripping the previous gate batch first);
//  - export time: the control panel re-runs the gates before every plan/
//    package export and raises a toast summary when violations exist.
//
// Severity:
//  - 'error' = a hard reference rule is broken (equipment transit,
//    exclusion-zone cut, corridor-lane breach, bundle crossing, chain cap);
//  - 'warn'  = the plan deviates from the reference pattern in a way that
//    needs an engineer's eye (fence-crossing count, chain shape,
//    ghost placement) but may be legitimate on traced or irregular yards.
// Both surface identically; severity is for triage and tests. Every check
// is defensive: a gate that throws reports itself as a warn instead of
// breaking the recompute.
// ---------------------------------------------------------------------------

import {
  CableClass,
  CorridorTrench,
  IslandInfo,
  PlacedEquipment,
  Pt,
  ReservedZone,
  SiteDesign,
} from './types';
import {
  FeederCircuit,
  MAX_INVERTERS_PER_FEEDER,
  MAX_FUTURE_PCS_PER_FEEDER,
  MAX_TOTAL_PCS_PER_FEEDER,
  FEEDER_TRENCH_SPACING_FT,
  feederCorridorInfo,
} from './feeders';
import { feederDisplayName } from './feederNaming';
import { feederKeepouts, bandCoRunViolations, CrossBand } from './feederKeepouts';
import { AreaZone } from './areaZones';
import { drawnCableClasses, legendCableClasses } from './cableLegendClasses';
// Routing gates audit the same normalized visible equipment geometry used to
// build and display routes. traceSourcePose is immutable normalization input,
// never an alternate routing frame.
import { equipmentForRouting } from './layoutEngine';

export const ROUTING_GATE_PREFIX = 'Routing gate G-RT-';

export interface RoutingGateResult {
  gate: number;                 // 1..12 (0 = the runner itself could not run)
  severity: 'error' | 'warn';
  message: string;              // starts with `Routing gate G-RT-<n>: `
}

export interface RoutingGateContext {
  feeders: FeederCircuit[];
  substation?: Pt | null;
  // Drafter-drawn UNDERGROUND EXCLUSION AREA zones (store-level, not on the
  // design object) — same list the router received.
  exclusionZones?: AreaZone[] | null;
  maxPerFeeder?: number;
}

// --- Tolerances (exported so the tests pin the calibrated values) ----------
export const GATE_SAMPLE_STEP_FT = 2;        // polyline sampling step
export const GATE_EQUIP_SHRINK_FT = 0.75;    // equipment rect inset (G-RT-1)
export const GATE_TERMINAL_RADIUS_FT = 8;    // terminal-stub exemption reach
export const GATE_TRANSIT_CHORD_FT = 2;      // interior chord that counts as a transit
export const GATE_CLUSTER_SHRINK_FT = 1;     // container-cluster bbox inset
export const GATE_CHAIN_COLLINEAR_TOL_FT = 2;
export const GATE_CHAIN_MONOTONE_TOL_FT = 1;
export const GATE_HOME_RUN_LAUNCH_FT = 30;   // home-run start near chain end
// Future PCS contiguity budget in row pitches: the reserve unit sits past
// the strip-end FJB/gear gap, ~3 pitches from the last built PCS.
export const GATE_GHOST_PITCH_FACTOR = 3.5;
export const GATE_MAX_BAND_PASSES = 2;       // same-trench crossing budget

// ---------------------------------------------------------------------------
// Local geometry helpers (oriented rects in their own frame).
// ---------------------------------------------------------------------------

interface Obb {
  cx: number; cy: number;
  cos: number; sin: number;
  hl: number; hw: number;      // half length (local x) / half width (local y)
}

const mkObb = (cx: number, cy: number, angRad: number, hl: number, hw: number): Obb =>
  ({ cx, cy, cos: Math.cos(angRad), sin: Math.sin(angRad), hl, hw });

const toLocal = (p: Pt, o: Obb): Pt => {
  const dx = p.x - o.cx, dy = p.y - o.cy;
  return { x: dx * o.cos + dy * o.sin, y: -dx * o.sin + dy * o.cos };
};

const pointInObb = (p: Pt, o: Obb, grow = 0): boolean => {
  const l = toLocal(p, o);
  return Math.abs(l.x) <= o.hl + grow && Math.abs(l.y) <= o.hw + grow;
};

const obbCorners = (o: Obb): Pt[] => {
  const out: Pt[] = [];
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
    const lx = sx * o.hl, ly = sy * o.hw;
    out.push({ x: o.cx + lx * o.cos - ly * o.sin, y: o.cy + lx * o.sin + ly * o.cos });
  }
  return out;
};

const obbBounds = (o: Obb) => {
  const cs = obbCorners(o);
  return {
    minX: Math.min(...cs.map(c => c.x)), maxX: Math.max(...cs.map(c => c.x)),
    minY: Math.min(...cs.map(c => c.y)), maxY: Math.max(...cs.map(c => c.y)),
  };
};

// Total interior chord length of a polyline inside an oriented rect
// (Liang–Barsky per segment in the rect's local frame).
function chordInObb(pts: Pt[], o: Obb): number {
  let total = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = toLocal(pts[i - 1], o), b = toLocal(pts[i], o);
    const dx = b.x - a.x, dy = b.y - a.y;
    let t0 = 0, t1 = 1, ok = true;
    const pk = [-dx, dx, -dy, dy];
    const qk = [a.x + o.hl, o.hl - a.x, a.y + o.hw, o.hw - a.y];
    for (let k = 0; k < 4 && ok; k++) {
      if (Math.abs(pk[k]) < 1e-12) { if (qk[k] < 0) ok = false; }
      else {
        const t = qk[k] / pk[k];
        if (pk[k] < 0) { if (t > t0) t0 = t; } else { if (t < t1) t1 = t; }
      }
    }
    if (ok && t1 > t0) total += (t1 - t0) * Math.hypot(dx, dy);
  }
  return total;
}

// Separating-axis overlap test for two oriented rects.
function obbsOverlap(a: Obb, b: Obb): boolean {
  const separated = (o: Obb, other: Obb): boolean => {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const c of obbCorners(other)) {
      const l = toLocal(c, o);
      if (l.x < minX) minX = l.x;
      if (l.x > maxX) maxX = l.x;
      if (l.y < minY) minY = l.y;
      if (l.y > maxY) maxY = l.y;
    }
    return maxX < -o.hl || minX > o.hl || maxY < -o.hw || minY > o.hw;
  };
  return !separated(a, b) && !separated(b, a);
}

// Points along a polyline every `step` ft (vertices included).
function samplePolyline(pts: Pt[], step: number): Pt[] {
  const out: Pt[] = [];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const n = Math.max(1, Math.ceil(len / step));
    for (let k = 0; k < n; k++) {
      out.push({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n });
    }
  }
  if (pts.length) out.push(pts[pts.length - 1]);
  return out;
}

// Proper segment × segment intersection point (open interiors), or null.
function segCross(a: Pt, b: Pt, c: Pt, d: Pt): Pt | null {
  const rx = b.x - a.x, ry = b.y - a.y, sx = d.x - c.x, sy = d.y - c.y;
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-12) return null;
  const t = ((c.x - a.x) * sy - (c.y - a.y) * sx) / den;
  const u = ((c.x - a.x) * ry - (c.y - a.y) * rx) / den;
  const EPS = 1e-6;
  if (t <= EPS || t >= 1 - EPS || u <= EPS || u >= 1 - EPS) return null;
  return { x: a.x + t * rx, y: a.y + t * ry };
}

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

// ---------------------------------------------------------------------------
// Shared per-run context.
// ---------------------------------------------------------------------------

interface NamedPolyline {
  label: string;
  pts: Pt[];
  kind: 'cable' | 'feeder' | 'aux';
  cls?: CableClass;
  bounds: { minX: number; maxX: number; minY: number; maxY: number };
}

const polyBounds = (pts: Pt[]) => ({
  minX: Math.min(...pts.map(p => p.x)), maxX: Math.max(...pts.map(p => p.x)),
  minY: Math.min(...pts.map(p => p.y)), maxY: Math.max(...pts.map(p => p.y)),
});

interface LocalBox { minX: number; maxX: number; minY: number; maxY: number }

interface IslandFrame {
  isl: IslandInfo;
  ang: number;               // radians, world rotation of the strip
  center: Pt;
  frame: Obb;                // unit frame at center (hl/hw unused for boxes)
  containers: PlacedEquipment[];
  containerBox: LocalBox | null;                 // all containers, local frame
  clusters: { side: 'south' | 'north'; box: LocalBox }[]; // per-side boxes
}

const blockNs = (pcsIds: string[]): Set<string> => {
  const out = new Set<string>();
  for (const id of pcsIds) {
    const m = /^inv-(\d+)$/.exec(id);
    if (m) out.add(m[1]);
  }
  return out;
};

function equipCorners(e: PlacedEquipment): Pt[] {
  const o = mkObb(e.x, e.y, e.rotation, e.length / 2, e.width / 2);
  return obbCorners(o);
}

function localBoxOf(items: PlacedEquipment[], frame: Obb): LocalBox | null {
  if (!items.length) return null;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const e of items) {
    for (const c of equipCorners(e)) {
      const l = toLocal(c, frame);
      if (l.x < minX) minX = l.x;
      if (l.x > maxX) maxX = l.x;
      if (l.y < minY) minY = l.y;
      if (l.y > maxY) maxY = l.y;
    }
  }
  return { minX, maxX, minY, maxY };
}

const inLocalBox = (l: Pt, b: LocalBox, shrink: number): boolean =>
  l.x > b.minX + shrink && l.x < b.maxX - shrink &&
  l.y > b.minY + shrink && l.y < b.maxY - shrink;

function buildIslandFrames(design: SiteDesign): IslandFrame[] {
  const out: IslandFrame[] = [];
  for (const isl of design.islands ?? []) {
    const ang = ((isl.angleDeg ?? (isl.vertical ? 90 : 0)) * Math.PI) / 180;
    const center: Pt =
      Number.isFinite(isl.cx) && Number.isFinite(isl.cy)
        ? { x: isl.cx!, y: isl.cy! }
        : isl.vertical
          ? { x: isl.y, y: (isl.minX + isl.maxX) / 2 }
          : { x: (isl.minX + isl.maxX) / 2, y: isl.y };
    const frame = mkObb(center.x, center.y, ang, 1, 1);
    const ns = blockNs(isl.inverterIds);
    const containers = design.equipment.filter(e => {
      if (e.kind !== 'bess') return false;
      const m = /^bess-(\d+)-/.exec(e.id);
      return !!m && ns.has(m[1]);
    });
    const southNs = blockNs(isl.southIds);
    const northNs = blockNs(isl.northIds);
    const sideOf = (e: PlacedEquipment): 'south' | 'north' | null => {
      const m = /^bess-(\d+)-/.exec(e.id);
      if (!m) return null;
      if (southNs.has(m[1])) return 'south';
      if (northNs.has(m[1])) return 'north';
      return null;
    };
    // Per-side cluster boxes split at real gaps (the mid-island gear gap is
    // a sanctioned crossing channel — one bbox per side would swallow it and
    // flag the aux tap that legally turns in there).
    const clusters: IslandFrame['clusters'] = [];
    for (const side of ['south', 'north'] as const) {
      const sideContainers = containers.filter(e => sideOf(e) === side);
      if (!sideContainers.length) continue;
      const spans = sideContainers
        .map(e => {
          let lo = Infinity, hi = -Infinity;
          for (const c of equipCorners(e)) {
            const l = toLocal(c, frame);
            if (l.x < lo) lo = l.x;
            if (l.x > hi) hi = l.x;
          }
          return { e, lo, hi };
        })
        .sort((a, b) => a.lo - b.lo);
      let group: PlacedEquipment[] = [];
      let groupHi = -Infinity;
      const flush = () => {
        const box = localBoxOf(group, frame);
        if (box) clusters.push({ side, box });
        group = [];
      };
      for (const s of spans) {
        if (group.length && s.lo - groupHi > 12) flush();
        group.push(s.e);
        groupHi = Math.max(groupHi, s.hi);
      }
      if (group.length) flush();
    }
    out.push({
      isl, ang, center, frame, containers,
      containerBox: localBoxOf(containers, frame),
      clusters,
    });
  }
  return out;
}

// Oriented rect of a corridor trench band (legacy AABB shapes included;
// `vertical` bands use the axis-swapped semantics: y = centerline X,
// minX/maxX = extents along Y).
function corridorObb(ct: CorridorTrench): Obb | null {
  if (!Number.isFinite(ct.width) || ct.width <= 0) return null;
  if (Number.isFinite(ct.cx) && Number.isFinite(ct.cy) &&
      Number.isFinite(ct.angleDeg) && Number.isFinite(ct.length) && (ct.length ?? 0) > 0) {
    return mkObb(ct.cx!, ct.cy!, (ct.angleDeg! * Math.PI) / 180, ct.length! / 2, ct.width / 2);
  }
  if (!Number.isFinite(ct.y) || !Number.isFinite(ct.minX) ||
      !Number.isFinite(ct.maxX) || ct.maxX <= ct.minX) return null;
  if (ct.vertical) {
    return mkObb(ct.y, (ct.minX + ct.maxX) / 2, Math.PI / 2, (ct.maxX - ct.minX) / 2, ct.width / 2);
  }
  return mkObb((ct.minX + ct.maxX) / 2, ct.y, 0, (ct.maxX - ct.minX) / 2, ct.width / 2);
}

// Perpendicular passes of a polyline through an axis-aligned band rect:
// count of outside→inside transitions along the densified polyline.
function bandPasses(pts: Pt[], rect: { x1: number; y1: number; x2: number; y2: number }): number {
  const samples = samplePolyline(pts, 1);
  let passes = 0;
  let prevIn = false;
  for (const p of samples) {
    const inside = p.x > rect.x1 + 1e-6 && p.x < rect.x2 - 1e-6 &&
                   p.y > rect.y1 + 1e-6 && p.y < rect.y2 - 1e-6;
    if (inside && !prevIn) passes++;
    prevIn = inside;
  }
  return passes;
}

// Exported for the test goldens (G-RT-11): per feeder × crossable trench
// band, how many separate passes the routed circuit makes through the band.
export function feederTrenchPassCounts(
  design: SiteDesign,
  feeders: FeederCircuit[]
): { feeder: string; bandIndex: number; passes: number }[] {
  const cross = feederKeepouts(design).cross;
  const out: { feeder: string; bandIndex: number; passes: number }[] = [];
  for (const f of feeders) {
    cross.forEach((band, bandIndex) => {
      let passes = 0;
      for (const seg of f.segments) passes += bandPasses(seg.pts, band.rect);
      if (passes > 0) out.push({ feeder: feederDisplayName(f), bandIndex, passes });
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The gate runner.
// ---------------------------------------------------------------------------

export function runRoutingGates(design: SiteDesign, ctx: RoutingGateContext): RoutingGateResult[] {
  // TOTAL by construction. Each gate body already degrades to a prefixed
  // warn via guarded(), but the SHARED setup below (equipment/cable walks,
  // island frames, feeder polylines) runs before any guard. The store calls
  // this uncaught inside routeFeedersInto — a throw there would abort feeder
  // recomputation — and the export path catches broadly, which would lose
  // the summary silently. So a corrupt or partial design degrades to one
  // visible G-RT-0 warning instead of ever throwing out.
  try {
    return runRoutingGatesInner(
      { ...design, equipment: equipmentForRouting(design.equipment) }, ctx);
  } catch (e) {
    return [{
      gate: 0,
      severity: 'warn',
      message: `${ROUTING_GATE_PREFIX}0: verification could not run ` +
        `(${e instanceof Error ? e.message : String(e)})`,
    }];
  }
}

function runRoutingGatesInner(design: SiteDesign, ctx: RoutingGateContext): RoutingGateResult[] {
  const results: RoutingGateResult[] = [];
  const emit = (gate: number, severity: 'error' | 'warn', details: string[], capN = 3) => {
    const unique = Array.from(new Set(details));
    if (!unique.length) return;
    const pre = `${ROUTING_GATE_PREFIX}${gate}: `;
    const list = unique.length > capN + 1
      ? [...unique.slice(0, capN), `...and ${unique.length - capN} more`]
      : unique;
    for (const d of list) results.push({ gate, severity, message: pre + d });
  };
  const guarded = (gate: number, fn: () => void) => {
    try { fn(); } catch (e) {
      emit(gate, 'warn', [`check failed (${e instanceof Error ? e.message : String(e)})`]);
    }
  };

  const feeders = ctx.feeders ?? [];
  const maxPer = ctx.maxPerFeeder && ctx.maxPerFeeder >= 1
    ? Math.min(Math.floor(ctx.maxPerFeeder), MAX_INVERTERS_PER_FEEDER)
    : MAX_INVERTERS_PER_FEEDER;
  const builtInverters = design.equipment.filter(
    e => e.kind === 'inverter' && !e.augmented && !e.future);
  const invById = new Map(builtInverters.map(e => [e.id, e]));
  const islandFrames = buildIslandFrames(design);
  const hasIslands = islandFrames.length > 0;
  const aux = design.auxFeeder ?? null;
  // Comb-discipline gates (4, 8, 11) verify promises only the comb router
  // makes: cross bands are crossed-never-ridden, the substation-corridor
  // bundle is crossing-free, and each band is passed at most twice. Traced
  // yards (tracedPcsUnits > 0 — same marker the router itself keys on) route
  // with the corridor-tree/grid router, which promises obstacle avoidance
  // but NOT band/corridor discipline: its legs legitimately follow the very
  // row corridors the bands mark, so those gates would flag every healthy
  // traced route. They apply to comb-routed yards only.
  const combRouted = (design.tracedPcsUnits ?? 0) === 0;

  // Routed polylines by role. Reference-only runs (ref: true) are exempt from
  // every transit gate — they are drawing annotations, not built trenches.
  const feederLines: NamedPolyline[] = [];
  for (const f of feeders) {
    const name = `feeder #${feederDisplayName(f)}`;
    for (let si = 0; si < f.segments.length; si++) {
      const seg = f.segments[si];
      if (seg.pts.length >= 2) {
        const role = si === f.segments.length - 1
          ? 'home run'
          : `row trunk section ${si + 1}`;
        feederLines.push({
          label: `${name} ${role}`, pts: seg.pts, kind: 'feeder', bounds: polyBounds(seg.pts),
        });
      }
    }
  }
  const auxLines: NamedPolyline[] = (aux?.legs ?? [])
    .filter(l => l.pts.length >= 2)
    .map((l, i) => ({
      label: `aux feeder leg ${i + 1}`, pts: l.pts, kind: 'aux' as const, bounds: polyBounds(l.pts),
    }));
  const cableLines: NamedPolyline[] = design.cables
    .filter(c => !c.ref && c.pts.length >= 2)
    .map(c => ({
      label: `${c.class} run ${c.id}`, pts: c.pts, kind: 'cable' as const,
      cls: c.class, bounds: polyBounds(c.pts),
    }));

  // --- G-RT-1: no routed run transits an equipment footprint ---------------
  // Manholes/vaults are cable access points and feeder junction boxes are
  // pass-through boxes (comms terminate in them, the corridor 480V/fiber
  // runs route straight through) — both are exempt by design.
  guarded(1, () => {
    const obstacles = design.equipment
      .filter(e => e.kind !== 'manhole' && e.kind !== 'feederJunctionBox' &&
                   e.length > 0 && e.width > 0)
      .map(e => ({
        e,
        obb: mkObb(e.x, e.y, e.rotation,
          Math.max(0.1, e.length / 2 - GATE_EQUIP_SHRINK_FT),
          Math.max(0.1, e.width / 2 - GATE_EQUIP_SHRINK_FT)),
        bounds: obbBounds(mkObb(e.x, e.y, e.rotation, e.length / 2, e.width / 2)),
      }));
    const errs: string[] = [];
    const warns: string[] = [];
    const lines = [...cableLines, ...feederLines, ...auxLines];
    for (const line of lines) {
      for (const ob of obstacles) {
        const M = GATE_TERMINAL_RADIUS_FT;
        if (line.bounds.maxX < ob.bounds.minX - M || line.bounds.minX > ob.bounds.maxX + M ||
            line.bounds.maxY < ob.bounds.minY - M || line.bounds.minY > ob.bounds.maxY + M) continue;
        // Terminal-stub exemption: a run that STARTS or ENDS at this unit may
        // enter its footprint to land on the terminal — but only the
        // contiguous landing stub at that end is exempt. Trimming the stub
        // (instead of skipping the whole polyline) keeps a mid-route transit
        // of the SAME unit visible: landing on a unit must not immunize
        // crossing it elsewhere.
        const p0 = line.pts[0], pn = line.pts[line.pts.length - 1];
        const landReach = GATE_EQUIP_SHRINK_FT + GATE_TERMINAL_RADIUS_FT;
        const land0 = pointInObb(p0, ob.obb, landReach);
        const landN = pointInObb(pn, ob.obb, landReach);
        let runPts = line.pts;
        if (land0 || landN) {
          const s = samplePolyline(line.pts, GATE_SAMPLE_STEP_FT);
          let i0 = 0, i1 = s.length;
          if (land0) while (i0 < i1 && pointInObb(s[i0], ob.obb, landReach)) i0++;
          if (landN) while (i1 > i0 && pointInObb(s[i1 - 1], ob.obb, landReach)) i1--;
          if (i1 - i0 < 2) continue; // the whole run is landing stub
          runPts = s.slice(i0, i1);
        }
        const chord = chordInObb(runPts, ob.obb);
        if (chord > GATE_TRANSIT_CHORD_FT) {
          const msg = `${line.label} passes through ${ob.e.label || ob.e.id} ` +
            `(${chord.toFixed(1)} ft inside its footprint)`;
          if (ob.e.id.startsWith('peq-')) warns.push(msg); else errs.push(msg);
        }
      }
    }
    emit(1, 'error', errs);
    emit(1, 'warn', warns);
  });

  // --- G-RT-2: MV/aux trenches keep out of exclusion + future-aug zones ----
  // Drafter-drawn UNDERGROUND EXCLUSION AREAs bind every 34.5 kV trench.
  // Future-augmentation reserves bind the MV home runs only: the aux daisy
  // chain enters each island through the strip-end corridor gap, which the
  // island's end aug reserve straddles by design.
  guarded(2, () => {
    const exclusion: { label: string; obb: Obb }[] = [];
    for (const z of ctx.exclusionZones ?? []) {
      if (z.kind !== 'exclusion') continue;
      exclusion.push({
        label: 'UNDERGROUND EXCLUSION AREA',
        obb: mkObb(z.x, z.y, 0, z.lengthFt / 2, z.widthFt / 2),
      });
    }
    const futureAug: { label: string; obb: Obb }[] = [];
    for (const z of design.reservedZones ?? []) {
      if (z.kind !== 'futureAug') continue;
      futureAug.push({
        label: z.label || 'future augmentation reserve',
        obb: mkObb(z.x, z.y, ((z.angleDeg ?? 0) * Math.PI) / 180, z.length / 2, z.width / 2),
      });
    }
    const details: string[] = [];
    const check = (line: NamedPolyline, zones: { label: string; obb: Obb }[]) => {
      const samples = samplePolyline(line.pts, GATE_SAMPLE_STEP_FT);
      for (const z of zones) {
        if (samples.some(p => pointInObb(p, z.obb, -0.25))) {
          details.push(`${line.label} cuts through the ${z.label}`);
          return;
        }
      }
    };
    for (const line of feederLines) check(line, [...exclusion, ...futureAug]);
    for (const line of auxLines) check(line, exclusion);
    emit(2, 'error', details);
  });

  // --- G-RT-3: MV home runs stay out of every container cluster ------------
  // The island-wide container bbox covers the battery rows AND the center
  // aux corridor between them: an MV feeder may ride the PCS-row lanes just
  // outside it, but never the island interior.
  guarded(3, () => {
    if (!hasIslands) return;
    const details: string[] = [];
    for (const line of feederLines) {
      for (const fr of islandFrames) {
        if (!fr.containerBox) continue;
        const samples = samplePolyline(line.pts, GATE_SAMPLE_STEP_FT);
        if (samples.some(p => inLocalBox(toLocal(p, fr.frame), fr.containerBox!, GATE_CLUSTER_SHRINK_FT))) {
          details.push(`${line.label} enters the container cluster of island ${fr.isl.n}`);
          break;
        }
      }
    }
    emit(3, 'error', details);
  });

  // --- G-RT-4: crossing-only trench bands are crossed, never ridden --------
  guarded(4, () => {
    if (!combRouted) return; // comb promise only — see combRouted above
    const cross = feederKeepouts(design).cross;
    if (!cross.length) return;
    const details: string[] = [];
    const seen = new Set<string>();
    // MV feeder lines ONLY: the aux daisy-chain legitimately rides row
    // corridors — its stops (aux transformers) live in the very gear gaps
    // and island corridors the cross bands mark.
    for (const line of feederLines) {
      const v = bandCoRunViolations(line.pts, cross);
      if (v > 0 && !seen.has(line.label)) {
        seen.add(line.label);
        details.push(`${line.label} rides along or turns inside a crossing-only trench band (${v} violation${v > 1 ? 's' : ''})`);
      }
    }
    emit(4, 'error', details);
  });

  // --- G-RT-5: chain composition and shape ----------------------------------
  guarded(5, () => {
    const errs: string[] = [];
    const warns: string[] = [];
    for (const f of feeders) {
      const name = `feeder #${feederDisplayName(f)}`;
      const n = f.inverterIds.length;
      if (f.routeValid === false) {
        const why = f.routeDiagnostics?.length
          ? f.routeDiagnostics.join('; ')
          : 'generated geometry did not pass final route acceptance';
        errs.push(`${name} route is omitted (failed closed: ${why})`);
      }
      if (n < 1) errs.push(`${name} serves no PCS`);
      if (n > MAX_INVERTERS_PER_FEEDER) {
        errs.push(`${name} serves ${n} built PCS (hard cap ${MAX_INVERTERS_PER_FEEDER})`);
      }
      const futurePcs = Math.max(0, f.futurePcs || 0);
      if (n + futurePcs > MAX_TOTAL_PCS_PER_FEEDER) {
        errs.push(`${name} carries ${n} built + ${futurePcs} future PCS ` +
          `(EOL cap ${MAX_TOTAL_PCS_PER_FEEDER})`);
      }
      const members = f.inverterIds
        .map(id => invById.get(id))
        .filter((e): e is PlacedEquipment => !!e);
      if (members.length >= 2) {
        // Row axis from the farthest member pair (orientation-agnostic).
        let ai = 0, bi = 1, best = -1;
        for (let i = 0; i < members.length; i++) {
          for (let j = i + 1; j < members.length; j++) {
            const d = dist(members[i], members[j]);
            if (d > best) { best = d; ai = i; bi = j; }
          }
        }
        const a = members[ai], b = members[bi];
        const len = Math.max(1e-6, dist(a, b));
        const ux = (b.x - a.x) / len, uy = (b.y - a.y) / len;
        let maxPerp = 0;
        for (const m of members) {
          const perp = Math.abs(-(m.x - a.x) * uy + (m.y - a.y) * ux);
          if (perp > maxPerp) maxPerp = perp;
        }
        if (maxPerp > GATE_CHAIN_COLLINEAR_TOL_FT) {
          warns.push(`${name} chain is not a single PCS row (max offset ${maxPerp.toFixed(1)} ft)`);
        }
        // Chain order walks the row monotonically end-to-end.
        const along = f.inverterIds.map(id => {
          const m = invById.get(id);
          return m ? (m.x - a.x) * ux + (m.y - a.y) * uy : null;
        });
        let dir = 0, monotone = true;
        for (let i = 1; i < along.length && monotone; i++) {
          const p = along[i - 1], q = along[i];
          if (p == null || q == null) continue;
          const step = q - p;
          if (Math.abs(step) <= GATE_CHAIN_MONOTONE_TOL_FT) continue;
          const s = Math.sign(step);
          if (dir === 0) dir = s;
          else if (s !== dir) monotone = false;
        }
        if (!monotone) warns.push(`${name} chain order jumps back and forth along its row`);

        // Explicit row-trunk grammar: a collinear PCS row has exactly N-1
        // internal sections; every section is one straight span, all spans
        // share one axis, and adjacent spans meet at the same tap node. The
        // PCS-to-trunk drops live in design.cables as mv-drop-<PCS id>.
        if (maxPerp <= GATE_CHAIN_COLLINEAR_TOL_FT && f.routeValid !== false) {
          const hops = f.segments.slice(0, -1);
          if (hops.length !== Math.max(0, n - 1)) {
            errs.push(`${name} row trunk has ${hops.length} sections (expected ${Math.max(0, n - 1)})`);
          } else if (hops.length) {
            const trunkPts = hops.flatMap(h => h.pts);
            const h0 = hops[0];
            const p0 = h0.pts[0], p1 = h0.pts[h0.pts.length - 1];
            const trunkLen = p0 && p1 ? dist(p0, p1) : 0;
            let grammarBad = '';
            if (hops.some(h => h.pts.length !== 2)) {
              grammarBad = 'contains an elbow/zigzag instead of straight row spans';
            } else if (trunkLen < 1e-6) {
              grammarBad = 'starts with a zero-length row span';
            } else {
              const tx = (p1.x - p0.x) / trunkLen, ty = (p1.y - p0.y) / trunkLen;
              const off = trunkPts.reduce((m, p) =>
                Math.max(m, Math.abs(-(p.x - p0.x) * ty + (p.y - p0.y) * tx)), 0);
              if (off > 0.25) grammarBad = `spans leave the common row axis by ${off.toFixed(1)} ft`;
              for (let i = 1; i < hops.length && !grammarBad; i++) {
                const prev = hops[i - 1].pts[hops[i - 1].pts.length - 1];
                const next = hops[i].pts[0];
                if (dist(prev, next) > 0.1) grammarBad = `has a break before section ${i + 1}`;
              }
            }
            if (grammarBad) errs.push(`${name} row trunk ${grammarBad}`);

            const drops = new Map(
              design.cables
                .filter(c => c.class === 'MV' && c.id.startsWith('mv-drop-') && c.pts.length >= 2)
                .map(c => [c.id.slice('mv-drop-'.length), c] as const));
            if (drops.size) {
              for (const id of f.inverterIds) {
                const drop = drops.get(id);
                if (!drop) {
                  errs.push(`${name} has no canonical MV drop for ${id}`);
                  continue;
                }
                const q = drop.pts[drop.pts.length - 1];
                const dLine = trunkLen > 1e-6
                  ? Math.abs(-(q.x - p0.x) * (p1.y - p0.y) / trunkLen +
                             (q.y - p0.y) * (p1.x - p0.x) / trunkLen)
                  : Infinity;
                if (dLine > 0.25) {
                  errs.push(`${name} MV drop ${id} misses its row trunk by ${dLine.toFixed(1)} ft`);
                }
              }
            }
          }
        }
      }
      // Home run launches from the chain end.
      if (members.length && f.segments.length) {
        const start = f.segments[f.segments.length - 1].pts[0];
        const end = f.segments[f.segments.length - 1].pts.at(-1);
        if (ctx.substation && (!end || dist(end, ctx.substation) > 0.1)) {
          errs.push(`${name} home run does not terminate at the substation`);
        }
        const ends = [members[0], members[members.length - 1]];
        const d = start ? Math.min(...ends.map(e => dist(start, e))) : Infinity;
        if (d > GATE_HOME_RUN_LAUNCH_FT) {
          warns.push(`${name} home run launches ${d.toFixed(0)} ft from its chain end ` +
            `(expected within ${GATE_HOME_RUN_LAUNCH_FT} ft)`);
        }
      }
    }
    emit(5, 'error', errs);
    emit(5, 'warn', warns);
  });

  // --- G-RT-6: future augmentation PCS sit in their reserve ----------------
  guarded(6, () => {
    const ghosts = [
      ...(design.futureEquipment ?? []).filter(e => e.kind === 'inverter'),
      ...design.equipment.filter(e => e.kind === 'inverter' && (e.augmented || e.future)),
    ];
    const warns: string[] = [];
    for (const f of feeders) {
      const futurePcs = Math.max(0, f.futurePcs || 0);
      if (futurePcs > MAX_FUTURE_PCS_PER_FEEDER) {
        warns.push(`feeder #${feederDisplayName(f)} reserves ${futurePcs} future PCS ` +
          `(standard ${MAX_FUTURE_PCS_PER_FEEDER} per feeder)`);
      }
    }
    if (ghosts.length) {
      const augZones = (design.reservedZones ?? []).filter((z: ReservedZone) => z.kind === 'futureAug')
        .map(z => mkObb(z.x, z.y, ((z.angleDeg ?? 0) * Math.PI) / 180, z.length / 2, z.width / 2));
      let pitch = 40;
      if (builtInverters.length >= 2) {
        let best = Infinity;
        for (let i = 0; i < builtInverters.length; i++) {
          for (let j = i + 1; j < builtInverters.length; j++) {
            const d = dist(builtInverters[i], builtInverters[j]);
            if (d > 1 && d < best) best = d;
          }
        }
        if (Number.isFinite(best)) pitch = Math.max(10, best);
      }
      for (const g of ghosts) {
        const label = g.label || g.id;
        if (augZones.length && !augZones.some(z => pointInObb(g, z, 1))) {
          warns.push(`future PCS ${label} sits outside every future-augmentation reserve zone`);
        }
        if (builtInverters.length) {
          const d = Math.min(...builtInverters.map(b => dist(g, b)));
          if (d > GATE_GHOST_PITCH_FACTOR * pitch) {
            warns.push(`future PCS ${label} is ${d.toFixed(0)} ft from the nearest built PCS ` +
              `(expected a contiguous row-end slot)`);
          }
        }
      }
    }
    emit(6, 'warn', warns);
  });

  // --- G-RT-7: each circuit crosses the fence exactly once -----------------
  // Count only. Crossing ANGLE is deliberately unchecked: the router promises
  // the corridor/climb geometry, not perpendicular fence incidence — on real
  // parcels the fence edge at the exit is often diagonal (e.g. Hondo), so an
  // angle warn would flag every healthy route on irregular boundaries.
  guarded(7, () => {
    const fence = design.fence ?? [];
    if (fence.length < 3) return;
    const warns: string[] = [];
    const insideFence = (p: Pt): boolean => {
      let inside = false;
      for (let i = 0, j = fence.length - 1; i < fence.length; j = i++) {
        const a = fence[i], b = fence[j];
        if (((a.y > p.y) !== (b.y > p.y)) &&
            p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) {
          inside = !inside;
        }
      }
      return inside;
    };
    const crossingsOf = (lines: { pts: Pt[] }[]): Pt[] => {
      const hits: Pt[] = [];
      for (const line of lines) {
        for (let i = 1; i < line.pts.length; i++) {
          const a = line.pts[i - 1], b = line.pts[i];
          // A comb commonly turns exactly ON the fence. segCross deliberately
          // excludes segment endpoints, so count the inside/outside state
          // transition as the crossing and dedupe the adjacent turn leg.
          if (insideFence(a) !== insideFence(b)) {
            const hit = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
            if (!hits.some(h => dist(h, hit) < 2)) hits.push(hit);
            continue;
          }
          for (let j = 0; j < fence.length; j++) {
            const c = fence[j], d = fence[(j + 1) % fence.length];
            const hit = segCross(a, b, c, d);
            if (!hit) continue;
            if (hits.some(h => dist(h, hit) < 2)) continue;
            hits.push(hit);
          }
        }
      }
      return hits;
    };
    for (const f of feeders) {
      const name = `feeder #${feederDisplayName(f)}`;
      const lines = feederLines.filter(l => l.label.startsWith(`${name} `));
      // Feeder circuits now join the canonical mv-drop endpoint instead of
      // re-drawing the PCS connection. That endpoint may already sit outside
      // the fence, so count the launch PCS's canonical drop as part of the
      // same physical circuit or a healthy route appears to cross zero times.
      const launchId = f.inverterIds[f.inverterIds.length - 1];
      const launchDrop = (design.cables ?? []).find(r => r.id === `mv-drop-${launchId}`);
      const launch = invById.get(launchId);
      const launchPts = launchDrop?.pts?.length
        ? (launch
            ? [{ x: launch.x, y: launch.y }, ...launchDrop.pts]
            : launchDrop.pts)
        : [];
      const completeLines = launchPts.length
        ? [{ label: name, pts: launchPts }, ...lines]
        : lines;
      const hits = crossingsOf(completeLines);
      if (hits.length !== 1) {
        warns.push(`${name} crosses the fence ${hits.length} times (expected exactly once)`);
      }
    }
    if (auxLines.length) {
      const hits = crossingsOf(auxLines);
      if (hits.length !== 1) {
        warns.push(`aux feeder crosses the fence ${hits.length} times (expected exactly once)`);
      }
    }
    emit(7, 'warn', warns);
  });

  // --- G-RT-8: the substation bundle corridor is crossing-free -------------
  guarded(8, () => {
    if (!combRouted) return; // comb promise only — see combRouted above
    const substation = ctx.substation;
    if (!substation || feeders.length < 2) return;
    const info = feederCorridorInfo(design, substation, maxPer);
    if (!info) return;
    // Strictly INSIDE the parallel-lane corridor: the window is inset from
    // the climb line and the substation approach so the sanctioned climb
    // sweeps (runs moving onto their lanes) and the terminal convergence
    // never count as bundle crossings.
    const lo = Math.min(info.spanLo, info.spanHi) + 2;
    const hi = Math.max(info.spanLo, info.spanHi) - 2;
    if (hi <= lo) return;
    // The crossing-free promise binds the final LANE BAND only: outside it,
    // outer highway rides legally cross other runs' lane-transfer jogs
    // (nested comb climbs). A hit counts only inside the band.
    const perpLo = info.autoCenter - info.halfBand - 5;
    const perpHi = info.autoCenter + info.halfBand + 5;
    const coord = (p: Pt) => (info.horiz ? p.x : p.y);
    const clip = (pts: Pt[]): Pt[][] => {
      const out: Pt[][] = [];
      let cur: Pt[] = [];
      const push = (p: Pt) => {
        if (!cur.length || dist(cur[cur.length - 1], p) > 1e-9) cur.push(p);
      };
      for (let i = 1; i < pts.length; i++) {
        let a = pts[i - 1], b = pts[i];
        let ca = coord(a), cb = coord(b);
        if ((ca < lo && cb < lo) || (ca > hi && cb > hi)) {
          if (cur.length > 1) out.push(cur);
          cur = [];
          continue;
        }
        const lerp = (t: number): Pt => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
        const span = cb - ca;
        let t0 = 0, t1 = 1;
        if (Math.abs(span) > 1e-12) {
          const tLo = (lo - ca) / span, tHi = (hi - ca) / span;
          t0 = Math.max(0, Math.min(tLo, tHi));
          t1 = Math.min(1, Math.max(tLo, tHi));
        }
        if (t1 <= t0) { if (cur.length > 1) out.push(cur); cur = []; continue; }
        if (t0 > 0) { if (cur.length > 1) out.push(cur); cur = []; push(lerp(t0)); }
        else push(a);
        push(lerp(t1));
        if (t1 < 1) { if (cur.length > 1) out.push(cur); cur = []; }
      }
      if (cur.length > 1) out.push(cur);
      return out;
    };
    const homeRuns = feeders
      .filter(f => f.segments.length && f.routeValid !== false)
      .map(f => ({
        name: feederDisplayName(f),
        pieces: clip(f.segments[f.segments.length - 1].pts),
      }));
    const details: string[] = [];
    const laneCoords: number[] = [];
    let everyHomeHasLane = homeRuns.length > 1;
    for (const home of homeRuns) {
      let best: { coord: number; len: number } | null = null;
      for (const piece of home.pieces) {
        for (let i = 1; i < piece.length; i++) {
          const a = piece[i - 1], b = piece[i];
          const along = info.horiz ? Math.abs(b.x - a.x) : Math.abs(b.y - a.y);
          const across = info.horiz ? Math.abs(b.y - a.y) : Math.abs(b.x - a.x);
          if (across > 1e-6 || along <= 12) continue;
          const coord = info.horiz ? a.y : a.x;
          // A fallback may contain a longer in-yard vertical/horizontal
          // detour before it settles onto its assigned bundle lane. The
          // corridor contract is the final sustained parallel ride nearest
          // the substation, not whichever same-axis leg happens to be longest.
          best = { coord, len: along };
        }
      }
      if (best) laneCoords.push(best.coord);
      else everyHomeHasLane = false;
    }
    if (everyHomeHasLane && laneCoords.length === homeRuns.length) {
      laneCoords.sort((a, b) => a - b);
      for (let i = 1; i < laneCoords.length; i++) {
        const gap = laneCoords[i] - laneCoords[i - 1];
        if (Math.abs(gap - FEEDER_TRENCH_SPACING_FT) > 0.15) {
          details.push(
            `parallel bundle lanes are ${gap.toFixed(2)} ft apart ` +
            `(required ${FEEDER_TRENCH_SPACING_FT.toFixed(1)} ft)`);
        }
      }
    }
    for (let i = 0; i < homeRuns.length; i++) {
      for (let j = i + 1; j < homeRuns.length; j++) {
        let crossed = false;
        for (const pa of homeRuns[i].pieces) {
          for (const pb of homeRuns[j].pieces) {
            for (let s = 1; s < pa.length && !crossed; s++) {
              for (let t = 1; t < pb.length && !crossed; t++) {
                const hit = segCross(pa[s - 1], pa[s], pb[t - 1], pb[t]);
                if (!hit) continue;
                const perp = info.horiz ? hit.y : hit.x;
                if (perp < perpLo || perp > perpHi) continue;
                const nearEnd =
                  dist(hit, pa[0]) < 1 || dist(hit, pa[pa.length - 1]) < 1 ||
                  dist(hit, pb[0]) < 1 || dist(hit, pb[pb.length - 1]) < 1;
                if (!nearEnd) crossed = true;
              }
            }
          }
        }
        if (crossed) {
          details.push(`home runs of feeder #${homeRuns[i].name} and feeder #${homeRuns[j].name} ` +
            `cross inside the substation corridor`);
        }
      }
    }
    emit(8, 'error', details);
  });

  // --- G-RT-9: trench bands sit between their rows, never under equipment --
  guarded(9, () => {
    const errs: string[] = [];
    const warns: string[] = [];
    const pads = design.equipment.filter(
      e => (e.kind === 'bess' || e.kind === 'inverter') && e.length > 0 && e.width > 0);
    const padObb = (e: PlacedEquipment) => mkObb(e.x, e.y, e.rotation,
      Math.max(0.1, e.length / 2 - 0.5), Math.max(0.1, e.width / 2 - 0.5));
    const checkOverlap = (band: Obb, label: string) => {
      for (const e of pads) {
        if (obbsOverlap(band, padObb(e))) {
          errs.push(`${label} runs under ${e.label || e.id}`);
          return;
        }
      }
    };
    if (design.trench) {
      const t = design.trench;
      checkOverlap(
        mkObb(t.x, (t.yBottom + t.yTop) / 2, Math.PI / 2, (t.yTop - t.yBottom) / 2, t.width / 2),
        '480V spine trench');
    }
    (design.corridorTrenches ?? []).forEach((ct, i) => {
      const obb = corridorObb(ct);
      if (!obb) return;
      const label = `corridor trench ${i + 1} (island ${ct.islandN})`;
      checkOverlap(obb, label);
      const fr = islandFrames.find(f => f.isl.n === ct.islandN);
      if (!fr || !fr.containerBox || ct.sideLane) return;
      // Center corridor: when the band overlaps the island's container
      // extents it must run BETWEEN the two container rows.
      const boxObb = mkObb(
        fr.center.x + ((fr.containerBox.minX + fr.containerBox.maxX) / 2) * Math.cos(fr.ang) -
          ((fr.containerBox.minY + fr.containerBox.maxY) / 2) * Math.sin(fr.ang),
        fr.center.y + ((fr.containerBox.minX + fr.containerBox.maxX) / 2) * Math.sin(fr.ang) +
          ((fr.containerBox.minY + fr.containerBox.maxY) / 2) * Math.cos(fr.ang),
        fr.ang,
        (fr.containerBox.maxX - fr.containerBox.minX) / 2,
        (fr.containerBox.maxY - fr.containerBox.minY) / 2);
      if (!obbsOverlap(obb, boxObb)) return;
      let below = 0, above = 0;
      for (const c of fr.containers) {
        const l = toLocal({ x: c.x, y: c.y }, obb);
        if (l.y < -1) below++;
        if (l.y > 1) above++;
      }
      if (!below || !above) {
        warns.push(`${label} does not run between the island's container rows`);
      }
    });
    emit(9, 'error', errs);
    emit(9, 'warn', warns);
  });

  // --- G-RT-10: aux daisy chain reaches every aux transformer --------------
  guarded(10, () => {
    const xfmrs = design.equipment.filter(
      e => e.kind === 'auxTransformer' && !e.augmented && !e.future);
    if (!xfmrs.length) return;
    if (!aux) {
      if (ctx.substation) {
        emit(10, 'warn', [`no aux feeder daisy chain is routed (${xfmrs.length} aux transformer${xfmrs.length > 1 ? 's' : ''} present)`]);
      }
      return;
    }
    const errs: string[] = [];
    const warns: string[] = [];
    const stopSet = new Set(aux.stopIds);
    if (stopSet.size !== aux.stopIds.length) {
      errs.push('aux feeder visits the same transformer more than once');
    }
    for (const x of xfmrs) {
      if (!stopSet.has(x.id)) errs.push(`aux feeder skips ${x.label || x.id}`);
    }
    const xfmrIds = new Set(xfmrs.map(x => x.id));
    for (const id of aux.stopIds) {
      if (!xfmrIds.has(id)) errs.push(`aux feeder stops at ${id}, which is not an aux transformer`);
    }
    // Legs may ride the island CENTER corridor (between the two per-side
    // container clusters) but never transit a cluster itself.
    for (const line of auxLines) {
      const samples = samplePolyline(line.pts, GATE_SAMPLE_STEP_FT);
      const p0 = line.pts[0], pn = line.pts[line.pts.length - 1];
      let hit: string | null = null;
      for (const fr of islandFrames) {
        for (const cl of fr.clusters) {
          if (samples.some(p =>
            dist(p, p0) > 10 && dist(p, pn) > 10 &&
            inLocalBox(toLocal(p, fr.frame), cl.box, GATE_CLUSTER_SHRINK_FT))) {
            hit = `${line.label} cuts through the ${cl.side} container row of island ${fr.isl.n}`;
            break;
          }
        }
        if (hit) break;
      }
      if (hit) warns.push(hit);
    }
    emit(10, 'error', errs);
    emit(10, 'warn', warns);
  });

  // --- G-RT-11: no circuit weaves through the same trench band -------------
  guarded(11, () => {
    if (!combRouted) return; // comb promise only — see combRouted above
    const counts = feederTrenchPassCounts(design, feeders);
    const details = counts
      .filter(c => c.passes > GATE_MAX_BAND_PASSES)
      .map(c => `feeder #${c.feeder} crosses trench band ${c.bandIndex + 1} ` +
        `${c.passes} times (budget ${GATE_MAX_BAND_PASSES})`);
    emit(11, 'warn', details);
  });

  // --- G-RT-12: every drawn cable class has a legend row --------------------
  guarded(12, () => {
    const drawn = drawnCableClasses(design);
    const legend = legendCableClasses(design);
    const details: string[] = [];
    for (const cls of Array.from(drawn)) {
      if (!legend.has(cls)) {
        details.push(`cable class ${cls} is drawn on the plan but has no legend row`);
      }
    }
    emit(12, 'error', details);
  });

  return results;
}
