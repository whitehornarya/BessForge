// Bill-of-materials sheets in the EXACT CAR-D-B018-1/-2 template of the
// issued 90% package (standalone, AC1015, same frame conventions as the
// other sheets).
//
// Sheet 1 ("BILL OF MATERIALS (SHEET 1)", B018-1): two table panels —
//   left:  BUS/CONDUCTOR, RUBBER GOODS/ SURGE ARRESTERS, EQUIPMENT,
//          PATCH PANEL & COMMS, HARDWARE through the first H13 child
//   right: remaining HARDWARE assemblies, CONDUIT through K4D
// Sheet 2 ("BILL OF MATERIALS (SHEET 2)", B018-2): left panel CONDUIT
//   continuing at K8, EQUIPMENT LABELS, GROUNDING. The reference sheet's
//   right panel is blank; we print the app-computed sections (MAJOR
//   EQUIPMENT / CABLE / TERMINATIONS / CONDUIT / CIVIL / GROUNDING) there
//   in the generic 4-column table — those are explicitly NOT part of the
//   template match.
// Both sheets carry the "ISSUED FOR 90% REVIEW" stamp above the title block.
//
// Panel breaks are CONTENT-anchored (after H13's first child row and after
// K4D), exactly where the issued sheets break — the template row count is
// design-independent, so the split never drifts.
//
// Template rows come VERBATIM from buildPartsTemplateRows (bomCatalog), the
// same builder that feeds the Full BOM CSV parts section; the app-computed
// sections come from buildBomRows + buildBomRollup. Nothing is recomputed
// here, so the DXF sheets, the PDF plots, and the CSV always agree.
//
// STANDALONE opt-in export (SLD pattern): NOT registered in the default
// drawing-package SHEET_REGISTRY; the default DXF/PDF/yard exports never
// call into this module, so they stay byte-identical.
import { SiteDesign } from './types';
import { BessConfiguration } from './catalog';
import { FeederCircuit } from './feeders';
import { GroundingPlan } from './grounding';
import { buildBomRows } from './bom';
import { BomTemplateRow, buildPartsTemplateRows, designCounts } from './bomCatalog';
import { BomRollup, buildBomRollup } from './bomRollup';
import { buildCableScheduleRows } from './cableSchedule';
import {
  DxfWriter,
  LAYERS,
  CHAR_W,
  TitleBlockMeta,
  addBaseLayers,
  addSheetFrame,
} from './dxfExport';

export const BOM_SHEET_TITLE_1 = 'BILL OF MATERIALS (SHEET 1)';
export const BOM_SHEET_TITLE_2 = 'BILL OF MATERIALS (SHEET 2)';
export const BOM_REVIEW_STAMP = 'ISSUED FOR 90% REVIEW';

export interface BomSheetOptions {
  groundingPlan?: GroundingPlan | null;
  /** Which B018 sheet to compose (default 1). */
  sheet?: 1 | 2;
}

// One flattened, sectioned line list — the app-computed quantity sections
// printed on sheet 2's right panel (NOT part of the B018 template match).
export interface BomSheetLine {
  section: string;
  qty: number | string;
  unit: string;
  description: string;
}

export function buildBomSheetLines(
  design: SiteDesign,
  feeders: FeederCircuit[],
  config?: BessConfiguration,
  opts?: BomSheetOptions,
): BomSheetLine[] {
  const grounding = opts?.groundingPlan ?? null;
  const scheduleRows = buildCableScheduleRows(design, feeders);
  const rollup: BomRollup = buildBomRollup(scheduleRows, design, feeders, grounding);
  const lines: BomSheetLine[] = [];
  const add = (section: string, rows: { qty: number | string; unit: string; description: string }[]) => {
    for (const r of rows) lines.push({ section, qty: r.qty, unit: r.unit, description: r.description });
  };
  add('MAJOR EQUIPMENT', buildBomRows(design, config, feeders));
  add('CABLE', rollup.cable);
  add('TERMINATIONS', rollup.terminations);
  add('CONDUIT', rollup.conduit);
  add('CIVIL', rollup.civil);
  if (rollup.grounding.length) add('GROUNDING', rollup.grounding);
  return lines;
}

