// NextEra BESS 10% Design Tool - Equipment Catalog
// Per NextEra Site Plan Guidance R2 (5-14-2026)
// ALL DIMENSIONS IN FEET (plan view: length x width, height)

export interface EquipmentDims {
  length: number; // ft (long plan dimension)
  width: number;  // ft (short plan dimension)
  height: number; // ft
}

// BESS - LG JF2 DC LINK 5.1: 23'-6.3" x 8'-5.2" x 9'-6"
export const LG_JF2: EquipmentDims = { length: 23.525, width: 8.433, height: 9.5 };

// Inverter - PE (FP4200M): 21'-4" x 7'-0" x 7'-6"
export const PE_FP4200M: EquipmentDims = { length: 21.333, width: 7.0, height: 7.5 };

// Inverter - GE Flex 1571: 20'-0" x 8'-0" x 9'-6"
export const GE_FLEX_1571: EquipmentDims = { length: 20.0, width: 8.0, height: 9.5 };

// Aux Transformer - Hitachi: 8'-2" x 7'-4" x 6'-9"
export const HITACHI_AUX_XFMR: EquipmentDims = { length: 8.167, width: 7.333, height: 6.75 };

// Aux Switchgear - IPS: 15'-0" x 4'-0" x 12'-0"
export const IPS_SWITCHGEAR: EquipmentDims = { length: 15.0, width: 4.0, height: 12.0 };

// Small panels per Sheets 3-4 legend (diagrammatic pad-mount sizes)
export const AUX_SWITCH_PANEL: EquipmentDims = { length: 8.0, width: 3.0, height: 7.0 };
export const FIBER_PATCH_PANEL: EquipmentDims = { length: 4.0, width: 3.0, height: 5.0 };
export const FIRE_CONTROL_PANEL: EquipmentDims = { length: 5.0, width: 3.0, height: 6.0 };

// Mirrored-pair island gear per the Puma reference inset (diagrammatic
// pad-mount sizes): feeder junction box + communications cabinet at each
// island end near the aux corridor.
export const FEEDER_JUNCTION_BOX: EquipmentDims = { length: 6.0, width: 4.0, height: 6.0 };

// ---- Substation yard equipment (collector substation areas) ---------------
// Envelope dimensions for the pad-level plan footprint. These are drawn
// footprints for the yard layout, not procured outline drawings.
// Main power transformer (GSU) bank incl. radiators/bushings envelope.
export const MAIN_XFMR: EquipmentDims = { length: 30.0, width: 20.0, height: 20.0 };
// 34.5 kV metal-clad collector switchgear lineup.
export const MV_SWITCHGEAR: EquipmentDims = { length: 40.0, width: 8.0, height: 10.0 };
// Prefabricated control enclosure (relay/SCADA house).
export const CONTROL_HOUSE: EquipmentDims = { length: 40.0, width: 14.0, height: 12.0 };
// Collector feeder position: the 34.5 kV termination structure where ONE BESS
// area's MV feeders land in the substation yard. Sized as a single metal-clad
// feeder bay off the collector lineup.
export const SUBSTATION_FEEDER: EquipmentDims = { length: 12.0, width: 8.0, height: 10.0 };
export const COMMS_CABINET: EquipmentDims = { length: 4.0, width: 3.0, height: 6.5 };

