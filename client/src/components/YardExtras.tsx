import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useGLTF, useTexture } from '@react-three/drei';
import { useFrame, useLoader } from '@react-three/fiber';
import { FBXLoader } from 'three-stdlib';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import * as THREE from 'three';
import { SiteDesign, IslandInfo, PlacedEquipment } from '../lib/nextera/types';
import { assetUrl } from '../lib/assetUrl';
import {
  feederTrenchSubSegments,
  sharpJointPatches,
  FEEDER_TRENCH_W_FT,
  FEEDER_SUB_MIN_LEN_FT,
  type FeederLike,
  type PatchClipBounds,
} from '../lib/nextera/feederTrenchGeom';
import { feederColor } from '../lib/nextera/feederColors';
import { useDesignStore } from '../lib/stores/useDesignStore';

// 3D-preview-only yard extras: recessed trench channel with real cable
// conductors, the uploaded gate 3D model, and textured fence panels.
// None of this touches layout math or the DXF/PDF display-list path.

export const TRENCH_DEPTH_FT = 3;

const GATE_MODEL_URL = assetUrl('/models/gate_fence.glb');
const FENCE_MODEL_URL = assetUrl('/models/wire_fence.fbx');
const FENCE_TEX = {
  map: assetUrl('/textures/fence/fence_basecolor.png'),
  normalMap: assetUrl('/textures/fence/fence_normal.jpg'),
  roughnessMap: assetUrl('/textures/fence/fence_roughness.jpg'),
};

const FENCE_HEIGHT_FT = 8;
const FENCE_PANEL_FT = 10; // texture tile width in feet

// Cable colors matching the preview legend (Sheets 3-4)
const TRENCH_CONDUCTORS: { color: string; dx: number; depth: number; r: number }[] = [
  { color: '#1f3fbf', dx: -0.9, depth: 2.45, r: 0.22 }, // LVAC run A
  { color: '#1f3fbf', dx: -0.3, depth: 2.45, r: 0.22 }, // LVAC run B
  { color: '#f39c12', dx: 0.5, depth: 2.2, r: 0.12 },  // fiber
  { color: '#f39c12', dx: 0.85, depth: 2.2, r: 0.12 }, // fiber spare
];

// Open excavated channel for the 480V aux + fiber trench: earthen side
// walls + bottom sunk TRENCH_DEPTH_FT below grade, with round cable
// conductors lying near the bottom. The translucent blue surface band
// (drawn by DesignScene) is kept, so the plan-view color coding is intact.
export function TrenchChannel({ trench }: { trench: NonNullable<SiteDesign['trench']> }) {
  const len = trench.yTop - trench.yBottom;
  const zMid = -(trench.yBottom + trench.yTop) / 2;
  const hw = trench.width / 2;
  const d = TRENCH_DEPTH_FT;
  if (len <= 0) return null;
  return (
    <group>
      {/* bottom of the excavation */}
      <mesh position={[trench.x, -d, zMid]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[trench.width, len]} />
        <meshStandardMaterial color="#4a3c28" side={THREE.DoubleSide} />
      </mesh>
      {/* side walls (long, along the run) */}
      {[-hw, hw].map(dx => (
        <mesh key={`w${dx}`} position={[trench.x + dx, -d / 2, zMid]} rotation={[0, Math.PI / 2, 0]}>
          <planeGeometry args={[len, d]} />
          <meshStandardMaterial color="#5c4a30" side={THREE.DoubleSide} />
        </mesh>
      ))}
      {/* end walls */}
      {[-(trench.yBottom), -(trench.yTop)].map(z => (
        <mesh key={`e${z}`} position={[trench.x, -d / 2, z]}>
          <planeGeometry args={[trench.width, d]} />
          <meshStandardMaterial color="#5c4a30" side={THREE.DoubleSide} />
        </mesh>
      ))}
      {/* cable conductors lying in the trench (LVAC deep blue, fiber orange) */}
      {TRENCH_CONDUCTORS.map((c, i) => (
        <mesh key={`c${i}`} position={[trench.x + c.dx, -c.depth, zMid]} rotation={[Math.PI / 2, 0, 0]}>
          <cylinderGeometry args={[c.r, c.r, len - 0.5, 10]} />
          <meshStandardMaterial color={c.color} roughness={0.55} />
        </mesh>
      ))}
    </group>
  );
}

