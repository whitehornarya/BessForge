// MV feeder circuits: inverters (34.5 kV via integrated MV transformer)
// grouped up to 6 per feeder, daisy-chained in series, with one home-run
// trench back to a drafter-placed substation point.
//
// Home runs follow a CORRIDOR-TREE pattern (standard yard practice): all
// feeders leave the substation as an ordered set of parallel runs — each in
// its OWN trench (no shared duct banks, no mutual-heating derating) — spaced
// FEEDER_TRENCH_SPACING_FT apart, traveling together along a corridor
// perpendicular to the substation face. Each feeder peels off the corridor
// at its own group's chain end. Lane order equals the north→south order of
// each group's centroid (west→east for a north/south substation), and
// feeder numbering F1..Fn follows lane order, so the plan reads like a real
// trench plan with no crossings.
// Simple resistance-based voltage-drop model (NEC Ch.9 Table 8 DC resistance).
// ALL COORDINATES IN FEET, local site frame.

import { Pt, SiteDesign, PlacedEquipment, AuxFeederCircuit, TakeoffDirection, takeoffVector } from './types';
import { rerouteOrthogonal, offsetOrthogonal, Rect } from './cableRouting';
import { exclusionRects } from './areaZones';
import { assignFeederNames, auxFeederNameOf, feederDisplayName } from './feederNaming';
import {
  feederKeepouts, bandCoRunViolations, parallelCrossRects, gappedCrossRects,
  nearestRoadWaypoint, punchKeepoutRects,
} from './feederKeepouts';
import {
  MV_BUNDLE_SPACING_FT,
  MV_CHAMFER_DEG,
  PCS_DEFAULT_PER_FEEDER,
  PCS_MAX_EOL_PER_FEEDER,
  ROUTING_RULESET_ID,
} from './routingRules';

// Center-to-center spacing between parallel feeder home-run trenches (ft)
export const FEEDER_TRENCH_SPACING_FT = MV_BUNDLE_SPACING_FT;
// Base distance of the first feeder's approach corridor from the substation (ft)
export const SUBSTATION_APPROACH_FT = 30;

// Ray-cast point-in-polygon (local copy — keeps this module import-cycle
// free). Used by the 45° chamfer pass to restrict chamfering to corners
// OUTSIDE the fence.
function pointInPoly(p: Pt, poly: Pt[]): boolean {
  let ins = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y) &&
        p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      ins = !ins;
    }
  }
  return ins;
}

function dedupePts(pts: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of pts) {
    const lastP = out[out.length - 1];
    if (!lastP || Math.hypot(p.x - lastP.x, p.y - lastP.y) > 0.01) out.push(p);
  }
  return out;
}

// Remove backtracking vertices: a vertex whose incoming and outgoing
// directions reverse (~180°) lays two coincident trench lines on top of each
// other (the offsetOrthogonal end jogs can overshoot their anchor). Dropping
// the vertex keeps the path on the same line and removes the doubled run.
function stripBacktracks(pts: Pt[]): Pt[] {
  const out = pts.slice();
  for (let i = 1; i < out.length - 1; ) {
    const a = out[i - 1], v = out[i], b = out[i + 1];
    const l1 = Math.hypot(v.x - a.x, v.y - a.y);
    const l2 = Math.hypot(b.x - v.x, b.y - v.y);
    if (l1 > 1e-9 && l2 > 1e-9) {
      const dot = ((v.x - a.x) * (b.x - v.x) + (v.y - a.y) * (b.y - v.y)) / (l1 * l2);
      if (dot < -0.999) { // ~180° reversal
        out.splice(i, 1);
        if (i > 1) i--; // re-check the previous joint after removal
        continue;
      }
    }
    i++;
  }
  return dedupePts(out);
}

// Home-run routing mode. 'orthogonal' (default) is the classic 90° corridor
// comb — byte-identical to every existing project. 'angled' keeps the
// in-yard legs orthogonal but replaces the exterior lane ride with a shared
// straight diagonal corridor to the substation approach (per CAR-D-B005-0:
// parallel bundle at constant spacing, mitered corners, no arcs), resolving
// back to orthogonal at the approach. Drafter-drawn routes ("manual")
// override either mode.
export type FeederRoutingMode = 'orthogonal' | 'angled';

export type ConductorSize = '500' | '750' | '1000' | '1500';
/** Approved MV feeder conductor sizes. Smaller catalog sizes remain available
 * for other electrical uses, but must never be selected for a feeder. */
export type FeederConductorSize = '1000' | '1500';
export type ConductorMaterial = 'Al' | 'Cu';

export const CONDUCTOR_SIZES: ConductorSize[] = ['500', '750', '1000', '1500'];
export const FEEDER_CONDUCTOR_SIZES: FeederConductorSize[] = ['1000', '1500'];

// Ohms per 1000 ft per conductor (NEC Chapter 9 Table 8, uncoated, 75C)
export const CONDUCTOR_R_PER_KFT: Record<ConductorMaterial, Record<ConductorSize, number>> = {
  Al: { '500': 0.0424, '750': 0.0282, '1000': 0.0212, '1500': 0.0141 },
  Cu: { '500': 0.0258, '750': 0.0171, '1000': 0.0129, '1500': 0.00858 },
};

// Amps per conductor, MV cable directly buried, 90C conductor / 20C earth,
// single isolated circuit at the base soil rho below (NEC 311.60 / typical
// 35 kV single-circuit direct-buried ratings).
export const CONDUCTOR_AMPACITY: Record<ConductorMaterial, Record<ConductorSize, number>> = {
  Al: { '500': 400, '750': 490, '1000': 560, '1500': 650 },
  Cu: { '500': 510, '750': 615, '1000': 700, '1500': 810 },
};

// ---------------------------------------------------------------------------
// Underground ampacity design basis (register F-01). These are NAMED,
// DOCUMENTED constants pending reviewer confirmation of the actual duct
// bank / trench design — change them here, never inline:
//  - Installation: direct-buried single-circuit base ratings (table above).
//  - Soil thermal resistivity: RHO-90 (the base the ratings assume; a hotter
//    native soil requires an additional site-specific derate).
//  - Load factor: 100% — a BESS feeder runs at full rated power for the
//    whole discharge window, so no daily-load-factor uprate is taken.
//  - Mutual heating: adjacent circuits in the shared parallel corridor
//    (one trench per feeder at FEEDER_TRENCH_SPACING_FT) derate each other.
//    Factors follow the ICEA / NEC B.310.15(B)(2) multiple-circuit pattern.
export const AMPACITY_SOIL_RHO = 90;      // °C·cm/W, base of the rating table
export const AMPACITY_LOAD_FACTOR_PCT = 100;
// Index = total circuits sharing the corridor (0/1 unused → 1.0); 7+ → last.
export const MUTUAL_HEATING_DERATE = [1.0, 1.0, 0.9, 0.85, 0.8, 0.75, 0.72, 0.7];

export function mutualHeatingDerate(circuitsInCorridor: number): number {
  const n = Math.max(1, Math.round(circuitsInCorridor));
  return MUTUAL_HEATING_DERATE[Math.min(n, MUTUAL_HEATING_DERATE.length - 1)];
}

// Derated per-conductor ampacity for one of N circuits sharing the corridor.
export function effectiveAmpacity(
  size: ConductorSize, material: ConductorMaterial, circuitsInCorridor: number
): number {
  return CONDUCTOR_AMPACITY[material][size] * mutualHeatingDerate(circuitsInCorridor);
}

export const MV_VOLTAGE = 34500;            // V line-to-line
export const MAX_INVERTERS_PER_FEEDER = PCS_DEFAULT_PER_FEEDER;  // max QTY 7 BUILT PCS per 34.5 kV feeder
// Fixed feeder standard: each island-side feeder is sized for 9 PCS total —
// 7 built + 2 reserved future augmentation PCS (one per default island aug
// unit). The future slots are reserved capacity only; grouping/routing use
// the built cap above.
export const MAX_FUTURE_PCS_PER_FEEDER = 2;
export const MAX_TOTAL_PCS_PER_FEEDER = PCS_MAX_EOL_PER_FEEDER;
export const VD_LIMIT_PCT = 3;              // flag threshold

export interface FeederSegment {
  pts: Pt[];        // orthogonal polyline (L-shaped)
  lengthFt: number;
  amps: number;     // current carried by this segment
}

export interface FeederCircuit {
  idx: number;                 // 1-based feeder number
  // Breaker-position circuit name per the issued package (e.g. '14A1';
  // display surfaces prepend '#'). Assigned from the final feeder order +
  // island membership (see feederNaming.ts). Sessions saved before naming
  // lack it — use feederDisplayName() for the legacy F<idx> fallback.
  name: string;
  inverterIds: string[];       // chain order, farthest from substation first
  loadMW: number;
  amps: number;                // full feeder current at the substation
  segments: FeederSegment[];   // chain hops + final home run
  totalLengthFt: number;
  size: ConductorSize;
  material: ConductorMaterial;
  vdVolts: number;             // line-to-line volts dropped at full load
  vdPct: number;
  overLimit: boolean;
  recommendedSize: ConductorSize | null; // smallest larger size meeting limit
  ampacity: number;            // rated amps for the selected size/material
  // Always null for generated circuits: MV feeders route directly to the
  // substation and bypass the junction boxes (fiber-only per CAR-D-B005-0).
  // Kept for saved sessions / synthetic study fixtures that still carry it.
  fjbId: string | null;
  overAmpacity: boolean;       // EOL feeder current exceeds derated ampacity
  // smallest larger size whose ampacity covers the load, or null if none
  ampacityRecommendedSize: ConductorSize | null;
  // conductors per phase needed if the largest size still can't carry it
  parallelRunsNeeded: number;  // 1 = single conductor is fine
  // --- Register F-01/F-02/F-03: EOL sizing + governing constraint ---------
  // Future augmentation PCS positions electrically tied to this feeder
  // (whole-block reserve at the feeder's island ends; default 2 per feeder).
  futurePcs: number;
  eolAmps: number;             // (built + future PCS) current — the sizing load
  // Parallel conductor sets per phase actually selected for service (auto
  // sizing chooses the smallest single conductor first, then parallel sets).
  parallelSets: number;
  // Per-conductor ampacity after the mutual-heating derate for the number
  // of circuits sharing the corridor (adjacentCircuits).
  effectiveAmpacity: number;
  adjacentCircuits: number;
  derateFactor: number;
  // Which constraint drove the selected conductor: 'ampacity' (EOL current)
  // or 'voltage-drop'. Printed on the feeder label per the review register.
  governing: 'ampacity' | 'voltage-drop';
  // Route provenance/validity is optional for sessions saved before the
  // carousel row-routing ruleset. Invalid generated geometry is omitted
  // fail-closed while the electrical circuit remains available for review.
  routingRuleset?: string;
  routeValid?: boolean;
  routeDiagnostics?: string[];
}

export interface FeederOptions {
  // inverter id -> feeder number (1-based); unassigned ids fall into auto groups
  assignments?: Record<string, number> | null;
  // feeder number -> approved MV feeder conductor size (default 1000 kcmil)
  sizes?: Record<number, FeederConductorSize>;
  material?: ConductorMaterial;
  // Drafter-pinned corridor centerline: the perpendicular coordinate (y for
  // an east/west approach, x for north/south) the parallel lane bundle is
  // centered on. null/undefined = automatic (substation centerline). An
  // invalid pin (see feederCorridorRejectReason) is ignored and the
  // automatic position kept, so stale pins in saved projects never break
  // routing.
  corridorPin?: number | null;
  // Drafter-selected max PCS units per feeder (5, 6 or 7; values above the hard 7-PCS limit clamp to 7). Default = the
  // reference cap (7).
  maxPerFeeder?: number;
  // Drafter-drawn home-run routes, keyed by stable feeder identity (see
  // feederRouteKey — the lowest-numbered member inverter id, e.g. "inv-3").
  // Each value is the list of interior waypoints; the engine snaps the route
  // to the feeder's launch point (the chain end) at the start and the
  // substation at the end. An invalid route (crosses equipment/fence
  // clearance, leaves the routing area) is rejected with a warning and the
  // automatic route kept. Overrides whose key matches no current feeder emit
  // an "inactive" warning and are otherwise ignored.
  routeOverrides?: Record<string, Pt[]> | null;
  // Route keys the engineer force-applied: the obstacle-clearance check is
  // skipped (the routing-area bounds check still applies) and the route is
  // kept with no rejection.
  forcedRoutes?: string[];
  // Design-wide default home-run routing mode. Absent/undefined behaves as
  // 'orthogonal' (byte-identical legacy output).
  defaultRoutingMode?: FeederRoutingMode;
  // Per-feeder routing-mode overrides, keyed by stable feeder identity
  // (feederRouteKey). An entry overrides defaultRoutingMode for that feeder
  // only. Keys matching no current feeder emit an "inactive" warning and are
  // otherwise ignored (same dormancy policy as routeOverrides). A drawn
  // route override (routeOverrides) beats the mode either way.
  routingModes?: Record<string, FeederRoutingMode> | null;
  // Drafter-drawn UNDERGROUND EXCLUSION AREA zones: buried MV home runs must
  // not cross them, so the router treats them as obstacle rects exactly like
  // yard equipment. Absent/empty => routing byte-identical.
  exclusionZones?: import('./areaZones').AreaZone[] | null;
  // Gate-entrance / apron hard keep-outs (traced yards): a home run must
  // never trench through the site entrance. Computed by the CALLER via
  // gateApronKeepouts() from the layout-edit road records — the design
  // object itself does not carry traced roads. Absent/empty => routing
  // byte-identical.
  gateKeepouts?: Rect[] | null;
  // MULTI-AREA ONLY: the compass direction the feeders travel as they land on
  // their substation take-off, stated by the drafter instead of inferred from
  // the equipment centroid. Absent/undefined keeps the inferred approach, so
  // single-area routing is byte-identical.
  approach?: import('./types').TakeoffDirection | null;
  // MULTI-AREA ONLY: fences of OTHER site areas the cross-area home runs must
  // not cut through (never the source yard's own fence, never the target
  // substation's). Treated as hard obstacle rects, exactly like equipment.
  // Absent/empty => routing byte-identical.
  foreignFences?: Pt[][] | null;
  // Called (at most once per concern) when routing had to fail-safe — e.g.
  // the run-coordinate stagger ran out of room and a trench line was
  // clamped to the routing area edge. Callers surface these on the design.
  onWarning?: (msg: string) => void;
}

/** Foreign-area fences reduced to obstacle rects for the router.
 *  A neighbouring yard is a keep-out as a whole: a cross-area feeder must go
 *  AROUND it, never through it, so its bounding box (not its outline) is the
 *  obstacle. */
export function foreignFenceRects(fences: Pt[][] | null | undefined): Rect[] {
  const out: Rect[] = [];
  for (const f of fences ?? []) {
    if (!f || f.length < 3) continue;
    const xs = f.map(p => p.x), ys = f.map(p => p.y);
    if (!xs.every(Number.isFinite) || !ys.every(Number.isFinite)) continue;
    out.push({
      x1: Math.min(...xs), x2: Math.max(...xs),
      y1: Math.min(...ys), y2: Math.max(...ys),
    });
  }
  return out;
}

// Per-inverter feeder current at 34.5 kV, unity pf
export function inverterAmps(blockMW: number): number {
  return (blockMW * 1e6) / (Math.sqrt(3) * MV_VOLTAGE);
}

function dist(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// Orthogonal L route between two points (x-leg then y-leg)
function lRoute(a: Pt, b: Pt): Pt[] {
  if (Math.abs(a.x - b.x) < 0.01 || Math.abs(a.y - b.y) < 0.01) return [a, b];
  return [a, { x: b.x, y: a.y }, b];
}

function polyLen(pts: Pt[]): number {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += dist(pts[i - 1], pts[i]);
  return s;
}

// Equipment rects (axis-aligned, rotation-aware) inflated by a small margin,
// used as obstacles for feeder routing. Reuses the same convention as the
// yard cable router.
export function equipmentRect(e: PlacedEquipment, margin: number): Rect {
  const rot = Math.abs(Math.sin(e.rotation)) > 0.5;
  const hx = (rot ? e.width : e.length) / 2 + margin;
  const hy = (rot ? e.length : e.width) / 2 + margin;
  return { x1: e.x - hx, x2: e.x + hx, y1: e.y - hy, y2: e.y + hy };
}

// Does an orthogonal polyline pass through any obstacle rect? Exact
// segment/rect overlap test (segments are axis-aligned). The first/last
// LAUNCH_FT of the run are exempt so a feeder can launch from the edge of
// its own inverter skid.
const LAUNCH_FT = 8;
// A home run that LAUNCHES inside a gate/apron keep-out cannot avoid that
// rect (the grid router cannot start inside an obstacle, so routing drops
// it), but only the initial egress is legal: once the path has left the
// rect, any later deep re-entry (>0.5 ft past the boundary, so samples
// riding exactly on the edge never trip it) means the run trenches back
// through the site entrance and must be surfaced by the gate audit. Pure
// and exported for direct regression tests. Paths are sampled at ~1 ft so
// short crossings between vertices cannot slip through.
export function homeRunReentersRect(pts: Pt[], r: Rect): boolean {
  let exited = false;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const n = Math.max(1, Math.ceil(len));
    for (let k = i === 0 ? 0 : 1; k <= n; k++) {
      const p = { x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n };
      if (!exited) {
        if (p.x <= r.x1 || p.x >= r.x2 || p.y <= r.y1 || p.y >= r.y2) exited = true;
      } else if (p.x > r.x1 + 0.5 && p.x < r.x2 - 0.5 &&
                 p.y > r.y1 + 0.5 && p.y < r.y2 - 0.5) {
        return true;
      }
    }
  }
  return false;
}

export function feederCrossesObstacle(pts: Pt[], obstacles: Rect[], start: Pt, end: Pt): boolean {
  // Recognized physical rows may be rotated. Preserve the fast/exact legacy
  // axis-aligned path, but use Liang–Barsky clipping whenever any segment is
  // diagonal so an arbitrary-angle trunk cannot slip through a keep-out.
  if (pts.some((p, i) => i + 1 < pts.length &&
      Math.abs(p.x - pts[i + 1].x) > 1e-6 &&
      Math.abs(p.y - pts[i + 1].y) > 1e-6)) {
    return customRouteCrossesObstacle(pts, obstacles, start, end);
  }
  const nearEndpoint = (x: number, y: number) =>
    Math.hypot(x - start.x, y - start.y) < LAUNCH_FT || Math.hypot(x - end.x, y - end.y) < LAUNCH_FT;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const horizontal = Math.abs(a.y - b.y) < 1e-6;
    const lo = horizontal ? Math.min(a.x, b.x) : Math.min(a.y, b.y);
    const hi = horizontal ? Math.max(a.x, b.x) : Math.max(a.y, b.y);
    for (const r of obstacles) {
      let oLo: number, oHi: number;
      if (horizontal) {
        if (a.y <= r.y1 || a.y >= r.y2) continue;
        oLo = Math.max(lo, r.x1); oHi = Math.min(hi, r.x2);
      } else {
        if (a.x <= r.x1 || a.x >= r.x2) continue;
        oLo = Math.max(lo, r.y1); oHi = Math.min(hi, r.y2);
      }
      if (oLo >= oHi) continue;
      // Overlap exists; ignore it only if entirely within a launch zone
      const mid = (oLo + oHi) / 2;
      const px = horizontal ? mid : a.x;
      const py = horizontal ? a.y : mid;
      if (nearEndpoint(px, py) && oHi - oLo < LAUNCH_FT * 2) continue;
      return true;
    }
  }
  return false;
}

