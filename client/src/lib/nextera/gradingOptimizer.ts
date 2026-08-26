// Grading-optimized layout search: sweep yard rotations against the real
// elevation grid and rank the poses by earthwork. For each candidate angle θ
// the parcel boundary is rotated by −θ about a fixed pivot (so the yard grid
// stays axis-aligned in its own working frame — the engine is axis-aligned by
// construction), the layout engine runs unchanged, and the resulting fenced
// yard is scored with the EXISTING cut/fill math over a terrain grid
// resampled into that same rotated frame. Scoring in the resampled frame
// means the number promised here is byte-identical to the cut/fill card the
// panel shows after Apply.
//
// Everything is pure and deterministic: fixed candidate order (ascending
// angle), stable tie-breaks (lowest angle wins), no randomness. θ = 0 is an
// exact identity — no transform is applied at all — so the flat-pad baseline
// stays byte-identical to the untouched design.
import { SiteBoundary, SiteDesign, Pt } from './types';
import { BessConfiguration } from './catalog';
import { generateSiteDesign, LayoutOptions } from './layoutEngine';
import {
  ElevationGrid,
  LocalRect,
  terrainLocalRect,
  sampleElevationFt,
  computeCutFill,
} from './terrain';

// Default sweep: 0–175° in 5° steps. 180° repeats 0° for the axis-aligned
// engine (a 180° parcel spin yields the mirrored layout of 0°, but the
// earthwork score is symmetric enough that the half-turn range is the
// standard screening sweep).
export const GRADING_STEP_DEG = 5;
export const GRADING_MAX_DEG = 180; // exclusive

export type GradingObjective = 'total' | 'net';

export interface GradingCandidate {
  rotationDeg: number;
  padElevationFt: number;
  cutCY: number;
  fillCY: number;
  netCY: number;
  totalCY: number; // cut + fill (both are non-negative magnitudes)
  blocksPlaced: number;
  // A pose that fits fewer blocks than the 0° baseline (or whose yard falls
  // off the terrain coverage) is kept in the list but marked infeasible —
  // it is never ranked above any feasible pose.
  feasible: boolean;
}

export interface GradingResult {
  // Ranked best-first: feasible before infeasible, then objective score
  // ascending, ties broken by the lowest angle.
  candidates: GradingCandidate[];
  baselineBlocks: number; // blocks placed at θ = 0
  objective: GradingObjective;
  stepDeg: number;
  evaluated: number;
  total: number;
  cancelled: boolean;
}

// Fixed rotation pivot: the mean of the parcel polygon vertices. Derived
// from the ORIGINAL (unrotated) boundary so every candidate — and the store
// Apply path — rotates about the exact same point.
export function polygonPivot(polygon: Pt[]): Pt {
  if (!polygon.length) return { x: 0, y: 0 };
  let sx = 0, sy = 0;
  for (const p of polygon) { sx += p.x; sy += p.y; }
  return { x: sx / polygon.length, y: sy / polygon.length };
}

// Rotate a point by deg (CCW positive) about the pivot. deg === 0 returns
// the point object unchanged — an exact identity, no float noise.
export function rotatePt(p: Pt, deg: number, pivot: Pt): Pt {
  if (deg === 0) return p;
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a), s = Math.sin(a);
  const dx = p.x - pivot.x, dy = p.y - pivot.y;
  return { x: pivot.x + dx * c - dy * s, y: pivot.y + dx * s + dy * c };
}

export function rotatePolygon(polygon: Pt[], deg: number, pivot: Pt): Pt[] {
  if (deg === 0) return polygon;
  return polygon.map(p => rotatePt(p, deg, pivot));
}

// The boundary the layout engine sees for a yard rotated by deg: the parcel
// polygon spun by −deg about the pivot (the yard frame is the geo frame
// rotated by −deg). deg === 0 returns the boundary object unchanged.
export function boundaryForYardRotation(boundary: SiteBoundary, deg: number): SiteBoundary {
  if (deg === 0) return boundary;
  const pivot = polygonPivot(boundary.polygon);
  return { ...boundary, polygon: rotatePolygon(boundary.polygon, -deg, pivot) };
}

