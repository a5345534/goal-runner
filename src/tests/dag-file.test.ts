import test from "node:test";
import assert from "node:assert/strict";
import {
  createGoalDagNodesFromFileContent,
  GoalRuntime,
  MemoryGoalStore,
  parseGoalDagFileContent,
  planGoalDagFromFileDocument,
} from "../core/index.js";

const now = "2026-06-02T00:00:00.000Z";

const validDag = {
  version: 1,
  objective: "Complete People Frappe backend remaining slices",
  defaults: {
    validators: ["npm test"],
    workspaceStrategy: "native-git-worktree",
    completionGates: ["controller-validation"],
    conflicts: { modules: ["people-frappe-module"] },
  },
  nodes: [
    {
      id: "attendance-parity",
      objective: "Add attendance parity fixtures",
      outputs: ["tests/test_attendance_parity.py"],
      conflicts: { files: ["attendance"] },
    },
    {
      id: "payroll-doctypes",
      objective: "Add payroll DocTypes",
      after: ["attendance-parity"],
      validators: ["pytest"],
      risk: "medium",
    },
  ],
} as const;

test("goal DAG file parser creates explicit nodes without inferred sequencing", () => {
  const document = parseGoalDagFileContent(JSON.stringify(validDag));
  const plan = planGoalDagFromFileDocument("goal-1", document, { now });

  assert.equal(document.objective, "Complete People Frappe backend remaining slices");
  assert.deepEqual(plan.nodeInputs.map((node) => node.nodeId), ["attendance-parity", "payroll-doctypes"]);
  assert.deepEqual(plan.nodeInputs[0]?.dependencyNodeIds, []);
  assert.deepEqual(plan.nodeInputs[1]?.dependencyNodeIds, ["attendance-parity"]);
  assert.deepEqual(plan.nodeInputs[0]?.validators, ["npm test"]);
  assert.deepEqual(plan.nodeInputs[1]?.validators, ["pytest"]);
  assert.deepEqual(plan.nodeInputs[0]?.expectedOutputs, ["tests/test_attendance_parity.py"]);
  assert.deepEqual(plan.nodeInputs[0]?.conflictHints?.files, ["attendance"]);
  assert.deepEqual(plan.nodeInputs[0]?.conflictHints?.modules, undefined);
  assert.deepEqual(plan.nodeInputs[1]?.conflictHints?.modules, ["people-frappe-module"]);
  assert.equal(plan.nodeInputs[1]?.risk, "medium");
});

test("goal DAG file parser rejects invalid structure before execution", () => {
  assert.throws(() => parseGoalDagFileContent("not-json"), /Invalid goal DAG file JSON/);
  assert.throws(() => parseGoalDagFileContent(JSON.stringify({ version: 2, objective: "x", nodes: [] })), /version must be 1/);
  assert.throws(() => parseGoalDagFileContent(JSON.stringify({ version: 1, objective: "x", nodes: [] })), /nodes must not be empty/);
  assert.throws(() => parseGoalDagFileContent(JSON.stringify({ version: 1, objective: "x", nodes: [{ id: "Bad_Id", objective: "x" }] })), /kebab-case/);
  assert.throws(() => parseGoalDagFileContent(JSON.stringify({ version: 1, objective: "x", nodes: [{ id: "a", objective: "x" }, { id: "a", objective: "y" }] })), /duplicate node id: a/);
  assert.throws(() => parseGoalDagFileContent(JSON.stringify({ version: 1, objective: "x", nodes: [{ id: "a", objective: "x", after: ["missing"] }] })), /depends on missing node missing/);
  assert.throws(
    () =>
      parseGoalDagFileContent(
        JSON.stringify({
          version: 1,
          objective: "x",
          nodes: [
            { id: "a", objective: "a", after: ["b"] },
            { id: "b", objective: "b", after: ["a"] },
          ],
        }),
      ),
    /cycle detected: a -> b -> a/,
  );
});

test("goal DAG file nodes are persisted and scheduled by dependencies", async () => {
  const runtime = new GoalRuntime({ store: new MemoryGoalStore(), config: { now: () => new Date(now) } });
  const document = parseGoalDagFileContent(JSON.stringify(validDag));
  const plan = await runtime.planGoalDagFromFileDocument("goal-1", document, { now });

  assert.deepEqual(plan.nodes.map((node) => node.nodeId), ["attendance-parity", "payroll-doctypes"]);
  assert.deepEqual((await runtime.getGoalDagReadyQueue("goal-1")).ready.map((node) => node.nodeId), ["attendance-parity"]);

  const first = await runtime.getGoalDagNode("goal-1", "attendance-parity");
  assert.ok(first);
  await runtime.saveGoalDagNode({ ...first, status: "complete", updatedAt: "2026-06-02T00:01:00.000Z" });
  assert.deepEqual((await runtime.getGoalDagReadyQueue("goal-1")).ready.map((node) => node.nodeId), ["payroll-doctypes"]);
});

test("goal DAG file content creates durable nodes", () => {
  const plan = createGoalDagNodesFromFileContent("goal-1", JSON.stringify(validDag), { now });

  assert.equal(plan.nodes.length, 2);
  assert.equal(plan.nodes[0]?.workspaceStrategy, "native-git-worktree");
  assert.deepEqual(plan.nodes[1]?.dependencyNodeIds, ["attendance-parity"]);
});
