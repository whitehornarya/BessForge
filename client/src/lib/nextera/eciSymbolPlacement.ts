// ---------------------------------------------------------------------------
// Yard equipment symbol placement — shared by the DXF exporter, the in-app
// scene overlays, the PDF plot, the CAD view and tests. Maps a legend glyph
// (normalized 0..1 y-up coords) onto a placed equipment rectangle in yard
// feet.
//
// SYMBOL SOURCE: the delivered NextEra equipment GLB, baked to plan-view
// vector linework in nexteraGlbSymbols.ts. That GLB carries TWO vendor sets
// (GE and Power Electronics), so the PCS, the LG container and the comms
// cabinet each have a per-vendor trace and the yard draws the set matching
// config.inverterModel. The GLB has no artwork for the fiber patch panel or
// the feeder junction box, so those two kinds — and only those two — still
// come from the older delivered ECI library rather than losing their symbol.
//
// Registration rule: the glyph's `body` bbox (the container/cabinet outline)
// maps 1:1 onto the equipment footprint rect; door swings, stands and
// reservation outlines overhang outside it, exactly like the source sheets.
//
// Orientation rule: glyphs are authored with the long axis along +x, the
// LG E-panel/cable-compartment corner at glyph-left, and the PCS DC cable
// compartment at glyph bottom-left. Axis flips (never variant swaps) align
// that corner with the layout's doorEnd/epanel and pcsCompartments()
// geometry, so the drawn compartment always matches where cables land.
// ---------------------------------------------------------------------------
import { ECI_LEGEND_GLYPHS, type EciLegendGlyph } from './eciLegendGlyphs';
import { NEXTERA_GLB_SYMBOLS } from './nexteraGlbSymbols';
import type { PlacedEquipment } from './types';
import type { BessConfiguration } from './catalog';
import { pcsCompartments } from './cableRouting';
import polygonClipping from 'polygon-clipping';

type LocalRect = [minX: number, minY: number, maxX: number, maxY: number];

export interface EciSymbolPlacement {
  glyphKey: string;
  glyph: EciLegendGlyph;
  /** Delivered artwork library that actually resolved this placement. */
  source: SymbolSource;
  /** Maps normalized glyph coords (0..1, y-up) to yard feet. */
  toYard: (nx: number, ny: number) => [number, number];
  /**
   * Maps normalized glyph coords into the symbol's own LOCAL frame in feet:
   * origin at the footprint center, axes along the footprint, no rotation,
   * no mirroring. Two units of the same kind share this frame exactly, which
   * is what lets the (expensive) linework thinning be computed once per
   * kind+size and reused — see eciYardSymbolPolys.
   */
  toLocalFt: (nx: number, ny: number) => [number, number];
  /** Rigid placement of a local-frame point: mirror, rotate, translate. */
  localToYard: (lx: number, ly: number) => [number, number];
  /** Cache identity of the local frame: same string ⇒ same thinned artwork. */
  localKey: string;
  /**
   * Local-foot region occupied by the retired cable-compartment frame.
   * It is erased from both ink groups before thinning/placement; routing keeps
   * using its independent landing geometry.
   */
  compartmentErase?: LocalRect;
  /**
   * Independent semantic landing region used to audit the emitted artwork.
   * Unlike compartmentErase, this exists for every resolved BESS/PCS symbol,
   * so a missed source-ring detection cannot make the downstream audit
   * silently skip that unit.
   */
  compartmentAudit?: {
    bounds: LocalRect;
    sourceRingExpected: boolean;
    sourceRingDetected: boolean;
    /** Exact detected authored ring before clipping, in the source local frame. */
    sourceRing?: [number, number][];
    sourceRingBounds?: LocalRect;
  };
}

/** True when the configuration uses the Power Electronics PCS. */
export function isPeConfig(config?: BessConfiguration): boolean {
  return !!config && !/flex/i.test(config.inverterModel);
}

// Kinds whose GLB artwork is vendor-specific: [GE set key, PE set key].
const VENDOR_GLYPHS: Partial<Record<PlacedEquipment['kind'], [string, string]>> = {
  inverter: ['geFlex', 'peInverter'],
  bess: ['lgLinkGe', 'lgLinkPe'],
  commsCabinet: ['commsCabinetGe', 'commsCabinetPe'],
};

// Kinds with a single GLB symbol shared by both vendor sets.
const SHARED_GLB_GLYPHS: Partial<Record<PlacedEquipment['kind'], string>> = {
  auxTransformer: 'auxTransformer',
  auxSwitchgear: 'auxDistCenter',
};

