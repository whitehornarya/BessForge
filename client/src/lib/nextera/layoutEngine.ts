// Auto-layout engine: places inverter blocks (1 inverter + N LG JF2 containers)
// on a grid inside the fenced yard, respecting NextEra Site Plan Guidance clearances.
// All units in FEET.

import polygonClipping from 'polygon-clipping';
import { BessConfiguration, CLEARANCES, LG_JF2, HITACHI_AUX_XFMR, IPS_SWITCHGEAR, AUX_SWITCH_PANEL, FIBER_PATCH_PANEL, FIRE_CONTROL_PANEL, FEEDER_JUNCTION_BOX, COMMS_CABINET, withContainersPerPcs } from './catalog';
import { generateCableRouting, type DcRoutingMode } from './cableRouting';
import { MAX_INVERTERS_PER_FEEDER } from './feeders';
import { SiteBoundary, SiteDesign, PlacedEquipment, EquipmentKind, AugmentationZone, ReservedZone, ReserveSummary, RoadSegment, RoadEdgeSeg, RoadNetwork, RoadCut, RowEditGeom, Pt, SurfacingMode, SurfacingPlan, SurfacingRegion, IslandInfo } from './types';
import { insetPolygon, rectInsidePolygon, rotatedRectInsidePolygon, pointInPolygon, distanceToPolygonEdge } from './kmz';
import { tracedApronKeepsPavement } from './referenceTrace';
import { applyReferenceLabels } from './labels';
import { polygonArea } from './kmz';

export interface BlockFootprint {
  width: number;     // ft, along x
  depth: number;     // ft, along y
  coreWidth: number; // ft, containers + PCS portion (= width; kept for NFPA math)
}

// ---- Mirrored-pair (3-container) block layout per the Puma reference -------
// 3-container blocks use the NextEra Puma arrangement: blocks form back-to-back
// mirrored pairs across a dedicated 10 ft 480V aux cabling corridor (not a
// road). Each block, from its outer (PCS) end toward the corridor:
//   PCS (long axis x) -> pcs clearance -> A-1 / A-2 containers side by side
//   (long axis y, 3 ft side-to-side clear between them) -> 3 ft -> A-3
//   perpendicular (long axis x, centered) -> corridor edge.
// Per the reference sheet the pair sits CLOSE together and the larger clear
// gap is between adjacent blocks along the strip.
export const AUX_CORRIDOR_FT = 10;    // 480V aux cabling corridor between paired blocks

// Clear gap between adjacent pair footprints along the strip.
//
// The verified Puma drawings dimension 10 ft between adjacent blocks; the
// 14 ft figure in the guidance is the PCS-to-container clearance, which is a
// different rule. Hot-climate (>40C) sites keep 14 ft, matching the wider PCS
// clearance those sites already carry; sites below 40C use the drawn 10 ft.
//
// Both regimes are fully encoded by pcsClearance (14 hot / 10 standard), so
// the gap is DERIVED from it rather than threaded separately. That keeps
// exactly one hot/standard switch in the engine — a caller cannot pair a
// hot-climate clearance with a standard-climate block gap.
export const PAIR_BLOCK_GAP_HOT_FT = 14;
export const PAIR_BLOCK_GAP_STD_FT = 10;
export function pairBlockGapFt(pcsClearance: number): number {
  return pcsClearance >= CLEARANCES.pcsHotClimate
    ? PAIR_BLOCK_GAP_HOT_FT
    : PAIR_BLOCK_GAP_STD_FT;
}

// Standard island (reference island detail): exactly 7 built PCS per side
// (14 per island) around the central aux corridor, one MV feeder per side
// sized for 9 PCS total = 7 built + 2 reserved future. Strips longer than
// one island split into multiple islands with an inter-island gap that fits
// the strip-end gear (FJB + comms) and the default 2-unit augmentation zone.
export const ISLAND_PCS_PER_SIDE = 7;
// Every island reserves this many future augmentation units (2 PCS + 6 BESS
// each) at its strip end by default; drafters can override per island
// (0 disables). Max 2 keeps each feeder at 7 built + 2 future = 9 PCS.
export const DEFAULT_ISLAND_AUG_UNITS = 2;
export const MAX_ISLAND_AUG_UNITS = 2;
export const PAIR_INNER_GAP_FT = 3;   // clear gap between the two parallel containers
export const A3_GAP_FT = 3;           // gap between the parallel pair and the A-3 unit

// Island MIDDLE clearance (90% package CAR-D-B005-1 conduit & trench plan and
// the dimensioned island detail images): the mid-island aux cluster (aux
// distribution center north of the corridor, aux transformer south of it)
// keeps 10'-0" clear on EITHER side to the neighboring container/PCS pair
// columns. The island's middle inter-pair gap is therefore widened from the
// standard block gap to 10 + (widest cluster piece along x) + 10, and the
// augmentation end keeps the standard gaps (see pairBlockGapFt).
export const ISLAND_MIDDLE_CLEAR_FT = 10;

// Extra width the mid-island aux cluster adds to ONE inter-pair gap, over and
// above the standard block gap. This is a fixed physical width (the cluster
// plus its 10 ft clear each side), so it does NOT shrink when the block gap
// shrinks — a smaller gap makes the middle gap relatively WIDER.
export function islandMiddleExtraFt(pcsClearance: number): number {
  const clusterXExtent = Math.max(
    HITACHI_AUX_XFMR.width,   // rot 90: plan x-extent = width
    IPS_SWITCHGEAR.width,     // rot 90
    COMMS_CABINET.length      // rot 0
  );
  return Math.max(0, 2 * ISLAND_MIDDLE_CLEAR_FT + clusterXExtent - pairBlockGapFt(pcsClearance));
}

// Largest x-gap that is still INSIDE one island, plus a tolerance. Blocks
// farther apart than this belong to different islands.
//
// **Why:** the widened middle gap is a fixed physical width while the lattice
// step shrinks with the block gap, so a fixed "1.5 lattice steps" rule breaks:
// at a 10 ft block gap the middle gap (47.33 ft) exceeds 1.5 steps (45 ft) and
// every 7-pair island gets mis-split into 4 + 3. Measure against the real
// intra-island step instead. The tolerance stays well below the inter-island
// skip (>= 2 lattice steps) so genuine island boundaries still split.
export function islandSplitGapFt(latStepX: number, pcsClearance: number): number {
  return latStepX + islandMiddleExtraFt(pcsClearance) + 1;
}

export type PlacedIslandKind = 'island' | 'single' | 'single2';
export interface PlacedIslandSpec {
  id: string;
  x: number;
  y: number;
  // Legacy orientation flag (horizontal = absent, vertical = true). Kept for
  // backward-compat reading of saved files. New code writes `angleDeg` instead.
  vertical?: boolean;
  // Rotation in degrees CCW from world +x axis (0 = strip runs east-west,
  // 90 = strip runs north-south). Takes priority over `vertical` when both
  // are present. Absent or 0 means horizontal (byte-identical to old saves).
  angleDeg?: number;
  pairs?: number;
  // Legacy manual module (`single`) keeps three containers; `single2` is the
  // explicit engineer-selected one-PCS/two-container grouped option.
  kind?: PlacedIslandKind;
  aug?: boolean;
  // Drafter's explicit decision about the standard mid-island AUXILIARY
  // CLUSTER (aux transformer + aux distribution/switchgear + comms cabinet).
  // false = core BESS equipment only: no cluster gear is composed AND the
  // island's middle inter-pair gap is not widened to house it, so an opt-out
  // placement never silently eats spacing around the core blocks. The FJB is
  // NOT aux gear - island feeders terminate in it, so a bare ISLAND keeps it
  // (a single module has neither, see composePlacedIsland).
  // Absent/true keeps the historical cluster, so saved projects round-trip
  // byte-identically.
  auxGear?: boolean;
}

export interface TracedEquipmentSpec {
  id: string; // peq-<n>
  kind: EquipmentKind;
  x: number;
  y: number;
  // degrees CCW, 0 = length along +x. Drawn rotation from the reference.
  rotationDeg?: number;
  lengthFt: number;
  widthFt: number;
  heightFt?: number;
  // Original KMZ rectangle before standard-geometry normalization. This is
  // immutable normalization input only; routing consumes the resulting
  // visible equipment pose so cables/trenches cannot detach from equipment.
  traceSourcePose?: {
    x: number;
    y: number;
    rotationDeg: number;
    lengthFt: number;
    widthFt: number;
  };
  label?: string;
  // 'trace' = auto-filled from the reference drawing, 'manual' = hand-placed.
  source?: 'trace' | 'manual';
  // Traced from an "AUGMENTED ..." drawing layer: reserve capacity, so the
  // unit is excluded from the initial-capacity (MW/MWh) rollup.
  augmented?: boolean;
  // Traced from a "FUTURE ..." drawing layer: later build-out capacity.
  // Imported and rendered like augmentation reserve, excluded from the
  // built MW/MWh/block rollups the same way.
  future?: boolean;
}

export function equipmentForRouting(equipment: PlacedEquipment[]): PlacedEquipment[] {
  // Compatibility seam for routing callers: the immutable traceSourcePose is
  // the basis from which climate normalization is deterministically rebuilt,
  // never a second geometry presented to cable/feeder/trench consumers.
  return equipment;
}

export function isMirroredPairConfig(config: BessConfiguration): boolean {
  return config.containersPerBlock === 3;
}

// Depth of ONE block of a mirrored pair (PCS outer edge to corridor edge)
export function mirroredBlockDepth(config: BessConfiguration, pcsClearance: number): number {
  return config.inverterDims.width + pcsClearance + LG_JF2.length + A3_GAP_FT + LG_JF2.width;
}

// Block layout (plan view, containers long-axis along y):
//   [PCS]  <- pcs clearance ->
//   [pair row: containers side by side, front facing PCS]
//   <- rear-to-rear 3 ft ->
//   [pair row: containers side by side, rear to rear with row above]
// No per-block augmentation bay: the MV transformer is integrated into the
// PCS per the current reference standard, so the block is just its core.
export function blockFootprint(config: BessConfiguration, pcsClearance: number): BlockFootprint {
  if (isMirroredPairConfig(config)) {
    // Footprint of a whole mirrored PAIR (two blocks + aux corridor). The
    // lattice places pairs; the odd/edge case fills only the south half.
    // A-3 lies perpendicular (long axis x) and is wider than the tightened
    // pair span, so it governs the footprint width alongside the PCS.
    const width = Math.max(
      2 * LG_JF2.width + PAIR_INNER_GAP_FT,
      config.inverterDims.length,
      LG_JF2.length
    );
    const depth = 2 * mirroredBlockDepth(config, pcsClearance) + AUX_CORRIDOR_FT;
    return { width, depth, coreWidth: width };
  }
  const pairsAcross = Math.ceil(config.containersPerBlock / 2); // containers side-by-side per row
  const rowWidth = pairsAcross * LG_JF2.width + (pairsAcross - 1) * CLEARANCES.sideToSide;
  const containerDepth = LG_JF2.length * 2 + CLEARANCES.rearToRear;
  const coreWidth = Math.max(rowWidth, config.inverterDims.length);
  const depth = containerDepth + pcsClearance + config.inverterDims.width;
  return { width: coreWidth, depth, coreWidth };
}

// Future augmentation unit: QTY 2 PCS + QTY 6 BESS containers, arranged
// exactly like one mirrored pair (Puma reference) regardless of the built
// configuration. For 3-container layouts this equals the block-pair footprint.
export function augUnitFootprint(config: BessConfiguration, pcsClearance: number): BlockFootprint {
  return blockFootprint({ ...config, containersPerBlock: 3 }, pcsClearance);
}

// Ghost equipment for one future augmentation unit centered at (cx, cy):
// the same 2-PCS + 6-BESS mirrored-pair arrangement placeMirroredPair builds
// for real blocks, with stable future-<zoneId>-... ids. Rendered ghosted in
// 3D and as individual dashed footprint rects in the DXF (WYSIWYG).
export function augUnitEquipment(
  zoneId: string,
  cx: number,
  cy: number,
  config: BessConfiguration,
  pcsClearance: number
): PlacedEquipment[] {
  const cfg3 = { ...config, containersPerBlock: 3 };
  const fp = augUnitFootprint(config, pcsClearance);
  const out: PlacedEquipment[] = [];
  placeMirroredPair(out, cfg3, 0, cx, cy, fp, pcsClearance, 2);
  return out.map(eq => ({
    ...eq,
    id: `future-${zoneId}-${eq.id}`,
    label: eq.kind === 'inverter' ? 'FUTURE PCS' : 'FUTURE BESS',
  }));
}

export type RoadMode = 'auto' | 'roads' | 'compact';

// Alternative deterministic placement arrangements: the same standard block
// lattice filled in a different scan order (which corner the yard packs
// from). On irregular/concave parcels this yields genuinely different yards
// (which lattice sites fill first, where partial rows land, where the aux
// pad and reserved areas end up). 'sw' is the standard default and is
// byte-identical to the historical layout.
export type ArrangementStrategy = 'sw' | 'se' | 'nw' | 'ne';

export const ARRANGEMENTS: { id: ArrangementStrategy; label: string; description: string }[] = [
  { id: 'sw', label: 'Standard (pack south-west)', description: 'Default: rows fill west to east, south row first' },
  { id: 'se', label: 'Pack south-east', description: 'Rows fill east to west, south row first' },
  { id: 'nw', label: 'Pack north-west', description: 'Rows fill west to east, north row first' },
  { id: 'ne', label: 'Pack north-east', description: 'Rows fill east to west, north row first' },
];

// Drafter layout edits, honored on every regeneration:
// - rowMoves: offset (dx, dy) applied to a whole auto-placed block row, keyed
//   by the stable 1-based auto row index (south to north). Moves that would
//   violate fence clearance, the NFPA setback, or overlap other blocks are
//   rejected with a warning and the automatic position is kept.
// - trenchX: pin the 480V aux + fiber trench (LVAC spine) corridor to this x;
//   null/undefined = automatic placement.
// - laydownPin: pin the construction laydown rectangle's center to this point
//   (site feet). The engine sizes the rectangle at the pinned spot with the
//   same aspect/shrink search it uses for auto placement; if nothing fits
//   there, the pin is rejected with a warning and auto placement is kept.
// - laydownSize: drafter-chosen laydown rectangle dimensions (feet). When set,
//   the engine places EXACTLY this rectangle (at the pin if one is set,
//   otherwise at the first spot found scanning south to north). If the exact
//   size fits nowhere, the size is rejected with a warning (stable prefix the
//   store checks) and the automatic aspect/shrink search is used instead.
export interface LayoutConstraints {
  rowMoves?: Record<number, { dx: number; dy: number }>;
  // blockMoves: offset (dx, dy) applied to ONE block (its containers, PCS and
  // aug bay as a unit), keyed by the stable 1-based block number. Applied
  // AFTER row moves (offsets compose), validated with the same
  // fence/NFPA/frozen-road/collision rules; invalid moves are rejected with a
  // warning and the block keeps its automatic (or row-moved) position.
  blockMoves?: Record<number, { dx: number; dy: number }>;
  // equipMoves: offset (dx, dy) applied to a SINGLE equipment item, keyed by
  // its stable id (e.g. bess-3-2, inv-3, fire-panel). Applied after block
  // moves, validated against fence clearance, the NFPA container setback
  // (BESS only), frozen drive aisles and collisions with everything else.
  equipMoves?: Record<string, { dx: number; dy: number }>;
  // equipRots: quarter turns CLOCKWISE applied to a SINGLE equipment item,
  // keyed by its stable id. Applied after equipMoves (so a moved item rotates
  // at its new spot) and validated by the same shared check a move uses, with
  // the item's ROTATED plan extents. Rejected rotations keep the automatic
  // orientation with a warning ("Equipment <id> rotation rejected: ...").
  equipRots?: Record<string, number>;
  // blockRots: quarter turns CLOCKWISE applied to one whole block (its PCS +
  // containers) about the block's own footprint center, keyed by the stable
  // 1-based block number. Same validation as an equipment rotation, run per
  // member against everything outside the block; all-or-nothing.
  blockRots?: Record<number, number>;
  trenchX?: number | null;
  laydownPin?: Pt | null;
  laydownSize?: { length: number; width: number } | null;
  // augPins: pin individual future BESS block reserves ('futureAug' reserved
  // zones) by their stable zone id (future-blk-N for auto/%-placed blocks,
  // island-aug-N-K for per-island units). Pins that violate the fence/road
  // clearances or the NFPA container setback are rejected with a warning and
  // the automatic position is kept for that block/unit.
  augPins?: Record<string, Pt>;
  // islandBlockDeltas: add/remove whole PCS+QTY3 blocks on a mirrored-pair
  // island, keyed by the stable 1-based island number (delta in blocks,
  // positive = add, negative = remove). Applied to the automatic plan before
  // block numbering: adds fill a half pair first, then open a new pair
  // column just past either strip end (fence/NFPA/spacing validated);
  // removals shrink from the strip end but never below 1 block. Infeasible
  // changes are rejected with a warning and the automatic island is kept.
  // Deltas for island numbers the layout does not create are dormant.
  islandBlockDeltas?: Record<number, number>;
  // islandAugUnits: extra future augmentation units (2 PCS + 6 BESS each)
  // appended at an island's strip ends, keyed by the stable 1-based island
  // number. Units that fit nowhere at either end are rejected with a warning.
  islandAugUnits?: Record<number, number>;
  // islandAugEnd: which strip end holds an island's augmentation units, keyed
  // by the stable 1-based island number (as a string) for auto islands, or by
  // the placed-island id (pisl-<n>) for drag-placed islands. Auto islands
  // default to the east-first scan; placed islands default to west (FJB owns
  // the east end — choosing 'east' mirrors the FJB and aug ends). A choice
  // whose end cannot hold the whole unit group is rejected with a warning
  // (stable prefix the store checks) and the automatic end is kept.
  islandAugEnd?: Record<string, 'east' | 'west'>;
  // gatePin: drafter-chosen entrance gate location. The pin is snapped to the
  // nearest point on the fence line where the full opening fits with corner
  // clearance (any edge — the pin overrides the gateEdge knob). Pins too far
  // from the fence are rejected with a warning and the automatic placement is
  // kept. The entrance road re-derives from the pinned gate.
  gatePin?: Pt | null;
  // rowShifts: vertical offset (dy, feet) applied to a whole auto block row,
  // keyed by the stable 1-based auto row index — the road-following sibling
  // of rowMoves.dy. Unlike rowMoves (roads frozen), accepted row shifts
  // REGENERATE the road network, surfacing, trenches and cables around the
  // new row positions, exactly like aisle moves. Used by the wrap/compact
  // tool to pull rows toward the north/south fence edge. Shifts are
  // validated (fence, NFPA, reserved areas, placed islands, other rows at
  // their shifted positions, and the minimum road pitch between adjacent
  // rows so the drive-aisle band always fits); invalid shifts are rejected
  // with a warning ("Row <idx> vertical shift rejected: ...") and the
  // automatic position is kept. Empty/absent = byte-identical output.
  rowShifts?: Record<number, number>;
  // aisleMoves: vertical offset (dy, feet) applied to an interior drive aisle,
  // keyed by the stable 1-based aisle index (aisle k runs between auto block
  // rows k and k+1, south to north). Dragging an aisle carries every row
  // NORTH of it along (rows k+1..N shift by dy) so the aisle keeps its
  // standard clearance to the row above; the gap south of the aisle widens
  // (dy > 0) or narrows (dy down to -AISLE_DOWN_SLACK_FT, keeping the 3 ft
  // road-edge clearance to the row below). Unlike other edits, an accepted
  // aisle move REGENERATES the road network, surfacing, trenches and cables
  // around the new positions. Invalid moves are rejected with a warning and
  // the automatic position is kept.
  aisleMoves?: Record<number, number>;
  // placedIslands: drafter drag-to-place islands. Each entry drops a standard
  // island (`pairs` mirrored-pair columns + mid-island aux cluster +
  // strip-end FJB + 2 augmentation units) centered at (x, y). `vertical`
  // rotates the whole island 90° (strip runs north-south). `pairs` defaults
  // to the full ISLAND_PCS_PER_SIDE; a smaller count places a deliberate
  // PARTIAL island (a half island for the last stub of capacity), composed
  // and validated exactly like a full one — the strip is simply shorter, so
  // it fits where a full island cannot. Placed islands are validated as a
  // unit (fence clearance, NFPA lot-line setback, pinned reserved areas,
  // other placed islands); invalid drops are rejected with a warning
  // ("Placed island <id> rejected: ...") that states what the island needed
  // and what was actually available. Accepted islands consume blocks from
  // the capacity target, keep auto placement clear of their footprint, and
  // get an access-road carve so the road network reaches them.
  // `kind: 'single'` places ONE PCS + its three BESS containers (half a
  // mirrored pair) instead of a paired strip — the smallest placeable module.
  // `aug` is the drafter's explicit augmentation decision for THIS placement:
  // false reserves no augmentation area, ghosts, capacity, BOM item or export
  // linework; absent/true keeps the validated augmentation reserve (absent is
  // the legacy default so saved files round-trip unchanged).
  // Mirrored-pair (QTY3) road-mode layouts only.
  placedIslands?: PlacedIslandSpec[];
  // placedEquipment: individual items the engineer placed by hand — the
  // auxiliary, comms, transformer and fire-control gear that an island
  // placement no longer adds automatically. Each entry is self-contained
  // (type + anchor + quarter-turn), so a manual item's position lives in ONE
  // place: moving it rewrites the spec instead of accumulating an equipMoves
  // delta, and deleting it drops the spec instead of leaving a removedEquipment
  // tombstone. Items that cannot be placed where they were dropped are
  // rejected with the stable "Placed equipment <id> rejected: " prefix and the
  // caller rolls the edit back; clearance-margin findings accept and warn with
  // "Placed equipment <id> placed with warning: ", matching placed islands.
  // The same list also carries items whose footprint is already known in feet
  // (KMZ auto-fill, catalog-dimension gear drops); those are honoured exactly
  // as drawn and only ever warn. See PlacedEquipmentSpec.
  placedEquipment?: PlacedEquipmentSpec[];
  // tracedRatings: client-declared nameplate for a traced yard, derived at
  // trace-apply time from the package's sheet specifications (declared site
  // MW / MWh split evenly across every BUILT traced PCS / container on the
  // site). When present each built traced PCS counts mwPerPcs instead of
  // config.blockMW (and containers mwhPerContainer instead of
  // config.containerMWh), so the panel reads the client's own ratings.
  // Absent on non-traced designs — untouched layouts stay byte-identical.
  tracedRatings?: { mwPerPcs?: number; mwhPerContainer?: number };
  // ringOffsets: drafter per-edge inward offsets (feet) for the perimeter
  // road ring, keyed n/s/e/w. Positive pulls that ring edge inward from its
  // automatic position (fence- or cluster-derived per the ring mode);
  // negative pushes it back out toward the fence. Offsets that would pinch
  // the road band into the equipment cluster or leave the fenced yard are
  // rejected with a warning ("Ring edge <side> move rejected: ...") and the
  // automatic edge is kept.
  ringOffsets?: RingOffsets | null;
  // feederCorridor: drafter-pinned MV feeder corridor centerline — the
  // perpendicular coordinate (y for an east/west substation approach, x for
  // north/south) the parallel home-run lane bundle is centered on. The
  // layout engine itself ignores this field; it lives here so the pin is a
  // first-class layout edit (undo/redo, session/project persistence, "reset
  // layout edits") and is consumed by generateFeeders via the store. Invalid
  // pins are rejected up front by feederCorridorRejectReason; stale pins in
  // saved files are ignored by the router (automatic position kept).
  feederCorridor?: number | null;
  // feederRoutes: drafter-drawn MV feeder home-run routes, keyed by stable
  // feeder identity (feederRouteKey — the lowest-numbered member inverter
  // id, e.g. "inv-3"). Each value is the interior waypoint list; endpoints
  // snap to the feeder's launch point and the substation. Like
  // feederCorridor, the layout engine ignores this field — it lives here so
  // routes are first-class layout edits (undo/redo, persistence, reset) and
  // are consumed by generateFeeders via the store. Invalid routes are
  // rejected with a warning and the automatic route kept; keys matching no
  // current feeder go dormant with a warning.
  feederRoutes?: Record<string, Pt[]>;
  // feederModes: per-feeder home-run routing-mode overrides ('orthogonal' |
  // 'angled'), keyed by stable feeder identity (feederRouteKey, e.g.
  // "inv-3"). Overrides the design-wide default routing mode for just that
  // feeder. Like feederRoutes, the layout engine ignores this field — it
  // lives here so modes are first-class layout edits (undo/redo,
  // persistence, reset) consumed by generateFeeders via the store. Keys
  // matching no current feeder go dormant with a warning; invalid values
  // are dropped by the load sanitizer.
  feederModes?: Record<string, 'orthogonal' | 'angled'>;
  // auxFeederWaypoints: drafter-drawn aux feeder route (interior waypoints,
  // site feet). The whole 34.5 kV daisy chain is one drawable route — the
  // start snaps to the substation and the end snaps to the last aux
  // transformer in visit order; the waypoints define the geometry in between.
  // Like feederRoutes, the layout engine ignores this field — it lives here
  // so the route is a first-class layout edit (undo/redo, session/project
  // persistence, reset) consumed by generateAuxFeeder via the store. Invalid
  // routes (NaN coords, empty) are rejected with a warning and the automatic
  // route is kept. Absent / null = automatic routing.
  auxFeederWaypoints?: Pt[] | null;
  // customRoads: drafter-drawn road centerline polylines (site feet). Each
  // polyline becomes a roadWidth-wide strip carved out of the equipment
  // islands (clipped to the yard interior, never under equipment), so the
  // drawn road joins the connected road network, surfacing and DXF exactly
  // like the auto roads. Roads whose strip is entirely clipped away are
  // reported with a warning but kept (the drafter can delete them).
  // `width` overrides the default 24 ft road width for this road only;
  // absent means use the site standard (24 ft). Range clamped 12–60 ft.
  // `traced` marks a road auto-filled from a KMZ reference drawing:
  // reference-wins, so blockage that would reject a hand-drawn road only
  // WARNS (stable "Traced road <id> placed with warning:" prefix) and the
  // drivable part of the strip is kept.
  customRoads?: { id: string; pts: Pt[]; width?: number; traced?: boolean; tracedV?: number; outline?: Pt[]; surface?: Pt[]; entrance?: boolean; gate?: Pt; apron?: boolean }[];
  // removedRoads: stable ids of AUTOMATICALLY generated interior road pieces
  // the drafter deliberately removed ("aisle-<k>" drive aisles,
  // "corridor-<k>" vertical middle roads). The piece is omitted from the road
  // network, so surfacing, cables, feeder routes and every export re-derive
  // without it. The perimeter band and gate entrance are NOT removable (they
  // are the yard's only vehicle entry — use the ring-edge offsets to reshape
  // the band instead). Removing a piece that isolates equipment from the road
  // network keeps the removal and warns about the broken access, rather than
  // silently reverting or hiding the consequence. Ids that no longer exist go
  // dormant with a warning and revive if the piece returns (same stable-
  // identity policy as rowMoves/blockMoves). The gate entrance road is
  // addressable as the sentinel id 'gate-entrance' (see GATE_ENTRANCE_ROAD_ID):
  // removing it drops both the entrance rectangle and the apron union, so the
  // yard keeps its ring but loses its driveway (reported, never silent).
  removedRoads?: string[];
  // removedTracedRoads: geometry tombstones for TRACED roads the drafter
  // deleted. A stale save's heal re-derives an area's traced set WHOLESALE
  // from the reference drawing (rederiveStaleTracedRoads) with re-sequenced
  // ids, so `troad-N` cannot key a deletion; instead the deleted strip's
  // fingerprint (bbox center + polyline length, site feet — see
  // tracedRoadFingerprint) suppresses the matching fresh strip. A full
  // re-apply of the trace clears the list: Apply intentionally restores the
  // complete drawn road set.
  removedTracedRoads?: { x: number; y: number; len: number }[];
  // pavedTracedRoads: pave-as-drawn overrides for TRACED strips the gate-
  // apron rule keeps as reference linework. The rule's thresholds are
  // engineering judgment — a site with a legitimately longer entrance drive
  // (say a 500 ft on-parcel approach lane) fails it and renders unpaved with
  // only a warning — so the drafter can force-pave a specific strip instead
  // of editing constants. Same keep-and-warn philosophy as drawn-road accept
  // gates: the strip paves exactly as drawn and the linework-only warning is
  // swapped for an override warning. Keyed by the SAME geometry fingerprint
  // as deletion tombstones (tracedRoadFingerprint — bbox center + polyline
  // length) so the stale-save wholesale re-derivation re-applies the
  // override to the matching fresh strip despite id re-sequencing. A full
  // re-apply of the trace clears the list, exactly like removedTracedRoads.
  pavedTracedRoads?: { x: number; y: number; len: number }[];
  // roadCuts: drafter-deleted road AREAS, as closed polygons in site feet.
  // This is the general deletion primitive that covers the road kinds an id
  // cannot name: a span of the perimeter ring, part of a drive aisle, a piece
  // of a drawn road — anything the drafter picks point-to-point on the plan.
  // Each polygon is SUBTRACTED from the connected road surface by unioning it
  // into the equipment-island (non-road) loop set, which is exactly how the
  // renderer, the DXF even-odd hatch, surfacing and routing already read
  // "not road". Because a cut is stored as geometry rather than an index, it
  // stays pinned to the same physical ground across regeneration, row moves
  // and equipment edits — an aisle renumbering can never make an old cut
  // silently delete a different road. Cuts that land entirely off the road
  // surface go dormant with a warning instead of being dropped.
  roadCuts?: RoadCut[];
  // removedBlocks: stable 1-based numbers of AUTOMATICALLY generated blocks
  // (one PCS + its containers + its aug bay) the drafter deleted. The block's
  // equipment is omitted, so islands, feeders, cables, trenching, reserved
  // zones, capacity, the BOM and every export re-derive without it.
  // Deliberately NOT a renumbering: the surviving blocks keep their automatic
  // numbers, so every other edit keyed by block number (moves, rotations, DC
  // routing overrides) still points at the same physical block. Numbers the
  // current layout does not create go dormant with a warning and revive if
  // the block returns (same stable-identity policy as removedRoads).
  removedBlocks?: number[];
  // removedEquipment: stable ids of individual AUTO equipment items the
  // drafter deleted (e.g. bess-3-2 for one container, or yard gear such as
  // fire-panel). Deleting a PCS ('inv-<n>') would leave its containers with
  // no inverter, so it ESCALATES to removing that whole block and says so.
  removedEquipment?: string[];
  // substation: substation location HINT for island feeder-junction-box end
  // selection: each island's FJB is placed at the strip end FACING the
  // substation (falling back to the opposite end when blocked), so feeders
  // launch toward the corridor and never wrap around the far side of the
  // yard. No substation hint keeps the historical east-first preference
  // (byte-identical layouts). This is a hint, not a stored edit — the store
  // injects the live substation at regenerate time; it is never persisted
  // inside layoutEdits.
  substation?: Pt | null;
  // dcRoutingOverrides: per-block DC container-run routing override, keyed by
  // the stable 1-based block number. An entry ('orthogonal' | 'direct')
  // overrides the design-wide dcRouting option for just that block; other
  // blocks follow the default. Overrides whose block number is absent from
  // the current layout go dormant with a warning and revive when the block
  // returns (same stable-identity policy as rowMoves/blockMoves).
  dcRoutingOverrides?: Record<number, DcRoutingMode>;
  // forcedEdits: engineer override keys ("row-<idx>", "aisle-<k>",
  // "block-<n>", "equip-<id>"). A forced edit that fails validation is
  // applied ANYWAY, and the rejection downgrades to an override warning
  // ("… moved with engineer override despite: <reason> — verify in detailed
  // design.") so the drafter owns the deviation. Structural rejections
  // (nonexistent aisle, fixed aux cluster) cannot be forced.
  forcedEdits?: string[];
  // alignIslands: opt-in to column-alignment moves that would otherwise be
  // blocked because they cost the island its augmentation zones at the
  // tighter row pitch. When true, those moves are applied and each affected
  // island gets an "Island alignment applied:" warning listing how many
  // augmentation zones were removed so the drafter can account for the loss
  // in detailed design. When absent/false (default), blocked alignment
  // opportunities are surfaced as "Island alignment available:" notices that
  // name the island and the aug-zone cost, letting the drafter decide whether
  // tidiness is worth the tradeoff. Byte-identical when no alignment
  // opportunities exist.
  alignIslands?: boolean;
}

// Max distance (ft) a gate pin may sit from the fence before it is rejected.
export const GATE_PIN_SNAP_FT = 100;

// Minimum drafter-resized laydown edge, feet (also enforced by the drag UI).
export const MIN_LAYDOWN_EDGE_FT = 20;

// Which fence edge holds the entrance gate: the gate lands on the fence
// segment whose midpoint is furthest in that compass direction. Default 'S'
// (southmost segment) is byte-identical to the historical behavior.
export type GateEdge = 'S' | 'N' | 'E' | 'W';
export const GATE_EDGES: { id: GateEdge; label: string }[] = [
  { id: 'S', label: 'South (default)' },
  { id: 'N', label: 'North' },
  { id: 'E', label: 'East' },
  { id: 'W', label: 'West' },
];

export interface LayoutOptions {
  hotClimate: boolean; // >40C ambient -> 14 ft PCS clearance
  roadMode?: RoadMode;  // explicit compact mode omits access roads
  // false = do NOT auto-wrap access roads around hand-placed islands or
  // drafter-moved pads. Absent/true keeps the historical wrap band +
  // connector behavior byte-identically. Lets a drafter place equipment
  // without the road network changing underneath them.
  autoRoadWrap?: boolean;
  // Set only by the multi-area store path. Normal automatic multi-area
  // layouts preserve access roads even when the full target cannot fit; the
  // engine reports the exact shortfall instead of silently changing the
  // civil design to compact. Single-area auto behavior remains unchanged.
  multiArea?: boolean;
  // Perimeter road ring style. 'fence' (default) follows the entire fence
  // line at the standard setback inset — even around empty ground. 'shrink'
  // hugs the placed equipment cluster on all four sides. 'hybrid' hugs only
  // the sides where the fence is far from the cluster and follows the fence
  // on the packed sides.
  ringMode?: RingMode;
  // Perimeter band placement: 'standard' (default) leaves the historical
  // 10 ft strip between the fence and the outside road edge; 'flush' runs
  // the outside road edge on the inside fence line so that strip becomes
  // usable road area. See PerimeterBandMode.
  perimeterBand?: PerimeterBandMode;
  // Where the security fence is drawn: 'inset' (default) keeps the typical
  // fenceToLotLine setback, 'property-line' puts the fence on the imported
  // outer boundary so the whole parcel becomes usable yard. See
  // FencePlacementMode — an EOR/civil decision, never inferred.
  fencePlacement?: FencePlacementMode;
  constraints?: LayoutConstraints; // drafter edits (row moves, pinned trench)
  laydownPct?: number;  // % of fenced-yard area reserved as construction laydown
  augmentPct?: number;  // % of placed blocks reserved, rounded up to whole 2-PCS aug units
  // Explicit future-phase augmentation units (2 PCS + 6 BESS each) placed in
  // the reserved-area grid exactly like the % reserve, in addition to it.
  futurePhaseUnits?: number;
  arrangement?: ArrangementStrategy; // block-lattice scan order; default 'sw'
  // Optimizer knobs (default = automatic/historical behavior, byte-identical):
  // latticeShift slides the block placement lattice origin by (x, y) feet —
  // values are normalized into [0, stepX) x [0, stepY); on irregular parcels a
  // shifted lattice can fit more blocks. gateEdge picks the fence edge for the
  // entrance gate.
  latticeShift?: Pt | null;
  gateEdge?: GateEdge | null;
  // Saved legacy projects may explicitly retain four containers; omitted means
  // the configuration's three-container four-hour standard.
  containersPerPcs?: number;
  // Crushed-rock yard surfacing coverage. Default 'between-roads'
  // (equipment courtyards only). Depth in inches (default 4").
  surfacingMode?: SurfacingMode;
  surfacingDepthIn?: number;
  // DC container-run routing method: 'orthogonal' (default, sheet-3 90°
  // trench legs) or 'direct' (straight-line runs per the direct-trench
  // guidance drawing; blocked runs keep their 90° path with a warning).
  dcRouting?: DcRoutingMode;
  // Drafter-drawn UNDERGROUND EXCLUSION AREA zones (only that kind is
  // consumed): buried cable/trench routes must not cross them, so the cable
  // router treats them as hard keep-outs. Absent/empty => byte-identical.
  exclusionZones?: import('./areaZones').AreaZone[] | null;
  // Dead-space trim (drafter-selectable, like ringMode): shrink the fence to
  // the minimum compliant hull around everything placed and clip crushed-rock
  // courtyards to their contents, so empty yard strips disappear. Default
  // off => byte-identical. When on but the layout already fills the fence,
  // the trim no-ops (original fence object kept).
  deadSpaceTrim?: boolean;
}

// ---------------------------------------------------------------------------
// Crushed-rock surfacing quantities (exported for tests / BOM):
// tons = area (sqft) * depth (ft) / 27 (cuft->CY) * density (t/CY).
export const SURFACING_DEPTH_IN_DEFAULT = 4;
export const SURFACING_TONS_PER_CY = 1.4;

export function surfacingTons(areaSqFt: number, depthIn: number): number {
  if (!Number.isFinite(areaSqFt) || areaSqFt <= 0 || !Number.isFinite(depthIn) || depthIn <= 0) return 0;
  return (areaSqFt * (depthIn / 12)) / 27 * SURFACING_TONS_PER_CY;
}

// Pure sizing rules for the reserved areas (exported for tests):
// augmentation % of the PLACED blocks, rounded up to whole future blocks.
export function augmentationBlockCount(pct: number, blocksPlaced: number): number {
  if (!Number.isFinite(pct) || pct <= 0 || blocksPlaced <= 0) return 0;
  return Math.ceil((blocksPlaced * pct) / 100);
}

// Future augmentation units: each unit is QTY 2 PCS + QTY 6 containers (one
// mirrored pair), so the pct% block reserve rounds up to whole 2-PCS units.
export function augmentationUnitCount(pct: number, blocksPlaced: number): number {
  return Math.ceil(augmentationBlockCount(pct, blocksPlaced) / 2);
}

// Laydown % of the fenced-yard area, in square feet.
export function laydownAreaSqFt(pct: number, fenceAreaSqFt: number): number {
  if (!Number.isFinite(pct) || pct <= 0 || fenceAreaSqFt <= 0) return 0;
  return (pct / 100) * fenceAreaSqFt;
}

// ---------------------------------------------------------------------------
// Shared row-drag / row-move validation. Used both by the engine when it
// applies constraint row moves and by the preview for live green/red ghost
// feedback while dragging, so both always agree.
export const MIN_BLOCK_SEP = 3; // ft minimum separation between moved and other block footprints
export const DRAG_SNAP_FT = 5;  // preview drag snaps to a 5 ft layout grid

export function snapToGrid(v: number, grid = DRAG_SNAP_FT): number {
  return Math.round(v / grid) * grid;
}

// Snap a dragged future-block center onto the engine's standard block lattice
// (origin + k*step per axis) when within `threshold` ft on that axis. Each
// axis snaps independently so "same grid, just this column" works. Returns
// the (possibly) adjusted point plus whether either axis snapped.
export const AUG_SNAP_THRESHOLD_FT = 15;

export function snapToAugLattice(
  x: number,
  y: number,
  grid: { originX: number; originY: number; stepX: number; stepY: number } | null | undefined,
  threshold = AUG_SNAP_THRESHOLD_FT
): { x: number; y: number; snappedX: boolean; snappedY: boolean } {
  if (!grid || grid.stepX <= 0 || grid.stepY <= 0) {
    return { x, y, snappedX: false, snappedY: false };
  }
  const latX = grid.originX + Math.round((x - grid.originX) / grid.stepX) * grid.stepX;
  const latY = grid.originY + Math.round((y - grid.originY) / grid.stepY) * grid.stepY;
  const snappedX = Math.abs(latX - x) <= threshold;
  const snappedY = Math.abs(latY - y) <= threshold;
  return { x: snappedX ? latX : x, y: snappedY ? latY : y, snappedX, snappedY };
}

// Axis-aligned half extents of a road/aisle strip. Auto drive aisles are
// horizontal (rotation 0, length along x); corridor roads between islands in
// the same strip row are vertical (rotation 90°, length along y).
export function aisleHalves(a: { length: number; width: number; rotation: number }): { hx: number; hy: number } {
  const rot = Math.abs(Math.sin(a.rotation)) > 0.5;
  return { hx: (rot ? a.width : a.length) / 2, hy: (rot ? a.length : a.width) / 2 };
}

// Row moves are cumulative offsets from the AUTO position; a drag delta from
// the current position composes with any existing move for that row.
export function composeRowMove(
  prev: { dx: number; dy: number } | undefined,
  deltaX: number,
  deltaY: number
): { dx: number; dy: number } {
  return { dx: (prev?.dx ?? 0) + deltaX, dy: (prev?.dy ?? 0) + deltaY };
}

// Validate translating a set of row block centers by (ddx, ddy) from their
// CURRENT positions. Returns null when valid, otherwise a human-readable
// rejection reason (same wording the engine puts in its warning).
export function validateRowShift(
  rowBlocks: { n: number; x: number; y: number }[],
  otherBlocks: { n: number; x: number; y: number }[],
  geom: RowEditGeom,
  fence: Pt[],
  boundaryPolygon: Pt[],
  ddx: number,
  ddy: number,
  frozenAisles: RoadSegment[] = [],
  reserved: { id?: string; x: number; y: number; length: number; width: number }[] = []
): string | null {
  // Auto placement packs rows at EXACTLY the minimum aisle clearance, so a
  // strict overlap test trips on floating-point noise at the untouched
  // position and every edit gets "blocked" (align reports already-aligned,
  // mirror rejects). Two guards fix that without weakening real checks:
  // an epsilon on the penetration depth, and a baseline comparison — a move
  // is rejected only when it DEEPENS the worst aisle encroachment relative
  // to the block's current position (sliding along a road at constant
  // clearance stays legal; moving INTO a road does not).
  const EPS = 1e-6;
  const aislePenetration = (a: RoadSegment, x: number, y: number): number => {
    const h = aisleHalves(a);
    const ox = geom.halfW + h.hx + (h.hx < h.hy ? CLEARANCES.equipmentToRoadEdge : 0) - Math.abs(x - a.x);
    const oy = geom.halfD + h.hy + (h.hx < h.hy ? 0 : CLEARANCES.equipmentToRoadEdge) - Math.abs(y - a.y);
    return Math.min(ox, oy);
  };
  for (const b of rowBlocks) {
    const nx = b.x + ddx, ny = b.y + ddy;
    if (!rectInsidePolygon(nx, ny, geom.halfW, geom.halfD, fence, geom.equipmentMargin)) {
      return `block ${b.n} would violate the fence/road clearance`;
    }
    // Roads are FROZEN during layout edits: the moved block must stay off the
    // frozen drive-aisle strips and keep the 3 ft road-edge clearance
    // (sheet 10 key note 5). Per-aisle non-worsening test: reject only when
    // the move deepens THAT aisle's encroachment beyond its current value.
    const aisleHit = frozenAisles.find(a => {
      const newPen = aislePenetration(a, nx, ny);
      return newPen > EPS && newPen > aislePenetration(a, b.x, b.y) + EPS;
    });
    if (aisleHit) {
      return `block ${b.n} would encroach on a frozen drive aisle (roads stay fixed during edits; ${CLEARANCES.equipmentToRoadEdge} ft road-edge clearance required)`;
    }
    if (geom.nfpa && !rectInsidePolygon(
      nx + geom.nfpa.offX, ny + geom.nfpa.offY,
      geom.nfpa.halfW, geom.nfpa.halfD,
      boundaryPolygon, geom.nfpa.margin
    )) {
      return `block ${b.n} containers would breach the ${CLEARANCES.bessToLotLine} ft NFPA 855 lot-line setback`;
    }
    const hit = otherBlocks.find(o =>
      Math.abs(nx - o.x) < geom.halfW * 2 + MIN_BLOCK_SEP - EPS &&
      Math.abs(ny - o.y) < geom.halfD * 2 + MIN_BLOCK_SEP - EPS
    );
    if (hit) return `block ${b.n} would collide with block ${hit.n}`;
    const rHit = reserved.find(z =>
      Math.abs(nx - z.x) < geom.halfW + z.length / 2 + MIN_EQUIP_SEP - EPS &&
      Math.abs(ny - z.y) < geom.halfD + z.width / 2 + MIN_EQUIP_SEP - EPS
    );
    if (rHit) return `block ${b.n} would overlap a reserved area`;
  }
  return null;
}

// Gap between adjacent block rows in road layouts: the drive aisle plus the
// required equipment-to-road-edge clearance on BOTH sides (reference
// standard: 24' road, 8'-0 3/4" to equipment). Also satisfies the 10 ft
// container front-to-front clearance by a wide margin.
export const ROW_AISLE_GAP_FT = CLEARANCES.roadWidth + 2 * CLEARANCES.equipmentToRoadEdge;

// How far an interior drive aisle may move DOWN (south, toward the row below
// it). The auto lattice centers the aisle in ROW_AISLE_GAP_FT, leaving exactly
// equipmentToRoadEdge between the aisle edge and each facing row — so there is
// no southward slack. Upward moves are limited only by fence/NFPA room above.
export const AISLE_DOWN_SLACK_FT =
  (ROW_AISLE_GAP_FT - CLEARANCES.roadWidth) / 2 - CLEARANCES.equipmentToRoadEdge;

// Validate dragging interior drive aisle k by dy: every row NORTH of the
// aisle (its blocks passed as movingBlocks) shifts with it. `ddy` is the
// shift from the blocks' CURRENT positions; `newTotalDy` is the composed
// total offset from the AUTO position (it alone decides the aisle's
// road-edge clearance to the unmoved row below). Shared by the engine and
// the preview drag ghost so both always agree. Returns null when valid,
// otherwise a human-readable rejection reason.
export function validateAisleShift(
  movingBlocks: { n: number; x: number; y: number }[],
  otherBlocks: { n: number; x: number; y: number }[],
  geom: RowEditGeom,
  fence: Pt[],
  boundaryPolygon: Pt[],
  ddy: number,
  newTotalDy: number,
  reserved: { id?: string; x: number; y: number; length: number; width: number }[] = []
): string | null {
  if (!movingBlocks.length) return 'no block rows north of this aisle to carry along';
  if (newTotalDy < -AISLE_DOWN_SLACK_FT - 1e-9) {
    return `the aisle would come within ${CLEARANCES.equipmentToRoadEdge} ft of the row south of it ` +
      `(max ${AISLE_DOWN_SLACK_FT} ft southward from the automatic position)`;
  }
  return validateRowShift(
    movingBlocks, otherBlocks, geom, fence, boundaryPolygon, 0, ddy, [], reserved
  );
}

// ---------------------------------------------------------------------------
// One-click row alignment (main 3D screen): compute the per-row horizontal
// shift (from CURRENT positions) that aligns every block row left / center /
// right within the usable yard. Each row is pushed as far as the shared
// validateRowShift rules allow (fence/road clearance, NFPA setback, frozen
// aisles, collisions, reserved areas), so the result is exactly what the
// engine will accept when applied through the normal rowMoves pipeline.
export type RowAlignMode = 'left' | 'center' | 'right';

// Coarse stride (ft) for the non-monotone-validity guard scan in
// computeRowAlignOffsets. Walking the full 0.5 ft grid across a multi-
// thousand-foot span for every row/direction made alignment clicks pause
// on very wide sites; a 4 ft stride with local 0.5 ft refinement around
// the first hit keeps clicks instant while still landing on the exact
// 0.5 ft limit of any pocket the coarse scan touches.
export const ROW_ALIGN_GUARD_STRIDE_FT = 4;

export function computeRowAlignOffsets(
  design: Pick<SiteDesign, 'blockRows' | 'rowEditGeom' | 'fence' | 'boundary' | 'aisles' | 'reservedZones'>,
  mode: RowAlignMode,
  // When set, only this row is aligned (all other rows stay put and act as
  // obstacles). Used by island-scoped alignment.
  onlyRowIndex?: number
): Record<number, { dx: number; dy: number }> {
  const geom = design.rowEditGeom;
  const out: Record<number, { dx: number; dy: number }> = {};
  if (!geom || !design.blockRows.length) return out;
  const fence = design.fence;
  const boundaryPolygon = design.boundary.polygon;
  const reserved = design.reservedZones;
  const frozenAisles = design.aisles;
  const xs = fence.map(p => p.x);
  const span = Math.max(...xs) - Math.min(...xs);
  if (!Number.isFinite(span) || span <= 0) return out;

  for (const row of design.blockRows) {
    if (onlyRowIndex !== undefined && row.index !== onlyRowIndex) continue;
    const rowBlocks = row.blocks;
    if (!rowBlocks.length) continue;
    const others = design.blockRows
      .filter(r => r.index !== row.index)
      .flatMap(r => r.blocks);
    const valid = (ddx: number) =>
      validateRowShift(rowBlocks, others, geom, fence, boundaryPolygon, ddx, 0, frozenAisles, reserved) === null;
    // Obstacle-edge candidate shifts: the coarse guard stride can step clean
    // over a valid pocket narrower than ROW_ALIGN_GUARD_STRIDE_FT sitting
    // between two invalid samples. Every pocket boundary, though, is where
    // some block's expanded footprint touches an obstacle's x-extent (or a
    // fence/NFPA vertex), so enumerate those ddx values exactly and seed the
    // guard scan with them — a pocket of ANY width bounded by an obstacle
    // then always gets at least one tested sample.
    const edgeCandidates: number[] = [];
    for (const b of rowBlocks) {
      for (const o of others) {
        if (Math.abs(b.y - o.y) < geom.halfD * 2 + MIN_BLOCK_SEP) {
          const w = geom.halfW * 2 + MIN_BLOCK_SEP;
          edgeCandidates.push(o.x - b.x - w, o.x - b.x + w);
        }
      }
      for (const a of frozenAisles) {
        if (Math.abs(b.y - a.y) < geom.halfD + a.width / 2 + CLEARANCES.equipmentToRoadEdge) {
          const w = geom.halfW + a.length / 2;
          edgeCandidates.push(a.x - b.x - w, a.x - b.x + w);
        }
      }
      for (const z of reserved) {
        if (Math.abs(b.y - z.y) < geom.halfD + z.width / 2 + MIN_EQUIP_SEP) {
          const w = geom.halfW + z.length / 2 + MIN_EQUIP_SEP;
          edgeCandidates.push(z.x - b.x - w, z.x - b.x + w);
        }
      }
      for (const v of fence) {
        const w = geom.halfW + geom.equipmentMargin;
        edgeCandidates.push(v.x - b.x - w, v.x - b.x + w);
      }
      if (geom.nfpa) {
        for (const v of boundaryPolygon) {
          const w = geom.nfpa.halfW + geom.nfpa.margin;
          const cx = b.x + geom.nfpa.offX;
          edgeCandidates.push(v.x - cx - w, v.x - cx + w);
        }
      }
    }
    // Largest valid shift in direction sign (+1 east, -1 west): bisection
    // (fast path, assumes one continuous valid span) snapped DOWN to a
    // 0.5 ft grid, then a coarse guard scan for non-monotone validity —
    // on concave parcels or yards fragmented by reserved areas a farther
    // valid landing spot can exist beyond an invalid gap, which bisection
    // alone would miss. To stay snappy on very wide sites the scan walks
    // a coarse ROW_ALIGN_GUARD_STRIDE_FT stride from the far end back
    // toward the bisection result; on the first valid coarse hit it
    // refines UP through the untested 0.5 ft grid positions in the stride
    // window above the hit (the previous coarse sample was invalid, so
    // the true limit can only be inside that window) and returns the
    // furthest valid one. The coarse samples are merged with the
    // obstacle-edge seeds above, so pockets narrower than the stride are
    // still found whenever they are bounded by an obstacle or a fence/NFPA
    // vertex; any pocket the scan touches is aligned to its exact 0.5 ft
    // limit. Residual limit: a sub-stride pocket bounded ONLY by slanted
    // concave fence edges (no obstacle edge or vertex x-value inside it)
    // can still be skipped — the row then aligns to a nearer valid spot,
    // never an invalid one.
    const maxShift = (sign: 1 | -1): number => {
      let s = 0;
      if (valid(sign * 0.5)) {
        let lo = 0.5, hi = span;
        if (valid(sign * hi)) lo = hi;
        else for (let i = 0; i < 24 && hi - lo > 0.05; i++) {
          const mid = (lo + hi) / 2;
          if (valid(sign * mid)) lo = mid; else hi = mid;
        }
        s = Math.floor(lo / 0.5) * 0.5;
        while (s > 0 && !valid(sign * s)) s -= 0.5;
      }
      const gridMax = Math.floor(span / 0.5) * 0.5;
      // Merge the coarse stride samples with obstacle-edge seeds (mapped
      // into this direction's shift magnitude, snapped DOWN to the 0.5 ft
      // grid; the point just below is added too, guarding exact-on-grid
      // boundary values that validate as touching-invalid).
      const samples = new Set<number>();
      for (let cand = gridMax; cand > s + 0.25; cand -= ROW_ALIGN_GUARD_STRIDE_FT) {
        samples.add(cand);
      }
      for (const c of edgeCandidates) {
        const t = Math.floor((sign * c) / 0.5) * 0.5;
        for (const v of [t, t - 0.5]) {
          if (v > s + 0.25 && v <= gridMax) samples.add(v);
        }
      }
      const ordered = Array.from(samples).sort((a, b) => b - a);
      for (const cand of ordered) {
        if (!valid(sign * cand)) continue;
        const top = Math.min(gridMax, cand + ROW_ALIGN_GUARD_STRIDE_FT - 0.5);
        for (let f = top; f > cand + 0.25; f -= 0.5) {
          if (valid(sign * f)) return f;
        }
        return cand;
      }
      // No coarse hit: the 0.5 ft positions between the bisection result and
      // the lowest (invalid) coarse sample are still untested — bisection can
      // converge just below the true limit (snap-down) and the stride can step
      // over it. Fine-scan that one stride-wide window down toward s.
      const top = Math.min(gridMax, s + ROW_ALIGN_GUARD_STRIDE_FT);
      for (let f = top; f > s + 0.25; f -= 0.5) {
        if (valid(sign * f)) return f;
      }
      return s;
    };
    let ddx = 0;
    if (mode === 'left') ddx = -maxShift(-1);
    else if (mode === 'right') ddx = maxShift(1);
    else {
      const west = maxShift(-1);
      const east = maxShift(1);
      ddx = Math.round(((east - west) / 2) / 0.5) * 0.5;
      if (ddx !== 0 && !valid(ddx)) ddx = 0;
    }
    if (Math.abs(ddx) >= 0.5) out[row.index] = { dx: ddx, dy: 0 };
  }
  return out;
}

// Island-scoped alignment: shift ONE selected mirrored-pair island left /
// center / right within the usable yard, as a rigid unit. An island is one
// pair row, so the shift rides the same declarative rowMoves mechanism and
// clearance rules as whole-yard row alignment — the island's row is aligned
// while every other row stays put and acts as an obstacle. Returns the row
// index + dx to apply, or an error reason (reject -> warn -> keep auto).
export function computeIslandAlignOffset(
  design: Pick<SiteDesign, 'blockRows' | 'rowEditGeom' | 'fence' | 'boundary' | 'aisles' | 'reservedZones' | 'islands'>,
  islandN: number,
  mode: RowAlignMode
): { rowIndex: number; dx: number } | { error: string } {
  const isl = design.islands?.find(i => i.n === islandN);
  if (!isl) return { error: `island ${islandN} does not exist in this layout` };
  const blockNs = new Set(isl.inverterIds
    .map(id => Number((id.match(/^inv-(\d+)/) ?? [])[1]))
    .filter(n => Number.isInteger(n)));
  const row = design.blockRows.find(r => r.blocks.some(b => blockNs.has(b.n)));
  if (!row) return { error: `island ${islandN} has no block row to move` };
  // rowMoves translate the WHOLE row; if another island shares this row a
  // row-level shift would drag it along, so refuse rather than surprise.
  if (!row.blocks.every(b => blockNs.has(b.n))) {
    return { error: `island ${islandN} shares its row with another island — use whole-yard row alignment instead` };
  }
  // The island's OWN reserved zones (its augmentation units, island-aug-N-K)
  // relocate with the island when its row moves — the engine re-places them
  // at the shifted strip ends. Treating them as fixed obstacles would cap the
  // shift at the island's own end-zone gap, so exclude them from the scan.
  const scoped = {
    ...design,
    reservedZones: design.reservedZones.filter(z =>
      !new RegExp(`^island-aug-${islandN}-\\d+$`).test(z.id)),
  };
  const offsets = computeRowAlignOffsets(scoped, mode, row.index);
  return { rowIndex: row.index, dx: offsets[row.index]?.dx ?? 0 };
}

// Mirror (symmetry) alignment: shift ONE island horizontally so it lines up
// with its nearest stacked neighbor island on another row — same X center,
// producing the symmetric stacked-island arrangement the guidance drawings
// show. The shift rides the same rowMoves mechanism and clearance validation
// as left/center/right island alignment; a blocked shift returns an error
// (reject -> warn -> keep current position) instead of a partial move.
export function computeIslandMirrorOffset(
  design: Pick<SiteDesign, 'blockRows' | 'rowEditGeom' | 'fence' | 'boundary' | 'aisles' | 'reservedZones' | 'islands'>,
  islandN: number
): { rowIndex: number; dx: number; neighborN: number } | { error: string } {
  const islands = design.islands ?? [];
  const isl = islands.find(i => i.n === islandN);
  if (!isl) return { error: `island ${islandN} does not exist in this layout` };
  const blockNs = new Set(isl.inverterIds
    .map(id => Number((id.match(/^inv-(\d+)/) ?? [])[1]))
    .filter(n => Number.isInteger(n)));
  const row = design.blockRows.find(r => r.blocks.some(b => blockNs.has(b.n)));
  if (!row) return { error: `island ${islandN} has no block row to move` };
  if (!row.blocks.every(b => blockNs.has(b.n))) {
    return { error: `island ${islandN} shares its row with another island — use whole-yard row alignment instead` };
  }
  // Nearest island on a DIFFERENT row (stacked neighbor). Ties break to the
  // lower island number for determinism.
  const neighbors = islands
    .filter(i => i.n !== islandN && Math.abs(i.y - isl.y) > 1)
    .sort((a, b) => Math.abs(a.y - isl.y) - Math.abs(b.y - isl.y) || a.n - b.n);
  const nb = neighbors[0];
  if (!nb) return { error: `island ${islandN} has no stacked neighbor island to mirror against` };
  // Center-on-center: for equal-width islands this makes the X extents
  // identical; for a partial tail island it centers it on the full one.
  const raw = (nb.minX + nb.maxX) / 2 - (isl.minX + isl.maxX) / 2;
  const dx = Math.round(raw / 0.5) * 0.5;
  if (Math.abs(dx) < 0.5) return { rowIndex: row.index, dx: 0, neighborN: nb.n };
  const geom = design.rowEditGeom;
  if (!geom) return { error: 'layout has no editable row geometry' };
  // The island's own aug units relocate with it (same rule as align).
  const reserved = design.reservedZones.filter(z =>
    !new RegExp(`^island-aug-${islandN}-\\d+$`).test(z.id));
  const others = design.blockRows
    .filter(r => r.index !== row.index)
    .flatMap(r => r.blocks);
  const reason = validateRowShift(row.blocks, others, geom, design.fence,
    design.boundary.polygon, dx, 0, design.aisles, reserved);
  if (reason) {
    return { error: `mirroring island ${islandN} onto island ${nb.n} is blocked — ${reason}` };
  }
  return { rowIndex: row.index, dx, neighborN: nb.n };
}

// ---- wrap/compact toward a fence edge --------------------------------------
// Vertical compact: pull auto block rows toward the north or south fence
// edge as far as clearances allow (gravity pack — the row nearest the target
// edge moves first to its own limit, each following row packs against it at
// no less than the drive-aisle pitch). Returns declarative dy offsets keyed
// by stable auto row index, applied through the road-regenerating rowShifts
// constraint. With `islandN` set, only that island's row moves (shared-row
// islands are refused, same rule as align) and every other row is a fixed
// obstacle. Placed islands are not part of the auto row machinery — compact
// them via computePlacedIslandCompactDelta instead.
export type CompactDir = 'N' | 'S';
export function computeCompactShifts(
  design: Pick<SiteDesign, 'blockRows' | 'rowEditGeom' | 'fence' | 'boundary' | 'reservedZones' | 'islands'>,
  dir: CompactDir,
  islandN?: number | null
): Record<number, number> | { error: string } {
  const geom = design.rowEditGeom;
  if (!geom || !design.blockRows.length) return { error: 'layout has no editable row geometry' };
  const sign: 1 | -1 = dir === 'N' ? 1 : -1;
  const fence = design.fence;
  const boundaryPolygon = design.boundary.polygon;
  const ys = fence.map(p => p.y);
  const span = Math.max(...ys) - Math.min(...ys);
  if (!Number.isFinite(span) || span <= 0) return { error: 'invalid fence geometry' };

  // Which rows move, and which island-aug reserved zones ride along (an
  // island's own aug units re-place at its shifted strip ends — treating
  // them as fixed obstacles would freeze the row in place).
  let rowsToMove: SiteDesign['blockRows'];
  let movingIslandNs: number[];
  if (islandN != null) {
    const isl = design.islands?.find(i => i.n === islandN);
    if (!isl) return { error: `island ${islandN} does not exist in this layout` };
    if (isl.placed) return { error: `island ${islandN} is a drag-placed island — compact moves it through its placement anchor` };
    const blockNs = new Set(isl.inverterIds
      .map(id => Number((id.match(/^inv-(\d+)/) ?? [])[1]))
      .filter(n => Number.isInteger(n)));
    const row = design.blockRows.find(r => r.blocks.some(b => blockNs.has(b.n)));
    if (!row) return { error: `island ${islandN} has no block row to move` };
    if (!row.blocks.every(b => blockNs.has(b.n))) {
      return { error: `island ${islandN} shares its row with another island — use whole-yard compact instead` };
    }
    rowsToMove = [row];
    movingIslandNs = [islandN];
  } else {
    rowsToMove = design.blockRows.filter(r => r.blocks.length > 0);
    movingIslandNs = (design.islands ?? []).filter(i => !i.placed).map(i => i.n);
  }
  const augRe = movingIslandNs.length
    ? new RegExp(`^island-aug-(?:${movingIslandNs.join('|')})-\\d+$`)
    : null;
  const reserved = design.reservedZones.filter(z => !(augRe && augRe.test(z.id)));

  // Gravity order: the row nearest the target edge first.
  const order = [...rowsToMove].sort((a, b) => (sign > 0 ? b.y - a.y : a.y - b.y));
  const out: Record<number, number> = {};
  // Planned y per row (already-compacted rows at their new positions).
  const newYOf = new Map<number, number>(design.blockRows.map(r => [r.index, r.y]));

  for (const row of order) {
    const rowBlocks = row.blocks;
    if (!rowBlocks.length) continue;
    const others = design.blockRows
      .filter(r => r.index !== row.index)
      .flatMap(r => {
        const d = (newYOf.get(r.index) ?? r.y) - r.y;
        return r.blocks.map(b => ({ n: b.n, x: b.x, y: b.y + d }));
      });
    // No frozen aisles: the road network regenerates around the shifted rows.
    const valid = (t: number) =>
      validateRowShift(rowBlocks, others, geom, fence, boundaryPolygon, 0, sign * t, [], reserved) === null;
    // Cap the travel so every x-overlapping row between this one and the
    // target edge keeps at least min(drive-aisle pitch, current gap) — the
    // same road-pitch invariant the engine enforces on apply.
    const rxs = rowBlocks.map(b => b.x);
    const aLo = Math.min(...rxs) - geom.halfW;
    const aHi = Math.max(...rxs) + geom.halfW;
    let cap = span;
    for (const other of design.blockRows) {
      if (other.index === row.index || !other.blocks.length) continue;
      const oxs = other.blocks.map(b => b.x);
      if (Math.max(...oxs) + geom.halfW <= aLo || Math.min(...oxs) - geom.halfW >= aHi) continue;
      const oy = newYOf.get(other.index) ?? other.y;
      if (sign * (oy - row.y) <= 0) continue; // not between the row and the edge
      const curGap = Math.abs(other.y - row.y) - geom.halfD * 2;
      const plannedGap = Math.abs(oy - row.y) - geom.halfD * 2;
      const minGap = Math.min(ROW_AISLE_GAP_FT, curGap);
      cap = Math.min(cap, Math.max(0, plannedGap - minGap));
    }
    cap = Math.floor(cap / 0.5) * 0.5;
    if (cap < 0.5) continue;
    // Largest valid travel: bisection (fast path) snapped down to the 0.5 ft
    // grid, then a coarse guard scan merged with obstacle-edge seeds for
    // non-monotone validity, with fine 0.5 ft refinement at both the coarse
    // hit and the bisection result (same scheme as computeRowAlignOffsets).
    const edgeCandidates: number[] = [];
    for (const b of rowBlocks) {
      for (const o of others) {
        if (Math.abs(b.x - o.x) < geom.halfW * 2 + MIN_BLOCK_SEP) {
          const w = geom.halfD * 2 + MIN_BLOCK_SEP;
          edgeCandidates.push(o.y - b.y - w, o.y - b.y + w);
        }
      }
      for (const z of reserved) {
        if (Math.abs(b.x - z.x) < geom.halfW + z.length / 2 + MIN_EQUIP_SEP) {
          const w = geom.halfD + z.width / 2 + MIN_EQUIP_SEP;
          edgeCandidates.push(z.y - b.y - w, z.y - b.y + w);
        }
      }
      for (const v of fence) {
        const w = geom.halfD + geom.equipmentMargin;
        edgeCandidates.push(v.y - b.y - w, v.y - b.y + w);
      }
      if (geom.nfpa) {
        for (const v of boundaryPolygon) {
          const w = geom.nfpa.halfD + geom.nfpa.margin;
          const cy = b.y + geom.nfpa.offY;
          edgeCandidates.push(v.y - cy - w, v.y - cy + w);
        }
      }
    }
    let s = 0;
    if (valid(0.5)) {
      let lo = 0.5, hi = cap;
      if (valid(hi)) lo = hi;
      else for (let i = 0; i < 24 && hi - lo > 0.05; i++) {
        const mid = (lo + hi) / 2;
        if (valid(mid)) lo = mid; else hi = mid;
      }
      s = Math.floor(lo / 0.5) * 0.5;
      while (s > 0 && !valid(s)) s -= 0.5;
    }
    const samples = new Set<number>();
    for (let cand = cap; cand > s + 0.25; cand -= ROW_ALIGN_GUARD_STRIDE_FT) samples.add(cand);
    for (const c of edgeCandidates) {
      const t = Math.floor((sign * c) / 0.5) * 0.5;
      for (const v of [t, t - 0.5]) {
        if (v > s + 0.25 && v <= cap) samples.add(v);
      }
    }
    let best = s;
    const ordered = Array.from(samples).sort((a, b) => b - a);
    let coarseHit = false;
    for (const cand of ordered) {
      if (!valid(cand)) continue;
      const top = Math.min(cap, cand + ROW_ALIGN_GUARD_STRIDE_FT - 0.5);
      best = cand;
      for (let f = top; f > cand + 0.25; f -= 0.5) {
        if (valid(f)) { best = f; break; }
      }
      coarseHit = true;
      break;
    }
    if (!coarseHit) {
      const top = Math.min(cap, s + ROW_ALIGN_GUARD_STRIDE_FT);
      for (let f = top; f > s + 0.25; f -= 0.5) {
        if (valid(f)) { best = f; break; }
      }
    }
    if (best >= 0.5) {
      out[row.index] = sign * best;
      newYOf.set(row.index, row.y + sign * best);
    }
  }
  return out;
}

// Placed-island compact: scan how far a drag-placed island can travel toward
// a fence edge and return the (dx, dy) delta for its placement anchor. The
// shifting set is the island's own equipment and reserved zones (everything
// whose center sits inside the island's inflated AABB); validity = every
// shifted rect inside the fence with the equipment margin, BESS rects inside
// the NFPA setback, and standard separation from all non-island equipment
// and reserved areas. The caller applies the delta through the normal
// placed-island move pipeline, which re-validates the landing spot exactly
// like a fresh drop (roads included) — this scan only picks the candidate.
export function computePlacedIslandCompactDelta(
  design: Pick<SiteDesign, 'equipment' | 'reservedZones' | 'fence' | 'boundary' | 'rowEditGeom' | 'islands'>,
  islandN: number,
  dir: 'N' | 'S' | 'E' | 'W'
): { dx: number; dy: number } | { error: string } {
  const isl = design.islands?.find(i => i.n === islandN);
  if (!isl) return { error: `island ${islandN} does not exist in this layout` };
  if (!isl.placed) return { error: `island ${islandN} is not a drag-placed island` };
  const geom = design.rowEditGeom;
  if (!geom) return { error: 'layout has no editable row geometry' };
  const blockNs = new Set(isl.inverterIds
    .map(id => Number((id.match(/^inv-(\d+)/) ?? [])[1]))
    .filter(n => Number.isInteger(n)));
  const coreRects = design.equipment.filter(e => {
    const m = e.id.match(/^(?:bess|inv)-(\d+)/);
    return m !== null && blockNs.has(Number(m[1]));
  });
  if (!coreRects.length) return { error: `island ${islandN} has no equipment to move` };
  const rectOf = (e: { x: number; y: number; length: number; width: number; rotation: number }) => {
    const rot = Math.abs(Math.sin(e.rotation)) > 0.5;
    return { x: e.x, y: e.y, hx: (rot ? e.width : e.length) / 2, hy: (rot ? e.length : e.width) / 2 };
  };
  // Island AABB from its block rects, inflated to catch the strip-end gear
  // (FJB, comms, aux cluster) and the aug reserve at the island ends.
  const rects0 = coreRects.map(rectOf);
  const bb = {
    minX: Math.min(...rects0.map(r => r.x - r.hx)),
    maxX: Math.max(...rects0.map(r => r.x + r.hx)),
    minY: Math.min(...rects0.map(r => r.y - r.hy)),
    maxY: Math.max(...rects0.map(r => r.y + r.hy)),
  };
  const alongX = !isl.vertical; // strip axis: gear/aug sit at the strip ends
  const padAlong = 150, padAcross = 25;
  const inflated = {
    minX: bb.minX - (alongX ? padAlong : padAcross),
    maxX: bb.maxX + (alongX ? padAlong : padAcross),
    minY: bb.minY - (alongX ? padAcross : padAlong),
    maxY: bb.maxY + (alongX ? padAcross : padAlong),
  };
  const inside = (x: number, y: number) =>
    x >= inflated.minX && x <= inflated.maxX && y >= inflated.minY && y <= inflated.maxY;
  const movingEquip = design.equipment.filter(e => inside(e.x, e.y));
  const movingIds = new Set(movingEquip.map(e => e.id));
  const movingZones = design.reservedZones.filter(z =>
    new RegExp(`^island-aug-${islandN}-\\d+$`).test(z.id) || inside(z.x, z.y));
  const movingZoneIds = new Set(movingZones.map(z => z.id));
  const staticEquip = design.equipment.filter(e => !movingIds.has(e.id)).map(rectOf);
  const staticZones = design.reservedZones
    .filter(z => !movingZoneIds.has(z.id))
    .map(z => ({ x: z.x, y: z.y, hx: z.length / 2, hy: z.width / 2 }));
  const vx = dir === 'E' ? 1 : dir === 'W' ? -1 : 0;
  const vy = dir === 'N' ? 1 : dir === 'S' ? -1 : 0;
  const fence = design.fence;
  const boundaryPolygon = design.boundary.polygon;
  const nfpaMargin = geom.nfpa?.margin ?? null;
  const valid = (t: number): boolean => {
    for (const e of movingEquip) {
      const r = rectOf(e);
      const x = r.x + vx * t, y = r.y + vy * t;
      if (!rectInsidePolygon(x, y, r.hx, r.hy, fence, geom.equipmentMargin)) return false;
      if (nfpaMargin !== null && e.kind === 'bess' &&
          !rectInsidePolygon(x, y, r.hx, r.hy, boundaryPolygon, nfpaMargin)) return false;
      for (const o of staticEquip) {
        if (Math.abs(x - o.x) < r.hx + o.hx + MIN_EQUIP_SEP &&
            Math.abs(y - o.y) < r.hy + o.hy + MIN_EQUIP_SEP) return false;
      }
      for (const o of staticZones) {
        if (Math.abs(x - o.x) < r.hx + o.hx + MIN_EQUIP_SEP &&
            Math.abs(y - o.y) < r.hy + o.hy + MIN_EQUIP_SEP) return false;
      }
    }
    for (const z of movingZones) {
      const x = z.x + vx * t, y = z.y + vy * t;
      const hx = z.length / 2, hy = z.width / 2;
      if (!rectInsidePolygon(x, y, hx, hy, fence, geom.equipmentMargin)) return false;
      // Aug-reserve ghosts hold future BESS containers: the engine NFPA-checks
      // them like real equipment, so the scan must too (conservatively with
      // the full zone rect — a slightly shorter travel beats a rejected drop).
      if (nfpaMargin !== null &&
          !rectInsidePolygon(x, y, hx, hy, boundaryPolygon, nfpaMargin)) return false;
      for (const o of staticEquip) {
        if (Math.abs(x - o.x) < hx + o.hx + MIN_EQUIP_SEP &&
            Math.abs(y - o.y) < hy + o.hy + MIN_EQUIP_SEP) return false;
      }
    }
    return true;
  };
  const pts = fence.map(p => (vx !== 0 ? p.x : p.y));
  const span = Math.max(...pts) - Math.min(...pts);
  if (!Number.isFinite(span) || span <= 0) return { error: 'invalid fence geometry' };
  let s = 0;
  if (valid(0.5)) {
    let lo = 0.5, hi = span;
    if (valid(hi)) lo = hi;
    else for (let i = 0; i < 24 && hi - lo > 0.05; i++) {
      const mid = (lo + hi) / 2;
      if (valid(mid)) lo = mid; else hi = mid;
    }
    s = Math.floor(lo / 0.5) * 0.5;
    while (s > 0 && !valid(s)) s -= 0.5;
  }
  // Guard scan for non-monotone validity (pockets beyond a blocking obstacle).
  const gridMax = Math.floor(span / 0.5) * 0.5;
  const samples: number[] = [];
  for (let cand = gridMax; cand > s + 0.25; cand -= ROW_ALIGN_GUARD_STRIDE_FT) samples.push(cand);
  for (const cand of samples) {
    if (!valid(cand)) continue;
    let best = cand;
    const top = Math.min(gridMax, cand + ROW_ALIGN_GUARD_STRIDE_FT - 0.5);
    for (let f = top; f > cand + 0.25; f -= 0.5) {
      if (valid(f)) { best = f; break; }
    }
    s = Math.max(s, best);
    break;
  }
  if (s < 0.5) return { dx: 0, dy: 0 };
  return { dx: vx * s, dy: vy * s };
}

// Auto island stacking: the reference drawings always show stacked islands
// mirrored onto each other — same X center, identical extents — never
// scattered to opposite ends of the parcel. After auto placement (and the
// aug rescue), every single-island row is aligned onto the WIDEST island
// (ties break to the lowest island number) via the same rowMoves mechanism
// and clearance validation drafter edits use. Rows whose shift is blocked
// keep their auto position (reject -> keep auto, no warning: this is an
// auto pass, not a drafter edit). Layouts whose islands are already aligned
// produce no moves and stay byte-identical.
export function computeIslandStackMoves(
  design: Pick<SiteDesign, 'blockRows' | 'rowEditGeom' | 'fence' | 'boundary' | 'aisles' | 'reservedZones' | 'islands'>
): Record<number, { dx: number; islandN: number }> {
  const islands = design.islands ?? [];
  if (islands.length < 2) return {};
  const geom = design.rowEditGeom;
  if (!geom) return {};
  // Movable islands: single-island rows only (shared-row islands are already
  // east/west neighbors; a row shift would drag both). Placed islands never
  // move but still serve as alignment targets.
  type Cand = { isl: IslandInfo; row: SiteDesign['blockRows'][number] };
  const movable: Cand[] = [];
  for (const isl of islands) {
    if (isl.placed || isl.vertical) continue;
    const blockNs = new Set(isl.inverterIds
      .map(id => Number((id.match(/^inv-(\d+)/) ?? [])[1]))
      .filter(n => Number.isInteger(n)));
    const row = design.blockRows.find(r => r.blocks.some(b => blockNs.has(b.n)));
    if (!row || !row.blocks.every(b => blockNs.has(b.n))) continue;
    movable.push({ isl, row });
  }
  if (!movable.length) return {};
  // World-X center of an island. Vertical islands use the axis-swapped
  // convention (`y` holds the corridor world-X, minX/maxX are Y extents), so
  // their X center is `y` — never (minX+maxX)/2, which would be a Y value.
  const center = (i: IslandInfo) => (i.vertical ? i.y : (i.minX + i.maxX) / 2);
  const shiftFor = (c: Cand, target: number): { dx: number; ok: boolean } => {
    const dx = Math.round((target - center(c.isl)) / 0.5) * 0.5;
    if (Math.abs(dx) < 0.5) return { dx: 0, ok: true };
    // Same validation as drafter island mirroring: the island's own aug
    // zones ride along, every other row is an obstacle.
    const reserved = design.reservedZones.filter(z =>
      !new RegExp(`^island-aug-${c.isl.n}-\\d+$`).test(z.id));
    const others = design.blockRows
      .filter(r => r.index !== c.row.index)
      .flatMap(r => r.blocks);
    const reason = validateRowShift(c.row.blocks, others, geom, design.fence,
      design.boundary.polygon, dx, 0, design.aisles, reserved);
    return { dx, ok: !reason };
  };
  // Every island's center is a candidate target: on a corner-scan layout the
  // widest island often sits AT its row's own travel limit, so aligning onto
  // it can be infeasible while aligning onto a mid-yard island works. Pick
  // the target the most islands can validly reach; ties break to the widest
  // island then the lowest island number, for determinism.
  const width = (i: IslandInfo) => i.maxX - i.minX;
  const targets = [...islands].sort((a, b) => width(b) - width(a) || a.n - b.n);
  let best: { score: number; moves: Record<number, { dx: number; islandN: number }> } | null = null;
  for (const t of targets) {
    const moves: Record<number, { dx: number; islandN: number }> = {};
    let score = 0;
    for (const c of movable) {
      const { dx, ok } = shiftFor(c, center(t));
      if (!ok) continue;
      score++;
      if (dx !== 0) moves[c.row.index] = { dx, islandN: c.isl.n };
    }
    if (!best || score > best.score) best = { score, moves };
  }
  return best?.moves ?? {};
}

// Shared single-equipment move validation: used both by the engine when it
// applies equipMoves constraints and by the preview drag ghost so they always
// agree. Validates translating `eq` by (ddx, ddy) from its CURRENT position
// against fence clearance, frozen drive aisles, the NFPA 855 lot-line setback
// (BESS containers only) and collisions with all other equipment, augmentation
// bays and reserved areas. Returns null when valid, else a rejection reason.
export const MIN_EQUIP_SEP = 2; // ft minimum separation between equipment items

export function normalizeQuarterTurns(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return 0;
  return ((Math.trunc(v) % 4) + 4) % 4;
}
export function validateEquipmentShift(
  eq: PlacedEquipment,
  others: PlacedEquipment[],
  augZones: AugmentationZone[],
  reserved: ReservedZone[],
  fence: Pt[],
  boundaryPolygon: Pt[],
  nfpaActive: boolean,
  ddx: number,
  ddy: number,
  frozenAisles: RoadSegment[] = [],
  // Road-aware fence margin: in roads mode pass the layout's equipmentMargin
  // (fence clearance + frozen perimeter-road corridor) so a single item can
  // never be dropped onto the perimeter road. Compact layouts pass the plain
  // fence clearance.
  fenceMargin: number = CLEARANCES.frontToFence
): string | null {
  const rot = Math.abs(Math.sin(eq.rotation)) > 0.5;
  const hx = (rot ? eq.width : eq.length) / 2;
  const hy = (rot ? eq.length : eq.width) / 2;
  const nx = eq.x + ddx, ny = eq.y + ddy;
  if (!rectInsidePolygon(nx, ny, hx, hy, fence, fenceMargin)) {
    return 'it would violate the fence/road clearance';
  }
  const aisleHit = frozenAisles.find(a => {
    const h = aisleHalves(a);
    const cx2 = h.hx < h.hy ? CLEARANCES.equipmentToRoadEdge : 0;
    return Math.abs(nx - a.x) < hx + h.hx + cx2 &&
      Math.abs(ny - a.y) < hy + h.hy + (CLEARANCES.equipmentToRoadEdge - cx2);
  });
  if (aisleHit) {
    return `it would encroach on a frozen drive aisle (roads stay fixed during edits; ${CLEARANCES.equipmentToRoadEdge} ft road-edge clearance required)`;
  }
  if (nfpaActive && eq.kind === 'bess' &&
      !rectInsidePolygon(nx, ny, hx, hy, boundaryPolygon, CLEARANCES.bessToLotLine)) {
    return `the container would breach the ${CLEARANCES.bessToLotLine} ft NFPA 855 lot-line setback`;
  }
  for (const o of others) {
    const orot = Math.abs(Math.sin(o.rotation)) > 0.5;
    const ohx = (orot ? o.width : o.length) / 2;
    const ohy = (orot ? o.length : o.width) / 2;
    if (Math.abs(nx - o.x) < hx + ohx + MIN_EQUIP_SEP &&
        Math.abs(ny - o.y) < hy + ohy + MIN_EQUIP_SEP) {
      return `it would collide with ${o.label || o.id}`;
    }
  }
  for (const z of augZones) {
    if (Math.abs(nx - z.x) < hx + z.length / 2 + 1 &&
        Math.abs(ny - z.y) < hy + z.width / 2 + 1) {
      return 'it would overlap an augmentation bay';
    }
  }
  for (const z of reserved) {
    if (Math.abs(nx - z.x) < hx + z.length / 2 + MIN_EQUIP_SEP &&
        Math.abs(ny - z.y) < hy + z.width / 2 + MIN_EQUIP_SEP) {
      return 'it would overlap a reserved area';
    }
  }
  return null;
}

// Shared laydown placement check, used both by the engine's reserved-zone
// zoneFits and by the preview's live green/red drag ghost so they always
// agree: fence/road clearance, 5 ft pad vs equipment / aug bays / other
// reserved zones, and drive-aisle strips. Returns null when the rectangle
// fits, otherwise a human-readable reason.
export function laydownFitReason(
  cx: number,
  cy: number,
  hx: number,
  hy: number,
  fence: Pt[],
  equipmentMargin: number,
  equipment: PlacedEquipment[],
  augmentationZones: AugmentationZone[],
  otherReserved: ReservedZone[],
  aisles: RoadSegment[]
): string | null {
  if (!rectInsidePolygon(cx, cy, hx, hy, fence, equipmentMargin)) {
    return 'it would violate the fence/road clearance';
  }
  const pad = 5;
  for (const e of equipment) {
    const rot = Math.abs(Math.sin(e.rotation)) > 0.5;
    const ehx = (rot ? e.width : e.length) / 2;
    const ehy = (rot ? e.length : e.width) / 2;
    if (Math.abs(cx - e.x) < hx + ehx + pad && Math.abs(cy - e.y) < hy + ehy + pad) {
      return 'it would encroach on placed equipment';
    }
  }
  for (const z of augmentationZones) {
    if (Math.abs(cx - z.x) < hx + z.length / 2 + pad && Math.abs(cy - z.y) < hy + z.width / 2 + pad) {
      return 'it would overlap an augmentation bay';
    }
  }
  for (const z of otherReserved) {
    if (Math.abs(cx - z.x) < hx + z.length / 2 + pad && Math.abs(cy - z.y) < hy + z.width / 2 + pad) {
      return 'it would overlap another reserved area';
    }
  }
  for (const aisle of aisles) {
    const h = aisleHalves(aisle);
    if (Math.abs(cx - aisle.x) < hx + h.hx + (h.hx < h.hy ? 3 : 0) &&
        Math.abs(cy - aisle.y) < hy + h.hy + (h.hx < h.hy ? 0 : 3)) {
      return 'it would block a drive aisle';
    }
  }
  return null;
}

// Shared future-BESS-block placement check: same clearance rules as laydown
// PLUS the NFPA 855 container setback (the future block's container portion
// must stay >= 100 ft from the lot line, same as real blocks). Used both by
// the engine's aug placement and the preview drag ghost so they always agree.
export function futureAugFitReason(
  cx: number,
  cy: number,
  geom: RowEditGeom,
  fence: Pt[],
  boundaryPolygon: Pt[],
  equipment: PlacedEquipment[],
  augmentationZones: AugmentationZone[],
  otherReserved: ReservedZone[],
  aisles: RoadSegment[]
): string | null {
  // Aug UNIT footprint dims when present (2 PCS + 6 BESS mirrored pair);
  // designs saved before aug units existed fall back to the block footprint.
  const a = geom.aug ?? { halfW: geom.halfW, halfD: geom.halfD, nfpa: geom.nfpa };
  const base = laydownFitReason(
    cx, cy, a.halfW, a.halfD, fence, geom.equipmentMargin,
    equipment, augmentationZones, otherReserved, aisles
  );
  if (base) return base;
  if (a.nfpa && !rectInsidePolygon(
    cx + a.nfpa.offX, cy + a.nfpa.offY,
    a.nfpa.halfW, a.nfpa.halfD,
    boundaryPolygon, a.nfpa.margin
  )) {
    return `its future containers would breach the ${CLEARANCES.bessToLotLine} ft NFPA 855 lot-line setback`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Roads-peer cache: compact mode calls generateSiteDesignCore with
// roadMode:'roads' purely to compare block counts.  The result only changes
// when (boundary, config, targetMW, targetMWh, options-minus-roadMode)
// change, so cache it so repeated compact regenerations with identical inputs
// skip the second full build entirely.  The cache is module-level (lives for
// the process lifetime) and capped at COMPACT_ROADS_PEER_CACHE_SIZE entries;
// the oldest entry is evicted when the cap is reached.
const _COMPACT_ROADS_PEER_CACHE_SIZE = 8;
const _compactRoadsPeerCache = new Map<string, number>(); // key → blocksPlaced

function _compactRoadsPeerKey(
  boundary: SiteBoundary,
  config: BessConfiguration,
  targetMW: number,
  targetMWh: number,
  selectedOptions: LayoutOptions
): string {
  // roadMode is always overridden to 'roads' in the peer call, so strip it
  // from the key to avoid key misses when the caller passes 'compact'.
  const { roadMode: _rm, ...restOpts } = selectedOptions;
  return JSON.stringify({ polygon: boundary.polygon, config, targetMW, targetMWh, opts: restOpts });
}

function roadShortfallReason(design: SiteDesign): string {
  const rows = design.blockRows ?? [];
  if (!rows.length) {
    return 'No block row fits between the perimeter road and the fence line on this footprint.';
  }
  const counts = rows.map(r => r.blockCount);
  const widest = Math.max(...counts);
  const allFull = counts.every(c => c === widest);
  if (allFull) {
    return `All ${rows.length} usable block row${rows.length === 1 ? '' : 's'} are full at ` +
      `${widest} blocks each: the footprint has no depth for another row at the ` +
      `${Math.round(ROW_AISLE_GAP_FT)} ft drive-aisle pitch, and no row has width for ` +
      'another island plus its strip-end gear gap.';
  }
  return `The deepest row holds ${widest} blocks and the remaining rows are ` +
    'fence-limited: the parcel narrows before another full island fits.';
}
export function generateSiteDesign(
  boundary: SiteBoundary,
  config: BessConfiguration,
  targetMW: number,
  targetMWh: number,
  options: LayoutOptions = { hotClimate: true }
): SiteDesign {
  // The island-augmentation rescue (below) may shift a row so an island's
  // aug units fit at its end. That shift becomes part of the AUTO baseline:
  // drafter rowMoves are composed ON TOP of it, so a move computed from the
  // displayed (rescued) layout lands exactly where the drafter aimed.
  const userRowMoves = options.constraints?.rowMoves ?? {};
  const hasUserRowMoves = Object.values(userRowMoves).some(m => m && (m.dx || m.dy));
  // Drafter blockMoves are likewise stripped from the synthetic-baseline
  // computation (rescue + island-stack probes): a block move can flip a
  // stack-alignment vetting decision, silently shifting the AUTO baseline the
  // move composes on top of — a dx=5 nudge then lands 2.5 ft off. The moves
  // are re-applied in the FINAL core build so the finished design carries
  // them on the same baseline the drafter saw.
  const userBlockMoves = options.constraints?.blockMoves ?? {};
  const hasUserBlockMoves = Object.values(userBlockMoves).some(m => m && (m.dx || m.dy));
  const strippedOptions = hasUserRowMoves || hasUserBlockMoves
    ? {
        ...options,
        constraints: {
          ...options.constraints,
          rowMoves: undefined,
          blockMoves: undefined,
        },
      }
    : options;
  let selectedOptions = strippedOptions;
  let base = generateSiteDesignCore(boundary, config, targetMW, targetMWh, selectedOptions);

  // A phase-footprint project must not trade the access-road network for
  // capacity in automatic mode. Before accepting a road-aware shortfall,
  // exhaust the legitimate deterministic pack directions already offered to
  // drafters. Do not override an explicit arrangement/lattice choice or a
  // row edit: those are deliberate engineering inputs, not auto-placement.
  //
  // Keep the first candidate on ties so the historical SW baseline remains
  // byte-identical whenever it is equally capable.
  const canSearchRoadLayouts =
    options.multiArea === true &&
    (options.roadMode ?? 'auto') === 'auto' &&
    !hasUserRowMoves &&
    !options.arrangement &&
    !options.latticeShift;
  if (canSearchRoadLayouts && base.blocksPlaced < base.blocksRequired) {
    for (const alternative of ARRANGEMENTS) {
      if (alternative.id === 'sw') continue;
      const candidateOptions = { ...strippedOptions, arrangement: alternative.id };
      const candidate = generateSiteDesignCore(boundary, config, targetMW, targetMWh, candidateOptions);
      if (candidate.blocksPlaced > base.blocksPlaced) {
        base = candidate;
        selectedOptions = candidateOptions;
      }
    }
  }

  // Deliberate road-aware packing search. The pack-direction sweep above only
  // moves the lattice ORIGIN CORNER; it cannot centre a row inside a
  // road-bounded bay, and it never reclaims the dead strip between the fence
  // and the outside perimeter-road edge. Both are exactly what an engineer
  // does by hand, and on real phase footprints they are the difference
  // between a two-row underfill and the full target.
  //
  // The search is deterministic and strictly additive: candidates are only
  // accepted when they place MORE blocks than the incumbent, ties keep the
  // earlier (historically byte-identical) candidate, and the whole sweep is
  // skipped unless the baseline is genuinely short of target in automatic
  // multi-area mode with no explicit arrangement/lattice/row input.
  if (canSearchRoadLayouts && base.blocksPlaced < base.blocksRequired) {
    const steps = latticeSearchSteps(boundary, config, options);
    // Perimeter band first (it enlarges the usable yard for every shift), then
    // the lattice offsets within each band. Fractions are exact rationals of
    // the lattice step so the sweep is reproducible across platforms.
    const FRACTIONS = [0, 1 / 16, 1 / 8, 3 / 16, 1 / 4, 5 / 16, 3 / 8, 7 / 16,
      1 / 2, 9 / 16, 5 / 8, 11 / 16, 3 / 4, 13 / 16, 7 / 8, 15 / 16];
    for (const band of ['flush', 'standard'] as const) {
      // 'standard' with zero shift IS the incumbent — never rebuild it.
      for (const fy of FRACTIONS) {
        for (const fx of [0, 1 / 4, 1 / 2, 3 / 4]) {
          if (band === 'standard' && fx === 0 && fy === 0) continue;
          if (base.blocksPlaced >= base.blocksRequired) break;
          const candidateOptions: LayoutOptions = {
            ...strippedOptions,
            ...(band === 'flush' ? { perimeterBand: 'flush' as const } : {}),
            latticeShift: { x: steps.x * fx, y: steps.y * fy },
          };
          const candidate = generateSiteDesignCore(
            boundary, config, targetMW, targetMWh, candidateOptions);
          if (candidate.blocksPlaced > base.blocksPlaced) {
            base = candidate;
            selectedOptions = candidateOptions;
          }
        }
        if (base.blocksPlaced >= base.blocksRequired) break;
      }
      if (base.blocksPlaced >= base.blocksRequired) break;
    }
  }

  const withRoadShortfallNotice = (design: SiteDesign): SiteDesign => {
    const targetMissed = design.achievedMW < targetMW - 1e-6 || design.achievedMWh < targetMWh - 1e-6;
    if (
      options.multiArea === true &&
      (options.roadMode ?? 'auto') === 'auto' &&
      design.roadNetwork &&
      targetMissed &&
      !design.warnings.some(w => w.startsWith('Access-road capacity shortfall:'))
    ) {
      const shortMW = Math.max(0, targetMW - design.achievedMW);
      const shortMWh = Math.max(0, targetMWh - design.achievedMWh);
      const shortBlocks = Math.max(0, design.blocksRequired - design.blocksPlaced);
      design.warnings.unshift(
        `Access-road capacity shortfall: retained the connected access-road network, ` +
        `but this footprint can deliver ${design.blocksPlaced} of ${design.blocksRequired} blocks — ` +
        `${design.achievedMW.toFixed(1)} MW / ${design.achievedMWh.toFixed(1)} MWh ` +
        `(short ${shortBlocks} block${shortBlocks === 1 ? '' : 's'} = ${shortMW.toFixed(1)} MW / ` +
        `${shortMWh.toFixed(1)} MWh below the ${targetMW.toFixed(1)} MW / ` +
        `${targetMWh.toFixed(1)} MWh target). ${roadShortfallReason(design)} ` +
        `Enlarge the BESS footprint, reduce this area's target, or explicitly ` +
        'select Compact after resolving fire/O&M access in detailed design.'
      );
    }
    return design;
  };

  // Compact-mode transparency: state which spacing rules compact relaxed (and
  // by how much), and — when compact bought no extra blocks over the same
  // parcel with roads — say so plainly so the drafter can pick the road
  // layout instead. Explicit compact only: automatic mode already explains
  // its own road/compact tradeoff, and untouched modes stay byte-identical.
  const withCompactNotices = (design: SiteDesign): SiteDesign => {
    if ((options.roadMode ?? 'auto') !== 'compact') return design;
    const ft = (v: number) =>
      Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
    const roadsMargin =
      CLEARANCES.frontToFence + CLEARANCES.roadWidth + CLEARANCES.equipmentToRoadEdge;
    design.warnings.unshift(
      `Compact spacing relaxed vs the road layout: row-to-row gap ${ft(CLEARANCES.frontToFront)} ft ` +
      `instead of ${ft(ROW_AISLE_GAP_FT)} ft (${ft(CLEARANCES.roadWidth)} ft aisle + ` +
      `${ft(CLEARANCES.equipmentToRoadEdge)} ft each side), and equipment-to-fence setback ` +
      `${ft(CLEARANCES.frontToFence)} ft instead of ${ft(roadsMargin)} ft. Equipment clearances, the ` +
      `${ft(CLEARANCES.bessToLotLine)} ft NFPA 855 setback and fence containment are unchanged.`
    );
    // Capacity parity: rebuild the same inputs WITH roads purely to compare
    // block counts. If compact wins nothing, the drafter is paying the access
    // cost for free.  The result is cached so repeated compact regenerations
    // with unchanged inputs skip this second full build.
    const _peerKey = _compactRoadsPeerKey(boundary, config, targetMW, targetMWh, selectedOptions);
    let _peerBlocks = _compactRoadsPeerCache.get(_peerKey);
    if (_peerBlocks === undefined) {
      const roadsPeer = generateSiteDesignCore(boundary, config, targetMW, targetMWh, {
        ...selectedOptions, roadMode: 'roads',
      });
      _peerBlocks = roadsPeer.blocksPlaced;
      if (_compactRoadsPeerCache.size >= _COMPACT_ROADS_PEER_CACHE_SIZE) {
        // Evict the oldest entry (Maps iterate in insertion order).
        _compactRoadsPeerCache.delete(_compactRoadsPeerCache.keys().next().value!);
      }
      _compactRoadsPeerCache.set(_peerKey, _peerBlocks);
    }
    if (design.blocksPlaced <= _peerBlocks) {
      design.warnings.unshift(
        `Compact fits no additional blocks on this parcel: ${design.blocksPlaced} blocks compact vs ` +
        `${_peerBlocks} with the road layout. The road layout delivers the same capacity ` +
        'and keeps fire/O&M vehicle access — set Site Access to "Always include roads" unless compact ' +
        'is needed for another reason.'
      );
    }
    return design;
  };

  const rescue = rescueIslandAugPlacement(boundary, config, targetMW, targetMWh, selectedOptions, base);
  // Auto island stacking: align every single-island row onto the widest
  // island so stacked islands mirror each other instead of scattering to
  // opposite ends of the parcel. The stack shift joins the synthetic
  // baseline exactly like the rescue shift: drafter rowMoves compose on top.
  let stackMoves = computeIslandStackMoves(rescue.design);
  let stackedProbe: SiteDesign | null = null;
  // Notices about alignment opportunities or applied alignments are collected
  // here and appended to whichever design is returned, separate from
  // rescue.notesByRow.
  const stackNotices: string[] = [];
  if (Object.keys(stackMoves).length) {
    // Vet the stack shifts on a probe build: a shift the core rejects, one
    // that costs its island any augmentation zone, or one that introduces a
    // new island-augmentation warning is dropped (silently — this is an auto
    // pass, the row keeps its rescue/auto position). Exception: when the
    // drafter has enabled alignIslands, moves that cost aug zones are accepted
    // and reported with an "Island alignment applied:" warning instead.
    const probeMoves: Record<number, { dx: number; dy: number }> = { ...rescue.synthMoves };
    for (const [k, mv] of Object.entries(stackMoves)) {
      const idx = Number(k);
      const s = probeMoves[idx];
      probeMoves[idx] = s ? { dx: s.dx + mv.dx, dy: s.dy } : { dx: mv.dx, dy: 0 };
    }
    const probe = generateSiteDesignCore(boundary, config, targetMW, targetMWh, {
      ...selectedOptions,
      constraints: { ...selectedOptions.constraints, rowMoves: probeMoves },
    });
    const augCount = (d: SiteDesign, n: number) =>
      d.reservedZones.filter(z => z.id.startsWith(`island-aug-${n}-`)).length;
    const alignIslandsOpt = options.constraints?.alignIslands === true;
    const vetted: typeof stackMoves = {};
    let allOk = true;
    for (const [k, mv] of Object.entries(stackMoves)) {
      const rejected = probe.warnings.some(w => w.startsWith(`Row ${k} move rejected`));
      const augBefore = augCount(rescue.design, mv.islandN);
      const augAfter = augCount(probe, mv.islandN);
      const nZonesLost = augBefore - augAfter; // > 0 means alignment costs aug zones
      const newAugWarn =
        probe.warnings.some(w => w.startsWith('Island augmentation:') && w.includes(`island ${mv.islandN}`)) &&
        !rescue.design.warnings.some(w => w.startsWith('Island augmentation:') && w.includes(`island ${mv.islandN}`));
      if (rejected || newAugWarn) { allOk = false; continue; }
      if (nZonesLost > 0) {
        // Alignment is geometrically possible but costs augmentation zones.
        allOk = false;
        if (alignIslandsOpt) {
          // Drafter opted in — apply the move and warn about the tradeoff.
          vetted[Number(k)] = mv;
          stackNotices.push(
            `Island alignment applied: island ${mv.islandN} shifted to the shared column line; ` +
            `${nZonesLost} augmentation zone${nZonesLost === 1 ? '' : 's'} removed ` +
            `(no room at the tighter row pitch). Verify future expansion in detailed design.`
          );
        } else {
          // Block the move but surface the opportunity so the drafter can decide.
          stackNotices.push(
            `Island alignment available: island ${mv.islandN} could align to the shared column ` +
            `line but would lose ${nZonesLost} augmentation zone${nZonesLost === 1 ? '' : 's'} ` +
            `(no room at the tighter row pitch). Enable "Align islands" in layout options to apply.`
          );
        }
        continue;
      }
      vetted[Number(k)] = mv;
    }
    stackMoves = vetted;
    if (allOk) stackedProbe = probe;
  }
  const synthMoves: Record<number, { dx: number; dy: number }> = { ...rescue.synthMoves };
  for (const [k, mv] of Object.entries(stackMoves)) {
    const idx = Number(k);
    const s = synthMoves[idx];
    synthMoves[idx] = s ? { dx: s.dx + mv.dx, dy: s.dy } : { dx: mv.dx, dy: 0 };
  }
  // Reinstate drafter blockMoves for the FINAL build only: the synthetic
  // baseline above was computed blind to them so it stays stable, and the
  // moves now compose on top of exactly the baseline the drafter saw.
  const finalConstraints = (rowMoves: Record<number, { dx: number; dy: number }>) => ({
    ...selectedOptions.constraints,
    rowMoves,
    ...(hasUserBlockMoves ? { blockMoves: userBlockMoves } : {}),
  });
  if (!hasUserRowMoves) {
    if (!Object.keys(stackMoves).length) {
      if (hasUserBlockMoves) {
        const withBlocks = generateSiteDesignCore(boundary, config, targetMW, targetMWh, {
          ...selectedOptions,
          constraints: finalConstraints(rescue.synthMoves),
        });
        withBlocks.warnings.push(...Object.values(rescue.notesByRow), ...stackNotices);
        return withRoadShortfallNotice(withCompactNotices(withBlocks));
      }
      rescue.design.warnings.push(...Object.values(rescue.notesByRow), ...stackNotices);
      return withRoadShortfallNotice(withCompactNotices(rescue.design));
    }
    const stacked = (!hasUserBlockMoves && stackedProbe) ||
      generateSiteDesignCore(boundary, config, targetMW, targetMWh, {
        ...selectedOptions,
        constraints: finalConstraints(synthMoves),
      });
    stacked.warnings.push(...Object.values(rescue.notesByRow), ...stackNotices);
    return withRoadShortfallNotice(withCompactNotices(stacked));
  }
  const rowMoves: Record<number, { dx: number; dy: number }> = { ...synthMoves };
  for (const [k, mv] of Object.entries(userRowMoves)) {
    const idx = Number(k);
    const s = synthMoves[idx];
    rowMoves[idx] = s ? { dx: s.dx + (mv.dx ?? 0), dy: mv.dy ?? 0 } : { dx: mv.dx ?? 0, dy: mv.dy ?? 0 };
  }
  let final = generateSiteDesignCore(boundary, config, targetMW, targetMWh, {
    ...selectedOptions,
    constraints: finalConstraints(rowMoves),
  });
  // If a COMPOSED move (rescue + user delta) was rejected, the core fell all
  // the way back to the pre-rescue auto position — losing the rescued aug
  // placement. Keep the rescue baseline instead: rebuild with the synth-only
  // move for the rejected row(s) and surface the user delta's rejection.
  const rejectedRows = Object.keys(synthMoves)
    .filter(k => final.warnings.some(w => w.startsWith(`Row ${k} move rejected`)));
  if (rejectedRows.length) {
    const rejWarns = final.warnings.filter(w =>
      rejectedRows.some(k => w.startsWith(`Row ${k} move rejected`)));
    const fallback = { ...rowMoves };
    for (const k of rejectedRows) fallback[Number(k)] = { ...synthMoves[Number(k)] };
    final = generateSiteDesignCore(boundary, config, targetMW, targetMWh, {
      ...selectedOptions,
      constraints: finalConstraints(fallback),
    });
    final.warnings.push(...rejWarns);
  }
  final.warnings.push(...Object.values(rescue.notesByRow), ...stackNotices);
  return withRoadShortfallNotice(withCompactNotices(final));
}

function generateSiteDesignCore(
  boundary: SiteBoundary,
  config: BessConfiguration,
  targetMW: number,
  targetMWh: number,
  options: LayoutOptions = { hotClimate: true }
): SiteDesign {
  const roadMode = options.roadMode ?? 'auto';

  // Saved legacy QTY4 projects remain reproducible, including their
  // PCS-capped credited output. New designs omit this option and retain the
  // configuration's QTY3 four-hour standard.
  config = withContainersPerPcs(config, options.containersPerPcs);

  // Blocks required from target. 100 MW targets at QTY 3 carry one extra
  // PCS+QTY3 block by default (28 blocks = two full 7-pair islands instead
  // of 27 with a dangling half pair) per the drafter's standard. Other
  // targets and QTY 4 layouts are untouched.
  const blocksByMW = Math.ceil(targetMW / config.blockMW);
  const blocksByMWh = Math.ceil(targetMWh / (config.containersPerBlock * config.containerMWh));
  // KMZ-traced yards are authoritative: when the reference drawing already
  // placed the PCS/BESS units, the automatic block scan stands down entirely
  // so the design shows ONLY the customer's equipment (never a mix of traced
  // gear plus auto blocks fighting for the same ground).
  const hasTracedYard = isTracedBessYard(options.constraints);
  const blocksRequired = hasTracedYard ? 0 : Math.max(blocksByMW, blocksByMWh) +
    (isMirroredPairConfig(config) && Math.abs(targetMW - 100) < 1e-6 ? 1 : 0);

  // ACCEPTED island block removals lower the effective placement floor: a
  // drafter-removed block must not read as "site can only fit" capacity
  // shortfall or trigger the NFPA-relaxed / compact fallbacks. Rejected or
  // dormant removals keep the auto layout, apply nothing, and therefore do
  // not lower the floor (buildLayout reports what it actually applied).
  const floorOf = (d: SiteDesign) => Math.max(1,
    blocksRequired - (d.islandBlockRemovalApplied ?? 0) - (d.blockRemovalApplied ?? 0));

  // NFPA 855 (sheet 10 key note 6): BESS containers must be >= 100 ft from the
  // lot line for "remote location" siting. Try the strict setback first; if the
  // parcel cannot fit the target that way, relax it and warn — an alternate
  // NFPA 855 compliance path (fire barriers / AHJ approval) is then required.
  const attempt = (compact: boolean): SiteDesign => {
    const strict = buildLayout(boundary, config, targetMW, targetMWh, blocksRequired, options, compact, true);
    if (strict.blocksPlaced >= floorOf(strict)) return strict;
    const relaxed = buildLayout(boundary, config, targetMW, targetMWh, blocksRequired, options, compact, false);
    if (relaxed.blocksPlaced > strict.blocksPlaced) {
      relaxed.warnings.unshift(
        `NFPA 855 100 ft BESS-to-lot-line setback relaxed: only ${strict.blocksPlaced} of ` +
        `${blocksRequired} blocks fit with all containers >= ${CLEARANCES.bessToLotLine} ft from the lot line. ` +
        'Containers within 100 ft of the lot line require an alternate NFPA 855 compliance path ' +
        '(fire barriers or AHJ approval) — review in detailed design.'
      );
      return relaxed;
    }
    return strict;
  };

  if (roadMode === 'compact') {
    const d = attempt(true);
    d.compact = true;
    d.warnings.unshift(
      'Compact layout: interior access roads omitted to maximize block count. ' +
      'Fire/O&M vehicle access must be addressed in detailed design.'
    );
    return d;
  }

  const withRoads = attempt(false);
  if (
    roadMode === 'roads' ||
    (roadMode === 'auto' && options.multiArea === true) ||
    withRoads.blocksPlaced >= floorOf(withRoads)
  ) {
    return withRoads;
  }

  // Auto mode: the target doesn't fit with interior roads — try a compact
  // layout (no perimeter road / drive aisles, tighter row spacing).
  const compact = attempt(true);
  if (compact.blocksPlaced > withRoads.blocksPlaced) {
    compact.compact = true;
    compact.warnings.unshift(
      `Interior access roads omitted to fit more blocks (${compact.blocksPlaced} vs ` +
      `${withRoads.blocksPlaced} with roads). Fire/O&M vehicle access must be addressed ` +
      'in detailed design. Set Site Access to "Always include roads" to keep roads instead.'
    );
    return compact;
  }
  withRoads.warnings.push(
    'A compact layout (no interior roads) would not fit additional blocks on this parcel.'
  );
  return withRoads;
}

// Island augmentation rescue: when the auto layout cannot fit an island's
// augmentation units together at either strip end, try a deterministic,
// minimal horizontal shift of the island itself (riding the same rowMoves
// mechanism drafter edits use — the engine re-validates the shift and
// re-places the units at the shifted ends). Only layouts that ALREADY carry
// the island-augmentation warning are ever rebuilt, so every layout without
// the warning stays byte-identical. If no shift frees room the warning is
// kept and the drafter is prompted to place the units manually (ghost drag /
// pin) — island augmentation is never relocated away from its island.
const AUG_RESCUE_MAX_BUILDS = 24;

function rescueIslandAugPlacement(
  boundary: SiteBoundary,
  config: BessConfiguration,
  targetMW: number,
  targetMWh: number,
  options: LayoutOptions,
  base: SiteDesign
): { design: SiteDesign; synthMoves: Record<number, { dx: number; dy: number }>; notesByRow: Record<number, string> } {
  const synthMoves: Record<number, { dx: number; dy: number }> = {};
  const notesByRow: Record<number, string> = {};
  const done = (design: SiteDesign) => ({ design, synthMoves, notesByRow });
  const baseWarn = base.warnings.find(w => w.startsWith('Island augmentation:'));
  if (!baseWarn) return done(base);
  const namedIn = (w: string) => {
    const out: number[] = [];
    const re = /island (\d+) unit/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(w)) !== null) out.push(parseInt(m[1], 10));
    return out;
  };
  const blocked = Array.from(new Set(namedIn(baseWarn))).sort((a, b) => a - b);
  if (!blocked.length) return done(base);

  const pcsClearance = options.hotClimate ? CLEARANCES.pcsHotClimate : CLEARANCES.pcsStandard;
  const pairGap = pairBlockGapFt(pcsClearance);
  const augFp = augUnitFootprint(config, pcsClearance);
  const userMoves = options.constraints?.rowMoves ?? {};
  let design = base;
  let builds = 0;

  for (const n of blocked) {
    // Re-read the CURRENT warning — an earlier island's shift may have fixed
    // this island too (or the warning may be gone entirely).
    const curWarn = design.warnings.find(w => w.startsWith('Island augmentation:')) ?? '';
    if (!curWarn.includes(`island ${n} unit`)) continue;
    const isl = design.islands?.find(i => i.n === n);
    if (!isl) continue;
    const blockNs = new Set(isl.inverterIds
      .map(id => Number((id.match(/^inv-(\d+)/) ?? [])[1]))
      .filter(v => Number.isInteger(v)));
    const row = design.blockRows.find(r => r.blocks.some(b => blockNs.has(b.n)));
    if (!row) continue;
    // A row shift drags every island on the row (rowMoves is the only shift
    // mechanism). That is safe: a candidate is only accepted when no block is
    // lost and no OTHER island's augmentation newly breaks. Never override a
    // drafter's own (non-zero) row move though — their edit wins. A stored
    // no-op move must not disable the rescue.
    const um = userMoves[row.index];
    if (um && (um.dx || um.dy)) continue;

    const missing = (curWarn.match(new RegExp(`island ${n} unit `, 'g')) ?? []).length;
    const needFt = Math.ceil(missing * (pairGap + augFp.width));
    // Minimal first: increasing fractions of the group extent up to the full
    // extent plus one extra gap. West shift first — it opens the preferred
    // east end.
    const steps = Array.from(new Set([0.25, 0.5, 0.625, 0.75, 1].map(f => Math.ceil(needFt * f))
      .concat(needFt + pairGap)));
    let fixed = false;
    for (const step of steps) {
      for (const sign of [-1, 1] as const) {
        if (fixed || builds >= AUG_RESCUE_MAX_BUILDS) break;
        builds++;
        const dx = sign * step;
        const rowMoves = { ...userMoves, ...synthMoves, [row.index]: { dx, dy: 0 } };
        const cand = generateSiteDesignCore(boundary, config, targetMW, targetMWh, {
          ...options,
          constraints: { ...options.constraints, rowMoves },
        });
        if (cand.blocksPlaced < design.blocksPlaced) continue;
        if (cand.warnings.some(w => w.startsWith(`Row ${row.index} move rejected`))) continue;
        const candWarn = cand.warnings.find(w => w.startsWith('Island augmentation:')) ?? '';
        if (candWarn.includes(`island ${n} unit`)) continue;
        // The shift must not break another island's augmentation that was
        // fine before the rescue.
        if (namedIn(candWarn).some(m => !blocked.includes(m))) continue;
        synthMoves[row.index] = { dx, dy: 0 };
        notesByRow[row.index] =
          `Island augmentation: island ${n} shifted ${Math.abs(dx)} ft ` +
          `${dx < 0 ? 'west' : 'east'} so its augmentation units fit together at the island end.`;
        design = cand;
        fixed = true;
      }
      if (fixed || builds >= AUG_RESCUE_MAX_BUILDS) break;
    }
  }
  return done(design);
}

// Comparison stats for one arrangement alternative (feet / acres).
export interface ArrangementOption {
  strategy: ArrangementStrategy;
  label: string;
  description: string;
  design: SiteDesign;
  stats: {
    blocksPlaced: number;
    blocksRequired: number;
    fenceAcres: number;
    roadLengthFt: number;
    cableFt: number;
  };
}

// Lay the site out under every named arrangement strategy (pristine — no
// drafter edits) and return each with quick comparison stats so the drafter
// can pick one. Deterministic: same inputs always give the same options.
// Memo cache: arrangement exploration regenerates four full designs; results
// are deterministic per inputs, so repeat opens of the explorer (same
// boundary/config/targets/options) reuse the previous result. Callers treat
// the returned designs as immutable (spread-copy before any mutation).
const arrangementCache = new Map<string, ArrangementOption[]>();
const ARRANGEMENT_CACHE_MAX = 8;

export function arrangementCacheKey(
  boundary: SiteBoundary,
  config: BessConfiguration,
  targetMW: number,
  targetMWh: number,
  options: Omit<LayoutOptions, 'arrangement' | 'constraints' | 'latticeShift' | 'gateEdge'>
): string {
  return JSON.stringify([
    boundary.polygon,
    config.id,
    targetMW,
    targetMWh,
    options.hotClimate,
    options.roadMode ?? 'auto',
    options.multiArea === true,
    options.laydownPct ?? 0,
    options.augmentPct ?? 0,
    options.surfacingMode ?? 'between-roads',
    options.surfacingDepthIn ?? SURFACING_DEPTH_IN_DEFAULT,
    options.dcRouting ?? 'direct',
    options.deadSpaceTrim === true,
    // Fence placement moves the fence itself, so it changes every candidate
    // arrangement's usable envelope: it MUST participate in the cache key or
    // switching modes replays the other mode's cached arrangements.
    options.fencePlacement ?? 'inset',
  ]);
}

export function clearArrangementCache(): void {
  arrangementCache.clear();
}

export function generateArrangements(
  boundary: SiteBoundary,
  config: BessConfiguration,
  targetMW: number,
  targetMWh: number,
  options: Omit<LayoutOptions, 'arrangement' | 'constraints' | 'latticeShift' | 'gateEdge'>
): ArrangementOption[] {
  const key = arrangementCacheKey(boundary, config, targetMW, targetMWh, options);
  const hit = arrangementCache.get(key);
  if (hit) return hit;
  const runLen = (pts: Pt[]) => {
    let s = 0;
    for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    return s;
  };
  const result = ARRANGEMENTS.map(a => {
    const design = generateSiteDesign(boundary, config, targetMW, targetMWh, {
      ...options,
      constraints: undefined,
      arrangement: a.id,
    });
    const roadLengthFt = design.roads.reduce((s, r) => s + r.length, 0);
    const cableFt = design.cables.reduce((s, c) => s + runLen(c.pts), 0);
    return {
      strategy: a.id,
      label: a.label,
      description: a.description,
      design,
      stats: {
        blocksPlaced: design.blocksPlaced,
        blocksRequired: design.blocksRequired,
        fenceAcres: Math.abs(polygonArea(design.fence)) / 43560,
        roadLengthFt,
        cableFt,
      },
    };
  });
  arrangementCache.set(key, result);
  if (arrangementCache.size > ARRANGEMENT_CACHE_MAX) {
    const oldest = arrangementCache.keys().next().value;
    if (oldest !== undefined) arrangementCache.delete(oldest);
  }
  return result;
}

function buildLayout(
  boundary: SiteBoundary,
  config: BessConfiguration,
  targetMW: number,
  targetMWh: number,
  blocksRequired: number,
  options: LayoutOptions,
  compact: boolean,
  nfpaSetback: boolean
): SiteDesign {
  const warnings: string[] = [];
  const pcsClearance = options.hotClimate ? CLEARANCES.pcsHotClimate : CLEARANCES.pcsStandard;
  const hasTracedYard = isTracedBessYard(options.constraints);

  // ACCEPTED drafter island block removals (islandBlockDeltas); rejected or
  // dormant removals never count. Lowers the capacity/fallback floor.
  let islandRemovalApplied = 0;

  // Manual layouts follow the drafter's placement choice. KMZ-traced BESS
  // yards always fence the imported property boundary: this is the customer
  // standard and is intentionally independent of the legacy project-level
  // inset default. The helper also deep-copies the boundary points.
  let fence = fencePolygonForLayout(
    boundary.polygon, options.constraints, options.fencePlacement);

  // Equipment must keep >= frontToFence(10ft) from fence; with roads, also
  // leave room for the 30 ft perimeter road inside the fence plus the 3 ft
  // equipment-to-road-edge clearance (sheet 10 key notes 3 and 5).
  const bandMode: PerimeterBandMode = options.perimeterBand ?? 'standard';
  const bandInset = perimeterBandInset(bandMode);
  const equipmentMargin = equipmentMarginFor(compact, bandMode);

  const mirrored = isMirroredPairConfig(config);
  const fp = blockFootprint(config, pcsClearance);
  const pairGap = pairBlockGapFt(pcsClearance);
  // Mirrored-pair strips: adjacent pairs keep the reference clear gap along
  // the strip (10 ft drawn, 14 ft on hot-climate sites); otherwise standard
  // front-to-front between blocks.
  const gapX = mirrored
    ? pairGap
    : CLEARANCES.frontToFront;     // between blocks side-to-side
  // Between block rows: 24 ft drive aisle + 8'-0 3/4" equipment-to-road-edge
  // clearance on each side, or just the front-to-front clearance in compact mode.
  const gapY = compact
    ? CLEARANCES.frontToFront
    : ROW_AISLE_GAP_FT;

  // NFPA 855 check region: the container portion of a candidate block footprint
  // (containers only — inverters/aux are exempt per sheet 10 key note 6).
  const containerDepth = LG_JF2.length * 2 + CLEARANCES.rearToRear;
  // NFPA container region within the footprint. Mirrored pairs: containers
  // span the middle band of the pair footprint (everything except the PCS +
  // clearance strip at each outer end), centered on the pair center.
  const nfpaRegion = mirrored
    ? {
        offX: 0,
        offY: 0,
        halfW: fp.width / 2,
        halfD: fp.depth / 2 - config.inverterDims.width - pcsClearance,
      }
    : {
        offX: -fp.width / 2 + fp.coreWidth / 2,
        offY: -fp.depth / 2 + containerDepth / 2,
        halfW: fp.coreWidth / 2,
        halfD: containerDepth / 2,
      };
  const containersFarEnough = (cx: number, cy: number) => {
    if (!nfpaSetback) return true;
    return rectInsidePolygon(
      cx + nfpaRegion.offX,
      cy + nfpaRegion.offY,
      nfpaRegion.halfW,
      nfpaRegion.halfD,
      boundary.polygon,
      CLEARANCES.bessToLotLine
    );
  };

  // Fence bounding box (also the origin of the placement lattices below)
  const xs = fence.map(p => p.x), ys = fence.map(p => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);

  // Optimizer lattice shift: slide the lattice origin by (x, y) normalized
  // into [0, step). shift 0 / undefined keeps the historical origin exactly
  // (no floating-point drift — the offsets below are then the literal 0).
  const latStepX = fp.width + gapX;
  const latStepY = fp.depth + gapY;
  const normShift = (v: number | undefined, step: number) => {
    if (!Number.isFinite(v) || !v || step <= 0) return 0;
    return ((v! % step) + step) % step;
  };
  const shiftX = normShift(options.latticeShift?.x, latStepX);
  const shiftY = normShift(options.latticeShift?.y, latStepY);

  // Same geometry exposed on the design so the preview drag validation
  // (validateRowShift) agrees exactly with the engine's constraint checks.
  // augGrid mirrors the future-aug lattice in placeReservedZones so the
  // preview can offer snap-to-grid targets that match the engine exactly.
  const rowEditGeom: RowEditGeom = {
    halfW: fp.width / 2,
    halfD: fp.depth / 2,
    equipmentMargin,
    nfpa: nfpaSetback
      ? {
          offX: nfpaRegion.offX,
          offY: nfpaRegion.offY,
          halfW: nfpaRegion.halfW,
          halfD: nfpaRegion.halfD,
          margin: CLEARANCES.bessToLotLine,
        }
      : null,
    augGrid: {
      originX: minX + equipmentMargin + fp.width / 2 + shiftX,
      originY: minY + equipmentMargin + fp.depth / 2 + shiftY,
      stepX: fp.width + CLEARANCES.frontToFront,
      stepY: fp.depth + (compact
        ? CLEARANCES.frontToFront
        : ROW_AISLE_GAP_FT),
    },
    // Aug UNIT (2 PCS + 6 BESS mirrored pair) fit geometry: its containers
    // span the middle band (everything but the PCS + clearance strip at each
    // outer end), centered on the unit — same rule as mirrored-pair blocks.
    aug: (() => {
      const afp = augUnitFootprint(config, pcsClearance);
      return {
        halfW: afp.width / 2,
        halfD: afp.depth / 2,
        nfpa: nfpaSetback
          ? {
              offX: 0,
              offY: 0,
              halfW: afp.width / 2,
              halfD: afp.depth / 2 - config.inverterDims.width - pcsClearance,
              margin: CLEARANCES.bessToLotLine,
            }
          : null,
      };
    })(),
  };

  // Grid search across the fence bounding box
  const equipment: PlacedEquipment[] = [];
  const augmentationZones: AugmentationZone[] = [];
  let blockIdx = 0;

  const stepX = latStepX;
  const stepY = latStepY;

  // Track rows of placed blocks so drive aisles can be drawn between them
  const rows: { y: number; minX: number; maxX: number }[] = [];
  // Footprint centers of placed blocks (1-based block number = index + 1)
  const blockCenters: { n: number; x: number; y: number }[] = [];

  // ---- Drafter drag-to-place islands (validated BEFORE the auto scan) ------
  // Each accepted entry drops one full standard island as a unit. Placement
  // is ADDITIVE: the automatic arrangement is planned exactly as it would be
  // without any placed island, and the drop only removes the planned sites it
  // physically covers (see the keepout filter below). It never re-plans the
  // yard, so islands the drafter already approved keep their position and
  // size. Everything below is gated on acceptedPlaced.length so layouts
  // without placed islands stay byte-identical.
  const placedSpecsIn = options.constraints?.placedIslands ?? [];
  if (placedSpecsIn.length && !mirrored) {
    // A genuine arrangement constraint, not an arbitrary refusal: QTY4 has
    // no mirrored-pair island model at all, so there is no island to place.
    const why =
      `this layout is QTY ${config.containersPerBlock} — islands are a QTY 3 (mirrored-pair) arrangement, ` +
      'so there is no island to place. Switch containers-per-PCS to 3 to place islands';
    for (const s of placedSpecsIn) {
      warnings.push(`Placed island ${s.id} rejected: ${why} — remove it in the layout edits panel.`);
    }
  }
  // Compact mode ACCEPTS placed equipment — drafters must be able to place in
  // a max-blocks layout. There are simply no roads to wrap or connect, so say
  // so once instead of bouncing the drop.
  if (placedSpecsIn.length && mirrored && compact) {
    warnings.push(
      'Compact mode builds no perimeter or interior roads, so hand-placed equipment has no road ' +
      'connection — verify vehicle access separately.');
  }
  const acceptedPlaced: { spec: PlacedIslandSpec; comp: PlacedIslandComposition }[] = [];
  // Aug pins that landed on an accepted placed island: the island always
  // wins (equipment is NEVER deleted by a pin) — these pins are rejected
  // with the standard pin warning and their unit keeps the automatic spot.
  const augPinsBlockedByIslands = new Set<string>();
  if (placedSpecsIn.length && mirrored) {
    // Pinned reserved rectangles exist regardless of placement order — the
    // same rects the pinnedReserved list below uses for aisle/block moves.
    const earlyPins: { id: string | null; x: number; y: number; hx: number; hy: number }[] = [];
    for (const [pinId, pt] of Object.entries(options.constraints?.augPins ?? {})) {
      if (Number.isFinite(pt?.x) && Number.isFinite(pt?.y)) {
        earlyPins.push({ id: pinId, x: pt.x, y: pt.y, hx: fp.width / 2, hy: fp.depth / 2 });
      }
    }
    {
      const ldPin = options.constraints?.laydownPin;
      const ldSize = options.constraints?.laydownSize;
      if (ldPin && Number.isFinite(ldPin.x) && Number.isFinite(ldPin.y) &&
          ldSize && Number.isFinite(ldSize.length) && Number.isFinite(ldSize.width)) {
        earlyPins.push({ id: null, x: ldPin.x, y: ldPin.y, hx: ldSize.length / 2, hy: ldSize.width / 2 });
      }
    }
    const rejectPlaced = (id: string, why: string) => warnings.push(
      `Placed island ${id} rejected: ${why} — move or remove it in the layout edits panel.`);
    for (const spec of placedSpecsIn) {
      if (!Number.isFinite(spec.x) || !Number.isFinite(spec.y)) {
        rejectPlaced(spec.id, 'invalid anchor position');
        continue;
      }
      // Geometry-only composition (island/block numbers assigned at append
      // time below — the auto block count is unknown until the scan runs).
      const comp = composePlacedIsland(spec, config, pcsClearance, 1, 1,
        options.constraints?.islandAugEnd?.[spec.id] === 'east' ? 'east' : 'west');
      // Place-with-warning model: only truly unworkable placements reject
      // (outside the fence line, overlapping another island or a pinned
      // reserved area). Clearance-margin and NFPA setback violations ACCEPT
      // the placement and surface as persistent warnings with the stable
      // "Placed island <id> placed with warning:" prefix so the drafter can
      // fix or accept them. Shared with the drag ghost so preview and commit
      // always agree.
      const ev = evaluatePlacedIslandDrop(
        spec, comp, config, pcsClearance, fence, boundary.polygon,
        equipmentMargin, nfpaSetback, earlyPins,
        acceptedPlaced.map(a => ({ id: a.spec.id, bbox: a.comp.bbox })));
      if (ev.hard) { rejectPlaced(spec.id, ev.hard); continue; }
      for (const w of ev.soft) {
        warnings.push(`Placed island ${spec.id} placed with warning: ${w} — review or move it in the layout edits panel.`);
      }
      for (const id of ev.blockedPins) augPinsBlockedByIslands.add(id);
      acceptedPlaced.push({ spec, comp });
    }
  }
  // Two different questions get asked about a placed island's surroundings,
  // and conflating them silently deletes approved equipment.
  //
  // 1. PHYSICAL conflict: does an auto block actually collide with the
  //    island (its footprint plus the equipment separation that must hold
  //    between any two blocks)? Only this may remove a planned site.
  // 2. ACCESS keepout: the same footprint inflated by a road corridor, so
  //    the island keeps a drivable lane. This is a preference about where
  //    NEW equipment should go — never a licence to delete existing blocks.
  const placedFootprints = acceptedPlaced.map(a => ({
    x: a.comp.bbox.x, y: a.comp.bbox.y,
    hx: a.comp.bbox.hx + pcsClearance,
    hy: a.comp.bbox.hy + pcsClearance,
  }));
  const placedKeepouts = acceptedPlaced.map(a => ({
    x: a.comp.bbox.x, y: a.comp.bbox.y,
    hx: a.comp.bbox.hx + CLEARANCES.roadWidth + 2 * CLEARANCES.equipmentToRoadEdge,
    hy: a.comp.bbox.hy + CLEARANCES.roadWidth + 2 * CLEARANCES.equipmentToRoadEdge,
  }));
  // Physically clear of every placed island (collision test).
  const clearOfPlacedFootprint = (x: number, y: number) => placedFootprints.every(k =>
    Math.abs(x - k.x) >= k.hx + fp.width / 2 || Math.abs(y - k.y) >= k.hy + fp.depth / 2);
  // Clear of the access corridor too (siting preference for NEW blocks).
  const clearOfPlaced = (x: number, y: number) => placedKeepouts.every(k =>
    Math.abs(x - k.x) >= k.hx + fp.width / 2 || Math.abs(y - k.y) >= k.hy + fp.depth / 2);
  // ADDITIVE PLACEMENT. The automatic scan runs at the FULL target and with
  // NO knowledge of the placed islands, so it reproduces exactly the
  // arrangement the drafter already sees. A placed island then removes only
  // the planned sites its footprint physically covers (post-scan filter
  // below) — it never lowers the target, which would let the scanner re-plan
  // the whole yard and relocate or delete islands the drafter approved.
  //
  // Consequence, and it is deliberate: a drop that lands on open ground adds
  // capacity on top of the automatic plan rather than trading it away. The
  // over/under-target position is reported to the drafter after the scan.
  const autoBlocksTarget = blocksRequired;

  // Lattice site coordinates, built with the exact same loop arithmetic as
  // the historical scan so the default arrangement stays byte-identical.
  const yVals: number[] = [];
  for (let y = minY + equipmentMargin + fp.depth / 2 + shiftY; y <= maxY - equipmentMargin; y += stepY) yVals.push(y);
  const xVals: number[] = [];
  for (let x = minX + equipmentMargin + fp.width / 2 + shiftX; x <= maxX - equipmentMargin; x += stepX) xVals.push(x);

  // Arrangement strategy = which corner the lattice fills from. 'sw' (the
  // default) scans south->north / west->east, identical to the original loop.
  const arrangement = options.arrangement ?? 'sw';
  const yOrder = arrangement === 'nw' || arrangement === 'ne' ? [...yVals].reverse() : yVals;
  const xOrder = arrangement === 'se' || arrangement === 'ne' ? [...xVals].reverse() : xVals;

  // Scan-time validity deliberately EXCLUDES the placed-island keepouts: the
  // automatic plan must come out identical to the no-placed-island baseline
  // (see ADDITIVE PLACEMENT above). Sites the drop actually covers are
  // filtered out afterwards, so the surviving islands keep their exact
  // baseline positions instead of re-flowing around the new footprint.
  const siteValidAuto = (x: number, y: number) =>
    rectInsidePolygon(x, y, fp.width / 2, fp.depth / 2, fence, equipmentMargin) &&
    containersFarEnough(x, y);
  // Full validity, including placed-island keepouts. Used by edits that ADD
  // new sites after the scan (island block deltas), which must not drop a
  // block onto a placed island.
  const siteValid = (x: number, y: number) =>
    siteValidAuto(x, y) && clearOfPlaced(x, y);
  const trackRow = (x: number, y: number) => {
    let row = rows.find(r => Math.abs(r.y - y) < 1);
    if (!row) { row = { y, minX: x, maxX: x }; rows.push(row); }
    row.minX = Math.min(row.minX, x - fp.width / 2);
    row.maxX = Math.max(row.maxX, x + fp.width / 2);
  };

  if (mirrored) {
    // Island-first placement. One lattice site = one mirrored PAIR (south
    // block + north block). Whole standard islands (ISLAND_PCS_PER_SIDE
    // pairs) are placed one at a time per row, then ISLAND_GAP_SITES lattice
    // sites are skipped so the strip-end gear (FJB + comms) and the default
    // 2-unit augmentation zone always fit between islands (the island aug
    // placement scans slots of PAIR_BLOCK_GAP + unit width off the strip
    // end; the first slot next to the gear is usually rejected, so allow 3).
    //
    // Strict pass: never start an island inside a valid run shorter than the
    // standard unless it is the site-wide final tail — every island comes
    // out full 7+7 with at most ONE partial tail island. If the strict pass
    // cannot fit the required blocks (fence-limited parcels where no run
    // holds a full island), a lenient pass reruns allowing fence-limited
    // short islands so capacity is never sacrificed.
    // Widened island MIDDLE gap (90% package CAR-D-B005-1): the mid-island
    // aux cluster keeps ISLAND_MIDDLE_CLEAR_FT (10'-0") clear on each side to
    // the neighboring pair columns, so the middle inter-pair gap grows from
    // the standard block gap to 10 + widest-cluster-piece + 10. Pair columns past
    // the split shift by midExtra in the scan direction; the shift is applied
    // only when every shifted site still passes fence/NFPA checks (otherwise
    // the island stays contiguous and a warning is raised at cluster time).
    const midExtra = islandMiddleExtraFt(pcsClearance);
    const islandGapExtra = 3 * (pairGap + fp.width) + pairGap;
    // Inter-island skip: widened islands overhang their last lattice site by
    // midExtra, so they need the larger skip; contiguous-fallback islands
    // keep the historical skip and pay no capacity for a gap they never got.
    const GAP_SITES_STD = Math.ceil(islandGapExtra / stepX);
    const GAP_SITES_WIDE = Math.ceil((islandGapExtra + midExtra) / stepX);
    const planScan = (strict: boolean) => {
      const placements: { x: number; y: number; count: number }[] = [];
      let remaining = autoBlocksTarget;
      for (const y of yOrder) {
        let i = 0;
        while (i < xOrder.length && remaining > 0) {
          if (!siteValidAuto(xOrder[i], y)) { i++; continue; }
          // Contiguous valid run starting here, capped at one island.
          let run = 1;
          while (run < ISLAND_PCS_PER_SIDE && i + run < xOrder.length && siteValidAuto(xOrder[i + run], y)) run++;
          const pairsLeft = Math.ceil(remaining / 2);
          if (strict && run < ISLAND_PCS_PER_SIDE && run < pairsLeft) {
            // Short fence-limited run mid-build: skip it, keep islands whole.
            i += run + 1;
            continue;
          }
          const take = Math.min(run, ISLAND_PCS_PER_SIDE, pairsLeft);
          // Middle-gap split: pairs at scan index >= mSplit shift by midExtra
          // in the scan direction so the cluster gap opens mid-island (4 + 3
          // for the standard 7-pair island, matching the reference detail).
          const mSplit = Math.ceil(take / 2);
          const scanDir = xOrder.length > 1 && xOrder[1] < xOrder[0] ? -1 : 1;
          // siteValidAuto, not siteValid: the widening decision is part of the
          // automatic plan, so it must be blind to placed islands too. Using
          // the keepout here let a nearby drop flip an untouched island to
          // non-widened geometry — resizing an island the drafter approved.
          const widen = take >= 2 &&
            Array.from({ length: take - mSplit }, (_, k) => xOrder[i + mSplit + k] + scanDir * midExtra)
              .every(sx => siteValidAuto(sx, y));
          for (let k = 0; k < take; k++) {
            // With only one block left, place just the south half (single-
            // sided edge strip; the aux corridor stays adjacent north).
            const count = Math.min(2, remaining);
            const sx = xOrder[i + k] + (widen && k >= mSplit ? scanDir * midExtra : 0);
            placements.push({ x: sx, y, count });
            remaining -= count;
          }
          i += take + (widen ? GAP_SITES_WIDE : GAP_SITES_STD);
        }
        if (remaining <= 0) break;
      }
      return placements;
    };
    const total = (p: { count: number }[]) => p.reduce((s, q) => s + q.count, 0);
    let placements = planScan(true);
    if (total(placements) < autoBlocksTarget) {
      const lenient = planScan(false);
      if (total(lenient) > total(placements)) placements = lenient;
    }
    // ADDITIVE PLACEMENT, step 2: the scan above ran blind to the placed
    // islands, so it reproduces the baseline arrangement exactly. Now drop
    // ONLY the planned pair sites a placed island PHYSICALLY collides with.
    // No back-fill and no re-scan: every surviving site keeps the coordinates
    // it had before the drop, so approved islands never move or disappear.
    // A drop on open ground removes nothing and is pure added capacity.
    //
    // The physical footprint is the right test here, NOT the road-inflated
    // access keepout: an auto block merely sitting in the new island's
    // preferred road corridor is existing approved equipment, and deleting it
    // to make room for a lane would be exactly the silent destruction this
    // whole change exists to prevent. Access is resolved by the road network,
    // which routes around whatever equipment is actually present.
    if (acceptedPlaced.length) {
      placements = placements.filter(p => clearOfPlacedFootprint(p.x, p.y));
    }

    // ---- drafter island block deltas (layout constraints) ------------------
    // islandRemovalApplied (declared below the placement loop's enclosing
    // scope) counts ACCEPTED removals so capacity/fallback floors follow
    // what was actually applied, never what was merely requested.
    // Applied to the AUTO plan before blocks are numbered: group the planned
    // pair sites into tentative islands exactly the way the island metadata
    // pass will (rows south -> north, x-adjacent runs split at gaps wider
    // than 1.5 lattice steps), then grow/shrink the targeted island at its
    // strip ends. Adds fill a half pair first, then open a new pair column
    // just past either end (fence/NFPA/spacing validated). Removals shrink
    // from the strip end, never below 1 block. Infeasible changes are
    // rejected with a warning and the automatic island is kept.
    const blockDeltas = options.constraints?.islandBlockDeltas ?? {};
    if (Object.keys(blockDeltas).length) {
      type PairSite = { x: number; y: number; count: number };
      const byRow = new Map<number, PairSite[]>();
      for (const p of placements) {
        const key = Array.from(byRow.keys()).find(y => Math.abs(y - p.y) < 1) ?? p.y;
        const arr = byRow.get(key) ?? [];
        arr.push(p);
        byRow.set(key, arr);
      }
      const islandSites: PairSite[][] = [];
      for (const y of Array.from(byRow.keys()).sort((a, b) => a - b)) {
        const sorted = [...byRow.get(y)!].sort((a, b) => a.x - b.x);
        let cur: PairSite[] = [];
        for (const s of sorted) {
          if (cur.length && s.x - cur[cur.length - 1].x > islandSplitGapFt(latStepX, pcsClearance)) {
            islandSites.push(cur);
            cur = [];
          }
          cur.push(s);
        }
        if (cur.length) islandSites.push(cur);
      }
      const rejectDelta = (n: number, why: string) => warnings.push(
        `Island ${n} block change rejected: ${why} — automatic island layout kept.`);
      for (const islN of Object.keys(blockDeltas).map(Number).sort((a, b) => a - b)) {
        const rawDelta = blockDeltas[islN];
        const delta = Math.trunc(typeof rawDelta === 'number' && Number.isFinite(rawDelta) ? rawDelta : 0);
        if (!delta || !Number.isInteger(islN) || islN < 1) continue;
        const cluster = islandSites[islN - 1];
        if (!cluster) {
          warnings.push(
            `Island block change for island ${islN} is dormant — the current layout ` +
            `only has ${islandSites.length} island${islandSites.length === 1 ? '' : 's'}.`);
          continue;
        }
        const blocksIn = () => cluster.reduce((s, q) => s + q.count, 0);
        if (delta < 0) {
          if (blocksIn() + delta < 1) {
            rejectDelta(islN,
              `island ${islN} holds only ${blocksIn()} block${blocksIn() === 1 ? '' : 's'} and at least 1 must remain`);
            continue;
          }
          for (let k = 0; k < -delta; k++) {
            const tail = cluster[cluster.length - 1];
            if (tail.count > 1) tail.count = 1;
            else {
              cluster.pop();
              placements.splice(placements.indexOf(tail), 1);
            }
            islandRemovalApplied++;
          }
        } else {
          let added = 0;
          for (let k = 0; k < delta; k++) {
            // Complete the island's half pair first (a count-1 tail site).
            const half = cluster.find(s => s.count === 1);
            if (half) { half.count = 2; added++; continue; }
            // Otherwise open a new pair column just past either strip end.
            const y = cluster[0].y;
            const rowSites = placements.filter(p => Math.abs(p.y - y) < 1);
            const fits = (x: number) => siteValid(x, y) &&
              rowSites.every(p => Math.abs(p.x - x) >= latStepX * 0.99);
            const east = cluster[cluster.length - 1].x + latStepX;
            const west = cluster[0].x - latStepX;
            const x = fits(east) ? east : fits(west) ? west : null;
            if (x === null) {
              rejectDelta(islN,
                `no room for ${delta - added > 1 ? `${delta - added} more blocks` : 'another block'} ` +
                `at either end of island ${islN} (fence, setback or spacing clearances)`);
              break;
            }
            const site: PairSite = { x, y, count: 1 };
            if (x === east) {
              placements.splice(placements.indexOf(cluster[cluster.length - 1]) + 1, 0, site);
              cluster.push(site);
            } else {
              placements.splice(placements.indexOf(cluster[0]), 0, site);
              cluster.unshift(site);
            }
            added++;
          }
        }
      }
    }

    for (const p of placements) {
      const placedCount = placeMirroredPair(
        equipment, config, blockIdx, p.x, p.y, fp, pcsClearance, p.count
      );
      for (let k = 0; k < placedCount; k++) {
        blockCenters.push({ n: blockIdx + 1 + k, x: p.x, y: p.y });
      }
      blockIdx += placedCount;
      trackRow(p.x, p.y);
    }
  } else {
    outer:
    for (const y of yOrder) {
      for (const x of xOrder) {
        if (blockIdx >= blocksRequired) break outer;
        if (!siteValid(x, y)) continue;
        placeBlock(equipment, config, blockIdx, x, y, fp, pcsClearance);
        blockCenters.push({ n: blockIdx + 1, x, y });
        blockIdx++;
        trackRow(x, y);
      }
    }
  }

  // ---- drafter deletions (layout constraints) -------------------------------
  // Deleting equipment is a first-class layout edit, exactly like moving it:
  // the item is omitted here, before any metadata pass, so islands, feeders,
  // cables, trenching, reserved zones, capacity, the BOM and every export
  // re-derive without it. Three deliberate rules:
  //   - Survivors KEEP their automatic block numbers (no renumbering), so
  //     every other edit keyed by block number (moves, rotations, DC routing)
  //     still points at the same physical block.
  //   - Deleting a PCS escalates to its whole block: containers with no
  //     inverter are not a buildable arrangement, and the escalation is
  //     reported rather than performed silently.
  //   - Ids the current layout does not create go dormant with a warning and
  //     revive if the item returns (same policy as removedRoads).
  let blockRemovalApplied = 0;
  let looseContainersRemoved = 0;
  // Aux gear, panels and per-island cabinets are placed LATER in this pass, so
  // their ids do not exist yet and cannot be filtered here. Carrying them
  // forward (instead of declaring them dormant now) is what makes deleting a
  // transformer, FJB, comms cabinet or panel actually take effect.
  const deferredEquipRemoval = new Set<string>();
  {
    const autoBlockNs = new Set(blockCenters.map(b => b.n));
    const wantBlocks = new Set<number>();
    for (const raw of options.constraints?.removedBlocks ?? []) {
      if (Number.isInteger(raw) && raw >= 1) wantBlocks.add(raw);
    }
    const wantEquip = new Set<string>();
    for (const raw of options.constraints?.removedEquipment ?? []) {
      if (typeof raw !== 'string' || !raw) continue;
      const inv = raw.match(/^inv-(\d+)$/);
      if (inv) {
        const n = Number(inv[1]);
        // Escalate, and say so — the containers vanish too, which the drafter
        // must not discover only by looking at the drawing.
        if (autoBlockNs.has(n) && !wantBlocks.has(n)) {
          warnings.push(
            `PCS ${raw} deleted with its whole block ${n}: containers cannot be built without ` +
            `their inverter, so block ${n} (PCS + containers) was removed.`
          );
        }
        wantBlocks.add(n);
        continue;
      }
      wantEquip.add(raw);
    }

    const removeBlockNs = new Set<number>();
    for (const n of Array.from(wantBlocks).sort((a, b) => a - b)) {
      if (!autoBlockNs.has(n)) {
        warnings.push(
          `Block ${n} deletion is dormant: this layout has no block ${n} — ` +
          'the deletion revives if that block returns.'
        );
        continue;
      }
      removeBlockNs.add(n);
    }

    if (removeBlockNs.size || wantEquip.size) {
      const blockOfId = (id: string): number | null => {
        const m = id.match(/^(?:bess|inv)-(\d+)/);
        return m ? Number(m[1]) : null;
      };
      const kept: PlacedEquipment[] = [];
      const removedIds = new Set<string>();
      for (const e of equipment) {
        const bn = blockOfId(e.id);
        if (bn !== null && removeBlockNs.has(bn)) { removedIds.add(e.id); continue; }
        if (wantEquip.has(e.id)) { removedIds.add(e.id); continue; }
        kept.push(e);
      }
      for (const id of Array.from(wantEquip)) {
        // Not present YET is not the same as not present at all: aux gear,
        // panels and island cabinets are pushed further down this pass, so the
        // removal is retried once the full equipment list exists.
        if (!removedIds.has(id)) deferredEquipRemoval.add(id);
      }
      equipment.length = 0;
      equipment.push(...kept);
      // Containers deleted ONE AT A TIME still cost stored energy; containers
      // that went with a whole block are already paid for by the block count.
      for (const id of Array.from(removedIds)) {
        const bn = blockOfId(id);
        if (/^bess-/.test(id) && !(bn !== null && removeBlockNs.has(bn))) looseContainersRemoved++;
      }
      if (removeBlockNs.size) {
        const survivors = blockCenters.filter(b => !removeBlockNs.has(b.n));
        blockCenters.length = 0;
        blockCenters.push(...survivors);
        blockRemovalApplied = removeBlockNs.size;
      }
    }
  }

  // Placed islands count toward capacity (their blocks are appended after
  // the auto metadata passes; numbering starts after the auto blocks). Count
  // each island's ACTUAL pair columns — a partial island carries fewer than
  // the standard strip and must not be billed as a full one.
  const placedBlockCount = acceptedPlaced.reduce(
    (s, a) => s + placedSpecBlockCount(a.spec), 0);
  // A manual 1 PCS + 2 BESS module still contributes one PCS block for MW,
  // but stores one fewer container than the standard QTY3 block. Keep that
  // energy adjustment separate so automatic and legacy single layouts retain
  // their historical capacity math.
  const placedContainerShortfall = acceptedPlaced.reduce(
    (s, a) => s + (a.spec.kind === 'single2'
      ? config.containersPerBlock - TWO_BESS_MODULE_CONTAINERS
      : 0),
    0);
  // blockIdx stays the numbering high-water mark (deleting block 5 must never
  // let a placed island reuse a surviving block's number), so the deletion is
  // subtracted from the COUNT only.
  const blocksPlaced = blockIdx - blockRemovalApplied + placedBlockCount;
  // AUTO blocks only — the gate for site-level gear the drafter did not ask
  // for. A layout that consists solely of drag-placed islands/modules gets
  // NOTHING inserted beyond what each placement composes itself (no yard aux
  // pad, no FACP/fiber/aux panels): "place an island" must mean exactly that.
  const autoBlocksPlaced = blockIdx - blockRemovalApplied;

  // Frozen drive-aisle strips, derived from the AUTO row positions only.
  // Layout edits never change them: roads are frozen during edits, and every
  // move is validated against these strips. Because auto placement is
  // deterministic in (parcel, config, targets), a config/parcel/reset change
  // regenerates fresh roads while edits leave them pixel-identical.
  let frozenAisles: RoadSegment[] = compact
    ? []
    : computeAisles(rows, fp, insetPolygon(fence, bandInset + CLEARANCES.roadWidth));

  // ---- drafter row moves (layout constraints) -------------------------------
  // Auto rows sorted south -> north give the stable 1-based row index the UI
  // and constraints use. A whole row is translated by (dx, dy) only when every
  // block in it still passes fence clearance, the NFPA container setback, and
  // does not collide with blocks of other rows; otherwise the move is rejected
  // with a warning and the automatic position is kept.
  const autoRows = [...rows].sort((a, b) => a.y - b.y);
  const blockRows: SiteDesign['blockRows'] = autoRows.map((r, i) => ({
    index: i + 1,
    y: r.y,
    autoY: r.y,
    blockCount: blockCenters.filter(b => Math.abs(b.y - r.y) < 1).length,
    moved: false,
    blocks: [],
  }));

  // Auto y of each block, captured before any move so row membership stays
  // stable when blocks/rows are translated.
  const autoCenterOf = new Map(blockCenters.map(b => [b.n, b.y] as const));

  // Drafter-pinned reserved areas are fixed rectangles (they do not re-place
  // around moved equipment), so aisle/block/equipment moves must not land on
  // them. Auto-placed reserved zones are placed AFTER these moves and avoid
  // the moved equipment on their own.
  const pinnedReserved: { id: string; x: number; y: number; length: number; width: number }[] = [];
  for (const [pinKey, pt] of Object.entries(options.constraints?.augPins ?? {})) {
    if (Number.isFinite(pt?.x) && Number.isFinite(pt?.y) && !augPinsBlockedByIslands.has(pinKey)) {
      pinnedReserved.push({ id: pinKey, x: pt.x, y: pt.y, length: fp.width, width: fp.depth });
    }
  }
  {
    const ldPin = options.constraints?.laydownPin;
    const ldSize = options.constraints?.laydownSize;
    if (ldPin && Number.isFinite(ldPin.x) && Number.isFinite(ldPin.y) &&
        ldSize && Number.isFinite(ldSize.length) && Number.isFinite(ldSize.width)) {
      pinnedReserved.push({ id: 'laydown', x: ldPin.x, y: ldPin.y, length: ldSize.length, width: ldSize.width });
    }
  }
  // Placed islands are fixed rectangles too: aisle/row/block moves must not
  // land on them (their footprint AABB covers blocks, gear and aug reserve).
  const placedObstacles: { id: string; x: number; y: number; length: number; width: number }[] =
    acceptedPlaced.map(a => ({
      id: `placed-${a.spec.id}`,
      x: a.comp.bbox.x, y: a.comp.bbox.y,
      length: a.comp.bbox.hx * 2, width: a.comp.bbox.hy * 2,
    }));
  pinnedReserved.push(...placedObstacles);

  // ---- drafter aisle moves (layout constraints) ------------------------------
  // Dragging interior drive aisle k by dy carries every row NORTH of it along
  // (rows k+1..N shift by dy) so the aisle keeps its standard clearance to the
  // row above; the gap south of it widens/narrows. Applied BEFORE row/block/
  // equipment moves. Unlike those edits, an accepted aisle move relaxes the
  // frozen-roads model: `rows` is updated so the road network, surfacing,
  // trenches and cables all regenerate from the shifted positions, and the
  // frozen strips are recomputed so later edits validate against the roads as
  // they will actually be rebuilt. With no aisle moves the output is
  // byte-identical to before.
  // Engineer override keys: forced edits apply even when validation fails
  // (warning kept so the deviation is on record). See LayoutConstraints.
  const forcedEdits = new Set(options.constraints?.forcedEdits ?? []);

  const aisleOffsets: number[] = frozenAisles.map(() => 0);
  {
    const aisleMoves = options.constraints?.aisleMoves ?? {};
    const rowObjByIndex = new Map(blockRows.map((info, i) => [info.index, autoRows[i]] as const));
    const keys = Object.keys(aisleMoves).map(Number).sort((a, b) => a - b);
    let anyApplied = false;
    for (const k of keys) {
      const dy = aisleMoves[k];
      if (!dy || !Number.isFinite(dy)) continue;
      if (compact || !Number.isInteger(k) || k < 1 || k > frozenAisles.length) {
        warnings.push(`Aisle ${k} move rejected: no such drive aisle — automatic position kept.`);
        continue;
      }
      const movingIdx = new Set(blockRows.filter(r => r.index > k).map(r => r.index));
      const rowIndexOfBlock = (b: { n: number; y: number }) =>
        blockRows.find(r => Math.abs((autoCenterOf.get(b.n) ?? b.y) - r.autoY) < 1)?.index ?? null;
      const movingBlocks = blockCenters.filter(b => {
        const ri = rowIndexOfBlock(b);
        return ri !== null && movingIdx.has(ri);
      });
      const movingSet = new Set(movingBlocks.map(b => b.n));
      const otherBlocks = blockCenters.filter(b => !movingSet.has(b.n));
      const reason = validateAisleShift(
        movingBlocks, otherBlocks, rowEditGeom, fence, boundary.polygon, dy, dy, pinnedReserved
      );
      if (reason) {
        if (forcedEdits.has(`aisle-${k}`)) {
          warnings.push(`Aisle ${k} moved with engineer override despite: ${reason} — verify clearances in detailed design.`);
        } else {
          warnings.push(`Aisle ${k} move rejected: ${reason} — automatic position kept.`);
          continue;
        }
      }
      for (const e of equipment) {
        const m = e.id.match(/^(?:bess|inv)-(\d+)/);
        if (m && movingSet.has(Number(m[1]))) e.y += dy;
      }
      for (const b of movingBlocks) b.y += dy;
      for (const info of blockRows) {
        if (!movingIdx.has(info.index)) continue;
        info.y += dy;
        info.moved = true;
        const rowObj = rowObjByIndex.get(info.index);
        if (rowObj) rowObj.y += dy;
      }
      // Rows k+1..N all shifted: aisle k's gap changed by dy, its recomputed
      // centerline moves dy/2 — offset it another dy/2 so it lands exactly dy
      // from auto (glued to the row above with the standard clearance).
      aisleOffsets[k - 1] += dy / 2;
      anyApplied = true;
    }
    if (anyApplied && !compact) {
      frozenAisles = computeAisles(
        rows, fp, insetPolygon(fence, bandInset + CLEARANCES.roadWidth), aisleOffsets
      );
    }
  }

  const rowMoves = options.constraints?.rowMoves ?? {};
  for (const [key, mv] of Object.entries(rowMoves)) {
    const idx = Number(key);
    const info = blockRows.find(r => r.index === idx);
    if (!info || (!mv.dx && !mv.dy)) continue;
    const rowBlocks = blockCenters.filter(b => Math.abs((autoCenterOf.get(b.n) ?? b.y) - info.autoY) < 1);
    const others = blockCenters.filter(b => Math.abs((autoCenterOf.get(b.n) ?? b.y) - info.autoY) >= 1);
    // Row centers may already carry an aisle-move shift; the (dx, dy)
    // constraint is an offset from that (aisle-adjusted) baseline, applied
    // from the blocks' current positions.
    const reason = validateRowShift(
      rowBlocks, others, rowEditGeom, fence, boundary.polygon, mv.dx, mv.dy, frozenAisles,
      placedObstacles
    );
    if (reason) {
      if (forcedEdits.has(`row-${idx}`)) {
        warnings.push(`Row ${idx} moved with engineer override despite: ${reason} — verify clearances in detailed design.`);
      } else {
        warnings.push(`Row ${idx} move rejected: ${reason} — automatic position kept.`);
        continue;
      }
    }
    // Apply: translate every equipment item of the row's blocks
    const ids = new Set(rowBlocks.map(b => b.n));
    for (const e of equipment) {
      const m = e.id.match(/^(?:bess|inv)-(\d+)/);
      if (m && ids.has(Number(m[1]))) { e.x += mv.dx; e.y += mv.dy; }
    }
    for (const b of rowBlocks) { b.x += mv.dx; b.y += mv.dy; }
    info.y += mv.dy;
    info.moved = true;
  }

  // ---- drafter vertical row shifts (wrap/compact toward an edge) -----------
  // Applied AFTER row moves (synthetic island-stack moves + user rowMoves) so
  // validation sees the rows at their final x positions — the same positions
  // computeCompactShifts scans in the finished design.
  // Road-following vertical sibling of rowMoves.dy: each accepted shift
  // translates a whole auto row and, like aisle moves, updates `rows` so the
  // road network, surfacing, trenches and cables regenerate around the new
  // positions. All requested shifts are validated as a set (each row against
  // every OTHER row at its shifted position, fence/NFPA/reserved/placed
  // islands, and the minimum drive-aisle pitch between x-overlapping rows so
  // no equipment can ever land on the road band). Rejected shifts drop out
  // and the survivors are re-validated until stable — reject → warn → keep
  // auto, never a broken layout. Absent/empty constraint => byte-identical.
  {
    const rowShiftsIn = options.constraints?.rowShifts ?? {};
    const requested: { idx: number; dy: number }[] = [];
    for (const key of Object.keys(rowShiftsIn).map(Number).sort((a, b) => a - b)) {
      const dy = rowShiftsIn[key];
      if (!dy || !Number.isFinite(dy)) continue;
      if (compact) {
        warnings.push(`Row ${key} vertical shift rejected: row shifts need a road-mode layout — automatic position kept.`);
        continue;
      }
      if (!blockRows.some(r => r.index === key)) {
        // Dormant shift (regeneration dropped the row) — silently ignored so
        // stale constraints from a changed layout never spam warnings.
        continue;
      }
      requested.push({ idx: key, dy });
    }
    if (requested.length) {
      const rowIndexOfBlock = (b: { n: number; y: number }) =>
        blockRows.find(r => Math.abs((autoCenterOf.get(b.n) ?? b.y) - r.autoY) < 1)?.index ?? null;
      const rowBlocksOf = new Map<number, { n: number; x: number; y: number }[]>();
      for (const info of blockRows) {
        rowBlocksOf.set(info.index, blockCenters.filter(b => rowIndexOfBlock(b) === info.index));
      }
      // Iteratively validate the surviving shift set (a rejection changes the
      // shifted positions the remaining rows validate against).
      const active = new Map(requested.map(r => [r.idx, r.dy]));
      const PITCH_EPS = 1e-6;
      for (let round = 0; round < requested.length + 1 && active.size; round++) {
        let changed = false;
        for (const [idx, dy] of Array.from(active.entries())) {
          const rowBlocks = rowBlocksOf.get(idx) ?? [];
          if (!rowBlocks.length) { active.delete(idx); changed = true; continue; }
          const others = blockCenters
            .filter(b => rowIndexOfBlock(b) !== idx)
            .map(b => {
              const ri = rowIndexOfBlock(b);
              const odny = ri !== null ? (active.get(ri) ?? 0) : 0;
              return { n: b.n, x: b.x, y: b.y + odny };
            });
          // No frozen aisles here: the road network regenerates around the
          // shifted rows, so only fence/NFPA/collisions/reserved apply...
          let reason = validateRowShift(
            rowBlocks, others, rowEditGeom, fence, boundary.polygon, 0, dy, [], pinnedReserved
          );
          // ...plus the road-pitch invariant: x-overlapping rows must keep at
          // least the drive-aisle gap (or their current gap, if the automatic
          // layout already packed tighter) between block footprints, so the
          // rebuilt aisle band always fits and equipment never overlaps road.
          if (!reason) {
            const info = blockRows.find(r => r.index === idx)!;
            const span = (bs: { x: number }[]) => {
              const xs = bs.map(b => b.x);
              return [Math.min(...xs) - rowEditGeom.halfW, Math.max(...xs) + rowEditGeom.halfW] as const;
            };
            const [aLo, aHi] = span(rowBlocks);
            for (const other of blockRows) {
              if (other.index === idx) continue;
              const obs = rowBlocksOf.get(other.index) ?? [];
              if (!obs.length) continue;
              const [bLo, bHi] = span(obs);
              if (aHi <= bLo || aLo >= bHi) continue; // no x overlap: no shared aisle
              const oDy = active.get(other.index) ?? 0;
              const curGap = Math.abs(info.y - other.y) - rowEditGeom.halfD * 2;
              const newGap = Math.abs((info.y + dy) - (other.y + oDy)) - rowEditGeom.halfD * 2;
              const minGap = Math.min(ROW_AISLE_GAP_FT, curGap);
              if (newGap < minGap - PITCH_EPS) {
                reason = `row ${other.index} would be closer than the minimum drive-aisle pitch (${minGap.toFixed(1)} ft needed, ${Math.max(0, newGap).toFixed(1)} ft left)`;
                break;
              }
            }
          }
          if (reason) {
            warnings.push(`Row ${idx} vertical shift rejected: ${reason} — automatic position kept.`);
            active.delete(idx);
            changed = true;
          }
        }
        if (!changed) break;
      }
      if (active.size) {
        const rowObjByIndex = new Map(blockRows.map((info, i) => [info.index, autoRows[i]] as const));
        for (const [idx, dy] of Array.from(active.entries())) {
          const rowBlocks = rowBlocksOf.get(idx) ?? [];
          const ids = new Set(rowBlocks.map(b => b.n));
          for (const e of equipment) {
            const m = e.id.match(/^(?:bess|inv)-(\d+)/);
            if (m && ids.has(Number(m[1]))) e.y += dy;
          }
          for (const b of rowBlocks) b.y += dy;
          const info = blockRows.find(r => r.index === idx)!;
          info.y += dy;
          info.moved = true;
          const rowObj = rowObjByIndex.get(idx);
          if (rowObj) rowObj.y += dy;
        }
        if (!compact) {
          frozenAisles = computeAisles(
            rows, fp, insetPolygon(fence, bandInset + CLEARANCES.roadWidth), aisleOffsets
          );
        }
      }
    }
  }

  // ---- drafter single-block moves (layout constraints) ----------------------
  // One block (containers + PCS) translated as a unit, composing on
  // top of any aisle/row move. Same validation rules as row moves; rejected
  // moves keep the automatic (or aisle/row-moved) position with a warning.
  // Pinned reserved rectangles (built above, before the aisle pass) stay
  // fixed, so block/equipment moves must not land on them.
  const blockMoves = options.constraints?.blockMoves ?? {};
  const movedPadCenters: Pt[] = [];
  // Blocks carrying the SAME delta translate rigidly together (this is how a
  // whole island is nudged), so they are validated and applied as ONE unit:
  //   - mirrored twins share a footprint center, so an island that lists both
  //     twin ids must still move that footprint ONCE (applying each entry
  //     separately doubled a 0.1 ft nudge into 0.2 ft), and
  //   - a co-moving block is not an obstacle to its own group, so the unit is
  //     validated only against blocks that are NOT moving with it. Validating
  //     pair-by-pair rejected legal rigid translations of multi-pair islands.
  // Blocks in other cohorts stay in `others` at their pre-move positions,
  // which is the conservative choice.
  const moveCohorts = new Map<string, { dx: number; dy: number; ns: number[] }>();
  for (const [key, mv] of Object.entries(blockMoves)) {
    const n = Number(key);
    if (!blockCenters.some(b => b.n === n) || (!mv.dx && !mv.dy)) continue;
    const ck = `${mv.dx.toFixed(4)}|${mv.dy.toFixed(4)}`;
    const c = moveCohorts.get(ck) ?? { dx: mv.dx, dy: mv.dy, ns: [] };
    c.ns.push(n);
    moveCohorts.set(ck, c);
  }
  for (const cohort of Array.from(moveCohorts.values())) {
    const mv = { dx: cohort.dx, dy: cohort.dy };
    // Expand to mirrored twins, then de-duplicate: the unit is a set of
    // BLOCKS, so a footprint listed twice (both twin ids) still moves once.
    const unitIds = new Set<number>();
    for (const n of cohort.ns) {
      const blk = blockCenters.find(b => b.n === n);
      if (!blk) continue;
      if (mirrored) {
        for (const b of blockCenters) {
          if (Math.abs(b.x - blk.x) < 0.5 && Math.abs(b.y - blk.y) < 0.5) unitIds.add(b.n);
        }
      } else unitIds.add(blk.n);
    }
    if (!unitIds.size) continue;
    const unit = blockCenters.filter(b => unitIds.has(b.n));
    const others = blockCenters.filter(b => !unitIds.has(b.n));
    const reason = validateRowShift(
      unit, others, rowEditGeom, fence, boundary.polygon, mv.dx, mv.dy, frozenAisles,
      pinnedReserved
    );
    if (reason) {
      // All-or-nothing: the whole group keeps its automatic position, and
      // EVERY requested block reports the rejection so the caller (which
      // matches on its own block numbers) reverts the entire edit.
      const overridden = cohort.ns.every(n => forcedEdits.has(`block-${n}`));
      if (overridden) {
        for (const n of cohort.ns) {
          warnings.push(`Block ${n} moved with engineer override despite: ${reason} — verify clearances in detailed design.`);
        }
      } else {
        for (const n of cohort.ns) {
          warnings.push(`Block ${n} move rejected: ${reason} — automatic position kept.`);
        }
        continue;
      }
    }
    for (const e of equipment) {
      const m = e.id.match(/^(?:bess|inv)-(\d+)/);
      if (m && unitIds.has(Number(m[1]))) { e.x += mv.dx; e.y += mv.dy; }
    }
    for (const b of unit) { b.x += mv.dx; b.y += mv.dy; }
    // Remember the moved pad centers: buildRoads() carves an access road ring
    // (plus a connector to the nearest existing road) around any accepted
    // block move that landed away from the frozen road network.
    for (const b of unit) {
      if (!movedPadCenters.some(p => Math.abs(p.x - b.x) < 0.5 && Math.abs(p.y - b.y) < 0.5)) {
        movedPadCenters.push({ x: b.x, y: b.y });
      }
    }
  }

  // Expose each row's current block centers for preview picking/drag.
  // Membership comes from the AUTO placement (stable even after a block is
  // individually moved off the row's y band), positions are current.
  const rowOfBlock = new Map<number, number>();
  for (const info of blockRows) {
    for (const b of blockCenters) {
      if (!rowOfBlock.has(b.n) && Math.abs((autoCenterOf.get(b.n) ?? b.y) - info.autoY) < 1) {
        rowOfBlock.set(b.n, info.index);
      }
    }
  }
  for (const info of blockRows) {
    info.blocks = blockCenters
      .filter(b => rowOfBlock.get(b.n) === info.index)
      .map(b => ({ n: b.n, x: b.x, y: b.y }));
  }

  // NOTE: aisle/road geometry is intentionally NOT rebuilt from row/block/
  // equipment moves — those edits leave `rows` at their baseline positions so
  // buildRoads() below reproduces the frozen road network. The one exception
  // is an accepted AISLE move (above), which shifts `rows` and sets per-aisle
  // offsets so roads, surfacing, trenches and cables regenerate around it.
  // ACCEPTED drafter island block removals lower the capacity floor: a
  // removed block is intentional, not a "site can only fit" shortfall.
  const removalFloor = Math.max(1, blocksRequired - islandRemovalApplied - blockRemovalApplied);
  if (blocksPlaced < removalFloor) {
    warnings.push(
      `Site can only fit ${blocksPlaced} of ${blocksRequired} required blocks. ` +
      `Achieved ${(blocksPlaced * config.blockMW).toFixed(1)} MW / ` +
       `${((blocksPlaced * config.containersPerBlock - placedContainerShortfall) * config.containerMWh).toFixed(1)} MWh.`
    );
  } else if (acceptedPlaced.length && blocksPlaced > blocksRequired) {
    // Hand-placed islands are ADDITIVE: a drop on open ground adds capacity
    // on top of the automatic plan rather than displacing it. Say so plainly
    // — the alternative (silently deleting automatic equipment to stay on
    // target) is exactly the behaviour that destroyed approved layouts.
    const overBlocks = blocksPlaced - blocksRequired;
    warnings.push(
      `Hand-placed islands put this layout ${overBlocks} block${overBlocks === 1 ? '' : 's'} above the ` +
      `${blocksRequired}-block target: ${blocksPlaced} blocks total, ` +
      `${(blocksPlaced * config.blockMW).toFixed(1)} MW / ` +
       `${((blocksPlaced * config.containersPerBlock - placedContainerShortfall) * config.containerMWh).toFixed(1)} MWh vs the ` +
      `${targetMW.toFixed(1)} MW / ${targetMWh.toFixed(1)} MWh target. Automatic islands were left where ` +
      'they are — remove a placed island or delete automatic blocks to come back to target.'
    );
  }

  // ---- Mirrored-pair islands (3-container layouts only) ---------------------
  // An island = one pair row (a back-to-back strip across the aux corridor).
  // Numbered south -> north; FF in PCS/CON labels is the island number. Each
  // island gets a feeder junction box + comms cabinet at the strip end near
  // the corridor (per the reference inset detail).
  let islands: IslandInfo[] | null = null;
  // Islands whose mid-island aux cluster (aux transformer at minimum) was
  // placed; > 0 suppresses the yard-level gate-side aux pad below.
  let islandAuxClustersPlaced = 0;
  if (mirrored && blocksPlaced > 0) {
    const invById = new Map(equipment.filter(e => e.kind === 'inverter').map(e => [e.id, e]));
    // Each row splits into standard islands at the inter-island gaps the
    // lattice inserted (7 pairs per island). Cluster the row's blocks by x
    // adjacency: a gap wider than the widest INTRA-island step (the widened
    // middle cluster gap) starts a new island. See islandSplitGapFt — a fixed
    // multiple of the lattice step mis-splits islands once the block gap
    // shrinks below the middle gap.
    // Numbered south -> north, then west -> east within a row.
    islands = [];
    let islandN = 0;
    const splitGap = islandSplitGapFt(latStepX, pcsClearance);
    for (const info of blockRows) {
      const sorted = [...info.blocks].sort((a, b) => a.x - b.x);
      const clusters: typeof sorted[] = [];
      for (const b of sorted) {
        const cur = clusters[clusters.length - 1];
        if (cur && b.x - cur[cur.length - 1].x <= splitGap) cur.push(b);
        else clusters.push([b]);
      }
      for (const members of clusters) {
        islandN++;
        const invs = members
          .map(b => invById.get(`inv-${b.n}`))
          .filter((e): e is PlacedEquipment => !!e);
        const south = invs.filter(e => e.y < info.y).sort((a, b) => a.x - b.x || a.id.localeCompare(b.id));
        const north = invs.filter(e => e.y >= info.y).sort((a, b) => b.x - a.x || a.id.localeCompare(b.id));
        const xs = members.map(b => b.x);
        islands.push({
          n: islandN,
          y: info.y,
          minX: Math.min(...xs) - fp.width / 2,
          maxX: Math.max(...xs) + fp.width / 2,
          inverterIds: [...south.map(e => e.id), ...north.map(e => e.id)],
          southIds: south.map(e => e.id),
          northIds: north.map(e => e.id),
        });
      }
    }
    // Island-first placement keeps every island at the full standard
    // (ISLAND_PCS_PER_SIDE pairs); the block-count remainder forms one
    // partial tail island, and fence-limited parcels (lenient pass) may hold
    // additional short islands. Surface every below-standard island so the
    // drafter always knows which feeders run under the 7-built standard.
    {
      const short = islands.filter(isl =>
        Math.min(isl.southIds.length, isl.northIds.length) < ISLAND_PCS_PER_SIDE);
      if (short.length) {
        warnings.push(
          `Island${short.length > 1 ? 's' : ''} ${short.map(i => i.n).join(', ')} ` +
          `hold${short.length > 1 ? '' : 's'} fewer than the standard ${ISLAND_PCS_PER_SIDE} PCS per side ` +
          `(${short.map(i => `${i.southIds.length}/${i.northIds.length}`).join(', ')}) — ` +
          `the remaining pairs form a partial island; its feeders run below the 7-built standard.`
        );
      }
    }
    // Island envelope-width equalization audit (register F-08): islands with
    // the SAME pair count must render the same envelope width. The planScan
    // widens every island's middle gap whenever the shifted sites stay valid,
    // so a same-count width mismatch means fence geometry FORCED one island
    // to stay contiguous — surface that loudly instead of letting the plan
    // silently show unequal islands.
    {
      const byCount = new Map<number, IslandInfo[]>();
      for (const isl of islands) {
        const pairs = Math.max(isl.southIds.length, isl.northIds.length);
        (byCount.get(pairs) ?? byCount.set(pairs, []).get(pairs)!).push(isl);
      }
      for (const [pairs, group] of Array.from(byCount.entries())) {
        if (group.length < 2) continue;
        const widths = group.map((i: IslandInfo) => i.maxX - i.minX);
        const wMax = Math.max(...widths), wMin = Math.min(...widths);
        if (wMax - wMin > 0.1) {
          const narrow = group.filter((i: IslandInfo) => (i.maxX - i.minX) < wMax - 0.1);
          warnings.push(
            `Island envelope: island${narrow.length > 1 ? 's' : ''} ${narrow.map(i => i.n).join(', ')} ` +
            `render${narrow.length > 1 ? '' : 's'} ${(wMax - wMin).toFixed(1)} ft narrower than the widest ${pairs}-pair island — ` +
            `fence geometry blocked the standard widened middle gap there; envelopes are NOT equal on this parcel.`);
        }
      }
    }

    // FJB + comms cabinet at the island end, on the corridor centerline.
    islandAuxClustersPlaced = 0;
    const gearFits = (cx: number, cy: number, hx: number, hy: number) => {
      if (!rectInsidePolygon(cx, cy, hx, hy, fence, equipmentMargin)) return false;
      const pad = 3;
      for (const e of equipment) {
        const rot = Math.abs(Math.sin(e.rotation)) > 0.5;
        const ehx = (rot ? e.width : e.length) / 2;
        const ehy = (rot ? e.length : e.width) / 2;
        if (Math.abs(cx - e.x) < hx + ehx + pad && Math.abs(cy - e.y) < hy + ehy + pad) return false;
      }
      for (const aisle of frozenAisles) {
        if (Math.abs(cx - aisle.x) < hx + aisle.length / 2 && Math.abs(cy - aisle.y) < hy + aisle.width / 2) return false;
      }
      return true;
    };
    const p2i = (v: number) => String(v).padStart(2, '0');
    // Per-island aux cluster mode (reference PMA-D-B001-2B island detail):
    // aux-equipped island layouts carry the comms cabinet in the mid-island
    // cluster instead of at the strip end, so the strip-end fit check only
    // needs the FJB itself.
    const islandClusterMode = config.hasAuxEquipment;
    // DOCUMENTED CONVENTION (per the Puma reference inset PMA-D-B001): a
    // feeder junction box terminates TWO feeders — one per island side. When
    // the per-feeder PCS cap splits a side into multiple feeders (large
    // islands, e.g. 10 PCS per side -> 2 feeders per side), ONE box is no
    // longer valid: the island gets one FJB per feeder PAIR, the second box
    // placed at the OPPOSITE strip end so each side's split chunks terminate
    // at the box nearest them (see nearest-FJB assignment in feeders.ts).
    // The comms cabinet stays one per island regardless. Islands that would
    // need more than two boxes (side > 2x cap) are warned for manual layout.
    for (const isl of islands) {
      const feedersOnIsland =
        Math.ceil(isl.southIds.length / MAX_INVERTERS_PER_FEEDER) +
        Math.ceil(isl.northIds.length / MAX_INVERTERS_PER_FEEDER);
      const fjbNeeded = Math.max(1, Math.ceil(feedersOnIsland / 2));
      let placedGear = false;
      let primaryDir: 1 | -1 = 1;
      // FJB end preference: with a substation hint, try the strip end FACING
      // the substation first so feeders launch toward the corridor instead of
      // wrapping around the far side of the yard (reference PMA-D-B001-2B:
      // every island drops its feeders out on the substation side). Without a
      // hint keep the historical east-first order (byte-identical layouts).
      const subHint = options.constraints?.substation;
      const dirOrder: readonly (1 | -1)[] =
        subHint && Number.isFinite(subHint.x) && Number.isFinite(subHint.y) &&
        subHint.x < (isl.minX + isl.maxX) / 2
          ? [-1, 1] : [1, -1];
      for (const dir of dirOrder) {
        const edgeX = dir > 0 ? isl.maxX : isl.minX;
        const fjbX = edgeX + dir * (6 + FEEDER_JUNCTION_BOX.length / 2);
        const commsX = fjbX + dir * (FEEDER_JUNCTION_BOX.length / 2 + 3 + COMMS_CABINET.length / 2);
        if (
          gearFits(fjbX, isl.y, FEEDER_JUNCTION_BOX.length / 2, FEEDER_JUNCTION_BOX.width / 2) &&
          (islandClusterMode ||
            gearFits(commsX, isl.y, COMMS_CABINET.length / 2, COMMS_CABINET.width / 2))
        ) {
          equipment.push({
            id: `fjb-${isl.n}`, kind: 'feederJunctionBox',
            label: fjbNeeded > 1 ? `FJB-${p2i(isl.n)}A` : `FJB-${p2i(isl.n)}`,
            x: fjbX, y: isl.y, rotation: 0,
            length: FEEDER_JUNCTION_BOX.length, width: FEEDER_JUNCTION_BOX.width, height: FEEDER_JUNCTION_BOX.height,
          });
          if (!islandClusterMode) {
            equipment.push({
              id: `comms-${isl.n}`, kind: 'commsCabinet', label: `COMMS-${p2i(isl.n)}`,
              x: commsX, y: isl.y, rotation: 0,
              length: COMMS_CABINET.length, width: COMMS_CABINET.width, height: COMMS_CABINET.height,
            });
          }
          placedGear = true;
          primaryDir = dir;
          break;
        }
      }
      if (!placedGear) {
        warnings.push(`Could not place feeder junction box / comms cabinet for island ${isl.n} with required clearances — locate manually in detailed design.`);
        continue;
      }
      if (fjbNeeded > 1) {
        // Second FJB at the opposite strip end (split-side island).
        const dir = (-primaryDir) as 1 | -1;
        const edgeX = dir > 0 ? isl.maxX : isl.minX;
        const fjbX = edgeX + dir * (6 + FEEDER_JUNCTION_BOX.length / 2);
        if (gearFits(fjbX, isl.y, FEEDER_JUNCTION_BOX.length / 2, FEEDER_JUNCTION_BOX.width / 2)) {
          equipment.push({
            id: `fjb-${isl.n}-2`, kind: 'feederJunctionBox', label: `FJB-${p2i(isl.n)}B`,
            x: fjbX, y: isl.y, rotation: 0,
            length: FEEDER_JUNCTION_BOX.length, width: FEEDER_JUNCTION_BOX.width, height: FEEDER_JUNCTION_BOX.height,
          });
        } else {
          warnings.push(`Island ${isl.n} splits into ${feedersOnIsland} feeders (2 per feeder junction box per the reference detail) but a second junction box could not be placed with required clearances — locate it manually in detailed design.`);
        }
        if (fjbNeeded > 2) {
          warnings.push(`Island ${isl.n} needs ${fjbNeeded} feeder junction boxes for ${feedersOnIsland} feeders (2 per box per the reference detail); only 2 strip-end positions are auto-placed — locate the remaining boxes manually in detailed design.`);
        }
      }
    }

    // Per-island aux cluster (reference PMA-D-B001-2B island detail): every
    // island carries its own aux transformer + aux distribution center (IPS
    // switchgear) + comms cabinet at the island MIDPOINT, on the 480V aux &
    // fiber corridor centerline, tucked into the inter-pair gaps nearest the
    // island center. The reference detail shows this gear between the A-3
    // containers of adjacent pair columns inside the 10 ft corridor, so the
    // clearance pad is intentionally tighter (0.5 ft) than yard-level gear.
    // Reject -> warn, never silently relocate (except the comms cabinet,
    // which falls back to its historical strip-end position WITH a warning
    // so the island never loses comms entirely).
    //
    // DOCUMENTED FINDING (task: non-island layouts follow the reference
    // DWGs): all 8 QTY4-style reference DWGs (BWL/CHW/CK1/GP1/GP2/LOCK/MRG/
    // TSO "BESS - xref") show ONE yard-level aux position per site — a
    // single AUXTX / "AUX 100" transformer callout with its switchboard
    // (AUXSWB appears repeatedly only as block-level text). Non-island
    // (QTY4) layouts therefore keep the single gate-side aux pad below.
    if (islandClusterMode) {
      const clusterFits = (cx: number, cy: number, hx: number, hy: number) => {
        if (!rectInsidePolygon(cx, cy, hx, hy, fence, equipmentMargin)) return false;
        const pad = 0.5; // corridor-tight per the reference island detail
        for (const e of equipment) {
          const rot = Math.abs(Math.sin(e.rotation)) > 0.5;
          const ehx = (rot ? e.width : e.length) / 2;
          const ehy = (rot ? e.length : e.width) / 2;
          if (Math.abs(cx - e.x) < hx + ehx + pad && Math.abs(cy - e.y) < hy + ehy + pad) return false;
        }
        for (const aisle of frozenAisles) {
          if (Math.abs(cx - aisle.x) < hx + aisle.length / 2 && Math.abs(cy - aisle.y) < hy + aisle.width / 2) return false;
        }
        return true;
      };
      for (const isl of islands) {
        // Pair-column x's of this island -> candidate inter-pair gap centers.
        // The widened middle gap (CAR-D-B005-1 cluster column) is preferred
        // first; remaining gaps order nearest the island midpoint.
        const xs = Array.from(new Set(
          blockCenters
            .filter(b => Math.abs(b.y - isl.y) < 1 && b.x > isl.minX - 1 && b.x < isl.maxX + 1)
            .map(b => b.x)
        )).sort((a, b) => a - b);
        const mid = (isl.minX + isl.maxX) / 2;
        const gapInfos: { center: number; clear: number }[] = [];
        for (let i = 0; i + 1 < xs.length; i++) {
          gapInfos.push({ center: (xs[i] + xs[i + 1]) / 2, clear: xs[i + 1] - xs[i] });
        }
        gapInfos.sort((a, b) =>
          (b.clear - a.clear > 0.1 || a.clear - b.clear > 0.1)
            ? b.clear - a.clear
            : Math.abs(a.center - mid) - Math.abs(b.center - mid));
        const gaps = gapInfos.map(g => g.center);

        let xfmrPlaced = false;
        let commsPlaced = false;
        let distPlaced = false;
        // Side-of-trench and order per the 90% package conduit & trench plan
        // CAR-D-B005-1 (both islands, AUXSWB15C-03/-04 + AUXTX15C-03/-04):
        //   - AUX DISTRIBUTION CENTER (AUXSWB, long axis N-S) just NORTH of
        //     the 480V aux & fiber corridor, in the widened middle gap;
        //   - AUX TRANSFORMER (AUXTX) just SOUTH of the corridor;
        //   - the comms cabinet (app-level CATL fiber head-end) stacks north
        //     of the distribution center.
        // All pieces sit OUTSIDE the 10 ft corridor band: the corridor
        // centerline is the feeder approach highway (chain-end -> FJB hops
        // ride it end to end), so gear on the centerline would force every
        // passing feeder into a collinear detour sliver. Long axes turn
        // along y so each piece fits the gap column width with the reference
        // 10'-0" clear to the pair columns each side (ISLAND_MIDDLE_CLEAR_FT).
        type ClusterPiece = { id: string; kind: PlacedEquipment['kind']; label: string; dims: { length: number; width: number; height: number }; rot: number; side: 1 | -1 };
        const stack: ClusterPiece[] = [
          { id: `island-aux-dist-${isl.n}`, kind: 'auxSwitchgear', label: 'AUX DIST (IPS)', dims: IPS_SWITCHGEAR, rot: Math.PI / 2, side: 1 },
          { id: `comms-${isl.n}`, kind: 'commsCabinet', label: `COMMS-${p2i(isl.n)}`, dims: COMMS_CABINET, rot: 0, side: 1 },
          { id: `island-aux-xfmr-${isl.n}`, kind: 'auxTransformer', label: 'AUX XFMR (HITACHI)', dims: HITACHI_AUX_XFMR, rot: Math.PI / 2, side: -1 },
        ];
        // Plan half-extents per piece: rot=90 turns the long axis along y.
        const halves = stack.map(s => ({
          hx: (s.rot ? s.dims.width : s.dims.length) / 2,
          hy: (s.rot ? s.dims.length : s.dims.width) / 2,
        }));
        const CORRIDOR_KEEPOUT = AUX_CORRIDOR_FT / 2 + 0.5; // stay clear of the feeder highway
        // Stack y positions honoring each piece's package side of the
        // corridor (mirror = fallback with every side flipped).
        const stackPositions = (mirror: 1 | -1): number[] => {
          const edge: Record<1 | -1, number> = { 1: isl.y + CORRIDOR_KEEPOUT, [-1]: isl.y - CORRIDOR_KEEPOUT };
          return stack.map((s, i) => {
            const side = (s.side * mirror) as 1 | -1;
            const yc = edge[side] + side * halves[i].hy;
            edge[side] += side * (halves[i].hy * 2 + 2);
            return yc;
          });
        };
        outer402:
        for (const gx of gaps) {
          for (const mirror of [1, -1] as const) {
            const ys = stackPositions(mirror);
            if (stack.every((_, i) => clusterFits(gx, ys[i], halves[i].hx, halves[i].hy))) {
              stack.forEach((s, i) => equipment.push({
                id: s.id, kind: s.kind, label: s.label,
                x: gx, y: ys[i], rotation: s.rot,
                length: s.dims.length, width: s.dims.width, height: s.dims.height,
              }));
              xfmrPlaced = commsPlaced = distPlaced = true;
              if (mirror === -1) {
                warnings.push(`Island ${isl.n} aux cluster: the package sides (aux distribution north of the corridor, transformer south — CAR-D-B005-1) did not fit; the cluster was mirrored across the corridor.`);
              }
              break outer402;
            }
          }
        }
        if (!xfmrPlaced) {
          // Partial fallback: place whatever pieces fit, each in the best
          // gap/side position scanning outward from the corridor; comms falls
          // back to the strip end below. Warned either way.
          const placeOne = (i: number): boolean => {
            for (const gx of gaps) {
              for (const side of [stack[i].side, -stack[i].side as 1 | -1]) {
                let edge = isl.y + side * CORRIDOR_KEEPOUT;
                for (let slot = 0; slot < 3; slot++) {
                  const yc = edge + side * halves[i].hy;
                  if (clusterFits(gx, yc, halves[i].hx, halves[i].hy)) {
                    const s = stack[i];
                    equipment.push({
                      id: s.id, kind: s.kind, label: s.label,
                      x: gx, y: yc, rotation: s.rot,
                      length: s.dims.length, width: s.dims.width, height: s.dims.height,
                    });
                    return true;
                  }
                  edge += side * (halves[i].hy * 2 + 2);
                }
              }
            }
            return false;
          };
          distPlaced = placeOne(0);
          commsPlaced = placeOne(1);
          xfmrPlaced = placeOne(2);
        }
        if (!commsPlaced) {
          // Strip-end fallback beside the FJB (historical position) so the
          // island never loses its comms cabinet; warned below.
          const fjb = equipment.find(e => e.id === `fjb-${isl.n}`);
          if (fjb) {
            const dir: 1 | -1 = fjb.x >= mid ? 1 : -1;
            const commsX = fjb.x + dir * (FEEDER_JUNCTION_BOX.length / 2 + 3 + COMMS_CABINET.length / 2);
            if (gearFits(commsX, isl.y, COMMS_CABINET.length / 2, COMMS_CABINET.width / 2)) {
              equipment.push({
                id: `comms-${isl.n}`, kind: 'commsCabinet', label: `COMMS-${p2i(isl.n)}`,
                x: commsX, y: isl.y, rotation: 0,
                length: COMMS_CABINET.length, width: COMMS_CABINET.width, height: COMMS_CABINET.height,
              });
              commsPlaced = true;
              warnings.push(`Island ${isl.n} aux cluster: comms cabinet did not fit the island center gaps — placed at the strip end beside the feeder junction box instead.`);
            }
          }
        }
        // Reference-clearance audit (CAR-D-B005-1 / task requirement): when a
        // cluster piece landed in a gap NARROWER than the widened middle gap
        // (contiguous fallback on constrained parcels), it cannot keep the
        // 10'-0" clear each side — warn explicitly, never silently degrade.
        {
          const reqCenterDist = fp.width + 2 * ISLAND_MIDDLE_CLEAR_FT + Math.max(
            HITACHI_AUX_XFMR.width, IPS_SWITCHGEAR.width, COMMS_CABINET.length);
          const placedGxs = new Set(
            equipment
              .filter(e => stack.some(s => s.id === e.id) && e.x > isl.minX - 1 && e.x < isl.maxX + 1)
              .map(e => e.x)
          );
          const short = Array.from(placedGxs).some(gx => {
            const gi = gapInfos.find(g => Math.abs(g.center - gx) < 0.1);
            return gi !== undefined && gi.clear < reqCenterDist - 0.05;
          });
          if (short) {
            warnings.push(`Island ${isl.n} aux cluster: the middle gap could not be widened on this parcel — cluster clearances are below the reference 10 ft each side (CAR-D-B005-1).`);
          }
        }
        if (xfmrPlaced) islandAuxClustersPlaced++;
        const missing: string[] = [];
        if (!xfmrPlaced) missing.push('aux transformer');
        if (!distPlaced) missing.push('aux distribution center');
        if (!commsPlaced) missing.push('comms cabinet');
        if (missing.length) {
          warnings.push(`Island ${isl.n} aux cluster: ${missing.join(', ')} could not be placed in the island center gaps with required clearances — locate manually in detailed design.`);
        }
      }
    }
  }

  // ---- Append accepted drag-placed islands ---------------------------------
  // After every auto island pass (metadata, FJB, aux clusters) so the auto
  // passes never see half-numbered placed gear, and before reserved zones /
  // roads / cables so all downstream consumers treat placed islands like any
  // other island. Placed blocks are numbered after the auto blocks and are
  // intentionally NOT in blockCenters/blockRows — row/aisle/block moves and
  // island metadata never touch them.
  const placedZoneSeeds: ReservedZone[] = [];
  const placedFutureSeeds: PlacedEquipment[] = [];
  const placedAccessRects: { id: string; x: number; y: number; hx: number; hy: number }[] = [];
  if (acceptedPlaced.length) {
    if (islands === null) islands = [];
    let nextIslandN = islands.length ? Math.max(...islands.map(i => i.n)) + 1 : 1;
    let nextBlockN = blockIdx + 1;
    for (const a of acceptedPlaced) {
      const comp = composePlacedIsland(a.spec, config, pcsClearance, nextIslandN, nextBlockN,
        options.constraints?.islandAugEnd?.[a.spec.id] === 'east' ? 'east' : 'west');
      equipment.push(...comp.equipment);
      islands.push(comp.info);
      placedZoneSeeds.push(...comp.zones);
      placedFutureSeeds.push(...comp.futureEquipment);
      placedAccessRects.push({ id: a.spec.id, ...comp.bbox });
      // A core-only placement composes no cluster, so it must not count as one
      // — otherwise a yard made entirely of core-only islands would suppress
      // the yard-level aux pad fallback below and end up with no aux gear at
      // all that nobody asked to remove.
      if (config.hasAuxEquipment && placedIslandHasAuxCluster(a.spec)) islandAuxClustersPlaced++;
      nextIslandN++;
      nextBlockN += comp.blockNs.length;
      blockIdx += comp.blockNs.length;
    }
  }

  // Traced / hand-placed single equipment (KMZ auto-fill + manual aux gear).
  // Reference-wins model: every item lands EXACTLY at its spec pose with its
  // drawn dimensions. Fence-clearance and overlap conflicts surface as
  // warnings ("Placed equipment <id> placed with warning:") — the geometry is
  // never moved or dropped. Only non-finite specs reject. Drafter nudges
  // (equipMoves/equipRots) apply later through the standard shared pass, so
  // placed gear moves and rotates exactly like automatic equipment.
  // Catalog-driven manual specs are NOT composed here — they carry no drawn
  // dimensions and are validated (reject-and-roll-back, not warn) further
  // down, after the deferred deletions.
  const placedEquipSpecs = (options.constraints?.placedEquipment ?? [])
    .filter((s): s is TracedEquipmentSpec => !isManualEquipmentSpec(s));
  if (placedEquipSpecs.length) {
    const labelFor = (k: EquipmentKind): string => ({
      bess: 'BESS', inverter: 'PCS', generator: 'GEN',
      auxTransformer: 'AUX XFMR', auxSwitchgear: 'AUX SWGR', auxSwitchPanel: 'AUX PANEL',
      fiberPatchPanel: 'FIBER PANEL', fireControlPanel: 'FIRE PANEL',
      feederJunctionBox: 'FJB', commsCabinet: 'COMMS CAB', conex: 'CONEX', manhole: 'MANHOLE',
      mainTransformer: 'MAIN XFMR', mvSwitchgear: 'MV SWGR',
      controlHouse: 'CONTROL HOUSE', substationFeeder: 'FEEDER',
    } as Record<EquipmentKind, string>)[k] ?? k.toUpperCase();
    for (const spec of placedEquipSpecs) {
      if (![spec.x, spec.y, spec.lengthFt, spec.widthFt].every(v => Number.isFinite(v)) ||
          spec.lengthFt <= 0 || spec.widthFt <= 0) {
        warnings.push(`Placed equipment ${spec.id} rejected: invalid position or size — remove it in the layout edits panel.`);
        continue;
      }
      const rotDeg = Number.isFinite(spec.rotationDeg) ? (spec.rotationDeg as number) : 0;
      const rad = (rotDeg * Math.PI) / 180;
      const item: PlacedEquipment = {
        id: spec.id,
        kind: spec.kind,
        label: spec.label || labelFor(spec.kind),
        x: spec.x, y: spec.y,
        rotation: rad,
        length: spec.lengthFt,
        width: spec.widthFt,
        height: Number.isFinite(spec.heightFt) && (spec.heightFt as number) > 0 ? (spec.heightFt as number) : 8,
        ...(spec.traceSourcePose ? {
          traceSourcePose: {
            x: spec.traceSourcePose.x,
            y: spec.traceSourcePose.y,
            rotation: spec.traceSourcePose.rotationDeg * Math.PI / 180,
            length: spec.traceSourcePose.lengthFt,
            width: spec.traceSourcePose.widthFt,
          },
        } : {}),
        // Augmentation reserve units (AUG PCS / AUG BATT from the KMZ scan)
        // keep their flag on the entity so feeder grouping can treat them as
        // future capacity instead of built load.
        ...(spec.augmented ? { augmented: true } : {}),
        ...(spec.future ? { future: true } : {}),
      };
      // Warn-only validation. Rotated corners against the fence line…
      const c = Math.cos(rad), s = Math.sin(rad);
      const hl = spec.lengthFt / 2, hw = spec.widthFt / 2;
      const corners: Pt[] = [
        { x: spec.x + c * hl - s * hw, y: spec.y + s * hl + c * hw },
        { x: spec.x + c * hl + s * hw, y: spec.y + s * hl - c * hw },
        { x: spec.x - c * hl - s * hw, y: spec.y - s * hl + c * hw },
        { x: spec.x - c * hl + s * hw, y: spec.y - s * hl - c * hw },
      ];
      if (corners.some(p => !pointInPolygon(p, fence))) {
        warnings.push(`Placed equipment ${spec.id} placed with warning: the ${item.label} extends outside the fence line at its drawn position — the reference geometry was kept as drawn; review the fence or move it.`);
      }
      // …and axis-aligned extents against everything already placed.
      const minX = Math.min(...corners.map(p => p.x)), maxX = Math.max(...corners.map(p => p.x));
      const minY = Math.min(...corners.map(p => p.y)), maxY = Math.max(...corners.map(p => p.y));
      const clash = equipment.find(e => {
        const h = equipHalves(e);
        return e.x - h.hx < maxX && e.x + h.hx > minX && e.y - h.hy < maxY && e.y + h.hy > minY;
      });
      if (clash) {
        warnings.push(`Placed equipment ${spec.id} placed with warning: the ${item.label} overlaps ${clash.id} — the reference geometry was kept as drawn; review the two footprints.`);
      }
      equipment.push(item);
    }
    // Traced PCS facing: the drawing's inverter outlines are plain
    // rectangles, so the fitted rotation is mod-180° ambiguous and carries
    // no connection-face truth on its own. Derive each traced PCS's
    // container-facing side from the containers drawn around it (nearest-PCS
    // association, mean offset in the PCS's local frame) and record it as
    // doorEnd — pcsCompartments, the cable fan and the symbol flip all read
    // it. Computed at generate time so stale saves self-heal without
    // rewriting stored edits; drafter nudges still apply on top.
    {
      const tracedInvs = placedEquipSpecs.filter(s2 => s2.kind === 'inverter');
      const tracedBess = placedEquipSpecs.filter(s2 => s2.kind === 'bess' && !s2.augmented && !s2.future);
      if (tracedInvs.length && tracedBess.length) {
        const byId = new Map(equipment.map(e => [e.id, e] as const));
        for (const spec of tracedInvs) {
          const item = byId.get(spec.id);
          if (!item || item.doorEnd) continue;
          const rad = ((Number.isFinite(spec.rotationDeg) ? spec.rotationDeg as number : 0) * Math.PI) / 180;
          const c2 = Math.cos(rad), s2 = Math.sin(rad);
          let sumLy = 0, n = 0;
          for (const cSpec of tracedBess) {
            const nearest = tracedInvs.reduce((best, o) =>
              Math.hypot(o.x - cSpec.x, o.y - cSpec.y) < Math.hypot(best.x - cSpec.x, best.y - cSpec.y) ? o : best);
            if (nearest.id !== spec.id) continue;
            const dx = cSpec.x - spec.x, dy = cSpec.y - spec.y;
            sumLy += -dx * s2 + dy * c2; // container side in the PCS local frame
            n++;
          }
          if (!n || Math.abs(sumLy / n) < 3) continue;
          // doorEnd feeds pcsCompartments' f: for near-horizontal equipment f
          // multiplies the WORLD y axis, for vertical it acts in the rotated
          // frame — fold the cos sign so the stored value faces the
          // containers under either formula.
          const localSide = sumLy >= 0 ? 1 : -1;
          const worldFlip = Math.abs(s2) <= 0.5 && c2 < 0 ? -1 : 1;
          item.doorEnd = (localSide * worldFlip) as 1 | -1;
        }
      }
    }
  }

  // Aux equipment near gate (south side of yard) for configs that include it.
  // Placement is validated against fence clearances; searches upward/sideways
  // for a valid spot. Island (QTY3) layouts with per-island aux clusters skip
  // this yard-level pad — the reference standard puts aux gear mid-island; the
  // pad remains only for non-island layouts (per the 8 reference DWGs) and as
  // a fallback when no island cluster could be placed at all (warned above).
  if (config.hasAuxEquipment && autoBlocksPlaced > 0 && islandAuxClustersPlaced === 0) {
    const bessOnly = equipment.filter(e => e.kind === 'bess' || e.kind === 'inverter');
    const firstBlockY = Math.min(...bessOnly.map(e => e.y));
    const yardCenterX = bessOnly.reduce((s, e) => s + e.x, 0) / bessOnly.length;

    const auxHalfW = 18; // half-width of the combined aux pad (xfmr + swgr side by side)
    const auxHalfD = Math.max(HITACHI_AUX_XFMR.width, IPS_SWITCHGEAR.width) / 2 + 2;
    const eqMinX = Math.min(...bessOnly.map(e => e.x));
    const eqMaxX = Math.max(...bessOnly.map(e => e.x));
    const eqMinY = Math.min(...bessOnly.map(e => e.y));
    const eqMaxY = Math.max(...bessOnly.map(e => e.y));

    const candidates: { x: number; y: number }[] = [];
    // South of the first row
    for (const dy of [15, 25, 40, 60, 80]) {
      for (const dx of [0, 40, -40, 80, -80, 120, -120]) {
        candidates.push({ x: yardCenterX + dx, y: firstBlockY - LG_JF2.length / 2 - dy });
      }
    }
    // Beside the yard (east / west), at several heights
    for (const yy of [eqMinY, (eqMinY + eqMaxY) / 2, eqMaxY]) {
      for (const off of [30, 45, 60]) {
        candidates.push({ x: eqMaxX + off, y: yy });
        candidates.push({ x: eqMinX - off, y: yy });
      }
    }
    // North of the yard
    for (const dy of [25, 45, 65]) {
      candidates.push({ x: yardCenterX, y: eqMaxY + dy });
    }

    const clearOfEverything = (cx: number, cy: number) => {
      const pad = 5; // ft separation from other equipment/zones
      for (const e of equipment) {
        const rot = Math.abs(Math.sin(e.rotation)) > 0.5;
        const ehx = (rot ? e.width : e.length) / 2;
        const ehy = (rot ? e.length : e.width) / 2;
        if (Math.abs(cx - e.x) < auxHalfW + ehx + pad && Math.abs(cy - e.y) < auxHalfD + ehy + pad) return false;
      }
      for (const z of augmentationZones) {
        if (Math.abs(cx - z.x) < auxHalfW + z.length / 2 + pad && Math.abs(cy - z.y) < auxHalfD + z.width / 2 + pad) return false;
      }
      return true;
    };

    // Frozen drive aisle strips (same ones buildRoads reproduces) so the aux
    // pad never lands on a road; compact layouts have no aisles
    const overlapsAisle = (cx: number, cy: number) =>
      frozenAisles.some(aisle =>
        Math.abs(cx - aisle.x) < auxHalfW + aisle.length / 2 &&
        Math.abs(cy - aisle.y) < auxHalfD + aisle.width / 2
      );

    let auxPos: { x: number; y: number } | null = null;
    for (const c of candidates) {
      if (
        rectInsidePolygon(c.x, c.y, auxHalfW, auxHalfD, fence, equipmentMargin) &&
        clearOfEverything(c.x, c.y) &&
        !overlapsAisle(c.x, c.y)
      ) {
        auxPos = c;
        break;
      }
    }

    if (auxPos) {
      equipment.push({
        id: 'aux-xfmr', kind: 'auxTransformer', label: 'AUX XFMR (HITACHI)',
        x: auxPos.x - 15, y: auxPos.y, rotation: 0,
        length: HITACHI_AUX_XFMR.length, width: HITACHI_AUX_XFMR.width, height: HITACHI_AUX_XFMR.height,
      });
      equipment.push({
        id: 'aux-swgr', kind: 'auxSwitchgear', label: 'AUX SWGR (IPS)',
        x: auxPos.x + 15, y: auxPos.y, rotation: 0,
        length: IPS_SWITCHGEAR.length, width: IPS_SWITCHGEAR.width, height: IPS_SWITCHGEAR.height,
      });
    } else {
      warnings.push('Could not place aux transformer/switchgear with required fence clearance — locate manually in detailed design.');
    }
  }

  // Small panels per Sheets 3-4: auxiliary switch panel, fire control panel,
  // fiber patch panel — placed near the aux cluster (or south of the yard) and
  // validated with the same fence/equipment clearance rules as everything else.
  // Gated on AUTO blocks: drafter-placed islands must never drag in site-level
  // panels (FACP/fiber/aux switch) the drafter did not ask for.
  if (autoBlocksPlaced > 0) {
    const bessOnly = equipment.filter(e => e.kind === 'bess' || e.kind === 'inverter');
    const firstBlockY = Math.min(...bessOnly.map(e => e.y));
    const yardCenterX = bessOnly.reduce((s, e) => s + e.x, 0) / bessOnly.length;
    const auxEq = equipment.filter(e => e.kind === 'auxTransformer' || e.kind === 'auxSwitchgear');
    const anchorX = auxEq.length ? auxEq.reduce((s, e) => s + e.x, 0) / auxEq.length : yardCenterX;
    const anchorY = auxEq.length
      ? Math.min(...auxEq.map(e => e.y))
      : firstBlockY - LG_JF2.length / 2 - 20;

    const aisleStrips = frozenAisles;

    // Aug-unit end-ladder keep-outs at both ends of every island (QTY3 only;
    // the legacy grid has no islands so this list is empty and placement is
    // unchanged). The strip covers the slots the island-aug pass scans later
    // (count + 2 slots of gap + unit width), at the island's corridor y.
    const islandEndKeepOuts: { x1: number; x2: number; y1: number; y2: number }[] = [];
    if (islands && islands.length) {
      const augFpK = augUnitFootprint(config, pcsClearance);
      const endGapK = pairBlockGapFt(pcsClearance);
      const ladder = 4 * (endGapK + augFpK.width); // count(<=2) + 2 slots
      const halfD = augFpK.depth / 2 + 5;
      for (const isl of islands) {
        if (isl.vertical) {
          // Axis-swapped: y holds world-X, minX/maxX are world-Y extents.
          islandEndKeepOuts.push(
            { x1: isl.y - halfD, x2: isl.y + halfD, y1: isl.minX - ladder, y2: isl.minX },
            { x1: isl.y - halfD, x2: isl.y + halfD, y1: isl.maxX, y2: isl.maxX + ladder });
        } else {
          islandEndKeepOuts.push(
            { x1: isl.minX - ladder, x2: isl.minX, y1: isl.y - halfD, y2: isl.y + halfD },
            { x1: isl.maxX, x2: isl.maxX + ladder, y1: isl.y - halfD, y2: isl.y + halfD });
        }
      }
    }

    const panelSpecs: { id: string; kind: PlacedEquipment['kind']; label: string; dims: typeof AUX_SWITCH_PANEL; dx: number }[] = [
      { id: 'aux-panel', kind: 'auxSwitchPanel', label: 'AUX SWITCH PANEL', dims: AUX_SWITCH_PANEL, dx: -12 },
      { id: 'fire-panel', kind: 'fireControlPanel', label: 'FIRE CONTROL PANEL', dims: FIRE_CONTROL_PANEL, dx: 0 },
      { id: 'fiber-panel', kind: 'fiberPatchPanel', label: 'FIBER PATCH PANEL', dims: FIBER_PATCH_PANEL, dx: 12 },
    ];

    const panelFits = (cx: number, cy: number, hx: number, hy: number, margin: number) => {
      if (!rectInsidePolygon(cx, cy, hx, hy, fence, margin)) return false;
      const pad = 4;
      for (const e of equipment) {
        // Container/PCS cable fans (DC corridors, LVAC risers) run vertical
        // legs just off the container SIDES — keep the yard panels a wider
        // berth in x around bess/PCS or LVAC runs clip the panel rects.
        const padX = e.kind === 'bess' || e.kind === 'inverter' ? 16 : 4;
        const pad = 4;
        const rot = Math.abs(Math.sin(e.rotation)) > 0.5;
        const ehx = (rot ? e.width : e.length) / 2;
        const ehy = (rot ? e.length : e.width) / 2;
        if (Math.abs(cx - e.x) < hx + ehx + padX && Math.abs(cy - e.y) < hy + ehy + pad) return false;
      }
      for (const z of augmentationZones) {
        if (Math.abs(cx - z.x) < hx + z.length / 2 + pad && Math.abs(cy - z.y) < hy + z.width / 2 + pad) return false;
      }
      for (const aisle of aisleStrips) {
        if (Math.abs(cx - aisle.x) < hx + aisle.length / 2 && Math.abs(cy - aisle.y) < hy + aisle.width / 2 + 3) return false;
      }
      // Island (QTY3) layouts place augmentation units at their island ENDS
      // later. A panel dropped in that end ladder silently blocks the aug
      // group, forcing the rescue to shift the whole island (and breaking
      // stacked-island alignment), so keep the panel cluster out of a strip
      // at both ends of every island.
      for (const ko of islandEndKeepOuts) {
        if (cx > ko.x1 - hx && cx < ko.x2 + hx && cy > ko.y1 - hy && cy < ko.y2 + hy) return false;
      }
      return true;
    };

    // Panels place as one CLUSTER at a shared offset: their tie cables
    // (fiber-fcp-tie, lvac-panel-tie) draw straight legs between them, so
    // scattering the panels to independent spots sweeps those ties across
    // container rows. One offset where every panel fits keeps ties short.
    // Fallback margin must still keep panels off the perimeter road band in
    // road layouts (frontToFence alone would drop them onto the road ring).
    const fallbackMargin = compact
      ? CLEARANCES.frontToFence
      : CLEARANCES.frontToFence + CLEARANCES.roadWidth;
    let placedCluster = false;
    outerPanel:
    for (const margin of [equipmentMargin, fallbackMargin]) {
      for (const dy of [-14, -22, -30, 14, 22, -40, 30, 38, 46, -48, -56, 54, 62, -64, 70]) {
        for (const dxx of [0, 18, -18, 36, -36, 54, -54, 72, -72, 90, -90, 108, -108, 126, -126]) {
          const fitsAll = panelSpecs.every(spec => panelFits(
            anchorX + spec.dx + dxx, anchorY + dy,
            spec.dims.length / 2, spec.dims.width / 2, margin));
          if (fitsAll) {
            for (const spec of panelSpecs) {
              equipment.push({
                id: spec.id, kind: spec.kind, label: spec.label,
                x: anchorX + spec.dx + dxx, y: anchorY + dy, rotation: 0,
                length: spec.dims.length, width: spec.dims.width, height: spec.dims.height,
              });
            }
            placedCluster = true;
            break outerPanel;
          }
        }
      }
    }
    if (!placedCluster) {
      // Cluster found no shared spot: place each panel independently (old
      // behaviour) so nothing silently disappears; warn on any leftover.
      for (const spec of panelSpecs) {
        const hx = spec.dims.length / 2, hy = spec.dims.width / 2;
        let placedPanel = false;
        outerSingle:
        for (const margin of [equipmentMargin, fallbackMargin]) {
          for (const dy of [-14, -22, -30, 14, 22, -40, 30, 38, 46, -48, -56, 54, 62, -64, 70]) {
            for (const dxx of [0, 18, -18, 36, -36, 54, -54, 72, -72, 90, -90, 108, -108, 126, -126]) {
              const cx = anchorX + spec.dx + dxx;
              const cy = anchorY + dy;
              if (panelFits(cx, cy, hx, hy, margin)) {
                equipment.push({
                  id: spec.id, kind: spec.kind, label: spec.label,
                  x: cx, y: cy, rotation: 0,
                  length: spec.dims.length, width: spec.dims.width, height: spec.dims.height,
                });
                placedPanel = true;
                break outerSingle;
              }
            }
          }
        }
        if (!placedPanel) {
          warnings.push(`Could not place ${spec.label.toLowerCase()} with required clearances — locate manually in detailed design.`);
        }
      }
    }
  }

  // ---- deferred equipment deletions (aux gear, panels, island cabinets) ----
  // These items only exist now, so the removals recorded above are applied
  // here — before reserved zones, moves, feeders, cables, capacity and the BOM
  // derive from the equipment list. Ids that still match nothing are genuinely
  // absent and go dormant, exactly like an unmatched block.
  if (deferredEquipRemoval.size) {
    const keptAfterDefer: PlacedEquipment[] = [];
    const deferRemoved = new Set<string>();
    for (const e of equipment) {
      if (deferredEquipRemoval.has(e.id)) { deferRemoved.add(e.id); continue; }
      keptAfterDefer.push(e);
    }
    equipment.length = 0;
    equipment.push(...keptAfterDefer);
    for (const id of Array.from(deferRemoved)) {
      if (/^bess-/.test(id)) looseContainersRemoved++;
    }
    for (const id of Array.from(deferredEquipRemoval)) {
      if (!deferRemoved.has(id)) {
        warnings.push(
          `Equipment ${id} deletion is dormant: this layout has no ${id} — ` +
          'the deletion revives if that item returns.'
        );
      }
    }
  }

  // ---- individually placed auxiliary / comms / panel gear ------------------
  // The engineer's own placements, composed after every automatic pass (so
  // they can never renumber or displace generated gear) and BEFORE reserved
  // areas, roads, cables, capacity and the BOM — every downstream consumer
  // sees them as ordinary equipment. Placed after the deferred deletions so a
  // stale removedEquipment id can never silently eat a manual placement:
  // deleting a manual item removes its spec instead.
  {
    // Only the catalog-driven records; items with drawn dimensions (KMZ
    // auto-fill and catalog-dimension gear drops) were composed earlier under
    // the reference-wins contract.
    const manualSpecs = (options.constraints?.placedEquipment ?? [])
      .filter(isManualEquipmentSpec);
    if (manualSpecs.length) {
      const pins = manualEquipmentPins(options.constraints ?? {}, config, pcsClearance);
      const manualMargin = compact
        ? CLEARANCES.frontToFence
        : CLEARANCES.frontToFence + CLEARANCES.roadWidth + CLEARANCES.equipmentToRoadEdge;
      // COMMS-<nn> numbering continues past the cabinets the islands already
      // placed so two cabinets never print the same reference tag.
      let commsSeq = equipment.filter(e => e.kind === 'commsCabinet').length;
      const seen = new Set<string>();
      for (const spec of manualSpecs) {
        if (seen.has(spec.id)) continue;
        seen.add(spec.id);
        const ev = evaluatePlacedEquipmentDrop(
          spec, equipment, augmentationZones, pins, fence, frozenAisles, manualMargin);
        if (ev.hard) {
          warnings.push(
            `Placed equipment ${spec.id} rejected: ${ev.hard} — move or remove it in the layout edits panel.`);
          continue;
        }
        for (const w of ev.soft) {
          warnings.push(
            `Placed equipment ${spec.id} placed with warning: ${w} — review or move it in the layout edits panel.`);
        }
        if (spec.type === 'commsCabinet') commsSeq++;
        equipment.push(composePlacedEquipment(spec, commsSeq));
      }
    }
  }

  // ---- Reserved areas: construction laydown + future augmentation blocks ----
  // Placed BEFORE single-equipment moves so those moves can be validated
  // against the real reserved rectangles (pinned and auto alike).
  const { reservedZones, reserveSummary, reserveWarnings, futureEquipment } = placeReservedZones(
    boundary, fence, equipment, augmentationZones, rows, fp, config,
    equipmentMargin, compact, rowEditGeom,
    options.laydownPct ?? 0, options.augmentPct ?? 0, blocksPlaced,
    options.constraints?.laydownPin ?? null,
    options.constraints?.laydownSize ?? null,
    options.constraints?.augPins ?? null,
    aisleOffsets,
    pcsClearance,
    islands,
    options.futurePhaseUnits ?? 0,
    options.constraints?.islandAugUnits ?? null,
    options.constraints?.islandAugEnd ?? null,
    augPinsBlockedByIslands,
    placedZoneSeeds,
    placedFutureSeeds,
    bandInset
  );
  warnings.push(...reserveWarnings);

  // Automatic middle road(s) between island groups sharing a strip row —
  // computed AFTER all equipment/aug/reserved placement so adding a road can
  // never evict or reject anything that fits today (no clear lane => no road).
  // Placed islands are excluded: their corridor axis may be vertical and
  // their access roads come from the dedicated buildRoads carve instead.
  const autoIslandsForAisles = (islands ?? []).filter(i => !i.placed);
  const corridorAisles = (!compact && autoIslandsForAisles.length >= 2)
    ? computeCorridorAisles(autoIslandsForAisles, equipment, augmentationZones, reservedZones, fence, bandInset)
    : [];

  // ---- drafter single-equipment moves (layout constraints) ------------------
  // One item translated by (dx, dy) from its current (post block/row move or
  // auto) position. Applied after aux gear, panels and reserved zones exist so
  // any item is addressable and reserved-area collisions are enforced;
  // validated by the same shared check the preview ghost uses. The aux
  // transformer/switchgear cluster stays fixed in this phase (task scope).
  const equipMoves = options.constraints?.equipMoves ?? {};
  for (const [id, mv] of Object.entries(equipMoves)) {
    const eq = equipment.find(e => e.id === id);
    if (!eq || (!mv.dx && !mv.dy)) continue;
    // Only the AUTOMATIC aux cluster is frozen. Gear the engineer placed by
    // hand is theirs to move — its position lives in its own spec, so it never
    // reaches this pass in practice, but the guard must not claim otherwise.
    if ((eq.kind === 'auxTransformer' || eq.kind === 'auxSwitchgear') && !isManualEquipmentId(id)) {
      warnings.push(`Equipment ${id} move rejected: the aux transformer/switchgear cluster stays fixed in this design phase — automatic position kept.`);
      continue;
    }
    const otherEquip = equipment.filter(e => e.id !== id);
    const reason = validateEquipmentShift(
      eq, otherEquip, augmentationZones, reservedZones, fence, boundary.polygon,
      nfpaSetback, mv.dx, mv.dy, [...frozenAisles, ...corridorAisles], equipmentMargin
    );
    if (reason) {
      if (forcedEdits.has(`equip-${id}`)) {
        warnings.push(`Equipment ${id} moved with engineer override despite: ${reason} — verify clearances in detailed design.`);
      } else {
        warnings.push(`Equipment ${id} move rejected: ${reason} — automatic position kept.`);
        continue;
      }
    }
    eq.x += mv.dx;
    eq.y += mv.dy;
  }

  // ---- drafter single-equipment rotations (layout constraints) --------------
  // One item turned in 90° clockwise steps about its OWN center, applied after
  // equipMoves so a moved item rotates where it now sits. Validated by the
  // same shared check a move uses, on the rotated clone (so its swapped plan
  // extents are what gets measured). The aux transformer/switchgear cluster
  // stays fixed in this design phase, matching the move rule above.
  const equipRots = options.constraints?.equipRots ?? {};
  for (const [id, turnsRaw] of Object.entries(equipRots)) {
    const turns = normalizeQuarterTurns(turnsRaw);
    if (!turns) continue;
    const eq = equipment.find(e => e.id === id);
    if (!eq) continue;
    if ((eq.kind === 'auxTransformer' || eq.kind === 'auxSwitchgear') && !isManualEquipmentId(id)) {
      warnings.push(`Equipment ${id} rotation rejected: the aux transformer/switchgear cluster stays fixed in this design phase — automatic orientation kept.`);
      continue;
    }
    const rotated = rotateEquipmentAbout(eq, eq.x, eq.y, turns);
    const reason = validateEquipmentShift(
      rotated, equipment.filter(e => e.id !== id), augmentationZones, reservedZones,
      fence, boundary.polygon, nfpaSetback, 0, 0,
      [...frozenAisles, ...corridorAisles], equipmentMargin
    );
    if (reason) {
      if (forcedEdits.has(`equip-rot-${id}`)) {
        warnings.push(`Equipment ${id} rotated with engineer override despite: ${reason} — verify clearances in detailed design.`);
      } else {
        warnings.push(`Equipment ${id} rotation rejected: ${reason} — automatic orientation kept.`);
        continue;
      }
    }
    eq.rotation = rotated.rotation;
  }

  // ---- drafter block rotations (layout constraints) -------------------------
  // One whole block (its PCS + containers) turned in 90° clockwise steps about
  // its own footprint center, composing on top of any row/aisle/block move.
  // Every member is re-validated with its ROTATED extents against everything
  // outside the block; the rotation is all-or-nothing so a block can never be
  // left half-turned.
  // Rotating a whole island asks for several blocks at once, so every
  // requested turn is STAGED before anything is validated: each member is
  // then checked against the complete candidate geometry (all other staged
  // turns already applied), never against a half-turned island. Validating
  // as we went made the verdict depend on iteration order — an early block
  // was measured against its peers' OLD footprints and a legitimate whole-
  // island turn could be rejected by a neighbour that the same turn moves
  // out of the way.
  const blockRots = options.constraints?.blockRots ?? {};
  type StagedRot = {
    n: number;
    members: typeof equipment;
    rotated: typeof equipment;
    forced: boolean;
    reason: string | null;
  };
  const stagedRots: StagedRot[] = [];
  for (const [key, turnsRaw] of Object.entries(blockRots)) {
    const n = Number(key);
    const turns = normalizeQuarterTurns(turnsRaw);
    if (!turns) continue;
    const members = equipment.filter(e => {
      const m = e.id.match(/^(?:bess|inv)-(\d+)/);
      return !!m && Number(m[1]) === n;
    });
    if (!members.length) continue;
    // Pivot: the automatic pad center when the block is one of the scanned
    // blocks, otherwise the block's own plan-extent center. Drag-placed
    // blocks (including single PCS modules) are deliberately NOT in
    // blockCenters, so without the fallback their rotation silently did
    // nothing — accepted by validation, absent from the geometry.
    const known = blockCenters.find(b => b.n === n);
    let blk: { x: number; y: number };
    if (known) blk = { x: known.x, y: known.y };
    else {
      let mnX = Infinity, mxX = -Infinity, mnY = Infinity, mxY = -Infinity;
      for (const e of members) {
        const rot = Math.abs(Math.sin(e.rotation)) > 0.5;
        const hx = (rot ? e.width : e.length) / 2, hy = (rot ? e.length : e.width) / 2;
        mnX = Math.min(mnX, e.x - hx); mxX = Math.max(mxX, e.x + hx);
        mnY = Math.min(mnY, e.y - hy); mxY = Math.max(mxY, e.y + hy);
      }
      blk = { x: (mnX + mxX) / 2, y: (mnY + mxY) / 2 };
    }
    stagedRots.push({
      n,
      members,
      rotated: members.map(e => rotateEquipmentAbout(e, blk.x, blk.y, turns)),
      forced: forcedEdits.has(`block-rot-${n}`),
      reason: null,
    });
  }
  if (stagedRots.length) {
    // Ascending block order so the warning list is deterministic.
    stagedRots.sort((a, b) => a.n - b.n);
    const live = resolveStagedRotations(
      stagedRots, equipment,
      (item, others) => validateEquipmentShift(
        item, others,
        augmentationZones, reservedZones, fence, boundary.polygon,
        nfpaSetback, 0, 0, [...frozenAisles, ...corridorAisles], equipmentMargin
      ));
    for (const s of stagedRots) {
      if (!live.has(s.n)) {
        warnings.push(`Block ${s.n} rotation rejected: ${s.reason} — automatic orientation kept.`);
        continue;
      }
      if (s.reason) {
        warnings.push(`Block ${s.n} rotated with engineer override despite: ${s.reason} — verify clearances in detailed design.`);
      }
      s.members.forEach((e, i) => {
        e.x = s.rotated[i].x; e.y = s.rotated[i].y; e.rotation = s.rotated[i].rotation;
      });
    }
  }

  // Dead-space trim (drafter-selectable option): shrink the fence to the
  // minimum compliant hull around everything placed — equipment, augmentation
  // and reserved zones, future-phase ghosts and drafter-drawn road points —
  // plus the full road-band clearance, so empty yard strips beyond the last
  // island disappear. OPT-IN (default off => byte-identical), following the
  // explicit ring-mode precedent: an automatic trim would silently remove
  // the open yard drafters use for aug pins and equipment moves. The trim is
  // a pure axis-aligned clip: when the hull already covers the fence extents
  // the ORIGINAL fence object is kept and the design stays byte-identical
  // even with the option on. Compact and placed-island layouts keep the
  // lot-inset fence (their geometry is drafter-driven).
  if (options.deadSpaceTrim === true && !hasTracedYard && !compact && blocksPlaced > 0 &&
      !(options.constraints?.placedIslands?.length)) {
    const hullRects: { x: number; y: number; hx: number; hy: number }[] = [
      ...equipment.map(e => { const h = equipHalves(e); return { x: e.x, y: e.y, hx: h.hx, hy: h.hy }; }),
      ...futureEquipment.map(e => { const h = equipHalves(e); return { x: e.x, y: e.y, hx: h.hx, hy: h.hy }; }),
      ...augmentationZones.map(z => ({ x: z.x, y: z.y, hx: z.length / 2, hy: z.width / 2 })),
      ...reservedZones.map(z => ({ x: z.x, y: z.y, hx: z.length / 2, hy: z.width / 2 })),
      ...(options.constraints?.customRoads ?? []).flatMap(r =>
        (r.pts ?? []).map(p => ({ x: p.x, y: p.y, hx: CLEARANCES.roadWidth / 2, hy: CLEARANCES.roadWidth / 2 }))),
      ...placedAccessRects.map(r => ({ x: r.x, y: r.y, hx: r.hx, hy: r.hy })),
    ];
    const trimmed = trimFenceToHull(fence, hullRects, equipmentMargin);
    if (trimmed) {
      const savedAc = (Math.abs(polygonArea(fence)) - Math.abs(polygonArea(trimmed))) / 43560;
      if (savedAc > 0.005) {
        fence = trimmed;
        warnings.push(
          `Dead-space trim: the fence was shrunk to the minimum compliant hull around the placed islands — ` +
          `${savedAc.toFixed(2)} AC of empty yard removed (roads and crushed-rock re-derive from the trimmed fence).`);
      }
    }
  }

  // Roads: one connected network — perimeter band inside the fence with
  // drive aisles subtracted from the interior (so aisles always meet the
  // perimeter road), plus an entrance road from the gate.
  // Compact layouts keep only the gate (no interior roads).
  const { roads, aisles, roadNetwork, gate, roadWarnings } = buildRoads(
    fence, equipment, rows, fp, compact, options.gateEdge ?? 'S',
    options.constraints?.gatePin ?? null, aisleOffsets,
    options.autoRoadWrap === false ? [] : movedPadCenters,
    options.constraints?.customRoads ?? [], corridorAisles,
    [
      ...augmentationZones.map(z => ({ x: z.x, y: z.y, hx: z.length / 2, hy: z.width / 2 })),
      ...reservedZones.map(z => ({
        x: z.x, y: z.y, hx: z.length / 2, hy: z.width / 2,
        ...(z.kind === 'laydown' ? { optional: true } : {}),
      })),
      ...futureEquipment.map(e => { const h = equipHalves(e); return { x: e.x, y: e.y, hx: h.hx, hy: h.hy }; }),
      // Drafter-drawn roads must stay inside the road-network region: the
      // ring expands so every drawn centerline point's strip fits inside the
      // inner edge (which sits equipmentToRoadEdge outside the cluster bbox,
      // hence the reduced half-extent — interior drawn roads never grow it).
      ...(options.constraints?.customRoads ?? []).flatMap(r =>
        (r.pts ?? []).map(p => {
          const h = Math.max(0, CLEARANCES.roadWidth / 2 - CLEARANCES.equipmentToRoadEdge);
          return { x: p.x, y: p.y, hx: h, hy: h };
        })),
    ],
    options.autoRoadWrap === false ? [] : placedAccessRects,
    options.ringMode ?? 'fence',
    options.constraints?.ringOffsets ?? null,
    false,
    options.constraints?.removedRoads ?? [],
    bandMode,
    options.constraints?.roadCuts ?? [],
    options.constraints?.pavedTracedRoads ?? []
  );
  warnings.push(...roadWarnings);

  // Cable routing per Sheets 3-4 (DC / MV / LVAC / fiber + trench band)
  const routing = generateCableRouting(
    equipmentForRouting(equipment), augmentationZones, fence, options.constraints?.trenchX ?? null,
    reservedZones, islands, options.dcRouting ?? 'direct',
    options.constraints?.dcRoutingOverrides ?? null,
    options.exclusionZones ?? null
  );
  warnings.push(...routing.warnings);

  // Crushed-rock yard surfacing regions + quantities (boolean difference from
  // the final fence/road/equipment/reserved geometry, after all edits).
  const surfacing = computeSurfacing(
    fence, roadNetwork, roads, equipment, reservedZones,
    options.surfacingMode ?? 'between-roads',
    options.surfacingDepthIn ?? SURFACING_DEPTH_IN_DEFAULT,
    augmentationZones,
    options.deadSpaceTrim === true,
    hasTracedYard
  );
  if (!surfacing) {
    warnings.push('Crushed-rock surfacing regions could not be computed for this geometry — surfacing omitted; review ground cover in detailed design.');
  }

  // Reference PCS/CON naming from the deterministic feeder grouping (relabeled
  // again from actual feeders once a substation exists — see useDesignStore).
  applyReferenceLabels(equipment, null, islands);

  // Traced/hand-placed PCS and containers (KMZ auto-fill) count toward the
  // achieved capacity: each non-augmented traced PCS represents one block at
  // the config rating, and traced containers carry the container energy.
  // Augmented units are reserve — excluded, same as the automatic aug zones.
  let tracedPcsUnits = 0;
  let tracedContainers = 0;
  let tracedAugPcsUnits = 0;
  let tracedAugContainers = 0;
  let tracedFuturePcsUnits = 0;
  let tracedFutureContainers = 0;
  for (const spec of placedEquipSpecs) {
    // Only KMZ-traced units count toward capacity — manual or legacy placed
    // gear (source absent) never silently changes the rated MW/MWh.
    if (spec.source !== 'trace') continue;
    if (spec.kind !== 'inverter' && spec.kind !== 'bess') continue;
    const isPcs = spec.kind === 'inverter';
    // Future build-out and augmentation reserve are tallied separately so
    // the panel can show them without letting them inflate built capacity.
    if (spec.future) {
      if (isPcs) tracedFuturePcsUnits++; else tracedFutureContainers++;
    } else if (spec.augmented) {
      if (isPcs) tracedAugPcsUnits++; else tracedAugContainers++;
    } else {
      if (isPcs) tracedPcsUnits++; else tracedContainers++;
    }
  }
  // Client-declared nameplate (from the package's sheet specs) overrides the
  // tool's own block rating for traced units, so a traced yard reads the
  // client's numbers (e.g. 500 MW / 176 PCS = 2.84 MW per built PCS).
  const ratings = options.constraints?.tracedRatings;
  const tracedMwPerPcs =
    Number.isFinite(ratings?.mwPerPcs) && (ratings!.mwPerPcs as number) > 0
      ? (ratings!.mwPerPcs as number) : config.blockMW;
  const tracedMwhPerContainer =
    Number.isFinite(ratings?.mwhPerContainer) && (ratings!.mwhPerContainer as number) > 0
      ? (ratings!.mwhPerContainer as number) : config.containerMWh;

  return {
    boundary,
    fence,
    ...(hasTracedYard ? { propertyLineFence: true as const } : {}),
    equipment,
    augmentationZones,
    reservedZones,
    reserveSummary,
    futureEquipment,
    roads,
    aisles,
    roadNetwork,
    gate,
    cables: routing.cables,
    trench: routing.trench,
    corridorTrenches: routing.corridorTrenches,
    surfacing,
    blockRows,
    islands,
    // Always present: an EMPTY design (zero blocks — e.g. a phase footprint
    // awaiting manual placement) still needs the edit layer's drag-validation
    // geometry, otherwise the placement tools never render and nothing can be
    // placed or clicked on that area.
    rowEditGeom,
    blocksPlaced,
    blocksRequired,
    achievedMW: blocksPlaced * config.blockMW + tracedPcsUnits * tracedMwPerPcs,
    // Individually deleted containers reduce stored energy without removing a
    // whole block, so MWh is counted from the containers actually present.
    achievedMWh: Math.max(0,
      blocksPlaced * config.containersPerBlock - placedContainerShortfall - looseContainersRemoved) * config.containerMWh +
      tracedContainers * tracedMwhPerContainer,
    ...(tracedPcsUnits > 0 ? { tracedPcsUnits } : {}),
    ...(tracedContainers > 0 ? { tracedContainers } : {}),
    ...(tracedAugPcsUnits > 0 ? { tracedAugPcsUnits } : {}),
    ...(tracedAugContainers > 0 ? { tracedAugContainers } : {}),
    ...(tracedFuturePcsUnits > 0 ? { tracedFuturePcsUnits } : {}),
    ...(tracedFutureContainers > 0 ? { tracedFutureContainers } : {}),
    targetMW,
    targetMWh,
    // Only present when a removal was actually applied, so unedited designs
    // stay byte-identical.
    ...(islandRemovalApplied > 0 ? { islandBlockRemovalApplied: islandRemovalApplied } : {}),
    ...(blockRemovalApplied > 0 ? { blockRemovalApplied } : {}),
    warnings,
  };
}

function placeBlock(
  equipment: PlacedEquipment[],
  config: BessConfiguration,
  blockIdx: number,
  cx: number, cy: number,
  fp: BlockFootprint,
  pcsClearance: number
) {
  const n = blockIdx + 1;
  const pairsAcross = Math.ceil(config.containersPerBlock / 2);
  const rowWidth = pairsAcross * LG_JF2.width + (pairsAcross - 1) * CLEARANCES.sideToSide;

  // The footprint is just the core (containers + PCS); no aug bay.
  const coreCx = cx;

  // Container block occupies bottom of footprint; inverter at top.
  const containerDepth = LG_JF2.length * 2 + CLEARANCES.rearToRear;
  const containersBottom = cy - fp.depth / 2;

  // Two rows rear-to-rear; containers long axis along y
  const rowYFront = containersBottom + LG_JF2.length / 2; // south row (front faces south)
  const rowYBack = containersBottom + LG_JF2.length + CLEARANCES.rearToRear + LG_JF2.length / 2;

  let placed = 0;
  for (let row = 0; row < 2 && placed < config.containersPerBlock; row++) {
    const y = row === 0 ? rowYFront : rowYBack;
    for (let col = 0; col < pairsAcross && placed < config.containersPerBlock; col++) {
      const x = coreCx - rowWidth / 2 + LG_JF2.width / 2 + col * (LG_JF2.width + CLEARANCES.sideToSide);
      // E-panel / cable-compartment side per sheet 3: paired containers face
      // their E-panels into the shared column gap, so the pair reads C | A
      // (EPNL-1200C = E-panel right on the left container, EPNL-1200A =
      // E-panel left on the right container).
      const epanel: 'left' | 'right' = col % 2 === 0 ? 'right' : 'left';
      equipment.push({
        id: `bess-${n}-${placed + 1}`,
        kind: 'bess',
        // Same naming as the DXF export (nexteraLabel in dxfExport.ts):
        // "BATT <blk>-<n> (A|C)" where (A)=EPNL-1200A / (C)=EPNL-1200C
        label: `BATT ${n}-${placed + 1} (${epanel === 'right' ? 'C' : 'A'})`,
        x, y,
        rotation: Math.PI / 2, // long axis along y
        length: LG_JF2.length, width: LG_JF2.width, height: LG_JF2.height,
        epanel,
        doorEnd: row === 0 ? -1 : 1,
      });
      placed++;
    }
  }

  // Inverter above containers with PCS clearance, long axis along x
  const invY = containersBottom + containerDepth + pcsClearance + config.inverterDims.width / 2;
  equipment.push({
    id: `inv-${n}`,
    kind: 'inverter',
    label: `${config.inverterModel} ${n}`,
    x: coreCx, y: invY, rotation: 0,
    length: config.inverterDims.length, width: config.inverterDims.width, height: config.inverterDims.height,
  });
}

// Mirrored-pair placement for 3-container blocks (Puma reference). The pair
// footprint is centered at (cx, cy); the 10 ft aux corridor runs E-W through
// the center. `count` = 1 places only the south block (edge/odd strip).
// Every container shares one rotation (PI/2 for the parallel A-1/A-2 pair is
// impossible if A-3 must also match, so per the reference: A-1/A-2 long axis
// along y, A-3 long axis along x — rotations are position-determined but
// uniform across ALL blocks; the north PCS keeps rotation 0 (sheet-3) and
// the south PCS carries rotation π (true 180° unit, ends mirrored).
function placeMirroredPair(
  equipment: PlacedEquipment[],
  config: BessConfiguration,
  blockIdx: number,
  cx: number, cy: number,
  fp: BlockFootprint,
  pcsClearance: number,
  count: number,
  containersPerPcs: number = SINGLE_MODULE_CONTAINERS
): number {
  const invW = config.inverterDims.width;
  const halfD = fp.depth / 2;
  const dxPair = (PAIR_INNER_GAP_FT + LG_JF2.width) / 2;
  // Per the reference plan the A-1/A-2 pair is NOT centered under the A-3:
  // its span (2 containers + 3 ft gap) is narrower than the A-3 length, and
  // the pair sits flush with one END of the A-3 (C-container edge on the A-3
  // end). The north block is a 180-degree rotation of the south block, so the
  // bias flips sides and the C/A order swaps — the centered PCS stays put,
  // which is why PCS units align while the BESS pairs show a mirrored offset.
  const pairBias = (LG_JF2.length - (2 * LG_JF2.width + PAIR_INNER_GAP_FT)) / 2;
  let placed = 0;
  // side -1 = south block (PCS at the south/outer end), +1 = north mirror.
  for (const side of [-1, 1] as const) {
    if (placed >= count) break;
    const n = blockIdx + placed + 1;
    // A-1 (C) and A-2 (A): long axis along y, doors facing the PCS end.
    // South block: C west, pair biased west (C flush with A-3 west end).
    // North block (rotated 180°): C east, pair biased east.
    const pairY = cy + side * (halfD - invW - pcsClearance - LG_JF2.length / 2);
    const shiftX = side * pairBias;
    for (let i = 0; i < 2; i++) {
      const isC = i === 0;
      const xOff = shiftX + (isC ? side * dxPair : -side * dxPair);
      equipment.push({
        id: `bess-${n}-${i + 1}`,
        kind: 'bess',
        label: `BATT ${n}-${i + 1} (${isC ? 'C' : 'A'})`,
        x: cx + xOff, y: pairY,
        rotation: Math.PI / 2,
        length: LG_JF2.length, width: LG_JF2.width, height: LG_JF2.height,
        // E-panels face the 3 ft inner gap between the pair
        epanel: xOff < 0 ? 'right' : 'left',
        doorEnd: side === -1 ? -1 : 1, // door end toward the PCS (outer) end
      });
    }
    if (containersPerPcs >= 3) {
      // A-3: perpendicular (long axis x), centered, at the corridor edge.
      equipment.push({
        id: `bess-${n}-3`,
        kind: 'bess',
        label: `BATT ${n}-3 (A)`,
        x: cx, y: cy + side * (AUX_CORRIDOR_FT / 2 + LG_JF2.width / 2),
        rotation: 0,
        length: LG_JF2.length, width: LG_JF2.width, height: LG_JF2.height,
        // Cable-entry end: the pair bias opens a lane on the side the pair is
        // NOT flush with — south block pair flush west => lane/entry at the
        // east (+x) end; north (180° rotated) => west (-x) end.
        epanel: side === -1 ? 'right' : 'left',
        doorEnd: side === -1 ? 1 : -1,
      });
    }
    // PCS at the outer end, long axis along x.
    equipment.push({
      id: `inv-${n}`,
      kind: 'inverter',
      label: `${config.inverterModel} ${n}`,
      // South block PCS is a TRUE 180° rotation (rotation π) of the north
      // block's sheet-3 unit: mirrorOf()/pcsCompartments() then flip the DC
      // and MV/aux compartments to the opposite ends automatically, so the
      // DC exits land at the block's A-3 cable-lane end on BOTH rows. The
      // north block keeps rotation 0 (canonical sheet-3 end assignment).
      x: cx, y: cy + side * (halfD - invW / 2),
      rotation: side === -1 ? Math.PI : 0,
      length: config.inverterDims.length, width: config.inverterDims.width, height: config.inverterDims.height,
      // Container-facing side: the PCS connection compartments (DC green box,
      // MV/aux box) sit on the face toward the containers. -side = inward.
      doorEnd: side === -1 ? 1 : -1,
    });
    placed++;
  }
  return placed;
}

// ---- Drafter drag-to-place islands ------------------------------------------
// A placed island is one FULL standard island composed as a unit in a LOCAL
// horizontal frame centered on the anchor: ISLAND_PCS_PER_SIDE mirrored-pair
// columns with the widened middle gap, the mid-island aux cluster (aux
// distribution north / comms / aux transformer south — same ids and stack as
// the auto pass), the strip-end FJB at the east end and the default 2
// augmentation units at the west end (so they never collide with the FJB).
// `angleDeg` (from PlacedIslandSpec) applies a real 2-D CCW rotation about
// the anchor so arbitrary angles are supported, not just 0 and 90. The legacy
// `vertical` flag is read for backward-compat and maps to angleDeg = 90.
export interface PlacedIslandComposition {
  equipment: PlacedEquipment[];
  zones: ReservedZone[];
  futureEquipment: PlacedEquipment[];
  blockCenters: Pt[];       // pair-column centers (world)
  blockNs: number[];        // block numbers consumed
  info: IslandInfo;
  bbox: { x: number; y: number; hx: number; hy: number }; // world AABB of everything
  // Pre-rotation LOCAL half-extents (local +x = strip axis, local +y = depth).
  // More accurate than back-projecting bbox for non-0/90 angles.
  localHx: number;
  localHy: number;
}

// World AABB half-extents of a composed island footprint (for the UI drag
// ghost). Always in the LOCAL (horizontal, pre-rotation) frame so callers
// can apply their own rotation; the drafter's chosen angle is separate.
export function placedIslandPlanDims(
  config: BessConfiguration, pcsClearance: number, pairs?: number,
  kind: PlacedIslandKind = 'island',
  aug: boolean = true,
  // false = bare placement (no aux cluster, narrower mid gap; singles no FJB).
  auxGear: boolean = true
): { hx: number; hy: number } {
  const c = composePlacedIsland(
    {
      id: 'ghost', x: 0, y: 0, pairs,
      ...(kind !== 'island' ? { kind } : {}),
      ...(aug ? {} : { aug: false as const }),
      ...(auxGear ? {} : { auxGear: false as const }),
    },
    config, pcsClearance, 1, 1);
  return { hx: c.bbox.hx, hy: c.bbox.hy };
}

// ---- interactive placement: snapping + orientation-correct footprints -----
// Snap increments offered while a placement preview is live. 0 = no snap
// (free positioning). The drafter's choice only affects where the CANDIDATE
// center lands; the candidate is what gets validated AND committed, so the
// preview and the commit can never disagree about position.
export const PLACEMENT_SNAP_STEPS_FT = [0, 0.1, 0.5, 1, 5] as const;
export const PLACEMENT_SNAP_DEFAULT_FT = 1;
// Fine / coarse / traverse nudge steps, matching the arrow-key convention the
// committed-equipment nudges already use (plain / Shift / Ctrl+Shift).
export const PLACEMENT_NUDGE_FT = { fine: 0.1, coarse: 1, far: 10 } as const;
// Free positioning still quantizes to 1/100 ft: a placement must be exactly
// reproducible from the saved project, and raw pointer floats are not.
const PLACEMENT_FREE_QUANTUM_FT = 0.01;

/** Deterministic candidate center for a raw pointer position. snapFt <= 0 = free. */
export function snapPlacementCenter(pt: Pt, snapFt: number): Pt {
  if (!Number.isFinite(pt.x) || !Number.isFinite(pt.y)) return { x: 0, y: 0 };
  if (!Number.isFinite(snapFt) || snapFt <= 0) {
    // Divide-then-multiply by 0.01 reintroduces binary float error (20.4 comes
    // back as 20.400000000000002), which would make the "free" candidate
    // depend on how the drafter arrived at it. Round on an integer scale so a
    // free position is always an exact hundredth.
    const q = 1 / PLACEMENT_FREE_QUANTUM_FT;
    return {
      x: Math.round(pt.x * q) / q,
      y: Math.round(pt.y * q) / q,
    };
  }
  return { x: snapToGrid(pt.x, snapFt), y: snapToGrid(pt.y, snapFt) };
}

export interface PlacementFootprint {
  x: number; y: number; hx: number; hy: number;
  role: 'equipment' | 'future' | 'zone';
  id: string;
  // Rotation of this footprint in degrees CCW from world +x.
  // hx is along the rotated local +x axis, hy across it.
  angleDeg?: number;
}

// Real per-item plan footprints of a placement, in WORLD feet with the
// placement's orientation already applied. The drag preview draws these
// instead of one axis-aligned box, so a rotated island shows its true shape
// (each container and PCS at its actual angle) before commit.
export function placedIslandFootprints(
  spec: PlacedIslandSpec,
  config: BessConfiguration,
  pcsClearance: number
): PlacementFootprint[] {
  const comp = composePlacedIsland(spec, config, pcsClearance, 1, 1);
  // Equipment: hx/hy are half-extents in the equipment's LOCAL frame and
  // angleDeg carries the world rotation so the preview can draw oriented rects.
  const eqRect = (e: PlacedEquipment, role: 'equipment' | 'future'): PlacementFootprint => ({
    id: e.id, role,
    x: e.x, y: e.y,
    hx: e.length / 2,
    hy: e.width / 2,
    angleDeg: (e.rotation * 180 / Math.PI + 720) % 360,
  });
  return [
    ...comp.equipment.map(e => eqRect(e, 'equipment')),
    ...comp.futureEquipment.map(e => eqRect(e, 'future')),
    ...comp.zones.map(z => ({
      id: z.id, role: 'zone' as const,
      x: z.x, y: z.y, hx: z.length / 2, hy: z.width / 2,
      angleDeg: z.angleDeg ?? 0,
    })),
  ];
}

// Pair-column count for a placed island. Defaults to the full standard
// island; a drafter may deliberately place a PARTIAL island (1 .. 7 pairs)
// to seat the last stub of capacity where a full 7-pair strip cannot fit.
export function placedIslandPairs(pairs: number | undefined): number {
  if (!Number.isFinite(pairs)) return ISLAND_PCS_PER_SIDE;
  return Math.min(ISLAND_PCS_PER_SIDE, Math.max(1, Math.trunc(pairs as number)));
}

// Augmentation units for a placed island scaled by pair count. A full
// 7-pair island keeps DEFAULT_ISLAND_AUG_UNITS (2) — byte-identical to the
// historical output. Partial islands reserve fewer units so the strip-end
// footprint does not crowd out the very space that made the parcel tight
// enough to need a partial in the first place.
//
// Formula: ceil(DEFAULT_ISLAND_AUG_UNITS * nCols / ISLAND_PCS_PER_SIDE),
// capped at DEFAULT_ISLAND_AUG_UNITS.
//   pairs 1-3 → 1 aug unit
//   pairs 4-7 → 2 aug units (full island: byte-identical)
export function placedIslandAugUnits(nCols: number): number {
  return Math.min(
    DEFAULT_ISLAND_AUG_UNITS,
    Math.ceil(DEFAULT_ISLAND_AUG_UNITS * nCols / ISLAND_PCS_PER_SIDE)
  );
}

// Longest clear span through (cx, cy) along the island's STRIP axis for a
// probe of half-extent `halfCross` across the strip, staying inside `poly`
// with `margin`. Walked outward from the anchor in 1 ft steps so the number
// reported to the drafter is the space actually available at the spot they
// dropped on — not a bounding-box approximation that ignores concave
// notches and angled lot lines.
//
// The two directions are reported SEPARATELY because an island is centered on
// its anchor: the total span is what the parcel offers, but only twice the
// SHORTER arm is usable without moving the drop point. Collapsing them into
// one number produced the self-contradictory "needs 349 ft but only 490 ft is
// available" message, which reads as a broken tool instead of "nudge it west".
function clearStripSpan(
  cx: number, cy: number, halfCross: number,
  poly: Pt[], margin: number, angleDeg: number, cap = 4000
): { neg: number; pos: number; total: number; usable: number } {
  const STEP = 1;
  const θ = angleDeg * Math.PI / 180;
  // Unit vector along the strip axis (local +x direction in world frame)
  const ux = Math.cos(θ), uy = Math.sin(θ);
  // Each 1-ft probe is a thin slice orthogonal to the strip, with half-extent
  // `halfCross` across the strip and STEP/2 along it, rotated to the island's angle.
  const fits = (ox: number, oy: number) =>
    rotatedRectInsidePolygon(ox, oy, STEP / 2, halfCross, θ, poly, margin);
  if (!fits(cx, cy)) return { neg: 0, pos: 0, total: 0, usable: 0 };
  let neg = 0, pos = 0;
  while (neg < cap && fits(cx - ux * (neg + STEP), cy - uy * (neg + STEP))) neg += STEP;
  while (pos < cap && fits(cx + ux * (pos + STEP), cy + uy * (pos + STEP))) pos += STEP;
  return {
    neg, pos,
    total: neg + pos + STEP,
    usable: 2 * Math.min(neg, pos) + STEP,
  };
}

// Drafter-facing "why it doesn't fit" sentence for a placed island that
// failed a containment check: what the island needs along its strip, what is
// actually clear at that anchor, and which line is doing the constraining.
// Also names the smallest partial island that WOULD fit there, so the
// drafter's next action is obvious instead of guess-and-drag.
function placedIslandFitsPoly(
  comp: PlacedIslandComposition, poly: Pt[], margin: number, onlyBess: boolean
): boolean {
  for (const e of [...comp.equipment, ...comp.futureEquipment]) {
    if (onlyBess && e.kind !== 'bess') continue;
    // Use the real rotated corners — more accurate than swapping hx/hy at 90°.
    if (!rotatedRectInsidePolygon(e.x, e.y, e.length / 2, e.width / 2, e.rotation, poly, margin)) return false;
  }
  return true;
}

function placedIslandSpaceReason(
  comp: PlacedIslandComposition,
  spec: PlacedIslandSpec,
  config: BessConfiguration,
  pcsClearance: number,
  poly: Pt[],
  margin: number,
  constraintName: string,
  // NFPA measures BESS containers only; fence/road clearance measure everything.
  onlyBess = false
): string {
  const angleDeg = spec.angleDeg ?? (spec.vertical ? 90 : 0);
  // Use the pre-rotation local half-extents for accurate strip/cross measurements
  // regardless of the island's rotation angle.
  const needed = 2 * comp.localHx;
  const halfCross = comp.localHy;
  const span = clearStripSpan(
    comp.bbox.x, comp.bbox.y,
    halfCross, poly, margin, angleDeg);
  // Human-readable axis label for the strip direction
  const axis = angleDeg === 0 ? 'east-west'
    : angleDeg === 90 ? 'north-south'
    : `${angleDeg}°`;
  const ft = (v: number) => `${Math.round(v)} ft`;
  const pairs = placedIslandPairs(spec.pairs);
  if (span.total <= 1) {
    return `it needs ${ft(needed)} of clear ${axis} space, and the drop point itself is ` +
      `already past ${constraintName}`;
  }
  // Largest partial island that fits, tested by composing the candidate at
  // this very anchor and running the same containment check the drop uses.
  // A smaller island is NOT a centered sub-span of the full one (the strip
  // recenters and the end gear/aug reserve move with it), so comparing plan
  // dims against the measured span suggests a size that is then rejected.
  // A single PCS module is already the smallest placeable thing, so there is
  // no smaller candidate to suggest — except dropping its augmentation
  // reserve, which is a real and often sufficient saving.
  // Dropping the optional mid-island aux cluster is checked FIRST for both
  // shapes: it keeps every core block the drafter asked for, so it beats any
  // suggestion that shrinks the placement itself.
  const coreOnlyFits = placedIslandHasAuxCluster(spec) &&
    placedIslandFitsPoly(
      composePlacedIsland({ ...spec, auxGear: false }, config, pcsClearance, 1, 1),
      poly, margin, onlyBess);
  let hint: string;
  if (coreOnlyFits) {
    hint = ' Placing it as core equipment only (no island aux cluster) would fit here.';
  } else if (spec.kind === 'single' || spec.kind === 'single2') {
    const noAug = placedIslandHasAug(spec) &&
      placedIslandFitsPoly(
        composePlacedIsland({ ...spec, aug: false }, config, pcsClearance, 1, 1),
        poly, margin, onlyBess);
    hint = noAug
      ? ' A single PCS module with NO augmentation would fit here.'
      : ' A single PCS module is already the smallest placement — move it toward the middle of the yard.';
  } else {
    let best = 0;
    for (let p = pairs - 1; p >= 1; p--) {
      const cand = composePlacedIsland({ ...spec, pairs: p }, config, pcsClearance, 1, 1);
      if (placedIslandFitsPoly(cand, poly, margin, onlyBess)) { best = p; break; }
    }
    const singleFits = placedIslandFitsPoly(
      composePlacedIsland({ ...spec, kind: 'single' }, config, pcsClearance, 1, 1),
      poly, margin, onlyBess);
    hint = best > 0
      ? ` A ${best}-pair partial island (${best * 2} blocks) would fit here.`
      : singleFits
        ? ' Not even a 1-pair partial island fits here — a single PCS + 3 BESS module would.'
        : ' Not even a 1-pair partial island fits here — move it toward the middle of the yard.';
  }
  // An island is centered on its anchor, so the binding number is twice the
  // SHORTER arm, not the whole span. When the parcel is wide enough overall
  // and only the off-center anchor is at fault, say so and name the shift
  // that would fix it — otherwise the drafter reads "needs 349 ft, 490 ft
  // available" and concludes the tool is broken.
  if (span.usable < needed && span.total >= needed) {
    const toward = span.pos > span.neg
      ? (angleDeg === 0 ? 'east' : angleDeg === 90 ? 'north' : 'the longer side')
      : (angleDeg === 0 ? 'west' : angleDeg === 90 ? 'south' : 'the longer side');
    const shift = Math.ceil((needed - span.usable) / 2);
    // Deliberately WITHOUT `hint`: the shrink-it suggestions are measured at
    // this same off-center anchor, so appending them yields the contradiction
    // "nudge it and it fits at full size. Not even a 1-pair island fits here."
    // Moving is the better action and the only one stated.
    return `the drop point is off-center in the clear ${axis} space: the island needs ` +
      `${ft(needed)} centered on the anchor and this spot only offers ${ft(span.usable)} ` +
      `(${ft(span.total)} total, limited by ${constraintName}). ` +
      `Nudge it about ${ft(shift)} ${toward} and it fits at full size.`;
  }
  return `it needs ${ft(needed)} of clear ${axis} space but only ${ft(span.usable)} is available here, ` +
    `limited by ${constraintName}.${hint}`;
}

// ---- Shared placed-island drop evaluation -----------------------------------
// SINGLE source of truth for whether a placed island is accepted, and why not.
// buildLayout calls this at commit time; the 3D drag ghost calls it every
// frame with the same geometry, so the red/green preview and its tooltip can
// never disagree with what the drop actually decides. `hard` is the rejection
// reason (null = accepted); `soft` are place-with-warning findings.
export interface PlacedIslandEvaluation {
  hard: string | null;
  soft: string[];
  blockedPins: string[];
}

export function evaluatePlacedIslandDrop(
  spec: PlacedIslandSpec,
  comp: PlacedIslandComposition,
  config: BessConfiguration,
  pcsClearance: number,
  fence: Pt[],
  lotPolygon: Pt[],
  equipmentMargin: number,
  nfpaSetback: boolean,
  // Pinned reserved rectangles. `id === null` = laydown (hard conflict);
  // a non-null id is an augmentation pin (island wins, pin is blocked).
  pins: { id: string | null; x: number; y: number; hx: number; hy: number }[],
  // Already-accepted placed islands to test overlap against.
  others: { id: string; bbox: { x: number; y: number; hx: number; hy: number } }[]
): PlacedIslandEvaluation {
  const soft: string[] = [];
  const blockedPins: string[] = [];
  if (!Number.isFinite(spec.x) || !Number.isFinite(spec.y)) {
    return { hard: 'invalid anchor position', soft, blockedPins };
  }
  let hard: string | null = null;
  for (const e of [...comp.equipment, ...comp.futureEquipment]) {
    // Use the actual rotated rectangle corners for containment checks so
    // islands at arbitrary angles are validated correctly.
    if (!rotatedRectInsidePolygon(e.x, e.y, e.length / 2, e.width / 2, e.rotation, fence, 0)) {
      // Report what the island needed vs what is actually clear here, naming
      // the fence line as the governing constraint, rather than a bare
      // "doesn't fit".
      hard = 'the island (including its strip-end gear and augmentation reserve) ' +
        'extends outside the fence line: ' +
        placedIslandSpaceReason(comp, spec, config, pcsClearance, fence, 0, 'the fence line');
      break;
    }
    if (!rotatedRectInsidePolygon(e.x, e.y, e.length / 2, e.width / 2, e.rotation, fence, equipmentMargin) &&
        !soft.some(w => w.includes('perimeter road clearance'))) {
      soft.push(`sits inside the ${equipmentMargin} ft perimeter road clearance margin — ` +
        placedIslandSpaceReason(comp, spec, config, pcsClearance, fence, equipmentMargin,
          'the perimeter road clearance'));
    }
    if (nfpaSetback && e.kind === 'bess' &&
        !rotatedRectInsidePolygon(e.x, e.y, e.length / 2, e.width / 2, e.rotation, lotPolygon, CLEARANCES.bessToLotLine) &&
        !soft.some(w => w.includes('NFPA 855'))) {
      soft.push(`BESS containers breach the ${CLEARANCES.bessToLotLine} ft NFPA 855 lot-line setback — ` +
        placedIslandSpaceReason(comp, spec, config, pcsClearance, lotPolygon,
          CLEARANCES.bessToLotLine, `the ${CLEARANCES.bessToLotLine} ft NFPA 855 lot-line setback`,
          true));
    }
  }
  if (!hard) {
    for (const p of pins) {
      if (Math.abs(comp.bbox.x - p.x) < comp.bbox.hx + p.hx + 3 &&
          Math.abs(comp.bbox.y - p.y) < comp.bbox.hy + p.hy + 3) {
        if (p.id !== null) {
          // An augmentation PIN never deletes a placed island: the island
          // wins, the pin is rejected later (stable prefix, keeps auto).
          blockedPins.push(p.id);
          continue;
        }
        hard = 'overlaps a pinned reserved area (laydown or future augmentation pin)';
        break;
      }
    }
  }
  if (!hard) {
    const islandGap = pairBlockGapFt(pcsClearance);
    for (const a of others) {
      if (Math.abs(comp.bbox.x - a.bbox.x) < comp.bbox.hx + a.bbox.hx + islandGap &&
          Math.abs(comp.bbox.y - a.bbox.y) < comp.bbox.hy + a.bbox.hy + islandGap) {
        hard = `overlaps placed island ${a.id}`;
        break;
      }
    }
  }
  return { hard, soft, blockedPins };
}

// Scene-facing preview of a placed-island drop. Composes the island exactly
// as buildLayout would, then runs the SAME evaluator, so the drag ghost's
// red/green state and tooltip always match what the drop will decide.
// `roadMode`/`config` carry the two arrangement gates (QTY 3 + non-compact)
// that buildLayout applies before it ever composes an island.
export function previewPlacedIslandDrop(
  center: Pt,
  angleDeg: number,    // island rotation (0 = horizontal, 90 = vertical, any = arbitrary)
  pairs: number | undefined,
  design: SiteDesign,
  config: BessConfiguration,
  pcsClearance: number,
  roadMode: RoadMode,
  edits: LayoutConstraints,
  // Excluded from the overlap test when previewing a MOVE of an existing island.
  ignoreId?: string,
  // Placement shape and the drafter's explicit augmentation decision, so the
  // ghost previews exactly what the commit will compose.
  kind: PlacedIslandKind = 'island',
  aug: boolean = true,
  // Drafter's explicit aux-cluster decision (false = core BESS only).
  auxGear: boolean = true
): PlacedIslandEvaluation {
  if (!isMirroredPairConfig(config)) {
    return {
      hard: `this layout is QTY ${config.containersPerBlock} — islands are a QTY 3 (mirrored-pair) ` +
        'arrangement. Switch containers-per-PCS to 3 to place islands',
      soft: [], blockedPins: [],
    };
  }
  const normAngle = ((angleDeg % 360) + 360) % 360;
  const spec: PlacedIslandSpec = {
    id: ignoreId ?? 'ghost',
    x: center.x, y: center.y,
    ...(normAngle !== 0 ? { angleDeg: normAngle } : {}),
    ...(pairs !== undefined ? { pairs } : {}),
    ...(kind !== 'island' ? { kind } : {}),
    ...(aug ? {} : { aug: false as const }),
    ...(auxGear ? {} : { auxGear: false as const }),
  };
  const comp = composePlacedIsland(spec, config, pcsClearance, 1, 1);
  const fp = blockFootprint(config, pcsClearance);
  const pins: { id: string | null; x: number; y: number; hx: number; hy: number }[] = [];
  for (const [pinId, pt] of Object.entries(edits.augPins ?? {})) {
    if (Number.isFinite(pt?.x) && Number.isFinite(pt?.y)) {
      pins.push({ id: pinId, x: pt.x, y: pt.y, hx: fp.width / 2, hy: fp.depth / 2 });
    }
  }
  const ldPin = edits.laydownPin, ldSize = edits.laydownSize;
  if (ldPin && Number.isFinite(ldPin.x) && Number.isFinite(ldPin.y) &&
      ldSize && Number.isFinite(ldSize.length) && Number.isFinite(ldSize.width)) {
    pins.push({ id: null, x: ldPin.x, y: ldPin.y, hx: ldSize.length / 2, hy: ldSize.width / 2 });
  }
  const others = (edits.placedIslands ?? [])
    .filter(p => p.id !== ignoreId)
    .map(p => {
      const c = composePlacedIsland(p, config, pcsClearance, 1, 1);
      return { id: p.id, bbox: c.bbox };
    });
  // Compact mode has no perimeter road band, so the fence margin is only the
  // front-to-fence clearance — mirror the engine or every compact drop near
  // the fence would preview red while the commit succeeds.
  const equipmentMargin = equipmentMarginFor(roadMode === 'compact', undefined);
  // The engine relaxes the NFPA setback only when the strict pass cannot hit
  // the target; the design records that outcome in its warnings, so mirror it
  // here rather than assuming strict.
  const nfpaSetback = !design.warnings.some(w =>
    w.startsWith('NFPA 855 100 ft BESS-to-lot-line setback relaxed'));
  return evaluatePlacedIslandDrop(
    spec, comp, config, pcsClearance, design.fence, design.boundary.polygon,
    equipmentMargin, nfpaSetback, pins, others);
}

export function composePlacedIsland(
  spec: PlacedIslandSpec,
  config: BessConfiguration,
  pcsClearance: number,
  islandN: number,
  blockStart: number,
  // Which end holds the augmentation units. Default 'west' (the FJB owns the
  // east end); 'east' mirrors the end gear — FJB/strip-end comms to the west,
  // aug units to the east. The composition stays symmetric so validation is
  // identical either way.
  augEnd: 'east' | 'west' = 'west'
): PlacedIslandComposition {
  // Mirror factor for the strip-end gear (local X only; strip is recentered).
  const endM = augEnd === 'east' ? -1 : 1;
  const fp = blockFootprint(config, pcsClearance);
  const pairGap = pairBlockGapFt(pcsClearance);
  const stepX = fp.width + pairGap;
  const clusterW = Math.max(HITACHI_AUX_XFMR.width, IPS_SWITCHGEAR.width, COMMS_CABINET.length);
  // Drafter's aux-cluster decision. When the cluster is opted out the middle
  // inter-pair gap keeps the STANDARD block gap: the widening exists solely to
  // house the cluster with its 10 ft clear each side, so a core-only island
  // must not reserve that space. midExtra keys off the SPEC FLAG ALONE - a
  // single has no mid gap to widen, and folding `single` in here would shift
  // legacy single geometry that saved projects depend on.
  const specWantsAuxCluster = placedIslandHasAuxCluster(spec);
  const midExtra = specWantsAuxCluster ? islandMiddleExtraFt(pcsClearance) : 0;
  // Partial islands carry fewer pair columns; the strip-end gear (FJB,
  // comms, aux cluster) is unchanged. The augmentation reserve scales with
  // pair count via placedIslandAugUnits so a 1–3 pair stub reserves only 1
  // aug unit instead of 2, freeing the tight end space that made the parcel
  // need a partial in the first place.
  // A SINGLE module is one PCS + either its legacy three containers or the
  // explicit engineer-selected two-container variant. Both are the south half
  // of one mirrored-pair column and keep the canonical PCS/pair geometry.
  const single = spec.kind === 'single' || spec.kind === 'single2';
  const singleContainers = spec.kind === 'single2'
    ? TWO_BESS_MODULE_CONTAINERS
    : SINGLE_MODULE_CONTAINERS;
  // A SINGLE module is one PCS and its containers, nothing else: no aux
  // cluster and no FJB, whatever the flag says.
  const wantAuxCluster = !single && specWantsAuxCluster;
  const nCols = single ? 1 : placedIslandPairs(spec.pairs);
  const mSplit = Math.ceil(nCols / 2);
  const xsRaw: number[] = [];
  for (let i = 0; i < nCols; i++) xsRaw.push(i * stepX + (i >= mSplit ? midExtra : 0));
  // Recenter so the anchor is the center of the BLOCK strip extents.
  const stripMin = xsRaw[0] - fp.width / 2;
  const stripMax = xsRaw[nCols - 1] + fp.width / 2;
  const shift = -(stripMin + stripMax) / 2;
  const xs = xsRaw.map(x => x + shift);
  const minLx = stripMin + shift, maxLx = stripMax + shift;

  const eqL: PlacedEquipment[] = [];
  const blockNs: number[] = [];
  if (single) {
    placeMirroredPair(
      eqL, config, blockStart - 1, xs[0], 0, fp, pcsClearance,
      SINGLE_MODULE_PCS, singleContainers);
    blockNs.push(blockStart);
  } else {
    for (let i = 0; i < nCols; i++) {
      placeMirroredPair(eqL, config, blockStart - 1 + 2 * i, xs[i], 0, fp, pcsClearance, 2);
      blockNs.push(blockStart + 2 * i, blockStart + 2 * i + 1);
    }
  }
  const p2i = (v: number) => String(v).padStart(2, '0');

  // Mid-island aux cluster in the widened middle gap (same stack, ids and
  // corridor keepout as the auto pass; package sides, never mirrored — the
  // composed island is regular so the package arrangement always fits).
  if (config.hasAuxEquipment && wantAuxCluster) {
    // Two or more pair columns have a widened middle gap to sit in. A
    // single-column partial island has no middle, so the cluster follows the
    // strip-end gear instead — it still straddles the aux corridor, so the
    // drops and collector run are unchanged.
    const gx = nCols >= 2
      ? (xs[mSplit - 1] + xs[mSplit]) / 2
      : endM * (maxLx + 6 + FEEDER_JUNCTION_BOX.length + 4 + clusterW / 2);
    type Piece = { id: string; kind: PlacedEquipment['kind']; label: string; dims: { length: number; width: number; height: number }; rot: number; side: 1 | -1 };
    const stack: Piece[] = [
      { id: `island-aux-dist-${islandN}`, kind: 'auxSwitchgear', label: 'AUX DIST (IPS)', dims: IPS_SWITCHGEAR, rot: Math.PI / 2, side: 1 },
      { id: `comms-${islandN}`, kind: 'commsCabinet', label: `COMMS-${p2i(islandN)}`, dims: COMMS_CABINET, rot: 0, side: 1 },
      { id: `island-aux-xfmr-${islandN}`, kind: 'auxTransformer', label: 'AUX XFMR (HITACHI)', dims: HITACHI_AUX_XFMR, rot: Math.PI / 2, side: -1 },
    ];
    const CORRIDOR_KEEPOUT = AUX_CORRIDOR_FT / 2 + 0.5;
    const edge: Record<1 | -1, number> = { 1: CORRIDOR_KEEPOUT, [-1]: -CORRIDOR_KEEPOUT };
    for (const s of stack) {
      const hy = (s.rot ? s.dims.length : s.dims.width) / 2;
      const yc = edge[s.side] + s.side * hy;
      edge[s.side] += s.side * (hy * 2 + 2);
      eqL.push({
        id: s.id, kind: s.kind, label: s.label,
        x: gx, y: yc, rotation: s.rot,
        length: s.dims.length, width: s.dims.width, height: s.dims.height,
      });
    }
  }

  // Strip-end FJB at the east end (same offset as the auto strip-end pass);
  // non-cluster configs keep the comms cabinet beside it. A SINGLE module is
  // one PCS + its containers and NOTHING else — no FJB (its feeder ties in
  // directly; drafters were furious about uninvited gear on singles).
  const fjbX = endM * (maxLx + 6 + FEEDER_JUNCTION_BOX.length / 2);
  // The FJB is electrically core - the island's feeders terminate in it - so a
  // bare ISLAND still gets one. A SINGLE module has no feeders of its own and
  // gets none.
  if (!single) {
    eqL.push({
      id: `fjb-${islandN}`, kind: 'feederJunctionBox', label: `FJB-${p2i(islandN)}`,
      x: fjbX, y: 0, rotation: 0,
      length: FEEDER_JUNCTION_BOX.length, width: FEEDER_JUNCTION_BOX.width, height: FEEDER_JUNCTION_BOX.height,
    });
  }
  // The comms cabinet is auxiliary gear either way: on a cluster config it
  // lives in the cluster, otherwise it sits beside the FJB. An explicit
  // aux-cluster opt-out drops it in both cases, so a core-only placement is
  // genuinely core-only.
  if (!config.hasAuxEquipment && wantAuxCluster) {
    eqL.push({
      id: `comms-${islandN}`, kind: 'commsCabinet', label: `COMMS-${p2i(islandN)}`,
      x: fjbX + endM * (FEEDER_JUNCTION_BOX.length / 2 + 3 + COMMS_CABINET.length / 2), y: 0, rotation: 0,
      length: COMMS_CABINET.length, width: COMMS_CABINET.width, height: COMMS_CABINET.height,
    });
  }

  // Augmentation units at the WEST end (the FJB owns the east end), same
  // spacing rule as the auto island-end scan. Full 7-pair islands always get
  // DEFAULT_ISLAND_AUG_UNITS (2) — byte-identical to historical output.
  // Partial islands reserve fewer units so the strip-end footprint does not
  // crowd out the space that made the parcel tight enough to need a partial.
  //
  // `aug: false` is the drafter's explicit "no augmentation" decision: ZERO
  // units, so this placement reserves no zone, no ghost equipment, no future
  // capacity, no BOM item and no export linework. The Big Iron Phase 1
  // reference has rows with no augmentation provision at all, so this is a
  // real arrangement, not a degenerate one.
  const nAugUnits = placedIslandHasAug(spec)
    ? (single ? 1 : placedIslandAugUnits(nCols))
    : 0;
  const augFp = augUnitFootprint(config, pcsClearance);
  const zonesL: ReservedZone[] = [];
  let futureL: PlacedEquipment[] = [];
  for (let k = 1; k <= nAugUnits; k++) {
    const cx = endM * (minLx - pairGap * k - augFp.width * (k - 0.5));
    const zid = `island-aug-${islandN}-${k}`;
    zonesL.push({
      id: zid, kind: 'futureAug', x: cx, y: 0,
      length: augFp.width, width: augFp.depth,
      label: `FUTURE AUG UNIT (ISLAND ${islandN})`,
    });
    futureL.push(...augUnitEquipment(zid, cx, 0, config, pcsClearance));
  }

  // Determine island rotation. `angleDeg` takes priority over legacy `vertical`.
  const angleDeg = spec.angleDeg != null
    ? ((spec.angleDeg % 360) + 360) % 360
    : (spec.vertical ? 90 : 0);
  const θ = angleDeg * Math.PI / 180;
  const cosθ = Math.cos(θ), sinθ = Math.sin(θ);

  // Pre-rotation LOCAL AABB: measure eqL/futureL/zonesL BEFORE applying W.
  // These are the half-extents in the island's own frame (strip along local +x,
  // depth along local +y) and are reported back via localHx/localHy for
  // diagnostics that need strip-aligned measurements at arbitrary angles.
  let lMinX = Infinity, lMaxX = -Infinity, lMinY = Infinity, lMaxY = -Infinity;
  const growL = (lx: number, ly: number, lhx: number, lhy: number) => {
    if (lx - lhx < lMinX) lMinX = lx - lhx;
    if (lx + lhx > lMaxX) lMaxX = lx + lhx;
    if (ly - lhy < lMinY) lMinY = ly - lhy;
    if (ly + lhy > lMaxY) lMaxY = ly + lhy;
  };
  for (const e of [...eqL, ...futureL]) {
    const eRot = Math.abs(Math.sin(e.rotation)) > 0.5;
    growL(e.x, e.y, (eRot ? e.width : e.length) / 2, (eRot ? e.length : e.width) / 2);
  }
  for (const z of zonesL) growL(z.x, z.y, z.length / 2, z.width / 2);
  const localHx = (lMaxX - lMinX) / 2;
  const localHy = (lMaxY - lMinY) / 2;

  // World transform: real 2-D CCW rotation by θ about the anchor.
  // At θ=0: translate only (horizontal island, byte-identical to old output).
  // At θ=90°: same as the old vertical branch (world = cx-localY, cy+localX).
  const W = (p: Pt): Pt => ({
    x: spec.x + p.x * cosθ - p.y * sinθ,
    y: spec.y + p.x * sinθ + p.y * cosθ,
  });
  const mapEq = (e: PlacedEquipment): PlacedEquipment => {
    const w = W({ x: e.x, y: e.y });
    return { ...e, x: w.x, y: w.y, rotation: e.rotation + θ };
  };
  const equipment = eqL.map(mapEq);
  const futureEquipment = futureL.map(mapEq);
  const zones = zonesL.map(z => {
    const w = W({ x: z.x, y: z.y });
    // Zones keep their local dimensions (length along strip, width across) and
    // carry angleDeg so consumers (DXF exporter, visual layer) know the orientation.
    return { ...z, x: w.x, y: w.y, ...(angleDeg !== 0 ? { angleDeg } : {}) };
  });
  const blockCenters = xs.map(x => W({ x, y: 0 }));

  // Island metadata. For placed islands the important consumer fields are
  // cx/cy (anchor), angleDeg, southIds/northIds, and the inverterIds list.
  // The legacy y/minX/maxX semantics (which are axis-swapped for vertical
  // islands) are preserved for the 0° and 90° cases so auto-code that reads
  // those fields continues to work; for other angles they hold approximate
  // world-bbox values and angleDeg is the canonical orientation reference.
  const southIds: string[] = [];
  const northIds: string[] = [];
  if (single) {
    southIds.push(`inv-${blockStart}`);
  } else {
    for (let i = 0; i < nCols; i++) {
      southIds.push(`inv-${blockStart + 2 * i}`);
      northIds.push(`inv-${blockStart + 2 * i + 1}`);
    }
    northIds.reverse();
  }
  let info: IslandInfo;
  if (angleDeg === 90) {
    // Vertical: preserve exact axis-swapped convention for backward compat.
    info = {
      n: islandN, y: spec.x, minX: spec.y + minLx, maxX: spec.y + maxLx,
      inverterIds: [...southIds, ...northIds], southIds, northIds,
      placed: true, vertical: true, angleDeg: 90, cx: spec.x, cy: spec.y,
    };
  } else if (angleDeg === 0) {
    // Horizontal: byte-identical to old output.
    info = {
      n: islandN, y: spec.y, minX: spec.x + minLx, maxX: spec.x + maxLx,
      inverterIds: [...southIds, ...northIds], southIds, northIds,
      placed: true, cx: spec.x, cy: spec.y,
    };
  } else {
    // Arbitrary angle: y/minX/maxX hold world-space approximations derived
    // from the world AABB (computed below). angleDeg is the canonical value.
    const wHx = Math.abs(localHx * cosθ) + Math.abs(localHy * sinθ);
    const wHy = Math.abs(localHx * sinθ) + Math.abs(localHy * cosθ);
    info = {
      n: islandN, y: spec.y, minX: spec.x - wHx, maxX: spec.x + wHx,
      inverterIds: [...southIds, ...northIds], southIds, northIds,
      placed: true, angleDeg, cx: spec.x, cy: spec.y,
    };
  }
  // Record a deliberate core-only placement on the island metadata so
  // downstream surfaces (compliance counts, aux collector routing, reports)
  // can tell "the engineer chose not to place a cluster" apart from "the
  // cluster is missing". Covers both ways an island ends up bare: an explicit
  // opt-out, and a SINGLE module, which never carries a cluster. Only ever
  // written as `false` — an island WITH its cluster keeps the field absent, so
  // historical islands stay byte-identical.
  if (!wantAuxCluster) info.auxGear = false;

  // World AABB over every composed item (blocks, gear, aug zones + ghosts).
  // For rotated equipment, use the actual rotated corners for a tight AABB.
  let bMinX = Infinity, bMaxX = -Infinity, bMinY = Infinity, bMaxY = -Infinity;
  const grow = (px: number, py: number, hx: number, hy: number, rot: number) => {
    // Half-extents of the rotated rect projected onto world axes
    const wHx = Math.abs(hx * Math.cos(rot)) + Math.abs(hy * Math.sin(rot));
    const wHy = Math.abs(hx * Math.sin(rot)) + Math.abs(hy * Math.cos(rot));
    if (px - wHx < bMinX) bMinX = px - wHx;
    if (px + wHx > bMaxX) bMaxX = px + wHx;
    if (py - wHy < bMinY) bMinY = py - wHy;
    if (py + wHy > bMaxY) bMaxY = py + wHy;
  };
  for (const e of [...equipment, ...futureEquipment]) {
    grow(e.x, e.y, e.length / 2, e.width / 2, e.rotation);
  }
  for (const z of zones) {
    // Zone length/width are still in local frame; their center is in world frame.
    grow(z.x, z.y, z.length / 2, z.width / 2, angleDeg * Math.PI / 180);
  }
  const bbox = {
    x: (bMinX + bMaxX) / 2, y: (bMinY + bMaxY) / 2,
    hx: (bMaxX - bMinX) / 2, hy: (bMaxY - bMinY) / 2,
  };

  return { equipment, zones, futureEquipment, blockCenters, blockNs, info, bbox, localHx, localHy };
}

export type ManualEquipmentType =
  | 'auxTransformer'
  | 'auxSwitchgear'
  | 'commsCabinet'
  | 'auxSwitchPanel'
  | 'fiberPatchPanel'
  | 'fireControlPanel';
function placeReservedZones(
  boundary: SiteBoundary,
  fence: Pt[],
  equipment: PlacedEquipment[],
  augmentationZones: AugmentationZone[],
  rows: { y: number; minX: number; maxX: number }[],
  fp: BlockFootprint,
  config: BessConfiguration,
  equipmentMargin: number,
  compact: boolean,
  geom: RowEditGeom,
  laydownPctIn: number,
  augmentPctIn: number,
  blocksPlaced: number,
  laydownPin?: Pt | null,
  laydownSizeIn?: { length: number; width: number } | null,
  augPins?: Record<string, Pt> | null,
  aisleOffsets: number[] = [],
  pcsClearance: number = CLEARANCES.pcsHotClimate,
  islands: IslandInfo[] | null = null,
  futurePhaseUnitsIn: number = 0,
  islandAugUnits: Record<number, number> | null = null,
  islandAugEnd: Record<string, 'east' | 'west'> | null = null,
  // Aug pin ids that landed on an accepted placed island — the island wins;
  // these pins are rejected here with the standard stable-prefix warning.
  blockedPinIds: Set<string> | null = null,
  // Drag-placed island seeds: their aug zones/ghosts are composed by the
  // island composer and passed through so every scan below avoids them and
  // the outputs include them. Empty arrays keep the output byte-identical.
  preplacedZones: ReservedZone[] = [],
  preplacedFuture: PlacedEquipment[] = [],
  // Inset from the fence to the OUTSIDE perimeter-road edge (0 when the band
  // runs flush to the fence). Defaults to the historical 10 ft strip so
  // non-flush callers stay byte-identical.
  bandInset: number = CLEARANCES.frontToFence
): { reservedZones: ReservedZone[]; reserveSummary: ReserveSummary | null; reserveWarnings: string[]; futureEquipment: PlacedEquipment[] } {
  // Defensive clamps for non-store callers (the UI store also clamps)
  const laydownPct = Math.min(50, Math.max(0, Number.isFinite(laydownPctIn) ? laydownPctIn : 0));
  const augmentPct = Math.min(100, Math.max(0, Number.isFinite(augmentPctIn) ? augmentPctIn : 0));
  const futurePhaseUnits = Math.max(0, Math.floor(Number.isFinite(futurePhaseUnitsIn) ? futurePhaseUnitsIn : 0));
  // Per-island unit counts: every island reserves DEFAULT_ISLAND_AUG_UNITS
  // by default; an explicit entry overrides (0 disables that island's zone).
  // Clamped to MAX_ISLAND_AUG_UNITS so each feeder stays at 7 built + 2
  // future = 9 PCS total. Explicit entries for islands that no longer exist
  // are kept so the existing "does not exist" warning below fires.
  const clampUnits = (v: unknown, dflt: number) =>
    Math.min(MAX_ISLAND_AUG_UNITS, Math.max(0, Math.floor(
      typeof v === 'number' && Number.isFinite(v) ? v : dflt)));
  const islandUnitEntries: (readonly [number, number])[] = [];
  for (const isl of islands ?? []) {
    // Drag-placed islands carry their own composed augmentation units; the
    // default per-island reserve (and its pin machinery) never applies.
    if (isl.placed) continue;
    const c = clampUnits(islandAugUnits?.[isl.n], DEFAULT_ISLAND_AUG_UNITS);
    if (c > 0) islandUnitEntries.push([isl.n, c] as const);
  }
  for (const [k, v] of Object.entries(islandAugUnits ?? {})) {
    const n = parseInt(k, 10);
    const c = clampUnits(v, 0);
    if (Number.isFinite(n) && n >= 1 && c > 0 && !(islands ?? []).some(i => i.n === n)) {
      islandUnitEntries.push([n, c] as const);
    }
  }
  const reserveWarningsEarly: string[] = [];
  for (const n of Object.keys(islandAugUnits ?? {}).map(Number)) {
    if ((islands ?? []).some(i => i.n === n && i.placed)) {
      reserveWarningsEarly.push(
        `Island ${n} augmentation override ignored: drag-placed islands keep their composed ${DEFAULT_ISLAND_AUG_UNITS}-unit reserve.`);
    }
  }
  // Island augmentation is a mirrored-pair (QTY 3) arrangement: a QTY 4
  // layout has no islands, so the per-island reserve simply does not exist.
  // Say so instead of letting the augmentation ghosts vanish with no reason.
  if (blocksPlaced > 0 && !isMirroredPairConfig(config) && (islands ?? []).length === 0) {
    reserveWarningsEarly.push(
      `Island augmentation is unavailable: this layout is QTY ${config.containersPerBlock}, and ` +
      `per-island augmentation reserves are part of the QTY 3 (mirrored-pair) island arrangement. ` +
      `Switch containers-per-PCS to 3 for island reserves, or use the site-wide augmentation % ` +
      `to reserve future capacity on this layout.`);
  }
  const islandUnitsRequested = islandUnitEntries.reduce((s, [, c]) => s + c, 0);
  const reservedZones: ReservedZone[] = [...preplacedZones];
  const reserveWarnings: string[] = [...reserveWarningsEarly];
  const futureEquipment: PlacedEquipment[] = [...preplacedFuture];
  // Aug UNIT footprint (2 PCS + 6 BESS mirrored pair) — the reserve geometry
  // for every placement path (%, future phase, per-island).
  const augFp = augUnitFootprint(config, pcsClearance);
  // Island-end aug units step off the strip end on the same block gap the
  // strip itself uses (10 ft drawn, 14 ft hot-climate).
  const islandEndGap = pairBlockGapFt(pcsClearance);
  const pushFutureZone = (z: ReservedZone) => {
    reservedZones.push(z);
    futureEquipment.push(...augUnitEquipment(z.id, z.x, z.y, config, pcsClearance));
  };

  // Pins for future-block indexes beyond the currently requested count are
  // dormant (the zone doesn't exist at this augmentation %). Keep the pin —
  // raising the % restores its effect — but tell the drafter it's inactive.
  const dormantRequested = augmentationUnitCount(augmentPct, blocksPlaced) + futurePhaseUnits;
  for (const key of Object.keys(augPins ?? {})) {
    const m = key.match(/^future-blk-(\d+)$/);
    if (!m) continue;
    const idx = parseInt(m[1], 10);
    if (idx > dormantRequested) {
      reserveWarnings.push(
        `Pinned future BESS block ${idx} is dormant: the current augmentation reserve ` +
        `(${augmentPct}%) only creates ${dormantRequested} future unit(s). The pin is kept ` +
        `and will re-apply if the reserve is raised, or reset it in the layout edits panel.`
      );
    }
  }
  // Same for pinned island units whose island (or unit index) does not exist
  // in the current layout — keep the pin, tell the drafter it is inactive.
  for (const key of Object.keys(augPins ?? {})) {
    const m = key.match(/^island-aug-(\d+)-(\d+)$/);
    if (!m) continue;
    const n = parseInt(m[1], 10);
    const k = parseInt(m[2], 10);
    const entry = islandUnitEntries.find(([en]) => en === n);
    if (!entry || k > entry[1]) {
      reserveWarnings.push(
        `Pinned island ${n} augmentation unit ${k} is dormant: the current layout has no ` +
        `such unit. The pin is kept and will re-apply if the unit returns, or reset it in ` +
        `the layout edits panel.`
      );
    }
  }

  if ((laydownPct <= 0 && augmentPct <= 0 && futurePhaseUnits <= 0 && !islandUnitEntries.length) || !fence.length) {
    return { reservedZones, reserveSummary: null, reserveWarnings, futureEquipment };
  }

  const aisleStrips = compact
    ? []
    : computeAisles(rows, fp, insetPolygon(fence, bandInset + CLEARANCES.roadWidth), aisleOffsets);

  // AABB clearance vs. equipment (5 ft pad), aug bays, other reserved zones,
  // and drive aisles — same rules the aux pad / small panels use. Shared with
  // the preview drag ghost via laydownFitReason so both always agree.
  const zoneFits = (cx: number, cy: number, hx: number, hy: number) =>
    laydownFitReason(cx, cy, hx, hy, fence, equipmentMargin, equipment, augmentationZones, reservedZones, aisleStrips) === null;

  const xs = fence.map(p => p.x), ys = fence.map(p => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);

  // ---- Future augmentation units (placed first: 2-PCS + 6-BESS footprints).
  // Count = % reserve (whole units) + explicit future-phase units; per-island
  // units are placed separately below at their island ends.
  const augBlocksRequested = augmentationUnitCount(augmentPct, blocksPlaced) + futurePhaseUnits;
  let augBlocksPlaced = 0;
  if (augBlocksRequested > 0) {
    // Same check the preview drag ghost uses (futureAugFitReason): laydown
    // clearance rules + the NFPA container setback, so both always agree.
    const augFit = (cx: number, cy: number) => futureAugFitReason(
      cx, cy, geom, fence, boundary.polygon,
      equipment, augmentationZones, reservedZones, aisleStrips
    );
    const usedIdx = new Set<number>();

    // Drafter-pinned future blocks first (stable zone id future-blk-N). A pin
    // that no longer fits is rejected with a warning (stable prefix the store
    // checks) and that block falls back to the automatic grid.
    for (let i = 1; i <= augBlocksRequested; i++) {
      const pin = augPins?.[`future-blk-${i}`];
      if (!pin || !Number.isFinite(pin.x) || !Number.isFinite(pin.y)) continue;
      const reason = blockedPinIds?.has(`future-blk-${i}`)
        ? 'it overlaps a drag-placed island (placed equipment is never removed by a pin)'
        : augFit(pin.x, pin.y);
      if (reason) {
        reserveWarnings.push(
          `Pinned future BESS block ${i} rejected: ${reason} — automatic position kept.`
        );
        continue;
      }
      usedIdx.add(i);
      augBlocksPlaced++;
      pushFutureZone({
        id: `future-blk-${i}`,
        kind: 'futureAug',
        x: pin.x, y: pin.y,
        length: augFp.width,
        width: augFp.depth,
        label: `FUTURE BESS BLOCK ${i}`,
      });
    }

    // Automatic grid placement for the remaining (unpinned/rejected) blocks.
    const nextIdx = () => {
      for (let i = 1; ; i++) if (!usedIdx.has(i)) return i;
    };
    // Lattice shared with the preview snap targets via geom.augGrid (built
    // from the same fence bbox / margins in buildLayout).
    const grid = geom.augGrid ?? {
      originX: minX + equipmentMargin + fp.width / 2,
      originY: minY + equipmentMargin + fp.depth / 2,
      stepX: fp.width + CLEARANCES.frontToFront,
      stepY: fp.depth + (compact
        ? CLEARANCES.frontToFront
        : ROW_AISLE_GAP_FT),
    };
    outerAug:
    for (let y = grid.originY; y <= maxY - equipmentMargin; y += grid.stepY) {
      for (let x = grid.originX; x <= maxX - equipmentMargin; x += grid.stepX) {
        if (augBlocksPlaced >= augBlocksRequested) break outerAug;
        if (augFit(x, y) !== null) continue;
        const i = nextIdx();
        usedIdx.add(i);
        augBlocksPlaced++;
        pushFutureZone({
          id: `future-blk-${i}`,
          kind: 'futureAug',
          x, y,
          length: augFp.width,
          width: augFp.depth,
          label: `FUTURE BESS BLOCK ${i}`,
        });
      }
    }
    if (augBlocksPlaced < augBlocksRequested) {
      reserveWarnings.push(
        `Future augmentation: only ${augBlocksPlaced} of ${augBlocksRequested} reserved unit ` +
        `footprint(s) fit inside the fence with required clearances (${augmentPct}% of ` +
        `${blocksPlaced} placed blocks plus ${futurePhaseUnits} future-phase unit(s)). ` +
        'Expand the parcel or reduce the augmentation reserve.'
      );
    }
  }

  // ---- Per-island augmentation units: appended at the island strip ends ----
  if (islandUnitEntries.length) {
    const augFit = (cx: number, cy: number) => futureAugFitReason(
      cx, cy, geom, fence, boundary.polygon,
      equipment, augmentationZones, reservedZones, aisleStrips
    );
    const rejected: string[] = [];
    for (const [n, count] of islandUnitEntries) {
      const isl = islands?.find(i => i.n === n);
      if (!isl) {
        reserveWarnings.push(
          `Island ${n} augmentation unit(s) skipped: island ${n} does not exist in the current layout.`
        );
        continue;
      }
      // Drafter-pinned island units first (stable zone id island-aug-N-K).
      // A pin that no longer fits is rejected with a warning (stable prefix
      // the store checks) and the unit falls back to the automatic
      // island-end scan below.
      const autoKs: number[] = [];
      for (let k = 1; k <= count; k++) {
        const pin = augPins?.[`island-aug-${n}-${k}`];
        if (pin && Number.isFinite(pin.x) && Number.isFinite(pin.y)) {
          const reason = blockedPinIds?.has(`island-aug-${n}-${k}`)
            ? 'it overlaps a drag-placed island (placed equipment is never removed by a pin)'
            : augFit(pin.x, pin.y);
          if (reason) {
            reserveWarnings.push(
              `Pinned island ${n} augmentation unit ${k} rejected: ${reason} — automatic position kept.`
            );
          } else {
            augBlocksPlaced++;
            pushFutureZone({
              id: `island-aug-${n}-${k}`,
              kind: 'futureAug',
              x: pin.x, y: pin.y,
              length: augFp.width,
              width: augFp.depth,
              label: `FUTURE AUG UNIT (ISLAND ${n})`,
            });
            continue;
          }
        }
        autoKs.push(k);
      }
      if (!autoKs.length) continue;
      // Automatic placement: ALL of the island's remaining units go together
      // at ONE end of the strip — east end preferred, then the west end.
      // Splitting one unit per end (or omitting some) is never allowed; if
      // neither end holds the whole group the units are rejected as a group
      // and the caller may rescue by shifting the island.
      let placed = false;
      let lastReason: string | null = null;
      // Drafter end choice reorders the scan (east default). If the chosen
      // end cannot hold the whole group the other end is still tried, with a
      // stable-prefix warning so the store can roll the choice back.
      const endPref = islandAugEnd?.[String(n)];
      const dirs: readonly (1 | -1)[] = endPref === 'west' ? [-1, 1] : [1, -1];
      let placedDir: 1 | -1 = 1;
      for (const dir of dirs) {
        const zMark = reservedZones.length;
        const fMark = futureEquipment.length;
        const aMark = augBlocksPlaced;
        let ok = true;
        for (const k of autoKs) {
          let spot: Pt | null = null;
          for (let slot = 1; slot <= count + 2 && !spot; slot++) {
            const cx = dir === 1
              ? isl.maxX + islandEndGap * slot + augFp.width * (slot - 0.5)
              : isl.minX - islandEndGap * slot - augFp.width * (slot - 0.5);
            const reason = augFit(cx, isl.y);
            if (reason === null) spot = { x: cx, y: isl.y };
            else lastReason = reason;
          }
          if (!spot) { ok = false; break; }
          augBlocksPlaced++;
          pushFutureZone({
            id: `island-aug-${n}-${k}`,
            kind: 'futureAug',
            x: spot.x, y: spot.y,
            length: augFp.width,
            width: augFp.depth,
            label: `FUTURE AUG UNIT (ISLAND ${n})`,
          });
        }
        if (ok) { placed = true; placedDir = dir; break; }
        // This end cannot hold the whole group — roll back its partial
        // placements and try the other end.
        reservedZones.length = zMark;
        futureEquipment.length = fMark;
        augBlocksPlaced = aMark;
      }
      if (placed && endPref && placedDir !== (endPref === 'east' ? 1 : -1)) {
        reserveWarnings.push(
          `Island ${n} augmentation end choice rejected: the ${endPref} end cannot hold the ` +
          `unit group (${lastReason ?? 'no clear spot'}) — units kept at the ${placedDir === 1 ? 'east' : 'west'} end.`
        );
      }
      if (!placed) {
        // No end holds the whole group. Never relocate silently to a
        // detached grid — the reference standard keeps augmentation units
        // together at their own island's end, so surface a per-island
        // warning and let the rescue / drafter handle it instead.
        for (const k of autoKs) {
          rejected.push(`island ${n} unit ${k} (${lastReason ?? 'no clear spot at either island end'})`);
        }
      }
    }
    if (rejected.length) {
      reserveWarnings.push(
        `Island augmentation: ${rejected.length} unit(s) do not fit together at either end of ` +
        `their island with required clearances: ${rejected.join('; ')}. Drag each ghost unit in ` +
        `the site view or set a pin in the layout edits panel to choose a spot — ` +
        `island augmentation is never relocated away from its island.`
      );
    }
  }

  // ---- Construction laydown rectangle (prefers spots near the gate/south) ----
  const fenceAreaSqFt = Math.abs(polygonArea(fence));
  const laydownRequestedSqFt = laydownAreaSqFt(laydownPct, fenceAreaSqFt);
  let laydownPlacedSqFt = 0;
  if (laydownRequestedSqFt > 0) {
    const aspects = [3, 2.5, 2, 1.5, 1, 0.75, 0.5, 0.33]; // length:width candidates
    let placed: { x: number; y: number; len: number; wid: number } | null = null;

    // Drafter-resized rectangle: place EXACTLY this size — at the pin if one
    // is set, otherwise at the first valid spot scanning south to north. If
    // it fits nowhere, reject with a warning (stable prefix the store checks)
    // and fall through to the pin/auto searches below.
    const laydownSize =
      laydownSizeIn &&
      Number.isFinite(laydownSizeIn.length) && Number.isFinite(laydownSizeIn.width) &&
      laydownSizeIn.length >= MIN_LAYDOWN_EDGE_FT && laydownSizeIn.width >= MIN_LAYDOWN_EDGE_FT
        ? laydownSizeIn
        : null;
    if (laydownSize) {
      const len = laydownSize.length, wid = laydownSize.width;
      if (laydownPin && Number.isFinite(laydownPin.x) && Number.isFinite(laydownPin.y)) {
        if (zoneFits(laydownPin.x, laydownPin.y, len / 2, wid / 2)) {
          placed = { x: laydownPin.x, y: laydownPin.y, len, wid };
        }
      } else if (len <= maxX - minX && wid <= maxY - minY) {
        const step = Math.max(10, Math.min(len, wid) / 4);
        sizeScan:
        for (let y = minY + equipmentMargin + wid / 2; y <= maxY - equipmentMargin; y += step) {
          for (let x = minX + equipmentMargin + len / 2; x <= maxX - equipmentMargin; x += step) {
            if (zoneFits(x, y, len / 2, wid / 2)) {
              placed = { x, y, len, wid };
              break sizeScan;
            }
          }
        }
      }
      if (!placed) {
        reserveWarnings.push(
          `Custom laydown size rejected: a ${len.toFixed(0)} x ${wid.toFixed(0)} ft laydown rectangle ` +
          (laydownPin ? 'does not fit at the pinned spot' : 'fits nowhere inside the fence') +
          ' with required clearances. Automatic sizing kept.'
        );
      }
    }

    // Drafter-pinned center: run the same shrink/aspect search, but only at
    // the pinned spot. If nothing fits there, reject the pin (warning with a
    // stable prefix the store checks) and fall back to automatic placement.
    if (!placed && laydownPin && Number.isFinite(laydownPin.x) && Number.isFinite(laydownPin.y)) {
      pinShrink:
      for (let f = 1; f >= 0.1 - 1e-9; f -= 0.1) {
        const area = laydownRequestedSqFt * f;
        for (const a of aspects) {
          const len = Math.sqrt(area * a);
          const wid = area / len;
          if (zoneFits(laydownPin.x, laydownPin.y, len / 2, wid / 2)) {
            placed = { x: laydownPin.x, y: laydownPin.y, len, wid };
            break pinShrink;
          }
        }
      }
      if (!placed) {
        reserveWarnings.push(
          'Pinned laydown area rejected: no laydown rectangle fits at the pinned spot with required ' +
          'clearances. Automatic placement kept.'
        );
      }
    }

    // Automatic placement (no pin, or pin rejected).
    if (!placed) {
      // Try full area first, then shrink in 10% steps down to 10%.
      shrink:
      for (let f = 1; f >= 0.1 - 1e-9; f -= 0.1) {
        const area = laydownRequestedSqFt * f;
        for (const a of aspects) {
          const len = Math.sqrt(area * a);
          const wid = area / len;
          if (len > maxX - minX || wid > maxY - minY) continue;
          // Scan south -> north so the laydown lands near the entrance gate.
          const step = Math.max(10, Math.min(len, wid) / 4);
          for (let y = minY + equipmentMargin + wid / 2; y <= maxY - equipmentMargin; y += step) {
            for (let x = minX + equipmentMargin + len / 2; x <= maxX - equipmentMargin; x += step) {
              if (zoneFits(x, y, len / 2, wid / 2)) {
                placed = { x, y, len, wid };
                break shrink;
              }
            }
          }
        }
      }
    }
    if (placed) {
      laydownPlacedSqFt = placed.len * placed.wid;
      reservedZones.push({
        id: 'laydown-1',
        kind: 'laydown',
        x: placed.x, y: placed.y,
        length: placed.len,
        width: placed.wid,
        label: 'CONSTRUCTION LAYDOWN AREA',
      });
    }
    if (laydownPlacedSqFt < laydownRequestedSqFt * 0.999) {
      const acre = 43560;
      reserveWarnings.push(
        `Laydown area shortfall: placed ${(laydownPlacedSqFt / acre).toFixed(2)} of the requested ` +
        `${(laydownRequestedSqFt / acre).toFixed(2)} acres (${laydownPct}% of the fenced yard). ` +
        'Reduce the laydown %, or stage laydown outside the fence in detailed design.'
      );
    }
  }

  const reserveSummary: ReserveSummary = {
    laydownPct,
    laydownRequestedSqFt,
    laydownPlacedSqFt,
    augPct: augmentPct,
    augBlocksRequested: augBlocksRequested + islandUnitsRequested,
    augBlocksPlaced,
    // Each unit is QTY 2 PCS + QTY 6 containers regardless of the built
    // configuration's containers-per-block.
    augMW: augBlocksPlaced * 2 * config.blockMW,
    augMWh: augBlocksPlaced * 6 * config.containerMWh,
  };
  return { reservedZones, reserveSummary, reserveWarnings, futureEquipment };
}

// 30 ft drive aisles centered in the gap between adjacent block rows
// (aisle centerline midway between the facing row edges). Each strip spans
// the full interior of the yard so it always reaches the perimeter road —
// the road network is built by subtracting these strips from the interior.
export function computeAisles(
  rows: { y: number; minX: number; maxX: number }[],
  fp: BlockFootprint,
  interior: Pt[],
  // Per-aisle centerline offsets (ft, 0-based in south->north order) from a
  // drafter aisle move — the gap changed by 2*offset, so the extra offset
  // lands the aisle exactly at its dragged position. Empty when untouched.
  offsets: number[] = []
): RoadSegment[] {
  const roadW = CLEARANCES.roadWidth;
  const aisles: RoadSegment[] = [];
  if (!interior.length) return aisles;
  const xs = interior.map(p => p.x);
  const x0 = Math.min(...xs) - 1, x1 = Math.max(...xs) + 1;
  const sorted = [...rows].sort((a, b) => a.y - b.y);
  for (let i = 0; i + 1 < sorted.length; i++) {
    const below = sorted[i], above = sorted[i + 1];
    // Centerline midway between the top face of the lower row and the
    // bottom face of the upper row (leaves >= 3 ft to equipment per key note 5)
    const aisleY = (below.y + fp.depth / 2 + (above.y - fp.depth / 2)) / 2 + (offsets[i] ?? 0);
    aisles.push({
      x: (x0 + x1) / 2,
      y: aisleY,
      length: x1 - x0,
      width: roadW,
      rotation: 0,
      id: `aisle-${i}`,
    });
  }
  return aisles;
}

// Automatic middle road between island groups that share a strip row: when
// two (or more) mirrored-pair islands sit on the same aux-corridor line, the
// wide inter-island gap gets a full-height VERTICAL road strip (rotation 90°)
// so the corridor is drivable end to end. The strip is fed into the same
// boolean subtraction as the horizontal drive aisles, so both ends flare into
// the perimeter loop with the standard 58 ft filleted island corners — byte-
// identical in style to the auto top/bottom roads. Placement is conservative:
// the lane must clear EVERY placed rect (equipment, aug bays, reserved zones)
// by the road-edge clearance over the full yard height; when no clear lane
// exists in a gap the road is simply omitted (never evicts anything).
export function computeCorridorAisles(
  islandInfos: IslandInfo[],
  equipment: PlacedEquipment[],
  augmentationZones: AugmentationZone[],
  reservedZones: { x: number; y: number; length: number; width: number }[],
  fence: Pt[],
  // Inset from the fence to the outside perimeter-road edge (0 = flush).
  bandInset: number = CLEARANCES.frontToFence
): RoadSegment[] {
  const segs: RoadSegment[] = [];
  if (islandInfos.length < 2 || fence.length < 3) return segs;
  const roadW = CLEARANCES.roadWidth;
  const clr = CLEARANCES.equipmentToRoadEdge;
  const half = roadW / 2;
  const inner = insetPolygon(fence, bandInset + roadW);
  if (inner.length < 3) return segs;
  const ys = inner.map(p => p.y);
  const y0 = Math.min(...ys) - 1, y1 = Math.max(...ys) + 1;

  // Group islands into strip rows by their corridor centerline y.
  const stripRows: IslandInfo[][] = [];
  for (const isl of [...islandInfos].sort((a, b) => a.y - b.y || a.minX - b.minX)) {
    const row = stripRows.find(r => Math.abs(r[0].y - isl.y) < 1);
    if (row) row.push(isl); else stripRows.push([isl]);
  }

  // Forbidden x-intervals for a full-height lane: every placed rect widened
  // by road-edge clearance + half road width (computed once, shared by gaps).
  const forbidden: [number, number][] = [];
  const block = (x: number, hx: number) => forbidden.push([x - hx - clr - half, x + hx + clr + half]);
  for (const e of equipment) { const h = equipHalves(e); block(e.x, h.hx); }
  for (const z of augmentationZones) block(z.x, z.length / 2);
  for (const z of reservedZones) block(z.x, z.length / 2);
  forbidden.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  for (const row of stripRows) {
    row.sort((a, b) => a.minX - b.minX);
    for (let i = 0; i + 1 < row.length; i++) {
      const lo = row[i].maxX + clr + half;
      const hi = row[i + 1].minX - clr - half;
      if (hi < lo) continue;
      // Free sub-intervals of [lo, hi] after removing the forbidden spans.
      const free: [number, number][] = [];
      let cur = lo;
      for (const [a, b] of forbidden) {
        if (b <= cur) continue;
        if (a >= hi) break;
        if (a > cur) free.push([cur, Math.min(a, hi)]);
        cur = Math.max(cur, b);
        if (cur >= hi) break;
      }
      if (cur < hi) free.push([cur, hi]);
      // Widest free lane wins; ties break toward the west (deterministic).
      let best: [number, number] | null = null;
      for (const f of free) {
        if (!best || f[1] - f[0] > best[1] - best[0] + 1e-9) best = f;
      }
      if (!best) continue;
      const cx = (best[0] + best[1]) / 2;
      // Skip near-duplicate lanes from aligned gaps in other strip rows.
      if (segs.some(s => Math.abs(s.x - cx) < roadW)) continue;
      segs.push({ x: cx, y: (y0 + y1) / 2, length: y1 - y0, width: roadW, rotation: Math.PI / 2 });
    }
  }
  segs.sort((a, b) => a.x - b.x);
  // Stable west->east identity, assigned after the sort so a corridor keeps
  // its id across regenerations (the suppression edit keys off it).
  return segs.map((seg, k) => ({ ...seg, id: `corridor-${k}` }));
}

// Fillet the corners of a closed polygon with radius r, returning a closed
// path of line + arc segments. Corners where the adjacent segments are too
// short get a reduced radius (or stay square if there is no room at all).
export function filletClosedPolygon(poly: Pt[], r: number, skipFillet?: (pt: Pt) => boolean): RoadEdgeSeg[] {
  const n = poly.length;
  const segs: RoadEdgeSeg[] = [];
  if (n < 3) return segs;

  const corners: { T1: Pt; T2: Pt; arc: RoadEdgeSeg | null }[] = [];
  for (let i = 0; i < n; i++) {
    const prev = poly[(i + n - 1) % n];
    const curr = poly[i];
    const next = poly[(i + 1) % n];
    const lenA = Math.hypot(curr.x - prev.x, curr.y - prev.y);
    const lenB = Math.hypot(next.x - curr.x, next.y - curr.y);
    if (lenA < 1e-6 || lenB < 1e-6) {
      corners.push({ T1: curr, T2: curr, arc: null });
      continue;
    }
    // Caller-supplied predicate: skip filleting this specific corner (e.g.
    // the fence-level corners of an entrance strip, which must stay square
    // so they don't produce arc segments that look like gate swing arcs).
    if (skipFillet?.(curr)) {
      corners.push({ T1: curr, T2: curr, arc: null });
      continue;
    }
    const u = { x: (curr.x - prev.x) / lenA, y: (curr.y - prev.y) / lenA };
    const v = { x: (next.x - curr.x) / lenB, y: (next.y - curr.y) / lenB };
    const cross = u.x * v.y - u.y * v.x;
    const dot = Math.max(-1, Math.min(1, u.x * v.x + u.y * v.y));
    const phi = Math.acos(dot); // turn angle at this corner
    if (phi < 0.03 || Math.abs(cross) < 1e-9) {
      corners.push({ T1: curr, T2: curr, arc: null }); // straight — no fillet
      continue;
    }
    // Tangent length from the corner; shrink the radius if segments are short
    // (half of each segment is reserved for the neighboring corner's fillet).
    const maxT = Math.min(lenA, lenB) * 0.475;
    let rEff = r;
    let t = r * Math.tan(phi / 2);
    if (t > maxT) {
      t = maxT;
      rEff = t / Math.tan(phi / 2);
    }
    if (rEff < 0.5) {
      corners.push({ T1: curr, T2: curr, arc: null });
      continue;
    }
    const T1 = { x: curr.x - u.x * t, y: curr.y - u.y * t };
    const T2 = { x: curr.x + v.x * t, y: curr.y + v.y * t };
    const bLen = Math.hypot(v.x - u.x, v.y - u.y);
    const bx = (v.x - u.x) / bLen;
    const by = (v.y - u.y) / bLen;
    const d = rEff / Math.cos(phi / 2); // corner-to-arc-center distance
    const c = { x: curr.x + bx * d, y: curr.y + by * d };
    corners.push({
      T1, T2,
      arc: {
        kind: 'arc', c, r: rEff,
        start: Math.atan2(T1.y - c.y, T1.x - c.x),
        end: Math.atan2(T2.y - c.y, T2.x - c.x),
        ccw: cross > 0,
      },
    });
  }

  for (let i = 0; i < n; i++) {
    const cur = corners[i];
    const nxt = corners[(i + 1) % n];
    if (cur.arc) segs.push(cur.arc);
    if (Math.hypot(nxt.T1.x - cur.T2.x, nxt.T1.y - cur.T2.y) > 0.01) {
      segs.push({ kind: 'line', a: cur.T2, b: nxt.T1 });
    }
  }
  return segs;
}

// Convert a polygon-clipping ring ([x,y] pairs, first point repeated at the
// end) to a Pt[] with the duplicate closing point and near-duplicates removed.
function ringToPts(ring: [number, number][]): Pt[] {
  const pts: Pt[] = [];
  for (const [x, y] of ring) {
    const last = pts[pts.length - 1];
    if (!last || Math.hypot(x - last.x, y - last.y) > 0.05) pts.push({ x, y });
  }
  const first = pts[0], last = pts[pts.length - 1];
  if (pts.length > 1 && Math.hypot(first.x - last.x, first.y - last.y) <= 0.05) pts.pop();
  return pts;
}

// Subtract aisle rectangles from the yard interior via polygon boolean.
// Returns the equipment "islands" (outer ring of each result piece) plus any
// interior holes those pieces contain. Today's full-width aisles can never
// produce a holed piece, but a future road shape (partial aisle, pad cut-out,
// cross-road stub) could — a hole is a road area fully enclosed by equipment,
// which must not be silently dropped from the road network / DXF hatch.
// Exported for regression testing.
export function subtractAislesFromYard(
  innerEdge: Pt[],
  aisleRects: [number, number][][][]
): { islands: Pt[][]; enclosedRoadHoles: Pt[][] } {
  const innerRing: [number, number][] = innerEdge.map(p => [p.x, p.y]);
  const islands: Pt[][] = [];
  const enclosedRoadHoles: Pt[][] = [];
  if (!aisleRects.length) return { islands: [innerEdge], enclosedRoadHoles };
  try {
    const diff = polygonClipping.difference([innerRing], ...aisleRects);
    for (const poly of diff) {
      const outer = ringToPts(poly[0]);
      if (outer.length < 3 || Math.abs(polygonArea(outer)) <= 200) continue; // drop slivers < 200 sqft
      islands.push(outer);
      // Inner rings = road regions fully enclosed inside this island
      for (let i = 1; i < poly.length; i++) {
        const hole = ringToPts(poly[i]);
        if (hole.length >= 3 && Math.abs(polygonArea(hole)) > 200) enclosedRoadHoles.push(hole);
      }
    }
  } catch {
    // Boolean failure (degenerate input) — fall back to the whole interior
    return { islands: [innerEdge], enclosedRoadHoles: [] };
  }
  return { islands, enclosedRoadHoles };
}

// ---- extra road carving (moved-block access rings + drafter-drawn roads) --
// Roads are added by SUBTRACTING strips from the equipment islands: the road
// surface is (outer edge minus islands, even-odd), so any area removed from
// an island becomes road in the render, DXF hatch and surfacing alike.

type PCRing = [number, number][];
const rectRing = (cx: number, cy: number, hx: number, hy: number): PCRing => [
  [cx - hx, cy - hy], [cx + hx, cy - hy], [cx + hx, cy + hy], [cx - hx, cy + hy],
];

// Rectangular strip of `width` along segment a->b, extended by `extend` past
// each end (so joins overlap cleanly).
function segStrip(a: Pt, b: Pt, width: number, extend = 0): PCRing | null {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 0.1) return null;
  const ux = dx / len, uy = dy / len;
  const px = -uy * (width / 2), py = ux * (width / 2);
  const ax = a.x - ux * extend, ay = a.y - uy * extend;
  const bx = b.x + ux * extend, by = b.y + uy * extend;
  return [
    [ax + px, ay + py], [bx + px, by + py],
    [bx - px, by - py], [ax - px, ay - py],
  ];
}

// Road-width strip along an OPEN polyline with rounded (filleted) bends,
// mirroring the auto network's corner treatment: every interior vertex gets
// an annular arc wedge whose inner edge radius targets `innerR` (the sheet-10
// 58 ft inner turning radius) and whose outer edge is concentric at
// innerR + width — a constant-width swept bend. The radius auto-shrinks on
// short adjacent legs using the same half-leg reservation rule as
// filletClosedPolygon; corners with no room at all keep the legacy square
// joint patch so the road never gaps. Returns polygon-clipping rings (the
// caller boolean-unions them into the road carve), or [] when no segment is
// long enough to form a strip. Exported for regression testing.
export function filletPolylineStrip(rawPts: Pt[], width: number, innerR: number): PCRing[] {
  // Non-finite coords pass `len < MIN` style filters (NaN compares false) and
  // would poison the polygon boolean — drop them at this boundary too.
  const pts = (rawPts ?? []).filter(p => p && Number.isFinite(p.x) && Number.isFinite(p.y));
  const n = pts.length;
  if (n < 2) return [];
  const w2 = width / 2;
  const rc = innerR + w2; // centerline fillet radius for the target inner edge

  // Per interior vertex: centerline tangent points + arc, or null (square).
  type Corner = { T1: Pt; T2: Pt; c: Pt; r: number; a1: number; a2: number; ccw: boolean } | null;
  const corners: Corner[] = [];
  for (let i = 1; i < n - 1; i++) {
    const prev = pts[i - 1], curr = pts[i], next = pts[i + 1];
    const lenA = Math.hypot(curr.x - prev.x, curr.y - prev.y);
    const lenB = Math.hypot(next.x - curr.x, next.y - curr.y);
    if (lenA < 1e-6 || lenB < 1e-6) { corners.push(null); continue; }
    const u = { x: (curr.x - prev.x) / lenA, y: (curr.y - prev.y) / lenA };
    const v = { x: (next.x - curr.x) / lenB, y: (next.y - curr.y) / lenB };
    const cross = u.x * v.y - u.y * v.x;
    const dot = Math.max(-1, Math.min(1, u.x * v.x + u.y * v.y));
    const phi = Math.acos(dot); // turn angle
    // Nearly straight: adjacent strips already overlap cleanly — no arc.
    if (phi < 0.03 || Math.abs(cross) < 1e-9) { corners.push(null); continue; }
    // Same short-leg reservation rule as filletClosedPolygon (half of each
    // leg is reserved for the neighboring corner's fillet).
    const maxT = Math.min(lenA, lenB) * 0.475;
    let rEff = rc;
    let t = rc * Math.tan(phi / 2);
    if (t > maxT) { t = maxT; rEff = t / Math.tan(phi / 2); }
    // The inner road edge (rEff - w/2) must keep a real radius, or the wedge
    // degenerates/self-intersects — fall back to the square joint patch.
    if (rEff < w2 + 0.5) { corners.push(null); continue; }
    const T1 = { x: curr.x - u.x * t, y: curr.y - u.y * t };
    const T2 = { x: curr.x + v.x * t, y: curr.y + v.y * t };
    const bLen = Math.hypot(v.x - u.x, v.y - u.y);
    const bx = (v.x - u.x) / bLen, by = (v.y - u.y) / bLen;
    const d = rEff / Math.cos(phi / 2);
    const c = { x: curr.x + bx * d, y: curr.y + by * d };
    corners.push({
      T1, T2, c, r: rEff,
      a1: Math.atan2(T1.y - c.y, T1.x - c.x),
      a2: Math.atan2(T2.y - c.y, T2.x - c.x),
      ccw: cross > 0,
    });
  }

  const rings: PCRing[] = [];
  let anyStrip = false;
  // Trimmed leg strips between the corner tangent points (tiny overlap so
  // the boolean union never leaves hairline slivers at the tangent lines).
  for (let i = 0; i + 1 < n; i++) {
    const a = i > 0 ? (corners[i - 1]?.T2 ?? pts[i]) : pts[i];
    const b = i + 1 < n - 1 ? (corners[i]?.T1 ?? pts[i + 1]) : pts[i + 1];
    const strip = segStrip(a, b, width, 0.05);
    if (strip) { rings.push(strip); anyStrip = true; }
  }
  if (!anyStrip) return [];
  // Corner pieces: annular arc wedge (rounded) or the legacy square patch.
  for (let i = 1; i < n - 1; i++) {
    const cr = corners[i - 1];
    if (!cr) { rings.push(rectRing(pts[i].x, pts[i].y, w2, w2)); continue; }
    // Signed sweep from a1 to a2 in the turn direction (always < PI).
    let sweep = cr.a2 - cr.a1;
    if (cr.ccw) { while (sweep < 0) sweep += Math.PI * 2; }
    else { while (sweep > 0) sweep -= Math.PI * 2; }
    const steps = Math.max(2, Math.ceil(Math.abs(sweep) / (Math.PI / 48))); // ~3.75° chords
    const rOut = cr.r + w2, rIn = cr.r - w2;
    const outer: [number, number][] = [];
    const inner: [number, number][] = [];
    for (let s = 0; s <= steps; s++) {
      const a = cr.a1 + sweep * (s / steps);
      outer.push([cr.c.x + rOut * Math.cos(a), cr.c.y + rOut * Math.sin(a)]);
      inner.push([cr.c.x + rIn * Math.cos(a), cr.c.y + rIn * Math.sin(a)]);
    }
    inner.reverse();
    rings.push([...outer, ...inner]);
  }
  // Legacy square end caps at the polyline endpoints (unchanged behavior:
  // only the interior joints gained fillets).
  rings.push(rectRing(pts[0].x, pts[0].y, w2, w2));
  rings.push(rectRing(pts[n - 1].x, pts[n - 1].y, w2, w2));
  return rings;
}

// Total unsigned area of a polygon-clipping multipolygon (outer rings minus
// holes; polygon-clipping returns holes with opposite winding so the signed
// shoelace sum per polygon already nets them out).
function multiPolyArea(mp: PCRing[][]): number {
  let total = 0;
  for (const poly of mp) {
    for (const ring of poly) {
      let s = 0;
      for (let i = 0; i < ring.length; i++) {
        const [x1, y1] = ring[i];
        const [x2, y2] = ring[(i + 1) % ring.length];
        s += x1 * y2 - x2 * y1;
      }
      total += s / 2;
    }
  }
  return Math.abs(total);
}

// The region where drawn-road surface can legally exist: inside the fence
// road band (fence inset by frontToFence — the outer road edge) and off
// every equipment pad inflated by the road-edge clearance (slightly under,
// so a road sharing an edge with an auto aisle is not flagged). Shared by
// the engine's drawn-road accept gate and the draw-tool live preview so the
// red/green band the drafter sees is exactly what the commit will decide.
export function drawnRoadLegalRegion(
  fence: Pt[],
  equipment: PlacedEquipment[],
  // Inset from the fence to the outside road edge (0 = flush band).
  bandInset: number = CLEARANCES.frontToFence,
  // Clearance inflation around every equipment pad. Compact layouts pass 0:
  // their rows are deliberately packed tighter than the road-edge clearance,
  // so inflating pads would leave no legal corridor anywhere — the pad
  // rectangles themselves still reject any route that actually crosses
  // equipment.
  padClearance: number = CLEARANCES.equipmentToRoadEdge
): PCRing[][] {
  const outer = insetPolygon(fence, bandInset);
  if (outer.length < 3) return [];
  const clr = padClearance;
  let region: PCRing[][] = [[outer.map(p => [p.x, p.y] as [number, number])]];
  const pads: PCRing[][] = equipment.map(e => {
    const h = equipHalves(e);
    return [rectRing(e.x, e.y, h.hx + clr - 0.05, h.hy + clr - 0.05)];
  });
  try {
    if (pads.length) region = polygonClipping.difference(region as any, ...pads as any) as PCRing[][];
  } catch {
    return [];
  }
  return region;
}

// Threshold below which a drawn road adds no meaningful new surface (sqft).
// Shared by the engine's nothing-to-add gate and the draw-tool preview so
// both make the same call.
export const DRAWN_ROAD_MIN_NEW_SQFT = 1;

// Sentinel road id for the gate entrance road, so the one generated road
// piece that has no index can still be named by a `removedRoads` entry.
export const GATE_ENTRANCE_ROAD_ID = 'gate-entrance';

// Minimum road area (sqft) a cut must actually remove before it counts as
// applied. Below this the cut landed off the road surface (or on a road that
// a later edit already deleted) and goes dormant with a warning.
export const ROAD_CUT_MIN_SQFT = 1;

// ---- road deletion (whole roads and point-to-point spans) -----------------
// The rendered road surface is ONE even-odd region: a point is road when the
// number of enclosing loops among {outer} ∪ islands is odd. Deleting road
// area is therefore a parity edit — add the deleted area's rings to the loop
// set and every point inside it flips from odd (road) to even (not road),
// while every point outside keeps its parity untouched.
//
// This is what lets one primitive serve every road kind. The perimeter ring,
// the gate apron, drive aisles, middle roads and drawn roads are not separate
// objects downstream — they are all just area inside this region — so a cut
// does not need to know which kind it hit, and partial spans cost no more
// than whole roads.
//
// Cuts are applied in order and each one is subtracted from the working road
// region before the next is measured. Overlapping cuts would otherwise each
// contribute a ring over the shared area, flipping its parity twice and
// resurrecting road the drafter had deleted.
export function applyRoadCuts(
  outerRing: Pt[],
  loops: Pt[][],
  cuts: RoadCut[]
): { loops: Pt[][]; added: Pt[][]; applied: RoadCut[]; dormant: RoadCut[]; removedSqft: number; road: PCRing[][]; roadBefore: PCRing[][] } {
  if (!cuts.length || outerRing.length < 3) {
    return { loops, added: [], applied: [], dormant: [], removedSqft: 0, road: [], roadBefore: [] };
  }
  const toRing = (pts: Pt[]): PCRing => pts.map(p => [p.x, p.y]);
  let road: PCRing[][];
  try {
    road = polygonClipping.xor(
      [toRing(outerRing)] as any,
      ...loops.map(l => [toRing(l)] as any)
    ) as PCRing[][];
  } catch {
    // Boolean failure on degenerate geometry: keep every road rather than
    // guessing which area to delete.
    return { loops, added: [], applied: [], dormant: [...cuts], removedSqft: 0, road: [], roadBefore: [] };
  }
  // The pre-cut region, kept so access loss can be measured as a CHANGE the
  // cut caused rather than an absolute state. Interior equipment in a large
  // island is normally further than one road-width from pavement, so an
  // absolute check would blame every cut for hundreds of items it never
  // touched and train the drafter to ignore the warning.
  const roadBefore = road;

  const added: Pt[][] = [];
  const applied: RoadCut[] = [];
  const dormant: RoadCut[] = [];
  let removedSqft = 0;

  for (const cut of cuts) {
    const pts = (cut.poly ?? []).filter(p => Number.isFinite(p.x) && Number.isFinite(p.y));
    if (pts.length < 3) { dormant.push(cut); continue; }
    const cutPoly: PCRing[][] = [[toRing(pts)]];
    let piece: PCRing[][];
    try {
      piece = polygonClipping.intersection(cutPoly as any, road as any) as PCRing[][];
    } catch {
      dormant.push(cut);
      continue;
    }
    const area = multiPolyArea(piece);
    if (area < ROAD_CUT_MIN_SQFT) { dormant.push(cut); continue; }
    // Every ring of the removed piece joins the loop set — outer rings AND
    // holes. A cut that swallows a whole equipment island produces a piece
    // with that island as a hole; dropping the hole ring would flip the
    // island itself to road surface.
    for (const poly of piece) {
      for (const ring of poly) {
        const r = ringToPts(ring);
        if (r.length >= 3) added.push(r);
      }
    }
    removedSqft += area;
    applied.push(cut);
    try {
      road = polygonClipping.difference(road as any, cutPoly as any) as PCRing[][];
    } catch { /* keep the un-subtracted region; the next cut just re-measures */ }
  }

  return {
    loops: added.length ? [...loops, ...added] : loops,
    added, applied, dormant, removedSqft, road, roadBefore,
  };
}

// How close a cut remainder must be to its own bounding box before it is
// re-emitted as a rectangle (fraction of the bbox area).
const RECT_REMAINDER_TOL = 0.02;

// Trim road RECTANGLES against the applied cuts.
//
// `roads`/`aisles` are a second, independent representation of the pavement:
// the 3D scene meshes them, the DXF pass draws and SOLID-hatches them, and the
// drainage / grounding / terrain surface models measure them. None of those
// read the boolean road region. Cutting only the region would therefore shrink
// roadNetwork while every one of those surfaces kept redrawing the full uncut
// rectangle — a drafter could delete a stretch of road (the gate driveway is
// the clearest case) and still see it on screen and ship it in the drawing.
//
// A trimmed rect is re-emitted as its rectangular remainder(s) in the road's
// OWN local frame, which is exact for the normal case: a span cut straight
// across a road leaves one or two rectangles. A remainder with no faithful
// rect form — a hole punched mid-road, a diagonal slice — is dropped rather
// than approximated by a bounding box that would hand back pavement the
// drafter deleted. roadNetwork still carries its true shape, so the region,
// the hatch and the surfacing stay correct either way.
export function trimRectsByCuts(rects: RoadSegment[], cuts: RoadCut[]): RoadSegment[] {
  if (!cuts.length || !rects.length) return rects;
  const cutPolys: PCRing[][] = [];
  for (const c of cuts) {
    const pts = (c.poly ?? []).filter(p => Number.isFinite(p.x) && Number.isFinite(p.y));
    if (pts.length >= 3) cutPolys.push([pts.map(p => [p.x, p.y] as [number, number])]);
  }
  if (!cutPolys.length) return rects;

  const out: RoadSegment[] = [];
  for (const r of rects) {
    const hl = r.length / 2, hw = r.width / 2;
    const cos = Math.cos(r.rotation), sin = Math.sin(r.rotation);
    const boxArea = r.length * r.width;
    if (!(boxArea > 0)) { out.push(r); continue; }
    const box: PCRing[][] = [[[[-hl, -hw], [hl, -hw], [hl, hw], [-hl, hw], [-hl, -hw]]]];
    const localCuts = cutPolys.map(mp => mp.map(ring => ring.map(([x, y]) => {
      const dx = x - r.x, dy = y - r.y;
      return [dx * cos + dy * sin, -dx * sin + dy * cos] as [number, number];
    })) as PCRing[]);
    let rest: PCRing[][];
    try {
      rest = polygonClipping.difference(box as any, ...(localCuts as any[])) as PCRing[][];
    } catch {
      // Boolean failure: keep the road rather than guessing it away.
      out.push(r);
      continue;
    }
    const restArea = multiPolyArea(rest);
    // Untouched by every cut: keep the ORIGINAL object so a cut elsewhere in
    // the yard leaves this rect byte-identical (no re-derived float drift).
    if (restArea >= boxArea - ROAD_CUT_MIN_SQFT) { out.push(r); continue; }
    if (restArea < ROAD_CUT_MIN_SQFT) continue; // wholly deleted

    for (const poly of rest) {
      if (poly.length !== 1) continue; // hole punched inside: no rect form
      const pts = ringToPts(poly[0]);
      if (pts.length < 3) continue;
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const p of pts) {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
      }
      const w = maxX - minX, h = maxY - minY;
      if (!(w > 0) || !(h > 0)) continue;
      const pieceArea = multiPolyArea([poly]);
      if (pieceArea < ROAD_CUT_MIN_SQFT) continue;
      // Only a piece that really IS its bounding box may be re-emitted as one.
      if (Math.abs(pieceArea - w * h) > RECT_REMAINDER_TOL * w * h) continue;
      const lx = (minX + maxX) / 2, ly = (minY + maxY) / 2;
      out.push({
        x: r.x + lx * cos - ly * sin,
        y: r.y + lx * sin + ly * cos,
        length: w,
        width: h,
        rotation: r.rotation,
        // Surviving halves stay the same logical road, so selecting or
        // restoring it by id still addresses the whole thing.
        ...(r.id ? { id: r.id } : {}),
      });
    }
  }
  return out;
}

// A plain closed ring as a road edge path (straight segments only). Cut
// boundaries are the exact area the drafter picked, so they are NOT filleted
// — a fillet would round the cut open again and hand back road the drafter
// deleted.
export function ringToEdgePath(ring: Pt[]): RoadEdgeSeg[] {
  const segs: RoadEdgeSeg[] = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    if (Math.hypot(b.x - a.x, b.y - a.y) > 1e-6) segs.push({ kind: 'line', a, b });
  }
  return segs;
}

// The drivable road region as a boolean multi-polygon, recovered from the
// rendered network. Shared by the edit tools (hit-testing, span geometry) and
// the tests so "is this point on a road?" has exactly one definition.
export function roadRegionFromNetwork(
  network: { outer: RoadEdgeSeg[]; islands: RoadEdgeSeg[][] } | null | undefined
): PCRing[][] {
  if (!network || !network.outer.length) return [];
  try {
    const outer = edgeSegsToRing(network.outer);
    if (outer.length < 3) return [];
    const loops = network.islands.map(i => edgeSegsToRing(i)).filter(r => r.length >= 3);
    return polygonClipping.xor(
      [outer.map(p => [p.x, p.y] as [number, number])] as any,
      ...loops.map(l => [l.map(p => [p.x, p.y] as [number, number])] as any)
    ) as PCRing[][];
  } catch { return []; }
}

// Is this point on drivable road surface?
export function pointOnRoad(region: PCRing[][], p: Pt): boolean {
  try {
    const eps = 0.25;
    const probe: PCRing[][] = [[rectRing(p.x, p.y, eps, eps)]];
    const hit = polygonClipping.intersection(probe as any, region as any);
    return hit.length > 0 && multiPolyArea(hit as PCRing[][]) > 0;
  } catch { return false; }
}

// How far the road extends perpendicular to `dir` at point `p`, out to
// `maxFt`. Used to size a span cut to the road it crosses, so the cut spans a
// tapering or non-standard-width road exactly without spilling onto a
// neighbouring parallel road.
export function roadHalfWidthAt(region: PCRing[][], p: Pt, dir: Pt, maxFt = 120): number {
  const len = Math.hypot(dir.x, dir.y);
  if (len < 1e-6) return 0;
  const nx = -dir.y / len, ny = dir.x / len;
  const STEP = 0.5;
  let out = 0;
  for (const s of [1, -1]) {
    let d = 0;
    while (d + STEP <= maxFt) {
      const q = { x: p.x + nx * s * (d + STEP), y: p.y + ny * s * (d + STEP) };
      if (!pointOnRoad(region, q)) break;
      d += STEP;
    }
    out = Math.max(out, d);
  }
  return out;
}

// Point-to-point span deletion: the quad covering the road from `a` to `b`
// across the road's own local width. The returned polygon is deliberately
// generous along the perpendicular (the measured half-width plus a margin) —
// applyRoadCuts intersects it with the real road region, so the cut lands
// exactly on road surface and stops at the road edge, whatever shape the road
// is. Returns null when neither endpoint is on a road.
export function roadSpanCutPoly(
  region: PCRing[][],
  a: Pt,
  b: Pt,
  marginFt = 1.5
): Pt[] | null {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 0.5 || !region.length) return null;
  const ux = dx / len, uy = dy / len;
  // Measure at both ends and the midpoint so a tapering road (wide gate apron
  // narrowing to a standard aisle) is still fully spanned.
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const hw = Math.max(
    roadHalfWidthAt(region, a, { x: ux, y: uy }),
    roadHalfWidthAt(region, mid, { x: ux, y: uy }),
    roadHalfWidthAt(region, b, { x: ux, y: uy }),
  ) + marginFt;
  if (hw <= marginFt) return null; // neither endpoint nor middle sits on road
  const px = -uy * hw, py = ux * hw;
  // Extend a hair past each end so the cut fully severs the road rather than
  // leaving a hairline sliver bridging the two sides.
  const ax = a.x - ux * 0.05, ay = a.y - uy * 0.05;
  const bx = b.x + ux * 0.05, by = b.y + uy * 0.05;
  return [
    { x: ax + px, y: ay + py },
    { x: bx + px, y: by + py },
    { x: bx - px, y: by - py },
    { x: ax - px, y: ay - py },
  ];
}

// Local direction of travel of the road at `p`: the heading along which the
// road surface extends farthest. Used to cut ACROSS a road (severing it)
// rather than along it, without needing to know which road it is.
export function roadTravelDirAt(region: PCRing[][], p: Pt, maxFt = 200): Pt | null {
  if (!region.length || !pointOnRoad(region, p)) return null;
  const STEP = 1;
  let best: { dir: Pt; reach: number } | null = null;
  for (let deg = 0; deg < 180; deg += 5) {
    const a = (deg * Math.PI) / 180;
    const ux = Math.cos(a), uy = Math.sin(a);
    let reach = 0;
    for (const s of [1, -1]) {
      let d = 0;
      while (d + STEP <= maxFt) {
        const q = { x: p.x + ux * s * (d + STEP), y: p.y + uy * s * (d + STEP) };
        if (!pointOnRoad(region, q)) break;
        d += STEP;
      }
      reach += d;
    }
    if (!best || reach > best.reach) best = { dir: { x: ux, y: uy }, reach };
  }
  return best ? best.dir : null;
}

// Sever the road at `p`: a band ACROSS the road (perpendicular to its local
// direction of travel), as wide as the road actually is there. This is how a
// click on the unnamed perimeter ring becomes a deletion — the ring is one
// continuous loop with no id, so the only meaningful "delete this road" at a
// point is to cut the loop there.
export function ringSpanCutAt(region: PCRing[][], p: Pt, alongFt = 26): Pt[] | null {
  const dir = roadTravelDirAt(region, p);
  if (!dir) return null;
  // The cut runs perpendicular to travel; roadSpanCutPoly then measures the
  // road width across ITS direction, which is the travel direction again.
  const half = alongFt / 2;
  const a = { x: p.x - dir.x * half, y: p.y - dir.y * half };
  const b = { x: p.x + dir.x * half, y: p.y + dir.y * half };
  // Span from a to b covers `alongFt` of travel; its width is measured
  // perpendicular, i.e. across the road. That is exactly a severing cut.
  return roadSpanCutPoly(region, a, b);
}

// ---------------------------------------------------------------------------
// Road-following deletion geometry.
//
// A straight quad between two picked points is only ever correct when both
// points sit on ONE straight run: the moment a drafter picks around a corner,
// the quad slashes diagonally across the yard interior and takes everything
// with it. Everything below instead follows the road SURFACE, so a cut is
// always road-shaped no matter how the road bends.
// ---------------------------------------------------------------------------

// Even-odd point test straight against the region rings. pointOnRoad() runs a
// boolean intersection per call, which is far too slow to drive a grid search
// (hundreds of thousands of probes); this is the same predicate in O(edges).
function ringContainsPt(ring: PCRing, p: Pt): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if ((yi > p.y) !== (yj > p.y)) {
      const xint = xi + ((p.y - yi) / (yj - yi)) * (xj - xi);
      if (p.x < xint) inside = !inside;
    }
  }
  return inside;
}

export function pointOnRoadFast(region: PCRing[][], p: Pt): boolean {
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return false;
  for (const poly of region) {
    if (!poly.length || !ringContainsPt(poly[0], p)) continue;
    let inHole = false;
    for (let i = 1; i < poly.length; i++) {
      if (ringContainsPt(poly[i], p)) { inHole = true; break; }
    }
    if (!inHole) return true;
  }
  return false;
}

// Half-width of the road at `p` measured across `dir`, using the fast probe.
export function roadHalfWidthAtFast(region: PCRing[][], p: Pt, dir: Pt, maxFt = 120): number {
  const len = Math.hypot(dir.x, dir.y);
  if (len < 1e-6) return 0;
  const nx = -dir.y / len, ny = dir.x / len;
  const STEP = 0.5;
  let out = 0;
  for (const s of [1, -1]) {
    let d = 0;
    while (d + STEP <= maxFt) {
      const q = { x: p.x + nx * s * (d + STEP), y: p.y + ny * s * (d + STEP) };
      if (!pointOnRoadFast(region, q)) break;
      d += STEP;
    }
    out = Math.max(out, d);
  }
  return out;
}

// Local direction of travel at `p` (the heading the road reaches farthest
// along), fast enough to call while marching.
export function roadTravelDirAtFast(region: PCRing[][], p: Pt, maxFt = 160): Pt | null {
  if (!pointOnRoadFast(region, p)) return null;
  const STEP = 2;
  let best: { dir: Pt; reach: number } | null = null;
  for (let deg = 0; deg < 180; deg += 5) {
    const a = (deg * Math.PI) / 180;
    const ux = Math.cos(a), uy = Math.sin(a);
    let reach = 0;
    for (const s of [1, -1]) {
      let d = 0;
      while (d + STEP <= maxFt) {
        const q = { x: p.x + ux * s * (d + STEP), y: p.y + uy * s * (d + STEP) };
        if (!pointOnRoadFast(region, q)) break;
        d += STEP;
      }
      reach += d;
    }
    if (!best || reach > best.reach) best = { dir: { x: ux, y: uy }, reach };
  }
  return best ? best.dir : null;
}

// Build one cut polygon that follows `path` along the road, sized at every
// step to the road's own local width. Consecutive quads overlap, so the union
// is a single connected corridor. applyRoadCuts intersects it with the real
// road region, so a small perpendicular margin never spills off the pavement.
export function roadCorridorCutPoly(
  region: PCRing[][],
  path: Pt[],
  marginFt = 1.5
): Pt[] | null {
  if (path.length < 2 || !region.length) return null;

  // Half-width per segment, measured across the segment's own heading.
  // Deliberately a MEDIAN of samples, not a max: at a T-junction or a corner
  // the perpendicular probe shoots straight down the joining road, and a max
  // would inflate the whole corridor to the length of that side road (a 24 ft
  // road cutting a 243 ft swathe). The median ignores those few outliers.
  const median = (v: number[]): number => {
    if (!v.length) return 0;
    const s = [...v].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  const segs: { a: Pt; b: Pt; u: Pt; hw: number }[] = [];
  const all: number[] = [];
  for (let i = 0; i + 1 < path.length; i++) {
    const a = path[i], b = path[i + 1];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) continue;
    const u = { x: dx / len, y: dy / len };
    const n = Math.max(3, Math.min(9, Math.ceil(len / 8)));
    const hws: number[] = [];
    for (let k = 0; k <= n; k++) {
      const q = { x: a.x + dx * (k / n), y: a.y + dy * (k / n) };
      const h = roadHalfWidthAtFast(region, q, u);
      if (h > 0) { hws.push(h); all.push(h); }
    }
    if (!hws.length) continue;
    segs.push({ a, b, u, hw: median(hws) });
  }
  if (!segs.length) return null;
  // A road may legitimately widen (gate apron), so allow generous headroom
  // over the typical width — but never the unbounded reach of a junction.
  const cap = Math.max(median(all) * 1.8, 14);

  const quads: PCRing[][] = [];
  for (const sg of segs) {
    const { a, b, u } = sg;
    const hw = Math.min(sg.hw, cap) + marginFt;
    if (hw <= marginFt) continue;
    const ux = u.x, uy = u.y;
    const px = -uy * hw, py = ux * hw;
    // Overshoot each end so successive quads overlap around bends instead of
    // leaving a wedge of pavement at the inside of a corner. Capped, or a
    // wide segment would push the cut well past the drafter's last click.
    const over = Math.min(hw, 14);
    const ax = a.x - ux * over, ay = a.y - uy * over;
    const bx = b.x + ux * over, by = b.y + uy * over;
    quads.push([[
      [ax + px, ay + py], [bx + px, by + py],
      [bx - px, by - py], [ax - px, ay - py],
    ] as PCRing]);
  }
  if (!quads.length) return null;
  try {
    const merged = quads.length === 1
      ? (quads[0] as unknown as PCRing[][])
      : (polygonClipping.union(quads[0] as any, ...quads.slice(1).map(q => q as any)) as PCRing[][]);
    const polys = (quads.length === 1 ? [quads[0]] : merged) as PCRing[][];
    let best: PCRing | null = null, bestA = 0;
    for (const poly of polys) {
      const ring = Array.isArray(poly[0]) && typeof (poly as any)[0][0] === 'number'
        ? (poly as unknown as PCRing) : poly[0];
      if (!ring || ring.length < 3) continue;
      const a = Math.abs(polygonArea(ring.map(q => ({ x: q[0], y: q[1] }))));
      if (a > bestA) { bestA = a; best = ring; }
    }
    if (!best) return null;
    return best.map(q => ({ x: q[0], y: q[1] }));
  } catch { return null; }
}

// The whole straight RUN of road through `p`: march along the local travel
// direction until the pavement ends. On the unnamed perimeter ring this is
// what "delete this road" means — a click on the north side selects the whole
// north side, corner to corner, not a stub.
export function roadRunAt(region: PCRing[][], p: Pt, maxFt = 20000): Pt[] | null {
  const dir = roadTravelDirAtFast(region, p);
  if (!dir) return null;
  const STEP = 2;
  const ends: Pt[] = [];
  for (const s of [1, -1]) {
    let cur = { x: p.x, y: p.y };
    let d = 0;
    while (d + STEP <= maxFt) {
      const nxt = { x: cur.x + dir.x * s * STEP, y: cur.y + dir.y * s * STEP };
      if (!pointOnRoadFast(region, nxt)) break;
      cur = nxt; d += STEP;
    }
    ends.push(cur);
  }
  const [fwd, back] = ends;
  if (Math.hypot(fwd.x - back.x, fwd.y - back.y) < 1) return null;
  // Sample along the run so a width change partway (gate apron → aisle) is
  // still spanned exactly.
  const path: Pt[] = [];
  const total = Math.hypot(fwd.x - back.x, fwd.y - back.y);
  const steps = Math.max(1, Math.ceil(total / 40));
  for (let i = 0; i <= steps; i++) {
    path.push({
      x: back.x + (fwd.x - back.x) * (i / steps),
      y: back.y + (fwd.y - back.y) * (i / steps),
    });
  }
  return path;
}

// Occupancy grid of the road surface, filled by scanline so building it costs
// O(rows x edges) rather than a point test per cell.
type RoadGrid = {
  cell: number; minX: number; minY: number; nx: number; ny: number;
  road: Uint8Array; clear: Int32Array;
};

function buildRoadGrid(region: PCRing[][], cell: number): RoadGrid | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const edges: { x0: number; y0: number; x1: number; y1: number }[] = [];
  for (const poly of region) {
    for (const ring of poly) {
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i], b = ring[(i + 1) % ring.length];
        edges.push({ x0: a[0], y0: a[1], x1: b[0], y1: b[1] });
        if (a[0] < minX) minX = a[0]; if (a[0] > maxX) maxX = a[0];
        if (a[1] < minY) minY = a[1]; if (a[1] > maxY) maxY = a[1];
      }
    }
  }
  if (!edges.length || !Number.isFinite(minX)) return null;
  minX -= cell; minY -= cell; maxX += cell; maxY += cell;
  const nx = Math.ceil((maxX - minX) / cell), ny = Math.ceil((maxY - minY) / cell);
  if (nx < 2 || ny < 2 || nx * ny > 4_000_000) return null;
  const road = new Uint8Array(nx * ny);
  const xs: number[] = [];
  for (let j = 0; j < ny; j++) {
    const y = minY + (j + 0.5) * cell;
    xs.length = 0;
    for (const e of edges) {
      if ((e.y0 > y) !== (e.y1 > y)) {
        xs.push(e.x0 + ((y - e.y0) / (e.y1 - e.y0)) * (e.x1 - e.x0));
      }
    }
    if (xs.length < 2) continue;
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const i0 = Math.max(0, Math.ceil((xs[k] - minX) / cell - 0.5));
      const i1 = Math.min(nx - 1, Math.floor((xs[k + 1] - minX) / cell - 0.5));
      for (let i = i0; i <= i1; i++) road[j * nx + i] = 1;
    }
  }
  // Clearance in cells (multi-source BFS out from non-road), so the route can
  // be biased toward the middle of the pavement instead of hugging an edge.
  const clear = new Int32Array(nx * ny).fill(-1);
  const q = new Int32Array(nx * ny);
  let qh = 0, qt = 0;
  for (let i = 0; i < road.length; i++) if (!road[i]) { clear[i] = 0; q[qt++] = i; }
  while (qh < qt) {
    const c = q[qh++]; const cx = c % nx, cy = (c / nx) | 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const ax = cx + dx, ay = cy + dy;
      if (ax < 0 || ay < 0 || ax >= nx || ay >= ny) continue;
      const ai = ay * nx + ax;
      if (clear[ai] !== -1) continue;
      clear[ai] = clear[c] + 1; q[qt++] = ai;
    }
  }
  return { cell, minX, minY, nx, ny, road, clear };
}

// Route from `a` to `b` THROUGH the road surface. This is what makes a
// point-to-point deletion behave: pick two points anywhere on a road and the
// cut follows the pavement between them, around corners and junctions,
// instead of cutting the straight line across whatever lies between.
// Returns null when the two points are not connected by road.
export function roadPathBetween(
  region: PCRing[][],
  a: Pt,
  b: Pt,
  cellFt = 6
): Pt[] | null {
  if (!region.length) return null;
  const g = buildRoadGrid(region, cellFt);
  if (!g) return null;
  const { nx, ny, cell, minX, minY, road, clear } = g;
  const idxOf = (p: Pt): number => {
    let i = Math.round((p.x - minX) / cell - 0.5);
    let j = Math.round((p.y - minY) / cell - 0.5);
    i = Math.max(0, Math.min(nx - 1, i)); j = Math.max(0, Math.min(ny - 1, j));
    if (road[j * nx + i]) return j * nx + i;
    // Snap to the nearest road cell: a pick can land a foot off the surface.
    for (let r = 1; r <= 6; r++) {
      let bestI = -1, bestD = Infinity;
      for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
        const ai = i + di, aj = j + dj;
        if (ai < 0 || aj < 0 || ai >= nx || aj >= ny) continue;
        const k = aj * nx + ai;
        if (!road[k]) continue;
        const d = di * di + dj * dj;
        if (d < bestD) { bestD = d; bestI = k; }
      }
      if (bestI >= 0) return bestI;
    }
    return -1;
  };
  const s = idxOf(a), t = idxOf(b);
  if (s < 0 || t < 0) return null;
  if (s === t) return null;

  // Dijkstra with a centre bias, so the route runs down the middle of the
  // pavement and the corridor it produces is symmetric about the road.
  const N = nx * ny;
  const dist = new Float64Array(N).fill(Infinity);
  const prev = new Int32Array(N).fill(-1);
  const visited = new Uint8Array(N);
  // Bucket queue keyed on rounded cost keeps this dependency-free and fast.
  const heap: { i: number; d: number }[] = [{ i: s, d: 0 }];
  dist[s] = 0;
  const push = (i: number, d: number) => {
    heap.push({ i, d });
    let c = heap.length - 1;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (heap[p].d <= heap[c].d) break;
      const tmp = heap[p]; heap[p] = heap[c]; heap[c] = tmp; c = p;
    }
  };
  const pop = (): { i: number; d: number } | null => {
    if (!heap.length) return null;
    const top = heap[0], last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      let c = 0;
      for (;;) {
        const l = c * 2 + 1, r = l + 1;
        let m = c;
        if (l < heap.length && heap[l].d < heap[m].d) m = l;
        if (r < heap.length && heap[r].d < heap[m].d) m = r;
        if (m === c) break;
        const tmp = heap[m]; heap[m] = heap[c]; heap[c] = tmp; c = m;
      }
    }
    return top;
  };
  while (heap.length) {
    const cur = pop()!;
    if (visited[cur.i]) continue;
    visited[cur.i] = 1;
    if (cur.i === t) break;
    const cx = cur.i % nx, cy = (cur.i / nx) | 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const ax = cx + dx, ay = cy + dy;
      if (ax < 0 || ay < 0 || ax >= nx || ay >= ny) continue;
      const ai = ay * nx + ax;
      if (!road[ai] || visited[ai]) continue;
      const step = (dx && dy) ? Math.SQRT2 : 1;
      const bias = 1 + 2 / (1 + clear[ai]);
      const nd = cur.d + step * bias;
      if (nd < dist[ai]) { dist[ai] = nd; prev[ai] = cur.i; push(ai, nd); }
    }
  }
  if (!visited[t] || prev[t] < 0) return null;
  const cells: number[] = [];
  for (let c = t; c !== -1; c = prev[c]) { cells.push(c); if (c === s) break; }
  cells.reverse();
  const toPt = (c: number): Pt => ({
    x: minX + ((c % nx) + 0.5) * cell,
    y: minY + (((c / nx) | 0) + 0.5) * cell,
  });
  // Keep the true endpoints; decimate the middle to corner points only, so the
  // corridor is built from a handful of quads rather than one per cell.
  const raw = cells.map(toPt);
  const path: Pt[] = [a];
  let lastDir: Pt | null = null;
  for (let i = 1; i + 1 < raw.length; i++) {
    const p0 = path[path.length - 1], p1 = raw[i];
    const dx = p1.x - p0.x, dy = p1.y - p0.y;
    const L = Math.hypot(dx, dy);
    if (L < cell) continue;
    const d = { x: dx / L, y: dy / L };
    if (!lastDir || (d.x * lastDir.x + d.y * lastDir.y) < 0.985 || L > 60) {
      path.push(p1); lastDir = d;
    }
  }
  path.push(b);
  return path.length >= 2 ? path : null;
}

// Does this traced road contribute NO pavement to the rendered road region?
// Linework-only status is a render-time OUTCOME (the gate-apron rule plus
// any pave-as-drawn override), not a stored flag, so the edit tools re-probe
// the region: sampled points along the drawn centerline (plus the drawn
// ring's centroid when one exists) all landing off-pavement means the strip
// rendered as reference linework only. Used to decide when to offer the
// force-pave action and to make unpaved strips selectable from their
// linework. Sampling is stride-capped — the answer is binary (a strip either
// paves or it doesn't), so a handful of probes along the run is enough.
export function tracedRoadRendersUnpaved(
  region: PCRing[][],
  rec: { pts: Pt[]; surface?: Pt[]; outline?: Pt[] },
): boolean {
  const probes: Pt[] = [];
  const segs = rec.pts.length - 1;
  const step = Math.max(1, Math.ceil(segs / 8));
  for (let i = 0; i < segs; i += step) {
    probes.push({ x: (rec.pts[i].x + rec.pts[i + 1].x) / 2, y: (rec.pts[i].y + rec.pts[i + 1].y) / 2 });
  }
  if (!probes.length && rec.pts.length) probes.push({ x: rec.pts[0].x, y: rec.pts[0].y });
  const ring = (rec.surface?.length ?? 0) >= 3 ? rec.surface!
    : (rec.outline?.length ?? 0) >= 3 ? rec.outline! : null;
  if (ring) {
    probes.push({
      x: ring.reduce((s, q) => s + q.x, 0) / ring.length,
      y: ring.reduce((s, q) => s + q.y, 0) / ring.length,
    });
  }
  if (!probes.length) return false;
  return probes.every(q => !pointOnRoad(region, q));
}

// Which named road piece sits under this point? Generated aisles and middle
// roads, the gate entrance and drafter-drawn roads all carry identity, so a
// click on one can delete that whole road. The perimeter ring deliberately
// has none (it is the yard's only continuous loop) — a click there selects
// the whole straight run through the pick instead.
export type RoadPick =
  | { kind: 'aisle' | 'corridor' | 'gate'; id: string; label: string }
  | { kind: 'drawn'; id: string; label: string };

export function roadPieceAt(
  p: Pt,
  aisles: RoadSegment[],
  roads: RoadSegment[],
  customRoads: { id: string; pts: Pt[]; width?: number; traced?: boolean; tracedV?: number; outline?: Pt[]; surface?: Pt[]; entrance?: boolean; gate?: Pt; apron?: boolean }[] = []
): RoadPick | null {
  const inRect = (r: RoadSegment): boolean => {
    const c = Math.cos(-r.rotation), s = Math.sin(-r.rotation);
    const dx = p.x - r.x, dy = p.y - r.y;
    const lx = dx * c - dy * s, ly = dx * s + dy * c;
    return Math.abs(lx) <= r.length / 2 && Math.abs(ly) <= r.width / 2;
  };
  // Drawn roads first: they are carved on top of the auto network, so where
  // they overlap an aisle the drafter means the road they drew.
  for (const r of customRoads) {
    // A verbatim-surface traced road (closed outline or flare) covers its
    // whole drawn polygon, not just the representative centerline strip.
    const ring = (r.surface?.length ?? 0) >= 3 ? r.surface!
      : (r.outline?.length ?? 0) >= 3 ? r.outline! : undefined;
    if (r.traced && ring && pointInPolygon(p, ring)) {
      return { kind: 'drawn', id: r.id, label: 'Drawn access road' };
    }
    const hw = ((r.width && Number.isFinite(r.width))
      ? Math.max(12, Math.min(60, r.width)) : CLEARANCES.roadWidth) / 2;
    for (let i = 0; i + 1 < r.pts.length; i++) {
      const a = r.pts[i], b = r.pts[i + 1];
      const vx = b.x - a.x, vy = b.y - a.y;
      const L2 = vx * vx + vy * vy;
      if (L2 < 1e-9) continue;
      const t = Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / L2));
      const q = { x: a.x + vx * t, y: a.y + vy * t };
      if (Math.hypot(q.x - p.x, q.y - p.y) <= hw) {
        return { kind: 'drawn', id: r.id, label: 'Drawn access road' };
      }
    }
  }
  for (const a of aisles) {
    if (!a.id || !inRect(a)) continue;
    return a.id.startsWith('corridor-')
      ? { kind: 'corridor', id: a.id, label: `Middle road ${a.id.replace('corridor-', '')}` }
      : { kind: 'aisle', id: a.id, label: `Drive aisle ${a.id.replace('aisle-', '')}` };
  }
  for (const r of roads) {
    if (r.id === GATE_ENTRANCE_ROAD_ID && inRect(r)) {
      return { kind: 'gate', id: r.id, label: 'Gate entrance road' };
    }
  }
  return null;
}

// Does the road region still reach every equipment island / placed rect?
// Used to report access loss after a deletion instead of hiding it.
export function roadAccessLoss(
  road: PCRing[][],
  items: { id: string; x: number; y: number; hx: number; hy: number }[],
  reachFt: number
): string[] {
  if (!road.length) return items.map(i => i.id);
  const lost: string[] = [];
  for (const it of items) {
    try {
      const probe: PCRing[][] = [[rectRing(it.x, it.y, it.hx + reachFt, it.hy + reachFt)]];
      const touch = polygonClipping.intersection(probe as any, road as any);
      if (!touch.length || multiPolyArea(touch as PCRing[][]) < 1) lost.push(it.id);
    } catch { /* boolean failure: never invent an access warning */ }
  }
  return lost;
}

// Convert a rendered road-network island (line + arc segments) back into a
// plain polygon ring by sampling arcs — lets the draw-tool preview run the
// same strip-vs-islands overlap the commit gate runs, without re-deriving
// the island polygons. Fillets shave only convex corner wedges, so overlap
// computed on these rings tracks the engine's pre-fillet check closely.
export function roadNetworkIslandPolys(network: { islands: RoadEdgeSeg[][] } | null | undefined): Pt[][] {
  if (!network) return [];
  const out: Pt[][] = [];
  for (const isl of network.islands) {
    const ring: Pt[] = [];
    for (const s of isl) {
      if (s.kind === 'line') ring.push(s.a);
      else {
        const steps = Math.max(2, Math.ceil(Math.abs(s.end - s.start) / (Math.PI / 24)));
        for (let i = 0; i < steps; i++) {
          const a = s.start + (s.end - s.start) * (i / steps);
          ring.push({ x: s.c.x + s.r * Math.cos(a), y: s.c.y + s.r * Math.sin(a) });
        }
      }
    }
    if (ring.length >= 3) out.push(ring);
  }
  return out;
}

// Evaluate a drawn road polyline against the legal region: how much of the
// filleted road strip materializes as drivable surface, and which parts are
// blocked (by equipment clearance or the fence setback). frac is
// blocked-area-free fraction of the strip in [0, 1]; blocked holds the
// offending sub-region for preview highlighting. When `islands` (non-road
// yard polygons) are supplied, newArea reports how much of the strip would
// become NEW road surface — the same overlap the commit's nothing-to-add
// gate measures.
export function evaluateDrawnRoad(
  pts: Pt[],
  fence: Pt[],
  equipment: PlacedEquipment[],
  legalRegion?: PCRing[][],
  islands?: Pt[][],
  // Road width for this specific route. Defaults to the site standard (24 ft)
  // so callers that never override the width stay byte-identical to the
  // pre-width-feature behavior.
  width = CLEARANCES.roadWidth,
): { frac: number; stripArea: number; blockedArea: number; newArea: number; strip: PCRing[][]; blocked: PCRing[][] } {
  const empty = { frac: 0, stripArea: 0, blockedArea: 0, newArea: 0, strip: [] as PCRing[][], blocked: [] as PCRing[][] };
  const pieces = filletPolylineStrip(pts, width, CLEARANCES.roadInnerRadius);
  if (!pieces.length) return empty;
  let strip: PCRing[][];
  try {
    const polys = pieces.map(r => [r]);
    strip = (polys.length > 1
      ? polygonClipping.union(polys[0] as any, ...(polys.slice(1) as any[]))
      : polys) as PCRing[][];
  } catch {
    return empty;
  }
  const stripArea = multiPolyArea(strip);
  if (stripArea <= 0) return empty;
  const legal = legalRegion ?? drawnRoadLegalRegion(fence, equipment);
  let blocked: PCRing[][];
  try {
    blocked = legal.length
      ? (polygonClipping.difference(strip as any, legal as any) as PCRing[][])
      : strip;
  } catch {
    // Boolean failure: treat as fully blocked so a broken check never
    // silently accepts a road that might vanish downstream.
    return { frac: 0, stripArea, blockedArea: stripArea, newArea: 0, strip, blocked: strip };
  }
  const blockedArea = multiPolyArea(blocked);
  // New-surface overlap: strip ∩ non-road yard polygons. Same measurement
  // as the commit's nothing-to-add gate (which uses the pre-fillet island
  // polygons; fillets only shave convex corner wedges, so preview callers
  // passing sampled rendered islands track it closely).
  let newArea = 0;
  if (islands?.length) {
    try {
      const over = polygonClipping.intersection(
        strip as any,
        islands.map(p => [p.map(q => [q.x, q.y] as [number, number])]) as any
      );
      newArea = multiPolyArea(over as PCRing[][]);
    } catch { newArea = 0; }
  }
  return { frac: Math.max(0, 1 - blockedArea / stripArea), stripArea, blockedArea, newArea, strip, blocked };
}

// Axis-aligned half-extents of a placed equipment item, accounting for
// 90-degree rotations (yard equipment is always placed orthogonally).
export function equipHalves(e: PlacedEquipment): { hx: number; hy: number } {
  // rotation is in RADIANS (same convention as every other orientation check).
  const swapped = Math.abs(Math.sin(e.rotation)) > 0.5;
  const hl = e.length / 2, hw = e.width / 2;
  return swapped ? { hx: hw, hy: hl } : { hx: hl, hy: hw };
}

// Carve `carve` (multi-polygon, site feet) out of the island polygons.
// Returns EVERY resulting ring — outer rings and holes alike — because the
// road network hatch/render is even-odd over all loops (outer = road,
// island = not road, hole in island = road, pad inside hole = not road).
export function carveIslands(islands: Pt[][], carve: PCRing[][]): Pt[][] {
  if (!carve.length) return islands;
  try {
    const subject = islands.map(p => [p.map(q => [q.x, q.y] as [number, number])]);
    const diff = polygonClipping.difference(subject as any, carve as any);
    const loops: Pt[][] = [];
    for (const poly of diff) {
      for (const ring of poly) {
        const pts = ringToPts(ring);
        if (pts.length >= 3 && Math.abs(polygonArea(pts)) > 100) loops.push(pts);
      }
    }
    return loops;
  } catch {
    return islands; // boolean failure: keep the un-carved islands
  }
}

// Tessellate a filleted closed road edge path (lines + fillet arcs) into a
// plain polygon ring for boolean operations. Arc chords <= maxChordFt so the
// surfacing regions hug the filleted road edges with no gaps or overlaps.
export function edgeSegsToRing(segs: RoadEdgeSeg[], maxChordFt = 2): Pt[] {
  const pts: Pt[] = [];
  const push = (p: Pt) => {
    const last = pts[pts.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) > 0.05) pts.push(p);
  };
  for (const s of segs) {
    if (s.kind === 'line') {
      push(s.a);
      push(s.b);
    } else {
      let sweep = s.end - s.start;
      if (s.ccw) { while (sweep <= 0) sweep += Math.PI * 2; }
      else { while (sweep >= 0) sweep -= Math.PI * 2; }
      const n = Math.max(2, Math.ceil((Math.abs(sweep) * s.r) / maxChordFt));
      for (let i = 0; i <= n; i++) {
        const a = s.start + sweep * (i / n);
        push({ x: s.c.x + s.r * Math.cos(a), y: s.c.y + s.r * Math.sin(a) });
      }
    }
  }
  if (pts.length > 1) {
    const f = pts[0], l = pts[pts.length - 1];
    if (Math.hypot(f.x - l.x, f.y - l.y) <= 0.05) pts.pop();
  }
  return pts;
}

// Dead-space fence trim (mirrored-island layouts): clip the lot-inset fence
// to the axis-aligned hull of everything placed, expanded by the full road
// band + fence clearance (`padFt` = equipmentMargin), so the perimeter road
// and its clearances always still fit. Returns the clipped polygon, or null
// when the hull already covers the fence extents (caller keeps the ORIGINAL
// fence object — byte-identical) or the boolean fails/degenerates.
export function trimFenceToHull(
  fence: Pt[],
  rects: { x: number; y: number; hx: number; hy: number }[],
  padFt: number
): Pt[] | null {
  if (fence.length < 3 || !rects.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const r of rects) {
    minX = Math.min(minX, r.x - r.hx); maxX = Math.max(maxX, r.x + r.hx);
    minY = Math.min(minY, r.y - r.hy); maxY = Math.max(maxY, r.y + r.hy);
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
  minX -= padFt; maxX += padFt; minY -= padFt; maxY += padFt;
  let fMinX = Infinity, fMinY = Infinity, fMaxX = -Infinity, fMaxY = -Infinity;
  for (const p of fence) {
    fMinX = Math.min(fMinX, p.x); fMaxX = Math.max(fMaxX, p.x);
    fMinY = Math.min(fMinY, p.y); fMaxY = Math.max(fMaxY, p.y);
  }
  const EPS = 0.05;
  if (minX <= fMinX + EPS && maxX >= fMaxX - EPS && minY <= fMinY + EPS && maxY >= fMaxY - EPS) {
    return null; // hull covers the fence — nothing to trim
  }
  try {
    const clipRect: [number, number][] = [[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY]];
    const result = polygonClipping.intersection(
      [[fence.map(p => [p.x, p.y] as [number, number])]],
      [[clipRect]]
    );
    // Keep the single largest resulting ring; reject degenerate output.
    let best: Pt[] | null = null;
    let bestArea = 0;
    for (const poly of result) {
      const ring = ringToPts(poly[0]);
      const a = Math.abs(polygonArea(ring));
      if (ring.length >= 3 && a > bestArea) { best = ring; bestArea = a; }
    }
    if (!best || bestArea < 1) return null;
    return best;
  } catch {
    return null;
  }
}

// Crushed-rock surfacing regions by boolean difference (exported for tests).
// - 'between-roads': the road-network islands (equipment courtyards) minus
//   equipment pads, reserved zones and any entrance-road rectangle overlap.
// - 'full-yard': everything inside the fence minus the road surface (outer
//   road region minus islands), entrance roads, equipment pads and reserved
//   zones. Per-block augmentation bays stay surfaced (rock keeps them clear
//   of vegetation until future equipment lands).
// Compact layouts (no road network) surface the whole fenced yard minus
// entrance roads / pads / reserves in either mode.
// Returns null when the polygon boolean fails on degenerate geometry.
export function computeSurfacing(
  fence: Pt[],
  roadNetwork: RoadNetwork | null,
  roads: RoadSegment[],
  equipment: PlacedEquipment[],
  reservedZones: ReservedZone[],
  mode: SurfacingMode,
  depthIn: number,
  // Augmentation zones only bound the dead-space courtyard trim below (rock
  // must still cover island-end aug bays); they are never cut out.
  augmentationZones: AugmentationZone[] = [],
  // Drafter-selectable dead-space trim (see LayoutOptions.deadSpaceTrim).
  // Default off => byte-identical legacy courtyards.
  trimDeadSpace = false,
  // Traced road outlines can contain nominal boolean "islands" that are not
  // usable equipment courtyards. Use the fenced non-road ground for every
  // traced yard instead of deciding from the raw island count.
  tracedYard = false
): SurfacingPlan | null {
  if (fence.length < 3) return null;
  type Ring = [number, number][];
  type MultiPoly = Ring[][];
  const toRing = (pts: Pt[]): Ring => pts.map(p => [p.x, p.y]);
  const rectRing = (x: number, y: number, length: number, width: number, rot: number): Ring => {
    const hl = length / 2, hw = width / 2;
    const c = Math.cos(rot), s = Math.sin(rot);
    return ([[-hl, -hw], [hl, -hw], [hl, hw], [-hl, hw]] as [number, number][])
      .map(([px, py]) => [x + px * c - py * s, y + px * s + py * c]);
  };

  // Cuts: equipment pads, reserved zones (laydown + future BESS), entrance roads.
  const cuts: MultiPoly[] = [];
  for (const eq of equipment) cuts.push([[rectRing(eq.x, eq.y, eq.length, eq.width, eq.rotation)]]);
  for (const z of reservedZones) cuts.push([[rectRing(z.x, z.y, z.length, z.width, 0)]]);
  for (const rd of roads) cuts.push([[rectRing(rd.x, rd.y, rd.length, rd.width, rd.rotation)]]);

  try {
    let subject: MultiPoly;
    let anyTrimmed = false;
    if (roadNetwork && mode === 'between-roads' && trimDeadSpace && !tracedYard) {
      // Dead-space courtyard trim: a courtyard that extends past its placed
      // contents (blocks, gear, reserved/aug zones) — e.g. the empty strip
      // east of a shorter island — is clipped to the contents' axis-aligned
      // hull plus the road-edge apron, so crushed rock never covers dead
      // ground. Courtyards whose contents already reach their extents keep
      // the ORIGINAL tessellated ring (byte-identical output/tonnage).
      const APRON = CLEARANCES.equipmentToRoadEdge;
      const contents = [
        ...equipment.map(e => {
          const rot = Math.abs(Math.sin(e.rotation)) > 0.5;
          return { x: e.x, y: e.y, hx: (rot ? e.width : e.length) / 2, hy: (rot ? e.length : e.width) / 2 };
        }),
        ...reservedZones.map(z => ({ x: z.x, y: z.y, hx: z.length / 2, hy: z.width / 2 })),
        ...augmentationZones.map(z => ({ x: z.x, y: z.y, hx: z.length / 2, hy: z.width / 2 })),
      ];
      subject = [];
      for (const isl of roadNetwork.islands) {
        const ring = edgeSegsToRing(isl);
        let rMinX = Infinity, rMinY = Infinity, rMaxX = -Infinity, rMaxY = -Infinity;
        for (const p of ring) {
          rMinX = Math.min(rMinX, p.x); rMaxX = Math.max(rMaxX, p.x);
          rMinY = Math.min(rMinY, p.y); rMaxY = Math.max(rMaxY, p.y);
        }
        const inside = contents.filter(c =>
          c.x > rMinX && c.x < rMaxX && c.y > rMinY && c.y < rMaxY &&
          pointInPolygon({ x: c.x, y: c.y }, ring));
        let cMinX = Infinity, cMinY = Infinity, cMaxX = -Infinity, cMaxY = -Infinity;
        for (const c of inside) {
          cMinX = Math.min(cMinX, c.x - c.hx); cMaxX = Math.max(cMaxX, c.x + c.hx);
          cMinY = Math.min(cMinY, c.y - c.hy); cMaxY = Math.max(cMaxY, c.y + c.hy);
        }
        const EPS = 0.05;
        const covered = inside.length > 0 &&
          cMinX - APRON <= rMinX + EPS && cMaxX + APRON >= rMaxX - EPS &&
          cMinY - APRON <= rMinY + EPS && cMaxY + APRON >= rMaxY - EPS;
        if (!inside.length || covered) {
          subject.push([toRing(ring)]);
          continue;
        }
        const clip: Ring = [
          [cMinX - APRON, cMinY - APRON], [cMaxX + APRON, cMinY - APRON],
          [cMaxX + APRON, cMaxY + APRON], [cMinX - APRON, cMaxY + APRON],
        ];
        const clipped = polygonClipping.intersection([[toRing(ring)]], [[clip]]) as MultiPoly;
        if (clipped.length) { subject.push(...clipped); anyTrimmed = true; }
        else subject.push([toRing(ring)]);
      }
    } else if (roadNetwork && mode === 'between-roads') {
      subject = tracedYard
        ? []
        : roadNetwork.islands.map(isl => [toRing(edgeSegsToRing(isl))]);
      // KMZ-traced road networks do not use boolean islands as authoritative
      // surfacing courtyards: most have none, while some contain a nominal
      // loop fully consumed by equipment. Fall back to the fenced non-road
      // region for all traced yards. Auto/manual networks keep their actual
      // courtyard islands and remain byte-identical.
      if (!subject.length) {
        const roadSurface = polygonClipping.difference(
          [[toRing(edgeSegsToRing(roadNetwork.outer))]],
          ...roadNetwork.islands.map(isl => [[toRing(edgeSegsToRing(isl))]] as MultiPoly)
        );
        subject = polygonClipping.difference([[toRing(fence)]], roadSurface) as MultiPoly;
      }
    } else if (roadNetwork) {
      // full-yard: fence interior minus the road surface (outer minus islands)
      const roadSurface = polygonClipping.difference(
        [[toRing(edgeSegsToRing(roadNetwork.outer))]],
        ...roadNetwork.islands.map(isl => [[toRing(edgeSegsToRing(isl))]] as MultiPoly)
      );
      subject = polygonClipping.difference([[toRing(fence)]], roadSurface) as MultiPoly;
    } else {
      subject = [[toRing(fence)]];
    }

    const result = cuts.length
      ? polygonClipping.difference(subject as any, ...cuts as any[])
      : (subject as any);

    const regions: SurfacingRegion[] = [];
    let areaSqFt = 0;
    for (const poly of result) {
      const outer = ringToPts(poly[0]);
      if (outer.length < 3 || Math.abs(polygonArea(outer)) <= 200) continue; // drop slivers
      const holes: Pt[][] = [];
      let a = Math.abs(polygonArea(outer));
      for (let i = 1; i < poly.length; i++) {
        const hole = ringToPts(poly[i]);
        // Keep small holes: a single BESS container pad is only ~198 sqft
        if (hole.length >= 3 && Math.abs(polygonArea(hole)) > 10) {
          holes.push(hole);
          a -= Math.abs(polygonArea(hole));
        }
      }
      regions.push({ outer, holes });
      areaSqFt += a;
    }
    return {
      mode, regions, areaSqFt, depthIn, tons: surfacingTons(areaSqFt, depthIn),
      ...(anyTrimmed ? { deadSpaceTrimmed: true as const } : {}),
    };
  } catch {
    return null;
  }
}

// Shrink-wrap trigger: the road ring hugs the equipment cluster only when
// the clipped ring saves at least this fraction of the legacy fence-following
// ring's area — layouts that (nearly) fill the parcel stay byte-identical.
export const SHRINKWRAP_AREA_RATIO = 0.9;

// Perimeter ring style: 'fence' follows the whole fence line (default),
// 'shrink' hugs the equipment cluster, 'hybrid' hugs only far sides.
export type RingMode = 'fence' | 'shrink' | 'hybrid';

export type PerimeterBandMode = 'standard' | 'flush';

export type FencePlacementMode = 'inset' | 'property-line';
export const HYBRID_FAR_FT = 150;
export type RingOffsets = { n?: number; s?: number; e?: number; w?: number };

// Exported so the substation-yard generator builds its perimeter ring, gate
// and fillets through the SAME road engine as a BESS yard (one road standard
// for the whole site). BESS callers are unaffected.
// Extend a route's first and last leg outward by `ext` feet. Traced reference
// routes are digitized to the CENTERLINE of the road they meet, so a
// T-junction leg often stops half a width short of the crossing road's
// surface — extending each end closes those junction gaps; the strip union
// absorbs any overlap and the fence clip trims what pokes past the yard.
export function extendRouteEnds(pts: Pt[], ext: number): Pt[] {
  if (pts.length < 2 || !(ext > 0)) return pts;
  const push = (a: Pt, b: Pt): Pt => {
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    return len < 1e-6 ? b : { x: b.x + (dx / len) * ext, y: b.y + (dy / len) * ext };
  };
  const out = pts.slice();
  out[0] = push(pts[1], pts[0]);
  out[out.length - 1] = push(pts[pts.length - 2], pts[pts.length - 1]);
  return out;
}

// Geometry fingerprint for a traced road: strip bbox center + polyline
// length, in site feet. Stable across the wholesale stale-save re-derivation
// (the heal reproduces the scan's strips exactly), immune to the id
// re-sequencing that makes `troad-N` unusable as a persistent key. Shared by
// deletion tombstones (removedTracedRoads) and pave-as-drawn overrides
// (pavedTracedRoads); the design store re-exports it.
export const tracedRoadFingerprint = (
  pts: Pt[],
): { x: number; y: number; len: number } => {
  let len = 0;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < pts.length; i++) {
    if (i) len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    minX = Math.min(minX, pts[i].x); maxX = Math.max(maxX, pts[i].x);
    minY = Math.min(minY, pts[i].y); maxY = Math.max(maxY, pts[i].y);
  }
  if (!Number.isFinite(minX) || !Number.isFinite(len)) return { x: 0, y: 0, len: 0 };
  return {
    x: Math.round(((minX + maxX) / 2) * 10) / 10,
    y: Math.round(((minY + maxY) / 2) * 10) / 10,
    len: Math.round(len * 10) / 10,
  };
};

// Fingerprint list match with the SAME tolerances the deletion-tombstone
// filter uses (|dx| ≤ 2 ft, |dy| ≤ 2 ft, |dlen| ≤ 4 ft): values survive the
// JSON round-trip and the re-derivation bit-for-bit in practice, but the
// slack absorbs float noise without ever matching a neighboring strip.
export const tracedRoadFingerprintMatch = (
  fp: { x: number; y: number; len: number },
  list: readonly { x: number; y: number; len: number }[] | null | undefined,
): boolean => !!list?.some(t =>
  Math.abs(t.x - fp.x) <= 2 && Math.abs(t.y - fp.y) <= 2 && Math.abs(t.len - fp.len) <= 4);

export function buildRoads(
  fence: Pt[],
  equipment: PlacedEquipment[],
  rows: { y: number; minX: number; maxX: number }[],
  fp: BlockFootprint,
  compact: boolean,
  gateEdge: GateEdge = 'S',
  gatePin: Pt | null = null,
  aisleOffsets: number[] = [],
  movedPadCenters: Pt[] = [],
  customRoads: { id: string; pts: Pt[]; width?: number; traced?: boolean; tracedV?: number; outline?: Pt[]; surface?: Pt[]; entrance?: boolean; gate?: Pt; apron?: boolean }[] = [],
  // Vertical middle-road strips between island groups sharing a strip row
  // (computeCorridorAisles) — subtracted exactly like the horizontal aisles.
  corridorAisles: RoadSegment[] = [],
  // Additional placed rects the road ring must wrap (augmentation zones,
  // reserved areas, future/ghost equipment) — half extents. `optional`
  // rects (laydown yards, per the reference drawing) are wrapped only when
  // they sit adjacent to the cluster ring band; a detached laydown stays
  // outside the shrink-wrapped ring.
  wrapExtras: { x: number; y: number; hx: number; hy: number; optional?: boolean }[] = [],
  // Drag-placed island footprints: each is wrapped in the full standard road
  // band (24 ft at road-edge clearance, boolean-merged with the rest of the
  // network so neighbors share roads) plus a guaranteed full-width connector
  // to the nearest perimeter/aisle road. Unconnectable islands stay placed
  // and warn with the stable "Placed island <id> placed with warning:" prefix.
  accessRects: { id: string; x: number; y: number; hx: number; hy: number }[] = [],
  // Perimeter ring style + drafter per-edge inward offsets (feet).
  ringMode: RingMode = 'fence',
  ringOffsets: RingOffsets | null = null,
  // Build the ring for an EMPTY yard (no equipment). A BESS yard with nothing
  // placed has no ring by definition — that early return is load-bearing for
  // every existing layout — but a substation area is civil-scope-only: it is
  // always empty and still needs its perimeter road and gate. Opt-in so the
  // BESS path stays byte-identical.
  allowEmptyEquipment = false,
  // Stable ids of automatically generated interior road pieces the drafter
  // removed. Empty = every generated piece is kept (byte-identical).
  removedRoads: string[] = [],
  // Perimeter band placement inside the fence. 'standard' (default) keeps
  // the historical 10 ft strip between the fence and the outside road edge;
  // 'flush' runs the outside road edge on the inside fence line so that
  // strip becomes usable road area.
  perimeterBand: PerimeterBandMode = 'standard',
  // Drafter-deleted road areas (see LayoutConstraints.roadCuts). Applied last,
  // after the gate apron is merged, so a cut can delete any road surface in
  // the yard — including the driveway — and not just the pieces that happen
  // to carry a generated id.
  roadCuts: RoadCut[] = [],
  // Pave-as-drawn override fingerprints (LayoutConstraints.pavedTracedRoads):
  // a traced apron strip matching one of these paves exactly as drawn even
  // though it fails the gate-apron rule, swapping the linework-only warning
  // for an override warning. Empty = byte-identical behavior.
  pavedTracedRoads: { x: number; y: number; len: number }[] = []
) {
  const roads: RoadSegment[] = [];
  const aisles: RoadSegment[] = [];
  const roadWarnings: string[] = [];
  let roadNetwork: RoadNetwork | null = null;
  let gate: SiteDesign['gate'] = null;
  // Raw drawn rings of verbatim traced roads. Their corners must survive the
  // network fillets: rounding them with the generated-road radii clamps to
  // ~half of any short edge and carves deep arcs into the drawn outline.
  // Function-scope so the shared gate-apron re-fillet below honors them too.
  // Empty for non-traced designs → every fillet predicate is byte-identical.
  const verbatimCornerRings: Pt[][] = [];
  // Min distance from a point to a ring's edges (PCRing tuple form) plus the
  // nearest boundary point — used to size generated gate connectors that must
  // reach a drawn flare apron.
  const ringEdgeNearest = (p: Pt, ring: [number, number][]): { d: number; pt: Pt } | null => {
    if (ring.length < 2) return null;
    let best = { d: Infinity, pt: { x: ring[0][0], y: ring[0][1] } };
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const L2 = dx * dx + dy * dy;
      const t = L2 < 1e-9 ? 0 : Math.max(0, Math.min(1, ((p.x - a[0]) * dx + (p.y - a[1]) * dy) / L2));
      const qx = a[0] + t * dx, qy = a[1] + t * dy;
      const d = Math.hypot(p.x - qx, p.y - qy);
      if (d < best.d) best = { d, pt: { x: qx, y: qy } };
    }
    return best;
  };
  // Traced/drawn roads are road surface in their own right: a yard whose
  // equipment was deleted (or an area that traced ONLY roads) must still
  // materialize them, so the empty-equipment early-out defers to them.
  if (!fence.length || (!equipment.length && !allowEmptyEquipment && !customRoads.length)) {
    return { roads, aisles, roadNetwork, gate, roadWarnings };
  }

  const roadW = CLEARANCES.roadWidth;
  // Inset from the fence to the OUTSIDE road edge (0 when flush).
  const bandInset = perimeterBandInset(perimeterBand);

  // Road network: the 30 ft perimeter band runs between frontToFence (10 ft)
  // and 40 ft inside the fence. Drive aisle strips are subtracted from the
  // interior region, splitting it into equipment "islands" — so every aisle
  // is connected to the perimeter road by construction (no gaps).
  // Edges are filleted per sheet 10: islands (inner edges) 58 ft radius,
  // outer edge 20 ft radius; radii auto-shrink where segments are short.
  let perimCenterline = insetPolygon(fence, bandInset + roadW / 2);
  // Final (ring-mode-adjusted) outer edge polygon, saved so the gate pass
  // below can union the entrance apron into the road region and re-fillet.
  let outerEdgeForGate: Pt[] | null = null;
  if (!compact && perimCenterline.length >= 3) {
    let outerEdge = insetPolygon(fence, bandInset);
    let innerEdge = insetPolygon(fence, bandInset + roadW);

    // ---- Ring mode: 'fence' (default) follows the fence-derived ring
    // unchanged. 'shrink' clips every ring edge to the placed equipment
    // cluster (equipment + aug/reserved zones + ghost units) at the standard
    // road-edge clearance. 'hybrid' clips only the sides where the fence is
    // far (> HYBRID_FAR_FT beyond the road band) from the cluster. Drafter
    // ringOffsets pull individual ring edges inward from the automatic
    // position; offsets that would pinch the band into the cluster or push
    // it outside the fence are rejected with a warning and ignored.
    {
      const rects = [
        ...equipment.map(e => { const h = equipHalves(e); return { x: e.x, y: e.y, hx: h.hx, hy: h.hy }; }),
        // Row lattice FOOTPRINTS, not just the placed steel: island contents
        // sit inset (~4 ft) inside their pair footprint, so hugging the bare
        // equipment pinched the outer gap tighter than the interior aisle
        // gaps (aisles center between facing footprint contents) and outer
        // islands read visibly off-center between their roads. Wrapping the
        // full footprint makes the shrink/hybrid outer gap match the
        // interior aisle gap exactly, so every island is centered.
        ...rows.map(r => ({
          x: (r.minX + r.maxX) / 2, y: r.y,
          hx: (r.maxX - r.minX) / 2, hy: fp.depth / 2,
        })),
        ...wrapExtras.filter(r => !r.optional),
      ];
      if (rects.length) {
        const clr2 = CLEARANCES.equipmentToRoadEdge;
        let minX = Math.min(...rects.map(r => r.x - r.hx));
        let maxX = Math.max(...rects.map(r => r.x + r.hx));
        let minY = Math.min(...rects.map(r => r.y - r.hy));
        let maxY = Math.max(...rects.map(r => r.y + r.hy));
        // Pull adjacent optional rects (laydown) into the wrap when they'd
        // otherwise collide with the ring band; detached ones stay outside.
        const pending = wrapExtras.filter(r => r.optional);
        for (let pass = 0; pass < pending.length; pass++) {
          const band = clr2 + roadW + clr2;
          const idx = pending.findIndex(r =>
            r.x - r.hx < maxX + band && r.x + r.hx > minX - band &&
            r.y - r.hy < maxY + band && r.y + r.hy > minY - band);
          if (idx < 0) break;
          const [r] = pending.splice(idx, 1);
          minX = Math.min(minX, r.x - r.hx); maxX = Math.max(maxX, r.x + r.hx);
          minY = Math.min(minY, r.y - r.hy); maxY = Math.max(maxY, r.y + r.hy);
        }
        // Fence-derived outer-edge bounding box: the automatic (no-clip)
        // outer position for every fence-following side.
        const fob = {
          minX: Math.min(...outerEdge.map(p => p.x)), maxX: Math.max(...outerEdge.map(p => p.x)),
          minY: Math.min(...outerEdge.map(p => p.y)), maxY: Math.max(...outerEdge.map(p => p.y)),
        };
        const band = clr2 + roadW;
        // Per-side hug decision: outer edge target = cluster + band when
        // hugging, the fence-derived position otherwise.
        const hug = (side: 'w' | 'e' | 's' | 'n'): boolean => {
          if (ringMode === 'shrink') return true;
          if (ringMode !== 'hybrid') return false;
          const gap =
            side === 'w' ? (minX - band) - fob.minX :
            side === 'e' ? fob.maxX - (maxX + band) :
            side === 's' ? (minY - band) - fob.minY :
            fob.maxY - (maxY + band);
          return gap > HYBRID_FAR_FT;
        };
        // Outer-edge position per side + whether that side actually clips.
        const sides: Record<'w' | 'e' | 's' | 'n', { o: number; active: boolean }> = {
          w: { o: hug('w') ? minX - band : fob.minX, active: hug('w') },
          e: { o: hug('e') ? maxX + band : fob.maxX, active: hug('e') },
          s: { o: hug('s') ? minY - band : fob.minY, active: hug('s') },
          n: { o: hug('n') ? maxY + band : fob.maxY, active: hug('n') },
        };
        // Drafter per-edge offsets: positive = inward (toward the cluster).
        // The moved band must still clear the cluster and stay inside the
        // fence-derived ring; invalid offsets warn and keep the auto edge.
        const SIDE_NAME = { w: 'west', e: 'east', s: 'south', n: 'north' } as const;
        for (const side of ['w', 'e', 's', 'n'] as const) {
          const off = ringOffsets?.[side];
          if (off === undefined || off === 0 || !Number.isFinite(off)) continue;
          const inwardSign = side === 'w' || side === 's' ? 1 : -1;
          const cand = sides[side].o + inwardSign * off;
          const clusterLimit =
            side === 'w' ? minX - band : side === 'e' ? maxX + band :
            side === 's' ? minY - band : maxY + band;
          const fenceLimit = fob[side === 'w' ? 'minX' : side === 'e' ? 'maxX' : side === 's' ? 'minY' : 'maxY'];
          const insideCluster = inwardSign * (cand - clusterLimit) > 1e-6;
          const outsideFence = inwardSign * (cand - fenceLimit) < -1e-6;
          if (insideCluster) {
            roadWarnings.push(`Ring edge ${SIDE_NAME[side]} move rejected: the road band would cut into the equipment cluster — automatic edge kept.`);
            continue;
          }
          if (outsideFence) {
            roadWarnings.push(`Ring edge ${SIDE_NAME[side]} move rejected: the road band would leave the fenced yard — automatic edge kept.`);
            continue;
          }
          sides[side].o = cand;
          sides[side].active = true;
        }
        const anyClip = sides.w.active || sides.e.active || sides.s.active || sides.n.active;
        if (anyClip) {
          const BIG = 1e7;
          // Clip rect side for a polygon inset `pad` from the fence: the
          // outer edge sits at o, so a polygon pad ft inside the fence clips
          // at o -/+ (band - pad). Inactive sides use a huge slack so the
          // fence-derived geometry passes through untouched.
          const clipToRect = (poly: Pt[], pad: number): Pt[] | null => {
            try {
              const rMinX = sides.w.active ? sides.w.o + (band - pad) : -BIG;
              const rMaxX = sides.e.active ? sides.e.o - (band - pad) : BIG;
              const rMinY = sides.s.active ? sides.s.o + (band - pad) : -BIG;
              const rMaxY = sides.n.active ? sides.n.o - (band - pad) : BIG;
              const rect: PCRing = [
                [rMinX, rMinY], [rMaxX, rMinY], [rMaxX, rMaxY], [rMinX, rMaxY],
              ];
              const out = polygonClipping.intersection(
                [[poly.map(p => [p.x, p.y] as [number, number])]] as any, [[rect]] as any);
              let best: Pt[] | null = null;
              for (const p of out) {
                const ring = ringToPts(p[0]);
                if (ring.length >= 3 && (!best || Math.abs(polygonArea(ring)) > Math.abs(polygonArea(best)))) {
                  best = ring;
                }
              }
              return best;
            } catch { return null; }
          };
          const newOuter = clipToRect(outerEdge, band);
          const newInner = clipToRect(innerEdge, clr2);
          const newCenter = clipToRect(perimCenterline, clr2 + roadW / 2);
          if (newOuter && newInner && newCenter) {
            outerEdge = newOuter;
            innerEdge = newInner;
            perimCenterline = newCenter;
          } else {
            roadWarnings.push('Perimeter ring adjustment failed geometrically — fence-following ring kept.');
          }
        }
      }
    }
    aisles.push(...computeAisles(rows, fp, innerEdge, aisleOffsets));
    aisles.push(...corridorAisles);

    // Drafter road removals: drop the named generated pieces before the
    // network is built, so surfacing, cables, feeder routes and every export
    // re-derive from the reduced network rather than patching it afterwards.
    // Unknown ids go dormant with a warning (the piece may return after a
    // later edit) instead of being silently discarded.
    if (removedRoads.length) {
      const present = new Set(aisles.map(a => a.id).filter((v): v is string => !!v));
      // The gate entrance is generated further down (it needs the gate pass),
      // so it is always a live target here — never report it dormant.
      present.add(GATE_ENTRANCE_ROAD_ID);
      for (const id of removedRoads) {
        if (!present.has(id)) {
          roadWarnings.push(
            `Removed road ${id} is dormant: the current layout has no such generated road piece. ` +
            'The removal is kept and will re-apply if the piece returns, or clear it in the layout edits panel.'
          );
        }
      }
      const removeSet = new Set(removedRoads);
      const kept = aisles.filter(a => !(a.id && removeSet.has(a.id)));
      const nRemoved = aisles.length - kept.length;
      if (nRemoved > 0) {
        aisles.length = 0;
        aisles.push(...kept);
        roadWarnings.push(
          `${nRemoved} generated access road${nRemoved === 1 ? '' : 's'} removed by drafter edit — ` +
          'the road network, crushed-rock surfacing, cable and feeder routing and all exports ' +
          'were rebuilt without them. Verify fire/O&M vehicle access to every island in detailed design.'
        );
      }
    }

    const aisleRects: [number, number][][][] = aisles.map(a => {
      const h = aisleHalves(a);
      return [[
        [a.x - h.hx, a.y - h.hy],
        [a.x + h.hx, a.y - h.hy],
        [a.x + h.hx, a.y + h.hy],
        [a.x - h.hx, a.y + h.hy],
      ] as [number, number][]];
    });

    const { islands: islandPolys, enclosedRoadHoles } = subtractAislesFromYard(innerEdge, aisleRects);

    // ---- extra roads: access rings around relocated blocks + drawn roads --
    // Both are carved OUT of the equipment islands (island area -> road
    // surface), clipped to the yard interior and kept off every equipment
    // pad, so the render, DXF hatch and surfacing all follow automatically.
    const innerRing: PCRing = innerEdge.map(p => [p.x, p.y]);
    const clr = CLEARANCES.equipmentToRoadEdge;
    const carvePieces: PCRing[][] = [];
    // Verbatim traced outline pieces (closed road networks / flare aprons):
    // carved against the tight 3 ft fence gap instead of the deep clearance
    // ring, which would eat the drawn ring road's inner band.
    const surfaceCarvePieces: PCRing[][] = [];
    // Entrance-flare outlines (traced + gate-flagged): unioned into the
    // outer edge below so roads mode keeps the drawn EXTERIOR apron too —
    // the outline polygon itself bounds the allowance, exactly like compact.
    const tracedFlareOutlines: { ring: PCRing; gate: Pt }[] = [];

    // Nearest point on the perimeter road centerline (connector target).
    const nearestOnPerimCL = (p: Pt): { q: Pt; d: number } | null => {
      if (perimCenterline.length < 2) return null;
      let best: { q: Pt; d: number } | null = null;
      for (let i = 0; i < perimCenterline.length; i++) {
        const s = perimCenterline[i], e = perimCenterline[(i + 1) % perimCenterline.length];
        const dx = e.x - s.x, dy = e.y - s.y;
        const L2 = dx * dx + dy * dy;
        const t = L2 > 0 ? Math.max(0, Math.min(1, ((p.x - s.x) * dx + (p.y - s.y) * dy) / L2)) : 0;
        const q = { x: s.x + dx * t, y: s.y + dy * t };
        const d = Math.hypot(q.x - p.x, q.y - p.y);
        if (!best || d < best.d) best = { q, d };
      }
      return best;
    };

    // Nearest reachable point on a drive-aisle centerline (connector target,
    // shared by moved pads and placed islands).
    const nearestOnAisles = (p: Pt): { q: Pt; d: number } | null => {
      let best: { q: Pt; d: number } | null = null;
      for (const a of aisles) {
        const vertical = Math.abs(Math.sin(a.rotation)) > 0.5;
        const q = vertical
          ? { x: a.x, y: Math.max(a.y - a.length / 2, Math.min(a.y + a.length / 2, p.y)) }
          : { x: Math.max(a.x - a.length / 2, Math.min(a.x + a.length / 2, p.x)), y: a.y };
        const d = Math.hypot(q.x - p.x, q.y - p.y);
        if (!best || d < best.d) best = { q, d };
      }
      return best;
    };

    for (const c of movedPadCenters.map(p => ({ x: p.x, y: p.y, hx: fp.width / 2, hy: fp.depth / 2 }))) {
      const hx = c.hx, hy = c.hy;
      // Skip pads that still sit next to the frozen road network: a pad in a
      // standard row position reaches an aisle (or the perimeter band) within
      // its road-edge clearance + one road width.
      try {
        const probe: PCRing[][] = [[rectRing(c.x, c.y, hx + clr + roadW, hy + clr + roadW)]];
        const touchesAisle = aisleRects.some(
          a => polygonClipping.intersection(probe as any, [a] as any).length > 0
        );
        const reachesPerimeter =
          polygonClipping.difference(probe as any, [[innerRing]] as any).length > 0;
        if (touchesAisle || reachesPerimeter) continue;
      } catch { continue; }
      // Access ring: roadW-wide loop at road-edge clearance around the pad.
      carvePieces.push([
        rectRing(c.x, c.y, hx + clr + roadW, hy + clr + roadW),
        rectRing(c.x, c.y, hx + clr, hy + clr),
      ]);
      // Connector strip: straight run from the pad center to the nearest
      // existing road (perimeter centerline or a drive-aisle centerline);
      // the pad's own clearance rectangle is subtracted below, so the strip
      // effectively starts at the ring and merges into the target road.
      let target: { q: Pt; d: number } | null = nearestOnPerimCL(c);
      for (const a of aisles) {
        const vertical = Math.abs(Math.sin(a.rotation)) > 0.5;
        const q = vertical
          ? { x: a.x, y: Math.max(a.y - a.length / 2, Math.min(a.y + a.length / 2, c.y)) }
          : { x: Math.max(a.x - a.length / 2, Math.min(a.x + a.length / 2, c.x)), y: a.y };
        const d = Math.hypot(q.x - c.x, q.y - c.y);
        if (!target || d < target.d) target = { q, d };
      }
      if (target && target.d > 0.5) {
        const strip = segStrip(c, target.q, roadW, roadW / 2);
        if (strip) carvePieces.push([strip]);
      }
    }

    // Drag-placed islands: the full standard treatment, matching the auto
    // rows and the reference layout — a roadW-wide band at road-edge
    // clearance wraps ALL four sides (always carved; the boolean union merges
    // it with the perimeter band, aisles and neighboring island bands so
    // close neighbors share one road), and when the band doesn't already
    // touch the existing network a full-width connector strip is added
    // toward the nearest perimeter/aisle centerline. Both get the standard
    // 58 ft inner fillets from the shared island filleting pass below. If
    // even the connector cannot reach a road (pocketed drop), the island is
    // rejected with the stable prefix so the store rolls the drop back.
    const placedRoadPieces: PCRing[][] = []; // verified-connected placed bands/connectors
    const touchesExisting = (comp: PCRing[][]): boolean =>
      aisleRects.some(a => polygonClipping.intersection(comp as any, [a] as any).length > 0) ||
      polygonClipping.difference(comp as any, [[innerRing]] as any).length > 0 ||
      placedRoadPieces.some(p => polygonClipping.intersection(comp as any, [p] as any).length > 0);
    const equipmentPads: PCRing[][] = equipment.map(e => {
      const h = equipHalves(e);
      return [rectRing(e.x, e.y, h.hx + clr - 0.05, h.hy + clr - 0.05)];
    });
    // Every connector candidate for a placed island, nearest first: the
    // perimeter-centerline projection plus each drive aisle's projection —
    // if the nearest strip is severed by equipment pads, the next one gets
    // a chance before the drop is rejected.
    const connectorCandidates = (c: { x: number; y: number }): { q: Pt; d: number }[] => {
      const out: { q: Pt; d: number }[] = [];
      const perim = nearestOnPerimCL(c);
      if (perim) out.push(perim);
      for (const a of aisles) {
        const vertical = Math.abs(Math.sin(a.rotation)) > 0.5;
        const q = vertical
          ? { x: a.x, y: Math.max(a.y - a.length / 2, Math.min(a.y + a.length / 2, c.y)) }
          : { x: Math.max(a.x - a.length / 2, Math.min(a.x + a.length / 2, c.x)), y: a.y };
        out.push({ q, d: Math.hypot(q.x - c.x, q.y - c.y) });
      }
      return out.filter(t => t.d > 0.5).sort((a, b) => a.d - b.d);
    };
    // Does (band + optional connector) reach the network once the
    // equipment-pad clearances are cut away? (A drop pocketed between other
    // equipment can sever the strip.)
    const verifyConnected = (pieces: PCRing[][], bandOuter: PCRing, bandInner: PCRing): boolean => {
      try {
        let region = polygonClipping.union(pieces[0] as any, ...(pieces.slice(1) as any[])) as PCRing[][];
        if (equipmentPads.length) region = polygonClipping.difference(region as any, ...(equipmentPads as any[])) as PCRing[][];
        for (const poly of region) {
          const comp: PCRing[][] = [poly as any];
          const touchesBand = polygonClipping.intersection(comp as any, [[bandOuter, bandInner]] as any).length > 0;
          if (!touchesBand) continue;
          if (touchesExisting(comp)) return true;
        }
        return false;
      } catch { return true; /* boolean failure — keep the carve, never false-reject */ }
    };
    // Fixpoint pass: a placed island may connect THROUGH a neighbor's band,
    // so acceptance must not depend on spec order — keep sweeping the pending
    // list until no island can be newly connected, then reject the rest.
    let pending = [...accessRects];
    let progressed = true;
    while (progressed && pending.length) {
      progressed = false;
      const still: typeof pending = [];
      for (const c of pending) {
        const bandOuter = rectRing(c.x, c.y, c.hx + clr + roadW, c.hy + clr + roadW);
        const bandInner = rectRing(c.x, c.y, c.hx + clr, c.hy + clr);
        let accepted: PCRing[][] | null = null;
        let touchesNetwork = false;
        try {
          touchesNetwork = touchesExisting([[bandOuter]]);
        } catch { /* fall through to the connector */ }
        if (touchesNetwork) {
          accepted = [[bandOuter, bandInner]];
        } else {
          for (const target of connectorCandidates(c)) {
            const strip = segStrip(c, target.q, roadW, roadW / 2);
            if (!strip) continue;
            const pieces: PCRing[][] = [[bandOuter, bandInner], [strip]];
            if (verifyConnected(pieces, bandOuter, bandInner)) { accepted = pieces; break; }
          }
        }
        if (accepted) {
          carvePieces.push(...accepted);
          placedRoadPieces.push(...accepted);
          progressed = true;
        } else {
          still.push(c);
        }
      }
      pending = still;
    }
    for (const c of pending) {
      roadWarnings.push(`Placed island ${c.id} placed with warning: no road connection could be built to the perimeter or a drive aisle from this position — the island stays where you put it; fix vehicle access or move it in the layout edits panel.`);
    }

    // Drafter-drawn roads: roadW-wide strips along each polyline, with arc
    // fillets at every interior bend mirroring the auto network's 58 ft inner
    // turning radius (auto-reduced on short legs; square patch fallback when
    // there is no room at all).
    // Accept gate: the whole strip must materialize as drivable surface —
    // inside the fence road band and off every equipment-pad clearance
    // rectangle. Anything less used to be silently eaten by the pad
    // difference below (slivers or nothing, with no message); now the road
    // is rejected loudly with the blocked footage so the drafter can
    // reroute. A small tolerance absorbs numeric edge slivers where the
    // strip shares an edge with an auto aisle or pad clearance line.
    // Compact layouts pack rows tighter than the 3 ft road-edge clearance, so
    // the clearance-inflated legal region would reject EVERY drawn road there.
    // Compact validates against the bare pad rectangles instead: a route
    // through open aisle space is accepted (the drafter accepted relaxed
    // clearances by choosing compact), a route across a pad still rejects.
    const drawnPadClr = compact ? 0 : CLEARANCES.equipmentToRoadEdge;
    const roadLegal = customRoads.length
      ? drawnRoadLegalRegion(fence, equipment, bandInset, drawnPadClr) : [];
    for (const road of customRoads) {
      const pts = road.pts;
      if (!pts || pts.length < 2) continue;
      // Per-road width: clamp to [12, 60] ft so absurd values can't break the
      // network; absent means use the site standard (24 ft).
      const rw = (road.width && Number.isFinite(road.width))
        ? Math.max(12, Math.min(60, road.width)) : roadW;
      // Traced roads carrying a verbatim drawn polygon (closed-outline
      // `surface` or entrance-flare `outline`) render exactly what the
      // reference drew — extending the centerline past its drawn ends
      // overshoots the outline (the gate flare used to run long).
      const verbatimRoad = road.traced &&
        ((road.surface?.length ?? 0) >= 3 || (road.outline?.length ?? 0) >= 3);
      const stripPts = road.traced && !verbatimRoad ? extendRouteEnds(pts, rw / 2) : pts;
      const pieces = filletPolylineStrip(stripPts, rw, CLEARANCES.roadInnerRadius);
      if (!pieces.length) {
        roadWarnings.push(road.traced
          ? `Traced road ${road.id} placed with warning: the reference route is too short to form a road strip — kept in the project but no surface was added.`
          : `Drawn road ${road.id} rejected: too short to form a road strip.`);
        continue;
      }
      // Pass the per-road width so the validation strip matches the carve strip
      // exactly — a 36 ft road tested against a 24 ft strip could pass the
      // 98% clear threshold then get its outer 6 ft clipped during carving.
      const ev = evaluateDrawnRoad(pts, fence, equipment, roadLegal, undefined, rw);
      if (ev.stripArea > 0 && ev.frac < 0.98) {
        const blockedFt = Math.round(ev.blockedArea / rw);
        const totalFt = Math.round(ev.stripArea / rw);
        if (road.traced) {
          // Reference-wins: a traced road keeps its drivable surface and the
          // blockage is only reported, never a rejection.
          roadWarnings.push(`Traced road ${road.id} placed with warning: ~${blockedFt} ft of the ${totalFt} ft reference route is blocked by equipment or the fence road setback — the clear part of the drawn road was kept.`);
        } else {
          roadWarnings.push(compact
            ? `Drawn road ${road.id} rejected: ~${blockedFt} ft of the ${totalFt} ft route crosses equipment pads or the fence road setback — in a compact layout, route through the open aisles between the packed rows.`
            : `Drawn road ${road.id} rejected: ~${blockedFt} ft of the ${totalFt} ft route is blocked by equipment clearance (${CLEARANCES.equipmentToRoadEdge} ft off every pad) or the fence road setback — reroute along open corridors between equipment rows.`
          );
          continue;
        }
      }
      // Nothing-to-add gate: a route lying entirely on existing road
      // surface (perimeter band / aisles / previous carves) would be
      // accepted, change nothing, and linger as a phantom edit — reject it
      // with an explanation instead. Traced roads are exempt: the reference
      // route often coincides with the auto perimeter/aisles and that is
      // fine — nothing is added, nothing is rejected.
      if (!road.traced) try {
        const stripPolys = pieces.map(r => [r]);
        const overIslands = polygonClipping.intersection(
          stripPolys as any,
          islandPolys.map(p => [p.map(q => [q.x, q.y] as [number, number])]) as any
        );
        if (multiPolyArea(overIslands as PCRing[][]) < DRAWN_ROAD_MIN_NEW_SQFT) {
          roadWarnings.push(
            `Drawn road ${road.id} rejected: the route already lies entirely on existing road surface — nothing to add.`
          );
          continue;
        }
      } catch { /* boolean failure: fall through and let the carve try */ }
      // A verbatim traced record renders its drawn polygon ALONE: the
      // constant-width strip from the representative centerline overruns a
      // tapered flare's narrow end (and arbitrary outline sides), so strip
      // geometry stays OUT of the pavement union. The strip computed above
      // still drives the too-short and blocked-route validation; picking
      // resolves verbatim roads by point-in-polygon on the drawn outline.
      const renderPieces: PCRing[] = verbatimRoad
        ? [
            ...(road.surface && road.surface.length >= 3
              ? [road.surface.map(p => [p.x, p.y] as [number, number])] : []),
            ...(road.outline && road.outline.length >= 3
              ? [road.outline.map(p => [p.x, p.y] as [number, number])] : []),
          ]
        : pieces;
      if (verbatimRoad) {
        if (road.surface && road.surface.length >= 3) verbatimCornerRings.push(road.surface);
        if (road.outline && road.outline.length >= 3) verbatimCornerRings.push(road.outline);
        // The outline ring STAYS in renderPieces (its interior carves islands
        // via surfaceCarvePieces); its outline-bounded exterior apron joins
        // the outer edge below.
        if (road.traced && road.entrance && road.gate && road.outline && road.outline.length >= 3) {
          tracedFlareOutlines.push({
            ring: road.outline.map(p => [p.x, p.y] as [number, number]),
            gate: road.gate,
          });
        }
      }
      // Pre-union all strip pieces (leg strips, corner arcs, end caps) into
      // one multi-polygon so polygon-clipping sees a single clean shape
      // rather than many slightly-overlapping rings.  Hairline slivers
      // between adjacent pieces can otherwise survive the island difference
      // as orphaned road stubs on both sides of the insertion.
      try {
        const polys = renderPieces.map(r => [[r]] as PCRing[][]);
        const unioned: PCRing[][] = polys.length === 1
          ? polys[0]
          : polygonClipping.union(polys[0] as any, ...(polys.slice(1) as any[])) as PCRing[][];
        for (const poly of unioned) (verbatimRoad ? surfaceCarvePieces : carvePieces).push(poly as PCRing[]);
      } catch {
        // Boolean failure: fall back to the per-ring approach
        for (const ring of renderPieces) (verbatimRoad ? surfaceCarvePieces : carvePieces).push([ring]);
      }
    }

    let carvedIslands = islandPolys;
    if (carvePieces.length || surfaceCarvePieces.length) {
      try {
        // Keep the carve inside the yard interior and off every equipment pad
        // (slightly under the road-edge clearance so shared edges stay clean).
        let carve = (carvePieces.length
          ? polygonClipping.intersection(carvePieces as any, [[innerRing]] as any)
          : []) as PCRing[][];
        const pads: PCRing[][] = equipment.map(e => {
          const h = equipHalves(e);
          return [rectRing(e.x, e.y, h.hx + clr - 0.05, h.hy + clr - 0.05)];
        });
        if (carve.length && pads.length) {
          carve = polygonClipping.difference(carve as any, ...pads as any);
        }
        // Verbatim traced outlines carve against the tight 3 ft fence gap —
        // the deep clearance ring would clip the drawn ring road's inner
        // band — with the same pad cut as every other road surface.
        if (surfaceCarvePieces.length) {
          const surfaceRing: PCRing = insetPolygon(fence, 3).map(p => [p.x, p.y]);
          let sc = polygonClipping.intersection(surfaceCarvePieces as any, [[surfaceRing]] as any) as PCRing[][];
          if (sc.length && pads.length) {
            sc = polygonClipping.difference(sc as any, ...pads as any) as PCRing[][];
          }
          carve.push(...sc);
        }
        if (carve.length) {
          carvedIslands = carveIslands(islandPolys, carve as PCRing[][]);
        } else if (customRoads.length) {
          roadWarnings.push('Drawn/auto access roads were entirely clipped away by the fence or equipment clearances — no road area added.');
        }
      } catch {
        roadWarnings.push('Extra road areas could not be computed for this geometry — access rings / drawn roads omitted.');
      }
    }

    if (enclosedRoadHoles.length) {
      roadWarnings.push(
        `${enclosedRoadHoles.length} road area(s) are fully enclosed by equipment with no connection to the perimeter road — review aisle layout (enclosed areas are unreachable by vehicles).`
      );
    }

    // Enclosed holes are still road surface: append them as extra loops so the
    // multi-loop even-odd DXF hatch fills them (outer=road, island=hole,
    // hole-in-island=road) instead of silently dropping them.
    // Corners that lie ON a verbatim traced ring keep their drawn angle —
    // the fillet radius clamps to ~half of any short edge and would carve
    // deep arcs into the drawn outline. With no verbatim traced roads the
    // predicate never fires and the network is byte-identical to before.
    const skipVerbatimCorner = (pt: Pt): boolean =>
      verbatimCornerRings.some(ring => distanceToPolygonEdge(pt, ring) <= 0.75);
    // Roads-mode flare parity with compact: an entrance-flare `outline` keeps
    // its drawn EXTERIOR apron — the outline polygon itself bounds the
    // allowance (exactly like the compact branch's extAllow). The yard
    // interior is already inside the outer edge, so only the apron past the
    // fence is new; a gate-width bridge from the gate into the yard
    // guarantees the union stays one connected ring even when the drawn
    // flare stops AT the fence line.
    for (const fl of tracedFlareOutlines) {
      try {
        let seg: { q: Pt; ux: number; uy: number } | null = null;
        let segD = Infinity;
        for (let i = 0; i < fence.length; i++) {
          const a = fence[i], b = fence[(i + 1) % fence.length];
          const dx = b.x - a.x, dy = b.y - a.y;
          const L2 = dx * dx + dy * dy;
          if (L2 < 1e-6) continue;
          const t = Math.max(0, Math.min(1, ((fl.gate.x - a.x) * dx + (fl.gate.y - a.y) * dy) / L2));
          const q = { x: a.x + t * dx, y: a.y + t * dy };
          const d = Math.hypot(fl.gate.x - q.x, fl.gate.y - q.y);
          if (d < segD) { segD = d; seg = { q, ux: dx / Math.sqrt(L2), uy: dy / Math.sqrt(L2) }; }
        }
        if (!seg || segD >= 5) continue;
        const { q, ux, uy } = seg;
        let nx = -uy, ny = ux;
        if (!pointInPolygon({ x: q.x + nx * 10, y: q.y + ny * 10 }, fence)) { nx = -nx; ny = -ny; }
        const hw = 12; // 24 ft — the standard gate width
        // Two connectivity legs: INWARD to the outer edge (the flare quad can
        // stop short of the perimeter ring), and OUTWARD to the quad's
        // nearest boundary point (drawn aprons can start 60-100+ ft past the
        // fence, possibly offset laterally — a perpendicular leg could miss,
        // and a disjoint quad would be dropped by the largest-ring pick).
        const inward: PCRing = [
          [q.x - ux * hw, q.y - uy * hw],
          [q.x + ux * hw, q.y + uy * hw],
          [q.x + ux * hw + nx * 60, q.y + uy * hw + ny * 60],
          [q.x - ux * hw + nx * 60, q.y - uy * hw + ny * 60],
        ];
        const legs: PCRing[][] = [[[...inward]] as PCRing[]];
        const qd = ringEdgeNearest(q, fl.ring as [number, number][]);
        // Only a DISJOINT flare needs the outward leg — when the gate already
        // sits inside the drawn outline, an extension would add generated
        // pavement past the verbatim boundary.
        if (qd && qd.d > 2 && qd.d < 400 &&
            !pointInPolygon(q, fl.ring.map(([x, y]) => ({ x, y })))) {
          const dx = qd.pt.x - q.x, dy = qd.pt.y - q.y;
          const L = Math.hypot(dx, dy) || 1;
          const ox = dx / L, oy = dy / L;   // toward the quad
          const wx = -oy, wy = ox;          // bridge width axis
          const ext = Math.min(L + 4, 400);
          legs.push([[
            [q.x - wx * hw, q.y - wy * hw],
            [q.x + wx * hw, q.y + wy * hw],
            [q.x + wx * hw + ox * ext, q.y + wy * hw + oy * ext],
            [q.x - wx * hw + ox * ext, q.y - wy * hw + oy * ext],
          ] as PCRing]);
        }
        const expanded = polygonClipping.union(
          [[outerEdge.map(p => [p.x, p.y] as [number, number])]] as any,
          [[fl.ring]] as any, ...(legs as any[])) as PCRing[][];
        let bestRing: PCRing | null = null;
        for (const poly of expanded) {
          const r = poly[0];
          if (r && r.length >= 3 &&
              (!bestRing || Math.abs(polygonArea(ringToPts(r))) > Math.abs(polygonArea(ringToPts(bestRing))))) {
            bestRing = r;
          }
        }
        if (bestRing) outerEdge = ringToPts(bestRing);
      } catch { /* boolean failure — keep the fence-following ring */ }
    }
    roadNetwork = {
      outer: filletClosedPolygon(outerEdge, CLEARANCES.roadOuterRadius, skipVerbatimCorner),
      islands: [...carvedIslands, ...enclosedRoadHoles].map(p =>
        filletClosedPolygon(p, CLEARANCES.roadInnerRadius, skipVerbatimCorner)
      ),
    };
    outerEdgeForGate = outerEdge;
  }

  // ---- drafter-drawn roads on COMPACT layouts ------------------------------
  // Compact omits the whole generated network, and the block above (which
  // also processes drawn roads) is skipped with it — so drawn roads used to
  // be silently ignored on compact layouts: no surface, no warning, a phantom
  // edit. Compact drawn roads are now built as their own road region.
  //
  // Validation matches the roads-mode gate with ONE relaxation: the legal
  // region uses the bare pad rectangles (clearance 0) instead of inflating
  // every pad by the 3 ft road-edge clearance. Compact rows are deliberately
  // packed tighter than that clearance, so the inflated region would reject
  // every possible route; the drafter accepted relaxed clearances by choosing
  // compact. A route that actually crosses a pad still rejects loudly with
  // the stable `Drawn road <id> rejected:` prefix.
  //
  // The accepted strips become the network via the same even-odd loop model
  // as everywhere else: every closed loop toggles road/not-road, so disjoint
  // strips are simply extra loops (largest ring serves as `outer`).
  if (compact && customRoads.length) {
    const roadLegal = drawnRoadLegalRegion(fence, equipment, bandInset, 0);
    const stripPolys: PCRing[][] = [];
    // Traced (KMZ) strips are reference-wins geometry: their surface is kept
    // exactly where drawn, INCLUDING outside the fence (gate entry aprons),
    // so they bypass the yard clip below. Drafter-drawn strips stay clipped.
    const tracedPolys: PCRing[][] = [];
    // Verbatim drawn-outline pieces (yard networks / pads): clipped against
    // the tight 3 ft fence gap, not the deep bandInset clearance yard.
    const tracedSurfacePolys: PCRing[][] = [];
    // The flagged gate point for the generated entrance throat (folded in
    // below) — captured BEFORE verbatim routing sends surface-only entrance
    // records to tracedSurfacePolys.
    let tracedGatePt: Pt | null = null;
    let tracedGateSurface: PCRing | null = null;
    // Gate + drawn approach ring resolved BEFORE the strip loop: scan order
    // follows the drawing, so an apron record can precede the entrance
    // record in customRoads (Big Iron Area 4), and the bare-apron pavement
    // guard below needs the gate for the FIRST record it visits.
    for (const road of customRoads) {
      if (road.traced && road.entrance && road.gate) {
        tracedGatePt = road.gate;
        // Keep the drawn ring around for the gate-junction infill below —
        // the generated throat/legs are rectangles and can't follow a
        // tapered drawn approach.
        if (road.surface && road.surface.length >= 3) {
          tracedGateSurface = road.surface.map(p => [p.x, p.y] as [number, number]);
        }
        break;
      }
    }
    // One gate crossing per area: when the trace commit marked entrance
    // roads, ONLY those keep pavement outside the fence — every other traced
    // strip is clipped to the fence interior (piece by piece; a failed clip
    // keeps the unclipped piece rather than dropping pavement). Designs
    // without any entrance flag (older saves, single-yard traces) keep the
    // original everything-bypasses behavior.
    const entranceRule = customRoads.some(r => r.traced && r.entrance);
    const tracedEntrancePolys: { poly: PCRing[]; gate?: Pt; outlineRing?: [number, number][]; verbatim?: boolean }[] = [];
    // Wholly-outside public-road pavement: kept, but clipped to the fence
    // EXTERIOR so it can never read as a second fence crossing.
    const tracedApronPolys: PCRing[][] = [];
    // Surviving post-clip apron rings — leg targets for the gate-throat
    // bridge so disjoint gate aprons stay connected to the yard ring.
    const apronRings: PCRing[] = [];
    for (const road of customRoads) {
      const pts = road.pts;
      if (!pts || pts.length < 2) continue;
      const rw = (road.width && Number.isFinite(road.width))
        ? Math.max(12, Math.min(60, road.width)) : roadW;
      // Traced roads carrying a verbatim drawn polygon (closed-outline
      // `surface` or entrance-flare `outline`) render exactly what the
      // reference drew — extending the centerline past its drawn ends
      // overshoots the outline (the gate flare used to run long).
      const verbatimRoad = road.traced &&
        ((road.surface?.length ?? 0) >= 3 || (road.outline?.length ?? 0) >= 3);
      const stripPts = road.traced && !verbatimRoad ? extendRouteEnds(pts, rw / 2) : pts;
      const pieces = filletPolylineStrip(stripPts, rw, CLEARANCES.roadInnerRadius);
      if (!pieces.length) {
        roadWarnings.push(road.traced
          ? `Traced road ${road.id} placed with warning: the reference route is too short to form a road strip — kept in the project but no surface was added.`
          : `Drawn road ${road.id} rejected: too short to form a road strip.`);
        continue;
      }
      const ev = evaluateDrawnRoad(pts, fence, equipment, roadLegal, undefined, rw);
      if (ev.stripArea > 0 && ev.frac < 0.98) {
        const blockedFt = Math.round(ev.blockedArea / rw);
        const totalFt = Math.round(ev.stripArea / rw);
        if (road.traced) {
          roadWarnings.push(`Traced road ${road.id} placed with warning: ~${blockedFt} ft of the ${totalFt} ft reference route is blocked by equipment or the fence road setback — the clear part of the drawn road was kept.`);
        } else {
          roadWarnings.push(
            `Drawn road ${road.id} rejected: ~${blockedFt} ft of the ${totalFt} ft route crosses equipment pads or the fence road setback — in a compact layout, route through the open aisles between the packed rows.`
          );
          continue;
        }
      }
      // A verbatim traced record renders its drawn polygon ALONE — the
      // constant-width strip from the representative centerline overruns a
      // tapered flare's narrow end (and arbitrary outline sides), so strip
      // geometry stays OUT of the pavement union (it still drove the
      // too-short / blocked-route validation above; picking resolves
      // verbatim roads by point-in-polygon on the drawn outline).
      const renderPieces: PCRing[] = verbatimRoad
        ? [
            ...(road.surface && road.surface.length >= 3
              ? [road.surface.map(p => [p.x, p.y] as [number, number])] : []),
            ...(road.outline && road.outline.length >= 3
              ? [road.outline.map(p => [p.x, p.y] as [number, number])] : []),
          ]
        : pieces;
      if (verbatimRoad) {
        if (road.surface && road.surface.length >= 3) verbatimCornerRings.push(road.surface);
        if (road.outline && road.outline.length >= 3) verbatimCornerRings.push(road.outline);
      }
      const target: PCRing[][] = [];
      try {
        const polys = renderPieces.map(r => [[r]] as PCRing[][]);
        const unioned: PCRing[][] = polys.length === 1
          ? polys[0]
          : polygonClipping.union(polys[0] as any, ...(polys.slice(1) as any[])) as PCRing[][];
        target.push(...unioned);
      } catch {
        for (const ring of renderPieces) target.push([ring]);
      }
      if (!road.traced) stripPolys.push(...target);
      else if (verbatimRoad && (road.outline?.length ?? 0) < 3 && !(entranceRule && road.apron && !road.entrance)) {
        // A closed drawn `surface` is yard pavement: ALWAYS clipped to the
        // tight 3-ft fence inset — even when the gate walk flagged the record
        // as the entrance — so compact renders it exactly like roads mode.
        // The exterior gate allowance exists for drawn flare `outline`s only.
        // A pure APRON carrying a scan-committed surface is exempt: its ring
        // IS the outside-fence entrance approach, and the 3-ft inset clip
        // would erase it entirely.
        tracedSurfacePolys.push(...target);
      } else if (entranceRule && road.entrance) {
        // Carry the drawn flare outline ring so the clipping step can use it
        // as the precise exterior-crossing region instead of a large disc.
        const outlineRing = road.outline && road.outline.length >= 3
          ? road.outline.map(p => [p.x, p.y] as [number, number])
          : undefined;
        for (const poly of target) tracedEntrancePolys.push({ poly, gate: road.gate, outlineRing, verbatim: verbatimRoad });
      } else if (entranceRule && road.apron) {
        // Render-time mirror of the scan's tracedApronKeepsPavement rule: a
        // stale save can still carry a passing-corridor strip that an older
        // rules version committed as an apron (Big Iron Area 4's ~1,460 ft
        // fence-hugging band paved ~36k sqft outside the fence) — bare OR
        // carrying a drawn surface/outline ring. When the re-derivation
        // cannot run (missing drawing, analyze failure) records render
        // as-is, so EVERY apron re-proves gate reach here with its own
        // ring: legit flare rings measure ~100% of their perimeter within
        // reach, passing corridors well under half. Without a gate point to
        // measure against, keep the drawn pavement (never silently drop).
        const ring = (road.surface?.length ?? 0) >= 3 ? road.surface
          : (road.outline?.length ?? 0) >= 3 ? road.outline
          : undefined;
        if (tracedGatePt && !tracedApronKeepsPavement(road.pts, ring, tracedGatePt)) {
          // Pave-as-drawn override: the drafter confirmed this strip really
          // is on-parcel pavement (e.g. a legitimately longer entrance
          // drive), so pave it exactly as drawn and keep a warning instead —
          // same keep-and-warn policy as drawn-road accept gates.
          if (tracedRoadFingerprintMatch(tracedRoadFingerprint(road.pts), pavedTracedRoads)) {
            roadWarnings.push(
              `Traced road ${road.id} paved as drawn by drafter override: it fails the gate-apron rule ` +
              `(${ring ? 'its drawn ring sits away from the gate' : 'the strip does not terminate at the gate'}) — ` +
              'verify the entrance approach in detailed design.');
            tracedApronPolys.push(...target);
          } else {
            roadWarnings.push(ring
              ? `Traced road ${road.id} kept as reference linework only: its drawn ring sits away from the gate (off-site pavement).`
              : `Traced road ${road.id} kept as reference linework only: the strip runs past the gate rather than terminating at it (off-site context road).`);
          }
        } else {
          tracedApronPolys.push(...target);
        }
      } else if (road.apron) {
        // No entrance road in this area (substation yards bucket the
        // between-area context corridor): a pavement-bearing apron only
        // makes sense next to a gate. These used to fall through to the
        // plain traced bucket and pave UNCLIPPED outside the fence. The
        // pave-as-drawn override is honored here too — it still gets the
        // fence-band cut, and roadRegionFromNetwork's XOR semantics render
        // a detached forced strip as pavement.
        if (tracedRoadFingerprintMatch(tracedRoadFingerprint(road.pts), pavedTracedRoads)) {
          roadWarnings.push(
            `Traced road ${road.id} paved as drawn by drafter override: it lies outside the fence and this ` +
            'area has no gate entrance road — verify the entrance approach in detailed design.');
          tracedApronPolys.push(...target);
        } else {
          roadWarnings.push(`Traced road ${road.id} kept as reference linework only: it lies outside the fence and this area has no gate entrance road.`);
        }
      }
      else if (verbatimRoad) tracedSurfacePolys.push(...target);
      else tracedPolys.push(...target);
    }
    if (stripPolys.length || tracedPolys.length || tracedSurfacePolys.length || tracedEntrancePolys.length || tracedApronPolys.length) {
      try {
        // Drafter-drawn surface stays inside the fence band; traced strips
        // keep their full drawn extent (gate aprons legitimately reach past
        // the fence). Both stay off every bare pad (slightly shrunk so
        // shared edges stay clean, same as the carve).
        const yard = insetPolygon(fence, bandInset);
        let region = stripPolys.length
          ? polygonClipping.intersection(
              stripPolys as any, [[yard.map(p => [p.x, p.y] as [number, number])]] as any) as PCRing[][]
          : [] as PCRing[][];
        if (tracedPolys.length || tracedEntrancePolys.length || tracedApronPolys.length || tracedSurfacePolys.length) {
          // Fold traced pieces in ONE AT A TIME: polygon-clipping throws on
          // occasional near-degenerate rings (long chained comb strips), and
          // a single big union used to abort the WHOLE road region for the
          // area — every drawn road vanished. A piece that still fails is
          // skipped alone.
          const fenceRegion = [[fence.map(p => [p.x, p.y] as [number, number])]];
          // Under the one-gate rule, non-entrance traced pavement stops
          // SHORT of the fence (≥3 ft even in perimeter-flush mode) so it
          // can never read as touching pavement kept outside the fence.
          const entranceYard = bandInset >= 3 ? yard : insetPolygon(fence, 3);
          const yardRegion = [[entranceYard.map(p => [p.x, p.y] as [number, number])]];
          // Verbatim traced surfaces are the customer's authoritative
          // pavement polygons: render them fully inside the fence with only
          // the ≥3 ft never-touch-the-fence gap. The deeper bandInset yard
          // is a clearance proxy for approximated strips — applied to a
          // verbatim outline it eats the drawn ring road's inner band.
          const surfaceYardRegion = [[insetPolygon(fence, 3).map(p => [p.x, p.y] as [number, number])]];
          let foldFailures = 0;
          const foldIn = (cp: PCRing[]) => {
            try {
              region = region.length
                ? polygonClipping.union(region as any, [cp] as any) as PCRing[][]
                : [cp];
            } catch {
              // Union failures skip ONE piece; surface it instead of
              // silently thinning the drawn pavement (warn once per area —
              // the fold runs per piece and a bad drawing repeats).
              foldFailures++;
            }
          };
          for (const tp of tracedPolys) {
            // A piece whose clip fails keeps its full extent (warn-only
            // policy — never silently drop drawn pavement).
            let clipped: PCRing[][] = [tp];
            if (entranceRule) {
              try {
                clipped = polygonClipping.intersection([tp] as any, yardRegion as any) as PCRing[][];
              } catch { clipped = [tp]; }
            }
            clipped.forEach(foldIn);
          }
          for (const tp of tracedSurfacePolys) {
            // Verbatim surfaces clip to the 3 ft fence gap REGARDLESS of
            // gate flags — a yard with no detected entrance must not render
            // its drawn network spilling outside the fence either.
            let clipped: PCRing[][] = [tp];
            try {
              clipped = polygonClipping.intersection([tp] as any, surfaceYardRegion as any) as PCRing[][];
            } catch { clipped = [tp]; }
            clipped.forEach(foldIn);
          }
          // The gate entrance keeps pavement inside the fence PLUS an exterior
          // region around the gate itself — the flare apron and the entry stub
          // live there — so a road that crosses at the gate AND somewhere else
          // keeps only its gate crossing.
          //
          // When the entrance road carries a drawn flare outline, use that
          // outline polygon as the precise exterior-crossing region. A wide road
          // bundle that happens to cross the fence within a large disc but is
          // NOT part of the flare is excluded — the opening is the flare throat
          // width, not the disc diameter. When there is no drawn outline (plain
          // entry stub), fall back to a disc sized for a standard driveway.
          const GATE_DISC_FT = 80; // fallback disc: covers a standard gate entry
          for (const { poly, gate, outlineRing, verbatim } of tracedEntrancePolys) {
            let clipped: PCRing[][] = [poly];
            if (gate) {
              try {
                let extAllow: [number, number][];
                if (outlineRing && outlineRing.length >= 3) {
                  // Use the drawn flare outline polygon as the exterior allow
                  // region so only pavement inside the flare's own footprint
                  // (or inside the fence) is kept — no spillover from a nearby
                  // wide road bundle that the disc would otherwise capture.
                  extAllow = outlineRing;
                } else {
                  // Fallback disc for entry stubs without a drawn flare outline.
                  const disc: [number, number][] = [];
                  for (let i = 0; i < 32; i++) {
                    const a = (i / 32) * Math.PI * 2;
                    disc.push([gate.x + Math.cos(a) * GATE_DISC_FT, gate.y + Math.sin(a) * GATE_DISC_FT]);
                  }
                  extAllow = disc;
                }
                // Away from its gate an entrance road obeys the same short-of-
                // the-fence inset as every other traced road; only the exterior
                // allow region lets pavement run through the fence line.
                const allow = polygonClipping.union(
                  (verbatim ? surfaceYardRegion : yardRegion) as any, [[extAllow]] as any);
                clipped = polygonClipping.intersection([poly] as any, allow as any) as PCRing[][];
              } catch {
                // Warn-only policy: a failed gate clip keeps the UNCLIPPED
                // entrance pavement (never silently drop the driveway), but
                // the drafter must hear that the one-gate trim didn't run.
                roadWarnings.push('Traced gate entrance placed with warning: the gate-area trim failed for this geometry — the full drawn entrance pavement was kept unclipped.');
                clipped = [poly];
              }
            }
            clipped.forEach(foldIn);
          }
          if (tracedApronPolys.length) {
            // Cut aprons against the fence PLUS a thin band along its edges:
            // a bare polygon difference leaves hairline pavement slivers on
            // the fence line at concave corners, which read as extra fence
            // crossings. The band keeps outside pavement ~1.5 ft clear.
            const APRON_GAP_FT = 1.5;
            let apronCut: PCRing[][] = fenceRegion as any;
            try {
              const bands: any[] = [];
              for (let i = 0; i < fence.length; i++) {
                const a = fence[i], b = fence[(i + 1) % fence.length];
                const L = Math.hypot(b.x - a.x, b.y - a.y);
                if (L < 1e-6) continue;
                const ux = (b.x - a.x) / L, uy = (b.y - a.y) / L;
                const nx = -uy, ny = ux, g = APRON_GAP_FT;
                const ax = a.x - ux * g, ay = a.y - uy * g;
                const bx = b.x + ux * g, by = b.y + uy * g;
                bands.push([[[ax + nx * g, ay + ny * g], [bx + nx * g, by + ny * g],
                             [bx - nx * g, by - ny * g], [ax - nx * g, ay - ny * g]]]);
              }
              apronCut = polygonClipping.union(fenceRegion as any, ...bands) as PCRing[][];
            } catch { apronCut = fenceRegion as any; }
            for (const tp of tracedApronPolys) {
              let clipped: PCRing[][] = [tp];
              try {
                clipped = polygonClipping.difference([tp] as any, apronCut as any) as PCRing[][];
              } catch {
                // Warn-only policy: a failed fence-band cut keeps the whole
                // apron piece rather than dropping drawn pavement.
                roadWarnings.push('Traced gate apron placed with warning: the fence-clearance cut failed for this geometry — the full drawn apron was kept.');
                clipped = [tp];
              }
              clipped.forEach(foldIn);
              // Keep the surviving outside pieces as leg targets below: an
              // apron disjoint from the yard ring would otherwise land in the
              // network's island list (a hole) and vanish from the render.
              for (const cp of clipped) if (cp[0]?.length >= 3) apronRings.push(cp[0]);
            }
          }
          if (foldFailures) {
            roadWarnings.push(`Drawn road pavement placed with warning: ${foldFailures} piece(s) could not be merged into the road region for this geometry and were skipped.`);
          }
          // Generated gate throat: traced commits force compact mode, which
          // omits the whole generated road network — including the entrance
          // road the roads-mode branch unions through the gate below. Every
          // traced piece stops short of the fence line (surfaces clip to the
          // 3 ft inset UNCONDITIONALLY; aprons keep a 1.5 ft clear band), so
          // without a throat NOTHING straddles the fence and the yard reads
          // as sealed. Union a gate-width stub through the flagged gate —
          // generated geometry, never surface-record pavement — so the yard
          // keeps exactly one fence crossing at the gate, drawn flare or not.
          if (tracedGatePt && !removedRoads.includes(GATE_ENTRANCE_ROAD_ID)) {
            const gatePt = tracedGatePt;
            const THROAT_HW = 12; // 24 ft throat — matches GATE_W below
            // Leg targets: drawn flare outlines AND clipped gate aprons —
            // computed up front because they also steer the throat
            // orientation at corner gates below.
            const legTargets: PCRing[] = [
              ...tracedEntrancePolys
                .filter(e => (e.outlineRing?.length ?? 0) >= 3)
                .map(e => e.outlineRing!),
              ...apronRings,
            ];
            type ThroatCand = { q: Pt; ux: number; uy: number; nx: number; ny: number; d: number };
            const cands: ThroatCand[] = [];
            for (let i = 0; i < fence.length; i++) {
              const a = fence[i], b = fence[(i + 1) % fence.length];
              const dx = b.x - a.x, dy = b.y - a.y;
              const L2 = dx * dx + dy * dy;
              if (L2 < 1e-6) continue;
              const t = Math.max(0, Math.min(1, ((gatePt.x - a.x) * dx + (gatePt.y - a.y) * dy) / L2));
              const q = { x: a.x + t * dx, y: a.y + t * dy };
              const d = Math.hypot(gatePt.x - q.x, gatePt.y - q.y);
              if (d >= 5) continue;
              // Inward normal probed from the segment MIDPOINT: a corner
              // gate's q lies on the adjacent edge's line, where a q-based
              // probe is ambiguous and can flip the normal.
              const ux = dx / Math.sqrt(L2), uy = dy / Math.sqrt(L2);
              const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
              let nx = -uy, ny = ux;
              if (!pointInPolygon({ x: mx + nx * 10, y: my + ny * 10 }, fence)) { nx = -nx; ny = -ny; }
              cands.push({ q, ux, uy, nx, ny, d });
            }
            cands.sort((c1, c2) => c1.d - c2.d);
            let seg: ThroatCand | null = cands[0] ?? null;
            // A gate ON a fence corner is equidistant to both edges — the
            // nearest-segment tie is arbitrary, and the losing orientation
            // points the 40 ft outward throat along the other edge into open
            // dirt (an unpaved-side "knob"). Break near-ties toward the drawn
            // approach: prefer the segment whose outward end lands nearest a
            // leg target. Mid-edge gates have one candidate and are unchanged.
            if (seg && legTargets.length) {
              const near = cands.filter(c => c.d <= cands[0].d + 1.5);
              if (near.length > 1) {
                const outwardScore = (c: ThroatCand): number => {
                  const ex = c.q.x - c.nx * 40, ey = c.q.y - c.ny * 40;
                  let best = Infinity;
                  for (const ring of legTargets) {
                    if (pointInPolygon({ x: ex, y: ey }, ring.map(([x, y]) => ({ x, y })))) return 0;
                    const qd = ringEdgeNearest({ x: ex, y: ey }, ring);
                    if (qd && qd.d < best) best = qd.d;
                  }
                  return best;
                };
                let bestC = near[0], bestS = outwardScore(near[0]);
                for (const c of near.slice(1)) {
                  const sc = outwardScore(c);
                  if (sc < bestS - 1e-9) { bestC = c; bestS = sc; }
                }
                seg = bestC;
              }
            }
            if (seg) {
              const { q, ux, uy, nx, ny } = seg;
              // 40 ft in (meets the inset-clipped ring road), 40 ft out (the
              // ±12 ft gate probes sit in this band). Drawn flare aprons can
              // start 60-100+ ft past the fence AND sit laterally off the gate
              // axis — connect each disjoint apron with an oriented 24-ft leg
              // aimed at its nearest boundary point (+4 ft into the outline)
              // so the entrance pavement stays continuous from yard to apron.
              // Generated geometry — surface records stay inset-clipped.
              const strip: PCRing = [
                [q.x - ux * THROAT_HW + nx * 40, q.y - uy * THROAT_HW + ny * 40],
                [q.x + ux * THROAT_HW + nx * 40, q.y + uy * THROAT_HW + ny * 40],
                [q.x + ux * THROAT_HW - nx * 40, q.y + uy * THROAT_HW - ny * 40],
                [q.x - ux * THROAT_HW - nx * 40, q.y - uy * THROAT_HW - ny * 40],
              ];
              // At a corner gate the throat's 40-ft INWARD half can exit
              // through the ADJACENT fence edge (the in-leg follows one
              // edge's normal, which is not "into the yard" near a corner) —
              // leaving a pavement tongue outside the fence beside the gate.
              // Keep the inward half only where it is truly inside the
              // fence; the outward half is kept whole. Mid-edge gates are
              // unaffected (their inward half is already inside).
              try {
                const B = 500;
                const outwardRect: PCRing = [
                  [q.x - ux * B, q.y - uy * B],
                  [q.x + ux * B, q.y + uy * B],
                  [q.x + ux * B - nx * B, q.y + uy * B - ny * B],
                  [q.x - ux * B - nx * B, q.y - uy * B - ny * B],
                ];
                const fenceRing: PCRing = fence.map(p => [p.x, p.y] as [number, number]);
                const allow = polygonClipping.union(
                  [[fenceRing]] as any, [[outwardRect]] as any) as PCRing[][];
                const clipped = polygonClipping.intersection(
                  [[strip]] as any, allow as any) as PCRing[][];
                clipped.forEach(foldIn);
              } catch { foldIn([strip]); }
              // Without a leg a disjoint flare/apron lands in the network's
              // island list (a hole) and vanishes from the render — the
              // "partially paved entrance flare" symptom.
              for (const ring of legTargets) {
                // A flare that already straddles the fence needs no leg — and
                // must not get one (generated pavement beyond the outline).
                if (pointInPolygon(q, ring.map(([x, y]) => ({ x, y })))) continue;
                const qd = ringEdgeNearest(q, ring);
                if (!qd || qd.d < 2 || qd.d >= 400) continue;
                const dx = qd.pt.x - q.x, dy = qd.pt.y - q.y;
                const L = Math.hypot(dx, dy) || 1;
                const ox = dx / L, oy = dy / L;   // toward the apron
                const wx = -oy, wy = ox;          // leg width axis
                // Leg width follows the target's NEAR boundary instead of a
                // fixed 24 ft: a drawn approach throat is wider than the gate
                // and sits off-center at corner gates, and the fixed-width
                // leg left an unpaved wedge beside itself (the gate "gap").
                // Collect target verts in the band just past the nearest
                // point, spread the leg to their lateral extent (never
                // narrower than the throat, capped at 60 ft a side), and run
                // it deep enough to reach the farthest collected vert.
                let wMin = -THROAT_HW, wMax = THROAT_HW, oMax = L;
                const oBand = Math.min(L, 60) + 20;
                for (const [vx, vy] of ring) {
                  const rx = vx - q.x, ry = vy - q.y;
                  const o = rx * ox + ry * oy;
                  if (o < -2 || o > oBand) continue;
                  const w = rx * wx + ry * wy;
                  if (w < -60 || w > 60) continue;
                  if (w < wMin) wMin = w;
                  if (w > wMax) wMax = w;
                  if (o > oMax) oMax = o;
                }
                const legLen = Math.min(oMax, 400) + 4;
                const leg: PCRing = [
                  [q.x + wx * wMin, q.y + wy * wMin],
                  [q.x + wx * wMax, q.y + wy * wMax],
                  [q.x + wx * wMax + ox * legLen, q.y + wy * wMax + oy * legLen],
                  [q.x + wx * wMin + ox * legLen, q.y + wy * wMin + oy * legLen],
                ];
                foldIn([leg]);
              }
              // The stub and legs are rectangles and cannot follow a tapered
              // drawn approach (chord edges, off-axis throats) — the slivers
              // left between them and the drawn edges read as dirt notches at
              // the gate. Fold in the DRAWN entrance pavement itself, bounded
              // to the fence↔target corridor: the surface ring intersected
              // with the convex hull of the gate throat and the leg targets.
              // The hull is gate-local by construction, so drawn pavement
              // elsewhere on the same ring (e.g. corridor roads kept as
              // linework) is untouched — surface records stay inset-clipped
              // everywhere else.
              if (tracedGateSurface && legTargets.length) {
                const hullPts: [number, number][] = [
                  [q.x - ux * THROAT_HW, q.y - uy * THROAT_HW],
                  [q.x + ux * THROAT_HW, q.y + uy * THROAT_HW],
                ];
                // Widen the hull's fence side to the drawn ring's own gate
                // crossing: the drawn approach is typically far wider than
                // the 24-ft generated throat (a corner gate's chord edge
                // crosses the fence well off-axis), and a throat-pinned hull
                // leaves a dirt triangle beside the approach. Crossings are
                // collected on the chosen fence segment's line, within 150 ft
                // of the gate — ring pavement beyond the fence elsewhere is
                // still discarded by the intersection below.
                for (let i = 0; i < tracedGateSurface.length; i++) {
                  const [x1, y1] = tracedGateSurface[i];
                  const [x2, y2] = tracedGateSurface[(i + 1) % tracedGateSurface.length];
                  const s1 = (x1 - q.x) * nx + (y1 - q.y) * ny;
                  const s2 = (x2 - q.x) * nx + (y2 - q.y) * ny;
                  if ((s1 > 0) === (s2 > 0)) continue;
                  const t = s1 / (s1 - s2);
                  const cxp = x1 + (x2 - x1) * t, cyp = y1 + (y2 - y1) * t;
                  const along = (cxp - q.x) * ux + (cyp - q.y) * uy;
                  if (Math.abs(along) < 150) hullPts.push([cxp, cyp]);
                }
                // Hull targets stay within 150 ft of the gate (tighter than
                // the 400-ft leg-target window): every hull point inside the
                // disc keeps the whole convex hull — and so the infill —
                // inside it. A drawn network that crosses the fence AGAIN
                // farther along (a second drawn stub the one-gate rule
                // trims) must never be re-paved by a hull stretched out to
                // a far-away apron.
                for (const ring of legTargets) {
                  for (const [vx, vy] of ring) {
                    if (Math.hypot(vx - q.x, vy - q.y) < 150) hullPts.push([vx, vy]);
                  }
                }
                const cross = (o: [number, number], a: [number, number], b: [number, number]) =>
                  (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
                const sorted = hullPts.slice().sort((p1, p2) => p1[0] - p2[0] || p1[1] - p2[1]);
                const lower: [number, number][] = [];
                for (const p of sorted) {
                  while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
                  lower.push(p);
                }
                const upper: [number, number][] = [];
                for (let i = sorted.length - 1; i >= 0; i--) {
                  const p = sorted[i];
                  while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
                  upper.push(p);
                }
                const hull = [...lower.slice(0, -1), ...upper.slice(0, -1)];
                if (hull.length >= 3) {
                  try {
                    const junction = polygonClipping.intersection(
                      [[tracedGateSurface]] as any, [[hull]] as any) as PCRing[][];
                    junction.forEach(foldIn);
                  } catch { /* keep stub+legs only */ }
                }
              }
            }
          }
        }
        const pads: PCRing[][] = equipment.map(e => {
          const h = equipHalves(e);
          return [rectRing(e.x, e.y, Math.max(0.1, h.hx - 0.05), Math.max(0.1, h.hy - 0.05))];
        });
        if (region.length && pads.length) {
          try {
            region = polygonClipping.difference(region as any, ...pads as any) as PCRing[][];
          } catch {
            // Same robustness rule for the pad carve: drop pads one at a
            // time rather than losing the entire region.
            for (const pad of pads) {
              try {
                region = polygonClipping.difference(region as any, [pad] as any) as PCRing[][];
              } catch { /* keep region uncarved for this pad */ }
            }
          }
        }
        const loops: Pt[][] = [];
        for (const poly of region) {
          for (const ring of poly) {
            const rp = ringToPts(ring);
            if (rp.length >= 3 && Math.abs(polygonArea(rp)) > 1) loops.push(rp);
          }
        }
        if (loops.length) {
          loops.sort((a, b) => Math.abs(polygonArea(b)) - Math.abs(polygonArea(a)));
          // Corners that lie ON a verbatim traced ring keep their drawn
          // angle (see the roads-mode branch) — with no verbatim traced
          // roads the predicate never fires, byte-identical to before.
          const skipVerbatimCorner = (pt: Pt): boolean =>
            verbatimCornerRings.some(ring => distanceToPolygonEdge(pt, ring) <= 0.75);
          roadNetwork = {
            outer: filletClosedPolygon(loops[0], CLEARANCES.roadOuterRadius, skipVerbatimCorner),
            islands: loops.slice(1).map(p =>
              filletClosedPolygon(p, CLEARANCES.roadInnerRadius, skipVerbatimCorner)),
          };
        } else {
          roadWarnings.push('Drawn roads were entirely clipped away by the fence or equipment — no road area added.');
        }
      } catch {
        roadWarnings.push('Extra road areas could not be computed for this geometry — drawn roads omitted.');
      }
    }
  }

  // Gate placement: score candidate points along the fence segments nearest
  // the chosen edge instead of blindly taking a segment midpoint. A good gate
  // (a) sits on a segment long enough for the opening with clearance from the
  // fence corners, (b) has a SHORT entrance road to the perimeter road, and
  // (c) meets that road roughly perpendicular to the fence (no diagonal
  // slashes across the yard). The gateEdge knob still decides which side of
  // the parcel is considered.
  const GATE_W = 24;
  const edgeScore = (midX: number, midY: number) => {
    switch (gateEdge) {
      case 'N': return -midY;
      case 'E': return -midX;
      case 'W': return midX;
      default: return midY; // 'S'
    }
  };

  // Exact nearest point on the perimeter road centerline (segment projection)
  const nearestOnPerim = (p: Pt): { q: Pt; d: number } | null => {
    if (perimCenterline.length < 2) return null;
    let best: { q: Pt; d: number } | null = null;
    for (let i = 0; i < perimCenterline.length; i++) {
      const s = perimCenterline[i], e = perimCenterline[(i + 1) % perimCenterline.length];
      const dx = e.x - s.x, dy = e.y - s.y;
      const L2 = dx * dx + dy * dy;
      const t = L2 > 0 ? Math.max(0, Math.min(1, ((p.x - s.x) * dx + (p.y - s.y) * dy) / L2)) : 0;
      const q = { x: s.x + dx * t, y: s.y + dy * t };
      const d = Math.hypot(q.x - p.x, q.y - p.y);
      if (!best || d < best.d) best = { q, d };
    }
    return best;
  };

  // Segments considered: those whose midpoint scores within a band of the
  // edge-most segment (20% of the parcel span), so the gate stays on the
  // requested side of the yard but is free to pick a better-connected spot.
  const xs = fence.map(p => p.x), ys = fence.map(p => p.y);
  const span = Math.max(
    Math.max(...xs) - Math.min(...xs),
    Math.max(...ys) - Math.min(...ys)
  );
  const segScores = fence.map((p, i) => {
    const q = fence[(i + 1) % fence.length];
    return edgeScore((p.x + q.x) / 2, (p.y + q.y) / 2);
  });
  const bestEdge = Math.min(...segScores);
  const band = span * 0.2;

  let best: { x: number; y: number; rot: number; q: Pt; d: number } | null = null;
  let bestCost = Infinity;
  for (let i = 0; i < fence.length; i++) {
    if (segScores[i] > bestEdge + band) continue;
    const a = fence[i], b = fence[(i + 1) % fence.length];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < GATE_W + 4) continue; // opening + minimal corner clearance
    const ux = (b.x - a.x) / len, uy = (b.y - a.y) / len;
    // Keep the whole opening (plus a small buffer) away from fence corners
    const tMin = Math.min(GATE_W / 2 + 5, len / 2);
    const tMax = Math.max(len - GATE_W / 2 - 5, len / 2);
    const ts: number[] = [];
    for (let t = tMin; t <= tMax + 1e-9; t += 15) ts.push(t);
    const mid = len / 2;
    if (!ts.some(t => Math.abs(t - mid) < 1e-9)) ts.push(Math.min(Math.max(mid, tMin), tMax));
    for (const t of ts) {
      const px = a.x + ux * t, py = a.y + uy * t;
      const n = nearestOnPerim({ x: px, y: py });
      if (!n) continue;
      // Perpendicularity: |sin| between the fence direction and the approach
      // to the road (1 = entrance road exactly perpendicular to the fence).
      let align = 1;
      if (n.d > 1) {
        const ax2 = (n.q.x - px) / n.d, ay2 = (n.q.y - py) / n.d;
        align = Math.abs(ux * ay2 - uy * ax2);
      }
      // Cost: short entrance road, near-perpendicular approach, mild pull
      // toward the true edge-most segment (deterministic tie-breaking by
      // strict < keeps the first/lowest-index candidate on exact ties).
      const cost = n.d + 45 * (1 - align) + 0.05 * (segScores[i] - bestEdge);
      if (cost < bestCost - 1e-9) {
        bestCost = cost;
        best = { x: px, y: py, rot: Math.atan2(b.y - a.y, b.x - a.x), q: n.q, d: n.d };
      }
    }
  }

  // Fallback (tiny/degenerate fences with no valid candidate): historical
  // midpoint of the edge-most segment.
  if (!best) {
    let bestIdx = 0, bestY = Infinity;
    for (let i = 0; i < fence.length; i++) {
      if (segScores[i] < bestY) { bestY = segScores[i]; bestIdx = i; }
    }
    const a = fence[bestIdx], b = fence[(bestIdx + 1) % fence.length];
    const gx = (a.x + b.x) / 2, gy = (a.y + b.y) / 2;
    const n = nearestOnPerim({ x: gx, y: gy });
    best = {
      x: gx, y: gy,
      rot: Math.atan2(b.y - a.y, b.x - a.x),
      q: n ? n.q : { x: gx, y: gy },
      d: n ? n.d : 0,
    };
  }

  // Drafter gate pin: snap the pinned point to the nearest spot on the fence
  // line where the full opening fits with corner clearance (any edge). A
  // valid pin overrides the automatic placement above; the entrance road is
  // re-derived from the pinned gate below.
  if (gatePin != null) {
    let pinBest: { x: number; y: number; rot: number; q: Pt; d: number } | null = null;
    let pinDist = Infinity;
    for (let i = 0; i < fence.length; i++) {
      const a = fence[i], b = fence[(i + 1) % fence.length];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len < GATE_W + 10) continue; // opening + corner clearance both sides
      const ux = (b.x - a.x) / len, uy = (b.y - a.y) / len;
      // Project the pin onto the segment, clamped so the opening keeps the
      // same corner buffer as the automatic placement.
      const tRaw = (gatePin.x - a.x) * ux + (gatePin.y - a.y) * uy;
      const t = Math.max(GATE_W / 2 + 5, Math.min(len - GATE_W / 2 - 5, tRaw));
      const px = a.x + ux * t, py = a.y + uy * t;
      const d = Math.hypot(px - gatePin.x, py - gatePin.y);
      if (d < pinDist - 1e-9) {
        pinDist = d;
        const n = nearestOnPerim({ x: px, y: py });
        pinBest = {
          x: px, y: py,
          rot: Math.atan2(b.y - a.y, b.x - a.x),
          q: n ? n.q : { x: px, y: py },
          d: n ? n.d : 0,
        };
      }
    }
    if (pinBest && pinDist <= GATE_PIN_SNAP_FT) {
      best = pinBest;
    } else {
      roadWarnings.push(
        `Pinned gate rejected: no fence segment within ${GATE_PIN_SNAP_FT} ft can hold the ${GATE_W} ft opening — keeping the automatic gate location.`
      );
    }
  }

  gate = { x: best.x, y: best.y, width: GATE_W, rotation: best.rot };

  // Entrance road: from the gate to its nearest point on the perimeter road
  // centerline (stays out of the equipment area). The drafter can delete it
  // like any other generated piece (sentinel id — it is the one generated
  // road with no index): the gate opening stays, but the driveway strip and
  // its apron union are both omitted so the ring is not silently left with a
  // paved approach the drawing no longer shows.
  const gateRemoved = removedRoads.includes(GATE_ENTRANCE_ROAD_ID);
  if (gateRemoved) {
    roadWarnings.push(
      'Gate entrance road removed by drafter edit — the yard keeps its gate opening and perimeter ring, ' +
      'but no paved approach connects them. Verify site ingress in detailed design or restore the entrance road.'
    );
  }
  if (best.d > 1 && !gateRemoved) {
    const ang = Math.atan2(best.q.y - best.y, best.q.x - best.x);
    const len = best.d + roadW / 2;
    roads.push({
      x: best.x + Math.cos(ang) * len / 2,
      y: best.y + Math.sin(ang) * len / 2,
      length: len,
      width: roadW,
      rotation: ang,
      id: GATE_ENTRANCE_ROAD_ID,
    });

    // Entrance apron: the rect above records the entrance in `roads`, but the
    // drawn/hatched road REGION is roadNetwork — without a union the filleted
    // perimeter ring sweeps straight past the gate and the plot reads as if
    // the rounded road blocks anyone from driving in. Union the same strip
    // into the (pre-fillet) outer edge polygon and re-fillet, so the gate
    // apron joins the loop as ONE continuous drive path with flared
    // outer-radius junctions where it meets the perimeter road.
    if (roadNetwork && outerEdgeForGate && outerEdgeForGate.length >= 3) {
      const ux = Math.cos(ang), uy = Math.sin(ang);
      const px = -uy, py = ux, hw = roadW / 2;
      const strip: [number, number][] = [
        [best.x + px * hw, best.y + py * hw],
        [best.x - px * hw, best.y - py * hw],
        [best.x - px * hw + ux * len, best.y - py * hw + uy * len],
        [best.x + px * hw + ux * len, best.y + py * hw + uy * len],
      ];
      try {
        const merged = polygonClipping.union(
          [[outerEdgeForGate.map(p => [p.x, p.y] as [number, number])]] as any,
          [[strip]] as any
        ) as [number, number][][][];
        let bestRing: Pt[] | null = null;
        for (const poly of merged) {
          const ring = ringToPts(poly[0]);
          if (ring.length >= 3 &&
              (!bestRing || Math.abs(polygonArea(ring)) > Math.abs(polygonArea(bestRing)))) {
            bestRing = ring;
          }
        }
        if (bestRing) {
          // The two fence-level corners of the entrance strip must NOT be
          // filleted. Without this guard, filletClosedPolygon produces
          // ~hw-radius quarter-circle arcs at the gate post positions —
          // nearly identical to the gate swing arcs (also hw radius) —
          // creating a visual "butterfly" that the client rejects. Fence-
          // level corners represent road-surface meeting the fence and must
          // read as square (reference sheet shows straight entrance sides).
          const fenceCorners: Pt[] = [
            { x: best.x + px * hw, y: best.y + py * hw },
            { x: best.x - px * hw, y: best.y - py * hw },
          ];
          const skipFenceLevelFillet = (pt: Pt): boolean =>
            fenceCorners.some(c => Math.hypot(pt.x - c.x, pt.y - c.y) < 2) ||
            verbatimCornerRings.some(ring => distanceToPolygonEdge(pt, ring) <= 0.75);
          roadNetwork = {
            ...roadNetwork,
            outer: filletClosedPolygon(bestRing, CLEARANCES.roadOuterRadius, skipFenceLevelFillet),
          };
        }
      } catch { /* boolean failure — keep the fence-following ring */ }
    }
  }

  // ---- drafter road deletions: point-to-point spans and whole roads -------
  // Applied last, on the FINAL region (perimeter ring + aisles + drawn roads +
  // gate apron), so a cut can delete any road surface in the yard regardless
  // of which pass produced it. Cut boundaries are added as plain unfilleted
  // loops: the drafter picked an exact area, and filleting it would round the
  // opening back out and return road they deleted.
  let roadsOut: RoadSegment[] = roads;
  let aislesOut: RoadSegment[] = aisles;
  if (roadCuts.length && roadNetwork) {
    const outerRing = edgeSegsToRing(roadNetwork.outer);
    const islandRings = roadNetwork.islands.map(isl => edgeSegsToRing(isl));
    const res = applyRoadCuts(outerRing, islandRings, roadCuts);
    for (const c of res.dormant) {
      roadWarnings.push(
        `Road cut ${c.id}${c.label ? ` (${c.label})` : ''} is dormant: it no longer overlaps any road surface ` +
        '— the layout changed under it, or that road was already deleted. The cut is kept and will re-apply ' +
        'if road returns there, or clear it in the layout edits panel.'
      );
    }
    if (res.applied.length) {
      // Two ways to record a cut in the network, and the choice matters for
      // the DRAWN linework (not just the fill):
      //
      // * Interior cut — the removed piece lies strictly inside the region,
      //   so it is a new hole. Appending it keeps `outer` untouched, which
      //   preserves the filleted ARC segments of the perimeter ring (and the
      //   radius callouts derived from them). This is the common case.
      //
      // * Boundary cut — the piece reaches the outer edge (severing the ring,
      //   or trimming the gate apron, which is unioned INTO `outer`). Here a
      //   hole is not enough: `outer` still traces the deleted pavement, so
      //   the road layer keeps drawing the outline of road the drafter
      //   deleted even though the hatch and the rects are correct. The ring
      //   set has to be rebuilt from the true post-cut region.
      //
      // Detected by area: a boundary cut shrinks the total outer-ring area,
      // an interior cut leaves it unchanged (it only adds holes).
      const outerAreaOf = (mp: PCRing[][]) =>
        mp.reduce((s, poly) => s + (poly[0] ? Math.abs(polygonArea(ringToPts(poly[0]))) : 0), 0);
      const cutTouchedBoundary =
        outerAreaOf(res.road) < Math.abs(polygonArea(outerRing)) - ROAD_CUT_MIN_SQFT;
      if (cutTouchedBoundary) {
        // Rebuild from the region itself: largest ring is the outer path, all
        // remaining rings are loops. roadRegionFromNetwork XORs them, and XOR
        // reproduces this exact region — holes toggle off, disjoint pieces
        // toggle on — so the region, hatch and edge linework finally agree.
        const rings: Pt[][] = [];
        for (const poly of res.road) {
          for (const ring of poly) {
            const r = ringToPts(ring);
            if (r.length >= 3) rings.push(r);
          }
        }
        rings.sort((a, b) => Math.abs(polygonArea(b)) - Math.abs(polygonArea(a)));
        if (rings.length) {
          roadNetwork = {
            ...roadNetwork,
            outer: ringToEdgePath(rings[0]),
            islands: rings.slice(1).map(ringToEdgePath),
          };
        }
      } else {
        roadNetwork = {
          ...roadNetwork,
          islands: [...roadNetwork.islands, ...res.added.map(ringToEdgePath)],
        };
      }
      // Access check on the POST-cut region: a deletion that strands equipment
      // is the drafter's call, but it is never silent.
      const reach = CLEARANCES.equipmentToRoadEdge + CLEARANCES.roadWidth;
      const probes = equipment.map(e => { const h = equipHalves(e); return { id: e.id, x: e.x, y: e.y, hx: h.hx, hy: h.hy }; });
      // Only equipment the CUT actually stranded. Interior units of a large
      // island are already beyond this reach before any edit, so reporting
      // the absolute set would blame each cut for hundreds of untouched items
      // and make the warning worthless.
      const lostBefore = new Set(roadAccessLoss(res.roadBefore, probes, reach));
      const lost = roadAccessLoss(res.road, probes, reach).filter(id => !lostBefore.has(id));
      const sqft = Math.round(res.removedSqft);
      roadWarnings.push(
        `${res.applied.length} road cut${res.applied.length === 1 ? '' : 's'} applied by drafter edit ` +
        `(~${sqft} sq ft of road surface removed) — the road network, crushed-rock surfacing, cable and ` +
        'feeder routing and all exports were rebuilt without it.'
      );
      if (lost.length) {
        const shown = lost.slice(0, 6).join(', ');
        roadWarnings.push(
          `Vehicle access lost: ${lost.length} equipment item${lost.length === 1 ? '' : 's'} ` +
          `(${shown}${lost.length > 6 ? `, +${lost.length - 6} more` : ''}) no longer reach the road network ` +
          'after the road deletions. Verify fire/O&M access in detailed design or restore the deleted road.'
        );
      }
      // The rect arrays are a SEPARATE representation of the same pavement
      // (3D meshes, DXF rects + hatch, drainage/grounding/terrain surfaces).
      // Trim them too, or every one of those surfaces redraws the road the
      // drafter just deleted. See trimRectsByCuts.
      roadsOut = trimRectsByCuts(roadsOut, res.applied);
      aislesOut = trimRectsByCuts(aislesOut, res.applied);
    }
  }

  return { roads: roadsOut, aisles: aislesOut, roadNetwork, gate, roadWarnings };
}

export function perimeterBandInset(mode: PerimeterBandMode | undefined): number {
  return mode === 'flush' ? 0 : CLEARANCES.frontToFence;
}

export function equipmentMarginFor(compact: boolean, band: PerimeterBandMode | undefined): number {
  return compact
    ? CLEARANCES.frontToFence
    : perimeterBandInset(band) + CLEARANCES.roadWidth + CLEARANCES.equipmentToRoadEdge;
}

function latticeSearchSteps(
  boundary: SiteBoundary,
  config: BessConfiguration,
  options: LayoutOptions
): { x: number; y: number } {
  const pcsClearance = options.hotClimate === false
    ? CLEARANCES.pcsStandard
    : CLEARANCES.pcsHotClimate;
  const fp = blockFootprint(config, pcsClearance);
  const mirrored = isMirroredPairConfig(config);
  const compact = (options.roadMode ?? 'auto') === 'compact';
  const gapX = mirrored ? pairBlockGapFt(pcsClearance) : CLEARANCES.frontToFront;
  const gapY = compact ? CLEARANCES.frontToFront : ROW_AISLE_GAP_FT;
  void boundary;
  return { x: fp.width + gapX, y: fp.depth + gapY };
}

export function placedIslandHasAug(spec: { aug?: boolean }): boolean {
  return spec.aug !== false;
}

export function placedIslandHasAuxCluster(spec: { auxGear?: boolean }): boolean {
  return spec.auxGear !== false;
}
export function placedSpecBlockCount(spec: PlacedIslandSpec): number {
  return spec.kind === 'single' || spec.kind === 'single2'
    ? SINGLE_MODULE_PCS
    : placedIslandPairs(spec.pairs) * 2;
}

export const SINGLE_MODULE_CONTAINERS = 3;

export const TWO_BESS_MODULE_CONTAINERS = 2;
export interface StagedBlockRotation<E> {
  n: number;
  members: E[];
  // Post-rotation clones of `members`, positionally aligned with it.
  rotated: E[];
  // Engineer override: the block stays in the accepted set even if it fails.
  forced: boolean;
  // Filled in by resolveStagedRotations with the failure it saw (if any).
  reason: string | null;
}

// Decide which staged block rotations may be committed.
//
// Every requested turn is staged FIRST, then each member is validated against
// the complete candidate field — the whole layout as it would stand with all
// still-accepted rotations applied at once. Validating turns one at a time as
// they were applied made the verdict depend on iteration order: an early block
// was measured against its peers' OLD footprints, so a legitimate whole-island
// turn could be rejected by a neighbour that the very same turn moves out of
// the way, and later blocks were measured against a half-turned island.
//
// Dropping a rejected block changes the field for everyone else (its members
// fall back to their un-turned footprints), so the scan repeats until the
// accepted set stops shrinking. Each pass either drops at least one block or
// ends the loop, so it is bounded by the number of staged blocks.
//
// Returns the set of block numbers whose rotation is accepted; each staged
// entry's `reason` holds the failure that was seen, if any.
export function resolveStagedRotations<E>(
  staged: StagedBlockRotation<E>[],
  equipment: E[],
  validate: (item: E, others: E[]) => string | null,
): Set<number> {
  const live = new Set(staged.map(s => s.n));
  for (let pass = 0; pass <= staged.length; pass++) {
    const candidates = new Map<E, E>();
    for (const s of staged) {
      if (!live.has(s.n)) continue;
      s.members.forEach((m, i) => candidates.set(m, s.rotated[i]));
    }
    const field = equipment.map(e => candidates.get(e) ?? e);
    let dropped = false;
    for (const s of staged) {
      if (!live.has(s.n)) continue;
      s.reason = null;
      for (const r of s.rotated) {
        // Validate the rotated item where it lands: the post-rotation clone
        // is measured against the complete candidate field.
        const reason = validate(r, field.filter(o => o !== r));
        if (reason) { s.reason = reason; break; }
      }
      // An override keeps the block in the field; only a genuine rejection
      // pulls it back out and forces another pass.
      if (s.reason && !s.forced) { live.delete(s.n); dropped = true; }
    }
    if (!dropped) break;
  }
  return live;
}

export function rotateEquipmentAbout(
  eq: PlacedEquipment, px: number, py: number, turns: number
): PlacedEquipment {
  const t = normalizeQuarterTurns(turns);
  let x = eq.x, y = eq.y;
  for (let i = 0; i < t; i++) {
    const dx = x - px, dy = y - py;
    x = px + dy; y = py - dx;
  }
  return { ...eq, x, y, rotation: eq.rotation - t * (Math.PI / 2) };
}

export const SINGLE_MODULE_PCS = 1;

/**
 * The polygon the security fence is drawn on for a parcel.
 *
 * SINGLE SOURCE for boundary -> fence: the BESS engine, the substation yard
 * generator and the empty multi-area design all call this, so a fence-placement
 * choice can never apply to some yards and not others. Everything downstream
 * (roads, gates, grounding, cables, compliance, 2D/3D/CAD, DXF, PDF, permit
 * packets) reads `design.fence` and therefore follows automatically.
 *
 * Undefined mode == 'inset': legacy sessions, legacy project files and the
 * default new design all take the historical inset path byte-identically.
 */
export function fencePolygonFor(boundaryPolygon: Pt[], mode?: FencePlacementMode): Pt[] {
  // DEEP copy, never the caller's array and never its point objects: the lot
  // line keeps being drawn as its own reference linework next to the fence, so
  // any in-place edit of a fence vertex downstream must not silently move the
  // imported property boundary with it. (`insetPolygon` already allocates
  // fresh points, so the two modes behave identically here.)
  return mode === 'property-line'
    ? boundaryPolygon.map(p => ({ x: p.x, y: p.y }))
    : insetPolygon(boundaryPolygon, CLEARANCES.fenceToLotLine);
}

/**
 * True when the placed-equipment constraints describe a KMZ-traced BESS yard.
 * Catalog/manual equipment deliberately does not opt a layout into this
 * customer-specific fence standard.
 */
export function isTracedBessYard(constraints?: LayoutConstraints | null): boolean {
  return (constraints?.placedEquipment ?? []).some(
    s => !isManualEquipmentSpec(s) && s.source === 'trace' &&
      (s.kind === 'inverter' || s.kind === 'bess'));
}
/**
 * One manual spec composed into a real PlacedEquipment. `commsSeq` numbers the
 * COMMS-<nn> label; callers pass a sequence that continues past the island
 * cabinets so two cabinets never print the same tag.
 */
export function composePlacedEquipment(
  spec: ManualEquipmentSpec, commsSeq = 1
): PlacedEquipment {
  const cat = MANUAL_EQUIPMENT_CATALOG[spec.type];
  const label = spec.type === 'commsCabinet'
    ? `COMMS-${String(commsSeq).padStart(2, '0')}`
    : cat.label;
  return {
    id: spec.id, kind: cat.kind, label,
    x: spec.x, y: spec.y,
    rotation: manualEquipmentAngle(spec) * Math.PI / 180,
    length: cat.dims.length, width: cat.dims.width, height: cat.dims.height,
  };
}

/**
 * SINGLE source of truth for whether a manually placed item is accepted.
 * buildLayout calls this at commit time and the drag ghost calls it every
 * frame, so the preview's red/green state can never disagree with the drop.
 *
 * Hard rejections are the unworkable cases (off the fenced yard, on top of
 * something already there, on a drive aisle). Clearance-margin findings accept
 * and warn, matching the placed-island contract — the engineer stays in charge
 * of where their gear goes.
 */
export function evaluatePlacedEquipmentDrop(
  spec: ManualEquipmentSpec,
  others: PlacedEquipment[],
  augZones: AugmentationZone[],
  // PINNED reserved rectangles only (drafter-pinned laydown / augmentation).
  // The AUTOMATIC reserved areas are deliberately not tested here: manual gear
  // is composed before placeReservedZones runs, so those areas are placed
  // around it. Testing them would make an accepted item start failing the next
  // time the auto laydown happened to move onto it.
  pins: { id: string; x: number; y: number; hx: number; hy: number }[],
  fence: Pt[],
  aisles: RoadSegment[],
  equipmentMargin: number
): PlacedEquipmentEvaluation {
  const soft: string[] = [];
  if (!Number.isFinite(spec.x) || !Number.isFinite(spec.y)) {
    return { hard: 'invalid anchor position', soft };
  }
  const e = composePlacedEquipment(spec);
  const rot = Math.abs(Math.sin(e.rotation)) > 0.5;
  const hx = (rot ? e.width : e.length) / 2;
  const hy = (rot ? e.length : e.width) / 2;
  if (!rectInsidePolygon(e.x, e.y, hx, hy, fence, 0)) {
    return { hard: 'it extends outside the fence line', soft };
  }
  // Separation matches the automatic small-panel pass so a hand-placed panel
  // is held to the same working clearance the generator uses.
  const PAD = 4;
  for (const o of others) {
    if (o.id === spec.id) continue;
    const oRot = Math.abs(Math.sin(o.rotation)) > 0.5;
    const ohx = (oRot ? o.width : o.length) / 2;
    const ohy = (oRot ? o.length : o.width) / 2;
    if (Math.abs(e.x - o.x) < hx + ohx + PAD && Math.abs(e.y - o.y) < hy + ohy + PAD) {
      return { hard: `it is within ${PAD} ft of ${o.label || o.id}`, soft };
    }
  }
  for (const z of augZones) {
    if (Math.abs(e.x - z.x) < hx + z.length / 2 + PAD && Math.abs(e.y - z.y) < hy + z.width / 2 + PAD) {
      return { hard: 'it overlaps an augmentation bay', soft };
    }
  }
  for (const p of pins) {
    if (Math.abs(e.x - p.x) < hx + p.hx + PAD && Math.abs(e.y - p.y) < hy + p.hy + PAD) {
      return { hard: 'it overlaps a pinned reserved area (laydown or future augmentation pin)', soft };
    }
  }
  for (const a of aisles) {
    if (Math.abs(e.x - a.x) < hx + a.length / 2 && Math.abs(e.y - a.y) < hy + a.width / 2) {
      return { hard: 'it sits on a drive aisle', soft };
    }
  }
  if (!rectInsidePolygon(e.x, e.y, hx, hy, fence, equipmentMargin)) {
    soft.push(`sits inside the ${Math.round(equipmentMargin)} ft perimeter road clearance margin`);
  }
  return { hard: null, soft };
}

/** Plan footprint of a manual item, for the drag ghost. */
export function placedEquipmentFootprints(spec: ManualEquipmentSpec): PlacementFootprint[] {
  const e = composePlacedEquipment(spec);
  return [{
    id: e.id, role: 'equipment',
    x: e.x, y: e.y, hx: e.length / 2, hy: e.width / 2,
    angleDeg: manualEquipmentAngle(spec),
  }];
}

export interface PlacedEquipmentEvaluation {
  hard: string | null;
  soft: string[];
}

export interface ManualEquipmentSpec {
  id: string;   // 'peq-<n>' — stable across regeneration
  type: ManualEquipmentType;
  x: number;
  y: number;
  // Quarter-turn orientation in degrees CCW (0 / 90 / 180 / 270). Absent = 0,
  // so a saved item written before rotation existed round-trips unchanged.
  angleDeg?: number;
}

export function isManualEquipmentType(v: unknown): v is ManualEquipmentType {
  return typeof v === 'string' && (MANUAL_EQUIPMENT_TYPES as readonly string[]).includes(v);
}

export function isManualEquipmentId(id: string): boolean {
  return id.startsWith(MANUAL_EQUIPMENT_ID_PREFIX);
}

export type PlacedEquipmentSpec = TracedEquipmentSpec | ManualEquipmentSpec;

/**
 * Scene-facing preview of a manual equipment drop: composes and evaluates
 * against the CURRENT design exactly as the commit will, so the ghost's
 * verdict and the drop's verdict are the same computation.
 */
export function previewPlacedEquipmentDrop(
  spec: ManualEquipmentSpec,
  design: SiteDesign,
  config: BessConfiguration,
  pcsClearance: number,
  roadMode: RoadMode,
  edits: LayoutConstraints
): PlacedEquipmentEvaluation {
  const equipmentMargin = roadMode === 'compact'
    ? CLEARANCES.frontToFence
    : CLEARANCES.frontToFence + CLEARANCES.roadWidth + CLEARANCES.equipmentToRoadEdge;
  // The live design already contains every other manual item, so the overlap
  // test naturally covers them; the item being MOVED is skipped by id.
  return evaluatePlacedEquipmentDrop(
    spec,
    design.equipment,
    design.augmentationZones,
    manualEquipmentPins(edits, config, pcsClearance),
    design.fence,
    design.aisles ?? [],
    equipmentMargin
  );
}

/** Prefix every manually placed equipment id carries. */
export const MANUAL_EQUIPMENT_ID_PREFIX = 'peq-';

/** Normalized quarter-turn angle (0 | 90 | 180 | 270) for a manual item. */
export function manualEquipmentAngle(spec: { angleDeg?: number }): number {
  const a = spec.angleDeg;
  if (!Number.isFinite(a)) return 0;
  const n = ((Math.round((a as number) / 90) * 90) % 360 + 360) % 360;
  return n;
}

export const MANUAL_EQUIPMENT_TYPES: readonly ManualEquipmentType[] = [
  'auxTransformer', 'auxSwitchgear', 'commsCabinet',
  'auxSwitchPanel', 'fiberPatchPanel', 'fireControlPanel',
] as const;

/**
 * Drafter-pinned reserved rectangles, in the shape evaluatePlacedEquipmentDrop
 * wants. Shared by the preview and the commit so both test the same pins.
 */
export function manualEquipmentPins(
  edits: LayoutConstraints, config: BessConfiguration, pcsClearance: number
): { id: string; x: number; y: number; hx: number; hy: number }[] {
  const pins: { id: string; x: number; y: number; hx: number; hy: number }[] = [];
  const fp = blockFootprint(config, pcsClearance);
  for (const [pinId, pt] of Object.entries(edits.augPins ?? {})) {
    if (Number.isFinite(pt?.x) && Number.isFinite(pt?.y)) {
      pins.push({ id: pinId, x: pt.x, y: pt.y, hx: fp.width / 2, hy: fp.depth / 2 });
    }
  }
  const ldPin = edits.laydownPin, ldSize = edits.laydownSize;
  if (ldPin && Number.isFinite(ldPin.x) && Number.isFinite(ldPin.y) &&
      ldSize && Number.isFinite(ldSize.length) && Number.isFinite(ldSize.width)) {
    pins.push({ id: 'laydown', x: ldPin.x, y: ldPin.y, hx: ldSize.length / 2, hy: ldSize.width / 2 });
  }
  return pins;
}

/** True for the catalog-driven manual record (see PlacedEquipmentSpec). */
export function isManualEquipmentSpec(spec: PlacedEquipmentSpec): spec is ManualEquipmentSpec {
  return typeof (spec as ManualEquipmentSpec).type === 'string';
}

export const MANUAL_EQUIPMENT_CATALOG: Record<ManualEquipmentType, {
  kind: PlacedEquipment['kind'];
  label: string;
  short: string;
  dims: { length: number; width: number; height: number };
}> = {
  auxTransformer: { kind: 'auxTransformer', label: 'AUX XFMR (HITACHI)', short: 'Aux Transformer', dims: HITACHI_AUX_XFMR },
  auxSwitchgear: { kind: 'auxSwitchgear', label: 'AUX DIST (IPS)', short: 'Aux Distribution', dims: IPS_SWITCHGEAR },
  // Label is filled in per item (COMMS-<nn>) so the reference naming
  // convention check keeps passing; `label` here is only the fallback.
  commsCabinet: { kind: 'commsCabinet', label: 'COMMS', short: 'Comms cabinet', dims: COMMS_CABINET },
  auxSwitchPanel: { kind: 'auxSwitchPanel', label: 'AUX SWITCH PANEL', short: 'Aux switch panel', dims: AUX_SWITCH_PANEL },
  fiberPatchPanel: { kind: 'fiberPatchPanel', label: 'FIBER PATCH PANEL', short: 'Fiber patch panel', dims: FIBER_PATCH_PANEL },
  fireControlPanel: { kind: 'fireControlPanel', label: 'FIRE CONTROL PANEL', short: 'FACP / Fire Alarm Control Panel', dims: FIRE_CONTROL_PANEL },
};

/**
 * Layout-aware boundary -> fence policy. Manual layouts retain the selected
 * inset/property-line mode; KMZ-traced BESS yards always use the boundary.
 */
export function fencePolygonForLayout(
  boundaryPolygon: Pt[],
  constraints?: LayoutConstraints | null,
  mode?: FencePlacementMode
): Pt[] {
  return fencePolygonFor(
    boundaryPolygon,
    isTracedBessYard(constraints) ? 'property-line' : mode
  );
}
