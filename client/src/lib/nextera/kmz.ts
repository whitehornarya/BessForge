import JSZip from 'jszip';
import { Pt, SiteBoundary } from './types';

// Parse a KMZ (zipped KML) file and extract the first polygon as the site boundary.
// Coordinates are projected to a local frame in FEET using an equirectangular
// projection about the polygon centroid (adequate for parcel-scale sites).
export async function parseKmz(file: File): Promise<SiteBoundary> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(file);
  } catch {
    throw new Error(
      `"${file.name}" is not a valid KMZ archive — the file could not be opened as a zip. ` +
      'Export the site boundary from Google Earth as a .kmz (or .kml) file and try again.'
    );
  }
  const kmlEntry =
    Object.values(zip.files).find(f => f.name.toLowerCase().endsWith('.kml')) || null;
  if (!kmlEntry) throw new Error('No KML file found inside the KMZ — the archive does not contain a site boundary. Re-export the parcel from Google Earth.');

  const kmlText = await kmlEntry.async('text');
  return parseKmlText(kmlText, file.name.replace(/\.kmz$/i, ''));
}

// Extract the raw KML text from a KMZ (or pass through a .kml file), so the
// caller can list boundary options before choosing which polygon to parse.
export async function extractKmlText(file: File): Promise<string> {
  if (file.name.toLowerCase().endsWith('.kml')) return file.text();
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(file);
  } catch {
    throw new Error(
      `"${file.name}" is not a valid KMZ archive — the file could not be opened as a zip. ` +
      'Export the site boundary from Google Earth as a .kmz (or .kml) file and try again.'
    );
  }
  const kmlEntry =
    Object.values(zip.files).find(f => f.name.toLowerCase().endsWith('.kml')) || null;
  if (!kmlEntry) throw new Error('No KML file found inside the KMZ — the archive does not contain a site boundary. Re-export the parcel from Google Earth.');
  return kmlEntry.async('text');
}

export interface BoundaryOption {
  index: number;      // polygon index within the KML (parseKmlText input)
  name: string;       // owning Placemark name (or a generic fallback)
  areaAcres: number;
}

interface DenseKmlPolygon {
  index: number;
  name: string;
  lonLat: { lon: number; lat: number }[];
}

interface DenseKmlScan {
  records: DenseKmlPolygon[];
  location: string | null;
}

// Google Earth CAD exports can carry thousands of LineStrings for labels,
// hatches, and equipment outlines alongside a handful of real Polygon
// footprints. Building a DOM for those 20+ MB KML files is enough to starve a
// WebGL page on some machines. Keep the established DOM path for ordinary
// boundary files; this narrow scan only activates for unusually dense exports.
const DENSE_KML_BYTES = 1_000_000;
let denseKmlCache: { text: string; scan: DenseKmlScan } | null = null;

function stripKmlMarkup(value: string): string {
  return value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]*>/g, '').trim();
}

function lonLatFromCoordinates(coordsText: string): { lon: number; lat: number }[] | null {
  const lonLat = coordsText
    .trim()
    .split(/\s+/)
    .map(tok => {
      const parts = tok.split(',');
      return { lon: parseFloat(parts[0]), lat: parseFloat(parts[1]) };
    })
    .filter(p => Number.isFinite(p.lon) && Number.isFinite(p.lat));
  if (lonLat.length < 3) return null;
  const first = lonLat[0];
  const last = lonLat[lonLat.length - 1];
  if (Math.abs(first.lon - last.lon) < 1e-9 && Math.abs(first.lat - last.lat) < 1e-9) lonLat.pop();
  return lonLat.length >= 3 ? lonLat : null;
}

function scanDenseKml(kmlText: string): DenseKmlScan {
  if (denseKmlCache?.text === kmlText) return denseKmlCache.scan;

  const records: DenseKmlPolygon[] = [];
  const placemarkRe = /<Placemark\b[^>]*>([\s\S]*?)<\/Placemark>/gi;
  let placemark: RegExpExecArray | null;
  let polygonIndex = 0;
  while ((placemark = placemarkRe.exec(kmlText)) !== null) {
    const body = placemark[1];
    const nameMatch = body.match(/<name\b[^>]*>([\s\S]*?)<\/name>/i);
    const name = nameMatch ? stripKmlMarkup(nameMatch[1]) : '';
    const polygonRe = /<Polygon\b[^>]*>([\s\S]*?)<\/Polygon>/gi;
    let polygon: RegExpExecArray | null;
    while ((polygon = polygonRe.exec(body)) !== null) {
      const outer = polygon[1].match(
        /<outerBoundaryIs\b[^>]*>[\s\S]*?<coordinates\b[^>]*>([\s\S]*?)<\/coordinates>/i
      ) ?? polygon[1].match(/<coordinates\b[^>]*>([\s\S]*?)<\/coordinates>/i);
      const lonLat = outer ? lonLatFromCoordinates(outer[1]) : null;
      if (lonLat) records.push({ index: polygonIndex, name, lonLat });
      polygonIndex++;
    }
  }
  const address = kmlText.match(/<address\b[^>]*>([\s\S]*?)<\/address>/i);
  const scan = { records, location: address ? stripKmlMarkup(address[1]) || null : null };
  denseKmlCache = { text: kmlText, scan };
  return scan;
}

