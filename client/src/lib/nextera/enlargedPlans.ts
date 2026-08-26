// Enlarged partial site-plan sheets ("AREA" tiles) for the 10% package.
//
// Problem: on large parcels the overall site plan picks 200-1000 ft/in and
// fixed 4-ft annotation prints at ~0.01" — unreadable. Fix: when the overall
// plan scale exceeds READABLE_MAX_FT_PER_IN, append a deterministic grid of
// enlarged plan tiles at a standard readable scale (40-100 ft/in ladder),
// each with match lines to its neighbors and a key-plan inset showing which
// window of the yard the sheet covers.
//
// Opt-in via SheetContext.enlargedPlans (10% exports only) — absent keeps
// both the DXF package and the PDF plot set byte-identical.
//
// Page-scale trick: makePageTransform auto-fits from op bounds, so each tile
// composes a border polyline spanning EXACTLY availW×S by availH×S model
// feet. pickScale then returns exactly the tile scale, and the printed
// "1\" = S'" caption can never drift from the actual transform. Every other
// op is clipped/placed strictly inside that window (text extents included,
// using the same len*h*0.9 estimate displayBounds uses).
import { SiteDesign } from './types';
import { BessConfiguration } from './catalog';
import {
  DxfWriter,
  DisplayOp,
  LAYERS,
  addBaseLayers,
  drawBoundaryAndFence,
  drawSurfacing,
  drawEquipment,
  drawEquipmentLabels,
  drawReservedZones,
  drawRoads,
  drawTrench,
  drawCables,
  drawFeedersAndSubstation,
  drawGate,
  drawContours,
  drawGrounding,
  drawAreaZones,
  addSpacingDimensions,
  CHAR_W,
  SPEC_LABEL_LINES,
} from './dxfExport';

// Set view of the repeated model/rating boilerplate lines (decluttered on
// the tiles — see emitClipped).
const SPEC_LINE_SET: ReadonlySet<string> = new Set(SPEC_LABEL_LINES);
import type { SheetContext } from './dxfSheets';
import { clipSeg } from './vicinityMap';
import { PAGE_W_IN, PAGE_H_IN, PAGE_MARGIN_IN, pickScale } from './plotScale';

// Layer for match lines / window borders / key plan linework on the tiles.
export const ENLARGED_LAYER = 'enlarged-plan';
// Overall-site-plan key grid layer (tile windows + tags drawn on sheet 2).
export const ENLARGED_KEY_LAYER = 'enlarged-key';

// Above this overall plot scale (ft/in) the fixed-height annotation is no
// longer readable at print size, so enlarged tiles are generated.
export const READABLE_MAX_FT_PER_IN = 60;
// Standard scales considered for the tiles (readable end of the ladder).
export const TILE_SCALES_FT_PER_IN = [40, 50, 60, 80, 100];
// Cap the sheet count so a huge parcel can't explode the package.
export const MAX_ENLARGED_TILES = 12;
// Neighboring tiles overlap by this much so match lines land on shared
// geometry rather than a knife edge.
export const TILE_OVERLAP_FT = 25;
// Padding around the boundary extents before tiling.
const TILE_PAD_FT = 25;

// Page real estate (inches): right strip reserved for the key plan, bottom
// strip for the sheet title/scale caption; the rest is the plan view.
const AVAIL_W_IN = PAGE_W_IN - 2 * PAGE_MARGIN_IN; // 33
const AVAIL_H_IN = PAGE_H_IN - 2 * PAGE_MARGIN_IN; // 21
const KEY_STRIP_IN = 4.5;
const TITLE_STRIP_IN = 0.9;
export const TILE_VIEW_W_IN = AVAIL_W_IN - KEY_STRIP_IN;  // 28.5
export const TILE_VIEW_H_IN = AVAIL_H_IN - TITLE_STRIP_IN; // 20.1

