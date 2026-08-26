// Multi-sheet DXF drawing package: a registry of sheet composers built on
// the shared drawing core in dxfExport.ts. Every sheet is a standalone
// AC1015 DXF (same writer, same layer table, same sheet frame) that draws
// the layer/annotation subset relevant to that discipline. The legacy
// combined single-sheet export (buildDesignDxfString) is untouched.
import { SiteDesign, Pt } from './types';
import { BessConfiguration } from './catalog';
import { FeederCircuit } from './feeders';
import {
  DxfWriter,
  LAYERS,
  TitleBlockMeta,
  SheetFrameOptions,
  addBaseLayers,
  addSheetFrame,
  addSpacingDimensions,
  addEquipmentSchedule,
  addTrenchSectionSchedule,
  drawBoundaryAndFence,
  drawTrench,
  drawCables,
  drawEquipment,
  drawEquipmentLabels,
  drawReservedZones,
  drawRoads,
  drawSurfacing,
  drawFeedersAndSubstation,
  drawGate,
  drawContours,
  drawGrounding,
  drawAreaZones,
} from './dxfExport';
import { areaZoneKindsPresent } from './areaZones';
import { ContourSet } from './terrain';
import { GroundingPlan } from './grounding';
import {
  drawEquipmentDetailSheet,
  bessPcsDetailItems,
  auxDetailItems,
} from './dxfDetails';
import { buildSldDxfString } from './sld';
import { buildBomSheetDxfString } from './bomSheet';
import { drawVicinityMap, clipSeg } from './vicinityMap';
import { planEnlargedTiles, drawEnlargedKeyGrid, buildEnlargedPlanDxfString } from './enlargedPlans';
import { areaSheetPlans, buildAreaSheetDxfString } from './areaSheets';
import type { DrawingVisibilityProfile } from './drawingVisibility';

