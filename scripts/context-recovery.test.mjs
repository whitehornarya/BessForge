/**
 * Visual regression: silent WebGL context-loss recovery.
 *
 * Two failure paths in DesignScene must recover WITHOUT ever showing the
 * "3D view couldn't start" recovery panel:
 *
 * Phase 1 — lost + restored: the browser drops the context and restores it
 * shortly after (typical tab-sleep hiccup). three.js re-initializes on the
 * same canvas; the app just repaints. Assert: no panel, scene renders real
 * (non-uniform) pixels afterwards.
 *
 * Phase 2 — lost with NO restore (deep sleep / driver reset): the app must
 * rebuild the canvas by itself with backoff, restoring the same camera
 * pose. Assert: no panel at any point, a live canvas exists afterwards,
 * pixels are non-uniform, and the camera pose survived the remount.
 *
 * Run: npm run test:context-recovery (SwiftShader; boots its own dev server
 * on port 5199 if one is not already running). Failure frames are left at
 * /tmp/context-recovery-*.png.
 */
import puppeteer from 'puppeteer';
import fs from 'fs';

import { resolveChromiumPath } from './chromium-path.mjs';
import { TEST_BASE as BASE, ensureDevServer, stopDevServer } from './dev-server.mjs';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const PANEL_TEXT = "3D view couldn't start";

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

// True when the recovery panel is in the DOM.
async function panelVisible(page) {
  return page.evaluate(
    (t) => document.body.innerText.includes(t),
    PANEL_TEXT,
  );
}

// Screenshot the (first) canvas and measure pixel variety: a healthy scene
// render has many distinct colors; a black/frozen/blank canvas is uniform.
async function canvasVariety(page, shotPath) {
  const canvas = await page.$('canvas');
  if (!canvas) return { canvas: false };
  await canvas.screenshot({ path: shotPath });
  const b64 = fs.readFileSync(shotPath).toString('base64');
  return page.evaluate(async (b64) => {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:image/png;base64,' + b64; });
    const cv = document.createElement('canvas');
    cv.width = img.width; cv.height = img.height;
    const ctx = cv.getContext('2d');
    ctx.drawImage(img, 0, 0);
    const { data } = ctx.getImageData(0, 0, cv.width, cv.height);
    const seen = new Map();
    let total = 0;
    for (let i = 0; i < data.length; i += 16) { // sample every 4th pixel
      const key = (data[i] >> 4) + ',' + (data[i + 1] >> 4) + ',' + (data[i + 2] >> 4);
      seen.set(key, (seen.get(key) ?? 0) + 1);
      total++;
    }
    const top = Math.max(...seen.values());
    return { canvas: true, colors: seen.size, dominantFrac: top / total, total };
  }, b64);
}

async function assertHealthy(page, label, shotPath) {
  if (await panelVisible(page)) fail(`${label}: recovery panel is showing — recovery was not silent`);
  const v = await canvasVariety(page, shotPath);
  if (!v.canvas) fail(`${label}: no <canvas> in the DOM after recovery`);
  console.log(`${label}: colors=${v.colors} dominantFrac=${v.dominantFrac.toFixed(3)}`);
  if (v.colors < 12 || v.dominantFrac > 0.98) {
    fail(`${label}: canvas looks blank/frozen (colors=${v.colors}, dominant color ${Math.round(v.dominantFrac * 100)}% — screenshot: ${shotPath})`);
  }
}

