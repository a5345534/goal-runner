/**
 * Harness-neutral choice/action adapter utilities.
 *
 * Exposes shared text-fallback rendering and input normalization that every
 * harness adapter can consume.  Harness-specific rendering (selector, dialog,
 * command-palette, etc.) lives inside the per-harness adapter files and calls
 * into the normalizers below to produce `ChoiceActionSelectionResult` values
 * that are portable across presentation modes.
 *
 * These utilities consume the shared `goal-contract` types and validators;
 * no Pi-specific, web-specific, or terminal-specific fields leak into the
 * return values.
 */
import { type ChoiceActionChoice, type ChoiceActionInputMode, type ChoiceActionRenderMode, type ChoiceActionRequest, type ChoiceActionSelectionResult, parseChoiceActionRequest, parseChoiceActionSelectionResult, validateChoiceActionSelectionResultAgainstRequest } from "goal-contract";
export type { ChoiceActionChoice, ChoiceActionInputMode, ChoiceActionRenderMode, ChoiceActionRequest, ChoiceActionSelectionResult, };
export { parseChoiceActionRequest, parseChoiceActionSelectionResult, validateChoiceActionSelectionResultAgainstRequest, };
/**
 * Render a `ChoiceActionRequest` as a text prompt suitable for non-interactive
 * harnesses.
 *
 * The output includes:
 *  1. The request title
 *  2. Optional body
 *  3. A numbered list of choices with labels and aliases
 *  4. The request's `fallbackPrompt` as a trailing prompt line
 *
 * Disabled choices are annotated with their `disabledReason`.
 */
export declare function renderChoiceActionTextFallback(request: ChoiceActionRequest): string;
/**
 * Result of attempting to normalize a user text input against a
 * `ChoiceActionRequest`.
 */
export interface ChoiceActionNormalizationResult {
    /** The normalized selection result, or `undefined` when no match was found. */
    result?: ChoiceActionSelectionResult;
    /** When `result` is undefined, this describes why the input didn't match. */
    error?: string;
}
/**
 * Normalize a free-text user input against a `ChoiceActionRequest`.
 *
 * Matching order (first match wins):
 *  1. Exact choice id
 *  2. Exact canonical value
 *  3. Normalized alias (case-insensitive trimmed)
 *  4. If `allowTextAliases` is false, only exact choice id and canonical value
 *     are accepted; alias-based matching is skipped.
 *
 * Returns `undefined` when no choice matches the input.
 */
export declare function normalizeChoiceActionTextInput(request: ChoiceActionRequest, userInput: string, selectedAt?: string): ChoiceActionNormalizationResult;
/**
 * Build a `ChoiceActionSelectionResult` for an interactive selection (selector,
 * dialog, button, etc.).
 *
 * The caller is responsible for checking that the choice is valid and not
 * blocked by disabled state unless the request allows it.
 */
export declare function buildInteractiveChoiceActionResult(request: ChoiceActionRequest, choice: ChoiceActionChoice, selectedAt?: string): ChoiceActionSelectionResult;
/**
 * Build a `ChoiceActionSelectionResult` for a defaulted selection (timeout or
 * explicit default).
 */
export declare function buildDefaultedChoiceActionResult(request: ChoiceActionRequest, selectedAt?: string): ChoiceActionSelectionResult | undefined;
