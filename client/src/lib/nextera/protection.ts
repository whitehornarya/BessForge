// Protection & arc-flash study over the per-bus short-circuit results —
// device-duty screening, feeder/main coordination screening, and incident
// energy at the working buses. "SKM-lite", clearly labeled with its
// assumptions.
//
// Consumes the ShortCircuitStudy the design already produced (same buses,
// same duties) so the two studies can never disagree.
//
// Model (simplified — documented on every output surface):
//   - Interrupting duty: each bus duty (sym kA) is checked against a
//     standard device ladder (MV: ANSI C37.04 breaker ratings; LV: common
//     molded/insulated-case interrupting ratings at 480 V). The recommended
//     device is the smallest ladder step with at least the user-set duty
//     margin above the calculated fault.
//   - Coordination screening: main and feeder relays modeled with the IEEE
//     C37.112 very-inverse characteristic t = TD·(19.61/(M²−1) + 0.491),
//     pickups at a user-set multiple of full-load amps. The screen computes
//     the operating-time separation (CTI) at the feeder-bus maximum fault
//     and flags pairs below the required interval.
//   - Arc flash, LV bus (480 V): IEEE 1584-2002 empirical method for
//     enclosed switchgear (box K=−0.555, grounded K2=−0.113, gap 32 mm,
//     distance exponent x=1.473, Cf=1.5).
//   - Arc flash, MV buses (34.5 kV > 15 kV model range): Ralph Lee method,
//     E = 2.142×10⁶·V·Ibf·t/D² (V kV, Ibf kA, t s, D mm, E J/cm²).
//   - PPE categories per NFPA 70E table thresholds (1.2/4/8/25/40 cal/cm²).
//
// Pure/deterministic module: no store, no DOM, no dxfExport import. The
// default DXF/PDF/CSV exports never call into this file; the POI data sheet
// only gains a section when a study object is explicitly passed in —
// defaults stay byte-identical.

import { ShortCircuitStudy, ScBusResult } from './shortCircuit';
import { FeederCircuit, MV_VOLTAGE } from './feeders';
import { feederDisplayName } from './feederNaming';

// Standard interrupting-rating ladders (kA sym).
export const MV_BREAKER_KA_LADDER = [16, 20, 25, 31.5, 40, 50, 63];
export const LV_BREAKER_KA_LADDER = [25, 35, 50, 65, 85, 100, 150, 200];

export interface ProtectionInputs {
  dutyMarginPct: number;     // required headroom above calculated duty (%)
  feederPickupPu: number;    // relay pickup as multiple of feeder FLA
  mainPickupPu: number;      // relay pickup as multiple of aggregate FLA
  feederTimeDial: number;    // IEEE very-inverse TD, feeder relays
  mainTimeDial: number;      // IEEE very-inverse TD, main relay
  ctiRequiredS: number;      // required coordination time interval (s)
  breakerClearingS: number;  // breaker interrupting time added to relay time
  mvWorkingDistIn: number;   // arc-flash working distance, MV gear (in)
  lvWorkingDistIn: number;   // arc-flash working distance, LV gear (in)
  maxArcDurationS: number;   // cap on arcing duration (self-extraction time)
}

export const DEFAULT_PROTECTION_INPUTS: ProtectionInputs = {
  dutyMarginPct: 20,
  feederPickupPu: 1.25,
  mainPickupPu: 1.25,
  feederTimeDial: 1,
  mainTimeDial: 3,
  ctiRequiredS: 0.3,
  breakerClearingS: 0.083, // 5 cycles at 60 Hz
  mvWorkingDistIn: 36,
  lvWorkingDistIn: 18,
  maxArcDurationS: 2,
};

// Numeric-field keys of ProtectionInputs (all fields are numeric).
export type ProtectionNumericKey = keyof ProtectionInputs;

