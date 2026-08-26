// Permitting & compliance packet PDF (letter portrait, jsPDF + autotable).
// County-submittal presentation: branded cover with vector site-plan key map,
// table of contents with page numbers, NFPA 855 setback tables, fire-access
// verification, reserved-area disclosures, equipment schedule, and a
// warnings/exceptions appendix.
//
// All table content comes from permitPacketSections(model) — a pure function
// of the report model — so the regression suite can pin the exact text the
// PDF renders without parsing PDF bytes.
import { finalizePdfBlob } from './pdfIdentity';
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import { saveBlob } from '../saveFile';
import { SiteDesign } from './types';
import {
  DxfWriter, addBaseLayers, LAYERS,
  drawBoundaryAndFence, drawEquipmentFootprints, drawRoads, drawGate, ftIn,
} from './dxfExport';
import { PermitPacketModel, PermitTableRow, PermitException } from './permitReport';
import { PROPERTY_LINE_FIGURE_RGB, showSeparateFence } from './propertyLineColor';
import { FindingStatus } from './complianceReport';
import type { DrawingVisibilityProfile } from './drawingVisibility';

// ---------------------------------------------------------------------------
// Pure content layer: every table the PDF renders, as plain string rows.
// ---------------------------------------------------------------------------
export interface PacketTable {
  id: string;
  title: string;
  intro: string;      // one-paragraph section preamble
  head: string[];
  rows: string[][];
  statusCol?: number; // column index carrying PASS/WARN/FAIL coloring
}

const STATUS_LABEL: Record<FindingStatus, string> = { PASS: 'PASS', WARN: 'WARN', FAIL: 'FAIL' };

function ruleRows(rows: PermitTableRow[]): string[][] {
  return rows.map(r => [r.item, r.requirement, r.measured, STATUS_LABEL[r.status], r.reference]);
}

// Deterministic across machines/locales: fixed en-US grouping.
const cy = (v: number) => `${Math.round(v).toLocaleString('en-US')} CY`;

// Screening-grade rough-grading summary rows (only when elevation data is
// loaded). Number formatting matches the control-panel card exactly.
function earthworkRows(ew: NonNullable<PermitPacketModel['earthwork']>): string[][] {
  const cf = ew.cutFill;
  const rows: string[][] = [
    ['Graded pad elevation', `${cf.padElevationFt.toFixed(1)} ft (median existing ground inside the fence)`],
    ['Existing ground range', `${cf.minElevFt.toFixed(0)}–${cf.maxElevFt.toFixed(0)} ft inside the fenced yard`],
    ['Estimated cut', cy(cf.cutCY)],
    ['Estimated fill', cy(cf.fillCY)],
    [`Net earthwork ${cf.netCY >= 0 ? '(import)' : '(export)'}`, cy(Math.abs(cf.netCY))],
    ...(ew.tieIn
      ? [
          ['Max cut at pad edge', ew.tieIn.maxCutFt > 0
            ? `${ew.tieIn.maxCutFt.toFixed(1)} ft below existing ground at the fence line`
            : 'None — pad meets or sits above existing ground along the fence line'],
          ['Max fill at pad edge', ew.tieIn.maxFillFt > 0
            ? `${ew.tieIn.maxFillFt.toFixed(1)} ft above existing ground at the fence line`
            : 'None — pad meets or sits below existing ground along the fence line'],
          ['Grading tie-in slopes', `${ew.tieIn.slopeRatio}:1 (H:V) daylight slopes assumed from the pad edge to existing grade`],
        ]
      : []),
    ['Graded area', `${(cf.areaSqFt / 43560).toFixed(2)} acres (${cf.sampleSpacingFt.toFixed(1)} ft sample grid)`],
    ['Elevation data source', `${ew.source}, ~${ew.resolutionM} m cells`],
    ['No-data disclosure', ew.noDataCount > 0
      ? `${ew.noDataCount} no-data cell(s) filled from nearest neighbors — verify coverage before relying on this estimate`
      : 'Full elevation coverage — no no-data cells'],
  ];
  if (ew.steep) {
    rows.push(['Steep-zone screening threshold', `${ew.steep.thresholdPct}% existing grade`]);
    rows.push(['Max existing grade under equipment/roads', `${ew.steep.maxSlopePct.toFixed(1)}%`]);
    rows.push(['Steep-zone findings', ew.steep.items.length
      ? ew.steep.items.map(i => `${i.label} — ${i.slopePct.toFixed(1)}% grade`).join('; ')
      : `None — all checked equipment and roads sit on existing grades at or below ${ew.steep.thresholdPct}%`]);
  } else {
    rows.push(['Steep-zone screening', 'Not evaluated']);
  }
  return rows;
}

// Grounding screening takeoff rows — quantities verbatim from the same
// GroundingPlan summary the panel card and DXF layer use (nothing recomputed).
function groundingRows(g: NonNullable<PermitPacketModel['grounding']>): string[][] {
  const s = g.summary;
  const lf = (v: number) => `${Math.round(v).toLocaleString('en-US')} LF`;
  return [
    ['Perimeter ground loop', `${lf(s.loopLengthFt)} bare copper conductor, confined to the BESS island envelope`],
    ['Interior grid conductors', `${lf(s.gridLengthFt)} — row/column runs along the container lattice, tied to the perimeter loop`],
    ['Ground rods', `${s.rodCount} rods — loop corners, gate, and max ${s.rodSpacingFt} ft spacing along the loop`],
    ['Test wells', `${s.testWellCount} inspection wells at ~200 ft intervals along the perimeter loop`],
    ['Grid crossing connections', `${s.crossingCount} exothermic (cadweld) connections at interior lattice crossings`],
    ['Equipment bonding taps', `${s.tapCount} taps (${lf(s.tapLengthFt)}) — multi-point container/PCS bonds to the nearest buried conductor`],
    ['Total grounding conductor', lf(s.totalConductorFt)],
    ['Grid area enclosed by loop', `${(s.gridAreaSqFt / 43560).toFixed(2)} acres`],
  ];
}

