// Multi-area site helpers.
//
// A single-boundary project has one parcel, one fence and one yard. A project
// imported from a phase-footprint drawing (e.g. BESS AREAS 1-4 plus SUBSTATION
// AREAS 1-2) has several disjoint footprints that belong to ONE project: they
// must be laid out individually but viewed and exported together.
//
// Every area's boundary is projected in a shared local frame (see
// parseKmlAreas), so the helpers here only deal with per-area layout.

import { Pt, SiteBoundary, SiteDesign, SiteArea } from './types';
import { resolveTakeoffs } from './substationTakeoffs';
import { fencePolygonFor, type FencePlacementMode } from './layoutEngine';

// Substation yards get a fence and a lot line but no BESS layout: the
// collection-system design owns them, not the block placer. Returning a real
// (empty) SiteDesign keeps every downstream consumer working unchanged.
export function emptyAreaDesign(
  boundary: SiteBoundary,
  fencePlacement?: FencePlacementMode
): SiteDesign {
  return {
    boundary,
    // Same project-level fence-placement choice as every other footprint, so
    // a non-BESS area never draws its fence on a different line.
    fence: fencePolygonFor(boundary.polygon, fencePlacement),
    equipment: [],
    augmentationZones: [],
    reservedZones: [],
    reserveSummary: null,
    roads: [],
    aisles: [],
    roadNetwork: null,
    gate: null,
    cables: [],
    trench: null,
    surfacing: null,
    blockRows: [],
    rowEditGeom: null,
    blocksPlaced: 0,
    blocksRequired: 0,
    achievedMW: 0,
    achievedMWh: 0,
    targetMW: 0,
    targetMWh: 0,
    warnings: [],
  };
}

