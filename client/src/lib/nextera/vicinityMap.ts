// Stylized state/county vicinity map for the "Issued for 10%" cover page.
// Data comes from the server-side TIGERweb proxy (/api/vicinity — U.S. Census
// Bureau, public domain); this module renders it as PURE VECTOR display-list
// ops (beige land, county/state boundaries + names, highways with route
// shields, town dots, site star) so the map plots in both the DXF cover sheet
// (no raster — WYSIWYG rule) and the PDF cover via the shared renderer.
//
// Everything here is opt-in: layers are declared only when the map is drawn,
// so exports without the 10% cover stay byte-identical.
import { DxfWriter } from './dxfExport';
import { apiFetchJson } from '../api/fetch';

export type LonLat = [number, number];

export interface VicinityRoad {
  name: string;
  cls: 'I' | 'U' | 'S' | 'O'; // interstate / US hwy / state hwy / other
  num: string | null;
  paths: LonLat[][];
}

export interface VicinityData {
  site: { lat: number; lon: number };
  bbox: { west: number; east: number; south: number; north: number };
  states: Array<{ name: string; rings: LonLat[][] }>;
  counties: Array<{ name: string; rings: LonLat[][] }>;
  roads: VicinityRoad[];
  places: Array<{ name: string; lon: number; lat: number; area: number }>;
  source: string;
}

// Fetch failures throw with a readable message — callers surface it and
// export without the vicinity panel rather than drawing a silent empty map.
export async function fetchVicinityMap(lat: number, lon: number): Promise<VicinityData> {
  return (await apiFetchJson<VicinityData>('/api/vicinity', { lat, lon }, {
    ttlMs: 30 * 24 * 60 * 60 * 1000, provenance: 'US Census TIGERweb',
  })).data;
}

// Vicinity-map layers (atlas palette). Declared by drawVicinityMap only.
export const VMAP_LAYERS = {
  LAND: 'VMAP - land',
  COUNTY: 'VMAP - county boundary',
  STATE: 'VMAP - state boundary',
  ROAD_I: 'VMAP - interstate',
  ROAD: 'VMAP - highway',
  SHIELD: 'VMAP - route shield',
  TEXT: 'VMAP - labels',
  STAR: 'VMAP - site star',
} as const;

// ACI color assignments for the map layers. 40 (tan) and 254 (near-white)
// get true-to-reference RGB values in the PDF renderer's ACI table.
export const VMAP_ACI = {
  LAND: 40,   // beige land fill
  COUNTY: 8,  // gray county lines
  STATE: 7,   // black state lines
  ROAD_I: 1,  // red interstates
  ROAD: 8,    // gray US/state highways
  SHIELD: 254, // near-white shield fill
  TEXT: 7,
  STAR: 2,    // yellow-gold star
} as const;

export interface PanelRect { x: number; y: number; w: number; h: number } // model ft, lower-left origin

// Liang-Barsky segment clip to an axis-aligned rect (local copy — the pdfPlot
// implementation lives in a module that drags jsPDF into the bundle).
export function clipSeg(
  a: [number, number], b: [number, number],
  r: { minX: number; minY: number; maxX: number; maxY: number }
): [[number, number], [number, number]] | null {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  let t0 = 0, t1 = 1;
  const edges: Array<[number, number]> = [
    [-dx, a[0] - r.minX], [dx, r.maxX - a[0]],
    [-dy, a[1] - r.minY], [dy, r.maxY - a[1]],
  ];
  for (const [p, q] of edges) {
    if (p === 0) { if (q < 0) return null; continue; }
    const t = q / p;
    if (p < 0) { if (t > t1) return null; if (t > t0) t0 = t; }
    else { if (t < t0) return null; if (t < t1) t1 = t; }
  }
  return [[a[0] + t0 * dx, a[1] + t0 * dy], [a[0] + t1 * dx, a[1] + t1 * dy]];
}

// lon/lat -> panel model-ft mapper, ground-aspect preserving, centered.
export function vicinityMapper(data: VicinityData, rect: PanelRect) {
  const { bbox } = data;
  const midLat = (bbox.south + bbox.north) / 2;
  const cosLat = Math.cos((midLat * Math.PI) / 180);
  const gw = (bbox.east - bbox.west) * cosLat; // ground-units wide
  const gh = bbox.north - bbox.south;
  const s = Math.min(rect.w / gw, rect.h / gh);
  const ox = rect.x + (rect.w - gw * s) / 2;
  const oy = rect.y + (rect.h - gh * s) / 2;
  return {
    px: (lon: number) => ox + (lon - bbox.west) * cosLat * s,
    py: (lat: number) => oy + (lat - bbox.south) * s,
    inner: {
      minX: ox, minY: oy,
      maxX: ox + gw * s, maxY: oy + gh * s,
    },
  };
}

