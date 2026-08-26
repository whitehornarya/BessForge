// Auto-generated single-line diagram (SLD) for the 34.5 kV collection
// system: POI/utility source → revenue metering → main breaker → collection
// bus → feeder breakers → (FJB) → PCS + MV step-up transformer → BESS
// container groups → aux power chain. Pure function of the SiteDesign +
// routed feeders + catalog ratings (+ optional short-circuit study), so
// the sheet is byte-deterministic.
//
// Standards encoded here (each symbol cites its clause in sldSymbols.ts):
//  - ANSI/IEEE Std 315 / ANSI Y32.2 — symbol shapes (default, NA practice).
//    Opt-in IEC 60617 alternate set via SldOptions.standard = 'IEC'.
//    The two conventions are NEVER mixed on one sheet.
//  - IEEE C37.2 — device function numbers: 52 = AC circuit breaker,
//    89 = line (isolating) switch. Tags: 52-POI (interconnection breaker),
//    89-POI (POI disconnect), 52-<circuit name> feeder breakers per the
//    issued package's breaker-position names (e.g. 52-14A1), 52-AUX.
//  - IEEE 141 (Red Book) §4 / IEEE 241 — one-line content: bus voltage &
//    ratings, transformer impedance %Z, conductor callouts, and available
//    fault duties shown at the buses when a study is attached.
//  - IEEE 1547-2018 §4.4 + typical LGIA Appendix one-lines — revenue-class
//    metering (CT/PT + WH meter) and a dedicated interconnection breaker
//    at the POI.
//  - NEC (NFPA 70) Art. 480/706 + NFPA 855 / UL 9540 — required BESS
//    disclosures in the notes block (system voltage, stored energy,
//    disconnecting means, listing).
//
// STANDALONE export: this sheet is NOT registered in the default
// drawing-package SHEET_REGISTRY; package inclusion is opt-in (absent
// context field ⇒ every existing DXF/PDF export stays byte-identical).
import { SiteDesign, PlacedEquipment } from './types';
import {
  BessConfiguration, specForKind, LG_JF2_SPEC, HITACHI_AUX_XFMR_SPEC, AUX_SWITCHBOARD_SPEC,
  LG_JF2_NAMEPLATE_MWH, LG_JF2_CONTINUOUS_C_RATE,
} from './catalog';
import { FeederCircuit, MV_VOLTAGE } from './feeders';
import { feederDisplayName } from './feederNaming';
import { ShortCircuitStudy, DEFAULT_SC_INPUTS } from './shortCircuit';
import {
  DxfWriter,
  LAYERS,
  TitleBlockMeta,
  addBaseLayers,
  addSheetFrame,
  nexteraLabel,
} from './dxfExport';
import {
  SldStandard,
  SymbolPen,
  symBreaker,
  symDisconnect,
  symTransformer2W,
  symCT,
  symPT,
  symMeter,
  symGround,
  symBattery,
  symInverter,
} from './sldSymbols';

// ---------------------------------------------------------------------------
// Options (all optional & additive — omitting them keeps legacy behavior:
// ANSI symbols, no fault duties).
// ---------------------------------------------------------------------------

export interface SldOptions {
  standard?: SldStandard;             // 'ANSI' (default) | 'IEC'
  study?: ShortCircuitStudy | null;   // fault duties on buses when present
  // Drafter-entered nameplate impedances from the LGIA data sheet inputs
  // (LgiaInputs.pcsXfmrZPct / auxXfmrZPct). null/absent = not provided —
  // the sheet then states so instead of printing an invented number.
  pcsXfmrZPct?: number | null;
  auxXfmrZPct?: number | null;
}

// ---------------------------------------------------------------------------
// Model: pure topology + ratings, independent of drawing geometry.
// ---------------------------------------------------------------------------

export interface SldPcs {
  label: string;        // yard tag, e.g. PCS01-02 (matches plan sheets)
  model: string;        // inverter model name from the catalog
  rating: string;       // catalog rating string, verbatim
  containerCount: number;
  containerLine: string; // e.g. "4 X LG JF2 DC LINK — 5.1 MWH, 1500 VDC"
  xfmrLine: string;      // integrated MV step-up impedance callout
  faultLine: string | null; // per-PCS MV terminal duty (study only)
  // Short per-column duty form ("12.3 / 30.1 KA") that always fits inside
  // a PCS_W column; the long form above stays for schedules/reports.
  faultShort: string | null;
}

