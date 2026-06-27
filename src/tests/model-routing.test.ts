import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createGoalDagNodesFromFileContent,
  parseGoalModelRoutingConfig,
  readModelBindingCatalogFromEnvOrBundled,
  readModelClassCatalogFromEnvOrBundled,
  resolveGoalModelForHarness,
  selectModelScenarioForNode,
  GoalRuntime,
  SQLiteGoalStore,
} from "../core/index.js";

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

  assert.deepEqual(
    selectModelScenarioForNode({
      nodeId: "docs-node",
      objective: "Update docs",
      scope: "docs",
      risk: "low",
      validators: [],
      expectedOutputs: [],
      modelScenario: "review",
    }, config),
    { scenario: "review", modelClass: "strict-reviewer", reason: "explicit node modelScenario review" },
  );
  assert.deepEqual(
    selectModelScenarioForNode({
      nodeId: "docs-node",
      objective: "Update docs",
      scope: "docs",
      risk: "low",
      validators: [],
      expectedOutputs: [],
    }, config),
    { scenario: "docs", modelClass: "implementation", reason: "routing rule docs" },
  );
  assert.deepEqual(
    selectModelScenarioForNode({
      nodeId: "impl-node",
      objective: "Implement API",
      validators: [],
      expectedOutputs: [],
    }, config),
    { scenario: "implementation", modelClass: "implementation", reason: "default subagent scenario implementation" },
  );
});

test("DAG file model routing stores selected scenario and modelClass on nodes", () => {
  const plan = createGoalDagNodesFromFileContent(
    "goal-1",
    JSON.stringify({
      version: 1,
      objective: "Route models by scenario",
      modelRouting,
      nodes: [
        { id: "docs-node", objective: "Update docs", scope: "docs", risk: "low" },
        { id: "review-node", objective: "Validate final behavior" },
        { id: "explicit-node", objective: "Implement hard part", modelScenario: "review" },
      ],
    }),
    { now: "2026-06-02T00:00:00.000Z" },
  );

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

  const sparkResolution = resolveGoalModelForHarness({
    harness: "pi",
    role: "subagent",
    modelScenario: "fast-docs",
    modelClass: "spark",
  });
  assert.equal(sparkResolution.modelArg, "openai-codex/gpt-5.3-codex-spark");
  assert.equal(sparkResolution.evidence.status, "resolved");
  assert.equal(sparkResolution.evidence.requested.modelClass, "spark");
});

test("model class env JSON overrides bundled catalog", () => {
  const classCatalog = {
    version: 1,
    modelClasses: {
      implementation: {
        minimumRequirements: {
          reasoning: "very_high",
          contextWindowTokens: 128000,
          toolUse: "required",
          structuredOutput: "strict",
          formatFollowing: "very_high",
          sourceCitation: "required",
          privacy: "cloud-ok",
        },
        fallbackPolicy: { allowDowngrade: false, onUnavailable: "block" },
      },
    },
  };

  const parsed = readModelClassCatalogFromEnvOrBundled({
    AGENT_GOAL_MODEL_CLASS_CATALOG_JSON: JSON.stringify(classCatalog),
  });
  assert.equal(parsed.modelClasses.implementation?.minimumRequirements.reasoning, "very_high");
  assert.throws(
    () => resolveGoalModelForHarness({
      harness: "pi",
      modelClass: "implementation",
      env: { AGENT_GOAL_MODEL_CLASS_CATALOG_JSON: JSON.stringify(classCatalog) },
    }),
    /Model resolution blocked for implementation: binding does not satisfy minimum capabilities/,
  );
});

