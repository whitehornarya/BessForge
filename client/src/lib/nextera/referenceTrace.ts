// ---------------------------------------------------------------------------
// Auto-fill a design from an imported KMZ reference drawing.
//
// Customer KMZs often already contain the designed yard: BESS container,
// PCS/inverter, aux and substation rectangles at real spacing, interior roads
// and a wide entrance road — with placemark/layer names identifying what each
// shape is ("road", "road 2", "bess container", "augmented inverter",
// "Generator", "substation for feeder area", ...). This module classifies the
// drawing's closed shapes by those names, fits a rectangle pose to each one,
// and produces a TracePlan the store can preview as ghosts and commit as real
// placed equipment + traced roads.
//
// Reference-wins rule: the drawn geometry is authoritative. Poses are taken
// exactly from the drawing (center + rotation + drawn dimensions); clearance
// or fence conflicts downstream become WARNINGS, never silent moves or drops.
// ---------------------------------------------------------------------------

import polygonClipping from 'polygon-clipping';
import { Pt } from './types';
import type { EquipmentKind } from './types';
import type { ImportedDrawing } from './kmz';
import { specForKind } from './catalog';

// Kinds a traced shape can resolve to. Aux kinds are included so a KMZ that
// draws them (or a drafter tag) lands them as real gear.
export type TraceEquipKind =
  | 'bess' | 'inverter' | 'generator' | 'conex' | 'manhole'
  | 'auxTransformer' | 'auxSwitchPanel' | 'fireControlPanel' | 'commsCabinet';

export type TraceClass =
  | { kind: 'road' }
  | { kind: 'equipment'; equip: TraceEquipKind; augmented: boolean; future?: boolean }
  | { kind: 'substation' }
  | { kind: 'boundary' } // parcel/area outlines — never equipment
  | { kind: 'ignore' }   // annotation linework — never geometry to fill from
  | null; // unknown — ask the drafter

// Name-driven classification of a placemark/layer name from the KML.
// Observed customer vocabulary: "road", "road 2", "bess container",
// "augmented container", "BESS Inverter", "augmented inverter",
// "DC-1 250MW", "Generator", "substation for feeder area".
export function classifyTraceName(name: string): TraceClass {
  const n = (name || '').toLowerCase().trim();
  if (!n || n === 'unnamed') return null;
  // Roads first: "SITE ACCESS" (the wide entrance road) must classify as a
  // road even though "site" alone would read as a parcel-scale name below.
  if (/\broads?\b|\broad\s*\d|access\s*road|entrance|site\s*access|driveway|street\s*cl|center\s*line|centerline|\be[\s-]*gate\b|\bgate\b/.test(n)) {
    return { kind: 'road' };
  }
  // Annotation layers: MV feeder label text, callout/leader linework and
  // cable "connector" runs describe the drawing, they are not yard geometry.
  // Filtering them by name keeps their strokes from pairing into phantom
  // thin roads or surfacing as unknown-shape prompts.
  // Guard: a layer that also names real yard gear ("FEEDER PCS", "BESS
  // CONNECTOR PADS") must fall through to the equipment rules below — only
  // pure annotation vocabulary is discarded.
  const namesEquipment =
    /\bpcs\b|inverter|bess|\bbatt|con+ex|container|man\s*hole|manhole|\bvault\b|generator|sub\s*station|substation|switchyard/.test(n);
  if (!namesEquipment &&
      /\bfeeder\b|callout|leader|annotation|\blabel|\btext\b|dimension|connector/.test(n)) {
    return { kind: 'ignore' };
  }
  // Easement / right-of-way linework and MV route centerlines: survey and
  // electrical reference layers (V-ESMT-…, X-EASE-T, "MV ROUTE 2"), never
  // yard geometry to fill from.
  if (!namesEquipment &&
      /esmt|easement|x-ease|right.?of.?way|\brow\b|mv\s*route|collector/.test(n)) {
    return { kind: 'ignore' };
  }
  // Survey reference layers: monuments, survey/right-of-way lines, parcel
  // linework (X-MONU, X-SURV-L, X-RTWY-L, X-PRCL-L).
  if (/monu|survey|x-surv|x-rtwy|x-prcl|parcel/.test(n)) {
    return { kind: 'ignore' };
  }
  if (/sub\s*station|substation|switchyard/.test(n)) return { kind: 'substation' };
  // Manholes / vaults are drawn at their real footprint — land them as plain
  // geometric blocks at the drawn dimensions.
  if (/man\s*hole|manhole|\bvault\b/.test(n)) {
    return { kind: 'equipment', equip: 'manhole', augmented: false };
  }
  // Area/parcel outlines: "DC-1 250MW", "phase 2", parcel/boundary/site names.
  if (/^dc[\s-]*\d/.test(n) || /\bphase\b|\bparcel\b|boundary|property\s*line|\bsite\b|easement/.test(n)) {
    return { kind: 'boundary' };
  }
  // CONEX / CONNEX storage boxes ("CONNEX BOXES (20'x10')", "CONEX BOXES /
  // (20' x 10') TYP") — plain rectangle blocks.
  if (/\bcon+ex\b/.test(n)) return { kind: 'equipment', equip: 'conex', augmented: false };
  if (/generator/.test(n)) return { kind: 'equipment', equip: 'generator', augmented: false };
  if (/aux(iliary)?\s*(power\s*)?(transformer|xfmr)/.test(n)) {
    return { kind: 'equipment', equip: 'auxTransformer', augmented: false };
  }
  if (/fire\s*(control\s*)?panel|facp/.test(n)) {
    return { kind: 'equipment', equip: 'fireControlPanel', augmented: false };
  }
  if (/aux(iliary)?\s*(distribution|switch|panel)/.test(n)) {
    return { kind: 'equipment', equip: 'auxSwitchPanel', augmented: false };
  }
  if (/comm(unication)?s?\s*cab(inet)?/.test(n)) {
    return { kind: 'equipment', equip: 'commsCabinet', augmented: false };
  }
  // "FUTURE ..." layers are capacity planned for a later build-out (drawn
  // yellow in customer packages); like augmentation reserve they import and
  // render but never count toward built MW/MWh. A name can be both ("FUTURE
  // AUGMENTATION") — future wins for display, both are excluded either way.
  const augmented = /augment/.test(n);
  const future = /future/.test(n);
  if (/inverter|\bpcs\b/.test(n)) {
    return { kind: 'equipment', equip: 'inverter', augmented, ...(future ? { future } : {}) };
  }
  if (/container|\bbess\b|battery/.test(n)) {
    return { kind: 'equipment', equip: 'bess', augmented, ...(future ? { future } : {}) };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Rectangle pose fit (minimum-area rectangle via rotating edge directions).
// ---------------------------------------------------------------------------

export interface RectPose {
  cx: number;
  cy: number;
  // degrees CCW; 0 = length along +x. Normalized to [0, 180).
  rotationDeg: number;
  lengthFt: number; // long side
  widthFt: number;  // short side
  areaSqFt: number; // polygon area (not rect area)
  fillRatio: number; // polygon area / rect area — 1.0 for a clean rectangle
}

function polyAreaFlat(flat: number[]): number {
  let a = 0;
  const n = flat.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += flat[2 * i] * flat[2 * j + 1] - flat[2 * j] * flat[2 * i + 1];
  }
  return a / 2;
}

// Min-area rectangle over the shape's convex hull, scanning hull edge
// directions (exact for polygons — the optimal rect shares a direction with a
// hull edge).
export function fitRectPose(flat: number[]): RectPose | null {
  const n = flat.length / 2;
  if (n < 3) return null;
  const pts: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const x = flat[2 * i], y = flat[2 * i + 1];
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    pts.push({ x, y });
  }
  const area = Math.abs(polyAreaFlat(flat));
  if (area < 1) return null;
  const hull = convexHull(pts);
  if (hull.length < 3) return null;

  let best: { angle: number; minX: number; maxX: number; minY: number; maxY: number; rectArea: number } | null = null;
  for (let i = 0; i < hull.length; i++) {
    const p = hull[i], q = hull[(i + 1) % hull.length];
    const angle = Math.atan2(q.y - p.y, q.x - p.x);
    const c = Math.cos(-angle), s = Math.sin(-angle);
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const h of hull) {
      const rx = h.x * c - h.y * s;
      const ry = h.x * s + h.y * c;
      if (rx < minX) minX = rx;
      if (rx > maxX) maxX = rx;
      if (ry < minY) minY = ry;
      if (ry > maxY) maxY = ry;
    }
    const rectArea = (maxX - minX) * (maxY - minY);
    if (!best || rectArea < best.rectArea) best = { angle, minX, maxX, minY, maxY, rectArea };
  }
  if (!best || best.rectArea < 1) return null;

  const w = best.maxX - best.minX;
  const h = best.maxY - best.minY;
  // Rect center back in world coordinates.
  const mx = (best.minX + best.maxX) / 2;
  const my = (best.minY + best.maxY) / 2;
  const c = Math.cos(best.angle), s = Math.sin(best.angle);
  const cx = mx * c - my * s;
  const cy = mx * s + my * c;

  // Length is the LONG side; rotate 90° when the frame's y-extent is longer.
  let rot = (best.angle * 180) / Math.PI;
  let lengthFt = w, widthFt = h;
  if (h > w) { lengthFt = h; widthFt = w; rot += 90; }
  rot = ((rot % 180) + 180) % 180; // a rectangle is symmetric under 180°
  return { cx, cy, rotationDeg: rot, lengthFt, widthFt, areaSqFt: area, fillRatio: area / best.rectArea };
}

