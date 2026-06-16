/**
 * Shared supported required-evidence token registry.
 *
 * This module is the single source of truth for controller-enforced
 * `validation.requiredEvidence` tokens.  Every consumer — parser, schema,
 * validation runner, docs, tests, and future adapters — must reference
 * this registry instead of maintaining its own copy.
 */
export const SUPPORTED_REQUIRED_EVIDENCE = [
    "validators-ran",
    "locked-artifacts-unchanged",
    "implementation-diff-present",
    "non-test-diff-present",
    "post-merge-validation-ran",
    "audit-report-present",
];
/** O(1) lookup set built from the canonical token list. */
export const SUPPORTED_REQUIRED_EVIDENCE_SET = new Set(SUPPORTED_REQUIRED_EVIDENCE);
/**
 * Type guard / runtime check to determine whether a string value is a
 * supported controller-enforced evidence token.
 */
export function isSupportedRequiredEvidence(value) {
    return SUPPORTED_REQUIRED_EVIDENCE_SET.has(value);
}
//# sourceMappingURL=validation-evidence.js.map