// Minimum printed text height on the enlarged tiles (inches). Source text
// is boosted all the way to this floor — the tiles exist because the base
// sheet's text is unreadable, so a bounded boost (the old 2.5x cap) that
// still prints below the floor defeats their whole purpose. Labels whose
// boosted extent would escape the view window fall back to their original
// height (see emitClipped) rather than vanish.
export const MIN_TEXT_IN = 0.08;

export interface Rect { minX: number; minY: number; maxX: number; maxY: number }

export interface EnlargedTile {
  tag: string;   // "A1".. row letter (north-first) + column number (west-first)
  ix: number;    // column index
  iy: number;    // row index (0 = north)
  view: Rect;    // model-feet window shown in the plan view area
}

export interface EnlargedPlan {
  scale: number;          // tile plot scale, ft per inch
  overallScale: number;   // the overall site plan's plot scale
  cols: number;
  rows: number;
  bounds: Rect;           // padded boundary extents the grid covers
  tiles: EnlargedTile[];
}

function boundaryBounds(design: SiteDesign): Rect {
  const xs = design.boundary.polygon.map(p => p.x);
  const ys = design.boundary.polygon.map(p => p.y);
  return {
    minX: Math.min(...xs) - TILE_PAD_FT,
    maxX: Math.max(...xs) + TILE_PAD_FT,
    minY: Math.min(...ys) - TILE_PAD_FT,
    maxY: Math.max(...ys) + TILE_PAD_FT,
  };
}

