// Per-bus short-circuit study over the designed collection network —
// "ETAP-lite", clearly labeled with its assumptions.
//
// Replaces the single ×1.2 screening multiplier with a bolted three-phase
// fault calculation at every bus the design actually has: the 34.5 kV main
// bus (POI), each feeder junction box (FJB), each PCS MV terminal, and the
// 480 V aux switchgear bus.
//
// Model (simplified — documented on every output surface):
//   - Utility source: Thevenin equivalent from the user-entered available
//     fault MVA and X/R at the 34.5 kV POI.
//   - Cable impedance: series R from the same NEC Ch.9 Table 8 family the
//     voltage-drop report uses (CONDUCTOR_R_PER_KFT), plus a typical
//     35 kV single-conductor direct-buried reactance table (X is geometry-
//     driven, so one table covers Al and Cu). Lengths come straight from
//     the routed feeder segments — the same polylines the DXF draws.
//   - Inverter contribution: fixed current source per IEEE 2800-typical
//     behavior — k × rated current (k user-editable, default 1.2, the
//     legacy screening multiplier). Current sources have infinite internal
//     impedance, so contributions ADD arithmetically at any MV bus and no
//     iteration is needed. No rotating-machine decay, no motor loads.
//   - Aux branch: transformer %Z on a user-editable kVA base; utility
//     contribution flows through Zsrc + Zxfmr, inverter current sources
//     divide between the grid (Zsrc) and the fault (Zxfmr) by superposition
//     and transfer through the turns ratio.
//   - Asymmetry: IEC-style peak factor κ = √2·(1.02 + 0.98·e^(−3/(X/R)))
//     from the utility-path X/R at the bus (the classic "2.6 × I_sym for
//     X/R→∞" factor family).
//
// Pure/deterministic module: no store, no DOM, no dxfExport import. The
// default DXF/PDF/CSV exports never call into this file, and the POI data
// sheet only gains a section when a study object is explicitly passed in —
// defaults stay byte-identical.

import {
  FeederCircuit,
  ConductorSize,
  CONDUCTOR_R_PER_KFT,
  MV_VOLTAGE,
} from './feeders';
import { feederDisplayName } from './feederNaming';

// Typical 35 kV single-conductor, direct-buried / trefoil series reactance,
// ohms per 1000 ft at 60 Hz (Southwire/Okonite MV-105 datasheet family).
// Reactance is set by conductor spacing/geometry, not metal, so one table
// serves both Al and Cu.
export const CONDUCTOR_X_PER_KFT: Record<ConductorSize, number> = {
  '500': 0.041,
  '750': 0.039,
  '1000': 0.037,
  '1500': 0.035,
};

export const AUX_LV_VOLTAGE = 480; // V line-to-line, aux switchgear bus

export interface ShortCircuitInputs {
  utilityFaultMVA: number;   // available 3-phase fault MVA at the 34.5 kV POI
  utilityXOverR: number;     // system X/R at the POI
  inverterK: number;         // PCS contribution, per-unit of rated current
  equipmentRatingKA: number | null; // optional MV gear interrupting rating (kA sym) for margin column
  auxKVA: number;            // aux transformer base kVA
  auxPctZ: number;           // aux transformer nameplate %Z on its base
  auxXOverR: number;         // aux transformer X/R
}

export const DEFAULT_SC_INPUTS: ShortCircuitInputs = {
  utilityFaultMVA: 1500,
  utilityXOverR: 10,
  inverterK: 1.2,
  equipmentRatingKA: null,
  auxKVA: 2000,   // matches the 2000 A / 480 V LSE2000FMCD aux switchboard
  auxPctZ: 5.75,  // typical pad-mount two-winding impedance
  auxXOverR: 5,
};

// Numeric-field keys of ShortCircuitInputs (equipmentRatingKA is nullable and
// has its own limits table entry below).
export type ScNumericKey = Exclude<keyof ShortCircuitInputs, 'equipmentRatingKA'>;

// Single source of truth for the sanitizer clamp ranges. The panel's number
// fields read min/max from here so what the drafter sees always matches what
// the sanitizer (and therefore the study math) will accept.
export const SC_NUM_LIMITS: Record<ScNumericKey, { min: number; max: number }> = {
  utilityFaultMVA: { min: 1, max: 100000 },
  utilityXOverR: { min: 0.1, max: 100 },
  inverterK: { min: 0, max: 3 },
  auxKVA: { min: 10, max: 100000 },
  auxPctZ: { min: 0.5, max: 30 },
  auxXOverR: { min: 0.1, max: 100 },
};

