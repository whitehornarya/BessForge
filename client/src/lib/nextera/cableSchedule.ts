// Cable & conduit schedule: one row per routed circuit (yard cable runs +
// MV feeder circuits) with deterministic circuit IDs, from/to endpoints,
// conductor make-up, routed length + slack, NEC Chapter 9 conduit sizing
// with fill %, and a trench section reference.
//
// STANDALONE export (like the SLD sheet): the DXF table sheet is NOT
// registered in the drawing-package SHEET_REGISTRY, so every existing
// DXF/PDF export stays byte-identical.
import { SiteDesign, CableRun, PlacedEquipment, CableClass } from './types';
import {
  BessConfiguration,
  CableSpec,
  DC_CABLE_SPEC,
  LVAC_CABLE_SPEC,
  AUXPWR_CABLE_SPEC,
  FIBER_CABLE_SPEC,
  FIBER_TRUNK_CABLE_SPEC,
  CATL_CABLE_SPEC,
  MV_CONDUCTOR_OD_IN,
  CONDUIT_SCH40_ID_IN,
  necMaxFill,
} from './catalog';
import { FeederCircuit } from './feeders';
import { feederDisplayName, auxDisplayName } from './feederNaming';
import {
  DxfWriter,
  LAYERS,
  TitleBlockMeta,
  addBaseLayers,
  addSheetFrame,
  nexteraLabel,
  CHAR_W,
} from './dxfExport';

import { DEFAULT_SLACK_PCT } from './catalog';
export { DEFAULT_SLACK_PCT };

// Yard MV runs (row buses / drops / spine) are collection-voltage cable at
// the smallest catalog feeder size; feeder rows carry their sized conductor.
const YARD_MV_SPEC: CableSpec = {
  description: '(3) 500 KCMIL AL, 35 KV',
  odIn: MV_CONDUCTOR_OD_IN['500'],
  conductors: 3,
};

export interface ScheduleRow {
  circuitId: string;    // deterministic ID consistent with plan labels
  from: string;
  to: string;
  cableClass: CableClass;
  conductor: string;    // conductor make-up text, e.g. "(3) 500 KCMIL AL, 35 KV"
  conductors: number;   // conductors per conduit
  odIn: number;         // single-conductor OD (inches)
  rawLengthFt: number;  // routed geometry length
  slackPct: number;
  totalLengthFt: number; // raw * (1 + slack)
  conduit: string;      // Sch 40 PVC trade size, e.g. '4"'
  fillPct: number;      // conductor area / conduit internal area * 100
  trenchRef: string;    // trench / duct section reference
}

