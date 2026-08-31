// DXF export for the NextEra BESS 10% design.
// WYSIWYG: simple clean rectangles/polylines taken 1:1 from layout positions (feet).
import { saveBlob } from '../saveFile';
import { SiteDesign, PlacedEquipment, RoadEdgeSeg, RoadNetwork, Pt, TrenchSectionType, CableRun } from './types';
import { FeederCircuit, MAX_INVERTERS_PER_FEEDER, VD_LIMIT_PCT, AMPACITY_SOIL_RHO, AMPACITY_LOAD_FACTOR_PCT, mutualHeatingDerate } from './feeders';
import { BessConfiguration, LG_JF2, HITACHI_AUX_XFMR, AUX_SWITCHBOARD_SPEC, specForKind, EquipmentSpec, CLEARANCES, TRENCH_SECTIONS, TRENCH_CROSSING_REFERENCE } from './catalog';
import { DEFAULT_SLACK_PCT } from './catalog';
import { ECI_LOGO_ASPECT as LOGO_ASPECT, ECI_LOGO_POLYS as LOGO_POLYS } from './eciLogoVector';
import { NORTH_ARROW_ASPECT, NORTH_ARROW_POLYS } from './northArrowVector';
import { pickScale, STANDARD_SCALES_FT_PER_IN, PAGE_W_IN, PAGE_H_IN, PAGE_MARGIN_IN } from './plotScale';
import { DEFAULT_PRELIM_REV } from './revisionScheme';
import { pointInPolygon } from './kmz';
import { buildBomRows, formatBomRowText } from './bom';
import { computeBlockSpacingDims, expandDim } from './dimensions';
import { feederColor, feederLegendRows } from './feederColors';
import { legendCableClasses } from './cableLegendClasses';
import { feederDisplayName, auxDisplayName } from './feederNaming';
import { ContourSet } from './terrain';
import { GroundingPlan, GROUND_CONDUCTOR_SPEC, GROUND_ROD_SPEC } from './grounding';
import { roadCalloutData } from './roadCallouts';
import { AreaZone, AreaZoneKind, AREA_ZONE_LABELS, areaZoneKindsPresent } from './areaZones';
import { eciSymbolForEquipment, eciYardSymbolPolys } from './eciSymbolPlacement';
import { TERMS } from './terminology';
import { PROPERTY_LINE_ACI, showSeparateFence } from './propertyLineColor';
import { equipmentLabelRotation } from './sceneLabels';
import {
  DEFAULT_DRAWING_VISIBILITY,
  DrawingVisibilityProfile,
  DrawingVisibilityRule,
  drawingVisibilityRuleEnabled,
  sanitizeDrawingVisibilityProfile,
} from './drawingVisibility';

// ---------------------------------------------------------------------------
// Vendor clearance NOTES (register F-05): the LG battery-container notes are
// unconditional; the PCS note set is selected by the configured PCS OEM. A
// GE site never prints Power Electronics clearances and vice versa. If the
// configured OEM has no authored note set, a LOUD compliance finding prints
// instead of a silently wrong vendor block. Exported so tests can assert the
// OEM/note pairing without rendering a full sheet.
export function vendorNotesFor(config?: BessConfiguration): string[] {
  const notes = [
    `NOTES - LG`,
    `1. LG CONTAINERS CAN COME WITH E-PANEL ON LEFT SIDE (EPNL-1200A) OR RIGHT SIDE (EPNL-1200C).`,
    `2. CLEARANCES PER LG CIVIL DESIGN GUIDE: FRONT TO FRONT 10FT, REAR TO REAR 3FT, SIDE TO SIDE (NO E-PANEL) 3FT, FRONT TO FENCE 10FT, SIDE TO FENCE 5FT, E-PANEL TO E-PANEL 5FT (MAKE 10FT FOR OPS ACCESS).`,
  ];
  // Legacy sheets without a configuration defaulted to the GE spec
  // (specForKind does the same), so GE notes are the no-config fallback.
  const model = (config?.inverterModel ?? 'GE FLEX 1571').toUpperCase();
  if (model.includes('FP4200') || model.startsWith('PE ')) {
    notes.push(
      `NOTES - POWER ELECTRONICS`,
      `1. A MINIMUM OF 9.8FT CLEARANCE IS REQUIRED FROM THE MV SWITCHGEAR DOOR. 4.9FT IS REQUIRED FROM THE AASS TRANSFORMER SIDE. A MIN OF 6.5FT IS REQUIRED FROM THE DC CABINET AND MV TRANSFORMER DOORS. IF TWO PCS OUTLETS ARE DIRECTLY FACING EACH OTHER 19.5FT CLEARANCE IS REQUIRED.`,
    );
  } else if (model.includes('FLEX') || model.includes('GE ')) {
    // Values mirror what the layout engine enforces (CLEARANCES catalog
    // constants per CAR-D-B000-3) so the printed notes and the placement
    // rules can never disagree.
    notes.push(
      `NOTES - GE VERNOVA`,
      `1. FLEXINVERTER PCS TO BATTERY CONTAINER CLEARANCE: ${CLEARANCES.pcsHotClimate}FT REQUIRED FOR SITES WITH AMBIENT TEMPS >40 DEG C; ${CLEARANCES.pcsStandard}FT FOR SITES <40 DEG C (CAR-D-B000-3).`,
      `2. MAINTAIN OEM DOOR-SWING AND SERVICE ACCESS AT THE FLEXINVERTER MV/DC COMPARTMENTS PER GE VERNOVA INSTALLATION DOCUMENTATION; CONFIRM FINAL CLEARANCES AGAINST THE ISSUED GE INSTALLATION MANUAL BEFORE CONSTRUCTION.`,
    );
  } else {
    notes.push(
      `NOTES - PCS VENDOR`,
      `1. COMPLIANCE FINDING: NO VENDOR CLEARANCE NOTE SET IS AUTHORED FOR PCS MODEL "${config?.inverterModel ?? 'UNKNOWN'}". OBTAIN AND INCORPORATE THE OEM INSTALLATION CLEARANCES BEFORE ISSUING THIS PACKAGE.`,
    );
  }
  return notes;
}

// Layer names follow the conventions observed in the 8 NextEra reference DWGs
// (BWL/CHW/CK1/GP1/GP2/LOCK/MRG/TSO BESS xrefs): lowercase "fence",
// "EQUIP - ..." family for equipment, "A - Equipment access" for roads,
// "text-sm/lg" for annotation.
export const LAYERS = {
  BOUNDARY: 'SITE_BOUNDARY',
  FENCE: 'fence',
  EQUIP: 'EQUIP - equip main outline',
  EQUIP_LABELS: 'EQUIP - Labels',
  LAYDOWN: 'EQUIP - laydown area',
  FUTURE_BESS: 'EQUIP - future BESS blocks',
  ROAD: 'A - Equipment access',
  ROAD_HATCH: 'Hatch - road proposed',
  GRAVEL: 'Hatch - crushed rock surfacing',
  TEXT_SM: 'text-sm',
  TEXT_LG: 'text-lg',
  CABLE_DC: 'E - DC cable',
  CABLE_DC_POS: 'E - DC cable (+)',
  CABLE_DC_NEG: 'E - DC cable (-)',
  CABLE_MV: 'E - MV cable',
  CABLE_LVAC: 'E - LVAC cable',
  CABLE_AUXPWR: 'E - aux power cable',
  CABLE_FIBER: 'E - fiber optic cable',
  CABLE_FIBER_TRUNK: 'E - fiber optic trunk',
  CABLE_CATL: 'E - CATL fiber network',
  CABLE_DC_REF: 'E - DC cable future reference',
  CABLE_MV_REF: 'E - MV cable future reference',
  TRENCH: 'E - 480V aux and fiber trench',
  FEEDER: 'E - MV feeder',
  AUX_FEEDER: 'E - Aux feeder',
  DIMS: 'A - Dimensions',
  SCHEDULE: 'A - Equipment schedule',
  // Existing-grade contour reference layers (opt-in export only; the layers
  // are declared only when contours are exported so the default DXF stays
  // byte-identical).
  CONTOUR: 'C - EXISTING CONTOUR',
  CONTOUR_MAJOR: 'C - EXISTING CONTOUR MAJOR',
  // Grounding screening layer (opt-in export only; declared with its entity
  // block — never in addBaseLayers — so the default DXF stays byte-identical).
  GROUNDING: 'EQUIP - GROUNDING',
  // ECI legend symbol shading layer (opt-in, ECI legend mode only; declared
  // lazily with its first entity so the default DXF stays byte-identical).
  SYM_GRAY: 'SYM-GRAY',
  // ECI yard symbol linework, lightened for print legibility (ACI 8 dark
  // gray — the full-black artwork buried the equipment labels). Declared
  // lazily (ECI symbol mode only) so the default DXF stays byte-identical.
  SYM_DARK: 'SYM-DARK',
  // Gate swing arcs (dashed quarter circles of the double-swing gate
  // symbol). Own dashed layer in the lowercase "fence" family so the arcs
  // plot dashed on every surface while the leaves/posts stay continuous.
  GATE_SWING: 'fence - gate swing',
  // Solid white mask under every equipment label (drafting wipeout
  // equivalent): keeps tags readable over symbol artwork, compartment
  // boxes, and feeder/cable runs. Own layer so drafters can freeze it.
  LABEL_MASK: 'EQUIP - Label mask',
} as const;

const layerVisibilityRule = (layer: string): DrawingVisibilityRule | null => {
  switch (layer) {
    case LAYERS.CABLE_DC:
    case LAYERS.CABLE_DC_POS:
    case LAYERS.CABLE_DC_NEG:
    case LAYERS.CABLE_DC_REF:
      return 'pcsToBess';
    case LAYERS.CABLE_FIBER:
    case LAYERS.CABLE_FIBER_TRUNK:
    case LAYERS.CABLE_CATL:
      return 'fiber';
    case LAYERS.CABLE_LVAC:
    case LAYERS.CABLE_AUXPWR:
    case LAYERS.AUX_FEEDER:
      return 'auxiliaryCables';
    case LAYERS.TRENCH:
      return ['fiber', 'auxiliaryCables'];
    case LAYERS.DIMS:
      return 'dimensions';
    case LAYERS.EQUIP_LABELS:
    case LAYERS.LABEL_MASK:
      return 'labels';
    default:
      return null;
  }
};

// Average glyph advance of the STANDARD (txt.shx) font relative to text
// height. Used for wrapping and fit checks — conservative so panel text
// never spills past its box border.
export const CHAR_W = 0.9;

export const COLORS = {
  // Property line is always the purple/magenta family (never blue) — shared
  // convention with the scene + PDF surfaces in propertyLineColor.ts.
  BOUNDARY: PROPERTY_LINE_ACI,
  FENCE: 4,      // cyan
  EQUIP: 1,      // red
  EQUIP_LABELS: 7,
  LAYDOWN: 2,    // yellow
  // Future augmentation is monochrome per the issued 90% reference: plain
  // black/white dashed linework + ANSI37 mesh, never a color tint.
  FUTURE_BESS: 7,
  ROAD: 8,       // gray
  ROAD_HATCH: 253, // light gray fill
  GRAVEL: 9,    // light gray (crushed rock — must read as background, not linework)
  TEXT: 7,       // white/black
  CABLE_DC: 3,    // green (legacy single-run layer; future-reference stubs)
  CABLE_DC_POS: 1, // red — DC CABLE (+) per the reference detail
  CABLE_DC_NEG: 5, // blue — DC CABLE (−) per the reference detail
  CABLE_MV: 4,    // cyan
  CABLE_LVAC: 6,  // thin magenta — aux distribution 0.480 kV (spec §2)
  CABLE_AUXPWR: 200, // thin purple — aux power, AUXT to AUXSWB (spec §2)
  CABLE_FIBER: 30, // orange dashed — 6-count row drops
  CABLE_FIBER_TRUNK: 30, // orange solid — 144-count trunk to FJBs
  CABLE_CATL: 4,  // cyan dashed — CATL container comms ring
  TRENCH: 5,      // deep blue band
  FEEDER: 6,      // magenta
  AUX_FEEDER: 36,  // brown (aux feeder daisy chain, CAR-D-B005-0 legend)
  CONTOUR: 8,        // gray (minor / intermediate contours)
  CONTOUR_MAJOR: 32, // brown-orange (index contours + elevation labels)
  GROUNDING: 84,     // muted green (buried bare copper convention)
};

// Linetype dash patterns (model-space feet; negative = gap, 0 = dot).
// SINGLE SOURCE for all three plot surfaces: the DXF LTYPE table, the CAD
// view dashed materials, and the PDF dash operators all derive from these
// arrays so every cable class prints with the same pattern everywhere.
// Register F-14: each cable class carries a unique dash pattern + weight so
// classes stay distinguishable in a grayscale plot.
export const LINETYPE_PATTERNS: Record<string, number[]> = {
  CONTINUOUS: [],
  DASHED: [12.5, -2.5],
  // Short dash — LVAC aux distribution (0.480 kV).
  DASHED2: [6, -3],
  // Dash-dot — MV cable / MV feeder circuits.
  DASHDOT: [12, -3, 0, -3],
  // Dotted — aux power LV (AUXT -> AUXSWB local links).
  DOT: [0, -2.5],
  // Medium dash — 6-count fiber row drops ("orange dashed" per spec §2),
  // shorter than DASHED2 so LVAC and fiber stay distinct in grayscale.
  DASHED3: [4, -2],
  // Long-short dash — CATL container comms ring ("cyan dashed" per spec §2);
  // longer than DASHED2 so it never reads as LVAC at plot scale.
  DASHED4: [8, -3],
};

// Layer lineweights (DXF group 370, 1/100 mm). Grayscale distinguishability
// is dash-pattern-first, weight-second: feeders heaviest, fiber lightest.
export const LINE_WEIGHTS = {
  FEEDER: 50,
  DC: 35,
  LVAC: 25,
  FIBER: 18,
} as const;

// Fence "X" pattern: tick spacing + half-size of the X marks drawn along
// fence linework (plan AND legend swatch share drawFenceLine, so the legend
// symbol is the same definition the plan places).
export const FENCE_TICK_SPACING = 60;
export const FENCE_TICK_HALF = 2.2;

// CableClass -> DXF layer
const CABLE_LAYER: Record<string, string> = {
  DC: LAYERS.CABLE_DC,
  MV: LAYERS.CABLE_MV,
  LVAC: LAYERS.CABLE_LVAC,
  AUXPWR: LAYERS.CABLE_AUXPWR,
  FIBER: LAYERS.CABLE_FIBER,
  FIBER_TRUNK: LAYERS.CABLE_FIBER_TRUNK,
  CATL: LAYERS.CABLE_CATL,
};

// Text heights per reference DWGs: labels ~1.5 ft, general text 4 ft
export const LABEL_H = 2.5;
// Outside-the-box fallback lines keep the historical 1.5 ft height: taller
// fallback text widens the hanging label stack and collides with adjacent
// small panels (aux switch / fiber patch / fire control side-by-side).
export const LABEL_FALLBACK_H = 1.5;
export const TEXT_H = 4;

// Fixed handles for the R2000 skeleton (block records, tables, dictionaries).
// Drawing entities get sequential handles starting at 0x100.
const H_MSP_BR = '1F'; // *Model_Space block record = owner of all entities

// Renderer-agnostic display list recorded alongside the DXF entity stream.
// Every primitive the writer emits is mirrored here 1:1 so other renderers
// (the PDF plot set) draw exactly what the DXF contains — no drift possible.
export type DisplaySourceRenderer =
  | 'canonical-equipment'
  | 'permit-key-map-footprint'
  | 'equipment-detail'
  | 'single-line-diagram'
  | 'relay-one-line'
  | 'legend-swatch'
  | 'canonical-cable'
  | 'canonical-feeder'
  | 'canonical-future-region'
  | 'sheet-annotation';

export type DisplayGeometryRole =
  | 'resolved-symbol'
  | 'neutral-equipment-outline'
  | 'schematic-symbol'
  | 'future-equipment-outline'
  | 'future-region'
  | 'dc-conductor'
  | 'cable-conductor'
  | 'feeder-run'
  | 'feeder-membership-mark'
  | 'annotation';

export type DisplaySymbolResolution =
  | 'delivered-glb'
  | 'delivered-eci'
  | 'neutral-fallback'
  | 'not-applicable';

export interface DisplayOpProvenance {
  sourceRenderer?: DisplaySourceRenderer;
  role?: DisplayGeometryRole;
  equipmentId?: string;
  equipmentKind?: PlacedEquipment['kind'];
  symbolResolution?: DisplaySymbolResolution;
  /** Display-only pose used by semantic geometry audits; never serialized. */
  equipmentFrame?: {
    x: number;
    y: number;
    length: number;
    width: number;
    rotation: number;
    compartmentBounds?: [number, number, number, number];
  };
}

export type DisplayOp = (
  | { kind: 'line'; x1: number; y1: number; x2: number; y2: number; layer: string; color?: number }
  | { kind: 'poly'; pts: number[][]; closed: boolean; layer: string; color?: number }
  // `cx` marks composer-intended horizontal center: the DXF x is estimated
  // from a nominal glyph width, but renderers with real font metrics (PDF
  // courier is 0.6 em, not 0.8) re-center on cx so printed ink is truly
  // centered (register F-24).
  | { kind: 'text'; x: number; y: number; h: number; text: string; layer: string; rot: number; color?: number; cx?: number; cy?: number; est?: number }
  | { kind: 'arc'; cx: number; cy: number; r: number; start: number; end: number; ccw: boolean; layer: string }
  | { kind: 'hatch'; loops: number[][][]; pattern: HatchPattern; layer: string; color?: number }
) & { provenance?: DisplayOpProvenance };

// Supported hatch patterns: SOLID fill, ANSI31 diagonals, ANSI37 cross-hatch
// mesh (future augmentation areas per the issued 90% package), GRAVEL
// crosshatch (two line families approximating a crushed-rock texture).
export type HatchPattern = 'SOLID' | 'ANSI31' | 'ANSI37' | 'GRAVEL';

export class DxfWriter {
  private entities: string[] = [];
  private layers: string[] = [];
  private handle = 0x100;
  // Display list mirror of the entity stream (same order as drawn)
  readonly ops: DisplayOp[] = [];
  // Layer -> ACI color, filled by addLayer
  readonly layerColors: Record<string, number> = {};
  // Layer -> line type name ('CONTINUOUS' | 'DASHED'), filled by addLayer.
  // Display-list metadata only (CAD view dashing) — never alters the DXF
  // entity stream, so exports stay byte-identical.
  readonly layerLineTypes: Record<string, string> = {};
  // Layer -> lineweight (DXF group 370, 1/100 mm; -3 = default), filled by
  // addLayer. Mirrored into the display list so PDF plots weight per class.
  readonly layerWeights: Record<string, number> = {};
  // Dimension truth audit: every dim helper records the label it printed and
  // the distance it actually measured between its definition points, so
  // regression tests can assert text == measurement for EVERY dimension.
  readonly dimAudit: { label: string; measured: number }[] = [];
  private currentProvenance?: DisplayOpProvenance;
  readonly drawingVisibility: DrawingVisibilityProfile;
  private visibilityScope: DrawingVisibilityRule | null = null;

  constructor(drawingVisibility: DrawingVisibilityProfile = DEFAULT_DRAWING_VISIBILITY) {
    this.drawingVisibility = sanitizeDrawingVisibilityProfile(drawingVisibility);
  }

  /**
   * Attach semantic provenance to display-list operations emitted in `draw`.
   * This metadata never changes the DXF entity stream. Nested scopes merge so
   * callers can identify both the output path and the resolved geometry.
   */
  withProvenance<T>(provenance: DisplayOpProvenance, draw: () => T): T {
    const previous = this.currentProvenance;
    this.currentProvenance = { ...previous, ...provenance };
    try {
      return draw();
    } finally {
      this.currentProvenance = previous;
    }
  }

  /** Whether a caller has already identified the renderer for nested ops. */
  hasProvenanceSourceRenderer(): boolean {
    return this.currentProvenance?.sourceRenderer !== undefined;
  }

  visibilityEnabled(rule: DrawingVisibilityRule): boolean {
    return drawingVisibilityRuleEnabled(this.drawingVisibility, rule);
  }

  visibilityAllEnabled(rules: readonly DrawingVisibilityRule[]): boolean {
    return rules.every(rule => this.visibilityEnabled(rule));
  }

  withVisibility<T>(rule: DrawingVisibilityRule, emit: () => T): T | undefined {
    if (!this.visibilityEnabled(rule)) return undefined;
    const previous = this.visibilityScope;
    this.visibilityScope = rule;
    try {
      return emit();
    } finally {
      this.visibilityScope = previous;
    }
  }

  private shouldEmit(layer: string): boolean {
    return drawingVisibilityRuleEnabled(
      this.drawingVisibility,
      this.visibilityScope ?? layerVisibilityRule(layer),
    );
  }

  private record(op: DisplayOp): void {
    this.ops.push(this.currentProvenance
      ? { ...op, provenance: { ...this.currentProvenance } }
      : op);
  }

  private nextHandle(): string {
    return (this.handle++).toString(16).toUpperCase();
  }

  // Common prefix every modelspace entity needs in a valid R2000 DXF:
  // handle, owner (model space block record), AcDbEntity subclass, layer.
  private ent(type: string, layer: string): string {
    return `  0\n${type}\n  5\n${this.nextHandle()}\n330\n${H_MSP_BR}\n100\nAcDbEntity\n  8\n${layer}`;
  }

  addLayer(name: string, color: number, lineType = 'CONTINUOUS', lineWeight = -3) {
    this.layerColors[name] = color;
    this.layerLineTypes[name] = lineType;
    this.layerWeights[name] = lineWeight;
    this.layers.push(
      `  0\nLAYER\n  5\n${this.nextHandle()}\n330\n2\n100\nAcDbSymbolTableRecord\n100\nAcDbLayerTableRecord\n  2\n${name}\n 70\n0\n 62\n${color}\n  6\n${lineType}\n370\n${lineWeight}\n390\nF`
    );
  }

  addLine(x1: number, y1: number, x2: number, y2: number, layer: string, color?: number) {
    if (!this.shouldEmit(layer)) return;
    this.record({ kind: 'line', x1, y1, x2, y2, layer, color });
    let s = this.ent('LINE', layer);
    if (color !== undefined) s += `\n 62\n${color}`;
    s += `\n100\nAcDbLine\n 10\n${r(x1)}\n 20\n${r(y1)}\n 30\n0.0\n 11\n${r(x2)}\n 21\n${r(y2)}\n 31\n0.0`;
    this.entities.push(s);
  }

  addPolyline(points: number[][], layer: string, closed = false, color?: number) {
    if (points.length < 2) return;
    if (!this.shouldEmit(layer)) return;
    this.record({ kind: 'poly', pts: points, closed, layer, color });
    let s = this.ent('LWPOLYLINE', layer);
    if (color !== undefined) s += `\n 62\n${color}`;
    s += `\n100\nAcDbPolyline\n 90\n${points.length}\n 70\n${closed ? 1 : 0}`;
    points.forEach(p => { s += `\n 10\n${r(p[0])}\n 20\n${r(p[1])}`; });
    this.entities.push(s);
  }

  // Encode a text string for DXF entity bodies. Raw Unicode characters that
  // DXF/AutoCAD renders via special-code sequences must be converted here so
  // ezdxf reads them back as the expected Unicode (e.g. ezdxf converts %%d→°
  // on read; writing raw UTF-8 bytes into an R2000 file causes cp1252 mojibake).
  private static dxfEsc(text: string): string {
    return text
      .replace(/°/g, '%%d')   // degree sign  (DXF %%d → °)
      .replace(/±/g, '%%p')   // plus-minus   (DXF %%p → ±)
      .replace(/⌀/g, '%%c');  // diameter      (DXF %%c → ⌀)
  }

  addText(x: number, y: number, height: number, text: string, layer: string, rotationDeg = 0, color?: number) {
    if (!this.shouldEmit(layer)) return;
    this.record({ kind: 'text', x, y, h: height, text, layer, rot: rotationDeg, color });
    let s = this.ent('TEXT', layer);
    if (color !== undefined) s += `\n 62\n${color}`;
    s += `\n100\nAcDbText\n 10\n${r(x)}\n 20\n${r(y)}\n 30\n0.0\n 40\n${height}\n  1\n${DxfWriter.dxfEsc(text)}`;
    if (rotationDeg) s += `\n 50\n${r(rotationDeg)}`;
    s += `\n100\nAcDbText`;
    this.entities.push(s);
  }

  // Center-justified text. (cx, y) is the BASELINE CENTER of the run.
  // The DXF entity carries real horizontal justification (72=1 with a
  // second alignment point) so AutoCAD — or any CAD renderer with any
  // font — centers it exactly; no width estimate is baked into the
  // printed position (register F-24, task #649). The display-list op
  // still records an estimated left anchor (opts.est em per char) for
  // consumers that reason about text extents (decluttering, tiles),
  // plus the true center (cx/cy) so the PDF/CAD renderers center on
  // real metrics.
  addCenteredText(cx: number, y: number, height: number, text: string, layer: string,
    color?: number, opts?: { rot?: number; est?: number }) {
    if (!this.shouldEmit(layer)) return 0;
    const est = opts?.est ?? 0.8;
    const rot = opts?.rot ?? 0;
    const tw = text.length * height * est;
    const rad = (rot * Math.PI) / 180;
    const x0 = cx - Math.cos(rad) * tw / 2;
    const y0 = y - Math.sin(rad) * tw / 2;
    this.record({ kind: 'text', x: x0, y: y0, h: height, text, layer, rot, color, cx, cy: y, est });
    let s = this.ent('TEXT', layer);
    if (color !== undefined) s += `\n 62\n${color}`;
    s += `\n100\nAcDbText\n 10\n${r(x0)}\n 20\n${r(y0)}\n 30\n0.0\n 40\n${height}\n  1\n${DxfWriter.dxfEsc(text)}`;
    if (rot) s += `\n 50\n${r(rot)}`;
    s += `\n 72\n1\n 11\n${r(cx)}\n 21\n${r(y)}\n 31\n0.0`;
    s += `\n100\nAcDbText`;
    this.entities.push(s);
    return tw;
  }

  // Circular arc. start/end in radians; DXF arcs always sweep CCW from 50 to 51.
  addArc(cx: number, cy: number, radius: number, startRad: number, endRad: number, ccw: boolean, layer: string) {
    if (!this.shouldEmit(layer)) return;
    this.record({ kind: 'arc', cx, cy, r: radius, start: startRad, end: endRad, ccw, layer });
    const a1 = ((ccw ? startRad : endRad) * 180) / Math.PI;
    const a2 = ((ccw ? endRad : startRad) * 180) / Math.PI;
    this.entities.push(
      `${this.ent('ARC', layer)}\n100\nAcDbCircle\n 10\n${r(cx)}\n 20\n${r(cy)}\n 30\n0.0\n 40\n${r(radius)}\n100\nAcDbArc\n 50\n${r(((a1 % 360) + 360) % 360)}\n 51\n${r(((a2 % 360) + 360) % 360)}`
    );
  }

  // Hatch over a closed polygon boundary. SOLID fill or ANSI31 diagonal
  // lines (pattern data embedded, ~3 ft spacing at 45 deg, units = feet).
  addHatch(points: number[][], layer: string, pattern: HatchPattern, color?: number) {
    this.addHatchLoops([points], layer, pattern, color);
  }

  // Hatch with multiple boundary loops (outer boundary + island holes),
  // e.g. the connected road network region.
  addHatchLoops(loops: number[][][], layer: string, pattern: HatchPattern, color?: number) {
    const valid = loops.filter(l => l.length >= 3);
    if (!valid.length) return;
    if (!this.shouldEmit(layer)) return;
    this.record({ kind: 'hatch', loops: valid, pattern, layer, color });
    const solid = pattern === 'SOLID';
    let s = this.ent('HATCH', layer);
    if (color !== undefined) s += `\n 62\n${color}`;
    s += `\n100\nAcDbHatch\n 10\n0.0\n 20\n0.0\n 30\n0.0\n210\n0.0\n220\n0.0\n230\n1.0\n  2\n${pattern}\n 70\n${solid ? 1 : 0}\n 71\n0\n 91\n${valid.length}`;
    valid.forEach((points, i) => {
      // Loop type flags (code 92): 2 = polyline, +1 external for the outer
      // boundary, +16 outermost for island holes — with island detection
      // style "normal" (75 = 0) viewers leave the islands unfilled.
      const flags = 2 | (i === 0 ? 1 : 16);
      s += `\n 92\n${flags}\n 72\n0\n 73\n1\n 93\n${points.length}`;
      points.forEach(p => { s += `\n 10\n${r(p[0])}\n 20\n${r(p[1])}`; });
      s += `\n 97\n0`;
    });
    s += `\n 75\n0\n 76\n${solid ? 1 : 0}`;
    if (pattern === 'ANSI31') {
      // One pattern line family: 45 deg, 3 ft normal spacing
      const off = 3 / Math.SQRT2;
      s += `\n 52\n0\n 41\n1.0\n 77\n0\n 78\n1`;
      s += `\n 53\n45.0\n 43\n0.0\n 44\n0.0\n 45\n${r(-off)}\n 46\n${r(off)}\n 79\n0`;
    } else if (pattern === 'ANSI37') {
      // Cross-hatch mesh: two line families (45 / 135 deg) at 3 ft normal
      // spacing — the issued 90% package convention for future augmentation
      // areas (reads as a mesh, distinct from single-direction ANSI31).
      const off = 3 / Math.SQRT2;
      s += `\n 52\n0\n 41\n1.0\n 77\n0\n 78\n2`;
      s += `\n 53\n45.0\n 43\n0.0\n 44\n0.0\n 45\n${r(-off)}\n 46\n${r(off)}\n 79\n0`;
      s += `\n 53\n135.0\n 43\n0.0\n 44\n0.0\n 45\n${r(-off)}\n 46\n${r(-off)}\n 79\n0`;
    } else if (pattern === 'GRAVEL') {
      // Two line families (45 / 135 deg) at 8 ft normal spacing — a light
      // crosshatch that reads as crushed-rock surfacing without swamping
      // the drawing.
      const off = 8 / Math.SQRT2;
      s += `\n 52\n0\n 41\n1.0\n 77\n0\n 78\n2`;
      s += `\n 53\n45.0\n 43\n0.0\n 44\n0.0\n 45\n${r(-off)}\n 46\n${r(off)}\n 79\n0`;
      s += `\n 53\n135.0\n 43\n0.0\n 44\n0.0\n 45\n${r(-off)}\n 46\n${r(-off)}\n 79\n0`;
    }
    s += `\n 98\n0`;
    this.entities.push(s);
  }

  // Closed path of line/arc segments (road edges with corner fillets)
  addEdgePath(segs: RoadEdgeSeg[], layer: string) {
    for (const seg of segs) {
      if (seg.kind === 'line') {
        this.addLine(seg.a.x, seg.a.y, seg.b.x, seg.b.y, layer);
      } else {
        this.addArc(seg.c.x, seg.c.y, seg.r, seg.start, seg.end, seg.ccw, layer);
      }
    }
  }

  // Rotated rectangle from center/size/rotation
  addRotatedRect(cx: number, cy: number, len: number, wid: number, rot: number, layer: string, color?: number) {
    const hl = len / 2, hw = wid / 2;
    const cos = Math.cos(rot), sin = Math.sin(rot);
    const pts = [
      [-hl, -hw], [hl, -hw], [hl, hw], [-hl, hw],
    ].map(([px, py]) => [cx + px * cos - py * sin, cy + px * sin + py * cos]);
    this.addPolyline(pts, layer, true, color);
  }

