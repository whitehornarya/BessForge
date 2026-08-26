// NextEra design tool types. ALL COORDINATES IN FEET, local site frame.
// Plan view: x = easting, y = northing. 3D scene maps (x, elevation, -y).

export interface Pt {
  x: number;
  y: number;
}

export interface SiteBoundary {
  name: string;
  polygon: Pt[];        // parcel/lot line polygon, local feet, closed implied
  origin: { lat: number; lon: number }; // reference for projection
  areaAcres: number;
  kmlName?: string;   // project name extracted from the KML <name> tag
  location?: string;  // human-readable location derived from the KML
}

// Per-area drafter edits.
//
// Every one of these is an INPUT to that area's layout, not generated output.
// They used to live only in the mirrored top-level store fields, which meant
// switching areas discarded them. Parking them on the area makes each
// footprint independently editable: switching away commits them here and
// switching back re-applies them, and saving a project writes them out.
//
// `LayoutConstraints`, `GateEdge` and `ArrangementStrategy` live in
// layoutEngine, which imports this module — so they come in as TYPE-ONLY
// imports. Those are erased at compile time, so there is no runtime cycle.
import type { LayoutConstraints, GateEdge, ArrangementStrategy } from './layoutEngine';
import type { GradingZone } from './gradingSurface';
import type { AreaZone } from './areaZones';

// Compass direction a substation take-off faces. This is the direction the
// incoming MV feeders TRAVEL as they land on the take-off (an 'E' take-off is
// approached by feeders running east), which is also the direction from the
// served BESS yard toward the take-off.
export type TakeoffDirection = 'N' | 'S' | 'E' | 'W' | 'NE' | 'NW' | 'SE' | 'SW';

export const TAKEOFF_DIRECTIONS: TakeoffDirection[] =
  ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

/** Unit-ish compass vector for a take-off direction (components in -1/0/+1). */
export const takeoffVector = (d: TakeoffDirection): { dx: number; dy: number } => ({
  dx: d.includes('E') ? 1 : d.includes('W') ? -1 : 0,
  dy: d.includes('N') ? 1 : d.includes('S') ? -1 : 0,
});

// One MV take-off position inside a SUBSTATION area's yard.
//
// A substation collecting several BESS areas carries one take-off per served
// area, so each area's feeders land on their own position instead of every
// circuit converging on a single point. The drafter can add, move, re-aim and
// remove them; `servesAreaId` is the BESS SiteArea whose feeders route here
// (null = not yet aimed, which routes nothing and is reported, never silent).
//
// Positions are in the SHARED projected frame, like every other area
// coordinate, so a BESS area can target a point inside another area's fence.
export interface SubstationTakeoff {
  id: string;
  x: number;
  y: number;
  dir: TakeoffDirection;
  servesAreaId: string | null;
}

export interface SiteAreaEdits {
  layoutEdits?: LayoutConstraints;
  substation?: Pt | null;
  // SUBSTATION areas only: the drafter's MV take-off positions. Absent means
  // "never edited", and the yard's automatic take-offs are used instead.
  takeoffs?: SubstationTakeoff[];
  feederAssignments?: Record<string, number>;
  gradingZones?: GradingZone[];
  areaZones?: AreaZone[];
  gateEdge?: GateEdge | null;
  arrangement?: ArrangementStrategy;
  latticeShift?: Pt | null;
}

// One footprint of a multi-area site (e.g. "BESS AREA 1", "SUBSTATION AREA 2").
// A project made of several phase footprints holds one SiteArea per outline;
// every area's boundary is projected in the SAME local frame, so their
// relative positions on the ground are preserved. Single-boundary projects
// never populate this — they stay exactly as they were.
export interface SiteArea {
  id: string;
  name: string;
  kind: 'bess' | 'substation' | 'other';
  boundary: SiteBoundary;
  design: SiteDesign | null; // null while generating or if this area failed
  error?: string;
  // The drafter's edits to THIS area. Absent means "never edited" — the area
  // lays out purely automatically, which is the state every area starts in.
  edits?: SiteAreaEdits;
}

