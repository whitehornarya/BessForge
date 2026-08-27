/**
 * Visual regression: the CAD drawing view actually renders pixels.
 *
 * The CAD view mode (DesignScene viewMode === 'cad') renders the DXF
 * exporter's own display list (composeDesignDxf ops via CadLinework) on a
 * dark drawing background — WYSIWYG with the exported file. Source-scan
 * tests in scripts/nextera.test.ts verify that wiring textually, but nothing
 * verified the rendered pixels: a frozen or blank CAD canvas (Suspense stuck
 * on the drei Text font, a demand-frameloop repaint bug, a broken shader)
 * would ship silently.
 *
 * This script renders the app with SwiftShader (software WebGL), loads the
 * sample, places a substation (so feeders + their per-feeder color overrides
 * exist), switches to the CAD view by clicking the CAD button (AFTER the
 * design loads — sample load fires the overview preset which forces 3D),
 * screenshots the canvas and fails loudly unless the frame shows:
 *   - the dark drawing background (#101418) as the dominant pixel class,
 *   - white linework/labels (ACI 7 -> #f0f0f0: sheet frame, equipment labels),
 *   - the magenta site boundary (ACI 6 -> #ff5cff),
 *   - feeder-colored linework (per-feeder palette overrides, F1 red #ff4d4d /
 *     F2 orange #ff9a33 hues), while warm red pixels stay sparse enough to
 *     prove closed red outlines were not restored around every equipment unit.
 *
 * Run: npm run test:cad-visual   (needs no GPU; boots its own dev server on
 * port 5199 if one is not already running).
 *
 * On failure the captured frame is left at /tmp/cad-visual.png.
 */
import puppeteer from 'puppeteer';
import fs from 'fs';

import { resolveChromiumPath } from './chromium-path.mjs';
import { TEST_BASE as BASE, ensureDevServer, stopDevServer } from './dev-server.mjs';
const SHOT = '/tmp/cad-visual.png';
const REALISTIC_SHOT = '/tmp/cad-realistic-visual.png';
const sleep = ms => new Promise(r => setTimeout(r, ms));

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  console.error(`Screenshot (if captured): ${SHOT}`);
  process.exit(1);
}

// Decode the PNG in-page via a 2D canvas + getImageData (no pngjs/sharp in
// this repo) and bucket pixels into the CAD drawing's color classes. The top
// ~110px strip is skipped: the 3D/CAD/2D view-mode buttons overlay the canvas
// there and their cyan/white accents would pollute the counts.
async function classifyPixels(page, b64) {
  return page.evaluate(async (b64) => {
    const img = new Image();
    await new Promise((res, rej) => {
      img.onload = res;
      img.onerror = rej;
      img.src = 'data:image/png;base64,' + b64;
    });
    const cv = document.createElement('canvas');
    cv.width = img.width;
    cv.height = img.height;
    const ctx = cv.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const y0 = 110;
    const { data } = ctx.getImageData(0, y0, cv.width, cv.height - y0);
    const W = cv.width, H = cv.height - y0;
    // Mask the bottom-right corner: the HTML "MV FEEDERS" legend overlays
    // the canvas there and its red/orange swatches would satisfy the feeder
    // pixel check even if the drawn feeder linework vanished.
    const maskX = W - 300, maskY = H - 220;
    let dark = 0, white = 0, magenta = 0, feeder = 0, total = 0;
    for (let i = 0; i < data.length; i += 4) {
      const px = (i / 4) % W, py = Math.floor(i / 4 / W);
      if (px >= maskX && py >= maskY) continue;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      total++;
      // Dark drawing background #101418 (blue-leaning near-black). Allow
      // generous slack for AA against bright linework.
      if (r < 45 && g < 50 && b < 60 && b >= r) dark++;
      // White linework/labels (ACI 7 -> #f0f0f0): bright, low chroma.
      if (r > 190 && g > 190 && b > 190) white++;
      // Magenta boundary (ACI 6 -> #ff5cff): red+blue high, green well below.
      if (r > 170 && b > 170 && g < 160 && r - g > 60 && b - g > 60) magenta++;
      // Feeder palette overrides. The first feeders get red #ff4d4d and
      // orange #ff9a33 — warm, red-dominant, low blue; distinct from the
      // magenta boundary (high blue) and white (low chroma).
      if (r > 170 && b < 130 && r - b > 90) feeder++;
    }
    return { dark, white, magenta, feeder, total, w: cv.width, h: cv.height };
  }, b64);
}