function convexHull(pts: Pt[]): Pt[] {
  const s = [...pts].sort((a, b) => a.x - b.x || a.y - b.y);
  if (s.length < 3) return s;
  const cross = (o: Pt, a: Pt, b: Pt) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Pt[] = [];
  for (const p of s) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Pt[] = [];
  for (let i = s.length - 1; i >= 0; i--) {
    const p = s[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop(); upper.pop();
  return lower.concat(upper);
}

// ---------------------------------------------------------------------------
// Road strips from a road-named outline: centerline + width.
// ---------------------------------------------------------------------------

export interface TraceRoadStrip {
  pts: Pt[];       // centerline
  widthFt: number; // clamped to the drawable 12–60 ft range downstream
  // Drawn outline of a wide-to-narrow gate entrance flare (apron). When
  // present the committed road keeps this exact polygon as pavement surface
  // instead of a uniform-width strip, so the drawn taper survives the trace.
  outline?: Pt[];
  // Verbatim closed road outline (yard networks, aprons, parking pads).
  // Constant-width strip fitting loses the internal aisles of comb-style
  // yard networks, so a closed outline commits ONE record whose `surface`
  // is the drawn polygon itself; `pts` is only the representative
  // centerline used for picking, labels, and gate-crossing detection.
  surface?: Pt[];
}

// A polyline is a closed ring when its parse-time flag says so OR when its
// endpoints geometrically close (gap < 2 ft, n >= 4). Persisted drawings from
// older parser vintages baked `closedFlags` under older normalization rules,
// so every consumer must derive closure from geometry at analysis time —
// then any drawing vintage analyzes identically after a heal.
export function isClosedPolylineRun(flat: number[], flag?: boolean): boolean {
  if (flag) return true;
  const n = flat.length / 2;
  if (n < 4) return false;
  return Math.hypot(flat[0] - flat[2 * (n - 1)], flat[1] - flat[2 * (n - 1) + 1]) < 2;
}

export function entranceFlareStrip(flat: number[]): TraceRoadStrip | null {
  const n = flat.length / 2;
  if (n < 3 || n > 8) return null;
  // A closed TRIANGLE outline is annotation linework (SITE ACCESS turning
  // arrows), never a gate flare — regardless of how wide the taper reads.
  // KML rings repeat the first vertex to close, so count DISTINCT vertices.
  {
    let nv = n;
    if (nv > 1 && Math.hypot(flat[0] - flat[2 * (nv - 1)], flat[1] - flat[2 * (nv - 1) + 1]) < 1e-6) nv--;
    if (nv <= 3) return null;
  }
  const pose = fitRectPose(flat);
  if (!pose) return null;
  // A clean rectangle is an ordinary road; a flare under-fills its min-rect.
  if (pose.fillRatio >= 0.72) return null;
  if (pose.lengthFt < 20 || pose.lengthFt > 250) return null;
  if (pose.widthFt < 12 || pose.widthFt > 120) return null;
  // Convexity: flares are convex (triangle/trapezoid); bent L/T road
  // outlines are not, and must keep going through the strip pairing.
  {
    let sign = 0;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n, k = (i + 2) % n;
      const cx1 = flat[2 * j] - flat[2 * i], cy1 = flat[2 * j + 1] - flat[2 * i + 1];
      const cx2 = flat[2 * k] - flat[2 * j], cy2 = flat[2 * k + 1] - flat[2 * j + 1];
      const cr = cx1 * cy2 - cy1 * cx2;
      if (Math.abs(cr) < 1e-6) continue;
      if (sign === 0) sign = Math.sign(cr);
      else if (Math.sign(cr) !== sign) return null;
    }
  }
  const rad = (pose.rotationDeg * Math.PI) / 180;
  const dir = { x: Math.cos(rad), y: Math.sin(rad) };
  const nrm = { x: -dir.y, y: dir.x };
  // Cross-section span perpendicular to the long axis at fraction f (0..1).
  const span = (f: number): number => {
    const ox = pose.cx + dir.x * (f - 0.5) * pose.lengthFt;
    const oy = pose.cy + dir.y * (f - 0.5) * pose.lengthFt;
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ax = flat[2 * i], ay = flat[2 * i + 1];
      const bx = flat[2 * j], by = flat[2 * j + 1];
      const da = (ax - ox) * dir.x + (ay - oy) * dir.y;
      const db = (bx - ox) * dir.x + (by - oy) * dir.y;
      if (da === db || (da > 0) === (db > 0)) continue;
      const t = da / (da - db);
      const s = (ax + (bx - ax) * t - ox) * nrm.x + (ay + (by - ay) * t - oy) * nrm.y;
      if (s < lo) lo = s;
      if (s > hi) hi = s;
    }
    return hi > lo ? hi - lo : 0;
  };
  const wA = Math.max(span(0.1), span(0.2));
  const wB = Math.max(span(0.8), span(0.9));
  const wide = Math.max(wA, wB), narrow = Math.min(wA, wB);
  // Real taper: the wide end is drivable and clearly wider than the far end,
  // and the NARROW end is still a drivable gate throat (24'+). Annotation
  // arrows (turning-radius SITE ACCESS triangles) taper to a point — they are
  // not pavement and must never commit as a flare.
  if (narrow < 12) return null;
  if (wide < 12 || wide < Math.max(narrow, 1) * 1.5) return null;
  const hx = pose.lengthFt / 2;
  const endA = { x: pose.cx - dir.x * hx, y: pose.cy - dir.y * hx };
  const endB = { x: pose.cx + dir.x * hx, y: pose.cy + dir.y * hx };
  const outline: Pt[] = [];
  for (let i = 0; i < n; i++) outline.push({ x: flat[2 * i], y: flat[2 * i + 1] });
  return {
    // Centerline runs wide end -> narrow end (apron toward the yard).
    pts: wA >= wB ? [endA, endB] : [endB, endA],
    widthFt: Math.min(60, wide),
    outline,
  };
}
export function roadStripsFromOutline(flat: number[]): TraceRoadStrip[] {
  const pose = fitRectPose(flat);
  if (!pose) return [];
  // A closed TRIANGLE outline is annotation linework (SITE ACCESS turning
  // arrows), never pavement — drop it before any strip fitting. KML rings
  // repeat the first vertex to close, so count DISTINCT vertices.
  {
    let nv = flat.length / 2;
    if (nv > 1 && Math.hypot(flat[0] - flat[2 * (nv - 1)], flat[1] - flat[2 * (nv - 1) + 1]) < 1e-6) nv--;
    if (nv <= 3) return [];
  }
  if (pose.fillRatio >= 0.72) {
    const rad = (pose.rotationDeg * Math.PI) / 180;
    const hx = pose.lengthFt / 2;
    const dir = { x: Math.cos(rad), y: Math.sin(rad) };
    return [{
      pts: [
        { x: pose.cx - dir.x * hx, y: pose.cy - dir.y * hx },
        { x: pose.cx + dir.x * hx, y: pose.cy + dir.y * hx },
      ],
      widthFt: pose.widthFt,
    }];
  }

  // Constant-width estimate for a long thin region: A ≈ w * (P/2 - w) —
  // solve; falls back to half the min-rect short side heuristics.
  const n = flat.length / 2;
  let perim = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    perim += Math.hypot(flat[2 * j] - flat[2 * i], flat[2 * j + 1] - flat[2 * i + 1]);
  }
  const halfP = perim / 2;
  const disc = halfP * halfP - 4 * pose.areaSqFt;
  const width = disc > 0 ? (halfP - Math.sqrt(disc)) / 2 : pose.widthFt;

  // Long edge runs: consecutive collinear-ish edges merged, kept when the
  // run is meaningfully longer than the road width.
  interface Run { a: Pt; b: Pt; dir: Pt; len: number }
  const runs: Run[] = [];
  let start = 0;
  const edgeDir = (i: number): Pt => {
    const j = (i + 1) % n;
    const dx = flat[2 * j] - flat[2 * i], dy = flat[2 * j + 1] - flat[2 * i + 1];
    const l = Math.hypot(dx, dy) || 1;
    return { x: dx / l, y: dy / l };
  };
  const pushRun = (i0: number, i1: number) => {
    const a = { x: flat[2 * i0], y: flat[2 * i0 + 1] };
    const bIdx = (i1 + 1) % n;
    const b = { x: flat[2 * bIdx], y: flat[2 * bIdx + 1] };
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len > Math.max(width * 1.5, 20)) {
      runs.push({ a, b, dir: { x: (b.x - a.x) / len, y: (b.y - a.y) / len }, len });
    }
  };
  for (let i = 1; i <= n; i++) {
    const d0 = edgeDir(start), d1 = edgeDir(i % n);
    const dot = d0.x * d1.x + d0.y * d1.y;
    if (i === n || dot < 0.985) { // > ~10° bend ends the run
      pushRun(start, i - 1);
      start = i % n;
    }
  }

  // Pair each run with the closest antiparallel run at roughly width apart;
  // midline of the overlapping extent is a centerline leg.
  const used = new Set<number>();
  const legs: { a: Pt; b: Pt }[] = [];
  for (let i = 0; i < runs.length; i++) {
    if (used.has(i)) continue;
    let bestJ = -1, bestGap = Infinity;
    for (let j = 0; j < runs.length; j++) {
      if (j === i || used.has(j)) continue;
      const dot = runs[i].dir.x * runs[j].dir.x + runs[i].dir.y * runs[j].dir.y;
      if (dot > -0.985) continue; // must be antiparallel (opposite winding side)
      // Perpendicular separation via midpoint distance projected off-axis.
      const mi = { x: (runs[i].a.x + runs[i].b.x) / 2, y: (runs[i].a.y + runs[i].b.y) / 2 };
      const mj = { x: (runs[j].a.x + runs[j].b.x) / 2, y: (runs[j].a.y + runs[j].b.y) / 2 };
      const dx = mj.x - mi.x, dy = mj.y - mi.y;
      const perp = Math.abs(dx * -runs[i].dir.y + dy * runs[i].dir.x);
      const along = Math.abs(dx * runs[i].dir.x + dy * runs[i].dir.y);
      if (perp < width * 0.4 || perp > width * 2.5) continue;
      if (along > (runs[i].len + runs[j].len) / 2) continue; // no overlap
      if (perp < bestGap) { bestGap = perp; bestJ = j; }
    }
    if (bestJ < 0) continue;
    used.add(i); used.add(bestJ);
    const r = runs[i], o = runs[bestJ];
    // Project o's endpoints onto r's axis to find the shared extent.
    const proj = (p: Pt) => (p.x - r.a.x) * r.dir.x + (p.y - r.a.y) * r.dir.y;
    const t0 = Math.max(0, Math.min(proj(o.a), proj(o.b)));
    const t1 = Math.min(r.len, Math.max(proj(o.a), proj(o.b)));
    if (t1 - t0 < width) continue;
    const off = bestGap / 2;
    // Midline sits halfway toward the paired run.
    const mi = { x: (r.a.x + r.b.x) / 2, y: (r.a.y + r.b.y) / 2 };
    const mj = { x: (o.a.x + o.b.x) / 2, y: (o.a.y + o.b.y) / 2 };
    const toOther = { x: mj.x - mi.x, y: mj.y - mi.y };
    const nrm = { x: -r.dir.y, y: r.dir.x };
    const sign = toOther.x * nrm.x + toOther.y * nrm.y >= 0 ? 1 : -1;
    legs.push({
      a: { x: r.a.x + r.dir.x * t0 + nrm.x * off * sign, y: r.a.y + r.dir.y * t0 + nrm.y * off * sign },
      b: { x: r.a.x + r.dir.x * t1 + nrm.x * off * sign, y: r.a.y + r.dir.y * t1 + nrm.y * off * sign },
    });
  }
  // A long edge run that never found an antiparallel partner is still real
  // pavement on a CLOSED outline. A comb-shaped road (parallel aisles joined
  // by one spine, Big Iron Area 2) has a spine whose inner side is only the
  // short diagonal aisle-mouth edges — pairing finds nothing, the spine
  // vanished, and the traced yard kept three disconnected aisles plus a
  // dead-end fragment. Keep such a run as a centerline leg inset half a
  // width toward the outline's interior (point-in-polygon probe: centroid
  // heuristics flip on concave combs).
  for (let i = 0; i < runs.length; i++) {
    if (used.has(i)) continue;
    const r = runs[i];
    if (r.len < width * 2.5) continue;
    const nrm = { x: -r.dir.y, y: r.dir.x };
    const mp = { x: (r.a.x + r.b.x) / 2, y: (r.a.y + r.b.y) / 2 };
    const inAt = (s: number) =>
      pointInFlatPoly(flat, mp.x + nrm.x * s * width * 0.5, mp.y + nrm.y * s * width * 0.5);
    const sign = inAt(1) ? 1 : inAt(-1) ? -1 : 0;
    if (!sign) continue;
    const off = (sign * width) / 2;
    legs.push({
      a: { x: r.a.x + nrm.x * off, y: r.a.y + nrm.y * off },
      b: { x: r.b.x + nrm.x * off, y: r.b.y + nrm.y * off },
    });
  }

  // T-junction snap: a leg that stops just short of another leg's centerline
  // (comb aisles end at the spine's tapered mouth, ~2 widths shy) extends
  // along its OWN axis until it meets that centerline, so the committed
  // strips union into one connected road instead of leaving a gap at every
  // junction. Parallel legs never intersect, so duplicates are untouched.
  const T_REACH = width * 2.2;
  for (let i = 0; i < legs.length; i++) {
    for (const end of [0, 1] as const) {
      const p = end === 0 ? legs[i].a : legs[i].b;
      const q = end === 0 ? legs[i].b : legs[i].a;
      const dl = Math.hypot(p.x - q.x, p.y - q.y) || 1;
      const d = { x: (p.x - q.x) / dl, y: (p.y - q.y) / dl }; // outward
      let bestT = Infinity, bestPt: Pt | null = null;
      for (let j = 0; j < legs.length; j++) {
        if (j === i) continue;
        const o = legs[j];
        const e = { x: o.b.x - o.a.x, y: o.b.y - o.a.y };
        const eLen = Math.hypot(e.x, e.y) || 1;
        const cross = d.x * e.y - d.y * e.x;
        if (Math.abs(cross) < 1e-6) continue; // parallel
        const wx = o.a.x - p.x, wy = o.a.y - p.y;
        const t = (wx * e.y - wy * e.x) / cross;        // along own outward axis
        const s = (wx * d.y - wy * d.x) / cross;        // along other leg
        if (t <= 0 || t > T_REACH) continue;
        if (s < -width || s > eLen + width) continue;
        if (t < bestT) {
          bestT = t;
          bestPt = { x: p.x + d.x * t, y: p.y + d.y * t };
        }
      }
      if (bestPt) {
        if (end === 0) legs[i].a = bestPt; else legs[i].b = bestPt;
      }
    }
  }

  if (!legs.length) {
    // Fallback: one strip along the min-rect axis so the drawn road is never
    // silently dropped (reference wins; the drafter can adjust afterwards).
    const rad = (pose.rotationDeg * Math.PI) / 180;
    const hx = pose.lengthFt / 2;
    const dir = { x: Math.cos(rad), y: Math.sin(rad) };
    return [{
      pts: [
        { x: pose.cx - dir.x * hx, y: pose.cy - dir.y * hx },
        { x: pose.cx + dir.x * hx, y: pose.cy + dir.y * hx },
      ],
      widthFt: width,
    }];
  }

  // Chain legs whose endpoints meet (within 1.5 widths) into polylines so an
  // L-shaped road commits as ONE road, meeting at the corner.
  const strips: TraceRoadStrip[] = [];
  const legUsed = new Set<number>();
  const near = (p: Pt, q: Pt) => Math.hypot(p.x - q.x, p.y - q.y) <= width * 1.5;
  for (let i = 0; i < legs.length; i++) {
    if (legUsed.has(i)) continue;
    legUsed.add(i);
    const chain: Pt[] = [legs[i].a, legs[i].b];
    let extended = true;
    while (extended) {
      extended = false;
      for (let j = 0; j < legs.length; j++) {
        if (legUsed.has(j)) continue;
        const head = chain[0], tail = chain[chain.length - 1];
        const { a, b } = legs[j];
        // Join at the meeting corner (midpoint of the two near ends), then
        // continue with the far end of the new leg.
        if (near(tail, a)) { chain[chain.length - 1] = mid(tail, a); chain.push(b); }
        else if (near(tail, b)) { chain[chain.length - 1] = mid(tail, b); chain.push(a); }
        else if (near(head, a)) { chain[0] = mid(head, a); chain.unshift(b); }
        else if (near(head, b)) { chain[0] = mid(head, b); chain.unshift(a); }
        else continue;
        legUsed.add(j);
        extended = true;
        break;
      }
    }
    strips.push({ pts: dedupePts(chain), widthFt: width });
  }
  return strips;
}

