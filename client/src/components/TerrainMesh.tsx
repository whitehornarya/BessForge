// True-terrain relief for the 3D preview: the USGS 3DEP elevation grid
// displaces a ground mesh, the satellite mosaic (or dirt texture) drapes
// over it, and an optional slope heatmap overlays grade percent per vertex.
//
// The fenced yard is shown as a GRADED PAD: terrain inside the fence is
// flattened to the cut/fill pad elevation (the yard geometry above it stays
// flat and WYSIWYG), with a smooth transition band outside the fence line.
// Preview/analysis only — never affects layout math, DXF or PDF geometry.
import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { useThree } from '@react-three/fiber';
import { Pt } from '../lib/nextera/types';
import { Line, Text } from '@react-three/drei';
import {
  ElevationGrid,
  LocalRect,
  terrainLocalRect,
  sampleElevationFt,
  computeSlopeGrid,
  sampleSlopePct,
  slopeRampColor,
  computeContours,
  pickContourInterval,
  ContourLine,
  computeGradingTieIn,
} from '../lib/nextera/terrain';
import { pointInPolygon, distanceToPolygonEdge } from '../lib/nextera/kmz';
import { FgSurface, fgElevationAt } from '../lib/nextera/gradingSurface';
import { buildProposedContours, cutFillBandIndexAt, CUT_FILL_BANDS } from '../lib/nextera/gradingPlan';
import { DrainageModel } from '../lib/nextera/drainage';
import { SatelliteImage, satelliteLocalRect } from '../lib/nextera/satellite';
import { getYardTextureSet } from '../lib/textureSets';
import { useDesignStore } from '../lib/stores/useDesignStore';
import { useTexture } from '@react-three/drei';
import { configureGroundTexture } from '../lib/groundTexture';

// Vertical placement of the graded pad surface relative to the (flat) yard
// geometry at y=0: just below the surfacing (0.08) and roads (0.2), above
// the legacy flat ground plane (-0.25). Respects the established >=0.1 ft
// layer-separation convention (see ground z-fighting notes).
const PAD_SURFACE_Y = -0.12;
// Blend band width outside the fence: pad elevation eases into true ground.
const BLEND_BAND_FT = 80;
// Grid resolution of the rendered mesh (vertices per side). Bilinear
// upsampling of the elevation grid keeps it smooth without huge buffers.
const MESH_SEGS = 160;

export interface TerrainGeomOpts {
  grid: ElevationGrid;
  rect: LocalRect;
  fence: Pt[];
  padElevationFt: number;
  fg?: FgSurface | null;
}

// Displaced-surface height (relative to the pad elevation) at a local point:
// true ground outside the fence, 0 on the graded pad, smoothstep blend in
// the band just outside the fence. Shared by the mesh and the contour drape
// so lines sit exactly on the rendered surface.
//
// When a proposed grading surface (fg) is supplied, the rendered ground IS
// that surface: sloped/benched pads inside the fence, cut/fill daylight
// slope faces in the tie-in band, existing ground beyond daylight — all
// continuous by construction, so no blend band is needed. The yard geometry
// above stays flat at y=0 (screening preview; equipment is not re-seated on
// benches).
function reliefAt(
  grid: ElevationGrid,
  rect: LocalRect,
  fence: Pt[],
  padElevationFt: number,
  x: number,
  y: number,
  fg?: FgSurface | null
): number {
  if (fg) return fgElevationAt(fg, grid, rect, x, y) - padElevationFt;
  let rel = sampleElevationFt(grid, rect, x, y) - padElevationFt;
  if (fence.length >= 3) {
    if (pointInPolygon({ x, y }, fence)) {
      rel = 0; // graded pad
    } else {
      const d = distanceToPolygonEdge({ x, y }, fence);
      if (d < BLEND_BAND_FT) {
        const t = d / BLEND_BAND_FT;
        rel *= t * t * (3 - 2 * t); // smoothstep
      }
    }
  }
  return rel;
}