// Kinds the delivered GLB has no artwork for; these fall back to the older
// ECI library glyph so they don't regress to a plain red rectangle.
const GLB_GAP_GLYPHS: Partial<Record<PlacedEquipment['kind'], string>> = {
  fiberPatchPanel: 'fiberJunctionBox',
  feederJunctionBox: 'junctionBox',
};

/**
 * Which delivered library a placement draws from.
 *  - 'glb' (default): the NextEra equipment GLB trace — the current source
 *    for the plan, the scene, the PDF and the CAD view.
 *  - 'eci': the older ECI legend library. Kept because its sheets carry the
 *    two LG DC Link door-config rows ("'A'"/"'C'") as separate symbols, which
 *    the GLB does not have — the ECI legend option still renders those rows.
 */
export type SymbolSource = 'glb' | 'eci';

// Legacy ECI library keys, by kind (the pre-GLB mapping).
const ECI_LIBRARY_GLYPHS: Partial<Record<PlacedEquipment['kind'], string>> = {
  auxTransformer: 'auxTransformer',
  auxSwitchgear: 'auxDistCenter',
  fiberPatchPanel: 'fiberJunctionBox',
  feederJunctionBox: 'junctionBox',
};

// The mirror of GLB_GAP_GLYPHS: kinds the older ECI library has no artwork
// for, mapped to the delivered GLB symbol [GE set key, PE set key]. Without
// this an ECI-mode drawing regresses to a plain rectangle for a kind the
// delivered set does cover, and the legend swatch (which replays this same
// resolution) would advertise a primitive the delivered artwork never draws.
const ECI_GAP_GLYPHS: Partial<Record<PlacedEquipment['kind'], [string, string]>> = {
  commsCabinet: ['commsCabinetGe', 'commsCabinetPe'],
};

/**
 * Resolve a glyph key to drawable linework. GLB artwork is a single ink
 * class, so it is all `black` (the thinning pass in eciYardSymbolPolys
 * expects that split); legacy ECI glyphs keep their black/gray groups.
 */
function glyphFor(key: string, source: SymbolSource): EciLegendGlyph | null {
  if (source === 'glb') {
    const glb = NEXTERA_GLB_SYMBOLS[key];
    if (glb) {
      return {
        aspect: glb.aspect,
        body: glb.body,
        black: glb.polys as unknown as number[][][][],
        gray: [],
      };
    }
  }
  return ECI_LEGEND_GLYPHS[key] ?? null;
}

/** Equipment kinds that resolve to a delivered symbol, by source. */
export function symbolEquipmentKinds(
  source: SymbolSource = 'glb'
): ReadonlySet<PlacedEquipment['kind']> {
  return new Set(
    (source === 'glb'
      ? [
          ...Object.keys(VENDOR_GLYPHS),
          ...Object.keys(SHARED_GLB_GLYPHS),
          ...Object.keys(GLB_GAP_GLYPHS),
        ]
      : [
          'inverter', 'bess',
          ...Object.keys(ECI_LIBRARY_GLYPHS),
          ...Object.keys(ECI_GAP_GLYPHS),
        ]
    ) as PlacedEquipment['kind'][]
  );
}

/** Kinds drawn from the delivered GLB symbol set (the default source). */
export const SYMBOL_EQUIPMENT_KINDS = symbolEquipmentKinds('glb');

/** Rotate a world-frame offset into the equipment's unrotated local frame. */
function toLocal(wx: number, wy: number, rot: number): [number, number] {
  const c = Math.cos(rot), s = Math.sin(rot);
  return [wx * c + wy * s, -wx * s + wy * c];
}

function ringBounds(ring: readonly [number, number][]): LocalRect {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of ring) {
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  return [minX, minY, maxX, maxY];
}

function rectArea(r: LocalRect): number {
  return Math.max(0, r[2] - r[0]) * Math.max(0, r[3] - r[1]);
}

function rectOverlapFraction(a: LocalRect, b: LocalRect): number {
  const overlap = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) *
    Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  return overlap / Math.max(rectArea(a), 1e-9);
}

