// Legacy DXF export façade: adapt + validate + tryBuildLegacyTemplateArtifact.

import {
  LEGACY_TEMPLATE_CONTRACT,
  tryBuildLegacyTemplateArtifact,
  validateLegacyLayoutInput,
  type LegacyExportArtifact,
  type LegacyTemplateExportResult,
  type ValidationIssue,
} from '@bessforge/legacy-dxf';
import {
  adaptSiteDesignToLegacyLayoutInput,
  type LegacyAdapterContext,
} from './legacyDxfAdapter';

export { LEGACY_TEMPLATE_CONTRACT };

export type CadExportProfile = 'current' | typeof LEGACY_TEMPLATE_CONTRACT.id;

export class LegacyExportValidationError extends Error {
  readonly issues: readonly ValidationIssue[];

  constructor(issues: readonly ValidationIssue[]) {
    const summary = issues
      .slice(0, 8)
      .map(i => `${i.path}: ${i.message}`)
      .join('; ');
    super(
      issues.length > 8
        ? `Legacy DXF validation failed (${issues.length} issues). ${summary}; …`
        : `Legacy DXF validation failed. ${summary}`,
    );
    this.name = 'LegacyExportValidationError';
    this.issues = issues;
  }
}

export function formatLegacyValidationIssues(issues: readonly ValidationIssue[]): string {
  return issues.map(i => `${i.path}: ${i.message}`).join('\n');
}

/**
 * Build the Legacy page-2 artifact when selectionId is legacy-eci-90.
 * Non-Legacy selections return { handled: false } without adapting.
 */
export function buildLegacyLayoutExport(
  selectionId: unknown,
  ctx: LegacyAdapterContext,
  options?: { filename?: string },
): LegacyTemplateExportResult {
  return tryBuildLegacyTemplateArtifact(
    selectionId,
    () => {
      const normalized = adaptSiteDesignToLegacyLayoutInput(ctx);
      const validation = validateLegacyLayoutInput(normalized);
      if (!validation.ok) {
        throw new LegacyExportValidationError(validation.issues);
      }
      return validation.value;
    },
    options,
  );
}

/** Download-ready Blob preserving artifact bytes exactly (no BOM/CRLF rewrite). */
export function legacyArtifactToBlob(artifact: LegacyExportArtifact): Blob {
  // Copy into a fresh ArrayBuffer-backed Uint8Array so BlobPart typing is satisfied.
  const copy = new Uint8Array(artifact.bytes.byteLength);
  copy.set(artifact.bytes);
  return new Blob([copy], { type: artifact.mimeType });
}