  // Apply drafter text-label overrides to both the display-list ops and the
  // DXF entity strings in one pass. Called at the end of composeDesignDxf
  // (and at the end of buildSheetDxfString for package sheets) so every
  // consumer — DXF download, PDF plot, CAD view — sees the same corrected
  // coordinates and content. An empty map is a guaranteed no-op.
  //
  // Invariant: ops[i] ↔ entities[i] (every add* call pushes exactly one
  // entry to each array; early-returns on degenerate inputs skip both).
  patchTextOverridesForExport(overrides: Record<string, TextOverride>): void {
    if (!Object.keys(overrides).length) return;
    for (let i = 0; i < this.ops.length; i++) {
      const op = this.ops[i];
      if (op.kind !== 'text') continue;
      const fp = textOverrideKey(op);
      const ov = overrides[fp];
      if (!ov) continue;
      const newX = op.x + ov.dx;
      const newY = op.y + ov.dy;
      const newH = ov.h !== undefined ? ov.h : op.h;
      const newText = ov.text !== undefined ? ov.text : op.text;
      const hasCx = (op as any).cx !== undefined;
      this.ops[i] = {
        ...op,
        x: newX, y: newY, h: newH, text: newText,
        ...(hasCx ? {
          cx: (op as any).cx + ov.dx,
          cy: ((op as any).cy ?? op.y) + ov.dy,
        } : {}),
      } as DisplayOp;
      let s = this.entities[i];
      if (typeof s !== 'string') continue;
      // Patch insertion point (group 10 = X, group 20 = Y)
      s = s.replace(/\n 10\n-?[\d.]+/, `\n 10\n${r(newX)}`);
      s = s.replace(/\n 20\n-?[\d.]+/, `\n 20\n${r(newY)}`);
      if (newH !== op.h) s = s.replace(/\n 40\n-?[\d.]+/, `\n 40\n${r(newH)}`);
      if (newText !== op.text) {
        const esc = newText.replace(/°/g, '%%d').replace(/±/g, '%%p').replace(/⌀/g, '%%c');
        s = s.replace(/\n  1\n[^\n]+/, `\n  1\n${esc}`);
      }
      // For centered text: also patch the alignment point (group 11 = X, group 21 = Y)
      if (hasCx) {
        const origCx: number = (op as any).cx;
        const origCy: number = (op as any).cy ?? op.y;
        s = s.replace(/\n 11\n-?[\d.]+/, `\n 11\n${r(origCx + ov.dx)}`);
        s = s.replace(/\n 21\n-?[\d.]+/, `\n 21\n${r(origCy + ov.dy)}`);
      }
      this.entities[i] = s;
    }
  }

  // Full minimal-but-valid AC1015 (R2000) document: header with handle seed,
  // required tables (VPORT/LTYPE/LAYER/STYLE/VIEW/UCS/APPID/DIMSTYLE/
  // BLOCK_RECORD), model/paper space blocks, entities owned by model space,
  // and the root object dictionary. Strict readers (AutoCAD, ezdxf) reject
  // AC1015 files without handles/subclass markers.
  toString(): string {
    const seed = (this.handle + 0x100).toString(16).toUpperCase();
    let dxf = `  0\nSECTION\n  2\nHEADER\n  9\n$ACADVER\n  1\nAC1015\n  9\n$HANDSEED\n  5\n${seed}\n  9\n$INSUNITS\n 70\n2\n  0\nENDSEC\n`;
    dxf += `  0\nSECTION\n  2\nCLASSES\n  0\nENDSEC\n`;
    dxf += `  0\nSECTION\n  2\nTABLES\n`;
    dxf += `  0\nTABLE\n  2\nVPORT\n  5\n8\n330\n0\n100\nAcDbSymbolTable\n 70\n1\n`;
    dxf += `  0\nVPORT\n  5\n29\n330\n8\n100\nAcDbSymbolTableRecord\n100\nAcDbViewportTableRecord\n  2\n*Active\n 70\n0\n  0\nENDTAB\n`;
    dxf += `  0\nTABLE\n  2\nLTYPE\n  5\n5\n330\n0\n100\nAcDbSymbolTable\n 70\n9\n`;
    dxf += `  0\nLTYPE\n  5\n14\n330\n5\n100\nAcDbSymbolTableRecord\n100\nAcDbLinetypeTableRecord\n  2\nByBlock\n 70\n0\n  3\n\n 72\n65\n 73\n0\n 40\n0.0\n`;
    dxf += `  0\nLTYPE\n  5\n15\n330\n5\n100\nAcDbSymbolTableRecord\n100\nAcDbLinetypeTableRecord\n  2\nByLayer\n 70\n0\n  3\n\n 72\n65\n 73\n0\n 40\n0.0\n`;
    dxf += `  0\nLTYPE\n  5\n16\n330\n5\n100\nAcDbSymbolTableRecord\n100\nAcDbLinetypeTableRecord\n  2\nCONTINUOUS\n 70\n0\n  3\nSolid line\n 72\n65\n 73\n0\n 40\n0.0\n`;
    dxf += `  0\nLTYPE\n  5\n17\n330\n5\n100\nAcDbSymbolTableRecord\n100\nAcDbLinetypeTableRecord\n  2\nDASHED\n 70\n0\n  3\nDashed __ __ __\n 72\n65\n 73\n2\n 40\n15.0\n 49\n12.5\n 74\n0\n 49\n-2.5\n 74\n0\n`;
    // Cable-class linetypes (register F-14). Elements mirror LINETYPE_PATTERNS
    // exactly — the CAD view and PDF plot dash from the same arrays.
    dxf += `  0\nLTYPE\n  5\n18\n330\n5\n100\nAcDbSymbolTableRecord\n100\nAcDbLinetypeTableRecord\n  2\nDASHED2\n 70\n0\n  3\nShort dash _ _ _\n 72\n65\n 73\n2\n 40\n9.0\n 49\n6.0\n 74\n0\n 49\n-3.0\n 74\n0\n`;
    dxf += `  0\nLTYPE\n  5\n19\n330\n5\n100\nAcDbSymbolTableRecord\n100\nAcDbLinetypeTableRecord\n  2\nDASHDOT\n 70\n0\n  3\nDash dot __ . __ .\n 72\n65\n 73\n4\n 40\n18.0\n 49\n12.0\n 74\n0\n 49\n-3.0\n 74\n0\n 49\n0.0\n 74\n0\n 49\n-3.0\n 74\n0\n`;
    dxf += `  0\nLTYPE\n  5\n1A\n330\n5\n100\nAcDbSymbolTableRecord\n100\nAcDbLinetypeTableRecord\n  2\nDOT\n 70\n0\n  3\nDotted . . . .\n 72\n65\n 73\n2\n 40\n2.5\n 49\n0.0\n 74\n0\n 49\n-2.5\n 74\n0\n`;
    dxf += `  0\nLTYPE\n  5\n1E\n330\n5\n100\nAcDbSymbolTableRecord\n100\nAcDbLinetypeTableRecord\n  2\nDASHED3\n 70\n0\n  3\nMedium dash _ _ _\n 72\n65\n 73\n2\n 40\n6.0\n 49\n4.0\n 74\n0\n 49\n-2.0\n 74\n0\n`;
    dxf += `  0\nLTYPE\n  5\n22\n330\n5\n100\nAcDbSymbolTableRecord\n100\nAcDbLinetypeTableRecord\n  2\nDASHED4\n 70\n0\n  3\nLong dash __ __ __\n 72\n65\n 73\n2\n 40\n11.0\n 49\n8.0\n 74\n0\n 49\n-3.0\n 74\n0\n`;
    dxf += `  0\nENDTAB\n`;
    dxf += `  0\nTABLE\n  2\nLAYER\n  5\n2\n330\n0\n100\nAcDbSymbolTable\n 70\n${this.layers.length + 1}\n`;
    dxf += `  0\nLAYER\n  5\n10\n330\n2\n100\nAcDbSymbolTableRecord\n100\nAcDbLayerTableRecord\n  2\n0\n 70\n0\n 62\n7\n  6\nCONTINUOUS\n370\n-3\n390\nF\n`;
    dxf += this.layers.join('\n') + '\n  0\nENDTAB\n';
    dxf += `  0\nTABLE\n  2\nSTYLE\n  5\n3\n330\n0\n100\nAcDbSymbolTable\n 70\n1\n`;
    dxf += `  0\nSTYLE\n  5\n11\n330\n3\n100\nAcDbSymbolTableRecord\n100\nAcDbTextStyleTableRecord\n  2\nStandard\n 70\n0\n 40\n0.0\n 41\n1.0\n 50\n0.0\n 71\n0\n 42\n2.5\n  3\ntxt\n  4\n\n  0\nENDTAB\n`;
    dxf += `  0\nTABLE\n  2\nVIEW\n  5\n6\n330\n0\n100\nAcDbSymbolTable\n 70\n0\n  0\nENDTAB\n`;
    dxf += `  0\nTABLE\n  2\nUCS\n  5\n7\n330\n0\n100\nAcDbSymbolTable\n 70\n0\n  0\nENDTAB\n`;
    dxf += `  0\nTABLE\n  2\nAPPID\n  5\n9\n330\n0\n100\nAcDbSymbolTable\n 70\n1\n`;
    dxf += `  0\nAPPID\n  5\n12\n330\n9\n100\nAcDbSymbolTableRecord\n100\nAcDbRegAppTableRecord\n  2\nACAD\n 70\n0\n  0\nENDTAB\n`;
    dxf += `  0\nTABLE\n  2\nDIMSTYLE\n  5\nA\n330\n0\n100\nAcDbSymbolTable\n 70\n0\n100\nAcDbDimStyleTable\n 71\n0\n  0\nENDTAB\n`;
    dxf += `  0\nTABLE\n  2\nBLOCK_RECORD\n  5\n1\n330\n0\n100\nAcDbSymbolTable\n 70\n2\n`;
    dxf += `  0\nBLOCK_RECORD\n  5\n${H_MSP_BR}\n330\n1\n100\nAcDbSymbolTableRecord\n100\nAcDbBlockTableRecord\n  2\n*Model_Space\n`;
    dxf += `  0\nBLOCK_RECORD\n  5\n1B\n330\n1\n100\nAcDbSymbolTableRecord\n100\nAcDbBlockTableRecord\n  2\n*Paper_Space\n  0\nENDTAB\n`;
    dxf += `  0\nENDSEC\n`;
    dxf += `  0\nSECTION\n  2\nBLOCKS\n`;
    dxf += `  0\nBLOCK\n  5\n20\n330\n${H_MSP_BR}\n100\nAcDbEntity\n  8\n0\n100\nAcDbBlockBegin\n  2\n*Model_Space\n 70\n0\n 10\n0.0\n 20\n0.0\n 30\n0.0\n  3\n*Model_Space\n  1\n\n`;
    dxf += `  0\nENDBLK\n  5\n21\n330\n${H_MSP_BR}\n100\nAcDbEntity\n  8\n0\n100\nAcDbBlockEnd\n`;
    dxf += `  0\nBLOCK\n  5\n1C\n330\n1B\n100\nAcDbEntity\n 67\n1\n  8\n0\n100\nAcDbBlockBegin\n  2\n*Paper_Space\n 70\n0\n 10\n0.0\n 20\n0.0\n 30\n0.0\n  3\n*Paper_Space\n  1\n\n`;
    dxf += `  0\nENDBLK\n  5\n1D\n330\n1B\n100\nAcDbEntity\n 67\n1\n  8\n0\n100\nAcDbBlockEnd\n`;
    dxf += `  0\nENDSEC\n`;
    dxf += `  0\nSECTION\n  2\nENTITIES\n`;
    dxf += this.entities.join('\n') + '\n  0\nENDSEC\n';
    dxf += `  0\nSECTION\n  2\nOBJECTS\n`;
    dxf += `  0\nDICTIONARY\n  5\nC\n330\n0\n100\nAcDbDictionary\n281\n1\n  3\nACAD_GROUP\n350\nD\n`;
    dxf += `  0\nDICTIONARY\n  5\nD\n330\nC\n100\nAcDbDictionary\n281\n1\n`;
    dxf += `  0\nENDSEC\n`;
    dxf += `  0\nEOF\n`;
    return dxf;
  }
}

export interface RedOperationCensusEntry {
  opIndex: number;
  primitive: DisplayOp['kind'];
  layer: string;
  effectiveAci: number;
  closed: boolean;
  pointCount: number;
  sourceRenderer: DisplaySourceRenderer | 'unattributed';
  role: DisplayGeometryRole | 'unattributed';
  equipmentId?: string;
  equipmentKind?: PlacedEquipment['kind'];
  symbolResolution: DisplaySymbolResolution | 'unattributed';
}

function displayOpClosed(op: DisplayOp): boolean {
  return op.kind === 'poly' ? op.closed : op.kind === 'hatch';
}

function displayOpPointCount(op: DisplayOp): number {
  if (op.kind === 'poly') return op.pts.length;
  if (op.kind === 'hatch') return op.loops.reduce((n, loop) => n + loop.length, 0);
  if (op.kind === 'line') return 2;
  return 0;
}

/**
 * Semantic census of every ACI-1 operation in the canonical display list.
 * Consumers can distinguish intended open positive-DC conductors and future
 * regions from built-equipment fallbacks without guessing from coordinates.
 */
export function censusRedOperations(
  ops: readonly DisplayOp[],
  layerColors: Readonly<Record<string, number>>,
): RedOperationCensusEntry[] {
  const rows: RedOperationCensusEntry[] = [];
  ops.forEach((op, opIndex) => {
    const effectiveAci = ('color' in op ? op.color : undefined) ?? layerColors[op.layer];
    if (effectiveAci !== 1) return;
    rows.push({
      opIndex,
      primitive: op.kind,
      layer: op.layer,
      effectiveAci,
      closed: displayOpClosed(op),
      pointCount: displayOpPointCount(op),
      sourceRenderer: op.provenance?.sourceRenderer ?? 'unattributed',
      role: op.provenance?.role ?? 'unattributed',
      equipmentId: op.provenance?.equipmentId,
      equipmentKind: op.provenance?.equipmentKind,
      symbolResolution: op.provenance?.symbolResolution ?? 'unattributed',
    });
  });
  return rows;
}

/**
 * Closed red built-equipment/cable-box violations. Intended red future or
 * exclusion regions are explicitly exempt; open red conductors remain valid.
 * The layer fallback also catches a newly introduced unattributed rectangle.
 */
export function findClosedRedCableBoxes(
  ops: readonly DisplayOp[],
  layerColors: Readonly<Record<string, number>>,
): RedOperationCensusEntry[] {
  const intendedClosedRole = new Set<DisplayGeometryRole>([
    'future-equipment-outline',
    'future-region',
  ]);
  return censusRedOperations(ops, layerColors).filter(row => {
    if (!row.closed || row.primitive !== 'poly' || row.pointCount < 3) return false;
    if (row.role !== 'unattributed' && intendedClosedRole.has(row.role)) return false;
    return row.pointCount === 4 ||
      row.layer === LAYERS.EQUIP ||
      row.role === 'neutral-equipment-outline' ||
      row.role === 'resolved-symbol' ||
      row.role === 'feeder-membership-mark' ||
      row.equipmentId !== undefined;
  });
}

export interface ResolvedCompartmentRingEntry {
  opIndex: number;
  loopIndex: number;
  primitive: 'poly' | 'hatch';
  layer: string;
  equipmentId: string;
  equipmentKind: 'bess' | 'inverter';
  symbolResolution: 'delivered-glb' | 'delivered-eci';
  localBounds: [number, number, number, number];
  rectangularity: number;
}

function unsignedRingArea(ring: readonly number[][]): number {
  let area2 = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    area2 += a[0] * b[1] - b[0] * a[1];
  }
  return Math.abs(area2) / 2;
}

/**
 * Color-independent audit for the retired compartment frames embedded in
 * delivered BESS/PCS artwork. Provenance selects only resolved built symbols;
 * the equipment frame then measures each closed loop in its unrotated local
 * coordinates. This deliberately ignores future regions, imported drawings,
 * fallback footprints, detail-sheet boxes, and every open conductor.
 */
export function findResolvedCompartmentRings(
  ops: readonly DisplayOp[],
): ResolvedCompartmentRingEntry[] {
  const rows: ResolvedCompartmentRingEntry[] = [];
  ops.forEach((op, opIndex) => {
    const provenance = op.provenance;
    const equipmentKind = provenance?.equipmentKind;
    const symbolResolution = provenance?.symbolResolution;
    const frame = provenance?.equipmentFrame;
    if (provenance?.role !== 'resolved-symbol' ||
        (equipmentKind !== 'bess' && equipmentKind !== 'inverter') ||
        (symbolResolution !== 'delivered-glb' && symbolResolution !== 'delivered-eci') ||
        !provenance.equipmentId || !frame?.compartmentBounds) return;
    const loops = op.kind === 'hatch'
      ? op.loops
      : op.kind === 'poly' && op.closed
        ? [op.pts]
        : [];
    const c = Math.cos(frame.rotation), s = Math.sin(frame.rotation);
    loops.forEach((loop, loopIndex) => {
      if (loop.length < 4) return;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      const local = loop.map(([x, y]) => {
        const dx = x - frame.x, dy = y - frame.y;
        const p = [dx * c + dy * s, -dx * s + dy * c];
        minX = Math.min(minX, p[0]); minY = Math.min(minY, p[1]);
        maxX = Math.max(maxX, p[0]); maxY = Math.max(maxY, p[1]);
        return p;
      });
      const spanX = maxX - minX, spanY = maxY - minY;
      const boxArea = spanX * spanY;
      if (boxArea <= 1e-6) return;
      const rectangularity = unsignedRingArea(local) / boxArea;
      // The ECI GE PCS frame is fused into one compound authored contour;
      // its enclosure is still rectangle-dominant but not a perfect box.
      if (rectangularity < 0.7) return;
      const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
      const target = frame.compartmentBounds!;
      const overlap = Math.max(0, Math.min(maxX, target[2]) - Math.max(minX, target[0])) *
        Math.max(0, Math.min(maxY, target[3]) - Math.max(minY, target[1]));
      if (overlap / boxArea < 0.2) return;
      const forbidden = equipmentKind === 'inverter'
        ? spanX >= 2.5 && spanX <= 8 && spanY >= 0.45 && spanY <= 2.5 &&
          Math.abs(cx) > 0.15 * frame.length && Math.abs(cy) > 0.05 * frame.width
        : spanX >= 0.45 && spanX <= 3.5 && spanY >= 0.7 && spanY <= 3 &&
          Math.abs(cx) > 0.3 * frame.length && Math.abs(cy) < 0.4 * frame.width;
      if (!forbidden) return;
      rows.push({
        opIndex,
        loopIndex,
        primitive: op.kind as 'poly' | 'hatch',
        layer: op.layer,
        equipmentId: provenance.equipmentId!,
        equipmentKind,
        symbolResolution,
        localBounds: [minX, minY, maxX, maxY],
        rectangularity,
      });
    });
  });
  return rows;
}

// ---------------------------------------------------------------------------
// Text-label override types (shared by the store, CAD view, and exporters).
// ---------------------------------------------------------------------------

// Drafter position / height / content delta for a single text label.
// Keyed by textOverrideKey(op) so the override survives re-layout as long as
// the label text and generated position round to the same integers.
export interface TextOverride {
  /** X offset from the generated anchor (layout feet, right = +). */
  dx: number;
  /** Y offset from the generated anchor (layout feet, up = +). */
  dy: number;
  /** Override text content (absent = keep generated value). */
  text?: string;
  /** Override text height in layout feet (absent = keep generated value). */
  h?: number;
}

// Fingerprint key for a text display-list op. Built from the raw generated
// coordinates (before any override is applied) so the key is stable.
export function textOverrideKey(op: { layer: string; text: string; x: number; y: number }): string {
  return `${op.layer}|${op.text}|${Math.round(op.x)}|${Math.round(op.y)}`;
}

function r(n: number): string {
  return n.toFixed(3);
}

// Reference naming per the current standard: PCS<FF>-<UU> for PCS units and
// CON<FFUU>-A-<n> for containers (FF = feeder number, UU = unit position on
// the feeder). Those labels are computed by labels.ts and stored on
// eq.label; this function returns them, falling back to the legacy id-based
// naming for designs saved before reference labels existed.
// Kinds whose printed tag is fixed by the guidance drawings, so a stored or
// catalog display name never overrides it.
const FIXED_TAG_KINDS = new Set<PlacedEquipment['kind']>([
  'auxTransformer', 'auxSwitchgear', 'auxSwitchPanel', 'fiberPatchPanel', 'fireControlPanel',
]);

export function nexteraLabel(eq: PlacedEquipment): string {
  const parts = eq.id.split('-');
  // Traced / hand-placed single equipment (peq-<n>) carries its own label
  // assigned at apply time ("PCS 12", "BATT 34", "CONEX 2"). The legacy
  // id-based fallbacks below would print "BATT 123-undefined" for these ids.
  if (parts[0] === 'peq') {
    // Traced gear carries the drawn name. Catalog-driven manual gear keeps the
    // guidance tag for its kind (AUX 100, FIRE CONTROL PANEL, ...), which the
    // kind branches below own — its catalog label is only a picker name.
    if (eq.label && !FIXED_TAG_KINDS.has(eq.kind)) return eq.label;
    if (eq.kind === 'bess') return `BATT ${parts[1]}`;
    if (eq.kind === 'inverter') return `PCS ${parts[1]}`;
    if (eq.kind === 'conex') return `CONEX ${parts[1]}`;
  }
  if (eq.kind === 'conex') return eq.label || 'CONEX';
  // Traced comms manhole placeholder — its own tag, never the fire-control
  // fallthrough (manholes carry fiber/comms runs; see FJB comms convention).
  if (eq.kind === 'manhole') return eq.label || 'COMMS MANHOLE';
  if (eq.kind === 'bess') {
    if (eq.label && /^CON\d/.test(eq.label)) return eq.label;
    // Legacy fallback: E-panel variant suffix (A)=EPNL-1200A, (C)=EPNL-1200C
    const variant = eq.epanel === 'left' ? ' (A)' : eq.epanel === 'right' ? ' (C)' : '';
    return `BATT ${parts[1]}-${parts[2]}${variant}`;
  }
  if (eq.kind === 'inverter') {
    if (eq.label && /^PCS\d/.test(eq.label)) return eq.label;
    return `PCS ${parts[1]}`;
  }
  if (eq.kind === 'auxTransformer') return 'AUX 100';
  if (eq.kind === 'auxSwitchgear') return 'AUX 101';
  if (eq.kind === 'auxSwitchPanel') return 'AUX SWITCH PANEL';
  if (eq.kind === 'fiberPatchPanel') return 'FIBER PATCH PANEL';
  if (eq.kind === 'feederJunctionBox') return eq.label || 'FEEDER JUNCTION BOX';
  if (eq.kind === 'commsCabinet') {
    // A communications cabinet is never a junction box (delivered redline:
    // the cabinet printed as "FJB"). A stale or imported label that names one
    // is dropped rather than printed, so the kind always reads as itself.
    const own = eq.label && !/\bFJB\b|JUNCTION\s*BOX/i.test(eq.label) ? eq.label : '';
    return own || 'COMMS CABINET';
  }
  // Substation yard kinds carry their own label (the feeder position names the
  // BESS area it collects). Without this they fell through to the FIRE CONTROL
  // PANEL default below, which is the wrong tag on a substation drawing.
  // Traced generator placeholder (KMZ auto-fill) — its own tag, never the
  // fire-control fallthrough.
  if (eq.kind === 'generator') return eq.label || 'GENERATOR';
  if (eq.kind === 'substationFeeder') return eq.label || 'COLLECTOR FEEDER';
  if (eq.kind === 'mainTransformer') return eq.label || 'MAIN POWER TRANSFORMER';
  if (eq.kind === 'mvSwitchgear') return eq.label || 'COLLECTOR SWITCHGEAR';
  if (eq.kind === 'controlHouse') return eq.label || 'CONTROL HOUSE';
  return 'FIRE CONTROL PANEL';
}

// Second label line: model + rating summary from the manufacturer specs
// (task example: "INV 1" + "PE FP4200M 4200kVA"). Kept short so the line
// stays legible at LABEL_H and does not overlap neighboring blocks.
// Panels (aux switch / fiber patch / fire control) keep single-line labels —
// their name already is the identity and there is no meaningful model line.
// Every possible model/rating spec line — single source of truth shared
// with the enlarged tiles, which declutter these repeated boilerplate lines
// so the identity tags get the boosted space (task: labels must never pile
// on top of each other on the AREA tiles).
export const SPEC_LABEL_LINES = [
  'LG JF2 DC LINK 5.1MWH',
  'PE FP4200M 4200KVA',
  'GE FLEX 1571 4.02MW',
  // Vendor names per the delivered equipment legend artwork (TERMS): the
  // auxiliary transformer prints as ABB HITACHI on the plan, not as a bare
  // voltage class.
  'ABB HITACHI 34.5KV-480V',
  'LSE2000FMCD 2000A',
] as const;

export function nexteraSpecLabel(eq: PlacedEquipment, config?: BessConfiguration): string | null {
  switch (eq.kind) {
    case 'bess': return SPEC_LABEL_LINES[0];
    case 'inverter':
      return config?.inverterModel === 'PE FP4200M'
        ? SPEC_LABEL_LINES[1]
        : SPEC_LABEL_LINES[2];
    case 'auxTransformer': return SPEC_LABEL_LINES[3];
    case 'auxSwitchgear': return SPEC_LABEL_LINES[4];
    default: return null;
  }
}

// ---------------------------------------------------------------------
// Equipment label layout: tag + spec text placed INSIDE the equipment
// rectangle, centered both ways, running along the box's long axis and
// auto-shrunk to fit — so labels can never spill into a neighboring
// block's title text (user-reported overlap in the CAD view). Shared by
// drawEquipment (DXF/CAD/PDF via the display list) and the tests.
export interface PlacedLabelLine {
  x: number;    // TEXT baseline-left anchor (plan ft)
  y: number;
  h: number;    // text height (ft)
  text: string;
  rot: number;  // exact plan rotation (deg)
}

// Minimum in-box text height: below this the box is too small to hold its
// label legibly, so the layout falls back to a single centered line just
// below the box (small standalone panels — never adjacent to another
// labeled block in the standard layouts).
export const LABEL_MIN_H = 0.7;

const CALLOUT_KINDS: ReadonlySet<PlacedEquipment['kind']> = new Set<PlacedEquipment['kind']>([
  'auxTransformer', 'auxSwitchgear', 'commsCabinet',
]);
export function equipmentLabelLayout(
  eq: PlacedEquipment,
  config?: BessConfiguration,
  ctx?: LabelContext
): PlacedLabelLine[] {
  if (ctx && CALLOUT_KINDS.has(eq.kind)) {
    const callout = calloutLabelLayout(eq, config, ctx.equipment);
    if (callout) return callout;
  }
  const tag = nexteraLabel(eq);
  const spec = nexteraSpecLabel(eq, config);
  // Axis-aligned extents remain useful for the legacy below-box fallback.
  const rotated = Math.abs(Math.sin(eq.rotation)) > 0.5;
  const xLen = rotated ? eq.width : eq.length;
  const yLen = rotated ? eq.length : eq.width;
  // In-box text runs in the equipment's own long-axis frame. This retains
  // 180° PCS facing and arbitrary traced/placed rotations instead of reducing
  // every label to a world-horizontal/world-vertical axis.
  const vertical = yLen > xLen;
  const lengthIsLong = eq.length >= eq.width;
  const along = (lengthIsLong ? eq.length : eq.width) * 0.88;
  const across = (lengthIsLong ? eq.width : eq.length) * 0.8;
  const GAPF = 0.45; // line gap as a fraction of text height

  // Per-line fit: each line takes the tallest height its own string allows
  // along the long axis (so a short identity tag is not shrunk down to the
  // long model/rating line's height), then the whole stack scales down
  // together if it exceeds the across budget.
  const fit = (lines: string[]): { hs: number[]; lines: string[] } => {
    let hs = lines.map(l => Math.min(LABEL_H, along / (l.length * CHAR_W)));
    const gaps = (lines.length - 1) * GAPF * (hs.reduce((s, h) => s + h, 0) / lines.length);
    const total = hs.reduce((s, h) => s + h, 0) + gaps;
    if (total > across) hs = hs.map(h => h * (across / total));
    return { hs, lines };
  };

  const allLines = labelLinesFor(eq, config);
  const best = fit(allLines);
  if (Math.min(...best.hs) < LABEL_MIN_H) {
    // Too small to label inside legibly: fall back to a below-the-box
    // placement, keeping EVERY line (spec-line parity with the preview is
    // a hard test invariant). Lines run VERTICALLY (90 deg, reading
    // bottom-to-top) hanging under the box so the label footprint stays
    // within the box's x-extent — side-by-side small panels (aux switch /
    // fiber patch / fire control) would collide with horizontal text.
    const g = LABEL_FALLBACK_H * 0.45;
    const n = allLines.length;
    const total = n * LABEL_FALLBACK_H + (n - 1) * g;
    return allLines.map((text, i) => {
      const w = text.length * CHAR_W * LABEL_FALLBACK_H;
      return {
        x: eq.x - total / 2 + LABEL_FALLBACK_H + i * (LABEL_FALLBACK_H + g),
        y: eq.y - yLen / 2 - 2.5 - w,
        h: LABEL_FALLBACK_H, text, rot: 90,
      };
    });
  }
  const { hs, lines } = best;
  const g = GAPF * (hs.reduce((s, h) => s + h, 0) / hs.length);
  const total = hs.reduce((s, h) => s + h, 0) + (hs.length - 1) * g;
  const out: PlacedLabelLine[] = [];
  let adv = 0; // stack advance across the lines placed so far
  const rawAxis = lengthIsLong ? eq.rotation : eq.rotation + Math.PI / 2;
  const labelRad = eq.kind === 'inverter'
    ? equipmentLabelRotation(eq, ctx?.equipment, ctx?.cables)
    : Math.atan2(Math.sin(2 * rawAxis), Math.cos(2 * rawAxis)) / 2;
  const cos = Math.cos(labelRad), sin = Math.sin(labelRad);
  const rot = ((labelRad * 180 / Math.PI) % 360 + 360) % 360;
  const toWorld = (lx: number, ly: number) => ({
    x: eq.x + lx * cos - ly * sin,
    y: eq.y + lx * sin + ly * cos,
  });
  lines.forEach((text, i) => {
    const h = hs[i];
    const w = text.length * CHAR_W * h;
    // Baseline-left anchor in label-local coordinates. Rotating both the
    // anchor and TEXT entity preserves the exact centered stack at 0/90/180/
    // 270 degrees and at arbitrary customer-drawing angles.
    const p = toWorld(-w / 2, total / 2 - adv - h);
    out.push({ x: p.x, y: p.y, h, text, rot });
    adv += h + g;
  });
  return out;
}

// Tessellate a closed line/arc edge path into a point loop (for HATCH
// boundary loops — arcs approximated with short chords, still 1:1 from layout)
function edgePathToLoop(segs: RoadEdgeSeg[]): number[][] {
  const pts: number[][] = [];
  const push = (x: number, y: number) => {
    const last = pts[pts.length - 1];
    if (!last || Math.hypot(x - last[0], y - last[1]) > 0.05) pts.push([x, y]);
  };
  for (const seg of segs) {
    if (seg.kind === 'line') {
      push(seg.a.x, seg.a.y);
      push(seg.b.x, seg.b.y);
    } else {
      let { start, end } = seg;
      if (seg.ccw && end < start) end += Math.PI * 2;
      if (!seg.ccw && end > start) end -= Math.PI * 2;
      const steps = Math.max(4, Math.ceil(Math.abs(end - start) / 0.15));
      for (let i = 0; i <= steps; i++) {
        const a = start + ((end - start) * i) / steps;
        push(seg.c.x + seg.r * Math.cos(a), seg.c.y + seg.r * Math.sin(a));
      }
    }
  }
  return pts;
}

// Road width + typical turning radius callouts near the perimeter road,
// leadered outward (away from the yard) so they clear equipment labels.
function addRoadCallouts(dxf: DxfWriter, road: RoadNetwork) {
  if (!dxf.visibilityAllEnabled(['dimensions', 'labels'])) return;
  // Placement math shared 1:1 with the 3D preview (roadCallouts.ts) — the
  // on-screen callouts and the exported drawing always agree.
  const data = roadCalloutData(road);
  if (!data) return;

  for (const c of data.radius) {
    dxf.addLine(c.from.x, c.from.y, c.end.x, c.end.y, LAYERS.ROAD);
    // Short horizontal landing + text to the side away from the site center
    dxf.addLine(c.end.x, c.end.y, c.land.x, c.land.y, LAYERS.ROAD);
    const tw = c.text.length * TEXT_H * 0.8;
    dxf.addText(c.side > 0 ? c.land.x + 2 : c.land.x - 2 - tw, c.land.y - TEXT_H / 2, TEXT_H, c.text, LAYERS.TEXT_SM);
  }

  // Road width label along the longest straight outer segment, rotated with
  // the road and placed inside the road band (between outer and inner edges)
  const w = data.width;
  if (w) {
    dxf.addCenteredText(w.x, w.y, TEXT_H, w.text, LAYERS.TEXT_SM, undefined, { rot: w.angDeg });
  }
}

