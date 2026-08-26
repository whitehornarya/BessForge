// WebGL-free 2D plan fallback: when the browser blocks WebGL entirely (the
// probe in DesignScene fails permanently), the CAD/2D Plan views render here
// through a plain Canvas2D renderer instead of the react-three-fiber scene.
// The geometry is NOT re-derived — it is the exact display list the DXF
// exporter records (composeDesignDxf into DxfWriter.ops), the same list the
// WebGL CAD view consumes, so this fallback stays WYSIWYG with the exported
// drawing. Display only — nothing here feeds back into layout math or
// exports (vector DXF/PDF exports are worker/CPU-side and never needed
// WebGL in the first place).
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { SiteDesign } from '../lib/nextera/types';
import { DxfWriter, composeDesignDxf, DisplayOp, LINETYPE_PATTERNS } from '../lib/nextera/dxfExport';
import { composeSiteDxf } from '../lib/nextera/siteCompose';
import { ansi37Segments } from '../lib/nextera/hatchPatterns';
import { getEffectiveConfiguration } from '../lib/nextera/catalog';
import { useDesignStore } from '../lib/stores/useDesignStore';
import { aciHex } from './CadLinework';

const BG = '#101418'; // same dark drawing background as the WebGL CAD view

// Extents of every drawable op (plan feet) — used for the initial fit.
export function opsBounds(ops: DisplayOp[]): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const pt = (x: number, y: number) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  };
  for (const op of ops) {
    switch (op.kind) {
      case 'line': pt(op.x1, op.y1); pt(op.x2, op.y2); break;
      case 'poly': for (const p of op.pts) pt(p[0], p[1]); break;
      case 'arc': pt(op.cx - op.r, op.cy - op.r); pt(op.cx + op.r, op.cy + op.r); break;
      case 'text': pt(op.x, op.y); pt(op.x + op.text.length * op.h * 0.8, op.y + op.h); break;
      case 'hatch': for (const loop of op.loops) for (const p of loop) pt(p[0], p[1]); break;
    }
  }
  return minX <= maxX ? { minX, minY, maxX, maxY } : null;
}

interface View { scale: number; tx: number; ty: number } // screen = (x*scale+tx, -y*scale+ty)

function fitView(b: { minX: number; minY: number; maxX: number; maxY: number }, w: number, h: number): View {
  const pad = 0.92;
  const scale = Math.min((w * pad) / Math.max(1, b.maxX - b.minX), (h * pad) / Math.max(1, b.maxY - b.minY));
  return {
    scale,
    tx: w / 2 - ((b.minX + b.maxX) / 2) * scale,
    ty: h / 2 + ((b.minY + b.maxY) / 2) * scale,
  };
}

