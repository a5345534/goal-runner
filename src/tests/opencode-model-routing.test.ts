import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readOpencodeModelRoutingConfig,
  resolveOpencodeControllerModel,
  selectOpencodeSubagentModel,
  modelArgFromOpencodeContext,
} from "../adapters/opencode/model-routing.js";
import type { GoalDagNode } from "../core/index.js";

function node(overrides: Partial<GoalDagNode> = {}): GoalDagNode {
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
  const ok = readOpencodeModelRoutingConfig({ inlineJson: JSON.stringify({ controllerScenario: "controller", scenarios: { controller: { modelClass: "controller" } } }) });
  assert.ok(ok);
  assert.equal(ok?.controllerScenario, "controller");

  assert.throws(() => readOpencodeModelRoutingConfig({ inlineJson: "{ this is not json" }), /model routing|Invalid goal/);
});

test("readOpencodeModelRoutingConfig reads from file path", () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-mrf-"));
  const file = join(dir, "model-routing.json");
  writeFileSync(file, JSON.stringify({ controllerScenario: "controller", scenarios: { controller: { modelClass: "controller" } } }));
  try {
    const config = readOpencodeModelRoutingConfig({ filePath: file });
    assert.equal(config?.scenarios?.controller?.modelClass, "controller");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readOpencodeModelRoutingConfig reads from env JSON", () => {
  const previous = process.env.AGENT_GOAL_MODEL_ROUTING_JSON;
  process.env.AGENT_GOAL_MODEL_ROUTING_JSON = JSON.stringify({ defaultSubagentScenario: "implementation", scenarios: { implementation: { modelClass: "implementation" } } });
  try {
    const config = readOpencodeModelRoutingConfig({});
    assert.equal(config?.defaultSubagentScenario, "implementation");
  } finally {
    if (previous === undefined) delete process.env.AGENT_GOAL_MODEL_ROUTING_JSON;
    else process.env.AGENT_GOAL_MODEL_ROUTING_JSON = previous;
  }
});

test("readOpencodeModelRoutingConfig rejects legacy concrete model", () => {
  assert.throws(
    () => readOpencodeModelRoutingConfig({ inlineJson: JSON.stringify({ controllerScenario: "controller", scenarios: { controller: { model: "provider/model" } } }) }),
    /model is unsupported; use modelClass/,
  );
});

test("resolveOpencodeControllerModel picks controller scenario model class and binding", () => {
  const config = readOpencodeModelRoutingConfig({ inlineJson: JSON.stringify({ controllerScenario: "controller", scenarios: { controller: { modelClass: "controller" } } }) });
  const selection = resolveOpencodeControllerModel(config);
  assert.equal(selection.scenario, "controller");
  assert.equal(selection.modelClass, "controller");
  assert.equal(selection.model, "openai-codex/gpt-5.5");
  assert.equal(selection.evidence?.requested.modelClass, "controller");
  assert.match(selection.reason, /controller scenario/);
});

test("resolveOpencodeControllerModel uses implicit controller class when no scenario set", () => {
  const selection = resolveOpencodeControllerModel(undefined);
  assert.equal(selection.modelClass, "controller");
  assert.equal(selection.model, "openai-codex/gpt-5.5");
  assert.match(selection.reason, /implicit controller/);
});

test("selectOpencodeSubagentModel respects persisted model resolution", () => {
  const result = selectOpencodeSubagentModel(
    node({ modelArg: "openai/gpt-5-mini", modelClass: "implementation", modelScenario: "docs" }),
    undefined,
  );
  assert.equal(result.model, "openai/gpt-5-mini");
  assert.equal(result.modelClass, "implementation");
  assert.equal(result.scenario, "docs");
});

test("selectOpencodeSubagentModel resolves routing rule modelClass through binding", () => {
  const config = readOpencodeModelRoutingConfig({
    inlineJson: JSON.stringify({
      defaultSubagentScenario: "implementation",
      scenarios: { implementation: { modelClass: "implementation" }, docs: { modelClass: "implementation" } },
      rules: [{ scenario: "docs", when: { scopes: ["docs"] } }],
    }),
  });
  const result = selectOpencodeSubagentModel(node({ scope: "docs" }), config);
  assert.equal(result.scenario, "docs");
  assert.equal(result.modelClass, "implementation");
  assert.equal(result.model, "deepseek/deepseek-v4-pro");
});

test("modelArgFromOpencodeContext extracts provider/model from object form", () => {
  assert.equal(modelArgFromOpencodeContext({ model: { providerID: "openai", modelID: "gpt-5" } }), "openai/gpt-5");
  assert.equal(modelArgFromOpencodeContext({ model: { providerId: "openai", modelId: "gpt-5" } }), "openai/gpt-5");
  assert.equal(modelArgFromOpencodeContext({ model: "openai/gpt-5" }), "openai/gpt-5");
  assert.equal(modelArgFromOpencodeContext({}), undefined);
});
