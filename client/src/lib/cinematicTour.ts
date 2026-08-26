import * as THREE from 'three';
import { SiteDesign, Pt, IslandInfo } from './nextera/types';
import type { FeederCircuit } from './nextera/feeders';
import type { BessConfiguration } from './nextera/catalog';
import { pointInPolygon, distanceToPolygonEdge } from './nextera/kmz';

// Cinematic marketing tour path builder. Generates a single continuous
// camera path from the loaded design (nothing hardcoded per site):
//
//   1. Establishing orbit — high above the yard, circling ~270° while
//      slowly descending, always looking at the yard center.
//   2. The dive — breaks off the orbit toward the gate entrance, dropping
//      to near eye level as the fence and gate grow in frame.
//   3. Drive-through — glides through the gate opening and along a
//      collision-checked corridor between the equipment islands at drone
//      height (~13 ft), with the look target leading the camera.
//   4. Pull-up bookend — rises at the far end back to the standard
//      full-site overview vantage (same fit math as the Overview preset).
//
// Everything here is presentation-only: pure geometry from the design,
// no store access, no effect on layout math or DXF/PDF exports.
//
// Coordinates: plan (x, y feet, y = north) like the rest of lib/. The
// scene mapping is (x, h, -y); toScene() below converts.

export interface TourFrame {
  x: number; y: number; h: number;    // camera position (plan + height ft)
  tx: number; ty: number; th: number; // look-at target
}

export interface TourPhases {
  orbitEnd: number;  // index of the last orbit frame
  gateIdx: number;   // index of the frame at the gate opening (-1: no gate)
  driveEnd: number;  // index of the last drive-through frame
}

export interface TourKeyframes {
  frames: TourFrame[];
  phases: TourPhases;
  duration: number; // seconds
  // Pacing knots for the sampler: end-frame index + authored time share of
  // each phase that is actually present (options can omit phases entirely).
  pace: { idx: number; share: number }[];
  // Index of the first pull-up bookend frame (-1 when the pull-up is off).
  pullStartIdx: number;
  // Equipment close-up segment (post-gate PCS/BESS beauty pass): index of
  // the top-down climb frame and of the last hold frame (-1 when absent).
  closeupHoldStartIdx: number;
  closeupEndIdx: number;
  // Feeder fly-along segment: index of the first arrival-hold frame over the
  // served island and of the last hold frame (-1 when absent).
  flyalongHoldStartIdx: number;
  flyalongEndIdx: number;
}

// Presentation-only extras the tour builder can use but the SiteDesign does
// not carry: the routed MV feeder polyline (substation -> island) for the
// fly-along segment. Purely optional — omitted extras reproduce the exact
// pre-extras path.
export interface TourExtras {
  /** Feeder route polyline in plan feet, FROM the substation TO the island
   * it serves (first point = substation end). null/short routes skip the
   * fly-along segment entirely. */
  feederRoute?: Pt[] | null;
}

// Pick the feeder the fly-along follows (the longest run reads best on
// camera; ties break to the lowest feeder number for determinism) and
// assemble its plan polyline from the substation to the island: the routed
// segments run island -> substation, so the concatenated chain is reversed.
// Pure function of the routed feeders — never mutates or re-routes anything.
export function feederFlyalongRoute(
  feeders: FeederCircuit[], substation: Pt | null,
): { route: Pt[]; feeder: FeederCircuit } | null {
  if (!substation || !Number.isFinite(substation.x) || !Number.isFinite(substation.y)) return null;
  let feeder: FeederCircuit | null = null;
  for (const f of feeders) {
    if (!f.segments.length) continue;
    if (!feeder || f.totalLengthFt > feeder.totalLengthFt + 1e-9
      || (Math.abs(f.totalLengthFt - feeder.totalLengthFt) <= 1e-9 && f.idx < feeder.idx)) feeder = f;
  }
  if (!feeder) return null;
  const chain: Pt[] = [];
  for (const seg of feeder.segments) {
    for (const p of seg.pts) {
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
      const last = chain[chain.length - 1];
      if (!last || Math.hypot(p.x - last.x, p.y - last.y) > 0.5) chain.push({ x: p.x, y: p.y });
    }
  }
  if (chain.length < 2) return null;
  const route = [...chain].reverse(); // substation first
  // The home run lands AT the substation; tolerate small landing offsets but
  // reject a route that never reaches it (corrupt/partial routing).
  if (Math.hypot(route[0].x - substation.x, route[0].y - substation.y) > 60) return null;
  let len = 0;
  for (let i = 1; i < route.length; i++) len += Math.hypot(route[i].x - route[i - 1].x, route[i].y - route[i - 1].y);
  return len > 50 ? { route, feeder } : null;
}

// Lookahead distances (ft) blended into one forward gaze point for the
// feeder fly-along. Averaging a window around the nominal 130 ft rounds the
// gaze through hard route corners (e.g. the turn toward the PCS row) so the
// target spline banks smoothly instead of pivoting at the vertex.
export const FLY_LOOKAHEAD_OFFSETS = [70, 130, 190] as const;

// ---------------------------------------------------------------------------
// Cinematic title intro (overlay-only). The intro plays over the opening
// orbit inside a fixed normalized-time window, so seeking/cancel re-derive it
// exactly; the content is a pure function of the design + configuration.
export const TOUR_INTRO_WINDOW = { start: 0.01, end: 0.17 } as const;

/** Staged intro progress (0 = hidden, 0..1 inside the window) as a pure
 * function of normalized tour time. */
export function introProgressAt(t: number): number {
  const { start, end } = TOUR_INTRO_WINDOW;
  if (t <= start || t >= end) return 0;
  return (t - start) / (end - start);
}

export interface TourIntroInfo {
  eyebrow: string;
  title: string;
  subtitle: string;    // location · acreage
  mw: number;
  mwh: number;
  hours: number;
  equipment: string[]; // manufacturer/config lines
}

const INVERTER_BRANDS: Record<BessConfiguration['inverterModel'], string> = {
  'GE FLEX 1571': 'GE VERNOVA FLEXINVERTER 1571 PCS',
  'PE FP4200M': 'POWER ELECTRONICS FP4200M PCS',
};

/** Drafter-typed intro text overrides (persisted with the tour options).
 * Blank/whitespace-only values fall back to the KMZ-derived defaults. */
export interface TourIntroOverrides {
  title?: string;
  subtitle?: string;
}

/** Build the intro title-card content from the design + effective equipment
 * configuration. Optional drafter overrides replace the KMZ-derived title
 * and/or subtitle (blank = default). Pure and deterministic — no store
 * access, no side effects. */
