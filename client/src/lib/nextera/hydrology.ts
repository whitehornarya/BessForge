// Design-grade hydrology engines (TR-55 / NRCS / HDS-5) for the drainage
// package. Pure + deterministic (no Date, no randomness) so every function
// runs in Node tests against published hand-math anchors.
//
//   * TR-55 segmental time of concentration: sheet flow (Manning kinematic),
//     shallow concentrated flow (unpaved velocity relation) and channel flow.
//   * NRCS curve-number runoff + SCS dimensionless unit hydrograph for the
//     24-hr Type II / Type III design storms (tabulated cumulative fractions,
//     PRF 484).
//   * Level-pool (Modified Puls) detention routing over a square prismoidal
//     basin with a two-stage outlet (low-flow orifice + overflow weir),
//     including outlet auto-sizing against a pre-development peak target.
//   * FHWA HDS-5 outlet-control culvert headwater (tailwater + entrance /
//     friction / exit losses) with circular critical depth.
//
// SCREENING/DESIGN SUPPORT ONLY — never imported by dxfExport/dxfSheets;
// default exports stay byte-identical with every feature off.

// ---------------------------------------------------------------------------
// TR-55 time of concentration (segment method).

export interface Tr55Segments {
  sheetLenFt: number;      // sheet-flow length (TR-55 caps at 100 ft)
  sheetSlope: number;      // ft/ft
  sheetN: number;          // Manning n for sheet flow (TR-55 Table 3-1)
  p2In: number;            // 2-yr 24-hr rainfall, inches
  shallowLenFt: number;    // shallow concentrated flow length
  shallowSlope: number;    // ft/ft
  shallowPaved: boolean;   // paved vs unpaved velocity relation
  channelLenFt: number;    // channel flow length
  channelVelFps: number;   // channel velocity (Manning, from the section)
}

export interface Tr55Tc {
  sheetMin: number;
  shallowMin: number;
  channelMin: number;
  totalMin: number;        // floored at 5 min
  sheetLenFt: number;
  shallowLenFt: number;
  channelLenFt: number;
  overridden?: boolean;    // manual override applied to totalMin
}

// TR-55 Chapter 3: Tt(sheet, hr) = 0.007 (nL)^0.8 / (P2^0.5 s^0.4), L <= 100 ft.
// Shallow concentrated V (fps) = 16.1345 sqrt(s) unpaved, 20.3282 sqrt(s) paved.
export function tr55TimeOfConcentration(seg: Tr55Segments): Tr55Tc {
  const sheetLenFt = Math.max(0, Math.min(100, seg.sheetLenFt));
  const sSheet = Math.max(seg.sheetSlope, 0.005);
  const p2 = Math.max(seg.p2In, 0.5);
  const sheetHr = sheetLenFt > 0
    ? 0.007 * Math.pow(seg.sheetN * sheetLenFt, 0.8) / (Math.sqrt(p2) * Math.pow(sSheet, 0.4))
    : 0;
  const sShallow = Math.max(seg.shallowSlope, 0.005);
  const vShallow = (seg.shallowPaved ? 20.3282 : 16.1345) * Math.sqrt(sShallow);
  const shallowMin = seg.shallowLenFt > 0 ? seg.shallowLenFt / vShallow / 60 : 0;
  const channelMin = seg.channelLenFt > 0 && seg.channelVelFps > 0
    ? seg.channelLenFt / seg.channelVelFps / 60
    : 0;
  const sheetMin = sheetHr * 60;
  const totalMin = Math.max(5, sheetMin + shallowMin + channelMin);
  return {
    sheetMin, shallowMin, channelMin, totalMin,
    sheetLenFt, shallowLenFt: Math.max(0, seg.shallowLenFt), channelLenFt: Math.max(0, seg.channelLenFt),
  };
}

// ---------------------------------------------------------------------------
// NRCS curve-number runoff.