// Read the live camera pose via the PoseCamera test hook.
async function cameraPose(page) {
  return page.evaluate(() => {
    const cam = window.__sceneCamera;
    if (!cam) return null;
    return [cam.position.x, cam.position.y, cam.position.z];
  });
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
    await page.evaluateOnNewDocument(() => {
      localStorage.setItem('nextera-show-satellite', 'false');
      localStorage.setItem('nextera-view-mode', '3d');
    });
    page.on('pageerror', e => console.log('[pageerror]', String(e).slice(0, 300)));

    await page.goto(`${BASE}/`, { waitUntil: 'networkidle2', timeout: 90000 });

    const loaded = await page.evaluate(async () => {
      const mod = await import('/src/lib/stores/useDesignStore.ts');
      const store = mod.useDesignStore;
      window.__store = store;
      await store.getState().loadSample('/samples/hondo-100mw.kmz', 'Hondo 100MW');
      const t0 = Date.now();
      while (Date.now() - t0 < 60000) {
        const s = store.getState();
        if (s.boundary && s.design) return { ok: true };
        await new Promise(r => setTimeout(r, 500));
      }
      return { ok: false };
    });
    if (!loaded.ok) fail('sample design did not load');
    await sleep(8000); // SwiftShader: let the initial scene settle + render
    await assertHealthy(page, 'baseline', '/tmp/context-recovery-baseline.png');

    // ------------------------------------------------------------------
    // Phase 0: view-mode cycling. 3D/CAD/2D must reuse the SAME live Canvas:
    // remounting it tears down the WebGL context while cached GLB textures are
    // still loading, which can strand the next view without realistic models.
    // The recovery machinery must also stay completely silent. Runs BEFORE
    // the real-loss phases so those can't mask a false positive here.
    // ------------------------------------------------------------------
    const clickView = async (label) => {
      const ok = await page.evaluate((label) => {
        const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === label);
        if (!btn) return false;
        btn.click();
        return true;
      }, label);
      if (!ok) fail(`phase 0: view button "${label}" not found`);
    };
    await page.evaluate(() => { window.__viewCycleCanvas = document.querySelector('canvas'); });
    const cycle = ['CAD', '3D', '2D Plan', '3D'];
    for (let i = 0; i < cycle.length; i++) {
      await clickView(cycle[i]);
      // The queued lost-timer (if any leaked) would fire ~2.5s after the
      // switch; wait past it plus SwiftShader settle before asserting.
      await sleep(6000);
      if (await panelVisible(page)) fail(`phase 0: recovery panel appeared after switching to ${cycle[i]}`);
      const sameCanvas = await page.evaluate(() =>
        document.querySelector('canvas') === window.__viewCycleCanvas);
      if (!sameCanvas) fail(`phase 0: switching to ${cycle[i]} replaced the live Canvas`);
      const toasted = await page.evaluate(() => document.body.innerText.includes('3D view recovered'));
      if (toasted) fail(`phase 0: "3D view recovered" toast appeared after switching to ${cycle[i]} — view switch was treated as a GPU failure`);
      const v = await canvasVariety(page, `/tmp/context-recovery-phase0-${i}.png`);
      if (!v.canvas) fail(`phase 0: no <canvas> after switching to ${cycle[i]}`);
      if (v.colors < 12 || v.dominantFrac > 0.98) {
        fail(`phase 0: canvas blank/frozen after switching to ${cycle[i]} (colors=${v.colors}, dominant ${Math.round(v.dominantFrac * 100)}%)`);
      }
      console.log(`phase0 ${cycle[i]}: colors=${v.colors} dominantFrac=${v.dominantFrac.toFixed(3)}`);
    }
    console.log('phase0: view cycling 3D→CAD→3D→2D→3D reused one healthy canvas');

    // ------------------------------------------------------------------
    // Phase 1: lose + restore on the same canvas. No remount expected.
    // ------------------------------------------------------------------
    const ph1 = await page.evaluate(() => {
      const c = document.querySelector('canvas');
      const gl = c.getContext('webgl2') || c.getContext('webgl');
      const ext = gl && gl.getExtension('WEBGL_lose_context');
      if (!ext) return { ok: false, why: 'WEBGL_lose_context unavailable' };
      window.__ext1 = ext;
      ext.loseContext();
      return { ok: true };
    });
    if (!ph1.ok) fail(`phase 1 setup: ${ph1.why}`);
    await sleep(600);
    if (await panelVisible(page)) fail('phase 1: panel appeared immediately on context loss');
    await page.evaluate(() => window.__ext1.restoreContext());
    await sleep(8000); // three re-init + SwiftShader repaint
    await assertHealthy(page, 'phase1 lost+restored', '/tmp/context-recovery-phase1.png');

    // ------------------------------------------------------------------
    // Phase 2: lose with NO restore — the app must remount by itself.
    // (lost-event wait 2.5s + first backoff 300ms, then scene rebuild.)
    // ------------------------------------------------------------------
    const poseBefore = await cameraPose(page);
    const ph2 = await page.evaluate(() => {
      const c = document.querySelector('canvas');
      const gl = c.getContext('webgl2') || c.getContext('webgl');
      const ext = gl && gl.getExtension('WEBGL_lose_context');
      if (!ext) return { ok: false, why: 'WEBGL_lose_context unavailable' };
      window.__deadCanvas = c;
      ext.loseContext(); // never restored
      return { ok: true };
    });
    if (!ph2.ok) fail(`phase 2 setup: ${ph2.why}`);

    // While the app waits for a restore that never comes and then rebuilds,
    // the panel must never flash up.
    const t0 = Date.now();
    while (Date.now() - t0 < 6000) {
      if (await panelVisible(page)) fail('phase 2: panel appeared during silent recovery');
      await sleep(500);
    }
    // Wait until a NEW canvas replaces the dead one, then let it render.
    const remounted = await page.evaluate(async () => {
      const t0 = Date.now();
      while (Date.now() - t0 < 20000) {
        const c = document.querySelector('canvas');
        if (c && c !== window.__deadCanvas) return true;
        await new Promise(r => setTimeout(r, 300));
      }
      return false;
    });
    if (!remounted) fail('phase 2: canvas was never remounted after an unrestored context loss');
    console.log('phase2: canvas remounted automatically');
    await sleep(12000); // full scene rebuild under SwiftShader
    await assertHealthy(page, 'phase2 unrestored loss', '/tmp/context-recovery-phase2.png');

    // Camera pose must survive the remount (PosePersistence).
    const poseAfter = await cameraPose(page);
    if (!poseBefore || !poseAfter) fail('phase 2: camera pose hook unavailable');
    const drift = Math.hypot(
      poseAfter[0] - poseBefore[0], poseAfter[1] - poseBefore[1], poseAfter[2] - poseBefore[2]);
    console.log(`phase2: camera drift after remount = ${drift.toFixed(2)} ft`);
    if (drift > 1) fail(`phase 2: camera pose not restored after remount (drift ${drift.toFixed(1)} ft)`);

    console.log('PASS: context loss recovers silently (restored + unrestored paths), pose preserved');
  } finally {
    await browser.close();
    stopDevServer();
  }
  process.exit(0);
}

main().catch(e => fail(`unexpected error: ${e?.stack || e}`));
