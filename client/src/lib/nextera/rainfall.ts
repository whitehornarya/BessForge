import { apiFetchJson } from '../api/fetch';

// NOAA Atlas 14 point precipitation-frequency (IDF) support for the
// drainage study — parses the PFDS intensity CSV (proxied by /api/rainfall)
// into a duration × ARI intensity table and interpolates the design
// intensity at any time of concentration.
//
// Pure + deterministic (no Date, no randomness); the fetch helper is the
// only I/O and is never called from exports or tests. SCREENING ONLY —
// never imported by dxfExport/dxfSheets; default exports stay byte-identical
// with the drainage feature off.

export interface Atlas14Idf {
  lat: number;
  lon: number;
  source: string;            // e.g. 'NOAA Atlas 14 Volume 8 Version 2'
  durationsMin: number[];    // ascending, minutes (5-min … 60-day)
  ariYears: number[];        // ascending, average recurrence intervals
  intensityInHr: number[][]; // [durationIdx][ariIdx], inches/hour
}

// Standard design-storm choices offered in the panel (all present in every
// Atlas 14 volume's ARI columns).
export const ATLAS14_ARI_CHOICES = [2, 5, 10, 25, 50, 100] as const;

// '5-min:' | '2-hr:' | '3-day:' -> minutes; null for unrecognized rows.
function durationLabelToMin(label: string): number | null {
  const m = /^(\d+(?:\.\d+)?)-(min|hr|day)$/.exec(label.trim().replace(/:$/, ''));
  if (!m) return null;
  const v = Number(m[1]);
  if (!Number.isFinite(v) || v <= 0) return null;
  switch (m[2]) {
    case 'min': return v;
    case 'hr': return v * 60;
    case 'day': return v * 1440;
    default: return null;
  }
}

// Parse the PFDS "fe_text_mean.csv" intensity payload. Throws on anything
// that does not look like an Atlas 14 intensity table — explicit failure,
// never a silently defaulted IDF.
export function parseNoaaPfdsCsv(csv: string, lat: number, lon: number): Atlas14Idf {
  const lines = csv.split(/\r?\n/);
  if (!/Precipitation intensity/i.test(csv)) {
    throw new Error('NOAA response is not an intensity table (expected data=intensity)');
  }
  const srcLine = lines.find(l => /NOAA Atlas \d+/i.test(l));
  const source = (srcLine ?? 'NOAA Atlas 14').trim();

  const headerIdx = lines.findIndex(l => /by duration for ARI \(years\):/i.test(l));
  if (headerIdx < 0) throw new Error('NOAA response is missing the ARI header row');
  const ariYears = lines[headerIdx]
    .split(':,')[1]
    .split(',')
    .map(s => Number(s.trim()))
    .filter(v => Number.isFinite(v) && v > 0);
  if (ariYears.length < 4) throw new Error('NOAA response has an unreadable ARI header row');

  const durationsMin: number[] = [];
  const intensityInHr: number[][] = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) break;
    const ci = line.indexOf(':,');
    if (ci < 0) break;
    const dur = durationLabelToMin(line.slice(0, ci));
    if (dur === null) break;
    const vals = line.slice(ci + 2).split(',').map(s => Number(s.trim()));
    if (vals.length !== ariYears.length || vals.some(v => !Number.isFinite(v) || v < 0)) {
      throw new Error(`NOAA intensity row for ${line.slice(0, ci)} is unreadable`);
    }
    durationsMin.push(dur);
    intensityInHr.push(vals);
  }
  if (durationsMin.length < 5) throw new Error('NOAA response has too few duration rows');
  for (let i = 1; i < durationsMin.length; i++) {
    if (durationsMin[i] <= durationsMin[i - 1]) throw new Error('NOAA duration rows are out of order');
  }
  return { lat, lon, source, durationsMin, ariYears, intensityInHr };
}

