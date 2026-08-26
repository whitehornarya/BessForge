import { useLayoutEffect, useMemo, useRef } from 'react';
import { useGLTF } from '@react-three/drei';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { PlacedEquipment } from '../lib/nextera/types';
import { getConfiguration } from '../lib/nextera/catalog';
import { assetUrl } from '../lib/assetUrl';
import { useDesignStore } from '../lib/stores/useDesignStore';
import { recoloredGeTexture, neutralizedGeMrTexture } from '../lib/pcsRecolor';
import { feederTintByInverterId } from '../lib/nextera/feederColors';
import { patchMaterialWithFeederTint, makeFeederTintAttribute } from '../lib/feederTint';

// Realistic manufacturer 3D models for the 3D preview toggle. Each uploaded
// model is normalized once (world transforms baked, centered at origin,
// scaled to a unit cube) so the same per-instance matrices as the simple
// boxes place it exactly on the catalog footprint: position (x, h/2, -y),
// yaw eq.rotation, scale (length, height, width). Layout math, clearance
// checks and DXF export are untouched — this is display-only.

export const MODEL_URLS = {
  bess: assetUrl('/models/lg_jf2_bess.glb'),
  inverter: assetUrl('/models/pe4200_pcs.glb'),
  fireControlPanel: assetUrl('/models/fire_control_panel.glb'),
  auxTransformer: assetUrl('/models/hitachi_aux_transformer.glb'),
  auxSwitchgear: assetUrl('/models/aux_distribution_center.glb'),
  fiberPatchPanel: assetUrl('/models/fiber_patch_panel.glb'),
} as const;

// The aux GLBs ship without materials (GLTFLoader falls back to flat white),
// so give them manufacturer-plausible finishes: Hitachi aux transformers are
// painted light machine gray, distribution switchboard enclosures are pale
// powder-coated steel. Applied once to the cloned per-scene materials.
const MODEL_MATERIAL_STYLES: Record<string, { color: string; roughness: number; metalness: number }> = {
  [MODEL_URLS.auxTransformer]: { color: '#9aa1a3', roughness: 0.55, metalness: 0.35 },
  [MODEL_URLS.auxSwitchgear]: { color: '#c8cbc9', roughness: 0.5, metalness: 0.3 },
};

// Cast-in-place concrete equipment pads under the aux gear (display-only):
// a 6 in slab reveal above grade, extending 1.5 ft beyond the equipment
// footprint on every side, with the model sitting ON the slab (lifted by the
// reveal). Matches how pad-mounted transformers/switchboards install in the
// field. Layout math, clearances and exports are untouched.
export const PAD_KINDS: ReadonlySet<PlacedEquipment['kind']> =
  new Set<PlacedEquipment['kind']>(['auxTransformer', 'auxSwitchgear']);
export const PAD_MARGIN_FT = 1.5;   // slab overhang beyond the footprint
export const PAD_REVEAL_FT = 0.5;   // slab height above grade (6 in)

// The PCS model follows the selected configuration: GE configurations show
// the GE FLEX (Glex) 1571 skid, PE configurations the Power Electronics
// FP4200M. Display-only, like everything else in this file.
export const GE_PCS_MODEL_URL = assetUrl('/models/ge_flex1571_pcs.glb');

export function inverterModelUrl(inverterModel: string | undefined): string {
  return inverterModel === 'GE FLEX 1571' ? GE_PCS_MODEL_URL : MODEL_URLS.inverter;
}

export type RealisticKind = keyof typeof MODEL_URLS;

export const REALISTIC_KINDS: ReadonlySet<PlacedEquipment['kind']> =
  new Set<PlacedEquipment['kind']>(['bess', 'inverter', 'fireControlPanel', 'auxTransformer', 'auxSwitchgear', 'fiberPatchPanel']);

// Draw-call budget: the current BESS GLB is a single pre-merged 136k-vert
// mesh (renders as one instanced draw via the "keep" branch below), but the
// pipeline still supports heavy multi-part CAD models: the legacy DC-Link
// BESS GLB had ~290 parts, and the original
// one-InstancedMesh-per-part rendering cost ~290 draws every frame. Parts
// whose EXPANDED vertex count (verts × local copies) is at or under this
// limit get baked into one merged geometry per material (1 draw, 1 instance
// per equipment unit); heavier parts (the 1.6M-vert main body, high-count
// GPU-instanced brackets) keep their original geometry and render as their
// own InstancedMesh, so no vertex data is ever duplicated for them. At 20k
// this collapses ~233 of the ~290 BESS parts into 2 merged draws (~1M baked
// verts, a one-time cost) and leaves ~57 instanced draws.
const MERGE_EXPANDED_VERT_LIMIT = 20000;

