import test from "node:test";
import assert from "node:assert/strict";
import { renderOpencodeMonitorLines, readOpencodeGoalMonitorSnapshot } from "../adapters/opencode/monitor-ui.js";
import { GoalRuntime, SQLiteGoalStore } from "../core/index.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const NOW = new Date("2026-06-03T01:00:00.000Z");
function makeSummary(overrides = {}) {
    return {
        sessionKey: "opencode:goal-1",
        goalId: "goal-1",
        shortGoalId: "goal-1",
        status: "active",
        objective: "ship the migration",
        objectiveSummary: "ship the migration",
        tokensUsed: 0,
        timeUsedSeconds: 0,
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
        lastActivityAt: NOW.toISOString(),
        ...overrides,
    };
}
function makeNode(overrides = {}) {
    return {
        goalId: "goal-1",
        nodeId: "n1",
        slug: "n1",
        objective: "implement X",
        expectedOutputs: [],
        validators: [],
        completionGates: [],
        dependencyNodeIds: [],
        status: "running",
        createdAt: new Date(NOW.getTime() - 60_000).toISOString(),
        updatedAt: new Date(NOW.getTime() - 5_000).toISOString(),
        ...overrides,
    };
}
function makeSubagent(overrides = {}) {
    return {
        goalId: "goal-1",
        nodeId: "n1",
        subagentId: "sa-1",
        harnessAdapterId: "opencode",
        prompts: [],
        status: "running",
        sessionId: "ses-1",
        branch: "feat/x",
        workspacePath: "/tmp/oc-wt-1",
        createdAt: new Date(NOW.getTime() - 60_000).toISOString(),
        updatedAt: new Date(NOW.getTime() - 5_000).toISOString(),
        lastActivityAt: new Date(NOW.getTime() - 5_000).toISOString(),
        ...overrides,
    };
}
test("renderOpencodeMonitorLines includes node and subagent lines", () => {
    const lines = renderOpencodeMonitorLines(makeSummary(), { nodes: [makeNode()], subagents: [makeSubagent()] }, { now: () => NOW });
    const joined = lines.join("\n");
    assert.match(joined, /Goal goal-1 monitor/);
    assert.match(joined, /\[running\] n1/);
    assert.match(joined, /\[running\] sa-1/);
    assert.match(joined, /branch: feat\/x/);
    assert.match(joined, /workspace: \/tmp\/oc-wt-1/);
});
test("renderOpencodeMonitorLines falls back to placeholder when state is empty", () => {
    const lines = renderOpencodeMonitorLines(makeSummary(), { nodes: [], subagents: [] }, { now: () => NOW });
    assert.match(lines.join("\n"), /no DAG nodes or subagents yet/);
});
test("readOpencodeGoalMonitorSnapshot reads from runtime and refreshes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-monitor-"));
    try {
        const store = new SQLiteGoalStore({ stateRoot: dir });
        const runtime = new GoalRuntime({ store });
        const goalRecord = {
            sessionKey: "opencode:goal-1",
            goalId: "goal-1",
            objective: "ship the migration",
            status: "active",
            tokensUsed: 0,
            timeUsedSeconds: 0,
            createdAt: NOW.toISOString(),
            updatedAt: NOW.toISOString(),
            goalTurnsSinceAuditReset: 0,
        };
        await store.saveGoal(goalRecord);
        await store.saveGoalDagNode(makeNode());
        await store.saveGoalSubagent(makeSubagent());
        const summary = makeSummary();
        const snapshot = await readOpencodeGoalMonitorSnapshot(runtime, summary, { now: () => NOW });
        assert.ok(snapshot.refreshedAt);
        const joined = snapshot.lines.join("\n");
        assert.match(joined, /n1/);
        assert.match(joined, /sa-1/);
        store.close();
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
//# sourceMappingURL=opencode-monitor.test.js.map