// ---------------------------------------------------------------------------
// B018 template panel split — content-anchored at the issued sheets' breaks.
// ---------------------------------------------------------------------------

export interface BomTemplatePanels {
  sheet1: [BomTemplateRow[], BomTemplateRow[]];
  sheet2: BomTemplateRow[];
}

export function splitTemplateRows(rows: BomTemplateRow[]): BomTemplatePanels {
  const idx = (tag: string) =>
    rows.findIndex(r => (r.kind === 'part' || r.kind === 'parent') && r.tag === tag);
  const b1 = idx('H13.1');      // sheet-1 left panel ends after H13's first child
  const b2 = idx('K4D');        // sheet 1 ends after K4D; K8 opens sheet 2
  if (b1 < 0 || b2 < 0 || b2 <= b1) throw new Error('B018 template break anchors missing');
  return {
    sheet1: [rows.slice(0, b1 + 1), rows.slice(b1 + 1, b2 + 1)],
    sheet2: rows.slice(b2 + 1),
  };
}

// ---------------------------------------------------------------------------
// B018 template panel renderer — 9 columns exactly as the issued sheets:
// ITEM | MFGR | CATALOG NO. | DESCRIPTION | QUANTITY | UNIT | FURNISHED BY |
// NOTES | REVISIONS, under a "BILL OF MATERIALS" title band, with section
// title rows, blank spacer rows, assembly parent rows and blank-ITEM children.
// ---------------------------------------------------------------------------

export const B018_COLS: { title: string; w: number }[] = [
  { title: 'ITEM', w: 8 },
  { title: 'MFGR', w: 12 },
  { title: 'CATALOG NO.', w: 15 },
  { title: 'DESCRIPTION', w: 54 },
  { title: 'QUANTITY', w: 9 },
  { title: 'UNIT', w: 6 },
  { title: 'FURNISHED BY', w: 12 },
  { title: 'NOTES', w: 15 },
  { title: 'REVISIONS', w: 9 },
];
const B018_TABLE_W = B018_COLS.reduce((s, c) => s + c.w, 0);
const B018_ROW_H = 4;
const B018_GAP = 8;

function wrapText(t: string, maxChars: number): string[] {
  if (t.length <= maxChars) return [t];
  const words = t.split(' ');
  const out: string[] = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (next.length > maxChars && cur) { out.push(cur); cur = w; }
    else cur = next;
  }
  if (cur) out.push(cur);
  return out;
}

