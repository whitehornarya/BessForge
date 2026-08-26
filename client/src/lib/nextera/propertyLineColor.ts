import type { SiteDesign } from './types';

// ---------------------------------------------------------------------------
// Property-line (parcel boundary) color convention — single source of truth.
//
// Drafting convention: PURPLE means property line, never blue. Every surface
// that draws the parcel boundary pulls its color from here so no surface can
// drift toward a hue a drafter could misread as other linework:
//   - 3D scene lot line (DesignScene)                 -> PROPERTY_LINE_HEX
//   - dimmed multi-area lot lines (SiteAreasOverlay)  -> PROPERTY_LINE_DIM_HEX
//   - arrangement explorer SVG thumbnail              -> PROPERTY_LINE_HEX
//   - DXF layer table (SITE_BOUNDARY)                 -> PROPERTY_LINE_ACI (6)
//   - PDF plot set (pdfPlot's paper color for ACI 6)  -> PROPERTY_LINE_FIGURE_RGB
//   - permit packet key map / contour / grounding figures and their in-panel
//     previews                                        -> PROPERTY_LINE_FIGURE_RGB
//
// Imported KMZ/CAD reference drawings reserve the purple cast for PARCEL and
// easement layers (REFERENCE_PARCEL_HEX). Every other reference layer must
// stay entirely off the blue -> violet -> purple -> magenta band so no
// reference linework can pass for the property line: isPropertyLineConfusable
// is that guard, and the main suite runs every color drawingLayerColor can
// emit through it.
// ---------------------------------------------------------------------------

/** Scene (dark background) property-line purple. */
export const PROPERTY_LINE_HEX = '#cc44cc';
/** Non-active multi-area lot lines: the same purple, dimmed toward the ground. */
export const PROPERTY_LINE_DIM_HEX = '#8a3a8a';
/** DXF layer color for SITE_BOUNDARY: ACI 6, the magenta/purple family. */
export const PROPERTY_LINE_ACI = 6;
/**
 * Paper (white background) plot purple: the RGB pdfPlot renders for ACI 6 and
 * the stroke the permit-packet vector figures use for the parcel boundary.
 */
export const PROPERTY_LINE_FIGURE_RGB: [number, number, number] = [190, 0, 190];
/** Reference-drawing PARCEL / easement layers: light purple cast. */
export const REFERENCE_PARCEL_HEX = '#d98fd9';

type FencePresentationDesign = Pick<
  SiteDesign,
  | 'propertyLineFence'
  | 'equipment'
  | 'tracedPcsUnits'
  | 'tracedContainers'
  | 'tracedAugPcsUnits'
  | 'tracedAugContainers'
  | 'tracedFuturePcsUnits'
  | 'tracedFutureContainers'
>;

/**
 * True when a generated design belongs to a KMZ-traced BESS yard whose
 * security fence is the property line.
 *
 * `propertyLineFence` is the current authoritative marker. The traced-unit
 * counters / routing-only source poses are the compatibility fingerprint for
 * designs that were already open when that marker shipped: Fast Refresh keeps
 * those older in-memory objects alive, so presentation must not wait for a
 * regeneration before removing the obsolete cyan inset perimeter.
 */
export function usesPropertyLineFence(design: FencePresentationDesign): boolean {
  if (design.propertyLineFence === true) return true;
  if ([
    design.tracedPcsUnits,
    design.tracedContainers,
    design.tracedAugPcsUnits,
    design.tracedAugContainers,
    design.tracedFuturePcsUnits,
    design.tracedFutureContainers,
  ].some(n => typeof n === 'number' && n > 0)) return true;
  return design.equipment.some(e =>
    (e.kind === 'inverter' || e.kind === 'bess') && e.traceSourcePose !== undefined);
}

/**
 * KMZ-traced BESS yards share one physical line for the property boundary and
 * security fence. Engineering keeps design.fence; visual/export surfaces omit
 * the second fence stroke/model and present the shared perimeter in purple.
 */
export function showSeparateFence(design: FencePresentationDesign): boolean {
  return !usesPropertyLineFence(design);
}

/**
 * Hue (degrees), chroma and value (both 0-255) of a #rrggbb color.
 * Neutrals report chroma 0.
 */
export function hexHueChroma(hex: string): { hue: number; chroma: number; value: number } {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return { hue: 0, chroma: 0, value: 0 };
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 0xff, g = (n >> 8) & 0xff, b = n & 0xff;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const chroma = max - min;
  if (!chroma) return { hue: 0, chroma: 0, value: max };
  let hue: number;
  if (max === r) hue = ((g - b) / chroma) % 6;
  else if (max === g) hue = (b - r) / chroma + 2;
  else hue = (r - g) / chroma + 4;
  hue *= 60;
  if (hue < 0) hue += 360;
  return { hue, chroma, value: max };
}

// The band a drafter can read as a property line: blue (200°) through violet
// and purple to magenta (345°). Colors that cannot read as a hue at line
// weight are exempt: effectively neutral (tiny chroma -> gray) or very dark
// (tiny value -> black).
export const PROPERTY_LINE_HUE_MIN = 200;
export const PROPERTY_LINE_HUE_MAX = 345;
const NEUTRAL_CHROMA = 24;
const READABLE_VALUE = 70;

/**
 * True when a color sits on the blue/purple band reserved for the property
 * line — i.e. it must never be handed to non-parcel linework.
 */
export function isPropertyLineConfusable(hex: string): boolean {
  const { hue, chroma, value } = hexHueChroma(hex);
  return chroma >= NEUTRAL_CHROMA && value >= READABLE_VALUE &&
    hue >= PROPERTY_LINE_HUE_MIN && hue < PROPERTY_LINE_HUE_MAX;
}

// ---------------------------------------------------------------------------
// Imported CAD reference drawing layer colors (3D scene underlay). The
// property-line purple band is reserved: only PARCEL / easement layers may
// take it, so every palette entry and every special-case below stays outside
// the band (warms, greens, cyans — never blue, violet, purple, or magenta).
// ---------------------------------------------------------------------------
export const DRAWING_LAYER_COLORS = [
  '#e8e3d3', '#b8e08f', '#ffd9a0', '#c9f0c0', '#e6a67f',
  '#8fd9b8', '#ffe9a8', '#a9e7e0', '#d4c96f', '#ffc0b8',
];

export function drawingLayerColor(name: string, i: number): string {
  const n = name.toUpperCase();
  // Give the layers a drafter reads as structure their conventional cast;
  // everything else cycles a readable palette so layers stay distinguishable.
  if (n.includes('ROAD') || n.includes('ACCESS')) return '#b9a98c';
  if (n.includes('PARCEL') || n.includes('ESMT') || n.includes('EASE')) return REFERENCE_PARCEL_HEX;
  if (n.includes('BESS') || n.includes('CONTAINER')) return '#7fd6e6';
  if (n.includes('INVERTER') || n.includes('PCS')) return '#7fe0a8';
  if (n.includes('SUBSTATION') || n.includes('COLLECTOR') || n.includes('MV')) return '#ffcf6b';
  // DC yards lean warm (coral — the DC(+) cast) so they can never read as the
  // blue/purple band; the old periwinkle sat exactly on it.
  if (n.includes('DC-') || n.includes('DC1') || n.includes('DC2')) return '#e88f7f';
  return DRAWING_LAYER_COLORS[i % DRAWING_LAYER_COLORS.length];
}
