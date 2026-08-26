// One-line diagram symbol library for the auto-generated SLD.
//
// Two selectable symbol conventions, NEVER mixed on one sheet:
//  - 'ANSI' (default): ANSI/IEEE Std 315-1975 (reaffirmed 1993) / ANSI
//    Y32.2 graphic symbols — the North American one-line convention.
//  - 'IEC' (opt-in project setting): IEC 60617 (BS EN 60617) symbol set
//    for international work.
//
// Every symbol cites the standard clause/item it is drawn from. Geometry
// is parameterized in SCHEMATIC UNITS and drawn through a tiny pen
// interface, so the same library feeds both the DXF writer and the PDF
// display-list renderer (WYSIWYG by construction).
//
// IEEE C37.2-2008 device function numbers used on the SLD:
//  ┌──────┬────────────────────────────────────────────────────────────┐
//  │ 52   │ AC circuit breaker                                         │
//  │ 89   │ Line switch (disconnect / isolating switch)                │
//  │ 50/51│ Instantaneous / AC time overcurrent relay (feeder prot.)   │
//  │ 27/59│ Under/overvoltage relay (IEEE 1547 §6.4 trip functions)    │
//  │ 81   │ Frequency relay (IEEE 1547 §6.4)                           │
//  │ 25   │ Synchronizing / synchronism-check device                   │
//  │ 87T  │ Transformer differential relay                             │
//  └──────┴────────────────────────────────────────────────────────────┘
// (Relay coordination itself is out of scope — the numbers designate the
// switching/protective devices drawn on this one-line.)

export type SldStandard = 'ANSI' | 'IEC';

// Pen: schematic-unit drawing surface. The SLD compositor supplies an
// implementation that scales into the sheet plan rect and mirrors every
// primitive into both the DXF entity stream and the PDF display list.
export interface SymbolPen {
  line(x1: number, y1: number, x2: number, y2: number, layer?: string): void;
  poly(pts: [number, number][], closed: boolean, layer?: string): void;
  // Full circles must be emitted as two half arcs (a 0..2π arc normalizes
  // to a zero sweep in the DXF — see project SLD convention).
  circle(cx: number, cy: number, r: number, layer?: string): void;
  arc(cx: number, cy: number, r: number, startRad: number, endRad: number, layer?: string): void;
  text(cx: number, y: number, h: number, t: string, layer?: string): void; // centered
}

// ---------------------------------------------------------------------------
// Circuit breaker.
// ANSI/IEEE 315 item 46.3 (power one-line): a closed square on the circuit.
// IEC 60617 S00287: straight circuit with an "X" at the contact point.
// ---------------------------------------------------------------------------
export function symBreaker(pen: SymbolPen, std: SldStandard, cx: number, cy: number, s: number) {
  const h = s / 2;
  if (std === 'ANSI') {
    pen.poly(
      [[cx - h, cy - h], [cx + h, cy - h], [cx + h, cy + h], [cx - h, cy + h]],
      true
    );
  } else {
    // IEC 60617 S00287: the breaker is an open-switch stroke with a small
    // "X" (multiplication cross) marking the fixed contact.
    pen.line(cx, cy - h, cx, cy + h * 0.1);
    pen.line(cx, cy + h * 0.1, cx - h * 0.9, cy + h);
    const xr = s * 0.28;
    pen.line(cx - xr, cy - h - xr, cx + xr, cy - h + xr);
    pen.line(cx - xr, cy - h + xr, cx + xr, cy - h - xr);
  }
}

