// In-panel preview of the permit packet's earthwork contour figure.
// Mirrors drawContourFigure in permitPdf.ts (minor contours light/thin, index
// contours heavier with elevation labels, parcel boundary property-line
// purple, fence amber) and is fed by the exact same contoursForDxf output the
// PDF embeds — including the drafter's contour-interval selection (0 = auto)
// — so what the drafter sees here is what the packet will contain.
import { useMemo } from 'react';
import { contoursForDxf, ElevationGrid } from '../lib/nextera/terrain';
import { SiteDesign } from '../lib/nextera/types';
import { PROPERTY_LINE_FIGURE_RGB, showSeparateFence } from '../lib/nextera/propertyLineColor';

const BOUNDARY_STROKE = `rgb(${PROPERTY_LINE_FIGURE_RGB.join(',')})`;

const W = 260;
const H = 190;
const PAD = 10;

export function ContourFigurePreview({
  terrain,
  design,
  intervalFt = 0,
}: {
  terrain: ElevationGrid;
  design: SiteDesign;
  intervalFt?: number; // drafter's contour-interval pick; 0 = auto
}) {
  const contours = useMemo(
    // Same interval selection as PermitEarthwork.contours the PDF embeds.
    () => contoursForDxf(terrain, design.boundary.origin, intervalFt),
    [terrain, design.boundary.origin, intervalFt]
  );

  const fig = useMemo(() => {
    if (!contours || !contours.lines.length) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const pt = (x: number, y: number) => {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    };
    for (const line of contours.lines) for (const p of line.pts) pt(p.x, p.y);
    for (const p of design.boundary.polygon) pt(p.x, p.y);
    for (const p of design.fence) pt(p.x, p.y);
    if (!isFinite(minX) || maxX - minX < 1 || maxY - minY < 1) return null;

    const sc = Math.min((W - 2 * PAD) / (maxX - minX), (H - 2 * PAD) / (maxY - minY));
    const w = (maxX - minX) * sc, h = (maxY - minY) * sc;
    const ox = (W - w) / 2, oy = (H - h) / 2;
    const fx = (x: number) => ox + (x - minX) * sc;
    const fy = (y: number) => oy + (maxY - y) * sc;
    const toPath = (pts: { x: number; y: number }[], closed: boolean) =>
      pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${fx(p.x).toFixed(1)} ${fy(p.y).toFixed(1)}`).join(' ') +
      (closed && pts.length > 2 ? ' Z' : '');

    const minor: string[] = [];
    const major: string[] = [];
    const labels: { x: number; y: number; text: string }[] = [];
    const fmtElev = (e: number) => (Number.isInteger(e) ? e.toFixed(0) : e.toFixed(1));
    for (const line of contours.lines) {
      if (line.pts.length < 2) continue;
      if (line.major) {
        major.push(toPath(line.pts, line.closed));
        const m = line.pts[Math.floor(line.pts.length / 2)];
        labels.push({ x: fx(m.x), y: fy(m.y) - 1.5, text: fmtElev(line.elevFt) });
      } else {
        minor.push(toPath(line.pts, line.closed));
      }
    }
    const boundary = design.boundary.polygon.length > 2 ? toPath(design.boundary.polygon, true) : null;
    const fence = showSeparateFence(design) && design.fence.length > 2
      ? toPath(design.fence, true)
      : null;
    return { minor, major, labels, boundary, fence, fmtElev };
  }, [contours, design]);

  if (!contours || !fig) {
    return (
      <div className="ml-5 mt-1.5 text-[10px] text-slate-500">
        Site has no measurable relief — the packet's earthwork figure will be omitted.
      </div>
    );
  }

  return (
    <div className="ml-5 mt-1.5">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full rounded border border-slate-600 bg-white"
        role="img"
        aria-label="Earthwork contour figure preview"
      >
        {fig.minor.map((d, i) => (
          <path key={`mn${i}`} d={d} fill="none" stroke="rgb(170,178,186)" strokeWidth={0.4} />
        ))}
        {fig.major.map((d, i) => (
          <path key={`mj${i}`} d={d} fill="none" stroke="rgb(110,118,128)" strokeWidth={0.9} />
        ))}
        {fig.labels.map((l, i) => (
          <text
            key={`lb${i}`}
            x={l.x}
            y={l.y}
            textAnchor="middle"
            fontSize={6}
            fontFamily="Helvetica, Arial, sans-serif"
            fill="rgb(90,98,108)"
          >
            {l.text}
          </text>
        ))}
        {fig.boundary && (
          <path d={fig.boundary} fill="none" stroke={BOUNDARY_STROKE} strokeWidth={0.7} />
        )}
        {fig.fence && (
          <path d={fig.fence} fill="none" stroke="rgb(180,120,10)" strokeWidth={0.7} />
        )}
      </svg>
      <div className="mt-1 text-[10px] text-slate-400">
        Earthwork figure as it will appear in the permit packet — {fig.fmtElev(contours.intervalFt)} ft
        {intervalFt > 0 ? '' : ' (auto)'} interval, index contours every {fig.fmtElev(contours.majorEveryFt)} ft (labeled).
      </div>
    </div>
  );
}
