// Central display-string terminology map (register F-17).
//
// Reviewer redlines standardized the words that print on issued sheets:
//   - DRIVE PATH(S), never ROAD(S) ("24' DRIVE PATH (TYP)")
//   - BATTERY CONTAINER(S), never BESS used as a noun for the boxes
//   - PROJECT BOUNDARY, never PROJECT LOT LINE / LOT LINE
//
// Note (checked against Attachment 2A R2, 5-14-2026): the R2 guidance legend
// itself still says "Auxiliary Switch Panel" — so that name is KEPT (R2 wins
// over the symbol-library file naming "aux distribution center").
//
// Every sheet-emitting module should pull display nouns from TERMS instead
// of hardcoding them, and the regression suite asserts no emitted sheet text
// matches FORBIDDEN_SHEET_TERMS.

export const TERMS = {
  drivePath: 'DRIVE PATH',
  drivePaths: 'DRIVE PATHS',
  batteryContainer: 'BATTERY CONTAINER',
  batteryContainers: 'BATTERY CONTAINERS',
  projectBoundary: 'PROJECT BOUNDARY',
  auxPanel: 'AUXILIARY SWITCH PANEL', // per Attachment 2A R2 legend
  // Mid-island auxiliary cluster, named exactly as the delivered equipment
  // legend artwork names it (Nextera_Legend_Equipment22 sheet, traced in
  // last3legends_*.glb). These three are separate pieces of gear from the
  // auxPanel row above: the legend, the plan callouts and the schedule all
  // pull the names from here so a communications cabinet can never be
  // printed as a junction box, nor the transformer as an unbranded box.
  auxDistCenter: 'LAKESHORE AUX DISTRIBUTION CENTER',
  auxTransformer: 'ABB HITACHI AUX TRANSFORMER',
  commsCabinet: 'COMMUNICATIONS CABINET',
} as const;

// Banned in any text that prints on an issued sheet (case-insensitive).
// "BESS" stays legal as an adjective (BESS YARD, BESS FENCE, BESS FEEDER) —
// only the noun-for-the-box usages are banned.
export const FORBIDDEN_SHEET_TERMS: Array<{ re: RegExp; why: string }> = [
  { re: /\bROADS?\b/i, why: 'use DRIVE PATH(S)' },
  { re: /\bLOT\s+LINE\b/i, why: 'use PROJECT BOUNDARY' },
  { re: /\bBESS\s+CONTAINERS?\b/i, why: 'use BATTERY CONTAINER(S)' },
  { re: /\bBESS\s+(HAVE|HAS|MUST|SHALL|TO BE)\b/i, why: 'BESS used as a noun — use BATTERY CONTAINERS' },
];