// IEEE-80 study rows — every value verbatim from the same Ieee80Study the
// panel card shows (nothing recomputed here). Status column drives the
// PASS/FAIL coloring the compliance tables use.
function ieee80Rows(st: NonNullable<PermitPacketModel['ieee80']>): string[][] {
  const i = st.inputs;
  const v = (x: number, d = 1) => x.toFixed(d);
  const pf = (ok: boolean) => (ok ? 'PASS' : 'FAIL');
  return [
    ['Soil resistivity ρ (uniform model)', `${v(i.soilRhoOhmM, 0)} Ω·m`, '', 'Input'],
    ['Surface layer', i.surfaceThicknessM > 0
      ? `${v(i.surfaceRhoOhmM, 0)} Ω·m crushed rock, ${(i.surfaceThicknessM * 39.3701).toFixed(1)} in thick (Cs = ${v(st.cs, 3)})`
      : 'None (Cs = 1.000)', '', 'Input'],
    ['Ground fault current 3I0 / clearing time', `${v(i.faultCurrentA, 0)} A / ${v(i.faultDurationS, 2)} s`, '', 'Input'],
    ['Current division Sf / decrement Df (X/R = ' + v(i.xOverR, 1) + ')', `${v(i.splitFactorSf, 2)} / ${v(st.df, 3)}`, '', 'Input'],
    ['Grid current IG = Df · Sf · 3I0', `${v(st.igA, 0)} A`, '', 'Eq. 68/79'],
    ['Grid resistance Rg', `${v(st.rgOhm, 3)} Ω`, '', st.geometry.rodCount > 0 ? 'Eqs. 63–65 (Schwarz)' : 'Eq. 57 (Sverak)'],
    ['Ground potential rise (GPR)', `${v(st.gprV, 0)} V`, '', 'IG × Rg'],
    [`Tolerable touch voltage (${i.bodyWeightKg} kg)`, `${v(st.etouchV, 1)} V`, '', 'Eqs. 32/33'],
    [`Tolerable step voltage (${i.bodyWeightKg} kg)`, `${v(st.estepV, 1)} V`, '', 'Eqs. 29/30'],
    ['Mesh (touch) voltage Em', `${v(st.emV, 1)} V`, pf(st.touchPass), 'Eqs. 80–89'],
    ['Step voltage Es', `${v(st.esV, 1)} V`, pf(st.stepPass), 'Eqs. 92–94'],
    ['Grid conductor thermal sizing', `${v(i.conductorKcmil, 1)} kcmil installed vs ${v(st.requiredKcmil, 1)} kcmil required`, pf(st.conductorOk), 'Eq. 37'],
    ['Overall result', st.overallPass ? 'Grid design PASSES IEEE 80 screening criteria' : 'Grid design FAILS — see remediation notes', pf(st.overallPass), 'IEEE Std 80-2013'],
  ];
}