export type EquipmentKind =
  | 'bess'
  | 'inverter'
  | 'auxTransformer'
  | 'auxSwitchgear'
  | 'auxSwitchPanel'
  | 'fiberPatchPanel'
  | 'fireControlPanel'
  | 'feederJunctionBox'
  | 'commsCabinet'
  // Placeholder block for a generator drawn in a customer reference KMZ
  // (auto-fill trace). No real equipment model yet — it renders and exports
  // as a plain block with its drawn footprint.
  | 'generator'
  // CONEX / CONNEX storage box drawn in a customer reference KMZ (typically
  // 20' x 10'). A plain rectangle block: renders and exports with its drawn
  // footprint, contributes nothing electrical.
  | 'conex'
  // Manhole / vault drawn in a customer reference KMZ. A plain rectangle
  // block at its drawn footprint, nothing electrical.
  | 'manhole'
  // Substation-yard equipment. These never appear in a BESS-area layout;
  // they are placed only by the substation yard generator, so every
  // BESS-only consumer keeps seeing exactly the kinds it always saw.
  | 'mainTransformer'
  | 'mvSwitchgear'
  | 'controlHouse'
  // Collector feeder position inside a substation yard. Each one receives the
  // MV feeders of ONE BESS area, so a substation collecting two BESS areas
  // carries two of them. Placed only by the substation yard generator.
  | 'substationFeeder';

export interface PlacedEquipment {
  id: string;
  kind: EquipmentKind;
  label: string;
  // center position in local feet
  x: number;
  y: number;
  rotation: number; // radians, 0 = length along x
  length: number;   // ft
  width: number;    // ft
  height: number;   // ft
  // KMZ trace imports may be normalized to the standard equipment geometry
  // for every visible/export surface while cable/feeder routing remains on
  // the customer's original topology. This routing-only pose is never drawn.
  traceSourcePose?: {
    x: number;
    y: number;
    rotation: number;
    length: number;
    width: number;
  };
  // BESS containers only: which side of the container the E-panel / cable
  // compartment is on (EPNL-1200A = left, EPNL-1200C = right), viewed in plan
  // with the container's front (door/compartment) end facing you.
  epanel?: 'left' | 'right';
  // BESS containers only: plan-y direction the door / cable-compartment end
  // wall faces (+1 = north/back row, -1 = south/front row). DC/LVAC runs land
  // at the compartment corner of this end.
  doorEnd?: 1 | -1;
  // Substation feeder positions only: id of the BESS SiteArea whose feeders
  // land on this position. Area ids are unique across the site (unlike
  // equipment ids, which repeat per area), so this is a safe cross-area link.
  servesAreaId?: string;
  // Traced (KMZ auto-fill) augmentation reserve units. Feeder grouping treats
  // an augmented PCS as reserved FUTURE capacity on its neighbors' feeder
  // (max 2 per feeder), never as built load with a circuit of its own.
  augmented?: boolean;
  // Traced (KMZ auto-fill) FUTURE build-out units ("FUTURE ..." drawing
  // layers). Rendered and listed like augmentation reserve, excluded from the
  // built MW/MWh/block rollups the same way.
  future?: boolean;
}

export interface AugmentationZone {
  id: string;
  x: number; // center
  y: number;
  length: number;
  width: number;
}

// Site-level reserved areas (Task: laydown + future augmentation by %):
// - 'laydown': temporary construction/staging rectangle near the entrance.
// - 'futureAug': one whole future block footprint reserved in the standard
//   block grid, so future blocks drop straight into the reserved positions.
// Distinct from the per-block AugmentationZone bays (aug-N) above.
export interface ReservedZone {
  id: string;
  kind: 'laydown' | 'futureAug';
  x: number; // center, feet
  y: number;
  length: number; // ft along x (or along local strip axis for rotated islands)
  width: number;  // ft along y (or across local strip axis for rotated islands)
  label: string;
  // Rotation of this zone in degrees from world +x (CCW). 0 = axis-aligned.
  // Only set for aug zones belonging to rotated placed islands.
  angleDeg?: number;
}

// Summary of the reserved-area request vs. what actually fit on the parcel.
export interface ReserveSummary {
  laydownPct: number;
  laydownRequestedSqFt: number;
  laydownPlacedSqFt: number;
  augPct: number;
  augBlocksRequested: number;
  augBlocksPlaced: number;
  augMW: number;   // future capacity of the placed blocks
  augMWh: number;
}

