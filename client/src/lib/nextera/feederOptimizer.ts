// Feeder-routing optimizer: a bounded, fully enumerative (no RNG) search over
// how the MV home-run bundle leaves the substation — all 90°, all angled, or
// a combined per-feeder assignment — plus the corridor approach position.
// Pure function of (design, substation, blockMW, base options, current
// params) -> ranked candidates. Applying one goes through the normal store
// layout-edit path so undo/redo works unchanged.
//
// Scope and why it is a SEPARATE search from optimizer.ts:
// - optimizer.ts searches the LAYOUT (arrangement, lattice shift, gate edge,
//   DC trench spine) and regenerates a whole SiteDesign per candidate.
// - This searches only how the ALREADY-PLACED yard's feeders exit, so a
//   candidate is one generateFeeders() call (~1-3 ms) against a fixed design.
//   Block placement, the substation position and feeder membership are never
//   touched — the same equipment is served, just routed differently.
//
// Cost asymmetry that shapes the phases: generateFeeders is milliseconds, but
// generateAuxFeeder routes the station-service trench around every MV trench
// (see #698) and costs ~1.2-1.8 s. So the broad search scores MV geometry
// only, and the aux keep-clear guarantee is verified on the shortlist that is
// actually offered to the drafter.
import { Pt, SiteDesign } from './types';
import { Rect } from './cableRouting';
import {
  FeederCircuit,
  FeederOptions,
  FeederRoutingMode,
  FEEDER_TRENCH_SPACING_FT,
  feederCorridorFrame,
  feederCorridorInfo,
  feederRouteKey,
  generateAuxFeeder,
  generateFeeders,
  polylineCrossings,
  substationConvergenceWindow,
} from './feeders';

// The feeder-exit knobs one candidate sets.
export interface FeederRoutingParams {
  // Design-wide default home-run routing mode.
  defaultMode: FeederRoutingMode;
  // Per-feeder overrides keyed by stable feeder identity (feederRouteKey).
  // Canonicalized to the MINORITY modes only — see paramsForVector.
  modes: Record<string, FeederRoutingMode>;
  // Corridor centerline pin (layoutEdits.feederCorridor); null = automatic.
  corridorPin: number | null;
}

export interface FeederRoutingMetrics {
  // Home-run x home-run crossings outside the substation convergence window.
  crossings: number;
  // Aux (station-service) trench x home-run crossings. -1 until the shortlist
  // phase routes the aux feeder for this candidate.
  auxCrossings: number;
  // Adjacent-lane spacing dispersion across the corridor: 0 = perfectly
  // uniform parallel bundle. Ranking uses this; uniformityPct is for display.
  spacingCv: number;
  uniformityPct: number;
  // Total MV feeder conductor feet (chain hops + home runs). The aux circuit
  // is NOT included: it is not being re-oriented, so folding it in would only
  // add a constant-ish offset that is unknown during the broad search.
  conductorFt: number;
  angledCount: number;
  feederCount: number;
  // Feeders that asked for the angled corridor but had no clear diagonal and
  // fell back to the 90° route. Surfaced so a card can never over-promise.
  angledFallbacks: number;
}

export type FeederOrientation = 'orthogonal' | 'angled' | 'combined';

export interface FeederRoutingCandidate {
  id: string;
  params: FeederRoutingParams;
  metrics: FeederRoutingMetrics;
  orientation: FeederOrientation;
  // True for the drafter's current settings, which always compete as a
  // candidate so "your current setup is already best" is a real answer.
  isCurrent: boolean;
}

export interface FeederRoutingResult {
  candidates: FeederRoutingCandidate[]; // ranked best-first, <= MAX_FEEDER_CANDIDATES
  current: FeederRoutingCandidate | null; // metrics for the current settings
  evaluated: number;
  total: number;
  cancelled: boolean;
}

