// Copies the static web build (dist/static/app, produced by
// "npm run build:static" in the repo root) into electron/app so
// electron-builder can package it. Fails loudly if the build is missing.
const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', 'dist', 'static', 'app');
const dest = path.join(__dirname, 'app');

if (!fs.existsSync(path.join(src, 'index.html'))) {
  console.error(
    `Static build not found at ${src}\n` +
      'Run "npm run build:static" in the repo root first.'
  );
  process.exit(1);
}

fs.rmSync(dest, { recursive: true, force: true });
fs.cpSync(src, dest, { recursive: true });
const configScript = path.join(dest, 'config.js');
if (!fs.existsSync(configScript)) {
  fs.writeFileSync(
    configScript,
    `// Runtime API endpoint. Electron overrides this from bessforge.config.json.\n` +
      `window.__BESSFORGE_CONFIG__ ||= Object.freeze({ apiBase: "http://127.0.0.1:53117" });\n`
  );
}
const configJson = path.join(dest, 'bessforge.config.json');
if (!fs.existsSync(configJson)) {
  fs.writeFileSync(configJson, '{\n  "apiBase": "http://127.0.0.1:53117"\n}\n');
}
console.log(`Copied static app bundle -> ${dest}`);
