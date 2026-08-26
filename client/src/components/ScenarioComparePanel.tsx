// Multi-scenario layout comparison: runs the seeded scenario engine in the
// design worker (never blocks the UI) and presents one card per objective —
// Max Capacity, Min Cabling, Min Civil, Balanced — with a live thumbnail and
// a scorecard. Per-metric best-in-class values are highlighted across the
// cards, and one click applies a scenario through the exact same store path
// as the optimizer (undo with Ctrl+Z).
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useDesignStore } from '../lib/stores/useDesignStore';
import { ARRANGEMENTS } from '../lib/nextera/layoutEngine';
import { Scenario, ScenarioResult, Scorecard } from '../lib/nextera/scenarios';
import { compareScenariosInWorker, cancelChannel, SupersededError } from '../lib/nextera/designWorkerClient';
import { ArrangementThumbnail } from './ArrangementThumbnail';

// One scorecard row: label, value formatter, and whether lower is better.
interface MetricDef {
  key: keyof Scorecard | 'energy';
  label: string;
  lowerBetter: boolean;
  value: (sc: Scorecard) => number;
  fmt: (sc: Scorecard) => string;
}

const METRICS: MetricDef[] = [
  {
    key: 'energy', label: 'Energy', lowerBetter: false,
    value: sc => sc.achievedMWh,
    fmt: sc => `${sc.achievedMW.toFixed(1)} MW / ${sc.achievedMWh.toFixed(0)} MWh`,
  },
  {
    key: 'blockCount', label: 'Blocks', lowerBetter: false,
    value: sc => sc.blockCount,
    fmt: sc => `${sc.blockCount}`,
  },
  {
    key: 'cableFt', label: 'Cable', lowerBetter: true,
    value: sc => sc.cableFt,
    fmt: sc => `${Math.round(sc.cableFt).toLocaleString()} ft`,
  },
  {
    key: 'trenchFt', label: 'Trench', lowerBetter: true,
    value: sc => sc.trenchFt,
    fmt: sc => `${Math.round(sc.trenchFt).toLocaleString()} ft`,
  },
  {
    key: 'roadAreaSqFt', label: 'Road area', lowerBetter: true,
    value: sc => sc.roadAreaSqFt,
    fmt: sc => `${(sc.roadAreaSqFt / 43560).toFixed(2)} ac`,
  },
  {
    key: 'fencePerimeterFt', label: 'Fence', lowerBetter: true,
    value: sc => sc.fencePerimeterFt,
    fmt: sc => `${Math.round(sc.fencePerimeterFt).toLocaleString()} ft`,
  },
  {
    key: 'warningCount', label: 'Warnings', lowerBetter: true,
    value: sc => sc.warningCount,
    fmt: sc => `${sc.warningCount}`,
  },
];

// Values within this relative tolerance of the best are all "best" (ties).
const TIE_EPS = 1e-6;

function bestValues(scenarios: Scenario[]): Map<string, number> {
  const best = new Map<string, number>();
  for (const m of METRICS) {
    const vs = scenarios.map(s => m.value(s.scorecard));
    best.set(m.key as string, m.lowerBetter ? Math.min(...vs) : Math.max(...vs));
  }
  return best;
}

const isBest = (m: MetricDef, sc: Scorecard, best: Map<string, number>): boolean => {
  const b = best.get(m.key as string);
  if (b === undefined) return false;
  const v = m.value(sc);
  return Math.abs(v - b) <= TIE_EPS * Math.max(1, Math.abs(b));
};

function scenarioSubtitle(s: Scenario): string {
  const parts: string[] = [
    ARRANGEMENTS.find(a => a.id === s.candidate.params.arrangement)?.label ?? s.candidate.params.arrangement,
  ];
  const p = s.candidate.params;
  if (p.latticeShift) parts.push(`grid offset ${p.latticeShift.x}, ${p.latticeShift.y} ft`);
  if (p.trenchX !== null) parts.push(`trench at x = ${p.trenchX} ft`);
  if (p.gateEdge && p.gateEdge !== 'S') {
    parts.push(`gate on ${p.gateEdge === 'N' ? 'north' : p.gateEdge === 'E' ? 'east' : 'west'} edge`);
  }
  return parts.join(' · ');
}