// Clipping planes for the vertical trench band in scene space.
// Scene mapping: plan (x, y) -> scene (x, elev, -y).
export function trenchClipPlanes(trench: NonNullable<SiteDesign['trench']>): {
  inside: THREE.Plane[];
  outside: THREE.Plane[];
} {
  const x0 = trench.x - trench.width / 2;
  const x1 = trench.x + trench.width / 2;
  // z range of the band: [-yTop, -yBottom]
  const inside = [
    new THREE.Plane(new THREE.Vector3(1, 0, 0), -x0),
    new THREE.Plane(new THREE.Vector3(-1, 0, 0), x1),
    new THREE.Plane(new THREE.Vector3(0, 0, 1), trench.yTop),
    new THREE.Plane(new THREE.Vector3(0, 0, -1), -trench.yBottom),
  ];
  // Used with material.clipIntersection = true: a fragment is clipped only
  // when it is behind ALL planes, i.e. strictly inside the band.
  const outside = [
    new THREE.Plane(new THREE.Vector3(-1, 0, 0), x0),
    new THREE.Plane(new THREE.Vector3(1, 0, 0), -x1),
    new THREE.Plane(new THREE.Vector3(0, 0, -1), -trench.yTop),
    new THREE.Plane(new THREE.Vector3(0, 0, 1), trench.yBottom),
  ];
  return { inside, outside };
}

// Bake a GLTF scene to a single normalized geometry list: world transforms
// applied, centered at origin, unit-cube extents, long horizontal axis on +x.
function useNormalizedModel(url: string): { geoms: THREE.BufferGeometry[]; size: THREE.Vector3 } {
  const { scene } = useGLTF(url);
  return useMemo(() => {
    scene.updateWorldMatrix(true, true);
    const geoms: THREE.BufferGeometry[] = [];
    scene.traverse(obj => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh || !mesh.geometry) return;
      const g = mesh.geometry.clone();
      // Quantized models (KHR_mesh_quantization / meshopt) store positions
      // and normals as normalized integers. applyMatrix4 would write the
      // transformed floats back into the integer array, clamping to [-1, 1]
      // and destroying the shape — de-quantize to plain Float32 first.
      for (const name of ['position', 'normal'] as const) {
        const attr = g.getAttribute(name);
        if (!attr || (!attr.normalized && attr.array instanceof Float32Array)) continue;
        const out = new Float32Array(attr.count * attr.itemSize);
        for (let i = 0; i < attr.count; i++) {
          out[i * attr.itemSize] = attr.getX(i);
          if (attr.itemSize > 1) out[i * attr.itemSize + 1] = attr.getY(i);
          if (attr.itemSize > 2) out[i * attr.itemSize + 2] = attr.getZ(i);
        }
        g.setAttribute(name, new THREE.BufferAttribute(out, attr.itemSize));
      }
      g.applyMatrix4(mesh.matrixWorld);
      geoms.push(g);
    });
    const box = new THREE.Box3();
    for (const g of geoms) {
      g.computeBoundingBox();
      if (g.boundingBox) box.union(g.boundingBox);
    }
    const size = new THREE.Vector3();
    const center = new THREE.Vector3();
    box.getSize(size);
    box.getCenter(center);
    const rotate = size.z > size.x;
    const norm = new THREE.Matrix4()
      .makeScale(
        1 / Math.max(rotate ? size.z : size.x, 1e-6),
        1 / Math.max(size.y, 1e-6),
        1 / Math.max(rotate ? size.x : size.z, 1e-6)
      )
      .multiply(new THREE.Matrix4().makeRotationY(rotate ? Math.PI / 2 : 0))
      .multiply(new THREE.Matrix4().makeTranslation(-center.x, -center.y, -center.z));
    for (const g of geoms) g.applyMatrix4(norm);
    const outSize = rotate ? new THREE.Vector3(size.z, size.y, size.x) : size.clone();
    return { geoms, size: outSize };
  }, [scene]);
}

