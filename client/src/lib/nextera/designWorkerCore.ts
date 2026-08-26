// Pure request/response core shared by the design web worker and Node tests.
// Every request is plain structured-clonable data (configs travel as ids and
// are rehydrated from the catalog), and every handler is a pure function of
// its request — so the worker path is byte-identical to the main-thread path
// by construction, and the test suite can exercise it without a browser.
import { SiteBoundary, SiteDesign, Pt } from './types';
import { getConfiguration, getEffectiveConfiguration } from './catalog';
import { generateSiteDesign, LayoutOptions } from './layoutEngine';
import { buildDesignDxfString, TitleBlockMeta, TextOverride } from './dxfExport';
import { buildDxfPackage, PackageSheet } from './dxfSheets';
import { buildSiteDxfString, siteCompositionApplies } from './siteCompose';
import { optimizeSteps, OptimizeResult, OptimizeBaseOptions } from './optimizer';
import { scenarioSteps, ScenarioResult } from './scenarios';
import { gradingSteps, GradingResult, GradingObjective } from './gradingOptimizer';
import {
  optimizeFeederRoutingSteps,
  FeederRoutingResult,
  FeederRoutingParams,
  FeederRoutingBaseOptions,
} from './feederOptimizer';
import { FeederCircuit } from './feeders';
import { ContourSet, ElevationGrid } from './terrain';
import { GroundingPlan } from './grounding';
import type { DrawingVisibilityProfile } from './drawingVisibility';

export interface GenerateRequest {
  kind: 'generate';
  boundary: SiteBoundary;
  configId: string;
  targetMW: number;
  targetMWh: number;
  options: LayoutOptions;
}

export interface DxfRequest {
  kind: 'dxf';

  design: SiteDesign;

  projectName: string;

  configId?: string;

  containersPerPcs?: number;

  meta?: TitleBlockMeta;

  feeders?: FeederCircuit[];

  substation?: Pt | null;
  // Opt-in existing-grade contours (plain data, structured-clonable).

  contours?: ContourSet | null;
  // Opt-in grounding screening plan (plain data, structured-clonable).

  grounding?: GroundingPlan | null;
  // Opt-in typical trench section schedule (CAR-D-B006-1/2).

  trenchSections?: boolean;
  // Opt-in legacy full-area crushed-rock GRAVEL mesh on the ground.

  surfacingMesh?: boolean;
  // Opt-in drafter-drawn area zones (plain data, structured-clonable).

  areaZones?: import('./areaZones').AreaZone[] | null;
  // Opt-in ECI reference legend equipment symbols.

  eciLegend?: boolean;
  // When true, the AUX FEEDER legend row carries a (MAN) suffix.
  auxManRoute?: boolean;
  // false hides plan-area feeder callouts + the NFPA setback dimension.
  includeFeederNfpaAnnotations?: boolean;
  // Opt-in drafter text-label overrides (position/height/content deltas).
  textOverrides?: Record<string, TextOverride>;
  // MULTI-AREA ONLY: the whole-site composition inputs (every area's design +
  // each area's own routed feeders, plus which areas to export). Present ⇒ the
  // export composes the selected footprints exactly as the CAD view draws
  // them. Absent, or resolving to a single area, keeps the legacy
  // single-design path byte-identical.
  site?: import('./siteCompose').SiteComposeInput | null;
  drawingVisibility?: DrawingVisibilityProfile;
}

export interface DxfPackageRequest {
  kind: 'dxfPackage';
  design: SiteDesign;
  projectName: string;
  configId?: string;
  containersPerPcs?: number;
  meta?: TitleBlockMeta;
  feeders?: FeederCircuit[];
  substation?: Pt | null;
  // Opt-in existing-grade contours (plain data, structured-clonable).
  contours?: ContourSet | null;
  // Opt-in grounding screening plan (plain data, structured-clonable).
  grounding?: GroundingPlan | null;
  // Opt-in typical trench section schedule (CAR-D-B006-1/2).
  trenchSections?: boolean;
  // Opt-in appended sheets (absent ⇒ package byte-identical to default).
  // Options are plain data (standard flag, study JSON, %Z numbers).
  sldSheet?: { options?: import('./sld').SldOptions } | null;
  bomSheet?: { options?: import('./bomSheet').BomSheetOptions } | null;
  // Opt-in "Issued for 10%" cover (plain data — vicinity geodata + aerial
  // rect; absent ⇒ package byte-identical to default).
  cover10?: import('./dxfSheets').SheetContext['cover10'];
  // Opt-in legacy full-area crushed-rock GRAVEL mesh on the ground.
  surfacingMesh?: boolean;
  // Opt-in drafter-drawn area zones (plain data, structured-clonable).
  areaZones?: import('./areaZones').AreaZone[] | null;
  // Opt-in ECI reference legend equipment symbols.
  eciLegend?: boolean;
  // When true, the AUX FEEDER legend row carries a (MAN) suffix.
  auxManRoute?: boolean;
  // false hides plan-area feeder callouts + the NFPA setback dimension.
  includeFeederNfpaAnnotations?: boolean;
  // Opt-in enlarged AREA site-plan tiles (10% exports).
  enlargedPlans?: boolean;
  // Opt-in drafter text-label overrides (position/height/content deltas).
  textOverrides?: Record<string, TextOverride>;
  // MULTI-AREA ONLY: whole-site composition inputs + the chosen areas (plain,
  // structured-clonable data). Present ⇒ the package appends one readable
  // full-size plan per selected footprint. Absent, or a selection resolving to
  // a single area, keeps the package byte-identical to the legacy output.
  site?: import('./siteCompose').SiteComposeInput | null;
  drawingVisibility?: DrawingVisibilityProfile;
}