// ---------------------------------------------------------------------------
// Road strips from OPEN linework. CAD exports frequently draw roads as loose
// edge lines (two parallel LineStrings per road) or as bare centerlines
// ("street cl", "CENTERLINE") rather than closed outlines. Pair antiparallel
// long runs into centerline legs (midline, width = gap); long runs that never
// find a partner are kept as centerlines at the default road width, so a
// drawn road is never silently dropped.
// ---------------------------------------------------------------------------

const OPEN_ROAD_DEFAULT_WIDTH_FT = 24;
const OPEN_ROAD_MIN_GAP_FT = 8;
const OPEN_ROAD_MAX_GAP_FT = 100;
const OPEN_ROAD_MIN_RUN_FT = 40;

export function roadStripsFromOpenLines(flats: number[][]): TraceRoadStrip[] {
  interface Run { a: Pt; b: Pt; dir: Pt; len: number }
  const runs: Run[] = [];
  for (const flat of flats) {
    const n = flat.length / 2;
    if (n < 2) continue;
    // Merge consecutive near-collinear edges into straight runs.
    let s0 = 0;
    const flush = (i0: number, i1: number) => {
      const a = { x: flat[2 * i0], y: flat[2 * i0 + 1] };
      const b = { x: flat[2 * i1], y: flat[2 * i1 + 1] };
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len >= OPEN_ROAD_MIN_RUN_FT) {
        runs.push({ a, b, dir: { x: (b.x - a.x) / len, y: (b.y - a.y) / len }, len });
      }
    };
    const dirAt = (i: number): Pt | null => {
      const dx = flat[2 * (i + 1)] - flat[2 * i], dy = flat[2 * (i + 1) + 1] - flat[2 * i + 1];
      const l = Math.hypot(dx, dy);
      return l > 0.5 ? { x: dx / l, y: dy / l } : null;
    };
    let prev: Pt | null = null;
    for (let i = 0; i < n - 1; i++) {
      const d = dirAt(i);
      if (!d) continue;
      if (prev && (d.x * prev.x + d.y * prev.y) < 0.985) {
        flush(s0, i);
        s0 = i;
      }
      prev = d;
    }
    flush(s0, n - 1);
  }

  // Pair each run with the closest antiparallel OR parallel run at a
  // road-plausible gap (loose edge lines may share or oppose direction).
  const used = new Set<number>();
  const legs: { a: Pt; b: Pt; width: number }[] = [];
  for (let i = 0; i < runs.length; i++) {
    if (used.has(i)) continue;
    let bestJ = -1, bestGap = Infinity;
    for (let j = 0; j < runs.length; j++) {
      if (j === i || used.has(j)) continue;
      const dot = runs[i].dir.x * runs[j].dir.x + runs[i].dir.y * runs[j].dir.y;
      if (Math.abs(dot) < 0.985) continue;
      const mi = { x: (runs[i].a.x + runs[i].b.x) / 2, y: (runs[i].a.y + runs[i].b.y) / 2 };
      const mj = { x: (runs[j].a.x + runs[j].b.x) / 2, y: (runs[j].a.y + runs[j].b.y) / 2 };
      const dx = mj.x - mi.x, dy = mj.y - mi.y;
      const perp = Math.abs(dx * -runs[i].dir.y + dy * runs[i].dir.x);
      const along = Math.abs(dx * runs[i].dir.x + dy * runs[i].dir.y);
      if (perp < OPEN_ROAD_MIN_GAP_FT || perp > OPEN_ROAD_MAX_GAP_FT) continue;
      if (along > (runs[i].len + runs[j].len) / 2) continue; // no overlap
      if (perp < bestGap) { bestGap = perp; bestJ = j; }
    }
    if (bestJ < 0) continue;
    used.add(i); used.add(bestJ);
    const r = runs[i], o = runs[bestJ];
    const proj = (p: Pt) => (p.x - r.a.x) * r.dir.x + (p.y - r.a.y) * r.dir.y;
    const t0 = Math.max(0, Math.min(proj(o.a), proj(o.b)));
    const t1 = Math.min(r.len, Math.max(proj(o.a), proj(o.b)));
    if (t1 - t0 < bestGap) continue;
    const mi = { x: (r.a.x + r.b.x) / 2, y: (r.a.y + r.b.y) / 2 };
    const mj = { x: (o.a.x + o.b.x) / 2, y: (o.a.y + o.b.y) / 2 };
    const nrm = { x: -r.dir.y, y: r.dir.x };
    const sign = (mj.x - mi.x) * nrm.x + (mj.y - mi.y) * nrm.y >= 0 ? 1 : -1;
    const off = bestGap / 2;
    legs.push({
      a: { x: r.a.x + r.dir.x * t0 + nrm.x * off * sign, y: r.a.y + r.dir.y * t0 + nrm.y * off * sign },
      b: { x: r.a.x + r.dir.x * t1 + nrm.x * off * sign, y: r.a.y + r.dir.y * t1 + nrm.y * off * sign },
      width: bestGap,
    });
  }
  // Unpaired long runs are centerlines at the default width.
  for (let i = 0; i < runs.length; i++) {
    if (used.has(i)) continue;
    if (runs[i].len < OPEN_ROAD_MIN_RUN_FT * 2) continue;
    legs.push({ a: runs[i].a, b: runs[i].b, width: OPEN_ROAD_DEFAULT_WIDTH_FT });
  }

  // Chain legs of similar width whose endpoints meet, so a bent road commits
  // as ONE polyline (same policy as the closed-outline tracer).
  const strips: TraceRoadStrip[] = [];
  const legUsed = new Set<number>();
  for (let i = 0; i < legs.length; i++) {
    if (legUsed.has(i)) continue;
    legUsed.add(i);
    const chain: Pt[] = [legs[i].a, legs[i].b];
    let width = legs[i].width;
    let count = 1;
    let extended = true;
    while (extended) {
      extended = false;
      for (let j = 0; j < legs.length; j++) {
        if (legUsed.has(j)) continue;
        if (Math.abs(legs[j].width - width) > Math.max(width, legs[j].width) * 0.5) continue;
        const near = (p: Pt, q: Pt) => Math.hypot(p.x - q.x, p.y - q.y) <= Math.max(width, legs[j].width) * 1.5;
        const head = chain[0], tail = chain[chain.length - 1];
        const { a, b } = legs[j];
        if (near(tail, a)) { chain[chain.length - 1] = mid(tail, a); chain.push(b); }
        else if (near(tail, b)) { chain[chain.length - 1] = mid(tail, b); chain.push(a); }
        else if (near(head, a)) { chain[0] = mid(head, a); chain.unshift(b); }
        else if (near(head, b)) { chain[0] = mid(head, b); chain.unshift(a); }
        else continue;
        legUsed.add(j);
        width = (width * count + legs[j].width) / (count + 1);
        count++;
        extended = true;
        break;
      }
    }
    const pts = dedupePts(chain);
    if (pts.length >= 2) strips.push({ pts, widthFt: width });
  }
  return strips;
}