// Uploaded gate 3D model placed across the fence entrance opening, scaled so
// its width spans the gate opening. Display-only; the DXF gate line and the
// simple yellow bar are unchanged when this option is off.
export function GateModel({ gate, open = false }: { gate: NonNullable<SiteDesign['gate']>; open?: boolean }) {
  const { geoms, size } = useNormalizedModel(GATE_MODEL_URL);
  // Swing-open animation for the first-person walkthrough: the whole gate
  // leaf rotates about a hinge at one end of the opening. The pivot lives in
  // the UNSCALED local frame (rotating inside a non-uniform scale would skew
  // the geometry); the model scale is applied inside the pivot.
  const hinge = useRef<THREE.Group>(null);
  const angle = useRef(0);
  useFrame((st, delta) => {
    const target = open ? -Math.PI * 0.55 : 0; // ~100° inward swing
    const a = angle.current;
    if (Math.abs(target - a) < 1e-4) return; // settled: no per-frame work
    const next = a + (target - a) * Math.min(1, delta * 3.2); // eased chase
    angle.current = next;
    if (hinge.current) hinge.current.rotation.y = next;
    st.invalidate(); // demand frameloop: keep the swing animating
  });
  // Preserve the model's own proportions: uniform scale from opening width,
  // capped to a sensible fence-scale height.
  const scale = useMemo(() => {
    const aspectH = size.x > 1e-6 ? size.y / size.x : 0.3;
    const h = Math.min(gate.width * aspectH, 12);
    const w = gate.width;
    const dRatio = size.x > 1e-6 ? size.z / size.x : 0.05;
    return new THREE.Vector3(w, aspectH > 1e-6 ? h : 8, Math.max(w * dRatio, 0.5));
  }, [gate.width, size]);
  // Plan->scene yaw: scene rotation.y = th maps local +X to plan direction
  // (cos th, sin th) because scene z = -plan y. The gate width axis must
  // follow the fence segment direction gate.rotation, so yaw is
  // +gate.rotation (NOT negated — a negated yaw mirrors the direction and
  // skews the gate across any non-axis-aligned fence segment). Same
  // convention as the 2D yellow bar ([-PI/2, 0, +gate.rotation]) and the
  // feeder trench segments (rotation.y = -atan2(-dy, dx) = +atan2(dy, dx)).
  return (
    <group position={[gate.x, scale.y / 2, -gate.y]} rotation={[0, gate.rotation, 0]}>
      {/* hinge at one end of the opening, in the unscaled local frame */}
      <group ref={hinge} position={[-gate.width / 2, 0, 0]}>
        <group position={[gate.width / 2, 0, 0]} scale={scale}>
          {geoms.map((g, i) => (
            <mesh key={i} geometry={g} castShadow receiveShadow>
              {/* bright galvanized finish + warm emissive so the gate reads
                  clearly against the dark chain-link fence around it */}
              <meshStandardMaterial
                color="#d3dde3"
                metalness={0.55}
                roughness={0.35}
                emissive="#ffb300"
                emissiveIntensity={0.28}
              />
            </mesh>
          ))}
        </group>
      </group>
      {/* translucent safety-yellow halo panel marking the entrance opening —
          hidden while the gate is swung open for the walkthrough */}
      {!open && (
        <mesh scale={scale}>
          <boxGeometry args={[1.04, 1.06, 1.5]} />
          <meshStandardMaterial
            color="#ffcc00"
            emissive="#ffcc00"
            emissiveIntensity={0.5}
            transparent
            opacity={0.14}
            depthWrite={false}
          />
        </mesh>
      )}
    </group>
  );
}

// ---------------------------------------------------------------------------
// MV feeder trench channels (feeder circuits to the substation): the same
// 3-ft-deep excavated-channel effect as the aux trench, but along the
// routed feeder polylines. Because feeders are many disjoint bands, the
// ground/road/surfacing openings are cut with a stencil mask instead of
// clipping planes (which can only express one convex region per material).
export { FEEDER_TRENCH_W_FT } from '../lib/nextera/feederTrenchGeom';
export const FEEDER_STENCIL_REF = 2;
const FEEDER_COLOR = '#e91e63';

// Spread onto ground-level opaque materials: fragments where the feeder
// opening mask wrote FEEDER_STENCIL_REF are discarded (NotEqual test).
// Harmless when no mask is drawn (buffer stays 0, test always passes).
export const feederCutStencil = {
  stencilWrite: true,
  stencilRef: FEEDER_STENCIL_REF,
  stencilFunc: THREE.NotEqualStencilFunc,
  stencilWriteMask: 0,
} as const;

export function FeederTrenchChannels({ feeders, patchBounds }: { feeders: FeederLike[]; patchBounds?: PatchClipBounds }) {
  // Flatten every feeder segment polyline into straight sub-segments
  // (pure decomposition shared with the regression suite); patchBounds keeps
  // hairpin miter patches from poking outside the fence / into equipment.
  const subs = useMemo(() => feederTrenchSubSegments(feeders, patchBounds), [feeders, patchBounds]);
  const showFeederColors = useDesignStore(s => s.showFeederColors);
  // MV feeder conductor tinted with the owning feeder's palette color
  // (fallback: neutral magenta).
  const items = useMemo<TrenchSub[]>(
    () => subs.map(s => ({
      cx: s.cx, cz: s.cz, ang: s.ang, len: s.len,
      color: showFeederColors && s.idx !== undefined ? feederColor(s.idx).hex : FEEDER_COLOR,
    })),
    [subs, showFeederColors]
  );
  if (items.length === 0) return null;
  return <InstancedTrenchChannels items={items} w={FEEDER_TRENCH_W_FT} condRadius={0.3} condDrop={0.55} condSegs={10} />;
}

