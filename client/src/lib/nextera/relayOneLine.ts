// Protection & metering relay one-line for the 34.5 kV collection system:
// utility source → revenue metering (M / CTs / VTs) → main breaker with the
// standard interconnection relay complement (ANSI device numbers) → feeder
// breakers with per-feeder 50/51 overcurrent. Pure functions of the
// SiteDesign + routed feeders + catalog ratings, so the sheet is
// byte-deterministic (same discipline as sld.ts).
//
// SCREENING LEVEL ONLY: device numbers and CT/VT ratios are 10%-design
// placeholders sized by simple rules (next standard CT above 125% of the
// computed bus current). They are NEVER relay settings — the sheet carries
// an explicit "verify with protection study" disclaimer.
//
// STANDALONE export: this sheet is NOT registered in the drawing-package
// SHEET_REGISTRY, so every existing DXF/PDF export stays byte-identical.
import { SiteDesign } from './types';
import { BessConfiguration } from './catalog';
import { FeederCircuit, MV_VOLTAGE } from './feeders';
import { feederDisplayName } from './feederNaming';
import {
  DxfWriter,
  LAYERS,
  TitleBlockMeta,
  addBaseLayers,
  addSheetFrame,
} from './dxfExport';
import { sldPlanRect } from './sld';

// ---------------------------------------------------------------------------
// CT sizing rule (screening placeholder): next standard ANSI CT primary
// rating above 125% of the computed bus load current. Secondary fixed at 5 A.
// ---------------------------------------------------------------------------
export const STANDARD_CT_PRIMARIES = [
  50, 75, 100, 150, 200, 250, 300, 400, 600, 800, 1200, 1600, 2000, 3000, 4000,
] as const;
export const CT_SIZING_FACTOR = 1.25;

export function nextStandardCt(busAmps: number): number {
  const need = busAmps * CT_SIZING_FACTOR;
  for (const p of STANDARD_CT_PRIMARIES) if (p >= need) return p;
  return STANDARD_CT_PRIMARIES[STANDARD_CT_PRIMARIES.length - 1];
}

export const ctRatioLabel = (primary: number) => `${primary}:5`;

// 34.5 kV system VT: standard 34500:120 wye placeholder (ratio 287.5:1).
export const VT_RATIO_LABEL = '34500:120 V';

// Standard interconnection relay complement at the main breaker and the
// per-feeder complement (ANSI device numbers, screening placeholder set).
export const MAIN_RELAY_DEVICES = ['50/51', '50N/51N', '27/59', '81O/U', '25'] as const;
export const FEEDER_RELAY_DEVICES = ['50/51'] as const;
export const LOCKOUT_DEVICE = '86';
export const METER_DEVICE = 'M';

export const RELAY_DISCLAIMER =
  'SCREENING PLACEHOLDER ONLY — DEVICE COMPLEMENT AND CT/VT RATIOS ARE 10% DESIGN ASSUMPTIONS. VERIFY WITH THE PROTECTION AND COORDINATION STUDY. NOT RELAY SETTINGS.';

// ---------------------------------------------------------------------------
// Model: pure topology + placeholder instrument ratings.
// ---------------------------------------------------------------------------
export interface RelayFeederBranch {
  idx: number;
  label: string;          // "FEEDER 1"
  amps: number;           // full feeder current at the main bus
  ctPrimary: number;      // per-feeder CT primary (next standard above 125%)
  ctLine: string;         // "(3) CT 400:5, C200 (RELAYING)"
  devices: string[];      // ["50/51"]
  breakerLabel: string;   // "52-F1"
}

export interface RelayMetering {
  meterLabel: string;     // "M1 — REVENUE METER"
  ctLine: string;         // "(3) CT 1200:5, 0.15S CL (METERING)"
  vtLine: string;         // "(3) VT 34500:120 V, 0.3 CL (METERING)"
  locationLine: string;   // metering location statement
}

export interface RelayOneLineModel {
  busLabel: string;         // "34.5 KV COLLECTION BUS"
  sourceLabel: string;      // "FROM UTILITY / POINT OF INTERCONNECTION"
  totalAmps: number;        // aggregate feeder amps at the main bus
  mainBreakerLabel: string; // "52-M MAIN BREAKER"
  mainCtPrimary: number;
  mainCtLine: string;
  mainVtLine: string;
  mainDevices: string[];    // MAIN_RELAY_DEVICES
  lockoutLabel: string;     // "86 LOCKOUT"
  metering: RelayMetering;
  feeders: RelayFeederBranch[];
}