function mid(p: Pt, q: Pt): Pt { return { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 }; }

// Even-odd point-in-polygon on a flat [x0,y0,x1,y1,...] ring.
function pointInFlatPoly(flat: number[], x: number, y: number): boolean {
  const n = flat.length / 2;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = flat[2 * i], yi = flat[2 * i + 1];
    const xj = flat[2 * j], yj = flat[2 * j + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function dedupePts(pts: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) > 1) out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Trace plan: everything the auto-fill found, ready for preview + commit.
// ---------------------------------------------------------------------------

export interface TraceItem {
  layerName: string;
  kind: TraceEquipKind;
  augmented: boolean;
  // Future build-out units (e.g. "FUTURE AUGMENTATION" layers): imported and
  // rendered, excluded from built-capacity rollups like augmented ones.
  future?: boolean;
  pose: RectPose;
}

export interface TraceRoad {
  layerName: string;
  strips: TraceRoadStrip[];
}

export interface TraceUnknown {
  layerName: string;
  pose: RectPose;
  // Size-based suggestion, preselected in the tagging prompt.
  suggested: TraceEquipKind | 'road' | 'ignore';
  // The drafter's answer; starts as the suggestion.
  tag: TraceEquipKind | 'road' | 'ignore';
}

export interface TracePlan {
  items: TraceItem[];
  roads: TraceRoad[];
  unknowns: TraceUnknown[];
  substations: { layerName: string; pose: RectPose }[];
  // Aux kinds the KMZ does not contain — the drafter is offered manual
  // placement for each of these.
  missingAux: TraceEquipKind[];
  ignoredLayers: string[]; // boundary/parcel-scale layers skipped on purpose
  // Site AC rating (MW) declared by the drawing itself: the sum of MW figures
  // baked into area/annotation layer names (e.g. "DC-1 250MW" + "DC-2 250MW"
  // = 500). When present, the traced yards' achieved MW is pro-rated against
  // this POI figure instead of the catalog block rating, so a delivered
  // package reports the capacity its own title block promises.
  sitePoiMW?: number;
}

const AUX_TRACE_KINDS: TraceEquipKind[] = [
  'auxTransformer', 'fireControlPanel', 'auxSwitchPanel', 'commsCabinet',
];

// Equipment-scale plausibility window (sq ft of the fitted rect footprint).
// A comms cabinet is ~10 sq ft; a substation yard is ~100k+. Shapes far
// outside the window are parcel outlines or stray CAD dots, not equipment.
const EQUIP_MIN_SQFT = 4;
const EQUIP_MAX_SQFT = 12000;

// Suggest a kind for an unclassified rectangle from its drawn size, matching
// against the real catalog footprints (best relative-dimension fit).
export function suggestKindForPose(pose: RectPose): TraceUnknown['suggested'] {
  // Long, thin, road-width shapes read as roads.
  if (pose.widthFt >= 10 && pose.widthFt <= 60 && pose.lengthFt >= pose.widthFt * 4) return 'road';
  const candidates: TraceEquipKind[] = [
    'bess', 'inverter', 'conex', 'auxTransformer', 'auxSwitchPanel', 'fireControlPanel', 'commsCabinet',
  ];
  let best: TraceEquipKind | null = null;
  let bestScore = Infinity;
  for (const k of candidates) {
    const dims = k === 'conex' ? CONEX_DIMS : specForKind(k)?.dims;
    if (!dims) continue;
    const l = Math.max(dims.length, dims.width);
    const w = Math.min(dims.length, dims.width);
    const score = Math.abs(Math.log(pose.lengthFt / l)) + Math.abs(Math.log(pose.widthFt / w));
    if (score < bestScore) { bestScore = score; best = k; }
  }
  // A shape less than ~35% off both catalog dims is a credible match;
  // anything else defaults to ignore so junk shapes need no attention.
  return best && bestScore < 0.6 ? best : 'ignore';
}

// Scan an imported reference drawing and build the auto-fill plan. Only
// CLOSED shapes participate (equipment pads and road outlines close); the
// tens of thousands of open linework runs in a CAD export stay reference-only.
export function analyzeReferenceDrawing(drawing: ImportedDrawing): TracePlan {
  const items: TraceItem[] = [];
  const roads: TraceRoad[] = [];
  const unknowns: TraceUnknown[] = [];
  const substations: { layerName: string; pose: RectPose }[] = [];
  const ignoredLayers = new Set<string>();

  for (const layer of drawing.layers) {
    const cls = classifyTraceName(layer.name);
    if (cls?.kind === 'boundary' || cls?.kind === 'ignore') { ignoredLayers.add(layer.name); continue; }
    const closed: number[][] = [];
    const open: number[][] = [];
    for (let i = 0; i < layer.polylines.length; i++) {
      if (isClosedPolylineRun(layer.polylines[i], layer.closedFlags[i])) closed.push(layer.polylines[i]);
      else open.push(layer.polylines[i]);
    }

    if (cls?.kind === 'road') {
      // Closed road outlines carry the drawn width; open linework (loose
      // edge-line pairs and bare centerlines) is paired into strips too, so
      // roads exported as LineStrings are captured instead of dropped.
      //
      // Sheets often draw the same road network outline TWICE (an exact
      // repeat, or a near-identical re-trace). Dedupe before committing or
      // the same pavement lands as several stacked road records.
      const ringOf = (flat: number[]): Pt[] => {
        const r: Pt[] = [];
        for (let i = 0; i + 1 < flat.length; i += 2) r.push({ x: flat[i], y: flat[i + 1] });
        // CAD exports repeat the first vertex to close a ring — the zero-
        // length final edge trips polygon boolean libraries, so drop it.
        while (r.length > 3 &&
               Math.hypot(r[0].x - r[r.length - 1].x, r[0].y - r[r.length - 1].y) < 1e-6) r.pop();
        return r;
      };
      const ringArea = (r: Pt[]): number => {
        let a = 0;
        for (let i = 0; i < r.length; i++) {
          const p = r[i], q = r[(i + 1) % r.length];
          a += p.x * q.y - q.x * p.y;
        }
        return Math.abs(a) / 2;
      };
      const seenKeys = new Set<string>();
      const keptRings: Pt[][] = [];
      const uniqClosed: number[][] = [];
      for (const flat of closed) {
        const ring = ringOf(flat);
        // Exact repeat: same quantized vertex set.
        const key = ring.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).sort().join('|');
        if (seenKeys.has(key)) continue;
        // Near-duplicate re-trace: >=90% of the smaller polygon is covered
        // by an already-kept outline.
        const a = ringArea(ring);
        let dup = false;
        if (a > 0) {
          for (const kept of keptRings) {
            const ka = ringArea(kept);
            if (Math.abs(ka - a) > Math.min(ka, a) * 2) continue; // area too different to overlap 90%
            try {
              const inter = polygonClipping.intersection(
                [ring.map(p => [p.x, p.y] as [number, number])],
                [kept.map(p => [p.x, p.y] as [number, number])]
              ) as [number, number][][][];
              let ia = 0;
              for (const poly of inter) for (const rr of poly) {
                let s2 = 0;
                for (let i = 0; i < rr.length; i++) {
                  const p = rr[i], q = rr[(i + 1) % rr.length];
                  s2 += p[0] * q[1] - q[0] * p[1];
                }
                ia += Math.abs(s2) / 2;
              }
              if (ia >= Math.min(a, ka) * 0.9) { dup = true; break; }
            } catch { /* malformed ring — treat as unique */ }
          }
        }
        if (dup) continue;
        seenKeys.add(key);
        keptRings.push(ring);
        uniqClosed.push(flat);
      }
      const stripLen = (pts: Pt[]): number => {
        let L = 0;
        for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
        return L;
      };
      // Closed distinct-3 triangles never fit as strips (annotation-arrow
      // rejection inside the fitters) — remember them; a second pass below
      // re-admits the ones that are pavement infill.
      const isTriangleRing = (flat: number[]): boolean => {
        let nv = flat.length / 2;
        if (nv > 1 && Math.hypot(flat[0] - flat[2 * (nv - 1)], flat[1] - flat[2 * (nv - 1) + 1]) < 1e-6) nv--;
        return nv <= 3;
      };
      const triCandidates = uniqClosed.filter(isTriangleRing);
      // Wide-to-narrow entrance flares keep their drawn outline verbatim.
      // Every other closed outline commits ONE record whose `surface` is
      // the drawn polygon itself — constant-width strip fitting loses the
      // internal aisles of comb-style yard networks. The most-branched
      // fitted strip rides along as the representative centerline
      // (picking, labels, gate-crossing detection).
      const closedStrips: TraceRoadStrip[] = [];
      for (const flat of uniqClosed) {
        const flare = entranceFlareStrip(flat);
        if (flare) { closedStrips.push(flare); continue; }
        const fitted = roadStripsFromOutline(flat);
        if (!fitted.length) continue;
        const rep = fitted.reduce((a, b) =>
          b.pts.length > a.pts.length ||
          (b.pts.length === a.pts.length && stripLen(b.pts) > stripLen(a.pts)) ? b : a);
        closedStrips.push({ pts: rep.pts, widthFt: rep.widthFt, surface: ringOf(flat) });
      }
      const strips = [
        ...closedStrips,
        ...roadStripsFromOpenLines(open),
      ].filter(s =>
        // Plausible drivable widths only: dimension/annotation linework on
        // road layers pairs into 1-3 ft slivers, gate tick marks into ~7 ft
        // stubs, and giant parcel outlines into several-hundred-ft "roads".
        s.widthFt >= 8 && s.widthFt <= 100
      );
      // Pavement infill wedges: a small closed triangle on the SAME layer is
      // a drawn corner patch ONLY when it fills the notch BETWEEN two
      // accepted pavement pieces (Big Iron Area 2 draws two of these at the
      // gate throat, tying the gate piece to the yard road ring). Admission
      // is deliberately strict, and purely geometric:
      //   1. some triangle edge >= 5 ft long lies COLLINEAR on an accepted
      //      pavement ring (both endpoints and its midpoint within 1 ft) —
      //      a drawn infill always continues a road edge;
      //   2. the triangle BRIDGES two distinct rings (>= 2 vertices within
      //      1 ft of each) — annotation arrows touch at most one road edge,
      //      so mid-network flush arrows stay annotation;
      //   3. the union with the target must come back as ONE polygon.
      // Free-standing SITE ACCESS turning arrows hit zero rings; flush
      // arrows hit one; short-based or corner-cutting shapes fail (1).
      // The merge target is the most-shared ring, tie to the smaller one
      // (the gate piece rather than the yard comb) so gate pavement stays
      // one record.
      const distToSeg = (p: Pt, a: Pt, b: Pt): number => {
        const dx = b.x - a.x, dy = b.y - a.y;
        const L2 = dx * dx + dy * dy;
        const t = L2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2)) : 0;
        return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
      };
      const distToRing = (p: Pt, ring: Pt[]): number => {
        let d = Infinity;
        for (let i = 0; i < ring.length; i++) {
          d = Math.min(d, distToSeg(p, ring[i], ring[(i + 1) % ring.length]));
        }
        return d;
      };
      for (const flat of triCandidates) {
        const tri = ringOf(flat);
        if (tri.length < 3) continue;
        // Measure the triangle against every accepted ring. Rings are read
        // live so a wedge can lean on an edge an earlier merge just extended.
        type RingHit = { s: TraceRoadStrip; ring: Pt[]; shared: number; collinear: boolean };
        const hits: RingHit[] = [];
        for (const s of strips) {
          const ring = s.surface ?? s.outline;
          if (!ring || ring.length < 3) continue;
          let shared = 0;
          for (const v of tri) if (distToRing(v, ring) <= 1.0) shared++;
          let collinear = false;
          for (let i = 0; i < tri.length && !collinear; i++) {
            const a = tri[i], b = tri[(i + 1) % tri.length];
            if (Math.hypot(b.x - a.x, b.y - a.y) < 5) continue;
            const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
            collinear = distToRing(a, ring) <= 1.0 && distToRing(b, ring) <= 1.0 &&
                        distToRing(mid, ring) <= 1.0;
          }
          if (shared >= 2 || collinear) hits.push({ s, ring, shared, collinear });
        }
        // (1) a drawn infill always continues some road edge
        if (!hits.some(h => h.collinear)) continue;
        // (2) and ties TWO pavement pieces together
        const anchored = hits.filter(h => h.shared >= 2);
        if (anchored.length < 2) continue;
        // (3) merge into the most-shared ring, tie to the smaller one
        let best: RingHit | null = null;
        let bestArea = Infinity;
        for (const h of anchored) {
          const areaS = ringArea(h.ring);
          if (!best || h.shared > best.shared ||
              (h.shared === best.shared && areaS < bestArea)) {
            best = h; bestArea = areaS;
          }
        }
        if (!best) continue;
        try {
          const merged = (polygonClipping.union(
            [best.ring.map(p => [p.x, p.y] as [number, number])],
            [tri.map(p => [p.x, p.y] as [number, number])]
          ) as [number, number][][][]).filter(poly => poly.length);
          if (merged.length !== 1) continue;
          const outer = merged[0][0].map(([x, y]) => ({ x, y }));
          while (outer.length > 3 &&
                 Math.hypot(outer[0].x - outer[outer.length - 1].x,
                            outer[0].y - outer[outer.length - 1].y) < 1e-6) outer.pop();
          if (outer.length >= 3) {
            if (best.s.surface) best.s.surface = outer;
            else best.s.outline = outer;
          }
        } catch { /* malformed union — the triangle stays annotation-only */ }
      }
      if (strips.length) roads.push({ layerName: layer.name, strips });
      continue;
    }
    if (!closed.length) continue;
    if (cls?.kind === 'substation') {
      for (const flat of closed) {
        const pose = fitRectPose(flat);
        if (pose) substations.push({ layerName: layer.name, pose });
      }
      continue;
    }
    for (const flat of closed) {
      const pose = fitRectPose(flat);
      if (!pose) continue;
      const rectSqFt = pose.lengthFt * pose.widthFt;
      if (cls?.kind === 'equipment') {
        if (rectSqFt < EQUIP_MIN_SQFT || rectSqFt > EQUIP_MAX_SQFT) continue;
        // Shapes on a GENERATOR layer are storage containers in practice
        // (customer packages label the conex row "GENERATOR" while drawing
        // container boxes) — import them ALL as conex so the yard never
        // sprouts phantom GEN units. Confirmed on the Big Iron package:
        // every GENERATOR-layer box is a conex, regardless of drawn size.
        const kind: TraceEquipKind = cls.equip === 'generator' ? 'conex' : cls.equip;
        items.push({
          layerName: layer.name, kind, augmented: cls.augmented,
          ...(cls.future ? { future: true } : {}),
          pose,
        });
      } else {
        // Unknown name. Only parcel-plausible equipment-scale rectangles are
        // worth a prompt; giant outlines and dust are ignored quietly.
        if (rectSqFt < EQUIP_MIN_SQFT || rectSqFt > EQUIP_MAX_SQFT || pose.fillRatio < 0.5) {
          ignoredLayers.add(layer.name);
          continue;
        }
        const suggested = suggestKindForPose(pose);
        unknowns.push({ layerName: layer.name, pose, suggested, tag: suggested });
      }
    }
  }

  const present = new Set(items.map(i => i.kind));
  const missingAux = AUX_TRACE_KINDS.filter(k => !present.has(k));
  // Site AC rating declared in the drawing's own layer names ("DC-1 250MW",
  // "DC-2 250MW" → 500 MW). Only whole-area rating labels count — a figure
  // must end the name (optionally followed by whitespace) so a road station
  // label never reads as a rating.
  let sitePoiMW = 0;
  for (const layer of drawing.layers) {
    const m = /(\d+(?:\.\d+)?)\s*MW\s*$/i.exec(layer.name.trim());
    if (m) sitePoiMW += parseFloat(m[1]);
  }
  return {
    items, roads, unknowns, substations, missingAux,
    ignoredLayers: Array.from(ignoredLayers),
    ...(sitePoiMW > 0 ? { sitePoiMW } : {}),
  };
}

