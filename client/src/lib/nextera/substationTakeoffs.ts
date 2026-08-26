// Substation MV take-off points.
//
// A single-area project has ONE substation point: the drafter drops a marker
// and every feeder in the yard runs to it. A phase-footprint site is
// different — several BESS areas feed a shared substation yard, and each area
// lands on its OWN position inside that yard. Those positions are take-offs.
//
// A take-off carries three things the router needs:
//   - where it sits (in the SHARED projected frame, so a BESS area can target
//     a point inside the substation area's fence),
//   - which BESS area's feeders land on it (`servesAreaId`),
//   - which way those feeders travel as they arrive (`dir`), which fixes the
//     corridor side instead of letting it be inferred from centroids.
//
// Nothing here runs for a single-area project: with no substation areas the
// resolver returns an empty map and every caller keeps its legacy path.

import { Pt, SiteArea, SiteDesign, SubstationTakeoff, TakeoffDirection, TAKEOFF_DIRECTIONS, takeoffVector } from './types';
import { pointInPolygon } from './kmz';

// Two take-offs closer than this read as one position on the drawing (and
// their approach corridors would overlap), so edits that violate it are
// rejected rather than quietly drawn on top of each other.
export const TAKEOFF_MIN_SPACING_FT = 30;

/** Stable prefix every take-off rejection notice starts with. */
export const TAKEOFF_REJECT_PREFIX = 'Substation take-off rejected:';

const bounds = (poly: Pt[]) => {
  const xs = poly.map(p => p.x), ys = poly.map(p => p.y);
  return {
    minX: Math.min(...xs), maxX: Math.max(...xs),
    minY: Math.min(...ys), maxY: Math.max(...ys),
  };
};

const centerOf = (poly: Pt[]): Pt => {
  const b = bounds(poly);
  return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
};

/**
 * Snap a travel vector to one of the eight compass directions.
 *
 * Deterministic on ties: the vector is compared against each direction's own
 * unit vector in a FIXED order (N, NE, E, ... see TAKEOFF_DIRECTIONS), and a
 * strictly-better score is required to displace the incumbent, so an exactly
 * diagonal vector always resolves the same way.
 */
export function snapTakeoffDirection(dx: number, dy: number): TakeoffDirection {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return 'E';
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return 'E';
  const ux = dx / len, uy = dy / len;
  let best: TakeoffDirection = TAKEOFF_DIRECTIONS[0];
  let bestDot = -Infinity;
  for (const d of TAKEOFF_DIRECTIONS) {
    const v = takeoffVector(d);
    const vl = Math.hypot(v.dx, v.dy) || 1;
    const dot = (ux * v.dx + uy * v.dy) / vl;
    if (dot > bestDot + 1e-9) { bestDot = dot; best = d; }
  }
  return best;
}

/**
 * The take-offs a substation area starts with, derived from the collector
 * feeder positions its yard generator already placed (one per collected BESS
 * area, each tagged with `servesAreaId`).
 *
 * These are pure defaults: the moment a drafter edits them the area stores its
 * own list and this is no longer consulted. Areas whose position could not be
 * placed (too-small yard) simply have no default take-off — the yard generator
 * already warns about that, and inventing a point outside the fence would be
 * worse than having none.
 */
export function defaultTakeoffs(sub: SiteArea, bessAreas: SiteArea[]): SubstationTakeoff[] {
  const design = sub.design;
  if (!design) return [];
  const byId = new Map(bessAreas.map(a => [a.id, a]));
  const out: SubstationTakeoff[] = [];
  for (const e of design.equipment) {
    if (e.kind !== 'substationFeeder') continue;
    const served = e.servesAreaId ? byId.get(e.servesAreaId) : undefined;
    // Direction the feeders TRAVEL: from the served yard toward this position.
    const dir = served
      ? snapTakeoffDirection(e.x - centerOf(served.boundary.polygon).x,
                             e.y - centerOf(served.boundary.polygon).y)
      : 'E';
    out.push({
      id: `takeoff-${e.id}`,
      x: e.x,
      y: e.y,
      dir,
      servesAreaId: e.servesAreaId ?? null,
    });
  }
  return out;
}

/** The take-offs in force for a substation area: the drafter's if it has any,
 *  otherwise the automatic ones. An area edited down to an EMPTY list keeps
 *  that empty list (deliberately removing every take-off is a real state, not
 *  a request for the defaults back). */
export function effectiveTakeoffs(sub: SiteArea, bessAreas: SiteArea[]): SubstationTakeoff[] {
  const edited = sub.edits?.takeoffs;
  return edited ? edited : defaultTakeoffs(sub, bessAreas);
}

/**
 * Why a take-off placement is invalid, or null when acceptable.
 *
 * `others` are the take-offs it must stay clear of (the area's remaining
 * take-offs — never itself). Policy matches every other drafter edit in the
 * app: reject with a reason and keep the previous valid state, never drop or
 * silently move an existing routed position.
 */