export interface SheetContext {
  design: SiteDesign;
  projectName: string;
  config?: BessConfiguration;
  meta?: TitleBlockMeta;
  feeders?: FeederCircuit[];
  substation?: Pt | null;
  /** Visibility controls for generated design linework only. */
  drawingVisibility?: DrawingVisibilityProfile;
  // MULTI-AREA ONLY: whole-site composition inputs (every area's design, each
  // area's own routed feeders, and which areas the export covers). Present ⇒
  // the design plot page composes the selected footprints exactly as the CAD
  // view draws them. Absent, or resolving to a single area, keeps every sheet
  // byte-identical to the legacy single-design output.
  site?: import('./siteCompose').SiteComposeInput | null;
  // Optional site-vicinity aerial mosaic (Cesium ion / Bing) rendered on the
  // PDF cover page only. DXF output never embeds raster imagery, and tests
  // that require byte-deterministic PDFs simply omit this field.
  coverImage?: {
    dataUrl: string;
    widthPx: number;
    heightPx: number;
    caption?: string;
    // Local-feet rectangle (layout frame) the mosaic spans, from
    // satelliteLocalRect(). When present, the PDF cover draws the design
    // layout (fence, equipment, roads) georegistered on top of the image.
    localRect?: { minX: number; maxX: number; minY: number; maxY: number };
  } | null;
  // Opt-in grading-optimized yard rotation (deg, CCW) + pivot (layout feet).
  // Only the PDF cover overlay uses it: design geometry lives in the yard
  // frame while the mosaic is geo-registered, so overlay strokes rotate by
  // +deg about the pivot (yard -> geo) before mapping onto the photo.
  // Absent/undefined keeps every output byte-identical to the default.
  yardRotation?: { deg: number; pivot: Pt } | null;
  // Opt-in existing-grade contour reference layers (same set the single-sheet
  // export draws). Absent/null/empty keeps every sheet byte-identical to the
  // default output.
  contours?: ContourSet | null;
  // Opt-in grounding screening plan (same rule: absent/null keeps every
  // sheet byte-identical to the default output).
  grounding?: GroundingPlan | null;
  // Opt-in typical trench section schedule (CAR-D-B006-1/2) on the cable &
  // trench plan sheet (same rule: absent/false keeps sheets byte-identical).
  trenchSections?: boolean;
  // Opt-in standards-compliant single-line diagram sheet APPENDED to the
  // drawing package/plot set (absent/null ⇒ package byte-identical to the
  // default; the seven registry sheets never change).
  sldSheet?: { options?: import('./sld').SldOptions } | null;
  // Opt-in bill-of-materials schedule sheet, same append-only rule.
  bomSheet?: { options?: import('./bomSheet').BomSheetOptions } | null;
  // Opt-in "Issued for 10%" cover page (reference: ECI issued-for-review
  // title sheets): stylized vector vicinity map (left panel), site aerial
  // with georegistered layout overlay (right panel), leader lines, project
  // stats and ISSUED FOR 10% REVIEW stamps. Absent/null keeps the legacy
  // cover byte-identical. The vicinity map and the overlay are pure vector
  // (DXF-safe); only the PDF adds the aerial raster under the right panel.
  // Opt-in legacy full-area crushed-rock GRAVEL mesh ("X ground mesh") on
  // the site/road plan sheets. Default (absent/false) draws surfacing
  // region outlines only — the only ground mesh left is the future
  // augmentation ANSI37 area, per drafter direction.
  surfacingMesh?: boolean;
  // Opt-in drafter-drawn area zones (dry pond / wet pond / laydown yard /
  // underground exclusion rectangles) on the site plan sheet + matching
  // legend rows. Absent/empty keeps every sheet byte-identical.
  areaZones?: import('./areaZones').AreaZone[] | null;
  // Opt-in ECI reference legend equipment symbols (legend swatch glyphs
  // only). Absent/false keeps every sheet byte-identical.
  eciLegend?: boolean;
  // When true, the AUX FEEDER legend row carries a (MAN) suffix.
  // Absent/false keeps every sheet byte-identical.
  auxManRoute?: boolean;
  // Controls plan-area feeder callouts and the NFPA setback dimension only.
  // Sheet-frame legends and notes always remain visible.
  includeFeederNfpaAnnotations?: boolean;
  // Client-captured hi-fi 3D renders for the 10% cover (PDF ONLY — the DXF
  // cover keeps the pure-vector overlay; raster never enters DXF). topDown
  // spans exactly cover10.aerial.localRect (ortho, plan-registered); hero is
  // a perspective beauty shot placed as a small framed inset.
  coverRenders?: {
    topDown?: { dataUrl: string; widthPx: number; heightPx: number } | null;
    hero?: { dataUrl: string; widthPx: number; heightPx: number } | null;
  } | null;
  // Opt-in dedicated full-site top-down ortho render page appended to the
  // PDF plot set (10% Package export only): realistic 3D models over the
  // deepest-zoom satellite ground, supersampled client capture. PDF ONLY —
  // raster never enters DXF. Absent keeps the plot set byte-identical.
  siteRender?: { dataUrl: string; widthPx: number; heightPx: number; caption?: string } | null;
  // Opt-in enlarged partial site-plan tiles (10% exports): appended AREA
  // sheets at a readable standard scale with match lines + key-plan insets,
  // plus the matching key grid on the overall site plan. No-op on parcels
  // whose overall plan already prints readable. Absent/false keeps the DXF
  // package and PDF plot set byte-identical.
  enlargedPlans?: boolean;
  // Opt-in drafter text-label overrides (position/height/content deltas keyed
  // by textOverrideKey). Applied to every sheet's DXF entity stream so that
  // both individual-sheet and package exports reflect drafter edits.
  // Absent/empty keeps every sheet byte-identical to the default output.
  textOverrides?: Record<string, import('./dxfExport').TextOverride>;
  cover10?: {
    vicinity: import('./vicinityMap').VicinityData | null;
    // Local-feet rect the aerial mosaic spans (satelliteLocalRect). Needed in
    // DXF too (for georegistering the vector overlay in the right panel) even
    // though the raster itself is PDF-only.
    aerial?: { localRect: { minX: number; maxX: number; minY: number; maxY: number } } | null;
    statsLine?: string;    // e.g. "100.0 MW/4 HR PROJECT"
    locationLine?: string; // e.g. "KIT CARSON COUNTY, COLORADO"
    coordinateLine?: string; // e.g. "36.3558°N, 99.1520°W"
  } | null;
}

export interface SheetDef {
  id: string;        // stable id, e.g. 'cover'
  fileTag: string;   // filename fragment, e.g. 'Cover_Sheet'
  title: string;     // title-block sheet title
  // Panel subset + extra boxes for this sheet's frame
  frame: (ctx: SheetContext) => Omit<SheetFrameOptions, 'sheetLabel' | 'sheetTitle'>;
  // Plan-area geometry for this sheet (may be a no-op, e.g. cover)
  compose: (dxf: DxfWriter, ctx: SheetContext) => void;
}

// ---------------------------------------------------------------------------
// "Issued for 10%" cover composition
// ---------------------------------------------------------------------------

// Geometry of the 10% cover, derived from the boundary extents so the page
// transform frames it like every other sheet. All rects in model feet.
// Width/height aspect of the 3D-model cover panel. The panel is pw × ph
// (same portrait rect as the vicinity/aerial panels: pw = RW·0.34,
// ph = RH·0.56 = RW·1.325·(22/34)·0.56). Derived from the same constants
// used in cover10Region so the hero capture always fills the frame.
// = 0.34 / (1.325 × (22/34) × 0.56) ≈ 0.7082
export const COVER10_PANEL_ASPECT = 0.34 / (1.325 * (22 / 34) * 0.56);

