// LandXML 1.2 surface export — hands the proposed FG surface to Civil 3D
// (or any LandXML consumer) as a TIN built from a deterministic grid
// triangulation of the continuous FG surface over the disturbed area.
//
// Deterministic bytes: fixed lattice, row-major vertex order, pinned
// date/time metadata, fixed decimal formatting — no Date, no randomness.
// STANDALONE opt-in export: never imported by dxfExport / dxfSheets, so the
// default drawing package stays byte-identical.

import { ElevationGrid, LocalRect } from './terrain';
import { FgSurface, fgElevationAt } from './gradingSurface';

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Grid-triangulated TIN of the FG surface. Vertices are lattice nodes over
// the daylight bbox (+margin) in row-major order (row 0 = north), ids 1-based.
// Coordinates are local site feet: P = "northing easting elevation" per the
// LandXML convention (y x z).
export function buildLandXmlString(
  fg: FgSurface,
  grid: ElevationGrid,
  rect: LocalRect,
  projectName: string,
  size = 48
): string {
  const region = fg.daylightPolygon.length >= 3 ? fg.daylightPolygon : fg.fence;
  const xs = region.map(p => p.x), ys = region.map(p => p.y);
  const margin = 25;
  const minX = Math.min(...xs) - margin, maxX = Math.max(...xs) + margin;
  const minY = Math.min(...ys) - margin, maxY = Math.max(...ys) + margin;
  const n = Math.max(2, Math.floor(size));
  const dx = (maxX - minX) / (n - 1);
  const dy = (maxY - minY) / (n - 1);

  const pnts: string[] = [];
  for (let r = 0; r < n; r++) {
    const y = maxY - r * dy; // row 0 = north
    for (let c = 0; c < n; c++) {
      const x = minX + c * dx;
      const z = fgElevationAt(fg, grid, rect, x, y);
      if (!Number.isFinite(z)) {
        // Never write a fake elevation: a silent 0.000 would put an
        // engineering-misleading pit in the TIN. Fail loud instead.
        throw new Error(`LandXML export: non-finite FG elevation at (${x.toFixed(1)}, ${y.toFixed(1)}) — check the terrain grid for no-data cells`);
      }
      pnts.push(`<P id="${r * n + c + 1}">${y.toFixed(3)} ${x.toFixed(3)} ${z.toFixed(3)}</P>`);
    }
  }

  const faces: string[] = [];
  for (let r = 0; r < n - 1; r++) {
    for (let c = 0; c < n - 1; c++) {
      const a = r * n + c + 1;       // NW
      const b = a + 1;               // NE
      const d = a + n;               // SW
      const e = d + 1;               // SE
      // Counter-clockwise viewed from above (+z): NW -> SW -> SE, NW -> SE -> NE.
      faces.push(`<F>${a} ${d} ${e}</F>`);
      faces.push(`<F>${a} ${e} ${b}</F>`);
    }
  }

  // ASCII-only surface name: Civil 3D turns the surface name into a drawing
  // object name, and non-ASCII characters (em dash etc.) are mangled by some
  // LandXML importers / codepage round-trips. Keep the whole name 7-bit safe.
  const asciiProject = projectName.replace(/[^\x20-\x7e]+/g, '_');
  const name = esc(`${asciiProject} - Proposed FG (screening)`);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2" version="1.2" date="2026-01-01" time="00:00:00" readOnly="true" language="English">',
    '  <Units>',
    '    <Imperial areaUnit="squareFoot" linearUnit="foot" volumeUnit="cubicYard" temperatureUnit="fahrenheit" pressureUnit="inchHG"/>',
    '  </Units>',
    '  <Application name="BESSForge" desc="BESS yard screening layout" manufacturer="ECI-EPCS" version="1.0"/>',
    '  <Surfaces>',
    `    <Surface name="${name}" desc="Screening-grade proposed finished grade. Local site coordinates (feet); not georeferenced. Not for construction.">`,
    '      <Definition surfType="TIN">',
    '        <Pnts>',
    ...pnts.map(p => `          ${p}`),
    '        </Pnts>',
    '        <Faces>',
    ...faces.map(f => `          ${f}`),
    '        </Faces>',
    '      </Definition>',
    '    </Surface>',
    '  </Surfaces>',
    '</LandXML>',
    '',
  ].join('\n');
}