// Obstacle test for DRAFTER-DRAWN routes: custom waypoint legs may run at
// any angle, which the orthogonal checker above cannot see (a diagonal leg
// through a skid would be misclassified). Liang–Barsky segment/rect
// clipping gives the exact in-rect interval for any orientation; the same
// launch-zone exemption applies. Rects are inset by a hair so a leg riding
// exactly along an obstacle's inflated margin edge (allowed for the
// orthogonal checker) does not count as a crossing here either.
export function customRouteCrossesObstacle(pts: Pt[], obstacles: Rect[], start: Pt, end: Pt): boolean {
  const EPS = 0.01;
  const nearEndpoint = (x: number, y: number) =>
    Math.hypot(x - start.x, y - start.y) < LAUNCH_FT || Math.hypot(x - end.x, y - end.y) < LAUNCH_FT;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const dx = b.x - a.x, dy = b.y - a.y;
    const segLen = Math.hypot(dx, dy);
    if (segLen < 1e-9) continue;
    for (const r of obstacles) {
      let t0 = 0, t1 = 1;
      let ok = true;
      const clip = (p: number, q: number): void => {
        if (!ok) return;
        if (Math.abs(p) < 1e-12) { if (q < 0) ok = false; return; }
        const t = q / p;
        if (p < 0) { if (t > t1) { ok = false; return; } if (t > t0) t0 = t; }
        else { if (t < t0) { ok = false; return; } if (t < t1) t1 = t; }
      };
      clip(-dx, a.x - (r.x1 + EPS));
      clip(dx, (r.x2 - EPS) - a.x);
      clip(-dy, a.y - (r.y1 + EPS));
      clip(dy, (r.y2 - EPS) - a.y);
      if (!ok || t1 <= t0) continue;
      const ovl = (t1 - t0) * segLen;
      if (ovl < 1e-6) continue;
      const tm = (t0 + t1) / 2;
      if (nearEndpoint(a.x + dx * tm, a.y + dy * tm) && ovl < LAUNCH_FT * 2) continue;
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Trench-vs-trench crossing geometry.
//
// The two clippers above answer "does this route cut through a BOX". Two
// buried circuits crossing each other is a different question and needs an
// exact segment-vs-segment test: it must work at any angle, and it must also
// catch COLLINEAR overlap (two trenches laid along the same line read as one
// shared trench on the drawing, which the reference standard forbids).
//
// One region is exempt: near the substation EVERY circuit legitimately
// converges on the same terminal — the approach waypoints and the entry jogs
// all land on the substation point by design. Callers pass that convergence
// window as `exempt`; meetings inside it are not crossings.
const CROSS_EPS = 1e-9;
// Cap on the squares one diagonal keep-out segment may contribute. Routers
// scan every obstacle per grid cell, so an unbounded sample count on a long
// diagonal makes routing unusable.
const DIAG_KEEPOUT_SAMPLES = 400;

const inRect = (p: Pt, r: Rect): boolean =>
  p.x >= r.x1 && p.x <= r.x2 && p.y >= r.y1 && p.y <= r.y2;

/** Every point where polyline `a` meets polyline `b`, excluding meetings
 *  inside the `exempt` convergence window. Collinear overlaps are reported
 *  once, at the midpoint of the shared run. */
export function polylineCrossings(a: Pt[], b: Pt[], exempt?: Rect | null): Pt[] {
  const hits: Pt[] = [];
  const finite = (p: Pt) => Number.isFinite(p.x) && Number.isFinite(p.y);
  for (let i = 0; i < a.length - 1; i++) {
    const p1 = a[i], p2 = a[i + 1];
    if (!finite(p1) || !finite(p2)) continue;
    const rx = p2.x - p1.x, ry = p2.y - p1.y;
    const rr = rx * rx + ry * ry;
    if (rr < CROSS_EPS) continue;
    for (let j = 0; j < b.length - 1; j++) {
      const p3 = b[j], p4 = b[j + 1];
      if (!finite(p3) || !finite(p4)) continue;
      const sx = p4.x - p3.x, sy = p4.y - p3.y;
      if (sx * sx + sy * sy < CROSS_EPS) continue;
      const d = rx * sy - ry * sx;
      const qpx = p3.x - p1.x, qpy = p3.y - p1.y;
      let hit: Pt | null = null;
      if (Math.abs(d) < 1e-12) {
        // Parallel. Only a COLLINEAR pair with real overlap is a shared
        // trench; merely parallel neighbours (the whole point of the lane
        // bundle) are fine.
        if (Math.abs(qpx * ry - qpy * rx) > 1e-6 * Math.sqrt(rr)) continue;
        const t0 = (qpx * rx + qpy * ry) / rr;
        const t1 = t0 + (sx * rx + sy * ry) / rr;
        const lo = Math.max(0, Math.min(t0, t1));
        const hi = Math.min(1, Math.max(t0, t1));
        // Touching end-to-end is not an overlap; require real shared length.
        if ((hi - lo) * Math.sqrt(rr) < 0.05) continue;
        const m = (lo + hi) / 2;
        hit = { x: p1.x + m * rx, y: p1.y + m * ry };
      } else {
        const t = (qpx * sy - qpy * sx) / d;
        const u = (qpx * ry - qpy * rx) / d;
        if (t < -CROSS_EPS || t > 1 + CROSS_EPS) continue;
        if (u < -CROSS_EPS || u > 1 + CROSS_EPS) continue;
        hit = { x: p1.x + t * rx, y: p1.y + t * ry };
      }
      if (!hit) continue;
      if (exempt && inRect(hit, exempt)) continue;
      hits.push(hit);
    }
  }
  return hits;
}

/** True when two buried runs meet anywhere outside the convergence window. */
export function polylinesCross(a: Pt[], b: Pt[], exempt?: Rect | null): boolean {
  return polylineCrossings(a, b, exempt).length > 0;
}

/** Thin keep-out rects tracing already-routed trenches, so the
 *  equipment-aware routers can treat existing circuits as obstacles and
 *  detour around them instead of cutting across. Axis-aligned runs (the
 *  overwhelming majority) become one fattened box each; diagonal runs
 *  (angled mode / drafter-drawn legs) are sampled into small squares.
 *  Geometry inside `exempt` is dropped so a route may still reach the
 *  shared substation terminal. */
export function trenchKeepOutRects(
  runs: Pt[][], halfWidthFt: number, exempt?: Rect | null
): Rect[] {
  const hw = Math.max(0.5, halfWidthFt);
  const out: Rect[] = [];
  const push = (x1: number, y1: number, x2: number, y2: number) => {
    if (x2 - x1 < 1e-6 || y2 - y1 < 1e-6) return;
    out.push({ x1, y1, x2, y2 });
  };
  for (const run of runs) {
    for (let i = 0; i < run.length - 1; i++) {
      const a = run[i], b = run[i + 1];
      if (!Number.isFinite(a.x) || !Number.isFinite(a.y)) continue;
      if (!Number.isFinite(b.x) || !Number.isFinite(b.y)) continue;
      const dx = b.x - a.x, dy = b.y - a.y;
      const len = Math.hypot(dx, dy);
      if (len < 1e-6) continue;
      if (Math.abs(dy) < 1e-6) {
        // Horizontal: exact clip of the exempt window out of the x range.
        const lo = Math.min(a.x, b.x), hi = Math.max(a.x, b.x);
        const blocks: [number, number][] = [[lo, hi]];
        if (exempt && a.y >= exempt.y1 && a.y <= exempt.y2) {
          blocks.length = 0;
          if (exempt.x1 > lo) blocks.push([lo, Math.min(hi, exempt.x1)]);
          if (exempt.x2 < hi) blocks.push([Math.max(lo, exempt.x2), hi]);
        }
        for (const [s, e] of blocks) push(s, a.y - hw, e, a.y + hw);
      } else if (Math.abs(dx) < 1e-6) {
        const lo = Math.min(a.y, b.y), hi = Math.max(a.y, b.y);
        const blocks: [number, number][] = [[lo, hi]];
        if (exempt && a.x >= exempt.x1 && a.x <= exempt.x2) {
          blocks.length = 0;
          if (exempt.y1 > lo) blocks.push([lo, Math.min(hi, exempt.y1)]);
          if (exempt.y2 < hi) blocks.push([Math.max(lo, exempt.y2), hi]);
        }
        for (const [s, e] of blocks) push(a.x - hw, s, a.x + hw, e);
      } else {
        // Diagonal: sample into squares. Bounded so a very long diagonal
        // cannot explode the obstacle list the routers scan per grid cell.
        const step = Math.max(hw, len / DIAG_KEEPOUT_SAMPLES);
        // When the cap forces a step coarser than the square, the squares
        // must grow to match or they stop touching and leave gaps a grid
        // route can thread straight through. Over-wide is safe for a
        // keep-out; spaced-apart is not.
        const sw = Math.max(hw, step);
        const n = Math.max(1, Math.ceil(len / step));
        for (let k = 0; k <= n; k++) {
          const t = k / n;
          const p = { x: a.x + dx * t, y: a.y + dy * t };
          if (exempt && inRect(p, exempt)) continue;
          push(p.x - sw, p.y - sw, p.x + sw, p.y + sw);
        }
      }
    }
  }
  return out;
}

// Route one feeder segment: try the plain L route first; if it would cut
// through equipment, fall back to the shared fence/equipment-aware grid
// router (rerouteOrthogonal) over a padded bounding box that includes the
// substation, so feeders may exit the fence/parcel when the substation is
// outside. If the grid is too large or no path exists, keep the L route.
function routeSegment(a: Pt, b: Pt, obstacles: Rect[], bounds: Pt[]): Pt[] {
  const l = lRoute(a, b);
  if (!feederCrossesObstacle(l, obstacles, a, b)) return l;
  let rr = rerouteOrthogonal(a, b, bounds, obstacles, () => true);
  if (!rr) {
    // Multi-area sites hand every reroute the GLOBAL routing bounds; at the
    // router's fixed grid step that blows its internal cell budget and it
    // bails without searching — silently keeping the blocked L route, which
    // is how traced-yard feeders ended up lancing through equipment. A
    // reroute only needs room around its own endpoints, so retry on a
    // padded endpoint window clipped to the full bounds. Single-area yards
    // are untouched: their full-bounds search already succeeded or genuinely
    // proved no path (the window is a subset of those bounds), so the retry
    // is skipped unless the window is actually smaller.
    const PAD = 320;
    const bx1 = Math.min(...bounds.map(p => p.x)), bx2 = Math.max(...bounds.map(p => p.x));
    const by1 = Math.min(...bounds.map(p => p.y)), by2 = Math.max(...bounds.map(p => p.y));
    const wx1 = Math.max(bx1, Math.min(a.x, b.x) - PAD), wx2 = Math.min(bx2, Math.max(a.x, b.x) + PAD);
    const wy1 = Math.max(by1, Math.min(a.y, b.y) - PAD), wy2 = Math.min(by2, Math.max(a.y, b.y) + PAD);
    if (wx2 - wx1 < bx2 - bx1 - 1 || wy2 - wy1 < by2 - by1 - 1) {
      rr = rerouteOrthogonal(a, b,
        [{ x: wx1, y: wy1 }, { x: wx2, y: wy1 }, { x: wx2, y: wy2 }, { x: wx1, y: wy2 }],
        obstacles, () => true);
    }
  }
  return rr ? rr.path : l;
}

// Padded rectangular routing bounds covering the whole yard + substation.
//
// `extra` widens the area to cover cross-area geometry (a take-off in another
// footprint, plus the neighbouring fences a detour has to get around). Absent
// => byte-identical single-area bounds.
function routingBounds(design: SiteDesign, substation: Pt, extra?: Pt[] | null): Pt[] {
  const ex = extra ?? [];
  const xs = design.fence.map(p => p.x).concat(substation.x, ...ex.map(p => p.x));
  const ys = design.fence.map(p => p.y).concat(substation.y, ...ex.map(p => p.y));
  const pad = 60;
  const x1 = Math.min(...xs) - pad, x2 = Math.max(...xs) + pad;
  const y1 = Math.min(...ys) - pad, y2 = Math.max(...ys) + pad;
  return [{ x: x1, y: y1 }, { x: x2, y: y1 }, { x: x2, y: y2 }, { x: x1, y: y2 }];
}

// ---------------------------------------------------------------------------
// Drafter-draggable feeder corridor: shared geometry + validation.
//
// The corridor is the bundle of parallel home-run lanes outside the fence.
// Its position is fully described by one number — the perpendicular
// coordinate of the bundle centerline (y for an east/west substation
// approach, x for north/south). The drag UI, the store action and
// generateFeeders all consume the same info/validator so preview ghosts,
// accepted pins and routed lanes always agree.
export interface FeederCorridorInfo {
  horiz: boolean;      // true = east/west approach (lanes stack in y)
  autoCenter: number;  // automatic centerline (substation y or x)
  laneCount: number;   // automatic feeder/lane count
  halfBand: number;    // centerline to outermost lane (ft)
  min: number;         // smallest valid pinned centerline
  max: number;         // largest valid pinned centerline
  // Extent of the lane bundle along the approach axis, for drawing the
  // drag handle: from the first climb line outside the fence to the
  // substation approach waypoint.
  spanLo: number;
  spanHi: number;
}

// Corridor climb legs start this far outside the fence (obstacle-free strip)
const CLIMB_MARGIN_FT = 15;

/** The corridor's frame of reference: which side the substation approaches
 *  from, where the lane bundle is centred, and where the climb strip starts.
 *  generateFeeders lays the MV lanes in this frame; the aux feeder reuses it
 *  so its dedicated lane is genuinely parallel to (and one trench spacing
 *  beyond) the MV bundle rather than an independently-derived guess. */
export interface FeederCorridorFrame {
  horizApproach: boolean;  // true = east/west approach (lanes stack in y)
  dirX: number;            // sign from the equipment centroid to the substation
  dirY: number;
  fenceEdge: number;       // fence coordinate on the substation side
  climbBase: number;       // first climb line, outside the fence
  laneCenter: number;      // lane-bundle centreline (pinned or automatic)
}

/**
 * Which side the corridor leaves the yard on.
 *
 * By default this is inferred from the equipment centroid vs. the substation
 * point — the single-area behaviour, unchanged. A multi-area take-off instead
 * states its direction EXPLICITLY, so the drafter (not a centroid) decides
 * which face the feeders depart from:
 *   - a cardinal direction fixes both the axis and the sign;
 *   - a diagonal fixes both signs and lets the geometry pick which axis the
 *     lanes stack on, so the corridor still runs along the longer leg.
 */
export function feederApproachAxis(
  substation: Pt, eqCx: number, eqCy: number, approach?: TakeoffDirection | null
): { horizApproach: boolean; dirX: number; dirY: number } {
  const geoHoriz = Math.abs(substation.x - eqCx) >= Math.abs(substation.y - eqCy);
  const geoDirX = Math.sign(substation.x - eqCx) || 1;
  const geoDirY = Math.sign(substation.y - eqCy) || 1;
  if (!approach) return { horizApproach: geoHoriz, dirX: geoDirX, dirY: geoDirY };
  const v = takeoffVector(approach);
  const diagonal = v.dx !== 0 && v.dy !== 0;
  return {
    horizApproach: diagonal ? geoHoriz : v.dx !== 0,
    dirX: v.dx !== 0 ? v.dx : geoDirX,
    dirY: v.dy !== 0 ? v.dy : geoDirY,
  };
}

export function feederCorridorFrame(
  design: SiteDesign,
  substation: Pt,
  corridorPin?: number | null,
  maxPer: number = MAX_INVERTERS_PER_FEEDER,
  approach?: TakeoffDirection | null
): FeederCorridorFrame | null {
  if (!Number.isFinite(substation.x) || !Number.isFinite(substation.y)) return null;
  const inverters = design.equipment.filter(e => e.kind === 'inverter' && !e.augmented && !e.future);
  if (!inverters.length || !design.fence?.length) return null;
  const eqCx = inverters.reduce((s, e) => s + e.x, 0) / inverters.length;
  const eqCy = inverters.reduce((s, e) => s + e.y, 0) / inverters.length;
  const { horizApproach, dirX, dirY } = feederApproachAxis(substation, eqCx, eqCy, approach);
  const fxs = design.fence.map(p => p.x);
  const fys = design.fence.map(p => p.y);
  const fenceEdge = horizApproach
    ? (dirX > 0 ? Math.max(...fxs) : Math.min(...fxs))
    : (dirY > 0 ? Math.max(...fys) : Math.min(...fys));
  const climbBase = fenceEdge + (horizApproach ? dirX : dirY) * CLIMB_MARGIN_FT;
  // Drafter corridor pin: a valid pin recenters the whole lane bundle on the
  // pinned perpendicular coordinate; an invalid/absent pin keeps the
  // automatic centerline (the substation itself).
  const laneCenter =
    corridorPin != null && feederCorridorRejectReason(design, substation, corridorPin, maxPer) === null
      ? corridorPin
      : horizApproach ? substation.y : substation.x;
  return { horizApproach, dirX, dirY, fenceEdge, climbBase, laneCenter };
}

export function feederCorridorInfo(design: SiteDesign, substation: Pt, maxPer: number = MAX_INVERTERS_PER_FEEDER): FeederCorridorInfo | null {
  if (!Number.isFinite(substation.x) || !Number.isFinite(substation.y)) return null;
  const inverters = design.equipment.filter(e => e.kind === 'inverter' && !e.augmented && !e.future);
  if (!inverters.length) return null;
  const eqCx = inverters.reduce((s, e) => s + e.x, 0) / inverters.length;
  const eqCy = inverters.reduce((s, e) => s + e.y, 0) / inverters.length;
  const horiz = Math.abs(substation.x - eqCx) >= Math.abs(substation.y - eqCy);
  const laneCount = (
    islandGroups(design, maxPer) ??
    tracedLineGroups(inverters, maxPer) ??
    autoGroupInverters(inverters, maxPer)
  ).length;
  const halfBand = ((laneCount - 1) / 2) * FEEDER_TRENCH_SPACING_FT;
  const b = routingBounds(design, substation);
  const min = (horiz ? b[0].y : b[0].x) + halfBand + FEEDER_TRENCH_SPACING_FT;
  const max = (horiz ? b[2].y : b[2].x) - halfBand - FEEDER_TRENCH_SPACING_FT;
  const dir = horiz ? (Math.sign(substation.x - eqCx) || 1) : (Math.sign(substation.y - eqCy) || 1);
  const fenceCoords = design.fence.map(p => (horiz ? p.x : p.y));
  const fenceEdge = dir > 0 ? Math.max(...fenceCoords) : Math.min(...fenceCoords);
  const climbBase = fenceEdge + dir * CLIMB_MARGIN_FT;
  const waypointCoord = (horiz ? substation.x : substation.y) - dir * SUBSTATION_APPROACH_FT;
  return {
    horiz,
    autoCenter: horiz ? substation.y : substation.x,
    laneCount,
    halfBand,
    min,
    max,
    spanLo: Math.min(climbBase, waypointCoord),
    spanHi: Math.max(climbBase, waypointCoord),
  };
}

// Why a pinned corridor centerline is invalid, or null when acceptable.
// Lanes live in the obstacle-free strip outside the fence, so the only
// geometric failure is pushing the bundle out of the padded routing area
// (where grid reroutes and the approach jog could no longer be built).
export function feederCorridorRejectReason(design: SiteDesign, substation: Pt, pin: number, maxPer: number = MAX_INVERTERS_PER_FEEDER): string | null {
  if (!Number.isFinite(pin)) return 'pinned position is not a number';
  const info = feederCorridorInfo(design, substation, maxPer);
  if (!info) return 'no inverters to feed';
  if (pin < info.min || pin > info.max) {
    return `the parallel lanes would leave the routing area (centerline must stay between ${info.min.toFixed(0)} and ${info.max.toFixed(0)} ft ${info.horiz ? 'north/south' : 'east/west'})`;
  }
  return null;
}

// Which end of an equipment row the feeders FILL from: the end nearest the
// substation along the approach axis. Passed by generateFeeders so oversized
// island sides chunk entry-end-first; count-only callers (corridor info)
// omit it — the chunk COUNT is identical either way.
export interface FeederEntryHint { horiz: boolean; dir: number; }

// Island layouts: one feeder per island side (2 per full island). Sides
// larger than the cap are split ENTRY-END-FIRST per the reference sheets:
// full groups of `maxPer` fill from the substation-entry end of the row and
// only the FAR end carries the remainder (a row with fewer built PCS than
// the cap is a remainder, never a rebalance). Returns null for non-island
// layouts so callers fall back to autoGroupInverters.
export function islandGroups(
  design: SiteDesign,
  maxPer: number = MAX_INVERTERS_PER_FEEDER,
  entry?: FeederEntryHint | null
): string[][] | null {
  if (!design.islands || !design.islands.length) return null;
  const byId = entry ? new Map(design.equipment.map(e => [e.id, e])) : null;
  const groups: string[][] = [];
  const pushSide = (ids: string[]) => {
    const n = ids.length;
    if (!n) return;
    if (n <= maxPer) { groups.push(ids); return; }
    // Entry end: compare the row's first vs last member along the approach
    // axis. Rows perpendicular to the approach (no spread along it) and
    // count-only calls fill from the row head — deterministic either way.
    let entryAtTail = false;
    if (entry && byId) {
      const a = byId.get(ids[0]);
      const b = byId.get(ids[n - 1]);
      if (a && b) {
        const ca = entry.horiz ? a.x : a.y;
        const cb = entry.horiz ? b.x : b.y;
        if (Math.abs(cb - ca) > 1) entryAtTail = (cb - ca) * entry.dir > 0;
      }
    }
    if (entryAtTail) {
      const rem = n % maxPer;
      let i = 0;
      if (rem) { groups.push(ids.slice(0, rem)); i = rem; }
      for (; i < n; i += maxPer) groups.push(ids.slice(i, i + maxPer));
    } else {
      for (let i = 0; i < n; i += maxPer) groups.push(ids.slice(i, i + maxPer));
    }
  };
  for (const isl of design.islands) {
    pushSide(isl.southIds);
    pushSide(isl.northIds);
  }
  return groups.length ? groups : null;
}

export function autoGroupInverters(inverters: PlacedEquipment[], maxPer: number = MAX_INVERTERS_PER_FEEDER): string[][] {
  const sorted = [...inverters].sort((a, b) => (a.x - b.x) || (a.y - b.y) || a.id.localeCompare(b.id));
  const n = sorted.length;
  if (!n) return [];
  const k = Math.ceil(n / maxPer);
  const base = Math.floor(n / k);
  let extra = n % k;
  const groups: string[][] = [];
  let i = 0;
  for (let g = 0; g < k; g++) {
    const take = base + (extra-- > 0 ? 1 : 0);
    groups.push(sorted.slice(i, i + take).map(e => e.id));
    i += take;
  }
  return groups;
}

// Orientation-aware PCS row grammar shared by traced, generic horizontal,
// vertical and arbitrarily rotated layouts. Equipment is first bucketed by
// long-axis orientation modulo 180°, then clustered by its perpendicular
// coordinate. Every resulting row is chunked independently at the governing
// seven-built-PCS cap; a feeder never jumps from the end of one row into the
// middle of another. A pure scatter returns null so legacy generic grouping
// remains available for synthetic/non-row layouts.
export function orientedRowGroups(
  inverters: PlacedEquipment[],
  maxPer: number = MAX_INVERTERS_PER_FEEDER
): string[][] | null {
  if (inverters.length < 2) return null;
  const ANGLE_TOL = (5 * Math.PI) / 180;
  const ROW_TOL_FT = 15;
  const norm = (a: number): number => {
    const p = a % Math.PI;
    return p < 0 ? p + Math.PI : p;
  };
  const angleNear = (a: number, b: number): boolean =>
    Math.abs(Math.sin(a - b)) <= Math.sin(ANGLE_TOL);
  const buckets: { angle: number; units: PlacedEquipment[] }[] = [];
  for (const e of [...inverters].sort((a, b) =>
    norm(a.rotation) - norm(b.rotation) || a.id.localeCompare(b.id))) {
    const a = norm(e.rotation);
    const bucket = buckets.find(b => angleNear(a, b.angle));
    if (bucket) bucket.units.push(e);
    else buckets.push({ angle: a, units: [e] });
  }

  const rows: { angle: number; units: PlacedEquipment[]; across: number }[] = [];
  let hasRealRow = false;
  for (const bucket of buckets) {
    const ux = Math.cos(bucket.angle), uy = Math.sin(bucket.angle);
    const across = (e: PlacedEquipment) => -e.x * uy + e.y * ux;
    const along = (e: PlacedEquipment) => e.x * ux + e.y * uy;
    const sorted = [...bucket.units].sort((a, b) =>
      across(a) - across(b) || along(a) - along(b) || a.id.localeCompare(b.id));
    let row: PlacedEquipment[] = [];
    let rowAcross = 0;
    const flush = () => {
      if (!row.length) return;
      row.sort((a, b) => along(a) - along(b) || a.id.localeCompare(b.id));
      if (row.length >= 2) hasRealRow = true;
      rows.push({ angle: bucket.angle, units: row, across: rowAcross });
      row = [];
    };
    for (const e of sorted) {
      const c = across(e);
      if (row.length && Math.abs(c - rowAcross) > ROW_TOL_FT) flush();
      if (!row.length) {
        row = [e];
        rowAcross = c;
      } else {
        row.push(e);
        rowAcross += (c - rowAcross) / row.length;
      }
    }
    flush();
  }
  if (!hasRealRow) return null;

  rows.sort((a, b) =>
    a.angle - b.angle || b.across - a.across ||
    a.units[0].id.localeCompare(b.units[0].id));
  const groups: string[][] = [];
  for (const row of rows) {
    for (let i = 0; i < row.units.length; i += maxPer) {
      groups.push(row.units.slice(i, i + maxPer).map(e => e.id));
    }
  }
  return groups;
}

// Feeder groups for TRACED yards (no auto islands): per the reference route
// map (CAR-D-B001-2) every feeder serves a CONTIGUOUS run of PCS along one
// equipment line (a drawn column or row), with at most one hop between
// ADJACENT line ends — never a mid-yard jump across foreign equipment. The
// generic x-then-y slicer can't see the drawn lines: its groups straddle
// columns mid-column, so chain hops lanced straight through other feeders'
// PCS and the container columns (the AREA3/AREA4 defect the drafters
// flagged). Cluster the built PCS by their shared line coordinate (the axis
// with fewer clusters is the line axis), walk the lines serpentine —
// alternating direction so consecutive lines join at NEAR ends — and deal
// the same group sizes the generic slicer would (feeder count unchanged).
// Orientation of the drawn PCS lines in a traced yard: true = vertical
// columns (units share x), false = horizontal rows (share y), null = no
// discernible line structure. PCS on one drawn line share a coordinate
// within drawing jitter; distinct lines sit at least an aisle apart, so a
// 15 ft cluster tolerance separates jitter from aisles.
export function tracedLinesVertical(inverters: PlacedEquipment[]): boolean | null {
  const n = inverters.length;
  if (n < 2) return null;
  const TOL = 15;
  const clusterCount = (coord: (e: PlacedEquipment) => number): number => {
    const sorted = inverters.map(coord).sort((a, b) => a - b);
    let count = 0;
    let prev = Infinity;
    for (const v of sorted) {
      if (v - prev > TOL) count++;
      else if (prev === Infinity) count = 1;
      prev = v;
    }
    return count;
  };
  const xc = clusterCount(e => e.x);
  const yc = clusterCount(e => e.y);
  if (Math.min(xc, yc) >= n) return null; // every unit its own line — scatter
  return xc <= yc; // fewer x-clusters -> vertical columns sharing x
}

export function tracedLineGroups(
  inverters: PlacedEquipment[],
  maxPer: number = MAX_INVERTERS_PER_FEEDER
): string[][] | null {
  const oriented = orientedRowGroups(inverters, maxPer);
  if (oriented) return oriented;
  const n = inverters.length;
  if (n < 2) return null;
  const vertical = tracedLinesVertical(inverters);
  if (vertical == null) return null;
  const TOL = 15;
  const cluster = (coord: (e: PlacedEquipment) => number): PlacedEquipment[][] => {
    const sorted = [...inverters].sort((a, b) => coord(a) - coord(b) || a.id.localeCompare(b.id));
    const out: PlacedEquipment[][] = [];
    for (const e of sorted) {
      const last = out[out.length - 1];
      if (last && coord(e) - coord(last[last.length - 1]) <= TOL) last.push(e);
      else out.push([e]);
    }
    return out;
  };
  const lines = vertical ? cluster(e => e.x) : cluster(e => e.y);
  const groups: string[][] = [];
  for (const line of lines) {
    const s = [...line].sort((a, b) =>
      (vertical ? a.y - b.y : a.x - b.x) || a.id.localeCompare(b.id));
    for (let i = 0; i < s.length; i += maxPer) {
      groups.push(s.slice(i, i + maxPer).map(e => e.id));
    }
  }
  return groups;
}

// Series chain order: greedy nearest-neighbor starting from the inverter
// farthest from the substation, so the chain naturally ends near it.
function chainOrder(members: PlacedEquipment[], substation: Pt, twoOpt = false): PlacedEquipment[] {
  if (members.length <= 1) return [...members];
  const remaining = [...members];
  remaining.sort((a, b) => dist(b, substation) - dist(a, substation) || a.id.localeCompare(b.id));
  const chain: PlacedEquipment[] = [remaining.shift()!];
  while (remaining.length) {
    const last = chain[chain.length - 1];
    let bi = 0;
    let bd = Infinity;
    remaining.forEach((m, j) => {
      const d = dist(m, last);
      if (d < bd - 1e-9 || (Math.abs(d - bd) < 1e-9 && m.id < remaining[bi].id)) { bd = d; bi = j; }
    });
    chain.push(remaining.splice(bi, 1)[0]);
  }
  // 2-opt improvement on the open path chain[0] .. chain[n-1] -> anchor —
  // ISLAND chains only: greedy nearest-neighbor can zig down
  // past a row and come back up (the island detour the drafters flagged).
  // Reversing any sub-path that shortens total hop length removes those
  // wrap-arounds; n <= 6 so the pass is cheap and deterministic. Non-island
  // chains keep the plain greedy order their comb invariants are tuned to.
  if (!twoOpt) return chain;
  const pathLen = (c: PlacedEquipment[]) => {
    let s = 0;
    for (let i = 1; i < c.length; i++) s += dist(c[i - 1], c[i]);
    return s + dist(c[c.length - 1], substation);
  };
  let improved = true;
  let guard = 0;
  while (improved && guard++ < 50) {
    improved = false;
    for (let i = 0; i < chain.length - 1 && !improved; i++) {
      for (let j = i + 1; j < chain.length && !improved; j++) {
        const cand = [
          ...chain.slice(0, i),
          ...chain.slice(i, j + 1).reverse(),
          ...chain.slice(j + 1),
        ];
        if (pathLen(cand) < pathLen(chain) - 1e-6) {
          chain.splice(0, chain.length, ...cand);
          improved = true;
        }
      }
    }
  }
  return chain;
}

// Stable identity for a feeder across renumbering/regrouping: the
// lowest-numbered member inverter id. Grouping edits that keep the same
// members keep the key; route overrides are stored under it so feeder
// renumbering (adding a substation-side row, regrouping others) never
// silently re-targets a drafter's custom route.
export function feederRouteKey(inverterIds: string[]): string {
  let best = '';
  let bestN = Infinity;
  for (const id of inverterIds) {
    const m = /^inv-(\d+)$/.exec(id);
    const n = m ? Number(m[1]) : Infinity;
    if (!best || n < bestN) { best = id; bestN = n; }
  }
  return best;
}

export function generateFeeders(
  design: SiteDesign,
  substation: Pt,
  blockMW: number,
  opts: FeederOptions = {}
): FeederCircuit[] {
  // A non-finite substation point (NaN/Infinity from a bad caller) would
  // poison every route with NaN coordinates — refuse to route instead.
  if (!Number.isFinite(substation.x) || !Number.isFinite(substation.y)) return [];
  // Fallback tie preference for this pass (see the home-run reroute scoring):
  // pass A prefers the own-run candidate; if the finished comb still crosses,
  // the build retries once with the direct candidate preferred and keeps the
  // better result. Internal — never set by callers.
  const tiePreferDirect = (opts as { _tiePreferDirect?: boolean })._tiePreferDirect === true;
  // Record every warning this pass emits so a winning retry pass can forward
  // only the warnings pass A did NOT already report (the passes can genuinely
  // diverge — e.g. an angled splice may fit one fallback shape but not the
  // other — and the drafter must still hear about the returned result).
  const emittedWarnings = new Set<string>();
  const lateRejectedRouteKeys = new Set<string>();
  {
    const userOnWarning = opts.onWarning;
    opts = {
      ...opts,
      onWarning: (m: string) => { emittedWarnings.add(m); userOnWarning?.(m); },
    };
  }
  const inverters = design.equipment.filter(e => e.kind === 'inverter' && !e.augmented && !e.future);
  if (!inverters.length) return [];
  const byId = new Map(inverters.map(e => [e.id, e]));

  // Start from the deterministic auto groups, then apply overrides.
  // Mirrored-pair (island) layouts get exactly two feeders per island — one
  // per island side (per the reference one-line): south side W->E, north side
  // E->W. Sides run parallel to the PCS line so the chain hops stay short.
  // Hard cap: no MV feeder ever serves more than MAX_INVERTERS_PER_FEEDER
  // (7) built PCS, regardless of what a caller or a stale saved session asks
  // for (plus MAX_FUTURE_PCS_PER_FEEDER reserved future slots = 9 total).
  const maxPer = opts.maxPerFeeder && opts.maxPerFeeder >= 1
    ? Math.min(Math.floor(opts.maxPerFeeder), MAX_INVERTERS_PER_FEEDER)
    : MAX_INVERTERS_PER_FEEDER;
  // Approach axis before grouping: island sides larger than the cap chunk
  // ENTRY-END-FIRST (full feeders fill from the substation end of the row,
  // only the far end carries the remainder), and the entry end is the row
  // end nearest the substation along the approach axis.
  const eqCx = inverters.reduce((s, e) => s + e.x, 0) / inverters.length;
  const eqCy = inverters.reduce((s, e) => s + e.y, 0) / inverters.length;
  const approachAxis = feederApproachAxis(substation, eqCx, eqCy, opts.approach);
  const entryHint: FeederEntryHint = approachAxis.horizApproach
    ? { horiz: true, dir: substation.x >= eqCx ? 1 : -1 }
    : { horiz: false, dir: substation.y >= eqCy ? 1 : -1 };
  // Traced yards have no auto islands, so group along the DRAWN equipment
  // lines (contiguous runs, reference route-map style); everything else
  // keeps the island/generic grouping byte-for-byte.
  const isTracedYard = (design.tracedPcsUnits ?? 0) > 0;
  // Area 2-style yards: PCS long axis east-west. Area 1/3 columns keep the
  // taller pad keep-outs — applying the row rules there opened the DC
  // courtyard as a trench (green through the left yard, purple through 07).
  const tracedHorizontalRows = (() => {
    if (!isTracedYard || inverters.length < 2) return false;
    let nH = 0;
    for (const e of inverters) {
      if (Math.abs(Math.sin(e.rotation)) <= 0.5) nH++;
    }
    return nH >= inverters.length * 0.7;
  })();
  // Static layout routing owns each PCS's local aux-face MV drop onto the
  // under-skid collector. Dynamic feeder circuits own the onward chain/home
  // run to the selected take-off. Join those two layers at the collector end
  // of mv-drop-<PCS id> so hops ride under the PCS rather than a parallel
  // offset beside the aux face.
  const mvRowNodeById = new Map<string, { anchor: Pt; equipmentDelta: Pt }>();
  const rotatedIslandByInv = new Map<string, NonNullable<SiteDesign['islands']>[number]>();
  for (const island of design.islands ?? []) {
    const angle = island.angleDeg != null
      ? (((island.angleDeg % 360) + 360) % 360) * Math.PI / 180
      : island.vertical ? Math.PI / 2 : 0;
    if (Math.abs(angle) < 1e-12) continue;
    for (const id of island.inverterIds) rotatedIslandByInv.set(id, island);
  }
  const mvTapOffset = (e: PlacedEquipment, dropPts: Pt[]): Pt => {
    const island = rotatedIslandByInv.get(e.id);
    if (island) {
      const angle = island.angleDeg != null
        ? (((island.angleDeg % 360) + 360) % 360) * Math.PI / 180
        : Math.PI / 2;
      const localRotation = e.rotation - angle;
      const mirror = Math.cos(localRotation) >= 0 ? 1 : -1;
      const lx = mirror * (e.length / 2 - 1.2);
      const ly = e.width / 2;
      return {
        x: lx * Math.cos(angle) - ly * Math.sin(angle),
        y: lx * Math.sin(angle) + ly * Math.cos(angle),
      };
    }
    // Drawing-traced PCS drops carry tap -> outward stub -> collector. Their
    // connection face is rotation-aware; ordinary row drops retain the
    // historical world-axis tap.
    if (dropPts.length >= 3) {
      const mirror = Math.cos(e.rotation) >= 0 ? 1 : -1;
      const face = -(e.doorEnd ?? -1) * e.width / 2;
      const lx = mirror * (e.length / 2 - 1.2);
      return {
        x: lx * Math.cos(e.rotation) - face * Math.sin(e.rotation),
        y: lx * Math.sin(e.rotation) + face * Math.cos(e.rotation),
      };
    }
    return {
      x: (Math.cos(e.rotation) >= 0 ? 1 : -1) * (e.length / 2 - 1.2),
      y: e.width / 2,
    };
  };
  for (const run of design.cables ?? []) {
    if (run.class !== 'MV' || !run.id.startsWith('mv-drop-') || !run.pts.length) continue;
    const id = run.id.slice('mv-drop-'.length);
    const e = byId.get(id);
    if (!e) continue;
    const tap = run.pts[0];
    const p = run.pts[run.pts.length - 1];
    if (Number.isFinite(tap.x) && Number.isFinite(tap.y) &&
        Number.isFinite(p.x) && Number.isFinite(p.y)) {
      const offset = mvTapOffset(e, run.pts);
      // Cable points are normally regenerated in world space alongside the
      // equipment.  In that case the collector endpoint must be consumed
      // verbatim; treating every tap as a saved local-space origin translates
      // perfectly good (including synthetic/reviewed) collectors a second
      // time when their tap convention differs from ours.
      //
      // There are two real cached-geometry cases which must continue to
      // follow a live PCS edit: traced/rotated drops, and the canonical
      // ordinary four-foot world-Y drop emitted by cableRouting.  Only those
      // geometries provide enough provenance to recover the equipment pose
      // at which the cable was generated.
      const dx = p.x - tap.x;
      const dy = p.y - tap.y;
      const canonicalOrdinaryDrop =
        run.pts.length === 2 &&
        Math.abs(dx) < 1e-9 &&
        (Math.abs(Math.abs(dy) - 4) < 1e-9 ||
         Math.abs(Math.abs(dy) - e.width / 2) < 1e-9);
      const followsEquipment =
        run.pts.length >= 3 ||
        rotatedIslandByInv.has(id) ||
        canonicalOrdinaryDrop;
      const sourceOrigin = {
        x: tap.x - offset.x,
        y: tap.y - offset.y,
      };
      mvRowNodeById.set(id, {
        anchor: { x: p.x, y: p.y },
        equipmentDelta: followsEquipment
          ? { x: e.x - sourceOrigin.x, y: e.y - sourceOrigin.y }
          : { x: 0, y: 0 },
      });
    }
  }
  const feederNodeOf = (e: PlacedEquipment): Pt => {
    const cached = mvRowNodeById.get(e.id);
    return cached
      ? {
          x: cached.anchor.x + cached.equipmentDelta.x,
          y: cached.anchor.y + cached.equipmentDelta.y,
        }
      : { x: e.x, y: e.y };
  };
  let groups = islandGroups(design, maxPer, entryHint)
    ?? (isTracedYard ? tracedLineGroups(inverters, maxPer) : orientedRowGroups(inverters, maxPer))
    ?? autoGroupInverters(inverters, maxPer);
  const assignments = opts.assignments;
  if (assignments && Object.keys(assignments).length) {
    const maxFeeder = Math.max(groups.length, ...Object.values(assignments));
    const buckets: string[][] = Array.from({ length: maxFeeder }, () => []);
    groups.forEach((g, gi) => {
      for (const id of g) {
        const f = assignments[id];
        const target = f && f >= 1 && f <= maxFeeder ? f - 1 : gi;
        buckets[target].push(id);
      }
    });
    groups = buckets.filter(b => b.length > 0);
  }

  const perInvAmps = inverterAmps(blockMW);
  const material: ConductorMaterial = opts.material || 'Al';

  // Fence/equipment-aware routing setup: all yard equipment is an obstacle,
  // except the two pieces a segment connects (a feeder must be able to
  // launch from / land on its own inverter skid).
  const rectById = new Map(design.equipment.map(e => [e.id, equipmentRect(e, 2)]));
  // Underground exclusion areas route exactly like equipment obstacles (they
  // are never "except"-able — no feeder launches from inside one).
  const exclObstacles: Rect[] = exclusionRects(opts.exclusionZones).map(r =>
    ({ x1: r.x1, y1: r.y1, x2: r.x2, y2: r.y2 }));
  // Neighbouring site-area fences (multi-area only): hard keep-outs, never
  // "except"-able — no feeder launches from inside another area's yard.
  const foreignObstacles: Rect[] = foreignFenceRects(opts.foreignFences);
  const obstaclesExcept = (...ids: (string | undefined)[]) => {
    const skip = new Set(ids.filter(Boolean));
    return [
      ...design.equipment.filter(e => !skip.has(e.id)).map(e => rectById.get(e.id)!),
      ...exclObstacles,
      ...foreignObstacles,
    ];
  };
  // Cross-area routing needs room for the detour around every foreign fence,
  // so those corners join the bounds. Empty => single-area bounds unchanged.
  const bounds = routingBounds(design, substation,
    foreignObstacles.flatMap(r => [{ x: r.x1, y: r.y1 }, { x: r.x2, y: r.y2 }]));
  // Padded routing-area bbox: custom route overrides must stay inside it
  // (same guarantee the run-line clamp gives the automatic routes).
  const rbxLo = Math.min(...bounds.map(p => p.x)), rbxHi = Math.max(...bounds.map(p => p.x));
  const rbyLo = Math.min(...bounds.map(p => p.y)), rbyHi = Math.max(...bounds.map(p => p.y));

  // --- Trench-corridor keep-outs (R-TR discipline) --------------------------
  // Island 480V/fiber corridor lanes and reserved future-equipment zones are
  // HARD keep-outs for AUTOMATIC MV routing only — drafter-drawn routes keep
  // the existing validation set (WYSIWYG; a conflict warns, never rejects).
  // The yard's central 480V spine band is CROSSABLE: perpendicular passes
  // are legal, riding along inside it is a violation. No trench geometry on
  // the design => empty lists => routing byte-identical.
  const keep = feederKeepouts(design);
  const hardBands = keep.hard;
  const crossBands = keep.cross;
  const autoObs = (base: Rect[]): Rect[] =>
    (hardBands.length ? base.concat(hardBands) : base);
  // Gate-entrance / apron keep-outs bind HOME-RUN routing (launch ride,
  // climb, corridor and re-lay legs) only — never chain hops between units:
  // traced yards legitimately draw equipment right against (even outside)
  // the fence beside the gate, so a blanket obstacle would make those hops
  // unroutable and the silent blocked-route fallback would lance containers
  // instead. A rect containing the leg's own launch point is dropped for
  // the same reason.
  const gateRects: Rect[] = opts.gateKeepouts ?? [];
  const gateObsFrom = (p: Pt): Rect[] =>
    gateRects.filter(r => !(p.x > r.x1 - 1 && p.x < r.x2 + 1 &&
                            p.y > r.y1 - 1 && p.y < r.y2 + 1));
  // Grid reroute that respects the crossable spine: try the plain route
  // first; if it co-runs the spine, retry with the band as an obstacle
  // PIERCED by perpendicular crossing windows at the leg's own endpoint
  // coordinates. Keep the retry only when it is genuinely clean.
  const routeSegmentTrenchAware = (a: Pt, b: Pt, obs: Rect[]): Pt[] => {
    let r = routeSegment(a, b, obs, bounds);
    if (crossBands.length && bandCoRunViolations(r, crossBands) > 0) {
      const alt = routeSegment(a, b, obs.concat(gappedCrossRects(crossBands, [a, b])), bounds);
      if (!feederCrossesObstacle(alt, obs, a, b) &&
          bandCoRunViolations(alt, crossBands) === 0) r = alt;
    }
    return r;
  };
  const roadAisles = [
    ...(design.aisles ?? []),
    ...(design.roads ?? []),
  ];
  const dcRuns: Pt[][] = (design.cables ?? [])
    .filter(c => c.class === 'DC' && !c.ref && (c.pts?.length ?? 0) >= 2)
    .map(c => c.pts);
  // Battery yards are HARD keep-outs for home runs. Built as one box per
  // pad so the 24 ft drive paths BETWEEN pads stay legal corridors. A single
  // site-wide can-box used to swallow those roads, after which the router
  // had no legal northbound and L-cut through the courtyards instead.
  const clusterRects: Rect[] = [];
  const pushCluster = (x1: number, y1: number, x2: number, y2: number) => {
    if (Number.isFinite(x1) && x2 - x1 > 4 && y2 - y1 > 4) {
      clusterRects.push({ x1, y1, x2, y2 });
    }
  };
  const growTowardPcs = (x1: number, y1: number, x2: number, y2: number): void => {
    let px1 = Infinity, py1 = Infinity, px2 = -Infinity, py2 = -Infinity;
    for (const e of design.equipment) {
      if (e.kind !== 'inverter' || e.augmented || e.future) continue;
      const r = equipmentRect(e, 0);
      const near = r.x2 >= x1 - 50 && r.x1 <= x2 + 50 &&
        r.y2 >= y1 - 50 && r.y1 <= y2 + 50;
      if (!near) continue;
      px1 = Math.min(px1, r.x1); py1 = Math.min(py1, r.y1);
      px2 = Math.max(px2, r.x2); py2 = Math.max(py2, r.y2);
    }
    if (!Number.isFinite(px1)) { pushCluster(x1, y1, x2, y2); return; }
    const pcsSouth = (py1 + py2) / 2 < (y1 + y2) / 2;
    const pcsWest = (px1 + px2) / 2 < (x1 + x2) / 2;
    if (Math.abs((py1 + py2) / 2 - (y1 + y2) / 2) >=
        Math.abs((px1 + px2) / 2 - (x1 + x2) / 2)) {
      y1 = pcsSouth ? Math.min(y1, py2) : y1;
      y2 = pcsSouth ? y2 : Math.max(y2, py1);
    } else {
      x1 = pcsWest ? Math.min(x1, px2) : x1;
      x2 = pcsWest ? x2 : Math.max(x2, px1);
    }
    pushCluster(x1, y1, x2, y2);
  };
  // Prefer the road-network holes: those ARE the equipment pads, and the
  // pavement around them is the legal MV corridor. Traced yards often have
  // one comb-shaped hole spanning a whole row; that box then blocks every
  // south exit and the router combs along the PCS line instead (09/purple).
  if (!tracedHorizontalRows && design.roadNetwork?.islands?.length) {
    for (const segs of design.roadNetwork.islands) {
      let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
      for (const s of segs) {
        if (s.kind === 'line') {
          x1 = Math.min(x1, s.a.x, s.b.x); x2 = Math.max(x2, s.a.x, s.b.x);
          y1 = Math.min(y1, s.a.y, s.b.y); y2 = Math.max(y2, s.a.y, s.b.y);
        } else {
          x1 = Math.min(x1, s.c.x - s.r); x2 = Math.max(x2, s.c.x + s.r);
          y1 = Math.min(y1, s.c.y - s.r); y2 = Math.max(y2, s.c.y + s.r);
        }
      }
      // Island AABBs are often the battery hole only. Grow to the PCS face
      // so the DC courtyard is a keep-out, not a "road" between boxes.
      if (x2 - x1 > 8 && y2 - y1 > 8) growTowardPcs(x1 + 2, y1 + 2, x2 - 2, y2 - 2);
    }
  }
  if (!tracedHorizontalRows) {
    for (const isl of design.islands ?? []) {
      const idSet = new Set(isl.inverterIds ?? []);
      let bx1 = Infinity, by1 = Infinity, bx2 = -Infinity, by2 = -Infinity;
      for (const e of design.equipment) {
        if (e.kind !== 'bess') continue;
        const m = /^bess-(\d+)-/.exec(e.id);
        const named = !!(m && idSet.has(`inv-${m[1]}`));
        const owned = idSet.has(e.id);
        if (!named && !owned) {
          if (!idSet.size) continue;
          const nearPcs = design.equipment.some(p =>
            p.kind === 'inverter' && idSet.has(p.id) &&
            Math.hypot(p.x - e.x, p.y - e.y) < 80);
          if (!nearPcs) continue;
        }
        const r = equipmentRect(e, 0);
        bx1 = Math.min(bx1, r.x1); by1 = Math.min(by1, r.y1);
        bx2 = Math.max(bx2, r.x2); by2 = Math.max(by2, r.y2);
      }
      if (Number.isFinite(bx1)) growTowardPcs(bx1, by1, bx2, by2);
    }
  }
  {
    const boxes = design.equipment
      .filter(e => (e.kind === 'bess' || e.kind === 'inverter') && !e.augmented && !e.future)
      .map(e => equipmentRect(e, 1));
    const parent = boxes.map((_, i) => i);
    const find = (i: number): number =>
      parent[i] === i ? i : (parent[i] = find(parent[i]));
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i], b = boxes[j];
        const dx = Math.max(0, Math.max(a.x1 - b.x2, b.x1 - a.x2));
        const dy = Math.max(0, Math.max(a.y1 - b.y2, b.y1 - a.y2));
        const xOv = Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1);
        const yOv = Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1);
        // Same column of a pad (overlap in X): merge along the whole island.
        // Side-by-side across a DC aisle or the ~10 ft PCS-to-PCS gap in a
        // traced row — never across a 24 ft drive path.
        const sameColumn = xOv > 4 && dy < (tracedHorizontalRows ? 18 : 40);
        const dcAisle = yOv > 4 && dx < 20;
        if (sameColumn || dcAisle) {
          const ra = find(i), rb = find(j);
          if (ra !== rb) parent[rb] = ra;
        }
      }
    }
    const groups = new Map<number, Rect[]>();
    boxes.forEach((r, i) => {
      const k = find(i);
      const g = groups.get(k);
      if (g) g.push(r); else groups.set(k, [r]);
    });
    for (const g of Array.from(groups.values())) {
      let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
      for (const r of g) {
        x1 = Math.min(x1, r.x1); y1 = Math.min(y1, r.y1);
        x2 = Math.max(x2, r.x2); y2 = Math.max(y2, r.y2);
      }
      growTowardPcs(x1, y1, x2, y2);
    }
  }
  // Individual container footprints stay keep-outs even when pad merge
  // leaves a 10 ft gap the trench could thread (Area 2 blue through CON).
  for (const e of design.equipment) {
    if (e.kind !== 'bess' || e.augmented || e.future) continue;
    const r = equipmentRect(e, 2);
    pushCluster(r.x1, r.y1, r.x2, r.y2);
  }
  // Close the PCS–battery courtyard even when island AABBs leave it open.
  // Gaps under 22 ft are DC aisles; 24 ft drive paths between pads stay open.
  {
    const pcsBoxes = design.equipment
      .filter(e => e.kind === 'inverter' && !e.augmented && !e.future)
      .map(e => equipmentRect(e, 2));
    const canBoxes = design.equipment
      .filter(e => e.kind === 'bess' && !e.augmented && !e.future)
      .map(e => equipmentRect(e, 2));
    for (const a of pcsBoxes) {
      for (const b of canBoxes) {
        const xOv = Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1);
        const yOv = Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1);
        const dx = Math.max(0, Math.max(a.x1 - b.x2, b.x1 - a.x2));
        const dy = Math.max(0, Math.max(a.y1 - b.y2, b.y1 - a.y2));
        const PAST = 12;
        if (xOv > 2 && dy > 0 && dy < 28) {
          const y1 = Math.min(a.y2, b.y2);
          const y2 = Math.max(a.y1, b.y1);
          // Pad width only — padding X ate the west road in Area 4 and the
          // trunk then had no legal northbound except through CON columns.
          if (y2 > y1 + 1) {
            pushCluster(Math.min(a.x1, b.x1), y1, Math.max(a.x2, b.x2), y2);
          }
        }
        if (yOv > 2 && dx > 0 && dx < 28) {
          const x1 = Math.min(a.x2, b.x2);
          const x2 = Math.max(a.x1, b.x1);
          if (x2 > x1 + 1) {
            pushCluster(
              x1, Math.min(a.y1, b.y1) - PAST,
              x2, Math.max(a.y2, b.y2) + PAST);
          }
        }
      }
    }
  }
  // Solid no-go yard: this PCS's batteries plus the DC courtyard up to the
  // PCS face. Internal 3 ft gaps and the cable fan sit inside the AABB so
  // a feeder cannot thread the cluster. The road on the opposite PCS face
  // stays open. Each container is owned by its nearest PCS so a 24 ft
  // drive between pads is not swallowed.
  {
    const pcsList = design.equipment.filter(e =>
      e.kind === 'inverter' && !e.augmented && !e.future);
    const ownerOf = (o: PlacedEquipment): PlacedEquipment | null => {
      let best: PlacedEquipment | null = null, bestD = Infinity;
      for (const p of pcsList) {
        const d = Math.hypot(p.x - o.x, p.y - o.y);
        if (d < bestD) { bestD = d; best = p; }
      }
      return bestD < 90 ? best : null;
    };
    const faceVote = new Map<string, { n: number; s: number; east: number; w: number }>();
    for (const e of pcsList) {
      const pcs = equipmentRect(e, 2);
      const cans: Rect[] = [];
      let n = 0, s = 0, east = 0, w = 0;
      for (const o of design.equipment) {
        if (o.kind !== 'bess' || o.augmented || o.future) continue;
        if (ownerOf(o) !== e) continue;
        cans.push(equipmentRect(o, 2));
        const dx = o.x - e.x, dy = o.y - e.y;
        if (Math.abs(dy) >= Math.abs(dx)) {
          if (dy >= 0) n++; else s++;
        } else if (dx >= 0) east++;
        else w++;
      }
      faceVote.set(e.id, { n, s, east, w });
      if (!cans.length) continue;
      let x1 = Math.min(pcs.x1, ...cans.map(r => r.x1));
      let y1 = Math.min(pcs.y1, ...cans.map(r => r.y1));
      let x2 = Math.max(pcs.x2, ...cans.map(r => r.x2));
      let y2 = Math.max(pcs.y2, ...cans.map(r => r.y2));
      if (n + s >= east + w) {
        if (n > s) y1 = pcs.y2;
        else if (s > n) y2 = pcs.y1;
      } else if (east > w) x1 = pcs.x2;
      else if (w > east) x2 = pcs.x1;
      pushCluster(x1, y1, x2, y2);
    }
    // Sandwich yard (Area 3/4): PCS on opposite faces of the same can
    // field. Per-PCS boxes leave a hole down the middle AND between
    // adjacent skids in the row (09 between PCS07-02 and 07-01). Fill the
    // full interior between the two facing rows. Two parallel yards facing
    // AWAY across a road do not match — their cans point into their own pads.
    const rowMates = (e: PlacedEquipment, horiz: boolean) =>
      pcsList.filter(o => horiz
        ? Math.abs(o.y - e.y) < 16
        : Math.abs(o.x - e.x) < 16);
    const seenSandwich = new Set<string>();
    for (let i = 0; i < pcsList.length; i++) {
      for (let j = i + 1; j < pcsList.length; j++) {
        const p = pcsList[i], q = pcsList[j];
        const pr = equipmentRect(p, 2), qr = equipmentRect(q, 2);
        const xOv = Math.min(pr.x2, qr.x2) - Math.max(pr.x1, qr.x1);
        const yOv = Math.min(pr.y2, qr.y2) - Math.max(pr.y1, qr.y1);
        const pv = faceVote.get(p.id) ?? { n: 0, s: 0, east: 0, w: 0 };
        const qv = faceVote.get(q.id) ?? { n: 0, s: 0, east: 0, w: 0 };
        if (xOv > 8 && Math.abs(p.y - q.y) > 24 && Math.abs(p.y - q.y) < 500) {
          const nv = p.y > q.y ? pv : qv;
          const sv = p.y > q.y ? qv : pv;
          if (nv.s > nv.n && sv.n > sv.s) {
            const north = p.y > q.y ? p : q;
            const south = p.y > q.y ? q : p;
            const lo = Math.min(north.y, south.y) + 12;
            const hi = Math.max(north.y, south.y) - 12;
            const intervening = pcsList.some(o =>
              o !== north && o !== south && o.y > lo && o.y < hi &&
              Math.min(equipmentRect(o, 2).x2, Math.max(pr.x2, qr.x2)) -
              Math.max(equipmentRect(o, 2).x1, Math.min(pr.x1, qr.x1)) > 8);
            if (!intervening) {
              const nMates = rowMates(north, true).filter(e => {
                const v = faceVote.get(e.id); return v && v.s > v.n;
              });
              const sMates = rowMates(south, true).filter(e => {
                const v = faceVote.get(e.id); return v && v.n > v.s;
              });
              const key = `ns:${[...nMates, ...sMates].map(e => e.id).sort().join(',')}`;
              if (nMates.length && sMates.length && !seenSandwich.has(key)) {
                seenSandwich.add(key);
                const nRects = nMates.map(e => equipmentRect(e, 2));
                const sRects = sMates.map(e => equipmentRect(e, 2));
                const y1 = Math.max(...sRects.map(r => r.y2));
                const y2 = Math.min(...nRects.map(r => r.y1));
                if (y2 - y1 > 4) {
                  pushCluster(
                    Math.min(...nRects.concat(sRects).map(r => r.x1)), y1,
                    Math.max(...nRects.concat(sRects).map(r => r.x2)), y2);
                }
              }
            }
          }
        }
        if (yOv > 8 && Math.abs(p.x - q.x) > 24 && Math.abs(p.x - q.x) < 500) {
          const ev = p.x > q.x ? pv : qv;
          const wv = p.x > q.x ? qv : pv;
          if (ev.w > ev.east && wv.east > wv.w) {
            const eastE = p.x > q.x ? p : q;
            const westE = p.x > q.x ? q : p;
            const lo = Math.min(eastE.x, westE.x) + 12;
            const hi = Math.max(eastE.x, westE.x) - 12;
            const intervening = pcsList.some(o =>
              o !== eastE && o !== westE && o.x > lo && o.x < hi &&
              Math.min(equipmentRect(o, 2).y2, Math.max(pr.y2, qr.y2)) -
              Math.max(equipmentRect(o, 2).y1, Math.min(pr.y1, qr.y1)) > 8);
            if (!intervening) {
              const eMates = rowMates(eastE, false).filter(e => {
                const v = faceVote.get(e.id); return v && v.w > v.east;
              });
              const wMates = rowMates(westE, false).filter(e => {
                const v = faceVote.get(e.id); return v && v.east > v.w;
              });
              const key = `ew:${[...eMates, ...wMates].map(e => e.id).sort().join(',')}`;
              if (eMates.length && wMates.length && !seenSandwich.has(key)) {
                seenSandwich.add(key);
                const eRects = eMates.map(e => equipmentRect(e, 2));
                const wRects = wMates.map(e => equipmentRect(e, 2));
                const x1 = Math.max(...wRects.map(r => r.x2));
                const x2 = Math.min(...eRects.map(r => r.x1));
                if (x2 - x1 > 4) {
                  pushCluster(
                    x1, Math.min(...eRects.concat(wRects).map(r => r.y1)),
                    x2, Math.max(...eRects.concat(wRects).map(r => r.y2)));
                }
              }
            }
          }
        }
      }
    }
  }
  // Peel pad = this PCS plus its own batteries only. Merged row keep-outs
  // above must not drag a feeder to a neighbor pad's far face (09→west).
  const peelPadOf = (e: PlacedEquipment): Rect => {
    const r0 = equipmentRect(e, 2);
    let x1 = r0.x1, y1 = r0.y1, x2 = r0.x2, y2 = r0.y2;
    for (const o of design.equipment) {
      if (o.kind !== 'bess' || o.augmented || o.future) continue;
      if (Math.hypot(o.x - e.x, o.y - e.y) > 30) continue;
      const r = equipmentRect(o, 2);
      x1 = Math.min(x1, r.x1); y1 = Math.min(y1, r.y1);
      x2 = Math.max(x2, r.x2); y2 = Math.max(y2, r.y2);
    }
    return { x1, y1, x2, y2 };
  };
  const bessVote = (e: PlacedEquipment) => {
    let n = 0, s = 0, east = 0, w = 0;
    for (const o of design.equipment) {
      if (o.kind !== 'bess' || o.augmented || o.future) continue;
      const dx = o.x - e.x, dy = o.y - e.y;
      const d = Math.hypot(dx, dy);
      // Area 4 cans sit ~60 ft west of the skid; 36 ft treated those pads
      // as empty and the first hop went west through CON.
      if (d >= 90) continue;
      let owned = true;
      for (const p of inverters) {
        if (p.id === e.id) continue;
        if (Math.hypot(o.x - p.x, o.y - p.y) < d - 0.1) { owned = false; break; }
      }
      if (!owned) continue;
      if (Math.abs(dy) >= Math.abs(dx)) {
        if (dy >= 0) n++; else s++;
      } else if (dx >= 0) east++;
      else w++;
    }
    return { n, s, east, w };
  };
  // Union of this vertical PCS stack plus the containers it owns. West
  // takeoff must leave at the north/south of THIS box, not at PCS Y
  // through the can field (Area 3/4).
  const columnYardOf = (e: PlacedEquipment): Rect => {
    const mates = inverters.filter(o => Math.abs(o.x - e.x) < 18);
    const seed = mates.length ? mates : [e];
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const p of seed) {
      const r = equipmentRect(p, 2);
      x1 = Math.min(x1, r.x1); y1 = Math.min(y1, r.y1);
      x2 = Math.max(x2, r.x2); y2 = Math.max(y2, r.y2);
    }
    for (const o of design.equipment) {
      if (o.kind !== 'bess' || o.augmented || o.future) continue;
      const near = seed.some(p => Math.hypot(o.x - p.x, o.y - p.y) < 90);
      if (!near) continue;
      const r = equipmentRect(o, 2);
      x1 = Math.min(x1, r.x1); y1 = Math.min(y1, r.y1);
      x2 = Math.max(x2, r.x2); y2 = Math.max(y2, r.y2);
    }
    return { x1, y1, x2, y2 };
  };
  const columnRoadX = (e: PlacedEquipment): number => {
    const pcs = equipmentRect(e, 2);
    const { east, w } = bessVote(e);
    // West takeoff: the can field is between the skid and the road.
    // Launching west at PCS Y is the Area 4 cut. Leave the east face
    // and ride around the north/south of the yard instead.
    if (approachAxis.horizApproach && approachAxis.dirX < 0) return pcs.x2 + 8;
    if (approachAxis.horizApproach && approachAxis.dirX > 0) return pcs.x1 - 8;
    if (east > w) return pcs.x1 - 8;
    return pcs.x2 + 8;
  };
  const columnEdgeY = (e: PlacedEquipment): number => {
    const local = columnYardOf(e);
    let y1 = local.y1, y2 = local.y2;
    for (const r of clusterRects) y1 = Math.min(y1, r.y1), y2 = Math.max(y2, r.y2);
    const yLo = y1 - 8, yHi = y2 + 8;
    return Math.abs(yHi - substation.y) <= Math.abs(yLo - substation.y) ? yHi : yLo;
  };
  const columnTurnY = (climb: number): number => {
    if (!clusterRects.length) return climb;
    const lo = Math.min(...clusterRects.map(r => r.y1)) - 8;
    const hi = Math.max(...clusterRects.map(r => r.y2)) + 8;
    return approachAxis.dirY > 0 ? Math.max(climb, hi) : Math.min(climb, lo);
  };
  const columnToward = (e: PlacedEquipment, start: Pt): Pt =>
    ({ x: columnRoadX(e), y: start.y });
  // First hop off a column PCS: the skid END away from its batteries (the
  // road / drive), never along the DC courtyard even when that is toward
  // the take-off. peelPadOf includes the cans, so pad.y2+8 was a trench
  // down through CON (Area 4 yellow/teal, Area 1 red).
  const pcsRoadToward = (e: PlacedEquipment, start: Pt): Pt => {
    const r = equipmentRect(e, 2);
    const { n, s, east, w } = bessVote(e);
    const west = { x: r.x1 - 8, y: start.y };
    const eastPt = { x: r.x2 + 8, y: start.y };
    const south = { x: start.x, y: r.y1 - 8 };
    const north = { x: start.x, y: r.y2 + 8 };
    const intoCans = (goEast: boolean | null, goNorth: boolean | null) => {
      if (goEast !== null) return goEast ? east - w > 1 : w - east > 1;
      return goNorth ? n - s > 1 : s - n > 1;
    };
    const pickHoriz = (goEast: boolean) => goEast ? eastPt : west;
    const pickVert = (goNorth: boolean) => goNorth ? north : south;
    const wantEast = substation.x >= start.x;
    const wantNorth = substation.y >= start.y;
    const ns = n + s, ew = east + w;
    // Road face = opposite the battery cloud. Approach-axis toward the
    // take-off is used only when that hop is not into cans — otherwise
    // the bottom-of-column south exit drops into the DC courtyard (Area 1
    // red) and the top-of-column south exit drops into CON (Area 4).
    if (ew > ns) return pickHoriz(w > east);
    if (ns > ew) {
      if (approachAxis.horizApproach && !intoCans(wantEast, null)) {
        return pickHoriz(wantEast);
      }
      if (!approachAxis.horizApproach && !intoCans(null, s > n)) {
        return pickVert(s > n);
      }
      return pickHoriz(intoCans(wantEast, null) ? w > east : wantEast);
    }
    if (approachAxis.horizApproach) {
      if (!intoCans(wantEast, null)) return pickHoriz(wantEast);
      if (!intoCans(null, wantNorth)) return pickVert(wantNorth);
    } else {
      if (!intoCans(null, wantNorth)) return pickVert(wantNorth);
      if (!intoCans(wantEast, null)) return pickHoriz(wantEast);
    }
    return approachAxis.horizApproach ? pickHoriz(wantEast) : pickVert(wantNorth);
  };
  // Coordinate of the drive face (opposite this PCS's batteries) — used
  // when a run line would otherwise sit in the 14 ft DC courtyard.
  const pcsRoadFaceCoord = (e: PlacedEquipment, rideX: boolean): number => {
    const r = equipmentRect(e, 2);
    const { n, s, east, w } = bessVote(e);
    if (rideX) return east >= w ? r.x1 - 8 : r.x2 + 8;
    return n >= s ? r.y1 - 8 : r.y2 + 8;
  };
  const peelRoadCoord = (e: PlacedEquipment, start: Pt, rideX: boolean): number => {
    const pad = peelPadOf(e);
    const a = rideX ? pad.x1 - 16 : pad.y1 - 16;
    const b = rideX ? pad.x2 + 16 : pad.y2 + 16;
    const s = rideX ? start.x : start.y;
    const hook = (c: number): Pt[] => rideX
      ? [start, { x: c, y: start.y }]
      : [start, { x: start.x, y: c }];
    const hit = (c: number) => {
      const others = clusterRects.filter(r =>
        r.x2 < pad.x1 - 1 || r.x1 > pad.x2 + 1 ||
        r.y2 < pad.y1 - 1 || r.y1 > pad.y2 + 1);
      return others.length > 0 &&
        feederCrossesObstacle(hook(c), others, start, hook(c)[1]);
    };
    const nearer = Math.abs(a - s) <= Math.abs(b - s) ? a : b;
    const farther = nearer === a ? b : a;
    if (hit(nearer) && !hit(farther) && Math.abs(farther - s) < 48) return farther;
    return nearer;
  };
  const equipmentExemptRect = (e: PlacedEquipment): Rect => {
    const hl = e.length / 2 + 1, hw = e.width / 2 + 1;
    const cs = Math.abs(Math.cos(e.rotation)), sn = Math.abs(Math.sin(e.rotation));
    const hx = hl * cs + hw * sn, hy = hl * sn + hw * cs;
    return { x1: e.x - hx, y1: e.y - hy, x2: e.x + hx, y2: e.y + hy };
  };
  const cableKeepOutFrom = (runs: Pt[][], exemptEq: PlacedEquipment[]): Rect[] =>
    punchKeepoutRects(
      trenchKeepOutRects(runs, 1.25),
      exemptEq.map(equipmentExemptRect),
    );
  // Drafter route overrides: keys consumed by a live feeder, and the gi's of
  // circuits whose home run is drafter-drawn (the collinear separation pass
  // must never re-lay those — they are WYSIWYG).
  const consumedRouteKeys = new Set<string>();
  const customRouted = new Set<number>();
  // Per-custom-route bookkeeping for the collinear separation pass: the
  // automatic route to revert to if the drawn route would read as a
  // combined trunk, plus the key/forced flag for the warning.
  const customMeta = new Map<number, { key: string; auto: Pt[]; forced: boolean }>();

  // Feeder NUMBERING order: groups ordered by centroid — north→south for
  // an east/west substation, west→east for a north/south substation — so
  // schedules read geographically. PHYSICAL lanes are dealt separately
  // below, by each feeder's chain-end exit position, so home runs nest
  // like a comb and never cross regardless of numbering.
  const { horizApproach } = approachAxis;
  const linesVertical = (() => {
    if (tracedHorizontalRows) return false;
    if (isTracedYard && inverters.length >= 2) {
      let nV = 0;
      for (const e of inverters) {
        if (Math.abs(Math.sin(e.rotation)) > 0.5) nV++;
      }
      if (nV >= inverters.length * 0.7) return true;
    }
    return tracedLinesVertical(inverters);
  })();

  const centroidOf = (ids: string[]) => {
    const ms = ids.map(id => byId.get(id)!).filter(Boolean);
    const n = Math.max(1, ms.length);
    return {
      x: ms.reduce((s, e) => s + e.x, 0) / n,
      y: ms.reduce((s, e) => s + e.y, 0) / n,
    };
  };
  // Drafter feeder-group overrides keep their bucket order as the lane
  // order: the numbers the drafter assigned reference the feeder numbers as
  // displayed (already lane-ordered), so re-sorting would silently renumber
  // their groups. Auto groups get the geometric north→south lane order.
  const hasAssignments = !!(assignments && Object.keys(assignments).length);
  const ordered = hasAssignments
    ? groups.map(ids => ({ ids }))
    : groups
        .map(ids => ({ ids, c: centroidOf(ids) }))
        .sort((a, b) =>
          horizApproach
            ? (b.c.y - a.c.y) || (a.c.x - b.c.x) || a.ids[0].localeCompare(b.ids[0])
            : (a.c.x - b.c.x) || (b.c.y - a.c.y) || a.ids[0].localeCompare(b.ids[0])
        );

  // 34.5 kV feeders route DIRECTLY from their PCS chain end to the
  // substation — they never terminate at or pass through a feeder junction
  // box. Per reference CAR-D-B005-0 the FJBs carry only the fiber-optic
  // communications loop; the MV home runs bypass them entirely. Island
  // membership is still tracked so island chains keep the 2-opt ordering
  // refinement (the greedy wrap-around fix the drafters flagged).
  const islandOfInv = new Map<string, number>();
  if (design.islands) {
    for (const isl of design.islands) for (const id of isl.inverterIds) islandOfInv.set(id, isl.n);
  }
  const isIslandGroup = (ids: string[]): boolean => {
    if (!islandOfInv.size || !ids.length) return false;
    const ns = new Set(ids.map(id => islandOfInv.get(id)));
    return !ns.has(undefined) && ns.size === 1;
  };

  // Pick the row end opposite its augmentation reserve. The supplied route
  // maps place future PCS at end-of-line and enter every built row from the
  // non-augmentation end. Island reserves have stable island-aug-N-* ids;
  // traced/generic yards use their explicit augmented/future PCS references.
  // Ambiguous reserves (balanced at both ends) deliberately return null and
  // retain the existing substation/field-edge anchor.
  const nonAugmentationAnchor = (
    ids: string[], members: PlacedEquipment[], nodes: Pt[]
  ): Pt | null => {
    if (nodes.length < 2) return null;
    let ai = 0, bi = 1, span = -1;
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const d = dist(nodes[i], nodes[j]);
        if (d > span) { span = d; ai = i; bi = j; }
      }
    }
    if (span < 1) return null;
    const ux = (nodes[bi].x - nodes[ai].x) / span;
    const uy = (nodes[bi].y - nodes[ai].y) / span;
    const origin = nodes[ai];
    const along = (p: Pt) => (p.x - origin.x) * ux + (p.y - origin.y) * uy;
    const across = (p: Pt) => Math.abs(-(p.x - origin.x) * uy + (p.y - origin.y) * ux);
    const rowAlong = nodes.map(along);
    const lo = Math.min(...rowAlong), hi = Math.max(...rowAlong);
    if (hi - lo < 1) return null;

    const islandN = isIslandGroup(ids) ? islandOfInv.get(ids[0]) : undefined;
    let refs: Pt[] = [];
    if (islandN !== undefined) {
      refs = (design.reservedZones ?? [])
        .filter(z => z.kind === 'futureAug' &&
          new RegExp(`^island-aug-${islandN}-\\d+$`).test(z.id))
        .map(z => ({ x: z.x, y: z.y }));
    }
    if (!refs.length) {
      refs = [
        ...(design.futureEquipment ?? []).filter(e => e.kind === 'inverter'),
        ...design.equipment.filter(e => e.kind === 'inverter' && (e.augmented || e.future)),
      ].map(e => ({ x: e.x, y: e.y }));
    }
    // Keep only references plausibly belonging to this row/island. The
    // island reserve is centered between its two PCS rows, so the across-row
    // allowance must include the standard ~119 ft island gap.
    const useful = refs.filter(p => {
      const s = along(p);
      return across(p) <= 150 && s >= lo - 4 * span && s <= hi + 4 * span;
    });
    if (!useful.length) return null;
    const mean = useful.reduce((s, p) => s + along(p), 0) / useful.length;
    const mid = (lo + hi) / 2;
    if (Math.abs(mean - mid) <= Math.max(5, (hi - lo) * 0.1)) return null;

    // Aug at high end => entry at low end, and vice versa. Extend the anchor
    // beyond the selected end so the direct row sort ends there deterministically.
    const entryAtLow = mean > mid;
    const targetS = entryAtLow ? lo : hi;
    const target = nodes.reduce((best, p) =>
      Math.abs(along(p) - targetS) < Math.abs(along(best) - targetS) ? p : best, nodes[0]);
    const sign = entryAtLow ? -1 : 1;
    return { x: target.x + sign * ux * 500, y: target.y + sign * uy * 500 };
  };

  // Direct row ordering replaces greedy nearest-neighbour whenever all
  // members lie on one line. It is orientation-independent and guarantees
  // monotone far-end -> entry-end progression, so every internal section is
  // one straight trunk span with no elbow or diagonal zigzag.
  const rowOrderedChain = (
    members: PlacedEquipment[], anchor: Pt
  ): PlacedEquipment[] | null => {
    if (members.length < 2) return [...members];
    let ai = 0, bi = 1, span = -1;
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        const d = dist(members[i], members[j]);
        if (d > span) { span = d; ai = i; bi = j; }
      }
    }
    if (span < 1) return null;
    const a = members[ai], b = members[bi];
    const ux = (b.x - a.x) / span, uy = (b.y - a.y) / span;
    if (members.some(m => Math.abs(-(m.x - a.x) * uy + (m.y - a.y) * ux) > 2)) {
      return null;
    }
    const sorted = [...members].sort((m, n) =>
      ((m.x - a.x) * ux + (m.y - a.y) * uy) -
      ((n.x - a.x) * ux + (n.y - a.y) * uy) ||
      m.id.localeCompare(n.id));
    if (dist(sorted[0], anchor) <= dist(sorted[sorted.length - 1], anchor)) {
      sorted.reverse();
    }
    return sorted;
  };
  const isContiguousPhysicalRow = (
    ids: string[], members: PlacedEquipment[]
  ): boolean => {
    if (members.length <= 1) return true;
    const nodes = members.map(feederNodeOf);
    let ai = 0, bi = 1, span = -1;
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const d = dist(nodes[i], nodes[j]);
        if (d > span) { span = d; ai = i; bi = j; }
      }
    }
    if (span < 1) return false;
    const origin = nodes[ai];
    const ux = (nodes[bi].x - origin.x) / span;
    const uy = (nodes[bi].y - origin.y) / span;
    const along = (p: Pt) => (p.x - origin.x) * ux + (p.y - origin.y) * uy;
    const across = (p: Pt) => Math.abs(-(p.x - origin.x) * uy + (p.y - origin.y) * ux);
    const memberAlong = nodes.map(along);
    const lo = Math.min(...memberAlong), hi = Math.max(...memberAlong);
    if (nodes.some(p => across(p) > 2)) return false;
    const memberIds = new Set(ids);
    // A manual group may take a contiguous slice of a longer physical row,
    // but it may not skip another built PCS inside its collector span.
    return !inverters.some(e => {
      if (memberIds.has(e.id)) return false;
      const p = feederNodeOf(e);
      const s = along(p);
      return across(p) <= 2 && s > lo + 0.1 && s < hi - 0.1;
    });
  };

  // Breaker-position circuit names (#14A1 …): assigned in FINAL feeder
  // order; letters group one island's feeders and never span islands, two
  // sub-circuits per letter, two letters per breaker, breakers from 14.
  const feederNames = assignFeederNames(
    ordered.map(({ ids }) => (isIslandGroup(ids) ? (islandOfInv.get(ids[0]) ?? null) : null)));

  const feederCount = ordered.length;

  // --- Per-feeder augmentation reserve tie (register F-02/F-03) -----------
  // Reserved future-aug blocks are electrically tied to the feeders they
  // will land on, so EOL PCS/container counts derive from what is actually
  // reserved (never a hardcoded +2). Island layouts: each island-aug unit
  // holds 2 future PCS on that island's strip; its blocks split across the
  // island's feeder sides. Non-island layouts: detached future-blk units
  // spread evenly across all feeders. Cap = MAX_FUTURE_PCS_PER_FEEDER.
  const islandAugUnits = new Map<number, number>();
  const detachedAugUnits = (design.reservedZones ?? []).reduce((s, z) => {
    if (z.kind !== 'futureAug') return s;
    const m = /^island-aug-(\d+)-\d+$/.exec(z.id);
    if (m) {
      const n = Number(m[1]);
      islandAugUnits.set(n, (islandAugUnits.get(n) ?? 0) + 1);
      return s;
    }
    return s + 1;
  }, 0);
  const islandSideCount = new Map<number, number>();
  for (const isl of design.islands ?? []) {
    islandSideCount.set(isl.n,
      (isl.southIds.length ? 1 : 0) + (isl.northIds.length ? 1 : 0));
  }
  // Traced augmentation PCS (KMZ auto-fill): each augmented unit is reserved
  // future capacity on the feeder of its NEAREST built PCS — never a built
  // circuit of its own (fixed standard: 7 built + up to 2 future per feeder).
  const tracedAugByOwner = new Map<string, number>();
  {
    const augInvs = design.equipment.filter(e => e.kind === 'inverter' && e.augmented);
    for (const a of augInvs) {
      let owner: string | null = null;
      let bd = Infinity;
      for (const i of inverters) {
        const d = Math.hypot(i.x - a.x, i.y - a.y);
        if (d < bd) { bd = d; owner = i.id; }
      }
      if (owner) tracedAugByOwner.set(owner, (tracedAugByOwner.get(owner) ?? 0) + 1);
    }
  }
  const futurePcsFor = (ids: string[]): number => {
    const tracedAug = ids.reduce((s, id) => s + (tracedAugByOwner.get(id) ?? 0), 0);
    if (tracedAug > 0) return Math.min(MAX_FUTURE_PCS_PER_FEEDER, tracedAug);
    const ns = new Set(ids.map(id => islandOfInv.get(id)));
    if (ns.size === 1 && !ns.has(undefined)) {
      const n = Array.from(ns)[0] as number;
      const units = islandAugUnits.get(n) ?? 0;
      const sides = Math.max(1, islandSideCount.get(n) ?? 1);
      // Each unit = 2 future PCS blocks shared by the island's feeder sides.
      return Math.min(MAX_FUTURE_PCS_PER_FEEDER, Math.floor((units * 2) / sides));
    }
    // Non-island (or mixed) feeder: even split of the detached grid reserve.
    return Math.min(MAX_FUTURE_PCS_PER_FEEDER,
      Math.floor((detachedAugUnits * 2) / Math.max(1, feederCount)));
  };

  // Corridor geometry: the parallel lanes and the per-feeder climb legs
  // live OUTSIDE the fence, in the strip between the fence and the
  // substation, where there is no equipment to dodge. Each feeder exits
  // the yard along its own run line, climbs onto its own lane at its own
  // climb line, and rides the lane to the substation approach.
  // Shared with generateAuxFeeder so the aux lane lands parallel to (and one
  // trench spacing beyond) this bundle. horizApproach is recomputed here from
  // the same inputs, so the frame always agrees with it.
  const frame = feederCorridorFrame(design, substation, opts.corridorPin, maxPer, opts.approach)!;
  const { dirX, dirY, climbBase, laneCenter } = frame;
  // Approach-side edge of the equipment field. Prior home-run keep-outs are
  // clipped here: when the take-off sits inside the fence, climbBase is the
  // far fence and would otherwise treat the whole corridor climb as "in-yard",
  // blocking every nested peel.
  let fieldExitAlong = NaN;
  {
    let lo = Infinity, hi = -Infinity;
    for (const e of design.equipment) {
      if (e.kind !== 'bess' && e.kind !== 'inverter') continue;
      const r = equipmentRect(e, 0);
      if (horizApproach) { lo = Math.min(lo, r.x1); hi = Math.max(hi, r.x2); }
      else { lo = Math.min(lo, r.y1); hi = Math.max(hi, r.y2); }
    }
    if (Number.isFinite(lo)) {
      fieldExitAlong = (horizApproach ? dirX : dirY) > 0 ? hi : lo;
    }
  }
  // Climb in the strip BETWEEN the yards and the take-off. The corridor
  // frame's climbBase is the far fence; when the take-off sits inside the
  // fence that origin is PAST the substation and every feeder turns on one
  // line — the yellow/teal × PCS05 crossings at the top of the yard.
  const climbOrigin = (() => {
    const dir = horizApproach ? dirX : dirY;
    const beforeTakeoff = (horizApproach ? substation.x : substation.y)
      - dir * SUBSTATION_APPROACH_FT;
    const pastYards = Number.isFinite(fieldExitAlong)
      ? fieldExitAlong + dir * 16
      : climbBase;
    return dir > 0
      ? Math.min(pastYards, beforeTakeoff)
      : Math.max(pastYards, beforeTakeoff);
  })();

  // Run-line stagger: two chain ends sharing the same row (or column)
  // would exit the yard along coincident lines. Keep every run line at
  // least a trench spacing away from all other run lines AND from every
  // lane, shifting toward the substation centerline until distinct.
  const usedRunCoords: number[] = [];
  for (let gi = 0; gi < feederCount; gi++) {
    const spread = horizApproach
      ? ((feederCount - 1) / 2 - gi) * FEEDER_TRENCH_SPACING_FT
      : (gi - (feederCount - 1) / 2) * FEEDER_TRENCH_SPACING_FT;
    usedRunCoords.push(laneCenter + spread);
  }
  // A run line must also be CLEAR of equipment along its whole in-yard leg:
  // with dense inverter rows the chain-end row is full of other inverters,
  // and a run at the raw row coordinate would need a grid reroute whose
  // arbitrary detour can cross another feeder's run — breaking the
  // crossing-free comb. Shift until both distinct and clear (bounded).
  //
  // ORDER-PRESERVING: run coordinates are assigned in raw exit order and may
  // only shift in the fixed exit-order direction (south for an east/west
  // approach, east for north/south). Shifting toward the centerline from
  // both sides can INVERT the exit order (a north exit shifted south of a
  // south exit shifted north) — then the launch drop from a chain end to
  // its far-away run line slices across the swapped feeder's run.
  //
  // HARD SPATIAL CLAMP: run coordinates may never leave the padded routing
  // bounds. If the stagger (or the monotone seed) would push a run line past
  // the bbox edge, it stops AT the edge and the caller is warned via
  // opts.onWarning — failing fast and visibly instead of silently drawing a
  // trench wherever the 200-iteration guard happened to stop.
  const runLo = horizApproach ? bounds[0].y : bounds[0].x;
  const runHi = horizApproach ? bounds[2].y : bounds[2].x;
  let runClampEngaged = false;
  const clampRun = (v: number): number => {
    if (v < runLo) { runClampEngaged = true; return runLo; }
    if (v > runHi) { runClampEngaged = true; return runHi; }
    return v;
  };
  const distinctRunCoord = (
    v: number, step: number,
    clear: (c: number) => boolean = () => true,
    lim?: { lo: number; hi: number }
  ): number => {
    // Optional tighter limits (banded traced yards cap rides to the fence
    // corridor); absent => the padded routing bounds, unchanged behavior.
    const lo = lim ? Math.max(runLo, lim.lo) : runLo;
    const hi = lim ? Math.min(runHi, lim.hi) : runHi;
    // Compressed ladders (corridor narrower than the full spacing) separate
    // by their own step; full-spacing callers keep the exact old test.
    const sep = Math.min(FEEDER_TRENCH_SPACING_FT, Math.abs(step)) - 1e-6;
    let out = v;
    if (out < lo) { runClampEngaged = true; out = lo; }
    else if (out > hi) { runClampEngaged = true; out = hi; }
    let guard = 0;
    while ((usedRunCoords.some(u => Math.abs(u - out) < sep) ||
            !clear(out)) && guard++ < 200) {
      const next = out + step;
      if (next < lo || next > hi) {
        runClampEngaged = true;
        break;
      }
      out = next;
    }
    usedRunCoords.push(out);
    return out;
  };

  // Yards whose PCS lines run PERPENDICULAR to the corridor approach
  // (columns with an east/west substation, rows with a north/south
  // substation): never thread a home-run ride through the equipment field.
  // Feeders leave at the field edge and ride the clear band (drive aisle /
  // perimeter road) to the climb base. Auto islands used to seed each ride
  // at the chain-end coordinate, which walked the DC aisles between
  // containers; that path misses equipment rects so it never fail-closes,
  // but it cuts the yard. Aligned yards (lines parallel to the ride) keep
  // chain-end seeding — those rides already follow the PCS-row corridor.
  const fieldBand = (() => {
    const vertical = tracedLinesVertical(inverters);
    // Band only when line axis ⊥ ride axis: vertical lines with horizontal
    // rides, or horizontal lines with vertical rides.
    if (vertical == null || vertical !== horizApproach) return null;
    let visibleLo = Infinity, visibleHi = -Infinity;
    let visiblePcsLo = Infinity, visiblePcsHi = -Infinity;
    for (const e of design.equipment) {
      if (e.kind !== 'bess' && e.kind !== 'inverter') continue;
      const r = equipmentRect(e, 0);
      visibleLo = Math.min(visibleLo, horizApproach ? r.y1 : r.x1);
      visibleHi = Math.max(visibleHi, horizApproach ? r.y2 : r.x2);
      if (e.kind === 'inverter') {
        visiblePcsLo = Math.min(visiblePcsLo, horizApproach ? r.y1 : r.x1);
        visiblePcsHi = Math.max(visiblePcsHi, horizApproach ? r.y2 : r.x2);
      }
    }
    let routingLo = Infinity, routingHi = -Infinity;
    for (const e of inverters) {
      const p = feederNodeOf(e);
      const r = equipmentRect({ ...e, x: p.x, y: p.y }, 0);
      routingLo = Math.min(routingLo, horizApproach ? r.y1 : r.x1);
      routingHi = Math.max(routingHi, horizApproach ? r.y2 : r.x2);
    }
    // Usually the normalized visible field is the right corridor envelope.
    // Some legacy traced yards retain canonical MV endpoints in a disjoint
    // source frame; there the visible band can literally pass through feeder
    // launches. Switch frames only when the intervals barely overlap.
    const routingSpan = routingHi - routingLo;
    const frameCenterDelta = Math.abs(
      (visiblePcsLo + visiblePcsHi) / 2 - (routingLo + routingHi) / 2);
    // North/south approaches need the canonical row envelope to choose the
    // correct side of paired launches. For east/west approaches retain the
    // normalized field when it materially shifted; when the frames already
    // agree, the canonical envelope avoids tiny launch doglegs/hairpins.
    const useRoutingFrame = isFinite(routingSpan) && routingSpan > 1 &&
      (!horizApproach || frameCenterDelta < FEEDER_TRENCH_SPACING_FT * 2);
    const lo = useRoutingFrame ? routingLo : visibleLo;
    const hi = useRoutingFrame ? routingHi : visibleHi;
    if (!isFinite(lo) || !isFinite(hi)) return null;
    const FIELD_EXIT_MARGIN_FT = 12;
    // A band side is only USABLE if its corridor actually exists inside the
    // fence: traced fences often hug the field on one side (aug ladders +
    // no room), and rides must never be laid in the void outside the yard.
    // With one usable side, every slice exits that way — interior slices
    // reach the band through the drive aisles (grid-routed drops). With
    // neither usable there is no band discipline to apply; fall back to the
    // aligned-yard behavior.
    let fLo = Infinity, fHi = -Infinity;
    for (const p of design.fence) {
      const c = horizApproach ? p.y : p.x;
      fLo = Math.min(fLo, c); fHi = Math.max(fHi, c);
    }
    const FENCE_RIDE_MARGIN_FT = 2;
    const fenceLo = fLo + FENCE_RIDE_MARGIN_FT, fenceHi = fHi - FENCE_RIDE_MARGIN_FT;
    const loOk = isFinite(fLo) && lo - FIELD_EXIT_MARGIN_FT >= fenceLo;
    const hiOk = isFinite(fHi) && hi + FIELD_EXIT_MARGIN_FT <= fenceHi;
    if (!loOk && !hiOk) return null;
    return {
      lo: lo - FIELD_EXIT_MARGIN_FT, hi: hi + FIELD_EXIT_MARGIN_FT,
      mid: (lo + hi) / 2, loOk, hiOk, fenceLo, fenceHi,
    };
  })();

  // --- Geometric lane assignment (crossing-free comb) ---------------------
  // Lanes are dealt by each feeder's actual EXIT position (the perpendicular
  // coordinate of its chain end), not by feeder number: the feeder exiting
  // northmost rides the northmost lane (east/west approach), so home runs
  // nest like a comb and never cross each other. Electrical numbering
  // (idx, labels, schedules) is untouched — only the physical lane changes.

  // BANDED yards: which field edge each group exits toward. Traced lines
  // longer than one feeder split to opposite ends so siblings do not lance
  // through each other. Auto islands on a shared row all exit the SAME
  // road side (nearest aisle) and nest there — farthest-from-the-edge
  // feeder takes the outermost lane.
  const bandSideOf: ('hi' | 'lo')[] | null = fieldBand ? (() => {
    const gs = ordered.map(({ ids }, gi) => {
      const ms = ids.map(id => byId.get(id)!).filter(Boolean);
      const nodes = ms.map(feederNodeOf);
      const n = Math.max(1, nodes.length);
      return {
        gi,
        lineC: nodes.reduce((s, p) => s + (horizApproach ? p.x : p.y), 0) / n,
        bandC: nodes.reduce((s, p) => s + (horizApproach ? p.y : p.x), 0) / n,
      };
    });
    const TOL = 15;
    const out = new Array<'hi' | 'lo'>(gs.length);
    const sorted = [...gs].sort((a, b) => a.lineC - b.lineC);
    let cluster: typeof gs = [];
    const roadSideFor = (line: typeof gs): 'hi' | 'lo' => {
      const cx = line.reduce((s, g) => s + g.bandC, 0) / line.length;
      const cy = line.reduce((s, g) => s + g.lineC, 0) / line.length;
      const pivot = horizApproach ? { x: cy, y: cx } : { x: cx, y: cy };
      const road = nearestRoadWaypoint(pivot, roadAisles);
      if (road) {
        const roadC = horizApproach ? road.y : road.x;
        return roadC >= fieldBand!.mid ? 'hi' : 'lo';
      }
      return cx >= fieldBand!.mid ? 'hi' : 'lo';
    };
    const flush = () => {
      if (!cluster.length) return;
      if (!fieldBand!.hiOk || !fieldBand!.loOk) {
        const side = fieldBand!.hiOk ? 'hi' : 'lo';
        cluster.forEach(g => { out[g.gi] = side; });
      } else if (!isTracedYard) {
        const side = roadSideFor(cluster);
        cluster.forEach(g => { out[g.gi] = side; });
      } else if (cluster.length === 1) {
        out[cluster[0].gi] = cluster[0].bandC >= fieldBand!.mid ? 'hi' : 'lo';
      } else {
        const byBand = [...cluster].sort((a, b) => (b.bandC - a.bandC) || (a.gi - b.gi));
        const nHi = Math.ceil(byBand.length / 2);
        byBand.forEach((g, i) => { out[g.gi] = i < nHi ? 'hi' : 'lo'; });
      }
      cluster = [];
    };
    for (const g of sorted) {
      if (cluster.length && g.lineC - cluster[cluster.length - 1].lineC > TOL) flush();
      cluster.push(g);
    }
    flush();
    return out;
  })() : null;

  const pre = ordered.map(({ ids }, gi) => {
    const members = ids.map(id => byId.get(id)!).filter(Boolean);
    const memberNodes = members.map(feederNodeOf);
    // Every feeder chains farthest-PCS-first toward the substation and
    // home-runs directly from its chain end (per CAR-D-B005-0 the MV runs
    // never touch a junction box). Island chains keep the 2-opt wrap-around
    // refinement; the anchor is normally the substation. Traced-yard chains
    // get the same 2-opt: greedy order zig-zags between drawn lines, and a
    // wrap-around hop there lances across foreign equipment. In a BANDED
    // traced yard the chain must instead END at the unit nearest its own
    // field edge — anchoring on the substation would end mid-column and the
    // axial exit drop would lance through the sibling slice above/below it —
    // so the anchor is a point straight out from the group on its band side.
    const bandSide: 'hi' | 'lo' | null = bandSideOf?.[gi] ?? null;
    const defaultAnchor: Pt = bandSide
      ? (horizApproach
          ? { x: memberNodes.reduce((s, p) => s + p.x, 0) / Math.max(1, memberNodes.length),
              y: bandSide === 'hi' ? fieldBand!.hi + 500 : fieldBand!.lo - 500 }
          : { x: bandSide === 'hi' ? fieldBand!.hi + 500 : fieldBand!.lo - 500,
              y: memberNodes.reduce((s, p) => s + p.y, 0) / Math.max(1, memberNodes.length) })
      : substation;
    const anchor = nonAugmentationAnchor(ids, members, memberNodes) ?? defaultAnchor;
    const chainNodes = members.map(m => ({ ...m, ...feederNodeOf(m) }));
    const rowChain = rowOrderedChain(chainNodes, anchor);
    const assignmentRowInvalid =
      hasAssignments && isTracedYard && !isContiguousPhysicalRow(ids, members);
    const orderedNodes = rowChain ??
      chainOrder(chainNodes, anchor, isIslandGroup(ids) || isTracedYard);
    const chain = orderedNodes.map(m => byId.get(m.id)!).filter(Boolean);
    const last = chain[chain.length - 1];
    // Launch: where the home run leaves the yard from — the chain end.
    const launch: PlacedEquipment = last;
    const launchPt = feederNodeOf(launch);
    return {
      gi, chain, launch, launchPt, bandSide,
      rowGrammar: rowChain !== null,
      assignmentRowInvalid,
      rawRun: horizApproach ? launchPt.y : launchPt.x,
    };
  });
  // Physical-row exit: the chain-end PCS is a ROW END when no other PCS sits
  // beyond it on the same line — home-run goes straight out, then turns toward
  // the station. A MID-ROW end peels to the drive aisle / road and rides that
  // to the take-off. Battery courtyards are not a legal corridor.
  const ROW_MATE_FT = 15;
  const physicalRowOf = (launch: PlacedEquipment): PlacedEquipment[] => {
    const ux = Math.cos(launch.rotation), uy = Math.sin(launch.rotation);
    const across = (e: PlacedEquipment) => -e.x * uy + e.y * ux;
    const ac0 = across(launch);
    return inverters.filter(e => Math.abs(across(e) - ac0) <= ROW_MATE_FT);
  };
  const rowExitOf = pre.map(p => {
    const mates = physicalRowOf(p.launch);
    const ux = Math.cos(p.launch.rotation), uy = Math.sin(p.launch.rotation);
    const along = (e: PlacedEquipment) => e.x * ux + e.y * uy;
    const sorted = [...mates].sort((a, b) =>
      along(a) - along(b) || a.id.localeCompare(b.id));
    const atLo = p.launch.id === sorted[0]?.id;
    const atHi = p.launch.id === sorted[sorted.length - 1]?.id;
    const end = sorted.length < 2 || atLo || atHi;
    const sign = atHi && !atLo ? 1 : atLo && !atHi ? -1
      : (along(p.launch) >= ((along(sorted[0]) + along(sorted[sorted.length - 1])) / 2) ? 1 : -1);
    return {
      end,
      sign,
      road: nearestRoadWaypoint(p.launchPt, roadAisles),
    };
  });
  // laneRank 0 = northmost lane (east/west approach) / westmost (north/south)
  //
  // Near-ties (chain ends on the same equipment row, fractions apart) are
  // quantized to a trench spacing and broken by proximity to the substation
  // ALONG the approach axis: the closest exit keeps the line nearest the
  // shared row, the farthest exit takes the deepest line. Then every launch
  // drop from the shared row down to its line passes only lines of feeders
  // whose runs START farther out (beyond the drop), so drops nest instead
  // of slicing across a neighbor's run.
  const alongExit = (p: { launchPt: Pt }) => {
    return horizApproach ? p.launchPt.x * dirX : p.launchPt.y * dirY;
  };
  // --- Shared-row hop-trench separation ------------------------------------
  // Two feeders daisy-chained along the SAME equipment row lay collinear hop
  // trenches at the row line — reading as one continuous trench serving both
  // circuits. Detect straight axis-aligned hop lines shared by more than one
  // feeder and deal each sharer its own parallel hop line (3 ft steps): the
  // feeder exiting closest to the substation keeps the row line, the others
  // step outward, with short taps back into each PCS.
  const HOP_STAGGER_FT = 3;
  const hopLineKeys = (chain: PlacedEquipment[]): string[] => {
    const keys = new Set<string>();
    for (let j = 0; j < chain.length - 1; j++) {
      const a = chain[j], b = chain[j + 1];
      const A = feederNodeOf(a), B = feederNodeOf(b);
      if (Math.abs(A.y - B.y) < 0.5) keys.add(`h${Math.round(A.y / 2)}`);
      else if (Math.abs(A.x - B.x) < 0.5) keys.add(`v${Math.round(A.x / 2)}`);
    }
    return Array.from(keys);
  };
  const hopKeyUsers = new Map<string, number[]>();
  pre.forEach(p => hopLineKeys(p.chain).forEach(k => {
    hopKeyUsers.set(k, [...(hopKeyUsers.get(k) ?? []), p.gi]);
  }));
  const hopShiftOf = new Array<number>(feederCount).fill(0);
  for (const gis of Array.from(hopKeyUsers.values())) {
    if (gis.length < 2) continue;
    const sharers = [...gis].sort((a, b) =>
      (alongExit(pre[b]) - alongExit(pre[a])) || a - b);
    sharers.forEach((gi, r) => {
      hopShiftOf[gi] = Math.max(hopShiftOf[gi], r * HOP_STAGGER_FT);
    });
  }

  // Run-line stagger applied in raw exit order so it stays deterministic.
  // The step direction follows the exit order (rank 0 first), so each
  // later feeder can only shift PAST the earlier ones — never back across
  // them — and a monotone bound keeps the assigned coords in exit order.
  const runStep = (horizApproach ? -1 : 1) * FEEDER_TRENCH_SPACING_FT;
  const runCoordOf = new Array<number>(feederCount);
  const peelOffsetOf = new Array<number>(feederCount).fill(0);
  // NOTE: a symmetric minimum-displacement (PAVA) spreading was tried here
  // and reverted: moving a run line BACK past its own launch exit breaks the
  // comb-nesting invariant (a neighbor's launch drop then slices across it),
  // reintroducing home-run crossings. Runs may only shift in the step
  // direction, away from their raw exit — the greedy one-sided assignment
  // below is the minimum-drift solution under that constraint.
  const runClearFor = (last: PlacedEquipment): ((c: number) => boolean) => {
    // Ride clearance includes the hard trench keep-outs and any crossable
    // band PARALLEL to the ride (a run coincident with the 480V spine must
    // shift off it); perpendicular bands stay legal to cross.
    const startPt = feederNodeOf(last);
    const obs = autoObs(obstaclesExcept(last.id)).concat(
      parallelCrossRects(crossBands, horizApproach ? 'x' : 'y'),
      gateObsFrom(startPt),
      clusterRects);
    return (c: number): boolean => {
      // Only the RIDE portion (parallel to the corridor axis) must be clear:
      // the short launch drop from the chain end is routed per-feeder and
      // stays within the launch zone. Including it here would never clear —
      // shifting further only makes the drop cross more equipment rows.
      const runStart: Pt = horizApproach ? { x: startPt.x, y: c } : { x: c, y: startPt.y };
      const exit: Pt = horizApproach ? { x: climbBase, y: c } : { x: c, y: climbBase };
      return !feederCrossesObstacle([runStart, exit], obs, startPt, exit);
    };
  };
  {
    // Legal north/south (or east/west) rides sit in the GAPS between yard
    // boxes — those gaps are the drive paths. Riding a PCS column X that
    // sits inside a yard box is what drew trenches through the containers.
    const rideX = !horizApproach;
    const channels: number[] = [];
    {
      const ivs = clusterRects
        .map(r => rideX ? [r.x1, r.x2] as [number, number] : [r.y1, r.y2] as [number, number])
        .filter(([a, b]) => b - a > 4)
        .sort((a, b) => a[0] - b[0]);
      const merged: [number, number][] = [];
      for (const iv of ivs) {
        const last = merged[merged.length - 1];
        if (last && iv[0] <= last[1] + 8) last[1] = Math.max(last[1], iv[1]);
        else merged.push([iv[0], iv[1]]);
      }
      const pushGap = (a: number, b: number) => {
        if (b - a < 16) return;
        const mid = (a + b) / 2;
        // A gap between equipment AABBs is only a legal ride if a real
        // drive path occupies it. The PCS-to-battery courtyard is also a
        // 10–20 ft gap and must not become a feeder channel (08 through 06).
        if (!roadAisles.length) { channels.push(mid); return; }
        const roadThere = roadAisles.some(rd => {
          if (!rd || !Number.isFinite(rd.x) || !Number.isFinite(rd.y)) return false;
          const c = rideX ? rd.x : rd.y;
          return c > a + 2 && c < b - 2;
        });
        if (roadThere) channels.push(mid);
      };
      if (merged.length) {
        pushGap(runLo, merged[0][0]);
        for (let i = 0; i < merged.length - 1; i++) pushGap(merged[i][1], merged[i + 1][0]);
        pushGap(merged[merged.length - 1][1], runHi);
      }
      for (const a of roadAisles) {
        if (!a || !Number.isFinite(a.x) || !Number.isFinite(a.y)) continue;
        const rot = Number.isFinite(a.rotation) ? a.rotation : 0;
        const alongRide = rideX
          ? Math.abs(Math.sin(rot)) > 0.5
          : Math.abs(Math.cos(rot)) > 0.5;
        if (alongRide) channels.push(rideX ? a.x : a.y);
      }
    }
    const pickChannel = (p: typeof pre[number], prefer: number): number => {
      const launchC = rideX ? p.launch.x : p.launch.y;
      const pad = peelPadOf(p.launch);
      // Prefer the road on the pad face away from the battery yard (the
      // drive path), not a channel on the far side that would cut the cans.
      let preferDir = 0;
      if (pad) {
        const mid = rideX ? (pad.x1 + pad.x2) / 2 : (pad.y1 + pad.y2) / 2;
        preferDir = Math.sign(launchC - mid) || Math.sign(prefer - launchC);
      }
      const hookTo = (c: number): Pt[] => {
        const off = 28;
        if (rideX) {
          const road = pcsRoadToward(p.launch, p.launchPt);
          return [p.launchPt, road, { x: c, y: road.y }];
        }
        if (linesVertical === true) {
          const x = p.launchPt.x + dirX * off;
          return [{ x: p.launchPt.x, y: launchC }, { x, y: launchC }, { x, y: c }];
        }
        return [{ x: p.launchPt.x, y: launchC }, { x: p.launchPt.x, y: c }];
      };
      let best = prefer;
      let bestD = Infinity;
      const seen = new Set<number>();
      for (const c of channels) {
        const q = Math.round(c * 10) / 10;
        if (seen.has(q)) continue;
        seen.add(q);
        const hook = hookTo(c);
        if (clusterRects.length &&
            feederCrossesObstacle(hook, clusterRects, hook[0], hook[hook.length - 1])) continue;
        const d = Math.abs(c - launchC);
        if (d < bestD && runClearFor(p.launch)(c)) {
          bestD = d;
          best = c;
        }
      }
      if (bestD === Infinity) {
        for (const c of channels) {
          const hook = hookTo(c);
          if (clusterRects.length &&
              feederCrossesObstacle(hook, clusterRects, hook[0], hook[hook.length - 1])) continue;
          const d = Math.abs(c - launchC);
          if (d < bestD && runClearFor(p.launch)(c)) {
            bestD = d;
            best = c;
          }
        }
      }
      if (bestD === Infinity && pad) {
        const edge = rideX
          ? (preferDir >= 0 ? pad.x2 + 8 : pad.x1 - 8)
          : (preferDir >= 0 ? pad.y2 + 8 : pad.y1 - 8);
        if (runClearFor(p.launch)(edge)) return edge;
      }
      const inCourt = (c: number) => clusterRects.some(r => rideX
        ? c > r.x1 && c < r.x2 && p.launchPt.y > r.y1 && p.launchPt.y < r.y2
        : c > r.y1 && c < r.y2 && p.launchPt.x > r.x1 && p.launchPt.x < r.x2);
      if (inCourt(best)) {
        const face = pcsRoadFaceCoord(p.launch, rideX);
        if (!inCourt(face)) return face;
      }
      return best;
    };
    const byRoad = new Map<number, typeof pre>();
    for (const p of pre) {
      const ex = rowExitOf[p.gi];
      const roadC = ex.road
        ? (horizApproach ? ex.road.y : ex.road.x)
        : (rideX ? p.launch.x : p.launch.y);
      const seed = pickChannel(p, roadC);
      const key = Math.round(seed / FEEDER_TRENCH_SPACING_FT);
      const list = byRoad.get(key) ?? [];
      list.push(p);
      byRoad.set(key, list);
      // stash seed on peelOffset slot briefly? no, assign after grouping
      runCoordOf[p.gi] = seed;
    }
    for (const group of Array.from(byRoad.values())) {
      group.sort((a, b) => (alongExit(b) - alongExit(a)) || a.gi - b.gi);
      const base = runCoordOf[group[0].gi];
      const outward = Math.sign(base - (horizApproach ? group[0].launch.y : group[0].launch.x)) ||
        (base >= (horizApproach ? group[0].launch.y : group[0].launch.x) ? 1 : -1);
      group.forEach((p, i) => {
        const seed = base + outward * i * FEEDER_TRENCH_SPACING_FT;
        const step = (outward || Math.sign(runStep) || 1) * FEEDER_TRENCH_SPACING_FT;
        runCoordOf[p.gi] = distinctRunCoord(seed, step, runClearFor(p.launch));
        peelOffsetOf[p.gi] = i * FEEDER_TRENCH_SPACING_FT;
      });
    }
  }
  if (runClampEngaged) {
    opts.onWarning?.(
      'Feeder routing ran out of room: a home-run trench line was clamped to the edge of the routing area, so trench spacing and crossing rules may be violated there — review feeder trenches in detailed design.'
    );
  }
  // Lanes are dealt from the FINAL (staggered) run coordinates: two chain
  // ends tied on the same row get pushed apart by the stagger, and the lane
  // order must follow the pushed positions or the pair swaps and crosses.
  const rankOrder = [...pre].sort((a, b) => {
    const ra = runCoordOf[a.gi], rb = runCoordOf[b.gi];
    return (horizApproach ? rb - ra : ra - rb) || a.gi - b.gi;
  });
  const laneRankOf = new Array<number>(feederCount);
  rankOrder.forEach((p, r) => { laneRankOf[p.gi] = r; });
  const spreadOf = (rank: number) => horizApproach
    ? ((feederCount - 1) / 2 - rank) * FEEDER_TRENCH_SPACING_FT
    : (rank - (feederCount - 1) / 2) * FEEDER_TRENCH_SPACING_FT;

  // Climb-line order: if feeder A's climb leg (run line → its own lane)
  // passes over feeder B's lane, A must turn onto its lane CLOSER to the
  // fence than where B's lane begins — otherwise the climb slices through
  // B's lane. Topologically sort those constraints so climbs form a nested
  // staircase; ties (and the impossible cycle case) fall back to lane rank.
  const laneCoordOf = (gi: number) => laneCenter + spreadOf(laneRankOf[gi]);
  const mustClimbAfter: number[][] = Array.from({ length: feederCount }, () => []);
  const indeg = new Array<number>(feederCount).fill(0);
  for (let a = 0; a < feederCount; a++) {
    const lo = Math.min(runCoordOf[a], laneCoordOf(a));
    const hi = Math.max(runCoordOf[a], laneCoordOf(a));
    for (let b = 0; b < feederCount; b++) {
      if (b === a) continue;
      // A's climb passes over B's LANE → A must climb before B's lane begins
      const lb = laneCoordOf(b);
      if (lb > lo + 1e-6 && lb < hi - 1e-6) {
        mustClimbAfter[a].push(b);
        indeg[b]++;
      }
      // A's climb passes over B's RUN line → A must climb beyond B's climb
      // (B's run leg only occupies its line up to B's own climb)
      const rb = runCoordOf[b];
      if (rb > lo + 1e-6 && rb < hi - 1e-6) { mustClimbAfter[b].push(a); indeg[a]++; }
    }
  }
  const climbOrderOf = new Array<number>(feederCount).fill(-1);
  {
    const ready = Array.from({ length: feederCount }, (_, i) => i).filter(i => indeg[i] === 0);
    let next = 0;
    while (ready.length) {
      ready.sort((x, y) => laneRankOf[x] - laneRankOf[y]);
      const i = ready.shift()!;
      climbOrderOf[i] = next++;
      for (const b of mustClimbAfter[i]) if (--indeg[b] === 0) ready.push(b);
    }
    for (const p of rankOrder) if (climbOrderOf[p.gi] < 0) climbOrderOf[p.gi] = next++;
  }

  // --- Routing-mode resolution (90° corridor comb vs. angled corridor) ----
  // Effective mode per feeder: per-key override beats the design default;
  // a drafter-drawn route override (handled later) beats both. Keys that
  // match no live feeder go dormant with a warning, mirroring routeOverrides.
  const routeKeyOf = pre.map(p => feederRouteKey(p.chain.map(c => c.id)));
  const modeOverrides = opts.routingModes ?? null;
  const angledSet = new Set<number>();
  for (let gi = 0; gi < feederCount; gi++) {
    const mode = modeOverrides?.[routeKeyOf[gi]] ?? opts.defaultRoutingMode ?? 'orthogonal';
    if (mode === 'angled') angledSet.add(gi);
  }
  if (modeOverrides) {
    for (const k of Object.keys(modeOverrides)) {
      if (!routeKeyOf.includes(k)) {
        opts.onWarning?.(
          `Feeder routing mode for ${k} is inactive: no feeder currently anchors on that PCS — the saved mode is kept but unused until the grouping matches again.`);
      }
    }
  }
  // Shared diagonal corridor direction for the angled bundle: from the
  // bundle's yard-exit center (climb base line, mean run coordinate of the
  // angled feeders) to the substation-approach center. Every angled feeder
  // rides a PARALLEL diagonal lane through its own approach waypoint, so
  // lane order and constant spacing are preserved and the bundle never
  // crosses itself (run lines, diagonal lanes and approach lanes are all
  // ordered by the same lane rank). Degenerate direction (no perpendicular
  // travel — the diagonal would be parallel to the 90° lanes anyway) keeps
  // the orthogonal route with a warning.
  let angledDir: Pt | null = null;
  if (angledSet.size) {
    const waypointCoordAll = horizApproach
      ? substation.x - dirX * SUBSTATION_APPROACH_FT
      : substation.y - dirY * SUBSTATION_APPROACH_FT;
    // Perpendicular travel of the corridor: the LARGEST run-line→lane offset
    // among the angled feeders (signed). The steepest need sets the shared
    // slope so its diagonal spans exactly climb base → approach; shallower
    // feeders intersect their run lines strictly inside the strip. (A mean
    // slope would push the steepest feeder's intersection back inside the
    // fence.) Feeders whose offset has the opposite sign can't share the
    // corridor and fall back with a warning.
    let vPerp = 0;
    for (const gi of Array.from(angledSet)) {
      const dy = laneCoordOf(gi) - runCoordOf[gi];
      if (Math.abs(dy) > Math.abs(vPerp)) vPerp = dy;
    }
    const v: Pt = horizApproach
      ? { x: waypointCoordAll - climbBase, y: vPerp }
      : { x: vPerp, y: waypointCoordAll - climbBase };
    const len = Math.hypot(v.x, v.y);
    const perp = horizApproach ? v.y : v.x;
    const along = horizApproach ? v.x * dirX : v.y * dirY;
    if (len > 1e-6 && Math.abs(perp) > 1e-6 && along > 1e-6) {
      angledDir = { x: v.x / len, y: v.y / len };
    }
  }
  const angledRouted = new Set<number>();

  // Already-routed trenches + DC (PCS↔battery) runs: fallback candidates are
  // scored by transversal crossings against these, so a rerouted feeder
  // turns toward the road instead of cutting a neighbor or a DC fan.
  const priorHomes: Pt[][] = [];
  const priorHops: Pt[][] = [];
  const properCross = (a: Pt, b: Pt, c: Pt, d2: Pt): boolean => {
    const o = (p: Pt, q: Pt, r: Pt) =>
      Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
    const o1 = o(a, b, c), o2 = o(a, b, d2), o3 = o(c, d2, a), o4 = o(c, d2, b);
    return o1 !== 0 && o2 !== 0 && o3 !== 0 && o4 !== 0 && o1 !== o2 && o3 !== o4;
  };
  const crossesForbidden = (pts: Pt[]): number => {
    let n = 0;
    for (const other of [...priorHomes, ...priorHops, ...dcRuns]) {
      for (let i = 0; i < pts.length - 1; i++) {
        for (let j = 0; j < other.length - 1; j++) {
          if (properCross(pts[i], pts[i + 1], other[j], other[j + 1])) n++;
        }
      }
    }
    return n;
  };
  const crossesPrior = (pts: Pt[]): number => crossesForbidden(pts);
  const clusterHits = (pts: Pt[]): number => {
    if (!clusterRects.length) return 0;
    let n = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      const samples = Math.max(2, Math.ceil(len / 4));
      for (let s = 1; s < samples; s++) {
        const t = s / samples;
        const x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t;
        if (clusterRects.some(r => x > r.x1 && x < r.x2 && y > r.y1 && y < r.y2)) n++;
      }
    }
    return n;
  };
  // Horizontal traced rows: a long sideways trench at PCS height is the
  // 09/purple cut. Sideways motion is legal only past the equipment field.
  const sweepsRow = (pts: Pt[]): boolean => {
    // Column yards: a long E/W trench at pad Y is the Area 3/4 cut
    // through the next can field. Flag it the same way horizontal rows
    // flag a long N/S comb.
    if (linesVertical === true) {
      const past = Number.isFinite(fieldExitAlong)
        ? fieldExitAlong + (horizApproach ? dirX : dirY) * 8
        : climbOrigin;
      const stepDir = horizApproach ? dirX : dirY;
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1];
        if (Math.abs(a.y - b.y) > 2 || Math.abs(a.x - b.x) < 24) continue;
        const along = horizApproach ? a.x : a.y;
        if ((along - past) * stepDir >= -1) continue;
        const y = (a.y + b.y) / 2;
        if (clusterRects.some(r => y > r.y1 && y < r.y2 &&
            Math.min(Math.max(a.x, b.x), r.x2) - Math.max(Math.min(a.x, b.x), r.x1) > 16)) {
          return true;
        }
      }
      return false;
    }
    if (linesVertical !== false) return false;
    const past = Number.isFinite(fieldExitAlong)
      ? fieldExitAlong + (horizApproach ? dirX : dirY) * 8
      : climbOrigin;
    const stepDir = horizApproach ? dirX : dirY;
    let fieldLo = Infinity, fieldHi = -Infinity;
    for (const r of clusterRects) {
      if (horizApproach) {
        fieldLo = Math.min(fieldLo, r.y1); fieldHi = Math.max(fieldHi, r.y2);
      } else {
        fieldLo = Math.min(fieldLo, r.x1); fieldHi = Math.max(fieldHi, r.x2);
      }
    }
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      if (horizApproach) {
        if (Math.abs(a.x - b.x) < 2 && Math.abs(a.y - b.y) > 24 &&
            (a.x - past) * stepDir < -1) {
          const x = (a.x + b.x) / 2;
          const inBand = clusterRects.some(r => x > r.x1 && x < r.x2);
          const lo = Math.min(a.y, b.y), hi = Math.max(a.y, b.y);
          if (inBand && Math.min(hi, fieldHi) - Math.max(lo, fieldLo) > 16) return true;
        }
      } else if (Math.abs(a.y - b.y) < 2 && Math.abs(a.x - b.x) > 24 &&
          (a.y - past) * stepDir < -1) {
        const y = (a.y + b.y) / 2;
        const inBand = clusterRects.some(r => y > r.y1 && y < r.y2);
        const lo = Math.min(a.x, b.x), hi = Math.max(a.x, b.x);
        if (inBand && Math.min(hi, fieldHi) - Math.max(lo, fieldLo) > 16) return true;
      }
    }
    return false;
  };
  // Station-ward through the interior of a traced row yard — the Area 2
  // light-blue cut down the PCS06 containers — is not a legal corridor.
  // Only the two field edges (and the road past fieldExitAlong) may carry it.
  const cutsYard = (pts: Pt[]): boolean => {
    if (!clusterRects.length) return false;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const horiz = Math.abs(a.y - b.y) < 2 && Math.abs(a.x - b.x) >= 24;
      const vert = Math.abs(a.x - b.x) < 2 && Math.abs(a.y - b.y) >= 24;
      if (!horiz && !vert) continue;
      for (const r of clusterRects) {
        if (horiz) {
          if (a.y <= r.y1 + 1 || a.y >= r.y2 - 1) continue;
          const lo = Math.min(a.x, b.x), hi = Math.max(a.x, b.x);
          if (Math.min(hi, r.x2) - Math.max(lo, r.x1) > 16) return true;
        } else {
          if (a.x <= r.x1 + 1 || a.x >= r.x2 - 1) continue;
          const lo = Math.min(a.y, b.y), hi = Math.max(a.y, b.y);
          if (Math.min(hi, r.y2) - Math.max(lo, r.y1) > 16) return true;
        }
      }
    }
    return false;
  };
  const scoreRoute = (pts: Pt[]): number =>
    crossesForbidden(pts) * 1000 + clusterHits(pts) +
    (sweepsRow(pts) ? 5000 : 0) + (cutsYard(pts) ? 5000 : 0) +
    (fieldComb(pts) ? 4000 : 0);
  const fieldComb = (pts: Pt[]): boolean => {
    if (!clusterRects.length) return false;
    let lo = Infinity, hi = -Infinity;
    for (const r of clusterRects) {
      lo = Math.min(lo, horizApproach ? r.y1 : r.x1);
      hi = Math.max(hi, horizApproach ? r.y2 : r.x2);
    }
    const past = Number.isFinite(fieldExitAlong)
      ? fieldExitAlong + (horizApproach ? dirX : dirY) * 8
      : NaN;
    const stepDir = horizApproach ? dirX : dirY;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      if (horizApproach) {
        if (Math.abs(a.x - b.x) > 2 || Math.abs(a.y - b.y) < 80) continue;
        if (Number.isFinite(past) && (a.x - past) * stepDir >= -1) continue;
      } else {
        if (Math.abs(a.y - b.y) > 2 || Math.abs(a.x - b.x) < 80) continue;
        if (Number.isFinite(past) && (a.y - past) * stepDir >= -1) continue;
      }
      const span0 = horizApproach ? Math.min(a.y, b.y) : Math.min(a.x, b.x);
      const span1 = horizApproach ? Math.max(a.y, b.y) : Math.max(a.x, b.x);
      if (Math.min(span1, hi) - Math.max(span0, lo) > 40) return true;
    }
    return false;
  };

  const circuits: FeederCircuit[] = ordered.map((_group, gi) => {
    const idx = gi + 1;
    const p = pre[gi];
    const chain = p.chain;
    const loadCount = chain.length;
    const segments: FeederSegment[] = [];
    // Chain hops: segment after chain node j carries loads of nodes 0..j.
    // When this feeder shares its hop row with another feeder, straight
    // axis-aligned hops are re-laid on the feeder's own parallel hop line
    // (hopShiftOf) with short taps back into the two PCS units — otherwise
    // the collinear hop trenches of both circuits read as one shared trench.
    //
    // Under-skid joins can wander a few feet across a physical row (pose
    // deltas, missing mv-drop → PCS center, lane mix). A tiny ΔY on an
    // otherwise horizontal hop makes routeSegment emit an L with 2 bends.
    // Snap the whole chain onto one shared across-line so every hop is a
    // single straight trunk span (same idea as averaged mv-drop joins).
    const ROW_JOG_SNAP_FT = 6;
    const { hopNodeOf, rowSnapped } = (() => {
      const nodes = chain.map(e => ({ id: e.id, p: feederNodeOf(e) }));
      const fallback = { hopNodeOf: feederNodeOf, rowSnapped: false };
      if (nodes.length < 2) return fallback;
      let ai = 0, bi = 1, span = -1;
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const d = dist(nodes[i].p, nodes[j].p);
          if (d > span) { span = d; ai = i; bi = j; }
        }
      }
      if (span < 1) return fallback;
      const origin = nodes[ai].p;
      const ux = (nodes[bi].p.x - origin.x) / span;
      const uy = (nodes[bi].p.y - origin.y) / span;
      const along = (p: Pt) => (p.x - origin.x) * ux + (p.y - origin.y) * uy;
      const across = (p: Pt) => -(p.x - origin.x) * uy + (p.y - origin.y) * ux;
      const meanAcross = nodes.reduce((s, n) => s + across(n.p), 0) / nodes.length;
      if (nodes.some(n => Math.abs(across(n.p) - meanAcross) > ROW_JOG_SNAP_FT)) {
        return fallback;
      }
      const snapped = new Map<string, Pt>();
      for (const n of nodes) {
        const s = along(n.p);
        snapped.set(n.id, {
          x: origin.x + ux * s - uy * meanAcross,
          y: origin.y + uy * s + ux * meanAcross,
        });
      }
      return {
        hopNodeOf: (e: PlacedEquipment) => snapped.get(e.id) ?? feederNodeOf(e),
        rowSnapped: true,
      };
    })();
    for (let j = 0; j < chain.length - 1; j++) {
      const a = chain[j], b = chain[j + 1];
      const hopObs = autoObs(obstaclesExcept(a.id, b.id)).concat(
        (p.rowGrammar || rowSnapped) ? [] : clusterRects,
        (p.rowGrammar || rowSnapped)
          ? []
          : cableKeepOutFrom([...dcRuns, ...priorHops, ...priorHomes], [a, b]));
      const A = hopNodeOf(a), B = hopNodeOf(b);
      // Recognized rows land on their canonical under-skid mv-collector
      // through the mv-drop-* endpoints. That collector is the one straight
      // row trunk; handing it to the generic obstacle router may legally
      // return an L-shaped detour, which is forbidden by the row grammar.
      // Snapped near-row chains get the same straight [A, B] treatment so a
      // few feet of join stagger cannot reintroduce the 2-bend L-jog.
      let pts = (p.rowGrammar || rowSnapped) ? [A, B] : routeSegmentTrenchAware(A, B, hopObs);
      // routeSegment keeps its L-route when the grid reroute finds no path —
      // on dense traced yards that used to silently lay a trench straight
      // through other feeders' PCS and the container columns. Per the
      // reference route map a chain trench NEVER transits equipment: try the
      // flipped elbow, then offset detour lines stepping toward the road
      // first, and only keep a crossing route with a loud warning when every
      // candidate fails.
      {
        if (!p.rowGrammar && !rowSnapped &&
            (feederCrossesObstacle(pts, hopObs, A, B) || crossesForbidden(pts) > 0)) {
          const roadPt = nearestRoadWaypoint(A, roadAisles);
          const cands: Pt[][] = [[A, { x: A.x, y: B.y }, B]];
          if (roadPt) {
            const mid = Math.abs(roadPt.x - A.x) >= Math.abs(roadPt.y - A.y)
              ? { x: roadPt.x, y: A.y }
              : { x: A.x, y: roadPt.y };
            cands.unshift([A, mid, { x: roadPt.x, y: roadPt.y }, B]);
          }
          const roadSgnY = roadPt ? (Math.sign(roadPt.y - A.y) || 1) : 1;
          const roadSgnX = roadPt ? (Math.sign(roadPt.x - A.x) || 1) : 1;
          for (let off = 8; off <= 64; off += 8) {
            const signsY = roadPt ? [roadSgnY, -roadSgnY] : [1, -1];
            const signsX = roadPt ? [roadSgnX, -roadSgnX] : [1, -1];
            for (const sgn of signsY) {
              const o = sgn * off;
              cands.push([A, { x: A.x, y: A.y + o }, { x: B.x, y: A.y + o }, B]);
            }
            for (const sgn of signsX) {
              const o = sgn * off;
              cands.push([A, { x: A.x + o, y: A.y }, { x: A.x + o, y: B.y }, B]);
            }
          }
          let clean: Pt[] | null = null;
          let cleanNoCoRun: Pt[] | null = null;
          for (const c of cands) {
            if (feederCrossesObstacle(c, hopObs, A, B)) continue;
            if (crossesForbidden(c) > 0) continue;
            if (!clean) clean = c;
            if (bandCoRunViolations(c, crossBands) === 0) { cleanNoCoRun = c; break; }
          }
          const pick = cleanNoCoRun ?? clean;
          if (pick) {
            pts = pick;
          } else {
            opts.onWarning?.(
              `Feeder chain trench between ${a.label ?? a.id} and ${b.label ?? b.id} could not avoid crossing equipment — no clear detour found; review the trench route in detailed design.`
            );
          }
        }
      }
      const shift = hopShiftOf[gi];
      if (!p.rowGrammar && shift > 0 && pts.length === 2) {
        const horizHop = Math.abs(A.y - B.y) < 0.5;
        const vertHop = Math.abs(A.x - B.x) < 0.5;
        if (horizHop || vertHop) {
          for (const off of [shift, -shift]) {
            const cand: Pt[] = horizHop
              ? [pts[0], { x: A.x, y: A.y + off }, { x: B.x, y: B.y + off }, pts[1]]
              : [pts[0], { x: A.x + off, y: A.y }, { x: B.x + off, y: B.y }, pts[1]];
            if (!feederCrossesObstacle(cand, hopObs, pts[0], pts[1])) {
              pts = cand;
              break;
            }
          }
        }
      }
      segments.push({ pts, lengthFt: polyLen(pts), amps: (j + 1) * perInvAmps });
      priorHops.push(pts);
    }
    {
    // Home run, corridor-tree pattern: the feeder peels off its launch point
    // (its chain end) straight onto
    // its own lane (a run parallel to the corridor axis at a dedicated
    // FEEDER_TRENCH_SPACING_FT offset from the substation centerline — its
    // OWN trench, not a shared bank), travels the lane all the way to the
    // substation approach, then lands with a short jog.
    const last = pre[gi].launch;
    const start: Pt = feederNodeOf(last);
    // Lane offset: dealt geometrically — lane rank follows the chain-end
    // exit coordinate (northmost exit rides the northmost lane), so home
    // runs nest like a comb instead of crossing.
    const spread = spreadOf(laneRankOf[gi]);
    const homeObstacles = obstaclesExcept(last.id);
    // Already-routed homes: hard keep-out so later feeders cannot cut
    // across them on the roads. Only the substation convergence window is
    // omitted — that is the one legal meeting point.
    const priorHomeKeep = trenchKeepOutRects(
      priorHomes, FEEDER_TRENCH_SPACING_FT / 2
    ).filter(r => {
      const cx = (r.x1 + r.x2) / 2, cy = (r.y1 + r.y2) / 2;
      return Math.hypot(cx - substation.x, cy - substation.y) >
        SUBSTATION_APPROACH_FT + 20;
    });
    const homeObstaclesAuto = autoObs(homeObstacles).concat(
      gateObsFrom(start),
      clusterRects,
      priorHomeKeep,
      cableKeepOutFrom([...dcRuns, ...priorHops], [last]));
    // Run line: the feeder exits the yard from its chain end along its own
    // (staggered) run line, perpendicular to the lane stack.
    const runCoord = runCoordOf[gi];
    // Climb line: each feeder turns onto its lane at its own climb line in
    // the obstacle-free strip outside the fence, staggered in nesting order
    // (a climb that passes over other lanes happens before those lanes
    // begin). Clamped so the climb can never overshoot the substation
    // approach when the substation sits close to (or inside) the fence bbox.
    const dir = horizApproach ? dirX : dirY;
    const waypointCoord = horizApproach
      ? substation.x - dirX * SUBSTATION_APPROACH_FT
      : substation.y - dirY * SUBSTATION_APPROACH_FT;
    const climbLimit = waypointCoord - dir * FEEDER_TRENCH_SPACING_FT;
    // Climb-step compression: with many feeders and a shallow strip between
    // the fence and the substation, full-spacing climb lines overshoot the
    // approach and the clamp used to pile every overflowing climb onto ONE
    // collinear line (reading as a single trench carrying several circuits).
    // Compress the step just enough that the deepest climb still lands
    // before the approach — every climb keeps its own line.
    const climbAvail = (climbLimit - climbOrigin) * dir;
    const climbStep = feederCount > 1 && climbAvail > 0
      ? Math.min(FEEDER_TRENCH_SPACING_FT, climbAvail / (feederCount - 1))
      : FEEDER_TRENCH_SPACING_FT;
    const climbRaw = climbOrigin + dir * climbOrderOf[gi] * climbStep;
    const climbCoord = dir > 0 ? Math.min(climbRaw, climbLimit) : Math.max(climbRaw, climbLimit);
    const roadPt = rowExitOf[gi].road ?? nearestRoadWaypoint(start, roadAisles);
    const columnYard = isTracedYard && !tracedHorizontalRows;
    // Aim along the assigned run (row-end outward, or the road-side PCS end).
    const fieldEdgeRun = linesVertical === false && !columnYard && clusterRects.length
      ? (() => {
          const lo = Math.min(...clusterRects.map(r => horizApproach ? r.y1 : r.x1));
          const hi = Math.max(...clusterRects.map(r => horizApproach ? r.y2 : r.x2));
          const s = horizApproach ? start.y : start.x;
          const sign = s < (lo + hi) / 2 ? -1 : 1;
          let edge = sign < 0 ? lo - 8 : hi + 8;
          const snap: Pt = horizApproach ? { x: start.x, y: edge } : { x: edge, y: start.y };
          if (feederCrossesObstacle([start, snap], clusterRects, start, snap)) {
            edge = pcsRoadFaceCoord(last, !horizApproach);
          }
          return edge + sign * (peelOffsetOf[gi] ?? 0);
        })()
      : null;
    // Use THIS PCS's pad only. A merged column AABB would put "off-row"
    // south of the whole stack, and the drop at start.x would cut every
    // container row in between (Area 2 F2/F8).
    const toward = (() => {
      if (!columnYard && linesVertical === false) {
        const localRun = fieldEdgeRun ?? peelRoadCoord(last, start, !horizApproach);
        const raw = horizApproach
          ? { x: start.x + dirX * 16, y: start.y }
          : { x: start.x, y: start.y + dirY * 16 };
        const along0 = horizApproach ? start.y : start.x;
        if (!horizApproach && Math.abs(localRun - along0) < 48) {
          const snap = { x: localRun, y: start.y };
          if (!clusterRects.length ||
              !feederCrossesObstacle([start, snap], clusterRects, start, snap)) {
            return snap;
          }
        }
        return raw;
      }
      return columnToward(last, start);
    })();
    // Column local run rides the road-side coordinate of THIS skid. peelPadOf
    // includes the cans, so pad.y1-16 was a trench down through CON (Area 4
    // yellow/teal) and pad.x1-16 cut the west courtyard (Area 1 red).
    const localRun = fieldEdgeRun ?? (horizApproach ? toward.y : toward.x);
    // First hop is the road-side PCS end, not the across-skid face — that
    // face is the DC courtyard when the long axis points at the take-off.
    const underExitBase = toward;
    const peelExtra = peelOffsetOf[gi] ?? 0;
    const underExit = (() => {
      if (peelExtra < 0.01 || linesVertical === false) return underExitBase;
      const dx = underExitBase.x - start.x, dy = underExitBase.y - start.y;
      const len = Math.hypot(dx, dy);
      if (len < 1e-6) return underExitBase;
      return {
        x: underExitBase.x + (dx / len) * peelExtra,
        y: underExitBase.y + (dy / len) * peelExtra,
      };
    })();
    const peelCoord = horizApproach ? underExit.x : underExit.y;
    const dropJog: Pt = underExit;
    const driveAlong = horizApproach
      ? (columnYard
          ? columnEdgeY(last)
          : (() => {
              const face = pcsRoadFaceCoord(last, false);
              return Math.abs(face - start.y) < 24 ? face : underExit.y;
            })())
      : peelCoord;
    const localStart: Pt = horizApproach
      ? { x: climbCoord, y: driveAlong }
      : { x: localRun, y: peelCoord };
    const runStart: Pt = horizApproach
      ? { x: climbCoord, y: driveAlong }
      : { x: runCoord, y: peelCoord };
    // Exit point: end of the in-yard run, on the climb line.
    const exitPt: Pt = horizApproach
      ? { x: climbCoord, y: runCoord }
      : { x: runCoord, y: climbCoord };
    const localExit: Pt = horizApproach
      ? { x: climbCoord, y: driveAlong }
      : { x: localRun, y: climbCoord };
    // Top of the climb: on the feeder's own lane.
    const laneJoin: Pt = horizApproach
      ? { x: climbCoord, y: laneCenter + spread }
      : { x: laneCenter + spread, y: climbCoord };
    // Corridor waypoint just short of the substation, still on the lane.
    const waypoint: Pt = horizApproach
      ? { x: substation.x - dirX * SUBSTATION_APPROACH_FT, y: laneCenter + spread }
      : { x: laneCenter + spread, y: substation.y - dirY * SUBSTATION_APPROACH_FT };
    const entry: Pt[] = horizApproach
      ? [{ x: substation.x, y: waypoint.y }, substation]
      : [{ x: waypoint.x, y: substation.y }, substation];
    // Ideal corridor route: run out of the yard, climb onto the lane
    // outside the fence, ride the lane to the approach, jog in.
    // Horizontal rows: drop onto THIS pad's road (take-off face), ride that
    // line to the field edge, then climb. Sideways at PCS height combs the
    // row; southbound at launch X cuts the next container row.
    // East/west take-off: finish the west/east exit along the PCS, then
    // turn only on the climb line (the road). A Y-leg at underExit.x is
    // still inside the can columns (Area 4 yellow/teal through CON0507).
    const ideal = horizApproach
      ? dedupePts([
          start, underExit, { x: underExit.x, y: driveAlong },
          { x: climbCoord, y: driveAlong },
          exitPt, laneJoin, waypoint, ...entry,
        ])
      : (linesVertical === false && !columnYard)
      ? dedupePts([
          start,
          underExit,
          { x: localRun, y: underExit.y },
          { x: localRun, y: climbCoord },
          exitPt, laneJoin, waypoint, ...entry,
        ])
      : (Math.abs(localRun - runCoord) > 1
        ? dedupePts([start, dropJog, localStart, localExit, exitPt, laneJoin, waypoint, ...entry])
        : dedupePts([start, dropJog, runStart, exitPt, laneJoin, waypoint, ...entry]));
    let homePts = ideal;
    if (feederCrossesObstacle(ideal, homeObstaclesAuto, start, substation) ||
        bandCoRunViolations(ideal, crossBands) > 0 ||
        crossesPrior(ideal) > 0 ||
        clusterHits(ideal) > 0 ||
        sweepsRow(ideal) ||
        cutsYard(ideal) ||
        fieldComb(ideal)) {
      // Only the in-yard run can hit equipment: grid-reroute just that leg
      // and keep the corridor legs (all outside the fence) intact.
      // Prefer reaching the feeder's OWN run line first and riding it to the
      // climb: a free start→exit grid route may travel east on a foreign
      // corridor and then cut across other feeders' climbs (comb violation).
      const viaOwnRun = (() => {
        const drop = horizApproach
          ? [{ x: underExit.x, y: driveAlong }, { x: climbCoord, y: driveAlong }, exitPt]
          : Math.abs(localRun - runCoord) > 1
          ? [...routeSegmentTrenchAware(underExit, localStart, homeObstaclesAuto), localExit]
          : routeSegmentTrenchAware(underExit, runStart, homeObstaclesAuto);
        const cand = stripBacktracks(dedupePts([start, ...drop, exitPt]));
        return feederCrossesObstacle(cand, homeObstaclesAuto, start, exitPt) ||
          bandCoRunViolations(cand, crossBands) > 0 ? null : cand;
      })();
      const direct = routeSegmentTrenchAware(start, exitPt, homeObstaclesAuto);
      // Stagger rerouted launch legs: two feeders rerouting through the
      // same drive aisle would otherwise lay coincident trench lines. Each
      // feeder gets a small unique orthogonal offset (3 ft per lane rank,
      // centered) so shared-aisle reroutes stay visibly separated; endpoints
      // are preserved so the corridor legs are untouched.
      const stagger = (laneRankOf[gi] - (feederCount - 1) / 2) * 3;
      const buildFrom = (runLeg: Pt[]): Pt[] | null => {
        let runPts = runLeg;
        if (Math.abs(stagger) > 0.01 && runLeg.length > 2) {
          const shiftedRun = offsetOrthogonal(runLeg, stagger);
          if (!feederCrossesObstacle(shiftedRun, homeObstaclesAuto, start, exitPt)) {
            runPts = shiftedRun;
          }
        }
        const cand = stripBacktracks(
          dedupePts([...runPts, laneJoin, waypoint, ...entry]));
        return feederCrossesObstacle(cand, homeObstaclesAuto, start, substation) ||
          bandCoRunViolations(cand, crossBands) > 0 ||
          clusterHits(cand) > 0 || cutsYard(cand) || sweepsRow(cand) ? null : cand;
      };
      // Neither reroute candidate can rely on the ideal comb nesting it just
      // broke — build BOTH full staggered routes, score each against the home
      // runs already routed, and take the one that crosses fewer of them.
      // The greedy score is blind to feeders not yet routed, so ties resolve
      // by the pass-level preference; generateFeeders retries the whole build
      // with the opposite preference if the finished comb still crosses.
      const builtOwn = viaOwnRun ? buildFrom(viaOwnRun) : null;
      const builtDirect = buildFrom(direct);
      // If shifting onto the assigned in-yard run line would cross a feeder
      // already riding toward the fence, keep this feeder on its physical
      // row-exit coordinate until it is outside the fence, then shift across
      // the bundle at its dedicated climb line. This is the other canonical
      // comb shape: all potentially transversal motion happens in the clear
      // exterior strip rather than through established in-yard runs.
      const rawExit: Pt = horizApproach
        ? { x: climbCoord, y: underExit.y }
        : { x: underExit.x, y: climbCoord };
      const outsideShift = stripBacktracks(
        dedupePts([start, underExit, rawExit, laneJoin, waypoint, ...entry]));
      const builtOutside =
        feederCrossesObstacle(outsideShift, homeObstaclesAuto, start, substation) ||
        bandCoRunViolations(outsideShift, crossBands) > 0
          ? null
          : outsideShift;
      // If the straight physical-row exit is blocked, route only that exit
      // leg around the obstruction and make the lane shift in the clear
      // exterior strip. This avoids sending a far row all the way to the
      // opposite side of the yard merely to reach its assigned run line.
      const routedOutsideLeg = routeSegmentTrenchAware(
        start, rawExit, homeObstaclesAuto);
      const routedOutsideCand = stripBacktracks(dedupePts([
        ...routedOutsideLeg, laneJoin, waypoint, ...entry,
      ]));
      const builtRoutedOutside =
        feederCrossesObstacle(
          routedOutsideCand, homeObstaclesAuto, start, substation) ||
        bandCoRunViolations(routedOutsideCand, crossBands) > 0
          ? null
          : routedOutsideCand;
      let builtOpposite: Pt[] | null = null;
      let builtOppositeScore = Infinity;
      const assignedDelta = runCoord - (horizApproach ? start.y : start.x);
      const oppositeSign = -(Math.sign(assignedDelta) || Math.sign(runStep) || 1);
      // A traced bank can be several hundred feet deep; limiting the opposite
      // side search to the feeder count (often only 8–9 steps) forced the far
      // row to detour across the entire yard. Search a bounded 64 trench
      // pitches so the candidate can go around the near end of the real bank
      // without relaxing any obstacle, crossing, or trench-band gate.
      for (let step = 1; step <= 64; step++) {
        const altCoord = (horizApproach ? start.y : start.x) +
          oppositeSign * step * FEEDER_TRENCH_SPACING_FT;
        const altRunStart: Pt = horizApproach
          ? { x: start.x, y: altCoord }
          : { x: altCoord, y: start.y };
        const altExit: Pt = horizApproach
          ? { x: climbCoord, y: altCoord }
          : { x: altCoord, y: climbCoord };
        const cand = stripBacktracks(
          dedupePts([start, altRunStart, altExit, laneJoin, waypoint, ...entry]));
        if (feederCrossesObstacle(cand, homeObstaclesAuto, start, substation) ||
            bandCoRunViolations(cand, crossBands) > 0) continue;
        const score = scoreRoute(cand);
        if (score < builtOppositeScore) {
          builtOpposite = cand;
          builtOppositeScore = score;
          if (score === 0) break;
        }
      }
      let builtViaRoad: Pt[] | null = null;
      if (roadPt) {
        const mid = Math.abs(roadPt.x - underExit.x) >= Math.abs(roadPt.y - underExit.y)
          ? { x: roadPt.x, y: underExit.y }
          : { x: underExit.x, y: roadPt.y };
        const viaRoad = stripBacktracks(dedupePts([
          start, underExit, mid, roadPt, rawExit, laneJoin, waypoint, ...entry,
        ]));
        if (!feederCrossesObstacle(viaRoad, homeObstaclesAuto, start, substation) &&
            bandCoRunViolations(viaRoad, crossBands) === 0) {
          builtViaRoad = viaRoad;
        } else {
          const routed = routeSegmentTrenchAware(underExit, roadPt, homeObstaclesAuto);
          const viaRouted = stripBacktracks(dedupePts([
            start, ...routed, rawExit, laneJoin, waypoint, ...entry,
          ]));
          if (!feederCrossesObstacle(viaRouted, homeObstaclesAuto, start, substation) &&
              bandCoRunViolations(viaRouted, crossBands) === 0) {
            builtViaRoad = viaRouted;
          }
        }
      }
      let disciplined: Pt[] | null;
      if (builtOwn && builtDirect) {
        const ownScore = scoreRoute(builtOwn);
        const directScore = scoreRoute(builtDirect);
        disciplined =
          (tiePreferDirect ? ownScore < directScore : ownScore <= directScore)
            ? builtOwn : builtDirect;
      } else {
        disciplined = builtOwn ?? builtDirect;
      }
      if (builtViaRoad &&
          (!disciplined || scoreRoute(builtViaRoad) < scoreRoute(disciplined))) {
        disciplined = builtViaRoad;
      }
      if (builtOutside &&
          (!disciplined || scoreRoute(builtOutside) < scoreRoute(disciplined))) {
        disciplined = builtOutside;
      }
      if (builtRoutedOutside) {
        const routedScore = scoreRoute(builtRoutedOutside);
        const disciplinedScore = disciplined ? scoreRoute(disciplined) : Infinity;
        const directLength =
          Math.abs(start.x - substation.x) + Math.abs(start.y - substation.y);
        const excessiveDetour = isTracedYard &&
          (!disciplined || polyLen(disciplined) - directLength > 500);
        if (excessiveDetour &&
            (!disciplined || routedScore < disciplinedScore ||
             (routedScore === disciplinedScore &&
              polyLen(builtRoutedOutside) < polyLen(disciplined) - 1e-6))) {
          disciplined = builtRoutedOutside;
        }
      }
      if (builtOpposite &&
          (!disciplined ||
           builtOppositeScore < scoreRoute(disciplined) ||
           (isTracedYard &&
            builtOppositeScore === scoreRoute(disciplined) &&
            polyLen(disciplined) -
              (Math.abs(start.x - substation.x) + Math.abs(start.y - substation.y)) > 500 &&
            polyLen(builtOpposite) < polyLen(disciplined) - 1e-6))) {
        disciplined = builtOpposite;
      }
      if (disciplined) {
        homePts = disciplined;
      } else {
        // Last resort: single grid route to the corridor waypoint, with the
        // legacy sideways nudge if the grid route hugged a shared corridor.
        const approach = routeSegmentTrenchAware(start, waypoint, homeObstaclesAuto);
        homePts = dedupePts([...approach, ...entry]);
        if (Math.abs(spread) > 0.01 && approach.length > 2) {
          const shifted = dedupePts([...offsetOrthogonal(approach, spread), ...entry]);
          if (feederCrossesObstacle(homePts, homeObstaclesAuto, start, substation) &&
              !feederCrossesObstacle(shifted, homeObstaclesAuto, start, substation)) {
            homePts = shifted;
          }
        }
      }
    }
    {
      const alongLaunch = !horizApproach && homePts.length >= 2 &&
        Math.abs(homePts[0].y - homePts[1].y) < 2 &&
        Math.abs(homePts[0].x - homePts[1].x) > 24;
      const alongLaunchH = horizApproach && homePts.length >= 2 &&
        Math.abs(homePts[0].x - homePts[1].x) < 2 &&
        Math.abs(homePts[0].y - homePts[1].y) > 24;
      if (!columnYard && linesVertical === false &&
          (sweepsRow(homePts) || cutsYard(homePts) || alongLaunch || alongLaunchH)) {
        const road = underExit;
        const ride = localRun;
        const forced = stripBacktracks(dedupePts([
          start,
          road,
          horizApproach ? { x: road.x, y: driveAlong } : { x: ride, y: road.y },
          horizApproach ? { x: climbCoord, y: driveAlong } : { x: ride, y: climbCoord },
          exitPt, laneJoin, waypoint, ...entry,
        ]));
        if ((!sweepsRow(forced) && !cutsYard(forced)) ||
            scoreRoute(forced) < scoreRoute(homePts)) homePts = forced;
      } else if (columnYard) {
        const roadX = columnRoadX(last);
        const edgeY = columnEdgeY(last);
        homePts = stripBacktracks(dedupePts(horizApproach
          ? [start, { x: roadX, y: start.y }, { x: roadX, y: edgeY },
              { x: climbCoord, y: edgeY }, exitPt, laneJoin, waypoint, ...entry]
          : [start, { x: roadX, y: start.y }, { x: roadX, y: columnTurnY(climbCoord) },
              { x: runCoord, y: columnTurnY(climbCoord) },
              laneJoin, waypoint, ...entry]));
      }
    }
    // Angled mode: replace the exterior lane ride (climb → lane → approach)
    // with a straight diagonal leg on this feeder's parallel diagonal lane
    // (through its own approach waypoint, shared bundle direction). In-yard
    // legs stay orthogonal; the route resolves back at the approach jog —
    // orthogonal / diagonal / orthogonal with mitered corners, no arcs.
    // Validated with the diagonal-aware obstacle check (the orthogonal
    // checker misses diagonal legs); any failure warns and keeps the 90°
    // route (reject → warn → keep-auto, same policy as drawn routes).
    if (angledSet.has(gi)) {
      let placed = false;
      if (angledDir) {
        // Keep the ACTUAL current in-yard route (which may already be an
        // obstacle-avoiding fallback, not the ideal comb legs) up to its
        // last vertex at or before the climb base, then splice the diagonal
        // from that exit: E → P (on this feeder's parallel diagonal lane
        // through its own approach waypoint) → waypoint → entry jog.
        let ei = -1;
        for (let i = 0; i < homePts.length; i++) {
          const along = horizApproach ? homePts[i].x : homePts[i].y;
          if ((along - climbBase) * dir <= 1e-6) ei = i;
        }
        const denom = horizApproach ? angledDir.y : angledDir.x;
        if (ei >= 0 && Math.abs(denom) > 1e-9) {
          const E = homePts[ei];
          // Intersection of the diagonal lane with the axis line through E.
          const t = horizApproach
            ? (E.y - waypoint.y) / angledDir.y
            : (E.x - waypoint.x) / angledDir.x;
          const P: Pt = horizApproach
            ? { x: waypoint.x + t * angledDir.x, y: E.y }
            : { x: E.x, y: waypoint.y + t * angledDir.y };
          const pAlong = horizApproach ? P.x : P.y;
          const eAlong = horizApproach ? E.x : E.y;
          const wAlong = horizApproach ? waypoint.x : waypoint.y;
          // The diagonal must start outside the fence (past the climb base,
          // and past the exit vertex) and end before the approach —
          // otherwise it would slice through the yard or overshoot.
          const insideStrip =
            (pAlong - climbBase) * dir >= -1e-6 &&
            (pAlong - eAlong) * dir >= -1e-6 &&
            (wAlong - pAlong) * dir >= -1e-6;
          if (insideStrip) {
            const cand = dedupePts([...homePts.slice(0, ei + 1), P, waypoint, ...entry]);
            if (!customRouteCrossesObstacle(cand, homeObstaclesAuto, start, substation)) {
              homePts = cand;
              angledRouted.add(gi);
              placed = true;
            }
          }
        }
      }
      if (!placed) {
        opts.onWarning?.(
          `Angled feeder route #${feederNames[gi].name} not applied: no clear straight diagonal corridor from the yard exit to the substation approach — 90° route kept.`);
      }
    }
    // Automatic offset/reroute fallbacks must never loop behind the
    // substation approach plane. Clamp only such accidental overshoot back
    // onto that plane; the final acceptance gate still rechecks every segment
    // against equipment and trench keep-outs. Drafter overrides below remain
    // WYSIWYG and are not silently altered.
    if (homePts.some(pt =>
      horizApproach
        ? (pt.x - substation.x) * dirX > 1e-9
        : (pt.y - substation.y) * dirY > 1e-9)) {
      homePts = stripBacktracks(dedupePts(homePts.map(pt =>
        horizApproach
          ? {
              x: (pt.x - substation.x) * dirX > 0 ? substation.x : pt.x,
              y: pt.y,
            }
          : {
              x: pt.x,
              y: (pt.y - substation.y) * dirY > 0 ? substation.y : pt.y,
            })));
    }
    // Drafter-drawn route override: replaces the whole home run from the
    // launch point to the substation. Validated with the same obstacle
    // check the automatic route uses (skipped when the engineer forced the
    // route), and always kept inside the padded routing area. Rejection
    // keeps the automatic route and warns with a stable, key-based prefix.
    const routeKey = routeKeyOf[gi];
    const override = opts.routeOverrides?.[routeKey];
    if (override && override.length) {
      consumedRouteKeys.add(routeKey);
      const forced = opts.forcedRoutes?.includes(routeKey) ?? false;
      const finite = override.every(p => Number.isFinite(p.x) && Number.isFinite(p.y));
      // The drawn route replaces the WHOLE home run: launch point, the
      // drafter's waypoints, then straight to the substation (no snap back
      // to the automatic lane entry — WYSIWYG).
      const cand = finite
        ? stripBacktracks(dedupePts([start, ...override, substation]))
        : [];
      let reason: string | null = null;
      if (!finite) reason = 'route contains invalid coordinates';
      else if (cand.length < 2) reason = 'route has no usable length';
      // Bounds-check the RAW waypoints (not just the normalized polyline):
      // stripBacktracks can collapse an out-of-bounds spike, which would
      // silently accept — and silently redraw — a route the drafter drew
      // outside the routing area.
      else if (!override.every(p => p.x >= rbxLo - 1e-9 && p.x <= rbxHi + 1e-9 && p.y >= rbyLo - 1e-9 && p.y <= rbyHi + 1e-9))
        reason = 'route leaves the routing area';
      else if (!forced && customRouteCrossesObstacle(cand, homeObstacles, start, substation))
        reason = 'route crosses equipment or fence clearance';
      if (reason === null) {
        customMeta.set(gi, { key: routeKey, auto: homePts, forced });
        homePts = cand;
        customRouted.add(gi);
      } else {
        opts.onWarning?.(`Custom feeder route ${routeKey} rejected: ${reason} — automatic route kept.`);
      }
    }
    priorHomes.push(homePts);
    segments.push({ pts: homePts, lengthFt: polyLen(homePts), amps: loadCount * perInvAmps });
    }

    const totalLengthFt = segments.reduce((s, seg) => s + seg.lengthFt, 0);

    // --- Conductor selection: ampacity (EOL) AND voltage drop govern ------
    // (register F-01/F-02). Sizing load is the END-OF-LIFE current: built
    // PCS plus the future augmentation PCS reserved on this feeder.
    const futurePcs = futurePcsFor(chain.map(c => c.id));
    const amps = loadCount * perInvAmps;
    const eolAmps = (loadCount + futurePcs) * perInvAmps;
    const adjacentCircuits = feederCount;
    const derateFactor = mutualHeatingDerate(adjacentCircuits);
    const effAmpOf = (sz: ConductorSize) =>
      CONDUCTOR_AMPACITY[material][sz] * derateFactor;

    // Voltage drop for a size/sets pick; per-segment amps scale from BOL to
    // EOL by the same ratio (chain hops carry proportional shares).
    const eolScale = amps > 1e-9 ? eolAmps / amps : 1;
    const vdForSets = (sz: ConductorSize, sets: number) => {
      const rPerFt = CONDUCTOR_R_PER_KFT[material][sz] / 1000 / Math.max(1, sets);
      return segments.reduce(
        (s, seg) => s + Math.sqrt(3) * seg.amps * eolScale * rPerFt * seg.lengthFt, 0);
    };
    const passes = (sz: ConductorSize, sets: number) =>
      sets * effAmpOf(sz) >= eolAmps &&
      (vdForSets(sz, sets) / MV_VOLTAGE) * 100 <= VD_LIMIT_PCT;

    // Manual pick wins (flags below still report against the derated EOL
    // basis); otherwise auto-select the smallest single conductor, then the
    // smallest parallel-set count, that passes BOTH constraints.
    const requestedSize = opts.sizes?.[idx];
    // generateFeeders is also called directly by reports/tests, so enforce the
    // feeder standard here rather than relying only on store/UI sanitization.
    const manualSize = FEEDER_CONDUCTOR_SIZES.includes(requestedSize as FeederConductorSize)
      ? requestedSize as FeederConductorSize
      : undefined;
    let size: ConductorSize = manualSize || '1000';
    let parallelSets = 1;
    if (!manualSize) {
      let found = false;
      outer:
      for (let sets = 1; sets <= 4 && !found; sets++) {
        for (const sz of FEEDER_CONDUCTOR_SIZES) {
          if (passes(sz, sets)) { size = sz; parallelSets = sets; found = true; break outer; }
        }
      }
      if (!found) { // pathological route — pick the biggest and flag it
        size = FEEDER_CONDUCTOR_SIZES[FEEDER_CONDUCTOR_SIZES.length - 1];
        parallelSets = 4;
      }
    }

    // Governing constraint at the selected set count: which requirement
    // forces the larger conductor. Equal minima report as ampacity (the
    // thermal limit is the harder one to fix in the field).
    const minIdxWhere = (ok: (sz: ConductorSize) => boolean): number => {
      for (let i = 0; i < FEEDER_CONDUCTOR_SIZES.length; i++) if (ok(FEEDER_CONDUCTOR_SIZES[i])) return i;
      return FEEDER_CONDUCTOR_SIZES.length; // nothing passes
    };
    const ampMinIdx = minIdxWhere(sz => parallelSets * effAmpOf(sz) >= eolAmps);
    const vdMinIdx = minIdxWhere(sz =>
      (vdForSets(sz, parallelSets) / MV_VOLTAGE) * 100 <= VD_LIMIT_PCT);
    const governing: 'ampacity' | 'voltage-drop' =
      ampMinIdx >= vdMinIdx ? 'ampacity' : 'voltage-drop';

    const vdVolts = vdForSets(size, parallelSets);
    const vdPct = (vdVolts / MV_VOLTAGE) * 100;
    const overLimit = vdPct > VD_LIMIT_PCT;
    let recommendedSize: ConductorSize | null = null;
    if (overLimit) {
      for (const sz of FEEDER_CONDUCTOR_SIZES) {
        if (CONDUCTOR_R_PER_KFT[material][sz] < CONDUCTOR_R_PER_KFT[material][size] &&
            (vdForSets(sz, parallelSets) / MV_VOLTAGE) * 100 <= VD_LIMIT_PCT) {
          recommendedSize = sz;
          break;
        }
      }
      // If no larger size actually meets the limit, leave null so the UI
      // recommends splitting the feeder / moving the substation instead.
    }

    // Ampacity check: EOL feeder current vs. derated conductor rating.
    const effectiveAmp = effAmpOf(size);
    const overAmpacity = eolAmps > parallelSets * effectiveAmp;
    let ampacityRecommendedSize: ConductorSize | null = null;
    let parallelRunsNeeded = parallelSets;
    if (overAmpacity) {
      for (const sz of FEEDER_CONDUCTOR_SIZES) {
        if (effAmpOf(sz) > effectiveAmp &&
            parallelSets * effAmpOf(sz) >= eolAmps) {
          ampacityRecommendedSize = sz;
          break;
        }
      }
      if (!ampacityRecommendedSize) {
        const largest = FEEDER_CONDUCTOR_SIZES[FEEDER_CONDUCTOR_SIZES.length - 1];
        parallelRunsNeeded = Math.ceil(eolAmps / effAmpOf(largest));
      }
    }

    return {
      idx,
      name: feederNames[gi].name,
      inverterIds: chain.map(c => c.id),
      loadMW: loadCount * blockMW,
      amps: loadCount * perInvAmps,
      segments,
      totalLengthFt,
      size,
      material,
      vdVolts,
      vdPct,
      overLimit,
      recommendedSize,
      ampacity: CONDUCTOR_AMPACITY[material][size],
      // MV feeders bypass the junction boxes (fiber-only per CAR-D-B005-0).
      fjbId: null,
      overAmpacity,
      ampacityRecommendedSize,
      parallelRunsNeeded,
      futurePcs,
      eolAmps,
      parallelSets,
      effectiveAmpacity: effectiveAmp,
      adjacentCircuits,
      derateFactor,
      governing,
      routingRuleset: ROUTING_RULESET_ID,
      routeValid: true,
      routeDiagnostics: [],
    };
  });
  // Dormant route overrides: a key that matched no live feeder (regrouping
  // moved its anchor inverter, or the layout shrank) is kept but unused —
  // warn so the drafter knows the drawn route is not in effect.
  if (opts.routeOverrides) {
    for (const k of Object.keys(opts.routeOverrides)) {
      if (!consumedRouteKeys.has(k)) {
        opts.onWarning?.(
          `Custom feeder route ${k} is inactive: no feeder currently anchors on that PCS — the drawn route is kept but unused until the grouping matches again.`);
      }
    }
  }

  // --- MV route cleanup: collinear-vertex merge (register F-13) -------------
  // Reroute/offset passes can leave interior vertices that sit ON a straight
  // leg (zero-degree "bends"). They read as spurious trench joints in CAD and
  // inflate the bend count. Dropping them is a pure geometry no-op (same
  // polyline, same length). Applied to AUTO inter-inverter CHAIN segments
  // only: the home run (last segment) keeps its vertex structure because the
  // cross-feeder separation pass below and its overlap bookkeeping are
  // calibrated to those vertices — merging them changes which shared
  // stretches the re-layer attempts and can leave real overlaps unfixed.
  // Drafter-drawn routes are WYSIWYG and never touched.
  for (let gi = 0; gi < circuits.length; gi++) {
    if (customRouted.has(gi)) continue;
    const segs = circuits[gi].segments;
    for (let si = 0; si < segs.length - 1; si++) {
      segs[si].pts = mergeCollinear(segs[si].pts);
    }
  }

  // Geometry changed — keep the electrical outputs derived from segment
  // lengths consistent with the final route. Shared by the separation pass
  // below and the 45° chamfer pass after it.
  const refreshElectrical = (c: FeederCircuit) => {
    c.totalLengthFt = c.segments.reduce((s, sg) => s + sg.lengthFt, 0);
    // Same EOL basis + parallel-set division the initial sizing used.
    const scale = c.amps > 1e-9 ? c.eolAmps / c.amps : 1;
    const vdFor = (sz: ConductorSize) => {
      const rPerFt = CONDUCTOR_R_PER_KFT[c.material][sz] / 1000 / Math.max(1, c.parallelSets);
      return c.segments.reduce((s, sg) => s + Math.sqrt(3) * sg.amps * scale * rPerFt * sg.lengthFt, 0);
    };
    c.vdVolts = vdFor(c.size);
    c.vdPct = (c.vdVolts / MV_VOLTAGE) * 100;
    c.overLimit = c.vdPct > VD_LIMIT_PCT;
    c.recommendedSize = null;
    if (c.overLimit) {
      for (const sz of FEEDER_CONDUCTOR_SIZES) {
        if (CONDUCTOR_R_PER_KFT[c.material][sz] < CONDUCTOR_R_PER_KFT[c.material][c.size] &&
            (vdFor(sz) / MV_VOLTAGE) * 100 <= VD_LIMIT_PCT) {
          c.recommendedSize = sz;
          break;
        }
      }
    }
    const minIdxWhere = (ok: (sz: ConductorSize) => boolean): number => {
      for (let i = 0; i < FEEDER_CONDUCTOR_SIZES.length; i++) {
        if (ok(FEEDER_CONDUCTOR_SIZES[i])) return i;
      }
      return FEEDER_CONDUCTOR_SIZES.length;
    };
    const ampMinIdx = minIdxWhere(sz =>
      c.parallelSets * CONDUCTOR_AMPACITY[c.material][sz] * c.derateFactor >= c.eolAmps);
    const vdMinIdx = minIdxWhere(sz =>
      (vdFor(sz) / MV_VOLTAGE) * 100 <= VD_LIMIT_PCT);
    c.governing = ampMinIdx >= vdMinIdx ? 'ampacity' : 'voltage-drop';
  };

  // --- Cross-feeder collinear home-run separation ---------------------------
  // Grid-rerouted home runs (packed island corridors: gear + island aug
  // zones can leave fewer clear lanes than feeders) may collapse onto one
  // shared grid path — reading as a combined trunk trench, which the
  // reference forbids (every feeder rides its OWN parallel trench). Detect
  // long collinear overlaps between DIFFERENT feeders' home runs and re-lay
  // the later feeder's run on its own parallel line. Overlaps at the
  // substation approach are the one legitimate convergence point and stay
  // untouched.
  {
    const OVL_FT = 50;   // shared stretch longer than this reads as one trench
    const LAT_FT = 1.5;  // pieces closer than this are "the same line"
    type Piece = { horiz: boolean; c: number; lo: number; hi: number; k: number };
    const piecesOf = (pts: Pt[]): Piece[] => {
      const out: Piece[] = [];
      for (let k = 0; k < pts.length - 1; k++) {
        const a = pts[k], b = pts[k + 1];
        if (Math.abs(a.y - b.y) < 1e-6 && Math.abs(a.x - b.x) > 1e-6) {
          out.push({ horiz: true, c: a.y, lo: Math.min(a.x, b.x), hi: Math.max(a.x, b.x), k });
        } else if (Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) > 1e-6) {
          out.push({ horiz: false, c: a.x, lo: Math.min(a.y, b.y), hi: Math.max(a.y, b.y), k });
        }
      }
      return out;
    };
    const allowedConvergence = (horiz: boolean, c: number, mid: number): boolean => {
      const mx = horiz ? mid : c, my = horiz ? c : mid;
      return Math.hypot(mx - substation.x, my - substation.y) < SUBSTATION_APPROACH_FT + 20;
    };
    // Candidates must stay inside the padded routing bounds — the bbox-edge
    // clamp guarantee for impossible layouts must survive this pass.
    const bxLo = Math.min(...bounds.map(p => p.x)), bxHi = Math.max(...bounds.map(p => p.x));
    const byLo = Math.min(...bounds.map(p => p.y)), byHi = Math.max(...bounds.map(p => p.y));
    const inBounds = (pts: Pt[]) => pts.every(p =>
      p.x >= bxLo - 1e-9 && p.x <= bxHi + 1e-9 && p.y >= byLo - 1e-9 && p.y <= byHi + 1e-9);
    // Returns the pts-index of the first offending leg, or -1 when clean.
    const firstOverlap = (pts: Pt[], earlier: Piece[][]): number => {
      for (const p of piecesOf(pts)) {
        for (const eps of earlier) for (const q of eps) {
          if (p.horiz !== q.horiz || Math.abs(p.c - q.c) >= LAT_FT) continue;
          const lo = Math.max(p.lo, q.lo), hi = Math.min(p.hi, q.hi);
          if (hi - lo <= OVL_FT) continue;
          if (!allowedConvergence(p.horiz, p.c, (lo + hi) / 2)) return p.k;
        }
      }
      return -1;
    };
    const earlier: Piece[][] = [];
    for (let ci = 0; ci < circuits.length; ci++) {
      const c = circuits[ci];
      const seg = c.segments[c.segments.length - 1];
      // Drafter-drawn routes are WYSIWYG: never re-lay them here — but they
      // must not read as a combined trunk either (every feeder rides its
      // OWN trench, per the reference). A non-forced custom route lying
      // collinear with an earlier feeder's trench for more than OVL_FT is
      // rejected here: reverted to its automatic route with the same stable
      // warning prefix as up-front validation. Forced routes stay — the
      // engineer owns the overlap.
      const meta = customRouted.has(ci) ? customMeta.get(ci) : undefined;
      if (seg && meta && !meta.forced && seg.pts.length >= 2 &&
          firstOverlap(seg.pts, earlier) >= 0) {
        seg.pts = meta.auto;
        seg.lengthFt = polyLen(meta.auto);
        refreshElectrical(c);
        customRouted.delete(ci);
        lateRejectedRouteKeys.add(meta.key);
        opts.onWarning?.(
          `Custom feeder route ${meta.key} rejected: route overlaps another feeder's trench — automatic route kept.`);
      }
      // Angled routes are never re-laid here either: offsetOrthogonal and
      // the leg re-lay assume axis-aligned polylines and would corrupt the
      // diagonal leg. Their geometry is crossing-free by construction
      // (parallel diagonal lanes, rank-ordered run/approach lines).
      const badK = seg && !customRouted.has(ci) && !angledRouted.has(ci) && seg.pts.length >= 3
        ? firstOverlap(seg.pts, earlier) : -1;
      if (seg && badK >= 0) {
        const start = seg.pts[0], end = seg.pts[seg.pts.length - 1];
        const obs = autoObs(obstaclesExcept(c.inverterIds[c.inverterIds.length - 1]))
          .concat(gateObsFrom(start), clusterRects);
        // Trench-band discipline must not REGRESS while re-laying: a
        // candidate may never co-run the crossable spine more than the
        // route it replaces already does.
        const curCoRun = bandCoRunViolations(seg.pts, crossBands);
        const accept = (cand: Pt[]): boolean => {
          if (cand.length < 2 || !inBounds(cand) || firstOverlap(cand, earlier) >= 0) return false;
          if (feederCrossesObstacle(cand, obs, start, end)) return false;
          if (bandCoRunViolations(cand, crossBands) > curCoRun) return false;
          if (clusterHits(cand) > 0 || sweepsRow(cand) || cutsYard(cand) || fieldComb(cand)) return false;
          seg.pts = cand;
          seg.lengthFt = polyLen(cand);
          refreshElectrical(c);
          return true;
        };
        let fixed = false;
        // First try shifting the whole run onto a parallel line…
        for (const m of [1, -1, 2, -2, 3, -3]) {
          if (accept(stripBacktracks(dedupePts(
            offsetOrthogonal(seg.pts, m * FEEDER_TRENCH_SPACING_FT))))) { fixed = true; break; }
        }
        // …then fall back to re-laying offending legs with two short jogs
        // each, leaving the rest of the (already obstacle-checked) route.
        // ITERATIVE: a grid-rerouted run can share MORE THAN ONE leg with an
        // earlier feeder (e.g. a corridor leg AND a gap-column leg); fixing
        // one leg at a time and re-scanning lets each re-lay stand on its
        // own instead of demanding a single candidate cure every overlap.
        if (!fixed) {
          let work = seg.pts;
          let k = badK;
          for (let iter = 0; iter < 6 && k >= 0; iter++) {
            const p0 = work[k], p1 = work[k + 1];
            const horiz = Math.abs(p0.y - p1.y) < 1e-6;
            let progressed = false;
            // Fine offsets first: grid-rerouted legs often thread a narrow
            // inter-pair gap column (~14 ft) where a full trench-spacing
            // shift lands inside equipment — a 3-6 ft parallel line inside
            // the same column still separates the trenches past the LAT
            // threshold.
            for (const off of [3, -3, 6, -6,
              ...[1, -1, 2, -2, 3, -3, 4, -4].map(m => m * FEEDER_TRENCH_SPACING_FT)]) {
              const relaid: Pt[] = horiz
                ? [{ x: p0.x, y: p0.y + off }, { x: p1.x, y: p1.y + off }]
                : [{ x: p0.x + off, y: p0.y }, { x: p1.x + off, y: p1.y }];
              const cand = stripBacktracks(dedupePts([
                ...work.slice(0, k + 1), ...relaid, ...work.slice(k + 1),
              ]));
              if (cand.length < 2 || !inBounds(cand)) continue;
              if (feederCrossesObstacle(cand, obs, start, end)) continue;
              if (bandCoRunViolations(cand, crossBands) > curCoRun) continue;
              const nk = firstOverlap(cand, earlier);
              // Accept a candidate that clears THIS leg (the next offending
              // leg, if any, lies further along) — never one that merely
              // moves the problem backwards.
              if (nk === -1 || nk > k) {
                work = cand;
                k = nk;
                progressed = true;
                break;
              }
            }
            // Last resort for this leg: re-route it with every earlier
            // feeder's trench piece added as a thin pseudo-obstacle, so the
            // grid router is FORCED onto a different clear channel (e.g. the
            // next gap column over) instead of the one it shares.
            if (!progressed) {
              const pseudo: Rect[] = [];
              for (const eps of earlier) for (const q of eps) {
                pseudo.push(q.horiz
                  ? { x1: q.lo - 0.1, x2: q.hi + 0.1, y1: q.c - LAT_FT, y2: q.c + LAT_FT }
                  : { x1: q.c - LAT_FT, x2: q.c + LAT_FT, y1: q.lo - 0.1, y2: q.hi + 0.1 });
              }
              const legRoute = routeSegment(work[k], work[k + 1], [...obs, ...pseudo], bounds);
              if (legRoute.length > 2) {
                const cand = stripBacktracks(dedupePts([
                  ...work.slice(0, k + 1), ...legRoute.slice(1, -1), ...work.slice(k + 1),
                ]));
                if (cand.length >= 2 && inBounds(cand) &&
                    !feederCrossesObstacle(cand, obs, start, end) &&
                    bandCoRunViolations(cand, crossBands) <= curCoRun) {
                  const nk = firstOverlap(cand, earlier);
                  if (nk === -1 || nk > k) {
                    work = cand;
                    k = nk;
                    progressed = true;
                  }
                }
              }
            }
            if (!progressed) break;
          }
          if (k === -1) {
            seg.pts = work;
            seg.lengthFt = polyLen(work);
            refreshElectrical(c);
          }
        }
      }
      earlier.push(piecesOf(c.segments[c.segments.length - 1]?.pts ?? []));
    }
  }
  if (lateRejectedRouteKeys.size) {
    const remainingRoutes = Object.fromEntries(
      Object.entries(opts.routeOverrides ?? {})
        .filter(([key]) => !lateRejectedRouteKeys.has(key)));
    return generateFeeders(design, substation, blockMW, {
      ...opts,
      routeOverrides: Object.keys(remainingRoutes).length ? remainingRoutes : null,
      forcedRoutes: (opts.forcedRoutes ?? [])
        .filter(key => !lateRejectedRouteKeys.has(key)),
    });
  }

  // Separation/offset passes can append a small automatic end jog behind the
  // substation plane. Project that accidental overshoot back to the terminal
  // plane before loop cleanup, which can then remove the resulting redundant
  // excursion under its full obstacle/crossing validation.
  for (let gi = 0; gi < circuits.length; gi++) {
    if (customRouted.has(gi)) continue;
    const seg = circuits[gi].segments[circuits[gi].segments.length - 1];
    if (!seg?.pts.length || !seg.pts.some(pt =>
      horizApproach
        ? (pt.x - substation.x) * dirX > 1e-9
        : (pt.y - substation.y) * dirY > 1e-9)) continue;
    seg.pts = stripBacktracks(dedupePts(seg.pts.map(pt =>
      horizApproach
        ? {
            x: (pt.x - substation.x) * dirX > 0 ? substation.x : pt.x,
            y: pt.y,
          }
        : {
            x: pt.x,
            y: (pt.y - substation.y) * dirY > 0 ? substation.y : pt.y,
          })));
    seg.lengthFt = polyLen(seg.pts);
    refreshElectrical(circuits[gi]);
  }

  // --- Task 902: MV home-run loop / hairpin cleanup -------------------------
  // Run AFTER the reroute / offset / collinear-merge / cross-feeder
  // separation passes (which can leave a redundant excursion or a 90°
  // loop-back), but BEFORE the cosmetic chamfer and the final audits, and
  // BEFORE the electrical outputs are read out. Applied to AUTOMATIC
  // orthogonal home runs ONLY: drafter-drawn (WYSIWYG) and angled-mode
  // routes are never touched — the shortcut would corrupt the drawn / diagonal
  // geometry. Every shortcut is validated against equipment / fence / gate
  // keep-outs, the padded routing bounds, the crossable-band discipline (no
  // regression) and cross-feeder crossings before it is accepted; a loop the
  // router genuinely needed to dodge an obstacle fails validation and stays.
  {
    const bxLo = Math.min(...bounds.map(p => p.x)), bxHi = Math.max(...bounds.map(p => p.x));
    const byLo = Math.min(...bounds.map(p => p.y)), byHi = Math.max(...bounds.map(p => p.y));
    const inBounds = (pts: Pt[]) => pts.every(p =>
      p.x >= bxLo - 1e-9 && p.x <= bxHi + 1e-9 && p.y >= byLo - 1e-9 && p.y <= byHi + 1e-9);
    // Cross-feeder crossings: a shortcut may never introduce a NEW crossing
    // against any OTHER feeder's final home run (drawn or auto).
    const homeOf = (ci: number): Pt[] => {
      const s = circuits[ci].segments[circuits[ci].segments.length - 1];
      return s?.pts ?? [];
    };
    const crossCountVs = (pts: Pt[], selfCi: number): number => {
      let n = 0;
      for (let ci = 0; ci < circuits.length; ci++) {
        if (ci === selfCi) continue;
        const other = homeOf(ci);
        for (let s = 0; s < pts.length - 1; s++)
          for (let t = 0; t < other.length - 1; t++)
            if (properCross(pts[s], pts[s + 1], other[t], other[t + 1])) n++;
      }
      return n;
    };
    for (let gi = 0; gi < circuits.length; gi++) {
      if (customRouted.has(gi) || angledRouted.has(gi)) continue;
      const c = circuits[gi];
      const seg = c.segments[c.segments.length - 1];
      if (!seg || seg.pts.length < 4) continue;
      const start = seg.pts[0], end = seg.pts[seg.pts.length - 1];
      const obs = autoObs(obstaclesExcept(c.inverterIds[c.inverterIds.length - 1]))
        .concat(gateObsFrom(start), clusterRects);
      const curCoRun = bandCoRunViolations(seg.pts, crossBands);
      const curCross = crossCountVs(seg.pts, gi);
      const accept = (cand: Pt[]): boolean => {
        if (cand.length < 2 || !inBounds(cand)) return false;
        // Endpoints must be preserved (only the interior may collapse).
        const cs = cand[0], ce = cand[cand.length - 1];
        if (Math.hypot(cs.x - start.x, cs.y - start.y) > 1e-6 ||
            Math.hypot(ce.x - end.x, ce.y - end.y) > 1e-6) return false;
        if (feederCrossesObstacle(cand, obs, start, end)) return false;
        if (bandCoRunViolations(cand, crossBands) > curCoRun) return false;
        if (crossCountVs(cand, gi) > curCross) return false;
        if (clusterHits(cand) > 0) return false;
        if (sweepsRow(cand) || cutsYard(cand) || fieldComb(cand)) return false;
        return true;
      };
      let fixed = stripOrthogonalLoops(seg.pts, accept);
      const directLength =
        Math.abs(start.x - end.x) + Math.abs(start.y - end.y);
      // Do NOT L-shortcut or midpoint-nudge traced yards: those passes
      // pull a long perimeter detour back through the container rows
      // (Area 2 light-blue across the top of PCS06).
      if (polyLen(fixed) < seg.lengthFt - 1e-6) {
        seg.pts = fixed;
        seg.lengthFt = polyLen(fixed);
        refreshElectrical(c);
      }
    }
  }

  // --- Final automatic de-braiding before cosmetic chamfers -----------------
  // Obstacle and overlap cleanup above can change a route after the initial
  // greedy comb was scored. If that introduces a transversal crossing, give
  // the later feeder one deterministic grid retry with earlier home runs as
  // thin keep-outs. The retry still lands on its assigned corridor lane; it
  // only changes the in-yard approach to that lane. If no legal retry exists,
  // the fail-closed acceptance pass below omits the route.
  {
    const conv = substationConvergenceWindow(design, substation, circuits.length, {
      maxPerFeeder: maxPer,
      corridorPin: opts.corridorPin,
      approach: opts.approach,
    });
    const crossPoint = (a: Pt, b: Pt, c: Pt, d2: Pt): Pt | null => {
      if (!properCross(a, b, c, d2)) return null;
      const den = (a.x - b.x) * (c.y - d2.y) - (a.y - b.y) * (c.x - d2.x);
      if (Math.abs(den) < 1e-12) return null;
      const det1 = a.x * b.y - a.y * b.x;
      const det2 = c.x * d2.y - c.y * d2.x;
      return {
        x: (det1 * (c.x - d2.x) - (a.x - b.x) * det2) / den,
        y: (det1 * (c.y - d2.y) - (a.y - b.y) * det2) / den,
      };
    };
    const sanctioned = (p: Pt): boolean =>
      p.x >= conv.x1 && p.x <= conv.x2 && p.y >= conv.y1 && p.y <= conv.y2;
    const crossingCount = (pts: Pt[], others: Pt[][]): number => {
      let n = 0;
      for (const other of others) {
        for (let i = 0; i < pts.length - 1; i++) {
          for (let j = 0; j < other.length - 1; j++) {
            const p = crossPoint(pts[i], pts[i + 1], other[j], other[j + 1]);
            if (p && !sanctioned(p)) n++;
          }
        }
      }
      return n;
    };
    // Preserve the established comb repair first. It is intentionally
    // conservative and keeps already-correct yards byte-identical.
    const earlier: Pt[][] = [];
    for (let gi = 0; gi < circuits.length; gi++) {
      const c = circuits[gi];
      const home = c.segments[c.segments.length - 1];
      if (!home || customRouted.has(gi) || crossingCount(home.pts, earlier) === 0) {
        earlier.push(home?.pts ?? []);
        continue;
      }
      const start = home.pts[0];
      const dir = horizApproach ? dirX : dirY;
      const waypointCoord = horizApproach
        ? substation.x - dirX * SUBSTATION_APPROACH_FT
        : substation.y - dirY * SUBSTATION_APPROACH_FT;
      const climbLimit = waypointCoord - dir * FEEDER_TRENCH_SPACING_FT;
      const climbAvail = (climbLimit - climbOrigin) * dir;
      const climbStep = feederCount > 1 && climbAvail > 0
        ? Math.min(FEEDER_TRENCH_SPACING_FT, climbAvail / (feederCount - 1))
        : FEEDER_TRENCH_SPACING_FT;
      const climbRaw = climbOrigin + dir * climbOrderOf[gi] * climbStep;
      const climbCoord = dir > 0
        ? Math.min(climbRaw, climbLimit)
        : Math.max(climbRaw, climbLimit);
      const spread = spreadOf(laneRankOf[gi]);
      const exitPt: Pt = horizApproach
        ? { x: climbCoord, y: runCoordOf[gi] }
        : { x: runCoordOf[gi], y: climbCoord };
      const laneJoin: Pt = horizApproach
        ? { x: climbCoord, y: laneCenter + spread }
        : { x: laneCenter + spread, y: climbCoord };
      const waypoint: Pt = horizApproach
        ? { x: waypointCoord, y: laneCenter + spread }
        : { x: laneCenter + spread, y: waypointCoord };
      const entry: Pt[] = horizApproach
        ? [{ x: substation.x, y: waypoint.y }, substation]
        : [{ x: waypoint.x, y: substation.y }, substation];
      const pseudo: Rect[] = [];
      for (const pts of earlier) {
        for (let i = 0; i < pts.length - 1; i++) {
          const a = pts[i], b = pts[i + 1];
          const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
          if (sanctioned(mid)) continue;
          pseudo.push({
            x1: Math.min(a.x, b.x) - 1.6,
            x2: Math.max(a.x, b.x) + 1.6,
            y1: Math.min(a.y, b.y) - 1.6,
            y2: Math.max(a.y, b.y) + 1.6,
          });
        }
      }
      const actualObs = autoObs(obstaclesExcept(pre[gi].launch.id))
        .concat(gateObsFrom(start), clusterRects);
      const targets: { target: Pt; tail: Pt[] }[] = [
        { target: exitPt, tail: [laneJoin, waypoint, ...entry] },
        { target: laneJoin, tail: [waypoint, ...entry] },
      ];
      let repaired: Pt[] | null = null;
      for (const { target, tail } of targets) {
        const approach = routeSegmentTrenchAware(start, target, [...actualObs, ...pseudo]);
        const cand = stripBacktracks(dedupePts([...approach, ...tail]));
        if (feederCrossesObstacle(cand, actualObs, start, substation) ||
            bandCoRunViolations(cand, crossBands) > 0 ||
            crossingCount(cand, earlier) > 0 ||
            clusterHits(cand) > 0 ||
            sweepsRow(cand) ||
            cutsYard(cand)) continue;
        repaired = cand;
        break;
      }
      if (repaired) {
        home.pts = repaired;
        home.lengthFt = polyLen(repaired);
        refreshElectrical(c);
      }
      earlier.push(home.pts);
    }
  }

  // Last keep-out repair: later separation/shortcut passes must never leave
  // a home run through a container yard. Rebuild a perimeter comb when they do.
  // Column yards (Area 1/3) keep under-PCS / island routing — this rebuild
  // is the row-field-edge comb and would cut those courtyards.
  if (linesVertical === false && tracedHorizontalRows) {
    for (let gi = 0; gi < circuits.length; gi++) {
      if (customRouted.has(gi) || angledRouted.has(gi)) continue;
      const c = circuits[gi];
      const seg = c.segments[c.segments.length - 1];
      if (!seg || seg.pts.length < 2) continue;
      const hits = clusterHits(seg.pts);
      const alongCol = !horizApproach && seg.pts.length >= 2 &&
        Math.abs(seg.pts[0].x - seg.pts[1].x) < 2 &&
        Math.abs(seg.pts[0].y - seg.pts[1].y) > 20;
      const alongColH = horizApproach && seg.pts.length >= 2 &&
        Math.abs(seg.pts[0].y - seg.pts[1].y) < 2 &&
        Math.abs(seg.pts[0].x - seg.pts[1].x) > 20;
      if (hits === 0 && !sweepsRow(seg.pts) && !cutsYard(seg.pts) &&
          !fieldComb(seg.pts) &&
          !(linesVertical === false && (alongCol || alongColH))) continue;
      const start = seg.pts[0];
      const last = pre[gi].launch;
      const localRun = (() => {
        if (!clusterRects.length) return peelRoadCoord(last, start, !horizApproach);
        const lo = Math.min(...clusterRects.map(r => horizApproach ? r.y1 : r.x1));
        const hi = Math.max(...clusterRects.map(r => horizApproach ? r.y2 : r.x2));
        const s = horizApproach ? start.y : start.x;
        const sign = s < (lo + hi) / 2 ? -1 : 1;
        let edge = sign < 0 ? lo - 8 : hi + 8;
        const snap: Pt = horizApproach ? { x: start.x, y: edge } : { x: edge, y: start.y };
        if (feederCrossesObstacle([start, snap], clusterRects, start, snap)) {
          edge = pcsRoadFaceCoord(last, !horizApproach);
        }
        return edge + sign * (peelOffsetOf[gi] ?? 0);
      })();
      const dir = horizApproach ? dirX : dirY;
      const spread = spreadOf(laneRankOf[gi]);
      const waypointCoord = horizApproach
        ? substation.x - dirX * SUBSTATION_APPROACH_FT
        : substation.y - dirY * SUBSTATION_APPROACH_FT;
      const climbLimit = waypointCoord - dir * FEEDER_TRENCH_SPACING_FT;
      const climbAvail = (climbLimit - climbOrigin) * dir;
      const climbStep = feederCount > 1 && climbAvail > 0
        ? Math.min(FEEDER_TRENCH_SPACING_FT, climbAvail / (feederCount - 1))
        : FEEDER_TRENCH_SPACING_FT;
      const climbRaw = climbOrigin + dir * climbOrderOf[gi] * climbStep;
      const climbCoord = dir > 0
        ? Math.min(climbRaw, climbLimit)
        : Math.max(climbRaw, climbLimit);
      const runCoord = runCoordOf[gi];
      const laneJoin: Pt = horizApproach
        ? { x: climbCoord, y: laneCenter + spread }
        : { x: laneCenter + spread, y: climbCoord };
      const waypoint: Pt = horizApproach
        ? { x: waypointCoord, y: laneCenter + spread }
        : { x: laneCenter + spread, y: waypointCoord };
      const entry: Pt[] = horizApproach
        ? [{ x: substation.x, y: waypoint.y }, substation]
        : [{ x: waypoint.x, y: substation.y }, substation];
      const roadAlong0 = horizApproach
        ? start.x + dirX * 16
        : start.y + dirY * 16;
      const roadAlong = roadAlong0;
      const along0 = horizApproach ? start.y : start.x;
      const nearEdge = Math.abs(localRun - along0) < 48;
      const faceY = pcsRoadFaceCoord(last, false);
      const driveY = Math.abs(faceY - start.y) < 24 ? faceY : start.y;
      const forced = stripBacktracks(dedupePts(
        horizApproach
          ? [
              start,
              { x: start.x + dirX * 16, y: start.y },
              { x: start.x + dirX * 16, y: driveY },
              { x: climbCoord, y: driveY },
              { x: climbCoord, y: runCoord },
              laneJoin, waypoint, ...entry,
            ]
          : nearEdge
          ? [
              start,
              { x: localRun, y: start.y },
              { x: localRun, y: climbCoord },
              { x: runCoord, y: climbCoord },
              laneJoin, waypoint, ...entry,
            ]
          : [
              start,
              { x: start.x, y: roadAlong },
              { x: localRun, y: roadAlong },
              { x: localRun, y: climbCoord },
              { x: runCoord, y: climbCoord },
              laneJoin, waypoint, ...entry,
            ],
      ));
      const fh = clusterHits(forced);
      if (fh < hits ||
          (fh === 0 &&
           (sweepsRow(seg.pts) || cutsYard(seg.pts) || alongCol || alongColH) &&
           !sweepsRow(forced) && !cutsYard(forced)) ||
          (fieldComb(seg.pts) && !cutsYard(forced))) {
        seg.pts = forced;
        seg.lengthFt = polyLen(forced);
        refreshElectrical(c);
      }
    }
  } else if (!(isTracedYard && !tracedHorizontalRows)) {
    for (let gi = 0; gi < circuits.length; gi++) {
      if (customRouted.has(gi) || angledRouted.has(gi)) continue;
      const c = circuits[gi];
      const seg = c.segments[c.segments.length - 1];
      if (!seg || seg.pts.length < 2) continue;
      if (!fieldComb(seg.pts) && !cutsYard(seg.pts) && clusterHits(seg.pts) === 0) continue;
      const start = seg.pts[0];
      const road = pcsRoadToward(pre[gi].launch, start);
      const dir = horizApproach ? dirX : dirY;
      const spread = spreadOf(laneRankOf[gi]);
      const waypointCoord = horizApproach
        ? substation.x - dirX * SUBSTATION_APPROACH_FT
        : substation.y - dirY * SUBSTATION_APPROACH_FT;
      const climbLimit = waypointCoord - dir * FEEDER_TRENCH_SPACING_FT;
      const climbAvail = (climbLimit - climbOrigin) * dir;
      const climbStep = feederCount > 1 && climbAvail > 0
        ? Math.min(FEEDER_TRENCH_SPACING_FT, climbAvail / (feederCount - 1))
        : FEEDER_TRENCH_SPACING_FT;
      const climbRaw = climbOrigin + dir * climbOrderOf[gi] * climbStep;
      const climbCoord = dir > 0
        ? Math.min(climbRaw, climbLimit)
        : Math.max(climbRaw, climbLimit);
      const runCoord = runCoordOf[gi];
      const laneJoin: Pt = horizApproach
        ? { x: climbCoord, y: laneCenter + spread }
        : { x: laneCenter + spread, y: climbCoord };
      const waypoint: Pt = horizApproach
        ? { x: waypointCoord, y: laneCenter + spread }
        : { x: laneCenter + spread, y: waypointCoord };
      const entry: Pt[] = horizApproach
        ? [{ x: substation.x, y: waypoint.y }, substation]
        : [{ x: waypoint.x, y: substation.y }, substation];
      const forced = stripBacktracks(dedupePts(
        horizApproach
          ? [
              start, road, { x: climbCoord, y: road.y },
              { x: climbCoord, y: runCoord },
              laneJoin, waypoint, ...entry,
            ]
          : [
              start, road, { x: road.x, y: climbCoord },
              { x: runCoord, y: climbCoord },
              laneJoin, waypoint, ...entry,
            ],
      ));
      if (clusterHits(forced) < clusterHits(seg.pts) ||
          ((cutsYard(seg.pts) || fieldComb(seg.pts)) &&
           !cutsYard(forced) && clusterHits(forced) <= clusterHits(seg.pts))) {
        seg.pts = forced;
        seg.lengthFt = polyLen(forced);
        refreshElectrical(c);
      }
    }
  }

  // Any home run still sampling a battery yard is forced onto the road-side
  // exit. Fail-open L/grid fallbacks used to keep the illegal geometry.
  {
    for (let gi = 0; gi < circuits.length; gi++) {
      if (customRouted.has(gi) || angledRouted.has(gi)) continue;
      const c = circuits[gi];
      const seg = c.segments[c.segments.length - 1];
      if (!seg || seg.pts.length < 2) continue;
      const hits = clusterHits(seg.pts);
      if (hits === 0 && !cutsYard(seg.pts)) continue;
      const start = seg.pts[0];
      const lastEq = pre[gi].launch;
      const dir = horizApproach ? dirX : dirY;
      const spread = spreadOf(laneRankOf[gi]);
      const waypointCoord = horizApproach
        ? substation.x - dirX * SUBSTATION_APPROACH_FT
        : substation.y - dirY * SUBSTATION_APPROACH_FT;
      const climbLimit = waypointCoord - dir * FEEDER_TRENCH_SPACING_FT;
      const climbAvail = (climbLimit - climbOrigin) * dir;
      const climbStep = feederCount > 1 && climbAvail > 0
        ? Math.min(FEEDER_TRENCH_SPACING_FT, climbAvail / (feederCount - 1))
        : FEEDER_TRENCH_SPACING_FT;
      const climbRaw = climbOrigin + dir * climbOrderOf[gi] * climbStep;
      const climbCoord = dir > 0
        ? Math.min(climbRaw, climbLimit)
        : Math.max(climbRaw, climbLimit);
      const runCoord = runCoordOf[gi];
      const laneJoin: Pt = horizApproach
        ? { x: climbCoord, y: laneCenter + spread }
        : { x: laneCenter + spread, y: climbCoord };
      const waypoint: Pt = horizApproach
        ? { x: waypointCoord, y: laneCenter + spread }
        : { x: laneCenter + spread, y: waypointCoord };
      const entry: Pt[] = horizApproach
        ? [{ x: substation.x, y: waypoint.y }, substation]
        : [{ x: waypoint.x, y: substation.y }, substation];
      const forced = (isTracedYard && !tracedHorizontalRows)
        ? stripBacktracks(dedupePts(horizApproach
          ? [start, { x: columnRoadX(lastEq), y: start.y },
              { x: columnRoadX(lastEq), y: columnEdgeY(lastEq) },
              { x: climbCoord, y: columnEdgeY(lastEq) },
              { x: climbCoord, y: runCoord }, laneJoin, waypoint, ...entry]
          : [start, { x: columnRoadX(lastEq), y: start.y },
              { x: columnRoadX(lastEq), y: columnTurnY(climbCoord) },
              { x: runCoord, y: columnTurnY(climbCoord) }, laneJoin, waypoint, ...entry]))
        : stripBacktracks(dedupePts(
        horizApproach
          ? [
              start, pcsRoadToward(lastEq, start), { x: pcsRoadToward(lastEq, start).x, y: (() => {
                const road = pcsRoadToward(lastEq, start);
                const face = pcsRoadFaceCoord(lastEq, !horizApproach);
                const drive = Math.abs(face - start.y) < 24 ? face : road.y;
                return drive;
              })() },
              { x: climbCoord, y: (() => {
                const road = pcsRoadToward(lastEq, start);
                const face = pcsRoadFaceCoord(lastEq, !horizApproach);
                return Math.abs(face - start.y) < 24 ? face : road.y;
              })() },
              { x: climbCoord, y: runCoord },
              laneJoin, waypoint, ...entry,
            ]
          : [
              start, pcsRoadToward(lastEq, start), { x: (() => {
                const road = pcsRoadToward(lastEq, start);
                const face = pcsRoadFaceCoord(lastEq, !horizApproach);
                return Math.abs(face - start.x) < 24 ? face : road.x;
              })(), y: pcsRoadToward(lastEq, start).y },
              { x: (() => {
                const road = pcsRoadToward(lastEq, start);
                const face = pcsRoadFaceCoord(lastEq, !horizApproach);
                return Math.abs(face - start.x) < 24 ? face : road.x;
              })(), y: climbCoord },
              { x: runCoord, y: climbCoord },
              laneJoin, waypoint, ...entry,
            ],
      ));
      if (clusterHits(forced) < hits || (hits > 0 && clusterHits(forced) === 0)) {
        seg.pts = forced;
        seg.lengthFt = polyLen(forced);
        refreshElectrical(c);
      }
    }
  }

  // --- 45° chamfered home-run corners outside the fence (CAR-D-B005-0) ------
  // The issued package miters the substation-corridor bends instead of
  // square corners. Cosmetic LAST pass: a corner is cut only where the
  // vertex AND both adjacent leg midpoints sit OUTSIDE the fence (climb /
  // lane / approach corners — in-yard launch geometry stays orthogonal for
  // the trench bookkeeping above), never on drafter-drawn (WYSIWYG) or
  // angled-mode routes. The cut adapts to short legs (≤40% of either leg,
  // ≤CHAMFER_FT) so compressed climb staircases keep their nesting —
  // CHAMFER_FT stays under the 10 ft lane spacing.
  {
    const CHAMFER_FT = 8;
    const fence = design.fence ?? [];
    const outsideFence = (p: Pt) => fence.length >= 3 && !pointInPoly(p, fence);
    // The miter diagonal must not clip anything the square corner was
    // legally routed AROUND: neighbouring area fences, underground
    // exclusion areas and 480V/fiber corridor keep-outs. The diagonal is
    // not axis-aligned, so feederCrossesObstacle cannot test it — clip the
    // segment against each rect parametrically (Liang-Barsky).
    const miterObs: Rect[] = [...foreignObstacles, ...exclObstacles, ...hardBands, ...gateRects,
      // A diagonal can never cross the 480V spine PERPENDICULAR, so a miter
      // must not touch a crossable band at all (unreachable for today's
      // outside-fence corners — the spine is interior — but kept structural).
      ...crossBands.map(b => b.rect)];
    const segHitsRect = (p: Pt, q: Pt, r: Rect): boolean => {
      const dx = q.x - p.x, dy = q.y - p.y;
      let t0 = 0, t1 = 1;
      const pk = [-dx, dx, -dy, dy];
      const qk = [p.x - r.x1, r.x2 - p.x, p.y - r.y1, r.y2 - p.y];
      for (let k = 0; k < 4; k++) {
        if (Math.abs(pk[k]) < 1e-12) { if (qk[k] < 0) return false; continue; }
        const t = qk[k] / pk[k];
        if (pk[k] < 0) { if (t > t0) t0 = t; } else { if (t < t1) t1 = t; }
      }
      return t0 < t1 - 1e-9;
    };
    for (let gi = 0; gi < circuits.length; gi++) {
      if (customRouted.has(gi) || angledRouted.has(gi)) continue;
      const seg = circuits[gi].segments[circuits[gi].segments.length - 1];
      if (!seg || seg.pts.length < 3) continue;
      const pts = seg.pts;
      const directLength =
        Math.abs(pts[0].x - pts[pts.length - 1].x) +
        Math.abs(pts[0].y - pts[pts.length - 1].y);
      // A far traced row may need a legitimate obstacle go-around just over
      // the detour budget. Use longer 45° cuts only on that already-excessive
      // exterior route; every miter still passes the exact fence/keep-out
      // intersection checks below.
      const adaptiveChamfer =
        isTracedYard && polyLen(pts) - directLength > 500;
      const chamferFt = adaptiveChamfer ? 14 : CHAMFER_FT;
      const routeMiterObs = adaptiveChamfer
        ? miterObs.concat(autoObs(obstaclesExcept(
            circuits[gi].inverterIds[circuits[gi].inverterIds.length - 1])))
        : miterObs;
      const out: Pt[] = [pts[0]];
      let changed = false;
      for (let i = 1; i < pts.length - 1; i++) {
        const a = pts[i - 1], v = pts[i], b = pts[i + 1];
        const ax = Math.abs(v.x - a.x) < 1e-6, ay = Math.abs(v.y - a.y) < 1e-6;
        const bx = Math.abs(b.x - v.x) < 1e-6, by = Math.abs(b.y - v.y) < 1e-6;
        const la = Math.hypot(v.x - a.x, v.y - a.y);
        const lb = Math.hypot(b.x - v.x, b.y - v.y);
        // Only true 90° axis-aligned corners; 40% cap per corner keeps two
        // chamfers on one shared leg from consuming it (0.4 + 0.4 < 1).
        const isCorner = ((ax && by) || (ay && bx)) && la > 1e-6 && lb > 1e-6;
        const d = Math.min(chamferFt, 0.4 * la, 0.4 * lb);
        if (!isCorner || d < 2 || (!adaptiveChamfer && (
            !outsideFence(v) ||
            !outsideFence({ x: (a.x + v.x) / 2, y: (a.y + v.y) / 2 }) ||
            !outsideFence({ x: (v.x + b.x) / 2, y: (v.y + b.y) / 2 })))) {
          out.push(v);
          continue;
        }
        const pA = { x: v.x + ((a.x - v.x) / la) * d, y: v.y + ((a.y - v.y) / la) * d };
        const pB = { x: v.x + ((b.x - v.x) / lb) * d, y: v.y + ((b.y - v.y) / lb) * d };
        // Keep the square corner when the cut would clip a keep-out or the
        // fence. The midpoint probe alone can miss a concave fence bite
        // narrower than half a leg, so also test the miter segment against
        // every fence edge exactly.
        const segCrossesFence = (p: Pt, q: Pt): boolean => {
          const d1x = q.x - p.x, d1y = q.y - p.y;
          for (let k = 0; k < fence.length; k++) {
            const e1 = fence[k], e2 = fence[(k + 1) % fence.length];
            const d2x = e2.x - e1.x, d2y = e2.y - e1.y;
            const den = d1x * d2y - d1y * d2x;
            if (Math.abs(den) < 1e-12) continue;
            const t = ((e1.x - p.x) * d2y - (e1.y - p.y) * d2x) / den;
            const u = ((e1.x - p.x) * d1y - (e1.y - p.y) * d1x) / den;
            if (t > -1e-9 && t < 1 + 1e-9 && u > -1e-9 && u < 1 + 1e-9) return true;
          }
          return false;
        };
        if ((!adaptiveChamfer &&
             !outsideFence({ x: (pA.x + pB.x) / 2, y: (pA.y + pB.y) / 2 })) ||
            segCrossesFence(pA, pB) ||
            routeMiterObs.some(r => segHitsRect(pA, pB, r))) {
          out.push(v);
          continue;
        }
        out.push(pA, pB);
        changed = true;
      }
      out.push(pts[pts.length - 1]);
      if (changed) {
        seg.pts = dedupePts(out);
        seg.lengthFt = polyLen(seg.pts);
        refreshElectrical(circuits[gi]);
      }
    }
  }

  // --- R-TR audit on the FINAL geometry -------------------------------------
  // Any segment still violating the trench discipline (no clear detour was
  // found, or a drafter-drawn route rides a trench) is surfaced with a stable
  // prefix so the drafter sees WHICH circuit to review. The fail-closed pass
  // below omits illegal automatic geometry while retaining its circuit record.
  if (hardBands.length || crossBands.length) {
    for (const c of circuits) {
      const nm = feederDisplayName(c);
      let hitHard = false, hitCoRun = false;
      for (const s of c.segments) {
        if (s.pts.length < 2) continue;
        const s0 = s.pts[0], s1 = s.pts[s.pts.length - 1];
        if (hardBands.length && feederCrossesObstacle(s.pts, hardBands, s0, s1)) hitHard = true;
        if (crossBands.length && bandCoRunViolations(s.pts, crossBands) > 0) hitCoRun = true;
      }
      if (hitHard) {
        opts.onWarning?.(
          `Feeder trench conflict: feeder #${nm} enters a 480V/fiber corridor or reserved future-equipment zone — no clear detour was found; review trench separation in detailed design.`);
      }
      if (hitCoRun) {
        opts.onWarning?.(
          `Feeder trench conflict: feeder #${nm} runs along the 480V/fiber trench instead of crossing it perpendicular — review trench separation in detailed design.`);
      }
    }
  }

  // Gate-entrance audit: a HOME RUN still crossing the site entrance / gate
  // apron (drawn override, or no clear detour existed) is surfaced loudly.
  // The fail-closed pass below omits illegal automatic geometry. Chain trenches between
  // units are exempt: traced yards legitimately place equipment against the
  // fence beside the gate, and those hops never leave the yard.
  if (gateRects.length) {
    for (const c of circuits) {
      const home = c.segments[c.segments.length - 1];
      if (!home || home.pts.length < 2) continue;
      const s0 = home.pts[0], s1 = home.pts[home.pts.length - 1];
      // The FULL gate geometry is audited: rects not containing the launch
      // via the standard crossing test, launch-containing (or adjacent —
      // gateObsFrom's ±1 ft expansion) rects via the egress/re-entry rule.
      // Routing had to drop those rects to lay the leg at all; the audit
      // must not, or a run launching in an apron could cross the rest of
      // it silently.
      const outside = gateObsFrom(s0);
      if (feederCrossesObstacle(home.pts, outside, s0, s1) ||
          gateRects.some(r => !outside.includes(r) && homeRunReentersRect(home.pts, r))) {
        opts.onWarning?.(
          `Feeder trench conflict: feeder #${feederDisplayName(c)} crosses the site entrance / gate apron — no clear detour was found; keep the entrance crossing clear in detailed design.`);
      }
    }
  }

  // Crossing-free comb is a hard property. The greedy reroute scoring above
  // resolves ties by pass preference; if this pass's finished home runs still
  // cross transversally, rebuild once with the opposite preference and keep
  // whichever comb crosses less. Clean layouts return pass A untouched, so
  // existing output stays byte-identical.
  const convergence = substationConvergenceWindow(design, substation, circuits.length, {
    maxPerFeeder: maxPer,
    corridorPin: opts.corridorPin,
    approach: opts.approach,
  });
  const crossInsideConvergence = (a: Pt, b: Pt, c: Pt, d2: Pt): boolean => {
    const den = (a.x - b.x) * (c.y - d2.y) - (a.y - b.y) * (c.x - d2.x);
    if (Math.abs(den) < 1e-12) return false;
    const det1 = a.x * b.y - a.y * b.x;
    const det2 = c.x * d2.y - c.y * d2.x;
    const x = (det1 * (c.x - d2.x) - (a.x - b.x) * det2) / den;
    const y = (det1 * (c.y - d2.y) - (a.y - b.y) * det2) / den;
    return x >= convergence.x1 && x <= convergence.x2 &&
      y >= convergence.y1 && y <= convergence.y2;
  };
  if (!tiePreferDirect) {
    const totalCrossings = (cs: FeederCircuit[]): number => {
      let n = 0;
      for (let i = 0; i < cs.length; i++) {
        for (let j = i + 1; j < cs.length; j++) {
          const A = cs[i].segments[cs[i].segments.length - 1]?.pts ?? [];
          const B = cs[j].segments[cs[j].segments.length - 1]?.pts ?? [];
          for (let s = 0; s < A.length - 1; s++) {
            for (let t = 0; t < B.length - 1; t++) {
              if (properCross(A[s], A[s + 1], B[t], B[t + 1]) &&
                  !crossInsideConvergence(A[s], A[s + 1], B[t], B[t + 1])) n++;
            }
          }
        }
      }
      return n;
    };
    const passA = totalCrossings(circuits);
    if (passA > 0) {
      // Buffer the retry's warnings: emit them only if the retry wins, and
      // only the ones pass A did not already report (the passes can diverge,
      // e.g. an angled splice may fit one fallback shape but not the other).
      const altWarnings: string[] = [];
      const alt = generateFeeders(design, substation, blockMW, {
        ...opts, onWarning: (m: string) => altWarnings.push(m), _tiePreferDirect: true,
      } as FeederOptions);
      if (alt.length === circuits.length && totalCrossings(alt) < passA) {
        for (const m of altWarnings) {
          if (!emittedWarnings.has(m)) opts.onWarning?.(m);
        }
        return alt;
      }
    }
  }

  // --- Fail-closed final route acceptance -----------------------------------
  // Candidate generation may exhaust every detour on an irregular parcel.
  // Never export that illegal polyline as if it were approved: retain the
  // circuit/load/sizing record for schedules, but collapse its drawable
  // geometry to terminal points and attach an actionable diagnostic. Forced
  // drafter routes remain explicit engineer-owned exceptions; malformed or
  // incomplete forced geometry is still rejected.
  {
    const rejected: Set<string>[] = Array.from({ length: circuits.length }, () => new Set<string>());
    const finiteLine = (pts: Pt[]): boolean =>
      pts.length >= 2 && pts.every(p => Number.isFinite(p.x) && Number.isFinite(p.y));
    for (let gi = 0; gi < circuits.length; gi++) {
      const c = circuits[gi];
      const p = pre[gi];
      const forced = customMeta.get(gi)?.forced === true;
      const finalAutoHome = c.segments[c.segments.length - 1];
      if (!forced && finalAutoHome?.pts.length >= 2 &&
          finalAutoHome.pts.some(pt =>
            horizApproach
              ? (pt.x - substation.x) * dirX > 1e-9
              : (pt.y - substation.y) * dirY > 1e-9)) {
        finalAutoHome.pts = stripBacktracks(dedupePts(finalAutoHome.pts.map(pt =>
          horizApproach
            ? {
                x: (pt.x - substation.x) * dirX > 0 ? substation.x : pt.x,
                y: pt.y,
              }
            : {
                x: pt.x,
                y: (pt.y - substation.y) * dirY > 0 ? substation.y : pt.y,
              })));
        finalAutoHome.lengthFt = polyLen(finalAutoHome.pts);
      }
      if (!forced && finalAutoHome?.pts.length >= 4) {
        const start = finalAutoHome.pts[0];
        const end = finalAutoHome.pts[finalAutoHome.pts.length - 1];
        const obs = autoObs(obstaclesExcept(p.launch.id))
          .concat(gateObsFrom(start), clusterRects);
        const crossingCount = (pts: Pt[]): number => {
          let n = 0;
          for (let oi = 0; oi < circuits.length; oi++) {
            if (oi === gi) continue;
            const other = circuits[oi].segments[circuits[oi].segments.length - 1]?.pts ?? [];
            for (let i = 0; i + 1 < pts.length; i++)
              for (let j = 0; j + 1 < other.length; j++)
                if (properCross(pts[i], pts[i + 1], other[j], other[j + 1])) n++;
          }
          return n;
        };
        const currentCrossings = crossingCount(finalAutoHome.pts);
        const currentBand = bandCoRunViolations(finalAutoHome.pts, crossBands);
        const fixed = stripOrthogonalLoops(finalAutoHome.pts, cand =>
          cand.length >= 2 &&
          !customRouteCrossesObstacle(cand, obs, start, end) &&
          bandCoRunViolations(cand, crossBands) <= currentBand &&
          crossingCount(cand) <= currentCrossings);
        if (polyLen(fixed) < finalAutoHome.lengthFt - 1e-6) {
          finalAutoHome.pts = fixed;
          finalAutoHome.lengthFt = polyLen(fixed);
        }
      }
      const expectedSegments = c.inverterIds.length;
      if (p.assignmentRowInvalid) {
        rejected[gi].add(
          'manual feeder assignment must contain one contiguous physical PCS row');
      }
      if (c.segments.length !== expectedSegments) {
        rejected[gi].add(`expected ${expectedSegments} route sections, found ${c.segments.length}`);
      }
      for (let si = 0; si < c.segments.length; si++) {
        const seg = c.segments[si];
        if (!finiteLine(seg.pts)) {
          rejected[gi].add(`section ${si + 1} has no complete finite polyline`);
          continue;
        }
        if (si < c.segments.length - 1) {
          const a = p.chain[si], b = p.chain[si + 1];
          if (p.rowGrammar && seg.pts.length !== 2) {
            rejected[gi].add(
              `row trunk section ${si + 1} is not one straight span (${seg.pts.length - 1} legs)`);
          }
          const obs = autoObs(obstaclesExcept(a?.id, b?.id));
          const equipmentConflict =
            feederCrossesObstacle(seg.pts, obs, seg.pts[0], seg.pts[seg.pts.length - 1]);
          const trenchConflicts = bandCoRunViolations(seg.pts, crossBands);
          if (equipmentConflict || trenchConflicts > 0) {
            rejected[gi].add(`row trunk section ${si + 1} conflicts with ` +
              `${equipmentConflict ? 'equipment' : 'a reserved trench'}`);
          }
        }
      }
      const home = c.segments[c.segments.length - 1];
      if (!home || !finiteLine(home.pts)) {
        rejected[gi].add('home run is incomplete');
      } else {
        const end = home.pts[home.pts.length - 1];
        if (dist(end, substation) > 0.1) rejected[gi].add('home run does not terminate at the substation');
        const overshootsApproach = home.pts.some(pt =>
          horizApproach
            ? (pt.x - substation.x) * dirX > 0.1
            : (pt.y - substation.y) * dirY > 0.1);
        if (overshootsApproach) {
          rejected[gi].add('home run overshoots the substation approach');
        }
        if (!forced) {
          const start = home.pts[0];
          const obs = autoObs(obstaclesExcept(p.launch.id)).concat(
            gateObsFrom(start), clusterRects);
          if (customRouteCrossesObstacle(home.pts, obs, start, substation)) {
            rejected[gi].add('home run conflicts with equipment, a reserve, or the site entrance');
          }
          if (clusterRects.length &&
              feederCrossesObstacle(home.pts, clusterRects, start, substation)) {
            rejected[gi].add('home run cuts through a container courtyard');
          }
          if (bandCoRunViolations(home.pts, crossBands) > 0) {
            rejected[gi].add('home run rides a crossing-only 480V/fiber trench');
          }
        }
      }
    }
    // No two feeders may cross — hops or home runs — except inside the
    // substation convergence window. Collinear shared approach legs are
    // not crossings (the corridor bundle). The retry above already chose
    // the better pass; a surviving transversal crossing fail-closes the
    // later circuit rather than emitting both illegal lines.
    const segsOf = (c: FeederCircuit): Pt[][] =>
      c.segments.map(s => s.pts).filter(pts => finiteLine(pts));
    for (let i = 0; i < circuits.length; i++) {
      const A = segsOf(circuits[i]);
      if (!A.length) continue;
      for (let j = i + 1; j < circuits.length; j++) {
        const B = segsOf(circuits[j]);
        if (!B.length) continue;
        let crossed = false;
        for (const a of A) {
          for (const b of B) {
            for (let s = 0; s < a.length - 1 && !crossed; s++) {
              for (let t = 0; t < b.length - 1 && !crossed; t++) {
                if (properCross(a[s], a[s + 1], b[t], b[t + 1]) &&
                    !crossInsideConvergence(a[s], a[s + 1], b[t], b[t + 1])) {
                  crossed = true;
                }
              }
            }
          }
        }
        if (crossed) {
          rejected[j].add(
            `route crosses feeder #${feederDisplayName(circuits[i])}`);
        }
      }
    }
    rejected.forEach((reasons, gi) => {
      const c = circuits[gi];
      const diagnostics = Array.from(reasons);
      c.routeValid = diagnostics.length === 0;
      c.routeDiagnostics = diagnostics;
      if (!diagnostics.length) return;
      // Only collapse undrawable / incomplete geometry. Courtyard, crossing,
      // and keep-out findings stay as diagnostics so the trench remains
      // visible — hiding the line was reading as "no feeders in the yard."
      const fatal = diagnostics.some(d =>
        d.includes('incomplete') ||
        d.includes('does not terminate') ||
        d.includes('no complete finite') ||
        d.includes('expected '));
      if (fatal) {
        for (const seg of c.segments) {
          const terminal = seg.pts.find(p => Number.isFinite(p.x) && Number.isFinite(p.y));
          seg.pts = terminal ? [terminal] : [];
          seg.lengthFt = 0;
        }
        refreshElectrical(c);
        opts.onWarning?.(
          `Feeder route omitted: feeder #${feederDisplayName(c)} failed closed — ` +
          `${diagnostics.join('; ')}. Its electrical circuit remains in the schedule for review.`);
      } else {
        opts.onWarning?.(
          `Feeder route review: feeder #${feederDisplayName(c)} — ${diagnostics.join('; ')}.`);
      }
    });
  }

  // This is the authoritative route/electrical synchronization point. Every
  // geometry mutation (separation, shortcutting, overshoot projection,
  // chamfering and fail-closed collapse) has completed, so derive segment
  // lengths and all length-dependent circuit metadata from the polylines that
  // are actually returned. A collapsed zero-geometry route therefore reports
  // zero routed length and zero voltage drop rather than stale pre-audit data.
  for (const c of circuits) {
    for (const seg of c.segments) {
      seg.lengthFt = seg.pts.length >= 2 ? polyLen(seg.pts) : 0;
    }
    refreshElectrical(c);
  }

  return circuits;
}

