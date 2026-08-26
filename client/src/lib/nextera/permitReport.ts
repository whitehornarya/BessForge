// Permitting packet report model: one typed structure gathering everything a
// county submittal packet needs — NFPA 855 setback compliance, fire-apparatus
// access verification, reserved-area disclosures, equipment schedule, and a
// verbatim warnings/exceptions appendix.
//
// SINGLE SOURCE OF TRUTH: every row is derived from the same modules the DXF
// drawing and the in-app compliance panel use (buildComplianceReport,
// validateDesign, buildBomRows) — nothing is recomputed here except the
// fence-to-lot-line distance, which no other module measures.
// Pure function of the design + session state; deterministic given `now`.
import { SiteDesign, Pt } from './types';
import { distanceToPolygonEdge, pointInPolygon } from './kmz';
import {
  BessConfiguration, CLEARANCES,
  TRENCH_SECTIONS, TRENCH_CROSSING_REFERENCE, TrenchSectionSpec,
} from './catalog';
import {
  buildComplianceReport,
  buildSiteComplianceReport,
  ComplianceReport,
  ComplianceFinding,
  FindingStatus,
} from './complianceReport';
import { validateDesign, ValidationReport } from './validateDesign';
import { buildBomRows, buildSiteBom, BomRow } from './bom';
import { FeederCircuit } from './feeders';
import { CutFillEstimate, SteepZoneReport, ContourSet } from './terrain';
import { GroundingPlan } from './grounding';
import { Ieee80Study } from './ieee80';
import { TitleBlockInfo } from '../stores/useDesignStore';

export interface PermitTableRow {
  item: string;         // human row label
  requirement: string;  // required value text (verbatim from the compliance rule)
  measured: string;     // measured value text (verbatim from the compliance rule)
  status: FindingStatus;
  reference: string;    // governing standard / guidance reference
}

// One typical trench cross-section row for the packet's trench detail table:
// the catalog section spec plus whether the section's governing runs exist in
// this design (verbatim presence text so the packet can never drift).
export interface TrenchSectionRow {
  spec: TrenchSectionSpec;
  inDesign: string; // e.g. "12 MV feeder runs" | "not used in this design"
}

export interface PermitException {
  source: string;       // 'Layout engine' | 'Design validation' | 'Compliance checklist'
  severity: 'WARN' | 'FAIL';
  text: string;         // verbatim message
}

// Screening-grade rough-grading (cut/fill) summary carried into the packet
// when elevation data is loaded. All numbers come verbatim from the same
// terrain analysis the control-panel card shows (computeCutFill /
// findSteepZones) — nothing is recomputed here. SCREENING ONLY — never for
// construction; terrain never touches layout or export geometry.
export interface PermitEarthwork {
  cutFill: CutFillEstimate;
  steep: SteepZoneReport | null;   // steep-zone screening vs maxGradePct
  source: string;                  // e.g. "USGS 3DEP (1/3 arc-second)"
  resolutionM: number;
  noDataCount: number;             // no-data cells filled (disclosure)
  // Grading tie-in at the pad edge (fence line): deepest cut / tallest fill
  // where the graded pad meets natural ground, from computeGradingTieIn —
  // the same numbers the 3D grading-limits overlay is built from. Optional
  // so older callers / saved models render unchanged.
  tieIn?: {
    maxCutFt: number;    // deepest cut at the fence line (0 = none)
    maxFillFt: number;   // tallest fill at the fence line (0 = none)
    slopeRatio: number;  // daylight slope, horizontal : vertical (e.g. 3 = 3:1)
  } | null;
  // Existing-grade contour map for the earthwork figure — the exact same
  // contoursForDxf output the DXF reference layer uses (deterministic, pure).
  // Optional so older callers / saved models render unchanged.
  contours?: ContourSet | null;
}

