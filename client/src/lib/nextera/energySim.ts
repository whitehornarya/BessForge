// Dispatch / energy simulation for the BESS yard: AC-PoC round-trip
// efficiency chain, year-by-year capacity degradation, and augmentation-year
// planning against the layout's reserved augmentation zones.
//
// Pure, deterministic calculation module — no store, no DOM, no exporter
// imports. Everything here is screening-grade 10%-design math with the
// sources documented inline; the report and panel surface the same notes.
//
// REFERENCES (surfaced in EnergySimResult.notes):
// [1] IEC 62933-2-1:2017 — Electrical energy storage (EES) systems, unit
//     parameters and test methods. Round-trip efficiency is defined at the
//     AC point of connection over full rated charge/discharge cycles and
//     INCLUDES auxiliary consumption (HVAC, controls). DC-terminal RTE is
//     never reported as system RTE here.
// [2] LG ES JF2 DC LINK 5.1 product spec (F2D4-5.1US-GN04): LFP DC-DC
//     round-trip efficiency ≈ 94% at nominal duty; auxiliary (HVAC +
//     controls) load served from the 480 V aux system.
// [3] PE FREEMAQ PCSM FP4200M datasheet Rev 1-17 / GE Vernova FLEXINVERTER
//     X88036-R008: CEC-weighted PCS efficiency ≈ 98.5% (MV skid, inverter
//     stage). Applied once per direction.
// [4] IEEE C57.12.00 / typical 34.5 kV pad-mount transformer loss data:
//     no-load ≈ 0.1% of rating (always on), load loss ≈ 0.8% of rating at
//     full load. The MV transformer is part of the PCS skid in these
//     configurations.
// [5] MV collection cable I²R at rated power from the same NEC Ch.9 Table 8
//     resistances the feeder sizing uses (CONDUCTOR_R_PER_KFT); when no
//     feeders are routed a 0.5% screening default is used.
// [6] NREL semi-empirical Li-ion life model form (Smith et al., NREL
//     BLAST publications): capacity fade = calendar fade ∝ √t with an
//     Arrhenius temperature acceleration, plus cycle fade proportional to
//     equivalent full cycles with a √DOD stress factor. Coefficients below
//     are calibrated to LFP warranty-class behavior: ~2.8%/√yr calendar at
//     25 °C cell temperature, and 20% cycle fade at 5,000 EFC @ 100% DOD.
// [7] Dispatch is the IEC 62933-2-1 standard-cycle framing: N full
//     cycles/day at rated power — NOT price-arbitrage optimization.

export const HOURS_PER_YEAR = 8760;
export const DAYS_PER_YEAR = 365;

// --- Loss chain defaults (fractions) ---------------------------------------
export const DEFAULT_BATTERY_RTE_DC = 0.94;    // [2] LFP DC-DC round trip
export const DEFAULT_PCS_EFF = 0.985;          // [3] CEC-weighted, one way
export const XFMR_NO_LOAD_FRAC = 0.001;        // [4] 0.1% of rating
export const XFMR_LOAD_LOSS_FRAC = 0.008;      // [4] 0.8% of rating @ full load
export const DEFAULT_CABLE_LOSS_FRAC = 0.005;  // [5] fallback when unrouted
export const DEFAULT_AUX_KW_PER_CONTAINER = 3.5; // [2] HVAC+controls annual avg

// --- Degradation coefficients [6] -------------------------------------------
export const CAL_FADE_PER_SQRT_YEAR = 0.028;   // fraction/√yr at Tref cell temp
export const CAL_REF_TEMP_C = 25;              // Arrhenius reference
export const CAL_ACTIVATION_EA_J = 24500;      // J/mol (fade ~doubles per +12 °C)
export const GAS_CONSTANT_R = 8.314;           // J/(mol·K)
export const CYC_FADE_PER_EFC_100DOD = 0.2 / 5000; // 20% at 5000 EFC @100% DOD
export const CELL_TEMP_RISE_C = 5;             // avg cell temp above site ambient
export const SOH_FLOOR = 0.5;                  // model validity floor

// ---------------------------------------------------------------------------
export interface EnergySimInputs {
  cyclesPerDay: number;      // standard cycles per day [7] (0.1–4)
  avgAmbientC: number;       // site annual-average ambient (°C, −20–50)
  projectLifeYears: number;  // simulation horizon (1–40)
  contractMWh: number;       // contracted usable energy; 0 = no augmentation planning
  dodPct: number;            // depth of discharge per cycle (10–100)
  batteryRteDc: number;      // override: battery DC-DC RTE (0.7–1)
  pcsEff: number;            // override: PCS one-way efficiency (0.9–1)
  auxKwPerContainer: number; // override: avg aux load per container (0–20 kW)
}

