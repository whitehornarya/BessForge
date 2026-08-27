// BESSForge Electron shell.
//
// Wraps the SAME static web build the Tauri app and the Azure zip use
// (dist/static/app, copied into electron/app by copy-app.cjs). No Node
// integration is exposed to the page — the renderer is the plain web app.
//
// Exports (DXF, PDF, CSV, project JSON) go through file-saver's anchor
// download in the web code. Chromium turns those into downloads, and the
// will-download hook below forces a native "Save As" dialog with a sensible
// default filename and file-type filter for every export.
const { app, BrowserWindow, ipcMain, safeStorage, session, shell } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const APP_DIR = path.join(__dirname, 'app');
const LOCAL_API_URL = 'http://127.0.0.1:53117';
const TOKEN_FILE = 'cesium-token.bin';
let apiChild = null;
let tokenWindow = null;

function isAllowedApiUrl(value) {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.pathname !== '' && url.pathname !== '/')
    ) {
      return false;
    }
    if (url.protocol === 'https:') return true;
    return (
      url.protocol === 'http:' &&
      (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]')
    );
  } catch {
    return false;
  }
}

function readApiUrl() {
  const candidates = [
    process.env.ECI_API_BASE_URL,
    path.join(app.getPath('userData'), 'bessforge.config.json'),
    path.join(path.dirname(app.getPath('exe')), 'bessforge.config.json'),
    path.join(APP_DIR, 'bessforge.config.json'),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    let value = candidate;
    if (candidate.endsWith('.json')) {
      try {
        const config = JSON.parse(fs.readFileSync(candidate, 'utf8'));
        value =
          config.apiBase ??
          config.API_BASE_URL ??
          config.apiBaseUrl ??
          config.eciApiBaseUrl ??
          config.ECI_API_BASE_URL;
      } catch (error) {
        if (fs.existsSync(candidate)) console.error(`Ignoring invalid API config ${candidate}:`, error.message);
        continue;
      }
    }
    if (isAllowedApiUrl(value)) return value.replace(/\/+$/, '');
    console.error('Ignoring unsafe API URL. Only HTTPS and loopback HTTP are allowed.');
  }
  return LOCAL_API_URL;
}

function tokenFilePath() {
  return path.join(app.getPath('userData'), TOKEN_FILE);
}

function readCesiumToken() {
  const environmentToken = process.env.CESIUM_ION_TOKEN?.trim();
  if (environmentToken) return environmentToken;
  const file = tokenFilePath();
  if (!fs.existsSync(file) || !safeStorage.isEncryptionAvailable()) return '';
  try {
    return safeStorage.decryptString(fs.readFileSync(file)).trim();
  } catch (error) {
    console.error('Could not decrypt the saved Cesium token:', error.message);
    return '';
  }
}

function saveCesiumToken(value) {
  const token = typeof value === 'string' ? value.trim() : '';
  if (token.length < 16 || token.length > 4096 || /[\r\n\0]/.test(token)) {
    throw new Error('Enter a valid Cesium ion token.');
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Windows secure storage is unavailable for this user.');
  }
  const file = tokenFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, safeStorage.encryptString(token), { mode: 0o600 });
  fs.rmSync(file, { force: true });
  fs.renameSync(temporary, file);
  return token;
}

function desktopApiPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'desktop-api.cjs')
    : path.join(__dirname, '..', 'dist', 'desktop-api.cjs');
}

function stopLocalApi() {
  if (!apiChild) return;
  const child = apiChild;
  apiChild = null;
  if (!child.killed) child.kill();
}

function startLocalApi(token) {
  stopLocalApi();
  const entry = desktopApiPath();
  if (!fs.existsSync(entry)) {
    console.error(`Bundled local API is missing: ${entry}`);
    return false;
  }
  const env = {
    ...process.env,
    BESSFORGE_LOOPBACK_ONLY: '1',
    ELECTRON_RUN_AS_NODE: '1',
    NODE_ENV: 'production',
    PORT: '53117',
  };
  if (token) env.CESIUM_ION_TOKEN = token;
  else delete env.CESIUM_ION_TOKEN;
  const child = spawn(process.execPath, [entry], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  apiChild = child;
  child.stdout.on('data', data => console.log(`[local-api] ${String(data).trim()}`));
  child.stderr.on('data', data => console.error(`[local-api] ${String(data).trim()}`));
  child.once('exit', code => {
    if (apiChild === child) apiChild = null;
    if (code && code !== 0) console.error(`BESSForge local API exited with code ${code}.`);
  });
  return true;
}

function openSafeExternal(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (url.protocol === 'https:') void shell.openExternal(url.href);
  } catch {
    // Invalid and non-HTTPS links remain inside neither the app nor the OS shell.
  }
}

