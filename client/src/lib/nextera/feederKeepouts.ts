// Trench-corridor keep-outs for automatic MV feeder routing (R-TR discipline
// per the feeder routing intelligence spec + CAR-D-B006 trench sections):
//
//  - HARD keep-outs: the island 480V/fiber corridor trenches (the center
//    lane between an island's two PCS rows — MV home runs must never enter
//    or ride it) and reserved FUTURE-equipment zones (future BESS blocks /
//    island aug ladders hold buried scope of their own; BOL feeder trenches
//    stay out so the future work never digs across them).
//  - CROSSABLE band: the yard's central "480V Aux and Fiber Trench" spine.
//    An MV run may cross it PERPENDICULAR at discrete points, but never
//    ride along inside it or turn within it.
//
// Everything here is derived geometry — no design mutation. Empty designs
// (no trench, no corridor trenches, no reserved zones) produce empty lists,
// keeping feeder routing byte-identical for projects without those features.

import { Pt, SiteDesign } from './types';
import { Rect } from './cableRouting';

// Extra clearance beyond the drawn band/zone edge (ft): keeps the MV trench
// wall a working distance off the 480V trench wall and the future pad edge.
export const CORRIDOR_KEEPOUT_MARGIN_FT = 3;
export const FUTURE_ZONE_KEEPOUT_MARGIN_FT = 2;
// Half-length of the legal perpendicular crossing window cut into the spine
// band for grid reroutes (ft each side of the sanctioned crossing line).
export const SPINE_CROSS_GAP_FT = 6;

/** TEMP: misplaced scanned aux spine — set true when placement is fixed.
 *  When false, yard `design.trench` is omitted from cross keepouts and the 3D scene. */
export const SHOW_YARD_AUX_TRENCH = false;

/** A trench band MV runs may cross perpendicular but never ride along.
 *  `axis` is the direction the trench RUNS ('y' = vertical band). */
export interface CrossBand { rect: Rect; axis: 'x' | 'y'; }

export interface FeederKeepouts {
  hard: Rect[];
  cross: CrossBand[];
}

// Oriented band (rotated placed-island corridors / rotated future zones)
// sampled into overlapping squares — same over-cover-never-gap policy as the
// feeder trench keep-out sampler. Bounded sample count so one long rotated
// island cannot explode the obstacle list.
const ORIENTED_SAMPLES = 64;
function orientedBandRects(
  cx: number, cy: number, angleDeg: number, lengthFt: number, halfWidthFt: number
): Rect[] {
  const out: Rect[] = [];
  const rad = (angleDeg * Math.PI) / 180;
  const ux = Math.cos(rad), uy = Math.sin(rad);
  const half = lengthFt / 2;
  const step = Math.max(halfWidthFt, lengthFt / ORIENTED_SAMPLES);
  const sw = Math.max(halfWidthFt, step);
  const n = Math.max(1, Math.ceil(lengthFt / step));
  for (let k = 0; k <= n; k++) {
    const t = -half + (lengthFt * k) / n;
    const px = cx + ux * t, py = cy + uy * t;
    out.push({ x1: px - sw, y1: py - sw, x2: px + sw, y2: py + sw });
  }
  return out;
}

const nearAxis = (angleDeg: number): 'x' | 'y' | null => {
  const a = ((angleDeg % 180) + 180) % 180;
  if (a < 0.5 || a > 179.5) return 'x';
  if (Math.abs(a - 90) < 0.5) return 'y';
  return null;
};

/** Derive the hard + crossable keep-outs from the design's routed trench
 *  geometry. Safe on partial designs (fields absent → empty lists). */
