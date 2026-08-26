// GE PCS container exterior recolor (display-only). The GE FLEXINVERTER GLB
// is one mesh with one material whose GE Vernova logos/text are BAKED into
// the BaseColor texture (light-gray body panels, dark-teal markings), so a
// uniform material color change would paint the logos too. Instead the
// texture itself is reprocessed pixel by pixel: body pixels take the chosen
// exterior color (shading preserved via per-pixel luminance), marking pixels
// (logo circle, "GE VERNOVA" lettering) are forced white — matching how the
// real green GE Vernova containers are painted. Never touches the GLB asset,
// layout math, or DXF/PDF exports.
import * as THREE from 'three';

// Factory-look sentinel is `null` (no reprocessing at all — byte-identical
// legacy rendering). The green preset matches the GE Vernova container paint
// from the manufacturer reference photo (dark teal green).
export const GE_PCS_GREEN = '#15514b';

// Untrusted saved value -> '#rrggbb' or null (factory). Anything malformed
// falls back to factory instead of rejecting the file.
export function sanitizePcsColor(v: unknown): string | null {
  return typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : null;
}

// Marking (logo/text) pixels in the GE BaseColor texture are teal-tinted —
// green and blue both run well above red — while body panels, hinges and
// shadows are neutral grays (r ≈ g ≈ b). Threshold 24 clears WebP noise on
// the grays while catching the anti-aliased marking edges.
export const MARKING_CHROMA_MIN = 24;

export function isGeMarkingPixel(r: number, g: number, b: number): boolean {
  return g - r > MARKING_CHROMA_MIN && b - r > MARKING_CHROMA_MIN;
}

// Reference body luminance: the dominant light-gray panel tone of the source
// texture (~176-190). A pixel at this luminance takes the chosen color
// exactly; darker pixels (panel seams, shading) keep proportionally darker
// paint so the recolor preserves all baked surface detail.
export const BODY_REF_LUM = 185;

// White the markings land on — slightly off pure white so the paper-bright
// logo still shades under scene lighting instead of blowing out.
export const MARKING_WHITE = 245;

