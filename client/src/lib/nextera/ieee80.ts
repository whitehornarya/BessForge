// IEEE Std 80-2013 grounding grid study.
//
// Pure, deterministic calculation module — no imports into any exporter.
// Consumes the screening GroundingPlan geometry (perimeter loop + interior
// grid + rods + bonding taps) plus engineer inputs, and produces grid
// resistance, GPR,
// mesh (touch) and step voltages with pass/fail against tolerable limits.
//
// Equation numbers reference IEEE Std 80-2013. All internal math is metric
// (Ω·m, meters, amps, seconds); the GroundingPlan wrapper converts from the
// layout's feet/sqft units.
//
// MODEL ASSUMPTIONS (surfaced in Ieee80Study.notes):
// - Uniform soil model (single resistivity ρ). Two-layer soil is detailed-
//   design scope.
// - The screening grid is a perimeter loop + interior row/column grid +
//   bonding taps, not a uniform
//   mesh; the mesh-voltage equations model it as a sparse grid using the
//   geometric factor n from the actual conductor/perimeter/area ratios and
//   an effective parallel-conductor spacing D ≈ √A / (n − 1). This is a
//   conservative screening-grade application of the Annex D equations.

import { GroundingPlan } from './grounding';

export const FT_TO_M = 0.3048;
const SQFT_TO_SQM = FT_TO_M * FT_TO_M;

// ---------------------------------------------------------------------------
// Inputs

export interface Ieee80Inputs {
  soilRhoOhmM: number;        // uniform soil resistivity ρ (Ω·m)
  surfaceRhoOhmM: number;     // crushed-rock surface layer ρs (Ω·m, wet)
  surfaceThicknessM: number;  // surface layer thickness hs (m); 0 = none
  faultCurrentA: number;      // symmetrical ground fault current 3I0 (A)
  faultDurationS: number;     // fault clearing time tf = ts = tc (s)
  splitFactorSf: number;      // current division factor Sf (1.0 conservative)
  xOverR: number;             // system X/R at the fault (0 → Df = 1.0)
  bodyWeightKg: 50 | 70;      // tolerable-limit body weight basis
  burialDepthM: number;       // grid conductor burial depth h (m)
  rodLengthM: number;         // ground rod length Lr (m)
  conductorDiamM: number;     // grid conductor diameter d (m)
  conductorKcmil: number;     // installed grid conductor size (kcmil)
}

export const DEFAULT_IEEE80_INPUTS: Ieee80Inputs = {
  soilRhoOhmM: 100,
  surfaceRhoOhmM: 2500,
  surfaceThicknessM: 0.102, // 4 in crushed rock
  faultCurrentA: 10000,
  faultDurationS: 0.5,
  splitFactorSf: 1.0,
  xOverR: 10,
  bodyWeightKg: 70,
  burialDepthM: 0.5, // 18 in
  rodLengthM: 3.048, // 10 ft copper-clad rod
  conductorDiamM: 0.0134, // 4/0 AWG stranded ≈ 13.4 mm
  conductorKcmil: 211.6, // 4/0 AWG
};

// Grid geometry in metric, derivable from a GroundingPlan or supplied
// directly (tests feed the IEEE 80 Annex B example geometry here).
export interface Ieee80Geometry {
  areaM2: number;      // grid area A (m²)
  perimeterM: number;  // grid perimeter Lp (m)
  conductorM: number;  // total buried horizontal conductor Lc (m)
  rodCount: number;    // number of ground rods nR
  rodLengthM: number;  // individual rod length Lr (m)
  lxM: number;         // grid extent in x (m)
  lyM: number;         // grid extent in y (m)
  spacingDM: number;   // parallel conductor spacing D (m)
  perimeterRods: boolean; // rods on the perimeter/corners (Kii = 1)
}

// ---------------------------------------------------------------------------
// Elementary factors

// Eq. 27: surface layer derating factor Cs.
export function surfaceDeratingCs(soilRho: number, surfRho: number, hs: number): number {
  if (hs <= 0 || surfRho <= soilRho) return 1;
  return 1 - (0.09 * (1 - soilRho / surfRho)) / (2 * hs + 0.09);
}