export interface OptimizeRequest {
  kind: 'optimize';
  boundary: SiteBoundary;
  configId: string;
  targetMW: number;
  targetMWh: number;
  baseOptions: OptimizeBaseOptions;
  seed: number;
}

// Same inputs as the optimizer — the scenario engine runs the identical
// seeded search and re-ranks the accepted pool under named objectives.
export interface ScenariosRequest {
  kind: 'scenarios';
  boundary: SiteBoundary;
  configId: string;
  targetMW: number;
  targetMWh: number;
  baseOptions: OptimizeBaseOptions;
  seed: number;
}

// Grading sweep: rotation candidates × full layout runs, scored against the
// elevation grid. The grid travels as plain data (structured-clonable), the
// layout options are the CURRENT store options so every candidate predicts
// exactly what Apply would regenerate.
export interface GradingRequest {
  kind: 'grading';
  boundary: SiteBoundary;
  grid: ElevationGrid;
  configId: string;
  targetMW: number;
  targetMWh: number;
  options: LayoutOptions;
  objective: GradingObjective;
  stepDeg?: number;
}

// Feeder-routing search: unlike the layout optimizer this does NOT regenerate
// designs, so the already-placed design travels as data and every candidate is
// re-routed against it. The response carries metrics and knob values only —
// never routed geometry — so Apply re-runs the normal store path and the
// drawing can never diverge from what the store would have produced anyway.
export interface FeederRoutingRequest {
  kind: 'feederRouting';
  design: SiteDesign;
  substation: Pt;
  blockMW: number;
  base: FeederRoutingBaseOptions;
  current: FeederRoutingParams;
}

export type DesignWorkerRequest =
  | GenerateRequest
  | DxfRequest
  | DxfPackageRequest
  | OptimizeRequest
  | ScenariosRequest
  | GradingRequest
  | FeederRoutingRequest;

export function handleGenerate(req: GenerateRequest): SiteDesign {
  return generateSiteDesign(
    req.boundary,
    getConfiguration(req.configId),
    req.targetMW,
    req.targetMWh,
    req.options
  );
}

export function handleDxf(req: DxfRequest): string {
  const config = req.configId ? getEffectiveConfiguration(req.configId, req.containersPerPcs) : undefined;
  const extras = (req.eciLegend || req.auxManRoute || req.includeFeederNfpaAnnotations === false) ? { ...(req.eciLegend ? { eciLegend: true } : {}), ...(req.auxManRoute ? { auxManRoute: true } : {}), ...(req.includeFeederNfpaAnnotations === false ? { includeFeederNfpaAnnotations: false } : {}) } : undefined;
  // Multi-area export: compose the SELECTED footprints through the same helper
  // the CAD view renders, so the drawing the drafter sees is the drawing that
  // ships. A selection resolving to one area falls through composeDesignDxf
  // inside the helper, so single-area output is untouched.
  if (siteCompositionApplies(req.site)) {
    return buildSiteDxfString(req.site, {
      design: req.design,
      projectName: req.projectName,
      config,
      meta: req.meta,
      feeders: req.feeders,
      substation: req.substation,
      areaZones: req.areaZones,
      sheetExtras: extras,
      textOverrides: req.textOverrides,
    }, req.drawingVisibility);
  }
  return buildDesignDxfString(
    req.design,
    req.projectName,
    config,
    req.meta,
    req.feeders,
    req.substation,
    req.contours,
    req.grounding,
    req.trenchSections,
    req.surfacingMesh,
    req.areaZones,
    extras,
    req.textOverrides,
    req.drawingVisibility
  );
}

