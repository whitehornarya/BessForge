import type { Express } from "express";
import { createServer, type Server } from "http";
import {
  BoundedTtlCache, InputError, UpstreamError, fetchFixed, optionalQueryNumber,
  parseJson, queryNumber, safeProxyMessage,
} from "./services/proxy-utils";
import { BUNDLED_CESIUM_ION_TOKEN } from "./cesiumIonToken";

function cesiumIonToken(): string {
  return (process.env.CESIUM_ION_TOKEN?.trim() || BUNDLED_CESIUM_ION_TOKEN.trim());
}

export async function registerRoutes(app: Express): Promise<Server> {
  app.get(['/health', '/api/health'], (_req, res) => {
    res.json({ status: 'ok', version: '1.0.1' });
  });
  // API endpoint to check server status
  app.get('/api/status', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });
  
  // API endpoint to get application configuration
  app.get('/api/config', (req, res) => {
    res.json({
      version: '1.0.1',
      name: 'BESS Layout Tool',
      description: 'Battery Energy Storage System Layout Tool',
      defaultUnits: 'METRIC'
    });
  });

  // -------------------------------------------------------------------------
  // Satellite imagery for the site vicinity (Cesium ion asset 2 -> Bing
  // Aerial). The ion token stays server-side; the client receives a mosaic of
  // the highest-resolution tiles available: the tile containing the site plus
  // its east / north / south neighbors, completed to a clean 2-col x 3-row
  // rectangle. Returns base64 JPEG tiles + the WGS84 bounds of the mosaic.
  // -------------------------------------------------------------------------
  let bingCache: { template: string; subdomains: string[]; zoomMax: number; expires: number } | null = null;

  async function getBingImagery() {
    if (bingCache && bingCache.expires > Date.now()) return bingCache;
    const token = cesiumIonToken();
    if (!token) throw new Error('CESIUM_ION_TOKEN is not configured');
    const ionUrl = new URL('https://api.cesium.com/v1/assets/2/endpoint');
    ionUrl.searchParams.set('access_token', token);
    const { response: ionRes, bytes: ionBytes } = await fetchFixed(ionUrl, { timeoutMs: 10_000, maxBytes: 256_000 });
    if (!ionRes.ok) throw new UpstreamError('Satellite imagery service is unavailable');
    const ion = parseJson<any>(ionBytes);
    const key = ion?.options?.key;
    const base = ion?.options?.url;
    if (!key || !base) throw new Error('Cesium ion did not return Bing imagery credentials');
    const baseUrl = new URL(String(base));
    if (baseUrl.protocol !== 'https:' ||
      !(baseUrl.hostname === 'dev.virtualearth.net' || baseUrl.hostname.endsWith('.virtualearth.net'))) {
      throw new UpstreamError('Satellite imagery service returned an invalid endpoint');
    }
    const metaUrl = new URL('/REST/v1/Imagery/Metadata/Aerial', baseUrl);
    metaUrl.searchParams.set('output', 'json');
    metaUrl.searchParams.set('key', String(key));
    const { response: metaRes, bytes: metaBytes } = await fetchFixed(metaUrl, { timeoutMs: 10_000, maxBytes: 512_000 });
    if (!metaRes.ok) throw new UpstreamError('Satellite imagery service is unavailable');
    const meta = parseJson<any>(metaBytes);
    const r0 = meta?.resourceSets?.[0]?.resources?.[0];
    if (!r0?.imageUrl) throw new Error('Bing imagery metadata missing tile template');
    const template = String(r0.imageUrl).replace(/^http:/, 'https:');
    const templateUrl = new URL(template.replace('{subdomain}', 't0').replace('{quadkey}', '0'));
    if (templateUrl.protocol !== 'https:' ||
      !(templateUrl.hostname === 'tiles.virtualearth.net' || templateUrl.hostname.endsWith('.tiles.virtualearth.net'))) {
      throw new UpstreamError('Satellite imagery service returned an invalid tile endpoint');
    }
    const subdomains = Array.isArray(r0.imageUrlSubdomains)
      ? r0.imageUrlSubdomains.filter((x: unknown): x is string => typeof x === 'string' && /^[a-z0-9]{1,8}$/i.test(x)).slice(0, 8)
      : [];
    bingCache = {
      template,
      subdomains: subdomains.length ? subdomains : ['t0'],
      zoomMax: Number.isInteger(r0.zoomMax) ? Math.min(Math.max(r0.zoomMax, 12), 21) : 19,
      expires: Date.now() + 30 * 60_000,
    };
    return bingCache;
  }

  function tileXY(lat: number, lon: number, z: number) {
    const n = 2 ** z;
    const latRad = (lat * Math.PI) / 180;
    return {
      x: Math.floor(((lon + 180) / 360) * n),
      y: Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n),
    };
  }

  function quadkey(x: number, y: number, z: number) {
    let q = '';
    for (let i = z; i > 0; i--) {
      let d = 0;
      const m = 1 << (i - 1);
      if (x & m) d += 1;
      if (y & m) d += 2;
      q += d;
    }
    return q;
  }

  const tileLon = (x: number, z: number) => (x / 2 ** z) * 360 - 180;
  const tileLat = (y: number, z: number) => {
    const n = Math.PI - (2 * Math.PI * y) / 2 ** z;
    return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  };

  async function fetchTile(bing: NonNullable<typeof bingCache>, x: number, y: number, z: number, i: number) {
    const sub = bing.subdomains[i % bing.subdomains.length];
    const url = bing.template.replace('{subdomain}', sub).replace('{quadkey}', quadkey(x, y, z));
    const tileUrl = new URL(url);
    if (tileUrl.protocol !== 'https:' ||
      !(tileUrl.hostname === 'tiles.virtualearth.net' || tileUrl.hostname.endsWith('.tiles.virtualearth.net'))) {
      throw new UpstreamError('Satellite imagery service returned an invalid tile endpoint');
    }
    const { response: res, bytes } = await fetchFixed(tileUrl, { timeoutMs: 12_000, maxBytes: 1_500_000 });
    // Bing flags upsampled/missing tiles with this header — treat as absent.
    if (!res.ok || res.headers.get('x-ve-tile-info') === 'no-tile') return null;
    const buf = Buffer.from(bytes);
    return buf.length > 500 ? buf.toString('base64') : null;
  }

  app.get('/api/satellite', async (req, res) => {
    try {
      const lat = queryNumber(req.query.lat, 'lat', -85, 85);
      const lon = queryNumber(req.query.lon, 'lon', -180, 180);
      const bing = await getBingImagery();
      // Optional coverage bbox (WGS84 deg): fetch a mosaic that fully covers
      // the requested area (the client passes the 3D ground-plane extents so
      // the drape matches the visible ground exactly). Without a bbox, fall
      // back to a small patch around the point (legacy behavior).
      const bboxValues = [
        optionalQueryNumber(req.query.west, 'west', -180, 180),
        optionalQueryNumber(req.query.east, 'east', -180, 180),
        optionalQueryNumber(req.query.north, 'north', -85, 85),
        optionalQueryNumber(req.query.south, 'south', -85, 85),
      ];
      const someBbox = bboxValues.some(v => v !== undefined);
      const hasBbox = bboxValues.every(v => v !== undefined);
      if (someBbox && !hasBbox) throw new InputError('west, east, north and south must be provided together');
      const [west, east, north, south] = bboxValues as [number, number, number, number];
      if (hasBbox && (west >= east || south >= north || east - west > 2 || north - south > 2)) {
        throw new InputError('bbox must be ordered and no larger than 2 degrees');
      }
      // Highest available DPI: start at Bing's max zoom, back off until the
      // coverage grid fits the tile budget AND every tile has real imagery.
      const MAX_TILES = 128;
      let remainingTileFetches = 256;
      for (let z = Math.min(bing.zoomMax, 21); z >= 12; z--) {
        let x0: number, y0: number, cols: number, rows: number;
        if (hasBbox) {
          const nw = tileXY(north, west, z);
          const se = tileXY(south, east, z);
          x0 = nw.x;
          y0 = nw.y;
          cols = se.x - nw.x + 1;
          rows = se.y - nw.y + 1;
          if (cols * rows > MAX_TILES) continue; // too fine for the budget: back off
        } else {
          if (z < 15) break;
          const c = tileXY(lat, lon, z);
          x0 = c.x;
          y0 = c.y - 1;
          cols = 2;
          rows = 3;
        }
        const cells: Array<{ col: number; row: number; x: number; y: number }> = [];
        for (let row = 0; row < rows; row++) {
          for (let col = 0; col < cols; col++) {
            cells.push({ col, row, x: x0 + col, y: y0 + row });
          }
        }
        // Chunked concurrency: hundreds of simultaneous tile fetches would
        // hammer the imagery CDN and risk throttling; eight at a time keeps
        // the request bounded. Bail out of a zoom level early on the first miss.
        const tiles: Array<string | null> = new Array(cells.length).fill(null);
        let missing = false;
        let totalTileBytes = 0;
        for (let i = 0; i < cells.length && !missing; i += 8) {
          const batch = cells.slice(i, i + 8);
          if (batch.length > remainingTileFetches) {
            missing = true;
            break;
          }
          remainingTileFetches -= batch.length;
          const got = await Promise.all(batch.map((cell, j) => fetchTile(bing, cell.x, cell.y, z, i + j)));
          got.forEach((t, j) => {
            tiles[i + j] = t;
            if (t) totalTileBytes += Buffer.byteLength(t, 'base64');
          });
          if (totalTileBytes > 24 * 1024 * 1024) missing = true;
          if (got.some(t => t === null)) missing = true;
        }
        if (missing) continue;
        res.json({
          zoom: z,
          cols,
          rows,
          tileSize: 256,
          tiles: cells.map((cell, i) => ({ col: cell.col, row: cell.row, jpegBase64: tiles[i] })),
          bounds: {
            west: tileLon(x0, z),
            east: tileLon(x0 + cols, z),
            north: tileLat(y0, z),
            south: tileLat(y0 + rows, z),
          },
        });
        return;
      }
      res.status(502).json({ message: 'No aerial imagery available at this location' });
    } catch (e: unknown) {
      res.status(e instanceof InputError ? 400 : 502).json({ message: safeProxyMessage(e, 'Satellite imagery service is unavailable') });
    }
  });

  // -------------------------------------------------------------------------
  // Vicinity map geodata (US Census TIGERweb ArcGIS REST — public domain, no
  // key). Returns counties/state boundaries, primary+secondary highways with
  // route classification, and incorporated-place label points around a site
  // so the client can render the stylized cover-page vicinity map as pure
  // vector geometry. Fails loudly (502) when the upstream is unavailable —
  // never a silent empty map.
  // -------------------------------------------------------------------------
  const TIGERWEB = 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb';
  const vicinityCache = new BoundedTtlCache<unknown>(20, 24 * 1024 * 1024, 15 * 60_000);

  type LonLat = [number, number];

  async function tigerQuery(
    service: 'State_County' | 'Transportation' | 'Places_CouSub_ConCity_SubMCD',
    layer: number,
    bbox: { west: number; south: number; east: number; north: number },
    outFields: string,
    offsetDeg: number
  ) {
    const qs = new URLSearchParams({
      geometry: `${bbox.west},${bbox.south},${bbox.east},${bbox.north}`,
      geometryType: 'esriGeometryEnvelope',
      inSR: '4326',
      outSR: '4326',
      spatialRel: 'esriSpatialRelIntersects',
      outFields,
      returnGeometry: 'true',
      maxAllowableOffset: String(offsetDeg),
      f: 'geojson',
    });
    const url = new URL(`${TIGERWEB}/${service}/MapServer/${layer}/query`);
    url.search = qs.toString();
    const { response, bytes } = await fetchFixed(url, { timeoutMs: 20_000, maxBytes: 4 * 1024 * 1024 });
    if (!response.ok) throw new UpstreamError('Vicinity map service is unavailable');
    const j = parseJson<any>(bytes);
    if (j.error || !Array.isArray(j.features)) throw new UpstreamError('Vicinity map service returned an invalid response');
    return j.features.slice(0, 10_000) as Array<{ properties: any; geometry: any }>;
  }

  // GeoJSON geometry -> flat list of coordinate rings/paths.
  function geomLines(geom: any): LonLat[][] {
    if (!geom) return [];
    if (geom.type === 'Polygon') return geom.coordinates as LonLat[][];
    if (geom.type === 'MultiPolygon') return (geom.coordinates as LonLat[][][]).flat();
    if (geom.type === 'LineString') return [geom.coordinates as LonLat[]];
    if (geom.type === 'MultiLineString') return geom.coordinates as LonLat[][];
    return [];
  }

  // Route classification from the TIGER road NAME ("I- 70", "US Hwy 24",
  // "State Hwy 385", ...). Returns [class, routeNumber|null].
  function classifyRoad(name: string): ['I' | 'U' | 'S' | 'O', string | null] {
    const i = /^I-? ?(\d+)/.exec(name);
    if (i) return ['I', i[1]];
    const u = /US Hwy (\d+)/i.exec(name);
    if (u) return ['U', u[1]];
    const s = /State (?:Hwy|Rte|Loop|Rd) (\d+)/i.exec(name);
    if (s) return ['S', s[1]];
    return ['O', null];
  }

  app.get('/api/vicinity', async (req, res) => {
    try {
      const lat = queryNumber(req.query.lat, 'lat', -72, 72);
      const lon = queryNumber(req.query.lon, 'lon', -180, 180);
      const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
      const cached = vicinityCache.get(key);
      if (cached) {
        res.json(cached);
        return;
      }
      // ~110 mi tall window, widened by cos(lat) so the map is square-ish on
      // the ground — matches the multi-county atlas framing of the reference.
      const halfLat = 0.8;
      const halfLon = 0.8 / Math.cos((lat * Math.PI) / 180);
      const bbox = { west: lon - halfLon, east: lon + halfLon, south: lat - halfLat, north: lat + halfLat };
      const OFFSET = 0.004; // ~1/4 mi simplification: clean lines at cover scale
      const [states, counties, primary, secondary, places] = await Promise.all([
        tigerQuery('State_County', 0, bbox, 'BASENAME', OFFSET),
        tigerQuery('State_County', 1, bbox, 'BASENAME', OFFSET),
        tigerQuery('Transportation', 2, bbox, 'NAME,MTFCC', OFFSET),
        tigerQuery('Transportation', 4, bbox, 'NAME,MTFCC', OFFSET),
        tigerQuery('Places_CouSub_ConCity_SubMCD', 4, bbox, 'BASENAME', 0.02),
      ]);
      const rings = (fs: typeof states) =>
        fs.map(f => ({
          name: String(f.properties?.BASENAME ?? ''),
          rings: geomLines(f.geometry),
        })).filter(x => x.rings.length);
      const roadOf = (f: (typeof primary)[number]) => {
        const name = String(f.properties?.NAME ?? '');
        const [cls, num] = classifyRoad(name);
        return { name, cls, num, paths: geomLines(f.geometry) };
      };
      // Place label points: ring centroid + shoelace area (for prominence
      // ranking client-side). Geometry is dropped from the payload.
      const placePts = places.map(f => {
        const ring = geomLines(f.geometry)[0] ?? [];
        let a = 0, cx = 0, cy = 0;
        for (let i = 0; i < ring.length; i++) {
          const [x1, y1] = ring[i];
          const [x2, y2] = ring[(i + 1) % ring.length];
          const w = x1 * y2 - x2 * y1;
          a += w; cx += (x1 + x2) * w; cy += (y1 + y2) * w;
        }
        if (Math.abs(a) < 1e-12 || !ring.length) return null;
        return {
          name: String(f.properties?.BASENAME ?? ''),
          lon: cx / (3 * a),
          lat: cy / (3 * a),
          area: Math.abs(a) / 2,
        };
      }).filter((p): p is NonNullable<typeof p> => !!p && !!p.name);
      const payload = {
        site: { lat, lon },
        bbox,
        states: rings(states),
        counties: rings(counties),
        roads: [...primary.map(roadOf), ...secondary.map(roadOf)].filter(r => r.paths.length),
        places: placePts,
        source: 'U.S. Census Bureau TIGERweb',
      };
      vicinityCache.set(key, payload);
      res.json(payload);
    } catch (e: unknown) {
      res.status(e instanceof InputError ? 400 : 502).json({ message: safeProxyMessage(e, 'Vicinity map service is unavailable') });
    }
  });

  // -------------------------------------------------------------------------
  // Reverse geocode a site origin to CITY / COUNTY / STATE (US Census
  // TIGERweb ArcGIS REST — public domain, no key). Point-in-polygon queries
  // against the state, county and incorporated-place layers. City is null
  // for rural sites outside any incorporated place. Fails loudly (502) when
  // the upstream is unavailable — the client leaves the typed value alone.
  // -------------------------------------------------------------------------
  const geocodeCache = new BoundedTtlCache<unknown>(50, 512 * 1024, 60 * 60_000);

  async function tigerPointQuery(
    service: 'State_County' | 'Places_CouSub_ConCity_SubMCD',
    layer: number, lat: number, lon: number,
  ) {
    const qs = new URLSearchParams({
      geometry: `${lon},${lat}`,
      geometryType: 'esriGeometryPoint',
      inSR: '4326',
      spatialRel: 'esriSpatialRelIntersects',
      outFields: 'BASENAME',
      returnGeometry: 'false',
      f: 'json',
    });
    const url = new URL(`${TIGERWEB}/${service}/MapServer/${layer}/query`);
    url.search = qs.toString();
    const { response, bytes } = await fetchFixed(url, { timeoutMs: 15_000, maxBytes: 256_000 });
    if (!response.ok) throw new UpstreamError('Geocoding service is unavailable');
    const j = parseJson<any>(bytes);
    if (j.error || !Array.isArray(j.features)) throw new UpstreamError('Geocoding service returned an invalid response');
    const name = j.features?.[0]?.attributes?.BASENAME;
    return typeof name === 'string' && name.trim() ? name.trim().slice(0, 200) : null;
  }

  app.get('/api/geocode', async (req, res) => {
    try {
      const lat = queryNumber(req.query.lat, 'lat', -72, 72);
      const lon = queryNumber(req.query.lon, 'lon', -180, 180);
      const key = `${lat.toFixed(4)},${lon.toFixed(4)}`;
      const cached = geocodeCache.get(key);
      if (cached) {
        res.json(cached);
        return;
      }
      const [state, county, city] = await Promise.all([
        tigerPointQuery('State_County', 0, lat, lon),
        tigerPointQuery('State_County', 1, lat, lon),
        tigerPointQuery('Places_CouSub_ConCity_SubMCD', 4, lat, lon),
      ]);
      if (!state || !county) {
        res.status(404).json({ message: 'No US county found at this location' });
        return;
      }
      const payload = { city, county, state, source: 'U.S. Census Bureau TIGERweb' };
      geocodeCache.set(key, payload);
      res.json(payload);
    } catch (e: unknown) {
      res.status(e instanceof InputError ? 400 : 502).json({ message: safeProxyMessage(e, 'Geocoding service is unavailable') });
    }
  });

  // -------------------------------------------------------------------------
  // Elevation grid for the site vicinity (USGS 3DEP ImageServer — public
  // domain, no key). Returns a JSON grid of elevations in FEET (row-major,
  // row 0 = north) for the requested WGS84 bbox. No-data cells come back as
  // null so the client can disclose coverage gaps — never silently faked.
  // -------------------------------------------------------------------------
  const USGS_3DEP =
    'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage';
  const M_TO_FT = 3.28084;
  const elevationCache = new BoundedTtlCache<unknown>(40, 28 * 1024 * 1024, 30 * 60_000);

  app.get('/api/elevation', async (req, res) => {
    try {
      const west = queryNumber(req.query.west, 'west', -180, 180);
      const east = queryNumber(req.query.east, 'east', -180, 180);
      const south = queryNumber(req.query.south, 'south', -85, 85);
      const north = queryNumber(req.query.north, 'north', -85, 85);
      const parsedSize = optionalQueryNumber(req.query.size, 'size', 16, 256);
      if (parsedSize !== undefined && !Number.isInteger(parsedSize)) throw new InputError('size must be a whole number');
      const size = parsedSize ?? 96;
      if (west >= east || south >= north || east - west >= 2 || north - south >= 2) {
        throw new InputError('bbox must be ordered and smaller than 2 degrees');
      }
      const key = [west, east, south, north].map(v => v.toFixed(6)).join(',') + `|${size}`;
      const cached = elevationCache.get(key);
      if (cached) {
        res.json(cached);
        return;
      }
      const qs = new URLSearchParams({
        bbox: `${west},${south},${east},${north}`,
        bboxSR: '4326',
        imageSR: '4326',
        size: `${size},${size}`,
        format: 'tiff',
        pixelType: 'F32',
        noDataInterpretation: 'esriNoDataMatchAny',
        interpolation: 'RSP_BilinearInterpolation',
        f: 'image',
      });
      const url = new URL(USGS_3DEP);
      url.search = qs.toString();
      const { response: upstream, bytes } = await fetchFixed(url, { timeoutMs: 30_000, maxBytes: 32 * 1024 * 1024 });
      const ctype = upstream.headers.get('content-type') ?? '';
      // Upstream content-type varies (image/tiff, image/tif, occasionally
      // octet-stream); accept those and let the GeoTIFF parser be the real
      // validity check. Reject only obvious non-image bodies (HTML/JSON errors).
      const looksTiff = ctype.includes('tif') || ctype.includes('octet-stream') || ctype === '';
      if (!upstream.ok || !looksTiff) {
        throw new UpstreamError('USGS 3DEP elevation service is unavailable');
      }
      const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      const { fromArrayBuffer } = await import('geotiff');
      const tiff = await fromArrayBuffer(buf);
      const img = await tiff.getImage();
      const rasters = await img.readRasters();
      const raw = rasters[0] as Float32Array;
      const width = img.getWidth();
      const height = img.getHeight();
      if (width < 1 || height < 1 || width > 256 || height > 256 || raw.length !== width * height) {
        throw new UpstreamError('Elevation service returned an invalid grid');
      }
      // 3DEP no-data is a float extreme; anything outside plausible Earth
      // elevations (meters) is treated as no data.
      const valuesFt: Array<number | null> = Array.from(raw, m =>
        Number.isFinite(m) && m > -500 && m < 9000 ? Math.round(m * M_TO_FT * 100) / 100 : null
      );
      if (valuesFt.every(v => v === null)) {
        res.status(502).json({ message: 'No elevation data available at this location (outside USGS 3DEP coverage).' });
        return;
      }
      // Approx source resolution: bbox height in meters / rows
      const resolutionM = ((north - south) * 111320) / height;
      const payload = {
        width,
        height,
        bounds: { west, east, south, north },
        valuesFt,
        source: 'USGS 3DEP (1/3 arc-second)',
        resolutionM: Math.round(resolutionM * 10) / 10,
      };
      elevationCache.set(key, payload);
      res.json(payload);
    } catch (e: unknown) {
      res.status(e instanceof InputError ? 400 : 502).json({
        message: safeProxyMessage(e, 'USGS 3DEP elevation service is unavailable'),
      });
    }
  });

  // -------------------------------------------------------------------------
  // NOAA Atlas 14 point precipitation-frequency estimates (PFDS — public
  // domain, no key). Proxies the intensity CSV for a lat/lon so the client
  // can parse a real IDF table for the design storm instead of a hand-typed
  // single intensity. Raw CSV is returned untouched (the client parser is
  // the validity check) — never silently faked.
  // -------------------------------------------------------------------------
  const NOAA_PFDS = 'https://hdsc.nws.noaa.gov/cgi-bin/new/fe_text_mean.csv';
  const rainfallCache = new BoundedTtlCache<unknown>(60, 12 * 1024 * 1024, 60 * 60_000);

  app.get('/api/rainfall', async (req, res) => {
    try {
      const lat = queryNumber(req.query.lat, 'lat', 15, 72);
      const lon = queryNumber(req.query.lon, 'lon', -180, -60);
      const key = `${lat.toFixed(4)},${lon.toFixed(4)}`;
      const cached = rainfallCache.get(key);
      if (cached) {
        res.json(cached);
        return;
      }
      const qs = new URLSearchParams({
        lat: String(lat), lon: String(lon),
        data: 'intensity', units: 'english', series: 'pds',
      });
      const url = new URL(NOAA_PFDS);
      url.search = qs.toString();
      const { response: upstream, bytes } = await fetchFixed(url, {
        timeoutMs: 25_000,
        maxBytes: 2 * 1024 * 1024,
        redirect: 'error',
      });
      const text = new TextDecoder().decode(bytes);
      if (!upstream.ok || !text.includes('PRECIPITATION FREQUENCY ESTIMATES')) {
        throw new UpstreamError('Rainfall service is unavailable');
      }
      const payload = { lat, lon, csv: text, source: 'NOAA Atlas 14 PFDS (partial-duration series, english units)' };
      rainfallCache.set(key, payload);
      res.json(payload);
    } catch (e: unknown) {
      res.status(e instanceof InputError ? 400 : 502).json({ message: safeProxyMessage(e, 'Rainfall service is unavailable') });
    }
  });

  // Create HTTP server
  const httpServer = createServer(app);

  return httpServer;
}
