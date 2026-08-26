// Canvas-2D renderer for the DXF writer's recorded display list — the same
// op stream renderSheet (pdfPlot.ts) rasterizes into the vector PDFs. Used
// by the cinematic tour's sheet showcase to draw the design plot, BOM sheet
// and single-line diagram as animated on-screen "plots" without touching any
// export path. Pure functions over an injected 2D-context interface so the
// node test suite can drive them with a fake context.
import type { DisplayOp } from './nextera/dxfExport';
import {
  DisplayList, displayBounds, aciToRgb, arcPoints, ansi31Segments, ansi37Segments, gravelSegments,
} from './nextera/pdfPlot';

// Minimal Canvas-2D surface the renderer needs (fakeable in tests).
export interface Canvas2DLike {
  save(): void;
  restore(): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  closePath(): void;
  stroke(): void;
  fill(rule?: 'evenodd' | 'nonzero'): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  translate(x: number, y: number): void;
  rotate(rad: number): void;
  fillText(text: string, x: number, y: number): void;
  fillStyle: string;
  strokeStyle: string;
  lineWidth: number;
  font: string;
  textBaseline: string;
  // Optional so existing fake test contexts stay valid; real 2D contexts
  // always have it. Centered ops set 'center' and restore afterwards.
  textAlign?: string;
}

// View: model-feet center + pixels-per-foot scale for a WxH pixel canvas.
export interface SheetView {
  cx: number;
  cy: number;
  scale: number; // px per ft
  width: number;
  height: number;
}

export interface ModelRect { minX: number; minY: number; maxX: number; maxY: number }

// Bounds of the LEGEND panel box in the recorded plot ops: locate the
// centered "LEGEND" title text, then pick the smallest closed rectangle
// polyline that encloses it — addSheetFrame draws exactly that border
// around every panel box, so the rect covers the title AND every legend
// row/swatch regardless of how many rows the design produces. Returns null
// when the sheet has no legend panel.
export function legendBoxRect(ops: DisplayOp[]): ModelRect | null {
  const title = ops.find(
    (op): op is Extract<DisplayOp, { kind: 'text' }> =>
      op.kind === 'text' && /^LEGEND$/i.test(op.text.trim()),
  );
  if (!title) return null;
  const px = title.x + title.text.length * title.h * 0.45; // ~text center
  const py = title.y + title.h / 2;
  let best: ModelRect | null = null;
  let bestArea = Infinity;
  for (const op of ops) {
    if (op.kind !== 'poly' || op.pts.length < 4 || op.pts.length > 5) continue;
    const xs = op.pts.map(p => p[0]);
    const ys = op.pts.map(p => p[1]);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    const w = maxX - minX, h = maxY - minY;
    if (w <= 0 || h <= 0) continue;
    // Axis-aligned rectangle: every vertex sits on the bbox border.
    const eps = Math.max(w, h) * 1e-6;
    const isRect = op.pts.every(p =>
      (Math.abs(p[0] - minX) < eps || Math.abs(p[0] - maxX) < eps) &&
      (Math.abs(p[1] - minY) < eps || Math.abs(p[1] - maxY) < eps));
    if (!isRect) continue;
    if (px < minX || px > maxX || py < minY || py > maxY) continue;
    const area = w * h;
    if (area < bestArea) { bestArea = area; best = { minX, minY, maxX, maxY }; }
  }
  return best;
}

// Fit the full display list in the canvas with a small margin.
export function fitSheetView(ops: DisplayOp[], width: number, height: number, margin = 0.94): SheetView {
  const b = displayBounds(ops);
  const w = Math.max(b.maxX - b.minX, 1e-6);
  const h = Math.max(b.maxY - b.minY, 1e-6);
  return {
    cx: (b.minX + b.maxX) / 2,
    cy: (b.minY + b.maxY) / 2,
    scale: Math.min(width / w, height / h) * margin,
    width, height,
  };
}

// View centered on a model-space detail rect (deep zoom target).
export function rectSheetView(rect: ModelRect, width: number, height: number, margin = 0.85): SheetView {
  const w = Math.max(rect.maxX - rect.minX, 1e-6);
  const h = Math.max(rect.maxY - rect.minY, 1e-6);
  return {
    cx: (rect.minX + rect.maxX) / 2,
    cy: (rect.minY + rect.maxY) / 2,
    scale: Math.min(width / w, height / h) * margin,
    width, height,
  };
}

const smooth = (t: number) => t * t * (3 - 2 * t);

