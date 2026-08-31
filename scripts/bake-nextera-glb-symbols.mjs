#!/usr/bin/env node
/**
 * Bake TraceGenius NextEra legend GLB → client/src/lib/nextera/nexteraGlbSymbols.ts
 *
 * The GLB is a flat 2D vector TRACE (triangle meshes in the XZ plane), not 3D
 * equipment geometry. Meshes cluster into 8 legend rows (symbol ink on the
 * left, label glyphs on the right). Each left mesh becomes one filled poly
 * [outer, ...holes], normalized 0..1 y-up over the symbol bbox.
 *
 * Usage:
 *   node scripts/bake-nextera-glb-symbols.mjs
 *   node scripts/bake-nextera-glb-symbols.mjs --only=geFlex,lgLinkGe
 *   node scripts/bake-nextera-glb-symbols.mjs --only=geFlex,lgLinkGe --force
 *   node scripts/bake-nextera-glb-symbols.mjs --glb=attached_assets/foo.glb
 *
 * When the on-disk GLB SHA already matches NEXTERA_GLB_SYMBOL_SOURCE and
 * --only is set, existing polys for those keys are kept unless --force is
 * passed. A naive re-extract can drop the BESS compartment frame ring that
 * eciSymbolPlacement requires for lgLinkGe.
 */
import { createHash } from 'crypto';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const KEYS = [
  'geFlex',
  'lgLinkGe',
  'commsCabinetGe',
  'peInverter',
  'lgLinkPe',
  'auxDistCenter',
  'auxTransformer',
  'commsCabinetPe',
];

const LABELS = {
  geFlex: 'GE FLEXINVERTER 1571',
  lgLinkGe: 'LG JF2 DC LINK 5.1 BATTERY CONTAINER',
  commsCabinetGe: 'COMMUNICATIONS CABINET',
  peInverter: 'POWER ELECTRONICS FP4200M PCS UNIT',
  lgLinkPe: 'LG JF2 DC LINK 5.1 BATTERY CONTAINER',
  auxDistCenter: 'LAKESHORE AUX DISTRIBUTION CENTER',
  auxTransformer: 'ABB HITACHI AUX TRANSFORMER',
  commsCabinetPe: 'COMMUNICATIONS CABINET',
};

/** Keys whose body is the full symbol bbox (normalized [0,0,1,1]). */
const FULL_BODY = new Set([
  'geFlex', 'lgLinkGe', 'peInverter', 'lgLinkPe', 'auxDistCenter', 'auxTransformer',
]);

const DEFAULT_GLB = 'attached_assets/legencforNexteraEquipment_1786740771084.glb';
const OUT = 'client/src/lib/nextera/nexteraGlbSymbols.ts';

function parseArgs(argv) {
  let glb = DEFAULT_GLB;
  let only = null;
  let force = false;
  for (const a of argv) {
    if (a.startsWith('--glb=')) glb = a.slice(6);
    else if (a.startsWith('--only=')) only = new Set(a.slice(7).split(',').map(s => s.trim()).filter(Boolean));
    else if (a === '--force') force = true;
  }
  return { glb, only, force };
}

function loadGlb(filePath) {
  const buf = readFileSync(filePath);
  const jsonLen = buf.readUInt32LE(12);
  const binChunkStart = 20 + jsonLen;
  const binLen = buf.readUInt32LE(binChunkStart);
  const bin = buf.slice(binChunkStart + 8, binChunkStart + 8 + binLen);
  const json = JSON.parse(buf.slice(20, 20 + jsonLen).toString('utf8'));
  return { json, bin };
}

