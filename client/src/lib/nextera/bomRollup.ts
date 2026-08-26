// Priced-quantity BOM rollup: consumes the cable-schedule rows EXACTLY
// (same slack + lengths — no independent recomputation) and groups them
// into estimator-ready quantities: conductor LF by class/size, termination
// counts, conduit sticks, and civil quantities.
import { SiteDesign } from './types';
import { BessConfiguration } from './catalog';
import { FeederCircuit } from './feeders';
import { ScheduleRow } from './cableSchedule';
import { BomRow, buildBomRows, bomToCsv } from './bom';
import { GroundingPlan } from './grounding';
import { summarizeCableLengths } from './cableRouting';
import { roadRegionAreaSqFt } from './scenarios';
import { buildPartsBomLines, designCounts } from './bomCatalog';

export const CONDUIT_STICK_FT = 20;      // standard Sch 40 PVC stick length
export const CONDUIT_WASTE_PCT = 5;      // cut/waste factor on conduit runs

export interface RollupLine {
  qty: number;
  unit: 'EA' | 'LF' | 'TON' | 'SF';
  description: string;
}

export interface BomRollup {
  cable: RollupLine[];        // conductor LF by class + make-up (slack included)
  terminations: RollupLine[]; // 2 per run + FJB pass-through splice pairs
  conduit: RollupLine[];      // sticks by trade size (raw route LF + waste)
  civil: RollupLine[];        // trench LF, road area, surfacing
  grounding: RollupLine[];    // from the grounding screening plan (empty when off)
}

const ceil = Math.ceil;

