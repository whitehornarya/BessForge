import { finalizePdfBlob } from '@/lib/nextera/pdfIdentity';
import { Fragment, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useDesignStore } from '../lib/stores/useDesignStore';
import { generateArrangements, ARRANGEMENTS, ArrangementStrategy, DEFAULT_ISLAND_AUG_UNITS, MAX_ISLAND_AUG_UNITS, ISLAND_PCS_PER_SIDE, MANUAL_EQUIPMENT_CATALOG, isManualEquipmentSpec, isTracedBessYard } from '../lib/nextera/layoutEngine';
import { OptimizeResult, OptimizeCandidate } from '../lib/nextera/optimizer';
import { optimizeInWorker, optimizeGradingInWorker, optimizeFeederRoutingInWorker, buildDxfInWorker, buildDxfPackageInWorker, cancelChannel, SupersededError } from '../lib/nextera/designWorkerClient';
import { feederRoutingInputSignature } from '../lib/nextera/feederOptimizer';
import { gateApronKeepouts } from '../lib/nextera/feederKeepouts';
import type { FeederRoutingResult, FeederRoutingCandidate } from '../lib/nextera/feederOptimizer';
import { ArrangementThumbnail } from './ArrangementThumbnail';
import { CONFIGURATIONS, getConfiguration, getEffectiveConfiguration } from '../lib/nextera/catalog';
import { buildBomRows, bomToCsv, buildSiteBom, siteBomToCsv } from '../lib/nextera/bom';
import { buildCableScheduleRows } from '../lib/nextera/cableSchedule';
import { buildBomRollup } from '../lib/nextera/bomRollup';
import { FEEDER_CONDUCTOR_SIZES, FeederConductorSize, ConductorMaterial, VD_LIMIT_PCT, inverterAmps, feederRouteKey } from '../lib/nextera/feeders';
import { feederDisplayName } from '../lib/nextera/feederNaming';
import { buildShortCircuitStudy, SC_NUM_LIMITS, SC_RATING_LIMITS } from '../lib/nextera/shortCircuit';
import { buildProtectionStudy, PROTECTION_NUM_LIMITS } from '../lib/nextera/protection';
import { buildFeederElectricalReport } from '../lib/nextera/electrical';
import { validateDesign } from '../lib/nextera/validateDesign';
import CompliancePanel from './CompliancePanel';
import ScenarioComparePanel from './ScenarioComparePanel';
import { assetUrl } from '../lib/assetUrl';
import { YARD_TEXTURE_SETS } from '../lib/textureSets';
import { GE_PCS_GREEN } from '../lib/pcsRecolor';
import { saveBlob } from '../lib/saveFile';
import { terrainLocalRect, terrainCoverageBbox, computeSlopeGrid, computeCutFill, findSteepZones, computeGradingTieIn, pickContourInterval, SteepZoneReport, CutFillEstimate } from '../lib/nextera/terrain';
import { buildFgSurface, ZONE_MIN_SIZE_FT, ZONE_MAX_SIZE_FT } from '../lib/nextera/gradingSurface';
import { buildDrainageModel, drainageSurfacesFromDesign, DRAINAGE_NUM_LIMITS, DrainageNumericKey, DrainageInputs } from '../lib/nextera/drainage';
import { ATLAS14_ARI_CHOICES, fetchNoaaIdf } from '../lib/nextera/rainfall';
import { resampleGridForYardRotation, polygonPivot, boundaryForYardRotation, buildGradingComparisonRows, GradingResult, GradingObjective } from '../lib/nextera/gradingOptimizer';
import { CUT_FILL_PREVIEW_LEGEND } from './TerrainMesh';
import { ContourFigurePreview } from './ContourFigurePreview';
import { GroundingFigurePreview } from './GroundingFigurePreview';
import { CapacityCurvePreview } from './CapacityCurvePreview';
import { buildGroundingPlan, ROD_SPACING_OPTIONS } from '../lib/nextera/grounding';
import { buildIeee80StudyFromPlan, DEFAULT_IEEE80_INPUTS, FT_TO_M, IEEE80_NUM_LIMITS } from '../lib/nextera/ieee80';
import { buildEnergySim, DEFAULT_CABLE_LOSS_FRAC, ENERGY_SIM_NUM_LIMITS } from '../lib/nextera/energySim';
import { buildEnergySimPdf } from '../lib/nextera/energySimPdf';
import { computeEarthworkCost, fmtUSD, COST_DISCLAIMER } from '../lib/nextera/earthworkCost';
import { isCoordinateLocation, fetchGeocodedLocation } from '../lib/nextera/geocode';
import { siteAreasTotals, areasMissingRoads, areasWithAccessRoadShortfalls } from '../lib/nextera/siteAreas';
import { areaFeederEndpoint, effectiveTakeoffs } from '../lib/nextera/substationTakeoffs';
import { SiteComposeInput, selectionLabel, selectedSiteAreas } from '../lib/nextera/siteCompose';
import { TAKEOFF_DIRECTIONS, type TakeoffDirection } from '../lib/nextera/types';
import {
  DRAWING_VISIBILITY_KEYS,
  drawingVisibilityAllOn,
  type DrawingVisibilityKey,
} from '../lib/nextera/drawingVisibility';
import { getSavedApiBaseOverride, resolveApiBase, saveApiBaseOverride } from '../lib/api/base';
import { API_STATUS_EVENT, type ApiResponseMeta } from '../lib/api/fetch';
import { exportSitePack, importSitePack, prefetchSiteData } from '../lib/offline/sitePack';
import { satelliteCoverageBbox } from '../lib/nextera/satellite';

const SAMPLE_SITES: { name: string; url: string; boundaryNames?: string[] }[] = [
  {
    name: 'Great Prairie 1 & 2',
    url: assetUrl('/samples/great-prairie-1-2.kmz'),
    // The KMZ holds 8 polygons — only these three are selectable site boundaries.
    boundaryNames: [
      'GREAT PRAIRIE WIND LLC substation boundary',
      'GP1 phase 1 - 200MW',
      'GP Energy Storage Boundary',
    ],
  },
  { name: 'Great Prairie Laydown', url: assetUrl('/samples/laydown.kmz') },
  { name: 'Hondo 100MW', url: assetUrl('/samples/hondo-100mw.kmz') },
  { name: 'Kaser NEER', url: assetUrl('/samples/kaser-neer.kmz') },
];

const DRAWING_VISIBILITY_LABELS: Record<DrawingVisibilityKey, { label: string; hint: string }> = {
  fiber: {
    label: 'Fiber',
    hint: '144-count trunk, 6-count drops, and container/CATL fiber networks',
  },
  pcsToBess: {
    label: 'PCS-to-BESS',
    hint: 'Both DC polarities and their direct or structured DC route/trench graphics',
  },
  dimensions: {
    label: 'Dimensions',
    hint: 'Measurement geometry and dimension text; sheet metadata and required notes stay visible',
  },
  labels: {
    label: 'Labels',
    hint: 'Generated equipment, circuit, cable, and callout labels; title blocks and mandatory metadata stay visible',
  },
  auxiliaryCables: {
    label: 'Auxiliary Cables',
    hint: 'Auxiliary MV feeder, 480 V distribution, local auxiliary power, and related cable callouts',
  },
};

function DrawingVisibilityPanel() {
  const profile = useDesignStore(s => s.drawingVisibility);
  const setDrawingVisibility = useDesignStore(s => s.setDrawingVisibility);
  const resetDrawingVisibility = useDesignStore(s => s.resetDrawingVisibility);
  const allOn = drawingVisibilityAllOn(profile);
  return (
    <section className="bg-slate-800 rounded p-3">
      <div className="flex items-start justify-between gap-3 mb-2">
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-300">
            Drawing Visibility
          </h3>
          <p className="text-[10px] leading-4 text-slate-500 mt-0.5">
            Project setting · applies immediately to CAD, 3D, 2D, DXF, PDF, permit, key maps, and 10% outputs
          </p>
        </div>
        <button
          type="button"
          onClick={resetDrawingVisibility}
          disabled={allOn}
          className="shrink-0 text-[10px] px-2 py-1 rounded border border-slate-600 text-slate-300 hover:bg-slate-700 disabled:opacity-40 disabled:cursor-default"
        >
          Reset All
        </button>
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-1">
        {DRAWING_VISIBILITY_KEYS.map(key => {
          const item = DRAWING_VISIBILITY_LABELS[key];
          return (
            <label
              key={key}
              className="flex items-center gap-2 min-h-7 text-xs text-slate-200 cursor-pointer hover:text-white"
              title={item.hint}
            >
              <input
                type="checkbox"
                checked={profile[key]}
                onChange={e => setDrawingVisibility({ [key]: e.target.checked })}
                className="accent-cyan-500"
              />
              <span>{item.label}</span>
            </label>
          );
        })}
      </div>
      {!allOn && (
        <div className="mt-2 text-[10px] text-amber-300">
          Hidden systems are omitted from views and issued drawing geometry.
        </div>
      )}
    </section>
  );
}

// Imported CAD drawing layers.
//
// A KMZ issued from CAD carries the whole drawing, not just the parcel: roads,
// DC yards, equipment outlines, easements, monuments and CAD text. All of it
// is imported and shown as reference linework under the generated design, so
// the drafter needs per-layer control — the dense layers (roads, DC yards)
// otherwise bury everything. Heavy layers start hidden; nothing is discarded.
function ImportedDrawingLayerList() {
  const drawing = useDesignStore(s => s.drawing);
  const showDrawing = useDesignStore(s => s.showDrawing);
  const layerVis = useDesignStore(s => s.drawingLayerVis);
  const setShowDrawing = useDesignStore(s => s.setShowDrawing);
  const setDrawingLayerVisible = useDesignStore(s => s.setDrawingLayerVisible);
  const setAllDrawingLayers = useDesignStore(s => s.setAllDrawingLayers);
  const [open, setOpen] = useState(false);
  if (!drawing || !drawing.layers.length) return null;
  const shown = drawing.layers.filter(l => layerVis[l.name] !== false).length;
  return (
    <div className="mt-3 bg-slate-800 rounded p-2.5">
      <div className="flex items-center justify-between gap-2">
        <label className="flex items-center gap-1.5 text-xs text-slate-200">
          <input
            type="checkbox"
            checked={showDrawing}
            onChange={e => setShowDrawing(e.target.checked)}
            className="accent-cyan-500"
          />
          <span className="font-medium">Imported drawing</span>
        </label>
        <button
          onClick={() => setOpen(o => !o)}
          className="text-[10px] px-1.5 py-0.5 rounded bg-slate-700 hover:bg-slate-600 text-slate-300"
        >
          {open ? 'Hide layers' : `${shown}/${drawing.layers.length} layers`}
        </button>
      </div>
      <div className="text-[10px] text-slate-500 mt-1">
        {drawing.featureCount.toLocaleString()} features · {drawing.vertexCount.toLocaleString()} points · reference only, never exported
      </div>
      {open && (
        <div className="mt-2">
          <div className="flex gap-1.5 mb-1.5">
            <button
              onClick={() => setAllDrawingLayers(true)}
              className="flex-1 text-[10px] py-1 rounded bg-slate-700 hover:bg-slate-600 text-slate-200"
            >
              Show all
            </button>
            <button
              onClick={() => setAllDrawingLayers(false)}
              className="flex-1 text-[10px] py-1 rounded bg-slate-700 hover:bg-slate-600 text-slate-200"
            >
              Hide all
            </button>
          </div>
          <div className="max-h-56 overflow-y-auto flex flex-col gap-0.5 pr-1">
            {drawing.layers.map(l => (
              <label
                key={l.name}
                className="flex items-center justify-between gap-2 text-[10px] text-slate-300 px-1 py-0.5 rounded hover:bg-slate-700/60"
                title={`${l.featureCount.toLocaleString()} features, ${l.vertexCount.toLocaleString()} points`}
              >
                <span className="flex items-center gap-1.5 min-w-0">
                  <input
                    type="checkbox"
                    checked={layerVis[l.name] !== false}
                    onChange={e => setDrawingLayerVisible(l.name, e.target.checked)}
                    className="accent-cyan-500 shrink-0"
                  />
                  <span className="truncate">{l.name}</span>
                </span>
                <span className="text-slate-500 shrink-0">{l.featureCount.toLocaleString()}</span>
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// Auto-fill the design from the imported reference drawing: classify shapes
// by their KML placemark names, preview the plan as ghosts in the scene, tag
// the unknowns, then commit everything as ONE undoable edit. Reference wins:
// clearance conflicts warn but the geometry lands exactly as drawn.
const TRACE_KIND_LABELS: Record<string, string> = {
  bess: 'BESS container', inverter: 'PCS unit', generator: 'Generator',
  conex: 'CONEX box', manhole: 'Manhole',
  auxTransformer: 'Aux transformer', auxSwitchPanel: 'Aux distribution panel',
  fireControlPanel: 'Fire control panel', commsCabinet: 'Communications cabinet',
  road: 'Road', ignore: 'Ignore',
};
const TRACE_TAG_OPTIONS = ['bess', 'inverter', 'generator', 'conex', 'manhole', 'auxTransformer', 'auxSwitchPanel', 'fireControlPanel', 'commsCabinet', 'road', 'ignore'] as const;

function ReferenceAutoFill() {
  const drawing = useDesignStore(s => s.drawing);
  const tracePlan = useDesignStore(s => s.tracePlan);
  const analyzeReferenceTrace = useDesignStore(s => s.analyzeReferenceTrace);
  const setTraceUnknownTag = useDesignStore(s => s.setTraceUnknownTag);
  const applyReferenceTraceWithProgress = useDesignStore(s => s.applyReferenceTraceWithProgress);
  const setBusyOverlay = useDesignStore(s => s.setBusyOverlay);
  const cancelReferenceTrace = useDesignStore(s => s.cancelReferenceTrace);
  const [applyProgress, setApplyProgress] = useState<{ frac: number; label: string } | null>(null);
  const gearPlacement = useDesignStore(s => s.gearPlacement);
  const setGearPlacement = useDesignStore(s => s.setGearPlacement);
  const bulkTag = useDesignStore(s => s.bulkTag);
  const setBulkTag = useDesignStore(s => s.setBulkTag);
  const placedEquipment = useDesignStore(s => s.layoutEdits.placedEquipment);
  const removePlacedEquipment = useDesignStore(s => s.removePlacedEquipment);
  const lastRejection = useDesignStore(s => s.lastRejection);
  // Group selection lives in the store so the 3D ghost preview shows exactly
  // what Apply will commit (unchecking a group hides its ghosts too).
  const traceInclude = useDesignStore(s => s.traceInclude);
  const setTraceInclude = useDesignStore(s => s.setTraceInclude);
  const inclEquip = traceInclude.equipment;
  const inclRoads = traceInclude.roads;
  if (!drawing || !drawing.layers.length) return null;

  const equipCount = tracePlan
    ? tracePlan.items.length + tracePlan.unknowns.filter(u => u.tag !== 'road' && u.tag !== 'ignore').length
    : 0;
  const roadCount = tracePlan
    ? tracePlan.roads.reduce((n, r) => n + r.strips.length, 0) + tracePlan.unknowns.filter(u => u.tag === 'road').length
    : 0;

  return (
    <div className="mt-2 bg-slate-800 rounded p-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-slate-200">Auto-fill from drawing</span>
        {!tracePlan && (
          <button
            onClick={() => { if (!analyzeReferenceTrace()) toast.error(useDesignStore.getState().lastRejection ?? 'Nothing to auto-fill.'); }}
            className="text-[10px] px-2 py-1 rounded bg-cyan-700 hover:bg-cyan-600 text-white"
          >
            Scan drawing
          </button>
        )}
      </div>
      {!tracePlan && (
        <div className="text-[10px] text-slate-500 mt-1">
          Turn the drawn roads and equipment outlines into a live design — everything lands exactly where the customer drew it.
        </div>
      )}
      {tracePlan && (
        <div className="mt-2 flex flex-col gap-2">
          <label className="flex items-center gap-1.5 text-[11px] text-slate-300">
            <input type="checkbox" checked={inclEquip} onChange={e => setTraceInclude({ equipment: e.target.checked })} className="accent-cyan-500" />
            Equipment — {equipCount} item{equipCount === 1 ? '' : 's'}
          </label>
          <label className="flex items-center gap-1.5 text-[11px] text-slate-300">
            <input type="checkbox" checked={inclRoads} onChange={e => setTraceInclude({ roads: e.target.checked })} className="accent-cyan-500" />
            Roads — {roadCount} segment{roadCount === 1 ? '' : 's'} (interior roads switch to drawn-roads-only)
          </label>
          {tracePlan.substations.length > 0 && (
            <div className="text-[10px] text-amber-300/90">
              {tracePlan.substations.length} substation outline{tracePlan.substations.length === 1 ? '' : 's'} recognized — substations are placed through the site areas panel, not auto-filled.
            </div>
          )}
          {tracePlan.unknowns.length > 0 && (
            <div>
              <div className="text-[10px] text-amber-300 mb-1">
                {tracePlan.unknowns.length} shape{tracePlan.unknowns.length === 1 ? '' : 's'} could not be identified by name — tag each one:
              </div>
              <div className="max-h-40 overflow-y-auto flex flex-col gap-1 pr-1">
                {tracePlan.unknowns.map((u, i) => (
                  <div key={i} className="flex items-center justify-between gap-2 text-[10px] text-slate-300">
                    <span className="truncate" title={u.layerName}>
                      {u.layerName || '(unnamed)'} · {Math.round(u.pose.lengthFt)}×{Math.round(u.pose.widthFt)} ft
                    </span>
                    <select
                      value={u.tag}
                      onChange={e => setTraceUnknownTag(i, e.target.value as typeof u.tag)}
                      className="bg-slate-700 text-slate-200 rounded px-1 py-0.5 text-[10px] shrink-0"
                    >
                      {TRACE_TAG_OPTIONS.map(t => (
                        <option key={t} value={t}>{TRACE_KIND_LABELS[t]}</option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
            </div>
          )}
          {tracePlan.missingAux.length > 0 && (
            <div className="text-[10px] text-slate-400">
              Not in the drawing: {tracePlan.missingAux.map(k => TRACE_KIND_LABELS[k]).join(', ')} — place them by hand below after applying.
            </div>
          )}
          {applyProgress && (
            <div className="flex flex-col gap-1">
              <div className="h-1.5 rounded bg-slate-700 overflow-hidden">
                <div
                  className="h-full bg-cyan-500 rounded transition-[width] duration-200 ease-out"
                  style={{ width: `${Math.round(applyProgress.frac * 100)}%` }}
                />
              </div>
              <div className="text-[10px] text-slate-400">{applyProgress.label}…</div>
            </div>
          )}
          <div className="flex gap-1.5">
            <button
              disabled={!!applyProgress}
              onClick={() => {
                void (async () => {
                  setApplyProgress({ frac: 0, label: 'Starting' });
                  setBusyOverlay({ label: 'Applying auto-fill…', frac: 0 });
                  try {
                    const ok = await applyReferenceTraceWithProgress(
                      (frac, label) => {
                        setApplyProgress({ frac, label });
                        setBusyOverlay({ label, frac });
                      },
                      { equipment: inclEquip, roads: inclRoads });
                    if (!ok) toast.error(useDesignStore.getState().lastRejection ?? 'Nothing to apply.');
                    else {
                      const warn = useDesignStore.getState().lastPlacedWarning;
                      if (warn) toast.warning(warn, { duration: 9000 });
                      else toast.success('Design filled in from the reference drawing.');
                    }
                  } finally {
                    setApplyProgress(null);
                    setBusyOverlay(null);
                  }
                })();
              }}
              className="flex-1 text-[11px] py-1.5 rounded bg-cyan-600 hover:bg-cyan-500 disabled:opacity-60 text-white font-medium"
            >
              {applyProgress ? 'Applying…' : 'Apply'}
            </button>
            <button
              onClick={cancelReferenceTrace}
              disabled={!!applyProgress}
              className="flex-1 text-[11px] py-1.5 rounded bg-slate-700 hover:bg-slate-600 disabled:opacity-60 text-slate-200"
            >
              Cancel
            </button>
          </div>
          {lastRejection && <div className="text-[10px] text-red-400">{lastRejection}</div>}
        </div>
      )}
      <div className="mt-2 border-t border-slate-700 pt-2">
        <div className="text-[10px] text-slate-400 mb-1">Place aux gear by hand (click the plan to drop):</div>
        <div className="flex flex-wrap gap-1">
          {(['auxTransformer', 'fireControlPanel', 'auxSwitchPanel', 'commsCabinet'] as const).map(k => (
            <button
              key={k}
              onClick={() => setGearPlacement(gearPlacement?.kind === k ? null : k)}
              className={`text-[10px] px-1.5 py-1 rounded ${gearPlacement?.kind === k ? 'bg-cyan-600 text-white' : 'bg-slate-700 hover:bg-slate-600 text-slate-300'}`}
            >
              {TRACE_KIND_LABELS[k]}
            </button>
          ))}
        </div>
        {gearPlacement && (
          <div className="text-[10px] text-cyan-300 mt-1">Click the plan view to place the {TRACE_KIND_LABELS[gearPlacement.kind].toLowerCase()} · Esc cancels</div>
        )}
      </div>
      <div className="mt-2 border-t border-slate-700 pt-2">
        <div className="text-[10px] text-slate-400 mb-1">Tag drawn shapes by hand (arm a tag, then drag a box over them in the plan):</div>
        <div className="flex flex-wrap gap-1">
          {([
            ['bess', 'BESS'], ['inverter', 'PCS'], ['conex', 'CONEX'], ['generator', 'Generator'],
            ['road', 'Road'], ['wideRoad', 'Wide road'],
          ] as const).map(([k, lbl]) => (
            <button
              key={k}
              onClick={() => setBulkTag(bulkTag === k ? null : k)}
              className={`text-[10px] px-1.5 py-1 rounded ${bulkTag === k ? 'bg-cyan-600 text-white' : 'bg-slate-700 hover:bg-slate-600 text-slate-300'}`}
            >
              {lbl}
            </button>
          ))}
        </div>
        {bulkTag && (
          <div className="text-[10px] text-cyan-300 mt-1">
            Drag a box over the drawn shapes to add them as {bulkTag === 'wideRoad' ? 'a wide road' : bulkTag === 'road' ? 'roads' : TRACE_KIND_LABELS[bulkTag] + 's'} — click the tag again to cancel.
          </div>
        )}
        {(placedEquipment?.length ?? 0) > 0 && (
          <div className="mt-1.5 max-h-32 overflow-y-auto flex flex-col gap-0.5 pr-1">
            {placedEquipment!.map(p => (
              <div key={p.id} className="flex items-center justify-between gap-2 text-[10px] text-slate-300">
                <span className="truncate">
                  {isManualEquipmentSpec(p)
                    ? MANUAL_EQUIPMENT_CATALOG[p.type].short
                    : TRACE_KIND_LABELS[p.kind] ?? p.kind} · ({Math.round(p.x)}, {Math.round(p.y)}) ft{!isManualEquipmentSpec(p) && p.source === 'trace' ? ' · traced' : ''}
                </span>
                <button
                  onClick={() => removePlacedEquipment(p.id)}
                  className="text-red-400 hover:text-red-300 shrink-0"
                  title="Remove this placed equipment"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// Exact-dimensions entry for a grading zone (mirrors the laydown exact-size
// pattern): the field holds a local draft while the drafter types and only
// commits on Enter/blur, so intermediate keystrokes (e.g. "2" on the way to
// "200") never hit setGradingZones' reject→warn→keep validation and never get
// snapped back mid-edit. When a scene drag updates the zone the draft resyncs
// (unless the field is focused), keeping panel and plan view in agreement.
function ZoneDimField({ label, value, step, min, max, onCommit }: {
  label: string;
  value: number;
  step: number;
  min?: number;
  max?: number;
  onCommit: (v: number) => string | null;
}) {
  const [draft, setDraft] = useState(String(value));
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setDraft(String(value));
  }, [value, editing]);
  const commit = () => {
    setEditing(false);
    const v = Number(draft);
    if (draft.trim() === '' || !Number.isFinite(v)) {
      setDraft(String(value));
      return;
    }
    if ((min !== undefined && v < min) || (max !== undefined && v > max)) {
      onCommit(v); // parent reports the range error with clear text
      setDraft(String(value));
      return;
    }
    const err = onCommit(v);
    if (err) setDraft(String(value));
  };
  return (
    <label className="block text-[9px] text-slate-500">
      {label} (ft)
      <input
        type="number" step={step} min={min} max={max}
        value={draft}
        onFocus={() => setEditing(true)}
        onChange={e => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={e => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') { setDraft(String(value)); setEditing(false); (e.target as HTMLInputElement).blur(); }
        }}
        className="w-full mt-0.5 bg-slate-900 border border-slate-600 rounded px-1 py-0.5 text-[10px] text-slate-100"
      />
    </label>
  );
}

// Drainage number field with sanitizer-true clamping. min/max come straight
// from DRAINAGE_NUM_LIMITS (the exact ranges sanitizeDrainageInputs enforces
// on export), so the displayed value can never silently differ from what
// exports: typing an out-of-range value shows an immediate red border + range
// note, and blur/Enter clamps it into range with a visible "adjusted" note.
function DrainageNumField({ field, label, title, step, compact = false }: {
  field: DrainageNumericKey;
  label: string;
  title: string;
  step: number;
  compact?: boolean;
}) {
  const value = useDesignStore(s => s.drainageInputs[field]);
  const setDrainageInputs = useDesignStore(s => s.setDrainageInputs);
  const { min, max } = DRAINAGE_NUM_LIMITS[field];
  const [draft, setDraft] = useState(String(value));
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const cancelledRef = useRef(false);
  useEffect(() => {
    if (!editing) setDraft(String(value));
  }, [value, editing]);
  const parsed = Number(draft);
  const outOfRange = editing && draft.trim() !== '' && Number.isFinite(parsed) && (parsed < min || parsed > max);
  const commit = () => {
    setEditing(false);
    if (cancelledRef.current) {
      cancelledRef.current = false;
      setDraft(String(value));
      setNote(null);
      return;
    }
    const v = Number(draft);
    if (draft.trim() === '' || !Number.isFinite(v)) {
      setDraft(String(value));
      setNote(null);
      return;
    }
    const clamped = Math.min(max, Math.max(min, v));
    setDrainageInputs({ [field]: clamped } as Partial<DrainageInputs>);
    setDraft(String(clamped));
    setNote(clamped !== v ? `Adjusted to ${clamped} (allowed ${min}\u2013${max})` : null);
  };
  return (
    <label className={compact ? 'block text-[10px] text-slate-400' : 'block text-xs text-slate-400'} title={title}>
      {label}
      <input
        type="number" min={min} max={max} step={step}
        value={draft}
        onFocus={() => { setEditing(true); setNote(null); }}
        onChange={e => {
          setDraft(e.target.value);
          setNote(null);
          const v = Number(e.target.value);
          if (e.target.value.trim() !== '' && Number.isFinite(v) && v >= min && v <= max) {
            setDrainageInputs({ [field]: v } as Partial<DrainageInputs>);
          }
        }}
        onBlur={commit}
        onKeyDown={e => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') { cancelledRef.current = true; setDraft(String(value)); setEditing(false); setNote(null); (e.target as HTMLInputElement).blur(); }
        }}
        className={`w-full mt-1 bg-slate-900 border rounded text-xs text-slate-100 ${compact ? 'px-1.5 py-1' : 'px-2 py-1'} ${outOfRange ? 'border-red-500' : 'border-slate-600'}`}
      />
      {outOfRange && (
        <span className="block mt-0.5 text-[10px] text-red-400">Allowed {min}&ndash;{max} &mdash; will clamp</span>
      )}
      {!outOfRange && note && (
        <span className="block mt-0.5 text-[10px] text-amber-400">{note}</span>
      )}
    </label>
  );
}

// Generic study number field with sanitizer-true clamping — the same pattern
// as DrainageNumField but for the study inputs whose values live in different
// stores (IEEE-80 grounding, short-circuit, protection, energy sim). min/max
// must come straight from the study's *_NUM_LIMITS table (the exact ranges its
// sanitizer enforces), so a typed value can never silently differ from what
// the study math / export uses: typing an out-of-range value shows an
// immediate red border + range note, and blur/Enter clamps it into range with
// a visible "adjusted" note. `nullable` fields (e.g. optional gear rating)
// treat blank as null instead of reverting. `integer` fields mirror
// sanitizers that round after clamping (e.g. projectLifeYears): a typed
// decimal is rounded on commit and the "Adjusted to" note surfaces it, so the
// displayed value never silently differs from what the sanitizer exports.
// `displayDecimals` fields are entered in display units that convert to a
// different stored unit (IEEE-80 inches/ft → metric): the value prop is
// rounded to that many decimals when derived from the stored metric number,
// so commit rounds the typed value to the same precision (and surfaces the
// rounding) — otherwise the metric round-trip would silently redisplay a
// different number than what was typed. Pair with displayBounds(lim,
// perUnit, displayDecimals) so the rounded value can never leave the
// sanitizer's range.
function StudyNumField({ label, title, step, min, max, value, onCommit, nullable = false, integer = false, displayDecimals, placeholder, className = '', unit }: {
  label: string;
  title: string;
  step: number;
  min: number;
  max: number;
  value: number | null;
  onCommit: (v: number | null) => void;
  nullable?: boolean;
  integer?: boolean;
  displayDecimals?: number;
  placeholder?: string;
  className?: string;
  unit?: string;
}) {
  const unitSuffix = unit ? ` ${unit}` : '';
  const display = value === null ? '' : String(value);
  const [draft, setDraft] = useState(display);
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const cancelledRef = useRef(false);
  useEffect(() => {
    if (!editing) setDraft(display);
  }, [display, editing]);
  const parsed = Number(draft);
  const outOfRange = editing && draft.trim() !== '' && Number.isFinite(parsed) && (parsed < min || parsed > max);
  const commit = () => {
    setEditing(false);
    if (cancelledRef.current) {
      cancelledRef.current = false;
      setDraft(display);
      setNote(null);
      return;
    }
    if (draft.trim() === '') {
      if (nullable) {
        onCommit(null);
        setDraft('');
      } else {
        setDraft(display);
      }
      setNote(null);
      return;
    }
    const v = Number(draft);
    if (!Number.isFinite(v)) {
      setDraft(display);
      setNote(null);
      return;
    }
    const clamped = Math.min(max, Math.max(min, v));
    const final = integer ? Math.round(clamped)
      : displayDecimals !== undefined ? roundToDecimals(clamped, displayDecimals)
      : clamped;
    onCommit(final);
    setDraft(String(final));
    if (final !== v) {
      setNote(clamped !== v && final === clamped
        ? `Adjusted to ${final}${unitSuffix} (allowed ${min}\u2013${max}${unitSuffix})`
        : integer
        ? `Adjusted to ${final}${unitSuffix} (whole ${label.toLowerCase().includes('yr') ? 'years' : 'number'}${clamped !== v ? `, allowed ${min}\u2013${max}${unitSuffix}` : ''})`
        : `Adjusted to ${final}${unitSuffix} (nearest ${displayDecimals === 0 ? '1' : String(10 ** -(displayDecimals ?? 0))}${clamped !== v ? `, allowed ${min}\u2013${max}${unitSuffix}` : ''})`);
    } else {
      setNote(null);
    }
  };
  return (
    <label className={`text-[10px] text-slate-400 ${className}`} title={title}>
      {label}
      <input
        type="number" min={min} max={max} step={step}
        value={draft}
        placeholder={placeholder}
        onFocus={() => { setEditing(true); setNote(null); }}
        onChange={e => {
          setDraft(e.target.value);
          setNote(null);
          const v = Number(e.target.value);
          if (e.target.value.trim() !== '' && Number.isFinite(v) && v >= min && v <= max &&
              (!integer || Number.isInteger(v)) &&
              (displayDecimals === undefined || roundToDecimals(v, displayDecimals) === v)) {
            onCommit(v);
          }
        }}
        onBlur={commit}
        onKeyDown={e => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') { cancelledRef.current = true; setDraft(display); setEditing(false); setNote(null); (e.target as HTMLInputElement).blur(); }
        }}
        className={`w-full mt-0.5 bg-slate-900 border rounded px-1.5 py-1 text-xs text-slate-100 font-mono ${outOfRange ? 'border-red-500' : 'border-slate-600'}`}
      />
      {outOfRange && (
        <span className="block mt-0.5 text-[10px] text-red-400">Allowed {min}&ndash;{max}{unitSuffix} &mdash; will clamp</span>
      )}
      {!outOfRange && note && (
        <span className="block mt-0.5 text-[10px] text-amber-400">{note}</span>
      )}
    </label>
  );
}

function roundToDecimals(x: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(x * f) / f;
}

// Display-unit bounds for study fields entered in different units than the
// model stores (IEEE-80 metric fields shown in inches/feet). Min rounds up
// and max rounds down (default 2 decimals) so a clamped display value
// converted back is always inside the model's sanitizer range. Pass the
// field's displayDecimals so the bounds land on the display precision grid —
// then clamp-then-round can never step outside the sanitizer range.
function displayBounds(lim: { min: number; max: number }, perUnit: number, decimals = 2): { min: number; max: number } {
  const f = 10 ** decimals;
  return {
    min: Math.ceil((lim.min / perUnit) * f) / f,
    max: Math.floor((lim.max / perUnit) * f) / f,
  };
}

// Collapsible discipline section for the control panel. Collapse state is a
// per-browser preference only (localStorage, one JSON map keyed by section
// id) — never project data, so shared project files are unaffected. Children
// stay mounted (hidden via CSS) so collapsing never changes behavior, only
// what is visible.
const PANEL_OPEN_KEY = 'nextera-panel-open';
function PanelSection({ id, title, discipline, children }: {
  id: string;
  title: string;
  discipline: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState<boolean>(() => {
    try {
      const raw = localStorage.getItem(PANEL_OPEN_KEY);
      if (raw) {
        const map = JSON.parse(raw);
        if (map && typeof map[id] === 'boolean') return map[id];
      }
    } catch {
      // storage unavailable / corrupt — default open
    }
    return true;
  });
  const toggle = () => {
    const next = !open;
    setOpen(next);
    try {
      const raw = localStorage.getItem(PANEL_OPEN_KEY);
      const map = raw ? (JSON.parse(raw) ?? {}) : {};
      map[id] = next;
      localStorage.setItem(PANEL_OPEN_KEY, JSON.stringify(map));
    } catch {
      // storage unavailable; preference just won't persist
    }
  };
  return (
    <section>
      <button
        type="button"
        onClick={toggle}
        className="w-full flex items-center justify-between gap-2 mb-2 text-left group"
        title={open ? 'Collapse section' : 'Expand section'}
      >
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400 group-hover:text-slate-200">
          {title}
        </h3>
        <span className="flex items-center gap-1.5 shrink-0">
          <span className="text-[9px] font-semibold uppercase tracking-wide text-slate-500 border border-slate-700 rounded px-1 py-px">
            {discipline}
          </span>
          <span className="text-slate-500 text-[10px]">{open ? '▾' : '▸'}</span>
        </span>
      </button>
      <div className={open ? undefined : 'hidden'}>{children}</div>
    </section>
  );
}

function OfflineDataPanel({ boundary }: {
  boundary: { origin: { lat: number; lon: number }; polygon: Array<{ x: number; y: number }> } | null;
}) {
  const [override, setOverride] = useState(() => getSavedApiBaseOverride());
  const [resolved, setResolved] = useState(() => {
    try { return resolveApiBase(); } catch (e) { return e instanceof Error ? e.message : String(e); }
  });
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<ApiResponseMeta | null>(null);
  const packRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onStatus = (event: Event) => setStatus((event as CustomEvent<ApiResponseMeta>).detail);
    window.addEventListener(API_STATUS_EVENT, onStatus);
    return () => window.removeEventListener(API_STATUS_EVENT, onStatus);
  }, []);
  const site = boundary ? {
    ...boundary.origin,
    satelliteBbox: satelliteCoverageBbox(boundary.polygon, boundary.origin),
    terrainBbox: terrainCoverageBbox(boundary.polygon, boundary.origin),
  } : null;
  const run = async (work: () => Promise<void>, success: string) => {
    setBusy(true);
    try { await work(); toast.success(success); }
    catch (e) { toast.error(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  return (
    <section className="mt-3 bg-slate-800 rounded p-3">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-300">API &amp; Offline Data</h3>
      <div className="text-[10px] text-slate-500 mt-1 truncate" title={resolved || 'Same-origin web API'}>
        Using {resolved || 'same-origin web API'}
      </div>
      <div className="text-[10px] text-slate-500 mt-1">
        A saved override takes priority. Clear it to restore desktop/runtime configuration or web same-origin.
      </div>
      <div className="flex gap-1.5 mt-2">
        <input
          value={override}
          onChange={e => setOverride(e.target.value)}
          placeholder="HTTPS API origin (optional)"
          aria-label="API base override"
          className="min-w-0 flex-1 bg-slate-900 border border-slate-600 rounded px-2 py-1 text-[10px] text-slate-100"
        />
        <button
          type="button"
          disabled={!override.trim()}
          onClick={() => {
            try {
              const next = saveApiBaseOverride(override);
              setOverride(getSavedApiBaseOverride());
              setResolved(next);
              toast.success('API override applied to subsequent requests.');
            }
            catch (e) { toast.error(e instanceof Error ? e.message : String(e)); }
          }}
          className="px-2 py-1 rounded bg-slate-700 hover:bg-slate-600 disabled:opacity-40 text-[10px]"
        >Apply</button>
        <button
          type="button"
          onClick={() => {
            try {
              setOverride('');
              setResolved(saveApiBaseOverride(''));
              toast.success('API override cleared; runtime/default restored.');
            }
            catch (e) { toast.error(e instanceof Error ? e.message : String(e)); }
          }}
          className="px-2 py-1 rounded bg-slate-700 hover:bg-slate-600 text-[10px]"
        >Clear</button>
      </div>
      {status && (
        <div className={`text-[10px] mt-1.5 ${status.offline ? 'text-amber-300' : 'text-emerald-300'}`}>
          {status.source === 'network' ? 'Online' : status.stale ? 'Offline · stale cache' : 'Offline · cached'} · {status.provenance}
        </div>
      )}
      <div className="grid grid-cols-3 gap-1.5 mt-2">
        <button disabled={!site || busy} onClick={() => site && run(() => prefetchSiteData(site), 'Site data cached for offline use.')}
          className="py-1.5 rounded bg-cyan-800 hover:bg-cyan-700 disabled:opacity-40 text-[10px]">Prefetch</button>
        <button disabled={!site || busy} onClick={() => site && run(async () => {
          const blob = await exportSitePack(site);
          await saveBlob(blob, `bessforge-site-${site.lat.toFixed(5)}-${site.lon.toFixed(5)}.zip`);
        }, 'Site pack exported.')}
          className="py-1.5 rounded bg-slate-700 hover:bg-slate-600 disabled:opacity-40 text-[10px]">Export pack</button>
        <button disabled={busy} onClick={() => packRef.current?.click()}
          className="py-1.5 rounded bg-slate-700 hover:bg-slate-600 disabled:opacity-40 text-[10px]">Import pack</button>
      </div>
      <input ref={packRef} type="file" accept=".zip,application/zip" className="hidden" onChange={e => {
        const file = e.target.files?.[0];
        e.target.value = '';
        if (file) void run(async () => { const r = await importSitePack(file); toast.info(`${r.imported} verified cache entries imported.`); }, 'Site pack ready.');
      }} />
    </section>
  );
}

export default function DesignControlPanel() {
  const fileRef = useRef<HTMLInputElement>(null);
  // Area being switched TO while the (synchronous) rebuild runs, so the site
  // areas list can show a busy state instead of appearing frozen.
  const [switchingAreaId, setSwitchingAreaId] = useState<string | null>(null);
  const {
    boundary, boundaryPicker, chooseBoundary, chooseAllBoundariesWithProgress, siteAreas, activeAreaId, setActiveArea, cancelBoundaryPicker, design, areaZones, configId, targetMW, targetMWh, hotClimate, containersPerPcs, roadMode, autoRoadWrap, ringMode, perimeterBand, fencePlacement, laydownPct, augmentPct, futurePhaseUnits, surfacingMode, surfacingDepthIn, deadSpaceTrim, dcRouting, textureSetId, gePcsColor, showGateModel, showFence3D, showFeederColors, showSatellite, satelliteStatus, satelliteError, terrain, terrainStatus, terrainError, showTerrain, labelDistanceScaling, showSlopeHeatmap, maxGradePct, showContours, contourIntervalFt, showGradingLimits, gradingSlopeRatio, exportContoursDxf, exportCutFillShading, showGrounding, groundingXray, groundingRodSpacingFt, exportGroundingDxf, exportTrenchSectionsDxf, exportSurfacingMesh, titleBlock, lgiaInputs, isLoading, busyOverlay, setBusyOverlay, error,
    loadKmz, loadSample, setConfigId, setTargetMW, setTargetMWh, setHotClimate, setContainersPerPcs, setRoadMode, setAutoRoadWrap, setRingMode, setPerimeterBand, setFencePlacement, setLaydownPct, setAugmentPct, setFuturePhaseUnits, setIslandAugUnits, setIslandAugEnd, adjustIslandBlocks, setSurfacingMode, setSurfacingDepthIn, setDeadSpaceTrim, setDcRouting, setTextureSetId, setGePcsColor, setShowGateModel, setShowFence3D, setShowFeederColors, setShowSatellite, loadSatellite, setShowTerrain, setLabelDistanceScaling, setShowSlopeHeatmap, setMaxGradePct, setShowContours, setContourIntervalFt, setShowGradingLimits, setGradingSlopeRatio, setExportContoursDxf, setExportCutFillShading, setShowGrounding, setGroundingXray, setGroundingRodSpacingFt, setExportGroundingDxf, setExportTrenchSectionsDxf, setExportSurfacingMesh, requestInspectTrench, requestOverview, setTitleBlock, setLgiaInputs, clearSite,
    eciLegend, setEciLegend,
    substation, placingSubstation, feeders, feederAssignments, feederMaterial,
    setPlacingSubstation, removeSubstation, setFeederSize, setFeederMaterial, assignInverterToFeeder, resetFeederOverrides, resetFeederSizes, removeFeederRoute,
    takeoffs, placingTakeoffId, setPlacingTakeoff, addTakeoff, aimTakeoff, setTakeoffServes, removeTakeoff,
    areaFeeders, feederEndpoint,
    maxVdPct, capacityFactorPct, setMaxVdPct, setCapacityFactorPct,
    layoutEdits, moveRow, moveBlock, moveEquipment, setTrenchPin, setLaydownPin, setFutureAugPin, setBlockDcRouting, setAlignIslands, resetLayoutEdits,
    arrangement, setArrangement, applyOptimizedLayout,
    undoStack, redoStack, undoEdit, redoEdit, jumpHistory,
    savedSession, restoreSession, dismissSavedSession, exportProjectJson, importProject,
  } = useDesignStore();
  const projectFileRef = useRef<HTMLInputElement>(null);

  // Yard-frame elevation grid: when a grading-optimized rotation is applied
  // the design lives in a rotated working frame, so every terrain consumer
  // (cut/fill, slope, contours, tie-in) reads a grid resampled into that
  // frame. At 0° this is the exact same grid object — zero-cost identity.
  // [662] Text-label overrides — threaded to every DXF/PDF export path so the
  // drafter's repositioned labels appear in every deliverable. Absent when no
  // overrides have been set (default: empty map, byte-identical output).
  const textOverrides = useDesignStore(s => s.textOverrides);
  const drawingVisibility = useDesignStore(s => s.drawingVisibility);
  // Whole-site rollup across every area (capacity, blocks, equipment, acres)
  // plus the per-area breakdown, from ONE computation so the site figure and
  // the per-area lines can never disagree. Null on a single-area project —
  // the site card is multi-area only, so existing output is untouched.
  // Feeder coverage rides along with the capacity rollup: the card reports
  // "designed to target" and "actually routed to a substation" from ONE
  // computation, so a fully packed area with no feeders cannot read as done.
  const areaFeederCounts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const [id, f] of Object.entries(areaFeeders)) out[id] = f.length;
    return out;
  }, [areaFeeders]);
  const siteTotals = useMemo(
    () => (siteAreas.length > 1 ? siteAreasTotals(siteAreas, areaFeederCounts) : null),
    [siteAreas, areaFeederCounts]
  );
  // Areas whose yard came out with no interior roads. The layout engine can
  // silently fall back to a compact, road-free layout when the target does
  // not fit with roads — in a multi-area site that can happen to an area the
  // drafter is not looking at, so the roads appear to vanish for no reason.
  const roadlessAreas = useMemo(
    () => (siteAreas.length > 1 ? areasMissingRoads(siteAreas) : []),
    [siteAreas]
  );
  const roadCapacityShortfallAreas = useMemo(
    () => (siteAreas.length > 1 ? areasWithAccessRoadShortfalls(siteAreas) : []),
    [siteAreas]
  );
  // Substation take-off editing targets the ACTIVE area. Its live take-offs
  // are the mirrored ones when the drafter has edited them, otherwise the
  // automatic ones derived from the yard's collector positions.
  const activeArea = useMemo(
    () => siteAreas.find(a => a.id === activeAreaId) ?? null,
    [siteAreas, activeAreaId]
  );
  const activeTakeoffs = useMemo(() => {
    if (!activeArea || activeArea.kind !== 'substation') return [];
    if (takeoffs) return takeoffs;
    // The mirrored design carries in-flight edits the parked copy lacks.
    return effectiveTakeoffs(
      { ...activeArea, design: design ?? activeArea.design },
      siteAreas.filter(a => a.kind === 'bess')
    );
  }, [activeArea, takeoffs, design, siteAreas]);
  const bessAreaOptions = useMemo(
    () => siteAreas.filter(a => a.kind === 'bess'),
    [siteAreas]
  );
  const kmzFenceStandard = isTracedBessYard(layoutEdits);

  // Which footprints the DXF / PDF exports cover. null = the ENTIRE site (the
  // default: a multi-area project is one project, and exporting only the yard
  // that happens to be active produced deliverables that silently omitted the
  // rest of the site). A subset lets the drafter issue one area, or any
  // combination (e.g. two BESS areas plus the substation collecting them).
  const [exportAreaIds, setExportAreaIds] = useState<string[] | null>(null);
  // Areas can be replaced wholesale by a new import; a stale selection would
  // otherwise silently narrow (or reset) what ships.
  useEffect(() => {
    setExportAreaIds(prev => {
      if (!prev) return prev;
      const kept = prev.filter(id => siteAreas.some(a => a.id === id));
      return kept.length === prev.length ? prev : (kept.length ? kept : null);
    });
  }, [siteAreas]);
  // Whole-site export inputs, shared by the DXF and PDF paths so the two can
  // never disagree about what a given selection contains. Null on single-area
  // projects, which keeps every export on the untouched legacy path.
  const siteExportInput = useMemo<SiteComposeInput | null>(() => {
    if (siteAreas.length < 2) return null;
    return {
      areas: siteAreas,
      activeAreaId,
      areaFeeders,
      selectedAreaIds: exportAreaIds,
    };
  }, [siteAreas, activeAreaId, areaFeeders, exportAreaIds]);
  const exportScopeLabel = useMemo(
    () => (siteAreas.length > 1 ? selectionLabel(siteAreas, exportAreaIds) : ''),
    [siteAreas, exportAreaIds]
  );
  // Filename fragment identifying a partial export, so a one-area or
  // two-area issue is never mistaken for the whole site on disk. Empty for
  // single-area projects and for whole-site exports, keeping legacy filenames.
  const exportFileTag = useCallback((): string => {
    if (siteAreas.length < 2 || !exportAreaIds) return '';
    const picked = selectedSiteAreas(siteAreas, exportAreaIds);
    if (picked.length === siteAreas.length) return '';
    const frag = picked.length === 1
      ? picked[0].name
      : `${picked.length}_areas`;
    return `_${frag.replace(/[^A-Za-z0-9_-]+/g, '_')}`;
  }, [siteAreas, exportAreaIds]);
  const yardRotationDeg = useDesignStore(s => s.yardRotationDeg);
  const setYardRotation = useDesignStore(s => s.setYardRotation);
  const terrainYard = useMemo(() => {
    if (!terrain || !boundary || yardRotationDeg === 0) return terrain;
    return resampleGridForYardRotation(terrain, boundary.origin, yardRotationDeg, polygonPivot(boundary.polygon));
  }, [terrain, boundary, yardRotationDeg]);

  // Terrain screening (elevation grid -> slope + cut/fill + steep zones).
  // Pure derived data, recomputed only when the grid, fence or threshold
  // changes. Null when no elevation data is loaded.
  const terrainAnalysis = useMemo((): { cutFill: CutFillEstimate | null; steep: SteepZoneReport | null } => {
    if (!terrainYard || !design || design.fence.length < 3) return { cutFill: null, steep: null };
    const rect = terrainLocalRect(terrainYard, design.boundary.origin);
    const cutFill = computeCutFill(terrainYard, rect, design.fence);
    const slope = computeSlopeGrid(terrainYard, rect);
    const steep = findSteepZones(slope, rect, {
      equipment: design.equipment,
      roads: design.roads,
      aisles: design.aisles,
    }, maxGradePct);
    return { cutFill, steep };
  }, [terrainYard, design, maxGradePct]);

  // Voltage drop & I²R losses screening report — pure derived data from the
  // routed feeders and the drafter's limit/capacity-factor preferences.
  // Null when no substation/feeders exist (the card and check don't appear).
  const electricalReport = useMemo(() => {
    if (!feeders.length) return null;
    return buildFeederElectricalReport(feeders, { maxVdPct, capacityFactorPct });
  }, [feeders, maxVdPct, capacityFactorPct]);

  // Grounding screening plan (loop / rods / taps) — pure derived data from
  // the design. Computed when the preview or the DXF option is on; the
  // summary card is screening-only, never an IEEE-80 study.
  const ieee80Enabled = useDesignStore(s => s.ieee80Enabled);
  const ieee80Inputs = useDesignStore(s => s.ieee80Inputs);
  const setIeee80Enabled = useDesignStore(s => s.setIeee80Enabled);
  const setIeee80Inputs = useDesignStore(s => s.setIeee80Inputs);
  const groundingPlan = useMemo(() => {
    if (!design || (!showGrounding && !exportGroundingDxf && !ieee80Enabled)) return null;
    return buildGroundingPlan(design, { rodSpacingFt: groundingRodSpacingFt });
  }, [design, showGrounding, exportGroundingDxf, ieee80Enabled, groundingRodSpacingFt]);

  // IEEE-80 grid study — pure derived data from the grounding plan geometry
  // + the engineer's persisted inputs. Null when the study toggle is off or
  // the loop could not be inset (the card and packet section don't appear).
  const ieee80Study = useMemo(() => {
    if (!ieee80Enabled || !groundingPlan) return null;
    return buildIeee80StudyFromPlan(groundingPlan, ieee80Inputs);
  }, [ieee80Enabled, groundingPlan, ieee80Inputs]);

  // Per-bus short-circuit study ("ETAP-lite") — pure derived data from the
  // routed feeders + the engineer's persisted source/contribution inputs.
  // Null while the toggle is off or no feeders are routed; when present it
  // is also passed into the POI data sheet export as its own section.
  const scEnabled = useDesignStore(s => s.scEnabled);
  const scInputs = useDesignStore(s => s.scInputs);
  const setScEnabled = useDesignStore(s => s.setScEnabled);
  const setScInputs = useDesignStore(s => s.setScInputs);

  // Proposed grading surface (sloped pads / benches / balanced earthwork):
  // pure derived data from the elevation grid + persisted inputs. Null while
  // the toggle is off. Preview + summary only — never touches exports.
  const gradingEnabled = useDesignStore(s => s.gradingEnabled);
  const gradingInputs = useDesignStore(s => s.gradingInputs);
  const setGradingEnabled = useDesignStore(s => s.setGradingEnabled);
  const setGradingInputs = useDesignStore(s => s.setGradingInputs);
  const showProposedContours = useDesignStore(s => s.showProposedContours);
  const setShowProposedContours = useDesignStore(s => s.setShowProposedContours);
  // Earthwork cost estimate (screening BoQ): per-browser unit rates + the
  // opt-in "cost on GP-1" toggle. Pure derived data from the FG earthwork.
  const earthworkRates = useDesignStore(s => s.earthworkRates);
  const setEarthworkRates = useDesignStore(s => s.setEarthworkRates);
  const exportCostEstimate = useDesignStore(s => s.exportCostEstimate);
  const setExportCostEstimate = useDesignStore(s => s.setExportCostEstimate);
  const exportSections = useDesignStore(s => s.exportSections);
  const setExportSections = useDesignStore(s => s.setExportSections);
  const gradingZones = useDesignStore(s => s.gradingZones);
  const setGradingZones = useDesignStore(s => s.setGradingZones);
  // Last zone rejection reason (reject→warn→keep): null once a set is accepted.
  const [zoneError, setZoneError] = useState<string | null>(null);
  const showCutFillPreview = useDesignStore(s => s.showCutFillPreview);
  const setShowCutFillPreview = useDesignStore(s => s.setShowCutFillPreview);
  const fgSurface = useMemo(() => {
    if (!gradingEnabled || !terrainYard || !design || design.fence.length < 3) return null;
    const rect = terrainLocalRect(terrainYard, design.boundary.origin);
    return buildFgSurface(terrainYard, rect, design.fence, gradingInputs, undefined, gradingZones);
  }, [gradingEnabled, gradingInputs, gradingZones, terrainYard, design]);
  // Drainage screening on the FG surface (D8 flow, ponding, swales,
  // rational-method discharge hydrology). Requires the grading surface;
  // pure derived data — never touches exports.
  const drainageEnabled = useDesignStore(s => s.drainageEnabled);
  const drainageInputs = useDesignStore(s => s.drainageInputs);
  const setDrainageEnabled = useDesignStore(s => s.setDrainageEnabled);
  const setDrainageInputs = useDesignStore(s => s.setDrainageInputs);
  const drainageIdf = useDesignStore(s => s.drainageIdf);
  const setDrainageIdf = useDesignStore(s => s.setDrainageIdf);
  const [idfBusy, setIdfBusy] = useState(false);
  const drainageModel = useMemo(() => {
    if (!drainageEnabled || !fgSurface || !terrainYard || !design) return null;
    const rect = terrainLocalRect(terrainYard, design.boundary.origin);
    return buildDrainageModel(terrainYard, rect, fgSurface, drainageInputs, undefined, {
      idf: drainageIdf,
      surfaces: drainageSurfacesFromDesign(design),
    });
  }, [drainageEnabled, drainageInputs, drainageIdf, fgSurface, terrainYard, design]);
  const handleFetchIdf = async () => {
    if (!design) return;
    setIdfBusy(true);
    try {
      const { lat, lon } = design.boundary.origin;
      const idf = await fetchNoaaIdf(lat, lon);
      setDrainageIdf(idf);
      toast.success(`NOAA Atlas 14 IDF loaded (${idf.source})`);
    } catch (e: any) {
      toast.error(`NOAA Atlas 14 fetch failed: ${e?.message ?? 'unknown error'}`);
    } finally {
      setIdfBusy(false);
    }
  };
  // Screening-level earthwork cost (BoQ): pure function of the FG earthwork
  // quantities and the sanitized per-browser unit rates.
  const earthworkCost = useMemo(() => {
    if (!fgSurface) return null;
    return computeEarthworkCost(fgSurface.earthwork, earthworkRates);
  }, [fgSurface, earthworkRates]);
  const scStudy = useMemo(() => {
    if (!scEnabled || !feeders.length || !design) return null;
    const cfg = getEffectiveConfiguration(configId, containersPerPcs);
    const inverterCount = design.equipment.filter(e => e.kind === 'inverter').length;
    return buildShortCircuitStudy(
      feeders, inverterCount, inverterAmps(cfg.blockMW), scInputs,
      { hasAux: cfg.hasAuxEquipment }
    );
  }, [scEnabled, feeders, design, configId, containersPerPcs, scInputs]);

  // Protection / arc-flash study ("SKM-lite") — built directly on the SC
  // study's buses so the two can never disagree. Null while its toggle is
  // off or while the SC study itself is unavailable.
  const protectionEnabled = useDesignStore(s => s.protectionEnabled);
  const protectionInputs = useDesignStore(s => s.protectionInputs);
  const setProtectionEnabled = useDesignStore(s => s.setProtectionEnabled);
  const setProtectionInputs = useDesignStore(s => s.setProtectionInputs);
  const protectionStudy = useMemo(() => {
    if (!protectionEnabled || !scStudy || !feeders.length) return null;
    return buildProtectionStudy(scStudy, feeders, protectionInputs);
  }, [protectionEnabled, scStudy, feeders, protectionInputs]);

  // Energy/dispatch simulation — pure derived data from the placed layout,
  // the routed feeders' I²R losses and the engineer's project-data inputs.
  // Null while the toggle is off or nothing is placed.
  const energySimEnabled = useDesignStore(s => s.energySimEnabled);
  const energySimInputs = useDesignStore(s => s.energySimInputs);
  const setEnergySimEnabled = useDesignStore(s => s.setEnergySimEnabled);
  const setEnergySimInputs = useDesignStore(s => s.setEnergySimInputs);
  const energySim = useMemo(() => {
    if (!energySimEnabled || !design || design.blocksPlaced <= 0) return null;
    const cfg = getEffectiveConfiguration(configId, containersPerPcs);
    const containers = design.blocksPlaced * cfg.containersPerBlock;
    // One-way MV collection loss fraction at rated power from the routed
    // feeders; screening default when no substation/feeders exist yet.
    const cableLossFrac = electricalReport && design.achievedMW > 0
      ? Math.min(0.05, electricalReport.totalPeakLossKW / (design.achievedMW * 1000))
      : DEFAULT_CABLE_LOSS_FRAC;
    return buildEnergySim({
      bolMWh: design.achievedMWh,
      containers,
      containerMWh: cfg.containerMWh,
      containersPerBlock: cfg.containersPerBlock,
      augZoneBlocks: design.reserveSummary?.augBlocksPlaced ?? 0,
      cableLossFrac,
    }, energySimInputs);
  }, [energySimEnabled, design, configId, containersPerPcs, electricalReport, energySimInputs]);

  // Regeneration (target/config/boundary change) can silently clear manual
  // feeder groupings when the inverter set changes — surface that as the same
  // kind of warning the feeder-cap knob shows.
  const feederResetNotice = useDesignStore(s => s.feederResetNotice);
  useEffect(() => {
    if (feederResetNotice) {
      toast.warning(feederResetNotice);
      useDesignStore.getState().clearFeederResetNotice();
    }
  }, [feederResetNotice]);

  // Opening a project/autosave whose saved grading zones fail fence
  // validation silently drops them (regenerate's apply()); surface that as a
  // one-time warning so the drafter knows why their zones vanished.
  const gradingZonesResetNotice = useDesignStore(s => s.gradingZonesResetNotice);
  useEffect(() => {
    if (gradingZonesResetNotice) {
      toast.warning(gradingZonesResetNotice);
      useDesignStore.getState().clearGradingZonesResetNotice();
    }
  }, [gradingZonesResetNotice]);

  // Auto-resolve the Title Block location from the site coordinates when the
  // field is blank or holds raw lat/long text (typed place names always win).
  // Resolution happens HERE at edit time — never inside an export handler —
  // so exports stay deterministic and offline: they consume the stored text.
  // Failures are surfaced and leave the field exactly as typed.
  const geocodeTriedRef = useRef('');
  useEffect(() => {
    if (!boundary) return;
    const typed = titleBlock.location.trim();
    if (typed && !isCoordinateLocation(typed)) return;
    const originKey = `${boundary.origin.lat.toFixed(6)},${boundary.origin.lon.toFixed(6)}`;
    const key = `${originKey}|${typed}`;
    if (geocodeTriedRef.current === key) return;
    geocodeTriedRef.current = key;
    (async () => {
      try {
        const line = await fetchGeocodedLocation(boundary.origin.lat, boundary.origin.lon);
        // Re-check BOTH the boundary and the field: the drafter may have
        // loaded a different site or typed a real location mid-fetch — a
        // stale response must never write another site's county/state.
        const st = useDesignStore.getState();
        const curOrigin = st.boundary
          ? `${st.boundary.origin.lat.toFixed(6)},${st.boundary.origin.lon.toFixed(6)}` : '';
        if (curOrigin !== originKey) return;
        const cur = st.titleBlock.location.trim();
        if (cur !== typed || line === cur) return;
        setTitleBlock({ location: line });
        toast.success(`Title Block location set from site coordinates: ${line} — edit to override`);
      } catch (e: any) {
        toast.warning(`Couldn't resolve county/state from coordinates: ${e?.message ?? 'lookup failed'} — Location left as typed`);
      }
    })();
  }, [boundary, titleBlock.location]);

  // Ctrl/Cmd+Z = undo, Ctrl/Cmd+Y or Ctrl/Cmd+Shift+Z = redo (layout edits)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (!(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) {
        e.preventDefault();
        if (useDesignStore.getState().undoEdit()) toast.success('Undo');
      } else if (k === 'y' || (k === 'z' && e.shiftKey)) {
        e.preventDefault();
        if (useDesignStore.getState().redoEdit()) toast.success('Redo');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const [editRow, setEditRow] = useState(1);
  const [dcBlockN, setDcBlockN] = useState(1);
  const [editDx, setEditDx] = useState('0');
  const [editDy, setEditDy] = useState('0');
  const [trenchInput, setTrenchInput] = useState('');
  const [confirmReset, setConfirmReset] = useState(false);
  const [confirmRemoveAll, setConfirmRemoveAll] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [showArrangements, setShowArrangements] = useState(false);
  const [showEarthworkFigure, setShowEarthworkFigure] = useState(false);
  const [pendingArrangement, setPendingArrangement] = useState<ArrangementStrategy | null>(null);

  // Layout optimizer (bounded seeded search over pristine layouts)
  const [optRunning, setOptRunning] = useState(false);
  const [optProgress, setOptProgress] = useState<{ done: number; total: number } | null>(null);
  const [optResult, setOptResult] = useState<OptimizeResult | null>(null);
  const optCancelRef = useRef(false);

  // Feeder-routing optimizer (how the MV bundle leaves the substation).
  // Separate from the layout optimizer above: it re-routes the EXISTING yard
  // instead of regenerating placements, so it has its own button and channel.
  const [frRunning, setFrRunning] = useState(false);
  const [frProgress, setFrProgress] = useState<{ done: number; total: number } | null>(null);
  const [frResult, setFrResult] = useState<FeederRoutingResult | null>(null);
  // A card's numbers only describe the yard they were computed against, so any
  // change to a routing input retires the whole result: cards are cleared the
  // moment the signature moves, and a response that lands after a change is
  // discarded rather than shown. Without this the drafter could move the
  // substation and then Apply metrics that describe the old position.
  const frFeederSizes = useDesignStore(s => s.feederSizes);
  const frMaxPerFeeder = useDesignStore(s => s.maxPcsPerFeeder);
  const frRoutingMode = useDesignStore(s => s.feederRoutingMode);
  // Built ONCE and used both to run the search and to hash it, so the numbers
  // on a card can never describe inputs other than the ones that produced it.
  const frInputs = useMemo(() => {
    if (!design || !substation) return null;
    return {
      design, substation,
        // Feeder ampacity/voltage-drop must use credited battery-backed
        // output, never the bare PCS capability or a stale catalog default.
        blockMW: getEffectiveConfiguration(configId, containersPerPcs).blockMW,
      base: {
        assignments: feederAssignments,
        sizes: frFeederSizes,
        material: feederMaterial,
        maxPerFeeder: frMaxPerFeeder,
        routeOverrides: layoutEdits.feederRoutes ?? null,
        forcedRoutes: (layoutEdits.forcedEdits ?? [])
          .filter(k => k.startsWith('feeder-route-'))
          .map(k => k.slice('feeder-route-'.length)),
        exclusionZones: areaZones.filter(z => z.kind === 'exclusion'),
        // Traced gate entrances / aprons are hard keep-outs for every
        // candidate, matching routeFeedersInto — a card must never advertise
        // a route the final routing would refuse.
        gateKeepouts: gateApronKeepouts(layoutEdits.customRoads ?? null),
        // A drawn aux route changes where the station-service trench runs, so
        // the search must score against it or the aux crossing count on a
        // card describes a circuit this yard does not have.
        auxWaypoints: layoutEdits.auxFeederWaypoints ?? null,
      },
      current: {
        defaultMode: frRoutingMode,
        modes: layoutEdits.feederModes ?? {},
        corridorPin: layoutEdits.feederCorridor ?? null,
      },
    };
  }, [design, substation, configId, feederAssignments, frFeederSizes, feederMaterial,
      frMaxPerFeeder, layoutEdits, areaZones, frRoutingMode]);
  const frInputSig = useMemo(() => frInputs
    ? feederRoutingInputSignature(frInputs.design, frInputs.substation,
        frInputs.blockMW, frInputs.base, frInputs.current)
    : '', [frInputs]);
  const frSigRef = useRef(frInputSig);
  const frAliveRef = useRef(true);
  useEffect(() => { frSigRef.current = frInputSig; setFrResult(null); }, [frInputSig]);
  useEffect(() => () => { frAliveRef.current = false; cancelChannel('feederRouting'); }, []);

  // Grading-rotation optimizer (earthwork vs yard rotation sweep)
  const [gradRunning, setGradRunning] = useState(false);
  const [gradProgress, setGradProgress] = useState<{ done: number; total: number } | null>(null);
  const [gradResult, setGradResult] = useState<GradingResult | null>(null);
  const [gradObjective, setGradObjective] = useState<GradingObjective>('total');
  // Comparison rows: top-5 ranked candidates with the CURRENT pose always
  // pinned into the table (appended when it falls outside the top 5), plus
  // signed earthwork deltas vs the current pose for each row.
  const gradRows = useMemo(
    () => (gradResult ? buildGradingComparisonRows(gradResult, yardRotationDeg) : null),
    [gradResult, yardRotationDeg]
  );
  // Cancel any in-flight sweep when the panel unmounts.
  useEffect(() => () => cancelChannel('grading'), []);
  // Results are only valid for the inputs they were computed from.
  useEffect(() => {
    setGradResult(null);
  }, [boundary, terrain, configId, targetMW, targetMWh, hotClimate, containersPerPcs, roadMode, laydownPct, augmentPct, surfacingMode, surfacingDepthIn]);

  // Default sample: on a fresh start (no boundary, no saved session to
  // restore), open Great Prairie 1 & 2 so its boundary choices are shown.
  const autoLoadedRef = useRef(false);
  useEffect(() => {
    if (autoLoadedRef.current) return;
    const st = useDesignStore.getState();
    if (st.boundary || st.savedSession) return;
    autoLoadedRef.current = true;
    void handleSample(SAMPLE_SITES[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Optimizer results are only valid for the inputs they were computed from —
  // drop stale candidate cards whenever a core input changes.
  useEffect(() => {
    setOptResult(null);
  }, [boundary, configId, targetMW, targetMWh, hotClimate, containersPerPcs, roadMode, laydownPct, augmentPct, surfacingMode, surfacingDepthIn]);

  const hasEdits =
    Object.keys(layoutEdits.rowMoves ?? {}).length > 0 ||
    Object.keys(layoutEdits.rowShifts ?? {}).length > 0 ||
    Object.keys(layoutEdits.blockMoves ?? {}).length > 0 ||
    Object.keys(layoutEdits.equipMoves ?? {}).length > 0 ||
    (layoutEdits.trenchX !== undefined && layoutEdits.trenchX !== null) ||
    (layoutEdits.laydownPin !== undefined && layoutEdits.laydownPin !== null) ||
    (layoutEdits.laydownSize !== undefined && layoutEdits.laydownSize !== null) ||
    Object.keys(layoutEdits.augPins ?? {}).length > 0 ||
    Object.keys(layoutEdits.feederRoutes ?? {}).length > 0 ||
    (layoutEdits.auxFeederWaypoints?.length ?? 0) > 0 ||
    (layoutEdits.customRoads ?? []).length > 0 ||
    (layoutEdits.removedRoads ?? []).length > 0 ||
    (layoutEdits.roadCuts ?? []).length > 0 ||
    (layoutEdits.placedIslands ?? []).length > 0 ||
    (layoutEdits.placedEquipment ?? []).length > 0 ||
    Object.keys(layoutEdits.dcRoutingOverrides ?? {}).length > 0 ||
    layoutEdits.alignIslands === true;

  const handleApplyRowMove = () => {
    const dxRaw = Number(editDx);
    const dyRaw = Number(editDy);
    if ((editDx.trim() !== '' && !Number.isFinite(dxRaw)) ||
        (editDy.trim() !== '' && !Number.isFinite(dyRaw))) {
      toast.error('Offsets must be numbers (feet)');
      return;
    }
    const dx = Number.isFinite(dxRaw) ? dxRaw : 0;
    const dy = Number.isFinite(dyRaw) ? dyRaw : 0;
    const ok = moveRow(editRow, dx, dy);
    if (!ok) {
      const why = useDesignStore.getState().lastRejection;
      toast.error(`Row ${editRow} move rejected — ${why ?? 'validation failed'}. Previous layout kept.`, {
        duration: 8000,
        action: {
          label: 'Override',
          onClick: () => {
            const forced = moveRow(editRow, dx, dy, true);
            if (forced) toast.warning(`Row ${editRow} moved with engineer override — verify clearances in detailed design.`);
            else toast.error(`Row ${editRow} move could not be overridden — this rule cannot be bypassed.`);
          },
        },
      });
    } else if (!dx && !dy) {
      toast.success(`Row ${editRow} restored to its automatic position`);
    } else {
      toast.success(`Row ${editRow} moved — site re-optimized around it`);
    }
  };

  const handleApplyTrenchPin = () => {
    const v = trenchInput.trim();
    if (v === '') {
      setTrenchPin(null);
      toast.success('Trench corridor set back to automatic');
      return;
    }
    const x = Number(v);
    if (!Number.isFinite(x)) {
      toast.error('Enter a number (feet, site coordinates) or leave blank for auto');
      return;
    }
    const ok = setTrenchPin(x);
    if (!ok) {
      toast.error(`Trench corridor at x = ${x} ft rejected — it would leave the fenced yard. Previous layout kept.`);
    } else {
      toast.success(`Trench pinned at x = ${x} ft — cables and buses rerouted`);
    }
  };

  const config = getEffectiveConfiguration(configId, containersPerPcs);

  const handleRunOptimizer = async () => {
    if (!boundary || optRunning) return;
    optCancelRef.current = false;
    setOptRunning(true);
    setOptResult(null);
    setOptProgress({ done: 0, total: 1 });
    try {
      // Runs in the design web worker — the search (~40 full layout
      // generations) never blocks the UI; Cancel aborts via cancelChannel.
      const result = await optimizeInWorker(
        // Search in the working (yard) frame so candidates regenerate
        // identically after Apply; at 0° this is the raw boundary object.
        boundaryForYardRotation(boundary, yardRotationDeg),
        configId,
        targetMW,
        targetMWh,
        { hotClimate, containersPerPcs, roadMode, laydownPct, augmentPct, surfacingMode, surfacingDepthIn, dcRouting },
        1,
        (done, total) => setOptProgress({ done, total })
      );
      if (result.cancelled) {
        toast.info('Optimization cancelled');
        setOptResult(null);
      } else {
        setOptResult(result);
        if (result.candidates.length === 0) {
          toast.info('No valid alternative layouts found — the current baseline is already best.');
        }
      }
    } catch (e: any) {
      if (e instanceof SupersededError) {
        toast.info('Optimization cancelled');
      } else {
        toast.error(`Optimization failed: ${e?.message ?? 'unknown error'}`);
      }
    } finally {
      setOptRunning(false);
      setOptProgress(null);
    }
  };

  const handleRunFeederOptimizer = async () => {
    if (!frInputs || !feeders.length || frRunning) return;
    setFrRunning(true);
    setFrResult(null);
    setFrProgress({ done: 0, total: 1 });
    // Hash of the inputs this run is about to use. The effect above keeps
    // frSigRef on the CURRENT yard, so any divergence means the design moved
    // while the search was in flight and the answer no longer applies.
    const sigAtStart = frInputSig;
    const fresh = () => frAliveRef.current && frSigRef.current === sigAtStart;
    try {
      // The very same object the signature hashed, so a card's metrics can
      // never describe inputs other than the ones that produced it.
      const result = await optimizeFeederRoutingInWorker(
        frInputs.design,
        frInputs.substation,
        frInputs.blockMW,
        frInputs.base,
        frInputs.current,
        (done, total) => { if (fresh()) setFrProgress({ done, total }); }
      );
      if (!fresh()) return;
      if (result.cancelled) {
        toast.info('Feeder routing search cancelled');
        setFrResult(null);
      } else {
        setFrResult(result);
        if (result.candidates.length === 0) {
          toast.info('No cleaner feeder routing found — the current bundle is already best.');
        }
      }
    } catch (e: any) {
      if (!fresh()) return;
      if (e instanceof SupersededError) toast.info('Feeder routing search cancelled');
      else toast.error(`Feeder routing search failed: ${e?.message ?? 'unknown error'}`);
    } finally {
      if (frAliveRef.current) {
        setFrRunning(false);
        setFrProgress(null);
      }
    }
  };

  const handleApplyFeederRouting = (cand: FeederRoutingCandidate) => {
    // Belt and braces: the signature effect already retires cards when a
    // routing input moves, but never let a click that raced that change write
    // a routing whose advertised metrics no longer describe this yard.
    if (frSigRef.current !== frInputSig) {
      setFrResult(null);
      toast.info('The design changed — run the feeder routing search again.');
      return;
    }
    if (useDesignStore.getState().applyFeederRoutingCandidate(cand.params)) {
      setFrResult(null);
      toast.success('Feeder routing applied — undo with Ctrl+Z');
    } else {
      toast.error('Could not apply that feeder routing to the current design.');
    }
  };

  const handleRunGradingOptimizer = async () => {
    if (!boundary || !terrain || gradRunning) return;
    setGradRunning(true);
    setGradResult(null);
    setGradProgress({ done: 0, total: 1 });
    try {
      // Sweeps yard rotations in the design web worker: each pose rotates
      // the ORIGINAL parcel, regenerates the full layout and scores the
      // cut/fill balance on a grid resampled into that pose's yard frame.
      const result = await optimizeGradingInWorker(
        boundary,
        terrain,
        configId,
        targetMW,
        targetMWh,
        { hotClimate, containersPerPcs, roadMode, laydownPct, augmentPct, surfacingMode, surfacingDepthIn, dcRouting },
        gradObjective,
        (done, total) => setGradProgress({ done, total })
      );
      if (result.cancelled) {
        toast.info('Grading sweep cancelled');
        setGradResult(null);
      } else {
        setGradResult(result);
      }
    } catch (e: any) {
      if (e instanceof SupersededError) {
        toast.info('Grading sweep cancelled');
      } else {
        toast.error(`Grading sweep failed: ${e?.message ?? 'unknown error'}`);
      }
    } finally {
      setGradRunning(false);
      setGradProgress(null);
    }
  };

  const handleApplyGradingRotation = (deg: number) => {
    setYardRotation(deg);
    const err = useDesignStore.getState().error;
    if (err) {
      toast.error(`Rotation ${deg}° failed to regenerate: ${err} — use Undo to go back.`);
    } else if (deg === 0) {
      toast.success('Yard rotation reset to 0° (original orientation)');
    } else {
      toast.success(`Yard rotated ${deg}° for grading — layout regenerated`);
    }
  };

  const handleApplyCandidate = (cand: OptimizeCandidate) => {
    applyOptimizedLayout(cand.params);
    const err = useDesignStore.getState().error;
    if (err) {
      toast.error(`Could not apply layout: ${err}`);
    } else {
      toast.success(`Optimized layout applied — ${cand.stats.blocksPlaced} blocks, ${cand.stats.achievedMWh.toFixed(0)} MWh. Undo with Ctrl+Z.`);
    }
  };

  // Pristine alternatives (no edits) with comparison stats; computed only
  // while the explorer is open. Deterministic per inputs.
  const arrangementOptions = useMemo(() => {
    if (!showArrangements || !boundary) return null;
    try {
      return generateArrangements(boundary, config, targetMW, targetMWh, {
        hotClimate, containersPerPcs, roadMode, laydownPct, augmentPct, surfacingMode, surfacingDepthIn, dcRouting,
        // The candidates must be packed inside the fence the drafter selected,
        // otherwise the explorer compares block counts for a yard that is not
        // the one being drawn.
        fencePlacement,
      });
    } catch {
      return null;
    }
  }, [showArrangements, boundary, config, targetMW, targetMWh, hotClimate, containersPerPcs, roadMode, laydownPct, augmentPct, surfacingMode, surfacingDepthIn, dcRouting, fencePlacement]);

  const swBlocksPlaced = useMemo(() => {
    if (!arrangementOptions) return null;
    const sw = arrangementOptions.find(o => o.strategy === 'sw');
    return sw ? sw.stats.blocksPlaced : null;
  }, [arrangementOptions]);

  const shortfallVsDefault = (s: ArrangementStrategy): number => {
    if (!arrangementOptions || swBlocksPlaced == null) return 0;
    const opt = arrangementOptions.find(o => o.strategy === s);
    if (!opt) return 0;
    return Math.max(0, swBlocksPlaced - opt.stats.blocksPlaced);
  };

  const applyArrangement = (s: ArrangementStrategy) => {
    setArrangement(s);
    setPendingArrangement(null);
    setConfirmReset(false);
    setEditDx('0');
    setEditDy('0');
    setTrenchInput('');
    const label = ARRANGEMENTS.find(a => a.id === s)?.label ?? s;
    toast.success(
      s === 'sw'
        ? 'Standard default arrangement applied — this is the new baseline'
        : `${label} applied — this is the new baseline (edits cleared, roads rebuilt)`
    );
  };

  const handlePickArrangement = (s: ArrangementStrategy) => {
    if (s === arrangement && !hasEdits) {
      toast.info('This arrangement is already the active baseline');
      return;
    }
    if (hasEdits || shortfallVsDefault(s) > 0) {
      setPendingArrangement(s);
      return;
    }
    applyArrangement(s);
  };

  const handleMaterialChange = (m: ConductorMaterial) => {
    const { feederSizes, feeders: before } = useDesignStore.getState();
    // Feeders with a manual size pick that pass checks under the current material
    const safeOverridden = before
      .filter(f => feederSizes[f.idx] !== undefined && !f.overLimit && !f.overAmpacity)
      .map(f => f.idx);
    setFeederMaterial(m);
    const after = useDesignStore.getState().feeders;
    const invalidated = after.filter(
      f => safeOverridden.includes(f.idx) && (f.overLimit || f.overAmpacity)
    );
    if (invalidated.length > 0) {
      const list = invalidated.map(f => `Feeder #${feederDisplayName(f)} (${f.size} kcmil)`).join(', ');
      const matName = m === 'Al' ? 'aluminum' : 'copper';
      toast.warning(
        `Switching to ${matName} made your manual conductor pick unsafe on ${list} — over ampacity or the ${VD_LIMIT_PCT}% voltage-drop limit.`,
        {
          duration: 12000,
          action: {
            label: 'Reset to auto sizes',
            onClick: () => {
              resetFeederSizes();
              toast.success('Manual conductor sizes cleared — feeders re-sized automatically.');
            },
          },
        }
      );
    }
  };

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.kmz') && !file.name.toLowerCase().endsWith('.kml')) {
      toast.error('Please upload a .kmz file');
      return;
    }
    await loadKmz(file);
    const st = useDesignStore.getState();
    if (st.error) toast.error(st.error);
    else if (!st.boundaryPicker) toast.success('Site boundary loaded');
  };

  const handleSample = async (s: { name: string; url: string; boundaryNames?: string[] }) => {
    await loadSample(s.url, s.name, s.boundaryNames);
    const st = useDesignStore.getState();
    if (st.error) toast.error(st.error);
    else if (!st.boundaryPicker) toast.success(`${s.name} loaded`);
  };

  // Opt-in existing-grade contours (reference layer), shared by every export
  // path (single DXF, DXF package, PDF plots). Computed on the UI thread from
  // the loaded elevation grid — plain data into the worker. Returns null when
  // the option is off, no terrain is loaded, or the site has no relief.
  const computeExportContours = async (d: NonNullable<typeof design>) => {
    if (!exportContoursDxf) return null;
    if (!terrainYard) {
      toast.warning('No elevation data loaded — exporting without contour lines');
      return null;
    }
    const { contoursForDxf } = await import('../lib/nextera/terrain');
    const contours = contoursForDxf(terrainYard, d.boundary.origin, contourIntervalFt);
    if (!contours) toast.warning('Site has no measurable relief — exporting without contour lines');
    return contours;
  };

  // "Issued for 10%" cover context: stylized vicinity map (TIGERweb proxy) +
  // aerial local rect for the georegistered right panel. Fetch failures are
  // surfaced and degrade to a cover without the failed panel — never silent.
  const buildCover10 = async (
    satImg: Awaited<ReturnType<typeof loadSatellite>> | null,
    // One-click 10% Package always ships the reference-style cover; the
    // explicit per-call flag can never leak into other exports (a shared
    // ref here once could, if another export ran during the package build).
    force10 = false
  ): Promise<import('../lib/nextera/dxfSheets').SheetContext['cover10']> => {
    if ((!issuedFor10 && !force10) || !boundary) return undefined;
    const { fetchVicinityMap } = await import('../lib/nextera/vicinityMap');
    let vicinity: import('../lib/nextera/vicinityMap').VicinityData | null = null;
    try {
      vicinity = await fetchVicinityMap(boundary.origin.lat, boundary.origin.lon);
    } catch (e: any) {
      toast.warning(`Vicinity map unavailable: ${e?.message ?? 'fetch failed'} — cover exports without it`);
    }
    const hours = targetMW > 0 ? targetMWh / targetMW : 0;
    const hoursTxt = Number.isInteger(hours) ? `${hours}` : hours.toFixed(1);
    return {
      vicinity,
      aerial: satImg
        ? { localRect: (await import('../lib/nextera/satellite')).satelliteLocalRect(satImg, boundary.origin) }
        : null,
      statsLine: `${targetMW} MW/${hoursTxt} HR PROJECT`,
      locationLine: titleBlock.location?.trim() || undefined,
      coordinateLine: (await import('../lib/nextera/kmz')).formatLatLon(boundary.origin.lat, boundary.origin.lon),
    };
  };

  // Hi-fi cover renders: ask the live 3D scene for a plan-registered
  // top-down shot + a perspective hero (PDF cover only; DXF stays vector).
  // Resolves null when the scene is in 2D mode or the capture times out —
  // callers then fall back to the vector overlay, never fail the export.
  // Wait until the scene reports the committed GLB detail state (set from a
  // DesignScene effect after React commits the group visibility). Bounded
  // fallback so a stalled scene can never hang an export.
  const waitForRealisticDetail = async () => {
    const t0 = Date.now();
    while (Date.now() - t0 < 3000) {
      if (useDesignStore.getState().realisticDetailApplied) return;
      await new Promise(r => setTimeout(r, 50));
    }
  };

  // Why NO_3D_SCENE names WebGL: drafters have exported from browsers where
  // WebGL is disabled (e.g. embedded/mobile webviews) — the 3D scene never
  // mounts, so there is nothing to photograph. A 10% cover without the model
  // renders is a defective deliverable; strict callers abort loudly instead
  // of silently shipping the vector-only fallback.
  const NO_3D_SCENE =
    '3D model renders unavailable — the 3D scene is not running in this browser ' +
    '(2D/CAD view active, or WebGL is disabled/failed here — common in embedded and mobile browsers). ' +
    'Open the app in a desktop browser, switch to the 3D view, and export again.';

  const captureCoverRenders = async (
    localRect: { minX: number; minY: number; maxX: number; maxY: number },
    opts?: { required?: boolean }
  ): Promise<{ topDown: { dataUrl: string; widthPx: number; heightPx: number } | null; hero: { dataUrl: string; widthPx: number; heightPx: number } | null } | null> => {
    const st = useDesignStore.getState();
    if (!st.coverCaptureReady) {
      if (opts?.required) throw new Error(NO_3D_SCENE);
      toast.info('2D/CAD view active — cover uses the vector key plan (switch to 3D for the model render)');
      return null;
    }
    // Force full-detail GLB models for the capture: if the drafter's
    // viewport is zoomed far out, the far-LOD sensor has swapped the yard
    // to simple boxes — without this the cover bakes boxes, not models.
    // Refcounted lease + scene commit handshake (not a timer).
    st.acquireForceRealisticNear();
    try {
      await waitForRealisticDetail();
      const n = st.requestCoverCapture(localRect, false, {
        topDown: hideCoverLabelsAerial,
        hero: hideCoverLabelsModel,
      });
      const res: any = await new Promise(resolve => {
        let done = false;
        const finish = (r: any) => {
          if (done) return;
          done = true; unsub(); clearTimeout(timer);
          resolve(r);
        };
      const unsub = useDesignStore.subscribe(s => {
        const r = s.coverCaptureResult;
        if (r && r.n === n) finish(r.topDown || r.hero ? { topDown: r.topDown, hero: r.hero } : null);
      });
      const timer = setTimeout(() => {
        if (!opts?.required) toast.warning('3D cover render timed out — cover uses the vector key plan');
        finish(opts?.required ? { __timeout: true } : null);
      }, 8000);
      });
      if (opts?.required) {
        if (res?.__timeout) throw new Error('3D cover render timed out — the 3D scene did not produce the model renders. Keep the 3D view visible and try again.');
        if (!res || !res.topDown) throw new Error(NO_3D_SCENE);
      }
      return res;
    } finally {
      useDesignStore.getState().releaseForceRealisticNear();
    }
  };

  // Routing validation gates (spec §9, G-RT-1..12) re-run before every plan/
  // package export: violations raise a toast summary here while the full
  // messages sit in the design warnings list. The export itself is never
  // blocked — the drafter decides, but never ships a violation unseen.
  const warnRoutingGatesForExport = () => {
    if (!design) return;
    try {
      // Audits EVERY exportable yard — on a multi-area project the store
      // walks all BESS areas (a superset of any export selection, and of the
      // permit packet's all-areas scope), so a violation in a non-active
      // exported area can never ship silently. The audit also refreshes each
      // design's gate warning batch, so the warnings list this toast points
      // at always shows the batch the export saw.
      const perArea = useDesignStore.getState().auditRoutingGatesForExport();
      const hit = perArea.filter(a => a.results.length);
      if (!hit.length) return;
      const total = hit.reduce((n, a) => n + a.results.length, 0);
      const errors = hit.reduce((n, a) => n + a.results.filter(r => r.severity === 'error').length, 0);
      const lead = hit.find(a => a.results.some(r => r.severity === 'error')) ?? hit[0];
      const leadMsg = (lead.results.find(r => r.severity === 'error') ?? lead.results[0]).message;
      toast.warning(
        `${total} routing gate finding${total > 1 ? 's' : ''}` +
        (errors ? ` (${errors} rule violation${errors > 1 ? 's' : ''})` : '') +
        (hit.length > 1 ? ` in ${hit.length} areas` : (lead.area ? ` in ${lead.area}` : '')) +
        ` — ${lead.area ? `${lead.area}: ` : ''}${leadMsg} — see the design warnings list`,
        { duration: 8000 });
    } catch {
      // The gate re-run must never block an export.
    }
  };

  const handleExport = async () => {
    if (!design || !boundary) {
      toast.error('Upload a KMZ site boundary first');
      return;
    }
    warnRoutingGatesForExport();
    const exportName = (titleBlock.projectName.trim() || boundary.name).replace(/[^A-Za-z0-9_-]+/g, '_');
    try {
      const contours = await computeExportContours(design);
      // DXF string is built in the design worker so a 150+ block sheet
      // (~1 MB of entities) never stalls the UI thread.
      const content = await buildDxfInWorker(design, exportName, configId, titleBlock, feeders, substation, containersPerPcs, contours, exportGroundingDxf ? groundingPlan : null, exportTrenchSectionsDxf, exportSurfacingMesh, areaZones.length ? areaZones : undefined, eciLegend || undefined, Object.keys(textOverrides).length ? textOverrides : undefined, layoutEdits.auxFeederWaypoints?.length ? true : undefined, undefined, siteExportInput, drawingVisibility);
      const saved = await saveBlob(
        new Blob([content], { type: 'application/dxf' }),
        `${exportName}${exportFileTag()}_10pct_Design_${new Date().toISOString().slice(0, 10)}.dxf`
      );
      if (saved) toast.success(siteExportInput ? `DXF exported — ${exportScopeLabel}` : 'DXF exported');
    } catch (e: any) {
      if (e instanceof SupersededError) return;
      toast.error(`DXF export failed: ${e?.message ?? 'unknown error'}`);
    }
  };

  const handleExportPackage = async () => {
    if (!design || !boundary) {
      toast.error('Upload a KMZ site boundary first');
      return;
    }
    warnRoutingGatesForExport();
    const exportName = (titleBlock.projectName.trim() || boundary.name).replace(/[^A-Za-z0-9_-]+/g, '_');
    try {
      const contours = await computeExportContours(design);
      // 10% cover: the DXF cover sheet is pure vector, but the aerial local
      // rect still georegisters the right-panel overlay — so fetch imagery
      // bounds when the option is on.
      const satForCover = issuedFor10 ? await loadSatellite() : null;
      const cover10 = await buildCover10(satForCover);
      // Sheets are composed in the design worker; the zip is assembled here.
      const sheets = await buildDxfPackageInWorker(
        design, exportName, configId, titleBlock, feeders, substation, containersPerPcs, contours,
        exportGroundingDxf ? groundingPlan : null,
        includeSldBom ? { options: sldOpts } : null,
        includeSldBom ? { options: { groundingPlan } } : null,
        exportTrenchSectionsDxf,
        cover10,
        exportSurfacingMesh,
        areaZones.length ? areaZones : undefined,
        eciLegend || undefined,
        issuedFor10 || undefined,
        Object.keys(textOverrides).length ? textOverrides : undefined,
        layoutEdits.auxFeederWaypoints?.length ? true : undefined,
        undefined,
        // Multi-area: append a readable full-size plan per selected footprint,
        // from the same selection the DXF and PDF exports use.
        siteExportInput,
        drawingVisibility
      );
      const JSZip = (await import('jszip')).default;
      const zip = new JSZip();
      sheets.forEach(s => zip.file(s.filename, s.content));
      // Include the ORIGINAL manufacturer mechanical drawing sheets (LG MC01
      // package) as CAD-attachable reference plates alongside the DXFs.
      const { MECH_DRAWING_PAGES } = await import('@/lib/nextera/mechDrawings');
      MECH_DRAWING_PAGES.forEach(p =>
        zip.file(`Reference_Drawings/${p.filename}`, p.jpegBase64, { base64: true })
      );
      const blob = await zip.generateAsync({ type: 'blob' });
      const saved = await saveBlob(blob, `${exportName}_DXF_Package_${new Date().toISOString().slice(0, 10)}.zip`);
      if (saved) toast.success(`DXF package exported (${sheets.length} sheets + ${MECH_DRAWING_PAGES.length} reference drawings)`);
    } catch (e: any) {
      if (e instanceof SupersededError) return;
      toast.error(`DXF package export failed: ${e?.message ?? 'unknown error'}`);
    }
  };

  const [pdfBusy, setPdfBusy] = useState(false);
  const handleExportPdf = async () => {
    if (!design || !boundary) {
      toast.error('Upload a KMZ site boundary first');
      return;
    }
    warnRoutingGatesForExport();
    const exportName = (titleBlock.projectName.trim() || boundary.name).replace(/[^A-Za-z0-9_-]+/g, '_');
    setPdfBusy(true);
    try {
      // Rendered from the same sheet composers as the DXF package (shared
      // display list) so the PDF can never drift from the DXF drawings.
      const { buildPdfPlot } = await import('../lib/nextera/pdfPlot');
      const { satelliteLocalRect } = await import('../lib/nextera/satellite');
      // Real aerial imagery of the site on the cover page (highest-DPI mosaic
      // via the server-side Cesium ion proxy). Fetch failures degrade to a
      // cover without imagery — and are surfaced, never silent.
      const contours = await computeExportContours(design);
      const satImg = await loadSatellite();
      if (!satImg) {
        const reason = useDesignStore.getState().satelliteError;
        toast.warning(`Cover satellite imagery unavailable${reason ? `: ${reason}` : ''} — exporting without it`);
      }
      // Yield a frame so the busy state paints before the synchronous render.
      await new Promise(res => setTimeout(res, 30));
      const doc = buildPdfPlot({
        design,
        projectName: exportName,
        drawingVisibility,
        config,
        meta: titleBlock,
        feeders,
        substation,
        contours,
        ...(eciLegend ? { eciLegend: true } : {}),
        ...(Object.keys(textOverrides).length ? { textOverrides } : {}),
        // Multi-area: append a readable full-size plan page per selected
        // footprint, from the same selection the DXF package uses.
        ...(siteExportInput ? { site: siteExportInput } : {}),
        coverImage: satImg
          ? {
              dataUrl: satImg.dataUrl,
              widthPx: satImg.widthPx,
              heightPx: satImg.heightPx,
              caption: `SITE VICINITY — AERIAL IMAGERY, ${boundary.origin.lat.toFixed(5)}, ${boundary.origin.lon.toFixed(5)} (CESIUM ION / BING MAPS, ZOOM ${satImg.zoom})`,
              // Local-feet rect of the mosaic so the cover draws the layout
              // georegistered over the photo (same math as the 3D drape).
              localRect: satelliteLocalRect(satImg, boundary.origin),
            }
          : null,
        // Only set under a grading-optimized rotation, so default exports
        // stay byte-identical (absent field -> exact no-op in the cover).
        ...(yardRotationDeg !== 0 && satImg
          ? { yardRotation: { deg: yardRotationDeg, pivot: polygonPivot(boundary.polygon) } }
          : {}),
        // Opt-in appended SLD + BOM pages (absent ⇒ plot set byte-identical
        // to the default).
        ...(includeSldBom
          ? { sldSheet: { options: sldOpts }, bomSheet: { options: { groundingPlan } } }
          : {}),
        // Opt-in "Issued for 10%" reference-style cover (absent ⇒ legacy
        // cover, byte-identical).
        ...(issuedFor10 ? { cover10: await buildCover10(satImg), enlargedPlans: true } : {}),
        // Hi-fi 3D cover renders (PDF only; falls back to vector overlay).
        ...(issuedFor10 && satImg
          ? { coverRenders: await captureCoverRenders(satelliteLocalRect(satImg, boundary.origin), { required: true }) }
          : {}),
        surfacingMesh: exportSurfacingMesh,
        ...(areaZones.length ? { areaZones } : {}),
      });
      const saved = await saveBlob(finalizePdfBlob(doc), `${exportName}_Plot_Set_${new Date().toISOString().slice(0, 10)}.pdf`);
      if (saved) toast.success(`PDF plot set exported (${includeSldBom ? '10' : '7'} sheets + 9 mechanical drawing plates, ANSI D)`);
    } catch (e: any) {
      toast.error(`PDF export failed: ${e?.message ?? 'unknown error'}`);
    } finally {
      setPdfBusy(false);
    }
  };

  // One-click 10% Package: full DXF sheet package + multi-page PDF plot set
  // (10% cover, drawing sheets, and a dedicated full-site top-down realistic
  // render page) in a single zip. Requirements fail LOUDLY — missing
  // satellite imagery, a non-3D view, or realistic models off abort the
  // export with a clear message instead of silently degrading the render.
  const [pkg10Busy, setPkg10Busy] = useState(false);
  const [pkg10Stage, setPkg10Stage] = useState('');
  const handleExport10Package = async () => {
    if (!design || !boundary) {
      toast.error('Upload a KMZ site boundary first');
      return;
    }
    warnRoutingGatesForExport();
    const st0 = useDesignStore.getState();
    if (!st0.coverCaptureReady) {
      toast.error('10% Package needs the 3D view — switch to 3D preview and try again');
      return;
    }
    if (!st0.realisticModels) {
      toast.error('10% Package needs realistic models — enable "Realistic models" in the 3D view and try again');
      return;
    }
    const exportName = (titleBlock.projectName.trim() || boundary.name).replace(/[^A-Za-z0-9_-]+/g, '_');
    setPkg10Busy(true);
    let pkg10NearLease = false;
    try {
      setPkg10Stage('Loading satellite imagery…');
      const satImg = await loadSatellite();
      if (!satImg) {
        const reason = useDesignStore.getState().satelliteError;
        throw new Error(`satellite imagery unavailable${reason ? ` (${reason})` : ''}`);
      }
      if (!useDesignStore.getState().showSatellite) setShowSatellite(true);
      setPkg10Stage('Waiting for 3D models and ground imagery…');
      const { waitForSceneReady } = await import('../lib/sceneReady');
      const settled = await waitForSceneReady({ settleMs: 600, timeoutMs: 30000 });
      if (!settled) throw new Error('3D models/imagery did not finish loading (timed out)');
      const { satelliteLocalRect } = await import('../lib/nextera/satellite');
      const localRect = satelliteLocalRect(satImg, boundary.origin);
      setPkg10Stage('Capturing site render…');
      // Force full-detail GLB models for both captures (far-LOD may have
      // swapped the yard to boxes if the viewport camera sits far out).
      // Lease released in this flow's finally; captureCoverRenders holds
      // its own nested lease (refcounted, so neither drops the other's).
      useDesignStore.getState().acquireForceRealisticNear();
      pkg10NearLease = true;
      await waitForRealisticDetail();
      // Hi-res supersampled top-down for the dedicated render page. A failed
      // or timed-out capture aborts the export — never a silently blank page.
      const nHi = useDesignStore.getState().requestCoverCapture(localRect, true, { topDown: hideSiteRenderLabels });
      const siteShot = await new Promise<{ dataUrl: string; widthPx: number; heightPx: number } | null>(resolve => {
        let done = false;
        const finish = (r: any) => { if (!done) { done = true; unsub(); clearTimeout(timer); resolve(r); } };
        const unsub = useDesignStore.subscribe(s => {
          const r = s.coverCaptureResult;
          if (r && r.n === nHi) finish(r.topDown);
        });
        const timer = setTimeout(() => finish(null), 20000);
      });
      if (!siteShot) throw new Error('site render capture failed or timed out');
      setPkg10Stage('Capturing cover renders…');
      const coverRenders = await captureCoverRenders(localRect, { required: true });
      setPkg10Stage('Building cover…');
      const contours = await computeExportContours(design);
      const cover10 = await buildCover10(satImg, true);
      setPkg10Stage('Composing DXF sheets…');
      const sheets = await buildDxfPackageInWorker(
        design, exportName, configId, titleBlock, feeders, substation, containersPerPcs, contours,
        exportGroundingDxf ? groundingPlan : null,
        includeSldBom ? { options: sldOpts } : null,
        includeSldBom ? { options: { groundingPlan } } : null,
        exportTrenchSectionsDxf,
        cover10,
        exportSurfacingMesh,
        areaZones.length ? areaZones : undefined,
        eciLegend || undefined,
        true, // enlarged AREA plan tiles (10% package)
        Object.keys(textOverrides).length ? textOverrides : undefined,
        layoutEdits.auxFeederWaypoints?.length ? true : undefined,
        undefined,
        undefined,
        drawingVisibility
      );
      setPkg10Stage('Rendering PDF plot set…');
      // Yield a frame so the stage text paints before the synchronous render.
      await new Promise(res => setTimeout(res, 30));
      const { buildPdfPlot } = await import('../lib/nextera/pdfPlot');
      const doc = buildPdfPlot({
        design,
        projectName: exportName,
        drawingVisibility,
        config,
        meta: titleBlock,
        feeders,
        substation,
        contours,
        ...(eciLegend ? { eciLegend: true } : {}),
        ...(Object.keys(textOverrides).length ? { textOverrides } : {}),
        coverImage: {
          dataUrl: satImg.dataUrl,
          widthPx: satImg.widthPx,
          heightPx: satImg.heightPx,
          caption: `SITE VICINITY — AERIAL IMAGERY, ${boundary.origin.lat.toFixed(5)}, ${boundary.origin.lon.toFixed(5)} (CESIUM ION / BING MAPS, ZOOM ${satImg.zoom})`,
          localRect,
        },
        ...(yardRotationDeg !== 0
          ? { yardRotation: { deg: yardRotationDeg, pivot: polygonPivot(boundary.polygon) } }
          : {}),
        ...(includeSldBom
          ? { sldSheet: { options: sldOpts }, bomSheet: { options: { groundingPlan } } }
          : {}),
        cover10,
        coverRenders,
        enlargedPlans: true,
        siteRender: {
          ...siteShot,
          caption: `SITE MODEL — TOP-DOWN ORTHOGRAPHIC RENDER OVER SATELLITE IMAGERY (ZOOM ${satImg.zoom})`,
        },
        surfacingMesh: exportSurfacingMesh,
        ...(areaZones.length ? { areaZones } : {}),
      });
      setPkg10Stage('Packaging zip…');
      const JSZip = (await import('jszip')).default;
      const zip = new JSZip();
      sheets.forEach(s => zip.file(s.filename, s.content));
      const { MECH_DRAWING_PAGES } = await import('@/lib/nextera/mechDrawings');
      MECH_DRAWING_PAGES.forEach(p =>
        zip.file(`Reference_Drawings/${p.filename}`, p.jpegBase64, { base64: true })
      );
      const date = new Date().toISOString().slice(0, 10);
      zip.file(`${exportName}_10pct_Plot_Set_${date}.pdf`, finalizePdfBlob(doc));
      const blob = await zip.generateAsync({ type: 'blob' });
      const saved = await saveBlob(blob, `${exportName}_10pct_Package_${date}.zip`);
      if (saved) toast.success(`10% Package exported (${sheets.length} DXF sheets + PDF plot set with site render page)`);
    } catch (e: any) {
      if (e instanceof SupersededError) return;
      toast.error(`10% Package export failed: ${e?.message ?? 'unknown error'}`);
    } finally {
      if (pkg10NearLease) useDesignStore.getState().releaseForceRealisticNear();
      setPkg10Busy(false);
      setPkg10Stage('');
    }
  };

  const [sldPdfBusy, setSldPdfBusy] = useState(false);
  // SLD export options (opt-in; defaults keep the legacy ANSI sheet):
  // symbol convention per ANSI/IEEE 315 vs IEC 60617 (never mixed on one
  // sheet), and bus fault duties from the short-circuit study when enabled.
  const [sldStandard, setSldStandard] = useState<'ANSI' | 'IEC'>('ANSI');
  const [sldIncludeFaults, setSldIncludeFaults] = useState(false);
  // Opt-in: append the SLD + BOM sheets to the one-click DXF package and PDF
  // plot set. OFF by default so both exports stay byte-identical.
  const [includeSldBom, setIncludeSldBom] = useState(false);
  // Opt-in "Issued for 10%" reference-style cover on package / plot exports.
  const [issuedFor10, setIssuedFor10] = useState(false);
  // Per-image label removal for the cover's 3D renders: equipment labels can
  // be hidden in the aerial key-plan render and/or the SITE 3D MODEL inset.
  // OFF by default — captures are unchanged unless the engineer opts in.
  const [hideCoverLabelsAerial, setHideCoverLabelsAerial] = useState(false);
  const [hideCoverLabelsModel, setHideCoverLabelsModel] = useState(false);
  const [hideSiteRenderLabels, setHideSiteRenderLabels] = useState(false);
  const sldOpts = useMemo(
    () => ({
      standard: sldStandard,
      study: sldIncludeFaults ? scStudy : null,
      // Nameplate impedances come from the drafter's LGIA data-sheet inputs
      // — the SLD prints "NOT PROVIDED" when these are blank rather than a
      // typical value.
      pcsXfmrZPct: lgiaInputs.pcsXfmrZPct,
      auxXfmrZPct: lgiaInputs.auxXfmrZPct,
    }),
    [sldStandard, sldIncludeFaults, scStudy, lgiaInputs.pcsXfmrZPct, lgiaInputs.auxXfmrZPct]
  );
  const handleExportSldDxf = async () => {
    if (!design || !boundary) {
      toast.error('Upload a KMZ site boundary first');
      return;
    }
    if (!feeders.length) {
      toast.error('Place a substation to route feeders first — the single-line diagram is built from the routed feeder circuits');
      return;
    }
    const exportName = (titleBlock.projectName.trim() || boundary.name).replace(/[^A-Za-z0-9_-]+/g, '_');
    try {
      // Small sheet (a few hundred entities) — built on the UI thread.
      const { buildSldDxfString } = await import('../lib/nextera/sld');
      const content = buildSldDxfString(design, exportName, feeders, config, titleBlock, sldOpts);
      const saved = await saveBlob(
        new Blob([content], { type: 'application/dxf' }),
        `${exportName}_Single_Line_Diagram_${new Date().toISOString().slice(0, 10)}.dxf`
      );
      if (saved) toast.success('Single-line diagram DXF exported');
    } catch (e: any) {
      toast.error(`SLD export failed: ${e?.message ?? 'unknown error'}`);
    }
  };

  const handleExportSldPdf = async () => {
    if (!design || !boundary) {
      toast.error('Upload a KMZ site boundary first');
      return;
    }
    if (!feeders.length) {
      toast.error('Place a substation to route feeders first — the single-line diagram is built from the routed feeder circuits');
      return;
    }
    const exportName = (titleBlock.projectName.trim() || boundary.name).replace(/[^A-Za-z0-9_-]+/g, '_');
    setSldPdfBusy(true);
    try {
      // Rendered from the same display list the SLD DXF records, so the PDF
      // can never drift from the DXF sheet.
      const { buildSldPdf } = await import('../lib/nextera/pdfPlot');
      await new Promise(res => setTimeout(res, 30));
      const doc = buildSldPdf(
        { design, projectName: exportName, config, meta: titleBlock },
        feeders,
        sldOpts
      );
      const saved = await saveBlob(finalizePdfBlob(doc), `${exportName}_Single_Line_Diagram_${new Date().toISOString().slice(0, 10)}.pdf`);
      if (saved) toast.success('Single-line diagram PDF exported (1 page, ANSI D, vector)');
    } catch (e: any) {
      toast.error(`SLD PDF export failed: ${e?.message ?? 'unknown error'}`);
    } finally {
      setSldPdfBusy(false);
    }
  };

  // --- BOM schedule sheet exports (standalone, same table conventions as the
  // cable schedule sheet; rows come verbatim from buildBomRows + the rollup,
  // so DXF/PDF/CSV always agree line for line).
  const [bomPdfBusy, setBomPdfBusy] = useState(false);
  const handleExportBomSheetDxf = async () => {
    if (!design || !boundary) {
      toast.error('Upload a KMZ site boundary first');
      return;
    }
    const exportName = (titleBlock.projectName.trim() || boundary.name).replace(/[^A-Za-z0-9_-]+/g, '_');
    try {
      const { buildBomSheetDxfString } = await import('../lib/nextera/bomSheet');
      // Two B018 sheets, exactly like the issued 90% package (CAR-D-B018-1/-2)
      let saved = false;
      for (const sheet of [1, 2] as const) {
        const content = buildBomSheetDxfString(design, exportName, feeders, config, titleBlock, { groundingPlan, sheet });
        saved = await saveBlob(
          new Blob([content], { type: 'application/dxf' }),
          `${exportName}_Bill_of_Materials_${sheet}_${new Date().toISOString().slice(0, 10)}.dxf`
        ) || saved;
      }
      if (saved) toast.success('Bill of materials DXF exported (2 sheets, B018 template)');
    } catch (e: any) {
      toast.error(`BOM sheet export failed: ${e?.message ?? 'unknown error'}`);
    }
  };

  const handleExportBomSheetPdf = async () => {
    if (!design || !boundary) {
      toast.error('Upload a KMZ site boundary first');
      return;
    }
    const exportName = (titleBlock.projectName.trim() || boundary.name).replace(/[^A-Za-z0-9_-]+/g, '_');
    setBomPdfBusy(true);
    try {
      const { buildBomSheetPdf } = await import('../lib/nextera/pdfPlot');
      await new Promise(res => setTimeout(res, 30));
      const doc = buildBomSheetPdf(
        { design, projectName: exportName, config, meta: titleBlock },
        feeders,
        { groundingPlan }
      );
      const saved = await saveBlob(finalizePdfBlob(doc), `${exportName}_Bill_of_Materials_${new Date().toISOString().slice(0, 10)}.pdf`);
      if (saved) toast.success('Bill of materials PDF exported (2 pages, B018 template, ANSI D, vector)');
    } catch (e: any) {
      toast.error(`BOM sheet PDF export failed: ${e?.message ?? 'unknown error'}`);
    } finally {
      setBomPdfBusy(false);
    }
  };

  // --- Grading plan exports (opt-in; only offered when the FG surface is on)
  const [gradingPdfBusy, setGradingPdfBusy] = useState(false);
  const handleExportGradingDxf = async () => {
    if (!design || !boundary) {
      toast.error('Upload a KMZ site boundary first');
      return;
    }
    if (!fgSurface || !terrainYard) {
      toast.error('Enable grading (proposed FG surface) in the Terrain card first');
      return;
    }
    const exportName = (titleBlock.projectName.trim() || boundary.name).replace(/[^A-Za-z0-9_-]+/g, '_');
    try {
      const { buildGradingPlanDxfString, buildProposedContours, buildCutFillRegions } = await import('../lib/nextera/gradingPlan');
      const rect = terrainLocalRect(terrainYard, design.boundary.origin);
      const proposed = buildProposedContours(terrainYard, rect, fgSurface);
      const existing = await computeExportContours(design);
      const cutFill = exportCutFillShading ? buildCutFillRegions(terrainYard, rect, fgSurface) : null;
      const cost = exportCostEstimate ? earthworkCost : null;
      const sections = exportSections
        ? (await import('../lib/nextera/gradingSections')).buildGradingSections(terrainYard, rect, fgSurface, { quarterPoints: true })
        : null;
      const content = buildGradingPlanDxfString(
        design, exportName,
        { fg: fgSurface, proposed, existing, drainage: drainageModel, cutFill, cost, sections },
        config, titleBlock
      );
      const saved = await saveBlob(
        new Blob([content], { type: 'application/dxf' }),
        `${exportName}_Grading_Plan_${new Date().toISOString().slice(0, 10)}.dxf`
      );
      if (saved) toast.success('Grading plan DXF exported (screening — not for construction)');
    } catch (e: any) {
      toast.error(`Grading plan export failed: ${e?.message ?? 'unknown error'}`);
    }
  };

  const handleExportGradingPdf = async () => {
    if (!design || !boundary) {
      toast.error('Upload a KMZ site boundary first');
      return;
    }
    if (!fgSurface || !terrainYard) {
      toast.error('Enable grading (proposed FG surface) in the Terrain card first');
      return;
    }
    const exportName = (titleBlock.projectName.trim() || boundary.name).replace(/[^A-Za-z0-9_-]+/g, '_');
    setGradingPdfBusy(true);
    try {
      // Rendered from the same display list the grading DXF records, so the
      // PDF can never drift from the DXF sheet.
      const { buildProposedContours, buildCutFillRegions } = await import('../lib/nextera/gradingPlan');
      const { buildGradingPlanPdf } = await import('../lib/nextera/pdfPlot');
      const rect = terrainLocalRect(terrainYard, design.boundary.origin);
      const proposed = buildProposedContours(terrainYard, rect, fgSurface);
      const existing = await computeExportContours(design);
      const cutFill = exportCutFillShading ? buildCutFillRegions(terrainYard, rect, fgSurface) : null;
      const cost = exportCostEstimate ? earthworkCost : null;
      const sections = exportSections
        ? (await import('../lib/nextera/gradingSections')).buildGradingSections(terrainYard, rect, fgSurface, { quarterPoints: true })
        : null;
      await new Promise(res => setTimeout(res, 30));
      const doc = buildGradingPlanPdf(
        { design, projectName: exportName, config, meta: titleBlock },
        { fg: fgSurface, proposed, existing, drainage: drainageModel, cutFill, cost, sections }
      );
      const saved = await saveBlob(finalizePdfBlob(doc), `${exportName}_Grading_Plan_${new Date().toISOString().slice(0, 10)}.pdf`);
      if (saved) toast.success('Grading plan PDF exported (1 page, ANSI D, vector)');
    } catch (e: any) {
      toast.error(`Grading plan PDF export failed: ${e?.message ?? 'unknown error'}`);
    } finally {
      setGradingPdfBusy(false);
    }
  };

  // --- GP-2 cross-sections exports (opt-in; only offered when enabled)
  const [sectionsPdfBusy, setSectionsPdfBusy] = useState(false);
  const [drainagePdfBusy, setDrainagePdfBusy] = useState(false);
  const [drainage2PdfBusy, setDrainage2PdfBusy] = useState(false);
  const handleExportSectionsDxf = async () => {
    if (!design || !boundary) {
      toast.error('Upload a KMZ site boundary first');
      return;
    }
    if (!fgSurface || !terrainYard) {
      toast.error('Enable grading (proposed FG surface) in the Terrain card first');
      return;
    }
    const exportName = (titleBlock.projectName.trim() || boundary.name).replace(/[^A-Za-z0-9_-]+/g, '_');
    try {
      const { buildGradingSections, buildGradingSectionsDxfString } = await import('../lib/nextera/gradingSections');
      const rect = terrainLocalRect(terrainYard, design.boundary.origin);
      const sections = buildGradingSections(terrainYard, rect, fgSurface, { quarterPoints: true });
      const content = buildGradingSectionsDxfString(design, exportName, sections, config, titleBlock);
      const saved = await saveBlob(
        new Blob([content], { type: 'application/dxf' }),
        `${exportName}_Grading_Sections_${new Date().toISOString().slice(0, 10)}.dxf`
      );
      if (saved) toast.success('Cross-sections DXF exported (screening — not for construction)');
    } catch (e: any) {
      toast.error(`Cross-sections export failed: ${e?.message ?? 'unknown error'}`);
    }
  };

  const handleExportSectionsPdf = async () => {
    if (!design || !boundary) {
      toast.error('Upload a KMZ site boundary first');
      return;
    }
    if (!fgSurface || !terrainYard) {
      toast.error('Enable grading (proposed FG surface) in the Terrain card first');
      return;
    }
    const exportName = (titleBlock.projectName.trim() || boundary.name).replace(/[^A-Za-z0-9_-]+/g, '_');
    setSectionsPdfBusy(true);
    try {
      // Rendered from the same display list the GP-2 DXF records, so the
      // PDF can never drift from the DXF sheet.
      const { buildGradingSections } = await import('../lib/nextera/gradingSections');
      const { buildGradingSectionsPdf } = await import('../lib/nextera/pdfPlot');
      const rect = terrainLocalRect(terrainYard, design.boundary.origin);
      const sections = buildGradingSections(terrainYard, rect, fgSurface, { quarterPoints: true });
      await new Promise(res => setTimeout(res, 30));
      const doc = buildGradingSectionsPdf(
        { design, projectName: exportName, config, meta: titleBlock },
        sections
      );
      const saved = await saveBlob(finalizePdfBlob(doc), `${exportName}_Grading_Sections_${new Date().toISOString().slice(0, 10)}.pdf`);
      if (saved) toast.success('Cross-sections PDF exported (1 page, ANSI D, vector)');
    } catch (e: any) {
      toast.error(`Cross-sections PDF export failed: ${e?.message ?? 'unknown error'}`);
    } finally {
      setSectionsPdfBusy(false);
    }
  };

  const handleExportDrainageDxf = async () => {
    if (!design || !boundary) {
      toast.error('Upload a KMZ site boundary first');
      return;
    }
    if (!fgSurface || !drainageModel) {
      toast.error('Enable grading and drainage screening in the Terrain card first');
      return;
    }
    const exportName = (titleBlock.projectName.trim() || boundary.name).replace(/[^A-Za-z0-9_-]+/g, '_');
    try {
      const { buildDrainageSheetDxfString } = await import('../lib/nextera/drainageSheet');
      const content = buildDrainageSheetDxfString(design, exportName, fgSurface, drainageModel, config, titleBlock);
      const saved = await saveBlob(
        new Blob([content], { type: 'application/dxf' }),
        `${exportName}_Drainage_Map_${new Date().toISOString().slice(0, 10)}.dxf`
      );
      if (saved) toast.success('Drainage area map DXF exported (screening — not for construction)');
    } catch (e: any) {
      toast.error(`Drainage map export failed: ${e?.message ?? 'unknown error'}`);
    }
  };

  const handleExportDrainagePdf = async () => {
    if (!design || !boundary) {
      toast.error('Upload a KMZ site boundary first');
      return;
    }
    if (!fgSurface || !drainageModel) {
      toast.error('Enable grading and drainage screening in the Terrain card first');
      return;
    }
    const exportName = (titleBlock.projectName.trim() || boundary.name).replace(/[^A-Za-z0-9_-]+/g, '_');
    setDrainagePdfBusy(true);
    try {
      // Rendered from the same display list the DR-1 DXF records, so the
      // PDF can never drift from the DXF sheet.
      const { buildDrainageSheetPdf } = await import('../lib/nextera/pdfPlot');
      await new Promise(res => setTimeout(res, 30));
      const doc = buildDrainageSheetPdf(
        { design, projectName: exportName, config, meta: titleBlock },
        fgSurface,
        drainageModel
      );
      const saved = await saveBlob(finalizePdfBlob(doc), `${exportName}_Drainage_Map_${new Date().toISOString().slice(0, 10)}.pdf`);
      if (saved) toast.success('Drainage area map PDF exported (1 page, ANSI D, vector)');
    } catch (e: any) {
      toast.error(`Drainage map PDF export failed: ${e?.message ?? 'unknown error'}`);
    } finally {
      setDrainagePdfBusy(false);
    }
  };

  const handleExportDrainage2Dxf = async () => {
    if (!design || !boundary) {
      toast.error('Upload a KMZ site boundary first');
      return;
    }
    if (!fgSurface || !drainageModel) {
      toast.error('Enable grading and drainage screening in the Terrain card first');
      return;
    }
    const exportName = (titleBlock.projectName.trim() || boundary.name).replace(/[^A-Za-z0-9_-]+/g, '_');
    try {
      const { buildDrainageDetailSheetDxfString } = await import('../lib/nextera/drainageDetailSheet');
      const content = buildDrainageDetailSheetDxfString(design, exportName, fgSurface, drainageModel, config, titleBlock);
      const saved = await saveBlob(
        new Blob([content], { type: 'application/dxf' }),
        `${exportName}_Drainage_Details_${new Date().toISOString().slice(0, 10)}.dxf`
      );
      if (saved) toast.success('Drainage details DXF exported (screening — not for construction)');
    } catch (e: any) {
      toast.error(`Drainage details export failed: ${e?.message ?? 'unknown error'}`);
    }
  };

  const handleExportDrainage2Pdf = async () => {
    if (!design || !boundary) {
      toast.error('Upload a KMZ site boundary first');
      return;
    }
    if (!fgSurface || !drainageModel) {
      toast.error('Enable grading and drainage screening in the Terrain card first');
      return;
    }
    const exportName = (titleBlock.projectName.trim() || boundary.name).replace(/[^A-Za-z0-9_-]+/g, '_');
    setDrainage2PdfBusy(true);
    try {
      // Rendered from the same display list the DR-2 DXF records, so the
      // PDF can never drift from the DXF sheet.
      const { buildDrainageDetailSheetPdf } = await import('../lib/nextera/pdfPlot');
      await new Promise(res => setTimeout(res, 30));
      const doc = buildDrainageDetailSheetPdf(
        { design, projectName: exportName, config, meta: titleBlock },
        fgSurface,
        drainageModel
      );
      const saved = await saveBlob(finalizePdfBlob(doc), `${exportName}_Drainage_Details_${new Date().toISOString().slice(0, 10)}.pdf`);
      if (saved) toast.success('Drainage details PDF exported (1 page, ANSI D, vector)');
    } catch (e: any) {
      toast.error(`Drainage details PDF export failed: ${e?.message ?? 'unknown error'}`);
    } finally {
      setDrainage2PdfBusy(false);
    }
  };

  const handleExportLandXml = async () => {
    if (!design || !boundary) {
      toast.error('Upload a KMZ site boundary first');
      return;
    }
    if (!fgSurface || !terrainYard) {
      toast.error('Enable grading (proposed FG surface) in the Terrain card first');
      return;
    }
    const exportName = (titleBlock.projectName.trim() || boundary.name).replace(/[^A-Za-z0-9_-]+/g, '_');
    try {
      const { buildLandXmlString } = await import('../lib/nextera/landxml');
      const rect = terrainLocalRect(terrainYard, design.boundary.origin);
      const content = buildLandXmlString(fgSurface, terrainYard, rect, exportName);
      const saved = await saveBlob(
        new Blob([content], { type: 'application/xml' }),
        `${exportName}_FG_Surface_LandXML_${new Date().toISOString().slice(0, 10)}.xml`
      );
      if (saved) toast.success('LandXML FG surface exported (local site coordinates, feet)');
    } catch (e: any) {
      toast.error(`LandXML export failed: ${e?.message ?? 'unknown error'}`);
    }
  };

  const [dxfPdfBusy, setDxfPdfBusy] = useState(false);
  const handleExportDxfPdf = async () => {
    if (!design || !boundary) {
      toast.error('Upload a KMZ site boundary first');
      return;
    }
    warnRoutingGatesForExport();
    const exportName = (titleBlock.projectName.trim() || boundary.name).replace(/[^A-Za-z0-9_-]+/g, '_');
    setDxfPdfBusy(true);
    try {
      // Rendered from the same display list buildDesignDxfString records, so
      // this single-page plot is always identical to the exported DXF. Pure
      // vector output — resolution-independent at any zoom / print DPI.
      const { buildDesignPdf } = await import('../lib/nextera/pdfPlot');
      const contours = await computeExportContours(design);
      // Opt-in "Issued for 10%" cover page ahead of the plot (aerial +
      // vicinity panels). Off ⇒ single page, byte-identical to legacy.
      let coverExtras: Partial<import('../lib/nextera/dxfSheets').SheetContext> = {};
      if (issuedFor10) {
        const satImg = await loadSatellite();
        if (!satImg) {
          const reason = useDesignStore.getState().satelliteError;
          toast.warning(`Cover satellite imagery unavailable${reason ? `: ${reason}` : ''} — exporting without it`);
        }
        const { satelliteLocalRect } = await import('../lib/nextera/satellite');
        coverExtras = {
          cover10: await buildCover10(satImg),
          // Hi-fi 3D cover renders (PDF only; null ⇒ vector overlay).
          ...(satImg
            ? { coverRenders: await captureCoverRenders(satelliteLocalRect(satImg, boundary.origin), { required: true }) }
            : {}),
          coverImage: satImg
            ? {
                dataUrl: satImg.dataUrl,
                widthPx: satImg.widthPx,
                heightPx: satImg.heightPx,
                localRect: satelliteLocalRect(satImg, boundary.origin),
              }
            : null,
          ...(yardRotationDeg !== 0 && satImg
            ? { yardRotation: { deg: yardRotationDeg, pivot: polygonPivot(boundary.polygon) } }
            : {}),
        };
      }
      await new Promise(res => setTimeout(res, 30));
      const doc = buildDesignPdf({
        design,
        projectName: exportName,
        drawingVisibility,
        config,
        meta: titleBlock,
        feeders,
        substation,
        contours,
        surfacingMesh: exportSurfacingMesh,
        ...(areaZones.length ? { areaZones } : {}),
        ...(eciLegend ? { eciLegend: true } : {}),
        ...(Object.keys(textOverrides).length ? { textOverrides } : {}),
        // Multi-area: plot exactly the footprints the drafter selected, from
        // the same composition the DXF export and the CAD view use.
        ...(siteExportInput ? { site: siteExportInput } : {}),
        ...coverExtras,
      });
      const saved = await saveBlob(finalizePdfBlob(doc), `${exportName}${exportFileTag()}_Design_Plot_${new Date().toISOString().slice(0, 10)}.pdf`);
      if (saved) toast.success(
        siteExportInput
          ? `Design PDF plot exported — ${exportScopeLabel}`
          : issuedFor10 ? 'Design PDF plot exported (10% cover + plan, ANSI D, vector)' : 'Design PDF plot exported (1 page, ANSI D, vector)');
    } catch (e: any) {
      toast.error(`PDF export failed: ${e?.message ?? 'unknown error'}`);
    } finally {
      setDxfPdfBusy(false);
    }
  };

  const [relayPdfBusy, setRelayPdfBusy] = useState(false);
  const handleExportRelayDxf = async () => {
    if (!design || !boundary) {
      toast.error('Upload a KMZ site boundary first');
      return;
    }
    if (!feeders.length) {
      toast.error('Place a substation to route feeders first — the relay one-line is built from the routed feeder circuits');
      return;
    }
    const exportName = (titleBlock.projectName.trim() || boundary.name).replace(/[^A-Za-z0-9_-]+/g, '_');
    try {
      // Small sheet (a few hundred entities) — built on the UI thread.
      const { buildRelayOneLineDxfString } = await import('../lib/nextera/relayOneLine');
      const content = buildRelayOneLineDxfString(design, exportName, feeders, config, titleBlock);
      const saved = await saveBlob(
        new Blob([content], { type: 'application/dxf' }),
        `${exportName}_Relay_One_Line_${new Date().toISOString().slice(0, 10)}.dxf`
      );
      if (saved) toast.success('Relay one-line DXF exported (screening placeholders — verify with protection study)');
    } catch (e: any) {
      toast.error(`Relay one-line export failed: ${e?.message ?? 'unknown error'}`);
    }
  };

  const handleExportRelayPdf = async () => {
    if (!design || !boundary) {
      toast.error('Upload a KMZ site boundary first');
      return;
    }
    if (!feeders.length) {
      toast.error('Place a substation to route feeders first — the relay one-line is built from the routed feeder circuits');
      return;
    }
    const exportName = (titleBlock.projectName.trim() || boundary.name).replace(/[^A-Za-z0-9_-]+/g, '_');
    setRelayPdfBusy(true);
    try {
      // Rendered from the same display list the relay DXF records, so the
      // PDF can never drift from the DXF sheet.
      const { buildRelayPdf } = await import('../lib/nextera/pdfPlot');
      await new Promise(res => setTimeout(res, 30));
      const doc = buildRelayPdf(
        { design, projectName: exportName, config, meta: titleBlock },
        feeders
      );
      const saved = await saveBlob(finalizePdfBlob(doc), `${exportName}_Relay_One_Line_${new Date().toISOString().slice(0, 10)}.pdf`);
      if (saved) toast.success('Relay one-line PDF exported (1 page, ANSI D, vector)');
    } catch (e: any) {
      toast.error(`Relay one-line PDF export failed: ${e?.message ?? 'unknown error'}`);
    } finally {
      setRelayPdfBusy(false);
    }
  };

  const [lgiaBusy, setLgiaBusy] = useState(false);
  const handleExportLgia = async () => {
    if (!design || !boundary) {
      toast.error('Upload a KMZ site boundary first');
      return;
    }
    const exportName = (titleBlock.projectName.trim() || boundary.name).replace(/[^A-Za-z0-9_-]+/g, '_');
    setLgiaBusy(true);
    try {
      // Pure model + PDF — placeholder fields explicitly marked; screening
      // fault contribution unless the per-bus study toggle is on.
      const { buildLgiaDataSheetModel, exportLgiaPdf } = await import('../lib/nextera/lgiaDataSheet');
      await new Promise(res => setTimeout(res, 30));
      const model = buildLgiaDataSheetModel(design, config, { titleBlock, feeders, substation, shortCircuitStudy: scStudy, lgiaInputs });
      const saved = await exportLgiaPdf(model, `${exportName}_LGIA_Data_Sheet_${new Date().toISOString().slice(0, 10)}.pdf`);
      if (saved) toast.success('LGIA-style facility data sheet PDF exported');
    } catch (e: any) {
      toast.error(`LGIA data sheet export failed: ${e?.message ?? 'unknown error'}`);
    } finally {
      setLgiaBusy(false);
    }
  };

  const [permitBusy, setPermitBusy] = useState(false);
  const handleExportPermit = async () => {
    if (!design || !boundary) {
      toast.error('Upload a KMZ site boundary first');
      return;
    }
    warnRoutingGatesForExport();
    const exportName = (titleBlock.projectName.trim() || boundary.name).replace(/[^A-Za-z0-9_-]+/g, '_');
    setPermitBusy(true);
    try {
      // Model + PDF are pure functions of the design/session state — every
      // number is derived from the same compliance/validation/BOM modules the
      // in-app panel and the DXF drawing use.
      const { buildPermitPacketModel, buildSitePermitPacketModel } = await import('../lib/nextera/permitReport');
      const { exportPermitPdf } = await import('../lib/nextera/permitPdf');
      const { contoursForDxf } = await import('../lib/nextera/terrain');
      await new Promise(res => setTimeout(res, 30));
      // A multi-area project submits ONE packet covering every area. Scoping
      // it to the active area produced a packet that looked complete while
      // describing a single phase.
      const multiArea = siteAreas.length > 1;
      const buildModel = (o: Parameters<typeof buildPermitPacketModel>[2]) =>
        multiArea
          ? buildSitePermitPacketModel(
              siteAreas.map(a => ({
                id: a.id,
                name: a.name,
                kind: a.kind,
                // The active area's live design carries in-flight edits;
                // every other area is described strictly by its OWN
                // persisted edits, never the active area's.
                design: a.id === activeAreaId ? design : a.design,
                // Each area's OWN routed feeders (they land on the substation
                // take-off aimed at that area); the active area's live routes
                // win for it because they carry in-flight edits.
                feeders: a.id === activeAreaId ? feeders : areaFeeders[a.id],
                // A BESS yard lands on its take-off in the SUBSTATION area,
                // so it has no local substation. The legacy field is null for
                // it, which drops its feeder-dependent packet findings.
                substation: areaFeederEndpoint(a, siteAreas, {
                  activeAreaId, liveEndpoint: feederEndpoint,
                }),
                areaZones: a.id === activeAreaId ? areaZones : (a.edits?.areaZones ?? null),
              })),
              config,
              o
            )
          : buildPermitPacketModel(design, config, o);
      const model = buildModel({
        hotClimate, titleBlock, feeders, substation,
        // Exclusion/pond/laydown zones feed the packet's validation +
        // compliance sections (exclusion-crossing audits must appear in the
        // exported packet, not just the in-app panel).
        ...(areaZones.length ? { areaZones } : {}),
        // Screening-grade rough-grading summary: same numbers the panel card
        // shows; omitted gracefully when no elevation data is loaded.
        earthwork: terrainYard && terrainAnalysis.cutFill
          ? (() => {
              const rect = terrainLocalRect(terrainYard, design.boundary.origin);
              const tie = computeGradingTieIn(terrainYard, rect, design.fence, terrainAnalysis.cutFill.padElevationFt);
              return {
                cutFill: terrainAnalysis.cutFill,
                steep: terrainAnalysis.steep,
                source: terrainYard.source,
                resolutionM: terrainYard.resolutionM,
                noDataCount: terrainYard.noDataCount,
                tieIn: tie
                  ? { maxCutFt: tie.maxCutFt, maxFillFt: tie.maxFillFt, slopeRatio: tie.slopeRatio }
                  : null,
                // Existing-grade contour figure: same deterministic contour
                // set the DXF reference layer exports, honoring the drafter's
                // interval selection (0 = auto) so the packet matches both the
                // in-panel preview and the DXF reference layer.
                contours: contoursForDxf(terrainYard, design.boundary.origin, contourIntervalFt),
              };
            })()
          : null,
        // Grounding screening takeoff: opt-in via the same toggle that gates
        // the DXF grounding layer, so the packet and the drawing always agree.
        grounding: exportGroundingDxf ? groundingPlan : null,
        // IEEE-80 study section: opt-in via its own toggle — same
        // byte-identity convention as the other optional sections.
        ieee80: ieee80Study,
      });
      const saved = await exportPermitPdf(
        model,
        `${exportName}_Permit_Packet_${new Date().toISOString().slice(0, 10)}.pdf`,
        design,
        drawingVisibility
      );
      if (saved) toast.success('Permit packet PDF exported');
    } catch (e: any) {
      toast.error(`Permit packet export failed: ${e?.message ?? 'unknown error'}`);
    } finally {
      setPermitBusy(false);
    }
  };

  const [poiBusy, setPoiBusy] = useState(false);
  const handleExportPoi = async () => {
    if (!design || !boundary) {
      toast.error('Upload a KMZ site boundary first');
      return;
    }
    const exportName = (titleBlock.projectName.trim() || boundary.name).replace(/[^A-Za-z0-9_-]+/g, '_');
    setPoiBusy(true);
    try {
      // Pure model + one-page PDF — every number derived from the same
      // design/catalog/feeder modules the drawings use.
      const { buildPoiDataSheetModel, exportPoiPdf } = await import('../lib/nextera/poiDataSheet');
      await new Promise(res => setTimeout(res, 30));
      const model = buildPoiDataSheetModel(design, config, { titleBlock, feeders, substation, shortCircuitStudy: scStudy, protectionStudy });
      const saved = await exportPoiPdf(model, `${exportName}_POI_Data_Sheet_${new Date().toISOString().slice(0, 10)}.pdf`);
      if (saved) toast.success('POI data sheet PDF exported');
    } catch (e: any) {
      toast.error(`POI data sheet export failed: ${e?.message ?? 'unknown error'}`);
    } finally {
      setPoiBusy(false);
    }
  };

  const handleSaveProject = async () => {
    const json = exportProjectJson();
    if (!json) {
      toast.error('Load a site boundary first');
      return;
    }
    const exportName = (titleBlock.projectName.trim() || boundary?.name || 'nextera-project').replace(/[^A-Za-z0-9_-]+/g, '_');
    try {
      const saved = await saveBlob(new Blob([json], { type: 'application/json;charset=utf-8' }), `${exportName}.bessforge.json`);
      if (saved) toast.success('Project file saved');
    } catch (e: any) {
      toast.error(`Save failed: ${e?.message ?? 'unknown error'}`);
    }
  };

  const handleOpenProject = async (file: File | undefined) => {
    if (!file) return;
    const text = await file.text();
    const err = importProject(text);
    if (err) toast.error(err);
    else toast.success('Project loaded');
    if (projectFileRef.current) projectFileRef.current.value = '';
  };

  const handleExportBom = async () => {
    if (!design || !boundary) {
      toast.error('Upload a KMZ site boundary first');
      return;
    }
    const exportName = (titleBlock.projectName.trim() || boundary.name).replace(/[^A-Za-z0-9_-]+/g, '_');
    // Multi-area sites export one section per area plus a WHOLE SITE total,
    // so the packet covers every yard instead of just the one on screen.
    // Single-area projects keep the original flat CSV byte-for-byte.
    const csv = siteAreas.length > 1
      ? siteBomToCsv(buildSiteBom(
          siteAreas.map(a => {
            const d = a.id === activeAreaId ? design : a.design;
            return {
              name: a.name,
              rows: d
                ? buildBomRows(d, config, a.id === activeAreaId ? feeders : undefined, a.id === activeAreaId ? groundingPlan : undefined)
                : [],
            };
          })
        ))
      : bomToCsv(buildBomRows(design, config, feeders, groundingPlan));
    try {
      const saved = await saveBlob(new Blob([csv], { type: 'text/csv;charset=utf-8' }), `${exportName}_BOM.csv`);
      if (saved) toast.success('BOM CSV exported');
    } catch (e: any) {
      toast.error(`BOM export failed: ${e?.message ?? 'unknown error'}`);
    }
  };

  const bomRollupSummary = useMemo(() => {
    if (!design) return null;
    try {
      const rows = buildCableScheduleRows(design, feeders);
      const rollup = buildBomRollup(rows, design, feeders, groundingPlan);
      const lines: { label: string; value: string }[] = [];
      for (const l of rollup.cable) {
        lines.push({ label: l.description.replace(/ \(.*$/, ''), value: `${l.qty.toLocaleString()} LF` });
      }
      const totalTerms = rollup.terminations.reduce((s, l) => s + l.qty, 0);
      if (totalTerms) lines.push({ label: 'CABLE TERMINATIONS', value: `${totalTerms.toLocaleString()} EA` });
      const totalSticks = rollup.conduit.reduce((s, l) => s + l.qty, 0);
      if (totalSticks) lines.push({ label: `CONDUIT STICKS (${20} FT)`, value: `${totalSticks.toLocaleString()} EA` });
      for (const l of rollup.civil) {
        lines.push({ label: l.description.replace(/ \(.*$/, ''), value: `${l.qty.toLocaleString()} ${l.unit}` });
      }
      for (const l of rollup.grounding) {
        lines.push({ label: l.description.replace(/ \(.*$/, ''), value: `${l.qty.toLocaleString()} ${l.unit}` });
      }
      return lines;
    } catch {
      return null;
    }
  }, [design, feeders, groundingPlan]);

  const handleExportCableScheduleCsv = async () => {
    if (!design || !boundary) {
      toast.error('Upload a KMZ site boundary first');
      return;
    }
    const exportName = (titleBlock.projectName.trim() || boundary.name).replace(/[^A-Za-z0-9_-]+/g, '_');
    try {
      const { buildCableScheduleRows, cableScheduleToCsv } = await import('../lib/nextera/cableSchedule');
      const csv = cableScheduleToCsv(buildCableScheduleRows(design, feeders));
      const saved = await saveBlob(new Blob([csv], { type: 'text/csv;charset=utf-8' }), `${exportName}_Cable_Schedule.csv`);
      if (saved) toast.success('Cable schedule CSV exported');
    } catch (e: any) {
      toast.error(`Cable schedule export failed: ${e?.message ?? 'unknown error'}`);
    }
  };

  const handleExportCableScheduleDxf = async () => {
    if (!design || !boundary) {
      toast.error('Upload a KMZ site boundary first');
      return;
    }
    const exportName = (titleBlock.projectName.trim() || boundary.name).replace(/[^A-Za-z0-9_-]+/g, '_');
    try {
      const { buildCableScheduleDxfString } = await import('../lib/nextera/cableSchedule');
      const content = buildCableScheduleDxfString(design, exportName, feeders, config, titleBlock);
      const saved = await saveBlob(
        new Blob([content], { type: 'application/dxf' }),
        `${exportName}_Cable_Schedule_${new Date().toISOString().slice(0, 10)}.dxf`
      );
      if (saved) toast.success('Cable schedule DXF exported');
    } catch (e: any) {
      toast.error(`Cable schedule DXF export failed: ${e?.message ?? 'unknown error'}`);
    }
  };

  const handleExportFullBom = async () => {
    if (!design || !boundary) {
      toast.error('Upload a KMZ site boundary first');
      return;
    }
    const exportName = (titleBlock.projectName.trim() || boundary.name).replace(/[^A-Za-z0-9_-]+/g, '_');
    try {
      const { buildCableScheduleRows } = await import('../lib/nextera/cableSchedule');
      const { buildBomRollup, fullBomToCsv } = await import('../lib/nextera/bomRollup');
      const rows = buildCableScheduleRows(design, feeders);
      const csv = fullBomToCsv(design, config, feeders, buildBomRollup(rows, design, feeders, groundingPlan));
      const saved = await saveBlob(new Blob([csv], { type: 'text/csv;charset=utf-8' }), `${exportName}_Full_BOM.csv`);
      if (saved) toast.success('Full BOM CSV exported');
    } catch (e: any) {
      toast.error(`Full BOM export failed: ${e?.message ?? 'unknown error'}`);
    }
  };

  return (
    <div className="w-96 shrink-0 h-full overflow-y-auto bg-slate-900 text-slate-100 border-r border-slate-700 flex flex-col">
      {/* Header */}
      <div className="p-4 border-b border-slate-700 bg-slate-950">
        <div className="flex items-center gap-3">
          <img src={assetUrl('/eci-logo.svg')} alt="ECI" className="h-10 w-auto bg-white rounded p-1" />
          <div>
            <div className="font-bold text-sm leading-tight">BESSForge</div>
            <div className="text-xs text-slate-400">BESS 10% Design Tool</div>
          </div>
        </div>
        <div className="text-[10px] text-slate-500 mt-2">
          Per NextEra Site Plan Guidance R2 (5-14-2026)
        </div>
      </div>

      <div className="p-4 space-y-5 flex-1">
        {/* Saved-session restore banner */}
        {savedSession && !boundary && (
          <div className="bg-cyan-950/60 border border-cyan-700 rounded p-3 text-sm">
            <div className="font-medium text-cyan-200">Resume previous session?</div>
            <div className="text-xs text-slate-300 mt-1 truncate">
              {savedSession.boundary.name}
              {savedSession.savedAt ? ` — saved ${new Date(savedSession.savedAt).toLocaleString()}` : ''}
            </div>
            <div className="flex gap-2 mt-2">
              <button
                onClick={() => { restoreSession(); toast.success('Session restored'); }}
                className="flex-1 py-1.5 rounded bg-cyan-600 hover:bg-cyan-500 text-xs font-semibold"
              >
                Restore
              </button>
              <button
                onClick={dismissSavedSession}
                className="flex-1 py-1.5 rounded bg-slate-700 hover:bg-slate-600 text-xs"
              >
                Dismiss
              </button>
            </div>
          </div>
        )}

        {/* Step 1: KMZ upload */}
        <PanelSection id="site" title="1. Site Boundary (KMZ)" discipline="Layout">
          <input
            ref={fileRef}
            type="file"
            accept=".kmz,.kml"
            className="hidden"
            onChange={e => handleFile(e.target.files?.[0])}
          />
          {!boundary ? (
            <button
              onClick={() => fileRef.current?.click()}
              disabled={isLoading}
              className="w-full py-3 rounded border-2 border-dashed border-slate-600 hover:border-cyan-500 hover:bg-slate-800 text-sm text-slate-300 transition-colors"
            >
              {isLoading ? 'Parsing…' : 'Upload KMZ site boundary'}
            </button>
          ) : (
            <div className="bg-slate-800 rounded p-3 text-sm">
              <div className="font-medium truncate">{boundary.name}</div>
              <div className="text-slate-400 text-xs mt-1">
                Parcel area: {boundary.areaAcres.toFixed(1)} acres
              </div>
              <div className="flex gap-2 mt-2">
                <button
                  onClick={() => fileRef.current?.click()}
                  className="text-xs px-2 py-1 rounded bg-slate-700 hover:bg-slate-600"
                >
                  Replace
                </button>
                <button
                  onClick={clearSite}
                  className="text-xs px-2 py-1 rounded bg-slate-700 hover:bg-red-800"
                >
                  Remove
                </button>
              </div>
            </div>
          )}
          {error && <div className="text-xs text-red-400 mt-2">{error}</div>}
          <ImportedDrawingLayerList />
          <ReferenceAutoFill />
          {boundaryPicker && (
            <div className="mt-3 bg-slate-800 border border-cyan-700 rounded p-3">
              <div className="text-xs font-medium text-cyan-200 mb-2">
                {boundaryPicker.sourceName}: {boundaryPicker.options.length} areas found
              </div>
              {/* Primary path for phase-footprint drawings: bring every
                  outline in as ONE project, positioned relative to each
                  other, instead of designing a single footprint in
                  isolation. */}
              <button
                disabled={!!busyOverlay}
                onClick={() => {
                  void (async () => {
                    setBusyOverlay({ label: 'Loading all site areas…', frac: 0 });
                    try {
                      await chooseAllBoundariesWithProgress((frac, label) => {
                        setBusyOverlay({ label, frac });
                      });
                      const err = useDesignStore.getState().error;
                      if (err) toast.error(err);
                      else {
                        const n = useDesignStore.getState().siteAreas.length;
                        toast.success(`Whole site loaded — ${n} areas`);
                      }
                    } finally {
                      setBusyOverlay(null);
                    }
                  })();
                }}
                className="w-full mb-2 py-2 rounded bg-cyan-600 hover:bg-cyan-500 disabled:opacity-60 text-xs font-semibold text-white transition-colors"
              >
                {busyOverlay ? 'Loading…' : `Show all ${boundaryPicker.options.length} areas as one site`}
              </button>
              <div className="text-[10px] uppercase tracking-wide text-slate-500 mb-1.5">
                or design a single area
              </div>
              <div className="flex flex-col gap-1.5">
                {boundaryPicker.options.map(o => (
                  <button
                    key={o.index}
                    onClick={() => {
                      chooseBoundary(o.index);
                      const err = useDesignStore.getState().error;
                      if (err) toast.error(err);
                      else toast.success(`${o.name} loaded`);
                    }}
                    className="text-left text-xs px-2 py-1.5 rounded bg-slate-900 hover:bg-slate-700 border border-slate-600 text-slate-200 transition-colors"
                  >
                    <span className="font-medium">{o.name}</span>
                    <span className="text-slate-400"> — {o.areaAcres.toFixed(1)} ac</span>
                  </button>
                ))}
              </div>
              <button
                onClick={cancelBoundaryPicker}
                className="mt-2 w-full py-1 rounded bg-slate-700 hover:bg-slate-600 text-xs text-slate-300"
              >
                Cancel
              </button>
            </div>
          )}
          {/* Multi-area site: every footprint is part of ONE project. The
              whole site stays visible in the scene; this switches which area
              the drafter is actively editing. */}
          {siteAreas.length > 1 && (
            <div className="mt-3 bg-slate-800 border border-slate-600 rounded p-3">
              <div className="text-[10px] uppercase tracking-wide text-slate-400 mb-2">
                Site areas ({siteAreas.length}) — editing
              </div>
              <div className="flex flex-col gap-1.5">
                {siteAreas.map(a => (
                  <button
                    key={a.id}
                    disabled={switchingAreaId !== null}
                    onClick={() => {
                      if (a.id === activeAreaId) return;
                      // Switching rebuilds feeder routes and remounts the
                      // scene, which can take a beat on large yards — show
                      // the busy state BEFORE the synchronous work starts.
                      setSwitchingAreaId(a.id);
                      requestAnimationFrame(() => requestAnimationFrame(() => {
                        try { setActiveArea(a.id); } finally { setSwitchingAreaId(null); }
                      }));
                    }}
                    className={`text-left text-xs px-2 py-1.5 rounded border transition-colors disabled:opacity-70 ${
                      a.id === activeAreaId
                        ? 'bg-cyan-900/60 border-cyan-500 text-cyan-100'
                        : 'bg-slate-900 border-slate-600 text-slate-300 hover:bg-slate-700'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium truncate">{a.name}</span>
                      <span className="text-[10px] uppercase text-slate-400 shrink-0">
                        {switchingAreaId === a.id
                          ? 'Loading…'
                          : a.kind === 'substation' ? 'Substation' : a.kind === 'bess' ? 'BESS' : 'Area'}
                      </span>
                    </div>
                    <div className="text-slate-400 text-[10px] mt-0.5">
                      {a.boundary.areaAcres.toFixed(1)} ac
                      {a.design && a.kind === 'bess' && ` — ${a.design.blocksPlaced + (a.design.tracedPcsUnits ?? 0)} blocks, ${a.design.achievedMW.toFixed(1)} MW`}
                      {a.design && a.kind === 'bess' && ((a.design.tracedAugPcsUnits ?? 0) > 0 || (a.design.tracedFuturePcsUnits ?? 0) > 0) && (
                        <span className="text-amber-300/80">
                          {(a.design.tracedAugPcsUnits ?? 0) > 0 && ` +${a.design.tracedAugPcsUnits} aug PCS`}
                          {(a.design.tracedFuturePcsUnits ?? 0) > 0 && ` +${a.design.tracedFuturePcsUnits} future PCS`}
                          {' (not counted)'}
                        </span>
                      )}
                      {a.error && <span className="text-amber-400"> — {a.error}</span>}
                    </div>
                  </button>
                ))}
              </div>
              <div className="text-[10px] text-slate-400 mt-2">
                Whole site:{' '}
                {siteAreas.reduce((s, a) => s + (a.design?.achievedMW ?? 0), 0).toFixed(1)} MW ·{' '}
                {siteAreas.reduce((s, a) => s + (a.design?.blocksPlaced ?? 0) + (a.design?.tracedPcsUnits ?? 0), 0)} blocks ·{' '}
                {siteAreas.reduce((s, a) => s + a.boundary.areaAcres, 0).toFixed(1)} ac
              </div>
            </div>
          )}

          {/* Substation MV take-offs. Only meaningful while a substation area
              is the active one: a take-off lives inside that yard's fence and
              decides where ONE BESS area's feeders land. */}
          {siteAreas.length > 1 && activeArea?.kind === 'substation' && (
            <div className="mt-3 bg-slate-800 border border-slate-600 rounded p-3">
              <div className="text-[10px] uppercase tracking-wide text-slate-400 mb-2">
                MV take-offs — {activeArea.name}
              </div>
              {activeTakeoffs.length === 0 && (
                <div className="text-[11px] text-amber-400 mb-2">
                  No take-offs — no BESS feeders land in this yard.
                </div>
              )}
              <div className="flex flex-col gap-2">
                {activeTakeoffs.map(t => (
                  <div key={t.id} className="bg-slate-900 border border-slate-700 rounded p-2 space-y-1.5">
                    <div className="flex items-center gap-1.5">
                      <select
                        value={t.servesAreaId ?? ''}
                        onChange={e => {
                          const why = setTakeoffServes(t.id, e.target.value || null);
                          if (why) toast.warning(why);
                        }}
                        className="flex-1 bg-slate-800 border border-slate-600 rounded px-1.5 py-1 text-xs text-slate-100"
                      >
                        <option value="">— collects nothing —</option>
                        {bessAreaOptions.map(a => (
                          <option key={a.id} value={a.id}>{a.name}</option>
                        ))}
                      </select>
                      <select
                        value={t.dir}
                        onChange={e => {
                          const why = aimTakeoff(t.id, e.target.value as TakeoffDirection);
                          if (why) toast.warning(why);
                        }}
                        title="Direction the feeders travel as they land here"
                        className="bg-slate-800 border border-slate-600 rounded px-1.5 py-1 text-xs text-slate-100"
                      >
                        {TAKEOFF_DIRECTIONS.map(d => (
                          <option key={d} value={d}>{d}</option>
                        ))}
                      </select>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <button
                        onClick={() => setPlacingTakeoff(placingTakeoffId === t.id ? null : t.id)}
                        className={`flex-1 text-[11px] px-2 py-1 rounded transition-colors ${
                          placingTakeoffId === t.id
                            ? 'bg-amber-600 hover:bg-amber-500 text-white'
                            : 'bg-slate-700 hover:bg-slate-600 text-slate-200'
                        }`}
                      >
                        {placingTakeoffId === t.id ? 'Click map to move… (cancel)' : 'Move'}
                      </button>
                      <button
                        onClick={() => {
                          const why = removeTakeoff(t.id);
                          if (why) toast.warning(why);
                        }}
                        className="text-[11px] px-2 py-1 rounded bg-slate-700 hover:bg-red-800 text-slate-200"
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                ))}
              </div>
              <button
                onClick={() => {
                  const why = addTakeoff(null);
                  if (why) toast.warning(why);
                }}
                className="w-full mt-2 text-[11px] px-2 py-1.5 rounded bg-slate-700 hover:bg-slate-600 text-slate-200"
              >
                + Add take-off
              </button>
              <div className="text-[10px] text-slate-400 mt-2">
                Each take-off collects one BESS area's feeders. The compass
                value is the direction those feeders travel as they arrive.
              </div>
            </div>
          )}
          <div className="mt-3">
            <div className="text-[10px] uppercase tracking-wide text-slate-500 mb-1.5">
              Sample sites
            </div>
            <div className="flex flex-col gap-1.5">
              {SAMPLE_SITES.map(s => (
                <button
                  key={s.url}
                  onClick={() => handleSample(s)}
                  disabled={isLoading}
                  className="text-left text-xs px-2 py-1.5 rounded bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 transition-colors"
                >
                  {s.name}
                </button>
              ))}
            </div>
          </div>
        </PanelSection>

        {/* Step 2: Configuration */}
        <PanelSection id="equipment" title="2. Equipment Configuration" discipline="Layout">
          <select
            value={configId}
            onChange={e => setConfigId(e.target.value)}
            className="w-full bg-slate-800 border border-slate-600 rounded px-2 py-2 text-sm"
          >
            {CONFIGURATIONS.map(c => (
              <option key={c.id} value={c.id}>{c.label}</option>
            ))}
          </select>
          <div className="text-[11px] text-slate-400 mt-2 space-y-0.5">
            <div>BESS: LG JF2 DCLINK 5.1 (23'-6" × 8'-5")</div>
            <div>PCS: {config.inverterModel}</div>
            <div>Aux equipment: {config.hasAuxEquipment ? 'Yes (xfmr + swgr)' : 'No'}</div>
          </div>
          <div className="mt-3 text-[11px] space-y-1">
            {config.inverterModel === 'GE FLEX 1571' ? (
              <>
                <div className="text-slate-300">
                  <span className="font-medium text-emerald-300">Four-hour standard:</span>{' '}
                  QTY 3 LG containers / PCS — {(config.containersPerBlock * config.containerMWh).toFixed(3)} MWh and {config.blockMW.toFixed(3)} MW credited continuous output per block.
                </div>
                <div className="text-slate-500">
                  GE FLEXINVERTER capability: {config.pcsCapabilityMW.toFixed(2)} MW. Project capacity is credited from the battery-backed continuous output, not the PCS capability.
                </div>
                {containersPerPcs === 4 && (
                  <div className="text-amber-300">
                    Legacy QTY 4 layout preserved: {(config.containersPerBlock * config.containerMWh).toFixed(3)} MWh / {config.blockMW.toFixed(2)} MW credited; select a GE configuration again to return to the QTY 3 standard.
                  </div>
                )}
              </>
            ) : (
              <div className="text-slate-500">
                This Power Electronics configuration retains its catalog block composition; its container standard is reviewed separately.
              </div>
            )}
          </div>
          <label className="flex items-center gap-2 mt-3 text-sm">
            <input
              type="checkbox"
              checked={hotClimate}
              onChange={e => setHotClimate(e.target.checked)}
            />
            <span>Hot climate site (&gt;40°C) — 14 ft PCS clearance and 14 ft between blocks (10 ft each below 40°C)</span>
          </label>
        </PanelSection>

        {/* Step 3: Target */}
        <PanelSection id="target" title="3. Target Rating" discipline="Layout · Civil">
          <div className="grid grid-cols-2 gap-3">
            <label className="text-xs text-slate-400">
              Power (MW)
              <input
                type="number"
                min={1}
                step={1}
                value={targetMW}
                onChange={e => setTargetMW(Math.max(1, Number(e.target.value) || 1))}
                className="w-full mt-1 bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-sm text-slate-100"
              />
            </label>
            <label className="text-xs text-slate-400">
              Energy (MWh)
              <input
                type="number"
                min={1}
                step={1}
                value={targetMWh}
                onChange={e => setTargetMWh(Math.max(1, Number(e.target.value) || 1))}
                className="w-full mt-1 bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-sm text-slate-100"
              />
            </label>
          </div>
          {kmzFenceStandard ? (
            <div className="text-xs text-slate-400 block mt-3" data-testid="kmz-fence-placement-standard">
              Security Fence Line
              <div className="w-full mt-1 bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-sm text-slate-100">
                On property boundary — KMZ traced-yard standard
              </div>
              <span className="block mt-1 text-[11px] leading-snug text-slate-500">
                The purple property boundary is also this area's security fence.
                Clearances, gates, roads, grounding, and cable routing all use
                that same perimeter.
              </span>
            </div>
          ) : (
            <label className="text-xs text-slate-400 block mt-3" data-testid="select-fence-placement-label">
              Security Fence Line
              <select
                value={fencePlacement ?? 'inset'}
                onChange={e => setFencePlacement(e.target.value as 'inset' | 'property-line')}
                className="w-full mt-1 bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-sm text-slate-100"
                data-testid="select-fence-placement"
              >
                <option value="inset">Inset from property boundary — 25 ft setback (default)</option>
                <option value="property-line">On property boundary — fence is the property line</option>
              </select>
              <span className="block mt-1 text-[11px] leading-snug text-slate-500">
                Use the property line only when the EOR/civil design puts the fence
                there — this app does not verify that a parcel may be fenced on its
                boundary. Equipment keeps every inside-fence clearance either way,
                and the imported boundary stays on the drawings as a separate
                reference line.
              </span>
            </label>
          )}
          <label className="text-xs text-slate-400 block mt-3">
            Site Access Roads
            <select
              value={roadMode}
              onChange={e => setRoadMode(e.target.value as 'auto' | 'roads' | 'compact')}
              className="w-full mt-1 bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-sm text-slate-100"
            >
              <option value="auto">Auto — preserve roads for multi-area sites; report any shortfall</option>
              <option value="roads">Always include roads (perimeter + drive aisles)</option>
              <option value="compact">Compact — no interior roads (max blocks)</option>
            </select>
          </label>
          <label className="flex items-center gap-2 text-xs text-slate-400 mt-2 cursor-pointer">
            <input
              type="checkbox"
              checked={autoRoadWrap}
              onChange={e => setAutoRoadWrap(e.target.checked)}
              className="accent-sky-500"
            />
            Auto-wrap roads around placed equipment
          </label>
          <label className="text-xs text-slate-400 block mt-3">
            Perimeter Road Ring
            <select
              value={ringMode}
              onChange={e => setRingMode(e.target.value as 'fence' | 'shrink' | 'hybrid')}
              className="w-full mt-1 bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-sm text-slate-100"
            >
              <option value="fence">Full fence ring — follow the entire fence line</option>
              <option value="shrink">Shrink-wrap — hug the equipment cluster</option>
              <option value="hybrid">Hybrid — hug only sides far from the fence</option>
            </select>
          </label>
          <label className="text-xs text-slate-400 block mt-3">
            Perimeter Road Outer Edge
            <select
              value={perimeterBand ?? 'standard'}
              onChange={e => setPerimeterBand(e.target.value as 'standard' | 'flush')}
              className="w-full mt-1 bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-sm text-slate-100"
            >
              <option value="standard">Standard — 10 ft inset from fence (NFPA 855 default)</option>
              <option value="flush">Flush with fence line — road reaches the boundary</option>
            </select>
          </label>
          <label className="text-xs text-slate-400 block mt-3">
            DC run routing (container to PCS)
            <select
              value={dcRouting}
              onChange={e => setDcRouting(e.target.value as 'orthogonal' | 'direct')}
              className="w-full mt-1 bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-sm text-slate-100"
            >
              <option value="orthogonal">90° trench legs (sheet-3 standard)</option>
              <option value="direct">Direct — straight-line runs</option>
            </select>
          </label>
          <label className="flex items-center gap-2 mt-3 text-xs text-slate-400 cursor-pointer" data-testid="toggle-dead-space-trim">
            <input
              type="checkbox"
              checked={deadSpaceTrim}
              onChange={e => setDeadSpaceTrim(e.target.checked)}
              className="accent-emerald-500"
            />
            Dead-space trim — shrink fence to minimum compliant hull, clip rock courtyards to contents
          </label>
          {(design?.islands?.length ?? 0) >= 2 && (
            <label
              className="flex items-center gap-2 mt-2 text-xs text-slate-400 cursor-pointer"
              data-testid="toggle-align-islands"
              title="Shift island columns onto a shared grid line. Islands at a tighter row pitch lose their augmentation zones when aligned."
            >
              <input
                type="checkbox"
                checked={layoutEdits.alignIslands === true}
                onChange={e => setAlignIslands(e.target.checked)}
                className="accent-emerald-500"
              />
              Align island columns (may remove augmentation zones)
            </label>
          )}
          <div className="grid grid-cols-2 gap-3 mt-3">
            <label className="text-xs text-slate-400">
              Rock surfacing coverage
              <select
                value={surfacingMode}
                onChange={e => setSurfacingMode(e.target.value as 'between-roads' | 'full-yard')}
                className="w-full mt-1 bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-sm text-slate-100"
              >
                <option value="between-roads">Between roads (courtyards only)</option>
                <option value="full-yard">Everything inside fence</option>
              </select>
            </label>
            <label className="text-xs text-slate-400">
              Rock depth (inches)
              <input
                type="number"
                min={1}
                max={24}
                step={1}
                value={surfacingDepthIn}
                onChange={e => setSurfacingDepthIn(Number(e.target.value) || 4)}
                className="w-full mt-1 bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-sm text-slate-100"
              />
            </label>
          </div>
          {design?.surfacing && design.surfacing.areaSqFt > 0 && (
            <div className="text-[11px] text-slate-400 mt-2 bg-slate-800 rounded p-2">
              Crushed rock: {(design.surfacing.areaSqFt / 43560).toFixed(2)} acres at {design.surfacing.depthIn}&quot; — approx. {Math.ceil(design.surfacing.tons).toLocaleString()} tons
            </div>
          )}
          <div className="mt-3">
            <div className="text-xs text-slate-400 mb-1">Yard textures (3D preview only)</div>
            <div className="grid grid-cols-1 gap-1">
              {YARD_TEXTURE_SETS.map(ts => (
                <button
                  key={ts.id}
                  onClick={() => {
                    setTextureSetId(ts.id);
                    toast.success(`Yard textures: ${ts.label}`);
                  }}
                  title={ts.source}
                  className={`flex items-center gap-2 px-2 py-1.5 rounded border text-left text-xs transition-colors ${
                    textureSetId === ts.id
                      ? 'border-cyan-500 bg-slate-800 text-slate-100'
                      : 'border-slate-700 bg-slate-800/40 text-slate-300 hover:border-slate-500'
                  }`}
                >
                  {ts.thumb ? (
                    <img src={assetUrl(ts.thumb)} alt="" className="w-6 h-6 rounded object-cover shrink-0" />
                  ) : (
                    <span className="w-6 h-6 rounded shrink-0 bg-slate-600 inline-block" />
                  )}
                  <span className="flex-1 truncate">{ts.label}</span>
                  {textureSetId === ts.id && <span className="text-cyan-400">✓</span>}
                </button>
              ))}
            </div>
            <div className="text-[10px] text-slate-500 mt-1">
              CC0 textures from Poly Haven / ambientCG. Does not affect DXF/PDF exports.
            </div>
          </div>
          {getEffectiveConfiguration(configId, containersPerPcs)?.inverterModel === 'GE FLEX 1571' && (
            <div className="mt-3" data-testid="ge-pcs-color-control">
              <div className="text-xs text-slate-400 mb-1" title="Repaint the GE PCS container exterior in the 3D preview: body panels take the chosen color, the baked GE Vernova logos and lettering go white — like the factory green units. Display only, DXF/PDF exports unaffected.">
                GE PCS exterior color (3D preview only)
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  onClick={() => setGePcsColor(null)}
                  data-testid="ge-pcs-color-factory"
                  className={`px-2 py-1.5 rounded border text-xs transition-colors ${
                    gePcsColor === null
                      ? 'border-cyan-500 bg-slate-800 text-slate-100'
                      : 'border-slate-700 bg-slate-800/40 text-slate-300 hover:border-slate-500'
                  }`}
                >
                  Factory
                </button>
                <button
                  onClick={() => setGePcsColor(GE_PCS_GREEN)}
                  data-testid="ge-pcs-color-green"
                  className={`flex items-center gap-1.5 px-2 py-1.5 rounded border text-xs transition-colors ${
                    gePcsColor === GE_PCS_GREEN
                      ? 'border-cyan-500 bg-slate-800 text-slate-100'
                      : 'border-slate-700 bg-slate-800/40 text-slate-300 hover:border-slate-500'
                  }`}
                >
                  <span className="w-3 h-3 rounded-sm inline-block border border-slate-600" style={{ background: GE_PCS_GREEN }} />
                  GE green
                </button>
                <label
                  data-testid="ge-pcs-color-custom"
                  className={`flex items-center gap-1.5 px-2 py-1.5 rounded border text-xs cursor-pointer transition-colors ${
                    gePcsColor !== null && gePcsColor !== GE_PCS_GREEN
                      ? 'border-cyan-500 bg-slate-800 text-slate-100'
                      : 'border-slate-700 bg-slate-800/40 text-slate-300 hover:border-slate-500'
                  }`}
                >
                  <input
                    type="color"
                    value={gePcsColor ?? GE_PCS_GREEN}
                    onChange={e => setGePcsColor(e.target.value)}
                    className="w-4 h-4 p-0 border-0 bg-transparent cursor-pointer"
                  />
                  Custom
                </label>
              </div>
              <div className="text-[10px] text-slate-500 mt-1">
                Logos and lettering stay white on any body color.
              </div>
            </div>
          )}
          <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400 mt-3 mb-1" title="Heavier preview features are off by default so the 3D view stays fast; turn on what you need. All display-only — DXF/PDF exports unaffected.">
            Display &amp; performance
          </div>
          <label className="flex items-center gap-2 mt-2 text-sm" title="Scale equipment labels up as you zoom out and hide them beyond viewing distance. Off = static labels with zero per-frame label work (fastest).">
            <input
              type="checkbox"
              checked={labelDistanceScaling}
              onChange={e => setLabelDistanceScaling(e.target.checked)}
              disabled={!drawingVisibility.labels}
            />
            <span>Label zoom scaling</span>
          </label>
          <label className="flex items-center gap-2 mt-2 text-sm" title="Per-feeder color palette in the preview (PCS tint, feeder lines, legend). Turn off for a neutral single-color plan check. Display only — DXF/PDF exports keep their colors.">
            <input
              type="checkbox"
              checked={showFeederColors}
              onChange={e => setShowFeederColors(e.target.checked)}
            />
            <span>Feeder colors in preview</span>
          </label>
          <label className="flex items-center gap-2 mt-2 text-sm" title="Place the uploaded gate 3D model at the fence entrance — 3D preview only, DXF/PDF unaffected">
            <input
              type="checkbox"
              checked={showGateModel}
              onChange={e => setShowGateModel(e.target.checked)}
            />
            <span>3D gate model at entrance</span>
          </label>
          <label className="flex items-center gap-2 mt-2 text-sm" title="Render textured chain-link fence panels along the fence line — 3D preview only, DXF/PDF unaffected">
            <input
              type="checkbox"
              checked={showFence3D}
              onChange={e => setShowFence3D(e.target.checked)}
            />
            <span>3D fence along fence line</span>
          </label>
          <label className="flex items-center gap-2 mt-2 text-sm" title="Drape real high-resolution aerial imagery of the site location (Cesium ion / Bing) on the ground plane, georegistered to the parcel. Also embedded on the PDF cover page. Never affects layout math or DXF geometry.">
            <input
              type="checkbox"
              checked={showSatellite}
              onChange={e => setShowSatellite(e.target.checked)}
            />
            <span>
              Satellite imagery drape
              {satelliteStatus === 'loading' && <span className="text-slate-400"> (loading…)</span>}
            </span>
          </label>
          {showSatellite && satelliteStatus === 'error' && (
            <div className="text-[10px] text-red-400 mt-1">
              Satellite imagery unavailable: {satelliteError}
            </div>
          )}
          <label className="flex items-center gap-2 mt-2 text-sm" title="Displace the 3D ground with real USGS 3DEP elevation, with the fenced yard shown as a flat graded pad. Preview and screening analysis only — never affects layout math, DXF or PDF geometry.">
            <input
              type="checkbox"
              checked={showTerrain}
              onChange={e => setShowTerrain(e.target.checked)}
            />
            <span>
              Terrain relief (3D)
              {terrainStatus === 'loading' && <span className="text-slate-400"> (loading elevation…)</span>}
            </span>
          </label>
          {showTerrain && terrainStatus === 'error' && (
            <div className="text-[10px] text-amber-400 mt-1">
              Flat ground shown (no elevation data): {terrainError}
            </div>
          )}
          {showTerrain && terrain && (
            <>
              <label className="flex items-center gap-2 mt-2 ml-5 text-sm" title="Color the terrain by grade percent: green = flat, yellow = at the max-grade threshold, red = 2x the threshold or steeper. 3D preview only.">
                <input
                  type="checkbox"
                  checked={showSlopeHeatmap}
                  onChange={e => setShowSlopeHeatmap(e.target.checked)}
                />
                <span>Slope heatmap</span>
              </label>
              {showSlopeHeatmap && (
                <div className="ml-5 mt-1.5 flex items-center gap-2 text-[10px] text-slate-400">
                  <span>0%</span>
                  <div className="h-2 flex-1 rounded-sm" style={{ background: 'linear-gradient(to right, #26bf33, #e6bf26, #e63319)' }} />
                  <span>≥{(maxGradePct * 2).toFixed(0)}%</span>
                </div>
              )}
              <label className="flex items-center gap-2 mt-2 ml-5 text-sm" title="Draw elevation contour lines on the terrain relief, with elevation labels on the index (major) contours. Hidden inside the graded yard pad. 3D preview only — DXF/PDF unaffected.">
                <input
                  type="checkbox"
                  checked={showContours}
                  onChange={e => setShowContours(e.target.checked)}
                />
                <span>Contour lines</span>
              </label>
              {showContours && (
                <label className="ml-5 mt-1.5 block text-xs text-slate-400" title="Contour interval in feet. Auto picks a drafting-friendly interval (1/2/5 ladder) from the site relief, aiming for roughly 8-16 contours.">
                  Contour interval
                  <select
                    value={contourIntervalFt}
                    onChange={e => setContourIntervalFt(Number(e.target.value))}
                    className="w-full mt-1 bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-sm text-slate-100"
                  >
                    <option value={0}>
                      Auto{terrainAnalysis.cutFill ? ` (${pickContourInterval(terrainAnalysis.cutFill.minElevFt, terrainAnalysis.cutFill.maxElevFt)} ft)` : ''}
                    </option>
                    <option value={0.5}>0.5 ft</option>
                    <option value={1}>1 ft</option>
                    <option value={2}>2 ft</option>
                    <option value={5}>5 ft</option>
                    <option value={10}>10 ft</option>
                    <option value={20}>20 ft</option>
                  </select>
                </label>
              )}
              <label className="flex items-center gap-2 mt-2 ml-5 text-sm" title="Mark the cut/fill grading transition where the graded yard pad meets natural ground: solid tie-in line at the fence, dashed daylight line where the selected slope meets existing grade, with slope hachures between. Red = cut, green = fill. 3D preview only — DXF/PDF unaffected.">
                <input
                  type="checkbox"
                  checked={showGradingLimits}
                  onChange={e => setShowGradingLimits(e.target.checked)}
                />
                <span>Grading limits (cut/fill)</span>
              </label>
              {showGradingLimits && (
                <>
                  <label className="ml-5 mt-1.5 block text-xs text-slate-400" title="Cut/fill slope ratio (horizontal : vertical) used for the daylight line. 3:1 suits typical soils; sandy or unstable soils need flatter 4:1; rock can hold steeper 2:1. Preview only — DXF/PDF unaffected.">
                    Slope ratio (H:V)
                    <select
                      value={gradingSlopeRatio}
                      onChange={e => setGradingSlopeRatio(Number(e.target.value))}
                      className="w-full mt-1 bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-sm text-slate-100"
                    >
                      <option value={2}>2:1 (rock / stable)</option>
                      <option value={3}>3:1 (typical)</option>
                      <option value={4}>4:1 (sandy / unstable)</option>
                    </select>
                  </label>
                  <div className="ml-5 mt-1.5 flex items-center gap-3 text-[10px] text-slate-400">
                    <span className="flex items-center gap-1">
                      <span className="inline-block w-3 h-[3px] rounded-sm" style={{ background: '#d0453a' }} />
                      Cut
                    </span>
                    <span className="flex items-center gap-1">
                      <span className="inline-block w-3 h-[3px] rounded-sm" style={{ background: '#2f9e57' }} />
                      Fill
                    </span>
                    <span className="text-slate-500">{gradingSlopeRatio}:1 slope tie-in</span>
                  </div>
                </>
              )}
              <label className="flex items-center gap-2 mt-2 ml-5 text-sm" title="Preview the existing-grade contour figure exactly as it will appear in the permit packet's earthwork section (same contour data at the selected interval above — Auto or your pick — index contours labeled). Check interval and label crowding before exporting the PDF.">
                <input
                  type="checkbox"
                  checked={showEarthworkFigure}
                  onChange={e => setShowEarthworkFigure(e.target.checked)}
                />
                <span>Earthwork figure (permit packet)</span>
              </label>
              {showEarthworkFigure && design && (
                <ContourFigurePreview terrain={terrainYard!} design={design} intervalFt={contourIntervalFt} />
              )}
              <label className="ml-5 mt-2 block text-xs text-slate-400" title="Steep-zone screening threshold: blocks and roads on existing ground steeper than this grade are flagged in the pre-export check.">
                Max grade (%)
                <input
                  type="number"
                  min={1}
                  max={50}
                  step={0.5}
                  value={maxGradePct}
                  onChange={e => {
                    const v = Number(e.target.value);
                    if (Number.isFinite(v)) setMaxGradePct(v);
                  }}
                  className="w-full mt-1 bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-sm text-slate-100"
                />
              </label>
              {terrainAnalysis.cutFill && (
                <div className="mt-2 bg-slate-800 rounded p-2.5 text-[11px] leading-relaxed" title="Screening-grade rough-grading estimate: one flat pad at the elevation minimizing total earthwork (median of existing ground inside the fence). Vertical cuts at the fence line; no benching, shrink or swell factors.">
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400 mb-1">
                    Rough grading (screening)
                  </div>
                  <div className="grid grid-cols-2 gap-x-3 text-slate-300">
                    <span>Pad elevation</span>
                    <span className="text-right font-mono">{terrainAnalysis.cutFill.padElevationFt.toFixed(1)} ft</span>
                    <span>Existing ground</span>
                    <span className="text-right font-mono">{terrainAnalysis.cutFill.minElevFt.toFixed(0)}–{terrainAnalysis.cutFill.maxElevFt.toFixed(0)} ft</span>
                    <span>Cut</span>
                    <span className="text-right font-mono">{Math.round(terrainAnalysis.cutFill.cutCY).toLocaleString()} CY</span>
                    <span>Fill</span>
                    <span className="text-right font-mono">{Math.round(terrainAnalysis.cutFill.fillCY).toLocaleString()} CY</span>
                    <span>Net {terrainAnalysis.cutFill.netCY >= 0 ? '(import)' : '(export)'}</span>
                    <span className="text-right font-mono">{Math.round(Math.abs(terrainAnalysis.cutFill.netCY)).toLocaleString()} CY</span>
                  </div>
                  <div className="text-[10px] text-slate-500 mt-1">
                    {terrain.source}, ~{terrain.resolutionM} m cells
                    {terrain.noDataCount > 0 && ` · ${terrain.noDataCount} no-data cells filled`}
                    . Screening only — not for construction.
                  </div>
                </div>
              )}
              <div className="mt-2 bg-slate-800 rounded p-2.5" title="Proposed finished-grade surface: sloped drainage pads (optionally terraced benches), a balanced cut/fill optimizer with shrink applied, and daylight tie-in slopes at the fence included in the volumes. Rendered in the 3D preview; screening only — DXF/PDF unaffected.">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={gradingEnabled}
                    onChange={e => setGradingEnabled(e.target.checked)}
                  />
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                    Proposed grading surface
                  </span>
                </label>
                {gradingEnabled && (
                  <>
                    <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 mt-2">
                      <label className="block text-xs text-slate-400" title="Pad drainage slope in percent. 0.5–2% is typical for BESS yards; 0 = dead flat.">
                        Pad slope (%)
                        <input
                          type="number" min={0} max={5} step={0.25}
                          value={gradingInputs.padSlopePct}
                          onChange={e => { const v = Number(e.target.value); if (Number.isFinite(v)) setGradingInputs({ padSlopePct: v }); }}
                          className="w-full mt-1 bg-slate-900 border border-slate-600 rounded px-2 py-1 text-xs text-slate-100"
                        />
                      </label>
                      <label className="block text-xs text-slate-400" title="Downhill direction of the pad slope (compass azimuth the water runs toward).">
                        Slope toward
                        <select
                          value={gradingInputs.slopeDirDeg}
                          onChange={e => setGradingInputs({ slopeDirDeg: Number(e.target.value) })}
                          className="w-full mt-1 bg-slate-900 border border-slate-600 rounded px-2 py-1 text-xs text-slate-100"
                        >
                          <option value={0}>North</option>
                          <option value={45}>Northeast</option>
                          <option value={90}>East</option>
                          <option value={135}>Southeast</option>
                          <option value={180}>South</option>
                          <option value={225}>Southwest</option>
                          <option value={270}>West</option>
                          <option value={315}>Northwest</option>
                        </select>
                      </label>
                      <label className="block text-xs text-slate-400" title="Cut daylight slope, horizontal feet per 1 ft vertical. Steeper (smaller) holds in rock/stable soils.">
                        Cut slope (H:1)
                        <input
                          type="number" min={1} max={6} step={0.5}
                          value={gradingInputs.cutRatioH}
                          onChange={e => { const v = Number(e.target.value); if (Number.isFinite(v)) setGradingInputs({ cutRatioH: v }); }}
                          className="w-full mt-1 bg-slate-900 border border-slate-600 rounded px-2 py-1 text-xs text-slate-100"
                        />
                      </label>
                      <label className="block text-xs text-slate-400" title="Fill daylight slope, horizontal feet per 1 ft vertical. Fills usually need flatter slopes than cuts.">
                        Fill slope (H:1)
                        <input
                          type="number" min={1} max={6} step={0.5}
                          value={gradingInputs.fillRatioH}
                          onChange={e => { const v = Number(e.target.value); if (Number.isFinite(v)) setGradingInputs({ fillRatioH: v }); }}
                          className="w-full mt-1 bg-slate-900 border border-slate-600 rounded px-2 py-1 text-xs text-slate-100"
                        />
                      </label>
                      <label className="block text-xs text-slate-400" title="Fill compaction shrink: compacted fill occupies less volume than the bank-measure cut that supplied it, so balancing needs extra cut.">
                        Shrink (%)
                        <input
                          type="number" min={0} max={40} step={1}
                          value={gradingInputs.shrinkPct}
                          onChange={e => { const v = Number(e.target.value); if (Number.isFinite(v)) setGradingInputs({ shrinkPct: v }); }}
                          className="w-full mt-1 bg-slate-900 border border-slate-600 rounded px-2 py-1 text-xs text-slate-100"
                        />
                      </label>
                      <label className="block text-xs text-slate-400" title="Cut haul swell: excavated material bulks up loose in the truck. Reported as the loose haul volume.">
                        Swell (%)
                        <input
                          type="number" min={0} max={60} step={1}
                          value={gradingInputs.swellPct}
                          onChange={e => { const v = Number(e.target.value); if (Number.isFinite(v)) setGradingInputs({ swellPct: v }); }}
                          className="w-full mt-1 bg-slate-900 border border-slate-600 rounded px-2 py-1 text-xs text-slate-100"
                        />
                      </label>
                      <label className="block text-xs text-slate-400" title="Earthwork balance target after shrink: 0 = balanced on site, positive = allow that much import, negative = export.">
                        Balance bias (CY)
                        <input
                          type="number" step={100}
                          value={gradingInputs.balanceBiasCY}
                          onChange={e => { const v = Number(e.target.value); if (Number.isFinite(v)) setGradingInputs({ balanceBiasCY: v }); }}
                          className="w-full mt-1 bg-slate-900 border border-slate-600 rounded px-2 py-1 text-xs text-slate-100"
                        />
                      </label>
                      <label className="block text-xs text-slate-400" title="Topsoil strip depth over the disturbed area, stockpiled separately from the cut/fill balance.">
                        Topsoil strip (in)
                        <input
                          type="number" min={0} max={24} step={1}
                          value={gradingInputs.topsoilStripIn}
                          onChange={e => { const v = Number(e.target.value); if (Number.isFinite(v)) setGradingInputs({ topsoilStripIn: v }); }}
                          className="w-full mt-1 bg-slate-900 border border-slate-600 rounded px-2 py-1 text-xs text-slate-100"
                        />
                      </label>
                    </div>
                    <label className="flex items-center gap-2 mt-2 text-sm" title="Terrace the yard into stepped bench pads along the slope direction on sites with more relief than one pad can absorb. Each step is capped at the max bench height and screened against the ramp length a road needs.">
                      <input
                        type="checkbox"
                        checked={gradingInputs.benchMode}
                        onChange={e => setGradingInputs({ benchMode: e.target.checked })}
                      />
                      <span className="text-xs text-slate-300">Bench (terrace) the yard</span>
                    </label>
                    {gradingInputs.benchMode && (
                      <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 mt-1.5">
                        <label className="block text-xs text-slate-400" title="Maximum vertical step between adjacent bench pads.">
                          Max bench (ft)
                          <input
                            type="number" min={2} max={20} step={1}
                            value={gradingInputs.maxBenchHeightFt}
                            onChange={e => { const v = Number(e.target.value); if (Number.isFinite(v)) setGradingInputs({ maxBenchHeightFt: v }); }}
                            className="w-full mt-1 bg-slate-900 border border-slate-600 rounded px-2 py-1 text-xs text-slate-100"
                          />
                        </label>
                        <label className="block text-xs text-slate-400" title="Max road grade allowed on the ramp connecting benches; screens whether the ramp fits inside a bench.">
                          Max road grade (%)
                          <input
                            type="number" min={2} max={15} step={0.5}
                            value={gradingInputs.maxRoadGradePct}
                            onChange={e => { const v = Number(e.target.value); if (Number.isFinite(v)) setGradingInputs({ maxRoadGradePct: v }); }}
                            className="w-full mt-1 bg-slate-900 border border-slate-600 rounded px-2 py-1 text-xs text-slate-100"
                          />
                        </label>
                      </div>
                    )}
                    <div className="mt-2 border-t border-slate-700 pt-2" title="Multi-pad grading zones: up to 4 named rectangles inside the fence, each holding its own pad elevation as an offset from the balanced FG surface (or auto-solved to the local terrain). Zones save with the project file and flow into the GP-1 sheet, sections, contours and LandXML.">
                      <div className="flex items-center justify-between">
                        <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                          Grading zones ({gradingZones.length}/4)
                        </span>
                        {gradingZones.length < 4 && design && design.fence.length >= 3 && (
                          <button
                            className="text-[10px] px-1.5 py-0.5 bg-slate-700 hover:bg-slate-600 rounded text-slate-200"
                            onClick={() => {
                              // Seed the new zone at the fence centroid — the point
                              // most likely to pass the inside-fence check.
                              const fx = design.fence.reduce((s2, p) => s2 + p.x, 0) / design.fence.length;
                              const fy = design.fence.reduce((s2, p) => s2 + p.y, 0) / design.fence.length;
                              const zone = {
                                id: `gz-${Date.now()}-${gradingZones.length}`,
                                name: `ZONE ${gradingZones.length + 1}`,
                                x: Math.round(fx), y: Math.round(fy),
                                lengthFt: 100, widthFt: 100,
                                mode: 'auto' as const, offsetFt: 0,
                              };
                              setZoneError(setGradingZones([...gradingZones, zone]));
                            }}
                          >
                            + Add zone
                          </button>
                        )}
                      </div>
                      {zoneError && (
                        <div className="mt-1 text-[10px] text-amber-400">{zoneError}</div>
                      )}
                      {gradingZones.map(z => (
                        <div key={z.id} className="mt-1.5 bg-slate-900/60 border border-slate-700 rounded p-1.5">
                          <div className="flex items-center gap-1.5">
                            <input
                              type="text"
                              value={z.name}
                              maxLength={24}
                              onChange={e => setZoneError(setGradingZones(gradingZones.map(g => g.id === z.id ? { ...g, name: e.target.value } : g)))}
                              className="flex-1 min-w-0 bg-slate-900 border border-slate-600 rounded px-1.5 py-0.5 text-[11px] text-slate-100"
                            />
                            <select
                              value={z.mode}
                              onChange={e => setZoneError(setGradingZones(gradingZones.map(g => g.id === z.id ? { ...g, mode: e.target.value as 'auto' | 'offset' } : g)))}
                              className="bg-slate-900 border border-slate-600 rounded px-1 py-0.5 text-[11px] text-slate-100"
                              title="Auto: the solver picks the pad offset that best fits the terrain inside the zone. Offset: you set the pad offset from the balanced base surface."
                            >
                              <option value="auto">Auto</option>
                              <option value="offset">Offset</option>
                            </select>
                            <button
                              className="text-[11px] px-1 text-slate-400 hover:text-red-400"
                              title="Remove zone"
                              onClick={() => setZoneError(setGradingZones(gradingZones.filter(g => g.id !== z.id)))}
                            >
                              ✕
                            </button>
                          </div>
                          <div className="grid grid-cols-4 gap-x-1.5 gap-y-1 mt-1" title="Type an exact pad position and size (e.g. 200 x 150 at a specific station) and press Enter or click away to apply. Invalid entries are rejected with the reason and the previous zone stays in effect; values track drag/resize edits made in the plan view.">
                            {([
                              ['Center X', 'x', 1, undefined, undefined],
                              ['Center Y', 'y', 1, undefined, undefined],
                              ['Length', 'lengthFt', 5, ZONE_MIN_SIZE_FT, ZONE_MAX_SIZE_FT],
                              ['Width', 'widthFt', 5, ZONE_MIN_SIZE_FT, ZONE_MAX_SIZE_FT],
                            ] as const).map(([lbl, key, stepV, minV, maxV]) => (
                              <ZoneDimField
                                key={key}
                                label={lbl}
                                value={z[key]}
                                step={stepV}
                                min={minV}
                                max={maxV}
                                onCommit={v => {
                                  if (minV !== undefined && (v < minV || (maxV !== undefined && v > maxV))) {
                                    const err = `Grading zones rejected — zone "${z.name}" ${lbl.toLowerCase()} must be between ${minV} and ${maxV} ft.`;
                                    setZoneError(err);
                                    return err;
                                  }
                                  const zonesNow = useDesignStore.getState().gradingZones;
                                  const err = setGradingZones(zonesNow.map(g => g.id === z.id ? { ...g, [key]: v } : g));
                                  setZoneError(err);
                                  return err;
                                }}
                              />
                            ))}
                          </div>
                          {z.mode === 'offset' && (
                            <label className="block text-[9px] text-slate-500 mt-1">
                              Pad offset from base FG (ft, +raise / −lower)
                              <input
                                type="number" min={-20} max={20} step={0.5}
                                value={z.offsetFt}
                                onChange={e => { const v = Number(e.target.value); if (Number.isFinite(v)) setZoneError(setGradingZones(gradingZones.map(g => g.id === z.id ? { ...g, offsetFt: v } : g))); }}
                                className="w-full mt-0.5 bg-slate-900 border border-slate-600 rounded px-1 py-0.5 text-[10px] text-slate-100"
                              />
                            </label>
                          )}
                          {z.mode === 'auto' && fgSurface?.zones && (
                            <div className="mt-1 text-[9px] text-slate-500">
                              Solved offset: {(() => {
                                const solved = fgSurface.zones.find(s2 => s2.id === z.id);
                                return solved ? `${solved.offsetFt >= 0 ? '+' : ''}${solved.offsetFt.toFixed(1)} ft` : '—';
                              })()}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                    <label className="flex items-center gap-2 mt-2 text-sm" title="Draw the proposed FG contours and daylight/disturbance limit on the terrain in the 3D preview — the same linework the GP-1 grading plan sheet exports. Preview only; DXF/PDF unaffected.">
                      <input
                        type="checkbox"
                        checked={showProposedContours}
                        onChange={e => setShowProposedContours(e.target.checked)}
                      />
                      <span className="text-xs text-slate-300">Show proposed contours (3D)</span>
                    </label>
                    <label className="flex items-center gap-2 mt-2 text-sm" title="Drape the cut/fill depth bands (FG minus existing grade) onto the terrain in the 3D preview — the same 4 bands the GP-1 cut/fill shading exports use. Preview only; DXF/PDF unaffected.">
                      <input
                        type="checkbox"
                        checked={showCutFillPreview}
                        onChange={e => setShowCutFillPreview(e.target.checked)}
                      />
                      <span className="text-xs text-slate-300">Show cut/fill shading (3D)</span>
                    </label>
                    {showCutFillPreview && (
                      <div className="flex flex-wrap gap-x-3 gap-y-1 mt-1.5 ml-5">
                        {CUT_FILL_PREVIEW_LEGEND.map(item => (
                          <span key={item.label} className="flex items-center gap-1 text-[10px] text-slate-400">
                            <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: item.color, opacity: 0.8 }} />
                            {item.label}
                          </span>
                        ))}
                      </div>
                    )}
                    {fgSurface && (
                      <div className="mt-2 border-t border-slate-700 pt-2 text-[11px] leading-relaxed">
                        <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400 mb-1">
                          Earthwork (balanced FG)
                        </div>
                        <div className="grid grid-cols-2 gap-x-3 text-slate-300">
                          <span>Benches</span>
                          <span className="text-right font-mono">
                            {fgSurface.benches.length}
                            {fgSurface.earthwork.maxBenchStepFt > 0.05 ? ` (max step ${fgSurface.earthwork.maxBenchStepFt.toFixed(1)} ft)` : ''}
                          </span>
                          <span>Cut (bank)</span>
                          <span className="text-right font-mono">{Math.round(fgSurface.earthwork.cutCY).toLocaleString()} CY</span>
                          <span>Fill (compacted)</span>
                          <span className="text-right font-mono">{Math.round(fgSurface.earthwork.fillCY).toLocaleString()} CY</span>
                          <span>Fill (bank, +shrink)</span>
                          <span className="text-right font-mono">{Math.round(fgSurface.earthwork.adjustedFillCY).toLocaleString()} CY</span>
                          <span>Net {fgSurface.earthwork.adjustedNetCY >= 0 ? '(import)' : '(export)'}</span>
                          <span className="text-right font-mono">{Math.round(Math.abs(fgSurface.earthwork.adjustedNetCY)).toLocaleString()} CY</span>
                          <span>Haul (loose)</span>
                          <span className="text-right font-mono">{Math.round(fgSurface.earthwork.haulLooseCY).toLocaleString()} CY</span>
                          <span>Topsoil strip</span>
                          <span className="text-right font-mono">{Math.round(fgSurface.earthwork.topsoilCY).toLocaleString()} CY</span>
                          <span>Disturbed area</span>
                          <span className="text-right font-mono">{(fgSurface.earthwork.disturbedAreaSqFt / 43560).toFixed(1)} ac</span>
                        </div>
                        {fgSurface.earthwork.warnings.map((w, i) => (
                          <div key={i} className="text-[10px] text-amber-400 mt-1">{w}</div>
                        ))}
                        <div className="text-[10px] text-slate-500 mt-1">
                          Balance shift {fgSurface.earthwork.balanceShiftFt >= 0 ? '+' : ''}{fgSurface.earthwork.balanceShiftFt.toFixed(2)} ft.
                          Equipment stays flat in the preview (screening). Not for construction.
                        </div>
                        <label
                          className="flex items-center gap-2 mt-2 text-[11px] cursor-pointer"
                          title="Add a cut/fill isopach (depth-shaded hatch regions from FG minus existing grade) to the grading plan sheet: dedicated DXF layers (C - CUT / C - FILL by depth band, ANSI31 hatch) and matching fills on the PDF twin. Off by default — the GP-1 sheet is unchanged unless enabled."
                        >
                          <input
                            type="checkbox"
                            checked={exportCutFillShading}
                            onChange={e => setExportCutFillShading(e.target.checked)}
                            className="accent-cyan-500"
                          />
                          <span className="text-slate-300">Cut/fill shading on grading sheet</span>
                        </label>
                        {earthworkCost && (
                          <div className="mt-2 border-t border-slate-700 pt-2">
                            <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400 mb-1">
                              Earthwork cost (screening)
                            </div>
                            <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 mb-1.5">
                              <label className="block text-[10px] text-slate-400" title="Excavation unit rate, bank measure ($/CY). Garbage input snaps back to the default.">
                                Cut $/CY
                                <input
                                  type="number" min={0} max={500} step={0.5}
                                  value={earthworkRates.cutPerCY}
                                  onChange={e => { const v = Number(e.target.value); if (Number.isFinite(v)) setEarthworkRates({ cutPerCY: v }); }}
                                  className="w-full mt-1 bg-slate-900 border border-slate-600 rounded px-2 py-1 text-xs text-slate-100"
                                />
                              </label>
                              <label className="block text-[10px] text-slate-400" title="Fill placement + compaction unit rate, compacted measure ($/CY).">
                                Fill $/CY
                                <input
                                  type="number" min={0} max={500} step={0.5}
                                  value={earthworkRates.fillPerCY}
                                  onChange={e => { const v = Number(e.target.value); if (Number.isFinite(v)) setEarthworkRates({ fillPerCY: v }); }}
                                  className="w-full mt-1 bg-slate-900 border border-slate-600 rounded px-2 py-1 text-xs text-slate-100"
                                />
                              </label>
                              <label className="block text-[10px] text-slate-400" title="Off-site haul unit rate, loose measure ($/CY).">
                                Haul $/CY
                                <input
                                  type="number" min={0} max={500} step={0.5}
                                  value={earthworkRates.haulPerCY}
                                  onChange={e => { const v = Number(e.target.value); if (Number.isFinite(v)) setEarthworkRates({ haulPerCY: v }); }}
                                  className="w-full mt-1 bg-slate-900 border border-slate-600 rounded px-2 py-1 text-xs text-slate-100"
                                />
                              </label>
                              <label className="block text-[10px] text-slate-400" title="Topsoil strip + stockpile unit rate ($/CY).">
                                Topsoil $/CY
                                <input
                                  type="number" min={0} max={500} step={0.5}
                                  value={earthworkRates.topsoilPerCY}
                                  onChange={e => { const v = Number(e.target.value); if (Number.isFinite(v)) setEarthworkRates({ topsoilPerCY: v }); }}
                                  className="w-full mt-1 bg-slate-900 border border-slate-600 rounded px-2 py-1 text-xs text-slate-100"
                                />
                              </label>
                              <label className="block text-[10px] text-slate-400 col-span-2" title="One-time mobilization lump sum ($). Set 0 to drop the line item.">
                                Mobilization (lump sum $)
                                <input
                                  type="number" min={0} max={10000000} step={1000}
                                  value={earthworkRates.mobilizationLump}
                                  onChange={e => { const v = Number(e.target.value); if (Number.isFinite(v)) setEarthworkRates({ mobilizationLump: v }); }}
                                  className="w-full mt-1 bg-slate-900 border border-slate-600 rounded px-2 py-1 text-xs text-slate-100"
                                />
                              </label>
                            </div>
                            <div className="grid grid-cols-2 gap-x-3 text-slate-300">
                              {earthworkCost.lines.map(l => (
                                <Fragment key={l.item}>
                                  <span>{l.item.charAt(0) + l.item.slice(1).toLowerCase()}{l.unit === 'CY' ? ` (${(l.qtyCY ?? 0).toLocaleString()} CY)` : ''}</span>
                                  <span className="text-right font-mono">{fmtUSD(l.amount)}</span>
                                </Fragment>
                              ))}
                              <span className="font-semibold text-slate-100">Total</span>
                              <span className="text-right font-mono font-semibold text-slate-100">{fmtUSD(earthworkCost.totalUSD)}</span>
                            </div>
                            <div className="text-[10px] text-amber-400 mt-1">{COST_DISCLAIMER}</div>
                            <label
                              className="flex items-center gap-2 mt-2 text-[11px] cursor-pointer"
                              title="Add an EARTHWORK COST ESTIMATE box (quantities × your unit rates, with the screening disclaimer) to the GP-1 grading sheet DXF and PDF. Off by default — the GP-1 sheet bytes are unchanged unless enabled. Rates are a browser preference, never saved in the project file."
                            >
                              <input
                                type="checkbox"
                                checked={exportCostEstimate}
                                onChange={e => setExportCostEstimate(e.target.checked)}
                                className="accent-cyan-500"
                              />
                              <span className="text-slate-300">Include cost estimate on grading sheet</span>
                            </label>
                          </div>
                        )}
                        <label
                          className="flex items-center gap-2 mt-2 text-[11px] cursor-pointer"
                          title="Add a GRADING CROSS-SECTIONS sheet (GP-2): 4 automatic section lines (one along the grade axis, three perpendicular) with OG vs FG profiles, cut/fill hatching, daylight points and station/elevation grids. Labeled section lines are drawn on GP-1 only when this is on — off by default, GP-1 bytes unchanged."
                        >
                          <input
                            type="checkbox"
                            checked={exportSections}
                            onChange={e => setExportSections(e.target.checked)}
                            className="accent-cyan-500"
                          />
                          <span className="text-slate-300">Cross-sections sheet (GP-2)</span>
                        </label>
                        <div className="grid grid-cols-3 gap-1.5 mt-2">
                          <button
                            onClick={handleExportGradingDxf}
                            className="bg-slate-700 hover:bg-slate-600 text-slate-100 text-[11px] py-1.5 rounded"
                            title="Standalone GRADING PLAN sheet (GP-1): proposed FG contours over screened existing contours, spot elevations, slope arrows, daylight limit, swales/discharge points (if drainage screening is on), legend and earthwork table. Opt-in — the drawing package DXF is unchanged."
                          >
                            Grading DXF
                          </button>
                          <button
                            onClick={handleExportGradingPdf}
                            disabled={gradingPdfBusy}
                            className="bg-slate-700 hover:bg-slate-600 disabled:opacity-50 text-slate-100 text-[11px] py-1.5 rounded"
                            title="Same GRADING PLAN sheet as a 1-page ANSI D vector PDF — rendered from the identical display list, so it can never drift from the DXF."
                          >
                            {gradingPdfBusy ? 'Plotting…' : 'Grading PDF'}
                          </button>
                          <button
                            onClick={handleExportLandXml}
                            className="bg-slate-700 hover:bg-slate-600 text-slate-100 text-[11px] py-1.5 rounded"
                            title="Proposed FG surface as a LandXML 1.2 TIN for Civil 3D / Carlson / Trimble. Local site coordinates in feet (not georeferenced). Screening only."
                          >
                            LandXML
                          </button>
                          {exportSections && (
                            <>
                              <button
                                onClick={handleExportSectionsDxf}
                                className="bg-slate-700 hover:bg-slate-600 text-slate-100 text-[11px] py-1.5 rounded"
                                title="Standalone GRADING CROSS-SECTIONS sheet (GP-2): OG (dashed) vs FG (solid) profiles along the automatic section lines with cut/fill hatching, elevation grids, station labels and daylight points. Opt-in — the drawing package DXF is unchanged."
                              >
                                Sections DXF
                              </button>
                              <button
                                onClick={handleExportSectionsPdf}
                                disabled={sectionsPdfBusy}
                                className="bg-slate-700 hover:bg-slate-600 disabled:opacity-50 text-slate-100 text-[11px] py-1.5 rounded"
                                title="Same GP-2 sheet as a 1-page ANSI D vector PDF — rendered from the identical display list, so it can never drift from the DXF."
                              >
                                {sectionsPdfBusy ? 'Plotting…' : 'Sections PDF'}
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>
              {gradingEnabled && (
                <div className="mt-2 bg-slate-800 rounded p-2.5" title="Screening-level drainage on the proposed FG surface: D8 flow direction/accumulation, ponding (sink) detection, perimeter swales along the daylight toe, and rational-method peak flows at the discharge points with a Manning swale-section check. Preview only — DXF/PDF unaffected.">
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={drainageEnabled}
                      onChange={e => setDrainageEnabled(e.target.checked)}
                    />
                    <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                      Drainage screening
                    </span>
                  </label>
                  {drainageEnabled && (
                    <>
                      <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 mt-2">
                        <DrainageNumField field="runoffC" label="Runoff C" step={0.05}
                          title="Rational-method runoff coefficient C. Graded/gravel BESS yards run 0.7–0.85; grassed areas lower." />
                        <DrainageNumField field="rainfallIntensityInHr" label="Intensity (in/hr)" step={0.5}
                          title="Design rainfall intensity i at the time of concentration (in/hr) — pull from the local IDF curve for the design storm." />
                        <DrainageNumField field="manningN" label="Manning n" step={0.002}
                          title="Manning roughness n of the swale lining. Grass ~0.030, riprap ~0.04, concrete ~0.013." />
                        <DrainageNumField field="swaleSideSlopeH" label="Side slope (H:1)" step={0.5}
                          title="Swale side slope, horizontal feet per 1 ft vertical (triangular section). 3:1 is mowable." />
                        <DrainageNumField field="swaleGradePct" label="Swale grade (%)" step={0.1}
                          title="Swale longitudinal grade used for the Manning capacity check. 0.5% is a common minimum to keep grass swales self-cleaning." />
                        <label className="block text-xs text-slate-400" title="Swale cross-section: triangular (V-ditch) or trapezoidal with a flat bottom.">
                          Channel shape
                          <select
                            value={drainageInputs.channelShape}
                            onChange={e => setDrainageInputs({ channelShape: e.target.value === 'trapezoidal' ? 'trapezoidal' : 'triangular' })}
                            className="w-full mt-1 bg-slate-900 border border-slate-600 rounded px-2 py-1 text-xs text-slate-100"
                          >
                            <option value="triangular">Triangular (V)</option>
                            <option value="trapezoidal">Trapezoidal</option>
                          </select>
                        </label>
                        {drainageInputs.channelShape === 'trapezoidal' && (
                          <DrainageNumField field="bottomWidthFt" label="Bottom width (ft)" step={0.5}
                            title="Flat bottom width of the trapezoidal swale." />
                        )}
                        <DrainageNumField field="freeboardFt" label="Freeboard (ft)" step={0.1}
                          title="Required freeboard above the design flow depth; flagged when depth + freeboard exceeds a 3 ft swale." />
                      </div>
                      {/* NOAA Atlas 14 IDF */}
                      <div className="mt-2 border-t border-slate-700 pt-2">
                        <label className="flex items-center gap-2 text-xs text-slate-400" title="Use the NOAA Atlas 14 point precipitation-frequency table for this site: the design intensity is interpolated at each subcatchment's time of concentration for the chosen storm, instead of the single manual intensity above.">
                          <input
                            type="checkbox"
                            checked={drainageInputs.useNoaaIdf}
                            onChange={e => setDrainageInputs({ useNoaaIdf: e.target.checked })}
                          />
                          NOAA Atlas 14 IDF (intensity at Tc)
                        </label>
                        {drainageInputs.useNoaaIdf && (
                          <div className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-1.5 items-end">
                            <label className="block text-xs text-slate-400" title="Design storm average recurrence interval.">
                              Design storm
                              <select
                                value={drainageInputs.stormAriYears}
                                onChange={e => { const v = Number(e.target.value); if (Number.isFinite(v)) setDrainageInputs({ stormAriYears: v }); }}
                                className="w-full mt-1 bg-slate-900 border border-slate-600 rounded px-2 py-1 text-xs text-slate-100"
                              >
                                {ATLAS14_ARI_CHOICES.map(a => (
                                  <option key={a} value={a}>{a}-yr</option>
                                ))}
                              </select>
                            </label>
                            <button
                              onClick={handleFetchIdf}
                              disabled={idfBusy}
                              className="bg-slate-700 hover:bg-slate-600 disabled:opacity-50 text-slate-100 text-xs rounded px-2 py-1.5"
                            >
                              {idfBusy ? 'Fetching…' : drainageIdf ? 'Re-fetch IDF' : 'Fetch NOAA IDF'}
                            </button>
                            <div className="col-span-2 text-[10px] text-slate-500">
                              {drainageIdf
                                ? `${drainageIdf.source} @ ${drainageIdf.lat.toFixed(4)}, ${drainageIdf.lon.toFixed(4)}`
                                : 'No IDF fetched yet — using the manual intensity until fetched.'}
                            </div>
                          </div>
                        )}
                      </div>
                      {/* Weighted runoff coefficient */}
                      <div className="mt-2 border-t border-slate-700 pt-2">
                        <label className="flex items-center gap-2 text-xs text-slate-400" title="Composite C per subcatchment, area-weighted from the layout: equipment pads, access roads, crushed-rock yard and undisturbed ground — instead of the single C above.">
                          <input
                            type="checkbox"
                            checked={drainageInputs.weightedC}
                            onChange={e => setDrainageInputs({ weightedC: e.target.checked })}
                          />
                          Weighted C from layout surfaces
                        </label>
                        {drainageInputs.weightedC && (
                          <div className="mt-1.5 grid grid-cols-4 gap-x-2">
                            {([
                              ['cPad', 'Pads'], ['cRoad', 'Roads'], ['cGravel', 'Gravel'], ['cUndisturbed', 'Undist.'],
                            ] as const).map(([key, label]) => (
                              <DrainageNumField key={key} field={key} label={label} step={0.05} compact
                                title={`Runoff coefficient for ${label === 'Undist.' ? 'undisturbed ground' : label.toLowerCase()}.`} />
                            ))}
                          </div>
                        )}
                      </div>
                      {/* Detention basin screening */}
                      <div className="mt-2 border-t border-slate-700 pt-2">
                        <label className="flex items-center gap-2 text-xs text-slate-400" title="Detention-basin screening: allowable release = pre-development peak; required storage by the modified rational method (IDF duration sweep) or a triangle approximation, with a suggested square 3:1 basin near the low discharge point.">
                          <input
                            type="checkbox"
                            checked={drainageInputs.detention}
                            onChange={e => setDrainageInputs({ detention: e.target.checked })}
                          />
                          Detention basin screening
                        </label>
                        {drainageInputs.detention && (
                          <div className="mt-1.5 grid grid-cols-2 gap-x-3">
                            <DrainageNumField field="preDevC" label="Pre-dev C" step={0.05}
                              title="Pre-development (existing ground) runoff coefficient — sets the allowable release rate." />
                            <DrainageNumField field="basinDepthFt" label="Basin depth (ft)" step={0.5}
                              title="Basin design depth (3:1 interior side slopes)." />
                          </div>
                        )}
                      </div>
                      {/* Design-grade hydrology (TR-55, NRCS/SCS, routing, culvert outlet) */}
                      <div className="mt-2 border-t border-slate-700 pt-2">
                        <label className="flex items-center gap-2 text-xs text-slate-400" title="TR-55 segmental time of concentration: sheet flow (Manning kinematic, ≤100 ft) + shallow concentrated + channel flow at the swale Manning velocity — replaces the Kirpich screening Tc and re-sizes swales at the new intensity.">
                          <input
                            type="checkbox"
                            checked={drainageInputs.tr55Tc}
                            onChange={e => setDrainageInputs({ tr55Tc: e.target.checked })}
                          />
                          TR-55 time of concentration
                        </label>
                        {drainageInputs.tr55Tc && (
                          <div className="mt-1.5 grid grid-cols-2 gap-x-3">
                            <DrainageNumField field="sheetFlowN" label="Sheet flow n" step={0.01}
                              title="Sheet-flow Manning n (TR-55 Table 3-1): 0.011 smooth surfaces, 0.15 short grass, 0.24 dense grass, 0.41 range." />
                            <DrainageNumField field="sheetFlowLenFt" label="Sheet length (ft)" step={10}
                              title="Sheet-flow length (TR-55 caps this at 100 ft)." />
                            <DrainageNumField field="p2In" label="P2 24-hr (in)" step={0.1}
                              title="2-year 24-hour rainfall (in) — the TR-55 sheet-flow travel-time storm." />
                            <DrainageNumField field="tcOverrideMin" label="Tc override (min)" step={1}
                              title="Manual Tc override in minutes (0 = use the computed TR-55 value)." />
                          </div>
                        )}
                        <label className="flex items-center gap-2 text-xs text-slate-400 mt-1.5" title="NRCS/SCS hydrograph mode: curve-number runoff for the 24-hr design storm (Type II/III distribution), SCS dimensionless unit hydrograph per subcatchment, site hydrograph by summation.">
                          <input
                            type="checkbox"
                            checked={drainageInputs.scsMode}
                            onChange={e => setDrainageInputs({ scsMode: e.target.checked })}
                          />
                          NRCS 24-hr hydrographs (SCS)
                        </label>
                        {drainageInputs.scsMode && (
                          <>
                            <div className="mt-1.5 grid grid-cols-2 gap-x-3">
                              <DrainageNumField field="curveNumber" label="Curve number" step={1}
                                title="Post-development composite curve number (85 typical for a gravel BESS yard)." />
                              <DrainageNumField field="preDevCn" label="Pre-dev CN" step={1}
                                title="Pre-development curve number — sets the allowable release for routing." />
                              <label className="block text-xs text-slate-400" title="SCS 24-hr storm distribution: Type II (most of the US) or Type III (Gulf/Atlantic coast).">
                                Storm type
                                <select
                                  value={drainageInputs.stormType}
                                  onChange={e => setDrainageInputs({ stormType: e.target.value === 'III' ? 'III' : 'II' })}
                                  className="w-full mt-1 bg-slate-900 border border-slate-600 rounded px-2 py-1 text-xs text-slate-100"
                                >
                                  <option value="II">Type II</option>
                                  <option value="III">Type III</option>
                                </select>
                              </label>
                              <DrainageNumField field="rain24In" label="24-hr rain (in)" step={0.1}
                                title="24-hr design rainfall depth (in) — e.g. the 25-yr or 100-yr 24-hr from NOAA Atlas 14." />
                            </div>
                            <label className="flex items-center gap-2 text-xs text-slate-400 mt-1.5" title="Level-pool (modified Puls) routing through an auto-sized two-stage outlet (low-flow orifice + overflow weir) so the routed peak ≤ the pre-development peak.">
                              <input
                                type="checkbox"
                                checked={drainageInputs.routedDetention}
                                onChange={e => setDrainageInputs({ routedDetention: e.target.checked })}
                              />
                              Routed detention design
                            </label>
                          </>
                        )}
                        <label className="flex items-center gap-2 text-xs text-slate-400 mt-1.5" title="HDS-5 outlet-control check on every culvert (entrance + friction + exit losses vs the tailwater); the larger of inlet/outlet headwater governs.">
                          <input
                            type="checkbox"
                            checked={drainageInputs.culvertOutlet}
                            onChange={e => setDrainageInputs({ culvertOutlet: e.target.checked })}
                          />
                          Culvert outlet-control check
                        </label>
                        {drainageInputs.culvertOutlet && (
                          <div className="mt-1.5 grid grid-cols-2 gap-x-3">
                            <DrainageNumField field="tailwaterFt" label="Tailwater (ft)" step={0.5}
                              title="Tailwater depth above the outlet invert (ft)." />
                          </div>
                        )}
                      </div>
                      {drainageModel ? (
                        <div className="mt-2 border-t border-slate-700 pt-2 text-[11px] leading-relaxed">
                          <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400 mb-1">
                            Discharge points (rational method)
                          </div>
                          <div className="grid grid-cols-2 gap-x-3 text-slate-300">
                            {drainageModel.discharges.map((d, i) => (
                              <Fragment key={i}>
                                <span>DP-{i + 1} · {d.areaAcres.toFixed(1)} ac · Tc {Math.round(d.tcMin)} min</span>
                                <span className="text-right font-mono">{d.qCfs.toFixed(1)} cfs</span>
                              </Fragment>
                            ))}
                          </div>
                          {drainageModel.swales.length > 0 && (
                            <>
                              <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400 mt-2 mb-1"
                                title={`Triangular section sized by Manning's equation at the assumed ${drainageModel.inputs.swaleGradePct}% longitudinal grade — a screening assumption, not a profile of the actual toe line.`}>
                                Swale runs (at assumed {drainageModel.inputs.swaleGradePct}% grade)
                              </div>
                              <div className="grid grid-cols-2 gap-x-3 text-slate-300">
                                {drainageModel.swales.map((s, i) => (
                                  <Fragment key={i}>
                                    <span>→ DP-{s.dischargeIdx + 1} · {Math.round(s.lengthFt)} ft</span>
                                    <span className="text-right font-mono">
                                      {s.section.depthFt.toFixed(1)} ft d × {s.section.topWidthFt.toFixed(0)} ft · {s.section.velocityFps.toFixed(1)} fps
                                    </span>
                                  </Fragment>
                                ))}
                              </div>
                            </>
                          )}
                          {drainageModel.discharges.some(d => d.riprap) && (
                            <>
                              <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400 mt-2 mb-1"
                                title="Isbash screening with a 1.25 safety factor at the swale outlet velocity; D50 on the common DOT class ladder, apron 2 in thickness min 12 in.">
                                Riprap outlet protection
                              </div>
                              <div className="grid grid-cols-2 gap-x-3 text-slate-300">
                                {drainageModel.discharges.map((d, i) => d.riprap && (
                                  <Fragment key={i}>
                                    <span>DP-{i + 1} · {d.riprap.velocityFps.toFixed(1)} fps</span>
                                    <span className="text-right font-mono">
                                      D50 {d.riprap.d50In}" · {Math.round(d.riprap.apronLengthFt)}×{Math.round(d.riprap.apronWidthFt)} ft
                                    </span>
                                  </Fragment>
                                ))}
                              </div>
                            </>
                          )}
                          {(drainageModel.culverts?.length ?? 0) > 0 && (
                            <>
                              <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400 mt-2 mb-1"
                                title="FHWA HDS-5 inlet-control screening at swale/road crossings — square-edge headwall, HW/D ≤ 1.5, standard CMP diameter ladder.">
                                Culverts (road crossings)
                              </div>
                              <div className="grid grid-cols-2 gap-x-3 text-slate-300">
                                {drainageModel.culverts!.map((c, i) => (
                                  <Fragment key={i}>
                                    <span>C-{i + 1} · {c.qCfs.toFixed(1)} cfs · {Math.round(c.lengthFt)} ft</span>
                                    <span className="text-right font-mono">{c.diaIn}" · HW/D {c.hwOverD.toFixed(2)}</span>
                                  </Fragment>
                                ))}
                              </div>
                            </>
                          )}
                          {drainageModel.detention && (
                            <>
                              <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400 mt-2 mb-1"
                                title={`Storage method: ${drainageModel.detention.method}. Allowable release = pre-development peak; suggested square basin with 3:1 interior slopes near the governing discharge point.`}>
                                Detention basin (screening)
                              </div>
                              <div className="grid grid-cols-2 gap-x-3 text-slate-300">
                                <span>Release / developed</span>
                                <span className="text-right font-mono">
                                  {drainageModel.detention.prePeakCfs.toFixed(1)} / {drainageModel.detention.postPeakCfs.toFixed(1)} cfs
                                </span>
                                <span>Required storage</span>
                                <span className="text-right font-mono">
                                  {(drainageModel.detention.requiredCf / 43560).toFixed(2)} ac-ft
                                </span>
                                <span>Suggested basin</span>
                                <span className={`text-right font-mono ${drainageModel.detention.placed ? '' : 'text-amber-400'}`}>
                                  {Math.round(drainageModel.detention.topWFt)} ft sq × {drainageModel.detention.depthFt.toFixed(1)} ft
                                  {drainageModel.detention.placed ? '' : ' (no fit)'}
                                </span>
                              </div>
                            </>
                          )}
                          <div className="grid grid-cols-2 gap-x-3 text-slate-300 mt-1">
                            <span>Ponding low spots</span>
                            <span className={`text-right font-mono ${drainageModel.ponding.some(p => p.onPad) ? 'text-red-400' : ''}`}>
                              {drainageModel.ponding.length === 0 ? 'none' :
                                `${drainageModel.ponding.length} (${drainageModel.ponding.filter(p => p.onPad).length} on pad)`}
                            </span>
                          </div>
                          {drainageModel.idfSource && (
                            <div className="text-[10px] text-slate-500 mt-1">IDF: {drainageModel.idfSource}</div>
                          )}
                          {drainageModel.warnings.map((w, i) => (
                            <div key={i} className="text-[10px] text-amber-400 mt-1">{w}</div>
                          ))}
                          <div className="text-[10px] text-slate-500 mt-1">{drainageModel.disclaimer}</div>
                          <div className="flex gap-2 mt-2">
                            <button
                              onClick={handleExportDrainageDxf}
                              className="flex-1 bg-slate-700 hover:bg-slate-600 text-slate-100 text-xs rounded px-2 py-1.5"
                              title="Export the DR-1 drainage area map sheet (subcatchments, flow arrows, swales, culverts, basin, hydrology schedules) as a separate AC1015 DXF. The main layout DXF is unchanged."
                            >
                              DR-1 DXF
                            </button>
                            <button
                              onClick={handleExportDrainagePdf}
                              disabled={drainagePdfBusy}
                              className="flex-1 bg-slate-700 hover:bg-slate-600 disabled:opacity-50 text-slate-100 text-xs rounded px-2 py-1.5"
                              title="Export the same DR-1 sheet as a 1-page ANSI D vector PDF — rendered from the identical display list as the DXF."
                            >
                              {drainagePdfBusy ? 'Rendering…' : 'DR-1 PDF'}
                            </button>
                          </div>
                          <div className="flex gap-2 mt-1.5">
                            <button
                              onClick={handleExportDrainage2Dxf}
                              className="flex-1 bg-slate-700 hover:bg-slate-600 text-slate-100 text-xs rounded px-2 py-1.5"
                              title="Export the DR-2 drainage details & routing sheet (channel section, pond outlet structure, culvert profile, TR-55 / NRCS / routing / stage-storage tables) as a separate AC1015 DXF."
                            >
                              DR-2 DXF
                            </button>
                            <button
                              onClick={handleExportDrainage2Pdf}
                              disabled={drainage2PdfBusy}
                              className="flex-1 bg-slate-700 hover:bg-slate-600 disabled:opacity-50 text-slate-100 text-xs rounded px-2 py-1.5"
                              title="Export the same DR-2 sheet as a 1-page ANSI D vector PDF — rendered from the identical display list as the DXF."
                            >
                              {drainage2PdfBusy ? 'Rendering…' : 'DR-2 PDF'}
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="text-[10px] text-slate-500 mt-2">
                          Needs the proposed grading surface above (terrain loaded and grading enabled).
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
              <div className="mt-2 bg-slate-800 rounded p-2.5" title="Sweep yard rotations (0–175° in 5° steps): each pose regenerates the full layout on the rotated parcel and scores its rough-grading earthwork. Applying a pose rotates the working frame — the layout, exports and earthwork numbers all follow. Screening only.">
                <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400 mb-1">
                  Grading-optimized rotation
                </div>
                <div className="flex items-center gap-2">
                  <select
                    value={gradObjective}
                    onChange={e => setGradObjective(e.target.value as GradingObjective)}
                    disabled={gradRunning}
                    className="flex-1 bg-slate-900 border border-slate-600 rounded px-2 py-1 text-xs text-slate-100"
                    title="Total = minimize cut + fill (least dirt moved). Net = minimize |cut − fill| (balanced import/export)."
                  >
                    <option value="total">Min total (cut + fill)</option>
                    <option value="net">Min net (balance)</option>
                  </select>
                  {gradRunning ? (
                    <button
                      onClick={() => cancelChannel('grading')}
                      className="px-2 py-1 text-xs rounded bg-red-900 hover:bg-red-800 text-red-100"
                    >
                      Cancel
                    </button>
                  ) : (
                    <button
                      onClick={handleRunGradingOptimizer}
                      className="px-2 py-1 text-xs rounded bg-emerald-800 hover:bg-emerald-700 text-emerald-50"
                    >
                      Optimize grading
                    </button>
                  )}
                </div>
                {gradRunning && gradProgress && (
                  <div className="text-[10px] text-slate-400 mt-1.5">
                    Evaluating rotations… {gradProgress.done}/{gradProgress.total}
                  </div>
                )}
                {yardRotationDeg !== 0 && (
                  <div className="flex items-center justify-between mt-1.5 text-[11px] text-amber-300">
                    <span>Yard rotated {yardRotationDeg}°</span>
                    <button
                      onClick={() => handleApplyGradingRotation(0)}
                      className="px-1.5 py-0.5 rounded bg-slate-700 hover:bg-slate-600 text-slate-200 text-[10px]"
                    >
                      Reset to 0°
                    </button>
                  </div>
                )}
                {gradResult && gradRows && (
                  <div className="mt-2 text-[11px]">
                    <div className="grid grid-cols-6 gap-x-2 text-slate-400 text-[10px] uppercase tracking-wide">
                      <span>Rot</span><span className="text-right">Cut CY</span><span className="text-right">Fill CY</span><span className="text-right">{gradResult.objective === 'net' ? '|Net| CY' : 'Total CY'}</span><span className="text-right">Δ CY</span><span />
                    </div>
                    {gradRows.map(({ candidate: c, isCurrent, deltaCY }) => (
                      <div key={c.rotationDeg} className={`grid grid-cols-6 gap-x-2 items-center py-0.5 ${isCurrent ? 'text-emerald-300' : c.feasible ? 'text-slate-200' : 'text-slate-500'}`}>
                        <span className="font-mono">{c.rotationDeg}°</span>
                        <span className="text-right font-mono">{Math.round(c.cutCY).toLocaleString()}</span>
                        <span className="text-right font-mono">{Math.round(c.fillCY).toLocaleString()}</span>
                        <span className="text-right font-mono">{Math.round(gradResult.objective === 'net' ? Math.abs(c.netCY) : c.totalCY).toLocaleString()}</span>
                        {isCurrent || deltaCY === null ? (
                          <span className="text-right font-mono text-slate-500">—</span>
                        ) : (
                          <span
                            className={`text-right font-mono ${deltaCY < 0 ? 'text-emerald-400' : deltaCY > 0 ? 'text-rose-400' : 'text-slate-400'}`}
                            title={deltaCY < 0 ? `Saves ${Math.round(-deltaCY).toLocaleString()} CY vs current pose` : deltaCY > 0 ? `Adds ${Math.round(deltaCY).toLocaleString()} CY vs current pose` : 'Same earthwork as current pose'}
                          >
                            {deltaCY > 0 ? '+' : deltaCY < 0 ? '−' : ''}{Math.round(Math.abs(deltaCY)).toLocaleString()}
                          </span>
                        )}
                        {isCurrent ? (
                          <span className="text-right text-[10px]">current</span>
                        ) : c.feasible ? (
                          <button
                            onClick={() => handleApplyGradingRotation(c.rotationDeg)}
                            className="justify-self-end px-1.5 py-0.5 rounded bg-slate-700 hover:bg-slate-600 text-slate-100 text-[10px]"
                          >
                            Apply
                          </button>
                        ) : (
                          <span className="text-right text-[10px]" title={`Fits fewer blocks than the 0° baseline (${gradResult.baselineBlocks})`}>{c.blocksPlaced} blk</span>
                        )}
                      </div>
                    ))}
                    <div className="text-[10px] text-slate-500 mt-1">
                      Best-first by {gradResult.objective === 'net' ? 'cut/fill balance' : 'total earthwork'}; Δ is earthwork vs the current pose (− saves, + adds); the current pose is always listed. Grayed poses fit fewer blocks than the 0° baseline. Screening only.
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
          <label className="flex items-center gap-2 mt-3 text-sm" title="Show the grounding screening layout: perimeter ground loop confined to the BESS island envelope (dashed green), ground rods at corners/spacing/gate, and bonding tap stubs to containers, PCS and FJBs. Preview only — the DXF is unchanged unless the export option below is enabled.">
            <input
              type="checkbox"
              checked={showGrounding}
              onChange={e => setShowGrounding(e.target.checked)}
            />
            <span>Grounding layout (screening)</span>
          </label>
          {showGrounding && (
            <label className="ml-5 mt-1.5 block text-xs text-slate-400" title="Ground rod spacing along the perimeter loop. Corners and the gate always get a rod.">
              Rod spacing
              <select
                value={groundingRodSpacingFt}
                onChange={e => setGroundingRodSpacingFt(Number(e.target.value))}
                className="w-full mt-1 bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-sm text-slate-100"
              >
                {ROD_SPACING_OPTIONS.map(ft => (
                  <option key={ft} value={ft}>{ft} ft</option>
                ))}
              </select>
            </label>
          )}
          {showGrounding && (
            <label className="ml-5 mt-1.5 flex items-center gap-2 text-xs text-slate-400" title="Hide equipment bodies in the 3D/2D view (footprint outlines only) so the buried grounding grid reads like the grounding sheet.">
              <input
                type="checkbox"
                checked={groundingXray}
                onChange={e => setGroundingXray(e.target.checked)}
              />
              <span>X-ray equipment (grid view)</span>
            </label>
          )}
          {showGrounding && groundingPlan && (
            <div className="mt-2 bg-slate-800 rounded p-2.5 text-[11px] leading-relaxed" title="Conductor-quantity takeoff from the screening layout: perimeter loop around the equipment island envelope, rods at corners/spacing/gate, multi-point container/PCS bonds plus aux/FJB bonds, exothermic connections at grid crossings, test wells along the loop. Screening only.">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400 mb-1">
                Grounding (screening)
              </div>
              <div className="flex flex-wrap gap-x-3 gap-y-0.5 mb-1.5 text-[10px] text-slate-400">
                <span className="flex items-center gap-1"><span className="inline-block w-3 h-0.5" style={{ background: '#39d353' }} /> Loop {Math.round(groundingPlan.summary.loopLengthFt).toLocaleString()} LF</span>
                <span className="flex items-center gap-1"><span className="inline-block w-3 h-0.5" style={{ background: '#2dd4bf' }} /> Grid {Math.round(groundingPlan.summary.gridLengthFt).toLocaleString()} LF</span>
                <span className="flex items-center gap-1"><span className="inline-block w-3 h-0.5" style={{ background: '#fbbf24' }} /> Taps {Math.round(groundingPlan.summary.tapLengthFt).toLocaleString()} LF</span>
                <span className="flex items-center gap-1"><span className="inline-block w-2 h-2 rounded-full" style={{ background: '#39d353' }} /> Rods {groundingPlan.summary.rodCount}</span>
                <span className="flex items-center gap-1"><span className="inline-block w-2 h-2 rounded-full border" style={{ borderColor: '#a3e635' }} /> Wells {groundingPlan.summary.testWellCount}</span>
                <span className="flex items-center gap-1"><span className="inline-block w-1.5 h-1.5 rounded-full" style={{ background: '#2dd4bf' }} /> Crossings {groundingPlan.summary.crossingCount}</span>
              </div>
              <div className="grid grid-cols-2 gap-x-3 text-slate-300">
                <span>Perimeter loop</span>
                <span className="text-right font-mono">{Math.round(groundingPlan.summary.loopLengthFt).toLocaleString()} LF</span>
                <span>Ground rods</span>
                <span className="text-right font-mono">{groundingPlan.summary.rodCount} @ {groundingPlan.summary.rodSpacingFt} ft</span>
                <span>Test wells</span>
                <span className="text-right font-mono">{groundingPlan.summary.testWellCount}</span>
                <span>Interior grid</span>
                <span className="text-right font-mono">{Math.round(groundingPlan.summary.gridLengthFt).toLocaleString()} LF</span>
                <span>Grid crossings</span>
                <span className="text-right font-mono">{groundingPlan.summary.crossingCount}</span>
                <span>Bonding taps</span>
                <span className="text-right font-mono">{groundingPlan.summary.tapCount} ({Math.round(groundingPlan.summary.tapLengthFt).toLocaleString()} LF)</span>
                <span>Total conductor</span>
                <span className="text-right font-mono">{Math.round(groundingPlan.summary.totalConductorFt).toLocaleString()} LF</span>
                <span>Grid area</span>
                <span className="text-right font-mono">{(groundingPlan.summary.gridAreaSqFt / 43560).toFixed(2)} ac</span>
              </div>
              <div className="text-[10px] text-slate-500 mt-1">
                Quantity takeoff only — not an IEEE-80 grid resistance or touch/step study.
              </div>
            </div>
          )}
          {showGrounding && design && !groundingPlan && (
            <div className="ml-5 mt-1.5 text-[10px] text-amber-400">
              Grounding loop could not be inset inside this fence — layout unavailable.
            </div>
          )}
          {exportGroundingDxf && design && groundingPlan && (
            <GroundingFigurePreview grounding={groundingPlan} design={design} />
          )}
          {exportGroundingDxf && design && !groundingPlan && (
            <div className="ml-5 mt-1.5 text-[10px] text-amber-400">
              Grounding loop could not be inset inside this fence — the packet's grounding section will be omitted.
            </div>
          )}
          <label className="flex items-center gap-2 mt-3 text-sm" title="Run a screening-grade IEEE Std 80-2013 grounding grid study on the layout's perimeter loop + rods + taps: grid resistance, GPR, mesh (touch) and step voltages vs tolerable limits. When enabled, the study is added to the permit packet PDF as its own section. Uniform soil model; final study is Engineer-of-Record scope.">
            <input
              type="checkbox"
              checked={ieee80Enabled}
              onChange={e => setIeee80Enabled(e.target.checked)}
            />
            <span>IEEE-80 grid study</span>
          </label>
          {ieee80Enabled && design && !groundingPlan && (
            <div className="ml-5 mt-1.5 text-[10px] text-amber-400">
              Grounding loop could not be inset inside this fence — the study needs the grid geometry.
            </div>
          )}
          {ieee80Enabled && (
            <div className="mt-2 bg-slate-800 rounded p-2.5 text-[11px] leading-relaxed">
              <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400 mb-1.5">
                IEEE-80 Study Inputs
              </div>
              <div className="grid grid-cols-2 gap-x-2 gap-y-1.5">
                <StudyNumField label="Soil ρ (Ω·m)" unit="Ω·m" title="Uniform soil resistivity from a field Wenner test. Typical: 10 (wet clay) to 1000+ (dry sand/rock) Ω·m."
                  step={10} min={IEEE80_NUM_LIMITS.soilRhoOhmM.min} max={IEEE80_NUM_LIMITS.soilRhoOhmM.max}
                  value={ieee80Inputs.soilRhoOhmM}
                  onCommit={v => { if (v !== null) setIeee80Inputs({ soilRhoOhmM: v }); }} />
                <StudyNumField label="Rock ρs (Ω·m)" unit="Ω·m" title="Crushed-rock surface layer resistivity (wet). 2500 Ω·m is the common design value; set Rock depth to 0 to disable the layer."
                  step={100} min={IEEE80_NUM_LIMITS.surfaceRhoOhmM.min} max={IEEE80_NUM_LIMITS.surfaceRhoOhmM.max}
                  value={ieee80Inputs.surfaceRhoOhmM}
                  onCommit={v => { if (v !== null) setIeee80Inputs({ surfaceRhoOhmM: v }); }} />
                <StudyNumField label="Rock depth (in)" unit="in" title="Crushed-rock layer thickness in inches (4 in typical — matches the yard surfacing depth)."
                  step={1} min={displayBounds(IEEE80_NUM_LIMITS.surfaceThicknessM, 0.0254, 1).min} max={displayBounds(IEEE80_NUM_LIMITS.surfaceThicknessM, 0.0254, 1).max}
                  displayDecimals={1}
                  value={Math.round(ieee80Inputs.surfaceThicknessM / 0.0254 * 10) / 10}
                  onCommit={v => { if (v !== null) setIeee80Inputs({ surfaceThicknessM: v * 0.0254 }); }} />
                <StudyNumField label="Fault 3I0 (A)" unit="A" title="Symmetrical ground fault current 3I0 at the site (A), from the utility short-circuit study."
                  step={500} min={IEEE80_NUM_LIMITS.faultCurrentA.min} max={IEEE80_NUM_LIMITS.faultCurrentA.max}
                  value={ieee80Inputs.faultCurrentA}
                  onCommit={v => { if (v !== null) setIeee80Inputs({ faultCurrentA: v }); }} />
                <StudyNumField label="Clearing tf (s)" unit="s" title="Fault clearing time tf (s) — primary protection total clearing time."
                  step={0.05} min={IEEE80_NUM_LIMITS.faultDurationS.min} max={IEEE80_NUM_LIMITS.faultDurationS.max}
                  value={ieee80Inputs.faultDurationS}
                  onCommit={v => { if (v !== null) setIeee80Inputs({ faultDurationS: v }); }} />
                <StudyNumField label="Split Sf" title="Current division factor Sf — the fraction of 3I0 that flows between the grid and remote earth. 1.0 = all of it (conservative); lower when overhead ground wires / neutrals divert current."
                  step={0.05} min={IEEE80_NUM_LIMITS.splitFactorSf.min} max={IEEE80_NUM_LIMITS.splitFactorSf.max}
                  value={ieee80Inputs.splitFactorSf}
                  onCommit={v => { if (v !== null) setIeee80Inputs({ splitFactorSf: v }); }} />
                <StudyNumField label="X/R" title="System X/R ratio at the fault — sets the DC-offset decrement factor Df (Eq. 79). 0 = ignore (Df = 1)."
                  step={1} min={IEEE80_NUM_LIMITS.xOverR.min} max={IEEE80_NUM_LIMITS.xOverR.max}
                  value={ieee80Inputs.xOverR}
                  onCommit={v => { if (v !== null) setIeee80Inputs({ xOverR: v }); }} />
                <label className="text-[10px] text-slate-400" title="Tolerable-limit body weight basis: 50 kg (public/conservative) or 70 kg (typical utility worker).">
                  Body weight
                  <select value={ieee80Inputs.bodyWeightKg}
                    onChange={e => setIeee80Inputs({ bodyWeightKg: Number(e.target.value) as 50 | 70 })}
                    className="w-full mt-0.5 bg-slate-900 border border-slate-600 rounded px-1.5 py-1 text-xs text-slate-100">
                    <option value={70}>70 kg</option>
                    <option value={50}>50 kg</option>
                  </select>
                </label>
                <StudyNumField label="Burial (in)" unit="in" title="Grid conductor burial depth in inches (18 in typical)."
                  step={1} min={displayBounds(IEEE80_NUM_LIMITS.burialDepthM, 0.0254, 0).min} max={displayBounds(IEEE80_NUM_LIMITS.burialDepthM, 0.0254, 0).max}
                  displayDecimals={0}
                  value={Math.round(ieee80Inputs.burialDepthM / 0.0254)}
                  onCommit={v => { if (v !== null) setIeee80Inputs({ burialDepthM: v * 0.0254 }); }} />
                <StudyNumField label="Rod length (ft)" unit="ft" title="Ground rod length in feet (10 ft copper-clad typical)."
                  step={1} min={displayBounds(IEEE80_NUM_LIMITS.rodLengthM, FT_TO_M, 1).min} max={displayBounds(IEEE80_NUM_LIMITS.rodLengthM, FT_TO_M, 1).max}
                  displayDecimals={1}
                  value={Math.round(ieee80Inputs.rodLengthM / FT_TO_M * 10) / 10}
                  onCommit={v => { if (v !== null) setIeee80Inputs({ rodLengthM: v * FT_TO_M }); }} />
                <StudyNumField className="col-span-2" label="Grid conductor (kcmil)" unit="kcmil" title="Installed grid conductor size (kcmil). 4/0 AWG = 211.6 kcmil is the common BESS yard loop; checked against the Eq. 37 thermal minimum for the entered fault."
                  step={1} min={IEEE80_NUM_LIMITS.conductorKcmil.min} max={IEEE80_NUM_LIMITS.conductorKcmil.max}
                  value={ieee80Inputs.conductorKcmil}
                  onCommit={v => { if (v !== null) setIeee80Inputs({ conductorKcmil: v }); }} />
              </div>
            </div>
          )}
          {ieee80Enabled && ieee80Study && (
            <div className="mt-2 bg-slate-800 rounded p-2.5 text-[11px] leading-relaxed" title="IEEE Std 80-2013 screening study computed from the grounding layout geometry (uniform soil model). Included in the permit packet PDF while enabled.">
              <div className="flex items-center justify-between mb-1">
                <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                  IEEE-80 Study Results
                </div>
                <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${ieee80Study.overallPass ? 'bg-emerald-700 text-emerald-100' : 'bg-red-800 text-red-100'}`}>
                  {ieee80Study.overallPass ? 'PASS' : 'FAIL'}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-x-3 text-slate-300">
                <span>Grid resistance Rg</span>
                <span className="text-right font-mono">{ieee80Study.rgOhm.toFixed(3)} Ω</span>
                <span>Grid current IG</span>
                <span className="text-right font-mono">{Math.round(ieee80Study.igA).toLocaleString()} A</span>
                <span>GPR</span>
                <span className="text-right font-mono">{Math.round(ieee80Study.gprV).toLocaleString()} V</span>
                <span>Mesh voltage Em</span>
                <span className={`text-right font-mono ${ieee80Study.touchPass ? '' : 'text-red-400'}`}>
                  {Math.round(ieee80Study.emV).toLocaleString()} / {Math.round(ieee80Study.etouchV).toLocaleString()} V {ieee80Study.touchPass ? '✓' : '✗'}
                </span>
                <span>Step voltage Es</span>
                <span className={`text-right font-mono ${ieee80Study.stepPass ? '' : 'text-red-400'}`}>
                  {Math.round(ieee80Study.esV).toLocaleString()} / {Math.round(ieee80Study.estepV).toLocaleString()} V {ieee80Study.stepPass ? '✓' : '✗'}
                </span>
                <span>Conductor sizing</span>
                <span className={`text-right font-mono ${ieee80Study.conductorOk ? '' : 'text-red-400'}`}>
                  ≥ {ieee80Study.requiredKcmil.toFixed(0)} kcmil {ieee80Study.conductorOk ? '✓' : '✗'}
                </span>
              </div>
              {ieee80Study.gprBelowTouch && (
                <div className="text-[10px] text-emerald-400 mt-1">
                  GPR is below the tolerable touch voltage — grid is safe without further mesh/step analysis.
                </div>
              )}
              {!ieee80Study.overallPass && (
                <div className="text-[10px] text-amber-400 mt-1">
                  {!ieee80Study.touchPass && 'Touch: add interior grid conductors, more rods, or thicker crushed rock. '}
                  {!ieee80Study.stepPass && 'Step: add perimeter rods or increase burial depth. '}
                  {!ieee80Study.conductorOk && 'Upsize the grid conductor for fault thermal duty.'}
                </div>
              )}
              <div className="text-[10px] text-slate-500 mt-1">
                Uniform soil model, screening grade — included in the permit packet PDF while enabled.
              </div>
            </div>
          )}
          <button
            onClick={() => {
              requestInspectTrench();
              toast.success('Flying camera to the 480V aux & fiber trench');
            }}
            disabled={!design?.trench}
            title="Fly the 3D camera to a low close-up of the 480V aux & fiber trench to inspect the recessed channel, blue LVAC and orange fiber conductors — 3D preview only, DXF/PDF unaffected"
            className="w-full mt-3 py-1.5 rounded bg-slate-700 hover:bg-slate-600 text-xs font-semibold text-slate-100 disabled:opacity-40 disabled:hover:bg-slate-700"
          >
            Inspect trench up close (3D)
          </button>
          <button
            onClick={() => {
              useDesignStore.getState().setWalkMode(true);
              toast.success('Walking the site — the gate is swinging open. WASD or arrow keys to walk, Shift to jog, click the view to look around');
            }}
            disabled={!design?.gate}
            title="Drop to eye level at the site entrance: the gate swings open and you can walk the roads and yard in first person (WASD/arrows + mouse look) — 3D preview only, DXF/PDF unaffected"
            className="w-full mt-2 py-1.5 rounded bg-cyan-700 hover:bg-cyan-600 text-xs font-semibold text-slate-100 disabled:opacity-40 disabled:hover:bg-cyan-700"
          >
            Walk the site (first person)
          </button>
          <button
            onClick={() => {
              requestOverview();
              toast.success('Flying camera back to the full-site overview');
            }}
            disabled={!design}
            title="Fly the 3D camera back to the default full-site view with the whole parcel in frame — 3D preview only, DXF/PDF unaffected"
            className="w-full mt-2 py-1.5 rounded bg-slate-700 hover:bg-slate-600 text-xs font-semibold text-slate-100 disabled:opacity-40 disabled:hover:bg-slate-700"
          >
            Back to full-site overview (3D)
          </button>
          <div className="grid grid-cols-2 gap-3 mt-3">
            <label className="text-xs text-slate-400">
              Laydown area (% of yard)
              <input
                type="number"
                min={0}
                max={50}
                step={1}
                value={laydownPct}
                onChange={e => setLaydownPct(Number(e.target.value) || 0)}
                className="w-full mt-1 bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-sm text-slate-100"
              />
            </label>
            <label className="text-xs text-slate-400">
              Future augmentation (% of blocks)
              <input
                type="number"
                min={0}
                max={100}
                step={1}
                value={augmentPct}
                onChange={e => setAugmentPct(Number(e.target.value) || 0)}
                className="w-full mt-1 bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-sm text-slate-100"
              />
            </label>
            <label className="text-xs text-slate-400">
              Future phase (augmentation units)
              <input
                type="number"
                min={0}
                max={50}
                step={1}
                value={futurePhaseUnits}
                onChange={e => setFuturePhaseUnits(Number(e.target.value) || 0)}
                className="w-full mt-1 bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-sm text-slate-100"
              />
            </label>
          </div>
          <div className="text-[10px] text-slate-500 mt-1">
            Each augmentation unit reserves QTY 2 PCS + QTY 6 BESS (one mirrored pair), shown ghosted in 3D and dashed in the DXF.
          </div>
          {(design?.islands?.length ?? 0) > 0 && (
            <div className="mt-2 space-y-1">
              <div className="text-xs text-slate-400 font-medium">Per-island augmentation units (default {DEFAULT_ISLAND_AUG_UNITS}, 0 disables)</div>
              {design!.islands!.map(isl => {
                const count = layoutEdits.islandAugUnits?.[isl.n] ?? DEFAULT_ISLAND_AUG_UNITS;
                return (
                  <div key={isl.n} className="flex items-center justify-between text-xs bg-slate-800 rounded px-2 py-1">
                    <span className="text-slate-300">Island {isl.n}</span>
                    <span className="flex items-center gap-2">
                      <button
                        className="px-2 py-0.5 rounded bg-slate-700 hover:bg-slate-600 disabled:opacity-40"
                        disabled={count <= 0}
                        onClick={() => setIslandAugUnits(isl.n, count - 1)}
                      >
                        −
                      </button>
                      <span className="w-6 text-center text-slate-200">{count}</span>
                      <button
                        className="px-2 py-0.5 rounded bg-slate-700 hover:bg-slate-600 disabled:opacity-40"
                        disabled={count >= MAX_ISLAND_AUG_UNITS}
                        onClick={() => setIslandAugUnits(isl.n, count + 1)}
                      >
                        +
                      </button>
                    </span>
                  </div>
                );
              })}
            </div>
          )}
          {(design?.islands?.length ?? 0) > 0 && (
            <div className="mt-2 space-y-1">
              <div className="text-xs text-slate-400 font-medium">Augmentation end (swap left ⇄ right per island)</div>
              {design!.islands!.map(isl => {
                // Placed islands are keyed by their pisl id; auto by number.
                const spec = isl.placed
                  ? (layoutEdits.placedIslands ?? []).find(p =>
                      Math.abs(p.x - (isl.cx ?? NaN)) < 0.01 && Math.abs(p.y - (isl.cy ?? NaN)) < 0.01)
                  : null;
                const key = isl.placed ? spec?.id : String(isl.n);
                if (!key) return null;
                // Current side from the actual zones (works for auto scans too)
                const zones = (design?.reservedZones ?? []).filter(z => z.id.startsWith(`island-aug-${isl.n}-`));
                const islCx = isl.vertical ? (isl.cy ?? 0) : (isl.minX + isl.maxX) / 2;
                const zCx = zones.length ? zones.reduce((s, z) => s + (isl.vertical ? z.y : z.x), 0) / zones.length : null;
                const curSide: 'east' | 'west' | null = zCx === null ? null : zCx >= islCx ? 'east' : 'west';
                return (
                  <div key={`augend-${isl.n}`} className="flex items-center justify-between text-xs bg-slate-800 rounded px-2 py-1">
                    <span className="text-slate-300">Island {isl.n}{isl.placed ? ' (placed)' : ''}
                      {curSide && <span className="text-slate-500"> — {curSide}</span>}</span>
                    <button
                      className="px-2 py-0.5 rounded bg-slate-700 hover:bg-slate-600 disabled:opacity-40"
                      disabled={!curSide}
                      onClick={() => {
                        const target = curSide === 'east' ? 'west' : 'east';
                        const why = setIslandAugEnd(key, target);
                        if (why === null) toast.success(`Island ${isl.n} augmentation moved to the ${target} end`);
                        else toast.error(`Swap rejected — ${why}`, { duration: 8000 });
                      }}
                    >
                      ⇄ Swap end
                    </button>
                  </div>
                );
              })}
            </div>
          )}
          {(design?.islands?.length ?? 0) > 0 && (
            <div className="mt-2 space-y-1">
              <div className="text-xs text-slate-400 font-medium">Per-island PCS+QTY3 blocks (add or remove a block)</div>
              {design!.islands!.map(isl => {
                const blockCount = isl.southIds.length + isl.northIds.length;
                return (
                  <div key={isl.n} className="flex items-center justify-between text-xs bg-slate-800 rounded px-2 py-1">
                    <span className="text-slate-300">Island {isl.n} — {blockCount} block{blockCount === 1 ? '' : 's'}</span>
                    <span className="flex items-center gap-2">
                      <button
                        className="px-2 py-0.5 rounded bg-slate-700 hover:bg-slate-600 disabled:opacity-40"
                        disabled={blockCount <= 1}
                        onClick={() => {
                          const err = adjustIslandBlocks(isl.n, -1);
                          if (err) toast.error(`Remove block: ${err}`);
                        }}
                      >
                        −
                      </button>
                      <button
                        className="px-2 py-0.5 rounded bg-slate-700 hover:bg-slate-600"
                        onClick={() => {
                          const err = adjustIslandBlocks(isl.n, 1);
                          if (err) toast.error(`Add block: ${err}`);
                        }}
                      >
                        +
                      </button>
                    </span>
                  </div>
                );
              })}
            </div>
          )}
          {design?.reserveSummary && (
            <div className="text-[11px] text-slate-400 mt-2 space-y-0.5 bg-slate-800 rounded p-2">
              {design.reserveSummary.laydownPct > 0 && (
                <div>
                  Laydown: {(design.reserveSummary.laydownPlacedSqFt / 43560).toFixed(2)} of{' '}
                  {(design.reserveSummary.laydownRequestedSqFt / 43560).toFixed(2)} acres placed
                </div>
              )}
              {(design.reserveSummary.augPct > 0 || design.reserveSummary.augBlocksRequested > 0) && (
                <div>
                  Future augmentation: {design.reserveSummary.augBlocksPlaced} of{' '}
                  {design.reserveSummary.augBlocksRequested} block footprint(s) reserved
                  {design.reserveSummary.augBlocksPlaced > 0 && (
                    <> (+{design.reserveSummary.augMW.toFixed(1)} MW / +{design.reserveSummary.augMWh.toFixed(1)} MWh future)</>
                  )}
                </div>
              )}
            </div>
          )}
        </PanelSection>

        {/* Step 4: Title block info */}
        <PanelSection id="titleblock" title="4. Title Block" discipline="Exports">
          <div className="space-y-2">
            <label className="text-xs text-slate-400 block">
              Project Name
              <input
                type="text"
                value={titleBlock.projectName}
                onChange={e => setTitleBlock({ projectName: e.target.value })}
                placeholder={boundary ? boundary.name : 'e.g. Hondo BESS'}
                className="w-full mt-1 bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-sm text-slate-100 placeholder:text-slate-500"
              />
            </label>
            <label className="text-xs text-slate-400 block">
              Location (County, State)
              <input
                type="text"
                value={titleBlock.location}
                onChange={e => setTitleBlock({ location: e.target.value })}
                placeholder="e.g. Medina County, TX"
                className="w-full mt-1 bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-sm text-slate-100 placeholder:text-slate-500"
              />
              {(isCoordinateLocation(titleBlock.location) || (!titleBlock.location.trim() && !!boundary)) && (
                <span className="block mt-0.5 text-[10px] text-slate-500">
                  Coordinates or blank — county/state auto-fills from the site location (type a place name to override)
                </span>
              )}
            </label>
            <div className="grid grid-cols-3 gap-2">
              <label className="text-xs text-slate-400 block">
                Drawn By
                <input
                  type="text"
                  value={titleBlock.drafter}
                  onChange={e => setTitleBlock({ drafter: e.target.value })}
                  placeholder="Initials"
                  className="w-full mt-1 bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-sm text-slate-100 placeholder:text-slate-500"
                />
              </label>
              <label className="text-xs text-slate-400 block">
                Rev
                <input
                  type="text"
                  value={titleBlock.revision}
                  onChange={e => setTitleBlock({ revision: e.target.value })}
                  placeholder="0A"
                  className="w-full mt-1 bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-sm text-slate-100 placeholder:text-slate-500"
                />
              </label>
              <label className="text-xs text-slate-400 block">
                Date
                <input
                  type="text"
                  value={titleBlock.date}
                  onChange={e => setTitleBlock({ date: e.target.value })}
                  placeholder={new Date().toLocaleDateString()}
                  className="w-full mt-1 bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-sm text-slate-100 placeholder:text-slate-500"
                />
              </label>
            </div>
            <label className="text-xs text-slate-400 block">
              NEER Dwg. Name (10% banner)
              <input
                type="text"
                value={titleBlock.neerDwgName}
                onChange={e => setTitleBlock({ neerDwgName: e.target.value })}
                placeholder="e.g. CK1-E-200 (blank = empty cell)"
                className="w-full mt-1 bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-sm text-slate-100 placeholder:text-slate-500"
              />
            </label>
            <label className="flex items-center gap-2 mt-2 text-sm" title="Draw the legend equipment symbols in the ECI reference legend style (traced from the issued legend sheets). Only the legend swatch glyphs change — rows, labels and the drawing itself are untouched. Saved with the project.">
              <input
                type="checkbox"
                checked={eciLegend}
                onChange={e => setEciLegend(e.target.checked)}
              />
              <span>ECI legend symbols</span>
            </label>
          </div>
        </PanelSection>

        {/* Step 5: Substation + MV feeders */}
        <PanelSection id="electrical" title="5. Substation &amp; MV Feeders" discipline="Electrical">
          {!design ? (
            <div className="text-xs text-slate-500">Generate a layout first.</div>
          ) : (
            <div className="space-y-2">
              <div className="flex gap-2">
                <button
                  onClick={() => setPlacingSubstation(!placingSubstation)}
                  className={`flex-1 text-xs px-2 py-2 rounded font-semibold transition-colors ${
                    placingSubstation
                      ? 'bg-pink-700 hover:bg-pink-600 text-white'
                      : 'bg-slate-700 hover:bg-slate-600'
                  }`}
                >
                  {placingSubstation ? 'Click map to place… (cancel)' : substation ? 'Move substation' : 'Place substation'}
                </button>
                {substation && (
                  <button
                    onClick={() => {
                      const notice = removeSubstation();
                      if (notice) toast.warning(notice);
                    }}
                    className="text-xs px-2 py-2 rounded bg-slate-700 hover:bg-red-800"
                  >
                    Remove
                  </button>
                )}
              </div>
              {substation && (
                <>
                  <label className="text-xs text-slate-400 block">
                    Conductor material
                    <select
                      value={feederMaterial}
                      onChange={e => handleMaterialChange(e.target.value as ConductorMaterial)}
                      className="w-full mt-1 bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-sm text-slate-100"
                    >
                      <option value="Al">Aluminum</option>
                      <option value="Cu">Copper</option>
                    </select>
                  </label>
                  <div className="text-xs text-slate-400">
                    Feeder standard
                    <div className="w-full mt-1 bg-slate-800 border border-slate-700 rounded px-2 py-1.5 text-sm text-slate-300">
                      7 built + 2 future PCS (9 total) — fixed
                    </div>
                  </div>
                  {feeders.map(f => (
                    <div key={f.idx} className={`rounded p-2 text-xs space-y-1 border ${f.overLimit || f.overAmpacity ? 'bg-red-950/60 border-red-700' : 'bg-slate-800 border-slate-700'}`}>
                      <div className="flex justify-between font-semibold">
                        <span>Feeder #{feederDisplayName(f)}</span>
                        <span>{f.inverterIds.length} PCS units</span>
                      </div>
                      <div className="flex justify-between text-slate-400">
                        <span>Load</span>
                        <span className="text-slate-200">{f.loadMW.toFixed(2)} MW / {f.amps.toFixed(0)} A</span>
                      </div>
                      <div className="flex justify-between text-slate-400">
                        <span>Length</span>
                        <span className="text-slate-200">{Math.ceil(f.totalLengthFt).toLocaleString()} LF</span>
                      </div>
                      <div className="flex justify-between items-center text-slate-400">
                        <span>Conductor</span>
                        <select
                          value={f.size}
                          onChange={e => setFeederSize(f.idx, e.target.value as FeederConductorSize)}
                          className="bg-slate-900 border border-slate-600 rounded px-1 py-0.5 text-xs text-slate-100"
                        >
                          {FEEDER_CONDUCTOR_SIZES.map(s => (
                            <option key={s} value={s}>{s} kcmil</option>
                          ))}
                        </select>
                      </div>
                      <div className="flex justify-between text-slate-400">
                        <span>Ampacity (EOL basis)</span>
                        <span className={f.overAmpacity ? 'text-red-400 font-semibold' : 'text-emerald-400'}>
                          BOL {f.amps.toFixed(0)} / EOL {(f.eolAmps || f.amps).toFixed(0)} A of {(Math.max(1, f.parallelSets || 1) * (f.effectiveAmpacity || f.ampacity)).toFixed(0)} A derated
                        </span>
                      </div>
                      {f.overAmpacity && (
                        <div className="text-red-400">
                          ⚠ Current exceeds conductor ampacity.{' '}
                          {f.ampacityRecommendedSize
                            ? `Recommend ${f.ampacityRecommendedSize} kcmil.`
                            : `Use ${f.parallelRunsNeeded} parallel conductors per phase, or split the feeder.`}
                        </div>
                      )}
                      <div className="flex justify-between text-slate-400">
                        <span>Voltage drop</span>
                        <span className={f.overLimit ? 'text-red-400 font-semibold' : 'text-emerald-400'}>
                          {f.vdPct.toFixed(2)}% ({f.vdVolts.toFixed(0)} V)
                        </span>
                      </div>
                      {f.overLimit && (
                        <div className="text-red-400">
                          ⚠ Exceeds {VD_LIMIT_PCT}% limit.{' '}
                          {f.recommendedSize
                            ? `Recommend ${f.recommendedSize} kcmil.`
                            : 'No larger size meets the limit — split the feeder or move the substation closer.'}
                        </div>
                      )}
                      {feeders.length > 1 && (
                        <div className="flex justify-between items-center text-slate-400 pt-1 border-t border-slate-700/60">
                          <span>Move PCS unit…</span>
                          <select
                            value=""
                            onChange={e => {
                              const [invId, tgt] = e.target.value.split('→');
                              if (!invId) return;
                              const ok = assignInverterToFeeder(invId, Number(tgt));
                              if (!ok) toast.error(`Feeder ${tgt} is full (max 7 PCS units)`);
                            }}
                            className="bg-slate-900 border border-slate-600 rounded px-1 py-0.5 text-xs text-slate-100 max-w-[150px]"
                          >
                            <option value="">select</option>
                            {f.inverterIds.map(id =>
                              feeders
                                .filter(o => o.idx !== f.idx)
                                .map(o => (
                                  <option key={`${id}→${o.idx}`} value={`${id}→${o.idx}`}>
                                    {id} → Feeder #{feederDisplayName(o)}
                                  </option>
                                ))
                            )}
                          </select>
                        </div>
                      )}
                    </div>
                  ))}
                  {Object.keys(feederAssignments).length > 0 && (
                    <button
                      onClick={resetFeederOverrides}
                      className="w-full text-xs px-2 py-1.5 rounded bg-slate-700 hover:bg-slate-600"
                    >
                      Reset feeder grouping to auto
                    </button>
                  )}
                  {Object.keys(layoutEdits.feederRoutes ?? {}).length > 0 && (
                    <div className="rounded p-2 text-xs space-y-1 border bg-slate-800 border-slate-700">
                      <div className="font-semibold text-slate-200">Custom feeder routes</div>
                      {Object.keys(layoutEdits.feederRoutes ?? {}).map(key => {
                        const live = feeders.find(f => feederRouteKey(f.inverterIds) === key);
                        const forced = (layoutEdits.forcedEdits ?? []).includes(`feeder-route-${key}`);
                        return (
                          <div key={key} className="flex items-center justify-between gap-2">
                            <span className="text-slate-400">
                              {live ? `Feeder #${feederDisplayName(live)}` : `${key} (inactive)`}
                              {forced ? ' — engineer override' : ''}
                              {!live ? ' — no feeder currently anchors on this PCS' : ''}
                            </span>
                            <button
                              onClick={() => removeFeederRoute(key)}
                              className="text-xs px-2 py-0.5 rounded bg-slate-700 hover:bg-slate-600 shrink-0"
                            >
                              Reset
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                  {/* Feeder-routing optimizer: re-orients how the MV bundle
                      leaves the substation. Never auto-applied — the drafter
                      reviews ranked cards and picks one. */}
                  {substation && feeders.length > 0 && (
                    <div className="rounded p-2 text-xs space-y-1.5 border bg-slate-800 border-slate-700">
                      <div className="font-semibold text-slate-200">Feeder routing optimizer</div>
                      {!frRunning ? (
                        <button
                          onClick={handleRunFeederOptimizer}
                          className="w-full py-1.5 rounded bg-emerald-700 hover:bg-emerald-600 text-xs font-semibold text-slate-100"
                        >
                          Optimize feeder routing
                        </button>
                      ) : (
                        <div className="space-y-1.5">
                          <div className="flex items-center justify-between text-slate-400">
                            <span>Searching routings… {frProgress ? `${frProgress.done}/${frProgress.total}` : ''}</span>
                            <button
                              onClick={() => cancelChannel('feederRouting')}
                              className="px-2 py-1 rounded bg-slate-700 hover:bg-slate-600 text-xs font-semibold text-slate-100"
                            >
                              Cancel
                            </button>
                          </div>
                          <div className="h-1.5 rounded bg-slate-700 overflow-hidden">
                            <div
                              className="h-full bg-emerald-500 transition-all"
                              style={{ width: `${frProgress && frProgress.total > 0 ? Math.round((frProgress.done / frProgress.total) * 100) : 0}%` }}
                            />
                          </div>
                        </div>
                      )}
                      <div className="text-[10px] text-slate-500">
                        Tries 90°, angled and combined home-run orientations plus corridor positions for this yard, and ranks them by fewest crossings, then most uniform lane spacing, then least conductor. Block placement, the substation position and feeder grouping are never changed.
                      </div>
                      {frResult && frResult.current && (
                        <div className="text-[10px] text-slate-500">
                          Current: {frResult.current.metrics.crossings} crossing{frResult.current.metrics.crossings === 1 ? '' : 's'} ·{' '}
                          {frResult.current.metrics.uniformityPct.toFixed(0)}% uniform ·{' '}
                          {frResult.current.metrics.conductorFt.toFixed(0)} ft
                        </div>
                      )}
                      {frResult && frResult.candidates.map((cand, i) => {
                        const m = cand.metrics;
                        const cur = frResult.current;
                        const label = m.angledCount - m.angledFallbacks === 0 ? '90° corridor'
                          : cand.orientation === 'angled' ? 'Angled corridor'
                          : `Combined (${m.angledCount - m.angledFallbacks} of ${m.feederCount} angled)`;
                        return (
                          <div key={cand.id} className="rounded border border-slate-700 bg-slate-900/60 p-2 space-y-1">
                            <div className="flex items-center justify-between gap-2">
                              <span className="font-semibold text-slate-200">
                                #{i + 1} — {label}
                                {i === 0 && <span className="text-emerald-400 font-normal"> — best</span>}
                              </span>
                              <button
                                onClick={() => handleApplyFeederRouting(cand)}
                                className="shrink-0 px-2 py-1 rounded bg-emerald-700 hover:bg-emerald-600 text-xs font-semibold text-slate-100"
                              >
                                Apply
                              </button>
                            </div>
                            <div className="grid grid-cols-2 gap-x-3 text-slate-400">
                              <span>Crossings: {m.crossings}{m.auxCrossings > 0 ? ` (+${m.auxCrossings} aux)` : ''}</span>
                              <span>Spacing: {m.uniformityPct.toFixed(0)}% uniform</span>
                              <span>Conductor: {m.conductorFt.toFixed(0)} ft</span>
                              {cur && (
                                <span className={m.conductorFt <= cur.metrics.conductorFt ? 'text-emerald-400' : 'text-amber-400'}>
                                  {m.conductorFt <= cur.metrics.conductorFt ? '−' : '+'}
                                  {Math.abs(m.conductorFt - cur.metrics.conductorFt).toFixed(0)} ft vs current
                                </span>
                              )}
                            </div>
                            <div className="text-[10px] text-slate-500">
                              Corridor {cand.params.corridorPin === null ? 'automatic' : `pinned at ${Math.round(cand.params.corridorPin)} ft`}
                              {m.angledFallbacks > 0 && ` · ${m.angledFallbacks} feeder${m.angledFallbacks > 1 ? 's have' : ' has'} no clear diagonal and keeps its 90° route`}
                            </div>
                          </div>
                        );
                      })}
                      {frResult && frResult.candidates.length === 0 && (
                        <div className="text-slate-500">
                          No cleaner routing found — the current feeder bundle is already the best of the orientations tried.
                        </div>
                      )}
                      {frResult && frResult.candidates.length > 0 && (
                        <div className="text-[10px] text-slate-500">
                          Applying sets the routing mode, per-feeder overrides and corridor position as one step. Undo with Ctrl+Z.
                        </div>
                      )}
                    </div>
                  )}
                  {electricalReport && (
                    <div className="rounded p-2 text-xs space-y-1.5 border bg-slate-800 border-slate-700">
                      <div className="font-semibold text-slate-200">Voltage Drop &amp; Losses</div>
                      <div className="text-[10px] text-slate-400">
                        EOL basis: currents include reserved augmentation PCS; capacity = parallel sets × mutual-heating-derated rating — same basis that sized each conductor (matches SLD/DXF).
                      </div>
                      <div className="grid grid-cols-2 gap-2 text-slate-400">
                        <label className="block" title="Feeders above this % voltage drop are flagged here and in the pre-export checklist. Screening preference only — auto conductor sizing keeps its 3% engineering default.">
                          Max VD (%)
                          <input
                            type="number"
                            min={0.5}
                            max={10}
                            step={0.5}
                            value={maxVdPct}
                            onChange={e => setMaxVdPct(Number(e.target.value))}
                            className="w-full mt-1 bg-slate-900 border border-slate-600 rounded px-2 py-1 text-xs text-slate-100"
                          />
                        </label>
                        <label className="block" title="Capacity (load) factor used for the annual I²R loss estimate: loss factor = 0.3·LF + 0.7·LF².">
                          Capacity factor (%)
                          <input
                            type="number"
                            min={5}
                            max={100}
                            step={5}
                            value={capacityFactorPct}
                            onChange={e => setCapacityFactorPct(Number(e.target.value))}
                            className="w-full mt-1 bg-slate-900 border border-slate-600 rounded px-2 py-1 text-xs text-slate-100"
                          />
                        </label>
                      </div>
                      <table className="w-full text-[11px]">
                        <thead>
                          <tr className="text-slate-400 border-b border-slate-700">
                            <th className="text-left font-medium py-0.5">Fdr</th>
                            <th className="text-right font-medium">kcmil</th>
                            <th className="text-right font-medium">LF</th>
                            <th className="text-right font-medium" title="BOL/EOL current vs total EOL capacity (parallel sets × mutual-heating-derated rating) — the basis that sized the conductor">A BOL/EOL / cap</th>
                            <th className="text-right font-medium">VD %</th>
                            <th className="text-right font-medium">MWh/yr</th>
                          </tr>
                        </thead>
                        <tbody>
                          {electricalReport.rows.map(r => (
                            <tr key={r.idx} className={r.overLimit ? 'text-red-400' : 'text-slate-200'}>
                              <td className="py-0.5">#{r.name ?? `F${r.idx}`}</td>
                              <td className="text-right">{r.size} {r.material}</td>
                              <td className="text-right">{Math.ceil(r.lengthFt).toLocaleString()}</td>
                              <td className={`text-right ${r.overAmpacity ? 'text-red-400 font-semibold' : ''}`}>{r.amps.toFixed(0)}/{r.eolAmps.toFixed(0)} / {r.eolCapacityAmps.toFixed(0)}{r.overAmpacity ? ' ⚠' : ''}</td>
                              <td className={`text-right ${r.overLimit ? 'font-semibold' : ''}`}>{r.vdPct.toFixed(2)}{r.overLimit ? ' ⚠' : ''}</td>
                              <td className="text-right">{r.annualLossMWh.toFixed(1)}</td>
                            </tr>
                          ))}
                        </tbody>
                        <tfoot>
                          <tr className="text-slate-300 border-t border-slate-700 font-semibold">
                            <td className="py-0.5" colSpan={4}>Total ({electricalReport.totalPeakLossKW.toFixed(1)} kW peak)</td>
                            <td className="text-right" colSpan={2}>{electricalReport.totalAnnualLossMWh.toFixed(1)} MWh/yr</td>
                          </tr>
                        </tfoot>
                      </table>
                      <div className="text-slate-500">
                        Screening-grade: NEC Ch.9 Table 8 DC resistance, loss factor {electricalReport.lossFactorUsed.toFixed(3)} from {electricalReport.capacityFactorPct}% capacity factor. Verify in detailed design.
                      </div>
                    </div>
                  )}
                  <label className="flex items-center gap-2 text-sm cursor-pointer" title="Run a simplified per-bus short-circuit study over the routed collection network: utility Thevenin source through the actual cable impedances, PCS units as fixed current sources (k × rated). Bolted 3-phase duty at the main bus, each FJB, each PCS terminal and the 480V aux bus. When enabled, the study is added to the POI data sheet PDF as its own section.">
                    <input
                      type="checkbox"
                      checked={scEnabled}
                      onChange={e => setScEnabled(e.target.checked)}
                    />
                    <span>Short-circuit study (per-bus)</span>
                  </label>
                  {scEnabled && (
                    <div className="bg-slate-800 rounded p-2.5 text-[11px] leading-relaxed">
                      <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400 mb-1.5">
                        Short-Circuit Study Inputs
                      </div>
                      <div className="grid grid-cols-2 gap-x-2 gap-y-1.5">
                        <StudyNumField label="Utility fault (MVA)" unit="MVA" title="Available 3-phase fault MVA at the 34.5 kV POI, from the utility's system study."
                          step={100} min={SC_NUM_LIMITS.utilityFaultMVA.min} max={SC_NUM_LIMITS.utilityFaultMVA.max}
                          value={scInputs.utilityFaultMVA}
                          onCommit={v => { if (v !== null) setScInputs({ utilityFaultMVA: v }); }} />
                        <StudyNumField label="Utility X/R" title="System X/R ratio at the POI — sets the source R/X split and the asymmetrical peak factor."
                          step={1} min={SC_NUM_LIMITS.utilityXOverR.min} max={SC_NUM_LIMITS.utilityXOverR.max}
                          value={scInputs.utilityXOverR}
                          onCommit={v => { if (v !== null) setScInputs({ utilityXOverR: v }); }} />
                        <StudyNumField label="PCS k (pu)" unit="pu" title="PCS fault contribution in per-unit of rated current (IEEE 2800-typical current-limited behavior). 1.2 is the common screening value."
                          step={0.1} min={SC_NUM_LIMITS.inverterK.min} max={SC_NUM_LIMITS.inverterK.max}
                          value={scInputs.inverterK}
                          onCommit={v => { if (v !== null) setScInputs({ inverterK: v }); }} />
                        <StudyNumField label="Gear rating (kA)" unit="kA" title="Optional MV switchgear interrupting rating (kA sym). When set, every MV bus shows its margin against this rating. Leave blank to skip."
                          step={1} min={SC_RATING_LIMITS.min} max={SC_RATING_LIMITS.max}
                          value={scInputs.equipmentRatingKA} nullable placeholder="—"
                          onCommit={v => setScInputs({ equipmentRatingKA: v })} />
                        <StudyNumField label="Aux xfmr (kVA)" unit="kVA" title="Aux transformer base kVA (2000 kVA matches the 2000 A / 480 V aux switchboard)."
                          step={250} min={SC_NUM_LIMITS.auxKVA.min} max={SC_NUM_LIMITS.auxKVA.max}
                          value={scInputs.auxKVA}
                          onCommit={v => { if (v !== null) setScInputs({ auxKVA: v }); }} />
                        <StudyNumField label="Aux %Z" unit="%" title="Aux transformer nameplate impedance (%Z on its own base). 5.75% is typical for pad-mounts."
                          step={0.25} min={SC_NUM_LIMITS.auxPctZ.min} max={SC_NUM_LIMITS.auxPctZ.max}
                          value={scInputs.auxPctZ}
                          onCommit={v => { if (v !== null) setScInputs({ auxPctZ: v }); }} />
                        <StudyNumField label="Aux X/R" title="Aux transformer X/R ratio — splits its impedance into R and X for the 480V bus X/R and peak factor. ~5 is typical at this size."
                          step={0.5} min={SC_NUM_LIMITS.auxXOverR.min} max={SC_NUM_LIMITS.auxXOverR.max}
                          value={scInputs.auxXOverR}
                          onCommit={v => { if (v !== null) setScInputs({ auxXOverR: v }); }} />
                      </div>
                    </div>
                  )}
                  {scEnabled && scStudy && (
                    <div className="rounded p-2 text-xs space-y-1.5 border bg-slate-800 border-slate-700" title="Bolted 3-phase symmetrical fault duty per bus: utility contribution through the routed cable impedance + all PCS current sources. Peak = IEC κ·√2·Isym from the utility-path X/R. Added to the POI data sheet PDF while enabled.">
                      <div className="flex items-center justify-between">
                        <div className="font-semibold text-slate-200">Short-Circuit Duty (per bus)</div>
                        {scStudy.inputs.equipmentRatingKA !== null && (
                          <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${scStudy.overRatedCount === 0 ? 'bg-emerald-700 text-emerald-100' : 'bg-red-800 text-red-100'}`}>
                            {scStudy.overRatedCount === 0 ? 'WITHIN RATING' : `${scStudy.overRatedCount} OVER`}
                          </span>
                        )}
                      </div>
                      <table className="w-full text-[11px]">
                        <thead>
                          <tr className="text-slate-400 border-b border-slate-700">
                            <th className="text-left font-medium py-0.5">Bus</th>
                            <th className="text-right font-medium">kA sym</th>
                            <th className="text-right font-medium">kA peak</th>
                            <th className="text-right font-medium">X/R</th>
                            {scStudy.inputs.equipmentRatingKA !== null && <th className="text-right font-medium">Margin</th>}
                          </tr>
                        </thead>
                        <tbody>
                          {scStudy.buses.map(b => (
                            <tr key={b.id} className={b.marginPct !== null && b.marginPct < 0 ? 'text-red-400' : 'text-slate-200'}>
                              <td className="py-0.5">{b.label}</td>
                              <td className="text-right font-mono">{b.symKA.toFixed(1)}</td>
                              <td className="text-right font-mono">{b.peakKA.toFixed(1)}</td>
                              <td className="text-right font-mono">{Number.isFinite(b.xOverR) ? b.xOverR.toFixed(1) : '—'}</td>
                              {scStudy.inputs.equipmentRatingKA !== null && (
                                <td className={`text-right font-mono ${b.marginPct !== null && b.marginPct < 0 ? 'font-semibold' : ''}`}>
                                  {b.marginPct === null ? '—' : `${b.marginPct >= 0 ? '+' : ''}${b.marginPct.toFixed(0)}%`}
                                </td>
                              )}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      <div className="text-slate-500">
                        Simplified: PCS as fixed current sources (k × rated), no machine decay. Included in the POI data sheet PDF while enabled.
                      </div>
                    </div>
                  )}
                  <label className={`flex items-center gap-2 text-sm ${scEnabled ? 'cursor-pointer' : 'opacity-50 cursor-not-allowed'}`} title="Protection screening built on the short-circuit study: interrupting-duty check against standard breaker rating ladders, feeder/main relay coordination (IEEE very-inverse curves), and arc-flash incident energy (IEEE 1584-2002 at the 480V aux bus, conservative Lee method at the MV buses). Requires the short-circuit study. Added to the POI data sheet PDF while enabled.">
                    <input
                      type="checkbox"
                      checked={protectionEnabled}
                      disabled={!scEnabled}
                      onChange={e => setProtectionEnabled(e.target.checked)}
                    />
                    <span>Protection & arc-flash study</span>
                  </label>
                  {scEnabled && protectionEnabled && (
                    <div className="bg-slate-800 rounded p-2.5 text-[11px] leading-relaxed">
                      <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400 mb-1.5">
                        Protection Study Inputs
                      </div>
                      <div className="grid grid-cols-2 gap-x-2 gap-y-1.5">
                        <StudyNumField label="Duty margin (%)" unit="%" title="Required headroom above the calculated fault duty when picking a device from the standard rating ladder. 20% is common practice."
                          step={5} min={PROTECTION_NUM_LIMITS.dutyMarginPct.min} max={PROTECTION_NUM_LIMITS.dutyMarginPct.max}
                          value={protectionInputs.dutyMarginPct}
                          onCommit={v => { if (v !== null) setProtectionInputs({ dutyMarginPct: v }); }} />
                        <StudyNumField label="Required CTI (s)" unit="s" title="Required coordination time interval between the feeder and main relay operating times at the feeder-bus maximum fault. 0.3 s is the classic relay-to-relay CTI."
                          step={0.05} min={PROTECTION_NUM_LIMITS.ctiRequiredS.min} max={PROTECTION_NUM_LIMITS.ctiRequiredS.max}
                          value={protectionInputs.ctiRequiredS}
                          onCommit={v => { if (v !== null) setProtectionInputs({ ctiRequiredS: v }); }} />
                        <StudyNumField label="Feeder pickup (pu)" unit="pu" title="Feeder relay pickup as a multiple of the feeder full-load amps. 1.25 pu is a common margin above load."
                          step={0.05} min={PROTECTION_NUM_LIMITS.feederPickupPu.min} max={PROTECTION_NUM_LIMITS.feederPickupPu.max}
                          value={protectionInputs.feederPickupPu}
                          onCommit={v => { if (v !== null) setProtectionInputs({ feederPickupPu: v }); }} />
                        <StudyNumField label="Main pickup (pu)" unit="pu" title="Main relay pickup as a multiple of the aggregate full-load amps."
                          step={0.05} min={PROTECTION_NUM_LIMITS.mainPickupPu.min} max={PROTECTION_NUM_LIMITS.mainPickupPu.max}
                          value={protectionInputs.mainPickupPu}
                          onCommit={v => { if (v !== null) setProtectionInputs({ mainPickupPu: v }); }} />
                        <StudyNumField label="Feeder time dial" title="Feeder relay time dial on the IEEE C37.112 very-inverse curve."
                          step={0.5} min={PROTECTION_NUM_LIMITS.feederTimeDial.min} max={PROTECTION_NUM_LIMITS.feederTimeDial.max}
                          value={protectionInputs.feederTimeDial}
                          onCommit={v => { if (v !== null) setProtectionInputs({ feederTimeDial: v }); }} />
                        <StudyNumField label="Main time dial" title="Main relay time dial on the IEEE C37.112 very-inverse curve — set above the feeder dial to coordinate."
                          step={0.5} min={PROTECTION_NUM_LIMITS.mainTimeDial.min} max={PROTECTION_NUM_LIMITS.mainTimeDial.max}
                          value={protectionInputs.mainTimeDial}
                          onCommit={v => { if (v !== null) setProtectionInputs({ mainTimeDial: v }); }} />
                        <StudyNumField label="MV work dist (in)" unit="in" title="Arc-flash working distance at the MV switchgear (36 in is the standard 15–36 kV class distance)."
                          step={6} min={PROTECTION_NUM_LIMITS.mvWorkingDistIn.min} max={PROTECTION_NUM_LIMITS.mvWorkingDistIn.max}
                          value={protectionInputs.mvWorkingDistIn}
                          onCommit={v => { if (v !== null) setProtectionInputs({ mvWorkingDistIn: v }); }} />
                        <StudyNumField label="LV work dist (in)" unit="in" title="Arc-flash working distance at the 480V aux switchgear (18 in is the standard LV distance)."
                          step={6} min={PROTECTION_NUM_LIMITS.lvWorkingDistIn.min} max={PROTECTION_NUM_LIMITS.lvWorkingDistIn.max}
                          value={protectionInputs.lvWorkingDistIn}
                          onCommit={v => { if (v !== null) setProtectionInputs({ lvWorkingDistIn: v }); }} />
                      </div>
                    </div>
                  )}
                  {scEnabled && protectionEnabled && protectionStudy && (
                    <div className="rounded p-2 text-xs space-y-1.5 border bg-slate-800 border-slate-700" title="Interrupting-duty recommendations, feeder/main coordination screening and arc-flash incident energy — all derived from the per-bus short-circuit study. Added to the POI data sheet PDF while enabled.">
                      <div className="flex items-center justify-between">
                        <div className="font-semibold text-slate-200">Protection & Arc Flash</div>
                        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${protectionStudy.inadequateDutyCount === 0 && protectionStudy.uncoordinatedCount === 0 ? 'bg-emerald-700 text-emerald-100' : 'bg-amber-700 text-amber-100'}`}>
                          {protectionStudy.inadequateDutyCount === 0 && protectionStudy.uncoordinatedCount === 0
                            ? 'SCREEN PASS'
                            : `${protectionStudy.inadequateDutyCount + protectionStudy.uncoordinatedCount} REVIEW`}
                        </span>
                      </div>
                      <table className="w-full text-[11px]">
                        <thead>
                          <tr className="text-slate-400 border-b border-slate-700">
                            <th className="text-left font-medium py-0.5">Bus</th>
                            <th className="text-right font-medium">Duty kA</th>
                            <th className="text-right font-medium">Device kA</th>
                          </tr>
                        </thead>
                        <tbody>
                          {protectionStudy.duty.filter(r => r.kind !== 'pcs').map(r => (
                            <tr key={r.busId} className={r.adequate ? 'text-slate-200' : 'text-red-400'}>
                              <td className="py-0.5">{r.busLabel}</td>
                              <td className="text-right font-mono">{r.symKA.toFixed(1)}</td>
                              <td className="text-right font-mono">{r.recommendedKA !== null ? r.recommendedKA : 'NONE'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      <table className="w-full text-[11px]">
                        <thead>
                          <tr className="text-slate-400 border-b border-slate-700">
                            <th className="text-left font-medium py-0.5">Pair</th>
                            <th className="text-right font-medium">CTI s</th>
                            <th className="text-right font-medium">Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {protectionStudy.coordination.map(c => (
                            <tr key={c.feederIdx} className={c.coordinated ? 'text-slate-200' : 'text-amber-400'}>
                              <td className="py-0.5">{c.feederName ? `#${c.feederName}` : `F${c.feederIdx}`} / main</td>
                              <td className="text-right font-mono">{Number.isFinite(c.ctiS) ? c.ctiS.toFixed(2) : '—'}</td>
                              <td className="text-right font-mono">{c.coordinated ? 'OK' : 'REVIEW'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      <table className="w-full text-[11px]">
                        <thead>
                          <tr className="text-slate-400 border-b border-slate-700">
                            <th className="text-left font-medium py-0.5">Arc Flash</th>
                            <th className="text-right font-medium">cal/cm²</th>
                            <th className="text-right font-medium">PPE</th>
                          </tr>
                        </thead>
                        <tbody>
                          {protectionStudy.arcFlash.map(r => (
                            <tr key={r.busId} className={r.ppeCategory >= 5 ? 'text-red-400' : 'text-slate-200'}>
                              <td className="py-0.5">{r.busLabel}</td>
                              <td className="text-right font-mono">{r.incidentCalCm2.toFixed(1)}</td>
                              <td className="text-right font-mono">{r.ppeCategory >= 5 ? 'DANGER' : `CAT ${r.ppeCategory}`}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      <div className="text-slate-500">
                        Screening: generic IEEE very-inverse curves, IEEE 1584-2002 (LV) / Lee (MV) arc flash. Included in the POI data sheet PDF while enabled.
                      </div>
                    </div>
                  )}
                  <label className="flex items-center gap-2 text-sm cursor-pointer" title="Simulate plant energy performance over the project life: IEC 62933-2-1 round-trip efficiency at the AC point of connection (including auxiliaries and the routed feeders' cable losses), NREL semi-empirical calendar + cycle degradation, and augmentation planning against the reserved augmentation zones. Inputs are saved in the project file. Screening grade; exports a standalone PDF report only.">
                    <input
                      type="checkbox"
                      checked={energySimEnabled}
                      onChange={e => setEnergySimEnabled(e.target.checked)}
                    />
                    <span>Energy & dispatch simulation</span>
                  </label>
                  {energySimEnabled && (
                    <div className="bg-slate-800 rounded p-2.5 text-[11px] leading-relaxed">
                      <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400 mb-1.5">
                        Energy Simulation Inputs
                      </div>
                      <div className="grid grid-cols-2 gap-x-2 gap-y-1.5">
                        <StudyNumField label="Cycles per day" title="Standard full cycles per day (IEC 62933-2-1 dispatch framing). 1.0 = one full charge/discharge per day."
                          step={0.1} min={ENERGY_SIM_NUM_LIMITS.cyclesPerDay.min} max={ENERGY_SIM_NUM_LIMITS.cyclesPerDay.max}
                          value={energySimInputs.cyclesPerDay}
                          onCommit={v => { if (v !== null) setEnergySimInputs({ cyclesPerDay: v }); }} />
                        <StudyNumField label="DOD (%)" unit="%" title="Depth of discharge per cycle (% of usable energy). Deeper cycling accelerates cycle fade via a √DOD stress factor."
                          step={5} min={ENERGY_SIM_NUM_LIMITS.dodPct.min} max={ENERGY_SIM_NUM_LIMITS.dodPct.max}
                          value={energySimInputs.dodPct}
                          onCommit={v => { if (v !== null) setEnergySimInputs({ dodPct: v }); }} />
                        <StudyNumField label="Avg ambient (°C)" unit="°C" title="Site annual-average ambient temperature. Cell temperature is assumed 5 °C above ambient; calendar fade roughly doubles per +12 °C (Arrhenius)."
                          step={1} min={ENERGY_SIM_NUM_LIMITS.avgAmbientC.min} max={ENERGY_SIM_NUM_LIMITS.avgAmbientC.max}
                          value={energySimInputs.avgAmbientC}
                          onCommit={v => { if (v !== null) setEnergySimInputs({ avgAmbientC: v }); }} />
                        <StudyNumField label="Project life (yr)" unit="yr" title="Simulation horizon in operating years (whole years — decimals round to the nearest year)."
                          integer step={1} min={ENERGY_SIM_NUM_LIMITS.projectLifeYears.min} max={ENERGY_SIM_NUM_LIMITS.projectLifeYears.max}
                          value={energySimInputs.projectLifeYears}
                          onCommit={v => { if (v !== null) setEnergySimInputs({ projectLifeYears: v }); }} />
                        <StudyNumField label="Contract MWh" unit="MWh" title="Contracted usable energy the plant must maintain. When usable capacity would fall below this, whole containers are added at the start of that year (augmentation). 0 disables augmentation planning."
                          step={10} min={ENERGY_SIM_NUM_LIMITS.contractMWh.min} max={ENERGY_SIM_NUM_LIMITS.contractMWh.max}
                          value={energySimInputs.contractMWh}
                          onCommit={v => { if (v !== null) setEnergySimInputs({ contractMWh: v }); }} />
                        <StudyNumField label="Aux kW/container" unit="kW" title="Average auxiliary (HVAC + controls) load per container. 3.5 kW is a warranty-class annual average for LFP containers in a moderate climate."
                          step={0.5} min={ENERGY_SIM_NUM_LIMITS.auxKwPerContainer.min} max={ENERGY_SIM_NUM_LIMITS.auxKwPerContainer.max}
                          value={energySimInputs.auxKwPerContainer}
                          onCommit={v => { if (v !== null) setEnergySimInputs({ auxKwPerContainer: v }); }} />
                        <StudyNumField label="Battery DC RTE (%)" unit="%" title="RTE override: battery DC-DC round-trip efficiency (%). 94% is a typical warranty-class LFP value; override from the OEM datasheet."
                          step={0.5} min={roundToDecimals(ENERGY_SIM_NUM_LIMITS.batteryRteDc.min * 100, 1)} max={roundToDecimals(ENERGY_SIM_NUM_LIMITS.batteryRteDc.max * 100, 1)}
                          displayDecimals={1}
                          value={Math.round(energySimInputs.batteryRteDc * 1000) / 10}
                          onCommit={v => { if (v !== null) setEnergySimInputs({ batteryRteDc: v / 100 }); }} />
                        <StudyNumField label="PCS one-way eff (%)" unit="%" title="RTE override: PCS one-way (per-direction) efficiency (%). 98.5% is a typical CEC-weighted value for utility-scale inverters."
                          step={0.1} min={roundToDecimals(ENERGY_SIM_NUM_LIMITS.pcsEff.min * 100, 1)} max={roundToDecimals(ENERGY_SIM_NUM_LIMITS.pcsEff.max * 100, 1)}
                          displayDecimals={1}
                          value={Math.round(energySimInputs.pcsEff * 1000) / 10}
                          onCommit={v => { if (v !== null) setEnergySimInputs({ pcsEff: v / 100 }); }} />
                      </div>
                    </div>
                  )}
                  {energySimEnabled && energySim && (
                    <div className="rounded p-2 text-xs space-y-1.5 border bg-slate-800 border-slate-700" title="IEC 62933-2-1 AC point-of-connection round-trip efficiency (including auxiliaries), NREL semi-empirical degradation and container-granular augmentation planning against the reserved augmentation zones. Screening grade.">
                      <div className="flex items-center justify-between">
                        <div className="font-semibold text-slate-200">Energy Simulation</div>
                        {energySim.totalAddedContainers > 0 && (
                          <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${energySim.zonesSufficient ? 'bg-emerald-700 text-emerald-100' : 'bg-red-800 text-red-100'}`}>
                            {energySim.zonesSufficient ? 'AUG ZONES OK' : 'AUG ZONES SHORT'}
                          </span>
                        )}
                      </div>
                      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-slate-300">
                        <span>System RTE @ AC PoC (incl. aux)</span>
                        <span className="text-right font-mono">{energySim.rte.acRtePct.toFixed(1)}%</span>
                        <span>AC RTE excl. aux</span>
                        <span className="text-right font-mono">{energySim.rte.acRteExAuxPct.toFixed(1)}%</span>
                        <span>Aux consumption</span>
                        <span className="text-right font-mono">{energySim.rte.dailyAuxMWh.toFixed(2)} MWh/day</span>
                        <span>Year-1 discharge</span>
                        <span className="text-right font-mono">{Math.round(energySim.annualThroughputBolMWh).toLocaleString()} MWh</span>
                        <span>End-of-life usable (yr {energySimInputs.projectLifeYears})</span>
                        <span className="text-right font-mono">{Math.round(energySim.endOfLifeUsableMWh).toLocaleString()} MWh</span>
                        {energySimInputs.contractMWh > 0 && (
                          <>
                            <span>Augmentation needed</span>
                            <span className="text-right font-mono">
                              {energySim.totalAddedContainers > 0
                                ? `${energySim.totalAddedContainers} cont. / ${energySim.totalAddedMWh.toFixed(0)} MWh`
                                : 'none'}
                            </span>
                            {energySim.totalAddedContainers > 0 && (
                              <>
                                <span>First augmentation year</span>
                                <span className="text-right font-mono">{energySim.augmentation[0].year}</span>
                                <span>Reserved zone capacity</span>
                                <span className={`text-right font-mono ${energySim.zonesSufficient ? '' : 'text-red-400'}`}>
                                  {energySim.zoneCapacityContainers} containers {energySim.zonesSufficient ? '✓' : '✗'}
                                </span>
                              </>
                            )}
                          </>
                        )}
                      </div>
                      {!energySim.zonesSufficient && (
                        <div className="text-[10px] text-amber-400">
                          Reserved augmentation zones cannot hold the planned containers — increase the future augmentation % above and regenerate.
                        </div>
                      )}
                      <CapacityCurvePreview result={energySim} />
                      <button
                        onClick={async () => {
                          try {
                            const cfg = getEffectiveConfiguration(configId, containersPerPcs);
                            const doc = buildEnergySimPdf(energySim, energySimInputs, {
                              titleBlock,
                              configLabel: cfg.label,
                              achievedMW: design?.achievedMW ?? 0,
                              achievedMWh: design?.achievedMWh ?? 0,
                              containers: (design?.blocksPlaced ?? 0) * cfg.containersPerBlock,
                            });
                            const exportName = (titleBlock.projectName || 'BESSForge').replace(/[^A-Za-z0-9_-]+/g, '_');
                            const saved = await saveBlob(finalizePdfBlob(doc), `${exportName}_Energy_Simulation_${new Date().toISOString().slice(0, 10)}.pdf`);
                            if (saved) toast.success('Energy simulation report PDF exported');
                          } catch (err) {
                            toast.error(`Energy report failed: ${err instanceof Error ? err.message : String(err)}`);
                          }
                        }}
                        className="w-full mt-1 py-1.5 rounded bg-slate-700 hover:bg-slate-600 text-xs font-semibold text-slate-100"
                        title="Export a one-page PDF report: RTE loss chain, year-by-year degradation and augmentation table, zone-capacity check and model citations. Standalone file — never part of the default DXF/PDF exports."
                      >
                        Export energy report (PDF)
                      </button>
                      <div className="text-slate-500">
                        Screening grade — IEC 62933-2-1 RTE framing, NREL semi-empirical degradation. Verify against OEM warranty and offtake agreement.
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </PanelSection>

        {/* Step 6: Edit layout */}
        {design && (
          <PanelSection id="edit" title="6. Edit Layout" discipline="Layout">
            <div className="space-y-2 text-xs text-slate-400">
              {/* Row/block move controls need auto rows; an empty area (manual
                  placement only) still gets the placement + placed-island tools. */}
              {design.blockRows.length > 0 && (<>
              <label className="block">
                Block row (south to north)
                <select
                  value={editRow}
                  onChange={e => {
                    const idx = Number(e.target.value);
                    setEditRow(idx);
                    const mv = layoutEdits.rowMoves?.[idx];
                    setEditDx(String(mv?.dx ?? 0));
                    setEditDy(String(mv?.dy ?? 0));
                  }}
                  className="w-full mt-1 bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-sm text-slate-100"
                >
                  {design.blockRows.map(r => (
                    <option key={r.index} value={r.index}>
                      Row {r.index} — {r.blockCount} block{r.blockCount === 1 ? '' : 's'} @ y {r.y.toFixed(0)} ft{r.moved ? ' (moved)' : ''}
                    </option>
                  ))}
                </select>
              </label>
              <div className="grid grid-cols-2 gap-2">
                <label className="block">
                  Offset X (ft, east +)
                  <input
                    type="number"
                    step={5}
                    value={editDx}
                    onChange={e => setEditDx(e.target.value)}
                    className="w-full mt-1 bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-sm text-slate-100"
                  />
                </label>
                <label className="block">
                  Offset Y (ft, north +)
                  <input
                    type="number"
                    step={5}
                    value={editDy}
                    onChange={e => setEditDy(e.target.value)}
                    className="w-full mt-1 bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-sm text-slate-100"
                  />
                </label>
              </div>
              <button
                onClick={handleApplyRowMove}
                className="w-full py-1.5 rounded bg-slate-700 hover:bg-slate-600 text-xs font-semibold text-slate-100"
              >
                Apply row move &amp; re-optimize site
              </button>

              <label className="block pt-2 border-t border-slate-700/60">
                480V aux &amp; fiber trench corridor X (ft)
                <input
                  type="number"
                  step={5}
                  value={trenchInput}
                  onChange={e => setTrenchInput(e.target.value)}
                  placeholder={
                    layoutEdits.trenchX != null
                      ? `pinned @ ${layoutEdits.trenchX}`
                      : design.trench
                        ? `auto @ ${design.trench.x.toFixed(0)}`
                        : 'auto'
                  }
                  className="w-full mt-1 bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-sm text-slate-100 placeholder:text-slate-500"
                />
              </label>
              <button
                onClick={handleApplyTrenchPin}
                className="w-full py-1.5 rounded bg-slate-700 hover:bg-slate-600 text-xs font-semibold text-slate-100"
              >
                {trenchInput.trim() === '' ? 'Set trench to automatic' : 'Pin trench & reroute cables'}
              </button>

              {(layoutEdits.laydownPin != null || layoutEdits.laydownSize != null) && (
                <div className="pt-2 border-t border-slate-700/60 space-y-1.5">
                  <div>
                    {layoutEdits.laydownPin != null && (
                      <>Laydown area pinned @ ({layoutEdits.laydownPin.x.toFixed(0)}, {layoutEdits.laydownPin.y.toFixed(0)}) ft</>
                    )}
                    {layoutEdits.laydownSize != null && (
                      <>{layoutEdits.laydownPin != null ? ', ' : 'Laydown area '}sized {layoutEdits.laydownSize.length.toFixed(0)} x {layoutEdits.laydownSize.width.toFixed(0)} ft</>
                    )}
                    <span className="text-slate-500"> — drag the rectangle to move it, drag a corner handle to resize</span>
                  </div>
                  <button
                    onClick={() => {
                      setLaydownPin(null);
                      toast.success('Laydown area set back to automatic placement');
                    }}
                    className="w-full py-1.5 rounded bg-slate-700 hover:bg-slate-600 text-xs font-semibold text-slate-100"
                  >
                    Reset laydown area to auto
                  </button>
                </div>
              )}

              <div className="pt-2 border-t border-slate-700/60 space-y-1.5">
                <div className="font-semibold text-slate-300">Per-block DC run routing</div>
                <div className="grid grid-cols-2 gap-2">
                  <label className="block">
                    Block
                    <select
                      value={dcBlockN}
                      onChange={e => setDcBlockN(Number(e.target.value))}
                      className="w-full mt-1 bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-sm text-slate-100"
                    >
                      {design.blockRows.flatMap(r => r.blocks).map(b => (
                        <option key={b.n} value={b.n}>
                          Block {b.n}{layoutEdits.dcRoutingOverrides?.[b.n] ? ` — ${layoutEdits.dcRoutingOverrides[b.n] === 'direct' ? 'direct' : '90°'}` : ''}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="block">
                    DC routing
                    <select
                      value={layoutEdits.dcRoutingOverrides?.[dcBlockN] ?? 'default'}
                      onChange={e => {
                        const v = e.target.value;
                        setBlockDcRouting(dcBlockN, v === 'default' ? null : (v as 'orthogonal' | 'direct'));
                        toast.success(v === 'default'
                          ? `Block ${dcBlockN} DC runs follow the design default again`
                          : `Block ${dcBlockN} DC runs set to ${v === 'direct' ? 'direct straight-line' : '90° trench'} routing`);
                      }}
                      className="w-full mt-1 bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-sm text-slate-100"
                    >
                      <option value="default">Design default ({dcRouting === 'direct' ? 'direct' : '90°'})</option>
                      <option value="orthogonal">90° trench legs</option>
                      <option value="direct">Direct — straight-line</option>
                    </select>
                  </label>
                </div>
                {Object.keys(layoutEdits.dcRoutingOverrides ?? {}).length > 0 && (
                  <div className="space-y-1.5">
                    {Object.entries(layoutEdits.dcRoutingOverrides ?? {}).map(([n, m]) => (
                      <div key={`dcr-${n}`} className="flex items-center justify-between gap-2">
                        <span>Block {n} DC runs: {m === 'direct' ? 'direct straight-line' : '90° trench'}</span>
                        <button
                          onClick={() => {
                            setBlockDcRouting(Number(n), null);
                            toast.success(`Block ${n} DC runs follow the design default again`);
                          }}
                          className="shrink-0 px-2 py-1 rounded bg-slate-700 hover:bg-slate-600 text-xs font-semibold text-slate-100"
                        >
                          Reset
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {Object.keys(layoutEdits.blockMoves ?? {}).length > 0 && (
                <div className="pt-2 border-t border-slate-700/60 space-y-1.5">
                  {Object.entries(layoutEdits.blockMoves ?? {}).map(([n, mv]) => (
                    <div key={`blk-${n}`} className="flex items-center justify-between gap-2">
                      <span>Block {n} moved ({mv.dx >= 0 ? '+' : ''}{mv.dx.toFixed(0)}, {mv.dy >= 0 ? '+' : ''}{mv.dy.toFixed(0)}) ft</span>
                      <button
                        onClick={() => {
                          moveBlock(Number(n), 0, 0);
                          toast.success(`Block ${n} restored to its automatic position`);
                        }}
                        className="shrink-0 px-2 py-1 rounded bg-slate-700 hover:bg-slate-600 text-xs font-semibold text-slate-100"
                      >
                        Reset
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {Object.keys(layoutEdits.equipMoves ?? {}).length > 0 && (
                <div className="pt-2 border-t border-slate-700/60 space-y-1.5">
                  {Object.entries(layoutEdits.equipMoves ?? {}).map(([id, mv]) => (
                    <div key={`eq-${id}`} className="flex items-center justify-between gap-2">
                      <span>
                        {design?.equipment.find(e => e.id === id)?.label ?? id} moved ({mv.dx >= 0 ? '+' : ''}{mv.dx.toFixed(0)}, {mv.dy >= 0 ? '+' : ''}{mv.dy.toFixed(0)}) ft
                      </span>
                      <button
                        onClick={() => {
                          moveEquipment(id, 0, 0);
                          toast.success('Equipment restored to its automatic position');
                        }}
                        className="shrink-0 px-2 py-1 rounded bg-slate-700 hover:bg-slate-600 text-xs font-semibold text-slate-100"
                      >
                        Reset
                      </button>
                    </div>
                  ))}
                </div>
              )}
              </>)}

              {/* Placed islands: explicit rotate / delete / nudge controls, so
                  the actions exist in the panel as well as on the plan (and
                  stay reachable when the scene selection is fiddly). */}
              {(layoutEdits.placedIslands ?? []).length > 0 && (
                <div className="pt-2 border-t border-slate-700/60 space-y-1.5">
                  {(layoutEdits.placedIslands ?? []).map(p => {
                    const single = p.kind === 'single' || p.kind === 'single2';
                    const singleBess = p.kind === 'single2' ? 2 : 3;
                    const pairs = p.pairs ?? ISLAND_PCS_PER_SIDE;
                    const augTxt = p.aug === false ? 'no augmentation' : 'with augmentation';
                    const nudge = (dx: number, dy: number) => {
                      const reason = useDesignStore.getState().movePlacedIsland(p.id, dx, dy);
                      if (reason) toast.error(`Move rejected: ${reason}`);
                      else {
                        const warn = useDesignStore.getState().lastPlacedWarning;
                        if (warn) toast.warning(`Island moved with warning: ${warn}`);
                        else toast.success('Island moved — roads, feeders and trenching regenerated');
                      }
                    };
                    return (
                      <div key={`pisl-${p.id}`} className="space-y-1">
                        <div className="flex items-center justify-between gap-2">
                          <span>
                            {single
                              ? `Placed single PCS module ${p.id.replace(/^pisl-/, '')} — 1 PCS + ${singleBess} BESS`
                              : `Placed island ${p.id.replace(/^pisl-/, '')} — ${pairs} pairs (${pairs * 2} blocks)`}
                            , {augTxt}, {single ? 'core equipment only'
                              : p.auxGear === false ? 'core equipment only' : 'with aux cluster'}
                            , {p.vertical ? 'vertical' : 'horizontal'} at ({p.x.toFixed(0)}, {p.y.toFixed(0)}) ft
                          </span>
                          <div className="shrink-0 flex gap-1">
                            <button
                              onClick={() => {
                                const reason = useDesignStore.getState().rotatePlacedIsland(p.id);
                                if (reason) toast.error(`Rotate rejected: ${reason}`);
                                else {
                                  const warn = useDesignStore.getState().lastPlacedWarning;
                                  if (warn) toast.warning(`Island rotated 90° with warning: ${warn}`);
                                  else toast.success('Island rotated 90° — roads, feeders and trenching regenerated');
                                }
                              }}
                              title="Rotate this island 90° about its own center (horizontal ⟷ vertical)"
                              className="px-2 py-1 rounded bg-sky-700 hover:bg-sky-600 text-xs font-semibold text-white"
                            >
                              Rotate 90°
                            </button>
                            <button
                              onClick={() => {
                                useDesignStore.getState().removePlacedIsland(p.id);
                                toast.success('Placed island removed — site regenerated');
                              }}
                              className="px-2 py-1 rounded bg-red-700 hover:bg-red-600 text-xs font-semibold text-white"
                            >
                              Delete
                            </button>
                          </div>
                        </div>
                        <div className="flex items-center gap-1 text-[11px] text-slate-400">
                          <span className="mr-1">Move 10 ft:</span>
                          {([['N', 0, 10], ['S', 0, -10], ['E', 10, 0], ['W', -10, 0]] as const).map(([lbl, dx, dy]) => (
                            <button
                              key={lbl}
                              onClick={() => nudge(dx, dy)}
                              className="px-2 py-0.5 rounded bg-slate-700 hover:bg-slate-600 font-semibold text-slate-100"
                            >
                              {lbl}
                            </button>
                          ))}
                          <span className="ml-1">(or drag it on the plan)</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Individually placed auxiliary / comms / transformer /
                  fire-control items. Each one is its own placement, so it
                  turns, nudges and deletes on its own — an island no longer
                  has to bring a whole cluster along to get one. */}
              {(layoutEdits.placedEquipment ?? []).filter(isManualEquipmentSpec).length > 0 && (
                <div className="pt-2 border-t border-slate-700/60 space-y-1.5">
                  <p className="text-[10px] text-slate-500 uppercase tracking-wide">Individually placed equipment</p>
                  {(layoutEdits.placedEquipment ?? []).filter(isManualEquipmentSpec).map(pe => {
                    const cat = MANUAL_EQUIPMENT_CATALOG[pe.type];
                    const nudgeEq = (dx: number, dy: number) => {
                      const reason = useDesignStore.getState().updatePlacedEquipment(
                        pe.id, { x: pe.x + dx, y: pe.y + dy });
                      if (reason) toast.error(`Move rejected: ${reason}`);
                      else {
                        const warn = useDesignStore.getState().lastPlacedWarning;
                        if (warn) toast.warning(`${cat.short} moved with warning: ${warn}`);
                        else toast.success(`${cat.short} moved — routes, trenching and exports regenerated`);
                      }
                    };
                    return (
                      <div key={`peq-${pe.id}`} className="space-y-1">
                        <div className="flex items-center justify-between gap-2">
                          <span>
                            {cat.short} {pe.id.replace(/^peq-/, '')} — {cat.dims.length} × {cat.dims.width} ft
                            , {(pe.angleDeg ?? 0) % 180 === 90 ? 'vertical' : 'horizontal'} at ({pe.x.toFixed(0)}, {pe.y.toFixed(0)}) ft
                          </span>
                          <div className="shrink-0 flex gap-1">
                            <button
                              onClick={() => {
                                const reason = useDesignStore.getState().rotatePlacedEquipment(pe.id);
                                if (reason) toast.error(`Rotate rejected: ${reason}`);
                                else {
                                  const warn = useDesignStore.getState().lastPlacedWarning;
                                  if (warn) toast.warning(`${cat.short} rotated 90° with warning: ${warn}`);
                                  else toast.success(`${cat.short} rotated 90°`);
                                }
                              }}
                              title="Rotate this item 90° about its own center"
                              className="px-2 py-1 rounded bg-sky-700 hover:bg-sky-600 text-xs font-semibold text-white"
                            >
                              Rotate 90°
                            </button>
                            <button
                              onClick={() => {
                                useDesignStore.getState().removePlacedEquipment(pe.id);
                                toast.success(`${cat.short} removed — site regenerated`);
                              }}
                              className="px-2 py-1 rounded bg-red-700 hover:bg-red-600 text-xs font-semibold text-white"
                            >
                              Delete
                            </button>
                          </div>
                        </div>
                        <div className="flex items-center gap-1 text-[11px] text-slate-400">
                          <span className="mr-1">Move 10 ft:</span>
                          {([['N', 0, 10], ['S', 0, -10], ['E', 10, 0], ['W', -10, 0]] as const).map(([lbl, dx, dy]) => (
                            <button
                              key={lbl}
                              onClick={() => nudgeEq(dx, dy)}
                              className="px-2 py-0.5 rounded bg-slate-700 hover:bg-slate-600 font-semibold text-slate-100"
                            >
                              {lbl}
                            </button>
                          ))}
                          <span className="ml-1">(or drag it on the plan)</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Auto-generated aisle removal: list every named aisle so
                  drafters can remove them from the panel without entering
                  the 3D Edit Mode. Each removal is reversible (Restore
                  appears below once the road is suppressed). */}
              {(design?.aisles ?? []).filter(a => a.id && !(layoutEdits.removedRoads ?? []).includes(a.id!)).length > 0 && (
                <div className="pt-2 border-t border-slate-700/60 space-y-1.5">
                  <p className="text-[10px] text-slate-500 uppercase tracking-wide">Auto-generated roads</p>
                  {(design?.aisles ?? []).filter(a => a.id && !(layoutEdits.removedRoads ?? []).includes(a.id!)).map(a => (
                    <div key={`rm-panel-${a.id}`} className="flex items-center justify-between gap-2">
                      <span className="truncate">
                        {a.id!.startsWith('corridor-') ? 'Middle road' : 'Drive aisle'} {a.id!.replace(/^(aisle|corridor)-/, '')}
                      </span>
                      <button
                        onClick={() => {
                          const warn = useDesignStore.getState().removeGeneratedRoad(a.id!);
                          if (warn) {
                            toast.warning(`Road removed, but access is now broken: ${warn}`, { duration: 10000 });
                          } else {
                            toast.success('Road removed — road network, surfacing and exports rebuilt');
                          }
                        }}
                        className="shrink-0 px-2 py-1 rounded bg-red-800 hover:bg-red-700 text-xs font-semibold text-slate-100"
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {/* Removed generated roads: each suppression is listed with a
                  restore control, so a road deletion is an inspectable,
                  reversible edit rather than an invisible one. */}
              {(layoutEdits.removedRoads ?? []).length > 0 && (
                <div className="pt-2 border-t border-slate-700/60 space-y-1.5">
                  {(layoutEdits.removedRoads ?? []).map(id => (
                    <div key={`rmroad-${id}`} className="flex items-center justify-between gap-2">
                      <span>
                        {id.startsWith('corridor-') ? 'Middle road' : 'Drive aisle'} {id.replace(/^(aisle|corridor)-/, '')} removed
                      </span>
                      <button
                        onClick={() => {
                          useDesignStore.getState().restoreGeneratedRoad(id);
                          toast.success('Generated road restored — road network and exports rebuilt');
                        }}
                        className="shrink-0 px-2 py-1 rounded bg-slate-700 hover:bg-slate-600 text-xs font-semibold text-slate-100"
                      >
                        Restore
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {/* Deleted road areas/spans. A cut is a polygon subtracted from
                  the road region (partial spans, the perimeter ring, anything
                  hit-tested in the scene), so unlike removedRoads it has no
                  generated id to list — each is shown by its provenance label
                  with its own Restore, plus a Restore-all for a clean sweep. */}
              {(layoutEdits.roadCuts ?? []).length > 0 && (
                <div className="pt-2 border-t border-slate-700/60 space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-[10px] text-slate-500 uppercase tracking-wide">Deleted road areas</p>
                    <button
                      onClick={() => {
                        useDesignStore.getState().restoreAllRoadCuts();
                        toast.success('All deleted road areas restored — road network and exports rebuilt');
                      }}
                      className="shrink-0 px-2 py-1 rounded bg-slate-700 hover:bg-slate-600 text-[10px] font-semibold text-slate-100"
                    >
                      Restore all
                    </button>
                  </div>
                  {(layoutEdits.roadCuts ?? []).map((c, i) => (
                    <div key={`rcut-${c.id}`} className="flex items-center justify-between gap-2">
                      <span className="truncate">{c.label ?? `Road area ${i + 1}`} deleted</span>
                      <button
                        onClick={() => {
                          useDesignStore.getState().restoreRoadCut(c.id);
                          toast.success('Road restored — road network, surfacing and exports rebuilt');
                        }}
                        className="shrink-0 px-2 py-1 rounded bg-slate-700 hover:bg-slate-600 text-xs font-semibold text-slate-100"
                      >
                        Restore
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {(layoutEdits.customRoads ?? []).length > 0 && (
                <div className="pt-2 border-t border-slate-700/60 space-y-1.5">
                  {(layoutEdits.customRoads ?? []).map(r => {
                    let len = 0;
                    for (let i = 0; i + 1 < r.pts.length; i++) len += Math.hypot(r.pts[i + 1].x - r.pts[i].x, r.pts[i + 1].y - r.pts[i].y);
                    return (
                      <div key={r.id} className="flex items-center justify-between gap-2">
                        <span>Drawn access road — {len.toFixed(0)} ft, {r.pts.length} vertices</span>
                        <button
                          onClick={() => {
                            useDesignStore.getState().removeCustomRoad(r.id);
                            toast.success('Drawn road removed — road network rebuilt');
                          }}
                          className="shrink-0 px-2 py-1 rounded bg-slate-700 hover:bg-slate-600 text-xs font-semibold text-slate-100"
                        >
                          Remove
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Pave-as-drawn overrides: traced strips the gate-apron rule
                  keeps as reference linework, force-paved by the drafter from
                  the 3D Edit Mode. Listed by geometry — the stale-save heal
                  re-sequences road ids, so the stored override is a geometry
                  fingerprint — each with a Reset back to the tool's own
                  judgment. */}
              {(layoutEdits.pavedTracedRoads ?? []).length > 0 && (
                <div className="pt-2 border-t border-slate-700/60 space-y-1.5">
                  <p className="text-[10px] text-slate-500 uppercase tracking-wide">Force-paved traced strips</p>
                  {(layoutEdits.pavedTracedRoads ?? []).map(t => (
                    <div key={`pvtr-${t.x}-${t.y}-${t.len}`} className="flex items-center justify-between gap-2">
                      <span className="truncate">Paved as drawn @ ({t.x.toFixed(0)}, {t.y.toFixed(0)}) — {t.len.toFixed(0)} ft</span>
                      <button
                        onClick={() => {
                          useDesignStore.getState().unpaveTracedRoad(t);
                          toast.success('Override removed — the strip returns to reference linework');
                        }}
                        className="shrink-0 px-2 py-1 rounded bg-slate-700 hover:bg-slate-600 text-xs font-semibold text-slate-100"
                      >
                        Reset
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {Object.keys(layoutEdits.augPins ?? {}).length > 0 && (
                <div className="pt-2 border-t border-slate-700/60 space-y-1.5">
                  {Object.entries(layoutEdits.augPins ?? {}).map(([zoneId, pt]) => {
                    const mIsl = zoneId.match(/^island-aug-(\d+)-(\d+)$/);
                    const name = mIsl
                      ? `Island ${mIsl[1]} aug unit ${mIsl[2]}`
                      : `Future block ${zoneId.replace('future-blk-', '')}`;
                    const dormantPrefix = mIsl
                      ? `Pinned island ${mIsl[1]} augmentation unit ${mIsl[2]} is dormant`
                      : `Pinned future BESS block ${zoneId.replace('future-blk-', '')} is dormant`;
                    const dormant =
                      design != null &&
                      !design.reservedZones.some(z => z.id === zoneId) &&
                      design.warnings.some(w => w.startsWith(dormantPrefix));
                    return (
                    <div key={zoneId} className="flex items-center justify-between gap-2">
                      <span>
                        {name} pinned @ ({pt.x.toFixed(0)}, {pt.y.toFixed(0)}) ft
                        {dormant && (
                          <span className="ml-1 text-amber-400" title={mIsl ? "The current layout doesn't have this island unit. The pin is kept and re-applies if the unit returns." : "The current augmentation % doesn't create this block. The pin is kept and re-applies if the reserve is raised."}>
                            {mIsl ? '— dormant (unit not in current layout)' : '— dormant (raise augmentation % to restore)'}
                          </span>
                        )}
                      </span>
                      <button
                        onClick={() => {
                          setFutureAugPin(zoneId, null);
                          toast.success(`${name} set back to automatic placement`);
                        }}
                        className="shrink-0 px-2 py-1 rounded bg-slate-700 hover:bg-slate-600 text-xs font-semibold text-slate-100"
                      >
                        Reset
                      </button>
                    </div>
                  );})}
                </div>
              )}

            </div>
          </PanelSection>
        )}

        {/* Step 7: Reset & alternative arrangements */}
        {design && (
          <PanelSection id="arrangements" title="7. Reset &amp; Arrangements" discipline="Layout">
            <div className="space-y-2 text-xs text-slate-400">
              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={() => { if (undoEdit()) toast.success('Undo'); }}
                  disabled={undoStack.length === 0}
                  className="py-1.5 rounded bg-slate-700 hover:bg-slate-600 disabled:opacity-40 disabled:cursor-not-allowed text-xs font-semibold text-slate-100"
                  title="Ctrl+Z"
                >
                  ↶ Undo{undoStack.length ? ` (${undoStack.length})` : ''}
                </button>
                <button
                  onClick={() => { if (redoEdit()) toast.success('Redo'); }}
                  disabled={redoStack.length === 0}
                  className="py-1.5 rounded bg-slate-700 hover:bg-slate-600 disabled:opacity-40 disabled:cursor-not-allowed text-xs font-semibold text-slate-100"
                  title="Ctrl+Y"
                >
                  ↷ Redo{redoStack.length ? ` (${redoStack.length})` : ''}
                </button>
              </div>
              {/* Edit history timeline: every recorded action, click to jump */}
              <button
                onClick={() => setShowHistory(v => !v)}
                className="w-full py-1.5 rounded bg-slate-800 hover:bg-slate-700 border border-slate-700 text-xs text-slate-300"
              >
                {showHistory ? '▾' : '▸'} Edit history ({undoStack.length + redoStack.length})
              </button>
              {showHistory && (
                <div className="rounded border border-slate-700 bg-slate-950/60 max-h-56 overflow-y-auto text-xs divide-y divide-slate-800">
                  <button
                    onClick={() => { jumpHistory(0); toast.success('Jumped to start of history'); }}
                    disabled={undoStack.length === 0}
                    className={`w-full text-left px-2 py-1.5 hover:bg-slate-800 disabled:cursor-default ${
                      undoStack.length === 0 ? 'text-cyan-300 font-semibold' : 'text-slate-400'
                    }`}
                  >
                    Start{undoStack.length === 0 ? ' — current' : ''}
                  </button>
                  {[
                    ...undoStack.map(s => s.label),
                    ...[...redoStack].reverse().map(s => s.label),
                  ].map((label, i) => {
                    const isCurrent = i === undoStack.length - 1;
                    const isFuture = i >= undoStack.length;
                    return (
                      <button
                        key={i}
                        onClick={() => {
                          if (isCurrent) return;
                          jumpHistory(i + 1);
                          toast.success(`Jumped to: ${label}`);
                        }}
                        className={`w-full text-left px-2 py-1.5 hover:bg-slate-800 ${
                          isCurrent
                            ? 'text-cyan-300 font-semibold'
                            : isFuture
                              ? 'text-slate-500 italic'
                              : 'text-slate-300'
                        }`}
                      >
                        {label}
                        {isCurrent ? ' — current' : ''}
                      </button>
                    );
                  })}
                  {undoStack.length + redoStack.length === 0 && (
                    <div className="px-2 py-1.5 text-slate-500">No edits yet — every change you make will appear here.</div>
                  )}
                </div>
              )}
              {/* Remove ALL equipment: one confirmed, undoable edit that
                  empties the yard. Removed automatic items stay listed on
                  the restore surfaces; Ctrl+Z puts everything back at once. */}
              {!confirmRemoveAll ? (
                <button
                  onClick={() => setConfirmRemoveAll(true)}
                  className="w-full py-2 rounded bg-slate-700 hover:bg-red-800 text-sm font-semibold text-slate-100"
                >
                  Remove all equipment
                </button>
              ) : (
                <div className="rounded border border-red-800 bg-red-950/40 p-2 space-y-1.5">
                  <div className="text-red-300">
                    This deletes every block, island and equipment item in the yard as one edit.
                    Roads, cables and exports rebuild for the empty yard. One Ctrl+Z restores everything.
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      onClick={() => {
                        setConfirmRemoveAll(false);
                        const n = useDesignStore.getState().removeAllEquipment();
                        if (n) toast.success(`All equipment removed (${n} item${n === 1 ? '' : 's'}) — one Ctrl+Z restores everything`);
                        else toast.info('The yard is already empty — nothing to remove');
                      }}
                      className="py-1.5 rounded bg-red-700 hover:bg-red-600 text-xs font-semibold text-slate-100"
                    >
                      Yes, remove all
                    </button>
                    <button
                      onClick={() => setConfirmRemoveAll(false)}
                      className="py-1.5 rounded bg-slate-700 hover:bg-slate-600 text-xs font-semibold text-slate-100"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
              {!confirmReset ? (
                <button
                  onClick={() => {
                    if (!hasEdits) {
                      toast.info('No layout edits to reset — the automatic baseline layout is already shown');
                      return;
                    }
                    setConfirmReset(true);
                  }}
                  className="w-full py-2 rounded bg-slate-700 hover:bg-red-800 text-sm font-semibold text-slate-100"
                >
                  Reset to default layout
                </button>
              ) : (
                <div className="rounded border border-red-800 bg-red-950/40 p-2 space-y-1.5">
                  <div className="text-red-300">
                    This discards all layout edits and restores the fully automatic{' '}
                    {arrangement === 'sw' ? 'standard' : (ARRANGEMENTS.find(a => a.id === arrangement)?.label ?? arrangement)} baseline layout (roads rebuilt). You can undo this with Ctrl+Z.
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      onClick={() => {
                        setConfirmReset(false);
                        resetLayoutEdits();
                        setEditDx('0');
                        setEditDy('0');
                        setTrenchInput('');
                        toast.success('Layout edits cleared — automatic baseline layout restored');
                      }}
                      className="py-1.5 rounded bg-red-700 hover:bg-red-600 text-xs font-semibold text-slate-100"
                    >
                      Yes, reset
                    </button>
                    <button
                      onClick={() => setConfirmReset(false)}
                      className="py-1.5 rounded bg-slate-700 hover:bg-slate-600 text-xs font-semibold text-slate-100"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
              {arrangement !== 'sw' && (
                <div className="space-y-1.5">
                  <div className="text-slate-500">
                    Baseline: {ARRANGEMENTS.find(a => a.id === arrangement)?.label ?? arrangement}
                  </div>
                  <button
                    onClick={() => handlePickArrangement('sw')}
                    className="w-full py-1.5 rounded bg-slate-700 hover:bg-slate-600 text-xs font-semibold text-slate-100"
                  >
                    Return to standard default arrangement
                  </button>
                </div>
              )}

              <button
                onClick={() => setShowArrangements(v => !v)}
                className="w-full py-1.5 rounded bg-slate-700 hover:bg-slate-600 text-xs font-semibold text-slate-100"
              >
                {showArrangements ? 'Hide arrangement explorer' : 'Explore arrangements'}
              </button>

              {showArrangements && arrangementOptions && (
                <div className="space-y-1.5">
                  {arrangementOptions.map(opt => {
                    const active = opt.strategy === arrangement;
                    const shortfall = shortfallVsDefault(opt.strategy);
                    return (
                      <div
                        key={opt.strategy}
                        className={`rounded border p-2 space-y-1 ${active ? 'border-cyan-500 bg-cyan-950/30' : 'border-slate-700 bg-slate-800/60'}`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-semibold text-slate-200">
                            {opt.label}
                            {opt.strategy === 'sw' && <span className="text-slate-500 font-normal"> — default</span>}
                          </span>
                          {active ? (
                            <span className="shrink-0 text-cyan-400 font-semibold">Active</span>
                          ) : (
                            <button
                              onClick={() => handlePickArrangement(opt.strategy)}
                              className="shrink-0 px-2 py-1 rounded bg-cyan-700 hover:bg-cyan-600 text-xs font-semibold text-slate-100"
                            >
                              Apply
                            </button>
                          )}
                        </div>
                        <div className="text-slate-500">{opt.description}</div>
                        {shortfall > 0 && (
                          <div className="inline-flex items-center gap-1 rounded border border-amber-600 bg-amber-950/50 px-1.5 py-0.5 text-amber-300 font-semibold">
                            <span aria-hidden>⚠</span>
                            {shortfall} fewer block{shortfall === 1 ? '' : 's'} than default
                          </div>
                        )}
                        <ArrangementThumbnail
                          design={opt.design}
                          referenceFence={
                            !active
                              ? arrangementOptions.find(o => o.strategy === arrangement)?.design.fence
                              : undefined
                          }
                        />
                        <div className="grid grid-cols-2 gap-x-3 text-slate-400">
                          <span>Blocks: {opt.stats.blocksPlaced}/{opt.stats.blocksRequired}</span>
                          <span>Fence: {opt.stats.fenceAcres.toFixed(1)} ac</span>
                          <span>Roads: {opt.stats.roadLengthFt.toFixed(0)} ft</span>
                          <span>Cable: {opt.stats.cableFt.toFixed(0)} ft</span>
                        </div>
                      </div>
                    );
                  })}
                  <div className="text-slate-500">
                    <span className="text-orange-400 font-semibold">G</span> marks the gate; the{' '}
                    <span className="text-pink-400">dashed pink outline</span> on other options is the active arrangement's fence for comparison.
                  </div>
                  <div className="text-slate-500">
                    Applying an arrangement makes it the new baseline: layout edits are cleared and roads are rebuilt for it.
                  </div>
                </div>
              )}
              {showArrangements && !arrangementOptions && (
                <div className="text-slate-500">Could not compute arrangement alternatives for this site.</div>
              )}

              {pendingArrangement && (
                <div className="rounded border border-amber-700 bg-amber-950/40 p-2 space-y-1.5">
                  <div className="text-amber-300">
                    Applying {ARRANGEMENTS.find(a => a.id === pendingArrangement)?.label ?? pendingArrangement}
                    {shortfallVsDefault(pendingArrangement) > 0 && (
                      <> places {shortfallVsDefault(pendingArrangement)} fewer block{shortfallVsDefault(pendingArrangement) === 1 ? '' : 's'} than the standard default arrangement</>
                    )}
                    {hasEdits
                      ? `${shortfallVsDefault(pendingArrangement) > 0 ? ' and' : ''} discards your current layout edits and rebuilds the roads.`
                      : ' and rebuilds the roads.'} Continue?
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      onClick={() => applyArrangement(pendingArrangement)}
                      className="py-1.5 rounded bg-amber-700 hover:bg-amber-600 text-xs font-semibold text-slate-100"
                    >
                      {hasEdits ? 'Apply & clear edits' : 'Apply anyway'}
                    </button>
                    <button
                      onClick={() => setPendingArrangement(null)}
                      className="py-1.5 rounded bg-slate-700 hover:bg-slate-600 text-xs font-semibold text-slate-100"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              {/* Layout optimizer */}
              <div className="pt-1 border-t border-slate-700 space-y-1.5">
                {!optRunning ? (
                  <button
                    onClick={handleRunOptimizer}
                    className="w-full py-1.5 rounded bg-emerald-700 hover:bg-emerald-600 text-xs font-semibold text-slate-100"
                  >
                    Optimize layout
                  </button>
                ) : (
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between text-slate-400">
                      <span>Searching layouts… {optProgress ? `${optProgress.done}/${optProgress.total}` : ''}</span>
                      <button
                        onClick={() => { optCancelRef.current = true; cancelChannel('optimize'); }}
                        className="px-2 py-1 rounded bg-slate-700 hover:bg-slate-600 text-xs font-semibold text-slate-100"
                      >
                        Cancel
                      </button>
                    </div>
                    <div className="h-1.5 rounded bg-slate-700 overflow-hidden">
                      <div
                        className="h-full bg-emerald-500 transition-all"
                        style={{ width: `${optProgress && optProgress.total > 0 ? Math.round((optProgress.done / optProgress.total) * 100) : 0}%` }}
                      />
                    </div>
                  </div>
                )}
                <div className="text-slate-500">
                  Runs a deterministic search over placement variations (scan corner, grid offset, trench corridor, gate edge) and ranks valid layouts by achieved MWh, then shortest cable.
                </div>

                {optResult && optResult.candidates.length > 0 && (
                  <div className="space-y-1.5">
                    {optResult.candidates.map((cand, i) => {
                      const label = ARRANGEMENTS.find(a => a.id === cand.params.arrangement)?.label ?? cand.params.arrangement;
                      const knobs: string[] = [];
                      if (cand.params.latticeShift) knobs.push(`grid offset ${cand.params.latticeShift.x}, ${cand.params.latticeShift.y} ft`);
                      if (cand.params.trenchX !== null) knobs.push(`trench at x = ${cand.params.trenchX} ft`);
                      if (cand.params.gateEdge && cand.params.gateEdge !== 'S') knobs.push(`gate on ${cand.params.gateEdge === 'N' ? 'north' : cand.params.gateEdge === 'E' ? 'east' : 'west'} edge`);
                      return (
                        <div key={cand.id} className="rounded border border-slate-700 bg-slate-800/60 p-2 space-y-1">
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-semibold text-slate-200">
                              #{i + 1} — {label}
                              {i === 0 && <span className="text-emerald-400 font-normal"> — best</span>}
                            </span>
                            <button
                              onClick={() => handleApplyCandidate(cand)}
                              className="shrink-0 px-2 py-1 rounded bg-emerald-700 hover:bg-emerald-600 text-xs font-semibold text-slate-100"
                            >
                              Apply
                            </button>
                          </div>
                          {knobs.length > 0 && <div className="text-slate-500">{knobs.join(' · ')}</div>}
                          <ArrangementThumbnail design={cand.design} />
                          <div className="grid grid-cols-2 gap-x-3 text-slate-400">
                            <span>Blocks: {cand.stats.blocksPlaced}/{cand.stats.blocksRequired}</span>
                            <span>Energy: {cand.stats.achievedMWh.toFixed(0)} MWh</span>
                            <span>Cable: {cand.stats.cableFt.toFixed(0)} ft</span>
                            <span>Roads: {cand.stats.roadLengthFt.toFixed(0)} ft</span>
                          </div>
                        </div>
                      );
                    })}
                    <div className="text-slate-500">
                      Applying a result makes it the new baseline: layout edits are cleared (except the result's trench pin) and roads are rebuilt. Undo with Ctrl+Z.
                    </div>
                  </div>
                )}
                {optResult && optResult.candidates.length === 0 && (
                  <div className="text-slate-500">No valid alternative layouts found — the automatic baseline is already best.</div>
                )}
              </div>

              {/* Multi-scenario comparison (Max Capacity / Min Cabling / Min Civil / Balanced) */}
              <ScenarioComparePanel />
            </div>
          </PanelSection>
        )}

        {/* Results — the active area, then (multi-area only) the whole site */}
        {design && (
          <section className="bg-slate-800 rounded p-3 text-sm space-y-1">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-1">
              {siteAreas.length > 1 ? 'Auto-Sized Layout — this area' : 'Auto-Sized Layout'}
            </h3>
            <div className="flex justify-between"><span className="text-slate-400">Blocks placed</span><span>{design.blocksPlaced} / {design.blocksRequired}</span></div>
            <div className="flex justify-between"><span className="text-slate-400">BESS containers</span><span>{design.equipment.filter(e => e.kind === 'bess').length}</span></div>
            <div className="flex justify-between"><span className="text-slate-400">PCS Units</span><span>{design.equipment.filter(e => e.kind === 'inverter').length}</span></div>
            <div className="flex justify-between"><span className="text-slate-400">Achieved</span><span>{design.achievedMW.toFixed(1)} MW / {design.achievedMWh.toFixed(0)} MWh</span></div>
            {design.warnings.map((w, i) => {
              if (w.startsWith('Island alignment available:')) {
                return (
                  <div key={i} className="text-xs mt-2 text-amber-400">
                    ⚠ {w}{' '}
                    <button
                      type="button"
                      className="underline hover:text-amber-200 transition-colors"
                      onClick={() => setAlignIslands(true)}
                    >
                      Enable alignment
                    </button>
                  </div>
                );
              }
              return (
                <div
                  key={i}
                  className={`${w.startsWith('Access-road capacity shortfall:')
                    ? 'border border-red-500/70 bg-red-950/35 text-red-300 font-medium rounded px-2 py-1.5'
                    : 'text-amber-400'} text-xs mt-2`}
                >
                  ⚠ {w}
                </div>
              );
            })}
          </section>
        )}

        {/* Whole-site totals: every area summed, with each area still listed
            separately. Areas that have not generated are called out rather
            than quietly dropped, so the site figure is never a silent
            undercount. */}
        {design && siteTotals && (
          <section className="bg-slate-800 rounded p-3 text-sm space-y-1">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-1">
              Whole Site — {siteTotals.perArea.length} areas
            </h3>
            <div className="flex justify-between"><span className="text-slate-400">Blocks placed</span><span>{siteTotals.blocksPlaced} / {siteTotals.blocksRequired}</span></div>
            <div className="flex justify-between"><span className="text-slate-400">BESS containers</span><span>{siteTotals.bessContainers}</span></div>
            <div className="flex justify-between"><span className="text-slate-400">PCS Units</span><span>{siteTotals.pcsUnits}</span></div>
            <div className="flex justify-between"><span className="text-slate-400">Achieved</span><span>{siteTotals.achievedMW.toFixed(1)} MW / {siteTotals.achievedMWh.toFixed(0)} MWh</span></div>
            <div className="flex justify-between">
              <span className="text-slate-400">Future augmentation</span>
              <span>{siteTotals.augBlocks} blk (+{siteTotals.augMW.toFixed(1)} MW / +{siteTotals.augMWh.toFixed(0)} MWh)</span>
            </div>
            <div className="flex justify-between"><span className="text-slate-400">Site area</span><span>{siteTotals.acres.toFixed(1)} ac</span></div>
            <div className="mt-2 pt-2 border-t border-slate-700 space-y-0.5">
              {siteTotals.perArea.map(a => (
                <div key={a.id} className="space-y-0.5">
                  <div className="flex justify-between gap-2 text-[11px]">
                    <span className="text-slate-400 truncate">
                      {a.name}
                      {a.kind === 'substation' && <span className="text-slate-600"> · sub</span>}
                    </span>
                    <span className="shrink-0 text-slate-300">
                      {a.generated
                        ? a.kind === 'substation'
                          ? `${a.acres.toFixed(1)} ac`
                          : `${a.blocksPlaced}/${a.blocksRequired} blk · ${a.achievedMW.toFixed(1)} MW / ${a.achievedMWh.toFixed(0)} MWh`
                        : <span className="text-amber-400">not generated</span>}
                    </span>
                  </div>
                  {/* Per-area detail: every BESS footprint is designed to the
                      FULL selected target, so its own shortfall, its future
                      augmentation reserve (never part of the active MW) and
                      the substation actually collecting it all belong on the
                      area's own line rather than only in the site total. */}
                  {a.generated && a.kind === 'bess' && (
                    <div className="pl-2 text-[10px] leading-snug text-slate-500">
                      {a.blocksShort > 0 ? (
                        <span className="text-amber-400">
                          Short {a.blocksShort} block{a.blocksShort === 1 ? '' : 's'} of target
                        </span>
                      ) : (
                        <span className="text-emerald-400">Full target met</span>
                      )}
                      {' · '}
                      {a.augBlocks > 0
                        ? `Future aug ${a.augBlocks} blk (+${a.augMW.toFixed(1)} MW / +${a.augMWh.toFixed(0)} MWh, not in active total)`
                        : 'No future augmentation fits'}
                      <br />
                      {a.servingSubstation
                        ? <>Served by {a.servingSubstation}{a.feederCount >= 0 ? ` · ${a.feederCount} routed feeder${a.feederCount === 1 ? '' : 's'}` : ''}</>
                        : <span className="text-amber-400">No substation take-off aimed at this area — MV feeders not routed</span>}
                      {a.servingSubstation && a.feederCount === 0 && (
                        <span className="text-amber-400"> — no feeders routed</span>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
            {siteTotals.pendingAreas > 0 && (
              <div className="text-amber-400 text-xs mt-2">
                ⚠ {siteTotals.pendingAreas} area{siteTotals.pendingAreas > 1 ? 's have' : ' has'} no layout yet — the site total above is incomplete.
              </div>
            )}
            {/* Roads dropped on an area the drafter may not be viewing. Named
                explicitly so a compact-mode fallback is never a silent loss. */}
            {roadlessAreas.map(a => (
              <div key={a.id} className="text-amber-400 text-xs mt-2">
                ⚠ {a.name}: no interior access roads. {a.reason}
              </div>
            ))}
            {roadCapacityShortfallAreas.map(a => (
              <div key={a.id} className="border border-red-500/70 bg-red-950/35 text-red-300 font-medium rounded px-2 py-1.5 text-xs mt-2">
                ⚠ {a.name}: {a.reason}
              </div>
            ))}
          </section>
        )}

        {design && <DrawingVisibilityPanel />}

        {/* Container marker legend */}
        {design && (
          <section className="bg-slate-800 rounded p-3 text-xs space-y-1.5">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-1">
              Container Markers
            </h3>
            <div className="flex items-start gap-2">
              <span className="inline-block w-6 h-2 mt-1 shrink-0 rounded-sm bg-slate-100 border border-slate-500" />
              <span className="text-slate-300">White stripe = door / compartment end wall</span>
            </div>
            <div className="flex items-start gap-2">
              <span className="inline-block w-6 mt-0.5 shrink-0 text-center font-mono text-slate-100">A/C</span>
              <span className="text-slate-300">(A) = E-panel on left side, (C) = E-panel on right side</span>
            </div>
          </section>
        )}

        {/* Compliance report against the NextEra guidance checklist */}
        {design && <CompliancePanel />}
      </div>

      {/* Export */}
      <div className="p-4 border-t border-slate-700">
        {design && (() => {
          const report = validateDesign(design, { titleBlock, feeders, substation, terrain: terrainAnalysis.steep, electrical: electricalReport, areaZones });
          const icon = (s: string) => (s === 'pass' ? '✓' : s === 'warn' ? '⚠' : '✕');
          const color = (s: string) =>
            s === 'pass' ? 'text-emerald-400' : s === 'warn' ? 'text-amber-400' : 'text-red-400';
          return (
            <div className="mb-3 bg-slate-800 rounded p-3">
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-1.5">
                Pre-Export Check
                <span className={`ml-2 ${report.failCount ? 'text-red-400' : report.warnCount ? 'text-amber-400' : 'text-emerald-400'}`}>
                  {report.failCount
                    ? `${report.failCount} blocking issue${report.failCount > 1 ? 's' : ''}`
                    : report.warnCount
                      ? `${report.warnCount} warning${report.warnCount > 1 ? 's' : ''}`
                      : 'all clear'}
                </span>
              </div>
              <div className="space-y-1">
                {report.checks.map(c => (
                  <div key={c.id} className="text-xs flex gap-1.5" title={c.detail}>
                    <span className={`shrink-0 ${color(c.status)}`}>{icon(c.status)}</span>
                    <span className="text-slate-300">{c.label}</span>
                    {c.status !== 'pass' && (
                      <span className="text-slate-500 truncate">— {c.detail}</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          );
        })()}
        <label
          className="flex items-center gap-2 mb-2 text-sm cursor-pointer"
          title="Add existing-grade contour lines to the exported DXF on dedicated reference layers (C - EXISTING CONTOUR, dashed, with elevation labels on index contours). Off by default — the drawing content is unchanged unless enabled."
        >
          <input
            type="checkbox"
            checked={exportContoursDxf}
            onChange={e => setExportContoursDxf(e.target.checked)}
            className="accent-cyan-500"
          />
          <span className="text-slate-300">Include contour lines in DXF (reference layer)</span>
        </label>
        <label
          className="flex items-center gap-2 mb-2 text-sm cursor-pointer"
          title="Add the grounding screening layout to exports: a dedicated DXF layer (EQUIP - GROUNDING, dashed — perimeter loop, rod symbols, bonding taps, screening key note) and a grounding takeoff section with a layout figure in the permit packet PDF. Off by default — export content is unchanged unless enabled."
        >
          <input
            type="checkbox"
            checked={exportGroundingDxf}
            onChange={e => setExportGroundingDxf(e.target.checked)}
            className="accent-cyan-500"
          />
          <span className="text-slate-300">Include grounding layout in exports (DXF + permit packet)</span>
        </label>
        <label
          className="flex items-center gap-2 mb-2 text-sm cursor-pointer"
          title="Add the typical trench section schedule to the DXF exports: MVAC direct-bury 2 ft wide x 3 ft deep, aux power 3.5 ft x 2.5 ft, DC duct bank 2 ft x 2.5 ft per the issued trench detail sheets CAR-D-B006-1/2. Off by default — export content is unchanged unless enabled. The permit packet always carries the trench sections table."
        >
          <input
            type="checkbox"
            checked={exportTrenchSectionsDxf}
            onChange={e => setExportTrenchSectionsDxf(e.target.checked)}
            className="accent-cyan-500"
          />
          <span className="text-slate-300">Include typical trench sections in DXF (CAR-D-B006)</span>
        </label>
        <label
          className="flex items-center gap-2 mb-2 text-sm cursor-pointer"
          title="Legacy full-area crushed-rock cross-hatch over the whole yard on DXF/PDF exports. Off by default — the only ground mesh is the future-augmentation area (ANSI37), matching the issued reference drawings."
        >
          <input
            type="checkbox"
            checked={exportSurfacingMesh}
            onChange={e => setExportSurfacingMesh(e.target.checked)}
            className="accent-cyan-500"
          />
          <span className="text-slate-300">Full-area surfacing mesh in exports (legacy)</span>
        </label>
        {exportContoursDxf && !terrain && (
          <div className="mb-2 text-xs text-amber-400">
            {terrainStatus === 'loading'
              ? 'Loading elevation data for contours…'
              : `No elevation data${terrainError ? `: ${terrainError}` : ''} — DXF will export without contours`}
          </div>
        )}
        {/* Multi-area export scope: the whole site by default, or any chosen
            combination of footprints. Applies to the DXF and the single-page
            PDF plot, which compose through the same helper the CAD view
            renders — so what is selected here is exactly what ships. */}
        {siteAreas.length > 1 && (
          <div className="mb-2 bg-slate-800 border border-slate-600 rounded p-3">
            <div className="text-[10px] uppercase tracking-wide text-slate-400 mb-2">
              Export scope — DXF &amp; PDF plot
            </div>
            <label className="flex items-center gap-2 text-xs cursor-pointer mb-1.5" title="Export every footprint in this project as one drawing.">
              <input
                type="radio"
                checked={exportAreaIds === null}
                onChange={() => setExportAreaIds(null)}
                className="accent-cyan-500"
              />
              <span className="text-slate-200 font-medium">Entire site ({siteAreas.length} areas)</span>
            </label>
            <label className="flex items-center gap-2 text-xs cursor-pointer" title="Export only the areas ticked below — one area, or any combination (e.g. two BESS areas plus the substation that collects them).">
              <input
                type="radio"
                checked={exportAreaIds !== null}
                onChange={() => setExportAreaIds([activeAreaId ?? siteAreas[0].id])}
                className="accent-cyan-500"
              />
              <span className="text-slate-200 font-medium">Selected areas</span>
            </label>
            {exportAreaIds !== null && (
              <div className="mt-2 pl-5 flex flex-col gap-1">
                {siteAreas.map(a => (
                  <label key={a.id} className="flex items-center gap-2 text-xs cursor-pointer">
                    <input
                      type="checkbox"
                      checked={exportAreaIds.includes(a.id)}
                      onChange={e => setExportAreaIds(prev => {
                        const cur = prev ?? [];
                        if (e.target.checked) {
                          // Keep stored area order so the composed op stream
                          // (and therefore the drawing) is selection-order
                          // independent.
                          const next = siteAreas.filter(x => x.id === a.id || cur.includes(x.id)).map(x => x.id);
                          return next;
                        }
                        const next = cur.filter(id => id !== a.id);
                        // Never allow an empty selection: it would compose a
                        // blank sheet with no explanation.
                        return next.length ? next : cur;
                      })}
                      className="accent-cyan-500"
                    />
                    <span className="text-slate-300 truncate">{a.name}</span>
                    <span className="text-[10px] uppercase text-slate-500 shrink-0">
                      {a.kind === 'substation' ? 'Sub' : a.kind === 'bess' ? 'BESS' : 'Area'}
                    </span>
                  </label>
                ))}
              </div>
            )}
            <div className="text-[10px] text-slate-400 mt-2">
              Exporting: <span className="text-cyan-300">{exportScopeLabel}</span>
            </div>
          </div>
        )}
        <button
          onClick={handleExport}
          disabled={!design}
          className="w-full py-2.5 rounded bg-cyan-600 hover:bg-cyan-500 disabled:opacity-40 disabled:cursor-not-allowed font-semibold text-sm"
        >
          {siteAreas.length > 1 ? `Export DXF — ${exportScopeLabel}` : 'Export DXF'}
        </button>
        <button
          onClick={handleExportDxfPdf}
          disabled={!design || dxfPdfBusy}
          className="w-full mt-2 py-2.5 rounded bg-cyan-600 hover:bg-cyan-500 disabled:opacity-40 disabled:cursor-not-allowed font-semibold text-sm"
        >
          {dxfPdfBusy ? 'Rendering PDF…' : siteAreas.length > 1 ? `Export PDF Plot — ${exportScopeLabel}` : 'Export DXF as PDF Plot (1 page)'}
        </button>
        <button
          onClick={handleExportPackage}
          disabled={!design}
          className="w-full mt-2 py-2.5 rounded bg-cyan-700 hover:bg-cyan-600 disabled:opacity-40 disabled:cursor-not-allowed font-semibold text-sm"
        >
          {includeSldBom ? 'Export DXF Package (10 sheets + refs, ZIP)' : 'Export DXF Package (7 sheets + refs, ZIP)'}
        </button>
        <button
          onClick={handleExportPdf}
          disabled={!design || pdfBusy}
          className="w-full mt-2 py-2.5 rounded bg-cyan-800 hover:bg-cyan-700 disabled:opacity-40 disabled:cursor-not-allowed font-semibold text-sm"
        >
          {pdfBusy ? 'Rendering PDF…' : includeSldBom ? 'Export PDF Plot Set (18 pages)' : 'Export PDF Plot Set (16 pages)'}
        </button>
        <button
          onClick={handleExport10Package}
          disabled={!design || pkg10Busy}
          title="One click: full DXF sheet package + multi-page PDF plot set (10% cover, drawing sheets, and a dedicated full-site top-down realistic render page) in a single zip. Requires the 3D view with realistic models enabled and satellite imagery — fails loudly if either cannot load."
          className="w-full mt-2 py-2.5 rounded bg-emerald-700 hover:bg-emerald-600 disabled:opacity-40 disabled:cursor-not-allowed font-semibold text-sm"
        >
          {pkg10Busy ? (pkg10Stage || 'Exporting 10% Package…') : 'Export 10% Package (DXF + PDF, ZIP)'}
        </button>
        <label className="mt-2 flex items-center gap-1.5 text-xs text-slate-300" title="Append the single-line diagram and bill-of-materials sheets to the DXF package and PDF plot set. Off by default — the default exports are unchanged byte-for-byte.">
          <input
            type="checkbox"
            checked={includeSldBom}
            onChange={e => setIncludeSldBom(e.target.checked)}
            className="accent-emerald-500"
          />
          Include SLD + BOM sheets in package / plot set
        </label>
        <label className="mt-1.5 flex items-center gap-1.5 text-xs text-slate-300" title="Replace the cover sheet with the NextEra issued-for-review style: stylized state/county vicinity map (U.S. Census TIGERweb data) with the site starred, aerial photo key plan with the layout georegistered over it, project stats and ISSUED FOR 10% REVIEW stamp. Off by default — default exports are unchanged byte-for-byte.">
          <input
            type="checkbox"
            checked={issuedFor10}
            onChange={e => setIssuedFor10(e.target.checked)}
            className="accent-amber-500"
          />
          Issued for 10% cover (vicinity map + aerial)
        </label>
        {issuedFor10 && (
          <div className="mt-1 ml-5 flex flex-col gap-1">
            <label className="flex items-center gap-1.5 text-xs text-slate-400" title="Hide the equipment labels in the cover's aerial site layout render (3D view captures only — the vector key plan never carries labels).">
              <input
                type="checkbox"
                checked={hideCoverLabelsAerial}
                onChange={e => setHideCoverLabelsAerial(e.target.checked)}
                className="accent-amber-500"
              />
              Remove labels from aerial layout image
            </label>
            <label className="flex items-center gap-1.5 text-xs text-slate-400" title="Hide the equipment labels in the SITE 3D MODEL inset render on the cover.">
              <input
                type="checkbox"
                checked={hideCoverLabelsModel}
                onChange={e => setHideCoverLabelsModel(e.target.checked)}
                className="accent-amber-500"
              />
              Remove labels from SITE 3D MODEL image
            </label>
            <label className="flex items-center gap-1.5 text-xs text-slate-400" title="Hide the equipment labels in the dedicated full-page hi-res site render appended to the one-click 10% package.">
              <input
                type="checkbox"
                checked={hideSiteRenderLabels}
                onChange={e => setHideSiteRenderLabels(e.target.checked)}
                className="accent-amber-500"
              />
              Remove labels from full-page site render
            </label>
          </div>
        )}
        <div className="mt-2 flex items-center gap-4 text-xs text-slate-300">
          <label className="flex items-center gap-1.5" title="Draw the single-line diagram with the IEC 60617 symbol set instead of the default ANSI/IEEE 315 (ANSI Y32.2) shapes. The two conventions are never mixed on one sheet.">
            <input
              type="checkbox"
              checked={sldStandard === 'IEC'}
              onChange={e => setSldStandard(e.target.checked ? 'IEC' : 'ANSI')}
              className="accent-indigo-500"
            />
            <span>IEC 60617 symbols</span>
          </label>
          <label
            className="flex items-center gap-1.5"
            title={scStudy
              ? 'Label each bus on the SLD with its symmetrical / peak fault duty from the short-circuit study (IEEE 141 practice).'
              : 'Enable the short-circuit study card first — fault duties come straight from it.'}
          >
            <input
              type="checkbox"
              checked={sldIncludeFaults}
              disabled={!scStudy}
              onChange={e => setSldIncludeFaults(e.target.checked)}
              className="accent-indigo-500 disabled:opacity-40"
            />
            <span className={scStudy ? '' : 'opacity-50'}>Fault duties on SLD</span>
          </label>
        </div>
        <div className="grid grid-cols-2 gap-2 mt-2">
          <button
            onClick={handleExportSldDxf}
            disabled={!design || !feeders.length}
            title={feeders.length ? undefined : 'Place a substation to route feeders first'}
            className="py-2.5 rounded bg-indigo-700 hover:bg-indigo-600 disabled:opacity-40 disabled:cursor-not-allowed font-semibold text-sm"
          >
            Single-Line Diagram (DXF)
          </button>
          <button
            onClick={handleExportSldPdf}
            disabled={!design || !feeders.length || sldPdfBusy}
            title={feeders.length ? undefined : 'Place a substation to route feeders first'}
            className="py-2.5 rounded bg-indigo-800 hover:bg-indigo-700 disabled:opacity-40 disabled:cursor-not-allowed font-semibold text-sm"
          >
            {sldPdfBusy ? 'Rendering…' : 'Single-Line Diagram (PDF)'}
          </button>
        </div>
        <div className="grid grid-cols-2 gap-2 mt-2">
          <button
            onClick={handleExportRelayDxf}
            disabled={!design || !feeders.length}
            title={feeders.length ? 'Protection & metering one-line — ANSI device numbers with screening CT/VT placeholders' : 'Place a substation to route feeders first'}
            className="py-2.5 rounded bg-violet-700 hover:bg-violet-600 disabled:opacity-40 disabled:cursor-not-allowed font-semibold text-sm"
          >
            Relay One-Line (DXF)
          </button>
          <button
            onClick={handleExportRelayPdf}
            disabled={!design || !feeders.length || relayPdfBusy}
            title={feeders.length ? 'Protection & metering one-line — ANSI device numbers with screening CT/VT placeholders' : 'Place a substation to route feeders first'}
            className="py-2.5 rounded bg-violet-800 hover:bg-violet-700 disabled:opacity-40 disabled:cursor-not-allowed font-semibold text-sm"
          >
            {relayPdfBusy ? 'Rendering…' : 'Relay One-Line (PDF)'}
          </button>
        </div>
        <div className="grid grid-cols-2 gap-2 mt-2">
          <button
            onClick={handleExportBomSheetDxf}
            disabled={!design}
            title="Bill-of-materials schedule sheet: major equipment + cable / terminations / conduit / civil / grounding rollups — same line items as the Full BOM CSV"
            className="py-2.5 rounded bg-emerald-700 hover:bg-emerald-600 disabled:opacity-40 disabled:cursor-not-allowed font-semibold text-sm"
          >
            Bill of Materials (DXF)
          </button>
          <button
            onClick={handleExportBomSheetPdf}
            disabled={!design || bomPdfBusy}
            title="Bill-of-materials schedule sheet: major equipment + cable / terminations / conduit / civil / grounding rollups — same line items as the Full BOM CSV"
            className="py-2.5 rounded bg-emerald-800 hover:bg-emerald-700 disabled:opacity-40 disabled:cursor-not-allowed font-semibold text-sm"
          >
            {bomPdfBusy ? 'Rendering…' : 'Bill of Materials (PDF)'}
          </button>
        </div>
        <details className="mt-2 rounded border border-slate-700 bg-slate-800/40">
          <summary
            className="px-2 py-1.5 text-xs font-semibold text-slate-300 cursor-pointer select-none"
            title="Project-specific values for the LGIA data sheet. Anything left blank stays explicitly marked as a placeholder on the exported sheet."
          >
            LGIA data sheet inputs (transformer %Z, ride-through, certification)
          </summary>
          <div className="px-2 pb-2 space-y-2">
            <div className="grid grid-cols-2 gap-2">
              <label className="text-xs text-slate-400 block">
                PCS step-up %Z
                <input
                  key={`pcsz-${lgiaInputs.pcsXfmrZPct ?? ''}`}
                  type="number"
                  min={0.5}
                  max={20}
                  step={0.01}
                  defaultValue={lgiaInputs.pcsXfmrZPct ?? ''}
                  onBlur={e => setLgiaInputs({ pcsXfmrZPct: e.target.value === '' ? null : Number(e.target.value) })}
                  placeholder="e.g. 6.5"
                  title="Nameplate impedance of the PCS integrated MV step-up transformer, in percent (0.5–20). Blank = placeholder on the sheet."
                  className="w-full mt-1 bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-sm text-slate-100 placeholder:text-slate-500"
                />
              </label>
              <label className="text-xs text-slate-400 block">
                Aux transformer %Z
                <input
                  key={`auxz-${lgiaInputs.auxXfmrZPct ?? ''}`}
                  type="number"
                  min={0.5}
                  max={20}
                  step={0.01}
                  defaultValue={lgiaInputs.auxXfmrZPct ?? ''}
                  onBlur={e => setLgiaInputs({ auxXfmrZPct: e.target.value === '' ? null : Number(e.target.value) })}
                  placeholder="e.g. 5.75"
                  title="Nameplate impedance of the auxiliary transformer, in percent (0.5–20). Blank = placeholder on the sheet."
                  className="w-full mt-1 bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-sm text-slate-100 placeholder:text-slate-500"
                />
              </label>
            </div>
            <label className="text-xs text-slate-400 block">
              IEEE 2800 ride-through settings
              <input
                key={`rt-${lgiaInputs.rideThroughDetail}`}
                type="text"
                defaultValue={lgiaInputs.rideThroughDetail}
                onBlur={e => setLgiaInputs({ rideThroughDetail: e.target.value })}
                placeholder="e.g. Category III; zero-voltage ride-through 0.16 s"
                title="Project ride-through settings/category appended to the IEEE 2800 statement. Blank = placeholder on the sheet."
                className="w-full mt-1 bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-sm text-slate-100 placeholder:text-slate-500"
              />
            </label>
            <label className="text-xs text-slate-400 block">
              UL 1741 SB certificate details
              <input
                key={`cert-${lgiaInputs.certificationDetail}`}
                type="text"
                defaultValue={lgiaInputs.certificationDetail}
                onBlur={e => setLgiaInputs({ certificationDetail: e.target.value })}
                placeholder="e.g. CSA listing, file no. 123456"
                title="Listing agency / certificate file number for the inverter UL 1741 SB certification. Blank = placeholder on the sheet."
                className="w-full mt-1 bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-sm text-slate-100 placeholder:text-slate-500"
              />
            </label>
            <div className="text-[11px] text-slate-500">
              Saved with the project file. Blank fields stay explicitly marked as placeholders on the exported data sheet.
            </div>
          </div>
        </details>
        <button
          onClick={handleExportLgia}
          disabled={!design || lgiaBusy}
          title="LGIA Appendix-style facility technical data sheet — placeholder fields clearly marked for project-specific input"
          className="w-full mt-2 py-2.5 rounded bg-emerald-900 hover:bg-emerald-800 disabled:opacity-40 disabled:cursor-not-allowed font-semibold text-sm"
        >
          {lgiaBusy ? 'Building data sheet…' : 'Export LGIA Data Sheet (PDF)'}
        </button>
        <button
          onClick={handleExportPermit}
          disabled={!design || permitBusy}
          className="w-full mt-2 py-2.5 rounded bg-emerald-700 hover:bg-emerald-600 disabled:opacity-40 disabled:cursor-not-allowed font-semibold text-sm"
        >
          {permitBusy ? 'Building packet…' : 'Export Permit Packet (PDF)'}
        </button>
        <button
          onClick={handleExportPoi}
          disabled={!design || poiBusy}
          className="w-full mt-2 py-2.5 rounded bg-emerald-800 hover:bg-emerald-700 disabled:opacity-40 disabled:cursor-not-allowed font-semibold text-sm"
        >
          {poiBusy ? 'Building data sheet…' : 'Export POI Data Sheet (PDF)'}
        </button>
        <button
          onClick={handleExportBom}
          disabled={!design}
          className="w-full mt-2 py-2.5 rounded bg-slate-700 hover:bg-slate-600 disabled:opacity-40 disabled:cursor-not-allowed font-semibold text-sm"
        >
          Export BOM (CSV)
        </button>
        <div className="grid grid-cols-2 gap-2 mt-2">
          <button
            onClick={handleExportCableScheduleDxf}
            disabled={!design}
            className="py-2.5 rounded bg-teal-800 hover:bg-teal-700 disabled:opacity-40 disabled:cursor-not-allowed font-semibold text-sm"
          >
            Cable Schedule (DXF)
          </button>
          <button
            onClick={handleExportCableScheduleCsv}
            disabled={!design}
            className="py-2.5 rounded bg-teal-900 hover:bg-teal-800 disabled:opacity-40 disabled:cursor-not-allowed font-semibold text-sm"
          >
            Cable Schedule (CSV)
          </button>
        </div>
        <button
          onClick={handleExportFullBom}
          disabled={!design}
          className="w-full mt-2 py-2.5 rounded bg-slate-600 hover:bg-slate-500 disabled:opacity-40 disabled:cursor-not-allowed font-semibold text-sm"
        >
          Export Full BOM w/ Cable Rollup (CSV)
        </button>
        {bomRollupSummary && (
          <div className="mt-2 bg-slate-800/60 rounded p-2 text-[11px] text-slate-300 space-y-0.5">
            <div className="font-semibold text-slate-200 text-xs">BOM Rollup (incl. slack)</div>
            {bomRollupSummary.map((l, i) => (
              <div key={i} className="flex justify-between gap-2">
                <span className="truncate">{l.label}</span>
                <span className="text-slate-400 whitespace-nowrap">{l.value}</span>
              </div>
            ))}
          </div>
        )}
        <OfflineDataPanel boundary={boundary} />
        <input
          ref={projectFileRef}
          type="file"
          accept=".json,application/json"
          className="hidden"
          onChange={e => handleOpenProject(e.target.files?.[0])}
        />
        <div className="grid grid-cols-2 gap-2 mt-2">
          <button
            onClick={handleSaveProject}
            disabled={!boundary}
            className="py-2 rounded bg-slate-700 hover:bg-slate-600 disabled:opacity-40 disabled:cursor-not-allowed text-xs font-semibold"
          >
            Save Project (.bessforge.json)
          </button>
          <button
            onClick={() => projectFileRef.current?.click()}
            className="py-2 rounded bg-slate-700 hover:bg-slate-600 text-xs font-semibold"
          >
            Open Project
          </button>
        </div>
        <div className="text-[10px] text-slate-500 mt-2 text-center">
          Clean 2D plan — rectangles match layout 1:1, units in feet
        </div>
      </div>
    </div>
  );
}