/** Draws one B018 panel; returns nothing. `s` is the model-units-per-row scale. */
export function drawB018PanelInto(
  dxf: DxfWriter,
  rows: BomTemplateRow[],
  x0: number,
  yTop: number,
  s: number,
) {
  const rowH = B018_ROW_H * s;
  const panelW = B018_TABLE_W * s;
  const nRows = rows.length + 2; // title band + column header
  const panelH = nRows * rowH;
  const textH = rowH * 0.42;

  // frame + horizontal rules
  dxf.addPolyline(
    [[x0, yTop - panelH], [x0 + panelW, yTop - panelH], [x0 + panelW, yTop], [x0, yTop]],
    LAYERS.SCHEDULE, true
  );
  for (let i = 1; i < nRows; i++) {
    dxf.addLine(x0, yTop - i * rowH, x0 + panelW, yTop - i * rowH, LAYERS.SCHEDULE);
  }
  // vertical rules (below the title band only)
  let cx = x0;
  for (let c = 0; c < B018_COLS.length - 1; c++) {
    cx += B018_COLS[c].w * s;
    dxf.addLine(cx, yTop - panelH, cx, yTop - rowH, LAYERS.SCHEDULE);
  }

  const centered = (colX: number, colW: number, yMid: number, t: string, h: number, layer: string) => {
    // true DXF center justification on the column center (register F-24)
    dxf.addCenteredText(colX + (colW * s) / 2, yMid - h / 2, h, t, layer,
      undefined, { est: CHAR_W });
  };

  // title band
  centered(x0, B018_TABLE_W, yTop - rowH / 2, 'BILL OF MATERIALS', textH * 1.5, LAYERS.TEXT_LG);
  // column header row
  {
    let hx = x0;
    const yMid = yTop - rowH * 1.5;
    for (const c of B018_COLS) {
      centered(hx, c.w, yMid, c.title, textH, LAYERS.TEXT_LG);
      hx += c.w * s;
    }
  }
  const descIdx = 3;
  const descX = x0 + B018_COLS.slice(0, descIdx).reduce((a, c) => a + c.w, 0) * s;

  rows.forEach((r, i) => {
    const yMid = yTop - (i + 2.5) * rowH;
    if (r.kind === 'spacer') return;
    if (r.kind === 'section') {
      centered(descX - x0 + x0, B018_COLS[descIdx].w, yMid, r.title, textH * 1.3, LAYERS.TEXT_LG);
      return;
    }
    const vals = [r.item, r.mfgr, r.catalogNo, r.description, r.qty, r.unit, r.furnishedBy, r.notes, ''];
    let colX = x0;
    for (let c = 0; c < B018_COLS.length; c++) {
      const t = vals[c];
      if (t) {
        const maxChars = Math.max(1, Math.floor((B018_COLS[c].w * s - textH) / (textH * CHAR_W)));
        const linesOut = wrapText(t, maxChars).slice(0, 3);
        const h = linesOut.length > 1 ? textH * 0.78 : textH;
        const lineGap = h * 1.15;
        const yStart = yMid + ((linesOut.length - 1) * lineGap) / 2;
        linesOut.forEach((ln, li) => {
          dxf.addCenteredText(colX + (B018_COLS[c].w * s) / 2, yStart - li * lineGap - h / 2,
            h, ln, LAYERS.TEXT_SM, undefined, { est: CHAR_W });
        });
      }
      colX += B018_COLS[c].w * s;
    }
  });
}

// ---------------------------------------------------------------------------
// Generic 4-column app-sections table (sheet 2 right panel; unchanged format).
// ---------------------------------------------------------------------------

const COLS: { title: string; w: number; get: (r: BomSheetLine) => string }[] = [
  { title: 'SECTION', w: 26, get: r => r.section },
  { title: 'QTY', w: 12, get: r => String(r.qty) },
  { title: 'UNIT', w: 9, get: r => r.unit },
  { title: 'DESCRIPTION', w: 110, get: r => r.description },
];

function bomPlanRect(design: SiteDesign) {
  const xs = design.boundary.polygon.map(p => p.x);
  const ys = design.boundary.polygon.map(p => p.y);
  return {
    minX: Math.min(...xs), maxX: Math.max(...xs),
    minY: Math.min(...ys), maxY: Math.max(...ys),
  };
}

// Draws the app-computed sections as a single generic table panel scaled to
// fit the given rect (same conventions as the cable schedule sheet).
export function drawBomSheetInto(
  dxf: DxfWriter,
  rows: BomSheetLine[],
  rect: { minX: number; minY: number; maxX: number; maxY: number }
) {
  if (!rows.length) return;
  const tableW = COLS.reduce((s, c) => s + c.w, 0);
  const rectW = rect.maxX - rect.minX;
  const rectH = rect.maxY - rect.minY;
  const ROW_H = 4;
  const s = Math.min(rectW / tableW, rectH / ((rows.length + 1) * ROW_H));
  const textH = ROW_H * 0.55 * s;

  const x0 = rect.minX;
  const yTop = rect.maxY;
  const panelRows = rows.length + 1;
  const panelH = panelRows * ROW_H * s;
  const panelW = tableW * s;

  dxf.addPolyline(
    [[x0, yTop - panelH], [x0 + panelW, yTop - panelH], [x0 + panelW, yTop], [x0, yTop]],
    LAYERS.SCHEDULE, true
  );
  for (let i = 1; i < panelRows; i++) {
    const y = yTop - i * ROW_H * s;
    dxf.addLine(x0, y, x0 + panelW, y, LAYERS.SCHEDULE);
  }
  let cx = x0;
  for (let c = 0; c < COLS.length - 1; c++) {
    cx += COLS[c].w * s;
    dxf.addLine(cx, yTop - panelH, cx, yTop, LAYERS.SCHEDULE);
  }
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
  rows.forEach((r, i) => {
    const y = yTop - (i + 2) * ROW_H * s;
    let colX = x0;
    const prev = i === 0 ? undefined : rows[i - 1];
    for (const c of COLS) {
      const raw = c.get(r);
      const t = c.title === 'SECTION' && prev && prev.section === r.section ? '' : raw;
      if (t) cell(colX, c.w, y, t, LAYERS.TEXT_SM);
      colX += c.w * s;
    }
  });
}