function readAccessor(json, bin, ai) {
  const a = json.accessors[ai];
  const v = json.bufferViews[a.bufferView];
  const start = (v.byteOffset || 0) + (a.byteOffset || 0);
  const comps = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[a.type];
  const n = a.count * comps;
  const dv = new DataView(bin.buffer, bin.byteOffset + start, n * (a.componentType === 5126 || a.componentType === 5125 ? 4 : 2));
  if (a.componentType === 5126) {
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = dv.getFloat32(i * 4, true);
    return out;
  }
  if (a.componentType === 5123) {
    const out = new Uint16Array(n);
    for (let i = 0; i < n; i++) out[i] = dv.getUint16(i * 2, true);
    return out;
  }
  if (a.componentType === 5125) {
    const out = new Uint32Array(n);
    for (let i = 0; i < n; i++) out[i] = dv.getUint32(i * 4, true);
    return out;
  }
  throw new Error(`unsupported componentType ${a.componentType}`);
}

function worldXz(node, x, y, z) {
  if (node.translation) {
    x += node.translation[0];
    y += node.translation[1];
    z += node.translation[2];
  }
  if (node.matrix) {
    const M = node.matrix;
    return [
      M[0] * x + M[4] * y + M[8] * z + M[12],
      M[2] * x + M[6] * y + M[10] * z + M[14],
    ];
  }
  return [x, z];
}

function ringsFromMesh(json, bin, node, mesh) {
  const prim = mesh.primitives[0];
  const pos = readAccessor(json, bin, prim.attributes.POSITION);
  const idx = prim.indices != null ? readAccessor(json, bin, prim.indices) : null;
  const verts = [];
  for (let i = 0; i < pos.length; i += 3) {
    verts.push(worldXz(node, pos[i], pos[i + 1], pos[i + 2]));
  }
  const tris = [];
  if (idx) {
    for (let i = 0; i < idx.length; i += 3) tris.push([idx[i], idx[i + 1], idx[i + 2]]);
  } else {
    for (let i = 0; i < verts.length; i += 3) tris.push([i, i + 1, i + 2]);
  }
  const edgeCount = new Map();
  const ek = (a, b) => (a < b ? `${a},${b}` : `${b},${a}`);
  for (const [a, b, c] of tris) {
    for (const [u, v] of [[a, b], [b, c], [c, a]]) {
      const k = ek(u, v);
      edgeCount.set(k, (edgeCount.get(k) || 0) + 1);
    }
  }
  const adj = new Map();
  for (const [k, c] of edgeCount) {
    if (c !== 1) continue;
    const [a, b] = k.split(',').map(Number);
    if (!adj.has(a)) adj.set(a, []);
    if (!adj.has(b)) adj.set(b, []);
    adj.get(a).push(b);
    adj.get(b).push(a);
  }
  const used = new Set();
  const rings = [];
  for (const start of adj.keys()) {
    if (used.has(start)) continue;
    const ring = [start];
    used.add(start);
    let prev = start;
    let cur = adj.get(start)[0];
    while (cur != null && cur !== start) {
      ring.push(cur);
      used.add(cur);
      const next = (adj.get(cur) || []).find(x => x !== prev);
      prev = cur;
      cur = next;
      if (ring.length > 500000) break;
    }
    if (ring.length >= 3) rings.push(ring.map(i => verts[i]));
  }
  return rings;
}

function ringArea(ring) {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % ring.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

function ringBBox(rings) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const ring of rings) {
    for (const [x, y] of ring) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  return { minX, minY, maxX, maxY };
}

/** Ramer–Douglas–Peucker on an open ring (not closed-duplicate). */
function rdp(points, eps) {
  if (points.length <= 2) return points.slice();
  const [x1, y1] = points[0];
  const [x2, y2] = points[points.length - 1];
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let maxD = 0, idx = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const [x, y] = points[i];
    const d = len2 === 0
      ? Math.hypot(x - x1, y - y1)
      : Math.abs(dy * (x - x1) - dx * (y - y1)) / Math.sqrt(len2);
    if (d > maxD) { maxD = d; idx = i; }
  }
  if (maxD > eps) {
    const left = rdp(points.slice(0, idx + 1), eps);
    const right = rdp(points.slice(idx), eps);
    return left.slice(0, -1).concat(right);
  }
  return [points[0], points[points.length - 1]];
}

