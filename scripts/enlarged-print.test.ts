// [604] Rendered-pixel legibility check for the enlarged AREA plan sheets.
//
// The [602] suite pins the tile-scale math, window bounds and byte identity,
// but nothing verified that the annotation actually RESOLVES at print
// resolution (the original complaint was literally "MAKE IMAGES LARGER").
// This test rasterizes a real enlarged-tile page of the plot-set PDF at
// 150 DPI (pdftoppm/poppler) and measures the ink of boosted equipment
// labels directly in the pixels:
//   1. absolute floor — the median glyph column span must correspond to at
//      least half the 0.08" minimum text height (cap height of a 0.08" em
//      courier glyph is ~0.06"), so a regression that silently shrinks
//      tile text below the readable floor fails here even if the
//      display-list math still "looks" consistent;
//   2. distinguishability — the SAME label rendered on the overall site
//      plan sheet (unreadable scale, which is why the tiles exist) must
//      measure clearly smaller than on the enlarged tile.
//
// Run with: npm run test:enlarged-print   (also part of npm test)

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { generateSiteDesign } from '../client/src/lib/nextera/layoutEngine';
import { getConfiguration } from '../client/src/lib/nextera/catalog';
import { SiteBoundary } from '../client/src/lib/nextera/types';
import {
  planEnlargedTiles, composeEnlargedPlan,
} from '../client/src/lib/nextera/enlargedPlans';
import { DxfWriter, addBaseLayers, DisplayOp } from '../client/src/lib/nextera/dxfExport';
import { SHEET_REGISTRY, SheetContext } from '../client/src/lib/nextera/dxfSheets';
import {
  buildPdfPlotString, makePageTransform, composeSheetDisplay, PageTransform,
} from '../client/src/lib/nextera/pdfPlot';

const DPI = 150;
// Contract under test: enlarged-tile text must print at >= ~0.08".
const MIN_TEXT_IN = 0.08;
// Courier cap height is ~0.6 em; demand at least half the em in ink so the
// check is tolerant of font metrics but still fails hard if the boost is
// dropped (unboosted 4' labels at 80 ft/in print at 0.05" em ~ 4 px cap).
const MIN_GLYPH_PX = Math.floor(MIN_TEXT_IN * DPI * 0.5); // 12 px em -> 6 px

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

// ---------------------------------------------------------------------------
// PGM (P5) loader — pdftoppm -gray output.
// ---------------------------------------------------------------------------
interface Gray { w: number; h: number; px: Uint8Array }

function loadPgm(file: string): Gray {
  const buf = readFileSync(file);
  // Header: "P5\n<w> <h>\n<maxval>\n" (fields may be split across lines).
  let pos = 0;
  const token = () => {
    while (buf[pos] === 0x20 || buf[pos] === 0x0a || buf[pos] === 0x0d || buf[pos] === 0x09) pos++;
    if (buf[pos] === 0x23) { while (buf[pos] !== 0x0a) pos++; return token(); } // comment
    const start = pos;
    while (pos < buf.length && buf[pos] !== 0x20 && buf[pos] !== 0x0a && buf[pos] !== 0x0d && buf[pos] !== 0x09) pos++;
    return buf.toString('ascii', start, pos);
  };
  const magic = token();
  if (magic !== 'P5') throw new Error(`expected P5 pgm, got ${magic}`);
  const w = parseInt(token(), 10);
  const h = parseInt(token(), 10);
  const maxval = parseInt(token(), 10);
  if (maxval !== 255) throw new Error(`expected maxval 255, got ${maxval}`);
  pos++; // single whitespace after maxval
  return { w, h, px: new Uint8Array(buf.subarray(pos, pos + w * h)) };
}

// Median per-column ink span (px) inside a crop box. Robust against stray
// linework: a vertical line only skews one column; a horizontal line adds a
// single row. Returns 0 when no ink is found.
const INK = 100; // gray threshold — vector strokes rasterize near black
function medianColumnSpan(img: Gray, x0: number, x1: number, y0: number, y1: number): number {
  const cx0 = Math.max(0, Math.floor(x0)), cx1 = Math.min(img.w - 1, Math.ceil(x1));
  const cy0 = Math.max(0, Math.floor(y0)), cy1 = Math.min(img.h - 1, Math.ceil(y1));
  const spans: number[] = [];
  for (let x = cx0; x <= cx1; x++) {
    let top = -1, bot = -1;
    for (let y = cy0; y <= cy1; y++) {
      if (img.px[y * img.w + x] < INK) { if (top < 0) top = y; bot = y; }
    }
    if (top >= 0) spans.push(bot - top + 1);
  }
  if (!spans.length) return 0;
  spans.sort((a, b) => a - b);
  return spans[Math.floor(spans.length / 2)];
}

