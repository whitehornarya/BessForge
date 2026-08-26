// Readable full-size PLAN SHEETS for each footprint of a multi-area site.
//
// Problem: a multi-area export composes every selected footprint onto ONE
// ANSI D sheet (siteCompose). That whole-site view is the right coordination
// drawing — it shows how the BESS yards and the substation relate — but the
// page transform must fit the entire site extent, so adding a substation a
// third of a mile east drops the plan from 1" = 60' to 1" = 150' and the
// equipment annotation prints far below anything a reviewer can read.
//
// Fix: the whole-site sheet stays exactly as it is (it is the key plan), and
// each selected footprint ALSO gets its own full-size sheet, composed through
// the ordinary single-design path — same frame, same schedule, same legend,
// and the same readable plot scale that footprint would print at on its own.
//
// MULTI-AREA ONLY. `areaSheetPlans` returns an empty list whenever the export
// is not a multi-area composition, so single-area DXF packages, plot sets and
// design PDFs stay byte-identical.

import { Pt, SiteDesign } from './types';
import { FeederCircuit } from './feeders';
import { AreaZone } from './areaZones';
import {
  DxfWriter, DisplayOp, addBaseLayers, composeDesignDxf, TextOverride,
} from './dxfExport';
import type { SheetContext } from './dxfSheets';
import { selectedSiteAreas, siteCompositionApplies } from './siteCompose';
import { areaFeederEndpoint } from './substationTakeoffs';
import { clipSeg } from './vicinityMap';

/** How far past a footprint's own extents its sheet window reaches. The runs
 *  leaving toward a remote substation are cut here, so the sheet frames the
 *  yard rather than the half-mile of open ground between footprints. */
const AREA_WINDOW_PAD_FT = 60;

interface Rect { minX: number; minY: number; maxX: number; maxY: number }

/** The window one area's own sheet frames: its parcel and fence, padded. */
function areaWindow(design: SiteDesign): Rect {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of [...design.boundary.polygon, ...design.fence]) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
  }
  if (minX > maxX) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return {
    minX: minX - AREA_WINDOW_PAD_FT, minY: minY - AREA_WINDOW_PAD_FT,
    maxX: maxX + AREA_WINDOW_PAD_FT, maxY: maxY + AREA_WINDOW_PAD_FT,
  };
}

const inRect = (p: Pt, r: Rect) =>
  p.x >= r.minX && p.x <= r.maxX && p.y >= r.minY && p.y <= r.maxY;

/** Truncate one routed polyline at the point it leaves the sheet window.
 *
 *  A cross-area home run travels from the yard to a take-off in the
 *  substation footprint. On the yard's OWN sheet the run must read as leaving
 *  the drawing, not drag the page scale out to cover the substation, so it is
 *  cut at the window edge. Returns null when nothing of the run is in view. */
function truncateRun(pts: Pt[], r: Rect): Pt[] | null {
  const out: Pt[] = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (inRect(p, r)) { out.push(p); continue; }
    // First point outside: cut this hop at the border and stop — everything
    // beyond belongs to another sheet.
    const prev = pts[i - 1];
    if (prev && inRect(prev, r)) {
      const c = clipSeg([prev.x, prev.y], [p.x, p.y], r);
      if (c) out.push({ x: c[1][0], y: c[1][1] });
    }
    break;
  }
  return out.length >= 2 ? out : null;
}

/** Each circuit with its runs cut at the sheet window, plus where they left
 *  it (for the off-sheet continuation note). Circuits with nothing in view
 *  are dropped rather than drawn as a stub. */
function clipFeedersToWindow(
  feeders: FeederCircuit[] | undefined, r: Rect
): { feeders: FeederCircuit[]; exits: Pt[] } {
  if (!feeders || !feeders.length) return { feeders: [], exits: [] };
  const exits: Pt[] = [];
  const out: FeederCircuit[] = [];
  for (const f of feeders) {
    const segments: FeederCircuit['segments'] = [];
    for (const seg of f.segments) {
      const pts = truncateRun(seg.pts, r);
      if (!pts) continue;
      const last = pts[pts.length - 1];
      const orig = seg.pts[seg.pts.length - 1];
      if (last.x !== orig.x || last.y !== orig.y) exits.push(last);
      segments.push({ ...seg, pts });
    }
    if (segments.length) out.push({ ...f, segments });
  }
  return { feeders: out, exits };
}

/** Everything one area's own sheet is drawn from. */
export interface AreaSheetPlan {
  areaId: string;
  name: string;
  /** True for the area currently being edited (drawn from the live design). */
  active: boolean;
  design: SiteDesign;
  /** This area's circuits, cut at the sheet window (see `truncateRun`). */
  feeders?: FeederCircuit[];
  /** The take-off, only when it is inside this sheet's own window. A remote
   *  substation belongs to a different footprint's sheet. */
  substation?: Pt | null;
  /** Whether any circuit runs off the edge of this sheet. */
  runsOffSheet: boolean;
  areaZones?: AreaZone[] | null;
  /** Filename fragment, e.g. `BESS_AREA_1`. */
  fileTag: string;
}

const fileTag = (name: string) =>
  name.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '') || 'AREA';

