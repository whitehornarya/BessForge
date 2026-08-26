// GRADING CROSS-SECTIONS sheet (GP-2, DXF + PDF twin) — 2-4 automatic
// section lines cut through the graded yard, each rendered as a profile
// strip: existing ground (OG, dashed) vs finished grade (FG, solid) sampled
// along the line, cut/fill hatched between the traces, an elevation grid
// with station labels, daylight points, vertical exaggeration note and the
// screening disclaimer.
//
// STANDALONE opt-in export exactly like GP-1: never registered in the
// drawing package SHEET_REGISTRY, never imported by dxfExport / dxfSheets,
// so every existing DXF/PDF export stays byte-identical. Pure +
// deterministic (no Date, no randomness) for byte-stable tests.

import { SiteDesign, Pt } from './types';
import { BessConfiguration } from './catalog';
import {
  DxfWriter,
  LAYERS,
  TitleBlockMeta,
  addBaseLayers,
  addSheetFrame,
} from './dxfExport';
import { ElevationGrid, LocalRect, sampleElevationFt } from './terrain';
import { FgSurface, fgElevationAt } from './gradingSurface';
import { GRADING_PLAN_DISCLAIMER } from './gradingPlan';

// Cross-section layers (declared only by this sheet / the GP-1 markers).
export const XS_LAYERS = {
  SECTION_LINE: 'C - SECTION LINE',   // GP-1 plan markers (A-A', B-B', ...)
  OG: 'X - OG PROFILE',
  FG: 'X - FG PROFILE',
  CUT: 'X - CUT AREA',
  FILL: 'X - FILL AREA',
  GRID: 'X - SECTION GRID',
  TEXT: 'X - SECTION TEXT',
  DAYLIGHT: 'X - DAYLIGHT POINT',
  ZONE: 'X - GRADING ZONE',
} as const;

const XS_COLORS = {
  SECTION_LINE: 6, // magenta
  OG: 8,           // gray dashed
  FG: 3,           // green solid
  CUT: 1,          // red hatch
  FILL: 5,         // blue hatch
  GRID: 8,
  TEXT: 7,
  DAYLIGHT: 6,
  ZONE: 4,        // cyan — matches the GP-1 grading-zone layer color
};

export const GRADING_SECTIONS_SHEET_TITLE = 'GRADING CROSS-SECTIONS';

// |FG - OG| below this reads as "grades match" (daylight / undisturbed).
export const DAYLIGHT_EPS_FT = 0.05;

export interface SectionSample {
  station: number; // ft along the section from p0
  og: number;      // existing ground elevation, ft
  fg: number;      // finished grade elevation, ft
}

// Station interval where the section line passes through a grading zone
// rectangle (multi-pad grading, opt-in). The FG trace already carries the
// zone pad elevation via fgElevationAt; the crossing marks WHERE so the
// strip can label the zone consistently with the GP-1 plan annotations.
export interface ZoneCrossing {
  name: string;     // zone name as annotated on GP-1
  sta0: number;     // entry station, ft
  sta1: number;     // exit station, ft
  offsetFt: number; // resolved pad offset from the base FG surface
  mode: 'offset' | 'auto';
}

export interface SectionLine {
  label: string;        // 'A', 'B', ...
  p0: Pt;               // plan start (station 0)
  p1: Pt;               // plan end
  lengthFt: number;
  samples: SectionSample[];
  daylightStations: number[]; // stations where |FG-OG| crosses DAYLIGHT_EPS_FT
  // Present ONLY when the section crosses at least one grading zone —
  // absent, the section JSON stays byte-identical to the zone-free engine.
  zoneCrossings?: ZoneCrossing[];
}

export interface GradingSectionSet {
  sections: SectionLine[];
  sampleCount: number;
}

// ---------------------------------------------------------------------------
// Section engine: automatic placement from the FG surface geometry.
//   A-A' — along the downhill grading axis through the fence centroid
//   B-B' — perpendicular to it through the centroid
//   C/D  — (opt-in) perpendicular lines at the quarter points of the axis
// Extents span the daylight polygon (fence when daylight is degenerate)
// plus a margin so both traces visibly merge into existing ground.