interface ModelPart {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  // Normalized local transforms for this part (one per GPU instance; merged
  // parts have exactly one identity local — the bake already placed them).
  // Final render matrix is equipMatrix * locals[k].
  locals: THREE.Matrix4[];
}

// Convert any (possibly quantized/normalized-int or interleaved) attribute
// to a plain Float32 attribute. Quantized GLB attributes must NEVER get
// applyMatrix4 directly — baking matrices into normalized-int arrays
// corrupts the mesh — so merged copies are de-quantized first, then
// transformed. getX/getY/getZ denormalize correctly for every storage type.
function toFloat32Attribute(attr: THREE.BufferAttribute | THREE.InterleavedBufferAttribute): THREE.BufferAttribute {
  const itemSize = attr.itemSize;
  const arr = new Float32Array(attr.count * itemSize);
  for (let i = 0; i < attr.count; i++) {
    arr[i * itemSize] = attr.getX(i);
    if (itemSize > 1) arr[i * itemSize + 1] = attr.getY(i);
    if (itemSize > 2) arr[i * itemSize + 2] = attr.getZ(i);
    if (itemSize > 3) arr[i * itemSize + 3] = attr.getW(i);
  }
  return new THREE.BufferAttribute(arr, itemSize);
}

const IDENTITY = new THREE.Matrix4();
const partsCache = new WeakMap<THREE.Object3D, ModelPart[]>();

function normalizedParts(scene: THREE.Object3D): ModelPart[] {
  const cached = partsCache.get(scene);
  if (cached) return cached;

  scene.updateWorldMatrix(true, true);
  const raw: { geometry: THREE.BufferGeometry; material: THREE.Material; locals: THREE.Matrix4[] }[] = [];
  scene.traverse(obj => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    const locals: THREE.Matrix4[] = [];
    const inst = mesh as THREE.InstancedMesh;
    if (inst instanceof THREE.InstancedMesh) {
      // Expand GPU instancing: one local matrix per instance.
      const im = new THREE.Matrix4();
      for (let i = 0; i < inst.count; i++) {
        inst.getMatrixAt(i, im);
        locals.push(new THREE.Matrix4().multiplyMatrices(mesh.matrixWorld, im));
      }
    } else {
      locals.push(mesh.matrixWorld.clone());
    }
    raw.push({ geometry: mesh.geometry, material: mat as THREE.Material, locals });
  });

  // Overall bounding box across all parts/instances in world space.
  // computeBoundingBox reads via getX/getY/getZ, which denormalizes
  // quantized attributes correctly.
  const box = new THREE.Box3();
  const partBox = new THREE.Box3();
  for (const p of raw) {
    p.geometry.computeBoundingBox();
    if (!p.geometry.boundingBox) continue;
    for (const local of p.locals) {
      partBox.copy(p.geometry.boundingBox).applyMatrix4(local);
      box.union(partBox);
    }
  }
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);

  // Long horizontal axis along +x (instance scale x = plan length)
  const rotate = size.z > size.x;
  const norm = new THREE.Matrix4()
    .makeScale(
      1 / Math.max(rotate ? size.z : size.x, 1e-6),
      1 / Math.max(size.y, 1e-6),
      1 / Math.max(rotate ? size.x : size.z, 1e-6)
    )
    .multiply(new THREE.Matrix4().makeRotationY(rotate ? Math.PI / 2 : 0))
    .multiply(new THREE.Matrix4().makeTranslation(-center.x, -center.y, -center.z));

  // Split parts into "merge" (small: bake Float32 copies per local into one
  // geometry per material) and "keep" (heavy: original geometry untouched,
  // rendered instanced with per-instance matrix = equipMatrix * norm*local).
  // Materials are cloned once per source material (we own the clones) and
  // pre-patched with the per-instance feeder tint shader — a zero tint
  // renders unchanged, so the same shader serves tinted (PCS) and untinted
  // (BESS / fire panel) kinds without per-tint geometry or material clones.
  const matClones = new Map<THREE.Material, THREE.Material>();
  const ownedMaterial = (src: THREE.Material): THREE.Material => {
    let c = matClones.get(src);
    if (!c) {
      c = src.clone();
      patchMaterialWithFeederTint(c);
      matClones.set(src, c);
    }
    return c;
  };

  const parts: ModelPart[] = [];
  const mergeBuckets = new Map<THREE.Material, THREE.BufferGeometry[]>();
  const local2 = new THREE.Matrix4();
  for (const p of raw) {
    const vertCount = p.geometry.getAttribute('position')?.count ?? 0;
    if (vertCount * p.locals.length > MERGE_EXPANDED_VERT_LIMIT) {
      parts.push({
        geometry: p.geometry,
        material: ownedMaterial(p.material),
        locals: p.locals.map(l => new THREE.Matrix4().multiplyMatrices(norm, l)),
      });
      continue;
    }
    for (const local of p.locals) {
      local2.multiplyMatrices(norm, local);
      const g = new THREE.BufferGeometry();
      // Keep only the attributes the standard materials read; extras
      // (tangents, second UV sets present on some parts only) would make
      // the per-material merge reject the whole group.
      for (const name of ['position', 'normal', 'uv'] as const) {
        const src = p.geometry.getAttribute(name);
        if (src) g.setAttribute(name, toFloat32Attribute(src));
      }
      if (p.geometry.index) g.setIndex(p.geometry.index.clone());
      if (!g.getAttribute('normal')) g.computeVertexNormals();
      g.applyMatrix4(local2); // safe: Float32 copies, never the GLTF arrays
      mergeBuckets.set(p.material, [...(mergeBuckets.get(p.material) ?? []), g]);
    }
  }

  for (const [srcMat, geoms] of Array.from(mergeBuckets.entries())) {
    // Merge needs a uniform attribute set: drop attrs missing from any
    // sibling (a lone uv-less part falls back to flat material color).
    const names = ['position', 'normal', 'uv'].filter(n => geoms.every((g: THREE.BufferGeometry) => g.getAttribute(n)));
    for (const g of geoms) {
      for (const n of ['normal', 'uv']) if (!names.includes(n)) g.deleteAttribute(n);
    }
    const merged = geoms.length === 1 ? geoms[0] : mergeGeometries(geoms, false);
    if (!merged) continue;
    if (geoms.length > 1) for (const g of geoms) g.dispose();
    parts.push({ geometry: merged, material: ownedMaterial(srcMat), locals: [IDENTITY] });
  }
  partsCache.set(scene, parts);
  return parts;
}

