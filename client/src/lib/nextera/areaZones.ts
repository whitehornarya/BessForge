// ---------------------------------------------------------------------------
// Drag-to-place site area zones: laydown yard, dry pond, wet pond, and
// underground exclusion area rectangles the drafter draws in the design view.
//
// These are ANNOTATION rectangles — they never feed the layout engine, never
// move equipment, and never model drainage. They live at store level (like
// gradingZones), travel in the project file only when non-empty, and are
// drawn opt-in on the DXF/PDF exports so a zone-free project keeps every
// export byte-identical to today's output.
// ---------------------------------------------------------------------------

import { pointInPolygon } from './kmz';
import { Pt } from './types';

export type AreaZoneKind = 'laydown' | 'dryPond' | 'wetPond' | 'exclusion';

export interface AreaZone {
  id: string;
  kind: AreaZoneKind;
  x: number;        // rectangle center, site ft
  y: number;
  lengthFt: number; // extent along x
  widthFt: number;  // extent along y
}

export const MAX_AREA_ZONES = 12;
export const AREA_ZONE_MIN_SIZE_FT = 20;
export const AREA_ZONE_MAX_SIZE_FT = 5000;

// Reference legend phrasing (issued CK1-E-200 civil sheet).
export const AREA_ZONE_LABELS: Record<AreaZoneKind, string> = {
  dryPond: 'DRY POND',
  wetPond: 'WET POND',
  laydown: 'LAYDOWN YARD',
  exclusion: 'UNDERGROUND EXCLUSION AREA',
};

// Fixed legend/report order (reference sheet order).
export const AREA_ZONE_KIND_ORDER: AreaZoneKind[] = ['dryPond', 'wetPond', 'laydown', 'exclusion'];

// Scene overlay colors, sampled from the reference CK1-E-200 legend swatches:
// dry pond = light tan FILL (219,206,195), wet pond = soft light-blue FILL
// (189,210,252). Laydown crosshatch amber and exclusion gray unchanged.
export const AREA_ZONE_COLORS: Record<AreaZoneKind, string> = {
  dryPond: '#dbcec3',
  wetPond: '#bdd2fc',
  laydown: '#eab308',
  exclusion: '#9ca3af',
};

// Zone EDGE colors (reference swatch borders): dry pond thick brown
// (148,110,76), wet pond blue (59,122,247). Laydown/exclusion edges match
// their fill hue.
export const AREA_ZONE_BORDER_COLORS: Record<AreaZoneKind, string> = {
  dryPond: '#946e4c',
  wetPond: '#3b7af7',
  laydown: '#eab308',
  exclusion: '#9ca3af',
};

const isKind = (v: unknown): v is AreaZoneKind =>
  v === 'laydown' || v === 'dryPond' || v === 'wetPond' || v === 'exclusion';

// Untrusted zones from a project file / autosave: invalid entries are
// DROPPED instead of rejecting the file (sanitizeGradingZones policy).
export function sanitizeAreaZones(v: unknown): AreaZone[] {
  if (!Array.isArray(v)) return [];
  const out: AreaZone[] = [];
  const seen = new Set<string>();
  for (const raw of v) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const z = raw as Record<string, unknown>;
    if (typeof z.id !== 'string' || !z.id || seen.has(z.id)) continue;
    if (!isKind(z.kind)) continue;
    if (typeof z.x !== 'number' || !Number.isFinite(z.x)) continue;
    if (typeof z.y !== 'number' || !Number.isFinite(z.y)) continue;
    if (typeof z.lengthFt !== 'number' || !Number.isFinite(z.lengthFt)) continue;
    if (typeof z.widthFt !== 'number' || !Number.isFinite(z.widthFt)) continue;
    out.push({
      id: z.id,
      kind: z.kind,
      x: z.x,
      y: z.y,
      lengthFt: Math.min(AREA_ZONE_MAX_SIZE_FT, Math.max(AREA_ZONE_MIN_SIZE_FT, z.lengthFt)),
      widthFt: Math.min(AREA_ZONE_MAX_SIZE_FT, Math.max(AREA_ZONE_MIN_SIZE_FT, z.widthFt)),
    });
    seen.add(z.id);
    if (out.length >= MAX_AREA_ZONES) break;
  }
  return out;
}

