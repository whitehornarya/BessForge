// Pre-export design validation: a WYSIWYG checklist the drafter reviews
// before cutting the DXF. Pure function of the design + session state so it
// is unit-testable in Node.
import { SiteDesign, Pt } from './types';
import { pointInPolygon, rectInsidePolygon } from './kmz';
import { TitleBlockInfo } from '../stores/useDesignStore';
import { FeederCircuit, VD_LIMIT_PCT } from './feeders';
import { feederDisplayName } from './feederNaming';
import { FeederElectricalReport } from './electrical';
import { SteepZoneReport } from './terrain';
import { AreaZone, exclusionRects, routeCrossesExclusion } from './areaZones';

export type CheckStatus = 'pass' | 'warn' | 'fail';

export interface DesignCheck {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
}

export interface ValidationReport {
  checks: DesignCheck[];
  passCount: number;
  warnCount: number;
  failCount: number;
  ok: boolean; // no failures
}

export function validateDesign(
  design: SiteDesign,
  opts: {
    titleBlock?: TitleBlockInfo;
    feeders?: FeederCircuit[];
    substation?: Pt | null;
    // Precomputed terrain steep-zone screening (existing-ground grade under
    // placed items vs the drafter's max-grade threshold). Omitted when no
    // elevation data is loaded — the check then simply doesn't appear.
    terrain?: SteepZoneReport | null;
    // Voltage drop & losses screening report at the drafter's configured
    // limit/capacity factor. Omitted when no substation/feeders exist —
    // the check then simply doesn't appear.
    electrical?: FeederElectricalReport | null;
    // Drafter-drawn area zones: UNDERGROUND EXCLUSION AREA rects are hard
    // keep-outs for buried routes — any crossing is a FAIL. Omitted/empty =>
    // the check simply doesn't appear (zone-free projects unchanged).
    areaZones?: AreaZone[] | null;
  } = {}
): ValidationReport {
  const checks: DesignCheck[] = [];
  const add = (id: string, label: string, status: CheckStatus, detail: string) =>
    checks.push({ id, label, status, detail });

  // 1. Capacity target
  if (design.blocksPlaced <= 0) {
    add('capacity', 'Capacity target', 'fail', 'No BESS blocks fit on this parcel — nothing to export.');
  } else if (design.blocksPlaced < design.blocksRequired) {
    add('capacity', 'Capacity target', 'warn',
      `${design.blocksPlaced} of ${design.blocksRequired} blocks placed — ` +
      `${design.achievedMW.toFixed(1)} MW / ${design.achievedMWh.toFixed(0)} MWh vs target ${design.targetMW} MW / ${design.targetMWh} MWh.`);
  } else {
    add('capacity', 'Capacity target', 'pass',
      `${design.blocksPlaced} blocks placed — ${design.achievedMW.toFixed(1)} MW / ${design.achievedMWh.toFixed(0)} MWh meets the target.`);
  }

  // 2. Fence geometry
  if (design.fence.length < 3) {
    add('fence', 'Fence polygon', 'fail', 'Fence polygon is missing or degenerate.');
  } else {
    add('fence', 'Fence polygon', 'pass', `Fence polygon has ${design.fence.length} vertices.`);
  }

  // 3. Every placed entity inside the fence
  if (design.fence.length >= 3) {
    const outside: string[] = [];
    const rectOk = (cx: number, cy: number, length: number, width: number, rotation: number) => {
      // Axis-aligned footprint check; for rotated items use the bounding
      // half-extents of the rotated rectangle (conservative).
      const c = Math.abs(Math.cos(rotation));
      const s = Math.abs(Math.sin(rotation));
      const halfW = (length * c + width * s) / 2;
      const halfH = (length * s + width * c) / 2;
      return rectInsidePolygon(cx, cy, halfW, halfH, design.fence, 0);
    };
    for (const e of design.equipment) {
      if (!rectOk(e.x, e.y, e.length, e.width, e.rotation)) outside.push(e.label || e.id);
    }
    for (const z of design.reservedZones) {
      if (!rectOk(z.x, z.y, z.length, z.width, 0)) outside.push(z.label || z.id);
    }
    if (outside.length) {
      add('inside-fence', 'Equipment inside fence', 'fail',
        `${outside.length} item(s) extend past the fence: ${outside.slice(0, 5).join(', ')}${outside.length > 5 ? ', …' : ''}.`);
    } else {
      add('inside-fence', 'Equipment inside fence', 'pass',
        `All ${design.equipment.length + design.reservedZones.length} placed items are inside the fence.`);
    }
  }

  // 4. Site access (gate + entrance road)
  if (!design.gate) {
    add('access', 'Site access', 'warn', 'No gate placed — the yard has no drawn entrance.');
  } else if (design.roads.length === 0) {
    add('access', 'Site access', 'warn', 'Gate present but no entrance road segment.');
  } else {
    add('access', 'Site access', 'pass', 'Gate and entrance road are present.');
  }

  // 5. Cable routing
  if (design.blocksPlaced > 0 && design.cables.length === 0) {
    add('cables', 'Cable routing', 'fail', 'Blocks are placed but no cable runs were routed.');
  } else {
    const outOfFence = design.fence.length >= 3
      ? design.cables.filter(c => !c.ref && c.pts.some(p => !pointInPolygon(p, design.fence)))
      : [];
    if (outOfFence.length) {
      add('cables', 'Cable routing', 'warn',
        `${outOfFence.length} cable run(s) have points outside the fence (check reroutes): ${outOfFence.slice(0, 3).map(c => c.id).join(', ')}.`);
    } else {
      add('cables', 'Cable routing', 'pass', `${design.cables.length} cable runs routed, all inside the fence.`);
    }
  }

  // 5b. Underground exclusion areas: no buried route may cross one.
  {
    const excl = exclusionRects(opts.areaZones);
    if (excl.length) {
      const offenders: string[] = [];
      for (const c of design.cables) {
        if (!c.ref && routeCrossesExclusion(c.pts, excl)) offenders.push(c.id);
      }
      for (const f of opts.feeders ?? []) {
        if (f.segments.some(s => routeCrossesExclusion(s.pts, excl))) offenders.push(`feeder #${f.idx}`);
      }
      for (const leg of design.auxFeeder?.legs ?? []) {
        if (routeCrossesExclusion(leg.pts, excl)) { offenders.push('aux feeder'); break; }
      }
      if (offenders.length) {
        add('exclusions', 'Underground exclusion areas', 'fail',
          `${offenders.length} buried route(s) cross an UNDERGROUND EXCLUSION AREA: ` +
          `${offenders.slice(0, 5).join(', ')}${offenders.length > 5 ? ', …' : ''}. Reroute before export.`);
      } else {
        add('exclusions', 'Underground exclusion areas', 'pass',
          `${excl.length} exclusion area(s) drawn — no buried cable/feeder route crosses one.`);
      }
    }
  }

  // 6. Engine warnings
  if (design.warnings.length) {
    add('warnings', 'Layout warnings', 'warn',
      `${design.warnings.length} active warning(s): ${design.warnings.slice(0, 3).join(' | ')}${design.warnings.length > 3 ? ' | …' : ''}`);
  } else {
    add('warnings', 'Layout warnings', 'pass', 'No layout warnings.');
  }

  // 7. Title block completeness
  const tb = opts.titleBlock;
  if (tb) {
    const missing: string[] = [];
    if (!tb.projectName.trim()) missing.push('project name');
    if (!tb.location.trim()) missing.push('location');
    if (!tb.drafter.trim()) missing.push('drafter');
    if (missing.length) {
      add('titleblock', 'Title block', 'warn', `Title block is missing: ${missing.join(', ')}.`);
    } else {
      add('titleblock', 'Title block', 'pass', 'Title block is complete.');
    }
  }

  // 8. MV feeders (only when a substation is placed)
  if (opts.substation) {
    const feeders = opts.feeders ?? [];
    if (!feeders.length) {
      add('feeders', 'MV feeders', 'warn', 'Substation placed but no feeders generated.');
    } else {
      const over = feeders.filter(f => f.vdPct > VD_LIMIT_PCT);
      if (over.length) {
        add('feeders', 'MV feeders', 'warn',
          `${over.length} feeder(s) exceed the ${VD_LIMIT_PCT}% voltage-drop limit: ${over.map(f => `#${f.idx} (${f.vdPct.toFixed(2)}%)`).join(', ')}.`);
      } else {
        add('feeders', 'MV feeders', 'pass', `${feeders.length} feeder(s), all within the ${VD_LIMIT_PCT}% voltage-drop limit.`);
      }
    }
  }

  // 9. Terrain steep zones (screening; only when elevation data is loaded)
  if (opts.terrain) {
    const t = opts.terrain;
    if (t.items.length) {
      add('terrain', 'Terrain grade', 'warn',
        `${t.items.length} item(s) sit on existing ground steeper than ${t.thresholdPct}% grade ` +
        `(max ${t.maxSlopePct.toFixed(1)}%): ${t.items.slice(0, 5).map(i => `${i.label} (${i.slopePct.toFixed(1)}%)`).join(', ')}${t.items.length > 5 ? ', …' : ''}. ` +
        'Screening-grade — grading will level the pad; verify earthwork scope.');
    } else {
      add('terrain', 'Terrain grade', 'pass',
        `Existing ground under all blocks and roads is within ${t.thresholdPct}% grade (max ${t.maxSlopePct.toFixed(1)}%).`);
    }
  }

  // 10. Voltage drop & losses (screening; only when the report is provided)
  if (opts.electrical && opts.electrical.rows.length) {
    const e = opts.electrical;
    if (e.overCount > 0) {
      const over = e.rows.filter(r => r.overLimit);
      add('vdrop', 'Voltage drop & losses', 'warn',
        `${e.overCount} feeder(s) exceed the ${e.limitPct}% voltage-drop limit: ` +
        `${over.slice(0, 5).map(r => `#${feederDisplayName(r)} (${r.vdPct.toFixed(2)}%)`).join(', ')}${over.length > 5 ? ', …' : ''}. ` +
        `Est. losses ${e.totalAnnualLossMWh.toFixed(1)} MWh/yr at ${e.capacityFactorPct}% capacity factor.`);
    } else {
      add('vdrop', 'Voltage drop & losses', 'pass',
        `All ${e.rows.length} feeder(s) within the ${e.limitPct}% voltage-drop limit ` +
        `(worst ${e.worstVdPct.toFixed(2)}%); est. losses ${e.totalAnnualLossMWh.toFixed(1)} MWh/yr ` +
        `at ${e.capacityFactorPct}% capacity factor.`);
    }
  }

  const passCount = checks.filter(c => c.status === 'pass').length;
  const warnCount = checks.filter(c => c.status === 'warn').length;
  const failCount = checks.filter(c => c.status === 'fail').length;
  return { checks, passCount, warnCount, failCount, ok: failCount === 0 };
}
