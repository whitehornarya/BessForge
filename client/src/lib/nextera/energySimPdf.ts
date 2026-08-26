// Client-side PDF export of the energy/dispatch simulation report
// (jsPDF + autotable). One page, letter portrait, ECI-branded header:
// RTE loss chain at the AC PoC, year-by-year degradation + augmentation
// table, zone-capacity check, and the model citations verbatim from the
// pure math module. Strictly opt-in — never part of any default export.
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import { EnergySimResult, EnergySimInputs } from './energySim';
import { TitleBlockInfo } from '../stores/useDesignStore';

export interface EnergySimPdfMeta {
  titleBlock: TitleBlockInfo;
  configLabel: string;
  achievedMW: number;
  achievedMWh: number;
  containers: number;
}

// Compact vector line chart: usable MWh vs. project year, contract line,
// augmentation step-up markers. Pure jsPDF primitives (lines/text only) so
// the report stays deterministic; always plots EVERY year even when the
// table above is condensed to milestone rows.
function drawCapacityChart(
  doc: jsPDF,
  result: EnergySimResult,
  x: number,
  y: number,
  w: number,
  h: number
): void {
  const years = result.years;
  if (years.length === 0) return;
  const contract = years[0].contractMWh;
  const padL = 46; // room for y-axis tick labels
  const padR = 8;
  const padT = 14; // title band
  const padB = 16; // x-axis labels
  const px = x + padL, py = y + padT;
  const pw = w - padL - padR, ph = h - padT - padB;

  // Y range: usable values plus the contract line, padded, tick-snapped.
  // Off-scale clipping: when the contract sits far below the fleet's
  // usable-energy band (< 50% of BOL), including it in the scale would
  // compress the degradation curve into a thin band at the top. In that
  // case the axis zooms to the usable range only and the contract line is
  // pinned at the bottom edge with an explicit "below scale" note so the
  // hidden value is never silent.
  const bolMWh = Math.max(...years.map(yr => yr.usableMWh));
  const contractOffScale = contract > 0 && contract < 0.5 * bolMWh;
  const vals = years.map(yr => yr.usableMWh);
  if (contract > 0 && !contractOffScale) vals.push(contract);
  let vMin = Math.min(...vals), vMax = Math.max(...vals);
  if (vMax - vMin < 1e-9) { vMax += 1; vMin -= 1; }
  const span = vMax - vMin;
  vMin = Math.max(0, vMin - span * 0.08);
  vMax = vMax + span * 0.08;
  // Nice tick step: 1/2/5 ladder aiming for ~4 gridlines.
  const rawStep = (vMax - vMin) / 4;
  const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
  const norm = rawStep / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  vMin = Math.floor(vMin / step) * step;
  vMax = Math.ceil(vMax / step) * step;

  const nYears = years.length;
  const sx = (yr: number) => px + ((yr - 1) / Math.max(1, nYears - 1)) * pw;
  const sy = (v: number) => py + ph - ((v - vMin) / (vMax - vMin)) * ph;

  // Title
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7.5);
  doc.setTextColor(30, 41, 59);
  doc.text('Usable Energy vs. Project Year', x, y + 8);
  doc.setTextColor(0);

  // Plot frame + horizontal gridlines with tick labels
  doc.setDrawColor(203, 213, 225);
  doc.setLineWidth(0.5);
  doc.rect(px, py, pw, ph);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(6);
  doc.setTextColor(100);
  for (let v = vMin; v <= vMax + 1e-9; v += step) {
    const gy = sy(v);
    if (v > vMin && v < vMax) {
      doc.setDrawColor(226, 232, 240);
      doc.line(px, gy, px + pw, gy);
    }
    doc.text(v.toLocaleString(undefined, { maximumFractionDigits: 0 }), px - 4, gy + 2, { align: 'right' });
  }
  // X-axis ticks: year 1, every 5th, final year.
  for (let yr = 1; yr <= nYears; yr++) {
    if (yr === 1 || yr === nYears || yr % 5 === 0) {
      doc.text(String(yr), sx(yr), py + ph + 9, { align: 'center' });
    }
  }
  doc.text('Year', px + pw / 2, py + ph + 15, { align: 'center' });
  doc.setTextColor(0);

  // Contract requirement: dashed horizontal line. Off-scale contracts are
  // pinned at the bottom plot edge with a down-arrow and an explicit
  // "below scale" note so the clipped value is never hidden silently.
  if (contract > 0) {
    doc.setDrawColor(180, 40, 40);
    doc.setLineWidth(0.8);
    doc.setLineDashPattern([3, 2], 0);
    const cy = contractOffScale ? py + ph : sy(contract);
    doc.line(px, cy, px + pw, cy);
    doc.setLineDashPattern([], 0);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(6);
    doc.setTextColor(180, 40, 40);
    const contractLabel = contractOffScale
      ? `\u2193 Contract ${contract.toLocaleString(undefined, { maximumFractionDigits: 0 })} MWh (below scale \u2014 axis zoomed to usable range)`
      : `Contract ${contract.toLocaleString(undefined, { maximumFractionDigits: 0 })} MWh`;
    doc.text(contractLabel, px + pw - 2, cy - 3, { align: 'right' });
    doc.setTextColor(0);
  }

  // Usable-energy polyline. Augmentation installs at the START of a year,
  // so a step-up shows as a vertical riser from the prior year's end value.
  doc.setDrawColor(29, 78, 137);
  doc.setLineWidth(1);
  let prevX = sx(1), prevY = sy(years[0].usableMWh);
  for (let i = 1; i < nYears; i++) {
    const cx = sx(years[i].year), cyv = sy(years[i].usableMWh);
    doc.line(prevX, prevY, cx, cyv);
    prevX = cx; prevY = cyv;
  }

  // Augmentation-year markers: filled triangles under the curve point.
  doc.setFillColor(180, 100, 10);
  for (const yr of years) {
    if (yr.augAddedContainers > 0) {
      const mx = sx(yr.year), my = sy(yr.usableMWh);
      doc.triangle(mx, my - 4.5, mx - 3, my + 1.5, mx + 3, my + 1.5, 'F');
    }
  }

  // Legend (single line under the title, right-aligned).
  doc.setFontSize(6);
  doc.setTextColor(100);
  const legend = 'Usable MWh (end of year)' + (contract > 0 ? '  \u00B7  dashed: contract  \u00B7  markers: augmentation years' : '');
  doc.text(legend, x + w, y + 8, { align: 'right' });
  doc.setTextColor(0);
}

