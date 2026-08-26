// Proposed finished-grade (FG) surface engine — the screening-grade answer
// to Civil 3D surface modeling for a BESS yard:
//
//   * The fenced yard grades as one or more PADS with a designer-selectable
//     drainage slope (e.g. 0.5–2%) and downhill direction, instead of the
//     dead-flat median pad of the basic cut/fill screen.
//   * Optional BENCH mode splits the yard into terraced pads along the major
//     grade direction, each with its own base elevation, with the step
//     between adjacent benches capped at a max bench height and screened
//     against the ramp length a road needs to climb it.
//   * A balance optimizer shifts the whole FG surface up/down (bisection —
//     the adjusted net volume is monotone in the shift) until the earthwork
//     hits net-zero or a user-set import/export bias, with fill compaction
//     shrink applied.
//   * Tie-in daylight slopes at independent cut/fill ratios replace the
//     vertical cut at the fence: their wedge volumes count in the earthwork
//     and their outer limit forms the daylight (disturbance) polygon.
//
// Pure + deterministic (sampled on fixed lattices, no randomness) for tests.
// Preview/analysis only — NEVER imported by dxfExport/dxfSheets; default
// exports stay byte-identical with the feature off.

import { Pt } from './types';
import { ElevationGrid, LocalRect, sampleElevationFt } from './terrain';
import { pointInPolygon } from './kmz';

const CF_PER_CY = 27;

// ---------------------------------------------------------------------------
// Inputs (persisted like other study inputs; deep-sanitized from storage).

export interface GradingInputs {
  padSlopePct: number;      // pad drainage slope, % (0 = flat pad)
  slopeDirDeg: number;      // downhill compass azimuth, deg (0=N, 90=E, 180=S)
  benchMode: boolean;       // terrace the yard into stepped pads
  maxBenchHeightFt: number; // max step between adjacent benches, ft
  maxRoadGradePct: number;  // max road grade climbing a bench step, %
  cutRatioH: number;        // cut daylight slope, horizontal per 1 vertical
  fillRatioH: number;       // fill daylight slope, horizontal per 1 vertical
  shrinkPct: number;        // fill compaction shrink, % (bank -> compacted loss)
  swellPct: number;         // cut haul swell, % (bank -> loose bulking)
  balanceBiasCY: number;    // target adjusted net; 0 = balanced, + = import, - = export
  topsoilStripIn: number;   // topsoil strip depth over disturbed area, inches
}

export const DEFAULT_GRADING_INPUTS: GradingInputs = {
  padSlopePct: 1,
  slopeDirDeg: 180,
  benchMode: false,
  maxBenchHeightFt: 8,
  maxRoadGradePct: 8,
  cutRatioH: 2,
  fillRatioH: 3,
  shrinkPct: 12,
  swellPct: 20,
  balanceBiasCY: 0,
  topsoilStripIn: 6,
};