export function buildTourIntro(
  design: SiteDesign, cfg: BessConfiguration, overrides?: TourIntroOverrides,
): TourIntroInfo {
  const b = design.boundary;
  const titleOverride = overrides?.title?.trim();
  const subtitleOverride = overrides?.subtitle?.trim();
  const title = (titleOverride || b.kmlName || b.name || 'BESS SITE').toUpperCase();
  const locBits: string[] = [];
  if (b.location) locBits.push(b.location.toUpperCase());
  if (Number.isFinite(b.areaAcres) && b.areaAcres > 0) locBits.push(`${b.areaAcres.toFixed(1)} ACRE PARCEL`);
  const pcsCount = design.equipment.filter(e => e.kind === 'inverter').length;
  const bessCount = design.equipment.filter(e => e.kind === 'bess').length;
  const equipment = [
    `${INVERTER_BRANDS[cfg.inverterModel]} — ${pcsCount} UNITS`,
    `LG ENERGY SOLUTION JF2 DC-LINK ${cfg.containerMWh} MWH — ${bessCount} CONTAINERS`,
  ];
  if (cfg.hasAuxEquipment) equipment.push('DEDICATED AUXILIARY TRANSFORMER + SWITCHGEAR');
  return {
    eyebrow: 'BATTERY ENERGY STORAGE SYSTEM',
    title,
    subtitle: subtitleOverride ? subtitleOverride.toUpperCase() : locBits.join('  ·  '),
    mw: design.achievedMW,
    mwh: design.achievedMWh,
    hours: cfg.durationHrs,
    equipment,
  };
}

// The island a feeder serves (its PCS chain lives on one island side), or
// null on non-island layouts. Used by the stat-card overlay copy.
export function flyalongIsland(design: SiteDesign, feeder: FeederCircuit): IslandInfo | null {
  const first = feeder.inverterIds[0];
  if (!first || !design.islands) return null;
  return design.islands.find(i => i.southIds.includes(first) || i.northIds.includes(first)) ?? null;
}

export interface FutureGhostBox {
  x: number; y: number;
  length: number; width: number; height: number;
  rotation: number;
}
export interface TourOptions {
  /** Playback pacing: 'short' ~30 s social clip, 'extended' full walkdown. */
  preset?: 'short' | 'standard' | 'extended';
  orbit?: boolean;        // establishing high orbit (default on)
  gateDive?: boolean;     // dive from altitude to the gate (default on)
  driveThrough?: boolean; // low glide through the yard (OPT-IN: default off)
  // Post-gate equipment close-up: front-of-PCS arc past the BESS containers,
  // then a top-down hold where the live DC reroute beat plays (default on;
  // requires the gate + drive-through to be present).
  equipmentCloseup?: boolean;
  // Which PCS block the equipment close-up circles: equipment id of an
  // inverter. Undefined (default) = the PCS nearest the gate. When the chosen
  // PCS can't host a collision-free arc (or no longer exists), the builder
  // falls back to the nearest-to-gate pick.
  closeupTarget?: string;
  // Cinematic title intro over the opening orbit: project name (from the
  // KMZ), site location, power/energy rating and the equipment
  // configuration with manufacturers (default on; overlay-only).
  intro?: boolean;
  // Drafter-typed intro text overrides: replace the KMZ-derived title and/or
  // subtitle on the title card. Blank/whitespace = KMZ default. Persist with
  // the rest of the tour options (overlay-only, never touch exports).
  introTitle?: string;
  introSubtitle?: string;
  // Feeder fly-along: follow an MV feeder from the substation to its island
  // with the island stat card overlay (default on; plays only when a routed
  // feeder polyline is supplied via TourExtras — no feeders = silent no-op).
  feederFlyalong?: boolean;
  pullUp?: boolean;       // rise to the overview bookend (default on)
  // Fly the camera path with the realistic manufacturer GLB models visible
  // (PCS, BESS containers, ...) instead of box placeholders. OPT-IN: default
  // off — realistic mode is heavy (GLB downloads + far more draw calls), so
  // drafters choose it deliberately. Presentation-only: the drafter's own
  // scene toggle is restored when the tour ends or is cancelled.
  realisticFlight?: boolean;
  // Post-flyover showcase stops (TourShowcase). Same semantics as the camera
  // stops: undefined/true = play, false = skip. All five off skips the whole
  // showcase and the tour ends right after the camera path.
  showcaseCad?: boolean;       // CAD dims/legend zoom (default on)
  showcaseRealistic?: boolean; // realistic-models reveal (default on)
  showcasePlot?: boolean;      // exported design plot sheet (default on)
  showcaseGrounding?: boolean; // grounding plan plot sheet (default on)
  showcaseBom?: boolean;       // B018 bill-of-materials sheet (default on)
  showcaseSld?: boolean;       // IEC single-line diagram sheet (default on)
}

// The five showcase stops in play order, shared by the options UI and the
// showcase player so the two can never disagree on what exists.
export const SHOWCASE_STOP_KEYS = [
  'showcaseCad', 'showcaseRealistic', 'showcasePlot', 'showcaseGrounding', 'showcaseBom', 'showcaseSld',
] as const;
export type ShowcaseStopKey = typeof SHOWCASE_STOP_KEYS[number];

// A stop plays unless it is explicitly toggled off (matches the camera-stop
// convention where undefined means "on").
export const showcaseStopEnabled = (opts: TourOptions, key: ShowcaseStopKey): boolean =>
  opts[key] !== false;

// Realistic models during the camera flight are opt-in (like the
// drive-through): only an explicit true enables them.
export const flightRealisticEnabled = (opts: TourOptions): boolean =>
  opts.realisticFlight === true;
const DRONE_H = 13;          // drive-through camera height
const GATE_H = 12;           // height passing through the gate
const EQUIP_CLEARANCE = 9;   // min horizontal distance from equipment at drone height
const FENCE_CLEARANCE = 12;  // min corridor distance from the fence line (spline corner-cut margin)
const GRID_CELL = 5;         // pathfinding grid resolution
const ORBIT_SWEEP = Math.PI * 1.5; // 270°
const ORBIT_FRAMES = 28;
const DRIVE_SPEED = 18;      // ft/s during the drive-through (slow, cinematic)
const CRAWL_SPEED = 8;       // ft/s crawling past PCS / BESS containers
const CRAWL_NEAR = 30;       // full crawl within this distance of equipment
const CRAWL_FAR = 130;       // back to full drive speed beyond this distance
const LOOKAHEAD_FT = 90;     // how far ahead the drive target leads
const GAZE_VIEW_R = 220;     // equipment within this range pulls the gaze
const GAZE_BIAS = 0.45;      // how strongly the gaze swings toward equipment
const GAZE_TARGET_H = 10;    // look-at height while eyeing containers
const MAX_GAZE_OFF = Math.PI / 4; // gaze never swings more than 45° off the path

interface Rect { x: number; y: number; hl: number; hw: number; cos: number; sin: number; }

function equipmentRects(design: SiteDesign, inflate: number): Rect[] {
  return design.equipment.map(e => ({
    x: e.x, y: e.y,
    hl: e.length / 2 + inflate,
    hw: e.width / 2 + inflate,
    cos: Math.cos(e.rotation), sin: Math.sin(e.rotation),
  }));
}