// ---------------------------------------------------------------------------
// Disconnect / isolating switch (device 89).
// ANSI/IEEE 315 item 46.2: hinged blade drawn open at ~30° off the run.
// IEC 60617 S00258 (disconnector): open blade with a short bar at the
// fixed contact perpendicular to the run.
// ---------------------------------------------------------------------------
export function symDisconnect(pen: SymbolPen, std: SldStandard, cx: number, cy: number, s: number) {
  const h = s / 2;
  // Hinge at bottom, fixed contact at top; blade swings off-axis.
  pen.line(cx, cy - h, cx, cy - h * 0.6);
  pen.line(cx, cy - h * 0.6, cx - s * 0.55, cy + h * 0.75);
  pen.line(cx, cy + h * 0.6, cx, cy + h);
  if (std === 'IEC') {
    // IEC fixed-contact bar (perpendicular tick at the stationary contact)
    pen.line(cx - s * 0.3, cy + h * 0.6, cx + s * 0.3, cy + h * 0.6);
  }
}

// ---------------------------------------------------------------------------
// Fuse.
// ANSI/IEEE 315 item 36: rectangle with the circuit line passing through.
// IEC 60617 S00137: rectangle with the conductor drawn through its length.
// (The two shapes coincide for the one-line form; kept as one geometry.)
// ---------------------------------------------------------------------------
export function symFuse(pen: SymbolPen, _std: SldStandard, cx: number, cy: number, s: number) {
  const w = s * 0.44, h = s;
  pen.poly(
    [[cx - w / 2, cy - h / 2], [cx + w / 2, cy - h / 2], [cx + w / 2, cy + h / 2], [cx - w / 2, cy + h / 2]],
    true
  );
  pen.line(cx, cy - h / 2, cx, cy + h / 2);
}

// ---------------------------------------------------------------------------
// Two-winding transformer.
// ANSI/IEEE 315 item 86 (one-line form): two overlapping circles.
// IEC 60617 S00832: two SEPARATED (tangent, non-overlapping) circles.
// Winding connection marks (delta / wye) per IEEE 315 item 86.16 /
// IEC 60617 S00258 winding-connection designators.
// ---------------------------------------------------------------------------
export function symTransformer2W(
  pen: SymbolPen, std: SldStandard, cx: number, cy: number, r: number,
  conn?: { hv: 'delta' | 'wye'; lv: 'delta' | 'wye' }
) {
  const sep = std === 'ANSI' ? r * 1.2 : r * 2.0; // ANSI overlaps, IEC tangent
  pen.circle(cx, cy, r);
  pen.circle(cx, cy - sep, r);
  if (conn) {
    connMark(pen, conn.hv, cx, cy + r * 0.35, r * 0.4);
    connMark(pen, conn.lv, cx, cy - sep - r * 0.35, r * 0.4);
  }
}

// Winding connection designator: delta triangle / wye Y (IEEE 315 item
// 86.16; IEC 60617 form 2 winding marks).
function connMark(pen: SymbolPen, kind: 'delta' | 'wye', cx: number, cy: number, r: number) {
  if (kind === 'delta') {
    pen.poly(
      [[cx, cy + r], [cx - r * 0.87, cy - r * 0.5], [cx + r * 0.87, cy - r * 0.5]],
      true
    );
  } else {
    pen.line(cx, cy, cx, cy + r);
    pen.line(cx, cy, cx - r * 0.87, cy - r * 0.5);
    pen.line(cx, cy, cx + r * 0.87, cy - r * 0.5);
  }
}

// ---------------------------------------------------------------------------
// Current transformer (CT).
// ANSI/IEEE 315 item 86.13 one-line form: a circle centered on the run.
// IEC 60617 S00563: circle with the primary conductor passing through.
// ---------------------------------------------------------------------------
export function symCT(pen: SymbolPen, _std: SldStandard, cx: number, cy: number, r: number) {
  pen.circle(cx, cy, r);
}

// ---------------------------------------------------------------------------
// Potential / voltage transformer (PT/VT).
// ANSI/IEEE 315 item 86: two small overlapping circles tapped off the bus.
// IEC 60617 S00832 (instrument VT one-line): same two-circle form, tangent.
// ---------------------------------------------------------------------------
export function symPT(pen: SymbolPen, std: SldStandard, cx: number, cy: number, r: number) {
  const sep = std === 'ANSI' ? r * 1.2 : r * 2.0;
  pen.circle(cx, cy, r);
  pen.circle(cx, cy - sep, r);
}