export interface PermitPacketModel {
  generatedAt: string;
  project: ComplianceReport['project'];
  site: {
    parcelAreaAcres: number;
    originLat: number;
    originLon: number;
    locationText: string;
    fenceVertices: number;
    containerCount: number;
    inverterCount: number;
    auxTransformerCount: number;
    auxSwitchgearCount: number;
    gateWidthFt: number | null;
    roadSegmentCount: number;
    surfacing: { mode: string; areaAcres: number; tons: number; depthIn: number } | null;
  };
  nfpaSetbacks: PermitTableRow[];
  fireAccess: PermitTableRow[];
  reservedAreas: PermitTableRow[];
  equipmentSchedule: BomRow[];
  // Typical trench cross-sections per the issued trench detail sheets
  // (CAR-D-B006-1/2): catalog section dimensions + whether each section's
  // governing runs exist in this design. Screening-grade detail table.
  trenchSections: TrenchSectionRow[];
  earthwork: PermitEarthwork | null; // null = no elevation data loaded (section omitted)
  // Grounding screening takeoff (opt-in, same plan the 3D preview and the
  // opt-in DXF layer draw). null = omitted — packet stays byte-identical.
  grounding: GroundingPlan | null;
  // IEEE-80 grounding study (opt-in, requires the grounding plan). null =
  // omitted — packet stays byte-identical when the study is not enabled.
  ieee80: Ieee80Study | null;
  validation: ValidationReport;
  compliance: { passCount: number; warnCount: number; failCount: number; total: number };
  exceptions: PermitException[];
  // Multi-area sites only. Absent on a single-area project, which keeps the
  // packet model, sections and PDF byte-identical.
  siteAreas?: PermitSiteSummary;
}

// Per-area roll-up carried by a whole-site packet, so a reviewer can see which
// yard each number came from and which yards were NOT covered.
export interface PermitSiteSummary {
  areaCount: number;
  // Areas with no generated layout: their rows could not be produced at all.
  // Disclosed rather than omitted — a packet that quietly dropped a phase
  // would read as a complete submittal for a partially designed site.
  uncheckedAreas: string[];
  perArea: {
    id: string;
    name: string;
    kind: string;
    generated: boolean;
    acres: number;
    achievedMW: number;
    achievedMWh: number;
    blocksPlaced: number;
    containerCount: number;
    inverterCount: number;
    passCount: number;
    warnCount: number;
    failCount: number;
  }[];
  // Areas that retained access roads but could not reach the requested
  // capacity within the available footprint. Empty on fully compliant sites.
  // Always present so callers can test `capacityShortfalls.length > 0`
  // without a null check.
  capacityShortfalls: {
    id: string;
    name: string;
    requestedMW: number;
    requestedMWh: number;
    achievedMW: number;
    achievedMWh: number;
    // Verbatim warning text from the layout engine.
    reason: string;
  }[];
}

export interface PermitSiteArea {
  id: string;
  name: string;
  kind: string;
  design: SiteDesign | null;
  // Strictly THIS area's own inputs. An area that tracks none is scored
  // without them; the caller must never substitute another area's.
  feeders?: FeederCircuit[];
  substation?: Pt | null;
  areaZones?: import('./areaZones').AreaZone[] | null;
}

export interface PermitPacketOptions {
  hotClimate?: boolean;
  titleBlock?: TitleBlockInfo;
  feeders?: FeederCircuit[];
  substation?: Pt | null;
  earthwork?: PermitEarthwork | null; // screening-grade grading summary (optional)
  grounding?: GroundingPlan | null;   // grounding screening takeoff (opt-in)
  ieee80?: Ieee80Study | null;        // IEEE-80 grid study (opt-in)
  // Drafter-drawn area zones (exclusion-area audit rides through to the
  // compliance findings and pre-export checks).
  areaZones?: import('./areaZones').AreaZone[] | null;
  // Civil-scope-only area (a substation yard): BESS block-composition rules
  // report as not applicable rather than FAILing for having no blocks.
  civilOnly?: boolean;
  now?: Date; // injectable for deterministic tests
}

const ft2 = (v: number) => `${v.toFixed(2)} ft`;

// Min distance from the fence polygon (vertices + edge midpoints) to the
// parcel lot line. The fence is constructed inside the parcel, so signed
// distance is positive when inside.
export function fenceToLotLineFt(fence: Pt[], lotLine: Pt[]): number | null {
  if (fence.length < 3 || lotLine.length < 3) return null;
  let min = Infinity;
  for (let i = 0; i < fence.length; i++) {
    const a = fence[i];
    const b = fence[(i + 1) % fence.length];
    for (const p of [a, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }]) {
      const d = pointInPolygon(p, lotLine)
        ? distanceToPolygonEdge(p, lotLine)
        : -distanceToPolygonEdge(p, lotLine);
      if (d < min) min = d;
    }
  }
  return Number.isFinite(min) ? min : null;
}

