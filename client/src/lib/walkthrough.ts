// First-person site walkthrough: pure math (no three.js scene deps) so the
// spawn pose, collision world and movement kinematics are testable in Node.
// Plan coordinates (x, y) in feet; the scene maps plan (x, y) -> (x, elev, -y).

import { SiteDesign, Pt } from './nextera/types';
import { pointInPolygon } from './nextera/kmz';

// ---------------------------------------------------------------------------
// Tuning (feet, seconds) — human-scale walking per US ergonomic norms.
export const EYE_HEIGHT_FT = 5.5;        // engineer eye level
export const PLAYER_RADIUS_FT = 1.25;    // shoulder-width capsule radius
export const WALK_SPEED_FPS = 8;         // ~5.5 mph brisk site walk
export const SPRINT_SPEED_FPS = 16;      // double-time
export const ACCEL_FPS2 = 40;            // reach full speed in ~0.2 s
export const FRICTION_FPS2 = 30;         // glide to a stop in ~0.25 s
export const SPAWN_BACKOFF_FT = 18;      // spawn this far outside the gate
export const HEAD_BOB_FREQ = 2.1;        // steps per second at walk speed
export const HEAD_BOB_AMP_FT = 0.12;     // subtle vertical bob

export interface WalkSegment { ax: number; ay: number; bx: number; by: number }
export interface WalkBox {
  x: number; y: number;      // center
  hl: number; hw: number;    // half length (local x) / half width (local y)
  cos: number; sin: number;  // rotation
}

export interface WalkWorld {
  walls: WalkSegment[]; // fence line minus the gate opening
  boxes: WalkBox[];     // equipment footprints
}

export interface SpawnPose {
  x: number; y: number;   // plan feet
  yaw: number;            // radians, plan-space heading (0 = +x, CCW)
}

const EPS = 1e-9;

function polygonCentroid(poly: Pt[]): Pt {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    const w = p.x * q.y - q.x * p.y;
    a += w; cx += (p.x + q.x) * w; cy += (p.y + q.y) * w;
  }
  if (Math.abs(a) < EPS) return poly[0] ?? { x: 0, y: 0 };
  return { x: cx / (3 * a), y: cy / (3 * a) };
}

// Spawn pose: just outside the gate, facing straight through the opening
// into the yard. Null when the design has no gate.
export function gateSpawn(design: SiteDesign): SpawnPose | null {
  const gate = design.gate;
  if (!gate) return null;
  // Fence tangent at the gate is gate.rotation; the two candidate normals
  // are rotation ± 90°. Probe a short step along each normal and pick the
  // one that lands inside the fence — robust on concave fences (a centroid
  // heuristic points the wrong way when the gate sits on a notch wall).
  const nx = -Math.sin(gate.rotation);
  const ny = Math.cos(gate.rotation);
  let inward = pointInPolygon({ x: gate.x + nx * 2, y: gate.y + ny * 2 }, design.fence) ? 1 : -1;
  if (inward === -1 && !pointInPolygon({ x: gate.x - nx * 2, y: gate.y - ny * 2 }, design.fence)) {
    // Degenerate probe (both outside): fall back to the centroid heuristic.
    const c = polygonCentroid(design.fence);
    inward = (c.x - gate.x) * nx + (c.y - gate.y) * ny >= 0 ? 1 : -1;
  }
  const ix = nx * inward, iy = ny * inward;
  return {
    x: gate.x - ix * SPAWN_BACKOFF_FT,
    y: gate.y - iy * SPAWN_BACKOFF_FT,
    yaw: Math.atan2(iy, ix),
  };
}

