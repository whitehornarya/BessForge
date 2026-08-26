// Shared hatch-pattern segment generators for every display-list renderer
// (PDF plot, canvas plots, CAD linework view). The segment geometry matches
// the DXF pattern definitions the writer embeds (dxfExport addHatchLoops),
// so all renderers show the exact pattern the exported DXF contains.

// Diagonal pattern lines clipped to the hatch loops with even-odd parity
// (outer boundary minus island holes). dir = +1 draws 45-degree lines
// (x - y = c), dir = -1 draws 135-degree lines (x + y = c).
export function diagSegments(
  loops: number[][][],
  spacing: number,
  dir: 1 | -1
): Array<[number, number, number, number]> {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  loops.forEach(l => l.forEach(p => {
    if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0];
    if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1];
  }));
  const segs: Array<[number, number, number, number]> = [];
  // Perpendicular spacing s => step in c of s*sqrt2.
  const dc = spacing * Math.SQRT2;
  const cMin = dir === 1 ? minX - maxY : minX + minY;
  const cMax = dir === 1 ? maxX - minY : maxX + maxY;
  const c0 = Math.ceil(cMin / dc) * dc;
  for (let c = c0; c <= cMax; c += dc) {
    // Intersections of the line x = dir*y + c with all loop edges; even-odd pairs.
    const ts: number[] = []; // parameter = y coordinate along the line
    for (const loop of loops) {
      for (let i = 0; i < loop.length; i++) {
        const a = loop[i], b = loop[(i + 1) % loop.length];
        // Edge param u in [0,1): solve (ax + (bx-ax)u) - dir*(ay + (by-ay)u) = c
        const denom = (b[0] - a[0]) - dir * (b[1] - a[1]);
        if (Math.abs(denom) < 1e-12) continue;
        const u = (c - (a[0] - dir * a[1])) / denom;
        if (u >= 0 && u < 1) ts.push(a[1] + (b[1] - a[1]) * u);
      }
    }
    ts.sort((p, q) => p - q);
    for (let i = 0; i + 1 < ts.length; i += 2) {
      const y1 = ts[i], y2 = ts[i + 1];
      if (y2 - y1 > 0.05) segs.push([dir * y1 + c, y1, dir * y2 + c, y2]);
    }
  }
  return segs;
}

// ANSI31: single 45-degree family at 3 ft (matches the DXF pattern def).
export function ansi31Segments(loops: number[][][]): Array<[number, number, number, number]> {
  return diagSegments(loops, 3, 1);
}

// ANSI37: 45/135-degree cross-hatch MESH at 3 ft — the issued 90% package
// convention for future augmentation areas (matches the DXF pattern def).
export function ansi37Segments(loops: number[][][]): Array<[number, number, number, number]> {
  return [...diagSegments(loops, 3, 1), ...diagSegments(loops, 3, -1)];
}

// GRAVEL: light 45/135-degree crosshatch at 8 ft (matches the DXF pattern def).
export function gravelSegments(loops: number[][][]): Array<[number, number, number, number]> {
  return [...diagSegments(loops, 8, 1), ...diagSegments(loops, 8, -1)];
}
