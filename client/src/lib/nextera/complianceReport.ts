// One-click compliance report: scores a generated design against every row
// of the NextEra Site Plan Guidance R2 checklist (docs/nextera-guidance-checklist.md).
// Pure read-only consumer of the design — never mutates layout or export state.
// Each finding carries the exact checklist "Item" text so coverage against the
// doc is testable 1:1.
import { DEFAULT_PRELIM_REV } from './revisionScheme';
import { SiteDesign, Pt, PlacedEquipment } from './types';
import { pointInPolygon, distanceToPolygonEdge } from './kmz';
import {
  BessConfiguration,
  CLEARANCES,
  CONFIGURATIONS,
  REFERENCE_CONFIG_IDS,
  LG_JF2,
  LG_JF2_CONTINUOUS_C_RATE,
  GE_PCS_CAPABILITY_MW,
  PE_FP4200M,
  GE_FLEX_1571,
  HITACHI_AUX_XFMR,
  IPS_SWITCHGEAR,
  EquipmentDims,
} from './catalog';
import { nexteraLabel } from './dxfExport';
import { edgeSegsToRing } from './layoutEngine';
import { FeederCircuit, VD_LIMIT_PCT } from './feeders';
import { AreaZone, exclusionRects, routeCrossesExclusion } from './areaZones';
import { TitleBlockInfo } from '../stores/useDesignStore';

export type FindingStatus = 'PASS' | 'WARN' | 'FAIL';

export interface ComplianceFinding {
  ruleId: string;
  category: string;       // checklist section heading
  checklistItem: string;  // exact "Item" cell from docs/nextera-guidance-checklist.md
  rule: string;           // required-value text from the guidance
  status: FindingStatus;
  required: string;
  measured: string;
  entityIds: string[];    // offending / relevant entity ids (click-to-highlight)
  // Multi-area sites only: which area this finding was measured in. Absent on
  // a single-area project, so its findings/CSV/PDF stay byte-identical.
  areaId?: string;
  areaName?: string;
}

// Whole-site rollup attached to a multi-area compliance report. Absent on a
// single-area project, so its report object stays byte-identical.
export interface ComplianceSiteSummary {
  areaCount: number;
  // Areas with no generated design — their rules could NOT be checked, so a
  // clean report while this is non-zero is incomplete, not a pass.
  uncheckedAreas: string[];
  perArea: {
    areaId: string;
    areaName: string;
    kind: string;
    passCount: number;
    warnCount: number;
    failCount: number;
  }[];
  // Areas that retained access roads but could not reach the requested
  // capacity within the available footprint. Empty on fully compliant sites.
  capacityShortfalls: {
    id: string;
    name: string;
    requestedMW: number;
    requestedMWh: number;
    achievedMW: number;
    achievedMWh: number;
    reason: string;
  }[];
}

export interface ComplianceReport {
  findings: ComplianceFinding[];
  passCount: number;
  warnCount: number;
  failCount: number;
  ok: boolean; // no FAILs
  generatedAt: string;
  // Multi-area sites only (see ComplianceSiteSummary).
  site?: ComplianceSiteSummary;
  project: {
    projectName: string;
    location: string;
    drafter: string;
    revision: string;
    date: string;
    configLabel: string;
    hotClimate: boolean;
    achievedMW: number;
    achievedMWh: number;
    targetMW: number;
    targetMWh: number;
    blocksPlaced: number;
    blocksRequired: number;
  };
}

export interface ComplianceOptions {
  hotClimate?: boolean;
  titleBlock?: TitleBlockInfo;
  feeders?: FeederCircuit[];
  substation?: Pt | null;
  // Drafter-drawn area zones: UNDERGROUND EXCLUSION AREA rects are audited
  // as hard keep-outs for buried routes. Omitted/empty => finding omitted.
  areaZones?: AreaZone[] | null;
  now?: Date; // injectable for deterministic tests
  // Multi-area sites only: stamps every finding with the area it came from.
  // Omitted on a single-area project => findings stay byte-identical.
  area?: { id: string; name: string };
  // Civil-only yard (a substation area): fence, roads, gate and feeder
  // infrastructure, with no BESS equipment BY DESIGN. Block-composition rules
  // would otherwise FAIL such a yard for "no blocks placed", which is the
  // specified state, not a defect. A BESS area that placed no blocks must
  // still FAIL, so this is an explicit input rather than an equipment count.
  civilOnly?: boolean;
}

const CAT_SHEET2 = 'Sheet 2 — LG JF2 equipment & clearances';
const CAT_SHEET34 = 'Sheets 3–4 — Enlarged block layouts';
const CAT_SHEET59 = 'Sheets 5–9 — Reference configurations';
const CAT_SHEET10 = 'Sheet 10 — Access road guidance';
const CAT_DWG = 'Reference DWG drafting conventions';

const ft = (v: number) => `${v.toFixed(2)} ft`;
const TOL = 0.05; // ft measurement tolerance for clearance comparisons

// Axis-aligned half extents of a placed rect (rotations are multiples of 90°).
function halfExtents(e: { rotation: number; length: number; width: number }) {
  const rot = Math.abs(Math.sin(e.rotation)) > 0.5;
  return { hx: (rot ? e.width : e.length) / 2, hy: (rot ? e.length : e.width) / 2 };
}

// Min distance from a rect's perimeter sample points to a polygon's edges.
function rectMinEdgeDist(e: PlacedEquipment, poly: Pt[]): number {
  const { hx, hy } = halfExtents(e);
  const pts: Pt[] = [
    { x: e.x - hx, y: e.y - hy }, { x: e.x + hx, y: e.y - hy },
    { x: e.x + hx, y: e.y + hy }, { x: e.x - hx, y: e.y + hy },
    { x: e.x, y: e.y - hy }, { x: e.x, y: e.y + hy },
    { x: e.x - hx, y: e.y }, { x: e.x + hx, y: e.y },
  ];
  return Math.min(...pts.map(p => (pointInPolygon(p, poly) ? distanceToPolygonEdge(p, poly) : -distanceToPolygonEdge(p, poly))));
}

// Gap between two axis-aligned rects: positive = clear separation along the
// dominant axis, negative = overlap.
function aabbGap(
  a: { x: number; y: number; hx: number; hy: number },
  b: { x: number; y: number; hx: number; hy: number }
) {
  const sepX = Math.abs(a.x - b.x) - (a.hx + b.hx);
  const sepY = Math.abs(a.y - b.y) - (a.hy + b.hy);
  return Math.max(sepX, sepY);
}

function dimsMatch(e: PlacedEquipment, d: EquipmentDims): boolean {
  return Math.abs(e.length - d.length) < 1e-6 && Math.abs(e.width - d.width) < 1e-6;
}

const dimsText = (d: EquipmentDims) => `${d.length.toFixed(2)} x ${d.width.toFixed(2)} ft`;

