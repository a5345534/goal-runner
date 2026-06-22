import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGoalDagNodesFromFileContent, parseGoalModelRoutingConfig, resolveGoalModelForHarness, selectModelScenarioForNode, GoalRuntime, SQLiteGoalStore, } from "../core/index.js";
const modelRouting = {
    scenarios: {
        controller: { modelClass: "controller" },
        implementation: { modelClass: "implementation" },
        docs: { modelClass: "implementation" },
        review: { modelClass: "strict-reviewer" },
    },
    controllerScenario: "controller",
    defaultSubagentScenario: "implementation",
    rules: [
        { scenario: "docs", when: { scopes: ["docs"], risks: ["low"] } },
        { scenario: "review", when: { objectiveIncludes: ["validate", "review"] } },
    ],
};
test("model routing selects explicit, rule, then default model classes", () => {
    const config = parseGoalModelRoutingConfig(modelRouting);
    assert.deepEqual(selectModelScenarioForNode({
        nodeId: "docs-node",
        objective: "Update docs",
        scope: "docs",
        risk: "low",
        validators: [],
        expectedOutputs: [],
        modelScenario: "review",
    }, config), { scenario: "review", modelClass: "strict-reviewer", reason: "explicit node modelScenario review" });
    assert.deepEqual(selectModelScenarioForNode({
        nodeId: "docs-node",
        objective: "Update docs",
        scope: "docs",
        risk: "low",
        validators: [],
        expectedOutputs: [],
    }, config), { scenario: "docs", modelClass: "implementation", reason: "routing rule docs" });
    assert.deepEqual(selectModelScenarioForNode({
        nodeId: "impl-node",
        objective: "Implement API",
        validators: [],
        expectedOutputs: [],
    }, config), { scenario: "implementation", modelClass: "implementation", reason: "default subagent scenario implementation" });
});
test("DAG file model routing stores selected scenario and modelClass on nodes", () => {
    const plan = createGoalDagNodesFromFileContent("goal-1", JSON.stringify({
        version: 1,
        objective: "Route models by scenario",
        modelRouting,
        nodes: [
            { id: "docs-node", objective: "Update docs", scope: "docs", risk: "low" },
            { id: "review-node", objective: "Validate final behavior" },
            { id: "explicit-node", objective: "Implement hard part", modelScenario: "review" },
        ],
    }), { now: "2026-06-02T00:00:00.000Z" });
    assert.deepEqual(plan.nodes.map((node) => [node.nodeId, node.modelScenario, node.modelClass, node.modelArg]), [
        ["docs-node", "docs", "implementation", undefined],
        ["review-node", "review", "strict-reviewer", undefined],
        ["explicit-node", "review", "strict-reviewer", undefined],
    ]);
});
test("harness binding resolution returns concrete model evidence", () => {
    const resolution = resolveGoalModelForHarness({
        harness: "pi",
        role: "subagent",
        modelScenario: "review",
        modelClass: "strict-reviewer",
    });
    assert.equal(resolution.modelArg, "openai-codex/gpt-5.5");
    assert.equal(resolution.evidence.status, "resolved");
    assert.equal(resolution.evidence.requested.modelClass, "strict-reviewer");
});
test("SQLite store persists DAG node model class, arg, and resolution evidence", async () => {
    const dir = mkdtempSync(join(tmpdir(), "goal-model-routing-"));
    const dbPath = join(dir, "goals.sqlite");
    try {
        const firstStore = new SQLiteGoalStore({ dbPath });
        const firstRuntime = new GoalRuntime({ store: firstStore });
        const plan = createGoalDagNodesFromFileContent("goal-1", JSON.stringify({
            version: 1,
            objective: "Route models by scenario",
            modelRouting,
            nodes: [{
                    id: "docs-node",
                    objective: "Update docs",
                    scope: "docs",
                    risk: "low",
                    workspace: { worktreeSlug: "docs-worktree", branch: "feat/docs-worktree", baseRef: "main" },
                }],
        }), { now: "2026-06-02T00:00:00.000Z" });
        const resolution = resolveGoalModelForHarness({ harness: "pi", role: "subagent", modelScenario: "docs", modelClass: "implementation" });
        await firstRuntime.saveGoalDagNode({
            ...plan.nodes[0],
            modelArg: resolution.modelArg,
            modelResolution: resolution.evidence,
        });
        firstStore.close();
        const secondStore = new SQLiteGoalStore({ dbPath });
        const secondRuntime = new GoalRuntime({ store: secondStore });
        const node = await secondRuntime.getGoalDagNode("goal-1", "docs-node");
        assert.equal(node?.modelScenario, "docs");
        assert.equal(node?.modelClass, "implementation");
        assert.equal(node?.modelArg, "deepseek/deepseek-v4-pro");
        assert.equal(node?.modelResolution?.requested.modelClass, "implementation");
        assert.deepEqual(node?.workspace, { worktreeSlug: "docs-worktree", branch: "feat/docs-worktree", baseRef: "main" });
        secondStore.close();
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
//# sourceMappingURL=model-routing.test.js.map