function inRect(px: number, py: number, r: Rect): boolean {
  const dx = px - r.x, dy = py - r.y;
  const lx = dx * r.cos + dy * r.sin;
  const ly = -dx * r.sin + dy * r.cos;
  return Math.abs(lx) <= r.hl && Math.abs(ly) <= r.hw;
}

// Horizontal distance from a point to a rect's edge (0 inside).
function rectDistance(px: number, py: number, r: Rect): number {
  const dx = px - r.x, dy = py - r.y;
  const lx = dx * r.cos + dy * r.sin;
  const ly = -dx * r.sin + dy * r.cos;
  const ex = Math.max(Math.abs(lx) - r.hl, 0);
  const ey = Math.max(Math.abs(ly) - r.hw, 0);
  return Math.hypot(ex, ey);
}

// Local drive-through speed at a plan point: full DRIVE_SPEED in the open,
// easing down to CRAWL_SPEED while gliding past PCS/BESS equipment so the
// containers get a long, readable beauty pass. Pure pacing — the corridor
// geometry is untouched.
export function driveSpeedAt(px: number, py: number, rects: Rect[]): number {
  let d = Infinity;
  for (const r of rects) {
    const rd = rectDistance(px, py, r);
    if (rd < d) d = rd;
  }
  const k = Math.min(1, Math.max(0, (d - CRAWL_NEAR) / (CRAWL_FAR - CRAWL_NEAR)));
  return CRAWL_SPEED + (DRIVE_SPEED - CRAWL_SPEED) * smooth(k);
}

function centroid(poly: { x: number; y: number }[]): { x: number; y: number } {
  let sx = 0, sy = 0;
  for (const p of poly) { sx += p.x; sy += p.y; }
  return { x: sx / Math.max(1, poly.length), y: sy / Math.max(1, poly.length) };
}

// Inward unit normal at the gate (same convention as walkthrough gateSpawn).
function gateInward(design: SiteDesign): { ix: number; iy: number } | null {
  const gate = design.gate;
  if (!gate) return null;
  // Probe a short step along each candidate normal and pick the one that
  // lands inside the fence — robust on concave fences, where the centroid
  // heuristic points the wrong way when the gate sits on a notch wall.
  const nx = -Math.sin(gate.rotation);
  const ny = Math.cos(gate.rotation);
  let s = pointInPolygon({ x: gate.x + nx * 2, y: gate.y + ny * 2 }, design.fence) ? 1 : -1;
  if (s === -1 && !pointInPolygon({ x: gate.x - nx * 2, y: gate.y - ny * 2 }, design.fence)) {
    const c = centroid(design.fence);
    s = (c.x - gate.x) * nx + (c.y - gate.y) * ny >= 0 ? 1 : -1;
  }
  return { ix: nx * s, iy: ny * s };
}

const smooth = (t: number) => t * t * (3 - 2 * t);