// ---------------------------------------------------------------------
// Spacing / clearance dimensions, per the NextEra guidance sheets (2-9):
// typical equipment gaps (container side gap, row front-to-front, PCS
// clearance), fence <-> lot-line setback, min BESS <-> lot line (NFPA 855)
// and overall fence extents. Classic extension-line + dim-line + oblique
// tick style, all 1:1 from layout positions on a dedicated layer.
const DIM_H = 4;          // dim text height (matches text-sm 4 ft standard)
const TICK = 2;           // oblique tick half-length

function dimTick(dxf: DxfWriter, x: number, y: number, ang: number) {
  // 45-degree tick across the dim line direction `ang`
  const a = ang + Math.PI / 4;
  dxf.addLine(x - Math.cos(a) * TICK, y - Math.sin(a) * TICK, x + Math.cos(a) * TICK, y + Math.sin(a) * TICK, LAYERS.DIMS);
}

// Horizontal dimension: measures xb - xa, extension lines rising (or
// dropping) from yRef to the dim line at yDim, text centered above.
// yRefB: optional separate extension-line origin for the far end — used when
// the two definition points sit at different offsets (e.g. a skewed fence
// whose min-x and max-x vertices have different y). Register F-19: extension
// lines must land ON the geometry being measured, not on the bounding box.
export function dimH(dxf: DxfWriter, xa: number, xb: number, yRef: number, yDim: number, label: string, yRefB = yRef) {
  dxf.dimAudit.push({ label, measured: Math.abs(xb - xa) });
  const over = 1.5 * Math.sign(yDim - yRef || 1);
  dxf.addLine(xa, yRef, xa, yDim + over, LAYERS.DIMS);
  dxf.addLine(xb, yRefB, xb, yDim + over, LAYERS.DIMS);
  dxf.addLine(xa, yDim, xb, yDim, LAYERS.DIMS);
  dimTick(dxf, xa, yDim, 0);
  dimTick(dxf, xb, yDim, 0);
  dxf.addCenteredText((xa + xb) / 2, yDim + 1, DIM_H, label, LAYERS.DIMS, undefined, { est: CHAR_W });
}

// Vertical dimension: measures yb - ya at xDim, text rotated 90.
export function dimV(dxf: DxfWriter, ya: number, yb: number, xRef: number, xDim: number, label: string, xRefB = xRef) {
  dxf.dimAudit.push({ label, measured: Math.abs(yb - ya) });
  const over = 1.5 * Math.sign(xDim - xRef || 1);
  dxf.addLine(xRef, ya, xDim + over, ya, LAYERS.DIMS);
  dxf.addLine(xRefB, yb, xDim + over, yb, LAYERS.DIMS);
  dxf.addLine(xDim, ya, xDim, yb, LAYERS.DIMS);
  dimTick(dxf, xDim, ya, Math.PI / 2);
  dimTick(dxf, xDim, yb, Math.PI / 2);
  dxf.addCenteredText(xDim - 1, (ya + yb) / 2, DIM_H, label, LAYERS.DIMS, undefined, { rot: 90, est: CHAR_W });
}

// Aligned point-to-point dimension (setbacks): dim line directly between
// the two points, ticks at both ends, text along the line.
function dimAligned(dxf: DxfWriter, a: Pt, b: Pt, label: string) {
  dxf.dimAudit.push({ label, measured: Math.hypot(b.x - a.x, b.y - a.y) });
  dxf.addLine(a.x, a.y, b.x, b.y, LAYERS.DIMS);
  const ang = Math.atan2(b.y - a.y, b.x - a.x);
  dimTick(dxf, a.x, a.y, ang);
  dimTick(dxf, b.x, b.y, ang);
  let deg = (ang * 180) / Math.PI;
  if (deg > 90) deg -= 180;
  if (deg <= -90) deg += 180;
  const rad = (deg * Math.PI) / 180;
  const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
  // offset text to the left of the dim line direction
  const ox = -Math.sin(rad) * (DIM_H * 0.6), oy = Math.cos(rad) * (DIM_H * 0.6);
  dxf.addCenteredText(mx + ox, my + oy, DIM_H, label, LAYERS.DIMS, undefined, { rot: deg, est: CHAR_W });
}

// Axis-aligned half-extents of a placed equipment rect (rotations are
// multiples of 90 deg in this layout engine).
function halfExtents(eq: PlacedEquipment): { hx: number; hy: number } {
  const c = Math.abs(Math.cos(eq.rotation)), s = Math.abs(Math.sin(eq.rotation));
  return { hx: (eq.length / 2) * c + (eq.width / 2) * s, hy: (eq.length / 2) * s + (eq.width / 2) * c };
}

// Distance from a point to a polygon (segments), with the foot point.
function distToPolygon(p: Pt, poly: Pt[]): { d: number; foot: Pt } {
  let best = { d: Infinity, foot: poly[0] };
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const abx = b.x - a.x, aby = b.y - a.y;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / (abx * abx + aby * aby || 1)));
    const f = { x: a.x + abx * t, y: a.y + aby * t };
    const d = Math.hypot(p.x - f.x, p.y - f.y);
    if (d < best.d) best = { d, foot: f };
  }
  return best;
}

export function addSpacingDimensions(dxf: DxfWriter, design: SiteDesign, includeNfpa = true) {
  if (!dxf.visibilityEnabled('dimensions')) return;
  const eqs = design.equipment;
  const bess = eqs.filter(e => e.kind === 'bess');
  const invs = eqs.filter(e => e.kind === 'inverter');
  const typ = (gap: number) => `${ftIn(gap)} (TYP)`;

  // 1) Container side-to-side gap: adjacent containers in the NORTH-most
  // row (dim drawn above them, clear of the yard).
  const topRowY = bess.length ? Math.max(...bess.map(b => b.y)) : 0;
  const topRow = bess.filter(b => Math.abs(b.y - topRowY) < 0.5).sort((a, b) => a.x - b.x);
  if (topRow.length >= 2) {
    const a = topRow[0], b = topRow[1];
    const ha = halfExtents(a), hb = halfExtents(b);
    const xa = a.x + ha.hx, xb = b.x - hb.hx;
    if (xb - xa > 0.2) {
      const yTop = Math.max(a.y + ha.hy, b.y + hb.hy);
      dimH(dxf, xa, xb, yTop, yTop + 8, typ(xb - xa));
    }
  }

  // 2) Container row front-to-front gap: two containers stacked in x-line
  // with the smallest positive vertical gap (dim to the left of the pair).
  {
    let best: { a: PlacedEquipment; b: PlacedEquipment; gap: number } | null = null;
    for (const a of bess) for (const b of bess) {
      if (a === b || Math.abs(a.x - b.x) > 0.5 || b.y <= a.y) continue;
      const gap = (b.y - halfExtents(b).hy) - (a.y + halfExtents(a).hy);
      if (gap > 0.2 && (!best || gap < best.gap)) best = { a, b, gap };
    }
    if (best) {
      const ya = best.a.y + halfExtents(best.a).hy, yb = best.b.y - halfExtents(best.b).hy;
      const xL = Math.min(best.a.x - halfExtents(best.a).hx, best.b.x - halfExtents(best.b).hx);
      dimV(dxf, ya, yb, xL, xL - 8, typ(best.gap));
    }
  }

  // 3) PCS clearance: inverter to its NEAREST container edge, in whichever
  // direction that neighbor sits (guidance sheet 2: 14'-0" / 10'-0").
  if (invs.length) {
    type Cand = { inv: PlacedEquipment; c: PlacedEquipment; gap: number; horiz: boolean };
    let best: Cand | null = null;
    for (const inv of invs) {
      const hi = halfExtents(inv);
      for (const c of bess) {
        const hc = halfExtents(c);
        const dx = Math.abs(c.x - inv.x) - (hi.hx + hc.hx);
        const dy = Math.abs(c.y - inv.y) - (hi.hy + hc.hy);
        // face-to-face gap only when the rects overlap on the other axis
        if (dy > 0.2 && dx < -0.2) {
          if (!best || dy < best.gap) best = { inv, c, gap: dy, horiz: false };
        } else if (dx > 0.2 && dy < -0.2) {
          if (!best || dx < best.gap) best = { inv, c, gap: dx, horiz: true };
        }
      }
    }
    if (best) {
      const hi = halfExtents(best.inv), hc = halfExtents(best.c);
      const label = `${ftIn(best.gap)} PCS CLEARANCE (TYP)`;
      if (best.horiz) {
        const left = best.inv.x < best.c.x ? best.inv : best.c;
        const right = left === best.inv ? best.c : best.inv;
        const hl = halfExtents(left), hr = halfExtents(right);
        const yTop = Math.max(left.y + hl.hy, right.y + hr.hy);
        dimH(dxf, left.x + hl.hx, right.x - hr.hx, yTop, yTop + 12, label);
      } else {
        const lo = best.inv.y < best.c.y ? best.inv : best.c;
        const hiEq = lo === best.inv ? best.c : best.inv;
        const h1 = halfExtents(lo), h2 = halfExtents(hiEq);
        const xR = Math.max(lo.x + h1.hx, hiEq.x + h2.hx);
        dimV(dxf, lo.y + h1.hy, hiEq.y - h2.hy, xR, xR + 8, label);
      }
    }
  }

  // 4) Fence <-> lot-line setback at the closest fence vertex.
  {
    let best: { v: Pt; foot: Pt; d: number } | null = null;
    for (const v of design.fence) {
      const r2 = distToPolygon(v, design.boundary.polygon);
      if (!best || r2.d < best.d) best = { v, foot: r2.foot, d: r2.d };
    }
    if (best && best.d > 1) {
      dimAligned(dxf, best.v, best.foot, `${ftIn(best.d)} FENCE TO PROJECT BOUNDARY (MIN)`);
    }
  }

  // 5) Min BESS <-> lot line (NFPA 855 remote-location basis). Skipped
  // when NFPA annotations are hidden (CAD Layers "Feeder & NFPA text" off).
  if (includeNfpa) {
    let best: { p: Pt; foot: Pt; d: number } | null = null;
    for (const b of bess) {
      const h = halfExtents(b);
      const corners: Pt[] = [
        { x: b.x - h.hx, y: b.y - h.hy }, { x: b.x + h.hx, y: b.y - h.hy },
        { x: b.x + h.hx, y: b.y + h.hy }, { x: b.x - h.hx, y: b.y + h.hy },
      ];
      for (const p of corners) {
        const r2 = distToPolygon(p, design.boundary.polygon);
        if (!best || r2.d < best.d) best = { p, foot: r2.foot, d: r2.d };
      }
    }
    if (best) {
      dimAligned(dxf, best.p, best.foot, `${ftIn(best.d)} BATTERY CONTAINER TO PROJECT BOUNDARY (MIN, NFPA 855)`);
    }
  }

  // 6) Per-block spacing dims (guidance sheet 3): container gaps, PCS
  // clearance and block-to-block gaps at every block, from the shared
  // dimension generator (same source as the 2D plan view overlay).
  // Future-augmentation footprints: a block-gap dim string centered mid-gap
  // can land exactly on the aug unit that (correctly) occupies that corridor
  // gap. Slide the text along its own dim line — standard drafting practice —
  // until it clears every aug rect; original spot kept when nothing clears,
  // so dims on aug-free layouts are byte-identical.
  const augRects: { minX: number; maxX: number; minY: number; maxY: number }[] = [];
  const rotAabb = (x: number, y: number, length: number, width: number, rad: number) => {
    const hx = Math.abs(Math.cos(rad)) * length / 2 + Math.abs(Math.sin(rad)) * width / 2;
    const hy = Math.abs(Math.sin(rad)) * length / 2 + Math.abs(Math.cos(rad)) * width / 2;
    return { minX: x - hx, maxX: x + hx, minY: y - hy, maxY: y + hy };
  };
  for (const z of design.reservedZones ?? []) {
    if (z.kind !== 'futureAug') continue;
    // Reserved-zone angles are DEGREES (angleDeg, optional).
    augRects.push(rotAabb(z.x, z.y, z.length, z.width, ((z.angleDeg ?? 0) * Math.PI) / 180));
  }
  for (const eq of design.futureEquipment ?? []) {
    // Equipment rotation is RADIANS.
    augRects.push(rotAabb(eq.x, eq.y, eq.length, eq.width, eq.rotation ?? 0));
  }
  const slideDimTextClear = (spec: { kind: 'h' | 'v'; a: number; b: number },
    t: { cx: number; cy: number; rot: number; label: string }) => {
    if (!augRects.length) return t;
    const w = t.label.length * DIM_H * 0.62;
    const ext = (cx: number, cy: number) => t.rot === 90
      ? { minX: cx - DIM_H, maxX: cx, minY: cy - w / 2, maxY: cy + w / 2 }
      : { minX: cx - w / 2, maxX: cx + w / 2, minY: cy, maxY: cy + DIM_H };
    const clear = (cx: number, cy: number) => {
      const e = ext(cx, cy);
      return !augRects.some(r =>
        e.minX < r.maxX && r.minX < e.maxX && e.minY < r.maxY && r.minY < e.maxY);
    };
    if (clear(t.cx, t.cy)) return t;
    const lo = Math.min(spec.a, spec.b) + w / 2, hi = Math.max(spec.a, spec.b) - w / 2;
    const step = DIM_H * 2;
    for (let k = 1; k <= 40; k++) {
      for (const s of [k, -k]) {
        const c = (spec.a + spec.b) / 2 + step * s;
        if (c < lo || c > hi) continue;
        const cx = spec.kind === 'h' ? c : t.cx;
        const cy = spec.kind === 'h' ? t.cy : c;
        if (clear(cx, cy)) return { ...t, cx, cy };
      }
    }
    return t;
  };
  for (const spec of computeBlockSpacingDims(design)) {
    dxf.dimAudit.push({ label: spec.label, measured: Math.abs(spec.b - spec.a) });
    const prims = expandDim(spec);
    for (const l of prims.lines) dxf.addLine(l.x1, l.y1, l.x2, l.y2, LAYERS.DIMS);
    const t = slideDimTextClear(spec, prims.text);
    dxf.addCenteredText(t.cx, t.cy, DIM_H, t.label, LAYERS.DIMS,
      undefined, { rot: t.rot, est: 0.62 });
  }

  // 7) Overall fence extents (south + west sides, outside the fence).
  {
    const fx = design.fence.map(p => p.x), fy = design.fence.map(p => p.y);
    const minX = Math.min(...fx), maxX = Math.max(...fx);
    const minY = Math.min(...fy), maxY = Math.max(...fy);
    if (maxX - minX > 1 && maxY - minY > 1) {
      // Register F-18: fence overall dims read in whole feet — a site-scale
      // overall printed as 1249'-11.7" is drafting noise, not precision.
      // Register F-19 (Great Prairie SE-corner "DIM OFF"): on a skewed fence
      // the min-x/max-x extremes sit at different y — each extension line
      // anchors at the fence vertex that actually achieves its extreme, so
      // the line lands on the fence instead of floating past the SE corner.
      const vMinX = design.fence.reduce((m, p) => (p.x < m.x ? p : m));
      const vMaxX = design.fence.reduce((m, p) => (p.x > m.x ? p : m));
      const vMinY = design.fence.reduce((m, p) => (p.y < m.y ? p : m));
      const vMaxY = design.fence.reduce((m, p) => (p.y > m.y ? p : m));
      dimH(dxf, minX, maxX, vMinX.y, minY - 15, `${Math.round(maxX - minX)}' FENCE OVERALL`, vMaxX.y);
      dimV(dxf, minY, maxY, vMinY.x, minX - 15, `${Math.round(maxY - minY)}' FENCE OVERALL`, vMaxY.x);
    }
  }
}

// Decimal feet -> ft-in string, e.g. 23.525 -> 23'-6.3"
export function ftIn(ft: number): string {
  let whole = Math.floor(ft);
  let inches = (ft - whole) * 12;
  // carry when the inch part rounds up to a full foot (avoid 39'-12")
  if (Math.abs(inches - 12) < 0.05) { whole += 1; inches = 0; }
  const inStr = Math.abs(inches - Math.round(inches)) < 0.05
    ? String(Math.round(inches))
    : inches.toFixed(1);
  return `${whole}'-${inStr}"`;
}

// Simple word wrap by character budget (TEXT has no wrapping)
function wrap(text: string, maxChars: number): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    if (cur && (cur + ' ' + w).length > maxChars) { lines.push(cur); cur = w; }
    else cur = cur ? cur + ' ' + w : w;
  }
  if (cur) lines.push(cur);
  return lines;
}

// Full drawing sheet frame per the NextEra guidance sheet layout:
// sheet border, right-hand panel with Site Information / Equipment
// Dimensions / Key Notes / Legend / Bill of Materials boxes, the red
// diagrammatic-purposes disclaimer, LG & PE notes, and a BESSForge
// title block at the bottom right (REV / DATE / SCALE / SHEET).
export interface TitleBlockMeta {
  projectName?: string;
  location?: string;
  drafter?: string;
  revision?: string;
  date?: string;
  neerDwgName?: string;  // client (NEER) drawing number; banner cell blank when absent
}

// Which right-hand panel boxes a sheet includes; defaults (all true) keep
// the legacy combined single-sheet output byte-identical.
export interface SheetFrameOptions {
  sheetLabel?: string;   // e.g. 'SHEET 2 OF 5'
  sheetTitle?: string;   // e.g. 'OVERALL SITE PLAN'
  panels?: {
    siteInfo?: boolean;
    equipDims?: boolean;
    bom?: boolean;
    legend?: boolean;
    keyNotes?: boolean;
    notes?: boolean;      // LG / Power Electronics notes
    disclaimer?: boolean; // red diagrammatic-purposes disclaimer
    stamp?: boolean;      // boxed "ISSUED FOR 10% REVIEW" (reference style)
  };
  // Extra titled boxes (e.g. cover-sheet SHEET INDEX), rendered after Site Information
  extraBoxes?: { title: string; rows: string[] }[];
  // Override the plan-area bounds the frame wraps (default: boundary polygon
  // extents, extended for substation/feeders). The cover10 sheet passes its
  // composed region so the border always encloses the cover artwork.
  planBounds?: { minX: number; minY: number; maxX: number; maxY: number };
  // Whether this sheet draws the equipment schedule table south of the yard
  // (sheet border is extended to enclose it). Defaults to true for the
  // legacy single-sheet export (frame === undefined).
  schedule?: boolean;
  // Panels-only sheets (no plan geometry): flow the panel boxes in columns
  // across the plan area instead of a single right-hand sidebar, so the
  // sheet reads full instead of ~95% blank (e.g. KEY NOTES & LEGEND).
  fillPlanArea?: boolean;
  // 90%-reference cover border: five nested rounded-corner border lines
  // (thick outer + four thin), the vector ECI logo set into the lower-left
  // of the border band, and a small drawing-number tag gapped into the
  // bottom band near the right corner. Cover10 only — absent keeps every
  // other sheet's plain rectangular border byte-identical.
  cover10Border?: { dwgTag?: string };
  // Issued-drawing full-width bottom title banner (reference bottom_of_dwg
  // strip): ECI logo cell, revision-comment table, big centered project
  // name, engineering-record table, right block with MW/MWh + sheet title
  // + DWG NAME / NEER DWG NAME / REVISION NO. Opt-in (10% layout sheet);
  // absent keeps every other sheet byte-identical.
  bottomBanner?: {
    sheetTitle?: string;   // e.g. 'OVERALL SITE PLAN'
    dwgName?: string;      // e.g. 'HON-D-B001-0'
    neerDwgName?: string;  // client drawing number; blank cell when absent
    revision?: string;     // issued banner revision override, e.g. GA for 10% General Arrangement
  };
  // Ornate surveyor-style north arrow (traced from the issued 90%
  // reference) + graphic scale bar in the gap between the plan and the
  // panel column. Layout sheet only.
  northArrow?: boolean;
  // Issued-for-10% right-column furniture (reference strip): the ornate
  // needle above a checkered graphic scale bar with FT tick labels and a
  // computed "SCALE: 1" = XX'" caption, beside the legend panel. Opt-in
  // with cover10; when set it REPLACES the legacy northArrow furniture on
  // the layout sheet. Absent keeps every other sheet byte-identical.
  scaleBar?: boolean;
  // Drafter-drawn area zone kinds present on the plan (dry pond, wet pond,
  // laydown yard, underground exclusion) — appends the matching reference
  // legend rows. Absent/empty keeps the legend byte-identical.
  areaZoneKinds?: AreaZoneKind[];
  // ECI reference legend equipment symbols (traced from the issued legend
  // references, eciLegendGlyphs.ts) instead of the baked GLB plan-view
  // traces. Only the legend swatch glyphs change — row set, labels and
  // every other legend element are untouched. Absent keeps every export
  // byte-identical to the default.
  eciLegend?: boolean;
  // When true, the AUX FEEDER legend row carries a " (MAN)" suffix to flag
  // that the route was drawn manually by the engineer. Absent/false keeps
  // the legend byte-identical to the auto-routed output.
  auxManRoute?: boolean;
  // Override the panel column width (default 330·k). The cover10 sheet
  // passes pw (= RW·0.34) so the right-hand title-block column is exactly
  // as wide as the vicinity / aerial image panels.
  framePW?: number;
  // Trim border whitespace when doing so wins a better standard plot scale.
  // The plotted scale is the smallest STANDARD rung whose sheet fits the
  // page, so a sheet overshooting a rung by a hair prints a whole step
  // small. Set on the 10% combined plan (yard + remote substation), which
  // misses the next rung by ~2% of sheet width. Absent keeps every other
  // sheet byte-identical.
  tightenToScale?: boolean;
}

/** Build the real-equipment prototype a legend swatch must replay.
 *
 * The legend must never silently fall back to a neutral catalog orientation
 * when the drawing has a real placed unit with a mirrored door or cable side.
 * An absent kind still needs a catalog-sized placeholder so optional rows can
 * render on sheets where that equipment is not installed.
 */
export function legendEquipmentPrototype(
  design: SiteDesign,
  kind: PlacedEquipment['kind'],
  config?: BessConfiguration,
  opts?: { doorEnd?: 1 | -1; epanel?: 'left' | 'right' },
): PlacedEquipment {
  const placed = design.equipment.find(e => e.kind === kind);
  const spec = specForKind(kind, config);
  const eq: PlacedEquipment = placed
    ? { ...placed, id: `legend-${kind}`, label: '' }
    : {
        id: `legend-${kind}`, kind, label: '',
        x: 0, y: 0, rotation: 0,
        length: spec?.dims.length ?? 10,
        width: spec?.dims.width ?? 10,
        height: spec?.dims.height ?? 10,
      };
  if (kind === 'bess') {
    eq.doorEnd = opts?.doorEnd ?? eq.doorEnd ?? 1;
    eq.epanel = opts?.epanel ?? eq.epanel ?? 'right';
  }
  return eq;
}