export const DEFAULT_ENERGY_SIM_INPUTS: EnergySimInputs = {
  cyclesPerDay: 1,
  avgAmbientC: 20,
  projectLifeYears: 20,
  contractMWh: 0,
  dodPct: 90,
  batteryRteDc: DEFAULT_BATTERY_RTE_DC,
  pcsEff: DEFAULT_PCS_EFF,
  auxKwPerContainer: DEFAULT_AUX_KW_PER_CONTAINER,
};

const clamp = (v: unknown, lo: number, hi: number, dflt: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt;

// Numeric-field keys of EnergySimInputs (all fields are numeric).
export type EnergySimNumericKey = keyof EnergySimInputs;

// Single source of truth for the sanitizer clamp ranges. The panel's number
// fields read min/max from here so what the drafter sees always matches what
// the sanitizer (and therefore every export) will accept.
export const ENERGY_SIM_NUM_LIMITS: Record<EnergySimNumericKey, { min: number; max: number }> = {
  cyclesPerDay: { min: 0.1, max: 4 },
  avgAmbientC: { min: -20, max: 50 },
  projectLifeYears: { min: 1, max: 40 },
  contractMWh: { min: 0, max: 50000 },
  dodPct: { min: 10, max: 100 },
  batteryRteDc: { min: 0.7, max: 1 },
  pcsEff: { min: 0.9, max: 1 },
  auxKwPerContainer: { min: 0, max: 20 },
};

const clampK = (o: Partial<EnergySimInputs>, k: EnergySimNumericKey): number =>
  clamp(o[k], ENERGY_SIM_NUM_LIMITS[k].min, ENERGY_SIM_NUM_LIMITS[k].max, DEFAULT_ENERGY_SIM_INPUTS[k]);

// Untrusted-input companion (project files / autosaves are hand-editable):
// every field clamps to its engineering range, non-finite/absent values snap
// to the documented default — same policy as sanitizeIeee80Inputs.
export function sanitizeEnergySimInputs(v: unknown): EnergySimInputs {
  const o = (v && typeof v === 'object' && !Array.isArray(v) ? v : {}) as Partial<EnergySimInputs>;
  return {
    cyclesPerDay: clampK(o, 'cyclesPerDay'),
    avgAmbientC: clampK(o, 'avgAmbientC'),
    projectLifeYears: Math.round(clampK(o, 'projectLifeYears')),
    contractMWh: clampK(o, 'contractMWh'),
    dodPct: clampK(o, 'dodPct'),
    batteryRteDc: clampK(o, 'batteryRteDc'),
    pcsEff: clampK(o, 'pcsEff'),
    auxKwPerContainer: clampK(o, 'auxKwPerContainer'),
  };
}

// ---------------------------------------------------------------------------
// RTE chain at the AC point of connection [1]
// ---------------------------------------------------------------------------
export interface RteBreakdown {
  batteryRteDcPct: number;   // DC-DC round trip [2]
  pcsOneWayPct: number;      // per direction [3]
  xfmrOneWayPct: number;     // per direction at rated load [4]
  cableOneWayPct: number;    // per direction at rated load [5]
  auxPct: number;            // aux energy as % of daily charge energy [1][2]
  acRtePct: number;          // system RTE at AC PoC incl. aux [1]
  acRteExAuxPct: number;     // AC-terminal RTE excluding aux (for reference)
  dailyDischargeMWh: number; // AC energy delivered per day at the PoC
  dailyChargeMWh: number;    // AC energy drawn per day at the PoC (excl. aux)
  dailyAuxMWh: number;       // auxiliary energy per day
}

export interface RtePlantParams {
  usableMWhPerCycle: number; // energy cycled through the DC bus per cycle (BOL·DOD)
  containers: number;        // BESS container count (drives aux load)
  cableLossFrac: number;     // one-way MV collection I²R loss fraction at rated power [5]
  cyclesPerDay: number;
}

export function buildRteBreakdown(p: RtePlantParams, inp: EnergySimInputs): RteBreakdown {
  const pcs = inp.pcsEff;
  const xfmr = 1 - XFMR_NO_LOAD_FRAC - XFMR_LOAD_LOSS_FRAC; // one way at rated load [4]
  const cable = 1 - Math.min(0.05, Math.max(0, p.cableLossFrac));
  const oneWayBop = pcs * xfmr * cable;
  // Battery cycle: discharging E_dc from the cells requires E_dc / rteDc in.
  const eDc = Math.max(0, p.usableMWhPerCycle) * Math.max(0, p.cyclesPerDay);
  const dailyDischargeMWh = eDc * oneWayBop;
  const dailyChargeMWh = eDc === 0 ? 0 : (eDc / inp.batteryRteDc) / oneWayBop;
  const dailyAuxMWh = (inp.auxKwPerContainer * p.containers * 24) / 1000;
  const denom = dailyChargeMWh + dailyAuxMWh;
  const acRte = denom > 0 ? dailyDischargeMWh / denom : 0;
  const acRteExAux = dailyChargeMWh > 0 ? dailyDischargeMWh / dailyChargeMWh : 0;
  return {
    batteryRteDcPct: inp.batteryRteDc * 100,
    pcsOneWayPct: pcs * 100,
    xfmrOneWayPct: xfmr * 100,
    cableOneWayPct: cable * 100,
    auxPct: dailyChargeMWh > 0 ? (dailyAuxMWh / dailyChargeMWh) * 100 : 0,
    acRtePct: acRte * 100,
    acRteExAuxPct: acRteExAux * 100,
    dailyDischargeMWh,
    dailyChargeMWh,
    dailyAuxMWh,
  };
}

// ---------------------------------------------------------------------------
// Degradation [6]
// ---------------------------------------------------------------------------

// Arrhenius acceleration factor relative to the 25 °C reference cell temp.
export function arrheniusFactor(cellTempC: number): number {
  const t = cellTempC + 273.15;
  const tref = CAL_REF_TEMP_C + 273.15;
  return Math.exp((CAL_ACTIVATION_EA_J / GAS_CONSTANT_R) * (1 / tref - 1 / t));
}

// State of health of one cohort after `years` in service.
export function cohortSoh(years: number, inp: EnergySimInputs): number {
  if (years <= 0) return 1;
  const cellTempC = inp.avgAmbientC + CELL_TEMP_RISE_C;
  const qCal = CAL_FADE_PER_SQRT_YEAR * arrheniusFactor(cellTempC) * Math.sqrt(years);
  const efc = inp.cyclesPerDay * DAYS_PER_YEAR * years;
  const qCyc = CYC_FADE_PER_EFC_100DOD * efc * Math.sqrt(inp.dodPct / 100);
  return Math.max(SOH_FLOOR, 1 - qCal - qCyc);
}

// ---------------------------------------------------------------------------
// Full simulation with cohort-based augmentation planning
// ---------------------------------------------------------------------------
export interface EnergySimYear {
  year: number;            // 1-based operating year
  sohPct: number;          // capacity-weighted fleet SOH at END of year
  usableMWh: number;       // Σ cohort BOL MWh × SOH at end of year
  contractMWh: number;     // 0 when no contract entered
  augAddedMWh: number;     // nameplate MWh installed at START of this year
  augAddedContainers: number;
  dischargedMWh: number;   // AC energy delivered at the PoC this year
  efc: number;             // equivalent full cycles this year
}

export interface AugmentationEvent {
  year: number;
  mwh: number;         // nameplate MWh added
  containers: number;  // LG JF2-class containers added
}

export interface EnergySimPlantParams {
  bolMWh: number;            // beginning-of-life nameplate energy (achieved MWh)
  containers: number;        // installed BESS containers
  containerMWh: number;      // MWh per container (augmentation granularity)
  containersPerBlock: number;// containers per augmentation block
  augZoneBlocks: number;     // reserved augmentation-zone block capacity
  cableLossFrac: number;     // one-way MV collection loss fraction [5]
}

export interface EnergySimResult {
  rte: RteBreakdown;
  years: EnergySimYear[];
  augmentation: AugmentationEvent[];
  totalAddedMWh: number;
  totalAddedContainers: number;
  zoneCapacityContainers: number;
  zonesSufficient: boolean;  // added containers fit the reserved zones
  endOfLifeUsableMWh: number;
  annualThroughputBolMWh: number; // year-1 AC discharge (headline number)
  notes: string[];           // model assumptions + citations, verbatim
}

export const ENERGY_SIM_NOTES: string[] = [
  'Round-trip efficiency is reported at the AC point of connection over full standard cycles and includes auxiliary (HVAC + controls) consumption, per IEC 62933-2-1. DC-terminal RTE is never reported as system RTE.',
  'Loss chain: LFP battery DC-DC RTE (LG JF2-class product spec), PCS CEC-weighted efficiency per direction (PE FREEMAQ / GE FLEXINVERTER datasheets), MV transformer no-load 0.1% + load loss 0.8% of rating (IEEE C57-class pad-mount data), MV collection cable I\u00B2R from the routed feeder geometry and NEC Ch.9 Table 8 resistances.',
  'Degradation follows the NREL semi-empirical form: calendar fade proportional to the square root of time with Arrhenius temperature acceleration (reference 25 \u00B0C cell temperature, assumed 5 \u00B0C above site average ambient), plus cycle fade proportional to equivalent full cycles with a \u221ADOD stress factor. Coefficients are calibrated to LFP warranty-class behavior (2.8%/\u221Ayr calendar at reference; 20% cycle fade at 5,000 EFC at 100% DOD).',
  'Dispatch is the IEC 62933-2-1 standard-cycle framing (N full cycles per day at rated power) \u2014 not market/price arbitrage. Augmentation cohorts are assumed to cycle at the same equivalent-full-cycle rate as the original fleet.',
  'SCREENING ONLY \u2014 augmentation timing and quantities must be verified against the OEM capacity warranty and the executed offtake agreement during detailed design.',
];

export function buildEnergySim(plant: EnergySimPlantParams, rawInputs: EnergySimInputs): EnergySimResult {
  const inp = sanitizeEnergySimInputs(rawInputs);
  const dod = inp.dodPct / 100;

  const rte = buildRteBreakdown({
    usableMWhPerCycle: plant.bolMWh * dod,
    containers: plant.containers,
    cableLossFrac: plant.cableLossFrac,
    cyclesPerDay: inp.cyclesPerDay,
  }, inp);

  // One-way balance-of-plant efficiency for annual AC discharge energy.
  const oneWayBop = (rte.pcsOneWayPct / 100) * (rte.xfmrOneWayPct / 100) * (rte.cableOneWayPct / 100);

  // Cohorts: { bolMWh, containers, installYear } — installYear 0 = original.
  const cohorts: { bolMWh: number; containers: number; installYear: number }[] = [
    { bolMWh: Math.max(0, plant.bolMWh), containers: Math.max(0, plant.containers), installYear: 0 },
  ];
  const years: EnergySimYear[] = [];
  const augmentation: AugmentationEvent[] = [];
  const zoneCapacityContainers = Math.max(0, Math.round(plant.augZoneBlocks)) *
    Math.max(1, Math.round(plant.containersPerBlock));
  let addedContainers = 0;
  let addedMWh = 0;
  const efcPerYear = inp.cyclesPerDay * DAYS_PER_YEAR;
  const canAugment = inp.contractMWh > 0 && plant.containerMWh > 0;

  // Usable at END of a given operating year for the current fleet.
  const usableAt = (year: number) =>
    cohorts.reduce((s, c) => s + (year > c.installYear
      ? c.bolMWh * cohortSoh(year - c.installYear, inp)
      : c.bolMWh), 0);

  for (let y = 1; y <= inp.projectLifeYears; y++) {
    let augAddedMWh = 0;
    let augAddedContainers = 0;
    if (canAugment && usableAt(y) < inp.contractMWh) {
      // Install at the START of year y: smallest whole-container addition
      // that restores end-of-year usable ≥ contract. The new cohort also
      // fades during year y (its SOH clock starts at install).
      const newCohortSoh = cohortSoh(1, inp);
      const deficit = inp.contractMWh - usableAt(y);
      const n = Math.ceil(deficit / (plant.containerMWh * newCohortSoh));
      if (n > 0) {
        augAddedContainers = n;
        augAddedMWh = n * plant.containerMWh;
        cohorts.push({ bolMWh: augAddedMWh, containers: n, installYear: y - 1 });
        addedContainers += n;
        addedMWh += augAddedMWh;
        augmentation.push({ year: y, mwh: augAddedMWh, containers: n });
      }
    }

    const usableMWh = usableAt(y);
    const totalBol = cohorts.reduce((s, c) => s + c.bolMWh, 0);
    const sohPct = totalBol > 0 ? (usableMWh / totalBol) * 100 : 0;
    // Annual AC discharge: energy-limited standard cycles on the usable
    // (post-fade) capacity, capped at the contract when one exists.
    const perCycleDc = Math.min(usableMWh, inp.contractMWh > 0 ? inp.contractMWh : usableMWh) * dod;
    const dischargedMWh = perCycleDc * efcPerYear * oneWayBop;
    years.push({
      year: y, sohPct, usableMWh,
      contractMWh: inp.contractMWh,
      augAddedMWh, augAddedContainers,
      dischargedMWh, efc: efcPerYear,
    });
  }

  return {
    rte,
    years,
    augmentation,
    totalAddedMWh: addedMWh,
    totalAddedContainers: addedContainers,
    zoneCapacityContainers,
    zonesSufficient: addedContainers <= zoneCapacityContainers,
    endOfLifeUsableMWh: years.length ? years[years.length - 1].usableMWh : plant.bolMWh,
    annualThroughputBolMWh: years.length ? years[0].dischargedMWh : 0,
    notes: ENERGY_SIM_NOTES,
  };
}
