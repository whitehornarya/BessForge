// 3D CAD drawing view: renders the design as DXF-style linework inside the
// interactive 3D scene. The geometry is NOT re-derived — it is the exact
// display list the DXF exporter records (composeDesignDxf mirrors every
// entity into DxfWriter.ops), so the CAD view is WYSIWYG with the exported
// drawing: same rectangles, polylines, trench bands, hatches, labels and
// ACI layer colors. Display only — nothing here feeds back into layout math
// or exports.
//
// [662] Text-label editing: each text label gets an invisible click target.
// Clicking selects it (calls onSelectText); dragging repositions it via a
// large invisible drag-capture plane. Overlapping label pairs are highlighted
// in red. Overrides are stored in textOverrides (store) and applied to both
// the CAD view and all DXF/PDF exports.
import { useEffect, useMemo, useState, useRef, useCallback } from 'react';
import * as THREE from 'three';
import { Text } from '@react-three/drei';
import { useThree } from '@react-three/fiber';
import { SiteDesign } from '../lib/nextera/types';
import { DxfWriter, composeDesignDxf, DisplayOp, LINETYPE_PATTERNS, LAYERS, textOverrideKey } from '../lib/nextera/dxfExport';
import { composeSiteDxf, ComposedAreaRange } from '../lib/nextera/siteCompose';
import { areaFeederEndpoint } from '../lib/nextera/substationTakeoffs';
import { ansi37Segments } from '../lib/nextera/hatchPatterns';
import { getEffectiveConfiguration } from '../lib/nextera/catalog';
import { FEEDER_PALETTE } from '../lib/nextera/feederColors';
import { useDesignStore, TextOverride } from '../lib/stores/useDesignStore';

// ACI color -> screen hex on the dark drawing background (classic AutoCAD
// model-space palette, lightened where the pure hue reads too dark).
const ACI_HEX: Record<number, string> = {
  1: '#ff4d4d',    // red
  2: '#ffee55',    // yellow
  3: '#4dff7a',    // green
  4: '#4defff',    // cyan
  5: '#6f8dff',    // blue (pure #00f is illegible on dark)
  6: '#ff5cff',    // magenta
  7: '#f0f0f0',    // white
  8: '#9aa0a6',    // gray
  9: '#b8bdc3',    // light gray (ECI symbol shading)
  23: '#946e4c',   // pond border brown (reference dry pond edge)
  30: '#ff9a33',   // orange
  33: '#dbcec3',   // dry pond light tan fill (reference legend)
  32: '#d98e56',   // brown-orange (index contours)
  34: '#c9a06a',   // tan (crushed rock)
  40: '#e6c229',   // gold
  84: '#63c76a',   // muted green (grounding)
  140: '#7dd3fc',  // sky blue
  150: '#3b7af7',  // wet pond border blue (reference wet pond edge)
  151: '#bdd2fc',  // wet pond light blue fill (reference legend)
  200: '#c58aff',  // purple
  253: '#565b63',  // light-gray road fill -> muted on dark bg
  255: '#101418',  // label mask: paints the CAD background (wipeout on dark)
};
for (const fc of FEEDER_PALETTE) ACI_HEX[fc.aci] = ACI_HEX[fc.aci] ?? fc.hex;
// Shared with the WebGL-free Canvas2D fallback (PlanFallback2D) so both
// renderers of the same display list use identical layer colors.
export const aciHex = (aci: number | undefined): string => ACI_HEX[aci ?? 7] ?? '#f0f0f0';

// Inactive-area tint (multi-area sites): the same hue blended toward the dark
// drawing background so a non-active yard still reads as real linework in its
// true colors, just quieter than the yard being edited. Kept as a color blend
// rather than a material opacity change so the merged LineSegments buckets
// (which key on color) separate active from inactive geometry automatically.
const DIM_MIX = 0.55; // fraction of the original color retained
export function dimHex(hex: string): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  // Background #101418 — blending toward it keeps dimmed linework sitting
  // naturally on the drawing sheet instead of turning muddy gray.
  const bg = [0x10, 0x14, 0x18];
  const out = [(n >> 16) & 255, (n >> 8) & 255, n & 255]
    .map((c, i) => Math.round(c * DIM_MIX + bg[i] * (1 - DIM_MIX)));
  return '#' + out.map(c => c.toString(16).padStart(2, '0')).join('');
}

