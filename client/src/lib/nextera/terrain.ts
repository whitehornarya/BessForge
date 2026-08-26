// Terrain awareness: elevation grid types + pure analysis math.
// Data comes from the server-side USGS 3DEP proxy (/api/elevation) — public
// domain 1/3 arc-second (~10 m) elevation. Everything here is SCREENING-GRADE
// analysis: 3D preview, summary panel, and the opt-in DXF contour reference
// layers (contoursForDxf). Terrain never touches the layout engine or the
// default drawing geometry — the default DXF stays byte-identical.
//
// All functions are pure and deterministic so they run in Node tests on
// synthetic grids.

import { Pt } from './types';
import { pointInPolygon } from './kmz';
import { apiFetchJson } from '../api/fetch';

// Same local-feet projection constants as kmz.ts / satellite.ts, so the
// terrain drape registers exactly with the parcel geometry.
const FT_PER_DEG_LAT = 364000;
export const M_TO_FT = 3.28084;

export interface ElevationGrid {
  width: number;   // columns
  height: number;  // rows (row 0 = north edge)
  bounds: { west: number; east: number; south: number; north: number }; // WGS84 deg
  valuesFt: number[]; // row-major elevations in FEET; NaN = no data
  source: string;       // e.g. "USGS 3DEP (1/3 arc-second)"
  resolutionM: number;  // approx source cell size in meters
  noDataCount: number;
}

interface ElevationApiResponse {
  width: number;
  height: number;
  bounds: ElevationGrid['bounds'];
  valuesFt: Array<number | null>;
  source: string;
  resolutionM: number;
}