const Y_AXIS = new THREE.Vector3(0, 1, 0);

// One InstancedMesh per part (merged bucket or heavy original part), with
// items.length * locals.length instances in item-major order. Matrices
// mirror the simple-box instancing exactly, so models sit on the ground and
// face the same way the boxes do. Feeder tints are a per-instance attribute
// on each part's geometry — never geometry/material clones per tint (that
// cloned the whole model per color and blew memory).
function ModelInstances({ url, items, tints, ghost, lift = 0, bodyColor = null }: { url: string; items: PlacedEquipment[]; tints?: (string | null)[]; ghost?: boolean; lift?: number; bodyColor?: string | null }) {
  const { scene } = useGLTF(url);
  const invalidate = useThree(s => s.invalidate);
  // normalizedParts is cached per GLTF scene (WeakMap) and the drei GLTF
  // cache keeps scenes alive for the app's lifetime, so the merged
  // geometries / cloned materials are one-time allocations — no per-render
  // churn and nothing to dispose until the page unloads.
  //
  // Ghost mode (future augmentation units): the shared part geometries carry
  // the aFeederTint attribute sized for the REAL equipment instances, so a
  // ghost consumer must never share them — it clones geometry + material once
  // and renders faded (transparent, no depth write, no shadows, no tints).
  const parts = useMemo(() => {
    const base = normalizedParts(scene);
    // Material-less GLBs (the aux gear) get their finish here, once per
    // cloned material (idempotent — the clones are per-scene singletons).
    const style = MODEL_MATERIAL_STYLES[url];
    if (style) {
      for (const p of base) {
        const m = p.material as THREE.MeshStandardMaterial;
        if (m.isMeshStandardMaterial && !m.userData.auxStyled) {
          m.color.set(style.color);
          m.roughness = style.roughness;
          m.metalness = style.metalness;
          m.userData.auxStyled = true;
        }
      }
    }
    // GE PCS exterior recolor (display-only): swap the BaseColor map on the
    // cloned (owned) materials for a cached recolored texture — body panels
    // take the chosen color, baked logos/text go white. `null` restores the
    // untouched factory map. Map swaps never trigger a shader recompile, so
    // the feeder-tint patch on these materials is preserved. The original
    // map is stashed once in userData so factory can always be restored.
    if (url === GE_PCS_MODEL_URL) {
      for (const p of base) {
        const m = p.material as THREE.MeshStandardMaterial;
        if (!m.isMeshStandardMaterial || (!m.map && !m.userData.factoryMap)) continue;
        if (!m.userData.factoryMap) m.userData.factoryMap = m.map;
        const factory = m.userData.factoryMap as THREE.Texture;
        m.map = bodyColor ? recoloredGeTexture(factory, bodyColor) : factory;
        // The baked logos/text are near-full METALLIC in the MR map — a
        // metal marking renders black regardless of its (whitened) base
        // color, so the repaint also swaps in an MR texture with the
        // marking pixels flattened to non-metal matte paint.
        if (m.metalnessMap || m.userData.factoryMr) {
          if (!m.userData.factoryMr) m.userData.factoryMr = m.metalnessMap;
          const factoryMr = m.userData.factoryMr as THREE.Texture;
          const mr = bodyColor ? neutralizedGeMrTexture(factoryMr, factory) : factoryMr;
          m.metalnessMap = mr;
          m.roughnessMap = mr; // glTF packs both in one texture
        }
      }
    }
    if (!ghost) {
      // Fresh array identity when the color changes so the layout effect
      // re-fires and calls invalidate() (demand frameloop repaint).
      return url === GE_PCS_MODEL_URL ? [...base] : base;
    }
    return base.map(p => {
      const geometry = p.geometry.clone();
      geometry.deleteAttribute('aFeederTint');
      const material = p.material.clone();
      material.transparent = true;
      material.opacity = 0.35;
      material.depthWrite = false;
      return { geometry, material, locals: p.locals };
    });
  }, [scene, ghost, url, bodyColor]);
  const refs = useRef<(THREE.InstancedMesh | null)[]>([]);

  const equipMatrices = useMemo(() => {
    const m: THREE.Matrix4[] = [];
    const q = new THREE.Quaternion();
    for (const eq of items) {
      q.setFromAxisAngle(Y_AXIS, eq.rotation);
      m.push(
        new THREE.Matrix4().compose(
          new THREE.Vector3(eq.x, lift + eq.height / 2, -eq.y),
          q.clone(),
          new THREE.Vector3(eq.length, eq.height, eq.width)
        )
      );
    }
    return m;
  }, [items]);

  // useLayoutEffect: matrices and tints must land before the remounted
  // meshes first render, or a frame of identity-matrix models flashes.
  useLayoutEffect(() => {
    const tmp = new THREE.Matrix4();
    parts.forEach((part, pi) => {
      const mesh = refs.current[pi];
      if (!mesh) return;
      let idx = 0;
      for (const em of equipMatrices) {
        for (const local of part.locals) {
          tmp.multiplyMatrices(em, local);
          mesh.setMatrixAt(idx++, tmp);
        }
      }
      mesh.count = idx;
      mesh.instanceMatrix.needsUpdate = true;
      if (ghost) {
        // No tint attribute in ghost mode (cloned unpatched materials).
        mesh.computeBoundingSphere();
        return;
      }
      // One tint slot per instance (item-major, repeated per local copy);
      // zeros (= untinted) when no tints apply. The attribute lives on the
      // part geometry (single consumer per model kind), so tint changes
      // never reallocate geometry or recompile the material.
      const expanded: (string | null)[] = [];
      for (let i = 0; i < items.length; i++) {
        for (let k = 0; k < part.locals.length; k++) expanded.push(tints?.[i] ?? null);
      }
      const fresh = makeFeederTintAttribute(expanded);
      const existing = part.geometry.getAttribute('aFeederTint') as THREE.InstancedBufferAttribute | undefined;
      if (existing && existing.count === fresh.count) {
        // Reuse the existing GPU buffer: update in place only when values
        // changed (recreating the attribute every matrix update churned GPU
        // allocations during layout edits).
        const a = existing.array as Float32Array;
        const b = fresh.array as Float32Array;
        let changed = false;
        for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) { changed = true; break; }
        if (changed) { a.set(b); existing.needsUpdate = true; }
      } else {
        part.geometry.setAttribute('aFeederTint', fresh);
      }
      // Instance-aware bounding sphere so frustum culling stays correct: an
      // off-screen yard section stops costing GPU time every frame.
      mesh.computeBoundingSphere();
    });
    // Demand frameloop: imperative matrix/tint writes don't diff host props,
    // so repaint explicitly.
    invalidate();
  }, [equipMatrices, parts, tints, items, invalidate, ghost]);

  if (items.length === 0) return null;
  return (
    <group>
      {parts.map((part, pi) => (
        <instancedMesh
          key={`${url}-${pi}-${items.length}`}
          ref={el => (refs.current[pi] = el)}
          args={[part.geometry, part.material, items.length * part.locals.length]}
          castShadow={!ghost}
          receiveShadow={!ghost}
        />
      ))}
    </group>
  );
}