const SECTION_MARGIN_FT = 25;

function polygonCentroid(poly: Pt[]): Pt {
  const n = poly.length || 1;
  return {
    x: poly.reduce((s, p) => s + p.x, 0) / n,
    y: poly.reduce((s, p) => s + p.y, 0) / n,
  };
}

// Extent of a polygon projected onto a unit direction, about a center point.
function projExtent(poly: Pt[], c: Pt, dir: Pt): { tMin: number; tMax: number } {
  let tMin = Infinity, tMax = -Infinity;
  for (const p of poly) {
    const t = (p.x - c.x) * dir.x + (p.y - c.y) * dir.y;
    if (t < tMin) tMin = t;
    if (t > tMax) tMax = t;
  }
  if (!Number.isFinite(tMin) || tMax <= tMin) { tMin = -200; tMax = 200; }
  return { tMin: tMin - SECTION_MARGIN_FT, tMax: tMax + SECTION_MARGIN_FT };
}

function sampleSection(
  label: string,
  p0: Pt,
  p1: Pt,
  grid: ElevationGrid,
  rect: LocalRect,
  fg: FgSurface,
  sampleCount: number
): SectionLine {
  const lengthFt = Math.hypot(p1.x - p0.x, p1.y - p0.y);
  const samples: SectionSample[] = [];
  for (let i = 0; i <= sampleCount; i++) {
    const t = i / sampleCount;
    const x = p0.x + (p1.x - p0.x) * t;
    const y = p0.y + (p1.y - p0.y) * t;
    const og = sampleElevationFt(grid, rect, x, y);
    const fgZ = fgElevationAt(fg, grid, rect, x, y);
    samples.push({ station: lengthFt * t, og, fg: fgZ });
  }
  // Daylight points: stations where the graded surface meets existing
  // ground — |FG-OG| crosses the epsilon in either direction. Interpolated
  // linearly on |diff| between adjacent samples.
  const daylightStations: number[] = [];
  for (let i = 0; i + 1 < samples.length; i++) {
    const a = samples[i], b = samples[i + 1];
    if (!Number.isFinite(a.og) || !Number.isFinite(b.og) ||
        !Number.isFinite(a.fg) || !Number.isFinite(b.fg)) continue;
    const da = Math.abs(a.fg - a.og), db = Math.abs(b.fg - b.og);
    const inA = da <= DAYLIGHT_EPS_FT, inB = db <= DAYLIGHT_EPS_FT;
    if (inA === inB) continue;
    const u = Math.abs(db - da) > 1e-12 ? (DAYLIGHT_EPS_FT - da) / (db - da) : 0.5;
    daylightStations.push(a.station + (b.station - a.station) * Math.min(1, Math.max(0, u)));
  }
  const line: SectionLine = { label, p0, p1, lengthFt, samples, daylightStations };
  // Grading-zone crossings: slab-clip the section segment against each zone
  // rectangle. Attached only when at least one zone is crossed, so the
  // zero-zone section JSON stays byte-identical to the legacy engine.
  if (fg.zones && fg.zones.length) {
    const crossings: ZoneCrossing[] = [];
    const dx = p1.x - p0.x, dy = p1.y - p0.y;
    for (const z of fg.zones) {
      let t0 = 0, t1 = 1;
      let ok = true;
      for (const [d, lo, hi, o] of [
        [dx, z.x0, z.x1, p0.x] as const,
        [dy, z.y0, z.y1, p0.y] as const,
      ]) {
        if (Math.abs(d) < 1e-12) {
          if (o < lo || o > hi) { ok = false; break; }
        } else {
          const ta = (lo - o) / d, tb = (hi - o) / d;
          t0 = Math.max(t0, Math.min(ta, tb));
          t1 = Math.min(t1, Math.max(ta, tb));
        }
      }
      if (!ok || t1 <= t0) continue;
      crossings.push({
        name: z.name,
        sta0: lengthFt * t0,
        sta1: lengthFt * t1,
        offsetFt: z.offsetFt,
        mode: z.mode,
      });
    }
    if (crossings.length) {
      crossings.sort((a, b) => a.sta0 - b.sta0);
      line.zoneCrossings = crossings;
    }
  }
  return line;
}