export function feederKeepouts(design: SiteDesign): FeederKeepouts {
  const hard: Rect[] = [];
  const cross: CrossBand[] = [];
  const M = CORRIDOR_KEEPOUT_MARGIN_FT;

  for (const ct of design.corridorTrenches ?? []) {
    // Positive, finite dimensions only — a forged/stale save with a zero or
    // negative width must not seed a degenerate (or inverted) obstacle rect.
    if (!ct || !Number.isFinite(ct.width) || ct.width <= 0) continue;
    const hw = ct.width / 2 + M;
    // Traced-yard SIDE lanes (single-sided 480V corridor beside a PCS row or
    // column) behave like the yard spine: MV may cross PERPENDICULAR, never
    // ride along or turn inside. Island center lanes stay hard below.
    if (ct.sideLane) {
      if (Number.isFinite(ct.cx) && Number.isFinite(ct.cy) &&
          Number.isFinite(ct.angleDeg) && Number.isFinite(ct.length) && ct.length! > 0) {
        const ax = nearAxis(ct.angleDeg!);
        if (ax === 'x') {
          cross.push({
            rect: { x1: ct.cx! - ct.length! / 2 - M, x2: ct.cx! + ct.length! / 2 + M,
                    y1: ct.cy! - hw, y2: ct.cy! + hw },
            axis: 'x',
          });
          continue;
        }
        if (ax === 'y') {
          cross.push({
            rect: { x1: ct.cx! - hw, x2: ct.cx! + hw,
                    y1: ct.cy! - ct.length! / 2 - M, y2: ct.cy! + ct.length! / 2 + M },
            axis: 'y',
          });
          continue;
        }
        // Oblique side lanes have no perpendicular grid crossing — keep hard.
        hard.push(...orientedBandRects(ct.cx!, ct.cy!, ct.angleDeg!, ct.length! + 2 * M, hw));
        continue;
      }
      // Legacy AABB shapes (no oriented fields).
      if (ct.vertical) {
        if (Number.isFinite(ct.y) && Number.isFinite(ct.minX) &&
            Number.isFinite(ct.maxX) && ct.maxX > ct.minX) {
          cross.push({
            rect: { x1: ct.y - hw, x2: ct.y + hw, y1: ct.minX - M, y2: ct.maxX + M },
            axis: 'y',
          });
        }
        continue;
      }
      if (Number.isFinite(ct.y) && Number.isFinite(ct.minX) &&
          Number.isFinite(ct.maxX) && ct.maxX > ct.minX) {
        cross.push({
          rect: { x1: ct.minX - M, x2: ct.maxX + M, y1: ct.y - hw, y2: ct.y + hw },
          axis: 'x',
        });
      }
      continue;
    }
    if (Number.isFinite(ct.cx) && Number.isFinite(ct.cy) &&
        Number.isFinite(ct.angleDeg) && Number.isFinite(ct.length) && ct.length! > 0) {
      const ax = nearAxis(ct.angleDeg!);
      if (ax === 'x') {
        hard.push({
          x1: ct.cx! - ct.length! / 2 - M, x2: ct.cx! + ct.length! / 2 + M,
          y1: ct.cy! - hw, y2: ct.cy! + hw,
        });
      } else if (ax === 'y') {
        hard.push({
          x1: ct.cx! - hw, x2: ct.cx! + hw,
          y1: ct.cy! - ct.length! / 2 - M, y2: ct.cy! + ct.length! / 2 + M,
        });
      } else {
        hard.push(...orientedBandRects(ct.cx!, ct.cy!, ct.angleDeg!, ct.length! + 2 * M, hw));
      }
    } else if (ct.vertical) {
      // Legacy vertical band: `y` holds the centerline X, minX/maxX the Y extents.
      if (!Number.isFinite(ct.y) || !Number.isFinite(ct.minX) ||
          !Number.isFinite(ct.maxX) || ct.maxX <= ct.minX) continue;
      hard.push({ x1: ct.y - hw, x2: ct.y + hw, y1: ct.minX - M, y2: ct.maxX + M });
    } else {
      if (!Number.isFinite(ct.y) || !Number.isFinite(ct.minX) ||
          !Number.isFinite(ct.maxX) || ct.maxX <= ct.minX) continue;
      hard.push({ x1: ct.minX - M, x2: ct.maxX + M, y1: ct.y - hw, y2: ct.y + hw });
    }
  }

  const FM = FUTURE_ZONE_KEEPOUT_MARGIN_FT;
  for (const z of design.reservedZones ?? []) {
    if (!z || z.kind !== 'futureAug') continue;
    if (!Number.isFinite(z.x) || !Number.isFinite(z.y) ||
        !Number.isFinite(z.length) || !Number.isFinite(z.width) ||
        z.length <= 0 || z.width <= 0) continue;
    if (z.angleDeg && nearAxis(z.angleDeg) === null) {
      hard.push(...orientedBandRects(z.x, z.y, z.angleDeg, z.length + 2 * FM, z.width / 2 + FM));
    } else if (z.angleDeg && nearAxis(z.angleDeg) === 'y') {
      hard.push({
        x1: z.x - z.width / 2 - FM, x2: z.x + z.width / 2 + FM,
        y1: z.y - z.length / 2 - FM, y2: z.y + z.length / 2 + FM,
      });
    } else {
      hard.push({
        x1: z.x - z.length / 2 - FM, x2: z.x + z.length / 2 + FM,
        y1: z.y - z.width / 2 - FM, y2: z.y + z.width / 2 + FM,
      });
    }
  }

  const t = design.trench;
  if (SHOW_YARD_AUX_TRENCH && t && Number.isFinite(t.x) && Number.isFinite(t.yBottom) &&
      Number.isFinite(t.yTop) && Number.isFinite(t.width) && t.width > 0 && t.yTop > t.yBottom) {
    const hw = t.width / 2 + M;
    cross.push({
      rect: { x1: t.x - hw, x2: t.x + hw, y1: t.yBottom, y2: t.yTop },
      axis: 'y',
    });
  }

  return { hard, cross };
}

