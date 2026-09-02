// Scaled PDF plot set for non-CAD reviewers.
// Renders the SAME display list the DXF writer records for each sheet in the
// drawing package (dxfSheets SHEET_REGISTRY), so the PDF and DXF can never
// drift apart. Pure vector output via jsPDF — no rasterized screenshots.
import { jsPDF } from 'jspdf';
import { NORTH_ARROW_ASPECT, NORTH_ARROW_POLYS } from './northArrowVector';
import {
  DxfWriter, DisplayOp, addBaseLayers, addSheetFrame, composeDesignDxf,
  drawBoundaryAndFence, drawEquipment, drawRoads, drawGate,
  LINETYPE_PATTERNS,
} from './dxfExport';
import { SHEET_REGISTRY, SheetContext, SheetDef, cover10PrintedRects, cover10AerialCoverPlacement, COVER10_OVERLAY_LAYER } from './dxfSheets';
import { composeSiteDxf, siteCompositionApplies } from './siteCompose';
import { composeSldDxf } from './sld';
import { composeBomSheetDxf } from './bomSheet';
import { composeRelayOneLineDxf } from './relayOneLine';
import { composeGradingPlanDxf } from './gradingPlan';
import { composeGradingSectionsDxf } from './gradingSections';
import { composeDrainageSheetDxf } from './drainageSheet';
import { composeDrainageDetailSheetDxf } from './drainageDetailSheet';
import { FEEDER_PALETTE } from './feederColors';
import { PROPERTY_LINE_FIGURE_RGB } from './propertyLineColor';
import { MECH_DRAWING_PAGES, MECH_DRAWINGS_TITLE } from './mechDrawings';
import { plotCreationDate, rewritePdfProducer } from './pdfIdentity';
import { planEnlargedTiles, composeEnlargedPlan } from './enlargedPlans';
import { areaSheetPlans, composeAreaSheetDisplay } from './areaSheets';

// ---------------------------------------------------------------------------
// Page geometry: ANSI D 22 x 34 in, landscape. Plan content is fitted at a
// standard engineering scale (1 in = S ft) inside the printable area.
// ---------------------------------------------------------------------------
// (constants + pickScale live in plotScale.ts so dxfExport's graphic scale
// bar caption can share them without an import cycle; re-exported here for
// all existing consumers.)
export { PAGE_W_IN, PAGE_H_IN, PAGE_MARGIN_IN, STANDARD_SCALES_FT_PER_IN, pickScale } from './plotScale';
import { PAGE_W_IN, PAGE_H_IN, PAGE_MARGIN_IN } from './plotScale';
import { pickScale } from './plotScale';

// ACI color -> RGB, for the color codes the layer table actually uses.
const ACI_RGB: Record<number, [number, number, number]> = {
  1: [204, 0, 0],      // red
  2: [178, 143, 0],    // yellow (darkened for white paper)
  3: [0, 140, 0],      // green
  4: [0, 130, 150],    // cyan (darkened)
  5: [0, 0, 200],      // blue
  6: PROPERTY_LINE_FIGURE_RGB, // magenta/purple — property line (propertyLineColor.ts)
  7: [0, 0, 0],        // white on screen -> black on paper
  8: [110, 110, 110],  // gray
  9: [184, 184, 184],  // light gray (ECI symbol shading — matches the
                       // delivered reference sheets' light interior gray)
  23: [148, 110, 76],  // pond border brown (reference CK1 dry pond edge)
  30: [214, 117, 0],   // orange
  33: [219, 206, 195], // dry pond light tan fill (reference CK1 legend)
  40: [229, 216, 178], // beige land fill (vicinity map atlas palette)
  150: [59, 122, 247], // wet pond border blue (reference CK1 wet pond edge)
  151: [189, 210, 252],// wet pond light blue fill (reference CK1 legend)
  200: [130, 60, 180], // purple
  253: [219, 219, 219],// light gray road fill
  255: [255, 255, 255],// true white (equipment label mask / wipeout)
  254: [252, 252, 250],// near-white (vicinity route shield fill)
};

// Per-feeder palette ACIs render with the palette's paper RGB so PDF hues
// match the DXF feeder colors exactly (shared source in feederColors.ts).
for (const fc of FEEDER_PALETTE) ACI_RGB[fc.aci] = ACI_RGB[fc.aci] ?? fc.rgb;

export function aciToRgb(aci: number | undefined): [number, number, number] {
  return ACI_RGB[aci ?? 7] ?? [0, 0, 0];
}

// Minimum a page renderer needs: the recorded display list plus layer colors.
export interface DisplayList {
  ops: DisplayOp[];
  layerColors: Record<string, number>;
  // Layer -> LTYPE name / lineweight (group 370). Optional so legacy callers
  // keep working; absent = every layer solid at the default width.
  layerLineTypes?: Record<string, string>;
  layerWeights?: Record<string, number>;
}

export interface SheetDisplay extends DisplayList {
  def: SheetDef;
}

// Compose one sheet exactly like buildSheetDxfString does, but capture the
// writer's display list instead of serializing DXF text.
export function composeSheetDisplay(def: SheetDef, ctx: SheetContext, index: number): SheetDisplay {
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
      // ECI legend symbol style — mirror dxfSheets.buildSheetDxfString so
      // package PDF sheets match the DXF package (absent = byte-identical).
      ...(ctx.eciLegend ? { eciLegend: true } : {}),
      sheetLabel: `SHEET ${index + 1} OF ${SHEET_REGISTRY.length}`,
      sheetTitle: def.title,
    }
  );
  def.compose(dxf, ctx);
  // Apply drafter text-label overrides to this sheet's display list, mirroring
  // buildSheetDxfString so the package PDF always matches the DXF deliverable.
  // Absent/empty map leaves every sheet byte-identical to the default.
  if (ctx.textOverrides && Object.keys(ctx.textOverrides).length) {
    dxf.patchTextOverridesForExport(ctx.textOverrides);
  }
  return { def, ops: dxf.ops, layerColors: dxf.layerColors, layerLineTypes: dxf.layerLineTypes, layerWeights: dxf.layerWeights };
}

