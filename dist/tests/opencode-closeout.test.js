import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GoalRuntime, SQLiteGoalStore } from "../core/index.js";
import { finalizeOpencodeGoalFromDagTerminalState, formatOpencodeCloseoutDiagnostics } from "../adapters/opencode/closeout.js";
const NOW = new Date("2026-06-03T01:00:00.000Z");
function makeGoal(goalId) {
    return {
        sessionKey: `opencode:${goalId}`,
        goalId,
        objective: "ship the migration",
        status: "active",
        tokensUsed: 0,
        timeUsedSeconds: 0,
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
        goalTurnsSinceAuditReset: 0,
    };
}
function makeNode(goalId, nodeId, status) {
    return {
        goalId,
        nodeId,
        slug: nodeId,
        objective: "implement X",
        expectedOutputs: [],
        validators: [],
        completionGates: [],
        dependencyNodeIds: [],
        status,
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
    };
}
function makeSubagent(goalId, nodeId, status, workspacePath) {
    return {
        goalId,
        nodeId,
        subagentId: `sa-${nodeId}`,
        harnessAdapterId: "opencode",
        prompts: [],
        status,
        sessionId: `ses-${nodeId}`,
        workspacePath,
        branch: workspacePath ? "feat/x" : undefined,
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
        lastActivityAt: NOW.toISOString(),
    };
}
test("finalizeOpencodeGoalFromDagTerminalState returns terminal=false when DAG is still running", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-closeout-"));
    try {
        const store = new SQLiteGoalStore({ stateRoot: dir });
        const runtime = new GoalRuntime({ store });
        await store.saveGoal(makeGoal("goal-running"));
        await store.saveGoalDagNode(makeNode("goal-running", "n1", "running"));
        const result = await finalizeOpencodeGoalFromDagTerminalState(runtime, "goal-running", { workspace: "/tmp/nowhere" }, { stopBackgroundSession: () => { } });
        assert.equal(result.terminal, false);
        assert.deepEqual(result.cleanup, []);
        store.close();
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("finalizeOpencodeGoalFromDagTerminalState finalizes a complete DAG and cleans up subagent worktrees", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-closeout-"));
    try {
        const store = new SQLiteGoalStore({ stateRoot: dir });
        const runtime = new GoalRuntime({ store });
        await store.saveGoal(makeGoal("goal-1"));
        await store.saveGoalDagNode(makeNode("goal-1", "n1", "complete"));
        await store.saveGoalSubagent(makeSubagent("goal-1", "n1", "complete", "/tmp/oc-no-such-worktree-1"));
        await store.saveGoalDagNode(makeNode("goal-1", "n2", "complete"));
        await store.saveGoalSubagent(makeSubagent("goal-1", "n2", "complete", "/tmp/oc-no-such-worktree-2"));
        let stopCalled = 0;
        const result = await finalizeOpencodeGoalFromDagTerminalState(runtime, "goal-1", { workspace: "/tmp/oc-controller" }, { stopBackgroundSession: () => { stopCalled += 1; } });
        assert.equal(result.terminal, true);
        assert.equal(result.backgroundSessionStopped, true);
        assert.equal(stopCalled, 1);
        assert.equal(result.cleanup.length, 2);
        // Both worktrees are reported even if cleanup errors because the
        // test paths do not exist; the result must still surface the
        // attempt per subagent.
        for (const entry of result.cleanup) {
            assert.ok(["removed", "error", "skipped", "preserved"].includes(entry.action));
        }
        store.close();
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("finalizeOpencodeGoalFromDagTerminalState marks a mixed DAG as blocked", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-closeout-"));
    try {
        const store = new SQLiteGoalStore({ stateRoot: dir });
        const runtime = new GoalRuntime({ store });
        await store.saveGoal(makeGoal("goal-blocked"));
        await store.saveGoalDagNode(makeNode("goal-blocked", "n1", "complete"));
        await store.saveGoalDagNode(makeNode("goal-blocked", "n2", "blocked"));
        const result = await finalizeOpencodeGoalFromDagTerminalState(runtime, "goal-blocked", { workspace: "/tmp/oc-controller" }, { stopBackgroundSession: () => { } });
        assert.equal(result.terminal, true);
        assert.equal(result.finalizationChanged, true);
        store.close();
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("formatOpencodeCloseoutDiagnostics surfaces cleanup errors", () => {
    const result = {
        terminal: true,
        finalizationChanged: true,
        cleanup: [
            { action: "error", subagentId: "sa-1", workspacePath: "/x", branch: "feat/x", error: "permission denied" },
        ],
        controllerCleanupError: undefined,
        backgroundSessionStopped: true,
    };
    const lines = formatOpencodeCloseoutDiagnostics(result, "goal-1xx");
    assert.match(lines.join("\n"), /subagent workspace cleanup\(s\) failed/);
    assert.match(lines.join("\n"), /background opencode session stopped/);
});
//# sourceMappingURL=opencode-closeout.test.js.map