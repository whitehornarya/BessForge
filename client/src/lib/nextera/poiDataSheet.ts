// Interconnection one-pager: point-of-interconnection (POI) data sheet.
// A single-page PDF summarizing the facility for a utility interconnection
// request at application time — project identity, MW/MWh rating,
// interconnection voltage, feeder circuits, inverter make/model/qty, a
// SCREENING-grade short-circuit contribution estimate, power factor range,
// and site acreage/location. Every number is pulled from the live design/
// catalog model — nothing hand-entered beyond the optional title-block
// fields the drafter already maintains.
//
// Standalone opt-in module (SLD pattern): the default DXF/PDF/yard-plan
// exports never touch this code, so they stay byte-identical.
//
// All content flows through poiSections(model) — a pure function of the
// model — so the regression suite pins the exact text the PDF renders
// without parsing PDF bytes. Deterministic output: injectable `now`,
// pinned PDF metadata, fixed en-US number formatting.

import { DEFAULT_PRELIM_REV } from './revisionScheme';
import { finalizePdfBlob } from './pdfIdentity';
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import { SiteDesign } from './types';
import { BessConfiguration, specForKind, LG_JF2_SPEC } from './catalog';
import { FeederCircuit, MV_VOLTAGE, inverterAmps } from './feeders';
import { feederDisplayName } from './feederNaming';
import { TitleBlockInfo } from '../stores/useDesignStore';
import { saveBlob } from '../saveFile';
import { ShortCircuitStudy, SC_DISCLAIMER } from './shortCircuit';
import { ProtectionStudy, PROTECTION_DISCLAIMER } from './protection';

// ---------------------------------------------------------------------------
// Screening short-circuit contribution multiplier.
//
// Inverter-based resources limit their fault current electronically to a
// small multiple of rated current — industry screening practice (IEEE 2800
// guidance, typical PCS manufacturer data) uses 1.1–1.3 per unit of rated
// output current for a first-pass estimate. We use 1.2 pu, the midpoint
// commonly quoted for grid-forming/grid-following PCS units. This is a
// SCREENING number only: the actual contribution must come from the
// manufacturer's short-circuit model during the utility's fault study.
// ---------------------------------------------------------------------------
export const POI_SC_SCREENING_MULTIPLIER = 1.2;

// Typical PCS reactive capability at the terminal: ±0.95 power factor at
// rated output (per PE FREEMAQ PCSM and GE FLEXINVERTER datasheet families).
export const POI_PF_RANGE_TEXT =
  '0.95 leading to 0.95 lagging at inverter terminals (typical PCS capability — confirm with manufacturer)';

export interface PoiFeederSummaryRow {
  feeder: string;      // "F1"
  pcsCount: number;
  loadMW: number;
  amps: number;        // full feeder current at the substation bus
  conductor: string;   // "750 kcmil Al"
  lengthFt: number;
}

export interface PoiDataSheetModel {
  generatedAt: string; // fixed-format UTC stamp (from injectable now)
  project: {
    projectName: string;
    location: string;
    originLat: number;
    originLon: number;
    parcelAreaAcres: number;
    drafter: string;
    revision: string;
    date: string;
    configLabel: string;
  };
  rating: {
    achievedMW: number;
    achievedMWh: number;
    durationHrs: number;
    blocksPlaced: number;
  };
  interconnection: {
    voltageKV: number;         // collection/interconnection voltage (34.5 kV)
    feederCount: number;
    feeders: PoiFeederSummaryRow[];
    totalFeederAmps: number;   // sum of feeder currents at the main bus
    substationPlaced: boolean;
  };
  inverter: {
    manufacturer: string;
    model: string;
    rating: string;
    qty: number;
    unitAmps: number;          // rated AC amps per inverter at 34.5 kV
  };
  storage: {
    containerModel: string;
    containerMWh: number;
    containerQty: number;
  };
  shortCircuit: {
    multiplier: number;        // POI_SC_SCREENING_MULTIPLIER
    totalRatedAmps: number;    // qty × unitAmps
    screeningAmps: number;     // totalRatedAmps × multiplier
    screeningMVA: number;      // √3 × V × I
  };
  powerFactorRange: string;
  // Opt-in per-bus short-circuit study (Task: "ETAP-lite"). null = the
  // legacy screening-only sheet — byte-identical to before the feature.
  shortCircuitStudy: ShortCircuitStudy | null;
  // Opt-in protection / arc-flash study. null = section absent —
  // byte-identical to before the feature.
  protectionStudy: ProtectionStudy | null;
}