export function buildComplianceReport(
  design: SiteDesign,
  config: BessConfiguration,
  opts: ComplianceOptions = {}
): ComplianceReport {
  const hot = opts.hotClimate ?? true;
  const findings: ComplianceFinding[] = [];
  const add = (
    ruleId: string, category: string, checklistItem: string, rule: string,
    status: FindingStatus, required: string, measured: string, entityIds: string[] = []
  ) => findings.push(
    opts.area
      ? { ruleId, category, checklistItem, rule, status, required, measured, entityIds, areaId: opts.area.id, areaName: opts.area.name }
      : { ruleId, category, checklistItem, rule, status, required, measured, entityIds }
  );

  const bess = design.equipment.filter(e => e.kind === 'bess');
  const inverters = design.equipment.filter(e => e.kind === 'inverter');
  const fenceOk = design.fence.length >= 3;

  // Rotated placed islands (drag-to-place, at any non-zero angle) break the
  // sheet 3–4 "block axis along world y" convention every geometric block check
  // below assumes. Canonicalize: map each rotated island's blocks back into its
  // local frame (inverse rotation about the island anchor), offset far away per
  // island so the pairwise adjacency scans never mix frames. doorEnd is defined
  // in the island-local frame, so it stays valid after the inverse transform.
  // Horizontal layouts (no rotated islands) are byte-identical: the map is the
  // identity for every block.
  // `θ` is the island's CCW rotation in radians; for vertical (legacy) it is π/2.
  const rotatedByBlock = new Map<string, { cx: number; cy: number; n: number; θ: number }>();
  for (const isl of design.islands ?? []) {
    if (isl.cx === undefined || isl.cy === undefined) continue;
    const θ = isl.angleDeg != null
      ? (((isl.angleDeg % 360) + 360) % 360) * Math.PI / 180
      : (isl.vertical ? Math.PI / 2 : 0);
    if (θ === 0) continue;
    for (const invId of isl.inverterIds) {
      rotatedByBlock.set(invId.replace('inv-', ''), { cx: isl.cx, cy: isl.cy, n: isl.n, θ });
    }
  }
  const blockNumOf = (e: PlacedEquipment): string | null =>
    e.kind === 'bess' ? e.id.split('-')[1]
    : e.kind === 'inverter' ? e.id.replace('inv-', '') : null;
  const isVertical = (e: PlacedEquipment) => {
    const n = blockNumOf(e);
    return n !== null && rotatedByBlock.has(n);
  };
  const toBlockFrame = (e: PlacedEquipment): PlacedEquipment => {
    const n = blockNumOf(e);
    const v = n !== null ? rotatedByBlock.get(n) : undefined;
    if (!v) return e;
    // Inverse rotation: lx = (wx-cx)·cosθ + (wy-cy)·sinθ
    //                   ly = -(wx-cx)·sinθ + (wy-cy)·cosθ
    // At θ=π/2 this reduces to lx=(wy-cy), ly=(cx-wx), matching the old
    // vertical formula exactly (byte-identical for 90° islands).
    // Per-island offset keeps canonical frames disjoint from world coords.
    const off = 1e6 * (1 + v.n);
    const dx = e.x - v.cx, dy = e.y - v.cy;
    const c = Math.cos(v.θ), s = Math.sin(v.θ);
    return {
      ...e,
      x: off + (dx * c + dy * s),
      y: (-dx * s + dy * c),
      rotation: e.rotation - v.θ,
    };
  };
  const bessC = bess.map(toBlockFrame);
  const invertersC = inverters.map(toBlockFrame);

  // -------------------------------------------------------------- Sheet 2
  // Equipment dimensions straight from the catalog
  const dimRule = (
    ruleId: string, item: string, kindLabel: string,
    items: PlacedEquipment[], want: EquipmentDims, applicable: boolean
  ) => {
    if (!applicable || items.length === 0) {
      add(ruleId, CAT_SHEET2, item, `${kindLabel}: ${dimsText(want)}`, 'PASS',
        dimsText(want), 'not used in this configuration');
      return;
    }
    const bad = items.filter(e => !dimsMatch(e, want));
    add(ruleId, CAT_SHEET2, item, `${kindLabel}: ${dimsText(want)}`,
      bad.length ? 'FAIL' : 'PASS', dimsText(want),
      bad.length
        ? `${bad.length} of ${items.length} item(s) deviate (${dimsText(bad[0])})`
        : `${items.length} item(s) at ${dimsText(want)}`,
      bad.map(e => e.id));
  };
  dimRule('bess-dims', 'BESS container dims', 'LG JF2 DC LINK 5.1', bess, LG_JF2, true);
  dimRule('pe-inv-dims', 'PE PCS dims', 'PE FP4200M', inverters, PE_FP4200M,
    config.inverterModel === 'PE FP4200M');
  dimRule('ge-inv-dims', 'GE PCS dims', 'GE Flex 1571', inverters, GE_FLEX_1571,
    config.inverterModel === 'GE FLEX 1571');
  dimRule('aux-xfmr-dims', 'Aux transformer dims', 'Hitachi aux transformer',
    design.equipment.filter(e => e.kind === 'auxTransformer'), HITACHI_AUX_XFMR, config.hasAuxEquipment);
  dimRule('aux-swgr-dims', 'Aux switchgear dims', 'IPS aux switchgear',
    design.equipment.filter(e => e.kind === 'auxSwitchgear'), IPS_SWITCHGEAR, config.hasAuxEquipment);

  // Container-to-container clearances. Containers are rotated 90° in plan
  // (long axis along y); doorEnd = front (door / compartment) wall direction.
  {
    let minFront = Infinity, minRear = Infinity, minSide = Infinity;
    const frontIds: string[] = [], rearIds: string[] = [], sideIds: string[] = [];
    for (let i = 0; i < bessC.length; i++) {
      for (let j = i + 1; j < bessC.length; j++) {
        const a = bessC[i], b = bessC[j];
        const ha = halfExtents(a), hb = halfExtents(b);
        const xOverlap = Math.abs(a.x - b.x) < ha.hx + hb.hx - 0.01;
        const yOverlap = Math.abs(a.y - b.y) < ha.hy + hb.hy - 0.01;
        if (xOverlap && !yOverlap && a.doorEnd && b.doorEnd) {
          const gap = Math.abs(a.y - b.y) - (ha.hy + hb.hy);
          if (gap > 60) continue; // different row groups, not adjacent
          const lower = a.y < b.y ? a : b;
          const upper = a.y < b.y ? b : a;
          const facingFronts = lower.doorEnd === 1 && upper.doorEnd === -1;
          const facingRears = lower.doorEnd === -1 && upper.doorEnd === 1;
          if (facingFronts && gap < minFront) { minFront = gap; frontIds.splice(0, 2, a.id, b.id); }
          if (facingRears && gap < minRear) { minRear = gap; rearIds.splice(0, 2, a.id, b.id); }
        } else if (yOverlap && !xOverlap) {
          const gap = Math.abs(a.x - b.x) - (ha.hx + hb.hx);
          if (gap > 60) continue;
          if (gap < minSide) { minSide = gap; sideIds.splice(0, 2, a.id, b.id); }
        }
      }
    }
    const gapRule = (ruleId: string, item: string, rule: string, req: number, min: number, ids: string[]) => {
      if (!Number.isFinite(min)) {
        add(ruleId, CAT_SHEET2, item, rule, 'PASS', ft(req), 'no adjacent container pairs of this type');
        return;
      }
      add(ruleId, CAT_SHEET2, item, rule, min >= req - TOL ? 'PASS' : 'FAIL',
        `>= ${ft(req)}`, `min gap ${ft(min)}`, min >= req - TOL ? [] : ids);
    };
    gapRule('front-front', 'Front to front', 'Container front-to-front clearance', CLEARANCES.frontToFront, minFront, frontIds);
    gapRule('rear-rear', 'Rear to rear', 'Container rear-to-rear clearance', CLEARANCES.rearToRear, minRear, rearIds);
    gapRule('side-side', 'Side to side (no E-Panel)', 'Container side-to-side clearance', CLEARANCES.sideToSide, minSide, sideIds);
  }

  // Fence clearances
  {
    let minFront = Infinity, minSide = Infinity;
    let frontId = '', sideId = '';
    if (fenceOk) {
      for (const c of bess) {
        const { hx, hy } = halfExtents(c);
        // doorEnd points along the block-local y axis; vertical placed
        // islands rotate local +y to world -x.
        const vert = isVertical(c);
        if (c.doorEnd) {
          const p = vert
            ? { x: c.x - c.doorEnd * hx, y: c.y }
            : { x: c.x, y: c.y + c.doorEnd * hy };
          const d = pointInPolygon(p, design.fence) ? distanceToPolygonEdge(p, design.fence) : -distanceToPolygonEdge(p, design.fence);
          if (d < minFront) { minFront = d; frontId = c.id; }
        }
        const sidePts = vert
          ? [{ x: c.x, y: c.y - hy }, { x: c.x, y: c.y + hy }]
          : [{ x: c.x - hx, y: c.y }, { x: c.x + hx, y: c.y }];
        for (const p of sidePts) {
          const d = pointInPolygon(p, design.fence) ? distanceToPolygonEdge(p, design.fence) : -distanceToPolygonEdge(p, design.fence);
          if (d < minSide) { minSide = d; sideId = c.id; }
        }
      }
    }
    const fenceRule = (ruleId: string, item: string, rule: string, req: number, min: number, id: string) => {
      if (!fenceOk || !Number.isFinite(min)) {
        add(ruleId, CAT_SHEET2, item, rule, bess.length ? 'FAIL' : 'PASS', `>= ${ft(req)}`,
          bess.length ? 'fence polygon missing' : 'no containers placed');
        return;
      }
      add(ruleId, CAT_SHEET2, item, rule, min >= req - TOL ? 'PASS' : 'FAIL',
        `>= ${ft(req)}`, `min distance ${ft(min)}`, min >= req - TOL ? [] : [id]);
    };
    fenceRule('front-fence', 'Front to fence', 'Container front wall to fence', CLEARANCES.frontToFence, minFront, frontId);
    fenceRule('side-fence', 'Side to fence', 'Container side wall to fence', CLEARANCES.sideToFence, minSide, sideId);
  }

  // PCS clearance: gap between each block's container row top and its PCS
  {
    // Minimum-clearance rule: a gap larger than the requirement is compliant.
    const req = hot ? CLEARANCES.pcsHotClimate : CLEARANCES.pcsStandard;
    let worstId = ''; let minGap = Infinity; let ok = invertersC.length > 0;
    for (const inv of invertersC) {
      const n = inv.id.replace('inv-', '');
      const blockContainers = bessC.filter(c => c.id.startsWith(`bess-${n}-`));
      if (!blockContainers.length) { ok = false; worstId = inv.id; continue; }
      // Mirrored-pair islands place the PCS at the OUTER end of each block:
      // north blocks keep containers below the PCS, south blocks keep them
      // above. Measure the gap on whichever side the containers actually sit.
      const avgY = blockContainers.reduce((s, c) => s + c.y, 0) / blockContainers.length;
      const hInv = halfExtents(inv).hy;
      const gap = inv.y >= avgY
        ? inv.y - hInv - Math.max(...blockContainers.map(c => c.y + halfExtents(c).hy))
        : Math.min(...blockContainers.map(c => c.y - halfExtents(c).hy)) - (inv.y + hInv);
      if (gap < minGap) { minGap = gap; if (gap < req - TOL) worstId = inv.id; }
    }
    if (!inverters.length) {
      add('pcs-clearance', CAT_SHEET2, 'PCS clearance', 'Container-to-PCS clearance', 'PASS',
        `>= ${req} ft (${hot ? '>40°C' : '<40°C'})`, 'no PCS units placed');
    } else {
      const pass = ok && minGap >= req - TOL;
      add('pcs-clearance', CAT_SHEET2, 'PCS clearance', 'Container-to-PCS clearance',
        pass ? 'PASS' : 'FAIL', `>= ${req} ft (${hot ? '>40°C' : '<40°C'})`,
        Number.isFinite(minGap) ? `min gap ${ft(minGap)}` : 'block containers missing',
        pass ? [] : [worstId]);
    }
  }

  // ------------------------------------------------------------ Sheets 3–4
  // Guidance sheets draw 3 containers per PCS but are explicitly
  // diagrammatic; the catalog block composition is the source of truth.
  const DRAWN_GUIDANCE_COUNT = 3;
  const compRule = (ruleId: string, item: string, applicable: boolean) => {
    const diagNote = config.containersPerBlock !== DRAWN_GUIDANCE_COUNT
      ? ` (guidance sheets draw ${DRAWN_GUIDANCE_COUNT}, diagrammatic only)` : '';
    if (opts.civilOnly) {
      add(ruleId, CAT_SHEET34, item, `${config.containersPerBlock} containers per PCS`, 'PASS',
        `${config.containersPerBlock} per block`, 'not applicable — civil-only area (no BESS blocks by design)');
      return;
    }
    if (!applicable) {
      add(ruleId, CAT_SHEET34, item, `${config.containersPerBlock} containers per PCS`, 'PASS',
        `${config.containersPerBlock} per block`, 'not used in this configuration');
      return;
    }
    const bad: string[] = [];
    for (const inv of inverters) {
      const n = inv.id.replace('inv-', '');
      const count = bess.filter(c => c.id.startsWith(`bess-${n}-`)).length;
      if (count !== config.containersPerBlock) bad.push(inv.id);
    }
    add(ruleId, CAT_SHEET34, item, `${config.containersPerBlock} containers per PCS${diagNote}`,
      bad.length || !inverters.length ? 'FAIL' : 'PASS',
      `${config.containersPerBlock} per block${diagNote}`,
      inverters.length
        ? bad.length
          ? `${bad.length} block(s) with the wrong container count`
          : `all ${inverters.length} block(s) have ${config.containersPerBlock} containers`
        : 'no blocks placed',
      bad);
  };
  compRule('block-comp-pe', 'Block composition (PE)', config.inverterModel === 'PE FP4200M');
  compRule('block-comp-ge', 'Block composition (GE)', config.inverterModel === 'GE FLEX 1571');

  // Container orientation: two rows rear-to-rear, fronts out, PCS north
  // of its containers across the PCS gap.
  {
    const bad: string[] = [];
    for (const c of bess) {
      if (!c.doorEnd || !c.epanel) bad.push(c.id);
    }
    for (const inv of invertersC) {
      const n = inv.id.replace('inv-', '');
      const blockContainers = bessC.filter(c => c.id.startsWith(`bess-${n}-`));
      // PCS across the clearance gap at the block's outer end: every
      // container on the SAME side of the PCS along the block axis (north
      // blocks: below; mirrored south blocks: above; vertical islands are
      // checked in their canonical frame).
      if (blockContainers.length &&
          !(blockContainers.every(c => inv.y > c.y) || blockContainers.every(c => inv.y < c.y))) {
        bad.push(inv.id);
      }
    }
    add('container-orientation', CAT_SHEET34, 'Container orientation',
      'Rows rear-to-rear, fronts out, PCS across the clearance gap',
      bad.length ? 'FAIL' : 'PASS', 'per sheet 3–4 block detail',
      bad.length ? `${bad.length} item(s) violate the block orientation` : 'all blocks oriented per the guidance',
      bad);
  }

  // 480V aux & fiber trench
  if (design.blocksPlaced === 0) {
    add('trench', CAT_SHEET34, '480V aux & fiber trench', 'Trench band between container rows',
      'PASS', 'trench band present', 'no blocks placed');
  } else if (!design.trench) {
    add('trench', CAT_SHEET34, '480V aux & fiber trench', 'Trench band between container rows',
      'WARN', 'trench band present', 'no trench band in this layout');
  } else {
    add('trench', CAT_SHEET34, '480V aux & fiber trench', 'Trench band between container rows',
      'PASS', 'trench band present',
      `trench at x = ${design.trench.x.toFixed(0)} ft, ${design.trench.width.toFixed(0)} ft wide`);
  }

  // Cable classes: presence + all non-reference points inside the fence
  const cableRule = (ruleId: string, item: string, cls: 'DC' | 'MV' | 'LVAC' | 'FIBER', rule: string) => {
    const runs = design.cables.filter(c => c.class === cls);
    if (design.blocksPlaced === 0) {
      add(ruleId, CAT_SHEET34, item, rule, 'PASS', `${cls} runs routed`, 'no blocks placed');
      return;
    }
    if (!runs.length) {
      // MV/LVAC/FIBER spines only exist when aux gear is placed
      const expected = cls === 'DC' || config.hasAuxEquipment;
      add(ruleId, CAT_SHEET34, item, rule, expected ? 'WARN' : 'PASS', `${cls} runs routed`,
        expected ? `no ${cls} cable runs in this layout` : 'not applicable without aux equipment');
      return;
    }
    const outIds = fenceOk
      ? runs.filter(c => !c.ref && c.pts.some(p => !pointInPolygon(p, design.fence))).map(c => c.id)
      : [];
    add(ruleId, CAT_SHEET34, item, rule, outIds.length ? 'WARN' : 'PASS',
      `${cls} runs routed inside the fence`,
      outIds.length
        ? `${outIds.length} run(s) leave the fenced yard`
        : `${runs.length} run(s), all inside the fence`,
      outIds);
  };
  cableRule('dc-cabling', 'DC cabling (container → PCS)', 'DC', 'Green DC runs per container');
  cableRule('mv-cabling', 'MV cabling (PCS → aux swgr)', 'MV', 'Cyan MV collection runs');
  cableRule('lvac-cabling', 'LVAC 480V cabling', 'LVAC', 'Deep blue LVAC runs');
  cableRule('fiber-cabling', 'Fiber optic cabling', 'FIBER', 'Orange fiber runs');

  // Small panels
  {
    const kinds = ['auxSwitchPanel', 'fiberPatchPanel', 'fireControlPanel'] as const;
    const missing = design.blocksPlaced > 0
      ? kinds.filter(k => !design.equipment.some(e => e.kind === k))
      : [];
    const panelWarn = design.warnings.find(w => w.includes('locate manually in detailed design') && /panel/i.test(w));
    add('small-panels', CAT_SHEET34, 'Aux switch / fiber patch / fire control panels',
      'Small panels placed near the aux cluster',
      missing.length || panelWarn ? 'WARN' : 'PASS', 'all 3 panels placed',
      missing.length ? `missing: ${missing.join(', ')}` : panelWarn ?? 'all 3 panels placed with clearances');
  }

  // Mirrored-pair island gear. Convention (reference detail PMA-D-B001):
  // one FJB terminates at most 2 feeders; split-side islands get a second
  // box. Non-island (QTY4) layouts have no island gear — reported PASS n/a
  // so the checklist row keeps 1:1 coverage.
  if (design.islands && design.islands.length) {
    const gearWarns = design.warnings.filter(w => /junction box/i.test(w));
    const nFjb = design.equipment.filter(e => e.kind === 'feederJunctionBox').length;
    const nComms = design.equipment.filter(e => e.kind === 'commsCabinet').length;
    const nIsl = design.islands.length;
    // A hand-placed island the engineer deliberately placed as CORE equipment
    // only carries no comms cabinet, so it must not be counted as a missing
    // one. The FJB is core to every island and is still expected on all of
    // them. Automatic islands never set the flag, so their expectation is
    // exactly what it always was.
    const nCoreOnly = design.islands.filter(i => i.auxGear === false).length;
    const wantComms = nIsl - nCoreOnly;
    add('island-gear', CAT_SHEET34, 'Island FJB + comms cabinets',
      'One FJB per 2 feeders (reference detail; split-side islands get a second box) and one comms cabinet per island that carries its aux cluster',
      gearWarns.length || nFjb < nIsl || nComms < wantComms ? 'WARN' : 'PASS',
      `>= ${nIsl} FJB + ${wantComms} comms cabinets`,
      gearWarns.length
        ? gearWarns[0]
        : `${nFjb} FJB + ${nComms} comms cabinets placed for ${nIsl} islands` +
          (nCoreOnly ? ` (${nCoreOnly} placed core-only by the engineer)` : ''));
  } else {
    add('island-gear', CAT_SHEET34, 'Island FJB + comms cabinets',
      'One FJB per 2 feeders (reference detail; split-side islands get a second box) and one comms cabinet per island',
      'PASS', 'n/a for non-island layouts', 'no mirrored-pair islands in this layout');
  }

  // ------------------------------------------------------------ Sheets 5–9
  // Project-sizing configurations (e.g. the 125 MW multi-area total) are not
  // guidance reference sheets, but they use a reference block/inverter, so
  // they are compliant by inheritance rather than by sheet identity.
  {
    const isReference = (REFERENCE_CONFIG_IDS as readonly string[]).includes(config.id);
    const isKnown = CONFIGURATIONS.some(c => c.id === config.id);
    add('five-configs', CAT_SHEET59, '5 configurations',
      'Configuration is one of the 5 guidance reference configurations',
      isReference ? 'PASS' : isKnown ? 'WARN' : 'FAIL',
      'one of 5 reference configurations',
      isReference
        ? config.label
        : isKnown
          ? `${config.label} — project sizing option (reference ${config.inverterModel} block)`
          : config.label);
  }
  if (config.inverterModel === 'GE FLEX 1571') {
    add('ge-hot-rating', CAT_SHEET59, 'GE hot-climate rating',
      `GE Flex 1571: ${GE_PCS_CAPABILITY_MW.toFixed(2)} MW PCS capability; credited output is battery-backed`,
      Math.abs(config.pcsCapabilityMW - GE_PCS_CAPABILITY_MW) < 0.01 &&
        Math.abs(config.blockMW - Math.min(config.pcsCapabilityMW, config.containersPerBlock * config.containerMWh * LG_JF2_CONTINUOUS_C_RATE)) < 1e-6
        ? 'PASS' : 'FAIL',
      `PCS ${GE_PCS_CAPABILITY_MW.toFixed(2)} MW; ${config.containersPerBlock} LG containers at ${LG_JF2_CONTINUOUS_C_RATE}C`,
      `${config.pcsCapabilityMW.toFixed(2)} MW PCS capability / ${config.blockMW.toFixed(3)} MW credited`);
  } else {
    add('ge-hot-rating', CAT_SHEET59, 'GE hot-climate rating',
      'GE Flex 1571 block rating', 'PASS', 'not applicable', 'not used in this configuration');
  }
  {
    const auxItems = design.equipment.filter(e => e.kind === 'auxTransformer' || e.kind === 'auxSwitchgear');
    const auxN = auxItems.length;
    // Drag-to-place islands each carry their OWN mid-island aux cluster
    // (island-aux-xfmr-N + island-aux-dist-N), on top of the single cluster
    // the automatic layout places when it holds any blocks itself.
    const placedIslands = (design.islands ?? []).filter(i => i.placed);
    const placedNs = new Set(placedIslands.map(i => i.n));
    const placedAuxN = auxItems.filter(e => {
      const m = e.id.match(/^island-aux-(?:xfmr|dist)-(\d+)$/);
      return m !== null && placedNs.has(parseInt(m[1], 10));
    }).length;
    // Gear the engineer placed one item at a time is counted separately: it is
    // neither part of an island cluster nor the yard-level pad, so it must not
    // be measured against the per-island expectation.
    const manualAuxN = auxItems.filter(e => e.id.startsWith('peq-')).length;
    // The reference standard puts aux gear MID-ISLAND: on an island layout
    // (the QTY3 standard) every island — auto or drag-placed — carries its
    // own transformer + distribution pair, and the yard-level pad near the
    // gate is not built at all. Only a non-island layout uses that single
    // pad. Expecting one pad per design failed every standard layout the
    // moment islands became the default.
    //
    // Islands the engineer deliberately placed as CORE equipment only carry no
    // cluster, so they are excluded from the expectation — the checklist has to
    // reflect the equipment that was actually chosen, not the equipment a
    // standard island would have brought along.
    const allIslands = design.islands ?? [];
    const clusterIslands = allIslands.filter(i => i.auxGear !== false);
    const placedClusterIslands = placedIslands.filter(i => i.auxGear !== false);
    const want = (!config.hasAuxEquipment || design.blocksPlaced === 0
      ? 0
      : allIslands.length
        ? 2 * clusterIslands.length
        : 2) + manualAuxN;
    const auxOk = auxN === want &&
      placedAuxN === (config.hasAuxEquipment ? 2 * placedClusterIslands.length : 0);
    const auxWarn = design.warnings.find(w => w.includes('aux transformer'));
    const coreOnlyN = allIslands.length - clusterIslands.length;
    add('aux-presence', CAT_SHEET59, 'Aux equipment presence',
      'Aux transformer + switchgear only on "with Aux" configurations',
      auxOk ? 'PASS' : auxWarn ? 'WARN' : 'FAIL',
      `${want} aux item(s)`,
      auxWarn ?? `${auxN} aux item(s) placed` +
        (coreOnlyN ? `, ${coreOnlyN} island(s) placed core-only by the engineer` : '') +
        (manualAuxN ? `, ${manualAuxN} placed individually` : ''));
  }
  add('disclaimer', CAT_SHEET59, 'Diagrammatic disclaimer',
    'Layouts convey concepts; EOR owns detailed design', 'PASS', 'disclaimer on drawing',
    'emitted in the DXF title block (verified by export regression tests)');

  // ------------------------------------------------------------- Sheet 10
  const net = design.roadNetwork;
  const compact = design.warnings.some(w => w.toLowerCase().includes('interior access roads omitted') || w.toLowerCase().includes('compact layout'));
  const arcRadii = (segs: { kind: string; r?: number }[][]) =>
    segs.flatMap(path => path.filter(s => s.kind === 'arc').map(s => (s as any).r as number));
  if (net) {
    const islandR = arcRadii(net.islands);
    const maxIsland = islandR.length ? Math.max(...islandR) : 0;
    add('kn2-inner-radius', CAT_SHEET10, 'Key note 2', "58' inner turning radius for yard roads",
      maxIsland <= CLEARANCES.roadInnerRadius + TOL ? 'PASS' : 'FAIL',
      `<= ${CLEARANCES.roadInnerRadius} ft target (auto-shrunk at tight tees)`,
      islandR.length ? `island fillet radii up to ${maxIsland.toFixed(1)} ft` : 'no island fillets');
    // Gate entrance apron: the outer road loop legitimately carries a short
    // leg out to the gate, and its corner fillets auto-shrink on the ~24 ft
    // apron edges — exempt arcs inside the inflated entrance-strip bbox from
    // the 20' outer-radius spec (they can never reach it geometrically).
    const gateC = design.gate;
    const entrance = gateC
      ? design.roads
          .map(rd => ({ rd, d: Math.hypot(rd.x - gateC.x, rd.y - gateC.y) }))
          .sort((a, b) => a.d - b.d)[0]?.rd ?? null
      : null;
    const apronPad = CLEARANCES.roadWidth / 2 + CLEARANCES.roadOuterRadius + 2;
    const inApron = (p: { x: number; y: number }) => {
      if (!entrance) return false;
      const c = Math.cos(entrance.rotation), s = Math.sin(entrance.rotation);
      const ax = entrance.x - c * entrance.length / 2, ay = entrance.y - s * entrance.length / 2;
      const bx = entrance.x + c * entrance.length / 2, by = entrance.y + s * entrance.length / 2;
      return p.x >= Math.min(ax, bx) - apronPad && p.x <= Math.max(ax, bx) + apronPad &&
             p.y >= Math.min(ay, by) - apronPad && p.y <= Math.max(ay, by) + apronPad;
    };
    const outerArcs = net.outer.filter(s => s.kind === 'arc') as { kind: 'arc'; c: { x: number; y: number }; r: number }[];
    const outerR = outerArcs.map(s => s.r);
    const badOuter = outerArcs
      .filter(s => Math.abs(s.r - CLEARANCES.roadOuterRadius) > TOL && !inApron(s.c))
      .map(s => s.r);
    add('kn4-outer-radius', CAT_SHEET10, 'Key note 4', "20' outer turning radius",
      badOuter.length ? 'FAIL' : 'PASS', `${CLEARANCES.roadOuterRadius} ft`,
      outerR.length
        ? badOuter.length
          ? `${badOuter.length} outer fillet(s) off-spec (${badOuter[0].toFixed(1)} ft)`
          : `all ${outerR.length} outer fillets at ${CLEARANCES.roadOuterRadius} ft`
        : 'no outer fillets');
    add('connected-network', CAT_SHEET10, 'Connected road network',
      'One connected road region — aisles tie into the perimeter road', 'PASS',
      'single boolean road region',
      `road region with ${net.islands.length} equipment island(s)`);
  } else {
    const noRoadStatus: FindingStatus = compact ? 'WARN' : design.blocksPlaced === 0 ? 'PASS' : 'WARN';
    const msg = compact
      ? 'interior roads omitted (compact layout) — fire/O&M access to be addressed in detailed design'
      : design.blocksPlaced === 0 ? 'no blocks placed' : 'no interior road network in this layout';
    add('kn2-inner-radius', CAT_SHEET10, 'Key note 2', "58' inner turning radius for yard roads", noRoadStatus,
      `<= ${CLEARANCES.roadInnerRadius} ft target`, msg);
    add('kn4-outer-radius', CAT_SHEET10, 'Key note 4', "20' outer turning radius", noRoadStatus,
      `${CLEARANCES.roadOuterRadius} ft`, msg);
    add('connected-network', CAT_SHEET10, 'Connected road network',
      'One connected road region — aisles tie into the perimeter road', noRoadStatus,
      'single boolean road region', msg);
  }
  {
    const widths = [...design.roads, ...design.aisles].map(r => r.width);
    const bad = widths.filter(w => Math.abs(w - CLEARANCES.roadWidth) > TOL);
    if (!widths.length) {
      add('kn3-road-width', CAT_SHEET10, 'Key note 3', `${CLEARANCES.roadWidth}' wide roads throughout the yard`,
        compact ? 'WARN' : 'PASS', `${CLEARANCES.roadWidth} ft`,
        compact ? 'interior roads omitted (compact layout)' : 'no road segments');
    } else {
      add('kn3-road-width', CAT_SHEET10, 'Key note 3', `${CLEARANCES.roadWidth}' wide roads throughout the yard`,
        bad.length ? 'FAIL' : 'PASS', `${CLEARANCES.roadWidth} ft`,
        bad.length
          ? `${bad.length} segment(s) off-spec (${bad[0].toFixed(1)} ft)`
          : `all ${widths.length} road segment(s) are ${CLEARANCES.roadWidth} ft wide`);
    }
    // Deliberately removed generated roads are an accepted engineering
    // exception, not a silent pass: the packet has to carry the reduced
    // access network so a reviewer sees it.
    const removalWarn = design.warnings.find(w => w.includes('removed by drafter edit'));
    if (removalWarn) {
      add('generated-road-removed', CAT_SHEET10, 'Drafter road removal',
        'Automatically generated access roads removed by drafter edit', 'WARN',
        'full automatic access-road network',
        removalWarn);
    }
  }
  {
    // Key note 5: 3' min from equipment to road edge (interior aisles)
    if (!design.aisles.length) {
      add('kn5-road-edge', CAT_SHEET10, 'Key note 5', `8'-0 3/4" min equipment distance to road edge`,
        'PASS', `>= ${CLEARANCES.equipmentToRoadEdge} ft`, compact ? 'interior roads omitted (compact layout)' : 'no interior aisles');
    } else {
      let min = Infinity; let minId = '';
      for (const e of design.equipment) {
        const h = halfExtents(e);
        for (const a of design.aisles) {
          const rot = Math.abs(Math.sin(a.rotation)) > 0.5;
          const ah = { hx: (rot ? a.width : a.length) / 2, hy: (rot ? a.length : a.width) / 2 };
          const gap = aabbGap({ x: e.x, y: e.y, hx: h.hx, hy: h.hy }, { x: a.x, y: a.y, ...ah });
          if (gap < min) { min = gap; minId = e.id; }
        }
      }
      add('kn5-road-edge', CAT_SHEET10, 'Key note 5', `8'-0 3/4" min equipment distance to road edge`,
        min >= CLEARANCES.equipmentToRoadEdge - TOL ? 'PASS' : 'FAIL',
        `>= ${CLEARANCES.equipmentToRoadEdge} ft`, `min gap ${ft(min)}`,
        min >= CLEARANCES.equipmentToRoadEdge - TOL ? [] : [minId]);
    }
  }
  {
    // Key note 6: NFPA 855 — BESS containers >= 100 ft from lot line
    const relaxed = design.warnings.find(w => w.includes('NFPA 855'));
    if (!bess.length) {
      add('kn6-nfpa855', CAT_SHEET10, 'Key note 6', "BESS >= 100'-0\" from lot line (NFPA 855)",
        'PASS', `>= ${CLEARANCES.bessToLotLine} ft`, 'no containers placed');
    } else {
      let min = Infinity; let minId = '';
      for (const c of bess) {
        const d = rectMinEdgeDist(c, design.boundary.polygon);
        if (d < min) { min = d; minId = c.id; }
      }
      const pass = min >= CLEARANCES.bessToLotLine - TOL;
      add('kn6-nfpa855', CAT_SHEET10, 'Key note 6', "BESS >= 100'-0\" from lot line (NFPA 855)",
        pass ? 'PASS' : relaxed ? 'WARN' : 'FAIL',
        `>= ${CLEARANCES.bessToLotLine} ft`,
        pass
          ? `min container-to-lot-line distance ${ft(min)}`
          : `min container-to-lot-line distance ${ft(min)}${relaxed ? ' — setback relaxed, alternate NFPA 855 compliance path required' : ''}`,
        pass ? [] : [minId]);
    }
  }

  // ------------------------------------- Reference DWG drafting conventions
  const staticDxf = (ruleId: string, item: string, rule: string) =>
    add(ruleId, CAT_DWG, item, rule, 'PASS', 'per reference DWGs',
      'guaranteed by the DXF exporter (byte-exact golden regression)');
  staticDxf('dwg-layers', 'Layers: `fence`, `EQUIP - ...`, `A - Equipment access`, `text-sm/lg`',
    'Layer names match the NextEra reference DWGs');
  staticDxf('dwg-road-hatch', 'Road fill on `Hatch - road proposed`', 'Road hatch layer convention');
  {
    const bad = design.equipment.filter(e => {
      const l = nexteraLabel(e);
      switch (e.kind) {
        case 'bess': return !/^CON\d{4}-A-\d+$/.test(l);
        case 'inverter': return !/^PCS\d{2}-\d{2}$/.test(l);
        case 'auxTransformer': return l !== 'AUX 100';
        case 'auxSwitchgear': return l !== 'AUX 101';
        case 'feederJunctionBox': return !/^FJB-\d{2}$/.test(l);
        case 'commsCabinet': return !/^COMMS-\d{2}$/.test(l);
        default: return !/^[A-Z ]+$/.test(l);
      }
    });
    add('dwg-labels', CAT_DWG, 'Labels `PCS<FF>-<UU>`, `CON<FFUU>-A-<n>`, `AUX 100/101`',
      'Equipment labels follow the reference naming', bad.length ? 'FAIL' : 'PASS',
      'PCSFF-UU / CONFFUU-A-n / AUX 100/101',
      bad.length ? `${bad.length} label(s) off-convention` : `${design.equipment.length} labels on-convention`,
      bad.map(e => e.id));
  }
  staticDxf('dwg-text-heights', "Text heights 1.5' labels / 4' general", 'Reference text heights');
  staticDxf('dwg-units-feet', 'Units: feet ($INSUNITS = 2)', 'Drawing units are feet');
  staticDxf('dwg-wysiwyg', 'WYSIWYG 2D entities 1:1 from layout positions',
    'Rectangles/lines/arcs only, straight from layout positions');

  // -------------- MV feeder trench / lane pattern (Puma ref PMA-D-B001-2B)
  const CAT_FEEDER_PATTERN = 'MV feeder trench / lane pattern (Puma reference PMA-D-B001-2B)';
  const staticFeeder = (ruleId: string, item: string, rule: string) =>
    add(ruleId, CAT_FEEDER_PATTERN, item, rule, 'PASS', 'per Puma reference',
      'guaranteed by the feeder routing engine (regression-tested)');
  staticFeeder('feeder-trench-exclusive', 'One MV circuit per trench',
    'Parallel home runs ride separate 10 ft comb lanes; no two feeders share a trench');
  staticFeeder('feeder-no-wander', 'No runs crossing the yard "connecting to nothing"',
    'Home-run length bounded by Manhattan distance + corridor allowance; lane order preserves exits');
  staticFeeder('feeder-no-detour', 'No down-then-back-up island detours',
    'Island chain order 2-opt optimized; hop length bounded by strip width');
  staticFeeder('feeder-fjb-separation', 'Same-FJB feeders separate immediately',
    'Drops off a shared FJB fan out at full 10 ft trench spacing');

  // ---------------------------------------------------------------- Extras
  // MV feeders (in-app design state, included when a substation is placed)
  if (opts.substation && (opts.feeders?.length ?? 0) > 0) {
    const over = (opts.feeders ?? []).filter(f => f.overLimit || f.overAmpacity);
    add('mv-feeders', 'In-app electrical checks', 'MV feeders',
      `Feeder voltage drop <= ${VD_LIMIT_PCT}% and within ampacity`,
      over.length ? 'WARN' : 'PASS', `<= ${VD_LIMIT_PCT}% VD, within ampacity`,
      over.length
        ? `${over.length} feeder(s) over limit: ${over.map(f => `#${f.idx} (${f.vdPct.toFixed(2)}%)`).join(', ')}`
        : `${(opts.feeders ?? []).length} feeder(s) all within limits`);
  }

  // Crushed-rock surfacing coverage: sample the expected yard area and verify
  // every sample falls inside a surfacing region (and no surfacing sample sits
  // on road surface or an equipment pad). Sampling keeps the check independent
  // of the boolean-difference code that produced the regions.
  {
    const CAT_SURF = 'In-app site checks';
    const item = 'Crushed rock surfacing coverage';
    const sp = design.surfacing;
    if (!sp || !fenceOk) {
      add('surfacing-coverage', CAT_SURF, item,
        'Yard ground cover per selected coverage mode',
        design.blocksPlaced === 0 || !fenceOk ? 'PASS' : 'WARN',
        'surfacing regions computed',
        !fenceOk ? 'no fence — not applicable' : sp ? 'no yard area to surface' : 'surfacing not computed for this layout');
    } else {
      const ruleText = sp.mode === 'full-yard'
        ? 'All non-road area inside the fence surfaced (equipment pads / reserves excluded)'
        : 'All equipment courtyards between roads surfaced (equipment pads / reserves excluded)';
      const inRegion = (p: Pt) =>
        sp.regions.some(rg => pointInPolygon(p, rg.outer) && !rg.holes.some(h => pointInPolygon(p, h)));
      const outerRing = net ? edgeSegsToRing(net.outer) : [];
      const islandRings = net ? net.islands.map(isl => edgeSegsToRing(isl)) : [];
      const onRoadSurface = (p: Pt) => {
        if (design.roads.some(rd => {
          const c = Math.cos(-rd.rotation), s = Math.sin(-rd.rotation);
          const lx = (p.x - rd.x) * c - (p.y - rd.y) * s;
          const ly = (p.x - rd.x) * s + (p.y - rd.y) * c;
          return Math.abs(lx) <= rd.length / 2 && Math.abs(ly) <= rd.width / 2;
        })) return true;
        if (!net || outerRing.length < 3) return false;
        return pointInPolygon(p, outerRing) && !islandRings.some(r => pointInPolygon(p, r));
      };
      const MARGIN = 1.5; // ft — keep samples off cut boundaries
      const inCutRect = (p: Pt) => {
        const inRect = (x: number, y: number, hl: number, hw: number, rot: number) => {
          const c = Math.cos(-rot), s = Math.sin(-rot);
          const lx = (p.x - x) * c - (p.y - y) * s;
          const ly = (p.x - x) * s + (p.y - y) * c;
          return Math.abs(lx) <= hl + MARGIN && Math.abs(ly) <= hw + MARGIN;
        };
        return design.equipment.some(e => inRect(e.x, e.y, e.length / 2, e.width / 2, e.rotation))
          || design.reservedZones.some(z => inRect(z.x, z.y, z.length / 2, z.width / 2, 0));
      };
      // Dead-space trim: when the drafter-selectable trim clipped courtyards
      // to their contents, full-courtyard coverage is no longer the contract —
      // the expected yard is each courtyard INTERSECTED with the axis-aligned
      // hull of its contents (equipment + reserved + aug zones) plus the
      // road-edge apron, mirroring the trim rule in computeSurfacing.
      const APRON = CLEARANCES.equipmentToRoadEdge;
      const trimHulls: { minX: number; minY: number; maxX: number; maxY: number; ring: Pt[] }[] = [];
      if (sp.deadSpaceTrimmed && sp.mode === 'between-roads' && net) {
        const contents = [
          ...design.equipment.map(e => {
            const rot = Math.abs(Math.sin(e.rotation)) > 0.5;
            return { x: e.x, y: e.y, hx: (rot ? e.width : e.length) / 2, hy: (rot ? e.length : e.width) / 2 };
          }),
          ...design.reservedZones.map(z => ({ x: z.x, y: z.y, hx: z.length / 2, hy: z.width / 2 })),
          ...design.augmentationZones.map(z => ({ x: z.x, y: z.y, hx: z.length / 2, hy: z.width / 2 })),
        ];
        for (const ring of islandRings) {
          const inside = contents.filter(c => pointInPolygon({ x: c.x, y: c.y }, ring));
          if (!inside.length) continue;
          let cMinX = Infinity, cMinY = Infinity, cMaxX = -Infinity, cMaxY = -Infinity;
          for (const c of inside) {
            cMinX = Math.min(cMinX, c.x - c.hx); cMaxX = Math.max(cMaxX, c.x + c.hx);
            cMinY = Math.min(cMinY, c.y - c.hy); cMaxY = Math.max(cMaxY, c.y + c.hy);
          }
          trimHulls.push({ minX: cMinX - APRON, minY: cMinY - APRON, maxX: cMaxX + APRON, maxY: cMaxY + APRON, ring });
        }
      }
      // Expected-yard membership per mode
      const inExpectedYard = (p: Pt) => {
        if (!pointInPolygon(p, design.fence)) return false;
        if (onRoadSurface(p)) return false;
        if (inCutRect(p)) return false;
        if (sp.mode === 'between-roads' && net) {
          if (sp.deadSpaceTrimmed) {
            return trimHulls.some(h =>
              p.x > h.minX + MARGIN && p.x < h.maxX - MARGIN &&
              p.y > h.minY + MARGIN && p.y < h.maxY - MARGIN &&
              pointInPolygon(p, h.ring));
          }
          return islandRings.some(r => pointInPolygon(p, r));
        }
        return true;
      };
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const p of design.fence) {
        if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
      }
      const N = 60;
      const dx = (maxX - minX) / N, dy = (maxY - minY) / N;
      let expected = 0, covered = 0, overlapBad = 0;
      for (let i = 0; i <= N; i++) {
        for (let j = 0; j <= N; j++) {
          const p = { x: minX + i * dx, y: minY + j * dy };
          const exp = inExpectedYard(p);
          const cov = inRegion(p);
          if (exp) {
            expected++;
            if (cov) covered++;
          }
          // Surfacing must never sit on road surface or a pad (no margin here)
          if (cov && onRoadSurface(p)) overlapBad++;
        }
      }
      const pct = expected ? (covered / expected) * 100 : 100;
      const covOk = pct >= 98; // sampling tolerance along boundaries
      const status: FindingStatus = overlapBad > 0 ? 'FAIL' : covOk ? 'PASS' : sp.regions.length ? 'WARN' : 'FAIL';
      add('surfacing-coverage', CAT_SURF, item, ruleText, status,
        '>= 98% of expected yard samples covered, no road/pad overlap',
        overlapBad > 0
          ? `${overlapBad} surfacing sample(s) overlap road surface`
          : `${pct.toFixed(1)}% of ${expected} yard sample(s) covered — ${sp.regions.length} region(s), ${(sp.areaSqFt / 43560).toFixed(2)} AC, ${Math.ceil(sp.tons)} tons at ${sp.depthIn}"`);
    }
  }

  // ---------------- Site access: gates at fence crossings + entrance ------
  // Audit rule (register F-11): every drive path that crosses the fence line
  // must carry a gate at the crossing, and the entrance must read as ONE
  // continuous drive path from public access through the gate onto the
  // internal loop (entrance rectangle overlaps the perimeter road region).
  if (fenceOk && (design.roads.length > 0 || design.roadNetwork)) {
    const CAT_ACCESS = 'In-app site checks';
    const gate = design.gate;
    // Sample each road rect's centerline; a fence crossing = consecutive
    // samples flipping inside/outside the fence polygon.
    const crossings: Pt[] = [];
    for (const rd of design.roads) {
      const c = Math.cos(rd.rotation), s = Math.sin(rd.rotation);
      const n = Math.max(2, Math.ceil(rd.length / 2));
      let prev: { p: Pt; in: boolean } | null = null;
      for (let i = 0; i <= n; i++) {
        const t = -rd.length / 2 + (rd.length * i) / n;
        const p = { x: rd.x + c * t, y: rd.y + s * t };
        const inside = pointInPolygon(p, design.fence);
        if (prev && prev.in !== inside) {
          crossings.push({ x: (prev.p.x + p.x) / 2, y: (prev.p.y + p.y) / 2 });
        }
        prev = { p, in: inside };
      }
    }
    const ungated = crossings.filter(p =>
      !gate || Math.hypot(p.x - gate.x, p.y - gate.y) > (gate.width ?? 0) + CLEARANCES.roadWidth);
    add('access-gate-crossings', CAT_ACCESS, 'Gate at every fence crossing',
      'Every drive path crossing the fence line carries a gate at the crossing',
      ungated.length ? 'FAIL' : 'PASS',
      'gate within one gate width + road width of each crossing',
      ungated.length
        ? `${ungated.length} fence crossing(s) without a gate`
        : crossings.length
          ? `${crossings.length} fence crossing(s), all gated`
          : 'no drive path crosses the fence line');

    // Entrance continuity: the entrance road (the rect nearest the gate)
    // must reach the perimeter road region so the drive path is continuous.
    if (gate && design.roadNetwork) {
      const outerRing = edgeSegsToRing(design.roadNetwork.outer);
      const entrance = design.roads
        .map(rd => ({ rd, d: Math.hypot(rd.x - gate.x, rd.y - gate.y) }))
        .sort((a, b) => a.d - b.d)[0]?.rd ?? null;
      let continuous = false;
      if (!entrance) {
        // No entrance rect: continuous only if the gate sits directly on the
        // perimeter road region (buildRoads' best.d <= 1 no-op case).
        continuous = outerRing.length >= 3 && pointInPolygon({ x: gate.x, y: gate.y }, outerRing);
      } else {
        // The entrance centerline must touch the gate on one side and the
        // perimeter road region on the other.
        const c = Math.cos(entrance.rotation), s = Math.sin(entrance.rotation);
        const ends = [
          { x: entrance.x - c * entrance.length / 2, y: entrance.y - s * entrance.length / 2 },
          { x: entrance.x + c * entrance.length / 2, y: entrance.y + s * entrance.length / 2 },
        ];
        const touchesGate = ends.some(p => Math.hypot(p.x - gate.x, p.y - gate.y) <= gate.width + 1);
        const reachesLoop = outerRing.length >= 3 && ends.some(p => pointInPolygon(p, outerRing));
        continuous = touchesGate && reachesLoop;
      }
      add('access-entrance-continuous', CAT_ACCESS, 'Continuous entrance drive path',
        'One continuous drive path: public access → gate → internal loop',
        continuous ? 'PASS' : 'FAIL',
        'entrance road touches the gate and the perimeter road region',
        continuous
          ? 'entrance drive path is continuous from the gate onto the internal loop'
          : 'entrance road does not connect the gate to the perimeter road region');
    }
  }

  // ---------------- Underground exclusion areas ---------------------------
  {
    const excl = exclusionRects(opts.areaZones);
    if (excl.length) {
      const offenders: string[] = [];
      for (const c of design.cables) {
        if (!c.ref && routeCrossesExclusion(c.pts, excl)) offenders.push(c.id);
      }
      for (const f of opts.feeders ?? []) {
        if (f.segments.some(s => routeCrossesExclusion(s.pts, excl))) offenders.push(`feeder-${f.idx}`);
      }
      for (const leg of design.auxFeeder?.legs ?? []) {
        if (routeCrossesExclusion(leg.pts, excl)) { offenders.push('aux-feeder'); break; }
      }
      add('exclusion-routes', 'In-app site checks', 'Underground exclusion areas',
        'No buried cable/trench route crosses an UNDERGROUND EXCLUSION AREA',
        offenders.length ? 'FAIL' : 'PASS',
        'zero route crossings',
        offenders.length
          ? `${offenders.length} buried route(s) cross an exclusion area`
          : `${excl.length} exclusion area(s), no buried route crossings`,
        offenders);
    }
  }

  const passCount = findings.filter(f => f.status === 'PASS').length;
  const warnCount = findings.filter(f => f.status === 'WARN').length;
  const failCount = findings.filter(f => f.status === 'FAIL').length;
  const tb = opts.titleBlock;
  return {
    findings, passCount, warnCount, failCount, ok: failCount === 0,
    generatedAt: (opts.now ?? new Date()).toLocaleString(),
    project: {
      projectName: tb?.projectName?.trim() || design.boundary.name,
      location: tb?.location?.trim() || '',
      drafter: tb?.drafter?.trim() || '',
      revision: tb?.revision?.trim() || DEFAULT_PRELIM_REV,
      date: tb?.date || '',
      configLabel: config.label,
      hotClimate: hot,
      achievedMW: design.achievedMW,
      achievedMWh: design.achievedMWh,
      targetMW: design.targetMW,
      targetMWh: design.targetMWh,
      blocksPlaced: design.blocksPlaced,
      blocksRequired: design.blocksRequired,
    },
  };
}

