// Small deterministic 2D plan-view thumbnail of a pristine SiteDesign for the
// arrangement explorer: lot line, fence, road region, block/equipment rects.
// Pure SVG (no WebGL) rendered straight from layout positions in feet.
import { useMemo } from 'react';
import { Pt, SiteDesign, RoadEdgeSeg, PlacedEquipment, RoadSegment } from '../lib/nextera/types';
import { PROPERTY_LINE_HEX, showSeparateFence } from '../lib/nextera/propertyLineColor';

const W = 220;
const H = 130;
const PAD = 6;

// Plan frame: x = easting (right), y = northing (up) -> SVG y is flipped.
function makeTransform(boundary: Pt[]) {
  // Degenerate boundary (empty or single point, e.g. a malformed KMZ):
  // Math.min(...[]) is Infinity, which would leak Infinity/NaN into every
  // SVG coordinate. Fall back to a unit box around the point (or origin).
  const xs = boundary.map(p => p.x);
  const ys = boundary.map(p => p.y);
  if (boundary.length < 2) {
    const cx = boundary.length === 1 ? boundary[0].x : 0;
    const cy = boundary.length === 1 ? boundary[0].y : 0;
    xs.length = 0; ys.length = 0;
    xs.push(cx - 0.5, cx + 0.5);
    ys.push(cy - 0.5, cy + 0.5);
  }
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const spanX = Math.max(maxX - minX, 1);
  const spanY = Math.max(maxY - minY, 1);
  const s = Math.min((W - 2 * PAD) / spanX, (H - 2 * PAD) / spanY);
  const ox = (W - s * spanX) / 2;
  const oy = (H - s * spanY) / 2;
  const t = (p: Pt): Pt => ({
    x: ox + (p.x - minX) * s,
    y: H - (oy + (p.y - minY) * s),
  });
  // Drawn site extent in SVG px — extreme-aspect parcels collapse one axis.
  return { t, s, drawnW: s * spanX, drawnH: s * spanY };
}

function polyPath(pts: Pt[], t: (p: Pt) => Pt, close = true): string {
  if (!pts.length) return '';
  const d = pts.map((p, i) => {
    const q = t(p);
    return `${i === 0 ? 'M' : 'L'}${q.x.toFixed(1)} ${q.y.toFixed(1)}`;
  }).join(' ');
  return close ? d + ' Z' : d;
}

// Convert a closed road edge path (lines + fillet arcs) to a point list by
// sampling arcs — plenty accurate at thumbnail scale.
function edgePathPoints(segs: RoadEdgeSeg[]): Pt[] {
  const pts: Pt[] = [];
  for (const seg of segs) {
    if (seg.kind === 'line') {
      pts.push(seg.a, seg.b);
    } else {
      const { c, r, start, end, ccw } = seg;
      let sweep = ccw ? end - start : start - end;
      while (sweep < 0) sweep += Math.PI * 2;
      const n = Math.max(2, Math.ceil(sweep / (Math.PI / 8)));
      for (let i = 0; i <= n; i++) {
        const a = ccw ? start + (sweep * i) / n : start - (sweep * i) / n;
        pts.push({ x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) });
      }
    }
  }
  return pts;
}

// Corners of a rotated rectangle centered at (x, y), plan feet.
function rectCorners(x: number, y: number, length: number, width: number, rotation: number): Pt[] {
  const hx = length / 2, hy = width / 2;
  const cos = Math.cos(rotation), sin = Math.sin(rotation);
  return [
    { x: -hx, y: -hy }, { x: hx, y: -hy }, { x: hx, y: hy }, { x: -hx, y: hy },
  ].map(p => ({ x: x + p.x * cos - p.y * sin, y: y + p.x * sin + p.y * cos }));
}

function equipColor(kind: PlacedEquipment['kind']): string {
  switch (kind) {
    case 'bess': return '#22d3ee';
    case 'inverter': return '#facc15';
    default: return '#94a3b8';
  }
}