// ---------------------------------------------------------------------------
// Sheet composition
// ---------------------------------------------------------------------------

function drawReviewStamp(dxf: DxfWriter, rect: { minX: number; minY: number; maxX: number; maxY: number }) {
  const w = (rect.maxX - rect.minX) * 0.16;
  const h = w * 0.14;
  const x1 = rect.maxX;
  const y0 = rect.minY + (rect.maxY - rect.minY) * 0.06;
  dxf.addPolyline(
    [[x1 - w, y0], [x1, y0], [x1, y0 + h], [x1 - w, y0 + h]],
    LAYERS.SCHEDULE, true
  );
  const textH = h * 0.45;
  dxf.addCenteredText(x1 - w / 2, y0 + (h - textH) / 2, textH, BOM_REVIEW_STAMP, LAYERS.TEXT_LG,
    undefined, { est: CHAR_W });
}

export function composeBomSheetDxf(
  dxf: DxfWriter,
  design: SiteDesign,
  projectName: string,
  feeders: FeederCircuit[],
  config?: BessConfiguration,
  meta?: TitleBlockMeta,
  opts?: BomSheetOptions,
) {
  const sheetNo = opts?.sheet ?? 1;
  addBaseLayers(dxf);
  addSheetFrame(dxf, design, projectName, config, meta, undefined, undefined, {
    panels: {
      siteInfo: true, equipDims: false, bom: false, legend: false,
      keyNotes: false, notes: false, disclaimer: true,
    },
    schedule: false,
    sheetLabel: sheetNo === 1 ? 'SHEET B018-1' : 'SHEET B018-2',
    sheetTitle: sheetNo === 1 ? BOM_SHEET_TITLE_1 : BOM_SHEET_TITLE_2,
  });
  const rect = bomPlanRect(design);
  const panels = splitTemplateRows(
    buildPartsTemplateRows(designCounts(design.equipment, design.islands))
  );

  const rectW = rect.maxX - rect.minX;
  const rectH = rect.maxY - rect.minY;
  const left = sheetNo === 1 ? panels.sheet1[0] : panels.sheet2;
  const right = sheetNo === 1 ? panels.sheet1[1] : null;
  const maxRows = Math.max(left.length, right?.length ?? 0) + 2;
  const unitW = right ? 2 * B018_TABLE_W + B018_GAP : 2 * B018_TABLE_W + B018_GAP;
  const s = Math.min(rectW / unitW, rectH / (maxRows * B018_ROW_H));

  drawB018PanelInto(dxf, left, rect.minX, rect.maxY, s);
  if (right) {
    drawB018PanelInto(dxf, right, rect.minX + (B018_TABLE_W + B018_GAP) * s, rect.maxY, s);
  } else {
    // Sheet 2 right half: app-computed quantity sections (not template-matched)
    const appRows = buildBomSheetLines(design, feeders, config, opts);
    drawBomSheetInto(dxf, appRows, {
      minX: rect.minX + (B018_TABLE_W + B018_GAP) * s,
      minY: rect.minY,
      maxX: rect.maxX,
      maxY: rect.maxY,
    });
  }
  drawReviewStamp(dxf, rect);
}

export function buildBomSheetDxfString(
  design: SiteDesign,
  projectName: string,
  feeders: FeederCircuit[],
  config?: BessConfiguration,
  meta?: TitleBlockMeta,
  opts?: BomSheetOptions,
): string {
  const dxf = new DxfWriter();
  composeBomSheetDxf(dxf, design, projectName, feeders, config, meta, opts);
  return dxf.toString();
}