// ---------------------------------------------------------------------------
// Manufacturer spec data for the DXF equipment schedule + per-block labels.
// Sourced from the uploaded manufacturer documents:
//  - PE FREEMAQ PCSM datasheet Rev 1-17 20240820 (FP4200M/FP4201M/FP4105M)
//  - LG JF2 DC LINK 5.1 product spec F2D4-5.1US-GN04 V5.0
//  - Lake Shore Electric LSE2000FMCD-100ET drawing (480V aux switchboard)
//  - Hitachi aux transformer outline drawing 0890229856
// NOTE on dimensions: the layout/catalog dims above follow the NextEra
// guidance sheets (the drawn WYSIWYG footprints). Where a manufacturer
// datasheet differs slightly (PE FP4200M cabinet is 21.3 x 6.5 x 7.2 ft on
// the datasheet vs 21'-4" x 7'-0" x 7'-6" on the guidance sheets; the LG
// skid is 23.52 x 8.43 x 9.5 ft on both), the guidance footprint is kept
// for layout and the schedule lists the drawn footprint, with the
// manufacturer rating/weight from the datasheet.
export interface EquipmentSpec {
  tag: string;          // schedule tag prefix (matches drawing labels)
  item: string;         // schedule item name
  manufacturer: string;
  model: string;
  rating: string;       // electrical rating summary from the datasheet
  dims: EquipmentDims;  // drawn plan footprint (ft) — matches the layout
  weightLbs: number | null; // null = not stated in the provided documents
}

export const PE_FP4200M_SPEC: EquipmentSpec = {
  tag: 'PCS', item: 'PCS UNIT',
  manufacturer: 'POWER ELECTRONICS',
  model: 'FREEMAQ PCSM FP4200M',
  rating: '4200 KVA @40C / 3900 KVA @50C, 34.5 KV',
  dims: PE_FP4200M,
  weightLbs: 30865,
};

// GE nameplate apparent-power rating (register F-04): the BOM/schedule must
// carry nameplate MVA, not just MW. 4.2 MVA per the GE Vernova FLEXINVERTER
// datasheet family (X88036-R008) — named constant pending final datasheet
// confirmation by the reviewing engineer.
export const GE_FLEX_1571_NAMEPLATE_MVA = 4.2;

export const GE_FLEX_1571_SPEC: EquipmentSpec = {
  tag: 'PCS', item: 'PCS UNIT',
  manufacturer: 'GE VERNOVA',
  model: 'FLEXINVERTER 1571',
  rating: `${GE_FLEX_1571_NAMEPLATE_MVA.toFixed(1)} MVA NAMEPLATE, 4.02 MW @40C / 3.74 MW @50C, 34.5 KV`,
  dims: GE_FLEX_1571,
  weightLbs: null,
};

export const LG_JF2_SPEC: EquipmentSpec = {
  tag: 'BATT', item: 'BATTERY CONTAINER',
  manufacturer: 'LG ENERGY SOLUTION',
  model: 'JF2 DC LINK 5.1 (F2D4-5.1US)',
  rating: '5.1 MWH, 1500 VDC',
  dims: LG_JF2,
  weightLbs: 105822,
};

export const HITACHI_AUX_XFMR_SPEC: EquipmentSpec = {
  tag: 'AUX 100', item: 'AUX TRANSFORMER',
  manufacturer: 'HITACHI ENERGY',
  model: 'PAD MOUNT (DWG 0890229856)',
  rating: '34.5 KV - 480/277 V',
  dims: HITACHI_AUX_XFMR,
  weightLbs: null,
};

// SINGLE SOURCE OF TRUTH for the aux distribution center (register F-06):
// Equipment Dimensions, BOM, equipment schedule, and legend must all read
// from THIS record — never from IPS_SWITCHGEAR or hardcoded manufacturer
// text. DECISION (2026-08-06): the drawn footprint stays the 15' x 4' x 12'
// guidance-sheet envelope (IPS_SWITCHGEAR constant, which this record's
// dims reference) — it is what the layout actually draws — while the
// manufacturer/model/rating are the procured Lake Shore Electric unit from
// the issued 90% BOM. If the Lake Shore outline drawing dims ever govern,
// change `dims` HERE so every document moves together.
export const AUX_SWITCHBOARD_SPEC: EquipmentSpec = {
  tag: 'AUX 101', item: 'AUX DISTRIBUTION CENTER',
  manufacturer: 'LAKE SHORE ELECTRIC',
  model: 'LSE2000FMCD-100ET',
  rating: '480/277 V 3PH 4W, 2000 A, 65 KAIC, NEMA 3R',
  dims: IPS_SWITCHGEAR,
  weightLbs: 4300,
};

