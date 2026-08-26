// GRADING PLAN sheet (DXF + PDF twin) — construction-package deliverable for
// the proposed FG surface: existing contours screened behind proposed
// contours (major/minor), pad spot elevations, slope arrows, daylight limit,
// swale centerlines with grade labels, discharge points, a legend and the
// earthwork quantities table.
//
// STANDALONE opt-in export: this sheet is NOT registered in the drawing
// package SHEET_REGISTRY and nothing here is imported by dxfExport /
// dxfSheets, so every existing DXF/PDF export stays byte-identical.
// Pure + deterministic (no Date, no randomness) for byte-stable tests.

import polygonClipping from 'polygon-clipping';
import { SiteDesign, Pt } from './types';
import { BessConfiguration } from './catalog';
import {
  DxfWriter,
  LAYERS,
  TitleBlockMeta,
  addBaseLayers,
  addSheetFrame,
  drawContours,
} from './dxfExport';
import {
  ElevationGrid,
  LocalRect,
  ContourSet,
  computeContours,
  pickContourInterval,
  sampleElevationFt,
} from './terrain';
import { FgSurface, fgElevationAt, fgPadElevationAt } from './gradingSurface';
import { DrainageModel } from './drainage';
import { EarthworkCostSummary, buildCostTableRows } from './earthworkCost';
import type { GradingSectionSet } from './gradingSections';

// Grading-plan layers (declared only by this sheet — never in addBaseLayers).
export const GP_LAYERS = {
  PROPOSED: 'C - PROPOSED CONTOUR',
  PROPOSED_MAJOR: 'C - PROPOSED CONTOUR MAJOR',
  DAYLIGHT: 'C - DAYLIGHT LIMIT',
  SPOT: 'C - SPOT ELEVATION',
  SLOPE_ARROW: 'C - SLOPE ARROW',
  SWALE: 'C - SWALE',
  DISCHARGE: 'C - DISCHARGE POINT',
} as const;

// Cut/fill isopach shading bands (opt-in): FG minus existing grade, split by
// depth. Layers are dedicated so reviewers can toggle the shading in CAD.
export interface CutFillBandDef {
  kind: 'cut' | 'fill';
  loFt: number;             // inclusive lower |depth| bound
  hiFt: number;             // exclusive upper |depth| bound (Infinity = open)
  layer: string;
  aci: number;
  label: string;
}

export const CUT_FILL_MIN_DEPTH_FT = 0.5; // |dz| below this is negligible
export const CUT_FILL_BANDS: readonly CutFillBandDef[] = [
  { kind: 'cut',  loFt: 2,   hiFt: Infinity, layer: 'C - CUT OVER 2FT',  aci: 1,  label: 'CUT > 2 FT' },
  { kind: 'cut',  loFt: 0.5, hiFt: 2,        layer: 'C - CUT 6IN-2FT',   aci: 30, label: 'CUT 0.5-2 FT' },
  { kind: 'fill', loFt: 0.5, hiFt: 2,        layer: 'C - FILL 6IN-2FT',  aci: 4,  label: 'FILL 0.5-2 FT' },
  { kind: 'fill', loFt: 2,   hiFt: Infinity, layer: 'C - FILL OVER 2FT', aci: 5,  label: 'FILL > 2 FT' },
] as const;

export interface CutFillBandRegions {
  def: CutFillBandDef;
  // Merged regions in polygon-clipping MultiPolygon shape: polygons -> rings
  // (outer + holes) -> [x, y] vertices, first vertex NOT repeated at the end.
  polygons: number[][][][];
}

export interface CutFillRegionSet {
  bands: CutFillBandRegions[]; // same order as CUT_FILL_BANDS
  cellFt: number;              // lattice cell size used for the banding
}

const GP_COLORS = {
  PROPOSED: 3,        // green (minor proposed)
  PROPOSED_MAJOR: 1,  // red (index proposed + labels)
  DAYLIGHT: 6,        // magenta
  SPOT: 7,
  SLOPE_ARROW: 2,     // yellow
  SWALE: 5,           // blue
  DISCHARGE: 1,       // red
};

export const GRADING_PLAN_SHEET_TITLE = 'GRADING PLAN';