// Resample the geo-frame elevation grid into the yard frame of a rotation:
// output cell centers are yard-frame points whose elevations come from
// bilinear sampling of the original grid at the corresponding geo point
// (yard → geo = rotate by +deg about the pivot). The output bounds are
// synthesized so terrainLocalRect(out, origin) reproduces the yard-frame
// bbox of the rotated coverage — every existing consumer (cut/fill,
// contours, slope, drape) then works unchanged in the yard frame.
// deg === 0 returns the input grid unchanged (exact identity).
export function resampleGridForYardRotation(
  grid: ElevationGrid,
  origin: { lat: number; lon: number },
  deg: number,
  pivot: Pt
): ElevationGrid {
  if (deg === 0) return grid;
  const rect = terrainLocalRect(grid, origin);
  // Yard-frame bbox of the rotated coverage (geo rect corners → yard frame).
  const corners = [
    { x: rect.minX, y: rect.minY },
    { x: rect.maxX, y: rect.minY },
    { x: rect.maxX, y: rect.maxY },
    { x: rect.minX, y: rect.maxY },
  ].map(p => rotatePt(p, -deg, pivot));
  const minX = Math.min(...corners.map(p => p.x));
  const maxX = Math.max(...corners.map(p => p.x));
  const minY = Math.min(...corners.map(p => p.y));
  const maxY = Math.max(...corners.map(p => p.y));
  const { width, height } = grid;
  const valuesFt = new Array<number>(width * height);
  for (let r = 0; r < height; r++) {
    // Same convention as sampleElevationFt: row 0 = north, cell centers.
    const y = maxY - ((r + 0.5) / height) * (maxY - minY);
    for (let c = 0; c < width; c++) {
      const x = minX + ((c + 0.5) / width) * (maxX - minX);
      const geo = rotatePt({ x, y }, deg, pivot);
      valuesFt[r * width + c] = sampleElevationFt(grid, rect, geo.x, geo.y);
    }
  }
  // Invert terrainLocalRect so the synthetic bounds project back onto the
  // yard-frame bbox exactly (same FT_PER_DEG constants).
  const FT_PER_DEG_LAT = 364000;
  const ftPerDegLon = FT_PER_DEG_LAT * Math.cos((origin.lat * Math.PI) / 180);
  return {
    ...grid,
    bounds: {
      west: origin.lon + minX / ftPerDegLon,
      east: origin.lon + maxX / ftPerDegLon,
      south: origin.lat + minY / FT_PER_DEG_LAT,
      north: origin.lat + maxY / FT_PER_DEG_LAT,
    },
    valuesFt,
  };
}

// Score one already-generated design against the yard-frame grid.
function scoreDesign(
  design: SiteDesign,
  gridYard: ElevationGrid,
  rectYard: LocalRect,
  rotationDeg: number,
  baselineBlocks: number
): GradingCandidate {
  const cf = design.fence.length >= 3 ? computeCutFill(gridYard, rectYard, design.fence) : null;
  return {
    rotationDeg,
    padElevationFt: cf?.padElevationFt ?? 0,
    cutCY: cf?.cutCY ?? 0,
    fillCY: cf?.fillCY ?? 0,
    netCY: cf?.netCY ?? 0,
    totalCY: cf ? cf.cutCY + cf.fillCY : Number.POSITIVE_INFINITY,
    blocksPlaced: design.blocksPlaced,
    feasible: cf !== null && design.blocksPlaced > 0 && design.blocksPlaced >= baselineBlocks,
  };
}

const objectiveScore = (c: GradingCandidate, objective: GradingObjective): number =>
  objective === 'net' ? Math.abs(c.netCY) : c.totalCY;

export function rankGradingCandidates(
  candidates: GradingCandidate[],
  objective: GradingObjective
): GradingCandidate[] {
  return candidates.slice().sort((a, b) => {
    if (a.feasible !== b.feasible) return a.feasible ? -1 : 1;
    const sa = objectiveScore(a, objective), sb = objectiveScore(b, objective);
    if (sa !== sb) return sa - sb;
    return a.rotationDeg - b.rotationDeg;
  });
}

