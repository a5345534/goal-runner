import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readOpencodeModelRoutingConfig, resolveOpencodeControllerModel, selectOpencodeSubagentModel, modelArgFromOpencodeContext, } from "../adapters/opencode/model-routing.js";
function node(overrides = {}) {
    return {
        goalId: "goal-1",
        nodeId: overrides.nodeId ?? "impl-1",
        slug: overrides.slug ?? "impl-1",
        objective: overrides.objective ?? "ship the migration",
        expectedOutputs: overrides.expectedOutputs ?? [],
        validators: overrides.validators ?? [],
        completionGates: overrides.completionGates ?? [],
        dependencyNodeIds: overrides.dependencyNodeIds ?? [],
        status: overrides.status ?? "planned",
        createdAt: overrides.createdAt ?? "2026-06-03T00:00:00.000Z",
        updatedAt: overrides.updatedAt ?? "2026-06-03T00:00:00.000Z",
        ...overrides,
    };
}
test("readOpencodeModelRoutingConfig reads inline JSON and rejects malformed input", () => {
    const ok = readOpencodeModelRoutingConfig({ inlineJson: JSON.stringify({ controllerScenario: "controller", scenarios: { controller: { model: "openai-codex/gpt-5.5" } } }) });
    assert.ok(ok);
    assert.equal(ok?.controllerScenario, "controller");
    assert.throws(() => readOpencodeModelRoutingConfig({ inlineJson: "{ this is not json" }), /model routing|Invalid goal/);
});
test("readOpencodeModelRoutingConfig reads from file path", () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-mrf-"));
    const file = join(dir, "model-routing.json");
    writeFileSync(file, JSON.stringify({ controllerScenario: "controller", scenarios: { controller: { model: "openai-codex/gpt-5.5" } } }));
    try {
        const config = readOpencodeModelRoutingConfig({ filePath: file });
        assert.equal(config?.scenarios?.controller?.model, "openai-codex/gpt-5.5");
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("readOpencodeModelRoutingConfig reads from env JSON", () => {
    const previous = process.env.AGENT_GOAL_MODEL_ROUTING_JSON;
    process.env.AGENT_GOAL_MODEL_ROUTING_JSON = JSON.stringify({ defaultSubagentScenario: "implementation", scenarios: { implementation: { model: "openai-codex/gpt-5.5" } } });
    try {
        const config = readOpencodeModelRoutingConfig({});
        assert.equal(config?.defaultSubagentScenario, "implementation");
    }
    finally {
        if (previous === undefined)
            delete process.env.AGENT_GOAL_MODEL_ROUTING_JSON;
        else
            process.env.AGENT_GOAL_MODEL_ROUTING_JSON = previous;
    }
});
test("resolveOpencodeControllerModel picks controller scenario model", () => {
    const config = readOpencodeModelRoutingConfig({ inlineJson: JSON.stringify({ controllerScenario: "controller", scenarios: { controller: { model: "openai-codex/gpt-5.5" } } }) });
    const selection = resolveOpencodeControllerModel(config, "openai/gpt-5-mini");
    assert.equal(selection.scenario, "controller");
    assert.equal(selection.model, "openai-codex/gpt-5.5");
    assert.match(selection.reason, /controller scenario/);
});
test("resolveOpencodeControllerModel falls back to session model when no scenario set", () => {
    const selection = resolveOpencodeControllerModel(undefined, "anthropic/claude-opus");
    assert.equal(selection.model, "anthropic/claude-opus");
    assert.match(selection.reason, /opencode session model/);
});
test("selectOpencodeSubagentModel respects persisted modelArg", () => {
    const result = selectOpencodeSubagentModel(node({ modelArg: "openai/gpt-5-mini", modelScenario: "docs" }), undefined, "anthropic/claude-opus");
    assert.equal(result.model, "openai/gpt-5-mini");
    assert.equal(result.scenario, "docs");
});
test("selectOpencodeSubagentModel falls back to routing rule match", () => {
    const config = readOpencodeModelRoutingConfig({
        inlineJson: JSON.stringify({
            defaultSubagentScenario: "implementation",
            scenarios: { implementation: { model: "openai-codex/gpt-5.5" }, docs: { model: "openai/gpt-5-mini" } },
            rules: [{ scenario: "docs", when: { scopes: ["docs"] } }],
        }),
    });
    const result = selectOpencodeSubagentModel(node({ scope: "docs" }), config, undefined);
    assert.equal(result.scenario, "docs");
    assert.equal(result.model, "openai/gpt-5-mini");
});
test("modelArgFromOpencodeContext extracts provider/model from object form", () => {
    assert.equal(modelArgFromOpencodeContext({ model: { providerID: "openai", modelID: "gpt-5" } }), "openai/gpt-5");
    assert.equal(modelArgFromOpencodeContext({ model: { providerId: "openai", modelId: "gpt-5" } }), "openai/gpt-5");
    assert.equal(modelArgFromOpencodeContext({ model: "openai/gpt-5" }), "openai/gpt-5");
    assert.equal(modelArgFromOpencodeContext({}), undefined);
});
//# sourceMappingURL=opencode-model-routing.test.js.map