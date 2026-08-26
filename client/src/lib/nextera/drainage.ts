// Storm drainage screening on the proposed finished-grade (FG) surface —
// the screening-grade answer to Civil 3D + Storm & Sanitary for a BESS 10%
// package: does the pad drain, where does water pond, and where does it
// leave the site?
//
//   * D8 flow model on a fixed lattice over the disturbed (daylight) area:
//     steepest-descent flow direction, flow accumulation, and sink
//     (ponding) detection on pads and roads.
//   * Perimeter swale layout along the daylight-limit toe, split into runs
//     that drain to the low corner(s) of the site — the discharge points.
//   * Rational-method screening at each discharge point (Q = C·i·A) with a
//     Kirpich time of concentration, and a Manning normal-depth check that
//     sizes the required triangular swale section at the user-set
//     longitudinal grade.
//
// Pure + deterministic (fixed lattices, stable sorts, no randomness) so it
// runs in Node tests on synthetic grids. SCREENING ONLY — never imported by
// dxfExport/dxfSheets; default exports stay byte-identical with the feature
// off.

import { Pt } from './types';
import { ElevationGrid, LocalRect } from './terrain';
import { pointInPolygon } from './kmz';
import { FgSurface, fgElevationAt } from './gradingSurface';
import { Atlas14Idf, idfIntensityAt } from './rainfall';
import {
  Tr55Tc, tr55TimeOfConcentration,
  ScsStormType, Hydrograph, scsStormHydrograph, scsRunoffIn,
  designDetentionOutlet, estimateRequiredStorageCf,
  basinStorageCf, outletDischargeCfs, BasinGeometry,
  culvertOutletControl as hdsOutletControl,
} from './hydrology';

// ---------------------------------------------------------------------------
// Inputs (persisted like other study inputs; deep-sanitized from storage).

export type ChannelShape = 'triangular' | 'trapezoidal';

export interface DrainageInputs {
  runoffC: number;             // rational-method runoff coefficient (0.1–0.95)
  rainfallIntensityInHr: number; // design rainfall intensity i, in/hr (manual)
  manningN: number;            // swale Manning roughness (grass ~0.030)
  swaleSideSlopeH: number;     // swale side slope, horizontal per 1 vertical
  swaleGradePct: number;       // swale longitudinal grade, %
  // --- A+ additions (all default to the legacy behavior) ---
  useNoaaIdf: boolean;         // use the fetched NOAA Atlas 14 IDF at Tc
  stormAriYears: number;       // design storm ARI (years) when the IDF is on
  channelShape: ChannelShape;  // swale cross-section shape
  bottomWidthFt: number;       // trapezoidal bottom width, ft
  freeboardFt: number;         // required freeboard above design depth, ft
  weightedC: boolean;          // composite C from the layout surfaces
  cPad: number;                // equipment pads / containers (impervious-ish)
  cRoad: number;               // compacted aggregate access roads
  cGravel: number;             // crushed-rock yard surfacing
  cUndisturbed: number;        // undisturbed / vegetated ground
  detention: boolean;          // detention-basin screening
  preDevC: number;             // pre-development runoff coefficient
  basinDepthFt: number;        // detention basin design depth, ft
  // --- Design-grade additions (all default to the legacy behavior) ---
  tr55Tc: boolean;             // TR-55 segmental Tc (sheet/shallow/channel)
  sheetFlowN: number;          // Manning n for sheet flow (TR-55 Table 3-1)
  sheetFlowLenFt: number;      // sheet-flow segment length (<= 100 ft eff.)
  p2In: number;                // 2-yr 24-hr rainfall for sheet flow, inches
  tcOverrideMin: number;       // manual Tc override, minutes (0 = computed)
  scsMode: boolean;            // NRCS CN + SCS unit-hydrograph hydrology
  curveNumber: number;         // post-development composite CN
  preDevCn: number;            // pre-development CN
  stormType: ScsStormType;     // 24-hr design storm distribution
  rain24In: number;            // 24-hr design rainfall depth, inches
  routedDetention: boolean;    // level-pool routed pond design (needs SCS)
  culvertOutlet: boolean;      // HDS-5 outlet-control check on culverts
  tailwaterFt: number;         // culvert tailwater above the outlet invert
  // --- Fidelity additions (all default to the legacy behavior) ---
  tracedTc: boolean;           // D8-traced flow path for the TR-55 Tc (needs tr55Tc)
  basinAspect: number;         // detention pond bottom L:W aspect (1 = square)
  riserDiaIn: number;          // second-stage riser orifice diameter, in (0 = none)
  riserCrestFt: number;        // riser invert stage above the pond bottom, ft
}

export const DEFAULT_DRAINAGE_INPUTS: DrainageInputs = {
  runoffC: 0.75,        // graded/gravel yard
  rainfallIntensityInHr: 4,
  manningN: 0.03,
  swaleSideSlopeH: 3,
  swaleGradePct: 0.5,
  useNoaaIdf: false,
  stormAriYears: 25,
  channelShape: 'triangular',
  bottomWidthFt: 2,
  freeboardFt: 0.5,
  weightedC: false,
  cPad: 0.9,
  cRoad: 0.85,
  cGravel: 0.75,
  cUndisturbed: 0.35,
  detention: false,
  preDevC: 0.3,
  basinDepthFt: 3,
  tr55Tc: false,
  sheetFlowN: 0.15,
  sheetFlowLenFt: 100,
  p2In: 3.5,
  tcOverrideMin: 0,
  scsMode: false,
  curveNumber: 85,
  preDevCn: 70,
  stormType: 'II',
  rain24In: 6,
  routedDetention: false,
  culvertOutlet: false,
  tailwaterFt: 0,
  tracedTc: false,
  basinAspect: 1,
  riserDiaIn: 0,
  riserCrestFt: 0,
};

// Numeric-field keys of DrainageInputs.
export type DrainageNumericKey = {
  [K in keyof DrainageInputs]: DrainageInputs[K] extends number ? K : never;
}[keyof DrainageInputs];

// Single source of truth for the sanitizer clamp ranges. The panel's number
// fields read min/max from here so what the drafter sees always matches what
// the sanitizer (and therefore every export) will accept.
export const DRAINAGE_NUM_LIMITS: Record<DrainageNumericKey, { min: number; max: number }> = {
  runoffC: { min: 0.1, max: 0.95 },
  rainfallIntensityInHr: { min: 0.5, max: 12 },
  manningN: { min: 0.012, max: 0.15 },
  swaleSideSlopeH: { min: 2, max: 6 },
  swaleGradePct: { min: 0.2, max: 5 },
  stormAriYears: { min: 1, max: 1000 },
  bottomWidthFt: { min: 0.5, max: 12 },
  freeboardFt: { min: 0, max: 2 },
  cPad: { min: 0.1, max: 0.98 },
  cRoad: { min: 0.1, max: 0.98 },
  cGravel: { min: 0.1, max: 0.98 },
  cUndisturbed: { min: 0.05, max: 0.95 },
  preDevC: { min: 0.05, max: 0.95 },
  basinDepthFt: { min: 1.5, max: 8 },
  sheetFlowN: { min: 0.011, max: 0.8 },
  sheetFlowLenFt: { min: 0, max: 100 },
  p2In: { min: 0.5, max: 10 },
  tcOverrideMin: { min: 0, max: 180 },
  curveNumber: { min: 40, max: 98 },
  preDevCn: { min: 30, max: 95 },
  rain24In: { min: 0.5, max: 20 },
  tailwaterFt: { min: 0, max: 8 },
  basinAspect: { min: 1, max: 6 },
  riserDiaIn: { min: 0, max: 48 },
  riserCrestFt: { min: 0, max: 8 },
};