function denseScanFor(kmlText: string): DenseKmlScan | null {
  return kmlText.length >= DENSE_KML_BYTES ? scanDenseKml(kmlText) : null;
}

function acresForLonLat(lonLat: { lon: number; lat: number }[]): number {
  const lat0 = lonLat.reduce((s, p) => s + p.lat, 0) / lonLat.length;
  const kY = 364000;
  const kX = kY * Math.cos((lat0 * Math.PI) / 180);
  let a = 0;
  for (let j = 0; j < lonLat.length; j++) {
    const p = lonLat[j], q = lonLat[(j + 1) % lonLat.length];
    a += p.lon * kX * (q.lat * kY) - q.lon * kX * (p.lat * kY);
  }
  return Math.abs(a / 2) / 43560;
}

function denseBoundaryOptions(kmlText: string, scan: DenseKmlScan): BoundaryOption[] {
  const options = scan.records.flatMap(record => {
    const acres = acresForLonLat(record.lonLat);
    if (acres < 0.5 || acres > 20000) return [];
    return [{
      index: record.index,
      name: record.name || `Boundary ${record.index + 1}`,
      areaAcres: acres,
    }];
  });
  // A full site-layout export includes all sorts of CAD geometry (roads,
  // gates, generators, cooling pads) as polygons. When it explicitly names
  // both BESS and substation footprints, those are the site design areas—not
  // the surrounding parcel line or each drawn component.
  const designAreas = options.filter(o => inferAreaKind(o.name) !== 'other');
  const hasBess = designAreas.some(o => inferAreaKind(o.name) === 'bess');
  const hasSubstation = designAreas.some(o => inferAreaKind(o.name) === 'substation');
  return hasBess && hasSubstation ? designAreas : options;
}

// List every polygon in the KML that could serve as a site boundary (parcel
// scale, non-degenerate), with its owning placemark name and acreage, so the
// user can choose when a KMZ contains multiple boundaries.
export function listKmlBoundaryOptions(kmlText: string): BoundaryOption[] {
  const dense = denseScanFor(kmlText);
  if (dense) return denseBoundaryOptions(kmlText, dense);
  const dom = new DOMParser().parseFromString(kmlText, 'text/xml');
  const polygons = dom.getElementsByTagName('Polygon');
  const options: BoundaryOption[] = [];
  for (let i = 0; i < polygons.length; i++) {
    const outer = polygons[i].getElementsByTagName('outerBoundaryIs')[0] || polygons[i];
    const coordsText = outer.getElementsByTagName('coordinates')[0]?.textContent?.trim();
    if (!coordsText) continue;
    const pts = coordsText.split(/\s+/).map(tok => {
      const parts = tok.split(',');
      return { lon: parseFloat(parts[0]), lat: parseFloat(parts[1]) };
    });
    if (pts.length < 3 || pts.some(p => !Number.isFinite(p.lon) || !Number.isFinite(p.lat))) continue;
    const lat0 = pts.reduce((s, p) => s + p.lat, 0) / pts.length;
    const kY = 364000;
    const kX = kY * Math.cos((lat0 * Math.PI) / 180);
    let a = 0;
    for (let j = 0; j < pts.length; j++) {
      const p = pts[j], q = pts[(j + 1) % pts.length];
      a += p.lon * kX * (q.lat * kY) - q.lon * kX * (p.lat * kY);
    }
    const acres = Math.abs(a / 2) / 43560;
    // Same usability window parseKmlText enforces
    if (acres < 0.5 || acres > 20000) continue;
    let node: Element | null = polygons[i] as Element;
    while (node && node.nodeName !== 'Placemark') node = node.parentNode as Element | null;
    const nm = (node && directChildText(node, 'name')?.trim()) || `Boundary ${options.length + 1}`;
    options.push({ index: i, name: nm, areaAcres: acres });
  }
  return options;
}

