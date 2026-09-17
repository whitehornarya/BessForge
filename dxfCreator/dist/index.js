import { LEGACY_CALIBRATION_PROFILES, LEGACY_PAGE_ROLE, LEGACY_TEMPLATE_CALIBRATION_PROFILE, LEGACY_TEMPLATE_ID, } from './constants.js';
import { composeLegacyLayout } from './compose.js';
import { assertValidLegacyLayoutInput } from './validate.js';
function validateOptions(options) {
    if (options.filename !== undefined) {
        if (!/^[A-Za-z0-9][A-Za-z0-9._ -]{0,180}\.dxf$/i.test(options.filename)) {
            throw new Error('options.filename must be printable ASCII, path-free, 1..184 characters, and end in .dxf');
        }
    }
    if (options.scaleFtPerIn !== undefined && !Number.isFinite(options.scaleFtPerIn)) {
        throw new Error('options.scaleFtPerIn must be finite');
    }
    if (options.autoScale !== undefined && typeof options.autoScale !== 'boolean') {
        throw new Error('options.autoScale must be a boolean');
    }
    if (options.calibrationProfile !== undefined
        && !LEGACY_CALIBRATION_PROFILES.includes(options.calibrationProfile)) {
        throw new Error(`options.calibrationProfile must be one of: ${LEGACY_CALIBRATION_PROFILES.join(', ')}`);
    }
}
function defaultFilename(input) {
    const base = input.title.drawingNumber.replace(/[^A-Za-z0-9._-]+/g, '_');
    return `${base || 'BESS'}_Legacy_Layout.dxf`;
}
export function buildLegacyLayoutDxf(input, options = {}) {
    validateOptions(options);
    const valid = assertValidLegacyLayoutInput(input);
    return composeLegacyLayout(valid, options);
}
export function buildLegacyExportArtifact(input, options = {}) {
    const text = buildLegacyLayoutDxf(input, options);
    return {
        filename: options.filename ?? defaultFilename(input),
        mimeType: 'application/dxf',
        pageRole: LEGACY_PAGE_ROLE,
        bytes: new TextEncoder().encode(text),
        text,
    };
}
function templateOptions(options) {
    if ('calibrationProfile' in options) {
        throw new Error(`Legacy template calibrationProfile is pinned to ${LEGACY_TEMPLATE_CALIBRATION_PROFILE}; omit it`);
    }
    return { ...options, calibrationProfile: LEGACY_TEMPLATE_CALIBRATION_PROFILE };
}
/** Builds the source-calibrated Legacy system template as deterministic DXF text. */
export function buildLegacyTemplateDxf(input, options = {}) {
    return buildLegacyLayoutDxf(input, templateOptions(options));
}
/** Builds the source-calibrated Legacy system template using the page-2 artifact contract. */
export function buildLegacyTemplateArtifact(input, options = {}) {
    return buildLegacyExportArtifact(input, templateOptions(options));
}
/** Matches the stable persisted template ID, never the visible/localized label. */
export function isLegacyTemplateSelection(selectionId) {
    return selectionId === LEGACY_TEMPLATE_ID;
}
const NOT_HANDLED = Object.freeze({ handled: false });
/**
 * Lazily handles the Legacy selection. Non-Legacy selections never invoke the
 * input adapter, validate a design, or generate bytes.
 */
export function tryBuildLegacyTemplateArtifact(selectionId, input, options = {}) {
    if (!isLegacyTemplateSelection(selectionId))
        return NOT_HANDLED;
    const normalized = typeof input === 'function' ? input() : input;
    return Object.freeze({
        handled: true,
        artifact: buildLegacyTemplateArtifact(normalized, options),
    });
}
export * from './constants.js';
export * from './compose.js';
export * from './crlSubstationTrace.js';
export * from './numeric.js';
export * from './sourceCalibration.js';
export * from './types.js';
export * from './validate.js';
export { DxfWriter, } from './writer.js';
//# sourceMappingURL=index.js.map