// Smoothly interpolate two views (log-space zoom so the ease reads even).
export function lerpSheetView(a: SheetView, b: SheetView, t: number): SheetView {
  const k = smooth(Math.min(1, Math.max(0, t)));
  return {
    cx: a.cx + (b.cx - a.cx) * k,
    cy: a.cy + (b.cy - a.cy) * k,
    scale: Math.exp(Math.log(a.scale) + (Math.log(b.scale) - Math.log(a.scale)) * k),
    width: b.width,
    height: b.height,
  };
}

const rgb = (c: [number, number, number]) => `rgb(${c[0]},${c[1]},${c[2]})`;

// Draw the display list at the given view. White "paper" background with the
// same per-layer ACI paper colors the PDF plot uses.
export function renderDisplayToCanvas(ctx: Canvas2DLike, disp: DisplayList, view: SheetView): void {
  const { width: W, height: H } = view;
  const X = (x: number) => W / 2 + (x - view.cx) * view.scale;
  const Y = (y: number) => H / 2 - (y - view.cy) * view.scale; // model y-up -> canvas y-down
  const colorOf = (layer: string, override?: number) =>
    rgb(aciToRgb(override !== undefined ? override : disp.layerColors[layer]));

  ctx.save();
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  ctx.lineWidth = Math.max(1, view.scale * 0.12);
  ctx.textBaseline = 'alphabetic';

  const strokeSeg = (x1: number, y1: number, x2: number, y2: number) => {
    ctx.beginPath();
    ctx.moveTo(X(x1), Y(y1));
    ctx.lineTo(X(x2), Y(y2));
    ctx.stroke();
  };

  for (const op of disp.ops) {
    if (op.kind === 'line') {
      ctx.strokeStyle = colorOf(op.layer, op.color);
      strokeSeg(op.x1, op.y1, op.x2, op.y2);
    } else if (op.kind === 'poly') {
      ctx.strokeStyle = colorOf(op.layer, op.color);
      const pts = op.closed ? [...op.pts, op.pts[0]] : op.pts;
      if (pts.length < 2) continue;
      ctx.beginPath();
      ctx.moveTo(X(pts[0][0]), Y(pts[0][1]));
      for (let i = 1; i < pts.length; i++) ctx.lineTo(X(pts[i][0]), Y(pts[i][1]));
      ctx.stroke();
    } else if (op.kind === 'arc') {
      ctx.strokeStyle = colorOf(op.layer);
      const pts = arcPoints(op);
      ctx.beginPath();
      ctx.moveTo(X(pts[0][0]), Y(pts[0][1]));
      for (let i = 1; i < pts.length; i++) ctx.lineTo(X(pts[i][0]), Y(pts[i][1]));
      ctx.stroke();
    } else if (op.kind === 'hatch') {
      const col = colorOf(op.layer);
      if (op.pattern === 'SOLID') {
        ctx.fillStyle = col;
        ctx.beginPath();
        for (const loop of op.loops) {
          loop.forEach((p, i) => (i === 0 ? ctx.moveTo(X(p[0]), Y(p[1])) : ctx.lineTo(X(p[0]), Y(p[1]))));
          ctx.closePath();
        }
        ctx.fill('evenodd');
      } else {
        ctx.strokeStyle = col;
        const prevW = ctx.lineWidth;
        ctx.lineWidth = Math.max(0.6, prevW * 0.7);
        const segs = op.pattern === 'GRAVEL' ? gravelSegments(op.loops)
          : op.pattern === 'ANSI37' ? ansi37Segments(op.loops)
          : ansi31Segments(op.loops);
        for (const [x1, y1, x2, y2] of segs) strokeSeg(x1, y1, x2, y2);
        ctx.lineWidth = prevW;
      }
    } else {
      // text — baseline-left anchor like DXF TEXT; rot is CCW degrees.
      // Ops with cx/cy are center-justified (register F-24): anchor on the
      // true center so this renderer matches PDF/CAD/AutoCAD centering.
      ctx.fillStyle = colorOf(op.layer, op.color);
      const px = Math.max(1.5, op.h * view.scale);
      ctx.font = `${px}px "Courier New", monospace`;
      const centered = op.cx !== undefined && op.cy !== undefined;
      const prevAlign = ctx.textAlign;
      if (centered) ctx.textAlign = 'center';
      const ax = centered ? op.cx! : op.x;
      const ay = centered ? op.cy! : op.y;
      if (op.rot) {
        ctx.save();
        ctx.translate(X(ax), Y(ay));
        ctx.rotate((-op.rot * Math.PI) / 180);
        ctx.fillText(op.text, 0, 0);
        ctx.restore();
      } else {
        ctx.fillText(op.text, X(ax), Y(ay));
      }
      if (centered) ctx.textAlign = prevAlign;
    }
  }
  ctx.restore();
}