// Q (in) = (P - 0.2S)^2 / (P + 0.8S), S = 1000/CN - 10 (P, Q inches).
export function scsRunoffIn(rainIn: number, cn: number): number {
  const c = Math.min(98, Math.max(30, cn));
  const s = 1000 / c - 10;
  const ia = 0.2 * s;
  if (rainIn <= ia) return 0;
  return ((rainIn - ia) * (rainIn - ia)) / (rainIn + 0.8 * s);
}

// SCS 24-hr cumulative rainfall distributions (fraction of the 24-hr depth
// at each hour, NRCS TR-55 / NEH-4 tabulations; linear interpolation
// between the hourly points is the standard practice for coarse steps).
export type ScsStormType = 'II' | 'III';

const TYPE_II_HOURLY: number[] = [
  0.000, 0.011, 0.022, 0.035, 0.048, 0.063, 0.080, 0.098, 0.120, 0.147,
  0.181, 0.235, 0.663, 0.772, 0.820, 0.854, 0.880, 0.898, 0.916, 0.930,
  0.944, 0.958, 0.972, 0.986, 1.000,
];

const TYPE_III_HOURLY: number[] = [
  0.000, 0.010, 0.020, 0.031, 0.043, 0.057, 0.072, 0.091, 0.114, 0.146,
  0.189, 0.250, 0.500, 0.750, 0.811, 0.854, 0.886, 0.910, 0.928, 0.943,
  0.957, 0.969, 0.981, 0.991, 1.000,
];

export function scsCumulativeFraction(type: ScsStormType, hr: number): number {
  const tab = type === 'III' ? TYPE_III_HOURLY : TYPE_II_HOURLY;
  if (hr <= 0) return 0;
  if (hr >= 24) return 1;
  const i = Math.floor(hr);
  const f = hr - i;
  return tab[i] + (tab[i + 1] - tab[i]) * f;
}

// SCS dimensionless unit hydrograph (PRF 484), t/Tp vs q/qp (NEH-4 table).
const DUH: Array<[number, number]> = [
  [0.0, 0.000], [0.1, 0.030], [0.2, 0.100], [0.3, 0.190], [0.4, 0.310],
  [0.5, 0.470], [0.6, 0.660], [0.7, 0.820], [0.8, 0.930], [0.9, 0.990],
  [1.0, 1.000], [1.1, 0.990], [1.2, 0.930], [1.3, 0.860], [1.4, 0.780],
  [1.5, 0.680], [1.6, 0.560], [1.7, 0.460], [1.8, 0.390], [1.9, 0.330],
  [2.0, 0.280], [2.2, 0.207], [2.4, 0.147], [2.6, 0.107], [2.8, 0.077],
  [3.0, 0.055], [3.2, 0.040], [3.4, 0.029], [3.6, 0.021], [3.8, 0.015],
  [4.0, 0.011], [4.5, 0.005], [5.0, 0.000],
];

function duhOrdinate(tOverTp: number): number {
  if (tOverTp <= 0 || tOverTp >= 5) return 0;
  for (let i = 1; i < DUH.length; i++) {
    if (tOverTp <= DUH[i][0]) {
      const [x0, y0] = DUH[i - 1];
      const [x1, y1] = DUH[i];
      return y0 + (y1 - y0) * ((tOverTp - x0) / (x1 - x0));
    }
  }
  return 0;
}

export interface ScsHydrographInputs {
  areaAcres: number;
  cn: number;
  rain24In: number;
  stormType: ScsStormType;
  tcMin: number;
}

export interface Hydrograph {
  dtMin: number;
  ordinatesCfs: number[];   // at t = 0, dt, 2dt, ...
  peakCfs: number;
  peakAtMin: number;
  volumeCf: number;
  runoffIn: number;
}