export interface GradingSectionOptions {
  quarterPoints?: boolean; // add C-C' / D-D' at the axis quarter points
  sampleCount?: number;    // samples per section (default 160)
}

export function buildGradingSections(
  grid: ElevationGrid,
  rect: LocalRect,
  fg: FgSurface,
  opts: GradingSectionOptions = {}
): GradingSectionSet {
  const sampleCount = Math.max(16, Math.floor(opts.sampleCount ?? 160));
  const region = fg.daylightPolygon.length >= 3 ? fg.daylightPolygon : fg.fence;
  const c = polygonCentroid(fg.fence);
  const dir = fg.dir;
  const perp: Pt = { x: -dir.y, y: dir.x };

  const axis = projExtent(region, c, dir);
  const cross = projExtent(region, c, perp);

  const at = (base: Pt, d: Pt, t: number): Pt => ({ x: base.x + d.x * t, y: base.y + d.y * t });

  const sections: SectionLine[] = [
    // A-A': along the downhill grading axis through the yard centroid.
    sampleSection('A', at(c, dir, axis.tMin), at(c, dir, axis.tMax), grid, rect, fg, sampleCount),
    // B-B': perpendicular through the centroid.
    sampleSection('B', at(c, perp, cross.tMin), at(c, perp, cross.tMax), grid, rect, fg, sampleCount),
  ];
  if (opts.quarterPoints) {
    // C-C' / D-D': perpendicular cuts at the quarter points of the axis.
    const q1 = at(c, dir, axis.tMin + SECTION_MARGIN_FT + (axis.tMax - axis.tMin - 2 * SECTION_MARGIN_FT) * 0.25);
    const q3 = at(c, dir, axis.tMin + SECTION_MARGIN_FT + (axis.tMax - axis.tMin - 2 * SECTION_MARGIN_FT) * 0.75);
    sections.push(
      sampleSection('C', at(q1, perp, cross.tMin), at(q1, perp, cross.tMax), grid, rect, fg, sampleCount),
      sampleSection('D', at(q3, perp, cross.tMin), at(q3, perp, cross.tMax), grid, rect, fg, sampleCount),
    );
  }
  return { sections, sampleCount };
}

// ---------------------------------------------------------------------------
// GP-2 sheet composition: one profile strip per section, stacked inside the
// plan area (the boundary bbox drives the sheet-frame annotation scale, so
// the strips are laid out over that same footprint).

const fmtElev = (e: number) => (Number.isInteger(e) ? e.toFixed(0) : e.toFixed(1));

// Nice-number ladders for the elevation grid, station ticks and the
// vertical exaggeration note.
const pickStep = (span: number, targetTicks: number, ladder: number[]): number => {
  const raw = span / Math.max(1, targetTicks);
  for (const v of ladder) if (v >= raw) return v;
  return ladder[ladder.length - 1];
};
const ELEV_LADDER = [0.5, 1, 2, 5, 10, 20, 50, 100];
const STA_LADDER = [25, 50, 100, 200, 250, 500, 1000, 2000];
const VE_LADDER = [1, 2, 5, 10, 20, 50];