// Deep-sanitize an IDF restored from untrusted storage. Returns null when
// the shape is not a plausible Atlas 14 table (caller falls back to manual
// intensity — never a fabricated IDF).
export function sanitizeAtlas14Idf(v: unknown): Atlas14Idf | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const lat = o.lat, lon = o.lon, source = o.source;
  const dur = o.durationsMin, ari = o.ariYears, grid = o.intensityInHr;
  if (typeof lat !== 'number' || !Number.isFinite(lat) || Math.abs(lat) > 90) return null;
  if (typeof lon !== 'number' || !Number.isFinite(lon) || Math.abs(lon) > 180) return null;
  if (typeof source !== 'string' || !source.trim()) return null;
  if (!Array.isArray(dur) || !Array.isArray(ari) || !Array.isArray(grid)) return null;
  if (dur.length < 5 || ari.length < 4 || grid.length !== dur.length) return null;
  const durationsMin: number[] = [];
  for (const d of dur) {
    if (typeof d !== 'number' || !Number.isFinite(d) || d <= 0) return null;
    if (durationsMin.length && d <= durationsMin[durationsMin.length - 1]) return null;
    durationsMin.push(d);
  }
  const ariYears: number[] = [];
  for (const a of ari) {
    if (typeof a !== 'number' || !Number.isFinite(a) || a <= 0) return null;
    ariYears.push(a);
  }
  const intensityInHr: number[][] = [];
  for (const row of grid) {
    if (!Array.isArray(row) || row.length !== ariYears.length) return null;
    for (const x of row) {
      if (typeof x !== 'number' || !Number.isFinite(x) || x < 0 || x > 50) return null;
    }
    intensityInHr.push(row.slice() as number[]);
  }
  return { lat, lon, source: source.trim(), durationsMin, ariYears, intensityInHr };
}

// Design intensity (in/hr) at a duration equal to the time of concentration,
// for the requested ARI. Durations interpolate log-log (IDF curves are close
// to straight lines in log-log space); the ARI snaps to the nearest listed
// column (Atlas 14 lists every standard design storm, so exact in practice).
// Durations clamp to the table range — no extrapolation.
export function idfIntensityAt(idf: Atlas14Idf, ariYears: number, durationMin: number): number {
  let kAri = 0;
  for (let k = 1; k < idf.ariYears.length; k++) {
    if (Math.abs(idf.ariYears[k] - ariYears) < Math.abs(idf.ariYears[kAri] - ariYears)) kAri = k;
  }
  const d = Math.min(
    idf.durationsMin[idf.durationsMin.length - 1],
    Math.max(idf.durationsMin[0], durationMin)
  );
  let i1 = 0;
  while (i1 + 1 < idf.durationsMin.length && idf.durationsMin[i1 + 1] < d) i1++;
  const i2 = Math.min(i1 + 1, idf.durationsMin.length - 1);
  const d1 = idf.durationsMin[i1], d2 = idf.durationsMin[i2];
  const v1 = idf.intensityInHr[i1][kAri], v2 = idf.intensityInHr[i2][kAri];
  if (i1 === i2 || d2 <= d1) return v1;
  if (v1 <= 0 || v2 <= 0) {
    // Degenerate zero intensities: fall back to linear interpolation.
    const t = (d - d1) / (d2 - d1);
    return v1 + (v2 - v1) * t;
  }
  const t = (Math.log(d) - Math.log(d1)) / (Math.log(d2) - Math.log(d1));
  return Math.exp(Math.log(v1) + (Math.log(v2) - Math.log(v1)) * t);
}

// Fetch + parse the Atlas 14 IDF for a site (via the server proxy). Errors
// propagate to the caller — the UI reports them; nothing is faked.
export async function fetchNoaaIdf(lat: number, lon: number): Promise<Atlas14Idf> {
  const { data: body } = await apiFetchJson<{ csv?: unknown }>('/api/rainfall', { lat, lon }, {
    ttlMs: 30 * 24 * 60 * 60 * 1000, provenance: 'NOAA Atlas 14',
  });
  if (typeof body?.csv !== 'string') throw new Error('NOAA Atlas 14 response was malformed');
  return parseNoaaPfdsCsv(body.csv, lat, lon);
}