// Everything generateFeeders needs that is NOT part of the search, minus the
// non-clonable warning callback (this request crosses postMessage).
export type FeederRoutingBaseOptions =
  Omit<FeederOptions, 'onWarning' | 'defaultRoutingMode' | 'routingModes' | 'corridorPin'> & {
    // A drafter-drawn aux route, when one exists. This is not a generateFeeders
    // option — it travels with the search because the aux crossing count on a
    // card has to model the SAME station-service circuit recomputeFeeders will
    // draw. Scoring against the automatic route while the yard actually uses a
    // manual one makes the card report a number Apply never reproduces.
    auxWaypoints?: Pt[] | null;
  };

// A candidate card's numbers only describe the yard they were measured
// against, so the panel has to know when that yard moves. This hashes every
// input the search reads. Counting feeders is NOT enough: a block nudged one
// foot re-shapes the home runs while feeder count, segment count and vertex
// count all stay identical, and the stale card would still offer an Apply.
export function feederRoutingInputSignature(
  design: SiteDesign,
  substation: Pt | null,
  blockMW: number,
  base: FeederRoutingBaseOptions,
  current: FeederRoutingParams
): string {
  return JSON.stringify([
    substation ? [substation.x, substation.y] : null,
    blockMW,
    // The design slices the routers actually consume — positions and all, not
    // cardinality. Over-including here only retires cards too eagerly, which
    // is the safe direction; under-including ships wrong numbers.
    design.equipment, design.fence, design.islands ?? null,
    design.reservedZones, design.augmentationZones, design.gate ?? null,
    // Feeder options (grouping, sizes, material, drafter routes, exclusion
    // zones, drawn aux route) travel wholesale so a field added later is
    // covered without anyone remembering to update this list.
    base,
    // The routing knobs the search starts from: these set the comparison floor
    // that every card's "never worse than current" claim is measured against,
    // so a change to them invalidates the ranking even if the yard is untouched.
    current.defaultMode,
    Object.entries(current.modes ?? {}).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
    current.corridorPin ?? null,
  ]);
}

export const MAX_FEEDER_CANDIDATES = 4;
// Mode assignments taken forward into the greedy single-feeder flip pass.
const FLIP_SEEDS = 2;
// Mode assignments taken forward into the corridor-position pass.
const PIN_SEEDS = 3;
// Corridor pin offsets tried, in trench spacings either side of automatic.
const PIN_STEPS = [1, -1, 2, -2];
// Scan stations across the corridor for the spacing-uniformity measurement.
const SPACING_STATIONS = 17;
// Uniformity difference below this is visual noise, not a reason to offer a
// card: 5e-3 dispersion is half a percentage point of uniformity.
const SPACING_EPS = 5e-3;
// Two intersections closer than this read as one trench, not two lanes.
const LANE_MERGE_FT = 0.5;
// Enumerating contiguous splits is O(n); guard a pathological feeder count so
// the broad search can never blow past a second or two.
const MAX_SPLIT_FEEDERS = 40;

/** The home run is always the LAST segment of a feeder circuit. */
export function homeRunsOf(feeders: FeederCircuit[]): Pt[][] {
  return feeders
    .map(f => f.segments[f.segments.length - 1]?.pts)
    .filter((p): p is Pt[] => Array.isArray(p) && p.length >= 2);
}

/** Home-run x home-run crossings, ignoring the substation convergence window
 *  where every circuit legitimately meets. */
export function countHomeRunCrossings(runs: Pt[][], exempt: Rect | null): number {
  let n = 0;
  for (let i = 0; i < runs.length; i++) {
    for (let j = i + 1; j < runs.length; j++) {
      n += polylineCrossings(runs[i], runs[j], exempt).length;
    }
  }
  return n;
}

/** How uniformly the parallel lanes are spaced, as a dimensionless dispersion
 *  (0 = every adjacent gap identical). Measured by scanning perpendicular
 *  across the corridor at evenly spaced stations and looking at the gaps
 *  between neighbouring trenches at each one.
 *
 *  Normalizing per station is what makes 90° and angled bundles comparable:
 *  near the yard exit only some lanes have formed yet, and a partly-populated
 *  station is not "non-uniform" — it just has fewer gaps to judge. */