export interface SldFeeder {
  idx: number;
  label: string;         // "FEEDER 1"
  breakerTag: string;    // IEEE C37.2 — "52-F1"
  conductorLine: string; // "(3) 500 KCMIL AL, 35 KV"
  loadLine: string;      // "1240 LF — 312 A (AMPACITY 385 A)"
  fjbLabel: string | null;
  fjbFaultLine: string | null; // FJB bus duty (study only)
  pcs: SldPcs[];
}

export interface SldAux {
  breakerTag: string;       // "52-AUX"
  transformerLabel: string; // "AUX 100 — 34.5 KV - 480/277 V"
  impedanceLine: string;    // "%Z = 5.75 @ 2000 KVA (NAMEPLATE)"
  switchgearLabel: string | null;
  faultLine: string | null; // 480 V bus duty (study only)
}

export interface SldPoi {
  sourceLabel: string;     // utility source text
  disconnectTag: string;   // "89-POI"
  breakerTag: string;      // "52-POI"
  meterLabel: string;      // revenue metering callout
  faultLine: string | null; // main bus duty (study only)
}

export interface SldModel {
  standard: SldStandard;
  busLabel: string;      // "34.5 KV COLLECTION BUS"
  sourceLabel: string;   // kept for compat: same as poi.sourceLabel
  totalLine: string;     // "TOTAL: 100.5 MW — 5 FEEDERS"
  poi: SldPoi;
  feeders: SldFeeder[];
  aux: SldAux | null;
  notes: string[];       // NEC/NFPA 855 disclosure + legend notes
  // Shared PCS unit data block, printed ONCE on the sheet. Every PCS on a
  // site is the same catalog unit, so repeating the model/rating/%Z and
  // container callouts under each symbol just smears neighboring columns
  // together — per-column text is limited to the yard tag, container count
  // and (optionally) the short fault duty.
  pcsDataLines: string[];
}

const fmt = (n: number, d = 0) => n.toFixed(d);

// Bus fault-duty callout per IEEE 141 §4.5 practice: symmetrical + first
// peak at the bus, from the attached simplified study.
function faultLineFor(study: ShortCircuitStudy | null | undefined, busId: string): string | null {
  if (!study) return null;
  const b = study.buses.find(x => x.id === busId);
  if (!b) return null;
  return `FAULT DUTY: ${b.symKA.toFixed(1)} KA SYM / ${b.peakKA.toFixed(1)} KA PEAK`;
}

// Compact per-PCS form of the same duty — must fit a single PCS column.
function faultShortFor(study: ShortCircuitStudy | null | undefined, busId: string): string | null {
  if (!study) return null;
  const b = study.buses.find(x => x.id === busId);
  if (!b) return null;
  return `${b.symKA.toFixed(1)} / ${b.peakKA.toFixed(1)} KA`;
}

