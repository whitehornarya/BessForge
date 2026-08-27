// Assemble the fully static distribution zip for BESSForge.
//
// Layout of the produced zip (dist/BESSForge_Static_<date>.zip):
//   BESSForge_Static/
//     app/        — the static site (output of `npm run build:static`)
//     server/     — optional self-hosted server: caddy.exe + Caddyfile + launchers
//     README.md   — deployment instructions (Azure / IIS / run-your-own-server)
//
// The server binary is Caddy (single-file, zero-dependency, Windows x64),
// downloaded once from the pinned official GitHub release and cached under
// .cache/. Run with: npm run package:static

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'fs';
import { createHash } from 'crypto';
import { runInNewContext } from 'vm';
import { fileURLToPath } from 'url';
import path from 'path';
import JSZip from 'jszip';
import { resolveApiBase } from '../client/src/lib/api/base';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP_DIR = path.join(ROOT, 'dist', 'static', 'app');
const PUBLIC_DIR = path.join(ROOT, 'client', 'public');
const CACHE_DIR = path.join(ROOT, '.cache');
const VERSION = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version as string;
const CADDY_VERSION = '2.8.4';
const CADDY_URL = `https://github.com/caddyserver/caddy/releases/download/v${CADDY_VERSION}/caddy_${CADDY_VERSION}_windows_amd64.zip`;
const CADDY_CACHE = path.join(CACHE_DIR, `caddy_${CADDY_VERSION}_windows_amd64.exe`);
// From the official release's caddy_2.8.4_checksums.txt (SHA-512 of the zip)
// plus the SHA-256 of the extracted caddy.exe, verified at pin time.
const CADDY_ZIP_SHA512 =
  '89f8fc9ece9941a15a0981b3c69543d3b9b5fe095e747875a05fc1775d4d78d4505a7fe54a58d496dade601e85f6053a00a1b0382a781d3e8b6eec044384f6e6';
const CADDY_EXE_SHA256 =
  '1b0ad44998d673252bae082e3010ae455a511c528e61c90cd8cd778236c20c17';
const CONFIG_JS = `// BESSForge runtime configuration (safe to edit after deployment).
// Leave apiBase empty for same-origin API requests on a hosted deployment.
// Otherwise use an HTTPS URL, or loopback HTTP such as http://127.0.0.1:53117.
// This file is public browser configuration: never put credentials or tokens here.
window.__BESSFORGE_CONFIG__ = Object.freeze({
  apiBase: ""
});
window.__ECI_CONFIG__ = window.__BESSFORGE_CONFIG__;
`;
const CONFIG_JSON = `{
  "apiBase": ""
}
`;

const sha512 = (b: Buffer) => createHash('sha512').update(b).digest('hex');
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

async function assertPackagedRuntimeConfig(buffer: Buffer): Promise<void> {
  const archive = await JSZip.loadAsync(buffer);
  const indexEntry = archive.file('BESSForge_Static/app/index.html');
  const configEntry = archive.file('BESSForge_Static/app/config.js');
  if (!indexEntry || !configEntry) {
    throw new Error('Static archive is missing index.html or config.js');
  }
  const index = await indexEntry.async('string');
  const config = await configEntry.async('string');
  const configTag = '<script src="./config.js"></script>';
  const moduleTag = '<script type="module"';
  if (index.indexOf(configTag) < 0 || index.indexOf(configTag) > index.indexOf(moduleTag)) {
    throw new Error('Static archive must load config.js synchronously before the application module');
  }

  const testOrigin = 'https://api.static-config.invalid';
  const modified = config.replace('apiBase: ""', `apiBase: "${testOrigin}"`);
  if (modified === config) {
    throw new Error('Static archive config.js does not contain an editable apiBase value');
  }
  const sandbox: { window: Record<string, unknown> } = { window: {} };
  runInNewContext(modified, sandbox, { filename: 'BESSForge_Static/app/config.js' });
  const runtime = sandbox.window.__BESSFORGE_CONFIG__ as { apiBase?: unknown } | undefined;
  const resolved = resolveApiBase({
    runtimeValue: runtime?.apiBase,
    location: { protocol: 'https:', origin: 'https://hosted.invalid' } as Location,
  });
  if (resolved !== testOrigin) {
    throw new Error(`Static archive API configuration was ignored (resolved ${resolved})`);
  }
}