const fmt = (n: number, d = 0) => n.toFixed(d);

export function buildRelayOneLineModel(
  design: SiteDesign,
  feeders: FeederCircuit[],
  _config?: BessConfiguration,
): RelayOneLineModel {
  const totalAmps = feeders.reduce((s, f) => s + f.amps, 0);
  const mainCt = nextStandardCt(totalAmps);
  const kv = MV_VOLTAGE / 1000;
  return {
    busLabel: `${fmt(kv, 1)} KV COLLECTION BUS`,
    sourceLabel: 'FROM UTILITY / POINT OF INTERCONNECTION',
    totalAmps,
    mainBreakerLabel: '52-M MAIN BREAKER',
    mainCtPrimary: mainCt,
    mainCtLine: `(3) CT ${ctRatioLabel(mainCt)}, C200 (RELAYING)`,
    mainVtLine: `(3) VT ${VT_RATIO_LABEL}, 0.3 CL`,
    mainDevices: [...MAIN_RELAY_DEVICES],
    lockoutLabel: `${LOCKOUT_DEVICE} LOCKOUT`,
    metering: {
      meterLabel: `${METER_DEVICE}1 — REVENUE METER`,
      ctLine: `(3) CT ${ctRatioLabel(mainCt)}, 0.15S CL (METERING)`,
      vtLine: `(3) VT ${VT_RATIO_LABEL}, 0.3 CL (METERING)`,
      locationLine: `REVENUE METERING AT THE ${fmt(kv, 1)} KV MAIN BUS, LINE SIDE OF THE MAIN BREAKER`,
    },
    feeders: feeders.map(f => {
      const ct = nextStandardCt(f.amps);
      return {
        idx: f.idx,
        label: `FEEDER #${feederDisplayName(f)}`,
        amps: f.amps,
        ctPrimary: ct,
        ctLine: `(3) CT ${ctRatioLabel(ct)}, C200 (RELAYING)`,
        devices: [...FEEDER_RELAY_DEVICES],
        breakerLabel: `52-${feederDisplayName(f)}`,
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// Deterministic schematic layout (same scaled schematic-unit approach as the
// SLD): drawn into the writer in schematic units, then uniformly fitted into
// the sheet's plan area.
// ---------------------------------------------------------------------------
const FDR_W = 70;        // column width per feeder branch
const FDR_GAP = 26;      // gap between feeder columns
const SRC_Y = 380;       // source stub top
const MET_Y = 340;       // metering CT/VT tap
const MAIN_Y = 290;      // main breaker center
const BUS_Y = 240;       // main bus
const FBKR_Y = 205;      // feeder breaker centers
const FCT_Y = 168;       // feeder CT position
const FOUT_Y = 120;      // feeder outgoing stub end
const BKR = 8;           // breaker square size
const CT_R = 4;          // CT circle radius
const H_SM = 4.2;
const H_MD = 5.5;

export function relaySchematicWidth(model: RelayOneLineModel): number {
  return Math.max(FDR_GAP + model.feeders.length * (FDR_W + FDR_GAP), 320);
}

export function drawRelayOneLineInto(
  dxf: DxfWriter,
  model: RelayOneLineModel,
  rect: { minX: number; minY: number; maxX: number; maxY: number },
) {
  if ((dxf as any).layerColors?.[LAYERS.SYM_DARK] === undefined &&
      typeof (dxf as any).addLayer === 'function') {
    dxf.addLayer(LAYERS.SYM_DARK, 8);
  }
  const provenance = {
    sourceRenderer: 'relay-one-line',
    role: 'schematic-symbol',
    symbolResolution: 'not-applicable',
  } as const;
  const withNeutralEquipment = <T>(draw: () => T): T =>
    typeof (dxf as any).withProvenance === 'function'
      ? dxf.withProvenance(provenance, draw)
      : draw();
  const W = relaySchematicWidth(model);
  const HGT = 420;
  const s = Math.min((rect.maxX - rect.minX) / W, (rect.maxY - rect.minY) / HGT);
  const ox = rect.minX + ((rect.maxX - rect.minX) - W * s) / 2;
  const oy = rect.minY + ((rect.maxY - rect.minY) - HGT * s) / 2;
  const X = (x: number) => ox + x * s;
  const Y = (y: number) => oy + y * s;
  const line = (x0: number, y0: number, x1: number, y1: number, layer: string) =>
    dxf.addLine(X(x0), Y(y0), X(x1), Y(y1), layer);
  const rectAt = (cx: number, cy: number, w: number, h: number, layer: string) => {
    const draw = () => dxf.addPolyline(
      [
        [X(cx - w / 2), Y(cy - h / 2)],
        [X(cx + w / 2), Y(cy - h / 2)],
        [X(cx + w / 2), Y(cy + h / 2)],
        [X(cx - w / 2), Y(cy + h / 2)],
      ],
      layer, true,
    );
    return layer === LAYERS.SYM_DARK ? withNeutralEquipment(draw) : draw();
  };
  const text = (x: number, y: number, h: number, t: string, layer: string = LAYERS.TEXT_SM) =>
    dxf.addText(X(x), Y(y), h * s, t, layer);
  const circle = (cx: number, cy: number, r: number, layer: string) => {
    // True circles as two half arcs (a 0..2π arc normalizes to zero sweep).
    const draw = () => {
      dxf.addArc(X(cx), Y(cy), r * s, 0, Math.PI, true, layer);
      dxf.addArc(X(cx), Y(cy), r * s, Math.PI, Math.PI * 2, true, layer);
    };
    return layer === LAYERS.SYM_DARK ? withNeutralEquipment(draw) : draw();
  };
  const breaker = (cx: number, cy: number, layer: string) => rectAt(cx, cy, BKR, BKR, layer);
  // CT symbol: circle on the conductor; VT symbol: circle hung off a tap.
  const ct = (cx: number, cy: number) => circle(cx, cy, CT_R, LAYERS.SYM_DARK);

  const busX0 = FDR_GAP;
  const busX1 = W - FDR_GAP;
  const srcX = (busX0 + busX1) / 2;

  // Source stub
  text(srcX - 40, SRC_Y + 8, H_MD, model.sourceLabel, LAYERS.TEXT_LG);
  line(srcX, SRC_Y, srcX, MAIN_Y + BKR / 2, LAYERS.FEEDER);

  // Revenue metering: CTs + VT tap + meter block on the line side
  ct(srcX, MET_Y);
  line(srcX + CT_R, MET_Y, srcX + 22, MET_Y, LAYERS.FEEDER);
  rectAt(srcX + 32, MET_Y, 20, 12, LAYERS.SYM_DARK);
  text(srcX + 24.5, MET_Y - 1.6, H_SM, 'M1', LAYERS.EQUIP_LABELS);
  text(srcX + 46, MET_Y + 4, H_SM, model.metering.meterLabel);
  text(srcX + 46, MET_Y - 2, H_SM, model.metering.ctLine);
  text(srcX + 46, MET_Y - 8, H_SM, model.metering.vtLine);
  // VT tap (hung to the left of the line)
  line(srcX, MET_Y - 14, srcX - 18, MET_Y - 14, LAYERS.FEEDER);
  circle(srcX - 22, MET_Y - 14, CT_R, LAYERS.SYM_DARK);
  text(srcX - 60, MET_Y - 16, H_SM, 'VT');

  // Main breaker + relay complement + lockout
  breaker(srcX, MAIN_Y, LAYERS.SYM_DARK);
  text(srcX + 8, MAIN_Y + 2, H_SM, model.mainBreakerLabel, LAYERS.TEXT_LG);
  ct(srcX, MAIN_Y - BKR / 2 - 10);
  text(srcX + 8, MAIN_Y - BKR / 2 - 12, H_SM, model.mainCtLine);
  text(srcX + 8, MAIN_Y - BKR / 2 - 18, H_SM, model.mainVtLine);
  // Relay bubbles: one circle per device, stacked left of the main breaker
  model.mainDevices.forEach((dev, i) => {
    const ry = MAIN_Y + 14 - i * 13;
    circle(srcX - 34, ry, 5.5, LAYERS.SYM_DARK);
    const tx = srcX - 34 - dev.length * H_SM * 0.42;
    dxf.addText(X(tx), Y(ry - 1.6), H_SM * s, dev, LAYERS.EQUIP_LABELS);
    line(srcX - 28.5, ry, srcX - BKR / 2 - 1, MAIN_Y, LAYERS.CABLE_FIBER);
  });
  // Lockout 86 below the relay stack
  rectAt(srcX - 34, MAIN_Y - 52, 16, 10, LAYERS.SYM_DARK);
  text(srcX - 38, MAIN_Y - 53.6, H_SM, LOCKOUT_DEVICE, LAYERS.EQUIP_LABELS);
  text(srcX - 62, MAIN_Y - 64, H_SM, model.lockoutLabel);
  line(srcX - 34, MAIN_Y - 47, srcX - 34, MAIN_Y + 14 - (model.mainDevices.length - 1) * 13 - 5.5, LAYERS.CABLE_FIBER);

  // Main bus (double line, SLD convention)
  line(srcX, MAIN_Y - BKR / 2, srcX, BUS_Y, LAYERS.FEEDER);
  line(busX0, BUS_Y, busX1, BUS_Y, LAYERS.FEEDER);
  line(busX0, BUS_Y - 1.4, busX1, BUS_Y - 1.4, LAYERS.FEEDER);
  text(busX0, BUS_Y + 4, H_MD, model.busLabel, LAYERS.TEXT_LG);
  text(busX0, BUS_Y - 9, H_SM, `AGGREGATE LOAD ${fmt(model.totalAmps)} A`);

  // Feeder branches
  model.feeders.forEach((f, i) => {
    const fx = FDR_GAP + i * (FDR_W + FDR_GAP) + FDR_W / 2;
    line(fx, BUS_Y - 1.4, fx, FBKR_Y + BKR / 2, LAYERS.FEEDER);
    breaker(fx, FBKR_Y, LAYERS.SYM_DARK);
    text(fx + 7, FBKR_Y + 2, H_SM, f.breakerLabel, LAYERS.TEXT_LG);
    // Per-feeder relay bubble(s)
    f.devices.forEach((dev, j) => {
      const ry = FBKR_Y - 2 - j * 13;
      circle(fx - 20, ry, 5.5, LAYERS.SYM_DARK);
      const tx = fx - 20 - dev.length * H_SM * 0.42;
      dxf.addText(X(tx), Y(ry - 1.6), H_SM * s, dev, LAYERS.EQUIP_LABELS);
      line(fx - 14.5, ry, fx - BKR / 2 - 1, FBKR_Y, LAYERS.CABLE_FIBER);
    });
    line(fx, FBKR_Y - BKR / 2, fx, FOUT_Y, LAYERS.FEEDER);
    ct(fx, FCT_Y);
    text(fx + 7, FCT_Y - 2, H_SM, f.ctLine);
    text(fx + 7, FCT_Y - 8, H_SM, `${fmt(f.amps)} A LOAD`);
    text(fx - 12, FOUT_Y - 8, H_SM, f.label, LAYERS.TEXT_LG);
    text(fx - 12, FOUT_Y - 15, H_SM, 'TO COLLECTION SYSTEM');
  });

  // Notes / disclaimer
  text(busX0, 40, H_SM, 'RELAY ONE-LINE — DIAGRAMMATIC ONLY. DEVICE NUMBERS PER ANSI/IEEE C37.2.');
  text(busX0, 32, H_SM, `CT SIZING RULE: NEXT STANDARD RATIO ABOVE ${fmt(CT_SIZING_FACTOR * 100)}% OF COMPUTED BUS LOAD CURRENT. SECONDARIES 5 A.`);
  text(busX0, 24, H_SM, RELAY_DISCLAIMER);
}

// ---------------------------------------------------------------------------
// Standalone sheet builders (DXF; the PDF plot lives in pdfPlot.ts).
// ---------------------------------------------------------------------------
export const RELAY_SHEET_TITLE = 'RELAY & METERING ONE-LINE';

export function composeRelayOneLineDxf(
  dxf: DxfWriter,
  design: SiteDesign,
  projectName: string,
  feeders: FeederCircuit[],
  config?: BessConfiguration,
  meta?: TitleBlockMeta,
) {
  addBaseLayers(dxf);
  addSheetFrame(dxf, design, projectName, config, meta, undefined, undefined, {
    panels: {
      siteInfo: true, equipDims: false, bom: false, legend: false,
      keyNotes: false, notes: false, disclaimer: true,
    },
    schedule: false,
    sheetLabel: 'SHEET RLY-1',
    sheetTitle: RELAY_SHEET_TITLE,
  });
  const model = buildRelayOneLineModel(design, feeders, config);
  drawRelayOneLineInto(dxf, model, sldPlanRect(design));
}

export function buildRelayOneLineDxfString(
  design: SiteDesign,
  projectName: string,
  feeders: FeederCircuit[],
  config?: BessConfiguration,
  meta?: TitleBlockMeta,
): string {
  const dxf = new DxfWriter();
  composeRelayOneLineDxf(dxf, design, projectName, feeders, config, meta);
  return dxf.toString();
}
