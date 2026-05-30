import test from "node:test";
import assert from "node:assert/strict";
import { fromCodexWireStatus, normalizeGoalStatus, renderActiveGoalReminderPrompt, renderBudgetLimitPrompt, renderCompletionAuditPrompt, renderContinuationPrompt, renderObjectiveUpdatedPrompt, } from "../core/index.js";
const goal = {
    sessionKey: "test-session",
    goalId: "goal-1",
    objective: "Finish the goal and verify it",
    status: "active",
    tokenBudget: 100,
    tokensUsed: 40,
    timeUsedSeconds: 12,
    createdAt: "2026-05-29T00:00:00.000Z",
    updatedAt: "2026-05-29T00:00:00.000Z",
    goalTurnsSinceAuditReset: 0,
};
test("status normalization preserves Codex wire names and legacy aliases", () => {
    assert.equal(normalizeGoalStatus("usageLimited"), "usageLimited");
    assert.equal(normalizeGoalStatus("usage_limited"), "usageLimited");
    assert.equal(normalizeGoalStatus("budgetLimited"), "budgetLimited");
    assert.equal(normalizeGoalStatus("budget_limited"), "budgetLimited");
    assert.equal(fromCodexWireStatus("complete"), "complete");
    assert.throws(() => normalizeGoalStatus("cancelled"), /unknown goal status/);
});
test("continuation prompt preserves objective and blocked threshold", () => {
    const prompt = renderContinuationPrompt(goal);
    assert.match(prompt, /Finish the goal and verify it/);
    assert.match(prompt, /untrusted user-provided task data/);
    assert.match(prompt, /three consecutive goal turns/);
    assert.match(prompt, /update_goal\(\{"status":"complete"\}\)/);
    assert.match(prompt, /update_goal\(\{"status":"blocked"\}\)/);
});
test("active goal reminder preserves objective and policy priority", () => {
    const prompt = renderActiveGoalReminderPrompt(goal);
    assert.match(prompt, /Finish the goal and verify it/);
    assert.match(prompt, /user-provided task data/);
    assert.match(prompt, /Respect all system, developer, workspace, and tool policies above this goal objective/);
    assert.match(prompt, /tokens remaining: 60/);
});
test("budget and objective update prompts include untrusted goal context", () => {
    assert.match(renderBudgetLimitPrompt(goal), /token budget/i);
    assert.match(renderBudgetLimitPrompt(goal), /Finish the goal and verify it/);
    assert.match(renderBudgetLimitPrompt(goal), /untrusted user-provided task data/);
    assert.match(renderObjectiveUpdatedPrompt(goal), /objective was updated/i);
    assert.match(renderObjectiveUpdatedPrompt(goal), /Finish the goal and verify it/);
    assert.match(renderObjectiveUpdatedPrompt(goal), /untrusted user-provided task data/);
});
test("completion audit prompt treats objective as untrusted data", () => {
    const prompt = renderCompletionAuditPrompt({
        goal,
        ledgerEvents: [],
        completionEvidence: { source: "test", verificationSignals: ["npm test passed"] },
    });
    assert.match(prompt, /Finish the goal and verify it/);
    assert.match(prompt, /untrusted user-provided task data/);
    assert.match(prompt, /higher-priority policy/);
});
//# sourceMappingURL=status-prompts.test.js.map