/** Bounds of the rendered glyph in its footprint-centered local frame. */
function glyphLocalBounds(
  glyph: EciLegendGlyph,
  length: number,
  width: number,
): LocalRect {
  const [bx0, by0, bx1, by1] = glyph.body;
  const bcx = (bx0 + bx1) / 2, bcy = (by0 + by1) / 2;
  const sx = length / Math.max(bx1 - bx0, 1e-6);
  const sy = width / Math.max(by1 - by0, 1e-6);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const poly of [...glyph.black, ...glyph.gray]) {
    for (const ring of poly) {
      for (const [x, y] of ring) {
        const lx = (x - bcx) * sx, ly = (y - bcy) * sy;
        minX = Math.min(minX, lx); minY = Math.min(minY, ly);
        maxX = Math.max(maxX, lx); maxY = Math.max(maxY, ly);
      }
    }
  }
  return Number.isFinite(minX)
    ? [minX, minY, maxX, maxY]
    : [-length / 2, -width / 2, length / 2, width / 2];
}

/**
 * Find the authored compartment frame from source geometry, not color or a
 * generated-table index. The PCS candidate is the largest rectangle-like
 * polygon overlapping the real lower-left DC landing region. The BESS
 * candidate is the narrow rectangle-like edge enclosure. A source without
 * such a four-corner frame (notably the ECI PE trace) needs no erase.
 */
function compartmentEraseFor(
  glyph: EciLegendGlyph,
  kind: PlacedEquipment['kind'],
  length: number,
  width: number,
  source: SymbolSource,
): {
  sourceRing: [number, number][];
  sourceBounds: LocalRect;
  eraseBounds: LocalRect;
} | undefined {
  if (kind !== 'inverter' && kind !== 'bess') return undefined;
  const [bx0, by0, bx1, by1] = glyph.body;
  const bcx = (bx0 + bx1) / 2, bcy = (by0 + by1) / 2;
  const sx = length / Math.max(bx1 - bx0, 1e-6);
  const sy = width / Math.max(by1 - by0, 1e-6);
  const artwork = glyphLocalBounds(glyph, length, width);
  const artL = Math.max(1e-9, artwork[2] - artwork[0]);
  const artW = Math.max(1e-9, artwork[3] - artwork[1]);
  const artArea = artL * artW;
  const landing: LocalRect = kind === 'inverter'
    ? [
        artwork[0] - 0.02 * artL, artwork[1] - 0.02 * artW,
        artwork[0] + 0.45 * artL, artwork[1] + 0.56 * artW,
      ]
    : [
        artwork[0] - 0.02 * artL, artwork[1] + 0.06 * artW,
        artwork[2] + 0.02 * artL, artwork[3] - 0.06 * artW,
      ];
  const candidates: {
    bounds: LocalRect;
    area: number;
    ring: [number, number][];
  }[] = [];
  for (const poly of [...glyph.black, ...glyph.gray]) {
    const outer = poly[0]?.map(([x, y]) =>
      [(x - bcx) * sx, (y - bcy) * sy] as [number, number]);
    if (!outer || outer.length < 4) continue;
    const bounds = ringBounds(outer);
    const area = rectArea(bounds);
    const rectangularity = Math.abs(ringArea(outer)) / Math.max(area, 1e-9);
    const cx = (bounds[0] + bounds[2]) / 2;
    const cy = (bounds[1] + bounds[3]) / 2;
    if (kind === 'inverter') {
      if (area >= 0.003 * artArea && area <= 0.1 * artArea &&
          rectangularity >= 0.72 &&
          cx < artwork[0] + 0.45 * artL &&
          cy < artwork[1] + 0.58 * artW &&
          rectOverlapFraction(bounds, landing) >= 0.2) {
        candidates.push({ bounds, area, ring: outer });
      }
    } else if (
      area >= 0.002 * artArea && area <= 0.025 * artArea &&
      rectangularity >= 0.72 &&
      rectOverlapFraction(bounds, landing) >= 0.2 &&
      (cx < artwork[0] + 0.25 * artL || cx > artwork[0] + 0.75 * artL) &&
      Math.abs(cy - (artwork[1] + artwork[3]) / 2) < 0.42 * artW
    ) {
      candidates.push({ bounds, area, ring: outer });
    }
  }
  const candidate = candidates.sort((a, b) => b.area - a.area)[0];
  if (!candidate) return undefined;

  const pad = 0.14;
  let [minX, minY, maxX, maxY] = candidate.bounds;
  minX -= pad; minY -= pad; maxX += pad; maxY += pad;
  // ECI compound traces: open erase through the rim to the equipment edge so
  // a fused compartment does not leave a hatch island. GLB TraceGenius ink is
  // already a closed thin annulus — opening to the edge merges outer+hole into
  // a C-notch and the stroked perimeter looks gappy. Keep GLB erase interior-only.
  if (source === 'eci') {
    if (kind === 'inverter') {
      minY = -width / 2 - pad;
    } else if ((minX + maxX) / 2 < 0) {
      minX = -length / 2 - pad;
    } else {
      maxX = length / 2 + pad;
    }
  }
  return {
    sourceRing: candidate.ring,
    sourceBounds: candidate.bounds,
    eraseBounds: [minX, minY, maxX, maxY],
  };
}