const CADDYFILE = `# BESSForge local server — production-grade static file serving.
# Default: private to this PC at http://localhost:8080
# LAN mode: the LAN launcher sets BESS_ADDRESS=0.0.0.0:8080
{
        admin off
        auto_https off
}

http://{$BESS_ADDRESS:localhost:8080} {
        root * ../app
        encode zstd gzip

        # Hashed build assets never change — cache forever.
        @hashed path /assets/*
        header @hashed Cache-Control "public, max-age=31536000, immutable"

        # The HTML shell and editable endpoint config must always revalidate.
        @shell path / /index.html /config.js /bessforge.config.json
        header @shell Cache-Control "no-cache"

        # Security headers.
        header {
                X-Content-Type-Options nosniff
                X-Frame-Options SAMEORIGIN
                Referrer-Policy strict-origin-when-cross-origin
                Permissions-Policy "camera=(), microphone=(), geolocation=(), usb=()"
                Content-Security-Policy "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'self'; script-src 'self' blob: 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; worker-src 'self' blob:; connect-src 'self' blob: https: http://127.0.0.1:* http://localhost:* http://[::1]:*"
        }

        # MIME types Caddy does not know out of the box.
        @kmz path *.kmz
        header @kmz Content-Type application/vnd.google-earth.kmz
        @glb path *.glb
        header @glb Content-Type model/gltf-binary

        # Same-origin browser API calls go to the loopback ECI service. This
        # keeps local mode private and avoids putting credentials in config.js.
        reverse_proxy /api/* http://127.0.0.1:53117

        file_server
}
`;

const BAT_LOCAL = `@echo off\r
setlocal\r
cd /d "%~dp0"\r
echo ============================================\r
echo  BESSForge local server\r
echo  Opening http://localhost:8080 ...\r
echo  Keep this window open while using the app.\r
echo  Press Ctrl+C to stop the server.\r
echo ============================================\r
start "" "http://localhost:8080"\r
caddy.exe run --config Caddyfile\r
if errorlevel 1 (\r
  echo.\r
  echo The server could not start. Most common cause: port 8080 is already\r
  echo in use by another program. Close it, or edit Caddyfile and change\r
  echo 8080 to another port, then run this launcher again.\r
  pause\r
)\r
`;

const BAT_LAN = `@echo off\r
setlocal\r
cd /d "%~dp0"\r
set BESS_ADDRESS=0.0.0.0:8080\r
echo ============================================\r
echo  BESSForge server - LAN mode\r
echo  Other PCs on your network can connect via\r
echo  http://THIS-PC-NAME:8080 or this PC's IP.\r
echo  Keep this window open while serving.\r
echo  Press Ctrl+C to stop the server.\r
echo ============================================\r
start "" "http://localhost:8080"\r
caddy.exe run --config Caddyfile\r
if errorlevel 1 (\r
  echo.\r
  echo The server could not start. Most common cause: port 8080 is already\r
  echo in use, or Windows Firewall blocked the LAN listener. Allow access\r
  echo when prompted, or edit Caddyfile to use a different port.\r
  pause\r
)\r
`;

