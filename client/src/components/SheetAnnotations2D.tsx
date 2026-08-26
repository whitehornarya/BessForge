// CAD-sheet-style annotation panel shown in 2D plan view, mirroring the
// DXF sheet frame: Site Information, Equipment Dimensions, BOM, Legend,
// Key Notes, disclaimer and the BESSForge title block.
import { useDesignStore } from '../lib/stores/useDesignStore';
import { buildBomRows } from '../lib/nextera/bom';
import { assetUrl } from '../lib/assetUrl';
import { getEffectiveConfiguration, LG_JF2, HITACHI_AUX_XFMR, AUX_SWITCHBOARD_SPEC, CLEARANCES } from '../lib/nextera/catalog';
import { MAX_INVERTERS_PER_FEEDER, VD_LIMIT_PCT } from '../lib/nextera/feeders';
import { feederDisplayName } from '../lib/nextera/feederNaming';
import { DEFAULT_PRELIM_REV } from '../lib/nextera/revisionScheme';
import { pickScale } from '../lib/nextera/plotScale';

function ftIn(ft: number): string {
  const whole = Math.floor(ft);
  const inches = (ft - whole) * 12;
  const inStr = Math.abs(inches - Math.round(inches)) < 0.05
    ? String(Math.round(inches))
    : inches.toFixed(1);
  return `${whole}'-${inStr}"`;
}

function Box({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border border-black mb-1.5">
      <div className="border-b border-black text-center font-bold px-1 py-0.5">{title}</div>
      <div className="px-1.5 py-1 space-y-0.5">{children}</div>
    </div>
  );
}

function LegendSwatch({ kind }: { kind: string }) {
  const base = 'inline-block w-8 h-2.5 mr-1.5 align-middle shrink-0';
  switch (kind) {
    case 'fence': return <span className={base} style={{ borderTop: '2px solid #06b6d4', height: 2, marginTop: 5 }} />;
    case 'lot': return <span className={base} style={{ borderTop: '2px dashed #d946ef', height: 2, marginTop: 5 }} />;
    case 'feeder': return <span className={base} style={{ borderTop: '2px solid #e91e63', height: 2, marginTop: 5 }} />;
    case 'bess': return <span className={`${base} border-2 border-red-600`} />;
    case 'inv': return <span className={`${base} border border-red-600`} style={{ width: 20 }} />;
    case 'road': return <span className={`${base} bg-gray-400`} />;
    case 'gate': return <span className={base} style={{ borderTop: '3px double #06b6d4', height: 4, marginTop: 4 }} />;
    case 'dc': return <span className={base} style={{ borderTop: '2px solid #16a34a', height: 2, marginTop: 5 }} />;
    case 'mv': return <span className={base} style={{ borderTop: '2px solid #06b6d4', height: 2, marginTop: 5 }} />;
    case 'lvac': return <span className={base} style={{ borderTop: '2px solid #1f3fbf', height: 2, marginTop: 5 }} />;
    case 'fiber': return <span className={base} style={{ borderTop: '2px solid #f97316', height: 2, marginTop: 5 }} />;
    case 'trench': return <span className={`${base}`} style={{ background: 'rgba(31,63,191,0.3)', border: '1px solid #1f3fbf' }} />;
    case 'auxpanel': return <span className={`${base}`} style={{ background: '#1f3fbf', width: 20 }} />;
    case 'fpp': return <span className={`${base}`} style={{ background: '#f97316', width: 12 }} />;
    case 'fcp': return <span className={`${base}`} style={{ background: '#ea580c', width: 16 }} />;
    case 'fjb': return <span className={`${base}`} style={{ background: '#8e44ad', width: 16 }} />;
    case 'comms': return <span className={`${base}`} style={{ background: '#2980b9', width: 12 }} />;
    case 'door': return <span className={`${base} border border-gray-500`} style={{ background: '#f1f5f9', width: 20 }} />;
    case 'epanel': return <span className={`${base} text-center font-bold`} style={{ width: 20, height: 'auto', lineHeight: '10px' }}>A/C</span>;
    default: return null;
  }
}