export interface CableScheduleOptions {
  slackPct?: number; // default DEFAULT_SLACK_PCT
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export function polylineLengthFt(pts: { x: number; y: number }[]): number {
  let len = 0;
  for (let i = 1; i < pts.length; i++) {
    len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  }
  return len;
}

// Smallest Sch 40 PVC conduit meeting the NEC Chapter 9 Table 1 fill limit
// for the given conductor group; falls back to the largest trade size.
export function sizeConduit(odIn: number, conductors: number): { trade: string; fillPct: number } {
  const condArea = conductors * Math.PI * (odIn / 2) ** 2;
  const limit = necMaxFill(conductors);
  for (const c of CONDUIT_SCH40_ID_IN) {
    const area = Math.PI * (c.idIn / 2) ** 2;
    const fill = condArea / area;
    if (fill <= limit) return { trade: c.trade, fillPct: round1(fill * 100) };
  }
  const last = CONDUIT_SCH40_ID_IN[CONDUIT_SCH40_ID_IN.length - 1];
  const area = Math.PI * (last.idIn / 2) ** 2;
  return { trade: last.trade, fillPct: round1((condArea / area) * 100) };
}

function specForClass(cls: CableClass): CableSpec {
  switch (cls) {
    case 'DC': return DC_CABLE_SPEC;
    case 'MV': return YARD_MV_SPEC;
    case 'LVAC': return LVAC_CABLE_SPEC;
    case 'AUXPWR': return AUXPWR_CABLE_SPEC;
    case 'FIBER': return FIBER_CABLE_SPEC;
    case 'FIBER_TRUNK': return FIBER_TRUNK_CABLE_SPEC;
    case 'CATL': return CATL_CABLE_SPEC;
  }
}

// From/to endpoint text per the deterministic run-ID conventions in
// cableRouting.ts (dc-/lvac-<container>, *-bus-N, *-drop-<inv>, spines/ties).
function endpointsForRun(
  run: CableRun,
  byId: Map<string, PlacedEquipment>,
  design: SiteDesign
): { from: string; to: string; trenchRef: string } {
  const id = run.id;
  const label = (eqId: string) => {
    const eq = byId.get(eqId);
    return eq ? nexteraLabel(eq) : eqId.toUpperCase();
  };
  const pcsForContainer = (cid: string) => {
    // bess-<n>-<i> pairs with inv-<n>
    const m = cid.match(/^bess-(\d+)-/);
    return m ? label(`inv-${m[1]}`) : 'PCS';
  };
  const auxS = design.equipment.find(e => e.kind === 'auxSwitchgear');
  const auxX = design.equipment.find(e => e.kind === 'auxTransformer');
  const trench = design.trench ? 'T-1' : '-';

  let m: RegExpMatchArray | null;
  if ((m = id.match(/^dc-(bess-.+)$/))) {
    return { from: label(m[1]), to: pcsForContainer(m[1]), trenchRef: 'BLK' };
  }
  if ((m = id.match(/^lvac-(bess-.+)$/))) {
    return { from: label(m[1]), to: 'LVAC ROW BUS', trenchRef: 'BLK' };
  }
  if ((m = id.match(/^(mv|lvac|fiber)-bus-(\d+)$/))) {
    const cls = m[1].toUpperCase();
    return { from: `${cls} ROW BUS ${m[2]}`, to: `${cls} SPINE`, trenchRef: `R-${m[2]}` };
  }
  if ((m = id.match(/^(mv|lvac|fiber)-drop-(inv-\d+)$/))) {
    return { from: label(m[2]), to: `${m[1].toUpperCase()} ROW BUS`, trenchRef: 'BLK' };
  }
  if ((m = id.match(/^lvac-corridor-(\d+)$/))) {
    return { from: `ISLAND ${m[1]} AUX CORRIDOR`, to: 'LVAC SPINE', trenchRef: `C-${m[1]}` };
  }
  if ((m = id.match(/^auxpwr-island-(\d+)$/))) {
    return {
      from: label(`island-aux-xfmr-${m[1]}`),
      to: label(`island-aux-dist-${m[1]}`),
      trenchRef: `C-${m[1]}`,
    };
  }
  if ((m = id.match(/^fiber-trunk-(\d+)$/))) {
    const fpp = design.equipment.find(e => e.kind === 'fiberPatchPanel');
    const fjb = design.equipment.find(e =>
      e.kind === 'feederJunctionBox' && new RegExp(`^fjb-${m![1]}(?:-\\d+)?$`).test(e.id));
    return {
      from: fpp ? nexteraLabel(fpp) : 'FIBER PATCH PANEL',
      to: fjb ? nexteraLabel(fjb) : `ISLAND ${m[1]} FJB`,
      trenchRef: design.trench ? 'T-1' : '-',
    };
  }
  if ((m = id.match(/^catl-ring-(\d+)(?:-\d+)?$/))) {
    return { from: pcsForContainer(`bess-${m[1]}-`), to: 'CONTAINER COMMS RING', trenchRef: 'BLK' };
  }
  if ((m = id.match(/^catl-tap-(\d+)(?:-\d+)?$/))) {
    return { from: pcsForContainer(`bess-${m[1]}-`), to: `CATL RING ${m[1]}`, trenchRef: 'BLK' };
  }
  if ((m = id.match(/^lvac-bus-h(\d+)$/))) {
    return { from: `LVAC ROW CORRIDOR ${m[1]}`, to: 'CONTAINER FEEDS', trenchRef: `H-${m[1]}` };
  }
  if (id === 'mv-spine') {
    return {
      from: 'MV ROW BUSES',
      to: auxS ? nexteraLabel(auxS) : 'POI STUB',
      trenchRef: trench,
    };
  }
  if (id === 'lvac-spine') {
    return {
      from: auxX ? nexteraLabel(auxX) : 'AUX SOURCE',
      to: 'LVAC ROW BUSES',
      trenchRef: trench,
    };
  }
  if (id === 'fiber-spine') {
    const fpp = design.equipment.find(e => e.kind === 'fiberPatchPanel');
    return {
      from: fpp ? nexteraLabel(fpp) : 'FIBER PATCH PANEL',
      to: 'FIBER ROW BUSES',
      trenchRef: trench,
    };
  }
  if (id === 'lvac-panel-tie') {
    const p = design.equipment.find(e => e.kind === 'auxSwitchPanel');
    return { from: p ? nexteraLabel(p) : 'AUX SWITCH PANEL', to: 'LVAC SPINE', trenchRef: trench };
  }
  if (id === 'fiber-fcp-tie') {
    const p = design.equipment.find(e => e.kind === 'fireControlPanel');
    return { from: p ? nexteraLabel(p) : 'FIRE CONTROL PANEL', to: 'FIBER SPINE', trenchRef: trench };
  }
  if ((m = id.match(/^mv-spine-(peq-\d+)$/))) {
    return { from: label(m[1]), to: 'MV SPINE', trenchRef: trench };
  }
  if ((m = id.match(/^lvac-spine-(peq-\d+)$/))) {
    return { from: label(m[1]), to: 'LVAC SPINE', trenchRef: trench };
  }
  if ((m = id.match(/^fiber-fcp-tie-(peq-\d+)$/))) {
    const fpp = design.equipment.find(e => e.kind === 'fiberPatchPanel');
    return {
      from: label(m[1]),
      to: fpp ? nexteraLabel(fpp) : 'FIBER SPINE',
      trenchRef: trench,
    };
  }
  return { from: '-', to: '-', trenchRef: '-' };
}

export function buildCableScheduleRows(
  design: SiteDesign,
  feeders: FeederCircuit[],
  opts?: CableScheduleOptions
): ScheduleRow[] {
  const slackPct = opts?.slackPct ?? DEFAULT_SLACK_PCT;
  const byId = new Map<string, PlacedEquipment>();
  for (const e of design.equipment) byId.set(e.id, e);
  const rows: ScheduleRow[] = [];

  const push = (
    circuitId: string, from: string, to: string, cls: CableClass,
    spec: CableSpec, rawLengthFt: number, trenchRef: string
  ) => {
    const raw = round1(rawLengthFt);
    const total = round1(raw * (1 + slackPct / 100));
    const conduit = sizeConduit(spec.odIn, spec.conductors);
    rows.push({
      circuitId, from, to, cableClass: cls,
      conductor: spec.description, conductors: spec.conductors, odIn: spec.odIn,
      rawLengthFt: raw, slackPct, totalLengthFt: total,
      conduit: conduit.trade, fillPct: conduit.fillPct, trenchRef,
    });
  };

  // Yard cable runs in routed order (reference-only stubs excluded — no BOL
  // conduit in exclusion zones, matching summarizeCableLengths).
  for (const run of design.cables) {
    if (run.ref) continue;
    const ep = endpointsForRun(run, byId, design);
    push(
      run.id.toUpperCase(), ep.from, ep.to, run.class,
      specForClass(run.class), polylineLengthFt(run.pts), ep.trenchRef
    );
  }

  // MV feeder circuits: one row each, sized conductor from the feeder study.
  for (const f of feeders) {
    const firstInv = f.inverterIds.length ? byId.get(f.inverterIds[0]) : undefined;
    const fjb = f.fjbId ? byId.get(f.fjbId) : undefined;
    const from = firstInv ? nexteraLabel(firstInv) : `FEEDER #${feederDisplayName(f)} HEAD`;
    const to = fjb ? `${nexteraLabel(fjb)} / SUBSTATION` : 'SUBSTATION';
    const matName = f.material === 'Al' ? 'AL' : 'CU';
    // Parallel conductor sets: each set is its own 3-conductor run in its
    // own conduit, so the schedule length counts route length × sets. This
    // keeps BOM cable totals (sum of schedule lengths) equal to the actual
    // purchased circuit-feet.
    const sets = Math.max(1, f.parallelSets || 1);
    const spec: CableSpec = {
      description: `(3) ${f.size} KCMIL ${matName}, 35 KV${sets > 1 ? ` - ${sets} PARALLEL SETS` : ''}`,
      odIn: MV_CONDUCTOR_OD_IN[f.size],
      conductors: 3,
    };
    push(`FDR-${feederDisplayName(f)}`, from, to, 'MV', spec, f.totalLengthFt * sets, 'FDR');
  }

  // Substation aux feeder (34.5 kV daisy chain through every aux
  // transformer, CAR-D-B005-0): one row for the whole chain; conductor is
  // the smallest standard MV size (lightly loaded aux circuit).
  const aux = design.auxFeeder;
  if (aux && aux.legs.length) {
    const lastStop = byId.get(aux.stopIds[aux.stopIds.length - 1]);
    const spec: CableSpec = {
      description: `(3) 500 KCMIL AL, 35 KV`,
      odIn: MV_CONDUCTOR_OD_IN['500'],
      conductors: 3,
    };
    push(
      `AUXF-${auxDisplayName(aux)}`, 'SUBSTATION',
      lastStop ? `${nexteraLabel(lastStop)} (VIA ${aux.stopIds.length} AUX XFMR)` : `${aux.stopIds.length} AUX XFMR CHAIN`,
      'MV', spec, aux.totalLengthFt, 'AUXF'
    );
  }

  return rows;
}

// ---------------------------------------------------------------------------
// CSV export (CRLF, same conventions as bom.ts)
// ---------------------------------------------------------------------------

function csvEscape(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export function cableScheduleToCsv(rows: ScheduleRow[]): string {
  const lines = [
    'CIRCUIT,FROM,TO,CLASS,CONDUCTOR,RAW LF,SLACK %,TOTAL LF,CONDUIT (SCH 40 PVC),FILL %,TRENCH',
  ];
  for (const r of rows) {
    lines.push([
      csvEscape(r.circuitId), csvEscape(r.from), csvEscape(r.to), r.cableClass,
      csvEscape(r.conductor), r.rawLengthFt.toFixed(1), r.slackPct.toFixed(0),
      r.totalLengthFt.toFixed(1), csvEscape(r.conduit), r.fillPct.toFixed(1),
      csvEscape(r.trenchRef),
    ].join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

// ---------------------------------------------------------------------------
// DXF table sheet (standalone, AC1015, same frame conventions as the SLD)
// ---------------------------------------------------------------------------

export const CABLE_SCHEDULE_SHEET_TITLE = 'CABLE & CONDUIT SCHEDULE';

const COLS: { title: string; w: number; get: (r: ScheduleRow) => string }[] = [
  { title: 'CIRCUIT', w: 26, get: r => r.circuitId },
  { title: 'FROM', w: 24, get: r => r.from },
  { title: 'TO', w: 24, get: r => r.to },
  { title: 'CLASS', w: 10, get: r => r.cableClass },
  { title: 'CONDUCTOR', w: 34, get: r => r.conductor },
  { title: 'RAW LF', w: 12, get: r => r.rawLengthFt.toFixed(1) },
  { title: 'SLACK', w: 9, get: r => `${r.slackPct.toFixed(0)}%` },
  { title: 'TOTAL LF', w: 13, get: r => r.totalLengthFt.toFixed(1) },
  { title: 'CONDUIT', w: 13, get: r => r.conduit },
  { title: 'FILL', w: 9, get: r => `${r.fillPct.toFixed(1)}%` },
  { title: 'TRENCH', w: 11, get: r => r.trenchRef },
];

function schedulePlanRect(design: SiteDesign) {
  const xs = design.boundary.polygon.map(p => p.x);
  const ys = design.boundary.polygon.map(p => p.y);
  return {
    minX: Math.min(...xs), maxX: Math.max(...xs),
    minY: Math.min(...ys), maxY: Math.max(...ys),
  };
}

// Draws the schedule as one or more table panels flowing left-to-right in
// the sheet's plan rect. Row/text height derives from the rect so any row
// count fits deterministically.
export function drawCableScheduleInto(
  dxf: DxfWriter,
  rows: ScheduleRow[],
  rect: { minX: number; minY: number; maxX: number; maxY: number }
) {
  const tableW = COLS.reduce((s, c) => s + c.w, 0); // table units
  const rectW = rect.maxX - rect.minX;
  const rectH = rect.maxY - rect.minY;
  const GAP = 6; // gap between stacked table panels, table units

  // Choose panel count so the scaled table fills the rect: n panels side by
  // side, each carrying ceil(rows/n) data rows + 1 header row.
  let best = { n: 1, s: 0 };
  for (let n = 1; n <= 6; n++) {
    const rowsPer = Math.ceil(rows.length / n) + 1; // + header
    const unitW = n * tableW + (n - 1) * GAP;
    // Row height in table units chosen so text stays readable relative to
    // column widths; scale to fit both dimensions.
    const rowH = 4;
    const unitH = rowsPer * rowH;
    const s = Math.min(rectW / unitW, rectH / unitH);
    if (s > best.s) best = { n, s };
  }
  const nPanels = best.n;
  const rowsPerPanel = Math.ceil(rows.length / nPanels);
  const ROW_H = 4;
  const s = best.s;
  const textH = ROW_H * 0.55 * s;

  for (let p = 0; p < nPanels; p++) {
    const slice = rows.slice(p * rowsPerPanel, (p + 1) * rowsPerPanel);
    if (!slice.length) continue;
    const x0 = rect.minX + p * (tableW + GAP) * s;
    const yTop = rect.maxY;
    const panelRows = slice.length + 1;
    const panelH = panelRows * ROW_H * s;
    const panelW = tableW * s;

    // Frame + horizontal rules
    dxf.addPolyline(
      [[x0, yTop - panelH], [x0 + panelW, yTop - panelH], [x0 + panelW, yTop], [x0, yTop]],
      LAYERS.SCHEDULE, true
    );
    for (let i = 1; i < panelRows; i++) {
      const y = yTop - i * ROW_H * s;
      dxf.addLine(x0, y, x0 + panelW, y, LAYERS.SCHEDULE);
    }
    // Vertical rules
    let cx = x0;
    for (let c = 0; c < COLS.length - 1; c++) {
      cx += COLS[c].w * s;
      dxf.addLine(cx, yTop - panelH, cx, yTop, LAYERS.SCHEDULE);
    }
    // Cell text (clipped to column width so cells never overflow)
    const cell = (colX: number, colW: number, y: number, t: string, layer: string) => {
      const maxChars = Math.max(1, Math.floor((colW * s - textH) / (textH * CHAR_W)));
      const txt = t.length > maxChars ? t.slice(0, maxChars) : t;
      dxf.addText(colX + textH * 0.5, y + ROW_H * s * 0.25, textH, txt, layer);
    };
    let hx = x0;
    const headerY = yTop - ROW_H * s;
    for (const c of COLS) {
      cell(hx, c.w, headerY, c.title, LAYERS.TEXT_LG);
      hx += c.w * s;
    }
    slice.forEach((r, i) => {
      const y = yTop - (i + 2) * ROW_H * s;
      let colX = x0;
      for (const c of COLS) {
        cell(colX, c.w, y, c.get(r), LAYERS.TEXT_SM);
        colX += c.w * s;
      }
    });
  }
}

export function composeCableScheduleDxf(
  dxf: DxfWriter,
  design: SiteDesign,
  projectName: string,
  feeders: FeederCircuit[],
  config?: BessConfiguration,
  meta?: TitleBlockMeta,
  opts?: CableScheduleOptions,
) {
  addBaseLayers(dxf);
  addSheetFrame(dxf, design, projectName, config, meta, undefined, undefined, {
    panels: {
      siteInfo: true, equipDims: false, bom: false, legend: false,
      keyNotes: false, notes: false, disclaimer: true,
    },
    schedule: false,
    sheetLabel: 'SHEET CS-1',
    sheetTitle: CABLE_SCHEDULE_SHEET_TITLE,
  });
  const rows = buildCableScheduleRows(design, feeders, opts);
  drawCableScheduleInto(dxf, rows, schedulePlanRect(design));
}

export function buildCableScheduleDxfString(
  design: SiteDesign,
  projectName: string,
  feeders: FeederCircuit[],
  config?: BessConfiguration,
  meta?: TitleBlockMeta,
  opts?: CableScheduleOptions,
): string {
  const dxf = new DxfWriter();
  composeCableScheduleDxf(dxf, design, projectName, feeders, config, meta, opts);
  return dxf.toString();
}