// Cut/fill closed loops between the OG and FG traces of one section, in
// strip coordinates. Regions split at every OG/FG crossing; each loop runs
// OG forward then FG backward. Pure geometry, exported for tests.
export function sectionCutFillLoops(
  samples: SectionSample[],
  sx: (station: number) => number,
  sy: (elev: number) => number
): { cut: number[][][]; fill: number[][][] } {
  const cut: number[][][] = [];
  const fill: number[][][] = [];
  let run: SectionSample[] = [];
  let runKind: 'cut' | 'fill' | null = null;

  const flush = () => {
    if (runKind && run.length >= 2) {
      const loop: number[][] = [
        ...run.map(s => [sx(s.station), sy(s.og)]),
        ...run.slice().reverse().map(s => [sx(s.station), sy(s.fg)]),
      ];
      (runKind === 'cut' ? cut : fill).push(loop);
    }
    run = [];
    runKind = null;
  };

  const kindOf = (s: SectionSample): 'cut' | 'fill' | null => {
    if (!Number.isFinite(s.og) || !Number.isFinite(s.fg)) return null;
    const d = s.og - s.fg;
    if (Math.abs(d) <= DAYLIGHT_EPS_FT) return null;
    return d > 0 ? 'cut' : 'fill';
  };

  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    const k = kindOf(s);
    if (k !== runKind) {
      // Close the old region and open the new one at the crossing sample so
      // adjacent loops share the boundary point (no gaps between hatches).
      const prev = run.length ? run[run.length - 1] : null;
      flush();
      if (k && prev) run.push(prev);
      runKind = k;
    }
    if (runKind) run.push(s);
  }
  flush();
  return { cut, fill };
}

