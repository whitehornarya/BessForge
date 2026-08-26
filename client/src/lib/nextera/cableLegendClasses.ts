// ---------------------------------------------------------------------------
// Single source of truth for WHICH cable-class legend rows a design prints.
//
// The DXF/PDF/CAD legend builder (dxfExport) consumes this module for its
// conditional cable rows, and routing gate G-RT-12 (routingGates.ts) compares
// the same predicate against the classes actually drawn — so a new cable
// class that reaches the plot without a legend row is caught at generate and
// export time instead of shipping silently (see the new-cable-class
// checklist: union → offsets → layers → legend → schedule → scene must all
// change together).
// ---------------------------------------------------------------------------

import { CableClass, SiteDesign } from './types';

// Classes whose legend row ALWAYS prints (reference sheet fixed rows):
// DC (+)/(−) pair, MV cable, aux distribution (0.480 kV), fiber (6 count).
export const ALWAYS_LEGEND_CLASSES: readonly CableClass[] = [
  'DC', 'MV', 'LVAC', 'FIBER',
] as const;

// Classes whose legend row prints only when the design routed at least one
// run of that class (spec §2 trench-class stack).
export const CONDITIONAL_LEGEND_CLASSES: readonly CableClass[] = [
  'AUXPWR', 'FIBER_TRUNK', 'CATL',
] as const;

// Every cable class present in the design's routed runs (ref/reference runs
// included — a reference MV run still prints MV linework on the plot).
export function drawnCableClasses(design: SiteDesign): Set<CableClass> {
  const out = new Set<CableClass>();
  for (const c of design.cables) out.add(c.class);
  return out;
}

// The cable classes the legend carries a row for. Always-rows print
// unconditionally; conditional rows key off the drawn runs.
export function legendCableClasses(design: SiteDesign): Set<CableClass> {
  const drawn = drawnCableClasses(design);
  const out = new Set<CableClass>(ALWAYS_LEGEND_CLASSES);
  for (const cls of CONDITIONAL_LEGEND_CLASSES) {
    if (drawn.has(cls)) out.add(cls);
  }
  return out;
}
