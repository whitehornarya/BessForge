// In-panel preview of the permit packet's grounding screening figure.
// Mirrors drawGroundingFigure in permitPdf.ts (parcel boundary property-line
// purple, fence amber, equipment outlines light red, bonding taps thin green,
// perimeter loop heavier dashed green, ground rods filled green dots) and is
// fed by the exact same buildGroundingPlan output the packet embeds, so the
// rod density and tap legibility the drafter sees here is what the PDF shows.
import { useMemo } from 'react';
import { GroundingPlan } from '../lib/nextera/grounding';
import { SiteDesign } from '../lib/nextera/types';
import { PROPERTY_LINE_FIGURE_RGB, showSeparateFence } from '../lib/nextera/propertyLineColor';

const BOUNDARY_STROKE = `rgb(${PROPERTY_LINE_FIGURE_RGB.join(',')})`;

const W = 260;
const H = 190;
const PAD = 10;

export function GroundingFigurePreview({
  grounding,
  design,
}: {
  grounding: GroundingPlan;
  design: SiteDesign;
}) {
  const fig = useMemo(() => {
    const loops = (grounding.loops ?? [grounding.loop]).filter(l => l.length > 2);
    if (!loops.length) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const pt = (x: number, y: number) => {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    };
    for (const lp of loops) for (const p of lp) pt(p.x, p.y);
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

    const boundary = design.boundary.polygon.length > 2 ? toPath(design.boundary.polygon, true) : null;
    const fence = showSeparateFence(design) && design.fence.length > 2
      ? toPath(design.fence, true)
      : null;
    const equipment: string[] = [];
    for (const eq of design.equipment) {
      const c = Math.cos(eq.rotation), s = Math.sin(eq.rotation);
      const hx = eq.length / 2, hy = eq.width / 2;
      const corners = [
        [-hx, -hy], [hx, -hy], [hx, hy], [-hx, hy],
      ].map(([lx, ly]) => ({ x: eq.x + lx * c - ly * s, y: eq.y + lx * s + ly * c }));
      equipment.push(toPath(corners, true));
    }
    const gridLines = grounding.grid.map(([a, b]) =>
      `M${fx(a.x).toFixed(1)} ${fy(a.y).toFixed(1)} L${fx(b.x).toFixed(1)} ${fy(b.y).toFixed(1)}`
    );
    const taps = grounding.taps.map(tap =>
      `M${fx(tap.from.x).toFixed(1)} ${fy(tap.from.y).toFixed(1)} L${fx(tap.to.x).toFixed(1)} ${fy(tap.to.y).toFixed(1)}`
    );
    const loopPaths = loops.map(lp => toPath(lp, true));
    const rods = grounding.rods.map(r => ({ cx: fx(r.x), cy: fy(r.y) }));
    const crossings = grounding.crossings.map(c => ({ cx: fx(c.x), cy: fy(c.y) }));
    const wells = grounding.testWells.map(w => ({ cx: fx(w.x), cy: fy(w.y) }));
    return { boundary, fence, equipment, taps, gridLines, loopPaths, rods, crossings, wells };
  }, [grounding, design]);

  if (!fig) {
    return (
      <div className="ml-5 mt-1.5 text-[10px] text-slate-500">
        Grounding loop unavailable — the packet's grounding figure will be omitted.
      </div>
    );
  }

  const s = grounding.summary;
  return (
    <div className="ml-5 mt-1.5">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full rounded border border-slate-600 bg-white"
        role="img"
        aria-label="Grounding screening figure preview"
      >
        {fig.boundary && (
          <path d={fig.boundary} fill="none" stroke={BOUNDARY_STROKE} strokeWidth={0.7} />
        )}
        {fig.fence && (
          <path d={fig.fence} fill="none" stroke="rgb(180,120,10)" strokeWidth={0.7} />
        )}
        {fig.equipment.map((d, i) => (
          <path key={`eq${i}`} d={d} fill="none" stroke="rgb(200,150,150)" strokeWidth={0.4} />
        ))}
        {fig.gridLines.map((d, i) => (
          <path key={`gr${i}`} d={d} fill="none" stroke="rgb(30,120,70)" strokeWidth={0.4} />
        ))}
        {fig.taps.map((d, i) => (
          <path key={`tp${i}`} d={d} fill="none" stroke="rgb(30,120,70)" strokeWidth={0.5} />
        ))}
        {fig.loopPaths.map((d, i) => (
          <path
            key={`lp${i}`}
            d={d}
            fill="none"
            stroke="rgb(30,120,70)"
            strokeWidth={1}
            strokeDasharray="3 2"
          />
        ))}
        {fig.crossings.map((c, i) => (
          <circle key={`cx${i}`} cx={c.cx} cy={c.cy} r={0.7} fill="rgb(30,120,70)" />
        ))}
        {fig.rods.map((r, i) => (
          <circle key={`rd${i}`} cx={r.cx} cy={r.cy} r={1.4} fill="rgb(30,120,70)" />
        ))}
        {fig.wells.map((w, i) => (
          <circle key={`tw${i}`} cx={w.cx} cy={w.cy} r={2.7} fill="none" stroke="rgb(30,120,70)" strokeWidth={0.5} />
        ))}
      </svg>
      <div className="mt-1 text-[10px] text-slate-400">
        Grounding figure as it will appear in the permit packet — grid confined to the
        equipment island envelope (dashed loop), {s.rodCount} ground rods (dots, max {s.rodSpacingFt} ft spacing), {s.testWellCount} test
        wells (circled), {s.crossingCount} grid crossings, {s.tapCount} equipment
        bonding taps. Screening only — not an IEEE 80 study.
      </div>
    </div>
  );
}