async function changedPixels(page, beforeB64, afterB64) {
  return page.evaluate(async (beforeB64, afterB64) => {
    const decode = b64 => new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = 'data:image/png;base64,' + b64;
    });
    const [before, after] = await Promise.all([decode(beforeB64), decode(afterB64)]);
    const cv = document.createElement('canvas');
    cv.width = before.width; cv.height = before.height;
    const ctx = cv.getContext('2d');
    ctx.drawImage(before, 0, 0);
    const a = ctx.getImageData(0, 0, cv.width, cv.height).data;
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.drawImage(after, 0, 0);
    const b = ctx.getImageData(0, 0, cv.width, cv.height).data;
    let changed = 0;
    for (let i = 0; i < a.length; i += 4) {
      if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 36) {
        changed++;
      }
    }
    return changed;
  }, beforeB64, afterB64);
}

async function main() {
  await ensureDevServer();

  const browser = await puppeteer.launch({
    headless: true,
    executablePath: resolveChromiumPath(),
    args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    defaultViewport: { width: 1280, height: 800 },
  });
  try {
    const page = await browser.newPage();
    const graphicsErrors = [];
    // Satellite imagery costs memory and adds a network dependency; the CAD
    // view draws on a dark plane and never shows it anyway.
    await page.evaluateOnNewDocument(() => {
      localStorage.setItem('nextera-show-satellite', 'false');
    });
    page.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 300)));
    page.on('console', msg => {
      const text = msg.text();
      if (/Couldn't load texture|WebGLRenderer: Context Lost/i.test(text)) graphicsErrors.push(text);
    });

    await page.goto(`${BASE}/`, { waitUntil: 'networkidle2', timeout: 90000 });

    // Drive the app through the zustand store (reliable; no UI clicking) to
    // load the sample and place a substation so feeders exist — the CAD view
    // draws feeder home runs with per-feeder color overrides.
    const loaded = await page.evaluate(async () => {
      const mod = await import('/src/lib/stores/useDesignStore.ts');
      const store = mod.useDesignStore;
      window.__store = store;
      await store.getState().loadSample('/samples/hondo-100mw.kmz', 'Hondo 100MW');
      // boundary and design both populate asynchronously after loadSample.
      let t0 = Date.now();
      while (Date.now() - t0 < 60000) {
        const s = store.getState();
        if (s.boundary && s.design) break;
        await new Promise(r => setTimeout(r, 500));
      }
      const s0 = store.getState();
      if (!s0.boundary || !s0.design) {
        return { ok: false, why: 'sample did not load a design' };
      }
      const xs = s0.design.boundary.polygon.map(p => p.x);
      const ys = s0.design.boundary.polygon.map(p => p.y);
      s0.placeSubstation({
        x: Math.max(...xs) + 120,
        y: (Math.min(...ys) + Math.max(...ys)) / 2,
      });
      t0 = Date.now();
      while (Date.now() - t0 < 30000) {
        if (store.getState().feeders.length > 0) return { ok: true };
        await new Promise(r => setTimeout(r, 300));
      }
      return { ok: false, why: 'no feeders after placing substation' };
    });
    if (!loaded.ok) fail(`setup failed: ${loaded.why}`);

    // [919] The toolbar Labels control is the same project-wide setting in
    // both 3D and CAD. Exercise the real button in both views and prove the
    // state survives view changes instead of falling back to local UI state.
    const labelToggle3d = await page.$('[data-testid="drawing-labels-toggle"]');
    if (!labelToggle3d) fail('Labels toolbar control not found in 3D view');
    if (await labelToggle3d.evaluate(el => el.getAttribute('aria-pressed')) !== 'true') {
      fail('Labels toolbar control did not start in the shared on state');
    }
    await page.evaluate(() => {
      document.querySelector('[data-testid="drawing-labels-toggle"]').click();
    });
    await page.waitForFunction(
      () => document.querySelector('[data-testid="drawing-labels-toggle"]')?.getAttribute('aria-pressed') === 'false',
      { timeout: 5000 },
    );
    const labelsOff3d = await page.evaluate(() => ({
      pressed: document.querySelector('[data-testid="drawing-labels-toggle"]')?.getAttribute('aria-pressed'),
      shared: window.__store.getState().drawingVisibility.labels,
    }));
    if (labelsOff3d.pressed !== 'false' || labelsOff3d.shared !== false) {
      fail(`3D Labels control did not update shared state: ${JSON.stringify(labelsOff3d)}`);
    }

    const clickView = label => page.evaluate(label => {
      const btn = [...document.querySelectorAll('button')]
        .find(b => b.textContent?.trim() === label);
      if (!btn) return false;
      btn.click();
      return true;
    }, label);

    if (!(await clickView('CAD'))) fail('CAD view-mode button not found');
    await sleep(1000);
    const labelsOffCad = await page.evaluate(() => ({
      exists: !!document.querySelector('[data-testid="drawing-labels-toggle"]'),
      pressed: document.querySelector('[data-testid="drawing-labels-toggle"]')?.getAttribute('aria-pressed'),
      shared: window.__store.getState().drawingVisibility.labels,
    }));
    if (!labelsOffCad.exists || labelsOffCad.pressed !== 'false' || labelsOffCad.shared !== false) {
      fail(`CAD Labels control did not preserve the shared off state: ${JSON.stringify(labelsOffCad)}`);
    }
    await page.evaluate(() => {
      document.querySelector('[data-testid="drawing-labels-toggle"]').click();
    });
    await page.waitForFunction(
      () => document.querySelector('[data-testid="drawing-labels-toggle"]')?.getAttribute('aria-pressed') === 'true',
      { timeout: 5000 },
    );
    const labelsOnCad = await page.evaluate(() => ({
      pressed: document.querySelector('[data-testid="drawing-labels-toggle"]')?.getAttribute('aria-pressed'),
      shared: window.__store.getState().drawingVisibility.labels,
    }));
    if (labelsOnCad.pressed !== 'true' || labelsOnCad.shared !== true) {
      fail(`CAD Labels control did not restore shared state: ${JSON.stringify(labelsOnCad)}`);
    }

    if (!(await clickView('3D'))) fail('3D view-mode button not found');
    await sleep(1000);
    const labelsOn3d = await page.evaluate(() => ({
      exists: !!document.querySelector('[data-testid="drawing-labels-toggle"]'),
      pressed: document.querySelector('[data-testid="drawing-labels-toggle"]')?.getAttribute('aria-pressed'),
      shared: window.__store.getState().drawingVisibility.labels,
    }));
    if (!labelsOn3d.exists || labelsOn3d.pressed !== 'true' || labelsOn3d.shared !== true) {
      fail(`3D Labels control did not preserve the shared on state: ${JSON.stringify(labelsOn3d)}`);
    }

    // Load the manufacturer GLBs and their embedded textures in 3D first,
    // then carry those exact cached resources into CAD on the same Canvas.
    // This reproduces the user path that used to tear down WebGL while blob
    // texture loads were still in flight.
    const persistentCanvas = await page.$('canvas');
    await page.evaluate(() => {
      const control = document.querySelector('[data-testid="realistic-models-toggle"]');
      if (control?.getAttribute('aria-pressed') !== 'true') control.click();
    });
    await page.waitForFunction(
      () => document.querySelector('[data-testid="realistic-models-toggle"]')?.getAttribute('aria-pressed') === 'true',
      { timeout: 5000 },
    );
    await page.evaluate(async () => {
      const { waitForSceneReady } = await import('/src/lib/sceneReady.ts');
      await waitForSceneReady({ timeoutMs: 120000 });
    });
    await sleep(8000);
    if (graphicsErrors.length) {
      fail(`Realistic 3D preload emitted graphics errors: ${graphicsErrors.join(' | ').slice(0, 1000)}`);
    }

    // Return to CAD for the rendered-pixel assertions below. Doing this via
    // the real UI proves the live Canvas and preloaded GLBs survive the same
    // view change a drafter uses.
    if (!(await clickView('CAD'))) fail('CAD view-mode button not found on return switch');

    // CadLinework rebuilds the display list and the drei Text labels suspend
    // on the font load. Give SwiftShader generous time to settle + repaint.
    await sleep(12000);

    // Screenshot ONLY the WebGL canvas — the sidebar UI has its own colors.
    const canvas = await page.$('canvas');
    if (!canvas) fail('no <canvas> element found (CAD view did not mount)');
    const sameCanvasAfterPreload = await page.evaluate(
      before => document.querySelector('canvas') === before,
      persistentCanvas,
    );
    if (!sameCanvasAfterPreload) fail('3D→CAD replaced the preloaded realistic Canvas');
    await canvas.screenshot({ path: REALISTIC_SHOT });
    const realisticPng = fs.readFileSync(REALISTIC_SHOT).toString('base64');

    // Turn models off only long enough to capture the plain CAD reference.
    await page.evaluate(() => {
      document.querySelector('[data-testid="realistic-models-toggle"]').click();
    });
    await page.waitForFunction(
      () => document.querySelector('[data-testid="realistic-models-toggle"]')?.getAttribute('aria-pressed') === 'false',
      { timeout: 5000 },
    );
    await sleep(2000);
    await canvas.screenshot({ path: SHOT });
    const png = fs.readFileSync(SHOT).toString('base64');

    const counts = await classifyPixels(page, png);
    console.log('pixel counts:', JSON.stringify(counts));

    // Thresholds sit far below healthy values (calibrated from a known-good
    // render) so AA/layout drift never trips them, but a blank canvas, a
    // stuck Suspense fallback or vanished linework (near-zero pixels)
    // always does.
    const missing = [];
    // Dark drawing background must dominate the frame. A frozen 3D frame
    // (sky #bcd6e8 / ground tan) or a white/blank canvas fails this.
    if (counts.dark < counts.total * 0.5) {
      missing.push(`dark CAD background (dark pixels ${counts.dark} < 50% of ${counts.total})`);
    }
    if (counts.white < 600) missing.push(`white sheet frame / labels (white pixels ${counts.white} < 600)`);
    if (counts.magenta < 200) missing.push(`magenta site boundary (magenta pixels ${counts.magenta} < 200)`);
    if (counts.feeder < 150) missing.push(`feeder-colored linework (feeder pixels ${counts.feeder} < 150)`);
    // Healthy warm ink is the open F1 route/membership chevrons and positive
    // DC conductors. Reintroducing a red fallback perimeter around every PCS,
    // BESS, or unsupported equipment kind pushes this fixed fixture far above
    // the calibrated ceiling (healthy frame: ~2.2k after the UI mask).
    if (counts.feeder > 3200) {
      missing.push(`closed red equipment-box flood (warm pixels ${counts.feeder} > 3200)`);
    }
    if (missing.length) fail(`CAD view is missing: ${missing.join('; ')}`);

    // Realistic CAD regression: CAD's wide camera must not hide models behind
    // the 3D far-LOD gate. The preloaded render must differ visibly from the
    // plain reference.
    const realisticChanged = await changedPixels(page, png, realisticPng);
    console.log(`realistic CAD changed pixels: ${realisticChanged}`);
    if (realisticChanged < 1000) {
      fail(`Realistic CAD models are not visibly rendered (${realisticChanged} changed pixels < 1000)`);
    }

    // Turn models back on and cycle the complete view path. Every switch must
    // retain the same Canvas, and CAD at the end must still show the textured
    // model render rather than dead cache resources or linework-only LOD.
    await page.evaluate(() => {
      document.querySelector('[data-testid="realistic-models-toggle"]').click();
    });
    await page.waitForFunction(
      () => document.querySelector('[data-testid="realistic-models-toggle"]')?.getAttribute('aria-pressed') === 'true',
      { timeout: 5000 },
    );
    for (const [view, settleMs] of [['3D', 4000], ['CAD', 6000], ['2D Plan', 2000], ['3D', 5000], ['CAD', 6000]]) {
      if (!(await clickView(view))) fail(`${view} view-mode button not found during realistic cycle`);
      await sleep(settleMs);
      const sameCanvas = await page.evaluate(
        before => document.querySelector('canvas') === before,
        persistentCanvas,
      );
      if (!sameCanvas) fail(`realistic view cycle replaced the Canvas at ${view}`);
    }
    if (await page.evaluate(() =>
      document.querySelector('[data-testid="realistic-models-toggle"]')?.getAttribute('aria-pressed')) !== 'true') {
      fail('Realistic state did not survive the 3D→CAD→2D→3D→CAD cycle');
    }
    const finalPng = await canvas.screenshot({ encoding: 'base64' });
    const finalChanged = await changedPixels(page, png, finalPng);
    console.log(`realistic CAD changed pixels after full cycle: ${finalChanged}`);
    if (finalChanged < 1000) {
      fail(`Realistic CAD models vanished after view cycling (${finalChanged} changed pixels < 1000)`);
    }
    if (graphicsErrors.length) {
      fail(`Realistic CAD emitted graphics errors: ${graphicsErrors.join(' | ').slice(0, 1000)}`);
    }

    console.log(`PASS: CAD linework and preloaded realistic models survive 3D→CAD→2D→3D→CAD on one WebGL canvas (screenshots: ${SHOT}, ${REALISTIC_SHOT})`);
  } finally {
    await browser.close();
    stopDevServer();
  }
  process.exit(0);
}

main().catch(e => fail(`unexpected error: ${e?.stack || e}`));