export function cover10Region(design: SiteDesign) {
  const xs = design.boundary.polygon.map(p => p.x);
  const ys = design.boundary.polygon.map(p => p.y);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const S = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), 400);
  // Region aspect: once the right-hand panel column (~0.325·RW at frame
  // scale k≈RW/1200) is appended, the OVERALL frame should match the
  // printable ANSI D landscape (34:22) so the cover prints the same size
  // as every other sheet instead of fitting short by width.
  const RW = S * 1.4;
  const RH = RW * 1.325 * (22 / 34);
  const L = cx - RW / 2, B = cy - RH / 2;
  // Original two-panel layout: vicinity (left) and aerial (right) sit wide in
  // the main area at pw = RW·0.34. The 3D model panel is placed east of the
  // main area in the title-block column, which coverSheet.frame() widens to pw
  // via framePW so all three panels print at the same size.
  const pw = RW * 0.34;
  const ph = RH * 0.56;
  const py = B + RH * 0.26;
  // Gap between the main area right edge and the panel column — must match the
  // GAP that addSheetFrame uses for the cover sheet (scaleBar not set → 60·k).
  // span = max(RW, RH, 400) = RW here; k = clamp(RW/1200, 0.5, 4).
  const kFrame = Math.min(Math.max(Math.max(RW, RH, 400) / 1200, 0.5), 4);
  const colGap = 60 * kFrame;
  return {
    L, B, RW, RH,
    left:  { x: L + RW * 0.08,           y: py, w: pw, h: ph },
    right: { x: L + RW - RW * 0.08 - pw, y: py, w: pw, h: ph },
    // 3D model panel: same portrait size (pw × ph) as the vicinity/aerial
    // panels, placed in the lower-right of the title-block column — BELOW
    // the info panels (Site Info, Sheet Index, Reference Drawings, title
    // stamp), near the bottom of the frame.  A 5% bottom margin keeps the
    // panel clear of the frame border stroke; the title-block panel stack
    // sits above (the stack takes ~33–38% of RH from the top, leaving the
    // lower ~55% for the model panel + gap).
    model: { x: L + RW + colGap, y: B + RH * 0.05, w: pw, h: ph },
  };
}

// Legacy contain-fit placement for callers that need to show the entire
// aerial. The 10% cover itself uses cover10AerialCoverPlacement below: all
// three cover images share one printed panel size, so the aerial is
// cover-cropped rather than made visibly shorter than the model/vicinity.
export function cover10AerialPlacement(
  panel: { x: number; y: number; w: number; h: number },
  lr: { minX: number; maxX: number; minY: number; maxY: number }
) {
  const lw = lr.maxX - lr.minX, lh = lr.maxY - lr.minY;
  const s = Math.min(panel.w / lw, panel.h / lh);
  const w = lw * s, h = lh * s;
  return { x: panel.x + (panel.w - w) / 2, y: panel.y + (panel.h - h) / 2, w, h };
}

// Printed image rectangles for the three cover panels (task 689). The left
// vicinity map contain-fits its geographic bbox into the left panel (see
// vicinityMapper), so its printed rect can be smaller than the panel. The
// aerial and 3D-model images must print at EXACTLY that same width/height,
// so all three rects are the vicinity's fitted size, centered within their
// respective panels. Without vicinity data all three fall back to the full
// panel rects (already equal).
export function cover10PrintedRects(
  design: SiteDesign,
  vicinityBbox?: { west: number; south: number; east: number; north: number } | null
) {
  const g = cover10Region(design);
  let w = g.left.w, h = g.left.h;
  if (vicinityBbox) {
    const midLat = (vicinityBbox.south + vicinityBbox.north) / 2;
    const cosLat = Math.cos((midLat * Math.PI) / 180);
    const gw = (vicinityBbox.east - vicinityBbox.west) * cosLat;
    const gh = vicinityBbox.north - vicinityBbox.south;
    if (gw > 0 && gh > 0) {
      const s = Math.min(g.left.w / gw, g.left.h / gh);
      w = gw * s;
      h = gh * s;
    }
  }
  const centered = (p: { x: number; y: number; w: number; h: number }) =>
    ({ x: p.x + (p.w - w) / 2, y: p.y + (p.h - h) / 2, w, h });
  return { ...g, left: centered(g.left), right: centered(g.right), model: centered(g.model) };
}

// Cover-fit the aerial while preserving its geographic aspect ratio. Its
// returned image rectangle may overhang `panel`; both PDF and DXF paths clip
// that overhang to the panel, keeping the visible aerial frame exactly equal
// to the vicinity and 3D-model frames.
export function cover10AerialCoverPlacement(
  panel: { x: number; y: number; w: number; h: number },
  lr: { minX: number; maxX: number; minY: number; maxY: number }
) {
  const lw = lr.maxX - lr.minX, lh = lr.maxY - lr.minY;
  const s = Math.max(panel.w / lw, panel.h / lh);
  const w = lw * s, h = lh * s;
  return { x: panel.x + (panel.w - w) / 2, y: panel.y + (panel.h - h) / 2, w, h };
}

function centeredText(dxf: DxfWriter, cx: number, y: number, h: number, text: string, layer: string) {
  // Center-anchored: PDF rendering re-centers on real font metrics (F-24).
  return dxf.addCenteredText(cx, y, h, text, layer);
}

// Dedicated layer for the cover key-plan overlay linework. PDF rendering
// skips this layer when a hi-fi top-down 3D render is present.
export const COVER10_OVERLAY_LAYER = 'COVER10 - key plan overlay';