export interface PoiOptions {
  titleBlock?: TitleBlockInfo;
  feeders?: FeederCircuit[];
  substation?: { x: number; y: number } | null;
  now?: Date; // injectable for deterministic tests
  // Per-bus short-circuit study to include as its own section (opt-in).
  shortCircuitStudy?: ShortCircuitStudy | null;
  // Protection / arc-flash study to include as its own section (opt-in).
  protectionStudy?: ProtectionStudy | null;
}

export function buildPoiDataSheetModel(
  design: SiteDesign,
  config: BessConfiguration,
  opts: PoiOptions = {}
): PoiDataSheetModel {
  const tb = opts.titleBlock;
  const feeders = opts.feeders ?? [];
  const inverterQty = design.equipment.filter(e => e.kind === 'inverter').length;
  const containerQty = design.equipment.filter(e => e.kind === 'bess').length;
  const invSpec = specForKind('inverter', config)!;
  const unitAmps = inverterAmps(config.blockMW);
  const totalRatedAmps = inverterQty * unitAmps;
  const screeningAmps = totalRatedAmps * POI_SC_SCREENING_MULTIPLIER;
  const screeningMVA = (Math.sqrt(3) * MV_VOLTAGE * screeningAmps) / 1e6;

  return {
    // Fixed UTC format: output must be byte-identical across machines/locales
    generatedAt: (opts.now ?? new Date()).toISOString().replace('T', ' ').slice(0, 16) + ' UTC',
    project: {
      projectName: tb?.projectName?.trim() || design.boundary.name,
      location: tb?.location?.trim() || design.boundary.location || '',
      originLat: design.boundary.origin.lat,
      originLon: design.boundary.origin.lon,
      parcelAreaAcres: design.boundary.areaAcres,
      drafter: tb?.drafter?.trim() || '',
      revision: tb?.revision?.trim() || DEFAULT_PRELIM_REV,
      date: tb?.date?.trim() || '',
      configLabel: config.label,
    },
    rating: {
      achievedMW: design.achievedMW,
      achievedMWh: design.achievedMWh,
      durationHrs: config.durationHrs,
      blocksPlaced: design.blocksPlaced,
    },
    interconnection: {
      voltageKV: MV_VOLTAGE / 1000,
      feederCount: feeders.length,
      feeders: feeders.map(f => ({
        feeder: feederDisplayName(f),
        pcsCount: f.inverterIds.length,
        loadMW: f.loadMW,
        amps: f.amps,
        conductor: `${f.size} kcmil ${f.material}`,
        lengthFt: f.totalLengthFt,
      })),
      totalFeederAmps: feeders.reduce((s, f) => s + f.amps, 0),
      substationPlaced: !!opts.substation,
    },
    inverter: {
      manufacturer: invSpec.manufacturer,
      model: invSpec.model,
      rating: invSpec.rating,
      qty: inverterQty,
      unitAmps,
    },
    storage: {
      containerModel: `${LG_JF2_SPEC.manufacturer} ${LG_JF2_SPEC.model}`,
      containerMWh: config.containerMWh,
      containerQty,
    },
    shortCircuit: {
      multiplier: POI_SC_SCREENING_MULTIPLIER,
      totalRatedAmps,
      screeningAmps,
      screeningMVA,
    },
    powerFactorRange: POI_PF_RANGE_TEXT,
    shortCircuitStudy: opts.shortCircuitStudy ?? null,
    protectionStudy: opts.protectionStudy ?? null,
  };
}

// ---------------------------------------------------------------------------
// Pure content layer: every table row the PDF renders, as plain strings.
// ---------------------------------------------------------------------------
export interface PoiSection {
  id: string;
  title: string;
  head: string[];
  rows: string[][];
}

// Deterministic fixed en-US grouping
const n0 = (v: number) => Math.round(v).toLocaleString('en-US');
const n1 = (v: number) => v.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

