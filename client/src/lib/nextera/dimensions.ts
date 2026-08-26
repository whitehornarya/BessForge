// Shared per-block spacing dimensions (NextEra guidance sheet 3 style):
// container-to-container gaps, PCS/inverter clearance and block-to-block
// gaps, computed 1:1 from layout positions. Consumed by BOTH the DXF
// export (A - Dimensions layer) and the 2D plan view overlay so the two
// always show identical measurements.
import type { SiteDesign, PlacedEquipment } from './types';

export interface DimSpec {
  kind: 'h' | 'v';
  a: number;      // start of measured span (x for 'h', y for 'v')
  b: number;      // end of measured span
  ref: number;    // where extension lines start (y for 'h', x for 'v')
  dim: number;    // dim line position (y for 'h', x for 'v')
  label: string;
}

export interface DimPrims {
  lines: { x1: number; y1: number; x2: number; y2: number }[];
  // x/y is the estimated left anchor (kept for extent-reasoning consumers,
  // e.g. the 3D overlay); cx/cy is the true baseline center — DXF/PDF/CAD
  // renderers must center on cx/cy (real justification, register F-24).
  text: { x: number; y: number; cx: number; cy: number; rot: number; label: string };
}

export const DIM_TEXT_H = 4; // ft, matches text-sm standard
const TICK = 2;              // oblique tick half-length
const CHAR_W = 0.62;         // approx text aspect used by the DXF writer

// Expand a DimSpec into raw line segments + a text placement. Geometry is
// identical to the classic extension-line + dim-line + 45-degree tick style
// used by the DXF dimH/dimV helpers.
export function expandDim(d: DimSpec): DimPrims {
  const lines: DimPrims['lines'] = [];
  const tick = (x: number, y: number, ang: number) => {
    const a2 = ang + Math.PI / 4;
    lines.push({
      x1: x - Math.cos(a2) * TICK, y1: y - Math.sin(a2) * TICK,
      x2: x + Math.cos(a2) * TICK, y2: y + Math.sin(a2) * TICK,
    });
  };
  const tw = d.label.length * DIM_TEXT_H * CHAR_W;
  if (d.kind === 'h') {
    const over = 1.5 * Math.sign(d.dim - d.ref || 1);
    lines.push({ x1: d.a, y1: d.ref, x2: d.a, y2: d.dim + over });
    lines.push({ x1: d.b, y1: d.ref, x2: d.b, y2: d.dim + over });
    lines.push({ x1: d.a, y1: d.dim, x2: d.b, y2: d.dim });
    tick(d.a, d.dim, 0);
    tick(d.b, d.dim, 0);
    return {
      lines,
      text: {
        x: (d.a + d.b) / 2 - tw / 2, y: d.dim + 1,
        cx: (d.a + d.b) / 2, cy: d.dim + 1, rot: 0, label: d.label,
      },
    };
  }
  const over = 1.5 * Math.sign(d.dim - d.ref || 1);
  lines.push({ x1: d.ref, y1: d.a, x2: d.dim + over, y2: d.a });
  lines.push({ x1: d.ref, y1: d.b, x2: d.dim + over, y2: d.b });
  lines.push({ x1: d.dim, y1: d.a, x2: d.dim, y2: d.b });
  tick(d.dim, d.a, Math.PI / 2);
  tick(d.dim, d.b, Math.PI / 2);
  return {
    lines,
    text: {
      x: d.dim - 1, y: (d.a + d.b) / 2 - tw / 2,
      cx: d.dim - 1, cy: (d.a + d.b) / 2, rot: 90, label: d.label,
    },
  };
}

// Decimal feet -> ft-in string, e.g. 23.525 -> 23'-6.3"
export function dimFtIn(ft: number): string {
  let whole = Math.floor(ft);
  let inches = (ft - whole) * 12;
  if (Math.abs(inches - 12) < 0.05) { whole += 1; inches = 0; }
  const inStr = Math.abs(inches - Math.round(inches)) < 0.05
    ? String(Math.round(inches))
    : inches.toFixed(1);
  return `${whole}'-${inStr}"`;
}

function halfExtents(eq: PlacedEquipment): { hx: number; hy: number } {
  const c = Math.abs(Math.cos(eq.rotation)), s = Math.abs(Math.sin(eq.rotation));
  return { hx: (eq.length / 2) * c + (eq.width / 2) * s, hy: (eq.length / 2) * s + (eq.width / 2) * c };
}

interface BlockGroup {
  n: number;
  inv: PlacedEquipment | null;
  containers: PlacedEquipment[];
  minX: number; maxX: number; minY: number; maxY: number;
}