/**
 * Broad cable-landing region derived from the rendered glyph envelope only,
 * never from the candidate ring selected by compartmentEraseFor.
 */
function compartmentAuditBounds(
  glyph: EciLegendGlyph,
  kind: PlacedEquipment['kind'],
  length: number,
  width: number,
  source: SymbolSource,
): LocalRect | undefined {
  const artwork = glyphLocalBounds(glyph, length, width);
  const artL = Math.max(1e-9, artwork[2] - artwork[0]);
  const artW = Math.max(1e-9, artwork[3] - artwork[1]);
  if (kind === 'inverter') {
    return [
      artwork[0] - 0.02 * artL, artwork[1] - 0.02 * artW,
      artwork[0] + 0.48 * artL, artwork[1] + 0.58 * artW,
    ];
  }
  if (kind === 'bess') {
    // The default GLB trace and older ECI trace are authored from opposite
    // ends. This source-aware region is still independent of polygon
    // detection. Limit it to the cable-landing end band so adjacent, valid
    // service-panel artwork cannot be mistaken for the retired frame.
    // localToYard applies the unit's real door/E-panel mirrors.
    return source === 'glb'
      ? [artwork[0] + 0.84 * artL, artwork[1] + 0.06 * artW,
          artwork[2] + 0.02 * artL, artwork[3] - 0.06 * artW]
      : [artwork[0] + 0.14 * artL, artwork[1] + 0.06 * artW,
          artwork[0] + 0.26 * artL, artwork[3] - 0.06 * artW];
  }
  return undefined;
}

/**
 * Semantic source inventory: these delivered variants are known to contain
 * the retired frame. This is intentionally keyed by library + glyph identity,
 * never by generated polygon order. ECI's PE inverter is the sole BESS/PCS
 * variant whose delivered trace has no standalone compartment frame.
 */
function sourceCompartmentRingExpected(
  kind: PlacedEquipment['kind'],
  source: SymbolSource,
  glyphKey: string,
): boolean {
  if (kind === 'bess') {
    return source === 'glb'
      ? glyphKey === 'lgLinkGe' || glyphKey === 'lgLinkPe'
      : glyphKey === 'lgLinkA' || glyphKey === 'lgLinkC';
  }
  if (kind === 'inverter') {
    return source === 'glb'
      ? glyphKey === 'geFlex' || glyphKey === 'peInverter'
      : glyphKey === 'geFlex';
  }
  return false;
}