export function takeoffRejectReason(
  design: SiteDesign | null,
  p: Pt,
  others: SubstationTakeoff[]
): string | null {
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) {
    return 'the position is not a finite point';
  }
  const fence = design?.fence;
  if (!fence || fence.length < 3) {
    return 'the substation area has no fenced yard to hold a take-off';
  }
  if (!pointInPolygon(p, fence)) {
    return 'the position is outside the substation fence';
  }
  const clash = others.find(t => Math.hypot(t.x - p.x, t.y - p.y) < TAKEOFF_MIN_SPACING_FT);
  if (clash) {
    return `it would sit within ${TAKEOFF_MIN_SPACING_FT} ft of another take-off`;
  }
  return null;
}

/** Where each BESS area's feeders land: BESS area id -> its take-off, plus the
 *  substation area holding it. Areas with no take-off aimed at them are absent
 *  (the caller reports that; it never falls back to a guessed point). */
export interface ResolvedTakeoff {
  takeoff: SubstationTakeoff;
  substationAreaId: string;
}

export function resolveTakeoffs(areas: SiteArea[]): Map<string, ResolvedTakeoff> {
  const out = new Map<string, ResolvedTakeoff>();
  const subs = areas.filter(a => a.kind === 'substation');
  if (!subs.length) return out;
  const bess = areas.filter(a => a.kind === 'bess');
  const bessIds = new Set(bess.map(a => a.id));
  // Fixed area order, then take-off order: the FIRST take-off aimed at an area
  // wins, so a drafter who aims two at the same area gets a deterministic
  // result (and a warning from takeoffWarnings) rather than order-of-iteration
  // luck.
  for (const s of subs) {
    for (const t of effectiveTakeoffs(s, bess)) {
      if (!t.servesAreaId || !bessIds.has(t.servesAreaId)) continue;
      if (out.has(t.servesAreaId)) continue;
      out.set(t.servesAreaId, { takeoff: t, substationAreaId: s.id });
    }
  }
  return out;
}

/**
 * Where ONE area's feeders land, for report/export consumers that score an
 * area against its own routes.
 *
 * A multi-area BESS yard has no local substation of its own — its landing
 * point is a take-off inside the substation area — so passing the legacy
 * `substation` field for it hands these consumers `null` and silently drops
 * every feeder-dependent finding for a fully routed yard. Substation areas
 * and single-area projects keep their own local substation.
 *
 * `liveEndpoint` is the ACTIVE area's already-resolved endpoint, which carries
 * the drafter's in-flight edits; it wins for that area.
 */
export function areaFeederEndpoint(
  area: SiteArea,
  areas: SiteArea[],
  opts: { activeAreaId?: string | null; liveEndpoint?: Pt | null } = {}
): Pt | null {
  if (opts.activeAreaId && area.id === opts.activeAreaId && opts.liveEndpoint) {
    return opts.liveEndpoint;
  }
  const own = area.edits?.substation ?? null;
  if (own) return own;
  if (areas.length < 2 || area.kind !== 'bess') return own;
  return resolveTakeoffs(areas).get(area.id)?.takeoff ?? null;
}

/**
 * Fences the cross-area feeders must not cut through: every area's fence
 * EXCEPT the source BESS yard (whose equipment obstacles already apply, and
 * whose feeders must be free to leave it) and the target substation yard
 * (which the feeders exist to enter).
 *
 * Returned as polygons; the router reduces them to obstacle rects.
 */
export function foreignFences(
  areas: SiteArea[], sourceAreaId: string, targetSubstationAreaId: string | null
): Pt[][] {
  const out: Pt[][] = [];
  for (const a of areas) {
    if (a.id === sourceAreaId || a.id === targetSubstationAreaId) continue;
    const f = a.design?.fence;
    if (f && f.length >= 3) out.push(f);
  }
  return out;
}

/** Problems worth telling the drafter about, in stable-prefixed sentences.
 *  Nothing here blocks routing — it reports what will NOT be routed. */
export function takeoffWarnings(areas: SiteArea[]): string[] {
  const subs = areas.filter(a => a.kind === 'substation');
  if (!subs.length) return [];
  const bess = areas.filter(a => a.kind === 'bess');
  const nameById = new Map(areas.map(a => [a.id, a.name]));
  const warnings: string[] = [];
  const claimed = new Set<string>();
  for (const s of subs) {
    for (const t of effectiveTakeoffs(s, bess)) {
      if (!t.servesAreaId) {
        warnings.push(`Substation take-off in ${s.name} is not aimed at a BESS area — it collects nothing.`);
        continue;
      }
      if (claimed.has(t.servesAreaId)) {
        warnings.push(
          `More than one substation take-off is aimed at ${nameById.get(t.servesAreaId) ?? t.servesAreaId} — ` +
          `only the first collects its feeders.`);
        continue;
      }
      claimed.add(t.servesAreaId);
    }
  }
  for (const b of bess) {
    if (!claimed.has(b.id)) {
      warnings.push(`${b.name} has no substation take-off aimed at it — its MV feeders are not routed to a substation.`);
    }
  }
  return warnings;
}

/** Stable marker for every take-off coverage/aim warning above. */
export const TAKEOFF_WARNING_MARKERS = [
  'Substation take-off in ',
  'More than one substation take-off',
  ' has no substation take-off aimed at it',
];
