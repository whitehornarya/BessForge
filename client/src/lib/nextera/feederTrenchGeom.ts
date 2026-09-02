// Pure geometry for the MV feeder trench channels rendered by
// FeederTrenchChannels in YardExtras.tsx. Kept free of three.js/react so
// the Node regression suite can verify the decomposition directly.
//
// Plan frame: x = easting, y = northing (feet). The 3D scene maps
// (x, y) -> (x, elev, -y). Sub centers use cz = -midY; yaw is plan
// bearing atan2(dy, dx) so rotateY aligns the channel with the segment.

export const FEEDER_TRENCH_W_FT = 3;
// Minimum polyline sub-segment length worth drawing a channel piece for.
export const FEEDER_SUB_MIN_LEN_FT = 0.5;
// Channel pieces (mask, bottom, walls, conductor) run overlong by one
// trench width so they join cleanly at L-corners.
export const FEEDER_SUB_OVERHANG_FT = FEEDER_TRENCH_W_FT;

export type FeederLike = { idx?: number; segments: { pts: { x: number; y: number }[] }[] };

// Joints turning by more than this get an extra "miter patch" piece: the
// fixed one-trench-width overhang on the two edge rectangles is proven (by
// the joint fan test) to cover every elbow up to a 90° direction change,
// but a sharper hairpin leaves the outer miter wedge of the elbow un-cut.
export const FEEDER_MAX_PLAIN_JOINT_DEV_RAD = Math.PI / 2;
// The miter tip distance (w/2)/cos(dev/2) diverges as the turn approaches a
// full reversal, while the un-covered wedge simultaneously thins to nothing.
// Cap how far a patch reaches; beyond this the residual sliver is thinner
// than anything visible at trench scale.
export const FEEDER_JOINT_PATCH_MAX_FT = 3 * FEEDER_TRENCH_W_FT;

type Pt2 = { x: number; y: number };

// Optional clip context for miter patches: patches are derived geometry (not
// part of the validated cable polyline), so on a hairpin right at the fence
// line the patch rect could poke outside the fence or into an equipment
// footprint. When bounds are given, each patch is shortened until its
// overlong rect stays inside the fence (only enforced when the joint vertex
// itself is inside the fence — feeder home runs legitimately travel outside
// to the substation) and clear of every obstacle polygon.
export type PatchClipBounds = {
  fence?: Pt2[];        // fenced-yard polygon (plan feet)
  obstacles?: Pt2[][];  // equipment footprint polygons (plan feet)
};

// Local even-odd point-in-polygon so this module stays free of imports (the
// Node regression suite loads it directly).
function ptInPoly(pt: Pt2, poly: Pt2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y;
    const xj = poly[j].x, yj = poly[j].y;
    if (yi > pt.y !== yj > pt.y && pt.x < ((xj - xi) * (pt.y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

// Distance from a point to the polygon's boundary (segments).
function distToPolyEdge(p: Pt2, poly: Pt2[]): number {
  let min = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    let t = len2 === 0 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    min = Math.min(min, Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)));
  }
  return min;
}

// Fence enforcement must include joints sitting exactly ON the fence line:
// even-odd point-in-polygon classifies some boundary points as outside
// (right/top edges), which would skip clipping in precisely the hairpin-at-
// the-fence scenario the clip exists for. Treat anything within this many
// feet of the fence boundary as inside for the enforcement decision.
const FENCE_ENFORCE_EPS_FT = 1e-6;

// True when a sample point of a patch rect is somewhere no ground cut may
// appear: outside the fence (when enforced) or inside an equipment footprint.
function patchPointBlocked(p: Pt2, bounds: PatchClipBounds, enforceFence: boolean): boolean {
  if (enforceFence && bounds.fence && bounds.fence.length >= 3 && !ptInPoly(p, bounds.fence)) return true;
  if (bounds.obstacles) {
    for (const poly of bounds.obstacles) {
      if (poly.length >= 3 && ptInPoly(p, poly)) return true;
    }
  }
  return false;
}

export type JointPatch = { a: Pt2; b: Pt2; index: number; clipped: boolean };

// For every interior vertex whose direction change exceeds 90°, return a
// short patch edge from the vertex along the outer miter bisector, sized so
// its overlong rectangle covers the miter wedge out to
// min(miter tip, FEEDER_JOINT_PATCH_MAX_FT). When `bounds` is given the
// patch is shortened (possibly to zero length, flagged via `clipped`) so its
// rect never leaves the fence or crosses an equipment footprint. Exported
// for the tests.
export function sharpJointPatches(pts: Pt2[], bounds?: PatchClipBounds): JointPatch[] {
  const out: JointPatch[] = [];
  const w = FEEDER_TRENCH_W_FT;
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1];
    const v = pts[i];
    const b = pts[i + 1];
    const l1 = Math.hypot(v.x - a.x, v.y - a.y);
    const l2 = Math.hypot(b.x - v.x, b.y - v.y);
    if (l1 < 1e-9 || l2 < 1e-9) continue;
    const d1 = { x: (v.x - a.x) / l1, y: (v.y - a.y) / l1 };
    const d2 = { x: (b.x - v.x) / l2, y: (b.y - v.y) / l2 };
    const dot = Math.max(-1, Math.min(1, d1.x * d2.x + d1.y * d2.y));
    const dev = Math.acos(dot);
    if (dev <= FEEDER_MAX_PLAIN_JOINT_DEV_RAD + 1e-9) continue;
    // Outer miter direction: bisects the elbow's outside wedge. d1 - d2
    // degenerates only as dev -> 0, which the threshold above excludes.
    let mx = d1.x - d2.x;
    let my = d1.y - d2.y;
    const ml = Math.hypot(mx, my);
    if (ml < 1e-9) continue;
    mx /= ml;
    my /= ml;
    // Distance from the vertex to the outer miter tip of the two exact
    // width-w strips; the whole wedge lies within w/2 of the miter axis, so
    // a single patch rect along the axis covers it.
    const cosHalf = Math.cos(dev / 2);
    const tip = cosHalf > 1e-6 ? (w / 2) / cosHalf : Infinity;
    const reach = Math.min(tip, FEEDER_JOINT_PATCH_MAX_FT);
    // The rect for an edge of length L extends L + overhang/2 past the
    // vertex end; size L so the rect reaches the (capped) tip.
    let len = Math.max(FEEDER_SUB_MIN_LEN_FT, reach - FEEDER_SUB_OVERHANG_FT / 2);
    let clipped = false;
    if (bounds && (bounds.fence || bounds.obstacles)) {
      // Only enforce the fence when the joint itself sits inside the fenced
      // yard; home runs to an outside substation legitimately leave it.
      const enforceFence = !!(bounds.fence && bounds.fence.length >= 3 &&
        (ptInPoly(v, bounds.fence) || distToPolyEdge(v, bounds.fence) <= FENCE_ENFORCE_EPS_FT));
      if (enforceFence || bounds.obstacles?.length) {
        // March outward along the miter axis: the patch rect is w wide and
        // extends len + overhang/2 past the vertex. Find the largest extent
        // whose full cross-sections stay legal, then shrink len to match.
        const px = -my, py = mx; // lateral unit
        const desired = len + FEEDER_SUB_OVERHANG_FT / 2;
        const step = w / 8;
        let allowed = desired;
        outer: for (let e = 0; e <= desired + 1e-9; e += step) {
          const d = Math.min(e, desired);
          for (const s of [-0.499 * w, 0, 0.499 * w]) {
            const p = { x: v.x + mx * d + px * s, y: v.y + my * d + py * s };
            if (patchPointBlocked(p, bounds, enforceFence)) {
              allowed = Math.max(0, d - step);
              break outer;
            }
          }
        }
        if (allowed < desired - 1e-9) {
          clipped = true;
          len = allowed - FEEDER_SUB_OVERHANG_FT / 2;
          if (len < FEEDER_SUB_MIN_LEN_FT) len = 0; // drop: caller filters short pieces
        }
      }
    }
    out.push({ a: v, b: { x: v.x + mx * len, y: v.y + my * len }, index: i, clipped });
  }
  return out;
}