/** Layer visibility groups for the CAD view overlay panel. */
export interface CadLayerVis {
  labels: boolean;
  dims: boolean;
  equip: boolean;
  cables: boolean;
  feederNotes: boolean;
}

/** Default: no CAD-only filtering. Project drawing-content visibility is
 * applied canonically by DxfWriter before this renderer receives any ops. */
export const CAD_LAYER_VIS_DEFAULT: CadLayerVis = {
  labels: true, dims: true, equip: true, cables: true, feederNotes: true,
};

/** Maps a DXF layer name to one of the four user-visible overlay groups.
 *  Returns null for layers that are always shown (fence, boundary, roads,
 *  and the TEXT_LG chrome layer which carries sheet borders, title block,
 *  north arrow, logo, and legend frame — never user-toggleable). */
function layerGroup(layer: string): keyof CadLayerVis | null {
  // Labels: equipment annotation text and label wipeout masks.
  // NOTE: TEXT_LG is intentionally excluded here — it is the sheet chrome
  // layer (frame borders, title block, north arrow, logo, legend frame,
  // ECI legend swatches) and must always be visible.
  if (layer === LAYERS.EQUIP_LABELS || layer === LAYERS.TEXT_SM ||
      layer === LAYERS.LABEL_MASK) return 'labels';
  // Dimensions: callout lines/text and equipment schedule table.
  if (layer === LAYERS.DIMS || layer === LAYERS.SCHEDULE) return 'dims';
  // Equipment outlines: BESS containers, laydown area, future blocks, grounding,
  // and ECI yard-symbol traced geometry.  SYM_GRAY/SYM_DARK are the layers
  // drawEquipment() uses for ECI mode yard geometry (gray shading + dark
  // linework respectively) — they must toggle together with Equipment outlines.
  if (layer === LAYERS.EQUIP      || layer === LAYERS.LAYDOWN      ||
      layer === LAYERS.FUTURE_BESS || layer === LAYERS.GROUNDING    ||
      layer === LAYERS.SYM_GRAY   || layer === LAYERS.SYM_DARK) return 'equip';
  // Cables and trenches: all electrical run layers.
  if (layer === LAYERS.CABLE_DC      || layer === LAYERS.CABLE_DC_POS ||
      layer === LAYERS.CABLE_DC_NEG  || layer === LAYERS.CABLE_MV     ||
      layer === LAYERS.CABLE_LVAC    || layer === LAYERS.CABLE_FIBER   ||
      layer === LAYERS.CABLE_DC_REF  || layer === LAYERS.CABLE_MV_REF  ||
      layer === LAYERS.TRENCH        || layer === LAYERS.FEEDER        ||
      layer === LAYERS.AUX_FEEDER) return 'cables';
  // Everything else is always shown (fence, boundary, road, satellite, sheet
  // frame, and the TEXT_LG chrome layer — see JSDoc above).
  return null;
}

/** Feeder and NFPA annotations share general text layers with other drawing
 * labels, so classify them by their emitted content only in the CAD view. */
function textGroup(layer: string, text: string): keyof CadLayerVis | null {
  if (/\bFEEDER\b/i.test(text) || /\bNFPA\b/i.test(text)) return 'feederNotes';
  return layerGroup(layer);
}

// Draw heights (ft above the dark ground plane): hatch fills lowest, then
// linework, then text — generous separations per the z-fighting convention
// for parcel-scale scenes.
const HATCH_Y = 0.1;
const LINE_Y = 0.3;
const TEXT_Y = 0.5;

// [662] Info surfaced to the parent for the floating edit panel.
export interface SelectedTextInfo {
  /** Fingerprint key (layer|text|roundX|roundY). Stable across re-layouts. */
  key: string;
  /** Current override applied (empty override = no change from generated). */
  override: TextOverride;
  /** Original generated text (before any override). */
  origText: string;
  /** Original generated height in layout feet. */
  origH: number;
}