// Eqs. 29/30 (step) and 32/33 (touch): tolerable voltages.
export function tolerableTouchV(cs: number, surfRho: number, ts: number, kg: 50 | 70): number {
  const k = kg === 70 ? 0.157 : 0.116;
  return ((1000 + 1.5 * cs * surfRho) * k) / Math.sqrt(ts);
}
export function tolerableStepV(cs: number, surfRho: number, ts: number, kg: 50 | 70): number {
  const k = kg === 70 ? 0.157 : 0.116;
  return ((1000 + 6 * cs * surfRho) * k) / Math.sqrt(ts);
}

// Eq. 79: decrement factor Df from X/R and fault duration (60 Hz).
export function decrementFactorDf(xOverR: number, tf: number): number {
  if (xOverR <= 0 || tf <= 0) return 1;
  const ta = xOverR / (2 * Math.PI * 60);
  return Math.sqrt(1 + (ta / tf) * (1 - Math.exp((-2 * tf) / ta)));
}

// Eq. 57 (Sverak): grid resistance from total buried conductor LT, area, depth.
export function sverakRg(rho: number, ltM: number, areaM2: number, hM: number): number {
  if (ltM <= 0 || areaM2 <= 0) return Infinity;
  const s20a = Math.sqrt(20 * areaM2);
  return rho * (1 / ltM + (1 / s20a) * (1 + 1 / (1 + hM * Math.sqrt(20 / areaM2))));
}

// Eqs. 63–65 (Schwarz): combined grid + rod-bed resistance. k1/k2 use the
// published straight-line approximations of Fig. 25 (curves A/B/C at depths
// 0, √A/10, √A/6) with linear interpolation on burial depth.
export function schwarzRg(
  rho: number, lcM: number, areaM2: number, hM: number, dCondM: number,
  nR: number, lrM: number, rodDiamM: number, lxM: number, lyM: number
): number {
  if (nR <= 0 || lrM <= 0) return sverakRg(rho, lcM, areaM2, hM);
  const x = Math.max(1, Math.max(lxM, lyM) / Math.max(1e-6, Math.min(lxM, lyM)));
  const sA = Math.sqrt(areaM2);
  // k1/k2 straight-line fits (IEEE 80 Fig. 25 curves):
  const K1 = [
    { h: 0, f: (r: number) => -0.04 * r + 1.41 },
    { h: sA / 10, f: (r: number) => -0.05 * r + 1.20 },
    { h: sA / 6, f: (r: number) => -0.05 * r + 1.13 },
  ];
  const K2 = [
    { h: 0, f: (r: number) => 0.15 * r + 5.50 },
    { h: sA / 10, f: (r: number) => 0.10 * r + 4.68 },
    { h: sA / 6, f: (r: number) => -0.05 * r + 4.40 },
  ];
  const interp = (tab: { h: number; f: (r: number) => number }[]): number => {
    const vals = tab.map(t => ({ h: t.h, v: t.f(x) }));
    if (hM <= vals[0].h) return vals[0].v;
    for (let i = 1; i < vals.length; i++) {
      if (hM <= vals[i].h) {
        const t = (hM - vals[i - 1].h) / (vals[i].h - vals[i - 1].h);
        return vals[i - 1].v + t * (vals[i].v - vals[i - 1].v);
      }
    }
    return vals[vals.length - 1].v;
  };
  const k1 = interp(K1);
  const k2 = interp(K2);
  const aPrime = hM > 0 ? Math.sqrt(dCondM * hM) : dCondM / 2; // a' = √(d·h) for buried conductor
  const lrTotal = nR * lrM;
  // Eq. 63: grid conductor resistance R1
  const r1 = (rho / (Math.PI * lcM)) *
    (Math.log((2 * lcM) / aPrime) + (k1 * lcM) / sA - k2);
  // Eq. 64: rod bed resistance R2
  const b = rodDiamM / 2;
  const r2 = (rho / (2 * Math.PI * nR * lrM)) *
    (Math.log((4 * lrM) / b) - 1 + ((2 * k1 * lrM) / sA) * Math.pow(Math.sqrt(nR) - 1, 2));
  // Eq. 65: mutual resistance Rm
  const rm = (rho / (Math.PI * lcM)) *
    (Math.log((2 * lcM) / lrM) + (k1 * lcM) / sA - k2 + 1);
  const denom = r1 + r2 - 2 * rm;
  if (denom <= 0 || !Number.isFinite(denom)) return sverakRg(rho, lcM + lrTotal, areaM2, hM);
  const rg = (r1 * r2 - rm * rm) / denom;
  // Guard degenerate geometry: combined result must stay physical.
  if (!Number.isFinite(rg) || rg <= 0 || rg > Math.max(r1, r2)) {
    return sverakRg(rho, lcM + lrTotal, areaM2, hM);
  }
  return rg;
}

