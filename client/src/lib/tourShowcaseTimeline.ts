// Deterministic timeline for the post-flight tour showcase (CAD zoom, plot,
// grounding plan, BOM, SLD sheets). The live TourShowcase drives itself with
// wall-clock sleeps; the offline WebCodecs renderer instead STEPS this
// timeline at even frame intervals (like the flight's tourSeek), so the
// showcase lands in the same encoder with zero dropped frames.
//
// Durations mirror the live script exactly (base ms, before the
// tourShowcaseSpeed divisor): 2D plan 5800, CAD layers 6200, dims hold 3000,
// legend hold 2600, realistic equipment 6000, and each sheet plays fit-hold 2500 → zoom-in 3500 →
// deep-hold 2500 → zoom-out 1800 → tail 800.

export type ShowcaseSheetKey = 'plot' | 'grounding' | 'bom' | 'sld';

export interface ShowcaseSegmentSpec {
  kind: 'plan-2d' | 'cad-layers' | 'cad-dims' | 'cad-legend' | 'realistic' | 'sheet';
  sheet?: ShowcaseSheetKey;
  ms: number;
}

export const SHEET_PHASES = {
  fitHold: 2500,
  zoomIn: 3500,
  deepHold: 2500,
  zoomOut: 1800,
  tailHold: 800,
} as const;

export const SHEET_SEGMENT_MS =
  SHEET_PHASES.fitHold + SHEET_PHASES.zoomIn + SHEET_PHASES.deepHold +
  SHEET_PHASES.zoomOut + SHEET_PHASES.tailHold; // 11100

export const CAD_DIMS_MS = 3000;
export const CAD_LEGEND_MS = 2600;
/** Slow staged reveal: labels → spacing/dimensions → cables/trenches →
 * feeder/NFPA notes, followed by a settled complete CAD drawing. */
export const CAD_LAYERS_MS = 6200;
export const PLAN_2D_MS = 5800;
export const REALISTIC_MS = 6000;

/** Which stops actually play — the caller resolves drafter toggles AND
 * runtime availability (e.g. no legend text op, grounding plan unbuildable)
 * before building the timeline, so the offline frame budget is exact. */
export interface ShowcaseAvailability {
  plan2d: boolean;
  cadDims: boolean;
  cadLegend: boolean;
  realistic: boolean;
  plot: boolean;
  grounding: boolean;
  bom: boolean;
  sld: boolean;
}

export function buildShowcaseTimeline(a: ShowcaseAvailability): ShowcaseSegmentSpec[] {
  const segs: ShowcaseSegmentSpec[] = [];
  if (a.plan2d) segs.push({ kind: 'plan-2d', ms: PLAN_2D_MS });
  if (a.cadDims) segs.push({ kind: 'cad-layers', ms: CAD_LAYERS_MS });
  if (a.cadDims) segs.push({ kind: 'cad-dims', ms: CAD_DIMS_MS });
  if (a.cadLegend) segs.push({ kind: 'cad-legend', ms: CAD_LEGEND_MS });
  if (a.realistic) segs.push({ kind: 'realistic', ms: REALISTIC_MS });
  for (const sheet of ['plot', 'grounding', 'bom', 'sld'] as const) {
    if (a[sheet]) segs.push({ kind: 'sheet', sheet, ms: SHEET_SEGMENT_MS });
  }
  return segs;
}

export function showcaseTotalMs(segs: ShowcaseSegmentSpec[]): number {
  return segs.reduce((sum, s) => sum + s.ms, 0);
}

export interface ShowcaseSegmentAt {
  index: number;
  seg: ShowcaseSegmentSpec;
  /** Milliseconds into the segment (clamped to [0, seg.ms]). */
  tLocalMs: number;
}

/** Segment playing at timeline time `ms`; clamps past-the-end times to the
 * last segment's end so the final offline frame is the settled tail frame. */