// ---------------------------------------------------------------------------
// Drive-through corridor: A* over a coarse grid of walkable cells (inside the
// fence, clear of every equipment footprint), from just inside the gate to
// the walkable cell deepest into the yard along the gate's inward axis. The
// grid guarantees the smoothed flight path never clips a container.
// ---------------------------------------------------------------------------
function findDriveCorridor(design: SiteDesign, gx: number, gy: number, ix: number, iy: number): { x: number; y: number }[] | null {
  const fence = design.fence;
  if (fence.length < 3) return null;
  const rects = equipmentRects(design, EQUIP_CLEARANCE);
  const xs = fence.map(p => p.x), ys = fence.map(p => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const cols = Math.max(2, Math.ceil((maxX - minX) / GRID_CELL));
  const rows = Math.max(2, Math.ceil((maxY - minY) / GRID_CELL));
  if (cols * rows > 1_200_000) return null; // absurd parcel: bail to fallback

  const cellX = (cx: number) => minX + (cx + 0.5) * GRID_CELL;
  const cellY = (cy: number) => minY + (cy + 0.5) * GRID_CELL;
  const walkableCache = new Int8Array(cols * rows); // 0 unknown, 1 yes, -1 no
  const walkable = (cx: number, cy: number): boolean => {
    if (cx < 0 || cy < 0 || cx >= cols || cy >= rows) return false;
    const idx = cy * cols + cx;
    const cached = walkableCache[idx];
    if (cached !== 0) return cached === 1;
    const px = cellX(cx), py = cellY(cy);
    // Keep a fence buffer too: the smoothing spline cuts corners between
    // thinned waypoints, so a corridor hugging the fence line can bow the
    // camera slightly outside it.
    let ok = pointInPolygon({ x: px, y: py }, fence)
      && distanceToPolygonEdge({ x: px, y: py }, fence) >= FENCE_CLEARANCE;
    if (ok) for (const r of rects) { if (inRect(px, py, r)) { ok = false; break; } }
    walkableCache[idx] = ok ? 1 : -1;
    return ok;
  };
  const toCell = (px: number, py: number) => ({
    cx: Math.min(cols - 1, Math.max(0, Math.round((px - minX) / GRID_CELL - 0.5))),
    cy: Math.min(rows - 1, Math.max(0, Math.round((py - minY) / GRID_CELL - 0.5))),
  });

  // Start: just inside the gate; nudge further inward until walkable.
  let start: { cx: number; cy: number } | null = null;
  for (let d = 15; d <= 90; d += 5) {
    const c = toCell(gx + ix * d, gy + iy * d);
    if (walkable(c.cx, c.cy)) { start = c; break; }
  }
  if (!start) return null;

  // Goal: BFS the reachable set from start, keep the cell with the deepest
  // projection along the inward axis (ties: farthest from the gate). BFS also
  // gives parents for the corridor; a separate A* is unnecessary at this
  // scale and the BFS-shortest path naturally follows open corridors.
  const parent = new Int32Array(cols * rows).fill(-2); // -2 unvisited, -1 root
  const queue = new Int32Array(cols * rows);
  let qh = 0, qt = 0;
  const sIdx = start.cy * cols + start.cx;
  parent[sIdx] = -1;
  queue[qt++] = sIdx;
  let best = sIdx, bestScore = -Infinity;
  // 4-connected: paths stay axis-aligned like the roads; smoothing rounds
  // the corners later. (Diagonal moves could squeeze between rect corners.)
  const nbr = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  while (qh < qt) {
    const cur = queue[qh++];
    const ccx = cur % cols, ccy = (cur / cols) | 0;
    const px = cellX(ccx), py = cellY(ccy);
    const depth = (px - gx) * ix + (py - gy) * iy;
    const score = depth * 2 + Math.hypot(px - gx, py - gy);
    if (score > bestScore) { bestScore = score; best = cur; }
    for (const [dx, dy] of nbr) {
      const nx = ccx + dx, ny = ccy + dy;
      if (!walkable(nx, ny)) continue;
      const nIdx = ny * cols + nx;
      if (parent[nIdx] !== -2) continue;
      parent[nIdx] = cur;
      queue[qt++] = nIdx;
    }
  }
  if (best === sIdx) return null; // gate opens into a dead pocket

  // Reconstruct, then thin: keep direction changes plus every ~30 ft so the
  // Catmull-Rom spline hugs the corridor instead of cutting corners.
  const cells: { x: number; y: number }[] = [];
  for (let cur = best; cur !== -1; cur = parent[cur]) {
    cells.push({ x: cellX(cur % cols), y: cellY((cur / cols) | 0) });
    if (cells.length > cols * rows) return null; // defensive
  }
  cells.reverse();
  const pts: { x: number; y: number }[] = [cells[0]];
  let acc = 0;
  for (let i = 1; i < cells.length - 1; i++) {
    const a = cells[i - 1], b = cells[i], c = cells[i + 1];
    const turn = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    acc += Math.hypot(b.x - a.x, b.y - a.y);
    if (Math.abs(turn) > 1e-6 || acc >= 30) { pts.push(b); acc = 0; }
  }
  pts.push(cells[cells.length - 1]);
  return pts;
}

// ---------------------------------------------------------------------------
// Keyframe assembly
// ---------------------------------------------------------------------------
export function buildTourKeyframes(design: SiteDesign, options: TourOptions = {}, extras: TourExtras = {}): TourKeyframes | null {
  const fence = design.fence;
  if (!fence || fence.length < 3) return null;
  const wantOrbit = options.orbit !== false;
  const wantDive = options.gateDive !== false;
  // Drive-through is OPT-IN: the long road drive after the PCS/BESS
  // close-up read as a jittery restart on real yards, so the default tour
  // fades from the close-up straight into the next phase instead. The
  // checkbox still enables it for drafters who want the full corridor run.
  const wantDrive = options.driveThrough === true;
  const wantCloseup = options.equipmentCloseup !== false;
  const wantPull = options.pullUp !== false;
  const scale = TOUR_PRESET_SCALE[options.preset ?? 'standard'] ?? 1;
  const xs = fence.map(p => p.x), ys = fence.map(p => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const spanX = maxX - minX, spanY = maxY - minY;
  const span = Math.max(spanX, spanY, 200);
  const diag = Math.hypot(spanX, spanY);

  const gate = design.gate;
  const inward = gateInward(design);

  const frames: TourFrame[] = [];
  const pace: { idx: number; share: number }[] = [];
  let pullStartIdx = -1;
  let closeupHoldStartIdx = -1;
  let closeupEndIdx = -1;
  let flyalongHoldStartIdx = -1;
  let flyalongEndIdx = -1;

  // --- 1. Establishing orbit ------------------------------------------------
  const R = diag / 2 * 1.35 + 80;               // comfortably outside the fence
  const H0 = Math.max(span * 0.85, 300);        // opening altitude
  const H1 = Math.max(span * 0.42, 160);        // altitude when the orbit ends
  // End the orbit on the gate's side of the yard so the dive is a natural
  // continuation; without a gate, end where it started facing north.
  const endA = gate ? Math.atan2(gate.y - cy, gate.x - cx) : Math.PI / 2;
  const startA = endA - ORBIT_SWEEP;
  if (wantOrbit) {
    for (let i = 0; i < ORBIT_FRAMES; i++) {
      const k = i / (ORBIT_FRAMES - 1);
      const a = startA + ORBIT_SWEEP * k;
      frames.push({
        x: cx + Math.cos(a) * R,
        y: cy + Math.sin(a) * R,
        h: H0 + (H1 - H0) * smooth(k),
        tx: cx, ty: cy, th: 0,
      });
    }
    pace.push({ idx: frames.length - 1, share: 0.30 });
  }
  const orbitEnd = frames.length - 1;

  let gateIdx = -1;
  let driveEnd = orbitEnd;
  let driveTime = 0; // seconds at authored (crawl-aware) speed
  let divePresent = false, drivePresent = false;

  if (gate && inward && (wantDive || wantDrive || wantCloseup)) {
    const { ix, iy } = inward;
    const ox = -ix, oy = -iy; // outward

    // --- 2. The dive --------------------------------------------------------
    if (wantDive) {
      const dive: [number, number, number][] = [
        [gate.x + ox * 260, gate.y + oy * 260, Math.max(70, span * 0.12)],
        [gate.x + ox * 110, gate.y + oy * 110, 30],
        [gate.x + ox * 35, gate.y + oy * 35, GATE_H + 3],
      ];
      for (const [px, py, h] of dive) {
        frames.push({ x: px, y: py, h, tx: gate.x, ty: gate.y, th: 6 });
      }
      divePresent = true;
    }
    // Through the opening. (With the dive skipped this is still the entry
    // point for the drive-through, so the path always crosses at the gate.)
    frames.push({
      x: gate.x, y: gate.y, h: GATE_H,
      tx: gate.x + ix * LOOKAHEAD_FT, ty: gate.y + iy * LOOKAHEAD_FT, th: 8,
    });
    gateIdx = frames.length - 1;
    if (divePresent) pace.push({ idx: gateIdx, share: 0.14 });
    driveEnd = gateIdx;

    // --- 2b. Equipment close-up (post-gate first pass) ----------------------
    // Auto-position in front of the PCS nearest the gate, arc slowly past the
    // adjacent BESS containers at eye/drone height, then climb to a top-down
    // hold over the same block — the playback layer runs the live DC reroute
    // beat inside that hold window. Pure path geometry; skipped when no PCS
    // exists or no collision-free arc radius fits the yard.
    if (wantCloseup) {
      const pcsList = design.equipment.filter(e => e.kind === 'inverter');
      let nearest: typeof pcsList[number] | null = null;
      let bestD = Infinity;
      for (const e of pcsList) {
        const d = Math.hypot(e.x - gate.x, e.y - gate.y);
        if (d < bestD) { bestD = d; nearest = e; }
      }
      // Drafter override: try the chosen PCS first, then fall back to the
      // nearest-to-gate pick when it doesn't exist or can't host an arc.
      const chosen = options.closeupTarget
        ? pcsList.find(e => e.id === options.closeupTarget) ?? null : null;
      const candidates = chosen && nearest && chosen.id !== nearest.id
        ? [chosen, nearest]
        : chosen ? [chosen] : nearest ? [nearest] : [];
      // The arc flies at 24 ft — above every container/PCS roof — so only
      // the fence bounds the sweep (BESS rects surround every PCS; a
      // ground-level rect check would reject every yard).
      const ARC_H = 24;
      const okAt = (px: number, py: number) =>
        pointInPolygon({ x: px, y: py }, fence)
        && distanceToPolygonEdge({ x: px, y: py }, fence) >= FENCE_CLEARANCE * 0.6;
      // Arc start faces the gate (the "front" the drafter arrives from);
      // sweep 150° around the block. Fall back to tighter radii on cramped
      // yards; skip the segment entirely if none fits.
      const ARC_N = 4;
      const fitArc = (p: { x: number; y: number }): { x: number; y: number }[] | null => {
        const aG = Math.atan2(gate.y - p.y, gate.x - p.x);
        for (const rad of [60, 45, 34]) {
          const pts: { x: number; y: number }[] = [];
          for (let i = 0; i < ARC_N; i++) {
            const a = aG + (Math.PI * 5 / 6) * (i / (ARC_N - 1));
            pts.push({ x: p.x + Math.cos(a) * rad, y: p.y + Math.sin(a) * rad });
          }
          const appr = { x: p.x + Math.cos(aG) * (rad + 35), y: p.y + Math.sin(aG) * (rad + 35) };
          if (okAt(appr.x, appr.y) && pts.every(q => okAt(q.x, q.y))) return [appr, ...pts];
        }
        return null;
      };
      let pcs: typeof pcsList[number] | null = null;
      let arc: { x: number; y: number }[] | null = null;
      for (const cand of candidates) {
        const a = fitArc(cand);
        if (a) { pcs = cand; arc = a; break; }
      }
      if (pcs && arc) {
        const a0 = Math.atan2(gate.y - pcs.y, gate.x - pcs.x);
        {
          // Approach + slow arc, gaze on the PCS/BESS block.
          frames.push({ x: arc[0].x, y: arc[0].y, h: ARC_H + 6, tx: pcs.x, ty: pcs.y, th: 9 });
          for (let i = 1; i < arc.length; i++) {
            frames.push({ x: arc[i].x, y: arc[i].y, h: ARC_H, tx: pcs.x, ty: pcs.y, th: 9 });
          }
          pace.push({ idx: frames.length - 1, share: 0.10 });
          // Vertical climb to a top-down vantage (small horizontal offset so
          // the look-at never degenerates against the camera up vector).
          const holdH = Math.min(320, Math.max(140, span * 0.35));
          const off = holdH * 0.2;
          const aTop = a0 + Math.PI * 5 / 6;
          const hx = pcs.x + Math.cos(aTop) * off, hy = pcs.y + Math.sin(aTop) * off;
          closeupHoldStartIdx = frames.length;
          frames.push({ x: hx, y: hy, h: holdH, tx: pcs.x, ty: pcs.y, th: 0 });
          pace.push({ idx: frames.length - 1, share: 0.04 });
          // Slow top-down drift hold (distinct points keep the Catmull-Rom
          // chords non-degenerate) — the DC reroute beat plays here.
          for (let i = 1; i <= 3; i++) {
            const a = aTop + 0.5 * i;
            frames.push({
              x: hx + Math.cos(a) * 12, y: hy + Math.sin(a) * 12, h: holdH,
              tx: pcs.x, ty: pcs.y, th: 0,
            });
          }
          closeupEndIdx = frames.length - 1;
          pace.push({ idx: closeupEndIdx, share: 0.10 });
        }
      }
    }

    // --- 3. Drive-through ----------------------------------------------------
    if (wantDrive) {
    const corridor = findDriveCorridor(design, gate.x, gate.y, ix, iy)
      // Fallback (no reachable corridor): a short straight poke inward — the
      // grid start search already proved at least the gate mouth is clear.
      ?? [{ x: gate.x + ix * 30, y: gate.y + iy * 30 }];
    // Forward lookahead point per corridor waypoint; when the remaining
    // corridor is shorter than the lookahead, extend past the end along the
    // last segment (or the inward axis) so the gaze never collapses onto the
    // camera position at the corridor tail.
    const ahead: { x: number; y: number }[] = corridor.map((_, i) => {
      let rem = LOOKAHEAD_FT;
      for (let j = i; j < corridor.length - 1; j++) {
        const a = corridor[j], b = corridor[j + 1];
        const seg = Math.hypot(b.x - a.x, b.y - a.y);
        if (seg >= rem) {
          const f = rem / Math.max(seg, 1e-6);
          return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
        }
        rem -= seg;
      }
      const last = corridor[corridor.length - 1];
      const prev = corridor.length >= 2 ? corridor[corridor.length - 2] : null;
      let dx = ix, dy = iy;
      if (prev) {
        const len = Math.hypot(last.x - prev.x, last.y - prev.y);
        if (len > 1e-6) { dx = (last.x - prev.x) / len; dy = (last.y - prev.y) / len; }
      }
      return { x: last.x + dx * rem, y: last.y + dy * rem };
    });
    // Angled fly-by: swing each gaze toward the nearest equipment island so
    // the drive-through keeps a three-quarter view of the containers instead
    // of a straight down-the-road shot. The bias is a SIGNED ANGLE off the
    // (inherently smooth) lookahead direction — never an absolute target —
    // so corridor corners can't fold the gaze behind the direction of
    // travel, and smoothing the scalar bias can't cut across the corner.
    const eq = design.equipment;
    const bias = corridor.map((p, i) => {
      let best: { x: number; y: number } | null = null;
      let bestD = GAZE_VIEW_R;
      for (const e of eq) {
        const d = Math.hypot(e.x - p.x, e.y - p.y);
        if (d < bestD) { bestD = d; best = { x: e.x, y: e.y }; }
      }
      if (!best) return 0;
      const fwd = Math.atan2(ahead[i].y - p.y, ahead[i].x - p.x);
      const toEq = Math.atan2(best.y - p.y, best.x - p.x);
      let off = toEq - fwd;
      while (off > Math.PI) off -= 2 * Math.PI;
      while (off < -Math.PI) off += 2 * Math.PI;
      // Closer equipment pulls harder, but the gaze keeps a strong forward
      // component so the camera still reads as flying ahead.
      const w = Math.min(1, GAZE_BIAS + 0.35 * (1 - bestD / GAZE_VIEW_R));
      return Math.sign(off) * Math.min(Math.abs(off) * w, MAX_GAZE_OFF);
    });
    const gazeA: number[] = [];
    const gazeBias: number[] = [];
    for (let i = 0; i < corridor.length; i++) {
      // Moving-average the scalar bias so the pan glides when the nearest
      // island flips sides, then rotate the lookahead gaze by it.
      let sb = 0, n = 0;
      for (let j = Math.max(0, i - 3); j <= Math.min(corridor.length - 1, i + 3); j++) {
        sb += bias[j]; n++;
      }
      const p = corridor[i];
      const fwd = Math.atan2(ahead[i].y - p.y, ahead[i].x - p.x);
      let a = fwd + sb / n;
      // Guard: at sharp corridor corners the lookahead direction can itself
      // sit ~45° off the immediate travel direction; keep the total gaze
      // within ±70° of the hop to the next waypoint so the camera never
      // reads as looking sideways-to-backwards mid-turn.
      const nxt = corridor[Math.min(i + 1, corridor.length - 1)];
      if (nxt !== p) {
        const travel = Math.atan2(nxt.y - p.y, nxt.x - p.x);
        let off = a - travel;
        while (off > Math.PI) off -= 2 * Math.PI;
        while (off < -Math.PI) off += 2 * Math.PI;
        const lim = Math.PI * 70 / 180;
        if (Math.abs(off) > lim) a = travel + Math.sign(off) * lim;
      }
      gazeA.push(a);
      gazeBias.push(sb / n);
    }
    // Unwrap + one light smoothing pass over the final gaze angles: corners
    // where the clamp engaged would otherwise pan noticeably faster than the
    // straightaways.
    for (let i = 1; i < gazeA.length; i++) {
      while (gazeA[i] - gazeA[i - 1] > Math.PI) gazeA[i] -= 2 * Math.PI;
      while (gazeA[i] - gazeA[i - 1] < -Math.PI) gazeA[i] += 2 * Math.PI;
    }
    // Crawl-aware pacing: each corridor hop gets its own pace knot whose
    // share is proportional to the time spent at the LOCAL speed (slow past
    // PCS/BESS containers, full drive speed in the open). The drive phase
    // keeps its overall 0.42 time share, so the other phase windows are
    // untouched — the crawl only redistributes time WITHIN the drive.
    const paceRects = equipmentRects(design, 0);
    const segTimes: number[] = [];
    for (let i = 0; i < corridor.length; i++) {
      const lo = Math.max(0, i - 1), hi = Math.min(corridor.length - 1, i + 1);
      let sa = 0;
      for (let j = lo; j <= hi; j++) sa += gazeA[j];
      let a = sa / (hi - lo + 1);
      const p = corridor[i];
      // Final guard AFTER smoothing: the moving average can undo the per-
      // waypoint clamp at sharp corridor corners (concave-notch gates), so
      // re-clamp the smoothed gaze to ±80° of the immediate travel direction.
      {
        const nxt = corridor[Math.min(i + 1, corridor.length - 1)];
        const prv = corridor[Math.max(i - 1, 0)];
        const rx = nxt !== p ? nxt.x - p.x : p.x - prv.x;
        const ry = nxt !== p ? nxt.y - p.y : p.y - prv.y;
        if (Math.abs(rx) + Math.abs(ry) > 1e-9) {
          const travel = Math.atan2(ry, rx);
          let off = a - travel;
          while (off > Math.PI) off -= 2 * Math.PI;
          while (off < -Math.PI) off += 2 * Math.PI;
          const lim = Math.PI * 80 / 180;
          if (Math.abs(off) > lim) a = travel + Math.sign(off) * lim;
        }
      }
      frames.push({
        x: p.x, y: p.y, h: DRONE_H,
        tx: p.x + Math.cos(a) * LOOKAHEAD_FT,
        ty: p.y + Math.sin(a) * LOOKAHEAD_FT,
        th: Math.abs(gazeBias[i]) > 0.05 ? GAZE_TARGET_H : 8,
      });
      if (i > 0) {
        const q = corridor[i - 1];
        const seg = Math.hypot(p.x - q.x, p.y - q.y);
        const v = (driveSpeedAt(p.x, p.y, paceRects) + driveSpeedAt(q.x, q.y, paceRects)) / 2;
        segTimes.push(seg / Math.max(v, 1e-6));
      }
    }
    driveTime = segTimes.reduce((s, v) => s + v, 0);
    // Include the gate → first-corridor hop in the first knot; per-hop knots
    // start at each corridor frame after the gate frame.
    const firstDriveFrame = frames.length - corridor.length;
    for (let i = 0; i < segTimes.length; i++) {
      pace.push({ idx: firstDriveFrame + i + 1, share: 0.42 * segTimes[i] / Math.max(driveTime, 1e-6) });
    }
    if (!segTimes.length) pace.push({ idx: frames.length - 1, share: 0.42 });
    driveEnd = frames.length - 1;
    drivePresent = true;
    }
  }

  // --- 3b. Feeder fly-along ---------------------------------------------------
  // Follow the routed MV feeder polyline from the substation out to the
  // island it serves, at low drone height with a forward gaze, then hold
  // over the island end — the stat-card overlay plays inside that hold
  // window. Route comes in via extras (presentation-only; the builder never
  // routes anything itself). Altitude keeps the camera above every
  // container/PCS roof, so the route needs no collision checks.
  const flyRoute = options.feederFlyalong !== false ? extras.feederRoute ?? null : null;
  if (flyRoute && flyRoute.length >= 2) {
    const FLY_H = 30;
    // Resample the polyline at a steady step so the spline flies the trench
    // line instead of cutting corners between sparse waypoints.
    const cumLen: number[] = [0];
    for (let i = 1; i < flyRoute.length; i++) {
      cumLen.push(cumLen[i - 1] + Math.hypot(flyRoute[i].x - flyRoute[i - 1].x, flyRoute[i].y - flyRoute[i - 1].y));
    }
    const totalLen = cumLen[cumLen.length - 1];
    const at = (d: number): { x: number; y: number } => {
      const dd = Math.min(totalLen, Math.max(0, d));
      let i = 1;
      while (i < cumLen.length - 1 && cumLen[i] < dd) i++;
      const seg = Math.max(cumLen[i] - cumLen[i - 1], 1e-6);
      const f = (dd - cumLen[i - 1]) / seg;
      return {
        x: flyRoute[i - 1].x + (flyRoute[i].x - flyRoute[i - 1].x) * f,
        y: flyRoute[i - 1].y + (flyRoute[i].y - flyRoute[i - 1].y) * f,
      };
    };
    // Lookahead sampler that extends past the route end along the last leg,
    // so the gaze never snaps when the lookahead window slides off the end.
    const atExt = (d: number): { x: number; y: number } => {
      if (d <= totalLen) return at(d);
      const a = at(Math.max(0, totalLen - 5)), b = at(totalLen);
      const l = Math.max(Math.hypot(b.x - a.x, b.y - a.y), 1e-6);
      const r = d - totalLen;
      return { x: b.x + ((b.x - a.x) / l) * r, y: b.y + ((b.y - a.y) / l) * r };
    };
    // Blurred forward gaze: average several lookahead distances around the
    // nominal 130 ft so a hard route corner (e.g. the trunk turning toward
    // the PCS row) rounds into a slow banking turn instead of the target
    // spline pivoting through the corner vertex in one knot (a visible
    // hitch on camera).
    const look = (d: number): { x: number; y: number } => {
      let lx = 0, ly = 0;
      for (const off of FLY_LOOKAHEAD_OFFSETS) {
        const q = atExt(d + off);
        lx += q.x; ly += q.y;
      }
      const n = FLY_LOOKAHEAD_OFFSETS.length;
      return { x: lx / n, y: ly / n };
    };
    // Dense resampling keeps the spline glued to the trench line and reads
    // as a steady, unhurried tracking shot rather than a corner-cut dash.
    // Knots are dense enough that a corner spans several of them, so the
    // Catmull-Rom target curve turns over multiple knots, never one.
    const step = Math.max(25, totalLen / 32);
    const sub = flyRoute[0];
    const first = at(Math.min(90, totalLen * 0.3));
    // Transit knot: climb from wherever the previous phase ended to a high
    // vantage over the substation, gaze already down the feeder run.
    frames.push({
      x: sub.x, y: sub.y, h: Math.max(150, span * 0.28),
      tx: first.x, ty: first.y, th: 0,
    });
    pace.push({ idx: frames.length - 1, share: 0.06 });
    // The fly-along proper: blurred forward gaze leads ~130 ft along the
    // route so corners read as slow banking turns, never sideways glances.
    for (let d = 0; d <= totalLen; d += step) {
      const p = at(d);
      const lk = look(d);
      frames.push({ x: p.x, y: p.y, h: FLY_H, tx: lk.x, ty: lk.y, th: 9 });
    }
    pace.push({ idx: frames.length - 1, share: 0.23 });
    // Arrival hold: rise to a three-quarter vantage over the island end and
    // drift slowly — the stat card fades in over this window.
    const end = at(totalLen);
    const back = at(Math.max(0, totalLen - 60));
    const aIn = Math.atan2(end.y - back.y, end.x - back.x);
    const holdH = Math.min(280, Math.max(120, span * 0.26));
    const hr = holdH * 0.75;
    flyalongHoldStartIdx = frames.length;
    frames.push({
      x: end.x - Math.cos(aIn) * hr, y: end.y - Math.sin(aIn) * hr, h: holdH,
      tx: end.x, ty: end.y, th: 4,
    });
    pace.push({ idx: frames.length - 1, share: 0.05 });
    for (let i = 1; i <= 3; i++) {
      const a = aIn + Math.PI + 0.22 * i;
      frames.push({
        x: end.x + Math.cos(a) * hr, y: end.y + Math.sin(a) * hr, h: holdH,
        tx: end.x, ty: end.y, th: 4,
      });
    }
    flyalongEndIdx = frames.length - 1;
    pace.push({ idx: flyalongEndIdx, share: 0.14 });
  }

  // --- 4. Pull-up bookend ---------------------------------------------------
  // (Needs a phase to pull up FROM: with every other stop off there is no
  // playable tour, and the < 4 frame check below returns null.)
  if (wantPull && frames.length > 0) {
  // Same fit math as the Overview preset (fov 45; a mid-range aspect — the
  // exact viewport aspect only changes the final backoff slightly).
  const vHalf = (45 * Math.PI / 180) / 2;
  const hHalf = Math.atan(Math.tan(vHalf) * 1.7);
  const dist = Math.max(
    (spanY / 2) * 1.15 / Math.tan(vHalf),
    (spanX / 2) * 1.15 / Math.tan(hHalf),
    200,
  );
  const dir = new THREE.Vector3(0, 1, 0.9).normalize().multiplyScalar(dist);
  const last = frames[frames.length - 1];
  pullStartIdx = frames.length;
  // Two easing frames lift the camera out of the yard before the final pose.
  // The first rises (near-)vertically above the drive end: any horizontal
  // drift while still low would let the spline bow the camera outside the
  // fence between the last drive frame and this one.
  frames.push({
    x: last.x * 0.9 + cx * 0.1,
    y: last.y * 0.9 + cy * 0.1,
    h: Math.max(span * 0.25, 120),
    tx: cx, ty: cy, th: 0,
  });
  frames.push({
    x: cx + dir.x,
    y: cy - dir.z, // scene z = -plan y
    h: dir.y,
    tx: cx, ty: cy, th: 0,
  });
  pace.push({ idx: frames.length - 1, share: 0.14 });
  }

  // A Catmull-Rom path needs at least 4 keyframes; fewer means the chosen
  // options left no playable tour (e.g. every stop toggled off).
  if (frames.length < 4) return null;

  // --- Duration --------------------------------------------------------------
  // Sum only the phases that are actually present, then apply the preset
  // pacing scale. With default options this reproduces the original 40-60 s
  // authored window (18+8+[10..24]+8 = 44..58 s).
  const orbitT = wantOrbit ? 18 : 0;
  const diveT = divePresent ? 8 : 0;
  // Equipment close-up + top-down reroute hold (~14 s when present).
  const closeupT = closeupEndIdx >= 0 ? 14 : 0;
  // Crawl-aware drive time (slower past equipment), with a slightly higher
  // cap than the constant-speed original so the crawl isn't squeezed out.
  const driveT = drivePresent ? Math.min(40, Math.max(14, driveTime)) : 0;
  // Feeder fly-along transit + run + island stat-card hold (~26 s present —
  // a slow, deliberate glide with a long dwell on the PCS/BESS island).
  // A generous time budget keeps the trench glide slow and deliberate —
  // cinematic tracking-shot pacing rather than a fly-by.
  const flyT = flyalongEndIdx >= 0 ? 40 : 0;
  const pullT = wantPull ? 8 : 0;
  const duration = Math.min(120, Math.max(8, scale * (orbitT + diveT + closeupT + driveT + flyT + pullT)));

  return { frames, phases: { orbitEnd, gateIdx, driveEnd }, duration, pace, pullStartIdx, closeupHoldStartIdx, closeupEndIdx, flyalongHoldStartIdx, flyalongEndIdx };
}

// ---------------------------------------------------------------------------
// Time-parameterized sampler: converts keyframes to scene-space Catmull-Rom
// curves plus a smooth distance-over-time profile (ease-in at the start,
// ease-out at the end, C1-blended speeds at the phase boundaries so there are
// no visible seams). Shared by the live playback component and the tests so
// the verified geometry IS the rendered geometry.
// ---------------------------------------------------------------------------
export interface TourSampler {
  duration: number;
  keyframes: TourKeyframes;
  /** t in [0,1] (normalized time) -> scene-space camera pose */
  sample(t: number): { pos: THREE.Vector3; target: THREE.Vector3 };
  /** Normalized time where the pull-up bookend begins (null: no pull-up). */
  pullStartT: number | null;
  /** Top-down close-up hold window (live DC reroute beat) — null when the
   * close-up segment is absent. */
  closeup: { holdStartT: number; holdEndT: number } | null;
  /** Island arrival hold window of the feeder fly-along (the stat-card
   * overlay window) — null when the fly-along segment is absent. */
  flyalong: { holdStartT: number; holdEndT: number } | null;
}

// White fade window around the close-up hold end (normalized tour time):
// the fade ramps up over the last CLOSEUP_FADE_LEAD of the hold, peaks
// exactly at closeup.holdEndT, and ramps back out over CLOSEUP_FADE_TAIL
// after it. Exported so the ordering tests can assert the fade tail (and
// with it the caption/fade beat) fully clears before the fly-along
// stat-card hold begins — the pair must never stack in a recorded video.
export const CLOSEUP_FADE_LEAD = 0.015;
export const CLOSEUP_FADE_TAIL = 0.030;

const toScenePos = (f: TourFrame) => new THREE.Vector3(f.x, f.h, -f.y);
const toSceneTgt = (f: TourFrame) => new THREE.Vector3(f.tx, f.th, -f.ty);

export function buildTourSampler(design: SiteDesign, options: TourOptions = {}, extras: TourExtras = {}): TourSampler | null {
  const kf = buildTourKeyframes(design, options, extras);
  if (!kf || kf.frames.length < 4) return null;
  const { frames } = kf;
  const posCurve = new THREE.CatmullRomCurve3(frames.map(toScenePos), false, 'centripetal', 0.5);
  const tgtCurve = new THREE.CatmullRomCurve3(frames.map(toSceneTgt), false, 'centripetal', 0.5);

  // Cumulative chord length across keyframes: the sampler maps time ->
  // distance -> frame-index parameter u, so BOTH curves are sampled at the
  // same u and the look target stays synchronized with the position.
  const cum: number[] = [0];
  for (let i = 1; i < frames.length; i++) {
    cum.push(cum[i - 1] + toScenePos(frames[i]).distanceTo(toScenePos(frames[i - 1])));
  }
  const total = Math.max(cum[cum.length - 1], 1e-6);

  // Distance-over-time: cubic Hermite through phase boundaries with slope 0
  // at the ends (ease-in/out) and averaged secant slopes at interior knots
  // (smooth speed transitions between orbit / dive / drive / pull-up).
  // Pacing knots come from the builder, so an omitted phase never steals a
  // time share that belonged to another (orbit 30%, dive 14%, drive 42% (slow, deliberate fly-by),
  // pull-up 14% when all present). The last knot always covers the final
  // frame even when the pull-up is skipped.
  const knots = kf.pace.filter((p, i) => p.idx > 0 && (i === 0 || p.idx > kf.pace[i - 1].idx));
  if (!knots.length || knots[knots.length - 1].idx !== frames.length - 1) {
    knots.push({ idx: frames.length - 1, share: 0.14 });
  }
  const knotIdx = [0, ...knots.map(k => k.idx)];
  const sKnots = knotIdx.map(i => cum[i] / total);
  const shares = knots.map(k => k.share);
  const shareSum = shares.reduce((a, b) => a + b, 0);
  const tKnots = [0];
  for (const sh of shares) tKnots.push(tKnots[tKnots.length - 1] + sh / shareSum);
  tKnots[tKnots.length - 1] = 1;
  const slopes: number[] = sKnots.map((_, i) => {
    if (i === 0 || i === sKnots.length - 1) return 0; // ease in/out
    const a = (sKnots[i] - sKnots[i - 1]) / Math.max(tKnots[i] - tKnots[i - 1], 1e-6);
    const b = (sKnots[i + 1] - sKnots[i]) / Math.max(tKnots[i + 1] - tKnots[i], 1e-6);
    // Fritsch–Carlson monotone limiting: a fast segment (climb) next to a
    // near-stationary one (top-down hold) would otherwise make the averaged
    // slope overshoot s(t) backwards through the slow segment.
    if (a <= 1e-9 || b <= 1e-9) return 0;
    return Math.min((a + b) / 2, 3 * Math.min(a, b));
  });
  const sOfT = (t: number): number => {
    const tc = Math.min(1, Math.max(0, t));
    let i = 0;
    while (i < tKnots.length - 2 && tc > tKnots[i + 1]) i++;
    const h = Math.max(tKnots[i + 1] - tKnots[i], 1e-6);
    const u = (tc - tKnots[i]) / h;
    const u2 = u * u, u3 = u2 * u;
    return (2 * u3 - 3 * u2 + 1) * sKnots[i]
      + (u3 - 2 * u2 + u) * h * slopes[i]
      + (-2 * u3 + 3 * u2) * sKnots[i + 1]
      + (u3 - u2) * h * slopes[i + 1];
  };

  const uOfS = (s: number): number => {
    const d = Math.min(1, Math.max(0, s)) * total;
    let lo = 0, hi = cum.length - 1;
    while (lo < hi - 1) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] <= d) lo = mid; else hi = mid;
    }
    const seg = Math.max(cum[hi] - cum[lo], 1e-6);
    return (lo + (d - cum[lo]) / seg) / (frames.length - 1);
  };

  // Normalized time where the pull-up bookend starts: the knot boundary at
  // the last pre-pull frame. (When the pull-up is on, the builder always
  // authors its own final pace knot, so the boundary before the last knot IS
  // the start of the pull segment.)
  let pullStartT: number | null = null;
  if (kf.pullStartIdx >= 0) {
    const bIdx = knotIdx.lastIndexOf(kf.pullStartIdx - 1);
    pullStartT = bIdx >= 0 ? tKnots[bIdx] : tKnots[tKnots.length - 2];
  }

  // Close-up hold window: the climb knot ends where the top-down hold begins,
  // and the hold's own knot ends where the drive resumes.
  let closeup: TourSampler['closeup'] = null;
  if (kf.closeupHoldStartIdx >= 0 && kf.closeupEndIdx >= 0) {
    const a = knotIdx.lastIndexOf(kf.closeupHoldStartIdx);
    const b = knotIdx.lastIndexOf(kf.closeupEndIdx);
    if (a >= 0 && b > a) closeup = { holdStartT: tKnots[a], holdEndT: tKnots[b] };
  }

  // Fly-along hold window: the transit/fly knots end where the arrival hold
  // begins; the hold's own knot ends where the pull-up (or the end) begins.
  let flyalong: TourSampler['flyalong'] = null;
  if (kf.flyalongHoldStartIdx >= 0 && kf.flyalongEndIdx >= 0) {
    const a = knotIdx.lastIndexOf(kf.flyalongHoldStartIdx);
    const b = knotIdx.lastIndexOf(kf.flyalongEndIdx);
    if (a >= 0 && b > a) flyalong = { holdStartT: tKnots[a], holdEndT: tKnots[b] };
  }

  return {
    duration: kf.duration,
    keyframes: kf,
    pullStartT,
    closeup,
    flyalong,
    sample(t: number) {
      const u = uOfS(sOfT(t));
      return { pos: posCurve.getPoint(u), target: tgtCurve.getPoint(u) };
    },
  };
}

