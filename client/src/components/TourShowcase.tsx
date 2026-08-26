import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useDesignStore } from '../lib/stores/useDesignStore';
import { SiteDesign } from '../lib/nextera/types';
import { getEffectiveConfiguration } from '../lib/nextera/catalog';
import { computeBlockSpacingDims } from '../lib/nextera/dimensions';
import { waitForSceneReady } from '../lib/sceneReady';
import {
  fitSheetView, rectSheetView, lerpSheetView, renderDisplayToCanvas,
  legendBoxRect, SheetView, ModelRect,
} from '../lib/displayListCanvas';
import type { DisplayList } from '../lib/nextera/pdfPlot';
import {
  buildShowcaseTimeline, showcaseTotalMs, showcaseSegmentAt, sheetZoomMixAt,
  cadPoseForRect, lerpCadPose, cadPoseMixAt, plan2dPoseAt, realisticPoseAt, CadPose,
  SHEET_PHASES, CAD_DIMS_MS, CAD_LEGEND_MS, ShowcaseSegmentSpec, ShowcaseSheetKey,
  CAD_LAYERS_MS, PLAN_2D_MS, REALISTIC_MS,
} from '../lib/tourShowcaseTimeline';

// Scripted post-flyover showcase (cinematic tour v2). After the camera path
// ends, this walks the app's "deliverables" on screen in one continuous take:
//
//   1. CAD view — zooms the camera onto the dimension callouts, then the
//      legend, then flips the realistic-models toggle on for the reveal.
//   2. DXF plot — the single-page design plot (the exact display list the
//      PDF/DXF exports record) drawn on an overlay canvas, with a slow deep
//      zoom into the equipment linework.
//   3. BOM sheet — the B018 bill-of-materials schedule, zooming onto the
//      table rows.
//   4. Single-line diagram — rendered with IEC 60617 symbols, zooming onto
//      a feeder column (breaker → PCS converter → transformer → battery).
//
// Presentation-only: every toggle it flips (view mode, realistic models) is
// restored afterwards, it never writes project state, and the exports are
// untouched — the overlay draws the SAME recorded display lists the exports
// already produce. Esc cancels cleanly at any point.
//
// Two drivers share the exact same content and restore path:
//   - LIVE (default): the wall-clock script below, used by playback and the
//     realtime ⏺ Record composite.
//   - DRIVEN (offline 4K60 render): when the offline WebCodecs renderer is
//     active, the component instead registers `window.__tourShowcaseDriver`
//     and renders the deterministic timeline state for whatever millisecond
//     the renderer seeks to (tourShowcaseTimeline) — the showcase joins the
//     flight in one zero-dropped-frame file.

type ViewMode = '3d' | '2d' | 'cad';
type TourCadLayers = { labels: boolean; dims: boolean; cables: boolean; feederNotes: boolean };

/** Presentation-only CAD layers, staged in the order a reviewer naturally
 * reads the drawing. The final state deliberately exposes all requested
 * groups before the camera travels into details and the legend. */
function cadLayersAt(tMs: number): TourCadLayers {
  const at = (start: number) => Math.min(1, Math.max(0, (tMs - start) / 250));
  // Discrete transitions are separated by soft white fades in the caption
  // overlay/camera motion; layer render itself stays crisp and deterministic.
  return {
    labels: at(0) > 0,
    dims: at(1200) > 0,
    cables: at(2500) > 0,
    feederNotes: at(3900) > 0,
  };
}

function cadLayerCaption(layers: TourCadLayers): string {
  if (!layers.dims) return 'CAD drawing — equipment labels';
  if (!layers.cables) return 'CAD drawing — spacing & dimensions';
  if (!layers.feederNotes) return 'CAD drawing — cables & trenches';
  return 'CAD drawing — feeder & NFPA annotations';
}

// Epoch counter guarding teardown: a stale showcase instance waking from a
// sleep after the user started ANOTHER tour must never restore toggles or
// stop the new run. Only the newest showcase owns the restore.
let showcaseEpoch = 0;

interface PreparedSheet {
  disp: DisplayList;
  detail: ModelRect;
  label: string;
}