// Eqs. 84–88: effective number of parallel conductors n = na·nb·nc·nd.
export function geometricFactorN(g: Pick<Ieee80Geometry, 'conductorM' | 'perimeterM' | 'areaM2' | 'lxM' | 'lyM'>): number {
  const na = (2 * g.conductorM) / g.perimeterM;
  const nb = Math.sqrt(g.perimeterM / (4 * Math.sqrt(g.areaM2))); // 1 for square
  const lxly = g.lxM * g.lyM;
  const nc = lxly > 0 && g.areaM2 > 0
    ? Math.pow(lxly / g.areaM2, (0.7 * g.areaM2) / lxly)
    : 1;
  const nd = 1; // 1 for square/rectangular (and near-rectangular) grids
  return Math.max(2, na * nb * nc * nd);
}

// Eq. 81: mesh spacing factor Km.
export function meshFactorKm(
  dM: number, hM: number, dCondM: number, n: number, perimeterRods: boolean
): number {
  const kh = Math.sqrt(1 + hM / 1); // Eq. 83, h0 = 1 m
  const kii = perimeterRods ? 1 : 1 / Math.pow(2 * n, 2 / n); // Eq. 82
  const t1 = (dM * dM) / (16 * hM * dCondM);
  const t2 = Math.pow(dM + 2 * hM, 2) / (8 * dM * dCondM);
  const t3 = hM / (4 * dCondM);
  return (1 / (2 * Math.PI)) *
    (Math.log(t1 + t2 - t3) + (kii / kh) * Math.log(8 / (Math.PI * (2 * n - 1))));
}

// Eq. 89: irregularity correction factor Ki.
export const irregularityKi = (n: number): number => 0.644 + 0.148 * n;

// Eq. 94: step spacing factor Ks (valid 0.25 m < h < 2.5 m).
export function stepFactorKs(dM: number, hM: number, n: number): number {
  return (1 / Math.PI) *
    (1 / (2 * hM) + 1 / (dM + hM) + (1 / dM) * (1 - Math.pow(0.5, n - 2)));
}

// Eq. 91: effective buried length for mesh voltage.
export function effectiveLengthLm(g: Ieee80Geometry): number {
  const lr = g.rodCount * g.rodLengthM;
  if (lr <= 0) return g.conductorM;
  const diag = Math.hypot(g.lxM, g.lyM);
  return g.conductorM + (1.55 + 1.22 * (g.rodLengthM / Math.max(1e-6, diag))) * lr;
}

// Eq. 93: effective buried length for step voltage.
export const effectiveLengthLs = (g: Ieee80Geometry): number =>
  0.75 * g.conductorM + 0.85 * g.rodCount * g.rodLengthM;

// Eq. 37 (simplified, Table 2): minimum conductor area in kcmil for
// commercial hard-drawn copper (Kf = 7.06, Tm = 1084 °C fusing).
export function requiredConductorKcmil(faultA: number, tcS: number): number {
  return (faultA / 1000) * 7.06 * Math.sqrt(tcS);
}

// ---------------------------------------------------------------------------
// Geometry from the screening GroundingPlan

