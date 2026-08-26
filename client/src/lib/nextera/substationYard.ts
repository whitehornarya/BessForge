// Collector-substation yard layout.
//
// A phase-footprint import (e.g. BESS AREAS 1-4 + SUBSTATION AREAS 1-2) has
// footprints that are NOT battery yards. They previously came back as
// `emptyAreaDesign` — a fence and nothing else — so the substation areas drew
// as bare outlines with no yard and no access.
//
// This generator gives a substation area its own civil works using the SAME
// standards as a BESS yard: the fence sits where the project's fence-placement
// choice puts it (`fenceToLotLine` inside the parcel by default, or on the
// property line when the drafter has selected that) and the perimeter road
// ring comes from the shared `buildRoads` engine, so road width, fillet radii,
// gate width and entrance apron all match the battery yards.
//
// DECISION (2026-08-11, drafter rule): a substation area carries NO placed
// equipment. The substation package itself is designed outside this tool; the
// only electrical content that ever lands in one of these yards is the feeder
// take-off the BESS areas run to. The yard therefore generates exactly the
// civil scope — boundary, fence, roads, gate — and leaves the interior clear
// for feeders. The `mainTransformer` / `mvSwitchgear` / `controlHouse` kinds
// stay in the catalog as reference specs, but nothing places them.
//
// Nothing here runs for BESS areas: `generateSiteDesign` is untouched.

import { Pt, SiteBoundary, SiteDesign, PlacedEquipment } from './types';
import { pointInPolygon, rectInsidePolygon } from './kmz';
import { CLEARANCES, SUBSTATION_FEEDER } from './catalog';
import { buildRoads, fencePolygonFor, type GateEdge, type FencePlacementMode } from './layoutEngine';

// One BESS area whose MV feeders are collected by this substation.
export interface CollectedArea {
  // SiteArea id — unique across the site, unlike per-area equipment ids.
  id: string;
  name: string;
  // Nameplate the area contributes to this substation, in MW. Summed into
  // the yard's collected total so the drafter can see what the yard carries.
  mw: number;
}

export interface SubstationYardOptions {
  // Fence edge the entrance gate is placed on (same knob as a BESS yard).
  gateEdge?: GateEdge | null;
  // BESS areas this substation collects. Each one gets its OWN collector
  // feeder position in the yard, so a substation serving two BESS areas
  // carries two of them.
  collects?: CollectedArea[];
  // Fence placement (same project-level knob as a BESS yard, so one site
  // never mixes an inset fence on one footprint with a property-line fence
  // on another). Absent/'inset' keeps the historical setback.
  fencePlacement?: FencePlacementMode;
}

function polyBounds(poly: Pt[]) {
  const xs = poly.map(p => p.x), ys = poly.map(p => p.y);
  return {
    minX: Math.min(...xs), maxX: Math.max(...xs),
    minY: Math.min(...ys), maxY: Math.max(...ys),
  };
}

/**
 * Lay out a substation area: fence, perimeter road ring and an entrance gate.
 * Returns a real `SiteDesign` so it flows through every existing per-area
 * consumer unchanged.
 *
 * The yard interior stays EMPTY by design — see the decision note at the top
 * of this file. Only the feeders the BESS areas run in ever occupy it.
 *
 * Deterministic: same boundary in, same yard out. A footprint too small to
 * hold a fenced yard comes back fence-only (or lot-line-only) with a warning
 * — never a throw, so one bad area can't fail the whole site import.
 */
