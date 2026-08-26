import rawRules from './fixtures/routing_rules_carousel.json';

export type RoutingRuleStatus =
  | 'MEASURED'
  | 'DIRECTIVE'
  | 'MEASURED+DIRECTIVE'
  | 'DIRECTIVE+MEASURED'
  | 'ASSUMED';

export interface RoutingRule<T> {
  readonly v: T;
  readonly status: RoutingRuleStatus;
  readonly src: string;
}

interface CarouselRoutingRules {
  readonly meta: {
    readonly name: string;
    readonly version: string;
    readonly generated: string;
    readonly sources: readonly string[];
    readonly authority: string;
  };
  readonly mv: {
    readonly bundle_offset_ft: RoutingRule<number>;
    readonly chamfer_deg: RoutingRule<number>;
    readonly entry_end_rule: RoutingRule<string>;
    readonly fence_crossing: RoutingRule<string>;
    readonly trench_crossing: RoutingRule<string>;
    readonly row_termination: RoutingRule<string>;
  };
  readonly geometry: {
    readonly row_pitch_ft: RoutingRule<number>;
    readonly row_gap_in_island_ft: RoutingRule<number>;
    readonly inter_island_row_gap_ft: RoutingRule<number>;
    readonly aisle_at_interslot_midpoint: RoutingRule<boolean>;
    readonly pcs_default: RoutingRule<number>;
    readonly pcs_max_eol: RoutingRule<number>;
  };
  readonly assumed: {
    readonly conductors_kcmil_amps: RoutingRule<readonly (readonly [number, number])[]>;
    readonly duct_bank_derate: RoutingRule<number>;
    readonly lane_capacities: RoutingRule<Readonly<Record<string, number>>>;
  };
}

// Reviewed TypeScript ingestion of the supplied Python package's canonical
// rules JSON. Geometry and topology rules tagged MEASURED and/or DIRECTIVE may
// drive routing. The ASSUMED electrical tables remain provenance-only and do
// not replace the project's governing conductor/derating model in feeders.ts.
export const CAROUSEL_ROUTING_RULES =
  rawRules as unknown as CarouselRoutingRules;

const governedNumber = (rule: RoutingRule<number>, label: string): number => {
  if (!Number.isFinite(rule.v) || rule.v <= 0 || rule.status === 'ASSUMED') {
    throw new Error(`Invalid governed routing rule: ${label}`);
  }
  return rule.v;
};

export const ROUTING_RULESET_ID =
  `${CAROUSEL_ROUTING_RULES.meta.name}@${CAROUSEL_ROUTING_RULES.meta.version}`;
export const MV_BUNDLE_SPACING_FT = governedNumber(
  CAROUSEL_ROUTING_RULES.mv.bundle_offset_ft, 'mv.bundle_offset_ft');
export const MV_CHAMFER_DEG = governedNumber(
  CAROUSEL_ROUTING_RULES.mv.chamfer_deg, 'mv.chamfer_deg');
export const PCS_DEFAULT_PER_FEEDER = governedNumber(
  CAROUSEL_ROUTING_RULES.geometry.pcs_default, 'geometry.pcs_default');
export const PCS_MAX_EOL_PER_FEEDER = governedNumber(
  CAROUSEL_ROUTING_RULES.geometry.pcs_max_eol, 'geometry.pcs_max_eol');

export const PROVISIONAL_ROUTING_ASSUMPTIONS = CAROUSEL_ROUTING_RULES.assumed;