// ---------------------------------------------------------------------------
// Imported reference drawing.
//
// A KMZ issued from CAD is a whole site drawing, not a boundary file: the
// customer's Big Iron export carries ~137,000 LineStrings and 96 Polygons
// across named layers (ROAD, DC-1 250MW, BESS CONTAINER, MV ROUTE, easements,
// survey monuments, parcel lines, and the CAD text traced as linework).
// Boundary parsing keeps only the polygons it can lay out on, which threw away
// everything the drafter actually drew.
//
// This captures EVERY geometry feature, grouped by its placemark/layer name,
// projected into the SAME local frame as the imported areas so it registers
// with the boundaries, generated equipment and imagery.
//
// It is reference geometry only: display-layer state that never feeds layout,
// routing, compliance or export geometry.
export interface DrawingLayer {
  name: string;
  // Each polyline is a flat [x0, y0, x1, y1, ...] run in local feet. Flat
  // arrays (not Pt objects) keep a 260k-vertex drawing cheap to hold and let
  // the renderer fill a merged buffer without a per-vertex object walk.
  polylines: number[][];
  closedFlags: boolean[]; // polygon rings close back to their first vertex
  // Degenerate single-coordinate features, flat [x0, y0, x1, y1, ...]. A CAD
  // export is full of them (the Big Iron file carries ~50,000 — node/marker
  // dots from the conversion). They cannot be drawn as line segments, so they
  // are kept separately and rendered as points rather than silently dropped.
  points: number[];
  featureCount: number;
  vertexCount: number;
}

export interface ImportedDrawing {
  sourceName: string;
  origin: { lat: number; lon: number };
  layers: DrawingLayer[];
  featureCount: number;
  vertexCount: number;
  // Bounds in local feet, for framing/diagnostics.
  bounds: { minX: number; maxX: number; minY: number; maxY: number };
  // Client-declared system ratings scraped from the package's sheet-info
  // text (title block / SYSTEM SPECIFICATIONS table carried in a placemark
  // description). When present, the auto-fill uses these to rate the traced
  // yard (declared MW split across built PCS) instead of the tool's own
  // block rating — the sheet is the client's authority on nameplate.
  sheetSpecs?: SheetSpecs;
}

export interface SheetSpecs {
  acRatingMW?: number;
  storedMWh?: number;
  durationHours?: number;
}

// Pull declared system ratings out of sheet text ("SYSTEM AC RATING AT POI
// (MW) ... 500"). The text arrives as HTML-ish CDATA with <br/> separators;
// values follow their label either on the same line or the next non-empty
// one. Returns undefined when nothing parses — absence must cost nothing.
export function parseSheetSpecs(descriptionText: string): SheetSpecs | undefined {
  const lines = descriptionText
    .replace(/<[^>]*>/g, '\n')
    .split(/[\n—]+/)
    .map(s => s.trim())
    .filter(Boolean);
  const grab = (label: RegExp): number | undefined => {
    for (let i = 0; i < lines.length; i++) {
      if (!label.test(lines[i])) continue;
      // Value on the same line after the label, else the next 1-2 lines.
      const tail = lines[i].replace(label, '');
      for (const cand of [tail, lines[i + 1] ?? '', lines[i + 2] ?? '']) {
        const m = cand.match(/-?\d+(?:,\d{3})*(?:\.\d+)?/);
        if (m) {
          const v = parseFloat(m[0].replace(/,/g, ''));
          if (Number.isFinite(v) && v > 0) return v;
        }
        // A different label starting before any number means the value is
        // missing — stop rather than stealing the next row's figure.
        if (/[A-Z]{4}/.test(cand)) break;
      }
      return undefined;
    }
    return undefined;
  };
  const specs: SheetSpecs = {};
  const ac = grab(/SYSTEM\s+AC\s+RATING[^0-9]*/i);
  const mwh = grab(/SYSTEM\s+STORED\s+CAPACITY[^0-9]*/i);
  const dur = grab(/STORAGE\s+DURATION[^0-9]*/i);
  if (ac !== undefined) specs.acRatingMW = ac;
  if (mwh !== undefined) specs.storedMWh = mwh;
  if (dur !== undefined) specs.durationHours = dur;
  return Object.keys(specs).length ? specs : undefined;
}

