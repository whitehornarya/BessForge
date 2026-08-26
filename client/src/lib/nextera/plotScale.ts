// Shared plot-scale ladder for the ANSI D (34x22) plot sheets. Lives in its
// own module so both pdfPlot (page transform) and dxfExport (graphic scale
// bar caption) compute the SAME "1\" = XX'" scale — no import cycle and no
// drift between the printed caption and the actual page transform.
export const PAGE_W_IN = 34;
export const PAGE_H_IN = 22;
export const PAGE_MARGIN_IN = 0.5;

// Standard engineering scales, ft per inch.
export const STANDARD_SCALES_FT_PER_IN = [10, 20, 30, 40, 50, 60, 80, 100, 150, 200, 300, 400, 500, 800, 1000];

// Smallest standard scale (ft/in) that fits the extents in the printable area.
export function pickScale(extentWFt: number, extentHFt: number): number {
  const availW = PAGE_W_IN - 2 * PAGE_MARGIN_IN;
  const availH = PAGE_H_IN - 2 * PAGE_MARGIN_IN;
  for (const s of STANDARD_SCALES_FT_PER_IN) {
    if (extentWFt / s <= availW && extentHFt / s <= availH) return s;
  }
  // Beyond the standard ladder: smallest round 1000 ft/in scale that fits,
  // so oversized extents are never silently clipped off the page.
  const need = Math.max(extentWFt / availW, extentHFt / availH);
  return Math.ceil(need / 1000) * 1000;
}
