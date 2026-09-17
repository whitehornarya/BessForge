import type { Point } from './types.js';

export const DXF_DECIMAL_PLACES = 6;
export const DXF_QUANTUM = 10 ** -DXF_DECIMAL_PLACES;
const DXF_SCALE = 10 ** DXF_DECIMAL_PLACES;
const MAX_EXACT_QUANTIZABLE_ABS_VALUE = Number.MAX_SAFE_INTEGER / DXF_SCALE;
export const MAX_ABS_LOCAL_COORDINATE_FT = 10_000_000;
export const MIN_EQUIPMENT_DIMENSION_FT = 0.001;
export const MAX_EQUIPMENT_DIMENSION_FT = 1_000_000;
export const MAX_ABS_ROTATION_DEG = 3_600;

export function quantizeDxfNumber(value: number): number {
  if (!Number.isFinite(value)) throw new Error(`DXF numeric value must be finite: ${value}`);
  if (Math.abs(value) > MAX_EXACT_QUANTIZABLE_ABS_VALUE) {
    throw new Error(`DXF numeric value exceeds exact six-decimal quantization range: ${value}`);
  }
  const rounded = Math.abs(value) < DXF_QUANTUM / 2
    ? 0
    : Math.round(value * DXF_SCALE) / DXF_SCALE;
  return Object.is(rounded, -0) ? 0 : rounded;
}

export function formatDxfNumber(value: number): string {
  const rounded = quantizeDxfNumber(value);
  return Number.isInteger(rounded)
    ? String(rounded)
    : rounded.toFixed(DXF_DECIMAL_PLACES).replace(/0+$/, '').replace(/\.$/, '');
}

export function quantizeDxfPoint(point: Point): Point {
  return { x: quantizeDxfNumber(point.x), y: quantizeDxfNumber(point.y) };
}

export function normalizeRotationDeg(value: number): number {
  const normalized = ((value % 360) + 360) % 360;
  const quantized = quantizeDxfNumber(normalized);
  return quantized >= 360 ? 0 : quantized;
}

export function quantizedPointKey(point: Point): string {
  return `${formatDxfNumber(point.x)},${formatDxfNumber(point.y)}`;
}