export function ArrangementThumbnail({
  design,
  referenceFence,
}: {
  design: SiteDesign;
  // Fence of the currently-active arrangement, ghost-outlined on the other
  // thumbnails so footprint differences pop at a glance.
  referenceFence?: Pt[];
}) {
  const model = useMemo(() => {
    const { t, s, drawnW, drawnH } = makeTransform(design.boundary.polygon);

    // Scale markers with the smaller drawn dimension so they never swamp a
    // thin-strip site, clamped so they stay legible on normal parcels.
    const minExtent = Math.min(drawnW, drawnH);
    const markerScale = Math.max(0.45, Math.min(1, minExtent / 45));

    const boundaryD = polyPath(design.boundary.polygon, t);
    const fenceD = showSeparateFence(design) ? polyPath(design.fence, t) : '';
    const refFenceD = referenceFence && referenceFence.length ? polyPath(referenceFence, t) : '';

    // Gate marker: small tick + dot at the gate location on the fence.
    let gate: { x: number; y: number } | null = null;
    if (design.gate) {
      const q = t({ x: design.gate.x, y: design.gate.y });
      gate = { x: q.x, y: q.y };
    }

    // On huge parcels the px-per-foot scale can shrink drawn features below a
    // pixel, making the yard look empty. Inflate any sub-pixel dimension (in
    // feet, before transform) so each rect draws at least ~1.2px per side.
    // Normal-scale thumbnails are untouched because the max() is a no-op.
    const MIN_PX = 1.2;
    const minFt = MIN_PX / s;

    // Road region: one path with outer loop + island holes (even-odd fill).
    // When a 30 ft road draws below ~1 px the filled region can vanish; add a
    // minimum-width stroke fallback so the network stays detectable.
    let roadD = '';
    const roadStroke = 30 * s < MIN_PX;
    if (design.roadNetwork) {
      roadD = polyPath(edgePathPoints(design.roadNetwork.outer), t);
      for (const isl of design.roadNetwork.islands) {
        roadD += ' ' + polyPath(edgePathPoints(isl), t);
      }
    }
    // Entrance/aisle strips get the same minFt inflation as equipment rects
    // so they can't collapse below a pixel on huge parcels.
    const roadRect = (r: RoadSegment) =>
      polyPath(rectCorners(r.x, r.y, Math.max(r.length, minFt), Math.max(r.width, minFt), r.rotation), t);
    const entranceDs = design.roads.map(roadRect);
    // Compact mode has no roadNetwork; fall back to aisle strips.
    const aisleDs = design.roadNetwork ? [] : design.aisles.map(roadRect);

    const equipRects = design.equipment
      .filter(e => e.kind === 'bess' || e.kind === 'inverter')
      .map(e => ({
        d: polyPath(
          rectCorners(e.x, e.y, Math.max(e.length, minFt), Math.max(e.width, minFt), e.rotation),
          t
        ),
        color: equipColor(e.kind),
      }));

    // Same sub-pixel inflation for augmentation/reserved zones so their
    // outlines/fills stay detectable at extreme parcel scales.
    const augDs = design.augmentationZones.map(z =>
      polyPath(rectCorners(z.x, z.y, Math.max(z.length, minFt), Math.max(z.width, minFt), 0), t)
    );
    const reservedDs = design.reservedZones.map(z =>
      polyPath(rectCorners(z.x, z.y, Math.max(z.length, minFt), Math.max(z.width, minFt), 0), t)
    );

    return { boundaryD, fenceD, refFenceD, gate, roadD, roadStroke, entranceDs, aisleDs, equipRects, augDs, reservedDs, markerScale };
  }, [design, referenceFence]);

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="w-full h-auto rounded bg-slate-900 border border-slate-700/60"
      role="img"
      aria-label="Arrangement plan-view thumbnail"
    >
      {/* Lot line: always the property-line purple, never a blue-ish gray
          (see propertyLineColor.ts). */}
      {model.boundaryD && (
        <path d={model.boundaryD} fill="none" stroke={PROPERTY_LINE_HEX} strokeWidth={1} strokeDasharray="4 2" />
      )}
      {model.roadD && (
        <path
          d={model.roadD}
          fill="#475569"
          fillRule="evenodd"
          stroke={model.roadStroke ? '#475569' : 'none'}
          strokeWidth={model.roadStroke ? 1.2 : 0}
          opacity={0.7}
        />
      )}
      {model.entranceDs.map((d, i) => (
        <path key={`ent-${i}`} d={d} fill="#475569" opacity={0.7} />
      ))}
      {model.aisleDs.map((d, i) => (
        <path key={`aisle-${i}`} d={d} fill="#475569" opacity={0.7} />
      ))}
      {model.fenceD && <path d={model.fenceD} fill="none" stroke="#e2e8f0" strokeWidth={1} />}
      {model.reservedDs.map((d, i) => (
        <path key={`res-${i}`} d={d} fill="#7c3aed" opacity={0.35} />
      ))}
      {model.augDs.map((d, i) => (
        <path key={`aug-${i}`} d={d} fill="none" stroke="#f59e0b" strokeWidth={0.75} strokeDasharray="2 1.5" />
      ))}
      {model.equipRects.map((r, i) => (
        <path key={`eq-${i}`} d={r.d} fill={r.color} opacity={0.9} />
      ))}
      {/* Ghost fence of the active arrangement: green, so the dashed purple
          lot line stays the only purple/magenta linework in the thumbnail. */}
      {model.refFenceD && (
        <path
          d={model.refFenceD}
          fill="none"
          stroke="#4ade80"
          strokeWidth={1}
          strokeDasharray="3 2"
          opacity={0.8}
        />
      )}
      {model.gate && (
        <g>
          <circle
            cx={model.gate.x}
            cy={model.gate.y}
            r={4.5 * model.markerScale}
            fill="#f97316"
            stroke="#0f172a"
            strokeWidth={Math.max(0.5, model.markerScale)}
          />
          {model.markerScale >= 0.65 && (
            <text
              x={model.gate.x}
              y={model.gate.y + 2.4 * model.markerScale}
              textAnchor="middle"
              fontSize={6.5 * model.markerScale}
              fontWeight={700}
              fill="#0f172a"
              style={{ userSelect: 'none' }}
            >
              G
            </text>
          )}
        </g>
      )}
      {/* North arrow (plan y = north = SVG up), pinned to the top-right corner.
          Shrinks (never below 70%) with the drawn site so it can't obscure a
          layout that stretches into the corner on extreme-aspect parcels. */}
      <g
        transform={`translate(${W - 11}, 15) scale(${Math.max(0.7, model.markerScale)})`}
        opacity={0.9}
      >
        <line x1={0} y1={7} x2={0} y2={-4} stroke="#e2e8f0" strokeWidth={1} />
        <path d="M0 -7 L2.6 -1.5 L0 -3 L-2.6 -1.5 Z" fill="#e2e8f0" />
        <text x={0} y={14} textAnchor="middle" fontSize={6} fontWeight={700} fill="#94a3b8" style={{ userSelect: 'none' }}>
          N
        </text>
      </g>
    </svg>
  );
}