export const AUX_SWITCH_PANEL_SPEC: EquipmentSpec = {
  tag: 'AUX SWITCH PANEL', item: 'AUX SWITCH PANEL',
  manufacturer: '-', model: 'PER GUIDANCE LEGEND',
  rating: '480 V', dims: AUX_SWITCH_PANEL, weightLbs: null,
};

export const FIBER_PATCH_PANEL_SPEC: EquipmentSpec = {
  tag: 'FIBER PATCH PANEL', item: 'FIBER PATCH PANEL',
  manufacturer: '-', model: 'PER GUIDANCE LEGEND',
  rating: '-', dims: FIBER_PATCH_PANEL, weightLbs: null,
};

export const FIRE_CONTROL_PANEL_SPEC: EquipmentSpec = {
  tag: 'FIRE CONTROL PANEL', item: 'FIRE CONTROL PANEL',
  manufacturer: '-', model: 'PER GUIDANCE LEGEND',
  rating: '120 V', dims: FIRE_CONTROL_PANEL, weightLbs: null,
};

export const FEEDER_JUNCTION_BOX_SPEC: EquipmentSpec = {
  tag: 'FJB', item: 'FEEDER JUNCTION BOX',
  manufacturer: '-', model: 'PER REFERENCE INSET (PMA-D-B001)',
  rating: '34.5 KV', dims: FEEDER_JUNCTION_BOX, weightLbs: null,
};

export const COMMS_CABINET_SPEC: EquipmentSpec = {
  tag: 'COMMS', item: 'COMMUNICATIONS CABINET',
  manufacturer: '-', model: 'PER REFERENCE INSET (PMA-D-B001)',
  rating: '-', dims: COMMS_CABINET, weightLbs: null,
};

// ---- Substation yard specs -------------------------------------------------
export const MAIN_XFMR_SPEC: EquipmentSpec = {
  tag: 'MTR', item: 'MAIN POWER TRANSFORMER',
  manufacturer: '-', model: 'BY OTHERS (SUBSTATION PACKAGE)',
  rating: '138 KV - 34.5 KV', dims: MAIN_XFMR, weightLbs: null,
};

export const MV_SWITCHGEAR_SPEC: EquipmentSpec = {
  tag: 'MVS', item: 'COLLECTOR SWITCHGEAR',
  manufacturer: '-', model: 'BY OTHERS (SUBSTATION PACKAGE)',
  rating: '34.5 KV METAL-CLAD', dims: MV_SWITCHGEAR, weightLbs: null,
};

export const CONTROL_HOUSE_SPEC: EquipmentSpec = {
  tag: 'CH', item: 'CONTROL HOUSE',
  manufacturer: '-', model: 'BY OTHERS (SUBSTATION PACKAGE)',
  rating: '-', dims: CONTROL_HOUSE, weightLbs: null,
};

// Collector feeder position: where ONE BESS area's MV feeders land inside a
// substation yard. Same 34.5 kV metal-clad lineup as the collector
// switchgear — the substation package itself is designed by others, so this
// carries the position and the served area, not a vendor selection.
export const SUBSTATION_FEEDER_SPEC: EquipmentSpec = {
  tag: 'SF', item: 'COLLECTOR FEEDER POSITION',
  manufacturer: '-', model: 'BY OTHERS (SUBSTATION PACKAGE)',
  rating: '34.5 KV METAL-CLAD', dims: SUBSTATION_FEEDER, weightLbs: null,
};