// ---------------------------------------------------------------------------
// Meter (revenue metering per IEEE 1547-2018 §4.4 / typical LGIA Appendix
// one-line requirements): ANSI/IEEE 315 item 48 — circle with a letter
// function designation ("W"/"WH" for watthour). IEC 60617 S00911 uses the
// same circled-letter form (asterisked function letter).
// ---------------------------------------------------------------------------
export function symMeter(pen: SymbolPen, _std: SldStandard, cx: number, cy: number, r: number, label = 'WH') {
  pen.circle(cx, cy, r);
  pen.text(cx, cy - r * 0.38, r * 0.8, label);
}

// ---------------------------------------------------------------------------
// Earth / ground.
// ANSI/IEEE 315 item 13.2 (earth ground): three descending horizontal
// strokes. IEC 60617 S00200: identical three-stroke earth symbol.
// ---------------------------------------------------------------------------
export function symGround(pen: SymbolPen, _std: SldStandard, cx: number, cy: number, s: number) {
  pen.line(cx, cy + s * 0.5, cx, cy);
  pen.line(cx - s * 0.5, cy, cx + s * 0.5, cy);
  pen.line(cx - s * 0.33, cy - s * 0.22, cx + s * 0.33, cy - s * 0.22);
  pen.line(cx - s * 0.16, cy - s * 0.44, cx + s * 0.16, cy - s * 0.44);
}

// ---------------------------------------------------------------------------
// Battery (storage).
// ANSI/IEEE 315 item 11: alternating long (positive) and short (negative)
// plate strokes. IEC 60617 S00048: identical long/short plate pairs.
// ---------------------------------------------------------------------------
export function symBattery(pen: SymbolPen, _std: SldStandard, cx: number, cy: number, s: number) {
  const long = s * 0.5, short = s * 0.24, gap = s * 0.22;
  pen.line(cx - long, cy + gap / 2, cx + long, cy + gap / 2);
  pen.line(cx - short, cy - gap / 2, cx + short, cy - gap / 2);
  pen.line(cx - long, cy - gap / 2 - gap, cx + long, cy - gap / 2 - gap);
  pen.line(cx - short, cy - gap / 2 - gap * 2, cx + short, cy - gap / 2 - gap * 2);
}

// ---------------------------------------------------------------------------
// PCS / inverter (DC-AC converter).
// IEC 60617 S01213 (converter): square split by a diagonal, DC marks (=)
// on one side and AC mark (~) on the other. IEEE 315 item 60 shows the
// same boxed-converter one-line form; this box is the industry-standard
// PCS representation on both conventions.
// ---------------------------------------------------------------------------
export function symInverter(pen: SymbolPen, _std: SldStandard, cx: number, cy: number, s: number) {
  const h = s / 2;
  pen.poly([[cx - h, cy - h], [cx + h, cy - h], [cx + h, cy + h], [cx - h, cy + h]], true);
  pen.line(cx - h, cy - h, cx + h, cy + h); // diagonal: AC (upper-left) / DC (lower-right)
  // AC tilde (upper-left): small two-arc wave
  const tr = s * 0.11, ty = cy + h * 0.5, tx = cx - h * 0.52;
  pen.arc(tx - tr, ty, tr, 0, Math.PI);
  pen.arc(tx + tr, ty, tr, Math.PI, Math.PI * 2);
  // DC marks (lower-right): solid stroke over dashed pair
  const dx = cx + h * 0.5, dy = cy - h * 0.5, dw = s * 0.22;
  pen.line(dx - dw, dy + s * 0.07, dx + dw, dy + s * 0.07);
  pen.line(dx - dw, dy - s * 0.07, dx - dw * 0.3, dy - s * 0.07);
  pen.line(dx + dw * 0.3, dy - s * 0.07, dx + dw, dy - s * 0.07);
}