function composeCover10(dxf: DxfWriter, ctx: SheetContext) {
  const c10 = ctx.cover10!;
  // Printed rects: all three image frames share the vicinity map's fitted
  // size (task 689) so the cover never shows a shorter left image next to
  // taller aerial/model panels.
  const g = cover10PrintedRects(ctx.design, c10.vicinity?.bbox ?? null);
  const { L, B, RW, RH, left, right } = g;
  const cx = L + RW / 2;

  // Title block: project name, underlined, over the standard subtitle.
  const name = (ctx.meta?.projectName?.trim() || ctx.projectName).toUpperCase();
  const line2 = 'BATTERY ENERGY STORAGE SYSTEM';
  const H1 = Math.min(RW * 0.032, (RW * 0.85) / (Math.max(name.length, line2.length) * 0.9));
  const yTitle = B + RH * 0.93;
  const tw1 = centeredText(dxf, cx, yTitle, H1, name, LAYERS.TEXT_LG);
  dxf.addLine(cx - tw1 / 2, yTitle - H1 * 0.35, cx + tw1 / 2, yTitle - H1 * 0.35, LAYERS.TEXT_LG);
  centeredText(dxf, cx, yTitle - H1 * 1.6, H1, line2, LAYERS.TEXT_LG);

  // Left panel: stylized vicinity map (when data was available).
  let star: { starX: number; starY: number } | null = null;
  if (c10.vicinity) {
    star = drawVicinityMap(dxf, c10.vicinity, left);
  } else {
    dxf.addPolyline(
      [[left.x, left.y], [left.x + left.w, left.y], [left.x + left.w, left.y + left.h], [left.x, left.y + left.h]],
      LAYERS.TEXT_LG, true
    );
    centeredText(dxf, left.x + left.w / 2, left.y + left.h / 2, RW * 0.012,
      'VICINITY MAP UNAVAILABLE', LAYERS.TEXT_SM);
  }

  // Right panel: georegistered layout linework (vector twin of the aerial —
  // the PDF puts the photo underneath at the exact same placement).
  const lr = c10.aerial?.localRect ?? (() => {
    const xs = ctx.design.boundary.polygon.map(p => p.x);
    const ys = ctx.design.boundary.polygon.map(p => p.y);
    const padX = (Math.max(...xs) - Math.min(...xs)) * 0.15 + 50;
    const padY = (Math.max(...ys) - Math.min(...ys)) * 0.15 + 50;
    return {
      minX: Math.min(...xs) - padX, maxX: Math.max(...xs) + padX,
      minY: Math.min(...ys) - padY, maxY: Math.max(...ys) + padY,
    };
  })();
  const place = cover10AerialCoverPlacement(right, lr);
  const fx = (ftX: number) => place.x + ((ftX - lr.minX) / (lr.maxX - lr.minX)) * place.w;
  const fy = (ftY: number) => place.y + ((ftY - lr.minY) / (lr.maxY - lr.minY)) * place.h;
  const rightClip = { minX: right.x, minY: right.y, maxX: right.x + right.w, maxY: right.y + right.h };
  {
    const ov = new DxfWriter(ctx.drawingVisibility);
    addBaseLayers(ov);
    drawBoundaryAndFence(ov, ctx.design);
    drawRoads(ov, ctx.design, false);
    drawEquipment(ov, ctx.design, ctx.config);
    drawGate(ov, ctx.design);
    const segs: Array<{ layer: string; pts: [number, number][] }> = [];
    for (const op of ov.ops) {
      if (op.kind === 'line') segs.push({ layer: op.layer, pts: [[op.x1, op.y1], [op.x2, op.y2]] });
      else if (op.kind === 'poly') {
        segs.push({ layer: op.layer, pts: (op.closed ? [...op.pts, op.pts[0]] : op.pts) as [number, number][] });
      } else if (op.kind === 'arc') {
        // Arcs (gate swing symbol): tessellate into chords. The gate-swing
        // layer plots DASHED2 on the plan sheets — the overlay layer is
        // continuous, so approximate the dashing by keeping alternate
        // chords (each its own 2-point seg) so the cover keeps the dashed
        // swing-arc read.
        const dashed = ov.layerLineTypes[op.layer] !== 'CONTINUOUS';
        let { start, end } = op;
        if (op.ccw && end < start) end += Math.PI * 2;
        if (!op.ccw && end > start) end -= Math.PI * 2;
        const steps = Math.max(6, Math.ceil(Math.abs(end - start) / 0.1));
        const pts: [number, number][] = [];
        for (let i = 0; i <= steps; i++) {
          const a = start + ((end - start) * i) / steps;
          pts.push([op.cx + op.r * Math.cos(a), op.cy + op.r * Math.sin(a)]);
        }
        if (dashed) {
          for (let i = 0; i + 1 < pts.length; i += 2) {
            segs.push({ layer: op.layer, pts: [pts[i], pts[i + 1]] });
          }
        } else {
          segs.push({ layer: op.layer, pts });
        }
      }
    }
    // Yard-rotation registration (yard frame -> geo frame), same rule as the
    // legacy PDF cover overlay.
    const yr = ctx.yardRotation;
    if (yr && yr.deg !== 0 && c10.aerial) {
      const a = (yr.deg * Math.PI) / 180;
      const cos = Math.cos(a), sin = Math.sin(a);
      for (const seg of segs) {
        seg.pts = seg.pts.map(([px2, py2]) => {
          const dx = px2 - yr.pivot.x, dy = py2 - yr.pivot.y;
          return [yr.pivot.x + dx * cos - dy * sin, yr.pivot.y + dx * sin + dy * cos] as [number, number];
        });
      }
    }
    // Overlay linework goes on a dedicated layer (per-layer ACI preserved
    // via entity color override) so the PDF can substitute a hi-fi 3D
    // render for it while the DXF keeps the pure-vector overlay.
    dxf.addLayer(COVER10_OVERLAY_LAYER, 7, 'CONTINUOUS');
    for (const seg of segs) {
      const aci = ov.layerColors[seg.layer] ?? 7;
      for (let i = 0; i + 1 < seg.pts.length; i++) {
        const c = clipSeg(seg.pts[i], seg.pts[i + 1], lr);
        if (!c) continue;
        const mapped = clipSeg(
          [fx(c[0][0]), fy(c[0][1])],
          [fx(c[1][0]), fy(c[1][1])],
          rightClip
        );
        if (mapped) dxf.addLine(mapped[0][0], mapped[0][1], mapped[1][0], mapped[1][1], COVER10_OVERLAY_LAYER, aci);
      }
    }
  }
  dxf.addPolyline(
    [[right.x, right.y], [right.x + right.w, right.y],
     [right.x + right.w, right.y + right.h], [right.x, right.y + right.h]],
    LAYERS.TEXT_LG, true
  );
  centeredText(dxf, right.x + right.w / 2, right.y - RW * 0.018, RW * 0.01,
    'SITE LOCATION — AERIAL IMAGERY', LAYERS.TEXT_SM);

  // Third panel: angled 3D site render, same size as the vicinity/aerial
  // panels, in the right-hand column region (task 650 — the hero is no
  // longer an inset inside the aerial panel). Vector frame + caption only;
  // the PDF places the raster underneath (raster never enters DXF).
  // Drawn only when a hero render is provided, so default output stays
  // byte-identical.
  const hero650 = ctx.coverRenders?.hero;
  if (hero650 && hero650.widthPx > 0 && hero650.heightPx > 0) {
    const m = g.model;
    dxf.addPolyline(
      [[m.x, m.y], [m.x + m.w, m.y], [m.x + m.w, m.y + m.h], [m.x, m.y + m.h]],
      LAYERS.TEXT_LG, true
    );
    centeredText(dxf, m.x + m.w / 2, m.y - RW * 0.018, RW * 0.01,
      'SITE 3D MODEL — PERSPECTIVE VIEW', LAYERS.TEXT_SM);
  }

  // Leader lines: vicinity star -> aerial panel corners (reference style).
  if (star) {
    dxf.addLine(star.starX, star.starY, right.x, right.y + right.h, LAYERS.TEXT_SM);
    dxf.addLine(star.starX, star.starY, right.x, right.y, LAYERS.TEXT_SM);
  }

  // Bottom center: project stats, issued-for line, location.
  const hS = RW * 0.013;
  let yb = B + RH * 0.14;
  if (c10.statsLine) { centeredText(dxf, cx, yb, hS, c10.statsLine.toUpperCase(), LAYERS.TEXT_LG); yb -= hS * 2.2; }
  centeredText(dxf, cx, yb, hS * 1.35, 'ISSUED FOR 10% REVIEW', LAYERS.TEXT_LG);
  yb -= hS * 2.6;
  if (c10.locationLine) { centeredText(dxf, cx, yb, hS * 1.15, c10.locationLine.toUpperCase(), LAYERS.TEXT_LG); yb -= hS * 2.0; }
  if (c10.coordinateLine) centeredText(dxf, cx, yb, hS * 1.15, c10.coordinateLine.toUpperCase(), LAYERS.TEXT_LG);

  // Boxed stamp, lower-right of the plan region.
  const stamp = 'ISSUED FOR 10% REVIEW';
  const hB = RW * 0.011;
  const bw = stamp.length * hB * 0.9 + hB * 2;
  const bx = L + RW - bw - RW * 0.02;
  const by = B + RH * 0.02;
  dxf.addPolyline([[bx, by], [bx + bw, by], [bx + bw, by + hB * 2.4], [bx, by + hB * 2.4]], LAYERS.TEXT_LG, true);
  // Stamp text centered in its box (review standard).
  centeredText(dxf, bx + bw / 2, by + hB * 0.7, hB, stamp, LAYERS.TEXT_LG);
}

