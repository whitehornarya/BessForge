// Single source of truth for per-feeder colors and the feeder legend rows.
// Every renderer (3D/2D scene, PDF plot, DXF export) derives its feeder
// color from this module so hues always match across the four outputs.
//
// The palette is a curated 10-hue, colorblind-considerate cycle (adapted
// from the Okabe-Ito / Tol qualitative sets): deterministic (feeder N always
// gets the same color, wrapping past the palette length), distinct on both
// the dark 3D ground and white paper. Each entry carries:
//   hex  - screen color for the 3D/2D scene and HTML legend (brighter)
//   rgb  - paper color for the PDF plot (darkened for white background)
//   aci  - AutoCAD Color Index used for the DXF entity color override
// ACI codes are unique within the palette and never collide with the codes
// the base layer table uses for semantic layers (checked by the tests).

import { FeederCircuit } from './feeders';
import { feederDisplayName } from './feederNaming';
import { PlacedEquipment } from './types';

export interface FeederColor {
  hex: string;                     // screen (3D/2D/HTML legend)
  rgb: [number, number, number];   // paper (PDF)
  aci: number;                     // DXF entity color override
}

export const FEEDER_PALETTE: readonly FeederColor[] = [
  { hex: '#ff5252', rgb: [204, 0, 0], aci: 1 },     // red
  { hex: '#ffa040', rgb: [214, 117, 0], aci: 30 },  // orange
  { hex: '#37d67a', rgb: [0, 140, 0], aci: 3 },     // green
  { hex: '#5c8dff', rgb: [0, 0, 200], aci: 5 },     // blue
  { hex: '#e91e63', rgb: [190, 0, 190], aci: 6 },   // magenta
  { hex: '#26c6da', rgb: [0, 130, 150], aci: 4 },   // teal
  { hex: '#b47aff', rgb: [130, 60, 180], aci: 200 },// purple
  { hex: '#e6c229', rgb: [158, 128, 0], aci: 40 },  // gold
  { hex: '#7dd3fc', rgb: [0, 96, 168], aci: 140 },  // sky / steel blue
  { hex: '#c98a4b', rgb: [140, 82, 26], aci: 34 },  // brown / tan
] as const;

// Deterministic feeder color: feeder idx (1-based) -> palette entry,
// wrapping past the palette length.
export function feederColor(idx: number): FeederColor {
  const n = FEEDER_PALETTE.length;
  const i = ((Math.round(idx) - 1) % n + n) % n;
  return FEEDER_PALETTE[i];
}

// Substation aux feeder (34.5 kV daisy chain through the aux transformers,
// reference CAR-D-B005-0): fixed BROWN across every output — the reference
// legend draws it as a brown dashed line, distinct from the BESS feeder
// palette. Deep brown so it never reads as palette entry 10 (tan).
export const AUX_FEEDER_COLOR: FeederColor = { hex: '#8d5524', rgb: [110, 62, 20], aci: 36 };

// One legend row per feeder: swatch color, F-label, PCS count and BESS
// container count. BESS containers belong to a PCS via the block-id
// convention: inverter `inv-<n>` owns containers `bess-<n>-*`.
export interface FeederLegendRow {
  idx: number;        // 1-based feeder number
  label: string;      // 'F1'..'Fn'
  color: FeederColor;
  pcsCount: number;   // BOL built PCS
  bessCount: number;  // BOL battery containers
  // End-of-life state (register F-02): built + reserved augmentation blocks
  // electrically tied to this feeder. Equal to BOL when nothing is reserved.
  eolPcsCount: number;
  eolBessCount: number;
}

export function bessCountForInverters(
  inverterIds: string[],
  equipment: PlacedEquipment[]
): number {
  const blockNs = new Set(
    inverterIds
      .map(id => /^inv-(\d+)$/.exec(id)?.[1])
      .filter((n): n is string => n !== undefined)
  );
  let count = 0;
  const inFeeder = new Set(inverterIds);
  // Traced/placed containers carry no auto block id — ownership is geometric:
  // each belongs to the NEAREST BUILT PCS (same rule the CON labels use), and
  // it counts here when that owner is on this feeder. Auto containers keep the
  // exact id match so mixed layouts never double-count. Two guards keep the
  // legend physically honest under the QTY3 standard:
  //  - augmentation/future containers and PCS NEVER join a feeder's count
  //    (they are reserve, not built equipment on the circuit; the flag check
  //    is the authority — nearest-owner geometry alone would count an
  //    aug/future container that happens to sit closest to a built PCS), and
  //  - a PCS owns at most 3 containers (QTY3), so a dense traced yard can
  //    never report an impossible figure like 7 PCS / 27 BESS.
  let allInverters: PlacedEquipment[] | null = null;
  const ownedPerPcs = new Map<string, number>();
  for (const e of equipment) {
    if (e.kind !== 'bess') continue;
    if (e.augmented || e.future) continue;
    const m = /^bess-(\d+)-/.exec(e.id);
    if (m) {
      if (blockNs.has(m[1])) count++;
      continue;
    }
    if (allInverters === null) {
      // Owner candidates are BUILT PCS only, so a built container that sits
      // nearest an augmentation/future PCS still lands on its real (built)
      // feeder instead of silently dropping off every legend row.
      allInverters = equipment.filter(
        q => q.kind === 'inverter' && !q.augmented && !q.future);
    }
    let owner: PlacedEquipment | null = null;
    let bd = Infinity;
    for (const i of allInverters) {
      const d = Math.hypot(i.x - e.x, i.y - e.y);
      if (d < bd) { bd = d; owner = i; }
    }
    if (owner && inFeeder.has(owner.id)) {
      const owned = ownedPerPcs.get(owner.id) ?? 0;
      if (owned < 3) { ownedPerPcs.set(owner.id, owned + 1); count++; }
    }
  }
  return count;
}

export function feederLegendRows(
  feeders: FeederCircuit[],
  equipment: PlacedEquipment[]
): FeederLegendRow[] {
  return feeders.map(f => {
    const pcsCount = f.inverterIds.length;
    const bessCount = bessCountForInverters(f.inverterIds, equipment);
    // Future blocks carry the same containers-per-PCS ratio as the built
    // fleet on this feeder (falls back to 3 for empty synthetic fixtures).
    const perPcs = pcsCount > 0 ? Math.round(bessCount / pcsCount) : 3;
    const futurePcs = Math.max(0, f.futurePcs || 0);
    return {
      idx: f.idx,
      // Breaker-position name ('14A1'; legacy F<idx> for unnamed saved
      // circuits). Display surfaces prepend '#' — the DXF legend template
      // already does.
      label: feederDisplayName(f),
      color: feederColor(f.idx),
      pcsCount,
      bessCount,
      eolPcsCount: pcsCount + futurePcs,
      eolBessCount: bessCount + futurePcs * perPcs,
    };
  });
}

// Inverter id -> screen hex of its feeder's color, for the PCS tint
// shader. Unassigned PCS (not on any feeder) are absent from the map.
export function feederTintByInverterId(feeders: FeederCircuit[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const f of feeders) {
    const hex = feederColor(f.idx).hex;
    for (const id of f.inverterIds) map.set(id, hex);
  }
  return map;
}
