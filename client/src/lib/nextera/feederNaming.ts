// MV feeder circuit NAMES per the issued 90% reference package (CAR-D-B001-2
// legend / CAR-D-B005-0 one-line): every feeder is identified by its
// substation breaker position — "#<breaker><letter><n>" (e.g. #14A1) — not a
// bare sequential F-number. The grammar the reference sheets follow:
//
//   - Breaker numbers start at 14 (the first BESS feeder breaker position on
//     the 34.5 kV main bus) and count up.
//   - Each breaker serves up to TWO letters (A, B), each letter up to TWO
//     sub-circuits (1, 2) — so one breaker carries at most 4 feeder circuits
//     (one full 7+7 island pair per letter-pair on the reference).
//   - Letters NEVER span islands: a new island always starts a fresh letter
//     (Carousel: island 1 = 14A1/14A2, island 2 = 14B1/14B2, island 3 =
//     15A1/15A2, island 4 = 15B1/15B2). Non-island feeders pair up two per
//     letter in their existing geographic order.
//   - The substation AUX feeder takes letter C on the LAST BESS breaker
//     (Carousel: #15C1). No BESS circuit ever uses C.
//
// Display convention: the stored name has no '#'; surfaces that print the
// reference style (legend rows, plan callouts) prepend it. Breaker tags are
// "52-<name>" (SLD / relay one-line).
//
// Pure module — no geometry imports — so every label surface (scene, panel,
// DXF, SLD, schedules, reports) can share it without cycles.

export const FEEDER_BREAKER_BASE = 14;
export const FEEDER_LETTERS_PER_BREAKER = 2; // A, B (C is reserved for aux)
export const FEEDER_SUBS_PER_LETTER = 2;     // <letter>1, <letter>2
export const AUX_FEEDER_LETTER = 'C';

export interface FeederNameInfo {
  name: string;    // '14A1' — display adds '#'
  breaker: number; // 14, 15, …
  letter: string;  // 'A' | 'B'
  sub: number;     // 1 | 2
}

/**
 * Assign breaker-position names to feeders in their FINAL circuit order
 * (the order generateFeeders numbers them — geographic north→south /
 * west→east, or the drafter's assignment-bucket order).
 *
 * `islandNs[i]` is the island number feeder i's PCS chain belongs to, or
 * null for non-island (or mixed-membership) feeders. A change of island
 * always advances to a fresh letter; nulls pair consecutively like an
 * island's own feeders do.
 */
export function assignFeederNames(islandNs: Array<number | null>): FeederNameInfo[] {
  const out: FeederNameInfo[] = [];
  let breaker = FEEDER_BREAKER_BASE;
  let letterIdx = -1; // -1 = no letter opened yet; 0 = 'A'
  let sub = 0;
  let haveIsland = false;
  let curIsland: number | null = null;
  const advanceLetter = () => {
    letterIdx++;
    if (letterIdx >= FEEDER_LETTERS_PER_BREAKER) {
      breaker++;
      letterIdx = 0;
    }
    sub = 0;
  };
  for (const isl of islandNs) {
    const islandChanged = !haveIsland || isl !== curIsland;
    if (letterIdx < 0 || islandChanged || sub >= FEEDER_SUBS_PER_LETTER) advanceLetter();
    haveIsland = true;
    curIsland = isl;
    sub++;
    const letter = String.fromCharCode(65 + letterIdx);
    out.push({ name: `${breaker}${letter}${sub}`, breaker, letter, sub });
  }
  return out;
}

/** Breaker number embedded in a feeder name ('15B2' → 15), or null. */
export function breakerOfName(name: string | null | undefined): number | null {
  const m = /^(\d+)[A-Z]\d+$/.exec(name ?? '');
  return m ? Number(m[1]) : null;
}

/**
 * The aux feeder's name: letter C, sub-circuit 1, on the LAST breaker the
 * BESS feeders occupy (base breaker when there are none / names are absent —
 * e.g. synthetic fixtures or sessions saved before naming).
 */
export function auxFeederNameOf(feeders: Array<{ name?: string | null }>): string {
  let breaker = FEEDER_BREAKER_BASE;
  for (const f of feeders) {
    const b = breakerOfName(f.name);
    if (b !== null && b > breaker) breaker = b;
  }
  return `${breaker}${AUX_FEEDER_LETTER}1`;
}

/**
 * Display name for a feeder circuit: the breaker-position name when present,
 * else the legacy F<idx> (sessions saved before naming, synthetic fixtures).
 * Callers add '#' where the reference style shows it.
 */
export function feederDisplayName(f: { idx: number; name?: string | null }): string {
  return f.name && f.name.length ? f.name : `F${f.idx}`;
}

/** Aux feeder display name ('15C1'), with the legacy circuit-number fallback. */
export function auxDisplayName(aux: { circuitNo: number; name?: string | null }): string {
  return aux.name && aux.name.length ? aux.name : `${aux.circuitNo}C1`;
}