// Pull a compliance finding by ruleId into a permit table row (verbatim
// required/measured text so packet numbers can never drift from the panel).
function rowFrom(findings: ComplianceFinding[], ruleId: string, item: string, reference: string): PermitTableRow {
  const f = findings.find(x => x.ruleId === ruleId);
  if (!f) {
    // Defensive: a compliance rule rename must never silently drop a permit
    // row — surface it loudly as a WARN so the drafter sees the gap.
    return {
      item,
      requirement: 'see compliance checklist',
      measured: `compliance rule "${ruleId}" not found — report may be out of date`,
      status: 'WARN',
      reference,
    };
  }
  return { item, requirement: f.required, measured: f.measured, status: f.status, reference };
}

// Typical trench sections table rows: catalog specs (CAR-D-B006-1) with a
// presence note derived from the design's routed runs / trench bands.
export function buildTrenchSectionRows(design: SiteDesign, feeders?: FeederCircuit[]): TrenchSectionRow[] {
  const mvRuns = design.cables.filter(c => c.class === 'MV' && !c.ref).length;
  const dcRuns = design.cables.filter(c => c.class === 'DC' && !c.ref).length;
  const auxBands = (design.trench ? 1 : 0) + (design.corridorTrenches?.length ?? 0);
  const feederCount = feeders?.length ?? 0;
  const none = 'not used in this design';
  return [
    {
      spec: TRENCH_SECTIONS.MVAC_DIRECT_BURY,
      inDesign: feederCount > 0 || mvRuns > 0
        ? `${feederCount > 0 ? `${feederCount} MV feeder circuit(s), ` : ''}${mvRuns} MV run(s)`
        : none,
    },
    {
      spec: TRENCH_SECTIONS.MVAC_DUCT,
      inDesign: 'road crossings per plan (duct option; see ' + TRENCH_CROSSING_REFERENCE + ')',
    },
    {
      spec: TRENCH_SECTIONS.AUX_FIBER,
      inDesign: auxBands > 0 ? `${auxBands} aux & fiber trench band(s)` : none,
    },
    {
      spec: TRENCH_SECTIONS.DC_DUCT_BANK,
      inDesign: dcRuns > 0 ? `${dcRuns} DC container-to-PCS run(s)` : none,
    },
  ];
}