// One instanced box per padded unit: unit cube scaled to (footprint +
// overhang) × reveal, top of slab at PAD_REVEAL_FT above grade. Broom-finish
// concrete reads as matte light gray; slab casts/receives shadows so the
// equipment grounds visually. Bottom face sits at y=0 (coplanar with the
// ground but facing down, so it never z-fights).
function ConcretePads({ items }: { items: PlacedEquipment[] }) {
  const invalidate = useThree(s => s.invalidate);
  const ref = useRef<THREE.InstancedMesh | null>(null);
  const material = useMemo(
    () => new THREE.MeshStandardMaterial({ color: '#b7b4ad', roughness: 0.95, metalness: 0.02 }),
    [],
  );
  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    const q = new THREE.Quaternion();
    const tmp = new THREE.Matrix4();
    items.forEach((eq, i) => {
      q.setFromAxisAngle(Y_AXIS, eq.rotation);
      tmp.compose(
        new THREE.Vector3(eq.x, PAD_REVEAL_FT / 2, -eq.y),
        q,
        new THREE.Vector3(eq.length + 2 * PAD_MARGIN_FT, PAD_REVEAL_FT, eq.width + 2 * PAD_MARGIN_FT),
      );
      mesh.setMatrixAt(i, tmp);
    });
    mesh.count = items.length;
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    invalidate();
  }, [items, invalidate]);
  if (items.length === 0) return null;
  return (
    <instancedMesh key={`pads-${items.length}`} ref={ref} args={[undefined, material, items.length]} castShadow receiveShadow>
      <boxGeometry args={[1, 1, 1]} />
    </instancedMesh>
  );
}