// 24-hr SCS storm hydrograph by convolving incremental runoff excess with
// the dimensionless unit hydrograph (lag = 0.6 Tc, Tp = dt/2 + lag,
// qp = 484 A Q / Tp with A in sq mi, Tp in hr).
export function scsStormHydrograph(inp: ScsHydrographInputs, dtMin = 6, durationHr = 30): Hydrograph {
  const dtHr = dtMin / 60;
  const lagHr = 0.6 * (inp.tcMin / 60);
  const tpHr = dtHr / 2 + lagHr;
  const areaSqMi = inp.areaAcres / 640;
  const runoffIn = scsRunoffIn(inp.rain24In, inp.cn);
  const nSteps = Math.round((durationHr * 60) / dtMin);
  // Incremental excess per step (inches).
  const excess: number[] = [];
  let prevQ = 0;
  for (let k = 1; k <= nSteps; k++) {
    const hr = k * dtHr;
    const p = inp.rain24In * scsCumulativeFraction(inp.stormType, hr);
    const q = scsRunoffIn(p, inp.cn);
    excess.push(Math.max(0, q - prevQ));
    prevQ = q;
  }
  // Unit-hydrograph kernel for 1 inch of excess in one dt.
  const qpUnit = tpHr > 0 ? (484 * areaSqMi * 1) / tpHr : 0;
  const kernelSteps = Math.ceil((5 * tpHr) / dtHr);
  const kernel: number[] = [];
  for (let k = 0; k <= kernelSteps; k++) {
    kernel.push(qpUnit * duhOrdinate((k * dtHr) / tpHr));
  }
  // Convolution.
  const ords = new Array<number>(nSteps + kernel.length).fill(0);
  for (let i = 0; i < excess.length; i++) {
    const e = excess[i];
    if (e <= 0) continue;
    for (let k = 0; k < kernel.length; k++) {
      ords[i + 1 + k] += e * kernel[k];
    }
  }
  // Trim trailing zeros (keep one).
  let last = ords.length - 1;
  while (last > 0 && ords[last] === 0) last--;
  const ordinatesCfs = ords.slice(0, last + 2);
  let peakCfs = 0, peakAt = 0, volumeCf = 0;
  for (let i = 0; i < ordinatesCfs.length; i++) {
    if (ordinatesCfs[i] > peakCfs) { peakCfs = ordinatesCfs[i]; peakAt = i; }
    volumeCf += ordinatesCfs[i] * dtMin * 60;
  }
  return { dtMin, ordinatesCfs, peakCfs, peakAtMin: peakAt * dtMin, volumeCf, runoffIn };
}

// ---------------------------------------------------------------------------
// Level-pool (Modified Puls) detention routing.

export interface BasinGeometry {
  bottomWFt: number;       // basin bottom width (short side)
  sideSlopeH: number;      // interior side slopes, H per 1 V
  depthFt: number;         // total constructed depth (top of bank)
  // Optional rectangular plan: bottom length = aspect × bottom width.
  // Absent (or 1) keeps the legacy square prismoid exactly.
  aspect?: number;
}

// Storage below stage h for a rectangular prismoid with side slope z,
// bottom width bw and bottom length a·bw (a = aspect, 1 = square):
// w(h') = bw + 2 z h', l(h') = a·bw + 2 z h'
// S(h) = ∫ w l dh' = a·bw² h + (1+a)·bw z h² + (4/3) z² h³
// (exact integral; a = 1 reduces to the legacy square formula).
export function basinStorageCf(geo: BasinGeometry, stageFt: number): number {
  const h = Math.max(0, Math.min(geo.depthFt, stageFt));
  const bw = geo.bottomWFt, z = geo.sideSlopeH;
  const a = geo.aspect && geo.aspect > 0 ? geo.aspect : 1;
  return a * bw * bw * h + (1 + a) * bw * z * h * h + (4 / 3) * z * z * h * h * h;
}

export interface OutletStructure {
  orificeDiaIn: number;    // low-flow orifice (invert at basin bottom)
  orificeCd: number;       // discharge coefficient (0.60 typical)
  weirCrestFt: number;     // overflow weir crest stage above basin bottom
  weirLengthFt: number;    // weir crest length
  weirCw: number;          // weir coefficient (3.0 broad-crested)
  // Optional second-stage riser orifice: invert at riserCrestFt above the
  // basin bottom. Absent (or diameter 0) keeps the legacy two-stage rating.
  riserDiaIn?: number;
  riserCrestFt?: number;
}