// Bounding box of every drawn primitive (model feet).
export function displayBounds(ops: DisplayOp[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const pt = (x: number, y: number) => {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  };
  for (const op of ops) {
    if (op.kind === 'line') { pt(op.x1, op.y1); pt(op.x2, op.y2); }
    else if (op.kind === 'poly') op.pts.forEach(p => pt(p[0], p[1]));
    else if (op.kind === 'text') { pt(op.x, op.y); pt(op.x + op.text.length * op.h * 0.9, op.y + op.h); }
    else if (op.kind === 'arc') { pt(op.cx - op.r, op.cy - op.r); pt(op.cx + op.r, op.cy + op.r); }
    else op.loops.forEach(l => l.forEach(p => pt(p[0], p[1])));
  }
  if (!isFinite(minX)) { minX = minY = 0; maxX = maxY = 1; }
  return { minX, minY, maxX, maxY };
}

// Model (feet) -> page (inches, y-down) transform for one sheet.
export interface PageTransform {
  scale: number; // ft per inch
  toX: (xFt: number) => number;
  toY: (yFt: number) => number;
}

export function makePageTransform(ops: DisplayOp[]): PageTransform {
  const b = displayBounds(ops);
  const scale = pickScale(b.maxX - b.minX, b.maxY - b.minY);
  const wIn = (b.maxX - b.minX) / scale;
  const hIn = (b.maxY - b.minY) / scale;
  const offX = (PAGE_W_IN - wIn) / 2;
  const offY = (PAGE_H_IN - hIn) / 2;
  return {
    scale,
    toX: (x: number) => offX + (x - b.minX) / scale,
    toY: (y: number) => offY + (b.maxY - y) / scale, // flip: model y-up -> page y-down
  };
}

// Tessellate an arc into page points, honoring sweep direction.
export function arcPoints(op: Extract<DisplayOp, { kind: 'arc' }>): number[][] {
  let { start, end } = op;
  if (op.ccw && end < start) end += Math.PI * 2;
  if (!op.ccw && end > start) end -= Math.PI * 2;
  const steps = Math.max(6, Math.ceil(Math.abs(end - start) / 0.1));
  const pts: number[][] = [];
  for (let i = 0; i <= steps; i++) {
    const a = start + ((end - start) * i) / steps;
    pts.push([op.cx + op.r * Math.cos(a), op.cy + op.r * Math.sin(a)]);
  }
  return pts;
}

// Hatch pattern segment generators live in hatchPatterns.ts (shared with the
// CAD linework view without dragging jsPDF into the 3D bundle); re-exported
// here for existing consumers (displayListCanvas, tests).
export { ansi31Segments, ansi37Segments, gravelSegments } from './hatchPatterns';
import { ansi31Segments, ansi37Segments, gravelSegments } from './hatchPatterns';

// Draw one sheet's display list onto the current jsPDF page.
// Exported for the [633] graphics-state regression (dash/weight cache vs
// hatch strokes) — production callers go through the build*Pdf entry points.
export function renderSheet(doc: jsPDF, disp: DisplayList, t: PageTransform) {
  const colorOf = (layer: string, override?: number) =>
    aciToRgb(override !== undefined ? override : disp.layerColors[layer]);
  const lwIn = 0.012;
  doc.setLineWidth(lwIn);

  // Per-layer dash + weight (register F-14): the PDF plot dashes from the
  // same LINETYPE_PATTERNS the DXF LTYPE table encodes, scaled to paper
  // inches at this sheet's plot scale, so grayscale prints keep cable
  // classes distinguishable. State changes are batched (jsPDF writes a
  // stream op per call) and reset after the op loop.
  let curLt = 'CONTINUOUS';
  let curLw = lwIn;
  const applyStroke = (layer: string) => {
    const lt = disp.layerLineTypes?.[layer] ?? 'CONTINUOUS';
    if (lt !== curLt) {
      curLt = lt;
      const pat = LINETYPE_PATTERNS[lt] ?? [];
      // DXF elements: +dash, -gap, 0 dot. On paper: dots get a minimum
      // visible length so they survive rasterization.
      const dashes = pat.map(e => Math.max(Math.abs(e) / t.scale, 0.01));
      doc.setLineDashPattern(dashes.length ? dashes : [], 0);
    }
    const w370 = disp.layerWeights?.[layer] ?? -3;
    const w = w370 > 0 ? w370 / 100 / 25.4 : lwIn; // 1/100 mm -> inches
    if (w !== curLw) { curLw = w; doc.setLineWidth(w); }
  };

  for (const op of disp.ops) {
    if (op.kind === 'line') {
      const [cr, cg, cb] = colorOf(op.layer, op.color);
      doc.setDrawColor(cr, cg, cb);
      applyStroke(op.layer);
      doc.line(t.toX(op.x1), t.toY(op.y1), t.toX(op.x2), t.toY(op.y2));
    } else if (op.kind === 'poly') {
      const [cr, cg, cb] = colorOf(op.layer, op.color);
      doc.setDrawColor(cr, cg, cb);
      applyStroke(op.layer);
      // One path so dash phase continues around the polyline (per-edge
      // doc.line reset phase to 0 and broke dashed legend/plan rectangles).
      if (op.pts.length < 2) continue;
      const path: Array<{ op: string; c?: number[] }> = [];
      op.pts.forEach((p, i) => {
        path.push({ op: i === 0 ? 'm' : 'l', c: [t.toX(p[0]), t.toY(p[1])] });
      });
      if (op.closed) path.push({ op: 'h' });
      (doc as any).path(path);
      (doc as any).stroke();
    } else if (op.kind === 'arc') {
      const [cr, cg, cb] = colorOf(op.layer);
      doc.setDrawColor(cr, cg, cb);
      applyStroke(op.layer);
      const pts = arcPoints(op);
      for (let i = 0; i + 1 < pts.length; i++) {
        doc.line(t.toX(pts[i][0]), t.toY(pts[i][1]), t.toX(pts[i + 1][0]), t.toY(pts[i + 1][1]));
      }
    } else if (op.kind === 'hatch') {
      const [cr, cg, cb] = colorOf(op.layer, op.color);
      if (op.pattern === 'SOLID') {
        // Even-odd multi-loop fill (outer boundary + unfilled islands).
        doc.setFillColor(cr, cg, cb);
        const path: Array<{ op: string; c?: number[] }> = [];
        for (const loop of op.loops) {
          loop.forEach((p, i) => {
            path.push({ op: i === 0 ? 'm' : 'l', c: [t.toX(p[0]), t.toY(p[1])] });
          });
          path.push({ op: 'h' });
        }
        (doc as any).path(path);
        (doc as any).fillEvenOdd();
      } else {
        // ANSI31 / GRAVEL diagonal pattern lines clipped to the loops.
        // Hatch strokes are always solid + thin: clear any active cable dash
        // and keep the curLt/curLw caches in sync with the real GS state so
        // the next stroked entity re-applies its class dash/weight.
        doc.setDrawColor(cr, cg, cb);
        if (curLt !== 'CONTINUOUS') { doc.setLineDashPattern([], 0); curLt = 'CONTINUOUS'; }
        doc.setLineWidth(lwIn * 0.7);
        curLw = lwIn * 0.7;
        const patSegs = op.pattern === 'GRAVEL' ? gravelSegments(op.loops)
          : op.pattern === 'ANSI37' ? ansi37Segments(op.loops)
          : ansi31Segments(op.loops);
        for (const [x1, y1, x2, y2] of patSegs) {
          doc.line(t.toX(x1), t.toY(y1), t.toX(x2), t.toY(y2));
        }
      }
    } else {
      // text — baseline-left anchor like DXF TEXT; rotation CCW in degrees
      const [cr, cg, cb] = colorOf(op.layer, op.color);
      doc.setTextColor(cr, cg, cb);
      const sizePt = Math.max(2, (op.h / t.scale) * 72);
      doc.setFontSize(sizePt);
      // Large-text layer plots bold (title pen weight) — e.g. future-aug
      // zone titles must stay readable over their light-gray mesh.
      const bold = op.layer === 'text-lg' || op.layer === 'EQUIP - Labels';
      if (bold) doc.setFont(doc.getFont().fontName, 'bold');
      // Composer-marked centered text re-anchors on the true center: the
      // op.x estimate assumes 0.8-em glyphs, but courier is 0.6 em — left
      // anchoring would print the ink off-center in its box (F-24). The
      // DXF now carries real center justification too (task #649); the
      // op center (cx/cy) mirrors that alignment point, incl. rotated.
      const cx624 = (op as any).cx;
      if (cx624 !== undefined) {
        const cy624 = (op as any).cy ?? op.y;
        doc.text(op.text, t.toX(cx624), t.toY(cy624),
          op.rot ? { align: 'center', angle: op.rot } : { align: 'center' });
      } else {
        doc.text(op.text, t.toX(op.x), t.toY(op.y), op.rot ? { angle: op.rot } : undefined);
      }
      if (bold) doc.setFont(doc.getFont().fontName, 'normal');
    }
  }
  // Reset stroke state so page furniture / the next sheet starts solid.
  if (curLt !== 'CONTINUOUS') doc.setLineDashPattern([], 0);
  if (curLw !== lwIn) doc.setLineWidth(lwIn);
}

// Scale note, graphic scale bar, and north arrow in the page margin.
function renderPageFurniture(doc: jsPDF, t: PageTransform) {
  const black: [number, number, number] = [0, 0, 0];
  doc.setDrawColor(...black);
  doc.setTextColor(...black);
  doc.setLineWidth(0.014);

  // Scale note + graphic scale bar, bottom-left margin
  const barFt = t.scale * 4; // a 4-inch bar reads as 4 x scale feet
  const x0 = PAGE_MARGIN_IN + 0.2;
  const y0 = PAGE_H_IN - PAGE_MARGIN_IN + 0.28;
  doc.setFontSize(10);
  doc.text(`SCALE: 1" = ${t.scale}'`, x0, y0 - 0.14);
  const barIn = barFt / t.scale;
  doc.line(x0, y0, x0 + barIn, y0);
  const quarters = 4;
  doc.setFontSize(7);
  for (let i = 0; i <= quarters; i++) {
    const x = x0 + (barIn * i) / quarters;
    doc.line(x, y0 - 0.05, x, y0 + 0.05);
    doc.text(`${(barFt * i) / quarters}'`, x - 0.06, y0 + 0.17);
  }

  // North arrow, top-right margin (site plans are drawn north-up).
  // Ornate surveyor-style needle traced from the issued 90% reference —
  // same vector data as the DXF glyph (northArrowVector.ts). Holes are
  // painted white over the black fill (jsPDF has no even-odd loop fill).
  const nx = PAGE_W_IN - PAGE_MARGIN_IN - 0.45;
  const ny = PAGE_MARGIN_IN + 0.02;
  const gh = 0.85;
  const gw = gh * NORTH_ARROW_ASPECT;
  const fillRing = (ring: [number, number][], white: boolean) => {
    doc.setFillColor(white ? 255 : 0, white ? 255 : 0, white ? 255 : 0);
    const pts = ring.map(([px, py]) => [nx + (px - 0.5) * gw, ny + gh - py * gh]);
    const segs = pts.slice(1).map((p, i) => [p[0] - pts[i][0], p[1] - pts[i][1]]);
    (doc as any).lines(segs, pts[0][0], pts[0][1], [1, 1], 'F', true);
  };
  for (const poly of NORTH_ARROW_POLYS) {
    poly.forEach((ring, ri) => fillRing(ring as [number, number][], ri > 0));
  }
  doc.setFontSize(9);
  doc.text('N', nx - 0.033, ny - 0.03);
}

// Appendix pages: the ORIGINAL manufacturer mechanical/structural drawing
// sheets (LG MC01 package), embedded 1:1 as full-page plates. The source
// package is raster-only (Print-To-PDF), so these are fixed embedded JPEGs —
// byte-deterministic across builds.
function renderMechAppendix(doc: jsPDF) {
  MECH_DRAWING_PAGES.forEach((page, i) => {
    doc.addPage([PAGE_W_IN, PAGE_H_IN], 'landscape');
    const black: [number, number, number] = [0, 0, 0];
    doc.setTextColor(...black);
    doc.setFontSize(11);
    const header = `APPENDIX A-${i + 1}  |  ${MECH_DRAWINGS_TITLE}  |  SHEET ${page.sheetNo} OF 11  |  ${page.label}`;
    doc.text(header, PAGE_MARGIN_IN, PAGE_MARGIN_IN + 0.1);
    // Fit the plate inside the printable area below the header, preserving
    // the source aspect ratio.
    const top = PAGE_MARGIN_IN + 0.3;
    const availW = PAGE_W_IN - 2 * PAGE_MARGIN_IN;
    const availH = PAGE_H_IN - PAGE_MARGIN_IN - top;
    const s = Math.min(availW / page.wPx, availH / page.hPx);
    const w = page.wPx * s;
    const h = page.hPx * s;
    doc.addImage(
      page.jpegBase64,
      'JPEG',
      (PAGE_W_IN - w) / 2,
      top + (availH - h) / 2,
      w,
      h
    );
  });
}

// Site-vicinity aerial imagery on the cover page: the PRIMARY cover graphic.
// Drawn FIRST so the vector cover content (title, frame, panels) plots on
// top of it. The image fills the plan area (left of the panel column), and
// when its local-feet rect is known the design layout (lot line, fence,
// roads, equipment, gate) is drawn georegistered on top in high-contrast
// halo styling — a real title-sheet key plan.
// Optional — omitted entirely when ctx.coverImage is absent, keeping the
// default plot set byte-deterministic.

// Overlay stroke colors chosen for contrast over aerial photography.
const OVERLAY_RGB: Record<string, [number, number, number]> = {
  'SITE_BOUNDARY': PROPERTY_LINE_FIGURE_RGB,    // lot line: property purple
  'fence': [255, 215, 0],                      // fence: high-vis yellow
  // Current built-equipment footprints/symbols use neutral SYM layers. Keep
  // the legacy EQUIP layer neutral in this cover-only mapper as well so an
  // old footprint cannot regain a red fallback box in the aerial key map.
  'EQUIP - equip main outline': [255, 255, 255],
  'A - Equipment access': [235, 235, 235],     // road edges: light gray
};

// Liang-Barsky clip of one segment to an axis-aligned rect in local feet.
// Returns the clipped segment endpoints, or null when the segment lies
// entirely outside the rect. Exported for regression tests.
export function clipSegmentToRect(
  a: [number, number],
  b: [number, number],
  rect: { minX: number; minY: number; maxX: number; maxY: number }
): [[number, number], [number, number]] | null {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  let t0 = 0;
  let t1 = 1;
  const edges: Array<[number, number]> = [
    [-dx, a[0] - rect.minX],
    [dx, rect.maxX - a[0]],
    [-dy, a[1] - rect.minY],
    [dy, rect.maxY - a[1]],
  ];
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return null; // parallel and outside
    } else {
      const r = q / p;
      if (p < 0) {
        if (r > t1) return null;
        if (r > t0) t0 = r;
      } else {
        if (r < t0) return null;
        if (r < t1) t1 = r;
      }
    }
  }
  return [
    [a[0] + t0 * dx, a[1] + t0 * dy],
    [a[0] + t1 * dx, a[1] + t1 * dy],
  ];
}