// Five-point star polygon (for the site marker), radius in model ft.
export function starPoints(cx: number, cy: number, r: number): number[][] {
  const pts: number[][] = [];
  for (let i = 0; i < 10; i++) {
    const rad = (Math.PI / 2) + (i * Math.PI) / 5;
    const rr = i % 2 === 0 ? r : r * 0.4;
    pts.push([cx + rr * Math.cos(rad), cy + rr * Math.sin(rad)]);
  }
  return pts;
}

const CHAR_W = 0.9; // STANDARD font advance, matches dxfExport

function clippedPolylines(
  paths: LonLat[][],
  m: ReturnType<typeof vicinityMapper>,
): Array<Array<[number, number]>> {
  const out: Array<Array<[number, number]>> = [];
  for (const path of paths) {
    let run: Array<[number, number]> = [];
    for (let i = 0; i + 1 < path.length; i++) {
      const a: [number, number] = [m.px(path[i][0]), m.py(path[i][1])];
      const b: [number, number] = [m.px(path[i + 1][0]), m.py(path[i + 1][1])];
      const c = clipSeg(a, b, m.inner);
      if (!c) { if (run.length > 1) out.push(run); run = []; continue; }
      if (!run.length) run.push(c[0]);
      else {
        const last = run[run.length - 1];
        if (Math.abs(last[0] - c[0][0]) > 1e-9 || Math.abs(last[1] - c[0][1]) > 1e-9) {
          if (run.length > 1) out.push(run);
          run = [c[0]];
        }
      }
      run.push(c[1]);
    }
    if (run.length > 1) out.push(run);
  }
  return out;
}

