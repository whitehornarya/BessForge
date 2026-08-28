// Road-surface pathing shared by layout edit tools and scan-mode feeder
// home runs. Kept out of layoutEngine so feeders.ts can call it without a
// circular import.
// ALL COORDINATES IN FEET.

import polygonClipping from 'polygon-clipping';
import { Pt, RoadEdgeSeg, RoadNetwork } from './types';

export type PCRing = [number, number][];

function tessellateEdgePath(segs: RoadEdgeSeg[], maxChordFt = 2): Pt[] {
  const pts: Pt[] = [];
  const push = (p: Pt) => {
    const last = pts[pts.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) > 0.05) pts.push(p);
  };
  for (const s of segs) {
    if (s.kind === 'line') {
      push(s.a);
      push(s.b);
    } else {
      let sweep = s.end - s.start;
      if (s.ccw) { while (sweep <= 0) sweep += Math.PI * 2; }
      else { while (sweep >= 0) sweep -= Math.PI * 2; }
      const n = Math.max(2, Math.ceil((Math.abs(sweep) * s.r) / maxChordFt));
      for (let i = 0; i <= n; i++) {
        const a = s.start + sweep * (i / n);
        push({ x: s.c.x + s.r * Math.cos(a), y: s.c.y + s.r * Math.sin(a) });
      }
    }
  }
  if (pts.length > 1) {
    const f = pts[0], l = pts[pts.length - 1];
    if (Math.hypot(f.x - l.x, f.y - l.y) <= 0.05) pts.pop();
  }
  return pts;
}

export function roadRegionFromNetwork(
  network: { outer: RoadEdgeSeg[]; islands: RoadEdgeSeg[][] } | null | undefined
): PCRing[][] {
  if (!network || !network.outer.length) return [];
  try {
    const outer = tessellateEdgePath(network.outer);
    if (outer.length < 3) return [];
    const loops = network.islands.map(i => tessellateEdgePath(i)).filter(r => r.length >= 3);
    return polygonClipping.xor(
      [outer.map(p => [p.x, p.y] as [number, number])] as any,
      ...loops.map(l => [l.map(p => [p.x, p.y] as [number, number])] as any)
    ) as PCRing[][];
  } catch { return []; }
}

function ringContainsPt(ring: PCRing, p: Pt): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if ((yi > p.y) !== (yj > p.y)) {
      const xint = xi + ((p.y - yi) / (yj - yi)) * (xj - xi);
      if (p.x < xint) inside = !inside;
    }
  }
  return inside;
}

export function pointOnRoadFast(region: PCRing[][], p: Pt): boolean {
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return false;
  for (const poly of region) {
    if (!poly.length || !ringContainsPt(poly[0], p)) continue;
    let inHole = false;
    for (let i = 1; i < poly.length; i++) {
      if (ringContainsPt(poly[i], p)) { inHole = true; break; }
    }
    if (!inHole) return true;
  }
  return false;
}

type RoadGrid = {
  cell: number; minX: number; minY: number; nx: number; ny: number;
  road: Uint8Array; clear: Int32Array;
};

function buildRoadGrid(region: PCRing[][], cell: number): RoadGrid | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const edges: { x0: number; y0: number; x1: number; y1: number }[] = [];
  for (const poly of region) {
    for (const ring of poly) {
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i], b = ring[(i + 1) % ring.length];
        edges.push({ x0: a[0], y0: a[1], x1: b[0], y1: b[1] });
        if (a[0] < minX) minX = a[0]; if (a[0] > maxX) maxX = a[0];
        if (a[1] < minY) minY = a[1]; if (a[1] > maxY) maxY = a[1];
      }
    }
  }
  if (!edges.length || !Number.isFinite(minX)) return null;
  minX -= cell; minY -= cell; maxX += cell; maxY += cell;
  const nx = Math.ceil((maxX - minX) / cell), ny = Math.ceil((maxY - minY) / cell);
  if (nx < 2 || ny < 2 || nx * ny > 4_000_000) return null;
  const road = new Uint8Array(nx * ny);
  const xs: number[] = [];
  for (let j = 0; j < ny; j++) {
    const y = minY + (j + 0.5) * cell;
    xs.length = 0;
    for (const e of edges) {
      if ((e.y0 > y) !== (e.y1 > y)) {
        xs.push(e.x0 + ((y - e.y0) / (e.y1 - e.y0)) * (e.x1 - e.x0));
      }
    }
    if (xs.length < 2) continue;
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const i0 = Math.max(0, Math.ceil((xs[k] - minX) / cell - 0.5));
      const i1 = Math.min(nx - 1, Math.floor((xs[k + 1] - minX) / cell - 0.5));
      for (let i = i0; i <= i1; i++) road[j * nx + i] = 1;
    }
  }
  const clear = new Int32Array(nx * ny).fill(-1);
  const q = new Int32Array(nx * ny);
  let qh = 0, qt = 0;
  for (let i = 0; i < road.length; i++) if (!road[i]) { clear[i] = 0; q[qt++] = i; }
  while (qh < qt) {
    const c = q[qh++]; const cx = c % nx, cy = (c / nx) | 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const ax = cx + dx, ay = cy + dy;
      if (ax < 0 || ay < 0 || ax >= nx || ay >= ny) continue;
      const ai = ay * nx + ax;
      if (clear[ai] !== -1) continue;
      clear[ai] = clear[c] + 1; q[qt++] = ai;
    }
  }
  return { cell, minX, minY, nx, ny, road, clear };
}