export interface RoadSegment {
  x: number; // center
  y: number;
  length: number; // along direction
  width: number;
  rotation: number; // radians
  // Stable identity for AUTOMATICALLY generated interior roads, so a drafter
  // can select and suppress one piece and the edit survives regeneration:
  // "aisle-<k>" = drive aisle k (south->north), "corridor-<k>" = vertical
  // middle road k (west->east). Absent on the perimeter band and the gate
  // entrance road, which are structural (use the ring-edge offsets instead).
  id?: string;
}

// One piece of a road edge path: straight line or fillet arc.
// Arcs travel from angle `start` to `end` about center `c`;
// `ccw` gives the direction of travel along the path.
export type RoadEdgeSeg =
  | { kind: 'line'; a: Pt; b: Pt }
  | { kind: 'arc'; c: Pt; r: number; start: number; end: number; ccw: boolean };

// Connected yard road network per sheet 10: one road region bounded by the
// filleted outer edge (20 ft radius, just inside the fence) with filleted
// "equipment island" holes (58 ft target radius, auto-shrunk at tight tees).
// Drive aisles are part of the region by construction — they are subtracted
// from the interior, so every aisle meets the perimeter road with no gaps.
export interface RoadNetwork {
  outer: RoadEdgeSeg[];     // closed outer road edge path
  islands: RoadEdgeSeg[][]; // closed island (hole) edge paths
}

// One drafter-deleted road AREA, stored as a closed polygon in site feet.
//
// This is the general road-deletion primitive. The road surface is a single
// boolean region (outer edge minus the even-odd island loops), so "delete this
// road" and "delete this span of road" are the same operation at different
// scales: union the picked area into the non-road loop set. That is why a cut
// works uniformly on the perimeter ring, the gate apron, generated drive
// aisles, vertical middle roads and drafter-drawn roads — none of them are
// special-cased, because none of them exist as separate objects downstream.
//
// A cut is stored as GEOMETRY, not as an index into a generated list. That is
// deliberate: aisle ids renumber when rows move, so an index-keyed cut could
// silently start deleting a different road after an unrelated edit. Ground
// coordinates stay pinned to the physical road the drafter picked.
export interface RoadCut {
  id: string;
  // Closed ring (implicitly closed; first point is not repeated).
  poly: Pt[];
  // Human-readable provenance for the layout-edits panel, e.g.
  // "Drive aisle 2" or "Perimeter road span". Display only.
  label?: string;
}

// Cable classes per the reference legend (Sheets 3-4) and the feeder-routing
// intelligence spec §2 (network taxonomy):
// DC = red(+)/blue(−) pair, MV = cyan dash-dot,
// LVAC = aux distribution 0.480 kV (thin magenta, AUXSWB → equipment aux
// panels along rows and island center), AUXPWR = aux power LV (thin purple,
// AUXT → AUXSWB and local aux equipment), FIBER = 6-count row drops (orange
// dashed, FJB daisy chain along PCS rows), FIBER_TRUNK = 144-count trunk
// (orange solid, control enclosure → one FJB per island), CATL = container
// comms network 6-count (cyan dashed closed ring per container cluster).
export type CableClass =
  | 'DC' | 'MV' | 'LVAC' | 'AUXPWR' | 'FIBER' | 'FIBER_TRUNK' | 'CATL';

// One routed cable run: an open orthogonal polyline in plan feet.
// `ref` marks reference-only stubs to future augmentation equipment
// (no BOL conduit inside exclusion zones per key note 1).
export interface CableRun {
  id: string;
  class: CableClass;
  pts: Pt[];
  ref?: boolean;
  // DC conductors route as (+)/(−) pairs per the reference detail
  // (DC CABLE (+) red / DC CABLE (−) blue), one cable per trench line.
  polarity?: 'pos' | 'neg';
}