// Draw the vicinity map into the panel rect. Returns the star position
// (model ft) so the cover can draw leader lines to the aerial panel.
export function drawVicinityMap(
  dxf: DxfWriter,
  data: VicinityData,
  rect: PanelRect
): { starX: number; starY: number } {
  dxf.addLayer(VMAP_LAYERS.LAND, VMAP_ACI.LAND);
  dxf.addLayer(VMAP_LAYERS.COUNTY, VMAP_ACI.COUNTY);
  dxf.addLayer(VMAP_LAYERS.STATE, VMAP_ACI.STATE);
  dxf.addLayer(VMAP_LAYERS.ROAD_I, VMAP_ACI.ROAD_I);
  dxf.addLayer(VMAP_LAYERS.ROAD, VMAP_ACI.ROAD);
  dxf.addLayer(VMAP_LAYERS.SHIELD, VMAP_ACI.SHIELD);
  dxf.addLayer(VMAP_LAYERS.TEXT, VMAP_ACI.TEXT);
  dxf.addLayer(VMAP_LAYERS.STAR, VMAP_ACI.STAR);

  const m = vicinityMapper(data, rect);
  const { minX, minY, maxX, maxY } = m.inner;
  const W = maxX - minX;

  // Beige land fill under everything, then the panel frame.
  dxf.addHatch(
    [[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY]],
    VMAP_LAYERS.LAND, 'SOLID'
  );

  // County boundaries (gray), then state boundaries (black, on top).
  for (const county of data.counties) {
    for (const run of clippedPolylines(county.rings, m)) {
      dxf.addPolyline(run, VMAP_LAYERS.COUNTY);
    }
  }
  for (const st of data.states) {
    for (const run of clippedPolylines(st.rings, m)) {
      dxf.addPolyline(run, VMAP_LAYERS.STATE);
    }
  }

  // County names: at the mean of in-panel ring vertices (cheap, stable).
  const countyH = W * 0.016;
  for (const county of data.counties) {
    let sx = 0, sy = 0, n = 0;
    for (const ring of county.rings) {
      for (const [lo, la] of ring) {
        const x = m.px(lo), y = m.py(la);
        if (x >= minX && x <= maxX && y >= minY && y <= maxY) { sx += x; sy += y; n++; }
      }
    }
    if (!n) continue;
    const label = `${county.name} County`.toUpperCase();
    const tw = label.length * countyH * CHAR_W;
    const tx = Math.min(Math.max(sx / n - tw / 2, minX + W * 0.01), maxX - tw - W * 0.01);
    dxf.addText(tx, sy / n, countyH, label, VMAP_LAYERS.TEXT);
  }

  // Roads: secondary (gray) under interstates (red).
  const roadsByCls = (want: (r: VicinityRoad) => boolean, layer: string) => {
    for (const road of data.roads) {
      if (!want(road)) continue;
      for (const run of clippedPolylines(road.paths, m)) {
        dxf.addPolyline(run, layer);
      }
    }
  };
  roadsByCls(r => r.cls !== 'I', VMAP_LAYERS.ROAD);
  roadsByCls(r => r.cls === 'I', VMAP_LAYERS.ROAD_I);

  // Route shields: one per unique class+number, at the midpoint of the
  // longest in-panel run. Interstates first, then US, then state routes,
  // capped so the map never drowns in shields.
  const shieldR = W * 0.022;
  const shields: Array<{ x: number; y: number; num: string }> = [];
  const seen = new Set<string>();
  const ordered = [...data.roads].sort((a, b) =>
    'IUSO'.indexOf(a.cls) - 'IUSO'.indexOf(b.cls));
  for (const road of ordered) {
    if (!road.num || shields.length >= 12) continue;
    const key = `${road.cls}${road.num}`;
    if (seen.has(key)) continue;
    let best: Array<[number, number]> | null = null;
    let bestLen = 0;
    for (const run of clippedPolylines(road.paths, m)) {
      let len = 0;
      for (let i = 0; i + 1 < run.length; i++) {
        len += Math.hypot(run[i + 1][0] - run[i][0], run[i + 1][1] - run[i][1]);
      }
      if (len > bestLen) { bestLen = len; best = run; }
    }
    if (!best || bestLen < shieldR * 4) continue;
    const mid = best[Math.floor(best.length / 2)];
    // Keep shields from stacking on one another.
    if (shields.some(s => Math.hypot(s.x - mid[0], s.y - mid[1]) < shieldR * 4)) continue;
    seen.add(key);
    shields.push({ x: mid[0], y: mid[1], num: road.num });
  }
  for (const s of shields) {
    // Near-white disc + black ring + centered route number.
    const disc: number[][] = [];
    for (let i = 0; i < 16; i++) {
      const a = (i * Math.PI * 2) / 16;
      disc.push([s.x + shieldR * Math.cos(a), s.y + shieldR * Math.sin(a)]);
    }
    dxf.addHatch(disc, VMAP_LAYERS.SHIELD, 'SOLID');
    dxf.addPolyline(disc, VMAP_LAYERS.STATE, true);
    const h = shieldR * 0.9;
    dxf.addCenteredText(s.x, s.y - h / 2, h, s.num, VMAP_LAYERS.TEXT,
      undefined, { est: CHAR_W });
  }

  // Town dots + names: most prominent places first (area rank), capped.
  const placeH = W * 0.014;
  const dotR = W * 0.004;
  const towns = [...data.places].sort((a, b) => b.area - a.area).slice(0, 14);
  for (const town of towns) {
    const x = m.px(town.lon), y = m.py(town.lat);
    if (x < minX + dotR || x > maxX - dotR || y < minY + dotR || y > maxY - dotR) continue;
    const dot: number[][] = [];
    for (let i = 0; i < 8; i++) {
      const a = (i * Math.PI * 2) / 8;
      dot.push([x + dotR * Math.cos(a), y + dotR * Math.sin(a)]);
    }
    dxf.addHatch(dot, VMAP_LAYERS.STATE, 'SOLID');
    const tw = town.name.length * placeH * CHAR_W;
    const tx = Math.min(Math.max(x + dotR * 2, minX), maxX - tw);
    dxf.addText(tx, y - placeH / 2, placeH, town.name, VMAP_LAYERS.TEXT);
  }

  // Site star (gold fill + black outline), always on top.
  const starX = m.px(data.site.lon);
  const starY = m.py(data.site.lat);
  const star = starPoints(starX, starY, W * 0.02);
  dxf.addHatch(star, VMAP_LAYERS.STAR, 'SOLID');
  dxf.addPolyline(star, VMAP_LAYERS.STATE, true);

  // Panel frame.
  dxf.addPolyline(
    [[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY]],
    VMAP_LAYERS.STATE, true
  );
  return { starX, starY };
}
