import { create } from 'zustand';
import { Pt, SiteBoundary, SiteDesign, SiteArea, SiteAreaEdits, SubstationTakeoff, TakeoffDirection, TAKEOFF_DIRECTIONS, RoadCut } from '../nextera/types';
import { CLEARANCES, CONFIGURATIONS, DEFAULT_CONFIGURATION_ID, DEFAULT_CONTAINERS_PER_PCS, LEGACY_CONTAINERS_PER_PCS, LG_JF2, getConfiguration, specForKind } from '../nextera/catalog';
import { analyzeReferenceDrawing, classifyTraceName, traceKindHeight, fitRectPose, roadStripsFromOutline, roadStripsFromOpenLines, isClosedPolylineRun, tracedApronKeepsPavement, type TracePlan, type TraceUnknown, type TraceEquipKind } from '../nextera/referenceTrace';

// Tag choices for the scene bulk-tag tool: any traceable equipment kind, a
// normal drawn road, or a wide (entrance-width) road.
export type BulkTagKind = TraceEquipKind | 'road' | 'wideRoad';
import { generateSiteDesign, RoadMode, RingMode, LayoutConstraints, ArrangementStrategy, GateEdge, GATE_ENTRANCE_ROAD_ID, SURFACING_DEPTH_IN_DEFAULT, fencePolygonFor, fencePolygonForLayout, isTracedBessYard, computeRowAlignOffsets, computeIslandAlignOffset, computeIslandMirrorOffset, computeCompactShifts, computePlacedIslandCompactDelta, validateRowShift, RowAlignMode, DEFAULT_ISLAND_AUG_UNITS, MAX_ISLAND_AUG_UNITS, ISLAND_PCS_PER_SIDE, PAIR_INNER_GAP_FT, A3_GAP_FT, PerimeterBandMode, FencePlacementMode, normalizeQuarterTurns, snapPlacementCenter, placedIslandPairs, PLACEMENT_SNAP_DEFAULT_FT, isManualEquipmentType, isManualEquipmentId, manualEquipmentAngle, isManualEquipmentSpec, MANUAL_EQUIPMENT_CATALOG, tracedRoadFingerprint, tracedRoadFingerprintMatch, equipmentForRouting, type PlacedIslandKind, type PlacedIslandSpec, type PlacedEquipmentSpec, type ManualEquipmentSpec, type TracedEquipmentSpec, type ManualEquipmentType } from '../nextera/layoutEngine';

// Re-export the traced-road fingerprint helpers at their historical home:
// the tombstone flow was built here, and external callers (tests) import
// them from the store. The definitions moved into layoutEngine so the roads
// builder can match pave-as-drawn overrides without a circular import.
export { tracedRoadFingerprint, tracedRoadFingerprintMatch };
import type { DcRoutingMode } from '../nextera/cableRouting';
import { SurfacingMode } from '../nextera/types';
import { OptimizeParams } from '../nextera/optimizer';
import { generateDesignInWorker, workerAvailable, SupersededError, cancelChannel } from '../nextera/designWorkerClient';
import { parseKmlText, parseKmlAreas, parseKmlDrawing, inferAreaKind, extractKmlText, listKmlBoundaryOptions, BoundaryOption, ImportedDrawing, pointInPolygon as kmzPointInPolygon } from '../nextera/kmz';
import { emptyAreaDesign, substationCollectionMap } from '../nextera/siteAreas';
import { saveDrawing, loadDrawing } from '../drawingStore';
import {
  effectiveTakeoffs,
  resolveTakeoffs,
  foreignFences,
  takeoffRejectReason,
  takeoffWarnings,
  TAKEOFF_WARNING_MARKERS,
  TAKEOFF_REJECT_PREFIX,
  TAKEOFF_MIN_SPACING_FT,
  snapTakeoffDirection,
} from '../nextera/substationTakeoffs';
import { generateSubstationYard } from '../nextera/substationYard';
import { SatelliteImage, fetchSatelliteImage, satelliteCoverageBboxFor } from '../nextera/satellite';

// Module-level in-flight satellite fetch, shared across concurrent callers
// (e.g. the 3D toggle and a PDF export racing) so only one request runs.
//
// Keyed by SITE EPOCH, never by the boundary object's identity. Importing a
// multi-area site swaps the boundary object mid-flight (applyBoundary takes a
// renamed copy, then regenerateAreas re-seats the original), so an identity
// guard silently discards a result that already arrived and strands the
// status on 'loading' forever. The epoch only changes when the site really
// changes, so completion is matched against the site, not an object.
let satelliteInFlight: { epoch: number; promise: Promise<SatelliteImage | null> } | null = null;
let satelliteEpoch = 0;
/** Invalidate any in-flight imagery: the site itself changed. */
const bumpSatelliteEpoch = () => { satelliteEpoch++; satelliteInFlight = null; };
import { ElevationGrid, fetchElevationGrid, terrainCoverageBbox, fillNoData } from '../nextera/terrain';
import { boundaryForYardRotation } from '../nextera/gradingOptimizer';

// Module-level in-flight elevation fetch (same dedupe pattern as satellite).
let terrainInFlight: { boundary: unknown; promise: Promise<ElevationGrid | null> } | null = null;
import { YardTextureSetId, DEFAULT_TEXTURE_SET_ID, isYardTextureSetId, getYardTextureSet } from '../textureSets';
import { sanitizePcsColor, GE_PCS_GREEN } from '../pcsRecolor';
import {
  FeederCircuit,
  ConductorSize,
  FeederConductorSize,
  ConductorMaterial,
  FeederRoutingMode,
  generateFeeders,
  generateAuxFeeder,
  feederRouteKey,
  feederCorridorInfo,
  feederCorridorRejectReason,
  MAX_INVERTERS_PER_FEEDER,
  FEEDER_CONDUCTOR_SIZES,
} from '../nextera/feeders';
import { feederDisplayName } from '../nextera/feederNaming';
import { gateApronKeepouts } from '../nextera/feederKeepouts';
import { runRoutingGates, ROUTING_GATE_PREFIX, type RoutingGateResult } from '../nextera/routingGates';
import type { FeederRoutingParams } from '../nextera/feederOptimizer';
import { applyReferenceLabels } from '../nextera/labels';
import type { TourOptions } from '../cinematicTour';
import { Ieee80Inputs, DEFAULT_IEEE80_INPUTS, sanitizeIeee80Inputs } from '../nextera/ieee80';
import { ShortCircuitInputs, DEFAULT_SC_INPUTS, sanitizeScInputs } from '../nextera/shortCircuit';
import { ProtectionInputs, DEFAULT_PROTECTION_INPUTS, sanitizeProtectionInputs } from '../nextera/protection';
import { EnergySimInputs, DEFAULT_ENERGY_SIM_INPUTS, sanitizeEnergySimInputs } from '../nextera/energySim';
import { GradingInputs, DEFAULT_GRADING_INPUTS, sanitizeGradingInputs, GradingZone, sanitizeGradingZones, gradingZonesRejectReason, gradingZoneInsideFence } from '../nextera/gradingSurface';
import { AreaZone, sanitizeAreaZones, areaZonesRejectReason } from '../nextera/areaZones';
import { EarthworkRates, DEFAULT_EARTHWORK_RATES, sanitizeEarthworkRates } from '../nextera/earthworkCost';
import { DrainageInputs, DEFAULT_DRAINAGE_INPUTS, sanitizeDrainageInputs } from '../nextera/drainage';
import { Atlas14Idf, sanitizeAtlas14Idf } from '../nextera/rainfall';
import { LgiaInputs, DEFAULT_LGIA_INPUTS, sanitizeLgiaInputs } from '../nextera/lgiaDataSheet';
import { DEFAULT_PRELIM_REV } from '../nextera/revisionScheme';
import { defaultProjectDisplayName } from '../nextera/projectName';
import {
  DrawingVisibilityProfile,
  DEFAULT_DRAWING_VISIBILITY,
  sanitizeDrawingVisibilityProfile,
  drawingVisibilityEquals,
  drawingVisibilityAllOn,
} from '../nextera/drawingVisibility';

export interface TitleBlockInfo {
  projectName: string;
  location: string;
  drafter: string;
  revision: string;
  date: string;
  // Client (NEER) drawing number shown in the 10% banner strip; banner cell
  // renders blank when empty (no invented defaults).
  neerDwgName: string;
}

export const defaultTitleBlock = (): TitleBlockInfo => ({
  projectName: '',
  location: '',
  drafter: '',
  revision: DEFAULT_PRELIM_REV,
  date: new Date().toLocaleDateString(),
  neerDwgName: '',
});

// One undo/redo step: every drafter-owned design input a single action can
// change, plus a human-readable label describing that action. The generated
// design itself is always derivable (regenerate), so snapshots only hold
// references to the immutable input objects — structural sharing keeps 50
// steps cheap even on very large sites.
export interface HistorySnap {
  label: string;
  at: number; // Date.now() when recorded (coalescing window)
  coalesceKey?: string; // consecutive same-key edits collapse into one step
  // Multi-area sites only: every area's edit record at snapshot time, so an
  // action that touched OTHER areas' edits (e.g. auto-fill distributing
  // traced gear across footprints) undoes across all of them. Absent on
  // single-area snapshots and never restored unless an area's edits differ.
  areaEdits?: Record<string, SiteAreaEdits | undefined>;
  configId: string;
  targetMW: number;
  targetMWh: number;
  hotClimate: boolean;
  containersPerPcs: number;
  roadMode: RoadMode;
  // false = never auto-wrap access roads around hand-placed/moved equipment.
  autoRoadWrap: boolean;
  ringMode: RingMode;
  // Perimeter band edge: 'standard' = 10 ft inset from fence (default),
  // 'flush' = outer road edge runs along the fence line.
  // Optional — snapshots that predate this restore to 'standard'.
  perimeterBand?: PerimeterBandMode;
  // Where the security fence is drawn: 'inset' (default) = the typical
  // lot-line setback, 'property-line' = on the imported outer boundary.
  // Optional — snapshots that predate this restore to 'inset'.
  fencePlacement?: FencePlacementMode;
  laydownPct: number;
  augmentPct: number;
  futurePhaseUnits: number;
  surfacingMode: SurfacingMode;
  surfacingDepthIn: number;
  deadSpaceTrim: boolean;
  dcRouting: DcRoutingMode;
  // MV home-run routing default. Optional — snapshots that predate the
  // feature restore to 'orthogonal' (the always-was 90° corridor comb).
  feederRoutingMode?: FeederRoutingMode;
  textureSetId: YardTextureSetId;
  // GE PCS exterior recolor. Optional — snapshots that predate the picker
  // restore to null (factory look).
  gePcsColor?: string | null;
  arrangement: ArrangementStrategy;
  // Whether `arrangement` is a value the DRAFTER selected rather than the
  // untouched 'sw' default. Optional — snapshots that predate the flag
  // restore as "not explicitly chosen".
  arrangementExplicit?: boolean;
  latticeShift: Pt | null;
  gateEdge: GateEdge | null;
  layoutEdits: LayoutConstraints;
  titleBlock: TitleBlockInfo;
  substation: Pt | null;
  // Substation MV take-offs (multi-area). Optional — snapshots that predate
  // the feature leave the current take-offs untouched on restore, and `null`
  // is a real recorded value ("never edited", use the automatic ones).
  takeoffs?: SubstationTakeoff[] | null;
  feederAssignments: Record<string, number>;
  feederSizes: Record<number, FeederConductorSize>;
  feederMaterial: ConductorMaterial;
  maxPcsPerFeeder: number;
  // Grading-optimized yard rotation (degrees). Optional — snapshots that
  // predate the feature restore to 0° (the always-was default pose).
  yardRotationDeg?: number;
  // Drafter-drawn area zones. Optional — snapshots that predate the feature
  // leave the current zones untouched on restore.
  areaZones?: AreaZone[];
  // ECI legend symbol style. Undoable because it changes exported drawing
  // content (DXF/PDF/CAD legend glyphs), like gePcsColor/textureSetId.
  // Optional — snapshots that predate the toggle leave the current value
  // untouched on restore.
  eciLegend?: boolean;
  // Feeder & NFPA annotation text visibility. Undoable for the same reason
  // as eciLegend: it changes exported drawing content (CAD/DXF/PDF plan
  // callouts). Optional — older snapshots leave the current value untouched.
  showFeederNfpaText?: boolean;
  // Generated-drawing subsystem visibility. Optional so legacy history
  // entries restore to the historical all-visible drawing.
  drawingVisibility?: DrawingVisibilityProfile;
}
const HISTORY_LIMIT = 50;
// Rapid same-control edits (typing a number, dragging a slider) within this
// window collapse into one undo step so history stays readable.
const COALESCE_MS = 1500;

// Capture the current design inputs by reference (no deep copy).
const snapOf = (s: DesignState, label: string, coalesceKey?: string): HistorySnap => ({
  label,
  at: Date.now(),
  coalesceKey,
  ...(s.siteAreas.length > 1
    ? { areaEdits: Object.fromEntries(s.siteAreas.map(a => [a.id, a.edits])) }
    : {}),
  configId: s.configId,
  targetMW: s.targetMW,
  targetMWh: s.targetMWh,
  hotClimate: s.hotClimate,
  containersPerPcs: s.containersPerPcs,
  roadMode: s.roadMode,
  autoRoadWrap: s.autoRoadWrap,
  ringMode: s.ringMode,
  perimeterBand: s.perimeterBand,
  fencePlacement: s.fencePlacement,
  laydownPct: s.laydownPct,
  augmentPct: s.augmentPct,
  futurePhaseUnits: s.futurePhaseUnits,
  surfacingMode: s.surfacingMode,
  surfacingDepthIn: s.surfacingDepthIn,
  deadSpaceTrim: s.deadSpaceTrim,
  dcRouting: s.dcRouting,
  feederRoutingMode: s.feederRoutingMode,
  textureSetId: s.textureSetId,
  gePcsColor: s.gePcsColor,
  arrangement: s.arrangement,
  arrangementExplicit: s.arrangementExplicit,
  latticeShift: s.latticeShift,
  gateEdge: s.gateEdge,
  layoutEdits: s.layoutEdits,
  titleBlock: s.titleBlock,
  substation: s.substation,
  takeoffs: s.takeoffs,
  feederAssignments: s.feederAssignments,
  feederSizes: s.feederSizes,
  feederMaterial: s.feederMaterial,
  maxPcsPerFeeder: s.maxPcsPerFeeder,
  yardRotationDeg: s.yardRotationDeg,
  areaZones: s.areaZones,
  eciLegend: s.eciLegend,
  showFeederNfpaText: s.showFeederNfpaText,
  drawingVisibility: s.drawingVisibility,
});

// Valid drafter-selectable feeder caps. Anything else in a saved session or
// project file falls back to the default cap (the hard 6-PCS limit) instead
// of rejecting the whole file — stale/hand-edited saves never block loading.
// Yard rotation from an untrusted save: finite number normalized into
// [0, 180); anything else falls back to 0° (the unrotated default) instead
// of rejecting the file. 0 stays exactly 0 so the identity path is exact.
const sanitizeYardRotation = (v: unknown): number => {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0;
  const d = ((v % 180) + 180) % 180;
  return Number.isFinite(d) ? d : 0;
};

// Future-phase augmentation units from an untrusted save: whole number in
// [0, 50]; anything else falls back to 0 instead of rejecting the file.
const sanitizeFuturePhaseUnits = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(50, Math.max(0, Math.floor(v))) : 0;

// The feeder cap is FIXED at the reference standard: 7 built PCS per feeder
// (+2 reserved future = 9 total). Legacy sessions/projects saved when the
// cap was a 5/6/7 choice migrate silently to the fixed standard.
const sanitizeFeederCap = (_v: unknown): number => MAX_INVERTERS_PER_FEEDER;

// A substation point restored from an autosave or project file must have
// finite coordinates: JSON round-trips NaN to null, and hand-edited files
// can carry anything. A non-finite point would propagate NaN through every
// feeder route into scene geometry, so it falls back to "no substation".
const sanitizeSubstation = (v: unknown): Pt | null => {
  if (!v || typeof v !== 'object') return null;
  const p = v as { x?: unknown; y?: unknown };
  return typeof p.x === 'number' && Number.isFinite(p.x) &&
    typeof p.y === 'number' && Number.isFinite(p.y)
    ? { x: p.x, y: p.y }
    : null;
};

// Substation take-offs restored from an autosave or project file are
// untrusted, exactly like the single substation point above. Every entry is
// validated independently: a malformed one is dropped rather than rejecting
// the file, and a non-finite coordinate would poison every route with NaN.
// Duplicate ids are dropped so an edit can never address two positions.
const sanitizeTakeoffs = (v: unknown): SubstationTakeoff[] | undefined => {
  if (!Array.isArray(v)) return undefined;
  const out: SubstationTakeoff[] = [];
  const seen = new Set<string>();
  for (const raw of v) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const t = raw as Record<string, unknown>;
    if (typeof t.id !== 'string' || !t.id || seen.has(t.id)) continue;
    if (typeof t.x !== 'number' || !Number.isFinite(t.x)) continue;
    if (typeof t.y !== 'number' || !Number.isFinite(t.y)) continue;
    if (typeof t.dir !== 'string' ||
        !(TAKEOFF_DIRECTIONS as string[]).includes(t.dir)) continue;
    out.push({
      id: t.id,
      x: t.x,
      y: t.y,
      dir: t.dir as TakeoffDirection,
      // An unknown/absent served area is a real state (an unaimed take-off),
      // reported by takeoffWarnings rather than silently guessed.
      servesAreaId: typeof t.servesAreaId === 'string' && t.servesAreaId ? t.servesAreaId : null,
    });
    seen.add(t.id);
  }
  // An empty ARRAY is meaningful (the drafter removed every take-off), so it
  // is preserved; only a non-array reverts to the automatic defaults.
  return out;
};

// Feeder maps restored from an autosave or project file are untrusted:
// validateProjectFile only checks they are plain objects, so hand-edited or
// corrupted files can carry NaN/fractional feeder indices or unknown
// conductor sizes into recomputeFeeders. Invalid entries are DROPPED (that
// override falls back to automatic assignment/sizing), matching the
// sanitizeLayoutEdits policy.
export const sanitizeFeederAssignments = (v: unknown): Record<string, number> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const clean: Record<string, number> = {};
  for (const [k, n] of Object.entries(v as Record<string, unknown>)) {
    if (typeof n === 'number' && Number.isInteger(n)) clean[k] = n;
  }
  return clean;
};
export const sanitizeFeederSizes = (v: unknown): Record<number, FeederConductorSize> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const clean: Record<number, FeederConductorSize> = {};
  for (const [k, s] of Object.entries(v as Record<string, unknown>)) {
    if (!Number.isInteger(Number(k))) continue;
    if (typeof s === 'string' && (FEEDER_CONDUCTOR_SIZES as readonly string[]).includes(s)) {
      clean[Number(k)] = s as FeederConductorSize;
    }
  }
  return clean;
};

// Layout edits restored from an autosave or project file are untrusted
// numeric input: JSON round-trips NaN/Infinity to null, and hand-edited
// files can carry anything. A single non-finite coordinate poisons scene
// geometry (NaN bounding spheres, duplicate React keys), so every field is
// deep-validated here — invalid entries are DROPPED (that edit falls back
// to automatic placement) instead of rejecting the whole file.
const finitePt = (v: unknown): v is Pt =>
  !!v && typeof v === 'object' &&
  typeof (v as Pt).x === 'number' && Number.isFinite((v as Pt).x) &&
  typeof (v as Pt).y === 'number' && Number.isFinite((v as Pt).y);
const finiteDxDy = (v: unknown): v is { dx: number; dy: number } =>
  !!v && typeof v === 'object' &&
  typeof (v as any).dx === 'number' && Number.isFinite((v as any).dx) &&
  typeof (v as any).dy === 'number' && Number.isFinite((v as any).dy);
export const sanitizeLayoutEdits = (v: unknown): LayoutConstraints => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  const e = v as Record<string, unknown>;
  const out: LayoutConstraints = {};
  const takeMoveMap = (raw: unknown, intKeys: boolean): Record<string, { dx: number; dy: number }> | null => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const clean: Record<string, { dx: number; dy: number }> = {};
    for (const [k, m] of Object.entries(raw as Record<string, unknown>)) {
      if (intKeys && !Number.isInteger(Number(k))) continue;
      if (finiteDxDy(m)) clean[k] = { dx: m.dx, dy: m.dy };
    }
    return Object.keys(clean).length ? clean : null;
  };
  const rowMoves = takeMoveMap(e.rowMoves, true);
  if (rowMoves) out.rowMoves = rowMoves as Record<number, { dx: number; dy: number }>;
  const blockMoves = takeMoveMap(e.blockMoves, true);
  if (blockMoves) out.blockMoves = blockMoves as Record<number, { dx: number; dy: number }>;
  const equipMoves = takeMoveMap(e.equipMoves, false);
  if (equipMoves) out.equipMoves = equipMoves;
  // Quarter turns (clockwise). Only 1..3 are meaningful; 0/4 mean "automatic
  // orientation" and are dropped so an untouched project stays byte-identical.
  const takeTurnMap = (raw: unknown, intKeys: boolean): Record<string, number> | null => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const clean: Record<string, number> = {};
    for (const [k, t] of Object.entries(raw as Record<string, unknown>)) {
      if (intKeys && !Number.isInteger(Number(k))) continue;
      const turns = normalizeQuarterTurns(t);
      if (turns) clean[k] = turns;
    }
    return Object.keys(clean).length ? clean : null;
  };
  const equipRots = takeTurnMap(e.equipRots, false);
  if (equipRots) out.equipRots = equipRots;
  const blockRots = takeTurnMap(e.blockRots, true);
  if (blockRots) out.blockRots = blockRots as Record<number, number>;
  if (typeof e.trenchX === 'number' && Number.isFinite(e.trenchX)) out.trenchX = e.trenchX;
  if (finitePt(e.laydownPin)) out.laydownPin = { x: e.laydownPin.x, y: e.laydownPin.y };
  {
    const s = e.laydownSize as { length?: unknown; width?: unknown } | null | undefined;
    if (s && typeof s === 'object' &&
        typeof s.length === 'number' && Number.isFinite(s.length) && s.length > 0 &&
        typeof s.width === 'number' && Number.isFinite(s.width) && s.width > 0) {
      out.laydownSize = { length: s.length, width: s.width };
    }
  }
  if (e.augPins && typeof e.augPins === 'object' && !Array.isArray(e.augPins)) {
    const clean: Record<string, Pt> = {};
    for (const [k, p] of Object.entries(e.augPins as Record<string, unknown>)) {
      if (/^(future-blk-\d+|island-aug-\d+-\d+)$/.test(k) && finitePt(p)) clean[k] = { x: p.x, y: p.y };
    }
    if (Object.keys(clean).length) out.augPins = clean;
  }
  if (e.islandAugUnits && typeof e.islandAugUnits === 'object' && !Array.isArray(e.islandAugUnits)) {
    const clean: Record<number, number> = {};
    for (const [k, c] of Object.entries(e.islandAugUnits as Record<string, unknown>)) {
      const n = Number(k);
      // 0 is a meaningful override (disables that island's default zone).
      if (Number.isInteger(n) && n >= 1 && typeof c === 'number' && Number.isFinite(c) && Math.floor(c) >= 0) {
        clean[n] = Math.min(MAX_ISLAND_AUG_UNITS, Math.floor(c));
      }
    }
    if (Object.keys(clean).length) out.islandAugUnits = clean;
  }
  if (e.islandAugEnd && typeof e.islandAugEnd === 'object' && !Array.isArray(e.islandAugEnd)) {
    const clean: Record<string, 'east' | 'west'> = {};
    for (const [k, v] of Object.entries(e.islandAugEnd as Record<string, unknown>)) {
      if (/^(\d+|pisl-\d+)$/.test(k) && (v === 'east' || v === 'west')) clean[k] = v;
    }
    if (Object.keys(clean).length) out.islandAugEnd = clean;
  }
  if (e.islandBlockDeltas && typeof e.islandBlockDeltas === 'object' && !Array.isArray(e.islandBlockDeltas)) {
    const clean: Record<number, number> = {};
    for (const [k, d] of Object.entries(e.islandBlockDeltas as Record<string, unknown>)) {
      const n = Number(k);
      const v = typeof d === 'number' && Number.isFinite(d) ? Math.trunc(d) : 0;
      // Non-zero integer deltas only; keep a sane bound so a corrupt file
      // cannot request an absurd island size.
      if (Number.isInteger(n) && n >= 1 && v !== 0 && Math.abs(v) <= 40) clean[n] = v;
    }
    if (Object.keys(clean).length) out.islandBlockDeltas = clean;
  }
  if (finitePt(e.gatePin)) out.gatePin = { x: e.gatePin.x, y: e.gatePin.y };
  if (e.rowShifts && typeof e.rowShifts === 'object' && !Array.isArray(e.rowShifts)) {
    const clean: Record<number, number> = {};
    for (const [k, dy] of Object.entries(e.rowShifts as Record<string, unknown>)) {
      if (Number.isInteger(Number(k)) && typeof dy === 'number' && Number.isFinite(dy) && dy !== 0) {
        clean[Number(k)] = dy;
      }
    }
    if (Object.keys(clean).length) out.rowShifts = clean;
  }
  if (e.aisleMoves && typeof e.aisleMoves === 'object' && !Array.isArray(e.aisleMoves)) {
    const clean: Record<number, number> = {};
    for (const [k, dy] of Object.entries(e.aisleMoves as Record<string, unknown>)) {
      if (Number.isInteger(Number(k)) && typeof dy === 'number' && Number.isFinite(dy)) {
        clean[Number(k)] = dy;
      }
    }
    if (Object.keys(clean).length) out.aisleMoves = clean;
  }
  if (typeof e.feederCorridor === 'number' && Number.isFinite(e.feederCorridor)) {
    out.feederCorridor = e.feederCorridor;
  }
  if (e.feederRoutes && typeof e.feederRoutes === 'object' && !Array.isArray(e.feederRoutes)) {
    const clean: Record<string, Pt[]> = {};
    for (const [k, v] of Object.entries(e.feederRoutes as Record<string, unknown>)) {
      if (!/^inv-\d+$/.test(k) || !Array.isArray(v)) continue;
      const pts = (v as unknown[]).filter(finitePt).map(p => ({ x: p.x, y: p.y }));
      if (pts.length >= 1) clean[k] = pts;
    }
    if (Object.keys(clean).length) out.feederRoutes = clean;
  }
  if (e.feederModes && typeof e.feederModes === 'object' && !Array.isArray(e.feederModes)) {
    const clean: Record<string, FeederRoutingMode> = {};
    for (const [k, m] of Object.entries(e.feederModes as Record<string, unknown>)) {
      if (/^inv-\d+$/.test(k) && (m === 'orthogonal' || m === 'angled')) clean[k] = m;
    }
    if (Object.keys(clean).length) out.feederModes = clean;
  }
  if (Array.isArray(e.customRoads)) {
    const clean = (e.customRoads as unknown[]).flatMap(r => {
      if (!r || typeof r !== 'object') return [];
      const road = r as { id?: unknown; pts?: unknown; width?: unknown; traced?: unknown; tracedV?: unknown; outline?: unknown; surface?: unknown; entrance?: unknown; gate?: unknown; apron?: unknown };
      if (typeof road.id !== 'string' || !road.id || !Array.isArray(road.pts)) return [];
      const pts = (road.pts as unknown[]).filter(finitePt).map(p => ({ x: p.x, y: p.y }));
      if (pts.length < 2) return [];
      const width = typeof road.width === 'number' && Number.isFinite(road.width)
        && road.width >= 12 && road.width <= 60 ? road.width : undefined;
      // Drawn entrance-flare outline: pavement polygon kept verbatim.
      const outline = Array.isArray(road.outline)
        ? (road.outline as unknown[]).filter(finitePt).map(p => ({ x: p.x, y: p.y }))
        : [];
      // Verbatim closed road outline (yard network / apron / pad).
      const surface = Array.isArray(road.surface)
        ? (road.surface as unknown[]).filter(finitePt).map(p => ({ x: p.x, y: p.y }))
        : [];
      // `traced` marks a road auto-filled from a KMZ reference drawing
      // (reference-wins warn-only gate). Only literal true survives.
      return [{
        id: road.id, pts,
        ...(width !== undefined ? { width } : {}),
        ...(road.traced === true ? { traced: true } : {}),
        // Road-rules version stamp must round-trip or every reload looks
        // stale and re-derives (resurrecting drafter-deleted traced roads).
        ...(road.traced === true && typeof road.tracedV === 'number'
          && Number.isInteger(road.tracedV) && road.tracedV >= 1
          ? { tracedV: road.tracedV } : {}),
        ...(outline.length >= 3 ? { outline } : {}),
        ...(surface.length >= 3 ? { surface } : {}),
        ...(road.entrance === true ? { entrance: true } : {}),
        ...(finitePt(road.gate) ? { gate: { x: road.gate.x, y: road.gate.y } } : {}),
        ...(road.apron === true ? { apron: true } : {}),
      }];
    });
    if (clean.length) out.customRoads = clean;
  }
  if (e.dcRoutingOverrides && typeof e.dcRoutingOverrides === 'object' && !Array.isArray(e.dcRoutingOverrides)) {
    const clean: Record<number, DcRoutingMode> = {};
    for (const [k, m] of Object.entries(e.dcRoutingOverrides as Record<string, unknown>)) {
      const n = Number(k);
      if (Number.isInteger(n) && n >= 1 && (m === 'orthogonal' || m === 'direct')) {
        clean[n] = m;
      }
    }
    if (Object.keys(clean).length) out.dcRoutingOverrides = clean;
  }
  if (Array.isArray(e.placedIslands)) {
    const clean = (e.placedIslands as unknown[]).flatMap(r => {
      if (!r || typeof r !== 'object') return [];
      const it = r as {
        id?: unknown; x?: unknown; y?: unknown;
        vertical?: unknown; angleDeg?: unknown; pairs?: unknown;
      };
      if (typeof it.id !== 'string' || !/^pisl-\d+$/.test(it.id)) return [];
      if (typeof it.x !== 'number' || !Number.isFinite(it.x)) return [];
      if (typeof it.y !== 'number' || !Number.isFinite(it.y)) return [];
      // pairs: deliberate partial island (1 .. full standard). Absent or
      // full-strip values stay absent so existing files round-trip unchanged.
      const pairs = typeof it.pairs === 'number' && Number.isFinite(it.pairs)
        ? Math.min(ISLAND_PCS_PER_SIDE, Math.max(1, Math.trunc(it.pairs)))
        : null;
      // kind 'single' = 1 PCS + 3 BESS; 'single2' = explicit 1 PCS + 2
      // BESS. Anything else is a normal island.
      // `aug` is tri-state and both booleans are preserved verbatim: true and
      // false are the drafter's recorded decision, while ABSENT means the
      // record predates the choice and keeps the historical "with
      // augmentation" behaviour. Only a non-boolean is dropped, so a file
      // saved before the choice existed still round-trips byte-identically.
      const rawKind = (it as { kind?: unknown }).kind;
      const singleKind: PlacedIslandKind | null = rawKind === 'single' || rawKind === 'single2'
        ? rawKind
        : null;
      const single = singleKind !== null;
      const augRaw = (it as { aug?: unknown }).aug;
      // auxGear follows the same tri-state contract as `aug`: true/false is
      // the engineer's recorded decision, ABSENT means the record predates the
      // choice and keeps the historical "island aux cluster included"
      // behaviour, so old files still round-trip byte-identically.
      const auxGearRaw = (it as { auxGear?: unknown }).auxGear;
      // Orientation: read angleDeg first (new format), fall back to vertical
      // (legacy). Always emit angleDeg in canonical form; vertical is dropped.
      const rawAngle = typeof it.angleDeg === 'number' && Number.isFinite(it.angleDeg)
        ? ((it.angleDeg % 360) + 360) % 360
        : (it.vertical === true ? 90 : 0);
      return [{
        id: it.id, x: it.x, y: it.y,
        ...(rawAngle !== 0 ? { angleDeg: rawAngle } : {}),
        ...(!single && pairs !== null && pairs !== ISLAND_PCS_PER_SIDE ? { pairs } : {}),
        ...(singleKind ? { kind: singleKind } : {}),
        ...(typeof augRaw === 'boolean' ? { aug: augRaw } : {}),
        ...(typeof auxGearRaw === 'boolean' ? { auxGear: auxGearRaw } : {}),
      }];
    }).slice(0, 20); // sane cap — a corrupt file cannot request hundreds of islands
    if (clean.length) out.placedIslands = clean;
  }
  if (Array.isArray(e.placedEquipment)) {
    // Single equipment items at exact poses. Two records share this list (see
    // PlacedEquipmentSpec): catalog-driven manual gear, whose identity is a
    // `type` plus an anchor and a quarter-turn, and items whose drawn
    // footprint is already known in feet (KMZ auto-fill trace, gear dropped
    // straight from catalog dimensions). Both round-trip verbatim; a
    // malformed entry is dropped rather than rejecting the whole file.
    const kinds = new Set([
      'bess', 'inverter', 'generator', 'conex', 'manhole', 'auxTransformer', 'auxSwitchgear',
      'auxSwitchPanel', 'fiberPatchPanel', 'fireControlPanel', 'commsCabinet',
    ]);
    const clean = (e.placedEquipment as unknown[]).flatMap(r => {
      if (!r || typeof r !== 'object') return [];
      const it = r as {
        id?: unknown; type?: unknown; kind?: unknown; x?: unknown; y?: unknown;
        angleDeg?: unknown; rotationDeg?: unknown;
        lengthFt?: unknown; widthFt?: unknown; heightFt?: unknown;
        label?: unknown; source?: unknown; traceSourcePose?: unknown;
      };
      if (typeof it.id !== 'string' || !/^peq-\d+$/.test(it.id)) return [];
      if (typeof it.x !== 'number' || !Number.isFinite(it.x)) return [];
      if (typeof it.y !== 'number' || !Number.isFinite(it.y)) return [];
      // Catalog-driven manual record: the type carries the dimensions, so
      // nothing but the pose is stored.
      if (it.type !== undefined) {
        if (!isManualEquipmentType(it.type)) return [];
        // Quarter-turns only; 0 stays absent so an unrotated item round-trips
        // exactly as it was written.
        const a = typeof it.angleDeg === 'number' && Number.isFinite(it.angleDeg)
          ? ((Math.round(it.angleDeg / 90) * 90) % 360 + 360) % 360
          : 0;
        return [{
          id: it.id, type: it.type, x: it.x, y: it.y,
          ...(a !== 0 ? { angleDeg: a } : {}),
        } as PlacedEquipmentSpec];
      }
      // Drawn-dimension record: the pose and size ARE the reference.
      if (typeof it.kind !== 'string' || !kinds.has(it.kind)) return [];
      if (typeof it.lengthFt !== 'number' || !Number.isFinite(it.lengthFt)) return [];
      if (typeof it.widthFt !== 'number' || !Number.isFinite(it.widthFt)) return [];
      const lengthFt = it.lengthFt, widthFt = it.widthFt;
      if (lengthFt <= 0 || widthFt <= 0 || lengthFt > 500 || widthFt > 500) return [];
      const rot = typeof it.rotationDeg === 'number' && Number.isFinite(it.rotationDeg)
        ? ((it.rotationDeg % 360) + 360) % 360 : 0;
      const heightFt = typeof it.heightFt === 'number' && Number.isFinite(it.heightFt)
        && it.heightFt > 0 && it.heightFt <= 60 ? it.heightFt : undefined;
      // Stale-save migration: scans pre-dating the GENERATOR→CONEX
      // classification committed those boxes as kind 'generator' with GEN
      // labels; a restored project must not keep rendering GEN forever.
      // TRACED records only — a manually placed generator is intentional
      // and must round-trip unchanged.
      const isTraceRecord = it.source === 'trace';
      const migratedKind = it.kind === 'generator' && isTraceRecord ? 'conex' : it.kind;
      const migratedLabel = typeof it.label === 'string' && isTraceRecord
        ? it.label.replace(/\bGEN\s+(\d+)$/, 'CONEX $1')
        : it.label;
      const rawSource = it.traceSourcePose;
      const sourcePose = rawSource && typeof rawSource === 'object' ? rawSource as {
        x?: unknown; y?: unknown; rotationDeg?: unknown;
        lengthFt?: unknown; widthFt?: unknown;
      } : null;
      const cleanSourcePose = isTraceRecord && sourcePose &&
        typeof sourcePose.x === 'number' && Number.isFinite(sourcePose.x) &&
        Math.abs(sourcePose.x) <= 1e7 &&
        typeof sourcePose.y === 'number' && Number.isFinite(sourcePose.y) &&
        Math.abs(sourcePose.y) <= 1e7 &&
        typeof sourcePose.rotationDeg === 'number' && Number.isFinite(sourcePose.rotationDeg) &&
        typeof sourcePose.lengthFt === 'number' && Number.isFinite(sourcePose.lengthFt) &&
        typeof sourcePose.widthFt === 'number' && Number.isFinite(sourcePose.widthFt) &&
        sourcePose.lengthFt > 0 && sourcePose.lengthFt <= 500 &&
        sourcePose.widthFt > 0 && sourcePose.widthFt <= 500
        ? {
            x: sourcePose.x,
            y: sourcePose.y,
            rotationDeg: ((sourcePose.rotationDeg % 360) + 360) % 360,
            lengthFt: sourcePose.lengthFt,
            widthFt: sourcePose.widthFt,
          }
        : null;
      return [{
        id: it.id,
        kind: migratedKind as TracedEquipmentSpec['kind'],
        x: it.x, y: it.y,
        ...(rot !== 0 ? { rotationDeg: rot } : {}),
        lengthFt, widthFt,
        ...(heightFt !== undefined ? { heightFt } : {}),
        ...(typeof migratedLabel === 'string' && migratedLabel ? { label: migratedLabel.slice(0, 40) } : {}),
        ...(it.source === 'manual' ? { source: 'manual' as const } : it.source === 'trace' ? { source: 'trace' as const } : {}),
        ...(cleanSourcePose ? { traceSourcePose: cleanSourcePose } : {}),
        ...((it as { augmented?: unknown }).augmented === true ? { augmented: true } : {}),
        ...((it as { future?: unknown }).future === true ? { future: true } : {}),
      } as PlacedEquipmentSpec];
      // Cap sized for full-site KMZ traces (Big Iron: ~1,100 drawn units).
    }).slice(0, 4000);
    if (clean.length) out.placedEquipment = clean;
  }
  {
    const r = e.ringOffsets as Record<string, unknown> | null | undefined;
    if (r && typeof r === 'object' && !Array.isArray(r)) {
      const clean: { n?: number; s?: number; e?: number; w?: number } = {};
      for (const side of ['n', 's', 'e', 'w'] as const) {
        const v = r[side];
        if (typeof v === 'number' && Number.isFinite(v) && v !== 0 && Math.abs(v) <= 10000) clean[side] = v;
      }
      if (Object.keys(clean).length) out.ringOffsets = clean;
    }
  }
  // Sheet-declared nameplate for traced yards: only positive finite numbers
  // survive; a malformed record is dropped (traced units simply fall back to
  // the catalog block rating rather than rejecting the project).
  {
    const tr = e.tracedRatings as Record<string, unknown> | null | undefined;
    if (tr && typeof tr === 'object' && !Array.isArray(tr)) {
      const clean: { mwPerPcs?: number; mwhPerContainer?: number } = {};
      for (const k of ['mwPerPcs', 'mwhPerContainer'] as const) {
        const v = tr[k];
        if (typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 1000) clean[k] = v;
      }
      if (Object.keys(clean).length) out.tracedRatings = clean;
    }
  }
  if (Array.isArray(e.auxFeederWaypoints)) {
    const pts = (e.auxFeederWaypoints as unknown[])
      .filter(finitePt)
      .map(p => ({ x: (p as Pt).x, y: (p as Pt).y }));
    if (pts.length >= 1) out.auxFeederWaypoints = pts;
  }
  if (Array.isArray(e.removedRoads)) {
    const clean = (e.removedRoads as unknown[]).filter(
      (k): k is string => typeof k === 'string' &&
        (/^(aisle|corridor)-\d+$/.test(k) || k === GATE_ENTRANCE_ROAD_ID));
    if (clean.length) out.removedRoads = Array.from(new Set(clean));
  }
  // Geometry tombstones for drafter-deleted TRACED roads (see
  // LayoutConstraints.removedTracedRoads): suppress matching strips when a
  // stale save's heal re-derives the traced set wholesale. Malformed
  // entries drop individually; the list is capped like removeCustomRoad
  // caps it on write.
  if (Array.isArray(e.removedTracedRoads)) {
    const clean = (e.removedTracedRoads as unknown[]).flatMap(t => {
      if (!t || typeof t !== 'object') return [];
      const g = t as { x?: unknown; y?: unknown; len?: unknown };
      return (typeof g.x === 'number' && Number.isFinite(g.x) &&
              typeof g.y === 'number' && Number.isFinite(g.y) &&
              typeof g.len === 'number' && Number.isFinite(g.len) && g.len >= 0)
        ? [{ x: g.x, y: g.y, len: g.len }]
        : [];
    });
    if (clean.length) out.removedTracedRoads = clean.slice(-200);
  }
  // Pave-as-drawn overrides for traced strips the gate-apron rule keeps as
  // linework (see LayoutConstraints.pavedTracedRoads): same fingerprint
  // shape, same untrusted-input policy and cap as the deletion tombstones.
  if (Array.isArray(e.pavedTracedRoads)) {
    const clean = (e.pavedTracedRoads as unknown[]).flatMap(t => {
      if (!t || typeof t !== 'object') return [];
      const g = t as { x?: unknown; y?: unknown; len?: unknown };
      return (typeof g.x === 'number' && Number.isFinite(g.x) &&
              typeof g.y === 'number' && Number.isFinite(g.y) &&
              typeof g.len === 'number' && Number.isFinite(g.len) && g.len >= 0)
        ? [{ x: g.x, y: g.y, len: g.len }]
        : [];
    });
    if (clean.length) out.pavedTracedRoads = clean.slice(-200);
  }
  // Road cuts: deleted road AREAS (see LayoutConstraints.roadCuts). Same
  // untrusted-input policy as every other edit — a malformed cut is dropped
  // (that road simply comes back) rather than rejecting the whole file. A
  // ring needs 3 real points to bound any area at all.
  if (Array.isArray(e.roadCuts)) {
    const clean = (e.roadCuts as unknown[]).flatMap(r => {
      if (!r || typeof r !== 'object') return [];
      const cut = r as { id?: unknown; poly?: unknown; label?: unknown };
      if (typeof cut.id !== 'string' || !cut.id || !Array.isArray(cut.poly)) return [];
      const poly = (cut.poly as unknown[]).filter(finitePt).map(p => ({ x: p.x, y: p.y }));
      if (poly.length < 3) return [];
      return [{
        id: cut.id, poly,
        ...(typeof cut.label === 'string' && cut.label ? { label: cut.label.slice(0, 80) } : {}),
      }];
    }).slice(0, 200); // sane cap — a corrupt file cannot request thousands of cuts
    if (clean.length) out.roadCuts = clean;
  }
  // Drafter deletions. Same untrusted-input policy as every other edit:
  // malformed entries are dropped (that item simply comes back) rather than
  // rejecting the whole project file.
  if (Array.isArray(e.removedBlocks)) {
    const clean = (e.removedBlocks as unknown[])
      .map(v => (typeof v === 'number' ? v : Number(v)))
      .filter(n => Number.isInteger(n) && n >= 1);
    if (clean.length) out.removedBlocks = Array.from(new Set(clean)).sort((a, b) => a - b);
  }
  if (Array.isArray(e.removedEquipment)) {
    const clean = (e.removedEquipment as unknown[]).filter(
      (k): k is string => typeof k === 'string' && /^[A-Za-z][A-Za-z0-9-]*$/.test(k));
    if (clean.length) out.removedEquipment = Array.from(new Set(clean)).sort();
  }
  if (Array.isArray(e.forcedEdits)) {
    const clean = (e.forcedEdits as unknown[]).filter((k): k is string => typeof k === 'string' && k.length > 0);
    if (clean.length) out.forcedEdits = clean;
  }
  if (e.alignIslands === true) out.alignIslands = true;
  return out;
};

// Add or remove an engineer-override key ("row-1", "aisle-2", "block-3",
// "equip-<id>") on the forcedEdits constraint list. Returns undefined when
// the resulting list is empty so cleared overrides do not linger in saves.
const withForcedKey = (list: string[] | undefined, key: string, on: boolean): string[] | undefined => {
  const next = (list ?? []).filter(k => k !== key);
  if (on) next.push(key);
  return next.length ? next : undefined;
};

// Mirrored (QTY3 island) layouts place a block and its twin at the SAME
// footprint center: two block numbers, one physical pad. The engine always
// translates such a pad as a unit, so a stored offset that names only ONE of
// the two ids is a half-recorded edit: a later group move composes each id
// from its own stored offset, the twins land in different move groups, and
// the shared pad gets translated twice (block +0.1 then island +0.1 became
// +0.3 for that pair while its neighbours moved +0.1).
//
// Every write to blockMoves therefore goes through this: whatever the drafter
// selected, both ids of a mirrored pad end up carrying the SAME offset.
const twinGroupOf = (s: DesignState, blockN: number): number[] => {
  const blocks = (s.design?.blockRows ?? []).flatMap(r => r.blocks);
  const self = blocks.find(b => b.n === blockN);
  if (!self) return [blockN];
  const group = blocks
    .filter(b => Math.abs(b.x - self.x) < 0.5 && Math.abs(b.y - self.y) < 0.5)
    .map(b => b.n);
  return group.length ? group : [blockN];
};

// Drafter text-label override: position/height/content delta keyed by the
// label fingerprint (layer|text|roundX|roundY). Defined here (not imported
// from dxfExport) to keep the store free of a heavy module dependency.
export interface TextOverride {
  /** X offset from the generated anchor (layout feet). */
  dx: number;
  /** Y offset from the generated anchor (layout feet). */
  dy: number;
  /** Override text content (absent = keep generated). */
  text?: string;
  /** Override text height in layout feet (absent = keep generated). */
  h?: number;
}

// Extract the engine's specific reason from a "<prefix>: <reason> —
// automatic position kept." warning. Returns null when no warning matches.
const rejectionReason = (warnings: string[] | undefined, prefix: string): string | null => {
  const w = (warnings ?? []).find(x => x.startsWith(prefix));
  if (!w) return null;
  return w
    .slice(prefix.length)
    .replace(/^:\s*/, '')
    .replace(/\s*—\s*automatic position kept\.\s*$/, '')
    .trim();
};

// Restore per-area edit records captured on a multi-area snapshot. Only
// applied when some area's edits actually differ (reference compare) so
// single-area projects and area-untouched undos never pay a full re-lay.
const restoreAreaEdits = (
  set: (partial: Partial<DesignState>) => void,
  get: () => DesignState,
  snap: HistorySnap
): void => {
  if (!snap.areaEdits) return;
  const cur = get().siteAreas;
  const changed = cur.some(a =>
    a.id !== get().activeAreaId && // active area restores through restoreFields
    a.id in snap.areaEdits! && snap.areaEdits![a.id] !== a.edits);
  if (!changed) return;
  set({
    siteAreas: cur.map(a =>
      a.id !== get().activeAreaId && a.id in snap.areaEdits!
        ? { ...a, edits: snap.areaEdits![a.id] }
        : a),
  });
  get().regenerateAreas();
};

// One traced-equipment addition (KMZ auto-fill scan or drafter bulk tag)
// before area routing and id assignment.
export type TraceEquipAdd = {
  kind: TraceEquipKind;
  augmented: boolean;
  // Future build-out ("FUTURE ..." layers): imported/rendered, excluded from
  // built capacity like augmentation reserve.
  future?: boolean;
  pose: { cx: number; cy: number; rotationDeg: number; lengthFt: number; widthFt: number };
  traceSourcePose?: {
    x: number; y: number; rotationDeg: number; lengthFt: number; widthFt: number;
  };
};
export type TraceRoadAdd = {
  pts: Pt[];
  widthFt: number;
  // Drawn gate-entrance flare outline (wide-to-narrow apron), kept verbatim
  // as pavement surface by the layout engine.
  outline?: Pt[];
  // Verbatim closed road outline (yard network / apron / pad): the drawn
  // polygon IS the pavement surface; `pts` is only the representative
  // centerline for picking, labels, and gate-crossing detection.
  surface?: Pt[];
  // Marked at commit time: this road crosses the fence AT THE GATE. The
  // engine keeps its pavement inside the fence plus a disc around `gate`;
  // all other traced roads are clipped to the fence interior.
  entrance?: boolean;
  gate?: Pt;
  // Pavement wholly outside the fence (public-road strips): kept, but
  // clipped to the fence exterior so it can never read as a crossing.
  apron?: boolean;
};

// Client-declared sheet-spec nameplate → per-unit ratings: the declared site
// MW/MWh split evenly across every BUILT traced PCS/container in the given
// edit records, so each area reads its share of the client's own rating
// (e.g. 500 MW / 176 PCS ⇒ a 44-PCS area reads 125 MW) instead of PCS-count
// × the tool's block rating. Shared by the scan-apply commit and the
// stale-project self-heal in regenerateAreas.
export const tracedRatingsFromSpecs = (
  specs: { acRatingMW?: number; storedMWh?: number } | null | undefined,
  records: readonly unknown[],
): { mwPerPcs?: number; mwhPerContainer?: number } | undefined => {
  if (!specs) return undefined;
  let builtPcs = 0, builtCon = 0;
  for (const rec of records) {
    const p = rec as { kind?: unknown; augmented?: unknown; future?: unknown };
    if (p.augmented === true || p.future === true) continue;
    if (p.kind === 'inverter') builtPcs++;
    else if (p.kind === 'bess') builtCon++;
  }
  const r: { mwPerPcs?: number; mwhPerContainer?: number } = {};
  if ((specs.acRatingMW ?? 0) > 0 && builtPcs > 0) r.mwPerPcs = (specs.acRatingMW as number) / builtPcs;
  if ((specs.storedMWh ?? 0) > 0 && builtCon > 0) r.mwhPerContainer = (specs.storedMWh as number) / builtCon;
  return Object.keys(r).length ? r : undefined;
};

// An area's edits carry traced built gear but no sheet-spec nameplate — the
// signature of a project saved before traced ratings existed.
const editsNeedTracedRatings = (e: LayoutConstraints | undefined): boolean =>
  !!e && !e.tracedRatings &&
  (e.placedEquipment ?? []).some(p => {
    const t = p as { source?: unknown; kind?: unknown; augmented?: unknown; future?: unknown };
    return t.source === 'trace' && t.augmented !== true && t.future !== true &&
      (t.kind === 'inverter' || t.kind === 'bess');
  });

// One gate entrance per area (flags): the drawn wide-to-narrow flare when
// the drawing has one, otherwise the widest fence-crossing road. Only
// entrance-flagged roads may keep pavement outside the fence; the layout
// engine clips every other traced road to the fence interior. Wholly-outside
// strips survive ONLY as gate-approach aprons — a strip far from the gate is
// context road the drafter never asked for ("roads only at the gate"), so it
// is dropped (returned lengths feed the commit warning). Mutates flags on
// the kept strips; returns the kept list plus dropped strip lengths.
export const TRACED_GATE_REACH_FT = 120;
export const flagTracedGateRoads = <T extends {
  pts: Pt[]; widthFt?: number; width?: number;
  outline?: Pt[]; surface?: Pt[]; entrance?: boolean; gate?: Pt; apron?: boolean;
}>(rds: T[], fence: Pt[], gateHint?: Pt | null,
   // Pave-as-drawn override fingerprints: a wholly-outside strip that FAILS
   // the gate-apron rule but matches one of these is KEPT as an apron record
   // (instead of dropped), so the render path can pave it under the same
   // override and the wholesale stale-save rebuild re-applies the drafter's
   // decision. Empty/absent = byte-identical behavior.
   pavedTraced?: readonly { x: number; y: number; len: number }[] | null,
  ): { kept: T[]; droppedLens: number[] } => {
  const GATE_REACH_FT = TRACED_GATE_REACH_FT;
  const forcePaved = (r: T): boolean =>
    tracedRoadFingerprintMatch(tracedRoadFingerprint(r.pts), pavedTraced);
  // A verbatim-surface road's fence relationship is defined by its DRAWN
  // polygon, not the representative centerline (a yard network's centerline
  // may never leave the fence while its ring road straddles it at the
  // gate). Walk the surface ring as a closed loop when one is present.
  const traceSegs = (r: T): [Pt, Pt][] => {
    const pts = r.surface?.length ? r.surface : r.pts;
    const segs = r.surface?.length ? pts.length : pts.length - 1;
    const out: [Pt, Pt][] = [];
    for (let i = 1; i <= segs; i++) out.push([pts[i - 1], pts[i % pts.length]]);
    return out;
  };
  // Fence-crossing points of each road's sampled trace.
  const crossingsOf = (r: T): Pt[] => {
    const out: Pt[] = [];
    let prev: Pt | null = null, prevIn = false;
    let first = true;
    for (const [a, b] of traceSegs(r)) {
      const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 5));
      for (let s = first ? 0 : 1; s <= steps; s++) {
        const p = { x: a.x + (b.x - a.x) * s / steps, y: a.y + (b.y - a.y) * s / steps };
        const inside = kmzPointInPolygon(p, fence);
        if (prev && inside !== prevIn) out.push({ x: (p.x + prev.x) / 2, y: (p.y + prev.y) / 2 });
        prev = p; prevIn = inside;
      }
      first = false;
    }
    return out;
  };
  const allOutsideOf = (r: T): boolean => {
    let first = true;
    for (const [a, b] of traceSegs(r)) {
      const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 5));
      for (let s = first ? 0 : 1; s <= steps; s++) {
        const p = { x: a.x + (b.x - a.x) * s / steps, y: a.y + (b.y - a.y) * s / steps };
        if (kmzPointInPolygon(p, fence)) return false;
      }
      first = false;
    }
    return true;
  };
  const infos = rds.map(r => ({ r, crossings: crossingsOf(r), allOutside: allOutsideOf(r) }));
  // Gate location: the point ON THE FENCE nearest the drawn flare (the
  // flare marks the entrance); else the widest crosser's crossing point.
  const nearestOnFence = (p: Pt): Pt => {
    let best = p, bd = Infinity;
    for (let i = 0; i < fence.length; i++) {
      const q0 = fence[i], q1 = fence[(i + 1) % fence.length];
      const dx = q1.x - q0.x, dy = q1.y - q0.y, L2 = dx * dx + dy * dy;
      const t = L2 > 0 ? Math.max(0, Math.min(1, ((p.x - q0.x) * dx + (p.y - q0.y) * dy) / L2)) : 0;
      const q = { x: q0.x + t * dx, y: q0.y + t * dy };
      const d = Math.hypot(p.x - q.x, p.y - q.y);
      if (d < bd) { bd = d; best = q; }
    }
    return best;
  };
  const centroidOf = (pts: Pt[]): Pt => {
    let x = 0, y = 0;
    for (const p of pts) { x += p.x; y += p.y; }
    return { x: x / pts.length, y: y / pts.length };
  };
  let gate: Pt | null = null;
  // Anchor priority: the drawing's own gate tick marks (E-GATE layer), then a
  // drawn flare outline, then the widest fence crosser. SITE ACCESS tapering
  // triangles are annotation arrows — they never reach this list anymore, and
  // without them an area can have NO outline record (Big Iron Area 2), where
  // the widest-crosser fallback pins the gate on the wrong fence.
  if (gateHint) gate = nearestOnFence(gateHint);
  const flare = infos.find(i => i.r.outline?.length);
  if (!gate && flare) gate = nearestOnFence(centroidOf(flare.r.outline!));
  if (!gate) {
    let bw = -1;
    for (const i of infos) {
      const w = i.r.widthFt ?? i.r.width ?? 24;
      if (i.crossings.length && w > bw) { bw = w; gate = i.crossings[0]; }
    }
  }
  const lenOf = (r: T): number => {
    let len = 0;
    for (let k = 1; k < r.pts.length; k++) {
      len += Math.hypot(r.pts[k].x - r.pts[k - 1].x, r.pts[k].y - r.pts[k - 1].y);
    }
    return Math.round(len);
  };
  if (!gate) {
    // No crossing and no flare: a wholly-outside strip that still reaches
    // right up to the fence is a gate-entry approach drawn short of the
    // boundary — keep it and pin the entrance at the nearest fence point.
    // FAR outside strips are off-site context roads — drop them so they
    // never render as scattered pavement away from the yard.
    const kept0: T[] = [];
    const drop0: number[] = [];
    for (const i of infos) {
      if (!i.allOutside) { kept0.push(i.r); continue; }
      let near: Pt | null = null, nd = Infinity;
      for (const p of (i.r.surface?.length ? i.r.surface : i.r.pts)) {
        const q = nearestOnFence(p);
        const d = Math.hypot(p.x - q.x, p.y - q.y);
        if (d < nd) { nd = d; near = q; }
      }
      if (near && nd <= GATE_REACH_FT + 80) {
        i.r.entrance = true;
        i.r.gate = { x: near.x, y: near.y };
        kept0.push(i.r);
      } else if (forcePaved(i.r)) {
        // Drafter force-paved this far-outside strip: keep it as an apron
        // record so the render path paves it (with its override warning).
        i.r.apron = true;
        kept0.push(i.r);
      } else {
        drop0.push(lenOf(i.r));
      }
    }
    return { kept: kept0, droppedLens: drop0 };
  }
  const g = gate;
  const nearGate = (p: Pt, reach: number) => Math.hypot(p.x - g.x, p.y - g.y) <= reach;
  const kept: T[] = [];
  const droppedLens: number[] = [];
  for (const i of infos) {
    // The flare sits wholly outside the fence, up to its own length past
    // the gate — measure its NEAREST drawn vertex against a longer reach.
    const flareAtGate = !!i.r.outline?.length &&
      i.r.outline.some(p => nearGate(p, GATE_REACH_FT + 80));
    const crossesAtGate = i.crossings.some(c => nearGate(c, GATE_REACH_FT));
    if (flareAtGate || crossesAtGate) {
      i.r.entrance = true;
      i.r.gate = { x: g.x, y: g.y };
      kept.push(i.r);
    } else if (i.allOutside) {
      // Wholly outside the fence (public-road pavement): kept as an apron
      // ONLY when it is the gate's approach — the drawn flare ring (most of
      // its perimeter in gate reach) or a short bare stub that TERMINATES
      // at the gate. The old ANY-point-in-reach test kept every strip that
      // merely PASSED the gate (Big Iron Area 4's ~1,460 ft fence-hugging
      // corridor band paved ~36k sqft outside the fence because one
      // endpoint landed ~190 ft from the gate); the approved Area 3
      // standard keeps such corridors as unpaved reference linework. The
      // shared predicate is also enforced render-side for stale saves.
      if (tracedApronKeepsPavement(i.r.pts, i.r.surface, g)) {
        i.r.apron = true;
        kept.push(i.r);
      } else if (forcePaved(i.r)) {
        // Pave-as-drawn override: the drafter confirmed this strip really is
        // on-parcel pavement. Keep it as an apron record — the render path
        // re-proves the predicate, sees the same override match, and paves
        // it with a keep-and-warn override warning instead of linework-only.
        i.r.apron = true;
        kept.push(i.r);
      } else {
        droppedLens.push(lenOf(i.r));
      }
    } else {
      kept.push(i.r);
    }
  }
  return { kept, droppedLens };
};

// One derivation sequence for the scan commit AND the stale-save re-derive:
// gate-tick preference → crossing prune → gate flag pass. The two callers
// previously duplicated this chain and drifted apart once — intermediate
// builds committed record sets the render-time heal could not reproduce
// (the customer's stale save carried 6 Area-2 roads with 2 entrances where
// a fresh scan commits 5 with 1). Poly SELECTION stays with each caller
// (the scan resolves per-bucket design fences; the heal receives them via
// ctx), but the sequence itself lives here so a rule change lands in both
// paths in the same commit. Tick scans never throw out of this helper: a
// drawing persisted by an older parser vintage must degrade to "no anchor
// hint", not abort the scan commit or throw an area into emptyAreaDesign.
const deriveTracedGateSet = (
  list: TraceRoadAdd[],
  drawing: ImportedDrawing | null | undefined,
  // Prune runs only when a poly is supplied (multi-area sites): single-area
  // traces keep the historical no-prune behavior.
  prunePoly: Pt[] | null,
  flagFence: Pt[],
  // Pave-as-drawn override fingerprints, threaded to the gate flag pass so
  // BOTH callers (scan commit and stale-save re-derivation) resurrect the
  // drafter's force-paved strips identically.
  pavedTraced?: readonly { x: number; y: number; len: number }[] | null,
): { kept: TraceRoadAdd[]; droppedLens: number[] } => {
  const safeTick = (poly: Pt[]): Pt | null => {
    try {
      return tracedGateTickHint(drawing, poly);
    } catch (e) {
      console.warn('[traced-roads] gate-tick scan failed on the drawing — deriving without the anchor hint', e);
      return null;
    }
  };
  let pruned = list;
  if (prunePoly && prunePoly.length >= 3) {
    // Steer the prune's gate-cluster choice toward the drawing's own gate
    // tick marks (E-GATE); fall back to a drawn flare outline when the
    // drawing has no ticks.
    const flare = list.find(r => r.outline?.length);
    const pref = safeTick(prunePoly) ?? (flare?.outline?.length
      ? {
          x: flare.outline.reduce((s2, p) => s2 + p.x, 0) / flare.outline.length,
          y: flare.outline.reduce((s2, p) => s2 + p.y, 0) / flare.outline.length,
        }
      : undefined);
    pruned = pruneTracedGateCrossings(list, prunePoly, pref ?? undefined);
  }
  return flagTracedGateRoads(pruned, flagFence, safeTick(flagFence), pavedTraced);
};

// The heal's fresh-scan surface list, cached per drawing identity: a stale
// save re-heals at every regenerate (stored edits are never rewritten), and
// re-analyzing the whole drawing once per area per regenerate would be a
// measurable stall on 260k-vertex CAD exports.
const healSurfaceCache = new WeakMap<ImportedDrawing, Pt[][]>();

// Stale-project heal: saves pre-dating verbatim road surfaces carry traced
// roads as bare centerline strips, so a restored project renders sparse
// approximations (internal comb aisles missing). Re-attach the drawn
// outline polygon from the persisted reference drawing to each traced
// strip that lies inside it. Heals records in place only — nothing is
// added, split, or dropped, so drafter deletions never resurrect. Pure and
// deterministic; the stored edits are never rewritten.
export const healTracedRoadSurfaces = (
  roads: NonNullable<LayoutConstraints['customRoads']>,
  drawing: ImportedDrawing | null | undefined,
): NonNullable<LayoutConstraints['customRoads']> => {
  if (!drawing) return roads;
  const needs = roads.some(r =>
    r.traced === true && !(r.surface?.length) && !(r.outline?.length));
  if (!needs) return roads;
  let freshSurfaces = healSurfaceCache.get(drawing);
  if (!freshSurfaces) {
    let plan: TracePlan;
    try {
      plan = analyzeReferenceDrawing(drawing);
    } catch {
      return roads;
    }
    freshSurfaces = [];
    for (const layer of plan.roads) for (const s of layer.strips) {
      if (s.surface?.length) freshSurfaces.push(s.surface);
    }
    healSurfaceCache.set(drawing, freshSurfaces);
  }
  if (!freshSurfaces.length) return roads;
  // Surfaces another road already renders verbatim — fresh commits carry the
  // yard outline on its own record, and re-stamping it onto every sibling
  // strip would flip them all into verbatim mode (a gate apron would render
  // the yard outline inside the fence and lose its own outside pavement).
  const sameRing = (a: { x: number; y: number }[], b: { x: number; y: number }[]) =>
    a.length === b.length && Math.abs(a[0].x - b[0].x) < 0.5 && Math.abs(a[0].y - b[0].y) < 0.5 &&
    Math.abs(a[a.length - 1].x - b[b.length - 1].x) < 0.5 && Math.abs(a[a.length - 1].y - b[b.length - 1].y) < 0.5;
  // Working set: seeded from pre-existing surfaced records AND grown as the
  // pass stamps — one surface ring must end up on at most one road record.
  const claimed = roads.filter(r => r.traced === true && (r.surface?.length ?? 0) >= 3)
    .map(r => r.surface!);
  let changed = false;
  const out = roads.map(r => {
    if (r.traced !== true || r.surface?.length || r.outline?.length) return r;
    // Entrance/apron records pave their own strip or flare at the gate —
    // never re-stamp them with a yard outline surface.
    if (r.entrance === true || r.apron === true) return r;
    // The drawn outline that contains this strip: the whole centerline
    // must fit so a strip grazing several outlines never steals one.
    const hit = freshSurfaces.find(surf =>
      r.pts.every(p => kmzPointInPolygon(p, surf)));
    if (!hit) return r;
    if (claimed.some(surf => sameRing(surf, hit))) return r;
    changed = true;
    const stamped = hit.map(p => ({ x: p.x, y: p.y }));
    claimed.push(stamped);
    return { ...r, surface: stamped };
  });
  return changed ? out : roads;
};

// Stale-project migration: saves pre-dating the one-gate commit pass carry
// traced road strips with NO entrance/gate/apron flags, and the engine
// renders unflagged traced roads at their full drawn extent — pavement
// scattered outside every fence. Re-run the same prune + flag pass the scan
// commit performs so the restored project renders under the one-gate rule.
// Pure and deterministic; the stored edits are never rewritten.
export const migrateLegacyTracedRoads = (
  roads: NonNullable<LayoutConstraints['customRoads']>,
  fence: Pt[],
  pavedTraced?: readonly { x: number; y: number; len: number }[] | null,
): NonNullable<LayoutConstraints['customRoads']> => {
  const traced = roads.filter(r => r.traced === true);
  // Only traced strips migrate, and only when none carries an entrance flag
  // yet — drafter-drawn manual roads pass through byte-identically, and a
  // manual road's entrance flag must not suppress the traced migration.
  if (fence.length < 3 || !traced.length || traced.some(r => r.entrance)) return roads;
  // Smuggle the stored record through the prune so ids/width survive.
  type Carrier = TraceRoadAdd & { __src: NonNullable<LayoutConstraints['customRoads']>[number] };
  const carriers: Carrier[] = traced.map(r => ({
    pts: r.pts, widthFt: r.width ?? 24,
    ...(r.outline?.length ? { outline: r.outline } : {}),
    ...(r.surface?.length ? { surface: r.surface } : {}),
    __src: r,
  }));
  const flare = carriers.find(r => r.outline?.length);
  const pref = flare?.outline?.length
    ? {
        x: flare.outline.reduce((s2, p) => s2 + p.x, 0) / flare.outline.length,
        y: flare.outline.reduce((s2, p) => s2 + p.y, 0) / flare.outline.length,
      }
    : undefined;
  const pruned = pruneTracedGateCrossings(carriers, fence, pref) as Carrier[];
  const { kept } = flagTracedGateRoads(pruned, fence, undefined, pavedTraced);
  // The prune can split one strip into several runs; index the migrated
  // pieces by their source id, then rebuild the road list in its original
  // order with manual roads untouched and dropped traced strips gone.
  const migratedById = new Map<string, NonNullable<LayoutConstraints['customRoads']>[number][]>();
  for (const c of kept) {
    const out = { ...c.__src, pts: c.pts };
    if (c.entrance) out.entrance = true;
    if (c.gate) out.gate = { x: c.gate.x, y: c.gate.y };
    if (c.apron) out.apron = true;
    (migratedById.get(c.__src.id) ?? migratedById.set(c.__src.id, []).get(c.__src.id)!).push(out);
  }
  return roads.flatMap(r => r.traced === true ? (migratedById.get(r.id) ?? []) : [r]);
};

// Road-rules version stamped on every traced road record the scan commits.
// Bump it whenever the commit rules change in a way stale saves must pick up
// (gate tick anchoring, ring-probe bucketing, annotation-arrow rejection):
// the render-time heal then re-derives the area's traced roads from the
// persisted reference drawing under the CURRENT rules — patching the old
// records is not enough when a gate flare never became a record at all
// (Big Iron Area 2). v1 = pre-versioning records (no tracedV field).
// v3 = gate-band triangle infill merges into the adjacent pavement ring and
// ring closure derives from geometry (isClosedPolylineRun), not baked
// closedFlags — so saves stamped v2 by intermediate builds re-derive too.
// v4 = invalidates every v3-era stamp. Intermediate v3 builds wrote
// structurally broken records for some areas (paved stub ending at the
// fence, flare kept as outline only — the customer's Areas 1/2/4 while
// Area 3 stayed correct) yet STAMPED them current, so the render-time heal
// skipped them forever: their reloads showed zero [traced-heal] activity.
// The derivation itself was already fixed; this bump exists purely so
// records stamped by those builds re-derive from the reference drawing.
// v5 = wholly-outside strips no longer qualify as gate aprons by merely
// coming near the gate (tracedApronKeepsPavement: a drawn flare RING keeps
// pavement when most of its perimeter sits in gate reach; a BARE stub only
// when it terminates at the gate and is stub-short). Under v4, Big Iron
// Area 4 committed its off-site fence-hugging corridor band and the
// substation yards committed context strips as pavement-bearing aprons.
// The prune→flag sequence also moved into deriveTracedGateSet, shared
// verbatim by the scan commit and the heal, so the two derivations can no
// longer drift apart (the v4-era poisoning happened exactly that way:
// intermediate builds changed the derivation without bumping this
// constant).
// RULE: any change that alters traced-road derivation output MUST bump this
// constant in the same commit — a stamp is a promise that the record's
// geometry matches the current rules, and an unbumped fix silently poisons
// every save written while the bug was live.
const TRACED_ROAD_RULES_V = 5;

// True when any area carries traced roads committed under older rules. The
// async drawing-load callbacks (session restore + project import) gate their
// second rebuild on this: the synchronous rebuild runs while the IndexedDB
// drawing read is still in flight, so the render-time heal below saw no
// drawing and no-op'd — without that second pass a stale save NEVER picks up
// the current commit rules (Big Iron gates stayed broken on reopen even
// though a fresh import was fixed).
export const tracedRoadsBelowRules = (
  roads: LayoutConstraints['customRoads'] | undefined,
): boolean =>
  (roads ?? []).some(
    r => r.traced === true && (r.tracedV ?? 1) < TRACED_ROAD_RULES_V);

// NOTE: single-area sessions keep their traced roads in TOP-LEVEL
// layoutEdits and may have no siteAreas at all — callers gating a rebuild
// must ALSO check tracedRoadsBelowRules(state.layoutEdits.customRoads), or
// single-area stale saves reopen broken forever while multi-area ones heal.
export const siteHasStaleTracedRoads = (
  siteAreas: readonly { edits?: { layoutEdits?: LayoutConstraints } }[],
): boolean =>
  siteAreas.some(a => tracedRoadsBelowRules(a.edits?.layoutEdits?.customRoads));

// Fresh-plan strip cache for the re-derivation, keyed per drawing identity
// (same lifetime rules as healSurfaceCache). Stores PRISTINE strips; the
// caller deep-copies before the gate flag pass, which mutates its input.
const rederiveStripCache = new WeakMap<ImportedDrawing, TraceRoadAdd[]>();
export const rederiveStaleTracedRoads = (
  roads: NonNullable<LayoutConstraints['customRoads']>,
  areaId: string,
  fence: Pt[],
  siteAreas: readonly { id: string; boundary: { polygon: Pt[] } }[],
  drawing: ImportedDrawing | null | undefined,
  ctx?: {
    // Scan-parity poly selection: the area's design fence (prune) and the
    // boundary+placement fence (flags). Without them the caller fence backs
    // both roles — identical whenever the design fence IS
    // fencePolygonFor(boundary, placement), i.e. every non-custom fence.
    designFence?: Pt[] | null;
    fencePlacement?: Parameters<typeof fencePolygonFor>[1];
    // Geometry tombstones for drafter-deleted traced roads.
    removedTraced?: readonly { x: number; y: number; len: number }[];
    // Pave-as-drawn override fingerprints for traced strips the drafter
    // force-paved (see LayoutConstraints.pavedTracedRoads): the rebuild
    // KEEPS matching strips that fail the gate-apron rule instead of
    // dropping them, so the override survives the wholesale re-derivation.
    pavedTraced?: readonly { x: number; y: number; len: number }[];
    // Filled for the caller: which branch this call actually took, so the
    // heal wrapper can log honestly instead of assuming "re-derived".
    outcome?: {
      branch?: 'not-stale' | 'no-drawing' | 'no-fence' | 'analyze-failed' | 'rederived';
      error?: unknown;
    };
  },
): NonNullable<LayoutConstraints['customRoads']> => {
  const traced = roads.filter(r => r.traced === true);
  if (!traced.length || !drawing || fence.length < 3) {
    if (ctx?.outcome) {
      ctx.outcome.branch = !traced.length ? 'not-stale' : (!drawing ? 'no-drawing' : 'no-fence');
    }
    return roads;
  }
  if (traced.every(r => (r.tracedV ?? 1) >= TRACED_ROAD_RULES_V)) {
    if (ctx?.outcome) ctx.outcome.branch = 'not-stale';
    return roads;
  }
  let strips = rederiveStripCache.get(drawing);
  if (!strips) {
    let plan: TracePlan;
    try {
      plan = analyzeReferenceDrawing(drawing);
    } catch (e) {
      // Stored records are kept as-is — never drop a drafter's roads
      // because the heal can't run. The caller logs this branch loudly;
      // silence here looked exactly like "no heal needed" in the field.
      if (ctx?.outcome) {
        ctx.outcome.branch = 'analyze-failed';
        ctx.outcome.error = e;
      }
      return roads;
    }
    strips = [];
    for (const layer of plan.roads) for (const s of layer.strips) {
      if (s.pts.length >= 2) {
        strips.push({
          pts: s.pts,
          widthFt: s.widthFt,
          ...(s.outline && s.outline.length >= 3 ? { outline: s.outline } : {}),
          ...(s.surface && s.surface.length >= 3 ? { surface: s.surface } : {}),
        });
      }
    }
    rederiveStripCache.set(drawing, strips);
  }
  // Deep copies: the gate flag pass mutates the strips it keeps.
  const copies: TraceRoadAdd[] = strips.map(s => ({
    pts: s.pts.map(p => ({ ...p })),
    widthFt: s.widthFt,
    ...(s.outline ? { outline: s.outline.map(p => ({ ...p })) } : {}),
    ...(s.surface ? { surface: s.surface.map(p => ({ ...p })) } : {}),
  }));
  const multi = siteAreas.length > 1;
  const list = multi
    ? (bucketTracedRoadAdds(copies, siteAreas, null, true, []).get(areaId) ?? [])
    : copies;
  // Same poly selection as the scan commit: prune against the area's design
  // fence (falling back to its boundary polygon), flag against the fence
  // derived from boundary + placement. The shared deriveTracedGateSet owns
  // the sequence itself — including the never-throw tick scan (a drawing
  // persisted by an older parser vintage must not throw the whole area into
  // regenerateAreas' catch, where emptyAreaDesign would blank the yard).
  const area = siteAreas.find(a => a.id === areaId);
  const designFence = ctx?.designFence?.length ? ctx.designFence : fence;
  const prunePoly = multi
    ? (designFence.length >= 3 ? designFence : (area?.boundary.polygon ?? fence))
    : null;
  let flagFence = fence;
  if (ctx?.fencePlacement !== undefined && area && area.boundary.polygon.length >= 3) {
    const f = fencePolygonFor(area.boundary.polygon, ctx.fencePlacement);
    if (f.length >= 3) flagFence = f;
  }
  const { kept } = deriveTracedGateSet(list, drawing, prunePoly, flagFence, ctx?.pavedTraced);
  // Drafter-deleted traced roads stay deleted through the wholesale rebuild:
  // drop any fresh strip whose geometry fingerprint matches a tombstone
  // (see LayoutConstraints.removedTracedRoads). Tolerances absorb float
  // noise, not geometry changes — a strip the rules genuinely reshaped is a
  // different road and legitimately returns. Tombstones filter AFTER the
  // pave-override resurrection above, so a strip that is somehow both
  // force-paved and deleted stays deleted (deletion is the stronger edit).
  const tombs = ctx?.removedTraced ?? [];
  const keptLive = tombs.length
    ? kept.filter(r => !tracedRoadFingerprintMatch(tracedRoadFingerprint(r.pts), tombs))
    : kept;
  const manual = roads.filter(r => r.traced !== true);
  let nextRoad = 1;
  for (const r of manual) {
    const m = /^troad-(\d+)$/.exec(r.id);
    if (m) nextRoad = Math.max(nextRoad, parseInt(m[1], 10) + 1);
  }
  const fresh = keptLive.map(r => ({
    id: `troad-${nextRoad++}`,
    pts: r.pts.map(p => ({ x: p.x, y: p.y })),
    width: Math.max(12, Math.min(60, r.widthFt)),
    traced: true,
    tracedV: TRACED_ROAD_RULES_V,
    ...(r.outline ? { outline: r.outline.map(p => ({ x: p.x, y: p.y })) } : {}),
    ...(r.surface ? { surface: r.surface.map(p => ({ x: p.x, y: p.y })) } : {}),
    ...(r.entrance ? { entrance: true } : {}),
    ...(r.gate ? { gate: { x: r.gate.x, y: r.gate.y } } : {}),
    ...(r.apron ? { apron: true } : {}),
  }));
  if (ctx?.outcome) ctx.outcome.branch = 'rederived';
  return [...manual, ...fresh];
};

// One heal composition for BOTH regenerate paths. regenerateAreas healed
// per-area from the start; the plain single-area regenerate() historically
// skipped the chain, so any setter-driven rebuild of a stale single-area
// traced yard silently reverted its healed roads to raw stored records.
// The [traced-heal] console lines are deliberate production diagnostics:
// the state that breaks this pipeline lives in the drafter's browser (their
// autosave + their IndexedDB drawing) and cannot be reproduced from code
// alone — each line names the branch taken so a screenshot report can be
// traced to a cause without forging their storage.
// A stale save re-heals on EVERY regenerate (stored edits are deliberately
// never rewritten), so identical diagnostic lines would repeat throughout a
// normal drafting session and drown the signal. Log each distinct outcome
// once per page lifetime; a CHANGED outcome (different counts) still logs.
const tracedHealLogSeen = new Set<string>();
const tracedHealLogOnce = (key: string, emit: () => void): void => {
  if (tracedHealLogSeen.has(key)) return;
  tracedHealLogSeen.add(key);
  emit();
};

export const healTracedRoadConstraints = (
  roads: Parameters<typeof rederiveStaleTracedRoads>[0],
  areaId: string,
  fence: Pt[],
  siteAreas: Parameters<typeof rederiveStaleTracedRoads>[3],
  drawing: Parameters<typeof rederiveStaleTracedRoads>[4],
  label: string,
  ctx?: Omit<NonNullable<Parameters<typeof rederiveStaleTracedRoads>[5]>, 'outcome'>,
): ReturnType<typeof rederiveStaleTracedRoads> => {
  const before = roads.filter(r => r.traced === true);
  if (before.length &&
      before.some(r => (r.tracedV ?? 1) < TRACED_ROAD_RULES_V) &&
      !drawing) {
    tracedHealLogOnce(`warn|${label}|${before.length}`, () =>
      console.warn(`[traced-heal] ${label}: ${before.length} traced road(s) below rules v${TRACED_ROAD_RULES_V} but no reference drawing is loaded — rendering stored records as-is`));
  }
  const outcome: NonNullable<NonNullable<Parameters<typeof rederiveStaleTracedRoads>[5]>['outcome']> = {};
  const healed = migrateLegacyTracedRoads(
    healTracedRoadSurfaces(
      rederiveStaleTracedRoads(roads, areaId, fence, siteAreas, drawing, { ...ctx, outcome }),
      drawing),
    fence, ctx?.pavedTraced);
  if (outcome.branch === 'analyze-failed') {
    // Loud by design: this used to bail silently, which read as "no heal
    // needed" while the drafter's stale records kept rendering broken.
    tracedHealLogOnce(`analyze-failed|${label}`, () =>
      console.warn(`[traced-heal] ${label}: the persisted reference drawing failed to analyze — stored traced records kept as-is (re-import the customer KMZ to heal this area)`, outcome.error));
  }
  if (healed !== roads) {
    const after = healed.filter(r => r.traced === true);
    const surfaced = after.filter(r => r.surface?.length || r.outline?.length).length;
    const entrances = after.filter(r => r.entrance).length;
    // Name the branch that actually ran: the in-place surface/legacy passes
    // also change the array identity, and logging those as "re-derived"
    // sent a field investigation down the wrong path.
    const verb = outcome.branch === 'rederived'
      ? `re-derived under rules v${TRACED_ROAD_RULES_V}`
      : 'surfaces/flags healed in place (records not re-derived)';
    tracedHealLogOnce(`info|${label}|${before.length}|${after.length}|${surfaced}|${entrances}|${outcome.branch ?? 'in-place'}`, () =>
      console.info(`[traced-heal] ${label}: ${before.length}\u2192${after.length} traced road(s), ` +
        `${surfaced} surfaced, ${entrances} entrance \u2014 ${verb}`));
    // Per-record fingerprint (once per distinct outcome): a field screenshot
    // of THIS line pins down which strip diverged from the reference-fleet
    // expectation without access to the drafter's browser storage.
    tracedHealLogOnce(`detail|${label}|${before.length}|${after.length}|${surfaced}|${entrances}|${outcome.branch ?? 'in-place'}`, () => {
      const lenOf = (pts: Pt[]): number => {
        let L = 0;
        for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
        return Math.round(L);
      };
      const rows = after.map(r => {
        const g = r.gate ? `@${r.gate.x.toFixed(0)},${r.gate.y.toFixed(0)}` : '';
        return `${r.id}[${r.entrance ? 'E' : ''}${r.apron ? 'A' : ''} len${lenOf(r.pts)} s${r.surface?.length ?? 0}/o${r.outline?.length ?? 0}${g}]`;
      }).join(' ');
      console.info(`[traced-heal] ${label} detail: ${rows} | prune=${ctx?.designFence?.length ?? 'caller'} placement=${ctx?.fencePlacement === undefined ? 'caller' : JSON.stringify(ctx?.fencePlacement)}`);
    });
  }
  return healed;
};

// Commit a batch of traced equipment/road additions as ONE undoable edit,
// routing each item to the site area whose footprint contains it (multi-area
// sites fill every footprint; single-area projects use the top-level edits).
// Shared by the KMZ auto-fill Apply and the scene bulk-tag tool so both
// commit through identical rules: real sequential labels, per-area peq/troad
// numbering, stale move/rot cleanup, compact road mode when roads landed.
// Re-entrancy guard for the phased (async) auto-fill apply: one at a time.
let traceApplyBusy = false;

// Gate anchor from the drawing's own GATE tick marks: the reference draws a
// pair of small closed rectangles straddling each gate throat (layers named
// *GATE*, e.g. E-GATE). This is the most reliable entrance anchor — a drawn
// flare outline may be absent (Big Iron Area 2) and tapering SITE ACCESS
// triangles are annotation arrows, not pavement.
const tracedGateTickHint = (drawing: ImportedDrawing | null | undefined, fence: Pt[]): Pt | null => {
  if (!drawing || fence.length < 3) return null;
  const ticks: Pt[] = [];
  for (const layer of drawing.layers) {
    if (!/GATE/i.test(layer.name)) continue;
    for (let li = 0; li < layer.polylines.length; li++) {
      if (!isClosedPolylineRun(layer.polylines[li], layer.closedFlags[li])) continue;
      const flat = layer.polylines[li];
      const n = flat.length / 2;
      if (n < 3 || n > 12) continue;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, sx = 0, sy = 0;
      for (let k = 0; k < n; k++) {
        const x = flat[2 * k], y = flat[2 * k + 1];
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
        sx += x; sy += y;
      }
      // Tick marks are gate-throat rectangles a few feet across; bigger
      // closed linework on a GATE layer is not a tick.
      if (x1 - x0 > 40 || y1 - y0 > 40) continue;
      ticks.push({ x: sx / n, y: sy / n });
    }
  }
  if (!ticks.length) return null;
  // Keep only the ticks hugging THIS fence — a multi-area site draws gate
  // ticks at every area's entrance.
  const near = ticks.filter(t => {
    for (let i = 0; i < fence.length; i++) {
      const q0 = fence[i], q1 = fence[(i + 1) % fence.length];
      const dx = q1.x - q0.x, dy = q1.y - q0.y, L2 = dx * dx + dy * dy;
      const u = L2 > 0 ? Math.max(0, Math.min(1, ((t.x - q0.x) * dx + (t.y - q0.y) * dy) / L2)) : 0;
      if (Math.hypot(t.x - (q0.x + u * dx), t.y - (q0.y + u * dy)) < 150) return true;
    }
    return false;
  });
  if (!near.length) return null;
  return {
    x: near.reduce((sum, t) => sum + t.x, 0) / near.length,
    y: near.reduce((sum, t) => sum + t.y, 0) / near.length,
  };
};

export const pruneTracedGateCrossings = (
  list: TraceRoadAdd[],
  poly: Pt[],
  // Preferred gate location (the drawn entrance flare, when the drawing has
  // one): the crossing cluster nearest this point is the gate, regardless of
  // strip count — the flare marks the entrance authoritatively.
  preferred?: Pt,
): TraceRoadAdd[] => {
  const CLUSTER_FT = 250;
  const MIN_RUN_FT = 30;
  const segCross = (a: Pt, b: Pt, c: Pt, d: Pt): number | null => {
    const rx = b.x - a.x, ry = b.y - a.y, sx = d.x - c.x, sy = d.y - c.y;
    const den = rx * sy - ry * sx;
    if (den === 0) return null;
    const t = ((c.x - a.x) * sy - (c.y - a.y) * sx) / den;
    const u = ((c.x - a.x) * ry - (c.y - a.y) * rx) / den;
    return t > 0 && t < 1 && u > 0 && u < 1 ? t : null;
  };
  // Crossing points per strip index.
  const crossings: { idx: number; pt: Pt }[] = [];
  list.forEach((r, idx) => {
    for (let i = 1; i < r.pts.length; i++) {
      for (let j = 0; j < poly.length; j++) {
        const t = segCross(r.pts[i - 1], r.pts[i], poly[j], poly[(j + 1) % poly.length]);
        if (t !== null) {
          const a = r.pts[i - 1], b = r.pts[i];
          crossings.push({ idx, pt: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t } });
        }
      }
    }
  });
  if (!crossings.length) return list;
  // Chain-cluster crossing points: two crossings within 250 ft of EACH OTHER
  // belong to the same entrance, transitively (union-find over pairwise
  // links) — a flare mouth whose strips cross at 0/240/480 ft is ONE gate,
  // even though the ends are 480 ft apart. A moving-centroid pass would split
  // such a chained span and clip a valid flare strip.
  const parent = crossings.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  };
  for (let i = 0; i < crossings.length; i++) {
    for (let j = i + 1; j < crossings.length; j++) {
      if (Math.hypot(crossings[i].pt.x - crossings[j].pt.x,
                     crossings[i].pt.y - crossings[j].pt.y) < CLUSTER_FT) {
        parent[find(j)] = find(i);
      }
    }
  }
  const byRoot = new Map<number, { x: number; y: number; n: number; idxs: Set<number>; members: number[] }>();
  const clusterOf: number[] = [];
  const rootOrder: number[] = [];
  crossings.forEach((c, i) => {
    const root = find(i);
    let cl = byRoot.get(root);
    if (!cl) {
      cl = { x: 0, y: 0, n: 0, idxs: new Set(), members: [] };
      byRoot.set(root, cl);
      rootOrder.push(root);
    }
    cl.x = (cl.x * cl.n + c.pt.x) / (cl.n + 1);
    cl.y = (cl.y * cl.n + c.pt.y) / (cl.n + 1);
    cl.n++; cl.idxs.add(c.idx); cl.members.push(i);
  });
  const clusters = rootOrder.map(r => byRoot.get(r)!);
  crossings.forEach((_, i) => {
    clusterOf.push(rootOrder.indexOf(find(i)));
  });
  if (clusters.length <= 1) return list;
  const gateIdx = preferred
    ? clusters.reduce((best, cl, i) =>
        Math.hypot(cl.x - preferred.x, cl.y - preferred.y) <
        Math.hypot(clusters[best].x - preferred.x, clusters[best].y - preferred.y) ? i : best, 0)
    : clusters.reduce((best, cl, i) =>
        cl.idxs.size > clusters[best].idxs.size ||
        (cl.idxs.size === clusters[best].idxs.size && cl.n > clusters[best].n) ? i : best, 0);
  const gate = clusters[gateIdx];
  const pruned: TraceRoadAdd[] = [];
  list.forEach((r, idx) => {
    // A verbatim-surface road renders its drawn polygon; splitting its
    // representative centerline would only duplicate the surface across
    // pieces. Gate-side clipping is handled by the engine's flags instead.
    if (r.surface?.length) { pruned.push(r); return; }
    // A strip is clipped when ANY of its crossings is a stray (non-gate)
    // crossing — even if the same polyline also crosses at the gate.
    const hasStray = crossings.some((c, ci) => c.idx === idx && clusterOf[ci] !== gateIdx);
    if (!hasStray) { pruned.push(r); return; }
    // Sample the centerline; a sample survives when it is inside the fence
    // (interior aisles) OR near the gate cluster (the entrance flare/apron
    // outside the fence). Split into contiguous runs at dropped samples and
    // keep every run long enough to be real pavement.
    // Gate proximity is judged against every crossing IN the gate cluster
    // (not just the centroid) so a chained flare spanning >250 ft keeps its
    // whole apron.
    const gatePts = gate.members.map(mi => crossings[mi].pt);
    const keep = (p: Pt) =>
      kmzPointInPolygon(p, poly) ||
      gatePts.some(g => Math.hypot(p.x - g.x, p.y - g.y) < CLUSTER_FT);
    const runs: Pt[][] = [];
    let cur: Pt[] = [];
    const push = (p: Pt) => {
      if (keep(p)) cur.push(p);
      else if (cur.length) { runs.push(cur); cur = []; }
    };
    push(r.pts[0]);
    for (let i = 1; i < r.pts.length; i++) {
      const a = r.pts[i - 1], b = r.pts[i];
      const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 15));
      for (let s = 1; s <= steps; s++) {
        push({ x: a.x + (b.x - a.x) * s / steps, y: a.y + (b.y - a.y) * s / steps });
      }
    }
    if (cur.length) runs.push(cur);
    for (const run of runs) {
      if (run.length < 2) continue;
      const span = Math.hypot(run[run.length - 1].x - run[0].x, run[run.length - 1].y - run[0].y);
      if (span < MIN_RUN_FT) continue;
      // Keep a sparse subset of the run (every ~5th sample plus both ends)
      // so a curved strip stays curved after trimming.
      const kept = run.filter((_, i) => i === 0 || i === run.length - 1 || i % 5 === 0);
      pruned.push({ ...r, pts: kept });
    }
  });
  return pruned;
};

// Bucket traced road strips to the site area that owns them: a MAJORITY of
// sampled centerline points wins (a strip clipping a corner of a neighbouring
// footprint still lands with the area that owns most of its length); a strip
// wholly outside every parcel (gate aprons, drawn flares) attaches to the
// nearest parcel within a short reach, probing its drawn ring
// (outline/surface), not just the fitted centerline — a verbatim traced road
// carries its drawn polygon as `surface`, and a gate flare whose fitted axis
// stops short of the parcel still has drawn pavement touching it (Big Iron
// Areas 2/3 flares). A ring probe INSIDE a parcel pins the strip to that area
// outright, beating a neighbouring parcel that is merely closer to the
// centerline. Shared by the scan commit and the stale-save re-derivation so
// both always agree which area a drawn strip belongs to.
const bucketTracedRoadAdds = (
  roadAdds: TraceRoadAdd[],
  siteAreas: readonly { id: string; boundary: { polygon: Pt[] } }[],
  activeId: string | null,
  multiArea: boolean,
  droppedRoads: number[],
): Map<string, TraceRoadAdd[]> => {
  const bucketRoads = new Map<string, TraceRoadAdd[]>();
  const areaOf = (x: number, y: number): string | null => {
    if (!multiArea) return null;
    for (const a of siteAreas) {
      if (kmzPointInPolygon({ x, y }, a.boundary.polygon)) return a.id;
    }
    return null;
  };
  for (const r of roadAdds) {
    if (multiArea) {
      const votes = new Map<string, number>();
      const p0 = r.pts[0], p1 = r.pts[r.pts.length - 1];
      // Sample every SEGMENT at a fixed interval (vertices alone under-count
      // long straight legs, so a bent route could be voted into the wrong
      // area even though most of its length runs elsewhere).
      const SAMPLE_FT = 100;
      const samples: Pt[] = [r.pts[0]];
      for (let i = 1; i < r.pts.length; i++) {
        const a = r.pts[i - 1], b = r.pts[i];
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        const steps = Math.max(1, Math.min(50, Math.ceil(len / SAMPLE_FT)));
        for (let s = 1; s <= steps; s++) {
          samples.push({ x: a.x + (b.x - a.x) * s / steps, y: a.y + (b.y - a.y) * s / steps });
        }
      }
      for (const p of samples) {
        const id = areaOf(p.x, p.y);
        if (id) votes.set(id, (votes.get(id) ?? 0) + 1);
      }
      let best: string | null = null, bestN = 0;
      votes.forEach((v, id) => { if (v > bestN) { best = id; bestN = v; } });
      if (!best) {
        // Gate ENTRY stubs sit entirely OUTSIDE the fence they serve (the
        // wide apron from the public road to the gate), so zero samples land
        // inside any footprint. Attach the strip to the nearest area ONLY
        // when its pavement actually reaches that area's boundary — a genuine
        // entry road touches the fence it enters; anything short of that is
        // between-area or off-site linework and drops with the warning.
        const ring = r.outline ?? r.surface;
        const ENTRY_REACH_FT = ring ? r.widthFt / 2 + 70 : r.widthFt / 2 + 10;
        const probes = ring ? [...samples, ...ring] : samples;
        let bd = Infinity;
        for (const a of siteAreas) {
          const poly = a.boundary.polygon;
          for (const p of probes) {
            if (ring && kmzPointInPolygon(p, poly)) { bd = 0; best = a.id; break; }
            for (let i = 0; i < poly.length; i++) {
              const q0 = poly[i], q1 = poly[(i + 1) % poly.length];
              const dx = q1.x - q0.x, dy = q1.y - q0.y;
              const L2 = dx * dx + dy * dy;
              const t = L2 > 0 ? Math.max(0, Math.min(1, ((p.x - q0.x) * dx + (p.y - q0.y) * dy) / L2)) : 0;
              const d = Math.hypot(p.x - (q0.x + t * dx), p.y - (q0.y + t * dy));
              if (d < bd) { bd = d; best = a.id; }
            }
          }
        }
        if (!best || bd > ENTRY_REACH_FT) {
          droppedRoads.push(Math.round(Math.hypot(p1.x - p0.x, p1.y - p0.y)));
          continue;
        }
      }
      (bucketRoads.get(best) ?? bucketRoads.set(best, []).get(best)!).push(r);
    } else {
      const id = activeId ?? '_';
      (bucketRoads.get(id) ?? bucketRoads.set(id, []).get(id)!).push(r);
    }
  }
  return bucketRoads;
};

// A KMZ rectangle is evidence that an equipment item exists, not permission
// to invent a second physical standard.  Keep every traced id/count and the
// customer's PCS anchor, but compose each PCS + up-to-three BESS group with
// the same QTY3 footprint, dimensions, clearances and orientation rules used
// by placeMirroredPair.  This happens once, after per-area bucketing and before
// the records are committed, so 3D/2D/CAD/export all receive one geometry.
export const normalizeTracedEquipmentAdds = (
  adds: TraceEquipAdd[],
  config: ReturnType<typeof getConfiguration>,
  hotClimate: boolean,
): TraceEquipAdd[] => {
  const out = adds.map(a => {
    const traceSourcePose = a.traceSourcePose ?? {
      x: a.pose.cx,
      y: a.pose.cy,
      rotationDeg: a.pose.rotationDeg,
      lengthFt: a.pose.lengthFt,
      widthFt: a.pose.widthFt,
    };
    // Every climate projection starts from the immutable customer-drawing
    // pose, never from the previously normalized 14 ft / 10 ft result. This
    // makes 14 → 10 → 14 deterministic and prevents cumulative drift.
    return {
      ...a,
      pose: {
        cx: traceSourcePose.x,
        cy: traceSourcePose.y,
        rotationDeg: traceSourcePose.rotationDeg,
        lengthFt: traceSourcePose.lengthFt,
        widthFt: traceSourcePose.widthFt,
      },
      traceSourcePose: { ...traceSourcePose },
    };
  });
  const snap90 = (deg: number) => {
    const q = Math.round((Number.isFinite(deg) ? deg : 0) / 90) * 90;
    return ((q % 360) + 360) % 360;
  };
  // Catalog footprints and quarter-turn alignment apply in every equipment
  // configuration. QTY3 additionally receives the mirrored-pair slot geometry
  // below; other configurations retain their source grouping until their
  // corresponding standard composer is available.
  for (const a of out) {
    if (a.kind === 'inverter') {
      a.pose.lengthFt = config.inverterDims.length;
      a.pose.widthFt = config.inverterDims.width;
      a.pose.rotationDeg = snap90(a.pose.rotationDeg);
    } else if (a.kind === 'bess') {
      a.pose.lengthFt = LG_JF2.length;
      a.pose.widthFt = LG_JF2.width;
      a.pose.rotationDeg = snap90(a.pose.rotationDeg);
    }
  }
  const normalizeCohort = (
    pcs: TraceEquipAdd[],
    bess: TraceEquipAdd[],
  ) => {
    if (!pcs.length || !bess.length) return;
    const pcsClearance = hotClimate ? CLEARANCES.pcsHotClimate : CLEARANCES.pcsStandard;
    const byOwner = new Map<TraceEquipAdd, TraceEquipAdd[]>();
    const ownerCap = Math.max(1, Math.ceil(bess.length / pcs.length));
    const ownerLoad = new Map<TraceEquipAdd, number>(pcs.map(p => [p, 0]));
    const ownerPairs: { bess: TraceEquipAdd; pcs: TraceEquipAdd; d: number }[] = [];
    for (const container of bess) for (const inverter of pcs) {
      ownerPairs.push({
        bess: container,
        pcs: inverter,
        d: Math.hypot(
          inverter.pose.cx - container.pose.cx,
          inverter.pose.cy - container.pose.cy,
        ),
      });
    }
    ownerPairs.sort((a, b) =>
      a.d - b.d ||
      a.bess.pose.cx - b.bess.pose.cx || a.bess.pose.cy - b.bess.pose.cy ||
      a.pcs.pose.cx - b.pcs.pose.cx || a.pcs.pose.cy - b.pcs.pose.cy);
    const ownerAssigned = new Set<TraceEquipAdd>();
    for (const capped of [true, false]) for (const pair of ownerPairs) {
      if (ownerAssigned.has(pair.bess) ||
          (capped && (ownerLoad.get(pair.pcs) ?? 0) >= ownerCap)) continue;
      ownerAssigned.add(pair.bess);
      ownerLoad.set(pair.pcs, (ownerLoad.get(pair.pcs) ?? 0) + 1);
      (byOwner.get(pair.pcs) ??
        byOwner.set(pair.pcs, []).get(pair.pcs)!).push(pair.bess);
    }

    // Legacy QTY4 follows the same two-row composer as placeBlock, anchored at
    // the customer's PCS center and rotated into its quarter-turn local frame.
    // Missing source containers stay missing; normalization never invents units.
    if (config.containersPerBlock !== 3) {
      const across = Math.ceil(config.containersPerBlock / 2);
      const rowWidth =
        across * LG_JF2.width + (across - 1) * CLEARANCES.sideToSide;
      const containerDepth = 2 * LG_JF2.length + CLEARANCES.rearToRear;
      for (const inverter of pcs) {
        const owned = (byOwner.get(inverter) ?? [])
          .slice(0, config.containersPerBlock);
        const thetaDeg = snap90(inverter.pose.rotationDeg);
        const theta = thetaDeg * Math.PI / 180;
        inverter.pose.rotationDeg = thetaDeg;
        const bottomY =
          -(containerDepth + pcsClearance + config.inverterDims.width / 2);
        const slots: { x: number; y: number }[] = [];
        for (let row = 0;
          row < 2 && slots.length < config.containersPerBlock;
          row++) {
          const y = bottomY + LG_JF2.length / 2 +
            row * (LG_JF2.length + CLEARANCES.rearToRear);
          for (let col = 0;
            col < across && slots.length < config.containersPerBlock;
            col++) {
            slots.push({
              x: -rowWidth / 2 + LG_JF2.width / 2 +
                col * (LG_JF2.width + CLEARANCES.sideToSide),
              y,
            });
          }
        }
        const local = (b: TraceEquipAdd) => {
          const dx = b.traceSourcePose!.x - inverter.traceSourcePose!.x;
          const dy = b.traceSourcePose!.y - inverter.traceSourcePose!.y;
          return {
            along: dx * Math.cos(theta) + dy * Math.sin(theta),
            normal: -dx * Math.sin(theta) + dy * Math.cos(theta),
          };
        };
        owned.sort((a, b) => {
          const aa = local(a), bb = local(b);
          return aa.normal - bb.normal || aa.along - bb.along ||
            a.pose.cx - b.pose.cx || a.pose.cy - b.pose.cy;
        });
        for (let i = 0; i < owned.length; i++) {
          const b = owned[i], slot = slots[i];
          b.pose.cx = inverter.pose.cx +
            slot.x * Math.cos(theta) - slot.y * Math.sin(theta);
          b.pose.cy = inverter.pose.cy +
            slot.x * Math.sin(theta) + slot.y * Math.cos(theta);
          b.pose.rotationDeg = snap90(thetaDeg + 90);
        }
      }
      return;
    }

    const dxPair = (PAIR_INNER_GAP_FT + LG_JF2.width) / 2;
    const pairBias =
      (LG_JF2.length - (2 * LG_JF2.width + PAIR_INNER_GAP_FT)) / 2;
    for (const inverter of pcs) {
      const owned = byOwner.get(inverter) ?? [];
      if (!owned.length) continue;
      const thetaDeg = snap90(inverter.pose.rotationDeg);
      const theta = thetaDeg * Math.PI / 180;
      const c = Math.cos(theta), s = Math.sin(theta);
      const local = (a: TraceEquipAdd) => {
        const dx = a.pose.cx - inverter.pose.cx;
        const dy = a.pose.cy - inverter.pose.cy;
        return { x: dx * c + dy * s, y: -dx * s + dy * c };
      };
      const meanY =
        owned.reduce((sum, a) => sum + local(a).y, 0) / owned.length;
      // inward points from the PCS toward its containers in the PCS local frame.
      const inward: 1 | -1 = meanY >= 0 ? 1 : -1;
      const pairY = inward * (
        config.inverterDims.width / 2 + pcsClearance + LG_JF2.length / 2);
      const a3Y = inward * (
        config.inverterDims.width / 2 + pcsClearance + LG_JF2.length +
        A3_GAP_FT + LG_JF2.width / 2);
      const slots = [
        {
          x: -inward * pairBias - inward * dxPair,
          y: pairY,
          rot: thetaDeg + 90,
        },
        {
          x: -inward * pairBias + inward * dxPair,
          y: pairY,
          rot: thetaDeg + 90,
        },
        { x: 0, y: a3Y, rot: thetaDeg },
      ];

      // Preserve which traced rectangle represented A-3 when the customer
      // drawing makes that clear (its long axis matches the PCS); the other two
      // keep deterministic local-x order. Missing third containers simply leave
      // A-3 absent — Task 903 never changes inventory counts.
      const axisDiff = (a: TraceEquipAdd) => {
        const d = Math.abs(snap90(a.pose.rotationDeg) - thetaDeg) % 180;
        return Math.min(d, 180 - d);
      };
      let a3: TraceEquipAdd | undefined;
      if (owned.length >= 3) {
        a3 = owned.slice().sort((a, b) => axisDiff(a) - axisDiff(b))[0];
      }
      const pair = owned
        .filter(a => a !== a3)
        .sort((a, b) => local(a).x - local(b).x);
      const ordered = [...pair.slice(0, 2), ...(a3 ? [a3] : [])];
      ordered.slice(0, 3).forEach((a, i) => {
        const slot = slots[i];
        a.pose.cx = inverter.pose.cx + c * slot.x - s * slot.y;
        a.pose.cy = inverter.pose.cy + s * slot.x + c * slot.y;
        a.pose.rotationDeg = ((slot.rot % 360) + 360) % 360;
        a.pose.lengthFt = LG_JF2.length;
        a.pose.widthFt = LG_JF2.width;
      });
    }
  };

  // Built, augmentation, and future groups each retain their own source
  // association. Normalizing cohorts separately prevents a planned container
  // from being attached to a built PCS while still applying the selected
  // climate clearance to every visible traced group.
  const cohorts = new Map<string, { pcs: TraceEquipAdd[]; bess: TraceEquipAdd[] }>();
  for (const a of out) {
    if (a.kind !== 'inverter' && a.kind !== 'bess') continue;
    const key = `${a.augmented === true ? 1 : 0}:${a.future === true ? 1 : 0}`;
    const cohort = cohorts.get(key) ??
      cohorts.set(key, { pcs: [], bess: [] }).get(key)!;
    (a.kind === 'inverter' ? cohort.pcs : cohort.bess).push(a);
  }
  cohorts.forEach(cohort => normalizeCohort(cohort.pcs, cohort.bess));
  return out;
};

// Re-project persisted KMZ equipment for the selected climate without
// rewriting the saved trace records. IDs, labels, flags, manual equipment and
// source associations stay byte-for-byte stable; only the generation-time
// visible pose/footprint changes. Cable routing consumes that same normalized
// visible pose; traceSourcePose remains normalization input only.
export const normalizeTracedPlacedEquipment = (
  specs: readonly PlacedEquipmentSpec[] | undefined,
  config: ReturnType<typeof getConfiguration>,
  hotClimate: boolean,
): PlacedEquipmentSpec[] | undefined => {
  if (!specs?.length) return specs ? [...specs] : undefined;
  const traced: Array<{ index: number; spec: TracedEquipmentSpec; add: TraceEquipAdd }> = [];
  specs.forEach((spec, index) => {
    if (isManualEquipmentSpec(spec) || spec.source !== 'trace') return;
    traced.push({
      index,
      spec,
      add: {
        // Persisted source:'trace' records originate from TraceEquipKind.
        // TracedEquipmentSpec is wider only because it shares the engine's
        // general EquipmentKind shape.
        kind: spec.kind as TraceEquipKind,
        augmented: spec.augmented === true,
        ...(spec.future ? { future: true } : {}),
        pose: {
          cx: spec.x,
          cy: spec.y,
          rotationDeg: spec.rotationDeg ?? 0,
          lengthFt: spec.lengthFt,
          widthFt: spec.widthFt,
        },
        ...(spec.traceSourcePose
          ? { traceSourcePose: { ...spec.traceSourcePose } }
          : {}),
      },
    });
  });
  if (!traced.length) return [...specs];

  const normalized = normalizeTracedEquipmentAdds(
    traced.map(x => x.add),
    config,
    hotClimate,
  );
  const byIndex = new Map<number, TracedEquipmentSpec>();
  traced.forEach(({ index, spec }, i) => {
    const n = normalized[i];
    const next: TracedEquipmentSpec = {
      ...spec,
      x: n.pose.cx,
      y: n.pose.cy,
      lengthFt: n.pose.lengthFt,
      widthFt: n.pose.widthFt,
      traceSourcePose: { ...n.traceSourcePose! },
    };
    if (n.pose.rotationDeg) next.rotationDeg = n.pose.rotationDeg;
    else delete next.rotationDeg;
    byIndex.set(index, next);
  });
  return specs.map((spec, index) => byIndex.get(index) ?? spec);
};

const buildTraceCommitPhases = (
  set: (partial: Partial<DesignState>) => void,
  get: () => DesignState,
  equipAdds: TraceEquipAdd[],
  roadAdds: TraceRoadAdd[],
  historyLabel: string
): { frac: number; label: string; run: () => void }[] | false => {
  if (!equipAdds.length && !roadAdds.length) return false;

  // Re-apply REPLACES the previous auto-fill: a second scan of the same
  // drawing must never stack a duplicate copy of every traced unit on top of
  // the first (capacity, block counts and feeder schedules all doubled).
  // Everything the earlier scan committed (source 'trace' equipment, traced
  // roads, and their stale move/rot offsets) is stripped from every area
  // before the new adds land; manual and drafter-placed gear is untouched.
  // Replacement is scoped per category: a Roads-only re-apply must never
  // erase the traced equipment (and vice versa) — the Equipment/Roads
  // inclusion toggles are independent, so stripping the excluded category
  // would silently delete a traced yard the drafter chose to keep.
  const isFullScanApply = equipAdds.length + roadAdds.length >= 20;
  const stripEquip = isFullScanApply && equipAdds.length > 0;
  const stripRoads = isFullScanApply && roadAdds.length > 0;
  const stripTraced = (prev: LayoutConstraints): LayoutConstraints => {
    if (!stripEquip && !stripRoads) return prev;
    const tracedIds = new Set(
      stripEquip
        ? (prev.placedEquipment ?? [])
            .filter(p => (p as { source?: string }).source === 'trace')
            .map(p => p.id)
        : []);
    const tracedRoad = (r: { traced?: boolean }) => stripRoads && r.traced === true;
    if (!tracedIds.size && !(prev.customRoads ?? []).some(tracedRoad) &&
        !(stripRoads && prev.removedTracedRoads?.length) &&
        !(stripRoads && prev.pavedTracedRoads?.length) &&
        !(stripEquip && prev.tracedRatings)) return prev;
    const next: LayoutConstraints = { ...prev };
    // Sheet-derived nameplate follows the traced equipment it rates.
    if (stripEquip) delete next.tracedRatings;
    const keptEq = (prev.placedEquipment ?? []).filter(p => !tracedIds.has(p.id));
    if (keptEq.length) next.placedEquipment = keptEq; else delete next.placedEquipment;
    const keptRoads = (prev.customRoads ?? []).filter(r => !tracedRoad(r));
    if (keptRoads.length) next.customRoads = keptRoads; else delete next.customRoads;
    // A full re-apply of the trace intentionally restores the complete drawn
    // road set: clear the deletion tombstones so previously deleted traced
    // strips return with it (documented behavior of Apply, not a leak).
    if (stripRoads && next.removedTracedRoads) delete next.removedTracedRoads;
    // Pave-as-drawn overrides reset with it — Apply restores the tool's own
    // gate-apron judgment; the drafter re-applies the override if the longer
    // drive really is pavement (mirrors the tombstone rule above).
    if (stripRoads && next.pavedTracedRoads) delete next.pavedTracedRoads;
    const moves = Object.fromEntries(
      Object.entries(prev.equipMoves ?? {}).filter(([id]) => !tracedIds.has(id)));
    if (Object.keys(moves).length) next.equipMoves = moves; else delete next.equipMoves;
    const rots = Object.fromEntries(
      Object.entries(prev.equipRots ?? {}).filter(([id]) => !tracedIds.has(id)));
    if (Object.keys(rots).length) next.equipRots = rots; else delete next.equipRots;
    return next;
  };

  // Real names in drawing order: "PCS 1", "BATT 12", "CONEX 2", "AUG PCS 3".
  // Counters continue past the highest label already placed anywhere on the
  // site (AFTER the replaced trace is stripped, so a re-scan numbers from 1
  // again instead of climbing forever), so a bulk tag never duplicates a name.
  const labelSeq = new Map<string, number>();
  const seedFrom = (edits: LayoutConstraints | undefined) => {
    for (const p of stripTraced(edits ?? {}).placedEquipment ?? []) {
      // Catalog-driven manual gear carries no drawn label to seed from.
      if (isManualEquipmentSpec(p)) continue;
      const m = /^((?:AUG )?(?:BATT|PCS|CONEX|GEN)) (\d+)$/.exec(p.label ?? '');
      if (m) labelSeq.set(m[1], Math.max(labelSeq.get(m[1]) ?? 0, parseInt(m[2], 10)));
    }
  };
  seedFrom(get().layoutEdits);
  for (const a of get().siteAreas) {
    if (a.id !== get().activeAreaId) seedFrom(a.edits?.layoutEdits);
  }
  const labelFor = (a: TraceEquipAdd): string | undefined => {
    const base = a.kind === 'bess' ? 'BATT'
      : a.kind === 'inverter' ? 'PCS'
      : a.kind === 'conex' ? 'CONEX'
      : a.kind === 'generator' ? 'GEN'
      : null;
    if (!base) return undefined;
    const key = (a.future ? 'FUT ' : a.augmented ? 'AUG ' : '') + base;
    const n = (labelSeq.get(key) ?? 0) + 1;
    labelSeq.set(key, n);
    return `${key} ${n}`;
  };

  // Multi-area routing: each traced item/road lands in the area whose
  // footprint contains it, so scanning once fills EVERY footprint instead of
  // dumping the whole site into the active area. Items outside every
  // footprint stay with the active area (reference-wins, warned there).
  const s0 = get();
  const activeId = s0.activeAreaId;
  const multiArea = s0.siteAreas.length > 1 && !!activeId;
  const areaOf = (x: number, y: number): string | null => {
    if (!multiArea) return null;
    for (const a of s0.siteAreas) {
      if (kmzPointInPolygon({ x, y }, a.boundary.polygon)) return a.id;
    }
    return null;
  };
  const bucketEquip = new Map<string, TraceEquipAdd[]>();
  // Equipment outside EVERY footprint on a multi-area site: gate/entry gear
  // that hugs a fence still attaches to the nearest area within a short
  // reach, but genuinely distant shapes (detail insets, legend samples,
  // spacing diagrams drawn far off the yards) are dropped with a warning —
  // dumping them into the active area doubled its equipment and capacity.
  const EQUIP_REACH_FT = 200;
  let droppedEquip = 0;
  const nearestAreaWithin = (x: number, y: number, reach: number): string | null => {
    let best: string | null = null, bd = reach;
    for (const a of s0.siteAreas) {
      const poly = a.boundary.polygon;
      for (let i = 0; i < poly.length; i++) {
        const q0 = poly[i], q1 = poly[(i + 1) % poly.length];
        const dx = q1.x - q0.x, dy = q1.y - q0.y;
        const L2 = dx * dx + dy * dy;
        const t = L2 > 0 ? Math.max(0, Math.min(1, ((x - q0.x) * dx + (y - q0.y) * dy) / L2)) : 0;
        const d = Math.hypot(x - (q0.x + t * dx), y - (q0.y + t * dy));
        if (d < bd) { bd = d; best = a.id; }
      }
    }
    return best;
  };
  for (const a of equipAdds) {
    let id = areaOf(a.pose.cx, a.pose.cy);
    if (!id && multiArea) {
      id = nearestAreaWithin(a.pose.cx, a.pose.cy, EQUIP_REACH_FT);
      if (!id) { droppedEquip++; continue; }
    }
    const key = id ?? activeId ?? '_';
    (bucketEquip.get(key) ?? bucketEquip.set(key, []).get(key)!).push(a);
  }
  // Normalize independently inside every owning area. Equipment from adjacent
  // BESS footprints must never be associated into one physical block.
  const traceConfig = getConfiguration(s0.configId);
  bucketEquip.forEach((list, key) => {
    bucketEquip.set(
      key,
      normalizeTracedEquipmentAdds(list, traceConfig, s0.hotClimate),
    );
  });
  // Roads are bucketed to the owning site area (majority vote, then ring-probe
  // reach for wholly-outside gate aprons) — one shared implementation with the
  // stale-save re-derivation so the two never disagree (see bucketTracedRoadAdds).
  const droppedRoads: number[] = [];
  const bucketRoads = bucketTracedRoadAdds(roadAdds, s0.siteAreas, activeId, multiArea, droppedRoads);

  // ---- one gate crossing per area (prune + flags) --------------------------
  // Exactly ONE road crosses each area's fence: the gate entrance — the drawn
  // wide-to-narrow flare when the drawing has one, otherwise the widest
  // fence-crossing road. Fence-crossing strips are clustered by crossing
  // location; the cluster at the drawing's gate ticks / flare (or carrying
  // the most strips) is the gate, every other crossing strip is trimmed back
  // to its inside-the-fence run, and only entrance-flagged roads may keep
  // pavement outside the fence — the layout engine clips the rest to the
  // fence interior. Manual layouts use the selected fence placement; KMZ
  // traced BESS areas use the property boundary itself.
  // Old saved traced designs (no flags) heal during regenerateAreas via
  // migrateLegacyTracedRoads. The prune→flag sequence lives in
  // deriveTracedGateSet, shared verbatim with the stale-save re-derivation,
  // so the scan and the heal can never drift apart again.
  const editsForKey = (key: string): LayoutConstraints | undefined => {
    const area = s0.siteAreas.find(a => a.id === key);
    return key === activeId ? s0.layoutEdits : area?.edits?.layoutEdits;
  };
  const keyUsesTracedFence = (key: string): boolean =>
    (bucketEquip.get(key) ?? []).some(a => a.kind === 'inverter' || a.kind === 'bess') ||
    isTracedBessYard(editsForKey(key));
  const fenceForKey = (key: string): Pt[] | null => {
    const area = s0.siteAreas.find(a => a.id === key);
    const poly = area?.boundary.polygon ?? s0.boundary?.polygon;
    if (!poly || poly.length < 3) return null;
    const f = fencePolygonFor(
      poly, keyUsesTracedFence(key) ? 'property-line' : s0.fencePlacement);
    return f.length >= 3 ? f : null;
  };
  bucketRoads.forEach((rds, key) => {
    const flagFence = fenceForKey(key);
    if (!flagFence) return;
    const area = s0.siteAreas.find(a => a.id === key);
    const areaDesign = key === activeId ? s0.design : area?.design;
    const prunePoly = multiArea && area
      ? (keyUsesTracedFence(key)
          ? area.boundary.polygon
          : (areaDesign?.fence?.length ? areaDesign.fence : area.boundary.polygon))
      : null;
    // Pave-as-drawn overrides survive a partial apply (existing roads kept),
    // but a FULL re-apply resets them (stripTraced clears the list — Apply
    // restores the tool's own gate-apron judgment), so never resurrect from
    // a list that is about to be cleared.
    const areaEdits = editsForKey(key);
    const pavedForKey = stripRoads ? undefined : areaEdits?.pavedTracedRoads;
    const { kept, droppedLens } = deriveTracedGateSet(rds, s0.drawing, prunePoly, flagFence, pavedForKey);
    droppedRoads.push(...droppedLens);
    bucketRoads.set(key, kept);
  });

  // Client-declared nameplate from the package's sheet specifications: the
  // declared site MW/MWh split evenly across every BUILT traced PCS/container
  // landing anywhere on the site, so each area reads its share of the
  // client's own rating (e.g. 500 MW / 176 PCS ⇒ a 44-PCS area reads 125 MW)
  // instead of PCS-count × the tool's block rating.
  const sheetSpecs = s0.drawing?.sheetSpecs;
  const allAdds: TraceEquipAdd[] = [];
  bucketEquip.forEach(list => allAdds.push(...list));
  const tracedRatings = tracedRatingsFromSpecs(sheetSpecs, allAdds);

  // Extend one edit record with its bucket (numbering continues past whatever
  // that area already has; stale move/rot edits for reused ids are stripped
  // so a freshly traced item is never nudged by a leftover offset).
  const extendEdits = (prev: LayoutConstraints, adds: TraceEquipAdd[], rds: TraceRoadAdd[]): LayoutConstraints => {
    let nextPeq = 1;
    for (const p of prev.placedEquipment ?? []) {
      const m = /^peq-(\d+)$/.exec(p.id);
      if (m) nextPeq = Math.max(nextPeq, parseInt(m[1], 10) + 1);
    }
    let nextRoad = 1;
    for (const r of prev.customRoads ?? []) {
      const m = /^troad-(\d+)$/.exec(r.id);
      if (m) nextRoad = Math.max(nextRoad, parseInt(m[1], 10) + 1);
    }
    const placedEquipment = [...(prev.placedEquipment ?? [])];
    const customRoads = [...(prev.customRoads ?? [])];
    const newIds: string[] = [];
    for (const a of adds) {
      const id = `peq-${nextPeq++}`;
      newIds.push(id);
      const label = labelFor(a);
      placedEquipment.push({
        id,
        kind: a.kind,
        x: a.pose.cx, y: a.pose.cy,
        ...(a.pose.rotationDeg ? { rotationDeg: a.pose.rotationDeg } : {}),
        lengthFt: a.pose.lengthFt, widthFt: a.pose.widthFt,
        heightFt: traceKindHeight(a.kind),
        ...(a.traceSourcePose ? { traceSourcePose: { ...a.traceSourcePose } } : {}),
        ...(label ? { label } : {}),
        source: 'trace' as const,
        ...(a.augmented ? { augmented: true } : {}),
        ...(a.future ? { future: true } : {}),
      });
    }
    for (const r of rds) {
      customRoads.push({
        id: `troad-${nextRoad++}`,
        pts: r.pts.map(p => ({ x: p.x, y: p.y })),
        width: Math.max(12, Math.min(60, r.widthFt)),
        traced: true,
        tracedV: TRACED_ROAD_RULES_V,
        ...(r.outline ? { outline: r.outline.map(p => ({ x: p.x, y: p.y })) } : {}),
        ...(r.surface ? { surface: r.surface.map(p => ({ x: p.x, y: p.y })) } : {}),
        ...(r.entrance ? { entrance: true } : {}),
        ...(r.gate ? { gate: { x: r.gate.x, y: r.gate.y } } : {}),
        ...(r.apron ? { apron: true } : {}),
      });
    }
    const equipMoves = { ...(prev.equipMoves ?? {}) };
    const equipRots = { ...(prev.equipRots ?? {}) };
    newIds.forEach(id => { delete equipMoves[id]; delete equipRots[id]; });
    const next: LayoutConstraints = {
      ...prev,
      ...(placedEquipment.length ? { placedEquipment } : {}),
      ...(customRoads.length ? { customRoads } : {}),
      // Sheet-declared nameplate rides along with the traced equipment it
      // rates; areas that received no traced adds keep their prior state.
      ...(tracedRatings && adds.length ? { tracedRatings } : {}),
    };
    if (Object.keys(equipMoves).length) next.equipMoves = equipMoves; else delete next.equipMoves;
    if (Object.keys(equipRots).length) next.equipRots = equipRots; else delete next.equipRots;
    return next;
  };

  // ONE undoable commit: traced roads force compact layout mode (the trace
  // provides the road network, so the automatic interior roads step aside).
  // Structured as named phases so the auto-fill Apply can drive a determinate
  // progress bar — sync callers (bulk tag) just run the phases back to back.
  const before = snapOf(get(), historyLabel);
  let touchedOthers = false;

  const phases: { frac: number; label: string; run: () => void }[] = [
    {
      frac: 0.15, label: 'Placing traced equipment and roads', run: () => {
        const activeKey = activeId ?? '_';
        const nextEdits = extendEdits(
          stripTraced(get().layoutEdits),
          bucketEquip.get(activeKey) ?? [],
          bucketRoads.get(activeKey) ?? []
        );
        set({
          layoutEdits: nextEdits,
          ...(roadAdds.length ? { roadMode: 'compact' as RoadMode } : {}),
          lastRejection: null,
        });
        // Other areas: fold each bucket onto that area's own edit record.
        if (multiArea) {
          const nextAreas = get().siteAreas.map(a => {
            if (a.id === activeId) return a;
            const adds = bucketEquip.get(a.id) ?? [];
            const rds = bucketRoads.get(a.id) ?? [];
            const prev0 = a.edits?.layoutEdits ?? {};
            const cleaned = stripTraced(prev0);
            // A full re-scan also REPLACES an area whose bucket is empty this
            // time (its old traced fill must not linger as duplicates).
            if (!adds.length && !rds.length && cleaned === prev0) return a;
            touchedOthers = true;
            const prev = cleaned;
            return { ...a, edits: { ...(a.edits ?? {}), layoutEdits: extendEdits(prev, adds, rds) } };
          });
          if (touchedOthers) set({ siteAreas: nextAreas });
        }
      },
    },
    { frac: 0.45, label: 'Rebuilding this area', run: () => get().regenerate({ sync: true }) },
    {
      frac: 0.75, label: 'Filling the other areas', run: () => {
        if (touchedOthers) get().regenerateAreas();
      },
    },
    {
      frac: 0.95, label: 'Finishing up', run: () => {
        const warns = (get().design?.warnings ?? []).filter(w =>
          w.startsWith('Placed equipment') || w.startsWith('Traced road'));
        if (droppedRoads.length) {
          warns.push(
            `${droppedRoads.length} traced road segment${droppedRoads.length === 1 ? '' : 's'} ` +
            'outside every area footprint skipped — roads only land inside an area.');
        }
        if (droppedEquip > 0) {
          warns.push(
            `${droppedEquip} reference shape${droppedEquip === 1 ? '' : 's'} far outside every ` +
            'area footprint skipped (detail/legend views in the drawing are not yard equipment).');
        }
        set({ lastPlacedWarning: warns.length ? warns.join('\n') : null });
        get().pushHistory(before);
      },
    },
  ];
  return phases;
};

// Build the equipment/road add lists a trace apply commits, in drawing order.
// null = no plan; empty lists = plan present but nothing selected.
const buildTraceAdds = (
  plan: DesignState['tracePlan'],
  incl: { equipment: boolean; roads: boolean },
  opts?: { equipment?: boolean; roads?: boolean }
): { equipAdds: TraceEquipAdd[]; roadAdds: TraceRoadAdd[]; sitePoiMW?: number } | null => {
  if (!plan) return null;
  const doEquip = opts?.equipment ?? incl.equipment;
  const doRoads = opts?.roads ?? incl.roads;
  const equipAdds: TraceEquipAdd[] = [];
  const roadAdds: TraceRoadAdd[] = [];
  if (doEquip) {
    for (const it of plan.items) {
      equipAdds.push({
        kind: it.kind, augmented: it.augmented,
        ...(it.future ? { future: true } : {}),
        pose: it.pose,
      });
    }
    for (const u of plan.unknowns) {
      if (u.tag !== 'road' && u.tag !== 'ignore') equipAdds.push({ kind: u.tag, augmented: false, pose: u.pose });
    }
  }
  if (doRoads) {
    for (const r of plan.roads) for (const s of r.strips) {
      if (s.pts.length >= 2) {
        roadAdds.push({
          pts: s.pts, widthFt: s.widthFt,
          ...(s.outline && s.outline.length >= 3 ? { outline: s.outline } : {}),
          ...(s.surface && s.surface.length >= 3 ? { surface: s.surface } : {}),
        });
      }
    }
    for (const u of plan.unknowns) {
      if (u.tag === 'road') {
        // A road-tagged unknown is a rectangle: one strip along its long axis.
        const rad = (u.pose.rotationDeg * Math.PI) / 180;
        const hl = u.pose.lengthFt / 2;
        const dx = Math.cos(rad) * hl, dy = Math.sin(rad) * hl;
        roadAdds.push({
          pts: [{ x: u.pose.cx - dx, y: u.pose.cy - dy }, { x: u.pose.cx + dx, y: u.pose.cy + dy }],
          widthFt: u.pose.widthFt,
        });
      }
    }
  }
  return { equipAdds, roadAdds, ...(plan.sitePoiMW ? { sitePoiMW: plan.sitePoiMW } : {}) };
};

// Run the trace-commit phases synchronously (bulk tag, tests).
const commitTraceAdds = (
  set: (partial: Partial<DesignState>) => void,
  get: () => DesignState,
  equipAdds: TraceEquipAdd[],
  roadAdds: TraceRoadAdd[],
  historyLabel: string
): boolean => {
  const phases = buildTraceCommitPhases(set, get, equipAdds, roadAdds, historyLabel);
  if (!phases) return false;
  for (const p of phases) p.run();
  return true;
};

const finishPlacedEquipmentEdit = (
  get: () => DesignState,
  set: (patch: Partial<DesignState>) => void,
  id: string,
  prevEdits: LayoutConstraints,
  before: HistorySnap
): string | null => {
  get().regenerate({ sync: true });
  const rejectPrefix = `Placed equipment ${id} rejected: `;
  const rejected = get().design?.warnings.find(w => w.startsWith(rejectPrefix));
  if (rejected) {
    set({ layoutEdits: prevEdits });
    get().regenerate({ sync: true });
    return rejected
      .slice(rejectPrefix.length)
      .replace(/\s*—\s*move or remove it in the layout edits panel\.\s*$/, '')
      .trim();
  }
  const warnPrefix = `Placed equipment ${id} placed with warning: `;
  const soft = (get().design?.warnings ?? [])
    .filter(w => w.startsWith(warnPrefix))
    .map(w => w.slice(warnPrefix.length).replace(/\s*—\s*[^—]*\.\s*$/, '').trim());
  set({ lastPlacedWarning: soft.length ? soft.join('; ') : null });
  get().pushHistory(before);
  return null;
};
// State patch that restores a snapshot's design inputs.
const restoreFields = (snap: HistorySnap) => ({
  configId: snap.configId,
  targetMW: snap.targetMW,
  targetMWh: snap.targetMWh,
  hotClimate: snap.hotClimate,
  containersPerPcs: snap.containersPerPcs ?? DEFAULT_CONTAINERS_PER_PCS,
  roadMode: snap.roadMode,
  autoRoadWrap: snap.autoRoadWrap ?? true,
  ringMode: snap.ringMode ?? 'fence',
  perimeterBand: snap.perimeterBand ?? 'standard',
  fencePlacement: snap.fencePlacement ?? 'inset',
  laydownPct: snap.laydownPct,
  augmentPct: snap.augmentPct,
  futurePhaseUnits: sanitizeFuturePhaseUnits(snap.futurePhaseUnits),
  surfacingMode: snap.surfacingMode ?? 'between-roads',
  surfacingDepthIn: snap.surfacingDepthIn ?? SURFACING_DEPTH_IN_DEFAULT,
  deadSpaceTrim: snap.deadSpaceTrim ?? false,
  dcRouting: snap.dcRouting ?? 'orthogonal',
  feederRoutingMode: snap.feederRoutingMode === 'angled' ? 'angled' as const : 'orthogonal' as const,
  textureSetId: isYardTextureSetId(snap.textureSetId) ? snap.textureSetId : DEFAULT_TEXTURE_SET_ID,
  gePcsColor: snap.gePcsColor === undefined ? GE_PCS_GREEN : sanitizePcsColor(snap.gePcsColor),
  arrangement: snap.arrangement,
  arrangementExplicit: snap.arrangementExplicit === true,
  latticeShift: snap.latticeShift,
  gateEdge: snap.gateEdge,
  layoutEdits: snap.layoutEdits,
  // Merge with defaults so snapshots/sessions saved before a field existed
  // (e.g. neerDwgName) restore with an empty string, not undefined.
  titleBlock: { ...defaultTitleBlock(), ...snap.titleBlock },
  substation: snap.substation,
  // Only restore take-offs the snapshot actually recorded — older snapshots
  // (pre-feature) must not wipe the drafter's current ones. `null` IS a
  // recorded value, so the check is for `undefined` specifically.
  ...(snap.takeoffs !== undefined
    ? { takeoffs: snap.takeoffs === null ? null : sanitizeTakeoffs(snap.takeoffs) ?? null }
    : {}),
  feederAssignments: snap.feederAssignments,
  feederSizes: snap.feederSizes,
  feederMaterial: snap.feederMaterial,
  maxPcsPerFeeder: sanitizeFeederCap(snap.maxPcsPerFeeder),
  yardRotationDeg: sanitizeYardRotation(snap.yardRotationDeg),
  // Only restore zones the snapshot actually recorded — older snapshots
  // (pre-feature) must not wipe the drafter's current zones.
  ...(snap.areaZones !== undefined ? { areaZones: sanitizeAreaZones(snap.areaZones) } : {}),
  // Only restore the legend style when the snapshot recorded it — older
  // snapshots (pre-toggle-history) must not flip the drafter's current choice.
  ...(snap.eciLegend !== undefined ? { eciLegend: snap.eciLegend === true } : {}),
  // Same pre-feature rule for the feeder/NFPA text visibility toggle.
  ...(snap.showFeederNfpaText !== undefined ? { showFeederNfpaText: snap.showFeederNfpaText === true } : {}),
  drawingVisibility: sanitizeDrawingVisibilityProfile(snap.drawingVisibility),
});

// ---------------------------------------------------------------------------
// First-load visibility for an imported CAD drawing.
//
// A full site export is dense (the Big Iron file draws ~137k line features,
// most of them in ROAD and the two DC yards). Showing every layer at once on
// first load buries the generated design under client linework, so the
// heaviest layers start hidden and everything else starts visible. The drafter
// turns any layer back on from the layer list — nothing is discarded.
const DRAWING_HEAVY_VERTEX_LIMIT = 20000;
export const defaultDrawingLayerVis = (drawing: ImportedDrawing | null): Record<string, boolean> => {
  const vis: Record<string, boolean> = {};
  for (const layer of drawing?.layers ?? []) {
    // Annotation-only layers (MV feeder routes, callout leaders, labels…)
    // classify as 'ignore' for the trace scan — the generated design draws
    // its own feeders, so this linework starts hidden too. The drafter can
    // turn any layer back on from the layer list; nothing is discarded.
    vis[layer.name] = layer.vertexCount <= DRAWING_HEAVY_VERTEX_LIMIT
      && classifyTraceName(layer.name)?.kind !== 'ignore';
  }
  return vis;
};

// Saved layer-visibility maps predating the annotation-hide default carry
// `true` for those layers — strip them so the (hidden) default wins on load.
// A drafter can still re-show them per session from the layer list.
export const dropAnnotationVis = (saved: Record<string, boolean> | undefined | null): Record<string, boolean> => {
  if (!saved) return {};
  return Object.fromEntries(Object.entries(saved).filter(
    ([name, v]) => !(v === true && classifyTraceName(name)?.kind === 'ignore')));
};

// ---------------------------------------------------------------------------
// Session autosave + project file (.json) shape. Version-gated so future
// format changes can migrate or reject cleanly.
export const PROJECT_FILE_VERSION = 1;
const SESSION_KEY = 'nextera-session-v1';

export interface ProjectFile {
  version: number;
  savedAt: string;
  boundary: SiteBoundary;
  configId: string;
  targetMW: number;
  targetMWh: number;
  hotClimate: boolean;
  // LG JF2 containers per PCS block (3 or 4). Optional — absent means the
  // file predates the toggle and was generated at QTY 4 (legacy default).
  containersPerPcs?: number;
  roadMode: RoadMode;
  // Optional — absent means the file predates the toggle; those load as
  // true (auto-wrap roads around placed/moved equipment, the historical
  // behavior). Serialized only when false so older files stay byte-stable.
  autoRoadWrap?: boolean;
  // Perimeter ring style. Optional — absent means the file predates the
  // selector; those load as 'fence' (full fence ring, the default).
  ringMode?: RingMode;
  // Perimeter band edge. Optional — absent means the file predates the
  // option; those load as 'standard' (10 ft inset, the legacy default).
  perimeterBand?: PerimeterBandMode;
  // Security fence placement. Optional — absent means the file predates the
  // option; those load as 'inset' (the typical lot-line setback), so a legacy
  // project always reopens with the fence exactly where it was drawn.
  fencePlacement?: FencePlacementMode;
  laydownPct: number;
  augmentPct: number;
  // Explicit future-phase augmentation units (2 PCS + 6 BESS each). Optional —
  // absent means the file predates the option (defaults to 0).
  futurePhaseUnits?: number;
  // Crushed-rock surfacing coverage + depth. Optional — absent means the file
  // predates surfacing (defaults: 'between-roads', 4").
  surfacingMode?: SurfacingMode;
  surfacingDepthIn?: number;
  // Dead-space trim (fence hull + courtyard clip). Optional — absent means
  // the file predates the option (defaults off, legacy geometry).
  deadSpaceTrim?: boolean;
  // DC container-run routing method. Optional — absent means the file
  // predates the option (defaults to the sheet-3 90° trench legs).
  dcRouting?: DcRoutingMode;
  // MV home-run routing default. Optional and only written when 'angled' so
  // files that never touched the option stay byte-identical (absent =
  // 'orthogonal', the legacy 90° corridor comb).
  feederRoutingMode?: FeederRoutingMode;
  // 3D-preview yard texture set. Optional — absent means the file predates
  // the picker (default 'classic', the original look). Never affects DXF/PDF.
  textureSetId?: YardTextureSetId;
  // GE PCS exterior color ('#rrggbb'). Optional — written only when set, so
  // factory-look files keep the exact legacy shape (byte-identity). Display
  // only: recolors the 3D model texture (body -> color, baked logos -> white)
  // and the simple-box preview; never read by the DXF/PDF exporters.
  gePcsColor?: string | null;
  // Feeder-color preview toggle (colored vs. monochrome plan-check view).
  // Carried in the project file like textureSetId so a shared file reproduces
  // the same view. Optional — absent means the file predates the toggle; the
  // drafter's local (per-browser) preference is kept in that case. Never
  // affects DXF/PDF exports.
  showFeederColors?: boolean;
  // Legend equipment symbol style: true = ECI reference symbols. Optional
  // and only written when true so files that never touched the option stay
  // byte-identical (absent = default baked GLB traces).
  eciLegend?: boolean;
  // Feeder & NFPA annotation text on the CAD view and DXF/PDF exports.
  // Optional and only written when true so files that never touched the
  // option stay byte-identical (absent = hidden, the CAD-view default).
  showFeederNfpaText?: boolean;
  // DECISION (2026-07-22): showSatellite / showFence3D / showGateModel do NOT
  // travel in the project file. They are per-browser view toggles only:
  // satellite triggers network tile loads (server-side Cesium token,
  // bandwidth-heavy), and fence/gate 3D models are per-machine performance
  // choices. Unlike textureSetId/showFeederColors they never change how the
  // shared design content reads, so a shared file must not override them.
  arrangement: ArrangementStrategy;
  // True only when the drafter actually picked an arrangement. Absent means
  // "no choice recorded", which is what lets an untouched multi-area
  // footprint keep its automatic road-aware packing search while a
  // deliberately selected SW (identical in value to the default) disables it.
  arrangementExplicit?: boolean;
  // Optimizer baseline knobs (optional — absent in older files = defaults).
  latticeShift?: Pt | null;
  gateEdge?: GateEdge | null;
  layoutEdits: LayoutConstraints;
  titleBlock: TitleBlockInfo;
  // LGIA data sheet project inputs (transformer %Z, ride-through settings,
  // UL 1741 SB cert details). Optional — absent in older files = all
  // placeholders; invalid values snap back on load (sanitizeLgiaInputs).
  lgiaInputs?: LgiaInputs;
  substation: Pt | null;
  // Substation MV take-offs for the ACTIVE area (multi-area sites). Optional —
  // absent in files that predate the feature, and in every single-area file.
  takeoffs?: SubstationTakeoff[] | null;
  feederAssignments: Record<string, number>;
  feederSizes: Record<number, FeederConductorSize>;
  feederMaterial: ConductorMaterial;
  // Max PCS units per MV feeder (5 or 6). Optional — absent means the
  // file predates the selector (default 6, the NextEra Puma reference cap).
  maxPcsPerFeeder?: number;
  // Grading-optimized yard rotation (degrees, [0, 180)). Optional — absent
  // means the file predates the feature (0°, the unrotated pose). Invalid
  // values fall back to 0 on load rather than rejecting the file.
  yardRotationDeg?: number;
  // Multi-pad grading zones (engineering inputs — they travel with the
  // project like layoutEdits, never localStorage). Optional and only written
  // when non-empty so older/zone-free files stay byte-identical.
  gradingZones?: GradingZone[];
  // Drafter-drawn area zones (dry pond / wet pond / laydown yard /
  // underground exclusion annotation rectangles). Optional and only written
  // when non-empty so older/zone-free files stay byte-identical.
  areaZones?: AreaZone[];
  // Energy/dispatch simulation (RTE + degradation + augmentation planning).
  // Engineering inputs that change the study results, so they travel with the
  // project. Optional and only written while the study is enabled so files
  // that never touched the feature stay byte-identical.
  energySim?: { enabled: boolean; inputs: EnergySimInputs };
  // Drafter text-label overrides (position/height/content deltas keyed by
  // label fingerprint). Optional and only written when non-empty so designs
  // without overrides keep the exact legacy project file shape.
  textOverrides?: Record<string, TextOverride>;
  // Undo/redo timeline. Present only in the session autosave (history survives
  // an accidental tab close within a session). Never written to exported
  // project files — opening a project starts a clean history.
  history?: { undo: HistorySnap[]; redo: HistorySnap[] };
  // Multi-area sites: every imported footprint, in the SHARED projection
  // frame, plus which one was being edited. Optional and only written when the
  // project really has several areas, so single-boundary files keep the exact
  // legacy shape (byte-identity).
  //
  // Only the INPUTS are stored, never the generated layout: each area's
  // boundary, kind and its own edit state. The designs are regenerated on
  // load, exactly as the single-area path already does. A file without this
  // key loads as the single-area project it is.
  siteAreas?: SavedSiteArea[];
  activeAreaId?: string | null;
  // Imported CAD reference drawing. The geometry itself is far too large for
  // this blob (a full site export runs to ~261k vertices), so it lives in
  // IndexedDB; only the display state travels here. Written only when a
  // drawing exists, so projects without one keep the exact legacy shape.
  drawingLayerVis?: Record<string, boolean>;
  showDrawing?: boolean;
  // Generated-drawing subsystem visibility. Absent in legacy files means all
  // generated systems remain visible. Omitted on save while all are visible.
  drawingVisibility?: DrawingVisibilityProfile;
}

// One area's saved state: its parcel plus the per-area edit inputs that used
// to live only in the mirrored top-level fields. Everything except id/name/
// kind/boundary is optional so an untouched area stays small in the file.
export interface SavedSiteArea {
  id: string;
  name: string;
  kind: SiteArea['kind'];
  boundary: SiteBoundary;
  layoutEdits?: LayoutConstraints;
  substation?: Pt | null;
  // Substation areas only: the drafter's MV take-offs. Absent = never edited
  // (the automatic take-offs are used), so untouched files keep the legacy
  // shape byte-for-byte.
  takeoffs?: SubstationTakeoff[];
  feederAssignments?: Record<string, number>;
  gradingZones?: GradingZone[];
  areaZones?: AreaZone[];
  gateEdge?: GateEdge | null;
  arrangement?: ArrangementStrategy;
  latticeShift?: Pt | null;
}

// Keep only well-formed history entries from an untrusted saved session.
const sanitizeHistory = (h: any): { undo: HistorySnap[]; redo: HistorySnap[] } => {
  const ok = (e: any): e is HistorySnap =>
    !!e && typeof e === 'object' &&
    typeof e.label === 'string' && e.label.length > 0 &&
    typeof e.configId === 'string' &&
    Number.isFinite(e.targetMW) && Number.isFinite(e.targetMWh) &&
    typeof e.layoutEdits === 'object' && e.layoutEdits !== null &&
    typeof e.titleBlock === 'object' && e.titleBlock !== null;
  // Snap layoutEdits are re-applied on undo/redo, so they get the same deep
  // finite-number sanitization as the live layoutEdits on load.
  const take = (a: any): HistorySnap[] => (Array.isArray(a)
    ? a.filter(ok).slice(-HISTORY_LIMIT).map(e2 => ({
        ...e2,
        layoutEdits: sanitizeLayoutEdits(e2.layoutEdits),
        drawingVisibility: sanitizeDrawingVisibilityProfile(e2.drawingVisibility),
      }))
    : []);
  return { undo: take(h?.undo), redo: take(h?.redo) };
};

// Sanitize an untrusted textOverrides map (project file / session).
// Invalid or non-finite entries are silently dropped; a fully empty map
// returns {} so the absence case stays byte-identical to the default.
function sanitizeTextOverrides(raw: any): Record<string, TextOverride> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, TextOverride> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof k !== 'string') continue;
    const ov = v as any;
    if (!ov || typeof ov !== 'object') continue;
    if (!Number.isFinite(ov.dx) || !Number.isFinite(ov.dy)) continue;
    out[k] = {
      dx: Number(ov.dx),
      dy: Number(ov.dy),
      ...(typeof ov.text === 'string' ? { text: ov.text } : {}),
      ...(Number.isFinite(ov.h) && (ov.h as number) > 0 ? { h: Number(ov.h) } : {}),
    };
  }
  return out;
}

// ---- Multi-area persistence ------------------------------------------------
//
// Each area owns the edits made while it was the active footprint. Only the
// INPUTS are stored (never the generated design), so a restored project lays
// out from the same inputs the drafter left behind.

// Pull the live mirrored edit state into a per-area edit record. Fields are
// omitted when they hold their default, so an untouched area serializes as
// `undefined` and the file keeps the legacy shape.
export const captureAreaEdits = (s: {
  layoutEdits: LayoutConstraints;
  substation: Pt | null;
  takeoffs: SubstationTakeoff[] | null;
  feederAssignments: Record<string, number>;
  gradingZones: GradingZone[];
  areaZones: AreaZone[];
  gateEdge: GateEdge | null;
  arrangement: ArrangementStrategy;
  // Optional so callers that never expose an arrangement picker (and the
  // pristine-capture tests) keep working: absent = not explicitly chosen.
  arrangementExplicit?: boolean;
  latticeShift: Pt | null;
}): SiteAreaEdits | undefined => {
  const e: SiteAreaEdits = {};
  if (Object.keys(s.layoutEdits).length) e.layoutEdits = s.layoutEdits;
  if (s.substation) e.substation = s.substation;
  // null = never edited (use the automatic take-offs); an empty ARRAY means
  // the drafter deliberately removed them all, so it must be persisted.
  if (s.takeoffs) e.takeoffs = s.takeoffs;
  if (Object.keys(s.feederAssignments).length) e.feederAssignments = s.feederAssignments;
  if (s.gradingZones.length) e.gradingZones = s.gradingZones;
  if (s.areaZones.length) e.areaZones = s.areaZones;
  if (s.gateEdge !== null) e.gateEdge = s.gateEdge;
  // The PRESENCE of the arrangement key is what marks a deliberate choice.
  // A drafter who selects SW picks the same value as the default, so the key
  // must still be written for them — otherwise their choice is
  // indistinguishable from an untouched area and the automatic road-aware
  // packing search would override it.
  if (s.arrangementExplicit === true || s.arrangement !== 'sw') e.arrangement = s.arrangement;
  if (s.latticeShift) e.latticeShift = s.latticeShift;
  return Object.keys(e).length ? e : undefined;
};

// Expand a per-area edit record back into the mirrored top-level fields.
// Absent fields come back as their documented defaults, so switching to a
// never-edited area produces the same pristine state a fresh import has.
export const areaEditsToState = (e: SiteAreaEdits | undefined) => ({
  layoutEdits: e?.layoutEdits ?? {},
  substation: e?.substation ?? null,
  // null = never edited: the area uses its automatic take-offs.
  takeoffs: e?.takeoffs ?? null,
  feederAssignments: e?.feederAssignments ?? {},
  gradingZones: e?.gradingZones ?? [],
  areaZones: e?.areaZones ?? [],
  gateEdge: e?.gateEdge ?? null,
  arrangement: e?.arrangement ?? 'sw' as ArrangementStrategy,
  arrangementExplicit: e?.arrangement !== undefined,
  latticeShift: e?.latticeShift ?? null,
});

// Sanitize one untrusted saved edit record. Same policy as the single-area
// loaders: every field is validated independently and an invalid one falls
// back to automatic rather than rejecting the file.
const sanitizeAreaEdits = (raw: any): SiteAreaEdits | undefined => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const arrangements: ArrangementStrategy[] = ['sw', 'se', 'nw', 'ne'];
  const e: SiteAreaEdits = {};
  const le = sanitizeLayoutEdits(raw.layoutEdits);
  if (Object.keys(le).length) e.layoutEdits = le;
  const sub = sanitizeSubstation(raw.substation);
  if (sub) e.substation = sub;
  const tk = sanitizeTakeoffs(raw.takeoffs);
  if (tk) e.takeoffs = tk;
  const fa = sanitizeFeederAssignments(raw.feederAssignments);
  if (Object.keys(fa).length) e.feederAssignments = fa;
  const gz = sanitizeGradingZones(raw.gradingZones);
  if (gz.length) e.gradingZones = gz;
  const az = sanitizeAreaZones(raw.areaZones);
  if (az.length) e.areaZones = az;
  if (raw.gateEdge && ['S', 'N', 'E', 'W'].includes(raw.gateEdge)) e.gateEdge = raw.gateEdge;
  if (arrangements.includes(raw.arrangement)) e.arrangement = raw.arrangement;
  if (finitePt(raw.latticeShift)) e.latticeShift = raw.latticeShift;
  return Object.keys(e).length ? e : undefined;
};

// Read the saved `siteAreas` block of an untrusted project/session file.
// A missing/!multi-area block yields [] — that file is a single-area project
// and loads through the untouched legacy path. Individual malformed areas are
// dropped rather than failing the whole load; a boundary is the one field an
// area cannot do without.
export const sanitizeSavedSiteAreas = (
  raw: any,
  // Area coordinates are all expressed in one site-local frame. The legacy
  // top-level boundary already carries that frame's origin, so use it as the
  // authority on reload rather than trusting one origin per saved area.
  sharedOrigin?: SiteBoundary['origin']
): SiteArea[] => {
  if (!Array.isArray(raw)) return [];
  const kinds = ['bess', 'substation', 'other'];
  const out: SiteArea[] = [];
  const seen = new Set<string>();
  for (const a of raw) {
    if (!a || typeof a !== 'object') continue;
    const b = a.boundary;
    if (!b || !Array.isArray(b.polygon) || b.polygon.length < 3) continue;
    if (!b.polygon.every((q: any) => q && Number.isFinite(q.x) && Number.isFinite(q.y))) continue;
    // Ids key the active-area pointer and React lists; a duplicate or
    // non-string id would silently collapse two areas into one.
    const id = typeof a.id === 'string' && a.id.length > 0 ? a.id : `area-${out.length}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      name: typeof a.name === 'string' ? a.name : (b.name ?? id),
      kind: kinds.includes(a.kind) ? a.kind : inferAreaKind(typeof a.name === 'string' ? a.name : ''),
      boundary: sharedOrigin
        ? { ...b, origin: { ...sharedOrigin } }
        : b,
      design: null, // always regenerated from the saved inputs on load
      // Edits are stored FLAT on the saved area (see SavedSiteArea), so they
      // read straight off the record rather than a nested `edits` object.
      edits: sanitizeAreaEdits(a),
    });
  }
  // One area is not a multi-area site: fall back to the single-area path so
  // those files behave exactly as they did before this feature.
  return out.length >= 2 ? out : [];
};

// Serialize areas for the project file: inputs only, no generated design.
const savedSiteAreasOf = (
  areas: SiteArea[],
  sharedOrigin: SiteBoundary['origin']
): SavedSiteArea[] =>
  areas.map(a => ({
    id: a.id,
    name: a.name,
    kind: a.kind,
    // Persist coordinates in the one shared site frame. Keeping every area
    // tied to this origin prevents a hand-edited/stale per-area origin from
    // separating the restored yards from their common imagery drape.
    boundary: { ...a.boundary, origin: { ...sharedOrigin } },
    ...(a.edits ?? {}),
  }));

// Validate an untrusted parsed project object. Returns an error string when
// unusable, null when OK — never throws.
export function validateProjectFile(p: any): string | null {
  if (!p || typeof p !== 'object') return 'File is not a BESSForge design project (not a JSON object).';
  if (p.version !== PROJECT_FILE_VERSION) return `Unsupported project file version ${String(p.version)} — this tool reads version ${PROJECT_FILE_VERSION}.`;
  const b = p.boundary;
  if (!b || !Array.isArray(b.polygon) || b.polygon.length < 3) return 'Project file has no valid site boundary polygon.';
  if (!b.polygon.every((q: any) => q && Number.isFinite(q.x) && Number.isFinite(q.y))) return 'Project boundary contains invalid coordinates.';
  if (typeof p.configId !== 'string') return 'Project file is missing the configuration id.';
  if (!CONFIGURATIONS.some(c => c.id === p.configId)) return `Project file uses an unknown equipment configuration ("${p.configId}").`;
  if (!Number.isFinite(p.targetMW) || !Number.isFinite(p.targetMWh)) return 'Project file has invalid MW/MWh targets.';
  if (p.targetMW <= 0 || p.targetMW > 5000 || p.targetMWh <= 0 || p.targetMWh > 50000) return 'Project file MW/MWh targets are out of range.';
  const arr: ArrangementStrategy[] = ['sw', 'se', 'nw', 'ne'];
  if (p.arrangement !== undefined && !arr.includes(p.arrangement)) return 'Project file has an unknown arrangement strategy.';
  if (p.latticeShift !== undefined && p.latticeShift !== null &&
      !(Number.isFinite(p.latticeShift.x) && Number.isFinite(p.latticeShift.y))) return 'Project file has an invalid lattice shift.';
  if (p.gateEdge !== undefined && p.gateEdge !== null && !['S', 'N', 'E', 'W'].includes(p.gateEdge)) return 'Project file has an unknown gate edge.';
  if (p.hotClimate !== undefined && typeof p.hotClimate !== 'boolean') return 'Project file has an invalid hot-climate flag.';
  if (p.containersPerPcs !== undefined && ![3, 4].includes(p.containersPerPcs)) return 'Project file has an invalid containers-per-PCS count (must be 3 or 4).';
  if (p.roadMode !== undefined && !['auto', 'roads', 'compact'].includes(p.roadMode)) return 'Project file has an unknown road mode.';
  if (p.autoRoadWrap !== undefined && typeof p.autoRoadWrap !== 'boolean') return 'Project file has an invalid road auto-wrap flag.';
  if (p.ringMode !== undefined && !['fence', 'shrink', 'hybrid'].includes(p.ringMode)) return 'Project file has an unknown perimeter ring mode.';
  if (p.surfacingMode !== undefined && !['between-roads', 'full-yard'].includes(p.surfacingMode)) return 'Project file has an unknown yard surfacing mode.';
  if (p.surfacingDepthIn !== undefined && (!Number.isFinite(p.surfacingDepthIn) || p.surfacingDepthIn <= 0 || p.surfacingDepthIn > 24)) return 'Project file has an invalid rock surfacing depth.';
  if (p.deadSpaceTrim !== undefined && typeof p.deadSpaceTrim !== 'boolean') return 'Project file has an invalid dead-space trim flag.';
  if (p.dcRouting !== undefined && !['orthogonal', 'direct'].includes(p.dcRouting)) return 'Project file has an unknown DC routing mode.';
  if (p.feederRoutingMode !== undefined && !['orthogonal', 'angled'].includes(p.feederRoutingMode)) return 'Project file has an unknown MV feeder routing mode.';
  if (p.textureSetId !== undefined && !isYardTextureSetId(p.textureSetId)) return 'Project file has an unknown yard texture set.';
  if (p.gePcsColor !== undefined && p.gePcsColor !== null && !(typeof p.gePcsColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(p.gePcsColor))) return 'Project file has an invalid GE PCS color.';
  if (p.showFeederColors !== undefined && typeof p.showFeederColors !== 'boolean') return 'Project file has an invalid feeder-colors preview flag.';
  if (p.eciLegend !== undefined && typeof p.eciLegend !== 'boolean') return 'Project file has an invalid legend symbol style flag.';
  if (p.showFeederNfpaText !== undefined && typeof p.showFeederNfpaText !== 'boolean') return 'Project file has an invalid feeder/NFPA text visibility flag.';
  if (p.drawingVisibility !== undefined) {
    const v = p.drawingVisibility;
    if (!v || typeof v !== 'object' || Array.isArray(v)) {
      return 'Project file has an invalid drawing visibility profile (expected an object).';
    }
    if (v.version !== DEFAULT_DRAWING_VISIBILITY.version) {
      return `Project file has an unsupported drawing visibility profile version ${String(v.version)}.`;
    }
    for (const key of ['fiber', 'pcsToBess', 'dimensions', 'labels', 'auxiliaryCables'] as const) {
      if (typeof v[key] !== 'boolean') {
        return `Project file drawing visibility field "${key}" must be boolean.`;
      }
    }
  }
  for (const k of ['laydownPct', 'augmentPct'] as const) {
    if (p[k] !== undefined && (!Number.isFinite(p[k]) || p[k] < 0 || p[k] > 100)) return `Project file has an invalid ${k === 'laydownPct' ? 'laydown' : 'augmentation'} percentage.`;
  }
  if (p.layoutEdits !== undefined && (typeof p.layoutEdits !== 'object' || p.layoutEdits === null || Array.isArray(p.layoutEdits))) return 'Project file has invalid layout edits.';
  if (p.titleBlock !== undefined) {
    if (typeof p.titleBlock !== 'object' || p.titleBlock === null || Array.isArray(p.titleBlock)) return 'Project file has an invalid title block.';
    for (const [k, v] of Object.entries(p.titleBlock)) {
      if (v !== undefined && typeof v !== 'string') return `Project file title block field "${k}" is not text.`;
    }
  }
  if (p.substation !== undefined && p.substation !== null && !(Number.isFinite(p.substation.x) && Number.isFinite(p.substation.y))) return 'Project file has an invalid substation location.';
  if (p.feederAssignments !== undefined && (typeof p.feederAssignments !== 'object' || p.feederAssignments === null || Array.isArray(p.feederAssignments))) return 'Project file has invalid feeder assignments.';
  if (p.feederSizes !== undefined && (typeof p.feederSizes !== 'object' || p.feederSizes === null || Array.isArray(p.feederSizes))) return 'Project file has invalid feeder sizes.';
  if (p.feederMaterial !== undefined && !['Al', 'Cu'].includes(p.feederMaterial)) return 'Project file has an unknown feeder conductor material.';
  // maxPcsPerFeeder is intentionally NOT validated here: out-of-range or
  // wrong-typed values fall back to the default cap on load (sanitizeFeederCap)
  // rather than rejecting the whole project file.
  if (p.gradingZones !== undefined && !Array.isArray(p.gradingZones)) return 'Project file has invalid grading zones.';
  if (p.areaZones !== undefined && !Array.isArray(p.areaZones)) return 'Project file has invalid area zones.';
  if (p.textOverrides !== undefined && (typeof p.textOverrides !== 'object' || p.textOverrides === null || Array.isArray(p.textOverrides))) return 'Project file has invalid text overrides.';
  // energySim contents are NOT deep-validated here: sanitizeEnergySimInputs
  // clamps every field back into range on load rather than rejecting the file.
  if (p.energySim !== undefined && (typeof p.energySim !== 'object' || p.energySim === null || Array.isArray(p.energySim))) return 'Project file has an invalid energy simulation section.';
  return null;
}

const projectFromState = (s: DesignState): ProjectFile | null => {
  if (!s.boundary) return null;
  return {
    version: PROJECT_FILE_VERSION,
    savedAt: new Date().toISOString(),
    boundary: s.boundary,
    configId: s.configId,
    targetMW: s.targetMW,
    targetMWh: s.targetMWh,
    hotClimate: s.hotClimate,
    containersPerPcs: s.containersPerPcs,
    roadMode: s.roadMode,
    ...(s.autoRoadWrap === false ? { autoRoadWrap: false } : {}),
    ringMode: s.ringMode,
    ...(s.perimeterBand && s.perimeterBand !== 'standard' ? { perimeterBand: s.perimeterBand } : {}),
    ...(s.fencePlacement === 'property-line' ? { fencePlacement: s.fencePlacement } : {}),
    laydownPct: s.laydownPct,
    augmentPct: s.augmentPct,
    futurePhaseUnits: s.futurePhaseUnits,
    surfacingMode: s.surfacingMode,
    surfacingDepthIn: s.surfacingDepthIn,
    deadSpaceTrim: s.deadSpaceTrim,
    dcRouting: s.dcRouting,
    // Written only when angled so untouched files keep the exact legacy shape.
    ...(s.feederRoutingMode === 'angled' ? { feederRoutingMode: 'angled' as const } : {}),
    textureSetId: s.textureSetId,
    // Always written: null is the drafter's explicit factory-look choice,
    // absent (legacy files) means "no choice recorded" and loads as the
    // GE Green default.
    gePcsColor: s.gePcsColor,
    showFeederColors: s.showFeederColors,
    // Written only when the ECI symbol style is selected so files that never
    // touched the option stay byte-identical.
    ...(s.eciLegend ? { eciLegend: true } : {}),
    // Written only when shown so untouched files stay byte-identical
    // (absent = hidden, matching the CAD-view default).
    ...(s.showFeederNfpaText ? { showFeederNfpaText: true } : {}),
    // The all-visible profile is the legacy behavior and is omitted to retain
    // byte identity for projects that have never hidden a drawing subsystem.
    ...(!drawingVisibilityAllOn(s.drawingVisibility)
      ? { drawingVisibility: s.drawingVisibility }
      : {}),
    arrangement: s.arrangement,
    // Written only when the drafter actually chose one, so files from
    // projects that never touched the picker stay byte-identical.
    ...(s.arrangementExplicit ? { arrangementExplicit: true as const } : {}),
    latticeShift: s.latticeShift,
    gateEdge: s.gateEdge,
    layoutEdits: s.layoutEdits,
    titleBlock: s.titleBlock,
    lgiaInputs: s.lgiaInputs,
    substation: s.substation,
    feederAssignments: s.feederAssignments,
    feederSizes: s.feederSizes,
    feederMaterial: s.feederMaterial,
    maxPcsPerFeeder: s.maxPcsPerFeeder,
    yardRotationDeg: s.yardRotationDeg,
    // Written only when zones exist so zone-free project files keep the
    // exact legacy shape.
    ...(s.gradingZones.length ? { gradingZones: s.gradingZones } : {}),
    // Same rule for drafter-drawn area zones (dry/wet pond, laydown yard,
    // underground exclusion): only written when present.
    ...(s.areaZones.length ? { areaZones: s.areaZones } : {}),
    // Text-label overrides: only written when non-empty so designs without
    // overrides keep the exact legacy project file shape (byte-identity).
    ...(Object.keys(s.textOverrides).length ? { textOverrides: s.textOverrides } : {}),
    // Written only while the energy study is on so untouched files keep the
    // exact legacy shape (byte-identity guarantee).
    ...(s.energySimEnabled ? { energySim: { enabled: true, inputs: s.energySimInputs } } : {}),
    // Multi-area sites only. The active area's live edits are committed back
    // onto it first, so saving mid-edit captures the footprint being worked on
    // as well as the ones already switched away from. Single-area projects
    // never write this key.
    ...(s.siteAreas.length >= 2
      ? {
          siteAreas: savedSiteAreasOf(commitActiveAreaEdits(s), s.boundary.origin),
          activeAreaId: s.activeAreaId,
        }
      : {}),
    // Imported reference drawing: display state only (the geometry is in
    // IndexedDB). Only written when a drawing is loaded.
    ...(s.drawing ? { drawingLayerVis: s.drawingLayerVis, showDrawing: s.showDrawing } : {}),
  };
};

// ---- Substation take-off helpers -------------------------------------------
//
// The active area's take-offs live in the mirrored `takeoffs` field exactly
// like `substation`. `null` there means "never edited", so the AUTOMATIC
// take-offs (derived from the yard's collector positions) are what is in
// force — that is what an editor has to start from.

/** The take-offs currently in force for the active area. */
const takeoffsOf = (s: DesignState): SubstationTakeoff[] => {
  if (s.takeoffs) return s.takeoffs;
  const area = s.siteAreas.find(a => a.id === s.activeAreaId);
  if (!area || area.kind !== 'substation') return [];
  // Derive from the area carrying the LIVE design (the mirrored top-level one
  // is newer than the copy parked on the area).
  return effectiveTakeoffs({ ...area, design: s.design ?? area.design },
    s.siteAreas.filter(a => a.kind === 'bess'));
};

/** Next free numeric suffix, so ids stay unique after removals. */
const nextTakeoffSeq = (existing: SubstationTakeoff[]): number => {
  let max = 0;
  for (const t of existing) {
    const m = /(\d+)$/.exec(t.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
};

/**
 * Commit an edited take-off list: mirror it, fold it onto the active area, and
 * re-lay the feeders of EVERY area.
 *
 * The full re-lay is the point — a take-off belongs to the substation area but
 * determines where a DIFFERENT area's home runs land, so recomputing only the
 * active area would leave the served BESS yard drawing routes to a position
 * that no longer exists.
 */
const commitTakeoffs = (
  set: (partial: Partial<DesignState>) => void,
  get: () => DesignState,
  next: SubstationTakeoff[],
  extra?: Partial<DesignState>
): void => {
  set({ takeoffs: next, ...(extra ?? {}) });
  const s = get();
  set({ siteAreas: commitActiveAreaEdits(s) });
  get().recomputeAllAreaFeeders();
};

/**
 * Route one area's MV feeders (plus its aux chain) onto a given substation
 * point, mutating that area's design the same way the single-area path does.
 *
 * This is the ONE place feeder routing inputs are assembled, so the active
 * area (routed by recomputeFeeders) and every background area (routed by
 * recomputeAllAreaFeeders) can never drift apart in their options — a
 * difference there would draw one yard's trenches under different rules than
 * its neighbour's.
 *
 * `approach`/`foreignFences` are the multi-area take-off inputs. Both absent
 * reproduces the legacy single-area result exactly.
 */
const routeFeedersInto = (
  design: SiteDesign,
  substation: Pt,
  ctx: {
    configId: string;
    layoutEdits: LayoutConstraints;
    // HEALED traced road records (stale-save flags/surfaces re-derived), when
    // the caller has them. The raw stored records in layoutEdits can carry no
    // entrance/apron flags at all on a pre-current-rules save (the heal is
    // render-time only, never persisted), and gate keep-outs derived from
    // those would silently vanish. Absent => layoutEdits.customRoads is used.
    customRoads?: LayoutConstraints['customRoads'] | null;
    feederAssignments: Record<string, number>;
    feederSizes: Record<number, FeederConductorSize>;
    feederMaterial: ConductorMaterial;
    maxPcsPerFeeder: number;
    feederRoutingMode: FeederRoutingMode;
    areaZones: AreaZone[];
    approach?: TakeoffDirection | null;
    foreignFences?: Pt[][] | null;
  }
): FeederCircuit[] => {
  const config = getConfiguration(ctx.configId);
  // Feeder routing fail-safe warnings (e.g. run-line clamp at the routing
  // area edge) are refreshed on every recompute: previous ones are stripped
  // below so they never duplicate or go stale after the geometry changes.
  const feederWarnings: string[] = [];
  const exclusionZones = ctx.areaZones.filter(z => z.kind === 'exclusion');
  // Traced gate entrances / aprons are hard keep-outs: a home run must never
  // trench through the site entrance. Empty for yards without traced gate
  // records (auto yards stay byte-identical).
  const gateKeep = gateApronKeepouts(ctx.customRoads ?? ctx.layoutEdits.customRoads ?? null);
  const feederDesign = { ...design, equipment: equipmentForRouting(design.equipment) };
  const feeders = generateFeeders(feederDesign, substation, config.blockMW, {
    assignments: ctx.feederAssignments,
    sizes: ctx.feederSizes,
    material: ctx.feederMaterial,
    corridorPin: ctx.layoutEdits.feederCorridor ?? null,
    routeOverrides: ctx.layoutEdits.feederRoutes ?? null,
    forcedRoutes: (ctx.layoutEdits.forcedEdits ?? [])
      .filter(k => k.startsWith('feeder-route-'))
      .map(k => k.slice('feeder-route-'.length)),
    maxPerFeeder: ctx.maxPcsPerFeeder,
    defaultRoutingMode: ctx.feederRoutingMode,
    routingModes: ctx.layoutEdits.feederModes ?? null,
    exclusionZones,
    gateKeepouts: gateKeep.length ? gateKeep : null,
    approach: ctx.approach ?? null,
    foreignFences: ctx.foreignFences ?? null,
    onWarning: (msg) => feederWarnings.push(msg),
  });
  design.warnings = design.warnings
    .filter(w => !w.startsWith('Feeder routing ran out of room') &&
                 !w.startsWith('Feeder route omitted:') &&
                 !w.startsWith('Custom feeder route') &&
                 !w.startsWith('Angled feeder route') &&
                 !w.startsWith('Feeder routing mode') &&
                 !w.startsWith('Feeder trench conflict'))
    .concat(feederWarnings);
  // Re-derive PCS/CON reference labels from the actual feeder circuits so
  // equipment names always match the MV schedule (FF = feeder number,
  // UU = position on the feeder).
  applyReferenceLabels(design.equipment, feeders, design.islands);
  // Substation aux feeder (34.5 kV daisy chain through every aux
  // transformer, per CAR-D-B005-0) — recomputed with the feeders since its
  // circuit number follows the BESS feeder count. The ROUTED feeders are
  // passed (not just their count) so the aux trench can take its own
  // parallel lane and keep clear of every MV home run. It gets the SAME
  // approach/foreign-fence context as the bundle it rides beside; deriving
  // its lane in a different frame would cut it across the home runs.
  design.auxFeeder = generateAuxFeeder(design, substation, feeders,
    (msg: string) => feederWarnings.push(msg),
    exclusionZones,
    ctx.layoutEdits.auxFeederWaypoints ?? null,
    {
      maxPerFeeder: ctx.maxPcsPerFeeder,
      corridorPin: ctx.layoutEdits.feederCorridor ?? null,
      approach: ctx.approach ?? null,
      foreignFences: ctx.foreignFences ?? null,
    });
  design.warnings = design.warnings
    .filter(w => !w.startsWith('Aux feeder leg') && !w.startsWith('Aux feeder custom route'))
    .concat(feederWarnings.filter(w => w.startsWith('Aux feeder leg') || w.startsWith('Aux feeder custom route')));
  // Routing validation gates (spec §9, G-RT-1..12): re-verify the routed
  // discipline against the finished geometry and surface violations with the
  // stable `Routing gate G-RT-` prefix. The previous gate batch is stripped
  // first so results always describe the CURRENT routing, and the gates are
  // pure verification — they never change a route.
  const gateResults = runRoutingGates(design, {
    feeders,
    substation,
    exclusionZones,
    maxPerFeeder: ctx.maxPcsPerFeeder,
  });
  design.warnings = design.warnings
    .filter(w => !w.startsWith(ROUTING_GATE_PREFIX))
    .concat(gateResults.map(r => r.message));
  return feeders;
};

// Fold the live mirrored edit state back onto the active area, returning the
// full area list. Every other area keeps the edits it was switched away with.
// This is the single point where "what the drafter is doing right now" becomes
// per-area state — used when switching areas and when saving.
export const commitActiveAreaEdits = (s: DesignState): SiteArea[] => {
  if (s.siteAreas.length === 0) return s.siteAreas;
  const edits = captureAreaEdits(s);
  return s.siteAreas.map(a =>
    a.id === s.activeAreaId
      ? {
          ...a,
          // The active area's boundary/design are mirrored at the top level and
          // can be newer than the copy on the area (regenerate only updates the
          // mirror), so take the live ones.
          boundary: s.boundary ?? a.boundary,
          design: s.design ?? a.design,
          ...(edits ? { edits } : { edits: undefined }),
        }
      : a
  );
};

const readSavedSession = (): ProjectFile | null => {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return validateProjectFile(parsed) === null ? (parsed as ProjectFile) : null;
  } catch {
    return null;
  }
};

// ---- interactive placement session (transient, never persisted) -----------
// What a session is placing. `move` re-previews an EXISTING placed island (its
// spec supplies the shape/orientation/augmentation); `new` previews a drop of
// the shape the drafter picked in the toolbar.
export interface PlacementInit {
  mode: 'new' | 'move';
  // Move sessions only: the spec id being repositioned.
  id?: string;
  // Initial pointer position (site feet).
  center: Pt;
  // New placements only (a move reads these from the existing spec).
  // `angleDeg` is the island rotation in degrees CCW from world +x (0 =
  // horizontal strip, 90 = vertical). Replaces the old `vertical` flag.
  angleDeg?: number;
  pairs?: number;
  kind?: PlacedIslandKind | 'equipment';
  aug?: boolean;
  // Island placements only: include the standard mid-island auxiliary cluster
  // (aux transformer + aux distribution + comms cabinet). Defaults to false
  // for a NEW placement — manual placements are core equipment unless the
  // engineer asks for the cluster.
  auxGear?: boolean;
  // kind === 'equipment' only: which single item is being placed.
  equipType?: ManualEquipmentType;
  // Snap increment in feet; 0 = free positioning. Defaults to
  // PLACEMENT_SNAP_DEFAULT_FT.
  snapFt?: number;
}
export interface PlacementSession {
  mode: 'new' | 'move';
  id?: string;
  // Raw (unsnapped) pointer position — drawn so the ghost tracks the pointer
  // smoothly even when the candidate center is quantized.
  pointer: Pt;
  // Deterministic center that is validated AND committed.
  center: Pt;
  // Island rotation in degrees CCW from world +x (0 = horizontal, 90 = vertical,
  // any other value = arbitrary angle). Step increments are 15°.
  angleDeg: number;
  pairs?: number;
  kind: PlacedIslandKind | 'equipment';
  aug: boolean;
  // Island aux cluster opt-in (see PlacementInit.auxGear). Always false for
  // single modules and for individually placed equipment.
  auxGear: boolean;
  equipType?: ManualEquipmentType;
  snapFt: number;
  // Move sessions: the spec's original center, so a cancelled move is a
  // provable no-op and a commit can send an exact delta.
  origin?: Pt;
}

interface DesignState {
  boundary: SiteBoundary | null;
  design: SiteDesign | null;
  // Multi-area site: every imported phase footprint, each with its own
  // boundary/fence/layout, all projected in ONE shared local frame so they
  // keep their true relative positions. Empty for single-boundary projects,
  // which keep using `boundary`/`design` exactly as before.
  siteAreas: SiteArea[];
  // Which area the drafter is currently editing (mirrored into
  // `boundary`/`design` so every existing edit path keeps working unchanged).
  activeAreaId: string | null;
  // Imported CAD drawing from the KMZ (every LineString/Polygon the file
  // carries, grouped by layer, in the shared projection frame). REFERENCE
  // ONLY: never read by layout, routing, compliance or any exporter — it is
  // what the client drew, shown underneath what BESSForge generates.
  drawing: ImportedDrawing | null;
  // Layer name -> visible. Absent name = use the import default.
  drawingLayerVis: Record<string, boolean>;
  showDrawing: boolean;
  configId: string;
  targetMW: number;
  targetMWh: number;
  hotClimate: boolean;
  // LG JF2 containers per PCS block (3 or 4; QTY 3 is the standard default,
  // legacy files/sessions without the field fall back to 4).
  containersPerPcs: number;
  roadMode: RoadMode;
  autoRoadWrap: boolean;
  ringMode: RingMode;
  // Outer edge of the perimeter road band: 'standard' = 10 ft inset from
  // fence (legacy default), 'flush' = outer road edge on the fence line.
  perimeterBand: PerimeterBandMode;
  // Where the security fence is drawn: 'inset' (legacy default) holds the
  // typical lot-line setback, 'property-line' draws it on the imported outer
  // boundary. Engineer-selected (EOR/civil call) — never inferred.
  fencePlacement: FencePlacementMode;
  laydownPct: number;
  augmentPct: number;
  // Explicit future-phase augmentation units (2 PCS + 6 BESS each), placed
  // like the % reserve, in addition to it.
  futurePhaseUnits: number;
  // Crushed-rock yard surfacing: coverage mode + rock depth (inches).
  surfacingMode: SurfacingMode;
  surfacingDepthIn: number;
  // Dead-space trim: shrink fence to the minimum compliant hull and clip
  // crushed-rock courtyards to their contents. Off by default (legacy).
  deadSpaceTrim: boolean;
  setDeadSpaceTrim: (on: boolean) => void;
  // DC container-run routing method: 90° trench legs (default) or straight-line direct runs.
  dcRouting: DcRoutingMode;
  // 3D-preview yard texture set (roads / crushed rock / dirt). Visual only —
  // never read by the DXF/PDF exporters.
  textureSetId: YardTextureSetId;
  // GE PCS exterior color ('#rrggbb', null = factory). Recolors the GE model
  // texture (body -> color, baked logos/text -> white) and the simple-box
  // inverter color. Display only — never read by the DXF/PDF exporters.
  gePcsColor: string | null;
  // True when `arrangement` below is the drafter's explicit selection rather
  // than the untouched default. Multi-area automatic packing keys off this:
  // a deliberately chosen arrangement (even the default SW) is an engineering
  // input the road-aware search must not override.
  arrangementExplicit: boolean;
  // Active placement arrangement: the auto BASELINE all edits/resets return
  // to. 'sw' is the standard default layout.
  arrangement: ArrangementStrategy;
  // Optimizer baseline knobs applied on every regeneration (null = defaults).
  latticeShift: Pt | null;
  gateEdge: GateEdge | null;
  layoutEdits: LayoutConstraints;
  // Drafter text-label overrides (position/height/content deltas). Applied to
  // the CAD view and all DXF/PDF exports. Keyed by label fingerprint.
  // Empty map = no overrides (default, keeps all outputs byte-identical).
  textOverrides: Record<string, TextOverride>;
  setTextOverride: (key: string, ov: TextOverride) => void;
  clearTextOverride: (key: string) => void;
  clearAllTextOverrides: () => void;
  // Grading-optimized yard rotation (degrees, [0, 180)). 0 = the unrotated
  // pose — the exact-identity default; every design input is untouched.
  yardRotationDeg: number;
  // Undo/redo of drafter layout state (edits + baseline arrangement).
  undoStack: HistorySnap[];
  redoStack: HistorySnap[];
  // Autosaved session found in localStorage at startup (null when none, or
  // once restored/dismissed). Restoring is explicit — never automatic.
  savedSession: ProjectFile | null;
  // Equipment ids highlighted in the 3D preview (compliance-finding focus).
  highlightIds: string[];
  showLabels: boolean;
  // Render uploaded manufacturer 3D models instead of simple boxes (3D view).
  realisticModels: boolean;
  // 3D preview only: place the uploaded gate 3D model at the fence entrance.
  showGateModel: boolean;
  // 3D preview only: render textured fence panels along the fence line.
  showFence3D: boolean;
  // Display-only: per-feeder color palette in the 3D/2D scene (PCS tint,
  // feeder polylines/conductors, legend overlay). Off = neutral monochrome
  // plan-check view. Never affects DXF/PDF output colors.
  showFeederColors: boolean;
  // Legend equipment symbol style: false = baked GLB plan-view traces
  // (default), true = ECI reference legend symbols. Travels with the
  // project (written only when true so legacy files stay byte-identical).
  eciLegend: boolean;
  // Feeder & NFPA annotation text: plan-area feeder callouts + the NFPA 855
  // setback dimension on the CAD view AND the 10% DXF/PDF exports. Hidden by
  // default (decluttered view); legend rows and notes always stay visible.
  showFeederNfpaText: boolean;
  setShowFeederNfpaText: (on: boolean) => void;
  // Project-scoped generated-drawing subsystem visibility. This changes only
  // rendering/export filtering, never layout geometry, so actions do not
  // regenerate the design.
  drawingVisibility: DrawingVisibilityProfile;
  setDrawingVisibility: (patch: Partial<DrawingVisibilityProfile>) => void;
  resetDrawingVisibility: () => void;
  // Cinematic CAD layer override: transient presentation state only. It
  // never writes to local storage/project JSON and is cleared whenever the
  // tour stops, so a recording cannot alter drafter/export preferences.
  tourCadLayers: { labels: boolean; dims: boolean; cables: boolean; feederNotes: boolean } | null;
  setTourCadLayers: (layers: { labels: boolean; dims: boolean; cables: boolean; feederNotes: boolean } | null) => void;
  // Site-vicinity satellite imagery (Cesium ion -> Bing Aerial via the server
  // proxy). Draped on the 3D ground when enabled and embedded on the PDF
  // cover page. Never affects layout math or DXF output.
  satellite: SatelliteImage | null;
  satelliteStatus: 'idle' | 'loading' | 'error';
  satelliteError: string | null;
  showSatellite: boolean;
  // Terrain awareness (USGS 3DEP elevation via the server proxy). The grid
  // drives the 3D relief drape, slope heatmap and cut/fill screening only —
  // it NEVER touches the layout engine or the DXF/PDF drawing geometry.
  // On fetch failure the preview stays on flat ground with an explicit
  // "flat ground (no elevation data)" label — elevation is never faked.
  terrain: ElevationGrid | null;
  terrainStatus: 'idle' | 'loading' | 'error';
  terrainError: string | null;
  showTerrain: boolean;       // 3D relief on/off (instant toggle)
  showSlopeHeatmap: boolean;  // slope overlay on the terrain
  maxGradePct: number;        // steep-zone threshold (% grade)
  // Voltage drop & losses screening prefs (per-browser localStorage, never
  // project data — the report is derived, never stored):
  maxVdPct: number;           // max feeder voltage drop flag threshold (%)
  capacityFactorPct: number;  // capacity/load factor for annual-loss estimate (%)
  showContours: boolean;      // elevation contour lines on the terrain (3D preview only)
  contourIntervalFt: number;  // contour interval in feet; 0 = auto from site relief
  showGradingLimits: boolean; // cut/fill grading tie-in at the pad edge (3D preview only)
  labelDistanceScaling: boolean; // zoom-aware label scaling/culling (3D preview only)
  // Proposed FG contour overlay (3D preview only): draws the grading-plan
  // linework (proposed contours + daylight limit) on the terrain when the
  // FG surface is enabled. Per-browser preference, never in project JSON.
  showProposedContours: boolean;
  // Cut/fill isopach drape (3D preview only): colors the terrain by the same
  // 4 depth bands the GP-1 shading exports (cutFillBandIndexAt) when the FG
  // surface is enabled. Per-browser preference, never in project JSON.
  showCutFillPreview: boolean;
  gradingSlopeRatio: number; // horizontal:vertical daylight slope for the grading overlay (2/3/4 = 2:1/3:1/4:1)
  // Opt-in: include existing-grade contour lines in the exported DXF on a
  // dedicated reference layer. Off by default so the default export stays
  // byte-identical. Per-browser preference (localStorage), not project data.
  exportContoursDxf: boolean;
  // Opt-in: include cut/fill isopach shading (depth-banded hatch regions,
  // FG minus existing grade) on the grading plan sheet (GP-1 DXF + PDF twin).
  // Off by default so the default GP-1 output stays byte-identical.
  // Per-browser preference (localStorage), not project data.
  exportCutFillShading: boolean;
  // Grounding screening layout (loop / rods / taps). Preview toggle is a
  // per-browser preference; DXF export is strictly opt-in (default export
  // stays byte-identical). Never project data — the plan is derived.
  showGrounding: boolean;
  groundingRodSpacingFt: number; // 25 / 50 / 100 ft rod spacing along the loop
  // Grounding X-ray: hide equipment bodies (footprint outlines only) so the
  // buried grid reads like the grounding sheet. Per-browser preference.
  groundingXray: boolean;
  exportGroundingDxf: boolean;
  // Typical trench section schedule (CAR-D-B006-1/2): strictly opt-in DXF
  // content — default export stays byte-identical. Per-browser preference.
  exportTrenchSectionsDxf: boolean;
  // Legacy full-area crushed-rock GRAVEL cross-hatch ("X ground mesh") on
  // exports. Default OFF — the only ground mesh is the future-augmentation
  // ANSI37 area. Per-browser preference.
  exportSurfacingMesh: boolean;
  // IEEE-80 grounding study: opt-in calculation card + permit packet section.
  // Inputs are per-browser prefs (localStorage), never project data. The
  // study itself is always derived — nothing here touches default exports.
  ieee80Enabled: boolean;
  ieee80Inputs: Ieee80Inputs;
  scEnabled: boolean;
  scInputs: ShortCircuitInputs;
  // Protection / arc-flash study (built on the SC study): opt-in card +
  // POI sheet section. Per-browser prefs (localStorage), never project data.
  protectionEnabled: boolean;
  protectionInputs: ProtectionInputs;
  // Energy/dispatch simulation (AC-PoC RTE, degradation, augmentation
  // planning). Opt-in card. Unlike the IEEE-80/SC prefs, the inputs change
  // the study results a shared file must reproduce, so enabled+inputs are
  // PROJECT DATA: they travel in the project JSON (single opt-in key written
  // only while enabled) — never localStorage. Nothing touches default exports.
  energySimEnabled: boolean;
  energySimInputs: EnergySimInputs;
  // Proposed grading surface (sloped pads / benches / balanced earthwork):
  // opt-in preview + earthwork card. Inputs are per-browser prefs
  // (localStorage), never project data — nothing here touches exports.
  gradingEnabled: boolean;
  gradingInputs: GradingInputs;
  // Multi-pad grading zones (engineering inputs, persisted in the project
  // file — empty array = feature off, the exact-identity default).
  gradingZones: GradingZone[];
  // Drafter-drawn area zones (annotation rectangles, persisted in the
  // project file — empty array = feature off, the exact-identity default).
  areaZones: AreaZone[];
  // Drainage screening on the proposed FG surface (flow paths, ponding,
  // swales, discharge hydrology): opt-in card, requires gradingEnabled.
  // Inputs are per-browser prefs (localStorage) — never touches exports.
  drainageEnabled: boolean;
  drainageInputs: DrainageInputs;
  drainageIdf: Atlas14Idf | null;
  // Earthwork cost estimate: user-editable unit rates ($/CY + mobilization)
  // and the opt-in "include cost estimate on GP-1" toggle. Per-browser prefs
  // (localStorage), NEVER project JSON; default GP-1 stays byte-identical.
  earthworkRates: EarthworkRates;
  exportCostEstimate: boolean;
  // GP-2 cross-sections export (opt-in): adds section markers to GP-1 and
  // offers the standalone GP-2 sheet. Per-browser preference (localStorage),
  // NEVER project JSON; default GP-1 stays byte-identical when off.
  exportSections: boolean;
  titleBlock: TitleBlockInfo;
  // LGIA data sheet project inputs (transformer %Z, ride-through settings,
  // UL 1741 SB cert details). Project data: travels in the exported project
  // JSON and the session autosave, like the title block.
  lgiaInputs: LgiaInputs;
  // 3D preview only: monotonic counter; each bump asks the scene to fly the
  // camera to a low oblique close-up of the 480V aux + fiber trench.
  // `inspectTrenchHandled` is bumped by the scene once the flight starts, so
  // a Canvas remount (2D→3D switch) doesn't replay old requests.
  inspectTrenchRequest: number;
  inspectTrenchHandled: number;
  // 3D preview only: monotonic counter; each bump asks the scene to fly the
  // camera back to the default full-site overview (whole parcel in view).
  // Same request/handled pattern as the trench inspect preset.
  overviewRequest: number;
  overviewHandled: number;
  // 3D preview only: explicit camera pose request (scene position + orbit
  // target, scene coords). Used by visual regression scripts to frame
  // arbitrary spots (e.g. a feeder trench crossing a road) that no built-in
  // preset covers. Same request/handled counter pattern as the presets.
  cameraPoseRequest: { pos: [number, number, number]; target: [number, number, number]; n: number } | null;
  cameraPoseHandled: number;
  // Orthographic counterpart used only by the presentation tour's 2D plan
  // beat; transient and never saved with a project.
  orthoCameraPoseRequest: { target: [number, number, number]; zoom: number; n: number } | null;
  orthoCameraPoseHandled: number;
  // 3D preview only: hi-fi cover capture request. The scene renders two
  // offscreen shots of the CURRENT 3D content — a plan-registered top-down
  // ortho over localRect and a perspective hero — and posts them back via
  // coverCaptureResult. Never touches the user's camera or exports state.
  // True while a 3D/CAD scene capable of servicing captures is mounted.
  coverCaptureReady: boolean;
  // Export-time override lease: while > 0, the realistic-model far-LOD box
  // swap is suppressed so cover/site captures always bake the full GLB
  // models, regardless of how far out the drafter's viewport camera sits.
  // Refcounted so overlapping capture flows can't release each other's hold.
  forceRealisticNearCount: number;
  // Scene handshake: true once the committed scene graph reflects the
  // current effective LOD state (set from an effect AFTER React commits the
  // GLB group's visibility) — capture flows wait on this, not a timer.
  realisticDetailApplied: boolean;
  // hiRes: supersampled full-site capture for the 10% Package render page
  // (renders 2x and downscales; larger output cap; topDown only, hero null).
  coverCaptureRequest: { localRect: { minX: number; minY: number; maxX: number; maxY: number }; n: number; hiRes?: boolean; hideLabels?: { topDown?: boolean; hero?: boolean } } | null;
  coverCaptureResult: {
    n: number;
    topDown: { dataUrl: string; widthPx: number; heightPx: number } | null;
    hero: { dataUrl: string; widthPx: number; heightPx: number } | null;
  } | null;
  // First-person walkthrough (3D preview only): engineer walks the site from
  // the gate. Never affects layout math or exports.
  walkMode: boolean;
  // Cinematic marketing tour (3D preview only): orbit → gate dive → drive-
  // through → pull-up. `tourRecord` also captures the canvas to a video file
  // while the tour plays. `tourSeek` (0..1) freezes playback at a fixed
  // progress — used by the visual regression script only. Presentation-only:
  // never affects layout math or exports.
  tourActive: boolean;
  tourRecord: boolean;
  tourSeek: number | null;
  // Tour v2: 'path' = camera flight, 'showcase' = scripted CAD/plot/BOM/SLD
  // segment after the pull-up. `tourGrounding` forces the grounding overlay
  // on during the final flyover (transient, never persisted). Speed > 1 is a
  // test hook that compresses the showcase timeline.
  tourPhase: 'path' | 'showcase' | null;
  tourGrounding: boolean;
  // Tour v3: live DC reroute beat during the top-down close-up hold. 0 = the
  // drafter's own routing; 0..1 progressively re-routes the DISPLAYED DC
  // runs to 'direct' (presentation-only — dcRouting, project JSON and every
  // export are untouched). `tourFade` drives the white fade-up transition
  // back into the drive-through (drawn on a recorder-captured overlay).
  tourDcSwap: number;
  tourFade: number;
  // On-screen caption for the reroute beat, drawn on the recorder-captured
  // overlay canvas (a DOM div would be invisible in the video). Null when no
  // caption is showing.
  tourCaption: string | null;
  // Feeder fly-along island stat card (presentation-only, drawn on the
  // recorder-captured overlay canvas). Alpha is the eased 0..1 fade driven
  // purely from normalized tour time; the card content is fixed per tour.
  tourStatAlpha: number;
  tourStatCard: { title: string; lines: string[]; sub: string[] } | null;
  // Fly-along ghost outlines of the island's future-upgrade PCS positions
  // (presentation-only, rendered translucent in the 3D scene during the same
  // island-hold window as the stat card). Alpha is the eased 0..1 fade driven
  // purely from normalized tour time; the boxes are fixed per tour.
  tourGhostAlpha: number;
  tourGhosts: { x: number; y: number; length: number; width: number; height: number; rotation: number }[] | null;
  // Cinematic title intro over the opening orbit (presentation-only, drawn
  // on the recorder-captured overlay). Progress is a pure function of
  // normalized tour time; the content is fixed per tour.
  tourIntroT: number;
  tourIntroInfo: import('../cinematicTour').TourIntroInfo | null;
  tourShowcaseSpeed: number;
  // Marketer-chosen tour options (duration preset + per-stop toggles); UI
  // preference only, never serialized into the project JSON.
  tourOptions: TourOptions;
  // Monotonic counter: each bump asks DesignScene to run the marketing
  // stills capture sequence (CAD / 3D simple / 3D realistic + hero angles).
  marketingStillsRequest: number;
  /** Offline WebCodecs 4K60 render: bump requests, DesignScene drives it. */
  offlineRenderRequest: number;
  offlineRenderOpts: { fps?: number; maxSeconds?: number } | null;
  /** True while the offline renderer is stepping frames (boosts render dpr). */
  offlineRenderActive: boolean;
  isLoading: boolean;
  // Full-viewport busy overlay (Show-all / scan Apply) — label + optional progress.
  busyOverlay: { label: string; frac?: number } | null;
  // True while the design worker is recomputing the layout off the main
  // thread (drives the subtle busy indicator in the preview).
  computing: boolean;
  error: string | null;

  // MV feeder / substation state
  substation: Pt | null;
  placingSubstation: boolean;
  // MULTI-AREA ONLY: routed MV feeders per area id, so every yard's circuits
  // exist at once (compliance, permit packet and totals score each area
  // against its OWN routes). Derived output — recomputed, never persisted.
  // Single-area projects leave this empty and read `feeders`.
  areaFeeders: Record<string, FeederCircuit[]>;
  // Where the ACTIVE area's circuits actually land: its assigned substation
  // take-off on a multi-area site, or the legacy local `substation`.
  //
  // A multi-area BESS area has NO local substation — its endpoint sits in a
  // different footprint — so anything that renders or measures routes must
  // read this instead of gating on `substation`, or a BESS area's feeders
  // silently disappear the moment it becomes active. Derived output,
  // recomputed with the feeders and never persisted.
  feederEndpoint: Pt | null;
  // SUBSTATION areas only (multi-area sites): the drafter's MV take-off
  // positions for the ACTIVE area, mirrored from/to that area's edits exactly
  // like `substation`. null = never edited, so the automatic take-offs derived
  // from the yard's collector positions are in force. Single-area projects
  // leave this null forever and keep the single-point path untouched.
  takeoffs: SubstationTakeoff[] | null;
  // Take-off id the drafter is currently moving by clicking the map, or null.
  placingTakeoffId: string | null;
  feeders: FeederCircuit[];
  feederAssignments: Record<string, number>; // inverter id -> feeder number (1-based)
  // One-shot notice set when a regeneration cleared non-empty manual feeder
  // groupings because the inverter set changed. The UI toasts it and calls
  // clearFeederResetNotice().
  feederResetNotice: string | null;
  // One-shot notice set when a regeneration dropped saved grading zones
  // because they no longer pass fence validation (restored/imported project
  // with a changed boundary or hand-edited file). The UI toasts it and calls
  // clearGradingZonesResetNotice().
  gradingZonesResetNotice: string | null;
  feederSizes: Record<number, FeederConductorSize>;
  feederMaterial: ConductorMaterial;
  // Max PCS units per MV feeder (5 or 6; default 6 per the NextEra
  // reference). Drives auto grouping and manual-assignment cap checks.
  maxPcsPerFeeder: number;
  // Display-only: feeder idx values whose scene rendering (polylines, trench
  // channels/conductors, PCS tint) is hidden via the legend toggles. Never
  // persisted (session/project) and never read by the DXF/PDF exporters —
  // exports always include every feeder. Cleared whenever feeders recompute.
  hiddenFeeders: ReadonlySet<number>;

  // Boundary picker: when an uploaded/sample KMZ contains more than one
  // parcel-scale polygon, the user picks which one is the site boundary.
  boundaryPicker: {
    sourceName: string;
    kmlText: string;
    options: BoundaryOption[];
  } | null;
  applyBoundary: (boundary: SiteBoundary) => void;
  loadKmlWithPicker: (kmlText: string, sourceName: string, boundaryNames?: string[]) => void;
  loadKmz: (file: File) => Promise<void>;
  loadSample: (url: string, name: string, boundaryNames?: string[]) => Promise<void>;
  chooseBoundary: (index: number) => void;
  // Import EVERY outline in the picker as one multi-area site (all footprints
  // in one shared frame, one layout each) instead of picking a single parcel.
  chooseAllBoundaries: () => void;
  // Same as chooseAllBoundaries, but regenerates each area with paint yields
  // so a busy overlay can report progress (Show-all loading screen).
  chooseAllBoundariesWithProgress: (
    onProgress: (frac: number, label: string) => void,
  ) => Promise<void>;
  setBusyOverlay: (next: { label: string; frac?: number } | null) => void;
  // Switch which area the drafter edits; mirrors that area into boundary/design.
  setActiveArea: (id: string) => void;
  // Lay out every area of a multi-area site. `only` regenerates a single area
  // and leaves every already-laid-out neighbour exactly as it is.
  // `skipFeederRecompute` defers MV routing (used when phasing one area at a time).
  regenerateAreas: (opts?: { only?: string; skipFeederRecompute?: boolean }) => void;
  cancelBoundaryPicker: () => void;
  setConfigId: (id: string) => void;
  setTargetMW: (mw: number) => void;
  setTargetMWh: (mwh: number) => void;
  setHotClimate: (hot: boolean) => void;
  setContainersPerPcs: (n: number) => void;
  setRoadMode: (mode: RoadMode) => void;
  setAutoRoadWrap: (wrap: boolean) => void;
  setRingMode: (mode: RingMode) => void;
  setPerimeterBand: (band: PerimeterBandMode) => void;
  setFencePlacement: (mode: FencePlacementMode) => void;
  moveRingEdge: (side: 'n' | 's' | 'e' | 'w', offset: number) => string | null;
  setLaydownPct: (pct: number) => void;
  setAugmentPct: (pct: number) => void;
  setFuturePhaseUnits: (n: number) => void;
  // Add/remove one future augmentation unit at an island's strip end
  // (islandAugUnits layout edit). No-ops on non-island layouts.
  setIslandAugUnits: (islandN: number, count: number) => void;
  // Choose which strip end holds an island's augmentation units. Key is the
  // island number (as string) for auto islands or the pisl-<n> id for
  // drag-placed islands; null clears the override. Returns a rejection
  // reason (edit rolled back) or null on success.
  setIslandAugEnd: (key: string, end: 'east' | 'west' | null) => string | null;
  adjustIslandBlocks: (islandN: number, step: 1 | -1) => string | null;
  setSurfacingMode: (mode: SurfacingMode) => void;
  setDcRouting: (mode: DcRoutingMode) => void;
  // Per-block DC routing override (layout edit). mode null = clear the
  // override so the block follows the design-wide default again.
  setBlockDcRouting: (blockN: number, mode: DcRoutingMode | null) => void;
  // Toggle island column alignment (layout edit). When on, alignment moves
  // that would cost augmentation zones are accepted and reported. When off
  // (default), those moves surface as "Island alignment available:" notices.
  setAlignIslands: (on: boolean) => void;
  setSurfacingDepthIn: (depth: number) => void;
  setTextureSetId: (id: YardTextureSetId) => void;
  setGePcsColor: (hex: string | null) => void;
  // Pick a placement arrangement as the new baseline: clears all layout
  // edits (they were relative to the previous baseline) and regenerates,
  // rebuilding roads for the new arrangement.
  setArrangement: (s: ArrangementStrategy) => void;
  // Apply an optimizer candidate as the new baseline (undoable, one step):
  // sets arrangement + lattice shift + gate edge, clears edits (keeping the
  // candidate's trench pin, if any), regenerates.
  applyOptimizedLayout: (params: OptimizeParams) => void;
  // Apply a grading-sweep yard rotation (undoable, one step). The parcel
  // boundary itself is never mutated — regenerate rotates it on the fly.
  setYardRotation: (deg: number) => void;
  setShowLabels: (show: boolean) => void;
  // Capture every geometry feature of an imported KML as reference linework
  // about `origin` (the frame the boundary/areas were projected into).
  captureDrawing: (kmlText: string, sourceName: string, origin: { lat: number; lon: number }) => void;
  // Imported reference drawing display controls (view state only).
  setShowDrawing: (show: boolean) => void;
  setDrawingLayerVisible: (layer: string, visible: boolean) => void;
  setAllDrawingLayers: (visible: boolean) => void;
  requestInspectTrench: () => void;
  markInspectTrenchHandled: (n: number) => void;
  requestOverview: () => void;
  markOverviewHandled: (n: number) => void;
  requestCameraPose: (pos: [number, number, number], target: [number, number, number]) => void;
  markCameraPoseHandled: (n: number) => void;
  requestOrthoCameraPose: (target: [number, number, number], zoom: number) => void;
  markOrthoCameraPoseHandled: (n: number) => void;
  setCoverCaptureReady: (ready: boolean) => void;
  acquireForceRealisticNear: () => void;
  releaseForceRealisticNear: () => void;
  setRealisticDetailApplied: (v: boolean) => void;
  requestCoverCapture: (localRect: { minX: number; minY: number; maxX: number; maxY: number }, hiRes?: boolean, hideLabels?: { topDown?: boolean; hero?: boolean }) => number;
  postCoverCaptureResult: (result: NonNullable<DesignState['coverCaptureResult']>) => void;
  setExportSurfacingMesh: (on: boolean) => void;
  setWalkMode: (on: boolean) => void;
  startCinematicTour: (record: boolean) => void;
  stopCinematicTour: () => void;
  finishTourPath: () => void;
  startTourShowcase: () => void;
  setTourGrounding: (on: boolean) => void;
  setTourDcSwap: (p: number) => void;
  setTourFade: (f: number) => void;
  setTourCaption: (c: string | null) => void;
  setTourStatAlpha: (a: number) => void;
  setTourStatCard: (c: { title: string; lines: string[]; sub: string[] } | null) => void;
  setTourGhostAlpha: (a: number) => void;
  setTourGhosts: (g: { x: number; y: number; length: number; width: number; height: number; rotation: number }[] | null) => void;
  setTourIntroT: (p: number) => void;
  setTourIntroInfo: (i: import('../cinematicTour').TourIntroInfo | null) => void;
  setTourShowcaseSpeed: (speed: number) => void;
  setTourSeek: (t: number | null) => void;
  setTourOptions: (opts: Partial<TourOptions>) => void;
  requestMarketingStills: () => void;
  requestOfflineRender: (opts?: { fps?: number; maxSeconds?: number }) => void;
  setOfflineRenderActive: (active: boolean) => void;
  setRealisticModels: (on: boolean) => void;
  setShowGateModel: (on: boolean) => void;
  setShowFence3D: (on: boolean) => void;
  setShowFeederColors: (on: boolean) => void;
  // Legend symbol style toggle (project-persisted, ECI reference symbols).
  setEciLegend: (on: boolean) => void;
  // Legend row click: toggle one feeder's scene visibility (display-only).
  toggleFeederHidden: (idx: number) => void;
  // Legend header control: hide or show ALL feeders at once.
  setAllFeedersHidden: (hidden: boolean) => void;
  setShowSatellite: (on: boolean) => void;
  // Fetch (or re-fetch) the satellite mosaic for the current boundary origin.
  // Resolves to the image, or null on failure (error surfaced in state).
  loadSatellite: () => Promise<SatelliteImage | null>;
  setShowTerrain: (on: boolean) => void;
  setShowSlopeHeatmap: (on: boolean) => void;
  setMaxGradePct: (pct: number) => void;
  setMaxVdPct: (pct: number) => void;
  setCapacityFactorPct: (pct: number) => void;
  setShowContours: (on: boolean) => void;
  setContourIntervalFt: (ft: number) => void;
  setShowGradingLimits: (on: boolean) => void;
  setLabelDistanceScaling: (on: boolean) => void;
  setShowProposedContours: (on: boolean) => void;
  setShowCutFillPreview: (on: boolean) => void;
  setGradingSlopeRatio: (ratio: number) => void;
  setExportContoursDxf: (on: boolean) => void;
  setExportCutFillShading: (on: boolean) => void;
  setShowGrounding: (on: boolean) => void;
  setGroundingXray: (on: boolean) => void;
  setGroundingRodSpacingFt: (ft: number) => void;
  setExportGroundingDxf: (on: boolean) => void;
  setExportTrenchSectionsDxf: (on: boolean) => void;
  setIeee80Enabled: (on: boolean) => void;
  setIeee80Inputs: (patch: Partial<Ieee80Inputs>) => void;
  setScEnabled: (on: boolean) => void;
  setScInputs: (patch: Partial<ShortCircuitInputs>) => void;
  setProtectionEnabled: (on: boolean) => void;
  setProtectionInputs: (patch: Partial<ProtectionInputs>) => void;
  setEnergySimEnabled: (on: boolean) => void;
  setEnergySimInputs: (patch: Partial<EnergySimInputs>) => void;
  setGradingEnabled: (on: boolean) => void;
  setGradingInputs: (patch: Partial<GradingInputs>) => void;
  // Reject→warn→keep: returns the rejection reason (zones kept unchanged)
  // or null when the new zone set was accepted and stored.
  setGradingZones: (zones: GradingZone[]) => string | null;
  setAreaZones: (zones: AreaZone[]) => string | null;
  setDrainageEnabled: (on: boolean) => void;
  setDrainageInputs: (patch: Partial<DrainageInputs>) => void;
  setDrainageIdf: (idf: Atlas14Idf | null) => void;
  setEarthworkRates: (patch: Partial<EarthworkRates>) => void;
  setExportCostEstimate: (on: boolean) => void;
  setExportSections: (on: boolean) => void;
  // Fetch (or re-fetch) the elevation grid for the current boundary.
  // Resolves to the grid, or null on failure (error surfaced in state).
  loadTerrain: () => Promise<ElevationGrid | null>;
  setHighlightIds: (ids: string[]) => void;
  setTitleBlock: (patch: Partial<TitleBlockInfo>) => void;
  setLgiaInputs: (patch: Partial<LgiaInputs>) => void;
  // Recompute the design from the current inputs. Default path runs in the
  // design web worker (never blocks the UI; superseded runs are discarded).
  // `{ sync: true }` forces main-thread computation for callers that must
  // observe the result immediately (edit validation, transactional import,
  // undo/redo bookkeeping) — and is the only path in Node tests.
  // suppressAssignmentNotice: undo/redo/import/restore re-apply the correct
  // assignments themselves, so the "groupings reset" notice must not fire.
  regenerate: (opts?: { sync?: boolean; suppressAssignmentNotice?: boolean }) => void;
  clearFeederResetNotice: () => void;
  clearGradingZonesResetNotice: () => void;
  clearSite: () => void;

  // Layout edits (row moves + pinned trench). Both return false when the
  // engine rejects the edit — state is then reverted to the previous layout.
  // On rejection, `lastRejection` holds the engine's specific reason so the
  // UI can show it. Passing `force: true` records an engineer override: the
  // engine applies the move anyway and downgrades the rejection to a kept
  // override warning.
  moveRow: (rowIndex: number, dx: number, dy: number, force?: boolean) => boolean;
  // One-click alignment (main screen, no Edit Layout needed): align every
  // block row left / center / right within the usable yard through the same
  // validated rowMoves pipeline. Rows the engine rejects keep their automatic
  // position with a warning (never a broken layout). Returns true when at
  // least one row shifted.
  alignRows: (mode: RowAlignMode) => boolean;
  // Align ONE mirrored-pair island (its row) left/center/right; same
  // compose/validate/revert flow as alignRows. False + lastRejection on
  // rejection or when there is nothing to move.
  alignIsland: (islandN: number, mode: RowAlignMode) => boolean;
  // Mirror-align ONE island onto its nearest stacked neighbor (same X
  // center — symmetric stacked islands). Same compose/validate/revert flow
  // as alignIsland. False + lastRejection on blocked/no-op.
  mirrorAlignIsland: (islandN: number) => boolean;
  // Wrap/compact: pull block rows (or one island) toward a fence edge as far
  // as clearances allow. N/S rides the road-regenerating rowShifts
  // constraint (roads, surfacing, trenches and cables rebuild around the new
  // positions); E/W reuses the align machinery; placed islands compact
  // through their placement anchor (all four directions). Same
  // compose/validate/revert flow as align: rejected moves keep the current
  // position, `lastRejection` holds the reason. Returns true when something
  // moved.
  compactIsland: (dir: 'N' | 'S' | 'E' | 'W', islandN: number | null) => boolean;
  moveAisle: (aisleIndex: number, dy: number, force?: boolean) => boolean;
  // `coalesceKey` collapses a burst of same-key edits (a held arrow key) into
  // ONE undo step that reverts the whole burst — omit it for discrete edits
  // like a drag commit, which should each stay individually undoable.
  moveBlock: (blockN: number, dx: number, dy: number, force?: boolean, coalesceKey?: string) => boolean;
  // Put a PCS block (or a whole island's blocks, moved rigidly) at the
  // midpoint of the space it can legally occupy. Unlike a yard-bounding-box
  // center this keeps concave fences, roads, NFPA buffers and neighbouring
  // equipment in the same validation path as a drag. False + lastRejection
  // when there is nothing to move or no legal space.
  centerBlocks: (blockNs: number[]) => boolean;
  // Center a drag-placed island in its legal space by averaging its
  // E/W and N/S compact travel, applied through movePlacedIsland.
  centerPlacedIsland: (islandN: number) => boolean;
  // Drop the drafter's manual offsets for these blocks so they return to the
  // automatic (generated) position. Placed islands have no automatic
  // position, so they are not valid targets. One undo step; false when there
  // was no manual offset to clear.
  restoreAutoPosition: (blockNs: number[]) => boolean;
  // Group move: translate several blocks by the same additional (dx, dy) in
  // ONE regeneration + ONE history step. `moves` holds each block's composed
  // TOTAL offset from its automatic position. Reverts ALL of them if the
  // engine rejects any one (all-or-nothing, like a single block move).
  moveBlocksGroup: (moves: { n: number; dx: number; dy: number }[], force?: boolean, coalesceKey?: string) => boolean;
  moveEquipment: (id: string, dx: number, dy: number, force?: boolean) => boolean;
  // Rotate one equipment item 90° clockwise about its own center. Same
  // accept/reject/override contract as moveEquipment.
  rotateEquipment: (id: string, force?: boolean) => boolean;
  // Rotate one whole block (PCS + containers) 90° clockwise about its own
  // footprint center. Same contract as a block move.
  rotateBlock: (n: number, force?: boolean) => boolean;
  // Rotate a whole automatic island: every member block turns 90° clockwise
  // as ONE transaction. All the turns are staged together and validated in a
  // single pass, so a block that cannot turn rejects the whole island and
  // leaves the design byte-identical — never partially rotated. Pushes at
  // most one history entry.
  rotateBlocksGroup: (ns: number[], force?: boolean) => boolean;
  // Specific engine reason from the most recent rejected layout edit (null
  // when the last edit was accepted). Read by the UI for toast messages.
  lastRejection: string | null;
  // Non-blocking warning(s) from the most recent accepted placed-island
  // drop/move ("placed with warning": NFPA setback, road clearance, road
  // connection). Null when the placement was clean. Read by the UI.
  lastPlacedWarning: string | null;
  // Vertically center an island between its north/south clearance limits
  // (Top/Bottom = compactIsland N/S). Works for auto and placed islands.
  vcenterIsland: (islandN: number) => boolean;
  // Drafter-drawn roads (centerline polylines, site feet)
  addCustomRoad: (pts: Pt[], width?: number) => boolean;
  removeCustomRoad: (id: string) => void;
  // Pave-as-drawn override for a TRACED strip the gate-apron rule keeps as
  // reference linework: force-pave it exactly as drawn (keep-and-warn, like
  // drawn-road accept gates). Persists as a geometry fingerprint in
  // layoutEdits.pavedTracedRoads so the stale-save wholesale re-derivation
  // re-applies it. Returns false with lastRejection set when the road is not
  // an eligible traced record.
  paveTracedRoad: (id: string) => boolean;
  // Remove a pave-as-drawn override (the strip returns to the tool's own
  // gate-apron judgment). Keyed by the stored fingerprint entry.
  unpaveTracedRoad: (fp: { x: number; y: number; len: number }) => void;
  setTrenchPin: (x: number | null) => boolean;
  // Pin the MV feeder corridor centerline (perpendicular coordinate of the
  // parallel lane bundle); null = back to automatic. Returns false (state
  // unchanged) when the pin is invalid — the reject reason is toast-surfaced
  // by the caller via feederCorridorRejectReason.
  setFeederCorridorPin: (c: number | null) => boolean;
  // Drafter-drawn feeder home-run route (interior waypoints, site feet).
  // Keyed internally by the feeder's stable identity (feederRouteKey). On
  // rejection, state is unchanged, lastRejection holds the reason, and false
  // is returned; force=true applies the route despite obstacle clearance
  // (engineer override). Pass pts=null to reset a feeder's route to auto.
  setFeederRoute: (feederIdx: number, pts: Pt[] | null, force?: boolean) => boolean;
  // Remove a route override by its stable key (used by the panel list,
  // including dormant overrides whose feeder no longer exists).
  removeFeederRoute: (key: string) => void;
  // Drag-to-place a standard island (mid-island aux cluster, FJB, 2 aug
  // units) centered at `center`; angleDeg = CCW rotation from world +x
  // (0 = horizontal, 90 = vertical, any = arbitrary). `pairs` defaults to
  // the full 7+7 strip; a smaller count places a deliberate PARTIAL island.
  // Returns the engine's reject reason (state unchanged) or null on success.
  // `auxGear` is the engineer's explicit choice about the standard
  // mid-island auxiliary cluster (aux transformer + aux distribution + comms
  // cabinet). It defaults to true so existing callers keep their behaviour;
  // the interactive toolbar passes the drafter's actual choice, and a single
  // PCS module never composes a cluster regardless.
  addPlacedIsland: (
    center: Pt, angleDeg: number, pairs?: number,
    kind?: PlacedIslandKind, aug?: boolean, auxGear?: boolean
  ) => string | null;

  // ---- individually placed auxiliary / comms / panel gear ----------------
  // The counterpart to core-only island placement: every piece of gear an
  // island no longer brings along can be placed, moved, turned and removed on
  // its own. Each item's position lives in its own spec (never an equipMoves
  // delta), so the usual move/rotate/delete entry points route here for
  // "peq-" ids and the whole thing stays one undoable, persisted layout edit.
  addPlacedEquipment: (type: ManualEquipmentType, center: Pt, angleDeg?: number) => string | null;
  updatePlacedEquipment: (id: string, center: Pt, angleDeg?: number) => string | null;
  rotatePlacedEquipment: (id: string) => string | null;
  removePlacedEquipment: (id: string) => void;
  movePlacedIsland: (id: string, dx: number, dy: number, coalesceKey?: string) => string | null;
  // Rotate a drag-placed island 90 degrees about its own anchor (horizontal
  // <-> vertical). Re-validated exactly like a fresh drop: a rejection rolls
  // the rotation back and returns the engine's reason.
  rotatePlacedIsland: (id: string) => string | null;
  removePlacedIsland: (id: string) => void;

  // ---- KMZ auto-fill from the reference drawing (TRANSIENT plan) ----------
  // analyzeReferenceTrace scans the imported reference drawing, classifies
  // shapes by their KML placemark names and holds the result as a plan the
  // scene previews as ghosts. Nothing is committed until applyReferenceTrace,
  // which lands everything as ONE undoable edit. Unknown-name shapes carry a
  // size-based suggested tag the drafter can change (or set to 'ignore').
  tracePlan: TracePlan | null;
  analyzeReferenceTrace: () => boolean;
  setTraceUnknownTag: (index: number, tag: TraceUnknown['tag']) => void;
  cancelReferenceTrace: () => void;
  // Commit the plan (equipment and/or roads — per-group accept). Traced
  // geometry is reference-wins: clearance conflicts warn, never move or drop.
  applyReferenceTrace: (opts?: { equipment?: boolean; roads?: boolean }) => boolean;
  applyReferenceTraceWithProgress: (
    onProgress: (frac: number, label: string) => void,
    opts?: { equipment?: boolean; roads?: boolean }
  ) => Promise<boolean>;
  // Which plan groups the drafter has kept checked. Lives in the store so the
  // scene ghost preview and the apply commit read the SAME selection — an
  // unchecked group disappears from the preview exactly as it will from the
  // commit. Reset to all-on by every new scan. TRANSIENT (not persisted).
  traceInclude: { equipment: boolean; roads: boolean };
  setTraceInclude: (patch: Partial<{ equipment: boolean; roads: boolean }>) => void;

  // ---- manual single-gear placement ---------------------------------------
  // Drag-to-place one aux item (aux transformer, fire control panel, aux
  // distribution panel, communications cabinet) at catalog dimensions. Used
  // when the KMZ lacked the gear; also available any time.
  gearPlacement: { kind: TraceEquipKind } | null;
  setGearPlacement: (kind: TraceEquipKind | null) => void;
  addPlacedGear: (kind: TraceEquipKind, x: number, y: number, rotationDeg?: number) => string | null;

  // ---- scene bulk tagging (manual auto-fill fallback) ---------------------
  // Arm a tag, then marquee-drag over the reference drawing in the scene:
  // every drawn shape inside the box commits as that tag (equipment rectangle
  // or road strip) through the same rules as the KMZ scan — real labels,
  // per-area routing, one undo step. 'wideRoad' traces at entrance width.
  bulkTag: BulkTagKind | null;
  setBulkTag: (tag: BulkTagKind | null) => void;
  applyBulkTagRegion: (rect: { minX: number; minY: number; maxX: number; maxY: number }) => string | null;

  // ---- interactive placement session (TRANSIENT) -------------------------
  // A live placement/move preview. Deliberately NOT part of the project file,
  // a history snapshot or the design: nothing downstream (layout, routing,
  // compliance, DXF, PDF) sees a session, so abandoning one leaves the
  // project byte-identical. Only commitPlacement() mutates anything, and it
  // does so exclusively through addPlacedIsland / movePlacedIsland, so
  // validation, warnings, undo and persistence stay shared with the
  // non-interactive paths.
  placement: PlacementSession | null;
  // Start a session. `center` is the initial pointer position; the candidate
  // center is derived from it through the session's snap increment.
  beginPlacement: (init: PlacementInit) => void;
  // Raw pointer motion: keeps the smooth (unsnapped) position for drawing and
  // re-derives the deterministic candidate that validation and commit use.
  updatePlacementPointer: (pt: Pt) => void;
  // Exact numeric center entry — no snapping, the typed value IS the candidate.
  setPlacementCenter: (pt: Pt) => void;
  // Keyboard/button nudge of the candidate center by an exact step (feet).
  nudgePlacement: (dx: number, dy: number) => void;
  // Change the snap increment (0 = free); re-derives the candidate from the
  // last raw pointer position so the ghost never jumps to a stale spot.
  setPlacementSnap: (snapFt: number) => void;
  // Explicit rotation control. rotatePlacement steps by 15° CW (same as the
  // R keyboard shortcut); setPlacementAngle sets an exact angle. Orientation
  // is never inferred from drag direction.
  rotatePlacement: () => void;
  setPlacementAngle: (angleDeg: number) => void;
  // Change WHAT a live new-placement session is building (kind / pair count /
  // augmentation) without disturbing the position the drafter has already
  // aimed at. A move session is never reconfigured: it previews the existing
  // placement's own shape.
  setPlacementConfig: (cfg: {
    kind?: PlacedIslandKind | 'equipment'; pairs?: number; aug?: boolean;
    auxGear?: boolean; equipType?: ManualEquipmentType;
  }) => void;
  // Abandon the session. Guaranteed to touch nothing but the session itself.
  cancelPlacement: () => void;
  // The exact spec the current candidate represents (null = no session). The
  // commit writes THIS geometry, so preview and commit cannot disagree.
  placementSpec: () => PlacedIslandSpec | null;
  // The single manual item the candidate represents (null unless the session
  // is placing equipment). Same preview-equals-commit contract.
  placementEquipmentSpec: () => ManualEquipmentSpec | null;
  // Commit the previewed candidate. Returns the engine's reject reason (state
  // unchanged, session kept so the drafter can adjust) or null on success
  // (session cleared).
  commitPlacement: () => string | null;
  // Remove an AUTOMATICALLY generated interior road piece by its stable id
  // ("aisle-<k>" / "corridor-<k>"). The suppression persists with the project
  // and every dependent artifact (network, surfacing, cables, feeders,
  // exports) is rebuilt without it. Returns the engine's access warning when
  // the removal breaks vehicle access (the removal is still applied), else
  // null.
  removeGeneratedRoad: (id: string) => string | null;
  // Restore a previously removed generated road piece.
  restoreGeneratedRoad: (id: string) => void;
  // Delete a road AREA: the general primitive behind "delete this road" and
  // "delete this span of road". `poly` is a closed ring in site feet; whatever
  // road surface falls inside it is removed, whichever kind of road produced
  // it (perimeter ring, gate apron, drive aisle, middle road, drawn road).
  // Returns the engine's access warning when the deletion strands equipment
  // (the deletion is still applied — an access break is the drafter's call),
  // or a dormant note when the area held no road, else null.
  cutRoadArea: (poly: Pt[], label?: string) => string | null;
  // Restore one road cut / every road cut.
  restoreRoadCut: (id: string) => void;
  restoreAllRoadCuts: () => void;
  // Delete AUTOMATICALLY generated equipment. Both actions persist with the
  // project, are undoable, and rebuild every dependent artifact (islands,
  // feeders, cables, trenching, reserves, capacity, BOM, exports).
  //   deleteBlock(n)      — one whole block: PCS + its containers + aug bay.
  //   deleteEquipment(id) — one item; a PCS id escalates to its whole block
  //                         (containers cannot be built without an inverter).
  // Both return a human-readable note when the deletion had a consequence
  // worth surfacing (escalation, dormant id), else null. Deleting the LAST
  // remaining block is refused: an empty yard is a reset, not an edit.
  deleteBlock: (n: number) => string | null;
  deleteEquipment: (id: string) => string | null;
  // deleteAutoIsland(blockNs) — every member block of one automatic island in
  // a SINGLE transaction: one regeneration, one undo step. Returns how many
  // blocks were removed plus any note worth surfacing.
  deleteAutoIsland: (blockNs: number[]) => { deleted: number; note: string | null };
  // deleteEquipmentBatch — ONE transaction for a heterogeneous multi-selection:
  // automatic blocks, individual equipment ids (PCS ids escalate to their
  // block; peq-<n> ids remove the placed-equipment constraint), and whole
  // hand-placed islands. One regeneration, one undo step. Invalid entries are
  // skipped with a note, never a partial mutation.
  deleteEquipmentBatch: (items: { blocks?: number[]; equipment?: string[]; placedIslandIds?: string[] }) => { deleted: number; notes: string[] };
  // removeAllEquipment — empty the yard as ONE undoable edit: every automatic
  // block and standalone item goes onto the removal lists (so the restore
  // surfaces still show them) and every hand-placed island/gear constraint is
  // cleared. Returns how many items were removed (0 = nothing to do).
  removeAllEquipment: () => number;
  // Restore drafter-deleted equipment. restoreDeleted() with no argument puts
  // everything back.
  restoreDeletedBlock: (n: number) => void;
  restoreDeletedEquipment: (id: string) => void;
  restoreAllDeleted: () => void;
  setLaydownPin: (pt: Pt | null) => boolean;
  setLaydownRect: (pt: Pt | null, size: { length: number; width: number } | null) => boolean;
  setFutureAugPin: (zoneId: string, pt: Pt | null) => boolean;
  setGatePin: (pt: Pt | null) => boolean;
  resetLayoutEdits: () => void;
  // Internal helper: record a pre-edit snapshot after a successful edit.
  pushHistory: (snap: HistorySnap) => void;
  undoEdit: () => boolean;
  redoEdit: () => boolean;
  // Jump to an arbitrary timeline position (0 = before the first recorded
  // action, undoStack.length = current). Implemented as repeated undo/redo,
  // so a jump is itself fully undoable.
  jumpHistory: (pos: number) => void;

  // Session + project files
  restoreSession: () => void;
  dismissSavedSession: () => void;
  exportProjectJson: () => string | null;
  importProject: (jsonText: string) => string | null; // null = ok, else error message

  setPlacingSubstation: (on: boolean) => void;
  // Both return a human-readable notice when a pinned feeder corridor had to
  // be dropped (reset to automatic) as a side effect, else null. Callers
  // surface the notice non-blockingly (toast) so the drafter knows why the
  // corridor jumped back.
  placeSubstation: (pt: Pt) => string | null;
  removeSubstation: () => string | null;
  // Design-wide default MV home-run routing mode (90° corridor comb vs.
  // shared straight diagonal corridor). Per-feeder overrides live in
  // layoutEdits.feederModes; a drawn route (feederRoutes) beats both.
  feederRoutingMode: FeederRoutingMode;
  setFeederRoutingMode: (mode: FeederRoutingMode) => void;
  // Per-feeder routing-mode override (null = back to the design default).
  // Keyed internally by stable feeder identity (feederRouteKey).
  setFeederMode: (feederIdx: number, mode: FeederRoutingMode | null) => boolean;
  // Feeder-routing optimizer → Apply. Writes the design-wide default mode, the
  // per-feeder overrides and the corridor pin together so the whole
  // re-orientation is ONE undo step (setFeederRoutingMode + setFeederMode +
  // setFeederCorridorPin would leave the drafter unwinding it click by click).
  applyFeederRoutingCandidate: (params: FeederRoutingParams) => boolean;
  // Legend → scene bridge: the feeder idx the drafter asked to reroute from
  // the MV FEEDERS legend while in Edit Layout. The edit layer consumes the
  // request (enters the waypoint-draw flow) and clears it back to null.
  feederDrawRequest: number | null;
  requestFeederDraw: (idx: number | null) => void;
  // Legend → scene bridge: signals the waypoint-draw flow for the aux feeder
  // circuit (the whole 34.5 kV daisy chain as one drawable path). The edit
  // layer consumes the flag (enters aux draw mode) and clears it via
  // requestAuxFeederDraw(). Parallel to feederDrawRequest for MV feeders.
  auxFeederDrawRequest: boolean;
  requestAuxFeederDraw: () => void;
  // Drafter-drawn aux feeder route (interior waypoints, site feet).
  // Pass pts=null to reset back to automatic routing.
  // Returns false (state unchanged, lastRejection set) when pts are invalid.
  // force=true applies the route despite the validation warning.
  setAuxFeederRoute: (pts: Pt[] | null, force?: boolean) => boolean;
  // Whether the scene's Edit Layout mode is active (mirrored from the
  // DesignScene toggle so overlays outside the canvas — e.g. the feeder
  // legend — can adapt their click behavior).
  layoutEditActive: boolean;
  setLayoutEditActive: (on: boolean) => void;
  setFeederSize: (feederIdx: number, size: FeederConductorSize) => void;
  setFeederMaterial: (m: ConductorMaterial) => void;
  resetFeederSizes: () => void;
  assignInverterToFeeder: (invId: string, feederIdx: number) => boolean;
  resetFeederOverrides: () => void;
  recomputeFeeders: () => void;
  // Re-route every area's feeders onto its resolved take-off (multi-area).
  // Falls back to recomputeFeeders for a single-area project.
  recomputeAllAreaFeeders: () => void;
  /** Export-time routing-gate audit across EVERY exportable yard (all BESS
   *  areas on a multi-area project, the live design otherwise). Refreshes
   *  each design's gate warning batch and returns per-area results.
   *  `area` is null for the single-area path. Pure verification — routes
   *  never change. */
  auditRoutingGatesForExport: () => Array<{ area: string | null; results: RoutingGateResult[] }>;

  // --- Substation MV take-offs (multi-area) ---
  // Enter/leave "click the map to move this take-off" mode.
  setPlacingTakeoff: (id: string | null) => void;
  // Every mutator returns null on success, or a TAKEOFF_REJECT_PREFIX reason
  // with state left completely unchanged. Callers toast the reason.
  addTakeoff: (servesAreaId: string | null) => string | null;
  moveTakeoff: (id: string, pt: Pt) => string | null;
  aimTakeoff: (id: string, dir: TakeoffDirection) => string | null;
  setTakeoffServes: (id: string, servesAreaId: string | null) => string | null;
  removeTakeoff: (id: string) => string | null;
}

// Monotonic token for regeneration superseding: only the newest regeneration
// (sync or worker-async) may apply its result to the store.
let regenToken = 0;
// Invalidation token for the imported reference drawing: every path that
// takes ownership of the drawing (KMZ capture, project open, clear) bumps it,
// and any in-flight async loadDrawing() result is dropped unless the token
// still matches — a stale load can never resurrect another site's drawing.
let drawingEpoch = 0;

export const useDesignStore = create<DesignState>((set, get) => ({
  boundary: null,
  design: null,
  siteAreas: [],
  activeAreaId: null,
  drawing: null,
  drawingLayerVis: {},
  showDrawing: true,
  drawingVisibility: { ...DEFAULT_DRAWING_VISIBILITY },
  configId: DEFAULT_CONFIGURATION_ID,
  targetMW: getConfiguration(DEFAULT_CONFIGURATION_ID).refMW,
  targetMWh: getConfiguration(DEFAULT_CONFIGURATION_ID).refMWh,
  hotClimate: true,
  containersPerPcs: 3,
  roadMode: 'auto',
  autoRoadWrap: true,
  ringMode: 'fence',
  perimeterBand: 'standard',
  fencePlacement: 'inset',
  laydownPct: 0,
  augmentPct: 0,
  futurePhaseUnits: 0,
  surfacingMode: 'between-roads',
  surfacingDepthIn: SURFACING_DEPTH_IN_DEFAULT,
  deadSpaceTrim: false,
  dcRouting: 'orthogonal',
  feederRoutingMode: 'orthogonal',
  feederDrawRequest: null,
  auxFeederDrawRequest: false,
  layoutEditActive: false,
  textureSetId: DEFAULT_TEXTURE_SET_ID,
  // GE PCS exterior defaults to GE Green (3D preview only); null is the
  // drafter's explicit "factory look" choice.
  gePcsColor: GE_PCS_GREEN,
  arrangement: 'sw',
  arrangementExplicit: false,
  latticeShift: null,
  gateEdge: null,
  layoutEdits: {},
  yardRotationDeg: 0,
  textOverrides: {},
  setTextOverride: (key, ov) => set(s => ({ textOverrides: { ...s.textOverrides, [key]: ov } })),
  clearTextOverride: (key) => set(s => {
    const next = { ...s.textOverrides };
    delete next[key];
    return { textOverrides: next };
  }),
  clearAllTextOverrides: () => set({ textOverrides: {} }),
  lastRejection: null,
  lastPlacedWarning: null,
  placement: null,
  undoStack: [],
  redoStack: [],
  savedSession: readSavedSession(),
  highlightIds: [],
  showLabels: (() => {
    try {
      return localStorage.getItem('nextera-show-labels') !== 'false';
    } catch {
      return true;
    }
  })(),
  realisticModels: (() => {
    try {
      return localStorage.getItem('nextera-realistic-models') === 'true';
    } catch {
      return false;
    }
  })(),
  showGateModel: (() => {
    try {
      return localStorage.getItem('nextera-show-gate-model') === 'true';
    } catch {
      return false;
    }
  })(),
  showFence3D: (() => {
    try {
      return localStorage.getItem('nextera-show-fence-3d') === 'true';
    } catch {
      return false;
    }
  })(),
  // Default ON (colored); persisted opt-out ('false') is respected.
  showFeederColors: (() => {
    try {
      return localStorage.getItem('nextera-feeder-colors') !== 'false';
    } catch {
      return true;
    }
  })(),
  eciLegend: false,
  showFeederNfpaText: false,
  tourCadLayers: null,
  satellite: null,
  satelliteStatus: 'idle',
  satelliteError: null,
  // Default ON: drafters should see real aerial context without hunting for
  // the toggle. Persisted opt-out ('false') is respected.
  showSatellite: (() => {
    try {
      return localStorage.getItem('nextera-show-satellite') !== 'false';
    } catch {
      return true;
    }
  })(),
  terrain: null,
  terrainStatus: 'idle',
  terrainError: null,
  // Default OFF: the displaced terrain mesh is expensive to render, so the
  // relief drape is opt-in ('true' turns it on). Elevation data still loads
  // automatically, so slope/cut-fill screening and exports are unaffected.
  // A previously stored explicit choice ('true'/'false') is respected.
  showTerrain: (() => {
    try {
      return localStorage.getItem('nextera-show-terrain') === 'true';
    } catch {
      return false;
    }
  })(),
  showSlopeHeatmap: false,
  // Contours default OFF (opt-in): the contour drape adds hundreds of line
  // draws, so drafters turn it on when reading grade breaks. A previously
  // stored explicit choice ('true'/'false') is respected.
  showContours: (() => {
    try {
      return localStorage.getItem('nextera-show-contours') === 'true';
    } catch {
      return false;
    }
  })(),
  // Grading limits default OFF (opt-in): the tie-in/hachure linework is a
  // grading-review overlay, not an everyday view. Per-browser preference
  // (persisted explicit choice respected), never in the project JSON.
  showGradingLimits: (() => {
    try {
      return localStorage.getItem('nextera-show-grading-limits') === 'true';
    } catch {
      return false;
    }
  })(),
  // Label zoom scaling default ON (persisted opt-out): the camera-distance
  // check only runs while the camera moves, so the default cost is minimal;
  // a saved 'false' keeps it off. Per-browser preference, never project JSON.
  labelDistanceScaling: (() => {
    try {
      return localStorage.getItem('nextera-label-distance-scaling') !== 'false';
    } catch {
      return true;
    }
  })(),
  // Proposed FG contours default ON (persisted opt-out): they only render
  // when the opt-in FG surface itself is enabled, so the default scene is
  // untouched. Per-browser preference, never in the project JSON.
  showProposedContours: (() => {
    try {
      return localStorage.getItem('nextera-show-proposed-contours') !== 'false';
    } catch {
      return true;
    }
  })(),
  // Cut/fill drape default OFF: it recolors the whole relief, so drafters
  // turn it on when reviewing earthwork. Per-browser preference (localStorage),
  // never in the project JSON or exports.
  showCutFillPreview: (() => {
    try {
      return localStorage.getItem('nextera-show-cutfill-preview') === 'true';
    } catch {
      return false;
    }
  })(),
  // Daylight slope ratio for the grading overlay (H:V). 3:1 is the common
  // default; sandy soils need flatter 4:1, rock can hold 2:1. Per-browser
  // preference (localStorage), never in the project JSON or exports.
  gradingSlopeRatio: (() => {
    try {
      const v = Number(localStorage.getItem('nextera-grading-slope-ratio'));
      return [2, 3, 4].includes(v) ? v : 3;
    } catch {
      return 3;
    }
  })(),
  // DXF contour export is strictly opt-in (default export stays byte-identical).
  exportContoursDxf: (() => {
    try {
      return localStorage.getItem('nextera-export-contours-dxf') === 'true';
    } catch {
      return false;
    }
  })(),
  // GP-1 cut/fill shading is strictly opt-in (default sheet stays byte-identical).
  exportCutFillShading: (() => {
    try {
      return localStorage.getItem('nextera-export-cutfill-shading') === 'true';
    } catch {
      return false;
    }
  })(),
  // Grounding preview default OFF: screening overlay, shown on demand.
  showGrounding: (() => {
    try {
      return localStorage.getItem('nextera-show-grounding') === 'true';
    } catch {
      return false;
    }
  })(),
  groundingXray: (() => {
    try {
      return localStorage.getItem('nextera-grounding-xray') === 'true';
    } catch {
      return false;
    }
  })(),
  groundingRodSpacingFt: (() => {
    try {
      const v = Number(localStorage.getItem('nextera-grounding-rod-spacing-ft'));
      return [25, 50, 100].includes(v) ? v : 50;
    } catch {
      return 50;
    }
  })(),
  // DXF grounding export is strictly opt-in (default export stays byte-identical).
  exportGroundingDxf: (() => {
    try {
      return localStorage.getItem('nextera-export-grounding-dxf') === 'true';
    } catch {
      return false;
    }
  })(),
  // DXF trench section schedule is strictly opt-in (default stays byte-identical).
  exportTrenchSectionsDxf: (() => {
    try {
      return localStorage.getItem('nextera-export-trench-sections-dxf') === 'true';
    } catch {
      return false;
    }
  })(),
  // Legacy full-area surfacing mesh is strictly opt-in (default: aug-area
  // mesh only).
  exportSurfacingMesh: (() => {
    try {
      return localStorage.getItem('nextera-export-surfacing-mesh') === 'true';
    } catch {
      return false;
    }
  })(),
  // IEEE-80 study card default OFF; inputs restored from untrusted
  // localStorage JSON through the same deep-sanitize policy as layoutEdits.
  ieee80Enabled: (() => {
    try {
      return localStorage.getItem('nextera-ieee80-enabled') === 'true';
    } catch {
      return false;
    }
  })(),
  ieee80Inputs: (() => {
    try {
      const raw = localStorage.getItem('nextera-ieee80-inputs');
      return raw ? sanitizeIeee80Inputs(JSON.parse(raw)) : { ...DEFAULT_IEEE80_INPUTS };
    } catch {
      return { ...DEFAULT_IEEE80_INPUTS };
    }
  })(),
  // Per-bus short-circuit study card default OFF; inputs restored from
  // untrusted localStorage JSON through the same deep-sanitize policy.
  scEnabled: (() => {
    try {
      return localStorage.getItem('nextera-sc-enabled') === 'true';
    } catch {
      return false;
    }
  })(),
  scInputs: (() => {
    try {
      const raw = localStorage.getItem('nextera-sc-inputs');
      return raw ? sanitizeScInputs(JSON.parse(raw)) : { ...DEFAULT_SC_INPUTS };
    } catch {
      return { ...DEFAULT_SC_INPUTS };
    }
  })(),
  // Protection study card default OFF; inputs restored from untrusted
  // localStorage JSON through the same deep-sanitize policy.
  protectionEnabled: (() => {
    try {
      return localStorage.getItem('nextera-protection-enabled') === 'true';
    } catch {
      return false;
    }
  })(),
  protectionInputs: (() => {
    try {
      const raw = localStorage.getItem('nextera-protection-inputs');
      return raw ? sanitizeProtectionInputs(JSON.parse(raw)) : { ...DEFAULT_PROTECTION_INPUTS };
    } catch {
      return { ...DEFAULT_PROTECTION_INPUTS };
    }
  })(),
  // Energy simulation is project data (like gradingZones): default OFF with
  // documented default inputs; restored from the project/session file only.
  energySimEnabled: false,
  energySimInputs: { ...DEFAULT_ENERGY_SIM_INPUTS },
  // Proposed grading surface card default OFF; inputs restored from
  // untrusted localStorage JSON through the same deep-sanitize policy.
  gradingEnabled: (() => {
    try {
      return localStorage.getItem('nextera-grading-enabled') === 'true';
    } catch {
      return false;
    }
  })(),
  gradingInputs: (() => {
    try {
      const raw = localStorage.getItem('nextera-grading-inputs');
      return raw ? sanitizeGradingInputs(JSON.parse(raw)) : { ...DEFAULT_GRADING_INPUTS };
    } catch {
      return { ...DEFAULT_GRADING_INPUTS };
    }
  })(),
  // Engineering input — restored from the project/session file, never
  // localStorage. Empty = feature off (exact-identity default).
  gradingZones: [],
  // Drafter-drawn area zones — same policy: project data, empty by default.
  areaZones: [],
  // Earthwork unit rates restored from untrusted localStorage JSON through
  // the same sanitize policy; cost-on-GP-1 toggle strictly opt-in so the
  // default sheet stays byte-identical.
  earthworkRates: (() => {
    try {
      const raw = localStorage.getItem('nextera-earthwork-rates');
      return raw ? sanitizeEarthworkRates(JSON.parse(raw)) : { ...DEFAULT_EARTHWORK_RATES };
    } catch {
      return { ...DEFAULT_EARTHWORK_RATES };
    }
  })(),
  exportCostEstimate: (() => {
    try {
      return localStorage.getItem('nextera-export-cost-estimate') === 'true';
    } catch {
      return false;
    }
  })(),
  exportSections: (() => {
    try {
      return localStorage.getItem('nextera-export-sections') === 'true';
    } catch {
      return false;
    }
  })(),
  // Drainage screening card default OFF; inputs restored from untrusted
  // localStorage JSON through the same deep-sanitize policy.
  drainageEnabled: (() => {
    try {
      return localStorage.getItem('nextera-drainage-enabled') === 'true';
    } catch {
      return false;
    }
  })(),
  drainageInputs: (() => {
    try {
      const raw = localStorage.getItem('nextera-drainage-inputs');
      return raw ? sanitizeDrainageInputs(JSON.parse(raw)) : { ...DEFAULT_DRAINAGE_INPUTS };
    } catch {
      return { ...DEFAULT_DRAINAGE_INPUTS };
    }
  })(),
  // Fetched NOAA Atlas 14 IDF table (untrusted localStorage JSON, deep-
  // sanitized; null until fetched or when the restore fails).
  drainageIdf: (() => {
    try {
      const raw = localStorage.getItem('nextera-drainage-idf');
      return raw ? sanitizeAtlas14Idf(JSON.parse(raw)) : null;
    } catch {
      return null;
    }
  })(),
  // 0 = auto interval from site relief (1/2/5 ladder, ~8-16 lines).
  contourIntervalFt: (() => {
    try {
      const v = Number(localStorage.getItem('nextera-contour-interval-ft'));
      return Number.isFinite(v) && [0, 0.5, 1, 2, 5, 10, 20].includes(v) ? v : 0;
    } catch {
      return 0;
    }
  })(),
  maxGradePct: (() => {
    try {
      const v = Number(localStorage.getItem('nextera-max-grade-pct'));
      return Number.isFinite(v) && v >= 1 && v <= 50 ? v : 5;
    } catch {
      return 5;
    }
  })(),
  maxVdPct: (() => {
    try {
      const v = Number(localStorage.getItem('nextera-max-vd-pct'));
      return Number.isFinite(v) && v >= 0.5 && v <= 10 ? v : 3;
    } catch {
      return 3;
    }
  })(),
  capacityFactorPct: (() => {
    try {
      const v = Number(localStorage.getItem('nextera-capacity-factor-pct'));
      return Number.isFinite(v) && v >= 5 && v <= 100 ? v : 35;
    } catch {
      return 35;
    }
  })(),
  titleBlock: defaultTitleBlock(),
  lgiaInputs: { ...DEFAULT_LGIA_INPUTS },
  isLoading: false,
  busyOverlay: null,
  computing: false,
  error: null,
  inspectTrenchRequest: 0,
  inspectTrenchHandled: 0,
  overviewRequest: 0,
  overviewHandled: 0,
  cameraPoseRequest: null,
  orthoCameraPoseRequest: null,
  coverCaptureReady: false,
  forceRealisticNearCount: 0,
  realisticDetailApplied: true,
  coverCaptureRequest: null,
  coverCaptureResult: null,
  cameraPoseHandled: 0,
  orthoCameraPoseHandled: 0,
  walkMode: false,
  tourActive: false,
  tourRecord: false,
  tourSeek: null,
  tourPhase: null,
  tourGrounding: false,
  tourDcSwap: 0,
  tourFade: 0,
  tourCaption: null,
  tourStatAlpha: 0,
  tourStatCard: null,
  tourGhostAlpha: 0,
  tourGhosts: null,
  tourIntroT: 0,
  tourIntroInfo: null,
  tourShowcaseSpeed: 1,
  tourOptions: {},
  marketingStillsRequest: 0,
  offlineRenderRequest: 0,
  offlineRenderOpts: null,
  offlineRenderActive: false,

  substation: null,
  placingSubstation: false,
  areaFeeders: {},
  feederEndpoint: null,
  takeoffs: null,
  placingTakeoffId: null,
  feeders: [],
  feederAssignments: {},
  feederResetNotice: null,
  gradingZonesResetNotice: null,
  feederSizes: {},
  feederMaterial: 'Al',
  maxPcsPerFeeder: MAX_INVERTERS_PER_FEEDER,
  hiddenFeeders: new Set<number>(),

  boundaryPicker: null,

  // Shared post-parse path for KMZ upload, sample load, and picker choice:
  // new site = fresh imagery + fresh history + auto-filled title block.
  applyBoundary: (boundary: SiteBoundary) => {
    bumpSatelliteEpoch();
    set({
      boundary,
      boundaryPicker: null,
      isLoading: false,
      satellite: null,
      satelliteStatus: 'idle',
      satelliteError: null,
      terrain: null,
      terrainStatus: 'idle',
      terrainError: null,
      yardRotationDeg: 0,
      // Reference linework belongs to the file it came from. Every import path
      // captures the new drawing right after this, so clearing here just stops
      // the previous site's drawing showing under a different parcel.
      drawing: null,
      drawingLayerVis: {},
      undoStack: [],
      redoStack: [],
      titleBlock: {
        ...get().titleBlock,
        // Display name defaulted from the KMZ, with generic parcel suffixes
        // ("... BOUNDARY", "... PARCEL") stripped so raw layer names don't
        // leak into the drawing title. Always editable in the title block.
        projectName: defaultProjectDisplayName(boundary.kmlName || boundary.name),
        location: boundary.location || '',
      },
      // LGIA data sheet inputs are project-specific nameplate/settings data —
      // carrying them into a different site would silently suppress the
      // placeholders on the new project's LGIA sheet. Fresh site = fresh
      // placeholders (project import restores its own saved values).
      lgiaInputs: { ...DEFAULT_LGIA_INPUTS },
      // Grading zones are anchored to a specific fence — a different site
      // would leave them floating outside it (project import restores its
      // own saved zones after this).
      gradingZones: [],
      // Area zones are anchored to a specific parcel — same rule.
      areaZones: [],
    });
    get().regenerate();
    if (get().showSatellite) void get().loadSatellite();
    void get().loadTerrain();
  },

  // Load KML text: if more than one parcel-scale polygon exists, open the
  // boundary picker instead of silently taking the first polygon.
  loadKmlWithPicker: (kmlText: string, sourceName: string, boundaryNames?: string[]) => {
    let options = listKmlBoundaryOptions(kmlText);
    if (boundaryNames?.length) {
      const wanted = boundaryNames.map(n => n.toLowerCase());
      const filtered = options.filter(o => wanted.includes(o.name.toLowerCase()));
      if (filtered.length) options = filtered;
    }
    if (options.length > 1) {
      set({ boundaryPicker: { sourceName, kmlText, options }, isLoading: false, error: null });
      return;
    }
    const boundary = parseKmlText(kmlText, sourceName, options[0]?.index ?? 0);
    boundary.name = sourceName;
    get().applyBoundary(boundary);
    get().captureDrawing(kmlText, sourceName, boundary.origin);
  },

  loadKmz: async (file: File) => {
    set({ isLoading: true, error: null });
    try {
      const kmlText = await extractKmlText(file);
      const sourceName = file.name.replace(/\.km[lz]$/i, '');
      get().loadKmlWithPicker(kmlText, sourceName);
    } catch (e: any) {
      set({ error: e?.message || 'Failed to parse KMZ file', isLoading: false });
    }
  },

  loadSample: async (url: string, name: string, boundaryNames?: string[]) => {
    set({ isLoading: true, error: null });
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Failed to fetch sample site (${res.status})`);
      const blob = await res.blob();
      const file = new File([blob], `${name}.kmz`);
      const kmlText = await extractKmlText(file);
      get().loadKmlWithPicker(kmlText, name, boundaryNames);
    } catch (e: any) {
      set({ error: e?.message || 'Failed to load sample site', isLoading: false });
    }
  },

  chooseBoundary: (index: number) => {
    const picker = get().boundaryPicker;
    if (!picker) return;
    try {
      const boundary = parseKmlText(picker.kmlText, picker.sourceName, index);
      boundary.name = picker.sourceName;
      get().applyBoundary(boundary);
      get().captureDrawing(picker.kmlText, picker.sourceName, boundary.origin);
    } catch (e: any) {
      set({ error: e?.message || 'Failed to load the selected boundary', boundaryPicker: null });
    }
  },

  // Import every listed outline as ONE multi-area site. All areas share a
  // single projection frame (parseKmlAreas), so the footprints keep their true
  // separation instead of stacking on the origin. The first BESS area becomes
  // the active editing target and is mirrored into boundary/design, which is
  // what every existing single-area code path already reads.
  chooseAllBoundaries: () => {
    void get().chooseAllBoundariesWithProgress(() => {});
  },

  chooseAllBoundariesWithProgress: async (onProgress) => {
    const picker = get().boundaryPicker;
    if (!picker) return;
    const paint = () => new Promise<void>(r => {
      const raf = typeof requestAnimationFrame === 'function'
        ? requestAnimationFrame
        : (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0) as unknown as number;
      raf(() => raf(() => r()));
    });
    try {
      onProgress(0.02, 'Reading site outlines…');
      await paint();
      const boundaries = parseKmlAreas(
        picker.kmlText,
        picker.sourceName,
        picker.options.map(o => o.index)
      );
      const areas: SiteArea[] = boundaries.map((b, i) => ({
        id: `area-${i}`,
        name: b.name,
        kind: inferAreaKind(b.name),
        design: null,
        boundary: b,
      }));
      const active = areas.find(a => a.kind === 'bess') ?? areas[0];
      const drawing = parseKmlDrawing(picker.kmlText, picker.sourceName, boundaries[0].origin);
      onProgress(0.08, 'Preparing the active area…');
      await paint();
      // applyBoundary resets imagery/history/title block and regenerates the
      // active area; keep satellite clear+reload for correct map registration.
      set({ siteAreas: areas, activeAreaId: active.id });
      const b = { ...active.boundary, name: picker.sourceName };
      get().applyBoundary(b);
      ++drawingEpoch;
      set({ drawing, drawingLayerVis: defaultDrawingLayerVis(drawing), showDrawing: true });
      void saveDrawing(drawing);
      // Surgical: build each area with yields so the busy overlay stays live.
      // Active area was already laid out by applyBoundary → regenerate(); still
      // run only-passes for every id so neighbour yards and heals stay consistent.
      const ids = get().siteAreas.map(a => a.id);
      const n = Math.max(1, ids.length);
      for (let i = 0; i < ids.length; i++) {
        const area = get().siteAreas.find(a => a.id === ids[i]);
        const name = area?.name ?? `area ${i + 1}`;
        onProgress(0.1 + 0.8 * (i / n), `Building “${name}” (${i + 1} of ${n})…`);
        await paint();
        get().regenerateAreas({ only: ids[i], skipFeederRecompute: true });
      }
      onProgress(0.95, 'Routing feeders…');
      await paint();
      if (get().siteAreas.length >= 2) get().recomputeAllAreaFeeders();
      onProgress(1, 'Done');
    } catch (e: any) {
      set({
        error: e?.message || 'Failed to load the site areas',
        boundaryPicker: null,
        siteAreas: [],
        activeAreaId: null,
      });
    }
  },

  setBusyOverlay: (next) => set({ busyOverlay: next }),

  // Lay out every area of a multi-area site. Substation footprints get a
  // fence and lot line but no BESS blocks; a single infeasible area records
  // its own error instead of failing the whole site.
  regenerateAreas: (opts?: { only?: string; skipFeederRecompute?: boolean }) => {
    const s = get();
    const { activeAreaId, configId, targetMW, targetMWh } = s;
    // Start from the committed list so an in-progress edit on the active area
    // is regenerated with, not without, the drafter's current changes.
    const siteAreas = commitActiveAreaEdits(s);
    if (siteAreas.length === 0) return;
    // Project-wide options. Per-area options (gate edge, arrangement, lattice
    // shift, constraints, exclusion zones) come from each area's own edits, so
    // editing one footprint never re-poses another.
    const shared = {
      hotClimate: s.hotClimate,
      containersPerPcs: s.containersPerPcs,
      roadMode: s.roadMode,
      // A normal multi-area BESS design must retain its access roads. The
      // layout engine still honors the drafter's explicit compact selection,
      // but automatic mode now retains road-aware shortfalls with a clear
      // per-area warning instead of silently returning a compact yard.
      multiArea: siteAreas.length > 1,
      autoRoadWrap: s.autoRoadWrap,
      ringMode: s.ringMode,
      perimeterBand: s.perimeterBand,
      fencePlacement: s.fencePlacement,
      laydownPct: s.laydownPct,
      augmentPct: s.augmentPct,
      futurePhaseUnits: s.futurePhaseUnits,
      surfacingMode: s.surfacingMode,
      surfacingDepthIn: s.surfacingDepthIn,
      deadSpaceTrim: s.deadSpaceTrim,
      dcRouting: s.dcRouting,
    };
    // The selected capacity is the rating of EACH BESS area, not a project
    // total to be divided among them. Picking 125 MW / 500 MWh means every
    // BESS footprint is designed to 125 MW, so a four-area site totals
    // 500 MW. Dividing here (the previous behavior) gave each area a
    // fraction of the nameplate — a 125 MW selection laid out ~31 MW yards
    // and still reported itself as "125 MW".
    const perAreaMW = targetMW;
    const perAreaMWh = targetMWh;
    // Which BESS areas each substation collects, so every substation yard can
    // place one collector feeder position per area it serves.
    const collection = substationCollectionMap(siteAreas);
    // Stale-project self-heal: a save pre-dating traced ratings carries traced
    // gear with no nameplate, so every reload would rate PCS at the catalog
    // block MW (the "wrong MW" the drafter keeps seeing). When the reference
    // drawing's sheet specs are loaded, derive the same per-unit rating the
    // scan would have written. In-memory only — edits stay untouched.
    const healingRatings =
      siteAreas.some(a => a.kind === 'bess' && editsNeedTracedRatings(a.edits?.layoutEdits))
        ? tracedRatingsFromSpecs(
            s.drawing?.sheetSpecs,
            // The sheet rating splits across built TRACED units only —
            // drafter-placed manual gear must not dilute the per-unit share.
            siteAreas.flatMap(a =>
              (a.edits?.layoutEdits?.placedEquipment ?? [])
                .filter(p => (p as { source?: string }).source === 'trace')))
        : undefined;
    const next = siteAreas.map(area => {
      // Targeted regeneration: leave every other area untouched (including
      // ones that still have design: null — the async Show-all path builds
      // those in their own only-pass).
      if (opts?.only && area.id !== opts.only) return area;
      const ed = areaEditsToState(area.edits);
      // Substation footprints get civil works — fence, perimeter road and a
      // gate — plus one collector feeder position per BESS area they collect.
      // The rest of the interior stays clear for the feeders that run in from
      // those areas.
      if (area.kind === 'substation') {
        try {
          const collects = (collection.get(area.id) ?? []).map(b => ({
            id: b.id,
            name: b.name,
            // Each BESS area is designed to the full per-area target, so that
            // is what it contributes to its substation.
            mw: perAreaMW,
          }));
          return {
            ...area,
            design: generateSubstationYard(area.boundary, { gateEdge: ed.gateEdge, collects, fencePlacement: s.fencePlacement }),
            error: undefined,
          };
        } catch (e: any) {
          return {
            ...area,
            design: emptyAreaDesign(area.boundary, s.fencePlacement),
            error: e?.message || 'Substation yard layout failed for this area',
          };
        }
      }
      if (area.kind !== 'bess') {
        return { ...area, design: emptyAreaDesign(area.boundary, s.fencePlacement), error: undefined };
      }
      try {
        const tracedFenceStandard = isTracedBessYard(ed.layoutEdits);
        const areaConfig = getConfiguration(configId);
        const normalizedLayoutEdits: LayoutConstraints = {
          ...ed.layoutEdits,
          ...(ed.layoutEdits.placedEquipment
            ? {
                placedEquipment: normalizeTracedPlacedEquipment(
                  ed.layoutEdits.placedEquipment,
                  areaConfig,
                  s.hotClimate,
                ),
              }
            : {}),
        };
        const healingFence = tracedFenceStandard
          ? fencePolygonForLayout(area.boundary.polygon, ed.layoutEdits, s.fencePlacement)
          : (area.design?.fence?.length
              ? area.design.fence
              : fencePolygonFor(area.boundary.polygon, s.fencePlacement));
        const healingFencePlacement: FencePlacementMode = tracedFenceStandard
          ? 'property-line'
          : s.fencePlacement;
        const design = generateSiteDesign(
          area.boundary,
          areaConfig,
          perAreaMW,
          perAreaMWh,
          {
            ...shared,
            // Only pass an arrangement the drafter actually chose. An
            // unedited area must leave this undefined: the layout engine
            // reads a defined arrangement as a deliberate engineering input
            // and skips its road-aware packing search, which is what left
            // every imported footprint underfilled. Undefined and 'sw'
            // produce the same base layout, so this is byte-identical for
            // areas that stay on the default.
            //
            // `edits.arrangement` is PRESENT whenever the drafter picked one,
            // including a pick of the default SW (see captureAreaEdits), so a
            // deliberate SW still disables the search.
            arrangement: area.edits?.arrangement,
            gateEdge: ed.gateEdge,
            latticeShift: ed.latticeShift,
            exclusionZones: ed.areaZones.filter(z => z.kind === 'exclusion'),
            constraints: {
              ...normalizedLayoutEdits,
              // Stale traced roads self-heal at render time (the stored
              // edits are never rewritten): saves committed under older
              // road-rules versions re-derive their traced roads from the
              // persisted reference drawing under the CURRENT commit rules;
              // saves from before verbatim road surfaces re-attach the drawn
              // outlines, and saves from before one-gate flags get the same
              // prune/flag pass the scan commit runs. All passes are no-ops
              // on current saves.
              ...(ed.layoutEdits.customRoads?.some(r => r.traced === true)
                ? {
                    customRoads: healTracedRoadConstraints(
                      ed.layoutEdits.customRoads,
                      area.id,
                      healingFence,
                      s.siteAreas,
                      s.drawing,
                      area.name,
                      {
                        designFence: healingFence,
                        fencePlacement: healingFencePlacement,
                        removedTraced: ed.layoutEdits.removedTracedRoads,
                        pavedTraced: ed.layoutEdits.pavedTracedRoads,
                      }),
                  }
                : {}),
              ...(healingRatings && editsNeedTracedRatings(ed.layoutEdits)
                ? { tracedRatings: healingRatings }
                : {}),
              substation: ed.substation,
            },
          }
        );
        return { ...area, design, error: undefined };
      } catch (e: any) {
        return {
          ...area,
          design: emptyAreaDesign(area.boundary, s.fencePlacement),
          error: e?.message || 'Layout failed for this area',
        };
      }
    });
    const active = next.find(a => a.id === activeAreaId);
    set({
      siteAreas: next,
      ...(active?.design ? { design: active.design, boundary: active.boundary } : {}),
    });
    // Laying out the areas produced fresh yards but no MV routes. Each BESS
    // area's feeders land on the substation take-off aimed at it, so they are
    // routed here — otherwise every area keeps the routes from the PREVIOUS
    // layout (or none at all), and compliance/permit exports describe
    // trenches that no longer exist.
    if (next.length >= 2 && !opts?.skipFeederRecompute) get().recomputeAllAreaFeeders();
  },

  setActiveArea: (id: string) => {
    const s = get();
    const target = s.siteAreas.find(a => a.id === id);
    if (!target || id === s.activeAreaId) return;
    // Commit what the drafter did to the CURRENT area before leaving it,
    // otherwise switching away silently discards those edits.
    const committed = commitActiveAreaEdits(s);
    const area = committed.find(a => a.id === id)!;
    set({
      siteAreas: committed,
      activeAreaId: id,
      boundary: area.boundary,
      ...(area.design ? { design: area.design } : {}),
      placingSubstation: false,
      // Placement mode is per-area: a take-off drag in progress must never
      // survive a switch to a different footprint.
      placingTakeoffId: null,
      // Feeder routes are derived output; recomputeFeeders rebuilds them for
      // the newly active area from its own assignments.
      feeders: [],
      // Every per-area input is restored from the area being switched TO
      // (defaults for one that has never been edited).
      ...areaEditsToState(area.edits),
    });
    // A previously laid-out area is restored as-is; only one that has never
    // been generated needs a layout pass.
    if (area.design) get().recomputeFeeders();
    else get().regenerate({ sync: true });
  },

  cancelBoundaryPicker: () => set({ boundaryPicker: null }),

  setConfigId: (id: string) => {
    if (id === get().configId) return;
    const cfg = getConfiguration(id);
    get().pushHistory(snapOf(get(), `Changed equipment configuration to ${cfg.label}`));
    // A configuration pick starts from its approved block composition. An
    // explicitly loaded legacy project retains its saved QTY4 value instead.
    set({
      configId: id,
      targetMW: cfg.refMW,
      targetMWh: cfg.refMWh,
      containersPerPcs: cfg.containersPerBlock,
    });
    get().regenerate();
  },

  setTargetMW: (mw: number) => {
    // Non-finite targets would poison block-count math (NaN block counts →
    // invalid geometry); ignore them outright.
    if (!Number.isFinite(mw) || mw === get().targetMW) return;
    get().pushHistory(snapOf(get(), `Set target power to ${mw} MW`, 'targetMW'));
    set({ targetMW: mw });
    get().regenerate();
  },

  setTargetMWh: (mwh: number) => {
    if (!Number.isFinite(mwh) || mwh === get().targetMWh) return;
    get().pushHistory(snapOf(get(), `Set target energy to ${mwh} MWh`, 'targetMWh'));
    set({ targetMWh: mwh });
    get().regenerate();
  },

  setHotClimate: (hot: boolean) => {
    if (hot === get().hotClimate) return;
    get().pushHistory(snapOf(get(), hot ? 'Enabled hot-climate clearances' : 'Disabled hot-climate clearances'));
    set({ hotClimate: hot });
    get().regenerate();
  },

  setContainersPerPcs: (n: number) => {
    if (n !== 3 && n !== 4) return;
    if (n === get().containersPerPcs) return;
    get().pushHistory(snapOf(get(), `Set BESS containers per PCS block to QTY ${n}`));
    set({ containersPerPcs: n });
    get().regenerate();
  },

  setRoadMode: (mode: RoadMode) => {
    if (mode === get().roadMode) return;
    const labels: Record<RoadMode, string> = { auto: 'automatic', roads: 'always include roads', compact: 'compact (no interior roads)' };
    get().pushHistory(snapOf(get(), `Set road mode to ${labels[mode]}`));
    set({ roadMode: mode });
    get().regenerate();
  },

  setAutoRoadWrap: (wrap: boolean) => {
    if (wrap === get().autoRoadWrap) return;
    get().pushHistory(snapOf(get(), wrap
      ? 'Auto-wrap roads around placed equipment'
      : 'Stop auto-wrapping roads around placed equipment'));
    set({ autoRoadWrap: wrap });
    get().regenerate();
  },

  setRingMode: (mode: RingMode) => {
    if (mode === get().ringMode) return;
    const labels: Record<RingMode, string> = { fence: 'full fence ring', shrink: 'shrink-wrap around equipment', hybrid: 'hybrid (hug far sides only)' };
    get().pushHistory(snapOf(get(), `Set perimeter ring to ${labels[mode]}`));
    set({ ringMode: mode });
    get().regenerate();
  },

  setPerimeterBand: (band: PerimeterBandMode) => {
    if (band === get().perimeterBand) return;
    const labels: Record<PerimeterBandMode, string> = { standard: 'standard (10 ft inset from fence)', flush: 'flush with fence line' };
    get().pushHistory(snapOf(get(), `Set perimeter road edge to ${labels[band]}`));
    set({ perimeterBand: band });
    get().regenerate();
  },

  setFencePlacement: (mode: FencePlacementMode) => {
    if (mode === get().fencePlacement) return;
    const labels: Record<FencePlacementMode, string> = {
      inset: `inset ${CLEARANCES.fenceToLotLine} ft from the property boundary`,
      'property-line': 'on the property boundary',
    };
    get().pushHistory(snapOf(get(), `Set fence placement to ${labels[mode]}`));
    set({ fencePlacement: mode });
    // Full rebuild: the fence is the envelope every placement, road, gate,
    // grounding and cable decision is made against, so nothing is salvaged
    // incrementally. regenerate()'s apply() re-validates the fence-dependent
    // stored state (grading zones) against the design it just produced, and
    // the engine reports any layout edit that no longer fits.
    get().regenerate();
  },

  setLaydownPct: (pct: number) => {
    const clamped = Math.min(50, Math.max(0, Number.isFinite(pct) ? pct : 0));
    if (clamped === get().laydownPct) return;
    get().pushHistory(snapOf(get(), `Set laydown area to ${clamped}% of yard`, 'laydownPct'));
    set({ laydownPct: clamped });
    get().regenerate();
  },

  setAugmentPct: (pct: number) => {
    const clamped = Math.min(100, Math.max(0, Number.isFinite(pct) ? pct : 0));
    if (clamped === get().augmentPct) return;
    get().pushHistory(snapOf(get(), `Set augmentation reserve to ${clamped}%`, 'augmentPct'));
    set({ augmentPct: clamped });
    get().regenerate();
  },

  setFuturePhaseUnits: (n: number) => {
    const clamped = Math.min(50, Math.max(0, Math.floor(Number.isFinite(n) ? n : 0)));
    if (clamped === get().futurePhaseUnits) return;
    get().pushHistory(snapOf(get(), `Set future phase to ${clamped} augmentation unit(s)`, 'futurePhaseUnits'));
    set({ futurePhaseUnits: clamped });
    get().regenerate();
  },

  setSurfacingMode: (mode: SurfacingMode) => {
    if (mode !== 'between-roads' && mode !== 'full-yard') return;
    if (mode === get().surfacingMode) return;
    get().pushHistory(snapOf(get(), mode === 'full-yard'
      ? 'Set rock surfacing to everything inside fence'
      : 'Set rock surfacing to between roads only'));
    set({ surfacingMode: mode });
    get().regenerate();
  },

  setDeadSpaceTrim: (on: boolean) => {
    if (typeof on !== 'boolean' || on === get().deadSpaceTrim) return;
    get().pushHistory(snapOf(get(), on
      ? 'Enable dead-space trim (fence hull + courtyard clip)'
      : 'Disable dead-space trim'));
    set({ deadSpaceTrim: on });
    get().regenerate();
  },

  setDcRouting: (mode: DcRoutingMode) => {
    if (mode !== 'orthogonal' && mode !== 'direct') return;
    if (mode === get().dcRouting) return;
    get().pushHistory(snapOf(get(), mode === 'direct'
      ? 'Set DC runs to direct straight-line routing'
      : 'Set DC runs to 90° trench routing'));
    set({ dcRouting: mode });
    get().regenerate();
  },

  setFeederRoutingMode: (mode: FeederRoutingMode) => {
    if (mode !== 'orthogonal' && mode !== 'angled') return;
    if (mode === get().feederRoutingMode) return;
    const before = snapOf(get(), mode === 'angled'
      ? 'Set MV feeder routing to angled corridor'
      : 'Set MV feeder routing to 90° corridor');
    set({ feederRoutingMode: mode });
    get().recomputeFeeders();
    get().pushHistory(before);
  },

  setFeederMode: (feederIdx: number, mode: FeederRoutingMode | null): boolean => {
    if (mode !== null && mode !== 'orthogonal' && mode !== 'angled') return false;
    const target = get().feeders.find(f => f.idx === feederIdx);
    if (!target) return false;
    const key = feederRouteKey(target.inverterIds);
    if (!key) return false;
    const prevEdits = get().layoutEdits;
    if ((prevEdits.feederModes?.[key] ?? null) === mode) return true;
    const before = snapOf(get(), mode === null
      ? `Set feeder F${feederIdx} routing back to the design default`
      : `Set feeder F${feederIdx} to ${mode === 'angled' ? 'angled corridor' : '90° corridor'} routing`);
    const feederModes = { ...(prevEdits.feederModes ?? {}) };
    if (mode === null) delete feederModes[key];
    else feederModes[key] = mode;
    const next = { ...prevEdits };
    if (Object.keys(feederModes).length) next.feederModes = feederModes;
    else delete next.feederModes;
    set({ layoutEdits: next });
    get().recomputeFeeders();
    get().pushHistory(before);
    return true;
  },

  applyFeederRoutingCandidate: (params: FeederRoutingParams): boolean => {
    if (!params || (params.defaultMode !== 'orthogonal' && params.defaultMode !== 'angled')) return false;
    const { design, substation } = get();
    if (!design || !substation) return false;
    const c = Number.isFinite(params.corridorPin as number) ? params.corridorPin! : null;
    if (params.corridorPin != null && c === null) return false;
    if (c !== null && feederCorridorRejectReason(design, substation, c, get().maxPcsPerFeeder) !== null) return false;
    // Re-sanitize exactly as the session loader does, so an optimizer result
    // can never write an edit shape that a reload would then drop.
    const modes: Record<string, FeederRoutingMode> = {};
    for (const [k, m] of Object.entries(params.modes ?? {})) {
      if (/^inv-\d+$/.test(k) && (m === 'orthogonal' || m === 'angled')) modes[k] = m;
    }
    const prevEdits = get().layoutEdits;
    const prevModes = prevEdits.feederModes ?? {};
    const modesSame = Object.keys(modes).length === Object.keys(prevModes).length &&
      Object.entries(modes).every(([k, m]) => prevModes[k] === m);
    if (modesSame && (prevEdits.feederCorridor ?? null) === c &&
        get().feederRoutingMode === params.defaultMode) return true;
    const nOver = Object.keys(modes).length;
    const before = snapOf(get(),
      `Applied optimized feeder routing (${params.defaultMode === 'angled' ? 'angled' : '90°'} default` +
      `${nOver ? `, ${nOver} per-feeder override${nOver > 1 ? 's' : ''}` : ''}` +
      `${c === null ? '' : `, corridor pinned at ${Math.round(c)} ft`})`);
    const edits = { ...prevEdits };
    if (nOver) edits.feederModes = modes;
    else delete edits.feederModes;
    if (c === null) delete edits.feederCorridor;
    else edits.feederCorridor = c;
    set({ feederRoutingMode: params.defaultMode, layoutEdits: edits });
    get().recomputeFeeders();
    get().pushHistory(before);
    return true;
  },

  requestFeederDraw: (idx: number | null) => set({ feederDrawRequest: idx }),
  requestAuxFeederDraw: () => set({ auxFeederDrawRequest: true }),
  setLayoutEditActive: (on: boolean) => set({ layoutEditActive: on }),

  setBlockDcRouting: (blockN: number, mode: DcRoutingMode | null) => {
    if (!Number.isInteger(blockN) || blockN < 1) return;
    if (mode !== null && mode !== 'orthogonal' && mode !== 'direct') return;
    const prevEdits = get().layoutEdits;
    const cur = prevEdits.dcRoutingOverrides?.[blockN] ?? null;
    if (cur === mode) return;
    const before = snapOf(get(), mode === null
      ? `Set block ${blockN} DC routing back to the design default`
      : `Set block ${blockN} DC runs to ${mode === 'direct' ? 'direct straight-line' : '90° trench'} routing`);
    const dcRoutingOverrides = { ...(prevEdits.dcRoutingOverrides ?? {}) };
    if (mode === null) delete dcRoutingOverrides[blockN];
    else dcRoutingOverrides[blockN] = mode;
    const nextEdits: LayoutConstraints = { ...prevEdits };
    if (Object.keys(dcRoutingOverrides).length) nextEdits.dcRoutingOverrides = dcRoutingOverrides;
    else delete nextEdits.dcRoutingOverrides;
    set({ layoutEdits: nextEdits });
    get().regenerate();
    get().pushHistory(before);
  },

  setAlignIslands: (on: boolean) => {
    const prevEdits = get().layoutEdits;
    const cur = prevEdits.alignIslands === true;
    if (on === cur) return;
    get().pushHistory(snapOf(get(), on
      ? 'Enable island column alignment (may remove augmentation zones)'
      : 'Disable island column alignment'));
    const nextEdits: LayoutConstraints = { ...prevEdits };
    if (on) nextEdits.alignIslands = true;
    else delete nextEdits.alignIslands;
    set({ layoutEdits: nextEdits });
    get().regenerate();
  },

  setSurfacingDepthIn: (depth: number) => {
    const clamped = Math.min(24, Math.max(1, Number.isFinite(depth) ? depth : SURFACING_DEPTH_IN_DEFAULT));
    if (clamped === get().surfacingDepthIn) return;
    get().pushHistory(snapOf(get(), `Set rock surfacing depth to ${clamped}"`, 'surfacingDepthIn'));
    set({ surfacingDepthIn: clamped });
    get().regenerate();
  },

  setTextureSetId: (id: YardTextureSetId) => {
    if (id === get().textureSetId) return;
    get().pushHistory(snapOf(get(), `Set yard textures to ${getYardTextureSet(id).label}`, 'textureSetId'));
    set({ textureSetId: id });
    // Visual-only setting: no regenerate needed — the scene re-reads the
    // active set from the store and swaps materials immediately.
  },

  setGePcsColor: (hex: string | null) => {
    const next = hex === null ? null : sanitizePcsColor(hex);
    if (next === get().gePcsColor) return;
    get().pushHistory(snapOf(get(), next ? 'Set GE PCS color' : 'Reset GE PCS color to factory', 'gePcsColor'));
    set({ gePcsColor: next });
    // Visual-only setting: no regenerate needed — the scene re-reads the
    // color from the store and swaps the recolored texture immediately.
  },

  setArrangement: (s: ArrangementStrategy) => {
    get().pushHistory(snapOf(get(), `Applied arrangement ${s.toUpperCase()} as new baseline`));
    set({
      arrangement: s,
      // A picked arrangement is a deliberate engineering input, including
      // when the pick happens to be the default SW.
      arrangementExplicit: true,
      latticeShift: null,
      gateEdge: null,
      layoutEdits: {},
    });
    get().regenerate();
  },

  applyOptimizedLayout: (params: OptimizeParams) => {
    // Optimizer candidates are computed values — a non-finite lattice shift
    // or trench pin must fall back to automatic, never reach the layout math.
    const lattice = finitePt(params.latticeShift) ? params.latticeShift : null;
    const trenchX = typeof params.trenchX === 'number' && Number.isFinite(params.trenchX)
      ? params.trenchX
      : null;
    get().pushHistory(snapOf(get(), `Applied optimized layout (arrangement ${params.arrangement.toUpperCase()})`));
    set({
      arrangement: params.arrangement,
      // Applying an optimizer candidate fixes the arrangement as the new
      // deliberate baseline, exactly like picking one by hand.
      arrangementExplicit: true,
      latticeShift: lattice,
      gateEdge: params.gateEdge,
      layoutEdits: trenchX !== null ? { trenchX } : {},
    });
    // Sync so callers can check `error` right after applying a candidate.
    get().regenerate({ sync: true });
  },

  setYardRotation: (deg: number) => {
    const next = sanitizeYardRotation(deg);
    if (next === get().yardRotationDeg) return;
    get().pushHistory(snapOf(get(), next === 0
      ? 'Reset yard rotation to 0°'
      : `Applied grading-optimized yard rotation (${next}°)`));
    set({ yardRotationDeg: next });
    // Sync so callers (the grading Apply button) can check `error` at once.
    get().regenerate({ sync: true });
  },

  requestInspectTrench: () => {
    set(s => ({ inspectTrenchRequest: s.inspectTrenchRequest + 1 }));
  },

  markInspectTrenchHandled: (n: number) => {
    set(s => (n > s.inspectTrenchHandled ? { inspectTrenchHandled: n } : {}));
  },

  requestOverview: () => {
    set(s => ({ overviewRequest: s.overviewRequest + 1 }));
  },

  requestCameraPose: (pos: [number, number, number], target: [number, number, number]) => {
    // Guard: a non-finite pose (NaN/Infinity — e.g. computed from a missing
    // equipment entry) poisons the camera's view matrix, which makes
    // WebGLClipping project the ground clipping planes to NaN and three.js's
    // uniform flatten() then throws "firstElem.toArray is not a function"
    // EVERY frame — a blank canvas with no recovery. Reject it loudly here.
    if (![...pos, ...target].every(Number.isFinite)) {
      console.warn('requestCameraPose ignored: non-finite pose', { pos, target });
      return;
    }
    set(s => ({ cameraPoseRequest: { pos, target, n: (s.cameraPoseRequest?.n ?? 0) + 1 } }));
  },

  markCameraPoseHandled: (n: number) => {
    set(s => (n > s.cameraPoseHandled ? { cameraPoseHandled: n } : {}));
  },

  requestOrthoCameraPose: (target, zoom) => {
    if (![...target, zoom].every(Number.isFinite) || zoom <= 0) return;
    set(s => ({ orthoCameraPoseRequest: { target, zoom, n: (s.orthoCameraPoseRequest?.n ?? 0) + 1 } }));
  },

  markOrthoCameraPoseHandled: (n) => {
    set(s => (n > s.orthoCameraPoseHandled ? { orthoCameraPoseHandled: n } : {}));
  },

  markOverviewHandled: (n: number) => {
    set(s => (n > s.overviewHandled ? { overviewHandled: n } : {}));
  },

  setWalkMode: (on: boolean) => {
    set({ walkMode: on });
  },

  startCinematicTour: (record: boolean) => {
    // Tour and walkthrough both drive the camera imperatively — never both.
    set({ tourActive: true, tourRecord: record, walkMode: false, tourPhase: 'path', tourGrounding: false, tourDcSwap: 0, tourFade: 0, tourCaption: null, tourStatAlpha: 0, tourStatCard: null, tourGhostAlpha: 0, tourGhosts: null, tourIntroT: 0, tourIntroInfo: null });
  },

  stopCinematicTour: () => {
    // Always clears the transient overlays too (forced grounding flyover,
    // live DC reroute beat, fade transition).
    set({ tourActive: false, tourRecord: false, tourSeek: null, tourPhase: null, tourGrounding: false, tourDcSwap: 0, tourFade: 0, tourCaption: null, tourStatAlpha: 0, tourStatCard: null, tourGhostAlpha: 0, tourGhosts: null, tourIntroT: 0, tourIntroInfo: null, tourCadLayers: null });
  },

  // Camera path finished: hand off to the scripted showcase segment.
  finishTourPath: () => {
    set(s => (s.tourActive ? { tourPhase: 'showcase' } : {}));
  },

  // Dev/test hook: jump straight into the showcase segment.
  startTourShowcase: () => {
    set({ tourActive: true, tourRecord: false, walkMode: false, tourPhase: 'showcase', tourGrounding: false });
  },

  // Final-flyover grounding overlay (presentation-only, never persisted).
  setTourGrounding: (on: boolean) => {
    set(s => (s.tourGrounding === on ? {} : { tourGrounding: on }));
  },

  // Live DC reroute beat progress (presentation-only; see state comment).
  setTourDcSwap: (p: number) => {
    const clamped = Math.min(1, Math.max(0, p));
    set(s => (s.tourDcSwap === clamped ? {} : { tourDcSwap: clamped }));
  },

  // White fade-up overlay opacity (0..1) between the reroute beat and the
  // resumed drive-through.
  setTourFade: (f: number) => {
    const clamped = Math.min(1, Math.max(0, f));
    set(s => (s.tourFade === clamped ? {} : { tourFade: clamped }));
  },

  // Reroute-beat caption text (drawn on the recorder-captured overlay).
  setTourCaption: (c: string | null) => {
    set(s => (s.tourCaption === c ? {} : { tourCaption: c }));
  },

  // Fly-along stat-card fade (0..1) and content (presentation-only).
  setTourStatAlpha: (a: number) => {
    const clamped = Math.min(1, Math.max(0, a));
    set(s => (s.tourStatAlpha === clamped ? {} : { tourStatAlpha: clamped }));
  },
  setTourStatCard: (c) => {
    set(s => (s.tourStatCard === c ? {} : { tourStatCard: c }));
  },

  // Fly-along future-PCS ghost fade (0..1) and boxes (presentation-only).
  setTourGhostAlpha: (a: number) => {
    const clamped = Math.min(1, Math.max(0, a));
    set(s => (s.tourGhostAlpha === clamped ? {} : { tourGhostAlpha: clamped }));
  },
  setTourGhosts: (g) => {
    set(s => (s.tourGhosts === g ? {} : { tourGhosts: g }));
  },

  // Title-intro progress (0..1) and content (presentation-only).
  setTourIntroT: (p: number) => {
    const clamped = Math.min(1, Math.max(0, p));
    set(s => (s.tourIntroT === clamped ? {} : { tourIntroT: clamped }));
  },
  setTourIntroInfo: (i) => {
    set(s => (s.tourIntroInfo === i ? {} : { tourIntroInfo: i }));
  },

  // Test hook: compress the showcase timeline (>1 = faster).
  setTourShowcaseSpeed: (speed: number) => {
    set({ tourShowcaseSpeed: Math.max(0.1, speed) });
  },

  // Test hook (visual regression): freeze the tour at a fixed progress.
  setTourSeek: (t: number | null) => {
    set({ tourSeek: t });
  },

  // Merge marketer-chosen tour options (duration preset + stop toggles).
  setTourOptions: (opts: Partial<TourOptions>) => {
    set(s => ({ tourOptions: { ...s.tourOptions, ...opts } }));
  },

  requestMarketingStills: () => {
    set(s => ({ marketingStillsRequest: s.marketingStillsRequest + 1 }));
  },

  requestOfflineRender: (opts?: { fps?: number; maxSeconds?: number }) => {
    // Never start an offline render on top of a playing tour — the renderer
    // owns tourSeek and the tour lifecycle for the whole stepped run.
    if (get().tourActive || get().offlineRenderActive) return;
    set(s => ({ offlineRenderRequest: s.offlineRenderRequest + 1, offlineRenderOpts: opts ?? null }));
  },

  setOfflineRenderActive: (active: boolean) => set({ offlineRenderActive: active }),

  captureDrawing: (kmlText: string, sourceName: string, origin: { lat: number; lon: number }) => {
    ++drawingEpoch;
    try {
      const drawing = parseKmlDrawing(kmlText, sourceName, origin);
      if (!drawing.featureCount) {
        set({ drawing: null, drawingLayerVis: {} });
        void saveDrawing(null);
        return;
      }
      set({ drawing, drawingLayerVis: defaultDrawingLayerVis(drawing), showDrawing: true });
      void saveDrawing(drawing);
    } catch {
      // Reference linework is a display aid: a malformed drawing must never
      // block an import whose boundary already parsed successfully.
      set({ drawing: null, drawingLayerVis: {} });
    }
  },

  setShowDrawing: (show: boolean) => set({ showDrawing: show }),

  setDrawingLayerVisible: (layer: string, visible: boolean) =>
    set(s => ({ drawingLayerVis: { ...s.drawingLayerVis, [layer]: visible } })),

  setAllDrawingLayers: (visible: boolean) =>
    set(s => ({
      drawingLayerVis: Object.fromEntries((s.drawing?.layers ?? []).map(l => [l.name, visible])),
    })),

  setShowLabels: (show: boolean) => {
    set({ showLabels: show });
    try {
      localStorage.setItem('nextera-show-labels', String(show));
    } catch {
      // storage unavailable; preference just won't persist
    }
  },

  setRealisticModels: (on: boolean) => {
    set({ realisticModels: on });
    try {
      localStorage.setItem('nextera-realistic-models', String(on));
    } catch {
      // storage unavailable; preference just won't persist
    }
  },

  setShowGateModel: (on: boolean) => {
    set({ showGateModel: on });
    try {
      localStorage.setItem('nextera-show-gate-model', String(on));
    } catch {
      // storage unavailable; preference just won't persist
    }
  },

  setShowFence3D: (on: boolean) => {
    set({ showFence3D: on });
    try {
      localStorage.setItem('nextera-show-fence-3d', String(on));
    } catch {
      // storage unavailable; preference just won't persist
    }
  },

  setShowFeederColors: (on: boolean) => {
    set({ showFeederColors: on });
    try {
      localStorage.setItem('nextera-feeder-colors', String(on));
    } catch {
      // storage unavailable; preference just won't persist
    }
  },

  setEciLegend: (on: boolean) => {
    if (on === get().eciLegend) return;
    // Undoable: the legend style changes exported drawing content (DXF/PDF/
    // CAD glyphs), so it reverts with undo like gePcsColor/textureSetId.
    get().pushHistory(snapOf(get(), on ? 'Enabled ECI legend symbols' : 'Disabled ECI legend symbols'));
    set({ eciLegend: on });
    // Display/export setting: no regenerate needed — CAD view and exporters
    // read the flag from the store directly.
  },

  setShowFeederNfpaText: (on: boolean) => {
    if (on === get().showFeederNfpaText) return;
    // Undoable like setEciLegend: the toggle changes exported drawing
    // content (CAD/DXF/PDF plan annotations), never geometry or calcs.
    get().pushHistory(snapOf(get(), on ? 'Showed feeder & NFPA text' : 'Hid feeder & NFPA text'));
    set({ showFeederNfpaText: on });
  },
  setDrawingVisibility: (patch: Partial<DrawingVisibilityProfile>) => {
    const current = get().drawingVisibility;
    const next = sanitizeDrawingVisibilityProfile({ ...current, ...patch });
    if (drawingVisibilityEquals(current, next)) return;
    get().pushHistory(snapOf(get(), 'Change drawing visibility'));
    set({ drawingVisibility: next });
  },
  resetDrawingVisibility: () => {
    const current = get().drawingVisibility;
    const next = { ...DEFAULT_DRAWING_VISIBILITY };
    if (drawingVisibilityEquals(current, next)) return;
    get().pushHistory(snapOf(get(), 'Reset drawing visibility'));
    set({ drawingVisibility: next });
  },

  setTourCadLayers: (layers) => {
    set(s => (
      s.tourCadLayers?.labels === layers?.labels &&
      s.tourCadLayers?.dims === layers?.dims &&
      s.tourCadLayers?.cables === layers?.cables &&
      s.tourCadLayers?.feederNotes === layers?.feederNotes
    ) ? {} : { tourCadLayers: layers });
  },

  toggleFeederHidden: (idx: number) => {
    const next = new Set(get().hiddenFeeders);
    if (next.has(idx)) next.delete(idx);
    else next.add(idx);
    set({ hiddenFeeders: next });
  },

  setAllFeedersHidden: (hidden: boolean) => {
    set({ hiddenFeeders: hidden ? new Set(get().feeders.map(f => f.idx)) : new Set<number>() });
  },

  setShowSatellite: (on: boolean) => {
    set({ showSatellite: on });
    try {
      localStorage.setItem('nextera-show-satellite', String(on));
    } catch {
      // storage unavailable; preference just won't persist
    }
    // Lazily fetch on first enable.
    if (on && !get().satellite && get().satelliteStatus !== 'loading') void get().loadSatellite();
  },

  loadSatellite: async () => {
    const boundary = get().boundary;
    if (!boundary) return null;
    const cached = get().satellite;
    if (cached) return cached;
    // Dedupe concurrent callers (e.g. toggle-on + PDF export): share one fetch.
    const epoch = satelliteEpoch;
    if (satelliteInFlight && satelliteInFlight.epoch === epoch) {
      return satelliteInFlight.promise;
    }
    // Whole-site coverage: on a multi-area import every footprint shares one
    // projection origin, so imagery must span every area's polygon. Using the
    // active area alone leaves the other areas on bare ground.
    const areas = get().siteAreas;
    const polygons = areas.length >= 2
      ? areas.map(a => a.boundary.polygon)
      : [boundary.polygon];
    set({ satelliteStatus: 'loading', satelliteError: null });
    const promise = (async (): Promise<SatelliteImage | null> => {
      try {
        const img = await fetchSatelliteImage(
          boundary.origin.lat,
          boundary.origin.lon,
          satelliteCoverageBboxFor(polygons, boundary.origin)
        );
        // Only a genuine site change invalidates this result. Never compare
        // boundary identity: regeneration re-seats that object routinely and
        // would strand the status on 'loading'.
        if (satelliteEpoch !== epoch) return null;
        set({ satellite: img, satelliteStatus: 'idle', satelliteError: null });
        return img;
      } catch (e: any) {
        // Never let a stale failure clobber a cached success for this site,
        // but ALWAYS leave a definite status — never 'loading'.
        if (satelliteEpoch === epoch && !get().satellite) {
          set({ satelliteStatus: 'error', satelliteError: e?.message ?? 'satellite imagery fetch failed' });
        }
        return null;
      } finally {
        if (satelliteInFlight?.epoch === epoch) satelliteInFlight = null;
      }
    })();
    satelliteInFlight = { epoch, promise };
    return promise;
  },

  setShowTerrain: (on: boolean) => {
    set({ showTerrain: on });
    try {
      localStorage.setItem('nextera-show-terrain', String(on));
    } catch {
      // storage unavailable; preference just won't persist
    }
    // Lazily fetch on first enable (e.g. the user opted out earlier).
    if (on && !get().terrain && get().terrainStatus !== 'loading') void get().loadTerrain();
  },

  setShowSlopeHeatmap: (on: boolean) => set({ showSlopeHeatmap: on }),

  setShowContours: (on: boolean) => {
    set({ showContours: on });
    try {
      localStorage.setItem('nextera-show-contours', String(on));
    } catch {
      // storage unavailable; preference just won't persist
    }
  },

  setShowGradingLimits: (on: boolean) => {
    set({ showGradingLimits: on });
    try {
      localStorage.setItem('nextera-show-grading-limits', String(on));
    } catch {
      // storage unavailable; preference just won't persist
    }
  },

  setLabelDistanceScaling: (on: boolean) => {
    set({ labelDistanceScaling: on });
    try {
      localStorage.setItem('nextera-label-distance-scaling', String(on));
    } catch {
      // storage unavailable; preference just won't persist
    }
  },

  setShowProposedContours: (on: boolean) => {
    set({ showProposedContours: on });
    try {
      localStorage.setItem('nextera-show-proposed-contours', String(on));
    } catch {
      // storage unavailable; preference just won't persist
    }
  },

  setShowCutFillPreview: (on: boolean) => {
    set({ showCutFillPreview: on });
    try {
      localStorage.setItem('nextera-show-cutfill-preview', String(on));
    } catch {
      // storage unavailable; preference just won't persist
    }
  },

  setGradingSlopeRatio: (ratio: number) => {
    if (![2, 3, 4].includes(ratio)) return;
    set({ gradingSlopeRatio: ratio });
    try {
      localStorage.setItem('nextera-grading-slope-ratio', String(ratio));
    } catch {
      // storage unavailable; preference just won't persist
    }
  },

  setExportContoursDxf: (on: boolean) => {
    set({ exportContoursDxf: on });
    try {
      localStorage.setItem('nextera-export-contours-dxf', String(on));
    } catch {
      // storage unavailable; preference just won't persist
    }
    // The DXF contours come from the elevation grid — fetch it lazily if the
    // drafter enables export before ever turning the terrain preview on.
    if (on && !get().terrain && get().terrainStatus !== 'loading') void get().loadTerrain();
  },

  setExportCutFillShading: (on: boolean) => {
    set({ exportCutFillShading: on });
    try {
      localStorage.setItem('nextera-export-cutfill-shading', String(on));
    } catch {
      // storage unavailable; preference just won't persist
    }
  },

  setShowGrounding: (on: boolean) => {
    set({ showGrounding: on });
    try {
      localStorage.setItem('nextera-show-grounding', String(on));
    } catch {
      // storage unavailable; preference just won't persist
    }
  },

  setGroundingXray: (on: boolean) => {
    set({ groundingXray: on });
    try {
      localStorage.setItem('nextera-grounding-xray', String(on));
    } catch {
      // storage unavailable; preference just won't persist
    }
  },

  setGroundingRodSpacingFt: (ft: number) => {
    if (![25, 50, 100].includes(ft)) return;
    set({ groundingRodSpacingFt: ft });
    try {
      localStorage.setItem('nextera-grounding-rod-spacing-ft', String(ft));
    } catch {
      // storage unavailable; preference just won't persist
    }
  },

  setExportGroundingDxf: (on: boolean) => {
    set({ exportGroundingDxf: on });
    try {
      localStorage.setItem('nextera-export-grounding-dxf', String(on));
    } catch {
      // storage unavailable; preference just won't persist
    }
  },

  setExportTrenchSectionsDxf: (on: boolean) => {
    set({ exportTrenchSectionsDxf: on });
    try {
      localStorage.setItem('nextera-export-trench-sections-dxf', String(on));
    } catch {
      // storage unavailable; preference just won't persist
    }
  },

  setExportSurfacingMesh: (on: boolean) => {
    set({ exportSurfacingMesh: on });
    try {
      localStorage.setItem('nextera-export-surfacing-mesh', String(on));
    } catch {
      // storage unavailable; preference just won't persist
    }
  },

  setCoverCaptureReady: (ready: boolean) => set({ coverCaptureReady: ready }),
  acquireForceRealisticNear: () => set(s => ({ forceRealisticNearCount: s.forceRealisticNearCount + 1 })),
  releaseForceRealisticNear: () => set(s => ({ forceRealisticNearCount: Math.max(0, s.forceRealisticNearCount - 1) })),
  setRealisticDetailApplied: (v: boolean) => set({ realisticDetailApplied: v }),

  requestCoverCapture: (localRect, hiRes, hideLabels) => {
    const n = (get().coverCaptureRequest?.n ?? 0) + 1;
    set({
      coverCaptureRequest: {
        localRect, n,
        ...(hiRes ? { hiRes: true } : {}),
        ...(hideLabels && (hideLabels.topDown || hideLabels.hero) ? { hideLabels } : {}),
      },
      coverCaptureResult: null,
    });
    return n;
  },

  postCoverCaptureResult: (result) => {
    set(s => (s.coverCaptureRequest?.n === result.n
      ? { coverCaptureRequest: null, coverCaptureResult: result }
      : {}));
  },

  setIeee80Enabled: (on: boolean) => {
    set({ ieee80Enabled: on });
    try {
      localStorage.setItem('nextera-ieee80-enabled', String(on));
    } catch {
      // storage unavailable; preference just won't persist
    }
  },

  setIeee80Inputs: (patch: Partial<Ieee80Inputs>) => {
    // Route the merged object through the sanitizer so out-of-range typed
    // values snap back to defaults instead of poisoning the study math.
    const next = sanitizeIeee80Inputs({ ...get().ieee80Inputs, ...patch });
    set({ ieee80Inputs: next });
    try {
      localStorage.setItem('nextera-ieee80-inputs', JSON.stringify(next));
    } catch {
      // storage unavailable; preference just won't persist
    }
  },

  setScEnabled: (on: boolean) => {
    set({ scEnabled: on });
    try {
      localStorage.setItem('nextera-sc-enabled', String(on));
    } catch {
      // storage unavailable; preference just won't persist
    }
  },

  setScInputs: (patch: Partial<ShortCircuitInputs>) => {
    // Merged object routed through the sanitizer so out-of-range typed
    // values snap back to defaults instead of poisoning the study math.
    const next = sanitizeScInputs({ ...get().scInputs, ...patch });
    set({ scInputs: next });
    try {
      localStorage.setItem('nextera-sc-inputs', JSON.stringify(next));
    } catch {
      // storage unavailable; preference just won't persist
    }
  },

  setProtectionEnabled: (on: boolean) => {
    set({ protectionEnabled: on });
    try {
      localStorage.setItem('nextera-protection-enabled', String(on));
    } catch {
      // storage unavailable; preference just won't persist
    }
  },

  setProtectionInputs: (patch: Partial<ProtectionInputs>) => {
    const next = sanitizeProtectionInputs({ ...get().protectionInputs, ...patch });
    set({ protectionInputs: next });
    try {
      localStorage.setItem('nextera-protection-inputs', JSON.stringify(next));
    } catch {
      // storage unavailable; preference just won't persist
    }
  },

  setEnergySimEnabled: (on: boolean) => {
    // Project data, not a browser pref — no localStorage. Turning the study
    // off drops the opt-in project-file key (byte-identity guarantee).
    set({ energySimEnabled: on });
  },

  setEnergySimInputs: (patch: Partial<EnergySimInputs>) => {
    // Merged object routed through the sanitizer so out-of-range typed
    // values snap back into range instead of poisoning the study math.
    set({ energySimInputs: sanitizeEnergySimInputs({ ...get().energySimInputs, ...patch }) });
  },

  setGradingEnabled: (on: boolean) => {
    set({ gradingEnabled: on });
    try {
      localStorage.setItem('nextera-grading-enabled', String(on));
    } catch {
      // storage unavailable; preference just won't persist
    }
  },

  setGradingInputs: (patch: Partial<GradingInputs>) => {
    // Merged object routed through the sanitizer so out-of-range typed
    // values snap back to defaults instead of poisoning the surface math.
    const next = sanitizeGradingInputs({ ...get().gradingInputs, ...patch });
    set({ gradingInputs: next });
    try {
      localStorage.setItem('nextera-grading-inputs', JSON.stringify(next));
    } catch {
      // storage unavailable; preference just won't persist
    }
  },

  setGradingZones: (zones: GradingZone[]): string | null => {
    // Reject→warn→keep: a candidate set that fails validation (outside the
    // fence, overlapping, too many) is rejected with the reason and the
    // previous zones stay in effect — mirrors the layout-edit pattern.
    const clean = sanitizeGradingZones(zones);
    if (clean.length !== zones.length) {
      return 'Grading zones rejected — a zone has invalid or out-of-range values.';
    }
    const fence = get().design?.fence ?? [];
    const reason = gradingZonesRejectReason(clean, fence);
    if (reason) return `Grading zones rejected — ${reason}.`;
    set({ gradingZones: clean });
    return null;
  },

  setAreaZones: (zones: AreaZone[]): string | null => {
    // Reject→keep: a candidate set that fails validation (outside the
    // parcel, overlapping, too many, malformed) is rejected loudly with the
    // reason and the previous zones stay in effect.
    const clean = sanitizeAreaZones(zones);
    if (clean.length !== zones.length) {
      return 'Area zones rejected — a zone has invalid or out-of-range values.';
    }
    const parcel = get().design?.boundary.polygon ?? get().boundary?.polygon ?? [];
    const reason = areaZonesRejectReason(clean, parcel);
    if (reason) return `Area zones rejected — ${reason}.`;
    get().pushHistory(snapOf(get(), 'Edited area zones'));
    set({ areaZones: clean });
    return null;
  },

  setEarthworkRates: (patch: Partial<EarthworkRates>) => {
    // Merged object routed through the sanitizer so out-of-range typed
    // values snap back to defaults instead of poisoning the cost math.
    const next = sanitizeEarthworkRates({ ...get().earthworkRates, ...patch });
    set({ earthworkRates: next });
    try {
      localStorage.setItem('nextera-earthwork-rates', JSON.stringify(next));
    } catch {
      // storage unavailable; preference just won't persist
    }
  },

  setExportCostEstimate: (on: boolean) => {
    set({ exportCostEstimate: on });
    try {
      localStorage.setItem('nextera-export-cost-estimate', String(on));
    } catch {
      // storage unavailable; preference just won't persist
    }
  },

  setExportSections: (on: boolean) => {
    set({ exportSections: on });
    try {
      localStorage.setItem('nextera-export-sections', String(on));
    } catch {
      // storage unavailable; preference just won't persist
    }
  },

  setDrainageEnabled: (on: boolean) => {
    set({ drainageEnabled: on });
    try {
      localStorage.setItem('nextera-drainage-enabled', String(on));
    } catch {
      // storage unavailable; preference just won't persist
    }
  },

  setDrainageInputs: (patch: Partial<DrainageInputs>) => {
    const next = sanitizeDrainageInputs({ ...get().drainageInputs, ...patch });
    set({ drainageInputs: next });
    try {
      localStorage.setItem('nextera-drainage-inputs', JSON.stringify(next));
    } catch {
      // storage unavailable; preference just won't persist
    }
  },

  setDrainageIdf: (idf: Atlas14Idf | null) => {
    const clean = idf ? sanitizeAtlas14Idf(idf) : null;
    set({ drainageIdf: clean });
    try {
      if (clean) localStorage.setItem('nextera-drainage-idf', JSON.stringify(clean));
      else localStorage.removeItem('nextera-drainage-idf');
    } catch {
      // storage unavailable; preference just won't persist
    }
  },

  setContourIntervalFt: (ft: number) => {
    if (!Number.isFinite(ft) || ft < 0) return;
    set({ contourIntervalFt: ft });
    try {
      localStorage.setItem('nextera-contour-interval-ft', String(ft));
    } catch {
      // storage unavailable; preference just won't persist
    }
  },

  setMaxGradePct: (pct: number) => {
    const v = Math.min(Math.max(pct, 1), 50);
    if (!Number.isFinite(v)) return;
    set({ maxGradePct: v });
    try {
      localStorage.setItem('nextera-max-grade-pct', String(v));
    } catch {
      // storage unavailable; preference just won't persist
    }
  },

  setMaxVdPct: (pct: number) => {
    if (!Number.isFinite(pct)) return;
    const v = Math.min(Math.max(pct, 0.5), 10);
    set({ maxVdPct: v });
    try {
      localStorage.setItem('nextera-max-vd-pct', String(v));
    } catch {
      // storage unavailable; preference just won't persist
    }
  },

  setCapacityFactorPct: (pct: number) => {
    if (!Number.isFinite(pct)) return;
    const v = Math.min(Math.max(pct, 5), 100);
    set({ capacityFactorPct: v });
    try {
      localStorage.setItem('nextera-capacity-factor-pct', String(v));
    } catch {
      // storage unavailable; preference just won't persist
    }
  },

  loadTerrain: async () => {
    const boundary = get().boundary;
    if (!boundary) return null;
    const cached = get().terrain;
    if (cached) return cached;
    if (terrainInFlight && terrainInFlight.boundary === boundary) {
      return terrainInFlight.promise;
    }
    set({ terrainStatus: 'loading', terrainError: null });
    const promise = (async (): Promise<ElevationGrid | null> => {
      try {
        const raw = await fetchElevationGrid(
          terrainCoverageBbox(boundary.polygon, boundary.origin)
        );
        // No-data cells are filled for rendering/analysis; the original
        // noDataCount is preserved for the disclosure UI.
        const grid = fillNoData(raw);
        // A different site may have loaded while the fetch was in flight.
        if (get().boundary !== boundary) return null;
        set({ terrain: grid, terrainStatus: 'idle', terrainError: null });
        return grid;
      } catch (e: any) {
        // Never let a stale failure clobber a cached success for this site.
        if (get().boundary === boundary && !get().terrain) {
          set({ terrainStatus: 'error', terrainError: e?.message ?? 'elevation fetch failed' });
        }
        return null;
      } finally {
        if (terrainInFlight?.boundary === boundary) terrainInFlight = null;
      }
    })();
    terrainInFlight = { boundary, promise };
    return promise;
  },

  setTitleBlock: (patch: Partial<TitleBlockInfo>) => {
    const cur = get().titleBlock;
    if (Object.entries(patch).every(([k, v]) => (cur as any)[k] === v)) return;
    get().pushHistory(snapOf(get(), 'Edited title block', 'titleBlock'));
    set({ titleBlock: { ...cur, ...patch } });
  },

  setLgiaInputs: (patch: Partial<LgiaInputs>) => {
    // Merged object routed through the sanitizer so out-of-range typed
    // values snap back to "missing" (placeholder) instead of poisoning the
    // sheet. Project data — persisted by the autosave subscriber, not here.
    const next = sanitizeLgiaInputs({ ...get().lgiaInputs, ...patch });
    const cur = get().lgiaInputs;
    if ((Object.keys(next) as (keyof LgiaInputs)[]).every(k => next[k] === cur[k])) return;
    set({ lgiaInputs: next });
  },

  setHighlightIds: (ids: string[]) => set({ highlightIds: ids }),

  clearFeederResetNotice: () => {
    if (get().feederResetNotice !== null) set({ feederResetNotice: null });
  },

  clearGradingZonesResetNotice: () => {
    if (get().gradingZonesResetNotice !== null) set({ gradingZonesResetNotice: null });
  },

  regenerate: (opts?: { sync?: boolean; suppressAssignmentNotice?: boolean }) => {
    const { boundary: rawBoundary, configId, targetMW, targetMWh, hotClimate, containersPerPcs, roadMode, autoRoadWrap, ringMode, perimeterBand, fencePlacement, laydownPct, augmentPct, surfacingMode, surfacingDepthIn, deadSpaceTrim, dcRouting, arrangement, layoutEdits, yardRotationDeg } = get();
    if (!rawBoundary) return;
    // Grading-optimized rotation: the engine always works in the yard frame
    // (parcel spun by −θ). θ = 0 returns the exact same boundary object, so
    // the default path is byte-identical to the pre-feature behavior.
    const boundary = boundaryForYardRotation(rawBoundary, yardRotationDeg);
    const config = getConfiguration(configId);
    const normalizedLayoutEdits: LayoutConstraints = {
      ...layoutEdits,
      ...(layoutEdits.placedEquipment
        ? {
            placedEquipment: normalizeTracedPlacedEquipment(
              layoutEdits.placedEquipment,
              config,
              hotClimate,
            ),
          }
        : {}),
    };
    const options = { hotClimate, containersPerPcs, roadMode, autoRoadWrap, ringMode, perimeterBand, fencePlacement, laydownPct, augmentPct, futurePhaseUnits: get().futurePhaseUnits, surfacingMode, surfacingDepthIn, deadSpaceTrim, dcRouting, arrangement, latticeShift: get().latticeShift, gateEdge: get().gateEdge, exclusionZones: get().areaZones.filter(z => z.kind === 'exclusion'), constraints: { ...normalizedLayoutEdits, substation: get().substation } };
    // Every regeneration (sync or async) claims a token; only the latest
    // token may apply its result, so a sync regenerate supersedes any
    // in-flight worker run and stale worker results are discarded.
    const token = ++regenToken;
    const apply = (design: SiteDesign, prevOverride?: SiteDesign | null) => {
      if (token !== regenToken) return; // superseded
      // Keep feeder grouping overrides when the inverter set is unchanged
      // (spatial edits move inverters but keep their ids); otherwise the
      // overrides no longer apply and are cleared.
      const invIds = (d: SiteDesign | null) =>
        (d?.equipment ?? []).filter(e => e.kind === 'inverter').map(e => e.id).sort().join(',');
      // A multi-area pass has already mirrored the new design into state, so
      // the comparison baseline must be the design captured BEFORE it ran.
      const prev = prevOverride !== undefined ? prevOverride : get().design;
      const sameInverters = prev !== null && invIds(prev) === invIds(design);
      const clearedManual =
        prev !== null &&
        !sameInverters &&
        !opts?.suppressAssignmentNotice &&
        Object.keys(get().feederAssignments).length > 0;
      set({
        design,
        error: null,
        computing: false,
        feederAssignments: sameInverters ? get().feederAssignments : {},
        ...(clearedManual
          ? {
              feederResetNotice:
                'This change altered the inverter set, so your manual feeder groupings were reset — inverters were regrouped automatically. Undo (Ctrl+Z) restores them.',
            }
          : {}),
      });
      get().recomputeFeeders();
      // Geometric re-validation of grading zones against the fence of the
      // design that was just applied. Zones were accepted against the fence
      // at edit time; a restored/imported project or a fence-changing
      // regeneration can invalidate them. Invalid zones are dropped
      // (reject→keep-empty) — same contract setGradingZones enforces —
      // rather than silently shaping the FG surface. Zero zones: no-op.
      const zonesNow = get().gradingZones;
      if (zonesNow.length > 0 && gradingZonesRejectReason(zonesNow, design.fence) !== null) {
        // Per-zone salvage: keep zones that still sit inside the new fence and
        // name only the dropped one(s) in the notice. If the survivors still
        // fail the set-level validator (overlap, count cap), fall back to the
        // full reset — those failures aren't attributable to a single zone.
        const kept = zonesNow.filter(z => gradingZoneInsideFence(z, design.fence));
        const dropped = zonesNow.filter(z => !gradingZoneInsideFence(z, design.fence));
        if (dropped.length > 0 && gradingZonesRejectReason(kept, design.fence) === null) {
          const names = dropped.map(z => `"${z.name}"`).join(', ');
          set({
            gradingZones: kept,
            gradingZonesResetNotice: kept.length > 0
              ? `Grading zone${dropped.length > 1 ? 's' : ''} ${names} no longer fit${dropped.length > 1 ? '' : 's'} inside the fence and ${dropped.length > 1 ? 'were' : 'was'} removed. Your other grading zone${kept.length > 1 ? 's' : ''} ${kept.length > 1 ? 'were' : 'was'} kept.`
              : `Grading zone${dropped.length > 1 ? 's' : ''} ${names} no longer fit${dropped.length > 1 ? '' : 's'} inside the fence and ${dropped.length > 1 ? 'were' : 'was'} removed. The finish-grade surface falls back to the flat pad.`,
          });
        } else {
          set({
            gradingZones: [],
            gradingZonesResetNotice:
              'Saved grading zones no longer fit the fence (out of bounds or overlapping) and were removed. The finish-grade surface falls back to the flat pad.',
          });
        }
      }
    };
    // Multi-area site: a layout-affecting change belongs to the WHOLE site,
    // not just the footprint being edited. Re-laying only the active area
    // here also fed it the project-level target against a single parcel,
    // which is what silently dropped that area's roads (the auto road mode
    // falls back to a compact, road-free layout when the target cannot fit).
    // regenerateAreas applies the per-area target to every area and keeps
    // each one's roads. Single-area projects never enter this branch, so
    // their behavior is unchanged.
    if (get().siteAreas.length > 1) {
      const prevDesign = get().design;
      try {
        get().regenerateAreas();
        const applied = get().design;
        if (applied) apply(applied, prevDesign);
        if (token === regenToken) set({ computing: false });
      } catch (e: any) {
        if (token === regenToken) set({ error: e?.message || 'Failed to generate layout', computing: false });
      }
      return;
    }
    // Single-area path: stale traced roads self-heal here exactly like
    // regenerateAreas does per-area (render-time only — the stored edits are
    // never rewritten). Historically only the multi-area branch healed, so a
    // setter-driven rebuild of a stale single-area traced yard silently
    // reverted its healed roads to the raw stored records. Multi-area sites
    // never reach this line (the branch above delegates), so the heal cannot
    // double-run.
    if (layoutEdits.customRoads?.some(r => r.traced === true)) {
      const s2 = get();
      const tracedFenceStandard = isTracedBessYard(layoutEdits);
      const healingFence = tracedFenceStandard
        ? fencePolygonForLayout(boundary.polygon, layoutEdits, fencePlacement)
        : (s2.design?.fence?.length
            ? s2.design.fence
            : fencePolygonFor(boundary.polygon, fencePlacement));
      options.constraints = {
        ...options.constraints,
        customRoads: healTracedRoadConstraints(
          layoutEdits.customRoads,
          s2.activeAreaId ?? '',
          healingFence,
          s2.siteAreas,
          s2.drawing,
          'active yard',
          {
            designFence: healingFence,
            fencePlacement: tracedFenceStandard ? 'property-line' : fencePlacement,
            removedTraced: layoutEdits.removedTracedRoads,
            pavedTraced: layoutEdits.pavedTracedRoads,
          }),
      };
    }
    if (opts?.sync || !workerAvailable()) {
      try {
        apply(generateSiteDesign(boundary, config, targetMW, targetMWh, options));
        if (token === regenToken) set({ computing: false });
      } catch (e: any) {
        if (token === regenToken) set({ error: e?.message || 'Failed to generate layout', computing: false });
      }
      return;
    }
    set({ computing: true });
    generateDesignInWorker(boundary, configId, targetMW, targetMWh, options)
      .then(apply)
      .catch((e: any) => {
        if (e instanceof SupersededError || token !== regenToken) return;
        set({ error: e?.message || 'Failed to generate layout', computing: false });
      });
  },

  moveRow: (rowIndex: number, dx: number, dy: number, force = false): boolean => {
    set({ lastRejection: null });
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return false;
    const rowsNow = get().design?.blockRows ?? [];
    if (!rowsNow.some(r => r.index === rowIndex)) return false;
    const prevEdits = get().layoutEdits;
    const before = snapOf(get(), !dx && !dy
      ? `Restored row ${rowIndex} to automatic position`
      : `Moved row ${rowIndex} (${dx >= 0 ? '+' : ''}${dx}, ${dy >= 0 ? '+' : ''}${dy} ft)`);
    const rowMoves = { ...(prevEdits.rowMoves ?? {}) };
    if (!dx && !dy) delete rowMoves[rowIndex];
    else rowMoves[rowIndex] = { dx, dy };
    const forcedEdits = withForcedKey(prevEdits.forcedEdits, `row-${rowIndex}`, force && !!(dx || dy));
    set({ layoutEdits: { ...prevEdits, rowMoves, forcedEdits } });
    get().regenerate({ sync: true });
    const reason = rejectionReason(get().design?.warnings, `Row ${rowIndex} move rejected`);
    if (reason !== null) {
      set({ layoutEdits: prevEdits, lastRejection: reason });
      get().regenerate({ sync: true });
      return false;
    }
    set({ lastRejection: null });
    get().pushHistory(before);
    return true;
  },

  alignRows: (mode: RowAlignMode): boolean => {
    set({ lastRejection: null });
    const design = get().design;
    if (!design || !design.blockRows.length) return false;
    const offsets = computeRowAlignOffsets(design, mode);
    if (!Object.keys(offsets).length) return false;
    const prevEdits = get().layoutEdits;
    const label = mode === 'left' ? 'Aligned rows left'
      : mode === 'right' ? 'Aligned rows right' : 'Centered rows';
    const before = snapOf(get(), label);
    // Offsets are shifts from CURRENT positions; compose them onto any
    // existing per-row moves (rowMoves are offsets from the AUTO position).
    const rowMoves = { ...(prevEdits.rowMoves ?? {}) };
    for (const [key, off] of Object.entries(offsets)) {
      const idx = Number(key);
      const prev = rowMoves[idx];
      const dx = (prev?.dx ?? 0) + off.dx;
      const dy = prev?.dy ?? 0;
      if (!dx && !dy) delete rowMoves[idx];
      else rowMoves[idx] = { dx, dy };
    }
    set({ layoutEdits: { ...prevEdits, rowMoves } });
    get().regenerate({ sync: true });
    // Rows the engine rejects keep their automatic position (engine warning
    // shown); surface the first reason without reverting accepted rows.
    const warnings = get().design?.warnings ?? [];
    const reasons = Object.keys(offsets)
      .map(k => rejectionReason(warnings, `Row ${k} move rejected`))
      .filter((r): r is string => r !== null);
    if (reasons.length === Object.keys(offsets).length) {
      // Nothing was accepted — restore the previous edits entirely.
      set({ layoutEdits: prevEdits, lastRejection: reasons[0] });
      get().regenerate({ sync: true });
      return false;
    }
    set({ lastRejection: reasons[0] ?? null });
    get().pushHistory(before);
    return true;
  },

  alignIsland: (islandN: number, mode: RowAlignMode): boolean => {
    set({ lastRejection: null });
    const design = get().design;
    if (!design || !Number.isInteger(islandN)) return false;
    const res = computeIslandAlignOffset(design, islandN, mode);
    if ('error' in res) {
      set({ lastRejection: res.error });
      return false;
    }
    if (Math.abs(res.dx) < 0.5) return false; // already aligned
    const prevEdits = get().layoutEdits;
    const label = mode === 'left' ? `Aligned island ${islandN} left`
      : mode === 'right' ? `Aligned island ${islandN} right`
      : `Centered island ${islandN}`;
    const before = snapOf(get(), label);
    // Offset is a shift from the CURRENT position; compose onto any existing
    // move of the island's row (rowMoves are offsets from AUTO position).
    const rowMoves = { ...(prevEdits.rowMoves ?? {}) };
    const prev = rowMoves[res.rowIndex];
    const dx = (prev?.dx ?? 0) + res.dx;
    const dy = prev?.dy ?? 0;
    if (!dx && !dy) delete rowMoves[res.rowIndex];
    else rowMoves[res.rowIndex] = { dx, dy };
    set({ layoutEdits: { ...prevEdits, rowMoves } });
    get().regenerate({ sync: true });
    const reason = rejectionReason(get().design?.warnings ?? [], `Row ${res.rowIndex} move rejected`);
    if (reason) {
      set({ layoutEdits: prevEdits, lastRejection: reason });
      get().regenerate({ sync: true });
      return false;
    }
    get().pushHistory(before);
    return true;
  },

  mirrorAlignIsland: (islandN: number): boolean => {
    set({ lastRejection: null });
    const design = get().design;
    if (!design || !Number.isInteger(islandN)) return false;
    const res = computeIslandMirrorOffset(design, islandN);
    if ('error' in res) {
      set({ lastRejection: res.error });
      return false;
    }
    if (Math.abs(res.dx) < 0.5) return false; // already mirrored
    const prevEdits = get().layoutEdits;
    const before = snapOf(get(), `Mirror-aligned island ${islandN} to island ${res.neighborN}`);
    const rowMoves = { ...(prevEdits.rowMoves ?? {}) };
    const prev = rowMoves[res.rowIndex];
    const dx = (prev?.dx ?? 0) + res.dx;
    const dy = prev?.dy ?? 0;
    if (!dx && !dy) delete rowMoves[res.rowIndex];
    else rowMoves[res.rowIndex] = { dx, dy };
    set({ layoutEdits: { ...prevEdits, rowMoves } });
    get().regenerate({ sync: true });
    const reason2 = rejectionReason(get().design?.warnings ?? [], `Row ${res.rowIndex} move rejected`);
    if (reason2) {
      set({ layoutEdits: prevEdits, lastRejection: reason2 });
      get().regenerate({ sync: true });
      return false;
    }
    get().pushHistory(before);
    return true;
  },

  compactIsland: (dir: 'N' | 'S' | 'E' | 'W', islandN: number | null): boolean => {
    set({ lastRejection: null });
    const design = get().design;
    if (!design || !design.blockRows.length) return false;

    // Placed islands are not part of the auto row machinery: compact them by
    // moving their placement anchor (all four directions), re-validated by
    // the engine exactly like a manual drag.
    const isl = islandN !== null ? (design.islands ?? []).find(i => i.n === islandN) : undefined;
    if (islandN !== null && !isl) {
      set({ lastRejection: `island ${islandN} does not exist in this layout` });
      return false;
    }
    if (isl?.placed) {
      const delta = computePlacedIslandCompactDelta(design, islandN!, dir);
      if ('error' in delta) {
        set({ lastRejection: delta.error });
        return false;
      }
      if (Math.abs(delta.dx) < 0.5 && Math.abs(delta.dy) < 0.5) return false; // already at the edge
      // Anchor spec lookup: placed IslandInfo carries the placement anchor in
      // cx/cy — match it to the drafter's placedIslands entry.
      const spec = (get().layoutEdits.placedIslands ?? []).find(p =>
        Math.abs(p.x - (isl.cx ?? NaN)) < 0.25 && Math.abs(p.y - (isl.cy ?? NaN)) < 0.25);
      if (!spec) {
        set({ lastRejection: `island ${islandN} has no matching placed-island edit` });
        return false;
      }
      // movePlacedIsland re-validates through a full regeneration (fence,
      // collisions, road connection) and rolls back on rejection. The scan
      // is conservative but not road-aware, so back off in halves if the
      // full-travel landing spot is rejected.
      let d = 1;
      for (; d <= 4; d *= 2) {
        const dx = Math.round((delta.dx / d) / 0.5) * 0.5;
        const dy = Math.round((delta.dy / d) / 0.5) * 0.5;
        if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) break;
        const reason = get().movePlacedIsland(spec.id, dx, dy);
        if (reason === null) return true;
        set({ lastRejection: reason });
      }
      return false;
    }

    // E/W compact IS align left/right (the align scan already pulls to the
    // clearance-limited true limit in that direction).
    if (dir === 'E' || dir === 'W') {
      const mode: RowAlignMode = dir === 'W' ? 'left' : 'right';
      return islandN !== null ? get().alignIsland(islandN, mode) : get().alignRows(mode);
    }

    // N/S: road-regenerating vertical row shifts (gravity pack). Accepted
    // shifts can change the island-stack x alignment, which in turn changes
    // other rows' vertical limits on slanted lot lines — so settle
    // iteratively: recompute on the regenerated design until no row can move
    // further (bounded, converges because every iteration must accept a
    // >= 0.5 ft move to continue).
    const label = islandN !== null
      ? `Compacted island ${islandN} ${dir === 'N' ? 'north' : 'south'}`
      : `Compacted rows ${dir === 'N' ? 'north' : 'south'}`;
    const before = snapOf(get(), label);
    let anyAccepted = false;
    let firstReason: string | null = null;
    for (let iter = 0; iter < 4; iter++) {
      const cur = get().design;
      if (!cur) break;
      const shifts = computeCompactShifts(cur, dir, islandN);
      if ('error' in shifts) {
        if (!anyAccepted) { set({ lastRejection: shifts.error as string }); return false; }
        break;
      }
      const allEntries = Object.entries(shifts);
      if (!allEntries.length) break; // settled
      // The scan is x-position sensitive (island stacking can re-align rows
      // in x once a shift is accepted), so a full-travel pass can be
      // rejected even though a shorter travel is fine — back off in halves
      // before giving up on this pass.
      let passAccepted = false;
      for (const scale of [1, 0.5, 0.25]) {
        const entries = allEntries
          .map(([k, dy]) => [k, Math.round((dy * scale) / 0.5) * 0.5] as const)
          .filter(([, dy]) => Math.abs(dy) >= 0.5);
        if (!entries.length) break;
        const prevEdits = get().layoutEdits;
        // Shifts are offsets from CURRENT positions; compose onto existing
        // rowShifts (offsets from the aisle-adjusted auto baseline).
        const rowShifts = { ...(prevEdits.rowShifts ?? {}) };
        for (const [key, dy] of entries) {
          const idx = Number(key);
          const next = (rowShifts[idx] ?? 0) + dy;
          if (!next) delete rowShifts[idx];
          else rowShifts[idx] = next;
        }
        const edits = { ...prevEdits };
        if (Object.keys(rowShifts).length) edits.rowShifts = rowShifts;
        else delete edits.rowShifts;
        set({ layoutEdits: edits });
        get().regenerate({ sync: true });
        const warnings = get().design?.warnings ?? [];
        const reasons = entries
          .map(([k]) => rejectionReason(warnings, `Row ${k} vertical shift rejected`))
          .filter((r): r is string => r !== null);
        firstReason = firstReason ?? reasons[0] ?? null;
        if (reasons.length === entries.length) {
          // Nothing in this attempt was accepted — restore and try shorter.
          set({ layoutEdits: prevEdits });
          get().regenerate({ sync: true });
          continue;
        }
        passAccepted = true;
        anyAccepted = true;
        break;
      }
      if (!passAccepted) break;
    }
    if (!anyAccepted) {
      set({ lastRejection: firstReason });
      return false;
    }
    set({ lastRejection: firstReason });
    get().pushHistory(before);
    return true;
  },

  // Vertical CENTER alignment: put the island midway between its north and
  // south clearance limits (Top/Bottom = compactIsland N/S). Same validated
  // shift machinery, reject -> warn -> keep current position.
  vcenterIsland: (islandN: number): boolean => {
    set({ lastRejection: null });
    const design = get().design;
    if (!design || !Number.isInteger(islandN)) return false;
    const isl = (design.islands ?? []).find(i => i.n === islandN);
    if (!isl) {
      set({ lastRejection: `island ${islandN} does not exist in this layout` });
      return false;
    }
    if (isl.placed) {
      const dN = computePlacedIslandCompactDelta(design, islandN, 'N');
      const dS = computePlacedIslandCompactDelta(design, islandN, 'S');
      if ('error' in dN || 'error' in dS) {
        set({ lastRejection: ('error' in dN ? dN.error : (dS as { error: string }).error) });
        return false;
      }
      const dy = Math.round(((dN.dy + dS.dy) / 2) / 0.5) * 0.5;
      if (Math.abs(dy) < 0.5) return false; // already centered
      const spec = (get().layoutEdits.placedIslands ?? []).find(p =>
        Math.abs(p.x - (isl.cx ?? NaN)) < 0.25 && Math.abs(p.y - (isl.cy ?? NaN)) < 0.25);
      if (!spec) {
        set({ lastRejection: `island ${islandN} has no matching placed-island edit` });
        return false;
      }
      const reason = get().movePlacedIsland(spec.id, 0, dy);
      if (reason !== null) {
        set({ lastRejection: reason });
        return false;
      }
      return true;
    }
    // Auto island: midpoint of the N/S compact limits, applied through the
    // road-regenerating rowShifts constraint (single validated pass).
    const sN = computeCompactShifts(design, 'N', islandN);
    const sS = computeCompactShifts(design, 'S', islandN);
    if ('error' in sN || 'error' in sS) {
      set({ lastRejection: ('error' in sN ? sN.error : (sS as { error: string }).error) as string });
      return false;
    }
    const idxKey = Object.keys(sN)[0] ?? Object.keys(sS)[0];
    if (idxKey === undefined) return false; // no travel either way
    const idx = Number(idxKey);
    const dy = Math.round((((sN[idx] ?? 0) + (sS[idx] ?? 0)) / 2) / 0.5) * 0.5;
    if (Math.abs(dy) < 0.5) return false; // already centered
    const prevEdits = get().layoutEdits;
    const before = snapOf(get(), `Centered island ${islandN} vertically`);
    const rowShifts = { ...(prevEdits.rowShifts ?? {}) };
    const next = (rowShifts[idx] ?? 0) + dy;
    if (!next) delete rowShifts[idx];
    else rowShifts[idx] = next;
    const edits = { ...prevEdits };
    if (Object.keys(rowShifts).length) edits.rowShifts = rowShifts;
    else delete edits.rowShifts;
    set({ layoutEdits: edits });
    get().regenerate({ sync: true });
    const reason = rejectionReason(get().design?.warnings ?? [], `Row ${idx} vertical shift rejected`);
    if (reason !== null) {
      set({ layoutEdits: prevEdits, lastRejection: reason });
      get().regenerate({ sync: true });
      return false;
    }
    get().pushHistory(before);
    return true;
  },

  moveAisle: (aisleIndex: number, dy: number, force = false): boolean => {
    set({ lastRejection: null });
    if (!Number.isFinite(dy) || !Number.isInteger(aisleIndex)) return false;
    // Only horizontal row aisles (rotation 0) carry the stable 1-based aisle
    // index; vertical corridor roads between island groups are not movable.
    const nAisles = get().design?.aisles.filter(a => Math.abs(Math.sin(a.rotation)) < 0.5).length ?? 0;
    if (aisleIndex < 1 || aisleIndex > nAisles) return false;
    const prevEdits = get().layoutEdits;
    const before = snapOf(get(), !dy
      ? `Restored drive aisle ${aisleIndex} to automatic position`
      : `Moved drive aisle ${aisleIndex} (${dy >= 0 ? '+' : ''}${dy} ft)`);
    const aisleMoves = { ...(prevEdits.aisleMoves ?? {}) };
    if (!dy) delete aisleMoves[aisleIndex];
    else aisleMoves[aisleIndex] = dy;
    const forcedEdits = withForcedKey(prevEdits.forcedEdits, `aisle-${aisleIndex}`, force && !!dy);
    set({ layoutEdits: { ...prevEdits, aisleMoves, forcedEdits } });
    get().regenerate({ sync: true });
    const reason = rejectionReason(get().design?.warnings, `Aisle ${aisleIndex} move rejected`);
    if (reason !== null) {
      set({ layoutEdits: prevEdits, lastRejection: reason });
      get().regenerate({ sync: true });
      return false;
    }
    set({ lastRejection: null });
    get().pushHistory(before);
    return true;
  },

  moveBlock: (blockN: number, dx: number, dy: number, force = false, coalesceKey?: string): boolean => {
    set({ lastRejection: null });
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return false;
    const rowsNow = get().design?.blockRows ?? [];
    if (!rowsNow.some(r => r.blocks.some(b => b.n === blockN))) return false;
    const prevEdits = get().layoutEdits;
    const before = snapOf(get(), !dx && !dy
      ? `Restored block ${blockN} to automatic position`
      : `Moved block ${blockN} (${dx >= 0 ? '+' : ''}${dx}, ${dy >= 0 ? '+' : ''}${dy} ft)`,
      coalesceKey);
    const blockMoves = { ...(prevEdits.blockMoves ?? {}) };
    // Record the offset for BOTH ids of a mirrored pad, so a later group move
    // composes one consistent offset per footprint instead of splitting the
    // twins across move groups.
    const twins = twinGroupOf(get(), blockN);
    let forcedEdits = prevEdits.forcedEdits;
    for (const t of twins) {
      if (!dx && !dy) delete blockMoves[t];
      else blockMoves[t] = { dx, dy };
      forcedEdits = withForcedKey(forcedEdits, `block-${t}`, force && !!(dx || dy));
    }
    set({ layoutEdits: { ...prevEdits, blockMoves, forcedEdits } });
    get().regenerate({ sync: true });
    const reason = rejectionReason(get().design?.warnings, `Block ${blockN} move rejected`);
    if (reason !== null) {
      set({ layoutEdits: prevEdits, lastRejection: reason });
      get().regenerate({ sync: true });
      return false;
    }
    set({ lastRejection: null });
    get().pushHistory(before);
    return true;
  },

  moveBlocksGroup: (moves: { n: number; dx: number; dy: number }[], force = false, coalesceKey?: string): boolean => {
    set({ lastRejection: null });
    if (!moves.length || moves.some(m => !Number.isFinite(m.dx) || !Number.isFinite(m.dy))) return false;
    const rowsNow = get().design?.blockRows ?? [];
    if (!moves.every(m => rowsNow.some(r => r.blocks.some(b => b.n === m.n)))) return false;
    const prevEdits = get().layoutEdits;
    const before = snapOf(get(), `Moved ${moves.length} blocks together`, coalesceKey);
    const blockMoves = { ...(prevEdits.blockMoves ?? {}) };
    let forcedEdits = prevEdits.forcedEdits;
    for (const m of moves) {
      // Both ids of a mirrored pad carry the same offset (see twinGroupOf),
      // so the engine sees one delta per footprint.
      for (const t of twinGroupOf(get(), m.n)) {
        if (!m.dx && !m.dy) delete blockMoves[t];
        else blockMoves[t] = { dx: m.dx, dy: m.dy };
        forcedEdits = withForcedKey(forcedEdits, `block-${t}`, force && !!(m.dx || m.dy));
      }
    }
    set({ layoutEdits: { ...prevEdits, blockMoves, forcedEdits } });
    get().regenerate({ sync: true });
    const warnings = get().design?.warnings ?? [];
    const reasons = moves
      .map(m => rejectionReason(warnings, `Block ${m.n} move rejected`))
      .filter((r): r is string => r !== null);
    if (reasons.length) {
      set({ layoutEdits: prevEdits, lastRejection: reasons[0] });
      get().regenerate({ sync: true });
      return false;
    }
    set({ lastRejection: null });
    get().pushHistory(before);
    return true;
  },

  // Center a PCS block inside the space it can actually legally occupy.
  // Travel limits come from the SAME validateRowShift the drag preview and
  // the engine use, so "centered" means centered between real clearance
  // limits (fence, frozen roads, NFPA, neighbours, pinned reserved zones)
  // rather than the middle of the yard bounding box.
  centerBlocks: (blockNs: number[]): boolean => {
    set({ lastRejection: null });
    const design = get().design;
    const geom = design?.rowEditGeom;
    if (!design || !geom || !blockNs.length) return false;
    const all = design.blockRows.flatMap(r => r.blocks);
    const unit = blockNs
      .map(n => all.find(b => b.n === n))
      .filter((b): b is NonNullable<typeof b> => b !== undefined);
    if (unit.length !== blockNs.length) return false;
    // Mirrored pairs share ONE footprint center, and the engine silently
    // expands any block move to its twin. The twin must therefore join the
    // moving unit — left in `others` it sits at distance zero and every
    // position, including the current one, reads as a collision.
    const ids = new Set(blockNs);
    for (const b of all) {
      if (ids.has(b.n)) continue;
      if (unit.some(u => Math.abs(u.x - b.x) < 0.5 && Math.abs(u.y - b.y) < 0.5)) {
        ids.add(b.n);
        unit.push(b);
      }
    }
    const others = all.filter(b => !ids.has(b.n));
    const edits = get().layoutEdits;
    const pinnedReserved = design.reservedZones.filter(z =>
      (z.kind === 'futureAug' && (edits.augPins ?? {})[z.id] != null) ||
      (z.kind === 'laydown' && edits.laydownPin != null && edits.laydownSize != null)
    );
    const ok = (dx: number, dy: number) => validateRowShift(
      unit, others, geom, design.fence, design.boundary.polygon, dx, dy,
      design.aisles, pinnedReserved
    ) === null;
    if (!ok(0, 0)) {
      set({ lastRejection: 'the current position is already outside its clearance limits' });
      return false;
    }
    // Walk outward in fine steps: the first blocked step is the limit. A
    // coarse stride would skip narrow legal pockets on concave fences.
    const STEP = 0.5;
    const MAX = 400;
    const travel = (bx: number, by: number, sx: number, sy: number) => {
      let last = 0;
      for (let d = STEP; d <= MAX; d += STEP) {
        if (!ok(bx + sx * d, by + sy * d)) break;
        last = d;
      }
      return last;
    };
    // The free region around a block is not convex (aisles, islands, reserve
    // zones), so one midpoint-of-travel step can expose NEW free space at the
    // landing spot and a second "center" click would move the block again.
    // Iterate the midpoint step from the candidate position until it reaches
    // a fixed point, so the committed spot really is centered in its pocket.
    let dx = 0, dy = 0;
    for (let iter = 0; iter < 8; iter++) {
      const east = travel(dx, dy, 1, 0), west = travel(dx, dy, -1, 0);
      const north = travel(dx, dy, 0, 1), south = travel(dx, dy, 0, -1);
      const sx = Math.round(((east - west) / 2) / 0.1) * 0.1;
      const sy = Math.round(((north - south) / 2) / 0.1) * 0.1;
      let nx = dx + sx, ny = dy + sy;
      if (!ok(nx, ny)) {
        if (ok(nx, dy)) ny = dy;
        else if (ok(dx, ny)) nx = dx;
        else break;
      }
      if (Math.abs(nx - dx) < 0.1 && Math.abs(ny - dy) < 0.1) break;
      dx = nx; dy = ny;
    }
    dx = Math.round(dx / 0.1) * 0.1;
    dy = Math.round(dy / 0.1) * 0.1;
    // A diagonal can be blocked even when both axes are individually free,
    // so drop an axis rather than committing an invalid combined move.
    if (!ok(dx, dy)) {
      if (ok(dx, 0)) dy = 0;
      else if (ok(0, dy)) dx = 0;
      else { set({ lastRejection: 'no clear space to center this block into' }); return false; }
    }
    // Already centered: the iteration quantizes to 0.1 ft, so a residual step
    // of exactly one quantum is convergence noise, not a real re-center.
    if (Math.abs(dx) <= 0.1 + 1e-9 && Math.abs(dy) <= 0.1 + 1e-9) return false;
    // Compose onto each block's existing offset so the whole unit translates
    // rigidly, and commit through the normal validated edit actions.
    const moves = blockNs.map(n => {
      const prev = edits.blockMoves?.[n];
      return {
        n,
        dx: Number(((prev?.dx ?? 0) + dx).toFixed(3)),
        dy: Number(((prev?.dy ?? 0) + dy).toFixed(3)),
      };
    });
    return moves.length === 1
      ? get().moveBlock(moves[0].n, moves[0].dx, moves[0].dy)
      : get().moveBlocksGroup(moves);
  },

  // Clear the drafter's manual offsets for these blocks. This is a pure
  // constraint removal, so the engine simply re-places them automatically —
  // there is nothing to validate and nothing to reject.
  restoreAutoPosition: (blockNs: number[]): boolean => {
    set({ lastRejection: null });
    if (!blockNs.length) return false;
    const prevEdits = get().layoutEdits;
    const blockMoves = { ...(prevEdits.blockMoves ?? {}) };
    let forcedEdits = prevEdits.forcedEdits;
    let changed = false;
    for (const n of blockNs) {
      // Clear both ids of a mirrored pad, or the twin's leftover offset would
      // drag the "restored" block straight back off its automatic position.
      for (const t of twinGroupOf(get(), n)) {
        if (blockMoves[t] !== undefined) { delete blockMoves[t]; changed = true; }
        const cleared = withForcedKey(forcedEdits, `block-${t}`, false);
        if (cleared !== forcedEdits) { forcedEdits = cleared; changed = true; }
      }
    }
    if (!changed) return false; // already at the automatic position
    const before = snapOf(get(), blockNs.length === 1
      ? `Restored block ${blockNs[0]} to automatic position`
      : `Restored ${blockNs.length} blocks to automatic positions`);
    const next = { ...prevEdits, forcedEdits };
    if (Object.keys(blockMoves).length) next.blockMoves = blockMoves;
    else delete next.blockMoves;
    set({ layoutEdits: next });
    get().regenerate({ sync: true });
    get().pushHistory(before);
    return true;
  },

  // Placed islands are anchor-driven, not part of the auto row machinery, so
  // their center is the midpoint of the compact travel in each direction.
  centerPlacedIsland: (islandN: number): boolean => {
    set({ lastRejection: null });
    const design = get().design;
    if (!design || !Number.isInteger(islandN)) return false;
    const isl = (design.islands ?? []).find(i => i.n === islandN);
    if (!isl?.placed) {
      set({ lastRejection: `island ${islandN} is not a drag-placed island` });
      return false;
    }
    const dE = computePlacedIslandCompactDelta(design, islandN, 'E');
    const dW = computePlacedIslandCompactDelta(design, islandN, 'W');
    const dN = computePlacedIslandCompactDelta(design, islandN, 'N');
    const dS = computePlacedIslandCompactDelta(design, islandN, 'S');
    for (const d of [dE, dW, dN, dS]) {
      if ('error' in d) { set({ lastRejection: d.error }); return false; }
    }
    const dx = Math.round(((( dE as { dx: number }).dx + (dW as { dx: number }).dx) / 2) / 0.5) * 0.5;
    const dy = Math.round(((( dN as { dy: number }).dy + (dS as { dy: number }).dy) / 2) / 0.5) * 0.5;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return false; // already centered
    const spec = (get().layoutEdits.placedIslands ?? []).find(p =>
      Math.abs(p.x - (isl.cx ?? NaN)) < 0.25 && Math.abs(p.y - (isl.cy ?? NaN)) < 0.25);
    if (!spec) {
      set({ lastRejection: `island ${islandN} has no matching placed-island edit` });
      return false;
    }
    const reason = get().movePlacedIsland(spec.id, dx, dy);
    if (reason !== null) { set({ lastRejection: reason }); return false; }
    return true;
  },

  addCustomRoad: (pts: Pt[], drawWidth?: number): boolean => {
    const clean = (pts ?? []).filter(p => Number.isFinite(p.x) && Number.isFinite(p.y));
    // Need at least one real segment
    let len = 0;
    for (let i = 0; i + 1 < clean.length; i++) len += Math.hypot(clean[i + 1].x - clean[i].x, clean[i + 1].y - clean[i].y);
    if (clean.length < 2 || len < 5) {
      set({ lastRejection: 'Road too short — draw at least 5 ft.' });
      return false;
    }
    const prevEdits = get().layoutEdits;
    // Clamp width to valid range; omit if it equals the default 24 ft so
    // legacy files remain byte-identical when no override is needed.
    const widthOverride = (drawWidth && Number.isFinite(drawWidth) && drawWidth !== 24)
      ? Math.max(12, Math.min(60, drawWidth)) : undefined;
    const before = snapOf(get(), `Drew access road (${Math.round(len)} ft${widthOverride ? `, ${widthOverride} ft wide` : ''})`);
    const id = `road-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4)}`;
    const customRoads = [...(prevEdits.customRoads ?? []), { id, pts: clean, ...(widthOverride !== undefined ? { width: widthOverride } : {}) }];
    set({ layoutEdits: { ...prevEdits, customRoads } });
    get().regenerate({ sync: true });
    // The engine rejects roads that would be silently eaten by equipment
    // clearance / fence-setback clipping (stable "Drawn road <id> rejected:"
    // prefix). Revert the edit so a rejected road never lingers invisibly.
    const reason = rejectionReason(get().design?.warnings ?? [], `Drawn road ${id} rejected`);
    if (reason) {
      set({ layoutEdits: prevEdits, lastRejection: reason });
      get().regenerate({ sync: true });
      return false;
    }
    set({ lastRejection: null });
    get().pushHistory(before);
    return true;
  },

  removeCustomRoad: (id: string): void => {
    const prevEdits = get().layoutEdits;
    const removed = (prevEdits.customRoads ?? []).find(r => r.id === id);
    if (!removed) return;
    const customRoads = (prevEdits.customRoads ?? []).filter(r => r.id !== id);
    const before = snapOf(get(), 'Removed drawn road');
    const nextEdits: LayoutConstraints = { ...prevEdits, customRoads };
    if (removed.traced === true) {
      // Tombstone the deleted TRACED strip by geometry: the stale-save heal
      // rebuilds the traced set wholesale with re-sequenced ids, so an id
      // list can't keep this road deleted — rederiveStaleTracedRoads drops
      // fresh strips matching a fingerprint instead. A full trace re-apply
      // clears the list (Apply restores the complete drawn set).
      nextEdits.removedTracedRoads = [
        ...(prevEdits.removedTracedRoads ?? []),
        tracedRoadFingerprint(removed.pts),
      ].slice(-200);
    }
    set({ layoutEdits: nextEdits });
    get().regenerate({ sync: true });
    get().pushHistory(before);
  },
  paveTracedRoad: (id: string): boolean => {
    const prevEdits = get().layoutEdits;
    const road = (prevEdits.customRoads ?? []).find(r => r.id === id);
    if (!road || road.traced !== true) {
      set({ lastRejection: 'Only traced reference roads can be paved as drawn — drawn access roads already pave.' });
      return false;
    }
    const fp = tracedRoadFingerprint(road.pts);
    if (tracedRoadFingerprintMatch(fp, prevEdits.pavedTracedRoads)) {
      set({ lastRejection: 'This traced road is already paved as drawn.' });
      return false;
    }
    // Same fingerprint override philosophy as the deletion tombstones, in
    // the other direction: the stale-save heal rebuilds the traced set
    // wholesale with re-sequenced ids, so the override is keyed by the
    // strip's geometry and re-applied to the matching fresh strip.
    const before = snapOf(get(), 'Paved traced road as drawn');
    set({
      layoutEdits: {
        ...prevEdits,
        pavedTracedRoads: [...(prevEdits.pavedTracedRoads ?? []), fp].slice(-200),
      },
      lastRejection: null,
    });
    get().regenerate({ sync: true });
    get().pushHistory(before);
    return true;
  },
  unpaveTracedRoad: (fp: { x: number; y: number; len: number }): void => {
    const prevEdits = get().layoutEdits;
    const list = (prevEdits.pavedTracedRoads ?? []).filter(t =>
      !(t.x === fp.x && t.y === fp.y && t.len === fp.len));
    if (list.length === (prevEdits.pavedTracedRoads ?? []).length) return;
    const before = snapOf(get(), 'Reverted traced road to linework');
    const nextEdits: LayoutConstraints = { ...prevEdits };
    if (list.length) nextEdits.pavedTracedRoads = list;
    else delete nextEdits.pavedTracedRoads;
    set({ layoutEdits: nextEdits });
    get().regenerate({ sync: true });
    get().pushHistory(before);
  },

  // ---- KMZ auto-fill (reference trace) ------------------------------------
  tracePlan: null,
  analyzeReferenceTrace: (): boolean => {
    const drawing = get().drawing;
    if (!drawing || !drawing.layers.length) {
      set({ lastRejection: 'No reference drawing is loaded — import a customer KMZ first.' });
      return false;
    }
    const plan = analyzeReferenceDrawing(drawing);
    if (!plan.items.length && !plan.roads.length && !plan.unknowns.length) {
      set({ lastRejection: 'The reference drawing has no closed equipment- or road-sized shapes to auto-fill from.' });
      return false;
    }
    set({ tracePlan: plan, traceInclude: { equipment: true, roads: true }, lastRejection: null });
    return true;
  },
  setTraceUnknownTag: (index: number, tag: TraceUnknown['tag']): void => {
    const plan = get().tracePlan;
    if (!plan || !plan.unknowns[index]) return;
    const unknowns = plan.unknowns.map((u, i) => i === index ? { ...u, tag } : u);
    set({ tracePlan: { ...plan, unknowns } });
  },
  cancelReferenceTrace: (): void => set({ tracePlan: null }),
  traceInclude: { equipment: true, roads: true },
  setTraceInclude: (patch: Partial<{ equipment: boolean; roads: boolean }>): void =>
    set({ traceInclude: { ...get().traceInclude, ...patch } }),
  applyReferenceTrace: (opts?: { equipment?: boolean; roads?: boolean }): boolean => {
    const adds = buildTraceAdds(get().tracePlan, get().traceInclude, opts);
    if (adds === null) return false;
    if (!adds.equipAdds.length && !adds.roadAdds.length) {
      set({ tracePlan: null, lastRejection: 'Nothing selected to auto-fill.' });
      return false;
    }
    set({ tracePlan: null });
    return commitTraceAdds(set, get, adds.equipAdds, adds.roadAdds, 'Auto-filled design from reference drawing');
  },
  // Same commit, run phase-by-phase with paint yields between phases so the
  // Apply button can show a determinate progress bar during a big auto-fill.
  applyReferenceTraceWithProgress: async (
    onProgress: (frac: number, label: string) => void,
    opts?: { equipment?: boolean; roads?: boolean }
  ): Promise<boolean> => {
    const adds = buildTraceAdds(get().tracePlan, get().traceInclude, opts);
    if (adds === null) return false;
    if (!adds.equipAdds.length && !adds.roadAdds.length) {
      set({ tracePlan: null, lastRejection: 'Nothing selected to auto-fill.' });
      return false;
    }
    // One apply at a time: the phased commit yields to the browser between
    // phases, so a second click (or a programmatic re-entry) must be refused
    // rather than interleaving two half-applied commits.
    if (traceApplyBusy) {
      set({ lastRejection: 'An auto-fill is already being applied.' });
      return false;
    }
    traceApplyBusy = true;
    try {
      set({ tracePlan: null });
      const capturedActive = get().activeAreaId;
      const phases = buildTraceCommitPhases(
        set, get, adds.equipAdds, adds.roadAdds, 'Auto-filled design from reference drawing');
      if (!phases) return false;
      const raf: (cb: () => void) => void =
        typeof requestAnimationFrame === 'function'
          ? cb => requestAnimationFrame(() => cb())
          : cb => setTimeout(cb, 0); // node/test environments
      const paint = () => new Promise<void>(r => raf(() => raf(r)));
      onProgress(0.05, 'Reading the reference plan');
      await paint();
      for (const p of phases) {
        onProgress(p.frac, p.label);
        await paint();
        // The phases were bucketed against the active area at build time. If
        // the drafter switched areas during a paint yield, pin the original
        // area back before running the phase so every write, regenerate and
        // the final history entry land where the buckets were computed.
        if (capturedActive && get().activeAreaId !== capturedActive) {
          get().setActiveArea(capturedActive);
        }
        p.run();
      }
      onProgress(1, 'Done');
      return true;
    } finally {
      traceApplyBusy = false;
    }
  },

  // ---- scene bulk tagging (manual auto-fill fallback) ---------------------
  bulkTag: null,
  setBulkTag: (tag: BulkTagKind | null): void => set({ bulkTag: tag }),
  applyBulkTagRegion: (rect): string | null => {
    const tag = get().bulkTag;
    if (!tag) return 'No bulk tag armed.';
    const drawing = get().drawing;
    if (!drawing) return 'No reference drawing imported.';
    const inRect = (x: number, y: number) =>
      x >= rect.minX && x <= rect.maxX && y >= rect.minY && y <= rect.maxY;

    // Existing placed equipment centers (every area) — a shape already
    // committed by the scan or an earlier tag is skipped, so re-dragging a
    // box never duplicates gear.
    const taken: Pt[] = [];
    const collect = (edits: LayoutConstraints | undefined) => {
      for (const p of edits?.placedEquipment ?? []) taken.push({ x: p.x, y: p.y });
    };
    collect(get().layoutEdits);
    for (const a of get().siteAreas) if (a.id !== get().activeAreaId) collect(a.edits?.layoutEdits);
    const isTaken = (x: number, y: number) =>
      taken.some(t => Math.hypot(t.x - x, t.y - y) < 2);

    const equipAdds: TraceEquipAdd[] = [];
    const roadAdds: TraceRoadAdd[] = [];
    const isRoadTag = tag === 'road' || tag === 'wideRoad';
    for (const layer of drawing.layers) {
      const closedInBox: number[][] = [];
      const openInBox: number[][] = [];
      for (let i = 0; i < layer.polylines.length; i++) {
        const flat = layer.polylines[i];
        // A shape belongs to the box when its centroid falls inside.
        let sx = 0, sy = 0;
        const n = flat.length / 2;
        for (let k = 0; k < n; k++) { sx += flat[2 * k]; sy += flat[2 * k + 1]; }
        if (!inRect(sx / n, sy / n)) continue;
        (isClosedPolylineRun(flat, layer.closedFlags[i]) ? closedInBox : openInBox).push(flat);
      }
      if (isRoadTag) {
        const strips = [
          ...closedInBox.flatMap(f => roadStripsFromOutline(f)),
          ...roadStripsFromOpenLines(openInBox),
        ];
        for (const s of strips) {
          if (s.pts.length < 2) continue;
          roadAdds.push({
            pts: s.pts,
            widthFt: tag === 'wideRoad' ? Math.max(40, s.widthFt) : s.widthFt,
          });
        }
      } else {
        for (const flat of closedInBox) {
          const pose = fitRectPose(flat);
          if (!pose) continue;
          if (isTaken(pose.cx, pose.cy)) continue;
          equipAdds.push({ kind: tag, augmented: false, pose });
        }
      }
    }
    if (!equipAdds.length && !roadAdds.length) {
      return 'No drawn shapes matched inside the box.';
    }
    commitTraceAdds(set, get, equipAdds, roadAdds,
      isRoadTag ? 'Bulk-tagged drawn roads' : 'Bulk-tagged drawn equipment');
    return null;
  },

  // ---- manual single-gear placement ---------------------------------------
  gearPlacement: null,
  setGearPlacement: (kind: TraceEquipKind | null): void =>
    set({ gearPlacement: kind ? { kind } : null }),
  addPlacedGear: (kind: TraceEquipKind, x: number, y: number, rotationDeg = 0): string | null => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return 'Invalid placement point.';
    const spec = specForKind(kind);
    if (!spec) return `No catalog dimensions for ${kind}.`;
    const prevEdits = get().layoutEdits;
    let nextPeq = 1;
    for (const p of prevEdits.placedEquipment ?? []) {
      const m = /^peq-(\d+)$/.exec(p.id);
      if (m) nextPeq = Math.max(nextPeq, parseInt(m[1], 10) + 1);
    }
    const rot = ((rotationDeg % 360) + 360) % 360;
    const item: PlacedEquipmentSpec = {
      id: `peq-${nextPeq}`,
      kind,
      x, y,
      ...(rot ? { rotationDeg: rot } : {}),
      lengthFt: spec.dims.length, widthFt: spec.dims.width, heightFt: spec.dims.height,
      source: 'manual' as const,
    };
    const before = snapOf(get(), `Placed ${spec.item.toLowerCase()}`);
    // Strip any stale move/rotation edit left under this reused id.
    const gearEdits: LayoutConstraints = { ...prevEdits, placedEquipment: [...(prevEdits.placedEquipment ?? []), item] };
    if (gearEdits.equipMoves?.[item.id]) {
      const m = { ...gearEdits.equipMoves }; delete m[item.id];
      if (Object.keys(m).length) gearEdits.equipMoves = m; else delete gearEdits.equipMoves;
    }
    if (gearEdits.equipRots?.[item.id] !== undefined) {
      const r = { ...gearEdits.equipRots }; delete r[item.id];
      if (Object.keys(r).length) gearEdits.equipRots = r; else delete gearEdits.equipRots;
    }
    set({
      layoutEdits: gearEdits,
      gearPlacement: null,
    });
    get().regenerate({ sync: true });
    const warns = (get().design?.warnings ?? []).filter(w => w.startsWith(`Placed equipment ${item.id} `));
    set({ lastPlacedWarning: warns.length ? warns.join('\n') : null });
    get().pushHistory(before);
    return null;
  },
  moveEquipment: (id: string, dx: number, dy: number, force = false): boolean => {
    set({ lastRejection: null });
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return false;
    if (!(get().design?.equipment ?? []).some(e => e.id === id)) return false;
    // Hand-placed items own their position: rewrite the spec instead of
    // stacking an equipMoves delta on top of it, so one item never carries two
    // competing sources of truth.
    const ownSpec = isManualEquipmentId(id)
      ? (get().layoutEdits.placedEquipment ?? []).find(s => s.id === id)
      : undefined;
    if (ownSpec && isManualEquipmentSpec(ownSpec)) {
      const spec = ownSpec;
      const why = get().updatePlacedEquipment(id, { x: spec.x + dx, y: spec.y + dy });
      if (why !== null) { set({ lastRejection: why }); return false; }
      return true;
    }
    const prevEdits = get().layoutEdits;
    const before = snapOf(get(), !dx && !dy
      ? `Restored ${id} to automatic position`
      : `Moved ${id} (${dx >= 0 ? '+' : ''}${dx}, ${dy >= 0 ? '+' : ''}${dy} ft)`);
    const equipMoves = { ...(prevEdits.equipMoves ?? {}) };
    if (!dx && !dy) delete equipMoves[id];
    else equipMoves[id] = { dx, dy };
    const forcedEdits = withForcedKey(prevEdits.forcedEdits, `equip-${id}`, force && !!(dx || dy));
    set({ layoutEdits: { ...prevEdits, equipMoves, forcedEdits } });
    get().regenerate({ sync: true });
    const reason = rejectionReason(get().design?.warnings, `Equipment ${id} move rejected`);
    if (reason !== null) {
      set({ layoutEdits: prevEdits, lastRejection: reason });
      get().regenerate({ sync: true });
      return false;
    }
    set({ lastRejection: null });
    get().pushHistory(before);
    return true;
  },

  // Rotate one equipment item 90° clockwise about its own center. Turns
  // accumulate modulo 4, so a fourth rotation DELETES the entry and the item
  // is back on its automatic orientation with a byte-identical edit set.
  rotateEquipment: (id: string, force = false): boolean => {
    set({ lastRejection: null });
    if (!(get().design?.equipment ?? []).some(e => e.id === id)) return false;
    if (isManualEquipmentId(id)) {
      const why = get().rotatePlacedEquipment(id);
      if (why !== null) { set({ lastRejection: why }); return false; }
      return true;
    }
    const prevEdits = get().layoutEdits;
    const turns = normalizeQuarterTurns((prevEdits.equipRots?.[id] ?? 0) + 1);
    const before = snapOf(get(), turns === 0
      ? `Restored ${id} to automatic orientation`
      : `Rotated ${id} 90°`);
    const equipRots = { ...(prevEdits.equipRots ?? {}) };
    if (!turns) delete equipRots[id];
    else equipRots[id] = turns;
    const forcedEdits = withForcedKey(prevEdits.forcedEdits, `equip-rot-${id}`, force && !!turns);
    const next = { ...prevEdits, forcedEdits };
    if (Object.keys(equipRots).length) next.equipRots = equipRots;
    else delete next.equipRots;
    set({ layoutEdits: next });
    get().regenerate({ sync: true });
    const reason = rejectionReason(get().design?.warnings, `Equipment ${id} rotation rejected`);
    if (reason !== null) {
      set({ layoutEdits: prevEdits, lastRejection: reason });
      get().regenerate({ sync: true });
      return false;
    }
    set({ lastRejection: null });
    get().pushHistory(before);
    return true;
  },

  // Rotate one whole block (its PCS + three containers) 90° clockwise about
  // its own footprint center. All-or-nothing, same as a block move.
  rotateBlock: (n: number, force = false): boolean => {
    set({ lastRejection: null });
    if (!Number.isInteger(n)) return false;
    const prevEdits = get().layoutEdits;
    const turns = normalizeQuarterTurns((prevEdits.blockRots?.[n] ?? 0) + 1);
    const before = snapOf(get(), turns === 0
      ? `Restored block ${n} to automatic orientation`
      : `Rotated block ${n} 90°`);
    const blockRots = { ...(prevEdits.blockRots ?? {}) };
    if (!turns) delete blockRots[n];
    else blockRots[n] = turns;
    const forcedEdits = withForcedKey(prevEdits.forcedEdits, `block-rot-${n}`, force && !!turns);
    const next = { ...prevEdits, forcedEdits };
    if (Object.keys(blockRots).length) next.blockRots = blockRots;
    else delete next.blockRots;
    set({ layoutEdits: next });
    get().regenerate({ sync: true });
    const reason = rejectionReason(get().design?.warnings, `Block ${n} rotation rejected`);
    if (reason !== null) {
      set({ layoutEdits: prevEdits, lastRejection: reason });
      get().regenerate({ sync: true });
      return false;
    }
    set({ lastRejection: null });
    get().pushHistory(before);
    return true;
  },

  // Rotate every block of an automatic island as ONE transaction.
  //
  // Rotating an island block-by-block through rotateBlock is NOT equivalent:
  // each call commits its own edit, regenerate and history entry, so a block
  // that fails validation half way through leaves the earlier blocks turned
  // while the UI reports the rotation was rejected. That is exactly the
  // partially-rotated island the all-or-nothing contract forbids. Staging
  // every turn and validating them in a single regenerate also evaluates the
  // members against each other, not against a half-turned island.
  rotateBlocksGroup: (ns: number[], force = false): boolean => {
    set({ lastRejection: null });
    const list = ns.filter((n, i) => Number.isInteger(n) && ns.indexOf(n) === i);
    if (!list.length) return false;
    const prevEdits = get().layoutEdits;
    const before = snapOf(get(), list.length === 1
      ? `Rotated block ${list[0]} 90°`
      : `Rotated island (${list.length} blocks) 90°`);

    const blockRots = { ...(prevEdits.blockRots ?? {}) };
    let forcedEdits = prevEdits.forcedEdits;
    for (const n of list) {
      const turns = normalizeQuarterTurns((prevEdits.blockRots?.[n] ?? 0) + 1);
      if (!turns) delete blockRots[n];
      else blockRots[n] = turns;
      forcedEdits = withForcedKey(forcedEdits, `block-rot-${n}`, force && !!turns);
    }
    const next = { ...prevEdits, forcedEdits };
    if (Object.keys(blockRots).length) next.blockRots = blockRots;
    else delete next.blockRots;

    set({ layoutEdits: next });
    get().regenerate({ sync: true });
    // Any single member rejecting fails the whole island.
    const warnings = get().design?.warnings;
    let reason: string | null = null;
    for (const n of list) {
      const r = rejectionReason(warnings, `Block ${n} rotation rejected`);
      if (r !== null) { reason = `block ${n}: ${r}`; break; }
    }
    if (reason !== null) {
      set({ layoutEdits: prevEdits, lastRejection: reason });
      get().regenerate({ sync: true });
      return false;
    }
    set({ lastRejection: null });
    get().pushHistory(before);
    return true;
  },

  setTrenchPin: (x: number | null): boolean => {
    if (x !== null && !Number.isFinite(x)) return false;
    const prevEdits = get().layoutEdits;
    const before = snapOf(get(), x === null
      ? 'Set trench corridor back to automatic'
      : `Pinned trench corridor at x = ${x} ft`);
    set({ layoutEdits: { ...prevEdits, trenchX: x } });
    get().regenerate({ sync: true });
    const rejected = get().design?.warnings.some(w => w.startsWith('Pinned trench corridor rejected'));
    if (rejected) {
      set({ layoutEdits: prevEdits });
      get().regenerate({ sync: true });
      return false;
    }
    get().pushHistory(before);
    return true;
  },

  setFeederCorridorPin: (c: number | null): boolean => {
    if (c !== null && !Number.isFinite(c)) return false;
    const { design, substation } = get();
    if (!design || !substation) return false;
    // Validate up front (the corridor only affects feeders, never the yard
    // layout, so there is no design-warning round trip like other edits).
    if (c !== null && feederCorridorRejectReason(design, substation, c, get().maxPcsPerFeeder) !== null) return false;
    const prevEdits = get().layoutEdits;
    if ((prevEdits.feederCorridor ?? null) === c) return true;
    const before = snapOf(get(), c === null
      ? 'Set feeder corridor back to automatic'
      : `Pinned feeder corridor at ${c} ft`);
    const edits = { ...prevEdits };
    if (c === null) delete edits.feederCorridor;
    else edits.feederCorridor = c;
    set({ layoutEdits: edits });
    get().recomputeFeeders();
    get().pushHistory(before);
    return true;
  },

  setFeederRoute: (feederIdx: number, pts: Pt[] | null, force = false): boolean => {
    const { feeders } = get();
    const target = feeders.find(f => f.idx === feederIdx);
    if (!target) return false;
    const key = feederRouteKey(target.inverterIds);
    if (!key) return false;
    if (pts !== null && (!pts.length || pts.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y)))) return false;
    const prevEdits = get().layoutEdits;
    const before = snapOf(get(), pts === null
      ? `Reset feeder F${feederIdx} route to automatic`
      : force
        ? `Routed feeder F${feederIdx} on a custom path (engineer override)`
        : `Routed feeder F${feederIdx} on a custom path`);
    const feederRoutes = { ...(prevEdits.feederRoutes ?? {}) };
    if (pts === null) delete feederRoutes[key];
    else feederRoutes[key] = pts.map(p => ({ x: p.x, y: p.y }));
    const next = { ...prevEdits };
    if (Object.keys(feederRoutes).length) next.feederRoutes = feederRoutes;
    else delete next.feederRoutes;
    // Force only ever set together with a route; clearing the route clears it.
    next.forcedEdits = withForcedKey(prevEdits.forcedEdits, `feeder-route-${key}`, force && pts !== null);
    if (next.forcedEdits === undefined) delete next.forcedEdits;
    set({ layoutEdits: next, lastRejection: null });
    get().recomputeFeeders();
    const rejectPrefix = `Custom feeder route ${key} rejected`;
    const reason = rejectionReason(get().design?.warnings, rejectPrefix);
    if (pts !== null && reason !== null) {
      set({ layoutEdits: prevEdits, lastRejection: reason.replace(/\s*—\s*automatic route kept\.\s*$/, '') });
      get().recomputeFeeders();
      return false;
    }
    get().pushHistory(before);
    return true;
  },

  setAuxFeederRoute: (pts: Pt[] | null, force = false): boolean => {
    if (pts !== null && (!pts.length || pts.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y)))) return false;
    const prevEdits = get().layoutEdits;
    const before = snapOf(get(), pts === null
      ? 'Reset aux feeder route to automatic'
      : force
        ? 'Drew aux feeder route (engineer override)'
        : 'Drew aux feeder route');
    const next = { ...prevEdits };
    if (pts === null) {
      delete next.auxFeederWaypoints;
    } else {
      next.auxFeederWaypoints = pts.map(p => ({ x: p.x, y: p.y }));
    }
    // Force override key: tracks whether this drawn route bypassed validation
    next.forcedEdits = withForcedKey(prevEdits.forcedEdits, 'aux-feeder-route', force && pts !== null);
    if (next.forcedEdits === undefined) delete next.forcedEdits;
    set({ layoutEdits: next, lastRejection: null });
    get().recomputeFeeders();
    const rejectPrefix = 'Aux feeder custom route rejected';
    const reason = rejectionReason(get().design?.warnings, rejectPrefix);
    if (pts !== null && reason !== null && !force) {
      set({ layoutEdits: prevEdits, lastRejection: reason.replace(/\s*—\s*automatic route kept\.\s*$/, '') });
      get().recomputeFeeders();
      return false;
    }
    get().pushHistory(before);
    return true;
  },

  removeFeederRoute: (key: string): void => {
    const prevEdits = get().layoutEdits;
    if (!prevEdits.feederRoutes?.[key]) return;
    const before = snapOf(get(), `Removed custom feeder route (${key})`);
    const feederRoutes = { ...prevEdits.feederRoutes };
    delete feederRoutes[key];
    const next = { ...prevEdits };
    if (Object.keys(feederRoutes).length) next.feederRoutes = feederRoutes;
    else delete next.feederRoutes;
    next.forcedEdits = withForcedKey(prevEdits.forcedEdits, `feeder-route-${key}`, false);
    if (next.forcedEdits === undefined) delete next.forcedEdits;
    set({ layoutEdits: next });
    get().recomputeFeeders();
    get().pushHistory(before);
  },

  setLaydownPin: (pt: Pt | null): boolean => {
    if (pt !== null && (!Number.isFinite(pt.x) || !Number.isFinite(pt.y))) return false;
    // Clearing the pin also clears any custom size (full reset to auto).
    return get().setLaydownRect(pt, pt === null ? null : get().layoutEdits.laydownSize ?? null);
  },

  // Set pin + custom size together (one regeneration). Either may be null:
  // null size = automatic aspect/shrink sizing, null pin = automatic spot.
  addPlacedIsland: (
    center: Pt, angleDeg: number, pairs?: number,
    // Placement shape and the drafter's explicit augmentation decision.
    // Defaults reproduce the historical call: a full island WITH augmentation
    // and WITH the standard mid-island aux cluster.
    kind: PlacedIslandKind = 'island',
    aug = true,
    // false = bare placement: no mid-island aux cluster (the FJB stays).
    // Default true reproduces the historical composition for existing callers.
    auxGear = true
  ): string | null => {
    if (!Number.isFinite(center.x) || !Number.isFinite(center.y)) return 'invalid position';
    const normAngle = ((angleDeg % 360) + 360) % 360;
    const prevEdits = get().layoutEdits;
    const existing = prevEdits.placedIslands ?? [];
    if (existing.length >= 20) return 'placed island limit reached (20)';
    const nextN = existing.reduce((m, p) => {
      const mm = p.id.match(/^pisl-(\d+)$/);
      return mm ? Math.max(m, Number(mm[1]) + 1) : m;
    }, 1);
    const id = `pisl-${nextN}`;
    // Full-strip islands omit `pairs` entirely so existing projects and
    // saved files stay byte-identical.
    const nPairs = Number.isFinite(pairs)
      ? Math.min(ISLAND_PCS_PER_SIDE, Math.max(1, Math.trunc(pairs as number)))
      : ISLAND_PCS_PER_SIDE;
    const single = kind === 'single' || kind === 'single2';
    const singleLabel = kind === 'single2' ? '1 PCS + 2 BESS' : '1 PCS + 3 BESS';
    // A single PCS module never composes the island aux cluster, so recording
    // an opt-in on one would be a lie in the project file and in the undo
    // label. Force it off for singles.
    const wantAux = single ? false : auxGear;
    const augSuffix = aug ? ' with augmentation' : ' without augmentation';
    const auxSuffix = single ? '' : wantAux ? ' + aux cluster' : ' (core only)';
    const angleLabel = normAngle === 0 ? 'horizontal' : normAngle === 90 ? 'vertical' : `${normAngle}°`;
    const before = snapOf(get(), single
      ? `Placed ${angleLabel} single PCS module (${singleLabel})${augSuffix}`
      : nPairs === ISLAND_PCS_PER_SIDE
        ? `Placed ${angleLabel} island${augSuffix}${auxSuffix}`
        : `Placed ${angleLabel} ${nPairs}-pair partial island${augSuffix}${auxSuffix}`);
    set({
      layoutEdits: {
        ...prevEdits,
        placedIslands: [...existing, {
          id, x: center.x, y: center.y,
          // Write angleDeg when non-zero; omit for 0° (byte-identical to old horizontal saves).
          ...(normAngle !== 0 ? { angleDeg: normAngle } : {}),
          ...(!single && nPairs !== ISLAND_PCS_PER_SIDE ? { pairs: nPairs } : {}),
          ...(single ? { kind } : {}),
          // The drafter's answer is recorded either way: a NEW placement
          // always carries an explicit true/false. Absence is reserved for
          // records written before the choice existed, which keep the
          // historical "with augmentation" behaviour when reloaded.
          aug,
          // Only recorded when the drafter opted OUT: absence keeps the
          // historical full-cluster behaviour for files saved before the
          // choice existed. A single module always records false - it never
          // carries a cluster, whatever the caller asked for.
          ...(wantAux ? {} : { auxGear: false as const }),
        }],
      },
    });
    get().regenerate({ sync: true });
    const rejectPrefix = `Placed island ${id} rejected: `;
    const rejected = get().design?.warnings.find(w => w.startsWith(rejectPrefix));
    if (rejected) {
      set({ layoutEdits: prevEdits });
      get().regenerate({ sync: true });
      return rejected
        .slice(rejectPrefix.length)
        .replace(/\s*—\s*(move or remove|remove) it in the layout edits panel\.\s*$/, '')
        .trim();
    }
    // Placed-with-warning: the drop is kept; surface the finding(s).
    const warnPrefix = `Placed island ${id} placed with warning: `;
    const soft = (get().design?.warnings ?? [])
      .filter(w => w.startsWith(warnPrefix))
      .map(w => w.slice(warnPrefix.length).replace(/\s*—\s*[^—]*\.\s*$/, '').trim());
    set({ lastPlacedWarning: soft.length ? soft.join('; ') : null });
    get().pushHistory(before);
    return null;
  },

  // Drag a perimeter ring edge: `offset` is the TOTAL inward offset (feet)
  // for that side (positive = toward the equipment). The engine validates
  // (band must clear the cluster and stay inside the fence); rejections roll
  // the edit back and return the specific reason.
  moveRingEdge: (side: 'n' | 's' | 'e' | 'w', offset: number): string | null => {
    if (!Number.isFinite(offset)) return 'invalid offset';
    const prevEdits = get().layoutEdits;
    const prev = prevEdits.ringOffsets ?? {};
    const next = { ...prev };
    if (offset === 0) delete next[side];
    else next[side] = offset;
    if (JSON.stringify(next) === JSON.stringify(prev)) return null;
    const SIDE_NAME = { n: 'north', s: 'south', e: 'east', w: 'west' } as const;
    const before = snapOf(get(), `Moved ${SIDE_NAME[side]} perimeter road edge`);
    const edits = { ...prevEdits };
    if (Object.keys(next).length) edits.ringOffsets = next;
    else delete edits.ringOffsets;
    set({ layoutEdits: edits });
    get().regenerate({ sync: true });
    const rejectPrefix = `Ring edge ${SIDE_NAME[side]} move rejected: `;
    const rejected = get().design?.warnings.find(w => w.startsWith(rejectPrefix));
    if (rejected) {
      set({ layoutEdits: prevEdits });
      get().regenerate({ sync: true });
      return rejected
        .slice(rejectPrefix.length)
        .replace(/\s*—\s*automatic edge kept\.\s*$/, '')
        .trim();
    }
    get().pushHistory(before);
    return null;
  },

  // Translate an existing drag-placed island by (dx, dy) feet. The engine
  // re-validates the island at its new spot exactly like a fresh drop (fence
  // clearance, collisions, road connection); a rejection rolls the move back
  // and returns the reason.
  movePlacedIsland: (id: string, dx: number, dy: number, coalesceKey?: string): string | null => {
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return 'invalid move';
    const prevEdits = get().layoutEdits;
    const existing = prevEdits.placedIslands ?? [];
    const spec = existing.find(p => p.id === id);
    if (!spec) return `placed island ${id} not found`;
    // Keyboard nudges are finer than the 0.5 ft drag quantum, so only a
    // truly zero move is a no-op here.
    if (!dx && !dy) return null;
    const before = snapOf(get(), `Moved placed island ${id.replace(/^pisl-/, '')}`, coalesceKey);
    set({
      layoutEdits: {
        ...prevEdits,
        placedIslands: existing.map(p =>
          p.id === id ? { ...p, x: p.x + dx, y: p.y + dy } : p),
      },
    });
    get().regenerate({ sync: true });
    const rejectPrefix = `Placed island ${id} rejected: `;
    const rejected = get().design?.warnings.find(w => w.startsWith(rejectPrefix));
    if (rejected) {
      set({ layoutEdits: prevEdits });
      get().regenerate({ sync: true });
      return rejected
        .slice(rejectPrefix.length)
        .replace(/\s*—\s*(move or remove|remove) it in the layout edits panel\.\s*$/, '')
        .trim();
    }
    // Placed-with-warning: the move is kept; surface the finding(s).
    const warnPrefix = `Placed island ${id} placed with warning: `;
    const soft = (get().design?.warnings ?? [])
      .filter(w => w.startsWith(warnPrefix))
      .map(w => w.slice(warnPrefix.length).replace(/\s*—\s*[^—]*\.\s*$/, '').trim());
    set({ lastPlacedWarning: soft.length ? soft.join('; ') : null });
    get().pushHistory(before);
    return null;
  },

  removePlacedIsland: (id: string) => {
    const prevEdits = get().layoutEdits;
    const existing = prevEdits.placedIslands ?? [];
    if (!existing.some(p => p.id === id)) return;
    const before = snapOf(get(), `Removed placed island ${id.replace(/^pisl-/, '')}`);
    const remaining = existing.filter(p => p.id !== id);
    const next = { ...prevEdits };
    if (remaining.length) next.placedIslands = remaining;
    else delete next.placedIslands;
    set({ layoutEdits: next });
    get().regenerate({ sync: true });
    get().pushHistory(before);
  },

  // Rotate a placed island 15 degrees in place (step increment). Same
  // accept/reject/warn contract as a drop or a move, so preview, commit
  // and the panel always agree: hard rejections roll back and return the
  // reason, soft findings keep the rotation and surface through lastPlacedWarning.
  rotatePlacedIsland: (id: string): string | null => {
    const prevEdits = get().layoutEdits;
    const existing = prevEdits.placedIslands ?? [];
    const spec = existing.find(p => p.id === id);
    if (!spec) return `placed island ${id} not found`;
    const currentAngle = spec.angleDeg ?? (spec.vertical ? 90 : 0);
    const nextAngle = (currentAngle + 15) % 360;
    const angleLabel = nextAngle === 0 ? 'horizontal' : nextAngle === 90 ? 'vertical' : `${nextAngle}°`;
    const before = snapOf(get(), `Rotated placed island ${id.replace(/^pisl-/, '')} to ${angleLabel}`);
    set({
      layoutEdits: {
        ...prevEdits,
        placedIslands: existing.map(p => {
          if (p.id !== id) return p;
          const rotated = { ...p } as PlacedIslandSpec;
          // Clear the legacy vertical flag; use angleDeg exclusively.
          delete (rotated as { vertical?: boolean }).vertical;
          if (nextAngle === 0) delete (rotated as { angleDeg?: number }).angleDeg;
          else (rotated as { angleDeg?: number }).angleDeg = nextAngle;
          return rotated;
        }),
      },
    });
    get().regenerate({ sync: true });
    const rejectPrefix = `Placed island ${id} rejected: `;
    const rejected = get().design?.warnings.find(w => w.startsWith(rejectPrefix));
    if (rejected) {
      set({ layoutEdits: prevEdits });
      get().regenerate({ sync: true });
      return rejected
        .slice(rejectPrefix.length)
        .replace(/\s*—\s*(move or remove|remove) it in the layout edits panel\.\s*$/, '')
        .trim();
    }
    const warnPrefix = `Placed island ${id} placed with warning: `;
    const soft = (get().design?.warnings ?? [])
      .filter(w => w.startsWith(warnPrefix))
      .map(w => w.slice(warnPrefix.length).replace(/\s*—\s*[^—]*\.\s*$/, '').trim());
    set({ lastPlacedWarning: soft.length ? soft.join('; ') : null });
    get().pushHistory(before);
    return null;
  },

  // ---- interactive placement session -------------------------------------
  // Everything below is transient by construction: it writes ONLY `placement`
  // until commitPlacement runs, and the commit itself goes through
  // addPlacedIsland / movePlacedIsland. No session state reaches the design,
  // the project file or the undo history, so an abandoned placement leaves the
  // project byte-identical.
  beginPlacement: (init: PlacementInit) => {
    if (!finitePt(init?.center)) return;
    const snapFt = Number.isFinite(init.snapFt) ? Math.max(0, init.snapFt as number) : PLACEMENT_SNAP_DEFAULT_FT;
    if (init.mode === 'move') {
      // Manual single items live in their own spec list; a move re-previews
      // that item's own type and orientation.
      if (init.id && isManualEquipmentId(init.id)) {
        const eq = (get().layoutEdits.placedEquipment ?? []).find(p => p.id === init.id);
        if (!eq || !isManualEquipmentSpec(eq)) return;
        set({
          placement: {
            mode: 'move', id: eq.id,
            pointer: { x: init.center.x, y: init.center.y },
            center: { x: eq.x, y: eq.y },
            origin: { x: eq.x, y: eq.y },
            angleDeg: manualEquipmentAngle(eq),
            kind: 'equipment', equipType: eq.type,
            aug: false, auxGear: false,
            snapFt,
          },
        });
        return;
      }
      const spec = (get().layoutEdits.placedIslands ?? []).find(p => p.id === init.id);
      if (!spec) return;
      // A move previews the EXISTING placement's own shape, orientation and
      // augmentation decision — never the toolbar's current choice.
      const specAngle = spec.angleDeg ?? (spec.vertical ? 90 : 0);
      set({
        placement: {
          mode: 'move', id: spec.id,
          pointer: { x: init.center.x, y: init.center.y },
          center: { x: spec.x, y: spec.y },
          origin: { x: spec.x, y: spec.y },
          angleDeg: specAngle,
          ...(spec.pairs !== undefined ? { pairs: spec.pairs } : {}),
          kind: spec.kind === 'single' || spec.kind === 'single2' ? spec.kind : 'island',
          aug: spec.aug !== false,
          // Mirrors placedIslandHasAuxCluster: absent = legacy include.
          auxGear: spec.kind === 'single' || spec.kind === 'single2' ? false : spec.auxGear !== false,
          snapFt,
        },
      });
      return;
    }
    const rawInitAngle = typeof init.angleDeg === 'number' && Number.isFinite(init.angleDeg)
      ? ((init.angleDeg % 360) + 360) % 360
      : 0;
    const initKind = init.kind === 'single' || init.kind === 'single2' ? init.kind
      : init.kind === 'equipment' ? 'equipment' : 'island';
    // Catalog equipment commits in quarter turns, so its preview must use the
    // same normalized angle rather than showing an impossible 15° pose.
    const initAngle = initKind === 'equipment'
      ? ((Math.round(rawInitAngle / 90) * 90) % 360 + 360) % 360
      : rawInitAngle;
    if (initKind === 'equipment' && !isManualEquipmentType(init.equipType)) return;
    set({
      placement: {
        mode: 'new',
        pointer: { x: init.center.x, y: init.center.y },
        center: snapPlacementCenter(init.center, snapFt),
        angleDeg: initAngle,
        ...(init.pairs !== undefined ? { pairs: init.pairs } : {}),
        kind: initKind,
        ...(initKind === 'equipment' ? { equipType: init.equipType } : {}),
        aug: initKind === 'equipment' ? false : init.aug !== false,
        // A NEW island places CORE equipment unless the engineer explicitly
        // opts into the cluster — the opposite of the legacy default, which
        // only survives for records saved before the choice existed.
        auxGear: initKind === 'island' && init.auxGear === true,
        snapFt,
      },
    });
  },

  // Pointer motion keeps the raw position (smooth ghost tracking) separate
  // from the snapped candidate (what gets validated and committed).
  updatePlacementPointer: (pt: Pt) => {
    if (!finitePt(pt)) return;
    const p = get().placement;
    if (!p) return;
    set({
      placement: {
        ...p,
        pointer: { x: pt.x, y: pt.y },
        center: snapPlacementCenter(pt, p.snapFt),
      },
    });
  },

  // Exact numeric entry: the typed center IS the candidate (no snapping), and
  // the pointer follows it so a later snap change re-derives from here.
  setPlacementCenter: (pt: Pt) => {
    if (!finitePt(pt)) return;
    const p = get().placement;
    if (!p) return;
    set({ placement: { ...p, pointer: { x: pt.x, y: pt.y }, center: { x: pt.x, y: pt.y } } });
  },

  nudgePlacement: (dx: number, dy: number) => {
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
    const p = get().placement;
    if (!p) return;
    // Exact arithmetic on the candidate, never a re-snap: a 0.1 ft nudge must
    // survive even when the snap increment is 5 ft.
    const center = {
      x: Math.round((p.center.x + dx) * 100) / 100,
      y: Math.round((p.center.y + dy) * 100) / 100,
    };
    set({ placement: { ...p, pointer: center, center } });
  },

  setPlacementSnap: (snapFt: number) => {
    const p = get().placement;
    if (!p) return;
    const s = Number.isFinite(snapFt) ? Math.max(0, snapFt) : 0;
    set({ placement: { ...p, snapFt: s, center: snapPlacementCenter(p.pointer, s) } });
  },

  // Rotation is EXPLICIT: islands step 15°; catalog equipment steps 90°
  // because its persisted/validated pose is quarter-turn-only.
  rotatePlacement: () => {
    const p = get().placement;
    if (!p) return;
    const step = p.kind === 'equipment' ? 90 : 15;
    set({ placement: { ...p, angleDeg: (p.angleDeg + step) % 360 } });
  },
  setPlacementAngle: (angleDeg: number) => {
    const p = get().placement;
    if (!p) return;
    const raw = ((angleDeg % 360) + 360) % 360;
    const a = p.kind === 'equipment'
      ? ((Math.round(raw / 90) * 90) % 360 + 360) % 360
      : raw;
    set({ placement: { ...p, angleDeg: a } });
  },

  // The toolbar's equipment choices must steer the LIVE ghost: once hovering
  // has opened a session, picking a different kind/size/augmentation has to
  // change what is previewed and committed, or the drafter sees one selection
  // in the UI and drops a different one on the ground.
  setPlacementConfig: (cfg: {
    kind?: PlacedIslandKind | 'equipment'; pairs?: number; aug?: boolean;
    auxGear?: boolean; equipType?: ManualEquipmentType;
  }) => {
    const p = get().placement;
    // Moves preview the existing placement's own shape — never the toolbar's.
    if (!p || p.mode !== 'new' || !cfg) return;
    const kind = cfg.kind === 'single' || cfg.kind === 'single2'
      || cfg.kind === 'island' || cfg.kind === 'equipment'
      ? cfg.kind : p.kind;
    const pairs = Number.isFinite(cfg.pairs) ? (cfg.pairs as number) : p.pairs;
    const equipType = isManualEquipmentType(cfg.equipType) ? cfg.equipType : p.equipType;
    // A single module and an individually placed item have no island aug bays
    // and no island cluster, so the toolbar's island choices cannot leak onto
    // them: the session records what the shape can actually carry.
    const aug = kind === 'equipment' ? false
      : typeof cfg.aug === 'boolean' ? cfg.aug : p.aug;
    const auxGear = kind !== 'island' ? false
      : typeof cfg.auxGear === 'boolean' ? cfg.auxGear : p.auxGear;
    if (kind === p.kind && pairs === p.pairs && aug === p.aug
        && auxGear === p.auxGear && equipType === p.equipType) return;
    if (kind === 'equipment' && !isManualEquipmentType(equipType)) return;
    set({
      placement: {
        ...p, kind, aug, auxGear,
        ...(kind === 'equipment'
          ? { angleDeg: ((Math.round(p.angleDeg / 90) * 90) % 360 + 360) % 360 }
          : {}),
        ...(pairs !== undefined ? { pairs } : {}),
        ...(kind === 'equipment' ? { equipType } : {}),
      },
    });
  },

  cancelPlacement: () => {
    if (!get().placement) return;
    set({ placement: null });
  },

  // The exact spec the candidate represents. Both the ghost and the commit
  // read this, so what the drafter sees is what gets built.
  placementSpec: (): PlacedIslandSpec | null => {
    const p = get().placement;
    if (!p || p.kind === 'equipment') return null;
    const single = p.kind === 'single' || p.kind === 'single2';
    const nPairs = single ? undefined : placedIslandPairs(p.pairs);
    const normAngle = ((p.angleDeg % 360) + 360) % 360;
    return {
      id: p.id ?? 'placement',
      x: p.center.x, y: p.center.y,
      ...(normAngle !== 0 ? { angleDeg: normAngle } : {}),
      ...(!single && nPairs !== undefined && nPairs !== ISLAND_PCS_PER_SIDE ? { pairs: nPairs } : {}),
      ...(single ? { kind: p.kind } : {}),
      aug: p.aug,
      // Only recorded when the drafter opted OUT (a single never carries a
      // cluster): absence keeps the historical full-cluster behaviour.
      ...(!single && p.auxGear ? {} : { auxGear: false as const }),
    };
  },

  // The single manual item the current candidate represents (null unless the
  // session is placing equipment). Same contract as placementSpec: the ghost
  // and the commit read THIS geometry.
  placementEquipmentSpec: (): ManualEquipmentSpec | null => {
    const p = get().placement;
    if (!p || p.kind !== 'equipment' || !isManualEquipmentType(p.equipType)) return null;
    const a = ((Math.round(p.angleDeg / 90) * 90) % 360 + 360) % 360;
    return {
      id: p.id ?? 'placement',
      type: p.equipType,
      x: p.center.x, y: p.center.y,
      ...(a !== 0 ? { angleDeg: a } : {}),
    };
  },

  commitPlacement: (): string | null => {
    const p = get().placement;
    if (!p) return 'no placement in progress';
    if (p.mode === 'move' && p.kind === 'equipment') {
      const spec = (get().layoutEdits.placedEquipment ?? []).find(s => s.id === p.id);
      if (!spec) { set({ placement: null }); return `placed equipment ${p.id} not found`; }
      const a = ((Math.round(p.angleDeg / 90) * 90) % 360 + 360) % 360;
      const why = get().updatePlacedEquipment(spec.id, { x: p.center.x, y: p.center.y }, a);
      if (why !== null) return why;
      set({ placement: null });
      return null;
    }
    if (p.mode === 'move') {
      const spec = (get().layoutEdits.placedIslands ?? []).find(s => s.id === p.id);
      if (!spec) { set({ placement: null }); return `placed island ${p.id} not found`; }
      const dx = p.center.x - spec.x;
      const dy = p.center.y - spec.y;
      const specAngle = spec.angleDeg ?? (spec.vertical ? 90 : 0);
      const sessionAngle = ((p.angleDeg % 360) + 360) % 360;
      const turned = specAngle !== sessionAngle;
      // Nothing changed: a no-op, not an empty history entry.
      if (dx === 0 && dy === 0 && !turned) { set({ placement: null }); return null; }
      // Position and orientation commit as ONE edit. Applying them as a
      // rotate-then-move pair would validate an intermediate pose the drafter
      // never previewed (a turn in the old spot can reject even when the
      // previewed target is fine) and would write history for each half, so a
      // rejected commit could still leave entries on the undo stack.
      const prevEdits = get().layoutEdits;
      const existing = prevEdits.placedIslands ?? [];
      const id = p.id!;
      const angleLabel = sessionAngle === 0 ? 'horizontal'
        : sessionAngle === 90 ? 'vertical' : `${sessionAngle}°`;
      const label = turned
        ? (dx || dy
            ? `Moved and rotated placed island ${id.replace(/^pisl-/, '')} to ${angleLabel}`
            : `Rotated placed island ${id.replace(/^pisl-/, '')} to ${angleLabel}`)
        : `Moved placed island ${id.replace(/^pisl-/, '')}`;
      const before = snapOf(get(), label);
      set({
        layoutEdits: {
          ...prevEdits,
          placedIslands: existing.map(s => {
            if (s.id !== id) return s;
            const next = { ...s, x: p.center.x, y: p.center.y } as PlacedIslandSpec;
            // Always use angleDeg exclusively; clear any legacy vertical flag.
            delete (next as { vertical?: boolean }).vertical;
            if (sessionAngle === 0) delete (next as { angleDeg?: number }).angleDeg;
            else (next as { angleDeg?: number }).angleDeg = sessionAngle;
            return next;
          }),
        },
      });
      get().regenerate({ sync: true });
      const rejectPrefix = `Placed island ${id} rejected: `;
      const rejected = get().design?.warnings.find(w => w.startsWith(rejectPrefix));
      if (rejected) {
        // Full rollback: the design AND the undo stack end exactly as they
        // were, and the session stays open so the drafter can adjust.
        set({ layoutEdits: prevEdits });
        get().regenerate({ sync: true });
        return rejected
          .slice(rejectPrefix.length)
          .replace(/\s*—\s*(move or remove|remove) it in the layout edits panel\.\s*$/, '')
          .trim();
      }
      // Placed-with-warning: the edit is kept; surface the finding(s).
      const warnPrefix = `Placed island ${id} placed with warning: `;
      const soft = (get().design?.warnings ?? [])
        .filter(w => w.startsWith(warnPrefix))
        .map(w => w.slice(warnPrefix.length).replace(/\s*—\s*[^—]*\.\s*$/, '').trim());
      set({ lastPlacedWarning: soft.length ? soft.join('; ') : null });
      get().pushHistory(before);
      set({ placement: null });
      return null;
    }
    if (p.kind === 'equipment') {
      if (!isManualEquipmentType(p.equipType)) return 'no equipment type selected';
      const a = ((Math.round(p.angleDeg / 90) * 90) % 360 + 360) % 360;
      const why = get().addPlacedEquipment(p.equipType, { x: p.center.x, y: p.center.y }, a);
      if (why !== null) return why;
      set({ placement: null });
      return null;
    }
    const sessionNormAngle = ((p.angleDeg % 360) + 360) % 360;
    const why = get().addPlacedIsland(
      { x: p.center.x, y: p.center.y }, sessionNormAngle,
      p.kind === 'single' || p.kind === 'single2' ? undefined : placedIslandPairs(p.pairs),
      p.kind, p.aug, p.auxGear);
    if (why !== null) return why;
    set({ placement: null });
    return null;
  },

  // ---- individually placed auxiliary / comms / panel gear ----------------
  // Same contract as the placed-island mutators: write the spec, regenerate
  // synchronously, roll back completely on a hard rejection, surface soft
  // findings, and only then push history.
  addPlacedEquipment: (type: ManualEquipmentType, center: Pt, angleDeg = 0): string | null => {
    if (!isManualEquipmentType(type)) return 'unknown equipment type';
    if (!Number.isFinite(center.x) || !Number.isFinite(center.y)) return 'invalid position';
    const prevEdits = get().layoutEdits;
    const existing = prevEdits.placedEquipment ?? [];
    if (existing.length >= 200) return 'placed equipment limit reached (200)';
    const nextN = existing.reduce((m, p) => {
      const mm = p.id.match(/^peq-(\d+)$/);
      return mm ? Math.max(m, Number(mm[1]) + 1) : m;
    }, 1);
    const id = `peq-${nextN}`;
    const a = ((Math.round(angleDeg / 90) * 90) % 360 + 360) % 360;
    const before = snapOf(get(), `Placed ${MANUAL_EQUIPMENT_CATALOG[type].short.toLowerCase()}`);
    set({
      layoutEdits: {
        ...prevEdits,
        placedEquipment: [...existing, {
          id, type, x: center.x, y: center.y,
          ...(a !== 0 ? { angleDeg: a } : {}),
        }],
      },
    });
    return finishPlacedEquipmentEdit(get, set, id, prevEdits, before);
  },

  // Move and/or turn one manual item. Position lives in the spec, so this is
  // an absolute rewrite rather than an accumulating delta — the item can never
  // drift out from under the engineer across regenerations.
  updatePlacedEquipment: (id: string, center: Pt, angleDeg?: number): string | null => {
    if (!Number.isFinite(center.x) || !Number.isFinite(center.y)) return 'invalid position';
    const prevEdits = get().layoutEdits;
    const existing = prevEdits.placedEquipment ?? [];
    const spec = existing.find(s => s.id === id);
    if (!spec) return `placed equipment ${id} not found`;
    // Reference geometry (KMZ auto-fill, catalog-dimension drops) is drawn
    // where it was drawn: it nudges through equipMoves like automatic gear.
    if (!isManualEquipmentSpec(spec)) return null;
    const a = angleDeg === undefined
      ? manualEquipmentAngle(spec)
      : ((Math.round(angleDeg / 90) * 90) % 360 + 360) % 360;
    const turned = a !== manualEquipmentAngle(spec);
    const moved = center.x !== spec.x || center.y !== spec.y;
    if (!moved && !turned) return null;   // no-op, not an empty history entry
    const what = MANUAL_EQUIPMENT_CATALOG[spec.type].short.toLowerCase();
    const before = snapOf(get(), turned
      ? (moved ? `Moved and rotated ${what}` : `Rotated ${what} to ${a}°`)
      : `Moved ${what}`);
    set({
      layoutEdits: {
        ...prevEdits,
        placedEquipment: existing.map(s => {
          if (s.id !== id) return s;
          const next: ManualEquipmentSpec = { ...spec, x: center.x, y: center.y };
          if (a === 0) delete next.angleDeg; else next.angleDeg = a;
          return next;
        }),
      },
    });
    return finishPlacedEquipmentEdit(get, set, id, prevEdits, before);
  },

  // Quarter-turn CW about the item's own center, re-validated like a drop.
  rotatePlacedEquipment: (id: string): string | null => {
    const spec = (get().layoutEdits.placedEquipment ?? []).find(s => s.id === id);
    if (!spec) return `placed equipment ${id} not found`;
    if (!isManualEquipmentSpec(spec)) return null;
    return get().updatePlacedEquipment(id, { x: spec.x, y: spec.y }, manualEquipmentAngle(spec) + 90);
  },

  // Deleting a manual item drops its spec outright. Deliberately NOT a
  // removedEquipment tombstone: the item only exists because a spec asked for
  // it, so removing the spec leaves no residue to go dormant or resurrect.
  removePlacedEquipment: (id: string) => {
    const prevEdits = get().layoutEdits;
    const existing = prevEdits.placedEquipment ?? [];
    const spec = existing.find(s => s.id === id);
    if (!spec) return;
    const remaining = existing.filter(s => s.id !== id);
    const what = isManualEquipmentSpec(spec)
      ? MANUAL_EQUIPMENT_CATALOG[spec.type].short.toLowerCase()
      : 'placed equipment';
    const before = snapOf(get(), `Removed ${what}`);
    const next = { ...prevEdits };
    if (remaining.length) next.placedEquipment = remaining;
    else delete next.placedEquipment;
    // Drop any drafter nudge stored under the removed id so a future item
    // reusing the id never inherits it.
    if (next.equipMoves?.[id]) {
      const m = { ...next.equipMoves }; delete m[id];
      if (Object.keys(m).length) next.equipMoves = m; else delete next.equipMoves;
    }
    if (next.equipRots?.[id] !== undefined) {
      const r = { ...next.equipRots }; delete r[id];
      if (Object.keys(r).length) next.equipRots = r; else delete next.equipRots;
    }
    set({ layoutEdits: next });
    get().regenerate({ sync: true });
    get().pushHistory(before);
  },

  // Suppress an automatically generated interior road piece. Deliberately a
  // keep-and-warn edit: an access break is the drafter's call to make, so the
  // removal always applies and the consequence is reported rather than
  // silently reverted or hidden.
  removeGeneratedRoad: (id: string): string | null => {
    if (typeof id !== 'string' || !id) return null;
    const prevEdits = get().layoutEdits;
    const existing = prevEdits.removedRoads ?? [];
    if (existing.includes(id)) return null;
    const label = id.startsWith('corridor-') ? 'middle road' : 'drive aisle';
    const before = snapOf(get(), `Removed generated ${label} ${id}`);
    set({ layoutEdits: { ...prevEdits, removedRoads: [...existing, id] } });
    get().regenerate({ sync: true });
    get().pushHistory(before);
    const warnings = get().design?.warnings ?? [];
    return warnings.find(w =>
      w.includes('fully enclosed by equipment with no connection to the perimeter road') ||
      w.startsWith('Placed island') && w.includes('no road connection')) ?? null;
  },

  restoreGeneratedRoad: (id: string) => {
    const prevEdits = get().layoutEdits;
    const existing = prevEdits.removedRoads ?? [];
    if (!existing.includes(id)) return;
    const before = snapOf(get(), `Restored generated road ${id}`);
    const remaining = existing.filter(k => k !== id);
    const next = { ...prevEdits };
    if (remaining.length) next.removedRoads = remaining;
    else delete next.removedRoads;
    set({ layoutEdits: next });
    get().regenerate({ sync: true });
    get().pushHistory(before);
  },

  // Delete a road AREA. Like every other road edit this is keep-and-warn: an
  // access break is the drafter's call to make, so the cut always applies and
  // the consequence is reported rather than silently reverted. The one
  // exception is a cut that removes no road at all — that is a mis-click, not
  // an edit, so it is reverted rather than left as an invisible constraint.
  cutRoadArea: (poly: Pt[], label?: string): string | null => {
    const clean = (poly ?? []).filter(p => Number.isFinite(p.x) && Number.isFinite(p.y));
    if (clean.length < 3) {
      set({ lastRejection: 'Road deletion needs an area with at least 3 corners.' });
      return null;
    }
    const prevEdits = get().layoutEdits;
    const id = `rcut-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4)}`;
    const before = snapOf(get(), label ? `Deleted ${label}` : 'Deleted road area');
    const cut: RoadCut = { id, poly: clean, ...(label ? { label } : {}) };
    set({
      layoutEdits: { ...prevEdits, roadCuts: [...(prevEdits.roadCuts ?? []), cut] },
      lastRejection: null,
    });
    get().regenerate({ sync: true });
    const warnings = get().design?.warnings ?? [];
    // Nothing removed: the pick missed the road surface. Revert so a no-op
    // cut never lingers as a phantom edit the drafter cannot see.
    if (warnings.some(w => w.startsWith(`Road cut ${id}`) && w.includes('dormant'))) {
      set({
        layoutEdits: prevEdits,
        lastRejection: 'That area holds no road surface — nothing to delete.',
      });
      get().regenerate({ sync: true });
      return null;
    }
    get().pushHistory(before);
    return warnings.find(w => w.startsWith('Vehicle access lost:')) ?? null;
  },

  restoreRoadCut: (id: string) => {
    const prevEdits = get().layoutEdits;
    const existing = prevEdits.roadCuts ?? [];
    const remaining = existing.filter(c => c.id !== id);
    if (remaining.length === existing.length) return;
    const gone = existing.find(c => c.id === id);
    const before = snapOf(get(), `Restored ${gone?.label ?? 'deleted road area'}`);
    const next = { ...prevEdits };
    if (remaining.length) next.roadCuts = remaining;
    else delete next.roadCuts;
    set({ layoutEdits: next });
    get().regenerate({ sync: true });
    get().pushHistory(before);
  },

  restoreAllRoadCuts: () => {
    const prevEdits = get().layoutEdits;
    const n = (prevEdits.roadCuts ?? []).length;
    if (!n) return;
    const before = snapOf(get(), `Restored ${n} deleted road area${n === 1 ? '' : 's'}`);
    const next = { ...prevEdits };
    delete next.roadCuts;
    set({ layoutEdits: next });
    get().regenerate({ sync: true });
    get().pushHistory(before);
  },

  // Delete one whole automatic block (PCS + containers + aug bay). A deletion
  // is a normal declarative layout edit: it persists with the project, is
  // undoable, and every dependent artifact regenerates without it. The one
  // refusal is emptying the yard — that is a reset, not an edit.
  deleteBlock: (n: number): string | null => {
    if (!Number.isInteger(n) || n < 1) return null;
    const d = get().design;
    if (!d) return null;
    const autoBlockNs = new Set(
      d.equipment
        .map(e => (e.id.match(/^inv-(\d+)$/) ?? [])[1])
        .filter(Boolean)
        .map(Number)
    );
    const placedInvNs = new Set(
      (d.islands ?? []).filter(i => i.placed)
        .flatMap(i => i.inverterIds.map(id => Number((id.match(/^inv-(\d+)/) ?? [])[1])))
        .filter(Number.isInteger)
    );
    const prevEdits = get().layoutEdits;
    const already = prevEdits.removedBlocks ?? [];
    // Already deleted: a plain no-op. This MUST come before the existence
    // check — the block is legitimately absent from the design precisely
    // because it was deleted, and reporting "no such block" for a repeat
    // Delete keypress would be nonsense.
    if (already.includes(n)) return null;
    if (placedInvNs.has(n)) {
      return `Block ${n} belongs to a hand-placed island — delete the island itself instead.`;
    }
    if (!autoBlockNs.has(n)) return `This layout has no block ${n}.`;
    const before = snapOf(get(), `Deleted block ${n}`);
    set({ layoutEdits: { ...prevEdits, removedBlocks: [...already, n].sort((a, b) => a - b) } });
    get().regenerate({ sync: true });
    get().pushHistory(before);
    const warnings = get().design?.warnings ?? [];
    return warnings.find(w => w.startsWith(`Block ${n} deletion is dormant`)) ?? null;
  },

  // Delete a whole AUTOMATIC island in ONE transaction. Looping deleteBlock()
  // over the members would regenerate the site once per block and leave a
  // 14-deep undo stack for what the drafter did as a single act. Here every
  // member is staged into one constraint set, the site regenerates once, and
  // exactly one history entry is pushed — so one Ctrl+Z puts the island back.
  // Blocks belonging to a hand-placed island are refused: those are deleted
  // through their own placedIslands constraint.
  deleteAutoIsland: (blockNs: number[]): { deleted: number; note: string | null } => {
    const d = get().design;
    if (!d) return { deleted: 0, note: null };
    const ns = Array.from(new Set(
      (blockNs ?? []).filter(n => Number.isInteger(n) && n >= 1)
    )).sort((a, b) => a - b);
    if (!ns.length) return { deleted: 0, note: null };
    const autoBlockNs = new Set(
      d.equipment
        .map(e => (e.id.match(/^inv-(\d+)$/) ?? [])[1])
        .filter(Boolean)
        .map(Number)
    );
    const placedInvNs = new Set(
      (d.islands ?? []).filter(i => i.placed)
        .flatMap(i => i.inverterIds.map(id => Number((id.match(/^inv-(\d+)/) ?? [])[1])))
        .filter(Number.isInteger)
    );
    const prevEdits = get().layoutEdits;
    const already = prevEdits.removedBlocks ?? [];
    if (ns.some(n => placedInvNs.has(n))) {
      return { deleted: 0, note: 'That island is hand-placed — delete the island itself instead.' };
    }
    const toRemove = ns.filter(n => !already.includes(n) && autoBlockNs.has(n));
    if (!toRemove.length) return { deleted: 0, note: null };
    const before = snapOf(get(), toRemove.length === 1
      ? `Deleted block ${toRemove[0]}`
      : `Deleted island (${toRemove.length} blocks)`);
    set({ layoutEdits: {
      ...prevEdits,
      removedBlocks: [...already, ...toRemove].sort((a, b) => a - b),
    } });
    get().regenerate({ sync: true });
    get().pushHistory(before);
    const warnings = get().design?.warnings ?? [];
    const dormant = warnings.find(w => /^Block \d+ deletion is dormant/.test(w)) ?? null;
    return { deleted: toRemove.length, note: dormant };
  },

  // Delete a heterogeneous multi-selection in ONE transaction. Looping the
  // single-item actions would regenerate per item and leave one undo entry
  // per item for what the drafter did as a single act (see deleteAutoIsland).
  // Ownership rules mirror the single-item paths exactly: PCS ids escalate to
  // their whole block, members of hand-placed islands are refused with a note
  // (delete the island itself — pass its id in placedIslandIds), and peq-<n>
  // ids remove the placed-equipment constraint (with its stale nudges).
  deleteEquipmentBatch: (items: { blocks?: number[]; equipment?: string[]; placedIslandIds?: string[] }): { deleted: number; notes: string[] } => {
    const notes: string[] = [];
    const d = get().design;
    if (!d) return { deleted: 0, notes };
    const autoBlockNs = new Set(
      d.equipment
        .map(e => (e.id.match(/^inv-(\d+)$/) ?? [])[1])
        .filter(Boolean)
        .map(Number)
    );
    const placedInvNs = new Set(
      (d.islands ?? []).filter(i => i.placed)
        .flatMap(i => i.inverterIds.map(id => Number((id.match(/^inv-(\d+)/) ?? [])[1])))
        .filter(Number.isInteger)
    );
    const prevEdits = get().layoutEdits;
    const alreadyB = prevEdits.removedBlocks ?? [];
    const alreadyE = prevEdits.removedEquipment ?? [];
    const blockSet = new Set<number>();
    const equipSet = new Set<string>();
    const peqSet = new Set<string>();
    const wantBlock = (n: number) => {
      if (!Number.isInteger(n) || n < 1) return;
      // Ownership first: a hand-placed island member is refused with a note
      // even if its number also sits on the removal list (placed islands can
      // reuse the numbers earlier deletions freed up).
      if (placedInvNs.has(n)) {
        notes.push(`Block ${n} belongs to a hand-placed island — delete the island itself instead.`);
        return;
      }
      if (alreadyB.includes(n)) return; // already deleted: plain no-op
      if (!autoBlockNs.has(n)) { notes.push(`This layout has no block ${n}.`); return; }
      blockSet.add(n);
    };
    for (const n of items.blocks ?? []) wantBlock(n);
    for (const id of items.equipment ?? []) {
      if (typeof id !== 'string' || !id) continue;
      const inv = id.match(/^inv-(\d+)$/);
      if (inv) { wantBlock(Number(inv[1])); continue; } // PCS → whole block
      if (/^peq-\d+$/.test(id)) {
        if ((prevEdits.placedEquipment ?? []).some(p => p.id === id)) peqSet.add(id);
        continue;
      }
      if (alreadyE.includes(id)) continue;
      if (!d.equipment.some(e => e.id === id)) { notes.push(`This layout has no ${id}.`); continue; }
      const owner = Number((id.match(/^bess-(\d+)/) ?? [])[1]);
      if (Number.isInteger(owner) && placedInvNs.has(owner)) {
        notes.push(`${id} belongs to a hand-placed island — delete the island itself instead.`);
        continue;
      }
      equipSet.add(id);
    }
    const existingP = prevEdits.placedIslands ?? [];
    const pislSet = new Set(
      (items.placedIslandIds ?? []).filter(id => existingP.some(p => p.id === id))
    );
    // Normalize overlap: a member item (bess-N-*) whose block N is being
    // deleted in this same batch is subsumed by the block removal. Keeping it
    // on removedEquipment would outlive a later "restore block N" and leave a
    // persistent partial block.
    if (blockSet.size) {
      equipSet.forEach(id => {
        const owner = Number((id.match(/^bess-(\d+)/) ?? [])[1]);
        if (Number.isInteger(owner) && blockSet.has(owner)) equipSet.delete(id);
      });
    }
    const total = blockSet.size + equipSet.size + pislSet.size + peqSet.size;
    if (!total) return { deleted: 0, notes };
    const before = snapOf(get(), total === 1
      ? 'Deleted 1 selected item'
      : `Deleted ${total} selected items`);
    const next = { ...prevEdits } as typeof prevEdits;
    if (blockSet.size) {
      next.removedBlocks = [...alreadyB, ...Array.from(blockSet)].sort((a, b) => a - b);
    }
    if (equipSet.size) {
      next.removedEquipment = [...alreadyE, ...Array.from(equipSet)].sort();
    }
    if (pislSet.size) {
      const remaining = existingP.filter(p => !pislSet.has(p.id));
      if (remaining.length) next.placedIslands = remaining;
      else delete next.placedIslands;
    }
    if (peqSet.size) {
      const remaining = (prevEdits.placedEquipment ?? []).filter(p => !peqSet.has(p.id));
      if (remaining.length) next.placedEquipment = remaining;
      else delete next.placedEquipment;
      // Drop the removed items' own move/rotation edits so a future item that
      // reuses the id doesn't inherit a stale nudge.
      const moves = { ...(next.equipMoves ?? {}) };
      const rots = { ...(next.equipRots ?? {}) };
      peqSet.forEach(id => { delete moves[id]; delete rots[id]; });
      if (Object.keys(moves).length) next.equipMoves = moves; else delete next.equipMoves;
      if (Object.keys(rots).length) next.equipRots = rots; else delete next.equipRots;
    }
    set({ layoutEdits: next });
    get().regenerate({ sync: true });
    get().pushHistory(before);
    const warnings = get().design?.warnings ?? [];
    const dormant = warnings.find(w => /^(Block \d+|Equipment \S+) deletion is dormant/.test(w));
    if (dormant) notes.push(dormant);
    return { deleted: total, notes };
  },

  // Empty the yard as ONE undoable edit. Every automatic block and standalone
  // automatic item is staged onto the removal lists (so they stay listed on
  // the restore surfaces), and every hand-placed island / gear constraint is
  // cleared, then the site regenerates once. This is deliberately allowed to
  // empty the yard — it is the explicit, confirmed "reset" the single-item
  // paths refuse to reach by accident.
  removeAllEquipment: (): number => {
    const d = get().design;
    if (!d) return 0;
    const prevEdits = get().layoutEdits;
    const alreadyB = prevEdits.removedBlocks ?? [];
    const alreadyE = prevEdits.removedEquipment ?? [];
    const placedInvNs = new Set(
      (d.islands ?? []).filter(i => i.placed)
        .flatMap(i => i.inverterIds.map(id => Number((id.match(/^inv-(\d+)/) ?? [])[1])))
        .filter(Number.isInteger)
    );
    const blockAdds = Array.from(new Set(
      d.equipment
        .map(e => (e.id.match(/^inv-(\d+)$/) ?? [])[1])
        .filter(Boolean)
        .map(Number)
    )).filter(n => !alreadyB.includes(n) && !placedInvNs.has(n));
    // Standalone automatic items: everything that isn't part of a block
    // (inv-/bess- ids ride with their block) and isn't a hand-placed item
    // (peq- ids clear through their own constraint below).
    const equipAdds = d.equipment
      .map(e => e.id)
      .filter(id => !/^inv-|^bess-|^peq-/.test(id) && !alreadyE.includes(id));
    const placedIslands = prevEdits.placedIslands ?? [];
    const placedEquipment = prevEdits.placedEquipment ?? [];
    const total = blockAdds.length + equipAdds.length + placedIslands.length + placedEquipment.length;
    if (!total) return 0;
    const before = snapOf(get(), 'Removed all equipment');
    const next = { ...prevEdits } as typeof prevEdits;
    if (blockAdds.length) next.removedBlocks = [...alreadyB, ...blockAdds].sort((a, b) => a - b);
    if (equipAdds.length) next.removedEquipment = [...alreadyE, ...equipAdds].sort();
    delete next.placedIslands;
    if (placedEquipment.length) {
      delete next.placedEquipment;
      const moves = { ...(next.equipMoves ?? {}) };
      const rots = { ...(next.equipRots ?? {}) };
      placedEquipment.forEach(p => { delete moves[p.id]; delete rots[p.id]; });
      if (Object.keys(moves).length) next.equipMoves = moves; else delete next.equipMoves;
      if (Object.keys(rots).length) next.equipRots = rots; else delete next.equipRots;
    }
    set({ layoutEdits: next });
    get().regenerate({ sync: true });
    get().pushHistory(before);
    return total;
  },

  // Delete a single equipment item. A PCS id escalates to its whole block:
  // containers with no inverter are not a buildable arrangement, so the
  // escalation is reported instead of performed silently.
  deleteEquipment: (id: string): string | null => {
    if (typeof id !== 'string' || !id) return null;
    const d = get().design;
    if (!d) return null;
    const inv = id.match(/^inv-(\d+)$/);
    if (inv) {
      // A PCS cannot be deleted on its own: its containers would have no
      // inverter. Escalate to the whole block and SAY so — the drafter must
      // not discover the missing containers only by reading the drawing.
      const n = Number(inv[1]);
      const already = (get().layoutEdits.removedBlocks ?? []).includes(n);
      const note = get().deleteBlock(n);
      if (note !== null || already) return note;
      return `PCS ${id} could not be deleted on its own — block ${n} ` +
        '(inverter, containers and augmentation bay) was deleted instead.';
    }
    // A hand-placed item is deleted by dropping its spec — a removedEquipment
    // tombstone would leave a dormant id pointing at something that no longer
    // has any reason to exist.
    if (isManualEquipmentId(id)) {
      if (!(get().layoutEdits.placedEquipment ?? []).some(s => s.id === id)) {
        return `This layout has no ${id}.`;
      }
      get().removePlacedEquipment(id);
      return null;
    }
    const prevEquip = get().layoutEdits.removedEquipment ?? [];
    if (prevEquip.includes(id)) return null;
    if (!d.equipment.some(e => e.id === id)) return `This layout has no ${id}.`;
    const placedInvNs = new Set(
      (d.islands ?? []).filter(i => i.placed)
        .flatMap(i => i.inverterIds.map(x => Number((x.match(/^inv-(\d+)/) ?? [])[1])))
        .filter(Number.isInteger)
    );
    const owner = Number((id.match(/^bess-(\d+)/) ?? [])[1]);
    if (Number.isInteger(owner) && placedInvNs.has(owner)) {
      return `${id} belongs to a hand-placed island — delete the island itself instead.`;
    }
    const prevEdits = get().layoutEdits;
    const already = prevEdits.removedEquipment ?? [];
    if (already.includes(id)) return null;
    const before = snapOf(get(), `Deleted ${id}`);
    set({ layoutEdits: { ...prevEdits, removedEquipment: [...already, id].sort() } });
    get().regenerate({ sync: true });
    get().pushHistory(before);
    const warnings = get().design?.warnings ?? [];
    return warnings.find(w => w.startsWith(`Equipment ${id} deletion is dormant`)) ?? null;
  },

  restoreDeletedBlock: (n: number) => {
    const prevEdits = get().layoutEdits;
    const existing = prevEdits.removedBlocks ?? [];
    if (!existing.includes(n)) return;
    const before = snapOf(get(), `Restored block ${n}`);
    const remaining = existing.filter(k => k !== n);
    const next = { ...prevEdits };
    if (remaining.length) next.removedBlocks = remaining;
    else delete next.removedBlocks;
    set({ layoutEdits: next });
    get().regenerate({ sync: true });
    get().pushHistory(before);
  },

  restoreDeletedEquipment: (id: string) => {
    const prevEdits = get().layoutEdits;
    const existing = prevEdits.removedEquipment ?? [];
    if (!existing.includes(id)) return;
    const before = snapOf(get(), `Restored ${id}`);
    const remaining = existing.filter(k => k !== id);
    const next = { ...prevEdits };
    if (remaining.length) next.removedEquipment = remaining;
    else delete next.removedEquipment;
    set({ layoutEdits: next });
    get().regenerate({ sync: true });
    get().pushHistory(before);
  },

  restoreAllDeleted: () => {
    const prevEdits = get().layoutEdits;
    const nBlocks = (prevEdits.removedBlocks ?? []).length;
    const nEquip = (prevEdits.removedEquipment ?? []).length;
    if (!nBlocks && !nEquip) return;
    const before = snapOf(get(), `Restored ${nBlocks + nEquip} deleted item${nBlocks + nEquip === 1 ? '' : 's'}`);
    const next = { ...prevEdits };
    delete next.removedBlocks;
    delete next.removedEquipment;
    set({ layoutEdits: next });
    get().regenerate({ sync: true });
    get().pushHistory(before);
  },

  setLaydownRect: (pt: Pt | null, size: { length: number; width: number } | null): boolean => {
    if (pt !== null && (!Number.isFinite(pt.x) || !Number.isFinite(pt.y))) return false;
    if (size !== null && (!Number.isFinite(size.length) || !Number.isFinite(size.width))) return false;
    const prevEdits = get().layoutEdits;
    const before = snapOf(get(), pt === null
      ? 'Reset laydown area to automatic'
      : size !== null
        ? `Placed laydown area (${size.length} × ${size.width} ft)`
        : 'Moved laydown area');
    set({ layoutEdits: { ...prevEdits, laydownPin: pt, laydownSize: size } });
    get().regenerate({ sync: true });
    const rejected = get().design?.warnings.some(w =>
      w.startsWith('Pinned laydown area rejected') || w.startsWith('Custom laydown size rejected'));
    if (rejected) {
      set({ layoutEdits: prevEdits });
      get().regenerate({ sync: true });
      return false;
    }
    get().pushHistory(before);
    return true;
  },

  setFutureAugPin: (zoneId: string, pt: Pt | null): boolean => {
    const mBlk = zoneId.match(/^future-blk-(\d+)$/);
    const mIsl = zoneId.match(/^island-aug-(\d+)-(\d+)$/);
    if (!mBlk && !mIsl) return false;
    if (pt !== null && (!Number.isFinite(pt.x) || !Number.isFinite(pt.y))) return false;
    const label = mBlk
      ? `future BESS block ${mBlk[1]}`
      : `island ${mIsl![1]} augmentation unit ${mIsl![2]}`;
    // Stable warning prefix the engine emits when a pin fails validation.
    const rejectPrefix = mBlk
      ? `Pinned future BESS block ${mBlk[1]} rejected`
      : `Pinned island ${mIsl![1]} augmentation unit ${mIsl![2]} rejected`;
    const prevEdits = get().layoutEdits;
    const before = snapOf(get(), pt === null
      ? `Reset ${label} to automatic placement`
      : `Moved ${label}`);
    const augPins = { ...(prevEdits.augPins ?? {}) };
    if (pt === null) delete augPins[zoneId];
    else augPins[zoneId] = pt;
    set({ layoutEdits: { ...prevEdits, augPins } });
    get().regenerate({ sync: true });
    const rejected = get().design?.warnings.some(w =>
      w.startsWith(rejectPrefix)
    );
    if (rejected) {
      set({ layoutEdits: prevEdits });
      get().regenerate({ sync: true });
      return false;
    }
    get().pushHistory(before);
    return true;
  },

  setIslandAugUnits: (islandN: number, count: number) => {
    if (!Number.isInteger(islandN) || islandN < 1) return;
    // Fixed standard: 0..2 units per island (default 2 when no override).
    // An explicit 0 is KEPT as an override (it disables that island's
    // default zone); an override equal to the default is dropped.
    const clamped = Math.min(MAX_ISLAND_AUG_UNITS, Math.max(0, Math.floor(Number.isFinite(count) ? count : 0)));
    const prevEdits = get().layoutEdits;
    const cur = prevEdits.islandAugUnits?.[islandN] ?? DEFAULT_ISLAND_AUG_UNITS;
    if (clamped === cur) return;
    get().pushHistory(snapOf(get(),
      clamped <= 0
        ? `Disabled augmentation at island ${islandN}`
        : clamped > cur
          ? `Added augmentation unit at island ${islandN}`
          : `Removed augmentation unit at island ${islandN}`,
      `islandAug-${islandN}`));
    const islandAugUnits = { ...(prevEdits.islandAugUnits ?? {}) };
    if (clamped === DEFAULT_ISLAND_AUG_UNITS) delete islandAugUnits[islandN];
    else islandAugUnits[islandN] = clamped;
    const next = { ...prevEdits };
    if (Object.keys(islandAugUnits).length) next.islandAugUnits = islandAugUnits;
    else delete next.islandAugUnits;
    set({ layoutEdits: next });
    get().regenerate();
  },

  setIslandAugEnd: (key: string, end: 'east' | 'west' | null): string | null => {
    if (!/^(\d+|pisl-\d+)$/.test(key)) return 'invalid island key';
    const prevEdits = get().layoutEdits;
    const cur = prevEdits.islandAugEnd?.[key] ?? null;
    if (cur === end) return null;
    const before = snapOf(get(),
      end ? `Moved island ${key} augmentation to the ${end} end` : `Reset island ${key} augmentation end`,
      `islandAugEnd-${key}`);
    const islandAugEnd = { ...(prevEdits.islandAugEnd ?? {}) };
    if (end === null) delete islandAugEnd[key];
    else islandAugEnd[key] = end;
    const next = { ...prevEdits };
    if (Object.keys(islandAugEnd).length) next.islandAugEnd = islandAugEnd;
    else delete next.islandAugEnd;
    set({ layoutEdits: next });
    get().regenerate({ sync: true });
    // Roll back if the choice was rejected: auto islands emit the end-choice
    // prefix; a placed island whose mirrored composition no longer fits is
    // rejected outright — never leave an edit that deletes equipment.
    const w = get().design?.warnings ?? [];
    const bad = key.startsWith('pisl-')
      ? w.find(x => x.startsWith(`Placed island ${key} rejected: `))
      : w.find(x => x.startsWith(`Island ${key} augmentation end choice rejected: `));
    if (bad) {
      set({ layoutEdits: prevEdits });
      get().regenerate({ sync: true });
      return bad.replace(/^[^:]+: /, '').replace(/\s*—\s*(move or remove|remove) it in the layout edits panel\.\s*$/, '').trim();
    }
    get().pushHistory(before);
    return null;
  },

  adjustIslandBlocks: (islandN: number, step: 1 | -1): string | null => {
    if (!Number.isInteger(islandN) || islandN < 1 || (step !== 1 && step !== -1)) return null;
    const prevEdits = get().layoutEdits;
    const before = snapOf(get(),
      step > 0
        ? `Added a PCS block to island ${islandN}`
        : `Removed a PCS block from island ${islandN}`,
      `islandBlocks-${islandN}`);
    const cur = prevEdits.islandBlockDeltas?.[islandN] ?? 0;
    const nextDelta = cur + step;
    const islandBlockDeltas = { ...(prevEdits.islandBlockDeltas ?? {}) };
    if (nextDelta === 0) delete islandBlockDeltas[islandN];
    else islandBlockDeltas[islandN] = nextDelta;
    const next = { ...prevEdits };
    if (Object.keys(islandBlockDeltas).length) next.islandBlockDeltas = islandBlockDeltas;
    else delete next.islandBlockDeltas;
    set({ layoutEdits: next });
    get().regenerate({ sync: true });
    const rejectPrefix = `Island ${islandN} block change rejected:`;
    const rejected = get().design?.warnings.find(w => w.startsWith(rejectPrefix));
    if (rejected) {
      set({ layoutEdits: prevEdits });
      get().regenerate({ sync: true });
      return rejected
        .slice(rejectPrefix.length)
        .replace(/\s*—\s*automatic island layout kept\.\s*$/, '')
        .trim();
    }
    get().pushHistory(before);
    return null;
  },

  setGatePin: (pt: Pt | null): boolean => {
    if (pt !== null && (!Number.isFinite(pt.x) || !Number.isFinite(pt.y))) return false;
    const prevEdits = get().layoutEdits;
    const before = snapOf(get(), pt === null
      ? 'Set entrance gate back to automatic placement'
      : 'Moved entrance gate');
    const next = { ...prevEdits };
    if (pt === null) delete next.gatePin;
    else next.gatePin = pt;
    set({ layoutEdits: next });
    get().regenerate({ sync: true });
    const rejected = get().design?.warnings.some(w => w.startsWith('Pinned gate rejected'));
    if (rejected) {
      set({ layoutEdits: prevEdits });
      get().regenerate({ sync: true });
      return false;
    }
    get().pushHistory(before);
    return true;
  },

  resetLayoutEdits: () => {
    if (Object.keys(get().layoutEdits).length > 0) {
      get().pushHistory(snapOf(get(), 'Reset all layout edits to automatic baseline'));
    }
    set({ layoutEdits: {} });
    get().regenerate();
  },

  // Internal: record the pre-edit snapshot after a successful edit. Every
  // design-changing mutation must route through here with a non-empty label —
  // fail loudly in dev/tests if one doesn't.
  pushHistory: (snap: HistorySnap) => {
    if (!snap.label) throw new Error('History entry recorded without a label');
    const { undoStack, redoStack } = get();
    const top = undoStack[undoStack.length - 1];
    // Coalesce rapid same-control edits: keep the FIRST before-state of the
    // burst (so one undo reverts the whole burst) but show the latest label.
    if (
      snap.coalesceKey &&
      top &&
      top.coalesceKey === snap.coalesceKey &&
      snap.at - top.at < COALESCE_MS &&
      redoStack.length === 0
    ) {
      set({
        undoStack: [...undoStack.slice(0, -1), { ...top, label: snap.label, at: snap.at }],
      });
      return;
    }
    set({
      undoStack: [...undoStack, snap].slice(-HISTORY_LIMIT),
      redoStack: [],
    });
  },

  undoEdit: (): boolean => {
    const s = get();
    if (!s.undoStack.length) return false;
    const snap = s.undoStack[s.undoStack.length - 1];
    // The redo entry reuses the undone action's label so the timeline keeps
    // describing the same action in both directions.
    const cur = snapOf(s, snap.label);
    set({
      undoStack: s.undoStack.slice(0, -1),
      redoStack: [...s.redoStack, cur].slice(-HISTORY_LIMIT),
      ...restoreFields(snap),
    });
    restoreAreaEdits(set, get, snap);
    get().regenerate({ sync: true, suppressAssignmentNotice: true });
    // regenerate() clears feeder assignments when the inverter set changed
    // relative to the transient pre-undo design — the snapshot's assignments
    // are authoritative for the restored design.
    if (get().feederAssignments !== snap.feederAssignments) {
      set({ feederAssignments: snap.feederAssignments });
      get().recomputeFeeders();
    }
    return true;
  },

  redoEdit: (): boolean => {
    const s = get();
    if (!s.redoStack.length) return false;
    const snap = s.redoStack[s.redoStack.length - 1];
    const cur = snapOf(s, snap.label);
    set({
      redoStack: s.redoStack.slice(0, -1),
      undoStack: [...s.undoStack, cur].slice(-HISTORY_LIMIT),
      ...restoreFields(snap),
    });
    restoreAreaEdits(set, get, snap);
    get().regenerate({ sync: true, suppressAssignmentNotice: true });
    if (get().feederAssignments !== snap.feederAssignments) {
      set({ feederAssignments: snap.feederAssignments });
      get().recomputeFeeders();
    }
    return true;
  },

  jumpHistory: (pos: number) => {
    const clamped = Math.max(0, Math.min(pos, get().undoStack.length + get().redoStack.length));
    while (get().undoStack.length > clamped) {
      if (!get().undoEdit()) break;
    }
    while (get().undoStack.length < clamped) {
      if (!get().redoEdit()) break;
    }
  },

  restoreSession: () => {
    const s = get().savedSession;
    if (!s) return;
    // Multi-area session: rebuild every footprint and the active pointer.
    // Absent/single-entry means a single-area session, which restores through
    // the untouched legacy path below.
    const areas = sanitizeSavedSiteAreas(s.siteAreas, s.boundary.origin);
    const restoredAreas = areas.length
      ? {
          siteAreas: areas,
          activeAreaId: areas.some(a => a.id === s.activeAreaId)
            ? s.activeAreaId!
            : (areas.find(a => a.kind === 'bess') ?? areas[0]).id,
        }
      : null;
    // The active area's own saved edits become the mirrored top-level state,
    // so the drafter reopens on the footprint they left, edits intact.
    const activeEdits = restoredAreas
      ? areaEditsToState(areas.find(a => a.id === restoredAreas.activeAreaId)?.edits)
      : null;
    set({
      boundary: s.boundary,
      configId: s.configId,
      targetMW: s.targetMW,
      targetMWh: s.targetMWh,
      hotClimate: s.hotClimate,
      // Pre-field save = a QTY4-era drawing; reopen it as drawn.
      containersPerPcs: s.containersPerPcs ?? LEGACY_CONTAINERS_PER_PCS,
      roadMode: s.roadMode ?? 'auto',
      autoRoadWrap: s.autoRoadWrap ?? true,
      ringMode: s.ringMode ?? 'fence',
      perimeterBand: s.perimeterBand === 'flush' ? 'flush' : 'standard',
      // Anything but the explicit property-line choice reopens inset.
      fencePlacement: s.fencePlacement === 'property-line' ? 'property-line' : 'inset',
      laydownPct: s.laydownPct ?? 0,
      augmentPct: s.augmentPct ?? 0,
      futurePhaseUnits: sanitizeFuturePhaseUnits(s.futurePhaseUnits),
      surfacingMode: s.surfacingMode ?? 'between-roads',
      deadSpaceTrim: s.deadSpaceTrim ?? false,
      surfacingDepthIn: s.surfacingDepthIn ?? SURFACING_DEPTH_IN_DEFAULT,
      dcRouting: s.dcRouting === 'direct' ? 'direct' : 'orthogonal',
      feederRoutingMode: s.feederRoutingMode === 'angled' ? 'angled' : 'orthogonal',
      textureSetId: isYardTextureSetId(s.textureSetId) ? s.textureSetId : DEFAULT_TEXTURE_SET_ID,
      // Sessions that predate the GE Green default load as GE Green;
      // an explicit null is the drafter's saved factory-look choice.
      gePcsColor: s.gePcsColor === undefined ? GE_PCS_GREEN : sanitizePcsColor(s.gePcsColor),
      // Older autosaves predate the toggle — keep the current (per-browser)
      // preference instead of forcing a default.
      showFeederColors: typeof s.showFeederColors === 'boolean' ? s.showFeederColors : get().showFeederColors,
      eciLegend: s.eciLegend === true,
      showFeederNfpaText: s.showFeederNfpaText === true,
      drawingVisibility: sanitizeDrawingVisibilityProfile(s.drawingVisibility),
      arrangement: s.arrangement ?? 'sw',
      arrangementExplicit: s.arrangementExplicit === true,
      latticeShift: finitePt(s.latticeShift) ? s.latticeShift : null,
      gateEdge: s.gateEdge ?? null,
      layoutEdits: sanitizeLayoutEdits(s.layoutEdits),
      titleBlock: { ...defaultTitleBlock(), ...(s.titleBlock ?? {}) },
      lgiaInputs: sanitizeLgiaInputs(s.lgiaInputs),
      substation: sanitizeSubstation(s.substation),
      takeoffs: sanitizeTakeoffs(s.takeoffs) ?? null,
      placingTakeoffId: null,
      feederAssignments: sanitizeFeederAssignments(s.feederAssignments),
      feederSizes: sanitizeFeederSizes(s.feederSizes),
      feederMaterial: s.feederMaterial ?? 'Al',
      maxPcsPerFeeder: sanitizeFeederCap(s.maxPcsPerFeeder),
      yardRotationDeg: sanitizeYardRotation(s.yardRotationDeg),
      gradingZones: sanitizeGradingZones(s.gradingZones),
      areaZones: sanitizeAreaZones(s.areaZones),
      // Energy study travels with the session like gradingZones; absent key
      // (older autosaves / study off) = disabled with documented defaults.
      energySimEnabled: s.energySim?.enabled === true,
      energySimInputs: sanitizeEnergySimInputs(s.energySim?.inputs),
      // History survives autosave/restore within a session.
      undoStack: sanitizeHistory(s.history).undo,
      redoStack: sanitizeHistory(s.history).redo,
      savedSession: null,
      error: null,
      ...restoredAreas,
      // Multi-area only: the mirrored per-area inputs belong to the active
      // footprint, so they win over the legacy top-level copies above.
      ...(activeEdits ?? {}),
    });
    // Imported reference drawing: the geometry is in IndexedDB (too large for
    // the session blob), the saved display state comes from the session. This
    // is an independent async restore (it only sets drawing state, and the
    // layout never reads it), so it is kicked off BEFORE the layout rebuild —
    // the satellite auto-fetch below must stay structurally adjacent to that
    // rebuild, and code wedged in between silently breaks that guarantee.
    const sessionEpoch = ++drawingEpoch;
    void loadDrawing().then(drawing => {
      // Obsolete callback (a rollback/clear/new load took ownership): say
      // nothing — its diagnostics would describe the WRONG site's state.
      if (drawingEpoch !== sessionEpoch) return;
      if (!drawing) {
        // The gated second rebuild below can never run without the drawing —
        // say so loudly instead of leaving stale traced roads rendering as
        // bare strips with a clean console (undiagnosable from a screenshot).
        if (siteHasStaleTracedRoads(get().siteAreas) ||
            tracedRoadsBelowRules(get().layoutEdits.customRoads)) {
          console.warn('[traced-heal] restore: no reference drawing found in browser storage, but this save carries traced roads below rules v' + TRACED_ROAD_RULES_V + ' — gate roads render from the stored records as-is. Re-import the site KMZ to restore the drawing.');
        }
        return;
      }
      set({
        drawing,
        drawingLayerVis: { ...defaultDrawingLayerVis(drawing), ...dropAnnotationVis(s.drawingLayerVis) },
        showDrawing: s.showDrawing !== false,
      });
      // Sheet specs arrive AFTER the layout rebuild below: a stale project
      // saved before traced ratings existed needs one more pass so per-area
      // MW reflects the client's declared nameplate, not the catalog block
      // rating. regenerateAreas applies the ratings in-memory; this second
      // pass is a no-op for projects that already carry them.
      const st = get();
      // Stale traced roads re-derive FROM the drawing too, and the
      // synchronous rebuild below ran before this IndexedDB read resolved —
      // the heal saw no drawing and no-op'd, so a stale save's broken gate
      // records would persist forever without this second pass.
      if ((drawing.sheetSpecs && st.siteAreas.length &&
          st.siteAreas.some(a => a.kind === 'bess' && editsNeedTracedRatings(a.edits?.layoutEdits))) ||
          siteHasStaleTracedRoads(st.siteAreas) ||
          tracedRoadsBelowRules(st.layoutEdits.customRoads)) {
        console.info(`[traced-heal] restore: reference drawing loaded (${drawing.layers.length} layers) — re-running the layout under rules v${TRACED_ROAD_RULES_V}`);
        // Single-area sessions have no siteAreas — their roads live in
        // top-level layoutEdits and regenerateAreas() would be a no-op.
        if (st.siteAreas.length > 1) get().regenerateAreas();
        else get().regenerate();
      }
    });
    // Multi-area sessions lay out every footprint, then mirror the saved
    // active one; single-area sessions take the untouched legacy path.
    if (restoredAreas) get().regenerateAreas();
    else get().regenerate({ suppressAssignmentNotice: true });
    // Same as the KMZ/sample/project-open paths: fetch the aerial drape for
    // the restored site unless the user has opted out.
    if (get().showSatellite) void get().loadSatellite();
    void get().loadTerrain();
  },

  dismissSavedSession: () => {
    set({ savedSession: null });
    try {
      localStorage.removeItem(SESSION_KEY);
    } catch {
      // storage unavailable
    }
  },

  exportProjectJson: (): string | null => {
    const p = projectFromState(get());
    return p ? JSON.stringify(p, null, 2) : null;
  },

  importProject: (jsonText: string): string | null => {
    let parsed: any;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      return 'File is not valid JSON.';
    }
    const err = validateProjectFile(parsed);
    if (err) return err;
    const p = parsed as ProjectFile;
    // Multi-area project: rebuild every footprint plus the active pointer.
    // Absent/single-entry means a single-area file, which loads through the
    // untouched legacy path.
    const areas = sanitizeSavedSiteAreas(p.siteAreas, p.boundary.origin);
    const importedAreas = areas.length
      ? {
          siteAreas: areas,
          activeAreaId: areas.some(a => a.id === p.activeAreaId)
            ? p.activeAreaId!
            : (areas.find(a => a.kind === 'bess') ?? areas[0]).id,
        }
      : null;
    const activeEdits = importedAreas
      ? areaEditsToState(areas.find(a => a.id === importedAreas.activeAreaId)?.edits)
      : null;
    // Transactional: snapshot prior state so a failed regenerate can roll back
    // instead of leaving a half-loaded project.
    const prev = get();
    const prior = {
      boundary: prev.boundary,
      design: prev.design,
      siteAreas: prev.siteAreas,
      activeAreaId: prev.activeAreaId,
      configId: prev.configId,
      targetMW: prev.targetMW,
      targetMWh: prev.targetMWh,
      hotClimate: prev.hotClimate,
      containersPerPcs: prev.containersPerPcs,
      roadMode: prev.roadMode,
      autoRoadWrap: prev.autoRoadWrap,
      ringMode: prev.ringMode,
      perimeterBand: prev.perimeterBand,
      fencePlacement: prev.fencePlacement,
      laydownPct: prev.laydownPct,
      augmentPct: prev.augmentPct,
      futurePhaseUnits: prev.futurePhaseUnits,
      surfacingMode: prev.surfacingMode,
      deadSpaceTrim: prev.deadSpaceTrim,
      surfacingDepthIn: prev.surfacingDepthIn,
      dcRouting: prev.dcRouting,
      feederRoutingMode: prev.feederRoutingMode,
      textureSetId: prev.textureSetId,
      gePcsColor: prev.gePcsColor,
      showFeederColors: prev.showFeederColors,
      eciLegend: prev.eciLegend,
      showFeederNfpaText: prev.showFeederNfpaText,
      drawingVisibility: prev.drawingVisibility,
      arrangement: prev.arrangement,
      arrangementExplicit: prev.arrangementExplicit,
      latticeShift: prev.latticeShift,
      gateEdge: prev.gateEdge,
      layoutEdits: prev.layoutEdits,
      titleBlock: prev.titleBlock,
      lgiaInputs: prev.lgiaInputs,
      substation: prev.substation,
      takeoffs: prev.takeoffs,
      feederAssignments: prev.feederAssignments,
      feederSizes: prev.feederSizes,
      feederMaterial: prev.feederMaterial,
      maxPcsPerFeeder: prev.maxPcsPerFeeder,
      yardRotationDeg: prev.yardRotationDeg,
      gradingZones: prev.gradingZones,
      areaZones: prev.areaZones,
      textOverrides: prev.textOverrides,
      energySimEnabled: prev.energySimEnabled,
      energySimInputs: prev.energySimInputs,
      undoStack: prev.undoStack,
      redoStack: prev.redoStack,
      error: prev.error,
      // Reference-drawing display state rolls back with everything else; the
      // drawing epoch (bumped below) already drops any in-flight load.
      drawing: prev.drawing,
      drawingLayerVis: prev.drawingLayerVis,
      showDrawing: prev.showDrawing,
    };
    bumpSatelliteEpoch();
    set({
      boundary: p.boundary,
      satellite: null,
      satelliteStatus: 'idle',
      satelliteError: null,
      terrain: null,
      terrainStatus: 'idle',
      terrainError: null,
      configId: p.configId,
      targetMW: p.targetMW,
      targetMWh: p.targetMWh,
      hotClimate: p.hotClimate ?? true,
      // Pre-field project file = a QTY4-era drawing; reopen it as drawn.
      containersPerPcs: p.containersPerPcs ?? LEGACY_CONTAINERS_PER_PCS,
      roadMode: p.roadMode ?? 'auto',
      autoRoadWrap: p.autoRoadWrap ?? true,
      ringMode: p.ringMode ?? 'fence',
      perimeterBand: p.perimeterBand === 'flush' ? 'flush' : 'standard',
      // Legacy files have no field ⇒ inset, exactly as they were drawn.
      fencePlacement: p.fencePlacement === 'property-line' ? 'property-line' : 'inset',
      laydownPct: p.laydownPct ?? 0,
      augmentPct: p.augmentPct ?? 0,
      futurePhaseUnits: sanitizeFuturePhaseUnits(p.futurePhaseUnits),
      surfacingMode: p.surfacingMode ?? 'between-roads',
      deadSpaceTrim: p.deadSpaceTrim ?? false,
      surfacingDepthIn: p.surfacingDepthIn ?? SURFACING_DEPTH_IN_DEFAULT,
      dcRouting: p.dcRouting ?? 'orthogonal',
      feederRoutingMode: p.feederRoutingMode === 'angled' ? 'angled' : 'orthogonal',
      textureSetId: isYardTextureSetId(p.textureSetId) ? p.textureSetId : DEFAULT_TEXTURE_SET_ID,
      // Project files that predate the GE Green default load as GE Green;
      // an explicit null is the drafter's saved factory-look choice.
      gePcsColor: p.gePcsColor === undefined ? GE_PCS_GREEN : sanitizePcsColor(p.gePcsColor),
      // Files that predate the toggle keep the drafter's current (per-browser)
      // preference; newer files carry the saved view state with them.
      showFeederColors: typeof p.showFeederColors === 'boolean' ? p.showFeederColors : prev.showFeederColors,
      eciLegend: p.eciLegend === true,
      showFeederNfpaText: p.showFeederNfpaText === true,
      drawingVisibility: sanitizeDrawingVisibilityProfile(p.drawingVisibility),
      arrangement: p.arrangement ?? 'sw',
      arrangementExplicit: p.arrangementExplicit === true,
      latticeShift: finitePt(p.latticeShift) ? p.latticeShift : null,
      gateEdge: p.gateEdge ?? null,
      layoutEdits: sanitizeLayoutEdits(p.layoutEdits),
      titleBlock: { ...defaultTitleBlock(), ...(p.titleBlock ?? {}) },
      lgiaInputs: sanitizeLgiaInputs(p.lgiaInputs),
      substation: sanitizeSubstation(p.substation),
      takeoffs: sanitizeTakeoffs(p.takeoffs) ?? null,
      placingTakeoffId: null,
      feederAssignments: sanitizeFeederAssignments(p.feederAssignments),
      feederSizes: sanitizeFeederSizes(p.feederSizes),
      feederMaterial: p.feederMaterial ?? 'Al',
      maxPcsPerFeeder: sanitizeFeederCap(p.maxPcsPerFeeder),
      yardRotationDeg: sanitizeYardRotation(p.yardRotationDeg),
      gradingZones: sanitizeGradingZones(p.gradingZones),
      areaZones: sanitizeAreaZones(p.areaZones),
      // Energy study travels with the project like gradingZones; absent key
      // (older files / study off) = disabled with documented defaults.
      energySimEnabled: p.energySim?.enabled === true,
      energySimInputs: sanitizeEnergySimInputs(p.energySim?.inputs),
      textOverrides: sanitizeTextOverrides(p.textOverrides),
      undoStack: [],
      redoStack: [],
      savedSession: null,
      error: null,
      // Multi-area file: every footprint plus the active pointer, then the
      // active area's own inputs override the mirrored legacy copies above.
      ...(importedAreas ?? { siteAreas: [], activeAreaId: null }),
      ...(activeEdits ?? {}),
    });
    // Imported reference drawing: geometry lives in IndexedDB (never in the
    // project JSON); the file carries only the display state. A file WITHOUT
    // drawing keys was saved with no drawing — never adopt whatever geometry
    // an earlier site left behind. A file WITH keys reloads it and applies
    // the saved layer choices, mirroring the session-restore path — async,
    // layout never reads it, kicked off BEFORE the rebuild so the
    // regenerate/loadSatellite adjacency stays intact. The epoch drops the
    // async result if a rollback/clear/replace took ownership meanwhile.
    const hasDrawingKeys = p.drawingLayerVis !== undefined || p.showDrawing !== undefined;
    const importEpoch = ++drawingEpoch;
    if (!hasDrawingKeys) {
      // The opened project has no drawing: drop the previous site's from view.
      set({ drawing: null, drawingLayerVis: {}, showDrawing: true });
    } else {
      void loadDrawing().then(drawing => {
        // Obsolete callback: a newer load owns the drawing state now.
        if (drawingEpoch !== importEpoch) return;
        if (!drawing) {
          // Mirror of the restore-path warning: the project file says a
          // drawing exists, but browser storage returned nothing.
          if (siteHasStaleTracedRoads(get().siteAreas) ||
              tracedRoadsBelowRules(get().layoutEdits.customRoads)) {
            console.warn('[traced-heal] import: this project references a drawing that is not in browser storage, and it carries traced roads below rules v' + TRACED_ROAD_RULES_V + ' — gate roads render from the stored records as-is. Re-import the site KMZ to restore the drawing.');
          }
          return;
        }
        set({
          drawing,
          drawingLayerVis: { ...defaultDrawingLayerVis(drawing), ...dropAnnotationVis(p.drawingLayerVis) },
          showDrawing: p.showDrawing !== false,
        });
        // Same stale-project heal as the session-restore path: sheet specs
        // land after the rebuild, so a project saved before traced ratings
        // needs one more regenerate to read its declared nameplate MW. Stale
        // traced roads need it too — the rebuild above ran before this
        // IndexedDB read resolved, so their re-derivation no-op'd.
        const st = get();
        if ((drawing.sheetSpecs && st.siteAreas.length &&
            st.siteAreas.some(a => a.kind === 'bess' && editsNeedTracedRatings(a.edits?.layoutEdits))) ||
            siteHasStaleTracedRoads(st.siteAreas) ||
            tracedRoadsBelowRules(st.layoutEdits.customRoads)) {
          console.info(`[traced-heal] import: reference drawing loaded (${drawing.layers.length} layers) — re-running the layout under rules v${TRACED_ROAD_RULES_V}`);
          // Single-area projects keep roads in top-level layoutEdits;
          // regenerateAreas() without siteAreas would heal nothing.
          if (st.siteAreas.length > 1) get().regenerateAreas();
          else get().regenerate();
        }
      });
    }
    // Multi-area projects lay out every footprint (each with its own saved
    // edits); single-area files take the untouched legacy path.
    if (importedAreas) get().regenerateAreas();
    else get().regenerate({ sync: true, suppressAssignmentNotice: true });
    const failure = get().error;
    if (failure || !get().design) {
      set(prior);
      return `Project could not be loaded: ${failure ?? 'the design could not be generated from the saved settings.'}`;
    }
    // A carried view preference becomes the drafter's new per-browser
    // preference (mirrors what toggling it in the UI would do).
    if (typeof p.showFeederColors === 'boolean') {
      try {
        localStorage.setItem('nextera-feeder-colors', String(p.showFeederColors));
      } catch {
        // storage unavailable; preference just won't persist
      }
    }
    // Same as the KMZ/sample load paths: fetch the aerial drape for the
    // restored site unless the user has opted out.
    if (get().showSatellite) void get().loadSatellite();
    void get().loadTerrain();
    return null;
  },

  clearSite: () => {
    // Invalidate any in-flight async regenerate so a stale worker result
    // can't rehydrate the design after the site was cleared.
    ++regenToken;
    cancelChannel('generate');
    bumpSatelliteEpoch();
    // Delete the stored reference-drawing geometry too, or a later session
    // restore would resurrect the cleared site's drawing under a new site.
    // The epoch bump drops any in-flight load; the delete itself is FIFO
    // ordered against a following Replace capture in the drawing store.
    ++drawingEpoch;
    void saveDrawing(null);
    set({
      computing: false,
      boundary: null,
      design: null,
      // Multi-area state is site-specific — never carry footprints from the
      // cleared site into whatever gets loaded next.
      siteAreas: [],
      activeAreaId: null,
      // The imported reference drawing belongs to the cleared site too
      // (the IndexedDB record is deleted below so a session restore can't
      // resurrect another site's drawing).
      drawing: null,
      drawingLayerVis: {},
      showDrawing: true,
      error: null,
      // Presentation modes latch UI state; never carry them across sites.
      walkMode: false,
      tourActive: false,
      tourRecord: false,
      tourSeek: null,
      tourPhase: null,
      tourGrounding: false,
      tourDcSwap: 0,
      tourFade: 0,
      tourCaption: null,
      tourStatAlpha: 0,
      tourStatCard: null,
      tourGhostAlpha: 0,
      tourGhosts: null,
      tourIntroT: 0,
      tourIntroInfo: null,
      satellite: null,
      satelliteStatus: 'idle',
      satelliteError: null,
      terrain: null,
      terrainStatus: 'idle',
      terrainError: null,
      arrangement: 'sw',
      arrangementExplicit: false,
      latticeShift: null,
      gateEdge: null,
      layoutEdits: {},
      yardRotationDeg: 0,
      // Zones are site-specific engineering inputs — never carry them into
      // whatever site gets loaded next.
      gradingZones: [],
      areaZones: [],
      textOverrides: {},
      // Same for the energy study: contract MWh / ambient are per-project.
      energySimEnabled: false,
      energySimInputs: { ...DEFAULT_ENERGY_SIM_INPUTS },
      undoStack: [],
      redoStack: [],
      substation: null,
      placingSubstation: false,
      takeoffs: null,
      placingTakeoffId: null,
      feeders: [],
      // Derived per-area routes are site-specific: carrying them into the
      // next site would score a fresh project against another site's trenches.
      areaFeeders: {},
      feederEndpoint: null,
      feederAssignments: {},
      feederResetNotice: null,
      gradingZonesResetNotice: null,
      feederSizes: {},
      hiddenFeeders: new Set<number>(),
      // Project-specific LGIA nameplate/settings data must not survive into
      // whatever site gets loaded next (see applyBoundary).
      lgiaInputs: { ...DEFAULT_LGIA_INPUTS },
    });
  },

  setPlacingSubstation: (on: boolean) => set({ placingSubstation: on }),

  placeSubstation: (pt: Pt) => {
    // A non-finite coordinate (NaN/Infinity from a bad caller computation)
    // would propagate NaN through every feeder route and into scene
    // geometry (NaN bounding spheres, duplicate "eNaN" React keys) — reject
    // it outright instead of storing it.
    if (!pt || !Number.isFinite(pt.x) || !Number.isFinite(pt.y)) {
      return 'Substation position rejected — coordinates must be finite numbers.';
    }
    get().pushHistory(snapOf(get(), get().substation === null ? 'Placed substation' : 'Moved substation'));
    // A pinned feeder corridor is defined relative to the substation approach:
    // its number is a y (east/west approach) or an x (north/south approach).
    // Moving the substation can flip the approach axis or push the old pin
    // outside the routing area — in either case the stale pin is meaningless,
    // so drop it (back to automatic) rather than silently reinterpreting it.
    const { design, substation: prevSub, layoutEdits } = get();
    let edits = layoutEdits;
    let notice: string | null = null;
    const pin = layoutEdits.feederCorridor;
    if (pin != null && design) {
      const maxPer = get().maxPcsPerFeeder;
      const prevInfo = prevSub ? feederCorridorInfo(design, prevSub, maxPer) : null;
      const nextInfo = feederCorridorInfo(design, pt, maxPer);
      const axisFlipped = !!prevInfo && !!nextInfo && prevInfo.horiz !== nextInfo.horiz;
      if (axisFlipped) {
        edits = { ...layoutEdits };
        delete edits.feederCorridor;
        notice =
          'Pinned feeder corridor reset to automatic — the substation now approaches from a different side, so the old pin no longer applies.';
      } else if (feederCorridorRejectReason(design, pt, pin, get().maxPcsPerFeeder) !== null) {
        edits = { ...layoutEdits };
        delete edits.feederCorridor;
        notice =
          'Pinned feeder corridor reset to automatic — the pin falls outside the valid routing range from the new substation position.';
      }
    }
    set({ substation: pt, placingSubstation: false, layoutEdits: edits });
    // Island FJB placement is substation-aware (the box sits at the strip
    // end FACING the substation so feeders never wrap around the yard). If
    // the new substation position flips the preferred end for any island,
    // the layout must regenerate to move the box; otherwise a cheap feeder
    // recompute suffices.
    const dNow = get().design;
    const needsRegen = !!dNow?.islands?.some(isl => {
      const fjb = dNow.equipment.find(e => e.id === `fjb-${isl.n}`);
      if (!fjb) return false;
      const center = (isl.minX + isl.maxX) / 2;
      const prefDir = pt.x < center ? -1 : 1;
      const actualDir = fjb.x < center ? -1 : 1;
      return prefDir !== actualDir;
    });
    const multiArea = get().siteAreas.length >= 2;
    if (needsRegen) {
      // The follow-up per-area route must run AFTER the regenerated FJB side
      // is committed. Force this branch synchronous; otherwise a worker apply
      // can arrive later and overwrite the just-routed active-area mirror.
      get().regenerate({ sync: true });
      // regenerateAreas performs an initial route, but regenerate's apply()
      // subsequently mirrors the active yard through the single-area apply
      // path. Always finish a multi-area move through the authoritative
      // per-area router so regenerated and cheap-reroute branches receive the
      // same equipment, healed gates, exclusion zones and foreign fences.
      if (multiArea) get().recomputeAllAreaFeeders();
    }
    // Multi-area sites route feeders per area (take-offs or the area's own
    // substation) — a plain recomputeFeeders would ignore the point just
    // placed and the drop would visibly do nothing.
    else if (multiArea) get().recomputeAllAreaFeeders();
    else get().recomputeFeeders();
    return notice;
  },

  removeSubstation: () => {
    if (get().substation !== null) {
      get().pushHistory(snapOf(get(), 'Removed substation'));
    }
    // The corridor pin has no meaning without a substation; keeping it would
    // surprise the drafter when a future substation lands on a different side.
    const hadPin = get().layoutEdits.feederCorridor != null;
    const edits = { ...get().layoutEdits };
    delete edits.feederCorridor;
    // The aux feeder circuit originates at the substation — it goes with it.
    const design = get().design;
    if (design) design.auxFeeder = null;
    set({ substation: null, placingSubstation: false, feeders: [], feederEndpoint: null, feederAssignments: {}, hiddenFeeders: new Set<number>(), layoutEdits: edits, design: design ? { ...design } : design });
    return hadPin
      ? 'Pinned feeder corridor reset to automatic — the pin has no meaning without a substation.'
      : null;
  },

  // --- Substation MV take-offs (multi-area) --------------------------------
  //
  // Every mutator below follows the same policy as the rest of the drafter's
  // edits: validate first, and on failure return a stable-prefixed reason and
  // change NOTHING, so an invalid drag never drops routes that were already
  // good. A successful edit commits the list to the active area and re-lays
  // every area's feeders (a take-off move changes where another area's home
  // runs land).
  setPlacingTakeoff: (id: string | null) => set({ placingTakeoffId: id }),

  addTakeoff: (servesAreaId: string | null): string | null => {
    const s = get();
    const area = s.siteAreas.find(a => a.id === s.activeAreaId);
    if (!area || area.kind !== 'substation') {
      return `${TAKEOFF_REJECT_PREFIX} only a substation area can hold take-offs.`;
    }
    const current = takeoffsOf(s);
    // Seed position: the yard center, nudged clear of the take-offs already
    // there. Never invent a point outside the fence — if nothing valid is
    // found the add is refused with a reason rather than placed illegally.
    const fence = s.design?.fence;
    if (!fence || fence.length < 3) {
      return `${TAKEOFF_REJECT_PREFIX} the substation area has no fenced yard to hold a take-off.`;
    }
    const xs = fence.map(p => p.x), ys = fence.map(p => p.y);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    let seed: Pt | null = null;
    for (let step = 0; step <= 12 && !seed; step++) {
      for (const cand of [
        { x: cx + step * TAKEOFF_MIN_SPACING_FT, y: cy },
        { x: cx - step * TAKEOFF_MIN_SPACING_FT, y: cy },
        { x: cx, y: cy + step * TAKEOFF_MIN_SPACING_FT },
        { x: cx, y: cy - step * TAKEOFF_MIN_SPACING_FT },
      ]) {
        if (takeoffRejectReason(s.design, cand, current) === null) { seed = cand; break; }
      }
    }
    if (!seed) {
      return `${TAKEOFF_REJECT_PREFIX} the substation yard has no clear room for another take-off.`;
    }
    // Aim: toward the served area if one was named, so a fresh take-off is
    // immediately sensible; otherwise the default east.
    const served = servesAreaId ? s.siteAreas.find(a => a.id === servesAreaId) : undefined;
    let dir: TakeoffDirection = 'E';
    if (served) {
      const sxs = served.boundary.polygon.map(p => p.x);
      const sys = served.boundary.polygon.map(p => p.y);
      dir = snapTakeoffDirection(
        seed.x - (Math.min(...sxs) + Math.max(...sxs)) / 2,
        seed.y - (Math.min(...sys) + Math.max(...sys)) / 2);
    }
    get().pushHistory(snapOf(s, 'Added substation take-off'));
    const id = `takeoff-${s.activeAreaId}-${nextTakeoffSeq(current)}`;
    commitTakeoffs(set, get, [...current, { id, x: seed.x, y: seed.y, dir, servesAreaId: servesAreaId ?? null }]);
    return null;
  },

  moveTakeoff: (id: string, pt: Pt): string | null => {
    const s = get();
    const current = takeoffsOf(s);
    const target = current.find(t => t.id === id);
    if (!target) return `${TAKEOFF_REJECT_PREFIX} that take-off no longer exists.`;
    const why = takeoffRejectReason(s.design, pt, current.filter(t => t.id !== id));
    if (why) return `${TAKEOFF_REJECT_PREFIX} ${why}.`;
    get().pushHistory(snapOf(s, 'Moved substation take-off'));
    commitTakeoffs(set, get,
      current.map(t => (t.id === id ? { ...t, x: pt.x, y: pt.y } : t)),
      { placingTakeoffId: null });
    return null;
  },

  aimTakeoff: (id: string, dir: TakeoffDirection): string | null => {
    const s = get();
    const current = takeoffsOf(s);
    if (!current.some(t => t.id === id)) return `${TAKEOFF_REJECT_PREFIX} that take-off no longer exists.`;
    if (!TAKEOFF_DIRECTIONS.includes(dir)) return `${TAKEOFF_REJECT_PREFIX} "${dir}" is not a compass direction.`;
    get().pushHistory(snapOf(s, `Aimed substation take-off ${dir}`));
    commitTakeoffs(set, get, current.map(t => (t.id === id ? { ...t, dir } : t)));
    return null;
  },

  setTakeoffServes: (id: string, servesAreaId: string | null): string | null => {
    const s = get();
    const current = takeoffsOf(s);
    if (!current.some(t => t.id === id)) return `${TAKEOFF_REJECT_PREFIX} that take-off no longer exists.`;
    if (servesAreaId && !s.siteAreas.some(a => a.id === servesAreaId && a.kind === 'bess')) {
      return `${TAKEOFF_REJECT_PREFIX} a take-off can only collect a BESS area.`;
    }
    get().pushHistory(snapOf(s, 'Re-assigned substation take-off'));
    commitTakeoffs(set, get, current.map(t => (t.id === id ? { ...t, servesAreaId } : t)));
    return null;
  },

  removeTakeoff: (id: string): string | null => {
    const s = get();
    const current = takeoffsOf(s);
    if (!current.some(t => t.id === id)) return `${TAKEOFF_REJECT_PREFIX} that take-off no longer exists.`;
    get().pushHistory(snapOf(s, 'Removed substation take-off'));
    commitTakeoffs(set, get, current.filter(t => t.id !== id), { placingTakeoffId: null });
    return null;
  },

  setFeederSize: (feederIdx: number, size: FeederConductorSize) => {
    if (!(FEEDER_CONDUCTOR_SIZES as readonly string[]).includes(size)) return;
    if (get().feederSizes[feederIdx] === size) return;
    const fdrName = feederDisplayName({ idx: feederIdx, name: get().feeders.find(f => f.idx === feederIdx)?.name });
    get().pushHistory(snapOf(get(), `Set feeder #${fdrName} conductor to ${size} kcmil`, `feederSize-${feederIdx}`));
    set({ feederSizes: { ...get().feederSizes, [feederIdx]: size } });
    get().recomputeFeeders();
  },

  setFeederMaterial: (m: ConductorMaterial) => {
    if (m === get().feederMaterial) return;
    get().pushHistory(snapOf(get(), `Set feeder conductor material to ${m === 'Al' ? 'aluminum' : 'copper'}`));
    set({ feederMaterial: m });
    get().recomputeFeeders();
  },

  // Returns false (and leaves state unchanged) if the target feeder is full
  assignInverterToFeeder: (invId: string, feederIdx: number): boolean => {
    const { feeders } = get();
    const target = feeders.find(f => f.idx === feederIdx);
    if (target && target.inverterIds.length >= get().maxPcsPerFeeder && !target.inverterIds.includes(invId)) {
      return false;
    }
    // Snapshot current membership so unrelated inverters stay put
    const assignments: Record<string, number> = {};
    for (const f of feeders) for (const id of f.inverterIds) assignments[id] = f.idx;
    assignments[invId] = feederIdx;
    get().pushHistory(snapOf(get(), `Moved ${invId.replace('inv-', 'INV ')} to feeder ${feederIdx}`));
    set({ feederAssignments: assignments });
    get().recomputeFeeders();
    return true;
  },

  resetFeederOverrides: () => {
    if (Object.keys(get().feederAssignments).length > 0) {
      get().pushHistory(snapOf(get(), 'Reset feeder grouping to automatic'));
    }
    set({ feederAssignments: {} });
    get().recomputeFeeders();
  },

  resetFeederSizes: () => {
    if (Object.keys(get().feederSizes).length > 0) {
      get().pushHistory(snapOf(get(), 'Reset conductor sizes to automatic'));
    }
    set({ feederSizes: {} });
    get().recomputeFeeders();
  },

  recomputeFeeders: () => {
    const { design, substation, configId, feederAssignments, feederSizes, feederMaterial, maxPcsPerFeeder } = get();
    // Any feeder recompute (regenerate, import, regrouping, rerouting) can
    // renumber circuits, so the display-only hidden set is always cleared —
    // stale indices must never silently hide a different feeder.
    const hiddenFeeders = get().hiddenFeeders.size ? new Set<number>() : get().hiddenFeeders;
    const s = get();
    // Multi-area: this area's feeders land on the take-off aimed at it, and
    // must dodge every OTHER area's fence. Single-area projects resolve to
    // nothing here and route exactly as before.
    //
    // Resolved BEFORE the no-endpoint guard below. On a multi-area site a
    // BESS area has NO legacy local `substation` — its endpoint lives in the
    // substation yard — so bailing on `!substation` first would clear the
    // area's routes every time it became active or the drafter touched a
    // feeder control.
    const areas = s.siteAreas;
    const resolved = areas.length >= 2 && s.activeAreaId
      ? resolveTakeoffs(commitActiveAreaEdits(s)).get(s.activeAreaId)
      : undefined;
    // The endpoint every circuit lands on: this area's assigned take-off, or
    // the legacy single-area substation. Routes are cleared only when there
    // is genuinely nowhere to route TO.
    const endpoint = resolved?.takeoff ?? substation;
    if (!design || !endpoint) {
      if (design) {
        // No feeders: fall back to the deterministic provisional grouping.
        applyReferenceLabels(design.equipment, null, design.islands);
        design.auxFeeder = null;
        set({ feeders: [], design: { ...design }, hiddenFeeders, feederEndpoint: null });
      } else {
        set({ feeders: [], hiddenFeeders, feederEndpoint: null });
      }
      return;
    }
    const feeders = routeFeedersInto(design, endpoint, {
      configId,
      layoutEdits: s.layoutEdits,
      // Same render-time heal the regenerate path runs: a stale save's stored
      // records can lack entrance/apron flags entirely, and the gate keep-outs
      // must not vanish with them. No-op (same array) on current saves.
      customRoads: s.layoutEdits.customRoads?.some(r => r.traced === true)
        ? healTracedRoadConstraints(
            s.layoutEdits.customRoads,
            s.activeAreaId ?? '',
            design.fence ?? [],
            s.siteAreas,
            s.drawing,
            'active yard',
            {
              designFence: design.fence ?? null,
              fencePlacement: s.fencePlacement,
              removedTraced: s.layoutEdits.removedTracedRoads,
            })
        : null,
      feederAssignments,
      feederSizes,
      feederMaterial,
      maxPcsPerFeeder,
      feederRoutingMode: s.feederRoutingMode,
      areaZones: s.areaZones,
      approach: resolved?.takeoff.dir ?? null,
      foreignFences: resolved
        ? foreignFences(areas, s.activeAreaId!, resolved.substationAreaId)
        : null,
    });
    set({
      feeders,
      design: { ...design },
      hiddenFeeders,
      feederEndpoint: endpoint,
      // Keep the per-area map in step with the active area's live routes, so
      // compliance/permit consumers never mix a stale copy with a fresh one.
      ...(areas.length >= 2 && s.activeAreaId
        ? { areaFeeders: { ...s.areaFeeders, [s.activeAreaId]: feeders } }
        : {}),
    });
  },

  // Re-route EVERY area's feeders onto its resolved take-off. A take-off edit
  // belongs to the substation area but decides where a different area's home
  // runs land, so recomputing only the active area would leave the served
  // yard drawing routes to a position that no longer exists.
  //
  // Areas are routed on their own designs; the active area's live mirrored
  // design is used for it (it carries in-flight edits) and written back.
  recomputeAllAreaFeeders: () => {
    const s = get();
    if (s.siteAreas.length < 2) { get().recomputeFeeders(); return; }
    const areas = commitActiveAreaEdits(s);
    const resolved = resolveTakeoffs(areas);
    const nextFeeders: Record<string, FeederCircuit[]> = {};
    const nextAreas = areas.map(area => {
      // Only BESS yards carry MV feeders; a substation area receives them.
      if (area.kind !== 'bess' || !area.design) return area;
      const ed = area.edits ?? {};
      const tracedFenceStandard = isTracedBessYard(ed.layoutEdits);
      const healingFence = tracedFenceStandard
        ? fencePolygonForLayout(area.boundary.polygon, ed.layoutEdits, s.fencePlacement)
        : (area.design.fence?.length
            ? area.design.fence
            : fencePolygonFor(area.boundary.polygon, s.fencePlacement));
      // An area's OWN placed substation wins over a take-off (same precedence
      // as areaFeederEndpoint, so exports and live routing never disagree).
      const own = ed.substation ?? null;
      const resolvedTarget = resolved.get(area.id);
      const endpoint: Pt | null = own ?? resolvedTarget?.takeoff ?? null;
      const target = endpoint
        ? {
            endpoint,
            approach: own ? null : (resolvedTarget?.takeoff.dir ?? null),
            substationAreaId: own ? area.id : resolvedTarget!.substationAreaId,
          }
        : null;
      // No take-off aimed at this area: it has nowhere to route TO. Its
      // feeders are cleared rather than aimed at a guessed point, and
      // takeoffWarnings tells the drafter why (see applyTakeoffWarnings).
      if (!target) {
        const design = { ...area.design, auxFeeder: null };
        applyReferenceLabels(design.equipment, null, design.islands);
        nextFeeders[area.id] = [];
        return { ...area, design };
      }
      const design = { ...area.design };
      nextFeeders[area.id] = routeFeedersInto(design, target.endpoint, {
        configId: s.configId,
        // Every routing input is the AREA'S OWN — borrowing the active
        // area's would route each yard under another yard's overrides.
        layoutEdits: ed.layoutEdits ?? {},
        // Same render-time heal the regenerate path runs (see recomputeFeeders):
        // stale-save records can lack entrance/apron flags, and the gate
        // keep-outs must not vanish with them.
        customRoads: ed.layoutEdits?.customRoads?.some(r => r.traced === true)
          ? healTracedRoadConstraints(
              ed.layoutEdits.customRoads,
              area.id,
              healingFence,
              s.siteAreas,
              s.drawing,
              area.name,
              {
                designFence: healingFence,
                fencePlacement: tracedFenceStandard ? 'property-line' : s.fencePlacement,
                removedTraced: ed.layoutEdits.removedTracedRoads,
              })
          : null,
        feederAssignments: ed.feederAssignments ?? {},
        feederSizes: s.feederSizes,
        feederMaterial: s.feederMaterial,
        maxPcsPerFeeder: s.maxPcsPerFeeder,
        feederRoutingMode: s.feederRoutingMode,
        areaZones: ed.areaZones ?? [],
        approach: target.approach,
        foreignFences: foreignFences(areas, area.id, target.substationAreaId),
      });
      return { ...area, design };
    });
    const active = nextAreas.find(a => a.id === s.activeAreaId);
    // Re-routing renumbers circuits, so the display-only hidden set is
    // cleared (a stale index would hide a different feeder). Computed as a
    // local: the hidden set is session-ephemeral and never read out of a
    // snapshot object.
    const hiddenFeeders = s.hiddenFeeders.size ? new Set<number>() : s.hiddenFeeders;
    set({
      siteAreas: nextAreas,
      areaFeeders: nextFeeders,
      // The active area's mirrored copies must follow, or the scene keeps
      // drawing the pre-edit routes.
      ...(active?.design ? { design: active.design } : {}),
      feeders: s.activeAreaId ? (nextFeeders[s.activeAreaId] ?? []) : [],
      hiddenFeeders,
      // The active area's landing point, so the scene can draw its routes
      // without a legacy local substation. An area's own placed substation
      // wins over a take-off, matching the routing precedence above.
      feederEndpoint: s.activeAreaId
        ? ((nextAreas.find(a => a.id === s.activeAreaId)?.edits?.substation)
            ?? resolved.get(s.activeAreaId)?.takeoff ?? null)
        : null,
    });
    applyTakeoffWarnings(set, get);
  },

  // Export-time routing-gate audit. Multi-area exports draw NON-ACTIVE
  // yards from their stored designs + areaFeeders, so the export-time gate
  // re-run must reach every one of them — auditing only the active design
  // would let a violation in an included inactive area ship silently. Each
  // area's inputs resolve exactly like recomputeAllAreaFeeders: its own
  // stored design, its own routed circuits, the same landing-point
  // precedence (own placed substation over take-off) and its own exclusion
  // zones. All areas are audited (a superset of any export selection, and
  // of the permit packet's all-areas scope), and each design's gate warning
  // batch is refreshed so the warnings list always shows the batch the
  // export saw. Pure verification — routes never change.
  auditRoutingGatesForExport: () => {
    const s = get();
    const exclusions = (z?: DesignState['areaZones'] | null) =>
      (z ?? []).filter(zone => zone.kind === 'exclusion');
    // Identity-preserving refresh (same convention as applyTakeoffWarnings):
    // an audit that changes nothing must not churn design identity, or every
    // export click would dirty the autosave for free.
    const refresh = <D extends { warnings: string[] }>(design: D, results: RoutingGateResult[]): D => {
      const next = design.warnings
        .filter(w => !w.startsWith(ROUTING_GATE_PREFIX))
        .concat(results.map(r => r.message));
      if (next.length === design.warnings.length &&
          next.every((w, i) => w === design.warnings[i])) return design;
      return { ...design, warnings: next };
    };
    if (s.siteAreas.length < 2) {
      if (!s.design) return [];
      const results = runRoutingGates(s.design, {
        feeders: s.feeders,
        substation: s.substation,
        exclusionZones: exclusions(s.areaZones),
        maxPerFeeder: s.maxPcsPerFeeder,
      });
      const refreshed = refresh(s.design, results);
      if (refreshed !== s.design) set({ design: refreshed });
      // Single-area findings still need an authentic area label: the export
      // toast and audit metadata must never degrade to an unlabeled/null yard.
      const areaLabel = s.boundary?.name || 'SITE';
      return [{ area: areaLabel, results }];
    }
    const areas = commitActiveAreaEdits(s);
    const resolved = resolveTakeoffs(areas);
    const out: Array<{ area: string | null; results: RoutingGateResult[] }> = [];
    const nextAreas = areas.map(area => {
      if (area.kind !== 'bess' || !area.design) return area;
      const ed = area.edits ?? {};
      // Same landing-point precedence as recomputeAllAreaFeeders.
      const endpoint = ed.substation ?? resolved.get(area.id)?.takeoff ?? null;
      // An unrouted area (no take-off aimed at it) has no routing to audit —
      // its feeders were cleared and takeoffWarnings already reports why.
      if (!endpoint) return area;
      const results = runRoutingGates(area.design, {
        feeders: s.areaFeeders[area.id] ?? [],
        substation: endpoint,
        exclusionZones: exclusions(ed.areaZones),
        maxPerFeeder: s.maxPcsPerFeeder,
      });
      out.push({ area: area.name, results });
      const refreshed = refresh(area.design, results);
      return refreshed === area.design ? area : { ...area, design: refreshed };
    });
    // Write back only when a batch actually changed; a no-change audit
    // leaves the store exactly as it found it (active edits included).
    if (nextAreas.some((a, i) => a !== areas[i])) {
      const active = nextAreas.find(a => a.id === s.activeAreaId);
      set({
        siteAreas: nextAreas,
        // The active area's mirrored copy must follow, or the warnings
        // panel keeps showing the pre-audit batch.
        ...(active?.design ? { design: active.design } : {}),
      });
    }
    return out;
  },
}));

const hasOpenLegacyKmzFence = (s: DesignState): boolean => {
  if (s.siteAreas.length > 1) {
    return s.siteAreas.some(area => {
      if (area.kind !== 'bess') return false;
      const edits = area.id === s.activeAreaId
        ? s.layoutEdits
        : area.edits?.layoutEdits;
      if (!isTracedBessYard(edits)) return false;
      const designs = area.id === s.activeAreaId
        ? [s.design, area.design]
        : [area.design];
      return designs.some(d => d !== null && d.propertyLineFence !== true);
    });
  }
  return s.design !== null &&
    s.design.propertyLineFence !== true &&
    isTracedBessYard(s.layoutEdits);
};
/**
 * Refresh the site-level take-off coverage warnings on the ACTIVE design.
 *
 * These are reported per site, not per area (an unaimed BESS yard is a site
 * problem), so they are stripped and re-added on every recompute by their
 * stable markers — never accumulated.
 */
const applyTakeoffWarnings = (
  set: (partial: Partial<DesignState>) => void,
  get: () => DesignState
): void => {
  const s = get();
  const design = s.design;
  if (!design) return;
  const stripped = design.warnings.filter(
    w => !TAKEOFF_WARNING_MARKERS.some(m => w.includes(m)));
  const next = s.siteAreas.length >= 2
    ? stripped.concat(takeoffWarnings(commitActiveAreaEdits(s)))
    : stripped;
  if (next.length === design.warnings.length &&
      next.every((w, i) => w === design.warnings[i])) return;
  set({ design: { ...design, warnings: next } });
};

// ---------------------------------------------------------------------------
// Session autosave: debounce-write the drafter's session to localStorage on
// every relevant change so a refresh or crash never loses their work.
// Restoring is always explicit (savedSession banner) — never automatic.
let saveTimer: ReturnType<typeof setTimeout> | null = null;
useDesignStore.subscribe((state, prev) => {
  if (
    state.boundary === prev.boundary &&
    state.configId === prev.configId &&
    state.targetMW === prev.targetMW &&
    state.targetMWh === prev.targetMWh &&
    state.hotClimate === prev.hotClimate &&
    state.containersPerPcs === prev.containersPerPcs &&
    state.roadMode === prev.roadMode &&
    state.autoRoadWrap === prev.autoRoadWrap &&
    state.ringMode === prev.ringMode &&
    // Perimeter band (standard vs flush-to-fence) is a saved design input:
    // omitting it here silently dropped a flush-only change from the session,
    // so a reload rebuilt the yard with the 10 ft inset ring the drafter had
    // explicitly turned off.
    state.perimeterBand === prev.perimeterBand &&
    // Fence placement (inset vs on the property line) is a saved design
    // input: leaving it out here would drop a property-line choice from the
    // session, so a reload would silently rebuild the yard inside the setback.
    state.fencePlacement === prev.fencePlacement &&
    state.laydownPct === prev.laydownPct &&
    state.augmentPct === prev.augmentPct &&
    state.futurePhaseUnits === prev.futurePhaseUnits &&
    state.surfacingMode === prev.surfacingMode &&
    state.deadSpaceTrim === prev.deadSpaceTrim &&
    state.surfacingDepthIn === prev.surfacingDepthIn &&
    state.dcRouting === prev.dcRouting &&
    state.feederRoutingMode === prev.feederRoutingMode &&
    state.textureSetId === prev.textureSetId &&
    state.gePcsColor === prev.gePcsColor &&
    state.showFeederColors === prev.showFeederColors &&
    state.eciLegend === prev.eciLegend &&
    state.showFeederNfpaText === prev.showFeederNfpaText &&
    drawingVisibilityEquals(state.drawingVisibility, prev.drawingVisibility) &&
    state.arrangement === prev.arrangement &&
    state.arrangementExplicit === prev.arrangementExplicit &&
    state.latticeShift === prev.latticeShift &&
    state.gateEdge === prev.gateEdge &&
    state.layoutEdits === prev.layoutEdits &&
    // Imported reference drawing display state: unchecking a KMZ layer must
    // persist like any other project setting (geometry itself is IndexedDB).
    state.drawingLayerVis === prev.drawingLayerVis &&
    state.showDrawing === prev.showDrawing &&
    state.titleBlock === prev.titleBlock &&
    state.lgiaInputs === prev.lgiaInputs &&
    state.substation === prev.substation &&
    state.feederAssignments === prev.feederAssignments &&
    state.feederSizes === prev.feederSizes &&
    state.feederMaterial === prev.feederMaterial &&
    state.maxPcsPerFeeder === prev.maxPcsPerFeeder &&
    state.areaZones === prev.areaZones &&
    // Multi-area sites: adding, laying out or switching a footprint changes
    // what must be saved even when every mirrored field above is untouched.
    state.siteAreas === prev.siteAreas &&
    state.activeAreaId === prev.activeAreaId
  ) {
    return;
  }
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const st = useDesignStore.getState();
      const p = projectFromState(st);
      // Session autosave carries the undo/redo timeline so history survives a
      // restore within a session (exported project files never include it).
      if (p) localStorage.setItem(SESSION_KEY, JSON.stringify({ ...p, history: { undo: st.undoStack, redo: st.redoStack } }));
    } catch {
      // storage unavailable or quota exceeded; autosave just skips
    }
  }, 400);
});

const scheduleLegacyKmzFenceRepair = (state: DesignState): void => {
  if (legacyKmzFenceRepairQueued || !hasOpenLegacyKmzFence(state)) return;
  legacyKmzFenceRepairQueued = true;
  queueMicrotask(() => {
    try {
      const current = useDesignStore.getState();
      if (!hasOpenLegacyKmzFence(current)) return;
      current.regenerate({ sync: true, suppressAssignmentNotice: true });
    } finally {
      legacyKmzFenceRepairQueued = false;
    }
  });
};

let legacyKmzFenceRepairQueued = false;
