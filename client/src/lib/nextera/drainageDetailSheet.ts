// DRAINAGE DETAILS & ROUTING sheet (DR-2, DXF + PDF twin) — the design-grade
// companion to the DR-1 area map: channel typical section, detention outlet
// structure detail, culvert profile diagram, plus TR-55 Tc breakdown, NRCS
// hydrology, level-pool routing and stage–storage tables.
//
// STANDALONE opt-in export exactly like DR-1/GP-1/GP-2: never registered in
// the drawing package SHEET_REGISTRY, never imported by dxfExport /
// dxfSheets, so every existing DXF/PDF export stays byte-identical. Pure +
// deterministic (no Date, no randomness) for byte-stable tests. Simple
// entities only (lines, polylines, arcs, text).

import { SiteDesign } from './types';
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

export const DR2_LAYERS = {
  DETAIL: 'DR - DETAIL',
  WATER: 'DR - WATER',
  TEXT: 'DR - TEXT',
} as const;

const DR2_COLORS = {
  DETAIL: 3,   // green
  WATER: 5,    // blue
  TEXT: 7,
};

export const DRAINAGE_DETAIL_SHEET_TITLE = 'DRAINAGE DETAILS & ROUTING';

const fmt1 = (v: number) => v.toFixed(1);
const fmt2 = (v: number) => v.toFixed(2);
const fmt0 = (v: number) => Math.round(v).toLocaleString('en-US');