export function buildSldModel(
  design: SiteDesign,
  feeders: FeederCircuit[],
  config?: BessConfiguration,
  opts?: SldOptions
): SldModel {
  const standard: SldStandard = opts?.standard === 'IEC' ? 'IEC' : 'ANSI';
  const study = opts?.study ?? null;
  const byId = new Map<string, PlacedEquipment>();
  for (const e of design.equipment) byId.set(e.id, e);

  const invSpec = specForKind('inverter', config);
  const kv = MV_VOLTAGE / 1000;

  // IEEE 141 §4: show transformer %Z — but only values with provenance.
  // The integrated PCS MV step-up impedance is not published in the
  // provided catalog documents, so it prints only when the drafter enters
  // the nameplate value on the LGIA data sheet; otherwise the sheet states
  // that the value is not provided rather than inventing a number.
  const pcsZ = typeof opts?.pcsXfmrZPct === 'number' && Number.isFinite(opts.pcsXfmrZPct)
    ? opts.pcsXfmrZPct : null;
  const xfmrLine = pcsZ !== null
    ? `MV STEP-UP %Z = ${pcsZ} (NAMEPLATE — PROJECT INPUT)`
    : 'MV STEP-UP %Z: NOT PROVIDED — VERIFY W/ MFR NAMEPLATE (SEE LGIA DATA SHEET)';

  const sldFeeders: SldFeeder[] = feeders.map(f => {
    const pcs: SldPcs[] = f.inverterIds.map(id => {
      const inv = byId.get(id);
      const n = id.replace('inv-', '');
      const containerCount = design.equipment.filter(
        e => e.kind === 'bess' && e.id.startsWith(`bess-${n}-`)
      ).length;
      return {
        label: inv ? nexteraLabel(inv) : id.toUpperCase(),
        model: invSpec?.model ?? 'PCS',
        rating: invSpec?.rating ?? '',
        containerCount,
        containerLine: `${containerCount} X ${LG_JF2_SPEC.model} — ${LG_JF2_SPEC.rating}`,
        xfmrLine,
        faultLine: faultLineFor(study, id),
        faultShort: faultShortFor(study, id),
      };
    });
    const fjbEq = f.fjbId ? byId.get(f.fjbId) : undefined;
    const matName = f.material === 'Al' ? 'AL' : 'CU';
    return {
      idx: f.idx,
      label: `FEEDER #${feederDisplayName(f)}`,
      breakerTag: `52-${feederDisplayName(f)}`,
      conductorLine: `(3${(f.parallelSets || 1) > 1 ? `X${f.parallelSets}` : ''}) ${f.size} KCMIL ${matName}, ${fmt(kv, 1)} KV`,
      loadLine: `${fmt(f.totalLengthFt)} LF — BOL ${fmt(f.amps)} A / EOL ${fmt(f.eolAmps || f.amps)} A (EOL AMPACITY ${fmt(Math.max(1, f.parallelSets || 1) * (f.effectiveAmpacity || f.ampacity))} A DERATED)`,
      fjbLabel: f.fjbId ? (fjbEq ? nexteraLabel(fjbEq) : f.fjbId.toUpperCase()) : null,
      fjbFaultLine: f.fjbId ? faultLineFor(study, f.fjbId) : null,
      pcs,
    };
  });

  const auxX = design.equipment.find(e => e.kind === 'auxTransformer');
  const auxS = design.equipment.find(e => e.kind === 'auxSwitchgear');
  const auxIn = study?.inputs ?? DEFAULT_SC_INPUTS;
  // Aux %Z provenance order: drafter nameplate entry (LGIA data sheet),
  // else the attached short-circuit study's sanitized input, else state
  // that the value is not provided (never an unlabeled typical).
  const auxZ = typeof opts?.auxXfmrZPct === 'number' && Number.isFinite(opts.auxXfmrZPct)
    ? opts.auxXfmrZPct : null;
  const auxImpedanceLine = auxZ !== null
    ? `%Z = ${auxZ} @ ${auxIn.auxKVA} KVA (NAMEPLATE — PROJECT INPUT)`
    : study
      ? `%Z = ${auxIn.auxPctZ} @ ${auxIn.auxKVA} KVA (SHORT-CIRCUIT STUDY INPUT)`
      : `%Z: NOT PROVIDED — VERIFY W/ MFR NAMEPLATE (SEE LGIA DATA SHEET)`;
  const aux: SldAux | null = auxX
    ? {
        breakerTag: '52-AUX',
        transformerLabel: `${nexteraLabel(auxX)} — ${HITACHI_AUX_XFMR_SPEC.rating}`,
        impedanceLine: auxImpedanceLine,
        switchgearLabel: auxS
          ? `${nexteraLabel(auxS)} — ${AUX_SWITCHBOARD_SPEC.rating}`
          : null,
        faultLine: faultLineFor(study, 'aux'),
      }
    : null;

  const totalMW = feeders.reduce((s, f) => s + f.loadMW, 0);
  const containerTotal = design.equipment.filter(e => e.kind === 'bess').length;
  // Installed energy uses the SAME container nameplate the layout sized
  // against (5.112 MWh), not the 5.1 MWh public rounding — otherwise this
  // sheet reports a different site energy than the plan/permit/BOM.
  const totalMWH = containerTotal * (config?.containerMWh ?? LG_JF2_NAMEPLATE_MWH);
  const sourceLabel = 'TO SUBSTATION / POINT OF INTERCONNECTION';

  // Notes block: NEC Art. 706 / NFPA 855 / UL 9540 required disclosures +
  // symbol-convention legend note. All derived from the live design.
  const notes = [
    `SYMBOLS PER ${standard === 'ANSI' ? 'ANSI/IEEE STD 315 (ANSI Y32.2)' : 'IEC 60617'}; DEVICE NUMBERS PER IEEE C37.2 (52 = BREAKER, 89 = DISCONNECT).`,
    `ESS PER NEC ART. 706 & NFPA 855: ${containerTotal} X LG JF2 CONTAINERS, 1500 VDC MAX, ${totalMWH.toFixed(1)} MWH TOTAL INSTALLED ENERGY. UL 9540 LISTED UNITS.`,
    'DISCONNECTING MEANS PER NEC 706.15: PCS AC/DC DISCONNECTS INTEGRAL TO EACH UNIT; 89-POI PROVIDES SITE ISOLATION.',
    'REVENUE METERING & INTERCONNECTION BREAKER PER IEEE 1547-2018 / LGIA REQUIREMENTS. RELAY SETTINGS BY OTHERS.',
    'SINGLE-LINE DIAGRAM — DIAGRAMMATIC ONLY. CONDUCTOR SIZES/LENGTHS FROM ROUTED FEEDER PLAN.',
  ];
  // The PCS unit data block prints the manufacturer nameplate (GE: 4.02 MW
  // @40C). Say plainly that the site MW on this sheet is the battery-backed
  // continuous output instead, so the two figures are never read as one.
  if (config && config.inverterModel === 'GE FLEX 1571') {
    notes.push(
      `SITE MW CREDITED FROM BATTERY-BACKED CONTINUOUS OUTPUT: QTY ${config.containersPerBlock} LG X ` +
      `${config.containerMWh.toFixed(3)} MWH X ${LG_JF2_CONTINUOUS_C_RATE}C = ${config.blockMW.toFixed(3)} MW PER PCS BLOCK. ` +
      `GE PCS ${config.pcsCapabilityMW.toFixed(2)} MW IS EQUIPMENT CAPABILITY, NOT CREDITED OUTPUT.`,
    );
  }
  if (study) {
    notes.push('FAULT DUTIES FROM SIMPLIFIED SHORT-CIRCUIT STUDY (IEEE 2800-TYPICAL PCS SOURCES) — VERIFY W/ FULL STUDY FOR CONSTRUCTION.');
  }

  // Shared PCS unit data (printed once): every PCS is the same catalog unit,
  // so its model/rating/%Z and container group callout are hoisted out of
  // the per-column area. Distinct container counts (rare) each get a line.
  const contCounts = Array.from(new Set(sldFeeders.flatMap(f => f.pcs.map(p => p.containerCount))))
    .sort((a, b) => a - b);
  const pcsDataLines = [
    'PCS UNIT DATA (EACH PCS):',
    `${invSpec?.model ?? 'PCS'} — ${invSpec?.rating ?? ''}`,
    xfmrLine,
    ...contCounts.map(n => `${n} X ${LG_JF2_SPEC.model} — ${LG_JF2_SPEC.rating} PER PCS`),
  ];
  if (study) {
    pcsDataLines.push('PCS MV TERMINAL FAULT DUTIES SHOWN AS SYM / PEAK KA.');
  }

  return {
    standard,
    busLabel: `${fmt(kv, 1)} KV COLLECTION BUS`,
    sourceLabel,
    totalLine: `TOTAL: ${fmt(totalMW, 1)} MW CREDITED — ${feeders.length} FEEDER${feeders.length === 1 ? '' : 'S'}`,
    poi: {
      sourceLabel,
      disconnectTag: '89-POI',
      breakerTag: '52-POI',
      meterLabel: 'REVENUE METERING (CT/PT + WH)',
      faultLine: faultLineFor(study, 'main'),
    },
    feeders: sldFeeders,
    aux,
    notes,
    pcsDataLines,
  };
}