const README = `# BESSForge — Static Distribution

BESSForge runs entirely in the web browser. This package contains plain
static files: there is no backend, no database, and no Node.js/Python
runtime requirement. Host the \`app/\` folder on any web server, or use the
bundled zero-install server in \`server/\`.

## Contents

- \`app/\` — the complete application (HTML/JS/CSS/textures/sample sites)
- \`app/config.js\` — editable public API endpoint configuration
- \`server/\` — optional self-contained local server (Windows x64, no installs)
- \`README.md\` — this file

## Option A — Azure Static Web Apps

1. In the Azure Portal, create a **Static Web App** (Free plan is fine).
2. Choose "Other" as the deployment source, then upload with the SWA CLI:
   \`swa deploy ./app --env production\` (or point your CI at the \`app/\` folder).
3. Done — Azure serves the site over HTTPS with global caching.

## Option B — Azure Blob Storage static website

1. Create a Storage Account → enable **Static website** (Data management).
2. Upload the *contents* of \`app/\` into the \`$web\` container
   (Portal upload, Azure Storage Explorer, or \`az storage blob upload-batch\`).
3. Set the index document name to \`index.html\`.
4. Browse to the "Primary endpoint" URL shown in the portal.

## Option C — IIS (internal Windows server)

1. Copy the \`app/\` folder to the server, e.g. \`C:\\inetpub\\bessforge\`.
2. In IIS Manager, add a Website (or a Virtual Directory / sub-application
   under an existing site — the app uses relative paths, so sub-paths work).
3. Point it at the copied folder. No handler mappings or app pools with
   managed code are needed — it is pure static content.
4. Recommended: add MIME types \`.kmz → application/vnd.google-earth.kmz\`
   and \`.glb → model/gltf-binary\` if not already present.

## Option D — Run your own server (no installation)

For a single engineer's PC or a quick shared server:

1. Open the \`server\` folder.
2. Double-click **Start BESSForge Server.bat** — the app opens at
   http://localhost:8080. Private to that PC.
3. To share on your office network instead, use
   **Start BESSForge Server (LAN).bat** and give colleagues the PC's
   address, e.g. \`http://THIS-PC:8080\`. Allow the Windows Firewall prompt.

The server is Caddy (caddyserver.com), a single self-contained executable —
nothing is installed, no admin rights are required, and stopping the window
(Ctrl+C or closing it) fully stops the server. The provided \`Caddyfile\`
config enables compression, long-lived caching for fingerprinted assets,
instant updates for the HTML shell, and standard security headers.
Its same-origin \`/api/*\` route proxies to the ECI API on
\`http://127.0.0.1:53117\`.

## API endpoint configuration

Edit \`app/config.js\` after extracting/deploying; no rebuild is needed.
Leave \`apiBase\` as an empty string when the API is routed at the same
HTTPS origin as the website. For a local API, set it to
\`http://127.0.0.1:53117\`. A remote API must use HTTPS. The browser will send
requests directly to that origin, so it must permit the website origin with
CORS. Do not place credentials, API keys, or tokens in either config file.
\`bessforge.config.json\` carries the equivalent machine-readable template for
desktop packaging; the browser configuration is \`config.js\`.

## Notes

- All engineering computation (KMZ parsing, layout generation, DXF/PDF
  export) happens inside the user's browser. No site data ever leaves
  their machine.
- To update a deployment, replace the \`app/\` folder contents with a newer
  build. Browsers pick up the new version on the next page load.
`;