// Spec lookup by placed-equipment kind (inverter resolved per configuration).
export function specForKind(kind: string, config?: BessConfiguration): EquipmentSpec | null {
  switch (kind) {
    case 'bess': return LG_JF2_SPEC;
    case 'inverter':
      return config?.inverterModel === 'PE FP4200M' ? PE_FP4200M_SPEC : GE_FLEX_1571_SPEC;
    case 'auxTransformer': return HITACHI_AUX_XFMR_SPEC;
    case 'auxSwitchgear': return AUX_SWITCHBOARD_SPEC;
    case 'auxSwitchPanel': return AUX_SWITCH_PANEL_SPEC;
    case 'fiberPatchPanel': return FIBER_PATCH_PANEL_SPEC;
    case 'fireControlPanel': return FIRE_CONTROL_PANEL_SPEC;
    case 'feederJunctionBox': return FEEDER_JUNCTION_BOX_SPEC;
    case 'commsCabinet': return COMMS_CABINET_SPEC;
    case 'mainTransformer': return MAIN_XFMR_SPEC;
    case 'mvSwitchgear': return MV_SWITCHGEAR_SPEC;
    case 'controlHouse': return CONTROL_HOUSE_SPEC;
    case 'substationFeeder': return SUBSTATION_FEEDER_SPEC;
    default: return null;
  }
}

// ---------------------------------------------------------------------------
// Conductor / conduit physical data for the cable & conduit schedule.
// ODs are representative catalog values (inches):
//  - MV: 35 kV 133% EPR single-conductor w/ jacketed copper tape shield
//    (Okonite/Prysmian class ODs, rounded to 0.01")
//  - DC: 2 kV RHW-2/USE-2 535 kcmil per LG DC LINK collection practice
//  - LVAC: 600 V XHHW-2 500 kcmil
//  - FIBER: loose-tube OSP fiber cable
// Conduit dims are Schedule 40 PVC internal diameters per NEC Chapter 9
// Table 4 (Article 352), trade sizes 2" through 6".
// ---------------------------------------------------------------------------

// Single-conductor OD (inches) for 35 kV MV cable by kcmil size.
// Cable quantity basis (register B3/F-07): every scheduled run = routed plan
// centerline length + this slack percentage. Lives here (not cableSchedule)
// so dxfExport can print the basis note without importing the schedule module.
export const DEFAULT_SLACK_PCT = 10;

export const MV_CONDUCTOR_OD_IN: Record<'500' | '750' | '1000' | '1500', number> = {
  '500': 1.64,
  '750': 1.83,
  '1000': 2.01,
  '1500': 2.32, // 35 kV 133% EPR single conductor, typical vendor sheet
};

export interface CableSpec {
  description: string; // schedule conductor text
  odIn: number;        // single-conductor / cable OD (inches)
  conductors: number;  // conductors pulled per run
}

// DC collection run: 2 conductors (+/-) per container-to-PCS run.
export const DC_CABLE_SPEC: CableSpec = {
  description: '(2) 535 KCMIL CU, 2 KV DC', odIn: 1.03, conductors: 2,
};
// LVAC 480V run: 3 phase + neutral.
export const LVAC_CABLE_SPEC: CableSpec = {
  description: '(4) 500 KCMIL AL, 600 V', odIn: 0.94, conductors: 4,
};
// Fiber run: one OSP loose-tube cable.
export const FIBER_CABLE_SPEC: CableSpec = {
  description: '(1) 48F OSP FIBER', odIn: 0.60, conductors: 1,
};
// Aux power (LV) link: island aux transformer -> distribution center and
// panel ties — small copper branch circuit (spec §2 AUXPWR class).
export const AUXPWR_CABLE_SPEC: CableSpec = {
  description: '(3) #6 AWG CU + (1) #10 AWG CU GND, 600 V', odIn: 0.32, conductors: 4,
};
// 144-ct fiber trunk: control enclosure -> one FJB per island (R-FB-1).
export const FIBER_TRUNK_CABLE_SPEC: CableSpec = {
  description: '(1) 144F OSP FIBER TRUNK', odIn: 0.80, conductors: 1,
};
// CATL container network ring: 6-ct fiber loop around each container cluster.
export const CATL_CABLE_SPEC: CableSpec = {
  description: '(1) 6F CATL NETWORK FIBER', odIn: 0.35, conductors: 1,
};

