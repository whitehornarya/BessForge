// Layout optimization: a bounded, seeded, deterministic search over the
// engine's layout knobs — arrangement scan order, lattice origin shift,
// entrance-gate edge and trench spine x — scored by achieved MWh (primary),
// total cable feet (tiebreak), then road length. Pure function of
// (parcel, config, targets, options, seed) → ranked candidates; applying a
// candidate goes through the normal store path so undo/redo works unchanged.
//
// Notes on the search space:
// - Yard rotation is intentionally NOT searched: the engine (roads, trench,
//   NFPA rects, DXF) is axis-aligned by construction; rotating the yard would
//   need a full geometry-frame refactor. Arrangement x lattice-shift covers
//   the practical packing variation on irregular parcels.
// - Row pitch is not searched either: the auto pitch already sits at the
//   guidance minimum clearances, so any larger pitch can only fit fewer (or
//   equal) blocks with longer cable runs — it can never win the score.
import { SiteBoundary, SiteDesign, Pt } from './types';
import { BessConfiguration } from './catalog';
import {
  generateSiteDesign,
  blockFootprint,
  ArrangementStrategy,
  ARRANGEMENTS,
  GateEdge,
  LayoutOptions,
  ROW_AISLE_GAP_FT,
} from './layoutEngine';
import { CLEARANCES } from './catalog';
import { validateDesign } from './validateDesign';
import { polygonArea } from './kmz';

// The layout knobs one candidate sets. null = engine default (auto).
export interface OptimizeParams {
  arrangement: ArrangementStrategy;
  latticeShift: Pt | null;
  gateEdge: GateEdge | null;
  trenchX: number | null;
}

export interface OptimizeCandidate {
  id: string;
  params: OptimizeParams;
  design: SiteDesign;
  stats: {
    blocksPlaced: number;
    blocksRequired: number;
    achievedMW: number;
    achievedMWh: number;
    cableFt: number;
    roadLengthFt: number;
    fenceAcres: number;
  };
}

export interface OptimizeResult {
  candidates: OptimizeCandidate[]; // ranked best-first, max MAX_CANDIDATES
  // EVERY accepted (valid, deduped, >= baseline blocks) candidate, ranked
  // best-first. Consumed by the scenario comparison engine, which re-ranks
  // under different objectives — worker responses for the plain optimizer
  // strip this to [] so ~40 full designs never cross postMessage needlessly.
  allCandidates: OptimizeCandidate[];
  evaluated: number;
  total: number;
  cancelled: boolean;
  seed: number;
  baselineBlocks: number;
}

export const MAX_CANDIDATES = 5;
const TOP_REFINE = 3;      // phase-2 refinement breadth
const SHIFTS_PER_ARR = 5;  // seeded lattice shifts per arrangement (plus 0,0)

// Deterministic PRNG (mulberry32) — same seed, same candidate list.
function mulberry32(seed: number) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const runLen = (pts: Pt[]) => {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  return s;
};

function statsOf(design: SiteDesign): OptimizeCandidate['stats'] {
  return {
    blocksPlaced: design.blocksPlaced,
    blocksRequired: design.blocksRequired,
    achievedMW: design.achievedMW,
    achievedMWh: design.achievedMWh,
    cableFt: design.cables.reduce((s, c) => s + runLen(c.pts), 0),
    roadLengthFt: design.roads.reduce((s, r) => s + r.length, 0),
    fenceAcres: design.fence.length >= 3 ? Math.abs(polygonArea(design.fence)) / 43560 : 0,
  };
}

// Best-first ordering: more MWh, then fewer cable feet, then less road.
function better(a: OptimizeCandidate, b: OptimizeCandidate): number {
  if (a.stats.achievedMWh !== b.stats.achievedMWh) return b.stats.achievedMWh - a.stats.achievedMWh;
  if (Math.abs(a.stats.cableFt - b.stats.cableFt) > 0.5) return a.stats.cableFt - b.stats.cableFt;
  return a.stats.roadLengthFt - b.stats.roadLengthFt;
}

