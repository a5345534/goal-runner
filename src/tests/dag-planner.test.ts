import test from "node:test";
import assert from "node:assert/strict";
import {
  createGoalDagNodesFromObjective,
  GoalRuntime,
  MemoryGoalStore,
  planGoalDagFromObjective,
} from "../core/index.js";

const now = "2026-06-02T00:00:00.000Z";

test("objective DAG planner creates one execution node for unstructured objectives", () => {
  const plan = createGoalDagNodesFromObjective("goal-1", "Implement the payroll importer", {
    now,
    defaultValidators: ["npm test"],
    defaultExpectedOutputs: ["src/payroll.ts"],
    defaultWorkspaceStrategy: "native-git-worktree",
  });

  assert.equal(plan.nodeInputs.length, 1);
  assert.equal(plan.nodes.length, 1);
  assert.equal(plan.nodes[0]?.nodeId, "implement-the-payroll-importer");
  assert.deepEqual(plan.nodes[0]?.validators, ["npm test"]);
  assert.deepEqual(plan.nodes[0]?.expectedOutputs, ["src/payroll.ts"]);
  assert.equal(plan.nodes[0]?.workspaceStrategy, "native-git-worktree");
  assert.match(plan.rationale[0] ?? "", /No explicit task list/);
});

test("objective DAG planner parses task lists, annotations, and sequential dependencies", () => {
  const objective = [
    "Implement goal runtime:",
    "- Add core state [id: core-state] [files: src/core/types.ts] [validators: npm test|npm run check]",
    "- Add Pi adapter [after: core-state] [modules: pi]",
    "- Update docs [parallel] [outputs: README.md]",
  ].join("\n");

  const plan = planGoalDagFromObjective("goal-1", objective, { now, defaultValidators: ["npm test"] });

  assert.deepEqual(plan.nodeInputs.map((node) => node.nodeId), ["core-state", "add-pi-adapter", "update-docs"]);
  assert.deepEqual(plan.nodeInputs[0]?.dependencyNodeIds, []);
  assert.deepEqual(plan.nodeInputs[1]?.dependencyNodeIds, ["core-state"]);
  assert.deepEqual(plan.nodeInputs[2]?.dependencyNodeIds, []);
  assert.deepEqual(plan.nodeInputs[0]?.validators, ["npm test", "npm run check"]);
  assert.deepEqual(plan.nodeInputs[1]?.validators, ["npm test"]);
  assert.deepEqual(plan.nodeInputs[0]?.conflictHints?.files, ["src/core/types.ts"]);
  assert.deepEqual(plan.nodeInputs[1]?.conflictHints?.modules, ["pi"]);
  assert.deepEqual(plan.nodeInputs[2]?.expectedOutputs, ["README.md"]);
  assert.match(plan.warnings[0] ?? "", /opted out/);
});

test("objective DAG planner supports independent dependency mode", () => {
  const plan = planGoalDagFromObjective(
    "goal-1",
    ["1. Implement attendance", "2. Implement payroll", "3. Implement docs"].join("\n"),
    { now, dependencyMode: "independent" },
  );

  assert.deepEqual(plan.nodeInputs.map((node) => node.dependencyNodeIds), [[], [], []]);
});

test("objective DAG planner rejects over-large plans", () => {
  assert.throws(
    () => planGoalDagFromObjective("goal-1", ["- one", "- two"].join("\n"), { maxNodes: 1 }),
    /exceeding maxNodes=1/,
  );
});

test("runtime persists objective-planned DAG nodes", async () => {
  const runtime = new GoalRuntime({ store: new MemoryGoalStore(), config: { now: () => new Date(now) } });
  const plan = await runtime.planGoalDagFromObjective(
    "goal-1",
    ["- Implement core", "- Implement adapter"].join("\n"),
    { now },
  );

  assert.deepEqual(plan.nodes.map((node) => node.nodeId), ["implement-core", "implement-adapter"]);
  assert.deepEqual((await runtime.getGoalDagReadyQueue("goal-1")).ready.map((node) => node.nodeId), ["implement-core"]);

  const first = await runtime.getGoalDagNode("goal-1", "implement-core");
  assert.ok(first);
  await runtime.saveGoalDagNode({ ...first, status: "complete", updatedAt: "2026-06-02T00:01:00.000Z" });
  assert.deepEqual((await runtime.getGoalDagReadyQueue("goal-1")).ready.map((node) => node.nodeId), ["implement-adapter"]);
});