// Single source of truth for the sanitizer clamp ranges. The panel's number
// fields read min/max from here so what the drafter sees always matches what
// the sanitizer (and therefore the study math) will accept.
export const PROTECTION_NUM_LIMITS: Record<ProtectionNumericKey, { min: number; max: number }> = {
  dutyMarginPct: { min: 0, max: 100 },
  feederPickupPu: { min: 1, max: 3 },
  mainPickupPu: { min: 1, max: 3 },
  feederTimeDial: { min: 0.5, max: 15 },
  mainTimeDial: { min: 0.5, max: 15 },
  ctiRequiredS: { min: 0.1, max: 1 },
  breakerClearingS: { min: 0.02, max: 0.5 },
  mvWorkingDistIn: { min: 12, max: 120 },
  lvWorkingDistIn: { min: 12, max: 60 },
  maxArcDurationS: { min: 0.1, max: 10 },
};

// Untrusted-input sanitizer (same policy as the SC inputs): every field
// individually range-checked; out-of-range or non-finite values snap back
// to the default so persisted garbage can never poison the math.
export function sanitizeProtectionInputs(raw: unknown): ProtectionInputs {
  const d = DEFAULT_PROTECTION_INPUTS;
  const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const num = (k: ProtectionNumericKey) => {
    const n = Number(o[k]);
    const { min, max } = PROTECTION_NUM_LIMITS[k];
    return Number.isFinite(n) && n >= min && n <= max ? n : d[k];
  };
  return {
    dutyMarginPct: num('dutyMarginPct'),
    feederPickupPu: num('feederPickupPu'),
    mainPickupPu: num('mainPickupPu'),
    feederTimeDial: num('feederTimeDial'),
    mainTimeDial: num('mainTimeDial'),
    ctiRequiredS: num('ctiRequiredS'),
    breakerClearingS: num('breakerClearingS'),
    mvWorkingDistIn: num('mvWorkingDistIn'),
    lvWorkingDistIn: num('lvWorkingDistIn'),
    maxArcDurationS: num('maxArcDurationS'),
  };
}

// IEEE C37.112 very-inverse operating time at multiple-of-pickup M.
export function veryInverseTripS(M: number, timeDial: number): number {
  if (!(M > 1)) return Infinity; // below pickup — never operates
  return timeDial * (19.61 / (M * M - 1) + 0.491);
}

export interface DutyRow {
  busId: string;
  busLabel: string;
  kind: ScBusResult['kind'];
  voltageV: number;
  symKA: number;
  requiredKA: number;        // symKA × (1 + margin)
  recommendedKA: number | null; // smallest ladder step ≥ requiredKA
  adequate: boolean;         // a ladder device covers the required duty
}

export interface CoordinationPair {
  feederIdx: number;
  // Breaker-position circuit name ('14A1') for display; optional so
  // synthetic fixtures and pre-naming sessions still type-check.
  feederName?: string;
  feederPickupA: number;
  mainPickupA: number;
  faultKA: number;           // feeder-bus maximum fault used for the check
  feederTripS: number;
  mainTripS: number;
  ctiS: number;              // mainTripS − feederTripS
  coordinated: boolean;      // ctiS ≥ required CTI (and both operate)
}

export type ArcFlashMethod = 'IEEE 1584-2002' | 'Lee';

export interface ArcFlashRow {
  busId: string;
  busLabel: string;
  method: ArcFlashMethod;
  boltedKA: number;
  arcingKA: number;          // = bolted for Lee (conservative)
  clearingS: number;
  workingDistIn: number;
  incidentCalCm2: number;
  boundaryIn: number;        // distance to 1.2 cal/cm²
  ppeCategory: number;       // 1–4, or 5 = beyond category ("dangerous")
}

export interface ProtectionStudy {
  inputs: ProtectionInputs;
  duty: DutyRow[];
  coordination: CoordinationPair[];
  arcFlash: ArcFlashRow[];
  inadequateDutyCount: number;
  uncoordinatedCount: number;
  worstIncidentCalCm2: number;
}

export function ppeCategory(calCm2: number): number {
  if (calCm2 <= 1.2) return 0;
  if (calCm2 <= 4) return 1;
  if (calCm2 <= 8) return 2;
  if (calCm2 <= 25) return 3;
  if (calCm2 <= 40) return 4;
  return 5; // beyond category — energized work prohibited
}

const log10 = (v: number) => Math.log(v) / Math.LN10;