// Central "480V Aux and Fiber Trench" band between block rows,
// axis-aligned vertical band centered at x.
// Horizontal per-island "480V Aux and Fiber Trench" band along an island's
// aux-corridor centerline (mirrored-pair layouts only), spanning the island's
// container drops and its mid-island aux cluster.
export interface CorridorTrench {
  islandN: number; // island number the trench serves
  y: number;       // corridor centerline y (or world X for vertical islands — legacy)
  minX: number;
  maxX: number;
  width: number;   // ft
  // Cross-section type (CAR-D-B006-1/2). Optional — absent on designs saved
  // before sections were modeled; corridor trenches default to 'AUX_FIBER'.
  section?: TrenchSectionType;
  // Vertical placed-island corridor band: `y` holds the corridor centerline
  // X coordinate and `minX`/`maxX` hold the band extents along Y.
  // Kept for backward compat with designs saved before `angleDeg` was added.
  vertical?: boolean;
  // For placed islands at arbitrary angles: the center point of the corridor
  // spine in world coordinates and its rotation in degrees CCW from world +x.
  // `length` is the full extent of the trench along its local X axis (ft).
  // When set, cx/cy/angleDeg/length describe the oriented band; minX/maxX/y/vertical
  // are approximate world-AABB values kept for backward-compat consumers only.
  cx?: number;
  cy?: number;
  angleDeg?: number;
  length?: number;
  // Traced-yard SIDE lane (single-sided 480V corridor beside a PCS row or
  // column, not an island center lane). MV home runs may cross it
  // perpendicular like the yard spine band — co-running inside it is still
  // a violation. Island center corridors never set this (hard keep-out).
  sideLane?: boolean;
}

// Trench cross-section type per the issued 90% package trench detail sheets
// (CAR-D-B006-1/2). Section dimensions (depth, bedding, spacing) live in the
// catalog as TRENCH_SECTIONS — the plan bands here carry only the type tag.
export type TrenchSectionType =
  | 'MVAC_DIRECT_BURY' // CAR-D-B006-1 detail 1
  | 'MVAC_DUCT'        // CAR-D-B006-1 detail 2
  | 'AUX_FIBER'        // CAR-D-B006-1 detail 3 (480V aux; combined w/ fiber in plan)
  | 'DC_DUCT_BANK';    // CAR-D-B006-1 detail 4

export interface TrenchBand {
  x: number;       // centerline x
  yBottom: number;
  yTop: number;
  width: number;   // ft
  // Cross-section type (CAR-D-B006-1/2). Optional — absent on designs saved
  // before sections were modeled; the 480V spine defaults to 'AUX_FIBER'.
  section?: TrenchSectionType;
}

// One row of auto-placed blocks, exposed for layout editing. `index` is the
// stable 1-based row number from the automatic placement (south to north),
// so a row keeps its number even after it is moved.
export interface BlockRowInfo {
  index: number;
  y: number;          // current row center y (after any applied move)
  autoY: number;      // row center y from automatic placement
  blockCount: number;
  moved: boolean;
  // Current block-footprint centers of this row (after any applied move),
  // used by the preview for row picking, ghost outlines and drag validation.
  blocks: { n: number; x: number; y: number }[];
}

// Geometry needed to validate a row drag against the same rules the layout
// engine applies (fence/road clearance, NFPA container setback, collisions).
export interface RowEditGeom {
  halfW: number;           // block footprint half-width (x)
  halfD: number;           // block footprint half-depth (y)
  equipmentMargin: number; // ft clearance required from the fence
  // NFPA 855 container check region, offset from the block center; null when
  // the setback pass is disabled.
  nfpa: { offX: number; offY: number; halfW: number; halfD: number; margin: number } | null;
  // Standard block-grid lattice used by the engine's future-aug placement
  // (placeReservedZones): candidate centers are origin + k*step. Exposed so
  // the preview drag can offer snap-to-grid targets that match the engine.
  augGrid: { originX: number; originY: number; stepX: number; stepY: number } | null;
  // Future augmentation UNIT footprint (2 PCS + 6 BESS mirrored pair) fit
  // geometry — may differ from the block footprint on 4-container layouts.
  // Absent on designs saved before aug units existed (block dims then apply).
  aug?: {
    halfW: number;
    halfD: number;
    nfpa: { offX: number; offY: number; halfW: number; halfD: number; margin: number } | null;
  };
}