// Dialog filter names per export extension (mirrors client/src/lib/saveFile.ts)
const FILTER_NAMES = {
  dxf: 'DXF drawing',
  pdf: 'PDF document',
  zip: 'ZIP archive',
  csv: 'CSV spreadsheet',
  json: 'Project file',
};

function createWindow(apiBaseUrl) {
  const win = new BrowserWindow({
    width: 1600,
    height: 950,
    minWidth: 1100,
    minHeight: 700,
    title: 'BESSForge — BESS 10% Design Tool',
    icon: path.join(__dirname, 'build', 'icon.ico'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      additionalArguments: [`--bessforge-api-base-url=${encodeURIComponent(apiBaseUrl)}`],
    },
  });

  // Block any top-level navigation away from the bundled app
  win.webContents.on('will-navigate', (event, url) => {
    if (url === win.webContents.getURL()) return;
    event.preventDefault();
    openSafeExternal(url);
  });

  // External links open in the default browser, never in the shell window
  win.webContents.setWindowOpenHandler(({ url }) => {
    openSafeExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('will-attach-webview', event => event.preventDefault());
  win.loadFile(path.join(APP_DIR, 'index.html'));
  return win;
}

function showTokenSetup(parent) {
  if (tokenWindow && !tokenWindow.isDestroyed()) {
    tokenWindow.focus();
    return;
  }
  tokenWindow = new BrowserWindow({
    width: 620,
    height: 510,
    minWidth: 560,
    minHeight: 460,
    parent,
    modal: true,
    title: 'Configure Cesium — BESSForge',
    autoHideMenuBar: true,
    resizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'token-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  tokenWindow.on('closed', () => { tokenWindow = null; });
  tokenWindow.loadFile(path.join(__dirname, 'token-setup.html'));
}

ipcMain.handle('bessforge:save-cesium-token', async (event, value) => {
  try {
    const token = saveCesiumToken(value);
    startLocalApi(token);
    setImmediate(() => BrowserWindow.fromWebContents(event.sender)?.close());
    return { ok: true };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : 'Token could not be saved.' };
  }
});

ipcMain.on('bessforge:skip-cesium-token', event => {
  BrowserWindow.fromWebContents(event.sender)?.close();
});

app.whenReady().then(() => {
  if (!fs.existsSync(path.join(APP_DIR, 'index.html'))) {
    console.error(
      'Static app bundle missing. Run "npm run build:static" in the repo root, then "npm run prepare:app" here.'
    );
    app.quit();
    return;
  }

  const apiBaseUrl = readApiUrl();
  const cesiumToken = readCesiumToken();
  startLocalApi(cesiumToken);
  const userConfig = path.join(app.getPath('userData'), 'bessforge.config.json');
  if (!fs.existsSync(userConfig)) {
    fs.mkdirSync(path.dirname(userConfig), { recursive: true });
    fs.writeFileSync(
      userConfig,
      `${JSON.stringify({ apiBase: apiBaseUrl }, null, 2)}\n`,
      { flag: 'wx' }
    );
  }

  // Deny powerful web permissions. The bundled design tool needs none.
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  session.defaultSession.setDevicePermissionHandler(() => false);
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const responseHeaders = { ...details.responseHeaders };
    responseHeaders['Content-Security-Policy'] = [
      `default-src 'self'; base-uri 'none'; object-src 'none'; frame-src 'none'; form-action 'none'; ` +
        `script-src 'self' blob: 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; ` +
        `img-src 'self' file: data: blob: https:; font-src 'self' file: data:; ` +
        `worker-src 'self' blob:; connect-src 'self' blob: https: http://127.0.0.1:* http://localhost:* http://[::1]:*`,
    ];
    responseHeaders['Permissions-Policy'] = [
      'camera=(), microphone=(), geolocation=(), usb=(), serial=(), bluetooth=()',
    ];
    callback({ responseHeaders });
  });

  // Native save dialog for every download (file-saver anchor downloads).
  // Electron shows a save dialog by default; setSaveDialogOptions adds the
  // suggested filename and a per-extension file-type filter.
  session.defaultSession.on('will-download', (_event, item) => {
    const name = item.getFilename();
    const ext = path.extname(name).slice(1).toLowerCase();
    item.setSaveDialogOptions({
      defaultPath: path.join(app.getPath('downloads'), name),
      filters: ext
        ? [
            { name: FILTER_NAMES[ext] || `${ext.toUpperCase()} file`, extensions: [ext] },
            { name: 'All files', extensions: ['*'] },
          ]
        : undefined,
    });
  });

  const mainWindow = createWindow(apiBaseUrl);
  if (!cesiumToken || process.argv.includes('--configure-cesium-token')) {
    mainWindow.once('ready-to-show', () => showTokenSetup(mainWindow));
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(apiBaseUrl);
  });
});

app.on('before-quit', stopLocalApi);
app.on('window-all-closed', () => app.quit());
