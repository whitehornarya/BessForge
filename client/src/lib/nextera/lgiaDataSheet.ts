// LGIA Appendix-style facility data sheet: the standard "Appendix 1 /
// technical data" fields a transmission provider requests with a Large
// Generator Interconnection Agreement — nameplate ratings, reactive
// capability, ride-through statement, inverter certifications, transformer
// data, feeder conductor schedule, fault contribution, and metering.
//
// SCREENING / 10%-DESIGN LEVEL: every value is pulled from the live design/
// catalog/feeder model where possible; fields that require project-specific
// engineering input are explicitly marked with the PLACEHOLDER prefix so a
// reviewer can never mistake them for confirmed data.
//
// Standalone opt-in module (POI data sheet pattern): the default DXF/PDF/
// packet exports never touch this code, so they stay byte-identical.
// All content flows through lgiaSections(model) — a pure function — so the
// regression suite pins the exact text without parsing PDF bytes.

import { DEFAULT_PRELIM_REV } from './revisionScheme';
import { finalizePdfBlob } from './pdfIdentity';
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import { SiteDesign } from './types';
import { BessConfiguration, specForKind, LG_JF2_SPEC, HITACHI_AUX_XFMR_SPEC } from './catalog';
import { FeederCircuit, MV_VOLTAGE, inverterAmps } from './feeders';
import { feederDisplayName } from './feederNaming';
import { TitleBlockInfo } from '../stores/useDesignStore';
import { saveBlob } from '../saveFile';
import { ShortCircuitStudy, SC_DISCLAIMER } from './shortCircuit';
import { POI_SC_SCREENING_MULTIPLIER, POI_PF_RANGE_TEXT } from './poiDataSheet';
import { RELAY_SHEET_TITLE } from './relayOneLine';

// Marks a value the project team must confirm — never auto-derivable.
export const PLACEHOLDER = '[PLACEHOLDER — CONFIRM FOR PROJECT]';

export const RIDE_THROUGH_BASE =
  'Facility will meet the voltage and frequency ride-through requirements of IEEE 2800-2022 (and the transmission provider\'s applicable standards).';
export const CERTIFICATION_BASE =
  'Inverters certified to UL 1741 SB (IEEE 1547-2018 / IEEE 2800 alignment). Certificates to be provided by the manufacturer.';
export const RIDE_THROUGH_TEXT = RIDE_THROUGH_BASE + ' ' + PLACEHOLDER;
export const CERTIFICATION_TEXT = CERTIFICATION_BASE + ' ' + PLACEHOLDER;

// Drafter-entered project-specific data sheet values. These are PROJECT data
// (they describe the facility, not a view preference), so they live in the
// design store and travel in the exported project JSON like the title block.
// null / '' = not yet confirmed → the sheet keeps the explicit PLACEHOLDER.
export interface LgiaInputs {
  pcsXfmrZPct: number | null;  // PCS integrated step-up transformer nameplate %Z
  auxXfmrZPct: number | null;  // aux transformer nameplate %Z
  rideThroughDetail: string;   // IEEE 2800 ride-through settings/category (e.g. "Category III; zero-voltage RT 0.16 s")
  certificationDetail: string; // UL 1741 SB certificate details (listing agency / file number)
}

export const DEFAULT_LGIA_INPUTS: LgiaInputs = {
  pcsXfmrZPct: null,
  auxXfmrZPct: null,
  rideThroughDetail: '',
  certificationDetail: '',
};

const LGIA_TEXT_MAX = 300;

// Untrusted-input sanitizer (same policy as the SC / IEEE-80 inputs): each
// field individually checked; garbage snaps back to "missing" (placeholder)
// rather than poisoning the sheet. %Z accepted in the physically plausible
// 0.5–20 % nameplate range.
export function sanitizeLgiaInputs(raw: unknown): LgiaInputs {
  const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const pct = (v: unknown): number | null => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0.5 && n <= 20 ? Math.round(n * 100) / 100 : null;
  };
  const txt = (v: unknown): string =>
    typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, LGIA_TEXT_MAX) : '';
  return {
    pcsXfmrZPct: pct(o.pcsXfmrZPct),
    auxXfmrZPct: pct(o.auxXfmrZPct),
    rideThroughDetail: txt(o.rideThroughDetail),
    certificationDetail: txt(o.certificationDetail),
  };
}

export interface LgiaFeederRow {
  feeder: string;      // "F1"
  pcsCount: number;
  loadMW: number;
  amps: number;
  conductor: string;   // "750 kcmil Al, 35 kV"
  lengthFt: number;
}