// Gate-entrance keep-outs: an MV home run must never trench through the site
// entrance — the gate is the yard's one guaranteed-clear access, and an open
// feeder trench (or a buried bank) across it would close the entrance during
// construction and put the crossing under the highest-traffic pavement.
// Entrance-flagged traced roads contribute a gate-centered window (the record
// itself can be a 700+ ft perimeter strip — only the fence crossing is
// sacred); apron records contribute their drawn pavement bbox (the apron
// predicate already guarantees aprons are compact gate flares).
export const GATE_KEEPOUT_MARGIN_FT = 3;
export const GATE_KEEPOUT_REACH_FT = 40;
// An "apron" whose pavement bbox spans beyond this is a stale or mis-flagged
// record — fall back to the gate window instead of walling off a corridor.
const APRON_KEEPOUT_CAP_FT = 250;

/** Structural subset of a traced/custom road record (layout-edit shape). */
export interface GateRoadLike {
  pts?: Pt[];
  entrance?: boolean;
  apron?: boolean;
  gate?: Pt;
  surface?: Pt[];
  outline?: Pt[];
}

export function gateApronKeepouts(roads: readonly GateRoadLike[] | null | undefined): Rect[] {
  const out: Rect[] = [];
  const M = GATE_KEEPOUT_MARGIN_FT;
  for (const r of roads ?? []) {
    if (!r || (!r.entrance && !r.apron)) continue;
    let apronBoxed = false;
    if (r.apron) {
      const ring = (r.surface?.length ? r.surface : r.outline?.length ? r.outline : r.pts) ?? [];
      let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity, n = 0;
      for (const p of ring) {
        if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
        n++;
        if (p.x < x1) x1 = p.x; if (p.x > x2) x2 = p.x;
        if (p.y < y1) y1 = p.y; if (p.y > y2) y2 = p.y;
      }
      if (n >= 3 && x2 - x1 <= APRON_KEEPOUT_CAP_FT && y2 - y1 <= APRON_KEEPOUT_CAP_FT) {
        out.push({ x1: x1 - M, y1: y1 - M, x2: x2 + M, y2: y2 + M });
        apronBoxed = true;
      }
    }
    const g = r.gate;
    if (g && Number.isFinite(g.x) && Number.isFinite(g.y) && (r.entrance || !apronBoxed)) {
      const R = GATE_KEEPOUT_REACH_FT + M;
      out.push({ x1: g.x - R, y1: g.y - R, x2: g.x + R, y2: g.y + R });
    }
  }
  return out;
}

