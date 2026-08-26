// Yard ground texture sets for the 3D preview ONLY — never used by DXF/PDF
// export. Each set maps the three ground surfaces (access roads, crushed-rock
// surfacing, dirt/ground plane) to a texture in client/public/textures/.
// Sets A–D are CC0 textures from Poly Haven (polyhaven.com) and ambientCG
// (ambientcg.com), downloaded at 2K and web-optimized to 1024px JPEG.

import { assetUrl } from './assetUrl';

export type YardTextureSetId =
  | 'classic'
  | 'ph-natural'
  | 'ph-asphalt'
  | 'acg-highway'
  | 'acg-industrial';

export interface YardTextureSet {
  id: YardTextureSetId;
  label: string;
  /** Attribution / origin note (all CC0). */
  source: string;
  /** Road surface texture URL resolved against the Vite base path. */
  road: string;
  /** Crushed-rock surfacing texture path. */
  rock: string;
  /** Dirt / bare-ground plane texture path; null = plain untextured color. */
  dirt: string | null;
  /** Small preview thumbnail (road swatch); null = no thumbnail. */
  thumb: string | null;
}

export const YARD_TEXTURE_SETS: readonly YardTextureSet[] = [
  {
    id: 'classic',
    label: 'Classic (original)',
    source: 'Built-in',
    road: assetUrl('/textures/asphalt.png'),
    rock: assetUrl('/textures/gravel.png'),
    dirt: null,
    thumb: null,
  },
  {
    id: 'ph-natural',
    label: 'A — Gravel road (natural)',
    source: 'Poly Haven, CC0 (gravel_road / rocky_gravel / gravelly_sand)',
    road: assetUrl('/textures/sets/yard-a-road.jpg'),
    rock: assetUrl('/textures/sets/yard-a-rock.jpg'),
    dirt: assetUrl('/textures/sets/yard-a-dirt.jpg'),
    thumb: assetUrl('/textures/sets/yard-a-thumb.jpg'),
  },
  {
    id: 'ph-asphalt',
    label: 'B — Clean asphalt yard',
    source: 'Poly Haven, CC0 (asphalt_02 / gravel_floor_02 / sandy_gravel)',
    road: assetUrl('/textures/sets/yard-b-road.jpg'),
    rock: assetUrl('/textures/sets/yard-b-rock.jpg'),
    dirt: assetUrl('/textures/sets/yard-b-dirt.jpg'),
    thumb: assetUrl('/textures/sets/yard-b-thumb.jpg'),
  },
  {
    id: 'acg-highway',
    label: 'C — Weathered asphalt',
    source: 'ambientCG, CC0 (Asphalt025C / Gravel023 / Ground081)',
    road: assetUrl('/textures/sets/yard-c-road.jpg'),
    rock: assetUrl('/textures/sets/yard-c-rock.jpg'),
    dirt: assetUrl('/textures/sets/yard-c-dirt.jpg'),
    thumb: assetUrl('/textures/sets/yard-c-thumb.jpg'),
  },
  {
    id: 'acg-industrial',
    label: 'D — Clean industrial',
    source: 'ambientCG, CC0 (Asphalt031 / Gravel043 / Ground062S)',
    road: assetUrl('/textures/sets/yard-d-road.jpg'),
    rock: assetUrl('/textures/sets/yard-d-rock.jpg'),
    dirt: assetUrl('/textures/sets/yard-d-dirt.jpg'),
    thumb: assetUrl('/textures/sets/yard-d-thumb.jpg'),
  },
];

export const DEFAULT_TEXTURE_SET_ID: YardTextureSetId = 'acg-industrial';

export const isYardTextureSetId = (v: unknown): v is YardTextureSetId =>
  typeof v === 'string' && YARD_TEXTURE_SETS.some(s => s.id === v);

export function getYardTextureSet(id: YardTextureSetId): YardTextureSet {
  return (
    YARD_TEXTURE_SETS.find(s => s.id === id) ??
    YARD_TEXTURE_SETS.find(s => s.id === DEFAULT_TEXTURE_SET_ID)!
  );
}