export interface LgiaDataSheetModel {
  generatedAt: string;
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
  nameplate: {
    achievedMW: number;
    achievedMWh: number;
    durationHrs: number;
    mvaAtRatedPf: number;   // MW / 0.95 (typical PCS PF capability)
    blocksPlaced: number;
  };
  powerFactorRange: string;
  rideThrough: string;
  certifications: string;
  inverter: {
    manufacturer: string;
    model: string;
    rating: string;
    qty: number;
    unitAmps: number;
  };
  storage: {
    containerModel: string;
    containerMWh: number;
    containerQty: number;
  };
  transformers: {
    pcsStepUpLine: string;  // integrated MV step-up description (catalog)
    auxLine: string | null; // aux transformer catalog data, if placed
  };
  interconnection: {
    voltageKV: number;
    feederCount: number;
    feeders: LgiaFeederRow[];
    totalFeederAmps: number;
    substationPlaced: boolean;
  };
  faultContribution: {
    basis: string;          // screening multiplier or per-bus study
    screeningAmps: number;
    screeningMVA: number;
    study: ShortCircuitStudy | null;
  };
  metering: {
    locationLine: string;
    equipment: string[];    // metering equipment list
  };
  oneLineReference: string; // pointer to the relay one-line sheet
}

export interface LgiaOptions {
  titleBlock?: TitleBlockInfo;
  feeders?: FeederCircuit[];
  substation?: { x: number; y: number } | null;
  now?: Date; // injectable for deterministic tests
  shortCircuitStudy?: ShortCircuitStudy | null;
  lgiaInputs?: LgiaInputs; // drafter-entered project data; absent = all placeholders
}

export function buildLgiaDataSheetModel(
  design: SiteDesign,
  config: BessConfiguration,
  opts: LgiaOptions = {},
): LgiaDataSheetModel {
  const tb = opts.titleBlock;
  const feeders = opts.feeders ?? [];
  const inverterQty = design.equipment.filter(e => e.kind === 'inverter').length;
  const containerQty = design.equipment.filter(e => e.kind === 'bess').length;
  const invSpec = specForKind('inverter', config)!;
  const unitAmps = inverterAmps(config.blockMW);
  const totalRatedAmps = inverterQty * unitAmps;
  const screeningAmps = totalRatedAmps * POI_SC_SCREENING_MULTIPLIER;
  const screeningMVA = (Math.sqrt(3) * MV_VOLTAGE * screeningAmps) / 1e6;
  const hasAux = design.equipment.some(e => e.kind === 'auxTransformer');
  const kv = MV_VOLTAGE / 1000;
  const study = opts.shortCircuitStudy ?? null;
  // Route through the sanitizer even when the caller passes typed data —
  // persisted project JSON is untrusted (same policy as the SC inputs).
  const li = sanitizeLgiaInputs(opts.lgiaInputs ?? DEFAULT_LGIA_INPUTS);
  const zLine = (z: number | null) =>
    z !== null ? `Z = ${z}% (nameplate, drafter-entered — confirm on final test report)` : PLACEHOLDER;

  return {
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
    nameplate: {
      achievedMW: design.achievedMW,
      achievedMWh: design.achievedMWh,
      durationHrs: config.durationHrs,
      mvaAtRatedPf: design.achievedMW / 0.95,
      blocksPlaced: design.blocksPlaced,
    },
    powerFactorRange: POI_PF_RANGE_TEXT,
    rideThrough: li.rideThroughDetail
      ? `${RIDE_THROUGH_BASE} Settings: ${li.rideThroughDetail}`
      : RIDE_THROUGH_TEXT,
    certifications: li.certificationDetail
      ? `${CERTIFICATION_BASE} Certificate: ${li.certificationDetail}`
      : CERTIFICATION_TEXT,
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
    transformers: {
      pcsStepUpLine: `${inverterQty} × integrated MV step-up within each ${invSpec.manufacturer} ${invSpec.model} PCS (${invSpec.rating}). Impedance/winding data: ${zLine(li.pcsXfmrZPct)}`,
      auxLine: hasAux
        ? `1 × ${HITACHI_AUX_XFMR_SPEC.manufacturer} ${HITACHI_AUX_XFMR_SPEC.model}, ${HITACHI_AUX_XFMR_SPEC.rating}. kVA/impedance: ${zLine(li.auxXfmrZPct)}`
        : null,
    },
    interconnection: {
      voltageKV: kv,
      feederCount: feeders.length,
      feeders: feeders.map(f => ({
        feeder: feederDisplayName(f),
        pcsCount: f.inverterIds.length,
        loadMW: f.loadMW,
        amps: f.amps,
        conductor: `${f.size} kcmil ${f.material}, 35 kV class`,
        lengthFt: f.totalLengthFt,
      })),
      totalFeederAmps: feeders.reduce((s, f) => s + f.amps, 0),
      substationPlaced: !!opts.substation,
    },
    faultContribution: {
      basis: study
        ? 'Simplified per-bus short-circuit study (see study section)'
        : `Inverter-limited screening: ${inverterQty} PCS × ${Math.round(unitAmps)} A rated × ${POI_SC_SCREENING_MULTIPLIER} pu`,
      screeningAmps,
      screeningMVA,
      study,
    },
    metering: {
      locationLine: `Revenue metering at the ${kv} kV main bus, line side of the main breaker (see relay one-line)`,
      equipment: [
        '(1) Revenue meter M1, bi-directional, utility-approved class ' + PLACEHOLDER,
        '(3) Metering CTs, 0.15S accuracy class — ratio per relay one-line',
        '(3) Metering VTs, 34500:120 V, 0.3 accuracy class',
      ],
    },
    oneLineReference: `Sheet RLY-1 — ${RELAY_SHEET_TITLE}`,
  };
}