// Paint the whole display list in op order (op order IS the plot order —
// label masks must wipe out earlier linework exactly like the DXF plot).
function drawOps(ctx: CanvasRenderingContext2D, dxf: DxfWriter, view: View, w: number, h: number) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, w, h);
  const X = (x: number) => x * view.scale + view.tx;
  const Y = (y: number) => -y * view.scale + view.ty;
  const opHex = (layer: string, color?: number) =>
    aciHex(color !== undefined ? color : dxf.layerColors[layer]);
  // Full per-linetype dash arrays from the shared LINETYPE_PATTERNS source
  // (dots render as short 1.5px dashes so they survive on screen).
  const dashPattern = (layer: string) => {
    const pat = LINETYPE_PATTERNS[dxf.layerLineTypes[layer] ?? 'CONTINUOUS'] ?? [];
    return pat.map(e => Math.max(Math.abs(e) * view.scale, 1.5));
  };

  ctx.lineWidth = 1;
  for (const op of dxf.ops) {
    switch (op.kind) {
      case 'line': {
        ctx.strokeStyle = opHex(op.layer, op.color);
        ctx.setLineDash(dashPattern(op.layer));
        ctx.beginPath();
        ctx.moveTo(X(op.x1), Y(op.y1));
        ctx.lineTo(X(op.x2), Y(op.y2));
        ctx.stroke();
        break;
      }
      case 'poly': {
        if (op.pts.length < 2) break;
        ctx.strokeStyle = opHex(op.layer, op.color);
        ctx.setLineDash(dashPattern(op.layer));
        ctx.beginPath();
        ctx.moveTo(X(op.pts[0][0]), Y(op.pts[0][1]));
        for (let i = 1; i < op.pts.length; i++) ctx.lineTo(X(op.pts[i][0]), Y(op.pts[i][1]));
        if (op.closed) ctx.closePath();
        ctx.stroke();
        break;
      }
      case 'arc': {
        ctx.strokeStyle = opHex(op.layer);
        ctx.setLineDash(dashPattern(op.layer));
        ctx.beginPath();
        // Screen y is flipped, so CCW in plan is CW on screen.
        ctx.arc(X(op.cx), Y(op.cy), op.r * view.scale, -op.start, -op.end, op.ccw);
        ctx.stroke();
        break;
      }
      case 'text': {
        ctx.setLineDash([]);
        ctx.fillStyle = opHex(op.layer, op.color);
        const px = Math.max(1, op.h * view.scale);
        ctx.font = `${px}px "Segoe UI", Arial, sans-serif`;
        // Centered ops carry the true center (cx/cy) — anchor there so the
        // 2D fallback matches PDF/CAD/AutoCAD centering (register F-24).
        const centered = op.cx !== undefined && op.cy !== undefined;
        ctx.textAlign = centered ? 'center' : 'left';
        ctx.textBaseline = 'alphabetic';
        ctx.save();
        ctx.translate(X(centered ? op.cx! : op.x), Y(centered ? op.cy! : op.y));
        if (op.rot) ctx.rotate((-op.rot * Math.PI) / 180);
        ctx.fillText(op.text, 0, 0);
        ctx.restore();
        break;
      }
      case 'hatch': {
        const outer = op.loops[0];
        if (!outer || outer.length < 3) break;
        const hex = opHex(op.layer, op.color);
        // ANSI37 cross-hatch: draw the actual pattern segments the DXF
        // pattern defines (same helper the WebGL CAD view uses).
        if (op.pattern === 'ANSI37') {
          ctx.strokeStyle = hex;
          ctx.setLineDash([]);
          ctx.beginPath();
          for (const [x1, y1, x2, y2] of ansi37Segments(op.loops)) {
            ctx.moveTo(X(x1), Y(y1));
            ctx.lineTo(X(x2), Y(y2));
          }
          ctx.stroke();
        }
        // Even-odd fill: holes/islands stay unfilled, like the DXF hatch.
        ctx.beginPath();
        for (const loop of op.loops) {
          if (loop.length < 3) continue;
          ctx.moveTo(X(loop[0][0]), Y(loop[0][1]));
          for (let i = 1; i < loop.length; i++) ctx.lineTo(X(loop[i][0]), Y(loop[i][1]));
          ctx.closePath();
        }
        const isMask = op.layer === 'EQUIP - Label mask';
        ctx.globalAlpha = isMask ? 1
          : op.pattern === 'SOLID' ? 0.35
          : op.pattern === 'ANSI31' || op.pattern === 'ANSI37' ? 0.16 : 0.1;
        // Label masks are drafting wipeouts: paint the drawing background.
        ctx.fillStyle = isMask ? BG : hex;
        ctx.fill('evenodd');
        ctx.globalAlpha = 1;
        break;
      }
    }
  }
  ctx.setLineDash([]);
}

