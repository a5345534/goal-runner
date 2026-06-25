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
import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { parseChoiceActionRequest, validateChoiceActionSelectionResultAgainstRequest, } from "goal-contract";
import { buildDefaultedChoiceActionResult, buildInteractiveChoiceActionResult, normalizeChoiceActionTextInput, renderChoiceActionTextFallback, } from "../adapters/choice-action.js";
// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------
const SCOPE_CONFIRM_REQUEST = parseChoiceActionRequest({
    requestId: "scope-confirm-001",
    title: "Scope Confirmation",
    body: "Choose how to proceed with the scope analysis.",
    choices: [
        {
            id: "confirm",
            label: "Confirm scope for analysis",
            canonicalValue: "confirm_scope_for_analysis",
            aliases: ["1", "c", "confirm"],
            description: "Accept the scope and proceed to analysis.",
        },
        {
            id: "revise",
            label: "Revise scope",
            canonicalValue: "revise_scope",
            aliases: ["2", "r", "revise"],
            description: "Edit the scope before analysis.",
        },
        {
            id: "abandon",
            label: "Abandon proposal",
            canonicalValue: "abandon_proposal",
            aliases: ["3", "a", "abandon"],
            disabled: true,
            disabledReason: "Abandon requires project owner approval.",
        },
    ],
    fallbackPrompt: "Enter the number, alias, or canonical value of your choice:",
    allowTextAliases: true,
});
const APPROVAL_REQUEST = parseChoiceActionRequest({
    requestId: "approval-001",
    title: "OpenSpec Authoring Approval",
    body: "Select the authorization level for the OpenSpec change.",
    choices: [
        {
            id: "continue",
            label: "Continue discussion",
            canonicalValue: "continue_discussion",
            aliases: ["1", "continue", "discuss"],
        },
        {
            id: "approve_full",
            label: "Approve full authoring",
            canonicalValue: "approve_openspec_authoring",
            aliases: ["2", "approve", "full"],
        },
        {
            id: "approve_small",
            label: "Approve smaller-scope authoring",
            canonicalValue: "approve_smaller_scope_authoring",
            aliases: ["3", "smaller", "small"],
        },
        {
            id: "no_build",
            label: "Accept no-build",
            canonicalValue: "accept_no_build",
            aliases: ["4", "no", "nobuild"],
        },
        {
            id: "abandon",
            label: "Abandon",
            canonicalValue: "abandon_openspec_change",
            aliases: ["5", "abandon", "drop"],
        },
    ],
    fallbackPrompt: "Enter your choice (number, alias, or canonical value):",
    allowTextAliases: true,
    defaultChoiceId: "continue",
});
const NO_ALIAS_REQUEST = parseChoiceActionRequest({
    requestId: "no-alias-001",
    title: "Strict Mode",
    choices: [
        {
            id: "yes",
            label: "Yes",
            canonicalValue: "yes",
            aliases: ["y"],
        },
        {
            id: "no",
            label: "No",
            canonicalValue: "no",
            aliases: ["n"],
        },
    ],
    fallbackPrompt: "Yes or no?",
    allowTextAliases: false,
});
// ---------------------------------------------------------------------------
// Text fallback rendering
// ---------------------------------------------------------------------------
describe("renderChoiceActionTextFallback", () => {
    it("renders the title", () => {
        const text = renderChoiceActionTextFallback(SCOPE_CONFIRM_REQUEST);
        assert.ok(text.includes("Scope Confirmation"));
    });
    it("renders the body when present", () => {
        const text = renderChoiceActionTextFallback(SCOPE_CONFIRM_REQUEST);
        assert.ok(text.includes("Choose how to proceed with the scope analysis."));
    });
    it("renders ordered choices with labels", () => {
        const text = renderChoiceActionTextFallback(SCOPE_CONFIRM_REQUEST);
        assert.ok(text.includes("1) Confirm scope for analysis"));
        assert.ok(text.includes("2) Revise scope"));
        assert.ok(text.includes("3) Abandon proposal"));
    });
    it("renders aliases for each choice", () => {
        const text = renderChoiceActionTextFallback(SCOPE_CONFIRM_REQUEST);
        assert.ok(text.includes("[aliases: 1, c, confirm]"));
        assert.ok(text.includes("[aliases: 2, r, revise]"));
    });
    it("renders disabled annotation with reason", () => {
        const text = renderChoiceActionTextFallback(SCOPE_CONFIRM_REQUEST);
        assert.ok(text.includes("(unavailable: Abandon requires project owner approval.)"));
    });
    it("renders descriptions", () => {
        const text = renderChoiceActionTextFallback(SCOPE_CONFIRM_REQUEST);
        assert.ok(text.includes("Accept the scope and proceed to analysis"));
    });
    it("renders the fallback prompt", () => {
        const text = renderChoiceActionTextFallback(SCOPE_CONFIRM_REQUEST);
        assert.ok(text.includes("Enter the number, alias, or canonical value of your choice:"));
    });
    it("renders correctly for a request without body", () => {
        const text = renderChoiceActionTextFallback(NO_ALIAS_REQUEST);
        assert.ok(text.startsWith("Strict Mode"));
        assert.ok(text.includes("1) Yes"));
        assert.ok(text.includes("2) No"));
        assert.ok(text.includes("Yes or no?"));
    });
});
// ---------------------------------------------------------------------------
// Text input normalisation — aliases
// ---------------------------------------------------------------------------
describe("normalizeChoiceActionTextInput — aliases", () => {
    it("matches numeric alias '1'", () => {
        const { result } = normalizeChoiceActionTextInput(SCOPE_CONFIRM_REQUEST, "1");
        assert.ok(result);
        assert.strictEqual(result.choiceId, "confirm");
        assert.strictEqual(result.canonicalValue, "confirm_scope_for_analysis");
        assert.strictEqual(result.inputMode, "text_alias");
        assert.strictEqual(result.renderMode, "text_fallback");
    });
    it("matches short alias 'c'", () => {
        const { result } = normalizeChoiceActionTextInput(SCOPE_CONFIRM_REQUEST, "c");
        assert.ok(result);
        assert.strictEqual(result.choiceId, "confirm");
        assert.strictEqual(result.canonicalValue, "confirm_scope_for_analysis");
    });
    it("matches full alias 'confirm'", () => {
        const { result } = normalizeChoiceActionTextInput(SCOPE_CONFIRM_REQUEST, "confirm");
        assert.ok(result);
        assert.strictEqual(result.choiceId, "confirm");
    });
    it("matches alias '2' (second choice)", () => {
        const { result } = normalizeChoiceActionTextInput(SCOPE_CONFIRM_REQUEST, "2");
        assert.ok(result);
        assert.strictEqual(result.choiceId, "revise");
        assert.strictEqual(result.canonicalValue, "revise_scope");
    });
    it("matches alias 'r' (revise)", () => {
        const { result } = normalizeChoiceActionTextInput(SCOPE_CONFIRM_REQUEST, "r");
        assert.ok(result);
        assert.strictEqual(result.choiceId, "revise");
    });
    it("matches alias '3' (abandon — disabled but alias matching still works)", () => {
        // Disabled choice can still be found; validation against request decides
        // whether to accept it.
        const { result } = normalizeChoiceActionTextInput(SCOPE_CONFIRM_REQUEST, "3");
        assert.ok(result);
        assert.strictEqual(result.choiceId, "abandon");
        // Validation against request should block it
        assert.throws(() => validateChoiceActionSelectionResultAgainstRequest(result, SCOPE_CONFIRM_REQUEST), /disabled/);
    });
    it("returns error for unmatched input", () => {
        const { result, error } = normalizeChoiceActionTextInput(SCOPE_CONFIRM_REQUEST, "xyz");
        assert.strictEqual(result, undefined);
        assert.ok(error);
        assert.ok(error.includes("xyz"));
    });
    it("returns error for empty input", () => {
        const { result, error } = normalizeChoiceActionTextInput(SCOPE_CONFIRM_REQUEST, "   ");
        assert.strictEqual(result, undefined);
        assert.ok(error);
    });
    it("trims whitespace around input", () => {
        const { result } = normalizeChoiceActionTextInput(SCOPE_CONFIRM_REQUEST, "  1  ");
        assert.ok(result);
        assert.strictEqual(result.choiceId, "confirm");
    });
    it("is case-insensitive for aliases", () => {
        const { result } = normalizeChoiceActionTextInput(SCOPE_CONFIRM_REQUEST, "C");
        assert.ok(result);
        assert.strictEqual(result.choiceId, "confirm");
    });
    it("does not accept aliases when allowTextAliases is false", () => {
        const { result, error } = normalizeChoiceActionTextInput(NO_ALIAS_REQUEST, "y");
        assert.strictEqual(result, undefined);
        assert.ok(error);
    });
});
// ---------------------------------------------------------------------------
// Text input normalisation — canonical values
// ---------------------------------------------------------------------------
describe("normalizeChoiceActionTextInput — canonical values", () => {
    it("matches canonical value 'confirm_scope_for_analysis'", () => {
        const { result } = normalizeChoiceActionTextInput(SCOPE_CONFIRM_REQUEST, "confirm_scope_for_analysis");
        assert.ok(result);
        assert.strictEqual(result.choiceId, "confirm");
        assert.strictEqual(result.canonicalValue, "confirm_scope_for_analysis");
        assert.strictEqual(result.inputMode, "canonical_text");
    });
    it("matches canonical value 'revise_scope'", () => {
        const { result } = normalizeChoiceActionTextInput(SCOPE_CONFIRM_REQUEST, "revise_scope");
        assert.ok(result);
        assert.strictEqual(result.choiceId, "revise");
        assert.strictEqual(result.inputMode, "canonical_text");
    });
    it("matches canonical value even when allowTextAliases is false", () => {
        const { result } = normalizeChoiceActionTextInput(NO_ALIAS_REQUEST, "yes");
        assert.ok(result);
        assert.strictEqual(result.choiceId, "yes");
        assert.strictEqual(result.inputMode, "canonical_text");
    });
    it("matches choice id as canonical_text input mode", () => {
        const { result } = normalizeChoiceActionTextInput(APPROVAL_REQUEST, "approve_full");
        assert.ok(result);
        assert.strictEqual(result.choiceId, "approve_full");
        assert.strictEqual(result.inputMode, "canonical_text");
    });
});
// ---------------------------------------------------------------------------
// Interactive selection
// ---------------------------------------------------------------------------
describe("buildInteractiveChoiceActionResult", () => {
    it("produces a result with inputMode interactive and renderMode interactive", () => {
        const choice = SCOPE_CONFIRM_REQUEST.choices[0]; // confirm
        const result = buildInteractiveChoiceActionResult(SCOPE_CONFIRM_REQUEST, choice, "2026-06-25T12:00:00Z");
        assert.strictEqual(result.choiceId, "confirm");
        assert.strictEqual(result.canonicalValue, "confirm_scope_for_analysis");
        assert.strictEqual(result.inputMode, "interactive");
        assert.strictEqual(result.renderMode, "interactive");
        assert.strictEqual(result.selectedAt, "2026-06-25T12:00:00Z");
    });
    it("throws for a disabled choice when allowDisabledOverride is not set", () => {
        const abandon = SCOPE_CONFIRM_REQUEST.choices[2]; // abandon, disabled
        assert.throws(() => buildInteractiveChoiceActionResult(SCOPE_CONFIRM_REQUEST, abandon), /disabled/);
    });
    it("interactive and text-alias selections produce equivalent canonical values", () => {
        const interactive = buildInteractiveChoiceActionResult(SCOPE_CONFIRM_REQUEST, SCOPE_CONFIRM_REQUEST.choices[0], "2026-06-25T12:00:00Z");
        const textAlias = normalizeChoiceActionTextInput(SCOPE_CONFIRM_REQUEST, "1", "2026-06-25T12:00:01Z");
        assert.strictEqual(interactive.choiceId, textAlias.result.choiceId);
        assert.strictEqual(interactive.canonicalValue, textAlias.result.canonicalValue);
        // Only input/render mode differs
        assert.notStrictEqual(interactive.inputMode, textAlias.result.inputMode);
        assert.notStrictEqual(interactive.renderMode, textAlias.result.renderMode);
    });
});
// ---------------------------------------------------------------------------
// Defaulted selection
// ---------------------------------------------------------------------------
describe("buildDefaultedChoiceActionResult", () => {
    it("returns undefined when no defaultChoiceId is set", () => {
        const result = buildDefaultedChoiceActionResult(SCOPE_CONFIRM_REQUEST);
        assert.strictEqual(result, undefined);
    });
    it("returns the default choice result", () => {
        const result = buildDefaultedChoiceActionResult(APPROVAL_REQUEST, "2026-06-25T12:00:00Z");
        assert.ok(result);
        assert.strictEqual(result.choiceId, "continue");
        assert.strictEqual(result.canonicalValue, "continue_discussion");
        assert.strictEqual(result.inputMode, "defaulted");
        assert.strictEqual(result.selectedAt, "2026-06-25T12:00:00Z");
    });
    it("returns undefined when defaultChoiceId references a disabled choice without override", () => {
        const request = parseChoiceActionRequest({
            requestId: "disabled-default-001",
            title: "Test",
            choices: [
                {
                    id: "blocked",
                    label: "Blocked choice",
                    canonicalValue: "blocked",
                    aliases: ["1"],
                    disabled: true,
                    disabledReason: "Not available",
                },
                {
                    id: "ok",
                    label: "OK choice",
                    canonicalValue: "ok",
                    aliases: ["2"],
                },
            ],
            fallbackPrompt: "Pick one:",
            allowTextAliases: true,
            defaultChoiceId: "blocked",
            allowDisabledOverride: false,
        });
        const result = buildDefaultedChoiceActionResult(request);
        assert.strictEqual(result, undefined);
    });
    it("returns the result when allowDisabledOverride is true", () => {
        const request = parseChoiceActionRequest({
            requestId: "disabled-default-ok-001",
            title: "Test",
            choices: [
                {
                    id: "blocked",
                    label: "Blocked choice",
                    canonicalValue: "blocked",
                    aliases: ["1"],
                    disabled: true,
                    disabledReason: "Not available in this mode",
                },
            ],
            fallbackPrompt: "Fallback:",
            allowTextAliases: true,
            defaultChoiceId: "blocked",
            allowDisabledOverride: true,
        });
        const result = buildDefaultedChoiceActionResult(request);
        assert.ok(result);
        assert.strictEqual(result.choiceId, "blocked");
    });
});
// ---------------------------------------------------------------------------
// Integration: goal-spec gate scenarios
// ---------------------------------------------------------------------------
describe("goal-spec gate scenario equivalence", () => {
    it("Stage 1.7 scope confirmation: interactive and text produce same canonical value", () => {
        // Simulate Stage 1.7 scope-confirmation gate
        const request = parseChoiceActionRequest({
            requestId: "goal-spec-stage-1.7-gate",
            title: "Scope Confirmation",
            body: "Confirm, revise, or abandon the scope.",
            choices: [
                {
                    id: "confirm",
                    label: "Confirm scope for analysis",
                    canonicalValue: "confirm_scope_for_analysis",
                    aliases: ["1", "c", "confirm"],
                },
                {
                    id: "revise",
                    label: "Revise scope",
                    canonicalValue: "revise_scope",
                    aliases: ["2", "r", "revise"],
                },
                {
                    id: "abandon",
                    label: "Abandon proposal",
                    canonicalValue: "abandon_proposal",
                    aliases: ["3", "a", "abandon"],
                },
            ],
            fallbackPrompt: "Enter number, alias, or canonical value:",
            allowTextAliases: true,
        });
        // Interactive selection of confirm
        const interactive = buildInteractiveChoiceActionResult(request, request.choices[0]);
        // Text alias "1"
        const alias1 = normalizeChoiceActionTextInput(request, "1");
        // Text alias "c"
        const aliasC = normalizeChoiceActionTextInput(request, "c");
        // Canonical text
        const canonical = normalizeChoiceActionTextInput(request, "confirm_scope_for_analysis");
        // All produce the same canonical value
        assert.strictEqual(interactive.canonicalValue, "confirm_scope_for_analysis");
        assert.strictEqual(alias1.result.canonicalValue, "confirm_scope_for_analysis");
        assert.strictEqual(aliasC.result.canonicalValue, "confirm_scope_for_analysis");
        assert.strictEqual(canonical.result.canonicalValue, "confirm_scope_for_analysis");
        // All reference the same choice
        assert.strictEqual(interactive.choiceId, "confirm");
        assert.strictEqual(alias1.result.choiceId, "confirm");
        assert.strictEqual(aliasC.result.choiceId, "confirm");
        assert.strictEqual(canonical.result.choiceId, "confirm");
    });
    it("Stage 5 approval gate: all inputs produce correct canonical values", () => {
        // Simulate Stage 5 approval gate
        const request = parseChoiceActionRequest({
            requestId: "goal-spec-stage-5-gate",
            title: "OpenSpec Authoring Approval",
            choices: [
                {
                    id: "continue",
                    label: "Continue discussion",
                    canonicalValue: "continue_discussion",
                    aliases: ["1", "continue", "discuss"],
                },
                {
                    id: "approve_full",
                    label: "Approve full authoring",
                    canonicalValue: "approve_openspec_authoring",
                    aliases: ["2", "approve", "full"],
                },
                {
                    id: "approve_small",
                    label: "Approve smaller-scope authoring",
                    canonicalValue: "approve_smaller_scope_authoring",
                    aliases: ["3", "smaller", "small"],
                },
                {
                    id: "no_build",
                    label: "Accept no-build",
                    canonicalValue: "accept_no_build",
                    aliases: ["4", "no", "nobuild"],
                },
                {
                    id: "abandon",
                    label: "Abandon",
                    canonicalValue: "abandon_openspec_change",
                    aliases: ["5", "abandon", "drop"],
                },
            ],
            fallbackPrompt: "Enter your choice:",
            allowTextAliases: true,
        });
        const interactive = buildInteractiveChoiceActionResult(request, request.choices[1]); // approve_full
        const alias2 = normalizeChoiceActionTextInput(request, "2");
        const aliasApprove = normalizeChoiceActionTextInput(request, "approve");
        const canonical = normalizeChoiceActionTextInput(request, "approve_openspec_authoring");
        assert.strictEqual(interactive.canonicalValue, "approve_openspec_authoring");
        assert.strictEqual(alias2.result.canonicalValue, "approve_openspec_authoring");
        assert.strictEqual(aliasApprove.result.canonicalValue, "approve_openspec_authoring");
        assert.strictEqual(canonical.result.canonicalValue, "approve_openspec_authoring");
    });
});
// ---------------------------------------------------------------------------
// Validation round-trip
// ---------------------------------------------------------------------------
describe("result validation against request", () => {
    it("accepts a valid interactive result", () => {
        const choice = SCOPE_CONFIRM_REQUEST.choices[0];
        const result = buildInteractiveChoiceActionResult(SCOPE_CONFIRM_REQUEST, choice);
        // Should not throw
        validateChoiceActionSelectionResultAgainstRequest(result, SCOPE_CONFIRM_REQUEST);
    });
    it("accepts a valid text alias result", () => {
        const { result } = normalizeChoiceActionTextInput(SCOPE_CONFIRM_REQUEST, "2");
        assert.ok(result);
        validateChoiceActionSelectionResultAgainstRequest(result, SCOPE_CONFIRM_REQUEST);
    });
    it("rejects result with mismatched canonical value", () => {
        const bogus = {
            requestId: SCOPE_CONFIRM_REQUEST.requestId,
            choiceId: "confirm",
            canonicalValue: "wrong_value",
            inputMode: "interactive",
            renderMode: "interactive",
            selectedAt: new Date().toISOString(),
        };
        assert.throws(() => validateChoiceActionSelectionResultAgainstRequest(bogus, SCOPE_CONFIRM_REQUEST), /mismatch|does not match/);
    });
    it("rejects result with unknown choice id", () => {
        const bogus = {
            requestId: SCOPE_CONFIRM_REQUEST.requestId,
            choiceId: "nonexistent",
            canonicalValue: "confirm_scope_for_analysis",
            inputMode: "interactive",
            renderMode: "interactive",
            selectedAt: new Date().toISOString(),
        };
        assert.throws(() => validateChoiceActionSelectionResultAgainstRequest(bogus, SCOPE_CONFIRM_REQUEST), /not found/);
    });
});
//# sourceMappingURL=choice-action-adapter.test.js.map