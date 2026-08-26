// Revision designator conventions for issued drawing packages.
//
// NEER preliminary convention: pre-issue revisions run 0A, 0B, ... 0Z;
// once issued-for-construction they become numeric 0, 1, 2, ...
// Legacy letter ('A', 'B') and plain numeric schemes are also recognized so
// nextRevision can advance whatever designator a drafter typed.

// Default designator for a fresh (preliminary / 10%) package.
export const DEFAULT_PRELIM_REV = '0A';

export type RevisionScheme = 'neer-prelim' | 'letters' | 'numeric';

// Detect which scheme a designator belongs to (undefined = free text).
export function revisionSchemeOf(rev: string): RevisionScheme | undefined {
  const r = rev.trim().toUpperCase();
  if (/^0[A-Z]$/.test(r)) return 'neer-prelim';
  if (/^[A-Z]$/.test(r)) return 'letters';
  if (/^\d+$/.test(r)) return 'numeric';
  return undefined;
}

// Advance a revision designator within its scheme:
//   0A -> 0B -> ... -> 0Z -> 0 (first issued numeric)
//   A -> B -> ... -> Z -> A (legacy letter wraps)
//   0 -> 1 -> 2 ...
// Unrecognized designators are returned unchanged (drafter free text).
export function nextRevision(rev: string): string {
  const r = rev.trim().toUpperCase();
  switch (revisionSchemeOf(r)) {
    case 'neer-prelim':
      return r[1] === 'Z' ? '0' : `0${String.fromCharCode(r.charCodeAt(1) + 1)}`;
    case 'letters':
      return r === 'Z' ? 'A' : String.fromCharCode(r.charCodeAt(0) + 1);
    case 'numeric':
      return String(parseInt(r, 10) + 1);
    default:
      return rev;
  }
}

// Normalize a stored/typed revision for display: trimmed + uppercased,
// empty falls back to the preliminary default.
export function displayRevision(rev: string | undefined | null): string {
  const r = (rev ?? '').trim().toUpperCase();
  return r || DEFAULT_PRELIM_REV;
}