export function permitPacketSections(model: PermitPacketModel): PacketTable[] {
  const s = model.site;
  const p = model.project;
  const siteRows: string[][] = [
    ['Project name', p.projectName || '—'],
    ['Location', s.locationText || '—'],
    ['Site coordinates', `${s.originLat.toFixed(5)}°, ${s.originLon.toFixed(5)}°`],
    ['Parcel area', `${s.parcelAreaAcres.toFixed(2)} acres`],
    ['System configuration', p.configLabel],
    ['Climate design basis', p.hotClimate ? 'Hot climate (>40 °C ambient)' : 'Standard (<40 °C ambient)'],
    ['Credited battery-backed output', `${p.achievedMW.toFixed(1)} MW / ${p.achievedMWh.toFixed(0)} MWh`],
    ['Target rating', `${p.targetMW} MW / ${p.targetMWh} MWh`],
    ['BESS blocks', `${p.blocksPlaced} placed of ${p.blocksRequired} required`],
    ['BESS containers', `${s.containerCount} — LG JF2 DC LINK 5.1 (5.1 MWh each)`],
    ['PCS inverter units', `${s.inverterCount}`],
    ['Auxiliary power equipment', s.auxTransformerCount + s.auxSwitchgearCount > 0
      ? `${s.auxTransformerCount} aux transformer(s), ${s.auxSwitchgearCount} aux switchgear`
      : 'None (configuration without dedicated aux equipment)'],
    ['Site access', s.gateWidthFt ? `${s.gateWidthFt.toFixed(0)} ft gate, ${s.roadSegmentCount} road segment(s)` : 'No gate placed'],
    ['Yard surfacing', s.surfacing
      ? `Crushed rock, ${s.surfacing.depthIn}" depth — ${s.surfacing.areaAcres.toFixed(2)} AC (${s.surfacing.tons} tons), ${s.surfacing.mode === 'full-yard' ? 'full yard' : 'between roads'}`
      : 'Not included in this design'],
    ['Prepared by', p.drafter || '—'],
    ['Revision / date', `${p.revision} / ${p.date || '—'}`],
  ];

  const tables: PacketTable[] = [
    {
      id: 'site-data',
      title: 'Project & Site Data',
      intro: model.siteAreas
        ? `Summary of the proposed battery energy storage system (BESS) across all ${model.siteAreas.areaCount} area(s) of this site. All quantities are generated from the site design model and match the accompanying drawing package exactly. Figures below are whole-site totals; the per-area breakdown follows in the next section.`
        : 'Summary of the proposed battery energy storage system (BESS) and host parcel. All quantities are generated from the site design model and match the accompanying drawing package exactly.',
      head: ['Item', 'Value'],
      rows: siteRows,
    },
    // Multi-area sites only: which yards this packet covers, what each one
    // contributes, and — critically — which ones are NOT covered at all.
    // Absent on a single-area project, so its packet is byte-identical.
    ...(model.siteAreas ? [{
      id: 'site-areas',
      title: 'Site Areas Covered by This Packet',
      intro: model.siteAreas.uncheckedAreas.length
        ? `This site comprises ${model.siteAreas.areaCount} area(s). INCOMPLETE SUBMITTAL: ${model.siteAreas.uncheckedAreas.length} area(s) have no generated layout and are NOT covered by any section of this packet — ${model.siteAreas.uncheckedAreas.join(', ')}. Every other section aggregates only the areas listed as covered below.`
        : `This site comprises ${model.siteAreas.areaCount} area(s), all of which are covered by this packet. Every following section aggregates all areas, with each row identified by the area it was measured in.`,
      head: ['Area', 'Type', 'Parcel', 'Capacity', 'Blocks', 'Containers / PCS', 'Compliance'],
      rows: model.siteAreas.perArea.map(a => [
        a.name,
        a.kind === 'substation' ? 'Substation (civil only)' : 'BESS',
        `${a.acres.toFixed(2)} AC`,
        a.generated ? `${a.achievedMW.toFixed(1)} MW / ${a.achievedMWh.toFixed(0)} MWh` : '—',
        a.generated ? String(a.blocksPlaced) : '—',
        a.generated ? `${a.containerCount} / ${a.inverterCount}` : '—',
        a.generated ? `${a.passCount}P / ${a.warnCount}W / ${a.failCount}F` : 'NOT COVERED',
      ]),
    } as PacketTable] : []),
    // Access-road capacity shortfalls: disclosed as a dedicated table so a
    // permit reviewer sees the exact per-area gap without digging through the
    // exceptions appendix. Absent on single-area and fully compliant sites —
    // the packet is byte-identical when there are no shortfalls.
    ...(model.siteAreas?.capacityShortfalls.length ? [{
      id: 'road-capacity-shortfalls',
      title: 'Access-Road Capacity Shortfalls',
      intro: 'The following BESS areas retained access roads but could not meet the requested capacity within the available footprint. The requested and achieved ratings are shown below; the recommended next action is to increase the phase footprint or reduce the target rating for the affected area.',
      head: ['Area', 'Requested MW', 'Requested MWh', 'Achieved MW', 'Achieved MWh', 'Shortfall MW', 'Shortfall MWh'],
      rows: model.siteAreas.capacityShortfalls.map(sf => [
        sf.name,
        sf.requestedMW.toFixed(1),
        sf.requestedMWh.toFixed(0),
        sf.achievedMW.toFixed(1),
        sf.achievedMWh.toFixed(0),
        (sf.requestedMW - sf.achievedMW).toFixed(1),
        (sf.requestedMWh - sf.achievedMWh).toFixed(0),
      ]),
    } as PacketTable] : []),
    {
      id: 'nfpa-setbacks',
      title: 'NFPA 855 Setback & Clearance Compliance',
      intro: 'Required versus measured separation distances for every governing setback and clearance. Measured values are computed 1:1 from the layout geometry shown on the site plan; a FAIL row indicates the design requires an alternate compliance path approved by the AHJ.',
      head: ['Setback / clearance', 'Requirement', 'Measured', 'Status', 'Reference'],
      rows: ruleRows(model.nfpaSetbacks),
      statusCol: 3,
    },
    {
      id: 'fire-access',
      title: 'Fire Apparatus Access',
      intro: 'Verification of emergency-vehicle access provisions: road widths, turning radii, equipment offsets from road edges, network connectivity, and gated site entry.',
      head: ['Access provision', 'Requirement', 'Measured', 'Status', 'Reference'],
      rows: ruleRows(model.fireAccess),
      statusCol: 3,
    },
    {
      id: 'reserved-areas',
      title: 'Reserved Area Disclosures',
      intro: 'Areas within the fenced yard reserved for construction staging or future capacity augmentation. No beginning-of-life conduit is routed inside reserved exclusion zones.',
      head: ['Reserved area', 'Basis', 'Provision', 'Status', 'Reference'],
      rows: ruleRows(model.reservedAreas),
      statusCol: 3,
    },
    {
      id: 'equipment-schedule',
      title: 'Equipment Schedule',
      intro: 'Principal equipment and material quantities for the proposed facility (matches the bill of materials on the drawing package).',
      head: ['Qty', 'Unit', 'Description'],
      rows: model.equipmentSchedule.map(r => [String(r.qty), r.unit, r.description]),
    },
    {
      id: 'trench-sections',
      title: 'Typical Trench Sections',
      intro: 'Typical underground trench cross-sections per the issued trench detail sheets CAR-D-B006-1 and CAR-D-B006-2 (screening-grade — construction sections, bedding and crossing details per the issued drawings). Plan-view trench routes on the site plan follow these typical sections.',
      head: ['Section', 'Width', 'Depth', 'Installation notes', 'Used in design', 'Reference'],
      rows: model.trenchSections.map(t => [
        t.spec.title,
        ftIn(t.spec.widthFt),
        ftIn(t.spec.depthFt),
        t.spec.notes,
        t.inDesign,
        t.spec.reference,
      ]),
    },
  ];
  // Optional rough-grading section: included only when elevation data was
  // loaded in the session. Placed before the exceptions appendix; sections
  // are renumbered below so the packet stays identical when it is absent.
  if (model.earthwork) {
    tables.push({
      id: 'earthwork',
      title: 'Rough Grading & Earthwork — Screening Only',
      intro: 'SCREENING ONLY — NOT FOR CONSTRUCTION. Preliminary cut/fill estimate assuming a single flat pad at the elevation minimizing total earthwork (median of existing ground inside the fence), with vertical cuts at the fence line and no benching, shrink or swell factors. Derived from public-domain elevation data; a licensed engineer must prepare the grading design.',
      head: ['Item', 'Value'],
      rows: earthworkRows(model.earthwork),
    });
  }
  // Optional grounding screening section (opt-in, mirrors the DXF grounding
  // layer opt-in). Sections are renumbered below, so the packet stays
  // identical when it is absent.
  if (model.grounding) {
    tables.push({
      id: 'grounding',
      title: 'Grounding System — Screening Takeoff',
      intro: 'SCREENING ONLY — NOT FOR CONSTRUCTION. Conductor-quantity takeoff for a perimeter ground loop with driven rods and equipment bonding taps, generated 1:1 from the site layout. This is not an IEEE 80 grid study: touch/step potentials, soil resistivity and conductor sizing are detailed-design scope for the Engineer of Record.',
      head: ['Item', 'Value'],
      rows: groundingRows(model.grounding),
    });
  }
  // Optional IEEE-80 grid study section (opt-in, requires the grounding
  // section's plan geometry). Same renumbering convention — the packet stays
  // byte-identical when the study is not enabled.
  if (model.ieee80) {
    tables.push({
      id: 'ieee80',
      title: 'Grounding Grid Study — IEEE Std 80-2013',
      intro: 'Screening-grade grounding grid study per IEEE Std 80-2013 using the perimeter loop, ground rods and bonding taps shown on the grounding layout. '
        + model.ieee80.notes.join(' ')
        + ' Final grounding design, field soil resistivity testing (Wenner method) and the construction grid study remain the responsibility of the Engineer of Record.',
      head: ['Parameter', 'Value', 'Status', 'Reference'],
      rows: ieee80Rows(model.ieee80),
      statusCol: 2,
    });
  }
  tables.push(
    {
      id: 'exceptions',
      title: 'Warnings & Exceptions Appendix',
      intro: model.exceptions.length
        ? 'Every active design warning and non-passing check, reproduced verbatim. Items listed here require resolution or AHJ concurrence during detailed design.'
        : 'No active warnings or non-passing checks — all automated design checks pass.',
      head: ['Source', 'Severity', 'Description'],
      rows: model.exceptions.map((e: PermitException) => [e.source, e.severity, e.text]),
      statusCol: 1,
    },
  );
  // Number the sections in order (numbers shift only when the optional
  // earthwork section is present, keeping the packet identical otherwise).
  return tables.map((t, i) => ({ ...t, title: `${i + 1}. ${t.title}` }));
}