/**
 * One plan per SELECTED footprint, in stored area order.
 *
 * Empty unless the export is a genuine multi-area composition: a single-area
 * project, or a selection that resolves to one area, already prints that one
 * footprint at its own readable scale, so extra sheets would be duplicates.
 *
 * Areas that were never generated carry no linework and are skipped rather
 * than emitting an empty sheet.
 */
export function areaSheetPlans(ctx: SheetContext): AreaSheetPlan[] {
  const site = ctx.site;
  if (!siteCompositionApplies(site)) return [];
  const areas = selectedSiteAreas(site.areas, site.selectedAreaIds);
  const out: AreaSheetPlan[] = [];
  for (const area of areas) {
    const active = area.id === site.activeAreaId;
    // The active area draws from the live mirrored design so in-flight edits
    // ship; every other area draws from its own stored design and routes.
    const design = active ? ctx.design : area.design;
    if (!design) continue;
    // Everything on this sheet is cut to the footprint's own window. Without
    // it a BESS yard's home runs reach the substation footprint half a mile
    // east and drag the page scale back out to the whole-site scale — the
    // exact unreadability these sheets exist to fix.
    const win = areaWindow(design);
    const raw = (active ? ctx.feeders : site.areaFeeders?.[area.id]) ?? undefined;
    const { feeders, exits } = clipFeedersToWindow(raw, win);
    const endpoint = areaFeederEndpoint(area, site.areas, {
      activeAreaId: site.activeAreaId,
      liveEndpoint: ctx.substation ?? null,
    });
    out.push({
      areaId: area.id,
      name: area.name,
      active,
      design,
      feeders: feeders.length ? feeders : undefined,
      // A take-off outside this window lives on another footprint's sheet.
      substation: endpoint && inRect(endpoint, win) ? endpoint : null,
      runsOffSheet: exits.length > 0,
      areaZones: (active ? ctx.areaZones : area.edits?.areaZones) ?? null,
      fileTag: fileTag(area.name),
    });
  }
  return out;
}

/** Title-block sheet title for an area plan, e.g. `BESS AREA 1 — PLAN`. */
export function areaSheetTitle(plan: AreaSheetPlan): string {
  return `${plan.name.toUpperCase()} - PLAN`;
}

/**
 * Compose one area's full-size plan into `dxf`.
 *
 * Deliberately the ORDINARY single-design composition: the whole point is
 * that this sheet is framed, scaled and annotated exactly like the drawing
 * that area would produce as a project of its own. Only the title block says
 * which footprint of the site it is.
 */
export function composeAreaSheet(
  dxf: DxfWriter, ctx: SheetContext, plan: AreaSheetPlan, index: number, total: number
) {
  const extras = {
    sheetTitle: areaSheetTitle(plan),
    sheetLabel: `AREA SHEET ${index + 1} OF ${total}`,
    // Circuits leaving this footprint are cut at the window; the substation
    // they land on is drawn on its own sheet and on the whole-site overview,
    // so this sheet must not plant a substation symbol at the cut.
    ...(plan.substation ? {} : { feederRunsOnly: true }),
    ...(ctx.eciLegend ? { eciLegend: true } : {}),
    ...(ctx.auxManRoute ? { auxManRoute: true } : {}),
    ...(ctx.includeFeederNfpaAnnotations === false ? { includeFeederNfpaAnnotations: false } : {}),
  };
  composeDesignDxf(
    dxf, plan.design, ctx.projectName, ctx.config, ctx.meta,
    plan.feeders, plan.substation,
    // Contours/grounding/trench sections belong to the ACTIVE area's design
    // only — they are computed against it, so attaching them to a different
    // footprint's sheet would draw another yard's terrain over this one.
    plan.active ? ctx.contours : null,
    plan.active ? ctx.grounding : null,
    plan.active ? ctx.trenchSections : undefined,
    ctx.surfacingMesh,
    plan.areaZones && plan.areaZones.length ? plan.areaZones : null,
    extras,
    ctx.textOverrides,
  );
}

/** Standalone AC1015 DXF for one area's plan sheet (package zip entry). */
export function buildAreaSheetDxfString(
  ctx: SheetContext, plan: AreaSheetPlan, index: number, total: number
): string {
  const dxf = new DxfWriter(ctx.drawingVisibility);
  addBaseLayers(dxf);
  composeAreaSheet(dxf, ctx, plan, index, total);
  return dxf.toString();
}

/** Display list for one area's plan sheet (PDF page). */
export function composeAreaSheetDisplay(
  ctx: SheetContext, plan: AreaSheetPlan, index: number, total: number
): { ops: DisplayOp[]; layerColors: Record<string, number>; layerLineTypes: Record<string, string>; layerWeights: Record<string, number> } {
  const dxf = new DxfWriter(ctx.drawingVisibility);
  addBaseLayers(dxf);
  composeAreaSheet(dxf, ctx, plan, index, total);
  return {
    ops: dxf.ops,
    layerColors: dxf.layerColors,
    layerLineTypes: dxf.layerLineTypes,
    layerWeights: dxf.layerWeights,
  };
}

// Re-exported for callers assembling a multi-file DXF deliverable so the
// override type does not have to be imported from two places.
export type { TextOverride };