// One row of the drafter-facing comparison table: a ranked candidate plus
// its signed earthwork delta vs the CURRENT pose (negative = the candidate
// saves earthwork). The current pose is ALWAYS included — when it falls
// outside the top `topN` ranked rows it is appended so the drafter can
// always compare against where they are today. deltaCY is null when the
// current rotation has no evaluated candidate (e.g. sweep step skipped it).
export interface GradingComparisonRow {
  candidate: GradingCandidate;
  isCurrent: boolean;
  deltaCY: number | null;
}

export function buildGradingComparisonRows(
  result: GradingResult,
  currentRotationDeg: number,
  topN: number = 5
): GradingComparisonRow[] {
  if (result.candidates.length === 0) return [];
  const score = (c: GradingCandidate) => objectiveScore(c, result.objective);
  const current = result.candidates.find(c => c.rotationDeg === currentRotationDeg) ?? null;
  const rows = result.candidates.slice(0, topN);
  if (current && !rows.includes(current)) rows.push(current);
  return rows.map(c => ({
    candidate: c,
    isCurrent: current !== null && c === current,
    deltaCY: current && Number.isFinite(score(c)) && Number.isFinite(score(current))
      ? score(c) - score(current)
      : null,
  }));
}

interface Progress { done: number; total: number }

// Generator core: yields progress after every candidate so the worker can
// stream a progress bar and honor cancellation between evaluations.
export function* gradingSteps(
  boundary: SiteBoundary,
  grid: ElevationGrid,
  config: BessConfiguration,
  targetMW: number,
  targetMWh: number,
  options: LayoutOptions,
  objective: GradingObjective = 'total',
  stepDeg: number = GRADING_STEP_DEG
): Generator<Progress, GradingResult> {
  const step = Number.isFinite(stepDeg) && stepDeg >= 1 ? Math.floor(stepDeg) : GRADING_STEP_DEG;
  const angles: number[] = [];
  for (let d = 0; d < GRADING_MAX_DEG; d += step) angles.push(d);
  const total = angles.length;
  const pivot = polygonPivot(boundary.polygon);

  const candidates: GradingCandidate[] = [];
  let baselineBlocks = 0;
  let done = 0;
  for (const deg of angles) {
    const design = generateSiteDesign(
      boundaryForYardRotation(boundary, deg),
      config, targetMW, targetMWh, options
    );
    if (deg === 0) baselineBlocks = design.blocksPlaced;
    const gridYard = resampleGridForYardRotation(grid, boundary.origin, deg, pivot);
    const rectYard = terrainLocalRect(gridYard, boundary.origin);
    candidates.push(scoreDesign(design, gridYard, rectYard, deg, baselineBlocks));
    done++;
    yield { done, total };
  }
  // The 0° candidate was scored before baselineBlocks was known elsewhere,
  // but its own comparison is against itself — re-mark all candidates with
  // the final baseline so ordering never depends on evaluation order.
  for (const c of candidates) {
    c.feasible = c.feasible && c.blocksPlaced >= baselineBlocks;
  }

  return {
    candidates: rankGradingCandidates(candidates, objective),
    baselineBlocks,
    objective,
    stepDeg: step,
    evaluated: done,
    total,
    cancelled: false,
  };
}

// Synchronous convenience wrapper (tests / non-UI callers).
export function optimizeGrading(
  boundary: SiteBoundary,
  grid: ElevationGrid,
  config: BessConfiguration,
  targetMW: number,
  targetMWh: number,
  options: LayoutOptions,
  objective: GradingObjective = 'total',
  stepDeg: number = GRADING_STEP_DEG
): GradingResult {
  const it = gradingSteps(boundary, grid, config, targetMW, targetMWh, options, objective, stepDeg);
  let r = it.next();
  while (!r.done) r = it.next();
  return r.value;
}