export function buildEnergySimPdf(
  result: EnergySimResult,
  inputs: EnergySimInputs,
  meta: EnergySimPdfMeta
): jsPDF {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'letter' });
  const pageW = doc.internal.pageSize.getWidth();
  const margin = 40;

  // Header
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(15);
  doc.text('BESS Energy & Dispatch Simulation', margin, 46);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  doc.setTextColor(90);
  doc.text('IEC 62933-2-1 AC point-of-connection efficiency \u00B7 NREL semi-empirical degradation \u00B7 augmentation planning', margin, 59);
  doc.setTextColor(0);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.text('ECI', pageW - margin, 46, { align: 'right' });
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7.5);
  doc.setTextColor(90);
  doc.text(`Generated ${new Date().toISOString().slice(0, 10)}`, pageW - margin, 57, { align: 'right' });
  doc.setTextColor(0);

  const tb = meta.titleBlock;
  const fmt1 = (v: number) => v.toLocaleString(undefined, { maximumFractionDigits: 1 });
  autoTable(doc, {
    startY: 70,
    body: [
      ['Project', tb.projectName || '\u2014', 'Configuration', meta.configLabel],
      ['Plant rating', `${fmt1(meta.achievedMW)} MW / ${fmt1(meta.achievedMWh)} MWh BOL (${meta.containers} containers)`,
        'Dispatch', `${inputs.cyclesPerDay} cycle(s)/day @ ${inputs.dodPct}% DOD, ${inputs.projectLifeYears}-yr horizon`],
      ['Contract energy', inputs.contractMWh > 0 ? `${fmt1(inputs.contractMWh)} MWh usable` : '\u2014 (no augmentation planning)',
        'Avg site ambient', `${inputs.avgAmbientC} \u00B0C`],
    ],
    theme: 'grid',
    styles: { fontSize: 7.5, cellPadding: 3 },
    columnStyles: {
      0: { fontStyle: 'bold', cellWidth: 78, fillColor: [240, 243, 246] },
      1: { cellWidth: 188 },
      2: { fontStyle: 'bold', cellWidth: 78, fillColor: [240, 243, 246] },
      3: { cellWidth: 188 },
    },
    margin: { left: margin, right: margin },
  });

  // RTE loss chain
  const r = result.rte;
  let y = (doc as any).lastAutoTable.finalY + 12;
  autoTable(doc, {
    startY: y,
    head: [[{ content: 'Round-Trip Efficiency at the AC Point of Connection (IEC 62933-2-1, incl. auxiliaries)', colSpan: 4, styles: { fillColor: [30, 41, 59], fontSize: 8.5 } }],
      ['Stage', 'Value', 'Stage', 'Value']],
    body: [
      ['Battery DC-DC round trip', `${r.batteryRteDcPct.toFixed(1)}%`, 'PCS (per direction, CEC)', `${r.pcsOneWayPct.toFixed(1)}%`],
      ['MV transformer (per direction)', `${r.xfmrOneWayPct.toFixed(1)}%`, 'MV collection cable (per direction)', `${r.cableOneWayPct.toFixed(2)}%`],
      ['Auxiliary (HVAC + controls)', `${r.dailyAuxMWh.toFixed(2)} MWh/day (${r.auxPct.toFixed(1)}% of charge)`, 'AC RTE excl. aux (reference)', `${r.acRteExAuxPct.toFixed(1)}%`],
      [{ content: 'SYSTEM RTE AT AC PoC (incl. aux)', styles: { fontStyle: 'bold' } }, { content: `${r.acRtePct.toFixed(1)}%`, styles: { fontStyle: 'bold' } },
        'Daily charge / discharge', `${r.dailyChargeMWh.toFixed(1)} / ${r.dailyDischargeMWh.toFixed(1)} MWh`],
    ],
    theme: 'grid',
    styles: { fontSize: 7.5, cellPadding: 3 },
    headStyles: { fillColor: [51, 65, 85], fontSize: 7.5 },
    columnStyles: { 0: { cellWidth: 152 }, 1: { cellWidth: 114 }, 2: { cellWidth: 152 }, 3: { cellWidth: 114 } },
    margin: { left: margin, right: margin },
  });

  // Degradation + augmentation year table. The report is strictly one
  // page: horizons beyond 25 years are condensed to milestone rows
  // (year 1, every 5th year, every augmentation year, final year) so the
  // table can never paginate.
  const MAX_FULL_YEARS = 25;
  const condensed = result.years.length > MAX_FULL_YEARS;
  const tableYears = condensed
    ? result.years.filter(yr =>
        yr.year === 1 ||
        yr.year === result.years.length ||
        yr.year % 5 === 0 ||
        yr.augAddedContainers > 0)
    : result.years;
  y = (doc as any).lastAutoTable.finalY + 12;
  autoTable(doc, {
    startY: y,
    head: [[{ content: `Capacity Degradation & Augmentation Plan${condensed ? ' (milestone years shown)' : ''}`, colSpan: 6, styles: { fillColor: [30, 41, 59], fontSize: 8.5 } }],
      ['Year', 'Fleet SOH', 'Usable MWh', 'Augmentation', 'AC discharge MWh/yr', 'EFC/yr']],
    body: tableYears.map(yr => [
      String(yr.year),
      `${yr.sohPct.toFixed(1)}%`,
      fmt1(yr.usableMWh),
      yr.augAddedContainers > 0 ? `+${fmt1(yr.augAddedMWh)} MWh (${yr.augAddedContainers} cont.)` : '\u2014',
      fmt1(yr.dischargedMWh),
      String(Math.round(yr.efc)),
    ]),
    theme: 'grid',
    styles: { fontSize: 6.8, cellPadding: 1.8, halign: 'right' },
    headStyles: { fillColor: [51, 65, 85], fontSize: 7, halign: 'right' },
    columnStyles: { 0: { halign: 'left', cellWidth: 40 } },
    didParseCell: data => {
      if (data.section === 'body' && data.column.index === 3 && String(data.cell.raw) !== '\u2014') {
        data.cell.styles.textColor = [180, 100, 10];
        data.cell.styles.fontStyle = 'bold';
      }
    },
    margin: { left: margin, right: margin },
  });

  // Capacity curve chart: full-resolution year-by-year usable energy vs.
  // the contract line, with augmentation step-ups marked. Height flexes
  // down on long horizons so the page can never overflow.
  y = (doc as any).lastAutoTable.finalY + 10;
  const chartH = condensed ? 118 : Math.max(78, 118 - (result.years.length - 20) * 8);
  drawCapacityChart(doc, result, margin, y, pageW - 2 * margin, chartH);
  y += chartH + 10;

  // Augmentation-zone capacity check
  doc.setFontSize(8);
  doc.setFont('helvetica', 'bold');
  const zoneMsg = result.totalAddedContainers === 0
    ? 'No augmentation required over the simulated horizon.'
    : `Augmentation total: ${result.totalAddedContainers} container(s) / ${fmt1(result.totalAddedMWh)} MWh nameplate. ` +
      `Reserved augmentation zones hold ${result.zoneCapacityContainers} container(s) \u2014 ` +
      (result.zonesSufficient ? 'SUFFICIENT.' : 'INSUFFICIENT: reserve more augmentation area (increase the augmentation % in the layout).');
  const zoneRgb: [number, number, number] = result.zonesSufficient ? [22, 100, 52] : [180, 40, 40];
  doc.setTextColor(zoneRgb[0], zoneRgb[1], zoneRgb[2]);
  y += 2;
  const zoneLines = doc.splitTextToSize(zoneMsg, pageW - 2 * margin);
  doc.text(zoneLines, margin, y);
  y += zoneLines.length * 9 + 6;
  doc.setTextColor(0);

  // Model notes / citations
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7.5);
  doc.text('Model basis & assumptions', margin, y);
  y += 8;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(6.5);
  doc.setTextColor(80);
  for (const note of result.notes) {
    const lines = doc.splitTextToSize(`\u2022 ${note}`, pageW - 2 * margin);
    doc.text(lines, margin, y);
    y += lines.length * 7.2 + 2;
  }
  doc.setTextColor(0);

  // Footer
  const pageH = doc.internal.pageSize.getHeight();
  doc.setFontSize(7);
  doc.setTextColor(120);
  doc.text('BESSForge \u00B7 Energy & Dispatch Simulation \u00B7 Screening grade \u2014 verify against OEM warranty and offtake agreement', margin, pageH - 24);
  const pageCount = doc.getNumberOfPages();
  doc.text(`Page ${pageCount} of ${pageCount}`, pageW - margin, pageH - 24, { align: 'right' });
  doc.setTextColor(0);
  return doc;
}
