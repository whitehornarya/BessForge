// In-panel preview of the energy report's capacity curve chart. Mirrors
// drawCapacityChart in energySimPdf.ts (usable-MWh polyline in the same
// blue, dashed red contract line, orange augmentation-year triangles,
// slate gridlines with 1/2/5-ladder ticks) and is fed by the exact same
// buildEnergySim result the report embeds, so the augmentation strategy
// the drafter sees here is what the exported PDF shows. Preview only —
// never part of any export or the project JSON.
import { useMemo } from 'react';
import { EnergySimResult } from '../lib/nextera/energySim';

const W = 260;
const H = 150;
const PAD_L = 40; // room for y-axis tick labels
const PAD_R = 8;
const PAD_T = 6;
const PAD_B = 16; // x-axis labels

export function CapacityCurvePreview({ result }: { result: EnergySimResult }) {
  const fig = useMemo(() => {
    const years = result.years;
    if (years.length === 0) return null;
    const contract = years[0].contractMWh;
    const px = PAD_L, py = PAD_T;
    const pw = W - PAD_L - PAD_R, ph = H - PAD_T - PAD_B;

    // Y range: usable values plus the contract line, padded, tick-snapped
    // with the same 1/2/5 ladder the PDF chart uses.
    const vals = years.map(yr => yr.usableMWh);
    if (contract > 0) vals.push(contract);
    let vMin = Math.min(...vals), vMax = Math.max(...vals);
    if (vMax - vMin < 1e-9) { vMax += 1; vMin -= 1; }
    const span = vMax - vMin;
    vMin = Math.max(0, vMin - span * 0.08);
    vMax = vMax + span * 0.08;
    const rawStep = (vMax - vMin) / 4;
    const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
    const norm = rawStep / mag;
    const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
    vMin = Math.floor(vMin / step) * step;
    vMax = Math.ceil(vMax / step) * step;

    const nYears = years.length;
    const sx = (yr: number) => px + ((yr - 1) / Math.max(1, nYears - 1)) * pw;
    const sy = (v: number) => py + ph - ((v - vMin) / (vMax - vMin)) * ph;

    const grid: { y: number; label: string }[] = [];
    for (let v = vMin; v <= vMax + 1e-9; v += step) {
      grid.push({
        y: sy(v),
        label: v.toLocaleString(undefined, { maximumFractionDigits: 0 }),
      });
    }
    const xTicks: { x: number; label: string }[] = [];
    for (let yr = 1; yr <= nYears; yr++) {
      if (yr === 1 || yr === nYears || yr % 5 === 0) {
        xTicks.push({ x: sx(yr), label: String(yr) });
      }
    }

    // Usable-energy polyline: augmentation installs at the START of a year,
    // so a step-up shows as a vertical riser from the prior year's end value.
    const curve = years
      .map((yr, i) => `${i === 0 ? 'M' : 'L'}${sx(yr.year).toFixed(1)} ${sy(yr.usableMWh).toFixed(1)}`)
      .join(' ');

    const augMarkers = years
      .filter(yr => yr.augAddedContainers > 0)
      .map(yr => {
        const mx = sx(yr.year), my = sy(yr.usableMWh);
        return `M${(mx).toFixed(1)} ${(my - 4.5).toFixed(1)} L${(mx - 3).toFixed(1)} ${(my + 1.5).toFixed(1)} L${(mx + 3).toFixed(1)} ${(my + 1.5).toFixed(1)} Z`;
      });

    const contractY = contract > 0 ? sy(contract) : null;
    const contractLabel = contract > 0
      ? `Contract ${contract.toLocaleString(undefined, { maximumFractionDigits: 0 })} MWh`
      : null;

    return { px, py, pw, ph, grid, xTicks, curve, augMarkers, contractY, contractLabel };
  }, [result]);

  if (!fig) return null;

  return (
    <div className="mt-1">
      <div className="text-[10px] font-semibold text-slate-300">
        Usable Energy vs. Project Year
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="w-full mt-0.5 rounded border border-slate-600 bg-white"
        role="img"
        aria-label="Capacity curve preview"
      >
        {fig.grid.map((g, i) => (
          g.y > fig.py + 0.5 && g.y < fig.py + fig.ph - 0.5 && (
            <line key={`gl${i}`} x1={fig.px} y1={g.y} x2={fig.px + fig.pw} y2={g.y}
              stroke="rgb(226,232,240)" strokeWidth={0.5} />
          )
        ))}
        <rect x={fig.px} y={fig.py} width={fig.pw} height={fig.ph}
          fill="none" stroke="rgb(203,213,225)" strokeWidth={0.5} />
        {fig.grid.map((g, i) => (
          <text key={`gt${i}`} x={fig.px - 3} y={g.y + 2} textAnchor="end"
            fontSize={6} fill="rgb(100,100,100)">{g.label}</text>
        ))}
        {fig.xTicks.map((t, i) => (
          <text key={`xt${i}`} x={t.x} y={fig.py + fig.ph + 8} textAnchor="middle"
            fontSize={6} fill="rgb(100,100,100)">{t.label}</text>
        ))}
        <text x={fig.px + fig.pw / 2} y={fig.py + fig.ph + 15} textAnchor="middle"
          fontSize={6} fill="rgb(100,100,100)">Year</text>
        {fig.contractY !== null && (
          <>
            <line x1={fig.px} y1={fig.contractY} x2={fig.px + fig.pw} y2={fig.contractY}
              stroke="rgb(180,40,40)" strokeWidth={0.8} strokeDasharray="3 2" />
            <text x={fig.px + fig.pw - 2} y={fig.contractY - 3} textAnchor="end"
              fontSize={6} fontWeight="bold" fill="rgb(180,40,40)">{fig.contractLabel}</text>
          </>
        )}
        <path d={fig.curve} fill="none" stroke="rgb(29,78,137)" strokeWidth={1} />
        {fig.augMarkers.map((d, i) => (
          <path key={`am${i}`} d={d} fill="rgb(180,100,10)" />
        ))}
      </svg>
      <div className="mt-0.5 text-[10px] text-slate-500">
        Capacity curve as it will appear in the energy report — usable MWh at end of
        year{fig.contractY !== null ? ', dashed contract line, triangles mark augmentation years' : ''}.
      </div>
    </div>
  );
}