// Pure cover-photo placement math, exported so the regression suite can pin
// it numerically (golden values) — drift here silently misregisters the
// cover overlay against the aerial photo.
export function computeCoverPlacement(
  b: { minX: number; maxX: number; minY: number; maxY: number },
  img: { widthPx: number; heightPx: number },
  t: PageTransform
): { x: number; y: number; w: number; h: number } | null {
  // Plan area of the cover in model feet: the boundary extents plus the
  // frame's inner padding; the panel column starts GAP = 60k ft east of the
  // plan, so stopping at +30k ft keeps the image clear of the panels.
  const span = Math.max(b.maxX - b.minX, b.maxY - b.minY, 400);
  const k = Math.min(Math.max(span / 1200, 0.5), 4); // same annotation scale as addSheetFrame
  const areaL = t.toX(b.minX - 30 * k);
  const areaR = t.toX(b.maxX + 30 * k);
  const areaT = t.toY(b.maxY + 30 * k);
  const areaB = t.toY(b.minY - 30 * k);
  const capH = 0.3; // caption strip below the image
  const maxW = areaR - areaL;
  const maxH = areaB - areaT - capH;
  if (maxW < 2 || maxH < 2) return null; // degenerate plan area: skip

  const s = Math.min(maxW / img.widthPx, maxH / img.heightPx);
  const w = img.widthPx * s;
  const h = img.heightPx * s;
  return { x: areaL + (maxW - w) / 2, y: areaT + (maxH - h) / 2, w, h };
}