export type FeederSub = {
  key: string;
  cx: number; // scene x of the sub-segment center
  cz: number; // scene z of the sub-segment center (= -plan y)
  len: number; // true polyline length (before overhang)
  ang: number; // plan bearing atan2(dy,dx); renderer maps via rotateY to scene xz
  idx?: number; // owning feeder's 1-based circuit idx (per-feeder coloring)
};

function toSub(key: string, a: Pt2, b: Pt2, len: number, idx?: number): FeederSub {
  return {
    key,
    cx: (a.x + b.x) / 2,
    cz: -(a.y + b.y) / 2,
    len,
    // Plan bearing atan2(dy,dx). InstancedTrenchChannels rotates about +Y so
    // local +X maps to scene (cos θ, -sin θ) = (dx, -dy)/len — matching
    // plan (x,y) → scene (x,-y). atan2(-dy,dx) mirrored diagonals (axis-
    // aligned runs still looked fine), so Direct DC digs missed the wires.
    ang: Math.atan2(b.y - a.y, b.x - a.x),
    idx,
  };
}

// Flatten every feeder segment polyline into straight sub-segments, plus a
// miter patch piece at any joint sharper than 90° (hairpin turns) so the
// elbow opening stays fully cut for any-angle routes. Optional `bounds`
// clips patch pieces so they never poke outside the fence or into
// equipment footprints (the edge rects themselves follow the validated
// cable polyline and need no clipping).
export function feederTrenchSubSegments(feeders: FeederLike[], bounds?: PatchClipBounds): FeederSub[] {
  const out: FeederSub[] = [];
  feeders.forEach((f, fi) =>
    f.segments.forEach((seg, si) => {
      for (let i = 0; i < seg.pts.length - 1; i++) {
        const a = seg.pts[i];
        const b = seg.pts[i + 1];
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        // NaN compares false against the minimum, so a poisoned point would
        // slip through and become NaN scene geometry (and a duplicate
        // "eNaN" React key from the ± end caps) — require a finite length.
        if (!Number.isFinite(len) || len < FEEDER_SUB_MIN_LEN_FT) continue;
        out.push(toSub(`${fi}-${si}-${i}`, a, b, len, f.idx));
      }
      if (seg.pts.length > 2) {
        for (const p of sharpJointPatches(seg.pts, bounds)) {
          const len = Math.hypot(p.b.x - p.a.x, p.b.y - p.a.y);
          if (!Number.isFinite(len) || len < FEEDER_SUB_MIN_LEN_FT - 1e-9) continue;
          out.push(toSub(`${fi}-${si}-p${p.index}`, p.a, p.b, len, f.idx));
        }
      }
    })
  );
  return out;
}