interface TextOp {
  /** Current display position (after override applied). */
  x: number; y: number;
  /** Current height and text (after override). */
  h: number; text: string;
  rot: number; hex: string;
  centered?: boolean;
  group: keyof CadLayerVis | null;
  // [662] Fingerprint and edit metadata:
  /** Stable fingerprint key (uses ORIGINAL op.x/op.y from dxf.ops). */
  key: string;
  /** Current dx/dy override (0,0 if none). */
  curDx: number; curDy: number;
  /** Original generated text and height (before any override). */
  origText: string; origH: number;
  /** Approximate AABB half-widths for overlap detection (in layout feet). */
  halfW: number; halfH: number;
  /** False for labels belonging to a non-active area on a multi-area site:
   *  they render, but they cannot be selected or dragged. */
  editable?: boolean;
}

interface Built {
  lines: THREE.LineSegments[];
  lineGroups: (keyof CadLayerVis | null)[];
  hatches: THREE.Mesh[];
  hatchGroups: (keyof CadLayerVis | null)[];
  texts: TextOp[];
}

/** Resolve which composed area an op index belongs to. Returns null for
 *  sheet-level ops (frame, title block) and for single-area projects, where
 *  there are no ranges and every op is simply "the drawing". */
function areaOfOp(ranges: ComposedAreaRange[], i: number): ComposedAreaRange | null {
  for (const r of ranges) if (i >= r.opStart && i < r.opEnd) return r;
  return null;
}

// Tessellate an arc op into segment pairs (plan coords).
function arcSegments(op: Extract<DisplayOp, { kind: 'arc' }>, out: number[], y: number) {
  let { start, end } = op;
  if (op.ccw && end < start) end += Math.PI * 2;
  if (!op.ccw && end > start) end -= Math.PI * 2;
  const steps = Math.max(4, Math.ceil(Math.abs(end - start) / 0.12));
  let px = op.cx + op.r * Math.cos(start);
  let py = op.cy + op.r * Math.sin(start);
  for (let i = 1; i <= steps; i++) {
    const a = start + ((end - start) * i) / steps;
    const x = op.cx + op.r * Math.cos(a);
    const yy = op.cy + op.r * Math.sin(a);
    out.push(px, y, -py, x, y, -yy);
    px = x; py = yy;
  }
}