// Two candidates are duplicates when their block placements coincide (same
// count + same rounded block-center signature) and their trench/gate match.
function signature(c: OptimizeCandidate): string {
  const centers = c.design.blockRows
    .flatMap(r => r.blocks.map(b => `${Math.round(b.x)},${Math.round(b.y)}`))
    .sort()
    .join(';');
  return `${centers}|t${c.params.trenchX === null ? 'a' : Math.round(c.params.trenchX)}|g${c.params.gateEdge ?? 'S'}`;
}

// Base options with all drafter edits and optimizer knobs stripped — the
// optimizer explores pristine layouts, exactly like the arrangement explorer.
export type OptimizeBaseOptions = Omit<LayoutOptions, 'arrangement' | 'constraints' | 'latticeShift' | 'gateEdge'>;

interface Progress {
  done: number;
  total: number;
}

// Generator core: yields progress after every candidate evaluation so the UI
// can show a progress bar and cancel by simply not resuming the generator.
export function* optimizeSteps(
  boundary: SiteBoundary,
  config: BessConfiguration,
  targetMW: number,
  targetMWh: number,
  baseOptions: OptimizeBaseOptions,
  seed: number
): Generator<Progress, OptimizeResult> {
  const rnd = mulberry32((seed | 0) || 1);
  const gen = (params: OptimizeParams): SiteDesign =>
    generateSiteDesign(boundary, config, targetMW, targetMWh, {
      ...baseOptions,
      arrangement: params.arrangement,
      latticeShift: params.latticeShift,
      gateEdge: params.gateEdge,
      constraints: params.trenchX !== null ? { trenchX: params.trenchX } : undefined,
    });

  // Baseline: the pristine default auto-layout ('sw', no knobs). The
  // optimizer never surfaces a candidate with fewer blocks than this.
  const baselineParams: OptimizeParams = { arrangement: 'sw', latticeShift: null, gateEdge: null, trenchX: null };
  const baseline = gen(baselineParams);
  const baselineBlocks = baseline.blocksPlaced;

  // Lattice steps for shift sampling (roads-mode pitch; shifts are normalized
  // into [0, step) by the engine, so sampling in [0, step) covers everything).
  const pcs = baseOptions.hotClimate ? CLEARANCES.pcsHotClimate : CLEARANCES.pcsStandard;
  const fp = blockFootprint(config, pcs);
  const stepX = fp.width + CLEARANCES.frontToFront;
  const stepY = fp.depth + ROW_AISLE_GAP_FT;

  // ---- Phase 1: arrangement x lattice shift (maximize blocks/MWh) ----------
  const phase1: OptimizeParams[] = [];
  for (const a of ARRANGEMENTS) {
    phase1.push({ arrangement: a.id, latticeShift: null, gateEdge: null, trenchX: null });
    for (let i = 0; i < SHIFTS_PER_ARR; i++) {
      phase1.push({
        arrangement: a.id,
        latticeShift: { x: Math.round(rnd() * stepX), y: Math.round(rnd() * stepY) },
        gateEdge: null,
        trenchX: null,
      });
    }
  }

  // Trench x samples inside the fence bbox (phase 2). Sampled up-front so the
  // random stream (and thus determinism) is independent of phase-1 results.
  const bxs = boundary.polygon.map(p => p.x);
  const bMinX = Math.min(...bxs), bMaxX = Math.max(...bxs);
  const trenchSamples = [
    bMinX + (0.25 + rnd() * 0.2) * (bMaxX - bMinX),
    bMinX + (0.55 + rnd() * 0.2) * (bMaxX - bMinX),
  ].map(v => Math.round(v));
  const gateEdges: (GateEdge | null)[] = [null, 'E', 'W', 'N'];

  const phase2PerCand = 1 + trenchSamples.length + (gateEdges.length - 1);
  const total = phase1.length + TOP_REFINE * phase2PerCand;
  let done = 0;

  const accepted: OptimizeCandidate[] = [];
  const seen = new Set<string>();
  let idc = 0;
  const consider = (params: OptimizeParams, design: SiteDesign) => {
    const stats = statsOf(design);
    if (design.blocksPlaced < baselineBlocks) return;
    if (design.blocksPlaced <= 0) return;
    if (!validateDesign(design).ok) return;
    // A pinned trench the engine rejected is not really this candidate.
    if (params.trenchX !== null &&
        design.warnings.some(w => w.startsWith('Pinned trench corridor rejected'))) return;
    const cand: OptimizeCandidate = { id: `opt-${++idc}`, params, design, stats };
    const sig = signature(cand);
    if (seen.has(sig)) return;
    seen.add(sig);
    accepted.push(cand);
    accepted.sort(better);
  };

  // Baseline itself is candidate #1 (already evaluated).
  consider(baselineParams, baseline);

  for (const params of phase1) {
    // Skip re-evaluating the exact baseline spec.
    if (!(params.arrangement === 'sw' && !params.latticeShift)) {
      consider(params, gen(params));
    }
    done++;
    yield { done, total };
  }

  // Early exit: if the required block count is already hit, phase 1 cannot be
  // beaten on MWh — refinement below only trims cable/road feet.
  const refineFrom = accepted.slice(0, TOP_REFINE);

  // ---- Phase 2: trench x + gate edge refinement on the top candidates ------
  for (const base of refineFrom) {
    for (const tx of trenchSamples) {
      const params: OptimizeParams = { ...base.params, trenchX: tx };
      consider(params, gen(params));
      done++;
      yield { done, total };
    }
    for (const ge of gateEdges.slice(1)) {
      const params: OptimizeParams = { ...base.params, gateEdge: ge };
      consider(params, gen(params));
      done++;
      yield { done, total };
    }
    done++; // slot reserved for the base itself (already counted in phase 1)
    yield { done, total };
  }

  return {
    candidates: accepted.slice(0, MAX_CANDIDATES),
    allCandidates: accepted.slice(),
    evaluated: done,
    total,
    cancelled: false,
    seed,
    baselineBlocks,
  };
}

