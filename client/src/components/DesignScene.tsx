import { Component, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls, Line, PerspectiveCamera, OrthographicCamera, Text, Billboard, useTexture } from '@react-three/drei';
import { toast } from 'sonner';
import { nexteraLabel } from '../lib/nextera/dxfExport';
import { COVER10_PANEL_ASPECT } from '../lib/nextera/dxfSheets';
import * as THREE from 'three';
import { useDesignStore } from '../lib/stores/useDesignStore';
import { SiteDesign, PlacedEquipment, RoadEdgeSeg, BlockRowInfo, Pt, SubstationTakeoff, takeoffVector, CableRun } from '../lib/nextera/types';
import { effectiveTakeoffs } from '../lib/nextera/substationTakeoffs';
import SheetAnnotations2D from './SheetAnnotations2D';
import RealisticEquipment, { REALISTIC_KINDS } from './RealisticEquipment';
import { computeBlockSpacingDims, expandDim, DIM_TEXT_H } from '../lib/nextera/dimensions';
import { pointInPolygon, rectInsidePolygon, type DrawingLayer } from '../lib/nextera/kmz';
import { generateCableRouting } from '../lib/nextera/cableRouting';
import { CLEARANCES } from '../lib/nextera/catalog';
import { siteAreasBounds } from '../lib/nextera/siteAreas';
import polygonClipping from 'polygon-clipping';
import { getYardTextureSet } from '../lib/textureSets';
import { configureGroundTexture } from '../lib/groundTexture';
import { SatelliteImage, satelliteLocalRect, siteGroundExtent } from '../lib/nextera/satellite';
import { TrenchChannel, GateModel, FencePanels, FeederTrenchChannels, CableTrenchChannels, feederCutStencil, trenchClipPlanes, TRENCH_DEPTH_FT, IslandAlignmentIndicators } from './YardExtras';
import { feederCorridorInfo, feederCorridorRejectReason } from '../lib/nextera/feeders';
import { feederDisplayName } from '../lib/nextera/feederNaming';
import { feederColor, feederTintByInverterId, AUX_FEEDER_COLOR } from '../lib/nextera/feederColors';
import { patchMaterialWithFeederTint, makeFeederTintAttribute } from '../lib/feederTint';
import FirstPersonMode from './FirstPersonMode';
import CinematicTourCamera from './CinematicTour';
import TourShowcase from './TourShowcase';
import { saveBlob } from '../lib/saveFile';
import { TerrainMesh } from './TerrainMesh';
import { terrainLocalRect, computeCutFill } from '../lib/nextera/terrain';
import { buildFgSurface, FgSurface, GradingZone, gradingZonesRejectReason, previewZonePadInfo, ZONE_MIN_SIZE_FT } from '../lib/nextera/gradingSurface';
import { AreaZone, AreaZoneKind, AREA_ZONE_COLORS, AREA_ZONE_BORDER_COLORS, AREA_ZONE_LABELS, AREA_ZONE_KIND_ORDER, AREA_ZONE_MIN_SIZE_FT, areaZonesRejectReason } from '../lib/nextera/areaZones';
import type { ElevationGrid } from '../lib/nextera/terrain';
import { buildDrainageModel, drainageSurfacesFromDesign } from '../lib/nextera/drainage';
import { polygonPivot, resampleGridForYardRotation } from '../lib/nextera/gradingOptimizer';
import { buildGroundingPlan } from '../lib/nextera/grounding';
import { roadCalloutData } from '../lib/nextera/roadCallouts';
import { isClosedPolylineRun } from '../lib/nextera/referenceTrace';
import { waitForSceneReady } from '../lib/sceneReady';
import { drawTourIntro } from '../lib/tourIntroDraw';
import { buildTourIntro, buildTourSampler, feederFlyalongRoute, flightRealisticEnabled } from '../lib/cinematicTour';
import { uhdBoundDims, offlineFrameSchedule, offlineFrameT, pickOfflineCodec, codecToMuxerId, codecContainer, OFFLINE_SUPERSAMPLE } from '../lib/offlineTourRender';
import { Muxer as WebmMuxer, ArrayBufferTarget as WebmTarget } from 'webm-muxer';
import { Muxer as Mp4Muxer, ArrayBufferTarget as Mp4Target } from 'mp4-muxer';
import { getEffectiveConfiguration, getConfiguration } from '../lib/nextera/catalog';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { eciSymbolForEquipment, eciYardSymbolPolys, symbolEquipmentKinds, type SymbolSource } from '../lib/nextera/eciSymbolPlacement';
import CadLinework, { CadLayerVis, CAD_LAYER_VIS_DEFAULT, SelectedTextInfo } from './CadLinework';
import PlanFallback2D from './PlanFallback2D';
import {
  EQUIPMENT_LABEL_BASE_FONT_FT,
  EQUIPMENT_LABEL_MAX_DISTANCE_SCALE,
  EQUIPMENT_LABEL_OUTLINE_FT,
  equipmentLabelEstimatedBounds,
  equipmentLabelFontSize,
  equipmentLabelMaxScale,
  equipmentLabelRotation,
} from '../lib/nextera/sceneLabels';

// Tessellate a closed line/arc edge path into a flat point list (plan feet)
import { showcaseFrameCount, showcaseFrameMs } from '../lib/tourShowcaseTimeline';
// Signed area of a plan polygon (positive = CCW)
import { partitionSceneEquipment } from '../lib/nextera/sceneEquipment';
import { PROPERTY_LINE_HEX, PROPERTY_LINE_DIM_HEX, drawingLayerColor, showSeparateFence } from '../lib/nextera/propertyLineColor';
import { snapToGrid, snapToAugLattice, composeRowMove, validateRowShift, validateAisleShift, validateEquipmentShift, laydownFitReason, futureAugFitReason, filletPolylineStrip, drawnRoadLegalRegion, evaluateDrawnRoad, roadNetworkIslandPolys, DRAWN_ROAD_MIN_NEW_SQFT, roadRegionFromNetwork, roadSpanCutPoly, roadPieceAt, pointOnRoad, pointOnRoadFast, ringSpanCutAt, roadPathBetween, roadCorridorCutPoly, roadRunAt, type RoadPick, tracedRoadRendersUnpaved, tracedRoadFingerprint, tracedRoadFingerprintMatch, placedIslandPlanDims, placedIslandFootprints, composePlacedIsland, previewPlacedIslandDrop, placedEquipmentFootprints, composePlacedEquipment, previewPlacedEquipmentDrop, isManualEquipmentId, isManualEquipmentSpec, MANUAL_EQUIPMENT_TYPES, MANUAL_EQUIPMENT_CATALOG, type ManualEquipmentType, type PlacedIslandSpec, snapPlacementCenter, PLACEMENT_SNAP_STEPS_FT, PLACEMENT_SNAP_DEFAULT_FT, PLACEMENT_NUDGE_FT, ISLAND_PCS_PER_SIDE, MIN_LAYDOWN_EDGE_FT, GATE_PIN_SNAP_FT, equipmentForRouting } from '../lib/nextera/layoutEngine';
function polySignedArea(ps: { x: number; y: number }[]): number {
  return ps.reduce((s, p, i) => {
    const q = ps[(i + 1) % ps.length];
    return s + (p.x * q.y - q.x * p.y);
  }, 0) / 2;
}


function useMaxAnisotropy(): number {
  const gl = useThree(s => s.gl);
  return useMemo(() => gl.capabilities.getMaxAnisotropy(), [gl]);
}

// Repeat-wrapped ground texture tiled every `tileFt` feet. ShapeGeometry UVs
// equal plan coordinates (feet), so repeat = 1/tileFt gives world-scale tiling.
function useGroundTexture(url: string, tileFt: number): THREE.Texture {
  const base = useTexture(url);
  const maxAnisotropy = useMaxAnisotropy();
  return useMemo(() => {
    const t = base.clone();
    configureGroundTexture(t, maxAnisotropy);
    t.repeat.set(1 / tileFt, 1 / tileFt);
    return t;
  }, [base, tileFt, maxAnisotropy]);
}

// Crushed-rock surfacing regions (outer ring + equipment/reserved holes),
// rendered just above the ground and below the road surface with a tiled
// gravel texture — 1:1 from the same layout polygons the DXF hatch uses.
function SurfacingMesh({ surfacing, trench }: { surfacing: NonNullable<SiteDesign['surfacing']>; trench: SiteDesign['trench'] }) {
  const texSet = getYardTextureSet(useDesignStore(s => s.textureSetId));
  const gravelTex = useGroundTexture(texSet.rock, 25);
  // The excavated trench channel is open to the sky: cut the trench band out
  // of the gravel surfacing so the channel below is visible.
  const clip = useMemo(() => (trench ? trenchClipPlanes(trench) : null), [trench]);
  const geometries = useMemo(() => {
    return surfacing.regions
      .filter(region => region.outer.length >= 3)
      .map(region => {
        const shape = new THREE.Shape(region.outer.map(p => new THREE.Vector2(p.x, p.y)));
        const outerArea = polySignedArea(region.outer);
        for (const h of region.holes) {
          if (h.length < 3) continue;
          const holePts = outerArea * polySignedArea(h) > 0 ? [...h].reverse() : h;
          shape.holes.push(new THREE.Path(holePts.map(p => new THREE.Vector2(p.x, p.y))));
        }
        return new THREE.ShapeGeometry(shape);
      });
  }, [surfacing]);
  return (
    <>
      {geometries.map((geometry, i) => (
        <mesh key={i} geometry={geometry} position={[0, 0.08, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
          <meshStandardMaterial
            map={gravelTex}
            color={texSet.id === 'classic' ? '#c8c2b4' : '#ffffff'}
            side={THREE.DoubleSide}
            clippingPlanes={clip ? clip.outside : null}
            clipIntersection={!!clip}
            {...feederCutStencil}
          />
        </mesh>
      ))}
    </>
  );
}

// Connected road network surface — one ShapeGeometry per polygon of the SAME
// boolean region the picking and the DXF even-odd hatch use. Render ==
// region: a hand-rolled loop classification diverges whenever a ring
// partially overlaps the outer edge or a tight generated bump (gate throat)
// self-intersects under the corner fillet and earcut silently drops its
// triangles; the XOR region is a clean simple multi-poly, earcut-safe by
// construction.
function RoadNetworkMesh({ road, trench }: { road: NonNullable<SiteDesign['roadNetwork']>; trench: SiteDesign['trench'] }) {
  const texSet = getYardTextureSet(useDesignStore(s => s.textureSetId));
  const roadTex = useGroundTexture(texSet.road, 15);
  // Where the buried trench crosses under a road, the road surface renders
  // slightly transparent so the trench channel and conductors stay visible.
  // Implemented with local clipping planes: the opaque pass excludes the
  // trench band (clipIntersection), a second translucent pass fills it.
  const clip = useMemo(() => (trench ? trenchClipPlanes(trench) : null), [trench]);
  const geometries = useMemo(() => {
    let region: ReturnType<typeof roadRegionFromNetwork>;
    try { region = roadRegionFromNetwork(road); } catch { return null; }
    const signed = (ring: [number, number][]) =>
      ring.reduce((s, p, i) => {
        const q = ring[(i + 1) % ring.length];
        return s + (p[0] * q[1] - q[0] * p[1]);
      }, 0) / 2;
    const geoms: THREE.ShapeGeometry[] = [];
    for (const poly of region) {
      const [outer, ...holes] = poly;
      if (!outer || outer.length < 3) continue;
      const outerArea = signed(outer);
      const shape = new THREE.Shape(outer.map(([x, y]) => new THREE.Vector2(x, y)));
      for (const h of holes) {
        if (h.length < 3) continue;
        const holePts = outerArea * signed(h) > 0 ? [...h].reverse() : h;
        shape.holes.push(new THREE.Path(holePts.map(([x, y]) => new THREE.Vector2(x, y))));
      }
      geoms.push(new THREE.ShapeGeometry(shape));
    }
    return geoms.length ? geoms : null;
  }, [road]);
  if (!geometries) return null;
  // ShapeGeometry lies in XY plane; rotate so plan (x, y) -> scene (x, 0, -y)
  return (
    <>
      {geometries.map((geometry, i) => (
        <mesh key={i} geometry={geometry} position={[0, 0.2 + i * 0.02, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
          <meshStandardMaterial
            map={roadTex}
            color={texSet.id === 'classic' ? '#9a9a9a' : '#ffffff'}
            side={THREE.DoubleSide}
            clippingPlanes={clip ? clip.outside : null}
            clipIntersection={!!clip}
            {...feederCutStencil}
          />
        </mesh>
      ))}
      {clip && geometries.map((geometry, i) => (
        <mesh key={`t${i}`} geometry={geometry} position={[0, 0.2 + i * 0.02, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <meshStandardMaterial
            map={roadTex}
            color={texSet.id === 'classic' ? '#9a9a9a' : '#ffffff'}
            side={THREE.DoubleSide}
            transparent
            opacity={0.45}
            depthWrite={false}
            clippingPlanes={clip.inside}
          />
        </mesh>
      ))}
    </>
  );
}

// Entrance road rectangle with world-scale asphalt tiling. planeGeometry UVs
// span 0..1, so the texture repeat is set from the road dimensions.
function EntranceRoadMesh({ rd, trench }: { rd: SiteDesign['roads'][number]; trench: SiteDesign['trench'] }) {
  const texSet = getYardTextureSet(useDesignStore(s => s.textureSetId));
  const base = useTexture(texSet.road);
  const maxAnisotropy = useMaxAnisotropy();
  const tex = useMemo(() => {
    const t = base.clone();
    configureGroundTexture(t, maxAnisotropy);
    t.repeat.set(rd.length / 15, rd.width / 15);
    return t;
  }, [base, rd.length, rd.width, maxAnisotropy]);
  // Same trench see-through treatment as RoadNetworkMesh, in case the trench
  // band ever crosses under the entrance road.
  const clip = useMemo(() => (trench ? trenchClipPlanes(trench) : null), [trench]);
  const color = texSet.id === 'classic' ? '#9a9a9a' : '#ffffff';
  return (
    <>
      <mesh position={[rd.x, 0.2, -rd.y]} rotation={[-Math.PI / 2, 0, -rd.rotation]} receiveShadow>
        <planeGeometry args={[rd.length, rd.width]} />
        <meshStandardMaterial
          map={tex}
          color={color}
          clippingPlanes={clip ? clip.outside : null}
          clipIntersection={!!clip}
          {...feederCutStencil}
        />
      </mesh>
      {clip && (
        <mesh position={[rd.x, 0.2, -rd.y]} rotation={[-Math.PI / 2, 0, -rd.rotation]}>
          <planeGeometry args={[rd.length, rd.width]} />
          <meshStandardMaterial
            map={tex}
            color={color}
            transparent
            opacity={0.45}
            depthWrite={false}
            clippingPlanes={clip.inside}
          />
        </mesh>
      )}
    </>
  );
}

// Dirt/ground plane material: textured when the active set provides a dirt
// map, plain classic color otherwise. planeGeometry UVs span 0..1, so the
// repeat is derived from the plane size for ~30 ft world-scale tiling.
function GroundMaterial({ groundSize, clippingPlanes }: { groundSize: number; clippingPlanes?: THREE.Plane[] }) {
  const texSet = getYardTextureSet(useDesignStore(s => s.textureSetId));
  if (!texSet.dirt) {
    return (
      <meshStandardMaterial
        color="#8a7f5c"
        clippingPlanes={clippingPlanes ?? null}
        clipIntersection={!!clippingPlanes}
        {...feederCutStencil}
      />
    );
  }
  return <DirtMaterial url={texSet.dirt} groundSize={groundSize} clippingPlanes={clippingPlanes ?? null} />;
}

function DirtMaterial({ url, groundSize, clippingPlanes }: { url: string; groundSize: number; clippingPlanes?: THREE.Plane[] | null }) {
  const base = useTexture(url);
  const maxAnisotropy = useMaxAnisotropy();
  const tex = useMemo(() => {
    const t = base.clone();
    configureGroundTexture(t, maxAnisotropy);
    const rep = groundSize / 30;
    t.repeat.set(rep, rep);
    return t;
  }, [base, groundSize, maxAnisotropy]);
  return (
    <meshStandardMaterial
      map={tex}
      clippingPlanes={clippingPlanes ?? null}
      clipIntersection={!!clippingPlanes}
      {...feederCutStencil}
    />
  );
}

// Site-vicinity satellite drape: the stitched aerial mosaic (fetched via the
// server-side Cesium ion proxy) rendered as a georegistered overlay just
// above the dirt plane. Bounds are converted from WGS84 to the layout's
// local-feet frame with the same projection kmz.ts uses, so the parcel line
// lands exactly where it sits in the real imagery. Visual only — never
// affects layout math or exports.
function SatelliteDrape({ image, origin, clippingPlanes }: {
  image: SatelliteImage;
  origin: { lat: number; lon: number };
  clippingPlanes?: THREE.Plane[];
}) {
  const maxAnisotropy = useMaxAnisotropy();
  const invalidate = useThree(s => s.invalidate);
  const tex = useMemo(() => {
    // invalidate on load: with the demand frameloop the async texture decode
    // wouldn't otherwise trigger a repaint and the drape would stay blank
    // until the next interaction.
    const t = new THREE.TextureLoader().load(image.dataUrl, () => invalidate());
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = maxAnisotropy;
    return t;
  }, [image, maxAnisotropy, invalidate]);
  useEffect(() => () => tex.dispose(), [tex]);
  const rect = useMemo(() => satelliteLocalRect(image, origin), [image, origin]);
  return (
    <mesh
      rotation={[-Math.PI / 2, 0, 0]}
      position={[(rect.minX + rect.maxX) / 2, -0.15, -(rect.minY + rect.maxY) / 2]}
      receiveShadow
    >
      <planeGeometry args={[rect.maxX - rect.minX, rect.maxY - rect.minY]} />
      <meshStandardMaterial
        map={tex}
        clippingPlanes={clippingPlanes ?? null}
        clipIntersection={!!clippingPlanes}
        {...feederCutStencil}
      />
    </mesh>
  );
}

// Road width / turning-radius callouts in the preview, 1:1 with the DXF
// export: placement comes from the same shared helper (roadCallouts.ts), so
// leaders and text land at the exact anchor points the drawing uses. Text is
// drawn flat on the ground (top-down oriented like the sheet annotations),
// slightly above the road surface so it never z-fights with equipment.
const ROAD_CALLOUT_COLOR = '#ffd166';
const ROAD_CALLOUT_TEXT_H = 4; // ft — matches the DXF TEXT_H
function RoadCalloutLabels({ road }: { road: NonNullable<SiteDesign['roadNetwork']> }) {
  const data = useMemo(() => roadCalloutData(road), [road]);
  if (!data) return null;
  const y = 0.7;
  return (
    <group>
      {data.radius.map((c, i) => (
        <group key={`rc-${i}`}>
          <Line
            points={[
              [c.from.x, y, -c.from.y],
              [c.end.x, y, -c.end.y],
              [c.land.x, y, -c.land.y],
            ]}
            color={ROAD_CALLOUT_COLOR}
            lineWidth={1.5}
          />
          <Text
            position={[c.land.x + c.side * 2, y + 0.1, -c.land.y]}
            rotation={[-Math.PI / 2, 0, 0]}
            fontSize={ROAD_CALLOUT_TEXT_H}
            color={ROAD_CALLOUT_COLOR}
            anchorX={c.side > 0 ? 'left' : 'right'}
            anchorY="middle"
            outlineWidth={0.25}
            outlineColor="#000000"
          >
            {c.text}
          </Text>
        </group>
      ))}
      {data.width && (
        <Text
          position={[data.width.x, y + 0.1, -data.width.y]}
          rotation={[-Math.PI / 2, 0, (data.width.angDeg * Math.PI) / 180]}
          fontSize={ROAD_CALLOUT_TEXT_H}
          color={ROAD_CALLOUT_COLOR}
          anchorX="center"
          anchorY="middle"
          outlineWidth={0.25}
          outlineColor="#000000"
        >
          {data.width.text}
        </Text>
      )}
    </group>
  );
}

// Live "Draw Road" width-band preview: the SAME filleted strip outline the
// commit will carve (filletPolylineStrip — 24 ft width, 58 ft inner turning
// radius, auto-reduced radius / square-fallback corners on short legs), so
// what the drafter sees while clicking vertices matches the built road.
// The fillet helper returns overlapping rings (leg strips + corner wedges);
// they are boolean-unioned here so the translucent fill has uniform opacity
// and the outline traces the final strip boundary. Preview only — commit
// geometry and exports are untouched.
function RoadDraftBand({ pts, width = 24 }: { pts: Pt[]; width?: number }) {
  const design = useDesignStore(s => s.design);
  // Legal-region cache: fence + equipment only change on regenerate, so the
  // (relatively expensive) inset + pad-difference booleans run once per
  // design, not per mouse move.
  const legalRegion = useMemo(() => {
    if (!design) return [];
    // Compact yards validate against the bare pad rectangles (clearance 0) —
    // the SAME call the engine's accept gate makes, so the red/grey preview
    // states always match what commit will decide.
    try {
      return drawnRoadLegalRegion(
        design.fence, design.equipment, undefined, design.compact ? 0 : undefined);
    } catch { return []; }
  }, [design]);
  // Non-road yard polygons (sampled from the rendered network) — lets the
  // preview run the commit's nothing-to-add overlap too.
  const islandPolys = useMemo(() => {
    if (!design?.roadNetwork) return [];
    try { return roadNetworkIslandPolys(design.roadNetwork); } catch { return []; }
  }, [design]);
  const parts = useMemo(() => {
    try {
      if (!design) return null;
      // SAME evaluation the commit gate runs — the red sub-region is exactly
      // what would get the road rejected, and newArea mirrors the
      // nothing-to-add gate.
      const ev = evaluateDrawnRoad(pts, design.fence, design.equipment, legalRegion as any, islandPolys, width);
      if (!ev.stripArea) return null;
      const toParts = (mp: [number, number][][][]) => {
        const fills: THREE.ShapeGeometry[] = [];
        const outlines: THREE.Vector3[][] = [];
        for (const poly of mp) {
          const [outer, ...holes] = poly;
          if (!outer || outer.length < 3) continue;
          const shape = new THREE.Shape(outer.map(([x, y]) => new THREE.Vector2(x, y)));
          for (const h of holes) {
            if (h.length < 3) continue;
            shape.holes.push(new THREE.Path(h.map(([x, y]) => new THREE.Vector2(x, y))));
          }
          fills.push(new THREE.ShapeGeometry(shape));
          for (const ring of poly) {
            if (ring.length < 3) continue;
            outlines.push([...ring, ring[0]].map(([x, y]) => new THREE.Vector3(x, 0.84, -y)));
          }
        }
        return { fills, outlines };
      };
      const strip = toParts(ev.strip as any);
      const blocked = ev.blockedArea > 0.5 ? toParts(ev.blocked as any) : null;
      const ok = ev.frac >= 0.98; // same threshold as the engine accept gate
      // Same call the engine's nothing-to-add gate makes: legal route that
      // adds no new surface (already entirely on existing road).
      const nothingToAdd = ok && islandPolys.length > 0 && ev.newArea < DRAWN_ROAD_MIN_NEW_SQFT;
      return strip.fills.length ? { strip, blocked, ok, nothingToAdd } : null;
    } catch {
      return null; // preview only — never let a degenerate polyline break the scene
    }
  }, [pts, design, legalRegion, islandPolys, width]);
  useEffect(() => () => {
    parts?.strip.fills.forEach(g => g.dispose());
    parts?.blocked?.fills.forEach(g => g.dispose());
  }, [parts]);
  if (!parts) return null;
  // Amber = will be accepted; red outline = blocked (rejected on commit);
  // grey = legal but entirely on existing road, nothing to add (also
  // rejected on commit) — every commit-gate outcome is visible while drawing.
  const stripColor = parts.nothingToAdd ? '#94a3b8' : parts.ok ? '#fbbf24' : '#f59e0b';
  const outlineColor = parts.nothingToAdd ? '#94a3b8' : parts.ok ? '#fbbf24' : '#ef4444';
  return (
    <group>
      {parts.strip.fills.map((g, i) => (
        <mesh key={`rdb-${i}`} geometry={g} position={[0, 0.82, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <meshBasicMaterial color={stripColor} transparent opacity={0.22} depthWrite={false} side={THREE.DoubleSide} />
        </mesh>
      ))}
      {parts.strip.outlines.map((line, i) => (
        <Line key={`rdo-${i}`} points={line} color={outlineColor} lineWidth={1.5} transparent opacity={0.85} />
      ))}
      {/* Blocked sub-region: painted red so the drafter sees exactly which
          stretch violates equipment clearance / fence setback BEFORE
          committing (the commit gate rejects the whole road otherwise). */}
      {parts.blocked?.fills.map((g, i) => (
        <mesh key={`rdbx-${i}`} geometry={g} position={[0, 0.83, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <meshBasicMaterial color="#ef4444" transparent opacity={0.45} depthWrite={false} side={THREE.DoubleSide} />
        </mesh>
      ))}
      {parts.blocked?.outlines.map((line, i) => (
        <Line key={`rdox-${i}`} points={line.map(v => new THREE.Vector3(v.x, 0.845, v.z))} color="#ef4444" lineWidth={2} transparent opacity={0.9} />
      ))}
    </group>
  );
}

// Road draw-tool cursor snapping: 1 ft grid always; when a previous vertex
// exists and the segment is within ~6° of a 45° multiple, project the cursor
// onto that axis first so straight/diagonal legs come out exactly straight
// (matching the orthogonal auto network) without fighting freehand angles.
function snapRoadPoint(p: Pt, last: Pt | undefined): Pt {
  let x = p.x, y = p.y;
  if (last) {
    const dx = x - last.x, dy = y - last.y;
    const len = Math.hypot(dx, dy);
    if (len > 2) {
      const ang = Math.atan2(dy, dx);
      const k = Math.round(ang / (Math.PI / 4)) * (Math.PI / 4);
      const diff = Math.abs(((ang - k + Math.PI) % (2 * Math.PI)) - Math.PI);
      if (diff < (6 * Math.PI) / 180) {
        x = last.x + len * Math.cos(k);
        y = last.y + len * Math.sin(k);
      }
    }
  }
  return { x: snapToGrid(x, 1), y: snapToGrid(y, 1) };
}

// Scene units = feet. Plan (x, y) -> scene (x, elev, -y)
const KIND_COLORS: Record<PlacedEquipment['kind'], string> = {
  bess: '#c0392b',
  inverter: '#f1c40f',
  auxTransformer: '#27ae60',
  auxSwitchgear: '#16a085',
  auxSwitchPanel: '#1f3fbf',
  fiberPatchPanel: '#e67e22',
  fireControlPanel: '#d35400',
  conex: '#7f8c8d',
  manhole: '#566573',
  feederJunctionBox: '#8e44ad',
  generator: '#7f8c8d',
  commsCabinet: '#2980b9',
  // Substation yard equipment (substation areas only)
  mainTransformer: '#7f8c8d',
  mvSwitchgear: '#34495e',
  controlHouse: '#95a5a6',
  substationFeeder: '#5d6d7e',
};

// Cable colors per the reference legend (Sheets 3-4). DC conductors route as
// (+)/(−) pairs (red/blue per the reference detail); the plain DC key remains
// for reference-only stubs without a polarity.
const CABLE_COLORS: Record<string, string> = {
  DC: '#22a844',
  'DC+': '#d43a3a',
  'DC-': '#2b50d8',
  MV: '#29b6d8',
  LVAC: '#c93bc9',        // aux distribution 0.480 kV — thin magenta (spec §2)
  AUXPWR: '#8e44ad',      // aux power LV — thin purple (spec §2)
  FIBER: '#f39c12',       // 6-count row drops — orange dashed
  FIBER_TRUNK: '#e67e22', // 144-count trunk — orange solid
  CATL: '#20d5c8',        // CATL container ring — cyan dashed (teal vs MV)
};

// Plan-view color for a run, polarity-aware for the DC pair split.
const cableRunColor = (run: { class: string; polarity?: 'pos' | 'neg' }): string =>
  run.class === 'DC' && run.polarity
    ? CABLE_COLORS[run.polarity === 'pos' ? 'DC+' : 'DC-']
    : CABLE_COLORS[run.class];

function generatedCableVisible(
  cableClass: string,
  visibility: ReturnType<typeof useDesignStore.getState>['drawingVisibility'],
): boolean {
  if (cableClass === 'DC') return visibility.pcsToBess;
  if (cableClass === 'FIBER' || cableClass === 'FIBER_TRUNK' || cableClass === 'CATL') {
    return visibility.fiber;
  }
  if (cableClass === 'LVAC' || cableClass === 'AUXPWR' || cableClass === 'AUXF') {
    return visibility.auxiliaryCables;
  }
  return true;
}

// Cable runs with the cinematic tour's presentation-only DC reroute beat.
// Outside that beat this renders design.cables unchanged. During the beat it
// derives temporary direct geometry without writing it back to the design,
// store, session, or export pipeline.
function TourSwapCableRuns({ design }: { design: SiteDesign }) {
  const drawingVisibility = useDesignStore(s => s.drawingVisibility);
  const swap = useDesignStore(s => s.tourDcSwap);
  const swapOn = swap > 0;
  const directCables = useMemo(() => {
    if (!swapOn) return null;
    try {
      return generateCableRouting(
        equipmentForRouting(design.equipment), design.augmentationZones, design.fence,
        design.trench?.x ?? null, design.reservedZones, design.islands ?? null,
        'direct', null,
      ).cables;
    } catch {
      return null;
    }
  }, [swapOn, design]);

  const runs = useMemo(() => {
    const isDc = (run: typeof design.cables[number]) => run.class === 'DC' && !run.ref;
    if (!directCables || swap <= 0) return design.cables;
    const oldDc = design.cables.filter(isDc);
    const newDc = directCables.filter(isDc);
    const count = Math.max(oldDc.length, newDc.length, 1);
    const cut = Math.floor(swap * count + 1e-6);
    return [
      ...design.cables.filter(run => !isDc(run)),
      ...newDc.slice(0, Math.min(cut, newDc.length)).map(run => ({ ...run, id: `tour-${run.id}` })),
      ...oldDc.slice(Math.min(cut, oldDc.length)),
    ];
  }, [design, directCables, swap]);

  return (
    <>
      {runs.filter(run => generatedCableVisible(run.class, drawingVisibility)).map(run => (
        <PolyLine
          key={run.id}
          pts={run.pts}
          color={cableRunColor(run)}
          y={0.35}
          lineWidth={run.class === 'DC' ? 1.5 : 2}
          closed={false}
          dashed={!!run.ref}
        />
      ))}
    </>
  );
}

function TourFutureGhostBox({ g, ease }: {
  g: { x: number; y: number; length: number; width: number; height: number; rotation: number };
  ease: number;
}) {
  const edges = useMemo(
    () => new THREE.EdgesGeometry(new THREE.BoxGeometry(g.length, g.height, g.width)),
    [g.length, g.height, g.width],
  );
  useEffect(() => () => edges.dispose(), [edges]);
  return (
    <group position={[g.x, g.height / 2 + 0.15, -g.y]} rotation={[0, g.rotation, 0]}>
      <mesh>
        <boxGeometry args={[g.length, g.height, g.width]} />
        <meshStandardMaterial color="#22d3ee" transparent opacity={0.32 * ease} depthWrite={false} />
      </mesh>
      <lineSegments geometry={edges}>
        <lineBasicMaterial color="#67e8f9" transparent opacity={0.9 * ease} depthWrite={false} />
      </lineSegments>
    </group>
  );
}
function TourFadeOverlay() {
  const fade = useDesignStore(s => s.tourFade);
  const caption = useDesignStore(s => s.tourCaption);
  const statAlpha = useDesignStore(s => s.tourStatAlpha);
  const statCard = useDesignStore(s => s.tourStatCard);
  const introT = useDesignStore(s => s.tourIntroT);
  const introInfo = useDesignStore(s => s.tourIntroInfo);
  const recordOn = useDesignStore(s => s.tourRecord);
  const offlineOn = useDesignStore(s => s.offlineRenderActive);
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const w = cv.clientWidth || cv.parentElement?.clientWidth || 1280;
    const h = cv.clientHeight || cv.parentElement?.clientHeight || 720;
    // Backing store above CSS size (device ratio normally, up to UHD scale
    // while recording) so intro/stat/caption text stays crisp in the 4K
    // composite video. Layout math below stays in CSS pixels.
    const ratio = (recordOn || offlineOn)
      ? Math.max(1, Math.min(3, Math.min(3840 / Math.max(1, w), 2160 / Math.max(1, h))))
      : Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    const dw = Math.round(w * ratio), dh = Math.round(h * ratio);
    if (cv.width !== dw || cv.height !== dh) { cv.width = dw; cv.height = dh; }
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, w, h);
    // Cinematic title intro over the opening orbit — staged type reveals
    // driven purely by introT (0..1 inside the intro window), so seeking and
    // cancel re-render exactly. Drawn on the recorder-captured overlay so it
    // lands in exported videos.
    if (introInfo && introT > 0) {
      drawTourIntro(ctx, w, h, introInfo, introT);
    }
    // Feeder fly-along island stat card: glassy gradient panel with a sheen
    // sweep, eased fade + slide-in, typographic hierarchy. Drawn HERE — on
    // the recorder-captured overlay canvas — so it lands in the exported
    // video (DOM divs never reach the composite recording). Everything is a
    // pure function of statAlpha, so seeking/cancel re-render exactly.
    if (statCard && statAlpha > 0) {
      const ease = statAlpha * statAlpha * (3 - 2 * statAlpha); // smoothstep
      const pw = Math.min(430, Math.max(300, w * 0.32));
      const px = w - pw - Math.round(w * 0.045);
      const rowBig = Math.max(19, Math.round(h * 0.030));
      const rowMid = Math.max(15, Math.round(h * 0.023));
      const rowSm = Math.max(11, Math.round(h * 0.0155));
      const pad = Math.round(rowBig * 1.15);
      const ph = pad * 2 + rowSm * 2.2 + rowBig * 1.7 + rowMid * 2 * 1.55 + rowSm * 3.4;
      const py = Math.round(h * 0.16) + Math.round((1 - ease) * 26); // slide-up
      ctx.save();
      ctx.globalAlpha = ease;
      // Panel: dark glass, vertical gradient, hairline border, soft shadow.
      const r = 14;
      const panel = () => {
        ctx.beginPath();
        if (typeof ctx.roundRect === 'function') ctx.roundRect(px, py, pw, ph, r);
        else ctx.rect(px, py, pw, ph);
      };
      const bg = ctx.createLinearGradient(0, py, 0, py + ph);
      bg.addColorStop(0, 'rgba(9, 14, 26, 0.88)');
      bg.addColorStop(1, 'rgba(17, 26, 44, 0.72)');
      ctx.shadowColor = 'rgba(0, 0, 0, 0.45)';
      ctx.shadowBlur = 28;
      ctx.shadowOffsetY = 8;
      ctx.fillStyle = bg;
      panel();
      ctx.fill();
      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;
      ctx.shadowOffsetY = 0;
      // Sheen sweep: a soft diagonal highlight that glides across the panel
      // as the card fades in (the "shader" treatment, alpha-driven).
      ctx.save();
      panel();
      ctx.clip();
      const sx = px - pw + ease * pw * 2.4;
      const sheen = ctx.createLinearGradient(sx, py, sx + pw * 0.9, py + ph);
      sheen.addColorStop(0, 'rgba(255,255,255,0)');
      sheen.addColorStop(0.5, 'rgba(190,225,255,0.10)');
      sheen.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = sheen;
      ctx.fillRect(px, py, pw, ph);
      ctx.restore();
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.38)';
      ctx.lineWidth = 1;
      panel();
      ctx.stroke();
      // Cyan accent bar down the left edge.
      ctx.fillStyle = 'rgba(34, 211, 238, 0.9)';
      ctx.fillRect(px, py + r, 3, ph - r * 2);
      // Typography: tracked-out eyebrow title, hero line, supporting rows,
      // hairline divider, then the live-derived footer rows.
      const font = (wgt: number, size: number) =>
        `${wgt} ${size}px Inter, ui-sans-serif, system-ui, -apple-system, sans-serif`;
      const anyCtx = ctx as CanvasRenderingContext2D & { letterSpacing?: string };
      const tracked = (on: boolean) => { if ('letterSpacing' in anyCtx) anyCtx.letterSpacing = on ? '2.5px' : '0px'; };
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
      let ty = py + pad + rowSm;
      tracked(true);
      ctx.fillStyle = 'rgba(103, 232, 249, 0.95)'; // cyan-300 eyebrow
      ctx.font = font(700, rowSm);
      ctx.fillText(statCard.title, px + pad, ty);
      tracked(false);
      ty += rowSm * 1.2 + rowBig;
      ctx.fillStyle = '#f8fafc';
      ctx.font = font(800, rowBig);
      ctx.shadowColor = 'rgba(103, 232, 249, 0.35)'; // soft glow on the hero
      ctx.shadowBlur = 14;
      ctx.fillText(statCard.lines[0] ?? '', px + pad, ty);
      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;
      ctx.fillStyle = 'rgba(226, 232, 240, 0.92)';
      ctx.font = font(600, rowMid);
      for (const line of statCard.lines.slice(1)) {
        ty += rowMid * 1.55;
        ctx.fillText(line, px + pad, ty);
      }
      ty += rowMid * 1.3;
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.25)';
      ctx.beginPath();
      ctx.moveTo(px + pad, ty);
      ctx.lineTo(px + pw - pad, ty);
      ctx.stroke();
      ctx.fillStyle = 'rgba(148, 163, 184, 0.9)';
      ctx.font = font(500, rowSm);
      tracked(true);
      for (const line of statCard.sub) {
        ty += rowSm * 1.7;
        ctx.fillText(line, px + pad, ty);
      }
      tracked(false);
      ctx.restore();
    }
    if (fade > 0) {
      ctx.globalAlpha = Math.min(1, fade);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, w, h);
      ctx.globalAlpha = 1;
    }
    // Reroute-beat caption, styled like the showcase captions (dark pill,
    // light text, bottom-center). Drawn HERE — on the recorder-captured
    // overlay canvas — because DOM divs never make it into the composite
    // recording. The tour clears it before the fade starts, so caption and
    // full-white fade never fight visually.
    if (caption) {
      const fontPx = Math.max(14, Math.round(h * 0.024));
      ctx.font = `600 ${fontPx}px ui-sans-serif, system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const padX = fontPx;
      const padY = fontPx * 0.55;
      const tw = ctx.measureText(caption).width;
      const bw = tw + padX * 2;
      const bh = fontPx + padY * 2;
      const cx = w / 2;
      const cy = h - bh / 2 - Math.round(h * 0.04);
      ctx.fillStyle = 'rgba(15, 23, 42, 0.8)'; // slate-900/80
      if (typeof (ctx as CanvasRenderingContext2D).roundRect === 'function') {
        ctx.beginPath();
        ctx.roundRect(cx - bw / 2, cy - bh / 2, bw, bh, 6);
        ctx.fill();
      } else {
        ctx.fillRect(cx - bw / 2, cy - bh / 2, bw, bh);
      }
      ctx.fillStyle = '#f1f5f9'; // slate-100
      ctx.fillText(caption, cx, cy);
    }
  }, [fade, caption, statAlpha, statCard, introT, introInfo, recordOn, offlineOn]);
  return (
    <canvas
      ref={ref}
      data-tour-overlay
      data-tour-intro={introInfo && introT > 0 ? '' : undefined}
      data-tour-stat={statCard && statAlpha > 0 ? '' : undefined}
      data-tour-caption-text={caption ?? undefined}
      className="absolute inset-0 z-20 w-full h-full pointer-events-none"
    />
  );
}

// Live title-card preview inside the tour options popover: renders the exact
// intro overlay (shared drawTourIntro) into a small 16:9 canvas at a frozen
// fully-staged progress, so drafters see wording/fit while typing without
// recording a tour. The backing canvas is 640×360 — fonts derive from H and
// the shrink-to-fit math is resolution-independent, so proportions match the
// exported video 1:1. Pure preview: reads store state only, writes nothing.
function TourIntroPreview({ design }: { design: SiteDesign }) {
  const tourOptions = useDesignStore(s => s.tourOptions);
  const configId = useDesignStore(s => s.configId);
  const containersPerPcs = useDesignStore(s => s.containersPerPcs);
  const introInfo = useMemo(
    () => buildTourIntro(design, getEffectiveConfiguration(configId, containersPerPcs), {
      title: tourOptions.introTitle,
      subtitle: tourOptions.introSubtitle,
    }),
    [design, configId, containersPerPcs, tourOptions.introTitle, tourOptions.introSubtitle],
  );
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    const ctx = cv?.getContext('2d');
    if (!cv || !ctx) return;
    // Dark stand-in for the aerial orbit shot behind the type.
    const bg = ctx.createLinearGradient(0, 0, 0, cv.height);
    bg.addColorStop(0, '#1e293b');
    bg.addColorStop(1, '#0f172a');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, cv.width, cv.height);
    // p = 0.7: every stage revealed, count-up finished, before the out-fade.
    drawTourIntro(ctx, cv.width, cv.height, introInfo, 0.7);
  }, [introInfo]);
  return (
    <canvas
      ref={ref}
      width={640}
      height={360}
      data-tour-intro-preview
      className="w-full rounded border border-slate-700"
    />
  );
}

// Equipment labels stay legible when zoomed out: scale with camera distance
// (perspective) or 1/zoom (orthographic 2D view), but never grow beyond their
// own unit's footprint on either axis, and hide once too far to be useful.
const LABEL_REF_DIST = 350;    // ft — below this, no upscaling
const LABEL_HIDE_DIST = 3500;  // ft — beyond this, hide labels (noise)
// Container/box labels are the densest text on a traced yard (hundreds of
// CON…-A-n strings a few feet apart). They drop out earlier than the PCS/aux
// labels so a zoomed-out view reads as one name per unit, not a smear.
const LABEL_DENSE_HIDE_DIST = 1600; // ft — bess/conex/manhole labels

// All equipment labels in one component with a single useFrame: same
// zoom-aware sizing and distance culling as before (LABEL_* constants),
// but one per-frame loop instead of one callback per label — on a 150+
// block site that is ~600 fewer per-frame React/three callbacks.
function EquipLabels({ equipment, cables }: { equipment: PlacedEquipment[]; cables?: readonly CableRun[] }) {
  const refs = useRef<(THREE.Group | null)[]>([]);
  const distanceScaling = useDesignStore(s => s.labelDistanceScaling);
  const labels = useMemo(() => equipment.map(nexteraLabel), [equipment]);
  const positions = useMemo(
    () => equipment.map(eq => new THREE.Vector3(eq.x, eq.height + 1.2, -eq.y)),
    [equipment]
  );
  const initialScaleCaps = useMemo(
    () => equipment.map((eq, i) =>
      equipmentLabelMaxScale(eq, equipmentLabelEstimatedBounds(eq, labels[i]))),
    [equipment, labels]
  );
  // Keep exact async text measurements until the equipment array changes.
  // Reset synchronously during render (rather than in a passive effect) so a
  // newly longer equipment list can never feed `undefined` into group scale.
  const scaleState = useRef({ equipment, caps: initialScaleCaps });
  if (scaleState.current.equipment !== equipment) {
    scaleState.current = { equipment, caps: initialScaleCaps };
  }
  const scaleCaps = scaleState.current.caps;
  // Last camera pose the label pass ran for: the batched update below is
  // skipped entirely while the camera is still, so an idle scene does zero
  // per-label work. Reset on toggle/equipment change to force one pass.
  const lastPose = useRef({ x: NaN, y: NaN, z: NaN, zoom: NaN });
  const invalidate = useThree(s => s.invalidate);
  useEffect(() => {
    lastPose.current = { x: NaN, y: NaN, z: NaN, zoom: NaN };
    if (!distanceScaling) {
      // Static labels: one reset pass, then no per-frame work at all.
      for (let i = 0; i < refs.current.length; i++) {
        const g = refs.current[i];
        if (!g) continue;
        g.visible = true;
        g.scale.setScalar(Math.min(1, scaleCaps[i] ?? 1));
      }
    }
    invalidate(); // demand frameloop: repaint after the imperative reset
  }, [distanceScaling, equipment, initialScaleCaps, scaleCaps, invalidate]);
  useFrame(({ camera }) => {
    if (!distanceScaling) return; // opt-in: no per-frame label work
    const isOrtho = (camera as THREE.OrthographicCamera).isOrthographicCamera;
    const zoom = isOrtho ? (camera as THREE.OrthographicCamera).zoom : 0;
    const lp = lastPose.current;
    const { x, y, z } = camera.position;
    if (x === lp.x && y === lp.y && z === lp.z && zoom === lp.zoom) return;
    lastPose.current = { x, y, z, zoom };
    // For ortho, on-screen size ∝ zoom; convert to an equivalent distance
    // (same for every label, so compute once per pass).
    const orthoDist = isOrtho ? LABEL_REF_DIST / Math.max(zoom, 1e-4) : 0;
    for (let i = 0; i < positions.length; i++) {
      const g = refs.current[i];
      if (!g) continue;
      const effDist = isOrtho ? orthoDist : camera.position.distanceTo(positions[i]);
      const k = equipment[i].kind;
      const hideAt = (k === 'bess' || k === 'conex' || k === 'manhole')
        ? LABEL_DENSE_HIDE_DIST : LABEL_HIDE_DIST;
      const visible = effDist < hideAt;
      g.visible = visible;
      if (visible) {
        const s = Math.min(
          Math.max(effDist / LABEL_REF_DIST, 1),
          EQUIPMENT_LABEL_MAX_DISTANCE_SCALE,
          scaleCaps[i],
        );
        g.scale.setScalar(s);
      }
    }
  });
  return (
    <>
      {equipment.map((eq, i) => (
        <group key={eq.id} ref={el => (refs.current[i] = el)} position={positions[i]} userData={{ equipLabel: true }}>
          <Text
            rotation={[
              -Math.PI / 2,
              0,
              // BESS, PCS and conex text follows the unit's exact long axis,
              // including arbitrary rotations traced from customer drawings.
              equipmentLabelRotation(eq, equipment, cables),
            ]}
            fontSize={equipmentLabelFontSize(eq)}
            color="#ffffff"
            outlineWidth={EQUIPMENT_LABEL_OUTLINE_FT}
            outlineColor="#000000"
            anchorX="center"
            anchorY="middle"
            onSync={text => {
              const b = text.textRenderInfo?.visibleBounds as number[] | undefined;
              if (!b || b.length < 4 || !b.every(Number.isFinite)) return;
              scaleCaps[i] = equipmentLabelMaxScale(eq, {
                width: Math.max(0, b[2] - b[0]),
                height: Math.max(0, b[3] - b[1]),
              });
              const g = refs.current[i];
              if (!g) return;
              if (distanceScaling) {
                // The camera may be still, so force the next batched frame to
                // apply the newly measured cap instead of pose-short-circuiting.
                lastPose.current = { x: NaN, y: NaN, z: NaN, zoom: NaN };
              } else {
                g.scale.setScalar(Math.min(1, scaleCaps[i]));
              }
              invalidate();
            }}
          >
            {labels[i]}
          </Text>
        </group>
      ))}
    </>
  );
}

// One instance = one equipment body box.
interface InstanceSpec {
  x: number; y: number; z: number;
  sx: number; sy: number; sz: number;
  rotY?: number;
  color?: string;
}

const Y_AXIS = new THREE.Vector3(0, 1, 0);

function fillInstances(mesh: THREE.InstancedMesh | null, items: InstanceSpec[]) {
  if (!mesh) return;
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const p = new THREE.Vector3();
  const s = new THREE.Vector3();
  const c = new THREE.Color();
  const hadInstanceColor = mesh.instanceColor !== null;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    q.setFromAxisAngle(Y_AXIS, it.rotY ?? 0);
    m.compose(p.set(it.x, it.y, it.z), q, s.set(it.sx, it.sy, it.sz));
    mesh.setMatrixAt(i, m);
    if (it.color) mesh.setColorAt(i, c.set(it.color));
  }
  mesh.count = items.length;
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) {
    mesh.instanceColor.needsUpdate = true;
    // The material may have been compiled before the instanceColor attribute
    // existed (setColorAt creates it lazily); force a recompile so the
    // per-instance colors are actually used by the shader.
    if (!hadInstanceColor) {
      const mat = mesh.material as THREE.Material | THREE.Material[];
      (Array.isArray(mat) ? mat : [mat]).forEach(mm => { mm.needsUpdate = true; });
    }
  }
}

// Instanced equipment rendering: one body draw call regardless of site size.
// Highlighted items are excluded by the caller
// and rendered through the classic EquipmentBox path (emissive + ring).
// Equipment kinds drawn as delivered symbols instead of plain boxes. Taken
// straight from the shared resolver so the scene can never disagree with the
// DXF/PDF/CAD coverage.
const symbolKindsFor = (source: SymbolSource) => symbolEquipmentKinds(source);

// Yard symbol overlay: flat filled traces of the delivered equipment symbols
// mapped onto each footprint (same placement math as the DXF export via
// eciSymbolForEquipment). In 2D the symbols REPLACE the boxes (bodies hidden
// by the caller) and sit just above the ground planes; in 3D they render as
// thin decals on the box tops. Pure geometry rebuilt per design change;
// demand frameloop repaints on mount automatically.
function EciSymbolOverlay(
  { equipment, is3D, source }: { equipment: PlacedEquipment[]; is3D?: boolean; source: SymbolSource }
) {
  const configId = useDesignStore(s => s.configId);
  const geoms = useMemo(() => {
    const config = getConfiguration(configId);
    const black: THREE.BufferGeometry[] = [];
    const gray: THREE.BufferGeometry[] = [];
    for (const eq of equipment) {
      const p = eciSymbolForEquipment(eq, config, source);
      if (!p) continue;
      // 2D: fixed heights above surfacing/road planes; 3D: box-top decal.
      const grayY = is3D ? eq.height + 0.08 : 0.3;
      const blackY = is3D ? eq.height + 0.16 : 0.4;
      // Shared yard-scale geometry (thinned black linework) — identical to
      // the DXF/PDF/CAD display list source.
      const yardPolys = eciYardSymbolPolys(p);
      const build = (polys: [number, number][][][], out: THREE.BufferGeometry[], y: number) => {
        for (const rings of polys) {
          const shape = new THREE.Shape(rings[0].map(([x, yy]) => new THREE.Vector2(x, yy)));
          for (let i = 1; i < rings.length; i++) {
            shape.holes.push(new THREE.Path(rings[i].map(([x, yy]) => new THREE.Vector2(x, yy))));
          }
          const g = new THREE.ShapeGeometry(shape);
          g.rotateX(-Math.PI / 2); // (x, yardY, 0) -> (x, 0, -yardY)
          g.translate(0, y, 0);
          out.push(g);
        }
      };
      build(yardPolys.gray, gray, grayY);
      build(yardPolys.black, black, blackY);
    }
    const merged = {
      black: black.length ? mergeGeometries(black, false) : null,
      gray: gray.length ? mergeGeometries(gray, false) : null,
    };
    // mergeGeometries copies attributes — free the per-polygon sources now.
    for (const g of black) g.dispose();
    for (const g of gray) g.dispose();
    return merged;
  }, [equipment, configId, is3D]);
  useEffect(() => () => { geoms.black?.dispose(); geoms.gray?.dispose(); }, [geoms]);
  return (
    <group>
      {geoms.gray && (
        <mesh geometry={geoms.gray}>
          <meshBasicMaterial color="#9aa0a6" side={THREE.DoubleSide} />
        </mesh>
      )}
      {geoms.black && (
        <mesh geometry={geoms.black}>
          <meshBasicMaterial color="#f0f0f0" side={THREE.DoubleSide} />
        </mesh>
      )}
    </group>
  );
}

function InstancedEquipment({ equipment, hideBodyKinds }: { equipment: PlacedEquipment[]; hideBodyKinds?: ReadonlySet<PlacedEquipment['kind']> }) {
  const bodyRef = useRef<THREE.InstancedMesh>(null);
  const feeders = useDesignStore(s => s.feeders);
  const showFeederColors = useDesignStore(s => s.showFeederColors);
  const hiddenFeeders = useDesignStore(s => s.hiddenFeeders);
  // GE PCS exterior color: the simple-box preview follows the drafter's
  // chosen paint (GE configs only) so simple and realistic views agree.
  const gePcsColor = useDesignStore(s => s.gePcsColor);
  const configId = useDesignStore(s => s.configId);
  const pcsBoxColor =
    gePcsColor && getConfiguration(configId)?.inverterModel === 'GE FLEX 1571'
      ? gePcsColor
      : null;
  // Body material with the per-instance feeder tint shader (subtle diffuse
  // mix + fresnel rim). Instances with a zero tint render exactly as before.
  const bodyMaterial = useMemo(() => {
    const m = new THREE.MeshStandardMaterial();
    patchMaterialWithFeederTint(m);
    return m;
  }, []);

  const parts = useMemo(() => {
    const tintById = showFeederColors
      ? feederTintByInverterId(feeders.filter(f => !hiddenFeeders.has(f.idx)))
      : new Map<string, string>();
    const bodies: InstanceSpec[] = [];
    const bodyTints: (string | null)[] = [];
    for (const eq of equipment) {
      if (!hideBodyKinds?.has(eq.kind)) {
        bodies.push({
          x: eq.x, y: eq.height / 2, z: -eq.y,
          sx: eq.length, sy: eq.height, sz: eq.width,
          rotY: eq.rotation,
          color: eq.kind === 'inverter' && pcsBoxColor ? pcsBoxColor : KIND_COLORS[eq.kind],
        });
        bodyTints.push(eq.kind === 'inverter' ? tintById.get(eq.id) ?? null : null);
      }
    }
    return { bodies, bodyTints };
  }, [equipment, hideBodyKinds, feeders, showFeederColors, hiddenFeeders, pcsBoxColor]);

  useEffect(() => {
    fillInstances(bodyRef.current, parts.bodies);
    // Per-instance feeder tint attribute (zero = untinted) for the body shader.
    if (bodyRef.current) {
      bodyRef.current.geometry.setAttribute('aFeederTint', makeFeederTintAttribute(parts.bodyTints));
    }
  }, [parts]);

  return (
    <group>
      {parts.bodies.length > 0 && (
        <instancedMesh
          key={`b${parts.bodies.length}`}
          ref={bodyRef}
          args={[undefined, bodyMaterial, parts.bodies.length]}
          castShadow
          receiveShadow
          frustumCulled={false}
        >
          <boxGeometry args={[1, 1, 1]} />
        </instancedMesh>
      )}
    </group>
  );
}

function EquipmentBox({ eq, showLabels, highlighted, symbolBody }: { eq: PlacedEquipment; showLabels: boolean; highlighted?: boolean; symbolBody?: boolean }) {
  // symbolBody: the ECI yard symbol overlay draws this unit's body (2D ECI
  // mode) — keep the highlight ring/affordance but drop the legacy box so the
  // delivered symbol stays the visible geometry.
  return (
    <group>
      {!symbolBody && <mesh
        position={[eq.x, eq.height / 2, -eq.y]}
        rotation={[0, eq.rotation, 0]}
        castShadow
        receiveShadow
      >
        <boxGeometry args={[eq.length, eq.height, eq.width]} />
        <meshStandardMaterial
          color={KIND_COLORS[eq.kind]}
          emissive={highlighted ? '#ff2d95' : '#000000'}
          emissiveIntensity={highlighted ? 0.9 : 0}
        />
      </mesh>}
      {highlighted && (
        <mesh position={[eq.x, 0.6, -eq.y]} rotation={[-Math.PI / 2, 0, eq.rotation]}>
          <ringGeometry args={[Math.max(eq.length, eq.width) * 0.75, Math.max(eq.length, eq.width) * 0.75 + 2, 32]} />
          <meshBasicMaterial color="#ff2d95" side={THREE.DoubleSide} transparent opacity={0.85} />
        </mesh>
      )}
      {showLabels && <EquipLabels equipment={[eq]} />}
    </group>
  );
}

// Exothermic grid-crossing dots (hundreds on a full lattice) — one
// instanced draw call. Demand frameloop: matrices set in useLayoutEffect
// before the commit's render, no invalidate needed beyond the mount.
function GroundingCrossingDots({ pts }: { pts: { x: number; y: number }[] }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const invalidate = useThree(s => s.invalidate);
  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    const m = new THREE.Matrix4();
    for (let i = 0; i < pts.length; i++) {
      m.setPosition(pts[i].x, 0.55, -pts[i].y);
      mesh.setMatrixAt(i, m);
    }
    mesh.count = pts.length;
    mesh.instanceMatrix.needsUpdate = true;
    invalidate();
  }, [pts, invalidate]);
  if (!pts.length) return null;
  return (
    <instancedMesh ref={ref} key={pts.length} args={[undefined, undefined, pts.length]}>
      <sphereGeometry args={[0.8, 8, 6]} />
      <meshBasicMaterial color="#2dd4bf" />
    </instancedMesh>
  );
}

// ---------------------------------------------------------------------------
// Imported CAD drawing (reference underlay).
//
// A full site export runs to six figures of line features — the customer's Big
// Iron KMZ draws ~137,000. One drawable per feature would be hopeless, so each
// LAYER becomes a single merged LineSegments buffer: one draw call per layer,
// built straight from the flat coordinate runs the importer stored.
// Layer colors come from the shared property-line convention module: the
// purple band is reserved for PARCEL/easement layers so no reference layer
// can be mistaken for the lot line (see propertyLineColor.ts).

// Degenerate single-coordinate features from the CAD conversion. Drawn as
// points so they are visible rather than silently dropped.
function DrawingLayerPoints({ layer, color, y }: { layer: DrawingLayer; color: string; y: number }) {
  const geometry = useMemo(() => {
    const n = layer.points.length / 2;
    const positions = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      positions[i * 3] = layer.points[i * 2];
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = -layer.points[i * 2 + 1];
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    return g;
  }, [layer, y]);
  const invalidate = useThree(s => s.invalidate);
  useEffect(() => {
    invalidate();
    return () => geometry.dispose();
  }, [geometry, invalidate]);
  if (!layer.points.length) return null;
  return (
    <points geometry={geometry}>
      <pointsMaterial color={color} size={1.6} sizeAttenuation transparent opacity={0.85} depthWrite={false} />
    </points>
  );
}

function DrawingLayerLines({ layer, color, y }: { layer: DrawingLayer; color: string; y: number }) {
  const geometry = useMemo(() => {
    let segments = 0;
    // Ring closure is re-derived geometrically — persisted drawings may
    // carry parse-era flags that disagree with the coordinates.
    for (let i = 0; i < layer.polylines.length; i++) {
      const n = layer.polylines[i].length / 2;
      segments += Math.max(0, n - 1) +
        (isClosedPolylineRun(layer.polylines[i], layer.closedFlags[i]) && n > 2 ? 1 : 0);
    }
    const positions = new Float32Array(segments * 6);
    let o = 0;
    for (let i = 0; i < layer.polylines.length; i++) {
      const flat = layer.polylines[i];
      const n = flat.length / 2;
      for (let j = 0; j < n - 1; j++) {
        positions[o++] = flat[j * 2];     positions[o++] = y; positions[o++] = -flat[j * 2 + 1];
        positions[o++] = flat[j * 2 + 2]; positions[o++] = y; positions[o++] = -flat[j * 2 + 3];
      }
      if (isClosedPolylineRun(flat, layer.closedFlags[i]) && n > 2) {
        positions[o++] = flat[(n - 1) * 2]; positions[o++] = y; positions[o++] = -flat[(n - 1) * 2 + 1];
        positions[o++] = flat[0];           positions[o++] = y; positions[o++] = -flat[1];
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    return g;
  }, [layer, y]);
  const invalidate = useThree(s => s.invalidate);
  useEffect(() => {
    invalidate();
    return () => geometry.dispose();
  }, [geometry, invalidate]);
  return (
    <lineSegments geometry={geometry}>
      <lineBasicMaterial color={color} transparent opacity={0.85} depthWrite={false} />
    </lineSegments>
  );
}

// The whole imported drawing, one merged buffer per visible layer. Reference
// only — it is never part of the design, so nothing here feeds exports.
function ImportedDrawingLayers() {
  const drawing = useDesignStore(s => s.drawing);
  const showDrawing = useDesignStore(s => s.showDrawing);
  const layerVis = useDesignStore(s => s.drawingLayerVis);
  if (!drawing || !showDrawing) return null;
  return (
    <group>
      {drawing.layers.map((layer, i) =>
        layerVis[layer.name] === false ? null : (
          <group key={layer.name}>
            <DrawingLayerLines layer={layer} color={drawingLayerColor(layer.name, i)} y={0.32} />
            <DrawingLayerPoints layer={layer} color={drawingLayerColor(layer.name, i)} y={0.32} />
          </group>
        )
      )}
    </group>
  );
}

function PolyLine({ pts, color, y = 0.5, lineWidth = 2, closed = true, dashed = false }: { pts: { x: number; y: number }[]; color: string; y?: number; lineWidth?: number; closed?: boolean; dashed?: boolean }) {
  const points = useMemo(() => {
    const arr = pts.map(p => new THREE.Vector3(p.x, y, -p.y));
    if (closed && arr.length) arr.push(arr[0].clone());
    return arr;
  }, [pts, y, closed]);
  if (points.length < 2) return null;
  return <Line points={points} color={color} lineWidth={lineWidth} dashed={dashed} dashSize={4} gapSize={2.5} />;
}

// Shared spacing dimensions (sheet 3 style), visible in both plan and 3D.
// The 3D view lays the same primitives just above grade so a tilted camera
// still provides a usable measurement presentation rather than omitting it.
const DIM_COLOR = '#c4b03a';

function SpacingDimensions({ design, is3D }: { design: SiteDesign; is3D: boolean }) {
  const dims = useMemo(() => computeBlockSpacingDims(design).map(expandDim), [design]);
  const y = is3D ? 2.2 : 1.4;
  return (
    <group>
      {dims.map((d, i) => (
        <group key={i}>
          {d.lines.map((l, j) => (
            <Line
              key={j}
              points={[new THREE.Vector3(l.x1, y, -l.y1), new THREE.Vector3(l.x2, y, -l.y2)]}
              color={DIM_COLOR}
              lineWidth={1.2}
            />
          ))}
          <Text
            position={[d.text.cx, y + 0.1, -d.text.cy]}
            rotation={[-Math.PI / 2, 0, d.text.rot === 90 ? Math.PI / 2 : 0]}
            fontSize={DIM_TEXT_H}
            color={DIM_COLOR}
            outlineWidth={0.3}
            outlineColor="#0f172a"
            anchorX="center"
            anchorY="middle"
          >
            {d.text.label}
          </Text>
        </group>
      ))}
    </group>
  );
}
const FEEDER_COLOR = '#e91e63';

// 3D-only: recessed see-through trench channels along the MV feeder routes
// (same excavated look as the aux trench), with the openings stencil-cut
// out of the ground/road/surfacing materials.
function FeederTrenches() {
  // Where this area's circuits land. On a multi-area site a BESS area has no
  // local substation (its endpoint is a take-off in the substation yard), so
  // gating on `substation` would hide the trenches for every routed area.
  const substation = useDesignStore(s => s.feederEndpoint ?? s.substation);
  const feeders = useDesignStore(s => s.feeders);
  const hiddenFeeders = useDesignStore(s => s.hiddenFeeders);
  const design = useDesignStore(s => s.design);
  // Legend visibility toggles: hidden feeders get no trench channel either.
  const visibleFeeders = useMemo(
    () => feeders.filter(f => !hiddenFeeders.has(f.idx)),
    [feeders, hiddenFeeders]
  );
  // Clip context so hairpin miter patches never cut ground outside the
  // fence or through an equipment footprint (rotated rect corner polys).
  const patchBounds = useMemo(() => ({
    fence: design?.fence ?? [],
    obstacles: (design?.equipment ?? []).map(e => {
      const c = Math.cos(e.rotation), s = Math.sin(e.rotation);
      const hl = e.length / 2, hw = e.width / 2;
      return [
        { x: e.x + c * -hl - s * -hw, y: e.y + s * -hl + c * -hw },
        { x: e.x + c * hl - s * -hw, y: e.y + s * hl + c * -hw },
        { x: e.x + c * hl - s * hw, y: e.y + s * hl + c * hw },
        { x: e.x + c * -hl - s * hw, y: e.y + s * -hl + c * hw },
      ];
    }),
  }), [design]);
  if (!substation || visibleFeeders.length === 0) return null;
  return <FeederTrenchChannels feeders={visibleFeeders} patchBounds={patchBounds} />;
}

// 3D-only: excavated trench channels along the substation aux feeder daisy
// chain (34.5 kV brown circuit through every aux transformer, CAR-D-B005-0).
// Rendered via the cable-trench channel path with a fixed AUXF color key.
function AuxFeederTrenches() {
  const design = useDesignStore(s => s.design);
  const auxiliaryVisible = useDesignStore(s => s.drawingVisibility.auxiliaryCables);
  // Take-off endpoint on a multi-area site; legacy substation otherwise.
  const substation = useDesignStore(s => s.feederEndpoint ?? s.substation);
  const patchBounds = useMemo(() => ({
    fence: design?.fence ?? [],
    obstacles: (design?.equipment ?? []).map(e => {
      const c = Math.cos(e.rotation), s = Math.sin(e.rotation);
      const hl = e.length / 2, hw = e.width / 2;
      return [
        { x: e.x + c * -hl - s * -hw, y: e.y + s * -hl + c * -hw },
        { x: e.x + c * hl - s * -hw, y: e.y + s * hl + c * -hw },
        { x: e.x + c * hl - s * hw, y: e.y + s * hl + c * hw },
        { x: e.x + c * -hl - s * hw, y: e.y + s * -hl + c * hw },
      ];
    }),
  }), [design]);
  const runs = useMemo(
    () => (design?.auxFeeder?.legs ?? []).map((leg, i) => ({
      id: `auxfeeder-${i + 1}`, class: 'AUXF', pts: leg.pts,
    })),
    [design],
  );
  if (!auxiliaryVisible || !substation || runs.length === 0) return null;
  return (
    <CableTrenchChannels
      runs={runs}
      colors={{ AUXF: AUX_FEEDER_COLOR.hex }}
      patchBounds={patchBounds}
    />
  );
}

// 3D-only: narrow excavated trench channels along the AUX/DC/LVAC/fiber
// cable runs (same treatment as the feeder trenches, thinner cut and a
// smaller conductor tinted with each run's plan color).
function CableTrenches() {
  const design = useDesignStore(s => s.design);
  const drawingVisibility = useDesignStore(s => s.drawingVisibility);
  const patchBounds = useMemo(() => ({
    fence: design?.fence ?? [],
    obstacles: (design?.equipment ?? []).map(e => {
      const c = Math.cos(e.rotation), s = Math.sin(e.rotation);
      const hl = e.length / 2, hw = e.width / 2;
      return [
        { x: e.x + c * -hl - s * -hw, y: e.y + s * -hl + c * -hw },
        { x: e.x + c * hl - s * -hw, y: e.y + s * hl + c * -hw },
        { x: e.x + c * hl - s * hw, y: e.y + s * hl + c * hw },
        { x: e.x + c * -hl - s * hw, y: e.y + s * -hl + c * hw },
      ];
    }),
  }), [design]);
  // Scope: AUX/DC/LVAC/fiber runs only — in-yard MV bus/spine runs are drawn
  // as surface circuits and the MV home-run trench is FeederTrenches.
  const runs = useMemo(
    () => (design?.cables ?? []).filter(c =>
      c.class !== 'MV' && generatedCableVisible(c.class, drawingVisibility)),
    [design, drawingVisibility],
  );
  if (!design || runs.length === 0) return null;
  return <CableTrenchChannels runs={runs} colors={CABLE_COLORS} patchBounds={patchBounds} />;
}

// Preview-only F-labels along each feeder's home run when the per-feeder
// color palette is off: with every polyline drawn in the single uncolored
// pink, the flat "F n" tag at the home-run midpoint is the only way a
// drafter can match a routed line to its legend row. Never exported —
// DXF/PDF carry their own feeder callouts and keep their colors.
function FeederIdLabel({ f }: { f: { idx: number; segments: { pts: Pt[] }[] } }) {
  const home = f.segments[f.segments.length - 1];
  if (!home || home.pts.length < 2) return null;
  const a = home.pts[0], b = home.pts[home.pts.length - 1];
  const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
  return (
    <Text
      position={[mx + 4, 1.4, -(my + 4)]}
      rotation={[-Math.PI / 2, 0, 0]}
      fontSize={EQUIPMENT_LABEL_BASE_FONT_FT * 2}
      color="#ffffff"
      outlineWidth={0.4}
      outlineColor="#000000"
      anchorX="center"
      anchorY="middle"
    >
      {`#${feederDisplayName(f)}`}
    </Text>
  );
}

function SubstationAndFeeders() {
  // The LEGACY local substation drives the 40x40 substation symbol: that box
  // marks a substation placed in THIS yard, and a multi-area BESS area has
  // none (its landing point is a take-off drawn by TakeoffMarkers instead).
  const substation = useDesignStore(s => s.substation);
  const design = useDesignStore(s => s.design);
  const feeders = useDesignStore(s => s.feeders);
  const showFeederColors = useDesignStore(s => s.showFeederColors);
  const hiddenFeeders = useDesignStore(s => s.hiddenFeeders);
  const drawingVisibility = useDesignStore(s => s.drawingVisibility);
  // Routes, however, exist whenever the area has an endpoint. Returning null
  // on `!substation` hid every multi-area BESS area's feeders and aux run.
  const hasRoutes = feeders.length > 0 || (design?.auxFeeder?.legs.length ?? 0) > 0;
  if (!substation && !hasRoutes) return null;
  const S = 20; // half-size of 40x40 ft symbol
  const sq = substation ? [
    { x: substation.x - S, y: substation.y - S },
    { x: substation.x + S, y: substation.y - S },
    { x: substation.x + S, y: substation.y + S },
    { x: substation.x - S, y: substation.y + S },
  ] : null;
  return (
    <group>
      {substation && sq && <>
        <mesh position={[substation.x, 1, -substation.y]}>
          <boxGeometry args={[2 * S, 2, 2 * S]} />
          <meshStandardMaterial color={FEEDER_COLOR} transparent opacity={0.35} />
        </mesh>
        <PolyLine pts={sq} color={FEEDER_COLOR} y={1.2} lineWidth={2.5} />
        <PolyLine pts={[sq[0], sq[2]]} color={FEEDER_COLOR} y={1.2} lineWidth={1.5} closed={false} />
        <PolyLine pts={[sq[3], sq[1]]} color={FEEDER_COLOR} y={1.2} lineWidth={1.5} closed={false} />
      </>}
      {feeders.filter(f => !hiddenFeeders.has(f.idx)).map(f =>
        f.segments.map((seg, si) => (
          <PolyLine
            key={`fd${f.idx}-${si}`}
            pts={seg.pts}
            color={showFeederColors ? feederColor(f.idx).hex : FEEDER_COLOR}
            y={0.55}
            lineWidth={2.5}
            closed={false}
          />
        ))
      )}
      {drawingVisibility.auxiliaryCables && design?.auxFeeder?.legs.map((leg, li) => (
        <PolyLine
          key={`auxfd-${li}`}
          pts={leg.pts}
          color={AUX_FEEDER_COLOR.hex}
          y={0.55}
          lineWidth={2.5}
          closed={false}
        />
      ))}
      {drawingVisibility.labels && !showFeederColors &&
        feeders
          .filter(f => !hiddenFeeders.has(f.idx))
          .map(f => <FeederIdLabel key={`fdlbl${f.idx}`} f={f} />)}
    </group>
  );
}

// ---------------------------------------------------------------------------
// Substation MV take-offs (multi-area sites only).
//
// Each marker is one landing position inside a substation yard, drawn with an
// arrow showing the compass direction its feeders TRAVEL as they arrive. The
// one being repositioned pulses so the drafter can see which marker the next
// map click will move.
const TAKEOFF_COLOR = '#ffb300';
const TAKEOFF_ACTIVE_COLOR = '#ffffff';

function TakeoffMarkers() {
  const siteAreas = useDesignStore(s => s.siteAreas);
  const activeAreaId = useDesignStore(s => s.activeAreaId);
  const design = useDesignStore(s => s.design);
  const takeoffs = useDesignStore(s => s.takeoffs);
  const placingTakeoffId = useDesignStore(s => s.placingTakeoffId);
  const generatedLabelsVisible = useDesignStore(s => s.drawingVisibility.labels);
  const setPlacingTakeoff = useDesignStore(s => s.setPlacingTakeoff);

  // Every substation area's take-offs, in the shared frame — including the
  // ones the drafter is not currently editing, so the whole collection system
  // is visible at once instead of only the selected yard's.
  const markers = useMemo(() => {
    if (siteAreas.length < 2) return [];
    const bess = siteAreas.filter(a => a.kind === 'bess');
    const nameById = new Map(siteAreas.map(a => [a.id, a.name]));
    const out: { t: SubstationTakeoff; areaId: string; served: string | null }[] = [];
    for (const a of siteAreas) {
      if (a.kind !== 'substation') continue;
      // The ACTIVE area's live take-offs/design carry in-flight edits; parked
      // areas are described by their own stored edits.
      const live = a.id === activeAreaId
        ? { ...a, design: design ?? a.design, edits: { ...(a.edits ?? {}), ...(takeoffs ? { takeoffs } : {}) } }
        : a;
      for (const t of effectiveTakeoffs(live, bess)) {
        out.push({ t, areaId: a.id, served: t.servesAreaId ? (nameById.get(t.servesAreaId) ?? null) : null });
      }
    }
    return out;
  }, [siteAreas, activeAreaId, design, takeoffs]);

  if (!markers.length) return null;
  const R = 12;      // marker half-size (ft)
  const ARROW = 55;  // arrow length (ft)
  return (
    <group>
      {markers.map(({ t, areaId, served }) => {
        const active = t.id === placingTakeoffId;
        const color = active ? TAKEOFF_ACTIVE_COLOR : TAKEOFF_COLOR;
        const v = takeoffVector(t.dir);
        const vl = Math.hypot(v.dx, v.dy) || 1;
        const ux = v.dx / vl, uy = v.dy / vl;
        // The arrow points the way feeders travel INTO the take-off, so it is
        // drawn arriving: tail upwind, head at the marker.
        const tail = { x: t.x - ux * ARROW, y: t.y - uy * ARROW };
        const head = { x: t.x - ux * R, y: t.y - uy * R };
        // Barbs, rotated ±150° off the travel direction.
        const barb = (sign: number) => {
          const a = Math.atan2(uy, ux) + sign * (Math.PI * 5) / 6;
          return { x: head.x + Math.cos(a) * 16, y: head.y + Math.sin(a) * 16 };
        };
        const diamond = [
          { x: t.x, y: t.y + R }, { x: t.x + R, y: t.y },
          { x: t.x, y: t.y - R }, { x: t.x - R, y: t.y },
        ];
        return (
          // Take-off ids derive from equipment ids, which are unique only
          // WITHIN an area — two substation yards both yield
          // `takeoff-subfeeder-1`. Scope the key by owning area or React
          // collapses one yard's markers into the other's.
          <group key={`${areaId}/${t.id}`}>
            {/* Click target: picking a marker arms it for the next map click. */}
            <mesh
              position={[t.x, 1.2, -t.y]}
              onPointerDown={e => {
                e.stopPropagation();
                setPlacingTakeoff(active ? null : t.id);
              }}
            >
              <boxGeometry args={[2 * R, 2.4, 2 * R]} />
              <meshStandardMaterial color={color} transparent opacity={active ? 0.75 : 0.4} />
            </mesh>
            <PolyLine pts={diamond} color={color} y={1.5} lineWidth={2.5} />
            <PolyLine pts={[tail, head]} color={color} y={1.5} lineWidth={2} closed={false} />
            <PolyLine pts={[barb(1), head, barb(-1)]} color={color} y={1.5} lineWidth={2} closed={false} />
            {generatedLabelsVisible && (
              <Billboard position={[t.x, 14, -t.y]}>
                <Text fontSize={11} color={color} anchorX="center" anchorY="middle" outlineWidth={0.4} outlineColor="#000">
                  {served ? `${served} → ${t.dir}` : `unaimed → ${t.dir}`}
                </Text>
              </Billboard>
            )}
          </group>
        );
      })}
    </group>
  );
}

// ---------------------------------------------------------------------------
// Layout edit mode: pick a block row or the trench band and drag it on the
// ground plane. Ghost outlines snap to the layout grid and show live
// green/red validity from the same checks the engine applies; on drop the
// move becomes a layout constraint (moveRow / setTrenchPin) and the whole
// site re-optimizes. Invalid drops snap back with a warning toast.
type DragState =
  | { kind: 'row'; index: number; start: { x: number; y: number }; dx: number; dy: number; srcEqId?: string }
  | { kind: 'block'; n: number; start: { x: number; y: number }; dx: number; dy: number; srcEqId?: string }
  | { kind: 'equip'; id: string; start: { x: number; y: number }; dx: number; dy: number; srcEqId?: string }
  | { kind: 'aisle'; index: number; start: { x: number; y: number }; dy: number }
  // Perimeter ring edge: one side of the road ring slides perpendicular
  // (d = raw axis delta; inward sign resolved on drop).
  | { kind: 'ringEdge'; side: 'n' | 's' | 'e' | 'w'; start: { x: number; y: number }; d: number }
  | { kind: 'trench'; start: { x: number; y: number }; dx: number }
  | { kind: 'laydown'; start: { x: number; y: number }; dx: number; dy: number }
  | { kind: 'laydown-resize'; sx: 1 | -1; sy: 1 | -1; start: { x: number; y: number }; dx: number; dy: number }
  | { kind: 'futureAug'; id: string; start: { x: number; y: number }; dx: number; dy: number }
  | { kind: 'gate'; start: { x: number; y: number }; dx: number; dy: number }
  // Grading zones (opt-in multi-pad grading): drag the rectangle to move it,
  // drag a corner handle to resize; commits go through setGradingZones so the
  // fence/overlap validation applies (reject→warn→keep).
  | { kind: 'gzone'; id: string; start: { x: number; y: number }; dx: number; dy: number }
  | { kind: 'gzone-resize'; id: string; sx: 1 | -1; sy: 1 | -1; start: { x: number; y: number }; dx: number; dy: number }
  // Area zones (dry/wet pond, laydown yard, underground exclusion): drawn by
  // rubber-band with the Area Zone tool, moved by their perimeter band,
  // resized by corner handles. Commits go through setAreaZones (parcel +
  // overlap validation, reject→keep).
  | { kind: 'zone-place'; zkind: AreaZoneKind; start: { x: number; y: number }; cur: { x: number; y: number } }
  | { kind: 'azone'; id: string; start: { x: number; y: number }; dx: number; dy: number }
  | { kind: 'azone-resize'; id: string; sx: 1 | -1; sy: 1 | -1; start: { x: number; y: number }; dx: number; dy: number }
  // MV feeder corridor: the whole parallel-lane bundle slides along ONE
  // perpendicular axis (d = delta from the current centerline).
  | { kind: 'feederCorridor'; start: { x: number; y: number }; d: number }
  // Marquee area-select: rubber-band rectangle on the ground; on release,
  // every block whose center is inside becomes part of the group selection.
  | { kind: 'marquee'; start: { x: number; y: number }; cur: { x: number; y: number } }
  // Live island placement: the ghost follows the pointer (no rubber band).
  // Position/orientation live in the store's transient placement session, so
  // the preview, the numeric fields and the commit all read one candidate.
  // Orientation is explicit (rotate control / R), never inferred from a drag.
  | { kind: 'island-place' }
  | { kind: 'pisland'; id: string; angleDeg: number; cx: number; cy: number; start: { x: number; y: number }; dx: number; dy: number; srcEqId?: string }
  // Move of an individually placed auxiliary/comms/panel item. Rides the same
  // transient placement session as a placed island, so a hand-placed item gets
  // the identical snap increments, explicit rotation and live verdict.
  | { kind: 'pequip'; id: string; angleDeg: number; start: { x: number; y: number }; srcEqId?: string }
  // Group move: all marquee-selected blocks translate together by (dx, dy)
  | { kind: 'group'; ns: number[]; start: { x: number; y: number }; dx: number; dy: number };

export type EditTool = 'move' | 'marquee' | 'road' | 'road-remove' | 'island' | 'zone';

// A road selected on the plan. `piece` is present when the click landed on a
// road that carries identity (a generated aisle / middle road, the gate
// entrance, or a drafter-drawn road) and can therefore be deleted whole. The
// perimeter ring has no id — it is one continuous loop — so a pick there
// carries only the point, and deletion happens by span.
// A road pick. `piece` is the named road under the pointer when there is one.
// The unnamed perimeter ring has no id, so a pick there resolves to the whole
// straight RUN through the point (corner to corner) plus the road-shaped cut
// polygon that deletes it — never a stub at the click.
export type RoadSel = { pt: Pt; piece: RoadPick | null; run?: Pt[] | null; cut?: Pt[] | null };

// Mirror of the engine's gate-pin snap: nearest point on the fence line where
// the 24 ft opening fits with 5 ft corner clearance. Returns the snapped
// point, the fence segment rotation, and whether the drop would be accepted.
function snapGateToFence(fence: { x: number; y: number }[], pt: { x: number; y: number }) {
  const GATE_W = 24;
  let best: { x: number; y: number; rot: number; d: number } | null = null;
  for (let i = 0; i < fence.length; i++) {
    const a = fence[i], b = fence[(i + 1) % fence.length];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < GATE_W + 10) continue;
    const ux = (b.x - a.x) / len, uy = (b.y - a.y) / len;
    const tRaw = (pt.x - a.x) * ux + (pt.y - a.y) * uy;
    const t = Math.max(GATE_W / 2 + 5, Math.min(len - GATE_W / 2 - 5, tRaw));
    const px = a.x + ux * t, py = a.y + uy * t;
    const d = Math.hypot(px - pt.x, py - pt.y);
    if (!best || d < best.d) best = { x: px, y: py, rot: Math.atan2(b.y - a.y, b.x - a.x), d };
  }
  if (!best) return null;
  return { ...best, valid: best.d <= GATE_PIN_SNAP_FT };
}

// Resize keeping the corner opposite the dragged handle fixed. Signs (sx, sy)
// identify the dragged corner; dims are clamped to the engine minimum edge.
function resizeLaydownRect(
  z: { x: number; y: number; length: number; width: number },
  sx: 1 | -1, sy: 1 | -1, dx: number, dy: number
) {
  const fixedX = z.x - (sx * z.length) / 2;
  const fixedY = z.y - (sy * z.width) / 2;
  const movX = z.x + (sx * z.length) / 2 + dx;
  const movY = z.y + (sy * z.width) / 2 + dy;
  const length = Math.max(MIN_LAYDOWN_EDGE_FT, sx * (movX - fixedX));
  const width = Math.max(MIN_LAYDOWN_EDGE_FT, sy * (movY - fixedY));
  return { x: fixedX + (sx * length) / 2, y: fixedY + (sy * width) / 2, length, width };
}

// Resize a grading zone keeping the corner opposite the dragged handle fixed;
// dims clamp to the engine minimum so the ghost mirrors what sanitize keeps.
function resizeGradingZoneRect(z: GradingZone, sx: 1 | -1, sy: 1 | -1, dx: number, dy: number) {
  const fixedX = z.x - (sx * z.lengthFt) / 2;
  const fixedY = z.y - (sy * z.widthFt) / 2;
  const movX = z.x + (sx * z.lengthFt) / 2 + dx;
  const movY = z.y + (sy * z.widthFt) / 2 + dy;
  const lengthFt = Math.max(ZONE_MIN_SIZE_FT, sx * (movX - fixedX));
  const widthFt = Math.max(ZONE_MIN_SIZE_FT, sy * (movY - fixedY));
  return { x: fixedX + (sx * lengthFt) / 2, y: fixedY + (sy * widthFt) / 2, lengthFt, widthFt };
}

// Same fixed-opposite-corner resize for drafter-drawn area zones.
function resizeAreaZoneRect(z: AreaZone, sx: 1 | -1, sy: 1 | -1, dx: number, dy: number) {
  const fixedX = z.x - (sx * z.lengthFt) / 2;
  const fixedY = z.y - (sy * z.widthFt) / 2;
  const movX = z.x + (sx * z.lengthFt) / 2 + dx;
  const movY = z.y + (sy * z.widthFt) / 2 + dy;
  const lengthFt = Math.max(AREA_ZONE_MIN_SIZE_FT, sx * (movX - fixedX));
  const widthFt = Math.max(AREA_ZONE_MIN_SIZE_FT, sy * (movY - fixedY));
  return { x: fixedX + (sx * lengthFt) / 2, y: fixedY + (sy * widthFt) / 2, lengthFt, widthFt };
}

function rowBBox(row: BlockRowInfo, halfW: number, halfD: number) {
  const xs = row.blocks.map(b => b.x);
  return {
    minX: Math.min(...xs) - halfW,
    maxX: Math.max(...xs) + halfW,
    minY: row.y - halfD,
    maxY: row.y + halfD,
  };
}

function GhostRect({ minX, maxX, minY, maxY, valid }: { minX: number; maxX: number; minY: number; maxY: number; valid: boolean }) {
  const color = valid ? '#22c55e' : '#ef4444';
  return (
    <group>
      <mesh position={[(minX + maxX) / 2, 0.7, -(minY + maxY) / 2]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[maxX - minX, maxY - minY]} />
        <meshBasicMaterial color={color} transparent opacity={0.18} side={THREE.DoubleSide} />
      </mesh>
      <Line
        points={[
          new THREE.Vector3(minX, 0.8, -minY),
          new THREE.Vector3(maxX, 0.8, -minY),
          new THREE.Vector3(maxX, 0.8, -maxY),
          new THREE.Vector3(minX, 0.8, -maxY),
          new THREE.Vector3(minX, 0.8, -minY),
        ]}
        color={color}
        lineWidth={3}
      />
    </group>
  );
}

function inOpenDialog(t: HTMLElement | null): boolean {
  if (typeof document !== 'undefined' && document.querySelector('dialog[open], [role="dialog"][data-state="open"]')) return true;
  return !!t?.closest?.('dialog, [role="dialog"], [role="alertdialog"]');
}
export type NudgeTarget =
  | { kind: 'block'; n: number }
  // placedId: the placedIslands constraint id for a hand-placed island, so
  // toolbar actions can target its own constraint (deletion removes the whole
  // placement, not its individual blocks).
  | { kind: 'island'; n: number; placed: boolean; blockNs: number[]; placedId?: string };

// A single selected equipment item (the FIRST click on anything). This is a
// deliberately separate channel from NudgeTarget: Center / Restore / the arrow
// keys act on blocks and islands only, but Delete must act on exactly what is
// selected — including one cabinet, panel or aux unit. Publishing it lets the
// toolbar show the same Delete the Delete key runs at equipment scope, instead
// of showing no button at all until the selection is widened to a block.
export type SelectedEquip = {
  id: string;
  label: string;
  // Set when the item belongs to a hand-placed island: deleting one member of
  // a placement is not a thing, so the toolbar offers the island removal.
  placedId?: string;
  placedIslandN?: number;
};

function LayoutEditLayer({ design, onDraggingChange, tool, onToolChange, zoneKind, islandPairs, placeKind, placeAug, placeAuxGear, placeEquipType, placeAngleDeg, placeSnap, roadDrawWidth, fgSurface, terrainYard, onSelectedIslandChange, onSelectedTargetChange, onSelectedEquipChange, onRoadSelectionChange }: { design: SiteDesign; onDraggingChange: (d: boolean) => void; tool: EditTool; onToolChange: (t: EditTool) => void; zoneKind: AreaZoneKind; islandPairs: number; placeKind: PlacementKind; placeAug: boolean; placeAuxGear: boolean; placeEquipType: ManualEquipmentType; placeAngleDeg: number; placeSnap: number; roadDrawWidth: number; fgSurface?: FgSurface | null; terrainYard?: ElevationGrid | null; onSelectedIslandChange?: (islandN: number | null) => void; onSelectedTargetChange?: (t: NudgeTarget | null) => void; onSelectedEquipChange?: (e: SelectedEquip | null) => void; onRoadSelectionChange?: (s: { labels: string[]; onDelete: () => void; onSpan: () => void; spanArmed: boolean; onPave?: () => void } | null) => void }) {
  const layoutEdits = useDesignStore(s => s.layoutEdits);
  const roadMode = useDesignStore(s => s.roadMode);
  const moveRow = useDesignStore(s => s.moveRow);
  const moveAisle = useDesignStore(s => s.moveAisle);
  const moveBlock = useDesignStore(s => s.moveBlock);
  const moveEquipment = useDesignStore(s => s.moveEquipment);
  const setTrenchPin = useDesignStore(s => s.setTrenchPin);
  const setFeederCorridorPin = useDesignStore(s => s.setFeederCorridorPin);
  const maxPcsPerFeeder = useDesignStore(s => s.maxPcsPerFeeder);
  const substation = useDesignStore(s => s.substation);
  const feeders = useDesignStore(s => s.feeders);
  const setLaydownPin = useDesignStore(s => s.setLaydownPin);
  const setLaydownRect = useDesignStore(s => s.setLaydownRect);
  const setFutureAugPin = useDesignStore(s => s.setFutureAugPin);
  const setGatePin = useDesignStore(s => s.setGatePin);
  const moveBlocksGroup = useDesignStore(s => s.moveBlocksGroup);
  const addPlacedIsland = useDesignStore(s => s.addPlacedIsland);
  const movePlacedIsland = useDesignStore(s => s.movePlacedIsland);
  // Transient placement session (never persisted; see the store).
  const placement = useDesignStore(s => s.placement);
  const beginPlacement = useDesignStore(s => s.beginPlacement);
  const updatePlacementPointer = useDesignStore(s => s.updatePlacementPointer);
  const nudgePlacement = useDesignStore(s => s.nudgePlacement);
  const rotatePlacement = useDesignStore(s => s.rotatePlacement);
  const cancelPlacement = useDesignStore(s => s.cancelPlacement);
  const commitPlacement = useDesignStore(s => s.commitPlacement);
  const realisticModels = useDesignStore(s => s.realisticModels);
  const acquireForceRealisticNear = useDesignStore(s => s.acquireForceRealisticNear);
  const releaseForceRealisticNear = useDesignStore(s => s.releaseForceRealisticNear);
  const removePlacedIsland = useDesignStore(s => s.removePlacedIsland);
  const bulkTag = useDesignStore(s => s.bulkTag);
  const rotatePlacedIsland = useDesignStore(s => s.rotatePlacedIsland);
  const removePlacedEquipment = useDesignStore(s => s.removePlacedEquipment);
  const rotatePlacedEquipment = useDesignStore(s => s.rotatePlacedEquipment);
  const rotateEquipment = useDesignStore(s => s.rotateEquipment);
  const rotateBlock = useDesignStore(s => s.rotateBlock);
  const rotateBlocksGroup = useDesignStore(s => s.rotateBlocksGroup);
  const moveRingEdge = useDesignStore(s => s.moveRingEdge);
  const configId = useDesignStore(s => s.configId);
  const containersPerPcs = useDesignStore(s => s.containersPerPcs);
  const hotClimate = useDesignStore(s => s.hotClimate);
  const addCustomRoad = useDesignStore(s => s.addCustomRoad);
  const removeGeneratedRoad = useDesignStore(s => s.removeGeneratedRoad);
  const removeCustomRoad = useDesignStore(s => s.removeCustomRoad);
  const cutRoadArea = useDesignStore(s => s.cutRoadArea);
  const deleteBlock = useDesignStore(s => s.deleteBlock);
  const deleteEquipment = useDesignStore(s => s.deleteEquipment);
  const deleteAutoIsland = useDesignStore(s => s.deleteAutoIsland);
  const deleteEquipmentBatch = useDesignStore(s => s.deleteEquipmentBatch);
  const setFeederRoute = useDesignStore(s => s.setFeederRoute);
  const setAuxFeederRoute = useDesignStore(s => s.setAuxFeederRoute);
  const hiddenFeeders = useDesignStore(s => s.hiddenFeeders);
  const gradingEnabled = useDesignStore(s => s.gradingEnabled);
  const gradingZonesAll = useDesignStore(s => s.gradingZones);
  const setGradingZones = useDesignStore(s => s.setGradingZones);
  // Zones are only draggable while grading is enabled; zero zones = nothing.
  const gzones = gradingEnabled ? gradingZonesAll : [];
  // Drafter-drawn area zones: always editable in edit mode (no toggle).
  const azones = useDesignStore(s => s.areaZones);
  const setAreaZones = useDesignStore(s => s.setAreaZones);
  const [drag, setDrag] = useState<DragState | null>(null);
  // rAF-coalesced drag updates: latest pointer plane point + scheduled frame.
  const dragMovePt = useRef<{ x: number; y: number } | null>(null);
  const dragMoveRaf = useRef(0);
  // Same coalescing for the live placement session's pointer tracking.
  const placeMovePt = useRef<{ x: number; y: number } | null>(null);
  const placeMoveRaf = useRef(0);
  useEffect(() => () => { if (placeMoveRaf.current) cancelAnimationFrame(placeMoveRaf.current); }, []);
  useEffect(() => {
    if (drag) return;
    // Drag ended (or none active): drop any pending coalesced move so a
    // stale frame can't fire after release. The functional setDrag is a
    // no-op on null anyway; this just avoids the wasted render.
    if (dragMoveRaf.current) cancelAnimationFrame(dragMoveRaf.current);
    dragMoveRaf.current = 0;
    dragMovePt.current = null;
  }, [drag]);
  useEffect(() => () => { if (dragMoveRaf.current) cancelAnimationFrame(dragMoveRaf.current); }, []);
  const [hover, setHover] = useState<string | null>(null);
  // Click-to-select with hierarchy cycling: clicking equipment selects the
  // item, clicking again widens to its block, again to its row, then back.
  // Selection scope is deliberately separate from the drag target.  A PCS
  // block is a single equipment group; an island is a rigid collection of
  // those groups.  Keeping that distinction here prevents a keyboard nudge
  // of an automatic island from silently becoming a whole-row move.
  const [sel, setSel] = useState<{ eqId: string; scope: 'equip' | 'block' | 'island' | 'row' } | null>(null);
  // Marquee area selection: block numbers picked up by the last rubber-band.
  // Dragging any selected block moves the whole group together.
  const [groupSel, setGroupSel] = useState<number[]>([]);
  // Shift-click multi-selection: heterogeneous units (whole blocks, single
  // equipment items, whole hand-placed islands) picked up one Shift-click at
  // a time. Composes with the marquee groupSel: Delete acts on both at once,
  // through ONE store transaction (one regeneration, one undo step).
  type MultiEntry =
    | { kind: 'block'; n: number }
    | { kind: 'equip'; id: string }
    | { kind: 'pisland'; id: string };
  const [multiSel, setMultiSel] = useState<MultiEntry[]>([]);
  const toggleMultiSel = useCallback((entry: MultiEntry) => {
    setMultiSel(prev => {
      const same = (m: MultiEntry) =>
        m.kind === entry.kind &&
        (m.kind === 'block' ? m.n === (entry as { n: number }).n
          : (m as { id: string }).id === (entry as { id: string }).id);
      return prev.some(same) ? prev.filter(m => !same(m)) : [...prev, entry];
    });
  }, []);
  // Road drawing: committed vertices + live cursor point for the preview.
  const [roadPts, setRoadPts] = useState<Pt[]>([]);
  const [roadCursor, setRoadCursor] = useState<Pt | null>(null);
  // Road selection: the road(s) picked on the plan, deletable with Delete /
  // Backspace or the toolbar exactly like a block or an island.
  const [roadSel, setRoadSel] = useState<RoadSel[]>([]);
  // Road hover: the road piece currently under the cursor in road-remove mode.
  // Cleared on pointer-out or tool change. Distinct from selection so the
  // drafter sees the target BEFORE clicking, not only after.
  const [roadHover, setRoadHover] = useState<{ piece: RoadPick | null; pt: Pt } | null>(null);
  // Point-to-point span cut: first picked point + live cursor. The cut is
  // sized to the road's own width at the picked points, so it works on a
  // tapering gate apron as well as a standard 24 ft aisle.
  const [spanPt, setSpanPt] = useState<Pt | null>(null);
  const [spanCursor, setSpanCursor] = useState<Pt | null>(null);
  // Feeder route drawing: clicking a home run enters waypoint mode; clicks
  // add vertices, Enter/double-click commits, Escape cancels.
  const [fdDraw, setFdDraw] = useState<{ idx: number; launch: Pt } | null>(null);
  const [fdPts, setFdPts] = useState<Pt[]>([]);
  const [fdCursor, setFdCursor] = useState<Pt | null>(null);
  // Aux feeder route drawing: the whole 34.5 kV daisy chain as one drawable
  // path. Same waypoint flow as MV feeders.
  const [auxFdDraw, setAuxFdDraw] = useState<boolean>(false);
  const [auxFdPts, setAuxFdPts] = useState<Pt[]>([]);
  const [auxFdCursor, setAuxFdCursor] = useState<Pt | null>(null);
  // Legend → scene bridge: a feeder-row click in the MV FEEDERS legend
  // (edit mode) requests the waypoint-draw flow for that circuit — same
  // entry as clicking the home run in the scene.
  const feederDrawRequest = useDesignStore(s => s.feederDrawRequest);
  useEffect(() => {
    if (feederDrawRequest == null) return;
    useDesignStore.getState().requestFeederDraw(null);
    const f = feeders.find(ff => ff.idx === feederDrawRequest);
    const home = f?.segments[f.segments.length - 1];
    if (!f || !home || home.pts.length === 0) return;
    const launch = home.pts[0];
    setFdDraw({ idx: f.idx, launch: { x: launch.x, y: launch.y } });
    setFdPts([]); setFdCursor(null);
    if (tool !== 'move') onToolChange('move');
    toast.info(`Drawing route for feeder #${feederDisplayName(f)} — click waypoints, Enter or double-click to apply, Esc to cancel.`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feederDrawRequest]);
  // Legend → scene bridge: an AUX FEEDER row click requests aux draw mode.
  const auxFeederDrawRequest = useDesignStore(s => s.auxFeederDrawRequest);
  useEffect(() => {
    if (!auxFeederDrawRequest) return;
    useDesignStore.setState({ auxFeederDrawRequest: false });
    if (!substation) return;
    setAuxFdDraw(true);
    setAuxFdPts([]); setAuxFdCursor(null);
    if (tool !== 'move') onToolChange('move');
    toast.info('Drawing aux feeder route — click waypoints, Enter or double-click to apply, Esc to cancel.');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auxFeederDrawRequest]);

  const geom = design.rowEditGeom;
  const rows = design.blockRows.filter(r => r.blocks.length > 0);

  // eq id -> owning block number (containers/PCS only) and row index
  const blockOfEq = (id: string): number | null => {
    const m = id.match(/^(?:bess|inv)-(\d+)/);
    return m ? Number(m[1]) : null;
  };
  const rowOfBlock = (n: number): number | null =>
    rows.find(r => r.blocks.some(b => b.n === n))?.index ?? null;
  // Placed islands live outside the row machinery, so their blocks never
  // appear in blockRows. Resolve them straight off the island list instead.
  const placedIslandOfBlock = (n: number) =>
    (design.islands ?? []).find(i => i.placed && i.inverterIds.includes(`inv-${n}`)) ?? null;
  const blockCenterOf = (n: number) => {
    for (const r of rows) {
      const b = r.blocks.find(bb => bb.n === n);
      if (b) return b;
    }
    return null;
  };
  const selEq = sel ? design.equipment.find(e => e.id === sel.eqId) ?? null : null;

  // Resolve the current selection to its owning mirrored-pair island (single
  // pick via block number, or a marquee group entirely inside one island) and
  // report it so the top-level Align control can scope to that island.
  useEffect(() => {
    if (!onSelectedIslandChange) return;
    const islands = design.islands ?? [];
    const islandOfBlock = (n: number) =>
      islands.find(i => i.inverterIds.includes(`inv-${n}`))?.n ?? null;
    let islandN: number | null = null;
    if (islands.length) {
      if (groupSel.length) {
        const owners = Array.from(new Set(groupSel.map(islandOfBlock)));
        if (owners.length === 1 && owners[0] !== null) islandN = owners[0];
      } else if (sel) {
        const n = blockOfEq(sel.eqId);
        if (n !== null) islandN = islandOfBlock(n);
      }
    }
    onSelectedIslandChange(islandN);
    // Reset on unmount (edit mode off / design cleared).
    return () => onSelectedIslandChange(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel, groupSel, design.islands, onSelectedIslandChange]);

  // Commit an in-progress aux feeder route: interior waypoints become the
  // drawn 34.5 kV daisy-chain route. Rejection snaps back with the engine
  // reason and an engineer-override retry.
  const commitAuxFeederRoute = () => {
    if (!auxFdDraw || auxFdPts.length < 1) return;
    const pts = [...auxFdPts];
    const ok = setAuxFeederRoute(pts);
    if (ok) {
      toast.success('Aux feeder rerouted — trench geometry and exports updated');
    } else {
      const why = useDesignStore.getState().lastRejection;
      toast.error(`Aux feeder route rejected — ${why ?? 'validation failed'}. Automatic route kept.`, {
        duration: 8000,
        action: {
          label: 'Override',
          onClick: () => {
            const forced = setAuxFeederRoute(pts, true);
            if (forced) toast.warning('Aux feeder route applied with engineer override — verify clearances in detailed design.');
            else toast.error('Aux feeder route could not be overridden — this rule cannot be bypassed.');
          },
        },
      });
    }
    setAuxFdDraw(false); setAuxFdPts([]); setAuxFdCursor(null);
  };

  // Commit an in-progress feeder route: waypoints become the drafter's
  // custom home run. Rejection snaps back with the engine's reason and an
  // engineer-override retry (same pattern as block/row moves).
  const commitFeederRoute = () => {
    if (!fdDraw || fdPts.length < 1) return;
    const { idx } = fdDraw;
    const pts = [...fdPts];
    // Breaker-position name for the toasts (falls back to F<idx> on
    // pre-naming sessions) — looked up BEFORE the route regenerates feeders.
    const nm = feederDisplayName({ idx, name: useDesignStore.getState().feeders.find(f => f.idx === idx)?.name });
    const ok = setFeederRoute(idx, pts);
    if (ok) {
      toast.success(`Feeder #${nm} rerouted — lengths, voltage drop, trenches and exports updated`);
    } else {
      const why = useDesignStore.getState().lastRejection;
      toast.error(`Feeder #${nm} route rejected — ${why ?? 'validation failed'}. Automatic route kept.`, {
        duration: 8000,
        action: {
          label: 'Override',
          onClick: () => {
            const forced = setFeederRoute(idx, pts, true);
            if (forced) toast.warning(`Feeder #${nm} route applied with engineer override — verify clearances in detailed design.`);
            else toast.error(`Feeder #${nm} route could not be overridden — this rule cannot be bypassed.`);
          },
        },
      });
    }
    setFdDraw(null); setFdPts([]); setFdCursor(null);
  };

  // Resolve the exact keyboard target.  A block selection always wins over
  // its parent island; marquee selection is an island only when every picked
  // block belongs to the same island.
  const selNudgeTarget = useMemo(() => {
    const islands = design.islands ?? [];
    const islandOfBlock = (n: number) =>
      islands.find(i => i.inverterIds.includes(`inv-${n}`)) ?? null;
    if (groupSel.length) {
      const owners = Array.from(new Set(groupSel.map(n => islandOfBlock(n)?.n ?? null)));
      if (owners.length === 1 && owners[0] !== null) {
        return { kind: 'island' as const, island: islands.find(i => i.n === owners[0])! };
      }
      return null;
    }
    if (sel) {
      const n = blockOfEq(sel.eqId);
      if (n === null) return null;
      if (sel.scope === 'block') return { kind: 'block' as const, n };
      if (sel.scope === 'island') {
        const island = islandOfBlock(n);
        return island ? { kind: 'island' as const, island } : null;
      }
    }
    return null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel, groupSel, design.islands]);

  // Drivable road surface as a boolean region. This is what makes every road
  // kind selectable through one code path: the perimeter ring, gate apron,
  // aisles, middle roads and drawn roads are all just area in this region, so
  // hit-testing it needs no per-kind special cases.
  const roadRegion = useMemo(() => {
    try { return roadRegionFromNetwork(design.roadNetwork); } catch { return []; }
  }, [design.roadNetwork]);

  // Traced strips the gate-apron rule kept as reference linework: they draw
  // no pavement, so the road tool's pavement hit-test can never reach them.
  // Resolve them from their stored records instead, so the drafter can still
  // select one (to delete it, or to force-pave it as drawn).
  const tracedLineworkRoads = useMemo(
    () => (layoutEdits.customRoads ?? []).filter(r =>
      r.traced === true && tracedRoadRendersUnpaved(roadRegion, r)),
    [layoutEdits.customRoads, roadRegion]);

  // A road selection is stale the moment the network is rebuilt underneath it
  // (the road may be gone, or now be a different shape), so clear it.
  useEffect(() => { setRoadSel([]); setSpanPt(null); setSpanCursor(null); }, [design.roadNetwork]);
  useEffect(() => {
    if (tool !== 'road-remove') { setRoadSel([]); setSpanPt(null); setSpanCursor(null); }
  }, [tool]);

  // Delete every selected road. Named roads go through their own suppression
  // constraint (so the panel can list and restore them by name); a pick on the
  // unnamed perimeter ring is deleted as an area cut at that point.
  const deleteSelectedRoads = () => {
    if (!roadSel.length) return;
    let done = 0;
    const notes: string[] = [];
    for (const rs of roadSel) {
      if (rs.piece?.kind === 'drawn') {
        removeCustomRoad(rs.piece.id);
        done++;
      } else if (rs.piece) {
        const warn = removeGeneratedRoad(rs.piece.id);
        if (warn) notes.push(warn);
        done++;
      } else {
        // Unnamed perimeter ring: delete the whole run the click selected
        // (corner to corner), not a stub at the pick.
        const region = roadRegionFromNetwork(useDesignStore.getState().design?.roadNetwork);
        const run = rs.run ?? roadRunAt(region, rs.pt);
        const poly = rs.cut ?? (run ? roadCorridorCutPoly(region, run) : null) ?? ringSpanCutAt(region, rs.pt);
        if (!poly) { notes.push('Could not measure the perimeter road at that point.'); continue; }
        const warn = cutRoadArea(poly, 'Perimeter road');
        const rejected = useDesignStore.getState().lastRejection;
        if (rejected) notes.push(rejected);
        else { done++; if (warn) notes.push(warn); }
      }
    }
    setRoadSel([]);
    if (done) toast.success(`${done} road${done === 1 ? '' : 's'} deleted — road network, surfacing, cables, feeders and exports rebuilt`);
    if (notes.length) toast.warning(notes[0], { duration: 10000 });
  };

  // Publish the road selection so the toolbar can expose the same Delete the
  // Delete key runs. Deliberately not memoized on the callbacks: they close
  // over the current selection, and a stale closure would delete the wrong
  // road.
  useEffect(() => {
    if (!onRoadSelectionChange) return;
    if (!roadSel.length && !spanPt) { onRoadSelectionChange(null); return; }
    // Force-pave eligibility: exactly one selected road, it is a traced
    // record, no override for it is stored yet, and it currently renders as
    // reference linework (no pavement). Keyed by geometry fingerprint like
    // the deletion tombstones, so the override survives the stale-save
    // heal's id re-sequencing.
    const paveable = (() => {
      if (roadSel.length !== 1) return null;
      const pc = roadSel[0].piece;
      if (!pc || pc.kind !== 'drawn') return null;
      const rec = (layoutEdits.customRoads ?? []).find(r => r.id === pc.id);
      if (!rec || rec.traced !== true) return null;
      if (tracedRoadFingerprintMatch(tracedRoadFingerprint(rec.pts), layoutEdits.pavedTracedRoads)) return null;
      // Only offer the action for strips the apron render guard actually
      // warned about — outside that guard (e.g. roads-mode clipping) an
      // override would be stored but change nothing on screen.
      const warns = useDesignStore.getState().design?.warnings ?? [];
      if (!warns.some(w => w.includes(`Traced road ${rec.id} kept as reference linework only`))) return null;
      return tracedRoadRendersUnpaved(roadRegion, rec) ? rec : null;
    })();
    onRoadSelectionChange({
      labels: roadSel.map(r => r.piece?.label ?? 'Perimeter road'),
      onDelete: deleteSelectedRoads,
      onSpan: () => {
        if (roadSel.length !== 1) return;
        setSpanPt(roadSel[0].pt);
        setSpanCursor(roadSel[0].pt);
        setRoadSel([]);
        toast.info('Click the far end of the stretch to delete — the cut follows the road between your two clicks. Esc cancels.');
      },
      spanArmed: spanPt !== null,
      ...(paveable ? {
        onPave: () => {
          const ok = useDesignStore.getState().paveTracedRoad(paveable.id);
          if (ok) {
            toast.warning('Traced strip paved as drawn (drafter override) — it still fails the gate-apron rule, so verify the entrance approach in detailed design.', { duration: 10000 });
          } else {
            toast.error(useDesignStore.getState().lastRejection ?? 'Could not pave this road as drawn.');
          }
          setRoadSel([]);
        },
      } : {}),
    });
    return () => onRoadSelectionChange(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roadSel, spanPt, onRoadSelectionChange]);

  // Publish the resolved target so the toolbar's Center / Restore controls
  // act on exactly what the arrow keys move.
  useEffect(() => {
    if (!onSelectedTargetChange) return;
    if (!selNudgeTarget) { onSelectedTargetChange(null); return; }
    if (selNudgeTarget.kind === 'block') {
      onSelectedTargetChange({ kind: 'block', n: selNudgeTarget.n });
    } else {
      const isl = selNudgeTarget.island;
      // A hand-placed island is edited through its OWN constraint, so publish
      // the spec id (matched on the anchor the engine stamped on the island).
      const placedSpec = isl.placed === true
        ? (layoutEdits.placedIslands ?? []).find(p =>
            Math.abs(p.x - (isl.cx ?? NaN)) < 0.51 && Math.abs(p.y - (isl.cy ?? NaN)) < 0.51)
        : undefined;
      onSelectedTargetChange({
        kind: 'island',
        n: isl.n,
        placed: isl.placed === true,
        blockNs: isl.inverterIds
          .map(id => Number((id.match(/^inv-(\d+)/) ?? [])[1]))
          .filter(Number.isInteger),
        ...(placedSpec ? { placedId: placedSpec.id } : {}),
      });
    }
    return () => onSelectedTargetChange(null);
  }, [selNudgeTarget, onSelectedTargetChange, layoutEdits.placedIslands]);

  // Publish the single picked item so the toolbar can offer the SAME Delete
  // the Delete key runs at equipment scope. selNudgeTarget resolves only to
  // blocks and islands, so on its own it leaves a selected cabinet, panel or
  // aux unit with no visible delete action at all.
  useEffect(() => {
    if (!onSelectedEquipChange) return;
    // A wider scope owns the toolbar: the block/island Delete is already shown.
    if (!sel || selNudgeTarget || groupSel.length) { onSelectedEquipChange(null); return; }
    const eq = design.equipment.find(e => e.id === sel.eqId);
    if (!eq) { onSelectedEquipChange(null); return; }
    // Items of a hand-placed island are removed through the placement's own
    // constraint, never one member at a time, so publish that route instead.
    const n = blockOfEq(sel.eqId);
    const pIsl = n === null ? null : placedIslandOfBlock(n);
    const spec = pIsl
      ? (layoutEdits.placedIslands ?? []).find(p =>
          Math.abs(p.x - (pIsl.cx ?? NaN)) < 0.51 && Math.abs(p.y - (pIsl.cy ?? NaN)) < 0.51)
      : undefined;
    onSelectedEquipChange({
      id: eq.id,
      label: eq.label || eq.id,
      ...(spec ? { placedId: spec.id, placedIslandN: pIsl!.n } : {}),
    });
    return () => onSelectedEquipChange(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel, selNudgeTarget, groupSel, design.equipment, design.islands, onSelectedEquipChange, layoutEdits.placedIslands]);

  // Escape clears the selection (and any in-flight drag snaps back);
  // while drawing a road, Escape cancels the polyline and Enter commits it.
  // Arrow keys nudge the selected PCS block or island.  Fine control is the
  // default (0.1 ft); Shift supplies the deliberately coarser 1 ft step and
  // Ctrl/Cmd+Shift is useful for traversing long sites.  All paths use the
  // regular transactional edit actions, so rejects roll back and retain their
  // normal engineer-override warning rather than creating a keyboard-only
  // escape hatch.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
      // A live placement preview owns the keyboard first: R rotates the ghost,
      // arrows nudge the candidate by an exact step, Enter commits it. All of
      // these change ONLY the transient session until Enter.
      if (!typing && placement) {
        if (e.key === 'r' || e.key === 'R') {
          e.preventDefault();
          rotatePlacement();
          return;
        }
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          e.preventDefault();
          // Same convention as the committed-selection nudges: fine by
          // default, Shift = 1 ft, Ctrl/Cmd+Shift = 10 ft.
          const step = e.shiftKey
            ? ((e.ctrlKey || e.metaKey) ? PLACEMENT_NUDGE_FT.far : PLACEMENT_NUDGE_FT.coarse)
            : PLACEMENT_NUDGE_FT.fine;
          nudgePlacement(
            e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0,
            e.key === 'ArrowDown' ? -step : e.key === 'ArrowUp' ? step : 0);
          return;
        }
        if (e.key === 'Enter') {
          e.preventDefault();
          commitPlacementSession();
          return;
        }
      }
      if (!typing && !drag && tool === 'move' && selNudgeTarget &&
          (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault();
        const step = e.shiftKey ? ((e.ctrlKey || e.metaKey) ? 10 : 1) : 0.1;
        const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
        const dy = e.key === 'ArrowDown' ? -step : e.key === 'ArrowUp' ? step : 0;
        const target = selNudgeTarget;
        // Held-key repeats collapse into a single undo step per target, so
        // undo reverts a whole nudge burst instead of one 0.1 ft increment.
        const ckey = target.kind === 'block'
          ? `nudge-block-${target.n}`
          : `nudge-island-${target.island.n}`;
        if (target.kind === 'block') {
          const total = composeRowMove(layoutEdits.blockMoves?.[target.n], dx, dy);
          const ok = moveBlock(target.n, total.dx, total.dy, false, ckey);
          if (!ok) {
            const why = useDesignStore.getState().lastRejection;
            toast.error(`PCS block nudge rejected — ${why ?? 'validation failed'}. Position kept.`, {
              duration: 6000,
              action: {
                label: 'Override',
                onClick: () => {
                  const forced = moveBlock(target.n, total.dx, total.dy, true);
                  if (forced) toast.warning('PCS block nudge applied with engineer override — verify clearances in detailed design.');
                  else toast.error('This rule cannot be bypassed.');
                },
              },
            });
          }
        } else if (target.island.placed) {
          const info = target.island;
          // Drag-placed island: match its anchor to the drafter's spec, then
          // apply the delta through the store (full re-validation).
          const ax = info.cx ?? (info.minX + info.maxX) / 2;
          const ay = info.cy ?? info.y;
          const specs = layoutEdits.placedIslands ?? [];
          const spec = specs
            .map(p => ({ p, d: Math.hypot(p.x - ax, p.y - ay) }))
            .sort((a, b) => a.d - b.d)[0]?.p;
          if (!spec) return;
          const why = movePlacedIsland(spec.id, dx, dy, ckey);
          if (why !== null) {
            toast.error(`Island nudge rejected — ${why}. Position kept.`, { duration: 6000 });
          }
        } else {
          // An automatic island can share a row.  Move precisely its own
          // blocks together, never the whole row (which used to move its
          // neighbor as an unexpected side effect).
          const blockNs = target.island.inverterIds
            .map(id => Number((id.match(/^inv-(\d+)/) ?? [])[1]))
            .filter(Number.isInteger);
          const moves = blockNs.map(n => {
            const total = composeRowMove(layoutEdits.blockMoves?.[n], dx, dy);
            return { n, dx: total.dx, dy: total.dy };
          });
          const ok = moves.length > 0 && moveBlocksGroup(moves, false, ckey);
          if (!ok) {
            const why = useDesignStore.getState().lastRejection;
            toast.error(`Island nudge rejected — ${why ?? 'validation failed'}. Position kept.`, {
              duration: 6000,
              action: {
                label: 'Override',
                onClick: () => {
                  const forced = moveBlocksGroup(moves, true);
                  if (forced) toast.warning('Island nudge applied with engineer override — verify clearances in detailed design.');
                  else toast.error('This rule cannot be bypassed.');
                },
              },
            });
          }
        }
        return;
      }
      // R rotates the selected editable target 90° clockwise. Deliberately
      // narrow: never while typing / in a contenteditable, never inside an
      // open dialog, never with a modifier (Ctrl+R is browser reload), never
      // mid-drag, and only with the move tool active — every other tool is a
      // drawing mode with its own in-flight geometry. Multi-block marquee
      // selections that are not exactly one island are out of scope, which
      // falls out of selNudgeTarget already resolving those to null.
      if ((e.key === 'r' || e.key === 'R') && !typing && !drag && tool === 'move' &&
          !e.ctrlKey && !e.metaKey && !e.altKey && !inOpenDialog(t) && (selNudgeTarget || sel)) {
        e.preventDefault();
        // Equipment scope: rotate that one item. Block/island scopes rotate
        // the whole block or the whole island. Each path is the SAME
        // transactional store action the panel buttons use, so validation,
        // override, history and persistence are shared.
        if (!selNudgeTarget && sel) {
          const ok = rotateEquipment(sel.eqId);
          if (!ok) {
            const why = useDesignStore.getState().lastRejection;
            toast.error(`Rotation rejected — ${why ?? 'validation failed'}. Orientation kept.`, {
              duration: 6000,
              action: {
                label: 'Override',
                onClick: () => {
                  const forced = rotateEquipment(sel.eqId, true);
                  if (forced) toast.warning('Rotation applied with engineer override — verify clearances in detailed design.');
                  else toast.error('This rule cannot be bypassed.');
                },
              },
            });
          } else toast.success('Rotated 90° — cables and drawings regenerated');
        } else if (selNudgeTarget?.kind === 'block') {
          const n = selNudgeTarget.n;
          const ok = rotateBlock(n);
          if (!ok) {
            const why = useDesignStore.getState().lastRejection;
            toast.error(`PCS block rotation rejected — ${why ?? 'validation failed'}. Orientation kept.`, {
              duration: 6000,
              action: {
                label: 'Override',
                onClick: () => {
                  const forced = rotateBlock(n, true);
                  if (forced) toast.warning('PCS block rotated with engineer override — verify clearances in detailed design.');
                  else toast.error('This rule cannot be bypassed.');
                },
              },
            });
          } else toast.success(`PCS block ${n} rotated 90° — cables and drawings regenerated`);
        } else if (selNudgeTarget?.kind === 'island') {
          const info = selNudgeTarget.island;
          if (info.placed) {
            // Drag-placed island / single module: rotate the placement spec.
            const ax = info.cx ?? (info.minX + info.maxX) / 2;
            const ay = info.cy ?? info.y;
            const spec = (layoutEdits.placedIslands ?? [])
              .map(p => ({ p, d: Math.hypot(p.x - ax, p.y - ay) }))
              .sort((a, b) => a.d - b.d)[0]?.p;
            if (spec) {
              const why = rotatePlacedIsland(spec.id);
              if (why !== null) toast.error(`Rotation rejected — ${why}. Orientation kept.`, { duration: 8000 });
              else {
                const warn = useDesignStore.getState().lastPlacedWarning;
                if (warn) toast.warning(`Rotated 90° with warning: ${warn}`, { duration: 8000 });
                else toast.success('Rotated 90° — roads, feeders and trenching regenerated');
              }
            }
          } else {
            // Automatic island: rotate each of its blocks in place. An
            // automatic island is not a placement spec, so there is nothing
            // to re-anchor — the blocks turn where they stand.
            const blockNs = info.inverterIds
              .map(id => Number((id.match(/^inv-(\d+)/) ?? [])[1]))
              .filter(Number.isInteger);
            // One transaction: every member turns together or none does, so
            // a late rejection can never leave the island half rotated.
            const ok = blockNs.length ? rotateBlocksGroup(blockNs) : false;
            if (blockNs.length && !ok) {
              toast.error(
                `Island rotation rejected — ${useDesignStore.getState().lastRejection ?? 'validation failed'}. ` +
                `Orientation kept.`,
                { duration: 8000 });
            } else if (blockNs.length) {
              toast.success(`Island ${info.n} rotated 90° — cables and drawings regenerated`);
            }
          }
        }
        return;
      }
      if (e.key === 'Escape') {
        // Abandoning a placement touches nothing but the session itself: no
        // design change, no layout edit, no history entry.
        cancelPlacement();
        setSel(null); setDrag(null); onDraggingChange(false);
        setGroupSel([]); setMultiSel([]); setRoadPts([]); setRoadCursor(null);
        setRoadSel([]); setSpanPt(null); setSpanCursor(null);
        setFdDraw(null); setFdPts([]); setFdCursor(null);
        setAuxFdDraw(false); setAuxFdPts([]); setAuxFdCursor(null);
        if (tool !== 'move') onToolChange('move');
      } else if (e.key === 'Enter' && tool === 'road' && roadPts.length >= 2) {
        const ok = addCustomRoad(roadPts, roadDrawWidth !== 24 ? roadDrawWidth : undefined);
        if (ok) toast.success(`${roadDrawWidth} ft access road added — road network, surfacing and DXF updated`);
        else toast.error(useDesignStore.getState().lastRejection ?? 'Road could not be added.');
        setRoadPts([]); setRoadCursor(null);
        onToolChange('move');
      } else if (e.key === 'Enter' && fdDraw && fdPts.length >= 1) {
        commitFeederRoute();
      } else if (e.key === 'Enter' && auxFdDraw && auxFdPts.length >= 1) {
        commitAuxFeederRoute();
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && !typing && !drag && roadSel.length) {
        // Roads are part of the generic selection system: Delete acts on the
        // selected road(s) exactly as it does on a block or an island.
        deleteSelectedRoads();
      } else if (e.key.toLowerCase() === 's' && tool === 'road-remove' && !drag && roadSel.length === 1 && !spanPt) {
        // Start a point-to-point deletion at the selected point, so a partial
        // deletion needs no separate tool — same selection, narrower scope.
        setSpanPt(roadSel[0].pt);
        setSpanCursor(roadSel[0].pt);
        setRoadSel([]);
        toast.info('Click the far end of the stretch to delete — the cut follows the road between your two clicks. Esc cancels.');
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && !typing && !drag && hover && /^azone(?:-h)?-azone-\d+/.test(hover)) {
        // Delete the hovered area zone (body, band, or corner handle). The
        // guard tests the hover STRING — a bare `hover` here would swallow the
        // key for anything hovered (after clicking a container the pointer is
        // still hovering it), making the selection undeletable by mouse.
        const m = hover.match(/^azone(?:-h)?-(azone-\d+)/);
        if (m) {
          const z = azones.find(a => a.id === m[1]);
          if (z) {
            const err = setAreaZones(azones.filter(a => a.id !== z.id));
            if (err) toast.error(err, { duration: 8000 });
            else toast.success(`${AREA_ZONE_LABELS[z.kind]} removed — drawings and exports updated`);
            setHover(null);
          }
        }
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && !typing && !drag && !placement) {
        // Delete the SELECTION, at exactly the scope the arrow keys move and
        // the outline shows: a marquee group, a whole island, one block, or a
        // single item. Deleting is a normal layout edit (undoable, persisted),
        // so the drafter can always press Ctrl+Z or Restore deleted.
        if (groupSel.length || multiSel.length) {
          // The marquee group and the Shift-click multi-selection delete
          // TOGETHER through one store transaction: one regeneration, one
          // undo step, so a single Ctrl+Z restores everything.
          const { deleted, notes } = deleteEquipmentBatch({
            blocks: [...groupSel, ...multiSel.filter(m => m.kind === 'block').map(m => (m as { n: number }).n)],
            equipment: multiSel.filter(m => m.kind === 'equip').map(m => (m as { id: string }).id),
            placedIslandIds: multiSel.filter(m => m.kind === 'pisland').map(m => (m as { id: string }).id),
          });
          if (deleted) toast.success(`${deleted} item${deleted === 1 ? '' : 's'} deleted in one step — layout, feeders, trenching and exports updated. Ctrl+Z restores them all.`);
          if (notes.length) toast.warning(notes[0], { duration: 8000 });
          setMultiSel([]); setGroupSel([]); setSel(null);
        } else if (selNudgeTarget?.kind === 'island') {
          const isl = selNudgeTarget.island;
          if (isl.placed) {
            // A hand-placed island owns a dedicated remove action: its whole
            // constraint goes away rather than per-block deletions. Match the
            // spec by the anchor the engine stamped onto the island.
            const spec = (layoutEdits.placedIslands ?? []).find(p =>
              Math.abs(p.x - (isl.cx ?? NaN)) < 0.51 && Math.abs(p.y - (isl.cy ?? NaN)) < 0.51);
            if (spec) {
              removePlacedIsland(spec.id);
              toast.success('Hand-placed island deleted — site regenerated');
              setSel(null);
            } else {
              toast.error('Could not identify that hand-placed island — use the ✕ handle above it.');
            }
          } else {
            const ns = isl.inverterIds
              .map(id => Number((id.match(/^inv-(\d+)/) ?? [])[1]))
              .filter(Number.isInteger);
            // One transaction: the whole island regenerates the site once and
            // costs exactly one Ctrl+Z, not one per member block.
            const { deleted, note } = deleteAutoIsland(ns);
            if (deleted) toast.success(`Island ${isl.n} deleted (${deleted} block${deleted === 1 ? '' : 's'}) — layout, feeders, trenching and exports updated`);
            else if (!note) toast.info(`Island ${isl.n} is already deleted.`);
            if (note) toast.warning(note, { duration: 8000 });
            setSel(null);
          }
        } else if (selNudgeTarget?.kind === 'block') {
          const note = deleteBlock(selNudgeTarget.n);
          if (note) toast.warning(note, { duration: 8000 });
          else toast.success(`Block ${selNudgeTarget.n} deleted — layout, feeders, trenching and exports updated`);
          setSel(null);
        } else if (sel) {
          const note = deleteEquipment(sel.eqId);
          if (note) toast.warning(note, { duration: 8000 });
          else toast.success(`${sel.eqId} deleted — layout, trenching and exports updated`);
          setSel(null);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // groupSel / roadSel / spanPt and the delete actions MUST be listed. The
    // handler closes over them, and while they were missing the listener kept
    // running an old closure: after a marquee or road pick, Delete still saw
    // the EMPTY selection captured at mount and silently did nothing.
  }, [onDraggingChange, tool, onToolChange, roadPts, addCustomRoad, roadDrawWidth, fdDraw, fdPts, auxFdDraw, auxFdPts, drag, hover,
      azones, setAreaZones, selNudgeTarget, sel, groupSel, multiSel, roadSel, spanPt, layoutEdits, moveBlock, moveBlocksGroup, movePlacedIsland,
      deleteBlock, deleteEquipment, deleteAutoIsland, deleteEquipmentBatch, removePlacedIsland,
      rotateEquipment, rotateBlock, rotateBlocksGroup, rotatePlacedIsland, islandPairs,
      deleteBlock, deleteEquipment, deleteAutoIsland, removePlacedIsland,
      placement, rotatePlacement, nudgePlacement, cancelPlacement, commitPlacement]);

  // Placement previews must not be rendered as low-detail boxes: hold the
  // realistic-model near lease for as long as a session is live, and release
  // it on cancel/commit/unmount so the viewport LOD returns to normal.
  useEffect(() => {
    if (!placement) return;
    acquireForceRealisticNear();
    return () => releaseForceRealisticNear();
  }, [!!placement, acquireForceRealisticNear, releaseForceRealisticNear]);

  // Leaving the island tool ends any live placement — a stale ghost must
  // never survive a tool switch (and it still mutates nothing).
  useEffect(() => {
    if (tool !== 'island') {
      const live = useDesignStore.getState().placement;
      if (live && live.mode === 'new') cancelPlacement();
    }
  }, [tool, cancelPlacement]);
  // Unmounting mid-placement (edit mode closed, design cleared) cancels too.
  useEffect(() => () => { useDesignStore.getState().cancelPlacement(); }, []);

  // Leaving a tool clears its transient state
  useEffect(() => {
    if (tool !== 'road') { setRoadPts([]); setRoadCursor(null); }
  }, [tool]);

  // Restore the cursor if the edit layer unmounts while an aisle is hovered
  useEffect(() => () => { document.body.style.cursor = ''; }, []);
  const trench = design.trench;
  // Interior drive aisles, y-sorted so position i+1 matches the engine's
  // stable 1-based aisle index (aisle k runs between block rows k and k+1).
  // Guarded on the expected count so a future road shape can't mis-map.
  const aisleHandles = useMemo(() => {
    // Vertical corridor roads (rotation 90°) between island groups are part
    // of design.aisles but are not draggable row aisles — filter them out so
    // handle index i+1 still matches the engine's stable aisle index.
    const sorted = design.aisles
      .filter(a => Math.abs(Math.sin(a.rotation)) < 0.5)
      .sort((a, b) => a.y - b.y);
    if (sorted.length === 0 || sorted.length !== rows.length - 1) return [];
    return sorted.map((a, i) => ({ a, index: i + 1 }));
  }, [design.aisles, rows]);
  const laydown = design.reservedZones.find(z => z.kind === 'laydown') ?? null;
  // Draggable/pinnable future units: auto/%-placed blocks (future-blk-N) and
  // per-island units (island-aug-N-K). Island units default to their island's
  // strip end but can be dragged anywhere that passes clearance checks.
  const futureBlocks = design.reservedZones.filter(z => z.kind === 'futureAug' && /^(future-blk-\d+|island-aug-\d+-\d+)$/.test(z.id));

  // MV feeder corridor drag handle: geometry of the parallel-lane bundle
  // outside the fence. Present only when a substation is placed and feeders
  // exist. The current centerline honors an existing pin.
  const corridor = useMemo(() => {
    if (!substation || feeders.length === 0) return null;
    const info = feederCorridorInfo(design, substation, maxPcsPerFeeder);
    if (!info) return null;
    // Re-validate a persisted pin (a stale pin from an old project file may no
    // longer be valid) so the handle always sits on the actually routed lanes.
    const pin = layoutEdits.feederCorridor;
    const center =
      pin != null && feederCorridorRejectReason(design, substation, pin, maxPcsPerFeeder) === null
        ? pin
        : info.autoCenter;
    const halfBand = info.halfBand + 6; // small visual margin around the lanes
    const rect = info.horiz
      ? { minX: info.spanLo, maxX: info.spanHi, minY: center - halfBand, maxY: center + halfBand }
      : { minX: center - halfBand, maxX: center + halfBand, minY: info.spanLo, maxY: info.spanHi };
    return { info, center, halfBand, rect };
  }, [design, substation, feeders.length, layoutEdits.feederCorridor, maxPcsPerFeeder]);

  const setDragging = (d: DragState | null) => {
    setDrag(d);
    onDraggingChange(d !== null);
  };

  // Ghost validity while dragging
  const ghost = useMemo(() => {
    if (!drag || !geom) return null;
    if (drag.kind === 'row') {
      const row = rows.find(r => r.index === drag.index);
      if (!row) return null;
      const others = rows.filter(r => r.index !== drag.index).flatMap(r => r.blocks);
      const reason = validateRowShift(
        row.blocks, others, geom, design.fence, design.boundary.polygon, drag.dx, drag.dy,
        design.aisles
      );
      const bb = rowBBox(row, geom.halfW, geom.halfD);
      return {
        rect: { minX: bb.minX + drag.dx, maxX: bb.maxX + drag.dx, minY: bb.minY + drag.dy, maxY: bb.maxY + drag.dy },
        valid: reason === null,
      };
    }
    if (drag.kind === 'aisle') {
      const handle = aisleHandles.find(h => h.index === drag.index);
      if (!handle) return null;
      // Same checks the engine applies: rows north of the aisle shift with it
      // (dy from current), the composed total decides the south road-edge
      // clearance, and pinned reserved rectangles stay off-limits.
      const movingBlocks = rows.filter(r => r.index > drag.index).flatMap(r => r.blocks);
      const otherBlocks = rows.filter(r => r.index <= drag.index).flatMap(r => r.blocks);
      const pinnedReserved = design.reservedZones.filter(z =>
        (z.kind === 'futureAug' && (layoutEdits.augPins ?? {})[z.id] != null) ||
        (z.kind === 'laydown' && layoutEdits.laydownPin != null && layoutEdits.laydownSize != null)
      );
      const newTotal = (layoutEdits.aisleMoves?.[drag.index] ?? 0) + drag.dy;
      const reason = validateAisleShift(
        movingBlocks, otherBlocks, geom, design.fence, design.boundary.polygon,
        drag.dy, newTotal, pinnedReserved
      );
      const a = handle.a;
      return {
        rect: {
          minX: a.x - a.length / 2, maxX: a.x + a.length / 2,
          minY: a.y - a.width / 2 + drag.dy, maxY: a.y + a.width / 2 + drag.dy,
        },
        valid: reason === null,
      };
    }
    if (drag.kind === 'block') {
      const blk = blockCenterOf(drag.n);
      if (!blk) return null;
      const others = rows.flatMap(r => r.blocks).filter(b => b.n !== drag.n);
      // Same pinned-reserved rectangles the engine checks: pinned future
      // blocks and an explicitly sized+pinned laydown stay fixed, so a block
      // may not land on them (auto zones re-place around moved equipment).
      const pinnedReserved = design.reservedZones.filter(z =>
        (z.kind === 'futureAug' && (layoutEdits.augPins ?? {})[z.id] != null) ||
        (z.kind === 'laydown' && layoutEdits.laydownPin != null && layoutEdits.laydownSize != null)
      );
      const reason = validateRowShift(
        [blk], others, geom, design.fence, design.boundary.polygon, drag.dx, drag.dy,
        design.aisles, pinnedReserved
      );
      return {
        rect: {
          minX: blk.x - geom.halfW + drag.dx, maxX: blk.x + geom.halfW + drag.dx,
          minY: blk.y - geom.halfD + drag.dy, maxY: blk.y + geom.halfD + drag.dy,
        },
        valid: reason === null,
      };
    }
    if (drag.kind === 'group') {
      const units = drag.ns.map(n => blockCenterOf(n)).filter((b): b is NonNullable<typeof b> => b !== null);
      if (!units.length) return null;
      const others = rows.flatMap(r => r.blocks).filter(b => !drag.ns.includes(b.n));
      const pinnedReserved = design.reservedZones.filter(z =>
        (z.kind === 'futureAug' && (layoutEdits.augPins ?? {})[z.id] != null) ||
        (z.kind === 'laydown' && layoutEdits.laydownPin != null && layoutEdits.laydownSize != null)
      );
      const reason = validateRowShift(
        units, others, geom, design.fence, design.boundary.polygon, drag.dx, drag.dy,
        design.aisles, pinnedReserved
      );
      const minX = Math.min(...units.map(b => b.x)) - geom.halfW;
      const maxX = Math.max(...units.map(b => b.x)) + geom.halfW;
      const minY = Math.min(...units.map(b => b.y)) - geom.halfD;
      const maxY = Math.max(...units.map(b => b.y)) + geom.halfD;
      return {
        rect: { minX: minX + drag.dx, maxX: maxX + drag.dx, minY: minY + drag.dy, maxY: maxY + drag.dy },
        valid: reason === null,
      };
    }
    if (drag.kind === 'marquee') return null;
    if (drag.kind === 'equip') {
      const eq = design.equipment.find(e => e.id === drag.id);
      if (!eq) return null;
      const others = design.equipment.filter(e => e.id !== drag.id);
      const reason = validateEquipmentShift(
        eq, others, design.augmentationZones, design.reservedZones, design.fence, design.boundary.polygon,
        geom.nfpa !== null, drag.dx, drag.dy, design.aisles, geom.equipmentMargin
      );
      const rot = Math.abs(Math.sin(eq.rotation)) > 0.5;
      const hx = (rot ? eq.width : eq.length) / 2;
      const hy = (rot ? eq.length : eq.width) / 2;
      return {
        rect: {
          minX: eq.x - hx + drag.dx, maxX: eq.x + hx + drag.dx,
          minY: eq.y - hy + drag.dy, maxY: eq.y + hy + drag.dy,
        },
        valid: reason === null,
      };
    }
    if (drag.kind === 'laydown-resize') {
      if (!laydown) return null;
      const r = resizeLaydownRect(laydown, drag.sx, drag.sy, drag.dx, drag.dy);
      const otherReserved = design.reservedZones.filter(z => z.kind !== 'laydown');
      const reason = laydownFitReason(
        r.x, r.y, r.length / 2, r.width / 2,
        design.fence, geom.equipmentMargin,
        design.equipment, design.augmentationZones, otherReserved, design.aisles
      );
      return {
        rect: {
          minX: r.x - r.length / 2, maxX: r.x + r.length / 2,
          minY: r.y - r.width / 2, maxY: r.y + r.width / 2,
        },
        valid: reason === null,
      };
    }
    if (drag.kind === 'laydown') {
      if (!laydown) return null;
      const nx = laydown.x + drag.dx;
      const ny = laydown.y + drag.dy;
      const otherReserved = design.reservedZones.filter(z => z.kind !== 'laydown');
      const reason = laydownFitReason(
        nx, ny, laydown.length / 2, laydown.width / 2,
        design.fence, geom.equipmentMargin,
        design.equipment, design.augmentationZones, otherReserved, design.aisles
      );
      return {
        rect: {
          minX: nx - laydown.length / 2, maxX: nx + laydown.length / 2,
          minY: ny - laydown.width / 2, maxY: ny + laydown.width / 2,
        },
        valid: reason === null,
      };
    }
    if (drag.kind === 'futureAug') {
      const zone = futureBlocks.find(z => z.id === drag.id);
      if (!zone) return null;
      // Snap onto the engine's standard block lattice when close, so future
      // blocks line up with the installed grid ("same grid, just this column").
      // Island units live on their island strip, not the block lattice — they
      // get plain 1-ft grid snapping instead.
      const isIsland = drag.id.startsWith('island-aug-');
      const snap = isIsland
        ? { x: snapToGrid(zone.x + drag.dx, 1), y: snapToGrid(zone.y + drag.dy, 1), snappedX: false, snappedY: false }
        : snapToAugLattice(zone.x + drag.dx, zone.y + drag.dy, geom.augGrid);
      const nx = snap.x;
      const ny = snap.y;
      const otherReserved = design.reservedZones.filter(z => z.id !== drag.id);
      const reason = futureAugFitReason(
        nx, ny, geom, design.fence, design.boundary.polygon,
        design.equipment, design.augmentationZones, otherReserved, design.aisles
      );
      return {
        rect: {
          minX: nx - zone.length / 2, maxX: nx + zone.length / 2,
          minY: ny - zone.width / 2, maxY: ny + zone.width / 2,
        },
        valid: reason === null,
      };
    }
    if (drag.kind === 'gate') {
      if (!design.gate) return null;
      const snap = snapGateToFence(design.fence, { x: design.gate.x + drag.dx, y: design.gate.y + drag.dy });
      if (!snap) return null;
      const hw = design.gate.width / 2;
      return {
        rect: { minX: snap.x - hw, maxX: snap.x + hw, minY: snap.y - 4, maxY: snap.y + 4 },
        valid: snap.valid,
      };
    }
    if (drag.kind === 'feederCorridor') {
      if (!corridor || !substation) return null;
      const nc = corridor.center + drag.d;
      const valid = feederCorridorRejectReason(design, substation, nc, maxPcsPerFeeder) === null;
      const { info, halfBand } = corridor;
      const rect = info.horiz
        ? { minX: info.spanLo, maxX: info.spanHi, minY: nc - halfBand, maxY: nc + halfBand }
        : { minX: nc - halfBand, maxX: nc + halfBand, minY: info.spanLo, maxY: info.spanHi };
      return { rect, valid };
    }
    if (drag.kind === 'azone' || drag.kind === 'azone-resize') {
      const z = azones.find(a => a.id === drag.id);
      if (!z) return null;
      const cand = drag.kind === 'azone'
        ? { ...z, x: z.x + drag.dx, y: z.y + drag.dy }
        : { ...z, ...resizeAreaZoneRect(z, drag.sx, drag.sy, drag.dx, drag.dy) };
      const candSet = azones.map(a => (a.id === z.id ? cand : a));
      const reason = areaZonesRejectReason(candSet, design.boundary.polygon);
      return {
        rect: {
          minX: cand.x - cand.lengthFt / 2, maxX: cand.x + cand.lengthFt / 2,
          minY: cand.y - cand.widthFt / 2, maxY: cand.y + cand.widthFt / 2,
        },
        valid: reason === null,
      };
    }
    if (drag.kind === 'gzone' || drag.kind === 'gzone-resize') {
      const z = gzones.find(g => g.id === drag.id);
      if (!z) return null;
      const cand = drag.kind === 'gzone'
        ? { ...z, x: z.x + drag.dx, y: z.y + drag.dy }
        : { ...z, ...resizeGradingZoneRect(z, drag.sx, drag.sy, drag.dx, drag.dy) };
      const candSet = gzones.map(g => (g.id === z.id ? cand : g));
      const reason = gradingZonesRejectReason(candSet, design.fence);
      // Live pad-elevation readout: auto zones re-solve their offset for the
      // candidate rectangle, offset zones show their fixed offset. Approximate
      // (the drop re-balances globally), hence the "≈".
      let label: string | null = null;
      if (fgSurface && terrainYard) {
        const rect = terrainLocalRect(terrainYard, design.boundary.origin);
        const info = previewZonePadInfo(fgSurface, terrainYard, rect, cand);
        const off = `${info.offsetFt >= 0 ? '+' : ''}${info.offsetFt.toFixed(1)}`;
        label = cand.mode === 'auto'
          ? (info.solved
              ? `PAD ≈ ${info.padElevFt.toFixed(1)} FT (auto ${off} FT)`
              : 'PAD — no terrain samples here')
          : `PAD ≈ ${info.padElevFt.toFixed(1)} FT (offset ${off} FT)`;
      }
      return {
        rect: {
          minX: cand.x - cand.lengthFt / 2, maxX: cand.x + cand.lengthFt / 2,
          minY: cand.y - cand.widthFt / 2, maxY: cand.y + cand.widthFt / 2,
        },
        valid: reason === null,
        label,
      };
    }
    if (drag.kind !== 'trench') return null; // island-place draws its own ghost
    if (!trench) return null;
    const nx = trench.x + drag.dx;
    const midY = (trench.yBottom + trench.yTop) / 2;
    const valid = rectInsidePolygon(nx, midY, trench.width / 2, (trench.yTop - trench.yBottom) / 2, design.fence, 0);
    return {
      rect: { minX: nx - trench.width / 2, maxX: nx + trench.width / 2, minY: trench.yBottom, maxY: trench.yTop },
      valid,
    };
  }, [drag, geom, rows, trench, laydown, futureBlocks, design, layoutEdits, corridor, substation, gzones, azones, fgSurface, terrainYard]);

  // Nearby standard-grid lattice targets while dragging a future block:
  // valid positions within ~1.5 steps of the cursor highlight so the drafter
  // can see where the ghost will snap.
  const snapTargets = useMemo(() => {
    if (!drag || drag.kind !== 'futureAug' || !geom?.augGrid) return [];
    // Island units don't snap to the block lattice — no lattice targets.
    if (drag.id.startsWith('island-aug-')) return [];
    const zone = futureBlocks.find(z => z.id === drag.id);
    if (!zone) return [];
    const g = geom.augGrid;
    const cx = zone.x + drag.dx;
    const cy = zone.y + drag.dy;
    const otherReserved = design.reservedZones.filter(z => z.id !== drag.id);
    const ki = Math.round((cx - g.originX) / g.stepX);
    const kj = Math.round((cy - g.originY) / g.stepY);
    const targets: { x: number; y: number; near: boolean }[] = [];
    for (let j = kj - 1; j <= kj + 1; j++) {
      for (let i = ki - 1; i <= ki + 1; i++) {
        const x = g.originX + i * g.stepX;
        const y = g.originY + j * g.stepY;
        if (Math.abs(x - cx) > g.stepX * 1.5 || Math.abs(y - cy) > g.stepY * 1.5) continue;
        if (futureAugFitReason(
          x, y, geom, design.fence, design.boundary.polygon,
          design.equipment, design.augmentationZones, otherReserved, design.aisles
        ) !== null) continue;
        targets.push({ x, y, near: i === ki && j === kj });
      }
    }
    return targets;
  }, [drag, geom, futureBlocks, design]);

  // Composed preview geometry for the live placement session. Both the
  // orientation-correct outlines and the model-backed ghost come from THIS
  // composition — the same function the commit composes with — so what the
  // drafter sees is exactly what gets built.
  const previewComposition = useMemo(() => {
    if (!placement) return null;
    const normPreviewAngle = ((placement.angleDeg % 360) + 360) % 360;
    // Single manual item: one footprint, one ghost model, same composition
    // the commit runs.
    if (placement.kind === 'equipment') {
      if (!placement.equipType) return null;
      const eqSpec = {
        id: placement.id ?? 'placement-preview',
        type: placement.equipType,
        x: placement.center.x, y: placement.center.y,
        ...(normPreviewAngle !== 0 ? { angleDeg: normPreviewAngle } : {}),
      };
      return {
        footprints: placedEquipmentFootprints(eqSpec),
        equipment: [composePlacedEquipment(eqSpec)]
          .map(e => ({ ...e, id: `plcghost-${e.id}` })),
      };
    }
    const single = placement.kind === 'single' || placement.kind === 'single2';
    const spec: PlacedIslandSpec = {
      id: placement.id ?? 'placement-preview',
      x: placement.center.x, y: placement.center.y,
      ...(normPreviewAngle !== 0 ? { angleDeg: normPreviewAngle } : {}),
      ...(!single && placement.pairs !== undefined && placement.pairs !== ISLAND_PCS_PER_SIDE
        ? { pairs: placement.pairs } : {}),
      ...(single ? { kind: placement.kind } : {}),
      aug: placement.aug,
      // Bare islands compose without the mid-island aux cluster — the ghost
      // must show (and size) exactly what the commit builds.
      ...(placement.auxGear ? {} : { auxGear: false as const }),
    };
    const cfg = getEffectiveConfiguration(configId, containersPerPcs);
    const pcsClr = hotClimate ? CLEARANCES.pcsHotClimate : CLEARANCES.pcsStandard;
    return {
      footprints: placedIslandFootprints(spec, cfg, pcsClr),
      // Ghost ids are namespaced so a preview can never collide with a
      // committed equipment id in a React key or an instanced-model map.
      equipment: composePlacedIsland(spec, cfg, pcsClr, 1, 1).equipment
        .map(e => ({ ...e, id: `plcghost-${e.id}` })),
    };
  }, [placement, configId, containersPerPcs, hotClimate]);
  const previewFootprints = previewComposition?.footprints ?? [];
  const previewEquipment = previewComposition?.equipment ?? [];

  if (!geom) return null;

  const planePt = (e: any) => ({ x: e.point.x, y: -e.point.z });

  // Fence bounding box for the click-away catcher plane
  const fbXs = design.fence.map(p => p.x);
  const fbYs = design.fence.map(p => p.y);
  const fb = {
    minX: Math.min(...fbXs), maxX: Math.max(...fbXs),
    minY: Math.min(...fbYs), maxY: Math.max(...fbYs),
  };

  // Zero-delta drop on an equipment pick plane = a click: widen the selection
  // scope (equipment -> block -> island -> row -> equipment). Aux gear and panels have
  // no block/row, so they stay at equipment scope.
  const cycleScope = (eqId: string) => {
    const n = blockOfEq(eqId);
    const prev = sel?.eqId === eqId ? sel.scope : null;
    // Drag-placed islands are self-contained units outside the auto row/aisle
    // machinery, so their blocks are absent from blockRows. They still need an
    // island scope, otherwise the selection would be stuck at equipment scope
    // and the arrow keys would have nothing to nudge. Block and row scopes stay
    // out of the cycle for them: both are driven by row geometry that a placed
    // island does not have.
    if (n !== null && placedIslandOfBlock(n)) {
      const pOrder: ('equip' | 'island')[] = ['equip', 'island'];
      const pNext = prev === null || prev === 'row' || prev === 'block'
        ? 'equip'
        : pOrder[(pOrder.indexOf(prev as 'equip' | 'island') + 1) % pOrder.length];
      setSel({ eqId, scope: pNext });
      return;
    }
    if (n === null || rowOfBlock(n) === null) { setSel({ eqId, scope: 'equip' }); return; }
    const order: ('equip' | 'block' | 'island' | 'row')[] = ['equip', 'block', 'island', 'row'];
    const next = prev === null ? 'equip' : order[(order.indexOf(prev) + 1) % order.length];
    setSel({ eqId, scope: next });
  };

  // Rejected-move toast: shows the engine's SPECIFIC reason (from the
  // store's lastRejection) and offers an engineer override that re-applies
  // the same move with force=true (the engine keeps it with a warning).
  const rejectToast = (what: string, retryForced: () => boolean) => {
    const why = useDesignStore.getState().lastRejection;
    toast.error(`${what} rejected — ${why ?? 'validation failed'}. Snapped back.`, {
      duration: 8000,
      action: {
        label: 'Override',
        onClick: () => {
          const ok = retryForced();
          if (ok) toast.warning(`${what} applied with engineer override — verify clearances in detailed design.`);
          else toast.error(`${what} could not be overridden — this rule cannot be bypassed.`);
        },
      },
    });
  };

  // Commit the live placement session (new drop or move of an existing
  // placement). The store commits exactly the candidate the ghost evaluated.
  const commitPlacementSession = () => {
    const live = useDesignStore.getState().placement;
    if (!live) return;
    const isMove = live.mode === 'move';
    const why = commitPlacement();
    if (why !== null) {
      // Session stays open so the drafter can nudge/rotate and retry.
      const rejectedWhat = isMove
        ? (live.kind === 'equipment' ? 'Equipment move' : 'Island move')
        : live.kind === 'equipment'
          ? `${live.equipType ? MANUAL_EQUIPMENT_CATALOG[live.equipType].short : 'Equipment'} placement`
          : live.kind === 'single' || live.kind === 'single2'
            ? 'Single PCS module placement'
            : 'Island placement';
      toast.error(
        `${rejectedWhat} rejected — ${why}.`,
        { duration: 10000 });
      return;
    }
    const warn = useDesignStore.getState().lastPlacedWarning;
    if (isMove) {
      if (warn) toast.warning(`Placed with warning: ${warn}`, { duration: 8000 });
      else toast.success('Island moved — roads, feeders and trenching regenerated');
      return;
    }
    const augTxt = live.aug ? 'with augmentation' : 'no augmentation';
    const nPairs = live.pairs ?? ISLAND_PCS_PER_SIDE;
    const what = live.kind === 'equipment'
      ? MANUAL_EQUIPMENT_CATALOG[live.equipType!].short
      : live.kind === 'single' || live.kind === 'single2'
      ? `single PCS module (1 PCS + ${live.kind === 'single2' ? 2 : 3} BESS, ${augTxt})`
      : `${nPairs === ISLAND_PCS_PER_SIDE ? '' : 'partial '}island (${nPairs * 2} PCS blocks, ${augTxt})`;
    if (warn) toast.warning(`Placed with warning: ${warn}`, { duration: 8000 });
    else {
      const liveAngleDeg = live.angleDeg;
      const liveOrientLabel = liveAngleDeg === 0 ? 'horizontal' : liveAngleDeg === 90 ? 'vertical' : `${liveAngleDeg}°`;
      toast.success(`Placed a ${liveOrientLabel} ${what} — roads, feeders and trenching regenerated`);
    }
    onToolChange('move');
  };

  // Pointer coalescing is a rendering optimization, never the source of truth
  // for what gets built. A release can arrive between the last pointermove and
  // the frame that would have applied it, so every commit path applies the
  // newest sampled point FIRST — otherwise a quick drag or a click commits the
  // previous frame's candidate instead of the position under the cursor.
  const flushPlacementPointer = (pt?: { x: number; y: number }) => {
    if (placeMoveRaf.current) { cancelAnimationFrame(placeMoveRaf.current); placeMoveRaf.current = 0; }
    if (dragMoveRaf.current) { cancelAnimationFrame(dragMoveRaf.current); dragMoveRaf.current = 0; }
    const live = useDesignStore.getState().placement;
    if (!live) return;
    // A move drags by delta from the grab point; a new drop tracks the pointer.
    if (drag?.kind === 'pisland') {
      const p = pt ?? dragMovePt.current;
      if (p) updatePlacementPointer({
        x: drag.cx + (p.x - drag.start.x),
        y: drag.cy + (p.y - drag.start.y),
      });
    } else {
      const p = pt ?? dragMovePt.current ?? placeMovePt.current;
      if (p) updatePlacementPointer(p);
    }
  };

  const commitDrop = () => {
    if (!drag) return;
    if (drag.kind === 'pisland' || drag.kind === 'pequip' || drag.kind === 'island-place') flushPlacementPointer();
    if (drag.kind === 'row') {
      if (drag.dx !== 0 || drag.dy !== 0) {
        const total = composeRowMove(layoutEdits.rowMoves?.[drag.index], drag.dx, drag.dy);
        const ok = moveRow(drag.index, total.dx, total.dy);
        if (ok) toast.success(`Row ${drag.index} moved — site re-optimized around it`);
        else rejectToast(`Row ${drag.index} move`, () => moveRow(drag.index, total.dx, total.dy, true));
      } else if (drag.srcEqId) {
        cycleScope(drag.srcEqId);
      }
    } else if (drag.kind === 'ringEdge') {
      if (drag.d !== 0) {
        // Inward = toward the yard interior for that side; compose with the
        // existing total offset so repeated drags accumulate.
        const inward = drag.side === 'n' ? -drag.d : drag.side === 's' ? drag.d : drag.side === 'e' ? -drag.d : drag.d;
        const total = (layoutEdits.ringOffsets?.[drag.side] ?? 0) + inward;
        const why = moveRingEdge(drag.side, total);
        if (why === null) toast.success('Perimeter road edge moved — ring, surfacing and cables regenerated');
        else toast.error(`Ring edge move rejected — ${why}. Snapped back.`, { duration: 8000 });
      }
    } else if (drag.kind === 'aisle') {
      if (drag.dy !== 0) {
        const total = (layoutEdits.aisleMoves?.[drag.index] ?? 0) + drag.dy;
        const ok = moveAisle(drag.index, total);
        if (ok) toast.success(`Drive aisle ${drag.index} moved — rows shifted with it; roads, surfacing and cables regenerated`);
        else rejectToast(`Drive aisle ${drag.index} move`, () => moveAisle(drag.index, total, true));
      }
    } else if (drag.kind === 'block') {
      if (drag.dx !== 0 || drag.dy !== 0) {
        const total = composeRowMove(layoutEdits.blockMoves?.[drag.n], drag.dx, drag.dy);
        const ok = moveBlock(drag.n, total.dx, total.dy);
        if (ok) toast.success(`Block ${drag.n} moved — cables rerouted, roads unchanged`);
        else rejectToast(`Block ${drag.n} move`, () => moveBlock(drag.n, total.dx, total.dy, true));
      } else if (drag.srcEqId) {
        cycleScope(drag.srcEqId);
      }
    } else if (drag.kind === 'pisland') {
      // The move rides the transient placement session: the ghost the drafter
      // released on IS the candidate that commits (no second snap pass).
      const live = useDesignStore.getState().placement;
      const moved = !!live && live.mode === 'move' &&
        (live.center.x !== (live.origin?.x ?? live.center.x) || live.center.y !== (live.origin?.y ?? live.center.y) ||
         (((live.angleDeg % 360) + 360) % 360) !== (((drag.angleDeg % 360) + 360) % 360));
      if (moved) commitPlacementSession();
      else {
        cancelPlacement();
        if (drag.srcEqId) cycleScope(drag.srcEqId);
      }
    } else if (drag.kind === 'pequip') {
      const live = useDesignStore.getState().placement;
      const moved = !!live && live.mode === 'move' &&
        (live.center.x !== (live.origin?.x ?? live.center.x) ||
         live.center.y !== (live.origin?.y ?? live.center.y) ||
         (((live.angleDeg % 360) + 360) % 360) !== (((drag.angleDeg % 360) + 360) % 360));
      if (moved) commitPlacementSession();
      else {
        cancelPlacement();
        if (drag.srcEqId) cycleScope(drag.srcEqId);
      }
    } else if (drag.kind === 'island-place') {
      // The click that ended here already positioned the session; commit the
      // exact candidate under the ghost.
      commitPlacementSession();
    } else if (drag.kind === 'marquee') {
      const minX = Math.min(drag.start.x, drag.cur.x), maxX = Math.max(drag.start.x, drag.cur.x);
      const minY = Math.min(drag.start.y, drag.cur.y), maxY = Math.max(drag.start.y, drag.cur.y);
      // Armed bulk tag: the box tags drawn reference shapes instead of
      // selecting blocks (manual fallback when the auto scan missed gear).
      const bulkTag = useDesignStore.getState().bulkTag;
      if (bulkTag) {
        const err = useDesignStore.getState().applyBulkTagRegion({ minX, minY, maxX, maxY });
        if (err) toast.error(err);
        else {
          toast.success('Drawn shapes tagged and added to the design');
          useDesignStore.getState().setBulkTag(null);
          onToolChange('move');
        }
        setDragging(null);
        return;
      }
      const ns = rows.flatMap(r => r.blocks)
        .filter(b => b.x >= minX && b.x <= maxX && b.y >= minY && b.y <= maxY)
        .map(b => b.n);
      setGroupSel(ns);
      onToolChange('move');
      if (ns.length) toast.success(`${ns.length} block${ns.length > 1 ? 's' : ''} selected — drag any of them to move the group together, Esc to deselect`);
      else toast.info('No blocks inside the selected area');
    } else if (drag.kind === 'group') {
      if (drag.dx !== 0 || drag.dy !== 0) {
        const moves = drag.ns.map(n => {
          const total = composeRowMove(layoutEdits.blockMoves?.[n], drag.dx, drag.dy);
          return { n, dx: total.dx, dy: total.dy };
        });
        const ok = moveBlocksGroup(moves);
        if (ok) toast.success(`${drag.ns.length} blocks moved together — cables rerouted, access roads updated`);
        else rejectToast('Group move', () => moveBlocksGroup(moves, true));
      }
    } else if (drag.kind === 'equip') {
      if (drag.dx !== 0 || drag.dy !== 0) {
        const total = composeRowMove(layoutEdits.equipMoves?.[drag.id], drag.dx, drag.dy);
        const ok = moveEquipment(drag.id, total.dx, total.dy);
        if (ok) toast.success(`Equipment moved — cables rerouted, roads unchanged`);
        else rejectToast('Equipment move', () => moveEquipment(drag.id, total.dx, total.dy, true));
      } else if (drag.srcEqId) {
        cycleScope(drag.srcEqId);
      }
    } else if (drag.kind === 'laydown') {
      if (laydown && (drag.dx !== 0 || drag.dy !== 0)) {
        const nx = snapToGrid(laydown.x + drag.dx, 1);
        const ny = snapToGrid(laydown.y + drag.dy, 1);
        const ok = setLaydownPin({ x: nx, y: ny });
        if (ok) toast.success('Laydown area pinned — site regenerated around it');
        else toast.error('Laydown spot rejected — clearances to fence, equipment, or roads. Snapped back.');
      }
    } else if (drag.kind === 'laydown-resize') {
      if (laydown && (drag.dx !== 0 || drag.dy !== 0)) {
        const r = resizeLaydownRect(laydown, drag.sx, drag.sy, drag.dx, drag.dy);
        const ok = setLaydownRect(
          { x: snapToGrid(r.x, 1), y: snapToGrid(r.y, 1) },
          { length: Math.round(r.length), width: Math.round(r.width) }
        );
        if (ok) toast.success(`Laydown resized to ${Math.round(r.length)} x ${Math.round(r.width)} ft — site regenerated`);
        else toast.error('Laydown size rejected — clearances to fence, equipment, or roads. Snapped back.');
      }
    } else if (drag.kind === 'futureAug') {
      const zone = futureBlocks.find(z => z.id === drag.id);
      if (zone && (drag.dx !== 0 || drag.dy !== 0)) {
        // Same snap the ghost shows: future blocks snap to the standard block
        // lattice when close; island units use plain 1-ft grid snapping.
        const isIsland = zone.id.startsWith('island-aug-');
        const snap = isIsland
          ? { x: zone.x + drag.dx, y: zone.y + drag.dy, snappedX: false, snappedY: false }
          : snapToAugLattice(zone.x + drag.dx, zone.y + drag.dy, geom.augGrid);
        const nx = snap.snappedX ? snap.x : snapToGrid(snap.x, 1);
        const ny = snap.snappedY ? snap.y : snapToGrid(snap.y, 1);
        const mIsl = zone.id.match(/^island-aug-(\d+)-(\d+)$/);
        const name = mIsl
          ? `Island ${mIsl[1]} augmentation unit ${mIsl[2]}`
          : `Future BESS block ${zone.id.replace('future-blk-', '')}`;
        const ok = setFutureAugPin(zone.id, { x: nx, y: ny });
        if (ok) toast.success(`${name} pinned — site regenerated around it`);
        else toast.error(`${name} spot rejected — clearances or the 100 ft NFPA setback. Snapped back.`);
      }
    } else if (drag.kind === 'gate') {
      if (design.gate && (drag.dx !== 0 || drag.dy !== 0)) {
        const snap = snapGateToFence(design.fence, { x: design.gate.x + drag.dx, y: design.gate.y + drag.dy });
        if (!snap) {
          toast.error('No fence segment can hold the gate opening.');
        } else {
          const ok = setGatePin({ x: Math.round(snap.x * 10) / 10, y: Math.round(snap.y * 10) / 10 });
          if (ok) toast.success('Entrance gate moved — entrance road re-routed');
          else toast.error('Gate spot rejected — too far from the fence or the opening does not fit. Snapped back.');
        }
      }
    } else if (drag.kind === 'zone-place') {
      const w = Math.abs(drag.cur.x - drag.start.x);
      const h = Math.abs(drag.cur.y - drag.start.y);
      if (w < 5 && h < 5) {
        toast.info('Drag a rectangle where the area zone should go.');
      } else {
        // Next free numeric suffix so ids stay unique across deletes.
        const maxIdx = azones.reduce((m, z) => {
          const mm = z.id.match(/^azone-(\d+)$/);
          return mm ? Math.max(m, Number(mm[1])) : m;
        }, 0);
        const cand: AreaZone = {
          id: `azone-${maxIdx + 1}`,
          kind: drag.zkind,
          x: snapToGrid((drag.start.x + drag.cur.x) / 2, 1),
          y: snapToGrid((drag.start.y + drag.cur.y) / 2, 1),
          lengthFt: Math.max(AREA_ZONE_MIN_SIZE_FT, Math.round(w)),
          widthFt: Math.max(AREA_ZONE_MIN_SIZE_FT, Math.round(h)),
        };
        const err = setAreaZones([...azones, cand]);
        if (err) toast.error(err, { duration: 8000 });
        else {
          toast.success(`${AREA_ZONE_LABELS[drag.zkind]} added (${cand.lengthFt} x ${cand.widthFt} ft) — drawings and exports updated`);
          onToolChange('move');
        }
      }
    } else if (drag.kind === 'azone' || drag.kind === 'azone-resize') {
      const z = azones.find(a => a.id === drag.id);
      if (z && (drag.dx !== 0 || drag.dy !== 0)) {
        const cand = drag.kind === 'azone'
          ? { ...z, x: snapToGrid(z.x + drag.dx, 1), y: snapToGrid(z.y + drag.dy, 1) }
          : (() => {
              const r = resizeAreaZoneRect(z, drag.sx, drag.sy, drag.dx, drag.dy);
              return { ...z, x: snapToGrid(r.x, 1), y: snapToGrid(r.y, 1), lengthFt: Math.round(r.lengthFt), widthFt: Math.round(r.widthFt) };
            })();
        const err = setAreaZones(azones.map(a => (a.id === z.id ? cand : a)));
        if (err) toast.error(`${err} Snapped back.`, { duration: 8000 });
        else toast.success(drag.kind === 'azone'
          ? `${AREA_ZONE_LABELS[z.kind]} moved — drawings and exports updated`
          : `${AREA_ZONE_LABELS[z.kind]} resized to ${cand.lengthFt} x ${cand.widthFt} ft — drawings and exports updated`);
      } else if (z && drag.kind === 'azone') {
        // Click without dragging: cycle the zone through the four types.
        const order = AREA_ZONE_KIND_ORDER;
        const next = order[(order.indexOf(z.kind) + 1) % order.length];
        const err = setAreaZones(azones.map(a => (a.id === z.id ? { ...a, kind: next } : a)));
        if (err) toast.error(err, { duration: 8000 });
        else toast.success(`Zone type changed to ${AREA_ZONE_LABELS[next]}`);
      }
    } else if (drag.kind === 'gzone' || drag.kind === 'gzone-resize') {
      const z = gzones.find(g => g.id === drag.id);
      if (z && (drag.dx !== 0 || drag.dy !== 0)) {
        const cand = drag.kind === 'gzone'
          ? { ...z, x: snapToGrid(z.x + drag.dx, 1), y: snapToGrid(z.y + drag.dy, 1) }
          : (() => {
              const r = resizeGradingZoneRect(z, drag.sx, drag.sy, drag.dx, drag.dy);
              return { ...z, x: snapToGrid(r.x, 1), y: snapToGrid(r.y, 1), lengthFt: Math.round(r.lengthFt), widthFt: Math.round(r.widthFt) };
            })();
        const err = setGradingZones(gzones.map(g => (g.id === z.id ? cand : g)));
        if (err) toast.error(`${err} Snapped back.`);
        else toast.success(drag.kind === 'gzone'
          ? `Grading zone "${z.name}" moved — pad surface recomputed`
          : `Grading zone "${z.name}" resized to ${cand.lengthFt} x ${cand.widthFt} ft — pad surface recomputed`);
      }
    } else if (drag.kind === 'feederCorridor') {
      if (corridor && drag.d !== 0) {
        const nc = snapToGrid(corridor.center + drag.d, 1);
        const ok = setFeederCorridorPin(nc);
        if (ok) toast.success(`Feeder corridor pinned at ${nc} ft — all home-run lanes shifted together`);
        else {
          const why = substation ? feederCorridorRejectReason(design, substation, nc, maxPcsPerFeeder) : null;
          toast.error(`Feeder corridor rejected${why ? `: ${why}` : ''} — automatic position kept. Snapped back.`);
        }
      }
    } else if (trench && drag.dx !== 0) {
      const nx = snapToGrid(trench.x + drag.dx, 1);
      const ok = setTrenchPin(nx);
      if (ok) toast.success(`Trench pinned at x = ${nx} ft — cables and buses rerouted`);
      else toast.error('Trench corridor rejected — it would leave the fenced yard. Snapped back.');
    }
    setDragging(null);
  };

  // Commit on pointer release anywhere (even outside the canvas), so drags
  // never get stuck if the mouse leaves the preview before releasing.
  // Geometry availability is a mount prerequisite for this edit layer. The
  // parent remounts the layer when the equipment family changes.
  // eslint-disable-next-line react-hooks/rules-of-hooks
  useEffect(() => {
    if (!drag) return;
    window.addEventListener('pointerup', commitDrop);
    return () => window.removeEventListener('pointerup', commitDrop);
  });

  // If the layer unmounts mid-drag (edit mode toggled off, design cleared),
  // make sure the parent never keeps a stale "dragging" flag.
  // See the immutable mount-prerequisite note above.
  // eslint-disable-next-line react-hooks/rules-of-hooks
  useEffect(() => () => onDraggingChange(false), [onDraggingChange]);

  return (
    <group>
      {/* Row pick planes */}
      {rows.map(row => {
        const bb = rowBBox(row, geom.halfW, geom.halfD);
        const active = drag?.kind === 'row' && drag.index === row.index;
        const hovered = hover === `row-${row.index}`;
        return (
          <mesh
            key={`edit-row-${row.index}`}
            position={[(bb.minX + bb.maxX) / 2, 0.45, -(bb.minY + bb.maxY) / 2]}
            rotation={[-Math.PI / 2, 0, 0]}
            onPointerOver={e => { e.stopPropagation(); if (!drag) setHover(`row-${row.index}`); }}
            onPointerOut={() => setHover(h => (h === `row-${row.index}` ? null : h))}
            onPointerDown={e => {
              e.stopPropagation();
              setDragging({ kind: 'row', index: row.index, start: planePt(e), dx: 0, dy: 0 });
            }}
          >
            <planeGeometry args={[bb.maxX - bb.minX, bb.maxY - bb.minY]} />
            <meshBasicMaterial
              color="#38bdf8"
              transparent
              opacity={active ? 0.28 : hovered ? 0.22 : 0.1}
              side={THREE.DoubleSide}
            />
          </mesh>
        );
      })}

      {/* Drive-aisle pick planes: drag an interior road section north/south;
          the rows north of it shift with it and roads/surfacing/cables
          regenerate on drop. */}
      {aisleHandles.map(({ a, index }) => {
        const active = drag?.kind === 'aisle' && drag.index === index;
        const hovered = hover === `aisle-${index}`;
        return (
          <mesh
            key={`edit-aisle-${index}`}
            position={[a.x, 0.45, -a.y]}
            rotation={[-Math.PI / 2, 0, 0]}
            onPointerOver={e => { e.stopPropagation(); if (!drag) { setHover(`aisle-${index}`); document.body.style.cursor = 'ns-resize'; } }}
            onPointerOut={() => { setHover(h => (h === `aisle-${index}` ? null : h)); document.body.style.cursor = ''; }}
            onPointerDown={e => {
              e.stopPropagation();
              setDragging({ kind: 'aisle', index, start: planePt(e), dy: 0 });
            }}
          >
            <planeGeometry args={[a.length, a.width]} />
            <meshBasicMaterial
              color="#a78bfa"
              transparent
              opacity={active ? 0.32 : hovered ? 0.26 : 0.1}
              side={THREE.DoubleSide}
            />
          </mesh>
        );
      })}

      {/* Perimeter ring edge handles: drag a side of the road ring inward or
          outward; the whole band re-derives on drop (validated: must clear
          the equipment cluster and stay inside the fence). */}
      {design.roadNetwork && (() => {
        const outer = design.roadNetwork.outer;
        if (!outer || outer.length < 3) return null;
        const opts: { x: number; y: number }[] = [];
        for (const s of outer) {
          if (s.kind === 'line') { opts.push(s.a, s.b); }
          else { opts.push({ x: s.c.x - s.r, y: s.c.y - s.r }, { x: s.c.x + s.r, y: s.c.y + s.r }); }
        }
        const oxs = opts.map(p => p.x), oys = opts.map(p => p.y);
        const ob = { minX: Math.min(...oxs), maxX: Math.max(...oxs), minY: Math.min(...oys), maxY: Math.max(...oys) };
        const roadW = CLEARANCES.roadWidth;
        const inset = 60; // keep clear of the filleted corners
        const bands: { side: 'n' | 's' | 'e' | 'w'; x: number; y: number; w: number; h: number; cursor: string }[] = [
          { side: 'n', x: (ob.minX + ob.maxX) / 2, y: ob.maxY - roadW / 2, w: Math.max(20, ob.maxX - ob.minX - inset * 2), h: roadW, cursor: 'ns-resize' },
          { side: 's', x: (ob.minX + ob.maxX) / 2, y: ob.minY + roadW / 2, w: Math.max(20, ob.maxX - ob.minX - inset * 2), h: roadW, cursor: 'ns-resize' },
          { side: 'e', x: ob.maxX - roadW / 2, y: (ob.minY + ob.maxY) / 2, w: roadW, h: Math.max(20, ob.maxY - ob.minY - inset * 2), cursor: 'ew-resize' },
          { side: 'w', x: ob.minX + roadW / 2, y: (ob.minY + ob.maxY) / 2, w: roadW, h: Math.max(20, ob.maxY - ob.minY - inset * 2), cursor: 'ew-resize' },
        ];
        return bands.map(b => {
          const active = drag?.kind === 'ringEdge' && drag.side === b.side;
          const hovered = hover === `ring-${b.side}`;
          const d = active && drag?.kind === 'ringEdge' ? drag.d : 0;
          const dx = b.side === 'e' || b.side === 'w' ? d : 0;
          const dy = b.side === 'n' || b.side === 's' ? d : 0;
          return (
            <mesh
              key={`ring-edge-${b.side}`}
              position={[b.x + dx, 0.46, -(b.y + dy)]}
              rotation={[-Math.PI / 2, 0, 0]}
              onPointerOver={e => { e.stopPropagation(); if (!drag) { setHover(`ring-${b.side}`); document.body.style.cursor = b.cursor; } }}
              onPointerOut={() => { setHover(h => (h === `ring-${b.side}` ? null : h)); document.body.style.cursor = ''; }}
              onPointerDown={e => {
                e.stopPropagation();
                setDragging({ kind: 'ringEdge', side: b.side, start: planePt(e), d: 0 });
              }}
            >
              <planeGeometry args={[b.w, b.h]} />
              <meshBasicMaterial
                color="#38bdf8"
                transparent
                opacity={active ? 0.3 : hovered ? 0.24 : 0.08}
                side={THREE.DoubleSide}
              />
            </mesh>
          );
        });
      })()}

      {/* Click-away catcher: an invisible ground plane under the pick planes.
          Clicking empty ground (not a row band, item, or handle — those all
          stopPropagation) clears the selection, matching Escape. */}
      {(sel || multiSel.length > 0) && !drag && (
        <mesh
          position={[(fb.minX + fb.maxX) / 2, 0.05, -(fb.minY + fb.maxY) / 2]}
          rotation={[-Math.PI / 2, 0, 0]}
          onPointerDown={e => {
            // Shift-clicking empty ground keeps the multi-selection (the
            // drafter is mid-collection); a plain click clears everything.
            if ((e as unknown as { shiftKey?: boolean }).shiftKey) return;
            setSel(null); setMultiSel([]);
          }}
        >
          <planeGeometry args={[(fb.maxX - fb.minX) * 4, (fb.maxY - fb.minY) * 4]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
      )}

      {/* Equipment pick planes: above the row planes (y 0.5 > 0.45) so a
          click on an item wins the raycast; clicks in row gaps still start a
          row drag. Pointer-down begins a drag at the item's CURRENT selection
          scope; releasing without moving is a click and cycles the scope.
          The aux transformer/switchgear cluster is NOT draggable (its position
          is derived), but it still gets a pick plane: without one, clicking an
          aux unit selected nothing and Delete had no target, so the cluster was
          undeletable. Those two kinds select at equipment scope only — the
          pointer-down below starts no drag for them. */}
      {design.equipment.map(eq => {
        // Only the AUTOMATIC cluster's aux units have derived positions. An
        // item the engineer placed by hand owns its own position, so it drags
        // like anything else.
        const manual = isManualEquipmentId(eq.id);
        const fixed = (eq.kind === 'auxTransformer' || eq.kind === 'auxSwitchgear') && !manual;
        const rot = Math.abs(Math.sin(eq.rotation)) > 0.5;
        const hx = (rot ? eq.width : eq.length) / 2;
        const hy = (rot ? eq.length : eq.width) / 2;
        const hovered = hover === `eq-${eq.id}`;
        const isSel = sel?.eqId === eq.id;
        return (
          <mesh
            key={`edit-eq-${eq.id}`}
            position={[eq.x, 0.5, -eq.y]}
            rotation={[-Math.PI / 2, 0, 0]}
            onPointerOver={e => { e.stopPropagation(); if (!drag) setHover(`eq-${eq.id}`); }}
            onPointerOut={() => setHover(h => (h === `eq-${eq.id}` ? null : h))}
            onPointerDown={e => {
              e.stopPropagation();
              // Shift-click: toggle this item in the multi-selection instead
              // of changing the single selection or starting a drag. The unit
              // follows the ownership rules Delete enforces anyway: a member
              // of a hand-placed island toggles the whole island, a PCS
              // toggles its whole block, anything else toggles as itself.
              if ((e as unknown as { shiftKey?: boolean }).shiftKey) {
                // Never collect selections mid-drag or mid-placement: the
                // click belongs to that interaction, not the multi-selection.
                if (drag || placement) return;
                const bn = blockOfEq(eq.id);
                if (bn !== null) {
                  const pIsl = (design.islands ?? []).find(i =>
                    i.placed && i.inverterIds.includes(`inv-${bn}`));
                  const spec = pIsl && (layoutEdits.placedIslands ?? []).find(p =>
                    Math.abs(p.x - (pIsl.cx ?? NaN)) < 0.01 && Math.abs(p.y - (pIsl.cy ?? NaN)) < 0.01);
                  if (spec) { toggleMultiSel({ kind: 'pisland', id: spec.id }); setSel(null); return; }
                }
                if (bn !== null && /^inv-\d+$/.test(eq.id)) {
                  toggleMultiSel({ kind: 'block', n: bn });
                  setSel(null);
                  return;
                }
                toggleMultiSel({ kind: 'equip', id: eq.id });
                setSel(null);
                return;
              }
              const scope = sel?.eqId === eq.id ? sel.scope : 'equip';
              const start = planePt(e);
              const n = blockOfEq(eq.id);
              // Non-block members of a placed island (FJB, comms cabinet,
              // mid-island aux gear) grab the WHOLE island — the drafter
              // clicked the island, not a piece of furniture. This must run
              // BEFORE the fixed-gear early return: island aux units are
              // "fixed" kinds, but on a placed island they are the island.
              {
                const mIsl = eq.id.match(/^(?:fjb|comms|island-aux-dist|island-aux-xfmr)-(\d+)$/);
                if (mIsl) {
                  const pIsl = (design.islands ?? []).find(i => i.placed && i.n === Number(mIsl[1]));
                  const spec = pIsl && (layoutEdits.placedIslands ?? []).find(p =>
                    Math.abs(p.x - (pIsl.cx ?? NaN)) < 0.01 && Math.abs(p.y - (pIsl.cy ?? NaN)) < 0.01);
                  if (spec) {
                    if (sel?.eqId !== eq.id) setSel({ eqId: eq.id, scope: 'equip' });
                    beginPlacement({ mode: 'move', id: spec.id, center: start, snapFt: placeSnap });
                    setDragging({
                      kind: 'pisland', id: spec.id,
                      angleDeg: spec.angleDeg ?? (spec.vertical ? 90 : 0),
                      cx: spec.x, cy: spec.y, start, dx: 0, dy: 0, srcEqId: eq.id,
                    });
                    return;
                  }
                }
              }
              // Derived-position gear: selectable (so Delete has a target),
              // never draggable. No drag is started, so the pointer-up is a
              // plain click that leaves the item selected at equipment scope.
              if (fixed) {
                setSel({ eqId: eq.id, scope: 'equip' });
                return;
              }
              // Hand-placed single item: move it through the SAME transient
              // placement session a new drop uses, so the drafter gets the
              // real model ghost, the snap increment and the live verdict.
              if (manual) {
                const espec = (layoutEdits.placedEquipment ?? [])
                  .filter(isManualEquipmentSpec).find(s => s.id === eq.id);
                if (espec) {
                  if (sel?.eqId !== eq.id) setSel({ eqId: eq.id, scope: 'equip' });
                  beginPlacement({ mode: 'move', id: espec.id, center: start, snapFt: placeSnap });
                  setDragging({
                    kind: 'pequip', id: espec.id,
                    angleDeg: espec.angleDeg ?? 0, start, srcEqId: eq.id,
                  });
                  return;
                }
              }
              // Blocks of a drag-placed island move the WHOLE island (placed
              // islands are self-contained units outside the row machinery).
              if (n !== null) {
                const pIsl = (design.islands ?? []).find(i =>
                  i.placed && i.inverterIds.includes(`inv-${n}`));
                const spec = pIsl && (layoutEdits.placedIslands ?? []).find(p =>
                  Math.abs(p.x - (pIsl.cx ?? NaN)) < 0.01 && Math.abs(p.y - (pIsl.cy ?? NaN)) < 0.01);
                if (spec) {
                  if (sel?.eqId !== eq.id) setSel({ eqId: eq.id, scope: 'equip' });
                  // Moving an existing placement previews through the SAME
                  // transient session as a new drop (real models, explicit
                  // rotation, snap increments), and mutates nothing until
                  // release.
                  beginPlacement({ mode: 'move', id: spec.id, center: start, snapFt: placeSnap });
                  setDragging({
                    kind: 'pisland', id: spec.id,
                    angleDeg: spec.angleDeg ?? (spec.vertical ? 90 : 0),
                    cx: spec.x, cy: spec.y, start, dx: 0, dy: 0, srcEqId: eq.id,
                  });
                  return;
                }
              }
              // Grabbing any block in the marquee group drags the whole group
              if (n !== null && groupSel.includes(n)) {
                setDragging({ kind: 'group', ns: groupSel, start, dx: 0, dy: 0 });
                return;
              }
              if (sel?.eqId !== eq.id) setSel({ eqId: eq.id, scope: 'equip' });
              if (scope === 'row' && n !== null) {
                const ri = rowOfBlock(n);
                if (ri !== null) { setDragging({ kind: 'row', index: ri, start, dx: 0, dy: 0, srcEqId: eq.id }); return; }
              }
              if (scope === 'block' && n !== null && blockCenterOf(n)) {
                setDragging({ kind: 'block', n, start, dx: 0, dy: 0, srcEqId: eq.id });
                return;
              }
              setDragging({ kind: 'equip', id: eq.id, start, dx: 0, dy: 0, srcEqId: eq.id });
            }}
          >
            <planeGeometry args={[hx * 2, hy * 2]} />
            <meshBasicMaterial
              color={isSel ? '#38bdf8' : '#e2e8f0'}
              transparent
              opacity={isSel ? 0.25 : hovered ? 0.2 : 0.02}
              side={THREE.DoubleSide}
            />
          </mesh>
        );
      })}

      {/* Selection outline + scope label */}
      {sel && selEq && (() => {
        const n = blockOfEq(sel.eqId);
        let rect: { minX: number; maxX: number; minY: number; maxY: number } | null = null;
        let label = '';
        if (sel.scope === 'equip') {
          const rot = Math.abs(Math.sin(selEq.rotation)) > 0.5;
          const hx = (rot ? selEq.width : selEq.length) / 2;
          const hy = (rot ? selEq.length : selEq.width) / 2;
          rect = { minX: selEq.x - hx, maxX: selEq.x + hx, minY: selEq.y - hy, maxY: selEq.y + hy };
          label = selEq.label || selEq.id;
        } else if (sel.scope === 'block' && n !== null) {
          const blk = blockCenterOf(n);
          if (blk) {
            rect = { minX: blk.x - geom.halfW, maxX: blk.x + geom.halfW, minY: blk.y - geom.halfD, maxY: blk.y + geom.halfD };
            label = `PCS BLOCK ${n} — arrows: 0.1 ft (Shift: 1 ft)`;
          }
        } else if (sel.scope === 'island' && n !== null) {
          const island = (design.islands ?? []).find(i => i.inverterIds.includes(`inv-${n}`));
          if (island) {
            const islandBlocks = island.inverterIds
              .map(id => blockOfEq(id))
              .filter((id): id is number => id !== null)
              .map(id => blockCenterOf(id))
              .filter((b): b is NonNullable<typeof b> => b !== null);
            if (islandBlocks.length) {
              rect = {
                minX: Math.min(...islandBlocks.map(b => b.x)) - geom.halfW,
                maxX: Math.max(...islandBlocks.map(b => b.x)) + geom.halfW,
                minY: Math.min(...islandBlocks.map(b => b.y)) - geom.halfD,
                maxY: Math.max(...islandBlocks.map(b => b.y)) + geom.halfD,
              };
            } else if (island.placed) {
              // A placed island has no row geometry to measure, so fall back to
              // the real placed equipment extents. Without this the island
              // scope would select silently, with no outline to confirm it.
              const eqs = design.equipment.filter(e => island.inverterIds.includes(e.id));
              if (eqs.length) {
                const hxOf = (e: typeof eqs[number]) =>
                  (Math.abs(Math.sin(e.rotation)) > 0.5 ? e.width : e.length) / 2;
                const hyOf = (e: typeof eqs[number]) =>
                  (Math.abs(Math.sin(e.rotation)) > 0.5 ? e.length : e.width) / 2;
                rect = {
                  minX: Math.min(...eqs.map(e => e.x - hxOf(e))),
                  maxX: Math.max(...eqs.map(e => e.x + hxOf(e))),
                  minY: Math.min(...eqs.map(e => e.y - hyOf(e))),
                  maxY: Math.max(...eqs.map(e => e.y + hyOf(e))),
                };
              }
            }
            label = `ISLAND ${island.n} — arrows: 0.1 ft (Shift: 1 ft)`;
          }
        } else if (sel.scope === 'row' && n !== null) {
          const ri = rowOfBlock(n);
          const row = ri !== null ? rows.find(r => r.index === ri) : null;
          if (row) {
            const bb = rowBBox(row, geom.halfW, geom.halfD);
            rect = bb;
            label = `ROW ${row.index}`;
          }
        }
        if (!rect) return null;
        const canCycle = n !== null && (rowOfBlock(n) !== null || placedIslandOfBlock(n) !== null);
        return (
          <group>
            <Line
              points={[
                new THREE.Vector3(rect.minX, 0.85, -rect.minY),
                new THREE.Vector3(rect.maxX, 0.85, -rect.minY),
                new THREE.Vector3(rect.maxX, 0.85, -rect.maxY),
                new THREE.Vector3(rect.minX, 0.85, -rect.maxY),
                new THREE.Vector3(rect.minX, 0.85, -rect.minY),
              ]}
              color="#38bdf8"
              lineWidth={3.5}
            />
            <Text
              position={[(rect.minX + rect.maxX) / 2, 1.2, -(rect.maxY + 6)]}
              rotation={[-Math.PI / 2, 0, 0]}
              fontSize={5}
              color="#38bdf8"
              outlineWidth={0.4}
              outlineColor="#0f172a"
              anchorX="center"
              anchorY="middle"
            >
              {label + (canCycle ? ' — click again to widen, drag to move, Esc to deselect' : ' — drag to move, Esc to deselect')}
            </Text>
          </group>
        );
      })()}

      {/* Trench pick plane */}
      {trench && (
        <mesh
          position={[trench.x, 0.45, -(trench.yBottom + trench.yTop) / 2]}
          rotation={[-Math.PI / 2, 0, 0]}
          onPointerOver={e => { e.stopPropagation(); if (!drag) setHover('trench'); }}
          onPointerOut={() => setHover(h => (h === 'trench' ? null : h))}
          onPointerDown={e => {
            e.stopPropagation();
            setDragging({ kind: 'trench', start: planePt(e), dx: 0 });
          }}
        >
          <planeGeometry args={[trench.width, trench.yTop - trench.yBottom]} />
          <meshBasicMaterial
            color="#818cf8"
            transparent
            opacity={drag?.kind === 'trench' ? 0.35 : hover === 'trench' ? 0.3 : 0.16}
            side={THREE.DoubleSide}
          />
        </mesh>
      )}

      {/* Feeder corridor pick plane: drag the whole parallel-lane bundle
          perpendicular to the substation approach */}
      {corridor && (
        <mesh
          position={[
            (corridor.rect.minX + corridor.rect.maxX) / 2,
            0.45,
            -(corridor.rect.minY + corridor.rect.maxY) / 2,
          ]}
          rotation={[-Math.PI / 2, 0, 0]}
          onPointerOver={e => { e.stopPropagation(); if (!drag) setHover('feederCorridor'); }}
          onPointerOut={() => setHover(h => (h === 'feederCorridor' ? null : h))}
          onPointerDown={e => {
            e.stopPropagation();
            setDragging({ kind: 'feederCorridor', start: planePt(e), d: 0 });
          }}
        >
          <planeGeometry args={[corridor.rect.maxX - corridor.rect.minX, corridor.rect.maxY - corridor.rect.minY]} />
          <meshBasicMaterial
            color="#ec4899"
            transparent
            opacity={drag?.kind === 'feederCorridor' ? 0.3 : hover === 'feederCorridor' ? 0.25 : 0.12}
            side={THREE.DoubleSide}
          />
        </mesh>
      )}

      {/* Gate pick plane: drag the entrance gate anywhere along the fence */}
      {design.gate && (
        <mesh
          position={[design.gate.x, 0.55, -design.gate.y]}
          rotation={[-Math.PI / 2, 0, design.gate.rotation]}
          onPointerOver={e => { e.stopPropagation(); if (!drag) setHover('gate'); }}
          onPointerOut={() => setHover(h => (h === 'gate' ? null : h))}
          onPointerDown={e => {
            e.stopPropagation();
            setDragging({ kind: 'gate', start: planePt(e), dx: 0, dy: 0 });
          }}
        >
          <planeGeometry args={[design.gate.width + 8, 14]} />
          <meshBasicMaterial
            color="#f97316"
            transparent
            opacity={drag?.kind === 'gate' ? 0.4 : hover === 'gate' ? 0.35 : 0.18}
            side={THREE.DoubleSide}
          />
        </mesh>
      )}

      {/* Laydown pick plane */}
      {laydown && (
        <mesh
          position={[laydown.x, 0.45, -laydown.y]}
          rotation={[-Math.PI / 2, 0, 0]}
          onPointerOver={e => { e.stopPropagation(); if (!drag) setHover('laydown'); }}
          onPointerOut={() => setHover(h => (h === 'laydown' ? null : h))}
          onPointerDown={e => {
            e.stopPropagation();
            setDragging({ kind: 'laydown', start: planePt(e), dx: 0, dy: 0 });
          }}
        >
          <planeGeometry args={[laydown.length, laydown.width]} />
          <meshBasicMaterial
            color="#facc15"
            transparent
            opacity={drag?.kind === 'laydown' ? 0.3 : hover === 'laydown' ? 0.25 : 0.12}
            side={THREE.DoubleSide}
          />
        </mesh>
      )}

      {/* Laydown corner resize handles (drag to resize; opposite corner stays put) */}
      {laydown && ([[1, 1], [1, -1], [-1, 1], [-1, -1]] as const).map(([sx, sy]) => {
        const hxp = laydown.x + (sx * laydown.length) / 2;
        const hyp = laydown.y + (sy * laydown.width) / 2;
        const key = `laydown-h-${sx}-${sy}`;
        const active = drag?.kind === 'laydown-resize' && drag.sx === sx && drag.sy === sy;
        const size = Math.max(6, Math.min(14, Math.min(laydown.length, laydown.width) / 8));
        return (
          <mesh
            key={key}
            position={[hxp, 0.55, -hyp]}
            rotation={[-Math.PI / 2, 0, 0]}
            onPointerOver={e => { e.stopPropagation(); if (!drag) setHover(key); }}
            onPointerOut={() => setHover(h => (h === key ? null : h))}
            onPointerDown={e => {
              e.stopPropagation();
              setDragging({ kind: 'laydown-resize', sx, sy, start: planePt(e), dx: 0, dy: 0 });
            }}
          >
            <planeGeometry args={[size, size]} />
            <meshBasicMaterial
              color="#fde047"
              transparent
              opacity={active ? 0.95 : hover === key ? 0.85 : 0.55}
              side={THREE.DoubleSide}
            />
          </mesh>
        );
      })}

      {/* Grading zone pick surfaces: visible teal rectangles (grading enabled
          only). Zones usually overlap rows/equipment, whose pick planes sit at
          y 0.45–0.5 and would win the raycast over a lower interior plane —
          so the MOVE grab area is a perimeter band at y 0.62 (above every
          other pick plane; drag the zone by its edge, CAD-style), keeping
          equipment inside the zone clickable. The interior plane below the
          row planes still catches clicks over empty ground. Commits go
          through setGradingZones so fence/overlap validation applies. */}
      {gzones.map(z => {
        const active = drag?.kind === 'gzone' && drag.id === z.id;
        const hovered = hover === `gzone-${z.id}`;
        const band = Math.max(4, Math.min(10, Math.min(z.lengthFt, z.widthFt) / 10));
        const startMove = (e: any) => {
          e.stopPropagation();
          setDragging({ kind: 'gzone', id: z.id, start: planePt(e), dx: 0, dy: 0 });
        };
        const hoverIn = (e: any) => { e.stopPropagation(); if (!drag) setHover(`gzone-${z.id}`); };
        const hoverOut = () => setHover(h => (h === `gzone-${z.id}` ? null : h));
        // Four edge strips (N/S/E/W) forming the always-on-top grab band
        const strips: { x: number; y: number; w: number; h: number }[] = [
          { x: z.x, y: z.y + z.widthFt / 2 - band / 2, w: z.lengthFt, h: band },
          { x: z.x, y: z.y - z.widthFt / 2 + band / 2, w: z.lengthFt, h: band },
          { x: z.x - z.lengthFt / 2 + band / 2, y: z.y, w: band, h: Math.max(0.1, z.widthFt - 2 * band) },
          { x: z.x + z.lengthFt / 2 - band / 2, y: z.y, w: band, h: Math.max(0.1, z.widthFt - 2 * band) },
        ];
        return (
          <group key={`edit-gzone-${z.id}`}>
            <mesh
              position={[z.x, 0.42, -z.y]}
              rotation={[-Math.PI / 2, 0, 0]}
              onPointerOver={hoverIn}
              onPointerOut={hoverOut}
              onPointerDown={startMove}
            >
              <planeGeometry args={[z.lengthFt, z.widthFt]} />
              <meshBasicMaterial
                color="#2dd4bf"
                transparent
                opacity={active ? 0.28 : hovered ? 0.22 : 0.1}
                side={THREE.DoubleSide}
              />
            </mesh>
            {strips.map((s, i) => (
              <mesh
                key={`gzone-band-${z.id}-${i}`}
                position={[s.x, 0.62, -s.y]}
                rotation={[-Math.PI / 2, 0, 0]}
                onPointerOver={hoverIn}
                onPointerOut={hoverOut}
                onPointerDown={startMove}
              >
                <planeGeometry args={[s.w, s.h]} />
                <meshBasicMaterial
                  color="#2dd4bf"
                  transparent
                  opacity={active ? 0.5 : hovered ? 0.42 : 0.22}
                  side={THREE.DoubleSide}
                />
              </mesh>
            ))}
            <Line
              points={[
                new THREE.Vector3(z.x - z.lengthFt / 2, 0.5, -(z.y - z.widthFt / 2)),
                new THREE.Vector3(z.x + z.lengthFt / 2, 0.5, -(z.y - z.widthFt / 2)),
                new THREE.Vector3(z.x + z.lengthFt / 2, 0.5, -(z.y + z.widthFt / 2)),
                new THREE.Vector3(z.x - z.lengthFt / 2, 0.5, -(z.y + z.widthFt / 2)),
                new THREE.Vector3(z.x - z.lengthFt / 2, 0.5, -(z.y - z.widthFt / 2)),
              ]}
              color="#2dd4bf"
              lineWidth={2}
              dashed
              dashSize={6}
              gapSize={4}
            />
            <Text
              position={[z.x, 0.6, -z.y]}
              rotation={[-Math.PI / 2, 0, 0]}
              fontSize={5}
              color="#2dd4bf"
              outlineWidth={0.4}
              outlineColor="#0f172a"
              anchorX="center"
              anchorY="middle"
            >
              {`${z.name} — grading zone (drag edge to move)`}
            </Text>
          </group>
        );
      })}

      {/* Grading zone corner resize handles (opposite corner stays put) */}
      {gzones.flatMap(z => ([[1, 1], [1, -1], [-1, 1], [-1, -1]] as const).map(([sx, sy]) => {
        const hxp = z.x + (sx * z.lengthFt) / 2;
        const hyp = z.y + (sy * z.widthFt) / 2;
        const key = `gzone-h-${z.id}-${sx}-${sy}`;
        const active = drag?.kind === 'gzone-resize' && drag.id === z.id && drag.sx === sx && drag.sy === sy;
        const size = Math.max(6, Math.min(14, Math.min(z.lengthFt, z.widthFt) / 8));
        return (
          <mesh
            key={key}
            position={[hxp, 0.64, -hyp]}
            rotation={[-Math.PI / 2, 0, 0]}
            onPointerOver={e => { e.stopPropagation(); if (!drag) setHover(key); }}
            onPointerOut={() => setHover(h => (h === key ? null : h))}
            onPointerDown={e => {
              e.stopPropagation();
              setDragging({ kind: 'gzone-resize', id: z.id, sx, sy, start: planePt(e), dx: 0, dy: 0 });
            }}
          >
            <planeGeometry args={[size, size]} />
            <meshBasicMaterial
              color="#5eead4"
              transparent
              opacity={active ? 0.95 : hover === key ? 0.85 : 0.55}
              side={THREE.DoubleSide}
            />
          </mesh>
        );
      }))}

      {/* Area zone pick surfaces: same CAD-style scheme as grading zones —
          low interior plane + always-on-top perimeter grab band, colored per
          zone type. Click without dragging cycles the type; hover + Delete
          removes the zone. Commits go through setAreaZones (parcel + overlap
          validation, reject→keep). */}
      {azones.map(z => {
        const col = AREA_ZONE_COLORS[z.kind];
        const active = drag?.kind === 'azone' && drag.id === z.id;
        const hovered = hover === `azone-${z.id}`;
        const band = Math.max(4, Math.min(10, Math.min(z.lengthFt, z.widthFt) / 10));
        const startMove = (e: any) => {
          e.stopPropagation();
          setDragging({ kind: 'azone', id: z.id, start: planePt(e), dx: 0, dy: 0 });
        };
        const hoverIn = (e: any) => { e.stopPropagation(); if (!drag) setHover(`azone-${z.id}`); };
        const hoverOut = () => setHover(h => (h === `azone-${z.id}` ? null : h));
        const strips: { x: number; y: number; w: number; h: number }[] = [
          { x: z.x, y: z.y + z.widthFt / 2 - band / 2, w: z.lengthFt, h: band },
          { x: z.x, y: z.y - z.widthFt / 2 + band / 2, w: z.lengthFt, h: band },
          { x: z.x - z.lengthFt / 2 + band / 2, y: z.y, w: band, h: Math.max(0.1, z.widthFt - 2 * band) },
          { x: z.x + z.lengthFt / 2 - band / 2, y: z.y, w: band, h: Math.max(0.1, z.widthFt - 2 * band) },
        ];
        return (
          <group key={`edit-azone-${z.id}`}>
            <mesh
              position={[z.x, 0.42, -z.y]}
              rotation={[-Math.PI / 2, 0, 0]}
              onPointerOver={hoverIn}
              onPointerOut={hoverOut}
              onPointerDown={startMove}
            >
              <planeGeometry args={[z.lengthFt, z.widthFt]} />
              <meshBasicMaterial color={col} transparent opacity={active ? 0.28 : hovered ? 0.22 : 0.1} side={THREE.DoubleSide} />
            </mesh>
            {strips.map((s, i) => (
              <mesh
                key={`azone-band-${z.id}-${i}`}
                position={[s.x, 0.62, -s.y]}
                rotation={[-Math.PI / 2, 0, 0]}
                onPointerOver={hoverIn}
                onPointerOut={hoverOut}
                onPointerDown={startMove}
              >
                <planeGeometry args={[s.w, s.h]} />
                <meshBasicMaterial color={col} transparent opacity={active ? 0.5 : hovered ? 0.42 : 0.22} side={THREE.DoubleSide} />
              </mesh>
            ))}
            <Text
              position={[z.x, 0.6, -z.y]}
              rotation={[-Math.PI / 2, 0, 0]}
              fontSize={5}
              color={col}
              outlineWidth={0.4}
              outlineColor="#0f172a"
              anchorX="center"
              anchorY="middle"
            >
              {`${AREA_ZONE_LABELS[z.kind]} (drag edge to move · click to retype · Del to remove)`}
            </Text>
          </group>
        );
      })}

      {/* Area zone corner resize handles (opposite corner stays put) */}
      {azones.flatMap(z => ([[1, 1], [1, -1], [-1, 1], [-1, -1]] as const).map(([sx, sy]) => {
        const hxp = z.x + (sx * z.lengthFt) / 2;
        const hyp = z.y + (sy * z.widthFt) / 2;
        const key = `azone-h-${z.id}-${sx}-${sy}`;
        const active = drag?.kind === 'azone-resize' && drag.id === z.id && drag.sx === sx && drag.sy === sy;
        const size = Math.max(6, Math.min(14, Math.min(z.lengthFt, z.widthFt) / 8));
        return (
          <mesh
            key={key}
            position={[hxp, 0.64, -hyp]}
            rotation={[-Math.PI / 2, 0, 0]}
            onPointerOver={e => { e.stopPropagation(); if (!drag) setHover(key); }}
            onPointerOut={() => setHover(h => (h === key ? null : h))}
            onPointerDown={e => {
              e.stopPropagation();
              setDragging({ kind: 'azone-resize', id: z.id, sx, sy, start: planePt(e), dx: 0, dy: 0 });
            }}
          >
            <planeGeometry args={[size, size]} />
            <meshBasicMaterial color={AREA_ZONE_COLORS[z.kind]} transparent opacity={active ? 0.95 : hover === key ? 0.85 : 0.55} side={THREE.DoubleSide} />
          </mesh>
        );
      }))}

      {/* Future BESS block pick planes */}
      {futureBlocks.map(zone => {
        const active = drag?.kind === 'futureAug' && drag.id === zone.id;
        const hovered = hover === `futureAug-${zone.id}`;
        return (
          <mesh
            key={`edit-${zone.id}`}
            position={[zone.x, 0.45, -zone.y]}
            rotation={[-Math.PI / 2, 0, 0]}
            onPointerOver={e => { e.stopPropagation(); if (!drag) setHover(`futureAug-${zone.id}`); }}
            onPointerOut={() => setHover(h => (h === `futureAug-${zone.id}` ? null : h))}
            onPointerDown={e => {
              e.stopPropagation();
              setDragging({ kind: 'futureAug', id: zone.id, start: planePt(e), dx: 0, dy: 0 });
            }}
          >
            <planeGeometry args={[zone.length, zone.width]} />
            <meshBasicMaterial
              color="#fb923c"
              transparent
              opacity={active ? 0.3 : hovered ? 0.25 : 0.12}
              side={THREE.DoubleSide}
            />
          </mesh>
        );
      })}

      {/* Standard-grid snap targets while dragging a future block */}
      {snapTargets.map((t, i) => (
        <group key={`snap-${i}`}>
          <Line
            points={[
              new THREE.Vector3(t.x - geom.halfW, 0.75, -(t.y - geom.halfD)),
              new THREE.Vector3(t.x + geom.halfW, 0.75, -(t.y - geom.halfD)),
              new THREE.Vector3(t.x + geom.halfW, 0.75, -(t.y + geom.halfD)),
              new THREE.Vector3(t.x - geom.halfW, 0.75, -(t.y + geom.halfD)),
              new THREE.Vector3(t.x - geom.halfW, 0.75, -(t.y - geom.halfD)),
            ]}
            color={t.near ? '#38bdf8' : '#94a3b8'}
            lineWidth={t.near ? 2.5 : 1.5}
            dashed
            dashSize={4}
            gapSize={3}
          />
          <mesh position={[t.x, 0.72, -t.y]} rotation={[-Math.PI / 2, 0, 0]}>
            <circleGeometry args={[t.near ? 4 : 2.5, 20]} />
            <meshBasicMaterial color={t.near ? '#38bdf8' : '#94a3b8'} transparent opacity={t.near ? 0.9 : 0.5} side={THREE.DoubleSide} />
          </mesh>
        </group>
      ))}

      {/* Place-island tool: full-ground catcher. Hovering starts/steers the
          transient placement session (smooth pointer tracking, deterministic
          snapped candidate); clicking commits it. No rubber band: size and
          orientation are chosen explicitly in the toolbar. */}
      {tool === 'island' && (
        <mesh
          position={[(fb.minX + fb.maxX) / 2, 0.6, -(fb.minY + fb.maxY) / 2]}
          rotation={[-Math.PI / 2, 0, 0]}
          onPointerMove={e => {
            e.stopPropagation();
            const p = planePt(e);
            // Coalesce to one session update per frame — same reason as the
            // drag catcher: pointermove outruns the display refresh.
            placeMovePt.current = p;
            if (placeMoveRaf.current) return;
            placeMoveRaf.current = requestAnimationFrame(() => {
              placeMoveRaf.current = 0;
              const q = placeMovePt.current;
              if (!q) return;
              const live = useDesignStore.getState().placement;
              if (live && live.mode === 'new') updatePlacementPointer(q);
              else if (!live) {
                beginPlacement({
                  mode: 'new', center: q, angleDeg: placeAngleDeg,
                  pairs: islandPairs, kind: placeKind, aug: placeAug,
                  auxGear: placeAuxGear, equipType: placeEquipType, snapFt: placeSnap,
                });
              }
            });
          }}
          onPointerDown={e => {
            e.stopPropagation();
            const p = planePt(e);
            const live = useDesignStore.getState().placement;
            if (!live) {
              beginPlacement({
                mode: 'new', center: p, angleDeg: placeAngleDeg,
                pairs: islandPairs, kind: placeKind, aug: placeAug,
                auxGear: placeAuxGear, equipType: placeEquipType, snapFt: placeSnap,
              });
            } else {
              // A hover session is already live, but its candidate may be one
              // buffered frame behind. The press position is what the drafter
              // means, so apply it synchronously and drop the stale frame.
              placeMovePt.current = p;
              flushPlacementPointer(p);
            }
            setDragging({ kind: 'island-place' });
          }}
        >
          <planeGeometry args={[(fb.maxX - fb.minX) * 4, (fb.maxY - fb.minY) * 4]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} side={THREE.DoubleSide} />
        </mesh>
      )}

      {/* Area-zone tool: full-ground catcher that starts the drag rect */}
      {tool === 'zone' && !drag && (
        <mesh
          position={[(fb.minX + fb.maxX) / 2, 0.6, -(fb.minY + fb.maxY) / 2]}
          rotation={[-Math.PI / 2, 0, 0]}
          onPointerDown={e => {
            e.stopPropagation();
            const p = planePt(e);
            setDragging({ kind: 'zone-place', zkind: zoneKind, start: p, cur: p });
          }}
        >
          <planeGeometry args={[(fb.maxX - fb.minX) * 4, (fb.maxY - fb.minY) * 4]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} side={THREE.DoubleSide} />
        </mesh>
      )}

      {/* Zone-place ghost: live rubber-band rectangle in the type's color;
          green/red edge = would pass/fail the parcel + overlap validation. */}
      {drag?.kind === 'zone-place' && (() => {
        const minX = Math.min(drag.start.x, drag.cur.x), maxX = Math.max(drag.start.x, drag.cur.x);
        const minY = Math.min(drag.start.y, drag.cur.y), maxY = Math.max(drag.start.y, drag.cur.y);
        const cand: AreaZone = {
          id: 'azone-ghost', kind: drag.zkind,
          x: (minX + maxX) / 2, y: (minY + maxY) / 2,
          lengthFt: Math.max(AREA_ZONE_MIN_SIZE_FT, maxX - minX),
          widthFt: Math.max(AREA_ZONE_MIN_SIZE_FT, maxY - minY),
        };
        const ok = areaZonesRejectReason([...azones, cand], design.boundary.polygon) === null;
        const edge = ok ? '#34d399' : '#f87171';
        return (
          <group>
            <mesh position={[cand.x, 0.7, -cand.y]} rotation={[-Math.PI / 2, 0, 0]}>
              <planeGeometry args={[Math.max(0.1, maxX - minX), Math.max(0.1, maxY - minY)]} />
              <meshBasicMaterial color={AREA_ZONE_COLORS[drag.zkind]} transparent opacity={0.2} side={THREE.DoubleSide} depthWrite={false} />
            </mesh>
            <Line
              points={[
                new THREE.Vector3(minX, 0.8, -minY),
                new THREE.Vector3(maxX, 0.8, -minY),
                new THREE.Vector3(maxX, 0.8, -maxY),
                new THREE.Vector3(minX, 0.8, -maxY),
                new THREE.Vector3(minX, 0.8, -minY),
              ]}
              color={edge}
              lineWidth={2.5}
              dashed
              dashSize={5}
              gapSize={3}
            />
          </group>
        );
      })()}

      {/* Live placement ghost — new drops AND moves of an existing placement.
          Geometry comes from the SAME composition the commit uses, so the
          per-item footprints are orientation-correct (a vertical island reads
          as vertical, and single modules with their exact BESS count) and the verdict text
          is the drop's own evaluation, not an approximation. */}
      {placement && (() => {
        const cx = placement.center.x;
        const cy = placement.center.y;
        const angleDeg = placement.angleDeg;
        const θ = angleDeg * Math.PI / 180;
        const pairs = placement.kind === 'single' || placement.kind === 'single2'
          ? undefined
          : (placement.pairs === undefined || placement.pairs === ISLAND_PCS_PER_SIDE ? undefined : placement.pairs);
        const gKind: PlacementKind = placement.kind;
        const gAug = placement.aug;
        const gAuxGear = placement.auxGear;
        const cfg = getEffectiveConfiguration(configId, containersPerPcs);
        const pcsClr = hotClimate ? CLEARANCES.pcsHotClimate : CLEARANCES.pcsStandard;
        // Single manual item: its own footprint and its own evaluation. Drawn
        // before the island branch so nothing island-shaped is computed for it.
        if (gKind === 'equipment') {
          const eqType = placement.equipType;
          if (!eqType) return null;
          const eqSpec = {
            id: placement.id ?? 'placement-preview',
            type: eqType, x: cx, y: cy,
            ...(angleDeg !== 0 ? { angleDeg } : {}),
          };
          const eev = previewPlacedEquipmentDrop(eqSpec, design, cfg, pcsClr, roadMode, layoutEdits);
          const eok = eev.hard === null;
          const ecol = eok ? (eev.soft.length ? '#fbbf24' : '#34d399') : '#f87171';
          const enote = eev.hard ?? (eev.soft.length ? eev.soft[0] : null);
          const cat = MANUAL_EQUIPMENT_CATALOG[eqType];
          const swap = Math.abs(Math.sin(θ)) > 0.5;
          const ehx = (swap ? cat.dims.width : cat.dims.length) / 2;
          const ehy = (swap ? cat.dims.length : cat.dims.width) / 2;
          const eRect = (ex: number, ey: number, h: number): THREE.Vector3[] => {
            const pts = ([[-ex, -ey], [+ex, -ey], [+ex, +ey], [-ex, +ey]] as [number, number][])
              .map(([lx, ly]) => new THREE.Vector3(cx + lx, h, -(cy + ly)));
            return [...pts, pts[0]];
          };
          return (
            <group>
              <mesh position={[cx, 0.7, -cy]} rotation={[-Math.PI / 2, 0, 0]}>
                <planeGeometry args={[Math.max(0.1, ehx * 2), Math.max(0.1, ehy * 2)]} />
                <meshBasicMaterial color={ecol} transparent opacity={0.18} side={THREE.DoubleSide} depthWrite={false} />
              </mesh>
              <Line points={eRect(ehx, ehy, 0.85)} color={ecol} lineWidth={2.5} />
              <Billboard position={[cx, 12, -cy]}>
                <Text
                  fontSize={6}
                  color={ecol}
                  anchorX="center"
                  anchorY="middle"
                  outlineWidth={0.5}
                  outlineColor="#0f172a"
                  maxWidth={320}
                  textAlign="center"
                >
                  {cat.short}
                  {`\n${angleDeg}° · ${cx.toFixed(1)}, ${cy.toFixed(1)} ft`}
                  {enote ? `\n${eok ? 'Warning' : 'Rejected'}: ${enote}` : ''}
                </Text>
              </Billboard>
            </group>
          );
        }
        const dims = placedIslandPlanDims(cfg, pcsClr, pairs, gKind, gAug, gAuxGear);
        // dims is always in the LOCAL (pre-rotation) frame: hx = half strip
        // length, hy = half depth. We apply the rotation in the rotRect helper.
        const { hx, hy } = dims;
        // Run the SAME evaluation the commit will run, so the ghost's color and
        // its reason text can never disagree with the actual result.
        const ev = previewPlacedIslandDrop(
          { x: cx, y: cy }, angleDeg, pairs, design, cfg, pcsClr, roadMode, layoutEdits,
          placement.mode === 'move' ? placement.id : undefined, gKind, gAug, gAuxGear);
        const ok = ev.hard === null;
        const col = ok ? (ev.soft.length ? '#fbbf24' : '#34d399') : '#f87171';
        const note = ev.hard ?? (ev.soft.length ? ev.soft[0] : null);
        // Road-band footprint: the standard 24 ft band at road-edge clearance
        // around the island drawn in the island's rotated frame.
        const roadPad = CLEARANCES.equipmentToRoadEdge + CLEARANCES.roadWidth;
        const bx = hx + roadPad;
        const by = hy + roadPad;
        // Oriented rect helper: generates a closed loop of Vector3 points for
        // a rectangle with half-extents (ex, ey) in the island's local frame,
        // centered at site (x, y), rotated by angle in radians. h = world height.
        const rotRect = (x: number, y: number, ex: number, ey: number, angle: number, h: number): THREE.Vector3[] => {
          const c = Math.cos(angle), s = Math.sin(angle);
          const corners: [number, number][] = [
            [-ex, -ey], [+ex, -ey], [+ex, +ey], [-ex, +ey],
          ];
          const pts = corners.map(([lx, ly]) => new THREE.Vector3(
            x + lx * c - ly * s, h,
            -(y + lx * s + ly * c),
          ));
          return [...pts, pts[0]];
        };
        return (
          <group>
            <Line points={rotRect(cx, cy, bx, by, θ, 0.8)} color={col} lineWidth={1.5}
              transparent opacity={0.55} dashed dashSize={3} gapSize={3} />
            {/* Fill: planeGeometry in XY, rotation [-PI/2, 0, θ] flattens it
                then rotates in the site horizontal plane by θ (CCW from east). */}
            <mesh position={[cx, 0.7, -cy]} rotation={[-Math.PI / 2, 0, θ]}>
              <planeGeometry args={[Math.max(0.1, hx * 2), Math.max(0.1, hy * 2)]} />
              <meshBasicMaterial color={col} transparent opacity={0.12} side={THREE.DoubleSide} depthWrite={false} />
            </mesh>
            <Line points={rotRect(cx, cy, hx, hy, θ, 0.8)} color={col} lineWidth={2.5}
              dashed dashSize={5} gapSize={3} />
            {/* Orientation-correct per-item outlines: every container, PCS,
                aux unit and reserved zone the commit will create, drawn where
                it will actually land. Each footprint carries its own angleDeg. */}
            {previewFootprints.map(f => {
              const fAngle = ((f.angleDeg ?? 0) * Math.PI) / 180;
              return (
                <Line
                  key={`plc-fp-${f.id}`}
                  points={rotRect(f.x, f.y, f.hx, f.hy, fAngle, 0.85)}
                  color={f.role === 'zone' ? '#a78bfa' : f.role === 'future' ? '#93c5fd' : col}
                  lineWidth={f.role === 'equipment' ? 1.8 : 1.2}
                  transparent
                  opacity={f.role === 'equipment' ? 0.95 : 0.6}
                  {...(f.role === 'equipment' ? {} : { dashed: true, dashSize: 3, gapSize: 2 })}
                />
              );
            })}
            {/* Live verdict above the ghost: the drafter reads WHY the drop
                will fail (or what it will warn about) before committing,
                instead of placing blind and reading a toast afterwards. */}
            <Billboard position={[cx, 12, -cy]}>
              <Text
                fontSize={7}
                color={col}
                anchorX="center"
                anchorY="middle"
                outlineWidth={0.5}
                outlineColor="#0f172a"
                maxWidth={320}
                textAlign="center"
              >
                {gKind === 'single' || gKind === 'single2'
                  ? `1 PCS + ${gKind === 'single2' ? 2 : 3} BESS`
                  : `${pairs ?? ISLAND_PCS_PER_SIDE} pairs (${(pairs ?? ISLAND_PCS_PER_SIDE) * 2} blocks)`}
                {gKind === 'single' || gKind === 'single2' ? '' : placement.auxGear ? ' + aux cluster' : ' · core only'}
                {`\n${angleDeg === 0 ? 'horizontal' : angleDeg === 90 ? 'vertical' : `${angleDeg}°`} · ${cx.toFixed(1)}, ${cy.toFixed(1)} ft`}
                {note ? `\n${ok ? 'Warning' : 'Rejected'}: ${note}` : ''}
              </Text>
            </Billboard>
          </group>
        );
      })()}
      {/* Real model-backed ghost: the composed equipment rendered through the
          normal realistic pipeline with its transparent ghost material, so the
          drafter sees actual containers/PCS before committing.
          Deliberately NOT gated on the global realistic-models display toggle:
          that toggle is an optional viewing preference (default off), while
          previewing the real hardware before committing is the whole point of
          the placement session. The near-detail lease keeps it full detail. */}
      {previewEquipment.length > 0 && (
        <Suspense fallback={null}>
          <RealisticEquipment equipment={previewEquipment} ghost />
        </Suspense>
      )}

      {/* Placed-island actions: rotate 90° and delete, shown above each
          drag-placed island. Both are explicit clickable affordances (the
          island itself stays draggable for the move workflow), and both work
          identically in 2D and 3D because they are billboarded overlays. */}
      {tool === 'move' && !drag && (layoutEdits.placedIslands ?? []).map(p => (
        <group key={`pisl-act-${p.id}`}>
          <Billboard position={[p.x - 10, 6, -p.y]}>
            <Text
              fontSize={9}
              color="#38bdf8"
              anchorX="center"
              anchorY="middle"
              outlineWidth={0.6}
              outlineColor="#1e293b"
              onPointerOver={e => { e.stopPropagation(); document.body.style.cursor = 'pointer'; }}
              onPointerOut={() => { document.body.style.cursor = ''; }}
              onClick={e => {
                e.stopPropagation();
                document.body.style.cursor = '';
                const reason = rotatePlacedIsland(p.id);
                if (reason) toast.error(`Rotate rejected: ${reason}`);
                else {
                  const warn = useDesignStore.getState().lastPlacedWarning;
                  if (warn) toast.warning(`Island rotated 90° with warning: ${warn}`);
                  else toast.success('Island rotated 90° — roads, feeders and trenching regenerated');
                }
              }}
            >
              ⟳
            </Text>
          </Billboard>
          <Billboard position={[p.x + 10, 6, -p.y]}>
            <Text
              fontSize={9}
              color="#f87171"
              anchorX="center"
              anchorY="middle"
              outlineWidth={0.6}
              outlineColor="#1e293b"
              onPointerOver={e => { e.stopPropagation(); document.body.style.cursor = 'pointer'; }}
              onPointerOut={() => { document.body.style.cursor = ''; }}
              onClick={e => {
                e.stopPropagation();
                document.body.style.cursor = '';
                removePlacedIsland(p.id);
                toast.success('Placed island removed — site regenerated');
              }}
            >
              ✕
            </Text>
          </Billboard>
        </group>
      ))}

      {/* Same rotate / delete handles for an individually placed item, so a
          hand-placed cabinet is as editable on the plan as a whole island. */}
      {tool === 'move' && !drag && (layoutEdits.placedEquipment ?? []).filter(isManualEquipmentSpec).map(pe => (
        <group key={`peq-act-${pe.id}`}>
          <Billboard position={[pe.x - 7, 6, -pe.y]}>
            <Text
              fontSize={7}
              color="#38bdf8"
              anchorX="center"
              anchorY="middle"
              outlineWidth={0.6}
              outlineColor="#1e293b"
              onPointerOver={e => { e.stopPropagation(); document.body.style.cursor = 'pointer'; }}
              onPointerOut={() => { document.body.style.cursor = ''; }}
              onClick={e => {
                e.stopPropagation();
                document.body.style.cursor = '';
                const reason = rotatePlacedEquipment(pe.id);
                if (reason) toast.error(`Rotate rejected: ${reason}`);
                else {
                  const warn = useDesignStore.getState().lastPlacedWarning;
                  if (warn) toast.warning(`Rotated 90° with warning: ${warn}`);
                  else toast.success('Rotated 90° — routes and drawings regenerated');
                }
              }}
            >
              ⟳
            </Text>
          </Billboard>
          <Billboard position={[pe.x + 7, 6, -pe.y]}>
            <Text
              fontSize={7}
              color="#f87171"
              anchorX="center"
              anchorY="middle"
              outlineWidth={0.6}
              outlineColor="#1e293b"
              onPointerOver={e => { e.stopPropagation(); document.body.style.cursor = 'pointer'; }}
              onPointerOut={() => { document.body.style.cursor = ''; }}
              onClick={e => {
                e.stopPropagation();
                document.body.style.cursor = '';
                removePlacedEquipment(pe.id);
                toast.success('Placed equipment removed — site regenerated');
              }}
            >
              ✕
            </Text>
          </Billboard>
        </group>
      ))}

      {/* Marquee tool: full-ground catcher that starts the rubber-band.
          Also active while a bulk tag is armed (drag a box over drawn
          reference shapes to tag them), regardless of the current tool. */}
      {(tool === 'marquee' || bulkTag) && !drag && (
        <mesh
          position={[(fb.minX + fb.maxX) / 2, 0.6, -(fb.minY + fb.maxY) / 2]}
          rotation={[-Math.PI / 2, 0, 0]}
          onPointerDown={e => {
            e.stopPropagation();
            const p = planePt(e);
            setDragging({ kind: 'marquee', start: p, cur: p });
          }}
        >
          <planeGeometry args={[(fb.maxX - fb.minX) * 4, (fb.maxY - fb.minY) * 4]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} side={THREE.DoubleSide} />
        </mesh>
      )}

      {/* Marquee rubber-band rectangle */}
      {drag?.kind === 'marquee' && (() => {
        const minX = Math.min(drag.start.x, drag.cur.x), maxX = Math.max(drag.start.x, drag.cur.x);
        const minY = Math.min(drag.start.y, drag.cur.y), maxY = Math.max(drag.start.y, drag.cur.y);
        return (
          <group>
            <mesh position={[(minX + maxX) / 2, 0.7, -(minY + maxY) / 2]} rotation={[-Math.PI / 2, 0, 0]}>
              <planeGeometry args={[Math.max(0.1, maxX - minX), Math.max(0.1, maxY - minY)]} />
              <meshBasicMaterial color="#22d3ee" transparent opacity={0.12} side={THREE.DoubleSide} depthWrite={false} />
            </mesh>
            <Line
              points={[
                new THREE.Vector3(minX, 0.8, -minY),
                new THREE.Vector3(maxX, 0.8, -minY),
                new THREE.Vector3(maxX, 0.8, -maxY),
                new THREE.Vector3(minX, 0.8, -maxY),
                new THREE.Vector3(minX, 0.8, -minY),
              ]}
              color="#22d3ee"
              lineWidth={2.5}
              dashed
              dashSize={5}
              gapSize={3}
            />
          </group>
        );
      })()}

      {/* Group selection outlines (cyan) on each selected block */}
      {groupSel.length > 0 && groupSel.map(n => {
        const blk = blockCenterOf(n);
        if (!blk) return null;
        const dx = drag?.kind === 'group' ? drag.dx : 0;
        const dy = drag?.kind === 'group' ? drag.dy : 0;
        return (
          <Line
            key={`gsel-${n}`}
            points={[
              new THREE.Vector3(blk.x - geom.halfW + dx, 0.82, -(blk.y - geom.halfD + dy)),
              new THREE.Vector3(blk.x + geom.halfW + dx, 0.82, -(blk.y - geom.halfD + dy)),
              new THREE.Vector3(blk.x + geom.halfW + dx, 0.82, -(blk.y + geom.halfD + dy)),
              new THREE.Vector3(blk.x - geom.halfW + dx, 0.82, -(blk.y + geom.halfD + dy)),
              new THREE.Vector3(blk.x - geom.halfW + dx, 0.82, -(blk.y - geom.halfD + dy)),
            ]}
            color="#22d3ee"
            lineWidth={3}
          />
        );
      })}

      {/* Shift-click multi-selection highlight: one outline per selected
          unit (block, single item, or whole hand-placed island), in a
          distinct color so it reads apart from the marquee group. */}
      {multiSel.length > 0 && multiSel.map((m, i) => {
        let rect: { minX: number; maxX: number; minY: number; maxY: number } | null = null;
        if (m.kind === 'block') {
          const blk = blockCenterOf(m.n);
          if (blk) rect = { minX: blk.x - geom.halfW, maxX: blk.x + geom.halfW, minY: blk.y - geom.halfD, maxY: blk.y + geom.halfD };
        } else if (m.kind === 'equip') {
          const eq = design.equipment.find(e => e.id === m.id);
          if (eq) {
            const rot = Math.abs(Math.sin(eq.rotation)) > 0.5;
            const hx = (rot ? eq.width : eq.length) / 2;
            const hy = (rot ? eq.length : eq.width) / 2;
            rect = { minX: eq.x - hx, maxX: eq.x + hx, minY: eq.y - hy, maxY: eq.y + hy };
          }
        } else {
          const spec = (layoutEdits.placedIslands ?? []).find(p => p.id === m.id);
          const isl = spec && (design.islands ?? []).find(x =>
            x.placed && Math.abs((x.cx ?? NaN) - spec.x) < 0.01 && Math.abs((x.cy ?? NaN) - spec.y) < 0.01);
          if (isl) {
            const members = new Set(isl.inverterIds.map(id => Number((id.match(/^inv-(\d+)/) ?? [])[1])));
            const eqs = design.equipment.filter(e => {
              const n = Number(((e.id.match(/^(?:inv|bess)-(\d+)/) ?? [])[1]));
              return Number.isInteger(n) && members.has(n);
            });
            if (eqs.length) {
              rect = {
                minX: Math.min(...eqs.map(e => e.x)) - 15, maxX: Math.max(...eqs.map(e => e.x)) + 15,
                minY: Math.min(...eqs.map(e => e.y)) - 15, maxY: Math.max(...eqs.map(e => e.y)) + 15,
              };
            }
          }
        }
        if (!rect) return null;
        return (
          <Line
            key={`msel-${i}`}
            points={[
              new THREE.Vector3(rect.minX, 0.84, -rect.minY),
              new THREE.Vector3(rect.maxX, 0.84, -rect.minY),
              new THREE.Vector3(rect.maxX, 0.84, -rect.maxY),
              new THREE.Vector3(rect.minX, 0.84, -rect.maxY),
              new THREE.Vector3(rect.minX, 0.84, -rect.minY),
            ]}
            color="#fbbf24"
            lineWidth={3}
          />
        );
      })}

      {/* Feeder home-run pick handles: in edit mode, clicking a feeder's
          home run enters waypoint drawing for that circuit. Thin invisible
          boxes lie along each home-run leg (the last segment of every
          visible feeder). */}
      {tool === 'move' && !drag && !fdDraw && feeders
        .filter(f => !hiddenFeeders.has(f.idx) && f.segments.length > 0)
        .map(f => {
          const home = f.segments[f.segments.length - 1];
          const launch = home.pts[0];
          return home.pts.slice(0, -1).map((a, k) => {
            const b = home.pts[k + 1];
            const len = Math.hypot(b.x - a.x, b.y - a.y);
            if (len < 2) return null;
            return (
              <mesh
                key={`fdpick-${f.idx}-${k}`}
                position={[(a.x + b.x) / 2, 0.7, -(a.y + b.y) / 2]}
                rotation={[0, Math.atan2(b.y - a.y, b.x - a.x), 0]}
                onPointerOver={e => { e.stopPropagation(); document.body.style.cursor = 'crosshair'; }}
                onPointerOut={() => { document.body.style.cursor = ''; }}
                onClick={e => {
                  e.stopPropagation();
                  document.body.style.cursor = '';
                  setFdDraw({ idx: f.idx, launch: { x: launch.x, y: launch.y } });
                  setFdPts([]); setFdCursor(null);
                  toast.info(`Drawing route for feeder #${feederDisplayName(f)} — click waypoints, Enter or double-click to apply, Esc to cancel.`);
                }}
              >
                <boxGeometry args={[len, 1.5, 6]} />
                <meshBasicMaterial visible={false} />
              </mesh>
            );
          });
        })}

      {/* Feeder waypoint drawing: click to add vertices, double-click/Enter
          commits the custom home run, Esc cancels. */}
      {fdDraw && !drag && (
        <mesh
          position={[(fb.minX + fb.maxX) / 2, 0.6, -(fb.minY + fb.maxY) / 2]}
          rotation={[-Math.PI / 2, 0, 0]}
          onPointerMove={e => { e.stopPropagation(); const p = planePt(e); setFdCursor({ x: snapToGrid(p.x, 1), y: snapToGrid(p.y, 1) }); }}
          onPointerDown={e => {
            e.stopPropagation();
            const p = planePt(e);
            const pt = { x: snapToGrid(p.x, 1), y: snapToGrid(p.y, 1) };
            setFdPts(prev => {
              const last = prev[prev.length - 1];
              if (last && Math.hypot(pt.x - last.x, pt.y - last.y) < 1) return prev;
              return [...prev, pt];
            });
          }}
          onDoubleClick={e => { e.stopPropagation(); commitFeederRoute(); }}
        >
          <planeGeometry args={[(fb.maxX - fb.minX) * 4, (fb.maxY - fb.minY) * 4]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} side={THREE.DoubleSide} />
        </mesh>
      )}

      {/* Feeder route preview: launch point → committed waypoints → cursor */}
      {fdDraw && (() => {
        const pts = [fdDraw.launch, ...fdPts, ...(fdCursor ? [fdCursor] : [])];
        return (
          <group>
            {pts.length >= 2 && (
              <Line
                points={pts.map(p => new THREE.Vector3(p.x, 0.9, -p.y))}
                color="#22d3ee"
                lineWidth={3.5}
                dashed
                dashSize={6}
                gapSize={3}
              />
            )}
            {[fdDraw.launch, ...fdPts].map((p, i) => (
              <mesh key={`fdpt-${i}`} position={[p.x, 0.91, -p.y]} rotation={[-Math.PI / 2, 0, 0]}>
                <circleGeometry args={[3, 16]} />
                <meshBasicMaterial color="#22d3ee" side={THREE.DoubleSide} />
              </mesh>
            ))}
          </group>
        );
      })()}

      {/* Aux feeder waypoint drawing: click to add vertices, double-click/Enter
          commits the custom 34.5 kV daisy chain route, Esc cancels. The start
          always snaps to the substation; the end snaps to the last aux xfmr. */}
      {auxFdDraw && !drag && substation && (
        <mesh
          position={[(fb.minX + fb.maxX) / 2, 0.6, -(fb.minY + fb.maxY) / 2]}
          rotation={[-Math.PI / 2, 0, 0]}
          onPointerMove={e => { e.stopPropagation(); const p = planePt(e); setAuxFdCursor({ x: snapToGrid(p.x, 1), y: snapToGrid(p.y, 1) }); }}
          onPointerDown={e => {
            e.stopPropagation();
            const p = planePt(e);
            const pt = { x: snapToGrid(p.x, 1), y: snapToGrid(p.y, 1) };
            setAuxFdPts(prev => {
              const last = prev[prev.length - 1];
              if (last && Math.hypot(pt.x - last.x, pt.y - last.y) < 1) return prev;
              return [...prev, pt];
            });
          }}
          onDoubleClick={e => { e.stopPropagation(); commitAuxFeederRoute(); }}
        >
          <planeGeometry args={[(fb.maxX - fb.minX) * 4, (fb.maxY - fb.minY) * 4]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} side={THREE.DoubleSide} />
        </mesh>
      )}

      {/* Aux feeder route preview: substation → committed waypoints → cursor */}
      {auxFdDraw && substation && (() => {
        const pts = [substation, ...auxFdPts, ...(auxFdCursor ? [auxFdCursor] : [])];
        return (
          <group>
            {pts.length >= 2 && (
              <Line
                points={pts.map(p => new THREE.Vector3(p.x, 0.9, -p.y))}
                color={AUX_FEEDER_COLOR.hex}
                lineWidth={3.5}
                dashed
                dashSize={6}
                gapSize={3}
              />
            )}
            {[substation, ...auxFdPts].map((p, i) => (
              <mesh key={`auxfdpt-${i}`} position={[p.x, 0.91, -p.y]} rotation={[-Math.PI / 2, 0, 0]}>
                <circleGeometry args={[3, 16]} />
                <meshBasicMaterial color={AUX_FEEDER_COLOR.hex} side={THREE.DoubleSide} />
              </mesh>
            ))}
          </group>
        );
      })()}

      {/* Road edit tool: ONE ground pick-plane over the whole yard rather than
          per-piece slabs. The road surface is a single boolean region, so
          hit-testing the region is what makes every road kind selectable with
          the same code — the perimeter ring and gate apron included, neither
          of which exists as a rectangle to hang a slab on.

          Click       — select the WHOLE road under the pointer (Shift adds to
                        the selection); Delete or the toolbar removes it. On
                        the unnamed perimeter ring this resolves to the whole
                        straight run through the pick, corner to corner — a
                        click must never resolve to a stub.
          Shift-drag  — no; partial deletes are two deliberate clicks (below),
                        so a stray drag can never silently cut a road.
          Second mode — with a start point set, the next click deletes the
                        stretch BETWEEN the two picks, following the pavement
                        around corners and junctions rather than cutting the
                        straight line between them. */}
      {tool === 'road-remove' && !drag && (
        <mesh
          position={[(fb.minX + fb.maxX) / 2, 0.62, -(fb.minY + fb.maxY) / 2]}
          rotation={[-Math.PI / 2, 0, 0]}
          onPointerMove={e => {
            e.stopPropagation();
            const p = planePt(e);
            if (spanPt) setSpanCursor(p);
            const onRoad = pointOnRoad(roadRegion, p);
            // Off-pavement: try the traced linework-only records (they have
            // no pavement to hit but are still selectable from their drawn
            // geometry). Span mode stays pavement-only.
            const lw = onRoad || spanPt ? null : roadPieceAt(p, [], [], tracedLineworkRoads);
            document.body.style.cursor = onRoad || lw ? 'pointer' : '';
            if (onRoad || lw) {
              const piece = lw ?? roadPieceAt(p, design.aisles, design.roads, layoutEdits.customRoads ?? []);
              setRoadHover(prev =>
                prev && prev.pt.x === p.x && prev.pt.y === p.y &&
                  prev.piece?.id === piece?.id ? prev : { piece, pt: p },
              );
            } else {
              setRoadHover(null);
            }
          }}
          onPointerOut={() => { document.body.style.cursor = ''; setRoadHover(null); }}
          onClick={e => {
            e.stopPropagation();
            const p = planePt(e);
            if (!pointOnRoad(roadRegion, p)) {
              // Traced strips kept as reference linework carry no pavement,
              // but drafters still need to select them — to delete one, or to
              // force-pave it as drawn. Fall back to their stored records
              // before treating the click as empty ground. Span mode stays
              // pavement-only (the cut follows the rendered road).
              const lw = spanPt ? null : roadPieceAt(p, [], [], tracedLineworkRoads);
              if (!lw) {
                if (!(e as any).shiftKey) { setRoadSel([]); setSpanPt(null); setSpanCursor(null); }
                return;
              }
              const entry: RoadSel = { pt: p, piece: lw, run: null, cut: null };
              setRoadSel(prev => (e as any).shiftKey ? [...prev, entry] : [entry]);
              setSel(null); setGroupSel([]);
              return;
            }
            // Span mode: the second click completes a point-to-point deletion.
            // The cut FOLLOWS the pavement between the two picks (around
            // corners and junctions), so picking two points that are not on
            // one straight run no longer slashes across the yard.
            if (spanPt) {
              const path = roadPathBetween(roadRegion, spanPt, p);
              const poly = path
                ? roadCorridorCutPoly(roadRegion, path)
                : roadSpanCutPoly(roadRegion, spanPt, p);
              setSpanPt(null); setSpanCursor(null);
              if (!poly) {
                toast.error(path
                  ? 'Could not measure the road between those two points.'
                  : 'Those two points are not connected by road — pick both ends on the same road network.');
                return;
              }
              const warn = cutRoadArea(poly, 'Road stretch');
              const rejected = useDesignStore.getState().lastRejection;
              if (rejected) toast.error(rejected);
              else if (warn) toast.warning(`Road stretch deleted, but vehicle access is now broken: ${warn}`, { duration: 10000 });
              else toast.success('Road stretch deleted — road network, surfacing, cables, feeders and exports rebuilt');
              return;
            }
            const piece = roadPieceAt(p, design.aisles, design.roads, layoutEdits.customRoads ?? []);
            // No named road under the pointer (the perimeter ring): select the
            // whole straight run through the pick, corner to corner. A click
            // must never resolve to a stub — that was the old behaviour and it
            // made deleting a perimeter side impossible.
            let run: Pt[] | null = null, cut: Pt[] | null = null;
            if (!piece) {
              run = roadRunAt(roadRegion, p);
              cut = run ? roadCorridorCutPoly(roadRegion, run) : null;
            }
            const entry: RoadSel = { pt: p, piece, run, cut };
            setRoadSel(prev => (e as any).shiftKey ? [...prev, entry] : [entry]);
            setSel(null); setGroupSel([]);
          }}
        >
          <planeGeometry args={[(fb.maxX - fb.minX) * 4, (fb.maxY - fb.minY) * 4]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} side={THREE.DoubleSide} />
        </mesh>
      )}

      {/* Road hover highlight: shows which road is under the cursor BEFORE the
          drafter clicks, so the target is obvious without committing. Amber
          tint keeps it visually distinct from the red selected state. Hidden
          while a span start-point is set (the start marker already guides the
          drafter) and when the piece is already selected (no double-highlight). */}
      {tool === 'road-remove' && !spanPt && roadHover && (() => {
        const { piece, pt } = roadHover;
        // Skip if this piece is already in the selection.
        const isSelected = piece
          ? roadSel.some(rs => rs.piece?.id === piece.id)
          : roadSel.some(rs => !rs.piece && Math.hypot(rs.pt.x - pt.x, rs.pt.y - pt.y) < 10);
        if (isSelected) return null;
        const a = piece && (piece.kind === 'aisle' || piece.kind === 'corridor')
          ? design.aisles.find(x => x.id === piece.id)
          : piece?.kind === 'gate'
            ? design.roads.find(x => x.id === piece.id)
            : null;
        if (a) {
          const vertical = Math.abs(Math.sin(a.rotation)) > 0.5;
          const w = vertical ? a.width : a.length;
          const h = vertical ? a.length : a.width;
          return (
            <mesh position={[a.x, 0.73, -a.y]} rotation={[-Math.PI / 2, 0, 0]}>
              <planeGeometry args={[Math.max(1, w), Math.max(1, h)]} />
              <meshBasicMaterial color="#fbbf24" transparent opacity={0.28} side={THREE.DoubleSide} depthWrite={false} />
            </mesh>
          );
        }
        if (piece?.kind === 'drawn') {
          const r = (layoutEdits.customRoads ?? []).find(c => c.id === piece.id);
          if (r && r.pts.length >= 2) {
            return (
              <Line
                points={r.pts.map(p2 => new THREE.Vector3(p2.x, 0.77, -p2.y))}
                color="#fbbf24" lineWidth={3} transparent opacity={0.7} />
            );
          }
        }
        // Perimeter ring: amber circle at the cursor, slightly larger than the
        // selection marker so the difference in state is legible.
        return (
          <mesh position={[pt.x, 0.73, -pt.y]} rotation={[-Math.PI / 2, 0, 0]}>
            <circleGeometry args={[7, 24]} />
            <meshBasicMaterial color="#fbbf24" transparent opacity={0.3} side={THREE.DoubleSide} depthWrite={false} />
          </mesh>
        );
      })()}

      {/* Selected-road highlight: whole named roads glow along their own
          footprint; a pick on the unnamed perimeter ring shows a marker at the
          picked point (its deletion is by span). */}
      {tool === 'road-remove' && roadSel.map((rs, i) => {
        const a = rs.piece && (rs.piece.kind === 'aisle' || rs.piece.kind === 'corridor')
          ? design.aisles.find(x => x.id === rs.piece!.id)
          : rs.piece?.kind === 'gate'
            ? design.roads.find(x => x.id === rs.piece!.id)
            : null;
        if (a) {
          const vertical = Math.abs(Math.sin(a.rotation)) > 0.5;
          const w = vertical ? a.width : a.length;
          const h = vertical ? a.length : a.width;
          return (
            <mesh key={`road-sel-${i}`} position={[a.x, 0.74, -a.y]} rotation={[-Math.PI / 2, 0, 0]}>
              <planeGeometry args={[Math.max(1, w), Math.max(1, h)]} />
              <meshBasicMaterial color="#f87171" transparent opacity={0.4} side={THREE.DoubleSide} depthWrite={false} />
            </mesh>
          );
        }
        if (rs.piece?.kind === 'drawn') {
          const r = (layoutEdits.customRoads ?? []).find(c => c.id === rs.piece!.id);
          if (r && r.pts.length >= 2) {
            return (
              <Line key={`road-sel-${i}`}
                points={r.pts.map(p => new THREE.Vector3(p.x, 0.78, -p.y))}
                color="#f87171" lineWidth={4} transparent opacity={0.9} />
            );
          }
        }
        return (
          <mesh key={`road-sel-${i}`} position={[rs.pt.x, 0.76, -rs.pt.y]} rotation={[-Math.PI / 2, 0, 0]}>
            <circleGeometry args={[6, 20]} />
            <meshBasicMaterial color="#f87171" transparent opacity={0.55} side={THREE.DoubleSide} depthWrite={false} />
          </mesh>
        );
      })}

      {/* Span-cut preview: start marker + the live band that would be removed,
          measured across the road's real width at the cursor. */}
      {tool === 'road-remove' && spanPt && (() => {
        // Preview runs the same road-following geometry the commit runs, so
        // what the drafter sees dashed is exactly what gets removed.
        const path = spanCursor ? roadPathBetween(roadRegion, spanPt, spanCursor) : null;
        const preview = path ? roadCorridorCutPoly(roadRegion, path) : null;
        return (
          <group>
            <mesh position={[spanPt.x, 0.8, -spanPt.y]} rotation={[-Math.PI / 2, 0, 0]}>
              <circleGeometry args={[3, 16]} />
              <meshBasicMaterial color="#fbbf24" side={THREE.DoubleSide} depthWrite={false} />
            </mesh>
            {preview && (
              <Line
                points={[...preview, preview[0]].map(p => new THREE.Vector3(p.x, 0.82, -p.y))}
                color="#f87171" lineWidth={2} dashed dashSize={3} gapSize={2} />
            )}
          </group>
        );
      })()}

      {/* Road drawing tool: click to add vertices, double-click/Enter to
          finish, Esc cancels. The strip is carved into the road network on
          commit; preview shows the centerline + a road-width band. */}
      {tool === 'road' && !drag && (
        <mesh
          position={[(fb.minX + fb.maxX) / 2, 0.6, -(fb.minY + fb.maxY) / 2]}
          rotation={[-Math.PI / 2, 0, 0]}
          onPointerMove={e => { e.stopPropagation(); const p = planePt(e); setRoadCursor(snapRoadPoint(p, roadPts[roadPts.length - 1])); }}
          onPointerDown={e => {
            e.stopPropagation();
            const p = planePt(e);
            const pt = snapRoadPoint(p, roadPts[roadPts.length - 1]);
            setRoadPts(prev => {
              const last = prev[prev.length - 1];
              if (last && Math.hypot(pt.x - last.x, pt.y - last.y) < 1) return prev;
              return [...prev, pt];
            });
          }}
          onDoubleClick={e => {
            e.stopPropagation();
            if (roadPts.length >= 2) {
              const ok = addCustomRoad(roadPts, roadDrawWidth !== 24 ? roadDrawWidth : undefined);
              if (ok) toast.success(`Access road added (${roadDrawWidth} ft wide) — road network, surfacing and DXF updated`);
              else toast.error(useDesignStore.getState().lastRejection ?? 'Road could not be added.');
            }
            setRoadPts([]); setRoadCursor(null);
            onToolChange('move');
          }}
        >
          <planeGeometry args={[(fb.maxX - fb.minX) * 4, (fb.maxY - fb.minY) * 4]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} side={THREE.DoubleSide} />
        </mesh>
      )}

      {/* Road polyline preview */}
      {tool === 'road' && (roadPts.length > 0 || roadCursor) && (() => {
        const pts = [...roadPts, ...(roadCursor ? [roadCursor] : [])];
        if (pts.length < 1) return null;
        return (
          <group>
            {pts.length >= 2 && <RoadDraftBand pts={pts} width={roadDrawWidth} />}
            {pts.length >= 2 && (
              <Line
                points={pts.map(p => new THREE.Vector3(p.x, 0.85, -p.y))}
                color="#fbbf24"
                lineWidth={3.5}
                dashed
                dashSize={6}
                gapSize={3}
              />
            )}
            {roadPts.map((p, i) => (
              <mesh key={`roadpt-${i}`} position={[p.x, 0.86, -p.y]} rotation={[-Math.PI / 2, 0, 0]}>
                <circleGeometry args={[3, 16]} />
                <meshBasicMaterial color="#fbbf24" side={THREE.DoubleSide} />
              </mesh>
            ))}
          </group>
        );
      })()}

      {/* Ghost outline with live validity */}
      {ghost && <GhostRect {...ghost.rect} valid={ghost.valid} />}
      {/* Live pad-elevation readout while dragging/resizing a grading zone */}
      {ghost && 'label' in ghost && ghost.label && (
        <Text
          position={[(ghost.rect.minX + ghost.rect.maxX) / 2, 0.9, -(ghost.rect.maxY + 8)]}
          rotation={[-Math.PI / 2, 0, 0]}
          fontSize={6}
          color={ghost.valid ? '#5eead4' : '#fca5a5'}
          outlineWidth={0.5}
          outlineColor="#0f172a"
          anchorX="center"
          anchorY="bottom"
        >
          {ghost.label}
        </Text>
      )}

      {/* Invisible drag-catcher plane while dragging */}
      {drag && (
        <mesh
          position={[0, 0.4, 0]}
          rotation={[-Math.PI / 2, 0, 0]}
          onPointerMove={e => {
            e.stopPropagation();
            // Coalesce pointer moves to one state update per animation frame:
            // on a 300MW+ site each setDrag re-renders the whole edit layer
            // (ghost validation, pick planes), and pointermove can fire far
            // faster than the display refreshes. Only the latest point in a
            // frame matters, so buffer it and apply once per rAF.
            dragMovePt.current = planePt(e);
            if (dragMoveRaf.current) return;
            dragMoveRaf.current = requestAnimationFrame(() => {
              dragMoveRaf.current = 0;
              const p = dragMovePt.current;
              if (!p) return;
              setDrag(prev => {
                if (!prev) return prev;
                if (prev.kind === 'row' || prev.kind === 'block' || prev.kind === 'equip' || prev.kind === 'laydown' || prev.kind === 'laydown-resize' || prev.kind === 'futureAug' || prev.kind === 'gate' || prev.kind === 'group' || prev.kind === 'gzone' || prev.kind === 'gzone-resize' || prev.kind === 'azone' || prev.kind === 'azone-resize') {
                  return { ...prev, dx: snapToGrid(p.x - prev.start.x), dy: snapToGrid(p.y - prev.start.y) };
                }
                if (prev.kind === 'marquee' || prev.kind === 'zone-place') return { ...prev, cur: p };
                if (prev.kind === 'island-place') {
                  // Placement position lives in the session, not the drag.
                  updatePlacementPointer(p);
                  return prev;
                }
                if (prev.kind === 'pisland') {
                  // A move steers the SAME session as a new placement: the raw
                  // pointer keeps the ghost smooth, the session's snap
                  // increment decides the deterministic candidate.
                  updatePlacementPointer({
                    x: prev.cx + (p.x - prev.start.x),
                    y: prev.cy + (p.y - prev.start.y),
                  });
                  return { ...prev, dx: p.x - prev.start.x, dy: p.y - prev.start.y };
                }
                if (prev.kind === 'aisle') {
                  // Vertical-only: an aisle slides north/south between its rows
                  return { ...prev, dy: snapToGrid(p.y - prev.start.y) };
                }
                if (prev.kind === 'ringEdge') {
                  // Single-axis: a ring edge slides perpendicular to itself
                  const raw = prev.side === 'n' || prev.side === 's' ? p.y - prev.start.y : p.x - prev.start.x;
                  return { ...prev, d: snapToGrid(raw) };
                }
                if (prev.kind === 'feederCorridor') {
                  // Single-axis: the lane bundle slides perpendicular to the
                  // approach (y for an east/west substation, x for north/south)
                  const delta = corridor?.info.horiz ? p.y - prev.start.y : p.x - prev.start.x;
                  return { ...prev, d: snapToGrid(delta) };
                }
                return { ...prev, dx: snapToGrid(p.x - prev.start.x) };
              });
            });
          }}
        >
          <planeGeometry args={[100000, 100000]} />
          <meshBasicMaterial visible={false} side={THREE.DoubleSide} />
        </mesh>
      )}
    </group>
  );
}

// Distance-based LOD for realistic models: past ENTER the whole yard is a
// few hundred pixels and the high-poly GLBs are indistinguishable from the
// simple boxes, so the scene falls back to boxes; zooming back under EXIT
// restores the models. Two thresholds (hysteresis band) so the swap never
// flickers while orbiting near the boundary. Runs one distance check per
// rendered frame (demand frameloop: only while the camera actually moves).
function RealisticLodSensor({ design, far, onChange }: { design: SiteDesign; far: boolean; onChange: (f: boolean) => void }) {
  const { center, diag } = useMemo(() => {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const eq of design.equipment) {
      if (eq.x < minX) minX = eq.x;
      if (eq.x > maxX) maxX = eq.x;
      if (eq.y < minY) minY = eq.y;
      if (eq.y > maxY) maxY = eq.y;
    }
    if (!Number.isFinite(minX)) return { center: new THREE.Vector3(), diag: 0 };
    return {
      center: new THREE.Vector3((minX + maxX) / 2, 0, -(minY + maxY) / 2),
      diag: Math.hypot(maxX - minX, maxY - minY),
    };
  }, [design.equipment]);
  useFrame(({ camera }) => {
    if (diag <= 0) return;
    const dist = camera.position.distanceTo(center);
    // Small yards keep models up to a fixed floor so a compact site never
    // downgrades at a normal working distance. Thresholds are generous:
    // framing the WHOLE yard must still show the models (pressing the
    // Realistic button has to visibly change the scene), so the box swap
    // only kicks in well past the full-yard framing distance.
    const enter = Math.max(diag * 3.2, 4000);
    const exit = Math.max(diag * 2.6, 3200);
    if (!far && dist > enter) onChange(true);
    else if (far && dist < exit) onChange(false);
  });
  return null;
}

// Always-visible area-zone overlay (outside edit mode too): translucent
// colored plane + outline + label per zone, matching the export reference
// colors. Pure presentation — reads the store, never mutates it.
function AreaZonesOverlay() {
  const azones = useDesignStore(s => s.areaZones);
  const generatedLabelsVisible = useDesignStore(s => s.drawingVisibility.labels);
  if (!azones.length) return null;
  return (
    <group>
      {azones.map(z => {
        const col = AREA_ZONE_COLORS[z.kind];
        const edge = AREA_ZONE_BORDER_COLORS[z.kind];
        return (
          <group key={`azone-view-${z.id}`}>
            <mesh position={[z.x, 0.34, -z.y]} rotation={[-Math.PI / 2, 0, 0]}>
              <planeGeometry args={[z.lengthFt, z.widthFt]} />
              <meshBasicMaterial color={col} transparent opacity={0.16} side={THREE.DoubleSide} depthWrite={false} />
            </mesh>
            <Line
              points={[
                new THREE.Vector3(z.x - z.lengthFt / 2, 0.36, -(z.y - z.widthFt / 2)),
                new THREE.Vector3(z.x + z.lengthFt / 2, 0.36, -(z.y - z.widthFt / 2)),
                new THREE.Vector3(z.x + z.lengthFt / 2, 0.36, -(z.y + z.widthFt / 2)),
                new THREE.Vector3(z.x - z.lengthFt / 2, 0.36, -(z.y + z.widthFt / 2)),
                new THREE.Vector3(z.x - z.lengthFt / 2, 0.36, -(z.y - z.widthFt / 2)),
              ]}
              color={edge}
              lineWidth={z.kind === 'dryPond' ? 4 : 2}
              dashed={z.kind === 'exclusion'}
              dashSize={6}
              gapSize={4}
            />
            {generatedLabelsVisible && (
              <Text
                position={[z.x, 0.38, -z.y]}
                rotation={[-Math.PI / 2, 0, 0]}
                fontSize={Math.max(4, Math.min(8, z.widthFt / 8))}
                color={col}
                outlineWidth={0.4}
                outlineColor="#0f172a"
                anchorX="center"
                anchorY="middle"
              >
                {AREA_ZONE_LABELS[z.kind]}
              </Text>
            )}
          </group>
        );
      })}
    </group>
  );
}

// Multi-area site: draw every footprint OTHER than the one being edited, so
// all four BESS phases and both substations read as one project. The active
// area is already drawn at full brightness by DesignContent; these are dimmed
// and non-interactive (editing still targets the active area only).
// Distance that fits a ground-plane rectangle in an obliquely-tilted
// perspective view. The simple max(spanX, spanY) fit math assumes the rect
// faces the camera; at the default (0, 1, 0.9) tilt a wide multi-area site is
// foreshortened along one axis and overflows the frustum, pushing the outer
// footprints off-screen. Projects the four ground corners and bisects for the
// nearest distance that keeps them all inside, so framing is exact rather
// than a hand-tuned margin. Pure + deterministic; only used for multi-area
// sites, so single-boundary framing stays byte-identical.
function groundRectFitDistance(
  cx: number, cy: number, spanX: number, spanY: number,
  fov: number, aspect: number, margin: number,
): number {
  const dir = new THREE.Vector3(0, 1, 0.9).normalize();
  const target = new THREE.Vector3(cx, 0, -cy);
  const corners = [
    [cx - spanX / 2, cy - spanY / 2], [cx + spanX / 2, cy - spanY / 2],
    [cx - spanX / 2, cy + spanY / 2], [cx + spanX / 2, cy + spanY / 2],
  ].map(([x, y]) => new THREE.Vector3(x, 0, -y));
  const limit = 1 / margin;
  const probe = new THREE.PerspectiveCamera(fov, aspect, 1, 500000);
  const fits = (dist: number) => {
    probe.position.copy(target.clone().add(dir.clone().multiplyScalar(dist)));
    probe.lookAt(target);
    probe.updateMatrixWorld(true);
    probe.updateProjectionMatrix();
    return corners.every(c => {
      const p = c.clone().project(probe);
      return Math.abs(p.x) <= limit && Math.abs(p.y) <= limit && p.z < 1;
    });
  };
  let lo = 200;
  let hi = Math.max(400, Math.hypot(spanX, spanY) * 8);
  if (!fits(hi)) return hi;
  for (let i = 0; i < 48; i++) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) hi = mid; else lo = mid;
  }
  return hi;
}

function SiteAreasOverlay({ cad }: { cad?: boolean }) {
  const siteAreas = useDesignStore(s => s.siteAreas);
  const activeAreaId = useDesignStore(s => s.activeAreaId);
  const generatedLabelsVisible = useDesignStore(s => s.drawingVisibility.labels);
  if (cad || siteAreas.length < 2) return null;
  return (
    <group>
      {siteAreas
        .filter(a => a.id !== activeAreaId)
        .map(a => {
          const sub = a.kind === 'substation';
          return (
            <group key={a.id}>
              {/* Lot line + fence, dimmed relative to the active area */}
              <PolyLine pts={a.boundary.polygon} color={PROPERTY_LINE_DIM_HEX} y={0.55} />
              {a.design && showSeparateFence(a.design) && (
                <PolyLine
                  pts={a.design.fence}
                  color={sub ? '#d08a2c' : '#0a7d92'}
                  y={0.55}
                  lineWidth={2}
                />
              )}
              {/* Equipment footprints as flat plates: readable at site zoom
                  without paying for full 3D bodies on every area. */}
              {a.design?.equipment.map(eq => (
                <mesh
                  key={eq.id}
                  position={[eq.x, 0.35, -eq.y]}
                  rotation={[-Math.PI / 2, 0, -eq.rotation]}
                >
                  <planeGeometry args={[eq.length, eq.width]} />
                  <meshBasicMaterial
                    color={eq.kind === 'inverter' ? '#3f8f5f' : '#5b6b86'}
                    transparent
                    opacity={0.85}
                  />
                </mesh>
              ))}
              {generatedLabelsVisible && (
                <Text
                  position={[
                    a.boundary.polygon.reduce((s, p) => s + p.x, 0) / a.boundary.polygon.length,
                    2,
                    -(a.boundary.polygon.reduce((s, p) => s + p.y, 0) / a.boundary.polygon.length),
                  ]}
                  rotation={[-Math.PI / 2, 0, 0]}
                  fontSize={38}
                  color={sub ? '#f0b45a' : '#7fd6e6'}
                  anchorX="center"
                  anchorY="middle"
                  outlineWidth={1.5}
                  outlineColor="#0b1220"
                >
                  {a.name}
                </Text>
              )}
            </group>
          );
        })}
    </group>
  );
}

function DesignContent({ design, editMode, realistic, is3D, cad, onDraggingChange, editTool, onEditToolChange, zoneKind, islandPairs, placeKind, placeAug, placeAuxGear, placeEquipType, placeAngleDeg, placeSnap, roadDrawWidth, onSelectedIslandChange, onSelectedTargetChange, onSelectedEquipChange, onRoadSelectionChange, cadLayerVis, onSelectText }: { design: SiteDesign; editMode: boolean; realistic?: boolean; is3D?: boolean; cad?: boolean; onDraggingChange: (d: boolean) => void; editTool: EditTool; onEditToolChange: (t: EditTool) => void; zoneKind: AreaZoneKind; islandPairs: number; placeKind: PlacementKind; placeAug: boolean; placeAuxGear: boolean; placeEquipType: ManualEquipmentType; placeAngleDeg: number; placeSnap: number; roadDrawWidth: number; onSelectedIslandChange?: (islandN: number | null) => void; onSelectedTargetChange?: (t: NudgeTarget | null) => void; onSelectedEquipChange?: (e: SelectedEquip | null) => void; onRoadSelectionChange?: (s: { labels: string[]; onDelete: () => void; onSpan: () => void; spanArmed: boolean; onPave?: () => void } | null) => void; cadLayerVis?: CadLayerVis; onSelectText?: (info: SelectedTextInfo | null) => void }) {
  const drawingVisibility = useDesignStore(s => s.drawingVisibility);
  const generatedLabelsVisible = drawingVisibility.labels;
  const { builtEquipment, plannedEquipment } = useMemo(
    () => partitionSceneEquipment(design.equipment, design.futureEquipment),
    [design.equipment, design.futureEquipment],
  );
  // Realistic-model LOD: true while the camera is far enough that the
  // simple boxes are indistinguishable from the GLB models.
  const [realisticFar, setRealisticFar] = useState(false);
  // Export captures force full-detail models: while a forceRealisticNear
  // lease is held, the far-LOD box swap is suppressed (the sensor keeps its
  // raw hysteresis state so the viewport snaps back correctly afterwards).
  const forceNear = useDesignStore(s => s.forceRealisticNearCount > 0);
  const realisticFarEff = realisticFar && !forceNear;
  // Commit handshake: report AFTER React committed the GLB group visibility
  // so capture flows wait on real scene state instead of a timer.
  const setRealisticDetailApplied = useDesignStore(s => s.setRealisticDetailApplied);
  useEffect(() => {
    setRealisticDetailApplied(!(realistic && realisticFarEff));
  }, [realistic, realisticFarEff, setRealisticDetailApplied]);
  const highlightIds = useDesignStore(s => s.highlightIds);
  const placingSubstation = useDesignStore(s => s.placingSubstation);
  const placeSubstation = useDesignStore(s => s.placeSubstation);
  // Multi-area take-off placement shares the ground plane as its click target.
  const placingTakeoffId = useDesignStore(s => s.placingTakeoffId);
  const moveTakeoff = useDesignStore(s => s.moveTakeoff);
  const showGateModel = useDesignStore(s => s.showGateModel);
  const showFence3D = useDesignStore(s => s.showFence3D);
  const walkMode = useDesignStore(s => s.walkMode);
  const tourActive = useDesignStore(s => s.tourActive);
  const showSatellite = useDesignStore(s => s.showSatellite);
  const satellite = useDesignStore(s => s.satellite);
  const terrain = useDesignStore(s => s.terrain);
  const boundary = useDesignStore(s => s.boundary);
  // Every area's lot line, for whole-site ground sizing. Single-area sites
  // fall back to the active boundary so framing stays byte-identical.
  const siteAreasForGround = useDesignStore(s => s.siteAreas);
  const groundAreaPolys = useMemo(
    () => (siteAreasForGround.length >= 2 ? siteAreasForGround.map(a => a.boundary.polygon) : []),
    [siteAreasForGround]
  );
  const yardRotationDeg = useDesignStore(s => s.yardRotationDeg);
  const showTerrain = useDesignStore(s => s.showTerrain);
  const showSlopeHeatmap = useDesignStore(s => s.showSlopeHeatmap);
  const maxGradePct = useDesignStore(s => s.maxGradePct);
  const showContours = useDesignStore(s => s.showContours);
  const contourIntervalFt = useDesignStore(s => s.contourIntervalFt);
  const showGradingLimits = useDesignStore(s => s.showGradingLimits);
  const gradingSlopeRatio = useDesignStore(s => s.gradingSlopeRatio);
  const showProposedContours = useDesignStore(s => s.showProposedContours);
  const showCutFillPreview = useDesignStore(s => s.showCutFillPreview);
  const showGrounding = useDesignStore(s => s.showGrounding);
  const groundingXray = useDesignStore(s => s.groundingXray);
  const groundingRodSpacingFt = useDesignStore(s => s.groundingRodSpacingFt);
  // Tour finale: the pull-up flyover forces the grounding overlay on without
  // touching the drafter's own toggle (cleared when the tour stops).
  const tourGrounding = useDesignStore(s => s.tourGrounding);
  // Grounding screening overlay (loop / rods / taps) — derived, deterministic,
  // preview-only unless the DXF export option is enabled separately.
  const groundingPlan = useMemo(
    () => (showGrounding || tourGrounding ? buildGroundingPlan(design, { rodSpacingFt: groundingRodSpacingFt }) : null),
    [showGrounding, tourGrounding, design, groundingRodSpacingFt]
  );
  // X-ray reads like the grounding sheet: bodies hidden, outlines only.
  const groundingXrayActive = !cad && groundingXray && !!groundingPlan;
  // Equipment symbols always draw from a delivered library; the ECI toggle
  // only chooses WHICH library (legacy ECI legend vs the NextEra equipment
  // GLB trace), so the scene matches whatever the DXF/PDF export will draw.
  const eciLegend = useDesignStore(s => s.eciLegend);
  const symbolSource: SymbolSource = eciLegend ? 'eci' : 'glb';
  const symbolKinds = useMemo(() => symbolKindsFor(symbolSource), [symbolSource]);
  // Yard-frame elevation grid: with a grading-optimized rotation applied the
  // scene draws in the rotated yard frame, so the relief/heatmap/contours
  // read a grid resampled into that frame. 0° is an exact identity.
  const yardPivot = useMemo(
    () => (boundary ? polygonPivot(boundary.polygon) : { x: 0, y: 0 }),
    [boundary]
  );
  const terrainYard = useMemo(() => {
    if (!terrain || !boundary || yardRotationDeg === 0) return terrain;
    return resampleGridForYardRotation(terrain, boundary.origin, yardRotationDeg, yardPivot);
  }, [terrain, boundary, yardRotationDeg, yardPivot]);
  // Terrain relief is a 3D-only drape; walk mode stays on the flat pad.
  const terrainOn = Boolean(is3D && showTerrain && terrainYard && !walkMode);
  // Pad (graded yard) elevation: the cut/fill-balancing pad from the
  // screening estimate, so the relief datum matches the summary panel.
  const padElevationFt = useMemo(() => {
    if (!terrainYard) return 0;
    const rect = terrainLocalRect(terrainYard, design.boundary.origin);
    return computeCutFill(terrainYard, rect, design.fence)?.padElevationFt ?? 0;
  }, [terrainYard, design.boundary.origin, design.fence]);
  // Proposed grading surface (opt-in): sloped/benched FG pads with balanced
  // earthwork, rendered by TerrainMesh instead of the flat pad. Pure and
  // deterministic; preview only — never affects layout math or exports.
  const gradingEnabled = useDesignStore(s => s.gradingEnabled);
  const gradingInputs = useDesignStore(s => s.gradingInputs);
  const gradingZones = useDesignStore(s => s.gradingZones);
  const fgSurface = useMemo(() => {
    if (!gradingEnabled || !terrainYard) return null;
    const rect = terrainLocalRect(terrainYard, design.boundary.origin);
    return buildFgSurface(terrainYard, rect, design.fence, gradingInputs, undefined, gradingZones);
  }, [gradingEnabled, gradingInputs, gradingZones, terrainYard, design.boundary.origin, design.fence]);
  // Drainage screening (opt-in, requires the FG surface): D8 flow paths,
  // ponding, perimeter swales and discharge hydrology. Preview only.
  const drainageEnabled = useDesignStore(s => s.drainageEnabled);
  const drainageInputs = useDesignStore(s => s.drainageInputs);
  const drainageIdf = useDesignStore(s => s.drainageIdf);
  const drainageModel = useMemo(() => {
    if (!drainageEnabled || !fgSurface || !terrainYard) return null;
    const rect = terrainLocalRect(terrainYard, design.boundary.origin);
    return buildDrainageModel(terrainYard, rect, fgSurface, drainageInputs, undefined, {
      idf: drainageIdf,
      surfaces: drainageSurfacesFromDesign(design),
    });
  }, [drainageEnabled, drainageInputs, drainageIdf, fgSurface, terrainYard, design]);
  // Trench band clip (cuts the open excavation out of the ground plane)
  const groundClip = useMemo(
    () => (is3D && design.trench ? trenchClipPlanes(design.trench).outside : undefined),
    [design.trench, is3D]
  );
  // Ground plane extent. Multi-area sites span every footprint in the shared
  // projection frame, so the plane must cover them all — sizing from the
  // active area alone leaves the others off the imagery. The imagery drape
  // requests this SAME square (siteGroundExtent drives satelliteCoverageBbox),
  // so the two always register. A single area stays origin-centered.
  const groundExtent = useMemo(() => {
    const polys = groundAreaPolys.length >= 2
      ? groundAreaPolys
      : [design.boundary.polygon];
    return siteGroundExtent(polys);
  }, [groundAreaPolys, design]);
  const groundSize = groundExtent.size;

  return (
    <>
      {/* Ground (also the click target for substation placement) */}
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        // plan (x, y) -> scene (x, -y): the plane sits under the whole site,
        // which for a multi-area import is NOT the projection origin.
        position={[groundExtent.cx, -0.25, -groundExtent.cy]}
        receiveShadow
        onPointerDown={e => {
          // scene (x, y, z) -> plan (x, -z)
          if (placingTakeoffId) {
            e.stopPropagation();
            // An invalid drop (outside the substation fence, too close to a
            // neighbour) is refused with its reason and the take-off stays
            // exactly where it was — never silently moved or dropped.
            const why = moveTakeoff(placingTakeoffId, { x: e.point.x, y: -e.point.z });
            if (why) toast.warning(why);
            return;
          }
          if (!placingSubstation) return;
          e.stopPropagation();
          const notice = placeSubstation({ x: e.point.x, y: -e.point.z });
          if (notice) toast.warning(notice);
        }}
      >
        <planeGeometry args={[groundSize, groundSize]} />
        {cad ? (
          // CAD drawing view: flat dark "model space" sheet; the plane stays
          // mounted as the substation-placement click target.
          <meshBasicMaterial color="#14171c" />
        ) : (
          <GroundMaterial groundSize={groundSize} clippingPlanes={groundClip} />
        )}
      </mesh>

      {/* CAD view: the exporter's own display list rendered as linework.
          Suspense: drei Text suspends while the font loads — without a local
          boundary the suspension climbs out of the Canvas. */}
      {cad && (
        <Suspense fallback={null}>
          <CadLinework
            design={design}
            vis={cadLayerVis}
            onSelectText={onSelectText}
            onDraggingChange={onDraggingChange}
          />
        </Suspense>
      )}

      {/* Satellite imagery drape (real aerial context for drafters). When
          terrain relief is on, the imagery drapes over the relief instead. */}
      {!cad && showSatellite && satellite && !terrainOn && (
        // The flat drape is geo-registered imagery: under a yard rotation the
        // scene draws in the yard frame (geo spun by −θ), so the drape spins
        // with it about the same pivot. Scene yaw −θrad about (pivot.x, −pivot.y)
        // maps plan rotate-by-−θ. At 0° the groups are exact no-ops.
        <group position={[yardPivot.x, 0, -yardPivot.y]}>
          <group rotation={[0, -(yardRotationDeg * Math.PI) / 180, 0]}>
            <group position={[-yardPivot.x, 0, yardPivot.y]}>
              <SatelliteDrape image={satellite} origin={design.boundary.origin} clippingPlanes={groundClip} />
            </group>
          </group>
        </group>
      )}

      {/* True-terrain relief (USGS 3DEP): displaced ground with the fenced
          yard flattened to the graded pad. Preview only — never in exports. */}
      {!cad && terrainOn && terrainYard && (
        <TerrainMesh
          grid={terrainYard}
          origin={design.boundary.origin}
          yardRotationDeg={yardRotationDeg}
          yardPivot={yardPivot}
          fence={design.fence}
          padElevationFt={padElevationFt}
          satellite={showSatellite ? satellite : null}
          showSlope={showSlopeHeatmap}
          maxGradePct={maxGradePct}
          showContours={showContours}
          contourIntervalFt={contourIntervalFt}
          showGradingLimits={showGradingLimits}
          gradingSlopeRatio={gradingSlopeRatio}
          showProposedContours={showProposedContours}
          showCutFill={showCutFillPreview}
          fg={fgSurface}
          drainage={drainageModel}
        />
      )}

      {/* Everything the imported KMZ draws (roads, DC yards, equipment
          outlines, easements, monuments, CAD text), under the generated
          design. Reference only — never exported. */}
      <ImportedDrawingLayers />

      {/* KMZ property-line fences present once in purple; inset/manual fences
          retain their separate cyan line. */}
      {!cad && <PolyLine pts={design.boundary.polygon} color={PROPERTY_LINE_HEX} y={0.6} />}
      {!cad && showSeparateFence(design) && (
        <PolyLine pts={design.fence} color="#00bbdd" y={0.6} lineWidth={3} />
      )}

      {/* Every OTHER footprint of a multi-area site, drawn dimmer than the
          area being edited so the whole project reads as one site. */}
      <SiteAreasOverlay cad={cad} />


      {/* Grounding screening overlay: engineer visualization — color-coded
          categories (loop green dashed = buried conductor convention, grid
          teal dashed, taps amber), rod markers, exothermic crossing dots
          (instanced — hundreds), and circled test wells. */}
      {!cad && groundingPlan && (
        <group>
          {(groundingPlan.loops ?? [groundingPlan.loop]).map((lp, i) => (
            <PolyLine key={`gl-${i}`} pts={lp} color="#39d353" y={0.5} lineWidth={2.5} dashed />
          ))}
          {groundingPlan.grid.map(([a, b], i) => (
            <Line
              key={`gg-${i}`}
              points={[[a.x, 0.5, -a.y], [b.x, 0.5, -b.y]]}
              color="#2dd4bf"
              lineWidth={1}
              dashed
              dashSize={3}
              gapSize={2}
            />
          ))}
          {groundingPlan.taps.map((t, i) => (
            <Line
              key={`gt-${t.equipId}-${i}`}
              points={[[t.from.x, 0.5, -t.from.y], [t.to.x, 0.5, -t.to.y]]}
              color="#fbbf24"
              lineWidth={1.5}
            />
          ))}
          {groundingPlan.rods.map((rod, i) => (
            <mesh key={`gr-${i}`} position={[rod.x, 0.6, -rod.y]}>
              <cylinderGeometry args={[1.2, 1.2, 1.2, 12]} />
              <meshStandardMaterial color="#39d353" emissive="#1f7a33" emissiveIntensity={0.5} />
            </mesh>
          ))}
          <GroundingCrossingDots pts={groundingPlan.crossings} />
          {groundingPlan.testWells.map((w, i) => (
            <mesh key={`gw-${i}`} position={[w.x, 0.62, -w.y]} rotation={[-Math.PI / 2, 0, 0]}>
              <ringGeometry args={[2.4, 3.2, 24]} />
              <meshBasicMaterial color="#a3e635" side={THREE.DoubleSide} />
            </mesh>
          ))}
        </group>
      )}

      {/* Grounding X-ray: equipment bodies hidden above — draw footprint
          outlines so the buried grid reads like the grounding sheet. */}
      {groundingXrayActive && builtEquipment.map(eq => {
        const c = Math.cos(eq.rotation), s = Math.sin(eq.rotation);
        const hl = eq.length / 2, hw = eq.width / 2;
        const corners: { x: number; y: number }[] = [
          { x: eq.x + c * -hl - s * -hw, y: eq.y + s * -hl + c * -hw },
          { x: eq.x + c * hl - s * -hw, y: eq.y + s * hl + c * -hw },
          { x: eq.x + c * hl - s * hw, y: eq.y + s * hl + c * hw },
          { x: eq.x + c * -hl - s * hw, y: eq.y + s * -hl + c * hw },
        ];
        return <PolyLine key={`gx-${eq.id}`} pts={corners} color="#64748b" y={0.45} lineWidth={1} />;
      })}

      {/* Fence (3D view only): the uploaded wire-fence model instanced along
          an ordinary inset fence line (option), or the classic translucent
          thin walls. A KMZ property-line fence stays the single purple
          perimeter above instead of adding coincident fence geometry. */}
      {showSeparateFence(design) && is3D && showFence3D ? (
        <Suspense fallback={null}>
          <FencePanels fence={design.fence} gate={design.gate} />
        </Suspense>
      ) : showSeparateFence(design) && is3D ? (
        design.fence.map((p, i) => {
          const q = design.fence[(i + 1) % design.fence.length];
          const len = Math.hypot(q.x - p.x, q.y - p.y);
          const ang = Math.atan2(-(q.y - p.y), q.x - p.x);
          return (
            <mesh key={`f${i}`} position={[(p.x + q.x) / 2, 4, -(p.y + q.y) / 2]} rotation={[0, -ang, 0]}>
              <boxGeometry args={[len, 8, 0.3]} />
              <meshStandardMaterial color="#9fb6bd" transparent opacity={0.35} />
            </mesh>
          );
        })
      ) : null}

      {/* Crushed-rock yard surfacing (under the roads); trench cut-through
          only applies in 3D (2D shows the flat blue trench band instead) */}
      {!cad && design.surfacing && <SurfacingMesh surfacing={design.surfacing} trench={is3D ? design.trench : null} />}

      {/* Connected road network (perimeter + aisles, filleted per sheet 10) */}
      {!cad && design.roadNetwork && <RoadNetworkMesh road={design.roadNetwork} trench={is3D ? design.trench : null} />}

      {/* Road width + turning radius callouts, same anchors as the DXF */}
      {!cad && generatedLabelsVisible && drawingVisibility.dimensions && design.roadNetwork && <RoadCalloutLabels road={design.roadNetwork} />}

      {/* Entrance road */}
      {!cad && design.roads.map((rd, i) => (
        <EntranceRoadMesh key={`r${i}`} rd={rd} trench={is3D ? design.trench : null} />
      ))}

      {/* Reserved areas: construction laydown (yellow) + future BESS block
          footprints (neutral black/white per the issued 90% reference),
          translucent fill + outline + label */}
      {!cad && design.reservedZones.map(z => {
        const col = z.kind === 'laydown' ? '#eab308' : '#e5e7eb';
        const l = z.length / 2, w = z.width / 2;
        // Zone rotation: arbitrary angleDeg in degrees CCW (world frame).
        const zθ = ((z.angleDeg ?? 0) * Math.PI) / 180;
        const zc = Math.cos(zθ), zs = Math.sin(zθ);
        // Map a local (lx, ly) point to world THREE.Vector3 at ground height h.
        const toV3 = (lx: number, ly: number, h: number) =>
          new THREE.Vector3(z.x + lx * zc - ly * zs, h, -(z.y + lx * zs + ly * zc));
        // Future zones read as FUTURE via a transparent diagonal-hatch mesh
        // on the ground (matches the issued 90% package convention for
        // reserved areas), not just a flat tint.
        const hatchPts: THREE.Vector3[][] = [];
        if (z.kind === 'futureAug') {
          // Cross-hatch MESH (both 45- and 135-deg families) matching the
          // ANSI37 pattern the DXF/CAD/PDF outputs use for future
          // augmentation areas (issued 90% package convention).
          // Hatch is computed in the zone's LOCAL frame then mapped to world
          // via toV3, so it always covers the actual rotated footprint.
          const spacing = Math.max(4, Math.min(z.length, z.width) / 6);
          for (const dir of [1, -1] as const) {
            for (let c = -(l + w); c <= l + w; c += spacing) {
              // Line x - dir*y' = c clipped to the local rect [-l,l]x[-w,w]
              const pts: [number, number][] = [];
              const tryPt = (x: number, yy: number) => {
                if (x >= -l - 1e-6 && x <= l + 1e-6 && yy >= -w - 1e-6 && yy <= w + 1e-6) pts.push([x, yy]);
              };
              tryPt(-l, dir * (-l - c)); tryPt(l, dir * (l - c)); tryPt(c + dir * -w, -w); tryPt(c + dir * w, w);
              if (pts.length >= 2) {
                const [a, b] = pts;
                hatchPts.push([toV3(a[0], a[1], 0.2), toV3(b[0], b[1], 0.2)]);
              }
            }
          }
        }
        // Title runs along the zone's long axis and shrinks to fit inside
        // its own rect, so adjacent islands' titles can never collide.
        const localVertical = z.width > z.length;
        const alongFt = (localVertical ? z.width : z.length) * 0.85;
        const labelSize = Math.min(10, Math.max(1.5, alongFt / (z.label.length * 0.62)));
        // Label Y-rotation in the horizontal plane: zone angle + 90° if the
        // long axis is local Y (so text always reads along the strip).
        const labelRot = zθ + (localVertical ? Math.PI / 2 : 0);
        // Rotated outline: four corners in local frame mapped to world.
        const outlinePts = [
          toV3(-l, -w, 0.45), toV3( l, -w, 0.45),
          toV3( l,  w, 0.45), toV3(-l,  w, 0.45),
          toV3(-l, -w, 0.45),
        ];
        return (
          <group key={z.id}>
            {/* Fill: group rotates around world +Y (unambiguous ground-plane yaw),
                child mesh flattens the plane via Rx(-PI/2). This guarantees the
                fill is always co-planar with the site regardless of zθ. */}
            <group position={[z.x, 0.12, -z.y]} rotation={[0, zθ, 0]}>
              <mesh rotation={[-Math.PI / 2, 0, 0]}>
                <planeGeometry args={[z.length, z.width]} />
                <meshStandardMaterial color={col} transparent opacity={z.kind === 'futureAug' ? 0.14 : 0.25} />
              </mesh>
            </group>
            {hatchPts.map((seg, i) => (
              <Line key={`hz-${i}`} points={seg} color={col} lineWidth={1} transparent opacity={0.55} />
            ))}
            <Line
              points={outlinePts}
              color={col}
              lineWidth={2}
              dashed
              dashSize={6}
              gapSize={4}
            />
            {generatedLabelsVisible && (
              <Text
                position={[z.x, 1.5, -z.y]}
                rotation={[-Math.PI / 2, 0, labelRot]}
                fontSize={labelSize}
                color={col}
                anchorX="center"
                anchorY="middle"
              >
                {z.label}
              </Text>
            )}
          </group>
        );
      })}

      {/* Entrance gate: bar across fence opening, matching DXF gate line;
          gate line stays, the uploaded 3D model replaces the bar (option) */}
      {!cad && design.gate && (() => {
        const g = design.gate;
        const hw = g.width / 2;
        const cos = Math.cos(g.rotation), sin = Math.sin(g.rotation);
        return (
          <group>
            <Line
              points={[
                new THREE.Vector3(g.x - hw * cos, 1, -(g.y - hw * sin)),
                new THREE.Vector3(g.x + hw * cos, 1, -(g.y + hw * sin)),
              ]}
              color="#ffcc00"
              lineWidth={4}
            />
            {is3D && (showGateModel || walkMode || tourActive) ? (
              <Suspense fallback={null}>
                {/* Gate swings open for the walkthrough AND the cinematic
                    tour — the tour camera flies through the opening. */}
                <GateModel gate={g} open={walkMode || tourActive} />
              </Suspense>
            ) : is3D ? (
              // yaw = +g.rotation: scene rotation.y = th maps local +X to
              // plan (cos th, sin th) — same sign convention as GateModel
              <mesh position={[g.x, 3, -g.y]} rotation={[0, g.rotation, 0]}>
                <boxGeometry args={[g.width, 6, 0.5]} />
                <meshStandardMaterial color="#ffcc00" transparent opacity={0.6} />
              </mesh>
            ) : null}
          </group>
        );
      })()}

      {/* 480V aux + fiber trench: translucent blue surface band (plan color
          code) over a real 3-ft-deep excavated channel with cable conductors */}
      {!cad && design.trench && (
        <>
          <mesh
            position={[design.trench.x, 0.15, -(design.trench.yBottom + design.trench.yTop) / 2]}
            rotation={[-Math.PI / 2, 0, 0]}
          >
            <planeGeometry args={[design.trench.width, design.trench.yTop - design.trench.yBottom]} />
            <meshStandardMaterial color="#1f3fbf" transparent opacity={0.25} depthWrite={false} />
          </mesh>
          {is3D && <TrenchChannel trench={design.trench} />}
        </>
      )}

      {/* Per-island 480V aux & fiber corridor trench bands (mirrored-pair
          layouts): flat marked bands along each island centerline.
          For placed islands at arbitrary angles, `cx/cy/angleDeg/length` give
          the exact oriented spine; the parent group rotates around world +Y
          (unambiguous ground-plane yaw), the child mesh flattens via Rx. */}
      {!cad && (drawingVisibility.fiber || drawingVisibility.auxiliaryCables) && (design.corridorTrenches ?? []).map(c => {
        const cθ = ((c.angleDeg ?? (c.vertical ? 90 : 0)) * Math.PI) / 180;
        const cx3 = c.cx ?? (c.vertical ? c.y : (c.minX + c.maxX) / 2);
        const cy3 = c.cy ?? (c.vertical ? (c.minX + c.maxX) / 2 : c.y);
        const cLen = c.length ?? (c.vertical ? c.maxX - c.minX : c.maxX - c.minX);
        return (
          <group
            key={`corridor-trench-${c.islandN}`}
            position={[cx3, 0.15, -cy3]}
            rotation={[0, cθ, 0]}
          >
            <mesh rotation={[-Math.PI / 2, 0, 0]}>
              <planeGeometry args={[cLen, c.width]} />
              <meshStandardMaterial color="#1f3fbf" transparent opacity={0.25} depthWrite={false} />
            </mesh>
          </group>
        );
      })}

      {/* Island alignment indicators: amber outlines around islands that have
          an "Island alignment available:" warning, so the drafter can see
          which island is off the shared column line before deciding.
          Disappears once alignIslands is enabled or all islands are aligned. */}
      {!cad && <IslandAlignmentIndicators design={design} />}

      {/* Cable runs use persisted design geometry except for the tour's
          presentation-only DC reroute beat. */}
      {!cad && <TourSwapCableRuns design={design} />}
      {/* Fly-along island hold: ghost outlines of the future-upgrade PCS. */}
      {!cad && <TourFutureGhosts />}

      {/* Substation point + MV feeder circuits */}
      {!cad && <SubstationAndFeeders />}
      {/* Multi-area: MV take-off positions inside every substation yard */}
      {!cad && <TakeoffMarkers />}
      {is3D && <FeederTrenches />}
      {is3D && <AuxFeederTrenches />}
      {is3D && <CableTrenches />}

      {/* Equipment: instanced boxes (constant draw calls at any site
          size); highlighted items render classic for the emissive + ring
          treatment; labels batch into one culling loop. Grounding X-ray
          hides the bodies (footprint outlines render with the overlay). */}
      {!cad && !groundingXrayActive && <InstancedEquipment
        equipment={
          highlightIds.length
            ? builtEquipment.filter(eq => !highlightIds.includes(eq.id))
            : builtEquipment
        }
        hideBodyKinds={
          realistic && !realisticFarEff ? REALISTIC_KINDS
          : !is3D ? symbolKinds
          : undefined
        }
      />}
      {/* Delivered equipment symbols: replace boxes in 2D, decal box tops in
          3D (realistic GLBs keep their own detail — no decals over models). */}
      {!cad && !groundingXrayActive && !(realistic && !realisticFarEff) && (
        <EciSymbolOverlay equipment={builtEquipment} is3D={is3D} source={symbolSource} />
      )}
      {/* Realistic models render in CAD view too (the Realistic button
          promises "3D and CAD"): GLBs sit on top of the drawing linework.
          Simple boxes never render in CAD — plain CAD stays pure linework. */}
      {realistic && !groundingXrayActive && (
        <Suspense fallback={null}>
          <RealisticLodSensor design={design} far={realisticFar} onChange={setRealisticFar} />
          {/* Far LOD hides (but keeps mounted) the models so zooming back
              in never re-parses the GLBs or re-uploads GPU buffers. */}
          <group visible={!realisticFarEff}>
            <RealisticEquipment
              equipment={
                highlightIds.length
                  ? builtEquipment.filter(eq => !highlightIds.includes(eq.id))
                  : builtEquipment
              }
            />
          </group>
        </Suspense>
      )}
      {highlightIds.length > 0 &&
        builtEquipment
          .filter(eq => highlightIds.includes(eq.id))
          .map(eq => <EquipmentBox key={eq.id} eq={eq} showLabels={false} highlighted
            symbolBody={!is3D && !(realistic && !realisticFarEff) && symbolKinds.has(eq.kind)} />)}

      {/* Future augmentation units: ghosted equipment (2 PCS + 6 BESS per
          unit). Real instanced models with a fade material in realistic
          mode; translucent neutral boxes otherwise (and at far LOD). */}
      {plannedEquipment.length > 0 && realistic && (
        <Suspense fallback={null}>
          <group visible={!realisticFarEff}>
            <RealisticEquipment equipment={plannedEquipment} ghost />
          </group>
        </Suspense>
      )}
      {!cad && plannedEquipment.length > 0 && (!realistic || realisticFarEff) &&
        plannedEquipment.map(eq => (
          <mesh key={eq.id} position={[eq.x, eq.height / 2, -eq.y]} rotation={[0, eq.rotation, 0]}>
            <boxGeometry args={[eq.length, eq.height, eq.width]} />
            <meshStandardMaterial color="#e5e7eb" transparent opacity={0.28} depthWrite={false} />
          </mesh>
        ))}
      {!cad && generatedLabelsVisible && <EquipLabels equipment={builtEquipment} cables={design.cables} />}

      {/* Layout edit mode: draggable rows + trench */}
      {!cad && <AreaZonesOverlay />}
      {editMode && <LayoutEditLayer design={design} onDraggingChange={onDraggingChange} tool={editTool} onToolChange={onEditToolChange} zoneKind={zoneKind} islandPairs={islandPairs} placeKind={placeKind} placeAug={placeAug} placeAuxGear={placeAuxGear} placeEquipType={placeEquipType} placeAngleDeg={placeAngleDeg} placeSnap={placeSnap} roadDrawWidth={roadDrawWidth} fgSurface={fgSurface} terrainYard={terrainYard} onSelectedIslandChange={onSelectedIslandChange} onSelectedTargetChange={onSelectedTargetChange} onSelectedEquipChange={onSelectedEquipChange} onRoadSelectionChange={onRoadSelectionChange} />}
    </>
  );
}

// One-click "inspect trench" camera preset: flies the perspective camera to a
// low oblique close-up of the 480V aux + fiber trench band so the recessed
// channel and the blue LVAC / orange fiber conductors are visible. 3D preview
// only — no effect on layout or exports.
function TrenchFlyCamera({ trench }: { trench: NonNullable<SiteDesign['trench']> }) {
  const camera = useThree(s => s.camera);
  const controls = useThree(s => s.controls) as any;
  const invalidate = useThree(s => s.invalidate);
  const request = useDesignStore(s => s.inspectTrenchRequest);
  const markHandled = useDesignStore(s => s.markInspectTrenchHandled);
  const flight = useRef<{
    t: number;
    fromPos: THREE.Vector3;
    fromTarget: THREE.Vector3;
    toPos: THREE.Vector3;
    toTarget: THREE.Vector3;
  } | null>(null);

  useEffect(() => {
    const handled = useDesignStore.getState().inspectTrenchHandled;
    if (request <= handled || !controls) return;
    markHandled(request);
    // Focus a point a short way up the trench from its south end, looking
    // north along the channel from a low, slightly offset vantage.
    const span = trench.yTop - trench.yBottom;
    const yFocus = trench.yBottom + Math.min(60, span * 0.35);
    const toTarget = new THREE.Vector3(trench.x, -TRENCH_DEPTH_FT / 2, -yFocus);
    const toPos = new THREE.Vector3(
      trench.x + trench.width / 2 + 28,
      16,
      -(yFocus - 55)
    );
    // Non-finite flight endpoints would NaN the camera matrix mid-flight
    // (NaN clipping uniforms -> renderer throws every frame). Skip instead.
    if (![...toPos.toArray(), ...toTarget.toArray()].every(Number.isFinite)) {
      console.warn('inspect-trench flight ignored: non-finite endpoint', { toPos, toTarget });
      return;
    }
    flight.current = {
      t: 0,
      fromPos: camera.position.clone(),
      fromTarget: controls.target.clone(),
      toPos,
      toTarget,
    };
    invalidate(); // demand frameloop: kick off the first flight frame
  }, [request, controls, camera, trench, markHandled, invalidate]);

  // Cancel the flight the moment the drafter grabs the controls (orbit/pan/
  // zoom) so the animation stops fighting their input.
  useEffect(() => {
    if (!controls?.addEventListener) return;
    const cancel = () => { flight.current = null; };
    controls.addEventListener('start', cancel);
    return () => controls.removeEventListener('start', cancel);
  }, [controls]);

  useFrame((st, delta) => {
    const f = flight.current;
    if (!f || !controls) return;
    f.t = Math.min(1, f.t + delta / 1.4);
    const k = f.t * f.t * (3 - 2 * f.t); // smoothstep ease
    camera.position.lerpVectors(f.fromPos, f.toPos, k);
    controls.target.lerpVectors(f.fromTarget, f.toTarget, k);
    controls.update();
    if (f.t >= 1) flight.current = null;
    else st.invalidate(); // demand frameloop: keep the flight animating
  });

  return null;
}

// Explicit camera pose request (scene coords), used by visual regression
// scripts to frame arbitrary spots — e.g. a feeder trench crossing a road —
// that no built-in preset covers. Applies the pose instantly (no flight):
// deterministic for screenshot tooling. 3D preview only.
// Hi-fi cover capture (3D preview only): renders the CURRENT scene into an
// offscreen render target with bespoke cameras — a plan-registered top-down
// orthographic shot spanning exactly the requested localRect, plus a
// perspective "hero" beauty shot — and posts JPEG data URLs back to the
// store. Never touches the user's camera, controls, or canvas framing.
function CoverRenderCapture() {
  const gl = useThree(s => s.gl);
  const scene = useThree(s => s.scene);
  const req = useDesignStore(s => s.coverCaptureRequest);
  useEffect(() => {
    const setReady = useDesignStore.getState().setCoverCaptureReady;
    setReady(true);
    return () => setReady(false);
  }, []);
  useEffect(() => {
    if (!req) return;
    const post = useDesignStore.getState().postCoverCaptureResult;
    const shot = (cam: THREE.Camera, wPx: number, hPx: number, supersample = 1) => {
      // Supersampled path (hiRes site render): render at supersample x the
      // output size, then downscale in the 2D canvas — cheap SSAA on top of
      // the MSAA target. Clamped to the GPU texture limit so a huge parcel
      // never fails the capture outright.
      const maxTex = gl.capabilities.maxTextureSize || 4096;
      let rw = wPx * supersample, rh = hPx * supersample;
      if (rw > maxTex || rh > maxTex) {
        const k = Math.min(maxTex / rw, maxTex / rh);
        rw = Math.floor(rw * k); rh = Math.floor(rh * k);
      }
      const rt = new THREE.WebGLRenderTarget(rw, rh, { samples: 4 });
      rt.texture.colorSpace = THREE.SRGBColorSpace;
      const prevRt = gl.getRenderTarget();
      try {
        gl.setRenderTarget(rt);
        gl.render(scene, cam);
        const buf = new Uint8Array(rw * rh * 4);
        gl.readRenderTargetPixels(rt, 0, 0, rw, rh, buf);
        const cnv = document.createElement('canvas');
        cnv.width = rw; cnv.height = rh;
        const ctx2d = cnv.getContext('2d')!;
        const img = ctx2d.createImageData(rw, rh);
        // GL rows are bottom-up; flip vertically into the 2D canvas.
        for (let y = 0; y < rh; y++) {
          img.data.set(buf.subarray((rh - 1 - y) * rw * 4, (rh - y) * rw * 4), y * rw * 4);
        }
        ctx2d.putImageData(img, 0, 0);
        if (supersample > 1 && (rw !== wPx || rh !== hPx)) {
          const out = document.createElement('canvas');
          // Keep the render's (possibly clamped) aspect when downscaling.
          const s = Math.min(wPx / rw, hPx / rh);
          out.width = Math.max(64, Math.round(rw * s));
          out.height = Math.max(64, Math.round(rh * s));
          const octx = out.getContext('2d')!;
          octx.imageSmoothingEnabled = true;
          octx.imageSmoothingQuality = 'high';
          octx.drawImage(cnv, 0, 0, out.width, out.height);
          return { dataUrl: out.toDataURL('image/jpeg', 0.92), widthPx: out.width, heightPx: out.height };
        }
        return { dataUrl: cnv.toDataURL('image/jpeg', 0.92), widthPx: rw, heightPx: rh };
      } finally {
        gl.setRenderTarget(prevRt);
        rt.dispose();
      }
    };
    // Optional per-image label removal: equipment label groups are tagged
    // userData.equipLabel; hide them for the duration of a single shot and
    // restore each group's prior visibility (distance culling may have some
    // hidden already) so the live scene is untouched.
    const shotWithLabels = (hide: boolean | undefined, fn: () => ReturnType<typeof shot>) => {
      if (!hide) return fn();
      const hidden: { obj: THREE.Object3D; visible: boolean }[] = [];
      scene.traverse(o => { if (o.userData?.equipLabel) hidden.push({ obj: o, visible: o.visible }); });
      try {
        for (const h2 of hidden) h2.obj.visible = false;
        return fn();
      } finally {
        for (const h2 of hidden) h2.obj.visible = h2.visible;
      }
    };
    try {
      const lr = req.localRect;
      const w = lr.maxX - lr.minX, h = lr.maxY - lr.minY;
      if (!(w > 0) || !(h > 0)) throw new Error('degenerate localRect');
      // Top-down: ortho camera spanning exactly localRect (plan registered;
      // scene x = local ft x, scene z = -local ft y per yard convention).
      // hiRes (10% Package site-render page): bigger output cap + 2x
      // supersample, downscaled in-canvas. Standard cover capture unchanged.
      const MAXPX = req.hiRes ? 4000 : 2600;
      const s = Math.min(MAXPX / w, MAXPX / h);
      const wPx = Math.max(64, Math.round(w * s));
      const hPx = Math.max(64, Math.round(h * s));
      const cx = (lr.minX + lr.maxX) / 2, cy = (lr.minY + lr.maxY) / 2;
      const ortho = new THREE.OrthographicCamera(-w / 2, w / 2, h / 2, -h / 2, 1, 10000);
      ortho.position.set(cx, 3000, -cy);
      ortho.up.set(0, 0, -1);
      ortho.lookAt(cx, 0, -cy);
      ortho.updateMatrixWorld(true);
      const topDown = shotWithLabels(req.hideLabels?.topDown, () => shot(ortho, wPx, hPx, req.hiRes ? 2 : 1));
      if (req.hiRes) {
        // Site-render capture: top-down only; skip the hero shot.
        post({ n: req.n, topDown, hero: null });
        return;
      }
      // Hero: perspective 3/4 view from the south-west, framing the yard.
      // Captured at the cover model-panel's native aspect (COVER10_PANEL_ASPECT)
      // so the render fills the panel frame edge-to-edge with zero letterbox —
      // exactly like the vicinity/aerial panels. The vertical FOV is widened so
      // the HORIZONTAL field of view matches the legacy 40°@16:10 framing (the
      // yard fills the width the same; the taller frame gains sky/foreground).
      const span = Math.max(w, h);
      const heroAspect = COVER10_PANEL_ASPECT;
      const legacyHalfH = Math.tan((40 * Math.PI) / 360) * (16 / 10);
      const fovDeg = (2 * Math.atan(legacyHalfH / heroAspect) * 180) / Math.PI;
      const persp = new THREE.PerspectiveCamera(fovDeg, heroAspect, 1, 50000);
      const d = span * 0.85;
      persp.position.set(cx - d * 0.6, d * 0.55, -cy + d * 0.6);
      persp.lookAt(cx, 0, -cy);
      persp.updateMatrixWorld(true);
      const heroH = 1600;
      const heroW = Math.max(64, Math.round(heroH * heroAspect));
      // Cover shot prints on a white sheet next to the vicinity/aerial
      // panels: swap the blue viewport sky for a neutral light gray for the
      // duration of the capture (restored after) so the panel doesn't read
      // as a blue-highlighted block on the printed cover.
      const prevBg = scene.background;
      let hero: ReturnType<typeof shot>;
      try {
        scene.background = new THREE.Color('#e8eaec');
        hero = shotWithLabels(req.hideLabels?.hero, () => shot(persp, heroW, heroH));
      } finally {
        scene.background = prevBg;
      }
      post({ n: req.n, topDown, hero });
    } catch (e) {
      console.warn('CoverRenderCapture failed:', e);
      post({ n: req.n, topDown: null, hero: null });
    }
  }, [req, gl, scene]);
  return null;
}

function PoseCamera() {
  const camera = useThree(s => s.camera);
  const controls = useThree(s => s.controls) as any;
  const invalidate = useThree(s => s.invalidate);
  const req = useDesignStore(s => s.cameraPoseRequest);
  const markHandled = useDesignStore(s => s.markCameraPoseHandled);
  // Test-tooling hook: visual regression scripts cross-check framing by
  // projecting the intended world point through the live camera (a capture
  // that frames the wrong spot must fail loudly, not just "sometimes").
  useEffect(() => {
    (window as any).__sceneCamera = camera;
  }, [camera]);
  useEffect(() => {
    if (!req || !controls) return;
    const handled = useDesignStore.getState().cameraPoseHandled;
    if (req.n <= handled) return;
    markHandled(req.n);
    // Defense in depth (see requestCameraPose): a non-finite pose would NaN
    // the view matrix -> NaN clipping-plane uniforms -> three.js throws
    // "firstElem.toArray is not a function" every frame (blank canvas).
    if (![...req.pos, ...req.target].every(Number.isFinite)) {
      console.warn('PoseCamera: ignoring non-finite pose request', req);
      return;
    }
    camera.position.set(req.pos[0], req.pos[1], req.pos[2]);
    controls.target.set(req.target[0], req.target[1], req.target[2]);
    controls.update();
    invalidate(); // demand frameloop: paint the new pose
  }, [req, controls, camera, markHandled, invalidate]);
  return null;
}

function OrthoPoseCamera() {
  const camera = useThree(s => s.camera) as THREE.OrthographicCamera;
  const controls = useThree(s => s.controls) as any;
  const invalidate = useThree(s => s.invalidate);
  const req = useDesignStore(s => s.orthoCameraPoseRequest);
  const markHandled = useDesignStore(s => s.markOrthoCameraPoseHandled);
  useEffect(() => {
    if (!req || !controls || !camera.isOrthographicCamera ||
      req.n <= useDesignStore.getState().orthoCameraPoseHandled) return;
    markHandled(req.n);
    camera.zoom = req.zoom;
    camera.updateProjectionMatrix();
    controls.target.set(...req.target);
    // Keep the top-down lens directly over the new target.
    camera.position.set(req.target[0], camera.position.y, req.target[2]);
    controls.update();
    invalidate();
  }, [req, controls, camera, markHandled, invalidate]);
  return null;
}

// Multi-area sites only: fit the whole-site envelope using the REAL camera
// aspect. The initial-pose memo runs outside the Canvas and can only guess
// with window.innerWidth, but the control panel takes ~384px, so a wide site
// framed against the window aspect pushes its outer footprints off-screen.
// Runs once per envelope change (siteBoundsSig), never for single-boundary
// sites, and defers to any explicit camera pose the drafter/test requested.
function SiteFitCamera({ sig, bounds }: {
  sig: string;
  bounds: { cx: number; cy: number; spanX: number; spanY: number };
}) {
  const camera = useThree(s => s.camera);
  const controls = useThree(s => s.controls) as any;
  const invalidate = useThree(s => s.invalidate);
  useEffect(() => {
    if (!sig || !controls) return;
    const persp = camera as THREE.PerspectiveCamera;
    if (!persp.isPerspectiveCamera) return;
    // Deliberately NOT latched to "apply once": whenever the bounds memo
    // produces a new object R3F re-applies the PerspectiveCamera position
    // prop (computed outside the Canvas against the window aspect) and yanks
    // the camera off the fitted pose. Re-running on the same narrow deps as
    // that re-application is what keeps the whole site framed.
    const dist = groundRectFitDistance(
      bounds.cx, bounds.cy, bounds.spanX, bounds.spanY,
      persp.fov ?? 45, persp.aspect ?? 1, 1.15,
    );
    const target = new THREE.Vector3(bounds.cx, 0, -bounds.cy);
    const pos = target.clone().add(new THREE.Vector3(0, 1, 0.9).normalize().multiplyScalar(dist));
    if (![...pos.toArray(), ...target.toArray()].every(Number.isFinite)) return;
    camera.position.copy(pos);
    controls.target.copy(target);
    controls.update();
    invalidate(); // demand frameloop: paint the fitted pose
  }, [sig, bounds, camera, controls, invalidate]);
  return null;
}

// Frames the ACTIVE area whenever the drafter switches which area is being
// edited. Mounted for every navigable view: the perspective views refit like
// SiteFitCamera; the 2D plan view refits the orthographic zoom instead.
function ActiveAreaFitCamera({ sig, viewMode }: { sig: string; viewMode: '3d' | '2d' | 'cad' }) {
  const camera = useThree(s => s.camera);
  const controls = useThree(s => s.controls) as any;
  const invalidate = useThree(s => s.invalidate);
  const size = useThree(s => s.size);
  useEffect(() => {
    if (!sig || !controls) return;
    const nums = (sig.split('|')[1] ?? '').split(',').map(Number);
    const [cx, cy, spanX, spanY] = nums;
    if (!nums.every(Number.isFinite) || nums.length !== 4) return;
    const target = new THREE.Vector3(cx, 0, -cy);
    const ortho = camera as THREE.OrthographicCamera;
    if (ortho.isOrthographicCamera) {
      camera.position.set(cx, camera.position.y, -cy);
      ortho.zoom = Math.max(1e-6, Math.min(
        size.width / (spanX * 1.15), size.height / (spanY * 1.15)));
      ortho.updateProjectionMatrix();
    } else {
      const persp = camera as THREE.PerspectiveCamera;
      const dist = groundRectFitDistance(cx, cy, spanX, spanY,
        persp.fov ?? 45, persp.aspect ?? 1, 1.15);
      const pos = target.clone().add(new THREE.Vector3(0, 1, 0.9).normalize().multiplyScalar(dist));
      if (![...pos.toArray(), ...target.toArray()].every(Number.isFinite)) return;
      camera.position.copy(pos);
    }
    controls.target.copy(target);
    controls.update();
    invalidate(); // demand frameloop: paint the fitted pose
  }, [sig, viewMode, camera, controls, invalidate, size]);
  return null;
}

// One-click "overview" camera preset: flies the perspective camera back to the
// default full-site vantage (whole parcel in view), completing the navigation
// loop after a trench close-up. 3D preview only — no effect on layout/exports.
function OverviewFlyCamera({ bounds }: { bounds: { cx: number; cy: number; spanX: number; spanY: number } }) {
  const camera = useThree(s => s.camera);
  const controls = useThree(s => s.controls) as any;
  const invalidate = useThree(s => s.invalidate);
  const request = useDesignStore(s => s.overviewRequest);
  const markHandled = useDesignStore(s => s.markOverviewHandled);
  const flight = useRef<{
    t: number;
    fromPos: THREE.Vector3;
    fromTarget: THREE.Vector3;
    toPos: THREE.Vector3;
    toTarget: THREE.Vector3;
  } | null>(null);

  useEffect(() => {
    const handled = useDesignStore.getState().overviewHandled;
    if (request <= handled || !controls) return;
    markHandled(request);
    // Fit the boundary bounding box: aim at its center and back off just far
    // enough that both spans fit in the frustum with a small margin, so
    // stretched or off-center parcels frame tightly instead of half-cropped.
    const persp = camera as THREE.PerspectiveCamera;
    const vHalf = ((persp.fov ?? 45) * Math.PI / 180) / 2;
    const hHalf = Math.atan(Math.tan(vHalf) * (persp.aspect ?? 1));
    const margin = 1.15;
    const distV = (bounds.spanY / 2) * margin / Math.tan(vHalf);
    const distH = (bounds.spanX / 2) * margin / Math.tan(hHalf);
    const dist = Math.max(distV, distH, 200);
    // Plan (x, y) maps to scene (x, elev, -y); keep the default tilt (0, 1, 0.9).
    const toTarget = new THREE.Vector3(bounds.cx, 0, -bounds.cy);
    const toPos = toTarget.clone().add(
      new THREE.Vector3(0, 1, 0.9).normalize().multiplyScalar(dist)
    );
    // Same guard as the inspect-trench flight: never fly to a NaN pose.
    if (![...toPos.toArray(), ...toTarget.toArray()].every(Number.isFinite)) {
      console.warn('overview flight ignored: non-finite endpoint', { toPos, toTarget });
      return;
    }
    flight.current = {
      t: 0,
      fromPos: camera.position.clone(),
      fromTarget: controls.target.clone(),
      toPos,
      toTarget,
    };
    invalidate(); // demand frameloop: kick off the first flight frame
  }, [request, controls, camera, bounds, markHandled, invalidate]);

  // Cancel the flight the moment the drafter grabs the controls (orbit/pan/
  // zoom) so the animation stops fighting their input — same behavior as the
  // trench inspect flight.
  useEffect(() => {
    if (!controls?.addEventListener) return;
    const cancel = () => { flight.current = null; };
    controls.addEventListener('start', cancel);
    return () => controls.removeEventListener('start', cancel);
  }, [controls]);

  useFrame((st, delta) => {
    const f = flight.current;
    if (!f || !controls) return;
    f.t = Math.min(1, f.t + delta / 1.4);
    const k = f.t * f.t * (3 - 2 * f.t); // smoothstep ease
    camera.position.lerpVectors(f.fromPos, f.toPos, k);
    controls.target.lerpVectors(f.fromTarget, f.toTarget, k);
    controls.update();
    if (f.t >= 1) flight.current = null;
    else st.invalidate(); // demand frameloop: keep the flight animating
  });

  return null;
}

// Drag-time render budget: while a drag is active, cap the pixel ratio at 1
// (a 300MW parcel at retina DPR is the single biggest fill-rate cost) and
// freeze shadow-map updates (the 2048² directional shadow re-renders the
// whole instanced yard every frame otherwise). Both restore on release with
// a forced shadow refresh + invalidate, so the idle scene is pixel-identical
// to before and exports (DXF/PDF, which never read the WebGL canvas) are
// untouched.
function DragPerformance({ active }: { active: boolean }) {
  const gl = useThree(s => s.gl);
  const setDpr = useThree(s => s.setDpr);
  const invalidate = useThree(s => s.invalidate);
  useEffect(() => {
    if (!active) return;
    const baseDpr = gl.getPixelRatio();
    if (baseDpr > 1) setDpr(1);
    gl.shadowMap.autoUpdate = false;
    return () => {
      if (baseDpr > 1) setDpr(baseDpr);
      gl.shadowMap.autoUpdate = true;
      gl.shadowMap.needsUpdate = true;
      invalidate();
    };
  }, [active, gl, setDpr, invalidate]);
  return null;
}

// Catches the throw from WebGLRenderer construction when the browser cannot
// create a WebGL context (GPU process hiccup, tab restored after sleep, too
// many live contexts, driver issues). Without this boundary the error
// escapes the React tree and the dev overlay / a blank page makes a healthy
// app look dead. The boundary reports up so DesignScene can swap the canvas
// for a recovery panel with a Retry button; everything outside the scene
// pane (side panel, exports) keeps working.
class CanvasErrorBoundary extends Component<
  { onError: (message: string) => void; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(err: unknown) {
    this.props.onError(err instanceof Error ? err.message : String(err));
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

// Repaint when the tab becomes visible again: with frameloop="demand" a
// backgrounded tab renders nothing, and some browsers discard the last
// presented frame — without this the drafter can come back to a black
// canvas until the next interaction. Also a backstop for contexts that die
// while hidden without ever firing webglcontextlost (seen on some GPUs):
// report the dead context so the silent recovery path can rebuild it.
function VisibilityRevive({ onDeadContext }: { onDeadContext: () => void }) {
  const gl = useThree(s => s.gl);
  const invalidate = useThree(s => s.invalidate);
  useEffect(() => {
    const onVis = () => {
      if (document.hidden) return;
      const ctx = gl.getContext() as WebGLRenderingContext | null;
      if (ctx && ctx.isContextLost()) onDeadContext();
      else invalidate();
    };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('focus', onVis);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('focus', onVis);
    };
  }, [gl, invalidate, onDeadContext]);
  return null;
}

// Continuously mirrors the live camera pose into a ref outside the Canvas so
// a silent recovery remount can put the drafter back at the exact same view.
// Restores once per remount, and only when the pose was captured in the same
// view mode (a 2D ortho pose applied to the 3D perspective camera — or vice
// versa — would frame garbage).
export type SavedCameraPose = {
  viewMode: string;
  pos: [number, number, number];
  target: [number, number, number];
  zoom: number;
};
function PosePersistence({ savedPose, restorePending, viewMode }: {
  savedPose: MutableRefObject<SavedCameraPose | null>;
  restorePending: MutableRefObject<boolean>;
  viewMode: string;
}) {
  const camera = useThree(s => s.camera);
  const controls = useThree(s => s.controls) as any;
  const invalidate = useThree(s => s.invalidate);
  const restoredOnce = useRef(false);
  useEffect(() => {
    if (!controls || restoredOnce.current) return;
    restoredOnce.current = true;
    const p = savedPose.current;
    if (restorePending.current && p && p.viewMode === viewMode &&
        [...p.pos, ...p.target, p.zoom].every(Number.isFinite)) {
      camera.position.set(p.pos[0], p.pos[1], p.pos[2]);
      if ((camera as any).isOrthographicCamera) {
        (camera as any).zoom = p.zoom;
        camera.updateProjectionMatrix();
      }
      controls.target.set(p.target[0], p.target[1], p.target[2]);
      controls.update();
      invalidate();
    }
    restorePending.current = false;
  }, [controls, camera, invalidate, savedPose, restorePending, viewMode]);
  useFrame(() => {
    if (!controls) return;
    savedPose.current = {
      viewMode,
      pos: [camera.position.x, camera.position.y, camera.position.z],
      target: [controls.target.x, controls.target.y, controls.target.z],
      zoom: (camera as any).zoom ?? 1,
    };
  });
  return null;
}

// Full-pane recovery message shown when WebGL fails to start or the live
// context is lost mid-session. Retry remounts the canvas; the design in the
// store is untouched, so a successful retry restores the exact same scene.
function isSceneAssetFailure(detail: string | null): boolean {
  return detail !== null &&
    (/\b(?:could not|failed to)\s+load\b/i.test(detail) ||
      /\/(?:textures|models)\//i.test(detail));
}

function SceneRecoveryPanel({ detail, onRetry }: { detail: string | null; onRetry: () => void }) {
  const assetFailure = isSceneAssetFailure(detail);
  return (
    <div className="w-full h-full flex items-center justify-center bg-slate-900">
      <div className="max-w-md text-center px-6 py-8 rounded-lg border border-slate-700 bg-slate-800/80 shadow-xl">
        <div className="text-slate-100 text-sm font-semibold mb-2">
          {assetFailure
            ? 'The 3D scene assets could not be loaded'
            : "This browser can't run the 3D view — WebGL is unavailable"}
        </div>
        <div className="text-slate-400 text-xs mb-4">
          {assetFailure ? (
            <>
              Your design is safe — nothing is lost. BESSForge started correctly,
              but a packaged texture or model was unavailable. Restart BESSForge
              and make sure the complete application folder was extracted together.
            </>
          ) : (
            <>
              Your design is safe — nothing is lost. The 3D view needs WebGL graphics,
              and this browser is refusing to provide it. That is common in mobile
              browsers and embedded preview panes, and can also happen after a
              GPU driver crash on desktop.
            </>
          )}
          <div className="mt-2 text-slate-300">
            The CAD and 2D Plan views still work here without WebGL — switch with the
            buttons in the top-right. DXF and PDF exports work too.
          </div>
          {!assetFailure ? (
            <div className="mt-2 text-slate-300">
              For the 3D view, open this app in a regular desktop browser (Chrome, Edge,
              Firefox, Safari) in its own window.
            </div>
          ) : null}
          {detail ? <div className="mt-2 text-slate-500 break-words">({detail})</div> : null}
        </div>
        <button
          onClick={onRetry}
          className="px-4 py-2 rounded bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-semibold"
        >
          Retry
        </button>
        <div className="text-slate-500 text-[11px] mt-3">
          {assetFailure
            ? 'If retrying does not help, reinstall or re-extract the complete BESSForge package.'
            : 'On desktop, if retrying does not help, restart the browser — a crashed GPU process stays dead until the browser restarts.'}
        </div>
      </div>
    </div>
  );
}

// Ghost preview of the KMZ auto-fill plan (transparent rects + road center
// lines exactly at their drawn poses; amber = unknown-name shapes awaiting a
// tag) plus the click catcher for manual aux-gear placement. Both are
// TRANSIENT overlays: nothing here mutates the design until the store's
// applyReferenceTrace / addPlacedGear actions land the geometry.
function TraceOverlay() {
  const tracePlan = useDesignStore(s => s.tracePlan);
  // Ghost preview mirrors the panel's group selection: an unchecked group is
  // omitted here exactly as Apply will omit it (preview = commit).
  const traceInclude = useDesignStore(s => s.traceInclude);
  const gearPlacement = useDesignStore(s => s.gearPlacement);
  const setGearPlacement = useDesignStore(s => s.setGearPlacement);
  const addPlacedGear = useDesignStore(s => s.addPlacedGear);
  useEffect(() => {
    if (!gearPlacement) return;
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') setGearPlacement(null); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [gearPlacement, setGearPlacement]);
  if (!tracePlan && !gearPlacement) return null;
  const ghosts: { cx: number; cy: number; rad: number; l: number; w: number; color: string; key: string }[] = [];
  const roadLines: { pts: Pt[]; key: string }[] = [];
  if (tracePlan) {
    if (traceInclude.equipment) {
      tracePlan.items.forEach((it, i) => ghosts.push({
        cx: it.pose.cx, cy: it.pose.cy, rad: (it.pose.rotationDeg * Math.PI) / 180,
        l: it.pose.lengthFt, w: it.pose.widthFt, color: '#22d3ee', key: `ti-${i}`,
      }));
    }
    tracePlan.unknowns.forEach((u, i) => {
      if (u.tag === 'ignore') return;
      if (u.tag === 'road' ? !traceInclude.roads : !traceInclude.equipment) return;
      ghosts.push({
        cx: u.pose.cx, cy: u.pose.cy, rad: (u.pose.rotationDeg * Math.PI) / 180,
        l: u.pose.lengthFt, w: u.pose.widthFt,
        color: u.tag === 'road' ? '#94a3b8' : '#f59e0b', key: `tu-${i}`,
      });
    });
    if (traceInclude.roads) {
      tracePlan.roads.forEach((r, i) => r.strips.forEach((s, j) => {
        if (s.pts.length >= 2) roadLines.push({ pts: s.pts, key: `tr-${i}-${j}` });
      }));
    }
  }
  return (
    <group>
      {ghosts.map(g => (
        <group key={g.key} position={[g.cx, 1.15, -g.cy]} rotation={[0, g.rad, 0]}>
          <mesh rotation={[-Math.PI / 2, 0, 0]}>
            <planeGeometry args={[g.l, g.w]} />
            <meshBasicMaterial color={g.color} transparent opacity={0.3} depthWrite={false} />
          </mesh>
        </group>
      ))}
      {roadLines.map(r => (
        <Line
          key={r.key}
          points={r.pts.map(p => [p.x, 1.15, -p.y] as [number, number, number])}
          color="#94a3b8"
          lineWidth={2}
          dashed
          dashSize={8}
          gapSize={5}
        />
      ))}
      {gearPlacement && (
        <mesh
          position={[0, 1.4, 0]}
          rotation={[-Math.PI / 2, 0, 0]}
          onPointerDown={e => {
            e.stopPropagation();
            const kind = gearPlacement.kind;
            const why = addPlacedGear(kind, Math.round(e.point.x), Math.round(-e.point.z));
            if (why) toast.error(why);
          }}
        >
          <planeGeometry args={[200000, 200000]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
      )}
    </group>
  );
}

export default function DesignScene() {
  const design = useDesignStore(s => s.design);
  const alignRows = useDesignStore(s => s.alignRows);
  const alignIsland = useDesignStore(s => s.alignIsland);
  const mirrorAlignIsland = useDesignStore(s => s.mirrorAlignIsland);
  const compactIsland = useDesignStore(s => s.compactIsland);
  const vcenterIsland = useDesignStore(s => s.vcenterIsland);
  const centerBlocks = useDesignStore(s => s.centerBlocks);
  const centerPlacedIsland = useDesignStore(s => s.centerPlacedIsland);
  const restoreAutoPosition = useDesignStore(s => s.restoreAutoPosition);
  const deleteBlock = useDesignStore(s => s.deleteBlock);
  const deleteAutoIsland = useDesignStore(s => s.deleteAutoIsland);
  const deleteEquipment = useDesignStore(s => s.deleteEquipment);
  const removePlacedIsland = useDesignStore(s => s.removePlacedIsland);
  const computing = useDesignStore(s => s.computing);
  const placingSubstation = useDesignStore(s => s.placingSubstation);
  const realisticModels = useDesignStore(s => s.realisticModels);
  const setRealisticModels = useDesignStore(s => s.setRealisticModels);
  // 3D scene / CAD drawing view / 2D plan. Persisted per-browser like the
  // other view prefs so the drafter's choice survives a reload.
  const [viewMode, setViewModeRaw] = useState<'3d' | '2d' | 'cad'>(() => {
    try {
      const v = localStorage.getItem('nextera-view-mode');
      return v === '2d' || v === 'cad' ? v : '3d';
    } catch { return '3d'; }
  });
  const setViewMode = useCallback((m: '3d' | '2d' | 'cad') => {
    setViewModeRaw(m);
    try { localStorage.setItem('nextera-view-mode', m); } catch { /* private mode */ }
  }, []);
  // Cinematic tours may temporarily stage CAD groups, but ordinary CAD
  // visibility comes only from the project-wide drawing profile.
  const tourCadLayers = useDesignStore(s => s.tourCadLayers);
  const cadLayerVis = useMemo<CadLayerVis | undefined>(
    () => tourCadLayers ? { ...CAD_LAYER_VIS_DEFAULT, ...tourCadLayers } : undefined,
    [tourCadLayers]
  );
  const drawingVisibility = useDesignStore(s => s.drawingVisibility);
  const setDrawingVisibility = useDesignStore(s => s.setDrawingVisibility);
  // [662] Selected text label info (null = nothing selected).
  const [cadSelectedText, setCadSelectedText] = useState<SelectedTextInfo | null>(null);
  const setTextOverride = useDesignStore(s => s.setTextOverride);
  const clearTextOverride = useDesignStore(s => s.clearTextOverride);
  const textOverrides = useDesignStore(s => s.textOverrides);
  // WebGL failure recovery. Losing the graphics context (tab slept, GPU
  // driver restarted, browser reclaimed the context) is recovered SILENTLY:
  // 1. contextlost + contextrestored — three.js re-initializes on the same
  //    canvas; we just repaint. Nothing remounts.
  // 2. contextlost with no restore, a dead context found on tab wake, a
  //    failed pre-flight probe, or a renderer-construction throw — the
  //    canvas remounts automatically with short backoff, restoring the
  //    exact camera pose via PosePersistence.
  // The recovery panel is a last resort after several consecutive automatic
  // attempts fail (genuinely broken GPU); a stable context resets the count.
  const [glFailure, setGlFailure] = useState<string | null>(null);
  const [glRetry, setGlRetry] = useState(0);
  // recoveredMount: set exactly when a scheduled recovery remount fires and
  // consumed by the next Canvas onCreated. Keying the toast off this flag
  // (instead of the raw attempt counter) means an ordinary view switch that
  // remounts the canvas within the 10s "stable" window after a genuine
  // recovery can never show a spurious "3D view recovered" toast.
  const recovery = useRef({ attempts: 0, pending: false, recoveredMount: false, timer: 0 as any, stableTimer: 0 as any });
  const savedPose = useRef<SavedCameraPose | null>(null);
  const poseRestorePending = useRef(false);
  const GL_MAX_AUTO_RETRIES = 3;
  // Clear any in-flight recovery timers on unmount so a scheduled remount
  // callback can never fire into a torn-down scene.
  useEffect(() => () => {
    clearTimeout(recovery.current.timer);
    clearTimeout(recovery.current.stableTimer);
  }, []);
  // Schedule a silent canvas remount with backoff; shows the panel only
  // once the attempt budget is exhausted.
  const attemptRecovery = useCallback((reason: string) => {
    const r = recovery.current;
    if (r.pending) return;
    clearTimeout(r.stableTimer);
    if (r.attempts >= GL_MAX_AUTO_RETRIES) {
      setGlFailure(reason);
      return;
    }
    const delay = [300, 1500, 4000][r.attempts] ?? 4000;
    r.attempts++;
    r.pending = true;
    poseRestorePending.current = true;
    clearTimeout(r.timer);
    r.timer = setTimeout(() => {
      r.pending = false;
      // Mark that the NEXT canvas mount is the product of this recovery
      // attempt — onCreated consumes this to decide whether to toast.
      r.recoveredMount = true;
      setGlFailure(null);
      setGlRetry(x => x + 1);
    }, delay);
  }, []);
  // Probe WebGL availability before mounting the Canvas: if the browser
  // cannot create a context at all, mounting would throw from inside the
  // renderer and (in dev) pop the error overlay on top of the recovery
  // panel. Probing with a throwaway canvas keeps that path exception-free;
  // the error boundary below remains as a backstop for anything the probe
  // can't predict.
  // The probe must run SYNCHRONOUSLY before render: an effect fires only
  // after the Canvas has already mounted and thrown from inside the
  // renderer (children commit before parent effects), which is exactly the
  // unhandled-error spam seen on WebGL-disabled browsers. Keyed by glRetry
  // so every scheduled recovery attempt re-probes.
  const glProbeOk = useMemo(() => {
    try {
      const probe = document.createElement('canvas');
      // three r163+ requires WebGL2 specifically — a browser that only
      // offers WebGL1 (e.g. WebGL2 blocked by enterprise policy) would pass
      // a webgl2||webgl probe and then throw inside the renderer anyway.
      const gl = probe.getContext('webgl2');
      if (!gl) return false;
      // Release the probe context immediately so it never counts against
      // the browser's live-context limit.
      (gl.getExtension('WEBGL_lose_context') as { loseContext(): void } | null)?.loseContext();
      return true;
    } catch {
      return false;
    }
  }, [glRetry]);
  useEffect(() => {
    if (glFailure !== null || glProbeOk) return;
    // A failed probe is often transient (GPU process still restarting
    // after tab sleep) — retry silently before ever surfacing a panel.
    attemptRecovery('The browser could not create a WebGL2 graphics context.');
  }, [glProbeOk, glRetry, glFailure, attemptRecovery]);
  // Island resolved from the edit-mode selection (null = no island selected);
  // scopes the Align control to that island instead of all rows.
  const [selIsland, setSelIsland] = useState<number | null>(null);
  // Exactly what the arrow keys move, so Center / Restore can act on the
  // same thing rather than guessing from the island picker.
  const [nudgeTarget, setNudgeTarget] = useState<NudgeTarget | null>(null);
  // A single selected item (equipment scope) — the toolbar shows a Delete for
  // it whenever no wider scope (block/island/marquee) owns the selection.
  const [selEquip, setSelEquip] = useState<SelectedEquip | null>(null);
  // Selected road(s), published from the edit layer so the toolbar can offer
  // the same Delete action the Delete key performs.
  const [roadSelInfo, setRoadSelInfo] = useState<{ labels: string[]; onDelete: () => void; onSpan: () => void; spanArmed: boolean; onPave?: () => void } | null>(null);
  // Align target island, pickable from the align bar in ANY mode (edit-mode
  // block selection also drives it). null = all rows.
  const [pickedIsland, setPickedIsland] = useState<number | null>(null);
  useEffect(() => {
    if (selIsland !== null) setPickedIsland(selIsland);
  }, [selIsland]);
  const [editMode, setEditMode] = useState(false);
  // Mirror edit mode into the store so overlays outside the canvas (the MV
  // FEEDERS legend) can adapt their click behavior; cleared on unmount.
  useEffect(() => {
    useDesignStore.getState().setLayoutEditActive(editMode);
    return () => useDesignStore.getState().setLayoutEditActive(false);
  }, [editMode]);
  const [editTool, setEditTool] = useState<EditTool>('move');
  // Road width for the Draw Road tool (24 ft standard / 30 / 36 ft). Resets
  // to 24 ft when edit mode is closed, persists for a whole draw session.
  const [roadDrawWidth, setRoadDrawWidth] = useState(24);
  // Pair columns for the next drag-placed island. Full standard strip by
  // default; smaller values place a deliberate PARTIAL island where a full
  // one cannot fit (e.g. the last stub of capacity on a tight parcel).
  const [islandPairs, setIslandPairs] = useState<number>(ISLAND_PCS_PER_SIDE);
  // What the island tool places: a mirrored-pair island (full or partial) or
  // a single PCS module with either 3 BESS (legacy) or 2 BESS (manual option).
  // And whether THIS placement reserves
  // augmentation — an explicit decision, never an implied default, because
  // the Big Iron Phase 1 reference has rows with no augmentation provision.
  const [placeKind, setPlaceKind] = useState<PlacementKind>('island');
  const [placeAug, setPlaceAug] = useState(true);
  // Whether THIS island placement also brings the standard mid-island aux
  // cluster (aux transformer + aux distribution + comms cabinet). Defaults to
  // OFF: a manual placement puts down core BESS equipment, and the cluster —
  // which widens the island's middle gap to house it — is an explicit
  // decision. Single modules never carry one.
  const [placeAuxGear, setPlaceAuxGear] = useState(false);
  // Which single item the equipment placement mode drops.
  const [placeEquipType, setPlaceEquipType] = useState<ManualEquipmentType>('auxTransformer');
  // Orientation for the next placement. EXPLICIT: chosen here or with R while
  // the ghost is live — never inferred from the direction of a pointer drag.
  // Island rotation for the next placement in degrees CCW from world +x.
  // 0 = horizontal strip (E-W), 90 = vertical (N-S), any value = arbitrary.
  const [placeAngleDeg, setPlaceAngleDeg] = useState(0);
  // Snap increment for placement (0 = free positioning, quantized to 0.01 ft).
  const [placeSnap, setPlaceSnap] = useState<number>(PLACEMENT_SNAP_DEFAULT_FT);
  // Equipment-choice controls must steer a session that hovering already
  // opened, exactly like the orientation and snap controls do — otherwise the
  // toolbar shows one selection while the ghost previews the previous one.
  const setLivePlacementConfig = (cfg: {
    kind?: PlacementKind; pairs?: number; aug?: boolean;
    auxGear?: boolean; equipType?: ManualEquipmentType;
  }) => useDesignStore.getState().setPlacementConfig(cfg);
  // Area-zone type picked in the toolbar; used by the Area Zone tool.
  const [zoneKind, setZoneKind] = useState<AreaZoneKind>('laydown');
  const [dragging, setDragging] = useState(false);
  const undoCount = useDesignStore(s => s.undoStack.length);
  const undoEdit = useDesignStore(s => s.undoEdit);
  const inspectTrenchRequest = useDesignStore(s => s.inspectTrenchRequest);
  const overviewRequest = useDesignStore(s => s.overviewRequest);
  // Whole-site camera envelope for multi-area projects, reduced to a rounded
  // STRING inside the selector. Returning an object here would allocate a new
  // reference on every store notification and make the camera memo below
  // re-run, which re-applies the camera props and yanks any requestCameraPose
  // (the exact failure mode the bounds memo is keyed to avoid). Empty string
  // for single-boundary sites keeps their framing byte-identical.
  const siteBoundsSig = useDesignStore(s => {
    if (s.siteAreas.length < 2) return '';
    const b = siteAreasBounds(s.siteAreas);
    return b ? `${b.cx.toFixed(2)},${b.cy.toFixed(2)},${b.spanX.toFixed(2)},${b.spanY.toFixed(2)}` : '';
  });
  // Switching the EDITABLE area changes the displayed design but not the
  // whole-site envelope, so the camera needs its own active-area fit trigger:
  // the signature below changes exactly when the selected footprint changes.
  // Reduced to a rounded STRING for the same reason as siteBoundsSig — an
  // object selector would re-run the camera memo on every store notification.
  const activeAreaFitSig = useDesignStore(s => {
    if (s.siteAreas.length < 2 || !s.activeAreaId) return '';
    const area = s.siteAreas.find(a => a.id === s.activeAreaId);
    if (!area) return '';
    const b = siteAreasBounds([area]);
    return b ? `${area.id}|${b.cx.toFixed(2)},${b.cy.toFixed(2)},${b.spanX.toFixed(2)},${b.spanY.toFixed(2)}` : '';
  });
  const walkMode = useDesignStore(s => s.walkMode);
  const setWalkMode = useDesignStore(s => s.setWalkMode);
  const showSatellite = useDesignStore(s => s.showSatellite);
  const satelliteStatus = useDesignStore(s => s.satelliteStatus);
  const satelliteError = useDesignStore(s => s.satelliteError);
  // Cinematic marketing tour + capture kit (presentation-only).
  const tourActive = useDesignStore(s => s.tourActive);
  const tourRecord = useDesignStore(s => s.tourRecord);
  const offlineRenderActive = useDesignStore(s => s.offlineRenderActive);
  const offlineRenderRequest = useDesignStore(s => s.offlineRenderRequest);
  const offlineHandled = useRef(0);
  const [offlineProgress, setOfflineProgress] = useState<number | null>(null);
  const tourPhase = useDesignStore(s => s.tourPhase);
  // View mode the drafter was in when the tour started (restored after the
  // showcase segment ends).
  const tourPrevView = useRef<'3d' | '2d' | 'cad'>('3d');
  const startCinematicTour = useDesignStore(s => s.startCinematicTour);
  const stopCinematicTour = useDesignStore(s => s.stopCinematicTour);
  const marketingStillsRequest = useDesignStore(s => s.marketingStillsRequest);
  const setRealisticModelsStore = setRealisticModels;
  const containerRef = useRef<HTMLDivElement>(null);
  const [stillsProgress, setStillsProgress] = useState<string | null>(null);
  // Tour options popover (duration preset + per-stop toggles)
  const [showTourOptions, setShowTourOptions] = useState(false);
  // Offline render quality popover (fps; one render always saves MP4 + WebM).
  const [showOfflineQuality, setShowOfflineQuality] = useState(false);
  const [offlineFps, setOfflineFps] = useState<30 | 60>(60);
  const tourOptions = useDesignStore(s => s.tourOptions);
  const setTourOptions = useDesignStore(s => s.setTourOptions);
  // Feeder fly-along stop availability: needs a placed substation with
  // routed feeders (the checkbox is disabled otherwise — a no-op stop).
  const tourFeeders = useDesignStore(s => s.feeders);
  const tourSubstation = useDesignStore(s => s.substation);

  // First-person walkthrough is 3D-only; entering it from the 2D plan view
  // switches back to 3D. Leaving edit mode avoids drag conflicts.
  useEffect(() => {
    if (walkMode) {
      setViewMode('3d');
      setEditMode(false);
      setDragging(false);
    }
  }, [walkMode]);

  // The cinematic tour's camera path is 3D-only and drives the camera
  // imperatively; entering it exits edit mode and forces the 3D view. Gated
  // on the 'path' phase — the scripted showcase segment that follows drives
  // the view mode itself (CAD zoom, sheet overlays) and must not be fought.
  useEffect(() => {
    if (tourActive && tourPhase === 'path') {
      tourPrevView.current = viewMode;
      setViewMode('3d');
      setEditMode(false);
      setDragging(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tourActive, tourPhase, setViewMode]);

  // Tour video recording. The tour spans view-mode switches (3D path →
  // CAD showcase → sheet overlays) and every switch remounts the Canvas,
  // killing any stream captured directly from the WebGL canvas. So the
  // recorder captures a COMPOSITE 2D canvas instead: a rAF loop re-queries
  // the live WebGL canvas each frame (survives remounts; preserveDrawingBuffer
  // makes drawImage read real pixels) and draws the sheet-showcase overlay
  // canvas on top when present — one continuous video across the whole tour.
  // The composite tracks the live canvas pixel size, so window resizes
  // mid-recording keep the video 1:1 with the on-screen sheet zooms.
  useEffect(() => {
    if (!tourActive || !tourRecord) return;
    const container = containerRef.current;
    const first = container?.querySelector('canvas:not([data-tour-overlay])') as HTMLCanvasElement | null;
    if (!container || !first || typeof MediaRecorder === 'undefined') {
      toast.error('Video recording is not supported in this browser — playing the tour without recording');
      return;
    }
    const comp = document.createElement('canvas');
    // 4K-class output: keep the live canvas aspect but scale the composite
    // UP to UHD bounds (3840×2160) so the exported video is 4K even when
    // the window is small. Even dimensions keep every encoder happy; never
    // downscale a buffer that is already above UHD.
    const uhdFit = (w: number, h: number) => {
      const s = Math.min(3840 / w, 2160 / h);
      return s > 1
        ? { w: Math.round((w * s) / 2) * 2, h: Math.round((h * s) / 2) * 2 }
        : { w, h };
    };
    const init = uhdFit(first.width || container.clientWidth || 1280, first.height || container.clientHeight || 720);
    comp.width = init.w;
    comp.height = init.h;
    const cctx = comp.getContext('2d');
    if (!cctx) {
      toast.error('Could not capture the 3D view for recording — playing the tour without recording');
      return;
    }
    let raf = 0;
    const draw = () => {
      const live = container.querySelector('canvas:not([data-tour-overlay])') as HTMLCanvasElement | null;
      // [490] Mid-recording window resizes: keep the composite matched to
      // the live canvas ASPECT (scaled to UHD), so late frames stay 1:1
      // with the screen (no letterboxing / shrunken sheet text). WebM
      // (VP8/VP9) muxes resolution changes fine; if the encoder can't
      // (e.g. some MP4 muxers), rec.onerror below stops and saves what was
      // captured.
      if (live && live.width && live.height) {
        const t = uhdFit(live.width, live.height);
        if (t.w !== comp.width || t.h !== comp.height) {
          comp.width = t.w;
          comp.height = t.h;
        }
      }
      cctx.imageSmoothingEnabled = true;
      cctx.imageSmoothingQuality = 'high';
      cctx.fillStyle = '#0b0f14';
      cctx.fillRect(0, 0, comp.width, comp.height);
      for (const src of [live, container.querySelector('canvas[data-tour-overlay]') as HTMLCanvasElement | null]) {
        if (!src || !src.width || !src.height) continue;
        // Contain-fit each source so aspect changes never distort the video.
        const s = Math.min(comp.width / src.width, comp.height / src.height);
        const w = src.width * s, h = src.height * s;
        try {
          cctx.drawImage(src, (comp.width - w) / 2, (comp.height - h) / 2, w, h);
        } catch {
          // A canvas mid-teardown can throw; skip this frame.
        }
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    let stream: MediaStream;
    try {
      // 30 fps: half the encoder load of 60 (the lag was dropped frames from
      // an overloaded realtime encoder), and the standard cinematic rate.
      stream = comp.captureStream(30);
    } catch {
      cancelAnimationFrame(raf);
      toast.error('Could not capture the 3D view for recording — playing the tour without recording');
      return;
    }
    // Every exit past this point must tear down the draw loop AND the
    // capture tracks, or a failed setup leaves a live rAF loop + encoder
    // tracks running for the rest of the session.
    const teardown = () => {
      cancelAnimationFrame(raf);
      for (const track of stream.getTracks()) track.stop();
    };
    // Prefer MP4 where the browser can mux it (Safari); WebM elsewhere.
    const mime = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm']
      .find(m => MediaRecorder.isTypeSupported(m));
    if (!mime) {
      teardown();
      toast.error('No supported video format for recording — playing the tour without recording');
      return;
    }
    let rec: MediaRecorder;
    try {
      // ~40 Mbps: 4K-class footage needs far more than the 14 Mbps that was
      // fine at window resolution, or the encoder smears the linework.
      rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 40_000_000 });
      const chunks: Blob[] = [];
      rec.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
      // If the encoder rejects a mid-recording resolution change, salvage
      // the footage captured so far instead of losing the whole video.
      rec.onerror = () => { if (rec.state !== 'inactive') rec.stop(); };
      rec.onstop = () => {
        if (chunks.length === 0) return;
        const ext = mime.startsWith('video/mp4') ? 'mp4' : 'webm';
        void saveBlob(new Blob(chunks, { type: mime }), `site-tour.${ext}`)
          .then(saved => { if (saved) toast.success(`Tour video saved (site-tour.${ext})`); });
      };
      rec.start(1000);
    } catch {
      teardown();
      toast.error('Could not start the video recorder — playing the tour without recording');
      return;
    }
    return () => {
      if (rec.state !== 'inactive') rec.stop();
      // Stop the capture tracks too — the recorder alone leaves live
      // encoder tracks running, which accumulate across repeated tours.
      teardown();
    };
  }, [tourActive, tourRecord]);

  // Offline WebCodecs 4K60 render: step the tour sampler frame by frame via
  // tourSeek (every overlay is a pure function of t, so the stepped frames
  // are identical to live playback), composite each rendered frame at UHD
  // and feed a non-realtime VideoEncoder. Zero dropped frames regardless of
  // GPU speed; perfectly even pacing. Esc / click cancels (they stop the
  // tour, which the loop watches).
  useEffect(() => {
    if (offlineRenderRequest <= offlineHandled.current || !design) return;
    offlineHandled.current = offlineRenderRequest;
    let disposed = false;
    (async () => {
      const st = useDesignStore.getState();
      const opts = st.offlineRenderOpts ?? {};
      const fps = Math.min(60, Math.max(1, opts.fps ?? 60));
      if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') {
        toast.error('This browser has no WebCodecs support — use the realtime ⏺ Record button instead');
        return;
      }
      const fly = feederFlyalongRoute(st.feeders, st.substation);
      const sampler = buildTourSampler(design, st.tourOptions, { feederRoute: fly?.route ?? null });
      if (!sampler) {
        toast.error('No playable tour for this design');
        return;
      }
      const sched = offlineFrameSchedule(sampler.duration, fps, opts.maxSeconds);
      const container = containerRef.current;
      if (!container) return;
      st.setOfflineRenderActive(true); // boosts render dpr (supersampled UHD)
      st.setTourSeek(0);
      st.startCinematicTour(false);
      setOfflineProgress(0);
      const raf2 = () => new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r())));
      let encoders: VideoEncoder[] = [];
      try {
        // Let the dpr bump remount buffers and the first pose settle.
        await raf2(); await raf2();
        // Realistic-flight option: the mounted tour camera flips the scene
        // toggle on; quality mode waits out the full GLB download/parse so
        // no stepped frame ever captures half-loaded models. (The camera's
        // own 20 s live gate is bypassed here — tourSeek drives the clock.)
        if (flightRealisticEnabled(st.tourOptions)) {
          const settled = await waitForSceneReady({ timeoutMs: 120000 });
          if (!settled) {
            toast.warning('Realistic models were still loading when the offline render started — early frames may show incomplete equipment.');
          }
        }
        const live0 = container.querySelector('canvas:not([data-tour-overlay])') as HTMLCanvasElement | null;
        if (!live0 || !live0.width) throw new Error('live canvas unavailable');
        // Encode target is EXACT UHD-fit (never above 4K): the supersampled
        // live buffer downscales into it for cleaner linework edges.
        const dims = uhdBoundDims(live0.width, live0.height);
        // One stepped pass, BOTH containers: every frame fans out to a WebM
        // (VP9/VP8) encoder AND an MP4 (H.264) encoder. A container whose
        // codec this browser can't encode is skipped with an explicit toast
        // — the render never fails just because one container is missing.
        const webmCfg = await pickOfflineCodec(dims.w, dims.h, fps, 'webm');
        const mp4Cfg = await pickOfflineCodec(dims.w, dims.h, fps, 'mp4');
        if (!webmCfg && !mp4Cfg) {
          toast.error('No supported offline video codec on this browser — use the realtime ⏺ Record button');
          throw new Error('no codec');
        }
        if (!mp4Cfg) toast.warning('MP4 (H.264) not supported by this browser at this resolution — saving WebM only');
        if (!webmCfg) toast.warning('WebM (VP9/VP8) not supported by this browser at this resolution — saving MP4 only');
        interface Sink {
          container: 'webm' | 'mp4';
          target: InstanceType<typeof Mp4Target> | InstanceType<typeof WebmTarget>;
          muxer: { addVideoChunk: (c: EncodedVideoChunk, m?: EncodedVideoChunkMetadata) => void; finalize: () => void };
          encoder: VideoEncoder;
          error: unknown;
        }
        const sinks: Sink[] = [];
        for (const cfg of [webmCfg, mp4Cfg]) {
          if (!cfg) continue;
          const container = codecContainer(cfg.codec);
          const target = container === 'mp4' ? new Mp4Target() : new WebmTarget();
          const muxer = container === 'mp4'
            ? new Mp4Muxer({
                target: target as InstanceType<typeof Mp4Target>,
                video: { codec: 'avc', width: dims.w, height: dims.h, frameRate: fps },
                fastStart: 'in-memory',
              })
            : new WebmMuxer({
                target: target as InstanceType<typeof WebmTarget>,
                video: { codec: codecToMuxerId(cfg.codec), width: dims.w, height: dims.h, frameRate: fps },
              });
          const sink: Sink = {
            container,
            target,
            muxer: muxer as unknown as Sink['muxer'],
            encoder: null as unknown as VideoEncoder,
            error: null,
          };
          sink.encoder = new VideoEncoder({
            output: (chunk, meta) => sink.muxer.addVideoChunk(chunk, meta),
            error: (e) => { sink.error = e; },
          });
          sink.encoder.configure(cfg);
          sinks.push(sink);
        }
        encoders = sinks.map(s => s.encoder);
        // A sink that errors mid-render is dropped (its file is discarded);
        // the render only fails outright when EVERY sink has errored.
        const liveSinks = () => sinks.filter(s => !s.error);
        const encError = () => (liveSinks().length === 0 ? sinks[0].error : null);
        const comp = document.createElement('canvas');
        comp.width = dims.w;
        comp.height = dims.h;
        const cctx = comp.getContext('2d');
        if (!cctx) throw new Error('composite 2d context unavailable');
        // One encoder frame from whatever is on screen right now (live WebGL
        // canvas + sheet-showcase overlay when present) — shared by the
        // flight loop and the [512] driven showcase loop so both land in the
        // SAME file with continuous timestamps.
        let frameIdx = 0;
        const encodeScreenFrame = () => {
          const live = container.querySelector('canvas:not([data-tour-overlay])') as HTMLCanvasElement | null;
          const over = container.querySelector('canvas[data-tour-overlay]') as HTMLCanvasElement | null;
          cctx.imageSmoothingEnabled = true;
          cctx.imageSmoothingQuality = 'high';
          cctx.fillStyle = '#0f172a';
          cctx.fillRect(0, 0, comp.width, comp.height);
          for (const src of [live, over]) {
            if (!src || !src.width || !src.height) continue;
            const s = Math.min(comp.width / src.width, comp.height / src.height);
            const dw = src.width * s, dh = src.height * s;
            try {
              cctx.drawImage(src, (comp.width - dw) / 2, (comp.height - dh) / 2, dw, dh);
            } catch { /* transient loss mid-frame: keep the slate frame */ }
          }
          const frame = new VideoFrame(comp, {
            timestamp: frameIdx * sched.frameDurUs,
            duration: sched.frameDurUs,
          });
          // Fan out: one VideoFrame feeds every live sink (encode() copies
          // the frame data internally, so a single close() after the loop is
          // safe), keeping the render single-pass for any number of outputs.
          for (const s of liveSinks()) {
            s.encoder.encode(frame, { keyFrame: frameIdx % (fps * 2) === 0 });
          }
          frame.close();
          frameIdx++;
        };
        // Backpressure: never let any sink's encode queue grow unbounded.
        const drainEncoder = async () => {
          while (liveSinks().some(s => s.encoder.encodeQueueSize > 4) && !encError()) {
            await new Promise(r => setTimeout(r, 10));
          }
        };
        let completed = false;
        for (let i = 0; i < sched.frames; i++) {
          // Esc/click stops the tour -> abort and discard (a half video with
          // no warning would look like a bug, not a cancel).
          if (disposed || encError() || !useDesignStore.getState().tourActive) break;
          useDesignStore.getState().setTourSeek(offlineFrameT(sched, i));
          await raf2();
          encodeScreenFrame();
          await drainEncoder();
          if ((i & 7) === 0 || i === sched.frames - 1) setOfflineProgress((i + 1) / sched.frames);
          completed = i === sched.frames - 1;
        }
        // [512] Post-flight showcase segment (CAD zoom, plot, grounding plan,
        // BOM, SLD sheets): hand off to TourShowcase in driven mode — it
        // registers window.__tourShowcaseDriver against its deterministic
        // timeline — and step that timeline at even frame intervals into the
        // SAME encoder. One file = flight + showcase, zero dropped frames.
        let showcaseFrames = 0;
        if (completed && !encError() && !disposed && useDesignStore.getState().tourActive) {
          useDesignStore.getState().setTourSeek(null);
          useDesignStore.getState().finishTourPath();
          // Wait for the driver to register; TourShowcase skips itself (and
          // ends the tour) when every showcase stop is toggled off.
          let driver: { totalMs: number; seek: (ms: number) => Promise<void>; done: () => void } | null = null;
          for (let w = 0; w < 200 && !disposed; w++) {
            await raf2();
            driver = (window as any).__tourShowcaseDriver ?? null;
            const st2 = useDesignStore.getState();
            if (driver || !st2.tourActive || st2.tourPhase !== 'showcase') break;
          }
          if (driver) {
            try {
              // The timeline plays at the live speed divisor so the offline
              // pacing matches realtime playback second-for-second.
              const spd = Math.max(0.1, useDesignStore.getState().tourShowcaseSpeed);
              showcaseFrames = showcaseFrameCount(driver.totalMs, spd, fps);
              let showDone = 0;
              for (let j = 0; j < showcaseFrames; j++) {
                // Esc still cancels through the showcase (stops the tour).
                if (disposed || encError() || !useDesignStore.getState().tourActive) break;
                await driver.seek(showcaseFrameMs(driver.totalMs, showcaseFrames, j));
                await raf2();
                encodeScreenFrame();
                await drainEncoder();
                if ((j & 7) === 0 || j === showcaseFrames - 1) {
                  setOfflineProgress((sched.frames + j + 1) / (sched.frames + showcaseFrames));
                }
                showDone = j + 1;
              }
              // A cancel mid-showcase discards the file like a mid-flight one.
              completed = showDone === showcaseFrames;
            } finally {
              driver.done();
            }
          }
        }
        if (completed && !encError() && !disposed) {
          // Finalize every surviving sink into its own file; a sink that
          // errored mid-render is reported and skipped (never a silent drop).
          const outputs: { container: 'webm' | 'mp4'; blob: Blob }[] = [];
          for (const s of sinks) {
            if (s.error) {
              console.error(`offline render ${s.container} encoder error`, s.error);
              toast.warning(`The ${s.container.toUpperCase()} encoder failed mid-render — that file was not saved`);
              continue;
            }
            await s.encoder.flush();
            s.muxer.finalize();
            outputs.push({
              container: s.container,
              blob: new Blob([s.target.buffer], { type: s.container === 'mp4' ? 'video/mp4' : 'video/webm' }),
            });
          }
          if (outputs.length === 0) {
            // Every sink errored between the last loop check and finalize —
            // deterministic failure, never a silent empty save.
            toast.error('Offline render failed in the video encoder — nothing was saved');
            return;
          }
          // Dev/test hook (mirrors __sceneCamera): lets the visual test
          // verify the muxed offline video without intercepting downloads.
          // `blob`/`container` stay the WebM output (the always-attempted
          // baseline) for existing consumers; `outputs` lists every file.
          const primary = outputs.find(o => o.container === 'webm') ?? outputs[0];
          (window as any).__offlineVideo = {
            blob: primary.blob, container: primary.container, outputs,
            w: dims.w, h: dims.h,
            frames: frameIdx, flightFrames: sched.frames, showcaseFrames, fps,
          };
          const stem = `site-tour-${dims.h >= 2160 ? '4k' : `${dims.h}p`}${fps}`;
          let savedAny = false;
          for (const o of outputs) {
            if (await saveBlob(o.blob, `${stem}.${o.container}`)) savedAny = true;
          }
          if (savedAny) {
            toast.success(`Offline ${dims.w}×${dims.h} ${fps} fps tour video saved (${outputs.map(o => o.container.toUpperCase()).join(' + ')})`);
          }
        } else if (encError()) {
          console.error('offline render encoder error', encError());
          toast.error('Offline render failed in the video encoder — nothing was saved');
        } else if (!disposed) {
          toast.error('Offline render cancelled — no video saved');
        }
      } catch (e) {
        if ((e as Error)?.message !== 'no codec') {
          console.error('offline render failed', e);
          toast.error('Offline render failed — nothing was saved');
        }
      } finally {
        for (const enc of encoders) {
          try { enc.close(); } catch { /* already closed */ }
        }
        const s2 = useDesignStore.getState();
        s2.setTourSeek(null);
        if (s2.tourActive) s2.stopCinematicTour();
        s2.setOfflineRenderActive(false);
        setOfflineProgress(null);
      }
    })();
    return () => { disposed = true; };
  }, [offlineRenderRequest, design]);

  // Marketing stills capture: sequences through the app's looks (CAD plain,
  // CAD realistic, 3D simple, 3D realistic + hero angles, 2D plan), captures
  // the WebGL canvas after each settles, and downloads the set as one zip.
  // Presentation-only; the drafter's view mode / realistic toggle / camera
  // are restored afterwards.
  const stillsHandled = useRef(0);
  const stillsBusy = useRef(false);
  useEffect(() => {
    if (marketingStillsRequest <= stillsHandled.current || !design || stillsBusy.current) return;
    stillsHandled.current = marketingStillsRequest;
    stillsBusy.current = true;
    let cancelled = false;
    const onKey = (e: KeyboardEvent) => { if (e.code === 'Escape') cancelled = true; };
    window.addEventListener('keydown', onKey);
    const nextFrames = () => new Promise<void>(r =>
      requestAnimationFrame(() => requestAnimationFrame(() => r())));
    const capture = (): Promise<Blob | null> => new Promise(res => {
      const canvas = containerRef.current?.querySelector('canvas') as HTMLCanvasElement | null;
      if (!canvas) return res(null);
      canvas.toBlob(b => res(b), 'image/png');
    });
    const store = useDesignStore.getState;
    const prev = { viewMode, realistic: realisticModels };
    // Hero poses (scene coords) from the loaded design — nothing hardcoded.
    const span = Math.max(bounds.spanX, bounds.spanY, 200);
    const overviewPose = (): [[number, number, number], [number, number, number]] => {
      const d = new THREE.Vector3(0, 1, 0.9).normalize().multiplyScalar(span * 1.25);
      return [[bounds.cx + d.x, d.y, -bounds.cy + d.z], [bounds.cx, 0, -bounds.cy]];
    };
    const gatePose = (): [[number, number, number], [number, number, number]] | null => {
      const g = design.gate;
      if (!g) return null;
      // Outside the gate, low, looking through the opening into the yard.
      const c = { x: bounds.cx, y: bounds.cy };
      const nx = -Math.sin(g.rotation), ny = Math.cos(g.rotation);
      const s = (c.x - g.x) * nx + (c.y - g.y) * ny >= 0 ? 1 : -1;
      const ox = -nx * s, oy = -ny * s;
      return [[g.x + ox * 90, 22, -(g.y + oy * 90)], [g.x, 6, -g.y]];
    };
    const islandPose = (): [[number, number, number], [number, number, number]] | null => {
      const eq = design.equipment.find(e => e.kind === 'inverter') ?? design.equipment[0];
      if (!eq) return null;
      const dist = Math.max(eq.length, eq.width, 60) * 1.6;
      return [[eq.x + dist * 0.7, dist * 0.55, -(eq.y - dist * 0.7)], [eq.x, 0, -eq.y]];
    };
    interface Shot {
      name: string;
      mode: '3d' | '2d' | 'cad';
      realistic: boolean;
      pose?: [[number, number, number], [number, number, number]] | null;
      // Hard cap on the readiness wait — capture proceeds at this point
      // even if some asset is still loading (slow network fallback).
      timeoutMs: number;
    }
    const shots: Shot[] = [
      { name: '01-cad-drawing', mode: 'cad', realistic: false, timeoutMs: 8000 },
      { name: '02-cad-realistic', mode: 'cad', realistic: true, timeoutMs: 15000 },
      { name: '03-yard-3d-simple', mode: '3d', realistic: false, pose: overviewPose(), timeoutMs: 8000 },
      { name: '04-yard-3d-realistic', mode: '3d', realistic: true, pose: overviewPose(), timeoutMs: 15000 },
      { name: '05-gate-entrance', mode: '3d', realistic: true, pose: gatePose(), timeoutMs: 8000 },
      { name: '06-pcs-island', mode: '3d', realistic: true, pose: islandPose(), timeoutMs: 8000 },
      { name: '07-plan-2d', mode: '2d', realistic: false, timeoutMs: 8000 },
    ];
    (async () => {
      const files: { name: string; blob: Blob }[] = [];
      try {
        for (let i = 0; i < shots.length; i++) {
          const shot = shots[i];
          if (cancelled) break;
          if (shot.pose === null) continue; // pose unavailable (e.g. no gate)
          setStillsProgress(`Capturing marketing stills… ${i + 1}/${shots.length} (Esc cancels)`);
          setViewMode(shot.mode);
          setRealisticModelsStore(shot.realistic);
          await nextFrames();
          if (shot.mode === '3d' && shot.pose) store().requestCameraPose(...shot.pose);
          // Readiness signal instead of a fixed sleep: wait until
          // THREE.DefaultLoadingManager (drei GLB cache, ground/road
          // textures, satellite drape) has settled idle, capped by the
          // per-shot hard timeout. Warm caches capture almost instantly;
          // cold loads wait exactly as long as the assets actually take.
          await waitForSceneReady({ timeoutMs: shot.timeoutMs });
          await nextFrames();
          if (cancelled) break;
          const blob = await capture();
          if (blob) files.push({ name: `${shot.name}.png`, blob });
        }
        if (!cancelled && files.length > 0) {
          const JSZip = (await import('jszip')).default;
          const zip = new JSZip();
          for (const f of files) zip.file(f.name, f.blob);
          const out = await zip.generateAsync({ type: 'blob' });
          const saved = await saveBlob(out, 'marketing-stills.zip');
          if (saved) toast.success(`Marketing stills saved (${files.length} images)`);
        } else if (cancelled) {
          toast.info('Marketing stills capture cancelled');
        } else {
          toast.error('Marketing stills capture produced no images');
        }
      } catch (err) {
        toast.error(`Marketing stills capture failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        window.removeEventListener('keydown', onKey);
        stillsBusy.current = false;
        setStillsProgress(null);
        // Restore is safe even from a stale closure: prev holds primitives
        // and the setters route through the store/localStorage.
        setViewMode(prev.viewMode);
        setRealisticModelsStore(prev.realistic);
      }
    })();
    // Effect re-run (design changed mid-capture) or unmount aborts the loop.
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [marketingStillsRequest, design]);

  // The trench camera preset is 3D-only; if it's requested while in the 2D
  // plan view, switch back to 3D (the Canvas remounts and the flight starts).
  useEffect(() => {
    if (inspectTrenchRequest > 0) setViewMode('3d');
  }, [inspectTrenchRequest]);

  // Same for the full-site overview preset.
  useEffect(() => {
    if (overviewRequest > 0) setViewMode('3d');
  }, [overviewRequest]);

  // Boundary bounding box (center + spans): used for both the overview camera
  // preset and the initial camera pose — on elongated/off-center parcels the
  // old origin-centered max-extent framing left part of the yard out of frame
  // until the drafter clicked the overview button.
  const bounds = useMemo(() => {
    // Multi-area site: frame the WHOLE project envelope, not just the area
    // being edited, so every footprint is on screen at first load. Parsed
    // back out of a rounded string signature (see siteBoundsSig) so that a
    // regenerate producing value-equal numbers cannot hand R3F a new object.
    if (siteBoundsSig) {
      const [cx, cy, spanX, spanY] = siteBoundsSig.split(',').map(Number);
      return { cx, cy, spanX, spanY };
    }
    if (!design) return { cx: 0, cy: 0, spanX: 800, spanY: 800 };
    const xs = design.boundary.polygon.map(p => p.x);
    const ys = design.boundary.polygon.map(p => p.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs);
    const minY = Math.min(...ys), maxY = Math.max(...ys);
    return {
      cx: (minX + maxX) / 2,
      cy: (minY + maxY) / 2,
      spanX: maxX - minX,
      spanY: maxY - minY,
    };
    // Keyed on the boundary (not the whole design): a regenerate/edit that
    // keeps the same fence must NOT recompute this object. New (value-equal)
    // position/target arrays make R3F re-apply the PerspectiveCamera position
    // prop and rebuild OrbitControls mid-commit, silently yanking the camera
    // back to the overview pose — losing any requestCameraPose that landed in
    // the same commit window. siteBoundsSig is a rounded string for the same
    // reason: it only changes when the site envelope actually moves.
  }, [design?.boundary, siteBoundsSig]);

  const activeAreaFitBounds = useMemo(() => {
    if (!activeAreaFitSig) return null;
    const [, values] = activeAreaFitSig.split('|');
    const [cx, cy, spanX, spanY] = (values ?? '').split(',').map(Number);
    if (![cx, cy, spanX, spanY].every(Number.isFinite)) return null;
    return { cx, cy, spanX, spanY };
  }, [activeAreaFitSig]);

  // Initial camera pose: same bounding-box fit math as OverviewFlyCamera so a
  // stretched or off-center parcel is framed correctly on first load.
  const initialCam = useMemo(() => {
    const margin = 1.15;
    const fov = 45;
    const vHalf = (fov * Math.PI / 180) / 2;
    const aspect = window.innerWidth / Math.max(1, window.innerHeight);
    const hHalf = Math.atan(Math.tan(vHalf) * aspect);
    const distV = (bounds.spanY / 2) * margin / Math.tan(vHalf);
    const distH = (bounds.spanX / 2) * margin / Math.tan(hHalf);
    // Multi-area sites use the exact corner fit (see groundRectFitDistance);
    // single-boundary sites keep the original span math untouched.
    const dist = siteBoundsSig
      ? groundRectFitDistance(bounds.cx, bounds.cy, bounds.spanX, bounds.spanY, fov, aspect, margin)
      : Math.max(distV, distH, 200);
    const dir = new THREE.Vector3(0, 1, 0.9).normalize().multiplyScalar(dist);
    const target: [number, number, number] = [bounds.cx, 0, -bounds.cy];
    const position: [number, number, number] = [
      bounds.cx + dir.x,
      dir.y,
      -bounds.cy + dir.z,
    ];
    // 2D ortho zoom fitted to the spans (pixels per foot on the tighter axis).
    const zoom = Math.min(
      window.innerHeight / Math.max(1, bounds.spanY * margin),
      window.innerWidth / Math.max(1, bounds.spanX * margin),
    );
    return { position, target, zoom };
  }, [bounds]);

  return (
    <div ref={containerRef} className="w-full h-full relative" style={placingSubstation ? { cursor: 'crosshair' } : undefined}>
      {placingSubstation && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 z-10 bg-pink-700 text-white text-xs font-semibold px-3 py-1.5 rounded shadow">
          Click anywhere on the map to place the substation (inside or outside the parcel)
        </div>
      )}
      {walkMode && (
        <>
          {/* crosshair */}
          <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-10 pointer-events-none">
            <div className="w-1.5 h-1.5 rounded-full bg-white/80 shadow" />
          </div>
          <div className="absolute top-3 left-1/2 -translate-x-1/2 z-10 bg-slate-900/85 text-slate-100 text-xs px-3 py-1.5 rounded shadow flex items-center gap-3">
            <span className="font-semibold text-cyan-300">First-person walkthrough</span>
            <span>WASD / arrows to walk · Shift to jog · click to look around · Esc releases the mouse</span>
            <button
              onClick={() => setWalkMode(false)}
              className="px-2 py-0.5 rounded bg-red-700 hover:bg-red-600 font-semibold text-white pointer-events-auto"
            >
              Exit
            </button>
          </div>
        </>
      )}
      {editMode && !placingSubstation && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 z-10 flex flex-col items-center gap-1.5">
          <div className="bg-emerald-700 text-white text-xs font-semibold px-3 py-1.5 rounded shadow">
            {editTool === 'marquee'
              ? 'Select area: drag a rectangle on the ground — every block inside it becomes a group you can drag together. Esc cancels.'
              : editTool === 'island'
                ? 'Place island: pick size, orientation and snap below, then move the pointer — a live ghost with the real equipment follows it. R rotates, arrows nudge (Shift = 1 ft, Ctrl+Shift = 10 ft), or type an exact center. Click or Enter commits; green = fits, amber = fits with a warning, red = rejected (reason on the ghost). Esc cancels and changes nothing.'
              : editTool === 'zone'
                ? 'Area zone: pick a type below, then drag a rectangle anywhere inside the parcel (outside the fence is fine). Drag an edge to move, corners to resize, click to retype, hover + Del to remove. Esc cancels.'
              : editTool === 'road'
                ? 'Draw road: click to place vertices along the road centerline; double-click or Enter to build it, Esc cancels.'
              : editTool === 'road-remove'
                ? 'Remove road: click any highlighted generated drive aisle or middle road to delete it. The edit persists and everything downstream rebuilds; you are warned if vehicle access breaks. Esc cancels.'
                : 'Edit layout: drag a block row, a purple drive aisle (up/down only, max 2 ft south — rows above follow), the trench band, or the pink MV feeder corridor (whole lane bundle slides together) — green ghost = valid, red = rejected on drop'}
          </div>
          <div className="flex rounded overflow-hidden border border-slate-600 shadow pointer-events-auto">
            <button
              onClick={() => setEditTool(t => (t === 'marquee' ? 'move' : 'marquee'))}
              title="Drag a rectangle to select all blocks inside it, then drag any of them to move the whole group together"
              className={`px-3 py-1.5 text-xs font-semibold border-r border-slate-600 ${editTool === 'marquee' ? 'bg-cyan-600 text-white' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'}`}
            >
              Select Area
            </button>
            <button
              onClick={() => setEditTool(t => (t === 'road' ? 'move' : 'road'))}
              title={`Click vertices to draw a new ${roadDrawWidth} ft access road; double-click or Enter to build it`}
              className={`px-3 py-1.5 text-xs font-semibold border-r border-slate-600 ${editTool === 'road' ? 'bg-amber-600 text-white' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'}`}
            >
              Draw Road
            </button>
            <button
              onClick={() => setEditTool(t => (t === 'road-remove' ? 'move' : 'road-remove'))}
              title="Click any road to select the whole road, then Delete. For part of one, press S (or Delete Part…) and click the far end — the cut follows the pavement between the two clicks."
              className={`px-3 py-1.5 text-xs font-semibold border-r border-slate-600 ${editTool === 'road-remove' ? 'bg-red-600 text-white' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'}`}
            >
              Remove Road
            </button>
            <button
              onClick={() => setEditTool(t => (t === 'island' ? 'move' : 'island'))}
              title="Click to place an island or single PCS module — the ghost previews exactly what commits (FJB included; aux gear and augmentation are the toggles below); R rotates"
              className={`px-3 py-1.5 text-xs font-semibold border-r border-slate-600 ${editTool === 'island' ? 'bg-emerald-600 text-white' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'}`}
            >
              Place Island
            </button>
            <button
              onClick={() => setEditTool(t => (t === 'zone' ? 'move' : 'zone'))}
              title="Drag a rectangle to draw a laydown yard, dry pond, wet pond, or underground exclusion area — validated against the parcel and other zones, shown on every drawing and export"
              className={`px-3 py-1.5 text-xs font-semibold border-r border-slate-600 ${editTool === 'zone' ? 'bg-sky-600 text-white' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'}`}
            >
              Area Zone
            </button>
            <button
              onClick={() => undoEdit()}
              disabled={undoCount === 0}
              title="Undo the last layout edit (Ctrl+Z)"
              className="px-3 py-1.5 text-xs font-semibold bg-slate-800 text-slate-300 hover:bg-slate-700 disabled:opacity-40"
            >
              ⟲ Undo{undoCount > 0 ? ` (${undoCount})` : ''}
            </button>
          </div>
          {editTool === 'island' && (
            <div className="flex items-center gap-2 pointer-events-auto">
              {/* What to place. A single module never grows a second PCS;
                  islands stay mirrored pairs. */}
              <div className="flex rounded overflow-hidden border border-slate-600 shadow">
                <button
                  onClick={() => { setPlaceKind('island'); setLivePlacementConfig({ kind: 'island' }); }}
                  title="Place a mirrored-pair island — choose the number of pair columns below"
                  className={`px-2.5 py-1.5 text-xs font-semibold border-r border-slate-600 ${placeKind === 'island' ? 'bg-emerald-600 text-white' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'}`}
                >
                  Island
                </button>
                <button
                  onClick={() => { setPlaceKind('single'); setLivePlacementConfig({ kind: 'single' }); }}
                  title="Place ONE PCS with exactly three BESS containers — the smallest placeable module; never creates a second PCS and never adds the island aux cluster"
                  className={`px-2.5 py-1.5 text-xs font-semibold border-r border-slate-600 ${placeKind === 'single' ? 'bg-emerald-600 text-white' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'}`}
                >
                  1 PCS + 3 BESS
                </button>
                <button
                  onClick={() => { setPlaceKind('single2'); setLivePlacementConfig({ kind: 'single2' }); }}
                  title="Place ONE PCS with exactly two associated BESS containers — a grouped engineer-selected manual block; automatic layouts remain 1 PCS + 3 BESS"
                  className={`px-2.5 py-1.5 text-xs font-semibold border-r border-slate-600 ${placeKind === 'single2' ? 'bg-emerald-600 text-white' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'}`}
                >
                  1 PCS + 2 BESS
                </button>
                <button
                  onClick={() => { setPlaceKind('equipment'); setLivePlacementConfig({ kind: 'equipment', equipType: placeEquipType }); }}
                  title="Place ONE auxiliary, comms, transformer or fire-control item on its own — pick which below"
                  className={`px-2.5 py-1.5 text-xs font-semibold ${placeKind === 'equipment' ? 'bg-emerald-600 text-white' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'}`}
                >
                  Single item
                </button>
              </div>
              {placeKind === 'equipment' ? (<>
                <div className="bg-slate-900/85 text-slate-300 text-xs font-semibold px-2 py-1.5 rounded shadow">
                  Item
                </div>
                <select
                  value={placeEquipType}
                  onChange={e => {
                    const t = e.target.value as ManualEquipmentType;
                    setPlaceEquipType(t);
                    setLivePlacementConfig({ kind: 'equipment', equipType: t });
                  }}
                  title="Which single item to place. Each one moves, turns and deletes like any other equipment once placed."
                  className="bg-slate-800 text-slate-200 text-xs font-semibold px-2 py-1.5 rounded border border-slate-600 shadow"
                >
                  {MANUAL_EQUIPMENT_TYPES.map(t => (
                    <option key={t} value={t}>{MANUAL_EQUIPMENT_CATALOG[t].short}</option>
                  ))}
                </select>
                <div className="bg-slate-900/85 text-slate-400 text-xs px-2 py-1.5 rounded shadow">
                  {(() => {
                    const d = MANUAL_EQUIPMENT_CATALOG[placeEquipType].dims;
                    return `${d.length} × ${d.width} ft`;
                  })()}
                </div>
              </>) : (<>
              {/* Explicit augmentation decision for THIS placement — required
                  before the drop commits, shown in the ghost and persisted. */}
              <div className="flex rounded overflow-hidden border border-slate-600 shadow">
                <button
                  onClick={() => { setPlaceAug(true); setLivePlacementConfig({ aug: true }); }}
                  title="Reserve the validated augmentation area (future units, capacity, BOM and export linework) with this placement"
                  className={`px-2.5 py-1.5 text-xs font-semibold border-r border-slate-600 ${placeAug ? 'bg-violet-600 text-white' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'}`}
                >
                  Include augmentation
                </button>
                <button
                  onClick={() => { setPlaceAug(false); setLivePlacementConfig({ aug: false }); }}
                  title="Reserve NO augmentation area at all — no reserve zone, ghost equipment, future capacity, BOM item or export linework"
                  className={`px-2.5 py-1.5 text-xs font-semibold ${!placeAug ? 'bg-violet-600 text-white' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'}`}
                >
                  No augmentation
                </button>
              </div>
              {placeKind === 'island' && (
              /* Explicit aux-cluster decision, bare by default: the cluster
                 widens the island's middle gap to house itself, so it must
                 never be added without being asked for. A SINGLE module never
                 carries one, so the choice is not offered there. */
              <div className="flex rounded overflow-hidden border border-slate-600 shadow">
                <button
                  onClick={() => { setPlaceAuxGear(false); setLivePlacementConfig({ auxGear: false }); }}
                  title="Place CORE equipment only — PCS blocks, containers and the feeder junction box. No aux transformer, aux distribution or comms cabinet, and no widened middle gap to house them."
                  className={`px-2.5 py-1.5 text-xs font-semibold border-r border-slate-600 ${!placeAuxGear ? 'bg-sky-600 text-white' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'}`}
                >
                  Core only
                </button>
                <button
                  onClick={() => { setPlaceAuxGear(true); setLivePlacementConfig({ auxGear: true }); }}
                  title="Also place the standard mid-island aux cluster (aux transformer + aux distribution + comms cabinet). The island's middle gap widens to house it."
                  className={`px-2.5 py-1.5 text-xs font-semibold ${placeAuxGear ? 'bg-sky-600 text-white' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'}`}
                >
                  + Aux cluster
                </button>
              </div>
              )}
              {placeKind === 'island' && (
              /* A dropdown, not seven buttons: the button row overflowed the
                 toolbar and sizes past QTY 4-5 were pushed out of view. */
              <label className="bg-slate-900/85 text-slate-300 text-xs font-semibold px-2 py-1 rounded shadow flex items-center gap-1.5">
                Island size
                <select
                  value={islandPairs}
                  onChange={e => {
                    const p = Number(e.target.value);
                    setIslandPairs(p); setLivePlacementConfig({ pairs: p });
                  }}
                  title={`Pairs of PCS blocks per island — up to ${ISLAND_PCS_PER_SIDE} PCS per side (full standard island)`}
                  className="bg-slate-800 border border-slate-600 rounded px-1.5 py-1 text-xs text-slate-100"
                >
                  {Array.from({ length: ISLAND_PCS_PER_SIDE }, (_, i) => i + 1).map(p => (
                    <option key={p} value={p}>
                      {p === ISLAND_PCS_PER_SIDE ? `QTY ${p} — full` : `QTY ${p}`}
                    </option>
                  ))}
                </select>
              </label>
              )}
              <div className="bg-slate-900/85 text-slate-400 text-xs px-2 py-1.5 rounded shadow">
                {placeKind === 'single' || placeKind === 'single2'
                  ? `1 PCS + ${placeKind === 'single2' ? 2 : 3} BESS`
                  : `${islandPairs * 2} blocks${islandPairs === ISLAND_PCS_PER_SIDE ? ' (full)' : ' (partial)'}`}
                {placeAug ? ' · with aug' : ' · no aug'}
                {placeKind === 'island' ? (placeAuxGear ? ' · + aux cluster' : ' · core only') : ' · core only'}
              </div>
              </>)}
              <PlacementPrecisionBar
                placeAngleDeg={placeAngleDeg}
                onAngle={a => {
                  setPlaceAngleDeg(a);
                  useDesignStore.getState().setPlacementAngle(a);
                }}
                placeSnap={placeSnap}
                onSnap={s => {
                  setPlaceSnap(s);
                  useDesignStore.getState().setPlacementSnap(s);
                }}
              />
            </div>
          )}
          {editTool === 'road' && (
            <div className="flex items-center gap-2 pointer-events-auto">
              <div className="bg-slate-900/85 text-slate-300 text-xs font-semibold px-2 py-1.5 rounded shadow">
                Road width
              </div>
              <div className="flex rounded overflow-hidden border border-slate-600 shadow">
                {([24, 30, 36] as const).map(w => (
                  <button
                    key={w}
                    onClick={() => setRoadDrawWidth(w)}
                    title={`Draw a ${w} ft wide road`}
                    className={`px-3 py-1.5 text-xs font-semibold border-r border-slate-600 last:border-r-0 ${roadDrawWidth === w ? 'bg-amber-600 text-white' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'}`}
                  >
                    {w} ft
                  </button>
                ))}
              </div>
              <div className="bg-slate-900/85 text-slate-400 text-xs px-2 py-1.5 rounded shadow">
                {roadDrawWidth === 24 ? 'standard' : roadDrawWidth === 30 ? 'wide' : 'extra-wide'}
              </div>
            </div>
          )}
          {editTool === 'zone' && (
            <div className="flex rounded overflow-hidden border border-slate-600 shadow pointer-events-auto">
              {AREA_ZONE_KIND_ORDER.map(k => (
                <button
                  key={k}
                  onClick={() => setZoneKind(k)}
                  title={`Draw a ${AREA_ZONE_LABELS[k].toLowerCase()} rectangle`}
                  className={`px-3 py-1.5 text-xs font-semibold border-r border-slate-600 last:border-r-0 ${zoneKind === k ? 'text-slate-900' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'}`}
                  style={zoneKind === k ? { backgroundColor: AREA_ZONE_COLORS[k] } : undefined}
                >
                  {AREA_ZONE_LABELS[k]}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {computing && (
        <div className="absolute bottom-3 right-3 z-10 bg-slate-900/85 text-slate-100 text-xs px-3 py-1.5 rounded shadow flex items-center gap-2">
          <div className="w-3 h-3 border-2 border-slate-400 border-t-transparent rounded-full animate-spin" />
          Recomputing layout…
        </div>
      )}
      {/* Satellite drape status: imagery is on by default, so tell the user
          why the ground may look generic while tiles fetch or if they fail. */}
      {showSatellite && satelliteStatus === 'loading' && (
        <div className="absolute bottom-3 left-3 z-10 bg-slate-900/85 text-slate-100 text-xs px-3 py-1.5 rounded shadow flex items-center gap-2">
          <div className="w-3 h-3 border-2 border-slate-400 border-t-transparent rounded-full animate-spin" />
          Loading satellite imagery…
        </div>
      )}
      {showSatellite && satelliteStatus === 'error' && (
        <div className="absolute bottom-3 left-3 z-10 bg-red-900/90 text-red-100 text-xs px-3 py-1.5 rounded shadow max-w-sm">
          Satellite imagery unavailable: {satelliteError}
        </div>
      )}
      {/* logarithmicDepthBuffer: parcel-scale scenes (thousands of feet) need
          far > 20k, which starves the standard depth buffer of precision for
          the thin ground/road/gravel layer offsets — the source of texture
          z-fighting at far zoom. */}
      {/* preserveDrawingBuffer (Canvas gl prop): the marketing stills capture
          reads the canvas back via toBlob after each shot settles; without it
          the back buffer is cleared after compositing and captures come back
          blank. Cost is one buffer copy per presented frame — negligible next
          to the parcel-scale scene itself. */}
      {/* frameloop="demand": the scene only re-renders when something changed
          (React updates auto-invalidate; OrbitControls/camera flights/walk
          mode invalidate explicitly). An idle scene renders zero frames, and
          during a drag every frame goes to real work instead of redundant
          repaints. Purely a render-scheduling change — no visual difference
          when idle and nothing export-related touches the frameloop. */}
      {glFailure !== null ? (
        // WebGL permanently unavailable. The CAD/2D Plan views fall back to
        // a plain Canvas2D renderer of the SAME composeDesignDxf display
        // list the WebGL CAD view consumes — the app stays usable (view +
        // vector exports) on WebGL-blocked browsers (e.g. mobile browsers
        // and embedded preview panes). Only the 3D view keeps the recovery
        // panel: there is no 3D without WebGL.
        viewMode !== '3d' && design ? (
          <PlanFallback2D
            design={design}
            onRetry3d={() => {
              recovery.current.attempts = 0;
              recovery.current.pending = false;
              setGlFailure(null);
              setGlRetry(r => r + 1);
            }}
          />
        ) : (
        <SceneRecoveryPanel
          detail={glFailure}
          onRetry={() => {
            recovery.current.attempts = 0;
            recovery.current.pending = false;
            setGlFailure(null);
            setGlRetry(r => r + 1);
          }}
        />
        )
      ) : !glProbeOk ? (
        // Failed probe with retries still in flight: never mount the Canvas
        // (it would throw an unhandled error from inside the renderer on
        // WebGL-disabled browsers) — hold a quiet placeholder while the
        // silent recovery backoff runs; the panel appears if it exhausts.
        <div className="w-full h-full flex items-center justify-center bg-slate-900 text-slate-400 text-sm">
          Restoring 3D view…
        </div>
      ) : (
      <CanvasErrorBoundary key={glRetry} onError={attemptRecovery}>
      <Canvas
        shadows
        key={viewMode}
        frameloop="demand"
        // While recording a tour, render at up to UHD so the 4K composite
        // captures real detail instead of an upscaled window buffer. The
        // offline renderer additionally supersamples ~1.4× above UHD and
        // downscales for cleaner linework edges (it is not racing realtime).
        // (Capped to bound GPU cost; normal sessions keep default dpr.)
        dpr={(tourRecord || offlineRenderActive) ? Math.min(offlineRenderActive ? 4 : 3, Math.max(
          window.devicePixelRatio || 1,
          Math.min(3840 / Math.max(1, containerRef.current?.clientWidth ?? 1280),
                   2160 / Math.max(1, containerRef.current?.clientHeight ?? 720))
            * (offlineRenderActive ? OFFLINE_SUPERSAMPLE : 1),
        )) : undefined}
        gl={{ logarithmicDepthBuffer: true, localClippingEnabled: true, stencil: true, preserveDrawingBuffer: true }}
        onCreated={(state) => {
          const { gl, invalidate } = state;
          const r = recovery.current;
          if (r.recoveredMount) {
            // This mount was explicitly triggered by a recovery attempt —
            // tell the drafter with a small toast, never a modal wall.
            // Consumed here so an ordinary view-switch remount (which also
            // runs onCreated) can never re-toast off a stale attempt count.
            r.recoveredMount = false;
            toast.success('3D view recovered');
          }
          // A context that stays alive for a while proves the GPU is healthy
          // again; reset the auto-retry budget for the next incident.
          clearTimeout(r.stableTimer);
          r.stableTimer = setTimeout(() => { r.attempts = 0; }, 10000);
          // Losing the live context mid-session: preventDefault is required
          // or the browser never attempts restoration. If the browser then
          // restores it, three.js re-initializes on the same canvas and a
          // repaint is all that's needed. If no restore arrives shortly,
          // rebuild the canvas silently.
          let lostTimer: ReturnType<typeof setTimeout> | undefined;
          gl.domElement.addEventListener('webglcontextlost', (e) => {
            // A canvas no longer in the document lost its context because WE
            // tore it down (view-mode switch remounts the Canvas via
            // key={viewMode}; R3F/three release the context on unmount).
            // That is intentional teardown, not a GPU failure — never
            // schedule recovery for it.
            if (!gl.domElement.isConnected) {
              clearTimeout(lostTimer);
              return;
            }
            e.preventDefault();
            clearTimeout(r.stableTimer);
            clearTimeout(lostTimer);
            lostTimer = setTimeout(() => {
              // Re-check at fire time: the canvas may have been unmounted
              // (view switch) while this timer was pending — a queued
              // recovery must never fire into the NEW canvas.
              if (!gl.domElement.isConnected) return;
              attemptRecovery('The browser lost its WebGL graphics context.');
            }, 2500);
          });
          gl.domElement.addEventListener('webglcontextrestored', () => {
            clearTimeout(lostTimer);
            if (!gl.domElement.isConnected) return; // detached canvas: ignore
            r.stableTimer = setTimeout(() => { r.attempts = 0; }, 10000);
            invalidate();
            toast.success('3D view recovered');
          });
        }}
      >
        <DragPerformance active={dragging} />
        <VisibilityRevive onDeadContext={() => attemptRecovery('The browser lost its WebGL graphics context while the tab was hidden.')} />
        <PosePersistence savedPose={savedPose} restorePending={poseRestorePending} viewMode={viewMode} />
        <color attach="background" args={[viewMode === 'cad' ? '#101418' : '#bcd6e8']} />
        {viewMode !== '2d' ? (
          <PerspectiveCamera makeDefault position={initialCam.position} fov={45} near={1} far={50000} />
        ) : (
          /* up=(0,0,-1): with the camera pointing straight down, the default
              +Y up vector is degenerate (parallel to the view direction) and
              the lookAt/OrbitControls tie-break resolved to a south-up screen
              — the 2D plan and satellite drape rendered rotated 180° from
              reality. Scene -Z is plan north, so pinning up to -Z makes the
              plan view deterministically north-up. */
          <OrthographicCamera makeDefault position={[initialCam.target[0], 5000, initialCam.target[2]]} up={[0, 0, -1]} zoom={initialCam.zoom} near={1} far={20000} />
        )}
        <ambientLight intensity={viewMode === '3d' ? 0.7 : 1.0} />
        <directionalLight
          position={[300, 600, 300]}
          intensity={1.1}
          castShadow
          shadow-mapSize={[2048, 2048]}
        />
        {design ? (
          <>
            <DesignContent design={design} editMode={editMode} realistic={realisticModels && viewMode !== '2d'} is3D={viewMode === '3d'} cad={viewMode === 'cad'} onDraggingChange={setDragging} editTool={editTool} onEditToolChange={setEditTool} zoneKind={zoneKind} islandPairs={islandPairs} placeKind={placeKind} placeAug={placeAug} placeAuxGear={placeAuxGear} placeEquipType={placeEquipType} placeAngleDeg={placeAngleDeg} placeSnap={placeSnap} roadDrawWidth={roadDrawWidth} onSelectedIslandChange={setSelIsland} onSelectedTargetChange={setNudgeTarget} onSelectedEquipChange={setSelEquip} onRoadSelectionChange={setRoadSelInfo} cadLayerVis={cadLayerVis} onSelectText={setCadSelectedText} />
            {viewMode !== 'cad' && drawingVisibility.dimensions &&
              <SpacingDimensions design={design} is3D={viewMode === '3d'} />}
          </>
        ) : (
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.25, 0]}>
            <planeGeometry args={[2000, 2000]} />
            <meshStandardMaterial color="#8a7f5c" />
          </mesh>
        )}
        <OrbitControls
          makeDefault
          target={initialCam.target}
          enabled={!dragging && !walkMode && !tourActive}
          enableRotate={viewMode !== '2d'}
          maxPolarAngle={Math.PI / 2.05}
        />
        {viewMode === '3d' && !walkMode && !tourActive && design?.trench && <TrenchFlyCamera trench={design.trench} />}
        {viewMode === '3d' && !walkMode && !tourActive && design && <OverviewFlyCamera bounds={bounds} />}
        {viewMode === '3d' && !walkMode && !tourActive && design && siteBoundsSig && (
          <SiteFitCamera sig={siteBoundsSig} bounds={bounds} />
        )}
        {/* Active-area fit is mounted for EVERY navigable view — switching the
            editable area must reframe the 2D plan and CAD sheet too. */}
        {!walkMode && !tourActive && design && activeAreaFitSig && (
          <ActiveAreaFitCamera sig={activeAreaFitSig} viewMode={viewMode} />
        )}
        {/* PoseCamera also serves the CAD view: the tour showcase zooms the
            CAD camera onto dims/legend via requestCameraPose. */}
        {viewMode !== '2d' && !walkMode && <PoseCamera />}
        {viewMode === '2d' && <OrthoPoseCamera />}
        {/* Hi-fi cover renders come from the REAL 3D yard only. In CAD view
            the scene contains the sheet display list (dark ground, linework,
            text panels) — capturing that rasterizes title-block text into the
            cover's aerial panel. CAD/2D exports fall back to the satellite
            photo + pure vector key plan instead. */}
        {viewMode === '3d' && <CoverRenderCapture />}
        {viewMode === '3d' && walkMode && design && <FirstPersonMode design={design} />}
        {viewMode === '3d' && tourActive && tourPhase === 'path' && design && <CinematicTourCamera design={design} />}
      </Canvas>
      </CanvasErrorBoundary>
      )}

      {/* CAD sheet annotations in 2D plan view */}
      {viewMode === '2d' && design && <SheetAnnotations2D />}

      {/* White fade-up between the tour's DC reroute beat and the resumed
          drive — a recorder-visible overlay canvas (path phase only). */}
      {tourActive && tourPhase === 'path' && <TourFadeOverlay />}
      {/* Cinematic tour: minimal stop affordance — every other control is
          hidden while the camera flies so recordings stay clean. */}
      {tourActive && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 z-30 bg-slate-900/70 text-slate-100 text-xs px-3 py-1.5 rounded shadow flex items-center gap-3">
          <span className="font-semibold text-cyan-300">Cinematic tour{tourRecord ? ' · recording' : ''}</span>
          <span>{tourPhase === 'showcase' ? 'Esc to stop' : 'Esc or click to stop'}</span>
        </div>
      )}
      {/* Scripted showcase segment: CAD zoom → realistic reveal → plot/BOM/SLD
          sheet overlays. Presentation-only; restores view + toggles on exit. */}
      {tourActive && tourPhase === 'showcase' && design && (
        <TourShowcase
          design={design}
          viewMode={viewMode}
          setViewMode={setViewMode}
          prevViewMode={tourPrevView.current}
        />
      )}
      {offlineProgress !== null && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 z-30 bg-slate-900/85 text-slate-100 text-xs px-3 py-1.5 rounded shadow flex items-center gap-2">
          <div className="w-3 h-3 border-2 border-cyan-400 border-t-transparent rounded-full animate-spin" />
          Rendering offline 4K video — {Math.round(offlineProgress * 100)}% (Esc cancels)
        </div>
      )}
      {stillsProgress && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 z-10 bg-slate-900/85 text-slate-100 text-xs px-3 py-1.5 rounded shadow flex items-center gap-2">
          <div className="w-3 h-3 border-2 border-slate-400 border-t-transparent rounded-full animate-spin" />
          {stillsProgress}
        </div>
      )}

      {/* Marketing capture bar: cinematic tour, tour recording, stills */}
      {design && !tourActive && !stillsProgress && (
        <div className="absolute top-3 left-3 z-10 flex rounded overflow-hidden border border-slate-600 shadow">
          <button
            onClick={() => startCinematicTour(false)}
            title="Cinematic site tour: orbits the yard from above, dives to the gate entrance, glides through the site and pulls up to the full-yard view (~45–60 s; Esc stops)"
            className="px-3 py-1.5 text-xs font-semibold bg-slate-800 text-slate-300 hover:bg-slate-700 border-r border-slate-600"
          >
            🎬 Tour
          </button>
          <button
            onClick={() => startCinematicTour(true)}
            title="Play the cinematic tour and record it to a video file (WebM/MP4) for marketing"
            className="px-3 py-1.5 text-xs font-semibold bg-slate-800 text-slate-300 hover:bg-slate-700 border-r border-slate-600"
          >
            ⏺ Record
          </button>
          <button
            onClick={() => useDesignStore.getState().requestOfflineRender({ fps: offlineFps })}
            title={`Offline render: steps the tour frame by frame and encodes a flawless 4K ${offlineFps} fps video (WebCodecs), saving BOTH an MP4 (H.264) and a WebM of the same recording — takes longer than the tour itself, but never drops a frame. Covers the 3D flight AND the CAD/plot/BOM/SLD showcase.`}
            className="px-3 py-1.5 text-xs font-semibold bg-slate-800 text-slate-300 hover:bg-slate-700"
          >
            ✨ 4K{offlineFps}
          </button>
          <button
            onClick={() => setShowOfflineQuality(v => !v)}
            title="Offline render quality: frame rate (30/60); one render saves both MP4 and WebM"
            className={`px-1.5 py-1.5 text-xs font-semibold border-r border-slate-600 ${showOfflineQuality ? 'bg-slate-600 text-white' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'}`}
            data-testid="offline-quality-toggle"
          >
            ▾
          </button>
          <button
            onClick={() => setShowTourOptions(v => !v)}
            title="Tour options: duration preset and which stops the camera visits"
            className={`px-3 py-1.5 text-xs font-semibold border-r border-slate-600 ${showTourOptions ? 'bg-slate-600 text-white' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'}`}
          >
            ⚙
          </button>
          <button
            onClick={() => useDesignStore.getState().requestMarketingStills()}
            title="Capture a marketing image set: CAD drawing (plain + realistic), 3D yard (simple + realistic), gate entrance, PCS island close-up and 2D plan — downloads as one zip"
            className="px-3 py-1.5 text-xs font-semibold bg-slate-800 text-slate-300 hover:bg-slate-700"
          >
            📸 Stills
          </button>
        </div>
      )}

      {/* Offline render quality popover: fps for the ✨ render (both files saved) */}
      {design && !tourActive && !stillsProgress && showOfflineQuality && (
        <div className="absolute top-12 left-3 z-20 w-56 bg-slate-900/95 border border-slate-600 rounded shadow-lg p-3 text-xs text-slate-200 space-y-3" data-testid="offline-quality-popover">
          <div>
            <div className="font-semibold text-slate-100 mb-1.5">Frame rate</div>
            <div className="flex rounded overflow-hidden border border-slate-600">
              {([30, 60] as const).map(f => (
                <button
                  key={f}
                  onClick={() => setOfflineFps(f)}
                  data-testid={`offline-fps-${f}`}
                  className={`flex-1 px-1.5 py-1 ${offlineFps === f ? 'bg-cyan-700 text-white' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'}`}
                >
                  {f} fps
                </button>
              ))}
            </div>
            <div className="text-slate-400 mt-1">30 fps roughly halves render time.</div>
          </div>
          <div>
            <div className="font-semibold text-slate-100 mb-1.5">Format</div>
            <div className="text-slate-300" data-testid="offline-container-both">
              One render saves <span className="font-semibold text-slate-100">both files</span>: MP4 (H.264) + WebM.
            </div>
            <div className="text-slate-400 mt-1">MP4 plays everywhere; WebM keeps the highest quality. If this browser can't encode H.264 you still get the WebM.</div>
          </div>
        </div>
      )}

      {/* Tour options popover: duration preset + which stops the camera visits */}
      {design && !tourActive && !stillsProgress && showTourOptions && (
        <div className="absolute top-12 left-3 z-20 w-56 bg-slate-900/95 border border-slate-600 rounded shadow-lg p-3 text-xs text-slate-200 space-y-3">
          <div>
            <div className="font-semibold text-slate-100 mb-1.5">Tour length</div>
            <div className="flex rounded overflow-hidden border border-slate-600">
              {([['short', 'Short ~30s'], ['standard', 'Standard'], ['extended', 'Extended']] as const).map(([val, label]) => (
                <button
                  key={val}
                  onClick={() => setTourOptions({ preset: val })}
                  className={`flex-1 px-1.5 py-1 ${(tourOptions.preset ?? 'standard') === val ? 'bg-cyan-700 text-white' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'}`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div>
            <div className="font-semibold text-slate-100 mb-1.5">Stops</div>
            {([
              ['intro', 'Title intro', false],
              ['orbit', 'High orbit', false],
              ['gateDive', 'Gate dive', true],
              ['driveThrough', 'Drive-through', true],
              ['equipmentCloseup', 'Equipment close-up', true],
              ['pullUp', 'Pull-up finale', false],
              ['realisticFlight', 'Realistic models', false],
            ] as const).map(([key, label, needsGate]) => {
              const disabled = needsGate && !design.gate;
              // Drive-through and realistic-flight are opt-in (the long road
              // drive and the heavy GLB models are off by default); every
              // other stop defaults on.
              const stopOn = (k: 'intro' | 'orbit' | 'gateDive' | 'driveThrough' | 'equipmentCloseup' | 'pullUp' | 'realisticFlight') =>
                k === 'driveThrough' || k === 'realisticFlight' ? tourOptions[k] === true : tourOptions[k] !== false;
              const checked = stopOn(key);
              // Keep at least one main stop on (the pull-up alone has too few
              // keyframes to fly): a tour with every phase off can't play.
              // Overlay-style options (pull-up, realistic models) are not
              // flight phases, so they never lock as the "last one on".
              const otherMains = (['orbit', 'gateDive', 'driveThrough'] as const)
                .filter(k => k !== key && stopOn(k) && (k === 'orbit' || !!design.gate));
              const lastOn = key !== 'pullUp' && key !== 'realisticFlight' && checked && otherMains.length === 0;
              return (
                <label key={key} className={`flex items-center gap-2 py-0.5 ${disabled ? 'opacity-40' : 'cursor-pointer'}`}>
                  <input
                    type="checkbox"
                    disabled={disabled || lastOn}
                    checked={checked && !disabled}
                    onChange={e => setTourOptions({ [key]: e.target.checked })}
                  />
                  <span>{label}{disabled ? ' (no gate)' : ''}</span>
                </label>
              );
            })}
            {/* Intro title/subtitle text overrides: replace the KMZ-derived
                title card text for marketing clips. Blank = KMZ default. */}
            {tourOptions.intro !== false && (
              <div className="pl-5 space-y-1 py-0.5">
                <input
                  type="text"
                  value={tourOptions.introTitle ?? ''}
                  onChange={e => setTourOptions({ introTitle: e.target.value || undefined })}
                  placeholder={`Title: ${(design.boundary.kmlName || design.boundary.name || 'BESS SITE').toUpperCase()}`}
                  className="w-full bg-slate-800 border border-slate-600 rounded px-1 py-0.5 text-slate-200 placeholder:text-slate-500"
                />
                <input
                  type="text"
                  value={tourOptions.introSubtitle ?? ''}
                  onChange={e => setTourOptions({ introSubtitle: e.target.value || undefined })}
                  placeholder="Subtitle: location · acreage"
                  className="w-full bg-slate-800 border border-slate-600 rounded px-1 py-0.5 text-slate-200 placeholder:text-slate-500"
                />
                {/* Live render of the title card (shared drawTourIntro) so
                    wording/fit can be checked without recording a tour. */}
                <TourIntroPreview design={design} />
              </div>
            )}
            {/* Which PCS block the equipment close-up circles. Falls back to
                nearest-to-gate when the pick can't host a valid arc. */}
            {(() => {
              const pcsUnits = design.equipment.filter(e => e.kind === 'inverter');
              const closeupOn = tourOptions.equipmentCloseup !== false && !!design.gate;
              if (!pcsUnits.length || !closeupOn) return null;
              const cur = tourOptions.closeupTarget && pcsUnits.some(e => e.id === tourOptions.closeupTarget)
                ? tourOptions.closeupTarget : '';
              return (
                <label className="flex items-center gap-2 py-0.5 pl-5">
                  <span className="text-slate-400">Close-up PCS</span>
                  <select
                    value={cur}
                    onChange={e => setTourOptions({ closeupTarget: e.target.value || undefined })}
                    className="flex-1 bg-slate-800 border border-slate-600 rounded px-1 py-0.5 text-slate-200"
                  >
                    <option value="">Nearest to gate</option>
                    {pcsUnits.map(e => (
                      <option key={e.id} value={e.id}>{e.label ?? e.id}</option>
                    ))}
                  </select>
                </label>
              );
            })()}
            {/* Feeder fly-along: follows a routed MV feeder from the
                substation to its island with the stat-card overlay. */}
            {(() => {
              const available = tourFeeders.length > 0 && !!tourSubstation;
              const checked = tourOptions.feederFlyalong !== false;
              return (
                <label className={`flex items-center gap-2 py-0.5 ${available ? 'cursor-pointer' : 'opacity-40'}`}>
                  <input
                    type="checkbox"
                    disabled={!available}
                    checked={checked && available}
                    onChange={e => setTourOptions({ feederFlyalong: e.target.checked })}
                  />
                  <span>Feeder fly-along{available ? '' : ' (no feeders)'}</span>
                </label>
              );
            })()}
          </div>
          <div>
            <div className="font-semibold text-slate-100 mb-1.5">Showcase</div>
            {/* Post-flyover deliverable stops. Unlike the camera stops, ALL
                of these may be off — the tour then ends right after the
                flyover (a short camera-only clip). */}
            {([
              ['showcaseCad', 'CAD zoom'],
              ['showcaseRealistic', 'Realistic reveal'],
              ['showcasePlot', 'Design plot'],
              ['showcaseGrounding', 'Grounding plan'],
              ['showcaseBom', 'BOM sheet'],
              ['showcaseSld', 'Single-line diagram'],
            ] as const).map(([key, label]) => (
              <label key={key} className="flex items-center gap-2 py-0.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={tourOptions[key] !== false}
                  onChange={e => setTourOptions({ [key]: e.target.checked })}
                />
                <span>{label}</span>
              </label>
            ))}
          </div>
        </div>
      )}

      {/* One-click alignment — all rows, or just the selected island */}
      {design && (design.blockRows.length > 0 || (design.islands ?? []).length > 0) && !tourActive && (
        <div className="absolute top-12 right-3 flex items-center rounded overflow-hidden border border-slate-600 shadow">
          {(() => {
            const islandNs = (design.islands ?? []).map(i => i.n);
            // Validate the pick against the CURRENT layout (regeneration can
            // renumber or remove islands).
            const target = pickedIsland !== null && islandNs.includes(pickedIsland)
              ? pickedIsland : null;
            const cyclePick = () => {
              if (!islandNs.length) return;
              const order: (number | null)[] = [null, ...islandNs];
              const next = order[(order.indexOf(target) + 1) % order.length];
              setPickedIsland(next);
            };
            return (
              <>
                {islandNs.length > 0 ? (
                  <button
                    onClick={cyclePick}
                    title="Choose what the align buttons act on: all block rows, or one island (click to cycle; selecting an island's equipment in Edit Layout also targets it)"
                    className={`px-2 py-1.5 text-xs font-semibold border-r border-slate-600 ${target !== null ? 'bg-cyan-700 text-white' : 'bg-slate-900/85 text-slate-400'} hover:bg-slate-700 select-none`}
                  >
                    {target !== null ? `Island ${target} ▾` : 'All rows ▾'}
                  </button>
                ) : (
                  <span className="px-2 py-1.5 text-xs font-semibold bg-slate-900/85 text-slate-400 border-r border-slate-600 select-none">
                    Align
                  </span>
                )}
                {(['left', 'center', 'right'] as const).map(m => (
                  <button
                    key={m}
                    onClick={() => {
                      const island = target;
                      // Placed islands are not part of the row machinery —
                      // left/right route through the anchor-based compact.
                      const placed = island !== null &&
                        (design.islands ?? []).find(i => i.n === island)?.placed === true;
                      if (placed && m !== 'center') {
                        const dir = m === 'left' ? 'W' as const : 'E' as const;
                        const ok = compactIsland(dir, island);
                        const reason = useDesignStore.getState().lastRejection;
                        if (ok) toast.success(`Island ${island} compacted ${dir === 'W' ? 'west' : 'east'}`);
                        else toast.info(reason
                          ? `Compact rejected: ${reason}`
                          : `Island ${island} is already at its ${dir === 'W' ? 'west' : 'east'} limit — nothing to move`);
                        return;
                      }
                      const ok = island !== null ? alignIsland(island, m) : alignRows(m);
                      const reason = useDesignStore.getState().lastRejection;
                      if (ok) {
                        const base = island !== null
                          ? (m === 'center' ? `Island ${island} centered in the yard` : `Island ${island} aligned ${m}`)
                          : (m === 'center' ? 'Rows centered in the yard' : `Rows aligned ${m}`);
                        toast.success(
                          base + (reason ? ` — some rows kept their automatic position: ${reason}` : '')
                        );
                      } else {
                        toast.info(reason
                          ? `Alignment rejected: ${reason}`
                          : (island !== null
                              ? `Island ${island} is already aligned — nothing to move`
                              : 'Rows are already aligned — nothing to move'));
                      }
                    }}
                    title={target !== null
                      ? `Align island ${target} ${m === 'center' ? 'centered' : m} within the fenced yard (moves as a rigid unit; clearances enforced, rejected moves keep the current position)`
                      : `Align all block rows ${m === 'center' ? 'centered' : m} within the fenced yard (clearances enforced; rejected rows keep their automatic position)`}
                    className="px-3 py-1.5 text-xs font-semibold bg-slate-800 text-slate-300 hover:bg-slate-700 border-r border-slate-600"
                  >
                    {m === 'left' ? 'Left' : m === 'center' ? 'Center' : 'Right'}
                  </button>
                ))}
                {(['N', 'S'] as const).map(d => (
                  <button
                    key={d}
                    onClick={() => {
                      const island = target;
                      const aislesBefore = design.aisles.length;
                      const ok = compactIsland(d, island);
                      const reason = useDesignStore.getState().lastRejection;
                      const word = d === 'N' ? 'north' : 'south';
                      if (ok) {
                        const st = useDesignStore.getState();
                        const aislesAfter = st.design?.aisles.length ?? aislesBefore;
                        const base = island !== null
                          ? `Island ${island} compacted ${word}`
                          : `Rows compacted ${word} — roads rebuilt around the new positions`;
                        toast.success(
                          base + (reason ? ` — some rows kept their position: ${reason}` : '')
                        );
                        // Road character changed (an interior drive aisle was
                        // absorbed or added): point at the existing ring
                        // choices instead of changing anything silently.
                        if (island === null && aislesAfter !== aislesBefore) {
                          toast.info('The drive-aisle layout changed with the compact. Review the perimeter ring style (Full fence / Shrink to fit / Hybrid) and per-side road offsets in the Roads panel if the ring should follow the new cluster.');
                        }
                      } else {
                        toast.info(reason
                          ? `Compact rejected: ${reason}`
                          : (island !== null
                              ? `Island ${island} is already at its ${word} limit — nothing to move`
                              : `Rows are already compacted ${word} — nothing to move`));
                      }
                    }}
                    title={target !== null
                      ? `Compact island ${target} ${d === 'N' ? 'north' : 'south'} — pull it toward the ${d === 'N' ? 'north' : 'south'} fence edge as far as clearances allow (roads rebuild around the new position; blocked moves are rejected)`
                      : `Compact all rows ${d === 'N' ? 'north' : 'south'} — gravity-pack the rows toward the ${d === 'N' ? 'north' : 'south'} fence edge (drive-aisle pitch preserved, roads rebuild; rejected rows keep their position)`}
                    className="px-3 py-1.5 text-xs font-semibold bg-slate-800 text-slate-300 hover:bg-slate-700 border-r border-slate-600"
                  >
                    {d === 'N' ? 'N ↑' : 'S ↓'}
                  </button>
                ))}
                <button
                  onClick={() => {
                    if (target === null) {
                      toast.info('Pick an island first — vertical centering works per island (click the selector on the left).');
                      return;
                    }
                    const ok = vcenterIsland(target);
                    const reason = useDesignStore.getState().lastRejection;
                    if (ok) toast.success(`Island ${target} centered between its north/south limits`);
                    else toast.info(reason
                      ? `Vertical centering rejected: ${reason}`
                      : `Island ${target} is already vertically centered — nothing to move`);
                  }}
                  title={target !== null
                    ? `Center island ${target} vertically — midway between its north and south clearance limits (validated shift; blocked moves keep the current position)`
                    : `Pick an island to center it vertically between its north and south clearance limits`}
                  className={`px-3 py-1.5 text-xs font-semibold bg-slate-800 text-slate-300 hover:bg-slate-700 ${islandNs.length >= 2 ? 'border-r border-slate-600' : ''}`}
                >
                  Mid ↕
                </button>
                {/* Center / Restore act on the SAME thing the arrow keys
                    move (a PCS block or a whole island), so precise keyboard
                    work and these one-click recoveries never disagree. */}
                {nudgeTarget && (
                  <>
                    <button
                      onClick={() => {
                        const ok = nudgeTarget.kind === 'block'
                          ? centerBlocks([nudgeTarget.n])
                          : nudgeTarget.placed
                            ? centerPlacedIsland(nudgeTarget.n)
                            : centerBlocks(nudgeTarget.blockNs);
                        const reason = useDesignStore.getState().lastRejection;
                        const what = nudgeTarget.kind === 'block'
                          ? `PCS block ${nudgeTarget.n}` : `Island ${nudgeTarget.n}`;
                        if (ok) toast.success(`${what} centered in its available space`);
                        else toast.info(reason
                          ? `Centering rejected: ${reason}`
                          : `${what} is already centered — nothing to move`);
                      }}
                      title="Center the selected block or island midway between its real clearance limits (fence, roads, NFPA setbacks and neighbouring equipment)"
                      className="px-3 py-1.5 text-xs font-semibold bg-slate-800 text-slate-300 hover:bg-slate-700 border-l border-slate-600"
                    >
                      Center
                    </button>
                    {!(nudgeTarget.kind === 'island' && nudgeTarget.placed) && (
                      <button
                        onClick={() => {
                          const ns = nudgeTarget.kind === 'block' ? [nudgeTarget.n] : nudgeTarget.blockNs;
                          const ok = restoreAutoPosition(ns);
                          const what = nudgeTarget.kind === 'block'
                            ? `PCS block ${nudgeTarget.n}` : `Island ${nudgeTarget.n}`;
                          if (ok) toast.success(`${what} restored to its automatic position`);
                          else toast.info(`${what} is already at its automatic position — nothing to restore`);
                        }}
                        title="Discard manual moves for the selected block or island and return it to the automatically generated position"
                        className="px-3 py-1.5 text-xs font-semibold bg-slate-800 text-slate-300 hover:bg-slate-700 border-l border-slate-600"
                      >
                        Restore
                      </button>
                    )}
                    {/* Deleting is a normal layout edit (undoable, persisted),
                        and it acts on exactly what Center/Restore and the
                        arrow keys act on. Also bound to the Delete key. */}
                    <button
                      onClick={() => {
                        if (nudgeTarget.kind === 'block') {
                          const note = deleteBlock(nudgeTarget.n);
                          if (note) toast.warning(note, { duration: 8000 });
                          else toast.success(`PCS block ${nudgeTarget.n} deleted — layout, feeders, trenching and exports updated`);
                          return;
                        }
                        if (nudgeTarget.placed) {
                          const spec = (useDesignStore.getState().layoutEdits.placedIslands ?? [])
                            .find(p => nudgeTarget.placedId ? p.id === nudgeTarget.placedId : false);
                          if (spec) {
                            removePlacedIsland(spec.id);
                            toast.success('Hand-placed island deleted — site regenerated');
                          } else {
                            toast.error('Could not identify that hand-placed island — use the ✕ handle above it.');
                          }
                          return;
                        }
                        // Same single transaction the Delete key runs: one
                        // regeneration and one undo step for the whole island.
                        const { deleted, note } = deleteAutoIsland(nudgeTarget.blockNs);
                        if (deleted) toast.success(`Island ${nudgeTarget.n} deleted (${deleted} block${deleted === 1 ? '' : 's'}) — layout, feeders, trenching and exports updated`);
                        else if (!note) toast.info(`Island ${nudgeTarget.n} is already deleted.`);
                        if (note) toast.warning(note, { duration: 8000 });
                      }}
                      title={nudgeTarget.kind === 'block'
                        ? `Delete PCS block ${nudgeTarget.n} (its inverter, containers and augmentation bay). Feeders, trenching, capacity, the BOM and every export rebuild without it. Undoable.`
                        : `Delete island ${nudgeTarget.n} and all of its blocks. Feeders, trenching, capacity, the BOM and every export rebuild without it. Undoable.`}
                      className="px-3 py-1.5 text-xs font-semibold bg-red-900/80 text-red-100 hover:bg-red-800 border-l border-slate-600"
                    >
                      Delete
                    </button>
                  </>
                )}
                {/* Equipment-scope selection: a single selected item gets its
                    own visible Delete. The wider scope owns the toolbar, so
                    this renders only when no nudge target is active. */}
                {!nudgeTarget && selEquip && (
                  <>
                    <span className="px-2.5 py-1.5 text-xs text-slate-300 border-l border-slate-600 select-none whitespace-nowrap">
                      {selEquip.label}
                    </span>
                    <button
                      onClick={() => {
                        if (selEquip.placedId) {
                          removePlacedIsland(selEquip.placedId);
                          toast.success('Hand-placed island deleted — site regenerated');
                          return;
                        }
                        const note = deleteEquipment(selEquip.id);
                        if (note) toast.warning(note, { duration: 8000 });
                        else toast.success(`${selEquip.label} deleted — layout, trenching and exports updated`);
                      }}
                      title={selEquip.placedId
                        ? `${selEquip.label} belongs to hand-placed island ${selEquip.placedIslandN}. Deleting removes the whole placement — it is placed as one unit. Undoable.`
                        : `Delete ${selEquip.label}. Feeders, trenching, the BOM and every export rebuild without it. Undoable.`}
                      className="px-3 py-1.5 text-xs font-semibold bg-red-900/80 text-red-100 hover:bg-red-800 border-l border-slate-600"
                    >
                      {selEquip.placedId ? 'Delete Island' : 'Delete'}
                    </button>
                  </>
                )}
                {/* Road selection: road-kind label chip + Delete Part / Delete
                    buttons. The kind chip names the exact road under the
                    selection so the drafter knows what they are about to
                    remove. Delete Part… is shown for a single selected road
                    and is the primary way to discover the span-cut flow
                    (the S shortcut still works as a backup). In span mode the
                    chip shows the prompt instead of the road name. */}
                {roadSelInfo && (
                  <>
                    {/* Span-cut only applies to roads that actually pave —
                        a linework-only traced strip (onPave present) has no
                        pavement for the cut to follow. */}
                    {roadSelInfo.labels.length === 1 && !roadSelInfo.spanArmed && !roadSelInfo.onPave && (
                      <button
                        onClick={roadSelInfo.onSpan}
                        title="Delete only PART of this road: click the far end of the stretch. The cut FOLLOWS the pavement between your two clicks — around corners and junctions — and is measured across the road's own width."
                        className="px-3 py-1.5 text-xs font-semibold bg-slate-800 text-slate-300 hover:bg-slate-700 border-l border-slate-600"
                      >
                        Delete Part…
                      </button>
                    )}
                    {/* Pave-as-drawn override for a traced strip the
                        gate-apron rule keeps as reference linework: the
                        drafter confirms it really is on-parcel pavement.
                        Keep-and-warn, like the drawn-road accept gates. */}
                    {roadSelInfo.onPave && !roadSelInfo.spanArmed && (
                      <button
                        onClick={roadSelInfo.onPave}
                        title="Force-pave this traced strip exactly as drawn. The tool keeps it as reference linework because it does not read as the gate approach (too long or too far from the gate); pave it anyway if it really is on-parcel pavement. A warning stays on the design so the override is visible. Undoable."
                        className="px-3 py-1.5 text-xs font-semibold bg-amber-700/90 text-amber-50 hover:bg-amber-600 border-l border-slate-600"
                      >
                        Pave as Drawn
                      </button>
                    )}
                    <button
                      onClick={roadSelInfo.onDelete}
                      disabled={!roadSelInfo.labels.length}
                      title={`Delete ${roadSelInfo.labels.length === 1 ? roadSelInfo.labels[0] : `${roadSelInfo.labels.length} selected roads`}. The road network, crushed-rock surfacing, cables, feeders and every export rebuild without it. Undoable.`}
                      className="px-3 py-1.5 text-xs font-semibold bg-red-900/80 text-red-100 hover:bg-red-800 border-l border-slate-600 disabled:opacity-40"
                    >
                      {roadSelInfo.labels.length > 1 ? `Delete ${roadSelInfo.labels.length} Roads` : 'Delete Road'}
                    </button>
                  </>
                )}
                {islandNs.length >= 2 && (
                  <button
                    onClick={() => {
                      const island = target ?? islandNs[islandNs.length - 1];
                      const ok = mirrorAlignIsland(island);
                      const reason = useDesignStore.getState().lastRejection;
                      if (ok) toast.success(`Island ${island} mirror-aligned with its neighbor island`);
                      else toast.info(reason
                        ? `Mirror alignment rejected: ${reason}`
                        : `Island ${island} is already aligned with its neighbor — nothing to move`);
                    }}
                    title={target !== null
                      ? `Slide island ${target} sideways so it lines up with its stacked neighbor island (symmetric design; clearances enforced, blocked moves are rejected)`
                      : `Pick an island first, or Mirror moves the last island onto its stacked neighbor (symmetric design; clearances enforced)`}
                    className="px-3 py-1.5 text-xs font-semibold bg-slate-800 text-slate-300 hover:bg-slate-700"
                  >
                    Mirror
                  </button>
                )}
              </>
            );
          })()}
        </div>
      )}

      {/* View mode + edit mode toggles */}
      {!tourActive && (
      <div className="absolute top-3 right-3" style={{ zIndex: 10 }}>
        <div className="flex rounded overflow-hidden border border-slate-600 shadow">
          <button
            onClick={() => { setEditMode(m => !m); setEditTool('move'); setDragging(false); }}
            disabled={!design}
            title="Click equipment to select (click again to widen to block/row), drag to move; rows, drive aisles (up/down, rows above follow), trench, laydown and future blocks are draggable too"
            className={`px-3 py-1.5 text-xs font-semibold border-r border-slate-600 disabled:opacity-40 ${editMode ? 'bg-emerald-600 text-white' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'}`}
          >
            Edit Layout
          </button>
          {viewMode !== '2d' && (
          <button
            onClick={() => setRealisticModels(!realisticModels)}
            disabled={!design}
            title="Show uploaded manufacturer 3D models (PCS, BESS container, fire panel) instead of simple boxes — 3D and CAD views; layout and DXF are unaffected"
            className={`px-3 py-1.5 text-xs font-semibold border-r border-slate-600 disabled:opacity-40 ${realisticModels ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'}`}
          >
            Realistic
          </button>
          )}
          {viewMode !== '2d' && (
          <button
            type="button"
            data-testid="drawing-labels-toggle"
            aria-pressed={drawingVisibility.labels}
            onClick={() => setDrawingVisibility({ labels: !drawingVisibility.labels })}
            disabled={!design}
            title={drawingVisibility.labels
              ? 'Labels are shown in CAD, 3D, and issued drawing exports. Click to hide them everywhere.'
              : 'Labels are hidden in CAD, 3D, and issued drawing exports. Click to show them everywhere.'}
            className={`px-3 py-1.5 text-xs font-semibold border-r border-slate-600 disabled:opacity-40 ${
              drawingVisibility.labels
                ? 'bg-emerald-600 text-white hover:bg-emerald-500'
                : 'bg-amber-900/80 text-amber-200 hover:bg-amber-800'
            }`}
          >
            Labels {drawingVisibility.labels ? 'On' : 'Off'}
          </button>
          )}
          <button
            onClick={() => setViewMode('3d')}
            className={`px-3 py-1.5 text-xs font-semibold ${viewMode === '3d' ? 'bg-cyan-600 text-white' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'}`}
          >
            3D
          </button>
          <button
            onClick={() => { if (walkMode) setWalkMode(false); setViewMode('cad'); }}
            title="CAD drawing view: the exported DXF linework (layers, labels, dims, sheet frame) rendered in the interactive 3D scene — orbit, edit and realistic models all work; exports are unaffected"
            className={`px-3 py-1.5 text-xs font-semibold border-r border-slate-600 ${viewMode === 'cad' ? 'bg-cyan-600 text-white' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'}`}
          >
            CAD
          </button>
          <button
            onClick={() => { if (walkMode) setWalkMode(false); setViewMode('2d'); }}
            className={`px-3 py-1.5 text-xs font-semibold ${viewMode === '2d' ? 'bg-cyan-600 text-white' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'}`}
          >
            2D Plan
          </button>
        </div>
        {/* [662] CAD text-label edit panel — floats below the toolbar when a
            label is selected in CAD view. Shows the current override delta, text,
            and height; drag in the CAD view also updates this panel live. */}
        {viewMode === 'cad' && cadSelectedText && (
          <div className="absolute top-full right-0 mt-1 bg-slate-900 border border-amber-500/50 rounded shadow-xl p-3 text-xs text-slate-200 min-w-[240px] z-20 pointer-events-auto">
            <div className="font-semibold text-amber-400 uppercase tracking-wide mb-2 text-[10px]">Edit Text Label</div>
            <div className="text-slate-400 mb-2 truncate" title={cadSelectedText.origText}>
              <span className="text-slate-300 font-mono">{cadSelectedText.origText.slice(0, 32)}{cadSelectedText.origText.length > 32 ? '…' : ''}</span>
            </div>
            <div className="space-y-1.5">
              <label className="flex items-center gap-2">
                <span className="text-slate-400 w-16 shrink-0">X offset</span>
                <input
                  type="number"
                  step="0.5"
                  value={Math.round(cadSelectedText.override.dx * 100) / 100}
                  onChange={e => {
                    const dx = parseFloat(e.target.value) || 0;
                    const ov = textOverrides[cadSelectedText.key] ?? { dx: 0, dy: 0 };
                    setTextOverride(cadSelectedText.key, { ...ov, dx });
                    setCadSelectedText(prev => prev ? { ...prev, override: { ...prev.override, dx } } : null);
                  }}
                  className="flex-1 bg-slate-800 border border-slate-600 rounded px-2 py-0.5 text-slate-100 focus:outline-none focus:border-amber-500"
                />
                <span className="text-slate-500">ft</span>
              </label>
              <label className="flex items-center gap-2">
                <span className="text-slate-400 w-16 shrink-0">Y offset</span>
                <input
                  type="number"
                  step="0.5"
                  value={Math.round(cadSelectedText.override.dy * 100) / 100}
                  onChange={e => {
                    const dy = parseFloat(e.target.value) || 0;
                    const ov = textOverrides[cadSelectedText.key] ?? { dx: 0, dy: 0 };
                    setTextOverride(cadSelectedText.key, { ...ov, dy });
                    setCadSelectedText(prev => prev ? { ...prev, override: { ...prev.override, dy } } : null);
                  }}
                  className="flex-1 bg-slate-800 border border-slate-600 rounded px-2 py-0.5 text-slate-100 focus:outline-none focus:border-amber-500"
                />
                <span className="text-slate-500">ft</span>
              </label>
              <label className="flex items-center gap-2">
                <span className="text-slate-400 w-16 shrink-0">Height</span>
                <input
                  type="number"
                  step="0.1"
                  min="0.1"
                  value={Math.round((cadSelectedText.override.h ?? cadSelectedText.origH) * 100) / 100}
                  onChange={e => {
                    const h = Math.max(0.1, parseFloat(e.target.value) || cadSelectedText.origH);
                    const ov = textOverrides[cadSelectedText.key] ?? { dx: 0, dy: 0 };
                    setTextOverride(cadSelectedText.key, { ...ov, h });
                    setCadSelectedText(prev => prev ? { ...prev, override: { ...prev.override, h } } : null);
                  }}
                  className="flex-1 bg-slate-800 border border-slate-600 rounded px-2 py-0.5 text-slate-100 focus:outline-none focus:border-amber-500"
                />
                <span className="text-slate-500">ft</span>
              </label>
              <label className="flex items-center gap-2">
                <span className="text-slate-400 w-16 shrink-0">Text</span>
                <input
                  type="text"
                  value={cadSelectedText.override.text ?? cadSelectedText.origText}
                  onChange={e => {
                    const text = e.target.value;
                    const ov = textOverrides[cadSelectedText.key] ?? { dx: 0, dy: 0 };
                    setTextOverride(cadSelectedText.key, { ...ov, text: text !== cadSelectedText.origText ? text : undefined });
                    setCadSelectedText(prev => prev ? { ...prev, override: { ...prev.override, text: text !== cadSelectedText.origText ? text : undefined } } : null);
                  }}
                  className="flex-1 bg-slate-800 border border-slate-600 rounded px-2 py-0.5 text-slate-100 focus:outline-none focus:border-amber-500 font-mono"
                />
              </label>
            </div>
            <div className="flex gap-1.5 mt-3">
              <button
                onClick={() => {
                  clearTextOverride(cadSelectedText.key);
                  setCadSelectedText(prev => prev ? { ...prev, override: { dx: 0, dy: 0 } } : null);
                }}
                className="flex-1 text-[10px] py-1 bg-slate-800 hover:bg-slate-700 border border-slate-600 rounded text-slate-300"
              >
                Reset
              </button>
              <button
                onClick={() => {
                  setCadSelectedText(null);
                }}
                className="flex-1 text-[10px] py-1 bg-slate-800 hover:bg-slate-700 border border-slate-600 rounded text-slate-300"
              >
                Done
              </button>
            </div>
          </div>
        )}
      </div>
      )}
    </div>
  );
}

function TourFutureGhosts() {
  const ghosts = useDesignStore(s => s.tourGhosts);
  const alpha = useDesignStore(s => s.tourGhostAlpha);
  if (!ghosts || !ghosts.length || alpha <= 0) return null;
  const ease = alpha * alpha * (3 - 2 * alpha); // smoothstep, same as the card
  return (
    <group>
      {ghosts.map((g, i) => <TourFutureGhostBox key={i} g={g} ease={ease} />)}
    </group>
  );
}

// What the placement tool is currently building. 'equipment' places ONE
// auxiliary/comms/transformer/fire-control item — the gear an island no longer
// brings along automatically.
export type PlacementKind = 'island' | 'single' | 'single2' | 'equipment';

// Precision controls for the island tool: explicit orientation, a snap
// increment (including free positioning) and exact numeric center entry.
// Every control writes the TRANSIENT placement session only — nothing here can
// change the design until the placement is committed.
function PlacementPrecisionBar({
  placeAngleDeg, onAngle, placeSnap, onSnap,
}: {
  placeAngleDeg: number;
  onAngle: (a: number) => void;
  placeSnap: number;
  onSnap: (s: number) => void;
}) {
  const placement = useDesignStore(s => s.placement);
  const setPlacementCenter = useDesignStore(s => s.setPlacementCenter);
  const nudgePlacement = useDesignStore(s => s.nudgePlacement);
  const rotatePlacement = useDesignStore(s => s.rotatePlacement);
  // The displayed angle is the LIVE session angle when a session is active,
  // or the toolbar preference otherwise.
  const displayAngle = placement != null ? placement.angleDeg : placeAngleDeg;
  const normDisplay = ((displayAngle % 360) + 360) % 360;
  // Local text state so a half-typed value ("-", "12.") never becomes a
  // candidate; the session updates only on a parseable number.
  const [xText, setXText] = useState('');
  const [yText, setYText] = useState('');
  useEffect(() => {
    if (!placement) { setXText(''); setYText(''); return; }
    setXText(String(Math.round(placement.center.x * 100) / 100));
    setYText(String(Math.round(placement.center.y * 100) / 100));
  }, [placement?.center.x, placement?.center.y, !!placement]);
  const commitNum = (xs: string, ys: string) => {
    const x = Number(xs), y = Number(ys);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    setPlacementCenter({ x, y });
  };
  const field = 'w-16 px-1.5 py-1 text-xs bg-slate-800 text-slate-100 border border-slate-600 rounded';
  return (
    <div className="flex items-center gap-2">
      {/* Rotation controls: snap presets + 15° step buttons. The ONLY way to
          rotate a placement — never inferred from drag direction. */}
      <div className="flex rounded overflow-hidden border border-slate-600 shadow">
        {([0, 45, 90] as const).map(a => (
          <button
            key={a}
            onClick={() => onAngle(a)}
            title={a === 0 ? 'Horizontal — strip runs east–west (0°)'
              : a === 45 ? 'Diagonal — strip at 45°'
              : 'Vertical — strip runs north–south (90°)'}
            className={`px-2.5 py-1.5 text-xs font-semibold border-r border-slate-600 ${normDisplay === a ? 'bg-emerald-600 text-white' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'}`}
          >
            {a}°
          </button>
        ))}
        <button
          onClick={() => onAngle(((normDisplay - 15) + 360) % 360)}
          title="Rotate −15° (counter-clockwise)"
          className="px-2 py-1.5 text-xs font-semibold border-r border-slate-600 bg-slate-800 text-slate-300 hover:bg-slate-700"
        >
          ◄
        </button>
        <span
          className="px-2.5 py-1.5 text-xs font-semibold bg-slate-900 text-sky-300 border-r border-slate-600 min-w-[3rem] text-center"
          title="Current island rotation in degrees (CCW from east)"
        >
          {normDisplay}°
        </span>
        <button
          onClick={() => onAngle((normDisplay + 15) % 360)}
          title="Rotate +15° clockwise (keyboard: R)"
          className="px-2 py-1.5 text-xs font-semibold bg-slate-800 text-sky-300 hover:bg-slate-700"
        >
          ⟳ R
        </button>
      </div>
      {/* Snap increment, including free positioning. */}
      <div className="bg-slate-900/85 text-slate-300 text-xs font-semibold px-2 py-1.5 rounded shadow">Snap</div>
      <div className="flex rounded overflow-hidden border border-slate-600 shadow">
        {PLACEMENT_SNAP_STEPS_FT.map(s => (
          <button
            key={s}
            onClick={() => onSnap(s)}
            title={s === 0
              ? 'No snap — the placement follows the pointer exactly (positions are still recorded to 0.01 ft)'
              : `Snap the placement center to a ${s} ft grid`}
            className={`px-2 py-1.5 text-xs font-semibold border-r border-slate-600 last:border-r-0 ${placeSnap === s ? 'bg-sky-600 text-white' : 'bg-slate-800 text-slate-300 hover:bg-slate-700'}`}
          >
            {s === 0 ? 'Free' : `${s} ft`}
          </button>
        ))}
      </div>
      {/* Exact numeric center + fine nudges (live session only). */}
      <div className="flex items-center gap-1 bg-slate-900/85 px-2 py-1 rounded shadow">
        <span className="text-slate-400 text-xs">X</span>
        <input
          className={field}
          value={xText}
          disabled={!placement}
          onChange={e => { setXText(e.target.value); commitNum(e.target.value, yText); }}
          title="Exact placement center X (feet). Typed values are used as-is — no snapping."
        />
        <span className="text-slate-400 text-xs">Y</span>
        <input
          className={field}
          value={yText}
          disabled={!placement}
          onChange={e => { setYText(e.target.value); commitNum(xText, e.target.value); }}
          title="Exact placement center Y (feet). Typed values are used as-is — no snapping."
        />
        <button
          onClick={() => nudgePlacement(-PLACEMENT_NUDGE_FT.fine, 0)}
          disabled={!placement}
          title={`Nudge ${PLACEMENT_NUDGE_FT.fine} ft west (arrow keys; Shift = ${PLACEMENT_NUDGE_FT.coarse} ft, Ctrl+Shift = ${PLACEMENT_NUDGE_FT.far} ft)`}
          className="px-1.5 py-1 text-xs font-semibold bg-slate-800 text-slate-300 rounded hover:bg-slate-700 disabled:opacity-40"
        >←</button>
        <button
          onClick={() => nudgePlacement(PLACEMENT_NUDGE_FT.fine, 0)}
          disabled={!placement}
          title={`Nudge ${PLACEMENT_NUDGE_FT.fine} ft east`}
          className="px-1.5 py-1 text-xs font-semibold bg-slate-800 text-slate-300 rounded hover:bg-slate-700 disabled:opacity-40"
        >→</button>
        <button
          onClick={() => nudgePlacement(0, PLACEMENT_NUDGE_FT.fine)}
          disabled={!placement}
          title={`Nudge ${PLACEMENT_NUDGE_FT.fine} ft north`}
          className="px-1.5 py-1 text-xs font-semibold bg-slate-800 text-slate-300 rounded hover:bg-slate-700 disabled:opacity-40"
        >↑</button>
        <button
          onClick={() => nudgePlacement(0, -PLACEMENT_NUDGE_FT.fine)}
          disabled={!placement}
          title={`Nudge ${PLACEMENT_NUDGE_FT.fine} ft south`}
          className="px-1.5 py-1 text-xs font-semibold bg-slate-800 text-slate-300 rounded hover:bg-slate-700 disabled:opacity-40"
        >↓</button>
      </div>
    </div>
  );
}