export function laneSpacingDispersion(
  runs: Pt[][],
  horizApproach: boolean,
  spanLo: number,
  spanHi: number,
  stations: number = SPACING_STATIONS
): number {
  if (runs.length < 3 || !(spanHi > spanLo) || stations < 1) return 0;
  const perp = (p: Pt) => (horizApproach ? p.y : p.x);
  let pLo = Infinity, pHi = -Infinity;
  for (const r of runs) {
    for (const p of r) {
      const v = perp(p);
      if (!Number.isFinite(v)) continue;
      if (v < pLo) pLo = v;
      if (v > pHi) pHi = v;
    }
  }
  if (!Number.isFinite(pLo) || !Number.isFinite(pHi)) return 0;
  pLo -= 50; pHi += 50;

  let acc = 0, used = 0;
  for (let s = 0; s < stations; s++) {
    // Strictly interior: the ends are the launch fan and the substation
    // convergence, where lanes are meant to bunch.
    const a = spanLo + ((s + 1) / (stations + 1)) * (spanHi - spanLo);
    const scan: Pt[] = horizApproach
      ? [{ x: a, y: pLo }, { x: a, y: pHi }]
      : [{ x: pLo, y: a }, { x: pHi, y: a }];
    const coords: number[] = [];
    for (const r of runs) {
      for (const hit of polylineCrossings(scan, r)) coords.push(perp(hit));
    }
    coords.sort((x, y) => x - y);
    const lanes: number[] = [];
    for (const c of coords) {
      if (!lanes.length || c - lanes[lanes.length - 1] > LANE_MERGE_FT) lanes.push(c);
    }
    if (lanes.length < 3) continue; // need >= 2 gaps to talk about uniformity
    const gaps: number[] = [];
    for (let i = 1; i < lanes.length; i++) gaps.push(lanes[i] - lanes[i - 1]);
    const mean = gaps.reduce((t, g) => t + g, 0) / gaps.length;
    if (!(mean > 1e-6)) continue;
    const dev = gaps.reduce((t, g) => t + Math.abs(g - mean), 0) / gaps.length;
    acc += dev / mean;
    used++;
  }
  return used ? acc / used : 0;
}

/** Score one already-routed feeder set. MV geometry only — the aux trench is
 *  scored separately on the shortlist (it costs ~1.5 s to route). */
export function scoreFeederRouting(
  design: SiteDesign,
  substation: Pt,
  feeders: FeederCircuit[],
  angledRequested: number,
  angledFallbacks: number,
  opts?: { maxPerFeeder?: number; corridorPin?: number | null }
): FeederRoutingMetrics {
  const runs = homeRunsOf(feeders);
  const exempt = feeders.length
    ? substationConvergenceWindow(design, substation, feeders.length, opts)
    : null;
  const info = feederCorridorInfo(design, substation, opts?.maxPerFeeder);
  const frame = feederCorridorFrame(design, substation, opts?.corridorPin, opts?.maxPerFeeder);
  const spacingCv = info && frame
    ? laneSpacingDispersion(runs, frame.horizApproach, info.spanLo, info.spanHi)
    : 0;
  return {
    crossings: countHomeRunCrossings(runs, exempt),
    auxCrossings: -1,
    spacingCv,
    uniformityPct: Math.max(0, 100 * (1 - Math.min(1, spacingCv))),
    conductorFt: feeders.reduce((t, f) => t + (Number.isFinite(f.totalLengthFt) ? f.totalLengthFt : 0), 0),
    angledCount: angledRequested,
    feederCount: feeders.length,
    angledFallbacks,
  };
}

/** Label from what actually got DRAWN, not what was asked for: a feeder with
 *  no clear diagonal silently keeps its 90° route, so "all angled" on a site
 *  where half the feeders fall back is really a combined bundle. */
export function orientationOf(m: FeederRoutingMetrics): FeederOrientation {
  const effective = Math.max(0, m.angledCount - m.angledFallbacks);
  if (effective <= 0) return 'orthogonal';
  if (effective >= m.feederCount) return 'angled';
  return 'combined';
}

/** Canonical params for an effective per-feeder mode vector: the majority mode
 *  becomes the design-wide default and only the minority carry overrides, so
 *  two spellings of the same routing can never both appear as candidates. */