// Does the drawing contain yard geometry worth auto-filling at all?
export function drawingHasYardGeometry(drawing: ImportedDrawing | null | undefined): boolean {
  if (!drawing) return false;
  const plan = analyzeReferenceDrawing(drawing);
  return plan.items.length > 0 || plan.roads.length > 0;
}

// Typical CONEX box footprint used for size-based suggestions (feet).
export const CONEX_DIMS = { length: 20, width: 10, height: 8.5 };

// Catalog height for a traced kind (drawn rectangles carry no height).
export function traceKindHeight(kind: TraceEquipKind): number {
  if (kind === 'generator') return 10;
  if (kind === 'conex') return CONEX_DIMS.height;
  if (kind === 'manhole') return 1;
  const spec = specForKind(kind);
  return spec ? spec.dims.height : 8;
}

export type { EquipmentKind };

// ---------------------------------------------------------------------------
// Gate-apron keep test — shared by the trace commit's gate flag pass
// (useDesignStore.flagTracedGateRoads) and the layout engine's render-time
// pavement guard so the two can never disagree about which wholly-outside
// strips carry pavement.
//
// A wholly-outside traced strip is a real gate apron in exactly two forms:
//   RING (verbatim drawn pavement polygon): the drawn flare/apron itself —
//     kept when the majority of its perimeter lies within apron reach of
//     the gate (every legitimate flare on the reference fleet measures
//     1.00; the drawn yard networks measure ≤0.32).
//   BARE centerline: a short public-road stub that TERMINATES at the gate
//     — an approach drawn stopping short of the boundary.
// A strip that merely PASSES the gate is off-site context road and never
// carries pavement, no matter how close it comes:
//   - Big Iron Area 4's ~1,460 ft fence-hugging corridor band came within
//     ~190 ft of the gate at one endpoint — the old ANY-point-in-reach rule
//     kept it and paved ~36k sqft outside the fence.
//   - Big Iron Area 1's ~470 ft frontage segment is CENTERED on the gate
//     (83% of its length in reach) but both endpoints run ~240 ft past it;
//     the user-approved Area 3 standard renders that public corridor as
//     reference linework, unpaved — so majority-in-reach must NOT keep a
//     bare passing strip either.