// Schedule 40 PVC conduit: trade size label -> internal diameter (inches),
// NEC Chapter 9 Table 4 (Article 352).
export const CONDUIT_SCH40_ID_IN: { trade: string; idIn: number }[] = [
  { trade: '2"', idIn: 2.047 },
  { trade: '2-1/2"', idIn: 2.445 },
  { trade: '3"', idIn: 3.042 },
  { trade: '4"', idIn: 3.998 },
  { trade: '5"', idIn: 5.016 },
  { trade: '6"', idIn: 6.031 },
];

// NEC Chapter 9 Table 1 max fill (fraction of conduit internal area).
export function necMaxFill(conductors: number): number {
  if (conductors === 1) return 0.53;
  if (conductors === 2) return 0.31;
  return 0.4;
}

// ---------------------------------------------------------------------------
// Typical trench cross-sections per the issued 90% package trench detail
// sheets CAR-D-B006-1 (details 1-4) and CAR-D-B006-2 (crossing details 8-11),
// Carousel Energy Storage "ISSUED FOR 90% REVIEW" 04/09/26. Screening-grade
// catalog constants: plan-view trench bands carry a TrenchSectionType tag and
// exports read the section dimensions from here.
// ---------------------------------------------------------------------------
import type { TrenchSectionType, CableClass } from './types';

export interface TrenchSectionSpec {
  type: TrenchSectionType;
  title: string;       // section title as printed on the detail sheet
  widthFt: number;     // trench width (ft)
  depthFt: number;     // trench depth below finished grade (ft)
  notes: string;       // installation notes from the section detail
  reference: string;   // governing package sheet / detail
}

export const TRENCH_SECTIONS: Record<TrenchSectionType, TrenchSectionSpec> = {
  MVAC_DIRECT_BURY: {
    type: 'MVAC_DIRECT_BURY',
    title: 'MVAC FEEDER TRENCH - DIRECT BURY',
    widthFt: 2.0,   // 2'-0" wide
    depthFt: 3.0,   // 3'-0" deep
    notes: '6" SAND BEDDING, 4" CABLE SPACING, WARNING TAPE 1\'-0" MIN ABOVE CABLES, TRENCH GROUND CONDUCTOR IN TRENCH',
    reference: 'CAR-D-B006-1 DETAIL 1',
  },
  MVAC_DUCT: {
    type: 'MVAC_DUCT',
    title: 'MVAC FEEDER TRENCH - IN DUCT',
    widthFt: 2.0,   // 2'-0" wide
    depthFt: 3.0,   // 3'-0" deep
    notes: 'FEEDER IN DUCT, TRENCH GROUND CONDUCTOR IN TRENCH',
    reference: 'CAR-D-B006-1 DETAIL 2',
  },
  AUX_FIBER: {
    type: 'AUX_FIBER',
    title: 'AUX POWER TRENCH FROM LOAD CENTER',
    widthFt: 3.5,   // 3'-6" wide
    depthFt: 2.5,   // 2'-6" deep
    notes: 'CONDUITS SPACED 6" O.C. (PLAN BANDS SHOW THE COMBINED 480V AUX + FIBER CORRIDOR WIDTH)',
    reference: 'CAR-D-B006-1 DETAIL 3',
  },
  DC_DUCT_BANK: {
    type: 'DC_DUCT_BANK',
    title: 'DC(-)/DC(+) DUCT BANK',
    widthFt: 2.0,   // 2'-0" wide
    depthFt: 2.5,   // 2'-6" deep
    notes: 'DC(-) AND DC(+) DUCT BANK, CONTAINER TO PCS',
    reference: 'CAR-D-B006-1 DETAIL 4',
  },
};