// ---------------------------------------------------------------------------
// Whole-site compliance: run the SAME per-design checklist once per area and
// merge, so a multi-area site is scored as one project while every finding
// still names the area it was measured in.
//
// Rule ids are namespaced per area (`<areaId>/<ruleId>`) because the panel and
// the PDF key on them for click-to-highlight — without the prefix the same
// rule in six areas would collide onto one row. Areas whose layout has not
// generated are reported in `site.uncheckedAreas` rather than being skipped
// silently: an all-clear report that quietly omitted an area would be a false
// pass on the exact thing this task exists to prevent.
export interface SiteComplianceArea {
  id: string;
  name: string;
  kind: string;
  design: SiteDesign | null;
  // Per-area routed feeders, when the caller tracks them per area.
  feeders?: FeederCircuit[];
  substation?: Pt | null;
  // This area's own drafter-drawn exclusion/laydown zones.
  areaZones?: AreaZone[] | null;
}

export function buildSiteComplianceReport(
  areas: SiteComplianceArea[],
  config: BessConfiguration,
  opts: ComplianceOptions = {}
): ComplianceReport {
  const findings: ComplianceFinding[] = [];
  const perArea: ComplianceSiteSummary['perArea'] = [];
  const uncheckedAreas: string[] = [];
  // The project header still describes the whole site, so it is taken from
  // the first generated area and its capacity figures are replaced by the
  // site totals below.
  let base: ComplianceReport | null = null;

  for (const a of areas) {
    if (!a.design) {
      uncheckedAreas.push(a.name);
      perArea.push({ areaId: a.id, areaName: a.name, kind: a.kind, passCount: 0, warnCount: 0, failCount: 0 });
      continue;
    }
    const rep = buildComplianceReport(a.design, config, {
      ...opts,
      // Strictly this area's own inputs — NEVER the caller's active-area
      // values. Falling back to `opts` scored every other yard against the
      // selected yard's feeder routes, substation and exclusion zones, which
      // silently invents findings for geometry that is not in that area.
      // An area that tracks no feeders is scored without feeder-dependent
      // findings, which is honest; borrowing another area's is not.
      feeders: a.feeders,
      substation: a.substation ?? null,
      areaZones: a.areaZones ?? null,
      area: { id: a.id, name: a.name },
      // A substation area is civil scope only — it has no BESS blocks by
      // design, so BESS block rules must not FAIL it for their absence.
      civilOnly: a.kind === 'substation',
    });
    if (!base) base = rep;
    for (const f of rep.findings) findings.push({ ...f, ruleId: `${a.id}/${f.ruleId}` });
    perArea.push({
      areaId: a.id, areaName: a.name, kind: a.kind,
      passCount: rep.passCount, warnCount: rep.warnCount, failCount: rep.failCount,
    });
  }

  const passCount = findings.filter(f => f.status === 'PASS').length;
  const warnCount = findings.filter(f => f.status === 'WARN').length;
  const failCount = findings.filter(f => f.status === 'FAIL').length;
  const sum = (pick: (d: SiteDesign) => number) =>
    areas.reduce((s, a) => s + (a.design ? pick(a.design) : 0), 0);

  // Access-road capacity shortfalls: BESS areas that kept roads but could not
  // fill the requested MW/MWh target within the available footprint.
  const ACCESS_ROAD_SHORTFALL_MARKER = 'Access-road capacity shortfall:';
  const capacityShortfalls: ComplianceSiteSummary['capacityShortfalls'] = [];
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
    }
  }

  const tb = opts.titleBlock;
  const project = base?.project;
  return {
    findings, passCount, warnCount, failCount, ok: failCount === 0,
    generatedAt: (opts.now ?? new Date()).toLocaleString(),
    site: { areaCount: areas.length, uncheckedAreas, perArea, capacityShortfalls },
    project: {
      projectName: tb?.projectName?.trim() || project?.projectName || '',
      location: tb?.location?.trim() || project?.location || '',
      drafter: tb?.drafter?.trim() || project?.drafter || '',
      revision: tb?.revision?.trim() || project?.revision || DEFAULT_PRELIM_REV,
      date: tb?.date || project?.date || '',
      configLabel: config.label,
      hotClimate: opts.hotClimate ?? true,
      achievedMW: sum(d => d.achievedMW),
      achievedMWh: sum(d => d.achievedMWh),
      targetMW: sum(d => d.targetMW),
      targetMWh: sum(d => d.targetMWh),
      blocksPlaced: sum(d => d.blocksPlaced),
      blocksRequired: sum(d => d.blocksRequired),
    },
  };
}

