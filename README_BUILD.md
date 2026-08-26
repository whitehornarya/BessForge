# BESSForge Rebuild Source 1.0.1

This sanitized source package contains the complete application, public runtime
assets, Electron shell, Tauri shell, static packager, installer definitions, and
release verification tools. It intentionally excludes dependencies, caches,
workspace metadata, uploaded reference material, build outputs, and secrets.

Copyright (c) 2026 ECI Electrical Consultants, Inc. All rights reserved.
This source is proprietary and confidential and is UNLICENSED. Possession of
the package does not grant permission to copy, modify, or redistribute it.

## Windows: build every delivery format

1. Run `scripts\build-installer.bat` for guided prerequisite setup and build.
2. Or install Node.js LTS, Rust (MSVC), Visual Studio C++ Build Tools, WebView2,
   and NSIS manually; then run `npm ci` and `npm run package:complete`.

The complete release is written under `dist/release/`.
`npm run package:complete` is intentionally Windows-only because MSI, NSIS,
PE metadata, and Windows Installer metadata are mandatory release gates.
Customer source rebuilds run the documented synthetic `test:release` subset
because uploaded/customer KMZ fixtures are intentionally not distributed.
The distributed native artifacts are produced only after the authoritative
workspace gate passes the full test suite, dev-server tests, Big Iron and KMZ
visual verification, and every serial trench/gates/ghost/CAD/context/10% visual
gate, plus root and Electron dependency audits.

## Individual builds

- Static site: `npm run package:static`
- Self-contained Electron installer + portable app: `npm run build:installer`
- Tauri MSI + NSIS: `scripts\build-installer.bat`
- Type check: `npm run check`
- Lint/type safety gate: `npm run lint`
- Clean synthetic/core tests: `npm test`
- Local verification subset: lockfile-only root and Electron installs,
  TypeScript, ESLint, API-base/offline-sitepack/proxy-hardening/elevation/
  enlarged-print tests, and a production static build. It does not build or
  inspect native installers.
- Recursive source audit: `npm run audit:release`

`SOURCE-VERIFICATION.json` is generated only after this staged source tree
passes lockfile installs, typecheck, lint, sanitized-core service tests, and a
production static build. Generated dependencies and build output are removed
before the source archive is created.