export function addSheetFrame(
  dxf: DxfWriter,
  design: SiteDesign,
  projectName: string,
  config?: BessConfiguration,
  meta?: TitleBlockMeta,
  feeders?: FeederCircuit[],
  substation?: Pt | null,
  frame?: SheetFrameOptions
) {
  const panels = {
    siteInfo: true, equipDims: true, bom: true, legend: true,
    keyNotes: true, notes: true, disclaimer: true, stamp: true,
    ...(frame?.panels ?? {}),
  };
  const xs = design.boundary.polygon.map(p => p.x);
  const ys = design.boundary.polygon.map(p => p.y);
  const pb = frame?.planBounds;
  const minX = pb ? pb.minX : Math.min(...xs);
  const minY = pb ? pb.minY : Math.min(...ys);
  const maxY = pb ? pb.maxY : Math.max(...ys);
  // Panels must clear ALL plan geometry, including an off-parcel
  // substation symbol and routed feeder home-runs east of the lot.
  let maxX = pb ? pb.maxX : Math.max(...xs);
  if (!pb) {
    if (substation) maxX = Math.max(maxX, substation.x + 25);
    if (feeders) for (const f of feeders) {
      for (const seg of f.segments) {
        for (const p of seg.pts) maxX = Math.max(maxX, p.x);
      }
    }
  }
  const span = Math.max(maxX - minX, maxY - minY, 400);

  // Annotation scale: panel sized relative to the plan so the sheet reads
  // like the reference PDF regardless of parcel size.
  const k = Math.min(Math.max(span / 1200, 0.5), 4);
  const H = 5 * k;          // body text height
  const HT = 6.5 * k;       // box title height
  const LG = 2.2 * k;       // line gap
  const PAD = 4 * k;
  // Panel width (cover10 overrides framePW to match image panels). Sheets
  // that opt into tightenToScale (the 10% combined-plan pages) widen the
  // sidebar instead: the stack's depth — not the sheet's width — is what
  // costs those pages a scale rung (the border pads width from height to
  // hold the printable aspect), and a wider panel un-wraps the text-heavy
  // KEY NOTES / NOTES rows, lifting the title block off the sheet bottom.
  // Panels start right of maxX (which already clears the substation and
  // feeder runs), so extra width never collides with plan geometry and the
  // page aspect solve absorbs it.
  const PW = frame?.framePW ?? (frame?.tightenToScale && frame?.fillPlanArea !== true ? 480 : 330) * k;
  // Plan-to-panel gap. The cover10 scale-bar stack (ornate needle +
  // checkered bar) lives in this column, so 10% sheets widen it to hold a
  // reference-proportioned bar; other sheets keep the legacy 60k gap.
  const GAP = (frame?.scaleBar ? 110 : 60) * k;

  // Panel column origin: right-hand sidebar by default; panels-only sheets
  // (fillPlanArea) flow columns left-to-right across the plan area in
  // balanced columns, so the sheet reads full instead of one skinny strip.
  const fill = frame?.fillPlanArea === true;
  const COL_GAP = 40 * k;
  let colBottom = minY;
  if (fill) {
    // Measure pass: same frame in plain sidebar mode (single unbroken
    // column) tells us the total stack height; pick a column height that
    // yields a roughly page-shaped (landscape) block of columns.
    const probe = new DxfWriter();
    const probeBot = addSheetFrame(probe, design, projectName, config, meta, feeders, substation, {
      ...frame, fillPlanArea: false,
    });
    const totalH = maxY - probeBot;
    const PAGE_ASPECT = 1.55; // ~ANSI D landscape printable area
    const idealColH = Math.sqrt((totalH * (PW + COL_GAP)) / PAGE_ASPECT);
    colBottom = Math.max(minY, maxY - idealColH);
  }
  let panelX = fill ? minX : maxX + GAP;
  let panelR = panelX + PW;
  let maxPanelR = panelR;
  let py = maxY;            // stack boxes downward from plan top
  let minPy = maxY;         // lowest content edge actually drawn (fill border)
  // Legend panel extent, captured for the cover10 scale-bar stack (drawn
  // beside the legend, in the plan-to-panel gap column).
  let legendRect: { top: number; bot: number } | null = null;

  // In fill mode, move to the next column when a block of the given height
  // would run past the column bottom (never mid-block, so boxes stay whole).
  const ensureSpace = (blockH: number) => {
    if (!fill) return;
    if (py - blockH < colBottom && py < maxY) {
      panelX = panelR + COL_GAP;
      panelR = panelX + PW;
      maxPanelR = Math.max(maxPanelR, panelR);
      py = maxY;
    }
    minPy = Math.min(minPy, py - blockH);
  };

  const centered = (t: string, cx: number, y: number, h: number, layer: string, color?: number) =>
    dxf.addCenteredText(cx, y, h, t, layer, color, { est: 0.84 });

  const maxChars = Math.floor((PW - 2 * PAD) / (H * CHAR_W));

  // One titled panel box: bordered rect, centered underlined title, body rows.
  // Every logical row is wrapped to the panel width here (continuation lines
  // hang-indented) so no text can ever overflow the box border, regardless
  // of what callers pass in. drawRow fires once per logical row, at its
  // first physical line.
  // `textIndent` (drawing units) reserves a fixed left column for row
  // swatches: text starts at panelX + PAD + textIndent and continuation
  // lines keep the same indent, so text can never overlap the swatch
  // column regardless of the preview font's metrics.
  const box = (title: string, rows: string[], drawRow?: (x: number, y: number, i: number) => void, textIndent = 0) => {
    const phys: { text: string; logical: number; first: boolean }[] = [];
    const indentChars = textIndent > 0 ? Math.ceil(textIndent / (H * CHAR_W)) : 0;
    rows.forEach((t, i) => {
      const indent = t.match(/^ */)![0];
      const budget = Math.max(10, maxChars - indent.length - indentChars);
      wrap(t.trimStart(), budget).forEach((line, j) => {
        phys.push({ text: indent + (j > 0 ? '  ' : '') + line, logical: i, first: j === 0 });
      });
    });
    const rowH = H + LG;
    const bodyH = phys.length * rowH + PAD * 2;
    const titleH = HT + PAD * 2;
    ensureSpace(titleH + bodyH);
    const top = py, bot = py - titleH - bodyH;
    dxf.addPolyline([[panelX, bot], [panelR, bot], [panelR, top], [panelX, top]], LAYERS.TEXT_LG, true);
    dxf.addLine(panelX, top - titleH, panelR, top - titleH, LAYERS.TEXT_LG);
    centered(title, (panelX + panelR) / 2, top - titleH + PAD, HT, LAYERS.TEXT_LG);
    phys.forEach((p, i) => {
      const yy = top - titleH - PAD - (i + 1) * rowH + LG;
      dxf.addText(panelX + PAD + textIndent, yy, H, p.text, LAYERS.TEXT_SM);
      if (drawRow && p.first) drawRow(panelX + PAD, yy, p.logical);
    });
    py = bot - 10 * k;
    return { top, bot };
  };

  // Fit a single line into a horizontal budget by shrinking its height
  // (title-block cells) — never let it cross the cell border.
  const fitText = (x: number, y: number, h: number, text: string, maxW: number, layer: string, color?: number) => {
    const hh = Math.min(h, maxW / Math.max(1, text.length * CHAR_W));
    dxf.addText(x, y, hh, text, layer, 0, color);
  };
  // Centered variant for title-block cells: shrink-to-fit, then anchor the
  // line about the cell's horizontal center (review standard — title-block
  // project/title text is centered, not left-ragged).
  const fitCentered = (cx: number, y: number, h: number, text: string, maxW: number, layer: string) => {
    const hh = Math.min(h, maxW / Math.max(1, text.length * CHAR_W));
    dxf.addCenteredText(cx, y, hh, text, layer, undefined, { est: CHAR_W });
  };

  // ---- Site Information ----
  const dur = config ? config.durationHrs : Math.round(design.targetMWh / Math.max(design.targetMW, 1));
  // KMZ-traced yards: no auto blocks exist (blocksPlaced stays 0) and the
  // MW/MWh targets are app-session defaults, not the drawing's declared
  // rating. Their sheet prints the DECLARED nameplate (achieved = the
  // package rating pro-rated over built units) and the built PCS count, so
  // a traced sheet never reads "100MW / 0 blocks" against a 125 MW yard.
  // Auto/manual layouts (blocksPlaced > 0 or no traced units) are untouched.
  const tracedYard = design.blocksPlaced === 0 &&
    design.equipment.some(e => e.id.startsWith('peq-') && (e.kind === 'inverter' || e.kind === 'bess'));
  const useDeclared = tracedYard && design.achievedMW > 0;
  const npMW = useDeclared ? design.achievedMW : design.targetMW;
  const npMWh = useDeclared ? design.achievedMWh : design.targetMWh;
  const npDur = useDeclared ? Math.round(design.achievedMWh / Math.max(design.achievedMW, 1)) : dur;
  const pcsBlocks = tracedYard
    ? design.equipment.filter(e => e.kind === 'inverter' && !e.augmented && !e.future).length
    : design.blocksPlaced;
  const siteRows = [
    `NAMEPLATE SIZE: ${npMW.toFixed(0)}MW X ${npDur}HR (${npMWh.toFixed(0)}MWH)`,
    `CREDITED OUTPUT: ${design.achievedMW.toFixed(1)} MW / ${design.achievedMWh.toFixed(1)} MWH`,
    `PCS BLOCKS: ${pcsBlocks}`,
    `SITE AREA: ${design.boundary.areaAcres.toFixed(1)} AC`,
    `SITE: ${(meta?.projectName?.trim() || projectName).toUpperCase()}`,
  ];
  if (config?.inverterModel === 'GE FLEX 1571') {
    siteRows.splice(2, 0,
      `GE PCS CAPABILITY: ${config.pcsCapabilityMW.toFixed(2)} MW EA (EQUIPMENT CAPABILITY)`,
      `BLOCK BASIS: QTY ${config.containersPerBlock} LG = ${(config.containersPerBlock * config.containerMWh).toFixed(3)} MWH / ${config.blockMW.toFixed(3)} MW CREDITED`,
    );
  }
  if (meta?.location) siteRows.push(`LOCATION: ${meta.location.toUpperCase()}`);
  if (config) siteRows.push(...wrap(`CONFIG: ${config.label.toUpperCase()}`, maxChars));
  if (panels.siteInfo) box('SITE INFORMATION', siteRows);

  // ---- Extra sheet-specific boxes (e.g. cover-sheet SHEET INDEX) ----
  for (const eb of frame?.extraBoxes ?? []) {
    box(eb.title, eb.rows.flatMap(t => wrap(t, maxChars)));
  }

  // ---- Equipment Dimensions ----
  const dimRows: string[] = [];
  if (config) {
    const inv = config.inverterDims;
    dimRows.push(
      `PCS - ${config.inverterModel} [L X W X H]`,
      `${ftIn(inv.length)} X ${ftIn(inv.width)} X ${ftIn(inv.height)}`,
    );
  }
  dimRows.push(
    `BATTERY CONTAINER - LG JF2 DC LINK 5.1 [L X W X H]`,
    `${ftIn(LG_JF2.length)} X ${ftIn(LG_JF2.width)} X ${ftIn(LG_JF2.height)}`,
  );
  if (!config || config.hasAuxEquipment) {
    dimRows.push(
      `AUX TRANSFORMER - HITACHI [L X W X H]`,
      `${ftIn(HITACHI_AUX_XFMR.length)} X ${ftIn(HITACHI_AUX_XFMR.width)} X ${ftIn(HITACHI_AUX_XFMR.height)}`,
      // Single-sourced from AUX_SWITCHBOARD_SPEC (register F-06): the same
      // catalog record drives this panel, the BOM, the equipment schedule
      // and the legend — never a hardcoded manufacturer string.
      `${AUX_SWITCHBOARD_SPEC.item} - ${AUX_SWITCHBOARD_SPEC.manufacturer} [L X W X H]`,
      `${ftIn(AUX_SWITCHBOARD_SPEC.dims.length)} X ${ftIn(AUX_SWITCHBOARD_SPEC.dims.width)} X ${ftIn(AUX_SWITCHBOARD_SPEC.dims.height)}`,
    );
  }
  if (panels.equipDims) box('EQUIPMENT DIMENSIONS', dimRows);

  // ---- Bill of Materials (equipment counts/types) ----
  // Rows come from the shared helper so the CSV export mirrors this panel exactly.
  const bomRows = buildBomRows(design, config, feeders).map(formatBomRowText);
  if (panels.bom) box('BILL OF MATERIALS (QTY / DESCRIPTION)', bomRows);

  // ---- Legend (reference CK1 style: heavy boxed panel, centered LEGEND
  // banner, uniform rows; equipment rows use HIGH-RES top-down vector
  // traces of the real GLB models, line rows show the layer linetype, area
  // rows show a bordered hatch swatch) ----
  const SW = 46 * k; // swatch column width
  // Row draw fns receive the swatch CELL rect (x, y, w, h), bottom-left.
  type LegendRow = {
    label: string;
    draw: (x: number, y: number, w: number, h: number) => void;
    visibility?: DrawingVisibilityRule;
  };
  const cellRect = (x: number, y: number, w: number, h: number, layer: string) =>
    dxf.addPolyline([[x, y], [x + w, y], [x + w, y + h], [x, y + h]], layer, true);
  // Equipment swatch = the ACTUAL layout symbol (register: legend/layout
  // primitive parity). Start from a placed unit of the requested kind so
  // rotation, door handing, E-panel side, and PCS cable-compartment side
  // match the drawing. Only an absent kind falls back to a catalog-sized
  // synthetic unit. The result is rendered through drawOneEquipment — the
  // exact same code path the plan uses, including ECI symbol mode — into a
  // scratch writer, then its ops replay scaled/centered into the cell.
  // The legend can therefore never show a primitive, color, linework
  // treatment, or orientation the plan doesn't draw.
  const equipSwatch = (
    kind: PlacedEquipment['kind'], x: number, y: number, w: number, h: number,
    opts?: { doorEnd?: 1 | -1; epanel?: 'left' | 'right' }
  ) => {
    const eq = legendEquipmentPrototype(design, kind, config, opts);
    const tmp = new DxfWriter();
    tmp.withProvenance({ sourceRenderer: 'legend-swatch' }, () =>
      drawOneEquipment(tmp, eq, config, !!frame?.eciLegend, true));
    // Bounds of everything drawn, then aspect-preserving fit into the cell.
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const grow = (px: number, py: number) => {
      if (px < minX) minX = px; if (px > maxX) maxX = px;
      if (py < minY) minY = py; if (py > maxY) maxY = py;
    };
    for (const op of tmp.ops) {
      if (op.kind === 'line') { grow(op.x1, op.y1); grow(op.x2, op.y2); }
      else if (op.kind === 'poly') for (const p of op.pts) grow(p[0], p[1]);
      else if (op.kind === 'hatch') for (const loop of op.loops) for (const p of loop) grow(p[0], p[1]);
    }
    if (!isFinite(minX)) {
      if (dxf.layerColors[LAYERS.SYM_DARK] === undefined) dxf.addLayer(LAYERS.SYM_DARK, 8);
      dxf.withProvenance({
        sourceRenderer: 'legend-swatch',
        role: 'neutral-equipment-outline',
        equipmentId: eq.id,
        equipmentKind: eq.kind,
        symbolResolution: 'neutral-fallback',
      }, () => cellRect(x, y, w, h, LAYERS.SYM_DARK));
      return;
    }
    // Reading orientation (task 896): containers place rotated in the plan
    // (long axis along y), and a portrait glyph fitted to the wide legend
    // cell prints as an unreadable sliver. Turn portrait glyphs 90° CW so
    // the long axis runs with the row text; landscape glyphs replay as-is.
    const portrait = (maxY - minY) > (maxX - minX);
    const rot = portrait
      ? (p: number[]) => [p[1], -p[0]]
      : (p: number[]) => p;
    if (portrait) {
      [minX, maxX, minY, maxY] = [minY, maxY, -maxX, -minX];
    }
    const bw = Math.max(maxX - minX, 1e-6), bh = Math.max(maxY - minY, 1e-6);
    // Enlarged swatch box (task 896): equipment glyphs printed small at the
    // shared cell size. Let them spill symmetrically into the slack the
    // legend layout reserves around every cell — the cell is SW*0.82 wide by
    // RH*0.7 tall inside an SW-by-RH slot, so 1.15x width / 1.3x height
    // stays inside the slot and clear of the label column.
    const ew = w * 1.15, eh = h * 1.3;
    const s = Math.min(ew / bw, eh / bh);
    const ox = x + w / 2 - (bw * s) / 2 - minX * s;
    const oy = y + h / 2 - (bh * s) / 2 - minY * s;
    const mp = (p: number[]) => {
      const q = rot(p);
      return [ox + q[0] * s, oy + q[1] * s];
    };
    // Symbol layers the plan declares lazily get the same lazy declaration
    // here (whichever draws first wins — duplicate LAYER records corrupt
    // the table).
    for (const [name, color] of Object.entries(tmp.layerColors)) {
      if (dxf.layerColors[name] === undefined) dxf.addLayer(name, color);
    }
    for (const op of tmp.ops) {
      dxf.withProvenance({
        ...(op.provenance ?? {
          role: 'neutral-equipment-outline',
          equipmentId: eq.id,
          equipmentKind: eq.kind,
          symbolResolution: 'neutral-fallback',
        }),
        sourceRenderer: 'legend-swatch',
      }, () => {
        if (op.kind === 'line') {
          const a = mp([op.x1, op.y1]), b = mp([op.x2, op.y2]);
          dxf.addLine(a[0], a[1], b[0], b[1], op.layer, op.color);
        } else if (op.kind === 'poly') {
          dxf.addPolyline(op.pts.map(mp), op.layer, op.closed, op.color);
        } else if (op.kind === 'hatch') {
          dxf.addHatchLoops(op.loops.map(loop => loop.map(mp)), op.layer, op.pattern, op.color);
        }
      });
    }
  };
  const lineRow = (
    layer: string,
    frac = 1,
    aci?: number,
    provenance: DisplayOpProvenance = { sourceRenderer: 'legend-swatch' },
  ): LegendRow['draw'] =>
    (x, y, w, h) => dxf.withProvenance({
      symbolResolution: 'not-applicable',
      ...provenance,
    }, () => aci !== undefined
      ? dxf.addPolyline([[x, y + h / 2], [x + w * frac, y + h / 2]], layer, false, aci)
      : dxf.addLine(x, y + h / 2, x + w * frac, y + h / 2, layer));
  const hatchRow = (layer: string, pattern: HatchPattern, outline = true): LegendRow['draw'] =>
    (x, y, w, h) => {
      if (outline) cellRect(x, y, w, h, layer);
      dxf.addHatch([[x, y], [x + w, y], [x + w, y + h], [x, y + h]], layer, pattern);
    };
  // Auto layouts mark future augmentation via reservedZones; KMZ-traced
  // yards carry flagged units inside design.equipment — both draw the same
  // dashed-footprint + ANSI37 mesh convention, so both select the same
  // legend rows.
  const hasAug = design.reservedZones.some(z => z.kind === 'futureAug') ||
    design.equipment.some(e => e.augmented || e.future);
  const hasKind = (k: PlacedEquipment['kind']) => design.equipment.some(e => e.kind === k);
  const legendRows: LegendRow[] = [
    { label: config ? `PCS ${config.inverterModel.toUpperCase()}` : 'PCS',
      draw: (x, y, w, h) => equipSwatch('inverter', x, y, w, h) },
    // LG container row(s). RULE: both ECI reference legend sheets always
    // list BOTH LG DC Link door-tick variants ("'A' CONFIG" and "'C' CONFIG")
    // as separate rows regardless of configuration, so in ECI legend mode the
    // single LG row expands to the two variant rows with their traced
    // symbols. Default (non-ECI) exports keep the single baked-GLB row —
    // byte-identical, since the expansion is gated on frame.eciLegend.
    ...(frame?.eciLegend ? [
      { label: `LG JF2 DC LINK 'A' CONFIG`,
        draw: ((x, y, w, h) => equipSwatch('bess', x, y, w, h, { doorEnd: 1 })) as LegendRow['draw'] },
      { label: `LG JF2 DC LINK 'C' CONFIG`,
        draw: ((x, y, w, h) => equipSwatch('bess', x, y, w, h, { doorEnd: -1 })) as LegendRow['draw'] },
    ] : [
      { label: 'LG JF2 DC LINK BATTERY CONTAINER',
        draw: ((x, y, w, h) => equipSwatch('bess', x, y, w, h)) as LegendRow['draw'] },
    ]),
    // RETIRED (task 896): the standalone fallback-construct rows — battery
    // container door-end tick / cable-compartment corner, PCS DC cable
    // compartment (double box), PCS MV / aux transformer connection box —
    // are gone. The issued drawings render delivered symbol artwork, which
    // carries its own door and compartment detail, so those hand-drawn
    // constructs never appear on the plan and the legend must not advertise
    // them.
    { label: 'AUXILIARY SWITCH PANEL',
      draw: (x, y, w, h) => equipSwatch('auxSwitchPanel', x, y, w, h) },
    { label: 'FIBER PATCH PANEL',
      draw: (x, y, w, h) => equipSwatch('fiberPatchPanel', x, y, w, h) },
    { label: 'FIRE CONTROL PANEL',
      draw: (x, y, w, h) => equipSwatch('fireControlPanel', x, y, w, h) },
    // Mid-island auxiliary cluster (delivered legend artwork
    // Nextera_Legend_Equipment22 / last3legends_*.glb, traced in
    // nexteraGlbSymbols). Names come from TERMS; symbols come from the same
    // equipSwatch path as every other equipment row, so the legend shows the
    // exact glyph the plan draws. Appended only for the kinds the design
    // actually places, so layouts without the cluster stay byte-identical.
    ...(hasKind('auxSwitchgear') ? [{
      label: TERMS.auxDistCenter,
      draw: ((x, y, w, h) => equipSwatch('auxSwitchgear', x, y, w, h)) as LegendRow['draw'],
    }] : []),
    ...(hasKind('auxTransformer') ? [{
      label: TERMS.auxTransformer,
      draw: ((x, y, w, h) => equipSwatch('auxTransformer', x, y, w, h)) as LegendRow['draw'],
    }] : []),
    ...(hasKind('commsCabinet') ? [{
      label: TERMS.commsCabinet,
      draw: ((x, y, w, h) => equipSwatch('commsCabinet', x, y, w, h)) as LegendRow['draw'],
    }] : []),
    // Future augmentation: batteries row carries the ANSI37 area mesh (the
    // only ground mesh on the plot), inverters row is the dashed footprint.
    ...(hasAug ? [
      { label: 'FUTURE AUGMENTATION BATTERIES', draw: hatchRow(LAYERS.FUTURE_BESS, 'ANSI37') },
      { label: 'FUTURE AUGMENTATION PCS', draw: ((x, y, w, h) => cellRect(x, y, w, h, LAYERS.FUTURE_BESS)) as LegendRow['draw'] },
    ] : [
      { label: 'FUTURE BESS AUGMENTATION BLOCK', draw: hatchRow(LAYERS.FUTURE_BESS, 'ANSI31') },
    ]),
    { label: 'CONSTRUCTION LAYDOWN AREA', draw: hatchRow(LAYERS.LAYDOWN, 'ANSI31') },
    ...(design.surfacing && design.surfacing.regions.length ? [
      { label: 'CRUSHED ROCK SURFACING', draw: hatchRow(LAYERS.GRAVEL, 'GRAVEL') },
    ] : []),
    ...(feeders && feeders.length ? [
      // Per-feeder legend rows: colored LINE swatch (reference style) with
      // the same palette color as the routed circuit, at 34.5 kV.
      // BOL/EOL states print together (register F-02): feeders are sized
      // for the end-of-life load including the reserved augmentation blocks.
      ...feederLegendRows(feeders, design.equipment).map(fr => ({
        label: `BESS FEEDER #${fr.label} (34.5 KV) - BOL ${fr.pcsCount} PCS - ${fr.bessCount} BATTERY CONTAINERS / EOL ${fr.eolPcsCount} PCS - ${fr.eolBessCount} BATTERY CONTAINERS`,
        draw: lineRow(LAYERS.FEEDER, 1, fr.color.aci, {
          sourceRenderer: 'legend-swatch',
          role: 'feeder-run',
        }),
      })),
    ] : []),
    ...(design.auxFeeder && design.auxFeeder.legs.length ? [{
      label: `AUX FEEDER #${auxDisplayName(design.auxFeeder)} (34.5 KV) - ${design.auxFeeder.stopIds.length} AUX XFMR${frame?.auxManRoute ? ' (MAN)' : ''}`,
      draw: lineRow(LAYERS.AUX_FEEDER, 1),
      visibility: 'auxiliaryCables' as const,
    }] : []),
    // DC conductors are (+)/(−) pairs per the reference detail legend.
    { label: 'DC CABLE (+)', draw: lineRow(LAYERS.CABLE_DC_POS, 1, undefined, {
      sourceRenderer: 'legend-swatch', role: 'dc-conductor',
    }), visibility: 'pcsToBess' },
    { label: 'DC CABLE (-)', draw: lineRow(LAYERS.CABLE_DC_NEG, 1, undefined, {
      sourceRenderer: 'legend-swatch', role: 'dc-conductor',
    }), visibility: 'pcsToBess' },
    { label: 'MV CABLE', draw: lineRow(LAYERS.CABLE_MV) },
    ...(design.cables.some(c => c.ref && c.class === 'MV') ? [{
      label: 'MV CABLE FUTURE REFERENCE (TO FUTURE BESS BLOCK)',
      draw: lineRow(LAYERS.CABLE_MV_REF),
    }] : []),
    // Spec §2 trench-class stack: aux distribution (0.480 kV magenta) is the
    // always-present LVAC service; the remaining classes appear only when the
    // design routed at least one run of that class.
    // Conditional cable-class rows consume the same single-source predicate
    // routing gate G-RT-12 checks (cableLegendClasses.ts), so a class drawn
    // on the plan can never silently miss its legend row.
    { label: 'AUX DISTRIBUTION (0.480 KV)', draw: lineRow(LAYERS.CABLE_LVAC), visibility: 'auxiliaryCables' },
    ...(legendCableClasses(design).has('AUXPWR') ? [{
      label: 'AUX POWER (LV)', draw: lineRow(LAYERS.CABLE_AUXPWR), visibility: 'auxiliaryCables' as const,
    }] : []),
    ...(legendCableClasses(design).has('FIBER_TRUNK') ? [{
      label: 'FIBER (144 COUNT)', draw: lineRow(LAYERS.CABLE_FIBER_TRUNK), visibility: 'fiber' as const,
    }] : []),
    { label: 'FIBER (6 COUNT)', draw: lineRow(LAYERS.CABLE_FIBER), visibility: 'fiber' },
    ...(legendCableClasses(design).has('CATL') ? [{
      label: 'CATL FIBER NETWORK (6 COUNT)', draw: lineRow(LAYERS.CABLE_CATL), visibility: 'fiber' as const,
    }] : []),
    {
      label: '480V AUX AND FIBER TRENCH',
      draw: (x, y, w, h) => cellRect(x, y, w, h, LAYERS.TRENCH),
      visibility: ['fiber', 'auxiliaryCables'],
    },
    // Fence swatch draws through drawFenceLine — same definition as the plan
    // fence, ticks scaled to the legend cell (registers F-15/F-16).
    { label: 'BESS FENCE', draw: (x, y, w, h) =>
      drawFenceLine(dxf, [[x, y + h / 2], [x + w, y + h / 2]], false, LAYERS.FENCE, w / 3, h * 0.28) },
    { label: 'PROJECT BOUNDARY', draw: lineRow(LAYERS.BOUNDARY) },
    { label: 'PROPOSED EQUIPMENT ACCESS', draw: hatchRow(LAYERS.ROAD_HATCH, 'SOLID', false) },
    // Gate swatch draws through gateSwingGeometry — the same double-swing
    // definition the plan places (span line + leaves + dashed swing arcs).
    { label: 'EXISTING ACCESS / GATE', draw: (x, y, w, h) => {
      const gw = Math.min(w * 0.55, h * 1.6);
      const gy = y + h * 0.2;
      const gGate = { x: x + w / 2, y: gy, width: gw, rotation: 0 };
      // Synthetic "yard" above the swatch line so the mini gate swings up.
      const yard: Pt[] = [
        { x: x - w, y: gy }, { x: x + 2 * w, y: gy },
        { x: x + 2 * w, y: y + 4 * h }, { x: x - w, y: y + 4 * h },
      ];
      dxf.addLine(x, gy, x + w, gy, LAYERS.FENCE);
      const sym = gateSwingGeometry(gGate, yard);
      for (const l of sym.leaves) dxf.addLine(l.x1, l.y1, l.x2, l.y2, LAYERS.FENCE);
      for (const a of sym.arcs) dxf.addArc(a.cx, a.cy, a.r, a.start, a.end, a.ccw, LAYERS.GATE_SWING);
    } },
    // Drafter-drawn area zones (reference CK1 legend rows) — appended only
    // for the kinds actually present, so zone-free sheets stay byte-identical.
    ...(frame?.areaZoneKinds ?? []).map(kind => ({
      label: AREA_ZONE_LABELS[kind],
      draw: (x: number, y: number, w: number, h: number) => {
        ensureAreaZoneLayers(dxf, [kind]);
        const def = AREA_ZONE_LAYERS[kind];
        const loop = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
        if (def.border) {
          // Pond swatch: light fill inset in a solid border band (dry =
          // thick brown, wet = blue) — sampled from the reference legend.
          const b = h * (kind === 'dryPond' ? 0.14 : 0.08);
          const inner = [[x + b, y + b], [x + w - b, y + b], [x + w - b, y + h - b], [x + b, y + h - b]];
          dxf.addPolyline(loop, def.border.name, true);
          dxf.addHatchLoops([loop, inner], def.border.name, 'SOLID');
          dxf.addHatch(inner, def.name, def.pattern);
        } else {
          cellRect(x, y, w, h, def.name);
          dxf.addHatch(loop, def.name, def.pattern);
        }
      },
    })),
  ];
  if (panels.legend) {
    // Dedicated legend renderer (reference layout): heavy double border,
    // centered LEGEND banner row, uniform row pitch, swatch cells on a
    // fixed column, labels vertically centered — text can never overlap
    // the swatch column and rows can never drift or crowd.
    const RH = H * 2.4;                 // uniform row pitch
    const cellW = SW * 0.82, cellH = RH * 0.7;
    const indentChars = Math.ceil(SW / (H * CHAR_W));
    const physRows = legendRows.filter(r => !r.visibility || dxf.visibilityEnabled(r.visibility)).map(r => ({
      row: r,
      lines: wrap(r.label, Math.max(10, maxChars - indentChars)),
    }));
    const rowHs = physRows.map(p => Math.max(RH, p.lines.length * (H + LG) + LG * 2));
    const bodyH = rowHs.reduce((a, b) => a + b, 0) + PAD * 2;
    const titleH = HT * 1.25 + PAD * 2;
    ensureSpace(titleH + bodyH);
    const top = py, bot = py - titleH - bodyH;
    legendRect = { top, bot };
    const in2 = 1.4 * k;
    dxf.addPolyline([[panelX, bot], [panelR, bot], [panelR, top], [panelX, top]], LAYERS.TEXT_LG, true);
    dxf.addPolyline([[panelX + in2, bot + in2], [panelR - in2, bot + in2], [panelR - in2, top - in2], [panelX + in2, top - in2]], LAYERS.TEXT_LG, true);
    dxf.addLine(panelX + in2, top - titleH, panelR - in2, top - titleH, LAYERS.TEXT_LG);
    centered('LEGEND', (panelX + panelR) / 2, top - titleH + PAD * 1.2, HT * 1.25, LAYERS.TEXT_LG);
    let yCur = top - titleH;
    physRows.forEach((p, i) => {
      const rh = rowHs[i];
      const rowBot = yCur - rh;
      p.row.draw(panelX + PAD + in2, rowBot + (rh - cellH) / 2, cellW, cellH);
      const blockH = p.lines.length * (H + LG) - LG;
      let ty = rowBot + (rh + blockH) / 2 - H;
      for (const line of p.lines) {
        dxf.addText(panelX + PAD + SW + in2, ty, H, line, LAYERS.TEXT_SM);
        ty -= H + LG;
      }
      yCur = rowBot;
    });
    py = bot - 10 * k;
  }

  // ---- Key Notes ----
  // (vendor notes builder lives at module scope below: vendorNotesFor)
  const noteTexts = [
    // Register F-17: reviewer terminology — DRIVE PATH(S) not ROAD(S),
    // BATTERY CONTAINERS not BESS-as-noun, PROJECT BOUNDARY not LOT LINE.
    `1. 58' INNER TURNING RADIUS FOR ALL DRIVE PATHS INSIDE THE BESS YARD.`,
    `2. ${CLEARANCES.roadWidth}' WIDE DRIVE PATHS THROUGHOUT THE BESS YARD.`,
    `3. 20' OUTER TURNING RADIUS FOR ALL DRIVE PATHS INSIDE THE BESS YARD.`,
    `4. 8'-0 3/4" MIN DISTANCE TO DRIVE PATH EDGE FOR EQUIPMENT.`,
    `5. BATTERY CONTAINERS HAVE TO BE 100'-0" MIN FROM PROJECT BOUNDARY PER NFPA 855 FOR "REMOTE LOCATION" BUT OTHER EQUIPMENT COULD BE WITHIN 100'-0".`,
    `6. PCS CLEARANCE: 14'-0" REQUIRED FOR SITES WITH AMBIENT TEMPS >40 DEG C; CAN REDUCE TO 10'-0" FOR SITES <40 DEG C.`,
    `7. TICK LINE INSIDE A BATTERY CONTAINER RECTANGLE MARKS THE DOOR / E-PANEL END WALL; ROUTED DC/LVAC LINE ENDS MARK THEIR CABLE LANDINGS.`,
    `8. CONTAINER LABELS FOLLOW CON<FFUU>-A-<N>: FF = FEEDER NUMBER, UU = PCS UNIT POSITION ON THE FEEDER, N = CONTAINER NUMBER AT THAT PCS UNIT.`,
  ];
  const rs = design.reserveSummary;
  if (rs && rs.laydownPct > 0) {
    noteTexts.push(
      `${noteTexts.length + 1}. CONSTRUCTION LAYDOWN AREA: ${(rs.laydownPlacedSqFt / 43560).toFixed(2)} AC RESERVED (${rs.laydownPct}% OF FENCED YARD REQUESTED = ${(rs.laydownRequestedSqFt / 43560).toFixed(2)} AC). TEMPORARY STAGING ONLY - NO PERMANENT EQUIPMENT, CONDUIT OR GROUND GRID.`
    );
  }
  if (rs && (rs.augPct > 0 || rs.augBlocksRequested > 0)) {
    // Register F-03: augmentation reserve is framed PER FEEDER — each
    // reserved block ties into the feeder whose island end holds it, and
    // the feeders are sized for that EOL load.
    const perFeeder = feeders && feeders.length
      ? Math.max(...feeders.map(f => f.futurePcs || 0)) : 0;
    const basis = rs.augPct > 0
      ? `${rs.augPct}% OF PLACED BLOCKS`
      : 'ISLAND STANDARD RESERVE';
    const perFeederTxt = perFeeder > 0
      ? ` ${perFeeder} WHOLE BLOCK FOOTPRINT(S) RESERVED PER MV FEEDER, ELECTRICALLY TIED TO THAT FEEDER; FEEDER CONDUCTORS ARE SIZED FOR THIS EOL LOAD.`
      : '';
    noteTexts.push(
      `${noteTexts.length + 1}. FUTURE BESS AUGMENTATION: ${rs.augBlocksPlaced} WHOLE BLOCK FOOTPRINT(S) RESERVED IN THE STANDARD BLOCK GRID (${basis}, +${rs.augMW.toFixed(1)} MW / +${rs.augMWh.toFixed(1)} MWH FUTURE).${perFeederTxt} KEEP CLEAR OF PERMANENT INSTALLATIONS.`
    );
  }
  if (design.surfacing && design.surfacing.regions.length) {
    const sp = design.surfacing;
    const cov = sp.mode === 'full-yard'
      ? 'ALL NON-DRIVE-PATH AREAS INSIDE THE FENCE'
      : 'EQUIPMENT COURTYARDS BETWEEN DRIVE PATHS';
    noteTexts.push(
      `${noteTexts.length + 1}. CRUSHED ROCK SURFACING: ${cov}, ${sp.depthIn}" DEPTH OVER GEOTEXTILE FABRIC. ${(sp.areaSqFt / 43560).toFixed(2)} AC TOTAL, APPROX. ${Math.ceil(sp.tons).toLocaleString('en-US')} TONS. EQUIPMENT PADS AND RESERVED LAYDOWN/FUTURE BESS FOOTPRINTS EXCLUDED.`
    );
  }
  if (feeders && feeders.length) {
    const sizes = Array.from(new Set(feeders.map(f =>
      `${(f.parallelSets || 1) > 1 ? `${f.parallelSets}X` : ''}${f.size} KCMIL ${f.material.toUpperCase()}`
    ))).join(', ');
    const maxVd = Math.max(...feeders.map(f => f.vdPct));
    const allFjb = feeders.every(f => f.fjbId);
    const maxEol = Math.max(...feeders.map(f => f.inverterIds.length + (f.futurePcs || 0)));
    const adj = feeders[0].adjacentCircuits || feeders.length;
    const derate = feeders[0].derateFactor || mutualHeatingDerate(adj);
    noteTexts.push(
      `${noteTexts.length + 1}. MV COLLECTION: ${feeders.length} FEEDER${feeders.length > 1 ? 'S' : ''} AT 34.5KV ROUTED INDIVIDUALLY TO SUBSTATION${allFjb ? ' VIA ISLAND FEEDER JUNCTION BOXES' : ''}; MAX ${MAX_INVERTERS_PER_FEEDER} PCS UNITS PER FEEDER AT BEGINNING OF LIFE (${maxEol} PCS AT END OF LIFE WITH RESERVED AUGMENTATION). CONDUCTORS (SIZED FOR EOL LOAD): ${sizes}. AMPACITY BASIS: DIRECT-BURIED SINGLE-CIRCUIT RATINGS AT RHO-${AMPACITY_SOIL_RHO}, ${AMPACITY_LOAD_FACTOR_PCT}% LOAD FACTOR, MUTUAL-HEATING DERATE ${derate.toFixed(2)} FOR ${adj} ADJACENT CIRCUITS IN THE SHARED CORRIDOR. VOLTAGE DROP MAX ${maxVd.toFixed(2)}% AT EOL (LIMIT ${VD_LIMIT_PCT}%) PER NEC CH.9 TABLE 8 DC RESISTANCE, UNITY PF.${design.auxFeeder && design.auxFeeder.legs.length ? ` AUX FEEDER #${auxDisplayName(design.auxFeeder)} (34.5KV) DAISY-CHAINS ${design.auxFeeder.stopIds.length} AUX TRANSFORMER${design.auxFeeder.stopIds.length > 1 ? 'S' : ''} FROM THE SUBSTATION.` : ''}`
    );
    // Register B3/F-07: state the cable quantity calculation basis so BOM
    // and schedule totals are auditable against each other.
    noteTexts.push(
      `${noteTexts.length + 1}. CABLE QUANTITIES: EACH RUN = ROUTED PLAN CENTERLINE LENGTH PLUS ${DEFAULT_SLACK_PCT}% SLACK/VERTICAL ALLOWANCE (RISERS, TERMINATIONS, TRAINING), ROUNDED UP TO WHOLE LF. BOM CABLE TOTALS ARE THE SUM OF THE PER-RUN CABLE SCHEDULE LENGTHS.`
    );
  }
  if (panels.keyNotes) box('KEY NOTES', noteTexts.flatMap(t => wrap(t, maxChars)));

  // ---- Red disclaimer (per reference sheets) ----
  if (panels.disclaimer) {
    const disclaimer = wrap(
      `THESE LAYOUTS ARE FOR DIAGRAMMATIC PURPOSES ONLY - THEY ARE PROVIDED TO CONVEY CONCEPTS AND ARE NOT INTENDED TO BE A COMPLETE DESIGN. THIS LAYOUT DOES NOT INCLUDE OTHER POTENTIAL REQUIRED FEATURES SUCH AS DRAINAGE, WATER RETENTION, LAYDOWN, PGD CONNEX BOXES, ETC. THE BESS EOR IS RESPONSIBLE FOR PROVIDING A DETAILED DESIGN THAT IS REVIEWED AND APPROVED BY THE OWNER.`,
      maxChars
    );
    ensureSpace(disclaimer.length * (H + LG) + 12 * k);
    dxf.withProvenance({
      sourceRenderer: 'sheet-annotation',
      role: 'annotation',
      symbolResolution: 'not-applicable',
    }, () => disclaimer.forEach((t, i) =>
      dxf.addText(panelX, py - i * (H + LG), H, t, LAYERS.TEXT_SM, 0, 1)));
    py -= disclaimer.length * (H + LG) + 12 * k;
  }

  // ---- Notes - LG battery + PCS-OEM vendor clearances (register F-05) ----
  // The PCS note set is CONDITIONAL on the configured PCS OEM — a GE site
  // must never print Power Electronics clearances. A config whose OEM has
  // no authored note set prints a loud compliance finding instead of a
  // wrong-vendor block.
  const lgNotes = vendorNotesFor(config);
  if (panels.notes) {
    // Boxed NOTES panel per the issued 90% reference sheet style.
    box('NOTES', lgNotes);
  }

  // ---- Boxed review stamp (reference style, above the title block) ----
  if (panels.stamp) {
    const stamp = 'ISSUED FOR 10% REVIEW';
    const sh = 8 * k;              // stamp text height (large, reference style)
    const boxH = sh + 2 * PAD;
    ensureSpace(boxH + 10 * k);
    dxf.addPolyline([[panelX, py - boxH], [panelR, py - boxH], [panelR, py], [panelX, py]], LAYERS.TEXT_LG, true);
    centered(stamp, (panelX + panelR) / 2, py - boxH + PAD + sh * 0.1, sh, LAYERS.TEXT_LG);
    py -= boxH + 10 * k;
  }

  // ---- Title block (bottom of panel) ----
  ensureSpace((22 + 12 + 16) * k);
  const tbTop = py;
  const rowH1 = 22 * k;  // logo/title row
  const rowH2 = 12 * k;  // rev/date row
  const rowH3 = 16 * k;  // sheet row
  const tbBot = tbTop - rowH1 - rowH2 - rowH3;
  const logoW = PW * 0.34;
  dxf.addPolyline([[panelX, tbBot], [panelR, tbBot], [panelR, tbTop], [panelX, tbTop]], LAYERS.TEXT_LG, true);
  dxf.addLine(panelX, tbTop - rowH1, panelR, tbTop - rowH1, LAYERS.TEXT_LG);
  dxf.addLine(panelX, tbTop - rowH1 - rowH2, panelR, tbTop - rowH1 - rowH2, LAYERS.TEXT_LG);
  dxf.addLine(panelX + logoW, tbBot, panelX + logoW, tbTop, LAYERS.TEXT_LG);
  // Real ECI logo, traced to vector polygons (see eciLogoVector.ts) so the
  // graphic plots everywhere without external image references.
  {
    const cellW = logoW - 2 * PAD, cellH = rowH1 - 2 * PAD;
    const lw = Math.min(cellW, cellH * LOGO_ASPECT);
    const lh = lw / LOGO_ASPECT;
    const lx = panelX + logoW / 2 - lw / 2;
    const ly = tbTop - rowH1 / 2 - lh / 2;
    for (const poly of LOGO_POLYS) {
      const rings = poly.map(ring => ring.map(([px, py2]) => [lx + px * lw, ly + py2 * lh]));
      dxf.addHatchLoops(rings, LAYERS.TEXT_LG, 'SOLID');
      for (const ring of rings) dxf.addPolyline(ring, LAYERS.TEXT_LG, true);
    }
  }
  // Drawing title
  const cellW2 = PW - logoW - 2 * PAD; // usable width right of the logo cell
  const cfgTitle = config ? config.label.replace(/\s*\(.*\)$/, '').toUpperCase() : 'BESSFORGE BESS 10% DESIGN';
  const cellCx = panelX + logoW + PAD + cellW2 / 2;
  fitCentered(cellCx, tbTop - rowH1 / 2 + 1 * k, 6 * k, cfgTitle, cellW2, LAYERS.TEXT_LG);
  const tbLine2 = [
    `${(meta?.projectName?.trim() || projectName).toUpperCase()} - BESS 10% SITE DESIGN`,
    meta?.location ? meta.location.toUpperCase() : '',
  ].filter(Boolean).join('  |  ');
  fitCentered(cellCx, tbTop - rowH1 / 2 - 6.5 * k, 5 * k, tbLine2, cellW2, LAYERS.TEXT_LG);
  // REV / DATE / DRAWN BY / SCALE
  const rev = (meta?.revision || DEFAULT_PRELIM_REV).toUpperCase();
  const date = meta?.date || new Date().toLocaleDateString();
  const revRow = `REV: ${rev}   DATE: ${date}` + (meta?.drafter ? `   DRAWN BY: ${meta.drafter.toUpperCase()}` : '');
  fitText(panelX + PAD, tbTop - rowH1 - rowH2 + 3 * k, 4.5 * k, revRow, logoW - 2 * PAD, LAYERS.TEXT_SM);
  // NOTE: the SCALE cell is emitted AFTER the sheet border is finalized —
  // the printed scale derives from the actual plotted viewport (pickScale
  // over the final border extents), never a hardcoded ratio.
  fitText(panelX + logoW + PAD, tbTop - rowH1 - rowH2 + 2 * k, 4 * k, `PER NEXTERA SITE PLAN GUIDANCE R2`, cellW2, LAYERS.TEXT_SM);
  // SHEET
  centered(frame?.sheetLabel ?? 'SHEET 1 OF 1', panelX + logoW / 2, tbBot + rowH3 / 2 - 2 * k, 7 * k, LAYERS.TEXT_LG);
  fitCentered(cellCx, tbBot + rowH3 / 2 - 2 * k, 5 * k, frame?.sheetTitle ?? `10% BESS LAYOUT`, cellW2, LAYERS.TEXT_SM);

  // ---- Ornate north arrow + graphic scale bar (layout sheet only) ----
  // Reference-style surveyor needle (traced vector, see northArrowVector.ts)
  // in the gap between the plan area and the panel column, upper right,
  // with a graphic scale bar beneath — matches the issued 90% sheet.
  if (frame?.northArrow && !fill && !frame.scaleBar) {
    const naH = 110 * k;
    const naW = naH * NORTH_ARROW_ASPECT;
    const naCx = maxX + GAP / 2;
    const naTop = maxY - 10 * k;
    for (const poly of NORTH_ARROW_POLYS) {
      const rings = poly.map(ring => ring.map(([px, py]) =>
        [naCx + (px - 0.5) * naW, naTop - naH + py * naH]));
      dxf.addHatchLoops(rings, LAYERS.TEXT_LG, 'SOLID');
      for (const ring of rings) dxf.addPolyline(ring, LAYERS.TEXT_LG, true);
    }
    // Graphic scale bar: nice round length in drawing feet, quarter ticks.
    // Must fit the plan-to-panel gap (GAP = 60k) with its end labels.
    const barFt = k >= 2.5 ? 100 : k >= 1.25 ? 50 : 20;
    const bxL = naCx - barFt / 2;
    const bY = naTop - naH - 18 * k;
    dxf.addLine(bxL, bY, bxL + barFt, bY, LAYERS.TEXT_SM);
    for (let i = 0; i <= 4; i++) {
      const tx = bxL + (barFt * i) / 4;
      dxf.addLine(tx, bY - 3 * k, tx, bY + 3 * k, LAYERS.TEXT_SM);
      const lbl = `${(barFt * i) / 4}'`;
      dxf.addCenteredText(tx, bY - 8.5 * k, 3.2 * k, lbl, LAYERS.TEXT_SM, undefined, { est: CHAR_W });
    }
    const gs = 'GRAPHIC SCALE';
    dxf.addCenteredText(naCx, bY - 15 * k, 3.2 * k, gs, LAYERS.TEXT_SM, undefined, { est: CHAR_W });
  }

  // ---- Sheet border around everything ----
  // The equipment schedule table sits south of the yard; make sure the
  // border encloses it (both depth and width) on sheets that draw it.
  const drawsSchedule = frame ? frame.schedule === true : true;
  const sched = drawsSchedule ? computeEquipmentSchedule(design, config) : null;
  const M = 50 * k;
  // Content extents BEFORE the border margin. Kept separate so the margin
  // can be re-tried below without re-deriving the content.
  // Fill mode hugs the panel columns (no plan geometry to enclose), so the
  // plotted page scales the content up instead of framing empty plan area.
  const rawX1 = minX;
  const rawY1 = (fill
    ? Math.min(minPy, tbBot)
    : Math.min(minY, tbBot, sched ? sched.yBot : Infinity));
  const rawX2 = Math.max(maxPanelR, sched ? sched.x0 + sched.totalW : -Infinity);
  const rawY2 = maxY;
  // ---- Uniform printed sheet size ----
  // Every sheet border is padded out to EXACTLY the printable page aspect
  // ((34-1)/(22-1) ANSI D landscape), so every page of the set prints at
  // the full page size like the cover — a tall parcel otherwise fits by
  // height and plots as a visibly narrower sheet than the cover.
  // The bottom banner spans the FINAL border width at height W/19.5, so
  // solve for the padded width with the banner's contribution included:
  //   W = A*(H0 + W/19.5)  =>  W* = A*H0 / (1 - A/19.5)
  const ASPECT = (PAGE_W_IN - 2 * PAGE_MARGIN_IN) / (PAGE_H_IN - 2 * PAGE_MARGIN_IN);
  const bannerFrac = frame?.bottomBanner ? 1 / 19.5 : 0;
  const borderForMargin = (m: number) => {
    let x1 = rawX1 - m, y1 = rawY1 - m, x2 = rawX2 + m, y2 = rawY2 + m;
    const W0 = x2 - x1, H0 = y2 - y1;
    const Wstar = (ASPECT * H0) / (1 - ASPECT * bannerFrac);
    if (Wstar >= W0) {
      const grow = (Wstar - W0) / 2;
      x1 -= grow; x2 += grow;
    } else {
      // Sheet wider than page aspect: extend the top edge (bottom stays
      // pinned to the title block / banner strip).
      y2 += W0 / ASPECT - H0 - W0 * bannerFrac;
    }
    return { x1, y1, x2, y2 };
  };
  let border = borderForMargin(M);
  // ---- Recover a lost scale step ----
  // The plotted scale is the smallest STANDARD scale whose sheet fits the
  // printable page, so a sheet that overshoots a rung by a hair prints a
  // whole step smaller. The 10% combined plan (yard + remote substation)
  // lands exactly there: it misses the next rung by ~2% of sheet width and
  // so plots ~25% smaller than the page allows. The overshoot is border
  // margin — pure whitespace — so when trimming it alone buys the better
  // rung, take it, keeping the LARGEST margin that still buys it. Opt-in:
  // absent leaves every other sheet byte-identical.
  if (frame?.tightenToScale && !fill) {
    const MIN_M = 12 * k;  // still a clear gap between content and border
    const scaleAt = (m: number) => {
      const b = borderForMargin(m);
      return pickScale(b.x2 - b.x1, b.y2 - b.y1);
    };
    const baseScale = scaleAt(M);
    if (MIN_M < M && scaleAt(MIN_M) < baseScale) {
      // Largest margin in [MIN_M, M] that still reaches the better rung.
      // scaleAt is non-decreasing in m, so this bisects cleanly. Fixed
      // iteration count keeps the result deterministic (byte-identical
      // rebuilds).
      let lo = MIN_M, hi = M;
      for (let i = 0; i < 48; i++) {
        const mid = (lo + hi) / 2;
        if (scaleAt(mid) < baseScale) lo = mid; else hi = mid;
      }
      border = borderForMargin(lo);
    }
  }
  let bx1 = border.x1;
  let by1 = border.y1;
  let bx2 = border.x2;
  let by2 = border.y2;
  // Full-width bottom title banner (reference style): hangs below all plan
  // content and panels; the sheet border is extended to enclose it.
  if (frame?.bottomBanner) {
    // Banner DWG SCALE cell prints the true plotted scale of the FINAL
    // sheet extents (banner strip included), never a hardcoded ratio.
    const bannerScaleFt = pickScale(bx2 - bx1, (by2 - by1) + (bx2 - bx1) / 19.5);
    by1 -= drawBottomBanner(dxf, bx1, by1, bx2, frame.bottomBanner, design, projectName, meta, bannerScaleFt);
  }
  // Title-block SCALE cell, emitted now that the border extents are final:
  // the value derives from the actual plotted viewport scale (same pickScale
  // ladder pdfPlot's page transform uses) — never hardcoded.
  fitText(panelX + logoW + PAD, tbTop - rowH1 - rowH2 / 2, 4 * k,
    `SCALE: 1"=${pickScale(bx2 - bx1, by2 - by1)}' (UNITS: FEET)`, cellW2, LAYERS.TEXT_SM);
  // ---- Issued-for-10% ornate north arrow + checkered graphic scale ----
  // Reference strip: surveyor needle with the scroll ribbon above an
  // alternating-checker scale bar (0 / 10FT / 30FT / 60FT style) with a
  // computed "SCALE: 1" = XX'" caption. Sits in the gap column between the
  // drawing and the panel stack, beside the legend panel. Drawn AFTER the
  // banner so the caption scale reflects the FULL sheet extents (matching
  // pdfPlot's page transform ladder). Opt-in with cover10.
  if (frame?.scaleBar && !fill) {
    const cx = maxX + GAP / 2;
    const scaleFt = pickScale(bx2 - bx1, by2 - by1);
    const naH = 130 * k;
    const naW = naH * NORTH_ARROW_ASPECT;
    const naTop = (legendRect ? legendRect.top : maxY) - 4 * k;
    // The 90% trace carries small baked-in text fragments along the glyph
    // bottom; the new reference needle has none — draw the needle only.
    const needlePolys = NORTH_ARROW_POLYS.filter(p => p[0].some(([, yy]) => yy > 0.05));
    for (const poly of needlePolys) {
      const rings = poly.map(ring => ring.map(([px, pyn]) =>
        [cx + (px - 0.5) * naW, naTop - naH + pyn * naH] as [number, number]));
      dxf.addHatchLoops(rings, LAYERS.TEXT_LG, 'SOLID');
      for (const ring of rings) dxf.addPolyline(ring, LAYERS.TEXT_LG, true);
    }
    // Bar unit: the reference uses u = scale/3 (0/10/30/60 at 1"=30');
    // keep that when the 6u bar fits the gap column, else the largest
    // round unit that fits. The bar always measures TRUE model feet.
    const NICE = [5, 10, 15, 20, 25, 50, 100, 200, 250, 500];
    const uRef = scaleFt / 3;
    const fitW = GAP * 0.8;
    const u = Number.isInteger(uRef) && 6 * uRef <= fitW
      ? uRef
      : ([...NICE].reverse().find(n => 6 * n <= fitW) ?? 5);
    const barW = 6 * u;
    const bh = Math.max(2.4 * k, barW * 0.045);
    const bxL = cx - barW / 2;
    const bTop = naTop - naH - 16 * k;
    const bMid = bTop - bh / 2, bBot = bTop - bh;
    dxf.addPolyline([[bxL, bBot], [bxL + barW, bBot], [bxL + barW, bTop], [bxL, bTop]], LAYERS.TEXT_SM, true);
    dxf.addLine(bxL, bMid, bxL + barW, bMid, LAYERS.TEXT_SM);
    const cell = (x0: number, x1: number, topRow: boolean) => {
      const yb = topRow ? bMid : bBot, yt = topRow ? bTop : bMid;
      dxf.addHatchLoops([[[x0, yb], [x1, yb], [x1, yt], [x0, yt]]], LAYERS.TEXT_SM, 'SOLID');
    };
    // Fine left section: first unit split into 5 checker columns.
    for (let j = 0; j < 5; j++) {
      const x0 = bxL + (u * j) / 5, x1 = bxL + (u * (j + 1)) / 5;
      dxf.addLine(x1, bBot, x1, bTop, LAYERS.TEXT_SM);
      cell(x0, x1, j % 2 === 0);
    }
    // Main cells: one unit each, alternating rows (reference pattern).
    for (let i = 1; i < 6; i++) {
      const x0 = bxL + u * i, x1 = bxL + u * (i + 1);
      if (i < 5) dxf.addLine(x1, bBot, x1, bTop, LAYERS.TEXT_SM);
      cell(x0, x1, i % 2 === 0);
    }
    // Tick labels above the bar: 0 / u / 3u / 6u (reference style).
    const lh = 3.4 * k;
    const lbl = (ft: number, text: string) =>
      dxf.addCenteredText(bxL + ft, bTop + 2.2 * k, lh, text, LAYERS.TEXT_SM, undefined, { est: CHAR_W });
    lbl(0, '0');
    lbl(u, `${u}FT`);
    lbl(3 * u, `${3 * u}FT`);
    lbl(6 * u, `${6 * u}FT`);
    const cap = `SCALE: 1"=${scaleFt}'`;
    dxf.addCenteredText(cx, bBot - lh - 3.5 * k, lh, cap, LAYERS.TEXT_SM, undefined, { est: CHAR_W });
  }
  if (frame?.cover10Border) {
    drawCover10Border(dxf, bx1, by1, bx2, by2, frame.cover10Border.dwgTag);
  } else {
    dxf.addPolyline([[bx1, by1], [bx2, by1], [bx2, by2], [bx1, by2]], LAYERS.TEXT_LG, true);
  }
  return tbBot;
}

