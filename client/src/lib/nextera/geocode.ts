import { apiFetchJson } from '../api/fetch';

// Reverse geocoding of the site origin into a title-block location line
// ("CITY, COUNTY COUNTY, STATE"), via the server-side TIGERweb proxy
// (/api/geocode — US Census, public domain, no key).
//
// RULES (task: Title Block edits drive 10% outputs):
// - An explicitly typed location always wins. Auto-resolution only applies
//   when the Location field is blank or holds raw coordinates.
// - Resolution happens at edit/design time in the control panel; the
//   resolved text is written into the title block and travels with the
//   project. Exports NEVER call the network — they consume the stored text.
// - Failures are surfaced to the drafter (toast) and leave the field
//   exactly as typed — never a silently blank cover line.

// True when the string is blank-equivalent coordinate text rather than a
// real place name: only numbers, degree/minute marks, hemisphere letters
// (N/S/E/W) and separators, with at least two numeric values. Examples:
//   "36.3640°N, 101.4792°W"  -> true
//   "36.364, -101.479"       -> true
//   "N36 21.84 W101 28.75"   -> true
//   "Medina County, TX"      -> false
//   ""                       -> false (blank is handled separately)
// Numeric-but-not-coordinate strings ("1/2", "101, 202", "LOT 3-4" ) must
// NOT be auto-overwritten: beyond the charset check, require explicit
// coordinate structure — degree marks or hemisphere letters — or exactly
// two signed decimal numbers inside world lat/lon ranges.
export function isCoordinateLocation(s: string): boolean {
  const t = s.trim();
  if (!t) return false;
  if (!/^[\s0-9.,;:°º'"+\-\/NSEWnsew()\[\]]*$/.test(t)) return false;
  const nums = t.match(/\d+(?:\.\d+)?/g) ?? [];
  if (nums.length < 2) return false;
  // Degree marks or hemisphere letters = explicit coordinate notation.
  if (/[°º]/.test(t) || /[NSEWnsew]/.test(t)) return true;
  // Bare numbers: only a plausible decimal lat/lon pair qualifies.
  if (nums.length !== 2) return false;
  const [a, b] = nums.map(Number);
  return nums.every(n => n.includes('.')) && Math.abs(a) <= 90 && Math.abs(b) <= 180;
}

// Format the geocoder result as the reference-style location line:
// "GRUVER, HANSFORD COUNTY, TEXAS" / "HANSFORD COUNTY, TEXAS".
// TIGER BASENAMEs carry no "County" suffix; parishes/boroughs and names
// already ending in a county-type word are left untouched.
export function formatLocationLine(g: { city?: string | null; county?: string | null; state?: string | null }): string | null {
  const county = g.county?.trim();
  const state = g.state?.trim();
  if (!county || !state) return null;
  const countyLine = /\b(county|parish|borough|municipio|census area|municipality|city)$/i.test(county)
    ? county
    : `${county} County`;
  const parts = [g.city?.trim() || null, countyLine, state].filter((p): p is string => !!p);
  return parts.join(', ').toUpperCase();
}

// Resolve the site origin to a location line via the server proxy.
// Throws with a human-readable message on any failure.
export async function fetchGeocodedLocation(lat: number, lon: number): Promise<string> {
  const { data: j } = await apiFetchJson<Record<string, unknown>>('/api/geocode', { lat, lon }, {
    ttlMs: 30 * 24 * 60 * 60 * 1000, provenance: 'US Census TIGERweb',
  });
  const line = formatLocationLine(j as { city?: string | null; county?: string | null; state?: string | null });
  if (!line) throw new Error('geocoder returned no county/state');
  return line;
}