export function eciSymbolForEquipment(
  eq: PlacedEquipment,
  config?: BessConfiguration,
  source: SymbolSource = 'glb'
): EciSymbolPlacement | null {
  const pe = isPeConfig(config);
  const glb = source === 'glb';
  let glyphKey: string | null = null;
  // Which library the resolved key belongs to: an ECI-mode drawing falls
  // back to the delivered GLB artwork for kinds the ECI library never had.
  let glyphSource: SymbolSource = source;
  let fx = 1, fy = 1;
  const vendorPair = VENDOR_GLYPHS[eq.kind];
  if (eq.kind === 'inverter') {
    glyphKey = glb ? vendorPair![pe ? 1 : 0] : (pe ? 'peInverter' : 'geFlex');
    // DC compartment authored at glyph bottom-left; align with layout.
    const dc = pcsCompartments(eq).find(c => c.kind === 'dc');
    if (dc) {
      const [lx, ly] = toLocal(dc.x - eq.x, dc.y - eq.y, eq.rotation);
      fx = lx > 0 ? -1 : 1;
      fy = ly > 0 ? -1 : 1;
    }
  } else if (eq.kind === 'bess') {
    // E-panel / cable-compartment corner: same world position the legacy
    // tick markers draw (drawEquipment), expressed in the local frame.
    let lx = -1, ly = 1; // default: corner at glyph left / +y, no flip
    if (eq.doorEnd && eq.epanel) {
      const rotated = Math.abs(Math.sin(eq.rotation)) > 0.5;
      const s2 = eq.epanel === 'left' ? -1 : 1;
      const [wx, wy] = rotated
        ? [s2 * (eq.width / 2 - 1), eq.doorEnd * (eq.length / 2 - 1)]
        : [s2 * (eq.length / 2 - 1), eq.doorEnd * (eq.width / 2 - 1)];
      [lx, ly] = toLocal(wx, wy, eq.rotation);
    }
    if (glb) {
      // The GLB sheets carry ONE container trace per vendor set (both rows
      // are labelled identically), so the 'A'/'C' handing the ECI library
      // encoded as two glyphs becomes a mirror across the long axis here.
      glyphKey = vendorPair![pe ? 1 : 0];
      fy = ly >= 0 ? 1 : -1;
    } else {
      // ECI library: the delivered sheets draw the two door configs as
      // separate symbols, so pick the variant instead of mirroring.
      glyphKey = ly >= 0 ? 'lgLinkA' : 'lgLinkC';
    }
    fx = lx > 0 ? -1 : 1;
  } else if (glb && vendorPair) {
    glyphKey = vendorPair[pe ? 1 : 0];
  } else if (glb) {
    glyphKey = SHARED_GLB_GLYPHS[eq.kind] ?? GLB_GAP_GLYPHS[eq.kind] ?? null;
  } else {
    glyphKey = ECI_LIBRARY_GLYPHS[eq.kind] ?? null;
    const gap = ECI_GAP_GLYPHS[eq.kind];
    if (!glyphKey && gap) {
      glyphKey = gap[pe ? 1 : 0];
      glyphSource = 'glb';
    }
  }
  if (!glyphKey) return null;
  const glyph = glyphFor(glyphKey, glyphSource);
  if (!glyph) return null;
  const [bx0, by0, bx1, by1] = glyph.body;
  const bcx = (bx0 + bx1) / 2, bcy = (by0 + by1) / 2;
  // Absolute (unmirrored) scale defines the LOCAL frame; the mirror signs
  // and rotation are part of the rigid placement on top of it.
  const asx = eq.length / Math.max(bx1 - bx0, 1e-6);
  const asy = eq.width / Math.max(by1 - by0, 1e-6);
  const sx = asx * fx, sy = asy * fy;
  const c = Math.cos(eq.rotation), s = Math.sin(eq.rotation);
  const toYard = (nx: number, ny: number): [number, number] => {
    const dx = (nx - bcx) * sx;
    const dy = (ny - bcy) * sy;
    return [eq.x + dx * c - dy * s, eq.y + dx * s + dy * c];
  };
  const toLocalFt = (nx: number, ny: number): [number, number] =>
    [(nx - bcx) * asx, (ny - bcy) * asy];
  const localToYard = (lx: number, ly: number): [number, number] => {
    const dx = lx * fx, dy = ly * fy;
    return [eq.x + dx * c - dy * s, eq.y + dx * s + dy * c];
  };
  // Same glyph at the same footprint size ⇒ identical local artwork. Mirror
  // signs are excluded on purpose: the thinning inset always moves toward a
  // ring's own interior, so it commutes with mirroring.
  const localKey = `${glyphSource}|${glyphKey}|${asx.toFixed(6)}|${asy.toFixed(6)}`;
  const sourceRingExpected =
    sourceCompartmentRingExpected(eq.kind, glyphSource, glyphKey);
  // Do not let a broad geometric heuristic erase valid service-panel detail
  // from a source variant explicitly inventoried as frame-free.
  const compartmentDetection = sourceRingExpected
    ? compartmentEraseFor(glyph, eq.kind, eq.length, eq.width, glyphSource)
    : undefined;
  const compartmentErase = compartmentDetection?.eraseBounds;
  const compartmentBounds =
    compartmentAuditBounds(glyph, eq.kind, eq.length, eq.width, glyphSource);
  if (sourceRingExpected && !compartmentErase) {
    throw new Error(
      `[symbol-compartment] ${glyphSource}/${glyphKey} is expected to contain ` +
      `a removable ${eq.kind} compartment frame, but none was detected`);
  }
  return {
    glyphKey, glyph, source: glyphSource, toYard, toLocalFt, localToYard,
    localKey, compartmentErase,
    ...(compartmentBounds ? {
      compartmentAudit: {
        bounds: compartmentBounds,
        sourceRingExpected,
        sourceRingDetected: !!compartmentDetection,
        sourceRing: compartmentDetection?.sourceRing,
        sourceRingBounds: compartmentDetection?.sourceBounds,
      },
    } : {}),
  };
}