// Issued-drawing full-width bottom title banner (reference bottom_of_dwg
// strip). Left to right: ECI logo cell, revision-comment table, big
// centered project name, engineering-record table (DRAWN/DESIGNED/
// CHECKED/APPROVED + scales), right block (underlined project title,
// MW/MWh line, sheet title, DWG NAME / NEER DWG NAME / REVISION NO strip).
// Pure vector; missing metadata renders blank cells. Returns banner height.
function drawBottomBanner(
  dxf: DxfWriter,
  bx1: number,
  yTop: number,
  bx2: number,
  banner: NonNullable<SheetFrameOptions['bottomBanner']>,
  design: SiteDesign,
  projectName: string,
  meta?: TitleBlockMeta,
  scaleFt?: number,
) {
  const W = bx2 - bx1;
  const BH = W / 19.5;            // reference strip aspect (3820 x 196 px)
  const yBot = yTop - BH;
  const L = LAYERS.TEXT_LG;
  const S = LAYERS.TEXT_SM;
  const fx = (f: number) => bx1 + f * W;
  const text = (x: number, y: number, h: number, t: string, layer: string = S) => {
    if (t) dxf.addText(x, y, h, t, layer);
  };
  const fit = (x: number, y: number, h: number, t: string, maxW: number, layer: string = S) => {
    if (!t) return;
    const hh = Math.min(h, maxW / Math.max(t.length * CHAR_W, 1e-9));
    dxf.addText(x, y, hh, t, layer);
  };
  const centeredB = (cx: number, y: number, h: number, t: string, maxW: number, layer: string = L) => {
    if (!t) return 0;
    const hh = Math.min(h, maxW / Math.max(t.length * CHAR_W, 1e-9));
    return dxf.addCenteredText(cx, y, hh, t, layer, undefined, { est: CHAR_W });
  };
  const box = (x0: number, y0: number, x1: number, y1: number, layer: string = S) =>
    dxf.addPolyline([[x0, y0], [x1, y0], [x1, y1], [x0, y1]], layer, true);

  // Outer banner box; interior panels are inset boxes per the reference —
  // there is no full-height cell divider between the logo area and the
  // revision table. All fractions pixel-measured off the reference strip.
  dxf.addPolyline([[bx1, yBot], [bx2, yBot], [bx2, yTop], [bx1, yTop]], L, true);
  const m = BH * 0.035;           // vertical inset of the interior panels
  const iBot = yBot + m, iTopY = yTop - m, iH = iTopY - iBot;

  // ---- Logo (vector ECI trace, never raster), fills the left area ----
  {
    const cellW = 0.144 * W, pad = BH * 0.05;
    const lw = Math.min(cellW - 2 * pad, (BH - 2 * pad) * LOGO_ASPECT);
    const lh = lw / LOGO_ASPECT;
    const lx = bx1 + cellW / 2 - lw / 2;
    const ly = yBot + BH / 2 - lh / 2;
    for (const poly of LOGO_POLYS) {
      const rings = poly.map(ring => ring.map(([px, py]) => [lx + px * lw, ly + py * lh]));
      dxf.addHatchLoops(rings, L, 'SOLID');
      for (const ring of rings) dxf.addPolyline(ring, L, true);
    }
  }

  // ---- Revision table: 6 rows, header at bottom (NO|REVISION|DATE|BY|APR) ----
  {
    const x0 = fx(0.144), x1 = fx(0.3695);
    box(x0, iBot, x1, iTopY);
    const cols = [0.160, 0.300, 0.3236, 0.3473].map(fx);
    const rowH = iH / 6;
    const th = rowH * 0.42;
    for (let i = 1; i < 6; i++) dxf.addLine(x0, iBot + i * rowH, x1, iBot + i * rowH, S);
    for (const cx of cols) dxf.addLine(cx, iBot, cx, iTopY, S);
    const [cNo, cDate, cBy, cApr] = cols;
    const rowY = (r: number) => iBot + r * rowH + rowH * 0.3; // r=0 bottom header
    const ctr = (xa: number, xb: number, y: number, t: string) =>
      centeredB((xa + xb) / 2, y, th, t, (xb - xa) * 0.9, S);
    // Header row (bottom, per reference).
    ctr(x0, cNo, rowY(0), 'NO');
    ctr(cNo, cDate, rowY(0), 'REVISION');
    ctr(cDate, cBy, rowY(0), 'DATE');
    ctr(cBy, cApr, rowY(0), 'BY');
    ctr(cApr, x1, rowY(0), 'APR');
    // First revision entry: the 10% issue itself. Missing metadata renders
    // blank cells (banner rule) — no invented defaults.
    const rev = (banner.revision ?? meta?.revision ?? '').toUpperCase();
    const date = meta?.date || '';
    // Drafter field usually holds initials — render as typed (reference: BAT).
    // A multi-word full name collapses to initials so the cell stays narrow.
    const drafterRaw = (meta?.drafter || '').trim().toUpperCase();
    const by = /\s/.test(drafterRaw)
      ? drafterRaw.split(/\s+/).map(w => w[0] ?? '').join('').slice(0, 4)
      : drafterRaw.slice(0, 4);
    ctr(x0, cNo, rowY(1), rev);
    fit(cNo + BH * 0.06, rowY(1), th, 'ISSUED FOR 10% REVIEW', cDate - cNo - BH * 0.12);
    ctr(cDate, cBy, rowY(1), date);
    ctr(cBy, cApr, rowY(1), by);
  }

  // ---- Big centered project name (wide serif band, no cell borders) ----
  {
    const cx = fx((0.3695 + 0.6245) / 2);
    const name = (meta?.projectName?.trim() || projectName).toUpperCase();
    centeredB(cx, yBot + BH * 0.36, BH * 0.32, name, (0.6245 - 0.3695) * W * 0.94);
  }

  // ---- Engineering-record table: boxed rows with gaps ----
  {
    const x0 = fx(0.6245), x1 = fx(0.7505);
    const cName = fx(0.6607), cDate = fx(0.7191);
    const rowH = iH / 6;
    const g = rowH * 0.13;        // vertical gap between row boxes
    const th = rowH * 0.42;
    // r counts from bottom: 0=scale row, 1..4 records, 5 header.
    const rowBox = (r: number) => ({ y0: iBot + r * rowH + (r > 0 ? g : 0), y1: iBot + (r + 1) * rowH });
    const rowY = (r: number) => iBot + r * rowH + (r > 0 ? g : 0) + rowH * 0.27;
    // Header: ENGINEERING RECORD spans label+name, DATE box separate.
    {
      const { y0, y1 } = rowBox(5);
      box(x0, y0, cDate, y1);
      box(cDate, y0, x1, y1);
      centeredB((x0 + cDate) / 2, rowY(5), th, 'ENGINEERING RECORD', cDate - x0 - BH * 0.1, S);
      centeredB((cDate + x1) / 2, rowY(5), th, 'DATE', (x1 - cDate) * 0.8, S);
    }
    const rows: Array<[string, string, string]> = [
      ['DRAWN', (meta?.drafter || '').toUpperCase(), meta?.date || ''],
      ['DESIGNED', '', ''],
      ['CHECKED', '', ''],
      ['APPROVED', '', ''],
    ];
    rows.forEach(([label, who, when], i) => {
      const r = 4 - i;
      const { y0, y1 } = rowBox(r);
      box(x0, y0, cDate, y1);
      dxf.addLine(cName, y0, cName, y1, S);
      box(cDate, y0, x1, y1);
      const y = rowY(r);
      fit(x0 + BH * 0.04, y, th, label, cName - x0 - BH * 0.08);
      fit(cName + BH * 0.04, y, th, who, cDate - cName - BH * 0.08);
      centeredB((cDate + x1) / 2, y, th, when, (x1 - cDate) * 0.85, S);
    });
    // Scale row: two separate boxes (DWG SCALE | PLT SCALE).
    {
      const { y0, y1 } = rowBox(0);
      const split = fx(0.688);
      box(x0, y0, split, y1);
      box(split, y0, x1, y1);
      const y = rowY(0);
      text(x0 + BH * 0.04, y, th, 'DWG SCALE:');
      fit(x0 + BH * 0.56, y, th, scaleFt ? `1" = ${scaleFt}'` : '', split - x0 - BH * 0.6);
      text(split + BH * 0.04, y, th, 'PLT SCALE:');
      text(split + BH * 0.56, y, th, '1:1');
    }
  }

  // ---- Right block: underlined title, MW line, sheet title, DWG-name strip ----
  {
    const x0 = fx(0.752), x1 = bx2 - m;
    const tw = x1 - x0;
    box(x0, iBot, x1, iTopY);
    const stripH = BH * 0.145;
    const yStrip = iBot + stripH;
    dxf.addLine(x0, yStrip, x1, yStrip, S);
    dxf.addLine(x0, yStrip + BH * 0.035, x1, yStrip + BH * 0.035, S);
    const cx = x0 + tw / 2;
    const name = (meta?.projectName?.trim() || projectName).toUpperCase();
    const mwLine = `${design.targetMW} MW / ${design.targetMWh} MWh  BATTERY SYSTEM`;
    const titleH = BH * 0.16;
    const uw = centeredB(cx, yTop - BH * 0.24, titleH, name, tw * 0.9);
    dxf.addLine(cx - uw / 2, yTop - BH * 0.29, cx + uw / 2, yTop - BH * 0.29, L);
    centeredB(cx, yTop - BH * 0.48, titleH * 0.85, mwLine, tw * 0.9);
    centeredB(cx, yTop - BH * 0.71, titleH * 0.85, (banner.sheetTitle || '').toUpperCase(), tw * 0.9);
    // Bottom strip: DWG. NAME | NEER DWG. NAME | REVISION NO
    const cA = x0 + tw * 0.37, cB = x0 + tw * 0.81;
    dxf.addLine(cA, iBot, cA, yStrip, S);
    dxf.addLine(cB, iBot, cB, yStrip, S);
    const sy = iBot + stripH * 0.28, sh = stripH * 0.46;
    text(x0 + tw * 0.008, sy, sh, 'DWG. NAME:');
    centeredB((x0 + tw * 0.09 + cA) / 2, sy, sh, (banner.dwgName || '').toUpperCase(), cA - x0 - tw * 0.1, L);
    text(cA + tw * 0.008, sy, sh, 'NEER DWG. NAME:');
    centeredB((cA + tw * 0.13 + cB) / 2, sy, sh, (banner.neerDwgName || '').toUpperCase(), cB - cA - tw * 0.14, L);
    text(cB + tw * 0.008, sy, sh, 'REVISION NO :');
    text(cB + tw * 0.155, sy, sh, (meta?.revision || '').toUpperCase(), L);
  }

  return BH;
}

// 90%-reference cover border: five nested rounded-corner rings (thick outer
// simulated as a close double line + four thin), the traced ECI logo set
// into the lower-left of the border band, and a small drawing-number tag
// gapped into the bottom band left of the lower-right corner. Pure vector.
function drawCover10Border(dxf: DxfWriter, bx1: number, by1: number, bx2: number, by2: number, dwgTag?: string) {
  const W = bx2 - bx1;
  const g = W * 0.004;          // ring spacing
  const R = W * 0.028;          // outer corner radius
  // Logo cell: interrupts the bottom band at the lower-left (reference).
  const logoW = W * 0.15;
  const logoH = logoW / LOGO_ASPECT;
  const logoX = bx1 + W * 0.035; // clear of the corner arcs + vertical rings
  const logoY = by1 + g * 0.6;
  // Drawing-number tag: small text gapped into the band near the right corner.
  const tagH = W * 0.005;
  const tag = (dwgTag ?? '').trim().toUpperCase();
  const tagW = tag.length * tagH * CHAR_W;
  const tagX2 = bx2 - R - W * 0.012;
  const tagX1 = tagX2 - tagW;
  // Bottom-edge gap spans (in x) that every ring skips.
  const gaps: [number, number][] = [[logoX - g, logoX + logoW + g]];
  if (tag) gaps.push([tagX1 - g * 2, tagX2 + g * 2]);

  // Ring insets: double outer line reads as the reference's thick stroke,
  // then four evenly spaced thin lines.
  const insets = [0, 0.35 * g, 1.6 * g, 2.6 * g, 3.6 * g, 4.6 * g];
  for (const inset of insets) {
    const x1 = bx1 + inset, y1 = by1 + inset, x2 = bx2 - inset, y2 = by2 - inset;
    const r = Math.max(R - inset, g);
    // Corner arcs (CCW quarter turns).
    dxf.addArc(x1 + r, y1 + r, r, Math.PI, Math.PI * 1.5, true, LAYERS.TEXT_LG);       // BL
    dxf.addArc(x2 - r, y1 + r, r, Math.PI * 1.5, 0, true, LAYERS.TEXT_LG);             // BR
    dxf.addArc(x2 - r, y2 - r, r, 0, Math.PI * 0.5, true, LAYERS.TEXT_LG);             // TR
    dxf.addArc(x1 + r, y2 - r, r, Math.PI * 0.5, Math.PI, true, LAYERS.TEXT_LG);       // TL
    // Left / top / right edges: unbroken.
    dxf.addLine(x1, y1 + r, x1, y2 - r, LAYERS.TEXT_LG);
    dxf.addLine(x1 + r, y2, x2 - r, y2, LAYERS.TEXT_LG);
    dxf.addLine(x2, y1 + r, x2, y2 - r, LAYERS.TEXT_LG);
    // Bottom edge: segmented around the logo / tag gap spans.
    let xs = x1 + r;
    const xe = x2 - r;
    for (const [gs, ge] of gaps) {
      const s = Math.max(xs, Math.min(gs, xe));
      if (s > xs) dxf.addLine(xs, y1, s, y1, LAYERS.TEXT_LG);
      xs = Math.max(xs, Math.min(ge, xe));
    }
    if (xe > xs) dxf.addLine(xs, y1, xe, y1, LAYERS.TEXT_LG);
  }

  // ECI logo (vector polygon hatches — never raster).
  for (const poly of LOGO_POLYS) {
    const rings = poly.map(ring => ring.map(([px, py]) => [logoX + px * logoW, logoY + py * logoH]));
    dxf.addHatchLoops(rings, LAYERS.TEXT_LG, 'SOLID');
    for (const ring of rings) dxf.addPolyline(ring, LAYERS.TEXT_LG, true);
  }

  // Drawing-number tag text, sitting in the band gap.
  if (tag) dxf.addText(tagX1, by1 + g * 1.2, tagH, tag, LAYERS.TEXT_SM);
}