// ---------------------------------------------------------------------------
// Instanced trench channel renderer shared by the MV feeder and LV/DC/fiber
// cable trenches. Visually identical to the old one-mesh-per-part version
// (same planes, cylinder conductor, stencil mask semantics) but each part
// class renders as ONE InstancedMesh, collapsing thousands of draw calls on
// large sites into a handful. Preview only — never in exports.
type TrenchSub = { cx: number; cz: number; ang: number; len: number; color: string };

// Shared unit geometries, scaled per instance via the matrix. Cylinders use
// unit radius/height: matrix scale (r, len, r) preserves the round profile.
const UNIT_PLANE = new THREE.PlaneGeometry(1, 1);
const UNIT_CYL_10 = new THREE.CylinderGeometry(1, 1, 1, 10);
const UNIT_CYL_8 = new THREE.CylinderGeometry(1, 1, 1, 8);
const QUAT_IDENT = new THREE.Quaternion();
const QUAT_XNEG90 = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
const QUAT_Y90 = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
const QUAT_Z90 = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);

function InstancedTrenchChannels({ items, w, condRadius, condDrop, condSegs, joinOverhang = true }: {
  items: TrenchSub[];
  w: number;          // trench width (ft)
  condRadius: number; // conductor radius (ft)
  condDrop: number;   // conductor height above the excavation bottom (ft)
  condSegs: 8 | 10;   // conductor radial segments (parity with the old meshes)
  // Feeder digs run overlong by one trench width so L-corners join cleanly.
  // Cable digs (Direct DC especially) must stop exactly on CableRun.pts so the
  // excavation follows the wires into the compartment landings.
  joinOverhang?: boolean;
}) {
  const d = TRENCH_DEPTH_FT;
  const built = useMemo(() => {
    const p = new THREE.Vector3();
    const sc = new THREE.Vector3();
    const base = new THREE.Matrix4();
    const local = new THREE.Matrix4();
    const stencil: THREE.Matrix4[] = [];
    const bottom: THREE.Matrix4[] = [];
    const walls: THREE.Matrix4[] = [];
    const condByColor = new Map<string, THREE.Matrix4[]>();
    for (const s of items) {
      // Three's +Y rotation maps local +X toward scene -Z, exactly matching
      // the plan (x,y) -> scene (x,-y) projection for a plan-frame angle.
      base.makeRotationY(s.ang).setPosition(s.cx, 0, s.cz);
      const L = joinOverhang ? s.len + w : s.len;
      const push = (arr: THREE.Matrix4[], px: number, py: number, pz: number, q: THREE.Quaternion, sx: number, sy: number, sz: number) => {
        local.compose(p.set(px, py, pz), q, sc.set(sx, sy, sz));
        arr.push(new THREE.Matrix4().multiplyMatrices(base, local));
      };
      // stencil mask opening (flat, just above grade)
      push(stencil, 0, 0.45, 0, QUAT_XNEG90, L, w, 1);
      // excavation bottom
      push(bottom, 0, -d, 0, QUAT_XNEG90, L, w, 1);
      // side walls + end caps (same material class)
      push(walls, 0, -d / 2, -w / 2, QUAT_IDENT, L, d, 1);
      push(walls, 0, -d / 2, w / 2, QUAT_IDENT, L, d, 1);
      push(walls, -L / 2, -d / 2, 0, QUAT_Y90, w, d, 1);
      push(walls, L / 2, -d / 2, 0, QUAT_Y90, w, d, 1);
      // conductor lying near the bottom (unit cylinder: axis = local Y,
      // rotated to run along the trench; scale keeps the radius round)
      const arr = condByColor.get(s.color) ?? [];
      local.compose(p.set(0, -(d - condDrop), 0), QUAT_Z90, sc.set(condRadius, Math.max(L - 0.4, 0.5), condRadius));
      arr.push(new THREE.Matrix4().multiplyMatrices(base, local));
      condByColor.set(s.color, arr);
    }
    return { stencil, bottom, walls, cond: Array.from(condByColor, ([color, mats]) => ({ color, mats })) };
  }, [items, w, condRadius, condDrop, d, joinOverhang]);
  return (
    <group>
      {/* stencil mask: punches the openings out of ground/roads/surfacing.
          Rendered first (renderOrder -5), writes stencil only. */}
      <TrenchInstances mats={built.stencil} renderOrder={-5}>
        <meshBasicMaterial
          colorWrite={false}
          depthWrite={false}
          stencilWrite
          stencilRef={FEEDER_STENCIL_REF}
          stencilFunc={THREE.AlwaysStencilFunc}
          stencilZPass={THREE.ReplaceStencilOp}
        />
      </TrenchInstances>
      {/* excavation bottoms */}
      <TrenchInstances mats={built.bottom}>
        <meshStandardMaterial color="#4a3c28" side={THREE.DoubleSide} />
      </TrenchInstances>
      {/* side walls + end caps */}
      <TrenchInstances mats={built.walls}>
        <meshStandardMaterial color="#5c4a30" side={THREE.DoubleSide} />
      </TrenchInstances>
      {/* conductors, one InstancedMesh per palette color so the emissive
          tint matches the old per-mesh materials exactly */}
      {built.cond.map(c => (
        <TrenchInstances key={c.color} mats={c.mats} geometry={condSegs === 10 ? UNIT_CYL_10 : UNIT_CYL_8}>
          <meshStandardMaterial color={c.color} emissive={c.color} emissiveIntensity={0.25} roughness={0.5} />
        </TrenchInstances>
      ))}
    </group>
  );
}