// Drop interior vertices whose incoming and outgoing directions are the same
// (~0° turn): the polyline geometry and length are unchanged, only the
// spurious joint is removed. Exported for tests.
export function mergeCollinear(pts: Pt[]): Pt[] {
  if (pts.length < 3) return pts;
  const out = pts.slice();
  for (let i = 1; i < out.length - 1; ) {
    const a = out[i - 1], v = out[i], b = out[i + 1];
    const l1 = Math.hypot(v.x - a.x, v.y - a.y);
    const l2 = Math.hypot(b.x - v.x, b.y - v.y);
    if (l1 > 1e-9 && l2 > 1e-9) {
      const dot = ((v.x - a.x) * (b.x - v.x) + (v.y - a.y) * (b.y - v.y)) / (l1 * l2);
      if (dot > 0.9999) { out.splice(i, 1); continue; }
    }
    i++;
  }
  return out;
}

// --- Task 902: orthogonal self-loop / 90° hairpin loop-back removal --------
// Late geometry passes (grid reroute + per-leg re-lay + parallel offset) can
// leave an AUTOMATIC orthogonal home run with a redundant excursion:
//   (a) a self-loop — a later vertex returns to (essentially) an earlier
//       vertex, so the whole intervening detour is dead trench that reads as
//       a loop on the drawing; or
//   (b) a 90° hairpin loop-back — the path steps off a leg, runs a short
//       cross leg, then turns straight back onto a line coincident with (or
//       within `lat` ft of) the leg it left, so a straight shortcut across
//       the mouth of the U is exactly equivalent trench without the doubled
//       run; or
//   (c) a TRUE self-intersection — two non-adjacent orthogonal legs (one
//       horizontal, one vertical) geometrically cross, so the polyline draws
//       a real crossed loop. Splicing both legs at the intersection point
//       erases the whole cycle between them.
// This is PURE geometry: it proposes each shortcut and hands it to the
// caller's `accept` predicate (equipment / fence / bounds / trench-band /
// cross-feeder validation). Each shortcut is offered in every equivalent
// straightening variant (e.g. a hairpin can collapse onto either leg's line),
// so a valid shortcut is not lost just because one variant hits a trench
// band. A rejected shortcut leaves the vertices intact, so a loop the router
// genuinely needed (to go around an obstacle) is kept. The polyline is only
// ever shortened; endpoints are never moved.
export function stripOrthogonalLoops(
  pts: Pt[],
  accept: (candidate: Pt[]) => boolean,
  lat = 1.5,
): Pt[] {
  if (pts.length < 4) return dedupePts(pts);
  const near = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y) <= lat;
  const isAxis = (a: Pt, b: Pt) =>
    Math.abs(a.x - b.x) < 1e-6 || Math.abs(a.y - b.y) < 1e-6;
  const allAxis = (arr: Pt[]) => {
    for (let i = 0; i < arr.length - 1; i++) if (!isAxis(arr[i], arr[i + 1])) return false;
    return true;
  };
  // Only operate on a strictly orthogonal polyline — an angled/diagonal leg
  // means this is not an automatic orthogonal home run and must be left alone.
  if (!allAxis(pts)) return dedupePts(pts);

  // Try each candidate variant in turn; accept the first the caller approves.
  const tryCands = (cands: Pt[][]): Pt[] | null => {
    for (const cand of cands) {
      const dd = dedupePts(cand);
      if (dd.length < 2 || !allAxis(dd)) continue;
      if (accept(dd)) return dd;
    }
    return null;
  };

  let work = dedupePts(pts);
  let changed = true;
  let guard = 0;
  while (changed && guard++ < pts.length * 3) {
    changed = false;

    // (a) Self-loop: vertex j returns near vertex i (i + 1 < j). Splice out
    // i+1..j, rejoining i directly to j+1 (or to the loop-close vertex when j
    // is the last vertex). The rejoin must stay axis-aligned.
    for (let i = 0; i < work.length - 2 && !changed; i++) {
      for (let j = i + 2; j < work.length; j++) {
        if (!near(work[i], work[j])) continue;
        // Collapse the loop onto vertex i: drop i+1..j.
        const cand = tryCands([[...work.slice(0, i + 1), ...work.slice(j + 1)]]);
        if (cand) { work = cand; changed = true; }
        break;
      }
    }
    if (changed) continue;

    // (b) 90° hairpin loop-back: vertices a,b,c,d where a→b and c→d are
    // parallel legs on lines within `lat` ft of each other and pointing the
    // SAME way (a U turned back on itself), joined by the short cross leg
    // b→c. Replace b,c with a single straight shortcut so the doubled run
    // collapses to the through-line. Offer straightening onto EITHER leg's
    // line (a→b's or c→d's) — a band/obstacle can veto one but not the other.
    for (let i = 0; i + 3 < work.length && !changed; i++) {
      const a = work[i], b = work[i + 1], c = work[i + 2], d = work[i + 3];
      const abHoriz = Math.abs(a.y - b.y) < 1e-6 && Math.abs(a.x - b.x) > 1e-6;
      const abVert = Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) > 1e-6;
      const cdHoriz = Math.abs(c.y - d.y) < 1e-6 && Math.abs(c.x - d.x) > 1e-6;
      const cdVert = Math.abs(c.x - d.x) < 1e-6 && Math.abs(c.y - d.y) > 1e-6;
      const variants: Pt[][] = [];
      if (abHoriz && cdHoriz && Math.abs(a.y - c.y) <= lat) {
        const dir1 = Math.sign(b.x - a.x), dir2 = Math.sign(d.x - c.x);
        if (dir1 !== 0 && dir1 === -dir2) {
          // Straighten onto a's line, then onto d's line.
          variants.push([a, { x: d.x, y: a.y }, d]);
          variants.push([a, { x: a.x, y: d.y }, d]);
        }
      } else if (abVert && cdVert && Math.abs(a.x - c.x) <= lat) {
        const dir1 = Math.sign(b.y - a.y), dir2 = Math.sign(d.y - c.y);
        if (dir1 !== 0 && dir1 === -dir2) {
          variants.push([a, { x: a.x, y: d.y }, d]);
          variants.push([a, { x: d.x, y: a.y }, d]);
        }
      }
      if (!variants.length) continue;
      const cand = tryCands(variants.map(v => [...work.slice(0, i), ...v, ...work.slice(i + 4)]));
      if (cand) { work = cand; changed = true; }
    }
    if (changed) continue;

    // (c) True self-intersection: a horizontal leg s and a vertical leg t
    // (non-adjacent, s + 1 < t) whose lines cross at an interior point X.
    // The polyline draws a real crossed loop; everything strictly between the
    // two legs (vertices s+1..t) plus the parts of legs s and t past X is the
    // cycle. Rejoin the leg-s vertex to X to the leg-t vertex, erasing it.
    for (let s = 0; s + 2 < work.length && !changed; s++) {
      const p0 = work[s], p1 = work[s + 1];
      const sHoriz = Math.abs(p0.y - p1.y) < 1e-6 && Math.abs(p0.x - p1.x) > 1e-6;
      const sVert = Math.abs(p0.x - p1.x) < 1e-6 && Math.abs(p0.y - p1.y) > 1e-6;
      if (!sHoriz && !sVert) continue;
      for (let t = s + 2; t + 1 < work.length && !changed; t++) {
        const q0 = work[t], q1 = work[t + 1];
        const tHoriz = Math.abs(q0.y - q1.y) < 1e-6 && Math.abs(q0.x - q1.x) > 1e-6;
        const tVert = Math.abs(q0.x - q1.x) < 1e-6 && Math.abs(q0.y - q1.y) > 1e-6;
        // Must be perpendicular (one horizontal, one vertical) to cross.
        if ((sHoriz && !tVert) || (sVert && !tHoriz)) continue;
        // Intersection of the two axis lines.
        const X: Pt = sHoriz ? { x: q0.x, y: p0.y } : { x: p0.x, y: q0.y };
        const between = (v: number, lo: number, hi: number) =>
          v > Math.min(lo, hi) + 1e-6 && v < Math.max(lo, hi) - 1e-6;
        // X strictly interior to BOTH legs => a genuine crossing (not a
        // shared endpoint / touch at a corner).
        const onS = sHoriz ? between(X.x, p0.x, p1.x) : between(X.y, p0.y, p1.y);
        const onT = tHoriz ? between(X.x, q0.x, q1.x) : between(X.y, q0.y, q1.y);
        if (!onS || !onT) continue;
        // Splice: keep p0..(cut leg s at X), jump to X, then (cut leg t at X)
        // to q1.. — the cycle vertices work[s+1..t] and the crossed leg tails
        // vanish.
        const cand = tryCands([[...work.slice(0, s + 1), X, ...work.slice(t + 1)]]);
        if (cand) { work = cand; changed = true; }
      }
    }
  }
  return mergeCollinear(dedupePts(work));
}