const EPS = 1e-6;
const inside = (p: Pt, r: Rect) =>
  p.x > r.x1 + EPS && p.x < r.x2 - EPS && p.y > r.y1 + EPS && p.y < r.y2 - EPS;

// Liang-Barsky: does the open interior of segment a→b enter the open
// interior of rect r (shrunk by EPS) for more than `minLen` ft? Catches
// oblique (diagonal) passes that the axis-aligned overlap tests miss.
function segInteriorSpan(a: Pt, b: Pt, r: Rect, minLen: number): boolean {
  const dx = b.x - a.x, dy = b.y - a.y;
  let t0 = 0, t1 = 1;
  const pk = [-dx, dx, -dy, dy];
  const qk = [a.x - (r.x1 + EPS), (r.x2 - EPS) - a.x, a.y - (r.y1 + EPS), (r.y2 - EPS) - a.y];
  for (let k = 0; k < 4; k++) {
    if (Math.abs(pk[k]) < 1e-12) { if (qk[k] < 0) return false; continue; }
    const t = qk[k] / pk[k];
    if (pk[k] < 0) { if (t > t0) t0 = t; } else { if (t < t1) t1 = t; }
  }
  return t0 < t1 && (t1 - t0) * Math.hypot(dx, dy) > minLen;
}

/**
 * Count co-run violations of a polyline against crossable bands:
 *  - a vertex INSIDE a band (the route turns or terminates in the trench);
 *  - a segment PARALLEL to the band's run axis overlapping the band interior
 *    for more than a foot (riding along inside the trench);
 *  - a DIAGONAL segment passing through the band interior (an oblique
 *    crossing is never perpendicular, so any real overlap is a violation).
 * A perpendicular pass straight through is legal and never counted.
 */
export function bandCoRunViolations(pts: Pt[], bands: CrossBand[]): number {
  if (!bands.length || pts.length < 2) return 0;
  let n = 0;
  // CAD-traced rows carry harmless sub-degree survey skew. Use the same
  // half-degree axis tolerance as keep-out construction so a row collector
  // crossing a spine at 89.6° is not misclassified as an oblique co-run.
  const axisSlope = Math.tan(0.5 * Math.PI / 180);
  for (const band of bands) {
    const r = band.rect;
    for (let i = 1; i < pts.length - 1; i++) {
      if (inside(pts[i], r)) n++;
    }
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      const dx = Math.abs(a.x - b.x), dy = Math.abs(a.y - b.y);
      const alongY = dy > EPS && dx <= Math.max(EPS, dy * axisSlope);
      const alongX = dx > EPS && dy <= Math.max(EPS, dx * axisSlope);
      const diagonal = !alongX && !alongY && dx > EPS && dy > EPS;
      if (diagonal && segInteriorSpan(a, b, r, 0.1)) { n++; continue; }
      if (band.axis === 'y' && alongY) {
        if (a.x > r.x1 + EPS && a.x < r.x2 - EPS) {
          const lo = Math.max(Math.min(a.y, b.y), r.y1), hi = Math.min(Math.max(a.y, b.y), r.y2);
          if (hi - lo > 1) n++;
        }
      } else if (band.axis === 'x' && alongX) {
        if (a.y > r.y1 + EPS && a.y < r.y2 - EPS) {
          const lo = Math.max(Math.min(a.x, b.x), r.x1), hi = Math.min(Math.max(a.x, b.x), r.x2);
          if (hi - lo > 1) n++;
        }
      }
    }
  }
  return n;
}

