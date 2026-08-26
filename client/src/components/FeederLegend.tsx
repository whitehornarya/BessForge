import { useMemo } from 'react';
import { useDesignStore } from '../lib/stores/useDesignStore';
import { feederLegendRows } from '../lib/nextera/feederColors';
import { feederRouteKey, FeederRoutingMode } from '../lib/nextera/feeders';
import { toast } from 'sonner';

// Approximate brown for the aux feeder swatch — matches COLORS.AUX_FEEDER (ACI 36).
const AUX_FEEDER_SWATCH = '#8B5E3C';

// Matches FEEDER_COLOR in DesignScene/YardExtras: the single color used for
// all feeder polylines when the per-feeder color palette is switched off.
const UNCOLORED_FEEDER_HEX = '#e91e63';

const MODE_LABEL: Record<FeederRoutingMode, string> = {
  orthogonal: '90°',
  angled: 'ANG',
};

// On-screen feeder legend overlay for the 3D/2D scene: one row per feeder
// circuit with its palette swatch, F-label, PCS count, BESS count and its
// home-run routing mode (90° / ANG / MAN). Dark background with light text
// so it stays readable over any yard view.
// Each row is a click toggle that hides/shows that feeder's scene rendering
// (polylines, trench channels, PCS tint) — display-only: DXF/PDF exports
// always include every feeder, and the hidden set resets on regeneration.
// In Edit Layout mode, clicking a row instead selects that feeder and
// enters the waypoint-drawing flow (same as clicking its home run in the
// scene). The header hosts the design-wide routing-mode toggle; the mode
// chip on each row cycles a per-feeder override (drawn routes show MAN —
// clicking the chip clears the drawn route back to the mode-based route).
export default function FeederLegend() {
  const feeders = useDesignStore(s => s.feeders);
  const design = useDesignStore(s => s.design);
  const showFeederColors = useDesignStore(s => s.showFeederColors);
  const hiddenFeeders = useDesignStore(s => s.hiddenFeeders);
  const toggleFeederHidden = useDesignStore(s => s.toggleFeederHidden);
  const setAllFeedersHidden = useDesignStore(s => s.setAllFeedersHidden);
  const feederRoutingMode = useDesignStore(s => s.feederRoutingMode);
  const setFeederRoutingMode = useDesignStore(s => s.setFeederRoutingMode);
  const setFeederMode = useDesignStore(s => s.setFeederMode);
  const layoutEdits = useDesignStore(s => s.layoutEdits);
  const layoutEditActive = useDesignStore(s => s.layoutEditActive);
  const requestFeederDraw = useDesignStore(s => s.requestFeederDraw);
  const removeFeederRoute = useDesignStore(s => s.removeFeederRoute);
  const setAuxFeederRoute = useDesignStore(s => s.setAuxFeederRoute);
  const requestAuxFeederDraw = useDesignStore(s => s.requestAuxFeederDraw);

  const rows = useMemo(
    () => (feeders.length && design ? feederLegendRows(feeders, design.equipment) : []),
    [feeders, design]
  );

  // Legend stays available even with feeder colors off, so drafters who
  // prefer uncolored feeders can still hide/show individual circuits. With
  // colors off, swatches use the scene's single uncolored feeder color.
  if (rows.length === 0) return null;

  const allHidden = rows.every(r => hiddenFeeders.has(r.idx));

  // Effective routing display per feeder: a drawn route override reads MAN;
  // otherwise the per-feeder mode override, falling back to the default.
  const routeKeyFor = (idx: number): string | null => {
    const f = feeders.find(ff => ff.idx === idx);
    return f ? feederRouteKey(f.inverterIds) : null;
  };
  const modeInfo = (idx: number): { label: string; manual: boolean; mode: FeederRoutingMode } => {
    const key = routeKeyFor(idx);
    const manual = !!(key && layoutEdits.feederRoutes?.[key]);
    const mode = (key && layoutEdits.feederModes?.[key]) || feederRoutingMode;
    return { label: manual ? 'MAN' : MODE_LABEL[mode], manual, mode };
  };

  const auxFeeder = design?.auxFeeder ?? null;
  const auxIsManual = !!(layoutEdits.auxFeederWaypoints?.length);

  return (
    <div
      className="absolute bottom-3 right-3 z-10 rounded-md px-3 py-2 text-xs select-none"
      style={{ background: 'rgba(15, 18, 24, 0.82)', color: '#e8eaed', backdropFilter: 'blur(2px)' }}
    >
      <div className="flex items-center gap-2 mb-1">
        <span className="font-semibold tracking-wide" style={{ color: '#ffffff' }}>
          MV FEEDERS
        </span>
        <button
          type="button"
          className="rounded px-1.5 py-0.5 hover:bg-white/10 border border-white/20"
          style={{ color: '#9db4d4', fontSize: 10, lineHeight: '14px' }}
          title={feederRoutingMode === 'angled'
            ? 'Home runs ride a shared straight angled corridor to the substation — click for the classic 90° corridor'
            : 'Home runs ride the classic 90° corridor comb — click for a shared straight angled corridor to the substation'}
          onClick={() => setFeederRoutingMode(feederRoutingMode === 'angled' ? 'orthogonal' : 'angled')}
        >
          {feederRoutingMode === 'angled' ? 'ANGLED' : '90°'}
        </button>
        <button
          type="button"
          className="ml-auto rounded px-1.5 py-0.5 hover:bg-white/10"
          style={{ color: '#9db4d4', fontSize: 10, lineHeight: '14px' }}
          title={allHidden ? 'Show all feeders in the preview' : 'Hide all feeders in the preview'}
          onClick={() => setAllFeedersHidden(!allHidden)}
        >
          {allHidden ? 'Show all' : 'Hide all'}
        </button>
      </div>
      {rows.map(r => {
        const hidden = hiddenFeeders.has(r.idx);
        const mi = modeInfo(r.idx);
        return (
          <div key={r.label} className="flex w-full items-center gap-2 leading-5">
            <button
              type="button"
              className="flex flex-1 items-center gap-2 rounded px-1 -mx-1 text-left hover:bg-white/10"
              style={{ opacity: hidden ? 0.4 : 1 }}
              title={layoutEditActive
                ? `Draw a custom route for ${r.label} (click waypoints in the scene, Enter to apply)`
                : hidden ? `Show ${r.label} in the preview` : `Hide ${r.label} in the preview (exports are unaffected)`}
              aria-pressed={hidden}
              onClick={() => {
                if (layoutEditActive) requestFeederDraw(r.idx);
                else toggleFeederHidden(r.idx);
              }}
            >
              <span
                className="inline-block rounded-sm"
                style={{ width: 14, height: 8, background: showFeederColors ? r.color.hex : UNCOLORED_FEEDER_HEX }}
              />
              <span
                className="font-medium"
                style={{ minWidth: 22, textDecoration: hidden ? 'line-through' : 'none' }}
              >
                #{r.label}
              </span>
              <span style={{ color: '#b7bcc4' }}>
                {r.pcsCount} PCS &middot; {r.bessCount} BESS
                {r.eolPcsCount > r.pcsCount ? ` · EOL ${r.eolPcsCount}/${r.eolBessCount}` : ''}
              </span>
            </button>
            <button
              type="button"
              className="rounded px-1 py-0 hover:bg-white/10 border border-white/15"
              style={{ color: mi.manual ? '#f0b429' : '#9db4d4', fontSize: 9, lineHeight: '13px', minWidth: 28 }}
              title={mi.manual
                ? `${r.label} follows a drafter-drawn route — click to clear it back to the automatic ${MODE_LABEL[mi.mode]} route`
                : `${r.label} routing: ${mi.label} — click to switch this feeder to ${mi.mode === 'angled' ? '90°' : 'angled'} routing`}
              onClick={() => {
                const key = routeKeyFor(r.idx);
                if (!key) return;
                if (mi.manual) {
                  removeFeederRoute(key);
                  toast.success(`Feeder #${r.label} drawn route cleared — automatic ${MODE_LABEL[mi.mode]} route restored`);
                } else {
                  setFeederMode(r.idx, mi.mode === 'angled' ? 'orthogonal' : 'angled');
                }
              }}
            >
              {mi.label}
            </button>
          </div>
        );
      })}

      {/* AUX FEEDER row: single row for the 34.5 kV daisy chain with AUTO/MAN chip */}
      {auxFeeder && auxFeeder.legs.length > 0 && (
        <>
          <div className="mt-1.5 pt-1.5" style={{ borderTop: '1px solid rgba(255,255,255,0.1)' }}>
            <div className="flex w-full items-center gap-2 leading-5">
              <button
                type="button"
                className="flex flex-1 items-center gap-2 rounded px-1 -mx-1 text-left hover:bg-white/10"
                title={layoutEditActive
                  ? 'Draw a custom route for the aux feeder (click waypoints in the scene, Enter to apply)'
                  : 'AUX FEEDER — 34.5 kV daisy chain through aux transformers'}
                onClick={() => {
                  if (layoutEditActive) requestAuxFeederDraw();
                }}
              >
                <span
                  className="inline-block rounded-sm"
                  style={{ width: 14, height: 8, background: AUX_FEEDER_SWATCH }}
                />
                <span className="font-medium" style={{ color: '#e8eaed' }}>
                  AUX FEEDER
                </span>
                <span style={{ color: '#b7bcc4' }}>
                  {auxFeeder.stopIds.length} AUX XFMR
                </span>
              </button>
              <button
                type="button"
                className="rounded px-1 py-0 hover:bg-white/10 border border-white/15"
                style={{ color: auxIsManual ? '#f0b429' : '#9db4d4', fontSize: 9, lineHeight: '13px', minWidth: 28 }}
                title={auxIsManual
                  ? 'Aux feeder follows a drafter-drawn route — click to clear it back to automatic routing'
                  : 'Aux feeder is auto-routed — click a row in Edit Layout to draw a custom route'}
                onClick={() => {
                  if (auxIsManual) {
                    setAuxFeederRoute(null);
                    toast.success('Aux feeder drawn route cleared — automatic route restored');
                  }
                }}
              >
                {auxIsManual ? 'MAN' : 'AUTO'}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