// ---------------------------------------------------------------------------
// Deterministic schematic layout, drawn into the writer in schematic units
// then uniformly scaled/translated to fit the sheet's plan area.
// ---------------------------------------------------------------------------

// Schematic constants (schematic units; scaled to the plan area at draw time)
const PCS_W = 46;        // column width per PCS position
const FEEDER_GAP = 34;   // gap between feeder groups
const AUX_W = 90;        // aux branch column width
const BUS_Y = 318;       // main bus
const SRC_Y = 396;       // source stub top
const BKR = 7;           // breaker square size
const FJB_Y = 262;       // FJB box center
const SUBBUS_Y = 225;    // feeder sub-bus
const PCS_Y = 196;       // PCS converter symbol center
const PCS_S = 14;        // PCS converter symbol size
const XFMR_Y = 152;      // transformer symbol center (upper circle)
const XFMR_R = 9;        // transformer circle radius
const CONT_Y = 74;       // container box center
const CONT_W = 40;
const CONT_H = 26;
const H_SM = 4.2;        // small text height
const H_MD = 5.5;

interface XY { x: number; y: number }

// Total schematic width for the model (pure; used by tests too).
export function sldSchematicWidth(model: SldModel): number {
  let w = FEEDER_GAP;
  for (const f of model.feeders) w += Math.max(1, f.pcs.length) * PCS_W + FEEDER_GAP;
  if (model.aux) w += AUX_W + FEEDER_GAP;
  return Math.max(w, 300);
}

