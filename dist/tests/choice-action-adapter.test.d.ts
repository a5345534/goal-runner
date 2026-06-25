/**
 * Tests for the harness-neutral choice/action adapter utilities.
 *
 * Covers:
 *  - Text fallback rendering preserves ordered choices, labels, aliases, and
 *    fallback prompt.
 *  - Text input normalisation maps aliases (numeric, short text) and canonical
 *    values to the correct choice.
 *  - Interactive selection produces equivalent canonical values to text
 *    selection.
 *  - Defaulted selection respects the request's defaultChoiceId.
 *  - Normalised results pass validation against their source request.
 */
export {};
