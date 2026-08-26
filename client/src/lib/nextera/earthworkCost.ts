// Earthwork cost estimate (screening-level BoQ) — pure math over the
// earthwork quantities the grading engine already reports, times user-set
// unit rates. USD only. SCREENING-LEVEL ESTIMATE — NOT A BID.
//
// Rates are a per-browser preference (localStorage), NEVER stored in the
// project JSON, and everything here is additive/opt-in: the GP-1 sheet only
// shows cost rows when the caller passes a computed cost summary.

import { EarthworkSummary } from './gradingSurface';

export interface EarthworkRates {
  cutPerCY: number;       // excavation, bank measure
  fillPerCY: number;      // placement + compaction, compacted measure
  haulPerCY: number;      // off-site haul, loose measure
  topsoilPerCY: number;   // topsoil strip + stockpile
  mobilizationLump: number; // one-time lump sum ($)
}

// Screening defaults (typical US utility-scale sitework, 2025-2026 ranges).
export const DEFAULT_EARTHWORK_RATES: EarthworkRates = {
  cutPerCY: 4.5,
  fillPerCY: 6.0,
  haulPerCY: 12.0,
  topsoilPerCY: 3.5,
  mobilizationLump: 25000,
};

// Same clamp policy as sanitizeGradingInputs: finite numbers clamp into the
// engineering range, anything else snaps back to the default (untrusted
// localStorage JSON).
const num = (v: unknown, def: number, min: number, max: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : def;

export function sanitizeEarthworkRates(v: unknown): EarthworkRates {
  const d = DEFAULT_EARTHWORK_RATES;
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { ...d };
  const o = v as Record<string, unknown>;
  return {
    cutPerCY: num(o.cutPerCY, d.cutPerCY, 0, 500),
    fillPerCY: num(o.fillPerCY, d.fillPerCY, 0, 500),
    haulPerCY: num(o.haulPerCY, d.haulPerCY, 0, 500),
    topsoilPerCY: num(o.topsoilPerCY, d.topsoilPerCY, 0, 500),
    mobilizationLump: num(o.mobilizationLump, d.mobilizationLump, 0, 10_000_000),
  };
}

export interface EarthworkCostLine {
  item: string;       // BoQ item name
  qtyCY: number | null; // rounded quantity (null for lump sum)
  unit: string;       // 'CY' or 'LS'
  rate: number;       // $/CY or lump $
  amount: number;     // rounded to whole dollars
}

export interface EarthworkCostSummary {
  lines: EarthworkCostLine[];
  totalUSD: number;   // sum of rounded line amounts (deterministic)
  disclaimer: string;
}

export const COST_DISCLAIMER = 'SCREENING-LEVEL ESTIMATE — NOT A BID';

// Deterministic rounding: quantities round to whole CY first, then each line
// amount rounds to whole dollars, and the total is the sum of the rounded
// lines — so the printed table always adds up exactly.
export function computeEarthworkCost(ew: EarthworkSummary, rates: EarthworkRates): EarthworkCostSummary {
  const r = sanitizeEarthworkRates(rates);
  const line = (item: string, rawCY: number, rate: number): EarthworkCostLine => {
    const qtyCY = Math.round(rawCY);
    return { item, qtyCY, unit: 'CY', rate, amount: Math.round(qtyCY * rate) };
  };
  const lines: EarthworkCostLine[] = [
    line('CUT (EXCAVATION, BANK)', ew.cutCY, r.cutPerCY),
    line('FILL (PLACE + COMPACT)', ew.fillCY, r.fillPerCY),
    line('HAUL (LOOSE)', ew.haulLooseCY, r.haulPerCY),
    line('TOPSOIL STRIP', ew.topsoilCY, r.topsoilPerCY),
  ];
  if (r.mobilizationLump > 0) {
    lines.push({
      item: 'MOBILIZATION',
      qtyCY: null,
      unit: 'LS',
      rate: r.mobilizationLump,
      amount: Math.round(r.mobilizationLump),
    });
  }
  const totalUSD = lines.reduce((s, l) => s + l.amount, 0);
  return { lines, totalUSD, disclaimer: COST_DISCLAIMER };
}

export const fmtUSD = (v: number) => `$${Math.round(v).toLocaleString('en-US')}`;

// Table rows for the GP-1 sheet box (DXF and PDF share this display list).
export function buildCostTableRows(cost: EarthworkCostSummary): string[] {
  const rows = cost.lines.map(l => {
    const qty = l.unit === 'LS' ? 'LUMP SUM' : `${(l.qtyCY ?? 0).toLocaleString('en-US')} CY @ $${l.rate}`;
    return `${l.item.padEnd(24)}${qty.padEnd(22)}${fmtUSD(l.amount)}`;
  });
  rows.push(`TOTAL (SCREENING)       ${''.padEnd(22)}${fmtUSD(cost.totalUSD)}`);
  rows.push(cost.disclaimer);
  return rows;
}