export function poiSections(model: PoiDataSheetModel): PoiSection[] {
  const p = model.project;
  const r = model.rating;
  const ic = model.interconnection;
  const inv = model.inverter;
  const sc = model.shortCircuit;

  const projectRows: string[][] = [
    ['Project name', p.projectName || '—'],
    ['Location', p.location || `${p.originLat.toFixed(5)}°, ${p.originLon.toFixed(5)}°`],
    ['Site coordinates', `${p.originLat.toFixed(5)}°, ${p.originLon.toFixed(5)}°`],
    ['Parcel area', `${p.parcelAreaAcres.toFixed(2)} acres`],
    ['System configuration', p.configLabel],
    ['Prepared by', p.drafter || '—'],
    ['Revision / date', `${p.revision} / ${p.date || '—'}`],
  ];

  const ratingRows: string[][] = [
    ['Facility rating', `${n1(r.achievedMW)} MW / ${n0(r.achievedMWh)} MWh (${r.durationHrs}-hour)`],
    ['PCS blocks', `${r.blocksPlaced}`],
    ['PCS inverter units', `${inv.qty} × ${inv.manufacturer} ${inv.model} (${inv.rating})`],
    ['BESS containers', `${model.storage.containerQty} × ${model.storage.containerModel} (${model.storage.containerMWh} MWh each)`],
    ['Reactive capability', model.powerFactorRange],
  ];

  const icRows: string[][] = [
    ['Interconnection voltage', `${ic.voltageKV} kV, 3-phase (MV collection bus)`],
    ['MV feeder circuits', ic.feederCount
      ? `${ic.feederCount} feeder(s), ${n0(ic.totalFeederAmps)} A aggregate at the main bus`
      : 'Not yet routed — place a substation to generate feeder circuits'],
    ...ic.feeders.map(f => [
      `Feeder #${f.feeder}`,
      `${f.pcsCount} PCS, ${n1(f.loadMW)} MW, ${n0(f.amps)} A — ${f.conductor}, ${n0(f.lengthFt)} ft`,
    ]),
  ];

  const scRows: string[][] = [
    ['Basis', `Inverter-limited: ${inv.qty} PCS × ${n0(inv.unitAmps)} A rated × ${sc.multiplier} pu screening multiplier`],
    ['Aggregate rated current', `${n0(sc.totalRatedAmps)} A at ${ic.voltageKV} kV`],
    ['Screening fault contribution', `${n0(sc.screeningAmps)} A (${n1(sc.screeningMVA)} MVA) at the ${ic.voltageKV} kV main bus`],
    ['Disclaimer', 'SCREENING ESTIMATE ONLY — inverter fault current is electronically limited; the utility fault study must use the manufacturer short-circuit model. Not a substitute for a detailed study.'],
  ];

  const sections: PoiSection[] = [
    { id: 'project', title: '1. Project & Site', head: ['Item', 'Value'], rows: projectRows },
    { id: 'rating', title: '2. Facility Rating & Equipment', head: ['Item', 'Value'], rows: ratingRows },
    { id: 'interconnection', title: '3. Interconnection & Collection System', head: ['Item', 'Value'], rows: icRows },
    { id: 'short-circuit', title: '4. Short-Circuit Contribution (Screening)', head: ['Item', 'Value'], rows: scRows },
  ];

  // Opt-in per-bus study — appended AFTER the screening section (kept for
  // continuity) so the default sheet stays byte-identical when absent.
  const study = model.shortCircuitStudy;
  if (study) {
    const busRows: string[][] = study.buses.map(b => {
      const parts = [
        `${n1(b.symKA)} kA sym (utility ${n1(b.utilityKA)} + PCS ${n1(b.inverterKA)})`,
        `${n1(b.peakKA)} kA peak`,
        `X/R ${Number.isFinite(b.xOverR) ? n1(b.xOverR) : '—'}`,
      ];
      if (b.marginPct !== null) {
        parts.push(`margin ${b.marginPct >= 0 ? '+' : ''}${n1(b.marginPct)}% vs ${n1(study.inputs.equipmentRatingKA!)} kA rating`);
      }
      return [b.label, parts.join(', ')];
    });
    const studyRows: string[][] = [
      ['Utility source', `${n0(study.inputs.utilityFaultMVA)} MVA available at the 34.5 kV POI, X/R ${n1(study.inputs.utilityXOverR)}`],
      ['PCS contribution', `${study.inverterCount} PCS × ${n0(study.inverterUnitAmps)} A rated × ${study.inputs.inverterK} pu (fixed current source)`],
      ['Aux transformer', `${n0(study.inputs.auxKVA)} kVA, ${study.inputs.auxPctZ}% Z, X/R ${n1(study.inputs.auxXOverR)}`],
      ...busRows,
      ['Disclaimer', SC_DISCLAIMER],
    ];
    sections.push({
      id: 'short-circuit-study',
      title: '5. Per-Bus Short-Circuit Study (Simplified)',
      head: ['Bus', 'Fault Duty'],
      rows: studyRows,
    });
  }

  // Opt-in protection / arc-flash study — appended after the SC study.
  const prot = model.protectionStudy;
  if (prot) {
    const nProt = study ? 6 : 5;
    const dutyRows: string[][] = prot.duty
      .filter(r => r.kind !== 'pcs')
      .map(r => [
        r.busLabel,
        r.recommendedKA !== null
          ? `duty ${n1(r.symKA)} kA -> ${n1(r.recommendedKA)} kA device ` +
            `(req ${n1(r.requiredKA)} kA incl. ${prot.inputs.dutyMarginPct}% margin)`
          : `duty ${n1(r.symKA)} kA — NO STANDARD DEVICE COVERS ${n1(r.requiredKA)} kA`,
      ]);
    const coordRows: string[][] = prot.coordination.map(c => [
      `Feeder ${c.feederName ? `#${c.feederName}` : `F${c.feederIdx}`} vs main`,
      `pickup ${n0(c.feederPickupA)}/${n0(c.mainPickupA)} A, fault ${n1(c.faultKA)} kA, ` +
        `CTI ${Number.isFinite(c.ctiS) ? c.ctiS.toFixed(2) : '—'} s ` +
        `(req ${prot.inputs.ctiRequiredS.toFixed(2)} s) — ` +
        (c.coordinated ? 'COORDINATED' : 'REVIEW'),
    ]);
    const afRows: string[][] = prot.arcFlash.map(r => [
      r.busLabel,
      `${r.incidentCalCm2.toFixed(1)} cal/cm2 at ${n0(r.workingDistIn)} in ` +
        `(${r.method}, t=${r.clearingS.toFixed(2)} s), ` +
        `boundary ${n0(r.boundaryIn)} in, PPE CAT ${r.ppeCategory >= 5 ? 'DANGER' : r.ppeCategory}`,
    ]);
    sections.push({
      id: 'protection-study',
      title: `${nProt}. Protection, Interrupting Duty & Arc Flash (Screening)`,
      head: ['Item', 'Result'],
      rows: [
        ...dutyRows,
        ...coordRows,
        ...afRows,
        ['Disclaimer', PROTECTION_DISCLAIMER],
      ],
    });
  }

  return sections;
}

