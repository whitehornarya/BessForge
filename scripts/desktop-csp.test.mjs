/**
 * Packaged-static desktop CSP smoke.
 *
 * Serves the production bundle with the same script/connect restrictions used
 * by the desktop shells, then exercises Troika text and the real R3F/WebGL
 * scene in SwiftShader Chromium.
 */
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = path.join(ROOT, 'dist', 'static', 'app');
const APP_MOUNT = '/desktop/';
const CSP = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "form-action 'none'",
  "script-src 'self' blob: 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "worker-src 'self' blob:",
  "connect-src 'self' blob: https://cdn.jsdelivr.net",
].join('; ');

function fail(message) {
  throw new Error(`desktop CSP smoke failed: ${message}`);
}

function directive(csp, name) {
  const match = csp.split(';').map(value => value.trim())
    .find(value => value === name || value.startsWith(`${name} `));
  return match ? match.split(/\s+/).slice(1) : [];
}

function assertCspSources(label, csp, name, expected) {
  const actual = directive(csp, name);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${label} ${name} must be ${expected.join(' ')}, received ${actual.join(' ')}`);
  }
}

function assertShippedCspContracts() {
  const electron = readFileSync(path.join(ROOT, 'electron', 'main.cjs'), 'utf8');
  if (!electron.includes("script-src 'self' blob: 'wasm-unsafe-eval';") ||
      !electron.includes("connect-src 'self' blob: https: http://127.0.0.1:* http://localhost:* http://[::1]:*")) {
    fail('Electron CSP must allow blob scripts and only validated API schemes/loopback hosts');
  }
  const electronScript = electron.match(/`script-src ([^;]+); style-src/)?.[1] ?? '';
  if (electronScript !== "'self' blob: 'wasm-unsafe-eval'" ||
      /(?:^|\s)'unsafe-(?:eval|inline)'(?:\s|$)/.test(electronScript)) {
    fail(`Electron script-src contract is unsafe or incomplete: ${electronScript}`);
  }
  const electronConnect = electron.match(/connect-src ([^`]+)`/)?.[1] ?? '';
  if (electronConnect !== "'self' blob: https: http://127.0.0.1:* http://localhost:* http://[::1]:*") {
    fail(`Electron connect-src contract is too broad: ${electronConnect}`);
  }

  const tauri = JSON.parse(readFileSync(path.join(ROOT, 'src-tauri', 'tauri.conf.json'), 'utf8'));
  assertCspSources('Tauri', tauri.app.security.csp, 'script-src', ["'self'", 'blob:', "'wasm-unsafe-eval'"]);
  if (!directive(tauri.app.security.csp, 'connect-src').includes('https:') ||
      !directive(tauri.app.security.csp, 'connect-src').includes('blob:')) {
    fail('Tauri connect-src must retain HTTPS and embedded GLB texture blob access');
  }

  const packager = readFileSync(path.join(ROOT, 'scripts', 'package-static.ts'), 'utf8');
  const caddy = packager.match(/Content-Security-Policy "([^"]+)"/)?.[1];
  if (!caddy) fail('could not find generated Caddy CSP');
  assertCspSources('Caddy', caddy, 'script-src', ["'self'", 'blob:', "'wasm-unsafe-eval'"]);
  if (!directive(caddy, 'connect-src').includes('https:') ||
      !directive(caddy, 'connect-src').includes('blob:')) {
    fail('Caddy connect-src must retain HTTPS and embedded GLB texture blob access');
  }

  const sourceIndex = readFileSync(path.join(ROOT, 'client', 'index.html'), 'utf8');
  const configTag = '<script src="./config.js"></script>';
  const moduleTag = '<script type="module"';
  if (sourceIndex.indexOf(configTag) < 0 ||
      sourceIndex.indexOf(configTag) > sourceIndex.indexOf(moduleTag)) {
    fail('the HTML shell must load editable config.js before the application module');
  }
}

function chromiumPath() {
  for (const candidate of [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    process.env.CHROME_PATH,
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ].filter(Boolean)) {
    if (existsSync(candidate)) return candidate;
  }
  const command = process.platform === 'win32' ? 'where.exe' : 'which';
  for (const name of process.platform === 'win32'
    ? ['chromium.exe', 'chrome.exe']
    : ['chromium', 'chromium-browser', 'google-chrome']) {
    try {
      const candidate = execFileSync(command, [name], { encoding: 'utf8' })
        .split(/\r?\n/).map(value => value.trim()).find(Boolean);
      if (candidate && existsSync(candidate)) return candidate;
    } catch {}
  }
  fail('Chromium executable not found');
}

