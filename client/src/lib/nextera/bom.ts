// Shared bill-of-materials row construction, used by both the DXF sheet
// panel and the CSV export so they always stay in sync.
import { SiteDesign } from './types';
import { BessConfiguration, AUX_SWITCHBOARD_SPEC, specForKind } from './catalog';
import { summarizeCableLengths } from './cableRouting';
import { FeederCircuit } from './feeders';
import { feederDisplayName } from './feederNaming';
import { buildCableScheduleRows, DEFAULT_SLACK_PCT, ScheduleRow } from './cableSchedule';
import { GroundingPlan } from './grounding';

export interface BomRow {
  qty: number;
  unit: 'EA' | 'LF' | 'TON';
  description: string;
}

// Grounding screening lines (opt-in). Quantities come VERBATIM from the
// GroundingPlan summary the panel card / DXF layer / permit packet use —
// nothing is recomputed here, so every surface agrees.
export function buildGroundingBomRows(plan: GroundingPlan): BomRow[] {
  const s = plan.summary;
  return [
    {
      qty: Math.ceil(s.totalConductorFt),
      unit: 'LF',
      description: `BARE COPPER GROUND CONDUCTOR (LOOP ${Math.ceil(s.loopLengthFt)} LF + GRID ${Math.ceil(s.gridLengthFt)} LF + ${s.tapCount} TAPS ${Math.ceil(s.tapLengthFt)} LF)`,
    },
    {
      qty: s.rodCount,
      unit: 'EA',
      description: `GROUND ROD (${s.rodSpacingFt}' SPACING + CORNERS/GATE)`,
    },
  ];
}

