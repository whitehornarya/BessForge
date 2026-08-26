import type { CableRun, EquipmentKind, PlacedEquipment, Pt } from './types';

export const EQUIPMENT_LABEL_BASE_FONT_FT = 3.2;
export const EQUIPMENT_LABEL_SMALL_FONT_FT = 2.2;
export const EQUIPMENT_LABEL_OUTLINE_FT = 0.25;
export const EQUIPMENT_LABEL_MAX_DISTANCE_SCALE = 3.5;

const SMALL_LABEL_KINDS = new Set<EquipmentKind>([
  'auxSwitchPanel',
  'fiberPatchPanel',
  'fireControlPanel',
  'feederJunctionBox',
  'commsCabinet',
]);

const LONG_AXIS_LABEL_KINDS = new Set<EquipmentKind>([
  'bess',
  'inverter',
  'conex',
]);

export function equipmentLabelFontSize(eq: Pick<PlacedEquipment, 'kind'>): number {
  return SMALL_LABEL_KINDS.has(eq.kind)
    ? EQUIPMENT_LABEL_SMALL_FONT_FT
    : EQUIPMENT_LABEL_BASE_FONT_FT;
}

export interface EquipmentLabelBounds {
  width: number;
  height: number;
}

/**
 * Conservative first-pass bounds used until Troika finishes asynchronous
 * text layout and reports the exact visible glyph bounds.
 */
export function equipmentLabelEstimatedBounds(
  eq: Pick<PlacedEquipment, 'kind'>,
  text: string,
): EquipmentLabelBounds {
  const fontSize = equipmentLabelFontSize(eq);
  const lines = text.split('\n');
  return {
    width: Math.max(fontSize, ...lines.map(line => line.length * fontSize * 0.62)),
    height: Math.max(fontSize, lines.length * fontSize),
  };
}

/**
 * Maximum distance-driven scale that keeps the complete visible label bounds
 * (including outline) within both axes of the equipment footprint.
 */
export function equipmentLabelMaxScale(
  eq: Pick<PlacedEquipment, 'kind' | 'length' | 'width'>,
  bounds: EquipmentLabelBounds = {
    width: equipmentLabelFontSize(eq),
    height: equipmentLabelFontSize(eq),
  },
): number {
  const visibleWidth = Math.max(1e-6, bounds.width + 2 * EQUIPMENT_LABEL_OUTLINE_FT);
  const visibleHeight = Math.max(1e-6, bounds.height + 2 * EQUIPMENT_LABEL_OUTLINE_FT);
  return Math.min(
    EQUIPMENT_LABEL_MAX_DISTANCE_SCALE,
    eq.length / visibleWidth,
    eq.width / visibleHeight,
  );
}

type LabelFacingEquipment =
  Pick<PlacedEquipment, 'kind' | 'rotation'> &
  Partial<Pick<PlacedEquipment, 'id' | 'label' | 'x' | 'y' | 'length' | 'width'>>;

function pointToEquipmentDistance(p: Pt, eq: PlacedEquipment): number {
  const dx = p.x - eq.x, dy = p.y - eq.y;
  const c = Math.cos(eq.rotation), s = Math.sin(eq.rotation);
  const lx = dx * c + dy * s;
  const ly = -dx * s + dy * c;
  const ox = Math.max(0, Math.abs(lx) - eq.length / 2);
  const oy = Math.max(0, Math.abs(ly) - eq.width / 2);
  return Math.hypot(ox, oy);
}