// ---------------------------------------------------------------------------
// Yard-scale linework thinning. The delivered library was vectorized from
// raster legend crops, so its "strokes" are filled polygons ~0.8-1 ft thick
// in yard units — far heavier than the hairline linework on the reference
// sheets. At yard/plan scale that reads as solid black slabs. Thinning
// insets every ink boundary toward the ink by THIN_INSET_FT (outer rings
// shrink, holes grow), which halves stroke weight while keeping geometry,
// and drops sub-print-resolution specks that collapse entirely. Legend
// cells keep the full-weight artwork (they render large).
// ---------------------------------------------------------------------------
export const ECI_YARD_THIN_FT = 0.22;

/** Signed area (positive = CCW) of a closed ring. */
function ringArea(ring: [number, number][]): number {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i], [x2, y2] = ring[(i + 1) % ring.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

/** Proper (interior) crossing test for two segments. */
function segsCross(
  a1: [number, number], a2: [number, number],
  b1: [number, number], b2: [number, number]
): boolean {
  const det = (p: [number, number], q: [number, number], r: [number, number]) =>
    (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const s1 = det(a1, a2, b1), s2 = det(a1, a2, b2), s3 = det(b1, b2, a1), s4 = det(b1, b2, a2);
  return s1 * s2 < -1e-12 && s3 * s4 < -1e-12;
}

/** True when the closed ring has no self-intersections. */
function ringSimple(r: [number, number][]): boolean {
  for (let i = 0; i < r.length; i++) {
    for (let j = i + 2; j < r.length; j++) {
      if (i === 0 && j === r.length - 1) continue; // adjacent through closure
      if (segsCross(r[i], r[(i + 1) % r.length], r[j], r[(j + 1) % r.length])) return false;
    }
  }
  return true;
}

/**
 * Miter-offset a closed ring toward its interior (d > 0) or exterior (d < 0),
 * mirroring the clamped-miter behavior of the cable-pair offset. Returns null
 * when the ring collapses (orientation flip or near-zero area).
 */
function offsetRing(ring: [number, number][], d: number, minArea = 0.35): [number, number][] | null {
  // Dedupe near-coincident consecutive vertices first.
  const pts: [number, number][] = [];
  for (const p of ring) {
    const q = pts[pts.length - 1];
    if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-9) pts.push(p);
  }
  while (pts.length > 1 && Math.hypot(
    pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) < 1e-9) pts.pop();
  if (pts.length < 3) return null;
  const srcArea = ringArea(pts);
  if (Math.abs(srcArea) < 1e-9) return null;
  // Interior is left of travel for CCW rings; flip d for CW so positive d
  // always moves toward the ring's interior.
  const dir = srcArea > 0 ? 1 : -1;
  const n = pts.length;
  const out: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n], p1 = pts[i], p2 = pts[(i + 1) % n];
    const l1 = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) || 1;
    const l2 = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) || 1;
    // Inward normals (left of travel, CCW convention) of the two edges.
    const n1: [number, number] = [-(p1[1] - p0[1]) / l1 * dir, (p1[0] - p0[0]) / l1 * dir];
    const n2: [number, number] = [-(p2[1] - p1[1]) / l2 * dir, (p2[0] - p1[0]) / l2 * dir];
    let mx = n1[0] + n2[0], my = n1[1] + n2[1];
    const ml = Math.hypot(mx, my);
    if (ml < 1e-9) { mx = n1[0]; my = n1[1]; } else { mx /= ml; my /= ml; }
    // Clamp miter growth on sharp corners (same 0.5 dot clamp as cable pairs).
    const dot = Math.max(0.5, mx * n1[0] + my * n1[1]);
    out.push([p1[0] + mx * (d / dot), p1[1] + my * (d / dot)]);
  }
  const outArea = ringArea(out);
  // Collapsed: orientation flipped or the remaining ink is a speck.
  if (outArea * srcArea <= 0 || Math.abs(outArea) < minArea) return null;
  return out;
}

/**
 * Yard-space symbol polygons for one placement: black linework thinned by
 * `thinFt`, gray shading passed through. Shared by the DXF exporter and the
 * in-app scene overlay so every 2D/3D surface draws identical geometry.
 */
