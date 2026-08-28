import { Suspense } from "react";
import { Toaster } from "sonner";
import DesignControlPanel from "./components/DesignControlPanel";
import DesignScene from "./components/DesignScene";
import FeederLegend from "./components/FeederLegend";
import { useDesignStore } from "./lib/stores/useDesignStore";

function BusyOverlay() {
  const busy = useDesignStore(s => s.busyOverlay);
  if (!busy) return null;
  const pct = typeof busy.frac === "number"
    ? Math.max(0, Math.min(100, Math.round(busy.frac * 100)))
    : null;
  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 pointer-events-auto"
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <div className="flex flex-col items-center gap-3 px-6 py-5 rounded-lg bg-slate-900/95 border border-slate-600 shadow-xl max-w-sm mx-4">
        <div className="w-10 h-10 border-4 border-cyan-400 border-t-transparent rounded-full animate-spin" />
        <div className="text-sm text-slate-100 text-center">{busy.label}</div>
        {pct !== null && (
          <div className="w-56 flex flex-col gap-1.5">
            <div className="h-1.5 rounded bg-slate-700 overflow-hidden">
              <div
                className="h-full bg-cyan-500 rounded transition-[width] duration-200 ease-out"
                style={{ width: `${pct}%` }}
              />
            </div>
            <div className="text-[11px] text-slate-400 text-center">{pct}%</div>
          </div>
        )}
      </div>
    </div>
  );
}

function App() {
  return (
    <div className="app-container h-screen w-screen overflow-hidden flex">
      <DesignControlPanel />
      <div className="flex-1 relative">
        <Suspense
          fallback={
            <div className="h-full w-full flex items-center justify-center bg-background">
              <div className="w-10 h-10 border-4 border-primary border-t-transparent rounded-full animate-spin"></div>
            </div>
          }
        >
          <DesignScene />
        </Suspense>
        <FeederLegend />
      </div>
      <BusyOverlay />
      <Toaster position="top-right" richColors />
    </div>
  );
}

export default App;