// One InstancedMesh per part class. Remounts when the instance count
// changes (count is fixed at construction); matrix refills are in-place.
// frustumCulled=false: instances span the whole yard, and per-instance
// culling is not worth the bounding-sphere churn for flat planes.
function TrenchInstances({ mats, geometry = UNIT_PLANE, renderOrder, children }: {
  mats: THREE.Matrix4[];
  geometry?: THREE.BufferGeometry;
  renderOrder?: number;
  children: React.ReactNode;
}) {
  const ref = useRef<THREE.InstancedMesh>(null);
  // useLayoutEffect (not useEffect): matrices must land before the frame
  // paints, or a remount shows one frame of identity-matrix instances.
  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    for (let i = 0; i < mats.length; i++) mesh.setMatrixAt(i, mats[i]);
    mesh.instanceMatrix.needsUpdate = true;
  }, [mats]);
  if (mats.length === 0) return null;
  return (
    <instancedMesh
      key={`n${mats.length}`}
      ref={ref}
      args={[undefined, undefined, mats.length]}
      geometry={geometry}
      renderOrder={renderOrder}
      frustumCulled={false}
    >
      {children}
    </instancedMesh>
  );
}

// ---------------------------------------------------------------------------
// LV/DC/fiber cable trench channels: the same excavated-channel treatment as
// the MV feeder trenches, but along the yard cable runs (DC harness, LVAC
// station power, fiber comms). Narrower than a feeder trench, one smaller
// conductor tinted with the run's plan color. Openings share the feeder
// stencil ref, so the existing ground/road/surfacing cutouts apply unchanged.
const CABLE_TRENCH_W_FT = 1.5;

export type CableRunLike = {
  id: string;
  pts: { x: number; y: number }[];
  class: string;
  ref?: boolean;
  polarity?: 'pos' | 'neg';
};

export function CableTrenchChannels({
  runs, colors, patchBounds,
}: {
  runs: CableRunLike[];
  colors: Record<string, string>;
  patchBounds?: PatchClipBounds;
}) {
  // Follow CableRun.pts exactly at open terminals (Direct DC landings), but
  // keep half-width overhang only toward interior L-joints so orthogonal
  // LVAC/DC elbows still join. joinOverhang=false below — length already
  // includes any joint overhang baked into each item.
  const items = useMemo<TrenchSub[]>(() => {
    const solid = runs.filter(r => !r.ref && r.pts.length >= 2);
    const half = CABLE_TRENCH_W_FT / 2;
    const out: TrenchSub[] = [];
    for (const r of solid) {
      const cls = r.class === 'DC' && r.polarity
        ? (r.polarity === 'pos' ? 'DC+' : 'DC-')
        : r.class;
      const color = colors[cls] ?? '#22c55e';
      const pts = r.pts;
      const nSeg = pts.length - 1;
      for (let i = 0; i < nSeg; i++) {
        const a = pts[i];
        const b = pts[i + 1];
        const len = Math.hypot(b.x - a.x, b.y - a.y);
        if (!Number.isFinite(len) || len < FEEDER_SUB_MIN_LEN_FT) continue;
        // Direct (1 segment): no overhang. Multi-leg: overhang only at joints.
        const ha = i > 0 ? half : 0;
        const hb = i < nSeg - 1 ? half : 0;
        const ux = (b.x - a.x) / len;
        const uy = (b.y - a.y) / len;
        const L = len + ha + hb;
        const midX = (a.x + b.x) / 2 + ux * (hb - ha) / 2;
        const midY = (a.y + b.y) / 2 + uy * (hb - ha) / 2;
        out.push({
          cx: midX,
          cz: -midY,
          len: L,
          // Plan bearing — see feederTrenchGeom.toSub (must not use -dy).
          ang: Math.atan2(b.y - a.y, b.x - a.x),
          color,
        });
      }
      if (pts.length > 2) {
        for (const p of sharpJointPatches(pts, patchBounds)) {
          const len = Math.hypot(p.b.x - p.a.x, p.b.y - p.a.y);
          if (!Number.isFinite(len) || len < FEEDER_SUB_MIN_LEN_FT - 1e-9) continue;
          out.push({
            cx: (p.a.x + p.b.x) / 2,
            cz: -(p.a.y + p.b.y) / 2,
            len,
            ang: Math.atan2(p.b.y - p.a.y, p.b.x - p.a.x),
            color,
          });
        }
      }
    }
    return out;
  }, [runs, colors, patchBounds]);
  if (items.length === 0) return null;
  return (
    <InstancedTrenchChannels
      items={items}
      w={CABLE_TRENCH_W_FT}
      condRadius={0.15}
      condDrop={0.4}
      condSegs={8}
      joinOverhang={false}
    />
  );
}

