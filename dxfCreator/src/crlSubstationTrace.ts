import { CRL_SUBSTATION_ENCODED_TRACE } from './crlSubstationData.js';
import type { Point } from './types.js';

export const CRL_SUBSTATION_LAYER_KEYS = Object.freeze([
  'fence',
  'fence-removal',
  'road',
  'foundation',
  'foundation-hidden',
  'conductor',
  'station-bus',
  'equipment',
  'steel-misc',
  'steel-tubular',
  'control-house',
  'control-house-stoop',
  'pullbox',
] as const);

export type CrlSubstationLayerKey = typeof CRL_SUBSTATION_LAYER_KEYS[number];

export interface CrlSubstationPath {
  readonly layer: CrlSubstationLayerKey;
  readonly closed: boolean;
  readonly points: readonly Readonly<Point>[];
}

export const CRL_SUBSTATION_TRACE_FACTS = Object.freeze({
  source: Object.freeze({
    filename: '2026-05-27_Carousel_layout_1789622658571.dwg',
    sha256: '34167b08c8560abd02816bb110275a2848d2253c79d9c5edca20bcb794945f3c',
    bytes: 6416102,
    format: 'AC1032',
    insertionUnits: 2,
    insertionUnitName: 'feet',
    tileMode: 1,
    layouts: Object.freeze(['Model', 'Layout1'] as const),
    layoutPlotStyle: 'ECI Standard.ctb',
  }),
  boundEvidence: Object.freeze({
    namespace: 'CRL-XREF EXI$0$',
    blockDefinitions: 113,
    definitionEntities: 14432,
    insertReferences: 481,
    uniqueReferencedBlocks: 81,
    boundLayers: 20,
    topLevelModelSpaceInserts: 198,
    topLevelModelSpaceEntitiesOnBoundLayers: 280,
  }),
  extraction: Object.freeze({
    status: 'stable-2d-schematic',
    modelSpaceOnly: true,
    sourceClusterBoundsFt: Object.freeze({
      minX: 3942726.946481345,
      minY: 1573422.015098742,
      maxX: 3942991.899606345,
      maxY: 1573606.968930576,
      width: 264.953125,
      height: 184.9538318340201,
    }),
    topLevelEntities: 231,
    curveFlatteningToleranceFt: 0.25,
    minimumRetainedPathExtentFt: 2,
    normalization: 'source bounds to centered [-0.5, 0.5] local envelope',
    coordinateEncoding: 'signed delta ZigZag varints on a 65534-unit normalized grid',
    encodedBytes: 8284,
    encodedBase64Characters: 11048,
    encodedBinarySha256: '8d5729331606b7dab52e0406a53e4218a3bdcfd2be4a6c98627477485d503588',
    pathCount: 211,
    pointCount: 3100,
    pathCountByLayer: Object.freeze({
      fence: 9,
      'fence-removal': 1,
      road: 4,
      foundation: 16,
      'foundation-hidden': 2,
      conductor: 21,
      'station-bus': 1,
      equipment: 76,
      'steel-misc': 44,
      'steel-tubular': 2,
      'control-house': 7,
      'control-house-stoop': 26,
      pullbox: 2,
    }),
  }),
  limitations: Object.freeze([
    'The bound geometry is direct visible source evidence, not the original unbound CRL-XREF EXI.dwg byte stream.',
    'The vector is a deterministic plan-view schematic; sub-2-foot fabrication details, Z, proxy graphics, and native display semantics are not retained.',
    'The drawing has no authoritative CAR-D-B005-1 paper-space border and uses ECI Standard.ctb, not ECI D BESS-COLOR.ctb.',
  ]),
});

function decodeBase64(value: string): Uint8Array {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const output = new Uint8Array(Math.floor(value.length * 3 / 4) - padding);
  let accumulator = 0;
  let bits = 0;
  let offset = 0;
  for (const character of value) {
    if (character === '=') break;
    const digit = alphabet.indexOf(character);
    if (digit < 0) throw new Error('Invalid CRL substation trace encoding');
    accumulator = (accumulator << 6) | digit;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      output[offset++] = (accumulator >>> bits) & 0xff;
    }
  }
  if (offset !== output.length) throw new Error('Truncated CRL substation trace encoding');
  return output;
}

interface Cursor {
  offset: number;
}

function readVarUint(bytes: Uint8Array, cursor: Cursor): number {
  let value = 0;
  let shift = 0;
  while (cursor.offset < bytes.length && shift <= 28) {
    const byte = bytes[cursor.offset++]!;
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return value >>> 0;
    shift += 7;
  }
  throw new Error('Invalid CRL substation trace varint');
}

function decodeZigZag(value: number): number {
  return (value >>> 1) ^ -(value & 1);
}

function decodeTrace(): readonly Readonly<CrlSubstationPath>[] {
  const bytes = decodeBase64(CRL_SUBSTATION_ENCODED_TRACE);
  if (
    bytes.length < 5
    || bytes[0] !== 0x43
    || bytes[1] !== 0x52
    || bytes[2] !== 0x4c
    || bytes[3] !== 0x32
  ) throw new Error('Unsupported CRL substation trace format');
  const cursor: Cursor = { offset: 4 };
  const pathCount = readVarUint(bytes, cursor);
  const paths: Readonly<CrlSubstationPath>[] = [];
  let pointCount = 0;
  for (let pathIndex = 0; pathIndex < pathCount; pathIndex++) {
    if (cursor.offset >= bytes.length) throw new Error('Truncated CRL substation trace path');
    const tag = bytes[cursor.offset++]!;
    const layerIndex = tag & 0x7f;
    const layer = CRL_SUBSTATION_LAYER_KEYS[layerIndex];
    if (!layer) throw new Error('Unknown CRL substation trace layer');
    const count = readVarUint(bytes, cursor);
    if (count < 2) throw new Error('CRL substation trace path requires at least two points');
    const points: Readonly<Point>[] = [];
    let x = 0;
    let y = 0;
    for (let pointIndex = 0; pointIndex < count; pointIndex++) {
      x += decodeZigZag(readVarUint(bytes, cursor));
      y += decodeZigZag(readVarUint(bytes, cursor));
      if (Math.abs(x) > 32767 || Math.abs(y) > 32767) {
        throw new Error('CRL substation trace coordinate is outside its normalized envelope');
      }
      points.push(Object.freeze({ x: x / 65534, y: y / 65534 }));
    }
    pointCount += points.length;
    paths.push(Object.freeze({
      layer,
      closed: (tag & 0x80) !== 0,
      points: Object.freeze(points),
    }));
  }
  if (
    cursor.offset !== bytes.length
    || paths.length !== CRL_SUBSTATION_TRACE_FACTS.extraction.pathCount
    || pointCount !== CRL_SUBSTATION_TRACE_FACTS.extraction.pointCount
  ) throw new Error('CRL substation trace integrity check failed');
  return Object.freeze(paths);
}

export const CRL_SUBSTATION_PATHS = decodeTrace();