// Shared layer table — every sheet in the package declares the full
// standard layer set so layer conventions are consistent across sheets.
export function addBaseLayers(dxf: DxfWriter) {
  dxf.addLayer(LAYERS.BOUNDARY, COLORS.BOUNDARY, 'DASHED');
  dxf.addLayer(LAYERS.FENCE, COLORS.FENCE);
  dxf.addLayer(LAYERS.EQUIP, COLORS.EQUIP);
  dxf.addLayer(LAYERS.EQUIP_LABELS, COLORS.EQUIP_LABELS);
  dxf.addLayer(LAYERS.LAYDOWN, COLORS.LAYDOWN, 'DASHED');
  dxf.addLayer(LAYERS.FUTURE_BESS, COLORS.FUTURE_BESS, 'DASHED');
  dxf.addLayer(LAYERS.ROAD, COLORS.ROAD);
  dxf.addLayer(LAYERS.ROAD_HATCH, COLORS.ROAD_HATCH);
  dxf.addLayer(LAYERS.GRAVEL, COLORS.GRAVEL);
  dxf.addLayer(LAYERS.TEXT_SM, COLORS.TEXT);
  dxf.addLayer(LAYERS.TEXT_LG, COLORS.TEXT);
  // Cable classes: unique linetype + weight per class (register F-14) so a
  // grayscale plot still separates DC / MV / LVAC / fiber.
  dxf.addLayer(LAYERS.CABLE_DC, COLORS.CABLE_DC, 'CONTINUOUS', LINE_WEIGHTS.DC);
  dxf.addLayer(LAYERS.CABLE_DC_POS, COLORS.CABLE_DC_POS, 'CONTINUOUS', LINE_WEIGHTS.DC);
  dxf.addLayer(LAYERS.CABLE_DC_NEG, COLORS.CABLE_DC_NEG, 'CONTINUOUS', LINE_WEIGHTS.DC);
  dxf.addLayer(LAYERS.CABLE_MV, COLORS.CABLE_MV, 'DASHDOT', LINE_WEIGHTS.FEEDER);
  dxf.addLayer(LAYERS.CABLE_LVAC, COLORS.CABLE_LVAC, 'DASHED2', LINE_WEIGHTS.LVAC);
  dxf.addLayer(LAYERS.CABLE_AUXPWR, COLORS.CABLE_AUXPWR, 'DOT', LINE_WEIGHTS.FIBER);
  dxf.addLayer(LAYERS.CABLE_FIBER, COLORS.CABLE_FIBER, 'DASHED3', LINE_WEIGHTS.FIBER);
  dxf.addLayer(LAYERS.CABLE_FIBER_TRUNK, COLORS.CABLE_FIBER_TRUNK, 'CONTINUOUS', LINE_WEIGHTS.LVAC);
  dxf.addLayer(LAYERS.CABLE_CATL, COLORS.CABLE_CATL, 'DASHED4', LINE_WEIGHTS.FIBER);
  dxf.addLayer(LAYERS.CABLE_DC_REF, COLORS.CABLE_DC, 'DASHED');
  dxf.addLayer(LAYERS.CABLE_MV_REF, COLORS.CABLE_MV, 'DASHED');
  dxf.addLayer(LAYERS.TRENCH, COLORS.TRENCH);
  dxf.addLayer(LAYERS.FEEDER, COLORS.FEEDER, 'DASHDOT', LINE_WEIGHTS.FEEDER);
  dxf.addLayer(LAYERS.DIMS, COLORS.TEXT);
  dxf.addLayer(LAYERS.SCHEDULE, COLORS.TEXT);
  // Gate swing arcs dash with the short DASHED2 pattern (arcs are only a
  // dozen feet long — the 12.5 ft DASHED pattern reads solid at that size).
  dxf.addLayer(LAYERS.GATE_SWING, COLORS.FENCE, 'DASHED2');
}

// Existing-grade contour lines (opt-in reference layers). Layers are declared
// here — NOT in addBaseLayers — so the default export (no contours) stays
// byte-identical: DxfWriter handles are shared between layers and entities.
// Minor contours go on CONTOUR, index (major) contours on CONTOUR_MAJOR with
// an elevation label placed at a vertex chosen to clear the equipment yard
// (see contourLabelVertex).
export function drawContours(dxf: DxfWriter, contours: ContourSet, design?: SiteDesign) {
  dxf.addLayer(LAYERS.CONTOUR, COLORS.CONTOUR, 'DASHED');
  dxf.addLayer(LAYERS.CONTOUR_MAJOR, COLORS.CONTOUR_MAJOR, 'DASHED');
  const fmtElev = (e: number) => (Number.isInteger(e) ? e.toFixed(0) : e.toFixed(1));
  for (const line of contours.lines) {
    if (line.pts.length < 2) continue;
    const layer = line.major ? LAYERS.CONTOUR_MAJOR : LAYERS.CONTOUR;
    dxf.addPolyline(line.pts.map(p => [p.x, p.y]), layer, line.closed);
    if (!line.major) continue;
    // Elevation label vertex: prefer a spot clear of the equipment yard
    // (outside the fence, farthest from it); fall back to the vertex
    // farthest from any equipment rectangle when the whole contour crosses
    // the yard. Deterministic: strict > comparison keeps the first-best
    // vertex, so the same design always yields the same DXF. Without a
    // design (direct calls), keep the legacy middle-vertex placement.
    const mi = contourLabelVertex(line.pts, design);
    const a = line.pts[Math.max(mi - 1, 0)];
    const b = line.pts[Math.min(mi === 0 ? 1 : mi, line.pts.length - 1)];
    let rot = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
    if (rot > 90) rot -= 180;
    if (rot < -90) rot += 180;
    const m = line.pts[mi];
    dxf.withVisibility('labels', () => {
      dxf.addText(m.x, m.y + 1, TEXT_H, fmtElev(line.elevFt), LAYERS.CONTOUR_MAJOR, rot);
    });
  }
}

// Grounding screening layout (opt-in export only). The layer is declared
// here — NOT in addBaseLayers — so the default export (no grounding) stays
// byte-identical (DxfWriter handles are shared between layers and entities).
// Loop + taps are DASHED per buried-conductor convention; rods draw as small
// circles (two semicircle arcs) with a cross tick, plus a screening key note
// anchored below the loop extents.
const ROD_SYMBOL_R = 2; // ft — rod symbol radius at plan scale
export function drawGrounding(dxf: DxfWriter, plan: GroundingPlan) {
  dxf.addLayer(LAYERS.GROUNDING, COLORS.GROUNDING, 'DASHED');
  for (const lp of plan.loops ?? [plan.loop]) {
    dxf.addPolyline(lp.map(p => [p.x, p.y]), LAYERS.GROUNDING, true);
  }
  for (const [a, b] of plan.grid) {
    dxf.addLine(a.x, a.y, b.x, b.y, LAYERS.GROUNDING);
  }
  for (const t of plan.taps) {
    dxf.addLine(t.from.x, t.from.y, t.to.x, t.to.y, LAYERS.GROUNDING);
  }
  for (const rod of plan.rods) {
    dxf.addArc(rod.x, rod.y, ROD_SYMBOL_R, 0, Math.PI, true, LAYERS.GROUNDING);
    dxf.addArc(rod.x, rod.y, ROD_SYMBOL_R, Math.PI, 0, true, LAYERS.GROUNDING);
    dxf.addLine(rod.x - ROD_SYMBOL_R, rod.y, rod.x + ROD_SYMBOL_R, rod.y, LAYERS.GROUNDING);
  }
  // Grid crossing connections (exothermic welds): small filled-dot symbol —
  // a compact cross tick pair at each lattice crossing (reference sheet's
  // filled dots), lighter weight than the rod symbol.
  const CROSS_R = 0.8;
  for (const c of plan.crossings) {
    dxf.addLine(c.x - CROSS_R, c.y, c.x + CROSS_R, c.y, LAYERS.GROUNDING);
    dxf.addLine(c.x, c.y - CROSS_R, c.x, c.y + CROSS_R, LAYERS.GROUNDING);
  }
  // Test wells (circled rod symbol on the reference sheet): an outer circle
  // around the rod at the well position.
  const WELL_R = ROD_SYMBOL_R * 1.8;
  for (const w of plan.testWells) {
    dxf.addArc(w.x, w.y, WELL_R, 0, Math.PI, true, LAYERS.GROUNDING);
    dxf.addArc(w.x, w.y, WELL_R, Math.PI, 0, true, LAYERS.GROUNDING);
  }
  // Key note — quantities takeoff, clearly labeled screening only.
  const allLoopPts = (plan.loops ?? [plan.loop]).flat();
  const xs = allLoopPts.map(p => p.x);
  const ys = allLoopPts.map(p => p.y);
  const nx = Math.min(...xs);
  const ny = Math.min(...ys) - 14;
  const s = plan.summary;
  dxf.addText(nx, ny, TEXT_H,
    `GROUNDING (SCREENING): LOOP ${Math.round(s.loopLengthFt)} LF, GRID ${Math.round(s.gridLengthFt)} LF, ${s.rodCount} RODS @ ${s.rodSpacingFt} FT, ${s.testWellCount} TEST WELLS, ${s.crossingCount} GRID CROSSINGS, ${s.tapCount} TAPS, TOTAL ${Math.round(s.totalConductorFt)} LF`,
    LAYERS.GROUNDING);
  dxf.addText(nx, ny - TEXT_H * 1.6, TEXT_H,
    `CONDUCTOR ${GROUND_CONDUCTOR_SPEC}, RODS ${GROUND_ROD_SPEC}`,
    LAYERS.GROUNDING);
  dxf.addText(nx, ny - TEXT_H * 3.2, TEXT_H,
    'QUANTITY TAKEOFF ONLY - NOT AN IEEE-80 GRID RESISTANCE / TOUCH-STEP STUDY',
    LAYERS.GROUNDING);
}

// Distance from a point to a polygon boundary (min over edges).
function distToPolyEdge(p: Pt, poly: Pt[]): number {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const dx = b.x - a.x, dy = b.y - a.y;
    const L2 = dx * dx + dy * dy;
    const t = L2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2)) : 0;
    const ex = a.x + t * dx - p.x, ey = a.y + t * dy - p.y;
    const d = Math.hypot(ex, ey);
    if (d < best) best = d;
  }
  return best;
}

// Distance from a point to a rotated equipment rectangle (0 when inside).
function distToEquipRect(p: Pt, eq: PlacedEquipment): number {
  const c = Math.cos(-eq.rotation), s = Math.sin(-eq.rotation);
  const lx = (p.x - eq.x) * c - (p.y - eq.y) * s;
  const ly = (p.x - eq.x) * s + (p.y - eq.y) * c;
  const ox = Math.max(Math.abs(lx) - eq.length / 2, 0);
  const oy = Math.max(Math.abs(ly) - eq.width / 2, 0);
  return Math.hypot(ox, oy);
}

// Pick the label vertex for an index contour. Scoring per vertex:
// outside the fence -> 1e6 + distance to fence (label clears the yard and
// all equipment/annotation inside it); inside the fence -> distance to the
// nearest equipment rectangle. Highest score wins; ties keep the lowest
// vertex index, so placement is fully deterministic.
export function contourLabelVertex(pts: Pt[], design?: SiteDesign): number {
  if (!design || design.fence.length < 3 || pts.length < 2) {
    return Math.floor(pts.length / 2);
  }
  let bestIdx = Math.floor(pts.length / 2);
  let bestScore = -Infinity;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    let score: number;
    if (!pointInPolygon(p, design.fence)) {
      score = 1e6 + distToPolyEdge(p, design.fence);
    } else {
      score = Infinity;
      for (const eq of design.equipment) {
        const d = distToEquipRect(p, eq);
        if (d < score) score = d;
      }
      if (!Number.isFinite(score)) score = 0;
    }
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }
  return bestIdx;
}

// Fence linework with the recognizable "X" fence pattern (register F-15):
// the polyline plus X ticks every FENCE_TICK_SPACING ft along its length.
// SINGLE SOURCE for plan and legend — the legend fence swatch calls this
// same helper, so the legend symbol is the definition the plan places.
export function drawFenceLine(
  dxf: DxfWriter, pts: number[][], closed: boolean, layer: string,
  spacing = FENCE_TICK_SPACING, half = FENCE_TICK_HALF,
) {
  dxf.addPolyline(pts, layer, closed);
  const segs: Array<[number[], number[]]> = [];
  for (let i = 0; i + 1 < pts.length; i++) segs.push([pts[i], pts[i + 1]]);
  if (closed && pts.length > 2) segs.push([pts[pts.length - 1], pts[0]]);
  // Continuous arc-length walk so tick rhythm doesn't reset at each vertex.
  let carry = spacing / 2;
  for (const [a, b] of segs) {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    if (!(len > 1e-9)) continue;
    const ux = dx / len, uy = dy / len;
    // X = two crossing ticks at ±45° to the fence direction.
    const d1x = (ux - uy) * Math.SQRT1_2, d1y = (uy + ux) * Math.SQRT1_2;
    const d2x = (ux + uy) * Math.SQRT1_2, d2y = (uy - ux) * Math.SQRT1_2;
    let s = carry;
    while (s <= len) {
      const cx = a[0] + ux * s, cy = a[1] + uy * s;
      dxf.addLine(cx - d1x * half, cy - d1y * half, cx + d1x * half, cy + d1y * half, layer);
      dxf.addLine(cx - d2x * half, cy - d2y * half, cx + d2x * half, cy + d2y * half, layer);
      s += spacing;
    }
    carry = s - len;
  }
}

// Site boundary (lot line) + fence
export function drawBoundaryAndFence(dxf: DxfWriter, design: SiteDesign) {
  dxf.addPolyline(design.boundary.polygon.map(p => [p.x, p.y]), LAYERS.BOUNDARY, true);
  if (showSeparateFence(design)) {
    drawFenceLine(dxf, design.fence.map(p => [p.x, p.y]), true, LAYERS.FENCE);
  }
}

// Rotation-aware AABB of a TEXT string at (x, y) with height h — the same
// len*h*CHAR_W glyph-box estimate the enlarged-tile fitter uses, corners
// rotated about the baseline-left anchor then AABB'd.
function textAabb(x: number, y: number, h: number, text: string, rotDeg = 0) {
  const w = text.length * h * CHAR_W;
  const rad = (rotDeg * Math.PI) / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const [px, py] of [[0, 0], [w, 0], [w, h], [0, h]]) {
    const gx = x + px * cos - py * sin;
    const gy = y + px * sin + py * cos;
    if (gx < minX) minX = gx; if (gx > maxX) maxX = gx;
    if (gy < minY) minY = gy; if (gy > maxY) maxY = gy;
  }
  return { minX, maxX, minY, maxY };
}

type TextRect = ReturnType<typeof textAabb>;

// Text extents of every spacing / clearance / setback dimension string,
// computed by running the dimension generator into a scratch writer — a
// pure, deterministic function of the design. Used to place trench callouts
// clear of dimension text emitted later in the compose order, so the SOURCE
// sheets never ship a callout-on-dimension overlap in the first place.
export function dimensionTextExtents(design: SiteDesign): TextRect[] {
  const scratch = new DxfWriter();
  addSpacingDimensions(scratch, design);
  const out: TextRect[] = [];
  for (const op of scratch.ops) {
    if (op.kind === 'text') out.push(textAabb(op.x, op.y, op.h, op.text, op.rot ?? 0));
  }
  return out;
}

// Deterministic de-collision nudge for a callout: slide along its run axis
// (unit vector ux, uy) in TEXT_H-sized steps — offsets tried in the fixed
// order 0, +1, -1, +2, -2, ... — until the padded extent clears every
// blocker. Falls back to the original spot when no bounded offset clears
// (never silently drops the callout).
export function nudgeCalloutClear(
  x: number, y: number, h: number, text: string, rotDeg: number,
  ux: number, uy: number, blockers: TextRect[],
): { x: number; y: number } {
  const pad = h * 0.15;
  const clear = (cx: number, cy: number) => {
    const e = textAabb(cx, cy, h, text, rotDeg);
    return !blockers.some(b =>
      e.minX - pad < b.maxX && b.minX < e.maxX + pad &&
      e.minY - pad < b.maxY && b.minY < e.maxY + pad);
  };
  if (clear(x, y)) return { x, y };
  const step = TEXT_H * 2;
  for (let k = 1; k <= 25; k++) {
    for (const s of [k, -k]) {
      const cx = x + ux * step * s, cy = y + uy * step * s;
      if (clear(cx, cy)) return { x: cx, y: cy };
    }
  }
  // Axis scan exhausted (the band can be fully flanked — e.g. island aug
  // units at both corridor ends plus dimension strings mid-band). Step
  // outward in perpendicular lanes and rescan the axis in each: a clear
  // slot always exists a few lanes out, and this phase only runs where the
  // old behavior was an overlapping fallback anyway.
  const px = -uy, py = ux;
  for (let m = 1; m <= 8; m++) {
    for (const t of [m, -m]) {
      const bx = x + px * step * t, by = y + py * step * t;
      if (clear(bx, by)) return { x: bx, y: by };
      for (let k = 1; k <= 25; k++) {
        for (const s of [k, -k]) {
          const cx = bx + ux * step * s, cy = by + uy * step * s;
          if (clear(cx, cy)) return { x: cx, y: cy };
        }
      }
    }
  }
  return { x, y };
}

// 480V aux + fiber trench band: outline rect + rotated label along the band
// (drawn before cables so the runs read on top of the band). Callout
// positions are nudged along the band to clear dimension text (which the
// compose order emits later) — see dimensionTextExtents.
export function drawTrench(dxf: DxfWriter, design: SiteDesign) {
  if (!dxf.visibilityEnabled(['fiber', 'auxiliaryCables'])) return;
  const hasTrench = !!design.trench || (design.corridorTrenches ?? []).length > 0;
  // Blockers: dimension text (emitted later in compose order) PLUS the
  // future-augmentation footprints — a trench callout hidden inside an aug
  // block's mesh is unreadable (user-reported on the mirrored-island plan).
  const dimExts = hasTrench ? dimensionTextExtents(design) : [];
  if (hasTrench) {
    for (const z of design.reservedZones ?? []) {
      if (z.kind !== 'futureAug') continue;
      dimExts.push({ minX: z.x - z.length / 2, maxX: z.x + z.length / 2,
        minY: z.y - z.width / 2, maxY: z.y + z.width / 2 });
    }
    for (const eq of design.futureEquipment ?? []) {
      const a = ((eq.rotation ?? 0) * Math.PI) / 180;
      const hx = Math.abs(Math.cos(a)) * eq.length / 2 + Math.abs(Math.sin(a)) * eq.width / 2;
      const hy = Math.abs(Math.sin(a)) * eq.length / 2 + Math.abs(Math.cos(a)) * eq.width / 2;
      dimExts.push({ minX: eq.x - hx, maxX: eq.x + hx, minY: eq.y - hy, maxY: eq.y + hy });
    }
  }
  // Placed equipment blocks the SPINE callout only (its lane fallback can
  // wander sideways into gear labels like AUX/COMMS). Corridor callouts
  // slide along their own band where equipment always flanks the corridor —
  // blocking on it would leave them no clear slot at all.
  const eqExts: TextRect[] = [];
  if (hasTrench && design.trench) {
    for (const eq of design.equipment) {
      const a = eq.rotation ?? 0;
      const hx = Math.abs(Math.cos(a)) * eq.length / 2 + Math.abs(Math.sin(a)) * eq.width / 2;
      const hy = Math.abs(Math.sin(a)) * eq.length / 2 + Math.abs(Math.cos(a)) * eq.width / 2;
      eqExts.push({ minX: eq.x - hx - 3, maxX: eq.x + hx + 3, minY: eq.y - hy - 3, maxY: eq.y + hy + 3 });
    }
  }
  // Per-island 480V aux & fiber corridor trench bands (mirrored-pair layouts):
  // horizontal rects along each island centerline, labeled once per island.
  // Callout PLACEMENT runs as a pre-pass (each placed callout blocks the
  // next, and the spine callout below must dodge all of them), but the
  // spine text is EMITTED first — downstream tile decluttering treats the
  // spine as the primary callout and collapses nearby corridor repeats.
  const TRENCH_TXT = '480V AUX AND FIBER TRENCH';
  const corridorPlaced: { x: number; y: number; rot: number }[] = [];
  for (const c of design.corridorTrenches ?? []) {
    // Effective angle: use angleDeg when available, fall back to vertical flag.
    const cDeg = c.angleDeg ?? (c.vertical ? 90 : 0);
    const cRad = (cDeg * Math.PI) / 180;
    // Corridor center in site coordinates
    const ccx = c.cx ?? (c.vertical ? c.y : (c.minX + c.maxX) / 2);
    const ccy = c.cy ?? (c.vertical ? (c.minX + c.maxX) / 2 : c.y);
    if (c.vertical || (cDeg % 90 === 0 && cDeg % 180 !== 0)) {
      // Legacy vertical path — keep existing nudge behavior
      const pv = nudgeCalloutClear(
        ccx + c.width / 2 + 2, ccy - 60, TEXT_H, TRENCH_TXT, 90, 0, 1, dimExts);
      corridorPlaced.push({ x: pv.x, y: pv.y, rot: 90 });
      dimExts.push(textAabb(pv.x, pv.y, TEXT_H, TRENCH_TXT, 90));
    } else if (cDeg === 0) {
      // Legacy horizontal path
      const ph = nudgeCalloutClear(
        ccx - 60, ccy + c.width / 2 + 2, TEXT_H, TRENCH_TXT, 0, 1, 0, dimExts);
      corridorPlaced.push({ x: ph.x, y: ph.y, rot: 0 });
      dimExts.push(textAabb(ph.x, ph.y, TEXT_H, TRENCH_TXT, 0));
    } else {
      // Arbitrary angle: place callout perpendicular to the corridor, offset by
      // half-width + 2 ft in the direction 90° CCW from the corridor axis.
      const perpX = -Math.sin(cRad), perpY = Math.cos(cRad);
      const tx = ccx + perpX * (c.width / 2 + 2);
      const ty = ccy + perpY * (c.width / 2 + 2);
      const labelRot = ((cDeg % 180) + 180) % 180;
      corridorPlaced.push({ x: tx, y: ty, rot: labelRot });
      dimExts.push(textAabb(tx, ty, TEXT_H, TRENCH_TXT, labelRot));
    }
  }
  // Yard spine trench: band + callout, emitted before the corridor texts.
  if (design.trench) {
    const t = design.trench;
    dxf.addPolyline(
      [
        [t.x - t.width / 2, t.yBottom],
        [t.x + t.width / 2, t.yBottom],
        [t.x + t.width / 2, t.yTop],
        [t.x - t.width / 2, t.yTop],
      ],
      LAYERS.TRENCH,
      true
    );
    // Anchor the spine callout at the FIRST island's latitude (same
    // neighborhood as the first island's own corridor callout) instead of
    // the yard midpoint — the midpoint lands between islands where the
    // second island's augmentation block hides it. The scan is bounded to
    // the trench extents so the callout can never detach from its band.
    const corr0 = (design.corridorTrenches ?? [])[0];
    const anchorY = corr0
      ? (corr0.vertical ? (corr0.minX + corr0.maxX) / 2 : corr0.y)
      : (t.yBottom + t.yTop) / 2;
    const txt = '480V AUX AND FIBER TRENCH';
    const labelLen = txt.length * CHAR_W * TEXT_H;
    const lo = t.yBottom + 2, hi = Math.max(lo, t.yTop - labelLen - 2);
    const clampY = (yy: number) => Math.max(lo, Math.min(hi, yy));
    const pad = TEXT_H * 0.15;
    const spineBlockers = dimExts.concat(eqExts);
    const clearAt = (xx: number, yy: number) => !spineBlockers.some(b =>
      xx - TEXT_H - pad < b.maxX && b.minX < xx + pad &&
      yy - pad < b.maxY && b.minY < yy + labelLen + pad);
    // Scan along the trench first; if a short trench leaves no clear slot
    // (label nearly spans the band), step outward in perpendicular lanes —
    // a clear spot always exists a few lanes out.
    // Distance-from-anchor outer, lane inner: stay as close to the first
    // island's latitude as possible, stepping sideways before drifting away.
    let lx = t.x + t.width / 2 + 2, ly = clampY(anchorY - 60);
    outerSpine:
    for (let k = 0; k <= 50; k++) {
      const cand = clampY(anchorY - 60 + (k % 2 ? (k + 1) / 2 : -k / 2) * TEXT_H * 2);
      for (let lane = 0; lane <= 12; lane++) {
        const cx = t.x + t.width / 2 + 2 + lane * (TEXT_H + 2);
        if (clearAt(cx, cand)) { lx = cx; ly = cand; break outerSpine; }
      }
    }
    dxf.withVisibility('labels', () => {
      dxf.addText(lx, ly, TEXT_H, txt, LAYERS.TEXT_SM, 90);
    });
  }
  // Corridor bands + their (pre-placed) callout texts.
  // Use oriented rotated-rect for any angle; axis-aligned polyline for 0°/90°
  // (keeps legacy geometry byte-identical for existing designs).
  (design.corridorTrenches ?? []).forEach((c, i) => {
    const cDeg = c.angleDeg ?? (c.vertical ? 90 : 0);
    const cRad = (cDeg * Math.PI) / 180;
    const ccx = c.cx ?? (c.vertical ? c.y : (c.minX + c.maxX) / 2);
    const ccy = c.cy ?? (c.vertical ? (c.minX + c.maxX) / 2 : c.y);
    const cLen = c.length ?? (c.vertical ? c.maxX - c.minX : c.maxX - c.minX);
    if (cDeg === 90 || c.vertical) {
      dxf.addPolyline(
        [
          [c.y - c.width / 2, c.minX],
          [c.y + c.width / 2, c.minX],
          [c.y + c.width / 2, c.maxX],
          [c.y - c.width / 2, c.maxX],
        ],
        LAYERS.TRENCH,
        true
      );
    } else if (cDeg === 0) {
      dxf.addPolyline(
        [
          [c.minX, c.y - c.width / 2],
          [c.maxX, c.y - c.width / 2],
          [c.maxX, c.y + c.width / 2],
          [c.minX, c.y + c.width / 2],
        ],
        LAYERS.TRENCH,
        true
      );
    } else {
      // Arbitrary angle: draw as a rotated rectangle centered at cx/cy.
      dxf.addRotatedRect(ccx, ccy, cLen, c.width, cRad, LAYERS.TRENCH);
    }
    const p = corridorPlaced[i];
    dxf.withVisibility('labels', () => {
      dxf.addText(p.x, p.y, TEXT_H, TRENCH_TXT, LAYERS.TEXT_SM, p.rot);
    });
  });
}

// Cable runs per Sheets 3-4: open LWPOLYLINEs, one layer per cable class
// (DC (+) red / DC (−) blue pairs, MV cyan / LVAC blue / fiber orange),
// 1:1 from layout feet.
// Reference-only runs (augmentation stubs) go on a dedicated DASHED layer
// so CAD output distinguishes conceptual stubs from installed conduit.
export function drawCables(dxf: DxfWriter, design: SiteDesign) {
  design.cables.forEach(run => {
    const layer = run.ref
      ? (run.class === 'MV' ? LAYERS.CABLE_MV_REF : LAYERS.CABLE_DC_REF)
      : run.class === 'DC' && run.polarity
        ? (run.polarity === 'pos' ? LAYERS.CABLE_DC_POS : LAYERS.CABLE_DC_NEG)
        : CABLE_LAYER[run.class];
    dxf.withProvenance({
      sourceRenderer: 'canonical-cable',
      role: run.class === 'DC' && !run.ref ? 'dc-conductor' : 'cable-conductor',
      symbolResolution: 'not-applicable',
    }, () => dxf.addPolyline(run.pts.map(p => [p.x, p.y]), layer, false));
  });
}

// Equipment - simple rectangles straight from layout positions, all on the
// main equipment outline layer; identity carried by labels (per reference DWGs)
// Equipment label with a solid white mask beneath it (drafting wipeout
// equivalent): the union AABB of the label lines, padded, plots as a SOLID
// white hatch so tags stay readable over symbol artwork,
// and any cable/feeder run that crosses the block. Labels plot bold black.
function emitEquipmentLabel(dxf: DxfWriter, eq: PlacedEquipment, config?: BessConfiguration, ctx?: LabelContext) {
  const lines = equipmentLabelLayout(eq, config, ctx);
  if (!lines.length) return;
  if (dxf.layerColors[LAYERS.LABEL_MASK] === undefined) {
    dxf.addLayer(LAYERS.LABEL_MASK, 255);
  }
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const line of lines) {
    const r = textAabb(line.x, line.y, line.h, line.text, line.rot ?? 0);
    if (r.minX < minX) minX = r.minX; if (r.maxX > maxX) maxX = r.maxX;
    if (r.minY < minY) minY = r.minY; if (r.maxY > maxY) maxY = r.maxY;
  }
  const pad = 0.6;
  dxf.addHatchLoops([[
    [minX - pad, minY - pad], [maxX + pad, minY - pad],
    [maxX + pad, maxY + pad], [minX - pad, maxY + pad],
  ]], LAYERS.LABEL_MASK, 'SOLID');
  for (const line of lines) {
    dxf.addText(line.x, line.y, line.h, line.text, LAYERS.EQUIP_LABELS, line.rot);
  }
}

// Labels-only pass: sheet compositions that draw feeder/cable geometry AFTER
// the equipment call drawEquipment(..., skipLabels) and then this at the end,
// so every label + its white mask plots on TOP of the routing linework.
export function drawEquipmentLabels(dxf: DxfWriter, design: SiteDesign, config?: BessConfiguration) {
  const ctx: LabelContext = { equipment: design.equipment, cables: design.cables };
  // Future/augmentation units carry no built-unit label — they read as
  // dashed future footprints under the group envelope + title, exactly like
  // the auto layouts' future ghosts (which never enter this pass at all).
  design.equipment.forEach(eq => {
    if (eq.augmented || eq.future) return;
    emitEquipmentLabel(dxf, eq, config, ctx);
  });
}

export function drawEquipment(dxf: DxfWriter, design: SiteDesign, config?: BessConfiguration, eci?: boolean, skipLabels?: boolean) {
  const ctx: LabelContext = { equipment: design.equipment, cables: design.cables };
  design.equipment.forEach(eq =>
    dxf.withProvenance({ sourceRenderer: 'canonical-equipment' }, () =>
      drawOneEquipment(dxf, eq, config, eci, skipLabels, ctx)));
  // Traced future/aug units draw only dashed footprints above; the group
  // envelope + title ships with the SAME pass so every sheet that renders
  // equipment (site plan, cable/trench plan, cover overlays, enlarged tiles)
  // reads the region as FUTURE — never dashed rects with no explanation.
  dxf.withProvenance({ sourceRenderer: 'canonical-future-region' }, () =>
    drawTracedFutureEnvelopes(dxf, design));
}

export function drawTracedFutureEnvelopes(dxf: DxfWriter, design: SiteDesign) {
  const flagged = design.equipment.filter(e => e.augmented || e.future);
  if (!flagged.length) return;
  const rotBounds = (cx: number, cy: number, len: number, wid: number, rotDeg: number) => {
    const a = (rotDeg * Math.PI) / 180;
    const hx = Math.abs(Math.cos(a)) * len / 2 + Math.abs(Math.sin(a)) * wid / 2;
    const hy = Math.abs(Math.sin(a)) * len / 2 + Math.abs(Math.cos(a)) * wid / 2;
    return { minX: cx - hx, minY: cy - hy, maxX: cx + hx, maxY: cy + hy };
  };
  const fBoxes = flagged.map(e => {
    const b = rotBounds(e.x, e.y, e.length, e.width, (e.rotation * 180) / Math.PI);
    // Only future PCS/batteries earn the BESS-block envelope + title; a lone
    // flagged logistics unit (conex etc.) keeps just its dashed rect.
    return { ...b, structural: e.kind === 'bess' || e.kind === 'inverter' };
  });
  // Cluster by proximity: boxes whose AABBs come within the merge gap join
  // one group (single-link union-find). Half-gap each side spans the
  // intra-ladder unit spacing while separate corners of the yard stay apart.
  const HALF_GAP = 12.5;
  const parent = fBoxes.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < fBoxes.length; i++) {
    for (let j = i + 1; j < fBoxes.length; j++) {
      const a = fBoxes[i], b = fBoxes[j];
      if (a.minX - HALF_GAP <= b.maxX + HALF_GAP && b.minX - HALF_GAP <= a.maxX + HALF_GAP &&
          a.minY - HALF_GAP <= b.maxY + HALF_GAP && b.minY - HALF_GAP <= a.maxY + HALF_GAP) {
        parent[find(i)] = find(j);
      }
    }
  }
  const clusters = new Map<number, { minX: number; minY: number; maxX: number; maxY: number; structural: boolean }>();
  fBoxes.forEach((b, i) => {
    const r = find(i);
    const c = clusters.get(r);
    if (!c) clusters.set(r, { minX: b.minX, minY: b.minY, maxX: b.maxX, maxY: b.maxY, structural: b.structural });
    else {
      c.minX = Math.min(c.minX, b.minX); c.minY = Math.min(c.minY, b.minY);
      c.maxX = Math.max(c.maxX, b.maxX); c.maxY = Math.max(c.maxY, b.maxY);
      c.structural = c.structural || b.structural;
    }
  });
  for (const c of Array.from(clusters.values())) {
    if (!c.structural) continue;
    // Light-gray ANSI37 mesh over the whole group (ACI 9) — same treatment
    // as the auto island envelopes in drawReservedZones: mesh reads as
    // background.
    dxf.withProvenance({
      role: 'future-region',
      symbolResolution: 'not-applicable',
    }, () => dxf.addHatch(
      [[c.minX, c.minY], [c.maxX, c.minY], [c.maxX, c.maxY], [c.minX, c.maxY]],
      LAYERS.FUTURE_BESS, 'ANSI37', 9));
    // Title fitted inside the envelope along its long axis, bold black on
    // the LARGE-text layer — identical construction to the zone titles.
    const label = 'FUTURE BESS AUGMENTATION BLOCK';
    const spanX = c.maxX - c.minX, spanY = c.maxY - c.minY;
    const vertical = spanY > spanX;
    const along = (vertical ? spanY : spanX) * 0.85;
    const h = Math.min(TEXT_H, along / (label.length * CHAR_W));
    dxf.withVisibility('labels', () => {
      dxf.addCenteredText(
        (c.minX + c.maxX) / 2 + (vertical ? -h / 2 : 0),
        (c.minY + c.maxY) / 2 + (vertical ? 0 : h / 2),
        h, label, LAYERS.TEXT_LG, 7, { rot: vertical ? 90 : 0, est: CHAR_W });
    });
  }
}