// Deterministic tile plan, or null when the overall plan already prints at
// a readable scale (small parcels) or no readable tiling stays under the
// sheet cap while actually enlarging.
export function planEnlargedTiles(design: SiteDesign): EnlargedPlan | null {
  const b = boundaryBounds(design);
  const w = b.maxX - b.minX, h = b.maxY - b.minY;
  const overallScale = pickScale(w, h);
  if (overallScale <= READABLE_MAX_FT_PER_IN) return null;
  // Walk the READABLE ladder only — tiles past 100 ft/in would defeat the
  // whole point (4-10 ft labels print below the 0.08" floor there). If even
  // 100 ft/in exceeds the sheet cap (a 12-tile grid at 100 covers ~2 miles,
  // beyond any realistic yard), return null rather than emit unreadable
  // tiles: no enlargement is better than a false one.
  for (const s of TILE_SCALES_FT_PER_IN) {
    if (s >= overallScale) break; // no longer an enlargement
    const vw = TILE_VIEW_W_IN * s, vh = TILE_VIEW_H_IN * s;
    const cols = Math.max(1, Math.ceil((w - TILE_OVERLAP_FT) / (vw - TILE_OVERLAP_FT)));
    const rows = Math.max(1, Math.ceil((h - TILE_OVERLAP_FT) / (vh - TILE_OVERLAP_FT)));
    if (cols * rows > MAX_ENLARGED_TILES) continue;
    const tiles: EnlargedTile[] = [];
    for (let iy = 0; iy < rows; iy++) {
      for (let ix = 0; ix < cols; ix++) {
        // Rows from the north (top) so tags read like a map grid; last
        // row/col clamps flush to the far edge instead of hanging past it.
        let x0 = b.minX + ix * (vw - TILE_OVERLAP_FT);
        if (cols > 1) x0 = Math.min(x0, b.maxX - vw);
        let y1 = b.maxY - iy * (vh - TILE_OVERLAP_FT);
        if (rows > 1) y1 = Math.max(y1, b.minY + vh);
        tiles.push({
          tag: `${String.fromCharCode(65 + iy)}${ix + 1}`,
          ix, iy,
          view: { minX: x0, maxX: x0 + vw, minY: y1 - vh, maxY: y1 },
        });
      }
    }
    return { scale: s, overallScale, cols, rows, bounds: b, tiles };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

// Sutherland-Hodgman polygon clip to an axis-aligned rect.
export function clipPolyToRect(pts: number[][], r: Rect): number[][] {
  let out = pts;
  const clipEdge = (
    inside: (p: number[]) => boolean,
    cross: (a: number[], b: number[]) => number[],
  ) => {
    const res: number[][] = [];
    for (let i = 0; i < out.length; i++) {
      const a = out[i], b = out[(i + 1) % out.length];
      const ia = inside(a), ib = inside(b);
      if (ia) {
        res.push(a);
        if (!ib) res.push(cross(a, b));
      } else if (ib) {
        res.push(cross(a, b));
      }
    }
    out = res;
  };
  const lerp = (a: number[], b: number[], t: number) =>
    [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  clipEdge(p => p[0] >= r.minX, (a, b) => lerp(a, b, (r.minX - a[0]) / (b[0] - a[0])));
  if (!out.length) return out;
  clipEdge(p => p[0] <= r.maxX, (a, b) => lerp(a, b, (r.maxX - a[0]) / (b[0] - a[0])));
  if (!out.length) return out;
  clipEdge(p => p[1] >= r.minY, (a, b) => lerp(a, b, (r.minY - a[1]) / (b[1] - a[1])));
  if (!out.length) return out;
  clipEdge(p => p[1] <= r.maxY, (a, b) => lerp(a, b, (r.maxY - a[1]) / (b[1] - a[1])));
  return out;
}

function arcToPts(op: Extract<DisplayOp, { kind: 'arc' }>): number[][] {
  let { start, end } = op;
  if (op.ccw && end < start) end += Math.PI * 2;
  if (!op.ccw && end > start) end -= Math.PI * 2;
  const steps = Math.max(8, Math.ceil(Math.abs(end - start) / 0.1));
  const pts: number[][] = [];
  for (let i = 0; i <= steps; i++) {
    const a = start + ((end - start) * i) / steps;
    pts.push([op.cx + op.r * Math.cos(a), op.cy + op.r * Math.sin(a)]);
  }
  return pts;
}

// ---------------------------------------------------------------------------
// Tile composition
// ---------------------------------------------------------------------------

// Full design content (site plan + cable/trench + feeders) — the enlarged
// tiles are where engineers actually read the detail, so they carry every
// plan layer rather than one discipline's subset.
export function composeSourceContent(dxf: DxfWriter, ctx: SheetContext) {
  drawBoundaryAndFence(dxf, ctx.design);
  drawSurfacing(dxf, ctx.design, ctx.surfacingMesh);
  drawTrench(dxf, ctx.design);
  drawCables(dxf, ctx.design);
  drawEquipment(dxf, ctx.design, ctx.config, !!ctx.eciLegend, true);
  drawReservedZones(dxf, ctx.design);
  drawRoads(dxf, ctx.design, true);
  addSpacingDimensions(dxf, ctx.design, ctx.includeFeederNfpaAnnotations !== false);
  drawFeedersAndSubstation(dxf, ctx.feeders, ctx.substation, ctx.design, ctx.includeFeederNfpaAnnotations !== false);
  drawGate(dxf, ctx.design);
  if (ctx.contours && ctx.contours.lines.length > 0) drawContours(dxf, ctx.contours);
  if (ctx.grounding) drawGrounding(dxf, ctx.grounding);
  if (ctx.areaZones && ctx.areaZones.length) drawAreaZones(dxf, ctx.areaZones);
  // Labels dead last: white masks + tags plot over every other layer,
  // including opt-in contour/grounding/zone linework crossing the yard.
  drawEquipmentLabels(dxf, ctx.design, ctx.config);
}

// Axis-aligned extent of a text op's estimated glyph box at height h,
// honoring rotation (corners rotated about the baseline-left anchor, then
// AABB'd). Width uses the same len*h*CHAR_W estimate displayBounds uses.
export function textExtentAt(
  op: Extract<DisplayOp, { kind: 'text' }>, h: number
): Rect {
  const w = op.text.length * h * CHAR_W;
  const rad = ((op.rot ?? 0) * Math.PI) / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  // Center-justified ops (register F-24) grow symmetrically about their
  // baseline center when re-emitted at a boosted height — the left anchor
  // must be re-derived from (cx, cy) at THIS height, or the collision model
  // disagrees with the emission and boosted labels overlap for real.
  const ax = op.cx !== undefined ? op.cx - (cos * w) / 2 : op.x;
  const ay = op.cx !== undefined && op.cy !== undefined ? op.cy - (sin * w) / 2 : op.y;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [px, py] of [[0, 0], [w, 0], [w, h], [0, h]]) {
    const x = ax + px * cos - py * sin;
    const y = ay + px * sin + py * cos;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  return { minX, maxX, minY, maxY };
}

const rectsOverlap = (a: Rect, b: Rect) =>
  a.minX < b.maxX && b.minX < a.maxX && a.minY < b.maxY && b.minY < a.maxY;

// Number of intermediate heights tried between the boosted floor and the
// source height when the full boost collides.
const BOOST_LADDER_STEPS = 5;

// Collision-aware boost: pick the largest height on a ladder from the
// readable floor (minH) down to the source height whose padded extent stays
// clear of every blocker extent AND inside the view window. Boosting every
// label unconditionally to the floor piled PCS/BESS/trench/feeder texts on
// top of each other (labels were sized to fit their rects; a 3-8 ft floor
// height overflows them into neighbors). Blockers must include every OTHER
// label's source extent (reserved up front) so no label can ever boost over
// another's position — a label therefore always keeps at least its source
// height. Returns the largest collision-free window-fitting height, or null
// when none exists (source escapes the window, or even the source height
// collides — the caller decides between keeping the pre-existing overlap
// and decluttering a repeated callout).
export function fitBoostedHeight(
  op: Extract<DisplayOp, { kind: 'text' }>,
  minH: number,
  view: Rect,
  blockers: Rect[],
): number | null {
  const candidates: number[] = [];
  if (op.h >= minH) {
    candidates.push(op.h);
  } else {
    for (let k = 0; k <= BOOST_LADDER_STEPS; k++) {
      candidates.push(minH + (op.h - minH) * (k / BOOST_LADDER_STEPS));
    }
  }
  for (const h of candidates) {
    const ext = textExtentAt(op, h);
    // Window fit: rotation-aware extent must stay inside on all four sides,
    // plus the max-side estimate displayBounds uses (keeps bounds pinned).
    if (ext.minX < view.minX || ext.maxX > view.maxX ||
        ext.minY < view.minY || ext.maxY > view.maxY) continue;
    if (op.x + op.text.length * h * CHAR_W > view.maxX || op.y + h > view.maxY) continue;
    const pad = h * 0.15;
    const padded: Rect = {
      minX: ext.minX - pad, maxX: ext.maxX + pad,
      minY: ext.minY - pad, maxY: ext.maxY + pad,
    };
    if (blockers.some(p => rectsOverlap(padded, p))) continue;
    return h;
  }
  return null;
}

// Radius within which a colliding label is decluttered when an identical
// text was already accepted (repeated trench/feeder callouts along a run —
// dropping the crossing instance loses nothing).
export const DECLUTTER_DUP_RADIUS_FT = 500;

// Decide every in-view text's height, collision-aware, in source order.
// Returns the height per accepted op plus the set of ops kept DESPITE a
// pre-existing source-height overlap (the source annotation already
// overlapped — the tiles keep, never worsen, that condition). Exported so
// the overlap regression test can distinguish boost-created smears (a bug)
// from overlaps inherited from the source drawing.
export function fitTileTextHeights(
  inView: Extract<DisplayOp, { kind: 'text' }>[],
  view: Rect,
  minH: number,
): {
  heights: Map<Extract<DisplayOp, { kind: 'text' }>, number>;
  preexisting: Set<Extract<DisplayOp, { kind: 'text' }>>;
} {
  const heights = new Map<Extract<DisplayOp, { kind: 'text' }>, number>();
  const preexisting = new Set<Extract<DisplayOp, { kind: 'text' }>>();
  // Every label's SOURCE extent is reserved up front: a label boosting
  // toward the floor may never grow over another label's position, and in
  // turn always keeps at least its own source height.
  const sourceExtents = inView.map(op => textExtentAt(op, op.h));
  const placedExtents: Rect[] = [];
  const accepted: Extract<DisplayOp, { kind: 'text' }>[] = [];
  inView.forEach((op, i) => {
    const blockers = placedExtents.concat(
      sourceExtents.filter((_, j) => j > i)); // earlier ops already in placedExtents
    let h = fitBoostedHeight(op, minH, view, blockers);
    if (h === null) {
      // Even the source height collides (a pre-existing overlap in the
      // source annotation). Declutter when the same text is already placed
      // nearby (repeated trench/feeder callouts along a run); otherwise the
      // window-fitting source height stays — never silently lose unique info.
      const srcExt = sourceExtents[i];
      if (srcExt.minX < view.minX || srcExt.maxX > view.maxX ||
          srcExt.minY < view.minY || srcExt.maxY > view.maxY) return;
      if (op.x + op.text.length * op.h * CHAR_W > view.maxX || op.y + op.h > view.maxY) return;
      const dup = accepted.some(p => p.text === op.text &&
        Math.hypot(p.x - op.x, p.y - op.y) <= DECLUTTER_DUP_RADIUS_FT);
      if (dup) return;
      h = op.h;
      preexisting.add(op);
    }
    heights.set(op, h);
    placedExtents.push(textExtentAt(op, h));
    accepted.push(op);
  });
  return { heights, preexisting };
}

// In-view non-boilerplate texts, exact duplicates collapsed — the input to
// fitTileTextHeights. Exported for the overlap regression test.
export function tileTextOps(ops: DisplayOp[], view: Rect): Extract<DisplayOp, { kind: 'text' }>[] {
  // Declutter: repeated model/rating boilerplate lines ("LG JF2 DC LINK
  // 5.1MWH" on every container) are dropped on the tiles — an identity tag
  // boosted to the floor needs its box's whole label row, and the model
  // info lives on the base sheets and equipment schedule.
  // Exact-duplicate callouts (same text, anchor, rotation — e.g. a trench
  // callout emitted once per segment) collapse to one: duplicates can never
  // deconflict from each other at any height.
  const seenKeys = new Set<string>();
  return ops.filter((op): op is Extract<DisplayOp, { kind: 'text' }> => {
    if (op.kind !== 'text' || SPEC_LINE_SET.has(op.text)) return false;
    if (op.x < view.minX || op.x > view.maxX || op.y < view.minY || op.y > view.maxY) return false;
    const key = `${op.text}|${op.x.toFixed(2)},${op.y.toFixed(2)}|${op.rot ?? 0}`;
    if (seenKeys.has(key)) return false;
    seenKeys.add(key);
    return true;
  });
}

// Emit the source ops clipped to the tile's view rect. Text is boosted
// toward the readable floor (collision-aware — see fitBoostedHeight) and
// dropped when its estimated extent (the same len*h*0.9 displayBounds uses)
// would escape the view window.
function emitClipped(dxf: DxfWriter, src: DxfWriter, view: Rect, scale: number) {
  // Carry over dynamically-registered layers (feeder tints, symbol gray...)
  for (const [name, color] of Object.entries(src.layerColors)) {
    if (dxf.layerColors[name] === undefined) {
      dxf.addLayer(name, color, src.layerLineTypes[name] ?? 'CONTINUOUS');
    }
  }
  const minH = MIN_TEXT_IN * scale;
  // Clip intersection arithmetic can land vertices an epsilon outside the
  // window; the border polyline pins the page bounds EXACTLY, so snap every
  // clipped coordinate back inside (an epsilon overflow bumps pickScale to
  // the next ladder step and unpins the page transform).
  const cx = (x: number) => Math.min(Math.max(x, view.minX), view.maxX);
  const cy = (y: number) => Math.min(Math.max(y, view.minY), view.maxY);
  const seg = (a: number[], b: number[], layer: string, color?: number) => {
    const c = clipSeg([a[0], a[1]], [b[0], b[1]], view);
    if (c) dxf.addLine(cx(c[0][0]), cy(c[0][1]), cx(c[1][0]), cy(c[1][1]), layer, color);
  };
  // Pre-pass: decide every in-view text's height collision-aware, in source
  // order, so the emission loop below stays 1:1 with the source op order.
  const { heights: textHeights } = fitTileTextHeights(tileTextOps(src.ops, view), view, minH);
  // [622] Equipment label masks must track the FINAL emitted text extents:
  // the boost pass above can grow a label past its source-sized wipeout,
  // which would let underlying linework cross the enlarged text. Collect
  // each accepted label's boosted extent so the mask hatch below can grow
  // to cover it (and drop masks whose every label was dropped).
  const boostedLabels = src.ops.filter(
    (o): o is Extract<DisplayOp, { kind: 'text' }> =>
      o.kind === 'text' && o.layer === LAYERS.EQUIP_LABELS && textHeights.has(o as any));
  const MASK_PAD = 0.6;
  for (const op of src.ops) {
    if (op.kind === 'line') {
      seg([op.x1, op.y1], [op.x2, op.y2], op.layer, op.color);
    } else if (op.kind === 'poly') {
      const n = op.pts.length;
      for (let i = 0; i < (op.closed ? n : n - 1); i++) {
        seg(op.pts[i], op.pts[(i + 1) % n], op.layer, op.color);
      }
    } else if (op.kind === 'arc') {
      const pts = arcToPts(op);
      for (let i = 0; i < pts.length - 1; i++) seg(pts[i], pts[i + 1], op.layer);
    } else if (op.kind === 'hatch') {
      let srcLoops = op.loops;
      if (op.layer === LAYERS.LABEL_MASK) {
        const ring = op.loops[0] ?? [];
        let mnX = Infinity, mxX = -Infinity, mnY = Infinity, mxY = -Infinity;
        for (const [x, y] of ring) {
          if (x < mnX) mnX = x; if (x > mxX) mxX = x;
          if (y < mnY) mnY = y; if (y > mxY) mxY = y;
        }
        const mine = boostedLabels.filter(t =>
          t.x >= mnX && t.x <= mxX && t.y >= mnY && t.y <= mxY);
        if (!mine.length) continue; // every label dropped — no blank white rect
        for (const t of mine) {
          const e = textExtentAt(t, textHeights.get(t as any)!);
          mnX = Math.min(mnX, e.minX - MASK_PAD); mxX = Math.max(mxX, e.maxX + MASK_PAD);
          mnY = Math.min(mnY, e.minY - MASK_PAD); mxY = Math.max(mxY, e.maxY + MASK_PAD);
        }
        srcLoops = [[[mnX, mnY], [mxX, mnY], [mxX, mxY], [mnX, mxY]]];
      }
      const loops = srcLoops
        .map(l => clipPolyToRect(l, view).map(([x, y]): [number, number] => [cx(x), cy(y)]))
        .filter(l => l.length >= 3);
      if (loops.length) dxf.addHatchLoops(loops, op.layer, op.pattern, op.color);
    } else if (op.kind === 'text') {
      // Anchor must be in view; the collision-aware pre-pass above decided
      // the height (or dropped the label — window escape / unresolvable
      // collision even at the source height).
      const h = textHeights.get(op);
      if (h === undefined) continue;
      if (op.cx !== undefined && op.cy !== undefined) {
        // Preserve true DXF center justification on tiles (register F-24,
        // #649): re-anchor on the source center so the boosted height grows
        // symmetrically and AutoCAD centers on its own font metrics.
        dxf.addCenteredText(op.cx, op.cy, h, op.text, op.layer, op.color,
          { rot: op.rot, est: op.est ?? 0.8 });
      } else {
        dxf.addText(op.x, op.y, h, op.text, op.layer, op.rot, op.color);
      }
    }
  }
}

// Compose one enlarged tile sheet into the writer: window border (pins the
// page transform to exactly the tile scale), clipped design geometry, match
// lines, key-plan inset, and title strip.
export function composeEnlargedPlan(
  dxf: DxfWriter, ctx: SheetContext, plan: EnlargedPlan, index: number
) {
  const tile = plan.tiles[index];
  const s = plan.scale;
  const view = tile.view;
  // Full page window in model feet (view = top-left region of it).
  const win: Rect = {
    minX: view.minX,
    maxX: view.minX + AVAIL_W_IN * s,
    maxY: view.maxY,
    minY: view.maxY - AVAIL_H_IN * s,
  };
  if (dxf.layerColors[ENLARGED_LAYER] === undefined) dxf.addLayer(ENLARGED_LAYER, 7);

  // 1. Window border first — exact availW x availH extents at scale s.
  dxf.addPolyline(
    [[win.minX, win.minY], [win.maxX, win.minY], [win.maxX, win.maxY], [win.minX, win.maxY]],
    ENLARGED_LAYER, true
  );
  // Plan view frame + key strip / title strip separators.
  dxf.addPolyline(
    [[view.minX, view.minY], [view.maxX, view.minY], [view.maxX, view.maxY], [view.minX, view.maxY]],
    ENLARGED_LAYER, true
  );

  // 2. Clipped design geometry.
  const src = new DxfWriter(ctx.drawingVisibility);
  addBaseLayers(src);
  composeSourceContent(src, ctx);
  emitClipped(dxf, src, view, s);

  // 3. Match lines along edges shared with neighboring tiles.
  if (dxf.layerColors[LAYERS.TEXT_LG] === undefined) dxf.addLayer(LAYERS.TEXT_LG, 7);
  const mlH = 0.1 * s;
  const inset = 0.15 * s;
  const neighborTag = (dix: number, diy: number) => {
    const t = plan.tiles.find(t2 => t2.ix === tile.ix + dix && t2.iy === tile.iy + diy);
    return t ? t.tag : '';
  };
  const matchLine = (
    x1: number, y1: number, x2: number, y2: number,
    tx: number, ty: number, rot: number, other: string
  ) => {
    dxf.addLine(x1, y1, x2, y2, ENLARGED_LAYER);
    dxf.addText(tx, ty, mlH, `MATCH LINE - SEE AREA ${other}`, ENLARGED_LAYER, rot);
  };
  if (tile.ix > 0) {
    const x = view.minX + inset;
    matchLine(x, view.minY, x, view.maxY, x + 0.05 * s, view.minY + 0.5 * s, 90, neighborTag(-1, 0));
  }
  if (tile.ix < plan.cols - 1) {
    const x = view.maxX - inset;
    matchLine(x, view.minY, x, view.maxY, x - mlH - 0.05 * s, view.minY + 0.5 * s, 90, neighborTag(1, 0));
  }
  if (tile.iy > 0) {
    const y = view.maxY - inset;
    matchLine(view.minX, y, view.maxX, y, view.minX + 0.5 * s, y + 0.03 * s, 0, neighborTag(0, -1));
  }
  if (tile.iy < plan.rows - 1) {
    const y = view.minY + inset;
    matchLine(view.minX, y, view.maxX, y, view.minX + 0.5 * s, y - mlH - 0.03 * s, 0, neighborTag(0, 1));
  }

  // 4. Key plan inset in the right strip: boundary + tile grid, current
  // tile hatched.
  const strip: Rect = { minX: view.maxX, maxX: win.maxX, minY: view.minY, maxY: win.maxY };
  const pad = 0.3 * s;
  dxf.addText(
    strip.minX + pad, strip.maxY - 0.45 * s, 0.28 * s, 'KEY PLAN', ENLARGED_LAYER
  );
  const kb = plan.bounds;
  const kw = kb.maxX - kb.minX, kh = kb.maxY - kb.minY;
  const availKW = (strip.maxX - strip.minX) - 2 * pad;
  const availKH = (strip.maxY - strip.minY) - 1.2 * s;
  const kScale = Math.min(availKW / kw, availKH / kh);
  const kx = (x: number) => strip.minX + pad + (x - kb.minX) * kScale;
  const ky = (y: number) => strip.minY + 0.6 * s + (y - kb.minY) * kScale;
  dxf.addPolyline(
    ctx.design.boundary.polygon.map(p => [kx(p.x), ky(p.y)]),
    ENLARGED_LAYER, true
  );
  for (const t of plan.tiles) {
    const r: number[][] = [
      [kx(t.view.minX), ky(t.view.minY)], [kx(t.view.maxX), ky(t.view.minY)],
      [kx(t.view.maxX), ky(t.view.maxY)], [kx(t.view.minX), ky(t.view.maxY)],
    ];
    dxf.addPolyline(r, ENLARGED_LAYER, true);
    if (t === tile) dxf.addHatchLoops([r], ENLARGED_LAYER, 'ANSI31');
    const tagH = Math.min(0.16 * s, (ky(t.view.maxY) - ky(t.view.minY)) * 0.3);
    dxf.addText(
      (kx(t.view.minX) + kx(t.view.maxX)) / 2 - t.tag.length * tagH * CHAR_W / 2,
      (ky(t.view.minY) + ky(t.view.maxY)) / 2 - tagH / 2,
      tagH, t.tag, ENLARGED_LAYER
    );
  }

  // 5. Title strip along the bottom.
  const titleH = 0.28 * s;
  dxf.addLine(win.minX, view.minY, win.maxX, view.minY, ENLARGED_LAYER);
  dxf.addText(
    win.minX + 0.3 * s, win.minY + (TITLE_STRIP_IN * s - titleH) / 2,
    titleH,
    `ENLARGED SITE PLAN - AREA ${tile.tag} (SHEET ${index + 1} OF ${plan.tiles.length})  SCALE: 1" = ${s}'`,
    ENLARGED_LAYER
  );
}

// Standalone AC1015 DXF for one enlarged tile (package zip entry).
export function buildEnlargedPlanDxfString(
  ctx: SheetContext, plan: EnlargedPlan, index: number
): string {
  const dxf = new DxfWriter(ctx.drawingVisibility);
  addBaseLayers(dxf);
  composeEnlargedPlan(dxf, ctx, plan, index);
  // Apply drafter text-label overrides to the enlarged DXF tile, mirroring
  // the package-PDF enlarged path (absent/empty = byte-identical).
  if (ctx.textOverrides && Object.keys(ctx.textOverrides).length) {
    dxf.patchTextOverridesForExport(ctx.textOverrides);
  }
  return dxf.toString();
}

// ---------------------------------------------------------------------------
// Overall-site-plan key grid (scale-aware annotation on sheet 2)
// ---------------------------------------------------------------------------

// When enlarged tiles exist, the overall site plan gains the matching key
// grid: each tile's window outlined + tagged with text sized from the
// OVERALL plot scale so the tags stay readable on the small-scale sheet.
export function drawEnlargedKeyGrid(dxf: DxfWriter, plan: EnlargedPlan) {
  if (dxf.layerColors[ENLARGED_KEY_LAYER] === undefined) {
    dxf.addLayer(ENLARGED_KEY_LAYER, 8, 'DASHED');
  }
  // Scale-aware: ~0.14" printed regardless of the overall sheet scale.
  const tagH = 0.14 * plan.overallScale;
  for (const t of plan.tiles) {
    dxf.addPolyline(
      [[t.view.minX, t.view.minY], [t.view.maxX, t.view.minY],
       [t.view.maxX, t.view.maxY], [t.view.minX, t.view.maxY]],
      ENLARGED_KEY_LAYER, true
    );
    const label = `SEE AREA ${t.tag}`;
    dxf.addCenteredText(
      (t.view.minX + t.view.maxX) / 2,
      (t.view.minY + t.view.maxY) / 2 - tagH / 2,
      tagH, label, ENLARGED_KEY_LAYER, undefined, { est: CHAR_W }
    );
  }
}
