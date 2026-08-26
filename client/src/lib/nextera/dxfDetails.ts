// Equipment detail sheets: scaled 2D outline views (plan / front / side)
// of each equipment type, redrawn from the uploaded manufacturer documents
// (LG F2D4-5.1US spec + MC01 mechanical drawings, PE FREEMAQ PCSM datasheet,
// BB3/BB4 switchboard package, Hitachi outline DWG 0890229856).
//
// Hard project rule: the DXF stays simple 2D rectangles — these views are
// diagrammatic outlines with TRUE catalog dimensions on the dim layer.
// Views are drawn at a uniform per-sheet scale chosen to fill the plan
// area (N.T.S. relative to the site plan sheets).
import { SiteDesign } from './types';
import {
  DxfWriter,
  LAYERS,
  CHAR_W,
  dimH,
  dimV,
  ftIn,
} from './dxfExport';
import {
  BessConfiguration,
  EquipmentSpec,
  LG_JF2_SPEC,
  PE_FP4200M_SPEC,
  GE_FLEX_1571_SPEC,
  HITACHI_AUX_XFMR_SPEC,
  AUX_SWITCHBOARD_SPEC,
  AUX_SWITCH_PANEL_SPEC,
  FIBER_PATCH_PANEL_SPEC,
  FIRE_CONTROL_PANEL_SPEC,
} from './catalog';

export interface DetailItem {
  spec: EquipmentSpec;
  notes: string[]; // source document + key callouts (all from the uploads)
}

// BESS + PCS detail items (sheet: BESS & PCS EQUIPMENT DETAILS)
export function bessPcsDetailItems(config?: BessConfiguration): DetailItem[] {
  const inverter =
    config?.inverterModel === 'PE FP4200M' ? PE_FP4200M_SPEC : GE_FLEX_1571_SPEC;
  const inverterNotes =
    inverter === PE_FP4200M_SPEC
      ? [
          'SOURCE: PE FREEMAQ PCSM DATASHEET REV 1-17 (PCSM GEN3 UL)',
          'OUTDOOR SKID-MOUNTED MV POWER STATION, 34.5 KV STEP-UP',
        ]
      : [
          'SOURCE: GE VERNOVA FLEXINVERTER DATASHEET X88036-R008',
          'OUTDOOR CONTAINERIZED MV POWER STATION, 34.5 KV STEP-UP',
        ];
  return [
    {
      spec: LG_JF2_SPEC,
      notes: [
        'SOURCE: LG F2D4-5.1US-GN04 SPEC V5.0 / MC01 MECH & STRUCT DWGS V2.0',
        'SEISMIC: SDS 1.2 (8 ANCHOR BRACKETS) / SDS 1.5 (14), ASCE 7-22 RC III',
        'OPERATING: -30 TO 50 DEG C, 5-100% RH, TO 2,000 M ALTITUDE',
      ],
    },
    { spec: inverter, notes: inverterNotes },
  ];
}

// Auxiliary equipment detail items (sheet: AUXILIARY EQUIPMENT DETAILS)
export function auxDetailItems(): DetailItem[] {
  return [
    {
      spec: HITACHI_AUX_XFMR_SPEC,
      notes: ['SOURCE: HITACHI ENERGY OUTLINE DWG 0890229856', 'PAD-MOUNT, 34.5 KV - 480/277 V'],
    },
    {
      spec: AUX_SWITCHBOARD_SPEC,
      notes: [
        'SOURCE: BB3 & BB4 DRAWING PACKAGE (FMCD & FAD)',
        'NEMA 3R, 2000 A MAIN, 65 KAIC, CAMLOCK + DISTRIBUTION SECTIONS',
      ],
    },
    { spec: AUX_SWITCH_PANEL_SPEC, notes: ['PER GUIDANCE SHEETS 3-4 LEGEND'] },
    { spec: FIBER_PATCH_PANEL_SPEC, notes: ['PER GUIDANCE SHEETS 3-4 LEGEND'] },
    { spec: FIRE_CONTROL_PANEL_SPEC, notes: ['PER GUIDANCE SHEETS 3-4 LEGEND'] },
  ];
}

