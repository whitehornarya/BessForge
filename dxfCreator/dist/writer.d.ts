import type { HatchPattern, Point } from './types.js';
export interface LayerDefinition {
    name: string;
    color: number;
    lineType: string;
    lineWeight: number;
}
export interface LineTypeDefinition {
    name: string;
    description: string;
    elements: readonly number[];
}
export interface TextStyleDefinition {
    name: string;
    fontFile: string;
    bigFontFile?: string;
    widthFactor?: number;
    obliqueAngle?: number;
    lastHeight?: number;
}
export declare class DxfWriter {
    private readonly lineTypeScale;
    readonly entities: string[];
    private readonly layers;
    private readonly lineTypes;
    private readonly textStyles;
    private readonly layerTextStyles;
    private handle;
    constructor(lineTypeScale?: number);
    private nextHandle;
    addLayer(layer: LayerDefinition): void;
    addLineType(lineType: LineTypeDefinition): void;
    addTextStyle(style: TextStyleDefinition): void;
    setLayerTextStyle(layer: string, style: string): void;
    private entity;
    addLine(a: Point, b: Point, layer: string, color?: number): void;
    addPolyline(points: readonly Point[], layer: string, closed?: boolean, color?: number): void;
    addArc(center: Point, radius: number, startDeg: number, endDeg: number, layer: string): void;
    addText(point: Point, height: number, text: string, layer: string, rotationDeg?: number, style?: string): void;
    addCenteredText(point: Point, height: number, text: string, layer: string, rotationDeg?: number, style?: string): void;
    addHatch(loops: readonly (readonly Point[])[], layer: string, pattern: HatchPattern, color?: number): void;
    toString(): string;
}
//# sourceMappingURL=writer.d.ts.map