// Local feet -> page-inch mapping across the placed photo, given the mosaic's
// local-feet rect. Exported for the same golden-value regression pinning.
export function coverOverlayMapper(
  lr: { minX: number; maxX: number; minY: number; maxY: number },
  p: { x: number; y: number; w: number; h: number }
): { fx: (ftX: number) => number; fy: (ftY: number) => number } {
  return {
    fx: (ftX: number) => p.x + ((ftX - lr.minX) / (lr.maxX - lr.minX)) * p.w,
    fy: (ftY: number) => p.y + ((lr.maxY - ftY) / (lr.maxY - lr.minY)) * p.h,
  };
}

function renderCoverImage(doc: jsPDF, ctx: SheetContext, disp: DisplayList, t: PageTransform) {
  const img = ctx.coverImage;
  if (!img || img.widthPx <= 0 || img.heightPx <= 0) return;

  // "Issued for 10%" cover: the aerial raster goes exactly under the right
  // panel's vector overlay (same placement helper as the DXF compose, so the
  // photo and the georegistered linework can never misregister). All other
  // cover content is vector and already in the display list.
  if (ctx.cover10) {
    // Printed rects (task 689): all three cover images share the vicinity
    // map's fitted size, so the raster placements below must use the same
    // shrunken rects as the DXF frames or the photos would overflow them.
    const region = cover10PrintedRects(ctx.design, ctx.cover10.vicinity?.bbox ?? null);
    // Third panel: angled 3D hero render, equal size to the vicinity/aerial
    // panels (task 650). COVER-fit inside the panel rect (fill the full frame,
    // cropping any aspect overhang behind a clip path) so the model panel
    // prints edge-to-edge exactly like the vicinity/aerial panels — never
    // letterboxed with white bands. The capture side photographs the hero at
    // COVER10_PANEL_ASPECT so the crop is a no-op for fresh renders; the clip
    // guarantees older/mismatched captures still fill the frame. The vector
    // frame + caption come from the display list (composeCover10) so the DXF
    // and PDF placements can never drift.
    const hero = ctx.coverRenders?.hero;
    if (hero && hero.widthPx > 0 && hero.heightPx > 0) {
      const m = region.model;
      const mx = t.toX(m.x);
      const my = t.toY(m.y + m.h);
      const mw = m.w / t.scale;
      const mh = m.h / t.scale;
      const hs = Math.max(mw / hero.widthPx, mh / hero.heightPx);
      const iw = hero.widthPx * hs, ih = hero.heightPx * hs;
      if (iw > 0.1 && ih > 0.1) {
        doc.saveGraphicsState();
        doc.rect(mx, my, mw, mh, null);
        doc.clip();
        doc.discardPath();
        doc.addImage(hero.dataUrl, 'JPEG', mx + (mw - iw) / 2, my + (mh - ih) / 2, iw, ih);
        doc.restoreGraphicsState();
      }
    }
    const lr = img.localRect;
    if (!lr || lr.maxX <= lr.minX || lr.maxY <= lr.minY) return;
    // Cover-crop the aerial into the same full-size panel used by the
    // vicinity and perspective render. Cropping preserves the map's aspect;
    // clipping makes the visible PDF image, DXF frame, and overlay agree.
    const p = cover10AerialCoverPlacement(region.right, lr);
    const x = t.toX(p.x);
    const y = t.toY(p.y + p.h);
    const w = p.w / t.scale;
    const h = p.h / t.scale;
    if (w > 0.1 && h > 0.1) {
      // Hi-fi 3D top-down render (captured plan-registered over the exact
      // same localRect) replaces the raw aerial when available; the vector
      // overlay linework is skipped in that case (see coverDisplayOps).
      const td = ctx.coverRenders?.topDown;
      const panelX = t.toX(region.right.x);
      const panelY = t.toY(region.right.y + region.right.h);
      const panelW = region.right.w / t.scale;
      const panelH = region.right.h / t.scale;
      doc.saveGraphicsState();
      doc.rect(panelX, panelY, panelW, panelH, null);
      doc.clip();
      doc.discardPath();
      if (td && td.widthPx > 0 && td.heightPx > 0) doc.addImage(td.dataUrl, 'JPEG', x, y, w, h);
      else doc.addImage(img.dataUrl, 'JPEG', x, y, w, h);
      doc.restoreGraphicsState();
    }
    return;
  }

  const xs = ctx.design.boundary.polygon.map(p => p.x);
  const ys = ctx.design.boundary.polygon.map(p => p.y);
  const bbox = {
    minX: Math.min(...xs), maxX: Math.max(...xs),
    minY: Math.min(...ys), maxY: Math.max(...ys),
  };
  const placement = computeCoverPlacement(bbox, img, t);
  if (!placement) return;
  const { x, y, w, h } = placement;
  doc.addImage(img.dataUrl, 'JPEG', x, y, w, h);

  // Georegistered layout overlay: local feet -> image pixels -> page inches.
  const lr = img.localRect;
  if (lr && lr.maxX > lr.minX && lr.maxY > lr.minY) {
    const { fx, fy } = coverOverlayMapper(lr, placement);
    // Reuse the exact site-plan drawing code so the key plan can never drift
    // from sheet 2 geometry; keep only line work (text/hatch would clutter
    // the photo at cover scale).
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
        const pts = (op.closed ? [...op.pts, op.pts[0]] : op.pts) as [number, number][];
        segs.push({ layer: op.layer, pts });
      } else if (op.kind === 'arc') {
        segs.push({ layer: op.layer, pts: arcPoints(op) as [number, number][] });
      }
    }
    // Grading-optimized yard rotation: design geometry is yard-frame while
    // the mosaic is geo-registered — rotate each stroke point by +deg about
    // the pivot (yard -> geo) before clipping/mapping. Absent -> exact no-op
    // so default covers stay byte-identical.
    const yr = ctx.yardRotation;
    if (yr && yr.deg !== 0) {
      const a = (yr.deg * Math.PI) / 180;
      const cos = Math.cos(a), sin = Math.sin(a);
      for (const seg of segs) {
        seg.pts = seg.pts.map(([px, py]) => {
          const dx = px - yr.pivot.x, dy = py - yr.pivot.y;
          return [yr.pivot.x + dx * cos - dy * sin, yr.pivot.y + dx * sin + dy * cos] as [number, number];
        });
      }
    }
    // Clip every stroke segment to the mosaic rect (Liang-Barsky) so line
    // work crossing the photo edge is trimmed cleanly instead of dropped.
    const clipped: Array<{ layer: string; a: [number, number]; b: [number, number] }> = [];
    for (const seg of segs) {
      for (let i = 0; i + 1 < seg.pts.length; i++) {
        const c = clipSegmentToRect(seg.pts[i], seg.pts[i + 1], lr);
        if (c) clipped.push({ layer: seg.layer, a: c[0], b: c[1] });
      }
    }
    // Two passes: dark halo under every stroke first, then the color pass,
    // so crossing strokes never punch holes in each other's halos.
    for (const pass of [0, 1] as const) {
      for (const seg of clipped) {
        if (pass === 0) {
          doc.setDrawColor(30, 30, 30);
          doc.setLineWidth(0.035);
        } else {
          const [cr, cg, cb] = OVERLAY_RGB[seg.layer] ?? [255, 255, 255];
          doc.setDrawColor(cr, cg, cb);
          doc.setLineWidth(0.016);
        }
        doc.line(fx(seg.a[0]), fy(seg.a[1]), fx(seg.b[0]), fy(seg.b[1]));
      }
    }
  }

  // Photo frame + caption strip.
  doc.setDrawColor(0, 0, 0);
  doc.setLineWidth(0.02);
  doc.rect(x, y, w, h);
  doc.setTextColor(0, 0, 0);
  doc.setFontSize(9);
  doc.text(
    img.caption ?? 'SITE VICINITY — AERIAL IMAGERY (CESIUM ION / BING MAPS)',
    x, y + h + 0.22
  );

  // White banner behind the big centered title lines (they live in the plan
  // area on the text-lg layer) so the title stays legible over the photo.
  const span = Math.max(bbox.maxX - bbox.minX, bbox.maxY - bbox.minY, 400);
  const k = Math.min(Math.max(span / 1200, 0.5), 4);
  for (const op of disp.ops) {
    if (op.kind !== 'text' || op.layer !== 'text-lg') continue;
    if (op.x > bbox.maxX + 30 * k) continue; // panel-column text: skip
    const tx = t.toX(op.x);
    const ty = t.toY(op.y);
    const tw = (op.text.length * op.h * 0.9) / t.scale;
    const th = op.h / t.scale;
    const pad = Math.min(0.12, th * 0.35);
    doc.setFillColor(255, 255, 255);
    doc.rect(tx - pad, ty - th - pad, tw + 2 * pad, th + 2 * pad, 'F');
  }
}

