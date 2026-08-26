// Whole-site drawing composition (multi-area sites).
//
// `composeDesignDxf` composes ONE design onto one sheet. That is exactly right
// for a single-boundary project, and it is what every export still uses. But a
// phase-footprint project holds several footprints in ONE shared projected
// frame, and composing only the active one leaves the CAD / 2D views showing a
// single small yard adrift in a large empty sheet — a drawing that disagrees
// with the 3D view the drafter was just looking at.
//
// This module composes EVERY area's linework into one display list. It is not
// a re-derivation: it calls the same exporter primitives (`drawBoundaryAndFence`,
// `drawEquipment`, `drawRoads`, ...) in the same order `composeDesignDxf` uses,
// so the composed drawing stays WYSIWYG with what those primitives produce.
//
// SINGLE-AREA IS UNTOUCHED. With fewer than two areas this delegates verbatim
// to `composeDesignDxf` and returns no ranges, so single-boundary output stays
// byte-identical (guarded by regression tests).

import { Pt, SiteArea, SiteDesign } from './types';
import { FeederCircuit } from './feeders';
import { BessConfiguration } from './catalog';
import { AreaZone } from './areaZones';
import {
  DxfWriter, TitleBlockMeta, TextOverride, LAYERS, TEXT_H,
  addBaseLayers, addSheetFrame, composeDesignDxf,
  drawBoundaryAndFence, drawSurfacing, drawTrench, drawCables, drawEquipment,
  drawEquipmentLabels, drawReservedZones, drawRoads, drawGate, drawAreaZones,
  drawFeedersAndSubstation, addSpacingDimensions,
} from './dxfExport';
import { areaZoneKindsPresent } from './areaZones';
import { areaFeederEndpoint } from './substationTakeoffs';
import type { DrawingVisibilityProfile } from './drawingVisibility';

/** Which display-list ops belong to which area.
 *
 *  The ops themselves stay a plain drawing list (no area tagging), so this
 *  index range is how a renderer tells one area's linework from another's —
 *  used by the CAD view to keep the active area distinct and to keep text
 *  editing confined to it. */
export interface ComposedAreaRange {
  areaId: string;
  name: string;
  active: boolean;
  /** First op index belonging to this area. */
  opStart: number;
  /** One past the last op index belonging to this area. */
  opEnd: number;
}

export interface ComposeSiteOptions {
  areas: SiteArea[];
  activeAreaId: string | null;
  /** The ACTIVE area's live mirrored design (carries in-flight edits). */
  design: SiteDesign;
  projectName: string;
  config?: BessConfiguration;
  meta?: TitleBlockMeta;
  /** The ACTIVE area's routed feeders. */
  feeders?: FeederCircuit[];
  /** Where the ACTIVE area's feeders land (local substation or take-off). */
  substation?: Pt | null;
  /** The ACTIVE area's drafter zones. */
  areaZones?: AreaZone[] | null;
  /** Every OTHER area's routed feeders, keyed by area id.
   *
   *  A multi-area site routes each BESS yard's circuits to its own take-off in
   *  the substation yard, and the store keeps them per area. Without this the
   *  drawing shows every yard but only the ACTIVE one's feeders, so the
   *  collection system looks like it does not exist for the areas the drafter
   *  is not currently editing. The active area's live `feeders` still win for
   *  it (they carry in-flight edits). */
  areaFeeders?: Record<string, FeederCircuit[]> | null;
  /** Which areas to draw (ids). Absent/null = the ENTIRE site.
   *
   *  Lets the drafter print one footprint, or a chosen combination (e.g. two
   *  BESS areas plus the substation that collects them), from the same
   *  composition the CAD view renders. Unknown ids are ignored; an empty or
   *  fully-unmatched selection falls back to the entire site rather than
   *  composing a blank sheet. */
  selectedAreaIds?: string[] | null;
  sheetExtras?: Parameters<typeof composeDesignDxf>[12];
  textOverrides?: Record<string, TextOverride>;
}

/** The areas a composition/export actually draws: the selected subset, or
 *  every area when nothing is selected. Shared so the CAD view, the DXF export
 *  and the PDF plot can never disagree about what "the drawing" contains. */