function buildObjects(
  dxf: DxfWriter,
  textOverrides: Record<string, TextOverride>,
  ranges: ComposedAreaRange[] = [],
): Built {
  // Multi-area sites dim every INACTIVE area's linework so the drafter can
  // still tell which yard they are editing. Single-area projects have no
  // ranges, so nothing is dimmed and the render is unchanged.
  const multi = ranges.length > 1;
  // Segment buckets keyed by `${hex}|${dashed}|${group}` -> flat xyz pairs.
  // The group tag is part of the key so lines from different overlay groups
  // are never merged into the same LineSegments — required for per-group
  // visibility filtering at render time without rebuilding geometry.
  type BucketVal = { pts: number[]; grp: keyof CadLayerVis | null };
  const buckets = new Map<string, BucketVal>();
  const seg = (hex: string, dashed: string | boolean, grp: keyof CadLayerVis | null) => {
    const key = `${hex}|${dashed || ''}|${grp ?? ''}`;
    let val = buckets.get(key);
    if (!val) { val = { pts: [], grp }; buckets.set(key, val); }
    return val.pts;
  };
  const opHex = (layer: string, color?: number) =>
    aciHex(color !== undefined ? color : dxf.layerColors[layer]);
  const opDashed = (layer: string) => {
    const lt = dxf.layerLineTypes[layer] ?? 'CONTINUOUS';
    return lt === 'CONTINUOUS' ? '' : lt;
  };

  const hatches: THREE.Mesh[] = [];
  const hatchGroups: (keyof CadLayerVis | null)[] = [];
  const texts: TextOp[] = [];

  // Per-op area lookup. Ops are composed in area order, so walking a cursor
  // through the (sorted, non-overlapping) ranges is O(ops) rather than
  // O(ops x areas) — a six-area yard emits hundreds of thousands of ops.
  let rangeCursor = 0;
  const areaAt = (i: number): ComposedAreaRange | null => {
    if (!multi) return null;
    while (rangeCursor < ranges.length && i >= ranges[rangeCursor].opEnd) rangeCursor++;
    const r = ranges[rangeCursor];
    return r && i >= r.opStart && i < r.opEnd ? r : null;
  };

  for (let opIdx = 0; opIdx < dxf.ops.length; opIdx++) {
    const op = dxf.ops[opIdx];
    // Inactive areas render dimmed so the yard being edited stays obvious.
    // Sheet-level ops (frame, title block) belong to no area and never dim.
    const ar = areaAt(opIdx);
    const dim = !!ar && !ar.active;
    const opHexA = (layer: string, color?: number) => {
      const hex = opHex(layer, color);
      return dim ? dimHex(hex) : hex;
    };
    switch (op.kind) {
      case 'line': {
        const grp = layerGroup(op.layer);
        seg(opHexA(op.layer, op.color), opDashed(op.layer), grp)
          .push(op.x1, LINE_Y, -op.y1, op.x2, LINE_Y, -op.y2);
        break;
      }
      case 'poly': {
        const grp = layerGroup(op.layer);
        const arr = seg(opHexA(op.layer, op.color), opDashed(op.layer), grp);
        const n = op.pts.length;
        for (let i = 0; i < n - 1; i++) {
          arr.push(op.pts[i][0], LINE_Y, -op.pts[i][1], op.pts[i + 1][0], LINE_Y, -op.pts[i + 1][1]);
        }
        if (op.closed && n > 2) {
          arr.push(op.pts[n - 1][0], LINE_Y, -op.pts[n - 1][1], op.pts[0][0], LINE_Y, -op.pts[0][1]);
        }
        break;
      }
      case 'arc': {
        const grp = layerGroup(op.layer);
        arcSegments(op, seg(opHexA(op.layer), opDashed(op.layer), grp), LINE_Y);
        break;
      }
      case 'text': {
        // Composer-centered ops carry the true center (cx/cy) — anchor the
        // glyph run there so the CAD view matches the DXF center
        // justification instead of the estimated left anchor (task #649).
        const cx = (op as any).cx as number | undefined;
        const cy = (op as any).cy as number | undefined;
        const grp = textGroup(op.layer, op.text);
        // [662] Build fingerprint from the ORIGINAL generated op.x/op.y so it
        // matches what patchTextOverridesForExport uses. Apply any override.
        const fp = textOverrideKey(op);
        const ov = textOverrides[fp];
        const curDx = ov?.dx ?? 0;
        const curDy = ov?.dy ?? 0;
        const curH = ov?.h ?? op.h;
        const curText = ov?.text ?? op.text;
        // Display position: center (cx/cy) + override offset for centered text,
        // op.x/op.y + offset for left-anchored text.
        const baseX = cx !== undefined ? cx : op.x;
        const baseY = cx !== undefined ? (cy ?? op.y) : op.y;
        const dispX = baseX + curDx;
        const dispY = baseY + curDy;
        const halfW = (curText.length * curH * 0.5) / 2;
        const halfH = curH / 2;
        texts.push({
          x: dispX, y: dispY,
          h: curH, text: curText,
          rot: op.rot,
          hex: opHexA(op.layer, op.color),
          centered: cx !== undefined,
          group: grp,
          key: fp,
          curDx, curDy,
          origText: op.text,
          origH: op.h,
          halfW, halfH,
          // Text editing stays confined to the area being edited: a label in
          // another yard belongs to a design the drafter is not editing, and
          // dragging it would write an override keyed to that area's geometry.
          editable: !dim,
        });
        break;
      }
      case 'hatch': {
        // Faint fill in the layer color; first loop is the outer boundary,
        // remaining loops render as holes (even-odd islands stay unfilled).
        const outer = op.loops[0];
        if (!outer || outer.length < 3) break;
        const grp = layerGroup(op.layer);
        // ANSI37 cross-hatch mesh (future augmentation areas): draw the
        // actual pattern segments the DXF pattern defines, so the CAD view
        // shows the same mesh the exported drawing contains.
        if (op.pattern === 'ANSI37') {
          const arr = seg(opHex(op.layer, op.color), false, grp);
          for (const [x1, y1, x2, y2] of ansi37Segments(op.loops)) {
            arr.push(x1, LINE_Y, -y1, x2, LINE_Y, -y2);
          }
        }
        const shape = new THREE.Shape(outer.map(p => new THREE.Vector2(p[0], p[1])));
        const outerArea = signedArea(outer);
        for (let i = 1; i < op.loops.length; i++) {
          const h = op.loops[i];
          if (h.length < 3) continue;
          const pts = outerArea * signedArea(h) > 0 ? [...h].reverse() : h;
          shape.holes.push(new THREE.Path(pts.map(p => new THREE.Vector2(p[0], p[1]))));
        }
        const geo = new THREE.ShapeGeometry(shape);
        const mat = new THREE.MeshBasicMaterial({
          color: opHex(op.layer, op.color),
          // Label masks are DXF wipeouts — correct on white paper but
          // visually destructive in the dark CAD scene (opaque black tiles
          // cover 3D GLB models). Render with opacity 0 so everything
          // beneath shows through. All other hatches keep their translucent
          // fills so road/trench/hatch areas read as fills without hiding
          // linework behind them.
          transparent: true,
          opacity: op.layer === LAYERS.LABEL_MASK ? 0
            : op.pattern === 'SOLID' ? 0.35
            : op.pattern === 'ANSI31' || op.pattern === 'ANSI37' ? 0.16 : 0.1,
          depthWrite: false,
          side: THREE.DoubleSide,
        });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.rotation.x = -Math.PI / 2; // plan (x, y) -> scene (x, 0, -y)
        // Cap the per-hatch Y increment: ECI yard symbols emit hundreds of
        // SOLID-pattern polygon rings per container (one hatch mesh per ring).
        // An uncapped 0.005 ft/mesh accumulation pushes the last ECI hatch
        // mesh 5–10 ft above the ground plane in a full yard, making them
        // "float" visibly over the DXF linework in the perspective CAD view.
        // Capping at 20 steps (0.1 ft headroom, well below LINE_Y = 0.3 ft)
        // preserves z-fighting separation for the structural hatches (road
        // fills, trench, ANSI37 aug areas) that appear early in the op list,
        // while ECI polygon rings at index 20+ share the 0.2 ft plane where
        // they never overlap each other so z-fighting cannot occur.
        mesh.position.y = HATCH_Y + Math.min(hatches.length, 20) * 0.005;
        hatches.push(mesh);
        hatchGroups.push(grp);
        break;
      }
    }
  }

  const lines: THREE.LineSegments[] = [];
  const lineGroups: (keyof CadLayerVis | null)[] = [];
  for (const [key, { pts, grp }] of Array.from(buckets.entries())) {
    const [hex, ltName] = key.split('|');
    const dashed = !!ltName;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pts), 3));
    // Approximate multi-element LTYPE patterns with dash/gap: dash = first
    // positive element (dots get a small visible dash), gap = sum of gaps
    // + dots after it, so DASHDOT/DOT read distinctly from plain DASHED.
    // LineDashedMaterial only supports one dash+gap pair; the DXF/PDF carry
    // the exact patterns (shared LINETYPE_PATTERNS source).
    const pat = LINETYPE_PATTERNS[ltName] ?? [];
    const dashSize = Math.max(pat.find(e => e > 0) ?? 0, 0.8);
    const gapSize = Math.max(pat.length ? pat.slice(1).reduce((s, e) => s + Math.max(-e, e === 0 ? 0.8 : 0), 0) : 0, 1.5);
    const mat = dashed
      ? new THREE.LineDashedMaterial({ color: hex, dashSize, gapSize })
      : new THREE.LineBasicMaterial({ color: hex });
    const obj = new THREE.LineSegments(geo, mat);
    if (dashed) obj.computeLineDistances();
    lines.push(obj);
    lineGroups.push(grp);
  }
  return { lines, lineGroups, hatches, hatchGroups, texts };
}