// Bounds for the optional (nullable) MV gear rating field.
export const SC_RATING_LIMITS = { min: 1, max: 500 };

// Untrusted-input sanitizer (same policy as the IEEE-80 inputs): every
// field individually range-checked; out-of-range or non-finite values snap
// back to the default so persisted garbage can never poison the math.
export function sanitizeScInputs(raw: unknown): ShortCircuitInputs {
  const d = DEFAULT_SC_INPUTS;
  const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const num = (k: ScNumericKey) => {
    const n = Number(o[k]);
    const { min, max } = SC_NUM_LIMITS[k];
    return Number.isFinite(n) && n >= min && n <= max ? n : d[k];
  };
  const rating = (() => {
    if (o.equipmentRatingKA === null || o.equipmentRatingKA === undefined) return null;
    const n = Number(o.equipmentRatingKA);
    return Number.isFinite(n) && n >= SC_RATING_LIMITS.min && n <= SC_RATING_LIMITS.max ? n : null;
  })();
  return {
    utilityFaultMVA: num('utilityFaultMVA'),
    utilityXOverR: num('utilityXOverR'),
    inverterK: num('inverterK'),
    equipmentRatingKA: rating,
    auxKVA: num('auxKVA'),
    auxPctZ: num('auxPctZ'),
    auxXOverR: num('auxXOverR'),
  };
}

// IEC 60909-style peak factor from X/R: κ = 1.02 + 0.98·e^(−3·R/X);
// peak current = κ·√2·I_sym. For X/R → ∞ this approaches 2·√2 ≈ 2.83;
// the classic "2.6" corresponds to X/R ≈ 17.
export function peakFactorKappa(xOverR: number): number {
  const xr = Math.max(xOverR, 1e-6);
  return 1.02 + 0.98 * Math.exp(-3 / xr);
}

interface Z { r: number; x: number } // ohms

const zAdd = (a: Z, b: Z): Z => ({ r: a.r + b.r, x: a.x + b.x });
const zMag = (z: Z): number => Math.hypot(z.r, z.x);
// Complex parallel of a list of impedances (admittance sum).
function zParallel(zs: Z[]): Z {
  let gr = 0, gx = 0;
  for (const z of zs) {
    const d = z.r * z.r + z.x * z.x;
    if (d <= 0) return { r: 0, x: 0 }; // a zero branch shorts the node
    gr += z.r / d;
    gx += -z.x / d;
  }
  const d = gr * gr + gx * gx;
  return { r: gr / d, x: -gx / d };
}

export type ScBusKind = 'main' | 'fjb' | 'pcs' | 'aux';

export interface ScBusResult {
  id: string;
  label: string;             // "34.5 kV main bus (POI)", "FJB-1", "PCS01-02", "480 V aux switchgear"
  kind: ScBusKind;
  voltageV: number;          // bus line-to-line voltage
  pathOhms: number;          // |Z| of the cable path from the main bus (0 for main)
  utilityKA: number;         // utility Thevenin contribution, kA sym
  inverterKA: number;        // summed PCS current-source contribution at this bus, kA
  symKA: number;             // total symmetrical fault duty
  xOverR: number;            // utility-path X/R at the bus
  peakKA: number;            // κ·√2·symKA — first-peak asymmetrical
  marginPct: number | null;  // vs equipmentRatingKA (MV buses only), + = headroom
}

export interface ShortCircuitStudy {
  inputs: ShortCircuitInputs;
  inverterCount: number;
  inverterUnitAmps: number;  // rated AC amps per PCS at 34.5 kV
  buses: ScBusResult[];
  worstSymKA: number;        // max over the MV buses
  overRatedCount: number;    // MV buses exceeding equipmentRatingKA (0 when no rating entered)
}

