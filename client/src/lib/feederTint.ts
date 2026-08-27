// Shared per-instance feeder tint shader for PCS units in both the simple
// instanced-box view and the realistic GLTF-model view. Each instance gets
// an `aFeederTint` vec3 attribute (its feeder's screen color, or 0,0,0 for
// PCS not assigned to any feeder = zero tint). The patched material:
//   - mixes ~10% of the tint into the body diffuse (subtle, not garish)
//   - adds a fresnel rim glow in the tint color (view-angle edge highlight,
//     no pulsing / no animation)
import * as THREE from 'three';

export const FEEDER_TINT_BODY_MIX = 0.10;
export const FEEDER_TINT_RIM_STRENGTH = 0.55;

type MaterialShaderHooks = {
  onBeforeCompile: THREE.Material['onBeforeCompile'];
  customProgramCacheKey: THREE.Material['customProgramCacheKey'];
};

// Keep the exact hooks that existed before tinting. Material.clone() copies
// the tint hook itself, so ghost consumers need this side table to recover an
// unpatched clone without mutating the shared/cached tinted material.
const feederTintOriginalHooks = new WeakMap<THREE.Material, MaterialShaderHooks>();

// Build the per-instance tint attribute. `hexes[i]` is instance i's feeder
// color, or null/undefined for no tint.
export function makeFeederTintAttribute(hexes: (string | null | undefined)[]): THREE.InstancedBufferAttribute {
  const arr = new Float32Array(hexes.length * 3);
  const c = new THREE.Color();
  hexes.forEach((hex, i) => {
    if (!hex) return;
    c.set(hex);
    arr[i * 3] = c.r;
    arr[i * 3 + 1] = c.g;
    arr[i * 3 + 2] = c.b;
  });
  return new THREE.InstancedBufferAttribute(arr, 3);
}

// Patch a material (in place) so it consumes `aFeederTint`. Call on a
// material you own (clone GLTF-shared materials before patching!).
export function patchMaterialWithFeederTint(mat: THREE.Material): void {
  if ((mat as any).userData?.feederTintPatched) return;
  const prevKey = mat.customProgramCacheKey;
  const prev = mat.onBeforeCompile;
  feederTintOriginalHooks.set(mat, {
    onBeforeCompile: prev,
    customProgramCacheKey: prevKey,
  });
  mat.userData = { ...mat.userData, feederTintPatched: true };
  // Distinct program cache key so three.js never reuses an unpatched
  // program for this material (or vice versa) when other properties match.
  mat.customProgramCacheKey = function () {
    return `${prevKey ? prevKey.call(this) : ''}|feederTint`;
  };
  mat.onBeforeCompile = (shader, renderer) => {
    prev?.call(mat, shader, renderer);
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nattribute vec3 aFeederTint;\nvarying vec3 vFeederTint;'
      )
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvFeederTint = aFeederTint;'
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\nvarying vec3 vFeederTint;'
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
{
  float hasTint = step(0.001, max(vFeederTint.r, max(vFeederTint.g, vFeederTint.b)));
  diffuseColor.rgb = mix(diffuseColor.rgb, vFeederTint, ${FEEDER_TINT_BODY_MIX.toFixed(3)} * hasTint);
}`
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
{
  float hasTint = step(0.001, max(vFeederTint.r, max(vFeederTint.g, vFeederTint.b)));
  float fres = pow(1.0 - clamp(dot(normalize(vViewPosition), normal), 0.0, 1.0), 3.0);
  totalEmissiveRadiance += vFeederTint * fres * ${FEEDER_TINT_RIM_STRENGTH.toFixed(3)} * hasTint;
}`
      );
  };
  // Force recompile in case the material was already compiled untinted.
  mat.needsUpdate = true;
}

/**
 * Clone a cached material while removing only this module's feeder-tint
 * shader patch. Ghost models deliberately share the base geometry but do not
 * create/populate aFeederTint, so retaining the patched shader would read a
 * missing or wrong-sized instanced attribute.
 */
export function cloneMaterialWithoutFeederTint(mat: THREE.Material): THREE.Material {
  const clone = mat.clone();
  const original = feederTintOriginalHooks.get(mat);
  clone.onBeforeCompile = original?.onBeforeCompile ?? THREE.Material.prototype.onBeforeCompile;
  clone.customProgramCacheKey =
    original?.customProgramCacheKey ?? THREE.Material.prototype.customProgramCacheKey;
  const userData = { ...clone.userData };
  delete userData.feederTintPatched;
  clone.userData = userData;
  clone.needsUpdate = true;
  return clone;
}