// ---------------------------------------------------------------------------
// PDF layout system
// ---------------------------------------------------------------------------
const PAGE_W = 612; // letter portrait, pt
const PAGE_H = 792;
const MARGIN = 54;
const INK = 20;
const SLATE = 100;
const BRAND: [number, number, number] = [15, 55, 95]; // deep engineering blue

const STATUS_COLORS: Record<string, [number, number, number]> = {
  PASS: [22, 130, 66],
  WARN: [180, 120, 10],
  FAIL: [180, 40, 40],
};

function sectionHeader(doc: jsPDF, title: string, y: number): number {
  doc.setFillColor(...BRAND);
  doc.rect(MARGIN, y, 4, 16, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.setTextColor(INK);
  doc.text(title, MARGIN + 12, y + 13);
  return y + 26;
}

function sectionIntro(doc: jsPDF, intro: string, y: number): number {
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  doc.setTextColor(SLATE);
  const lines = doc.splitTextToSize(intro, PAGE_W - 2 * MARGIN);
  doc.text(lines, MARGIN, y);
  doc.setTextColor(INK);
  return y + lines.length * 10 + 8;
}

// Vector site-plan key map drawn straight from the same DXF drawing code the
// plot set uses (boundary, fence, roads, equipment, gate) — never a raster.
//
// Equipment draws as FOOTPRINTS here, not delivered symbols: this is an
// orientation key map a few hundred points wide, where per-unit symbol
// artwork is sub-pixel detail that only inflates the file (see
// drawEquipmentFootprints).
export function drawSitePlanThumbnail(
  doc: jsPDF,
  design: SiteDesign,
  box: { x: number; y: number; w: number; h: number },
  contours?: NonNullable<PermitPacketModel['earthwork']>['contours'],
  drawingVisibility?: DrawingVisibilityProfile
) {
  const ov = new DxfWriter(drawingVisibility);
  addBaseLayers(ov);
  drawBoundaryAndFence(ov, design);
  drawRoads(ov, design, false);
  drawEquipmentFootprints(ov, design);
  drawGate(ov, design);

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const pt = (x: number, y: number) => {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  };
  const segs: Array<{ layer: string; pts: [number, number][] }> = [];
  // Traced future/augmentation envelope ops (drawTracedFutureEnvelopes):
  // the ANSI37 mesh reads as a flat light fill at key-map scale, and the
  // fitted title keeps the dashed group explained. Scoped by layer so road
  // surface hatches and the gate label stay un-rendered as before.
  const futureFills: [number, number][][] = [];
  const futureTitles: Array<{ x: number; y: number; h: number; text: string; rot: number }> = [];
  for (const op of ov.ops) {
    if (op.kind === 'line') { segs.push({ layer: op.layer, pts: [[op.x1, op.y1], [op.x2, op.y2]] }); pt(op.x1, op.y1); pt(op.x2, op.y2); }
    else if (op.kind === 'poly') {
      const pts = (op.closed ? [...op.pts, op.pts[0]] : op.pts) as [number, number][];
      segs.push({ layer: op.layer, pts });
      op.pts.forEach(p => pt(p[0], p[1]));
    } else if (op.kind === 'arc') {
      const steps = 16; const pts: [number, number][] = [];
      let { start, end } = op;
      if (op.ccw && end < start) end += Math.PI * 2;
      if (!op.ccw && end > start) end -= Math.PI * 2;
      for (let i = 0; i <= steps; i++) {
        const a = start + ((end - start) * i) / steps;
        pts.push([op.cx + op.r * Math.cos(a), op.cy + op.r * Math.sin(a)]);
      }
      segs.push({ layer: op.layer, pts });
      pt(op.cx - op.r, op.cy - op.r); pt(op.cx + op.r, op.cy + op.r);
    } else if (op.kind === 'hatch' && op.layer === LAYERS.FUTURE_BESS) {
      for (const loop of op.loops) {
        futureFills.push(loop as [number, number][]);
        loop.forEach(p => pt(p[0], p[1]));
      }
    } else if (op.kind === 'text' && op.layer === LAYERS.TEXT_LG) {
      futureTitles.push({ x: op.cx ?? op.x, y: op.cy ?? op.y, h: op.h, text: op.text, rot: op.rot || 0 });
    }
  }
  if (!isFinite(minX) || maxX - minX < 1 || maxY - minY < 1) return;
  const hasContours = !!(contours && contours.lines.length);
  if (hasContours) for (const line of contours!.lines) for (const p of line.pts) pt(p.x, p.y);

  const pad = 10;
  const sc = Math.min((box.w - 2 * pad) / (maxX - minX), (box.h - 2 * pad) / (maxY - minY));
  const w = (maxX - minX) * sc, h = (maxY - minY) * sc;
  const ox = box.x + (box.w - w) / 2, oy = box.y + (box.h - h) / 2;
  const fx = (x: number) => ox + (x - minX) * sc;
  const fy = (y: number) => oy + (maxY - y) * sc;

  // Existing-grade contour underlay (drawn first so site line work stays on
  // top): very light minor lines, slightly heavier major (index) lines. Only
  // present when terrain data is loaded — packets without terrain data are
  // byte-identical to before.
  if (hasContours) {
    const drawContourLine = (pts: { x: number; y: number }[], closed: boolean) => {
      for (let i = 0; i + 1 < pts.length; i++) {
        doc.line(fx(pts[i].x), fy(pts[i].y), fx(pts[i + 1].x), fy(pts[i + 1].y));
      }
      if (closed && pts.length > 2) {
        const a = pts[pts.length - 1], b = pts[0];
        doc.line(fx(a.x), fy(a.y), fx(b.x), fy(b.y));
      }
    };
    doc.setDrawColor(215, 221, 227);
    doc.setLineWidth(0.3);
    for (const line of contours!.lines) {
      if (line.major || line.pts.length < 2) continue;
      drawContourLine(line.pts, line.closed);
    }
    doc.setDrawColor(190, 198, 206);
    doc.setLineWidth(0.5);
    for (const line of contours!.lines) {
      if (!line.major || line.pts.length < 2) continue;
      drawContourLine(line.pts, line.closed);
    }
  }

  // Future-augmentation envelope fills go under the line work so fence,
  // roads and footprints stay legible on top. Absent on auto layouts —
  // their packets stay byte-identical.
  if (futureFills.length) {
    doc.setFillColor(234, 237, 240);
    for (const loop of futureFills) {
      if (loop.length < 3) continue;
      const p0: [number, number] = [fx(loop[0][0]), fy(loop[0][1])];
      const deltas: [number, number][] = [];
      let px = p0[0], py = p0[1];
      for (let i = 1; i < loop.length; i++) {
        const qx = fx(loop[i][0]), qy = fy(loop[i][1]);
        deltas.push([qx - px, qy - py]);
        px = qx; py = qy;
      }
      doc.lines(deltas, p0[0], p0[1], [1, 1], 'F', true);
    }
  }

  const LAYER_RGB: Record<string, [number, number, number]> = {
    // Property line: always the shared purple (never gray/blue) so it can't
    // be read as contour or road linework — see propertyLineColor.ts.
    'SITE_BOUNDARY': PROPERTY_LINE_FIGURE_RGB,
    'fence': [180, 120, 10],
    // Key-map built footprints use SYM_DARK, but keep this legacy layer
    // neutral too so an old or externally forged footprint cannot reintroduce
    // a red fallback box through the permit-only renderer.
    'EQUIP - equip main outline': [70, 90, 110],
    [LAYERS.SYM_DARK]: [70, 90, 110],
    'A - Equipment access': [140, 140, 140],
    [LAYERS.FUTURE_BESS]: [150, 158, 166],
  };
  doc.setLineWidth(0.7);
  // Future footprints print dashed, matching the DXF layer linetype. The
  // dash operators are only emitted when a future seg is present, keeping
  // auto packets byte-identical.
  let dashed = false;
  for (const seg of segs) {
    const wantDash = seg.layer === LAYERS.FUTURE_BESS;
    if (wantDash !== dashed) {
      doc.setLineDashPattern(wantDash ? [2.5, 1.8] : [], 0);
      dashed = wantDash;
    }
    const [cr, cg, cb] = LAYER_RGB[seg.layer] ?? [70, 90, 110];
    doc.setDrawColor(cr, cg, cb);
    for (let i = 0; i + 1 < seg.pts.length; i++) {
      doc.line(fx(seg.pts[i][0]), fy(seg.pts[i][1]), fx(seg.pts[i + 1][0]), fy(seg.pts[i + 1][1]));
    }
  }
  if (dashed) doc.setLineDashPattern([], 0);
  // Envelope titles on top, scaled with the map but clamped legible.
  if (futureTitles.length) {
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(96, 104, 112);
    for (const t of futureTitles) {
      doc.setFontSize(Math.max(4, Math.min(8, t.h * sc)));
      doc.text(t.text, fx(t.x), fy(t.y), { align: 'center', baseline: 'middle', angle: t.rot });
    }
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(INK);
  }
  // frame
  doc.setDrawColor(...BRAND);
  doc.setLineWidth(1);
  doc.rect(box.x, box.y, box.w, box.h);
}

// Vector existing-grade contour figure for the earthwork section. Drawn 1:1
// from the same ContourSet the DXF reference layer exports (contoursForDxf) —
// minor contours light, index (major) contours heavier with elevation labels.
// Boundary + fence line work is included for orientation. Pure vector, fully
// deterministic — never a raster.
export function drawContourFigure(
  doc: jsPDF,
  ew: NonNullable<PermitPacketModel['earthwork']>,
  design: SiteDesign | undefined,
  box: { x: number; y: number; w: number; h: number }
) {
  const contours = ew.contours;
  if (!contours || !contours.lines.length) return;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const pt = (x: number, y: number) => {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  };
  for (const line of contours.lines) for (const p of line.pts) pt(p.x, p.y);
  if (design) {
    for (const p of design.boundary.polygon) pt(p.x, p.y);
    for (const p of design.fence) pt(p.x, p.y);
  }
  if (!isFinite(minX) || maxX - minX < 1 || maxY - minY < 1) return;

  const pad = 10;
  const sc = Math.min((box.w - 2 * pad) / (maxX - minX), (box.h - 2 * pad) / (maxY - minY));
  const w = (maxX - minX) * sc, h = (maxY - minY) * sc;
  const ox = box.x + (box.w - w) / 2, oy = box.y + (box.h - h) / 2;
  const fx = (x: number) => ox + (x - minX) * sc;
  const fy = (y: number) => oy + (maxY - y) * sc;

  const drawPoly = (pts: { x: number; y: number }[], closed: boolean) => {
    for (let i = 0; i + 1 < pts.length; i++) {
      doc.line(fx(pts[i].x), fy(pts[i].y), fx(pts[i + 1].x), fy(pts[i + 1].y));
    }
    if (closed && pts.length > 2) {
      const a = pts[pts.length - 1], b = pts[0];
      doc.line(fx(a.x), fy(a.y), fx(b.x), fy(b.y));
    }
  };

  // Minor contours: light, thin
  doc.setDrawColor(170, 178, 186);
  doc.setLineWidth(0.4);
  for (const line of contours.lines) {
    if (line.major || line.pts.length < 2) continue;
    drawPoly(line.pts, line.closed);
  }
  // Index (major) contours: heavier, darker, labeled with the elevation
  doc.setDrawColor(110, 118, 128);
  doc.setLineWidth(0.9);
  for (const line of contours.lines) {
    if (!line.major || line.pts.length < 2) continue;
    drawPoly(line.pts, line.closed);
  }
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(6);
  doc.setTextColor(90, 98, 108);
  const fmtElev = (e: number) => (Number.isInteger(e) ? e.toFixed(0) : e.toFixed(1));
  for (const line of contours.lines) {
    if (!line.major || line.pts.length < 2) continue;
    const m = line.pts[Math.floor(line.pts.length / 2)];
    doc.text(fmtElev(line.elevFt), fx(m.x), fy(m.y) - 1.5, { align: 'center' });
  }

  // Site context: parcel boundary (property-line purple) + fence (amber),
  // same colors as the cover key map so the two figures read consistently.
  if (design) {
    doc.setDrawColor(...PROPERTY_LINE_FIGURE_RGB);
    doc.setLineWidth(0.7);
    if (design.boundary.polygon.length > 2) drawPoly(design.boundary.polygon, true);
    if (showSeparateFence(design)) {
      doc.setDrawColor(180, 120, 10);
      if (design.fence.length > 2) drawPoly(design.fence, true);
    }
  }

  // frame + caption
  doc.setDrawColor(...BRAND);
  doc.setLineWidth(1);
  doc.rect(box.x, box.y, box.w, box.h);
  doc.setFontSize(7.5);
  doc.setTextColor(SLATE);
  doc.text(
    `EXISTING-GRADE CONTOUR MAP — ${fmtElev(contours.intervalFt)} ft interval, index contours every ${fmtElev(contours.majorEveryFt)} ft (labeled). Reference only — ${ew.source}.`,
    box.x, box.y + box.h + 12,
    { maxWidth: box.w }
  );
  doc.setTextColor(INK);
}

// Vector grounding screening figure: perimeter loop (dashed), ground rod
// markers, bonding tap stubs, with boundary + fence + equipment outlines for
// context — drawn 1:1 from the same GroundingPlan the DXF layer exports.
// Pure vector, fully deterministic — never a raster.
export function drawGroundingFigure(
  doc: jsPDF,
  grounding: NonNullable<PermitPacketModel['grounding']>,
  design: SiteDesign | undefined,
  box: { x: number; y: number; w: number; h: number }
) {
  const loops = (grounding.loops ?? [grounding.loop]).filter(l => l.length > 2);
  if (!loops.length) return;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const pt = (x: number, y: number) => {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  };
  for (const lp of loops) for (const p of lp) pt(p.x, p.y);
  if (design) {
    for (const p of design.boundary.polygon) pt(p.x, p.y);
    for (const p of design.fence) pt(p.x, p.y);
  }
  if (!isFinite(minX) || maxX - minX < 1 || maxY - minY < 1) return;

  const pad = 10;
  const sc = Math.min((box.w - 2 * pad) / (maxX - minX), (box.h - 2 * pad) / (maxY - minY));
  const w = (maxX - minX) * sc, h = (maxY - minY) * sc;
  const ox = box.x + (box.w - w) / 2, oy = box.y + (box.h - h) / 2;
  const fx = (x: number) => ox + (x - minX) * sc;
  const fy = (y: number) => oy + (maxY - y) * sc;

  const drawPoly = (pts: { x: number; y: number }[], closed: boolean) => {
    for (let i = 0; i + 1 < pts.length; i++) {
      doc.line(fx(pts[i].x), fy(pts[i].y), fx(pts[i + 1].x), fy(pts[i + 1].y));
    }
    if (closed && pts.length > 2) {
      const a = pts[pts.length - 1], b = pts[0];
      doc.line(fx(a.x), fy(a.y), fx(b.x), fy(b.y));
    }
  };

  // Site context first so grounding line work stays on top: parcel boundary
  // (property-line purple) + fence (amber), same colors as the cover key
  // map, plus light equipment outlines so taps visibly land on enclosures.
  if (design) {
    doc.setDrawColor(...PROPERTY_LINE_FIGURE_RGB);
    doc.setLineWidth(0.7);
    if (design.boundary.polygon.length > 2) drawPoly(design.boundary.polygon, true);
    if (showSeparateFence(design)) {
      doc.setDrawColor(180, 120, 10);
      if (design.fence.length > 2) drawPoly(design.fence, true);
    }
    doc.setDrawColor(200, 150, 150);
    doc.setLineWidth(0.4);
    for (const eq of design.equipment) {
      const c = Math.cos(eq.rotation), s = Math.sin(eq.rotation);
      const hx = eq.length / 2, hy = eq.width / 2;
      const corners = [
        [-hx, -hy], [hx, -hy], [hx, hy], [-hx, hy],
      ].map(([lx, ly]) => ({ x: eq.x + lx * c - ly * s, y: eq.y + lx * s + ly * c }));
      drawPoly(corners, true);
    }
  }

  // Bonding taps: thin green stubs from the loop to each enclosure edge.
  doc.setDrawColor(30, 120, 70);
  doc.setLineWidth(0.5);
  for (const tap of grounding.taps) {
    doc.line(fx(tap.from.x), fy(tap.from.y), fx(tap.to.x), fy(tap.to.y));
  }

  // Interior grid conductors: thin green lattice runs (CAR-D-B009-1A pattern).
  for (const [a, b] of grounding.grid) {
    doc.line(fx(a.x), fy(a.y), fx(b.x), fy(b.y));
  }

  // Perimeter ground loops: heavier green, dashed (buried conductor) — one
  // per equipment island envelope.
  doc.setLineDashPattern([3, 2], 0);
  doc.setLineWidth(1);
  for (const lp of loops) drawPoly(lp, true);
  doc.setLineDashPattern([], 0);

  // Grid crossing connections: tiny filled dots at lattice crossings.
  doc.setFillColor(30, 120, 70);
  for (const c of grounding.crossings) doc.circle(fx(c.x), fy(c.y), 0.7, 'F');

  // Ground rods: small filled circles on the loop.
  const rodR = 1.4;
  for (const r of grounding.rods) doc.circle(fx(r.x), fy(r.y), rodR, 'F');

  // Test wells: open circle around the rod (circled rod symbol).
  doc.setDrawColor(30, 120, 70);
  doc.setLineWidth(0.5);
  for (const w of grounding.testWells) doc.circle(fx(w.x), fy(w.y), rodR * 1.9, 'S');

  // frame + caption
  doc.setDrawColor(...BRAND);
  doc.setLineWidth(1);
  doc.rect(box.x, box.y, box.w, box.h);
  doc.setFontSize(7.5);
  doc.setTextColor(SLATE);
  const s = grounding.summary;
  doc.text(
    `GROUNDING SCREENING LAYOUT — grid confined to the equipment island envelope (dashed loop), ${s.rodCount} ground rods (dots, max ${s.rodSpacingFt} ft spacing), ${s.testWellCount} test wells (circled), ${s.crossingCount} grid crossings, ${s.tapCount} bonding taps. Screening only — not an IEEE 80 study.`,
    box.x, box.y + box.h + 12,
    { maxWidth: box.w }
  );
  doc.setTextColor(INK);
}

export function buildPermitPdf(
  model: PermitPacketModel,
  design?: SiteDesign,
  drawingVisibility?: DrawingVisibilityProfile
): jsPDF {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'letter' });
  // Deterministic output: pin the PDF metadata (same convention as pdfPlot)
  // so identical models always produce byte-identical packets. The visible
  // generation time comes from model.generatedAt, not the PDF metadata.
  doc.setCreationDate(new Date('2026-01-01T00:00:00Z'));
  (doc as any).setFileId('00000000000000000000000000000000');
  const tables = permitPacketSections(model);
  const p = model.project;

  // ---------------- Cover (page 1)
  doc.setFillColor(...BRAND);
  doc.rect(0, 0, PAGE_W, 130, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(22);
  doc.text('Permitting & Compliance Packet', MARGIN, 62);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(11);
  doc.text('Battery Energy Storage System — NFPA 855 & Site Standards Review', MARGIN, 84);
  doc.setFontSize(9);
  doc.text('ECI — BESSForge automated site design', MARGIN, 108);

  doc.setTextColor(INK);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(17);
  doc.text(p.projectName || 'Untitled Project', MARGIN, 172);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10.5);
  doc.setTextColor(SLATE);
  const sub = [
    model.site.locationText || `${model.site.originLat.toFixed(5)}°, ${model.site.originLon.toFixed(5)}°`,
    `${p.achievedMW.toFixed(1)} MW / ${p.achievedMWh.toFixed(0)} MWh — ${p.configLabel}`,
    `Revision ${p.revision}${p.date ? ` — ${p.date}` : ''}${p.drafter ? ` — Prepared by ${p.drafter}` : ''}`,
    `Generated ${model.generatedAt}`,
  ];
  sub.forEach((line, i) => doc.text(line, MARGIN, 192 + i * 15));

  if (design) {
    drawSitePlanThumbnail(doc, design, { x: MARGIN, y: 268, w: PAGE_W - 2 * MARGIN, h: 330 }, model.earthwork?.contours, drawingVisibility);
    doc.setFontSize(8);
    doc.setTextColor(SLATE);
    doc.text('SITE PLAN KEY MAP — see the accompanying drawing package for the scaled site plan.', MARGIN, 612);
  }

  // Compliance banner
  const bannerY = design ? 640 : 300;
  const worst = model.compliance.failCount > 0 ? 'FAIL' : model.compliance.warnCount > 0 ? 'WARN' : 'PASS';
  doc.setFillColor(...STATUS_COLORS[worst]);
  doc.roundedRect(MARGIN, bannerY, PAGE_W - 2 * MARGIN, 44, 4, 4, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.text(
    `Automated compliance result: ${model.compliance.passCount} PASS / ${model.compliance.warnCount} WARN / ${model.compliance.failCount} FAIL (${model.compliance.total} rules checked)`,
    MARGIN + 14, bannerY + 19
  );
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  // The exceptions appendix number shifts when the optional earthwork
  // section is present — always reference its actual position.
  const appendixNo = tables.findIndex(t => t.id === 'exceptions') + 1;
  doc.text(
    worst === 'PASS'
      ? `All automated checks pass. See Section ${appendixNo} for any advisory notes.`
      : `Non-passing items are detailed in the sections below and listed verbatim in Section ${appendixNo}.`,
    MARGIN + 14, bannerY + 34
  );
  doc.setTextColor(INK);

  // ---------------- TOC placeholder (page 2), filled after render
  doc.addPage();
  const tocPage = doc.getNumberOfPages();

  // ---------------- Sections
  const tocEntries: Array<{ title: string; page: number }> = [];
  for (const t of tables) {
    doc.addPage();
    tocEntries.push({ title: t.title, page: doc.getNumberOfPages() });
    let y = sectionHeader(doc, t.title, MARGIN);
    y = sectionIntro(doc, t.intro, y);
    if (!t.rows.length) {
      doc.setFontSize(9);
      doc.setTextColor(SLATE);
      doc.text('No entries.', MARGIN, y + 4);
      doc.setTextColor(INK);
      continue;
    }
    autoTable(doc, {
      startY: y,
      head: [t.head],
      body: t.rows,
      theme: 'grid',
      styles: { fontSize: 8, cellPadding: 4, valign: 'top', textColor: INK, lineColor: [200, 206, 214], lineWidth: 0.5 },
      headStyles: { fillColor: BRAND, textColor: 255, fontSize: 8, fontStyle: 'bold' },
      alternateRowStyles: { fillColor: [246, 248, 250] },
      columnStyles: t.id === 'site-data' || t.id === 'earthwork' || t.id === 'grounding'
        ? { 0: { fontStyle: 'bold', cellWidth: 170, fillColor: [240, 243, 246] } }
        : t.id === 'equipment-schedule'
          ? { 0: { halign: 'right', cellWidth: 45 }, 1: { cellWidth: 40 } }
          : t.id === 'trench-sections'
            ? { 1: { halign: 'center', cellWidth: 42 }, 2: { halign: 'center', cellWidth: 42 } }
            : t.statusCol !== undefined
            ? { [t.statusCol]: { halign: 'center', fontStyle: 'bold', cellWidth: 44 } }
            : {},
      didParseCell: data => {
        if (data.section === 'body' && t.statusCol !== undefined && data.column.index === t.statusCol) {
          const c = STATUS_COLORS[String(data.cell.raw)];
          if (c) data.cell.styles.textColor = c;
        }
      },
      margin: { left: MARGIN, right: MARGIN, top: MARGIN, bottom: 60 },
    });
    // Earthwork section: append the existing-grade contour figure below the
    // table (new page when the remaining space is too short for a legible
    // map). Skipped entirely when no contours are present, keeping older
    // packets byte-identical.
    if (t.id === 'earthwork' && model.earthwork?.contours?.lines.length) {
      const finalY = (doc as any).lastAutoTable?.finalY ?? y;
      const figW = PAGE_W - 2 * MARGIN;
      let figY = finalY + 18;
      let figH = PAGE_H - 60 - 20 - figY; // leave room for the caption + footer
      if (figH < 220) {
        doc.addPage();
        figY = MARGIN + 10;
        figH = PAGE_H - 60 - 20 - figY;
      }
      drawContourFigure(doc, model.earthwork, design, { x: MARGIN, y: figY, w: figW, h: figH });
    }
    // Grounding section: append the screening layout figure below the table
    // (same new-page rule as the contour figure). Only present when the
    // opt-in grounding section exists, keeping default packets byte-identical.
    if (t.id === 'grounding' && model.grounding) {
      const finalY = (doc as any).lastAutoTable?.finalY ?? y;
      const figW = PAGE_W - 2 * MARGIN;
      let figY = finalY + 18;
      let figH = PAGE_H - 60 - 20 - figY; // leave room for the caption + footer
      if (figH < 220) {
        doc.addPage();
        figY = MARGIN + 10;
        figH = PAGE_H - 60 - 20 - figY;
      }
      drawGroundingFigure(doc, model.grounding, design, { x: MARGIN, y: figY, w: figW, h: figH });
    }
  }

  // ---------------- Fill the TOC
  doc.setPage(tocPage);
  let y = sectionHeader(doc, 'Table of Contents', MARGIN);
  y += 10;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10.5);
  for (const e of tocEntries) {
    doc.setTextColor(INK);
    doc.text(e.title, MARGIN, y);
    doc.setTextColor(SLATE);
    const pageLabel = String(e.page);
    const titleW = doc.getTextWidth(e.title);
    const pageW2 = doc.getTextWidth(pageLabel);
    // dot leader
    const dotsStart = MARGIN + titleW + 8;
    const dotsEnd = PAGE_W - MARGIN - pageW2 - 8;
    let dots = '';
    const dotW = doc.getTextWidth('.');
    for (let x = dotsStart; x + dotW < dotsEnd; x += dotW * 2) dots += '. ';
    doc.text(dots, dotsStart, y);
    doc.setTextColor(INK);
    doc.text(pageLabel, PAGE_W - MARGIN, y, { align: 'right' });
    y += 20;
  }

  // ---------------- Header/footer on every page
  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    if (i > 1) {
      doc.setFontSize(7.5);
      doc.setTextColor(SLATE);
      doc.text(`${p.projectName || 'BESS Project'} — Permitting & Compliance Packet`, MARGIN, 30);
      doc.text(`Rev ${p.revision}`, PAGE_W - MARGIN, 30, { align: 'right' });
      doc.setDrawColor(210, 216, 224);
      doc.setLineWidth(0.5);
      doc.line(MARGIN, 36, PAGE_W - MARGIN, 36);
    }
    doc.setFontSize(7);
    doc.setTextColor(120);
    doc.text(
      'Diagrammatic 10% design — layouts convey concepts only; the Engineer of Record owns detailed design. BESSForge / ECI.',
      MARGIN, PAGE_H - 26
    );
    doc.text(`Page ${i} of ${pages}`, PAGE_W - MARGIN, PAGE_H - 26, { align: 'right' });
    doc.setTextColor(INK);
  }
  return doc;
}

export function exportPermitPdf(
  model: PermitPacketModel,
  fileName: string,
  design?: SiteDesign,
  drawingVisibility?: DrawingVisibilityProfile
): Promise<boolean> {
  return saveBlob(finalizePdfBlob(buildPermitPdf(model, design, drawingVisibility)), fileName);
}