function signedArea(pts: number[][]): number {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const q = pts[(i + 1) % pts.length];
    s += pts[i][0] * q[1] - q[0] * pts[i][1];
  }
  return s / 2;
}

// [662] Compute which text indices overlap (naive AABB pairwise check).
// Returns a Set of indices that overlap with at least one other label.
function computeOverlapIndices(texts: TextOp[]): Set<number> {
  const overlapping = new Set<number>();
  for (let i = 0; i < texts.length; i++) {
    // Overlap flagging is an editing aid for the yard being edited. On a
    // multi-area site the other areas' labels are reference linework the
    // drafter cannot move here, so flagging them would paint most of the
    // drawing red with collisions they cannot act on.
    if (texts[i].editable === false) continue;
    for (let j = i + 1; j < texts.length; j++) {
      if (texts[j].editable === false) continue;
      const a = texts[i], b = texts[j];
      const axMin = a.x - a.halfW, axMax = a.x + a.halfW;
      const ayMin = a.y - a.halfH, ayMax = a.y + a.halfH;
      const bxMin = b.x - b.halfW, bxMax = b.x + b.halfW;
      const byMin = b.y - b.halfH, byMax = b.y + b.halfH;
      if (axMax > bxMin && bxMax > axMin && ayMax > byMin && byMax > ayMin) {
        overlapping.add(i);
        overlapping.add(j);
      }
    }
  }
  return overlapping;
}

