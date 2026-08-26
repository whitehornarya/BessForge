// DRAINAGE AREA MAP sheet (DR-1, DXF + PDF twin) — plan view of the
// drainage study: subcatchment boundaries traced from the D8 sheds, flow
// paths, perimeter swale runs, discharge points with hydrology callouts,
// riprap outlet aprons, culvert crossings and the detention-basin
// footprint, plus hydrology / riprap / culvert schedule boxes.
//
// STANDALONE opt-in export exactly like GP-1/GP-2: never registered in the
// drawing package SHEET_REGISTRY, never imported by dxfExport / dxfSheets,
// so every existing DXF/PDF export stays byte-identical. Pure +
// deterministic (no Date, no randomness) for byte-stable tests.

import { SiteDesign, Pt } from './types';
import { BessConfiguration } from './catalog';
import {
  DxfWriter,
  LAYERS,
  TitleBlockMeta,
  addBaseLayers,
  addSheetFrame,
} from './dxfExport';
import { FgSurface } from './gradingSurface';
import { DrainageModel } from './drainage';

export const DR_LAYERS = {
  SUBCATCH: 'DR - SUBCATCHMENT',
  FLOWPATH: 'DR - FLOW PATH',
  ARROW: 'DR - FLOW ARROW',
  SWALE: 'DR - SWALE',
  DISCHARGE: 'DR - DISCHARGE',
  RIPRAP: 'DR - RIPRAP APRON',
  CULVERT: 'DR - CULVERT',
  BASIN: 'DR - DETENTION BASIN',
  TEXT: 'DR - TEXT',
} as const;

const DR_COLORS = {
  SUBCATCH: 4,   // cyan dashed
  FLOWPATH: 5,   // blue
  ARROW: 8,      // gray
  SWALE: 3,      // green
  DISCHARGE: 6,  // magenta
  RIPRAP: 1,     // red
  CULVERT: 2,    // yellow
  BASIN: 5,      // blue
  TEXT: 7,
};

export const DRAINAGE_SHEET_TITLE = 'DRAINAGE AREA MAP';

const fmt1 = (v: number) => v.toFixed(1);
const fmt2 = (v: number) => v.toFixed(2);