export function geometryFromGroundingPlan(plan: GroundingPlan, rodLengthM: number): Ieee80Geometry {
  const s = plan.summary;
  const allLoopPts = (plan.loops ?? [plan.loop]).flat();
  const xs = allLoopPts.map(p => p.x);
  const ys = allLoopPts.map(p => p.y);
  const areaM2 = s.gridAreaSqFt * SQFT_TO_SQM;
  const perimeterM = s.loopLengthFt * FT_TO_M;
  const conductorM = s.totalConductorFt * FT_TO_M; // loop + interior grid + bonding taps (buried)
  const g = {
    areaM2,
    perimeterM,
    conductorM,
    rodCount: s.rodCount,
    rodLengthM,
    lxM: (Math.max(...xs) - Math.min(...xs)) * FT_TO_M,
    lyM: (Math.max(...ys) - Math.min(...ys)) * FT_TO_M,
    perimeterRods: s.rodCount > 0, // rods sit ON the loop by construction
  };
  // Effective parallel spacing for the sparse (loop + taps) grid: D ≈ √A/(n−1),
  // floored at 2 m so degenerate slivers can't blow up the log terms.
  const n = geometricFactorN(g);
  const spacingDM = Math.max(2, Math.sqrt(areaM2) / Math.max(1, n - 1));
  return { ...g, spacingDM };
}

// ---------------------------------------------------------------------------
// Full study

export interface Ieee80Study {
  inputs: Ieee80Inputs;
  geometry: Ieee80Geometry;
  cs: number;
  etouchV: number;
  estepV: number;
  df: number;
  igA: number;      // grid current IG = Df · Sf · 3I0
  rgOhm: number;    // grid resistance (Schwarz when rods, else Sverak)
  rgSverakOhm: number; // Sverak Eq. 57 with LT = Lc + rods (reference)
  gprV: number;
  n: number;
  km: number;
  ki: number;
  ks: number;
  emV: number;      // mesh (touch) voltage
  esV: number;      // step voltage
  requiredKcmil: number;
  conductorOk: boolean;
  gprBelowTouch: boolean; // GPR < Etouch → grid safe without further analysis
  touchPass: boolean;
  stepPass: boolean;
  overallPass: boolean;
  notes: string[];
}

export function buildIeee80Study(geometry: Ieee80Geometry, inputs: Ieee80Inputs): Ieee80Study {
  const g = geometry;
  const inp = inputs;
  const cs = surfaceDeratingCs(inp.soilRhoOhmM, inp.surfaceRhoOhmM, inp.surfaceThicknessM);
  const surfRhoEff = inp.surfaceThicknessM > 0 ? inp.surfaceRhoOhmM : inp.soilRhoOhmM;
  const etouchV = tolerableTouchV(cs, surfRhoEff, inp.faultDurationS, inp.bodyWeightKg);
  const estepV = tolerableStepV(cs, surfRhoEff, inp.faultDurationS, inp.bodyWeightKg);
  const df = decrementFactorDf(inp.xOverR, inp.faultDurationS);
  const igA = df * inp.splitFactorSf * inp.faultCurrentA;

  const lrTotal = g.rodCount * g.rodLengthM;
  const rgSverakOhm = sverakRg(inp.soilRhoOhmM, g.conductorM + lrTotal, g.areaM2, inp.burialDepthM);
  const rgOhm = g.rodCount > 0
    ? schwarzRg(inp.soilRhoOhmM, g.conductorM, g.areaM2, inp.burialDepthM,
        inp.conductorDiamM, g.rodCount, g.rodLengthM, 0.0159 /* 5/8" rod */, g.lxM, g.lyM)
    : rgSverakOhm;
  const gprV = igA * rgOhm;

  const n = geometricFactorN(g);
  const km = meshFactorKm(g.spacingDM, inp.burialDepthM, inp.conductorDiamM, n, g.perimeterRods);
  const ki = irregularityKi(n);
  const ks = stepFactorKs(g.spacingDM, inp.burialDepthM, n);
  const emV = (inp.soilRhoOhmM * km * ki * igA) / Math.max(1e-6, effectiveLengthLm(g));
  const esV = (inp.soilRhoOhmM * ks * ki * igA) / Math.max(1e-6, effectiveLengthLs(g));

  const requiredKcmil = requiredConductorKcmil(inp.faultCurrentA, inp.faultDurationS);
  const conductorOk = inp.conductorKcmil >= requiredKcmil;

  const gprBelowTouch = gprV <= etouchV;
  const touchPass = gprBelowTouch || emV <= etouchV;
  const stepPass = gprBelowTouch || esV <= estepV;
  const overallPass = touchPass && stepPass && conductorOk;

  const notes: string[] = [
    'Uniform soil model (single resistivity). Two-layer soil analysis is detailed-design scope.',
    `Current division factor Sf = ${inp.splitFactorSf.toFixed(2)} — Sf = 1.0 assumes the full fault current enters the grid (conservative).`,
    'Screening grid is a perimeter loop + interior row/column grid + bonding taps modeled as a sparse mesh (effective spacing D ≈ √A/(n−1)); results are screening-grade per IEEE 80 Annex D equations.',
  ];
  if (gprBelowTouch) {
    notes.push('GPR is below the tolerable touch voltage — the grid is safe without mesh/step analysis (IEEE 80 design procedure step 7).');
  }
  if (!touchPass) {
    notes.push('Mesh (touch) voltage exceeds the tolerable limit — add interior grid conductors (tighter spacing), more ground rods, or a thicker/higher-resistivity crushed-rock surface layer.');
  }
  if (!stepPass) {
    notes.push('Step voltage exceeds the tolerable limit — add perimeter rods or increase burial depth; verify soil resistivity with a field (Wenner) test.');
  }
  if (!conductorOk) {
    notes.push(`Grid conductor is undersized for the fault: requires ≥ ${requiredKcmil.toFixed(1)} kcmil copper (Eq. 37, hard-drawn Cu); installed ${inp.conductorKcmil.toFixed(1)} kcmil.`);
  }

  return {
    inputs: inp, geometry: g, cs, etouchV, estepV, df, igA, rgOhm, rgSverakOhm,
    gprV, n, km, ki, ks, emV, esV, requiredKcmil, conductorOk, gprBelowTouch,
    touchPass, stepPass, overallPass, notes,
  };
}