// Parse every Polygon ring and LineString in the KML into layer-grouped
// polylines about `origin` (the shared projection origin of the imported
// areas). Placemark names become layer names; unnamed placemarks collect
// under a single generic layer rather than being dropped.
export function parseKmlDrawing(
  kmlText: string,
  sourceName: string,
  origin: { lat: number; lon: number }
): ImportedDrawing {
  const FT_PER_DEG_LAT = 364000;
  const ftPerDegLon = FT_PER_DEG_LAT * Math.cos((origin.lat * Math.PI) / 180);

  const byName = new Map<string, DrawingLayer>();
  let sheetSpecs: SheetSpecs | undefined;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  let featureCount = 0;
  let vertexCount = 0;

  const addRun = (layerName: string, coordsText: string, closed: boolean) => {
    const flat: number[] = [];
    // Manual tokenizer: split/map/filter over 137k coordinate lists allocates
    // millions of short-lived strings and objects on the import path.
    const tokens = coordsText.split(/\s+/);
    for (const tok of tokens) {
      if (!tok) continue;
      const c1 = tok.indexOf(',');
      if (c1 < 0) continue;
      const lon = parseFloat(tok.slice(0, c1));
      const c2 = tok.indexOf(',', c1 + 1);
      const lat = parseFloat(c2 < 0 ? tok.slice(c1 + 1) : tok.slice(c1 + 1, c2));
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
      const x = (lon - origin.lon) * ftPerDegLon;
      const y = (lat - origin.lat) * FT_PER_DEG_LAT;
      flat.push(x, y);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    if (flat.length < 2) return; // no usable coordinate at all
    let layer = byName.get(layerName);
    if (!layer) {
      layer = { name: layerName, polylines: [], closedFlags: [], points: [], featureCount: 0, vertexCount: 0 };
      byName.set(layerName, layer);
    }
    if (flat.length === 2) {
      // Single coordinate: keep it as a point marker.
      layer.points.push(flat[0], flat[1]);
    } else {
      // CAD exports often draw closed shapes (equipment rectangles, pads) as
      // LineStrings whose last vertex lands back on the first. Treat those as
      // closed rings so the auto-fill tracer sees them as real outlines.
      const n = flat.length / 2;
      const ringLike = !closed && n >= 4 &&
        Math.hypot(flat[0] - flat[2 * n - 2], flat[1] - flat[2 * n - 1]) < 2;
      layer.polylines.push(flat);
      layer.closedFlags.push(closed || ringLike);
    }
    layer.featureCount++;
    layer.vertexCount += flat.length / 2;
    featureCount++;
    vertexCount += flat.length / 2;
  };

  const placemarkRe = /<Placemark\b[^>]*>([\s\S]*?)<\/Placemark>/gi;
  let placemark: RegExpExecArray | null;
  while ((placemark = placemarkRe.exec(kmlText)) !== null) {
    const body = placemark[1];
    const nameMatch = body.match(/<name\b[^>]*>([\s\S]*?)<\/name>/i);
    const layerName = (nameMatch ? stripKmlMarkup(nameMatch[1]) : '') || 'Unnamed';

    // Sheet-info placemarks carry the package's title-block text in their
    // description — scrape declared system ratings the first time one parses.
    if (!sheetSpecs && /SYSTEM\s+SPECIFICATIONS/i.test(body)) {
      const desc = body.match(/<description\b[^>]*>([\s\S]*?)<\/description>/i);
      if (desc) sheetSpecs = parseSheetSpecs(desc[1]);
    }

    // Polygon rings (outer and any inner holes) close back on themselves.
    const polygonRe = /<Polygon\b[^>]*>([\s\S]*?)<\/Polygon>/gi;
    let polygon: RegExpExecArray | null;
    while ((polygon = polygonRe.exec(body)) !== null) {
      const ringRe = /<coordinates\b[^>]*>([\s\S]*?)<\/coordinates>/gi;
      let ring: RegExpExecArray | null;
      while ((ring = ringRe.exec(polygon[1])) !== null) addRun(layerName, ring[1], true);
    }

    // LineStrings — the bulk of a CAD export (roads, equipment outlines,
    // easements, monuments and traced drawing text).
    const lineRe = /<LineString\b[^>]*>([\s\S]*?)<\/LineString>/gi;
    let line: RegExpExecArray | null;
    while ((line = lineRe.exec(body)) !== null) {
      const coords = line[1].match(/<coordinates\b[^>]*>([\s\S]*?)<\/coordinates>/i);
      if (coords) addRun(layerName, coords[1], false);
    }
  }

  const layers = Array.from(byName.values()).sort((a, b) => b.vertexCount - a.vertexCount);
  return {
    sourceName,
    origin,
    layers,
    featureCount,
    vertexCount,
    bounds: featureCount
      ? { minX, maxX, minY, maxY }
      : { minX: 0, maxX: 0, minY: 0, maxY: 0 },
    ...(sheetSpecs ? { sheetSpecs } : {}),
  };
}

export type SiteAreaKind = 'bess' | 'substation' | 'other';

// Classify a phase footprint from its placemark name so a multi-area import
// knows which outlines get a BESS layout and which are substation yards.
export function inferAreaKind(name: string): SiteAreaKind {
  const n = (name || '').toLowerCase();
  if (/sub\s*station|substation|\bsub\b|switchyard/.test(n)) return 'substation';
  if (/bess|battery|storage|phase/.test(n)) return 'bess';
  return 'other';
}

// Read one Polygon's outer ring as lon/lat, with the duplicated closing point
// dropped. Returns null when the ring is missing or degenerate.
function polygonLonLat(poly: Element): { lon: number; lat: number }[] | null {
  const outer = poly.getElementsByTagName('outerBoundaryIs')[0] || poly;
  const coordsText = outer.getElementsByTagName('coordinates')[0]?.textContent;
  if (!coordsText) return null;
  const lonLat = coordsText
    .trim()
    .split(/\s+/)
    .map(tok => {
      const parts = tok.split(',');
      return { lon: parseFloat(parts[0]), lat: parseFloat(parts[1]) };
    })
    .filter(p => Number.isFinite(p.lon) && Number.isFinite(p.lat));
  if (lonLat.length < 3) return null;
  const first = lonLat[0];
  const last = lonLat[lonLat.length - 1];
  if (Math.abs(first.lon - last.lon) < 1e-9 && Math.abs(first.lat - last.lat) < 1e-9) lonLat.pop();
  return lonLat.length >= 3 ? lonLat : null;
}

// Parse SEVERAL polygons into ONE shared local frame.
//
// parseKmlText re-centres every polygon on its OWN centroid, which is correct
// for a single parcel but collapses a multi-area site: six footprints would
// all land on top of each other at the origin. Here the projection origin is
// the centroid of every selected ring combined, so each area keeps its true
// separation and bearing relative to the others and the whole site can be
// designed as one project.
export function parseKmlAreas(
  kmlText: string,
  sourceName: string,
  indices: number[]
): SiteBoundary[] {
  const dense = denseScanFor(kmlText);
  if (dense) {
    const wanted = new Set(indices);
    const rings = dense.records
      .filter(record => wanted.has(record.index))
      .map(record => ({ idx: record.index, lonLat: record.lonLat, name: record.name }));
    if (!rings.length) {
      throw new Error('None of the selected outlines had usable coordinates — re-export the KMZ from Google Earth.');
    }
    const all = rings.flatMap(r => r.lonLat);
    const origin = {
      lat: all.reduce((s, p) => s + p.lat, 0) / all.length,
      lon: all.reduce((s, p) => s + p.lon, 0) / all.length,
    };
    const ftPerDegLon = 364000 * Math.cos((origin.lat * Math.PI) / 180);
    const location = dense.location || formatLatLon(origin.lat, origin.lon);
    const out: SiteBoundary[] = [];
    for (const ring of rings) {
      const polygon = ring.lonLat.map(p => ({
        x: (p.lon - origin.lon) * ftPerDegLon,
        y: (p.lat - origin.lat) * 364000,
      }));
      const areaSqFt = Math.abs(polygonArea(polygon));
      if (areaSqFt < 100 || !polygon.every(p => Number.isFinite(p.x) && Number.isFinite(p.y))) continue;
      const name = ring.name || `${sourceName} area ${out.length + 1}`;
      out.push({ name, polygon, origin, areaAcres: areaSqFt / 43560, kmlName: name, location });
    }
    if (!out.length) {
      throw new Error('The selected outlines were all degenerate (near-zero area) — draw closed polygons and re-export.');
    }
    return out;
  }
  const dom = new DOMParser().parseFromString(kmlText, 'text/xml');
  const polygons = dom.getElementsByTagName('Polygon');
  if (!polygons.length) {
    throw new Error('No Polygon found in KML — the KMZ must contain site boundary polygons');
  }

  const rings: { idx: number; lonLat: { lon: number; lat: number }[] }[] = [];
  for (const idx of indices) {
    if (idx < 0 || idx >= polygons.length) continue;
    const lonLat = polygonLonLat(polygons[idx]);
    if (lonLat) rings.push({ idx, lonLat });
  }
  if (!rings.length) {
    throw new Error('None of the selected outlines had usable coordinates — re-export the KMZ from Google Earth.');
  }

  // Shared projection origin: centroid of every selected ring's vertices.
  const all = rings.flatMap(r => r.lonLat);
  const origin = {
    lat: all.reduce((s, p) => s + p.lat, 0) / all.length,
    lon: all.reduce((s, p) => s + p.lon, 0) / all.length,
  };
  const FT_PER_DEG_LAT = 364000;
  const ftPerDegLon = FT_PER_DEG_LAT * Math.cos((origin.lat * Math.PI) / 180);

  const location = extractKmlLocation(dom) || formatLatLon(origin.lat, origin.lon);
  const out: SiteBoundary[] = [];
  for (const { idx, lonLat } of rings) {
    const polygon: Pt[] = lonLat.map(p => ({
      x: (p.lon - origin.lon) * ftPerDegLon,
      y: (p.lat - origin.lat) * FT_PER_DEG_LAT,
    }));
    if (!polygon.every(p => Number.isFinite(p.x) && Number.isFinite(p.y))) continue;
    const areaSqFt = Math.abs(polygonArea(polygon));
    if (areaSqFt < 100) continue;
    const nm = extractKmlName(dom, idx) || `${sourceName} area ${out.length + 1}`;
    out.push({
      name: nm,
      polygon,
      origin,
      areaAcres: areaSqFt / 43560,
      kmlName: nm,
      location,
    });
  }
  if (!out.length) {
    throw new Error('The selected outlines were all degenerate (near-zero area) — draw closed polygons and re-export.');
  }
  return out;
}

export function parseKmlText(kmlText: string, name: string, polygonIndex = 0): SiteBoundary {
  const dense = denseScanFor(kmlText);
  if (dense) {
    const record = dense.records.find(r => r.index === polygonIndex);
    if (!record) {
      throw new Error(`Boundary polygon #${polygonIndex} not found in KML (file has ${dense.records.length}).`);
    }
    const origin = {
      lat: record.lonLat.reduce((s, p) => s + p.lat, 0) / record.lonLat.length,
      lon: record.lonLat.reduce((s, p) => s + p.lon, 0) / record.lonLat.length,
    };
    const ftPerDegLon = 364000 * Math.cos((origin.lat * Math.PI) / 180);
    const polygon = record.lonLat.map(p => ({
      x: (p.lon - origin.lon) * ftPerDegLon,
      y: (p.lat - origin.lat) * 364000,
    }));
    const areaSqFt = Math.abs(polygonArea(polygon));
    const acres = areaSqFt / 43560;
    if (!polygon.every(p => Number.isFinite(p.x) && Number.isFinite(p.y))) {
      throw new Error('Boundary polygon contains invalid coordinates — re-export the KMZ from Google Earth.');
    }
    if (areaSqFt < 100) {
      throw new Error('Boundary polygon is degenerate (near-zero area) — the points are collinear or duplicated. Draw a closed parcel polygon and re-export.');
    }
    if (acres < 0.5 || acres > 20000) {
      throw new Error(acres < 0.5
        ? `Site boundary is only ${acres.toFixed(2)} acres — too small for a BESS yard. Check that the polygon was drawn at parcel scale (the tool expects roughly 1–20,000 acres).`
        : `Site boundary is ${Math.round(acres).toLocaleString()} acres — far larger than a parcel. The polygon may be a region or state outline; upload the parcel boundary instead.`);
    }
    return {
      name,
      polygon,
      origin,
      areaAcres: acres,
      kmlName: record.name || name,
      location: dense.location || formatLatLon(origin.lat, origin.lon),
    };
  }
  const dom = new DOMParser().parseFromString(kmlText, 'text/xml');

  // Find the selected Polygon's outer boundary coordinates (defaults to the
  // first polygon; multi-boundary KMZs pick one via listKmlBoundaryOptions).
  const polygons = dom.getElementsByTagName('Polygon');
  if (!polygons.length) throw new Error('No Polygon found in KML — the KMZ must contain a site boundary polygon');
  if (polygonIndex < 0 || polygonIndex >= polygons.length) {
    throw new Error(`Boundary polygon #${polygonIndex} not found in KML (file has ${polygons.length}).`);
  }

  let coordsText: string | null = null;
  const poly = polygons[polygonIndex];
  const outer = poly.getElementsByTagName('outerBoundaryIs')[0] || poly;
  const coordsEl = outer.getElementsByTagName('coordinates')[0];
  if (coordsEl?.textContent) coordsText = coordsEl.textContent;
  if (!coordsText) throw new Error('Polygon has no coordinates');

  const lonLat: { lon: number; lat: number }[] = coordsText
    .trim()
    .split(/\s+/)
    .map(tok => {
      const parts = tok.split(',');
      const lon = parseFloat(parts[0]);
      const lat = parseFloat(parts[1]);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
        throw new Error(
          `Boundary polygon has an invalid coordinate ("${tok}") — the KML coordinate list is corrupted. Re-export the KMZ from Google Earth.`
        );
      }
      return { lon, lat };
    });

  if (lonLat.length < 3) throw new Error('Boundary polygon has fewer than 3 points');

  // Drop duplicated closing point
  const first = lonLat[0];
  const last = lonLat[lonLat.length - 1];
  if (Math.abs(first.lon - last.lon) < 1e-9 && Math.abs(first.lat - last.lat) < 1e-9) {
    lonLat.pop();
  }

  // Centroid as projection origin
  const origin = {
    lat: lonLat.reduce((s, p) => s + p.lat, 0) / lonLat.length,
    lon: lonLat.reduce((s, p) => s + p.lon, 0) / lonLat.length,
  };

  const FT_PER_DEG_LAT = 364000; // ~69 miles
  const ftPerDegLon = FT_PER_DEG_LAT * Math.cos((origin.lat * Math.PI) / 180);

  const polygon: Pt[] = lonLat.map(p => ({
    x: (p.lon - origin.lon) * ftPerDegLon,
    y: (p.lat - origin.lat) * FT_PER_DEG_LAT,
  }));

  const areaSqFt = Math.abs(polygonArea(polygon));
  const acres = areaSqFt / 43560;
  // Reject unusable boundaries with actionable messages instead of loading
  // an empty/degenerate site.
  if (!polygon.every(p => Number.isFinite(p.x) && Number.isFinite(p.y))) {
    throw new Error('Boundary polygon contains invalid coordinates — re-export the KMZ from Google Earth.');
  }
  if (areaSqFt < 100) {
    throw new Error('Boundary polygon is degenerate (near-zero area) — the points are collinear or duplicated. Draw a closed parcel polygon and re-export.');
  }
  if (acres < 0.5) {
    throw new Error(`Site boundary is only ${acres.toFixed(2)} acres — too small for a BESS yard. Check that the polygon was drawn at parcel scale (the tool expects roughly 1–20,000 acres).`);
  }
  if (acres > 20000) {
    throw new Error(`Site boundary is ${Math.round(acres).toLocaleString()} acres — far larger than a parcel. The polygon may be a region or state outline; upload the parcel boundary instead.`);
  }
  return {
    name,
    polygon,
    origin,
    areaAcres: areaSqFt / 43560,
    kmlName: extractKmlName(dom, polygonIndex) || name,
    location: extractKmlLocation(dom) || formatLatLon(origin.lat, origin.lon),
  };
}