export function composeDrainageSheetDxf(
  dxf: DxfWriter,
  design: SiteDesign,
  projectName: string,
  fg: FgSurface,
  model: DrainageModel,
  config?: BessConfiguration,
  meta?: TitleBlockMeta,
) {
  const d = model;
  const hasRiprap = d.discharges.some(x => !!x.riprap);
  const hasCulverts = !!d.culverts && d.culverts.length > 0;
  const hasBasin = !!d.detention;

  // Schedule boxes in the right margin.
  const hydroRows = d.discharges.map((dp, k) => {
    const c = dp.compositeC ?? d.inputs.runoffC;
    const i = dp.intensityInHr ?? d.inputs.rainfallIntensityInHr;
    return `DP-${k + 1}  A=${fmt2(dp.areaAcres)} AC  C=${fmt2(c)}  TC=${fmt1(dp.tcMin)} MIN  ` +
      `I=${fmt2(i)} IN/HR  Q=${fmt1(dp.qCfs)} CFS`;
  });
  const extraBoxes: Array<{ title: string; rows: string[] }> = [
    {
      title: d.idfSource
        ? `RATIONAL METHOD (${d.inputs.stormAriYears}-YR NOAA ATLAS 14)`
        : 'RATIONAL METHOD (MANUAL INTENSITY)',
      rows: hydroRows.length ? hydroRows : ['NO DISCHARGE POINTS'],
    },
  ];
  if (hasRiprap) {
    extraBoxes.push({
      title: 'RIPRAP OUTLET PROTECTION (ISBASH, SF 1.25)',
      rows: d.discharges.flatMap((dp, k) => dp.riprap ? [
        `DP-${k + 1}  V=${fmt1(dp.riprap.velocityFps)} FPS  D50=${dp.riprap.d50In}"  ` +
        `APRON ${Math.round(dp.riprap.apronLengthFt)}x${Math.round(dp.riprap.apronWidthFt)} FT  ` +
        `THK ${dp.riprap.thicknessIn}"`,
      ] : []),
    });
  }
  if (hasCulverts) {
    extraBoxes.push({
      title: 'CULVERTS (HDS-5 INLET CONTROL)',
      rows: d.culverts!.map((c, i) =>
        `C-${i + 1}  ${c.diaIn}" RCP  Q=${fmt1(c.qCfs)} CFS  HW/D=${fmt2(c.hwOverD)}  L=${Math.round(c.lengthFt)} FT`),
    });
  }
  if (hasBasin) {
    const b = d.detention!;
    extraBoxes.push({
      title: 'DETENTION BASIN SCREENING',
      rows: [
        `PRE ${fmt1(b.prePeakCfs)} CFS / POST ${fmt1(b.postPeakCfs)} CFS`,
        `REQ ${Math.round(b.requiredCf).toLocaleString('en-US')} CF (${b.method.toUpperCase()})`,
        `BASIN ${Math.round(b.topWFt)}x${Math.round(b.topWFt)} FT TOP, D=${fmt1(b.depthFt)} FT, 3:1`,
        `PROVIDES ${Math.round(b.providedCf).toLocaleString('en-US')} CF` +
          (b.placed ? '' : ' — NOT PLACED, LOCATE MANUALLY'),
      ],
    });
  }

  addBaseLayers(dxf);
  addSheetFrame(dxf, design, projectName, config, meta, undefined, undefined, {
    panels: {
      siteInfo: true, equipDims: false, bom: false, legend: false,
      keyNotes: false, notes: false, disclaimer: true,
    },
    schedule: false,
    sheetLabel: 'SHEET DR-1',
    sheetTitle: DRAINAGE_SHEET_TITLE,
    extraBoxes,
  });

  // Annotation scale keyed to the parcel span (same rule as GP sheets).
  const bxs = design.boundary.polygon.map(p => p.x);
  const bys = design.boundary.polygon.map(p => p.y);
  const minX = Math.min(...bxs), maxX = Math.max(...bxs);
  const minY = Math.min(...bys);
  const span = Math.max(maxX - minX, Math.max(...bys) - minY, 400);
  const k = Math.min(Math.max(span / 1200, 0.5), 4);
  const H = 5 * k;

  dxf.addLayer(DR_LAYERS.SUBCATCH, DR_COLORS.SUBCATCH, 'DASHED');
  dxf.addLayer(DR_LAYERS.FLOWPATH, DR_COLORS.FLOWPATH);
  dxf.addLayer(DR_LAYERS.ARROW, DR_COLORS.ARROW);
  dxf.addLayer(DR_LAYERS.SWALE, DR_COLORS.SWALE);
  dxf.addLayer(DR_LAYERS.DISCHARGE, DR_COLORS.DISCHARGE);
  if (hasRiprap) dxf.addLayer(DR_LAYERS.RIPRAP, DR_COLORS.RIPRAP);
  if (hasCulverts) dxf.addLayer(DR_LAYERS.CULVERT, DR_COLORS.CULVERT);
  if (hasBasin) dxf.addLayer(DR_LAYERS.BASIN, DR_COLORS.BASIN, 'DASHED');
  dxf.addLayer(DR_LAYERS.TEXT, DR_COLORS.TEXT);

  // Fence for orientation (thin, on the base fence layer).
  if (fg.fence.length >= 3) {
    dxf.addPolyline(fg.fence.map(p => [p.x, p.y]), LAYERS.FENCE, true);
  }

  // Subcatchment boundaries + area labels at the loop centroid.
  for (const sc of d.subcatchments ?? []) {
    let biggest: Pt[] | null = null;
    let bigLen = 0;
    for (const loop of sc.loops) {
      dxf.addPolyline(loop.map(p => [p.x, p.y]), DR_LAYERS.SUBCATCH, true);
      if (loop.length > bigLen) { bigLen = loop.length; biggest = loop; }
    }
    if (biggest) {
      const cxL = biggest.reduce((s, p) => s + p.x, 0) / biggest.length;
      const cyL = biggest.reduce((s, p) => s + p.y, 0) / biggest.length;
      dxf.addText(cxL - H * 4, cyL, H * 1.0,
        `DA-${sc.dischargeIdx + 1}  ${fmt2(sc.areaSqFt / 43560)} AC`, DR_LAYERS.TEXT);
    }
  }

  // Major flow paths.
  for (const fp of d.flowPaths) {
    if (fp.pts.length >= 2) dxf.addPolyline(fp.pts.map(p => [p.x, p.y]), DR_LAYERS.FLOWPATH);
  }

  // Flow arrows (short segment + head).
  const arrowLen = H * 2;
  for (const a of d.flowArrows) {
    const hx = a.x + a.dx * arrowLen, hy = a.y + a.dy * arrowLen;
    dxf.addLine(a.x, a.y, hx, hy, DR_LAYERS.ARROW);
    const bx = -a.dx, by = -a.dy;
    const w = arrowLen * 0.3;
    dxf.addLine(hx, hy, hx + (bx - by * 0.6) * w, hy + (by + bx * 0.6) * w, DR_LAYERS.ARROW);
    dxf.addLine(hx, hy, hx + (bx + by * 0.6) * w, hy + (by - bx * 0.6) * w, DR_LAYERS.ARROW);
  }

  // Swale centerlines.
  for (const s of d.swales) {
    if (s.pts.length >= 2) dxf.addPolyline(s.pts.map(p => [p.x, p.y]), DR_LAYERS.SWALE);
  }

  // Discharge points: circle + DP tag + riprap apron rectangle oriented
  // along the outgoing (away-from-yard) direction of the last swale leg.
  d.discharges.forEach((dp, i) => {
    dxf.addArc(dp.p.x, dp.p.y, H * 0.9, 0, Math.PI * 2, true, DR_LAYERS.DISCHARGE);
    dxf.addText(dp.p.x + H * 1.2, dp.p.y + H * 1.2, H * 1.0, `DP-${i + 1}`, DR_LAYERS.DISCHARGE);
    if (dp.riprap) {
      // Outflow direction: from the yard centroid through the DP.
      const cxr = fg.fence.reduce((s, p) => s + p.x, 0) / Math.max(1, fg.fence.length);
      const cyr = fg.fence.reduce((s, p) => s + p.y, 0) / Math.max(1, fg.fence.length);
      let ux = dp.p.x - cxr, uy = dp.p.y - cyr;
      const m = Math.hypot(ux, uy) || 1;
      ux /= m; uy /= m;
      const L = dp.riprap.apronLengthFt, W = dp.riprap.apronWidthFt;
      const px = -uy, py = ux;
      const a: [number, number] = [dp.p.x + px * W / 2, dp.p.y + py * W / 2];
      const b: [number, number] = [dp.p.x - px * W / 2, dp.p.y - py * W / 2];
      const c2: [number, number] = [b[0] + ux * L, b[1] + uy * L];
      const d2: [number, number] = [a[0] + ux * L, a[1] + uy * L];
      dxf.addPolyline([a, b, c2, d2], DR_LAYERS.RIPRAP, true);
      dxf.addText(dp.p.x + ux * L + H, dp.p.y + uy * L, H * 0.8,
        `RIPRAP D50=${dp.riprap.d50In}"`, DR_LAYERS.RIPRAP);
    }
  });

  // Culvert crossings: double circle + tag.
  (d.culverts ?? []).forEach((c, i) => {
    dxf.addArc(c.p.x, c.p.y, H * 0.7, 0, Math.PI * 2, true, DR_LAYERS.CULVERT);
    dxf.addArc(c.p.x, c.p.y, H * 1.1, 0, Math.PI * 2, true, DR_LAYERS.CULVERT);
    dxf.addText(c.p.x + H * 1.4, c.p.y - H * 0.4, H * 0.9,
      `C-${i + 1} ${c.diaIn}" RCP`, DR_LAYERS.CULVERT);
  });

  // Detention basin footprint (top of bank + bottom, 3:1 inset).
  if (d.detention?.placed && d.detention.rect) {
    const b = d.detention;
    const r = b.rect!;
    dxf.addPolyline([[r.x0, r.y0], [r.x1, r.y0], [r.x1, r.y1], [r.x0, r.y1]], DR_LAYERS.BASIN, true);
    const inset = 3 * b.depthFt;
    if (r.x1 - r.x0 > 2 * inset && r.y1 - r.y0 > 2 * inset) {
      dxf.addPolyline([
        [r.x0 + inset, r.y0 + inset], [r.x1 - inset, r.y0 + inset],
        [r.x1 - inset, r.y1 - inset], [r.x0 + inset, r.y1 - inset],
      ], DR_LAYERS.BASIN, true);
    }
    dxf.addText(r.x0, r.y1 + H * 0.8, H * 1.0,
      `DETENTION BASIN  ${Math.round(b.requiredCf).toLocaleString('en-US')} CF REQ`, DR_LAYERS.BASIN);
  }

  // Screening disclaimer south of the plan.
  dxf.addText(minX, minY - H * 4, H * 0.9, d.disclaimer, LAYERS.TEXT_SM);
  if (d.idfSource) {
    dxf.addText(minX, minY - H * 6, H * 0.9,
      `RAINFALL: ${d.idfSource.toUpperCase()} — ${d.inputs.stormAriYears}-YR STORM AT EACH SUBCATCHMENT TC.`,
      LAYERS.TEXT_SM);
  }
}

export function buildDrainageSheetDxfString(
  design: SiteDesign,
  projectName: string,
  fg: FgSurface,
  model: DrainageModel,
  config?: BessConfiguration,
  meta?: TitleBlockMeta,
): string {
  const dxf = new DxfWriter();
  composeDrainageSheetDxf(dxf, design, projectName, fg, model, config, meta);
  return dxf.toString();
}