export default function PlanFallback2D({ design, onRetry3d }: { design: SiteDesign; onRetry3d: () => void }) {
  const boundary = useDesignStore(s => s.boundary);
  const configId = useDesignStore(s => s.configId);
  const containersPerPcs = useDesignStore(s => s.containersPerPcs);
  const titleBlock = useDesignStore(s => s.titleBlock);
  const feeders = useDesignStore(s => s.feeders);
  const substation = useDesignStore(s => s.substation);
  const areaZones = useDesignStore(s => s.areaZones);
  const eciLegend = useDesignStore(s => s.eciLegend);
  const drawingVisibility = useDesignStore(s => s.drawingVisibility);
  const siteAreas = useDesignStore(s => s.siteAreas);
  const activeAreaId = useDesignStore(s => s.activeAreaId);
  const areaFeeders = useDesignStore(s => s.areaFeeders);

  // Same composition (and parameters) the DXF download / PDF plot / WebGL
  // CAD view use, so this fallback can never drift from the deliverable.
  // Multi-area sites compose every footprint through the SAME shared helper
  // the WebGL CAD view calls, so the two views cannot diverge.
  const dxf = useMemo(() => {
    const config = getEffectiveConfiguration(configId, containersPerPcs);
    const projName = titleBlock.projectName.trim() || boundary?.name || 'Site';
    const w = new DxfWriter(drawingVisibility);
    composeSiteDxf(w, {
      areas: siteAreas,
      activeAreaId,
      design,
      projectName: projName,
      config,
      meta: titleBlock,
      feeders,
      substation,
      areaFeeders,
      areaZones: areaZones.length ? areaZones : undefined,
      sheetExtras: eciLegend ? { eciLegend: true } : undefined,
    });
    return w;
  }, [design, configId, containersPerPcs, titleBlock, boundary, feeders, substation, areaZones,
      eciLegend, drawingVisibility, siteAreas, activeAreaId, areaFeeders]);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewRef = useRef<View | null>(null);
  const rafRef = useRef(0);

  const repaint = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext('2d');
      if (!canvas || !ctx) return;
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth, h = canvas.clientHeight;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      if (!viewRef.current) {
        const b = opsBounds(dxf.ops);
        if (!b) return;
        viewRef.current = fitView(b, w, h);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // drawOps sets its own identity transform in device px — wrap it in
      // the dpr scale by pre-scaling the view instead.
      const v = viewRef.current;
      drawOps(ctx, dxf, { scale: v.scale * dpr, tx: v.tx * dpr, ty: v.ty * dpr }, w * dpr, h * dpr);
    });
  }, [dxf]);

  // Refit + repaint when the design (display list) changes or the pane
  // resizes; keep the drafter's pan/zoom across pure repaints.
  useEffect(() => { viewRef.current = null; repaint(); }, [repaint]);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ro = new ResizeObserver(() => repaint());
    ro.observe(canvas);
    return () => { ro.disconnect(); cancelAnimationFrame(rafRef.current); };
  }, [repaint]);

  // Pan (pointer drag) + zoom about the cursor (wheel / pinch-wheel).
  const drag = useRef<{ x: number; y: number } | null>(null);
  const onPointerDown = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY };
  }, []);
  const onPointerMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drag.current || !viewRef.current) return;
    viewRef.current.tx += e.clientX - drag.current.x;
    viewRef.current.ty += e.clientY - drag.current.y;
    drag.current = { x: e.clientX, y: e.clientY };
    repaint();
  }, [repaint]);
  const onPointerUp = useCallback(() => { drag.current = null; }, []);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // Non-passive wheel listener: preventDefault stops the page scrolling
    // while zooming the plan.
    const onWheel = (e: WheelEvent) => {
      const v = viewRef.current;
      if (!v) return;
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      const factor = Math.exp(-e.deltaY * 0.0015);
      const next = Math.min(1000, Math.max(0.001, v.scale * factor));
      const f = next / v.scale;
      v.scale = next;
      v.tx = mx + (v.tx - mx) * f;
      v.ty = my + (v.ty - my) * f;
      repaint();
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, [repaint]);

  return (
    <div className="w-full h-full relative" data-testid="plan-fallback-2d" style={{ background: BG }}>
      <canvas
        ref={canvasRef}
        className="w-full h-full block cursor-grab active:cursor-grabbing touch-none"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      />
      <div className="absolute bottom-3 left-3 z-10 bg-slate-900/85 text-slate-300 text-xs px-3 py-1.5 rounded shadow flex items-center gap-3 max-w-md">
        <span>
          2D drawing fallback — WebGL is unavailable in this browser, so the plan renders
          without 3D. Drag to pan, scroll to zoom. DXF and PDF exports still work.
        </span>
        <button
          onClick={onRetry3d}
          className="px-2 py-1 rounded bg-cyan-700 hover:bg-cyan-600 text-white font-semibold shrink-0"
        >
          Retry 3D
        </button>
      </div>
    </div>
  );
}