export function buildBomRows(design: SiteDesign, config?: BessConfiguration, feeders?: FeederCircuit[], grounding?: GroundingPlan | null): BomRow[] {
  // Future/augmentation units (KMZ-traced yards keep them in
  // design.equipment with augmented/future flags) are not procurement
  // scope: the BOM quantifies the BUILT yard only, like every capacity
  // rollup. Auto layouts never flag design.equipment, so they're untouched.
  const count = (kind: string) =>
    design.equipment.filter(e => e.kind === kind && !e.augmented && !e.future).length;
  // Real procurement part numbers from the 90% package BOM (CAR-D-B018-1):
  // LG JF2 containers = LG EPNLTF_1200A/C; PE PCS = FP4200M1.
  const pePcs = config?.inverterModel?.toUpperCase().includes('FP4200M');
  // PCS rating comes from the catalog spec record so the BOM carries the
  // NAMEPLATE apparent power (register F-04), not just the site-usable MW.
  const pcsSpec = specForKind('inverter', config);
  const rows: BomRow[] = [
    { qty: count('bess'), unit: 'EA', description: 'LG JF2 DCLINK 5.1 CONTAINER (LG P/N EPNLTF_1200A/C, 5.1 MWH EA)' },
    {
      qty: count('inverter'),
      unit: 'EA',
      description: `${config ? config.inverterModel : ''}${config ? ' ' : ''}PCS UNIT${config && pcsSpec ? ` (${pcsSpec.rating}${pePcs ? ', PE P/N FP4200M1' : ''})` : ''}`,
    },
  ];
  const nAuxX = count('auxTransformer');
  const nAuxS = count('auxSwitchgear');
  if (nAuxX) rows.push({ qty: nAuxX, unit: 'EA', description: 'AUX TRANSFORMER, PADMOUNT 34.5KV-480V 1.5MVA Z=5.75% (HITACHI)' });
  // Single-sourced from AUX_SWITCHBOARD_SPEC (register F-06) — never a
  // second hardcoded manufacturer string.
  if (nAuxS) rows.push({
    qty: nAuxS, unit: 'EA',
    description: `${AUX_SWITCHBOARD_SPEC.item}, ${AUX_SWITCHBOARD_SPEC.rating} (${AUX_SWITCHBOARD_SPEC.manufacturer} ${AUX_SWITCHBOARD_SPEC.model})`,
  });
  const nAuxP = count('auxSwitchPanel');
  const nFpp = count('fiberPatchPanel');
  const nFcp = count('fireControlPanel');
  if (nAuxP) rows.push({ qty: nAuxP, unit: 'EA', description: 'AUXILIARY SWITCH PANEL' });
  if (nFpp) rows.push({ qty: nFpp, unit: 'EA', description: 'FIBER PATCH PANEL' });
  if (nFcp) rows.push({ qty: nFcp, unit: 'EA', description: 'FIRE CONTROL PANEL' });
  const nFjb = count('feederJunctionBox');
  const nComms = count('commsCabinet');
  if (nFjb) rows.push({ qty: nFjb, unit: 'EA', description: 'FEEDER JUNCTION BOX' });
  if (nComms) rows.push({ qty: nComms, unit: 'EA', description: 'COMMUNICATIONS CABINET' });
  if (design.gate) {
    rows.push({ qty: 1, unit: 'EA', description: `SITE ACCESS GATE (${design.gate.width.toFixed(0)}' WIDE)` });
  }
  if (design.surfacing && design.surfacing.areaSqFt > 0) {
    const sp = design.surfacing;
    rows.push({
      qty: Math.ceil(sp.tons),
      unit: 'TON',
      description: `CRUSHED ROCK SURFACING, ${sp.depthIn}" DEPTH (${(sp.areaSqFt / 43560).toFixed(2)} AC)`,
    });
  }
  // Cable LF rows are the SUM OF THE PER-RUN CABLE SCHEDULE LENGTHS
  // (routed centerline + DEFAULT_SLACK_PCT slack, register B3/F-07) — the
  // BOM never recomputes lengths on a different basis than the schedule,
  // so the two documents always reconcile exactly.
  const schedRows: ScheduleRow[] = buildCableScheduleRows(design, feeders ?? []);
  const yardRows = schedRows.filter(r => !r.circuitId.startsWith('FDR-'));
  const byClass = (cls: string) => yardRows.filter(r => r.cableClass === cls);
  const cableRow = (cls: string, label: string): BomRow | null => {
    const rs = byClass(cls);
    if (!rs.length) return null;
    // Procurement rounding rule: ceil EACH schedule run to whole LF, then
    // sum — so the BOM quantity equals the sum of the schedule's displayed
    // per-run quantities exactly.
    const total = rs.reduce((s, r) => s + Math.ceil(r.totalLengthFt), 0);
    const longest = Math.max(...rs.map(r => r.totalLengthFt));
    return {
      qty: total,
      unit: 'LF',
      description: `${label} (${rs.length} RUNS, LONGEST ${Math.ceil(longest)} LF, INCL ${DEFAULT_SLACK_PCT}% SLACK)`,
    };
  };
  for (const [cls, label] of [
    ['DC', 'DC CABLE'], ['MV', 'MV CABLE'],
    ['LVAC', 'LVAC (480V) CABLE'], ['AUXPWR', 'AUX POWER (LV) CABLE'],
    ['FIBER', 'FIBER OPTIC CABLE'], ['FIBER_TRUNK', 'FIBER TRUNK (144 CT)'],
    ['CATL', 'CATL FIBER RING (6 CT)'],
  ] as const) {
    const r = cableRow(cls, label);
    if (r) rows.push(r);
  }
  // Trench footage is civil scope, not cable — keep the routed basis.
  const cl = summarizeCableLengths(design.cables, design.trench, design.corridorTrenches);
  if (cl.trench > 0) rows.push({ qty: Math.ceil(cl.trench), unit: 'LF', description: '480V AUX & FIBER TRENCH' });
  if (feeders && feeders.length) {
    // Group MV feeder schedule rows by conductor pick (size/material/sets).
    const fdrRows = schedRows.filter(r => r.circuitId.startsWith('FDR-'));
    const groups = new Map<string, { totalFt: number; circuits: number; desc: string }>();
    for (const f of feeders) {
      const sr = fdrRows.find(r => r.circuitId === `FDR-${feederDisplayName(f)}`);
      if (!sr) continue;
      const sets = Math.max(1, f.parallelSets || 1);
      const key = `${f.size}|${f.material}|${sets}`;
      const g = groups.get(key) ?? {
        totalFt: 0, circuits: 0,
        desc: `MV FEEDER CABLE ${sets > 1 ? `${sets}X` : ''}${f.size} KCMIL ${f.material.toUpperCase()}`,
      };
      g.totalFt += Math.ceil(sr.totalLengthFt); // per-run ceil, same rule as yard rows
      g.circuits += 1;
      groups.set(key, g);
    }
    for (const g of Array.from(groups.values())) {
      rows.push({
        qty: g.totalFt,
        unit: 'LF',
        description: `${g.desc} (${g.circuits} CIRCUIT${g.circuits > 1 ? 'S' : ''}, INCL ${DEFAULT_SLACK_PCT}% SLACK)`,
      });
    }
    rows.push({ qty: 1, unit: 'EA', description: 'SUBSTATION (POINT OF INTERCONNECTION, BY OTHERS)' });
  }
  if (grounding) rows.push(...buildGroundingBomRows(grounding));
  return rows;
}