// Project name: prefer the Placemark that owns the boundary polygon, then the
// Document/Folder name. Generic viewer defaults ("Untitled...", "doc") are skipped.
function extractKmlName(dom: Document, polygonIndex = 0): string | null {
  const isUseful = (s: string | null | undefined): s is string => {
    const t = (s || '').trim();
    return t.length > 0 && !/^(untitled|doc|new folder|my places|temporary places)/i.test(t);
  };
  const poly = dom.getElementsByTagName('Polygon')[polygonIndex];
  // Walk up from the polygon to its Placemark
  let node: Element | null = poly;
  while (node && node.nodeName !== 'Placemark') node = node.parentNode as Element | null;
  if (node) {
    const nm = directChildText(node, 'name');
    if (isUseful(nm)) return nm.trim();
  }
  for (const tag of ['Document', 'Folder']) {
    const els = dom.getElementsByTagName(tag);
    for (let i = 0; i < els.length; i++) {
      const nm = directChildText(els[i], 'name');
      if (isUseful(nm)) return nm.trim();
    }
  }
  return null;
}

// Location: prefer an explicit <address> tag; otherwise null (caller falls
// back to formatted lat/lon of the site centroid).
function extractKmlLocation(dom: Document): string | null {
  const addr = dom.getElementsByTagName('address')[0]?.textContent?.trim();
  return addr || null;
}

