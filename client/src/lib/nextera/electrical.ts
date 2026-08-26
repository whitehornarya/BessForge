// Voltage drop & I²R losses screening report for the MV feeder circuits.
// Pure/deterministic function of the routed feeders — no store, no DOM — so
// it is unit-testable in Node and can never drift from the plan geometry:
// lengths come straight from the same segments the DXF/PDF draw.
//
// Model (screening-grade, documented on the report):
//   - Per-segment 3-phase drop:  ΔV = √3 · I_seg · R/ft · L_seg  (NEC Ch.9
//     Table 8 DC resistance — same table generateFeeders sizes with)
//   - Peak conductor loss:       P = Σ 3 · I_seg² · R/ft · L_seg   [W]
//   - Annual energy loss:        E = P · 8760 · LsF / 1e6          [MWh/yr]
//     with the standard empirical loss factor LsF = 0.3·LF + 0.7·LF²
//     (LF = load/capacity factor, entered as a percent).
import {
  FeederCircuit,
  CONDUCTOR_R_PER_KFT,
  MV_VOLTAGE,
  VD_LIMIT_PCT,
} from './feeders';
import { feederDisplayName } from './feederNaming';

export const HOURS_PER_YEAR = 8760;
export const DEFAULT_CAPACITY_FACTOR_PCT = 35;

// Empirical loss factor from a load factor (both as fractions).
export function lossFactor(loadFactor: number): number {
  const lf = Math.min(Math.max(loadFactor, 0), 1);
  return 0.3 * lf + 0.7 * lf * lf;
}

export interface FeederElectricalRow {
  idx: number;               // feeder number (matches the plan / legend)
  name: string;              // breaker-position circuit name ('14A1'; legacy F<n>)
  size: string;              // conductor size (kcmil)
  material: string;          // Al | Cu
  lengthFt: number;          // total routed length
  amps: number;              // BOL feeder current at the substation
  eolAmps: number;           // EOL current (BOL + reserved augmentation PCS)
  ampacity: number;          // base single-conductor table rating
  // Total usable capacity that sized the feeder: sets × derated rating.
  eolCapacityAmps: number;
  overAmpacity: boolean;     // eolAmps exceeds eolCapacityAmps
  vdVolts: number;           // line-to-line volts dropped at EOL current
  vdPct: number;             // % of 34.5 kV (EOL basis — matches sizing)
  overLimit: boolean;        // vdPct > the configured limit
  peakLossKW: number;        // 3·I²R conductor loss at rated current
  annualLossMWh: number;     // peak loss × 8760 h × loss factor
}

export interface FeederElectricalReport {
  rows: FeederElectricalRow[];
  limitPct: number;              // configured max voltage drop (%)
  capacityFactorPct: number;     // configured capacity/load factor (%)
  lossFactorUsed: number;        // derived empirical loss factor (fraction)
  totalPeakLossKW: number;
  totalAnnualLossMWh: number;
  worstVdPct: number;            // max row vdPct (0 when no feeders)
  overCount: number;             // rows exceeding limitPct
}

export interface FeederElectricalOptions {
  // Max voltage drop flag threshold (%); defaults to the engineering
  // default the feeder auto-sizing uses.
  maxVdPct?: number;
  // Capacity (load) factor in percent for the annual-loss estimate.
  capacityFactorPct?: number;
}

export function buildFeederElectricalReport(
  feeders: FeederCircuit[],
  opts: FeederElectricalOptions = {}
): FeederElectricalReport {
  const limitPct =
    Number.isFinite(opts.maxVdPct) && (opts.maxVdPct as number) > 0
      ? (opts.maxVdPct as number)
      : VD_LIMIT_PCT;
  const capacityFactorPct =
    Number.isFinite(opts.capacityFactorPct) &&
    (opts.capacityFactorPct as number) > 0 &&
    (opts.capacityFactorPct as number) <= 100
      ? (opts.capacityFactorPct as number)
      : DEFAULT_CAPACITY_FACTOR_PCT;
  const lsf = lossFactor(capacityFactorPct / 100);

  const rows: FeederElectricalRow[] = feeders.map(f => {
    // Parallel conductor sets divide the effective per-phase resistance.
    // (`|| 1` keeps saved-session / synthetic fixtures without the field.)
    const rPerFt =
      CONDUCTOR_R_PER_KFT[f.material][f.size] / 1000 / Math.max(1, f.parallelSets || 1);
    // EOL basis: the report must agree with the sizing engine, which
    // evaluates voltage drop at end-of-life current (BOL + reserved
    // augmentation PCS). Segment currents are stored at BOL, so scale.
    const eolScale = f.amps > 0 && f.eolAmps ? f.eolAmps / f.amps : 1;
    // Per-segment sums: chain hops carry less current than the home run,
    // so both drop and loss must be evaluated segment-by-segment.
    let vdVolts = 0;
    let peakLossW = 0;
    for (const seg of f.segments) {
      const a = seg.amps * eolScale;
      vdVolts += Math.sqrt(3) * a * rPerFt * seg.lengthFt;
      peakLossW += 3 * a * a * rPerFt * seg.lengthFt;
    }
    const vdPct = (vdVolts / MV_VOLTAGE) * 100;
    const peakLossKW = peakLossW / 1000;
    return {
      idx: f.idx,
      name: feederDisplayName(f),
      size: f.size,
      material: f.material,
      lengthFt: f.totalLengthFt,
      amps: f.amps,
      eolAmps: f.eolAmps || f.amps,
      ampacity: f.ampacity,
      eolCapacityAmps:
        Math.max(1, f.parallelSets || 1) * (f.effectiveAmpacity || f.ampacity),
      overAmpacity: !!f.overAmpacity,
      vdVolts,
      vdPct,
      overLimit: vdPct > limitPct,
      peakLossKW,
      annualLossMWh: (peakLossKW * HOURS_PER_YEAR * lsf) / 1000,
    };
  });

  return {
    rows,
    limitPct,
    capacityFactorPct,
    lossFactorUsed: lsf,
    totalPeakLossKW: rows.reduce((s, r) => s + r.peakLossKW, 0),
    totalAnnualLossMWh: rows.reduce((s, r) => s + r.annualLossMWh, 0),
    worstVdPct: rows.reduce((m, r) => Math.max(m, r.vdPct), 0),
    overCount: rows.filter(r => r.overLimit).length,
  };
}
