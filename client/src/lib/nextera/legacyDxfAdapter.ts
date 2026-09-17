// Adapter: BessForge SiteDesign snapshot → @bessforge/legacy-dxf LegacyLayoutInput.
// Pure mapping only — no React stores, Three.js, or GLB. Coordinates stay local feet.

import type {
  CableClass as LegacyCableClass,
  Equipment as LegacyEquipment,
  EquipmentKind as LegacyEquipmentKind,
  IdentifiedPolygon,
  IdentifiedPolyline,
  LegacyLayoutInput,
  Point,
  ReservedZone as LegacyReservedZone,
  Road as LegacyRoad,
  TrenchClass,
  TrenchRun,
} from '@bessforge/legacy-dxf';
import type { TitleBlockInfo } from '../stores/useDesignStore';
import type { FeederCircuit } from './feeders';
import type {
  CableRun,
  CorridorTrench,
  EquipmentKind,
  PlacedEquipment,
  Pt,
  ReservedZone,
  RoadEdgeSeg,
  RoadSegment,
  SiteDesign,
} from './types';

const FEEDER_CABLE_CLASSES: readonly LegacyCableClass[] = [
  'bess-feeder-14a1', 'bess-feeder-14a2', 'bess-feeder-14b1', 'bess-feeder-14b2',
  'bess-feeder-15a1', 'bess-feeder-15a2', 'bess-feeder-15b1', 'bess-feeder-15b2',
];

export interface LegacyAdapterContext {
  design: SiteDesign;
  titleBlock: TitleBlockInfo;
  feeders?: FeederCircuit[] | null;
  substation?: Pt | null;
  projectOwner?: string;
  drawingNumber?: string;
  sheetTitle?: string;
  statusStamp?: string;
  preferredFtPerIn?: number;
  autoScale?: boolean;
}

