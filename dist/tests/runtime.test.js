import test from "node:test";
import assert from "node:assert/strict";
import { GoalRuntime, MemoryGoalStore } from "../core/index.js";
test("runtime keeps one current goal per session", async () => {
    const runtime = new GoalRuntime({ store: new MemoryGoalStore() });
    await runtime.createOrReplaceGoal("s1", "first");
    await runtime.createOrReplaceGoal("s1", "second");
    const result = await runtime.getGoal("s1");
    assert.equal(result.goal?.objective, "second");
    assert.equal(result.goal?.status, "active");
});
test("update_goal only accepts complete or blocked", async () => {
    const runtime = new GoalRuntime({ store: new MemoryGoalStore() });
    await runtime.createOrReplaceGoal("s1", "finish");
    await assert.rejects(() => runtime.toolUpdateGoal("s1", "paused"), /only accepts/);
    await runtime.toolUpdateGoal("s1", "complete");
    assert.equal((await runtime.getGoal("s1")).goal?.status, "complete");
});
test("blocked requires three goal turns", async () => {
    const runtime = new GoalRuntime({ store: new MemoryGoalStore(), config: { retryBaseDelayMs: 0, retryJitterMs: 0 } });
    await runtime.createOrReplaceGoal("s1", "blocked test");
    await runtime.turnStarted({ sessionKey: "s1", turnId: "t1" });
    await assert.rejects(() => runtime.toolUpdateGoal("s1", "blocked"), /3 consecutive/);
    await runtime.turnStarted({ sessionKey: "s1", turnId: "t2" });
    await runtime.turnStarted({ sessionKey: "s1", turnId: "t3" });
    await runtime.toolUpdateGoal("s1", "blocked");
    assert.equal((await runtime.getGoal("s1")).goal?.status, "blocked");
});
test("blocked audit evidence can reject non-matching blockers even after three turns", async () => {
    const runtime = new GoalRuntime({ store: new MemoryGoalStore(), config: { retryBaseDelayMs: 0, retryJitterMs: 0 } });
    await runtime.createOrReplaceGoal("s1", "blocked evidence test");
    await runtime.turnStarted({ sessionKey: "s1", turnId: "t1" });
    await runtime.turnStarted({ sessionKey: "s1", turnId: "t2" });
    await runtime.turnStarted({ sessionKey: "s1", turnId: "t3" });
    await assert.rejects(() => runtime.toolUpdateGoal("s1", "blocked", {
        blockedAuditEvidence: {
            inspectedGoalTurns: 3,
            consecutiveMatchingTurns: 1,
            blockerSignature: "tool:error-a",
            reason: "recent blocker signatures are not the same",
            source: "test",
        },
    }), /matching blocker evidence/);
    await runtime.toolUpdateGoal("s1", "blocked", {
        blockedAuditEvidence: {
            inspectedGoalTurns: 3,
            consecutiveMatchingTurns: 3,
            blockerSignature: "tool:error-a",
            source: "test",
        },
    });
    assert.equal((await runtime.getGoal("s1")).goal?.status, "blocked");
});
test("idle active goal starts hidden continuation once", async () => {
    const store = new MemoryGoalStore();
    const requests = [];
    const runtime = new GoalRuntime({
        store,
        config: { retryBaseDelayMs: 0, retryJitterMs: 0 },
        callbacks: {
            readHarnessState: () => ({
                materialized: true,
                queuedUserInput: false,
                queuedTriggerTurn: false,
                continuationSuppressed: false,
            }),
            startHiddenGoalTurn: (request) => {
                requests.push(request);
                return { kind: "started", hostTurnId: "h1" };
            },
        },
    });
    await runtime.createOrReplaceGoal("s1", "continue me");
    assert.equal(requests.length, 1);
    const second = await runtime.maybeContinueIfIdle("s1");
    assert.deepEqual(second, { kind: "notEligible", reason: "continuation already reserved" });
    assert.equal(requests.length, 1);
});
test("active goal starts another hidden continuation after a hidden turn finishes", async () => {
    const requests = [];
    const runtime = new GoalRuntime({
        store: new MemoryGoalStore(),
        config: { retryBaseDelayMs: 0, retryJitterMs: 0 },
        callbacks: {
            readHarnessState: () => ({
                materialized: true,
                queuedUserInput: false,
                queuedTriggerTurn: false,
                continuationSuppressed: false,
            }),
            startHiddenGoalTurn: (request) => {
                requests.push(request);
                return { kind: "started", hostTurnId: `h${requests.length}` };
            },
        },
    });
    await runtime.createOrReplaceGoal("s1", "continue until done");
    assert.equal(requests.length, 1);
    await runtime.turnStarted({ sessionKey: "s1", turnId: "hidden-1" });
    await runtime.turnFinished({ sessionKey: "s1", turnId: "hidden-1" }, true);
    assert.equal(requests.length, 2);
    assert.notEqual(requests[0]?.attemptId, requests[1]?.attemptId);
});
test("retryable hidden-turn failure retries within bounds", async () => {
    let attempts = 0;
    const runtime = new GoalRuntime({
        store: new MemoryGoalStore(),
        config: { retryBaseDelayMs: 0, retryJitterMs: 0, maxContinuationAttempts: 3 },
        callbacks: {
            readHarnessState: () => ({
                materialized: true,
                queuedUserInput: false,
                queuedTriggerTurn: false,
                continuationSuppressed: false,
            }),
            startHiddenGoalTurn: () => {
                attempts += 1;
                return attempts < 3 ? { kind: "retryableFailure", error: "temporary" } : { kind: "started", hostTurnId: "h3" };
            },
        },
    });
    await runtime.createOrReplaceGoal("s1", "retry me");
    assert.equal(attempts, 3);
});
test("queued user input suppresses continuation", async () => {
    let attempts = 0;
    const runtime = new GoalRuntime({
        store: new MemoryGoalStore(),
        callbacks: {
            readHarnessState: () => ({
                materialized: true,
                queuedUserInput: true,
                queuedTriggerTurn: false,
                continuationSuppressed: false,
            }),
            startHiddenGoalTurn: () => {
                attempts += 1;
                return { kind: "started" };
            },
        },
    });
    const result = await runtime.createOrReplaceGoal("s1", "wait for user");
    assert.equal(result.goal?.status, "active");
    assert.equal(attempts, 0);
});
test("goal edit can update token budget without resetting usage", async () => {
    const runtime = new GoalRuntime({ store: new MemoryGoalStore() });
    await runtime.createOrReplaceGoal("s1", "old objective", { tokenBudget: 1_000 });
    await runtime.turnStarted({ sessionKey: "s1", turnId: "t1", tokenUsage: { totalTokens: 0 } });
    await runtime.toolCompleted({ sessionKey: "s1", tokenUsage: { totalTokens: 250 } });
    const result = await runtime.executeCommand("s1", "edit --tokens 500 new objective");
    assert.equal(result.goal?.objective, "new objective");
    assert.equal(result.goal?.tokenBudget, 500);
    assert.equal(result.goal?.tokensUsed, 250);
    assert.equal(result.goal?.status, "active");
});
test("goal edit becomes budget-limited when the new budget is already exhausted", async () => {
    const runtime = new GoalRuntime({ store: new MemoryGoalStore() });
    await runtime.createOrReplaceGoal("s1", "old objective", { tokenBudget: 1_000 });
    await runtime.turnStarted({ sessionKey: "s1", turnId: "t1", tokenUsage: { totalTokens: 0 } });
    await runtime.toolCompleted({ sessionKey: "s1", tokenUsage: { totalTokens: 250 } });
    const result = await runtime.executeCommand("s1", "edit --tokens 100 new objective");
    assert.equal(result.goal?.tokenBudget, 100);
    assert.equal(result.goal?.tokensUsed, 250);
    assert.equal(result.goal?.status, "budgetLimited");
});
test("budget-limited resume does not continue while budget remains exhausted", async () => {
    let attempts = 0;
    const runtime = new GoalRuntime({
        store: new MemoryGoalStore(),
        callbacks: {
            readHarnessState: () => ({
                materialized: true,
                queuedUserInput: false,
                queuedTriggerTurn: false,
                continuationSuppressed: false,
            }),
            startHiddenGoalTurn: () => {
                attempts += 1;
                return { kind: "started" };
            },
        },
    });
    await runtime.createOrReplaceGoal("s1", "budgeted", { tokenBudget: 100 });
    await runtime.turnStarted({ sessionKey: "s1", turnId: "t1", tokenUsage: { totalTokens: 0 } });
    await runtime.toolCompleted({ sessionKey: "s1", tokenUsage: { totalTokens: 150 } });
    attempts = 0;
    const result = await runtime.resumeGoal("s1");
    assert.equal(result.goal?.status, "budgetLimited");
    assert.equal(result.message, "Goal token budget is still exhausted.");
    assert.equal(attempts, 0);
});
test("unfinished failed turns do not auto-continue", async () => {
    let attempts = 0;
    const runtime = new GoalRuntime({
        store: new MemoryGoalStore(),
        callbacks: {
            readHarnessState: () => ({
                materialized: true,
                queuedUserInput: true,
                queuedTriggerTurn: false,
                continuationSuppressed: false,
            }),
            startHiddenGoalTurn: () => {
                attempts += 1;
                return { kind: "started" };
            },
        },
    });
    await runtime.createOrReplaceGoal("s1", "do not continue on abort");
    await runtime.turnStarted({ sessionKey: "s1", turnId: "t1" });
    await runtime.turnFinished({ sessionKey: "s1", turnId: "t1" }, false);
    assert.equal(attempts, 0);
    assert.equal((await runtime.getGoal("s1")).goal?.status, "active");
});
//# sourceMappingURL=runtime.test.js.map