// ---------------------------------------------------------------------------
// Sheet definitions
// ---------------------------------------------------------------------------

const coverSheet: SheetDef = {
  id: 'cover',
  fileTag: 'Cover_Sheet',
  title: 'COVER SHEET',
  frame: (ctx) => ({
    // The cover art lives in its own region (cover10Region) that is wider
    // than the parcel; the border must wrap THAT, not the boundary extents,
    // or the title/panels overflow the frame.
    ...(ctx.cover10 ? (() => {
      const g = cover10Region(ctx.design);
      // Drawing-number tag per reference (CAR-D-B000-0 style): 3-letter
      // project prefix, D discipline, B000 cover, revision 0.
      const prefix = (ctx.meta?.projectName?.trim() || ctx.projectName)
        .toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 3) || 'BES';
      return {
        planBounds: { minX: g.L, minY: g.B, maxX: g.L + g.RW, maxY: g.B + g.RH },
        cover10Border: { dwgTag: `${prefix}-D-B000-0` },
        // Widen the title-block column to match the vicinity/aerial panel width
        // so the 3D model panel (placed in that column by cover10Region) prints
        // at exactly the same size as the two main image panels.
        framePW: g.model.w,
      };
    })() : {}),
    panels: {
      siteInfo: true, equipDims: false, bom: false, legend: false,
      keyNotes: false, notes: false, disclaimer: true,
      // The cover10 plan area draws its own boxed stamp; skip the panel one.
      stamp: false,
    },
    extraBoxes: [
      {
        title: 'SHEET INDEX',
        rows: SHEET_REGISTRY.map((s, i) => `${String(i + 1).padStart(2, '0')} - ${s.title}`),
      },
      {
        title: 'REFERENCE DRAWINGS (PDF APPENDIX A / ZIP)',
        rows: [
          'LG F2D4-5.1US-MC01 DC LINK MECH & STRUCT DWGS V2.0',
          'SHEETS 3-11: DC-LINK OUTLINE / EXTERIOR / E-PANEL',
        ],
      },
    ],
  }),
  compose: (dxf, ctx) => {
    // Opt-in "Issued for 10%" reference-style cover: vicinity map + aerial
    // key plan panels. Absent -> legacy title-only cover, byte-identical.
    if (ctx.cover10) { composeCover10(dxf, ctx); return; }
    // Big centered project title in the plan area (no plan geometry on the
    // cover — geometry lives on the discipline sheets).
    const xs = ctx.design.boundary.polygon.map(p => p.x);
    const ys = ctx.design.boundary.polygon.map(p => p.y);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    const w = Math.max(...xs) - Math.min(...xs);
    const name = (ctx.meta?.projectName?.trim() || ctx.projectName).toUpperCase();
    const line2 = 'BATTERY ENERGY STORAGE SYSTEM';
    const line3 = '10% BESS LAYOUT';
    // Title height scaled to the site extents so it reads at sheet scale.
    const H1 = Math.max(10, Math.min(60, w / (name.length * 1.1)));
    const H2 = H1 * 0.55;
    dxf.addCenteredText(cx, cy + H1, H1, name, LAYERS.TEXT_LG);
    dxf.addCenteredText(cx, cy - H2 * 0.8, H2, line2, LAYERS.TEXT_LG);
    dxf.addCenteredText(cx, cy - H2 * 2.6, H2, line3, LAYERS.TEXT_LG);
  },
};

