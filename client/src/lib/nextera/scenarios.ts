// Multi-scenario layout comparison: re-ranks the optimizer's full accepted
// candidate pool under several named objectives (Max Capacity, Min Cabling,
// Min Civil, Balanced) and returns one pick per objective with a comparable
// scorecard. Pure, deterministic functions of the same seeded search the
// optimizer runs — same parcel + config + seed → byte-identical scenarios.
//
// Applying a scenario goes through the exact same store path as applying an
// optimizer candidate (applyOptimizedLayout(params)), so undo/redo, edits and
// exports all work unchanged.
import { SiteBoundary, SiteDesign, RoadEdgeSeg } from './types';
import { BessConfiguration } from './catalog';
import {
  optimizeSteps,
  OptimizeCandidate,
  OptimizeBaseOptions,
} from './optimizer';
import { polygonArea, classifyLoopDepths } from './kmz';

// ---------------------------------------------------------------------------
// Scorecard: every metric a scenario card compares, computed 1:1 from the
// same layout geometry the DXF/BOM use (cables from routed runs, road area
// from the connected road region, trench from the 480V band).
export interface Scorecard {
  achievedMW: number;
  achievedMWh: number;
  blockCount: number;
  cableFt: number;          // total routed DC/MV/LVAC/fiber run length
  trenchFt: number;         // 480V aux + fiber trench band length
  roadAreaSqFt: number;     // connected road region + entrance rectangles
  fencePerimeterFt: number;
  fenceAcres: number;
  warningCount: number;
}

const runLen = (pts: { x: number; y: number }[]) => {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  return s;
};

// Tessellate a closed line/arc edge path into a polygon (arcs sampled at
// ~7.5 deg — area error well under 0.1% at yard fillet radii).
function edgePathPolygon(segs: RoadEdgeSeg[]): { x: number; y: number }[] {
  const pts: { x: number; y: number }[] = [];
  const push = (p: { x: number; y: number }) => {
    const last = pts[pts.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) > 0.05) pts.push(p);
  };
  for (const seg of segs) {
    if (seg.kind === 'line') {
      push(seg.a);
      push(seg.b);
    } else {
      let sweep = seg.ccw ? seg.end - seg.start : seg.start - seg.end;
      while (sweep < 0) sweep += Math.PI * 2;
      const n = Math.max(2, Math.ceil(sweep / (Math.PI / 24)));
      for (let i = 0; i <= n; i++) {
        const a = seg.ccw ? seg.start + (sweep * i) / n : seg.start - (sweep * i) / n;
        push({ x: seg.c.x + seg.r * Math.cos(a), y: seg.c.y + seg.r * Math.sin(a) });
      }
    }
  }
  return pts;
}

// Area of the connected road region: |outer| minus top-level islands, plus
// enclosed road pockets (odd nesting depth), minus their holes — the same
// even-odd classification the DXF road hatch and the 3D road mesh use.
export function roadRegionAreaSqFt(design: SiteDesign): number {
  let area = 0;
  if (design.roadNetwork) {
    const outer = edgePathPolygon(design.roadNetwork.outer);
    if (outer.length >= 3) area += Math.abs(polygonArea(outer));
    const loops = design.roadNetwork.islands
      .map(isl => edgePathPolygon(isl))
      .filter(p => p.length >= 3);
    const depths = classifyLoopDepths(loops);
    loops.forEach((pts, i) => {
      const a = Math.abs(polygonArea(pts));
      area += depths[i] % 2 === 0 ? -a : a;
    });
  } else {
    // Compact mode: no connected network — sum the aisle strips instead.
    area += design.aisles.reduce((s, r) => s + r.length * r.width, 0);
  }
  area += design.roads.reduce((s, r) => s + r.length * r.width, 0);
  return Math.max(0, area);
}