function directChildText(el: Element, tag: string): string | null {
  for (let i = 0; i < el.childNodes.length; i++) {
    const c = el.childNodes[i];
    if (c.nodeName === tag) return c.textContent;
  }
  return null;
}

export function formatLatLon(lat: number, lon: number): string {
  const latS = `${Math.abs(lat).toFixed(4)}\u00B0${lat >= 0 ? 'N' : 'S'}`;
  const lonS = `${Math.abs(lon).toFixed(4)}\u00B0${lon >= 0 ? 'E' : 'W'}`;
  return `${latS}, ${lonS}`;
}

export function polygonArea(poly: Pt[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

export function pointInPolygon(pt: Pt, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y;
    const xj = poly[j].x, yj = poly[j].y;
    if (yi > pt.y !== yj > pt.y && pt.x < ((xj - xi) * (pt.y - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

// Nesting depth of each closed loop among a set of disjoint (non-crossing)
// loops: depth = number of other loops that contain it. Used to render the
// road network's even-odd loop list — depth 0 loops are equipment islands
// (holes in the road), odd-depth loops are enclosed road pockets, etc.
export function classifyLoopDepths(loops: Pt[][]): number[] {
  return loops.map((pts, i) => {
    if (!pts.length) return 0;
    let d = 0;
    for (let j = 0; j < loops.length; j++) {
      if (j !== i && pointInPolygon(pts[0], loops[j])) d++;
    }
    return d;
  });
}

// Distance from point to polygon edge (positive value)
export function distanceToPolygonEdge(pt: Pt, poly: Pt[]): number {
  let min = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    min = Math.min(min, distToSegment(pt, a, b));
  }
  return min;
}

function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = a.x + t * dx, cy = a.y + t * dy;
  return Math.hypot(p.x - cx, p.y - cy);
}

// Inward offset of a simple polygon using edge-normal offsets with miter joins.
// Works for convex and concave parcels. Each edge is shifted inward by `inset`
// along its normal; adjacent offset edges are intersected to form new vertices.
// Vertices that end up invalid (outside the original polygon or closer than
// the inset to an original edge) are nudged toward the centroid until valid.
export function insetPolygon(poly: Pt[], inset: number): Pt[] {
  const n = poly.length;
  if (n < 3 || inset <= 0) return poly.slice();

  // Ensure CCW orientation (positive area) so inward normal = left of edge dir
  const ccw = polygonArea(poly) > 0;
  const pts = ccw ? poly.slice() : poly.slice().reverse();

  const result: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const prev = pts[(i - 1 + n) % n];
    const curr = pts[i];
    const next = pts[(i + 1) % n];

    // Offset lines for the two edges meeting at curr
    const l1 = offsetLine(prev, curr, inset);
    const l2 = offsetLine(curr, next, inset);
    const ix = intersectLines(l1, l2);
    result.push(ix ?? { x: curr.x + (l1.nx + l2.nx) * 0.5 * inset, y: curr.y + (l1.ny + l2.ny) * 0.5 * inset });
  }

  // Validate/repair each vertex: must be inside original and >= 0.95*inset from edges
  const cx = pts.reduce((s, p) => s + p.x, 0) / n;
  const cy = pts.reduce((s, p) => s + p.y, 0) / n;
  const repaired = result.map(p => {
    let q = { ...p };
    let guard = 0;
    while (guard++ < 40 && (!pointInPolygon(q, pts) || distanceToPolygonEdge(q, pts) < inset * 0.95)) {
      q = { x: q.x + (cx - q.x) * 0.15, y: q.y + (cy - q.y) * 0.15 };
    }
    return q;
  });

  return ccw ? repaired : repaired.reverse();
}

interface OffsetLine { px: number; py: number; dx: number; dy: number; nx: number; ny: number }

function offsetLine(a: Pt, b: Pt, inset: number): OffsetLine {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len;
  // Inward normal for CCW polygon = left of direction
  const nx = -uy, ny = ux;
  return { px: a.x + nx * inset, py: a.y + ny * inset, dx: ux, dy: uy, nx, ny };
}

function intersectLines(l1: OffsetLine, l2: OffsetLine): Pt | null {
  const denom = l1.dx * l2.dy - l1.dy * l2.dx;
  if (Math.abs(denom) < 1e-9) return null; // parallel (collinear edges)
  const t = ((l2.px - l1.px) * l2.dy - (l2.py - l1.py) * l2.dx) / denom;
  return { x: l1.px + l1.dx * t, y: l1.py + l1.dy * t };
}

// Check that a rectangle (center, size, axis-aligned) lies fully inside polygon
// with at least `margin` clearance from every edge.
export function rectInsidePolygon(
  cx: number, cy: number, halfW: number, halfH: number,
  poly: Pt[], margin: number
): boolean {
  const samples: Pt[] = [
    { x: cx - halfW, y: cy - halfH },
    { x: cx + halfW, y: cy - halfH },
    { x: cx + halfW, y: cy + halfH },
    { x: cx - halfW, y: cy + halfH },
    { x: cx, y: cy },
    { x: cx, y: cy - halfH },
    { x: cx, y: cy + halfH },
    { x: cx - halfW, y: cy },
    { x: cx + halfW, y: cy },
  ];
  for (const s of samples) {
    if (!pointInPolygon(s, poly)) return false;
  }
  // Corner clearance from edges
  for (const s of samples.slice(0, 4)) {
    if (distanceToPolygonEdge(s, poly) < margin) return false;
  }
  return true;
}

/** Like rectInsidePolygon but for a rectangle rotated by angleRad (CCW from
 * world +x to the rect's local +x axis).  hx/hy are half-extents in the
 * rectangle's LOCAL frame (hx along the rotated length axis, hy across it).
 * Uses the same 9-sample strategy as rectInsidePolygon; margin is checked at
 * the four corners. */
export function rotatedRectInsidePolygon(
  cx: number, cy: number, hx: number, hy: number,
  angleRad: number, poly: Pt[], margin: number
): boolean {
  const cosθ = Math.cos(angleRad), sinθ = Math.sin(angleRad);
  // 4 corners + center + 4 edge midpoints, all in world coordinates
  const samples: Pt[] = [
    { x: cx - hx * cosθ + hy * sinθ, y: cy - hx * sinθ - hy * cosθ }, // -x -y (SW local)
    { x: cx + hx * cosθ + hy * sinθ, y: cy + hx * sinθ - hy * cosθ }, // +x -y (SE local)
    { x: cx + hx * cosθ - hy * sinθ, y: cy + hx * sinθ + hy * cosθ }, // +x +y (NE local)
    { x: cx - hx * cosθ - hy * sinθ, y: cy - hx * sinθ + hy * cosθ }, // -x +y (NW local)
    { x: cx,                          y: cy                           }, // center
    { x: cx - hx * cosθ,              y: cy - hx * sinθ              }, // mid -x
    { x: cx + hx * cosθ,              y: cy + hx * sinθ              }, // mid +x
    { x: cx + hy * sinθ,              y: cy - hy * cosθ              }, // mid -y
    { x: cx - hy * sinθ,              y: cy + hy * cosθ              }, // mid +y
  ];
  for (const s of samples) {
    if (!pointInPolygon(s, poly)) return false;
  }
  for (const s of samples.slice(0, 4)) {
    if (distanceToPolygonEdge(s, poly) < margin) return false;
  }
  return true;
}
