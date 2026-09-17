import type { Point } from './types.js';
export declare const CRL_SUBSTATION_LAYER_KEYS: readonly ["fence", "fence-removal", "road", "foundation", "foundation-hidden", "conductor", "station-bus", "equipment", "steel-misc", "steel-tubular", "control-house", "control-house-stoop", "pullbox"];
export type CrlSubstationLayerKey = typeof CRL_SUBSTATION_LAYER_KEYS[number];
export interface CrlSubstationPath {
    readonly layer: CrlSubstationLayerKey;
    readonly closed: boolean;
    readonly points: readonly Readonly<Point>[];
}
export declare const CRL_SUBSTATION_TRACE_FACTS: Readonly<{
    source: Readonly<{
        filename: "2026-05-27_Carousel_layout_1789622658571.dwg";
        sha256: "34167b08c8560abd02816bb110275a2848d2253c79d9c5edca20bcb794945f3c";
        bytes: 6416102;
        format: "AC1032";
        insertionUnits: 2;
        insertionUnitName: "feet";
        tileMode: 1;
        layouts: readonly ["Model", "Layout1"];
        layoutPlotStyle: "ECI Standard.ctb";
    }>;
    boundEvidence: Readonly<{
        namespace: "CRL-XREF EXI$0$";
        blockDefinitions: 113;
        definitionEntities: 14432;
        insertReferences: 481;
        uniqueReferencedBlocks: 81;
        boundLayers: 20;
        topLevelModelSpaceInserts: 198;
        topLevelModelSpaceEntitiesOnBoundLayers: 280;
    }>;
    extraction: Readonly<{
        status: "stable-2d-schematic";
        modelSpaceOnly: true;
        sourceClusterBoundsFt: Readonly<{
            minX: 3942726.946481345;
            minY: 1573422.015098742;
            maxX: 3942991.899606345;
            maxY: 1573606.968930576;
            width: 264.953125;
            height: 184.9538318340201;
        }>;
        topLevelEntities: 231;
        curveFlatteningToleranceFt: 0.25;
        minimumRetainedPathExtentFt: 2;
        normalization: "source bounds to centered [-0.5, 0.5] local envelope";
        coordinateEncoding: "signed delta ZigZag varints on a 65534-unit normalized grid";
        encodedBytes: 8284;
        encodedBase64Characters: 11048;
        encodedBinarySha256: "8d5729331606b7dab52e0406a53e4218a3bdcfd2be4a6c98627477485d503588";
        pathCount: 211;
        pointCount: 3100;
        pathCountByLayer: Readonly<{
            fence: 9;
            'fence-removal': 1;
            road: 4;
            foundation: 16;
            'foundation-hidden': 2;
            conductor: 21;
            'station-bus': 1;
            equipment: 76;
            'steel-misc': 44;
            'steel-tubular': 2;
            'control-house': 7;
            'control-house-stoop': 26;
            pullbox: 2;
        }>;
    }>;
    limitations: readonly string[];
}>;
export declare const CRL_SUBSTATION_PATHS: readonly Readonly<CrlSubstationPath>[];
//# sourceMappingURL=crlSubstationTrace.d.ts.map