// [662] Highlight ring rendered around a selected or overlapping text label.
// Rendered as a THREE.LineLoop (closed rectangle outline) at TEXT_Y + epsilon.
function TextHighlightRing({ t, color, yOffset = 0 }: { t: TextOp; color: string; yOffset?: number }) {
  const pad = t.h * 0.15;
  const hw = t.halfW + pad;
  const hh = t.halfH + pad;
  const cx = t.x, cy = t.y + t.halfH; // cy = baseline + halfH = center
  const lineLoop = useMemo(() => {
    const y = TEXT_Y + 0.05 + yOffset;
    const positions = new Float32Array([
      cx - hw, y, -(cy - hh),
      cx + hw, y, -(cy - hh),
      cx + hw, y, -(cy + hh),
      cx - hw, y, -(cy + hh),
    ]);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.LineBasicMaterial({ color });
    return new THREE.LineLoop(geo, mat);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cx, cy, hw, hh, yOffset, color]);
  useEffect(() => () => {
    lineLoop.geometry.dispose();
    (lineLoop.material as THREE.Material).dispose();
  }, [lineLoop]);
  return <primitive object={lineLoop} />;
}

// Drag state stored in a ref so it doesn't cause re-renders mid-drag.
interface DragRef {
  key: string;
  /** World-space start position of pointer on the drag plane (TEXT_Y height). */
  worldStartX: number;
  worldStartZ: number;
  /** Override dx/dy at drag start. */
  origDx: number;
  origDy: number;
}

interface Props {
  design: SiteDesign;
  vis?: CadLayerVis;
  /** Called when the user selects / deselects a text label. */
  onSelectText?: (info: SelectedTextInfo | null) => void;
  /** Called with true on drag start, false on drag end. */
  onDraggingChange?: (dragging: boolean) => void;
}