// Median per-row ink span (px) inside a crop box — the transposed twin of
// medianColumnSpan, for 90°-rotated labels whose glyph height runs
// horizontally on the page.
function medianRowSpan(img: Gray, x0: number, x1: number, y0: number, y1: number): number {
  const cx0 = Math.max(0, Math.floor(x0)), cx1 = Math.min(img.w - 1, Math.ceil(x1));
  const cy0 = Math.max(0, Math.floor(y0)), cy1 = Math.min(img.h - 1, Math.ceil(y1));
  const spans: number[] = [];
  for (let y = cy0; y <= cy1; y++) {
    let left = -1, right = -1;
    for (let x = cx0; x <= cx1; x++) {
      if (img.px[y * img.w + x] < INK) { if (left < 0) left = x; right = x; }
    }
    if (left >= 0) spans.push(right - left + 1);
  }
  if (!spans.length) return 0;
  spans.sort((a, b) => a - b);
  return spans[Math.floor(spans.length / 2)];
}

// Crop box for a baseline-left text op under a page transform (inches->px).
// Handles horizontal (rot 0) and vertical (rot 90 CCW: baseline runs +y in
// model space = -y on the page, glyphs extend toward -x model = -x page).
function labelCrop(op: Extract<DisplayOp, { kind: 'text' }>, t: PageTransform) {
  const hIn = op.h / t.scale;
  const xIn = t.toX(op.x);
  const yIn = t.toY(op.y); // baseline (jsPDF alphabetic)
  // Courier advance is 0.6 em — crop only the glyph run, not the 0.9-em
  // layout estimate, to keep neighboring linework out of the box.
  const wIn = op.text.length * hIn * 0.6;
  if (op.rot === 90) {
    // Page-space: glyph run extends upward (model +y = page -y), glyph
    // height extends toward page +x from the baseline? Model -x = page -x.
    return {
      x0: (xIn - hIn * 1.05) * DPI, x1: (xIn + hIn * 0.15) * DPI,
      y0: (yIn - wIn) * DPI, y1: yIn * DPI,
    };
  }
  return {
    x0: xIn * DPI, x1: (xIn + wIn) * DPI,
    y0: (yIn - hIn * 1.05) * DPI, y1: (yIn + hIn * 0.15) * DPI,
  };
}

// Glyph-height ink measurement for a label: column spans for horizontal
// text, row spans for 90°-rotated text.
function labelInkSpan(img: Gray, op: Extract<DisplayOp, { kind: 'text' }>, t: PageTransform): number {
  const c = labelCrop(op, t);
  return op.rot === 90
    ? medianRowSpan(img, c.x0, c.x1, c.y0, c.y1)
    : medianColumnSpan(img, c.x0, c.x1, c.y0, c.y1);
}