// Road/utility crossing details (aux×DC, fiber×MVAC, fiber×DC, aux×fiber) are
// covered by CAR-D-B006-2 details 8-11 — referenced in export notes; crossing
// geometry itself remains detailed-design scope.
export const TRENCH_CROSSING_REFERENCE = 'CAR-D-B006-2 DETAILS 8-11';

// Which trench cross-section governs a buried run of the given cable class.
export function trenchSectionForCableClass(cls: CableClass): TrenchSectionSpec {
  switch (cls) {
    case 'MV': return TRENCH_SECTIONS.MVAC_DIRECT_BURY;
    case 'DC': return TRENCH_SECTIONS.DC_DUCT_BANK;
    default: return TRENCH_SECTIONS.AUX_FIBER; // LVAC + FIBER share the aux corridor
  }
}

// Clearances per LG Civil Design Guide + PCS guidance (feet).
// Values cross-checked against the issued 90% package "DESIGN SPACING AND
// DIMENSION" table on CAR-D-B000-3 (Carousel Energy Storage, 04/09/26):
//   exterior/interior access road width 24 FT, battery container spacing
//   min back side 3.0 FT / front side 10 FT, PCS to battery container 14 FT.
export const CLEARANCES = {
  frontToFront: 10,       // container front to front (CAR-D-B000-3: 10 FT min front side)
  rearToRear: 3,          // container rear to rear (CAR-D-B000-3: 3.0 FT min back side)
  sideToSide: 3,          // container side to side (no E-Panel)
  ePanelToEPanel: 5,      // 10 ft for OPS access
  frontToFence: 10,
  sideToFence: 5,
  pcsHotClimate: 14,      // PCS clearance, ambient > 40C (CAR-D-B000-3: PCS to battery container 14 FT)
  pcsStandard: 10,        // ambient < 40C
  fenceToLotLine: 25,     // inset-mode fence setback from the lot line ("typ."). Fence
                          // placement is a per-design choice (2026-08-16): 'inset' keeps
                          // this setback, 'property-line' puts the fence ON the boundary.
  roadWidth: 24,          // "24' wide roads" (reference standard; CAR-D-B000-3 confirms 24 FT ext + int)
  roadInnerRadius: 58,    // "58' Inner Turning Radius" (guidance key note 2). DECISION (2026-07-30):
                          // keep 58 ft per the guidance drawings. The issued 90% package CAR-D-B001-1
                          // shows R60'-0" TYP but the guidance key note is the governing standard.
                          // Changing this reshapes roads on all existing projects — do not alter without
                          // a deliberate user decision (see nextera-90pct-gap-register.md).
  roadOuterRadius: 20,    // "20' Outer Turning Radius for all roads inside the BESS yard" (key note 4)
  equipmentToRoadEdge: 8.0625, // 8'-0 3/4" min distance to road edge for equipment (reference standard)
  bessToLotLine: 100,     // "BESS have to be 100'-0" min from lot line per NFPA 855" (key note 6)
};

export interface BessConfiguration {
  id: string;
  label: string;
  inverterModel: 'PE FP4200M' | 'GE FLEX 1571';
  inverterDims: EquipmentDims;
  hasAuxEquipment: boolean;   // dedicated aux xfmr + switchgear
  refMW: number;              // reference layout rating
  refMWh: number;
  durationHrs: number;
  // AC capability of the physical PCS, separate from credited battery-backed
  // output. A four-hour site cannot claim more MW than its containers can
  // continuously deliver.
  pcsCapabilityMW: number;
  blockMW: number;            // credited continuous MW per inverter block
  containersPerBlock: number; // LG JF2 containers per block
  containerMWh: number;       // MWh per LG JF2 DCLINK 5.1 container
}