// Crushed-rock yard surfacing coverage mode:
// - 'between-roads': only the equipment courtyards (road-network islands)
//   are surfaced — the areas enclosed between roads.
// - 'full-yard': everything inside the fence that is not road surface.
// Equipment pads and reserved zones (laydown / future BESS footprints) are
// always excluded; per-block augmentation bays stay surfaced.
export type SurfacingMode = 'between-roads' | 'full-yard';

// One surfacing region: outer ring + interior holes (both simple 2D polygons
// in plan feet, 1:1 layout positions — WYSIWYG for the DXF gravel hatch).
export interface SurfacingRegion {
  outer: Pt[];
  holes: Pt[][];
}

// Computed crushed-rock surfacing plan: regions + bid quantities.
export interface SurfacingPlan {
  mode: SurfacingMode;
  regions: SurfacingRegion[];
  areaSqFt: number;
  depthIn: number;  // rock depth (default 4")
  tons: number;     // areaSqFt * depth -> CY * ~1.4 t/CY
  // Set when the drafter-selectable dead-space trim clipped one or more
  // courtyard regions to their contents (audits relax full-courtyard
  // coverage expectations accordingly). Absent on untrimmed plans.
  deadSpaceTrimmed?: boolean;
}

// One mirrored-pair island: a strip of back-to-back block pairs sharing a
// 10 ft 480V aux cabling corridor down the middle (corridor centerline at
// `y`, spanning `minX`..`maxX`).
export interface IslandInfo {
  n: number;            // 1-based island number (= FF in equipment labels)
  y: number;            // aux corridor centerline (pair-row center)
  minX: number;         // strip extents along x (block footprints)
  maxX: number;
  inverterIds: string[]; // south side W->E, then north side E->W
  southIds: string[];    // south-side PCS ids, W->E (feeder 1 of the island)
  northIds: string[];    // north-side PCS ids, E->W (feeder 2; empty on edge strips)
  // Drafter-placed island (drag-to-place tool). Placed islands are composed
  // as a self-contained unit (blocks + strip-end FJB + mid-island aux
  // cluster + 2 aug units) and are NOT part of the auto row/aisle machinery:
  // row/block moves, island block deltas and align/mirror tools skip them.
  placed?: boolean;
  // Vertical (90°-rotated) placed island. AXIS-SWAPPED SEMANTICS: `y` holds
  // the corridor centerline X coordinate and `minX`/`maxX` hold the strip
  // extents along Y. `cx`/`cy` carry the placement anchor so consumers can
  // map between the island's local (horizontal) frame and world coordinates:
  // world = (cx - localY, cy + localX).
  vertical?: boolean;
  // Arbitrary rotation in degrees (CCW from world +x, 0 = horizontal strip).
  // Takes priority over `vertical`. Only set for placed islands.
  angleDeg?: number;
  cx?: number;
  cy?: number;
  // Drafter-placed islands only: false when the engineer deliberately placed
  // the island as CORE BESS EQUIPMENT ONLY, without the standard mid-island
  // auxiliary cluster (aux transformer + aux distribution + comms cabinet).
  // Only ever false; absence means the island carries its cluster, so every
  // automatic island and every legacy saved placement reads exactly as before.
  // Consumers that expect per-island aux gear (compliance counts, aux
  // collector routing) must treat `auxGear === false` as intentional.
  auxGear?: boolean;
}

// Substation aux feeder circuit (34.5 kV, per reference CAR-D-B005-0): ONE
// circuit leaving the substation and daisy-chaining every aux transformer
// down the yard (brown dashed "AUX FEEDER #NC1" on the reference legend).
// The 480V distribution beyond each transformer stays local (LVAC runs).
export interface AuxFeederLeg {
  pts: Pt[];        // orthogonal polyline, own trench
  lengthFt: number;
}
export interface AuxFeederCircuit {
  circuitNo: number;   // substation circuit number = BESS feeder count + 1
  // Breaker-position circuit name: letter C on the last BESS feeder breaker
  // (e.g. '15C1'; display surfaces prepend '#'). Optional so sessions saved
  // before naming still load — use auxDisplayName() for the fallback.
  name?: string;
  label: string;       // e.g. 'AUX FEEDER #15C1 (34.5 kV)'
  stopIds: string[];   // aux transformer ids in visit order
  legs: AuxFeederLeg[]; // substation -> stop 1 -> ... -> last stop
  totalLengthFt: number;
}