// Displaced plane geometry in the scene frame (x, up, -y). Heights are
// RELATIVE to the pad elevation so the yard stays at scene y ~= 0.
function buildTerrainGeometry(opts: TerrainGeomOpts): THREE.BufferGeometry {
  const { grid, rect, fence, padElevationFt, fg } = opts;
  const w = rect.maxX - rect.minX;
  const h = rect.maxY - rect.minY;
  const segs = MESH_SEGS;
  const verts = (segs + 1) * (segs + 1);
  const positions = new Float32Array(verts * 3);
  const uvs = new Float32Array(verts * 2);
  let i = 0;
  for (let r = 0; r <= segs; r++) {
    const y = rect.maxY - (h * r) / segs; // row 0 = north
    for (let c = 0; c <= segs; c++) {
      const x = rect.minX + (w * c) / segs;
      const rel = reliefAt(grid, rect, fence, padElevationFt, x, y, fg);
      positions[i * 3] = x;
      positions[i * 3 + 1] = PAD_SURFACE_Y + rel;
      positions[i * 3 + 2] = -y;
      uvs[i * 2] = c / segs;
      uvs[i * 2 + 1] = 1 - r / segs;
      i++;
    }
  }
  const indices = new Uint32Array(segs * segs * 6);
  let k = 0;
  for (let r = 0; r < segs; r++) {
    for (let c = 0; c < segs; c++) {
      const a = r * (segs + 1) + c;
      const b = a + 1;
      const d = a + segs + 1;
      const e = d + 1;
      indices[k++] = a; indices[k++] = d; indices[k++] = b;
      indices[k++] = b; indices[k++] = d; indices[k++] = e;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  geo.computeVertexNormals();
  return geo;
}

// Remap the default 0..1 UVs so the satellite mosaic lands georegistered on
// the terrain rect (both are in the same local-feet frame). Under a
// grading-optimized yard rotation the mesh vertices are yard-frame points
// while the mosaic rect is geo-frame — each vertex is rotated by +θ about
// the pivot (yard → geo) before the UV lookup, so the imagery stays
// georegistered on the rotated relief. θ = 0 skips the transform entirely.
function applySatelliteUvs(
  geo: THREE.BufferGeometry,
  rect: LocalRect,
  satRect: LocalRect,
  yardRotationDeg = 0,
  yardPivot: Pt = { x: 0, y: 0 }
) {
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
  const sw = satRect.maxX - satRect.minX;
  const sh = satRect.maxY - satRect.minY;
  const a = (yardRotationDeg * Math.PI) / 180;
  const cos = Math.cos(a), sin = Math.sin(a);
  for (let i = 0; i < pos.count; i++) {
    let x = pos.getX(i);
    let y = -pos.getZ(i);
    if (yardRotationDeg !== 0) {
      const dx = x - yardPivot.x, dy = y - yardPivot.y;
      x = yardPivot.x + dx * cos - dy * sin;
      y = yardPivot.y + dx * sin + dy * cos;
    }
    uv.setXY(i, (x - satRect.minX) / sw, (y - satRect.minY) / sh);
  }
  uv.needsUpdate = true;
  void rect;
}

function useDisposable<T extends { dispose(): void }>(obj: T): T {
  useEffect(() => () => obj.dispose(), [obj]);
  return obj;
}

function SatelliteTerrainMaterial({ image }: { image: SatelliteImage }) {
  const gl = useThree(s => s.gl);
  const maxAnisotropy = useMemo(() => gl.capabilities.getMaxAnisotropy(), [gl]);
  const invalidate = useThree(s => s.invalidate);
  const tex = useMemo(() => {
    // invalidate on load: with the demand frameloop the async texture decode
    // wouldn't otherwise trigger a repaint.
    const t = new THREE.TextureLoader().load(image.dataUrl, () => invalidate());
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = maxAnisotropy;
    return t;
  }, [image, maxAnisotropy, invalidate]);
  useEffect(() => () => tex.dispose(), [tex]);
  return <meshStandardMaterial map={tex} side={THREE.DoubleSide} />;
}

function DirtTerrainMaterial({ rect }: { rect: LocalRect }) {
  const texSet = getYardTextureSet(useDesignStore(s => s.textureSetId));
  const url = texSet.dirt ?? texSet.rock;
  const base = useTexture(url);
  const gl = useThree(s => s.gl);
  const maxAnisotropy = useMemo(() => gl.capabilities.getMaxAnisotropy(), [gl]);
  const tex = useMemo(() => {
    const t = base.clone();
    configureGroundTexture(t, maxAnisotropy);
    // UVs span the rect 0..1; tile every ~30 ft.
    t.repeat.set((rect.maxX - rect.minX) / 30, (rect.maxY - rect.minY) / 30);
    return t;
  }, [base, rect, maxAnisotropy]);
  // Cloned textures own GPU allocations — free them when the clone is
  // replaced (boundary/texture-set switch) or the mesh unmounts.
  useEffect(() => () => tex.dispose(), [tex]);
  return <meshStandardMaterial map={tex} color={texSet.dirt ? '#ffffff' : '#8a7f5c'} side={THREE.DoubleSide} />;
}

// Height offsets keeping contours/labels above the slope overlay (+0.35).
const CONTOUR_LIFT = 0.55;
const LABEL_LIFT = 0.8;

// Flatten polylines into a shared segment-pair list so a whole style class
// (all major or all minor contours) renders as ONE merged LineSegments2
// draw instead of one Line object per run. Purely a draw-call optimization:
// the vertices are byte-identical to the per-run version.
function polylinesToSegments(runs: [number, number, number][][]): [number, number, number][] {
  const out: [number, number, number][] = [];
  for (const run of runs) {
    for (let i = 0; i < run.length - 1; i++) out.push(run[i], run[i + 1]);
  }
  return out;
}

// A contour polyline clipped against the fence (contours are meaningless on
// the flattened pad) and draped onto the displaced surface. Splits into runs
// where the line crosses the fence polygon.
function splitOutsideFence(line: ContourLine, fence: Pt[]): Pt[][] {
  if (fence.length < 3) return [line.pts];
  const runs: Pt[][] = [];
  let cur: Pt[] = [];
  for (const p of line.pts) {
    if (pointInPolygon(p, fence)) {
      if (cur.length >= 2) runs.push(cur);
      cur = [];
    } else {
      cur.push(p);
    }
  }
  if (cur.length >= 2) runs.push(cur);
  return runs;
}

function ContourOverlay({ grid, rect, fence, padElevationFt, intervalFt, fg }: {
  grid: ElevationGrid;
  rect: LocalRect;
  fence: Pt[];
  padElevationFt: number;
  intervalFt: number; // 0 = auto from site relief
  fg?: FgSurface | null;
}) {
  const contours = useMemo(() => {
    let minV = Infinity, maxV = -Infinity;
    for (const v of grid.valuesFt) {
      if (!Number.isFinite(v)) continue;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    const interval = intervalFt > 0 ? intervalFt : pickContourInterval(minV, maxV);
    return computeContours(grid, rect, interval);
  }, [grid, rect, intervalFt]);

  // Clip against the fence and drape each vertex onto the rendered surface.
  const draped = useMemo(() => {
    const out: Array<{ pts3: [number, number, number][]; major: boolean; elevFt: number; lenFt: number }> = [];
    for (const line of contours.lines) {
      for (const run of splitOutsideFence(line, fence)) {
        let len = 0;
        const pts3 = run.map((p, i) => {
          if (i > 0) len += Math.hypot(p.x - run[i - 1].x, p.y - run[i - 1].y);
          const rel = reliefAt(grid, rect, fence, padElevationFt, p.x, p.y, fg);
          return [p.x, PAD_SURFACE_Y + rel + CONTOUR_LIFT, -p.y] as [number, number, number];
        });
        if (len < 20) continue; // drop slivers (ft)
        out.push({ pts3, major: line.major, elevFt: line.elevFt, lenFt: len });
      }
    }
    return out;
  }, [contours, fence, grid, rect, padElevationFt, fg]);

  // One label per major level: on that level's longest run, at its midpoint,
  // laid flat on the ground and rotated along the local line direction.
  const labels = useMemo(() => {
    const bestByLevel = new Map<number, { pts3: [number, number, number][]; lenFt: number }>();
    for (const d of draped) {
      if (!d.major || d.lenFt < 120) continue;
      const cur = bestByLevel.get(d.elevFt);
      if (!cur || d.lenFt > cur.lenFt) bestByLevel.set(d.elevFt, { pts3: d.pts3, lenFt: d.lenFt });
    }
    return Array.from(bestByLevel.entries()).map(([elevFt, run]) => {
      const m = run.pts3[Math.floor(run.pts3.length / 2)];
      const m2 = run.pts3[Math.min(Math.floor(run.pts3.length / 2) + 1, run.pts3.length - 1)];
      let ang = Math.atan2(-(m2[2] - m[2]), m2[0] - m[0]); // plan angle (x, -z)
      // Keep text upright (never upside-down when read from above)
      if (ang > Math.PI / 2) ang -= Math.PI;
      if (ang < -Math.PI / 2) ang += Math.PI;
      return { elevFt, x: m[0], y: m[1] - CONTOUR_LIFT + LABEL_LIFT, z: m[2], ang };
    });
  }, [draped]);

  // Merged linework: one draw per style class instead of one per run.
  const majorSegs = useMemo(
    () => polylinesToSegments(draped.filter(d => d.major).map(d => d.pts3)),
    [draped]
  );
  const minorSegs = useMemo(
    () => polylinesToSegments(draped.filter(d => !d.major).map(d => d.pts3)),
    [draped]
  );

  return (
    <group>
      {majorSegs.length > 0 && (
        <Line points={majorSegs} segments color="#8a5a2b" lineWidth={2.5} transparent opacity={0.95} />
      )}
      {minorSegs.length > 0 && (
        <Line points={minorSegs} segments color="#a9835a" lineWidth={1.2} transparent opacity={0.7} />
      )}
      {labels.map((l, i) => (
        <Text
          key={i}
          position={[l.x, l.y, l.z]}
          rotation={[-Math.PI / 2, 0, l.ang]}
          fontSize={14}
          color="#6b4423"
          anchorX="center"
          anchorY="middle"
          outlineWidth={1}
          outlineColor="#f5efe4"
        >
          {`${l.elevFt.toFixed(l.elevFt % 1 === 0 ? 0 : 1)} FT`}
        </Text>
      ))}
    </group>
  );
}

// Proposed-grading overlay colors matching the GP-1 sheet convention:
// minor proposed contours green, index (major) contours red with elevation
// labels, daylight/disturbance limit magenta dashed.
const PROPOSED_MINOR_COLOR = '#3fae5c';
const PROPOSED_MAJOR_COLOR = '#d0453a';
const DAYLIGHT_COLOR = '#c743c7';
const PROPOSED_LIFT = 0.6;

// Preview-only proposed-grading linework: the same proposed FG contours and
// daylight limit that GP-1 exports (buildProposedContours), draped onto the
// rendered FG surface so drafters see the grading plan before export.
// Rendered only when the FG surface is on; never touches exports.
function ProposedContourOverlay({ grid, rect, fence, padElevationFt, intervalFt, fg }: {
  grid: ElevationGrid;
  rect: LocalRect;
  fence: Pt[];
  padElevationFt: number;
  intervalFt: number; // 0 = auto (same pick the GP-1 sheet uses)
  fg: FgSurface;
}) {
  const contours = useMemo(
    () => buildProposedContours(grid, rect, fg, intervalFt > 0 ? intervalFt : undefined),
    [grid, rect, fg, intervalFt]
  );

  const drape = useMemo(() => {
    return (p: Pt, lift = PROPOSED_LIFT): [number, number, number] => [
      p.x,
      PAD_SURFACE_Y + reliefAt(grid, rect, fence, padElevationFt, p.x, p.y, fg) + lift,
      -p.y,
    ];
  }, [grid, rect, fence, padElevationFt, fg]);

  const draped = useMemo(() => {
    const out: Array<{ pts3: [number, number, number][]; major: boolean; elevFt: number; lenFt: number }> = [];
    for (const line of contours.lines) {
      if (line.pts.length < 2) continue;
      let len = 0;
      const pts3 = line.pts.map((p, i) => {
        if (i > 0) len += Math.hypot(p.x - line.pts[i - 1].x, p.y - line.pts[i - 1].y);
        return drape(p);
      });
      if (len < 20) continue; // drop slivers (ft)
      out.push({ pts3, major: line.major, elevFt: line.elevFt, lenFt: len });
    }
    return out;
  }, [contours, drape]);

  // One label per major level on its longest run (same rule as the existing
  // contour overlay), laid flat and aligned with the local line direction.
  const labels = useMemo(() => {
    const bestByLevel = new Map<number, { pts3: [number, number, number][]; lenFt: number }>();
    for (const d of draped) {
      if (!d.major || d.lenFt < 80) continue;
      const cur = bestByLevel.get(d.elevFt);
      if (!cur || d.lenFt > cur.lenFt) bestByLevel.set(d.elevFt, { pts3: d.pts3, lenFt: d.lenFt });
    }
    return Array.from(bestByLevel.entries()).map(([elevFt, run]) => {
      const m = run.pts3[Math.floor(run.pts3.length / 2)];
      const m2 = run.pts3[Math.min(Math.floor(run.pts3.length / 2) + 1, run.pts3.length - 1)];
      let ang = Math.atan2(-(m2[2] - m[2]), m2[0] - m[0]);
      if (ang > Math.PI / 2) ang -= Math.PI;
      if (ang < -Math.PI / 2) ang += Math.PI;
      return { elevFt, x: m[0], y: m[1] - PROPOSED_LIFT + LABEL_LIFT, z: m[2], ang };
    });
  }, [draped]);

  const daylight = useMemo(() => {
    if (fg.daylightPolygon.length < 3) return null;
    const pts = [...fg.daylightPolygon, fg.daylightPolygon[0]];
    return pts.map(p => drape(p, PROPOSED_LIFT + 0.05));
  }, [fg.daylightPolygon, drape]);

  // Merged linework: one draw per style class instead of one per run.
  const majorSegs = useMemo(
    () => polylinesToSegments(draped.filter(d => d.major).map(d => d.pts3)),
    [draped]
  );
  const minorSegs = useMemo(
    () => polylinesToSegments(draped.filter(d => !d.major).map(d => d.pts3)),
    [draped]
  );

  return (
    <group>
      {majorSegs.length > 0 && (
        <Line points={majorSegs} segments color={PROPOSED_MAJOR_COLOR} lineWidth={2.5} transparent opacity={0.95} />
      )}
      {minorSegs.length > 0 && (
        <Line points={minorSegs} segments color={PROPOSED_MINOR_COLOR} lineWidth={1.2} transparent opacity={0.75} />
      )}
      {daylight && (
        <Line
          points={daylight}
          color={DAYLIGHT_COLOR}
          lineWidth={2}
          dashed
          dashSize={10}
          gapSize={6}
          transparent
          opacity={0.9}
        />
      )}
      {labels.map((l, i) => (
        <Text
          key={i}
          position={[l.x, l.y, l.z]}
          rotation={[-Math.PI / 2, 0, l.ang]}
          fontSize={14}
          color={PROPOSED_MAJOR_COLOR}
          anchorX="center"
          anchorY="middle"
          outlineWidth={1}
          outlineColor="#f5efe4"
        >
          {`FG ${l.elevFt.toFixed(l.elevFt % 1 === 0 ? 0 : 1)}`}
        </Text>
      ))}
    </group>
  );
}

// Cut/fill isopach drape colors, one per CUT_FILL_BANDS entry (same order):
// deep cut red, shallow cut orange, shallow fill teal, deep fill blue —
// matching the read of the GP-1 export band colors (ACI 1/30/4/5).
const CUT_FILL_PREVIEW_COLORS: readonly [number, number, number][] = [
  [0.82, 0.20, 0.16], // CUT > 2 FT (red)
  [0.90, 0.55, 0.16], // CUT 0.5-2 FT (orange)
  [0.18, 0.72, 0.75], // FILL 0.5-2 FT (teal/cyan)
  [0.16, 0.38, 0.85], // FILL > 2 FT (blue)
];
export const CUT_FILL_PREVIEW_LEGEND = CUT_FILL_BANDS.map((def, i) => {
  const [r, g, b] = CUT_FILL_PREVIEW_COLORS[i];
  const hex = (v: number) => Math.round(v * 255).toString(16).padStart(2, '0');
  return { label: def.label, color: `#${hex(r)}${hex(g)}${hex(b)}` };
});

// Grading-limit colors (civil convention: cut = red, fill = green).
const CUT_COLOR = '#d0453a';
const FILL_COLOR = '#2f9e57';
// Lifts keeping the tie-in band above contours (+0.55) and below labels.
const TIEIN_LIFT = 0.65;

// Preview-only cut/fill grading limits at the pad edge: the fence tie-in
// line colored by cut vs fill, a dashed daylight line offset outward where
// the slope meets natural ground (3:1, clamped to the render blend band),
// and slope hachures (ticks) between them — how a grading plan reads.
// Never touches layout math or DXF/PDF exports.
function GradingLimitsOverlay({ grid, rect, fence, padElevationFt, slopeRatio, fg }: {
  grid: ElevationGrid;
  rect: LocalRect;
  fence: Pt[];
  padElevationFt: number;
  slopeRatio: number; // horizontal : vertical (e.g. 3 = 3:1)
  fg?: FgSurface | null;
}) {
  const tieIn = useMemo(
    () => computeGradingTieIn(grid, rect, fence, padElevationFt, { maxOffsetFt: BLEND_BAND_FT, slopeRatio }),
    [grid, rect, fence, padElevationFt, slopeRatio]
  );

  const drape = (p: Pt): [number, number, number] => [
    p.x,
    PAD_SURFACE_Y + reliefAt(grid, rect, fence, padElevationFt, p.x, p.y, fg) + TIEIN_LIFT,
    -p.y,
  ];

  const built = useMemo(() => {
    if (!tieIn) return null;
    const runs = tieIn.runs.map(run => {
      const tiePts = run.pts.map(drape);
      const dayPts = run.daylightPts.map(drape);
      // Hachures every ~3rd sample (~30 ft), only where the offset is
      // visible; alternate long/short ticks like plan-view slope hatching.
      const ticks: Array<[number, number, number][]> = [];
      for (let i = 0; i < run.pts.length; i += 3) {
        const a = run.pts[i], b = run.daylightPts[i];
        const dx = b.x - a.x, dy = b.y - a.y;
        if (Math.hypot(dx, dy) < 4) continue;
        const f = (i / 3) % 2 === 0 ? 1 : 0.5; // long / short alternation
        ticks.push([drape(a), drape({ x: a.x + dx * f, y: a.y + dy * f })]);
      }
      return { kind: run.kind, tiePts, dayPts, ticks };
    }).filter(r => r.tiePts.length >= 2);
    return runs;
    // drape is stable given the same inputs; deps below cover them all.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tieIn, grid, rect, fence, padElevationFt, fg]);

  if (!built || !built.length) return null;
  return (
    <group>
      {built.map((r, i) => {
        const color = r.kind === 'cut' ? CUT_COLOR : FILL_COLOR;
        return (
          <group key={i}>
            <Line points={r.tiePts} color={color} lineWidth={3} transparent opacity={0.95} />
            <Line
              points={r.dayPts}
              color={color}
              lineWidth={1.5}
              dashed
              dashSize={8}
              gapSize={5}
              transparent
              opacity={0.8}
            />
            {r.ticks.length > 0 && (
              <Line points={polylinesToSegments(r.ticks)} segments color={color} lineWidth={1} transparent opacity={0.6} />
            )}
          </group>
        );
      })}
    </group>
  );
}

// Drainage screening overlay colors + lifts (above tie-in lines at +0.65).
const FLOW_COLOR = '#2f7fd0';
const POND_COLOR = '#d0453a';
const SWALE_COLOR = '#1f5fa8';
const DISCHARGE_COLOR = '#128a4c';
const DRAINAGE_LIFT = 0.75;

// Preview-only drainage screening overlay: D8 flow arrows + major flow-path
// polylines, ponding (sink) markers, perimeter swale centerlines along the
// daylight toe, and discharge-point markers with peak-flow labels. Draped
// onto the rendered surface; never touches layout math or exports.
function DrainageOverlay({ grid, rect, fence, padElevationFt, drainage, fg }: {
  grid: ElevationGrid;
  rect: LocalRect;
  fence: Pt[];
  padElevationFt: number;
  drainage: DrainageModel;
  fg?: FgSurface | null;
}) {
  const drape = useMemo(() => {
    return (p: Pt, lift = DRAINAGE_LIFT): [number, number, number] => [
      p.x,
      PAD_SURFACE_Y + reliefAt(grid, rect, fence, padElevationFt, p.x, p.y, fg) + lift,
      -p.y,
    ];
  }, [grid, rect, fence, padElevationFt, fg]);

  // Arrow segments: shaft + two head barbs per arrow (flat plan geometry).
  const arrows = useMemo(() => {
    const segs: Array<[number, number, number][]> = [];
    for (const a of drainage.flowArrows) {
      const L = 14; // ft shaft
      const tip = { x: a.x + a.dx * L, y: a.y + a.dy * L };
      const bx = -a.dy, by = a.dx; // perpendicular
      segs.push([drape({ x: a.x, y: a.y }), drape(tip)]);
      segs.push([drape(tip), drape({ x: tip.x - a.dx * 5 + bx * 3, y: tip.y - a.dy * 5 + by * 3 })]);
      segs.push([drape(tip), drape({ x: tip.x - a.dx * 5 - bx * 3, y: tip.y - a.dy * 5 - by * 3 })]);
    }
    return segs;
  }, [drainage.flowArrows, drape]);

  const paths = useMemo(
    () => drainage.flowPaths.map(fp => fp.pts.map(p => drape(p))),
    [drainage.flowPaths, drape]
  );
  const swales = useMemo(
    () => drainage.swales.map(s => s.pts.map(p => drape(p))),
    [drainage.swales, drape]
  );

  return (
    <group>
      {arrows.map((s, i) => (
        <Line key={`fa-${i}`} points={s} color={FLOW_COLOR} lineWidth={1.5} transparent opacity={0.75} />
      ))}
      {paths.map((p, i) => (
        <Line key={`fp-${i}`} points={p} color={FLOW_COLOR} lineWidth={2.5} transparent opacity={0.9} />
      ))}
      {swales.map((p, i) => (
        <Line
          key={`sw-${i}`}
          points={p}
          color={SWALE_COLOR}
          lineWidth={3}
          dashed
          dashSize={10}
          gapSize={6}
          transparent
          opacity={0.95}
        />
      ))}
      {drainage.ponding.map((p, i) => (
        <group key={`pond-${i}`}>
          <mesh position={drape({ x: p.x, y: p.y }, DRAINAGE_LIFT + 0.2)} rotation={[-Math.PI / 2, 0, 0]}>
            <ringGeometry args={[6, 9, 24]} />
            <meshBasicMaterial color={POND_COLOR} transparent opacity={0.85} side={THREE.DoubleSide} depthWrite={false} />
          </mesh>
          <Text
            position={drape({ x: p.x, y: p.y }, DRAINAGE_LIFT + 1)}
            rotation={[-Math.PI / 2, 0, 0]}
            fontSize={10}
            color={POND_COLOR}
            anchorX="center"
            anchorY="middle"
            outlineWidth={1}
            outlineColor="#ffffff"
          >
            {p.onPad ? 'PONDING (PAD)' : 'PONDING'}
          </Text>
        </group>
      ))}
      {drainage.discharges.map((d, i) => (
        <group key={`dp-${i}`}>
          <mesh position={drape(d.p, DRAINAGE_LIFT + 0.2)} rotation={[-Math.PI / 2, 0, 0]}>
            <circleGeometry args={[7, 24]} />
            <meshBasicMaterial color={DISCHARGE_COLOR} transparent opacity={0.85} side={THREE.DoubleSide} depthWrite={false} />
          </mesh>
          <Text
            position={drape(d.p, DRAINAGE_LIFT + 1)}
            rotation={[-Math.PI / 2, 0, 0]}
            fontSize={10}
            color={DISCHARGE_COLOR}
            anchorX="center"
            anchorY="middle"
            outlineWidth={1}
            outlineColor="#ffffff"
          >
            {`DP-${i + 1}  ${d.qCfs.toFixed(1)} CFS`}
          </Text>
        </group>
      ))}
    </group>
  );
}

export function TerrainMesh({ grid, origin, fence, padElevationFt, satellite, showSlope, maxGradePct, showContours, contourIntervalFt, showGradingLimits, gradingSlopeRatio, showProposedContours = false, showCutFill = false, yardRotationDeg = 0, yardPivot, fg = null, drainage = null }: {
  grid: ElevationGrid;
  origin: { lat: number; lon: number };
  fence: Pt[];
  // Grading-optimized yard rotation (deg) + pivot: only used to keep the
  // geo-registered satellite mosaic aligned on the rotated relief.
  yardRotationDeg?: number;
  yardPivot?: Pt;
  padElevationFt: number;
  satellite: SatelliteImage | null;
  showSlope: boolean;
  maxGradePct: number;
  showContours: boolean;
  contourIntervalFt: number; // 0 = auto
  showGradingLimits: boolean;
  gradingSlopeRatio: number; // horizontal : vertical daylight slope
  // Proposed FG contours + daylight limit overlay (opt-in; only rendered
  // when fg is supplied). Preview only — never affects exports.
  showProposedContours?: boolean;
  // Cut/fill isopach drape (opt-in, requires fg): colors the rendered
  // surface by the same 4 depth bands the GP-1 shading export uses.
  // Preview only — never affects exports.
  showCutFill?: boolean;
  // Proposed grading surface (opt-in): when present, the rendered ground is
  // the FG surface (sloped/benched pads + daylight slopes) instead of the
  // flat pad. Preview only — never affects layout math or exports.
  fg?: FgSurface | null;
  // Drainage screening (opt-in, requires fg): flow arrows, ponding markers,
  // swale toe lines and discharge points. Preview only — never in exports.
  drainage?: DrainageModel | null;
}) {
  const rect = useMemo(() => terrainLocalRect(grid, origin), [grid, origin]);
  const geometry = useDisposable(
    useMemo(() => buildTerrainGeometry({ grid, rect, fence, padElevationFt, fg }), [grid, rect, fence, padElevationFt, fg])
  );
  useMemo(() => {
    if (satellite) applySatelliteUvs(geometry, rect, satelliteLocalRect(satellite, origin), yardRotationDeg, yardPivot);
  }, [geometry, satellite, rect, origin, yardRotationDeg, yardPivot]);

  // Slope heatmap: same displaced surface, vertex-colored by grade percent
  // (green -> yellow -> red, saturating at 2x the threshold), floating just
  // above the terrain. Separate geometry so toggling is instant + disposable.
  const slopeGrid = useMemo(() => (showSlope ? computeSlopeGrid(grid, rect) : null), [showSlope, grid, rect]);
  const slopeGeometry = useDisposable(
    useMemo(() => {
      if (!slopeGrid) return new THREE.BufferGeometry();
      const g = geometry.clone();
      const pos = g.getAttribute('position') as THREE.BufferAttribute;
      const colors = new Float32Array(pos.count * 3);
      const rampMax = maxGradePct * 2;
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i);
        const y = -pos.getZ(i);
        const s = sampleSlopePct(slopeGrid, rect, x, y);
        const [cr, cg, cb] = slopeRampColor(s, rampMax);
        colors[i * 3] = cr;
        colors[i * 3 + 1] = cg;
        colors[i * 3 + 2] = cb;
        pos.setY(i, pos.getY(i) + 0.35); // float above the terrain surface
      }
      g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      return g;
    }, [slopeGrid, geometry, rect, maxGradePct])
  );

  // Cut/fill isopach drape: same displaced surface, RGBA vertex colors from
  // the shared band classifier (cutFillBandIndexAt) so the preview always
  // matches the GP-1 shading export bands. Alpha 0 where depth is negligible.
  const cutFillOn = Boolean(showCutFill && fg);
  const cutFillGeometry = useDisposable(
    useMemo(() => {
      if (!cutFillOn || !fg) return new THREE.BufferGeometry();
      const g = geometry.clone();
      const pos = g.getAttribute('position') as THREE.BufferAttribute;
      const colors = new Float32Array(pos.count * 4);
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i);
        const y = -pos.getZ(i);
        const b = cutFillBandIndexAt(grid, rect, fg, x, y);
        if (b >= 0) {
          const [cr, cg, cb] = CUT_FILL_PREVIEW_COLORS[b];
          colors[i * 4] = cr;
          colors[i * 4 + 1] = cg;
          colors[i * 4 + 2] = cb;
          colors[i * 4 + 3] = 1;
        }
        pos.setY(i, pos.getY(i) + 0.5); // float above terrain + slope heatmap
      }
      g.setAttribute('color', new THREE.BufferAttribute(colors, 4));
      return g;
    }, [cutFillOn, fg, geometry, grid, rect])
  );

  return (
    <group>
      <mesh geometry={geometry} receiveShadow>
        {satellite ? <SatelliteTerrainMaterial image={satellite} /> : <DirtTerrainMaterial rect={rect} />}
      </mesh>
      {showSlope && slopeGrid && (
        <mesh geometry={slopeGeometry}>
          <meshBasicMaterial vertexColors transparent opacity={0.55} depthWrite={false} side={THREE.DoubleSide} />
        </mesh>
      )}
      {cutFillOn && (
        <mesh geometry={cutFillGeometry}>
          <meshBasicMaterial vertexColors transparent opacity={0.55} depthWrite={false} side={THREE.DoubleSide} />
        </mesh>
      )}
      {showContours && (
        <ContourOverlay
          grid={grid}
          rect={rect}
          fence={fence}
          padElevationFt={padElevationFt}
          intervalFt={contourIntervalFt}
          fg={fg}
        />
      )}
      {showGradingLimits && (
        <GradingLimitsOverlay
          grid={grid}
          rect={rect}
          fence={fence}
          padElevationFt={padElevationFt}
          slopeRatio={gradingSlopeRatio}
          fg={fg}
        />
      )}
      {showProposedContours && fg && (
        <ProposedContourOverlay
          grid={grid}
          rect={rect}
          fence={fence}
          padElevationFt={padElevationFt}
          intervalFt={contourIntervalFt}
          fg={fg}
        />
      )}
      {drainage && (
        <DrainageOverlay
          grid={grid}
          rect={rect}
          fence={fence}
          padElevationFt={padElevationFt}
          drainage={drainage}
          fg={fg}
        />
      )}
    </group>
  );
}