// Cover display ops, minus the vector key-plan overlay when a hi-fi 3D
// top-down render stands in for it (PDF only — DXF keeps the vector twin).
export function coverDisplayOps(disp: DisplayList, ctx: SheetContext): DisplayList {
  const td595 = ctx.coverRenders?.topDown;
  // Strip the overlay only for a usable render — renderCoverImage applies the
  // same dimension guard, so a malformed payload never blanks the key plan.
  if (!ctx.cover10 || !td595 || td595.widthPx <= 0 || td595.heightPx <= 0) return disp;
  return { ...disp, ops: disp.ops.filter(op => !('layer' in op) || op.layer !== COVER10_OVERLAY_LAYER) };
}
export const SITE_RENDER_PAGE_TITLE = 'FULL SITE TOP-DOWN RENDER';
function renderSiteRenderPage(doc: jsPDF, ctx: SheetContext) {
  const sr = ctx.siteRender;
  if (!sr || sr.widthPx <= 0 || sr.heightPx <= 0) return;
  doc.addPage([PAGE_W_IN, PAGE_H_IN], 'landscape');
  const black: [number, number, number] = [0, 0, 0];
  doc.setDrawColor(...black);
  doc.setTextColor(...black);
  doc.setLineWidth(0.02);
  doc.rect(PAGE_MARGIN_IN, PAGE_MARGIN_IN, PAGE_W_IN - 2 * PAGE_MARGIN_IN, PAGE_H_IN - 2 * PAGE_MARGIN_IN);
  const name = (ctx.meta?.projectName?.trim() || ctx.projectName).toUpperCase();
  doc.setFontSize(13);
  doc.text(`${SITE_RENDER_PAGE_TITLE}  |  ${name}`, PAGE_W_IN / 2, PAGE_MARGIN_IN + 0.32, { align: 'center' });
  // Fit the capture inside the printable area below the header, preserving
  // the source aspect ratio; caption strip under the image.
  const top = PAGE_MARGIN_IN + 0.55;
  const capH = 0.3;
  const availW = PAGE_W_IN - 2 * PAGE_MARGIN_IN - 0.4;
  const availH = PAGE_H_IN - PAGE_MARGIN_IN - top - capH - 0.2;
  const s = Math.min(availW / sr.widthPx, availH / sr.heightPx);
  const w = sr.widthPx * s, h = sr.heightPx * s;
  const x = (PAGE_W_IN - w) / 2, y = top + (availH - h) / 2;
  doc.addImage(sr.dataUrl, 'JPEG', x, y, w, h);
  doc.setLineWidth(0.02);
  doc.rect(x, y, w, h);
  doc.setFontSize(9);
  doc.text(
    sr.caption ?? 'SITE MODEL — TOP-DOWN ORTHOGRAPHIC RENDER OVER SATELLITE IMAGERY',
    x, y + h + 0.22
  );
}

// Total plot-set page count: one page per package sheet plus the appendix.
export const PLOT_PAGE_COUNT = SHEET_REGISTRY.length + MECH_DRAWING_PAGES.length;