// ---------------------------------------------------------------------------
// One-page PDF layout — same typography family as the permit packet
// (letter portrait, deep engineering blue brand band, autotable grids).
// ---------------------------------------------------------------------------
const PAGE_W = 612; // letter portrait, pt
const MARGIN = 54;
const INK = 20;
const SLATE = 100;
const BRAND: [number, number, number] = [15, 55, 95];

export function buildPoiPdf(model: PoiDataSheetModel): jsPDF {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'letter' });
  // Deterministic output: pin the PDF metadata (same convention as the
  // permit packet / plot set) so identical models produce identical bytes.
  doc.setCreationDate(new Date('2026-01-01T00:00:00Z'));
  (doc as any).setFileId('00000000000000000000000000000000');

  // Header band
  doc.setFillColor(...BRAND);
  doc.rect(0, 0, PAGE_W, 92, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(17);
  doc.text('Point of Interconnection Data Sheet', MARGIN, 40);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9.5);
  doc.text('Battery Energy Storage System — Utility Interconnection Request Summary', MARGIN, 58);
  doc.setFontSize(8);
  doc.text('ECI — BESSForge automated site design', MARGIN, 76);

  doc.setTextColor(INK);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.text(model.project.projectName || 'Untitled Project', MARGIN, 116);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  doc.setTextColor(SLATE);
  doc.text(`Generated ${model.generatedAt}`, MARGIN, 130);
  doc.setTextColor(INK);

  let y = 144;
  for (const s of poiSections(model)) {
    doc.setFillColor(...BRAND);
    doc.rect(MARGIN, y, 3, 11, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.text(s.title, MARGIN + 9, y + 9);
    autoTable(doc, {
      startY: y + 16,
      body: s.rows,
      theme: 'grid',
      styles: { fontSize: 7.5, cellPadding: 3, valign: 'top', textColor: INK, lineColor: [200, 206, 214], lineWidth: 0.5 },
      columnStyles: { 0: { fontStyle: 'bold', cellWidth: 150, fillColor: [240, 243, 246] } },
      alternateRowStyles: { fillColor: [246, 248, 250] },
      margin: { left: MARGIN, right: MARGIN },
    });
    y = ((doc as any).lastAutoTable?.finalY ?? y + 16) + 14;
  }

  // Footer
  doc.setFontSize(7);
  doc.setTextColor(SLATE);
  doc.text(
    'All values generated from the automated 10% site design model. Screening data only — subject to detailed engineering and the utility interconnection study.',
    MARGIN, 772, { maxWidth: PAGE_W - 2 * MARGIN }
  );
  doc.setTextColor(INK);
  return doc;
}

export async function exportPoiPdf(model: PoiDataSheetModel, filename: string): Promise<boolean> {
  const doc = buildPoiPdf(model);
  return saveBlob(finalizePdfBlob(doc), filename);
}