function builtEquipmentOutlineLayer(dxf: DxfWriter, eq: PlacedEquipment): string {
  void eq;
  // Every unresolved built kind uses one intentional neutral fallback.
  // The red EQUIP layer is reserved for authored legacy detail, never a plain
  // generated footprint around panels, junction boxes, logistics equipment,
  // substation gear, PCS or containers.
  if (dxf.layerColors[LAYERS.SYM_DARK] === undefined) dxf.addLayer(LAYERS.SYM_DARK, 8);
  return LAYERS.SYM_DARK;
}

export function bessDoorTick(eq: PlacedEquipment): { a: Pt; b: Pt } | null {
  if (eq.kind !== 'bess' || !eq.doorEnd || !eq.epanel) return null;
  // Preserve the existing cardinal handing rule, then transform the stripe
  // through the unit's exact pose so arbitrary traced angles land on the
  // rotated end wall instead of snapping horizontal/vertical.
  const vertical = Math.abs(Math.sin(eq.rotation)) > 0.5;
  const endSgn = vertical ? eq.doorEnd : (eq.epanel === 'left' ? -1 : 1);
  const lx = endSgn * (eq.length / 2 - 0.8);
  const halfStripe = eq.width * 0.45;
  const c = Math.cos(eq.rotation), s = Math.sin(eq.rotation);
  const world = (ly: number): Pt => ({
    x: eq.x + lx * c - ly * s,
    y: eq.y + lx * s + ly * c,
  });
  return { a: world(-halfStripe), b: world(halfStripe) };
}

export function drawEquipmentFootprints(dxf: DxfWriter, design: SiteDesign) {
  // Traced future/augmentation units keep the same reading here as in the
  // full plan drawer: a footprint rect on the future layer (dashed via the
  // layer linetype), never a built-scope EQUIP rect. Auto layouts' future
  // ghosts live in reservedZones, not design.equipment, so their key maps
  // are byte-identical.
  design.equipment.forEach(eq => {
    const layer = (eq.augmented || eq.future)
      ? LAYERS.FUTURE_BESS
      : builtEquipmentOutlineLayer(dxf, eq);
    dxf.withProvenance({
      sourceRenderer: 'permit-key-map-footprint',
      role: eq.augmented || eq.future ? 'future-equipment-outline' : 'neutral-equipment-outline',
      equipmentId: eq.id,
      equipmentKind: eq.kind,
      symbolResolution: eq.augmented || eq.future ? 'not-applicable' : 'neutral-fallback',
    }, () => dxf.addRotatedRect(eq.x, eq.y, eq.length, eq.width, eq.rotation, layer));
  });
  // Same invariant as drawEquipment: every path that renders the yard's
  // equipment must explain the future group (ANSI37 mesh + fitted title).
  dxf.withProvenance({ sourceRenderer: 'permit-key-map-footprint' }, () =>
    drawTracedFutureEnvelopes(dxf, design));
}

// Single-equipment drawer — the ONE code path that turns a placed unit into
// plan linework. The legend swatches call this too (with a synthetic unit),
// so a legend symbol can never drift from the layout symbol.
export function drawOneEquipment(dxf: DxfWriter, eq: PlacedEquipment, config?: BessConfiguration, eci?: boolean, skipLabels?: boolean, ctx?: LabelContext): void {
  // This exported primitive is also useful standalone. Default such calls to
  // the canonical path while preserving an outer legend/permit renderer scope.
  if (!dxf.hasProvenanceSourceRenderer()) {
    dxf.withProvenance({ sourceRenderer: 'canonical-equipment' }, () =>
      drawOneEquipment(dxf, eq, config, eci, skipLabels, ctx));
    return;
  }
  // Future/augmentation units. KMZ-traced yards carry these INSIDE
  // design.equipment with augmented/future flags (auto layouts keep their
  // ghosts in futureEquipment + reservedZones instead). Reference
  // convention: a dashed footprint rect on EQUIP - future BESS blocks —
  // never solid symbol artwork, compartment detail or a built-unit label.
  // The ANSI37 group mesh + title come from drawTracedFutureEnvelopes
  // (attached to drawEquipment and drawEquipmentFootprints), mirroring what
  // drawReservedZones gives the auto future-augmentation regions. Auto and
  // manual units never set these flags, so every existing layout stays
  // byte-identical.
  if (eq.augmented || eq.future) {
    dxf.withProvenance({
      role: 'future-equipment-outline',
      equipmentId: eq.id,
      equipmentKind: eq.kind,
      symbolResolution: 'not-applicable',
    }, () => dxf.addRotatedRect(
      eq.x, eq.y, eq.length, eq.width, eq.rotation, LAYERS.FUTURE_BESS));
    return;
  }
  {
    // Delivered symbol mode: equipment with a delivered library symbol draws
    // that glyph mapped onto its footprint — gray shading (SYM-GRAY, ACI 9
    // light gray) under dark linework (SYM-DARK, ACI 8 dark gray), never the
    // red rectangles. The symbol carries its own door swings / compartment
    // detail, so the legacy compartment rects and door-tick markers are
    // skipped for those units; labels and kinds without a symbol (fire
    // control panel, substation yard gear) keep the legacy drawing.
    //
    // Source: the NextEra equipment GLB trace by default; `eci` selects the
    // older ECI legend library instead (it carries the two LG door-config
    // rows the GLB sheets don't).
    {
      const p = eciSymbolForEquipment(eq, config, eci ? 'eci' : 'glb');
      if (p) {
        if (p.glyph.gray.length && dxf.layerColors[LAYERS.SYM_GRAY] === undefined) {
          dxf.addLayer(LAYERS.SYM_GRAY, 9);
        }
        // Yard-scale geometry: black linework thinned toward reference
        // hairline weight, gray shading as delivered (eciYardSymbolPolys —
        // shared with the in-app scene overlay).
        const yard = eciYardSymbolPolys(p);
        // Hatch fills the outline annulus (outer + holes). Stroke ONLY the
        // outer ring — stroking hole rings draws a near-rectangular grey box
        // under the special shape (GLB annuli use a footprint-sized hole).
        const drawGroup = (polys: [number, number][][][], layer: string) => {
          for (const rings of polys) {
            dxf.addHatchLoops(rings, layer, 'SOLID');
            if (rings[0]) dxf.addPolyline(rings[0], layer, true);
          }
        };
        const symbolProvenance: DisplayOpProvenance = {
          role: 'resolved-symbol',
          equipmentId: eq.id,
          equipmentKind: eq.kind,
          symbolResolution: p.source === 'eci' ? 'delivered-eci' : 'delivered-glb',
          equipmentFrame: {
            x: eq.x,
            y: eq.y,
            length: eq.length,
            width: eq.width,
            rotation: eq.rotation,
            ...(p.compartmentAudit ? (() => {
              const [x0, y0, x1, y1] = p.compartmentAudit.bounds;
              const corners = [
                p.localToYard(x0, y0), p.localToYard(x1, y0),
                p.localToYard(x1, y1), p.localToYard(x0, y1),
              ];
              const c = Math.cos(eq.rotation), s = Math.sin(eq.rotation);
              const local = corners.map(([x, y]) => {
                const dx = x - eq.x, dy = y - eq.y;
                return [dx * c + dy * s, -dx * s + dy * c];
              });
              return {
                compartmentBounds: [
                  Math.min(...local.map(q => q[0])),
                  Math.min(...local.map(q => q[1])),
                  Math.max(...local.map(q => q[0])),
                  Math.max(...local.map(q => q[1])),
                ] as [number, number, number, number],
              };
            })() : {}),
          },
        };
        dxf.withProvenance(symbolProvenance, () => drawGroup(yard.gray, LAYERS.SYM_GRAY));
        // Symbol linework plots dark gray (SYM-DARK, ACI 8), never full
        // black: the artwork sits UNDER the labels and full black made the
        // black label text unreadable wherever a stroke crossed it.
        if (dxf.layerColors[LAYERS.SYM_DARK] === undefined) {
          dxf.addLayer(LAYERS.SYM_DARK, 8);
        }
        dxf.withProvenance(symbolProvenance, () => drawGroup(yard.black, LAYERS.SYM_DARK));
        if (!skipLabels) emitEquipmentLabel(dxf, eq, config, ctx);
        return;
      }
    }
    dxf.withProvenance({
      role: 'neutral-equipment-outline',
      equipmentId: eq.id,
      equipmentKind: eq.kind,
      symbolResolution: 'neutral-fallback',
    }, () => dxf.addRotatedRect(
      eq.x, eq.y, eq.length, eq.width, eq.rotation,
      builtEquipmentOutlineLayer(dxf, eq)));
    // Keep the BESS door-end orientation tick, but do not draw the generated
    // cable-compartment corner box. Cable routing retains its hidden landing
    // geometry independently.
    const tick = bessDoorTick(eq);
    if (tick) dxf.withProvenance({
      role: 'neutral-equipment-outline',
      equipmentId: eq.id,
      equipmentKind: eq.kind,
      symbolResolution: 'neutral-fallback',
    }, () => dxf.addLine(tick.a.x, tick.a.y, tick.b.x, tick.b.y, LAYERS.SYM_DARK));
    if (!skipLabels) emitEquipmentLabel(dxf, eq, config, ctx);
  }
}

// Reserved areas: construction laydown + future BESS block footprints —
// WYSIWYG dashed rects 1:1 from layout positions, ANSI31 hatch + centered
// label on their dedicated layers (labels on text-sm, not EQUIP - Labels).
// ---------------------------------------------------------------------------
// Drafter-drawn area zones (dry pond / wet pond / laydown yard / underground
// exclusion). Opt-in: layers are declared HERE (never in addBaseLayers) and
// only when zones are actually drawn, so zone-free exports keep the exact
// legacy layer table and entity stream (byte-identity).
const AREA_ZONE_LAYERS: Record<AreaZoneKind, {
  name: string; color: number; pattern: HatchPattern; lineType?: string;
  // Pond swatches in the reference CK1 legend are a light FILL wrapped in a
  // colored BORDER band (dry = thick brown, wet = blue). Border geometry
  // lives on its own layer so the fill and edge can carry different colors
  // (addHatch has no per-entity color override).
  border?: { name: string; color: number; widthFt: number };
}> = {
  // Fill colors sampled from the reference legend: dry (219,206,195) light
  // tan -> ACI 33 (mapped to the exact RGB in the PDF/CAD palettes), border
  // (148,110,76) brown -> ACI 23; wet fill (189,210,252) -> ACI 151, border
  // (59,122,247) -> ACI 150.
  dryPond: { name: 'ZONE - Dry pond', color: 33, pattern: 'SOLID',
    border: { name: 'ZONE - Dry pond border', color: 23, widthFt: 3 } },
  wetPond: { name: 'ZONE - Wet pond', color: 151, pattern: 'SOLID',
    border: { name: 'ZONE - Wet pond border', color: 150, widthFt: 1.5 } },
  laydown: { name: 'ZONE - Laydown yard', color: 2, pattern: 'ANSI37' },   // diamond crosshatch (reference)
  exclusion: { name: 'ZONE - Underground exclusion', color: 8, pattern: 'ANSI31', lineType: 'DASHED' },
};

// Layers may be needed by either the legend swatches (addSheetFrame) or the
// plan rectangles (drawAreaZones) — whichever runs first declares them, the
// other skips (a duplicate LAYER record would corrupt the table).
// Only the kinds actually in use get a layer — a sheet with just a laydown
// yard must not declare pond/exclusion layers it never draws on.
function ensureAreaZoneLayers(dxf: DxfWriter, kinds: AreaZoneKind[]) {
  for (const kind of kinds) {
    const def = AREA_ZONE_LAYERS[kind];
    if (!(def.name in dxf.layerColors)) dxf.addLayer(def.name, def.color, def.lineType ?? 'CONTINUOUS');
    if (def.border && !(def.border.name in dxf.layerColors)) dxf.addLayer(def.border.name, def.border.color);
  }
}

// Simple rectangles 1:1 from the stored zone positions (WYSIWYG rule):
// closed outline + the reference hatch, plus a centered kind label.
export function drawAreaZones(dxf: DxfWriter, zones: AreaZone[]) {
  if (!zones.length) return;
  ensureAreaZoneLayers(dxf, zones.map(z => z.kind));
  for (const z of zones) {
    const def = AREA_ZONE_LAYERS[z.kind];
    const x0 = z.x - z.lengthFt / 2, x1 = z.x + z.lengthFt / 2;
    const y0 = z.y - z.widthFt / 2, y1 = z.y + z.widthFt / 2;
    const loop = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
    if (def.border) {
      // Reference pond style: light fill inset inside a solid colored border
      // band (dry = thick brown, wet = blue). Band = outer loop minus inner
      // loop on the border layer; fill hatch covers the inner rect.
      const b = Math.min(def.border.widthFt, (x1 - x0) / 4, (y1 - y0) / 4);
      const inner = [[x0 + b, y0 + b], [x1 - b, y0 + b], [x1 - b, y1 - b], [x0 + b, y1 - b]];
      dxf.addPolyline(loop, def.border.name, true);
      dxf.addPolyline(inner, def.border.name, true);
      dxf.addHatchLoops([loop, inner], def.border.name, 'SOLID');
      dxf.addHatch(inner, def.name, def.pattern);
    } else {
      dxf.addPolyline(loop, def.name, true);
      dxf.addHatch(loop, def.name, def.pattern);
    }
    const label = AREA_ZONE_LABELS[z.kind];
    const h = Math.max(4, Math.min(10, z.widthFt / 8));
    dxf.withVisibility('labels', () => {
      dxf.addCenteredText(z.x, z.y - h / 2, h, label, LAYERS.TEXT_SM, undefined, { est: 0.62 });
    });
  }
}

export function drawReservedZones(dxf: DxfWriter, design: SiteDesign) {
  // Future-augmentation mesh scope: ONE ANSI37 cross-hatch per island's
  // ENTIRE augmentation area (the envelope of all that island's aug unit
  // zones + their ghost equipment, including the gaps between units) —
  // matching the issued 90% reference, where the mesh reads as a single
  // future-augmentation region, not per-footprint patches. Non-island aug
  // zones (free-grid FUTURE BESS BLOCKs) stay per-zone so a sparse lattice
  // can never get one giant envelope over unrelated ground.
  const augGroups = new Map<string, { minX: number; minY: number; maxX: number; maxY: number }>();
  const growBy = (key: string, minX: number, minY: number, maxX: number, maxY: number) => {
    const g = augGroups.get(key);
    if (!g) augGroups.set(key, { minX, minY, maxX, maxY });
    else {
      g.minX = Math.min(g.minX, minX); g.minY = Math.min(g.minY, minY);
      g.maxX = Math.max(g.maxX, maxX); g.maxY = Math.max(g.maxY, maxY);
    }
  };
  const rotRectBounds = (cx: number, cy: number, len: number, wid: number, rotDeg: number) => {
    const a = (rotDeg * Math.PI) / 180;
    const hx = Math.abs(Math.cos(a)) * len / 2 + Math.abs(Math.sin(a)) * wid / 2;
    const hy = Math.abs(Math.sin(a)) * len / 2 + Math.abs(Math.cos(a)) * wid / 2;
    return { minX: cx - hx, minY: cy - hy, maxX: cx + hx, maxY: cy + hy };
  };
  const augGroupKey = (z: { id: string; label: string }) => {
    const m = z.label.match(/\(ISLAND (\d+)\)/);
    return m ? `island-${m[1]}` : `zone-${z.id}`;
  };
  for (const z of design.reservedZones) {
    if (z.kind !== 'futureAug') continue;
    const key = augGroupKey(z);
    // Use the rotated-rect AABB so a skewed zone's envelope covers its actual footprint.
    const zb = rotRectBounds(z.x, z.y, z.length, z.width, z.angleDeg ?? 0);
    growBy(key, zb.minX, zb.minY, zb.maxX, zb.maxY);
    for (const eq of (design.futureEquipment ?? []).filter(e => e.id.startsWith(`future-${z.id}-`))) {
      const b = rotRectBounds(eq.x, eq.y, eq.length, eq.width, eq.rotation);
      growBy(key, b.minX, b.minY, b.maxX, b.maxY);
    }
  }
  const hatchedGroups = new Set<string>();
  design.reservedZones.forEach(z => dxf.withProvenance({
    sourceRenderer: 'canonical-future-region',
    role: z.kind === 'futureAug' ? 'future-region' : undefined,
    symbolResolution: 'not-applicable',
  }, () => {
    if (z.kind === 'futureAug') {
      // Future augmentation unit: individual dashed PCS/BESS footprint rects
      // (2 PCS + 6 BESS mirrored-pair arrangement) 1:1 from the ghost
      // equipment positions — WYSIWYG simple rectangles, dashed via the
      // FUTURE_BESS layer linetype. Falls back to the single zone rect for
      // designs saved before ghost equipment existed.
      const ghosts = (design.futureEquipment ?? []).filter(eq => eq.id.startsWith(`future-${z.id}-`));
      if (ghosts.length) {
        for (const eq of ghosts) {
          dxf.addRotatedRect(eq.x, eq.y, eq.length, eq.width, eq.rotation, LAYERS.FUTURE_BESS);
        }
      } else {
        // angleDeg carries the zone's rotation for placed islands at arbitrary
        // angles; 0 (or absent) = axis-aligned (the normal case).
        const zRotRad = (z.angleDeg ?? 0) * Math.PI / 180;
        dxf.addRotatedRect(z.x, z.y, z.length, z.width, zRotRad, LAYERS.FUTURE_BESS);
      }
      // Cross-hatch MESH over the ENTIRE augmentation area (island group
      // envelope, hatched once per group at its first zone) so the region
      // reads unmistakably as FUTURE — issued 90% package convention.
      const gkey = augGroupKey(z);
      if (!hatchedGroups.has(gkey)) {
        hatchedGroups.add(gkey);
        const g = augGroups.get(gkey)!;
        // Light-gray mesh (ACI 9): the full-weight black mesh buried the
        // zone titles — the mesh reads as background, the text stays black.
        dxf.addHatch(
          [
            [g.minX, g.minY],
            [g.maxX, g.minY],
            [g.maxX, g.maxY],
            [g.minX, g.maxY],
          ],
          LAYERS.FUTURE_BESS,
          'ANSI37',
          9
        );
      }
      // Title fitted INSIDE the zone, rotated along its long axis, so
      // adjacent islands' titles can never collide (user-reported overlap).
      // Explicit black (ACI 7) on the LARGE-text layer so it plots at the
      // heavy title pen weight — bold over the light-gray mesh.
      // For rotated zones the label orientation follows the zone's angleDeg
      // so it always reads along the long axis in the zone's local frame.
      const zRotDeg = z.angleDeg ?? 0;
      const vertical = z.width > z.length;
      const along = (vertical ? z.width : z.length) * 0.85;
      const h = Math.min(TEXT_H, along / (z.label.length * CHAR_W));
      const labelRotDeg = ((zRotDeg + (vertical ? 90 : 0)) % 360 + 360) % 360;
      // Offset the text anchor half a glyph height along the perpendicular
      // so it sits centered on the corridor centerline regardless of angle.
      const θlr = labelRotDeg * Math.PI / 180;
      const perpX = -Math.sin(θlr) * h / 2;
      const perpY =  Math.cos(θlr) * h / 2;
      dxf.withVisibility('labels', () => {
        dxf.addCenteredText(z.x + perpX, z.y + perpY, h, z.label, LAYERS.TEXT_LG, 7, { rot: labelRotDeg, est: CHAR_W });
      });
      return;
    }
    const layer = LAYERS.LAYDOWN;
    const laydownRotRad = (z.angleDeg ?? 0) * Math.PI / 180;
    dxf.addRotatedRect(z.x, z.y, z.length, z.width, laydownRotRad, layer);
    dxf.addHatch(
      [
        [z.x - z.length / 2, z.y - z.width / 2],
        [z.x + z.length / 2, z.y - z.width / 2],
        [z.x + z.length / 2, z.y + z.width / 2],
        [z.x - z.length / 2, z.y + z.width / 2],
      ],
      layer,
      'ANSI31'
    );
    dxf.withVisibility('labels', () => {
      dxf.addCenteredText(z.x, z.y - TEXT_H / 2, TEXT_H, z.label, LAYERS.TEXT_SM);
    });
  }));
  // Traced future/aug envelopes (flagged design.equipment) ship with the
  // equipment pass — see drawTracedFutureEnvelopes, called by drawEquipment —
  // so sheets that draw equipment without reserved zones still carry them.
}

// Crushed-rock surfacing regions: WYSIWYG multi-loop GRAVEL crosshatch 1:1
// from computed layout polygons (outer ring + equipment/reserved holes),
// plus thin boundary outlines on the same layer for CAD picking. Drawn
// before roads/equipment so everything else reads on top.
// Crushed-rock surfacing regions. The full-area GRAVEL cross-hatch ("X
// ground mesh") is OFF by default per drafter direction — the only ground
// mesh on the plot should be the future-augmentation ANSI37 areas. Passing
// mesh=true restores the legacy full-area hatch byte-identically.
export function drawSurfacing(dxf: DxfWriter, design: SiteDesign, mesh = false) {
  if (!design.surfacing) return;
  for (const region of design.surfacing.regions) {
    const outer = region.outer.map(p => [p.x, p.y]);
    const holes = region.holes.map(h => h.map(p => [p.x, p.y]));
    if (mesh) dxf.addHatchLoops([outer, ...holes], LAYERS.GRAVEL, 'GRAVEL');
    dxf.addPolyline(outer, LAYERS.GRAVEL, true);
    for (const h of holes) dxf.addPolyline(h, LAYERS.GRAVEL, true);
  }
}

// Entrance road rectangle(s) + connected road network region with fillets,
// single multi-loop SOLID hatch and (optionally) sheet-10 style callouts.
export function drawRoads(dxf: DxfWriter, design: SiteDesign, withCallouts = true) {
  design.roads.forEach(rd => {
    dxf.addRotatedRect(rd.x, rd.y, rd.length, rd.width, rd.rotation, LAYERS.ROAD);
    const hl = rd.length / 2, hw = rd.width / 2;
    const cos = Math.cos(rd.rotation), sin = Math.sin(rd.rotation);
    const pts = [
      [-hl, -hw], [hl, -hw], [hl, hw], [-hl, hw],
    ].map(([px, py]) => [rd.x + px * cos - py * sin, rd.y + px * sin + py * cos]);
    dxf.addHatch(pts, LAYERS.ROAD_HATCH, 'SOLID');
  });

  // Connected road network: one filleted outer edge path + one filleted
  // edge path per equipment island (58 ft inner / 20 ft outer turning radii
  // per sheet 10, auto-shrunk at tight tees). Shared aisle/perimeter edges
  // exist only once — the region is a single connected road surface, filled
  // with one multi-loop SOLID hatch on the DWG-standard road hatch layer.
  if (design.roadNetwork) {
    dxf.addEdgePath(design.roadNetwork.outer, LAYERS.ROAD);
    design.roadNetwork.islands.forEach(isl => dxf.addEdgePath(isl, LAYERS.ROAD));
    dxf.addHatchLoops(
      [edgePathToLoop(design.roadNetwork.outer), ...design.roadNetwork.islands.map(edgePathToLoop)],
      LAYERS.ROAD_HATCH,
      'SOLID'
    );
    if (withCallouts) addRoadCallouts(dxf, design.roadNetwork);
  }
}

// MV feeder circuits: daisy-chain hops + home-run trench per feeder, all
// 1:1 from routed feeder polylines, on the dedicated feeder layer, plus a
// substation point symbol (square + X + label) and per-feeder labels.
// Each feeder's polylines and label carry that feeder's palette ACI as an
// entity color override (layer name unchanged); the substation symbol stays
// on the neutral layer color. When `design` is given, each PCS assigned to
// a feeder also gets an open chevron in its footprint in the feeder color.
// The old closed accent rectangle made feeder 1 look like a red cable box.
const PCS_MEMBERSHIP_MARK_INSET_FT = 1.5;
// Feeder / aux-feeder plan callouts follow the issued reference drawing:
// each numbered MV callout sits in the open corridor where its OWN home run
// leaves the equipment field (so callout order reads as lane order without
// being pinned to any one compass side), and AUX FEEDER sits centered above
// the equipment field.  Text is emitted centered (`cx`) so the DXF estimate
// and the PDF's real courier metrics resolve to the same printed ink.
type FeederLabelPlacement = {
  cx: number;   // composer-intended horizontal center
  y: number;
  text: string;
  aci: number;
  w: number;    // estimated ink width (de-confliction + tests)
};

const LABEL_EST = 0.62;      // glyph width factor (matches PDF courier)
const LABEL_CLEAR_FT = 14;   // clearance held off the equipment field
const LABEL_GAP_FT = 6;      // gap between the route exit and the text box