export function eciYardSymbolPolys(
  p: EciSymbolPlacement,
  thinFt: number = ECI_YARD_THIN_FT
): { black: [number, number][][][]; gray: [number, number][][][] } {
  // The thinning below is the expensive part (miter offset + O(n^2) validity
  // checks per ring), and a yard holds hundreds of units drawn from only a
  // handful of distinct symbols. It is computed in the placement's LOCAL
  // frame — footprint-centered, unrotated, unmirrored — where every unit of
  // the same kind and size is identical, then cached and replayed through
  // each unit's own rigid transform. Rotation/translation are rigid and the
  // inset always moves toward a ring's own interior (orientation-aware), so
  // mirroring commutes with it: the drawn result is unchanged.
  const cached = thinCache.get(`${p.localKey}|${thinFt}`);
  const localBlack = cached ?? thinBlackLocal(p, thinFt);
  if (!cached) {
    if (thinCache.size > 512) thinCache.clear(); // bounded; keys are few
    thinCache.set(`${p.localKey}|${thinFt}`, localBlack);
  }
  const mappedGray = p.glyph.gray.map((poly): [number, number][][] =>
    poly.map(ring => ring.map(([nx, ny]) => p.toLocalFt(nx, ny))));
  const localGray = eraseLocalPolys(mappedGray, p.compartmentErase);
  return {
    black: localBlack.map(poly => poly.map(ring => ring.map(([lx, ly]) => p.localToYard(lx, ly)))),
    gray: localGray.map(poly =>
      poly.map(ring => ring.map(([lx, ly]) => p.localToYard(lx, ly)))),
  };
}

/** Local-frame thinned linework, keyed by symbol + footprint size. */
const thinCache = new Map<string, [number, number][][][]>();

function eraseLocalPolys(
  polys: [number, number][][][],
  erase?: LocalRect,
): [number, number][][][] {
  if (!erase) return polys;
  const [x0, y0, x1, y1] = erase;
  const close = (ring: [number, number][]): [number, number][] => {
    const out = ring.map(p => [p[0], p[1]] as [number, number]);
    const first = out[0], last = out[out.length - 1];
    if (first && last &&
        (Math.abs(first[0] - last[0]) > 1e-9 || Math.abs(first[1] - last[1]) > 1e-9)) {
      out.push([first[0], first[1]]);
    }
    return out;
  };
  const clip = [[[
    [x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0],
  ]]] as [number, number][][][];
  const result: [number, number][][][] = [];
  for (const poly of polys) {
    const subject = [poly.map(close)] as [number, number][][][];
    const diff = polygonClipping.difference(subject, clip) as unknown as [number, number][][][];
    for (const outPoly of diff) {
      const rings = outPoly.map(ring => {
        const out = ring.map(([x, y]) => [x, y] as [number, number]);
        if (out.length > 1) {
          const first = out[0], last = out[out.length - 1];
          if (Math.abs(first[0] - last[0]) < 1e-9 &&
              Math.abs(first[1] - last[1]) < 1e-9) out.pop();
        }
        return out;
      }).filter(ring => ring.length >= 3);
      if (rings.length) result.push(rings);
    }
  }
  return result;
}

