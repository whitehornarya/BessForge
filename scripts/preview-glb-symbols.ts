/**
 * Write SVG previews of baked geFlex / lgLinkGe for mapping vs TraceGenius.
 * Usage: npx tsx --tsconfig scripts/tsconfig.test.json scripts/preview-glb-symbols.ts
 */
import { writeFileSync } from 'fs';
import { NEXTERA_GLB_SYMBOLS } from '../client/src/lib/nextera/nexteraGlbSymbols.ts';

function svgFor(key: string, scale = 400): string {
  const s = NEXTERA_GLB_SYMBOLS[key];
  const w = scale * s.aspect;
  const h = scale;
  const paths: string[] = [];
  for (const poly of s.polys) {
    for (let i = 0; i < poly.length; i++) {
      const ring = poly[i];
      const d = ring.map((p, j) =>
        `${j ? 'L' : 'M'}${(p[0] * w).toFixed(2)},${((1 - p[1]) * h).toFixed(2)}`
      ).join(' ') + ' Z';
      paths.push(`<path d="${d}" fill="${i === 0 ? '#fff' : '#000'}" fill-rule="evenodd"/>`);
    }
  }
  // evenodd on combined
  const combined = s.polys.flatMap(poly =>
    poly.map((ring, i) => {
      const d = ring.map((p, j) =>
        `${j ? 'L' : 'M'}${(p[0] * w).toFixed(2)},${((1 - p[1]) * h).toFixed(2)}`
      ).join(' ') + ' Z';
      return d;
    })
  ).join(' ');
  return `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <rect width="100%" height="100%" fill="#000"/>
  <path d="${combined}" fill="#fff" fill-rule="evenodd"/>
  <text x="8" y="20" fill="#0f0" font-size="14" font-family="monospace">${key}: ${s.label}</text>
</svg>`;
}

for (const key of ['geFlex', 'lgLinkGe'] as const) {
  const out = `attached_assets/preview-${key}.svg`;
  writeFileSync(out, svgFor(key));
  console.log('wrote', out, 'aspect', NEXTERA_GLB_SYMBOLS[key].aspect);
}