export function showcaseSegmentAt(
  segs: ShowcaseSegmentSpec[],
  ms: number,
): ShowcaseSegmentAt | null {
  if (segs.length === 0) return null;
  let acc = 0;
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (ms < acc + seg.ms || i === segs.length - 1) {
      return { index: i, seg, tLocalMs: Math.min(seg.ms, Math.max(0, ms - acc)) };
    }
    acc += seg.ms;
  }
  return null; // unreachable
}

/** Sheet zoom mix (0 = fitted view, 1 = deep detail view) as a pure function
 * of ms into a sheet segment — the same linear tween shape the live
 * showcase plays: hold fit, zoom in, hold deep, zoom back out, tail hold. */
export function sheetZoomMixAt(tLocalMs: number): number {
  const p = SHEET_PHASES;
  let t = tLocalMs;
  if (t <= p.fitHold) return 0;
  t -= p.fitHold;
  if (t <= p.zoomIn) return t / p.zoomIn;
  t -= p.zoomIn;
  if (t <= p.deepHold) return 1;
  t -= p.deepHold;
  if (t <= p.zoomOut) return 1 - t / p.zoomOut;
  return 0;
}

// ---------------------------------------------------------------------------
// CAD-viewport camera poses (dims + legend close-ups). Pure math so the live
// wall-clock script and the driven offline renderer produce the exact same
// camera motion, and the node suite can pin it without THREE.
// ---------------------------------------------------------------------------

/** Camera pose in scene coordinates: pos [x, y(height), z], target on the
 * ground plane. Plan (x, yPlan) maps to scene (x, -yPlan). */
export interface CadPose {
  pos: [number, number, number];
  target: [number, number, number];
}

/** Vertical FOV the design scene's perspective camera uses. */
export const CAD_FOV_DEG = 45;

/** Settled hold (ms) at the end of each CAD pose move so the shot rests on
 * the framed content before the segment ends. */
export const CAD_POSE_HOLD_MS = 900;

/** Fraction of the camera height used as a gentle forward tilt offset —
 * near-top-down so panel text reads upright, with just enough perspective
 * to not look like a flat scan. */
export const CAD_TILT_FRAC = 0.12;

/** Camera height that fits a plan-space rect in view (vertical FOV + aspect),
 * with a margin so linework never touches the frame edge. */
export function cadFitHeight(
  rectW: number,
  rectH: number,
  aspect: number,
  fovDeg = CAD_FOV_DEG,
  margin = 1.15,
): number {
  const halfTan = Math.tan((fovDeg * Math.PI / 180) / 2);
  const need = Math.max(rectH, rectW / Math.max(0.1, aspect)) / 2;
  return Math.max(20, (need / halfTan) * margin);
}

/** Near-top-down pose centered on a plan-space rect, fitted to the given
 * viewport aspect. Frames the WHOLE rect (e.g. the legend panel box), so
 * long legends scale into view instead of being cut off. */
export function cadPoseForRect(rect: { minX: number; minY: number; maxX: number; maxY: number }, aspect: number): CadPose {
  const cx = (rect.minX + rect.maxX) / 2;
  const cy = (rect.minY + rect.maxY) / 2;
  const h = cadFitHeight(rect.maxX - rect.minX, rect.maxY - rect.minY, aspect);
  return {
    pos: [cx, h, -cy + h * CAD_TILT_FRAC],
    target: [cx, 0, -cy],
  };
}

const smooth01 = (t: number) => {
  const k = Math.min(1, Math.max(0, t));
  return k * k * (3 - 2 * k);
};

/** Smooth pose interpolation; height moves in log-space so the zoom-in
 * reads even (same treatment lerpSheetView gives the 2D sheet scale). */
export function lerpCadPose(a: CadPose, b: CadPose, t: number): CadPose {
  const k = smooth01(t);
  const l = (x: number, y: number) => x + (y - x) * k;
  const h = Math.exp(Math.log(Math.max(1e-6, a.pos[1])) + (Math.log(Math.max(1e-6, b.pos[1])) - Math.log(Math.max(1e-6, a.pos[1]))) * k);
  return {
    pos: [l(a.pos[0], b.pos[0]), h, l(a.pos[2], b.pos[2])],
    target: [l(a.target[0], b.target[0]), l(a.target[1], b.target[1]), l(a.target[2], b.target[2])],
  };
}