const sitePlanSheet: SheetDef = {
  id: 'site-plan',
  fileTag: 'Overall_Site_Plan',
  title: 'OVERALL SITE PLAN',
  frame: (ctx) => ({
    panels: {
      siteInfo: true, equipDims: true, bom: false, legend: false,
      keyNotes: false, notes: true, disclaimer: true,
    },
    schedule: true,
    // Ornate reference north arrow + graphic scale (issued 90% style).
    northArrow: true,
    // Drafter-drawn area zones: matching reference legend rows, only for
    // the kinds present (absent/empty keeps the frame byte-identical).
    ...(ctx.areaZones && ctx.areaZones.length
      ? { panels: { siteInfo: true, equipDims: true, bom: false, legend: true, keyNotes: false, notes: true, disclaimer: true }, areaZoneKinds: areaZoneKindsPresent(ctx.areaZones) }
      : {}),
    // Issued-for-10% styling: full-width bottom title banner (reference
    // bottom_of_dwg strip). Opt-in with cover10 so the default package
    // stays byte-identical.
    ...(ctx.cover10 ? (() => {
      const prefix = (ctx.meta?.projectName?.trim() || ctx.projectName)
        .toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 3) || 'BES';
      return {
        bottomBanner: {
          sheetTitle: '10% PRELIMINARY BESS LAYOUT',
          dwgName: `${prefix}-D-B001-0`,
          revision: 'GA',
          ...(ctx.meta?.neerDwgName ? { neerDwgName: ctx.meta.neerDwgName } : {}),
        },
        // Ornate needle + checkered graphic scale beside the legend
        // (replaces the legacy northArrow furniture on 10% sheets).
        scaleBar: true,
      };
    })() : {}),
  }),
  compose: (dxf, ctx) => {
    drawBoundaryAndFence(dxf, ctx.design);
    drawSurfacing(dxf, ctx.design, ctx.surfacingMesh);
    drawEquipment(dxf, ctx.design, ctx.config, !!ctx.eciLegend, true);
    drawReservedZones(dxf, ctx.design);
    drawRoads(dxf, ctx.design, false);
    addSpacingDimensions(dxf, ctx.design, ctx.includeFeederNfpaAnnotations !== false);
    addEquipmentSchedule(dxf, ctx.design, ctx.config);
    drawGate(dxf, ctx.design);
    // Labels last: white masks + tags plot over all yard linework.
    drawEquipmentLabels(dxf, ctx.design, ctx.config);
    // Opt-in existing-grade contour reference layers — drawn last so the
    // default (no contours) entity/handle stream is untouched.
    if (ctx.contours && ctx.contours.lines.length > 0) drawContours(dxf, ctx.contours);
    // Opt-in grounding screening layer, same byte-identity rule.
    if (ctx.grounding) drawGrounding(dxf, ctx.grounding);
    // Opt-in drafter-drawn area zones — drawn last, same byte-identity rule.
    if (ctx.areaZones && ctx.areaZones.length) drawAreaZones(dxf, ctx.areaZones);
    // Opt-in enlarged-plan key grid — tile windows + "SEE AREA x" tags with
    // text sized from the overall plot scale (drawn last, byte-identical off).
    if (ctx.enlargedPlans) {
      const plan = planEnlargedTiles(ctx.design);
      if (plan) drawEnlargedKeyGrid(dxf, plan);
    }
  },
};