export default function SheetAnnotations2D() {
  const design = useDesignStore(s => s.design);
  const boundary = useDesignStore(s => s.boundary);
  const configId = useDesignStore(s => s.configId);
  const containersPerPcs = useDesignStore(s => s.containersPerPcs);
  const titleBlock = useDesignStore(s => s.titleBlock);
  const feeders = useDesignStore(s => s.feeders);
  if (!design || !boundary) return null;
  const config = getEffectiveConfiguration(configId, containersPerPcs);
  const projName = titleBlock.projectName.trim() || boundary.name;

  // Plotted-scale readout derived from the site extents via the same
  // pickScale ladder the exports use (never a hardcoded ratio).
  const bxs = design.boundary.polygon.map(p => p.x);
  const bys = design.boundary.polygon.map(p => p.y);
  const sheetScaleFt = pickScale(Math.max(...bxs) - Math.min(...bxs), Math.max(...bys) - Math.min(...bys));

  const nFjb = design.equipment.filter(e => e.kind === 'feederJunctionBox').length;
  const nComms = design.equipment.filter(e => e.kind === 'commsCabinet').length;
  const inv = config.inverterDims;

  return (
    <div className="absolute top-14 right-3 bottom-3 w-72 overflow-y-auto bg-white text-black text-[10px] leading-tight font-mono border-2 border-black p-1.5 shadow-lg select-text">
      <Box title="Site Information">
        <div><b>Nameplate Size:</b> {design.targetMW.toFixed(0)}MW x {config.durationHrs}hr ({design.targetMWh.toFixed(0)}MWh)</div>
        <div><b>Achieved:</b> {design.achievedMW.toFixed(1)} MW / {design.achievedMWh.toFixed(1)} MWh</div>
        <div><b>PCS Blocks:</b> {design.blocksPlaced}</div>
        <div><b>Site Area:</b> {design.boundary.areaAcres.toFixed(1)} AC</div>
        <div><b>Site:</b> {projName}</div>
        {titleBlock.location.trim() && <div><b>Location:</b> {titleBlock.location}</div>}
        <div><b>Config:</b> {config.label}</div>
      </Box>

      <Box title="Equipment Dimensions">
        <div><b>PCS - {config.inverterModel} [L x W x H]</b><br />{ftIn(inv.length)} x {ftIn(inv.width)} x {ftIn(inv.height)}</div>
        <div><b>BATTERY CONTAINER - LG JF2 DC LINK 5.1 [L x W x H]</b><br />{ftIn(LG_JF2.length)} x {ftIn(LG_JF2.width)} x {ftIn(LG_JF2.height)}</div>
        {config.hasAuxEquipment && (
          <>
            <div><b>Aux Transformer - Hitachi [L x W x H]</b><br />{ftIn(HITACHI_AUX_XFMR.length)} x {ftIn(HITACHI_AUX_XFMR.width)} x {ftIn(HITACHI_AUX_XFMR.height)}</div>
            <div><b>{AUX_SWITCHBOARD_SPEC.item} - {AUX_SWITCHBOARD_SPEC.manufacturer} [L x W x H]</b><br />{ftIn(AUX_SWITCHBOARD_SPEC.dims.length)} x {ftIn(AUX_SWITCHBOARD_SPEC.dims.width)} x {ftIn(AUX_SWITCHBOARD_SPEC.dims.height)}</div>
          </>
        )}
      </Box>

      <Box title="Bill of Materials">
        {/* Rows come VERBATIM from buildBomRows — the same builder the CSV,
            DXF BOM panel, BOM sheet, and permit packet use — so this panel
            always carries the real part numbers (LG EPNLTF_1200A/C,
            PE FP4200M1, Hitachi / Lakeshore Electric) in sync. */}
        {buildBomRows(design, config).map((r, i) => (
          <div key={i}>{r.qty}{r.unit === 'EA' ? '' : ` ${r.unit}`} — {r.description}</div>
        ))}
        {feeders.map(f => (
          <div key={f.idx}>
            {Math.ceil(f.totalLengthFt)} LF — MV Feeder #{feederDisplayName(f)} ({f.size} kcmil {f.material}, VD {f.vdPct.toFixed(2)}%)
          </div>
        ))}
      </Box>

      <Box title="Legend">
        <div className="flex items-center"><LegendSwatch kind="fence" />Fence</div>
        <div className="flex items-center"><LegendSwatch kind="lot" />Project Boundary</div>
        <div className="flex items-center"><LegendSwatch kind="bess" />Battery Container</div>
        <div className="flex items-center"><LegendSwatch kind="inv" />PCS</div>
        <div className="flex items-center"><LegendSwatch kind="road" />Drive Path</div>
        <div className="flex items-center"><LegendSwatch kind="gate" />Gate</div>
        <div className="flex items-center"><LegendSwatch kind="dc" />DC Cable</div>
        <div className="flex items-center"><LegendSwatch kind="mv" />MV Cable</div>
        <div className="flex items-center"><LegendSwatch kind="lvac" />LVAC Cable</div>
        <div className="flex items-center"><LegendSwatch kind="fiber" />Fiber Optic Cable</div>
        <div className="flex items-center"><LegendSwatch kind="trench" />480V Aux &amp; Fiber Trench</div>
        {feeders.length > 0 && <div className="flex items-center"><LegendSwatch kind="feeder" />MV Feeder (34.5kV) / Substation</div>}
        <div className="flex items-center"><LegendSwatch kind="auxpanel" />Auxiliary Switch Panel</div>
        <div className="flex items-center"><LegendSwatch kind="fpp" />Fiber Patch Panel</div>
        <div className="flex items-center"><LegendSwatch kind="fcp" />Fire Control Panel</div>
        {nFjb > 0 && <div className="flex items-center"><LegendSwatch kind="fjb" />Feeder Junction Box (FJB-nnA/B = split-side island pair)</div>}
        {nComms > 0 && <div className="flex items-center"><LegendSwatch kind="comms" />Communications Cabinet</div>}
        <div className="flex items-center"><LegendSwatch kind="door" />White Stripe = Door / Compartment End Wall</div>
        <div className="flex items-center"><LegendSwatch kind="epanel" />(A) = E-Panel Left Side, (C) = E-Panel Right Side</div>
      </Box>

      <Box title="Key Notes">
        <div>1. 58' inner turning radius for all drive paths inside the BESS yard.</div>
        <div>2. {CLEARANCES.roadWidth}' wide drive paths throughout the BESS yard.</div>
        <div>3. 20' outer turning radius for all drive paths inside the BESS yard.</div>
        <div>4. 8'-0 3/4" min distance to drive path edge for equipment.</div>
        <div>5. Battery containers 100'-0" min from project boundary per NFPA 855 ("remote location"); other equipment may be within 100'-0".</div>
        <div>6. PCS clearance: 14'-0" for ambient &gt;40°C; 10'-0" for &lt;40°C.</div>
        {feeders.length > 0 && (
          <div>
            7. MV collection: {feeders.length} feeder{feeders.length > 1 ? 's' : ''} at 34.5kV routed to substation; max {MAX_INVERTERS_PER_FEEDER} PCS units per feeder.
            Conductors: {Array.from(new Set(feeders.map(f => `${f.size} kcmil ${f.material}`))).join(', ')}.
            Voltage drop max {Math.max(...feeders.map(f => f.vdPct)).toFixed(2)}% (limit {VD_LIMIT_PCT}%) per NEC Ch.9 Table 8 DC resistance, unity pf.
          </div>
        )}
      </Box>

      <div className="text-red-600 font-bold mb-1.5">
        These layouts are for diagrammatic purposes only - they are provided to convey concepts and are NOT intended to be a complete design. This layout does not include other potential required features such as drainage, water retention, laydown, PGD Connex boxes, etc. The BESS EOR is responsible for providing a detailed design that is reviewed and approved by the Owner.
      </div>

      <div className="border-2 border-black">
        <div className="flex border-b border-black">
          <div className="w-1/3 border-r border-black flex flex-col items-center justify-center py-1">
            <img src={assetUrl('/eci-logo.svg')} alt="ECI" className="h-8 w-auto max-w-full object-contain" />
          </div>
          <div className="flex-1 px-1.5 py-1">
            <div className="font-bold">{config.label.replace(/\s*\(.*\)$/, '')}</div>
            <div>
              {projName} — BESS 10% Site Design
              {titleBlock.location.trim() && <><br />{titleBlock.location}</>}
            </div>
          </div>
        </div>
        <div className="flex border-b border-black text-[9px]">
          <div className="w-1/3 border-r border-black px-1.5 py-0.5">
            REV: {(titleBlock.revision.trim() || DEFAULT_PRELIM_REV).toUpperCase()}<br />
            {titleBlock.date.trim() || new Date().toLocaleDateString()}
            {titleBlock.drafter.trim() && <><br />Drawn: {titleBlock.drafter.toUpperCase()}</>}
          </div>
          <div className="flex-1 px-1.5 py-0.5">Scale: 1&quot; = {sheetScaleFt}&apos; (units: feet)<br />Per NextEra Site Plan Guidance R2</div>
        </div>
        <div className="flex">
          <div className="w-1/3 border-r border-black px-1.5 py-1 font-bold text-center">SHEET 1</div>
          <div className="flex-1 px-1.5 py-1">10% BESS Layout</div>
        </div>
      </div>
    </div>
  );
}