export function selectedSiteAreas(
  areas: SiteArea[], selectedAreaIds?: string[] | null
): SiteArea[] {
  if (!selectedAreaIds || !selectedAreaIds.length) return areas;
  const want = new Set(selectedAreaIds);
  const picked = areas.filter(a => want.has(a.id));
  // An empty match means the selection is stale (areas replaced by a new
  // import). Drawing nothing would be a blank sheet with no explanation, so
  // fall back to the whole site.
  return picked.length ? picked : areas;
}

/** The whole-site inputs an EXPORT carries alongside its active-area design.
 *
 *  Plain, structured-clonable data so the DXF worker request can carry it.
 *  Absent (single-area projects) keeps every export on the untouched legacy
 *  single-design path. */
export interface SiteComposeInput {
  areas: SiteArea[];
  activeAreaId: string | null;
  /** Each non-active area's routed circuits, keyed by area id. */
  areaFeeders?: Record<string, FeederCircuit[]> | null;
  /** Which areas to export. Absent/empty = the entire site. */
  selectedAreaIds?: string[] | null;
}

/** Whether an export must go through the whole-site composition rather than
 *  the legacy single-design path.
 *
 *  True when the selection draws several footprints, and ALSO when it draws
 *  exactly one INACTIVE area — only the active area is mirrored into the live
 *  `design`/`feeders`/`substation` inputs, so the legacy path would print the
 *  yard being edited under the picked area's name. Selecting the active area
 *  alone (or a single-area project) stays on the legacy path, which keeps
 *  optional extras like contours and the surfacing mesh and preserves
 *  byte-identical output.
 *
 *  Shared so the DXF export and the PDF plot can never disagree about which
 *  drawing a selection produces. */
export function siteCompositionApplies(
  site?: SiteComposeInput | null
): site is SiteComposeInput {
  if (!site) return false;
  const picked = selectedSiteAreas(site.areas, site.selectedAreaIds);
  if (picked.length > 1) return true;
  return picked.length === 1 && picked[0].id !== site.activeAreaId;
}

/** Whole-site DXF string: the same composition the CAD view renders, so a
 *  multi-area export is WYSIWYG with the screen. A selection that resolves to
 *  a single area delegates to `composeDesignDxf`, keeping single-area output
 *  byte-identical to the legacy export. */
export function buildSiteDxfString(
  site: SiteComposeInput,
  opts: Omit<ComposeSiteOptions, 'areas' | 'activeAreaId' | 'areaFeeders' | 'selectedAreaIds'>,
  drawingVisibility?: DrawingVisibilityProfile
): string {
  const dxf = new DxfWriter(drawingVisibility);
  composeSiteDxf(dxf, {
    areas: site.areas,
    activeAreaId: site.activeAreaId,
    areaFeeders: site.areaFeeders ?? null,
    selectedAreaIds: site.selectedAreaIds ?? null,
    ...opts,
  });
  return dxf.toString();
}

/** Human-readable description of what an export will contain, for the button
 *  label, the toast and the filename tag. */
export function selectionLabel(areas: SiteArea[], selectedAreaIds?: string[] | null): string {
  const picked = selectedSiteAreas(areas, selectedAreaIds);
  if (picked.length === areas.length) return 'Entire site';
  if (picked.length === 1) return picked[0].name;
  return `${picked.length} areas`;
}

/** The plan region the sheet border must enclose: every area's parcel and
 *  fence, plus the active area's off-parcel substation symbol and routed home
 *  runs (the same extension `addSheetFrame` applies when it derives its own
 *  bounds). Composing a multi-area sheet from one area's extents would clip
 *  every other footprint outside the border. */