const cableTrenchSheet: SheetDef = {
  id: 'cable-trench',
  fileTag: 'Cable_and_Trench_Plan',
  title: 'CABLE & TRENCH PLAN',
  frame: (ctx) => ({
    panels: {
      siteInfo: true, equipDims: false, bom: true, legend: true,
      keyNotes: false, notes: false, disclaimer: true,
    },
    ...(ctx.auxManRoute ? { auxManRoute: true } : {}),
  }),
  compose: (dxf, ctx) => {
    drawBoundaryAndFence(dxf, ctx.design);
    drawTrench(dxf, ctx.design);
    drawCables(dxf, ctx.design);
    drawEquipment(dxf, ctx.design, ctx.config, !!ctx.eciLegend, true);
    drawFeedersAndSubstation(dxf, ctx.feeders, ctx.substation, ctx.design, ctx.includeFeederNfpaAnnotations !== false);
    drawGate(dxf, ctx.design);
    // Labels last: white masks + tags plot over all yard linework.
    drawEquipmentLabels(dxf, ctx.design, ctx.config);
    // Opt-in typical trench section schedule (CAR-D-B006-1/2) — drawn last so
    // the default (no sections) entity/handle stream is untouched.
    if (ctx.trenchSections) addTrenchSectionSchedule(dxf, ctx.design, ctx.config);
  },
};

const roadPlanSheet: SheetDef = {
  id: 'road-plan',
  fileTag: 'Road_Plan',
  title: 'DRIVE PATH PLAN',
  frame: () => ({
    panels: {
      siteInfo: true, equipDims: false, bom: false, legend: false,
      keyNotes: false, notes: false, disclaimer: true,
    },
  }),
  compose: (dxf, ctx) => {
    drawBoundaryAndFence(dxf, ctx.design);
    drawSurfacing(dxf, ctx.design, ctx.surfacingMesh);
    drawEquipment(dxf, ctx.design, ctx.config, !!ctx.eciLegend, true);
    drawReservedZones(dxf, ctx.design);
    drawRoads(dxf, ctx.design, true); // includes sheet-10 style callouts
    drawGate(dxf, ctx.design);
    // Labels last: white masks + tags plot over all yard linework.
    drawEquipmentLabels(dxf, ctx.design, ctx.config);
  },
};

const notesLegendSheet: SheetDef = {
  id: 'notes-legend',
  fileTag: 'Key_Notes_and_Legend',
  title: 'KEY NOTES & LEGEND',
  frame: () => ({
    panels: {
      siteInfo: false, equipDims: true, bom: true, legend: true,
      keyNotes: true, notes: true, disclaimer: true,
    },
    fillPlanArea: true,
  }),
  compose: () => {
    // Panels only — no plan geometry on the notes/legend sheet.
  },
};

// Equipment detail sheets: outline views redrawn from the uploaded
// manufacturer drawing packages (see dxfDetails.ts for sources).
const bessPcsDetailsSheet: SheetDef = {
  id: 'bess-pcs-details',
  fileTag: 'BESS_and_PCS_Equipment_Details',
  title: 'BESS & PCS EQUIPMENT DETAILS',
  frame: () => ({
    panels: {
      siteInfo: false, equipDims: true, bom: false, legend: false,
      keyNotes: false, notes: true, disclaimer: true,
    },
  }),
  compose: (dxf, ctx) => {
    drawEquipmentDetailSheet(dxf, ctx.design, bessPcsDetailItems(ctx.config));
  },
};