export const GRADING_PLAN_DISCLAIMER =
  'SCREENING-LEVEL GRADING AND DRAINAGE — NOT FOR CONSTRUCTION. ' +
  'FINAL DESIGN REQUIRES A CIVIL GRADING PLAN AND DRAINAGE REPORT PER THE AHJ.';

// ---------------------------------------------------------------------------
// Proposed-surface contour extraction: sample the continuous FG surface on a
// deterministic lattice over the disturbed area (daylight bbox + margin) and
// reuse the Marching Squares engine. Outside the daylight limit fgElevationAt
// returns existing ground, so proposed contours blend into existing at the
// disturbance limit — exactly what a grading plan shows.

export function buildProposedContours(
  grid: ElevationGrid,
  rect: LocalRect,
  fg: FgSurface,
  intervalFt?: number,
  size = 96
): ContourSet {
  const region = fg.daylightPolygon.length >= 3 ? fg.daylightPolygon : fg.fence;
  const xs = region.map(p => p.x), ys = region.map(p => p.y);
  const margin = 25;
  const fgRect: LocalRect = {
    minX: Math.min(...xs) - margin, maxX: Math.max(...xs) + margin,
    minY: Math.min(...ys) - margin, maxY: Math.max(...ys) + margin,
  };
  const n = Math.max(8, Math.floor(size));
  const cellX = (fgRect.maxX - fgRect.minX) / n;
  const cellY = (fgRect.maxY - fgRect.minY) / n;
  const valuesFt: number[] = [];
  let minZ = Infinity, maxZ = -Infinity;
  for (let r = 0; r < n; r++) {
    const y = fgRect.maxY - (r + 0.5) * cellY; // row 0 = north
    for (let c = 0; c < n; c++) {
      const z = fgElevationAt(fg, grid, rect, fgRect.minX + (c + 0.5) * cellX, y);
      valuesFt.push(z);
      if (Number.isFinite(z)) {
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
      }
    }
  }
  const fgGrid: ElevationGrid = {
    width: n, height: n,
    bounds: { west: 0, east: 1, south: 0, north: 1 }, // unused by computeContours
    valuesFt, source: 'proposed FG', resolutionM: 0, noDataCount: 0,
  };
  const interval = intervalFt ?? (maxZ > minZ ? pickContourInterval(minZ, maxZ) : 1);
  return computeContours(fgGrid, fgRect, interval);
}

// ---------------------------------------------------------------------------
// Cut/fill isopach regions: sample dz = existing grade - FG on the same kind
// of deterministic lattice as buildProposedContours, classify each cell into
// a depth band, merge consecutive same-band cells per row into strips, then
// boolean-union the strips per band into clean multi-loop regions (outer
// boundaries + island holes) ready for DXF hatching / PDF fills.

// Shared band classifier: index into CUT_FILL_BANDS for the point (x, y),
// or -1 when the depth is negligible / samples are invalid. Used by the DXF
// region builder AND the 3D preview drape so both always agree.
export function cutFillBandIndexAt(
  grid: ElevationGrid,
  rect: LocalRect,
  fg: FgSurface,
  x: number,
  y: number
): number {
  const fgZ = fgElevationAt(fg, grid, rect, x, y);
  const ogZ = sampleElevationFt(grid, rect, x, y);
  if (!Number.isFinite(fgZ) || !Number.isFinite(ogZ)) return -1;
  const dz = ogZ - fgZ; // + = cut (existing above FG), - = fill
  const depth = Math.abs(dz);
  if (depth < CUT_FILL_MIN_DEPTH_FT) return -1;
  const kind = dz > 0 ? 'cut' : 'fill';
  for (let b = 0; b < CUT_FILL_BANDS.length; b++) {
    const def = CUT_FILL_BANDS[b];
    if (def.kind === kind && depth >= def.loFt && depth < def.hiFt) return b;
  }
  return -1;
}