async function download(url: string): Promise<Buffer> {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`Download failed ${res.status}: ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

async function getCaddyExe(): Promise<Buffer> {
  if (existsSync(CADDY_CACHE)) {
    const cached = readFileSync(CADDY_CACHE);
    if (sha256(cached) === CADDY_EXE_SHA256) return cached;
    console.warn('Cached caddy.exe failed checksum — re-downloading.');
  }
  console.log(`Downloading Caddy v${CADDY_VERSION} (Windows x64)...`);
  const zipBuf = await download(CADDY_URL);
  if (sha512(zipBuf) !== CADDY_ZIP_SHA512) {
    throw new Error('Caddy download failed SHA-512 verification — aborting.');
  }
  const zip = await JSZip.loadAsync(zipBuf);
  const entry = zip.file('caddy.exe');
  if (!entry) throw new Error('caddy.exe not found in the release archive');
  const exe = Buffer.from(await entry.async('uint8array'));
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(CADDY_CACHE, exe);
  return exe;
}

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else yield full;
  }
}

async function main() {
  if (!existsSync(path.join(APP_DIR, 'index.html'))) {
    throw new Error(`Static build not found at ${APP_DIR}. Run: npm run build:static`);
  }
  // The preview-only direct-download links in client/public/downloads point
  // back into dist/. Vite follows them while copying public assets, which
  // would recursively nest old release binaries in this static release.
  rmSync(path.join(APP_DIR, 'downloads'), { recursive: true, force: true });
  const appFilesOnDisk = [...walk(APP_DIR)];
  const appBytes = appFilesOnDisk.reduce((sum, file) => sum + statSync(file).size, 0);
  if (appFilesOnDisk.length < 60 || appBytes < 40 * 1024 * 1024) {
    throw new Error(
      `Static build is unexpectedly small (${appFilesOnDisk.length} files, ${(appBytes / 1024 / 1024).toFixed(1)} MB)`
    );
  }
  for (const directory of ['fonts', 'geometries', 'models', 'samples', 'sounds', 'textures']) {
    if (!existsSync(path.join(APP_DIR, directory))) {
      throw new Error(`Static build is missing required asset directory: ${directory}`);
    }
  }
  for (const source of walk(PUBLIC_DIR)) {
    const relative = path.relative(PUBLIC_DIR, source);
    const built = path.join(APP_DIR, relative);
    if (!existsSync(built)) throw new Error(`Static build omitted public asset: ${relative}`);
    if (sha256(readFileSync(source)) !== sha256(readFileSync(built))) {
      throw new Error(`Static build changed public asset bytes: ${relative}`);
    }
  }

  const caddyExe = await getCaddyExe();
  const zip = new JSZip();
  const rootName = 'BESSForge_Static';

  let appFiles = 0;
  for (const file of walk(APP_DIR)) {
    const rel = path.relative(APP_DIR, file).split(path.sep).join('/');
    zip.file(`${rootName}/app/${rel}`, rel === 'config.js' ? CONFIG_JS : readFileSync(file));
    appFiles++;
  }
  if (!appFilesOnDisk.some(file => path.relative(APP_DIR, file) === 'config.js')) {
    zip.file(`${rootName}/app/config.js`, CONFIG_JS);
    appFiles++;
  }
  zip.file(`${rootName}/app/bessforge.config.json`, CONFIG_JSON);

  zip.file(`${rootName}/server/caddy.exe`, caddyExe);
  zip.file(`${rootName}/server/Caddyfile`, CADDYFILE);
  zip.file(`${rootName}/server/Start BESSForge Server.bat`, BAT_LOCAL);
  zip.file(`${rootName}/server/Start BESSForge Server (LAN).bat`, BAT_LAN);
  zip.file(`${rootName}/README.md`, README);
  const provenancePath = path.join(ROOT, 'BUILD-PROVENANCE.json');
  if (!existsSync(provenancePath)) {
    throw new Error('BUILD-PROVENANCE.json is required; use npm run package:complete');
  }
  zip.file(`${rootName}/BUILD-PROVENANCE.json`, readFileSync(provenancePath));

  const outPath = path.join(ROOT, 'dist', 'static', `BESSForge_Static_${VERSION}_Windows_x64.zip`);
  const buf = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
  await assertPackagedRuntimeConfig(buf);
  writeFileSync(outPath, buf);
  console.log(`Packaged ${appFiles} app files + server (${(caddyExe.length / 1e6).toFixed(1)} MB caddy.exe)`);
  console.log(`Wrote ${outPath} (${(buf.length / 1e6).toFixed(1)} MB)`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
