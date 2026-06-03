import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGoalDagNodesFromFileContent, parseGoalModelRoutingConfig, selectModelScenarioForNode, GoalRuntime, SQLiteGoalStore, } from "../core/index.js";
const modelRouting = {
    scenarios: {
        controller: { model: "openai-codex/gpt-5.5" },
        implementation: { model: "openai-codex/gpt-5.5" },
        docs: { model: "openai/gpt-5-mini" },
        review: { model: "anthropic/claude-opus" },
    },
    controllerScenario: "controller",
    defaultSubagentScenario: "implementation",
    rules: [
        { scenario: "docs", when: { scopes: ["docs"], risks: ["low"] } },
        { scenario: "review", when: { objectiveIncludes: ["validate", "review"] } },
    ],
};
test("model routing selects explicit, rule, then default scenarios", () => {
    const config = parseGoalModelRoutingConfig(modelRouting);
    assert.deepEqual(selectModelScenarioForNode({
        nodeId: "docs-node",
        objective: "Update docs",
        scope: "docs",
        risk: "low",
        validators: [],
        expectedOutputs: [],
        modelScenario: "review",
    }, config), { scenario: "review", model: "anthropic/claude-opus", reason: "node.modelScenario:review" });
    assert.deepEqual(selectModelScenarioForNode({
        nodeId: "docs-node",
        objective: "Update docs",
        scope: "docs",
        risk: "low",
        validators: [],
        expectedOutputs: [],
    }, config), { scenario: "docs", model: "openai/gpt-5-mini", reason: "rule:docs" });
    assert.deepEqual(selectModelScenarioForNode({
        nodeId: "impl-node",
        objective: "Implement API",
        validators: [],
        expectedOutputs: [],
    }, config), { scenario: "implementation", model: "openai-codex/gpt-5.5", reason: "defaultSubagentScenario:implementation" });
});
test("DAG file model routing stores selected scenario and model on nodes", () => {
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
    assert.deepEqual(plan.nodes.map((node) => [node.nodeId, node.modelScenario, node.modelArg]), [
        ["docs-node", "docs", "openai/gpt-5-mini"],
        ["review-node", "review", "anthropic/claude-opus"],
        ["explicit-node", "review", "anthropic/claude-opus"],
    ]);
});
test("SQLite store persists DAG node model scenario and model arg", async () => {
    const dir = mkdtempSync(join(tmpdir(), "goal-model-routing-"));
    const dbPath = join(dir, "goals.sqlite");
    try {
        const firstStore = new SQLiteGoalStore({ dbPath });
        const firstRuntime = new GoalRuntime({ store: firstStore });
        const plan = createGoalDagNodesFromFileContent("goal-1", JSON.stringify({
            version: 1,
            objective: "Route models by scenario",
            modelRouting,
            nodes: [{ id: "docs-node", objective: "Update docs", scope: "docs", risk: "low" }],
        }), { now: "2026-06-02T00:00:00.000Z" });
        await firstRuntime.saveGoalDagNode(plan.nodes[0]);
        firstStore.close();
        const secondStore = new SQLiteGoalStore({ dbPath });
        const secondRuntime = new GoalRuntime({ store: secondStore });
        const node = await secondRuntime.getGoalDagNode("goal-1", "docs-node");
        assert.equal(node?.modelScenario, "docs");
        assert.equal(node?.modelArg, "openai/gpt-5-mini");
        secondStore.close();
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
//# sourceMappingURL=model-routing.test.js.map