const auxDetailsSheet: SheetDef = {
  id: 'aux-details',
  fileTag: 'Auxiliary_Equipment_Details',
  title: 'AUXILIARY EQUIPMENT DETAILS',
  frame: () => ({
    panels: {
      siteInfo: false, equipDims: true, bom: false, legend: false,
      keyNotes: false, notes: false, disclaimer: true,
    },
  }),
  compose: (dxf, ctx) => {
    drawEquipmentDetailSheet(dxf, ctx.design, auxDetailItems());
  },
};

export const SHEET_REGISTRY: SheetDef[] = [
  coverSheet,
  sitePlanSheet,
  cableTrenchSheet,
  roadPlanSheet,
  bessPcsDetailsSheet,
  auxDetailsSheet,
  notesLegendSheet,
];

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

export function buildSheetDxfString(def: SheetDef, ctx: SheetContext, index: number): string {
  const dxf = new DxfWriter(ctx.drawingVisibility);
  addBaseLayers(dxf);
  addSheetFrame(
    dxf,
    ctx.design,
    ctx.projectName,
    ctx.config,
    ctx.meta,
    ctx.feeders,
    ctx.substation,
    {
      ...def.frame(ctx),
      // ECI legend symbol style applies to every sheet that renders a
      // legend panel; absent keeps the frame options byte-identical.
      ...(ctx.eciLegend ? { eciLegend: true } : {}),
      sheetLabel: `SHEET ${index + 1} OF ${SHEET_REGISTRY.length}`,
      sheetTitle: def.title,
    }
  );
  def.compose(dxf, ctx);
  // Opt-in text-label overrides: patch entity strings + display-list ops after
  // the sheet is fully composed so the DXF download reflects drafter edits.
  // An empty/absent map leaves the sheet byte-identical to the default.
  if (ctx.textOverrides && Object.keys(ctx.textOverrides).length) {
    dxf.patchTextOverridesForExport(ctx.textOverrides);
  }
  return dxf.toString();
}

export interface PackageSheet {
  filename: string;
  content: string;
}

// Build the complete drawing package: one DXF per registered sheet, with
// zero-padded sheet numbers in the filenames for stable ordering in the zip.
// Opt-in sheets (SLD, BOM schedule) are APPENDED after the registry so the
// default seven files stay byte-identical when the context fields are absent.
export function buildDxfPackage(ctx: SheetContext): PackageSheet[] {
  const sheets: PackageSheet[] = SHEET_REGISTRY.map((def, i) => ({
    filename: `${String(i + 1).padStart(2, '0')}_${def.fileTag}.dxf`,
    content: buildSheetDxfString(def, ctx, i),
  }));
  let n = SHEET_REGISTRY.length;
  if (ctx.sldSheet) {
    n += 1;
    sheets.push({
      filename: `${String(n).padStart(2, '0')}_Single_Line_Diagram.dxf`,
      content: buildSldDxfString(
        ctx.design, ctx.projectName, ctx.feeders ?? [], ctx.config, ctx.meta,
        ctx.sldSheet.options
      ),
    });
  }
  if (ctx.bomSheet) {
    // Two B018 sheets, exactly like the issued 90% package (CAR-D-B018-1/-2).
    for (const sheet of [1, 2] as const) {
      n += 1;
      sheets.push({
        filename: `${String(n).padStart(2, '0')}_Bill_of_Materials_${sheet}.dxf`,
        content: buildBomSheetDxfString(
          ctx.design, ctx.projectName, ctx.feeders ?? [], ctx.config, ctx.meta,
          { ...ctx.bomSheet.options, sheet }
        ),
      });
    }
  }
  // MULTI-AREA: a readable full-size plan for EVERY selected footprint.
  // The registry sheets above frame the whole site (the coordination / key
  // plan), which on a site with a remote substation drops to 1" = 150' and
  // prints the equipment annotation far below readable. Each footprint also
  // ships as its own sheet at the scale it would print at alone. Appended
  // before the 10% enlarged tiles and no-op on single-area exports, so every
  // existing filename and sheet number is untouched.
  const areaPlans = areaSheetPlans(ctx);
  areaPlans.forEach((plan, i) => {
    n += 1;
    sheets.push({
      filename: `${String(n).padStart(2, '0')}_Area_Plan_${plan.fileTag}.dxf`,
      content: buildAreaSheetDxfString(ctx, plan, i, areaPlans.length),
    });
  });
  // Enlarged AREA tiles last (10% exports) — appended so all default and
  // earlier opt-in filenames/numbering are untouched.
  if (ctx.enlargedPlans) {
    const plan = planEnlargedTiles(ctx.design);
    if (plan) {
      plan.tiles.forEach((tile, i) => {
        n += 1;
        sheets.push({
          filename: `${String(n).padStart(2, '0')}_Enlarged_Site_Plan_${tile.tag}.dxf`,
          content: buildEnlargedPlanDxfString(ctx, plan, i),
        });
      });
    }
  }
  return sheets;
}