/** Crossable bands running PARALLEL to `axis`, as plain obstacle rects —
 *  used where a leg rides along `axis` and must not share the trench. */
export function parallelCrossRects(bands: CrossBand[], axis: 'x' | 'y'): Rect[] {
  return bands.filter(b => b.axis === axis).map(b => b.rect);
}

/**
 * Crossable bands as obstacle rects with PERPENDICULAR crossing windows cut
 * out at the anchor points' coordinates — hands the grid router "you may
 * cross here, straight through" geometry. Anchors are the endpoints of the
 * leg being rerouted; each contributes one window on every band.
 */
export function gappedCrossRects(bands: CrossBand[], anchors: Pt[], gapFt: number = SPINE_CROSS_GAP_FT): Rect[] {
  const out: Rect[] = [];
  for (const band of bands) {
    const r = band.rect;
    const lo = band.axis === 'y' ? r.y1 : r.x1;
    const hi = band.axis === 'y' ? r.y2 : r.x2;
    const windows = anchors
      .map(p => (band.axis === 'y' ? p.y : p.x))
      .filter(c => Number.isFinite(c) && c + gapFt > lo && c - gapFt < hi)
      .sort((a, b) => a - b);
    let cur = lo;
    const push = (s: number, e: number) => {
      if (e - s < 0.5) return;
      out.push(band.axis === 'y'
        ? { x1: r.x1, x2: r.x2, y1: s, y2: e }
        : { x1: s, x2: e, y1: r.y1, y2: r.y2 });
    };
    for (const c of windows) {
      push(cur, Math.min(hi, c - gapFt));
      cur = Math.max(cur, c + gapFt);
    }
    push(cur, hi);
  }
  return out;
}

/** Nearest point on an aisle/road centerline. Used when an MV feeder must
 *  turn toward the drive aisle instead of crossing DC or another feeder. */
export function nearestRoadWaypoint(
  p: Pt,
  aisles: readonly {
    x: number; y: number; length: number; width: number; rotation: number;
  }[] | null | undefined,
): Pt | null {
  if (!aisles?.length) return null;
  let best: Pt | null = null;
  let bestD = Infinity;
  for (const a of aisles) {
    if (!a || !Number.isFinite(a.x) || !Number.isFinite(a.y) ||
        !Number.isFinite(a.length) || a.length <= 0) continue;
    const rot = Number.isFinite(a.rotation) ? a.rotation : 0;
    const cs = Math.cos(rot), sn = Math.sin(rot);
    const hx = cs * a.length / 2, hy = sn * a.length / 2;
    const a0 = { x: a.x - hx, y: a.y - hy };
    const dx = 2 * hx, dy = 2 * hy;
    const l2 = dx * dx + dy * dy;
    const t = l2 > 1e-9
      ? Math.max(0, Math.min(1, ((p.x - a0.x) * dx + (p.y - a0.y) * dy) / l2))
      : 0;
    const q = { x: a0.x + t * dx, y: a0.y + t * dy };
    const d = Math.hypot(p.x - q.x, p.y - q.y);
    if (d < bestD) { bestD = d; best = q; }
  }
  return best && bestD > 0.5 && bestD < 500 ? best : null;
}

/** Drop keep-out samples whose center sits inside any exemption (PCS skid). */
export function punchKeepoutRects(rects: Rect[], zones: Rect[]): Rect[] {
  if (!zones.length) return rects;
  return rects.filter(r => {
    const cx = (r.x1 + r.x2) / 2, cy = (r.y1 + r.y2) / 2;
    return !zones.some(z =>
      cx >= z.x1 && cx <= z.x2 && cy >= z.y1 && cy <= z.y2);
  });
}