export function buildBomRollup(
  rows: ScheduleRow[],
  design: SiteDesign,
  feeders: FeederCircuit[],
  groundingPlan?: GroundingPlan | null
): BomRollup {
  // --- Cable LF by class + conductor make-up (total = with slack) ---------
  const cableMap = new Map<string, { cls: string; conductor: string; lf: number; runs: number }>();
  for (const r of rows) {
    const key = `${r.cableClass}|${r.conductor}`;
    const cur = cableMap.get(key) || { cls: r.cableClass, conductor: r.conductor, lf: 0, runs: 0 };
    cur.lf += r.totalLengthFt;
    cur.runs += 1;
    cableMap.set(key, cur);
  }
  const cable: RollupLine[] = Array.from(cableMap.values()).map(g => ({
    qty: ceil(g.lf),
    unit: 'LF',
    description: `${g.cls} CABLE ${g.conductor} (${g.runs} RUNS, INCL ${rows[0]?.slackPct ?? 0}% SLACK)`,
  }));

  // --- Terminations: 2 per run; feeders through an FJB add a splice pair --
  const termMap = new Map<string, number>();
  for (const r of rows) {
    termMap.set(r.cableClass, (termMap.get(r.cableClass) || 0) + 2);
  }
  const fjbFeeders = feeders.filter(f => f.fjbId).length;
  if (fjbFeeders) termMap.set('MV', (termMap.get('MV') || 0) + 2 * fjbFeeders);
  const TERM_LABEL: Record<string, string> = {
    DC: 'DC CABLE TERMINATIONS (2 PER RUN)',
    MV: fjbFeeders
      ? 'MV CABLE TERMINATIONS (2 PER RUN + 2 PER FJB PASS-THROUGH)'
      : 'MV CABLE TERMINATIONS (2 PER RUN)',
    LVAC: 'LVAC CABLE TERMINATIONS (2 PER RUN)',
    AUXPWR: 'AUX POWER (LV) TERMINATIONS (2 PER RUN)',
    FIBER: 'FIBER SPLICE/PATCH TERMINATIONS (2 PER RUN)',
    FIBER_TRUNK: 'FIBER TRUNK SPLICE/PATCH TERMINATIONS (2 PER RUN)',
    CATL: 'CATL FIBER SPLICE TERMINATIONS (2 PER RUN)',
  };
  const terminations: RollupLine[] = (['DC', 'MV', 'LVAC', 'AUXPWR', 'FIBER', 'FIBER_TRUNK', 'CATL'] as const)
    .filter(c => termMap.has(c))
    .map(c => ({ qty: termMap.get(c)!, unit: 'EA', description: TERM_LABEL[c] }));

  // --- Conduit sticks by trade size (conduit follows raw route length) ----
  const conduitMap = new Map<string, number>();
  for (const r of rows) {
    conduitMap.set(r.conduit, (conduitMap.get(r.conduit) || 0) + r.rawLengthFt);
  }
  const conduit: RollupLine[] = Array.from(conduitMap.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([trade, lf]) => ({
      qty: ceil((lf * (1 + CONDUIT_WASTE_PCT / 100)) / CONDUIT_STICK_FT),
      unit: 'EA',
      description: `${trade} SCH 40 PVC CONDUIT STICK (${CONDUIT_STICK_FT} FT, ${ceil(lf)} LF RUN + ${CONDUIT_WASTE_PCT}% WASTE)`,
    }));

  // --- Civil quantities ----------------------------------------------------
  const civil: RollupLine[] = [];
  const trenchLf = summarizeCableLengths(
    design.cables, design.trench, design.corridorTrenches,
  ).trench;
  if (trenchLf > 0) {
    civil.push({ qty: ceil(trenchLf), unit: 'LF', description: '480V AUX & FIBER TRENCH (T-1)' });
  }
  const roadSf = roadRegionAreaSqFt(design);
  if (roadSf > 0) {
    civil.push({ qty: ceil(roadSf), unit: 'SF', description: `DRIVE PATH SURFACE (${(roadSf / 43560).toFixed(2)} AC)` });
  }
  if (design.surfacing && design.surfacing.areaSqFt > 0) {
    const sp = design.surfacing;
    civil.push({
      qty: ceil(sp.tons),
      unit: 'TON',
      description: `CRUSHED ROCK SURFACING, ${sp.depthIn}" DEPTH (${(sp.areaSqFt / 43560).toFixed(2)} AC)`,
    });
  }

  // --- Grounding (screening plan quantities — never recomputed here) ------
  const grounding: RollupLine[] = [];
  if (groundingPlan) {
    const g = groundingPlan.summary;
    grounding.push({
      qty: ceil(g.totalConductorFt),
      unit: 'LF',
      description: `BARE COPPER GROUND CONDUCTOR (LOOP ${ceil(g.loopLengthFt)} LF + GRID ${ceil(g.gridLengthFt)} LF + TAPS ${ceil(g.tapLengthFt)} LF)`,
    });
    grounding.push({
      qty: g.rodCount,
      unit: 'EA',
      description: `GROUND RODS (${g.rodSpacingFt} FT SPACING ON PERIMETER LOOP)`,
    });
    grounding.push({
      qty: g.rodCount + g.tapCount + g.crossingCount,
      unit: 'EA',
      description: `EXOTHERMIC CONNECTIONS (1 PER ROD + 1 PER EQUIPMENT TAP + 1 PER GRID CROSSING, ${g.tapCount} TAPS, ${g.crossingCount} CROSSINGS)`,
    });
  }

  return { cable, terminations, conduit, civil, grounding };
}

// ---------------------------------------------------------------------------
// Full BOM CSV: existing equipment BOM + the rollup sections, one file.
// ---------------------------------------------------------------------------

function csvEscape(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export function fullBomToCsv(
  design: SiteDesign,
  config: BessConfiguration | undefined,
  feeders: FeederCircuit[],
  rollup: BomRollup,
  grounding?: GroundingPlan | null
): string {
  const lines: string[] = ['SECTION,QTY,UNIT,DESCRIPTION'];
  const add = (section: string, rowsIn: { qty: number | string; unit: string; description: string }[]) => {
    for (const r of rowsIn) {
      lines.push(`${section},${r.qty},${r.unit},${csvEscape(r.description)}`);
    }
  };
  add('MAJOR EQUIPMENT', buildBomRows(design, config, feeders));
  add('CABLE', rollup.cable);
  add('TERMINATIONS', rollup.terminations);
  add('CONDUIT', rollup.conduit);
  add('CIVIL', rollup.civil);
  if (rollup.grounding.length) add('GROUNDING', rollup.grounding);
  // Real part numbers transcribed from the 90% package (CAR-D-B018-1/2),
  // quantities scaled to this design (same builder feeds the BOM sheet).
  add('PARTS (90% PKG)', buildPartsBomLines(designCounts(design.equipment, design.islands)));
  return lines.join('\r\n') + '\r\n';
}

export { bomToCsv };