// IEEE 1584-2002 empirical incident energy for LV enclosed switchgear.
// boltedKA in kA, voltage in kV L-L, t in s, D in inches.
export function ieee1584LvIncident(
  boltedKA: number, voltageKV: number, tS: number, workingDistIn: number,
): { arcingKA: number; calCm2: number; boundaryIn: number } {
  const G = 32;      // gap, mm — LV switchgear
  const x = 1.473;   // distance exponent — LV switchgear
  const Cf = 1.5;    // <1 kV calculation factor
  const lgIbf = log10(Math.max(boltedKA, 0.001));
  // Arcing current (box, system < 1 kV): K = −0.555.
  const lgIa = -0.555 + 0.662 * lgIbf + 0.0966 * voltageKV + 0.000526 * G +
    0.5588 * voltageKV * lgIbf - 0.00304 * G * lgIbf;
  const Ia = Math.pow(10, lgIa);
  // Normalized energy (box K1=−0.555, grounded K2=−0.113), 0.2 s, 610 mm.
  const lgEn = -0.555 - 0.113 + 1.081 * lgIa + 0.0011 * G;
  const En = Math.pow(10, lgEn); // J/cm² at 0.2 s, 610 mm
  const Dmm = workingDistIn * 25.4;
  const E_Jcm2 = 4.184 * Cf * En * (tS / 0.2) * Math.pow(610 / Dmm, x);
  const calCm2 = E_Jcm2 / 4.184;
  // Boundary: distance where E = 1.2 cal/cm² (5.0208 J/cm²).
  const DbMm = 610 * Math.pow((4.184 * Cf * En * (tS / 0.2)) / 5.0208, 1 / x);
  return { arcingKA: Ia, calCm2, boundaryIn: DbMm / 25.4 };
}

// Ralph Lee method (open-air, conservative for >15 kV class equipment).
// E [J/cm²] = 2.142×10⁶ · V[kV] · Ibf[kA] · t[s] / D[mm]².
export function leeIncident(
  boltedKA: number, voltageKV: number, tS: number, workingDistIn: number,
): { calCm2: number; boundaryIn: number } {
  const Dmm = workingDistIn * 25.4;
  const E_Jcm2 = 2.142e6 * voltageKV * boltedKA * tS / (Dmm * Dmm);
  const DbMm = Math.sqrt(2.142e6 * voltageKV * boltedKA * tS / 5.0208);
  return { calCm2: E_Jcm2 / 4.184, boundaryIn: DbMm / 25.4 };
}