export function paramsForVector(
  vector: FeederRoutingMode[], keys: string[], corridorPin: number | null
): FeederRoutingParams {
  const angled = vector.reduce((n, m) => n + (m === 'angled' ? 1 : 0), 0);
  const defaultMode: FeederRoutingMode = angled * 2 > vector.length ? 'angled' : 'orthogonal';
  const modes: Record<string, FeederRoutingMode> = {};
  vector.forEach((m, i) => { if (m !== defaultMode && keys[i]) modes[keys[i]] = m; });
  return { defaultMode, modes, corridorPin };
}

/** The effective mode of every feeder under a given params set, in feeder
 *  order — the search's working representation. */
export function vectorForParams(params: FeederRoutingParams, keys: string[]): FeederRoutingMode[] {
  return keys.map(k => params.modes[k] ?? params.defaultMode);
}

// Best-first: fewest crossings, then the most uniform bundle, then the least
// conductor. Length is the LAST word by design — a tidy-looking bundle must
// never win by burying far more cable, but it must not be able to win on
// length alone either (that is how a "short" route ends up running straight
// down the middle of the lane bundle).
function better(a: FeederRoutingCandidate, b: FeederRoutingCandidate): number {
  const am = a.metrics, bm = b.metrics;
  if (am.crossings !== bm.crossings) return am.crossings - bm.crossings;
  const aAux = am.auxCrossings < 0 ? 0 : am.auxCrossings;
  const bAux = bm.auxCrossings < 0 ? 0 : bm.auxCrossings;
  if (aAux !== bAux) return aAux - bAux;
  if (Math.abs(am.spacingCv - bm.spacingCv) > SPACING_EPS) return am.spacingCv - bm.spacingCv;
  if (Math.abs(am.conductorFt - bm.conductorFt) > 0.5) return am.conductorFt - bm.conductorFt;
  // Stable last word so an identical-scoring pair always ranks the same way.
  return a.id.localeCompare(b.id);
}

const sigOf = (vector: FeederRoutingMode[], pin: number | null) =>
  `${vector.map(m => (m === 'angled' ? 'a' : 'o')).join('')}|${pin === null ? 'auto' : Math.round(pin)}`;

/** Identity of what the drafter would actually SEE. Two mode assignments can
 *  route to the same trenches — a feeder whose run line already sits on its
 *  lane has no diagonal to take, so switching it to angled changes nothing.
 *  Deduping on the request would offer that as a separate "combined" card
 *  that is byte-identical to the 90° one. */
function geometrySignature(runs: Pt[][]): string {
  return runs
    .map(r => r.map(p => `${Math.round(p.x * 10)},${Math.round(p.y * 10)}`).join(';'))
    .join('|');
}

/** Generator core: yields progress after every candidate so the worker can
 *  report a bar and cancel by simply not resuming. */