export function drawSldInto(
  dxf: DxfWriter,
  model: SldModel,
  rect: { minX: number; minY: number; maxX: number; maxY: number }
) {
  if ((dxf as any).layerColors?.[LAYERS.SYM_DARK] === undefined &&
      typeof (dxf as any).addLayer === 'function') {
    dxf.addLayer(LAYERS.SYM_DARK, 8);
  }
  const provenance = {
    sourceRenderer: 'single-line-diagram',
    role: 'schematic-symbol',
    symbolResolution: 'not-applicable',
  } as const;
  const withNeutralEquipment = <T>(draw: () => T): T =>
    typeof (dxf as any).withProvenance === 'function'
      ? dxf.withProvenance(provenance, draw)
      : draw();
  const W = sldSchematicWidth(model);
  const HGT = 400;
  const s = Math.min((rect.maxX - rect.minX) / W, (rect.maxY - rect.minY) / HGT);
  const ox = rect.minX + ((rect.maxX - rect.minX) - W * s) / 2;
  const oy = rect.minY + ((rect.maxY - rect.minY) - HGT * s) / 2;
  const X = (x: number) => ox + x * s;
  const Y = (y: number) => oy + y * s;
  const line = (a: XY, b: XY, layer: string) => dxf.addLine(X(a.x), Y(a.y), X(b.x), Y(b.y), layer);
  const rectAt = (cx: number, cy: number, w: number, h: number, layer: string) =>
    dxf.addPolyline(
      [
        [X(cx - w / 2), Y(cy - h / 2)],
        [X(cx + w / 2), Y(cy - h / 2)],
        [X(cx + w / 2), Y(cy + h / 2)],
        [X(cx - w / 2), Y(cy + h / 2)],
      ],
      layer, true
    );
  const text = (x: number, y: number, h: number, t: string, layer: string = LAYERS.TEXT_SM) =>
    dxf.addText(X(x), Y(y), h * s, t, layer);
  const ctext = (cx: number, y: number, h: number, t: string, layer: string = LAYERS.TEXT_SM) => {
    // Centered text, clamped so long labels on edge columns never spill
    // outside the sheet's plan area.
    const width = t.length * h * s * 0.84;
    let x0 = X(cx) - width / 2;
    x0 = Math.min(x0, rect.maxX - width);
    x0 = Math.max(x0, rect.minX);
    dxf.addText(x0, Y(y), h * s, t, layer);
  };
  const circle = (cx: number, cy: number, r: number, layer: string) => {
    // A full 0..2π arc would normalize to 50=0/51=0 in the DXF (zero sweep),
    // so true circles are drawn as two half arcs with distinct angles.
    dxf.addArc(X(cx), Y(cy), r * s, 0, Math.PI, true, layer);
    dxf.addArc(X(cx), Y(cy), r * s, Math.PI, Math.PI * 2, true, layer);
  };

  // Symbol pen adapter: schematic units → sheet units, one layer per call
  // site. Full circles route through the two-half-arc convention above.
  const penOn = (layer: string): SymbolPen => ({
    line: (x1, y1, x2, y2) => dxf.addLine(X(x1), Y(y1), X(x2), Y(y2), layer),
    poly: (pts, closed) => dxf.addPolyline(pts.map(p => [X(p[0]), Y(p[1])]), layer, closed),
    circle: (cx, cy, r) => circle(cx, cy, r, layer),
    arc: (cx, cy, r, a0, a1) => dxf.addArc(X(cx), Y(cy), r * s, a0, a1, true, layer),
    text: (cx, y, h, t) => ctext(cx, y, h, t, layer),
  });
  const neutralPen = penOn(LAYERS.SYM_DARK);
  const equipPen: SymbolPen = {
    line: (...args) => withNeutralEquipment(() => neutralPen.line(...args)),
    poly: (...args) => withNeutralEquipment(() => neutralPen.poly(...args)),
    circle: (...args) => withNeutralEquipment(() => neutralPen.circle(...args)),
    arc: (...args) => withNeutralEquipment(() => neutralPen.arc(...args)),
    text: (...args) => withNeutralEquipment(() => neutralPen.text(...args)),
  };
  const neutralRectAt = (cx: number, cy: number, w: number, h: number) =>
    withNeutralEquipment(() => rectAt(cx, cy, w, h, LAYERS.SYM_DARK));
  const std = model.standard;

  // Feeder/aux column extents
  const cols: { x0: number; x1: number; f: SldFeeder }[] = [];
  let cx0 = FEEDER_GAP;
  for (const f of model.feeders) {
    const w = Math.max(1, f.pcs.length) * PCS_W;
    cols.push({ x0: cx0, x1: cx0 + w, f });
    cx0 += w + FEEDER_GAP;
  }
  const auxX0 = model.aux ? cx0 : null;
  const busX1 = model.aux ? cx0 + AUX_W : cx0 - FEEDER_GAP;

  // --- POI / source section: utility → 89-POI disconnect → revenue
  // metering (CT/PT + WH) → 52-POI interconnection breaker → main bus.
  const srcX = (FEEDER_GAP + busX1) / 2;
  ctext(srcX, SRC_Y + 4, H_MD, model.poi.sourceLabel, LAYERS.TEXT_LG);
  line({ x: srcX, y: SRC_Y }, { x: srcX, y: BUS_Y + BKR }, LAYERS.FEEDER);
  // 89-POI disconnect (IEEE C37.2 device 89)
  symDisconnect(equipPen, std, srcX, SRC_Y - 12, BKR);
  text(srcX + BKR, SRC_Y - 13, H_SM, model.poi.disconnectTag);
  // Revenue metering: CT on the run, PT + WH meter tapped to the left
  // (IEEE 1547-2018 §4.4 / LGIA one-line practice).
  const meterY = SRC_Y - 28;
  symCT(equipPen, std, srcX, meterY, 3.4);
  line({ x: srcX - 3.4, y: meterY }, { x: srcX - 16, y: meterY }, LAYERS.FEEDER);
  symPT(equipPen, std, srcX - 20, meterY + 2.5, 2.6);
  symMeter(equipPen, std, srcX - 20, meterY - 6.5, 4, 'WH');
  text(srcX - 42, meterY - 15, H_SM, model.poi.meterLabel);
  // 52-POI interconnection breaker
  symBreaker(equipPen, std, srcX, BUS_Y + BKR / 2 + 2, BKR);
  text(srcX + BKR, BUS_Y + BKR + 2, H_SM, model.poi.breakerTag);
  // Main bus (double line) + system ground (ANSI/IEEE 315 item 13.2)
  line({ x: FEEDER_GAP, y: BUS_Y }, { x: busX1, y: BUS_Y }, LAYERS.FEEDER);
  line({ x: FEEDER_GAP, y: BUS_Y - 1.4 }, { x: busX1, y: BUS_Y - 1.4 }, LAYERS.FEEDER);
  symGround(equipPen, std, FEEDER_GAP - 8, BUS_Y - 8, 6);
  line({ x: FEEDER_GAP, y: BUS_Y - 1.4 }, { x: FEEDER_GAP - 8, y: BUS_Y - 5 }, LAYERS.FEEDER);
  text(FEEDER_GAP, BUS_Y + 4, H_MD, model.busLabel, LAYERS.TEXT_LG);
  text(FEEDER_GAP, BUS_Y - 9, H_SM, model.totalLine);
  if (model.poi.faultLine) text(FEEDER_GAP, BUS_Y - 15, H_SM, model.poi.faultLine);

  // --- Feeders
  for (const col of cols) {
    const f = col.f;
    const dropX = (col.x0 + col.x1) / 2;
    // Feeder breaker 52-Fn (IEEE C37.2 device 52)
    symBreaker(equipPen, std, dropX, BUS_Y - 1.4 - BKR / 2 - 2, BKR);
    text(dropX + 5, BUS_Y - 1.4 - BKR / 2 - 3.5, H_SM, f.breakerTag);
    const fjbTop = f.fjbLabel ? FJB_Y + 8 : SUBBUS_Y;
    line({ x: dropX, y: BUS_Y - 1.4 - BKR - 4 }, { x: dropX, y: fjbTop }, LAYERS.FEEDER);
    text(dropX + 4, (BUS_Y + SUBBUS_Y) / 2 + 14, H_SM, f.label, LAYERS.TEXT_LG);
    text(dropX + 4, (BUS_Y + SUBBUS_Y) / 2 + 7, H_SM, f.conductorLine);
    text(dropX + 4, (BUS_Y + SUBBUS_Y) / 2, H_SM, f.loadLine);
    if (f.fjbLabel) {
      neutralRectAt(dropX, FJB_Y, 26, 16);
      ctext(dropX, FJB_Y - 1.8, H_SM, f.fjbLabel);
      if (f.fjbFaultLine) ctext(dropX, FJB_Y - 12.5, H_SM * 0.85, f.fjbFaultLine);
      line({ x: dropX, y: FJB_Y - 8 }, { x: dropX, y: SUBBUS_Y }, LAYERS.FEEDER);
    }
    // Feeder sub-bus across the PCS span
    line({ x: col.x0 + PCS_W * 0.2, y: SUBBUS_Y }, { x: col.x1 - PCS_W * 0.2, y: SUBBUS_Y }, LAYERS.FEEDER);
    f.pcs.forEach((p, i) => {
      const px = col.x0 + (i + 0.5) * PCS_W;
      line({ x: px, y: SUBBUS_Y }, { x: px, y: PCS_Y + PCS_S / 2 }, LAYERS.FEEDER);
      // PCS converter (IEC 60617 S01213 boxed-converter one-line form)
      symInverter(equipPen, std, px, PCS_Y, PCS_S);
      line({ x: px, y: PCS_Y - PCS_S / 2 }, { x: px, y: XFMR_Y + XFMR_R }, LAYERS.FEEDER);
      // Integrated MV step-up: 2-winding transformer, delta (MV) / wye (LV)
      // per typical PCS step-up practice (IEEE 315 item 86 connection marks).
      symTransformer2W(equipPen, std, px, XFMR_Y, XFMR_R, { hv: 'delta', lv: 'wye' });
      // Per-column text is limited to what varies per PCS (yard tag, count,
      // short fault duty) so neighboring columns can never overlap — the
      // shared model/rating/%Z/container data prints once (pcsDataLines).
      ctext(px, XFMR_Y + XFMR_R + 3, H_SM, p.label, LAYERS.EQUIP_LABELS);
      if (p.faultShort) ctext(px, XFMR_Y - XFMR_R * 2.2 - 6, H_SM * 0.85, p.faultShort);
      line({ x: px, y: XFMR_Y - XFMR_R * 2.2 - 24 }, { x: px, y: CONT_Y + CONT_H / 2 }, LAYERS.CABLE_DC);
      neutralRectAt(px, CONT_Y, CONT_W, CONT_H);
      // Battery plates inside the container box (ANSI/IEEE 315 item 11)
      symBattery(equipPen, std, px - CONT_W / 2 + 7, CONT_Y + 4, 8);
      ctext(px + 4, CONT_Y + 1.5, H_SM * 0.85, `${p.containerCount} X BESS`, LAYERS.EQUIP_LABELS);
    });
  }

  // --- Aux branch: 52-AUX breaker → aux transformer (Δ-Y w/ %Z) →
  // 480 V aux switchboard, LV neutral ground.
  if (model.aux && auxX0 !== null) {
    const ax = auxX0 + AUX_W / 2;
    symBreaker(equipPen, std, ax, BUS_Y - 1.4 - BKR / 2 - 2, BKR);
    text(ax + 5, BUS_Y - 1.4 - BKR / 2 - 3.5, H_SM, model.aux.breakerTag);
    line({ x: ax, y: BUS_Y - 1.4 - BKR - 4 }, { x: ax, y: XFMR_Y + XFMR_R }, LAYERS.FEEDER);
    text(ax + 4, (BUS_Y + SUBBUS_Y) / 2 + 3, H_SM, 'AUX POWER', LAYERS.TEXT_LG);
    symTransformer2W(equipPen, std, ax, XFMR_Y, XFMR_R, { hv: 'delta', lv: 'wye' });
    ctext(ax, XFMR_Y + XFMR_R + 3, H_SM * 0.9, model.aux.transformerLabel, LAYERS.EQUIP_LABELS);
    ctext(ax, XFMR_Y - XFMR_R * 2.2 - 6, H_SM * 0.8, model.aux.impedanceLine);
    // LV neutral earth (solidly grounded wye secondary)
    line({ x: ax + XFMR_R, y: XFMR_Y - XFMR_R * 1.2 }, { x: ax + XFMR_R + 6, y: XFMR_Y - XFMR_R * 1.2 }, LAYERS.FEEDER);
    symGround(equipPen, std, ax + XFMR_R + 6, XFMR_Y - XFMR_R * 1.2 - 3, 5);
    if (model.aux.switchgearLabel) {
      line({ x: ax, y: XFMR_Y - XFMR_R * 2.2 - 8 }, { x: ax, y: CONT_Y + CONT_H / 2 }, LAYERS.CABLE_LVAC);
      neutralRectAt(ax, CONT_Y, CONT_W * 1.6, CONT_H);
      ctext(ax, CONT_Y + 1.5, H_SM * 0.8, 'AUX SWITCHBOARD', LAYERS.EQUIP_LABELS);
      ctext(ax, CONT_Y - 5, H_SM * 0.72, model.aux.switchgearLabel);
      if (model.aux.faultLine) ctext(ax, CONT_Y - 10.5, H_SM * 0.72, model.aux.faultLine);
    }
  }

  // --- Shared PCS unit data block (top-left, printed once). The source
  // stub label is centered mid-sheet at SRC_Y + 4, so starting below
  // SRC_Y keeps the two clear of each other even on narrow sheets.
  (model.pcsDataLines ?? []).forEach((t, i) => {
    text(FEEDER_GAP, SRC_Y - 4 - i * 6.5, H_SM * 0.9, t);
  });

  // --- Notes block (NEC 706 / NFPA 855 / UL 9540 disclosures + legend)
  model.notes.forEach((t, i) => {
    text(FEEDER_GAP, 40 - i * 7, H_SM * 0.9, t);
  });
}