export default function TourShowcase({
  design,
  viewMode,
  setViewMode,
  prevViewMode,
}: {
  design: SiteDesign;
  viewMode: ViewMode;
  setViewMode: (m: ViewMode) => void;
  prevViewMode: ViewMode;
}) {
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const [caption, setCaption] = useState<string | null>(null);
  const [overlayOn, setOverlayOn] = useState(false);
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return; // one take per showcase mount
    ran.current = true;
    const myEpoch = ++showcaseEpoch;
    let cancelled = false;
    // Unmount hook for the driven mode: resolves the pending driver promise
    // so the async body reaches its finally (restore) even when the offline
    // renderer is torn down first.
    let releaseDriven: (() => void) | null = null;
    const store = () => useDesignStore.getState();
    const prevRealistic = store().realisticModels;
    const prevCadLayers = store().tourCadLayers;
    const spd = Math.max(0.1, store().tourShowcaseSpeed);
    const onKey = (e: KeyboardEvent) => { if (e.code === 'Escape') cancelled = true; };
    window.addEventListener('keydown', onKey);

    const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms / spd));
    const frames = () => new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r())));
    const bail = () => cancelled || !store().tourActive;

    // Animated sheet segment on the overlay canvas: fit → deep zoom → hold.
    const playSheet = async (disp: DisplayList, detail: ModelRect, label: string) => {
      const canvas = overlayRef.current;
      if (!canvas || bail()) return;
      setOverlayOn(true);
      setCaption(label);
      await frames();
      const W = (canvas.width = canvas.clientWidth || 1280);
      const H = (canvas.height = canvas.clientHeight || 720);
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      const fit = fitSheetView(disp.ops, W, H);
      const deep = rectSheetView(detail, W, H);
      const draw = (v: SheetView) => renderDisplayToCanvas(ctx as any, disp, v);
      const tween = (a: SheetView, b: SheetView, ms: number) => new Promise<void>(res => {
        const t0 = performance.now();
        const step = () => {
          if (bail()) return res();
          const t = Math.min(1, ((performance.now() - t0) * spd) / ms);
          draw(lerpSheetView(a, b, t));
          if (t >= 1) res(); else requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      });
      draw(fit);
      await sleep(SHEET_PHASES.fitHold);
      if (bail()) return;
      await tween(fit, deep, SHEET_PHASES.zoomIn);
      await sleep(SHEET_PHASES.deepHold);
      if (bail()) return;
      await tween(deep, fit, SHEET_PHASES.zoomOut);
      await sleep(SHEET_PHASES.tailHold);
    };

    (async () => {
      try {
        const s = store();
        // Drafter-chosen showcase stops (undefined = on, false = skip). Read
        // once at start so a mid-run options edit can't tear the sequence.
        const opts = s.tourOptions;
        const { showcaseStopEnabled } = await import('../lib/cinematicTour');
        const wantCad = showcaseStopEnabled(opts, 'showcaseCad');
        const wantRealistic = showcaseStopEnabled(opts, 'showcaseRealistic');
        const wantPlot = showcaseStopEnabled(opts, 'showcasePlot');
        const wantGrounding = showcaseStopEnabled(opts, 'showcaseGrounding');
        const wantBom = showcaseStopEnabled(opts, 'showcaseBom');
        const wantSld = showcaseStopEnabled(opts, 'showcaseSld');
        const feeders = s.feeders;
        const config = getEffectiveConfiguration(s.configId, s.containersPerPcs);
        const meta = s.titleBlock;
        const projectName = (meta.projectName?.trim() || s.boundary?.name || 'Site').replace(/[^A-Za-z0-9_-]+/g, '_');
        const sheetCtx = {
          design, projectName, config, meta, feeders, substation: s.substation,
          // Drafter-drawn area zones show in the CAD sheet stop exactly as
          // they export (same display-list composer as the DXF/PDF).
          ...(s.areaZones.length ? { areaZones: s.areaZones } : {}),
        };

        // Anchor point for camera/plot framing, needed by CAD and plot stops.
        // (scene x = plan x, scene z = -plan y; the linework lies near y = 0).
        const dims = computeBlockSpacingDims(design);
        const d0 = dims[0];
        const dimAt = d0
          ? (d0.kind === 'h'
              ? { x: (d0.a + d0.b) / 2, y: d0.dim }
              : { x: d0.dim, y: (d0.a + d0.b) / 2 })
          : { x: design.equipment[0]?.x ?? 0, y: design.equipment[0]?.y ?? 0 };
        const xs = design.boundary.polygon.map(p => p.x);
        const ys = design.boundary.polygon.map(p => p.y);
        const planBounds = {
          cx: (Math.min(...xs) + Math.max(...xs)) / 2,
          cy: (Math.min(...ys) + Math.max(...ys)) / 2,
          spanX: Math.max(...xs) - Math.min(...xs),
          spanY: Math.max(...ys) - Math.min(...ys),
        };
        const applyPlanPose = (t: number) => {
          const p = plan2dPoseAt(planBounds, dimAt, { width: window.innerWidth || 16, height: window.innerHeight || 9 }, t);
          store().requestOrthoCameraPose(p.target, p.zoom);
        };
        const applyRealisticPose = (t: number) => {
          const p = realisticPoseAt(planBounds, dimAt, t);
          store().requestCameraPose(p.pos, p.target);
        };

        // The recorded plot display list serves both the CAD legend close-up
        // and the plot sheet stop — compose it only when either plays.
        const { composeDesignDisplay, composeGroundingDisplay, composeBomSheetDisplay, composeSldDisplay, displayBounds } = await import('../lib/nextera/pdfPlot');
        const plotDisp = wantCad || wantPlot ? composeDesignDisplay(sheetCtx) : null;
        // Legend close-up target: the LEGEND text in the recorded plot ops.
        const legendOp = plotDisp?.ops.find(op => op.kind === 'text' && /LEGEND/i.test(op.text)) as
          | Extract<DisplayList['ops'][number], { kind: 'text' }>
          | undefined;

        // Prepare every sheet stop up front (pure display-list composition)
        // so the live and driven paths render identical content.
        const sheets: Partial<Record<ShowcaseSheetKey, PreparedSheet>> = {};
        if (wantPlot && plotDisp) {
          const eq = design.equipment[0];
          const plotDetail: ModelRect = eq
            ? { minX: eq.x - 70, maxX: eq.x + 70, minY: eq.y - 45, maxY: eq.y + 45 }
            : { minX: dimAt.x - 70, maxX: dimAt.x + 70, minY: dimAt.y - 45, maxY: dimAt.y + 45 };
          sheets.plot = { disp: plotDisp, detail: plotDetail, label: 'Design plot — exported DXF, 1:1' };
        }
        // Grounding plan: the design plot with the buried loop/grid/rod
        // linework, from the SAME display-list composer the exports use.
        // Computed transiently when the drafter's grounding toggle is off —
        // nothing is persisted and no export is touched.
        if (wantGrounding) {
          const { buildGroundingPlan } = await import('../lib/nextera/grounding');
          const gplan = buildGroundingPlan(design, { rodSpacingFt: s.groundingRodSpacingFt });
          if (gplan) {
            const gDisp = composeGroundingDisplay(sheetCtx, gplan);
            const loop = (gplan.loops ?? [gplan.loop])[0] ?? [];
            const gc = loop.length
              ? {
                  x: loop.reduce((a, p) => a + p.x, 0) / loop.length,
                  y: loop.reduce((a, p) => a + p.y, 0) / loop.length,
                }
              : dimAt;
            sheets.grounding = {
              disp: gDisp,
              detail: { minX: gc.x - 90, maxX: gc.x + 90, minY: gc.y - 60, maxY: gc.y + 60 },
              label: 'Grounding plan — buried loop, grid & rods',
            };
          }
        }
        if (wantBom) {
          const bomDisp = composeBomSheetDisplay(sheetCtx, feeders, {});
          const bb = displayBounds(bomDisp.ops);
          sheets.bom = {
            disp: bomDisp,
            detail: {
              minX: bb.minX + (bb.maxX - bb.minX) * 0.05,
              maxX: bb.minX + (bb.maxX - bb.minX) * 0.5,
              minY: bb.minY + (bb.maxY - bb.minY) * 0.45,
              maxY: bb.minY + (bb.maxY - bb.minY) * 0.95,
            },
            label: 'Bill of materials — B018 schedule',
          };
        }
        if (wantSld) {
          const sldDisp = composeSldDisplay(sheetCtx, feeders, { standard: 'IEC' });
          const sb = displayBounds(sldDisp.ops);
          // Tight close-up: dive well into the diagram so the IEC symbols
          // and conductor labels are legible in the recording.
          sheets.sld = {
            disp: sldDisp,
            detail: {
              minX: sb.minX + (sb.maxX - sb.minX) * 0.38,
              maxX: sb.minX + (sb.maxX - sb.minX) * 0.63,
              minY: sb.minY + (sb.maxY - sb.minY) * 0.36,
              maxY: sb.minY + (sb.maxY - sb.minY) * 0.74,
            },
            label: 'Single-line diagram — IEC 60617 symbols',
          };
        }

        // CAD-viewport poses. Each stop travels from a wide start pose to
        // its framed pose (pure pose-at-mix functions shared by the live
        // wall-clock tween and the driven offline renderer):
        //   dims:   full-sheet fit  → dimension callouts (a real zoom-in)
        //   legend: dims close-up   → the WHOLE legend panel box, fitted
        //           upright + centered from its recorded bounds so every
        //           row is in frame regardless of legend length.
        const aspect = (window.innerWidth || 16) / Math.max(1, window.innerHeight || 9);
        const sheetFitPose: CadPose | null = plotDisp
          ? cadPoseForRect(displayBounds(plotDisp.ops), aspect)
          : null;
        const dimsPose: CadPose = {
          pos: [dimAt.x, 300, -dimAt.y + 190],
          target: [dimAt.x, 0, -dimAt.y],
        };
        const legendRect = plotDisp ? legendBoxRect(plotDisp.ops) : null;
        const legendPose: CadPose | null = legendRect
          ? cadPoseForRect(legendRect, aspect)
          : legendOp // fallback: legacy offset from the title op
            ? {
                pos: [legendOp.x + 30, 260, -(legendOp.y - 60) + 160],
                target: [legendOp.x + 30, 0, -(legendOp.y - 60)],
              }
            : null;
        const poseDimsAt = (mix: number) => {
          const p = sheetFitPose ? lerpCadPose(sheetFitPose, dimsPose, mix) : dimsPose;
          store().requestCameraPose(p.pos, p.target);
        };
        const poseLegendAt = (mix: number) => {
          if (!legendPose) return;
          const p = lerpCadPose(dimsPose, legendPose, mix);
          store().requestCameraPose(p.pos, p.target);
        };
        // Live-mode pose tween: drives poseAt over the segment's wall clock
        // (honoring the tourShowcaseSpeed divisor like every other sleep).
        const tweenPose = (poseAt: (mix: number) => void, segMs: number) =>
          new Promise<void>(res => {
            const t0 = performance.now();
            const stepFrame = () => {
              if (bail()) return res();
              const t = Math.min(segMs, (performance.now() - t0) * spd);
              poseAt(cadPoseMixAt(t, segMs));
              if (t >= segMs) res(); else requestAnimationFrame(stepFrame);
            };
            requestAnimationFrame(stepFrame);
          });

        // ---- DRIVEN mode: offline WebCodecs render steps the timeline. ----
        if (s.offlineRenderActive) {
          const segs = buildShowcaseTimeline({
            plan2d: wantCad,
            cadDims: wantCad && !!plotDisp,
            cadLegend: wantCad && !!plotDisp && !!legendOp,
            realistic: wantRealistic,
            plot: !!sheets.plot,
            grounding: !!sheets.grounding,
            bom: !!sheets.bom,
            sld: !!sheets.sld,
          });
          if (segs.length === 0) return; // nothing enabled → tour ends
          let lastIdx = -1;
          let sheetState: {
            disp: DisplayList; fit: SheetView; deep: SheetView;
            ctx: CanvasRenderingContext2D;
          } | null = null;
          const enterSegment = async (seg: ShowcaseSegmentSpec) => {
            const st = store();
            if (seg.kind === 'sheet') {
              // Leaving the realistic reveal (if any) — mirror the live flow.
              st.setRealisticModels(false);
              const sheet = sheets[seg.sheet!];
              if (!sheet) return;
              setOverlayOn(true);
              setCaption(sheet.label);
              await frames();
              const canvas = overlayRef.current;
              if (!canvas) return;
              // The offline composite upscales the overlay into a UHD frame;
              // render the sheet near 4K so its linework/text stay crisp.
              const cw = canvas.clientWidth || 1280;
              const ch = canvas.clientHeight || 720;
              const scale = Math.max(1, Math.min(4, 3840 / Math.max(1, cw)));
              const W = (canvas.width = Math.round(cw * scale));
              const H = (canvas.height = Math.round(ch * scale));
              const ctx = canvas.getContext('2d');
              if (!ctx) return;
              sheetState = {
                disp: sheet.disp,
                fit: fitSheetView(sheet.disp.ops, W, H),
                deep: rectSheetView(sheet.detail, W, H),
                ctx,
              };
              return;
            }
            if (seg.kind === 'plan-2d') {
              setOverlayOn(false);
              st.setRealisticModels(false);
              setViewMode('2d');
              setCaption('Plan view — yard approach & full layout');
              await frames();
              applyPlanPose(0);
              return;
            }
            // CAD-viewport segments (dims/legend/realistic reveal).
            setOverlayOn(false);
            if (seg.kind === 'realistic') {
              setViewMode('3d');
            } else {
              st.setRealisticModels(false);
              setViewMode('cad');
            }
            await frames();
            await waitForSceneReady({ timeoutMs: 8000 });
            if (seg.kind === 'cad-layers') {
              const layers = cadLayersAt(0);
              setCaption(cadLayerCaption(layers));
              st.setTourCadLayers(layers);
              poseDimsAt(0);
            } else if (seg.kind === 'cad-dims') {
              setCaption('CAD drawing — dimensions & legend');
              poseDimsAt(0);
            } else if (seg.kind === 'cad-legend') {
              setCaption('CAD drawing — dimensions & legend');
              poseLegendAt(0);
            } else {
              setCaption('Realistic equipment — reveal, close-up & yard pan');
              st.setRealisticModels(true);
              // Offline render is quality mode — it steps the timeline itself,
              // so it is not racing a wall clock. Give slow machines far
              // longer to finish the GLB downloads/parses, and surface a
              // warning if even that runs out (frames would show
              // half-loaded models).
              const settled = await waitForSceneReady({ timeoutMs: 120000 });
              if (!settled) {
                toast.warning(
                  'Realistic models were still loading when the offline render '
                  + 'moved on — the showcase segment may show incomplete equipment.',
                );
              }
            }
          };
          const seek = async (ms: number) => {
            if (bail()) return;
            const at = showcaseSegmentAt(segs, ms);
            if (!at) return;
            if (at.index !== lastIdx) {
              lastIdx = at.index;
              sheetState = null;
              await enterSegment(at.seg);
            }
            if (at.seg.kind === 'sheet' && sheetState) {
              renderDisplayToCanvas(
                sheetState.ctx as any,
                sheetState.disp,
                lerpSheetView(sheetState.fit, sheetState.deep, sheetZoomMixAt(at.tLocalMs)),
              );
            } else if (at.seg.kind === 'plan-2d') {
              applyPlanPose(at.tLocalMs);
            } else if (at.seg.kind === 'cad-dims') {
              // Deterministic camera travel — the offline frames replay the
              // exact same fit→dims / dims→legend moves the live take plays.
              poseDimsAt(cadPoseMixAt(at.tLocalMs, at.seg.ms));
            } else if (at.seg.kind === 'cad-layers') {
              const layers = cadLayersAt(at.tLocalMs);
              store().setTourCadLayers(layers);
              setCaption(cadLayerCaption(layers));
              poseDimsAt(cadPoseMixAt(at.tLocalMs, at.seg.ms));
            } else if (at.seg.kind === 'cad-legend') {
              poseLegendAt(cadPoseMixAt(at.tLocalMs, at.seg.ms));
            } else if (at.seg.kind === 'realistic') {
              applyRealisticPose(at.tLocalMs);
            }
          };
          try {
            await new Promise<void>(resolve => {
              releaseDriven = resolve;
              (window as any).__tourShowcaseDriver = {
                totalMs: showcaseTotalMs(segs),
                seek,
                done: () => resolve(),
              };
            });
          } finally {
            releaseDriven = null;
            delete (window as any).__tourShowcaseDriver;
          }
          return;
        }

        // ---- LIVE mode: the original wall-clock take. ----

        // --- 1. Slow 2D approach: focused pan/zoom followed by full layout.
        if (wantCad) {
          s.setRealisticModels(false);
          setViewMode('2d');
          setCaption('Plan view — yard approach & full layout');
          await frames();
          await new Promise<void>(res => {
            const t0 = performance.now();
            const step = () => {
              if (bail()) return res();
              const t = Math.min(PLAN_2D_MS, (performance.now() - t0) * spd);
              applyPlanPose(t);
              if (t >= PLAN_2D_MS) res(); else requestAnimationFrame(step);
            };
            requestAnimationFrame(step);
          });
          if (bail()) return;
        }
        // --- 2. CAD view: dims/legend close-ups, then the realistic reveal.
        // Both live in the CAD viewport, so it opens when either is on.
        if (wantCad || wantRealistic) {
          s.setRealisticModels(false);
          setViewMode('cad');
          await frames();
          await waitForSceneReady({ timeoutMs: 8000 });
          if (bail()) return;
        }
        if (wantCad && plotDisp) {
          const firstLayers = cadLayersAt(0);
          setCaption(cadLayerCaption(firstLayers));
          s.setTourCadLayers(firstLayers);
          const playCadLayers = async () => new Promise<void>(res => {
            const t0 = performance.now();
            const step = () => {
              if (bail()) return res();
              const t = Math.min(CAD_LAYERS_MS, (performance.now() - t0) * spd);
              const layers = cadLayersAt(t);
              s.setTourCadLayers(layers);
              setCaption(cadLayerCaption(layers));
              poseDimsAt(cadPoseMixAt(t, CAD_LAYERS_MS));
              if (t >= CAD_LAYERS_MS) res(); else requestAnimationFrame(step);
            };
            requestAnimationFrame(step);
          });
          await playCadLayers();
          if (bail()) return;
          setCaption('CAD drawing — dimensions & legend');
          // Zoom from the full-sheet fit onto the block-spacing dimension
          // callouts, then travel over to the legend panel and fit it whole.
          await tweenPose(poseDimsAt, CAD_DIMS_MS);
          if (bail()) return;
          if (legendPose) {
            await tweenPose(poseLegendAt, CAD_LEGEND_MS);
            if (bail()) return;
          }
        }
        if (wantRealistic) {
          setViewMode('3d');
          setCaption('Realistic equipment — reveal, close-up & yard pan');
          s.setRealisticModels(true);
          await waitForSceneReady({ timeoutMs: 15000 });
          await new Promise<void>(res => {
            const t0 = performance.now();
            const step = () => {
              if (bail()) return res();
              const t = Math.min(REALISTIC_MS, (performance.now() - t0) * spd);
              applyRealisticPose(t);
              if (t >= REALISTIC_MS) res(); else requestAnimationFrame(step);
            };
            requestAnimationFrame(step);
          });
          if (bail()) return;
          s.setRealisticModels(false);
        }

        // --- 3..6. Sheet stops: plot, grounding plan, BOM, SLD.
        for (const key of ['plot', 'grounding', 'bom', 'sld'] as const) {
          const sheet = sheets[key];
          if (!sheet) continue;
          await playSheet(sheet.disp, sheet.detail, sheet.label);
          if (bail()) return;
        }
      } catch (err) {
        toast.error(`Tour showcase failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        window.removeEventListener('keydown', onKey);
        setOverlayOn(false);
        setCaption(null);
        // Teardown ownership: skip entirely if a newer showcase has started,
        // and never clobber a NEW tour that is mid-path (its own showcase
        // will restore its own saved state).
        const cur = store();
        const newRunInPath = cur.tourActive && cur.tourPhase === 'path';
        if (showcaseEpoch === myEpoch && !newRunInPath) {
          // Restore everything the showcase touched, then end the tour
          // (which also clears the transient grounding-flyover flag).
          cur.setRealisticModels(prevRealistic);
          cur.setTourCadLayers(prevCadLayers);
          setViewMode(prevViewMode);
          cur.stopCinematicTour();
        }
      }
    })();

    return () => {
      cancelled = true;
      // Driven mode: unblock the pending driver promise so the finally
      // (state restore) runs even if the offline renderer never calls done.
      releaseDriven?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <canvas
        ref={overlayRef}
        data-tour-overlay
        className="absolute inset-0 z-20 w-full h-full"
        style={{ display: overlayOn ? 'block' : 'none', background: '#fff' }}
      />
      {caption && (
        <div data-tour-caption className="absolute bottom-6 left-1/2 -translate-x-1/2 z-30 bg-slate-900/80 text-slate-100 text-sm font-semibold px-4 py-1.5 rounded shadow pointer-events-none">
          {caption}
        </div>
      )}
    </>
  );
}