test("model binding env file overrides bundled binding catalog", () => {
  const dir = mkdtempSync(join(tmpdir(), "goal-binding-env-"));
  const file = join(dir, "pi-binding.json");
  try {
    writeFileSync(file, JSON.stringify({
      version: 1,
      harness: "pi",
      bindings: {
        implementation: {
          model: "local/custom-implementation",
          declaredCapabilities: {
            reasoning: "high",
            contextWindowTokens: 256000,
            toolUse: "required",
            structuredOutput: "preferred",
            formatFollowing: "high",
            sourceCitation: "preferred",
            privacy: "cloud-ok",
          },
        },
      },
    }));

    const parsed = readModelBindingCatalogFromEnvOrBundled("pi", { AGENT_GOAL_MODEL_BINDING_FILE: file });
    assert.equal(parsed.bindings.implementation?.model, "local/custom-implementation");

    const resolution = resolveGoalModelForHarness({
      harness: "pi",
      modelClass: "implementation",
      env: { AGENT_GOAL_MODEL_BINDING_FILE: file },
    });
    assert.equal(resolution.modelArg, "local/custom-implementation");
    assert.equal(resolution.evidence.resolved?.bindingSource, `AGENT_GOAL_MODEL_BINDING_FILE:${file}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("model resolver fails closed for explicit missing or invalid env catalogs", () => {
  const missing = join(tmpdir(), "missing-goal-model-catalog.json");
  assert.throws(
    () => readModelClassCatalogFromEnvOrBundled({ AGENT_GOAL_MODEL_CLASS_CATALOG_FILE: missing }),
    /AGENT_GOAL_MODEL_CLASS_CATALOG_FILE not found/,
  );
  assert.throws(
    () => readModelBindingCatalogFromEnvOrBundled("pi", { AGENT_GOAL_MODEL_BINDING_FILE: missing }),
    /AGENT_GOAL_MODEL_BINDING_FILE not found/,
  );
  assert.throws(
    () => readModelBindingCatalogFromEnvOrBundled("pi", { AGENT_GOAL_MODEL_BINDING_JSON: "{not json" }),
    /Invalid goal model binding catalog JSON/,
  );
  assert.throws(
    () => readModelBindingCatalogFromEnvOrBundled("pi", {
      AGENT_GOAL_MODEL_BINDING_JSON: JSON.stringify({
        version: 1,
        harness: "opencode",
        bindings: {
          implementation: {
            model: "provider/model",
            declaredCapabilities: { reasoning: "high" },
          },
        },
      }),
    }),
    /does not match requested harness/,
  );
});

test("model resolver blocks unknown harness without an explicit binding catalog", () => {
  assert.throws(
    () => resolveGoalModelForHarness({ harness: "unknown-harness", modelClass: "implementation", env: {} }),
    /no bundled binding catalog for harness/,
  );
});

test("SQLite store persists DAG node model class, arg, and resolution evidence", async () => {
  const dir = mkdtempSync(join(tmpdir(), "goal-model-routing-"));
  const dbPath = join(dir, "goals.sqlite");
  try {
    const firstStore = new SQLiteGoalStore({ dbPath });
    const firstRuntime = new GoalRuntime({ store: firstStore });
    const plan = createGoalDagNodesFromFileContent(
      "goal-1",
      JSON.stringify({
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
      }),
      { now: "2026-06-02T00:00:00.000Z" },
    );
    const resolution = resolveGoalModelForHarness({ harness: "pi", role: "subagent", modelScenario: "docs", modelClass: "implementation" });
    await firstRuntime.saveGoalDagNode({
      ...plan.nodes[0]!,
      modelArg: resolution.modelArg,
      modelResolution: resolution.evidence,
    });
    firstStore.close();

    const secondStore = new SQLiteGoalStore({ dbPath });
    const secondRuntime = new GoalRuntime({ store: secondStore });
    const node = await secondRuntime.getGoalDagNode("goal-1", "docs-node");
    assert.equal(node?.modelScenario, "docs");
    assert.equal(node?.modelClass, "implementation");
    assert.equal(node?.modelArg, "deepseek/deepseek-v4-flash");
    assert.equal(node?.modelResolution?.requested.modelClass, "implementation");
    assert.deepEqual(node?.workspace, { worktreeSlug: "docs-worktree", branch: "feat/docs-worktree", baseRef: "main" });
    secondStore.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