export default function CadLinework({ design, vis, onSelectText, onDraggingChange }: Props) {
  const boundary = useDesignStore(s => s.boundary);
  const configId = useDesignStore(s => s.configId);
  const containersPerPcs = useDesignStore(s => s.containersPerPcs);
  const titleBlock = useDesignStore(s => s.titleBlock);
  const feeders = useDesignStore(s => s.feeders);
  const substation = useDesignStore(s => s.substation);
  const areaZones = useDesignStore(s => s.areaZones);
  const eciLegend = useDesignStore(s => s.eciLegend);
  const drawingVisibility = useDesignStore(s => s.drawingVisibility);
  const textOverrides = useDesignStore(s => s.textOverrides);
  const setTextOverride = useDesignStore(s => s.setTextOverride);
  // Multi-area sites compose every footprint into the drawing; single-area
  // projects leave siteAreas empty and take the untouched legacy path.
  const siteAreas = useDesignStore(s => s.siteAreas);
  const activeAreaId = useDesignStore(s => s.activeAreaId);
  // Every OTHER area's routed circuits, so the CAD view shows the whole
  // collection system instead of only the yard being edited.
  const areaFeeders = useDesignStore(s => s.areaFeeders);
  const invalidate = useThree(s => s.invalidate);

  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const dragRef = useRef<DragRef | null>(null);

  const built = useMemo<Built>(() => {
    const config = getEffectiveConfiguration(configId, containersPerPcs);
    const projName = titleBlock.projectName.trim() || boundary?.name || 'Site';
    const dxf = new DxfWriter(drawingVisibility);
    // Same composition (and parameters) the DXF download / PDF plot use, so
    // the on-screen drawing can never drift from the deliverable. On a
    // multi-area site this composes EVERY area into the shared frame; a
    // single-area project delegates to the identical legacy call.
    const ranges = composeSiteDxf(dxf, {
      areas: siteAreas,
      activeAreaId,
      design,
      projectName: projName,
      config,
      meta: titleBlock,
      feeders,
      substation,
      areaFeeders,
      areaZones: areaZones.length ? areaZones : undefined,
      sheetExtras: eciLegend ? { eciLegend: true } : undefined,
    });
    return buildObjects(dxf, textOverrides, ranges);
  }, [design, configId, containersPerPcs, titleBlock, boundary, feeders, substation, areaZones,
      eciLegend, drawingVisibility, textOverrides, siteAreas, activeAreaId, areaFeeders]);

  // Dispose replaced geometry/materials; demand frameloop needs an explicit
  // repaint whenever the built objects change.
  useEffect(() => {
    invalidate();
    return () => {
      for (const l of built.lines) { l.geometry.dispose(); (l.material as THREE.Material).dispose(); }
      for (const m of built.hatches) { m.geometry.dispose(); (m.material as THREE.Material).dispose(); }
    };
  }, [built, invalidate]);

  // If the selected label was removed (re-layout wiped it), clear selection.
  useEffect(() => {
    if (selectedKey && !built.texts.some(t => t.key === selectedKey)) {
      setSelectedKey(null);
      onSelectText?.(null);
    }
  }, [built.texts, selectedKey, onSelectText]);

  // Overlap indices (recomputed whenever texts change).
  const overlapIndices = useMemo(() => computeOverlapIndices(built.texts), [built.texts]);

  // Resolve effective visibility (default: all groups on).
  const v = vis ?? CAD_LAYER_VIS_DEFAULT;
  const visLine  = (g: keyof CadLayerVis | null) => g === null || v[g];
  const visHatch = (g: keyof CadLayerVis | null) => g === null || v[g];
  const visText  = (g: keyof CadLayerVis | null) => g === null || v[g];

  // Handler: user clicks a text label → select it.
  const handleTextPointerDown = useCallback((e: any, t: TextOp) => {
    e.stopPropagation();
    setSelectedKey(t.key);
    const ov = textOverrides[t.key] ?? { dx: 0, dy: 0 };
    onSelectText?.({
      key: t.key,
      override: { dx: t.curDx, dy: t.curDy, text: ov.text, h: ov.h },
      origText: t.origText,
      origH: t.origH,
    });
    // Begin drag tracking.
    dragRef.current = {
      key: t.key,
      worldStartX: e.point.x,
      worldStartZ: e.point.z,
      origDx: t.curDx,
      origDy: t.curDy,
    };
    setIsDragging(true);
    onDraggingChange?.(true);
  }, [textOverrides, onSelectText, onDraggingChange]);

  // Handler: pointer moves on the large drag-capture plane.
  const handleDragPlaneMove = useCallback((e: any) => {
    const dr = dragRef.current;
    if (!dr) return;
    e.stopPropagation();
    const dx = e.point.x - dr.worldStartX;
    // scene z = -plan y, so plan dy = -(scene dz)
    const dy = -(e.point.z - dr.worldStartZ);
    const newDx = dr.origDx + dx;
    const newDy = dr.origDy + dy;
    // Live-update the override so the label moves as the user drags.
    const existing = textOverrides[dr.key] ?? { dx: 0, dy: 0 };
    setTextOverride(dr.key, { ...existing, dx: newDx, dy: newDy });
    // Update the selection info panel.
    const t = built.texts.find(x => x.key === dr.key);
    if (t) {
      onSelectText?.({
        key: dr.key,
        override: { dx: newDx, dy: newDy, text: existing.text, h: existing.h },
        origText: t.origText,
        origH: t.origH,
      });
    }
  }, [textOverrides, setTextOverride, built.texts, onSelectText]);

  // Handler: pointer up on drag plane → commit and stop dragging.
  const handleDragPlaneUp = useCallback((e: any) => {
    const dr = dragRef.current;
    if (!dr) return;
    e.stopPropagation();
    const dx = e.point.x - dr.worldStartX;
    const dy = -(e.point.z - dr.worldStartZ);
    const newDx = dr.origDx + dx;
    const newDy = dr.origDy + dy;
    const existing = textOverrides[dr.key] ?? { dx: 0, dy: 0 };
    setTextOverride(dr.key, { ...existing, dx: newDx, dy: newDy });
    dragRef.current = null;
    setIsDragging(false);
    onDraggingChange?.(false);
    invalidate();
  }, [textOverrides, setTextOverride, onDraggingChange, invalidate]);

  return (
    <group>
      {built.hatches.map((m, i) =>
        visHatch(built.hatchGroups[i]) && <primitive key={`h${i}`} object={m} />
      )}
      {built.lines.map((l, i) =>
        visLine(built.lineGroups[i]) && <primitive key={`l${i}`} object={l} />
      )}
      {built.texts.map((t, i) => (
        visText(t.group) && (
          <group key={`tg${t.key}${i}`}>
            <Text
              position={[t.x, TEXT_Y, -t.y]}
              rotation={[-Math.PI / 2, 0, (t.rot * Math.PI) / 180]}
              fontSize={t.h}
              color={t.hex}
              anchorX={t.centered ? 'center' : 'left'}
              anchorY="bottom"
            >
              {t.text}
            </Text>
            {/* Invisible click/drag target at TEXT_Y + tiny offset. Omitted
                for non-active areas: their labels are reference linework, and
                editing them would write overrides against a design the
                drafter is not currently editing. */}
            {t.editable !== false && (
              <mesh
                position={[t.x, TEXT_Y + 0.02, -t.y - t.halfH]}
                rotation={[-Math.PI / 2, 0, 0]}
                onPointerDown={(e) => handleTextPointerDown(e, t)}
              >
                <planeGeometry args={[t.halfW * 2 + t.h, t.h * 1.4]} />
                <meshBasicMaterial transparent opacity={0} depthWrite={false} />
              </mesh>
            )}
          </group>
        )
      ))}

      {/* [662] Selection highlight ring (yellow) */}
      {selectedKey && (() => {
        const idx = built.texts.findIndex(t => t.key === selectedKey);
        return idx >= 0 && visText(built.texts[idx].group)
          ? <TextHighlightRing key={`sel${selectedKey}`} t={built.texts[idx]} color="#f0d060" />
          : null;
      })()}

      {/* [662] Overlap highlight rings (red) */}
      {Array.from(overlapIndices).map(i => {
        const t = built.texts[i];
        if (!t || t.key === selectedKey || !visText(t.group)) return null;
        return <TextHighlightRing key={`ov${t.key}${i}`} t={t} color="#ff4444" yOffset={0.01} />;
      })}

      {/* [662] Large invisible drag-capture plane — only present while dragging.
          Covers the entire yard so pointer-move events stay captured even when
          the pointer moves off the original click-target mesh. Sits at TEXT_Y. */}
      {isDragging && (
        <mesh
          position={[0, TEXT_Y + 0.03, 0]}
          rotation={[-Math.PI / 2, 0, 0]}
          onPointerMove={handleDragPlaneMove}
          onPointerUp={handleDragPlaneUp}
        >
          <planeGeometry args={[1000000, 1000000]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} side={THREE.DoubleSide} />
        </mesh>
      )}
    </group>
  );
}