// The chosen hex is an sRGB display color and the recolored texture is
// tagged SRGBColorSpace, so the raw hex bytes go into the pixels verbatim.
// (THREE.Color(hex) must NOT be used here: with color management enabled it
// converts to Linear-sRGB working space, which double-darkens the paint —
// the dark GE green preset came out nearly black.)
export function hexToRgb255(hex: string): { r: number; g: number; b: number } {
  const n = parseInt(hex.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

// The GE markings are baked almost fully METALLIC in the metallic-roughness
// map (metal ≈ 234/255 vs body ≈ 98). A metal surface with no environment
// map renders black no matter how white its base color is — so the repaint
// must also flatten the marking pixels to non-metal matte paint or the
// whitened logos still show up black. glTF packing: G = roughness,
// B = metallic.
export const MARKING_ROUGHNESS = 170;
export const MARKING_METALLIC = 0;

// Neutralize marking pixels in the metallic-roughness RGBA array using the
// marking mask derived from the BaseColor pixels (same UV space / same
// dimensions). Body pixels keep their factory finish. Pure — unit-testable.
export function neutralizeMarkingMrPixels(
  mrData: Uint8ClampedArray,
  baseData: Uint8ClampedArray,
): void {
  for (let i = 0; i < mrData.length; i += 4) {
    if (isGeMarkingPixel(baseData[i], baseData[i + 1], baseData[i + 2])) {
      mrData[i + 1] = MARKING_ROUGHNESS; // G = roughness
      mrData[i + 2] = MARKING_METALLIC;  // B = metallic
    }
  }
}

// Recolor the RGBA pixel array in place (unit-testable in Node — no canvas
// or three.js needed). `rgb` is the target body color as 0-255 components.
export function recolorGePcsPixels(
  data: Uint8ClampedArray,
  rgb: { r: number; g: number; b: number },
): void {
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    if (isGeMarkingPixel(r, g, b)) {
      data[i] = MARKING_WHITE;
      data[i + 1] = MARKING_WHITE;
      data[i + 2] = MARKING_WHITE;
      continue;
    }
    const shade = Math.min(1.25, ((r + g + b) / 3) / BODY_REF_LUM);
    data[i] = Math.min(255, Math.round(rgb.r * shade));
    data[i + 1] = Math.min(255, Math.round(rgb.g * shade));
    data[i + 2] = Math.min(255, Math.round(rgb.b * shade));
  }
}

// Recolored replacement for the GE BaseColor texture. Cached per
// (source texture, color) so repeated renders/instances reuse one canvas +
// GPU upload; the source texture is never mutated. Returns the source
// unchanged when the image is unavailable (still decoding / test stub) —
// callers fall back to the factory look rather than crashing.
//
// Bounded LRU: the custom color picker fires continuously while scrubbing,
// producing many unique hex values — an unbounded cache would pin a full
// 1024x1024 GPU texture per visited color forever. Evicted textures are
// disposed (GPU memory reclaimed); the material holds its own reference to
// the CURRENT texture, so only stale colors are ever evicted/disposed.
export const RECOLOR_CACHE_MAX = 8;
const recolorCache = new Map<string, THREE.Texture>();

export function recoloredGeTexture(src: THREE.Texture, hex: string): THREE.Texture {
  const key = `${src.uuid}|${hex.toLowerCase()}`;
  const hit = recolorCache.get(key);
  if (hit) {
    // LRU refresh: re-insert so the active color is the last to be evicted.
    recolorCache.delete(key);
    recolorCache.set(key, hit);
    return hit;
  }
  const img = src.image as { width?: number; height?: number } | undefined;
  if (!img || !img.width || !img.height || typeof document === 'undefined') return src;
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return src;
  try {
    ctx.drawImage(src.image as CanvasImageSource, 0, 0);
  } catch {
    return src; // image not drawable (unexpected source type)
  }
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  recolorGePcsPixels(imageData.data, hexToRgb255(hex));
  ctx.putImageData(imageData, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  // Mirror the GLTF texture's sampling state exactly — a cloned/derived
  // texture that loses flipY/colorSpace renders upside-down or washed out,
  // and anisotropy resets to 1 cause far-zoom shimmer.
  tex.flipY = src.flipY;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = src.wrapS;
  tex.wrapT = src.wrapT;
  tex.magFilter = src.magFilter;
  tex.minFilter = src.minFilter;
  tex.anisotropy = src.anisotropy;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  recolorCache.set(key, tex);
  while (recolorCache.size > RECOLOR_CACHE_MAX) {
    const oldestKey = recolorCache.keys().next().value as string;
    const oldest = recolorCache.get(oldestKey);
    recolorCache.delete(oldestKey);
    oldest?.dispose();
  }
  return tex;
}

// Marking-neutralized replacement for the GE metallic-roughness texture.
// Color-independent (one canvas regardless of chosen body color), cached per
// (mr texture, basecolor texture) pair. Returns the source unchanged when
// either image is unavailable — callers keep the factory finish.
const mrCache = new Map<string, THREE.Texture>();

export function neutralizedGeMrTexture(mrSrc: THREE.Texture, baseSrc: THREE.Texture): THREE.Texture {
  const key = `${mrSrc.uuid}|${baseSrc.uuid}`;
  const hit = mrCache.get(key);
  if (hit) return hit;
  const mrImg = mrSrc.image as { width?: number; height?: number } | undefined;
  const baseImg = baseSrc.image as { width?: number; height?: number } | undefined;
  if (!mrImg?.width || !mrImg.height || !baseImg?.width || !baseImg.height ||
      typeof document === 'undefined') return mrSrc;
  const canvas = document.createElement('canvas');
  canvas.width = mrImg.width;
  canvas.height = mrImg.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return mrSrc;
  const maskCanvas = document.createElement('canvas');
  maskCanvas.width = mrImg.width;
  maskCanvas.height = mrImg.height;
  const maskCtx = maskCanvas.getContext('2d', { willReadFrequently: true });
  if (!maskCtx) return mrSrc;
  try {
    ctx.drawImage(mrSrc.image as CanvasImageSource, 0, 0);
    // Scale the basecolor to the MR dimensions in case they differ.
    maskCtx.drawImage(baseSrc.image as CanvasImageSource, 0, 0, maskCanvas.width, maskCanvas.height);
  } catch {
    return mrSrc;
  }
  const mrData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const baseData = maskCtx.getImageData(0, 0, canvas.width, canvas.height);
  neutralizeMarkingMrPixels(mrData.data, baseData.data);
  ctx.putImageData(mrData, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.flipY = mrSrc.flipY;
  tex.colorSpace = mrSrc.colorSpace; // MR data is non-color (linear)
  tex.wrapS = mrSrc.wrapS;
  tex.wrapT = mrSrc.wrapT;
  tex.magFilter = mrSrc.magFilter;
  tex.minFilter = mrSrc.minFilter;
  tex.anisotropy = mrSrc.anisotropy;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  mrCache.set(key, tex);
  return tex;
}

// Test hook: current cache size (no texture references leak out).
export function recolorCacheSize(): number {
  return recolorCache.size;
}