// Total feeder cable LF grouped by conductor size (for BOM rows)
export function summarizeFeederLengths(feeders: FeederCircuit[]): { size: ConductorSize; material: ConductorMaterial; totalFt: number; circuits: number }[] {
  const map = new Map<string, { size: ConductorSize; material: ConductorMaterial; totalFt: number; circuits: number }>();
  for (const f of feeders) {
    const key = `${f.size}-${f.material}`;
    const cur = map.get(key) || { size: f.size, material: f.material, totalFt: 0, circuits: 0 };
    cur.totalFt += f.totalLengthFt;
    cur.circuits += 1;
    map.set(key, cur);
  }
  return Array.from(map.values()).sort((a, b) => Number(a.size) - Number(b.size));
}

// ---------------------------------------------------------------------------
// Substation aux feeder circuit (34.5 kV, reference CAR-D-B005-0): ONE brown
// dashed circuit leaving the substation and daisy-chaining EVERY aux
// transformer in the yard (yard-level aux-xfmr and each island's
// island-aux-xfmr-<n>) in nearest-neighbor order. Each leg is routed
// orthogonally with the same fence/equipment obstacle avoidance the MV
// feeders use, in its own trench. The 480V distribution past each
// transformer stays local (existing LVAC runs). Circuit number = BESS feeder
// count + 1 (the reference names it "#15C1" after 14 BESS feeders).
// Extract the sub-path of a polyline from parameter fromT on segment fromSeg
// to parameter toT on segment toSeg (both parameters in [0,1]). Returns the
// slice including the start and end interpolated points plus the intermediate
// vertices. Consecutive near-duplicate points (<0.01 ft) are collapsed.
function extractSubPath(path: Pt[], fromSeg: number, fromT: number, toSeg: number, toT: number): Pt[] {
  if (fromSeg >= path.length - 1 || toSeg >= path.length - 1) return [];
  const dedup = (pts: Pt[], p: Pt) => {
    if (!pts.length || Math.hypot(p.x - pts[pts.length - 1].x, p.y - pts[pts.length - 1].y) > 0.01)
      pts.push(p);
    return pts;
  };
  const pts: Pt[] = [];
  // Start: interpolated point at fromT on segment fromSeg
  { const a = path[fromSeg], b = path[fromSeg + 1];
    dedup(pts, fromT < 1e-9 ? { ...a } : { x: a.x + fromT * (b.x - a.x), y: a.y + fromT * (b.y - a.y) }); }
  // Interior vertices: path[fromSeg+1] through path[toSeg]
  for (let i = fromSeg + 1; i <= toSeg; i++) dedup(pts, { ...path[i] });
  // End: interpolated point at toT on segment toSeg
  if (toT > 1e-9) {
    const a = path[toSeg], b = path[toSeg + 1];
    dedup(pts, { x: a.x + toT * (b.x - a.x), y: a.y + toT * (b.y - a.y) });
  }
  return pts;
}