// Synchronous convenience wrapper (tests / non-UI callers).
export function optimizeLayout(
  boundary: SiteBoundary,
  config: BessConfiguration,
  targetMW: number,
  targetMWh: number,
  baseOptions: OptimizeBaseOptions,
  seed = 1
): OptimizeResult {
  const it = optimizeSteps(boundary, config, targetMW, targetMWh, baseOptions, seed);
  let r = it.next();
  while (!r.done) r = it.next();
  return r.value;
}

// Async wrapper for the UI: yields to the event loop between evaluations so
// the progress bar paints and cancel is responsive.
export async function optimizeLayoutAsync(
  boundary: SiteBoundary,
  config: BessConfiguration,
  targetMW: number,
  targetMWh: number,
  baseOptions: OptimizeBaseOptions,
  seed = 1,
  onProgress?: (done: number, total: number) => void,
  shouldCancel?: () => boolean
): Promise<OptimizeResult> {
  const it = optimizeSteps(boundary, config, targetMW, targetMWh, baseOptions, seed);
  let r = it.next();
  while (!r.done) {
    onProgress?.(r.value.done, r.value.total);
    if (shouldCancel?.()) {
      const ret = it.return?.(undefined as any);
      void ret;
      return {
        candidates: [],
        allCandidates: [],
        evaluated: r.value.done,
        total: r.value.total,
        cancelled: true,
        seed,
        baselineBlocks: 0,
      };
    }
    await new Promise<void>(res => setTimeout(res, 0));
    r = it.next();
  }
  return r.value;
}