const MIME = {
  '.css': 'text/css; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.json': 'application/json; charset=utf-8',
  '.kmz': 'application/vnd.google-earth.kmz',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

async function main() {
  assertShippedCspContracts();
  if (!existsSync(path.join(APP, 'index.html'))) {
    fail('dist/static/app is missing; run npm run build:static first');
  }

  const server = createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
    if (!pathname.startsWith(APP_MOUNT)) {
      res.writeHead(404).end();
      return;
    }
    const relative = pathname === APP_MOUNT ? 'index.html' : pathname.slice(APP_MOUNT.length);
    const file = path.resolve(APP, relative);
    if (file !== APP && !file.startsWith(`${APP}${path.sep}`)) {
      res.writeHead(403).end();
      return;
    }
    const resolved = existsSync(file) && statSync(file).isFile()
      ? file
      : path.extname(relative)
        ? null
        : path.join(APP, 'index.html');
    if (!resolved) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(resolved).toLowerCase()] ?? 'application/octet-stream',
      'Content-Security-Policy': CSP,
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(readFileSync(resolved));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  let browser;
  try {
    const address = server.address();
    if (!address || typeof address === 'string') fail('test server did not bind a TCP port');
    browser = await puppeteer.launch({
      headless: true,
      executablePath: chromiumPath(),
      args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
      defaultViewport: { width: 1280, height: 800 },
    });
    const page = await browser.newPage();
    const runtimeErrors = [];
    const assetErrors = [];
    const relevant = /troika|importScripts|content security policy|violates.*csp|refused to (?:load|connect|execute)|could not load|\/(?:textures|models)\//i;
    page.on('console', message => {
      const text = message.text();
      if (message.type() === 'error' && relevant.test(text)) runtimeErrors.push(text);
    });
    page.on('pageerror', error => {
      const text = error.stack || String(error);
      if (relevant.test(text)) runtimeErrors.push(text);
    });
    page.on('requestfailed', request => {
      if (/\/(?:textures|models)\//i.test(request.url())) {
        assetErrors.push(`${request.url()}: ${request.failure()?.errorText ?? 'request failed'}`);
      }
    });
    page.on('response', response => {
      if (response.status() >= 400 && /\/(?:textures|models)\//i.test(response.url())) {
        assetErrors.push(`${response.url()}: HTTP ${response.status()}`);
      }
    });
    await page.evaluateOnNewDocument(() => {
      localStorage.setItem('nextera-show-satellite', 'false');
    });
    await page.goto(`http://127.0.0.1:${address.port}${APP_MOUNT}`, {
      waitUntil: 'networkidle2',
      timeout: 90000,
    });
    const loadedConfig = await page.evaluate(() => window.__BESSFORGE_CONFIG__?.apiBase);
    if (loadedConfig !== '') fail('packaged config.js did not load before the application');

    const clicked = await page.evaluate(() => {
      const elements = [...document.querySelectorAll('button, a, [role="button"]')];
      const sample = elements.find(element => element.textContent?.trim() === 'Hondo 100MW');
      if (!(sample instanceof HTMLElement)) return false;
      sample.click();
      return true;
    });
    if (!clicked) fail('default Hondo 100MW sample control was not found');

    await page.waitForFunction(() => {
      const canvas = document.querySelector('canvas');
      if (!(canvas instanceof HTMLCanvasElement)) return false;
      const rect = canvas.getBoundingClientRect();
      return rect.width > 100 && rect.height > 100 && getComputedStyle(canvas).visibility !== 'hidden';
    }, { timeout: 90000 });
    await page.waitForFunction(() => {
      const control = document.querySelector('[data-testid="realistic-models-toggle"]');
      return control instanceof HTMLButtonElement && !control.disabled;
    }, { timeout: 90000 });
    const realisticClicked = await page.evaluate(() => {
      const control = document.querySelector('[data-testid="realistic-models-toggle"]');
      if (!(control instanceof HTMLButtonElement)) return false;
      if (control.getAttribute('aria-pressed') !== 'true') control.click();
      return true;
    });
    if (!realisticClicked) fail('packaged Realistic control was not found');
    await page.waitForFunction(
      () => document.querySelector('[data-testid="realistic-models-toggle"]')?.getAttribute('aria-pressed') === 'true',
      { timeout: 5000 },
    );
    // Embedded GLB textures are WebP buffer views. GLTFLoader exposes them as
    // blob URLs and ImageBitmapLoader fetches those URLs, so this is the
    // packaged regression for both asset paths and connect-src blob access.
    await new Promise(resolve => setTimeout(resolve, 25000));
    if (assetErrors.length) fail(`packaged asset path escaped the desktop app root: ${assetErrors[0]}`);
    if (runtimeErrors.length) fail(`browser reported ${runtimeErrors[0]}`);

    const canvas = await page.$('canvas');
    if (!canvas) fail('3D canvas is missing');
    const box = await canvas.boundingBox();
    if (!box || box.width < 100 || box.height < 100) fail('3D canvas is not visible');
    const png = await canvas.screenshot({ encoding: 'base64' });
    const pixels = await page.evaluate(async encoded => {
      const image = new Image();
      image.src = `data:image/png;base64,${encoded}`;
      await image.decode();
      const output = document.createElement('canvas');
      output.width = image.width;
      output.height = image.height;
      const context = output.getContext('2d');
      context.drawImage(image, 0, 0);
      const data = context.getImageData(0, 0, output.width, output.height).data;
      const bins = new Set();
      let opaque = 0;
      for (let index = 0; index < data.length; index += 16) {
        if (data[index + 3] > 0) opaque++;
        bins.add(`${data[index] >> 4},${data[index + 1] >> 4},${data[index + 2] >> 4}`);
      }
      return { width: output.width, height: output.height, opaque, bins: bins.size };
    }, png);
    if (pixels.opaque < 1000 || pixels.bins < 12) {
      fail(`3D render is empty or uniform (${JSON.stringify(pixels)})`);
    }
    console.log(`PASS: packaged desktop CSP rendered realistic Hondo in SwiftShader (${pixels.width}x${pixels.height}, ${pixels.bins} color bins)`);
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(1);
});