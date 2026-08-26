# BESSForge 1.0.1

ECI-EPCS battery energy storage system preliminary design software.

Copyright © 2026 ECI Electrical Consultants, Inc. All rights reserved.
BESSForge is proprietary and confidential software and is **UNLICENSED**. No
permission is granted to copy, modify, publish, sublicense, sell, or distribute
the software except under a separate written agreement with ECI.

## Run and verify

```text
npm ci
npm run check
npm test
npm run dev
```

The development server uses port 5000 by default. A production web build uses
`npm run build`; the static package uses `npm run package:static`.

## Windows delivery formats

- **Electron:** self-contained installer and portable package with bundled
  Chromium.
- **Tauri:** smaller MSI/NSIS installer using Microsoft WebView2.
- **Static:** browser files plus an optional local Windows web server.

On Windows, `npm run package:complete` builds every delivery format, creates a
sanitized allowlisted rebuild-source archive, recursively audits the staged and
final packages, and writes the complete release under `dist/release/`.
The Windows build requires Node.js, Rust with the MSVC target, Visual Studio C++
Build Tools, WebView2, and NSIS. Installers are unsigned unless ECI signs them;
verify the supplied SHA-256 checksums before use.

## Windows loopback and API proxy

Browser deployments normally call `/api` on their own origin. Desktop/file
launches use `http://127.0.0.1:5000` by default. Set
`BESSFORGE_LOOPBACK_ONLY=1` on the Express process to bind only to loopback.
Without that setting the server listens on all interfaces, so firewall and
access controls are the operator's responsibility.

For an ECI-managed static frontend in Azure whose API is hosted separately,
define `window.__BESSFORGE_CONFIG__.apiBase` (or `API_BASE_URL`) before the app
loads. The value must be an absolute HTTPS origin with no credentials, path,
query, or fragment; plain HTTP is accepted only for localhost, `127.0.0.1`, or
`::1`. The API must separately allow the frontend origin through CORS. ECI must
provide the approved endpoint—this repository contains no public hosted URL.

## Release audit

Before native Windows artifacts exist, verify and package the sanitized rebuild
source independently:

```text
npm run verify:sanitized-source
```

This writes the verified source ZIP, checksum, and recursive audit report under
`dist/source-verification/` and does not build or inspect native installers.

Run a standalone source audit with:

```text
node scripts/audit-release.mjs dist/release/BESSForge_Complete_Release_1.0.1.zip --report dist/release-audit-report.json
```

Internal workspace metadata, agent data, caches, dependencies, build output,
and customer-supplied source material are excluded from repository-root audits
and are never included in the sanitized source package. Release-target audits
do not apply those exclusions and recursively inspect every shipped file,
nested ZIP, executable byte stream, ASCII string, and UTF-16 string.

Third-party components retain their own license notices. Those notices do not
license BESSForge itself.