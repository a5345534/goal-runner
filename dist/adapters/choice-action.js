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
import { parseChoiceActionRequest, parseChoiceActionSelectionResult, validateChoiceActionSelectionResultAgainstRequest, } from "goal-contract";
export { parseChoiceActionRequest, parseChoiceActionSelectionResult, validateChoiceActionSelectionResultAgainstRequest, };
// ---------------------------------------------------------------------------
// Text fallback rendering
// ---------------------------------------------------------------------------
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
export function renderChoiceActionTextFallback(request) {
    const lines = [];
    // Title and optional body
    lines.push(request.title);
    if (request.body) {
        lines.push("");
        lines.push(request.body);
    }
    // Numbered choices
    lines.push("");
    for (let i = 0; i < request.choices.length; i++) {
        const choice = request.choices[i];
        const number = i + 1;
        const aliasHint = choice.aliases.length > 0
            ? ` [aliases: ${choice.aliases.join(", ")}]`
            : "";
        const disabledNote = choice.disabled
            ? ` (unavailable: ${choice.disabledReason ?? "disabled"})`
            : "";
        const descriptionSuffix = choice.description ? ` — ${choice.description}` : "";
        lines.push(`${number}) ${choice.label}${aliasHint}${disabledNote}${descriptionSuffix}`);
    }
    // Fallback prompt
    lines.push("");
    lines.push(request.fallbackPrompt);
    return lines.join("\n");
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
export function normalizeChoiceActionTextInput(request, userInput, selectedAt) {
    const trimmed = userInput.trim();
    if (!trimmed) {
        return { error: "Empty input" };
    }
    const selectedAtIso = selectedAt ?? new Date().toISOString();
    // 1. Exact choice id
    const byId = request.choices.find((c) => c.id === trimmed);
    if (byId) {
        return {
            result: buildChoiceActionSelectionResult(request, byId, "canonical_text", "text_fallback", selectedAtIso),
        };
    }
    // 2. Exact canonical value
    const byCanonical = request.choices.find((c) => c.canonicalValue === trimmed);
    if (byCanonical) {
        return {
            result: buildChoiceActionSelectionResult(request, byCanonical, "canonical_text", "text_fallback", selectedAtIso),
        };
    }
    // 3. Alias matching (only when allowed)
    if (request.allowTextAliases) {
        const normalizedInput = normalizeAlias(trimmed);
        const byAlias = request.choices.find((c) => c.aliases.some((a) => normalizeAlias(a) === normalizedInput));
        if (byAlias) {
            return {
                result: buildChoiceActionSelectionResult(request, byAlias, "text_alias", "text_fallback", selectedAtIso),
            };
        }
    }
    return { error: `Input "${trimmed}" does not match any choice` };
}
/**
 * Build a `ChoiceActionSelectionResult` for an interactive selection (selector,
 * dialog, button, etc.).
 *
 * The caller is responsible for checking that the choice is valid and not
 * blocked by disabled state unless the request allows it.
 */
export function buildInteractiveChoiceActionResult(request, choice, selectedAt) {
    const result = buildChoiceActionSelectionResult(request, choice, "interactive", "interactive", selectedAt);
    // Validate against the request (disabled check, canonical match)
    validateChoiceActionSelectionResultAgainstRequest(result, request);
    return result;
}
/**
 * Build a `ChoiceActionSelectionResult` for a defaulted selection (timeout or
 * explicit default).
 */
export function buildDefaultedChoiceActionResult(request, selectedAt) {
    if (!request.defaultChoiceId)
        return undefined;
    const choice = request.choices.find((c) => c.id === request.defaultChoiceId);
    if (!choice)
        return undefined;
    const result = buildChoiceActionSelectionResult(request, choice, "defaulted", request.allowTextAliases ? "text_fallback" : "text_fallback", selectedAt);
    // For defaulted, allow disabled override if the request explicitly permits it
    try {
        validateChoiceActionSelectionResultAgainstRequest(result, request);
    }
    catch {
        if (!request.allowDisabledOverride)
            return undefined;
        // With override allowed, still return the result
    }
    return result;
}
// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------
function normalizeAlias(alias) {
    return alias.trim().toLowerCase();
}
function buildChoiceActionSelectionResult(request, choice, inputMode, renderMode, selectedAt) {
    return {
        requestId: request.requestId,
        choiceId: choice.id,
        canonicalValue: choice.canonicalValue,
        inputMode,
        renderMode,
        selectedAt: selectedAt ?? new Date().toISOString(),
    };
}
//# sourceMappingURL=choice-action.js.map