export function fencePerimeterFt(design: SiteDesign): number {
  const f = design.fence;
  if (f.length < 3) return 0;
  let s = 0;
  for (let i = 0; i < f.length; i++) {
    const a = f[i], b = f[(i + 1) % f.length];
    s += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return s;
}

export function scorecardOf(design: SiteDesign): Scorecard {
  return {
    achievedMW: design.achievedMW,
    achievedMWh: design.achievedMWh,
    blockCount: design.blocksPlaced,
    cableFt: design.cables.reduce((s, c) => s + runLen(c.pts), 0),
    trenchFt: design.trench ? Math.max(0, design.trench.yTop - design.trench.yBottom) : 0,
    roadAreaSqFt: roadRegionAreaSqFt(design),
    fencePerimeterFt: fencePerimeterFt(design),
    fenceAcres: design.fence.length >= 3 ? Math.abs(polygonArea(design.fence)) / 43560 : 0,
    warningCount: design.warnings.length,
  };
}

// ---------------------------------------------------------------------------
// Objectives
export type ScenarioObjective = 'capacity' | 'cabling' | 'civil' | 'balanced';

export interface ScenarioDef {
  id: ScenarioObjective;
  label: string;
  tagline: string; // one-line "what this optimizes for"
}

export const SCENARIO_DEFS: ScenarioDef[] = [
  { id: 'capacity', label: 'Max Capacity', tagline: 'Most MWh on the parcel' },
  { id: 'cabling', label: 'Min Cabling', tagline: 'Shortest cable + trench runs' },
  { id: 'civil', label: 'Min Civil', tagline: 'Least road area and fence line' },
  { id: 'balanced', label: 'Balanced', tagline: 'Best capacity / cost trade-off' },
];

export interface Scenario {
  objective: ScenarioObjective;
  def: ScenarioDef;
  candidate: OptimizeCandidate;
  scorecard: Scorecard;
  // Set when an earlier objective already picked this exact candidate — the
  // card shows "same layout as <label>" instead of pretending it differs.
  sameAs: ScenarioObjective | null;
}

export interface ScenarioResult {
  scenarios: Scenario[];
  evaluated: number;
  total: number;
  cancelled: boolean;
  seed: number;
  baselineBlocks: number;
}

// Deterministic final tiebreak: candidate ids are "opt-<n>" in evaluation
// order, so lower n = earlier in the fixed seeded search order.
const idNum = (c: OptimizeCandidate) => Number(c.id.slice(4)) || 0;

type Scored = { cand: OptimizeCandidate; sc: Scorecard };

const cmpCapacity = (a: Scored, b: Scored) =>
  b.sc.achievedMWh - a.sc.achievedMWh ||
  a.sc.cableFt - b.sc.cableFt ||
  a.sc.roadAreaSqFt - b.sc.roadAreaSqFt ||
  idNum(a.cand) - idNum(b.cand);

const cmpCabling = (a: Scored, b: Scored) =>
  (a.sc.cableFt + a.sc.trenchFt) - (b.sc.cableFt + b.sc.trenchFt) ||
  b.sc.achievedMWh - a.sc.achievedMWh ||
  a.sc.roadAreaSqFt - b.sc.roadAreaSqFt ||
  idNum(a.cand) - idNum(b.cand);

const cmpCivil = (a: Scored, b: Scored) =>
  a.sc.roadAreaSqFt - b.sc.roadAreaSqFt ||
  a.sc.fencePerimeterFt - b.sc.fencePerimeterFt ||
  b.sc.achievedMWh - a.sc.achievedMWh ||
  a.sc.cableFt - b.sc.cableFt ||
  idNum(a.cand) - idNum(b.cand);

// Balanced: min-max normalized weighted score. Capacity dominates (a BESS
// site exists to store energy) with cabling and civil works as cost drags.
const BALANCED_WEIGHTS = { mwh: 0.45, cable: 0.25, road: 0.2, fence: 0.1 };

function balancedScores(scored: Scored[]): Map<OptimizeCandidate, number> {
  const norm = (get: (s: Scored) => number) => {
    const vs = scored.map(get);
    const min = Math.min(...vs), max = Math.max(...vs);
    const span = max - min;
    return (s: Scored) => (span > 1e-9 ? (get(s) - min) / span : 0);
  };
  const nMwh = norm(s => s.sc.achievedMWh);
  const nCable = norm(s => s.sc.cableFt + s.sc.trenchFt);
  const nRoad = norm(s => s.sc.roadAreaSqFt);
  const nFence = norm(s => s.sc.fencePerimeterFt);
  const out = new Map<OptimizeCandidate, number>();
  for (const s of scored) {
    out.set(
      s.cand,
      BALANCED_WEIGHTS.mwh * nMwh(s) +
        BALANCED_WEIGHTS.cable * (1 - nCable(s)) +
        BALANCED_WEIGHTS.road * (1 - nRoad(s)) +
        BALANCED_WEIGHTS.fence * (1 - nFence(s))
    );
  }
  return out;
}

// Pure re-ranking: one pick per objective from the accepted candidate pool.
// Every candidate already carries the optimizer's guarantees (valid design,
// block count >= pristine baseline, deduped placements).
export function pickScenarios(all: OptimizeCandidate[]): Scenario[] {
  if (all.length === 0) return [];
  const scored: Scored[] = all.map(cand => ({ cand, sc: scorecardOf(cand.design) }));
  const bal = balancedScores(scored);
  const cmpBalanced = (a: Scored, b: Scored) =>
    (bal.get(b.cand) ?? 0) - (bal.get(a.cand) ?? 0) || idNum(a.cand) - idNum(b.cand);

  const pickers: Record<ScenarioObjective, (a: Scored, b: Scored) => number> = {
    capacity: cmpCapacity,
    cabling: cmpCabling,
    civil: cmpCivil,
    balanced: cmpBalanced,
  };

  const out: Scenario[] = [];
  for (const def of SCENARIO_DEFS) {
    const best = [...scored].sort(pickers[def.id])[0];
    const prior = out.find(s => s.candidate.id === best.cand.id);
    out.push({
      objective: def.id,
      def,
      candidate: best.cand,
      scorecard: best.sc,
      sameAs: prior ? prior.objective : null,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Generator: same seeded optimizer search, progress after every candidate
// evaluation (for the UI progress bar + cancellation), scenarios picked from
// the full accepted pool at the end.
export function* scenarioSteps(
  boundary: SiteBoundary,
  config: BessConfiguration,
  targetMW: number,
  targetMWh: number,
  baseOptions: OptimizeBaseOptions,
  seed: number
): Generator<{ done: number; total: number }, ScenarioResult> {
  const it = optimizeSteps(boundary, config, targetMW, targetMWh, baseOptions, seed);
  let r = it.next();
  while (!r.done) {
    yield r.value;
    r = it.next();
  }
  const opt = r.value;
  return {
    scenarios: pickScenarios(opt.allCandidates),
    evaluated: opt.evaluated,
    total: opt.total,
    cancelled: false,
    seed,
    baselineBlocks: opt.baselineBlocks,
  };
}

// Synchronous convenience wrapper (tests / non-UI callers).
export function compareScenarios(
  boundary: SiteBoundary,
  config: BessConfiguration,
  targetMW: number,
  targetMWh: number,
  baseOptions: OptimizeBaseOptions,
  seed = 1
): ScenarioResult {
  const it = scenarioSteps(boundary, config, targetMW, targetMWh, baseOptions, seed);
  let r = it.next();
  while (!r.done) r = it.next();
  return r.value;
}
