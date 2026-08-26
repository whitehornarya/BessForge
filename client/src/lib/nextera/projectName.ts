// Project display-name defaulting.
//
// KMZ placemark/layer names are drawn by surveyors, not marketers — they
// frequently read "GP Energy Storage Boundary" or just "SUBSTATION BOUNDARY".
// The drawing title should show the project, not the parcel artifact, so the
// default display name strips trailing generic parcel words. If nothing
// descriptive remains (the name was ALL generic words), the raw name is kept
// verbatim — we never invent project names. The field stays fully editable
// and is serialized with the project via the title block.

const GENERIC_TOKENS = new Set([
  'BOUNDARY', 'BNDY', 'BNDRY', 'PARCEL', 'LIMITS', 'LIMIT', 'OUTLINE',
  'PERIMETER', 'FENCE', 'FENCELINE', 'PROPERTY', 'LINE', 'AREA', 'SITE',
  'LOT', 'SUBSTATION', 'YARD', 'FOOTPRINT', 'EXTENTS', 'POLYGON', 'LAYER',
]);

export function defaultProjectDisplayName(raw: string): string {
  const name = (raw ?? '').trim();
  if (!name) return '';
  const words = name.split(/\s+/);
  // Strip generic tokens off the END only — leading words carry identity.
  let end = words.length;
  while (end > 0 && GENERIC_TOKENS.has(words[end - 1].toUpperCase().replace(/[^A-Z]/g, ''))) end--;
  const kept = words.slice(0, end).join(' ');
  // All-generic name ("SUBSTATION BOUNDARY") -> keep raw; drafter edits it.
  return kept || name;
}