export interface SiteDesign {
  boundary: SiteBoundary;
  fence: Pt[];              // fence polygon
  // KMZ-traced BESS yards use the property boundary as their engineering
  // fence and present that shared line once, in property-line purple. Optional
  // so manual/non-KMZ designs keep their historical output byte-identically.
  propertyLineFence?: true;
  equipment: PlacedEquipment[];
  augmentationZones: AugmentationZone[];
  reservedZones: ReservedZone[];        // site-level laydown + future aug units
  // Ghost equipment for every future augmentation unit (2 PCS + 6 BESS per
  // 'futureAug' reserved zone, ids future-<zoneId>-...). Rendered ghosted in
  // 3D and as individual dashed rects in the DXF; absent on old saved designs.
  futureEquipment?: PlacedEquipment[];
  reserveSummary: ReserveSummary | null; // null when both % inputs are 0
  roads: RoadSegment[];              // entrance road rectangle(s)
  aisles: RoadSegment[];             // interior drive-aisle strips (analysis/derived; drawn via roadNetwork)
  roadNetwork: RoadNetwork | null;   // connected road region (roads mode)
  gate: { x: number; y: number; width: number; rotation: number } | null;
  cables: CableRun[];        // routed DC / MV / LVAC / fiber runs
  // Substation 34.5 kV aux feeder daisy chain; computed with the feeders
  // (needs the substation point), null/absent until one is placed.
  auxFeeder?: AuxFeederCircuit | null;
  trench: TrenchBand | null; // 480V aux + fiber trench band
  // Per-island 480V aux & fiber corridor trench bands (mirrored-pair layouts
  // only; absent on old saved designs).
  corridorTrenches?: CorridorTrench[];
  surfacing: SurfacingPlan | null; // crushed-rock ground cover regions + quantities
  blockRows: BlockRowInfo[];
  // Mirrored-pair (3-container) layouts only: island definitions. An island
  // is one back-to-back strip of block pairs across a shared 10 ft aux
  // corridor. `inverterIds` runs down the south side (west->east) and back up
  // the north side (east->west), matching the reference unit numbering; FF in
  // PCS/CON labels is the island number `n`.
  islands?: IslandInfo[] | null;
  rowEditGeom: RowEditGeom | null; // drag validation geometry (null when no blocks)
  blocksPlaced: number;
  blocksRequired: number;
  // Count of ACCEPTED drafter island block removals (islandBlockDeltas);
  // only present when > 0 so unedited designs stay byte-identical. Lowers
  // the capacity-warning / layout-fallback floor in the layout engine.
  islandBlockRemovalApplied?: number;
  // Count of automatic blocks the drafter deleted outright (removedBlocks),
  // as ACTUALLY applied. Like islandBlockRemovalApplied this lowers the
  // capacity floor so a deliberate deletion never reads as a parcel
  // shortfall or triggers the NFPA-relaxed / compact fallbacks.
  blockRemovalApplied?: number;
  achievedMW: number;
  achievedMWh: number;
  // Traced/hand-placed PCS units and BESS containers (KMZ auto-fill),
  // excluding augmentation reserve. Present only when > 0, so unedited
  // designs stay byte-identical. These count toward the per-area capacity
  // rollup (each traced PCS represents one block at the config rating).
  tracedPcsUnits?: number;
  tracedContainers?: number;
  // Augmentation-reserve and future build-out units from the KMZ auto-fill.
  // Reported separately (panel shows them next to built capacity) and NEVER
  // included in achievedMW/achievedMWh/block counts. Present only when > 0.
  tracedAugPcsUnits?: number;
  tracedAugContainers?: number;
  tracedFuturePcsUnits?: number;
  tracedFutureContainers?: number;
  targetMW: number;
  targetMWh: number;
  warnings: string[];
  // True when this layout was built compact (packed rows, interior roads
  // omitted) — whether chosen explicitly or via the automatic fallback.
  // Drawn-road validation relaxes the pad clearance inflation in compact
  // yards, and the draw-tool preview must make the same call as the engine
  // gate. Only present on compact designs so untouched layouts stay
  // byte-identical.
  compact?: boolean;
}