function cellCenter(g: RoadGrid, i: number): Pt {
  return {
    x: g.minX + ((i % g.nx) + 0.5) * g.cell,
    y: g.minY + (((i / g.nx) | 0) + 0.5) * g.cell,
  };
}

// Nearest paved cell to `p`, then the highest-clearance (mid-strip) cell
// within a short radius of that snap so junctions don't pin to a shoulder.
export function nearestRoadCenter(
  region: PCRing[][],
  p: Pt,
  maxSearchFt = 120
): Pt | null {
  const g = buildRoadGrid(region, 4);
  if (!g) return null;
  let nearest = -1, nearestD = Infinity;
  for (let i = 0; i < g.road.length; i++) {
    if (!g.road[i]) continue;
    const c = cellCenter(g, i);
    const d = Math.hypot(c.x - p.x, c.y - p.y);
    if (d < nearestD) { nearestD = d; nearest = i; }
  }
  if (nearest < 0 || nearestD > maxSearchFt) return null;
  const snap = cellCenter(g, nearest);
  let best = nearest, bestClear = g.clear[nearest];
  const win = 12;
  for (let i = 0; i < g.road.length; i++) {
    if (!g.road[i]) continue;
    const c = cellCenter(g, i);
    if (Math.hypot(c.x - snap.x, c.y - snap.y) > win) continue;
    if (g.clear[i] > bestClear) { bestClear = g.clear[i]; best = i; }
  }
  return cellCenter(g, best);
}

export function roadPathBetween(
  region: PCRing[][],
  a: Pt,
  b: Pt,
  cellFt = 6
): Pt[] | null {
  if (!region.length) return null;
  const g = buildRoadGrid(region, cellFt);
  if (!g) return null;
  const { nx, ny, cell, minX, minY, road, clear } = g;
  const idxOf = (p: Pt): number => {
    let i = Math.round((p.x - minX) / cell - 0.5);
    let j = Math.round((p.y - minY) / cell - 0.5);
    i = Math.max(0, Math.min(nx - 1, i)); j = Math.max(0, Math.min(ny - 1, j));
    if (road[j * nx + i]) return j * nx + i;
    for (let r = 1; r <= 6; r++) {
      let bestI = -1, bestD = Infinity;
      for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
        const ai = i + di, aj = j + dj;
        if (ai < 0 || aj < 0 || ai >= nx || aj >= ny) continue;
        const k = aj * nx + ai;
        if (!road[k]) continue;
        const d = di * di + dj * dj;
        if (d < bestD) { bestD = d; bestI = k; }
      }
      if (bestI >= 0) return bestI;
    }
    return -1;
  };
  const s = idxOf(a), t = idxOf(b);
  if (s < 0 || t < 0) return null;
  if (s === t) return null;

  const N = nx * ny;
  const dist = new Float64Array(N).fill(Infinity);
  const prev = new Int32Array(N).fill(-1);
  const visited = new Uint8Array(N);
  const heap: { i: number; d: number }[] = [{ i: s, d: 0 }];
  dist[s] = 0;
  const push = (i: number, d: number) => {
    heap.push({ i, d });
    let c = heap.length - 1;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (heap[p].d <= heap[c].d) break;
      const tmp = heap[p]; heap[p] = heap[c]; heap[c] = tmp; c = p;
    }
  };
  const pop = (): { i: number; d: number } | null => {
    if (!heap.length) return null;
    const top = heap[0], last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      let c = 0;
      for (;;) {
        const l = c * 2 + 1, r = l + 1;
        let m = c;
        if (l < heap.length && heap[l].d < heap[m].d) m = l;
        if (r < heap.length && heap[r].d < heap[m].d) m = r;
        if (m === c) break;
        const tmp = heap[m]; heap[m] = heap[c]; heap[c] = tmp; c = m;
      }
    }
    return top;
  };
  while (heap.length) {
    const cur = pop()!;
    if (visited[cur.i]) continue;
    visited[cur.i] = 1;
    if (cur.i === t) break;
    const cx = cur.i % nx, cy = (cur.i / nx) | 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const ax = cx + dx, ay = cy + dy;
      if (ax < 0 || ay < 0 || ax >= nx || ay >= ny) continue;
      const ai = ay * nx + ax;
      if (!road[ai] || visited[ai]) continue;
      const step = (dx && dy) ? Math.SQRT2 : 1;
      const bias = 1 + 2 / (1 + clear[ai]);
      const nd = cur.d + step * bias;
      if (nd < dist[ai]) { dist[ai] = nd; prev[ai] = cur.i; push(ai, nd); }
    }
  }
  if (!visited[t] || prev[t] < 0) return null;
  const cells: number[] = [];
  for (let c = t; c !== -1; c = prev[c]) { cells.push(c); if (c === s) break; }
  cells.reverse();
  const toPt = (c: number): Pt => ({
    x: minX + ((c % nx) + 0.5) * cell,
    y: minY + (((c / nx) | 0) + 0.5) * cell,
  });
  const raw = cells.map(toPt);
  const path: Pt[] = [a];
  let lastDir: Pt | null = null;
  for (let i = 1; i + 1 < raw.length; i++) {
    const p0 = path[path.length - 1], p1 = raw[i];
    const dx = p1.x - p0.x, dy = p1.y - p0.y;
    const L = Math.hypot(dx, dy);
    if (L < cell) continue;
    const d = { x: dx / L, y: dy / L };
    if (!lastDir || (d.x * lastDir.x + d.y * lastDir.y) < 0.985 || L > 60) {
      path.push(p1); lastDir = d;
    }
  }
  path.push(b);
  return path.length >= 2 ? path : null;
}