// CSV export of the findings table. Multi-area reports gain a leading Area
// column; a single-area report keeps the exact original column set.
export function complianceReportToCsv(report: ComplianceReport): string {
  const esc = (s: string) => `"${s.replace(/"/g, '""')}"`;
  const multi = !!report.site;
  const cols = ['Rule ID', 'Category', 'Checklist Item', 'Rule', 'Status', 'Required', 'Measured', 'Entities'];
  const rows = [
    (multi ? ['Area', ...cols] : cols).map(esc).join(','),
    ...report.findings.map(f => {
      const cells = [f.ruleId, f.category, f.checklistItem, f.rule, f.status, f.required, f.measured, f.entityIds.join('; ')];
      return (multi ? [f.areaName ?? '', ...cells] : cells).map(esc).join(',');
    }),
  ];
  const p = report.project;
  const header = [
    `# BESSForge Compliance Report — NextEra Site Plan Guidance R2 (5-14-2026)`,
    `# Project: ${p.projectName}${p.location ? ` — ${p.location}` : ''}`,
    `# Config: ${p.configLabel}${p.hotClimate ? ' — hot climate (>40C)' : ''}`,
    `# Achieved: ${p.achievedMW.toFixed(1)} MW / ${p.achievedMWh.toFixed(0)} MWh (target ${p.targetMW} MW / ${p.targetMWh} MWh, ${p.blocksPlaced}/${p.blocksRequired} blocks)`,
    `# Drafter: ${p.drafter} — Rev ${p.revision} — ${p.date}`,
    `# Generated: ${report.generatedAt}`,
    `# Result: ${report.passCount} PASS / ${report.warnCount} WARN / ${report.failCount} FAIL`,
    ...(report.site
      ? [
          `# Site: ${report.site.areaCount} areas — ${report.site.perArea
            .map(a => `${a.areaName} (${a.passCount}P/${a.warnCount}W/${a.failCount}F)`)
            .join('; ')}`,
          ...(report.site.uncheckedAreas.length
            ? [`# INCOMPLETE — not checked (no layout generated): ${report.site.uncheckedAreas.join('; ')}`]
            : []),
          ...(report.site.capacityShortfalls.length
            ? report.site.capacityShortfalls.map(s =>
                `# ACCESS-ROAD CAPACITY SHORTFALL — ${s.name}: requested ${s.requestedMW.toFixed(1)} MW / ${s.requestedMWh.toFixed(0)} MWh, achieved ${s.achievedMW.toFixed(1)} MW / ${s.achievedMWh.toFixed(0)} MWh — recommend increasing the phase footprint or reducing the target`)
            : []),
        ]
      : []),
  ].join('\n');
  return `${header}\n${rows.join('\n')}\n`;
}