// Fence wall segments with the gate opening removed, so the engineer can
// walk through the entrance but nowhere else across the fence line.
export function fenceWalls(design: SiteDesign): WalkSegment[] {
  const fence = design.fence;
  const gate = design.gate;
  const out: WalkSegment[] = [];
  if (fence.length < 2) return out;
  const halfGap = gate ? gate.width / 2 + PLAYER_RADIUS_FT : 0;
  for (let i = 0; i < fence.length; i++) {
    const a = fence[i], b = fence[(i + 1) % fence.length];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < EPS) continue;
    if (!gate) { out.push({ ax: a.x, ay: a.y, bx: b.x, by: b.y }); continue; }
    // Project the gate point onto this segment; if it lies on it, split the
    // segment around the opening.
    const t = ((gate.x - a.x) * dx + (gate.y - a.y) * dy) / (len * len);
    const px = a.x + dx * t, py = a.y + dy * t;
    const onSeg = t >= -EPS && t <= 1 + EPS &&
      Math.hypot(px - gate.x, py - gate.y) < 0.5;
    if (!onSeg) { out.push({ ax: a.x, ay: a.y, bx: b.x, by: b.y }); continue; }
    const tGap = halfGap / len;
    const t0 = Math.max(0, t - tGap);
    const t1 = Math.min(1, t + tGap);
    if (t0 > EPS) out.push({ ax: a.x, ay: a.y, bx: a.x + dx * t0, by: a.y + dy * t0 });
    if (t1 < 1 - EPS) out.push({ ax: a.x + dx * t1, ay: a.y + dy * t1, bx: b.x, by: b.y });
  }
  return out;
}

// Full collision world: fence walls + every placed equipment footprint.
// Reserved zones (laydown / future aug) are ground markings — walkable.
export function buildWalkWorld(design: SiteDesign): WalkWorld {
  const boxes: WalkBox[] = design.equipment.map(e => ({
    x: e.x,
    y: e.y,
    hl: e.length / 2,
    hw: e.width / 2,
    cos: Math.cos(e.rotation),
    sin: Math.sin(e.rotation),
  }));
  return { walls: fenceWalls(design), boxes };
}

// Push a circle of radius r at (x, y) out of a segment. Returns corrected
// position (slide response: only the penetration normal is removed).
function pushOutOfSegment(x: number, y: number, r: number, s: WalkSegment): { x: number; y: number } {
  const dx = s.bx - s.ax, dy = s.by - s.ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 < EPS ? 0 : Math.max(0, Math.min(1, ((x - s.ax) * dx + (y - s.ay) * dy) / len2));
  const cx = s.ax + dx * t, cy = s.ay + dy * t;
  let nx = x - cx, ny = y - cy;
  const d = Math.hypot(nx, ny);
  if (d >= r) return { x, y };
  if (d < EPS) { // dead center on the wall: push along segment normal
    nx = -dy; ny = dx;
    const nl = Math.hypot(nx, ny) || 1;
    nx /= nl; ny /= nl;
    return { x: cx + nx * r, y: cy + ny * r };
  }
  return { x: cx + (nx / d) * r, y: cy + (ny / d) * r };
}

// Push a circle out of a rotated box (expanded by r — circle vs rounded box).
function pushOutOfBox(x: number, y: number, r: number, b: WalkBox): { x: number; y: number } {
  // to box-local frame
  const lx = (x - b.x) * b.cos + (y - b.y) * b.sin;
  const ly = -(x - b.x) * b.sin + (y - b.y) * b.cos;
  const qx = Math.max(-b.hl, Math.min(b.hl, lx));
  const qy = Math.max(-b.hw, Math.min(b.hw, ly));
  let nx = lx - qx, ny = ly - qy;
  const d = Math.hypot(nx, ny);
  let ox: number, oy: number;
  if (d >= r) return { x, y };
  if (d > EPS) {
    // outside the box face/corner but within r: push out along the normal
    ox = qx + (nx / d) * r;
    oy = qy + (ny / d) * r;
  } else {
    // center inside the box: exit through the nearest face
    const px = b.hl - Math.abs(lx);
    const py = b.hw - Math.abs(ly);
    if (px < py) { ox = (lx >= 0 ? b.hl + r : -b.hl - r); oy = ly; }
    else { ox = lx; oy = (ly >= 0 ? b.hw + r : -b.hw - r); }
  }
  return {
    x: b.x + ox * b.cos - oy * b.sin,
    y: b.y + ox * b.sin + oy * b.cos,
  };
}