// Build the protection study. Pure function of the SC study + routed
// feeders + inputs; feeders provide load currents for relay pickups.
export function buildProtectionStudy(
  sc: ShortCircuitStudy,
  feeders: FeederCircuit[],
  inputsRaw: ProtectionInputs,
): ProtectionStudy {
  const inputs = sanitizeProtectionInputs(inputsRaw);

  // 1. Interrupting duty per bus against the standard ladders.
  const duty: DutyRow[] = sc.buses.map(b => {
    const ladder = b.kind === 'aux' ? LV_BREAKER_KA_LADDER : MV_BREAKER_KA_LADDER;
    const requiredKA = b.symKA * (1 + inputs.dutyMarginPct / 100);
    const recommendedKA = ladder.find(k => k >= requiredKA) ?? null;
    return {
      busId: b.id,
      busLabel: b.label,
      kind: b.kind,
      voltageV: b.voltageV,
      symKA: b.symKA,
      requiredKA,
      recommendedKA,
      adequate: recommendedKA !== null,
    };
  });

  // 2. Feeder/main coordination screening at each feeder's launch bus.
  //    Fault magnitude: the feeder's FIRST PCS bus duty (largest fault the
  //    feeder relay must clear downstream of the main).
  const totalFLA = feeders.reduce((s, f) => s + f.amps, 0);
  const mainPickupA = totalFLA * inputs.mainPickupPu;
  const busById = new Map(sc.buses.map(b => [b.id, b]));
  const coordination: CoordinationPair[] = feeders.map(f => {
    const feederPickupA = f.amps * inputs.feederPickupPu;
    // Worst downstream fault the pair must coordinate for.
    let faultKA = 0;
    for (const invId of f.inverterIds) {
      const b = busById.get(invId);
      if (b && b.symKA > faultKA) faultKA = b.symKA;
    }
    if (faultKA <= 0) faultKA = sc.worstSymKA;
    const faultA = faultKA * 1000;
    const feederTripS = veryInverseTripS(faultA / feederPickupA, inputs.feederTimeDial);
    const mainTripS = veryInverseTripS(faultA / mainPickupA, inputs.mainTimeDial);
    const ctiS = mainTripS - feederTripS;
    return {
      feederIdx: f.idx,
      feederName: feederDisplayName(f),
      feederPickupA,
      mainPickupA,
      faultKA,
      feederTripS,
      mainTripS,
      ctiS,
      coordinated: Number.isFinite(feederTripS) && Number.isFinite(mainTripS) &&
        ctiS >= inputs.ctiRequiredS,
    };
  });

  // 3. Arc flash at the working buses: main bus + each FJB (Lee, MV) and
  //    the aux bus (IEEE 1584 LV) when present. PCS terminals share the
  //    FJB/main results (same order of duty) — kept off the table to avoid
  //    a row per inverter.
  const arcFlash: ArcFlashRow[] = [];
  for (const b of sc.buses) {
    if (b.kind === 'pcs') continue;
    if (b.kind === 'aux') {
      // Clearing: LV main device — feeder-style very-inverse at the aux
      // duty is out of scope; use breaker clearing + one CTI as a bounded
      // screening time (documented simplification).
      const tClear = Math.min(inputs.breakerClearingS + inputs.ctiRequiredS, inputs.maxArcDurationS);
      const r = ieee1584LvIncident(b.symKA, b.voltageV / 1000, tClear, inputs.lvWorkingDistIn);
      arcFlash.push({
        busId: b.id, busLabel: b.label, method: 'IEEE 1584-2002',
        boltedKA: b.symKA, arcingKA: r.arcingKA, clearingS: tClear,
        workingDistIn: inputs.lvWorkingDistIn,
        incidentCalCm2: r.calCm2, boundaryIn: r.boundaryIn,
        ppeCategory: ppeCategory(r.calCm2),
      });
    } else {
      // MV clearing: upstream relay operating time at this bus fault plus
      // breaker interruption, capped at the self-extraction limit.
      const faultA = b.symKA * 1000;
      const relayS = veryInverseTripS(faultA / Math.max(mainPickupA, 1), inputs.mainTimeDial);
      const tClear = Math.min(
        (Number.isFinite(relayS) ? relayS : inputs.maxArcDurationS) + inputs.breakerClearingS,
        inputs.maxArcDurationS,
      );
      const r = leeIncident(b.symKA, b.voltageV / 1000, tClear, inputs.mvWorkingDistIn);
      arcFlash.push({
        busId: b.id, busLabel: b.label, method: 'Lee',
        boltedKA: b.symKA, arcingKA: b.symKA, clearingS: tClear,
        workingDistIn: inputs.mvWorkingDistIn,
        incidentCalCm2: r.calCm2, boundaryIn: r.boundaryIn,
        ppeCategory: ppeCategory(r.calCm2),
      });
    }
  }

  return {
    inputs,
    duty,
    coordination,
    arcFlash,
    inadequateDutyCount: duty.filter(r => !r.adequate).length,
    uncoordinatedCount: coordination.filter(c => !c.coordinated).length,
    worstIncidentCalCm2: arcFlash.reduce((m, r) => Math.max(m, r.incidentCalCm2), 0),
  };
}

export const PROTECTION_DISCLAIMER =
  'SCREENING STUDY — relay curves are generic IEEE very-inverse with fixed ' +
  'pickups; arc flash uses IEEE 1584-2002 (LV) and the conservative Lee ' +
  'method (MV). Device selection, settings, and incident energy must be ' +
  'confirmed by a full coordination and arc-flash study for construction.';

// MV_VOLTAGE re-exported check keeps the import used and pins the model
// voltage the study text refers to.
export const PROTECTION_MV_VOLTAGE = MV_VOLTAGE;