function groupBlocks(design: SiteDesign): BlockGroup[] {
  const map = new Map<number, BlockGroup>();
  for (const e of design.equipment) {
    let n: number | null = null;
    if (e.kind === 'bess') {
      const m = e.id.match(/^bess-(\d+)-/);
      if (m) n = Number(m[1]);
    } else if (e.kind === 'inverter') {
      const m = e.id.match(/^inv-(\d+)$/);
      if (m) n = Number(m[1]);
    }
    if (n === null) continue;
    let g = map.get(n);
    if (!g) { g = { n, inv: null, containers: [], minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity }; map.set(n, g); }
    if (e.kind === 'inverter') g.inv = e;
    else g.containers.push(e);
    const h = halfExtents(e);
    g.minX = Math.min(g.minX, e.x - h.hx);
    g.maxX = Math.max(g.maxX, e.x + h.hx);
    g.minY = Math.min(g.minY, e.y - h.hy);
    g.maxY = Math.max(g.maxY, e.y + h.hy);
  }
  return Array.from(map.values()).sort((a, b) => a.n - b.n);
}

// Traced KMZ equipment deliberately keeps peq-* identifiers, so it cannot be
// recovered through the automatic bess-<block>-* / inv-<block> convention.
// Build the same physical groups geometrically: every built container belongs
// to its nearest built PCS.  Dimensions are then taken from the actual rotated
// footprints (via their world plan extents), never from an id or catalog guess.
function groupTracedBlocks(design: SiteDesign): BlockGroup[] {
  const equipment = design.equipment.filter(e =>
    !!e.traceSourcePose && e.id.startsWith('peq-') &&
    !e.augmented && !e.future &&
    (e.kind === 'bess' || e.kind === 'inverter'));
  const invs = equipment.filter(e => e.kind === 'inverter');
  const bess = equipment.filter(e => e.kind === 'bess');
  if (!invs.length || !bess.length) return [];
  const groups = invs.map((inv, n): BlockGroup => {
    const h = halfExtents(inv);
    return {
      n, inv, containers: [],
      minX: inv.x - h.hx, maxX: inv.x + h.hx,
      minY: inv.y - h.hy, maxY: inv.y + h.hy,
    };
  });
  // Match the balanced-proximity service association: globally ordered
  // candidate pairs plus a yard-wide cap prevents one PCS from stealing a
  // neighbour's containers in dense traced yards.
  const reach = 400;
  const cap = Math.max(1, Math.ceil(bess.length / invs.length));
  const load = new Map<BlockGroup, number>(groups.map(g => [g, 0]));
  const pairs: { c: PlacedEquipment; g: BlockGroup; d: number }[] = [];
  for (const c of bess) for (const g of groups) {
    const d = Math.hypot(g.inv!.x - c.x, g.inv!.y - c.y);
    if (d <= reach) pairs.push({ c, g, d });
  }
  pairs.sort((a, b) =>
    a.d - b.d || a.c.id.localeCompare(b.c.id) || a.g.inv!.id.localeCompare(b.g.inv!.id));
  const assigned = new Set<string>();
  for (const capped of [true, false]) for (const { c, g } of pairs) {
    if (assigned.has(c.id) || (capped && (load.get(g) ?? 0) >= cap)) continue;
    assigned.add(c.id);
    load.set(g, (load.get(g) ?? 0) + 1);
    g.containers.push(c);
    const h = halfExtents(c);
    g.minX = Math.min(g.minX, c.x - h.hx);
    g.maxX = Math.max(g.maxX, c.x + h.hx);
    g.minY = Math.min(g.minY, c.y - h.hy);
    g.maxY = Math.max(g.maxY, c.y + h.hy);
  }
  return groups;
}

function canonicalGroup(g: BlockGroup): { group: BlockGroup; swapped: boolean } {
  if (!g.inv || Math.abs(Math.sin(g.inv.rotation)) <= 0.5) {
    return { group: g, swapped: false };
  }
  const swap = (e: PlacedEquipment): PlacedEquipment => ({
    ...e,
    x: e.y,
    y: e.x,
    rotation: e.rotation - Math.PI / 2,
  });
  const inv = swap(g.inv);
  const containers = g.containers.map(swap);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const e of [inv, ...containers]) {
    const h = halfExtents(e);
    minX = Math.min(minX, e.x - h.hx);
    maxX = Math.max(maxX, e.x + h.hx);
    minY = Math.min(minY, e.y - h.hy);
    maxY = Math.max(maxY, e.y + h.hy);
  }
  return {
    swapped: true,
    group: { n: g.n, inv, containers, minX, maxX, minY, maxY },
  };
}

// Canonical x'=world-y and y'=world-x. DimSpec stores a/b on the measured
// axis and ref/dim on the perpendicular axis, so the numeric slots already
// become the correct world coordinates when h/v is exchanged.
const fromCanonical = (d: DimSpec, swapped: boolean): DimSpec =>
  swapped ? { ...d, kind: d.kind === 'h' ? 'v' : 'h' } : d;