// Resolve all collisions for the player circle; a few iterations lets the
// position settle in corners where walls and boxes meet (natural sliding).
export function resolveCollisions(x: number, y: number, world: WalkWorld, r = PLAYER_RADIUS_FT): { x: number; y: number } {
  let px = x, py = y;
  for (let it = 0; it < 3; it++) {
    let moved = false;
    for (const b of world.boxes) {
      const n = pushOutOfBox(px, py, r, b);
      if (n.x !== px || n.y !== py) { px = n.x; py = n.y; moved = true; }
    }
    for (const s of world.walls) {
      const n = pushOutOfSegment(px, py, r, s);
      if (n.x !== px || n.y !== py) { px = n.x; py = n.y; moved = true; }
    }
    if (!moved) break;
  }
  return { x: px, y: py };
}

export interface WalkInput {
  forward: boolean; back: boolean; left: boolean; right: boolean; sprint: boolean;
}

export interface WalkState {
  x: number; y: number;      // plan feet
  vx: number; vy: number;    // plan feet / s
  yaw: number;               // plan heading, radians (0 = +x, CCW)
  bobPhase: number;          // head-bob accumulator
}

// One kinematics step: acceleration toward the wish direction, friction when
// idle, speed clamp, integration, then collision resolution. Pure.
export function stepWalk(state: WalkState, input: WalkInput, dt: number, world: WalkWorld): WalkState {
  const clampedDt = Math.min(dt, 0.05); // never explode on a hitched frame
  const fx = Math.cos(state.yaw), fy = Math.sin(state.yaw);
  const rx = fy, ry = -fx; // strafe right of heading
  let wx = 0, wy = 0;
  if (input.forward) { wx += fx; wy += fy; }
  if (input.back) { wx -= fx; wy -= fy; }
  if (input.right) { wx += rx; wy += ry; }
  if (input.left) { wx -= rx; wy -= ry; }
  const wl = Math.hypot(wx, wy);
  let vx = state.vx, vy = state.vy;
  if (wl > EPS) {
    vx += (wx / wl) * ACCEL_FPS2 * clampedDt;
    vy += (wy / wl) * ACCEL_FPS2 * clampedDt;
  } else {
    const sp = Math.hypot(vx, vy);
    const drop = FRICTION_FPS2 * clampedDt;
    const k = sp <= drop ? 0 : (sp - drop) / sp;
    vx *= k; vy *= k;
  }
  const max = input.sprint ? SPRINT_SPEED_FPS : WALK_SPEED_FPS;
  const sp = Math.hypot(vx, vy);
  if (sp > max) { vx *= max / sp; vy *= max / sp; }
  const raw = { x: state.x + vx * clampedDt, y: state.y + vy * clampedDt };
  const pos = resolveCollisions(raw.x, raw.y, world);
  // kill velocity into the surface we were pushed out of
  if (Math.hypot(pos.x - raw.x, pos.y - raw.y) > EPS) {
    const nx = pos.x - raw.x, ny = pos.y - raw.y;
    const nl = Math.hypot(nx, ny);
    const into = (vx * nx + vy * ny) / nl;
    if (into < 0) { vx -= (nx / nl) * into; vy -= (ny / nl) * into; }
  }
  const moving = Math.hypot(vx, vy);
  const bobPhase = state.bobPhase + moving * clampedDt * (HEAD_BOB_FREQ / WALK_SPEED_FPS) * Math.PI * 2;
  return { x: pos.x, y: pos.y, vx, vy, yaw: state.yaw, bobPhase };
}

// Eye elevation with subtle head bob, scaled by how fast we're moving.
export function eyeHeight(state: WalkState): number {
  const speed = Math.hypot(state.vx, state.vy);
  const k = Math.min(1, speed / WALK_SPEED_FPS);
  return EYE_HEIGHT_FT + Math.sin(state.bobPhase) * HEAD_BOB_AMP_FT * k;
}