// ---------------------------------------------------------------------------
// Standalone sheet builders (DXF; PDF lives in pdfPlot.ts)
// ---------------------------------------------------------------------------

export const SLD_SHEET_TITLE = 'SINGLE-LINE DIAGRAM';

export function sldPlanRect(design: SiteDesign) {
  const xs = design.boundary.polygon.map(p => p.x);
  const ys = design.boundary.polygon.map(p => p.y);
  return {
    minX: Math.min(...xs), maxX: Math.max(...xs),
    minY: Math.min(...ys), maxY: Math.max(...ys),
  };
}

export function composeSldDxf(
  dxf: DxfWriter,
  design: SiteDesign,
  projectName: string,
  feeders: FeederCircuit[],
  config?: BessConfiguration,
  meta?: TitleBlockMeta,
  opts?: SldOptions,
) {
  addBaseLayers(dxf);
  addSheetFrame(dxf, design, projectName, config, meta, undefined, undefined, {
    panels: {
      siteInfo: true, equipDims: false, bom: false, legend: false,
      keyNotes: false, notes: false, disclaimer: true,
    },
    schedule: false,
    sheetLabel: 'SHEET SLD-1',
    sheetTitle: SLD_SHEET_TITLE,
  });
  const model = buildSldModel(design, feeders, config, opts);
  drawSldInto(dxf, model, sldPlanRect(design));
}

export function buildSldDxfString(
  design: SiteDesign,
  projectName: string,
  feeders: FeederCircuit[],
  config?: BessConfiguration,
  meta?: TitleBlockMeta,
  opts?: SldOptions,
): string {
  const dxf = new DxfWriter();
  composeSldDxf(dxf, design, projectName, feeders, config, meta, opts);
  return dxf.toString();
}