function simplifyRing(ring, eps) {
  if (ring.length < 4) return ring;
  const out = rdp(ring, eps);
  return out.length >= 3 ? out : ring;
}

function pointInRing(p, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    if (((yi > p[1]) !== (yj > p[1])) &&
        (p[0] < (xj - xi) * (p[1] - yi) / ((yj - yi) || 1e-15) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

/** Nest rings into [outer, ...holes] polys (even-odd). */
function nestRings(rings) {
  const sorted = [...rings].sort((a, b) => Math.abs(ringArea(b)) - Math.abs(ringArea(a)));
  const polys = [];
  const used = new Array(sorted.length).fill(false);
  for (let i = 0; i < sorted.length; i++) {
    if (used[i]) continue;
    const outer = sorted[i];
    used[i] = true;
    const poly = [outer];
    for (let j = i + 1; j < sorted.length; j++) {
      if (used[j]) continue;
      const hole = sorted[j];
      let hx = 0, hy = 0;
      for (const [x, y] of hole) { hx += x; hy += y; }
      hx /= hole.length; hy /= hole.length;
      if (pointInRing([hx, hy], outer)) {
        used[j] = true;
        poly.push(hole);
      }
    }
    polys.push(poly);
  }
  return polys;
}

function meshWorldBBox(json, bin, node, mesh) {
  const prim = mesh.primitives[0];
  const pos = readAccessor(json, bin, prim.attributes.POSITION);
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < pos.length; i += 3) {
    const [x, z] = worldXz(node, pos[i], pos[i + 1], pos[i + 2]);
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  return { minX, maxX, minZ, maxZ, cz: (minZ + maxZ) / 2 };
}

function extractSymbols(json, bin, onlyKeys = null) {
  // Phase 1: cheap world bboxes for clustering (no boundary walk).
  const items = [];
  for (let ni = 0; ni < (json.nodes || []).length; ni++) {
    const node = json.nodes[ni];
    if (node.mesh == null) continue;
    const mesh = json.meshes[node.mesh];
    const bb = meshWorldBBox(json, bin, node, mesh);
    items.push({ ni, node, mesh, ...bb });
  }
  items.sort((a, b) => a.cz - b.cz);

  const clusters = [];
  let cur = null;
  for (const it of items) {
    if (!cur || it.cz - cur.maxCz > 0.15) {
      cur = { minCz: it.minZ, maxCz: it.maxZ, items: [] };
      clusters.push(cur);
    }
    cur.minCz = Math.min(cur.minCz, it.minZ);
    cur.maxCz = Math.max(cur.maxCz, it.maxZ);
    cur.items.push(it);
  }
  if (clusters.length !== 8) {
    throw new Error(`expected 8 symbol bands, got ${clusters.length}`);
  }

  const symbols = [];
  for (let ci = 0; ci < clusters.length; ci++) {
    const key = KEYS[ci];
    if (onlyKeys && !onlyKeys.has(key)) continue;

    const c = clusters[ci];
    const sorted = [...c.items].sort((a, b) => a.minX - b.minX);
    let gapAt = -1, gap = 0;
    for (let j = 1; j < sorted.length; j++) {
      const g = sorted[j].minX - sorted[j - 1].maxX;
      if (g > gap) { gap = g; gapAt = j; }
    }
    const left = gap > 0.2 ? sorted.slice(0, gapAt) : sorted;

    // Phase 2: each left mesh is one TraceGenius ink object → nest its
    // own rings into [outer,...holes], then collect all meshes' polys.
    const polys = [];
    for (const it of left) {
      const rings = ringsFromMesh(json, bin, it.node, it.mesh);
      const simplified = rings.map(r => {
        const epsWorld = r.length > 5000 ? 0.002 : r.length > 800 ? 0.0008 : 0.00035;
        return simplifyRing(r, epsWorld);
      }).filter(r => r.length >= 3);
      if (!simplified.length) continue;
      // Temporary world-space nest; normalize after union bbox.
      for (const poly of nestRings(simplified)) polys.push(poly);
    }
    if (!polys.length) throw new Error(`no polys for ${key}`);

    const wbb = ringBBox(polys.flat());
    const w = Math.max(1e-9, wbb.maxX - wbb.minX);
    const h = Math.max(1e-9, wbb.maxY - wbb.minY);
    const toNorm = (x, z) => [
      (x - wbb.minX) / w,
      (z - wbb.minY) / h,
    ];
    const normPolys = polys.map(poly =>
      poly.map(ring => {
        const norm = ring.map(([x, z]) => toNorm(x, z));
        const a = ringArea(norm);
        const out = a >= 0 ? norm : [...norm].reverse();
        return out.map(([x, y]) => [
          Math.round(x * 10000) / 10000,
          Math.round(y * 10000) / 10000,
        ]);
      })
    );

    let body = [0, 0, 1, 1];
    if (!FULL_BODY.has(key) && normPolys[0]?.[0]?.length) {
      // Cabinet body ≈ largest filled region's outer bbox (excludes stands).
      const outer = normPolys[0][0];
      const bb = ringBBox([outer]);
      body = [
        Math.round(bb.minX * 10000) / 10000,
        Math.round(bb.minY * 10000) / 10000,
        Math.round(bb.maxX * 10000) / 10000,
        Math.round(bb.maxY * 10000) / 10000,
      ];
    }

    symbols.push({
      key,
      aspect: Math.round((w / h) * 10000) / 10000,
      body,
      label: LABELS[key],
      polys: normPolys,
      leftCount: left.length,
      meshNames: left.map(m => m.node.name),
    });
  }
  return symbols;
}

function formatPolys(polys) {
  const fmtPt = ([x, y]) => `[${x},${y}]`;
  const fmtRing = r => `[${r.map(fmtPt).join(',')}]`;
  const fmtPoly = p => `[${p.map(fmtRing).join(',')}]`;
  return `[${polys.map(fmtPoly).join(',')}]`;
}

function emitFile(glbRel, sha256, symbolsByKey) {
  const lines = [];
  lines.push(`// Auto-generated by scripts/bake-nextera-glb-symbols.mjs from the delivered`);
  lines.push(`// NextEra equipment symbol GLB (${glbRel}).`);
  lines.push(`// The GLB is a flat 2D vector TRACE of the reference legend sheet, so this is`);
  lines.push(`// plan-view linework — no 3D mesh geometry is ever used for drawings.`);
  lines.push(`// Coordinates are normalized 0..1 over each symbol's own bbox, y up.`);
  lines.push(`//   polys: one filled region per entry, [outerRing, ...holeRings] (even-odd).`);
  lines.push(`//   body:  [x0,y0,x1,y1] bbox of the main cabinet/container contour — this is`);
  lines.push(`//          what registers 1:1 onto the placed equipment footprint; detail`);
  lines.push(`//          outside it (stands, radiators) overhangs like the reference sheet.`);
  lines.push(`// Regenerate with: node scripts/bake-nextera-glb-symbols.mjs`);
  lines.push(`export interface NexteraGlbSymbol {`);
  lines.push(`  aspect: number;`);
  lines.push(`  body: [number, number, number, number];`);
  lines.push(`  label: string;`);
  lines.push(`  /** One filled region per entry: [outerRing, ...holeRings], even-odd. */`);
  lines.push(`  polys: number[][][][];`);
  lines.push(`}`);
  lines.push(`export const NEXTERA_GLB_SYMBOLS: Record<string, NexteraGlbSymbol> = {`);
  for (const key of KEYS) {
    const s = symbolsByKey[key];
    lines.push(
      `  ${key}: { aspect: ${s.aspect}, body: [${s.body.join(',')}], label: ${JSON.stringify(s.label)}, polys: ${formatPolys(s.polys)} },`
    );
  }
  lines.push(`};`);
  lines.push(`// SHA-256 of the source GLB at bake time; the regression suite compares this`);
  lines.push(`// against the file on disk so a re-delivered model can't ship stale artwork.`);
  lines.push(`export const NEXTERA_GLB_SYMBOL_SOURCE = {`);
  lines.push(`  path: ${JSON.stringify(glbRel.replace(/\\\\/g, '/'))},`);
  lines.push(`  sha256: ${JSON.stringify(sha256)},`);
  lines.push(`};`);
  lines.push(``);
  return lines.join('\n');
}

/** Parse existing baked file's symbol objects via a tiny TS→JS strip + Function. */
function parseExistingTs(src) {
  const start = src.indexOf('export const NEXTERA_GLB_SYMBOLS');
  const end = src.indexOf('export const NEXTERA_GLB_SYMBOL_SOURCE');
  if (start < 0 || end < 0) throw new Error('cannot parse existing nexteraGlbSymbols.ts');
  let block = src.slice(start, end);
  block = block
    .replace('export const NEXTERA_GLB_SYMBOLS: Record<string, NexteraGlbSymbol> =', 'return')
    .replace(/;$/, '');
  // eslint-disable-next-line no-new-func
  return Function(`"use strict"; ${block}`)();
}

function main() {
  const { glb, only, force } = parseArgs(process.argv.slice(2));
  const abs = resolve(glb);
  if (!existsSync(abs)) {
    console.error(`GLB not found: ${abs}`);
    process.exit(1);
  }
  const buf = readFileSync(abs);
  const sha256 = createHash('sha256').update(buf).digest('hex');
  const glbRel = glb.replace(/\\/g, '/');
  console.log(`baking ${glbRel}`);
  console.log(`sha256 ${sha256}`);

  const existing = existsSync(OUT) ? parseExistingTs(readFileSync(OUT, 'utf8')) : null;
  let existingSourceSha = null;
  if (existsSync(OUT)) {
    const m = readFileSync(OUT, 'utf8').match(/sha256:\s*"([a-f0-9]+)"/);
    existingSourceSha = m?.[1] ?? null;
  }

  // Same GLB + selective update: keep proven polys (compartment rings, etc.)
  // unless the caller forces a re-extract.
  if (only && existing && existingSourceSha === sha256 && !force) {
    console.log('source SHA unchanged — keeping existing polys for --only keys (pass --force to re-extract)');
    const merged = {};
    for (const key of KEYS) {
      const e = existing[key];
      merged[key] = { key, aspect: e.aspect, body: e.body, label: e.label, polys: e.polys };
    }
    const text = emitFile(glbRel, sha256, merged);
    writeFileSync(OUT, text);
    console.log(`wrote ${OUT} (polys unchanged)`);
    return;
  }

  const { json, bin } = loadGlb(abs);
  const extracted = extractSymbols(json, bin, only);
  for (const s of extracted) {
    console.log(
      `  ${s.key}: aspect=${s.aspect} leftMeshes=${s.leftCount} polys=${s.polys.length} ` +
      `rings=${s.polys.map(p => p.map(r => r.length).join('/')).join('; ')}`
    );
  }

  let byKey = Object.fromEntries(extracted.map(s => [s.key, s]));
  if (only) {
    if (!existing) throw new Error(`--only requires existing ${OUT}`);
    const merged = {};
    for (const key of KEYS) {
      if (only.has(key)) {
        if (!byKey[key]) throw new Error(`selective bake missing ${key}`);
        merged[key] = byKey[key];
      } else {
        const e = existing[key];
        merged[key] = {
          key,
          aspect: e.aspect,
          body: e.body,
          label: e.label,
          polys: e.polys,
        };
      }
    }
    byKey = merged;
    console.log(`selective write: ${[...only].join(', ')}`);
  }

  const text = emitFile(glbRel, sha256, byKey);
  writeFileSync(OUT, text);
  console.log(`wrote ${OUT}`);
}

main();