function asciiText(value: string, fallback = ' '): string {
  const cleaned = value
    .replace(/[\\^]/g, '')
    .replace(/%%/g, '')
    .replace(/[^\x20-\x7E]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || fallback;
}

function stableId(raw: string, fallback: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9._:#/-]+/g, '-').replace(/^-+|-+$/g, '');
  if (/^[A-Za-z0-9]/.test(cleaned) && cleaned.length <= 128) return cleaned;
  return fallback;
}

function pt(p: Pt): Point {
  return { x: p.x, y: p.y };
}

/** Open ring: drop duplicate closing vertex if present. */
function openRing(points: Pt[]): Point[] {
  if (points.length < 2) return points.map(pt);
  const first = points[0]!;
  const last = points[points.length - 1]!;
  const ring = Math.hypot(first.x - last.x, first.y - last.y) < 1e-6
    ? points.slice(0, -1)
    : points;
  return ring.map(pt);
}

function rectPolygon(cx: number, cy: number, length: number, width: number, rotationRad: number): Point[] {
  const hx = length / 2;
  const hy = width / 2;
  const c = Math.cos(rotationRad);
  const s = Math.sin(rotationRad);
  const corners: Pt[] = [
    { x: -hx, y: -hy },
    { x: hx, y: -hy },
    { x: hx, y: hy },
    { x: -hx, y: hy },
  ];
  return corners.map(p => ({
    x: cx + p.x * c - p.y * s,
    y: cy + p.x * s + p.y * c,
  }));
}

function tessellateEdgePath(segs: RoadEdgeSeg[]): Point[] {
  const pts: Point[] = [];
  const push = (x: number, y: number) => {
    const last = pts[pts.length - 1];
    if (!last || Math.hypot(x - last.x, y - last.y) > 0.05) pts.push({ x, y });
  };
  for (const seg of segs) {
    if (seg.kind === 'line') {
      push(seg.a.x, seg.a.y);
      push(seg.b.x, seg.b.y);
    } else {
      let { start, end } = seg;
      if (seg.ccw && end < start) end += Math.PI * 2;
      if (!seg.ccw && end > start) end -= Math.PI * 2;
      const steps = Math.max(4, Math.ceil(Math.abs(end - start) / 0.15));
      for (let i = 0; i <= steps; i++) {
        const a = start + ((end - start) * i) / steps;
        push(seg.c.x + seg.r * Math.cos(a), seg.c.y + seg.r * Math.sin(a));
      }
    }
  }
  return openRing(pts);
}

function roadFromSegment(seg: RoadSegment, index: number): LegacyRoad {
  return {
    id: stableId(seg.id ?? `road-seg-${index + 1}`, `road-seg-${index + 1}`),
    points: rectPolygon(seg.x, seg.y, seg.length, seg.width, seg.rotation),
  };
}

function mapEquipmentKind(kind: EquipmentKind): LegacyEquipmentKind | null {
  switch (kind) {
    case 'bess': return 'bess';
    case 'inverter': return 'inverter';
    case 'auxTransformer': return 'aux-transformer';
    case 'auxSwitchgear':
    case 'auxSwitchPanel':
      return 'aux-distribution';
    case 'fiberPatchPanel': return 'fiber-junction-box';
    case 'feederJunctionBox': return 'junction-box';
    case 'fireControlPanel':
    case 'commsCabinet':
    case 'generator':
    case 'conex':
    case 'manhole':
    case 'mainTransformer':
    case 'mvSwitchgear':
    case 'controlHouse':
    case 'substationFeeder':
      return 'junction-box';
    default:
      return null;
  }
}

function mapEquipment(e: PlacedEquipment): LegacyEquipment | null {
  const kind = mapEquipmentKind(e.kind);
  if (!kind) return null;
  const base = {
    id: stableId(e.id, `eq-${e.id}`),
    label: asciiText(e.label || e.id, e.id),
    center: { x: e.x, y: e.y },
    length: Math.max(0.001, e.length),
    width: Math.max(0.001, e.width),
    rotationDeg: (e.rotation * 180) / Math.PI,
  };
  if (kind === 'bess') {
    const configuration = e.epanel === 'right' ? 'C' : 'A';
    return { ...base, kind: 'bess', configuration };
  }
  return { ...base, kind };
}

function feederCableClass(feeder: FeederCircuit, index: number): LegacyCableClass {
  const raw = (feeder.name || '').replace(/^#/, '').trim().toUpperCase();
  const key = raw ? `bess-feeder-${raw.toLowerCase()}` : '';
  if ((FEEDER_CABLE_CLASSES as readonly string[]).includes(key)) {
    return key as LegacyCableClass;
  }
  return FEEDER_CABLE_CLASSES[index % FEEDER_CABLE_CLASSES.length]!;
}

function mapDesignCable(c: CableRun): { class: LegacyCableClass; feederName?: string } | null {
  switch (c.class) {
    case 'DC':
      return { class: c.polarity === 'neg' ? 'dc-negative' : 'dc-positive' };
    case 'FIBER':
    case 'FIBER_TRUNK':
    case 'CATL':
      return { class: 'fiber' };
    case 'AUXPWR':
    case 'LVAC':
      return { class: 'aux-feeder' };
    case 'MV':
      // MV home runs / hops are represented via FeederCircuit segments.
      return null;
    default:
      return null;
  }
}

function mapReservedZone(z: ReservedZone): LegacyReservedZone {
  const kind: LegacyReservedZone['kind'] =
    z.kind === 'laydown' ? 'laydown' : 'future-augmentation-batteries';
  const rotationRad = ((z.angleDeg ?? 0) * Math.PI) / 180;
  return {
    id: stableId(z.id, `zone-${z.id}`),
    kind,
    label: asciiText(z.label || z.kind, z.kind),
    points: rectPolygon(z.x, z.y, z.length, z.width, rotationRad),
  };
}

function trenchFromBand(design: SiteDesign): TrenchRun[] {
  const out: TrenchRun[] = [];
  if (design.trench) {
    const t = design.trench;
    out.push({
      id: 'trench-aux-spine',
      class: 'aux-fiber',
      points: [
        { x: t.x, y: t.yBottom },
        { x: t.x, y: t.yTop },
      ],
    });
  }
  for (const c of design.corridorTrenches ?? []) {
    out.push(corridorToTrench(c));
  }
  return out;
}

function corridorToTrench(c: CorridorTrench): TrenchRun {
  const id = stableId(`trench-corridor-${c.islandN}`, `trench-corridor-${c.islandN}`);
  const trenchClass: TrenchClass =
    c.section === 'DC_DUCT_BANK' ? 'dc'
      : c.section === 'MVAC_DIRECT_BURY' || c.section === 'MVAC_DUCT' ? 'mvac'
        : 'aux-fiber';
  if (c.cx != null && c.cy != null && c.angleDeg != null && c.length != null) {
    const half = c.length / 2;
    const rad = (c.angleDeg * Math.PI) / 180;
    const dx = Math.cos(rad) * half;
    const dy = Math.sin(rad) * half;
    return {
      id,
      class: trenchClass,
      points: [
        { x: c.cx - dx, y: c.cy - dy },
        { x: c.cx + dx, y: c.cy + dy },
      ],
    };
  }
  if (c.vertical) {
    return {
      id,
      class: trenchClass,
      points: [
        { x: c.y, y: c.minX },
        { x: c.y, y: c.maxX },
      ],
    };
  }
  return {
    id,
    class: trenchClass,
    points: [
      { x: c.minX, y: c.y },
      { x: c.maxX, y: c.y },
    ],
  };
}

function ensureFence(design: SiteDesign): IdentifiedPolygon {
  if (design.fence.length >= 3) {
    return { id: 'security-fence', points: openRing(design.fence) };
  }
  // Trace yards may share the property line as the fence.
  return {
    id: 'security-fence',
    points: openRing(design.boundary.polygon),
  };
}

function buildTitle(ctx: LegacyAdapterContext): LegacyLayoutInput['title'] {
  const tb = ctx.titleBlock;
  const projectName = asciiText(tb.projectName || ctx.design.boundary.name || 'BESS PROJECT', 'BESS PROJECT');
  const rev = asciiText(tb.revision || '0A', '0A');
  const date = asciiText(tb.date || new Date().toLocaleDateString('en-US'), '01/01/26');
  const drafter = asciiText(tb.drafter || 'DRAFTER', 'DRAFTER');
  return {
    projectOwner: asciiText(ctx.projectOwner || 'PROJECT OWNER', 'PROJECT OWNER'),
    projectName,
    sheetTitle: asciiText(ctx.sheetTitle || 'BESS LAYOUT', 'BESS LAYOUT'),
    drawingNumber: asciiText(ctx.drawingNumber || tb.neerDwgName || 'BESS-D-0001', 'BESS-D-0001'),
    clientDrawingNumber: tb.neerDwgName.trim() ? asciiText(tb.neerDwgName) : '',
    revision: rev,
    location: asciiText(tb.location || ctx.design.boundary.location || projectName, projectName),
    statusStamp: asciiText(ctx.statusStamp || 'ISSUED FOR 90% REVIEW', 'ISSUED FOR 90% REVIEW'),
    notes: [
      asciiText('SEE GENERAL NOTES.', 'SEE GENERAL NOTES.'),
    ],
    revisions: [
      {
        revision: rev,
        description: asciiText('ISSUED FOR REVIEW', 'ISSUED FOR REVIEW'),
        date,
        by: drafter,
        checkedBy: drafter,
      },
    ],
    engineering: {
      drawnBy: drafter,
      designedBy: drafter,
      checkedBy: drafter,
      approvedBy: drafter,
      drawnDate: date,
      designedDate: date,
      checkedDate: date,
      approvedDate: date,
    },
  };
}

/**
 * Map the latest BessForge design snapshot to a Legacy layout input.
 * Caller must validate with validateLegacyLayoutInput before compose.
 */
export function adaptSiteDesignToLegacyLayoutInput(ctx: LegacyAdapterContext): LegacyLayoutInput {
  const { design } = ctx;

  const roads: LegacyRoad[] = [];
  if (design.roadNetwork && design.roadNetwork.outer.length) {
    const outer = tessellateEdgePath(design.roadNetwork.outer);
    const holes = design.roadNetwork.islands
      .map(isl => tessellateEdgePath(isl))
      .filter(h => h.length >= 3);
    if (outer.length >= 3) {
      roads.push({
        id: 'road-network',
        label: 'EQUIPMENT ACCESS',
        points: outer,
        ...(holes.length ? { holes } : {}),
      });
    }
  } else {
    design.roads.forEach((seg, i) => roads.push(roadFromSegment(seg, i)));
    design.aisles.forEach((seg, i) => roads.push({
      ...roadFromSegment(seg, i),
      id: stableId(seg.id ?? `aisle-${i + 1}`, `aisle-${i + 1}`),
    }));
  }

  const surfacing: IdentifiedPolygon[] = (design.surfacing?.regions ?? []).map((r, i) => ({
    id: `surfacing-${i + 1}`,
    points: openRing(r.outer),
    ...(r.holes.length
      ? { holes: r.holes.map(h => openRing(h)).filter(h => h.length >= 3) }
      : {}),
  })).filter(r => r.points.length >= 3);

  const equipment: LegacyEquipment[] = [];
  for (const e of design.equipment) {
    const mapped = mapEquipment(e);
    if (mapped) equipment.push(mapped);
  }
  for (const e of design.futureEquipment ?? []) {
    const mapped = mapEquipment(e);
    if (mapped) equipment.push({ ...mapped, id: stableId(`future-${e.id}`, `future-${e.id}`) });
  }
  if (ctx.substation) {
    equipment.push({
      id: 'substation',
      kind: 'substation',
      label: 'SUBSTATION',
      center: { x: ctx.substation.x, y: ctx.substation.y },
      length: 60,
      width: 40,
      rotationDeg: 0,
    });
  }

  const cables: LegacyLayoutInput['cables'] = [];
  for (const c of design.cables) {
    if (c.pts.length < 2) continue;
    const mapped = mapDesignCable(c);
    if (!mapped) continue;
    cables.push({
      id: stableId(c.id, `cable-${c.id}`),
      class: mapped.class,
      points: c.pts.map(pt),
      ...(mapped.feederName ? { feederName: mapped.feederName } : {}),
    });
  }
  (ctx.feeders ?? []).forEach((feeder, fi) => {
    const cableClass = feederCableClass(feeder, fi);
    const feederName = asciiText(feeder.name ? `#${feeder.name.replace(/^#/, '')}` : `F${feeder.idx}`, `F${fi + 1}`);
    feeder.segments.forEach((seg, si) => {
      if (seg.pts.length < 2) return;
      cables.push({
        id: stableId(`feeder-${feeder.idx}-${si + 1}`, `feeder-${fi + 1}-${si + 1}`),
        class: cableClass,
        feederName,
        points: seg.pts.map(pt),
      });
    });
  });
  if (design.auxFeeder?.legs?.length) {
    const pts: Point[] = [];
    for (const leg of design.auxFeeder.legs) {
      for (const p of leg.pts ?? []) {
        const last = pts[pts.length - 1];
        if (!last || Math.hypot(last.x - p.x, last.y - p.y) > 0.05) pts.push(pt(p));
      }
    }
    if (pts.length >= 2) {
      cables.push({
        id: 'aux-feeder-main',
        class: 'aux-feeder',
        points: pts,
      });
    }
  }

  const trenches: TrenchRun[] = trenchFromBand(design);
  // MV feeder routes also act as MVAC trench centerlines in the legacy sheet.
  (ctx.feeders ?? []).forEach((feeder, fi) => {
    feeder.segments.forEach((seg, si) => {
      if (seg.pts.length < 2) return;
      trenches.push({
        id: stableId(`trench-mv-${feeder.idx}-${si + 1}`, `trench-mv-${fi + 1}-${si + 1}`),
        class: 'mvac',
        points: seg.pts.map(pt),
      });
    });
  });

  const reservedZones = design.reservedZones.map(mapReservedZone);
  for (const z of design.augmentationZones) {
    reservedZones.push({
      id: stableId(z.id, `aug-${z.id}`),
      kind: 'future-augmentation-inverters',
      label: 'FUTURE AUGMENTATION',
      points: rectPolygon(z.x, z.y, z.length, z.width, 0),
    });
  }

  const adjacentFences: IdentifiedPolyline[] = [];
  const projectFences: IdentifiedPolyline[] = [];
  const existingAccess: LegacyRoad[] = [];
  const detailMarkers: LegacyLayoutInput['detailMarkers'] = [];
  const callouts: LegacyLayoutInput['callouts'] = [];
  const matchLines: LegacyLayoutInput['matchLines'] = [];

  return {
    title: buildTitle(ctx),
    rating: {
      mw: design.achievedMW || design.targetMW || 0,
      mwh: design.achievedMWh || design.targetMWh || 0,
    },
    scale: {
      preferredFtPerIn: ctx.preferredFtPerIn ?? 20,
      autoScale: ctx.autoScale ?? true,
    },
    siteBoundary: {
      id: 'site-boundary',
      points: openRing(design.boundary.polygon),
    },
    fence: ensureFence(design),
    adjacentFences,
    projectFences,
    existingAccess,
    detailMarkers,
    roads,
    surfacing,
    equipment,
    cables,
    trenches,
    reservedZones,
    callouts,
    matchLines,
  };
}