/** Pose mix (0 = segment-start pose, 1 = framed pose) as a pure function of
 * ms into a CAD segment: eased travel over the segment minus the settled
 * hold, then hold at 1. This is what makes the CAD stops visibly MOVE
 * (fit → dims, dims → legend) instead of holding a static pose. */
export function cadPoseMixAt(tLocalMs: number, segMs: number): number {
  const ramp = Math.max(1, segMs - CAD_POSE_HOLD_MS);
  return Math.min(1, Math.max(0, tLocalMs / ramp));
}

/** A seek-safe 2D plan camera. The opening eases toward an equipment-side
 * close-up, then smoothly pulls back to a complete fitted layout. */
export interface Plan2dPose { target: [number, number, number]; zoom: number }
export function plan2dPoseAt(
  bounds: { cx: number; cy: number; spanX: number; spanY: number },
  focus: { x: number; y: number },
  viewport: { width: number; height: number },
  tLocalMs: number,
): Plan2dPose {
  const aspect = Math.max(0.1, viewport.width / Math.max(1, viewport.height));
  const fit = Math.min(viewport.height / Math.max(1, bounds.spanY * 1.15), viewport.width / Math.max(1, bounds.spanX * 1.15));
  const close = Math.min(viewport.height / Math.max(1, bounds.spanY * 0.42), viewport.width / Math.max(1, bounds.spanX * 0.42));
  const pullStart = PLAN_2D_MS * 0.52;
  const k = tLocalMs < pullStart ? smooth01(tLocalMs / pullStart) : 1 - smooth01((tLocalMs - pullStart) / Math.max(1, PLAN_2D_MS - pullStart));
  return { target: [bounds.cx + (focus.x - bounds.cx) * k, 0, -(bounds.cy + (focus.y - bounds.cy) * k)], zoom: fit + (close - fit) * k };
}

/** Realistic-model overview → representative equipment close-up → lateral
 * overview pan. Pure math makes each offline seek independently reproducible. */
export function realisticPoseAt(
  bounds: { cx: number; cy: number; spanX: number; spanY: number },
  focus: { x: number; y: number },
  tLocalMs: number,
): CadPose {
  const span = Math.max(bounds.spanX, bounds.spanY, 120);
  const overview: CadPose = { pos: [bounds.cx - span * .72, span * .66, -bounds.cy + span * .72], target: [bounds.cx, 0, -bounds.cy] };
  const close: CadPose = { pos: [focus.x + span * .18, span * .20, -focus.y + span * .20], target: [focus.x, 0, -focus.y] };
  const pan: CadPose = { pos: [bounds.cx + span * .72, span * .58, -bounds.cy + span * .42], target: [bounds.cx + span * .12, 0, -bounds.cy] };
  const third = REALISTIC_MS / 3;
  return tLocalMs < third ? lerpCadPose(overview, close, tLocalMs / third)
    : tLocalMs < third * 2 ? lerpCadPose(close, pan, (tLocalMs - third) / third)
      : pan;
}

/** Frame budget for the driven showcase capture: the timeline plays at the
 * live speed divisor (`tourShowcaseSpeed`, the same test hook the realtime
 * path honors), sampled at the encoder fps. Always at least 2 frames so the
 * first/last frames span the timeline. */
export function showcaseFrameCount(totalMs: number, speed: number, fps: number): number {
  const wallSec = totalMs / Math.max(0.1, speed) / 1000;
  return Math.max(2, Math.round(wallSec * fps));
}

/** Timeline time (ms) of driven frame j — evenly spaced, first frame at 0,
 * last frame exactly at the timeline end. */
export function showcaseFrameMs(totalMs: number, frames: number, j: number): number {
  return frames <= 1 ? totalMs : totalMs * (j / (frames - 1));
}
