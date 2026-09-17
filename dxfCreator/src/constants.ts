import type { CableClass, EquipmentKind, TrenchClass } from './types.js';

export const PAGE_WIDTH_IN = 34;
export const PAGE_HEIGHT_IN = 22;
export const PAGE_MARGIN_IN = 0.5;
export const STANDARD_SCALES_FT_PER_IN = Object.freeze([
  10, 20, 30, 40, 50, 60, 80, 100, 150, 200, 300, 400, 500, 800, 1000,
] as const);

export const LEGACY_PROFILE_ID = 'legacy-eci-90' as const;
export const LEGACY_TEMPLATE_ID = LEGACY_PROFILE_ID;
export const LEGACY_TEMPLATE_LABEL = 'Legacy' as const;
export const LEGACY_PAGE_ROLE = 'page-2-legacy-bess-layout' as const;
export const LEGACY_V1_CALIBRATION_PROFILE = 'legacy-v1' as const;
export const CAR_D_B005_1_CALIBRATION_PROFILE = 'car-d-b005-1' as const;
export const LEGACY_TEMPLATE_CALIBRATION_PROFILE = CAR_D_B005_1_CALIBRATION_PROFILE;
export const DEFAULT_CALIBRATION_PROFILE = LEGACY_V1_CALIBRATION_PROFILE;
export const LEGACY_CALIBRATION_PROFILES = Object.freeze([
  LEGACY_V1_CALIBRATION_PROFILE,
  CAR_D_B005_1_CALIBRATION_PROFILE,
] as const);
export const LEGACY_TEMPLATE_CONTRACT = Object.freeze({
  id: LEGACY_TEMPLATE_ID,
  label: LEGACY_TEMPLATE_LABEL,
  pageRole: LEGACY_PAGE_ROLE,
  mimeType: 'application/dxf' as const,
  calibrationProfile: LEGACY_TEMPLATE_CALIBRATION_PROFILE,
});

export const EQUIPMENT_KINDS: readonly EquipmentKind[] = Object.freeze([
  'bess', 'inverter', 'aux-transformer', 'aux-distribution',
  'fiber-junction-box', 'junction-box', 'substation',
]);

export const CABLE_CLASSES: readonly CableClass[] = Object.freeze([
  'bess-feeder-14a1', 'bess-feeder-14a2', 'bess-feeder-14b1',
  'bess-feeder-14b2', 'bess-feeder-15a1', 'bess-feeder-15a2',
  'bess-feeder-15b1', 'bess-feeder-15b2', 'aux-feeder',
  'dc-negative', 'dc-positive', 'fiber',
]);

export const TRENCH_CLASSES: readonly TrenchClass[] = Object.freeze([
  'mvac', 'dc', 'aux-fiber',
]);

export const LAYERS = Object.freeze({
  FRAME: 'SHEET - frame',
  TITLE: 'SHEET - title block',
  TEXT_SM: 'text-sm',
  TEXT_MD: 'text-md',
  TEXT_LG: 'text-lg',
  FENCE: 'fence',
  FENCE_ADJACENT: 'fence - adjacent substation',
  FENCE_PROJECT: 'fence - project by others',
  PROPERTY: 'property line',
  EQUIPMENT: 'EQUIP - equip main outline',
  EQUIPMENT_LABEL: 'EQUIP - Labels',
  FUTURE: 'EQUIP - future augment',
  FUTURE_INVERTER: 'EQUIP - future augment inverter',
  EXCLUSION: 'EQUIP - underground exclusion',
  LAYDOWN: 'SITE - laydown area',
  ROAD: 'A - Equipment access',
  ROAD_HATCH: 'Hatch - road proposed',
  ROAD_EXISTING: 'A - Existing access',
  SURFACING: 'Hatch - surfacing',
  TRENCH_MVAC: 'TRENCH - MVAC',
  TRENCH_DC: 'TRENCH - DC',
  TRENCH_AUX: 'TRENCH - AUX FIBER',
  MATCH: 'MATCH LINE',
  CALLOUT: 'CALL OUT',
  DETAIL: 'DETAIL MARKER',
  FEEDER_14A1: 'BESS FEEDER #14A1',
  FEEDER_14A2: 'BESS FEEDER #14A2',
  FEEDER_14B1: 'BESS FEEDER #14B1',
  FEEDER_14B2: 'BESS FEEDER #14B2',
  FEEDER_15A1: 'BESS FEEDER #15A1',
  FEEDER_15A2: 'BESS FEEDER #15A2',
  FEEDER_15B1: 'BESS FEEDER #15B1',
  FEEDER_15B2: 'BESS FEEDER #15B2',
  AUX_FEEDER: 'AUX FEEDER',
  DC_NEGATIVE: 'DC CABLE (-)',
  DC_POSITIVE: 'DC CABLE (+)',
  FIBER: 'CATL FIBER NETWORK (6 COUNT)',
});

export const CABLE_LAYER: Readonly<Record<CableClass, string>> = Object.freeze({
  'bess-feeder-14a1': LAYERS.FEEDER_14A1,
  'bess-feeder-14a2': LAYERS.FEEDER_14A2,
  'bess-feeder-14b1': LAYERS.FEEDER_14B1,
  'bess-feeder-14b2': LAYERS.FEEDER_14B2,
  'bess-feeder-15a1': LAYERS.FEEDER_15A1,
  'bess-feeder-15a2': LAYERS.FEEDER_15A2,
  'bess-feeder-15b1': LAYERS.FEEDER_15B1,
  'bess-feeder-15b2': LAYERS.FEEDER_15B2,
  'aux-feeder': LAYERS.AUX_FEEDER,
  'dc-negative': LAYERS.DC_NEGATIVE,
  'dc-positive': LAYERS.DC_POSITIVE,
  fiber: LAYERS.FIBER,
});

export const TRENCH_LAYER: Readonly<Record<TrenchClass, string>> = Object.freeze({
  mvac: LAYERS.TRENCH_MVAC,
  dc: LAYERS.TRENCH_DC,
  'aux-fiber': LAYERS.TRENCH_AUX,
});