function thinBlackLocal(
  p: EciSymbolPlacement,
  thinFt: number
): [number, number][][][] {
  const sourceBlack = p.glyph.black.map((poly): [number, number][][] =>
    poly.map(ring => ring.map(([nx, ny]) => p.toLocalFt(nx, ny))));
  const mappedBlack = eraseLocalPolys(sourceBlack, p.compartmentErase);
  // Adaptive inset: strokes scale with the equipment footprint (a GE skid
  // symbol maps to far thinner yard-feet strokes than an LG container), so
  // estimate the mean stroke width from ink area vs boundary length
  // (width ~= 2A/P for stroke-like shapes) and thin by a fraction of it,
  // capped at `thinFt`. Fixed insets collapse small-footprint glyphs.
  let inkA = 0, perim = 0;
  for (const poly of mappedBlack) {
    for (let i = 0; i < poly.length; i++) {
      const r = poly[i];
      inkA += (i === 0 ? 1 : -1) * Math.abs(ringArea(r));
      for (let j = 0; j < r.length; j++) {
        const [x1, y1] = r[j], [x2, y2] = r[(j + 1) % r.length];
        perim += Math.hypot(x2 - x1, y2 - y1);
      }
    }
  }
  // Thinning removes ~d of ink from every boundary, so total removed area
  // ~= d * perimeter. Target roughly 40% removal: d = 0.4 * A / P, capped.
  const d = perim > 0 ? Math.min(thinFt, Math.max(0, 0.4 * inkA / perim)) : 0;
  const black: [number, number][][][] = [];
  // Speck threshold scales with the inset so small-footprint glyphs keep
  // their (proportionally small) structural marks.
  const minArea = Math.max(0.04, (3 * d) ** 2);
  // Offset with validity retry: a miter offset on concave raster-traced
  // contours can self-intersect where |d| exceeds a local feature — halve
  // the inset until the result is simple, else keep the source ring at
  // full weight (locally unthinned beats geometrically invalid: even-odd
  // hatch fills and ShapeGeometry holes both require simple rings).
  // Untangle: miter crossings on thin strokes produce small spurious loops
  // at concave corners — cut the shorter arc at each crossing until the
  // ring is simple again (bounded iterations; null when it degenerates).
  const untangle = (ring: [number, number][]): [number, number][] | null => {
    let r = ring;
    for (let iter = 0; iter < 24; iter++) {
      let cut = false;
      outer: for (let i = 0; i < r.length; i++) {
        for (let j = i + 2; j < r.length; j++) {
          if (i === 0 && j === r.length - 1) continue;
          if (segsCross(r[i], r[(i + 1) % r.length], r[j], r[(j + 1) % r.length])) {
            const inner = j - i;               // vertices i+1..j
            const outerArc = r.length - inner; // the rest
            r = inner <= outerArc
              ? [...r.slice(0, i + 1), ...r.slice(j + 1)]
              : r.slice(i + 1, j + 1);
            cut = true;
            break outer;
          }
        }
      }
      if (!cut) return r.length >= 3 ? r : null;
    }
    return null;
  };
  const offsetSimple = (
    ring: [number, number][], dd: number, mA: number
  ): [number, number][] | 'collapsed' | 'keep' => {
    const srcSign = Math.sign(ringArea(ring));
    for (let k = 0; k < 3; k++, dd /= 2) {
      const cand = offsetRing(ring, dd, mA);
      if (!cand) return k === 0 ? 'collapsed' : 'keep';
      if (ringSimple(cand)) return cand;
      const fixed = untangle(cand);
      if (fixed && Math.sign(ringArea(fixed)) === srcSign && Math.abs(ringArea(fixed)) >= mA) {
        return fixed;
      }
    }
    return 'keep';
  };
  // Even-odd renderers (DXF hatch islands, three.js ShapeGeometry) require
  // every hole to sit strictly inside its outer ring. Verify that, so an
  // aggressively thinned outer can never end up smaller than its own hole.
  const nestingValid = (rings: [number, number][][]): boolean => {
    const outerA = Math.abs(ringArea(rings[0]));
    for (let i = 1; i < rings.length; i++) {
      const h = rings[i];
      if (Math.abs(ringArea(h)) >= outerA) return false;
      let cx = 0, cy = 0;
      for (const [x, y] of h) { cx += x; cy += y; }
      if (!pointInRing([cx / h.length, cy / h.length], rings[0])) return false;
    }
    return true;
  };
  for (const poly of mappedBlack) {
    const o = offsetSimple(poly[0], d, minArea);
    if (o === 'collapsed') continue; // sub-print speck — drop whole poly
    const outer = o === 'keep' ? poly[0] : o;
    const outerArea = Math.abs(ringArea(outer));
    const rings: [number, number][][] = [outer];
    for (let i = 1; i < poly.length; i++) {
      // Grow the hole by the same adaptive inset as the outer shrank, so
      // stroke weight thins evenly from both sides. Guard: a grown hole
      // must stay strictly smaller than the shrunken outer or the even-odd
      // fill inverts — fall back to the source ring in that case.
      const h = offsetSimple(poly[i], -d, 0);
      const hole = h === 'collapsed' || h === 'keep' ? poly[i] : h;
      rings.push(Math.abs(ringArea(hole)) < outerArea ? hole : poly[i]);
    }
    // Ring-by-ring fallbacks can still leave an invalid nest: on a narrow
    // traced annulus the outer shrinks by far more area than the source
    // hole, so even the untouched source hole is no longer contained. The
    // delivered artwork is valid by construction, so drop the thinning for
    // this polygon rather than emit a shape the fill rules can't render —
    // locally unthinned beats geometrically invalid (same rule as above).
    black.push(nestingValid(rings) ? rings : poly);
  }
  return black;
}

/** Even-odd point-in-ring test (ray casting). */
function pointInRing(pt: [number, number], r: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    if ((r[i][1] > pt[1]) !== (r[j][1] > pt[1]) &&
        pt[0] < (r[j][0] - r[i][0]) * (pt[1] - r[i][1]) / (r[j][1] - r[i][1]) + r[i][0]) {
      inside = !inside;
    }
  }
  return inside;
}