const zoneRect = (z: AreaZone) => ({
  x0: z.x - z.lengthFt / 2, x1: z.x + z.lengthFt / 2,
  y0: z.y - z.widthFt / 2, y1: z.y + z.widthFt / 2,
});

// Validation for the reject→keep pattern: returns the specific reason a
// candidate zone set is not acceptable, or null when valid. Zones must sit
// fully inside the PARCEL boundary (the reference plots place ponds and the
// laydown yard outside the fence but inside the lot line) and must not
// overlap each other. Overlap with the fenced yard is allowed — a laydown
// yard may legitimately sit inside the fence.
export function areaZonesRejectReason(zones: AreaZone[], parcel: Pt[]): string | null {
  if (zones.length > MAX_AREA_ZONES) {
    return `at most ${MAX_AREA_ZONES} area zones are supported`;
  }
  if (parcel.length >= 3) {
    for (const z of zones) {
      const r = zoneRect(z);
      const corners: Pt[] = [
        { x: r.x0, y: r.y0 }, { x: r.x1, y: r.y0 },
        { x: r.x1, y: r.y1 }, { x: r.x0, y: r.y1 },
      ];
      if (!corners.every(c => pointInPolygon(c, parcel))) {
        return `${AREA_ZONE_LABELS[z.kind]} zone extends outside the parcel boundary`;
      }
    }
  }
  for (let i = 0; i < zones.length; i++) {
    for (let j = i + 1; j < zones.length; j++) {
      const a = zoneRect(zones[i]), b = zoneRect(zones[j]);
      if (a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1) {
        return `${AREA_ZONE_LABELS[zones[i].kind]} and ${AREA_ZONE_LABELS[zones[j].kind]} zones overlap`;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Underground exclusion enforcement (Task: routes must respect exclusions).
// Exclusion zones are the ONE area-zone kind that constrains routing: buried
// trench/cable runs must not cross them. These helpers give the routers and
// the audits a single shared crossing test. Zone-free projects stay
// byte-identical — every consumer no-ops on an empty rect list.

export interface ExclusionRect { x1: number; y1: number; x2: number; y2: number; id: string; }

export function exclusionRects(zones: AreaZone[] | null | undefined): ExclusionRect[] {
  return (zones ?? [])
    .filter(z => z.kind === 'exclusion')
    .map(z => ({
      x1: z.x - z.lengthFt / 2, y1: z.y - z.widthFt / 2,
      x2: z.x + z.lengthFt / 2, y2: z.y + z.widthFt / 2,
      id: z.id,
    }));
}

export const pointInExclusion = (p: Pt, rects: ExclusionRect[]): ExclusionRect | null =>
  rects.find(r => p.x > r.x1 && p.x < r.x2 && p.y > r.y1 && p.y < r.y2) ?? null;

// Sampled polyline-vs-exclusion test (segments sampled every `stepFt` so
// mid-segment crossings are caught, same policy as the fence-exit sampler).
export function routeCrossesExclusion(
  pts: Pt[] | null | undefined, rects: ExclusionRect[], stepFt = 5
): ExclusionRect | null {
  if (!pts || pts.length < 2 || !rects.length) return null;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / stepFt));
    for (let s = 0; s <= steps; s++) {
      const hit = pointInExclusion(
        { x: a.x + ((b.x - a.x) * s) / steps, y: a.y + ((b.y - a.y) * s) / steps }, rects);
      if (hit) return hit;
    }
  }
  return null;
}

// The kinds present in a zone set, in fixed legend order (deduped) — feeds
// the conditional legend rows on the sheet frame.
export function areaZoneKindsPresent(zones: AreaZone[] | null | undefined): AreaZoneKind[] {
  if (!zones || !zones.length) return [];
  const present = new Set(zones.map(z => z.kind));
  return AREA_ZONE_KIND_ORDER.filter(k => present.has(k));
}