// One circular-orifice rating with the invert at `invertFt`: partial-
// submergence branch below one diameter of local head, then the standard
// submerged equation with head to the centerline. Continuous and monotone
// through the transition (regression-tested).
function orificeRatingCfs(diaIn: number, cd: number, invertFt: number, stageFt: number): number {
  const g = 32.2;
  const d = diaIn / 12;
  const h = stageFt - invertFt;   // local head above the orifice invert
  if (!(h > 0) || !(d > 0)) return 0;
  const a = Math.PI * d * d / 4;
  if (h <= d) return cd * a * (h / d) * Math.sqrt(2 * g * (h / 2));
  return cd * a * Math.sqrt(2 * g * (h - d / 2));
}

// Combined outlet rating at stage h (ft above the basin bottom).
export function outletDischargeCfs(out: OutletStructure, stageFt: number): number {
  let q = orificeRatingCfs(out.orificeDiaIn, out.orificeCd, 0, stageFt);
  if (out.riserDiaIn && out.riserDiaIn > 0) {
    q += orificeRatingCfs(out.riserDiaIn, out.orificeCd, out.riserCrestFt ?? 0, stageFt);
  }
  if (stageFt > out.weirCrestFt && out.weirLengthFt > 0) {
    const hw = stageFt - out.weirCrestFt;
    q += out.weirCw * out.weirLengthFt * Math.pow(hw, 1.5);
  }
  return q;
}

export interface RoutingResult {
  peakInflowCfs: number;
  peakOutflowCfs: number;
  maxStageFt: number;
  maxStorageCf: number;
  drawdownHr: number;      // time from peak stage to stage < 0.1 ft (capped)
  overtopped: boolean;     // stage reached the constructed depth
  outflow: number[];       // outflow ordinates at the inflow dt
  stage: number[];         // stage ordinates at the inflow dt
}

// Screening estimate of the storage a basin must hold to cap the release at
// allowableCfs: max over time of (cumulative inflow − allowable release).
export function estimateRequiredStorageCf(inflow: Hydrograph, allowableCfs: number): number {
  const dtSec = inflow.dtMin * 60;
  let cum = 0, best = 0;
  for (let i = 0; i < inflow.ordinatesCfs.length; i++) {
    cum += (inflow.ordinatesCfs[i] - allowableCfs) * dtSec;
    if (cum < 0) cum = 0;
    if (cum > best) best = cum;
  }
  return best;
}

// Level-pool routing in stage form: dh/dt = (I(t) − O(h)) / A(h) with the
// exact water-surface area A(h) = (bw + 2 z h)^2 — no storage inversion
// needed. Fine sub-stepping keeps it stable and deterministic; equivalent
// to Modified Puls at small steps.
export function routeLevelPool(
  inflow: Hydrograph, geo: BasinGeometry, out: OutletStructure, maxHr = 96
): RoutingResult {
  const dtSec = inflow.dtMin * 60;
  const nSub = 24;
  const subSec = dtSec / nSub;
  const nExtra = Math.max(0, Math.round((maxHr * 3600) / dtSec) - inflow.ordinatesCfs.length);
  const inOrds = [...inflow.ordinatesCfs, ...new Array<number>(nExtra).fill(0)];
  const aspect = geo.aspect && geo.aspect > 0 ? geo.aspect : 1;
  const areaAt = (h: number): number => {
    const hh = Math.max(0, h);
    const w = geo.bottomWFt + 2 * geo.sideSlopeH * hh;
    const l = geo.bottomWFt * aspect + 2 * geo.sideSlopeH * hh;
    return Math.max(1, w * l);
  };
  let h = 0;
  let peakOut = 0, maxStage = 0;
  let peakStageAtSec = 0, drawdownAtSec = -1;
  const outflow: number[] = [0];
  const stage: number[] = [0];
  let overtopped = false;
  for (let i = 0; i + 1 < inOrds.length; i++) {
    for (let k = 0; k < nSub; k++) {
      const f = (k + 0.5) / nSub;
      const inflowNow = inOrds[i] + (inOrds[i + 1] - inOrds[i]) * f;
      const o = outletDischargeCfs(out, h);
      h = h + ((inflowNow - o) / areaAt(h)) * subSec;
      if (h < 0) h = 0;
      if (h >= geo.depthFt) { h = geo.depthFt; overtopped = true; }
      if (h > maxStage) {
        maxStage = h;
        peakStageAtSec = i * dtSec + (k + 1) * subSec;
      }
      if (o > peakOut) peakOut = o;
    }
    outflow.push(outletDischargeCfs(out, h));
    stage.push(h);
    if (drawdownAtSec < 0 && maxStage > 0.1 && h < 0.1 && (i + 1) * dtSec > peakStageAtSec) {
      drawdownAtSec = (i + 1) * dtSec;
    }
  }
  const maxStorage = basinStorageCf(geo, maxStage);
  let peakIn = 0;
  for (const v of inflow.ordinatesCfs) if (v > peakIn) peakIn = v;
  const drawdownHr = drawdownAtSec >= 0
    ? (drawdownAtSec - peakStageAtSec) / 3600
    : maxHr;
  return {
    peakInflowCfs: peakIn,
    peakOutflowCfs: peakOut,
    maxStageFt: maxStage,
    maxStorageCf: maxStorage,
    drawdownHr,
    overtopped,
    outflow,
    stage,
  };
}