export function buildPermitPacketModel(
  design: SiteDesign,
  config: BessConfiguration,
  opts: PermitPacketOptions = {}
): PermitPacketModel {
  const compliance = buildComplianceReport(design, config, opts);
  const validation = validateDesign(design, {
    titleBlock: opts.titleBlock,
    feeders: opts.feeders,
    substation: opts.substation,
    areaZones: opts.areaZones,
  });
  const f = compliance.findings;

  // --- NFPA 855 / clearance setback table -------------------------------
  const nfpaSetbacks: PermitTableRow[] = [];
  const pushRow = (r: PermitTableRow | null) => { if (r) nfpaSetbacks.push(r); };
  pushRow(rowFrom(f, 'kn6-nfpa855', 'BESS container to lot line', 'NFPA 855 (guidance key note 6)'));
  {
    const d = fenceToLotLineFt(design.fence, design.boundary.polygon);
    // A fence drawn ON the property line measures 0 ft here. That is a
    // deliberate engineering selection, not a near-miss on the typical
    // setback, so say which one the reviewer is looking at — but keep it a
    // WARN either way: this tool does not certify that a parcel may be
    // fenced on its boundary, the EOR/civil design does.
    const onPropertyLine = d !== null && Math.abs(d) <= 0.05;
    nfpaSetbacks.push({
      item: 'Security fence to lot line',
      requirement: `>= ${ft2(CLEARANCES.fenceToLotLine)} (typ.)`,
      measured: d === null
        ? 'fence or lot line missing'
        : onPropertyLine
          ? 'fence drawn ON the property line (0 ft setback) — confirm the parcel permits a boundary fence'
          : `min distance ${ft2(d)}`,
      status: d === null ? (design.fence.length >= 3 ? 'WARN' : 'FAIL') : d >= CLEARANCES.fenceToLotLine - 0.05 ? 'PASS' : 'WARN',
      reference: 'Site standard (typical fence setback)',
    });
  }
  pushRow(rowFrom(f, 'front-fence', 'Container front wall to fence', 'LG Civil Design Guide'));
  pushRow(rowFrom(f, 'side-fence', 'Container side wall to fence', 'LG Civil Design Guide'));
  pushRow(rowFrom(f, 'front-front', 'Container front-to-front separation', 'LG Civil Design Guide'));
  pushRow(rowFrom(f, 'rear-rear', 'Container rear-to-rear separation', 'LG Civil Design Guide'));
  pushRow(rowFrom(f, 'side-side', 'Container side-to-side separation', 'LG Civil Design Guide'));
  pushRow(rowFrom(f, 'pcs-clearance', 'Container to PCS clearance', 'PCS manufacturer guidance'));

  // --- Fire apparatus access table --------------------------------------
  const fireAccess: PermitTableRow[] = [];
  const pushFire = (r: PermitTableRow | null) => { if (r) fireAccess.push(r); };
  pushFire(rowFrom(f, 'kn3-road-width', 'Access road width', 'Guidance sheet 10, key note 3'));
  pushFire(rowFrom(f, 'kn2-inner-radius', 'Inner turning radius', 'Guidance sheet 10, key note 2'));
  pushFire(rowFrom(f, 'kn4-outer-radius', 'Outer turning radius', 'Guidance sheet 10, key note 4'));
  pushFire(rowFrom(f, 'kn5-road-edge', 'Equipment distance to road edge', 'Guidance sheet 10, key note 5'));
  pushFire(rowFrom(f, 'connected-network', 'Connected road network', 'Guidance sheet 10'));
  fireAccess.push({
    item: 'Site access gate',
    requirement: 'Gated entrance connected to the access road',
    measured: design.gate
      ? `${design.gate.width.toFixed(0)} ft wide gate${design.roads.length ? ' with entrance road' : ' — no entrance road segment'}`
      : 'no gate placed',
    status: design.gate ? (design.roads.length ? 'PASS' : 'WARN') : 'WARN',
    reference: 'Site standard',
  });

  // --- Reserved-area disclosures -----------------------------------------
  const reservedAreas: PermitTableRow[] = [];
  const rs = design.reserveSummary;
  if (rs) {
    if (rs.laydownPct > 0) {
      reservedAreas.push({
        item: 'Construction laydown area',
        requirement: `${rs.laydownPct}% of yard (${(rs.laydownRequestedSqFt / 43560).toFixed(2)} AC requested)`,
        measured: `${(rs.laydownPlacedSqFt / 43560).toFixed(2)} AC reserved`,
        status: rs.laydownPlacedSqFt >= rs.laydownRequestedSqFt - 1 ? 'PASS' : 'WARN',
        reference: 'Project requirement',
      });
    }
    // Island defaults reserve units even at 0% — key off the actual request.
    if (rs.augPct > 0 || rs.augBlocksRequested > 0) {
      reservedAreas.push({
        item: 'Future augmentation reserve',
        requirement: rs.augPct > 0
          ? `${rs.augPct}% future capacity (${rs.augBlocksRequested} block(s))`
          : `${rs.augBlocksRequested} reserved unit(s) (island standard)`,
        measured: `${rs.augBlocksPlaced} block footprint(s) reserved — ${rs.augMW.toFixed(1)} MW / ${rs.augMWh.toFixed(0)} MWh future`,
        status: rs.augBlocksPlaced >= rs.augBlocksRequested ? 'PASS' : 'WARN',
        reference: 'Project requirement',
      });
    }
  }
  for (const z of design.augmentationZones.length ? [design.augmentationZones] : []) {
    reservedAreas.push({
      item: 'Per-block augmentation bays',
      requirement: 'One reserved bay per BESS block',
      measured: `${z.length} augmentation bay(s) reserved (no BOL conduit inside exclusion zones)`,
      status: 'PASS',
      reference: 'Guidance key note 1',
    });
  }
  if (!reservedAreas.length) {
    reservedAreas.push({
      item: 'Reserved areas',
      requirement: 'Disclose all reserved / future-use areas',
      measured: 'no reserved areas in this design',
      status: 'PASS',
      reference: '—',
    });
  }

  // --- Warnings / exceptions appendix (verbatim) --------------------------
  const exceptions: PermitException[] = [];
  for (const w of design.warnings) {
    exceptions.push({ source: 'Layout engine', severity: 'WARN', text: w });
  }
  for (const c of validation.checks) {
    if (c.status === 'pass') continue;
    exceptions.push({
      source: 'Design validation',
      severity: c.status === 'fail' ? 'FAIL' : 'WARN',
      text: `${c.label}: ${c.detail}`,
    });
  }
  for (const fd of f) {
    if (fd.status === 'PASS') continue;
    exceptions.push({
      source: 'Compliance checklist',
      severity: fd.status,
      text: `${fd.checklistItem} — required ${fd.required}; measured ${fd.measured}`,
    });
  }

  const count = (kind: string) => design.equipment.filter(e => e.kind === kind).length;
  return {
    // Fixed UTC format: output must be byte-identical across machines/locales
    generatedAt: (opts.now ?? new Date()).toISOString().replace('T', ' ').slice(0, 16) + ' UTC',
    project: compliance.project,
    site: {
      parcelAreaAcres: design.boundary.areaAcres,
      originLat: design.boundary.origin.lat,
      originLon: design.boundary.origin.lon,
      locationText: opts.titleBlock?.location?.trim() || design.boundary.location || '',
      fenceVertices: design.fence.length,
      containerCount: count('bess'),
      inverterCount: count('inverter'),
      auxTransformerCount: count('auxTransformer'),
      auxSwitchgearCount: count('auxSwitchgear'),
      gateWidthFt: design.gate ? design.gate.width : null,
      roadSegmentCount: design.roads.length + design.aisles.length,
      surfacing: design.surfacing && design.surfacing.areaSqFt > 0
        ? {
            mode: design.surfacing.mode,
            areaAcres: design.surfacing.areaSqFt / 43560,
            tons: Math.ceil(design.surfacing.tons),
            depthIn: design.surfacing.depthIn,
          }
        : null,
    },
    nfpaSetbacks,
    fireAccess,
    reservedAreas,
    equipmentSchedule: buildBomRows(design, config, opts.feeders),
    trenchSections: buildTrenchSectionRows(design, opts.feeders),
    earthwork: opts.earthwork ?? null,
    grounding: opts.grounding ?? null,
    ieee80: opts.ieee80 ?? null,
    validation,
    compliance: {
      passCount: compliance.passCount,
      warnCount: compliance.warnCount,
      failCount: compliance.failCount,
      total: compliance.findings.length,
    },
    exceptions,
  };
}