// Build the full plot set: one ANSI D page per sheet in the DXF package,
// followed by the manufacturer mechanical drawing appendix.
// Deterministic: fixed creation date + file id, no compression.
export function buildPdfPlot(ctx: SheetContext): jsPDF {
  const doc = new jsPDF({ unit: 'in', format: [PAGE_W_IN, PAGE_H_IN], orientation: 'landscape', compress: false });
  doc.setCreationDate(plotCreationDate(ctx.meta?.date));
  (doc as any).setFileId('00000000000000000000000000000000');
  doc.setFont('courier', 'normal');

  SHEET_REGISTRY.forEach((def, i) => {
    if (i > 0) doc.addPage([PAGE_W_IN, PAGE_H_IN], 'landscape');
    const disp = composeSheetDisplay(def, ctx, i);
    const t = makePageTransform(disp.ops);
    if (def.id === 'cover' && ctx.coverImage) renderCoverImage(doc, ctx, disp, t);
    renderSheet(doc, def.id === 'cover' ? coverDisplayOps(disp, ctx) : disp, t);
    renderPageFurniture(doc, t);
  });
  // Opt-in dedicated site-render page right after the drawing sheets
  // (10% Package export). Absent keeps the plot set byte-identical.
  if (ctx.siteRender) renderSiteRenderPage(doc, ctx);
  // Opt-in appended pages (mirror buildDxfPackage): absent context fields
  // keep the plot set byte-identical to the default.
  if (ctx.sldSheet) {
    doc.addPage([PAGE_W_IN, PAGE_H_IN], 'landscape');
    const disp = composeSldDisplay(ctx, ctx.feeders ?? [], ctx.sldSheet.options);
    const t = makePageTransform(disp.ops);
    renderSheet(doc, disp, t);
    renderPageFurniture(doc, t);
  }
  if (ctx.bomSheet) {
    // Two B018 pages, exactly like the issued 90% package (CAR-D-B018-1/-2).
    for (const sheet of [1, 2] as const) {
      doc.addPage([PAGE_W_IN, PAGE_H_IN], 'landscape');
      const disp = composeBomSheetDisplay(ctx, ctx.feeders ?? [], { ...ctx.bomSheet.options, sheet });
      const t = makePageTransform(disp.ops);
      renderSheet(doc, disp, t);
      renderPageFurniture(doc, t);
    }
  }
  // MULTI-AREA: a readable full-size plan page per selected footprint, in the
  // SAME order and from the same plans buildDxfPackage appends, so the plot
  // set and the DXF package can never disagree. No-op on single-area exports.
  {
    const areaPlans = areaSheetPlans(ctx);
    areaPlans.forEach((plan, i) => {
      doc.addPage([PAGE_W_IN, PAGE_H_IN], 'landscape');
      const disp = composeAreaSheetDisplay(ctx, plan, i, areaPlans.length);
      const t = makePageTransform(disp.ops);
      renderSheet(doc, disp, t);
      renderPageFurniture(doc, t);
    });
  }
  // Opt-in enlarged AREA tiles last (mirror buildDxfPackage ordering).
  if (ctx.enlargedPlans) {
    const plan = planEnlargedTiles(ctx.design);
    if (plan) {
      plan.tiles.forEach((_tile, i) => {
        doc.addPage([PAGE_W_IN, PAGE_H_IN], 'landscape');
        const dxf = new DxfWriter(ctx.drawingVisibility);
        addBaseLayers(dxf);
        composeEnlargedPlan(dxf, ctx, plan, i);
        // Apply drafter text-label overrides to each enlarged-tile page,
        // mirroring the DXF package enlarged path (absent/empty = byte-identical).
        if (ctx.textOverrides && Object.keys(ctx.textOverrides).length) {
          dxf.patchTextOverridesForExport(ctx.textOverrides);
        }
        const disp: DisplayList = { ops: dxf.ops, layerColors: dxf.layerColors, layerLineTypes: dxf.layerLineTypes, layerWeights: dxf.layerWeights };
        const t = makePageTransform(disp.ops);
        renderSheet(doc, disp, t);
        renderPageFurniture(doc, t);
      });
    }
  }
  renderMechAppendix(doc);
  return doc;
}

// Serialized PDF (for tests and for building the download blob).
export function buildPdfPlotString(ctx: SheetContext): string {
  return rewritePdfProducer(buildPdfPlot(ctx).output());
}

// ---------------------------------------------------------------------------
// Single-page PDF plot of the full "Export DXF" drawing (the complete
// single-sheet design DXF). Captures the SAME display list the DXF writer
// records in buildDesignDxfString — pure vector output, so the plot is
// resolution-independent (no rasterization at any zoom level).
// ---------------------------------------------------------------------------
export function composeDesignDisplay(ctx: SheetContext): DisplayList {
  const dxf = new DxfWriter(ctx.drawingVisibility);
  // Issued-for-10% exports carry the full-width reference bottom banner on
  // the design plot page (same strip the 10% layout sheet draws). Absent
  // cover10 keeps the legacy page byte-identical.
  const banner = ctx.cover10 ? (() => {
    const prefix = (ctx.meta?.projectName?.trim() || ctx.projectName)
      .toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 3) || 'BES';
    return {
      bottomBanner: {
        sheetTitle: '10% PRELIMINARY BESS LAYOUT',
        dwgName: `${prefix}-D-B001-0`,
        revision: 'GA',
        ...(ctx.meta?.neerDwgName ? { neerDwgName: ctx.meta.neerDwgName } : {}),
      },
      // Ornate needle + checkered graphic scale in the right column,
      // between the legend panel and the drawing (reference strip).
      scaleBar: true,
      // Page two carries the COMBINED plan (yard + remote substation), which
      // overshoots a standard scale rung by a hair of border whitespace and
      // so prints a whole step small. Let the frame trim that margin when it
      // wins the better rung, so the combined plan prints as large as the
      // sheet allows.
      tightenToScale: true,
    };
  })() : undefined;
  // ECI legend symbol style rides the same sheetExtras vehicle; absent
  // keeps the composed display byte-identical to the default.
  const extras = (ctx.eciLegend || ctx.includeFeederNfpaAnnotations === false)
    ? { ...(banner ?? {}), ...(ctx.eciLegend ? { eciLegend: true } : {}), ...(ctx.includeFeederNfpaAnnotations === false ? { includeFeederNfpaAnnotations: false } : {}) }
    : banner;
  // Multi-area plot: compose the SELECTED footprints through the same helper
  // the CAD view and the DXF export use, so the plot shows every exported
  // yard (and every yard's feeders) instead of the active one alone. A
  // selection resolving to a single area delegates back to composeDesignDxf
  // inside the helper, so single-area plots stay byte-identical.
  if (siteCompositionApplies(ctx.site)) {
    composeSiteDxf(dxf, {
      areas: ctx.site.areas,
      activeAreaId: ctx.site.activeAreaId,
      areaFeeders: ctx.site.areaFeeders ?? null,
      selectedAreaIds: ctx.site.selectedAreaIds ?? null,
      design: ctx.design,
      projectName: ctx.projectName,
      config: ctx.config,
      meta: ctx.meta,
      feeders: ctx.feeders,
      substation: ctx.substation,
      areaZones: ctx.areaZones,
      sheetExtras: extras,
      textOverrides: ctx.textOverrides,
    });
  } else {
    composeDesignDxf(dxf, ctx.design, ctx.projectName, ctx.config, ctx.meta, ctx.feeders, ctx.substation, ctx.contours, undefined, undefined, ctx.surfacingMesh, ctx.areaZones, extras, ctx.textOverrides);
  }
  return { ops: dxf.ops, layerColors: dxf.layerColors, layerLineTypes: dxf.layerLineTypes, layerWeights: dxf.layerWeights };
}

// Design plot + grounding linework, from the SAME display-list composer the
// exports use. Additive helper for the tour's grounding showcase stop only —
// composeDesignDisplay and every export path are untouched (byte-identical).
export function composeGroundingDisplay(
  ctx: SheetContext,
  grounding: NonNullable<Parameters<typeof composeDesignDxf>[8]>,
): DisplayList {
  const dxf = new DxfWriter(ctx.drawingVisibility);
  composeDesignDxf(dxf, ctx.design, ctx.projectName, ctx.config, ctx.meta, ctx.feeders, ctx.substation, ctx.contours, grounding);
  return { ops: dxf.ops, layerColors: dxf.layerColors, layerLineTypes: dxf.layerLineTypes, layerWeights: dxf.layerWeights };
}