export function siteplanBounds(
  areas: SiteArea[],
  activeDesign: SiteDesign | null,
  feeders?: FeederCircuit[],
  substation?: Pt | null,
  /** Every other drawn area's routes/endpoints, so cross-area home runs are
   *  inside the border instead of being clipped by it. */
  extra?: { feeders?: FeederCircuit[] | null; substation?: Pt | null }[],
): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const pt = (x: number, y: number) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  };
  for (const a of areas) {
    for (const p of a.boundary.polygon) pt(p.x, p.y);
    const f = a.design?.fence;
    if (f) for (const p of f) pt(p.x, p.y);
  }
  if (activeDesign) {
    for (const p of activeDesign.boundary.polygon) pt(p.x, p.y);
    for (const p of activeDesign.fence) pt(p.x, p.y);
  }
  // Same extension addSheetFrame applies to its own derived bounds.
  if (substation) pt(substation.x + 25, substation.y);
  if (feeders) for (const f of feeders) for (const seg of f.segments) {
    for (const p of seg.pts) pt(p.x, p.y);
  }
  // Every other drawn area's collection system counts toward the frame too,
  // otherwise a home run that crosses toward the substation yard gets clipped
  // by the border it should sit inside.
  if (extra) for (const e of extra) {
    if (e.substation) pt(e.substation.x + 25, e.substation.y);
    if (e.feeders) for (const f of e.feeders) for (const seg of f.segments) {
      for (const p of seg.pts) pt(p.x, p.y);
    }
  }
  return minX <= maxX ? { minX, minY, maxX, maxY } : null;
}

/** Area name caption, centered above the footprint so the drawing identifies
 *  which phase / substation each yard is. Sized off the footprint so the name
 *  stays readable when the whole site is framed (a site-wide view makes the
 *  4 ft equipment-label text unreadably small). */