// Half-width of the substation entry line (see below). Wide enough that the
// 3 ft routing grid can still reach the terminal through it.
const ENTRY_LINE_HALF_FT = FEEDER_TRENCH_SPACING_FT / 2 + 1;

/**
 * The one place circuits legitimately converge: the substation ENTRY LINE.
 * Every lane ride ends on the line through the substation perpendicular to
 * the corridor, and each circuit then runs down that shared line to the
 * terminal — so on that line, and only there, trenches meet by design.
 *
 * Deliberately a thin strip, not a deep approach box: a box that reaches
 * back to the approach waypoints lets a router drop straight across the
 * whole lane bundle just inside the exempt edge, which is a real 90 degree
 * crossing on the drawing that the exemption would hide. Outside this strip
 * the aux circuit must cross NOTHING — that is the contract the router
 * enforces and the tests assert.
 */
export function substationConvergenceWindow(
  design: SiteDesign,
  substation: Pt,
  mvFeederCount: number,
  opts?: { maxPerFeeder?: number; corridorPin?: number | null; approach?: TakeoffDirection | null }
): Rect {
  const w = ENTRY_LINE_HALF_FT;
  const frame = feederCorridorFrame(design, substation, opts?.corridorPin, opts?.maxPerFeeder, opts?.approach);
  if (!frame) {
    return {
      x1: substation.x - w, y1: substation.y - w,
      x2: substation.x + w, y2: substation.y + w,
    };
  }
  // Across the corridor the strip spans the whole lane bundle — the MV
  // lanes plus the aux lane — since every one of them lands on this line.
  const perpHalf = (Math.max(0, mvFeederCount) / 2) * FEEDER_TRENCH_SPACING_FT
    + 2 * FEEDER_TRENCH_SPACING_FT;
  return frame.horizApproach
    ? {
        x1: substation.x - w, x2: substation.x + w,
        y1: frame.laneCenter - perpHalf, y2: frame.laneCenter + perpHalf,
      }
    : {
        x1: frame.laneCenter - perpHalf, x2: frame.laneCenter + perpHalf,
        y1: substation.y - w, y2: substation.y + w,
      };
}

