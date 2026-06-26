import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GoalRuntime, JsonlGoalDebugTracer, MemoryGoalStore, buildGoalDebugReport, recordGoalDebugSnapshot, } from "../core/index.js";
function tempDir(prefix) {
    return mkdtempSync(join(tmpdir(), prefix));
}
function readTrace(path) {
    return readFileSync(path, "utf8")
        .trim()
        .split(/\n+/)
        .filter(Boolean)
        .map((line) => JSON.parse(line));
}
test("debug tracer records logical store/database operations without raw objective text", async () => {
    const dir = tempDir("goal-debug-trace-");
    try {
        let traceId = 0;
        const traceFile = join(dir, "trace.jsonl");
        const tracer = new JsonlGoalDebugTracer({
            traceFile,
            now: () => new Date("2026-06-02T00:00:00.000Z"),
            randomId: () => `trace-${++traceId}`,
        });
        const runtime = new GoalRuntime({
            store: new MemoryGoalStore(),
            debugTracer: tracer,
            config: {
                now: () => new Date("2026-06-02T00:00:00.000Z"),
                randomId: () => "goal-debug-1",
            },
        });
        const created = await runtime.createOrReplaceGoal("session-1", "debug objective should not be copied into trace", { continueIfIdle: false });
        assert.equal(created.goal?.goalId, "goal-debug-1");
        await runtime.getGoal("session-1");
        const events = readTrace(traceFile);
        assert.ok(events.some((event) => event.category === "db" && event.operation === "saveGoal" && event.goalId === "goal-debug-1"));
        assert.ok(events.some((event) => event.category === "db" && event.operation === "appendLedgerEvent" && event.details?.type === "goal_created"));
        assert.equal(JSON.stringify(events).includes("debug objective should not be copied into trace"), false);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("debug report detects runner-start launch failure anomalies", async () => {
    const runtime = new GoalRuntime({
        store: new MemoryGoalStore(),
        config: {
            now: () => new Date("2026-06-02T00:00:00.000Z"),
            randomId: () => "goal-debug-2",
        },
    });
    const created = await runtime.createOrReplaceGoal("session-1", "debug runner launch", { continueIfIdle: false });
    const goal = created.goal;
    const [node] = await runtime.planGoalDag(goal.goalId, [{ nodeId: "implementation", objective: "implement", expectedOutputs: [], validators: [] }]);
    await runtime.saveGoalDagNode({
        ...node,
        status: "running",
        lifecyclePhase: "runnerStarting",
        preparedResources: {
            subagentId: "implementation-runner",
            metadata: {
                runnerLaunchFailureCount: 1,
                lastRunnerLaunchFailureAt: "2026-06-02T00:00:00.000Z",
            },
        },
    });
    const state = await runtime.getGoalOrchestrationState(goal.goalId);
    const report = buildGoalDebugReport({ goal, state, ledgerEvents: [] });
    assert.ok(report.anomalies.some((anomaly) => anomaly.code === "runner-launch-failure-retry-pending"));
    assert.ok(report.anomalies.some((anomaly) => anomaly.code === "runner-starting-without-live-subagent"));
});
test("monitor debug snapshots write monitor and anomaly trace events", async () => {
    const dir = tempDir("goal-debug-snapshot-");
    try {
        const traceFile = join(dir, "trace.jsonl");
        const tracer = new JsonlGoalDebugTracer({
            traceFile,
            now: () => new Date("2026-06-02T00:00:00.000Z"),
            randomId: () => "trace-snapshot",
        });
        const runtime = new GoalRuntime({
            store: new MemoryGoalStore(),
            config: {
                now: () => new Date("2026-06-02T00:00:00.000Z"),
                randomId: () => "goal-debug-3",
            },
        });
        const created = await runtime.createOrReplaceGoal("session-1", "debug snapshot", { continueIfIdle: false });
        const goal = created.goal;
        const [node] = await runtime.planGoalDag(goal.goalId, [{ nodeId: "blocked-node", objective: "blocked", expectedOutputs: [], validators: [] }]);
        await runtime.saveGoalDagNode({ ...node, status: "blocked", lastValidationSummary: "blocked for test" });
        const state = await runtime.getGoalOrchestrationState(goal.goalId);
        recordGoalDebugSnapshot(tracer, { source: "test.monitor", goal, state });
        const events = readTrace(traceFile);
        assert.ok(events.some((event) => event.category === "monitor" && event.operation === "snapshot" && event.goalId === goal.goalId));
        assert.ok(events.some((event) => event.category === "anomaly" && event.operation === "node-blocked" && event.nodeId === "blocked-node"));
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
//# sourceMappingURL=debug-trace.test.js.map