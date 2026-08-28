/**
 * Project-scoped generated-drawing visibility.
 *
 * These controls deliberately do not include imported CAD/KMZ reference
 * layers. Reference-layer visibility remains owned by drawingLayerVis.
 */
export const DRAWING_VISIBILITY_VERSION = 1 as const;

export type DrawingVisibilityKey =
  | 'fiber'
  | 'pcsToBess'
  | 'dimensions'
  | 'labels'
  | 'auxiliaryCables';

export interface DrawingVisibilityProfile {
  version: typeof DRAWING_VISIBILITY_VERSION;
  fiber: boolean;
  pcsToBess: boolean;
  dimensions: boolean;
  labels: boolean;
  auxiliaryCables: boolean;
}

export const DEFAULT_DRAWING_VISIBILITY: Readonly<DrawingVisibilityProfile> =
  Object.freeze({
    version: DRAWING_VISIBILITY_VERSION,
    // TEMP: hide fiber runs while debugging yard routing / clutter.
    fiber: false,
    pcsToBess: true,
    dimensions: true,
    labels: true,
    auxiliaryCables: true,
  });

export type DrawingVisibilityRule =
  | DrawingVisibilityKey
  | readonly DrawingVisibilityKey[];

export const DRAWING_VISIBILITY_KEYS: readonly DrawingVisibilityKey[] = [
  'fiber',
  'pcsToBess',
  'dimensions',
  'labels',
  'auxiliaryCables',
];

/** Missing/legacy/partially invalid profiles fail open for backward compatibility. */
export function sanitizeDrawingVisibilityProfile(raw: unknown): DrawingVisibilityProfile {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Partial<Record<DrawingVisibilityKey | 'version', unknown>>
    : {};
  return {
    version: DRAWING_VISIBILITY_VERSION,
    fiber: typeof value.fiber === 'boolean' ? value.fiber : true,
    pcsToBess: typeof value.pcsToBess === 'boolean' ? value.pcsToBess : true,
    dimensions: typeof value.dimensions === 'boolean' ? value.dimensions : true,
    labels: typeof value.labels === 'boolean' ? value.labels : true,
    auxiliaryCables: typeof value.auxiliaryCables === 'boolean'
      ? value.auxiliaryCables
      : true,
  };
}

export function drawingVisibilityEquals(
  a: DrawingVisibilityProfile,
  b: DrawingVisibilityProfile,
): boolean {
  return a.version === b.version && DRAWING_VISIBILITY_KEYS.every(key => a[key] === b[key]);
}

export function drawingVisibilityAllOn(profile: DrawingVisibilityProfile): boolean {
  return DRAWING_VISIBILITY_KEYS.every(key => profile[key]);
}

/**
 * A single-key rule requires that key. Multi-key rules use OR semantics,
 * which is needed for shared infrastructure such as the combined 480 V/fiber
 * trench: it remains relevant while either carried system is visible.
 */
export function drawingVisibilityRuleEnabled(
  profile: DrawingVisibilityProfile,
  rule: DrawingVisibilityRule | null | undefined,
): boolean {
  if (!rule) return true;
  return Array.isArray(rule)
    ? (rule as readonly DrawingVisibilityKey[]).some(key => profile[key])
    : profile[rule as DrawingVisibilityKey];
}
