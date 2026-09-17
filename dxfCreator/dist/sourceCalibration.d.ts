import { type CrlSubstationLayerKey } from './crlSubstationTrace.js';
import type { CableClass, TrenchClass } from './types.js';
import type { LayerDefinition, LineTypeDefinition, TextStyleDefinition } from './writer.js';
export declare const CAR_D_B005_1_SOURCE_FACTS: Readonly<{
    evidenceKind: "verified-dwg-metadata-and-bound-geometry";
    archive: Readonly<{
        sha256: "44e5a92de04ad5da45d87b69ec7adb0bb37f2fca9248895682859479363eecd4";
        bytes: 150076875;
        entries: 80;
        zipIntegrity: "passed";
    }>;
    host: Readonly<{
        filename: "CAR-D-B005-0.dwg";
        sha256: "cf2f29d43cbe3a4f51515259daf9723f0190455f151288d1af51aa833b6034b5";
        bytes: 570115;
        format: "AC1032";
        units: Readonly<{
            insertionUnits: 2;
            insertionUnitName: "feet";
            linearUnits: 2;
            linearPrecision: 3;
            lineTypeScale: 1;
            paperSpaceLineTypeScale: 1;
            tileMode: 0;
        }>;
        layouts: readonly string[];
    }>;
    xrefs: Readonly<{
        bess: Readonly<{
            filename: "CAR BESS - xref.dwg";
            sha256: "078d532ae4d36740c68eb2a059edbada6b32f24000df0e12b11d67ba9f75b6a5";
            bytes: 3486159;
        }>;
        landbase: Readonly<{
            filename: "CAR MAP3D CO83-CF landbase - xref.dwg";
            sha256: "ed8288f08c38eff20781e555deadc4adcba4af4ca3b5699d469e9daa807ae008";
            bytes: 2008622;
        }>;
    }>;
    boundSources: Readonly<{
        crlExistingSubstation: Readonly<{
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
    }>;
    layout: Readonly<{
        name: "CAR-D-B005-1";
        media: "ANSI_full_bleed_D_(34.00_x_22.00_Inches)";
        widthIn: 34;
        heightIn: 22;
        widthMm: 863.5999756;
        heightMm: 558.7999878;
        marginsIn: Readonly<{
            left: 0;
            bottom: 0;
            right: 0;
            top: 0;
        }>;
        rotation: 0;
        plotType: 5;
        paperUnits: 1;
        drawingUnits: 1;
        standardScaleType: 16;
        paperScale: 1;
        printer: "DWG To PDF.pc3";
        stylesheet: "ECI D BESS-COLOR.ctb";
        plotFlags: 752;
        shadePlotType: 0;
        shadePlotResolutionLevel: 2;
        customDpi: 300;
    }>;
    mainPlanViewport: Readonly<{
        centerIn: readonly [14.09216272501403, 12];
        widthIn: 23.10932545002807;
        heightIn: 18.8;
        viewHeightFt: 375.99365776840534;
        target: readonly [2285513.310256527, 13718055.363680616, 0];
        paperPlanBoxIn: Readonly<{
            left: 2.5375;
            bottom: 2.6;
            right: 25.64682545002807;
            top: 21.4;
        }>;
    }>;
    legendColumnIn: Readonly<{
        left: 28.5;
        right: 33.5;
    }>;
    plottedEvidence: Readonly<{
        fonts: readonly string[];
        exactPlotParityBlockedByMissingCtb: true;
    }>;
    provenance: Readonly<{
        direct: readonly string[];
        derived: readonly string[];
        retainedFallbacks: readonly string[];
    }>;
    unresolvedDependencies: readonly string[];
}>;
export declare const CAR_D_B005_1_SOURCE_LAYERS: Readonly<{
    FRAME: "TB1";
    TITLE: "Title Block";
    TEXT_SM: "text-sm";
    TEXT_MD: "text-md";
    TEXT_LG: "text-lg";
    FENCE: "fence";
    FENCE_ADJACENT: "fence - adjacent substation";
    FENCE_PROJECT: "-layout fence - NP";
    PROPERTY: "property line";
    EQUIPMENT: "EQUIP - equip main overall size";
    EQUIPMENT_LABEL: "EQUIP - Labels";
    FUTURE: "EQUIP - future augment";
    FUTURE_INVERTER: "EQUIP - future project planning";
    EXCLUSION: "EQUIP - exclusion zone";
    LAYDOWN: "SITE - laydown area";
    ROAD: "A - Equipment access";
    ROAD_HATCH: "Hatch - road proposed";
    ROAD_EXISTING: "Hatch - road exist";
    SURFACING: "HATCH";
    TRENCH_MVAC: "TRENCH - MVAC";
    TRENCH_DC: "TRENCH - DC";
    TRENCH_AUX: "TRENCH - AUX FIBER";
    MATCH: "MATCH LINE";
    CALLOUT: "CALL OUT";
    DETAIL: "DETAIL MARKER";
    FEEDER_14A1: "conduit - Feeder 14A1";
    FEEDER_14A2: "conduit - Feeder 14A2";
    FEEDER_14B1: "conduit - Feeder 14B1";
    FEEDER_14B2: "conduit - Feeder 14B2";
    FEEDER_15A1: "conduit - Feeder 15A1";
    FEEDER_15A2: "conduit - Feeder 15A2";
    FEEDER_15B1: "conduit - Feeder 15B1";
    FEEDER_15B2: "conduit - Feeder 15B2";
    AUX_FEEDER: "conduit - Aux Feeder 15C1";
    DC_NEGATIVE: "conduit - DC -";
    DC_POSITIVE: "conduit - DC +";
    FIBER: "conduit - Fiber - 6-COUNT";
}>;
export declare const CAR_D_B005_1_SOURCE_CABLE_LAYERS: Readonly<Record<CableClass, string>>;
export declare const CAR_D_B005_1_SOURCE_TRENCH_LAYERS: Readonly<Record<TrenchClass, string>>;
export declare const CAR_D_B005_1_CRL_SUBSTATION_LAYERS: Readonly<Record<CrlSubstationLayerKey, string>>;
export declare const CAR_D_B005_1_CRL_SUBSTATION_LINE_TYPES: readonly LineTypeDefinition[];
export declare const CAR_D_B005_1_CRL_SUBSTATION_LAYER_DEFINITIONS: readonly LayerDefinition[];
export declare const CAR_D_B005_1_SOURCE_LINE_TYPES: readonly LineTypeDefinition[];
export declare const CAR_D_B005_1_SOURCE_TEXT_STYLES: readonly TextStyleDefinition[];
export declare const CAR_D_B005_1_SOURCE_LAYER_DEFINITIONS: readonly LayerDefinition[];
export declare const CAR_D_B005_1_SOURCE_PROFILE: Readonly<{
    id: "car-d-b005-1";
    facts: Readonly<{
        evidenceKind: "verified-dwg-metadata-and-bound-geometry";
        archive: Readonly<{
            sha256: "44e5a92de04ad5da45d87b69ec7adb0bb37f2fca9248895682859479363eecd4";
            bytes: 150076875;
            entries: 80;
            zipIntegrity: "passed";
        }>;
        host: Readonly<{
            filename: "CAR-D-B005-0.dwg";
            sha256: "cf2f29d43cbe3a4f51515259daf9723f0190455f151288d1af51aa833b6034b5";
            bytes: 570115;
            format: "AC1032";
            units: Readonly<{
                insertionUnits: 2;
                insertionUnitName: "feet";
                linearUnits: 2;
                linearPrecision: 3;
                lineTypeScale: 1;
                paperSpaceLineTypeScale: 1;
                tileMode: 0;
            }>;
            layouts: readonly string[];
        }>;
        xrefs: Readonly<{
            bess: Readonly<{
                filename: "CAR BESS - xref.dwg";
                sha256: "078d532ae4d36740c68eb2a059edbada6b32f24000df0e12b11d67ba9f75b6a5";
                bytes: 3486159;
            }>;
            landbase: Readonly<{
                filename: "CAR MAP3D CO83-CF landbase - xref.dwg";
                sha256: "ed8288f08c38eff20781e555deadc4adcba4af4ca3b5699d469e9daa807ae008";
                bytes: 2008622;
            }>;
        }>;
        boundSources: Readonly<{
            crlExistingSubstation: Readonly<{
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
        }>;
        layout: Readonly<{
            name: "CAR-D-B005-1";
            media: "ANSI_full_bleed_D_(34.00_x_22.00_Inches)";
            widthIn: 34;
            heightIn: 22;
            widthMm: 863.5999756;
            heightMm: 558.7999878;
            marginsIn: Readonly<{
                left: 0;
                bottom: 0;
                right: 0;
                top: 0;
            }>;
            rotation: 0;
            plotType: 5;
            paperUnits: 1;
            drawingUnits: 1;
            standardScaleType: 16;
            paperScale: 1;
            printer: "DWG To PDF.pc3";
            stylesheet: "ECI D BESS-COLOR.ctb";
            plotFlags: 752;
            shadePlotType: 0;
            shadePlotResolutionLevel: 2;
            customDpi: 300;
        }>;
        mainPlanViewport: Readonly<{
            centerIn: readonly [14.09216272501403, 12];
            widthIn: 23.10932545002807;
            heightIn: 18.8;
            viewHeightFt: 375.99365776840534;
            target: readonly [2285513.310256527, 13718055.363680616, 0];
            paperPlanBoxIn: Readonly<{
                left: 2.5375;
                bottom: 2.6;
                right: 25.64682545002807;
                top: 21.4;
            }>;
        }>;
        legendColumnIn: Readonly<{
            left: 28.5;
            right: 33.5;
        }>;
        plottedEvidence: Readonly<{
            fonts: readonly string[];
            exactPlotParityBlockedByMissingCtb: true;
        }>;
        provenance: Readonly<{
            direct: readonly string[];
            derived: readonly string[];
            retainedFallbacks: readonly string[];
        }>;
        unresolvedDependencies: readonly string[];
    }>;
    layers: Readonly<{
        FRAME: "TB1";
        TITLE: "Title Block";
        TEXT_SM: "text-sm";
        TEXT_MD: "text-md";
        TEXT_LG: "text-lg";
        FENCE: "fence";
        FENCE_ADJACENT: "fence - adjacent substation";
        FENCE_PROJECT: "-layout fence - NP";
        PROPERTY: "property line";
        EQUIPMENT: "EQUIP - equip main overall size";
        EQUIPMENT_LABEL: "EQUIP - Labels";
        FUTURE: "EQUIP - future augment";
        FUTURE_INVERTER: "EQUIP - future project planning";
        EXCLUSION: "EQUIP - exclusion zone";
        LAYDOWN: "SITE - laydown area";
        ROAD: "A - Equipment access";
        ROAD_HATCH: "Hatch - road proposed";
        ROAD_EXISTING: "Hatch - road exist";
        SURFACING: "HATCH";
        TRENCH_MVAC: "TRENCH - MVAC";
        TRENCH_DC: "TRENCH - DC";
        TRENCH_AUX: "TRENCH - AUX FIBER";
        MATCH: "MATCH LINE";
        CALLOUT: "CALL OUT";
        DETAIL: "DETAIL MARKER";
        FEEDER_14A1: "conduit - Feeder 14A1";
        FEEDER_14A2: "conduit - Feeder 14A2";
        FEEDER_14B1: "conduit - Feeder 14B1";
        FEEDER_14B2: "conduit - Feeder 14B2";
        FEEDER_15A1: "conduit - Feeder 15A1";
        FEEDER_15A2: "conduit - Feeder 15A2";
        FEEDER_15B1: "conduit - Feeder 15B1";
        FEEDER_15B2: "conduit - Feeder 15B2";
        AUX_FEEDER: "conduit - Aux Feeder 15C1";
        DC_NEGATIVE: "conduit - DC -";
        DC_POSITIVE: "conduit - DC +";
        FIBER: "conduit - Fiber - 6-COUNT";
    }>;
    cableLayers: Readonly<Record<CableClass, string>>;
    trenchLayers: Readonly<Record<TrenchClass, string>>;
    layerDefinitions: readonly LayerDefinition[];
    lineTypes: readonly LineTypeDefinition[];
    textStyles: readonly TextStyleDefinition[];
    textStyleByLayer: Readonly<{
        "text-sm": "ECIS8";
        "text-md": "ECIS8-MD";
        "text-lg": "Legend";
        "EQUIP - Labels": "ECIS8";
    }>;
    statusStampTextStyle: "Stamp Text";
    sourceSubstation: Readonly<{
        layers: Readonly<Record<"fence" | "fence-removal" | "road" | "foundation" | "foundation-hidden" | "conductor" | "station-bus" | "equipment" | "steel-misc" | "steel-tubular" | "control-house" | "control-house-stoop" | "pullbox", string>>;
        layerDefinitions: readonly LayerDefinition[];
        lineTypes: readonly LineTypeDefinition[];
    }>;
}>;
//# sourceMappingURL=sourceCalibration.d.ts.map