import test from "node:test";
import assert from "node:assert/strict";
import { GoalRuntime, MemoryGoalStore, mapHarnessStatusToSubagentStatus, sendGoalSubagentPrompt, startGoalSubagent, syncGoalSubagentState, } from "../core/index.js";
const now = "2026-06-02T00:00:00.000Z";
function node(overrides = {}) {
    return {
        goalId: "goal-1",
        nodeId: "attendance",
        slug: "attendance",
        objective: "Implement attendance slice",
        dependencyNodeIds: [],
        expectedOutputs: ["src/attendance.ts"],
        validators: ["npm test"],
        completionGates: ["controller-validation"],
        status: "ready",
        createdAt: now,
        updatedAt: now,
        ...overrides,
    };
}
function fakeAdapter(state = { status: "idle" }) {
    const starts = [];
    const prompts = [];
    const adapter = {
        adapterId: "fake-harness",
        startSession(request) {
            starts.push(request);
            return {
                sessionId: `session-${request.subagentId}`,
                sessionFile: `/sessions/${request.subagentId}.jsonl`,
                workspacePath: request.cwd,
                branch: request.branch,
                ref: request.ref,
                status: "running",
                lastActivityAt: now,
            };
        },
        sendPrompt(request) {
            prompts.push(request.prompt);
        },
        getSessionState() {
            return state;
        },
        abortSession() { },
    };
    return { adapter, starts, prompts };
}
test("harness subagent adapter contract starts sessions and creates registry records", async () => {
    const { adapter, starts } = fakeAdapter();
    const started = await startGoalSubagent(adapter, node(), {
        subagentId: "subagent-1",
        cwd: "/repo/.worktrees/attendance",
        branch: "feat/attendance",
        systemPrompt: "system",
        initialPrompt: "implement attendance",
        now,
    });
    assert.equal(starts.length, 1);
    assert.equal(starts[0]?.node.nodeId, "attendance");
    assert.equal(starts[0]?.initialPrompt, "implement attendance");
    assert.equal(started.record.harnessAdapterId, "fake-harness");
    assert.equal(started.record.sessionId, "session-subagent-1");
    assert.equal(started.record.workspacePath, "/repo/.worktrees/attendance");
    assert.equal(started.record.branch, "feat/attendance");
    assert.equal(started.record.status, "running");
    assert.deepEqual(started.record.prompts, ["implement attendance"]);
});
test("subagent prompt and state sync keep controller-owned registry updates explicit", async () => {
    const { adapter, prompts } = fakeAdapter({
        status: "selfReportedComplete",
        selfReportedResult: "done",
        validationSignals: ["npm test passed"],
        lastActivityAt: "2026-06-02T00:01:00.000Z",
    });
    const base = {
        goalId: "goal-1",
        nodeId: "attendance",
        subagentId: "subagent-1",
        harnessAdapterId: "fake-harness",
        sessionId: "session-subagent-1",
        status: "idle",
        prompts: ["initial"],
        createdAt: now,
        updatedAt: now,
    };
    const followed = await sendGoalSubagentPrompt(adapter, base, "please fix tests", { now: "2026-06-02T00:00:30.000Z" });
    assert.deepEqual(prompts, ["please fix tests"]);
    assert.equal(followed.status, "needsFollowup");
    assert.deepEqual(followed.prompts, ["initial", "please fix tests"]);
    const synced = await syncGoalSubagentState(adapter, followed, { now: "2026-06-02T00:02:00.000Z" });
    assert.equal(synced.status, "selfReportedComplete");
    assert.equal(synced.selfReportedResult, "done");
    assert.deepEqual(synced.controllerValidationResults, ["npm test passed"]);
    assert.equal(synced.lastActivityAt, "2026-06-02T00:01:00.000Z");
});
test("subagent sync clears stale integration errors after a healthy state read", async () => {
    const { adapter } = fakeAdapter({ status: "idle", lastActivityAt: "2026-06-02T00:03:00.000Z" });
    const stale = {
        goalId: "goal-1",
        nodeId: "attendance",
        subagentId: "subagent-1",
        harnessAdapterId: "fake-harness",
        status: "running",
        prompts: ["initial"],
        integrationStatus: "Pi subagent session file not found",
        createdAt: now,
        updatedAt: now,
    };
    const synced = await syncGoalSubagentState(adapter, stale, { now: "2026-06-02T00:04:00.000Z" });
    assert.equal(synced.status, "idle");
    assert.equal(synced.integrationStatus, undefined);
});
test("subagent sync ignores stale blocked-to-failed terminal error replays", async () => {
    const rawError = "429 {\"type\":\"error\",\"error\":{\"type\":\"rate_limit_error\",\"message\":\"Token Plan usage limit reached\"}}";
    const { adapter } = fakeAdapter({ status: "failed", error: rawError, lastActivityAt: "2026-06-02T00:01:00.000Z" });
    const blocked = {
        goalId: "goal-1",
        nodeId: "attendance",
        subagentId: "subagent-1",
        harnessAdapterId: "fake-harness",
        status: "blocked",
        prompts: ["initial"],
        integrationStatus: `blocked: provider/model quota or billing limit reached; configure credentials, quota, or a fallback model before continuing. Error: ${rawError}`,
        lastActivityAt: "2026-06-02T00:01:00.000Z",
        createdAt: now,
        updatedAt: now,
    };
    const synced = await syncGoalSubagentState(adapter, blocked, { now: "2026-06-02T00:03:00.000Z" });
    assert.equal(synced, blocked);
    assert.equal(synced.status, "blocked");
    assert.equal(synced.integrationStatus, blocked.integrationStatus);
});
test("runtime persists started and synced subagent records through the adapter contract", async () => {
    const { adapter } = fakeAdapter({ status: "idle", lastActivityAt: "2026-06-02T00:03:00.000Z" });
    const runtime = new GoalRuntime({ store: new MemoryGoalStore(), config: { now: () => new Date(now) } });
    const plannedNode = node();
    await runtime.saveGoalDagNode(plannedNode);
    const started = await runtime.startGoalSubagent(adapter, plannedNode, {
        subagentId: "subagent-1",
        cwd: "/repo/.worktrees/attendance",
        initialPrompt: "implement attendance",
        now,
    });
    assert.equal((await runtime.getGoalDagNode("goal-1", "attendance"))?.status, "running");
    assert.equal((await runtime.getGoalSubagent("goal-1", "subagent-1"))?.status, "running");
    const synced = await runtime.syncGoalSubagent(adapter, started);
    assert.equal(synced.status, "idle");
    assert.equal((await runtime.getGoalSubagent("goal-1", "subagent-1"))?.lastActivityAt, "2026-06-02T00:03:00.000Z");
});
test("harness statuses map to durable subagent lifecycle states", () => {
    assert.equal(mapHarnessStatusToSubagentStatus("starting"), "sessionStarted");
    assert.equal(mapHarnessStatusToSubagentStatus("running"), "running");
    assert.equal(mapHarnessStatusToSubagentStatus("idle"), "idle");
    assert.equal(mapHarnessStatusToSubagentStatus("selfReportedComplete"), "selfReportedComplete");
    assert.equal(mapHarnessStatusToSubagentStatus("blocked"), "blocked");
    assert.equal(mapHarnessStatusToSubagentStatus("failed"), "failed");
    assert.equal(mapHarnessStatusToSubagentStatus("stopped"), "complete");
});
//# sourceMappingURL=subagent-adapter.test.js.map