// ---------------------------------------------------------------------------
// Pure content layer.
// ---------------------------------------------------------------------------
export interface LgiaSection {
  id: string;
  title: string;
  head: string[];
  rows: string[][];
}

const n0 = (v: number) => Math.round(v).toLocaleString('en-US');
const n1 = (v: number) => v.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

export function lgiaSections(model: LgiaDataSheetModel): LgiaSection[] {
  const p = model.project;
  const np = model.nameplate;
  const ic = model.interconnection;
  const fc = model.faultContribution;

  const projectRows: string[][] = [
    ['Project name', p.projectName || '—'],
    ['Location', p.location || `${p.originLat.toFixed(5)}°, ${p.originLon.toFixed(5)}°`],
    ['Site coordinates', `${p.originLat.toFixed(5)}°, ${p.originLon.toFixed(5)}°`],
    ['Parcel area', `${p.parcelAreaAcres.toFixed(2)} acres`],
    ['System configuration', p.configLabel],
    ['Prepared by', p.drafter || '—'],
    ['Revision / date', `${p.revision} / ${p.date || '—'}`],
  ];

  const nameplateRows: string[][] = [
    ['Nameplate real power', `${n1(np.achievedMW)} MW (${np.blocksPlaced} PCS blocks)`],
    ['Nameplate apparent power', `${n1(np.mvaAtRatedPf)} MVA at 0.95 PF (typical PCS capability — confirm with manufacturer)`],
    ['Energy capacity', `${n0(np.achievedMWh)} MWh (${np.durationHrs}-hour)`],
    ['Reactive capability', model.powerFactorRange],
    ['Ride-through', model.rideThrough],
    ['Certifications', model.certifications],
  ];

  const equipRows: string[][] = [
    ['PCS inverters', `${model.inverter.qty} × ${model.inverter.manufacturer} ${model.inverter.model} (${model.inverter.rating})`],
    ['BESS containers', `${model.storage.containerQty} × ${model.storage.containerModel} (${model.storage.containerMWh} MWh each)`],
    ['PCS step-up transformers', model.transformers.pcsStepUpLine],
    ...(model.transformers.auxLine ? [['Auxiliary transformer', model.transformers.auxLine]] : []),
  ];

  const icRows: string[][] = [
    ['Interconnection voltage', `${ic.voltageKV} kV, 3-phase (MV collection bus)`],
    ['MV feeder circuits', ic.feederCount
      ? `${ic.feederCount} feeder(s), ${n0(ic.totalFeederAmps)} A aggregate at the main bus`
      : 'Not yet routed — place a substation to generate feeder circuits'],
  ];

  const feederScheduleRows: string[][] = ic.feeders.map(f => [
    f.feeder,
    `${f.pcsCount}`,
    `${n1(f.loadMW)}`,
    `${n0(f.amps)}`,
    f.conductor,
    `${n0(f.lengthFt)}`,
  ]);

  const faultRows: string[][] = [
    ['Basis', fc.basis],
    ['Fault contribution at the main bus', `${n0(fc.screeningAmps)} A (${n1(fc.screeningMVA)} MVA) at ${ic.voltageKV} kV`],
    ...(fc.study
      ? fc.study.buses.map(b => [
          b.label,
          `${n1(b.symKA)} kA sym, ${n1(b.peakKA)} kA peak, X/R ${Number.isFinite(b.xOverR) ? n1(b.xOverR) : '—'}`,
        ])
      : []),
    ['Disclaimer', SC_DISCLAIMER],
  ];

  const meteringRows: string[][] = [
    ['Metering location', model.metering.locationLine],
    ...model.metering.equipment.map((e, i) => [`Metering equipment ${i + 1}`, e]),
    ['One-line reference', model.oneLineReference],
  ];

  return [
    { id: 'project', title: '1. Project & Site', head: ['Item', 'Value'], rows: projectRows },
    { id: 'nameplate', title: '2. Nameplate & Performance Data', head: ['Item', 'Value'], rows: nameplateRows },
    { id: 'equipment', title: '3. Major Equipment & Transformers', head: ['Item', 'Value'], rows: equipRows },
    { id: 'interconnection', title: '4. Interconnection', head: ['Item', 'Value'], rows: icRows },
    { id: 'feeder-schedule', title: '5. Feeder Conductor Schedule', head: ['Feeder', 'PCS', 'MW', 'Amps', 'Conductor', 'Length (ft)'], rows: feederScheduleRows },
    { id: 'fault', title: '6. Fault Contribution', head: ['Item', 'Value'], rows: faultRows },
    { id: 'metering', title: '7. Revenue Metering', head: ['Item', 'Value'], rows: meteringRows },
  ];
}