// Coverage requested for a parcel: the fence/boundary bbox plus a margin so
// the terrain extends past the yard (default half the parcel span, capped).
export function terrainCoverageBbox(
  polygon: Pt[],
  origin: { lat: number; lon: number }
): { west: number; east: number; north: number; south: number } {
  const xs = polygon.map(p => p.x);
  const ys = polygon.map(p => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const span = Math.max(maxX - minX, maxY - minY);
  const margin = Math.min(Math.max(span * 0.5, 300), 3000); // ft
  const ftPerDegLon = FT_PER_DEG_LAT * Math.cos((origin.lat * Math.PI) / 180);
  return {
    west: origin.lon + (minX - margin) / ftPerDegLon,
    east: origin.lon + (maxX + margin) / ftPerDegLon,
    south: origin.lat + (minY - margin) / FT_PER_DEG_LAT,
    north: origin.lat + (maxY + margin) / FT_PER_DEG_LAT,
  };
}

// Fetch the elevation grid from the server proxy. Throws with a
// human-readable message on any failure — callers surface it and fall back
// to flat ground with an explicit label (never silently fake elevation).
export async function fetchElevationGrid(
  bbox: { west: number; east: number; north: number; south: number },
  size = 96
): Promise<ElevationGrid> {
  const { data } = await apiFetchJson<ElevationApiResponse>('/api/elevation', {
    west: bbox.west, east: bbox.east, south: bbox.south, north: bbox.north, size,
  }, { ttlMs: 30 * 24 * 60 * 60 * 1000, provenance: 'USGS 3DEP' });
  return gridFromApi(data);
}

export function gridFromApi(data: ElevationApiResponse): ElevationGrid {
  const valuesFt = data.valuesFt.map(v => (v === null || !Number.isFinite(v) ? NaN : v));
  const noDataCount = valuesFt.reduce((n, v) => n + (Number.isNaN(v) ? 1 : 0), 0);
  if (noDataCount === valuesFt.length) {
    throw new Error('Elevation source returned no data for this location.');
  }
  return {
    width: data.width,
    height: data.height,
    bounds: data.bounds,
    valuesFt,
    source: data.source,
    resolutionM: data.resolutionM,
    noDataCount,
  };
}

// WGS84 grid bounds -> local-feet rectangle in the layout frame (same
// projection as kmz.ts / satellite.ts).
export interface LocalRect { minX: number; maxX: number; minY: number; maxY: number }

export function terrainLocalRect(
  grid: Pick<ElevationGrid, 'bounds'>,
  origin: { lat: number; lon: number }
): LocalRect {
  const ftPerDegLon = FT_PER_DEG_LAT * Math.cos((origin.lat * Math.PI) / 180);
  return {
    minX: (grid.bounds.west - origin.lon) * ftPerDegLon,
    maxX: (grid.bounds.east - origin.lon) * ftPerDegLon,
    minY: (grid.bounds.south - origin.lat) * FT_PER_DEG_LAT,
    maxY: (grid.bounds.north - origin.lat) * FT_PER_DEG_LAT,
  };
}

// Fill no-data cells with the nearest finite value (row scan then column
// scan), so rendering and analysis never see NaN. Returns a new grid; the
// original noDataCount is preserved for the disclosure UI.
export function fillNoData(grid: ElevationGrid): ElevationGrid {
  if (grid.noDataCount === 0) return grid;
  const v = grid.valuesFt.slice();
  const { width, height } = grid;
  const finiteMean = (() => {
    let s = 0, n = 0;
    for (const x of v) if (!Number.isNaN(x)) { s += x; n++; }
    return n ? s / n : 0;
  })();
  for (let r = 0; r < height; r++) {
    // forward + backward fill along the row
    let last = NaN;
    for (let c = 0; c < width; c++) {
      const i = r * width + c;
      if (Number.isNaN(v[i])) { if (!Number.isNaN(last)) v[i] = last; }
      else last = v[i];
    }
    last = NaN;
    for (let c = width - 1; c >= 0; c--) {
      const i = r * width + c;
      if (Number.isNaN(v[i])) { if (!Number.isNaN(last)) v[i] = last; }
      else last = v[i];
    }
  }
  // any fully-empty rows: column fill, then mean
  for (let c = 0; c < width; c++) {
    let last = NaN;
    for (let r = 0; r < height; r++) {
      const i = r * width + c;
      if (Number.isNaN(v[i])) { if (!Number.isNaN(last)) v[i] = last; }
      else last = v[i];
    }
    last = NaN;
    for (let r = height - 1; r >= 0; r--) {
      const i = r * width + c;
      if (Number.isNaN(v[i])) { if (!Number.isNaN(last)) v[i] = last; }
      else last = v[i];
    }
  }
  for (let i = 0; i < v.length; i++) if (Number.isNaN(v[i])) v[i] = finiteMean;
  return { ...grid, valuesFt: v };
}

// Bilinear elevation sample at a local-feet point. Values sit at cell
// centers; points outside the rect clamp to the edge. NaN cells propagate
// (use fillNoData first for rendering).
export function sampleElevationFt(
  grid: ElevationGrid,
  rect: LocalRect,
  x: number,
  y: number
): number {
  const { width, height, valuesFt } = grid;
  const fx = ((x - rect.minX) / (rect.maxX - rect.minX)) * width - 0.5;
  const fy = ((rect.maxY - y) / (rect.maxY - rect.minY)) * height - 0.5; // row 0 = north
  const cx = Math.min(Math.max(fx, 0), width - 1);
  const cy = Math.min(Math.max(fy, 0), height - 1);
  const c0 = Math.floor(cx), r0 = Math.floor(cy);
  const c1 = Math.min(c0 + 1, width - 1), r1 = Math.min(r0 + 1, height - 1);
  const tx = cx - c0, ty = cy - r0;
  const v00 = valuesFt[r0 * width + c0];
  const v01 = valuesFt[r0 * width + c1];
  const v10 = valuesFt[r1 * width + c0];
  const v11 = valuesFt[r1 * width + c1];
  return (v00 * (1 - tx) + v01 * tx) * (1 - ty) + (v10 * (1 - tx) + v11 * tx) * ty;
}

// Per-cell grade percent (rise/run * 100) via central differences in the
// local-feet frame. Same layout (row-major, row 0 = north) as the grid.
export interface SlopeGrid {
  width: number;
  height: number;
  slopePct: number[]; // per cell
  maxSlopePct: number;
  meanSlopePct: number;
}

export function computeSlopeGrid(grid: ElevationGrid, rect: LocalRect): SlopeGrid {
  const { width, height, valuesFt } = grid;
  const cellX = (rect.maxX - rect.minX) / width;
  const cellY = (rect.maxY - rect.minY) / height;
  const slopePct = new Array<number>(width * height);
  let maxS = 0, sum = 0, n = 0;
  const at = (r: number, c: number) =>
    valuesFt[Math.min(Math.max(r, 0), height - 1) * width + Math.min(Math.max(c, 0), width - 1)];
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      const zx1 = at(r, c + 1), zx0 = at(r, c - 1);
      const zy1 = at(r - 1, c), zy0 = at(r + 1, c); // row decreases northward (+y)
      const spanX = (Math.min(c + 1, width - 1) - Math.max(c - 1, 0)) * cellX;
      const spanY = (Math.min(r + 1, height - 1) - Math.max(r - 1, 0)) * cellY;
      const dzdx = spanX > 0 ? (zx1 - zx0) / spanX : 0;
      const dzdy = spanY > 0 ? (zy1 - zy0) / spanY : 0;
      const s = 100 * Math.hypot(dzdx, dzdy);
      const val = Number.isFinite(s) ? s : 0;
      slopePct[r * width + c] = val;
      if (val > maxS) maxS = val;
      sum += val;
      n++;
    }
  }
  return { width, height, slopePct, maxSlopePct: maxS, meanSlopePct: n ? sum / n : 0 };
}