export function buildDesignPdf(ctx: SheetContext): jsPDF {
  const doc = new jsPDF({ unit: 'in', format: [PAGE_W_IN, PAGE_H_IN], orientation: 'landscape', compress: false });
  doc.setCreationDate(plotCreationDate(ctx.meta?.date));
  (doc as any).setFileId('00000000000000000000000000000000');
  doc.setFont('courier', 'normal');

  // "Issued for 10%": prepend the reference-style cover page (vicinity map +
  // aerial key plan) ahead of the single-page design plot. Absent field keeps
  // the one-page output byte-identical to the legacy export.
  if (ctx.cover10) {
    const cover = composeSheetDisplay(SHEET_REGISTRY[0], ctx, 0);
    const tc = makePageTransform(cover.ops);
    renderCoverImage(doc, ctx, cover, tc);
    renderSheet(doc, coverDisplayOps(cover, ctx), tc);
    renderPageFurniture(doc, tc);
    doc.addPage([PAGE_W_IN, PAGE_H_IN], 'landscape');
  }

  const disp = composeDesignDisplay(ctx);
  const t = makePageTransform(disp.ops);
  renderSheet(doc, disp, t);
  renderPageFurniture(doc, t);

  // MULTI-AREA: the page above frames the WHOLE selection — the coordination
  // drawing — which on a site with a remote substation prints the yards far
  // too small to read. Each selected footprint follows on its own page at the
  // scale it would print at alone. No-op (single page) on single-area exports.
  const areaPlans = areaSheetPlans(ctx);
  areaPlans.forEach((plan, i) => {
    doc.addPage([PAGE_W_IN, PAGE_H_IN], 'landscape');
    const ad = composeAreaSheetDisplay(ctx, plan, i, areaPlans.length);
    const at = makePageTransform(ad.ops);
    renderSheet(doc, ad, at);
    renderPageFurniture(doc, at);
  });
  return doc;
}

// Serialized single-page design PDF (for tests and the download blob).
export function buildDesignPdfString(ctx: SheetContext): string {
  return rewritePdfProducer(buildDesignPdf(ctx).output());
}

// ---------------------------------------------------------------------------
// Single-page PDF plot of the STANDALONE single-line diagram sheet.
// Captures the same display list buildSldDxfString records, so the SLD PDF
// can never drift from the SLD DXF. Additive: nothing above changes.
// ---------------------------------------------------------------------------
export function composeSldDisplay(
  ctx: SheetContext,
  feeders: import('./feeders').FeederCircuit[],
  opts?: import('./sld').SldOptions
): DisplayList {
  const dxf = new DxfWriter();
  composeSldDxf(dxf, ctx.design, ctx.projectName, feeders, ctx.config, ctx.meta, opts);
  return { ops: dxf.ops, layerColors: dxf.layerColors, layerLineTypes: dxf.layerLineTypes, layerWeights: dxf.layerWeights };
}

export function buildSldPdf(
  ctx: SheetContext,
  feeders: import('./feeders').FeederCircuit[],
  opts?: import('./sld').SldOptions
): jsPDF {
  const doc = new jsPDF({ unit: 'in', format: [PAGE_W_IN, PAGE_H_IN], orientation: 'landscape', compress: false });
  doc.setCreationDate(plotCreationDate(ctx.meta?.date));
  (doc as any).setFileId('00000000000000000000000000000000');
  doc.setFont('courier', 'normal');

  const disp = composeSldDisplay(ctx, feeders, opts);
  const t = makePageTransform(disp.ops);
  renderSheet(doc, disp, t);
  renderPageFurniture(doc, t);
  return doc;
}

// Serialized SLD PDF (for tests and the download blob).
export function buildSldPdfString(
  ctx: SheetContext,
  feeders: import('./feeders').FeederCircuit[],
  opts?: import('./sld').SldOptions
): string {
  return rewritePdfProducer(buildSldPdf(ctx, feeders, opts).output());
}

// ---------------------------------------------------------------------------
// Single-page PDF plot of the STANDALONE bill-of-materials schedule sheet.
// Captures the same display list buildBomSheetDxfString records, so the
// PDF can never drift from the DXF. Additive: nothing above changes.
// ---------------------------------------------------------------------------
export function composeBomSheetDisplay(
  ctx: SheetContext,
  feeders: import('./feeders').FeederCircuit[],
  opts?: import('./bomSheet').BomSheetOptions
): DisplayList {
  const dxf = new DxfWriter();
  composeBomSheetDxf(dxf, ctx.design, ctx.projectName, feeders, ctx.config, ctx.meta, opts);
  return { ops: dxf.ops, layerColors: dxf.layerColors, layerLineTypes: dxf.layerLineTypes, layerWeights: dxf.layerWeights };
}

export function buildBomSheetPdf(
  ctx: SheetContext,
  feeders: import('./feeders').FeederCircuit[],
  opts?: import('./bomSheet').BomSheetOptions
): jsPDF {
  const doc = new jsPDF({ unit: 'in', format: [PAGE_W_IN, PAGE_H_IN], orientation: 'landscape', compress: false });
  doc.setCreationDate(plotCreationDate(ctx.meta?.date));
  (doc as any).setFileId('00000000000000000000000000000000');
  doc.setFont('courier', 'normal');

  // Both B018 sheets, one ANSI D page each (CAR-D-B018-1/-2 template).
  ([1, 2] as const).forEach((sheet, i) => {
    if (i > 0) doc.addPage([PAGE_W_IN, PAGE_H_IN], 'landscape');
    const disp = composeBomSheetDisplay(ctx, feeders, { ...opts, sheet });
    const t = makePageTransform(disp.ops);
    renderSheet(doc, disp, t);
    renderPageFurniture(doc, t);
  });
  return doc;
}

// Serialized BOM sheet PDF (for tests and the download blob).
export function buildBomSheetPdfString(
  ctx: SheetContext,
  feeders: import('./feeders').FeederCircuit[],
  opts?: import('./bomSheet').BomSheetOptions
): string {
  return rewritePdfProducer(buildBomSheetPdf(ctx, feeders, opts).output());
}

// ---------------------------------------------------------------------------
// Single-page PDF plot of the STANDALONE relay & metering one-line sheet.
// Captures the same display list buildRelayOneLineDxfString records, so the
// PDF can never drift from the DXF. Additive: nothing above changes.
// ---------------------------------------------------------------------------
export function composeRelayDisplay(ctx: SheetContext, feeders: import('./feeders').FeederCircuit[]): DisplayList {
  const dxf = new DxfWriter();
  composeRelayOneLineDxf(dxf, ctx.design, ctx.projectName, feeders, ctx.config, ctx.meta);
  return { ops: dxf.ops, layerColors: dxf.layerColors, layerLineTypes: dxf.layerLineTypes, layerWeights: dxf.layerWeights };
}

export function buildRelayPdf(ctx: SheetContext, feeders: import('./feeders').FeederCircuit[]): jsPDF {
  const doc = new jsPDF({ unit: 'in', format: [PAGE_W_IN, PAGE_H_IN], orientation: 'landscape', compress: false });
  doc.setCreationDate(plotCreationDate(ctx.meta?.date));
  (doc as any).setFileId('00000000000000000000000000000000');
  doc.setFont('courier', 'normal');

  const disp = composeRelayDisplay(ctx, feeders);
  const t = makePageTransform(disp.ops);
  renderSheet(doc, disp, t);
  renderPageFurniture(doc, t);
  return doc;
}

// Serialized relay one-line PDF (for tests and the download blob).
export function buildRelayPdfString(ctx: SheetContext, feeders: import('./feeders').FeederCircuit[]): string {
  return rewritePdfProducer(buildRelayPdf(ctx, feeders).output());
}