// Outlet auto-sizing: pick the largest ladder orifice whose routed peak
// stays at or below the allowable release, with the overflow weir crest set
// above the routed design stage (freeboard below top of bank). Grows the
// basin bottom width when even the smallest orifice overtops.
export const ORIFICE_DIA_LADDER_IN = [4, 6, 8, 10, 12, 15, 18, 24, 30, 36];

export interface DetentionDesignResult {
  geo: BasinGeometry;
  outlet: OutletStructure;
  routing: RoutingResult;
  meetsRelease: boolean;   // routed peak <= allowable
  freeboardFt: number;     // top of bank − routed max stage
  grownBasin: boolean;     // basin had to be enlarged beyond the initial geometry
}

export function designDetentionOutlet(
  inflow: Hydrograph,
  allowableCfs: number,
  geo0: BasinGeometry,
  freeboardReqFt: number,
  riser?: { diaIn: number; crestFt: number },
): DetentionDesignResult {
  const weirCw = 3.0, orificeCd = 0.6;
  let geo = { ...geo0 };
  let grown = false;
  for (let grow = 0; grow < 40; grow++) {
    // Weir crest: reserve the required freeboard at the top of bank.
    const crest = Math.max(0.5, geo.depthFt - Math.max(0.5, freeboardReqFt));
    let best: DetentionDesignResult | null = null;
    for (let di = ORIFICE_DIA_LADDER_IN.length - 1; di >= 0; di--) {
      const outlet: OutletStructure = {
        orificeDiaIn: ORIFICE_DIA_LADDER_IN[di],
        orificeCd,
        weirCrestFt: crest,
        weirLengthFt: 10,
        weirCw,
      };
      if (riser && riser.diaIn > 0) {
        outlet.riserDiaIn = riser.diaIn;
        outlet.riserCrestFt = Math.max(0, Math.min(crest, riser.crestFt));
      }
      const routing = routeLevelPool(inflow, geo, outlet);
      const meets = routing.peakOutflowCfs <= allowableCfs * (1 + 1e-6);
      const stageOk = routing.maxStageFt <= crest + 1e-6 && !routing.overtopped;
      if (meets && stageOk) {
        return {
          geo, outlet, routing,
          meetsRelease: true,
          freeboardFt: geo.depthFt - routing.maxStageFt,
          grownBasin: grown,
        };
      }
      if (di === 0) {
        best = {
          geo, outlet, routing,
          meetsRelease: meets,
          freeboardFt: geo.depthFt - routing.maxStageFt,
          grownBasin: grown,
        };
      }
    }
    // Even the smallest orifice pushes the stage past the crest — enlarge.
    if (best && (best.routing.maxStageFt > crest || best.routing.overtopped)) {
      geo = { ...geo, bottomWFt: geo.bottomWFt + 10 };
      grown = true;
      continue;
    }
    if (best) return best;
  }
  // Bounded fallback (never expected): smallest orifice on the grown basin.
  const fallbackCrest = Math.max(0.5, geo.depthFt - Math.max(0.5, freeboardReqFt));
  const outlet: OutletStructure = {
    orificeDiaIn: ORIFICE_DIA_LADDER_IN[0], orificeCd,
    weirCrestFt: fallbackCrest,
    weirLengthFt: 10, weirCw,
  };
  if (riser && riser.diaIn > 0) {
    outlet.riserDiaIn = riser.diaIn;
    outlet.riserCrestFt = Math.max(0, Math.min(fallbackCrest, riser.crestFt));
  }
  const routing = routeLevelPool(inflow, geo, outlet);
  return {
    geo, outlet, routing,
    meetsRelease: routing.peakOutflowCfs <= allowableCfs,
    freeboardFt: geo.depthFt - routing.maxStageFt,
    grownBasin: true,
  };
}