export default function RealisticEquipment({ equipment, ghost }: { equipment: PlacedEquipment[]; ghost?: boolean }) {
  const feeders = useDesignStore(s => s.feeders);
  const showFeederColors = useDesignStore(s => s.showFeederColors);
  const hiddenFeeders = useDesignStore(s => s.hiddenFeeders);
  const configId = useDesignStore(s => s.configId);
  const gePcsColor = useDesignStore(s => s.gePcsColor);
  const pcsUrl = useMemo(
    () => inverterModelUrl(getConfiguration(configId)?.inverterModel),
    [configId],
  );
  const byKind = useMemo(() => {
    const groups: Record<RealisticKind, PlacedEquipment[]> = {
      bess: [],
      inverter: [],
      fireControlPanel: [],
      auxTransformer: [],
      auxSwitchgear: [],
      fiberPatchPanel: [],
    };
    for (const eq of equipment) {
      if (eq.kind in groups) groups[eq.kind as RealisticKind].push(eq);
    }
    return groups;
  }, [equipment]);

  // Per-instance feeder tints for PCS (inverter) units only; other kinds
  // stay untinted.
  const inverterTints = useMemo(() => {
    if (!showFeederColors) return byKind.inverter.map(() => null);
    const tintById = feederTintByInverterId(feeders.filter(f => !hiddenFeeders.has(f.idx)));
    return byKind.inverter.map(eq => tintById.get(eq.id) ?? null);
  }, [byKind.inverter, feeders, showFeederColors, hiddenFeeders]);

  return (
    <group>
      {(Object.keys(MODEL_URLS) as RealisticKind[]).map(kind => (
        <ModelInstances
          key={kind}
          url={kind === 'inverter' ? pcsUrl : MODEL_URLS[kind]}
          items={byKind[kind]}
          tints={kind === 'inverter' && !ghost ? inverterTints : undefined}
          ghost={ghost}
          lift={PAD_KINDS.has(kind) ? PAD_REVEAL_FT : 0}
          bodyColor={kind === 'inverter' && pcsUrl === GE_PCS_MODEL_URL ? gePcsColor : null}
        />
      ))}
      {!ghost && (
        <ConcretePads items={equipment.filter(eq => PAD_KINDS.has(eq.kind))} />
      )}
    </group>
  );
}
