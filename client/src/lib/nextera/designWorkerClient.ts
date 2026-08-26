// Main-thread client for the design worker. One shared worker instance,
// sequence-numbered requests, and per-channel superseding: when a newer
// request of the same channel is issued, the older promise rejects with
// SupersededError and its (eventual) worker response is dropped. Falls back
// to synchronous main-thread computation when Workers are unavailable
// (Node tests, very old browsers) — same pure functions, same bytes.
import { SiteDesign, Pt } from './types';
import { LayoutOptions } from './layoutEngine';
import { OptimizeResult, OptimizeBaseOptions } from './optimizer';
import { ScenarioResult } from './scenarios';
import { GradingResult, GradingObjective } from './gradingOptimizer';
import { FeederCircuit } from './feeders';
import { TitleBlockMeta } from './dxfExport';
import { ContourSet } from './terrain';
import { GroundingPlan } from './grounding';
import {
  DesignWorkerRequest,
  handleGenerate,
  handleDxf,
  handleDxfPackage,
  handleOptimize,
  handleScenarios,
  handleGrading,
  handleFeederRouting,
} from './designWorkerCore';
import {
  FeederRoutingResult,
  FeederRoutingParams,
  FeederRoutingBaseOptions,
} from './feederOptimizer';
import { PackageSheet } from './dxfSheets';
import { SiteBoundary } from './types';

export class SupersededError extends Error {
  constructor() {
    super('superseded by a newer request');
    this.name = 'SupersededError';
  }
}

type Pending = {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  onProgress?: (done: number, total: number) => void;
  channel: string;
};

let worker: Worker | null = null;
let seqCounter = 0;
const pending = new Map<number, Pending>();
// channel -> latest seq; older seqs of the same channel are superseded
const latestByChannel = new Map<string, number>();

export const workerAvailable = () => typeof Worker !== 'undefined';

function getWorker(): Worker | null {
  if (!workerAvailable()) return null;
  if (!worker) {
    worker = new Worker(new URL('./designWorker.worker.ts', import.meta.url), {
      type: 'module',
    });
    worker.onmessage = (e: MessageEvent<any>) => {
      const { seq, result, error, progress } = e.data;
      const p = pending.get(seq);
      if (!p) return;
      if (progress) {
        p.onProgress?.(progress.done, progress.total);
        return;
      }
      pending.delete(seq);
      if (latestByChannel.get(p.channel) !== seq) return; // stale — drop
      if (error) p.reject(new Error(error));
      else p.resolve(result);
    };
    worker.onerror = () => {
      // Worker crashed: fail all pending requests; a fresh worker is created
      // on the next request.
      pending.forEach(p => p.reject(new Error('Design worker crashed')));
      pending.clear();
      worker?.terminate();
      worker = null;
    };
  }
  return worker;
}