// Matches the commit-side reach: TRACED_GATE_REACH_FT (120) + the engine's
// 80 ft gate disc. The longest legitimate drawn flare ring on the reference
// fleet is ~300 ft of perimeter, comfortably inside both limits below.
export const TRACED_APRON_REACH_FT = 200;
// A bare (ring-less) strip longer than this is a corridor, not a gate stub
// — even if it terminates in reach. A genuinely long drawn driveway would
// be dropped too (render warns loudly); none exists on the reference
// fleet, and a drafter can hand-draw one, which bypasses this rule.
export const TRACED_APRON_MAX_BARE_FT = 350;

export const tracedApronKeepsPavement = (
  pts: Pt[],
  surface: Pt[] | undefined,
  gate: Pt,
): boolean => {
  const ring = (surface?.length ?? 0) >= 3 ? surface! : null;
  if (ring) {
    // Sample the ring perimeter at ~5 ft so short edges still count.
    let total = 0;
    let near = 0;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      const L = Math.hypot(b.x - a.x, b.y - a.y);
      if (!Number.isFinite(L) || L <= 0) continue;
      const steps = Math.max(1, Math.ceil(L / 5));
      const dl = L / steps;
      for (let k = 0; k < steps; k++) {
        const t = (k + 0.5) / steps;
        const d = Math.hypot(
          a.x + (b.x - a.x) * t - gate.x,
          a.y + (b.y - a.y) * t - gate.y);
        total += dl;
        if (d <= TRACED_APRON_REACH_FT) near += dl;
      }
    }
    return total > 0 && near / total >= 0.5;
  }
  if (pts.length < 2) return false;
  let len = 0;
  for (let i = 1; i < pts.length; i++) {
    const L = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    if (Number.isFinite(L)) len += L;
  }
  if (len > TRACED_APRON_MAX_BARE_FT) return false;
  const dA = Math.hypot(pts[0].x - gate.x, pts[0].y - gate.y);
  const dB = Math.hypot(pts[pts.length - 1].x - gate.x, pts[pts.length - 1].y - gate.y);
  return Math.min(dA, dB) <= TRACED_APRON_REACH_FT;
};