// ---------------------------------------------------------------------------
// HDS-5 outlet-control culvert headwater.

// Critical depth in a circular section by bisection on Q^2 T = g A^3.
export function circularCriticalDepthFt(qCfs: number, diaFt: number): number {
  if (!(qCfs > 0) || !(diaFt > 0)) return 0;
  const g = 32.2;
  const r = diaFt / 2;
  const seg = (y: number): { a: number; t: number } => {
    const yy = Math.max(1e-9, Math.min(diaFt - 1e-9, y));
    const th = 2 * Math.acos(1 - yy / r);
    const a = (r * r / 2) * (th - Math.sin(th));
    const t = 2 * Math.sqrt(Math.max(0, yy * (diaFt - yy)));
    return { a, t };
  };
  const f = (y: number): number => {
    const { a, t } = seg(y);
    return qCfs * qCfs * t - g * a * a * a;
  };
  // f > 0 when flow is supercritical at depth y (depth below critical).
  if (f(diaFt - 1e-6) > 0) return diaFt; // flows full before reaching critical
  let lo = 1e-6, hi = diaFt - 1e-6;
  for (let it = 0; it < 60; it++) {
    const mid = (lo + hi) / 2;
    if (f(mid) > 0) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

export interface OutletControlInputs {
  qCfs: number;
  diaIn: number;
  lengthFt: number;
  slopeFtFt: number;
  tailwaterFt: number;     // tailwater depth above the outlet invert
  ke?: number;             // entrance loss coefficient (0.5 square edge)
  manningN?: number;       // barrel roughness (0.012 concrete)
}

export interface OutletControlResult {
  hwFt: number;            // headwater above the inlet invert
  hoFt: number;            // effective tailwater datum max(TW, (dc+D)/2)
  lossesFt: number;        // (1 + ke + 29 n^2 L / R^1.33) V^2 / 2g
  criticalDepthFt: number;
}

// HDS-5 outlet control (full-flow approximation): HW = ho + H − S·L with
// H = (1 + ke + 29 n^2 L / R^1.33) V^2/2g, ho = max(TW, (dc + D)/2).
export function culvertOutletControl(inp: OutletControlInputs): OutletControlResult {
  const g = 32.2;
  const d = inp.diaIn / 12;
  const ke = inp.ke ?? 0.5;
  const n = inp.manningN ?? 0.012;
  const a = Math.PI * d * d / 4;
  const v = inp.qCfs > 0 && a > 0 ? inp.qCfs / a : 0;
  const rHyd = d / 4;
  const losses = (1 + ke + (29 * n * n * inp.lengthFt) / Math.pow(rHyd, 4 / 3)) * (v * v) / (2 * g);
  const dc = Math.min(circularCriticalDepthFt(inp.qCfs, d), d);
  const ho = Math.max(inp.tailwaterFt, (dc + d) / 2);
  const hw = ho + losses - inp.slopeFtFt * inp.lengthFt;
  return { hwFt: hw, hoFt: ho, lossesFt: losses, criticalDepthFt: dc };
}