export function composeGradingSectionsDxf(
  dxf: DxfWriter,
  design: SiteDesign,
  projectName: string,
  sections: GradingSectionSet,
  config?: BessConfiguration,
  meta?: TitleBlockMeta,
) {
  const secs = sections.sections;
  const hasZones = secs.some(s => !!s.zoneCrossings && s.zoneCrossings.length > 0);
  addBaseLayers(dxf);
  addSheetFrame(dxf, design, projectName, config, meta, undefined, undefined, {
    panels: {
      siteInfo: true, equipDims: false, bom: false, legend: false,
      keyNotes: false, notes: false, disclaimer: true,
    },
    schedule: false,
    sheetLabel: 'SHEET GP-2',
    sheetTitle: GRADING_SECTIONS_SHEET_TITLE,
    extraBoxes: [
      {
        title: 'SECTION INDEX',
        rows: secs.map(s =>
          `${s.label}-${s.label}'  ${s.label === 'A' ? 'ALONG GRADE AXIS' : 'PERPENDICULAR CUT'}  L=${Math.round(s.lengthFt)} FT`),
      },
      {
        title: 'SECTION LEGEND',
        rows: [
          'EXISTING GROUND (OG) ..... GRAY DASHED',
          'FINISHED GRADE (FG) ...... GREEN SOLID',
          'CUT AREA ................. RED HATCH',
          'FILL AREA ................ BLUE HATCH',
          'DAYLIGHT POINT ........... MAGENTA CIRCLE',
          ...(hasZones ? [
            'GRADING ZONE ............. CYAN BRACKET, SEE SHEET GP-1',
          ] : []),
          'SECTION LINES SHOWN ON SHEET GP-1',
        ],
      },
    ],
  });

  // Annotation scale keyed to the parcel span (same rule as the sheet frame).
  const bxs = design.boundary.polygon.map(p => p.x);
  const bys = design.boundary.polygon.map(p => p.y);
  const minX = Math.min(...bxs), maxX = Math.max(...bxs);
  const minY = Math.min(...bys), maxY = Math.max(...bys);
  const span = Math.max(maxX - minX, maxY - minY, 400);
  const k = Math.min(Math.max(span / 1200, 0.5), 4);
  const H = 5 * k;

  dxf.addLayer(XS_LAYERS.OG, XS_COLORS.OG, 'DASHED');
  dxf.addLayer(XS_LAYERS.FG, XS_COLORS.FG);
  dxf.addLayer(XS_LAYERS.CUT, XS_COLORS.CUT);
  dxf.addLayer(XS_LAYERS.FILL, XS_COLORS.FILL);
  dxf.addLayer(XS_LAYERS.GRID, XS_COLORS.GRID);
  dxf.addLayer(XS_LAYERS.TEXT, XS_COLORS.TEXT);
  dxf.addLayer(XS_LAYERS.DAYLIGHT, XS_COLORS.DAYLIGHT);
  if (hasZones) dxf.addLayer(XS_LAYERS.ZONE, XS_COLORS.ZONE, 'DASHED');

  // Strip layout: stacked top-to-bottom across the plan-area footprint. The
  // left gutter carries the elevation labels; below each strip its stations.
  const gutter = H * 8;
  const x0 = minX + gutter;
  const stripW = Math.max(200, maxX - minX - gutter);
  const n = secs.length;
  const titleH = H * 2.4;   // per-strip title line
  const staH = H * 3;       // station label band under the grid
  const gap = H * 3;
  const slotH = (maxY - minY) / n;
  const stripH = Math.max(H * 8, slotH - titleH - staH - gap);

  secs.forEach((s, i) => {
    const top = maxY - i * slotH;
    const gy0 = top - titleH - stripH; // grid bottom (baseline)
    const gy1 = top - titleH;          // grid top

    // Elevation window over the finite samples, padded.
    let zMin = Infinity, zMax = -Infinity;
    for (const sm of s.samples) {
      for (const z of [sm.og, sm.fg]) {
        if (!Number.isFinite(z)) continue;
        if (z < zMin) zMin = z;
        if (z > zMax) zMax = z;
      }
    }
    if (!Number.isFinite(zMin) || zMax <= zMin) { zMin = 0; zMax = 1; }
    const zPad = Math.max(0.5, (zMax - zMin) * 0.1);
    zMin -= zPad; zMax += zPad;

    const hScale = stripW / Math.max(1, s.lengthFt); // sheet ft per plan ft
    // Vertical exaggeration: largest ladder value that keeps the elevation
    // window inside the strip; noted on the strip title.
    const rawVE = (stripH / Math.max(0.5, zMax - zMin)) / hScale;
    let ve = VE_LADDER[0];
    for (const v of VE_LADDER) if (v <= rawVE) ve = v;
    const vScale = hScale * ve;

    const sx = (sta: number) => x0 + sta * hScale;
    const sy = (z: number) => gy0 + (z - zMin) * vScale;
    const yTop = Math.min(gy1, sy(zMax));

    // Title with the vertical exaggeration note.
    dxf.addText(x0, top - H * 1.6, H * 1.1,
      `SECTION ${s.label}-${s.label}'  (VERT EXAG ${ve}X, STA IN FT)`, XS_LAYERS.TEXT);

    // Grid border.
    dxf.addPolyline([[x0, gy0], [x0 + stripW, gy0], [x0 + stripW, yTop], [x0, yTop]], XS_LAYERS.GRID, true);

    // Elevation gridlines + labels (left gutter).
    const eStep = pickStep(zMax - zMin, 5, ELEV_LADDER);
    for (let z = Math.ceil(zMin / eStep) * eStep; z <= zMax + 1e-9; z += eStep) {
      const y = sy(z);
      if (y > yTop + 1e-6) break;
      dxf.addLine(x0, y, x0 + stripW, y, XS_LAYERS.GRID);
      dxf.addText(x0 - gutter + H * 0.4, y + H * 0.15, H * 0.8, `EL ${fmtElev(z)}`, XS_LAYERS.TEXT);
    }

    // Station ticks + labels (bottom band).
    const sStep = pickStep(s.lengthFt, 8, STA_LADDER);
    for (let sta = 0; sta <= s.lengthFt + 1e-9; sta += sStep) {
      const x = sx(sta);
      dxf.addLine(x, gy0, x, gy0 - H * 0.8, XS_LAYERS.GRID);
      dxf.addText(x + H * 0.2, gy0 - H * 2, H * 0.8, `${Math.round(sta)}`, XS_LAYERS.TEXT);
    }

    // Cut/fill hatching between the traces (drawn first, traces on top).
    const loops = sectionCutFillLoops(s.samples, sx, sy);
    for (const loop of loops.cut) dxf.addHatchLoops([loop], XS_LAYERS.CUT, 'ANSI31');
    for (const loop of loops.fill) dxf.addHatchLoops([loop], XS_LAYERS.FILL, 'ANSI31');

    // OG (dashed) and FG (solid) traces over finite samples.
    const finite = s.samples.filter(sm => Number.isFinite(sm.og) && Number.isFinite(sm.fg));
    if (finite.length >= 2) {
      dxf.addPolyline(finite.map(sm => [sx(sm.station), sy(sm.og)]), XS_LAYERS.OG);
      dxf.addPolyline(finite.map(sm => [sx(sm.station), sy(sm.fg)]), XS_LAYERS.FG);
    }

    // Grading-zone brackets above the strip: dashed verticals at the entry/
    // exit stations, a tie bar over the top, and the zone name + pad offset
    // label — the profile counterpart of the GP-1 zone rectangles.
    for (const zc of s.zoneCrossings ?? []) {
      const zx0 = sx(zc.sta0), zx1 = sx(zc.sta1);
      const yBar = yTop + H * 1.2;
      dxf.addLine(zx0, gy0, zx0, yBar, XS_LAYERS.ZONE);
      dxf.addLine(zx1, gy0, zx1, yBar, XS_LAYERS.ZONE);
      dxf.addLine(zx0, yBar, zx1, yBar, XS_LAYERS.ZONE);
      dxf.addText((zx0 + zx1) / 2 - H * 6, yBar + H * 0.4, H * 0.9,
        `${zc.name.toUpperCase()} (PAD ${zc.offsetFt >= 0 ? '+' : ''}${zc.offsetFt.toFixed(1)} FT${zc.mode === 'auto' ? ' AUTO' : ''})`,
        XS_LAYERS.ZONE);
    }

    // End labels A / A' at the trace ends.
    dxf.addText(x0 - H * 2.2, yTop + H * 0.5, H * 1.1, s.label, XS_LAYERS.TEXT);
    dxf.addText(x0 + stripW + H * 0.6, yTop + H * 0.5, H * 1.1, `${s.label}'`, XS_LAYERS.TEXT);

    // Daylight points: circle on the FG trace + 'DL' tag.
    for (const sta of s.daylightStations) {
      // Interpolate FG at the daylight station from the bracketing samples.
      let z: number | null = null;
      for (let j = 0; j + 1 < s.samples.length; j++) {
        const a = s.samples[j], b = s.samples[j + 1];
        if (sta >= a.station && sta <= b.station &&
            Number.isFinite(a.fg) && Number.isFinite(b.fg)) {
          const u = b.station > a.station ? (sta - a.station) / (b.station - a.station) : 0;
          z = a.fg + (b.fg - a.fg) * u;
          break;
        }
      }
      if (z === null) continue;
      const px = sx(sta), py = sy(z);
      dxf.addArc(px, py, H * 0.5, 0, Math.PI * 2, true, XS_LAYERS.DAYLIGHT);
      dxf.addText(px + H * 0.7, py + H * 0.7, H * 0.7, 'DL', XS_LAYERS.DAYLIGHT);
    }
  });

  // Screening disclaimer + exaggeration note south of the strips.
  dxf.addText(minX, minY - H * 4, H * 0.9, GRADING_PLAN_DISCLAIMER, LAYERS.TEXT_SM);
  dxf.addText(minX, minY - H * 6, H * 0.9,
    'PROFILES ARE VERTICALLY EXAGGERATED (SEE EACH SECTION TITLE). ' +
    'SECTION LOCATIONS SHOWN ON SHEET GP-1.',
    LAYERS.TEXT_SM);
}

export function buildGradingSectionsDxfString(
  design: SiteDesign,
  projectName: string,
  sections: GradingSectionSet,
  config?: BessConfiguration,
  meta?: TitleBlockMeta,
): string {
  const dxf = new DxfWriter();
  composeGradingSectionsDxf(dxf, design, projectName, sections, config, meta);
  return dxf.toString();
}