function cableOwnedBess(
  eq: LabelFacingEquipment,
  built: readonly PlacedEquipment[],
  cables?: readonly CableRun[],
): PlacedEquipment[] {
  if (!cables?.length) return [];
  const found = new Map<string, PlacedEquipment>();
  for (const run of cables) {
    if (run.class !== 'DC' || run.ref || run.pts.length < 2) continue;
    const ends = [run.pts[0], run.pts[run.pts.length - 1]];
    const d0 = pointToEquipmentDistance(ends[0], eq as PlacedEquipment);
    const d1 = pointToEquipmentDistance(ends[1], eq as PlacedEquipment);
    const pcsEnd = d0 <= d1 ? 0 : 1;
    if (Math.min(d0, d1) > 4) continue;
    const other = ends[1 - pcsEnd];
    let nearest: PlacedEquipment | null = null;
    let best = Infinity;
    for (const item of built) {
      const d = pointToEquipmentDistance(other, item);
      if (d < best) { best = d; nearest = item; }
    }
    if (nearest && best <= 4) found.set(nearest.id, nearest);
  }
  return Array.from(found.values());
}

function connectedBessCentroid(
  eq: LabelFacingEquipment,
  equipment?: readonly PlacedEquipment[],
  cables?: readonly CableRun[],
): { x: number; y: number } | null {
  if (eq.kind !== 'inverter' || !equipment?.length ||
      !Number.isFinite(eq.x) || !Number.isFinite(eq.y)) return null;

  const built = equipment.filter(item =>
    item.kind === 'bess' && !item.augmented && !item.future);
  if (!built.length) return null;

  let owned: PlacedEquipment[] = [];
  const ref = eq.label?.match(/^PCS(\d{2})-(\d{2})$/);
  if (ref) {
    const prefix = `CON${ref[1]}${ref[2]}-A-`;
    owned = built.filter(item => item.label?.startsWith(prefix));
  }
  if (!owned.length) {
    const block = eq.id?.match(/^inv-(\d+)$/)?.[1];
    if (block) owned = built.filter(item => item.id.startsWith(`bess-${block}-`));
  }
  if (!owned.length) owned = cableOwnedBess(eq, built, cables);
  if (!owned.length) {
    // Before traced labels/cables have been applied, use a deterministic
    // service-bank score in the PCS's local frame. This favors containers
    // across the PCS short axis over an unrelated island along its long axis.
    const c = Math.cos(eq.rotation), s = Math.sin(eq.rotation);
    let nearest = built[0];
    let best = Infinity;
    for (const item of built) {
      const dx = item.x - eq.x!, dy = item.y - eq.y!;
      const along = Math.abs(dx * c + dy * s);
      const across = Math.abs(-dx * s + dy * c);
      const axialGap = Math.max(
        0,
        along - ((eq.length ?? 0) + item.length) / 2,
      );
      const score = across + 2 * axialGap;
      if (score < best) { best = score; nearest = item; }
    }
    owned = [nearest];
  }

  return {
    x: owned.reduce((sum, item) => sum + item.x, 0) / owned.length,
    y: owned.reduce((sum, item) => sum + item.y, 0) / owned.length,
  };
}

/**
 * Labels on long rectangular units follow the exact equipment long axis.
 * BESS/conex text stays sheet-upright. PCS text retains the half-turn that
 * makes the bottom/read-from edge face the containers served by that PCS.
 */
export function equipmentLabelRotation(
  eq: LabelFacingEquipment,
  equipment?: readonly PlacedEquipment[],
  cables?: readonly CableRun[],
): number {
  if (!LONG_AXIS_LABEL_KINDS.has(eq.kind)) return 0;
  const axis = Math.atan2(Math.sin(2 * eq.rotation), Math.cos(2 * eq.rotation)) / 2;
  const target = connectedBessCentroid(eq, equipment, cables);
  if (!target) return axis;

  // At angle r the glyph bottom/read-from edge points (sin r, -cos r).
  // Select r or r+PI so that edge points toward the connected BESS centroid.
  const towardX = target.x - eq.x!;
  const towardY = target.y - eq.y!;
  const facesTarget = Math.sin(axis) * towardX - Math.cos(axis) * towardY >= 0;
  const facing = facesTarget ? axis : axis + Math.PI;
  return Math.atan2(Math.sin(facing), Math.cos(facing));
}