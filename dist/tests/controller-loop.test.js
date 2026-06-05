import test from "node:test";
import assert from "node:assert/strict";
import { GoalRuntime, MemoryGoalStore, } from "../core/index.js";
const now = "2026-06-02T00:00:00.000Z";
class FakeSubagentAdapter {
    adapterId = "fake";
    starts = [];
    prompts = [];
    states = new Map();
    startSession(request) {
        this.starts.push(request);
        return {
            sessionId: `session-${request.subagentId}`,
            sessionFile: `/sessions/${request.subagentId}.jsonl`,
            workspacePath: request.cwd,
            branch: request.branch,
            ref: request.ref,
            status: "running",
            lastActivityAt: now,
        };
    }
    sendPrompt(request) {
        this.prompts.push(request);
    }
    getSessionState(request) {
        return this.states.get(request.subagent.subagentId) ?? { status: "running", lastActivityAt: now };
    }
    abortSession() { }
}
async function runtimeWithPlan(inputs) {
    const runtime = new GoalRuntime({ store: new MemoryGoalStore(), config: { now: () => new Date(now), randomId: () => "goal-1" } });
    const nodes = await runtime.planGoalDag("goal-1", inputs, { now });
    return { runtime, nodes };
}
function subagent(overrides = {}) {
    return {
        goalId: "goal-1",
        nodeId: "build",
        subagentId: "subagent-1",
        harnessAdapterId: "fake",
        sessionId: "session-subagent-1",
        status: "running",
        prompts: ["initial"],
        createdAt: now,
        updatedAt: now,
        ...overrides,
    };
}
test("controller tick starts ready DAG nodes through the subagent adapter", async () => {
    const { runtime } = await runtimeWithPlan([{ nodeId: "build", objective: "Build feature", validators: ["npm test"] }]);
    const adapter = new FakeSubagentAdapter();
    const tick = await runtime.runGoalControllerTick("goal-1", {
        adapter,
        schedulingPolicy: { maxConcurrentSubagents: 1 },
        workspaceAllocator: ({ node }) => ({ cwd: `/repo/.worktrees/${node.slug}`, branch: `feat/${node.slug}` }),
    });
    assert.equal(tick.started.length, 1);
    assert.equal(adapter.starts.length, 1);
    assert.equal(adapter.starts[0]?.cwd, "/repo/.worktrees/build-feature");
    assert.equal(adapter.starts[0]?.branch, "feat/build-feature");
    assert.match(adapter.starts[0]?.initialPrompt ?? "", /Build feature/);
    assert.equal((await runtime.getGoalDagNode("goal-1", "build"))?.status, "running");
    assert.equal((await runtime.getGoalSubagent("goal-1", tick.started[0]?.subagentId ?? ""))?.workspacePath, "/repo/.worktrees/build-feature");
});
test("subagent self-report is held for controller validation when no validator is configured", async () => {
    const { runtime } = await runtimeWithPlan([{ nodeId: "build", objective: "Build feature" }]);
    await runtime.saveGoalDagNode({ ...await runtime.getGoalDagNode("goal-1", "build"), status: "running", updatedAt: now });
    await runtime.saveGoalSubagent(subagent());
    const adapter = new FakeSubagentAdapter();
    adapter.states.set("subagent-1", { status: "selfReportedComplete", selfReportedResult: "done", lastActivityAt: "2026-06-02T00:01:00.000Z" });
    const tick = await runtime.runGoalControllerTick("goal-1", { adapter });
    assert.equal(tick.synced.length, 1);
    assert.equal(tick.validating.length, 1);
    assert.equal(tick.completed.length, 0);
    assert.equal((await runtime.getGoalDagNode("goal-1", "build"))?.status, "controllerValidating");
    assert.equal((await runtime.getGoalSubagent("goal-1", "subagent-1"))?.status, "controllerValidating");
});
test("controller validator completion unlocks dependent ready nodes in the same tick", async () => {
    const { runtime } = await runtimeWithPlan([
        { nodeId: "build", objective: "Build feature" },
        { nodeId: "docs", objective: "Document feature", dependencyNodeIds: ["build"] },
    ]);
    await runtime.saveGoalDagNode({ ...await runtime.getGoalDagNode("goal-1", "build"), status: "running", updatedAt: now });
    await runtime.saveGoalSubagent(subagent());
    const adapter = new FakeSubagentAdapter();
    adapter.states.set("subagent-1", { status: "selfReportedComplete", selfReportedResult: "done", lastActivityAt: "2026-06-02T00:01:00.000Z" });
    const tick = await runtime.runGoalControllerTick("goal-1", {
        adapter,
        validator: () => ({ status: "passed", summary: "controller tests passed", validationSignals: ["npm test"] }),
    });
    assert.deepEqual(tick.completed.map((node) => node.nodeId), ["build"]);
    assert.deepEqual(tick.started.map((item) => item.nodeId), ["docs"]);
    assert.equal((await runtime.getGoalDagNode("goal-1", "build"))?.status, "complete");
    assert.equal((await runtime.getGoalDagNode("goal-1", "docs"))?.status, "running");
    assert.deepEqual((await runtime.getGoalSubagent("goal-1", "subagent-1"))?.controllerValidationResults, ["controller tests passed", "npm test"]);
});
test("controller validator failure can send a follow-up prompt instead of completing the node", async () => {
    const { runtime } = await runtimeWithPlan([{ nodeId: "build", objective: "Build feature" }]);
    await runtime.saveGoalDagNode({ ...await runtime.getGoalDagNode("goal-1", "build"), status: "running", updatedAt: now });
    await runtime.saveGoalSubagent(subagent());
    const adapter = new FakeSubagentAdapter();
    adapter.states.set("subagent-1", { status: "selfReportedComplete", selfReportedResult: "done", lastActivityAt: "2026-06-02T00:01:00.000Z" });
    const tick = await runtime.runGoalControllerTick("goal-1", {
        adapter,
        validator: () => ({ status: "failed", summary: "tests failed", followupPrompt: "Fix failing tests" }),
    });
    assert.equal(tick.followups.length, 1);
    assert.equal(adapter.prompts[0]?.prompt, "Fix failing tests");
    assert.equal((await runtime.getGoalDagNode("goal-1", "build"))?.status, "running");
    assert.equal((await runtime.getGoalSubagent("goal-1", "subagent-1"))?.status, "running");
});
test("controller asks idle subagents with terminal text but missing outcome marker to re-report explicitly", async () => {
    const { runtime } = await runtimeWithPlan([{ nodeId: "build", objective: "Build feature" }]);
    await runtime.saveGoalDagNode({ ...await runtime.getGoalDagNode("goal-1", "build"), status: "running", updatedAt: now });
    await runtime.saveGoalSubagent(subagent());
    const adapter = new FakeSubagentAdapter();
    adapter.states.set("subagent-1", { status: "needsFollowup", selfReportedResult: "Implemented files and verification passed, but no marker.", lastActivityAt: "2026-06-02T00:01:00.000Z" });
    const tick = await runtime.runGoalControllerTick("goal-1", { adapter });
    assert.equal(tick.followups.length, 1);
    assert.match(adapter.prompts[0]?.prompt ?? "", /EXPLICIT_OUTCOME_MARKER/);
    assert.match(adapter.prompts[0]?.prompt ?? "", /SUBAGENT_RESULT/);
    assert.match(adapter.prompts[0]?.prompt ?? "", /SUBAGENT_BLOCKED/);
    assert.equal((await runtime.getGoalDagNode("goal-1", "build"))?.status, "running");
    assert.equal((await runtime.getGoalSubagent("goal-1", "subagent-1"))?.status, "running");
});
test("controller sends stale subagent continuation prompt for stale needs-followup sessions", async () => {
    const { runtime } = await runtimeWithPlan([{ nodeId: "build", objective: "Build feature" }]);
    await runtime.saveGoalDagNode({ ...await runtime.getGoalDagNode("goal-1", "build"), status: "running", updatedAt: now });
    await runtime.saveGoalSubagent(subagent({ status: "running", integrationStatus: "stale-subagent-session: no transcript activity for 1200s after last message role=toolResult" }));
    const adapter = new FakeSubagentAdapter();
    adapter.states.set("subagent-1", {
        status: "needsFollowup",
        error: "stale-subagent-session: no transcript activity for 1200s after last message role=toolResult",
        lastActivityAt: "2026-06-02T00:01:00.000Z",
    });
    const tick = await runtime.runGoalControllerTick("goal-1", { adapter });
    assert.equal(tick.followups.length, 1);
    assert.match(adapter.prompts[0]?.prompt ?? "", /STALE_SUBAGENT_SESSION/);
    assert.match(adapter.prompts[0]?.prompt ?? "", /Continue from the existing session transcript/);
    assert.equal((await runtime.getGoalDagNode("goal-1", "build"))?.status, "running");
    assert.equal((await runtime.getGoalSubagent("goal-1", "subagent-1"))?.status, "running");
});
test("controller auto-retries existing failed subagents with WebSocket transport errors", async () => {
    const { runtime } = await runtimeWithPlan([{ nodeId: "build", objective: "Build feature" }]);
    await runtime.saveGoalDagNode({ ...await runtime.getGoalDagNode("goal-1", "build"), status: "failed", updatedAt: now, lastValidationSummary: "WebSocket error" });
    await runtime.saveGoalSubagent(subagent({ status: "failed", integrationStatus: "WebSocket error", workspacePath: "/repo/.worktrees/build" }));
    const adapter = new FakeSubagentAdapter();
    const tick = await runtime.runGoalControllerTick("goal-1", { adapter, maxAutoRetries: 2 });
    assert.equal(tick.started.length, 1);
    assert.equal(adapter.starts.length, 1);
    assert.equal(adapter.starts[0]?.cwd, "/repo/.worktrees/build");
    assert.equal((await runtime.getGoalDagNode("goal-1", "build"))?.status, "running");
    assert.equal((await runtime.getGoalSubagent("goal-1", "subagent-1"))?.retryCount, 1);
});
test("controller tick treats transient database locks as retryable sync skips", async () => {
    const { runtime } = await runtimeWithPlan([{ nodeId: "build", objective: "Build feature" }]);
    await runtime.saveGoalDagNode({ ...await runtime.getGoalDagNode("goal-1", "build"), status: "running", updatedAt: now });
    await runtime.saveGoalSubagent(subagent());
    const adapter = new FakeSubagentAdapter();
    adapter.getSessionState = () => {
        throw new Error("database is locked");
    };
    const tick = await runtime.runGoalControllerTick("goal-1", { adapter });
    assert.equal(tick.changed, false);
    assert.equal(tick.failed.length, 0);
    assert.equal((await runtime.getGoalDagNode("goal-1", "build"))?.status, "running");
    assert.equal((await runtime.getGoalSubagent("goal-1", "subagent-1"))?.status, "running");
});
test("controller loop can run bounded ticks and stop when idle", async () => {
    const { runtime } = await runtimeWithPlan([{ nodeId: "build", objective: "Build feature", status: "complete" }]);
    const adapter = new FakeSubagentAdapter();
    const loop = await runtime.runGoalControllerLoop("goal-1", { adapter, maxTicks: 3, intervalMs: 0 });
    assert.equal(loop.ticks.length, 1);
    assert.equal(loop.ticks[0]?.changed, false);
});
//# sourceMappingURL=controller-loop.test.js.map