/**
 * The station-service (aux) circuit. It is simply ONE MORE 34.5 kV circuit
 * leaving the substation, so it is routed like one: it gets its own lane in
 * the corridor bundle — parallel to the MV lanes, one trench spacing beyond
 * the outermost one, with its own approach jog — and it treats the already
 * routed MV home runs as keep-outs so it never cuts across them.
 *
 * `bessFeeders` are the ROUTED MV circuits (not just their count): their
 * polylines are what the aux trench has to stay clear of.
 */
export function generateAuxFeeder(
  design: SiteDesign,
  substation: Pt,
  bessFeeders: FeederCircuit[],
  onWarning?: (msg: string) => void,
  exclusionZones?: import('./areaZones').AreaZone[] | null,
  waypoints?: Pt[] | null,
  // `approach`/`foreignFences` are the multi-area take-off inputs (see
  // FeederOptions). Absent => byte-identical single-area behaviour. The aux
  // circuit MUST be given the same values as the MV bundle it rides beside,
  // or its lane is derived in a different frame and cuts across the home runs.
  opts?: {
    maxPerFeeder?: number;
    corridorPin?: number | null;
    approach?: TakeoffDirection | null;
    foreignFences?: Pt[][] | null;
  }
): AuxFeederCircuit | null {
  if (!Number.isFinite(substation.x) || !Number.isFinite(substation.y)) return null;
  const stops = design.equipment.filter(e => e.kind === 'auxTransformer');
  if (!stops.length) return null;
  const mvFeeders = bessFeeders ?? [];

  const rectById = new Map(design.equipment.map(e => [e.id, equipmentRect(e, 2)]));
  // Underground exclusion areas are hard keep-outs for the buried aux chain,
  // exactly like the BESS feeder routing above (never "except"-able).
  const auxExclObstacles: Rect[] = exclusionRects(exclusionZones).map(r =>
    ({ x1: r.x1, y1: r.y1, x2: r.x2, y2: r.y2 }));
  // Neighbouring site-area fences (multi-area only) are keep-outs for the aux
  // chain too — it must not cut through another yard on its way out.
  const auxForeignObstacles: Rect[] = foreignFenceRects(opts?.foreignFences);
  const obstaclesExcept = (...ids: (string | undefined)[]) => {
    const skip = new Set(ids.filter(Boolean));
    return [
      ...design.equipment.filter(e => !skip.has(e.id)).map(e => rectById.get(e.id)!),
      ...auxExclObstacles,
      ...auxForeignObstacles,
    ];
  };
  const bounds = routingBounds(design, substation,
    auxForeignObstacles.flatMap(r => [{ x: r.x1, y: r.y1 }, { x: r.x2, y: r.y2 }]));

  // --- MV feeder trenches are keep-outs for the aux circuit ---------------
  // The aux run must never cross a home run. Near the substation every
  // circuit legitimately converges on the same terminal, so that window is
  // exempt from both the crossing test and the keep-out geometry (otherwise
  // the aux route could not reach the terminal at all).
  const mvRuns: Pt[][] = mvFeeders.flatMap(f =>
    (f?.segments ?? []).map(s => s.pts).filter(p => Array.isArray(p) && p.length > 1));
  const frame = feederCorridorFrame(design, substation, opts?.corridorPin, opts?.maxPerFeeder, opts?.approach);
  const convergence = substationConvergenceWindow(design, substation, mvFeeders.length, opts);
  // Half a trench spacing each side: wide enough that the 3 ft routing grid
  // cannot step over a keep-out, and it holds the aux trench a full spacing
  // clear of the MV trench it is dodging.
  const mvKeepOut = trenchKeepOutRects(mvRuns, FEEDER_TRENCH_SPACING_FT / 2, convergence);
  const mvCrossings = (pts: Pt[]): number =>
    mvRuns.reduce((n, run) => n + polylineCrossings(pts, run, convergence).length, 0);

  // The aux circuit's own lane: parallel to the MV bundle, one trench
  // spacing beyond the outermost MV lane (the same centred spread formula
  // generateFeeders deals its lanes from, evaluated at rank = feeder count).
  const auxLane = frame
    ? frame.laneCenter + (frame.horizApproach
        ? ((mvFeeders.length - 1) / 2 - mvFeeders.length) * FEEDER_TRENCH_SPACING_FT
        : (mvFeeders.length - (mvFeeders.length - 1) / 2) * FEEDER_TRENCH_SPACING_FT)
    : null;

  // Corridor departure from the substation: entry jog off the terminal onto
  // the aux lane, approach waypoint, then the lane ride out past the fence.
  // Returns the lane-ride prefix and the full ideal route to `stopPt`.
  const corridorDeparture = (stopPt: Pt): { prefix: Pt[]; ideal: Pt[] } | null => {
    if (!frame || auxLane == null) return null;
    const { horizApproach, dirX, dirY } = frame;
    const dir = horizApproach ? dirX : dirY;
    const perpLo = horizApproach ? bounds[0].y : bounds[0].x;
    const perpHi = horizApproach ? bounds[2].y : bounds[2].x;
    const lane = Math.min(perpHi, Math.max(perpLo, auxLane));
    const waypointCoord = horizApproach
      ? substation.x - dirX * SUBSTATION_APPROACH_FT
      : substation.y - dirY * SUBSTATION_APPROACH_FT;
    // Aux turns onto its lane BEYOND every MV climb line. MV feeders climb
    // between climbBase (just outside the fence) and one trench spacing
    // short of the approach waypoint; a climb leg spans from its feeder's
    // run line all the way to its lane, so it sweeps right across where the
    // aux lane sits. Climbing past all of them keeps the aux lane ride in
    // the clear strip between the last MV climb and the substation.
    const climbCoord = waypointCoord + dir * FEEDER_TRENCH_SPACING_FT / 2;
    const mk = (along: number, perp: number): Pt =>
      horizApproach ? { x: along, y: perp } : { x: perp, y: along };
    const subAlong = horizApproach ? substation.x : substation.y;
    const prefix = dedupePts([
      { x: substation.x, y: substation.y },
      mk(subAlong, lane),
      mk(climbCoord, lane),
    ]);
    if (prefix.length < 2) return null;
    const runCoord = horizApproach ? stopPt.y : stopPt.x;
    return {
      prefix,
      ideal: dedupePts([...prefix, mk(climbCoord, runCoord), { x: stopPt.x, y: stopPt.y }]),
    };
  };

  // Nearest-neighbor visit order starting at the substation (deterministic
  // id tiebreak) — the reference chain simply walks down the yard spine.
  const remaining = [...stops].sort((a, b) => a.id.localeCompare(b.id));
  const order: PlacedEquipment[] = [];
  let cur: Pt = substation;
  while (remaining.length) {
    let bi = 0;
    let bd = Infinity;
    remaining.forEach((m, j) => {
      const d = Math.hypot(m.x - cur.x, m.y - cur.y);
      if (d < bd - 1e-9 || (Math.abs(d - bd) < 1e-9 && m.id < remaining[bi].id)) { bd = d; bi = j; }
    });
    const next = remaining.splice(bi, 1)[0];
    order.push(next);
    cur = next;
  }

  // When drafter-supplied waypoints are present, build legs from the drawn
  // path instead of auto-routing each leg. The full drawn path is:
  //   [substation, ...waypoints, lastStop]
  // For a single-stop chain, the path is the one leg.
  // For multi-stop chains, each intermediate stop is projected (monotone
  // nearest-point) onto the full path and the path is split there so each
  // leg runs from the previous stop's projection to the next, ending at
  // the actual stop position.
  if (waypoints != null) {
    const validPts = waypoints.filter(p => Number.isFinite(p.x) && Number.isFinite(p.y));
    if (validPts.length < 1) {
      onWarning?.('Aux feeder custom route rejected: waypoints list is empty or all non-finite — automatic route kept.');
    } else {
      const lastStop = order[order.length - 1];
      const fullPath: Pt[] = [
        { x: substation.x, y: substation.y },
        ...validPts,
        { x: lastStop.x, y: lastStop.y },
      ];
      let customLegs: { pts: Pt[]; lengthFt: number }[];
      if (order.length === 1) {
        const pts = mergeCollinear(fullPath);
        customLegs = [{ pts, lengthFt: polyLen(pts) }];
      } else {
        // Splice-into-path: for each intermediate stop, find its nearest
        // projection on the drawn path (monotone forward) and INSERT the
        // actual stop position at that location. After all splices the path
        // literally passes through every transformer, so legs are always
        // head-to-tail continuous with no gap between leg[i].end and
        // leg[i+1].start.
        const splicedPath: Pt[] = fullPath.map(p => ({ ...p }));
        const stopPathIndices: number[] = [0]; // index of each stop in splicedPath
        let searchFrom = 1; // start past the substation
        for (let si = 0; si < order.length - 1; si++) {
          const stop = order[si];
          let bestSeg = searchFrom - 1, bestDist = Infinity, bestPct = 0;
          for (let i2 = searchFrom - 1; i2 < splicedPath.length - 1; i2++) {
            const a2 = splicedPath[i2], b2 = splicedPath[i2 + 1];
            const ddx = b2.x - a2.x, ddy = b2.y - a2.y;
            const len2 = ddx * ddx + ddy * ddy;
            const t = len2 < 1e-12 ? 0 : Math.max(0, Math.min(1,
              ((stop.x - a2.x) * ddx + (stop.y - a2.y) * ddy) / len2
            ));
            const px = a2.x + t * ddx, py = a2.y + t * ddy;
            const d = Math.hypot(stop.x - px, stop.y - py);
            if (d < bestDist) { bestDist = d; bestSeg = i2; bestPct = t; }
          }
          // Insert actual stop position at bestSeg+1 (splitting the segment).
          const insertIdx = bestSeg + 1;
          splicedPath.splice(insertIdx, 0, { x: stop.x, y: stop.y });
          stopPathIndices.push(insertIdx);
          searchFrom = insertIdx + 1;
        }
        stopPathIndices.push(splicedPath.length - 1);

        // Build one leg per stop: splicedPath[stopPathIndices[si]..stopPathIndices[si+1]]
        customLegs = [];
        for (let si = 0; si < order.length; si++) {
          const from = stopPathIndices[si];
          const to = stopPathIndices[si + 1];
          const subPath = splicedPath.slice(from, to + 1);
          const clean = mergeCollinear(subPath);
          const pts = clean.length >= 2 ? clean : (subPath.length >= 2 ? subPath : [splicedPath[from], splicedPath[to]]);
          customLegs.push({ pts, lengthFt: polyLen(pts) });
        }
      }
      // A drawn aux route is WYSIWYG, so it is accepted whole or rejected
      // loudly: the aux trench may not cross an MV home run, and a drafter
      // route gets exactly the same rule as an automatic one.
      //
      // Checked on the FINAL legs, never the raw drawn path. Splicing an
      // intermediate stop into the path introduces geometry the drafter
      // never drew — the detour out to that transformer and back — and that
      // detour can cross a home run even when the drawn path itself did not.
      const drawnHits = customLegs.reduce((n, l) => n + mvCrossings(l.pts), 0);
      if (drawnHits > 0) {
        onWarning?.(
          `Aux feeder custom route rejected: the drawn path crosses the MV feeder home run${drawnHits === 1 ? '' : 's'} in ${drawnHits} place${drawnHits === 1 ? '' : 's'} — automatic route kept.`
        );
      } else {
        const circuitNo = mvFeeders.length + 1;
        const auxName = auxFeederNameOf(mvFeeders);
        return {
          circuitNo,
          name: auxName,
          label: `AUX FEEDER #${auxName} (34.5 kV)`,
          stopIds: order.map(o => o.id),
          legs: customLegs,
          totalLengthFt: customLegs.reduce((s, l) => s + l.lengthFt, 0),
        };
      }
    }
    // Invalid or rejected waypoints: fall through to automatic routing.
  }

  const legs = order.map((stop, i) => {
    const prev = i === 0 ? null : order[i - 1];
    const a: Pt = prev ? { x: prev.x, y: prev.y } : substation;
    const b: Pt = { x: stop.x, y: stop.y };
    const obs = obstaclesExcept(prev?.id, stop.id);
    const obsMv = [...obs, ...mvKeepOut];

    // Candidate routes, most preferred first:
    //  1. the dedicated aux lane out of the substation, then straight in;
    //  2. the same lane departure, with the in-yard portion grid-routed
    //     around equipment AND the MV trenches;
    //  3. a plain route that still treats the MV trenches as keep-outs;
    //  4. the legacy equipment-only route (never dropped — last resort).
    const cands: Pt[][] = [];
    if (i === 0) {
      const dep = corridorDeparture(b);
      if (dep) {
        cands.push(mergeCollinear(dep.ideal));
        const handoff = dep.prefix[dep.prefix.length - 1];
        const inYard = routeSegment(handoff, b, obsMv, bounds);
        cands.push(mergeCollinear(stripBacktracks(dedupePts([...dep.prefix, ...inYard]))));
        for (const stage of [
          { x: b.x + 40, y: b.y },
          { x: b.x - 40, y: b.y },
          { x: b.x, y: b.y + 40 },
          { x: b.x, y: b.y - 40 },
        ]) {
          cands.push(mergeCollinear(dedupePts([
            ...dep.prefix, ...lRoute(handoff, stage), b,
          ])));
        }
      }
    }
    cands.push(mergeCollinear(routeSegment(a, b, obsMv, bounds)));
    // A transformer center can be surrounded by its island equipment closely
    // enough that a center-to-center grid search has no valid terminal cell.
    // Approach from a clear cardinal staging point, then land on the owning
    // transformer; the final segment is still ranked against every foreign
    // equipment body and MV trench below.
    const TERMINAL_APPROACH_FT = 40;
    for (const stage of [
      { x: b.x + TERMINAL_APPROACH_FT, y: b.y },
      { x: b.x - TERMINAL_APPROACH_FT, y: b.y },
      { x: b.x, y: b.y + TERMINAL_APPROACH_FT },
      { x: b.x, y: b.y - TERMINAL_APPROACH_FT },
    ]) {
      const approach = routeSegment(a, stage, obsMv, bounds);
      cands.push(mergeCollinear(dedupePts([...approach, b])));
    }
    cands.push(mergeCollinear(routeSegment(a, b, obs, bounds)));

    // Rank on clearance only — and keep the EARLIER candidate on a tie.
    // Preference order is the whole point: a shorter route that runs down
    // the middle of the MV lane bundle crosses nothing yet still shares the
    // corridor, which is exactly what the dedicated aux lane exists to
    // avoid.
    //
    // A NEIGHBOURING YARD outranks everything else. Multi-area sites put
    // another fenced footprint between this yard and the substation, and the
    // aux trench has no more right to cut through it than an MV home run
    // does — that land belongs to a different area. Sharing the MV corridor
    // is a drafting nuisance; trenching through the neighbour is not
    // buildable, so foreign-fence crossings are the FIRST criterion. The
    // straight lane-ride candidate ignores obstacles by construction, so
    // without this it always won and drove the aux straight through.
    const foreignHits = (c: Pt[]): number =>
      auxForeignObstacles.length === 0 ? 0
        : (feederCrossesObstacle(c, auxForeignObstacles, a, b) ? 1 : 0);
    let pts = cands[cands.length - 1];
    let bestForeign = Infinity, bestMv = Infinity, bestObs = Infinity;
    for (const c of cands) {
      if (c.length < 2) continue;
      const foreign = foreignHits(c);
      const mv = mvCrossings(c);
      const hit = feederCrossesObstacle(c, obs, a, b) ? 1 : 0;
      // Equipment transit is an export-blocking routing-gate error, whereas
      // an unavoidable MV crossing is retained with an explicit engineering
      // warning. Prefer a body-clear terminal approach before minimizing the
      // remaining MV crossings.
      if (foreign < bestForeign ||
          (foreign === bestForeign && hit < bestObs) ||
          (foreign === bestForeign && hit === bestObs && mv < bestMv)) {
        pts = c; bestForeign = foreign; bestMv = mv; bestObs = hit;
      }
    }
    if (bestForeign > 0) {
      onWarning?.(
        `Aux feeder leg to ${stop.id} still crosses a neighbouring site area's fence — no clear route exists around it for this substation take-off, so review the aux feeder trench in detailed design.`
      );
    }
    if (bestMv > 0) {
      onWarning?.(
        `Aux feeder leg to ${stop.id} still crosses the MV feeder home run${bestMv === 1 ? '' : 's'} in ${bestMv} place${bestMv === 1 ? '' : 's'} — no clear parallel route exists for this substation position and yard layout, so review the aux feeder trench in detailed design.`
      );
    }
    if (feederCrossesObstacle(pts, obs, a, b)) {
      // Kept, never dropped: distinguish an exclusion-area crossing (audit
      // will FAIL it) from an ordinary equipment-clearance pinch.
      const hitsExclusion = auxExclObstacles.length > 0 &&
        feederCrossesObstacle(pts, auxExclObstacles, a, b);
      onWarning?.(hitsExclusion
        ? `Aux feeder leg to ${stop.id} crosses an UNDERGROUND EXCLUSION AREA and no compliant detour was found — reroute before export.`
        : `Aux feeder leg to ${stop.id} could not fully clear equipment/fence clearance — review the aux feeder trench in detailed design.`);
    }
    return { pts, lengthFt: polyLen(pts) };
  });

  const circuitNo = mvFeeders.length + 1;
  const auxName = auxFeederNameOf(mvFeeders);
  return {
    circuitNo,
    name: auxName,
    label: `AUX FEEDER #${auxName} (34.5 kV)`,
    stopIds: order.map(o => o.id),
    legs,
    totalLengthFt: legs.reduce((s2, l) => s2 + l.lengthFt, 0),
  };
}
