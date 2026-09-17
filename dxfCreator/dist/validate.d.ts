import type { LegacyLayoutInput, ValidationIssue, ValidationResult } from './types.js';
export declare class LegacyLayoutValidationError extends Error {
    readonly issues: readonly ValidationIssue[];
    constructor(issues: readonly ValidationIssue[]);
}
export declare function assertValidLegacyLayoutInput(input: unknown): LegacyLayoutInput;
export declare function validateLegacyLayoutInput(input: unknown): ValidationResult;
//# sourceMappingURL=validate.d.ts.map