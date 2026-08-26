// Shared road callout placement: the exact same anchor/direction math feeds
// both the DXF export (addRoadCallouts) and the 3D preview (RoadCalloutLabels
// in DesignScene), so on-screen annotations always match the exported drawing.
// Pure geometry — no DXF or three.js dependencies.

import { RoadNetwork, RoadEdgeSeg } from './types';
import { CLEARANCES } from './catalog';

export type Pt2 = { x: number; y: number };

// Leader-style callout (turning radii): line from -> end, short horizontal
// landing end -> land, text placed on the `side` of the landing away from
// the site center (side +1 = text to the right of land, -1 = to the left).
export type RoadRadiusCallout = {
  from: Pt2;
  end: Pt2;
  land: Pt2;
  side: 1 | -1;
  text: string;
};

// Road width label: rotated text centered at (x, y), angle in degrees
// (already normalized to (-90, 90] for readability).
export type RoadWidthCallout = {
  x: number;
  y: number;
  angDeg: number;
  text: string;
};

export type RoadCalloutData = {
  radius: RoadRadiusCallout[];
  width: RoadWidthCallout | null;
};

// Midpoint of an arc segment along its actual sweep direction
export function arcMidpoint(seg: Extract<RoadEdgeSeg, { kind: 'arc' }>): Pt2 {
  const TAU = Math.PI * 2;
  const sweep = seg.ccw
    ? ((seg.end - seg.start) % TAU + TAU) % TAU
    : ((seg.start - seg.end) % TAU + TAU) % TAU;
  const mid = seg.ccw ? seg.start + sweep / 2 : seg.start - sweep / 2;
  return { x: seg.c.x + seg.r * Math.cos(mid), y: seg.c.y + seg.r * Math.sin(mid) };
}

// Compute the typical-radius leader callouts and the road width label for a
// road network. Returns null-ish parts when the network has no usable
// anchors (no straight outer segments / no fillet arcs).
export function roadCalloutData(road: RoadNetwork): RoadCalloutData | null {
  // Centroid of the outer edge path endpoints — used to point leaders outward
  const pts: Pt2[] = [];
  road.outer.forEach(s => { if (s.kind === 'line') { pts.push(s.a, s.b); } });
  if (!pts.length) return null;
  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;

  const radius: RoadRadiusCallout[] = [];
  const leader = (from: Pt2, dir: Pt2, len: number, text: string) => {
    const end = { x: from.x + dir.x * len, y: from.y + dir.y * len };
    const side: 1 | -1 = end.x >= cx ? 1 : -1;
    const land = { x: end.x + side * 6, y: end.y };
    radius.push({ from, end, land, side, text });
  };

  // Largest fillet arc on each edge gets a typical-radius callout
  const biggestArc = (segs: RoadEdgeSeg[]) => {
    let best: Extract<RoadEdgeSeg, { kind: 'arc' }> | null = null;
    for (const s of segs) if (s.kind === 'arc' && (!best || s.r > best.r)) best = s;
    return best;
  };

  const innerArc = biggestArc(road.islands.flat());
  if (innerArc) {
    const m = arcMidpoint(innerArc);
    const d = Math.hypot(m.x - cx, m.y - cy) || 1;
    const dir = { x: (m.x - cx) / d, y: (m.y - cy) / d };
    leader(m, dir, 35, `${Math.round(innerArc.r)}' INNER TURNING RADIUS (TYP)`);
  }

  const outerArc = biggestArc(road.outer);
  if (outerArc) {
    const m = arcMidpoint(outerArc);
    const d = Math.hypot(m.x - cx, m.y - cy) || 1;
    const dir = { x: (m.x - cx) / d, y: (m.y - cy) / d };
    leader(m, dir, 55, `${Math.round(outerArc.r)}' OUTER TURNING RADIUS (TYP)`);
  }

  // Road width label along the longest straight outer segment, rotated with
  // the road and placed inside the road band (between outer and inner edges)
  let width: RoadWidthCallout | null = null;
  let bestSeg: Extract<RoadEdgeSeg, { kind: 'line' }> | null = null;
  let bestLen = 0;
  for (const s of road.outer) {
    if (s.kind !== 'line') continue;
    const len = Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y);
    if (len > bestLen) { bestLen = len; bestSeg = s; }
  }
  if (bestSeg && bestLen > 40) {
    const mx = (bestSeg.a.x + bestSeg.b.x) / 2;
    const my = (bestSeg.a.y + bestSeg.b.y) / 2;
    const dx = (bestSeg.b.x - bestSeg.a.x) / bestLen;
    const dy = (bestSeg.b.y - bestSeg.a.y) / bestLen;
    // Inward normal: away from the outward direction from centroid
    let nx = -dy, ny = dx;
    if ((mx + nx - cx) ** 2 + (my + ny - cy) ** 2 > (mx - nx - cx) ** 2 + (my - ny - cy) ** 2) {
      nx = -nx; ny = -ny;
    }
    // Keep text horizontal-ish for readability
    let angDeg = (Math.atan2(dy, dx) * 180) / Math.PI;
    if (angDeg > 90) angDeg -= 180;
    if (angDeg <= -90) angDeg += 180;
    width = {
      x: mx + nx * 13,
      y: my + ny * 13,
      angDeg,
      // Register F-17: DRIVE PATH, never ROAD, in sheet-emitted text.
      text: `${CLEARANCES.roadWidth}' DRIVE PATH (TYP)`,
    };
  }

  return { radius, width };
}