export function buildCutFillRegions(
  grid: ElevationGrid,
  rect: LocalRect,
  fg: FgSurface,
  size = 72
): CutFillRegionSet {
  const region = fg.daylightPolygon.length >= 3 ? fg.daylightPolygon : fg.fence;
  const xs = region.map(p => p.x), ys = region.map(p => p.y);
  const margin = 10;
  const minX = Math.min(...xs) - margin, maxX = Math.max(...xs) + margin;
  const minY = Math.min(...ys) - margin, maxY = Math.max(...ys) + margin;
  const n = Math.max(8, Math.floor(size));
  const cellX = (maxX - minX) / n;
  const cellY = (maxY - minY) / n;

  // Band index per cell (-1 = none), row-major, row 0 = south.
  const bandAt = (x: number, y: number): number => cutFillBandIndexAt(grid, rect, fg, x, y);

  // Row strips per band: consecutive same-band cells merge into one rect.
  const strips: number[][][][][] = CUT_FILL_BANDS.map(() => []);
  for (let r = 0; r < n; r++) {
    const y0 = minY + r * cellY, y1 = y0 + cellY;
    const yc = (y0 + y1) / 2;
    let runBand = -1, runStart = 0;
    const flush = (endCol: number) => {
      if (runBand < 0) return;
      const x0 = minX + runStart * cellX;
      const x1 = minX + endCol * cellX;
      strips[runBand].push([[[x0, y0], [x1, y0], [x1, y1], [x0, y1]]]);
    };
    for (let c = 0; c < n; c++) {
      const b = bandAt(minX + (c + 0.5) * cellX, yc);
      if (b !== runBand) {
        flush(c);
        runBand = b;
        runStart = c;
      }
    }
    flush(n);
  }

  const bands: CutFillBandRegions[] = CUT_FILL_BANDS.map((def, i) => {
    let polygons: number[][][][] = [];
    if (strips[i].length) {
      const merged = polygonClipping.union(
        strips[i][0] as any, ...(strips[i].slice(1) as any[])
      ) as unknown as number[][][][];
      // Drop the repeated closing vertex polygon-clipping emits per ring.
      polygons = merged.map(poly => poly.map(ring => {
        const pts = ring.slice();
        const a = pts[0], b = pts[pts.length - 1];
        if (pts.length > 1 && a[0] === b[0] && a[1] === b[1]) pts.pop();
        return pts;
      })).filter(poly => poly.length > 0 && poly[0].length >= 3);
    }
    return { def, polygons };
  });

  return { bands, cellFt: Math.max(cellX, cellY) };
}

// Shoelace area of one ring (absolute, sq ft); rings do not repeat the
// closing vertex, so the wrap term uses the first point.
function ringAreaSqFt(ring: number[][]): number {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x0, y0] = ring[i];
    const [x1, y1] = ring[(i + 1) % ring.length];
    sum += x0 * y1 - x1 * y0;
  }
  return Math.abs(sum) / 2;
}

// Net area per band (outer rings minus hole rings), sq ft, in band order.
export function cutFillBandAreasSqFt(set: CutFillRegionSet): number[] {
  return set.bands.map(band => {
    let area = 0;
    for (const poly of band.polygons) {
      for (let r = 0; r < poly.length; r++) {
        const a = ringAreaSqFt(poly[r]);
        area += r === 0 ? a : -a;
      }
    }
    return Math.max(0, area);
  });
}

// Legend-friendly area string: acres at >= 0.25 AC, square feet below.
export function fmtBandArea(sqFt: number): string {
  const AC = 43560;
  if (sqFt >= 0.25 * AC) return `${(sqFt / AC).toFixed(2)} AC`;
  return `${Math.round(sqFt).toLocaleString('en-US')} SF`;
}

// ---------------------------------------------------------------------------
// Sheet composition

export interface GradingPlanData {
  fg: FgSurface;
  proposed: ContourSet;
  existing?: ContourSet | null;   // screened behind the proposed surface
  drainage?: DrainageModel | null; // swales / discharge points (optional)
  // Opt-in cut/fill isopach shading (null/absent = sheet unchanged).
  cutFill?: CutFillRegionSet | null;
  // Opt-in earthwork cost estimate box (null/absent = sheet unchanged).
  cost?: EarthworkCostSummary | null;
  // Opt-in GP-2 cross-section markers (null/absent = sheet unchanged).
  sections?: GradingSectionSet | null;
}

// GP-1 section-line marker layer (only declared when sections are present).
export const GP_SECTION_LINE_LAYER = 'C - SECTION LINE';

