import * as THREE from 'three';

// Shared sampling setup for all tiled ground textures: repeat wrapping,
// trilinear mipmap filtering, and the renderer's maximum anisotropy. Cloned
// textures default to anisotropy 1, which causes severe shimmer/moiré on
// near-horizontal ground planes at far zoom. Every cloned ground texture in
// the 3D preview MUST pass through this helper (regression-tested in
// scripts/nextera.test.ts).
export function configureGroundTexture(t: THREE.Texture, maxAnisotropy: number): void {
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = maxAnisotropy;
  t.needsUpdate = true;
}