export const TOUR_PRESET_SCALE: Record<NonNullable<TourOptions['preset']>, number> = {
  short: 0.55,
  standard: 1,
  extended: 1.6,
};

export function flyalongFutureGhosts(design: SiteDesign, feeder: FeederCircuit): FutureGhostBox[] {
  const island = flyalongIsland(design, feeder);
  if (!island || !design.futureEquipment?.length) return [];
  const prefix = `future-island-aug-${island.n}-`;
  const pcs = design.futureEquipment.filter(e =>
    e.kind === 'inverter' && e.id.startsWith(prefix) &&
    Number.isFinite(e.x) && Number.isFinite(e.y) &&
    Number.isFinite(e.length) && Number.isFinite(e.width) && Number.isFinite(e.height));
  if (!pcs.length) return [];
  // Keep the ghost PCS on the feeder's own island side (south = below the
  // aux-corridor centerline). If the side filter empties (single-sided edge
  // strips), fall back to every island ghost rather than showing nothing.
  const south = island.southIds.includes(feeder.inverterIds[0] ?? '');
  const side = pcs.filter(e => (south ? e.y < island.y : e.y > island.y));
  return (side.length ? side : pcs).map(e => ({
    x: e.x, y: e.y, length: e.length, width: e.width, height: e.height, rotation: e.rotation,
  }));
}