// ---------------------------------------------------------------------------
// Single-page PDF plot of the STANDALONE grading plan sheet.
// Captures the same display list buildGradingPlanDxfString records, so the
// PDF can never drift from the DXF. Additive: nothing above changes.
// ---------------------------------------------------------------------------
export function composeGradingPlanDisplay(
  ctx: SheetContext,
  data: import('./gradingPlan').GradingPlanData
): DisplayList {
  const dxf = new DxfWriter();
  composeGradingPlanDxf(dxf, ctx.design, ctx.projectName, data, ctx.config, ctx.meta);
  return { ops: dxf.ops, layerColors: dxf.layerColors, layerLineTypes: dxf.layerLineTypes, layerWeights: dxf.layerWeights };
}

export function buildGradingPlanPdf(
  ctx: SheetContext,
  data: import('./gradingPlan').GradingPlanData
): jsPDF {
  const doc = new jsPDF({ unit: 'in', format: [PAGE_W_IN, PAGE_H_IN], orientation: 'landscape', compress: false });
  doc.setCreationDate(plotCreationDate(ctx.meta?.date));
  (doc as any).setFileId('00000000000000000000000000000000');
  doc.setFont('courier', 'normal');

  const disp = composeGradingPlanDisplay(ctx, data);
  const t = makePageTransform(disp.ops);
  renderSheet(doc, disp, t);
  renderPageFurniture(doc, t);
  return doc;
}

// Serialized grading plan PDF (for tests and the download blob).
export function buildGradingPlanPdfString(
  ctx: SheetContext,
  data: import('./gradingPlan').GradingPlanData
): string {
  return rewritePdfProducer(buildGradingPlanPdf(ctx, data).output());
}

// ---------------------------------------------------------------------------
// Single-page PDF plot of the STANDALONE grading cross-sections sheet (GP-2).
// Captures the same display list buildGradingSectionsDxfString records, so
// the PDF can never drift from the DXF. Additive: nothing above changes.
// ---------------------------------------------------------------------------
export function composeGradingSectionsDisplay(
  ctx: SheetContext,
  sections: import('./gradingSections').GradingSectionSet
): DisplayList {
  const dxf = new DxfWriter();
  composeGradingSectionsDxf(dxf, ctx.design, ctx.projectName, sections, ctx.config, ctx.meta);
  return { ops: dxf.ops, layerColors: dxf.layerColors, layerLineTypes: dxf.layerLineTypes, layerWeights: dxf.layerWeights };
}

export function buildGradingSectionsPdf(
  ctx: SheetContext,
  sections: import('./gradingSections').GradingSectionSet
): jsPDF {
  const doc = new jsPDF({ unit: 'in', format: [PAGE_W_IN, PAGE_H_IN], orientation: 'landscape', compress: false });
  doc.setCreationDate(plotCreationDate(ctx.meta?.date));
  (doc as any).setFileId('00000000000000000000000000000000');
  doc.setFont('courier', 'normal');

  const disp = composeGradingSectionsDisplay(ctx, sections);
  const t = makePageTransform(disp.ops);
  renderSheet(doc, disp, t);
  renderPageFurniture(doc, t);
  return doc;
}

// ---------------------------------------------------------------------------
// Single-page PDF plot of the STANDALONE drainage area map sheet (DR-1).
// Captures the same display list buildDrainageSheetDxfString records, so
// the PDF can never drift from the DXF. Additive: nothing above changes.
// ---------------------------------------------------------------------------
export function composeDrainageSheetDisplay(
  ctx: SheetContext,
  fg: import('./gradingSurface').FgSurface,
  model: import('./drainage').DrainageModel
): DisplayList {
  const dxf = new DxfWriter();
  composeDrainageSheetDxf(dxf, ctx.design, ctx.projectName, fg, model, ctx.config, ctx.meta);
  return { ops: dxf.ops, layerColors: dxf.layerColors, layerLineTypes: dxf.layerLineTypes, layerWeights: dxf.layerWeights };
}

export function buildDrainageSheetPdf(
  ctx: SheetContext,
  fg: import('./gradingSurface').FgSurface,
  model: import('./drainage').DrainageModel
): jsPDF {
  const doc = new jsPDF({ unit: 'in', format: [PAGE_W_IN, PAGE_H_IN], orientation: 'landscape', compress: false });
  doc.setCreationDate(plotCreationDate(ctx.meta?.date));
  (doc as any).setFileId('00000000000000000000000000000000');
  doc.setFont('courier', 'normal');

  const disp = composeDrainageSheetDisplay(ctx, fg, model);
  const t = makePageTransform(disp.ops);
  renderSheet(doc, disp, t);
  renderPageFurniture(doc, t);
  return doc;
}

// Serialized DR-1 PDF (for tests and the download blob).
export function buildDrainageSheetPdfString(
  ctx: SheetContext,
  fg: import('./gradingSurface').FgSurface,
  model: import('./drainage').DrainageModel
): string {
  return rewritePdfProducer(buildDrainageSheetPdf(ctx, fg, model).output());
}

// ---------------------------------------------------------------------------
// Single-page PDF plot of the STANDALONE drainage details sheet (DR-2).
// Captures the same display list buildDrainageDetailSheetDxfString records,
// so the PDF can never drift from the DXF. Additive: nothing above changes.
// ---------------------------------------------------------------------------
export function composeDrainageDetailDisplay(
  ctx: SheetContext,
  fg: import('./gradingSurface').FgSurface,
  model: import('./drainage').DrainageModel
): DisplayList {
  const dxf = new DxfWriter();
  composeDrainageDetailSheetDxf(dxf, ctx.design, ctx.projectName, fg, model, ctx.config, ctx.meta);
  return { ops: dxf.ops, layerColors: dxf.layerColors, layerLineTypes: dxf.layerLineTypes, layerWeights: dxf.layerWeights };
}

export function buildDrainageDetailSheetPdf(
  ctx: SheetContext,
  fg: import('./gradingSurface').FgSurface,
  model: import('./drainage').DrainageModel
): jsPDF {
  const doc = new jsPDF({ unit: 'in', format: [PAGE_W_IN, PAGE_H_IN], orientation: 'landscape', compress: false });
  doc.setCreationDate(plotCreationDate(ctx.meta?.date));
  (doc as any).setFileId('00000000000000000000000000000000');
  doc.setFont('courier', 'normal');

  const disp = composeDrainageDetailDisplay(ctx, fg, model);
  const t = makePageTransform(disp.ops);
  renderSheet(doc, disp, t);
  renderPageFurniture(doc, t);
  return doc;
}

// Serialized DR-2 PDF (for tests and the download blob).
export function buildDrainageDetailSheetPdfString(
  ctx: SheetContext,
  fg: import('./gradingSurface').FgSurface,
  model: import('./drainage').DrainageModel
): string {
  return rewritePdfProducer(buildDrainageDetailSheetPdf(ctx, fg, model).output());
}

// Serialized cross-sections PDF (for tests and the download blob).
export function buildGradingSectionsPdfString(
  ctx: SheetContext,
  sections: import('./gradingSections').GradingSectionSet
): string {
  return rewritePdfProducer(buildGradingSectionsPdf(ctx, sections).output());
}