// Convenience wrapper from the screening plan.
export function buildIeee80StudyFromPlan(plan: GroundingPlan, inputs: Ieee80Inputs): Ieee80Study {
  return buildIeee80Study(geometryFromGroundingPlan(plan, inputs.rodLengthM), inputs);
}

// ---------------------------------------------------------------------------
// Numeric-field keys of Ieee80Inputs (bodyWeightKg is an enum, not a range).
export type Ieee80NumericKey = Exclude<keyof Ieee80Inputs, 'bodyWeightKg'>;

// Single source of truth for the sanitizer clamp ranges. The panel's number
// fields read min/max from here so what the drafter sees always matches what
// the sanitizer (and therefore the study math) will accept.
export const IEEE80_NUM_LIMITS: Record<Ieee80NumericKey, { min: number; max: number }> = {
  soilRhoOhmM: { min: 1, max: 100000 },
  surfaceRhoOhmM: { min: 1, max: 1000000 },
  surfaceThicknessM: { min: 0, max: 1 },
  faultCurrentA: { min: 100, max: 200000 },
  faultDurationS: { min: 0.05, max: 10 },
  splitFactorSf: { min: 0.05, max: 1 },
  xOverR: { min: 0, max: 100 },
  burialDepthM: { min: 0.25, max: 2.5 },
  rodLengthM: { min: 1, max: 30 },
  conductorDiamM: { min: 0.003, max: 0.05 },
  conductorKcmil: { min: 10, max: 2000 },
};

// Input sanitization for persisted (localStorage) prefs — untrusted JSON.
export function sanitizeIeee80Inputs(v: unknown): Ieee80Inputs {
  const d = DEFAULT_IEEE80_INPUTS;
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { ...d };
  const o = v as Record<string, unknown>;
  const num = (k: Ieee80NumericKey): number => {
    const x = o[k];
    const { min, max } = IEEE80_NUM_LIMITS[k];
    return typeof x === 'number' && Number.isFinite(x) && x >= min && x <= max ? x : d[k];
  };
  return {
    soilRhoOhmM: num('soilRhoOhmM'),
    surfaceRhoOhmM: num('surfaceRhoOhmM'),
    surfaceThicknessM: num('surfaceThicknessM'),
    faultCurrentA: num('faultCurrentA'),
    faultDurationS: num('faultDurationS'),
    splitFactorSf: num('splitFactorSf'),
    xOverR: num('xOverR'),
    bodyWeightKg: o.bodyWeightKg === 50 ? 50 : 70,
    burialDepthM: num('burialDepthM'),
    rodLengthM: num('rodLengthM'),
    conductorDiamM: num('conductorDiamM'),
    conductorKcmil: num('conductorKcmil'),
  };
}