export function composeDrainageDetailSheetDxf(
  dxf: DxfWriter,
  design: SiteDesign,
  projectName: string,
  fg: FgSurface,
  model: DrainageModel,
  config?: BessConfiguration,
  meta?: TitleBlockMeta,
) {
  const d = model;
  const hasTc55 = d.discharges.some(dp => !!dp.tc55);
  const hasScs = !!d.scs;
  const hasRouting = !!d.routing;
  const hasCulverts = !!d.culverts && d.culverts.length > 0;
  const hasOutletCk = !!d.culverts?.some(c => !!c.outlet);

  // Schedule boxes in the right margin.
  const extraBoxes: Array<{ title: string; rows: string[] }> = [];
  if (hasTc55) {
    extraBoxes.push({
      title: `TR-55 TIME OF CONCENTRATION (P2=${fmt1(d.inputs.p2In)}", N=${fmt2(d.inputs.sheetFlowN)})`,
      rows: d.discharges.flatMap((dp, k) => dp.tc55 ? [
        `DP-${k + 1}  SHEET ${fmt1(dp.tc55.sheetMin)} + SHALLOW ${fmt1(dp.tc55.shallowMin)} + ` +
        `CHANNEL ${fmt1(dp.tc55.channelMin)} = ${fmt1(dp.tc55.totalMin)} MIN` +
        (dp.tc55.overridden ? ' (OVERRIDE)' : ''),
      ] : []),
    });
  } else {
    extraBoxes.push({
      title: 'TIME OF CONCENTRATION (KIRPICH SCREENING)',
      rows: d.discharges.map((dp, k) => `DP-${k + 1}  TC=${fmt1(dp.tcMin)} MIN  L=${fmt0(dp.longestPathFt)} FT`),
    });
  }
  if (hasScs) {
    const s = d.scs!;
    extraBoxes.push({
      title: `NRCS HYDROLOGY (TYPE ${s.stormType}, ${fmt1(s.rain24In)}" 24-HR)`,
      rows: [
        `POST CN=${Math.round(s.cn)}  Q=${fmt2(s.runoffIn)} IN  PEAK ${fmt1(s.sitePeakCfs)} CFS`,
        `PRE  CN=${Math.round(s.preDevCn)}  Q=${fmt2(s.preRunoffIn)} IN  PEAK ${fmt1(s.prePeakCfs)} CFS`,
        ...d.discharges.flatMap((dp, k) => dp.scs ? [
          `DP-${k + 1}  QP=${fmt1(dp.scs.peakCfs)} CFS AT ${fmt0(dp.scs.peakAtMin)} MIN  ` +
          `V=${fmt0(dp.scs.volumeCf)} CF`,
        ] : []),
      ],
    });
  }
  if (hasRouting) {
    const r = d.routing!;
    extraBoxes.push({
      title: 'LEVEL-POOL ROUTING (MODIFIED PULS)',
      rows: [
        `IN ${fmt1(r.peakInflowCfs)} CFS -> OUT ${fmt1(r.peakOutflowCfs)} CFS ` +
          `(ALLOW ${fmt1(r.allowableCfs)} CFS)${r.meetsRelease ? '' : ' — NOT MET'}`,
        `MAX STAGE ${fmt2(r.maxStageFt)} FT  STORAGE ${fmt0(r.maxStorageCf)} CF`,
        `FREEBOARD ${fmt2(r.freeboardFt)} FT  DRAWDOWN ${fmt1(r.drawdownHr)} HR`,
        `BASIN ${fmt0(r.bottomWFt)}x${fmt0(r.bottomLFt ?? r.bottomWFt)} FT BOT, D=${fmt1(r.depthFt)} FT, ` +
          `${r.sideSlopeH}:1${r.grownBasin ? ' (ENLARGED)' : ''}`,
        `OUTLET ${r.orificeDiaIn}" ORIFICE + ${fmt0(r.weirLengthFt)} FT WEIR AT ${fmt2(r.weirCrestFt)} FT`,
        ...(r.riserDiaIn ? [
          `STAGE 2: ${r.riserDiaIn}" RISER ORIFICE AT ${fmt2(r.riserCrestFt ?? 0)} FT`,
        ] : []),
      ],
    });
    extraBoxes.push({
      title: 'STAGE - STORAGE - DISCHARGE',
      rows: r.stageStorage.map(row =>
        `${fmt2(row.stageFt)} FT   ${fmt0(row.storageCf)} CF   ${fmt2(row.outflowCfs)} CFS`),
    });
  }
  if (hasCulverts) {
    extraBoxes.push({
      title: hasOutletCk ? 'CULVERTS (INLET VS OUTLET CONTROL)' : 'CULVERTS (HDS-5 INLET CONTROL)',
      rows: d.culverts!.map((c, i) => {
        if (c.outlet) {
          return `C-${i + 1}  ${c.diaIn}"  HWI=${fmt2(c.outlet.hwInletFt)} FT  ` +
            `HWO=${fmt2(c.outlet.hwOutletFt)} FT  ${c.outlet.controlling.toUpperCase()} CONTROL`;
        }
        return `C-${i + 1}  ${c.diaIn}" RCP  Q=${fmt1(c.qCfs)} CFS  HW/D=${fmt2(c.hwOverD)}`;
      }),
    });
  }

  addBaseLayers(dxf);
  addSheetFrame(dxf, design, projectName, config, meta, undefined, undefined, {
    panels: {
      siteInfo: true, equipDims: false, bom: false, legend: false,
      keyNotes: false, notes: false, disclaimer: true,
    },
    schedule: false,
    sheetLabel: 'SHEET DR-2',
    sheetTitle: DRAINAGE_DETAIL_SHEET_TITLE,
    extraBoxes,
  });

  // Annotation scale keyed to the parcel span (same rule as DR-1).
  const bxs = design.boundary.polygon.map(p => p.x);
  const bys = design.boundary.polygon.map(p => p.y);
  const minX = Math.min(...bxs), maxX = Math.max(...bxs);
  const minY = Math.min(...bys), maxY = Math.max(...bys);
  const span = Math.max(maxX - minX, maxY - minY, 400);
  const k = Math.min(Math.max(span / 1200, 0.5), 4);
  const H = 5 * k;

  dxf.addLayer(DR2_LAYERS.DETAIL, DR2_COLORS.DETAIL);
  dxf.addLayer(DR2_LAYERS.WATER, DR2_COLORS.WATER);
  dxf.addLayer(DR2_LAYERS.TEXT, DR2_COLORS.TEXT);

  // Detail diagrams drawn in a row across the parcel interior (the sheet is
  // a details sheet — the plan geometry stays on DR-1). Each panel is a
  // span-scaled cell anchored at the parcel's lower-left.
  const cellW = span * 0.30;
  const cellH = span * 0.26;
  const y0 = minY + span * 0.06;
  let colX = minX + span * 0.04;
  const nextCell = (): { x: number; y: number } => {
    const at = { x: colX, y: y0 };
    colX += cellW + span * 0.03;
    return at;
  };

  // --- Panel 1: channel typical section (from the worst swale run). ---
  {
    const at = nextCell();
    let worst = d.swales.length ? d.swales[0].section : null;
    for (const s of d.swales) {
      if (worst && s.section.depthFt > worst.depthFt) worst = s.section;
    }
    dxf.addText(at.x, at.y + cellH, H * 1.1, 'CHANNEL TYPICAL SECTION', DR2_LAYERS.TEXT);
    if (worst && worst.depthFt > 0) {
      const bw = worst.bottomWidthFt ?? 0;
      const tw = Math.max(worst.topWidthFt, bw + 0.1);
      const dDes = worst.depthFt;
      const dTot = dDes + d.inputs.freeboardFt;
      const zH = d.inputs.swaleSideSlopeH;
      const twTot = bw + 2 * zH * dTot;
      const sx = (cellW * 0.8) / Math.max(twTot, 1);
      const sy = (cellH * 0.55) / Math.max(dTot, 0.5);
      const cx0 = at.x + cellW / 2, gy = at.y + cellH * 0.62;
      // Ground line + channel cut (total depth incl. freeboard).
      const halfT = (twTot / 2) * sx;
      const halfB = (bw / 2) * sx;
      const yBot = gy - dTot * sy;
      dxf.addLine(at.x, gy, cx0 - halfT, gy, DR2_LAYERS.DETAIL);
      dxf.addLine(cx0 + halfT, gy, at.x + cellW, gy, DR2_LAYERS.DETAIL);
      dxf.addPolyline([
        [cx0 - halfT, gy], [cx0 - halfB, yBot], [cx0 + halfB, yBot], [cx0 + halfT, gy],
      ], DR2_LAYERS.DETAIL);
      // Design water surface.
      const halfW = ((bw + 2 * zH * dDes) / 2) * sx;
      const yWs = yBot + dDes * sy;
      dxf.addLine(cx0 - halfW, yWs, cx0 + halfW, yWs, DR2_LAYERS.WATER);
      dxf.addText(cx0 + halfW + H * 0.5, yWs, H * 0.8, `WS D=${fmt2(dDes)} FT`, DR2_LAYERS.TEXT);
      dxf.addText(at.x, at.y + cellH - H * 1.6, H * 0.8,
        `${d.inputs.channelShape.toUpperCase()}  ${zH}:1  N=${fmt2(d.inputs.manningN)}  ` +
        `S=${fmt2(d.inputs.swaleGradePct)}%  FB=${fmt1(d.inputs.freeboardFt)} FT`, DR2_LAYERS.TEXT);
      dxf.addText(cx0 - halfB, yBot - H * 1.2, H * 0.8,
        `V=${fmt1(worst.velocityFps)} FPS  Q=${fmt1(worst.capacityCfs)} CFS`, DR2_LAYERS.TEXT);
    } else {
      dxf.addText(at.x, at.y + cellH * 0.5, H * 0.9, 'NO SWALE RUNS', DR2_LAYERS.TEXT);
    }
  }

  // --- Panel 2: detention outlet structure detail (when routed). ---
  if (hasRouting) {
    const r = d.routing!;
    const at = nextCell();
    dxf.addText(at.x, at.y + cellH, H * 1.1, 'POND OUTLET STRUCTURE', DR2_LAYERS.TEXT);
    const sy = (cellH * 0.6) / Math.max(r.depthFt, 1);
    const yBot = at.y + cellH * 0.1;
    const xRiser = at.x + cellW * 0.45;
    const riserW = cellW * 0.12;
    // Basin bottom + top-of-bank lines.
    dxf.addLine(at.x, yBot, at.x + cellW * 0.9, yBot, DR2_LAYERS.DETAIL);
    const yTop = yBot + r.depthFt * sy;
    dxf.addLine(at.x, yTop, at.x + cellW * 0.9, yTop, DR2_LAYERS.DETAIL);
    dxf.addText(at.x, yTop + H * 0.4, H * 0.75, `TOP OF BANK ${fmt1(r.depthFt)} FT`, DR2_LAYERS.TEXT);
    // Riser box with weir crest.
    const yCrest = yBot + r.weirCrestFt * sy;
    dxf.addPolyline([
      [xRiser, yBot], [xRiser, yCrest], [xRiser + riserW, yCrest], [xRiser + riserW, yBot],
    ], DR2_LAYERS.DETAIL);
    dxf.addText(xRiser + riserW + H * 0.5, yCrest, H * 0.75,
      `WEIR CREST ${fmt2(r.weirCrestFt)} FT (L=${fmt0(r.weirLengthFt)} FT)`, DR2_LAYERS.TEXT);
    // Low-flow orifice circle on the riser face.
    const orifD = Math.max((r.orificeDiaIn / 12) * sy, H * 0.4);
    dxf.addArc(xRiser + riserW / 2, yBot + orifD / 2 + H * 0.2, orifD / 2, 0, Math.PI * 2, true, DR2_LAYERS.DETAIL);
    dxf.addText(xRiser + riserW + H * 0.5, yBot + H * 0.4, H * 0.75,
      `${r.orificeDiaIn}" ORIFICE (CD 0.60)`, DR2_LAYERS.TEXT);
    // Second-stage riser orifice (when configured).
    if (r.riserDiaIn && r.riserDiaIn > 0) {
      const y2 = yBot + (r.riserCrestFt ?? 0) * sy;
      const orifD2 = Math.max((r.riserDiaIn / 12) * sy, H * 0.4);
      dxf.addArc(xRiser + riserW / 2, y2 + orifD2 / 2 + H * 0.2, orifD2 / 2, 0, Math.PI * 2, true, DR2_LAYERS.DETAIL);
      dxf.addText(xRiser + riserW + H * 0.5, y2 + H * 1.4, H * 0.75,
        `${r.riserDiaIn}" STAGE-2 ORIFICE AT ${fmt2(r.riserCrestFt ?? 0)} FT`, DR2_LAYERS.TEXT);
    }
    // Routed max stage.
    const yStage = yBot + r.maxStageFt * sy;
    dxf.addLine(at.x, yStage, xRiser, yStage, DR2_LAYERS.WATER);
    dxf.addText(at.x, yStage + H * 0.3, H * 0.75,
      `ROUTED MAX STAGE ${fmt2(r.maxStageFt)} FT`, DR2_LAYERS.TEXT);
  }

  // --- Panel 3: culvert profile diagram (first culvert). ---
  if (hasCulverts) {
    const c = d.culverts![0];
    const at = nextCell();
    dxf.addText(at.x, at.y + cellH, H * 1.1, 'CULVERT PROFILE (C-1)', DR2_LAYERS.TEXT);
    const dFt = c.diaIn / 12;
    const L = c.lengthFt;
    const sx = (cellW * 0.6) / Math.max(L, 10);
    const sy = (cellH * 0.35) / Math.max(dFt * 2.5, 2);
    const xIn = at.x + cellW * 0.2, xOut = xIn + L * sx;
    const yInv = at.y + cellH * 0.25;
    const drop = (Math.max(d.inputs.swaleGradePct, 0.05) / 100) * L * sy;
    // Barrel (two lines, sloped).
    dxf.addLine(xIn, yInv, xOut, yInv - drop, DR2_LAYERS.DETAIL);
    dxf.addLine(xIn, yInv + dFt * sy, xOut, yInv - drop + dFt * sy, DR2_LAYERS.DETAIL);
    // Roadway hump above.
    dxf.addPolyline([
      [xIn - cellW * 0.1, yInv + dFt * sy * 2.2],
      [xIn + (xOut - xIn) / 2, yInv + dFt * sy * 2.6],
      [xOut + cellW * 0.1, yInv + dFt * sy * 2.2],
    ], DR2_LAYERS.DETAIL);
    // Headwater at the inlet.
    const hwFt = c.outlet
      ? Math.max(c.outlet.hwInletFt, c.outlet.hwOutletFt)
      : c.hwOverD * dFt;
    const yHw = yInv + hwFt * sy;
    dxf.addLine(xIn - cellW * 0.12, yHw, xIn, yHw, DR2_LAYERS.WATER);
    dxf.addText(at.x, yHw + H * 0.3, H * 0.75, `HW ${fmt2(hwFt)} FT`, DR2_LAYERS.TEXT);
    if (c.outlet) {
      // Tailwater at the outlet.
      const yTw = yInv - drop + c.outlet.tailwaterFt * sy;
      dxf.addLine(xOut, yTw, xOut + cellW * 0.12, yTw, DR2_LAYERS.WATER);
      dxf.addText(xOut - cellW * 0.05, at.y + cellH * 0.06, H * 0.75,
        `TW ${fmt2(c.outlet.tailwaterFt)} FT  ${c.outlet.controlling.toUpperCase()} CONTROL`, DR2_LAYERS.TEXT);
    }
    dxf.addText(xIn, yInv - H * 1.4, H * 0.75,
      `${c.diaIn}" RCP  L=${fmt0(L)} FT  Q=${fmt1(c.qCfs)} CFS`, DR2_LAYERS.TEXT);
  }

  // --- Panel 4: routed pond hydrographs (inflow vs outflow + stage trace),
  // drawn in a second row above the detail panels. HydroCAD-style chart:
  // vector polylines only, time axis in hours, flow on the left axis, stage
  // scaled to the same box against the right axis.
  if (hasRouting && hasScs) {
    const r = d.routing!;
    const hyd = d.scs!.hydrograph;
    const dtHr = hyd.dtMin / 60;
    const inflow = hyd.ordinatesCfs;
    const outflow = r.outflowCfs;
    const stageTr = r.stageTraceFt;
    const peakIn = Math.max(r.peakInflowCfs, 0.1);
    const peakOut = r.peakOutflowCfs;
    // Trim the plotted window: stop once inflow and outflow have both decayed
    // below 2% of their peaks and the pond is essentially drained.
    let lastIdx = 1;
    const n = Math.max(inflow.length, outflow.length, stageTr.length);
    for (let i = 0; i < n; i++) {
      const qi = inflow[i] ?? 0;
      const qo = outflow[i] ?? 0;
      const st = stageTr[i] ?? 0;
      if (qi > 0.02 * peakIn || qo > Math.max(0.02 * peakOut, 0.01) || st > 0.05) {
        lastIdx = i;
      }
    }
    lastIdx = Math.min(n - 1, lastIdx + 2);
    const tEndHr = Math.max(lastIdx * dtHr, 1);

    const chartX = minX + span * 0.04;
    const chartY = y0 + cellH + span * 0.08;
    const chartW = span * 0.56;
    const chartH = span * 0.24;
    dxf.addText(chartX, chartY + chartH + H * 1.2, H * 1.1,
      'ROUTED POND HYDROGRAPHS', DR2_LAYERS.TEXT);

    // Axes.
    dxf.addLine(chartX, chartY, chartX, chartY + chartH, DR2_LAYERS.DETAIL);
    dxf.addLine(chartX, chartY, chartX + chartW, chartY, DR2_LAYERS.DETAIL);
    const sxT = chartW / tEndHr;
    const syQ = chartH / (peakIn * 1.1);
    const stageMax = Math.max(r.maxStageFt, 0.1);
    const syS = chartH / (stageMax * 1.25);

    // Time ticks on a 1/2/3/6/12/24-hr ladder aiming for ~5-8 ticks.
    const tickLadder = [1, 2, 3, 6, 12, 24];
    let tickHr = tickLadder[tickLadder.length - 1];
    for (const t of tickLadder) {
      if (tEndHr / t <= 8) { tickHr = t; break; }
    }
    for (let t = tickHr; t <= tEndHr + 1e-9; t += tickHr) {
      const x = chartX + t * sxT;
      dxf.addLine(x, chartY, x, chartY - H * 0.6, DR2_LAYERS.DETAIL);
      dxf.addText(x - H * 0.8, chartY - H * 1.8, H * 0.7, `${fmt0(t)}`, DR2_LAYERS.TEXT);
    }
    dxf.addText(chartX + chartW / 2 - H * 3, chartY - H * 3.4, H * 0.8,
      'TIME (HR)', DR2_LAYERS.TEXT);

    // Flow ticks on a 1/2/5 ladder aiming for ~4-6 gridlines.
    let qTick = 1;
    while (peakIn / qTick > 6) {
      qTick *= (String(qTick)[0] === '1') ? 2 : (String(qTick)[0] === '2' ? 2.5 : 2);
    }
    for (let q = qTick; q <= peakIn * 1.1 + 1e-9; q += qTick) {
      const y = chartY + q * syQ;
      dxf.addLine(chartX - H * 0.6, y, chartX, y, DR2_LAYERS.DETAIL);
      dxf.addText(chartX - H * 0.8 - String(fmt0(q)).length * H * 0.6, y - H * 0.35,
        H * 0.7, fmt0(q), DR2_LAYERS.TEXT);
    }
    dxf.addText(chartX - H * 4.5, chartY + chartH + H * 0.4, H * 0.8,
      'Q (CFS)', DR2_LAYERS.TEXT);

    // Trace polylines (skip any non-finite ordinates defensively).
    const trace = (
      ords: number[], sy: number, layer: string,
    ) => {
      const pts: Array<[number, number]> = [];
      for (let i = 0; i <= lastIdx; i++) {
        const v = ords[i] ?? 0;
        if (!Number.isFinite(v)) continue;
        pts.push([chartX + i * dtHr * sxT, chartY + Math.max(0, v) * sy]);
      }
      if (pts.length >= 2) dxf.addPolyline(pts, layer);
    };
    trace(inflow, syQ, DR2_LAYERS.DETAIL);
    trace(outflow, syQ, DR2_LAYERS.WATER);
    trace(stageTr, syS, DR2_LAYERS.TEXT);

    // Legend + right-axis stage note.
    const lx = chartX + chartW + H;
    dxf.addLine(lx, chartY + chartH - H * 0.3, lx + H * 3, chartY + chartH - H * 0.3, DR2_LAYERS.DETAIL);
    dxf.addText(lx + H * 3.6, chartY + chartH - H * 0.65, H * 0.8,
      `INFLOW QP=${fmt1(r.peakInflowCfs)} CFS`, DR2_LAYERS.TEXT);
    dxf.addLine(lx, chartY + chartH - H * 2.3, lx + H * 3, chartY + chartH - H * 2.3, DR2_LAYERS.WATER);
    dxf.addText(lx + H * 3.6, chartY + chartH - H * 2.65, H * 0.8,
      `OUTFLOW QP=${fmt1(r.peakOutflowCfs)} CFS`, DR2_LAYERS.TEXT);
    dxf.addLine(lx, chartY + chartH - H * 4.3, lx + H * 3, chartY + chartH - H * 4.3, DR2_LAYERS.TEXT);
    dxf.addText(lx + H * 3.6, chartY + chartH - H * 4.65, H * 0.8,
      `STAGE (MAX ${fmt2(r.maxStageFt)} FT, RIGHT SCALE)`, DR2_LAYERS.TEXT);
    // Right-axis max-stage tick.
    const yStageMax = chartY + r.maxStageFt * syS;
    dxf.addLine(chartX + chartW, yStageMax, chartX + chartW + H * 0.6, yStageMax, DR2_LAYERS.TEXT);
    dxf.addText(chartX + chartW + H * 0.8, yStageMax - H * 0.35, H * 0.7,
      `${fmt2(r.maxStageFt)} FT`, DR2_LAYERS.TEXT);
  }

  // Screening disclaimer south of the panels.
  dxf.addText(minX, minY - H * 4, H * 0.9, d.disclaimer, LAYERS.TEXT_SM);
  if (hasScs) {
    dxf.addText(minX, minY - H * 6, H * 0.9,
      `NRCS HYDROLOGY: SCS TYPE ${d.scs!.stormType} 24-HR, ${fmt1(d.scs!.rain24In)} IN, ` +
      'DIMENSIONLESS UNIT HYDROGRAPH (PRF 484), LAG = 0.6 TC.',
      LAYERS.TEXT_SM);
  }
}

export function buildDrainageDetailSheetDxfString(
  design: SiteDesign,
  projectName: string,
  fg: FgSurface,
  model: DrainageModel,
  config?: BessConfiguration,
  meta?: TitleBlockMeta,
): string {
  const dxf = new DxfWriter();
  composeDrainageDetailSheetDxf(dxf, design, projectName, fg, model, config, meta);
  return dxf.toString();
}