// Rotation-agnostic bounding box of the placed equipment field. Uses each
// footprint's circumscribed radius so the result never depends on how a
// given item is rotated (and never on the rotation unit convention).
export function equipmentFieldBox(design?: SiteDesign):
  { minX: number; minY: number; maxX: number; maxY: number } | null {
  if (!design || !design.equipment.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const e of design.equipment) {
    if (!Number.isFinite(e.x) || !Number.isFinite(e.y)) continue;
    const r = Math.hypot(e.length, e.width) / 2;
    minX = Math.min(minX, e.x - r); maxX = Math.max(maxX, e.x + r);
    minY = Math.min(minY, e.y - r); maxY = Math.max(maxY, e.y + r);
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}

function overlaps(
  a: { cx: number; y: number; w: number },
  b: { cx: number; y: number; w: number }
): boolean {
  const pad = 2;
  return Math.abs(a.cx - b.cx) < (a.w + b.w) / 2 + pad
    && Math.abs(a.y - b.y) < TEXT_H + pad;
}

// Deterministic search outward from the ideal spot so a crowded corridor
// still yields stable, reproducible coordinates. `bias` 0 alternates
// (0, -step, +step, -2step…); ±1 searches one way only, which is how a
// north/south stack stays on the outboard side instead of creeping back
// over the equipment field.
function deconflict(
  ideal: { cx: number; y: number; w: number },
  placed: { cx: number; y: number; w: number }[],
  axis: 'y' | 'x',
  step: number,
  bias: -1 | 0 | 1 = 0
): { cx: number; y: number } {
  for (let i = 0; i < 24; i++) {
    const mag = Math.ceil(i / 2) * step;
    const off = bias === 0 ? (i % 2 === 1 ? -mag : mag) : bias * i * step;
    const cand = axis === 'y'
      ? { cx: ideal.cx, y: ideal.y + off, w: ideal.w }
      : { cx: ideal.cx + off, y: ideal.y, w: ideal.w };
    if (!placed.some(p => overlaps(cand, p))) return { cx: cand.cx, y: cand.y };
  }
  return { cx: ideal.cx, y: ideal.y };
}

// Pure placement helper feeding DXF, PDF and CAD through the one shared
// display-list composition path. Route geometry is never modified.
export function feederLabelStack(
  feeders: FeederCircuit[],
  design?: SiteDesign
): FeederLabelPlacement[] {
  const entries = feeders.map(f => {
    const sets = f.parallelSets || 1;
    const eolPcs = f.inverterIds.length + (f.futurePcs || 0);
    const gov = f.governing === 'voltage-drop' ? 'VD GOVERNED' : 'AMPACITY GOVERNED';
    return {
      feeder: f,
      text: `FEEDER #${feederDisplayName(f)} - BOL ${f.inverterIds.length} PCS / EOL ${eolPcs} PCS - ${sets > 1 ? `${sets}X` : ''}${f.size} KCMIL ${f.material.toUpperCase()} - ${gov}`,
    };
  }).sort((a, b) => a.feeder.idx - b.feeder.idx);
  if (!entries.length) return [];

  const bb = equipmentFieldBox(design);
  const step = TEXT_H + 3;
  const placed: { cx: number; y: number; w: number }[] = [];

  return entries.map(e => {
    const home = e.feeder.segments[e.feeder.segments.length - 1];
    const pts = home.pts;
    const last = pts[pts.length - 1];
    // Default (no equipment context): midpoint of the home run.
    let exit = { x: (pts[0].x + last.x) / 2, y: (pts[0].y + last.y) / 2 };
    let dir = { x: last.x - pts[0].x, y: last.y - pts[0].y };

    if (bb) {
      // Walk the run from the island end toward the substation and stop at
      // the first point clear of the equipment field: that is the open
      // corridor this feeder actually passes through.
      const outside = (p: { x: number; y: number }) =>
        p.x < bb.minX - LABEL_CLEAR_FT || p.x > bb.maxX + LABEL_CLEAR_FT ||
        p.y < bb.minY - LABEL_CLEAR_FT || p.y > bb.maxY + LABEL_CLEAR_FT;
      search: for (let s = 0; s < pts.length - 1; s++) {
        const a = pts[s], b = pts[s + 1];
        const segLen = Math.hypot(b.x - a.x, b.y - a.y);
        // Bounded sample count: a non-finite length would otherwise spin
        // forever, and long runs don't need foot-by-foot resolution.
        if (!Number.isFinite(segLen)) continue;
        const steps = Math.min(32, Math.max(1, Math.ceil(segLen / 2)));
        for (let k = 0; k <= steps; k++) {
          const t = k / steps;
          const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
          if (outside(p)) {
            exit = p;
            dir = { x: b.x - a.x, y: b.y - a.y };
            break search;
          }
        }
      }
    }

    const w = e.text.length * TEXT_H * LABEL_EST;
    let ideal: { cx: number; y: number; w: number };
    let axis: 'y' | 'x';
    let bias: -1 | 0 | 1 = 0;
    if (Math.abs(dir.x) >= Math.abs(dir.y)) {
      // Run leaves east/west: text reads outward from the yard, on the lane.
      const sign = dir.x < 0 ? -1 : 1;
      ideal = { cx: exit.x + sign * (LABEL_GAP_FT + w / 2), y: exit.y + 2, w };
      axis = 'y';
    } else {
      // Run leaves north/south: text centers on the lane, clear of the run.
      // Lane spacing is far narrower than a callout is wide, so these stack
      // outward in y rather than sitting side by side.
      ideal = {
        cx: exit.x,
        y: dir.y < 0 ? exit.y - LABEL_GAP_FT - TEXT_H : exit.y + LABEL_GAP_FT,
        w,
      };
      axis = 'y';
      bias = dir.y < 0 ? -1 : 1;
    }
    const pos = deconflict(ideal, placed, axis, step, bias);
    placed.push({ cx: pos.cx, y: pos.y, w });
    return { cx: pos.cx, y: pos.y, text: e.text, aci: feederColor(e.feeder.idx).aci, w };
  // A run with non-finite vertices would otherwise emit text at NaN/Infinity
  // coordinates and corrupt the DXF; drop the callout rather than the file.
  }).filter(p => Number.isFinite(p.cx) && Number.isFinite(p.y));
}

// AUX FEEDER callout: centered above the equipment field per the reference,
// nudged clear of any MV callout that already occupies that band.
export function auxFeederLabelPos(
  text: string,
  placements: FeederLabelPlacement[],
  design?: SiteDesign,
  fallback?: { x: number; y: number }
): { cx: number; y: number } {
  const w = text.length * TEXT_H * LABEL_EST;
  const bb = equipmentFieldBox(design);
  const ideal = bb
    ? { cx: (bb.minX + bb.maxX) / 2, y: bb.maxY + LABEL_CLEAR_FT, w }
    : { cx: fallback ? fallback.x : 0, y: fallback ? fallback.y : 0, w };
  return deconflict(ideal, placements, 'y', TEXT_H + 3);
}

export function drawFeedersAndSubstation(
  dxf: DxfWriter,
  feeders?: FeederCircuit[],
  substation?: Pt | null,
  design?: SiteDesign,
  // Plan-area feeder callout text only: false suppresses the FEEDER/AUX
  // FEEDER labels while keeping every route polyline, membership chevron and the
  // substation symbol (geometry and calculations are never affected).
  includeAnnotations = true,
  // `runsOnly`: draw the feeder runs WITHOUT a substation symbol. Used by the
  // per-area plan sheets of a multi-area site, where the yard's circuits are
  // clipped at the sheet window and the substation lives on another sheet.
  // Absent keeps the legacy rule (no substation ⇒ nothing drawn).
  opts?: { runsOnly?: boolean }
) {
  if ((substation || opts?.runsOnly) && feeders && feeders.length) {
    if (substation) {
      const S = 20; // half-size of the 40x40 substation symbol
      dxf.addPolyline(
        [
          [substation.x - S, substation.y - S],
          [substation.x + S, substation.y - S],
          [substation.x + S, substation.y + S],
          [substation.x - S, substation.y + S],
        ],
        LAYERS.FEEDER,
        true
      );
      dxf.addLine(substation.x - S, substation.y - S, substation.x + S, substation.y + S, LAYERS.FEEDER);
      dxf.addLine(substation.x - S, substation.y + S, substation.x + S, substation.y - S, LAYERS.FEEDER);
      dxf.withVisibility('labels', () => {
        dxf.addText(substation.x - S, substation.y + S + 3, TEXT_H, 'SUBSTATION', LAYERS.TEXT_LG);
      });
    }

    const eqById = new Map<string, PlacedEquipment>();
    if (design) for (const e of design.equipment) eqById.set(e.id, e);

    const placements = feederLabelStack(feeders, design);
    feeders.forEach(f => {
      const aci = feederColor(f.idx).aci;
      f.segments.forEach(seg => dxf.withProvenance({
        sourceRenderer: 'canonical-feeder',
        role: 'feeder-run',
        symbolResolution: 'not-applicable',
      }, () => dxf.addPolyline(
        seg.pts.map(p => [p.x, p.y]), LAYERS.FEEDER, false, aci)));
      // Open feeder-membership chevron inside each assigned PCS footprint.
      // Two line segments preserve the per-feeder color cue without creating
      // any closed four-edge cycle or changing the real cable landing data.
      for (const invId of f.inverterIds) {
        const eq = eqById.get(invId);
        if (!eq) continue;
        const len = eq.length - 2 * PCS_MEMBERSHIP_MARK_INSET_FT;
        const wid = eq.width - 2 * PCS_MEMBERSHIP_MARK_INSET_FT;
        if (len <= 0 || wid <= 0) continue;
        const hx = Math.min(len * 0.28, 4);
        const rise = Math.min(wid * 0.3, 1.5);
        const local = [[-hx, -rise / 2], [0, rise / 2], [hx, -rise / 2]];
        const c = Math.cos(eq.rotation), s = Math.sin(eq.rotation);
        const points = local.map(([x, y]) => [
          eq.x + x * c - y * s,
          eq.y + x * s + y * c,
        ]);
        dxf.withProvenance({
          sourceRenderer: 'canonical-feeder',
          role: 'feeder-membership-mark',
          equipmentId: eq.id,
          equipmentKind: eq.kind,
          symbolResolution: 'not-applicable',
        }, () => dxf.addPolyline(points, LAYERS.FEEDER, false, aci));
      }
    });
    if (includeAnnotations && dxf.visibilityEnabled('labels')) {
      for (const label of placements) {
        dxf.withProvenance({
          sourceRenderer: 'canonical-feeder',
          role: 'feeder-run',
          symbolResolution: 'not-applicable',
        }, () => dxf.addCenteredText(
          label.cx, label.y, TEXT_H, label.text, LAYERS.TEXT_SM,
          label.aci, { est: LABEL_EST }));
      }
    }

    // Substation aux feeder (34.5 kV brown daisy chain through every aux
    // transformer, CAR-D-B005-0): own layer/color so it never reads as a
    // BESS feeder. The reference places this in the open band above the
    // numbered MV stack, rather than at an incidental route midpoint.
    const aux = design?.auxFeeder;
    if (aux && aux.legs.length) {
      // Layer declared lazily — only when a circuit exists — so every
      // aux-feeder-free export stays byte-identical to the golden files.
      dxf.addLayer(LAYERS.AUX_FEEDER, COLORS.AUX_FEEDER, 'DASHED');
      for (const leg of aux.legs) {
        dxf.addPolyline(leg.pts.map(p => [p.x, p.y]), LAYERS.AUX_FEEDER, false);
      }
      let longest = aux.legs[0];
      for (const leg of aux.legs) if (leg.lengthFt > longest.lengthFt) longest = leg;
      const text = `AUX FEEDER #${auxDisplayName(aux)} (34.5 KV)`;
      const mid = {
        x: (longest.pts[0].x + longest.pts[longest.pts.length - 1].x) / 2,
        y: (longest.pts[0].y + longest.pts[longest.pts.length - 1].y) / 2 + 3,
      };
      const pos = auxFeederLabelPos(text, placements, design, mid);
      if (includeAnnotations && dxf.visibilityAllEnabled(['labels', 'auxiliaryCables'])) {
        dxf.addCenteredText(pos.cx, pos.y, TEXT_H, text, LAYERS.TEXT_SM,
          COLORS.AUX_FEEDER, { est: LABEL_EST });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Equipment schedule table: one row per equipment type actually placed,
// populated from the manufacturer spec data in the catalog. Bordered
// lines + text per the reference DWG conventions, placed clear of the
// yard (below the south fence/boundary extents).
const SCHED_TEXT_H = 3;      // schedule body text height (ft)
const SCHED_ROW_H = 6;       // row height
const SCHED_PAD = 1.2;       // cell left padding
const SCHED_TITLES = ['TAG', 'ITEM', 'MANUFACTURER', 'MODEL', 'RATING',
  'DIMS LxWxH (FT)', 'WEIGHT (LBS)', 'QTY'];

function schedDims(s: EquipmentSpec): string {
  const f = (n: number) => (Math.round(n * 10) / 10).toString();
  return `${f(s.dims.length)} x ${f(s.dims.width)} x ${f(s.dims.height)}`;
}

// Shared schedule layout: cell matrix, column widths, and the placement
// rectangle south of the yard. Used by both the drawing routine and the
// sheet-frame border computation (so the border always encloses the table).
export function computeEquipmentSchedule(design: SiteDesign, config?: BessConfiguration): {
  matrix: string[][]; colW: number[]; totalW: number;
  x0: number; yTitle: number; yTop: number; yBot: number;
} | null {
  // Order rows like the drawing legend: containers, inverters, aux gear, panels
  const KIND_ORDER = ['bess', 'inverter', 'auxTransformer', 'auxSwitchgear',
    'auxSwitchPanel', 'fiberPatchPanel', 'fireControlPanel',
    'feederJunctionBox', 'commsCabinet'];
  const rows: { spec: EquipmentSpec; qty: number }[] = [];
  for (const kind of KIND_ORDER) {
    // Future/augmentation units (KMZ-traced yards keep them in
    // design.equipment) are not built scope: the schedule quantifies the
    // BUILT yard only, matching every capacity/BOM rollup.
    const qty = design.equipment.filter(e => e.kind === kind && !e.augmented && !e.future).length;
    const spec = specForKind(kind, config);
    if (qty > 0 && spec) rows.push({ spec, qty });
  }
  if (!rows.length) return null;

  // Cell text matrix: header row + one row per equipment type
  const matrix: string[][] = [
    SCHED_TITLES,
    ...rows.map(({ spec, qty }) => [
      spec.tag, spec.item, spec.manufacturer, spec.model, spec.rating,
      schedDims(spec),
      spec.weightLbs === null ? '-' : spec.weightLbs.toLocaleString('en-US'),
      String(qty),
    ]),
  ];
  // Column widths from the longest content (STANDARD font, CHAR_W aspect)
  const colW = SCHED_TITLES.map((_, c) =>
    Math.max(...matrix.map(r => r[c].length)) * SCHED_TEXT_H * CHAR_W + 2 * SCHED_PAD);
  const totalW = colW.reduce((s, w) => s + w, 0);
  // Place below everything already drawn: south of the boundary/fence
  // extents with margin clear of the fence-overall dimension (15 ft) and
  // gate/entrance annotations.
  const xsAll = [...design.boundary.polygon, ...design.fence];
  const x0 = Math.min(...xsAll.map(p => p.x));
  const minY = Math.min(...xsAll.map(p => p.y));
  const yTitle = minY - 40;
  const yTop = yTitle - 4;
  const yBot = yTop - matrix.length * SCHED_ROW_H;
  return { matrix, colW, totalW, x0, yTitle, yTop, yBot };
}

export function addEquipmentSchedule(dxf: DxfWriter, design: SiteDesign, config?: BessConfiguration) {
  const sched = computeEquipmentSchedule(design, config);
  if (!sched) return;
  const { matrix, colW, totalW, x0, yTitle, yTop, yBot } = sched;
  const nRows = matrix.length;
  dxf.addText(x0, yTitle, TEXT_H, 'EQUIPMENT SCHEDULE', LAYERS.SCHEDULE);

  // Outer border + horizontal rules
  dxf.addPolyline([[x0, yTop], [x0 + totalW, yTop], [x0 + totalW, yBot], [x0, yBot]], LAYERS.SCHEDULE, true);
  for (let i = 1; i < nRows; i++) {
    const y = yTop - i * SCHED_ROW_H;
    dxf.addLine(x0, y, x0 + totalW, y, LAYERS.SCHEDULE);
  }
  // Vertical rules
  let cx = x0;
  for (let i = 0; i < colW.length - 1; i++) {
    cx += colW[i];
    dxf.addLine(cx, yTop, cx, yBot, LAYERS.SCHEDULE);
  }
  // Header + body text (baseline centered-ish in each row band)
  matrix.forEach((rowTexts, r) => {
    let cxx = x0;
    rowTexts.forEach((text, c) => {
      const y = yTop - (r + 1) * SCHED_ROW_H + (SCHED_ROW_H - SCHED_TEXT_H) / 2;
      dxf.addText(cxx + SCHED_PAD, y, SCHED_TEXT_H, text, LAYERS.SCHEDULE);
      cxx += colW[c];
    });
  });
}

export function gateSwingGeometry(
  g: { x: number; y: number; width: number; rotation: number },
  fence: Pt[],
) {
  const hw = g.width / 2;
  // Fence direction unit vector + inward normal (probe the fence polygon —
  // centroid heuristics flip on concave parcels).
  const ux = Math.cos(g.rotation), uy = Math.sin(g.rotation);
  let nx = -uy, ny = ux;
  if (!pointInPolygon({ x: g.x + nx * 5, y: g.y + ny * 5 }, fence)) { nx = -nx; ny = -ny; }
  const hinges: [number, number][] = [
    [g.x - hw * ux, g.y - hw * uy],
    [g.x + hw * ux, g.y + hw * uy],
  ];
  // Open leaf tip = hinge + inward normal * leaf length (half the opening).
  const leaves = hinges.map(([hx, hy]) =>
    ({ x1: hx, y1: hy, x2: hx + nx * hw, y2: hy + ny * hw }));
  // Swing arcs: quarter circle from the closed position (leaf lying along
  // the fence toward the gate center) to the open position (inward normal).
  const arcs = hinges.map(([hx, hy], i) => {
    const cx2 = i === 0 ? ux : -ux, cy2 = i === 0 ? uy : -uy; // toward center
    const start = Math.atan2(cy2, cx2);
    const end = Math.atan2(ny, nx);
    const ccw = cx2 * ny - cy2 * nx > 0;
    return { cx: hx, cy: hy, r: hw, start, end, ccw };
  });
  // Hinge posts: small squares centered on each hinge, axis-aligned to the
  // fence direction (reference sheet draws square posts at the jambs).
  const POST = 1.5;
  const posts = hinges.map(([hx, hy]) => {
    const a = POST / 2;
    return [
      [hx - a * ux - a * nx, hy - a * uy - a * ny],
      [hx + a * ux - a * nx, hy + a * uy - a * ny],
      [hx + a * ux + a * nx, hy + a * uy + a * ny],
      [hx - a * ux + a * nx, hy - a * uy + a * ny],
    ];
  });
  return { hinges, leaves, arcs, posts };
}
export function drawGate(dxf: DxfWriter, design: SiteDesign) {
  if (design.gate) {
    const g = design.gate;
    const hw = g.width / 2;
    const cos = Math.cos(g.rotation), sin = Math.sin(g.rotation);
    dxf.addLine(g.x - hw * cos, g.y - hw * sin, g.x + hw * cos, g.y + hw * sin, LAYERS.FENCE);
    const sym = gateSwingGeometry(g, design.fence);
    for (const p of sym.posts) dxf.addPolyline(p, LAYERS.FENCE, true);
    for (const l of sym.leaves) dxf.addLine(l.x1, l.y1, l.x2, l.y2, LAYERS.FENCE);
    for (const a of sym.arcs) dxf.addArc(a.cx, a.cy, a.r, a.start, a.end, a.ccw, LAYERS.GATE_SWING);
    dxf.withVisibility('labels', () => {
      dxf.addText(g.x + 5, g.y - 10, TEXT_H, 'GATE', LAYERS.TEXT_SM);
    });
  }
}

// Opt-in typical trench section schedule per the issued trench detail sheets
// CAR-D-B006-1/2: a text schedule of the catalog cross-sections (width x
// depth + installation notes), placed below the equipment schedule so the
// default entity/handle stream is untouched when not requested.
export function addTrenchSectionSchedule(dxf: DxfWriter, design: SiteDesign, config?: BessConfiguration) {
  const sched = computeEquipmentSchedule(design, config);
  // Anchor below the equipment schedule when present, else below the extents.
  const xsAll = [...design.boundary.polygon, ...design.fence];
  if (!xsAll.length) return;
  const x0 = sched ? sched.x0 : Math.min(...xsAll.map(p => p.x));
  let y = (sched ? sched.yBot : Math.min(...xsAll.map(p => p.y)) - 40) - 20;
  dxf.addText(x0, y, TEXT_H, 'TYPICAL TRENCH SECTIONS (CAR-D-B006-1/2)', LAYERS.SCHEDULE);
  y -= 8;
  const order: TrenchSectionType[] = ['MVAC_DIRECT_BURY', 'MVAC_DUCT', 'AUX_FIBER', 'DC_DUCT_BANK'];
  for (const t of order) {
    const s = TRENCH_SECTIONS[t];
    dxf.addText(x0, y, SCHED_TEXT_H,
      `${s.title}: ${ftIn(s.widthFt)} WIDE X ${ftIn(s.depthFt)} DEEP - ${s.notes} (${s.reference})`,
      LAYERS.SCHEDULE);
    y -= 6;
  }
  dxf.addText(x0, y, SCHED_TEXT_H,
    `CROSSING DETAILS PER ${TRENCH_CROSSING_REFERENCE}. SECTIONS ARE SCREENING-GRADE TYPICALS — CONSTRUCTION SECTIONS PER THE ISSUED DRAWINGS.`,
    LAYERS.SCHEDULE);
}

// Compose the complete single-sheet drawing into a writer. Shared by the DXF
// serializer and the single-page PDF plot (same display list, so the PDF can
// never drift from the exported DXF).
export function composeDesignDxf(
  dxf: DxfWriter,
  design: SiteDesign,
  projectName: string,
  config?: BessConfiguration,
  meta?: TitleBlockMeta,
  feeders?: FeederCircuit[],
  substation?: Pt | null,
  contours?: ContourSet | null,
  grounding?: GroundingPlan | null,
  trenchSections?: boolean,
  surfacingMesh?: boolean,
  areaZones?: AreaZone[] | null,
  sheetExtras?: {
    bottomBanner?: SheetFrameOptions['bottomBanner']; scaleBar?: boolean;
    eciLegend?: boolean; auxManRoute?: boolean; includeFeederNfpaAnnotations?: boolean;
    // Title-block sheet identification. Used by the per-area plans of a
    // multi-area deliverable, where several full-size sheets share one
    // package and each must say which footprint it is. Absent keeps the
    // default title block ("10% BESS LAYOUT" / "SHEET 1 OF 1") untouched.
    sheetTitle?: string; sheetLabel?: string;
    // Draw the feeder runs without a substation symbol. The per-area plans of
    // a multi-area site clip each yard's circuits at its own sheet window —
    // the substation they land on is a different footprint, drawn on its own
    // sheet and on the whole-site overview.
    feederRunsOnly?: boolean;
    // Trim border whitespace when it wins a better standard plot scale (10%
    // combined plan). Absent keeps other sheets byte-identical.
    tightenToScale?: boolean;
  },
  // Drafter text-label overrides (position/height/content deltas keyed by
  // textOverrideKey). Absent or empty keeps the output byte-identical.
  textOverrides?: Record<string, TextOverride>
): void {
  // Plan-area feeder callouts + NFPA setback dimension: shown unless the
  // drafter turned "Feeder & NFPA text" off. Legends/notes never filter.
  const feederNfpa = sheetExtras?.includeFeederNfpaAnnotations !== false;
  addBaseLayers(dxf);

  // Full sheet frame: border, site info / equipment dims / key notes /
  // legend / BOM panel, disclaimer, notes and BESSForge title block.
  // Area-zone legend rows and the issued-drawing bottom banner are opt-in:
  // exports without either keep the exact legacy call (frame === undefined
  // → schedule default true) so the default output stays byte-identical.
  const zoneKinds = areaZoneKindsPresent(areaZones);
  const wantsFrame = zoneKinds.length > 0 || !!sheetExtras?.bottomBanner || !!sheetExtras?.scaleBar || !!sheetExtras?.eciLegend || !!sheetExtras?.auxManRoute || !!sheetExtras?.sheetTitle || !!sheetExtras?.sheetLabel;
  addSheetFrame(dxf, design, projectName, config, meta, feeders, substation,
    wantsFrame ? {
      schedule: true,
      ...(zoneKinds.length ? { areaZoneKinds: zoneKinds } : {}),
      ...(sheetExtras?.bottomBanner ? { bottomBanner: sheetExtras.bottomBanner } : {}),
      ...(sheetExtras?.scaleBar ? { scaleBar: true } : {}),
      ...(sheetExtras?.eciLegend ? { eciLegend: true } : {}),
      ...(sheetExtras?.auxManRoute ? { auxManRoute: true } : {}),
      ...(sheetExtras?.sheetTitle ? { sheetTitle: sheetExtras.sheetTitle } : {}),
      ...(sheetExtras?.sheetLabel ? { sheetLabel: sheetExtras.sheetLabel } : {}),
      ...(sheetExtras?.tightenToScale ? { tightenToScale: true } : {}),
    } : undefined);

  drawBoundaryAndFence(dxf, design);
  drawSurfacing(dxf, design, surfacingMesh);
  drawTrench(dxf, design);
  drawCables(dxf, design);
  drawEquipment(dxf, design, config, !!sheetExtras?.eciLegend, true);
  drawReservedZones(dxf, design);
  drawRoads(dxf, design);

  // Spacing / clearance / setback dimensions per the guidance sheets
  addSpacingDimensions(dxf, design, feederNfpa);

  // Equipment schedule table, placed clear of the yard (south of extents)
  addEquipmentSchedule(dxf, design, config);

  drawFeedersAndSubstation(dxf, feeders, substation, design, feederNfpa,
    sheetExtras?.feederRunsOnly ? { runsOnly: true } : undefined);
  drawGate(dxf, design);
  // Labels last: white masks + tags plot over ALL yard linework
  // (feeders, cables, gate) — nothing unconditional draws after them.
  drawEquipmentLabels(dxf, design, config);

  // Opt-in existing-grade contour reference layers — drawn last so the
  // default (no contours) entity/handle stream is untouched.
  if (contours && contours.lines.length > 0) drawContours(dxf, contours, design);

  // Opt-in grounding screening layer — also drawn last, same byte-identity
  // rule as the contours: absent/null leaves the default stream untouched.
  if (grounding) drawGrounding(dxf, grounding);

  // Opt-in typical trench section schedule (CAR-D-B006-1/2) — drawn last so
  // the default DXF stays byte-identical when not requested.
  if (trenchSections) addTrenchSectionSchedule(dxf, design, config);

  // Opt-in drafter-drawn area zones — drawn last, same byte-identity rule.
  if (areaZones && areaZones.length) drawAreaZones(dxf, areaZones);
  // Opt-in text-label overrides — applied last so DXF entity and display-list
  // op are both patched before any consumer reads them. Empty/absent = no-op,
  // so designs without overrides stay byte-identical to the default output.
  if (textOverrides && Object.keys(textOverrides).length) dxf.patchTextOverridesForExport(textOverrides);
}

export function buildDesignDxfString(
  design: SiteDesign,
  projectName: string,
  config?: BessConfiguration,
  meta?: TitleBlockMeta,
  feeders?: FeederCircuit[],
  substation?: Pt | null,
  contours?: ContourSet | null,
  grounding?: GroundingPlan | null,
  trenchSections?: boolean,
  surfacingMesh?: boolean,
  areaZones?: AreaZone[] | null,
  sheetExtras?: { bottomBanner?: SheetFrameOptions['bottomBanner']; scaleBar?: boolean; eciLegend?: boolean; auxManRoute?: boolean; includeFeederNfpaAnnotations?: boolean },
  textOverrides?: Record<string, TextOverride>,
  drawingVisibility?: DrawingVisibilityProfile
): string {
  const dxf = new DxfWriter(drawingVisibility);
  composeDesignDxf(dxf, design, projectName, config, meta, feeders, substation, contours, grounding, trenchSections, surfacingMesh, areaZones, sheetExtras, textOverrides);
  return dxf.toString();
}

export function exportDesignToDXF(
  design: SiteDesign,
  projectName: string,
  config?: BessConfiguration,
  meta?: TitleBlockMeta,
  feeders?: FeederCircuit[],
  substation?: Pt | null,
  drawingVisibility?: DrawingVisibilityProfile
): Promise<boolean> {
  const content = buildDesignDxfString(design, projectName, config, meta, feeders, substation, undefined, undefined, undefined, undefined, undefined, undefined, undefined, drawingVisibility);
  const blob = new Blob([content], { type: 'application/dxf' });
  // Resolves false when the user cancels the native save dialog.
  return saveBlob(blob, `${projectName}_10pct_Design_${new Date().toISOString().slice(0, 10)}.dxf`);
}

type LabelRect = { x0: number; y0: number; x1: number; y1: number };

const CALLOUT_H_STEP = 0.15;    // text-height ladder step (ft)

const CALLOUT_GAP = 1.5;        // clear space between symbol and text (ft)

const CALLOUT_MASK_PAD = 0.6;   // label white-mask padding (emitEquipmentLabel)

/** Text anchors for a solved callout block. */
function calloutLines(
  rect: LabelRect, lines: string[], widths: number[], rot: 0 | 90,
  h: number, gap: number, maxW: number
): PlacedLabelLine[] {
  if (rot === 0) {
    // Lines stack downward from the top of the block, each centered on it.
    return lines.map((text, i) => ({
      x: rect.x0 + (maxW - widths[i]) / 2,
      y: rect.y1 - i * (h + gap) - h,
      h, text, rot: 0,
    }));
  }
  // 90 deg CCW: baseline runs +y, glyphs extend toward -x, successive lines
  // advance toward +x — the same convention as the below-box fallback.
  const cy = (rect.y0 + rect.y1) / 2;
  return lines.map((text, i) => ({
    x: rect.x0 + i * (h + gap) + h,
    y: cy - widths[i] / 2,
    h, text, rot: 90,
  }));
}

const growRect = (r: LabelRect, d: number): LabelRect =>
  ({ x0: r.x0 - d, y0: r.y0 - d, x1: r.x1 + d, y1: r.y1 + d });

const calloutCache = new WeakMap<readonly PlacedEquipment[], Map<string, PlacedLabelLine[]>>();

/** Tag line + optional model/rating line, in print order. */
function labelLinesFor(eq: PlacedEquipment, config?: BessConfiguration): string[] {
  const tag = nexteraLabel(eq);
  const spec = nexteraSpecLabel(eq, config);
  return spec ? [tag, spec] : [tag];
}

/**
 * Extent of everything the plan DRAWS for a unit: its footprint plus the
 * delivered symbol's overhang (comms-cabinet stand, transformer radiators,
 * door swings), which reaches outside the footprint by design. A callout has
 * to clear the artwork, not merely the rectangle.
 */
function drawnExtent(eq: PlacedEquipment, config?: BessConfiguration): LabelRect {
  const r = footprintRect(eq);
  const p = eciSymbolForEquipment(eq, config);
  if (!p) return r;
  let { x0, y0, x1, y1 } = r;
  for (const [nx, ny] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
    const [x, y] = p.toYard(nx, ny);
    x0 = Math.min(x0, x); y0 = Math.min(y0, y);
    x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  }
  return { x0, y0, x1, y1 };
}

function calloutLabelLayout(
  eq: PlacedEquipment,
  config: BessConfiguration | undefined,
  equipment: readonly PlacedEquipment[]
): PlacedLabelLine[] | null {
  const cacheKey = `${config?.id ?? ''}|${eq.id}`;
  let cache = calloutCache.get(equipment);
  if (cache?.has(cacheKey)) return cache.get(cacheKey)!;

  const cluster = equipment
    .filter(o => CALLOUT_KINDS.has(o.kind) && Math.hypot(o.x - eq.x, o.y - eq.y) <= CALLOUT_CLUSTER_R)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (!cluster.some(o => o.id === eq.id)) return null;
  const cx = cluster.reduce((s, o) => s + o.x, 0) / cluster.length;
  const cy = cluster.reduce((s, o) => s + o.y, 0) / cluster.length;

  // Blockers: the drawn artwork of every unit near the cluster, plus the
  // label text of the neighbors that are NOT callouts (they keep the in-box /
  // hang-below layout, which a callout must not land on).
  const WIN = CALLOUT_CLUSTER_R + 150;
  const blockers: LabelRect[] = [];
  for (const o of equipment) {
    if (Math.abs(o.x - cx) > WIN || Math.abs(o.y - cy) > WIN) continue;
    blockers.push(drawnExtent(o, config));
    if (CALLOUT_KINDS.has(o.kind)) continue;
    for (const l of equipmentLabelLayout(o, config)) {
      const t = textAabb(l.x, l.y, l.h, l.text, l.rot);
      blockers.push({ x0: t.minX, y0: t.minY, x1: t.maxX, y1: t.maxY });
    }
  }

  const sides = [
    { dir: 'n', vx: 0, vy: 1 }, { dir: 's', vx: 0, vy: -1 },
    { dir: 'e', vx: 1, vy: 0 }, { dir: 'w', vx: -1, vy: 0 },
  ] as const;

  // The cluster sits in a 10 ft island gap, so the full-size text block does
  // not always fit beside it. Solve the whole cluster at the largest text
  // height (down to the legibility floor) that clears everything; if nothing
  // is fully clear, keep the height with the least collision.
  const solveAt = (h: number) => {
    const gap = h * 0.45;
    const out = new Map<string, PlacedLabelLine[]>();
    const placed: LabelRect[] = [];
    let total = 0;
    for (const u of cluster) {
      const lines = labelLinesFor(u, config);
      const widths = lines.map(t => t.length * CHAR_W * h);
      const maxW = Math.max(...widths);
      const stack = lines.length * h + (lines.length - 1) * gap;
      const own = drawnExtent(u, config);
      const awayX = u.x - cx, awayY = u.y - cy;
      let base = 0;
      let best: { rank: number; side: number; area: number; rot: 0 | 90; rect: LabelRect } | null = null;
      for (const rot of [0, 90] as const) {
        for (const s of sides) {
          const bw = rot === 0 ? maxW : stack;
          const bh = rot === 0 ? stack : maxW;
          const rect: LabelRect =
            s.dir === 'n' ? { x0: u.x - bw / 2, y0: own.y1 + CALLOUT_GAP, x1: u.x + bw / 2, y1: own.y1 + CALLOUT_GAP + bh }
            : s.dir === 's' ? { x0: u.x - bw / 2, y0: own.y0 - CALLOUT_GAP - bh, x1: u.x + bw / 2, y1: own.y0 - CALLOUT_GAP }
            : s.dir === 'e' ? { x0: own.x1 + CALLOUT_GAP, y0: u.y - bh / 2, x1: own.x1 + CALLOUT_GAP + bw, y1: u.y + bh / 2 }
            : { x0: own.x0 - CALLOUT_GAP - bw, y0: u.y - bh / 2, x1: own.x0 - CALLOUT_GAP, y1: u.y + bh / 2 };
          // Prefer the side pointing OUT of the cluster, then the base order
          // (horizontal text first — it reads without turning the sheet).
          const dot = s.vx * awayX + s.vy * awayY;
          const side = dot > 1e-9 ? 0 : dot < -1e-9 ? 2 : 1;
          const rank = side * 100 + base;
          base++;
          const test = growRect(rect, CALLOUT_MASK_PAD);
          let area = 0;
          for (const b of blockers) area += rectOverlapArea(test, b);
          for (const b of placed) area += rectOverlapArea(test, growRect(b, CALLOUT_MASK_PAD));
          // Least collision wins; ties break on the preference rank, so an
          // uncluttered cluster always lands on the outward side.
          if (!best || (Math.abs(area - best.area) > 1e-6 ? area < best.area : rank < best.rank)) {
            best = { rank, side, area, rot, rect };
          }
        }
      }
      if (!best) continue;
      placed.push(best.rect);
      // Collision dominates; a callout that points OUT of the cluster is
      // worth dropping one step of text height for (an inward callout floats
      // between two symbols and reads as belonging to either).
      total += best.area * 1000 + best.side;
      out.set(`${config?.id ?? ''}|${u.id}`, calloutLines(best.rect, lines, widths, best.rot, h, gap, maxW));
    }
    return { total, out };
  };

  let solved = new Map<string, PlacedLabelLine[]>();
  let bestScore = Infinity;
  for (let step = 0; step * CALLOUT_H_STEP < LABEL_FALLBACK_H - LABEL_MIN_H + 1e-9; step++) {
    const h = Math.round((LABEL_FALLBACK_H - step * CALLOUT_H_STEP) * 100) / 100;
    const run = solveAt(h);
    // One height step costs the same as pushing one callout off its outward
    // side: shrink the text only when it buys a genuinely better placement.
    const score = run.total + step;
    // Strictly-better only, so the LARGEST height wins any tie.
    if (score < bestScore - 1e-6) { bestScore = score; solved = run.out; }
  }

  if (!cache) { cache = new Map(); calloutCache.set(equipment, cache); }
  solved.forEach((v, k) => cache!.set(k, v));
  return solved.get(cacheKey) ?? null;
}

const CALLOUT_CLUSTER_R = 80;   // units this close compete for label space

/** Rest-of-drawing context a callout needs to find free space. */
export interface LabelContext {
  equipment: readonly PlacedEquipment[];
  cables?: readonly CableRun[];
}

const rectOverlapArea = (a: LabelRect, b: LabelRect): number =>
  Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) *
  Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));

/** Axis-aligned footprint of a placed unit (rotations are multiples of 90). */
function footprintRect(eq: PlacedEquipment): LabelRect {
  const rotated = Math.abs(Math.sin(eq.rotation)) > 0.5;
  const xl = (rotated ? eq.width : eq.length) / 2;
  const yl = (rotated ? eq.length : eq.width) / 2;
  return { x0: eq.x - xl, y0: eq.y - yl, x1: eq.x + xl, y1: eq.y + yl };
}