// Bounding box across every area that has geometry, used to frame the whole
// site instead of just the active footprint.
export function siteAreasBounds(
  areas: SiteArea[]
): { cx: number; cy: number; spanX: number; spanY: number } | null {
  const pts: Pt[] = [];
  for (const a of areas) pts.push(...a.boundary.polygon);
  if (pts.length < 2) return null;
  const xs = pts.map(p => p.x);
  const ys = pts.map(p => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  return {
    cx: (minX + maxX) / 2,
    cy: (minY + maxY) / 2,
    spanX: maxX - minX,
    spanY: maxY - minY,
  };
}

function areaCenter(a: SiteArea): Pt {
  const poly = a.boundary.polygon;
  const xs = poly.map(p => p.x), ys = poly.map(p => p.y);
  return {
    x: (Math.min(...xs) + Math.max(...xs)) / 2,
    y: (Math.min(...ys) + Math.max(...ys)) / 2,
  };
}

// Which BESS areas each substation area collects.
//
// A phase-footprint site is arranged BESS–substation–BESS, so every BESS area
// feeds the substation nearest to it. That yields the drafter's expected
// topology on the Big Iron layout — 4 BESS areas across 2 substations, two
// collector feeder positions per substation — without asking for manual
// assignment, while still being correct for uneven counts.
//
// Deterministic: ties break on area id, so the same site always produces the
// same assignment. Returns a map keyed by substation area id. With no
// substation areas (the single-area case and BESS-only sites) it returns an
// empty map and nothing downstream changes.
export function substationCollectionMap(areas: SiteArea[]): Map<string, SiteArea[]> {
  const subs = areas.filter(a => a.kind === 'substation');
  const map = new Map<string, SiteArea[]>();
  if (subs.length === 0) return map;
  for (const s of subs) map.set(s.id, []);
  const subCenters = subs.map(s => ({ area: s, c: areaCenter(s) }));
  for (const b of areas.filter(a => a.kind === 'bess')) {
    const bc = areaCenter(b);
    let best = subCenters[0];
    let bestD = Infinity;
    for (const s of subCenters) {
      const d = Math.hypot(s.c.x - bc.x, s.c.y - bc.y);
      // Strict <: the first substation wins a tie, and subCenters follows the
      // caller's area order, so the result never depends on iteration luck.
      if (d < bestD - 1e-9 || (Math.abs(d - bestD) <= 1e-9 && s.area.id < best.area.id)) {
        best = s; bestD = d;
      }
    }
    map.get(best.area.id)!.push(b);
  }
  return map;
}

// Stable marker every "roads were dropped" warning from the layout engine
// starts with or contains. Matching on this rather than the full sentence
// keeps the detection working when the wording is tuned.
const ROADS_OMITTED_MARKER = 'access roads omitted';
const ACCESS_ROAD_SHORTFALL_MARKER = 'Access-road capacity shortfall:';

// Areas whose yard came out WITHOUT an interior road network.
//
// The layout engine's automatic road mode silently falls back to a compact,
// road-free layout when the target does not fit with roads. On a single-area
// project the drafter sees that warning on the one results card; in a
// multi-area site the warning belongs to an area they may not be looking at,
// so the roads appear to vanish for no reason. Surfacing it per area, by
// name, is what makes the fallback visible instead of silent.
//
// Only BESS areas are considered: a substation yard legitimately has a ring
// and no interior roads.
export function areasMissingRoads(areas: SiteArea[]): { id: string; name: string; reason: string }[] {
  const out: { id: string; name: string; reason: string }[] = [];
  for (const a of areas) {
    if (a.kind !== 'bess' || !a.design) continue;
    const omitted = a.design.warnings.find(w => w.includes(ROADS_OMITTED_MARKER));
    if (omitted) {
      out.push({ id: a.id, name: a.name, reason: omitted });
      continue;
    }
    // Belt and braces: a BESS area that placed equipment but has no road
    // network lost its roads regardless of whether a warning was emitted.
    if (a.design.equipment.length > 0 && !a.design.roadNetwork) {
      out.push({
        id: a.id,
        name: a.name,
        reason: 'This area has no interior access road network.',
      });
    }
  }
  return out;
}

// Multi-area automatic layouts now retain roads when a phase footprint cannot
// meet its requested capacity. Surface that capacity decision at site level as
// well as on the active-area card, so an undersized inactive footprint is never
// hidden behind an otherwise plausible whole-site total.
export function areasWithAccessRoadShortfalls(
  areas: SiteArea[]
): { id: string; name: string; reason: string }[] {
  return areas.flatMap(a => {
    if (a.kind !== 'bess' || !a.design) return [];
    const reason = a.design.warnings.find(w => w.startsWith(ACCESS_ROAD_SHORTFALL_MARKER));
    return reason ? [{ id: a.id, name: a.name, reason }] : [];
  });
}

// One area's contribution to the whole-site rollup. Areas that failed to
// generate (design === null) still contribute their parcel acreage and are
// counted as pending, so the site total never silently hides a missing yard.
export interface SiteAreaTotal {
  id: string;
  name: string;
  kind: SiteArea['kind'];
  acres: number;
  generated: boolean;
  achievedMW: number;
  achievedMWh: number;
  blocksPlaced: number;
  blocksRequired: number;
  bessContainers: number;
  pcsUnits: number;
  // Blocks still owed against THIS area's own target. Every BESS footprint is
  // designed to the full selected rating, so a shortfall here is this area's
  // shortfall — never a share of a divided site target.
  blocksShort: number;
  // Future augmentation reserved in this area. Reported separately and never
  // folded into achievedMW/achievedMWh: it is future capacity, not active
  // nameplate.
  augBlocks: number;
  augMW: number;
  augMWh: number;
  // Name of the substation area collecting this yard's feeders, or null when
  // no take-off is aimed at it (its MV feeders go nowhere — see
  // takeoffWarnings). Substation areas themselves are always null.
  servingSubstation: string | null;
  // Number of routed MV feeder circuits leaving this area, when the caller
  // supplies the per-area feeder map. -1 = not supplied (unknown), which
  // reads differently from a genuine 0 (assigned but nothing routed).
  feederCount: number;
}

export interface SiteTotals {
  achievedMW: number;
  achievedMWh: number;
  blocksPlaced: number;
  blocksRequired: number;
  bessContainers: number;
  pcsUnits: number;
  acres: number;
  blocksShort: number;
  augBlocks: number;
  augMW: number;
  augMWh: number;
  // Areas whose layout has not been generated (or that failed). A site total
  // reported while this is non-zero is INCOMPLETE — every surface that shows
  // the total must say so rather than presenting an undercount as final.
  pendingAreas: number;
  perArea: SiteAreaTotal[];
}

// Whole-site rollup across the per-area designs. Capacity, block counts and
// equipment counts are summed across areas while each area is still reported
// separately in `perArea`, so a surface can show the site figure and the
// per-area breakdown from ONE computation (they can never disagree).
export function siteAreasTotals(
  areas: SiteArea[],
  // Optional per-area routed feeder counts (store's areaFeeders map), so the
  // rollup can report feeder coverage next to capacity in ONE computation.
  areaFeederCounts?: Record<string, number>
): SiteTotals {
  // Which substation collects each BESS area, resolved from the drafter's
  // take-off aims (falling back to the automatic nearest-substation defaults)
  // so the rollup names the SAME substation the feeder router uses.
  const nameById = new Map(areas.map(a => [a.id, a.name]));
  const servedBy = new Map<string, string>();
  resolveTakeoffs(areas).forEach((r, bessId) => {
    servedBy.set(bessId, nameById.get(r.substationAreaId) ?? r.substationAreaId);
  });
  const perArea: SiteAreaTotal[] = areas.map(a => {
    const d = a.design;
    // Augmentation-reserve and future build-out units (traced from the KMZ)
    // are excluded here the same way the engine excludes them from
    // achievedMW/MWh — the equipment totals must describe BUILT capacity.
    const count = (kind: string) =>
      (d ? d.equipment.filter(e => e.kind === kind && !e.augmented && !e.future).length : 0);
    // Traced PCS units (KMZ auto-fill) each represent one block: the engine
    // already folds them into achievedMW/MWh; fold them into the block count
    // here so "N blocks" and the MW figure can never disagree.
    const placed = (d?.blocksPlaced ?? 0) + (d?.tracedPcsUnits ?? 0);
    const required = d?.blocksRequired ?? 0;
    const rs = d?.reserveSummary ?? null;
    return {
      id: a.id,
      name: a.name,
      kind: a.kind,
      acres: a.boundary.areaAcres,
      generated: !!d,
      achievedMW: d?.achievedMW ?? 0,
      achievedMWh: d?.achievedMWh ?? 0,
      blocksPlaced: placed,
      blocksRequired: required,
      bessContainers: count('bess'),
      pcsUnits: count('inverter'),
      blocksShort: Math.max(0, required - placed),
      augBlocks: rs?.augBlocksPlaced ?? 0,
      augMW: rs?.augMW ?? 0,
      augMWh: rs?.augMWh ?? 0,
      servingSubstation: a.kind === 'bess' ? (servedBy.get(a.id) ?? null) : null,
      feederCount: a.kind === 'bess' && areaFeederCounts
        ? (areaFeederCounts[a.id] ?? 0)
        : -1,
    };
  });
  const sum = (pick: (t: SiteAreaTotal) => number) => perArea.reduce((s, t) => s + pick(t), 0);
  return {
    achievedMW: sum(t => t.achievedMW),
    achievedMWh: sum(t => t.achievedMWh),
    blocksPlaced: sum(t => t.blocksPlaced),
    blocksRequired: sum(t => t.blocksRequired),
    bessContainers: sum(t => t.bessContainers),
    pcsUnits: sum(t => t.pcsUnits),
    acres: sum(t => t.acres),
    blocksShort: sum(t => t.blocksShort),
    augBlocks: sum(t => t.augBlocks),
    augMW: sum(t => t.augMW),
    augMWh: sum(t => t.augMWh),
    pendingAreas: perArea.filter(t => !t.generated).length,
    perArea,
  };
}
