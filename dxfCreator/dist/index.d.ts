import { LEGACY_TEMPLATE_ID } from './constants.js';
import type { LegacyBuildOptions, LegacyExportArtifact, LegacyLayoutInput, LegacyTemplateBuildOptions, LegacyTemplateExportResult, LegacyTemplateInputSource } from './types.js';
export declare function buildLegacyLayoutDxf(input: LegacyLayoutInput, options?: LegacyBuildOptions): string;
export declare function buildLegacyExportArtifact(input: LegacyLayoutInput, options?: LegacyBuildOptions): LegacyExportArtifact;
/** Builds the source-calibrated Legacy system template as deterministic DXF text. */
export declare function buildLegacyTemplateDxf(input: LegacyLayoutInput, options?: LegacyTemplateBuildOptions): string;
/** Builds the source-calibrated Legacy system template using the page-2 artifact contract. */
export declare function buildLegacyTemplateArtifact(input: LegacyLayoutInput, options?: LegacyTemplateBuildOptions): LegacyExportArtifact;
/** Matches the stable persisted template ID, never the visible/localized label. */
export declare function isLegacyTemplateSelection(selectionId: unknown): selectionId is typeof LEGACY_TEMPLATE_ID;
/**
 * Lazily handles the Legacy selection. Non-Legacy selections never invoke the
 * input adapter, validate a design, or generate bytes.
 */
export declare function tryBuildLegacyTemplateArtifact(selectionId: unknown, input: LegacyTemplateInputSource, options?: LegacyTemplateBuildOptions): LegacyTemplateExportResult;
export * from './constants.js';
export * from './compose.js';
export * from './crlSubstationTrace.js';
export * from './numeric.js';
export * from './sourceCalibration.js';
export * from './types.js';
export * from './validate.js';
export { DxfWriter, type LayerDefinition, type LineTypeDefinition, type TextStyleDefinition, } from './writer.js';
//# sourceMappingURL=index.d.ts.map