// Issue a request on a named channel. A newer request on the same channel
// supersedes older in-flight ones: their promises reject with SupersededError.
function request<T>(
  channel: string,
  req: DesignWorkerRequest,
  onProgress?: (done: number, total: number) => void
): Promise<T> {
  const w = getWorker();
  const seq = ++seqCounter;
  const prevSeq = latestByChannel.get(channel);
  latestByChannel.set(channel, seq);
  if (prevSeq !== undefined) {
    const prev = pending.get(prevSeq);
    if (prev) {
      pending.delete(prevSeq);
      if (w && (req.kind === 'optimize' || req.kind === 'scenarios' || req.kind === 'grading'
        || req.kind === 'feederRouting')) {
        w.postMessage({ seq: prevSeq, cancel: true });
      }
      prev.reject(new SupersededError());
    }
  }
  if (!w) {
    // Synchronous fallback: same pure functions on the main thread.
    return new Promise<T>((resolve, reject) => {
      try {
        if (req.kind === 'generate') resolve(handleGenerate(req) as T);
        else if (req.kind === 'dxf') resolve(handleDxf(req) as T);
        else if (req.kind === 'dxfPackage') resolve(handleDxfPackage(req) as T);
        else if (req.kind === 'scenarios') resolve(handleScenarios(req, onProgress) as T);
        else if (req.kind === 'grading') resolve(handleGrading(req, onProgress) as T);
        else if (req.kind === 'feederRouting') resolve(handleFeederRouting(req, onProgress) as T);
        else resolve(handleOptimize(req, onProgress) as T);
      } catch (e: any) {
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }
  return new Promise<T>((resolve, reject) => {
    pending.set(seq, { resolve, reject, onProgress, channel });
    w.postMessage({ seq, req });
  });
}

// Cancel any in-flight request on a channel (used by the optimizer's Cancel
// button). The pending promise rejects with SupersededError.
export function cancelChannel(channel: string) {
  const seq = latestByChannel.get(channel);
  if (seq === undefined) return;
  const p = pending.get(seq);
  latestByChannel.delete(channel);
  if (p) {
    pending.delete(seq);
    worker?.postMessage({ seq, cancel: true });
    p.reject(new SupersededError());
  }
}

export function generateDesignInWorker(
  boundary: SiteBoundary,
  configId: string,
  targetMW: number,
  targetMWh: number,
  options: LayoutOptions
): Promise<SiteDesign> {
  return request<SiteDesign>('generate', {
    kind: 'generate',
    boundary,
    configId,
    targetMW,
    targetMWh,
    options,
  });
}

export function buildDxfInWorker(
  design: SiteDesign,
  projectName: string,
  configId?: string,
  meta?: TitleBlockMeta,
  feeders?: FeederCircuit[],
  substation?: Pt | null,
  containersPerPcs?: number,
  contours?: ContourSet | null,
  grounding?: GroundingPlan | null,
  trenchSections?: boolean,
  surfacingMesh?: boolean,
  areaZones?: import('./areaZones').AreaZone[] | null,
  eciLegend?: boolean,
  textOverrides?: Record<string, import('./dxfExport').TextOverride>,
  auxManRoute?: boolean,
  includeFeederNfpaAnnotations?: boolean,
  // MULTI-AREA ONLY: whole-site composition inputs + the chosen areas. Absent
  // (or a one-area selection) keeps the legacy single-design export.
  site?: import('./siteCompose').SiteComposeInput | null,
  drawingVisibility?: import('./drawingVisibility').DrawingVisibilityProfile
): Promise<string> {
  return request<string>('dxf', {
    kind: 'dxf',
    design,
    projectName,
    configId,
    containersPerPcs,
    meta,
    feeders,
    substation,
    contours,
    grounding,
    trenchSections,
    surfacingMesh,
    areaZones,
    eciLegend,
    textOverrides,
    ...(auxManRoute ? { auxManRoute: true } : {}),
    ...(includeFeederNfpaAnnotations === false ? { includeFeederNfpaAnnotations: false } : {}),
    ...(site ? { site } : {}),
    ...(drawingVisibility ? { drawingVisibility } : {}),
  });
}

export function buildDxfPackageInWorker(
  design: SiteDesign,
  projectName: string,
  configId?: string,
  meta?: TitleBlockMeta,
  feeders?: FeederCircuit[],
  substation?: Pt | null,
  containersPerPcs?: number,
  contours?: ContourSet | null,
  grounding?: GroundingPlan | null,
  sldSheet?: { options?: import('./sld').SldOptions } | null,
  bomSheet?: { options?: import('./bomSheet').BomSheetOptions } | null,
  trenchSections?: boolean,
  cover10?: import('./dxfSheets').SheetContext['cover10'],
  surfacingMesh?: boolean,
  areaZones?: import('./areaZones').AreaZone[] | null,
  eciLegend?: boolean,
  enlargedPlans?: boolean,
  textOverrides?: Record<string, import('./dxfExport').TextOverride>,
  auxManRoute?: boolean,
  includeFeederNfpaAnnotations?: boolean,
  // MULTI-AREA ONLY: whole-site composition inputs + the chosen areas. Absent
  // (or a one-area selection) keeps the package byte-identical to the legacy
  // single-design output.
  site?: import('./siteCompose').SiteComposeInput | null,
  drawingVisibility?: import('./drawingVisibility').DrawingVisibilityProfile
): Promise<PackageSheet[]> {
  return request<PackageSheet[]>('dxfPackage', {
    kind: 'dxfPackage',
    design,
    projectName,
    configId,
    containersPerPcs,
    meta,
    feeders,
    substation,
    contours,
    grounding,
    trenchSections,
    sldSheet,
    bomSheet,
    cover10,
    surfacingMesh,
    areaZones,
    eciLegend,
    enlargedPlans,
    textOverrides,
    ...(auxManRoute ? { auxManRoute: true } : {}),
    ...(includeFeederNfpaAnnotations === false ? { includeFeederNfpaAnnotations: false } : {}),
    ...(site ? { site } : {}),
    ...(drawingVisibility ? { drawingVisibility } : {}),
  });
}

export function compareScenariosInWorker(
  boundary: SiteBoundary,
  configId: string,
  targetMW: number,
  targetMWh: number,
  baseOptions: OptimizeBaseOptions,
  seed: number,
  onProgress?: (done: number, total: number) => void
): Promise<ScenarioResult> {
  return request<ScenarioResult>(
    'scenarios',
    { kind: 'scenarios', boundary, configId, targetMW, targetMWh, baseOptions, seed },
    onProgress
  );
}

export function optimizeGradingInWorker(
  boundary: SiteBoundary,
  grid: import('./terrain').ElevationGrid,
  configId: string,
  targetMW: number,
  targetMWh: number,
  options: LayoutOptions,
  objective: GradingObjective,
  onProgress?: (done: number, total: number) => void,
  stepDeg?: number
): Promise<GradingResult> {
  return request<GradingResult>(
    'grading',
    { kind: 'grading', boundary, grid, configId, targetMW, targetMWh, options, objective, stepDeg },
    onProgress
  );
}

// Feeder-exit search against an ALREADY-PLACED design (its own channel, so it
// supersedes/cancels independently of the layout optimizer).
export function optimizeFeederRoutingInWorker(
  design: SiteDesign,
  substation: Pt,
  blockMW: number,
  base: FeederRoutingBaseOptions,
  current: FeederRoutingParams,
  onProgress?: (done: number, total: number) => void
): Promise<FeederRoutingResult> {
  return request<FeederRoutingResult>(
    'feederRouting',
    { kind: 'feederRouting', design, substation, blockMW, base, current },
    onProgress
  );
}

export function optimizeInWorker(
  boundary: SiteBoundary,
  configId: string,
  targetMW: number,
  targetMWh: number,
  baseOptions: OptimizeBaseOptions,
  seed: number,
  onProgress?: (done: number, total: number) => void
): Promise<OptimizeResult> {
  return request<OptimizeResult>(
    'optimize',
    { kind: 'optimize', boundary, configId, targetMW, targetMWh, baseOptions, seed },
    onProgress
  );
}
