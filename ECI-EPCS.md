# BESSForge — ECI-EPCS Engineering Notes

**Release:** 1.0.1  
**Owner:** ECI Electrical Consultants, Inc.  
**License:** Proprietary and confidential; UNLICENSED.

## Purpose

BESSForge supports preliminary battery-energy-storage site design: KMZ/KML
boundary import, equipment sizing and layout, engineering checks, 2D/3D review,
and DXF/PDF/CSV/project export. Layout coordinates and CAD output use feet.

## Architecture

- React, Vite, TypeScript, Three.js, Zustand, and Tailwind provide the client.
- Express provides development hosting and optional network-backed API routes.
- Electron and Tauri provide Windows desktop shells over the same static client.
- Core layout, clearance, road, cable, drainage, grading, study, and export logic
  is under `client/src/lib/nextera/`.
- Shared contracts are under `shared/`; API implementation is under `server/`.

## Engineering invariants

- DXF output is generated from plan-layout data, never extracted from 3D meshes.
- Project capacity surfaces use the configuration's credited block output;
  equipment capability is presented separately.
- Local-only rendering/export preferences are not written to shared project
  files unless a field is explicitly part of the project schema.
- Changes to persisted traced-road healing rules require the corresponding
  rules-version bump and stale-state regression coverage.
- Customer releases exclude reference uploads, workspace metadata, caches,
  secrets, dependencies, build outputs, and helper tools tied to internal
  source material.

## API routing and Windows loopback

When the page and API share an origin, no override is needed. Desktop/file
launches default API requests to `http://127.0.0.1:5000`. The server can be
restricted to loopback by setting `BESSFORGE_LOOPBACK_ONLY=1`; otherwise it
listens on all interfaces and must be protected by normal network controls.

For an ECI-managed frontend hosted in Azure with an API at a different origin,
set `window.__BESSFORGE_CONFIG__.apiBase` (or `API_BASE_URL`) to the approved
absolute API origin before the application loads. The override requires HTTPS,
except for localhost, `127.0.0.1`, or `::1`, and it rejects credentials, paths,
queries, and fragments. ECI must supply the deployed endpoint and configure the
server CORS allowlist. This repository does not define or claim a hosted URL.

## Release controls

`scripts/audit-release.mjs` recursively checks filenames and file content,
including case-insensitive ASCII, UTF-16, binary strings, and nested ZIP
content. `scripts/build-complete-release.mjs` invokes that audit fail-closed
before declaring a complete package ready.