// Per-field clamp policy: finite numbers clamp into the engineering range,
// anything else snaps back to the default (untrusted localStorage JSON).
const num = (v: unknown, def: number, min: number, max: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : def;

export function sanitizeGradingInputs(v: unknown): GradingInputs {
  const d = DEFAULT_GRADING_INPUTS;
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { ...d };
  const o = v as Record<string, unknown>;
  const dir = num(o.slopeDirDeg, d.slopeDirDeg, -360, 720);
  return {
    padSlopePct: num(o.padSlopePct, d.padSlopePct, 0, 5),
    slopeDirDeg: ((dir % 360) + 360) % 360,
    benchMode: typeof o.benchMode === 'boolean' ? o.benchMode : d.benchMode,
    maxBenchHeightFt: num(o.maxBenchHeightFt, d.maxBenchHeightFt, 2, 20),
    maxRoadGradePct: num(o.maxRoadGradePct, d.maxRoadGradePct, 2, 15),
    cutRatioH: num(o.cutRatioH, d.cutRatioH, 1, 6),
    fillRatioH: num(o.fillRatioH, d.fillRatioH, 1, 6),
    shrinkPct: num(o.shrinkPct, d.shrinkPct, 0, 40),
    swellPct: num(o.swellPct, d.swellPct, 0, 60),
    balanceBiasCY: num(o.balanceBiasCY, d.balanceBiasCY, -1_000_000, 1_000_000),
    topsoilStripIn: num(o.topsoilStripIn, d.topsoilStripIn, 0, 24),
  };
}

// ---------------------------------------------------------------------------
// Multi-pad grading zones (opt-in): named axis-aligned rectangles inside the
// fence, each holding its own pad elevation as an offset from the balanced
// base surface — fixed by the engineer or auto-solved to the local terrain.
// Engineering inputs: they persist in the PROJECT file, not localStorage.
// With no zones the engine takes the exact legacy code path (byte-identity).

export const MAX_GRADING_ZONES = 4;
export const ZONE_MIN_SIZE_FT = 20;
export const ZONE_MAX_SIZE_FT = 5000;
export const ZONE_MAX_OFFSET_FT = 20;

export interface GradingZone {
  id: string;
  name: string;
  x: number;         // rectangle center, site ft
  y: number;
  lengthFt: number;  // extent along x
  widthFt: number;   // extent along y
  mode: 'offset' | 'auto';
  offsetFt: number;  // pad offset from the balanced base FG (mode 'offset')
}

// Untrusted zones from a project file / autosave: invalid entries are
// DROPPED (that zone falls back to "no zone") instead of rejecting the file,
// matching the sanitizeLayoutEdits policy. Never returns more than the cap.
export function sanitizeGradingZones(v: unknown): GradingZone[] {
  if (!Array.isArray(v)) return [];
  const out: GradingZone[] = [];
  const seen = new Set<string>();
  for (const raw of v) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const z = raw as Record<string, unknown>;
    if (typeof z.id !== 'string' || !z.id || seen.has(z.id)) continue;
    if (typeof z.x !== 'number' || !Number.isFinite(z.x)) continue;
    if (typeof z.y !== 'number' || !Number.isFinite(z.y)) continue;
    if (typeof z.lengthFt !== 'number' || !Number.isFinite(z.lengthFt)) continue;
    if (typeof z.widthFt !== 'number' || !Number.isFinite(z.widthFt)) continue;
    const mode = z.mode === 'auto' ? 'auto' : z.mode === 'offset' ? 'offset' : null;
    if (!mode) continue;
    out.push({
      id: z.id,
      name: typeof z.name === 'string' && z.name.trim() ? z.name.trim().slice(0, 24) : `ZONE ${out.length + 1}`,
      x: z.x,
      y: z.y,
      lengthFt: Math.min(ZONE_MAX_SIZE_FT, Math.max(ZONE_MIN_SIZE_FT, z.lengthFt)),
      widthFt: Math.min(ZONE_MAX_SIZE_FT, Math.max(ZONE_MIN_SIZE_FT, z.widthFt)),
      mode,
      offsetFt: num(z.offsetFt, 0, -ZONE_MAX_OFFSET_FT, ZONE_MAX_OFFSET_FT),
    });
    seen.add(z.id);
    if (out.length >= MAX_GRADING_ZONES) break;
  }
  return out;
}

const zoneRect = (z: GradingZone) => ({
  x0: z.x - z.lengthFt / 2, x1: z.x + z.lengthFt / 2,
  y0: z.y - z.widthFt / 2, y1: z.y + z.widthFt / 2,
});

// Per-zone fence containment test — true when the zone rectangle sits fully
// inside the fence polygon (or when there is no usable fence, matching the
// set-level validator's fence.length >= 3 guard). Lets callers drop ONLY the
// offending zone(s) instead of resetting the whole set.
export function gradingZoneInsideFence(z: GradingZone, fence: Pt[]): boolean {
  if (fence.length < 3) return true;
  const r = zoneRect(z);
  const corners: Pt[] = [
    { x: r.x0, y: r.y0 }, { x: r.x1, y: r.y0 },
    { x: r.x1, y: r.y1 }, { x: r.x0, y: r.y1 },
  ];
  return corners.every(c => pointInPolygon(c, fence));
}