// 1x1 transparent GIF: the uploaded fence FBX references its source texture
// files by name; we redirect those requests to this stub (materials from the
// FBX are discarded — the real PBR maps are applied by our own material).
const BLANK_IMG = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';

// Load the uploaded wire-fence FBX model, bake world transforms into a single
// merged geometry (the atlas UVs are preserved), normalized so the module's
// base sits at y=0, centered in x/z, scaled to FENCE_HEIGHT_FT tall. Returns
// the merged geometry plus the module width in feet at that height.
function useFenceModule(): { geom: THREE.BufferGeometry; moduleW: number } {
  const group = useLoader(FBXLoader, FENCE_MODEL_URL, loader => {
    const mgr = new THREE.LoadingManager();
    mgr.setURLModifier(url =>
      /\.(png|jpe?g|tga|tif+)($|\?)/i.test(url) ? BLANK_IMG : url
    );
    loader.manager = mgr;
  });
  const built = useMemo(() => {
    group.updateWorldMatrix(true, true);
    const geoms: THREE.BufferGeometry[] = [];
    group.traverse(obj => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh || !mesh.geometry) return;
      const g = mesh.geometry.clone();
      g.applyMatrix4(mesh.matrixWorld);
      // drop everything but position/normal/uv so the geometries merge
      const keep = ['position', 'normal', 'uv'];
      for (const name of Object.keys(g.attributes)) {
        if (!keep.includes(name)) g.deleteAttribute(name);
      }
      geoms.push(g.toNonIndexed());
    });
    const merged = mergeGeometries(geoms, false)!;
    geoms.forEach(g => g.dispose());
    merged.computeBoundingBox();
    const bb = merged.boundingBox!;
    const size = new THREE.Vector3();
    bb.getSize(size);
    // long horizontal axis to x (FBX module is already x-long, but be safe)
    if (size.z > size.x) {
      merged.applyMatrix4(new THREE.Matrix4().makeRotationY(Math.PI / 2));
      merged.computeBoundingBox();
      bb.copy(merged.boundingBox!);
      bb.getSize(size);
    }
    const s = FENCE_HEIGHT_FT / Math.max(size.y, 1e-6);
    const center = new THREE.Vector3();
    bb.getCenter(center);
    merged.applyMatrix4(
      new THREE.Matrix4()
        .makeScale(s, s, s)
        .multiply(new THREE.Matrix4().makeTranslation(-center.x, -bb.min.y, -center.z))
    );
    merged.computeBoundingBox();
    return { geom: merged, moduleW: size.x * s };
  }, [group]);
  // Dispose the merged geometry when the fence option is toggled off /
  // component unmounts (the cached FBX source group is left to useLoader).
  useEffect(() => {
    return () => built.geom.dispose();
  }, [built]);
  return built;
}

