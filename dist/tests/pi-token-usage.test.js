import test from "node:test";
import assert from "node:assert/strict";
import { normalizePiAssistantUsage, readPiAssistantTokenTotalFromEntries } from "../adapters/pi/index.js";
import { GoalRuntime, MemoryGoalStore } from "../core/index.js";
test("Pi assistant usage counts input plus output", () => {
    assert.equal(normalizePiAssistantUsage({ input: 100, output: 40 }), 140);
});
test("Pi assistant usage excludes cache accounting channels", () => {
    assert.equal(normalizePiAssistantUsage({ input: 100, output: 40, cacheRead: 1_000, cacheWrite: 500 }), 140);
});
test("Pi assistant usage falls back to totalTokens when input/output are unavailable", () => {
    assert.equal(normalizePiAssistantUsage({ totalTokens: 250, cacheRead: 1_000 }), 250);
});
test("Pi branch token total sums normalized assistant messages only", () => {
    const entries = [
        { type: "message", message: { role: "user", usage: { input: 999, output: 999 } } },
        { type: "message", message: { role: "assistant", usage: { input: 10, output: 5, cacheRead: 100 } } },
        { type: "custom", message: { role: "assistant", usage: { input: 999, output: 999 } } },
        { type: "message", message: { role: "assistant", usage: { totalTokens: 7 } } },
    ];
    assert.equal(readPiAssistantTokenTotalFromEntries(entries), 22);
});
test("normalized Pi snapshots still drive core budget crossing", async () => {
    const runtime = new GoalRuntime({ store: new MemoryGoalStore() });
    await runtime.createOrReplaceGoal("s1", "budgeted", { tokenBudget: 100 });
    await runtime.turnStarted({ sessionKey: "s1", turnId: "t1", tokenUsage: { totalTokens: 0 } });
    await runtime.toolCompleted({
        sessionKey: "s1",
        turnId: "t1",
        tokenUsage: { totalTokens: normalizePiAssistantUsage({ input: 80, output: 25, cacheRead: 1_000 }) },
        toolName: "bash",
        meaningfulProgress: true,
    });
    assert.equal((await runtime.getGoal("s1")).goal?.status, "budgetLimited");
});
//# sourceMappingURL=pi-token-usage.test.js.map