// Validation for the reject→warn→keep pattern: returns the specific reason a
// candidate zone set is not buildable, or null when it is valid. Zones must
// sit fully inside the fence and must not overlap each other.
export function gradingZonesRejectReason(zones: GradingZone[], fence: Pt[]): string | null {
  if (zones.length > MAX_GRADING_ZONES) {
    return `at most ${MAX_GRADING_ZONES} grading zones are supported`;
  }
  if (fence.length >= 3) {
    for (const z of zones) {
      const r = zoneRect(z);
      const corners: Pt[] = [
        { x: r.x0, y: r.y0 }, { x: r.x1, y: r.y0 },
        { x: r.x1, y: r.y1 }, { x: r.x0, y: r.y1 },
      ];
      if (!corners.every(c => pointInPolygon(c, fence))) {
        return `zone "${z.name}" extends outside the fenced yard`;
      }
    }
  }
  for (let i = 0; i < zones.length; i++) {
    for (let j = i + 1; j < zones.length; j++) {
      const a = zoneRect(zones[i]), b = zoneRect(zones[j]);
      if (a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1) {
        return `zones "${zones[i].name}" and "${zones[j].name}" overlap`;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Surface model.

export interface FgBench {
  index: number;
  proj0: number;      // bench extent along the downhill axis (projection, ft)
  proj1: number;
  baseElevFt: number; // FG elevation at the bench's projection center
}

export interface EarthworkSummary {
  cutCY: number;            // bank volume removed (pad + tie-in wedges)
  fillCY: number;           // compacted volume placed (pad + tie-in wedges)
  netCY: number;            // fill - cut (raw, no factors)
  adjustedFillCY: number;   // bank volume needed for the fill after shrink
  adjustedNetCY: number;    // adjustedFill - cut; + = import, - = export
  haulLooseCY: number;      // cut volume in loose (hauled) measure after swell
  topsoilCY: number;        // strip over the disturbed area (stockpiled separately)
  padAreaSqFt: number;      // fenced yard area sampled
  tieInAreaSqFt: number;    // daylight slope band area outside the fence
  disturbedAreaSqFt: number;// pad + tie-in band
  sampleSpacingFt: number;
  balanceShiftFt: number;   // global FG shift the optimizer applied
  maxBenchStepFt: number;   // largest step between adjacent benches (0 = none)
  requiredRampLenFt: number;// road length needed to climb that step at max grade
  warnings: string[];
}

// A solved grading zone carried on the FG surface: rectangle extents plus
// the resolved pad offset (auto zones get their solved value here) and the
// transition band width used to blend back into the base surface.
export interface FgZone {
  id: string;
  name: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  mode: 'offset' | 'auto';
  offsetFt: number; // resolved offset from the base FG surface
  blendFt: number;  // transition band width outside the rectangle
}

export interface FgSurface {
  inputs: GradingInputs;
  dir: Pt;              // downhill unit vector in plan (x = E, y = N)
  fence: Pt[];
  benches: FgBench[];
  daylightPolygon: Pt[]; // fence offset outward to the daylight limit
  earthwork: EarthworkSummary;
  // Present ONLY when grading zones are defined — absent, the surface JSON
  // is byte-identical to the zone-free engine output.
  zones?: FgZone[];
}

// Vertical zone adjustment at a plan point: full offset inside the zone
// rectangle, linear falloff across the blend band, zero beyond. Zones are
// validated non-overlapping; abutting blend bands sum (continuous either way).
function zoneAdjustAt(zones: readonly FgZone[], x: number, y: number): number {
  let adj = 0;
  for (const z of zones) {
    const dx = Math.max(z.x0 - x, 0, x - z.x1);
    const dy = Math.max(z.y0 - y, 0, y - z.y1);
    const dist = Math.hypot(dx, dy);
    if (dist <= 0) adj += z.offsetFt;
    else if (dist < z.blendFt) adj += z.offsetFt * (1 - dist / z.blendFt);
  }
  return adj;
}

// Daylight offsets beyond this are unrealistic for a screening yard pad and
// would run the surface off the loaded grid — clamp (and warn via dz).
const MAX_DAYLIGHT_OFFSET_FT = 150;
const PERIMETER_STEP_FT = 10;

// Projection of a point onto the downhill axis.
const proj = (p: Pt, dir: Pt): number => p.x * dir.x + p.y * dir.y;

// Bench-local FG plane elevation at a projection coordinate.
const benchPlaneElev = (b: FgBench, s: number, pr: number): number =>
  b.baseElevFt - s * (pr - (b.proj0 + b.proj1) / 2);

// FG pad elevation along the downhill axis for a set of benches. Within a
// bench the pad falls at padSlopePct; adjacent benches are connected by a
// ramp transition band centered on the shared boundary whose width is set by
// the bench step and the max road grade (clamped to the available bench
// depth — when clamped the actual grade exceeds the limit, which the builder
// already reports via the ramp warning). Continuous by construction.
function padElevAtProj(benches: FgBench[], s: number, maxRoadGradePct: number, pr: number): number {
  let bi = 0;
  for (let i = 0; i < benches.length; i++) {
    if (pr >= benches[i].proj0) bi = i; else break;
  }
  const b = benches[bi];
  if (benches.length > 1) {
    const grade = Math.max(maxRoadGradePct, 0.5) / 100;
    const ramp = (up: FgBench, dn: FgBench): number | null => {
      const boundary = dn.proj0;
      const step = Math.abs(benchPlaneElev(up, s, boundary) - benchPlaneElev(dn, s, boundary));
      if (step < 1e-9) return null;
      // Half-width so the blended surface climbs the step at <= road grade,
      // clamped so the band stays inside both benches.
      let w = step / grade / 2;
      w = Math.min(w, (up.proj1 - up.proj0) * 0.49, (dn.proj1 - dn.proj0) * 0.49);
      if (w < 1e-9 || pr < boundary - w || pr > boundary + w) return null;
      const e0 = benchPlaneElev(up, s, boundary - w);
      const e1 = benchPlaneElev(dn, s, boundary + w);
      const t = (pr - (boundary - w)) / (2 * w);
      return e0 + (e1 - e0) * t;
    };
    if (bi > 0) {
      const v = ramp(benches[bi - 1], b);
      if (v !== null) return v;
    }
    if (bi < benches.length - 1) {
      const v = ramp(b, benches[bi + 1]);
      if (v !== null) return v;
    }
  }
  return benchPlaneElev(b, s, pr);
}

export function fgPadElevationAt(surface: Pick<FgSurface, 'benches' | 'dir' | 'inputs' | 'zones'>, x: number, y: number): number {
  const { benches, dir, inputs, zones } = surface;
  const s = inputs.padSlopePct / 100;
  const base = padElevAtProj(benches, s, inputs.maxRoadGradePct, proj({ x, y }, dir));
  return zones && zones.length ? base + zoneAdjustAt(zones, x, y) : base;
}

// Live drag-preview of a candidate zone's resulting pad: replicates the
// builder's auto-solve (median existing-ground residual over the base pad,
// same lattice spacing rule) against an already-built surface, so the ghost
// can show the pad elevation the zone WOULD get at the candidate rectangle.
// The builder's benches carry the balance shift, while zone offsets were
// solved pre-shift — residuals vs the shifted base are corrected by adding
// balanceShiftFt back. The global re-balance a moved zone triggers is a
// second-order effect, so the preview is approximate (labelled "≈").
export function previewZonePadInfo(
  surface: FgSurface,
  grid: ElevationGrid,
  rect: LocalRect,
  zone: GradingZone
): { offsetFt: number; padElevFt: number; solved: boolean } {
  const baseAt = (x: number, y: number) =>
    fgPadElevationAt({ benches: surface.benches, dir: surface.dir, inputs: surface.inputs, zones: undefined }, x, y);
  let offsetFt = zone.offsetFt;
  let solved = true;
  if (zone.mode === 'auto') {
    const fence = surface.fence;
    const xs = fence.map(p => p.x), ys = fence.map(p => p.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const span = Math.max(maxX - minX, maxY - minY);
    const step = Math.max(5, span / 120);
    const zx0 = zone.x - zone.lengthFt / 2, zx1 = zone.x + zone.lengthFt / 2;
    const zy0 = zone.y - zone.widthFt / 2, zy1 = zone.y + zone.widthFt / 2;
    const shift = surface.earthwork.balanceShiftFt;
    const residuals: number[] = [];
    for (let y = minY + step / 2; y < maxY; y += step) {
      if (y < zy0 || y > zy1) continue;
      for (let x = minX + step / 2; x < maxX; x += step) {
        if (x < zx0 || x > zx1) continue;
        if (!pointInPolygon({ x, y }, fence)) continue;
        const og = sampleElevationFt(grid, rect, x, y);
        if (!Number.isFinite(og)) continue;
        residuals.push(og - baseAt(x, y) + shift);
      }
    }
    if (residuals.length) {
      const s2 = residuals.slice().sort((a, b) => a - b);
      const m = s2.length >> 1;
      const med = s2.length % 2 ? s2[m] : (s2[m - 1] + s2[m]) / 2;
      offsetFt = Math.min(ZONE_MAX_OFFSET_FT, Math.max(-ZONE_MAX_OFFSET_FT, med));
    } else {
      offsetFt = 0;
      solved = false;
    }
  }
  return { offsetFt, padElevFt: baseAt(zone.x, zone.y) + offsetFt, solved };
}

// Nearest point on the fence polygon boundary (for tie-in slope faces).
function nearestPointOnPolygon(p: Pt, poly: Pt[]): { q: Pt; dist: number } {
  let best = { q: poly[0], dist: Infinity };
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
    const q = { x: a.x + dx * t, y: a.y + dy * t };
    const d = Math.hypot(p.x - q.x, p.y - q.y);
    if (d < best.dist) best = { q, dist: d };
  }
  return best;
}

// Full FG surface elevation at any local point: the sloped/benched pad inside
// the fence, the cut/fill daylight slope face in the tie-in band outside it,
// and existing ground beyond daylight. Continuous by construction.
export function fgElevationAt(
  surface: FgSurface,
  grid: ElevationGrid,
  rect: LocalRect,
  x: number,
  y: number
): number {
  if (surface.fence.length >= 3 && pointInPolygon({ x, y }, surface.fence)) {
    return fgPadElevationAt(surface, x, y);
  }
  const og = sampleElevationFt(grid, rect, x, y);
  if (!Number.isFinite(og)) return og;
  const { q, dist } = nearestPointOnPolygon({ x, y }, surface.fence);
  if (dist > MAX_DAYLIGHT_OFFSET_FT) return og;
  const fgEdge = fgPadElevationAt(surface, q.x, q.y);
  if (og > fgEdge) {
    // Cut: slope face rises from the pad edge to meet the higher ground.
    return Math.min(og, fgEdge + dist / surface.inputs.cutRatioH);
  }
  // Fill: slope face falls from the pad edge to meet the lower ground.
  return Math.max(og, fgEdge - dist / surface.inputs.fillRatioH);
}

// ---------------------------------------------------------------------------
// Builder: solve bench base elevations + global balance shift, then compute
// the earthwork summary and daylight polygon.

interface PadSample { x: number; y: number; og: number; pr: number }
interface PerimSample { p: Pt; n: Pt; segLen: number }

export function buildFgSurface(
  grid: ElevationGrid,
  rect: LocalRect,
  fence: Pt[],
  inputsRaw: Partial<GradingInputs> | GradingInputs,
  sampleSpacingFt?: number,
  zonesRaw?: GradingZone[]
): FgSurface | null {
  const inputs = sanitizeGradingInputs({ ...DEFAULT_GRADING_INPUTS, ...inputsRaw });
  if (fence.length < 3) return null;
  const zonesIn = zonesRaw && zonesRaw.length ? sanitizeGradingZones(zonesRaw) : [];

  // Downhill unit vector from the compass azimuth (0 = N = +y, 90 = E = +x).
  const a = (inputs.slopeDirDeg * Math.PI) / 180;
  const dir: Pt = { x: Math.sin(a), y: Math.cos(a) };
  const slope = inputs.padSlopePct / 100;

  // Interior sample lattice — same spacing rule as computeCutFill so the two
  // screens agree on resolution (deterministic, ~120 samples across).
  const xs = fence.map(p => p.x), ys = fence.map(p => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const span = Math.max(maxX - minX, maxY - minY);
  const step = sampleSpacingFt ?? Math.max(5, span / 120);
  const pads: PadSample[] = [];
  let ogMin = Infinity, ogMax = -Infinity;
  for (let y = minY + step / 2; y < maxY; y += step) {
    for (let x = minX + step / 2; x < maxX; x += step) {
      if (!pointInPolygon({ x, y }, fence)) continue;
      const og = sampleElevationFt(grid, rect, x, y);
      if (!Number.isFinite(og)) continue;
      pads.push({ x, y, og, pr: proj({ x, y }, dir) });
      if (og < ogMin) ogMin = og;
      if (og > ogMax) ogMax = og;
    }
  }
  if (!pads.length) return null;

  // Bench extents along the downhill axis (fence vertices bound the pads).
  const prs = fence.map(p => proj(p, dir));
  const prMin = Math.min(...prs), prMax = Math.max(...prs);
  const benchCount = inputs.benchMode
    ? Math.min(12, Math.max(1, Math.ceil((ogMax - ogMin) / inputs.maxBenchHeightFt)))
    : 1;
  const benchLen = (prMax - prMin) / benchCount;

  // Initial base elevation per bench: the median of (og + slope * (pr - c))
  // over that bench's samples — the L1-optimal plane offset for the bench.
  const median = (arr: number[]): number => {
    const s2 = arr.slice().sort((p2, q2) => p2 - q2);
    const m = s2.length >> 1;
    return s2.length % 2 ? s2[m] : (s2[m - 1] + s2[m]) / 2;
  };
  const benches: FgBench[] = [];
  for (let i = 0; i < benchCount; i++) {
    const proj0 = prMin + i * benchLen;
    const proj1 = i === benchCount - 1 ? prMax : proj0 + benchLen;
    const center = (proj0 + proj1) / 2;
    const inBench = pads.filter(sm =>
      sm.pr >= proj0 - 1e-9 && (i === benchCount - 1 ? sm.pr <= proj1 + 1e-9 : sm.pr < proj1));
    const base = inBench.length
      ? median(inBench.map(sm => sm.og + slope * (sm.pr - center)))
      : median(pads.map(sm => sm.og + slope * (sm.pr - center)));
    benches.push({ index: i, proj0, proj1, baseElevFt: base });
  }

  // Cap the step between adjacent benches at maxBenchHeightFt: walk downhill
  // and clamp each bench's base into the range the previous one allows. The
  // step at the shared boundary is fg(uphill side) - fg(downhill side).
  for (let i = 1; i < benches.length; i++) {
    const up = benches[i - 1], dn = benches[i];
    const boundary = dn.proj0;
    const fgUp = up.baseElevFt - slope * (boundary - (up.proj0 + up.proj1) / 2);
    const dnCenter = (dn.proj0 + dn.proj1) / 2;
    // fgDn(boundary) = base - slope * (boundary - center); solve base bounds.
    const fgDnLo = fgUp - inputs.maxBenchHeightFt;
    const fgDnHi = fgUp + inputs.maxBenchHeightFt;
    const baseLo = fgDnLo + slope * (boundary - dnCenter);
    const baseHi = fgDnHi + slope * (boundary - dnCenter);
    dn.baseElevFt = Math.min(baseHi, Math.max(baseLo, dn.baseElevFt));
  }

  // Perimeter samples for the tie-in wedges (shared by the balance objective
  // and the final summary). Outward normal via polygon orientation.
  let area2 = 0;
  for (let i = 0; i < fence.length; i++) {
    const p1 = fence[i], p2 = fence[(i + 1) % fence.length];
    area2 += p1.x * p2.y - p2.x * p1.y;
  }
  const ccw = area2 > 0;
  const perim: PerimSample[] = [];
  for (let i = 0; i < fence.length; i++) {
    const p1 = fence[i], p2 = fence[(i + 1) % fence.length];
    const dx = p2.x - p1.x, dy = p2.y - p1.y;
    const len = Math.hypot(dx, dy);
    if (!(len > 1e-6)) continue;
    const sgn = ccw ? 1 : -1;
    const n = { x: (sgn * dy) / len, y: (-sgn * dx) / len };
    const count = Math.max(1, Math.round(len / PERIMETER_STEP_FT));
    const segLen = len / count;
    for (let k = 0; k < count; k++) {
      const t = (k + 0.5) / count;
      perim.push({ p: { x: p1.x + dx * t, y: p1.y + dy * t }, n, segLen });
    }
  }

  const cellArea = step * step;
  const shrinkFactor = 1 - inputs.shrinkPct / 100;

  // Earthwork for a candidate global shift. Pad volumes prism-sum per sample;
  // tie-in volumes are triangular wedges (0.5 * dz * offset) per perimeter
  // segment. Adjusted net = fill/(1-shrink) - cut, monotone increasing in
  // the shift, which makes the balance solve a clean bisection.
  // FG at zero shift is precomputed per sample: a uniform base shift moves
  // every bench plane (and the linear ramp blends between them) by exactly
  // that shift, so fg(shift) = fg0 + shift. Ramp corridors are part of the
  // pad lattice, so their volumes are integrated, not just screened.
  // Solve the grading zones against the pre-shift base surface: fixed zones
  // take their offset as-is; auto zones take the median residual of existing
  // ground over the base pad inside the rectangle (L1-optimal local pad).
  // The blend band is sized so the transition slope stays at or below the
  // flatter of the two tie-in ratios. Offsets are relative to the base pad,
  // so the global balance shift moves zones with it: fg(shift) = fg0 + shift.
  const zoneWarnings: string[] = [];
  const zones: FgZone[] = zonesIn.map(z => {
    const x0 = z.x - z.lengthFt / 2, x1 = z.x + z.lengthFt / 2;
    const y0 = z.y - z.widthFt / 2, y1 = z.y + z.widthFt / 2;
    let offsetFt = z.offsetFt;
    if (z.mode === 'auto') {
      const residuals = pads
        .filter(sm => sm.x >= x0 && sm.x <= x1 && sm.y >= y0 && sm.y <= y1)
        .map(sm => sm.og - padElevAtProj(benches, slope, inputs.maxRoadGradePct, sm.pr));
      if (residuals.length) {
        offsetFt = Math.min(ZONE_MAX_OFFSET_FT, Math.max(-ZONE_MAX_OFFSET_FT, median(residuals)));
      } else {
        offsetFt = 0;
        zoneWarnings.push(`Zone "${z.name}" contains no terrain samples — auto offset left at 0.`);
      }
    }
    const blendFt = Math.max(10, Math.abs(offsetFt) * 2 * Math.max(inputs.cutRatioH, inputs.fillRatioH));
    return { id: z.id, name: z.name, x0, y0, x1, y1, mode: z.mode, offsetFt, blendFt };
  });
  if (zones.length && inputs.benchMode && benches.length > 1) {
    zoneWarnings.push('Grading zones are offsets from the benched base surface — a zone spanning a bench step inherits that step.');
  }
  const zAdj = (x: number, y: number): number => (zones.length ? zoneAdjustAt(zones, x, y) : 0);

  const padFg0 = pads.map(sm => padElevAtProj(benches, slope, inputs.maxRoadGradePct, sm.pr) + zAdj(sm.x, sm.y));
  const perimFg0 = perim.map(ps => padElevAtProj(benches, slope, inputs.maxRoadGradePct, proj(ps.p, dir)) + zAdj(ps.p.x, ps.p.y));
  const perimOg = perim.map(ps => sampleElevationFt(grid, rect, ps.p.x, ps.p.y));
  const evalShift = (shift: number) => {
    let cutCF = 0, fillCF = 0, tieInArea = 0;
    for (let i = 0; i < pads.length; i++) {
      const dz = pads[i].og - (padFg0[i] + shift);
      if (dz > 0) cutCF += dz * cellArea;
      else fillCF += -dz * cellArea;
    }
    for (let i = 0; i < perim.length; i++) {
      const ps = perim[i];
      const og = perimOg[i];
      if (!Number.isFinite(og)) continue;
      const fgEdge = perimFg0[i] + shift;
      const dz = og - fgEdge;
      const ratio = dz > 0 ? inputs.cutRatioH : inputs.fillRatioH;
      const offset = Math.min(Math.abs(dz) * ratio, MAX_DAYLIGHT_OFFSET_FT);
      const wedgeCF = 0.5 * Math.abs(dz) * offset * ps.segLen;
      if (dz > 0) cutCF += wedgeCF; else fillCF += wedgeCF;
      tieInArea += offset * ps.segLen;
    }
    const cutCY = cutCF / CF_PER_CY;
    const fillCY = fillCF / CF_PER_CY;
    const adjustedFillCY = shrinkFactor > 0 ? fillCY / shrinkFactor : fillCY;
    return { cutCY, fillCY, tieInArea, adjustedNetCY: adjustedFillCY - cutCY, adjustedFillCY };
  };

  // Balance: bisect the shift until adjustedNet hits the bias target.
  const warnings: string[] = [...zoneWarnings];
  let lo = -(ogMax - ogMin) - 50, hi = (ogMax - ogMin) + 50;
  const target = inputs.balanceBiasCY;
  const fLo = evalShift(lo).adjustedNetCY - target;
  const fHi = evalShift(hi).adjustedNetCY - target;
  let shift = 0;
  if (fLo > 0 || fHi < 0) {
    warnings.push('Balance target unreachable within the site relief — FG left at the unshifted grade.');
  } else {
    let l = lo, h = hi;
    for (let it = 0; it < 60; it++) {
      const mid = (l + h) / 2;
      if (evalShift(mid).adjustedNetCY - target > 0) h = mid; else l = mid;
    }
    shift = (lo === l && hi === h) ? 0 : (l + h) / 2;
  }
  const final = evalShift(shift); // fg0 lattices are pre-shift
  for (const b of benches) b.baseElevFt += shift;

  // Bench-step / ramp screening.
  let maxStep = 0;
  for (let i = 1; i < benches.length; i++) {
    const up = benches[i - 1], dn = benches[i];
    const boundary = dn.proj0;
    const fgUp = up.baseElevFt - slope * (boundary - (up.proj0 + up.proj1) / 2);
    const fgDn = dn.baseElevFt - slope * (boundary - (dn.proj0 + dn.proj1) / 2);
    maxStep = Math.max(maxStep, Math.abs(fgUp - fgDn));
  }
  const requiredRampLenFt = maxStep > 0 ? maxStep / (inputs.maxRoadGradePct / 100) : 0;
  if (benches.length > 1 && requiredRampLenFt > benchLen) {
    warnings.push(
      `Ramp between benches needs ${Math.round(requiredRampLenFt)} ft at ${inputs.maxRoadGradePct}% road grade ` +
      `but each bench is only ${Math.round(benchLen)} ft deep — flatten benches or relax the road grade.`
    );
  }

  const padAreaSqFt = pads.length * cellArea;
  const disturbedAreaSqFt = padAreaSqFt + final.tieInArea;
  const topsoilCY = (disturbedAreaSqFt * (inputs.topsoilStripIn / 12)) / CF_PER_CY;

  const earthwork: EarthworkSummary = {
    cutCY: final.cutCY,
    fillCY: final.fillCY,
    netCY: final.fillCY - final.cutCY,
    adjustedFillCY: final.adjustedFillCY,
    adjustedNetCY: final.adjustedNetCY,
    haulLooseCY: final.cutCY * (1 + inputs.swellPct / 100),
    topsoilCY,
    padAreaSqFt,
    tieInAreaSqFt: final.tieInArea,
    disturbedAreaSqFt,
    sampleSpacingFt: step,
    balanceShiftFt: shift,
    maxBenchStepFt: maxStep,
    requiredRampLenFt,
    warnings,
  };

  // Zone offsets are relative to the base pad, so the shifted surface keeps
  // them unchanged; include zones so daylight edges honor the local pads.
  const partial = zones.length
    ? { benches, dir, inputs, zones }
    : { benches, dir, inputs };

  // Daylight polygon: each fence vertex offset outward along its averaged
  // edge normal by the local daylight distance (clamped).
  const daylightPolygon: Pt[] = fence.map((p, i) => {
    const prev = fence[(i - 1 + fence.length) % fence.length];
    const next = fence[(i + 1) % fence.length];
    const sgn = ccw ? 1 : -1;
    const mk = (a2: Pt, b2: Pt): Pt => {
      const dx = b2.x - a2.x, dy = b2.y - a2.y;
      const len = Math.hypot(dx, dy) || 1;
      return { x: (sgn * dy) / len, y: (-sgn * dx) / len };
    };
    const n1 = mk(prev, p), n2 = mk(p, next);
    let nx = n1.x + n2.x, ny = n1.y + n2.y;
    const nl = Math.hypot(nx, ny) || 1;
    nx /= nl; ny /= nl;
    const og = sampleElevationFt(grid, rect, p.x, p.y);
    const fgEdge = fgPadElevationAt(partial, p.x, p.y);
    const dz = Number.isFinite(og) ? og - fgEdge : 0;
    const ratio = dz > 0 ? inputs.cutRatioH : inputs.fillRatioH;
    const offset = Math.min(Math.abs(dz) * ratio, MAX_DAYLIGHT_OFFSET_FT);
    return { x: p.x + nx * offset, y: p.y + ny * offset };
  });

  // `zones` key present ONLY when zones exist so the zone-free surface JSON
  // stays byte-identical to the legacy engine output.
  return zones.length
    ? { inputs, dir, fence, benches, daylightPolygon, earthwork, zones }
    : { inputs, dir, fence, benches, daylightPolygon, earthwork };
}