export function generateSubstationYard(
  boundary: SiteBoundary,
  options: SubstationYardOptions = {}
): SiteDesign {
  const warnings: string[] = [];
  const fence = fencePolygonFor(boundary.polygon, options.fencePlacement);

  const empty = (): SiteDesign => ({
    boundary,
    fence,
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
    warnings,
  });

  // The setback is only the reason the yard collapsed when the fence is
  // actually inset; a property-line fence is the parcel itself.
  const tooSmall = options.fencePlacement === 'property-line'
    ? 'Substation area is too small for a usable fenced yard on the property line.'
    : `Substation area is too small for a usable fenced yard at the standard ${CLEARANCES.fenceToLotLine} ft lot-line setback.`;

  if (fence.length < 3) {
    warnings.push(tooSmall);
    return empty();
  }

  // The lot-line inset can collapse a tiny parcel into a sub-inch sliver that
  // is still technically a polygon, which would sail through every check below
  // and produce a "yard" no vehicle could use. Require a fence with real area
  // before going any further.
  const MIN_FENCE_AREA_SQFT = 400; // a 20 ft x 20 ft yard is already absurd
  const fenceArea = Math.abs(
    fence.reduce((s, p, i) => {
      const q = fence[(i + 1) % fence.length];
      return s + (p.x * q.y - q.x * p.y);
    }, 0) / 2
  );
  if (fenceArea < MIN_FENCE_AREA_SQFT) {
    warnings.push(tooSmall);
    return empty();
  }

  // ---- Roads + gate through the shared engine ------------------------------
  // No equipment and no BESS block rows: the ring follows the fence and the
  // gate lands on the requested edge, leaving the whole interior clear for the
  // feeders that arrive from the BESS areas.
  const { roads, aisles, roadNetwork, gate, roadWarnings } = buildRoads(
    fence,
    [],
    [],
    { width: 0, depth: 0, coreWidth: 0 },
    false,
    options.gateEdge ?? 'S',
    null,
    [],
    [],
    [],
    [],
    [],
    [],
    'fence',
    null,
    // The yard is empty by design, so the engine's "no equipment ⇒ no ring"
    // rule must not apply here.
    true
  );
  warnings.push(...roadWarnings);

  // A parcel can be large enough to inset a fence but still too small to hold
  // the 24 ft road band inside it. Say so rather than returning a yard that
  // silently has no access.
  if (!roadNetwork || !gate) {
    warnings.push(
      'Substation area is too small for a perimeter access road and gate inside the fence — fence only.'
    );
  }

  // ---- Collector feeder positions -----------------------------------------
  // One position per BESS area this substation collects, so a yard serving
  // two BESS areas carries two of them. They sit on the yard centerline,
  // evenly spaced and ordered by the area they serve, which keeps the layout
  // deterministic and keeps the rest of the interior clear for the incoming
  // feeder runs. This is the ONLY equipment a substation yard ever places.
  const equipment: PlacedEquipment[] = [];
  const collects = options.collects ?? [];
  if (collects.length > 0) {
    const fb = polyBounds(fence);
    const cy = (fb.minY + fb.maxY) / 2;
    const hx = SUBSTATION_FEEDER.length / 2;
    const hy = SUBSTATION_FEEDER.width / 2;
    // Even spacing across the yard width: N positions get N+1 gaps, so the
    // lineup stays centered whatever the count.
    const span = fb.maxX - fb.minX;
    const placed: PlacedEquipment[] = [];
    const skipped: string[] = [];
    collects.forEach((c, i) => {
      const x = fb.minX + (span * (i + 1)) / (collects.length + 1);
      // Never place a position that would sit outside the fenced yard (a
      // narrow or concave substation parcel), and never silently drop one:
      // an unplaceable position is named in a warning below.
      if (!rectInsidePolygon(x, cy, hx, hy, fence, CLEARANCES.sideToFence)) {
        skipped.push(c.name);
        return;
      }
      placed.push({
        id: `subfeeder-${i + 1}`,
        kind: 'substationFeeder',
        label: `SF ${i + 1}`,
        x, y: cy,
        rotation: 0,
        length: SUBSTATION_FEEDER.length,
        width: SUBSTATION_FEEDER.width,
        height: SUBSTATION_FEEDER.height,
        servesAreaId: c.id,
      });
    });
    equipment.push(...placed);
    if (skipped.length > 0) {
      warnings.push(
        `Substation yard has no room for the collector feeder position${skipped.length > 1 ? 's' : ''} ` +
        `serving ${skipped.join(', ')} — place ${skipped.length > 1 ? 'them' : 'it'} manually in detailed design.`
      );
    }
    const collectedMW = collects.reduce((s, c) => s + (Number.isFinite(c.mw) ? c.mw : 0), 0);
    if (collectedMW > 0) {
      warnings.push(
        `Substation collects ${collectedMW.toFixed(1)} MW from ${collects.length} BESS ` +
        `area${collects.length > 1 ? 's' : ''}: ${collects.map(c => c.name).join(', ')}.`
      );
    }
  }

  return {
    boundary,
    fence,
    equipment,
    augmentationZones: [],
    reservedZones: [],
    reserveSummary: null,
    roads,
    aisles,
    roadNetwork,
    gate,
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
    warnings,
  };
}

/**
 * Default MV take-off point for a substation area.
 *
 * The yard holds no equipment, so there is no switchgear to key off: the seed
 * point is the center of the fenced yard, which is the clear interior the
 * feeders run to. The feeder work uses this as the starting position for the
 * per-area take-off points a drafter can then aim and move. Returns null when
 * the area has no fenced yard (footprint too small).
 */
export function substationTakeoffPoint(design: SiteDesign | null): Pt | null {
  const fence = design?.fence;
  if (!fence || fence.length < 3) return null;
  const b = polyBounds(fence);
  const c = { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
  // A concave yard's bounding-box center can fall outside the fence; fall
  // back to the vertex average, which is always inside a simple polygon's
  // hull, and only report a point that really sits in the yard.
  if (pointInPolygon(c, fence)) return c;
  const avg = {
    x: fence.reduce((s, p) => s + p.x, 0) / fence.length,
    y: fence.reduce((s, p) => s + p.y, 0) / fence.length,
  };
  return pointInPolygon(avg, fence) ? avg : null;
}

/** True when the point sits inside the area's fenced yard. */
export function insideYard(design: SiteDesign | null, p: Pt): boolean {
  if (!design?.fence?.length) return false;
  return pointInPolygon(p, design.fence);
}