// Per-block spacing dimensions per guidance sheet 3:
// - container column side gap (per block, horizontal, drawn above the block)
// - container row front/rear gap (per block, vertical, drawn left of the block)
// - PCS clearance: containers <-> inverter (per block, vertical, right side)
export function computeBlockSpacingDims(design: SiteDesign): DimSpec[] {
  const dims: DimSpec[] = [];
  const blocks = [...groupBlocks(design), ...groupTracedBlocks(design)];

  for (const raw of blocks) {
    const { group: g, swapped } = canonicalGroup(raw);
    const blockDims: DimSpec[] = [];
    if (!g.containers.length) continue;

    // Container side gap: measured between two containers that actually sit
    // side by side, i.e. within the SAME container row (equal y). Scanning all
    // containers by x instead breaks on staggered blocks — a 3-container block
    // puts one container centered above two, so the two left-most x centers
    // belong to different rows, their extents overlap, and the real side gap
    // is silently dropped from the drawing.
    const rowsByY = new Map<number, PlacedEquipment[]>();
    for (const c of g.containers) {
      const key = Math.round(c.y * 10) / 10;
      const arr = rowsByY.get(key);
      if (arr) arr.push(c); else rowsByY.set(key, [c]);
    }
    // Prefer the most populated row; tie-break on the lower row so the
    // dimension keeps its historical position on square blocks.
    const gapRow = Array.from(rowsByY.entries())
      .filter(([, cs]) => cs.length >= 2)
      .sort((a, b) => b[1].length - a[1].length || a[0] - b[0])[0]?.[1];
    if (gapRow) {
      const byX = gapRow.slice().sort((a, b) => a.x - b.x);
      const cA = byX[0];
      const cB = byX[1];
      const xa = cA.x + halfExtents(cA).hx;
      const xb = cB.x - halfExtents(cB).hx;
      if (xb - xa > 0.2) {
        blockDims.push({ kind: 'h', a: xa, b: xb, ref: g.maxY, dim: g.maxY + 6, label: dimFtIn(xb - xa) });
      }
    }

    // container rows (unique y centers)
    const rowYs = Array.from(new Set(g.containers.map(c => Math.round(c.y * 10) / 10))).sort((a, b) => a - b);
    if (rowYs.length >= 2) {
      const rA = g.containers.find(c => Math.abs(c.y - rowYs[0]) < 0.2)!;
      const rB = g.containers.find(c => Math.abs(c.y - rowYs[1]) < 0.2)!;
      const ya = rA.y + halfExtents(rA).hy;
      const yb = rB.y - halfExtents(rB).hy;
      if (yb - ya > 0.2) {
        blockDims.push({ kind: 'v', a: ya, b: yb, ref: g.minX, dim: g.minX - 6, label: dimFtIn(yb - ya) });
      }
    }

    // PCS clearance: nearest container edge to the inverter, vertical or
    // horizontal depending on where the inverter sits relative to containers
    if (g.inv) {
      const hi = halfExtents(g.inv);
      let best: { gap: number; horiz: boolean; c: PlacedEquipment } | null = null;
      for (const c of g.containers) {
        const hc = halfExtents(c);
        const dx = Math.abs(c.x - g.inv.x) - (hi.hx + hc.hx);
        const dy = Math.abs(c.y - g.inv.y) - (hi.hy + hc.hy);
        if (dy > 0.2 && dx < -0.2 && (!best || dy < best.gap)) best = { gap: dy, horiz: false, c };
        else if (dx > 0.2 && dy < -0.2 && (!best || dx < best.gap)) best = { gap: dx, horiz: true, c };
      }
      if (best) {
        const hc = halfExtents(best.c);
        if (!best.horiz) {
          const below = best.c.y < g.inv.y;
          const ya = below ? best.c.y + hc.hy : g.inv.y + hi.hy;
          const yb = below ? g.inv.y - hi.hy : best.c.y - hc.hy;
          blockDims.push({ kind: 'v', a: ya, b: yb, ref: g.maxX, dim: g.maxX + 6, label: dimFtIn(best.gap) });
        } else {
          const left = best.c.x < g.inv.x;
          const xa = left ? best.c.x + hc.hx : g.inv.x + hi.hx;
          const xb = left ? g.inv.x - hi.hx : best.c.x - hc.hx;
          blockDims.push({ kind: 'h', a: xa, b: xb, ref: g.maxY, dim: g.maxY + 6, label: dimFtIn(xb - xa) });
        }
      }
    }
    dims.push(...blockDims.map(d => fromCanonical(d, swapped)));
  }

  return dims;
}