// Real 3D fence along the fence polyline: the uploaded wire-fence model
// (posts + chain-link mesh, UV-mapped to its texture atlas) is instanced
// module-by-module along every segment via a single InstancedMesh — one
// draw call for the whole perimeter.
export function FencePanels({
  fence,
  gate,
}: {
  fence: { x: number; y: number }[];
  gate?: { x: number; y: number; width: number } | null;
}) {
  const maps = useTexture(FENCE_TEX);
  const { geom, moduleW } = useFenceModule();
  const textures = useMemo(() => {
    const clone = (t: THREE.Texture, srgb: boolean) => {
      const c = t.clone();
      if (srgb) c.colorSpace = THREE.SRGBColorSpace;
      c.anisotropy = 8;
      c.needsUpdate = true;
      return c;
    };
    return {
      map: clone(maps.map, true),
      normalMap: clone(maps.normalMap, false),
      roughnessMap: clone(maps.roughnessMap, false),
    };
  }, [maps]);
  useEffect(() => {
    return () => {
      textures.map.dispose();
      textures.normalMap.dispose();
      textures.roughnessMap.dispose();
    };
  }, [textures]);
  // Per-module instance transforms: each fence segment gets ceil(len/moduleW)
  // modules, stretched uniformly in x so they fill the segment exactly.
  const instances = useMemo(() => {
    const mats: THREE.Matrix4[] = [];
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const scl = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    for (let i = 0; i < fence.length; i++) {
      const p = fence[i];
      const q = fence[(i + 1) % fence.length];
      const len = Math.hypot(q.x - p.x, q.y - p.y);
      if (len < 0.5) continue;
      const n = Math.max(1, Math.round(len / moduleW));
      const w = len / n; // exact module width for this segment
      const ang = Math.atan2(-(q.y - p.y), q.x - p.x);
      quat.setFromAxisAngle(up, -ang);
      scl.set(w / moduleW, 1, 1);
      const ux = (q.x - p.x) / len;
      const uy = (q.y - p.y) / len;
      // Leave the fence open across the gate: if the gate sits on this
      // segment, skip every module that overlaps the gate opening span.
      let gapLo = Infinity;
      let gapHi = -Infinity;
      if (gate) {
        const tGate = (gate.x - p.x) * ux + (gate.y - p.y) * uy;
        if (tGate > -1 && tGate < len + 1) {
          const px = p.x + ux * tGate - gate.x;
          const py = p.y + uy * tGate - gate.y;
          if (Math.hypot(px, py) < 3) {
            gapLo = tGate - gate.width / 2;
            gapHi = tGate + gate.width / 2;
          }
        }
      }
      for (let k = 0; k < n; k++) {
        const t = (k + 0.5) * w;
        if (t + w / 2 > gapLo && t - w / 2 < gapHi) continue; // module in gate opening
        pos.set(p.x + ux * t, 0, -(p.y + uy * t));
        mats.push(new THREE.Matrix4().compose(pos, quat, scl));
      }
    }
    return mats;
  }, [fence, gate, moduleW]);
  const meshRef = useRef<THREE.InstancedMesh>(null);
  useEffect(() => {
    const m = meshRef.current;
    if (!m) return;
    instances.forEach((mat, i) => m.setMatrixAt(i, mat));
    m.instanceMatrix.needsUpdate = true;
    m.computeBoundingSphere();
  }, [instances]);
  if (instances.length === 0) return null;
  return (
    <instancedMesh
      ref={meshRef}
      key={instances.length}
      args={[geom, undefined, instances.length]}
      castShadow
      frustumCulled={false}
    >
      <meshStandardMaterial
        map={textures.map}
        normalMap={textures.normalMap}
        roughnessMap={textures.roughnessMap}
        alphaTest={0.35}
        side={THREE.DoubleSide}
        metalness={0.25}
        roughness={0.7}
      />
    </instancedMesh>
  );
}

// ---------------------------------------------------------------------------
// Island alignment indicators: amber outline box around each island that has
// an "Island alignment available:" warning, so drafters can see WHICH island
// is off the shared column line before deciding whether to enable alignment.
// Rendered in the 3D (and flat) preview only — never in DXF or PDF.
// Disappears once `alignIslands: true` is set (warnings stop being emitted).

// Regex that matches the warning format emitted by the layout engine.
const ALIGN_AVAIL_RE = /^Island alignment available: island (\d+)\b/;