export function orthogonalizeRoadPolyline(pts: Pt[]): Pt[] {
  if (pts.length < 2) return pts;
  const raw: Pt[] = [{ x: pts[0].x, y: pts[0].y }];
  for (let i = 1; i < pts.length; i++) {
    const a = raw[raw.length - 1], b = pts[i];
    if (Math.abs(a.x - b.x) < 0.05 || Math.abs(a.y - b.y) < 0.05) {
      raw.push({ x: b.x, y: b.y });
      continue;
    }
    const preferX = Math.abs(b.x - a.x) >= Math.abs(b.y - a.y);
    raw.push(preferX ? { x: b.x, y: a.y } : { x: a.x, y: b.y });
    raw.push({ x: b.x, y: b.y });
  }
  const out: Pt[] = [];
  for (const p of raw) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) > 0.05) out.push(p);
  }
  for (let i = 1; i < out.length - 1; ) {
    const a = out[i - 1], v = out[i], b = out[i + 1];
    const l1 = Math.hypot(v.x - a.x, v.y - a.y);
    const l2 = Math.hypot(b.x - v.x, b.y - v.y);
    if (l1 > 1e-9 && l2 > 1e-9) {
      const dot = ((v.x - a.x) * (b.x - v.x) + (v.y - a.y) * (b.y - v.y)) / (l1 * l2);
      if (dot > 0.9999) { out.splice(i, 1); continue; }
    }
    i++;
  }
  return out;
}

// Lateral offset of interior vertices along the path's local left-normal.
// Endpoints stay pinned so a feeder launch / substation landing does not drift.
export function offsetRoadPolyline(pts: Pt[], delta: number): Pt[] {
  if (pts.length < 2 || Math.abs(delta) < 1e-6) return pts;
  const nrm = (a: Pt, b: Pt): Pt => {
    const dx = b.x - a.x, dy = b.y - a.y;
    const L = Math.hypot(dx, dy);
    if (L < 1e-9) return { x: 0, y: 0 };
    return { x: -dy / L, y: dx / L };
  };
  return pts.map((p, i) => {
    if (i === 0 || i === pts.length - 1) return { x: p.x, y: p.y };
    const n1 = nrm(pts[i - 1], p);
    const n2 = nrm(p, pts[i + 1]);
    let nx = n1.x + n2.x, ny = n1.y + n2.y;
    const L = Math.hypot(nx, ny);
    if (L < 1e-9) { nx = n1.x; ny = n1.y; }
    else { nx /= L; ny /= L; }
    return { x: p.x + nx * delta, y: p.y + ny * delta };
  });
}

export function rectRoadNetwork(x1: number, y1: number, x2: number, y2: number): RoadNetwork {
  const pts: Pt[] = [
    { x: x1, y: y1 }, { x: x2, y: y1 }, { x: x2, y: y2 }, { x: x1, y: y2 },
  ];
  const outer: RoadEdgeSeg[] = pts.map((a, i) => ({
    kind: 'line', a, b: pts[(i + 1) % pts.length],
  }));
  return { outer, islands: [] };
}