// LG JF2 DC LINK 5.1 nameplate energy. Public-facing schedules round this to
// 5.1 MWh, but sizing retains the issued 5.112 MWh value.
export const LG_JF2_NAMEPLATE_MWH = 5.112;
// LG DC LINK is a 0.25C continuous product: its battery-backed MW is energy
// × this rate, independently of the PCS capability.
export const LG_JF2_CONTINUOUS_C_RATE = 0.25;
export const DEFAULT_CONTAINERS_PER_PCS = 3;
// A saved file that predates the containers-per-PCS field was drawn when QTY4
// was the only arrangement. Reopening it must reproduce THAT drawing, so an
// absent field resolves to 4 — only brand-new designs start at the QTY3
// standard. Silently re-reading old files as QTY3 would redraw a delivered
// layout under the drafter.
export const LEGACY_CONTAINERS_PER_PCS = 4;
const CONTAINER_MWH = LG_JF2_NAMEPLATE_MWH;

// GE "Flex 1571" = GE Vernova FLEXINVERTER 1.5kV BESS Power Station (model 1571).
// Per GE Vernova datasheet X88036-R008 (May 2025):
//   AC discharge power 4.02 MW up to 40C ambient / 3.74 MW at 50C (4.40 / 4.13 MVA).
// A 3-container GE block is the design-system standard: 15.336 MWh × 0.25C
// = 3.834 MW continuously for four hours. The 4.02 MW PCS is retained as
// equipment capability, not credited project capacity.
export const GE_PCS_CAPABILITY_MW = 4.02;
const GE_CONTAINERS_PER_BLOCK = DEFAULT_CONTAINERS_PER_PCS;
const GE_BLOCK_MW = CONTAINER_MWH * GE_CONTAINERS_PER_BLOCK * LG_JF2_CONTINUOUS_C_RATE;

// The 5 reference configurations from the guidance sheets 5-9
export const CONFIGURATIONS: BessConfiguration[] = [
  {
    id: 'pe-aux-200',
    label: 'PE PCS w/ Dedicated Aux Feeder (50MW x 4hr - 200MWh)',
    inverterModel: 'PE FP4200M',
    inverterDims: PE_FP4200M,
    hasAuxEquipment: true,
    refMW: 50, refMWh: 200, durationHrs: 4,
    pcsCapabilityMW: 4.2, blockMW: 4.2, containersPerBlock: 4, containerMWh: CONTAINER_MWH,
  },
  {
    id: 'ge-auxfeeder-400',
    label: 'GE PCS w/ Dedicated Aux Feeder (100MW x 4hr - 400MWh)',
    inverterModel: 'GE FLEX 1571',
    inverterDims: GE_FLEX_1571,
    hasAuxEquipment: true,
    refMW: 100, refMWh: 400, durationHrs: 4,
    pcsCapabilityMW: GE_PCS_CAPABILITY_MW, blockMW: GE_BLOCK_MW, containersPerBlock: GE_CONTAINERS_PER_BLOCK, containerMWh: CONTAINER_MWH,
  },
  {
    id: 'ge-noaux-300',
    label: 'GE PCS w/o Aux Equipment (75MW x 4hr - 300MWh)',
    inverterModel: 'GE FLEX 1571',
    inverterDims: GE_FLEX_1571,
    hasAuxEquipment: false,
    refMW: 75, refMWh: 300, durationHrs: 4,
    pcsCapabilityMW: GE_PCS_CAPABILITY_MW, blockMW: GE_BLOCK_MW, containersPerBlock: GE_CONTAINERS_PER_BLOCK, containerMWh: CONTAINER_MWH,
  },
  {
    id: 'ge-noaux-400',
    label: 'GE PCS w/o Aux Equipment (100MW x 4hr - 400MWh)',
    inverterModel: 'GE FLEX 1571',
    inverterDims: GE_FLEX_1571,
    hasAuxEquipment: false,
    refMW: 100, refMWh: 400, durationHrs: 4,
    pcsCapabilityMW: GE_PCS_CAPABILITY_MW, blockMW: GE_BLOCK_MW, containersPerBlock: GE_CONTAINERS_PER_BLOCK, containerMWh: CONTAINER_MWH,
  },
  {
    id: 'ge-aux-400',
    label: 'GE PCS w/ Aux Equipment (100MW x 4hr - 400MWh)',
    inverterModel: 'GE FLEX 1571',
    inverterDims: GE_FLEX_1571,
    hasAuxEquipment: true,
    refMW: 100, refMWh: 400, durationHrs: 4,
    pcsCapabilityMW: GE_PCS_CAPABILITY_MW, blockMW: GE_BLOCK_MW, containersPerBlock: GE_CONTAINERS_PER_BLOCK, containerMWh: CONTAINER_MWH,
  },
  // Multi-area phase sizing. Not a guidance reference sheet: this is the
  // rating of EACH BESS area on a phase-footprint site, so a four-area site
  // selecting this option is a 500 MW project (4 x 125 MW). The multi-area
  // layout pass applies it per area rather than dividing it among them.
  // Same GE block as the reference configurations, so every downstream
  // rating/BOM/compliance rule applies unchanged.
  {
    id: 'ge-aux-500',
    label: 'GE PCS w/ Aux Equipment (125MW x 4hr - 500MWh)',
    inverterModel: 'GE FLEX 1571',
    inverterDims: GE_FLEX_1571,
    hasAuxEquipment: true,
    refMW: 125, refMWh: 500, durationHrs: 4,
    pcsCapabilityMW: GE_PCS_CAPABILITY_MW, blockMW: GE_BLOCK_MW, containersPerBlock: GE_CONTAINERS_PER_BLOCK, containerMWh: CONTAINER_MWH,
  },
];