// Compute the axis-aligned bounding box in plan coordinates from all PCS
// inverters and BESS containers belonging to the island.  Equipment positions
// are already in world (plan) feet, so this works for horizontal and vertical
// placed islands without any axis-swap logic.  Returns null only when no
// matching equipment is found (graceful fallback below).
function islandEquipmentBounds(
  island: IslandInfo,
  equipment: PlacedEquipment[],
): { minX: number; maxX: number; minY: number; maxY: number } | null {
  // Collect the block numbers carried by this island's PCS inverter ids.
  const blockNs = new Set<number>();
  for (const id of island.inverterIds) {
    const m = id.match(/^inv-(\d+)$/);
    if (m) blockNs.add(Number(m[1]));
  }
  if (blockNs.size === 0) return null;

  let mnX = Infinity, mxX = -Infinity, mnY = Infinity, mxY = -Infinity;
  for (const eq of equipment) {
    // Match inv-N (PCS) and bess-N-K (BESS containers) for island blocks.
    const m = eq.id.match(/^(?:inv|bess)-(\d+)/);
    if (!m || !blockNs.has(Number(m[1]))) continue;
    // AABB half-extents accounting for equipment rotation (handles 0, ±π/2).
    const rot = eq.rotation;
    const hx = Math.abs(Math.cos(rot)) * eq.length / 2 + Math.abs(Math.sin(rot)) * eq.width / 2;
    const hy = Math.abs(Math.sin(rot)) * eq.length / 2 + Math.abs(Math.cos(rot)) * eq.width / 2;
    if (eq.x - hx < mnX) mnX = eq.x - hx;
    if (eq.x + hx > mxX) mxX = eq.x + hx;
    if (eq.y - hy < mnY) mnY = eq.y - hy;
    if (eq.y + hy > mxY) mxY = eq.y + hy;
  }
  return Number.isFinite(mnX) ? { minX: mnX, maxX: mxX, minY: mnY, maxY: mxY } : null;
}

function IslandAlignmentOutline({ island, equipment }: {
  island: IslandInfo;
  equipment: PlacedEquipment[];
}) {
  const { geo, cx, cz, sw, sd } = useMemo(() => {
    // Use the real equipment AABB so the outline encloses the full island
    // footprint (PCS + BESS blocks on both sides of the corridor), not just
    // the 10-ft aux-corridor strip.
    const bounds = islandEquipmentBounds(island, equipment);

    let planCx: number, planCy: number, sw: number, sd: number;
    if (bounds) {
      planCx = (bounds.minX + bounds.maxX) / 2;
      planCy = (bounds.minY + bounds.maxY) / 2;
      sw      = bounds.maxX - bounds.minX;
      sd      = bounds.maxY - bounds.minY;
    } else {
      // Graceful fallback: corridor centerline + strip length only.
      planCx = (island.minX + island.maxX) / 2;
      planCy = island.y;
      sw      = island.maxX - island.minX;
      sd      = 10; // AUX_CORRIDOR_FT
    }

    // Scene: plan(x, y) -> scene(x, elev, -y)
    const scx = planCx;
    const scz = -planCy;

    // Add a small clearance margin so the border sits just outside equipment.
    const MARGIN = 4; // ft
    const outW = sw + MARGIN;
    const outD = sd + MARGIN;
    const box  = new THREE.BoxGeometry(outW, 0.5, outD);
    const edges = new THREE.EdgesGeometry(box);
    box.dispose();
    return { geo: edges, cx: scx, cz: scz, sw: outW, sd: outD };
  }, [island, equipment]);

  useEffect(() => () => { geo.dispose(); }, [geo]);

  return (
    <group position={[cx, 0.6, cz]}>
      {/* Amber edge outline framing the full island footprint */}
      <lineSegments geometry={geo} renderOrder={12}>
        <lineBasicMaterial color="#f59e0b" toneMapped={false} />
      </lineSegments>
      {/* Semi-transparent amber fill so the island area reads at a glance */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.3, 0]} renderOrder={11}>
        <planeGeometry args={[sw, sd]} />
        <meshBasicMaterial
          color="#f59e0b"
          transparent
          opacity={0.07}
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>
    </group>
  );
}

/** Renders amber outlines around every island that has an "Island alignment
 *  available:" warning, so drafters can see which island is off the shared
 *  column line before deciding whether to enable alignment.
 *  Drop into the 3D scene alongside the corridor trench bands; gate with
 *  `!cad` at the call site. */
export function IslandAlignmentIndicators({ design }: { design: SiteDesign }) {
  // Collect island numbers mentioned in alignment-available warnings.
  const misalignedNs = useMemo(() => {
    const ns = new Set<number>();
    for (const w of design.warnings) {
      const m = ALIGN_AVAIL_RE.exec(w);
      if (m) ns.add(Number(m[1]));
    }
    return ns;
  }, [design.warnings]);

  const affected = useMemo(
    () => (design.islands ?? []).filter(isl => misalignedNs.has(isl.n)),
    [design.islands, misalignedNs],
  );

  if (affected.length === 0) return null;

  return (
    <>
      {affected.map(isl => (
        <IslandAlignmentOutline key={isl.n} island={isl} equipment={design.equipment} />
      ))}
    </>
  );
}

useGLTF.preload(GATE_MODEL_URL);