async function main() {
  const config = getConfiguration('ge-aux-400');

  // Large synthetic parcel — same shape [602] uses: overall plot scale far
  // past the readable threshold, so enlarged tiles are generated.
  // Sized so the tile plan lands at 50 ft/in: coarser scales (100 ft/in) put
  // the 0.08" floor at 8 ft — physically too tall to fit dense container
  // stacks, so almost nothing boosts (the [607] collision-aware fitter keeps
  // packed labels at source size instead of smearing them over neighbors).
  const bigPoly = [
    { x: -2200, y: -1400 }, { x: 2200, y: -1400 },
    { x: 2200, y: 1400 }, { x: -2200, y: 1400 },
  ];
  const bigBoundary: SiteBoundary = {
    name: 'enlarged-print-test',
    polygon: bigPoly,
    origin: { lat: 29.35, lon: -99.14 },
    areaAcres: 1157,
  };
  const design = generateSiteDesign(bigBoundary, config, 100, 400, {
    hotClimate: true, roadMode: 'roads',
  });
  const ctx: SheetContext = {
    design,
    projectName: 'ENLARGED PRINT TEST',
    config,
    enlargedPlans: true,
  };

  console.log('\n[604] enlarged AREA sheets: rendered-pixel legibility at 150 DPI');
  const plan = planEnlargedTiles(design);
  check('[604] large parcel produces an enlarged tile plan', !!plan);
  if (!plan) process.exit(1);

  // Recompose tiles exactly like buildPdfPlot does so the page transform
  // (pinned by the tile's window border) reproduces the rendered positions.
  // Pick the first tile that actually carries boosted equipment labels —
  // corner tiles of a big grid can be pure empty-yard windows.
  // Candidates: FLOOR-BOOSTED equipment labels (the boost is collision-aware
  // since [607] — labels in packed cores keep their source size rather than
  // pile on top of each other, so only the labels that claimed the floor are
  // held to the rendered-pixel floor contract). Both orientations qualify;
  // rot-90 labels are measured with a transposed crop.
  const candidatesOf = (dxf: DxfWriter, tileIdx: number) => {
    const view = plan.tiles[tileIdx].view;
    const inset = 0.5 * plan.scale;
    return dxf.ops.filter((op): op is Extract<DisplayOp, { kind: 'text' }> =>
      op.kind === 'text' && op.layer === 'EQUIP - Labels' &&
      (op.rot === 0 || op.rot === 90) &&
      op.text.length >= 5 &&
      op.h / plan.scale >= MIN_TEXT_IN - 1e-9 &&
      op.x > view.minX + inset && op.x < view.maxX - inset &&
      op.y > view.minY + inset && op.y < view.maxY - inset &&
      (op.rot === 90
        ? op.y + op.text.length * op.h * 0.9 < view.maxY - inset
        : op.x + op.text.length * op.h * 0.9 < view.maxX - inset)
    );
  };
  let tileIdx = -1;
  let tileDxf = new DxfWriter();
  let labels: Extract<DisplayOp, { kind: 'text' }>[] = [];
  for (let i = 0; i < plan.tiles.length; i++) {
    const dxf = new DxfWriter();
    addBaseLayers(dxf);
    composeEnlargedPlan(dxf, ctx, plan, i);
    const cand = candidatesOf(dxf, i);
    if (cand.length >= 3) { tileIdx = i; tileDxf = dxf; labels = cand.slice(0, 6); break; }
  }
  check('[604] a tile carries >= 3 measurable equipment labels', tileIdx >= 0,
    `no tile with candidates among ${plan.tiles.length}`);
  if (tileIdx < 0) process.exit(1);
  const tileT = makePageTransform(tileDxf.ops);
  check('[604] tile page transform locks to the tile scale',
    tileT.scale === plan.scale, `${tileT.scale} vs ${plan.scale}`);
  // The floor contract in the display list itself: every candidate label is
  // boosted to at least 0.08" printed.
  const belowFloor = labels.filter(op => op.h / plan.scale < MIN_TEXT_IN - 1e-9);
  check('[604] every measured label is boosted to the 0.08" floor in the display list',
    belowFloor.length === 0,
    belowFloor.map(op => `${op.text}@${(op.h / plan.scale).toFixed(3)}"`).join(', '));

  // [622] Wipeout containment: the white label mask must track the FINAL
  // (boosted) text extent, or enlarged text pokes past its mask and the
  // underlying linework crosses it again. Every boosted equipment label on
  // the tile must sit fully inside some 'EQUIP - Label mask' hatch rect.
  {
    const maskRects = tileDxf.ops
      .filter((o): o is Extract<DisplayOp, { kind: 'hatch' }> =>
        o.kind === 'hatch' && o.layer === 'EQUIP - Label mask')
      .map(o => {
        const xs = o.loops[0].map(p => p[0]), ys = o.loops[0].map(p => p[1]);
        return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
      });
    check('[622] tile carries label mask hatches', maskRects.length > 0);
    const uncovered = labels.filter(op => {
      // estimated glyph box at the emitted (boosted) height, incl. rotation
      const w = op.text.length * op.h * 0.9;
      const ext = op.rot === 90
        ? { x0: op.x - op.h, x1: op.x, y0: op.y, y1: op.y + w }
        : { x0: op.x, x1: op.x + w, y0: op.y, y1: op.y + op.h };
      return !maskRects.some(m =>
        ext.x0 >= m.x0 - 1e-6 && ext.x1 <= m.x1 + 1e-6 &&
        ext.y0 >= m.y0 - 1e-6 && ext.y1 <= m.y1 + 1e-6);
    });
    check('[622] every boosted label sits inside its white wipeout mask',
      uncovered.length === 0, uncovered.map(o => o.text).join(', '));
  }

  // Same labels on the overall site plan sheet (registry index 1) for the
  // distinguishability comparison. (Its page transform auto-fits the framed
  // sheet, so its scale is >= the raw boundary's overall scale.)
  const siteDisp = composeSheetDisplay(SHEET_REGISTRY[1], ctx, 1);
  const siteT = makePageTransform(siteDisp.ops);
  check('[604] overall site plan prints past the readable threshold',
    siteT.scale >= plan.overallScale, `${siteT.scale} vs overall ${plan.overallScale}`);
  const siteLabelByText = new Map<string, Extract<DisplayOp, { kind: 'text' }>>();
  for (const op of siteDisp.ops) {
    if (op.kind === 'text' && op.layer === 'EQUIP - Labels' && (op.rot === 0 || op.rot === 90)) {
      siteLabelByText.set(`${op.text}@${op.x.toFixed(3)},${op.y.toFixed(3)}`, op);
    }
  }

  // Build the real plot set and rasterize the two pages of interest.
  const tmp = mkdtempSync(path.join(tmpdir(), 'enlarged-print-'));
  try {
    const pdfStr = buildPdfPlotString(ctx);
    const pdfPath = path.join(tmp, 'plot.pdf');
    writeFileSync(pdfPath, Buffer.from(pdfStr, 'latin1'));

    // Page order in buildPdfPlot with only enlargedPlans opted in:
    // SHEET_REGISTRY pages, then one page per tile, then the mech appendix.
    const sitePage = 2; // sitePlanSheet is SHEET_REGISTRY[1]
    const tilePage = SHEET_REGISTRY.length + 1 + tileIdx;
    const render = (page: number, prefix: string): Gray => {
      execFileSync('pdftoppm', [
        '-gray', '-r', String(DPI), '-f', String(page), '-l', String(page),
        '-aa', 'no', '-aaVector', 'no', // hard ink edges — measure strokes, not blur
        pdfPath, path.join(tmp, prefix),
      ]);
      const out = readdirSync(tmp).find(f => f.startsWith(prefix) && f.endsWith('.pgm'));
      if (!out) throw new Error(`pdftoppm produced no ${prefix} page`);
      return loadPgm(path.join(tmp, out));
    };
    const tileImg = render(tilePage, 'tile');
    const siteImg = render(sitePage, 'site');
    check('[604] tile page rasterized at 150 DPI (34x22in landscape)',
      tileImg.w === 34 * DPI && tileImg.h === 22 * DPI, `${tileImg.w}x${tileImg.h}`);

    // The tile title caption exists on the page (sanity that we hit an
    // enlarged sheet, not a registry page): its ink region is non-empty.
    const title = tileDxf.ops.find((op): op is Extract<DisplayOp, { kind: 'text' }> =>
      op.kind === 'text' && op.text.startsWith('ENLARGED SITE PLAN - AREA '));
    check('[604] tile page carries the ENLARGED SITE PLAN title text op', !!title);
    if (title) {
      const c = labelCrop(title, tileT);
      check('[604] title caption resolves in the rendered pixels',
        medianColumnSpan(tileImg, c.x0, c.x1, c.y0, c.y1) >= MIN_GLYPH_PX);
    }

    // Core check: every boosted label's rendered glyph span meets the floor
    // AND is clearly larger than the same label on the base sheet.
    let minTilePx = Infinity;
    let comparisons = 0, distinguishable = 0;
    const details: string[] = [];
    for (const op of labels) {
      const tilePx = labelInkSpan(tileImg, op, tileT);
      minTilePx = Math.min(minTilePx, tilePx);
      details.push(`${op.text}:${tilePx}px`);
      const base = siteLabelByText.get(`${op.text}@${op.x.toFixed(3)},${op.y.toFixed(3)}`);
      if (base) {
        const basePx = labelInkSpan(siteImg, base, siteT);
        comparisons++;
        if (tilePx >= Math.max(2 * basePx, basePx + 3)) distinguishable++;
        details[details.length - 1] += ` (base ${basePx}px)`;
      }
    }
    console.log(`  measured: ${details.join(', ')}`);
    check(`[604] every enlarged label resolves at >= ${MIN_GLYPH_PX} px (~0.08" em) at ${DPI} DPI`,
      labels.length > 0 && minTilePx >= MIN_GLYPH_PX, `min ${minTilePx}px`);
    check('[604] enlarged labels found on the base sheet for comparison',
      comparisons >= 2, `${comparisons} matched`);
    check('[604] enlarged labels are clearly larger than the base sheet\'s',
      comparisons > 0 && distinguishable === comparisons,
      `${distinguishable}/${comparisons} distinguishable`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  // -------------------------------------------------------------------
  // [615] ECI yard symbols must print as linework, not slabs: rasterize the
  // site plan sheet in ECI mode and measure ink inside a container
  // footprint. Before the yard thinning + light shading gray, the delivered
  // raster-traced artwork rendered ~solid dark (dark share well above 50%);
  // crisp reference-style linework keeps a bounded dark share with visible
  // light interior (white + light-gray shading).
  // -------------------------------------------------------------------
  console.log('\n[615] ECI yard symbols: rendered-pixel slab guard at 150 DPI');
  {
    const poly = [
      { x: -600, y: -450 }, { x: 600, y: -450 },
      { x: 600, y: 450 }, { x: -600, y: 450 },
    ];
    const boundary: SiteBoundary = {
      name: 'eci-slab-test', polygon: poly,
      origin: { lat: 29.35, lon: -99.14 }, areaAcres: 248,
    };
    const design = generateSiteDesign(boundary, config, 40, 160, { hotClimate: true });
    const ctx: SheetContext = {
      design, projectName: 'ECI SLAB TEST', config, eciLegend: true,
    };
    const disp = composeSheetDisplay(SHEET_REGISTRY[1], ctx, 1);
    const t = makePageTransform(disp.ops);
    // rotation is radians; accept 0/π (long axis on x) and ±π/2 (on y).
    const axisRot = (e: { rotation: number }) => {
      const r = ((e.rotation % Math.PI) + Math.PI) % Math.PI;
      return r < 0.01 || r > Math.PI - 0.01 ? 0 : Math.abs(r - Math.PI / 2) < 0.01 ? 90 : -1;
    };
    const bess = design.equipment.filter(e => e.kind === 'bess' && axisRot(e) >= 0);
    check('[615] axis-aligned BESS containers available to measure', bess.length >= 3,
      `${bess.length} of ${design.equipment.filter(e => e.kind === 'bess').length} bess; rotations ${[...new Set(design.equipment.filter(e => e.kind === 'bess').map(e => e.rotation))].join(',')}`);
    const tmp = mkdtempSync(path.join(tmpdir(), 'eci-slab-'));
    try {
      const pdfPath = path.join(tmp, 'plot.pdf');
      writeFileSync(pdfPath, Buffer.from(buildPdfPlotString(ctx), 'latin1'));
      execFileSync('pdftoppm', [
        '-gray', '-r', String(DPI), '-f', '2', '-l', '2',
        '-aa', 'no', '-aaVector', 'no', pdfPath, path.join(tmp, 'site'),
      ]);
      const out = readdirSync(tmp).find(f => f.startsWith('site') && f.endsWith('.pgm'))!;
      const img = loadPgm(path.join(tmp, out));
      let worstDark = 0, bestLight = 1;
      const details: string[] = [];
      for (const eq of bess.slice(0, 4)) {
        // Footprint window in pixels (axis-aligned container, small inset so
        // the outline stroke itself stays inside the window).
        const swap = axisRot(eq) === 90;
        const hx = (swap ? eq.width : eq.length) / 2 - 0.5;
        const hy = (swap ? eq.length : eq.width) / 2 - 0.5;
        const x0 = Math.round(t.toX(eq.x - hx) * DPI), x1 = Math.round(t.toX(eq.x + hx) * DPI);
        const y0 = Math.round(t.toY(eq.y + hy) * DPI), y1 = Math.round(t.toY(eq.y - hy) * DPI);
        let dark = 0, light = 0, n = 0;
        for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y++) {
          for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) {
            const v = img.px[y * img.w + x];
            n++;
            if (v < 96) dark++;
            else light++; // white paper or light shading gray
          }
        }
        const darkShare = n ? dark / n : 1;
        const lightShare = n ? light / n : 0;
        worstDark = Math.max(worstDark, darkShare);
        bestLight = Math.min(bestLight, lightShare);
        details.push(`${eq.id ?? 'bess'}: dark ${(darkShare * 100).toFixed(1)}%`);
      }
      console.log(`  measured: ${details.join(', ')}`);
      check('[615] no container prints as a slab (dark ink share bounded)',
        worstDark > 0 && worstDark < 0.5, `worst dark share ${(worstDark * 100).toFixed(1)}%`);
      check('[615] interior stays visibly light (white/shading dominates)',
        bestLight >= 0.5, `min light share ${(bestLight * 100).toFixed(1)}%`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error('Test run crashed:', err);
  process.exit(1);
});