// GP-1 grading-zone layer (only declared when the FG surface carries zones).
export const GP_GRADING_ZONE_LAYER = 'C - GRADING ZONE';

const fmtElev = (e: number) => (Number.isInteger(e) ? e.toFixed(0) : e.toFixed(1));
const fmtCY = (v: number) => `${Math.round(v).toLocaleString('en-US')} CY`;

export function buildEarthworkTableRows(fg: FgSurface): string[] {
  const ew = fg.earthwork;
  return [
    `CUT (BANK)            ${fmtCY(ew.cutCY)}`,
    `FILL (COMPACTED)      ${fmtCY(ew.fillCY)}`,
    `NET (RAW)             ${fmtCY(ew.netCY)}`,
    `FILL (BANK, +${fg.inputs.shrinkPct}% SHRINK)  ${fmtCY(ew.adjustedFillCY)}`,
    `ADJUSTED NET          ${fmtCY(Math.abs(ew.adjustedNetCY))} ${ew.adjustedNetCY >= 0 ? 'IMPORT' : 'EXPORT'}`,
    `HAUL (LOOSE, +${fg.inputs.swellPct}% SWELL)  ${fmtCY(ew.haulLooseCY)}`,
    `TOPSOIL STRIP (${fg.inputs.topsoilStripIn}")    ${fmtCY(ew.topsoilCY)}`,
    `DISTURBED AREA        ${(ew.disturbedAreaSqFt / 43560).toFixed(1)} AC`,
  ];
}