// ---------------------------------------------------------------------------
// PDF layout — same typography family as the POI data sheet.
// ---------------------------------------------------------------------------
const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN = 54;
const INK = 20;
const SLATE = 100;
const BRAND: [number, number, number] = [15, 55, 95];

export function buildLgiaPdf(model: LgiaDataSheetModel): jsPDF {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'letter' });
  doc.setCreationDate(new Date('2026-01-01T00:00:00Z'));
  (doc as any).setFileId('00000000000000000000000000000000');

  doc.setFillColor(...BRAND);
  doc.rect(0, 0, PAGE_W, 92, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(17);
  doc.text('Facility Data Sheet (LGIA Appendix Style)', MARGIN, 40);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9.5);
  doc.text('Battery Energy Storage System — Interconnection Technical Data', MARGIN, 58);
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
  for (const s of lgiaSections(model)) {
    if (y > PAGE_H - 120) {
      doc.addPage('letter', 'portrait');
      y = MARGIN;
    }
    doc.setFillColor(...BRAND);
    doc.rect(MARGIN, y, 3, 11, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.text(s.title, MARGIN + 9, y + 9);
    const tabular = s.head.length > 2;
    autoTable(doc, {
      startY: y + 16,
      head: tabular ? [s.head] : undefined,
      body: s.rows.length ? s.rows : [[...s.head.map((_, i) => (i === 0 ? '—' : ''))]],
      theme: 'grid',
      styles: { fontSize: 7.5, cellPadding: 3, valign: 'top', textColor: INK, lineColor: [200, 206, 214], lineWidth: 0.5 },
      headStyles: { fillColor: BRAND, textColor: 255, fontSize: 7.5 },
      columnStyles: tabular ? {} : { 0: { fontStyle: 'bold', cellWidth: 150, fillColor: [240, 243, 246] } },
      alternateRowStyles: { fillColor: [246, 248, 250] },
      margin: { left: MARGIN, right: MARGIN },
    });
    y = ((doc as any).lastAutoTable?.finalY ?? y + 16) + 14;
  }

  if (y > PAGE_H - 60) {
    doc.addPage('letter', 'portrait');
    y = MARGIN;
  }
  doc.setFontSize(7);
  doc.setTextColor(SLATE);
  doc.text(
    `All values generated from the automated 10% site design model. Items marked ${PLACEHOLDER} require project-specific input. Screening data only — subject to detailed engineering and the transmission provider's interconnection study.`,
    MARGIN, Math.min(y + 10, PAGE_H - 20), { maxWidth: PAGE_W - 2 * MARGIN },
  );
  doc.setTextColor(INK);
  return doc;
}

export function buildLgiaPdfString(model: LgiaDataSheetModel): string {
  return buildLgiaPdf(model).output();
}

export async function exportLgiaPdf(model: LgiaDataSheetModel, filename: string): Promise<boolean> {
  const doc = buildLgiaPdf(model);
  return saveBlob(finalizePdfBlob(doc), filename);
}