const num = (v: unknown, def: number, min: number, max: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : def;

const numK = (o: Record<string, unknown>, k: DrainageNumericKey): number =>
  num(o[k], DEFAULT_DRAINAGE_INPUTS[k], DRAINAGE_NUM_LIMITS[k].min, DRAINAGE_NUM_LIMITS[k].max);

const bool = (v: unknown, def: boolean): boolean => (typeof v === 'boolean' ? v : def);

export function sanitizeDrainageInputs(v: unknown): DrainageInputs {
  const d = DEFAULT_DRAINAGE_INPUTS;
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { ...d };
  const o = v as Record<string, unknown>;
  return {
    runoffC: numK(o, 'runoffC'),
    rainfallIntensityInHr: numK(o, 'rainfallIntensityInHr'),
    manningN: numK(o, 'manningN'),
    swaleSideSlopeH: numK(o, 'swaleSideSlopeH'),
    swaleGradePct: numK(o, 'swaleGradePct'),
    useNoaaIdf: bool(o.useNoaaIdf, d.useNoaaIdf),
    stormAriYears: numK(o, 'stormAriYears'),
    channelShape: o.channelShape === 'trapezoidal' ? 'trapezoidal' : 'triangular',
    bottomWidthFt: numK(o, 'bottomWidthFt'),
    freeboardFt: numK(o, 'freeboardFt'),
    weightedC: bool(o.weightedC, d.weightedC),
    cPad: numK(o, 'cPad'),
    cRoad: numK(o, 'cRoad'),
    cGravel: numK(o, 'cGravel'),
    cUndisturbed: numK(o, 'cUndisturbed'),
    detention: bool(o.detention, d.detention),
    preDevC: numK(o, 'preDevC'),
    basinDepthFt: numK(o, 'basinDepthFt'),
    tr55Tc: bool(o.tr55Tc, d.tr55Tc),
    sheetFlowN: numK(o, 'sheetFlowN'),
    sheetFlowLenFt: numK(o, 'sheetFlowLenFt'),
    p2In: numK(o, 'p2In'),
    tcOverrideMin: numK(o, 'tcOverrideMin'),
    scsMode: bool(o.scsMode, d.scsMode),
    curveNumber: numK(o, 'curveNumber'),
    preDevCn: numK(o, 'preDevCn'),
    stormType: o.stormType === 'III' ? 'III' : 'II',
    rain24In: numK(o, 'rain24In'),
    routedDetention: bool(o.routedDetention, d.routedDetention),
    culvertOutlet: bool(o.culvertOutlet, d.culvertOutlet),
    tailwaterFt: numK(o, 'tailwaterFt'),
    tracedTc: bool(o.tracedTc, d.tracedTc),
    basinAspect: numK(o, 'basinAspect'),
    riserDiaIn: numK(o, 'riserDiaIn'),
    riserCrestFt: numK(o, 'riserCrestFt'),
  };
}

// ---------------------------------------------------------------------------
// Model output.

export interface FlowArrow {
  x: number; y: number;        // cell center (local ft)
  dx: number; dy: number;      // unit flow direction in plan
  accumSqFt: number;           // upstream contributing area
}

export interface FlowPath {
  pts: Pt[];                   // downstream polyline (cell centers)
  accumSqFt: number;           // accumulation at the head
}

export interface PondingSpot {
  x: number; y: number;
  elevFt: number;
  areaSqFt: number;            // cell area flagged (screening)
  onPad: boolean;              // inside the fence (pad/road) vs tie-in band
}

export interface SwaleSection {
  depthFt: number;             // required flow depth (normal depth for Q)
  topWidthFt: number;          // top width at depthFt
  velocityFps: number;
  capacityCfs: number;         // capacity at depthFt (== Q by construction)
  // Present only for trapezoidal sections — the triangular JSON is unchanged.
  bottomWidthFt?: number;
}

export interface SwaleRun {
  pts: Pt[];                   // toe centerline, ordered toward the discharge
  lengthFt: number;
  dischargeIdx: number;        // index into discharges
  section: SwaleSection;
}

// Riprap outlet protection at a discharge point (Isbash screening with a
// 1.25 safety factor, sized to the incoming swale velocity; class ladder is
// the common DOT D50 series).
export interface RiprapSpec {
  velocityFps: number;         // design velocity at the outlet
  d50In: number;               // required median stone size (class ladder)
  apronLengthFt: number;
  apronWidthFt: number;
  thicknessIn: number;         // 2 × D50, min 12 in
}

export interface DischargePoint {
  p: Pt;
  elevFt: number;              // FG toe elevation
  areaAcres: number;           // contributing area (D8, incl. sinks resolved)
  tcMin: number;               // Kirpich time of concentration, minutes
  qCfs: number;                // rational-method peak flow
  longestPathFt: number;
  // Present only when the respective A+ feature is active — the legacy JSON
  // is unchanged when everything is off.
  compositeC?: number;         // surface-weighted C for this subcatchment
  intensityInHr?: number;      // IDF intensity actually used (at Tc, ARI)
  riprap?: RiprapSpec;         // outlet protection (attached when Q > 0)
  tc55?: Tr55Tc;               // TR-55 segmental Tc breakdown (when enabled)
  scs?: ScsDischarge;          // NRCS hydrograph summary (when SCS mode is on)
  tracedPathFt?: number;       // D8-traced hydraulic path length (when tracedTc)
}

// NRCS/SCS per-discharge hydrology summary (opt-in SCS mode).
export interface ScsDischarge {
  cn: number;
  runoffIn: number;            // 24-hr runoff depth
  peakCfs: number;             // unit-hydrograph peak
  peakAtMin: number;           // time of peak from storm start
  volumeCf: number;            // runoff volume
}

// One drainage subcatchment (shed) draining to a discharge point: lattice
// cells whose D8 terminal reports to that DP, outlined for the DR-1 map.
export interface Subcatchment {
  dischargeIdx: number;
  areaSqFt: number;
  loops: Pt[][];               // closed boundary loops (lattice-edge trace)
}

// Detention-basin screening (modified rational when an IDF is available,
// triangle approximation otherwise).
export interface DetentionBasin {
  prePeakCfs: number;          // allowable release (pre-development peak)
  postPeakCfs: number;         // developed peak at the design storm
  requiredCf: number;          // required storage volume, cubic ft
  method: string;              // how requiredCf was computed
  depthFt: number;
  topWFt: number;              // square basin top width (3:1 interior slopes)
  bottomWFt: number;
  providedCf: number;          // volume of the suggested basin
  rect?: { x0: number; y0: number; x1: number; y1: number }; // placed footprint
  placed: boolean;
}

// Culvert where a perimeter swale crosses an access road (FHWA HDS-5
// inlet-control screening, square-edge headwall, HW/D ≤ 1.5).
export interface CulvertSpec {
  p: Pt;                       // crossing point (plan)
  qCfs: number;
  diaIn: number;
  hwOverD: number;             // headwater ratio at qCfs
  lengthFt: number;            // road width + end sections
  dischargeIdx: number;        // swale system it belongs to
  outlet?: CulvertOutletCheck; // HDS-5 outlet-control check (when enabled)
}

// HDS-5 outlet-control result next to the inlet-control screening; the
// controlling case is the larger computed headwater.
export interface CulvertOutletCheck {
  hwInletFt: number;           // inlet-control headwater, ft (= hwOverD × D)
  hwOutletFt: number;          // outlet-control headwater, ft
  tailwaterFt: number;         // tailwater used
  criticalDepthFt: number;
  lossesFt: number;            // entrance + friction + exit losses
  controlling: 'inlet' | 'outlet';
}

export interface DrainageModel {
  inputs: DrainageInputs;
  cellFt: number;              // lattice spacing
  flowArrows: FlowArrow[];     // decimated arrow field (major flow only)
  flowPaths: FlowPath[];       // traced major flow-path polylines
  ponding: PondingSpot[];      // sinks (low spots) sorted worst-first
  swales: SwaleRun[];
  discharges: DischargePoint[];
  warnings: string[];
  disclaimer: string;
  // Present only when the respective A+ feature/context is supplied.
  subcatchments?: Subcatchment[];
  detention?: DetentionBasin;
  culverts?: CulvertSpec[];
  idfSource?: string;          // NOAA table provenance when useNoaaIdf is on
  scs?: ScsSummary;            // site NRCS hydrology (when SCS mode is on)
  routing?: DetentionRouting;  // routed pond design (when routedDetention on)
}

// Site-level NRCS/SCS hydrology summary (opt-in SCS mode).
export interface ScsSummary {
  stormType: ScsStormType;
  rain24In: number;
  cn: number;
  preDevCn: number;
  runoffIn: number;            // post-development 24-hr runoff depth
  preRunoffIn: number;
  sitePeakCfs: number;         // combined site inflow hydrograph peak
  prePeakCfs: number;          // pre-development hydrograph peak (allowable)
  hydrograph: Hydrograph;      // combined site inflow hydrograph
}

// Routed detention design (level-pool / Modified Puls) summary.
export interface DetentionRouting {
  bottomWFt: number;           // designed square basin bottom width
  topWFt: number;
  depthFt: number;
  sideSlopeH: number;
  orificeDiaIn: number;
  weirCrestFt: number;
  weirLengthFt: number;
  // Present only when the respective fidelity input is non-default.
  aspectRatio?: number;        // bottom L:W (rect pond); absent = square
  bottomLFt?: number;          // bottom length (rect pond)
  topLFt?: number;             // top length (rect pond)
  riserDiaIn?: number;         // second-stage riser orifice
  riserCrestFt?: number;
  peakInflowCfs: number;
  peakOutflowCfs: number;
  allowableCfs: number;
  maxStageFt: number;
  maxStorageCf: number;
  freeboardFt: number;
  drawdownHr: number;
  // Routed hydrograph traces at the inflow dt (t = 0, dt, 2dt, ... — same
  // clock as scs.hydrograph.ordinatesCfs; dt = scs.hydrograph.dtMin).
  outflowCfs: number[];
  stageTraceFt: number[];
  meetsRelease: boolean;
  grownBasin: boolean;
  stageStorage: Array<{ stageFt: number; storageCf: number; outflowCfs: number }>;
}

// Layout surfaces for the weighted-C classification and culvert crossings.
// Rects are center + rotation like PlacedEquipment / RoadSegment.
export interface SurfaceRect {
  x: number; y: number;
  length: number; width: number;
  rotation: number;            // radians
}

export interface DrainageSurfaces {
  pads: SurfaceRect[];         // equipment footprints
  roads: SurfaceRect[];        // entrance roads + drive aisles
  gravel: Array<{ outer: Pt[]; holes: Pt[][] }> | null; // surfacing regions
  parcel?: Pt[];               // parcel polygon (basin placement check)
}

export interface DrainageModelOpts {
  idf?: Atlas14Idf | null;
  surfaces?: DrainageSurfaces | null;
}

// Layout -> DrainageSurfaces (weighted C classification, culvert crossings,
// basin placement). Duck-typed to avoid importing SiteDesign (keeps this
// module usable from Node tests with synthetic layouts).
export function drainageSurfacesFromDesign(design: {
  equipment: Array<SurfaceRect & { kind?: string }>;
  roads: SurfaceRect[];
  aisles: SurfaceRect[];
  surfacing: { regions: Array<{ outer: Pt[]; holes: Pt[][] }> } | null;
  boundary: { polygon: Pt[] };
}): DrainageSurfaces {
  return {
    pads: design.equipment.map(e => ({
      x: e.x, y: e.y, length: e.length, width: e.width, rotation: e.rotation,
    })),
    roads: [...design.roads, ...design.aisles].map(r => ({
      x: r.x, y: r.y, length: r.length, width: r.width, rotation: r.rotation,
    })),
    gravel: design.surfacing
      ? design.surfacing.regions.map(g => ({ outer: g.outer, holes: g.holes }))
      : null,
    parcel: design.boundary.polygon.length >= 3 ? design.boundary.polygon : undefined,
  };
}

export const DRAINAGE_DISCLAIMER =
  'Screening-level drainage only (rational method, D8 on the proposed FG). ' +
  'Not a hydrology study — final design requires a drainage report per the AHJ.';

// D8 neighbor offsets (E, NE, N, NW, W, SW, S, SE) and distances.
const D8: Array<{ dx: number; dy: number }> = [
  { dx: 1, dy: 0 }, { dx: 1, dy: 1 }, { dx: 0, dy: 1 }, { dx: -1, dy: 1 },
  { dx: -1, dy: 0 }, { dx: -1, dy: -1 }, { dx: 0, dy: -1 }, { dx: 1, dy: -1 },
];

// Manning triangular-channel normal depth for Q (cfs) at grade s (ft/ft),
// side slope z (H per 1 V), roughness n. Monotone in depth -> bisection.
// Q = (1.49/n) · A · R^(2/3) · s^(1/2),  A = z·d²,  P = 2·d·√(1+z²).
export function triangularSwaleSection(
  qCfs: number, gradePct: number, sideSlopeH: number, manningN: number
): SwaleSection {
  const s = Math.max(gradePct, 0.05) / 100;
  const z = sideSlopeH;
  const cap = (d: number): number => {
    if (d <= 0) return 0;
    const area = z * d * d;
    const perim = 2 * d * Math.sqrt(1 + z * z);
    const r = area / perim;
    return (1.49 / manningN) * area * Math.pow(r, 2 / 3) * Math.sqrt(s);
  };
  if (!(qCfs > 0)) {
    return { depthFt: 0, topWidthFt: 0, velocityFps: 0, capacityCfs: 0 };
  }
  let lo = 0, hi = 0.5;
  while (cap(hi) < qCfs && hi < 64) hi *= 2;
  for (let it = 0; it < 60; it++) {
    const mid = (lo + hi) / 2;
    if (cap(mid) < qCfs) lo = mid; else hi = mid;
  }
  const d = (lo + hi) / 2;
  const area = z * d * d;
  const q = cap(d);
  return {
    depthFt: d,
    topWidthFt: 2 * z * d,
    velocityFps: area > 0 ? q / area : 0,
    capacityCfs: q,
  };
}

// Manning trapezoidal-channel normal depth for Q (cfs) at grade s (ft/ft),
// bottom width b (ft), side slope z (H per 1 V), roughness n. Monotone in
// depth -> bisection. A = (b + z·d)·d, P = b + 2·d·√(1+z²).
export function trapezoidalSwaleSection(
  qCfs: number, gradePct: number, sideSlopeH: number, manningN: number, bottomWidthFt: number
): SwaleSection {
  const s = Math.max(gradePct, 0.05) / 100;
  const z = sideSlopeH;
  const b = Math.max(0.5, bottomWidthFt);
  const cap = (d: number): number => {
    if (d <= 0) return 0;
    const area = (b + z * d) * d;
    const perim = b + 2 * d * Math.sqrt(1 + z * z);
    const r = area / perim;
    return (1.49 / manningN) * area * Math.pow(r, 2 / 3) * Math.sqrt(s);
  };
  if (!(qCfs > 0)) {
    return { depthFt: 0, topWidthFt: b, velocityFps: 0, capacityCfs: 0, bottomWidthFt: b };
  }
  let lo = 0, hi = 0.5;
  while (cap(hi) < qCfs && hi < 64) hi *= 2;
  for (let it = 0; it < 60; it++) {
    const mid = (lo + hi) / 2;
    if (cap(mid) < qCfs) lo = mid; else hi = mid;
  }
  const d = (lo + hi) / 2;
  const area = (b + z * d) * d;
  const q = cap(d);
  return {
    depthFt: d,
    topWidthFt: b + 2 * z * d,
    velocityFps: area > 0 ? q / area : 0,
    capacityCfs: q,
    bottomWidthFt: b,
  };
}

// Channel section for the configured shape.
export function channelSectionFor(inputs: DrainageInputs, qCfs: number): SwaleSection {
  return inputs.channelShape === 'trapezoidal'
    ? trapezoidalSwaleSection(qCfs, inputs.swaleGradePct, inputs.swaleSideSlopeH, inputs.manningN, inputs.bottomWidthFt)
    : triangularSwaleSection(qCfs, inputs.swaleGradePct, inputs.swaleSideSlopeH, inputs.manningN);
}

// Riprap outlet protection: Isbash stable-stone size at the outlet velocity
// (C = 0.86 turbulent, Sg = 2.65) with a 1.25 safety factor, snapped up to
// the common DOT class ladder. Apron: L = max(10 ft, 6·depth), W = swale top
// width + 4 ft, thickness 2·D50 (min 12 in). Screening — not scour design.
export const RIPRAP_D50_LADDER_IN = [6, 9, 12, 18, 24];

export function riprapFor(velocityFps: number, depthFt: number, topWidthFt: number): RiprapSpec {
  const g = 32.2, C = 0.86, sg = 2.65;
  const d50RawFt = (velocityFps * velocityFps) / (2 * g * C * C * (sg - 1)) * 1.25;
  const d50RawIn = d50RawFt * 12;
  let d50In = RIPRAP_D50_LADDER_IN[RIPRAP_D50_LADDER_IN.length - 1];
  for (const v of RIPRAP_D50_LADDER_IN) {
    if (v >= d50RawIn) { d50In = v; break; }
  }
  return {
    velocityFps,
    d50In,
    apronLengthFt: Math.max(10, 6 * depthFt),
    apronWidthFt: Math.max(4, topWidthFt + 4),
    thicknessIn: Math.max(12, 2 * d50In),
  };
}

// FHWA HDS-5 inlet-control screening for a circular culvert (square-edge
// headwall, submerged/orifice form: HW/D = c·(Q/(A·D^0.5))² + Y − 0.5·S).
// Returns the smallest ladder diameter with HW/D ≤ 1.5, or the largest
// ladder size (flagged by the caller via hwOverD > 1.5).
export const CULVERT_DIA_LADDER_IN = [18, 24, 30, 36, 42, 48, 60, 72];

export function culvertInletControl(qCfs: number, slopeFtFt: number): { diaIn: number; hwOverD: number } {
  const c = 0.0398, Y = 0.67;
  const hwOverD = (dFt: number): number => {
    const a = Math.PI * dFt * dFt / 4;
    const x = qCfs / (a * Math.sqrt(dFt));
    return c * x * x + Y - 0.5 * slopeFtFt;
  };
  for (const diaIn of CULVERT_DIA_LADDER_IN) {
    const h = hwOverD(diaIn / 12);
    if (h <= 1.5) return { diaIn, hwOverD: h };
  }
  const last = CULVERT_DIA_LADDER_IN[CULVERT_DIA_LADDER_IN.length - 1];
  return { diaIn: last, hwOverD: hwOverD(last / 12) };
}

// Point inside a rotated rect (center/length/width/rotation)?
function pointInSurfaceRect(p: Pt, r: SurfaceRect): boolean {
  const c = Math.cos(-r.rotation), s = Math.sin(-r.rotation);
  const dx = p.x - r.x, dy = p.y - r.y;
  const lx = dx * c - dy * s, ly = dx * s + dy * c;
  return Math.abs(lx) <= r.length / 2 + 1e-9 && Math.abs(ly) <= r.width / 2 + 1e-9;
}

// Segment × rotated-rect intersection: slab-clip in the rect frame.
// Returns the crossing midpoint, or null when the segment misses the rect.
function segmentRectCrossing(a: Pt, b: Pt, r: SurfaceRect): Pt | null {
  const c = Math.cos(-r.rotation), s = Math.sin(-r.rotation);
  const tx = (p: Pt): Pt => {
    const dx = p.x - r.x, dy = p.y - r.y;
    return { x: dx * c - dy * s, y: dx * s + dy * c };
  };
  const la = tx(a), lb = tx(b);
  const dx = lb.x - la.x, dy = lb.y - la.y;
  let t0 = 0, t1 = 1;
  for (const [d, o, half] of [
    [dx, la.x, r.length / 2] as const,
    [dy, la.y, r.width / 2] as const,
  ]) {
    if (Math.abs(d) < 1e-12) {
      if (o < -half || o > half) return null;
    } else {
      const ta = (-half - o) / d, tb = (half - o) / d;
      t0 = Math.max(t0, Math.min(ta, tb));
      t1 = Math.min(t1, Math.max(ta, tb));
    }
  }
  if (t1 <= t0) return null;
  const tm = (t0 + t1) / 2;
  return { x: a.x + (b.x - a.x) * tm, y: a.y + (b.y - a.y) * tm };
}

// Kirpich time of concentration (minutes): tc = 0.0078 · L^0.77 · S^-0.385,
// L in ft, S in ft/ft; floored at 5 minutes (standard screening floor).
export function kirpichTcMin(lengthFt: number, dropFt: number): number {
  if (!(lengthFt > 0) || !(dropFt > 0)) return 5;
  const s = dropFt / lengthFt;
  const tc = 0.0078 * Math.pow(lengthFt, 0.77) * Math.pow(s, -0.385);
  return Math.max(5, tc);
}

const SQFT_PER_ACRE = 43560;
const TOE_STEP_FT = 25;      // swale toe densification
const ARROW_MAX = 400;       // cap on rendered arrows
const PATH_COUNT = 8;        // traced major flow paths

export function buildDrainageModel(
  grid: ElevationGrid,
  rect: LocalRect,
  fg: FgSurface,
  inputsRaw: Partial<DrainageInputs> | DrainageInputs,
  cellFtOverride?: number,
  opts?: DrainageModelOpts
): DrainageModel | null {
  const inputs = sanitizeDrainageInputs({ ...DEFAULT_DRAINAGE_INPUTS, ...inputsRaw });
  const idf = inputs.useNoaaIdf ? (opts?.idf ?? null) : null;
  const surfaces = opts?.surfaces ?? null;
  const region = fg.daylightPolygon.length >= 3 ? fg.daylightPolygon : fg.fence;
  if (region.length < 3) return null;

  // Lattice over the disturbed area. Same style of deterministic spacing as
  // the grading engine (~96 cells across, min 5 ft).
  const xs = region.map(p => p.x), ys = region.map(p => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const span = Math.max(maxX - minX, maxY - minY);
  const cell = cellFtOverride ?? Math.max(5, span / 96);
  const nx = Math.max(2, Math.ceil((maxX - minX) / cell));
  const ny = Math.max(2, Math.ceil((maxY - minY) / cell));
  const cellArea = cell * cell;

  const idx = (ix: number, iy: number) => iy * nx + ix;
  const cx = (ix: number) => minX + (ix + 0.5) * cell;
  const cyF = (iy: number) => minY + (iy + 0.5) * cell;

  const inside = new Array<boolean>(nx * ny).fill(false);
  const z = new Array<number>(nx * ny).fill(NaN);
  const cellsIn: number[] = [];
  for (let iy = 0; iy < ny; iy++) {
    for (let ix = 0; ix < nx; ix++) {
      const p = { x: cx(ix), y: cyF(iy) };
      if (!pointInPolygon(p, region)) continue;
      const e = fgElevationAt(fg, grid, rect, p.x, p.y);
      if (!Number.isFinite(e)) continue;
      const i = idx(ix, iy);
      inside[i] = true;
      z[i] = e;
      cellsIn.push(i);
    }
  }
  if (cellsIn.length < 4) return null;

  // D8 flow direction: steepest descent. downstream[i] = cell index, or
  // -1 = sink (no lower in-region neighbor AND not at the region edge), or
  // -2 = exit (steepest drop leaves the region — water leaves the site).
  const downstream = new Array<number>(nx * ny).fill(-1);
  for (const i of cellsIn) {
    const ix = i % nx, iy = Math.floor(i / nx);
    let bestSlope = 0, best = -1, edge = false;
    for (const d of D8) {
      const jx = ix + d.dx, jy = iy + d.dy;
      const dist = Math.hypot(d.dx, d.dy) * cell;
      if (jx < 0 || jy < 0 || jx >= nx || jy >= ny || !inside[idx(jx, jy)]) {
        edge = true;
        continue;
      }
      const j = idx(jx, jy);
      const slope = (z[i] - z[j]) / dist;
      if (slope > bestSlope + 1e-12) { bestSlope = slope; best = j; }
    }
    // No downhill in-region neighbor: at the region edge water simply exits
    // over the toe; in the interior it is a genuine sink (ponding).
    downstream[i] = best >= 0 ? best : (edge ? -2 : -1);
  }

  // Flow accumulation: process high-to-low (stable order by elevation then
  // index) — each cell pushes its accumulated area downstream.
  const accum = new Array<number>(nx * ny).fill(0);
  const order = cellsIn.slice().sort((a, b) => (z[b] - z[a]) || (a - b));
  for (const i of order) {
    accum[i] += cellArea;
    const dsi = downstream[i];
    if (dsi >= 0) accum[dsi] += accum[i];
  }

  // Terminal resolution (memoized): where does each cell's water end up?
  // >= 0: terminal cell index (exit-edge cell or sink cell).
  const terminal = new Array<number>(nx * ny).fill(-9);
  const resolveTerminal = (start: number): number => {
    const chain: number[] = [];
    let i = start;
    while (terminal[i] === -9) {
      chain.push(i);
      const dsi = downstream[i];
      if (dsi < 0) { terminal[i] = i; break; } // sink or exit edge terminates here
      i = dsi;
    }
    const t = terminal[i] !== -9 ? terminal[i] : i;
    for (const c of chain) terminal[c] = t;
    return t;
  };

  // Ponding: interior sinks, worst (largest upstream area) first.
  const ponding: PondingSpot[] = [];
  for (const i of cellsIn) {
    if (downstream[i] !== -1) continue;
    const p = { x: cx(i % nx), y: cyF(Math.floor(i / nx)) };
    ponding.push({
      x: p.x, y: p.y, elevFt: z[i],
      areaSqFt: accum[i],
      onPad: pointInPolygon(p, fg.fence),
    });
  }
  ponding.sort((a, b) => (b.areaSqFt - a.areaSqFt) || (a.x - b.x) || (a.y - b.y));

  // Arrow field: the top-accumulation cells that flow somewhere (decimated).
  const flowing = cellsIn.filter(i => downstream[i] >= 0);
  const byAccum = flowing.slice().sort((a, b) => (accum[b] - accum[a]) || (a - b));
  const arrowCells = byAccum.slice(0, Math.min(ARROW_MAX, Math.ceil(byAccum.length / 3)));
  const flowArrows: FlowArrow[] = arrowCells.map(i => {
    const dsi = downstream[i];
    const ax = cx(i % nx), ay = cyF(Math.floor(i / nx));
    const bx2 = cx(dsi % nx), by2 = cyF(Math.floor(dsi / nx));
    const len = Math.hypot(bx2 - ax, by2 - ay) || 1;
    return { x: ax, y: ay, dx: (bx2 - ax) / len, dy: (by2 - ay) / len, accumSqFt: accum[i] };
  });

  // Major flow paths: trace downstream from the highest-accumulation exit
  // feeders' heads. Heads = high-accum cells that no rendered path passes
  // through yet (greedy, deterministic).
  const flowPaths: FlowPath[] = [];
  const onPath = new Set<number>();
  for (const head of byAccum) {
    if (flowPaths.length >= PATH_COUNT) break;
    if (onPath.has(head)) continue;
    const pts: Pt[] = [];
    let i = head, guard = 0;
    while (i >= 0 && guard++ < nx * ny) {
      pts.push({ x: cx(i % nx), y: cyF(Math.floor(i / nx)) });
      onPath.add(i);
      i = downstream[i];
    }
    if (pts.length >= 3) flowPaths.push({ pts, accumSqFt: accum[head] });
  }

  // -------------------------------------------------------------------------
  // Perimeter swale along the daylight toe. Densify the toe polygon, read
  // the FG elevation at each toe point, find discharge points (local minima
  // of toe elevation) and split the loop into runs draining to them.
  const toe: Array<{ p: Pt; elevFt: number }> = [];
  for (let i = 0; i < region.length; i++) {
    const a = region[i], b = region[(i + 1) % region.length];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const count = Math.max(1, Math.round(len / TOE_STEP_FT));
    for (let k = 0; k < count; k++) {
      const t = k / count;
      const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      toe.push({ p, elevFt: fgElevationAt(fg, grid, rect, p.x, p.y) });
    }
  }
  const n = toe.length;
  if (n < 4) return null;

  // Local minima on the closed toe loop (strictly not-higher than both
  // neighbors, with a tie-break so flats yield one point: first index).
  const isMin = (i: number): boolean => {
    const prev = toe[(i - 1 + n) % n].elevFt, next = toe[(i + 1) % n].elevFt;
    if (toe[i].elevFt < prev && toe[i].elevFt < next) return true;
    // flat-bottom: count the first point of a flat run lower than both ends
    if (toe[i].elevFt <= prev && toe[i].elevFt < next && toe[i].elevFt < prev) return true;
    return false;
  };
  let minIdxs = Array.from({ length: n }, (_, i) => i).filter(isMin);
  if (minIdxs.length === 0) {
    // Monotone/flat loop: use the single global minimum (first occurrence).
    let best = 0;
    for (let i = 1; i < n; i++) if (toe[i].elevFt < toe[best].elevFt) best = i;
    minIdxs = [best];
  }
  // Keep discharge points well-separated: greedily accept minima low-first,
  // dropping any within 8 toe steps of an accepted one.
  const accepted: number[] = [];
  for (const i of minIdxs.slice().sort((a, b) => (toe[a].elevFt - toe[b].elevFt) || (a - b))) {
    const near = accepted.some(j => {
      const d = Math.abs(i - j);
      return Math.min(d, n - d) < 8;
    });
    if (!near) accepted.push(i);
  }
  accepted.sort((a, b) => a - b);

  // Split points between discharges: the local maximum of the toe elevation
  // on each arc between consecutive discharge points.
  const splits: number[] = [];
  for (let k = 0; k < accepted.length; k++) {
    const a = accepted[k], b = accepted[(k + 1) % accepted.length];
    let i = (a + 1) % n, best = i;
    while (i !== b) {
      if (toe[i].elevFt > toe[best].elevFt) best = i;
      i = (i + 1) % n;
    }
    splits.push(best);
  }

  // Contributing area per discharge: every lattice cell's terminal maps to
  // the nearest discharge point (sinks report to the nearest one too — the
  // pond warning already flags them; screening keeps the water accounted).
  const dischargeAreaSqFt = new Array<number>(accepted.length).fill(0);
  const dischargeLongest = new Array<number>(accepted.length).fill(0);
  const nearestDischarge = (p: Pt): number => {
    let best = 0, bd = Infinity;
    for (let k = 0; k < accepted.length; k++) {
      const q = toe[accepted[k]].p;
      const d = Math.hypot(p.x - q.x, p.y - q.y);
      if (d < bd - 1e-9) { bd = d; best = k; }
    }
    return best;
  };
  // Path length per cell (to its terminal) for Tc: computed along the chain.
  // shedOf[i] records the discharge subcatchment for the weighted-C sums,
  // the DR-1 subcatchment outlines and the detention screening.
  const shedOf = new Array<number>(nx * ny).fill(-1);
  // Surface classification per cell (weighted C): pad > road > gravel >
  // undisturbed, resolved on the cell center. Without surfacing regions,
  // in-fence cells default to gravel and out-of-fence cells to undisturbed.
  const surfaceC = (p: Pt): number => {
    if (surfaces) {
      for (const r of surfaces.pads) if (pointInSurfaceRect(p, r)) return inputs.cPad;
      for (const r of surfaces.roads) if (pointInSurfaceRect(p, r)) return inputs.cRoad;
      if (surfaces.gravel && surfaces.gravel.length) {
        for (const g of surfaces.gravel) {
          if (!pointInPolygon(p, g.outer)) continue;
          if (g.holes.some(h => pointInPolygon(p, h))) continue;
          return inputs.cGravel;
        }
        return inputs.cUndisturbed;
      }
    }
    return pointInPolygon(p, fg.fence) ? inputs.cGravel : inputs.cUndisturbed;
  };
  const useWeightedC = inputs.weightedC;
  const dischargeCSum = new Array<number>(accepted.length).fill(0);

  // Traced hydraulic path (opt-in): exact D8 chain length from each cell to
  // its terminal, memoized along the chains, plus the terminal→toe closing
  // hop. Replaces the straight-line ×1.2 proxy for the TR-55 length/slope.
  const useTraced = inputs.tr55Tc && inputs.tracedTc;
  const pathLenFt = useTraced ? new Array<number>(nx * ny).fill(-1) : null;
  const resolvePathLen = (start: number): number => {
    if (!pathLenFt) return 0;
    const chain: number[] = [];
    let i = start;
    while (pathLenFt[i] < 0) {
      const dsi = downstream[i];
      if (dsi < 0) { pathLenFt[i] = 0; break; } // terminal cell
      chain.push(i);
      i = dsi;
    }
    // Walk back up the chain accumulating hop distances.
    for (let c = chain.length - 1; c >= 0; c--) {
      const a = chain[c], b = downstream[a];
      const hop = Math.hypot(cx(a % nx) - cx(b % nx), cyF(Math.floor(a / nx)) - cyF(Math.floor(b / nx)));
      pathLenFt[a] = pathLenFt[b] + hop;
    }
    return pathLenFt[start];
  };
  const dischargeTracedFt = new Array<number>(accepted.length).fill(0);
  const dischargeTracedDropFt = new Array<number>(accepted.length).fill(0);

  for (const i of cellsIn) {
    const t = resolveTerminal(i);
    const tp = { x: cx(t % nx), y: cyF(Math.floor(t / nx)) };
    const k = nearestDischarge(tp);
    shedOf[i] = k;
    dischargeAreaSqFt[k] += cellArea;
    const cp = { x: cx(i % nx), y: cyF(Math.floor(i / nx)) };
    if (useWeightedC) dischargeCSum[k] += surfaceC(cp) * cellArea;
    // Longest-path proxy: straight-line from the cell to the discharge toe
    // point plus the D8 grid factor — cheap, stable, adequate for Tc floors.
    const q = toe[accepted[k]].p;
    const L = Math.hypot(cp.x - q.x, cp.y - q.y) * 1.2;
    if (L > dischargeLongest[k]) dischargeLongest[k] = L;
    if (useTraced) {
      // Traced length: D8 chain to the terminal + closing hop to the toe.
      const lt = resolvePathLen(i) + Math.hypot(tp.x - q.x, tp.y - q.y);
      if (lt > dischargeTracedFt[k]) {
        dischargeTracedFt[k] = lt;
        dischargeTracedDropFt[k] = Math.max(z[i] - toe[accepted[k]].elevFt, 0.1);
      }
    }
  }

  // Discharge hydrology.
  const dischargeDropFt = new Array<number>(accepted.length).fill(0.1);
  const discharges: DischargePoint[] = accepted.map((ti, k) => {
    const areaAcres = dischargeAreaSqFt[k] / SQFT_PER_ACRE;
    const L = dischargeLongest[k];
    // Drop over the longest path: highest FG in the shed vs the toe.
    let zMax = toe[ti].elevFt;
    for (const i of cellsIn) {
      // cheap: only cells assigned to this discharge matter; reuse terminal
      if (terminal[i] >= 0) {
        const tp = { x: cx(terminal[i] % nx), y: cyF(Math.floor(terminal[i] / nx)) };
        if (nearestDischarge(tp) === k && z[i] > zMax) zMax = z[i];
      }
    }
    dischargeDropFt[k] = Math.max(zMax - toe[ti].elevFt, 0.1);
    const tcMin = kirpichTcMin(L, dischargeDropFt[k]);
    const cEff = useWeightedC && dischargeAreaSqFt[k] > 0
      ? dischargeCSum[k] / dischargeAreaSqFt[k]
      : inputs.runoffC;
    const iUsed = idf
      ? idfIntensityAt(idf, inputs.stormAriYears, tcMin)
      : inputs.rainfallIntensityInHr;
    const qCfs = cEff * iUsed * areaAcres;
    const dp: DischargePoint = {
      p: toe[ti].p, elevFt: toe[ti].elevFt, areaAcres, tcMin, qCfs, longestPathFt: L,
    };
    // Optional fields only when the respective feature is active, keeping
    // the legacy JSON byte-identical with everything off.
    if (useWeightedC) dp.compositeC = cEff;
    if (idf) dp.intensityInHr = iUsed;
    return dp;
  });

  // Swale runs: each arc from a split (high point) to a discharge (low
  // point), sized by Manning for the full Q of its discharge (conservative:
  // both runs into a discharge carry their shared Q at the outlet).
  const swales: SwaleRun[] = [];
  const arcPts = (from: number, to: number, forward: boolean): Pt[] => {
    const pts: Pt[] = [];
    let i = from;
    for (let guard = 0; guard <= n; guard++) {
      pts.push(toe[i].p);
      if (i === to) break;
      i = forward ? (i + 1) % n : (i - 1 + n) % n;
    }
    return pts;
  };
  const polyLen = (pts: Pt[]): number => {
    let s = 0;
    for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    return s;
  };
  for (let k = 0; k < accepted.length; k++) {
    const dLow = accepted[k];
    // The two splits bracketing this discharge: splits[k-1] (before) and
    // splits[k] (after) in loop order.
    const hiPrev = splits[(k - 1 + accepted.length) % accepted.length];
    const hiNext = splits[k];
    const q = discharges[k].qCfs;
    const section = channelSectionFor(inputs, q);
    const runA = arcPts(hiPrev, dLow, true);
    if (runA.length >= 2) swales.push({ pts: runA, lengthFt: polyLen(runA), dischargeIdx: k, section });
    if (hiNext !== hiPrev || accepted.length > 1) {
      const runB = arcPts(hiNext, dLow, false);
      if (runB.length >= 2) swales.push({ pts: runB, lengthFt: polyLen(runB), dischargeIdx: k, section });
    }
  }

  // -------------------------------------------------------------------------
  // TR-55 segmental time of concentration (opt-in): sheet flow over the
  // first segment of the longest shed path, shallow concentrated flow over
  // the remainder, channel flow along the longest feeding swale run at its
  // Manning velocity. Recomputes i and Q at the new Tc and re-sizes the
  // swale sections so the whole chain stays consistent.
  if (inputs.tr55Tc) {
    discharges.forEach((dp, k) => {
      const traced = useTraced && dischargeTracedFt[k] > 0;
      const L = Math.max(traced ? dischargeTracedFt[k] : dp.longestPathFt, 1);
      const shedSlope = (traced ? dischargeTracedDropFt[k] : dischargeDropFt[k]) / L;
      if (traced) dp.tracedPathFt = dischargeTracedFt[k];
      const feeders = swales.filter(s => s.dischargeIdx === k);
      let chanLen = 0, chanVel = 0;
      for (const s of feeders) {
        if (s.lengthFt > chanLen) { chanLen = s.lengthFt; chanVel = s.section.velocityFps; }
      }
      const sheetLen = Math.min(inputs.sheetFlowLenFt, L);
      const tc = tr55TimeOfConcentration({
        sheetLenFt: sheetLen,
        sheetSlope: shedSlope,
        sheetN: inputs.sheetFlowN,
        p2In: inputs.p2In,
        shallowLenFt: Math.max(0, L - sheetLen),
        shallowSlope: shedSlope,
        shallowPaved: false,
        channelLenFt: chanLen,
        channelVelFps: chanVel,
      });
      if (inputs.tcOverrideMin > 0) {
        tc.totalMin = inputs.tcOverrideMin;
        tc.overridden = true;
      }
      dp.tcMin = tc.totalMin;
      dp.tc55 = tc;
      const cEff = dp.compositeC ?? inputs.runoffC;
      const iUsed = idf
        ? idfIntensityAt(idf, inputs.stormAriYears, dp.tcMin)
        : inputs.rainfallIntensityInHr;
      dp.qCfs = cEff * iUsed * dp.areaAcres;
      if (idf) dp.intensityInHr = iUsed;
      for (const s of feeders) s.section = channelSectionFor(inputs, dp.qCfs);
    });
  }

  // Warnings.
  const warnings: string[] = [];
  if (inputs.useNoaaIdf && !idf) {
    warnings.push(
      'NOAA Atlas 14 IDF is enabled but no table has been fetched — using the manual intensity. ' +
      'Fetch the IDF in the drainage panel for intensity-at-Tc hydrology.'
    );
  }
  const padPonds = ponding.filter(p => p.onPad);
  if (padPonds.length) {
    warnings.push(
      `${padPonds.length} low spot${padPonds.length > 1 ? 's' : ''} pond${padPonds.length > 1 ? '' : 's'} water ON THE PAD — ` +
      'regrade (increase pad slope or adjust the slope direction) so the yard sheets to the perimeter.'
    );
  }
  const bandPonds = ponding.length - padPonds.length;
  if (bandPonds > 0) {
    warnings.push(`${bandPonds} low spot${bandPonds > 1 ? 's' : ''} in the tie-in band trap runoff — check the daylight grading.`);
  }
  for (const s of swales) {
    if (s.section.depthFt + inputs.freeboardFt > 3) {
      const fb = inputs.freeboardFt > 0 ? ` + ${inputs.freeboardFt.toFixed(1)} ft freeboard` : '';
      warnings.push(
        `Swale run to discharge ${s.dischargeIdx + 1} needs ${s.section.depthFt.toFixed(1)} ft of depth${fb} at ` +
        `${inputs.swaleGradePct}% — deeper than a typical 3 ft roadside swale; add a discharge point or steepen the grade.`
      );
      break; // one warning is enough
    }
  }

  // Riprap outlet protection at each discharge with flow: sized to the
  // worst (fastest) incoming swale run.
  discharges.forEach((d, k) => {
    if (!(d.qCfs > 0)) return;
    const feeders = swales.filter(s => s.dischargeIdx === k);
    if (!feeders.length) return;
    let worst = feeders[0].section;
    for (const s of feeders) if (s.section.velocityFps > worst.velocityFps) worst = s.section;
    d.riprap = riprapFor(worst.velocityFps, worst.depthFt, worst.topWidthFt);
  });

  const model: DrainageModel = {
    inputs,
    cellFt: cell,
    flowArrows,
    flowPaths,
    ponding,
    swales,
    discharges,
    warnings,
    disclaimer: DRAINAGE_DISCLAIMER,
  };
  if (idf) model.idfSource = idf.source;

  // -------------------------------------------------------------------------
  // Subcatchment outlines for the DR-1 drainage area map: trace the lattice
  // boundary edges of each shed into closed loops (deterministic chaining).
  {
    const key = (p: Pt): string => `${Math.round(p.x * 100)}|${Math.round(p.y * 100)}`;
    const subs: Subcatchment[] = [];
    for (let k = 0; k < accepted.length; k++) {
      // Directed boundary edges (CCW around the shed): for each cell in shed
      // k, any 4-neighbor edge whose neighbor is not in the shed.
      const segs: Array<{ a: Pt; b: Pt }> = [];
      for (const i of cellsIn) {
        if (shedOf[i] !== k) continue;
        const ix = i % nx, iy = Math.floor(i / nx);
        const x0 = minX + ix * cell, y0 = minY + iy * cell;
        const x1 = x0 + cell, y1 = y0 + cell;
        const nb = (jx: number, jy: number): boolean => {
          if (jx < 0 || jy < 0 || jx >= nx || jy >= ny) return false;
          const j = idx(jx, jy);
          return inside[j] && shedOf[j] === k;
        };
        // Edges directed so the shed interior is on the left (CCW loops).
        if (!nb(ix, iy - 1)) segs.push({ a: { x: x0, y: y0 }, b: { x: x1, y: y0 } }); // south
        if (!nb(ix + 1, iy)) segs.push({ a: { x: x1, y: y0 }, b: { x: x1, y: y1 } }); // east
        if (!nb(ix, iy + 1)) segs.push({ a: { x: x1, y: y1 }, b: { x: x0, y: y1 } }); // north
        if (!nb(ix - 1, iy)) segs.push({ a: { x: x0, y: y1 }, b: { x: x0, y: y0 } }); // west
      }
      if (!segs.length) continue;
      // Chain into loops: map start-point -> segment indices, walk greedily
      // in insertion order (deterministic; cellsIn iteration is stable).
      const byStart = new Map<string, number[]>();
      segs.forEach((s, si) => {
        const kk = key(s.a);
        const arr = byStart.get(kk);
        if (arr) arr.push(si); else byStart.set(kk, [si]);
      });
      const used = new Array<boolean>(segs.length).fill(false);
      const loops: Pt[][] = [];
      for (let si = 0; si < segs.length; si++) {
        if (used[si]) continue;
        const loop: Pt[] = [segs[si].a];
        let cur = si;
        let guard = 0;
        while (guard++ <= segs.length) {
          used[cur] = true;
          const end = segs[cur].b;
          loop.push(end);
          const cands = byStart.get(key(end)) ?? [];
          let next = -1;
          for (const c of cands) if (!used[c]) { next = c; break; }
          if (next < 0) break;
          cur = next;
        }
        // Closed loop when it returns to its start; drop degenerate stubs.
        if (loop.length >= 4 && key(loop[0]) === key(loop[loop.length - 1])) {
          loop.pop();
          // Merge collinear runs to keep the DXF light.
          const out: Pt[] = [];
          for (let i2 = 0; i2 < loop.length; i2++) {
            const a = out.length >= 2 ? out[out.length - 2] : null;
            const b = out.length >= 1 ? out[out.length - 1] : null;
            const c = loop[i2];
            if (a && b && ((a.x === b.x && b.x === c.x) || (a.y === b.y && b.y === c.y))) {
              out[out.length - 1] = c;
            } else {
              out.push(c);
            }
          }
          if (out.length >= 4) loops.push(out);
        }
      }
      if (loops.length) {
        subs.push({ dischargeIdx: k, areaSqFt: dischargeAreaSqFt[k], loops });
      }
    }
    if (subs.length) model.subcatchments = subs;
  }

  // -------------------------------------------------------------------------
  // Detention-basin screening (opt-in): allowable release = pre-development
  // peak; required storage by the modified rational method (duration sweep
  // over the IDF) or a triangle approximation with a manual intensity.
  if (inputs.detention) {
    const totalSqFt = dischargeAreaSqFt.reduce((s, v) => s + v, 0);
    const totalAcres = totalSqFt / SQFT_PER_ACRE;
    const cPost = useWeightedC && totalSqFt > 0
      ? dischargeCSum.reduce((s, v) => s + v, 0) / totalSqFt
      : inputs.runoffC;
    const tcSite = discharges.reduce((m, d) => Math.max(m, d.tcMin), 5);
    const iAtTc = idf ? idfIntensityAt(idf, inputs.stormAriYears, tcSite) : inputs.rainfallIntensityInHr;
    const postPeakCfs = cPost * iAtTc * totalAcres;
    const prePeakCfs = inputs.preDevC * iAtTc * totalAcres;
    let requiredCf = 0;
    let method: string;
    if (idf) {
      // Modified rational: V(D) = C·i(D)·A·D − Qallow·D, maximized over the
      // IDF durations (plus the site Tc itself).
      const durations = [...idf.durationsMin.filter(d => d >= 5 && d <= 1440), tcSite];
      for (const D of durations) {
        const iD = idfIntensityAt(idf, inputs.stormAriYears, D);
        const v = (cPost * iD * totalAcres - prePeakCfs) * D * 60;
        if (v > requiredCf) requiredCf = v;
      }
      method = `modified rational, ${inputs.stormAriYears}-yr Atlas 14 IDF duration sweep`;
    } else {
      requiredCf = Math.max(0, postPeakCfs - prePeakCfs) * tcSite * 60 * 1.5;
      method = 'rational triangle approximation (no IDF — fetch NOAA Atlas 14 for a duration sweep)';
    }
    const depth = inputs.basinDepthFt;
    const zB = 3; // interior side slopes 3H:1V
    // Square basin: grow the top width until the prismoid holds requiredCf.
    const volumeOf = (topW: number): number => {
      const bw = Math.max(0, topW - 2 * zB * depth);
      return depth * ((topW * topW + bw * bw + topW * bw) / 3); // prismoidal
    };
    let topW = 2 * zB * depth + 4;
    while (requiredCf > 0 && volumeOf(topW) < requiredCf && topW < 2000) topW += 2;
    const bottomW = Math.max(0, topW - 2 * zB * depth);
    const basin: DetentionBasin = {
      prePeakCfs, postPeakCfs, requiredCf, method,
      depthFt: depth, topWFt: topW, bottomWFt: bottomW,
      providedCf: volumeOf(topW),
      placed: false,
    };
    if (requiredCf > 0) {
      // Placement: outside the graded area near the lowest discharge, on the
      // parcel. Try 8 compass directions; first candidate whose footprint is
      // inside the parcel (when known) and fully outside the daylight region.
      let low = 0;
      for (let k2 = 1; k2 < discharges.length; k2++) {
        if (discharges[k2].elevFt < discharges[low].elevFt) low = k2;
      }
      const dp = discharges[low].p;
      const half = topW / 2;
      const R = half + 20;
      const dirs: Pt[] = [
        { x: 1, y: 0 }, { x: 0.7071, y: 0.7071 }, { x: 0, y: 1 }, { x: -0.7071, y: 0.7071 },
        { x: -1, y: 0 }, { x: -0.7071, y: -0.7071 }, { x: 0, y: -1 }, { x: 0.7071, y: -0.7071 },
      ];
      // Prefer the direction pointing away from the region centroid.
      const cxr = region.reduce((s, p) => s + p.x, 0) / region.length;
      const cyr = region.reduce((s, p) => s + p.y, 0) / region.length;
      const away = Math.atan2(dp.y - cyr, dp.x - cxr);
      dirs.sort((a, b) => {
        const da = Math.abs(Math.atan2(Math.sin(Math.atan2(a.y, a.x) - away), Math.cos(Math.atan2(a.y, a.x) - away)));
        const db = Math.abs(Math.atan2(Math.sin(Math.atan2(b.y, b.x) - away), Math.cos(Math.atan2(b.y, b.x) - away)));
        return da - db;
      });
      for (const dir of dirs) {
        const cxB = dp.x + dir.x * R, cyB = dp.y + dir.y * R;
        const corners: Pt[] = [
          { x: cxB - half, y: cyB - half }, { x: cxB + half, y: cyB - half },
          { x: cxB + half, y: cyB + half }, { x: cxB - half, y: cyB + half },
        ];
        const insideParcel = !surfaces?.parcel || corners.every(p => pointInPolygon(p, surfaces.parcel!));
        const clearOfGrading = corners.every(p => !pointInPolygon(p, region)) &&
          !pointInPolygon({ x: cxB, y: cyB }, region);
        if (insideParcel && clearOfGrading) {
          basin.rect = { x0: cxB - half, y0: cyB - half, x1: cxB + half, y1: cyB + half };
          basin.placed = true;
          break;
        }
      }
      if (!basin.placed) {
        warnings.push(
          `Detention basin (${Math.round(requiredCf).toLocaleString('en-US')} CF required) does not fit near the low ` +
          'discharge point inside the parcel — locate it manually or reduce the developed peak.'
        );
      }
    }
    model.detention = basin;
  }

  // -------------------------------------------------------------------------
  // NRCS/SCS hydrology (opt-in): curve-number runoff + SCS dimensionless
  // unit hydrograph per subcatchment for the 24-hr design storm; the site
  // inflow hydrograph is the ordinate-wise sum (all share dt).
  if (inputs.scsMode) {
    const dtMin = 6;
    let siteOrds: number[] = [];
    discharges.forEach(dp => {
      const hyd = scsStormHydrograph({
        areaAcres: dp.areaAcres,
        cn: inputs.curveNumber,
        rain24In: inputs.rain24In,
        stormType: inputs.stormType,
        tcMin: dp.tcMin,
      }, dtMin);
      dp.scs = {
        cn: inputs.curveNumber,
        runoffIn: hyd.runoffIn,
        peakCfs: hyd.peakCfs,
        peakAtMin: hyd.peakAtMin,
        volumeCf: hyd.volumeCf,
      };
      if (hyd.ordinatesCfs.length > siteOrds.length) {
        const grown = hyd.ordinatesCfs.slice();
        for (let i2 = 0; i2 < siteOrds.length; i2++) grown[i2] += siteOrds[i2];
        siteOrds = grown;
      } else {
        for (let i2 = 0; i2 < hyd.ordinatesCfs.length; i2++) siteOrds[i2] += hyd.ordinatesCfs[i2];
      }
    });
    const totalAcres = dischargeAreaSqFt.reduce((s, v) => s + v, 0) / SQFT_PER_ACRE;
    const tcSite = discharges.reduce((m, d) => Math.max(m, d.tcMin), 5);
    let sitePeak = 0, sitePeakAt = 0, siteVol = 0;
    for (let i2 = 0; i2 < siteOrds.length; i2++) {
      if (siteOrds[i2] > sitePeak) { sitePeak = siteOrds[i2]; sitePeakAt = i2 * dtMin; }
      siteVol += siteOrds[i2] * dtMin * 60;
    }
    const runoffIn = scsRunoffIn(inputs.rain24In, inputs.curveNumber);
    const pre = scsStormHydrograph({
      areaAcres: totalAcres,
      cn: inputs.preDevCn,
      rain24In: inputs.rain24In,
      stormType: inputs.stormType,
      tcMin: tcSite,
    }, dtMin);
    const siteHyd: Hydrograph = {
      dtMin,
      ordinatesCfs: siteOrds,
      peakCfs: sitePeak,
      peakAtMin: sitePeakAt,
      volumeCf: siteVol,
      runoffIn,
    };
    model.scs = {
      stormType: inputs.stormType,
      rain24In: inputs.rain24In,
      cn: inputs.curveNumber,
      preDevCn: inputs.preDevCn,
      runoffIn,
      preRunoffIn: pre.runoffIn,
      sitePeakCfs: sitePeak,
      prePeakCfs: pre.peakCfs,
      hydrograph: siteHyd,
    };

    // ---------------------------------------------------------------------
    // Routed detention design (opt-in, needs the SCS inflow hydrograph):
    // stage–storage from the basin prismoid, two-stage outlet auto-sized so
    // the routed peak ≤ the pre-development peak, level-pool routing.
    if (inputs.routedDetention && sitePeak > 0) {
      const allowable = Math.max(pre.peakCfs, 0.1);
      const depth = inputs.basinDepthFt;
      const zB = 3;
      // Initial bottom width from the screening storage estimate at the
      // stage the pond may actually use (crest = depth − freeboard).
      const estCf = estimateRequiredStorageCf(siteHyd, allowable);
      const usableDepth = Math.max(0.5, depth - Math.max(0.5, inputs.freeboardFt));
      const aspect = inputs.basinAspect;
      let bw0 = 10;
      while (bw0 < 2000 &&
        basinStorageCf(
          aspect > 1
            ? { bottomWFt: bw0, sideSlopeH: zB, depthFt: usableDepth, aspect }
            : { bottomWFt: bw0, sideSlopeH: zB, depthFt: usableDepth },
          usableDepth,
        ) < estCf) {
        bw0 += 5;
      }
      const geo0: BasinGeometry = aspect > 1
        ? { bottomWFt: bw0, sideSlopeH: zB, depthFt: depth, aspect }
        : { bottomWFt: bw0, sideSlopeH: zB, depthFt: depth };
      const riser = inputs.riserDiaIn > 0
        ? { diaIn: inputs.riserDiaIn, crestFt: inputs.riserCrestFt }
        : undefined;
      const design = designDetentionOutlet(
        siteHyd, allowable, geo0,
        Math.max(0.5, inputs.freeboardFt),
        riser,
      );
      const geo = design.geo;
      const rows: Array<{ stageFt: number; storageCf: number; outflowCfs: number }> = [];
      const nRows = 8;
      for (let r2 = 0; r2 <= nRows; r2++) {
        const stageFt = (depth * r2) / nRows;
        rows.push({
          stageFt,
          storageCf: basinStorageCf(geo, stageFt),
          outflowCfs: outletDischargeCfs(design.outlet, stageFt),
        });
      }
      model.routing = {
        bottomWFt: geo.bottomWFt,
        topWFt: geo.bottomWFt + 2 * zB * depth,
        depthFt: depth,
        sideSlopeH: zB,
        orificeDiaIn: design.outlet.orificeDiaIn,
        weirCrestFt: design.outlet.weirCrestFt,
        weirLengthFt: design.outlet.weirLengthFt,
        ...(aspect > 1 ? {
          aspectRatio: aspect,
          bottomLFt: geo.bottomWFt * aspect,
          topLFt: geo.bottomWFt * aspect + 2 * zB * depth,
        } : {}),
        ...(design.outlet.riserDiaIn && design.outlet.riserDiaIn > 0 ? {
          riserDiaIn: design.outlet.riserDiaIn,
          riserCrestFt: design.outlet.riserCrestFt ?? 0,
        } : {}),
        peakInflowCfs: design.routing.peakInflowCfs,
        peakOutflowCfs: design.routing.peakOutflowCfs,
        allowableCfs: allowable,
        maxStageFt: design.routing.maxStageFt,
        maxStorageCf: design.routing.maxStorageCf,
        freeboardFt: design.freeboardFt,
        drawdownHr: design.routing.drawdownHr,
        outflowCfs: design.routing.outflow,
        stageTraceFt: design.routing.stage,
        meetsRelease: design.meetsRelease,
        grownBasin: design.grownBasin,
        stageStorage: rows,
      };
      if (!design.meetsRelease) {
        warnings.push(
          'Routed detention: even the smallest orifice cannot hold the release to the pre-development peak — ' +
          'deepen the basin or reduce the developed runoff.'
        );
      }
      if (design.routing.overtopped) {
        warnings.push('Routed detention: the basin overtops at the design storm — enlarge the pond.');
      }
      if (design.routing.drawdownHr > 72) {
        warnings.push(
          `Routed detention: drawdown ${design.routing.drawdownHr.toFixed(0)} hr exceeds the 72-hr guideline — ` +
          'upsize the low-flow orifice.'
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // Culverts where perimeter swales cross access roads (one per swale ×
  // road rect, at the crossing midpoint).
  if (surfaces && surfaces.roads.length) {
    const culverts: CulvertSpec[] = [];
    const seen = new Set<string>();
    swales.forEach((sw, swIdx) => {
      const q = discharges[sw.dischargeIdx]?.qCfs ?? 0;
      if (!(q > 0)) return;
      surfaces.roads.forEach((road, rIdx) => {
        const dedup = `${swIdx}|${rIdx}`;
        if (seen.has(dedup)) return;
        for (let i2 = 0; i2 + 1 < sw.pts.length; i2++) {
          const hit = segmentRectCrossing(sw.pts[i2], sw.pts[i2 + 1], road);
          if (!hit) continue;
          const slope = Math.max(inputs.swaleGradePct, 0.05) / 100;
          const sized = culvertInletControl(q, slope);
          const spec: CulvertSpec = {
            p: hit,
            qCfs: q,
            diaIn: sized.diaIn,
            hwOverD: sized.hwOverD,
            lengthFt: road.width + 8,
            dischargeIdx: sw.dischargeIdx,
          };
          // HDS-5 outlet-control check (opt-in): entrance + friction + exit
          // losses against the tailwater; the larger headwater controls.
          if (inputs.culvertOutlet) {
            const oc = hdsOutletControl({
              qCfs: q,
              diaIn: sized.diaIn,
              lengthFt: spec.lengthFt,
              slopeFtFt: slope,
              tailwaterFt: inputs.tailwaterFt,
            });
            const hwInletFt = sized.hwOverD * (sized.diaIn / 12);
            spec.outlet = {
              hwInletFt,
              hwOutletFt: oc.hwFt,
              tailwaterFt: inputs.tailwaterFt,
              criticalDepthFt: oc.criticalDepthFt,
              lossesFt: oc.lossesFt,
              controlling: oc.hwFt > hwInletFt ? 'outlet' : 'inlet',
            };
            if (oc.hwFt > 1.5 * (sized.diaIn / 12) && oc.hwFt > hwInletFt) {
              warnings.push(
                `Culvert at the DP-${sw.dischargeIdx + 1} crossing is OUTLET-controlled with HW ` +
                `${oc.hwFt.toFixed(1)} ft (> 1.5D) — check the tailwater or upsize the barrel.`
              );
            }
          }
          culverts.push(spec);
          if (sized.hwOverD > 1.5) {
            warnings.push(
              `Culvert at the DP-${sw.dischargeIdx + 1} swale road crossing exceeds HW/D 1.5 even at ` +
              `${sized.diaIn}" — split the flow or use a box culvert.`
            );
          }
          seen.add(dedup);
          break;
        }
      });
    });
    if (culverts.length) {
      culverts.sort((a, b) => (a.p.x - b.p.x) || (a.p.y - b.p.y));
      model.culverts = culverts;
    }
  }

  return model;
}