export function composeGradingPlanDxf(
  dxf: DxfWriter,
  design: SiteDesign,
  projectName: string,
  data: GradingPlanData,
  config?: BessConfiguration,
  meta?: TitleBlockMeta,
) {
  const { fg, proposed, existing, drainage, cutFill, cost, sections } = data;
  const hasSections = !!sections && sections.sections.length > 0;
  const hasZones = !!fg.zones && fg.zones.length > 0;
  const hasCutFill = !!cutFill && cutFill.bands.some(b => b.polygons.length > 0);
  addBaseLayers(dxf);
  addSheetFrame(dxf, design, projectName, config, meta, undefined, undefined, {
    panels: {
      siteInfo: true, equipDims: false, bom: false, legend: false,
      keyNotes: false, notes: false, disclaimer: true,
    },
    schedule: false,
    sheetLabel: 'SHEET GP-1',
    sheetTitle: GRADING_PLAN_SHEET_TITLE,
    extraBoxes: [
      {
        title: 'EARTHWORK QUANTITIES (SCREENING)',
        rows: buildEarthworkTableRows(fg),
      },
      // Opt-in cost estimate box: only present when the drafter enabled
      // "include cost estimate" — absent, GP-1 bytes are unchanged.
      ...(cost ? [{
        title: 'EARTHWORK COST ESTIMATE (SCREENING)',
        rows: buildCostTableRows(cost),
      }] : []),
      {
        title: 'GRADING LEGEND',
        rows: [
          'EXISTING CONTOUR ......... GRAY DASHED',
          'PROPOSED CONTOUR ......... GREEN / RED INDEX',
          'DAYLIGHT LIMIT ........... MAGENTA DASHED',
          'SPOT ELEVATION ........... FG XXX.X AT FENCE',
          `SLOPE ARROW .............. PAD FALL ${fg.inputs.padSlopePct.toFixed(1)}%`,
          ...(hasCutFill && cutFill ? [
            'CUT SHADING .............. ORANGE 0.5-2 FT / RED > 2 FT',
            'FILL SHADING ............. CYAN 0.5-2 FT / BLUE > 2 FT',
            ...cutFillBandAreasSqFt(cutFill).flatMap((sqFt, i) =>
              cutFill.bands[i].polygons.length
                ? [`  ${CUT_FILL_BANDS[i].label.padEnd(14, ' ')}..... ${fmtBandArea(sqFt)}`]
                : []),
          ] : []),
          ...(drainage ? [
            'SWALE CENTERLINE ......... BLUE, GRADE LABELED',
            'DISCHARGE POINT .......... DP-N, RATIONAL Q',
          ] : []),
          ...(hasSections ? [
            'SECTION LINE ............. MAGENTA DASHED, SEE SHEET GP-2',
          ] : []),
          ...(hasZones && fg.zones ? [
            'GRADING ZONE ............. CYAN RECTANGLE, PAD EL LABELED',
            ...fg.zones.map(z =>
              `  ${z.name.padEnd(14, ' ')}..... ${z.offsetFt >= 0 ? '+' : ''}${z.offsetFt.toFixed(1)} FT${z.mode === 'auto' ? ' (AUTO)' : ''}`),
          ] : []),
        ],
      },
    ],
  });

  // Annotation scale keyed to the parcel span (same rule as the sheet frame).
  const bxs = design.boundary.polygon.map(p => p.x);
  const bys = design.boundary.polygon.map(p => p.y);
  const span = Math.max(
    Math.max(...bxs) - Math.min(...bxs),
    Math.max(...bys) - Math.min(...bys),
    400
  );
  const k = Math.min(Math.max(span / 1200, 0.5), 4);
  const H = 5 * k;

  // Plan context: parcel boundary + fence.
  dxf.addPolyline(design.boundary.polygon.map(p => [p.x, p.y]), LAYERS.BOUNDARY, true);
  dxf.addPolyline(fg.fence.map(p => [p.x, p.y]), LAYERS.FENCE, true);

  // Cut/fill isopach shading (opt-in): drawn first so every contour, label
  // and symbol reads on top of the hatched depth bands.
  if (hasCutFill && cutFill) {
    for (const band of cutFill.bands) {
      if (!band.polygons.length) continue;
      dxf.addLayer(band.def.layer, band.def.aci);
      for (const poly of band.polygons) {
        dxf.addHatchLoops(poly, band.def.layer, 'ANSI31');
      }
    }
  }

  // Existing contours screened behind the proposed surface.
  if (existing && existing.lines.length > 0) drawContours(dxf, existing, design);

  // Proposed contours (major/minor) with index elevation labels.
  dxf.addLayer(GP_LAYERS.PROPOSED, GP_COLORS.PROPOSED);
  dxf.addLayer(GP_LAYERS.PROPOSED_MAJOR, GP_COLORS.PROPOSED_MAJOR);
  for (const line of proposed.lines) {
    if (line.pts.length < 2) continue;
    const layer = line.major ? GP_LAYERS.PROPOSED_MAJOR : GP_LAYERS.PROPOSED;
    dxf.addPolyline(line.pts.map(p => [p.x, p.y]), layer, line.closed);
    if (line.major) {
      const mid = line.pts[Math.floor(line.pts.length / 2)];
      dxf.addText(mid.x + H * 0.4, mid.y + H * 0.4, H * 0.8, fmtElev(line.elevFt), GP_LAYERS.PROPOSED_MAJOR);
    }
  }

  // Daylight (disturbance) limit.
  if (fg.daylightPolygon.length >= 3) {
    dxf.addLayer(GP_LAYERS.DAYLIGHT, GP_COLORS.DAYLIGHT, 'DASHED');
    dxf.addPolyline(fg.daylightPolygon.map(p => [p.x, p.y]), GP_LAYERS.DAYLIGHT, true);
    const dp0 = fg.daylightPolygon[0];
    dxf.addText(dp0.x + H * 0.5, dp0.y + H * 0.5, H * 0.8, 'DAYLIGHT / DISTURBANCE LIMIT', GP_LAYERS.DAYLIGHT);
  }

  // Pad spot elevations at the fence corners: cross + "FG xxx.x".
  dxf.addLayer(GP_LAYERS.SPOT, GP_COLORS.SPOT);
  const tick = H * 0.6;
  for (const p of fg.fence) {
    const z = fgPadElevationAt(fg, p.x, p.y);
    if (!Number.isFinite(z)) continue;
    dxf.addLine(p.x - tick, p.y, p.x + tick, p.y, GP_LAYERS.SPOT);
    dxf.addLine(p.x, p.y - tick, p.x, p.y + tick, GP_LAYERS.SPOT);
    dxf.addText(p.x + tick * 1.3, p.y + tick * 1.3, H * 0.8, `FG ${fmtElev(z)}`, GP_LAYERS.SPOT);
  }

  // Slope arrows: one per bench, at the fence centroid shifted along the
  // downhill axis to the bench center, pointing downhill.
  dxf.addLayer(GP_LAYERS.SLOPE_ARROW, GP_COLORS.SLOPE_ARROW);
  const cx = fg.fence.reduce((s, p) => s + p.x, 0) / fg.fence.length;
  const cy = fg.fence.reduce((s, p) => s + p.y, 0) / fg.fence.length;
  const cProj = cx * fg.dir.x + cy * fg.dir.y;
  const aLen = Math.min(60, Math.max(25, span / 20));
  for (const b of fg.benches) {
    const pc = (b.proj0 + b.proj1) / 2;
    const px = cx + fg.dir.x * (pc - cProj);
    const py = cy + fg.dir.y * (pc - cProj);
    const x0 = px - fg.dir.x * aLen / 2, y0 = py - fg.dir.y * aLen / 2;
    const x1 = px + fg.dir.x * aLen / 2, y1 = py + fg.dir.y * aLen / 2;
    dxf.addLine(x0, y0, x1, y1, GP_LAYERS.SLOPE_ARROW);
    // Arrowhead: two barbs swept back 30° from the tip.
    const ang = Math.atan2(y1 - y0, x1 - x0);
    const hl = aLen * 0.22;
    for (const da of [Math.PI - 0.5236, Math.PI + 0.5236]) {
      dxf.addLine(x1, y1, x1 + hl * Math.cos(ang + da), y1 + hl * Math.sin(ang + da), GP_LAYERS.SLOPE_ARROW);
    }
    dxf.addText(px + H * 0.6, py + H * 0.6, H * 0.8,
      `${fg.inputs.padSlopePct.toFixed(1)}%${fg.benches.length > 1 ? ` (BENCH ${b.index + 1})` : ''}`,
      GP_LAYERS.SLOPE_ARROW);
    dxf.addText(px + H * 0.6, py - H * 1.2, H * 0.7,
      `PAD EL ${fmtElev(b.baseElevFt)}`, GP_LAYERS.SLOPE_ARROW);
  }

  // Grading-zone pads (opt-in): rectangle outline, name + pad elevation
  // label at the center, and spot elevations at the four zone corners.
  // Absent zones keep GP-1 byte-identical.
  if (hasZones && fg.zones) {
    dxf.addLayer(GP_GRADING_ZONE_LAYER, 4); // cyan
    for (const z of fg.zones) {
      dxf.addPolyline(
        [[z.x0, z.y0], [z.x1, z.y0], [z.x1, z.y1], [z.x0, z.y1]],
        GP_GRADING_ZONE_LAYER, true);
      const zx = (z.x0 + z.x1) / 2, zy = (z.y0 + z.y1) / 2;
      const padEl = fgPadElevationAt(fg, zx, zy);
      dxf.addText(zx + H * 0.4, zy + H * 0.4, H * 0.9, z.name.toUpperCase(), GP_GRADING_ZONE_LAYER);
      dxf.addText(zx + H * 0.4, zy - H * 1.1, H * 0.8,
        `PAD EL ${fmtElev(padEl)} (${z.offsetFt >= 0 ? '+' : ''}${z.offsetFt.toFixed(1)} FT${z.mode === 'auto' ? ' AUTO' : ''})`,
        GP_GRADING_ZONE_LAYER);
      for (const [cx2, cy2] of [[z.x0, z.y0], [z.x1, z.y0], [z.x1, z.y1], [z.x0, z.y1]] as const) {
        const cz = fgPadElevationAt(fg, cx2, cy2);
        if (!Number.isFinite(cz)) continue;
        dxf.addLine(cx2 - tick, cy2, cx2 + tick, cy2, GP_LAYERS.SPOT);
        dxf.addLine(cx2, cy2 - tick, cx2, cy2 + tick, GP_LAYERS.SPOT);
        dxf.addText(cx2 + tick * 1.3, cy2 + tick * 1.3, H * 0.7, `FG ${fmtElev(cz)}`, GP_LAYERS.SPOT);
      }
    }
  }

  // Section-line markers (opt-in): drawn only when the GP-2 export is
  // enabled — absent/null keeps GP-1 byte-identical.
  if (hasSections && sections) {
    dxf.addLayer(GP_SECTION_LINE_LAYER, 6, 'DASHED');
    for (const s of sections.sections) {
      dxf.addLine(s.p0.x, s.p0.y, s.p1.x, s.p1.y, GP_SECTION_LINE_LAYER);
      const dx = (s.p1.x - s.p0.x) / (s.lengthFt || 1);
      const dy = (s.p1.y - s.p0.y) / (s.lengthFt || 1);
      const tick2 = H * 1.2;
      for (const e of [s.p0, s.p1]) {
        dxf.addLine(e.x - dy * tick2, e.y + dx * tick2, e.x + dy * tick2, e.y - dx * tick2, GP_SECTION_LINE_LAYER);
      }
      dxf.addText(s.p0.x - dx * H * 3 + H * 0.4, s.p0.y - dy * H * 3 + H * 0.4, H * 1.1,
        s.label, GP_SECTION_LINE_LAYER);
      dxf.addText(s.p1.x + dx * H * 1.5 + H * 0.4, s.p1.y + dy * H * 1.5 + H * 0.4, H * 1.1,
        `${s.label}'`, GP_SECTION_LINE_LAYER);
    }
  }

  // Drainage: swale centerlines with grade labels + discharge points.
  if (drainage) {
    if (drainage.swales.length > 0) dxf.addLayer(GP_LAYERS.SWALE, GP_COLORS.SWALE);
    drainage.swales.forEach(sw => {
      if (sw.pts.length < 2) return;
      dxf.addPolyline(sw.pts.map(p => [p.x, p.y]), GP_LAYERS.SWALE);
      const mid = sw.pts[Math.floor(sw.pts.length / 2)];
      dxf.addText(mid.x + H * 0.4, mid.y + H * 0.4, H * 0.7,
        `SWALE ${Math.round(sw.lengthFt)} LF @ ${drainage.inputs.swaleGradePct}% TO DP-${sw.dischargeIdx + 1}`,
        GP_LAYERS.SWALE);
    });
    if (drainage.discharges.length > 0) dxf.addLayer(GP_LAYERS.DISCHARGE, GP_COLORS.DISCHARGE);
    drainage.discharges.forEach((d, i) => {
      const r0 = H * 0.9;
      dxf.addArc(d.p.x, d.p.y, r0, 0, Math.PI * 2, true, GP_LAYERS.DISCHARGE);
      dxf.addLine(d.p.x - r0, d.p.y - r0, d.p.x + r0, d.p.y + r0, GP_LAYERS.DISCHARGE);
      dxf.addLine(d.p.x - r0, d.p.y + r0, d.p.x + r0, d.p.y - r0, GP_LAYERS.DISCHARGE);
      dxf.addText(d.p.x + r0 * 1.4, d.p.y + r0 * 1.4, H * 0.8,
        `DP-${i + 1}  Q=${d.qCfs.toFixed(1)} CFS (${d.areaAcres.toFixed(1)} AC)`,
        GP_LAYERS.DISCHARGE);
    });
  }

  // Screening disclaimer inside the plan area (south of the parcel).
  const minY = Math.min(...bys);
  const minX = Math.min(...bxs);
  dxf.addText(minX, minY - H * 4, H * 0.9, GRADING_PLAN_DISCLAIMER, LAYERS.TEXT_SM);
  dxf.addText(minX, minY - H * 6, H * 0.9,
    `PROPOSED CONTOUR INTERVAL ${proposed.intervalFt} FT (INDEX EVERY ${proposed.majorEveryFt} FT). ` +
    `BALANCE SHIFT ${fg.earthwork.balanceShiftFt >= 0 ? '+' : ''}${fg.earthwork.balanceShiftFt.toFixed(2)} FT.`,
    LAYERS.TEXT_SM);
}

export function buildGradingPlanDxfString(
  design: SiteDesign,
  projectName: string,
  data: GradingPlanData,
  config?: BessConfiguration,
  meta?: TitleBlockMeta,
): string {
  const dxf = new DxfWriter();
  composeGradingPlanDxf(dxf, design, projectName, data, config, meta);
  return dxf.toString();
}