export function handleDxfPackage(req: DxfPackageRequest): PackageSheet[] {
  return buildDxfPackage({
    design: req.design,
    projectName: req.projectName,
    config: req.configId ? getEffectiveConfiguration(req.configId, req.containersPerPcs) : undefined,
    meta: req.meta,
    feeders: req.feeders,
    substation: req.substation,
    contours: req.contours,
    grounding: req.grounding,
    trenchSections: req.trenchSections,
    sldSheet: req.sldSheet,
    bomSheet: req.bomSheet,
    cover10: req.cover10,
    surfacingMesh: req.surfacingMesh,
    areaZones: req.areaZones,
    eciLegend: req.eciLegend,
    auxManRoute: req.auxManRoute,
    includeFeederNfpaAnnotations: req.includeFeederNfpaAnnotations,
    enlargedPlans: req.enlargedPlans,
    textOverrides: req.textOverrides,
    site: req.site,
    drawingVisibility: req.drawingVisibility,
  });
}

// Runs the optimizer generator to completion, reporting progress and honoring
// a cancellation probe between candidate evaluations.
export function handleFeederRouting(
  req: FeederRoutingRequest,
  onProgress?: (done: number, total: number) => void,
  isCancelled?: () => boolean
): FeederRoutingResult {
  const it = optimizeFeederRoutingSteps(
    req.design,
    req.substation,
    req.blockMW,
    req.base,
    req.current
  );
  let r = it.next();
  while (!r.done) {
    onProgress?.(r.value.done, r.value.total);
    if (isCancelled?.()) {
      it.return?.(undefined as any);
      return {
        candidates: [],
        current: null,
        evaluated: r.value.done,
        total: r.value.total,
        cancelled: true,
      };
    }
    r = it.next();
  }
  return r.value;
}

export function handleOptimize(
  req: OptimizeRequest,
  onProgress?: (done: number, total: number) => void,
  isCancelled?: () => boolean
): OptimizeResult {
  const it = optimizeSteps(
    req.boundary,
    getConfiguration(req.configId),
    req.targetMW,
    req.targetMWh,
    req.baseOptions,
    req.seed
  );
  let r = it.next();
  while (!r.done) {
    onProgress?.(r.value.done, r.value.total);
    if (isCancelled?.()) {
      it.return?.(undefined as any);
      return {
        candidates: [],
        allCandidates: [],
        evaluated: r.value.done,
        total: r.value.total,
        cancelled: true,
        seed: req.seed,
        baselineBlocks: 0,
      };
    }
    r = it.next();
  }
  // The plain optimizer UI only shows the top candidates; drop the full
  // accepted pool (~40 designs) so it never crosses postMessage needlessly.
  return { ...r.value, allCandidates: [] };
}

// Runs the grading-rotation sweep to completion, reporting progress and
// honoring cancellation between candidate evaluations.
export function handleGrading(
  req: GradingRequest,
  onProgress?: (done: number, total: number) => void,
  isCancelled?: () => boolean
): GradingResult {
  const it = gradingSteps(
    req.boundary,
    req.grid,
    getConfiguration(req.configId),
    req.targetMW,
    req.targetMWh,
    req.options,
    req.objective,
    req.stepDeg
  );
  let r = it.next();
  while (!r.done) {
    onProgress?.(r.value.done, r.value.total);
    if (isCancelled?.()) {
      it.return?.(undefined as any);
      return {
        candidates: [],
        baselineBlocks: 0,
        objective: req.objective,
        stepDeg: req.stepDeg ?? 5,
        evaluated: r.value.done,
        total: r.value.total,
        cancelled: true,
      };
    }
    r = it.next();
  }
  return r.value;
}

// Runs the scenario-comparison generator (same seeded search) to completion,
// reporting progress and honoring cancellation between evaluations.
export function handleScenarios(
  req: ScenariosRequest,
  onProgress?: (done: number, total: number) => void,
  isCancelled?: () => boolean
): ScenarioResult {
  const it = scenarioSteps(
    req.boundary,
    getConfiguration(req.configId),
    req.targetMW,
    req.targetMWh,
    req.baseOptions,
    req.seed
  );
  let r = it.next();
  while (!r.done) {
    onProgress?.(r.value.done, r.value.total);
    if (isCancelled?.()) {
      it.return?.(undefined as any);
      return {
        scenarios: [],
        evaluated: r.value.done,
        total: r.value.total,
        cancelled: true,
        seed: req.seed,
        baselineBlocks: 0,
      };
    }
    r = it.next();
  }
  return r.value;
}
