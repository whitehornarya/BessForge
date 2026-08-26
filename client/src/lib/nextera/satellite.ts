import { apiFetchJson } from '../api/fetch';

// Site-vicinity satellite imagery (fetched through the server-side Cesium
// ion -> Bing Aerial proxy at /api/satellite; the ion token never reaches
// the browser). The server returns the highest-resolution tile mosaic that
// covers the tile containing the site plus its east / north / south
// neighbors; this module stitches the tiles into one image and converts the
// mosaic's WGS84 bounds into the same local-feet frame the layout engine
// uses (equirectangular about the KMZ boundary origin — see kmz.ts).

export interface SatelliteImage {
  dataUrl: string;       // stitched JPEG data URL
  widthPx: number;
  heightPx: number;
  zoom: number;          // web-mercator zoom level of the source tiles
  bounds: { west: number; east: number; north: number; south: number }; // WGS84 deg
}

interface SatelliteApiResponse {
  zoom: number;
  cols: number;
  rows: number;
  tileSize: number;
  tiles: Array<{ col: number; row: number; jpegBase64: string }>;
  bounds: SatelliteImage['bounds'];
}

const loadImage = (src: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('satellite tile failed to decode'));
    img.src = src;
  });

// Square of ground the 3D view stands on, in local feet: where its center
// sits and how long its side is.
//
// A SINGLE parcel is always centered on the projection origin (kmz.ts projects
// one boundary about its own centroid), so its square is origin-centered and
// sized from the farthest vertex — the historical 2.6x framing, unchanged.
//
// A MULTI-AREA site shares one origin across every footprint, so no area is
// centered on it and "distance from the origin" stops describing the site at
// all. An area far from the origin forces an origin-centered square to grow
// until it reaches back across the origin and out the other side — mostly
// empty land, and a mosaic large enough to make the server back the zoom down
// (coarse imagery) or blow its tile budget outright. Multi-area sites are
// therefore framed on the ENVELOPE of every area: centered on the envelope,
// sized to its longest span plus a small margin.
export interface SiteGroundExtent {
  cx: number;   // center of the square, local feet
  cy: number;
  size: number; // side length, local feet
}

export function siteGroundExtent(
  polygons: Array<Array<{ x: number; y: number }>>
): SiteGroundExtent {
  const finite: Array<{ x: number; y: number }> = [];
  for (const poly of polygons) {
    for (const p of poly) {
      if (Number.isFinite(p.x) && Number.isFinite(p.y)) finite.push(p);
    }
  }
  if (!finite.length) return { cx: 0, cy: 0, size: 200 };

  // Single area: keep the origin-centered 2.6x framing byte-identical.
  if (polygons.length <= 1) {
    let maxAbs = 0;
    for (const p of finite) {
      const m = Math.max(Math.abs(p.x), Math.abs(p.y));
      if (m > maxAbs) maxAbs = m;
    }
    return { cx: 0, cy: 0, size: maxAbs > 0 ? maxAbs * 2.6 + 200 : 200 };
  }

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of finite) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const span = Math.max(maxX - minX, maxY - minY);
  return {
    cx: (minX + maxX) / 2,
    cy: (minY + maxY) / 2,
    // 15% margin so the outermost lot lines aren't flush with the imagery edge.
    size: span > 0 ? span * 1.15 + 200 : 200,
  };
}

// Side length only — the 3D ground plane's geometry args.
export function siteGroundExtentFt(
  polygons: Array<Array<{ x: number; y: number }>>
): number {
  return siteGroundExtent(polygons).size;
}

// Coverage requested from the server: the WGS84 bbox of the 3D view's ground
// plane. Must mirror DesignScene's groundSize formula so the drape spans the
// entire visible ground — not just a small patch around the site point.
export function satelliteCoverageBbox(
  polygon: Array<{ x: number; y: number }>,
  origin: { lat: number; lon: number }
): { west: number; east: number; north: number; south: number } {
  return satelliteCoverageBboxFor([polygon], origin);
}

// Whole-site coverage: every area's polygon in the shared projection frame.
// One area behaves identically to satelliteCoverageBbox.
export function satelliteCoverageBboxFor(
  polygons: Array<Array<{ x: number; y: number }>>,
  origin: { lat: number; lon: number }
): { west: number; east: number; north: number; south: number } {
  // Must mirror the ground plane exactly — same center, same size — or the
  // imagery drapes off-register from the ground it is supposed to cover.
  const { cx, cy, size } = siteGroundExtent(polygons);
  const halfFt = size / 2;
  const ftPerDegLon = FT_PER_DEG_LAT * Math.cos((origin.lat * Math.PI) / 180);
  return {
    west: origin.lon + (cx - halfFt) / ftPerDegLon,
    east: origin.lon + (cx + halfFt) / ftPerDegLon,
    south: origin.lat + (cy - halfFt) / FT_PER_DEG_LAT,
    north: origin.lat + (cy + halfFt) / FT_PER_DEG_LAT,
  };
}

// Fetch + stitch. Throws with a human-readable message on any failure —
// callers surface it (no silent fallbacks).
export async function fetchSatelliteImage(
  lat: number,
  lon: number,
  bbox?: { west: number; east: number; north: number; south: number }
): Promise<SatelliteImage> {
  const { data } = await apiFetchJson<SatelliteApiResponse>('/api/satellite', {
    lat, lon, west: bbox?.west, east: bbox?.east, north: bbox?.north, south: bbox?.south,
  }, { ttlMs: 30 * 24 * 60 * 60 * 1000, provenance: 'Cesium ion / Bing proxy' });
  const canvas = document.createElement('canvas');
  canvas.width = data.cols * data.tileSize;
  canvas.height = data.rows * data.tileSize;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas 2d context unavailable');
  const imgs = await Promise.all(
    data.tiles.map(t => loadImage(`data:image/jpeg;base64,${t.jpegBase64}`))
  );
  data.tiles.forEach((t, i) => {
    ctx.drawImage(imgs[i], t.col * data.tileSize, t.row * data.tileSize, data.tileSize, data.tileSize);
  });
  return {
    dataUrl: canvas.toDataURL('image/jpeg', 0.92),
    widthPx: canvas.width,
    heightPx: canvas.height,
    zoom: data.zoom,
    bounds: data.bounds,
  };
}

// WGS84 mosaic bounds -> local feet rectangle in the layout frame, using the
// SAME projection constants as kmz.ts (ft = deg * 364000, x scaled by
// cos(origin lat)) so the drape registers with the parcel geometry.
const FT_PER_DEG_LAT = 364000;

export function satelliteLocalRect(
  img: SatelliteImage,
  origin: { lat: number; lon: number }
): { minX: number; maxX: number; minY: number; maxY: number } {
  const ftPerDegLon = FT_PER_DEG_LAT * Math.cos((origin.lat * Math.PI) / 180);
  return {
    minX: (img.bounds.west - origin.lon) * ftPerDegLon,
    maxX: (img.bounds.east - origin.lon) * ftPerDegLon,
    minY: (img.bounds.south - origin.lat) * FT_PER_DEG_LAT,
    maxY: (img.bounds.north - origin.lat) * FT_PER_DEG_LAT,
  };
}