function drawAreaName(dxf: DxfWriter, area: SiteArea) {
  const poly = area.boundary.polygon;
  if (poly.length < 3) return;
  const xs = poly.map(p => p.x), ys = poly.map(p => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const maxY = Math.max(...ys);
  const span = Math.max(maxX - minX, 1);
  const h = Math.max(TEXT_H * 2, span * 0.035);
  dxf.addCenteredText((minX + maxX) / 2, maxY + h * 0.9, h,
    area.name.toUpperCase(), LAYERS.TEXT_LG, undefined, { est: 0.84 });
}

/** One area's yard linework, in the same order composeDesignDxf draws it.
 *
 *  Deliberately excludes the sheet frame, the equipment schedule and the
 *  spacing dimensions: those are sheet-level furniture positioned relative to
 *  ONE design's extents, so drawing them per area would stack several title
 *  blocks on one sheet and drop each area's schedule table on top of whatever
 *  footprint happens to lie south of it. */
function drawAreaYard(
  dxf: DxfWriter,
  design: SiteDesign,
  config: BessConfiguration | undefined,
  eci: boolean,
  zones: AreaZone[] | null,
) {
  drawBoundaryAndFence(dxf, design);
  drawSurfacing(dxf, design);
  drawTrench(dxf, design);
  drawCables(dxf, design);
  drawEquipment(dxf, design, config, eci, true);
  drawReservedZones(dxf, design);
  drawRoads(dxf, design);
  drawGate(dxf, design);
  // Labels last: their white wipeout masks must plot over this area's own
  // linework, exactly as they do on a single-area sheet.
  drawEquipmentLabels(dxf, design, config);
  if (zones && zones.length) drawAreaZones(dxf, zones);
}

/**
 * Compose the whole site's drawing into `dxf`.
 *
 * Returns the per-area op ranges (empty for a single-area project, which is
 * delegated to `composeDesignDxf` unchanged).
 */
export function composeSiteDxf(dxf: DxfWriter, opts: ComposeSiteOptions): ComposedAreaRange[] {
  const {
    areas: allAreas, activeAreaId, design, projectName, config, meta,
    feeders, substation, areaZones, areaFeeders, selectedAreaIds,
    sheetExtras, textOverrides,
  } = opts;

  // Only the chosen footprints are drawn (default: the entire site). Resolved
  // before the single-area fast path so printing ONE area of a multi-area site
  // produces exactly the legacy single-yard sheet.
  const areas = selectedSiteAreas(allAreas, selectedAreaIds);

  // ---- Single-area fast path: byte-identical to the legacy composition ----
  if (areas.length < 2) {
    // Printing ONE area of a multi-area site must print THAT area. Only the
    // active area is mirrored into the live `design`/`feeders`/`substation`
    // inputs, so an inactive selection has to be composed from the area's own
    // stored design, routes and take-off — otherwise the drafter picks
    // "BESS AREA 2" and is handed the yard they happen to be editing, under
    // the other area's name.
    const only = areas.length === 1 ? areas[0] : null;
    const inactive = only && only.id !== activeAreaId ? only : null;
    if (inactive) {
      const d = inactive.design;
      // An ungenerated area has no linework to print. Falling through to the
      // active design would silently print the wrong yard, so compose the
      // sheet chrome alone and let the empty sheet say so plainly.
      const routes = areaFeeders?.[inactive.id] ?? null;
      const endpoint = areaFeederEndpoint(inactive, allAreas, {
        activeAreaId, liveEndpoint: substation ?? null,
      });
      const zones = inactive.edits?.areaZones ?? null;
      composeDesignDxf(dxf, d ?? design, projectName, config, meta,
        routes ?? undefined, endpoint ?? undefined,
        undefined, undefined, undefined, undefined,
        zones && zones.length ? zones : undefined,
        sheetExtras, textOverrides);
      return [];
    }
    composeDesignDxf(dxf, design, projectName, config, meta, feeders, substation,
      undefined, undefined, undefined, undefined,
      areaZones && areaZones.length ? areaZones : undefined,
      sheetExtras, textOverrides);
    return [];
  }

  const eci = !!sheetExtras?.eciLegend;
  const feederNfpa = sheetExtras?.includeFeederNfpaAnnotations !== false;
  const ranges: ComposedAreaRange[] = [];

  // Each drawn area's own collection system, resolved once: the ACTIVE area
  // uses the live routes/endpoint (in-flight edits), every other area uses its
  // stored routes and its assigned take-off. Resolved before the frame so the
  // border encloses every drawn feeder, not just the active area's.
  const perArea = areas.map(area => {
    const active = area.id === activeAreaId;
    return {
      area, active,
      routes: (active ? feeders : areaFeeders?.[area.id]) ?? null,
      endpoint: areaFeederEndpoint(area, allAreas, {
        activeAreaId, liveEndpoint: substation ?? null,
      }),
    };
  });

  addBaseLayers(dxf);

  // ONE sheet frame for the whole project, wrapped around every footprint.
  // The schedule is suppressed: it anchors south of a single design's extents
  // and would land on a neighbouring area's yard.
  const pb = siteplanBounds(areas, design, feeders, substation,
    perArea.filter(p => !p.active).map(p => ({ feeders: p.routes, substation: p.endpoint })));
  const zoneKinds = areaZoneKindsPresent(areaZones ?? null);
  addSheetFrame(dxf, design, projectName, config, meta, feeders, substation, {
    schedule: false,
    ...(pb ? { planBounds: pb } : {}),
    ...(zoneKinds.length ? { areaZoneKinds: zoneKinds } : {}),
    ...(sheetExtras?.bottomBanner ? { bottomBanner: sheetExtras.bottomBanner } : {}),
    ...(sheetExtras?.scaleBar ? { scaleBar: true } : {}),
    ...(sheetExtras?.eciLegend ? { eciLegend: true } : {}),
    ...(sheetExtras?.auxManRoute ? { auxManRoute: true } : {}),
  });

  // Every area, in stored order (deterministic: the same site always composes
  // the same op stream).
  for (const { area, active, routes, endpoint } of perArea) {
    // The active area draws from the live mirrored design so in-flight edits
    // appear immediately; the others draw from their own stored designs.
    const d = active ? design : area.design;
    if (!d) continue;
    const opStart = dxf.ops.length;
    drawAreaYard(dxf, d, config, eci,
      active ? (areaZones ?? null) : (area.edits?.areaZones ?? null));
    drawAreaName(dxf, area);
    if (active) {
      // Spacing / clearance dimensions stay on the area being edited only:
      // they are sheet-level annotation sized to one design's extents.
      addSpacingDimensions(dxf, d, feederNfpa);
    }
    // EVERY drawn area's collection system, not just the one being edited: a
    // BESS yard's circuits land on its own take-off in the substation yard, so
    // drawing only the active area's feeders hides the collection system for
    // every other footprint on the sheet.
    if (routes && routes.length && endpoint) {
      drawFeedersAndSubstation(dxf, routes, endpoint, d, feederNfpa);
    }
    ranges.push({
      areaId: area.id, name: area.name, active,
      opStart, opEnd: dxf.ops.length,
    });
  }

  // Applied last so every op is in place before overrides patch them (same
  // rule composeDesignDxf follows).
  if (textOverrides && Object.keys(textOverrides).length) {
    dxf.patchTextOverridesForExport(textOverrides);
  }
  return ranges;
}