export function* optimizeFeederRoutingSteps(
  design: SiteDesign,
  substation: Pt,
  blockMW: number,
  base: FeederRoutingBaseOptions,
  current: FeederRoutingParams
): Generator<{ done: number; total: number }, FeederRoutingResult> {
  const maxPer = base.maxPerFeeder;
  const basePin = Number.isFinite(current.corridorPin as number) ? current.corridorPin! : null;
  // auxWaypoints rides on base for transport but is not a generateFeeders
  // option, so keep it out of every routing spread below.
  const { auxWaypoints = null, ...feederBase } = base;

  // Feeder identity comes from a single reference routing. Membership never
  // changes across candidates (grouping is not part of this search), so the
  // key list is fixed for the whole run.
  const reference = generateFeeders(design, substation, blockMW, {
    ...feederBase, defaultRoutingMode: 'orthogonal', routingModes: null, corridorPin: basePin,
  });
  const keys = reference.map(f => feederRouteKey(f.inverterIds));
  const n = keys.length;

  const evalVector = (
    vector: FeederRoutingMode[], pin: number | null, id: string, isCurrent: boolean
  ): { cand: FeederRoutingCandidate; geom: string } => {
    const params = paramsForVector(vector, keys, pin);
    let fallbacks = 0;
    const feeders = generateFeeders(design, substation, blockMW, {
      ...feederBase,
      defaultRoutingMode: params.defaultMode,
      routingModes: Object.keys(params.modes).length ? params.modes : null,
      corridorPin: params.corridorPin,
      onWarning: (msg: string) => { if (msg.startsWith('Angled feeder route')) fallbacks++; },
    });
    const angled = vector.reduce((t, m) => t + (m === 'angled' ? 1 : 0), 0);
    const metrics = scoreFeederRouting(design, substation, feeders, angled, fallbacks,
      { maxPerFeeder: maxPer, corridorPin: params.corridorPin });
    return {
      cand: { id, params, metrics, orientation: orientationOf(metrics), isCurrent },
      geom: geometrySignature(homeRunsOf(feeders)),
    };
  };

  // ---- Phase 0: the drafter's current settings -----------------------------
  const currentVector = vectorForParams(current, keys);
  let done = 0;
  const splits = n >= 2 && n <= MAX_SPLIT_FEEDERS ? 2 * (n - 1) : 0;
  const total = 1 + 2 + splits + FLIP_SEEDS * n + PIN_SEEDS * PIN_STEPS.length + 1 + MAX_FEEDER_CANDIDATES;

  const currentCand = n ? evalVector(currentVector, basePin, 'fr-current', true) : null;
  done++;
  yield { done, total };
  if (!n || !currentCand) {
    return { candidates: [], current: null, evaluated: done, total, cancelled: false };
  }

  const accepted: FeederRoutingCandidate[] = [];
  const tried = new Set<string>();      // request-level: skip re-routing
  const seenGeom = new Set<string>();   // result-level: skip duplicate drawings
  let idc = 0;
  // A candidate may never be WORSE than what the drafter already has. When the
  // current bundle is clean (the normal case) this is exactly "reject any
  // candidate that crosses"; when it already crosses (a wide launch fan can
  // cross its own run lines inside the yard regardless of how the bundle
  // exits), the optimizer stays useful instead of refusing to show anything.
  const crossingCeiling = currentCand.cand.metrics.crossings;
  const consider = (scored: { cand: FeederRoutingCandidate; geom: string }) => {
    if (scored.cand.metrics.crossings > crossingCeiling) return;
    if (seenGeom.has(scored.geom)) return;
    seenGeom.add(scored.geom);
    accepted.push(scored.cand);
    accepted.sort(better);
  };
  tried.add(sigOf(currentVector, basePin));
  consider(currentCand);

  const step = (vector: FeederRoutingMode[], pin: number | null) => {
    const sig = sigOf(vector, pin);
    if (!tried.has(sig)) {
      tried.add(sig);
      consider(evalVector(vector, pin, `fr-${++idc}`, false));
    }
    done++;
  };

  // ---- Phase 1: the two pure orientations + contiguous combined splits -----
  const allOf = (m: FeederRoutingMode): FeederRoutingMode[] => new Array<FeederRoutingMode>(n).fill(m);
  step(allOf('orthogonal'), basePin);
  yield { done, total };
  step(allOf('angled'), basePin);
  yield { done, total };
  // Combined assignments are enumerated as CONTIGUOUS runs (the first k or the
  // last k feeders go angled). A bundle where modes alternate feeder-by-feeder
  // reads as a mess on the plan even when it scores well, and the greedy pass
  // below can still reach any assignment the score genuinely prefers.
  if (splits) {
    for (let k = 1; k < n; k++) {
      const pre = allOf('orthogonal'); for (let i = 0; i < k; i++) pre[i] = 'angled';
      step(pre, basePin);
      yield { done, total };
      const suf = allOf('orthogonal'); for (let i = n - k; i < n; i++) suf[i] = 'angled';
      step(suf, basePin);
      yield { done, total };
    }
  }

  // ---- Phase 2: greedy single-feeder flips from the best assignments -------
  const flipSeeds = accepted.slice(0, FLIP_SEEDS).map(c => vectorForParams(c.params, keys));
  for (let s = 0; s < FLIP_SEEDS; s++) {
    const seed = flipSeeds[s];
    for (let i = 0; i < n; i++) {
      if (seed) {
        const v = seed.slice();
        v[i] = v[i] === 'angled' ? 'orthogonal' : 'angled';
        step(v, basePin);
      } else {
        done++;
      }
      yield { done, total };
    }
  }

  // ---- Phase 3: corridor approach position on the best assignments ---------
  const info = feederCorridorInfo(design, substation, maxPer);
  const pinSeeds = accepted.slice(0, PIN_SEEDS).map(c => vectorForParams(c.params, keys));
  for (let s = 0; s < PIN_SEEDS; s++) {
    const seed = pinSeeds[s];
    for (const mult of PIN_STEPS) {
      if (seed && info) {
        const pin = info.autoCenter + mult * FEEDER_TRENCH_SPACING_FT;
        // An out-of-range pin is silently ignored by the router, which would
        // make the candidate a duplicate of the automatic one under a
        // misleading label — skip it outright.
        if (pin >= info.min && pin <= info.max) step(seed, pin);
        else done++;
      } else {
        done++;
      }
      yield { done, total };
    }
  }

  // ---- Phase 4: aux keep-clear verification on the shortlist ---------------
  // Routing the station-service trench costs ~1.5 s (it detours around every
  // MV trench), so it runs only for the handful of candidates actually
  // offered, plus the current settings for the comparison floor.
  const auxCrossingsFor = (cand: FeederRoutingCandidate): number => {
    const feeders = generateFeeders(design, substation, blockMW, {
      ...feederBase,
      defaultRoutingMode: cand.params.defaultMode,
      routingModes: Object.keys(cand.params.modes).length ? cand.params.modes : null,
      corridorPin: cand.params.corridorPin,
    });
    const aux = generateAuxFeeder(design, substation, feeders, undefined,
      base.exclusionZones ?? null, auxWaypoints,
      { maxPerFeeder: maxPer, corridorPin: cand.params.corridorPin });
    if (!aux) return 0;
    const runs = homeRunsOf(feeders);
    const exempt = feeders.length
      ? substationConvergenceWindow(design, substation, feeders.length,
          { maxPerFeeder: maxPer, corridorPin: cand.params.corridorPin })
      : null;
    let x = 0;
    for (const leg of aux.legs) {
      for (const r of runs) x += polylineCrossings(leg.pts, r, exempt).length;
    }
    return x;
  };

  const cur = currentCand.cand;
  cur.metrics.auxCrossings = auxCrossingsFor(cur);
  done++;
  yield { done, total };

  const shortlist = accepted.filter(c => !c.isCurrent).slice(0, MAX_FEEDER_CANDIDATES);
  const verified: FeederRoutingCandidate[] = [];
  for (let i = 0; i < MAX_FEEDER_CANDIDATES; i++) {
    const cand = shortlist[i];
    if (cand) {
      cand.metrics.auxCrossings = auxCrossingsFor(cand);
      // Same never-worse rule as the MV crossings: an alternative that pushes
      // the station-service trench into a home run is not an improvement.
      // Then, having the aux number, re-check that it still genuinely BEATS
      // the current settings — an alternative that merely ties is not worth a
      // card, and offering it would make "your bundle is already clean" look
      // like a finding.
      if (cand.metrics.auxCrossings <= cur.metrics.auxCrossings && better(cand, cur) < 0) {
        verified.push(cand);
      }
    }
    done++;
    yield { done, total };
  }

  verified.sort(better);
  return {
    candidates: verified.slice(0, MAX_FEEDER_CANDIDATES),
    current: cur,
    evaluated: done,
    total,
    cancelled: false,
  };
}

/** Synchronous wrapper (tests / non-UI callers). */
export function optimizeFeederRouting(
  design: SiteDesign,
  substation: Pt,
  blockMW: number,
  base: FeederRoutingBaseOptions,
  current: FeederRoutingParams
): FeederRoutingResult {
  const it = optimizeFeederRoutingSteps(design, substation, blockMW, base, current);
  let r = it.next();
  while (!r.done) r = it.next();
  return r.value;
}