// Sheet-panel text form, e.g. "12  DC CABLE RUN" / "340 LF  MV CABLE RUN".
export function formatBomRowText(row: BomRow): string {
  return row.unit === 'EA' ? `${row.qty}  ${row.description}` : `${row.qty} ${row.unit}  ${row.description}`;
}

function csvEscape(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export function bomToCsv(rows: BomRow[]): string {
  const lines = ['QTY,UNIT,DESCRIPTION'];
  for (const r of rows) lines.push(`${r.qty},${r.unit},${csvEscape(r.description)}`);
  return lines.join('\r\n') + '\r\n';
}

// ---------------------------------------------------------------------------
// Whole-site BOM: every area's rows, plus a combined site total.
//
// Quantities are summed, never recomputed, so the site total always reconciles
// with the per-area rows exactly.
//
// Merge key depends on what the trailing parenthetical means:
//
//  - A note stating a per-area QUANTITY ("12 RUNS", "3 CIRCUITS", "1.23 AC")
//    stops being true once quantities are summed, and it differs area to area.
//    Those rows key on the description BEFORE the note, so the same material
//    combines across areas, and the note is then restated as the number of
//    areas combined rather than left as a false claim about the site total.
//  - Any other note is a SPEC ("SITE ACCESS GATE (24' WIDE)") that stays true
//    after summing. Those rows key on the exact description, so two different
//    specs can never collapse onto one row.

export interface SiteBomArea {
  name: string;
  rows: BomRow[];
}

export interface SiteBom {
  perArea: SiteBomArea[];
  site: BomRow[];
}

// A trailing parenthetical that states a per-area quantity ("12 RUNS",
// "3 CIRCUITS", "1.23 AC") stops being true once quantities are summed.
// A pure spec note ("24' WIDE") stays true, so it is left alone.
const STALE_WHEN_SUMMED = /\d[\d,.]*\s*(RUNS?|CIRCUITS?|AC)\b/i;

export function buildSiteBom(areas: SiteBomArea[]): SiteBom {
  const merged = new Map<
    string,
    { qty: number; unit: BomRow['unit']; description: string; base: string; stale: boolean; areas: Set<string> }
  >();
  for (const a of areas) {
    for (const r of a.rows) {
      const paren = /^(.*?)\s*\(([^()]*)\)\s*$/.exec(r.description);
      const stale = !!paren && STALE_WHEN_SUMMED.test(paren[2]);
      const key = stale ? `${r.unit}|${paren![1]}` : `${r.unit}|${r.description}`;
      const cur = merged.get(key);
      if (!cur) {
        merged.set(key, {
          qty: r.qty, unit: r.unit, description: r.description,
          base: stale ? paren![1] : r.description,
          stale, areas: new Set([a.name]),
        });
      } else {
        cur.qty += r.qty;
        cur.areas.add(a.name);
        cur.stale = cur.stale || stale;
      }
    }
  }
  const site: BomRow[] = Array.from(merged.values()).map(m => ({
    qty: m.qty,
    unit: m.unit,
    // One area contributed: its own note still describes the quantity exactly.
    description: m.stale && m.areas.size > 1
      ? `${m.base} (${m.areas.size} AREAS COMBINED)`
      : m.description,
  }));
  return { perArea: areas, site };
}

// CSV with an AREA column: one section per area, then the WHOLE SITE total.
export function siteBomToCsv(bom: SiteBom): string {
  const lines = ['AREA,QTY,UNIT,DESCRIPTION'];
  for (const a of bom.perArea) {
    for (const r of a.rows) {
      lines.push(`${csvEscape(a.name)},${r.qty},${r.unit},${csvEscape(r.description)}`);
    }
  }
  for (const r of bom.site) {
    lines.push(`${csvEscape('WHOLE SITE')},${r.qty},${r.unit},${csvEscape(r.description)}`);
  }
  return lines.join('\r\n') + '\r\n';
}