// A simple neutral rectangle outline for a dimensioned equipment view. These
// are intentionally schematic, not unresolved red yard-symbol fallbacks.
function rect(dxf: DxfWriter, x: number, y: number, w: number, h: number) {
  if ((dxf as any).layerColors?.[LAYERS.SYM_DARK] === undefined &&
      typeof (dxf as any).addLayer === 'function') {
    dxf.addLayer(LAYERS.SYM_DARK, 8);
  }
  const draw = () => {
    dxf.addPolyline(
      [
        [x, y],
        [x + w, y],
        [x + w, y + h],
        [x, y + h],
      ],
      LAYERS.SYM_DARK,
      true
    );
  };
  const provenance = {
    sourceRenderer: 'equipment-detail',
    role: 'schematic-symbol',
    symbolResolution: 'not-applicable',
  } as const;
  if (typeof (dxf as any).withProvenance === 'function') dxf.withProvenance(provenance, draw);
  else draw();
}

// One dimensioned view: scaled rectangle + true-dimension callouts + caption.
function view(
  dxf: DxfWriter,
  x: number, // left edge of the view rect
  y: number, // bottom edge of the view rect
  trueW: number,
  trueH: number,
  s: number, // drawing scale (drawn ft per true ft)
  caption: string,
  textH: number
) {
  const w = trueW * s;
  const h = trueH * s;
  rect(dxf, x, y, w, h);
  const off = textH * 2.5;
  dimH(dxf, x, x + w, y, y - off, ftIn(trueW));
  dimV(dxf, y, y + h, x, x - off, ftIn(trueH));
  dxf.addCenteredText(x + w / 2, y - off - textH * 2.4, textH, caption, LAYERS.TEXT_SM,
    undefined, { est: CHAR_W });
  return w;
}

// One equipment detail cell: header, PLAN / FRONT / SIDE views, spec notes.
function detailCell(
  dxf: DxfWriter,
  x0: number,
  y0: number, // top-left corner of the cell
  cellW: number,
  cellH: number,
  item: DetailItem
) {
  const { spec } = item;
  const L = spec.dims.length, W = spec.dims.width, H = spec.dims.height;
  const textH = Math.max(3, Math.min(5, cellH / 22));
  const header = `${spec.tag} - ${spec.manufacturer} ${spec.model}`;
  dxf.addText(x0, y0 - textH * 1.6, textH * 1.15, header, LAYERS.TEXT_LG);

  // Views band: PLAN (L x W), FRONT ELEVATION (L x H), SIDE ELEVATION (W x H)
  const gap = cellW * 0.06;
  const dimPad = textH * 6; // room for dim lines + captions around each view
  const availW = cellW - 2 * gap - 3 * dimPad;
  const availH = cellH * 0.52 - dimPad;
  const s = Math.min(availW / (L + L + W), availH / Math.max(W, H));

  const bandBottom = y0 - textH * 4 - Math.max(W, H) * s - dimPad * 0.2;
  let vx = x0 + dimPad;
  vx += view(dxf, vx, bandBottom, L, W, s, 'PLAN VIEW', textH) + gap + dimPad;
  vx += view(dxf, vx, bandBottom, L, H, s, 'FRONT ELEVATION', textH) + gap + dimPad;
  view(dxf, vx, bandBottom, W, H, s, 'SIDE ELEVATION', textH);

  // Spec + source notes under the views.
  const lines = [
    `RATING: ${spec.rating}`,
    `DIMENSIONS: ${ftIn(L)} L x ${ftIn(W)} W x ${ftIn(H)} H`,
    spec.weightLbs != null
      ? `WEIGHT: ${spec.weightLbs.toLocaleString('en-US')} LBS`
      : 'WEIGHT: NOT STATED IN PROVIDED DOCUMENTS',
    ...item.notes,
  ];
  let ty = bandBottom - textH * 7;
  for (const line of lines) {
    dxf.addText(x0, ty, textH, line, LAYERS.TEXT_SM);
    ty -= textH * 1.8;
  }
}

// Compose one equipment-details sheet: stacked detail cells sized to the
// site extents (so the shared sheet-frame/plot transform frames them well).
export function drawEquipmentDetailSheet(
  dxf: DxfWriter,
  design: SiteDesign,
  items: DetailItem[]
) {
  const xs = design.boundary.polygon.map(p => p.x);
  const ys = design.boundary.polygon.map(p => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  // Fixed-proportion drawing region centered on the site extents; a floor
  // keeps the views/dim text legible on very small parcels.
  const w = Math.max(maxX - minX, 600);
  const h = Math.max(maxY - minY, 400);
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const x0 = cx - w / 2, yTop = cy + h / 2;

  const note = 'DETAIL VIEWS N.T.S. - DIMENSIONS TRUE PER MANUFACTURER DOCUMENTS';
  dxf.addText(x0, yTop + 10, 5, note, LAYERS.TEXT_LG);

  const cellH = h / items.length;
  items.forEach((item, i) => {
    detailCell(dxf, x0, yTop - i * cellH, w, cellH, item);
  });
}