// Slope percent at a local point (bilinear over the slope grid).
export function sampleSlopePct(slope: SlopeGrid, rect: LocalRect, x: number, y: number): number {
  const pseudo: ElevationGrid = {
    width: slope.width,
    height: slope.height,
    bounds: { west: 0, east: 1, south: 0, north: 1 },
    valuesFt: slope.slopePct,
    source: '',
    resolutionM: 0,
    noDataCount: 0,
  };
  return sampleElevationFt(pseudo, rect, x, y);
}

// Rough-grading estimate for the fenced yard: a single flat pad at the
// elevation that minimizes total earthwork (cut + fill), i.e. the median of
// the sampled existing-ground elevations inside the fence. Volumes assume
// vertical cuts at the fence line (screening-grade — no slopes/benching,
// no shrink/swell factors).
export interface CutFillEstimate {
  padElevationFt: number;
  cutCY: number;      // material removed (existing above pad)
  fillCY: number;     // material added (existing below pad)
  netCY: number;      // fill - cut; positive = net import
  areaSqFt: number;   // fenced area sampled
  sampleSpacingFt: number;
  minElevFt: number;
  maxElevFt: number;
}

export function computeCutFill(
  grid: ElevationGrid,
  rect: LocalRect,
  fence: Pt[],
  sampleSpacingFt?: number
): CutFillEstimate | null {
  if (fence.length < 3) return null;
  const xs = fence.map(p => p.x), ys = fence.map(p => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const span = Math.max(maxX - minX, maxY - minY);
  // Default spacing: ~120 samples across the yard, min 5 ft (deterministic).
  const step = sampleSpacingFt ?? Math.max(5, span / 120);
  const samples: number[] = [];
  for (let y = minY + step / 2; y < maxY; y += step) {
    for (let x = minX + step / 2; x < maxX; x += step) {
      if (!pointInPolygon({ x, y }, fence)) continue;
      const z = sampleElevationFt(grid, rect, x, y);
      if (Number.isFinite(z)) samples.push(z);
    }
  }
  if (!samples.length) return null;
  const sorted = samples.slice().sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const pad = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const cellArea = step * step; // sq ft per sample
  let cutCF = 0, fillCF = 0;
  for (const z of samples) {
    if (z > pad) cutCF += (z - pad) * cellArea;
    else fillCF += (pad - z) * cellArea;
  }
  const CF_PER_CY = 27;
  return {
    padElevationFt: pad,
    cutCY: cutCF / CF_PER_CY,
    fillCY: fillCF / CF_PER_CY,
    netCY: (fillCF - cutCF) / CF_PER_CY,
    areaSqFt: samples.length * cellArea,
    sampleSpacingFt: step,
    minElevFt: sorted[0],
    maxElevFt: sorted[sorted.length - 1],
  };
}

// Steep-zone screening: which placed blocks / roads sit on existing grades
// above the threshold. Checks the EXISTING ground slope under each item —
// the screening question is "how much grading does this parcel need", so
// steep natural ground under the yard is exactly the flag we want.
export interface SteepZoneReport {
  thresholdPct: number;
  maxSlopePct: number;      // over the checked items
  items: Array<{ label: string; slopePct: number }>;
}

export function findSteepZones(
  slope: SlopeGrid,
  rect: LocalRect,
  design: {
    equipment: Array<{ label: string; id: string; x: number; y: number; length: number; width: number; rotation: number; kind: string }>;
    roads: Array<{ x: number; y: number; length: number; width: number; rotation: number }>;
    aisles: Array<{ x: number; y: number; length: number; width: number; rotation: number }>;
  },
  thresholdPct: number
): SteepZoneReport {
  const items: Array<{ label: string; slopePct: number }> = [];
  let overallMax = 0;
  const rectMax = (cx: number, cy: number, len: number, wid: number, rot: number): number => {
    // sample a 3x3 lattice over the (rotated) rectangle
    const cos = Math.cos(rot), sin = Math.sin(rot);
    let m = 0;
    for (let a = -1; a <= 1; a++) {
      for (let b = -1; b <= 1; b++) {
        const lx = (a * len) / 2, ly = (b * wid) / 2;
        const x = cx + lx * cos - ly * sin;
        const y = cy + lx * sin + ly * cos;
        const s = sampleSlopePct(slope, rect, x, y);
        if (Number.isFinite(s) && s > m) m = s;
      }
    }
    return m;
  };
  for (const e of design.equipment) {
    // Screen the primary yard items (containers + inverters); small panels
    // ride on the same pads.
    if (e.kind !== 'bess' && e.kind !== 'inverter') continue;
    const s = rectMax(e.x, e.y, e.length, e.width, e.rotation);
    if (s > overallMax) overallMax = s;
    if (s > thresholdPct) items.push({ label: e.label || e.id, slopePct: s });
  }
  const roadLike = [...design.roads, ...design.aisles];
  roadLike.forEach((r, i) => {
    const s = rectMax(r.x, r.y, r.length, r.width, r.rotation);
    if (s > overallMax) overallMax = s;
    if (s > thresholdPct) items.push({ label: `Road segment ${i + 1}`, slopePct: s });
  });
  items.sort((a, b) => b.slopePct - a.slopePct || a.label.localeCompare(b.label));
  return { thresholdPct, maxSlopePct: overallMax, items };
}

// ---------------------------------------------------------------------------
// Elevation contour lines (3D preview only — never exported).
// Marching squares over the elevation grid (values at cell centers), with
// linear interpolation of the crossing points and greedy joining of the
// resulting segments into polylines. Pure + deterministic for Node tests.

export interface ContourLine {
  elevFt: number;   // contour level (absolute site elevation, feet)
  major: boolean;   // index contour (every `majorEvery`-th level)
  pts: Pt[];        // polyline vertices in the local-feet frame
  closed: boolean;  // first/last point coincide (closed loop)
}

export interface ContourSet {
  intervalFt: number;
  majorEveryFt: number;
  lines: ContourLine[];
}

// Pick a drafting-friendly interval from the site relief, aiming for roughly
// 8–16 contour lines across the parcel (the classic 1/2/5 ladder).
export function pickContourInterval(minElevFt: number, maxElevFt: number): number {
  const relief = Math.max(maxElevFt - minElevFt, 0);
  const candidates = [0.5, 1, 2, 5, 10, 20, 25, 50, 100, 200];
  for (const c of candidates) {
    if (relief / c <= 16) return c;
  }
  return candidates[candidates.length - 1];
}

// Quantize a coordinate for endpoint matching when chaining segments.
const keyOf = (p: Pt) => `${Math.round(p.x * 100)},${Math.round(p.y * 100)}`;

export function computeContours(
  grid: ElevationGrid,
  rect: LocalRect,
  intervalFt: number,
  majorEvery = 5
): ContourSet {
  const { width, height, valuesFt } = grid;
  const lines: ContourLine[] = [];
  if (!(intervalFt > 0) || width < 2 || height < 2) {
    return { intervalFt, majorEveryFt: intervalFt * majorEvery, lines };
  }
  let minV = Infinity, maxV = -Infinity;
  for (const v of valuesFt) {
    if (!Number.isFinite(v)) continue;
    if (v < minV) minV = v;
    if (v > maxV) maxV = v;
  }
  if (!(maxV > minV)) return { intervalFt, majorEveryFt: intervalFt * majorEvery, lines };

  // Cell-center coordinates in the local frame (row 0 = north).
  const cellX = (rect.maxX - rect.minX) / width;
  const cellY = (rect.maxY - rect.minY) / height;
  const cx = (c: number) => rect.minX + (c + 0.5) * cellX;
  const cy = (r: number) => rect.maxY - (r + 0.5) * cellY;
  const at = (r: number, c: number) => valuesFt[r * width + c];

  const firstLevel = Math.ceil(minV / intervalFt) * intervalFt;
  for (let level = firstLevel; level <= maxV; level += intervalFt) {
    // Levels landing exactly on grid values create degenerate topology;
    // nudge by an epsilon far below drafting significance.
    const z = level + intervalFt * 1e-6;
    const segs: Array<[Pt, Pt]> = [];
    const lerp = (pa: Pt, va: number, pb: Pt, vb: number): Pt => {
      const t = (z - va) / (vb - va);
      return { x: pa.x + (pb.x - pa.x) * t, y: pa.y + (pb.y - pa.y) * t };
    };
    for (let r = 0; r < height - 1; r++) {
      for (let c = 0; c < width - 1; c++) {
        const v0 = at(r, c), v1 = at(r, c + 1), v2 = at(r + 1, c + 1), v3 = at(r + 1, c);
        if (!Number.isFinite(v0) || !Number.isFinite(v1) || !Number.isFinite(v2) || !Number.isFinite(v3)) continue;
        const p0 = { x: cx(c), y: cy(r) };
        const p1 = { x: cx(c + 1), y: cy(r) };
        const p2 = { x: cx(c + 1), y: cy(r + 1) };
        const p3 = { x: cx(c), y: cy(r + 1) };
        // Corner bitmask: 1 = above the level.
        let idx = 0;
        if (v0 > z) idx |= 1;
        if (v1 > z) idx |= 2;
        if (v2 > z) idx |= 4;
        if (v3 > z) idx |= 8;
        if (idx === 0 || idx === 15) continue;
        const eTop = () => lerp(p0, v0, p1, v1);
        const eRight = () => lerp(p1, v1, p2, v2);
        const eBottom = () => lerp(p3, v3, p2, v2);
        const eLeft = () => lerp(p0, v0, p3, v3);
        switch (idx) {
          case 1: case 14: segs.push([eLeft(), eTop()]); break;
          case 2: case 13: segs.push([eTop(), eRight()]); break;
          case 3: case 12: segs.push([eLeft(), eRight()]); break;
          case 4: case 11: segs.push([eRight(), eBottom()]); break;
          case 6: case 9: segs.push([eTop(), eBottom()]); break;
          case 7: case 8: segs.push([eLeft(), eBottom()]); break;
          case 5: // saddle: resolve by center mean
          case 10: {
            const mean = (v0 + v1 + v2 + v3) / 4;
            const centerAbove = mean > z;
            if ((idx === 5) === centerAbove) {
              segs.push([eLeft(), eTop()]);
              segs.push([eRight(), eBottom()]);
            } else {
              segs.push([eTop(), eRight()]);
              segs.push([eLeft(), eBottom()]);
            }
            break;
          }
        }
      }
    }
    // Chain segments into polylines via endpoint matching.
    const byStart = new Map<string, number[]>();
    segs.forEach((s, i) => {
      const k = keyOf(s[0]);
      const arr = byStart.get(k);
      if (arr) arr.push(i); else byStart.set(k, [i]);
      const k2 = keyOf(s[1]);
      const arr2 = byStart.get(k2);
      if (arr2) arr2.push(i); else byStart.set(k2, [i]);
    });
    const used = new Array<boolean>(segs.length).fill(false);
    const takeNext = (pt: Pt, exclude: number): { seg: number; flipped: boolean } | null => {
      const arr = byStart.get(keyOf(pt));
      if (!arr) return null;
      for (const i of arr) {
        if (used[i] || i === exclude) continue;
        if (keyOf(segs[i][0]) === keyOf(pt)) return { seg: i, flipped: false };
        if (keyOf(segs[i][1]) === keyOf(pt)) return { seg: i, flipped: true };
      }
      return null;
    };
    const isMajor = Math.round(level / intervalFt) % majorEvery === 0;
    for (let i = 0; i < segs.length; i++) {
      if (used[i]) continue;
      used[i] = true;
      const pts: Pt[] = [segs[i][0], segs[i][1]];
      // Extend forward
      let last = i;
      for (;;) {
        const nxt = takeNext(pts[pts.length - 1], last);
        if (!nxt) break;
        used[nxt.seg] = true;
        last = nxt.seg;
        pts.push(nxt.flipped ? segs[nxt.seg][0] : segs[nxt.seg][1]);
      }
      // Extend backward
      last = i;
      for (;;) {
        const nxt = takeNext(pts[0], last);
        if (!nxt) break;
        used[nxt.seg] = true;
        last = nxt.seg;
        pts.unshift(nxt.flipped ? segs[nxt.seg][1] : segs[nxt.seg][0]);
      }
      const closed = keyOf(pts[0]) === keyOf(pts[pts.length - 1]);
      lines.push({ elevFt: level, major: isMajor, pts, closed });
    }
  }
  return { intervalFt, majorEveryFt: intervalFt * majorEvery, lines };
}

// ---------------------------------------------------------------------------
// Grading tie-in / daylight limits (3D preview only — never exported).
// The yard pad is graded flat at the cut/fill pad elevation; where the pad
// edge (fence line) meets natural ground, a cut or fill slope must daylight
// into the existing grade. This samples the fence perimeter, classifies each
// stretch as CUT (natural ground above the pad) or FILL (below), and offsets
// a daylight line outward by slopeRatio * |dz| (clamped) — how a civil
// grading plan reads its grading-limit line. Pure + deterministic for tests.

export interface GradingTieInRun {
  kind: 'cut' | 'fill';
  pts: Pt[];         // tie-in samples on the fence line
  daylightPts: Pt[]; // parallel outward daylight points (same length)
  dzFt: number[];    // natural minus pad elevation at each sample (same length)
  maxDzFt: number;   // max |dz| over the run
}

export interface GradingTieIn {
  runs: GradingTieInRun[];
  slopeRatio: number;   // horizontal : vertical (e.g. 3 = 3:1 slopes)
  maxOffsetFt: number;  // daylight offset clamp
  maxCutFt: number;     // deepest cut at the fence line (0 if none)
  maxFillFt: number;    // tallest fill at the fence line (0 if none)
}

export function computeGradingTieIn(
  grid: ElevationGrid,
  rect: LocalRect,
  fence: Pt[],
  padElevationFt: number,
  opts?: { stepFt?: number; slopeRatio?: number; maxOffsetFt?: number; minDzFt?: number }
): GradingTieIn | null {
  if (fence.length < 3) return null;
  const stepFt = opts?.stepFt ?? 10;
  const slopeRatio = opts?.slopeRatio ?? 3;
  const maxOffsetFt = opts?.maxOffsetFt ?? 80;
  const minDzFt = opts?.minDzFt ?? 0.25;

  // Polygon orientation (shoelace): decides which edge normal points outward.
  let area2 = 0;
  for (let i = 0; i < fence.length; i++) {
    const a = fence[i], b = fence[(i + 1) % fence.length];
    area2 += a.x * b.y - b.x * a.y;
  }
  const ccw = area2 > 0;

  // Walk the perimeter, sampling every ~stepFt along each edge (always
  // including edge start points so corners are represented).
  type Sample = { p: Pt; n: Pt; dz: number };
  const samples: Sample[] = [];
  for (let i = 0; i < fence.length; i++) {
    const a = fence[i], b = fence[(i + 1) % fence.length];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (!(len > 1e-6)) continue;
    // Outward normal: for CCW polygons the interior is to the left of the
    // edge direction, so outward = right-hand normal (dy, -dx)/len.
    const s = ccw ? 1 : -1;
    const n = { x: (s * dy) / len, y: (-s * dx) / len };
    const count = Math.max(1, Math.round(len / stepFt));
    for (let k = 0; k < count; k++) {
      const t = k / count;
      const p = { x: a.x + dx * t, y: a.y + dy * t };
      const z = sampleElevationFt(grid, rect, p.x, p.y);
      samples.push({ p, n, dz: Number.isFinite(z) ? z - padElevationFt : 0 });
    }
  }
  if (!samples.length) return null;

  const kindOf = (dz: number): 'cut' | 'fill' | null =>
    dz > minDzFt ? 'cut' : dz < -minDzFt ? 'fill' : null;

  // Split into consecutive same-kind runs around the closed loop. Rotate so
  // the loop starts at a kind boundary (deterministic and never splits a run
  // across the seam).
  let start = 0;
  for (let i = 0; i < samples.length; i++) {
    const prev = samples[(i + samples.length - 1) % samples.length];
    if (kindOf(samples[i].dz) !== kindOf(prev.dz)) { start = i; break; }
  }
  const runs: GradingTieInRun[] = [];
  let cur: Sample[] = [];
  let curKind: 'cut' | 'fill' | null = null;
  const flush = () => {
    if (curKind && cur.length >= 2) {
      const dzFt = cur.map(sm => sm.dz);
      runs.push({
        kind: curKind,
        pts: cur.map(sm => sm.p),
        daylightPts: cur.map(sm => {
          const off = Math.min(Math.abs(sm.dz) * slopeRatio, maxOffsetFt);
          return { x: sm.p.x + sm.n.x * off, y: sm.p.y + sm.n.y * off };
        }),
        dzFt,
        maxDzFt: Math.max(...dzFt.map(Math.abs)),
      });
    }
    cur = [];
    curKind = null;
  };
  for (let i = 0; i < samples.length; i++) {
    const sm = samples[(start + i) % samples.length];
    const k = kindOf(sm.dz);
    if (k !== curKind) {
      flush();
      curKind = k;
    }
    if (k) cur.push(sm);
  }
  flush();

  let maxCut = 0, maxFill = 0;
  for (const r of runs) {
    if (r.kind === 'cut') maxCut = Math.max(maxCut, r.maxDzFt);
    else maxFill = Math.max(maxFill, r.maxDzFt);
  }
  return { runs, slopeRatio, maxOffsetFt, maxCutFt: maxCut, maxFillFt: maxFill };
}

// Contours ready for the DXF reference-layer export: local-feet frame around
// the given origin, auto interval (1/2/5 ladder) when intervalFt is 0/absent.
// Returns null when the grid has no usable relief (no lines to draw).
export function contoursForDxf(
  grid: ElevationGrid,
  origin: { lat: number; lon: number },
  intervalFt = 0
): ContourSet | null {
  const rect = terrainLocalRect(grid, origin);
  let minV = Infinity, maxV = -Infinity;
  for (const v of grid.valuesFt) {
    if (!Number.isFinite(v)) continue;
    if (v < minV) minV = v;
    if (v > maxV) maxV = v;
  }
  if (!(maxV > minV)) return null;
  const interval = intervalFt > 0 ? intervalFt : pickContourInterval(minV, maxV);
  const cs = computeContours(grid, rect, interval);
  return cs.lines.length > 0 ? cs : null;
}

// Green -> yellow -> red color ramp for the slope heatmap (0 .. maxPct).
// Returns [r, g, b] each 0..1. Exported so the legend and the mesh agree.
export function slopeRampColor(slopePct: number, maxPct: number): [number, number, number] {
  const t = Math.min(Math.max(slopePct / Math.max(maxPct, 1e-6), 0), 1);
  if (t < 0.5) {
    const u = t / 0.5; // green -> yellow
    return [0.15 + 0.75 * u, 0.75, 0.2 - 0.05 * u];
  }
  const u = (t - 0.5) / 0.5; // yellow -> red
  return [0.9, 0.75 - 0.55 * u, 0.15 - 0.05 * u];
}
