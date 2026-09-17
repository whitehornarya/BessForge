import type { Point } from './types.js';
export declare const DXF_DECIMAL_PLACES = 6;
export declare const DXF_QUANTUM: number;
export declare const MAX_ABS_LOCAL_COORDINATE_FT = 10000000;
export declare const MIN_EQUIPMENT_DIMENSION_FT = 0.001;
export declare const MAX_EQUIPMENT_DIMENSION_FT = 1000000;
export declare const MAX_ABS_ROTATION_DEG = 3600;
export declare function quantizeDxfNumber(value: number): number;
export declare function formatDxfNumber(value: number): string;
export declare function quantizeDxfPoint(point: Point): Point;
export declare function normalizeRotationDeg(value: number): number;
export declare function quantizedPointKey(point: Point): string;
//# sourceMappingURL=numeric.d.ts.map