export default function ScenarioComparePanel() {
  const {
    boundary, configId, targetMW, targetMWh, hotClimate, containersPerPcs,
    roadMode, laydownPct, augmentPct, surfacingMode, surfacingDepthIn, dcRouting,
    applyOptimizedLayout,
  } = useDesignStore();

  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [result, setResult] = useState<ScenarioResult | null>(null);
  const [appliedId, setAppliedId] = useState<string | null>(null);
  const cardRefs = useRef<(HTMLDivElement | null)[]>([]);
  // Monotonic run token: bumped whenever a core input changes, so an
  // in-flight run started under old inputs can never surface its result.
  const runTokenRef = useRef(0);

  // Scenario results are only valid for the inputs they were computed from —
  // drop stale cards AND invalidate/cancel any in-flight run whenever a core
  // design input changes.
  useEffect(() => {
    runTokenRef.current++;
    cancelChannel('scenarios');
    setResult(null);
    setAppliedId(null);
  }, [boundary, configId, targetMW, targetMWh, hotClimate, containersPerPcs, roadMode, laydownPct, augmentPct, surfacingMode, surfacingDepthIn, dcRouting]);

  const handleRun = async () => {
    if (!boundary || running) return;
    const token = ++runTokenRef.current;
    setRunning(true);
    setResult(null);
    setAppliedId(null);
    setProgress({ done: 0, total: 1 });
    try {
      const r = await compareScenariosInWorker(
        boundary,
        configId,
        targetMW,
        targetMWh,
        { hotClimate, containersPerPcs, roadMode, laydownPct, augmentPct, surfacingMode, surfacingDepthIn, dcRouting },
        1,
        (done, total) => {
          if (runTokenRef.current === token) setProgress({ done, total });
        }
      );
      // Inputs changed while the search was running — the result no longer
      // describes the current site; drop it silently (the effect above
      // already cleared the cards and cancelled the worker).
      if (runTokenRef.current !== token) return;
      if (r.cancelled) {
        toast.info('Scenario comparison cancelled');
        setResult(null);
      } else {
        setResult(r);
        if (r.scenarios.length === 0) {
          toast.info('No valid layouts found for this parcel — check the site inputs.');
        }
      }
    } catch (e: any) {
      if (runTokenRef.current !== token) return;
      if (e instanceof SupersededError) {
        toast.info('Scenario comparison cancelled');
      } else {
        toast.error(`Scenario comparison failed: ${e?.message ?? 'unknown error'}`);
      }
    } finally {
      setRunning(false);
      setProgress(null);
    }
  };

  const handleApply = (s: Scenario) => {
    applyOptimizedLayout(s.candidate.params);
    const err = useDesignStore.getState().error;
    if (err) {
      toast.error(`Could not apply scenario: ${err}`);
    } else {
      setAppliedId(s.candidate.id);
      toast.success(
        `${s.def.label} scenario applied — ${s.scorecard.blockCount} blocks, ${s.scorecard.achievedMWh.toFixed(0)} MWh. Undo with Ctrl+Z.`
      );
    }
  };

  // Arrow keys move focus between scenario cards; Enter/Space applies.
  const onCardKeyDown = (e: React.KeyboardEvent, i: number, s: Scenario) => {
    const n = result?.scenarios.length ?? 0;
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
      e.preventDefault();
      cardRefs.current[(i + 1) % n]?.focus();
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
      e.preventDefault();
      cardRefs.current[(i - 1 + n) % n]?.focus();
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleApply(s);
    }
  };

  const best = result && result.scenarios.length > 1 ? bestValues(result.scenarios) : null;

  return (
    <div className="pt-1 border-t border-slate-700 space-y-1.5">
      {!running ? (
        <button
          onClick={handleRun}
          className="w-full py-1.5 rounded bg-sky-700 hover:bg-sky-600 text-xs font-semibold text-slate-100"
        >
          Compare scenarios
        </button>
      ) : (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-slate-400">
            <span>Generating scenarios… {progress ? `${progress.done}/${progress.total}` : ''}</span>
            <button
              onClick={() => cancelChannel('scenarios')}
              className="px-2 py-1 rounded bg-slate-700 hover:bg-slate-600 text-xs font-semibold text-slate-100"
            >
              Cancel
            </button>
          </div>
          <div className="h-1.5 rounded bg-slate-700 overflow-hidden">
            <div
              className="h-full bg-sky-500 transition-all"
              style={{ width: `${progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0}%` }}
            />
          </div>
        </div>
      )}
      <div className="text-slate-500">
        Generates named layout scenarios from one deterministic search — Max Capacity, Min Cabling, Min Civil and Balanced — and compares them side by side. Best value per metric is highlighted.
      </div>

      {result && result.scenarios.length > 0 && (
        <div className="space-y-1.5" role="group" aria-label="Layout scenarios — use arrow keys to move between cards, Enter to apply">
          {result.scenarios.map((s, i) => {
            const applied = appliedId === s.candidate.id;
            const sameAsDef = s.sameAs ? result.scenarios.find(x => x.objective === s.sameAs)?.def : null;
            return (
              <div
                key={s.objective}
                ref={el => (cardRefs.current[i] = el)}
                tabIndex={0}
                onKeyDown={e => onCardKeyDown(e, i, s)}
                className={`rounded border p-2 space-y-1 outline-none transition-colors focus:ring-2 focus:ring-sky-500 ${
                  applied ? 'border-sky-500 bg-sky-950/30' : 'border-slate-700 bg-slate-800/60'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold text-slate-200">
                    {s.def.label}
                    {applied && <span className="text-sky-400 font-normal"> — applied</span>}
                  </span>
                  <button
                    onClick={() => handleApply(s)}
                    className="shrink-0 px-2 py-1 rounded bg-sky-700 hover:bg-sky-600 text-xs font-semibold text-slate-100"
                  >
                    Apply
                  </button>
                </div>
                <div className="text-slate-500">{s.def.tagline} · {scenarioSubtitle(s)}</div>
                {sameAsDef && (
                  <div className="inline-flex items-center gap-1 rounded border border-slate-600 bg-slate-900/60 px-1.5 py-0.5 text-slate-400 font-semibold">
                    Same layout as {sameAsDef.label}
                  </div>
                )}
                <ArrangementThumbnail design={s.candidate.design} />
                <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
                  {METRICS.map(m => {
                    const bestHere = !!best && isBest(m, s.scorecard, best);
                    return (
                      <span
                        key={m.key as string}
                        className={bestHere ? 'text-emerald-400 font-semibold' : 'text-slate-400'}
                        title={bestHere ? `Best ${m.label.toLowerCase()} across scenarios` : undefined}
                      >
                        {m.label}: {m.fmt(s.scorecard)}
                        {bestHere && <span aria-label="best in class"> ★</span>}
                      </span>
                    );
                  })}
                </div>
              </div>
            );
          })}
          <div className="text-slate-500">
            <span className="text-emerald-400 font-semibold">★</span> marks the best value for a metric across scenarios. Applying a scenario makes it the new baseline (edits cleared, roads rebuilt) — undo with Ctrl+Z.
          </div>
        </div>
      )}
      {result && result.scenarios.length === 0 && !result.cancelled && (
        <div className="text-slate-500">No valid layouts could be generated for this parcel.</div>
      )}
    </div>
  );
}