// ---------------------------------------------------------------------------
// Whole-site permit packet: one submittal covering EVERY area of a multi-area
// project, instead of the selected phase only.
//
// The per-area packet model is reused verbatim (same compliance, validation
// and BOM modules), then the tables are concatenated with each row labeled by
// its area, so nothing here recomputes an engineering number. Site-level rows
// (capacity, block counts, acreage) come from the summed per-area figures.
//
// Areas with no generated layout contribute NO rows, so they are disclosed in
// `siteAreas.uncheckedAreas` and as an exception — a packet that silently
// omitted a phase would read as a complete submittal for a partial design.
export function buildSitePermitPacketModel(
  areas: PermitSiteArea[],
  config: BessConfiguration,
  opts: PermitPacketOptions = {}
): PermitPacketModel {
  const generated = areas.filter(a => a.design);
  if (!generated.length) {
    throw new Error('buildSitePermitPacketModel: no area has a generated layout');
  }

  const perAreaModels = generated.map(a => ({
    area: a,
    model: buildPermitPacketModel(a.design!, config, {
      ...opts,
      // Strictly this area's own inputs. Falling back to `opts` scored every
      // other yard against the ACTIVE yard's feeder routes, substation and
      // exclusion zones — inventing trench quantities, BOM rows and findings
      // for geometry that does not exist in that area.
      feeders: a.feeders,
      substation: a.substation ?? null,
      areaZones: a.areaZones ?? null,
      // A substation is civil scope only: it has no BESS blocks by design, so
      // the block-composition rules must not FAIL it for their absence.
      // Without this the packet's exceptions appendix contradicted its own
      // compliance summary — 0 FAILs up top, a BESS-block FAIL in the back.
      civilOnly: a.kind === 'substation',
      // Terrain/grounding/IEEE-80 are tracked for the ACTIVE area only, so
      // attaching them to every area would repeat one yard's figures under
      // every other yard's heading. They are carried once, at site level.
      earthwork: null, grounding: null, ieee80: null,
    }),
  }));

  // Label a rule row with the area it was measured in. Every table in this
  // packet is a concatenation across areas, so an unlabeled row would be
  // unattributable once two yards report the same rule.
  const tag = (name: string, rows: PermitTableRow[]): PermitTableRow[] =>
    rows.map(r => ({ ...r, item: `${name} — ${r.item}` }));

  const nfpaSetbacks: PermitTableRow[] = [];
  const fireAccess: PermitTableRow[] = [];
  const reservedAreas: PermitTableRow[] = [];
  const exceptions: PermitException[] = [];
  const checks: ValidationReport['checks'] = [];
  for (const { area, model } of perAreaModels) {
    nfpaSetbacks.push(...tag(area.name, model.nfpaSetbacks));
    fireAccess.push(...tag(area.name, model.fireAccess));
    reservedAreas.push(...tag(area.name, model.reservedAreas));
    for (const e of model.exceptions) {
      exceptions.push({ ...e, text: `${area.name}: ${e.text}` });
    }
    for (const c of model.validation.checks) {
      checks.push({ ...c, label: `${area.name} — ${c.label}` });
    }
  }

  // Equipment schedule: the same whole-site BOM the CSV export produces, so
  // the packet and the exported takeoff can never disagree.
  const bom = buildSiteBom(perAreaModels.map(({ area, model }) => ({
    name: area.name, rows: model.equipmentSchedule,
  })));

  // Trench sections are catalog specs (identical rows every area); merge on
  // the spec and combine the per-area "used in design" notes.
  const trenchSections: TrenchSectionRow[] = [];
  for (const { area, model } of perAreaModels) {
    for (const t of model.trenchSections) {
      const cur = trenchSections.find(x => x.spec.title === t.spec.title);
      if (!cur) trenchSections.push({ spec: t.spec, inDesign: `${area.name}: ${t.inDesign}` });
      else cur.inDesign += `; ${area.name}: ${t.inDesign}`;
    }
  }

  const compliance = buildSiteComplianceReport(
    areas.map(a => ({
      id: a.id, name: a.name, kind: a.kind, design: a.design,
      // Every input the per-area models above were built from must be
      // repeated here verbatim. Dropping one (areaZones) let a finding
      // appear in the packet's exceptions appendix while the aggregate
      // compliance totals and coverage-table counts silently omitted it.
      feeders: a.feeders, substation: a.substation, areaZones: a.areaZones,
    })),
    config,
    opts
  );

  const uncheckedAreas = areas.filter(a => !a.design).map(a => a.name);
  for (const name of uncheckedAreas) {
    exceptions.push({
      source: 'Whole-site packet',
      severity: 'WARN',
      text: `${name}: no layout generated — this area is NOT covered by any section of this packet.`,
    });
  }

  // Access-road capacity shortfalls: areas that kept roads but could not reach
  // the requested capacity. Disclosed in the site summary and as exceptions so
  // a reviewer checking only the exceptions appendix never misses them.
  const ACCESS_ROAD_SHORTFALL_MARKER = 'Access-road capacity shortfall:';
  const capacityShortfalls: PermitSiteSummary['capacityShortfalls'] = [];
  for (const a of areas) {
    if (a.kind !== 'bess' || !a.design) continue;
    const reason = a.design.warnings.find(w => w.startsWith(ACCESS_ROAD_SHORTFALL_MARKER));
    if (reason) {
      capacityShortfalls.push({
        id: a.id,
        name: a.name,
        requestedMW: a.design.targetMW,
        requestedMWh: a.design.targetMWh,
        achievedMW: a.design.achievedMW,
        achievedMWh: a.design.achievedMWh,
        reason,
      });
      exceptions.push({
        source: 'Whole-site packet',
        severity: 'WARN',
        text: `${a.name}: access-road capacity shortfall — requested ${a.design.targetMW.toFixed(1)} MW / ${a.design.targetMWh.toFixed(0)} MWh, achieved ${a.design.achievedMW.toFixed(1)} MW / ${a.design.achievedMWh.toFixed(0)} MWh. Recommend increasing the phase footprint or reducing the target.`,
      });
    }
  }

  const sum = (pick: (m: PermitPacketModel) => number) =>
    perAreaModels.reduce((s, { model }) => s + pick(model), 0);
  const byArea = new Map(compliance.site?.perArea.map(p => [p.areaId, p]) ?? []);
  const siteAreas: PermitSiteSummary = {
    areaCount: areas.length,
    uncheckedAreas,
    capacityShortfalls,
    perArea: areas.map(a => {
      const m = perAreaModels.find(x => x.area.id === a.id)?.model;
      const c = byArea.get(a.id);
      return {
        id: a.id,
        name: a.name,
        kind: a.kind,
        generated: !!a.design,
        acres: a.design?.boundary.areaAcres ?? 0,
        achievedMW: a.design?.achievedMW ?? 0,
        achievedMWh: a.design?.achievedMWh ?? 0,
        blocksPlaced: a.design?.blocksPlaced ?? 0,
        containerCount: m?.site.containerCount ?? 0,
        inverterCount: m?.site.inverterCount ?? 0,
        passCount: c?.passCount ?? 0,
        warnCount: c?.warnCount ?? 0,
        failCount: c?.failCount ?? 0,
      };
    }),
  };

  const first = perAreaModels[0].model;
  const warnCount = checks.filter(c => c.status === 'warn').length;
  const failCount = checks.filter(c => c.status === 'fail').length;
  return {
    generatedAt: first.generatedAt,
    // Capacity figures in the header are already site totals (the site
    // compliance report replaces them with the summed values).
    project: compliance.project,
    site: {
      // The "parcel" of a whole-site packet is every area's acreage.
      parcelAreaAcres: siteAreas.perArea.reduce((s, a) => s + a.acres, 0),
      originLat: first.site.originLat,
      originLon: first.site.originLon,
      locationText: first.site.locationText,
      fenceVertices: sum(m => m.site.fenceVertices),
      containerCount: sum(m => m.site.containerCount),
      inverterCount: sum(m => m.site.inverterCount),
      auxTransformerCount: sum(m => m.site.auxTransformerCount),
      auxSwitchgearCount: sum(m => m.site.auxSwitchgearCount),
      // A single gate width is meaningless across yards; each area's gate is
      // reported in its own fire-access rows.
      gateWidthFt: null,
      roadSegmentCount: sum(m => m.site.roadSegmentCount),
      surfacing: perAreaModels.some(({ model }) => model.site.surfacing)
        ? {
            mode: first.site.surfacing?.mode ?? 'full-yard',
            areaAcres: sum(m => m.site.surfacing?.areaAcres ?? 0),
            tons: sum(m => m.site.surfacing?.tons ?? 0),
            depthIn: first.site.surfacing?.depthIn ?? 4,
          }
        : null,
    },
    nfpaSetbacks,
    fireAccess,
    reservedAreas,
    equipmentSchedule: bom.site,
    trenchSections,
    earthwork: opts.earthwork ?? null,
    grounding: opts.grounding ?? null,
    ieee80: opts.ieee80 ?? null,
    validation: {
      checks,
      passCount: checks.filter(c => c.status === 'pass').length,
      warnCount,
      failCount,
      ok: failCount === 0,
    },
    compliance: {
      passCount: compliance.passCount,
      warnCount: compliance.warnCount,
      failCount: compliance.failCount,
      total: compliance.findings.length,
    },
    exceptions,
    siteAreas,
  };
}