// The 5 guidance reference configurations (sheets 5-9). `CONFIGURATIONS` also
// carries project-sizing options that are not reference sheets; compliance
// checks the reference set, selection UI offers all of them.
export const REFERENCE_CONFIG_IDS = [
  'pe-aux-200', 'ge-auxfeeder-400', 'ge-noaux-300', 'ge-noaux-400', 'ge-aux-400',
] as const;
export const DEFAULT_CONFIGURATION_ID = 'ge-aux-400';

export function getConfiguration(id: string): BessConfiguration {
  const c = CONFIGURATIONS.find(c => c.id === id);
  if (!c) throw new Error(`Unknown configuration: ${id}`);
  return c;
}

export function creditedBlockMW(config: Pick<BessConfiguration, 'pcsCapabilityMW' | 'containersPerBlock' | 'containerMWh'>): number {
  return Math.min(
    config.pcsCapabilityMW,
    config.containersPerBlock * config.containerMWh * LG_JF2_CONTINUOUS_C_RATE,
  );
}

/** Preserve explicit legacy QTY4 projects while recomputing their true output. */
export function withContainersPerPcs(config: BessConfiguration, containersPerPcs?: number): BessConfiguration {
  if ((containersPerPcs !== 3 && containersPerPcs !== 4) || containersPerPcs === config.containersPerBlock) {
    return config;
  }
  const updated = { ...config, containersPerBlock: containersPerPcs };
  const blockMW = creditedBlockMW(updated);
  return {
    ...updated,
    blockMW,
    // A legacy GE QTY4 layout is a valid preserved drawing, but it is no
    // longer represented as a four-hour design.
    ...(updated.inverterModel === 'GE FLEX 1571'
      ? { durationHrs: updated.containersPerBlock * updated.containerMWh / blockMW }
      : {}),
  };
}

// Configuration with a saved/legacy container-count override applied. All
// display/export consumers use this so counts and credited output match.
export function getEffectiveConfiguration(id: string, containersPerPcs?: number): BessConfiguration {
  return withContainersPerPcs(getConfiguration(id), containersPerPcs);
}