// Series impedance of one routed feeder segment for a given conductor.
// Parallel conductor sets act as parallel impedance on the same route,
// dividing both R and X by the set count.
function segmentZ(lengthFt: number, size: ConductorSize, material: 'Al' | 'Cu', sets = 1): Z {
  const n = Math.max(1, sets);
  return {
    r: (CONDUCTOR_R_PER_KFT[material][size] / 1000) * lengthFt / n,
    x: (CONDUCTOR_X_PER_KFT[size] / 1000) * lengthFt / n,
  };
}

export interface ShortCircuitOptions {
  hasAux?: boolean; // include the 480 V aux bus (config has aux equipment)
}

// Build the per-bus study. Pure function of the routed feeders + inputs:
//   feeders          — the same FeederCircuit[] the voltage-drop report uses
//   inverterCount    — placed PCS units (all contribute at every MV bus)
//   inverterUnitAmps — rated AC amps per PCS at 34.5 kV (inverterAmps(blockMW))
export function buildShortCircuitStudy(
  feeders: FeederCircuit[],
  inverterCount: number,
  inverterUnitAmps: number,
  inputsRaw: ShortCircuitInputs,
  opts: ShortCircuitOptions = {}
): ShortCircuitStudy {
  const inputs = sanitizeScInputs(inputsRaw);
  const vMV = MV_VOLTAGE;

  // Utility Thevenin at the POI: |Z| = V² / S, split R/X by the X/R angle.
  const zMagSrc = (vMV * vMV) / (inputs.utilityFaultMVA * 1e6);
  const theta = Math.atan(inputs.utilityXOverR);
  const zSrc: Z = { r: zMagSrc * Math.cos(theta), x: zMagSrc * Math.sin(theta) };

  // Total PCS current-source contribution at any MV bus (kA).
  const invKA_MV = (inputs.inverterK * inverterCount * inverterUnitAmps) / 1000;

  const busFromPath = (
    id: string, label: string, kind: ScBusKind, zPath: Z
  ): ScBusResult => {
    const zTot = zAdd(zSrc, zPath);
    const utilityKA = vMV / Math.sqrt(3) / zMag(zTot) / 1000;
    const symKA = utilityKA + invKA_MV;
    const xOverR = zTot.r > 0 ? zTot.x / zTot.r : Infinity;
    const peakKA = peakFactorKappa(xOverR) * Math.SQRT2 * symKA;
    const marginPct = inputs.equipmentRatingKA
      ? ((inputs.equipmentRatingKA - symKA) / inputs.equipmentRatingKA) * 100
      : null;
    return {
      id, label, kind, voltageV: vMV,
      pathOhms: zMag(zPath),
      utilityKA, inverterKA: invKA_MV, symKA, xOverR, peakKA, marginPct,
    };
  };

  const buses: ScBusResult[] = [];

  // 1. Main bus / POI: no cable between the source and the fault.
  buses.push(busFromPath('main', `${vMV / 1000} kV main bus (POI)`, 'main', { r: 0, x: 0 }));

  // Per-feeder segment impedances. Segment order (generateFeeders):
  //   [0 .. n-2]  chain hops — hop j runs chain[j] → chain[j+1]
  //   [n-1?]      FJB approach hop (island layouts only, full load amps)
  //   [last]      home run (launch point → substation, full load amps)
  // Path from the main bus to chain member i = home run (+ FJB hop) + hops j ≥ i.
  interface FeederPaths {
    f: FeederCircuit;
    zHome: Z;                       // home run only (main bus → FJB/launch)
    zToPcs: Map<string, Z>;         // inverter id → full path impedance
  }
  const perFeeder: FeederPaths[] = feeders.map(f => {
    const nInv = f.inverterIds.length;
    const nHops = Math.max(0, nInv - 1);
    const hasFjbHop = f.segments.length > nHops + 1; // hops + (fjb hop?) + home
    const homeSeg = f.segments[f.segments.length - 1];
    const sets = Math.max(1, f.parallelSets || 1);
    const zHomeRun = homeSeg ? segmentZ(homeSeg.lengthFt, f.size, f.material, sets) : { r: 0, x: 0 };
    const fjbSeg = hasFjbHop ? f.segments[f.segments.length - 2] : null;
    const zFjbHop = fjbSeg ? segmentZ(fjbSeg.lengthFt, f.size, f.material, sets) : { r: 0, x: 0 };
    const zToPcs = new Map<string, Z>();
    // Walk from the chain end (nearest the launch) back to the head:
    // cumulative starts at home run + FJB hop, then adds hop j when moving
    // from chain[j+1] to chain[j].
    let cum = zAdd(zHomeRun, zFjbHop);
    for (let i = nInv - 1; i >= 0; i--) {
      zToPcs.set(f.inverterIds[i], cum);
      if (i > 0) cum = zAdd(cum, segmentZ(f.segments[i - 1].lengthFt, f.size, f.material, sets));
    }
    return { f, zHome: zHomeRun, zToPcs };
  });

  // 2. FJB buses: feeders sharing one box give parallel utility paths
  //    (each home run is its own conductor back to the main bus).
  const byFjb = new Map<string, Z[]>();
  for (const p of perFeeder) {
    if (!p.f.fjbId) continue;
    byFjb.set(p.f.fjbId, [...(byFjb.get(p.f.fjbId) ?? []), p.zHome]);
  }
  for (const [fjbId, paths] of Array.from(byFjb.entries()).sort((a, b) => a[0].localeCompare(b[0]))) {
    buses.push(busFromPath(fjbId, fjbId.toUpperCase(), 'fjb', zParallel(paths)));
  }

  // 3. PCS MV terminals, in feeder order then chain order.
  for (const p of perFeeder) {
    for (const invId of p.f.inverterIds) {
      const z = p.zToPcs.get(invId)!;
      buses.push(busFromPath(invId, `${feederDisplayName(p.f)} — ${invId}`, 'pcs', z));
    }
  }

  const mvBuses = buses.slice();
  const worstSymKA = mvBuses.reduce((m, b) => Math.max(m, b.symKA), 0);

  // 4. 480 V aux switchgear bus (only when the config has aux equipment).
  if (opts.hasAux) {
    const vLV = AUX_LV_VOLTAGE;
    const t = vLV / vMV;
    // Source impedance referred to 480 V.
    const zSrcLV: Z = { r: zSrc.r * t * t, x: zSrc.x * t * t };
    // Transformer impedance at 480 V on its own base.
    const zBaseLV = (vLV * vLV) / (inputs.auxKVA * 1000);
    const zxMagLV = (inputs.auxPctZ / 100) * zBaseLV;
    const thX = Math.atan(inputs.auxXOverR);
    const zX_LV: Z = { r: zxMagLV * Math.cos(thX), x: zxMagLV * Math.sin(thX) };
    const zTotLV = zAdd(zSrcLV, zX_LV);
    const utilityKA = vLV / Math.sqrt(3) / zMag(zTotLV) / 1000;
    // Inverter current sources at the MV bus divide between the grid (zSrc)
    // and the transformer branch (zX referred to MV) by superposition; the
    // fault share transfers through the turns ratio. Magnitude divider —
    // simplified, consistent with the study grade.
    const zX_MV: Z = { r: zX_LV.r / (t * t), x: zX_LV.x / (t * t) };
    const divider = zMag(zSrc) / zMag(zAdd(zSrc, zX_MV));
    const inverterKA = invKA_MV * divider * (vMV / vLV);
    const symKA = utilityKA + inverterKA;
    const xOverR = zTotLV.r > 0 ? zTotLV.x / zTotLV.r : Infinity;
    buses.push({
      id: 'aux',
      label: `${vLV} V aux switchgear`,
      kind: 'aux',
      voltageV: vLV,
      pathOhms: zMag(zX_LV),
      utilityKA,
      inverterKA,
      symKA,
      xOverR,
      peakKA: peakFactorKappa(xOverR) * Math.SQRT2 * symKA,
      marginPct: null, // MV gear rating doesn't apply at 480 V
    });
  }

  const overRatedCount = inputs.equipmentRatingKA
    ? mvBuses.filter(b => b.symKA > inputs.equipmentRatingKA!).length
    : 0;

  return {
    inputs,
    inverterCount,
    inverterUnitAmps,
    buses,
    worstSymKA,
    overRatedCount,
  };
}

export const SC_DISCLAIMER =
  'SIMPLIFIED STUDY — inverter contributions modeled as fixed current sources ' +
  '(k × rated, IEEE 2800-typical); no rotating-machine decay, no motor ' +
  'contribution; cable X from typical 35 kV datasheet values. Verify with a ' +
  'full short-circuit study (manufacturer PCS models) for construction.';
