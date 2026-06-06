import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GoalRuntime,
  MemoryGoalStore,
  SQLiteGoalStore,
  type GoalDagNode,
  type GoalSubagentRecord,
} from "../core/index.js";

const now = "2026-06-02T00:00:00.000Z";

function node(overrides: Partial<GoalDagNode> = {}): GoalDagNode {
  return {
    goalId: "goal-1",
    nodeId: "attendance-doctypes",
    slug: "implement-attendance-doctypes",
    objective: "Add Attendance DocType skeletons",
    scope: "attendance",
    dependencyNodeIds: [],
    expectedOutputs: ["src/attendance/**"],
    validators: ["npm test"],
    workspaceStrategy: "native-git-worktree",
    risk: "medium",
    conflictHints: { files: ["src/attendance/**"], modules: ["attendance"], capabilities: ["people-frappe-backend"] },
    completionGates: ["tests-pass", "controller-review"],
    status: "planned",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function subagent(overrides: Partial<GoalSubagentRecord> = {}): GoalSubagentRecord {
  return {
    goalId: "goal-1",
    nodeId: "attendance-doctypes",
    subagentId: "subagent-1",
    harnessAdapterId: "pi",
    sessionId: "session-1",
    sessionFile: "/sessions/session-1.jsonl",
    workspacePath: "/repo/.worktrees/implement-attendance-doctypes",
    branch: "feat/implement-attendance-doctypes",
    status: "running",
    prompts: ["Implement attendance doctypes"],
    lastActivityAt: now,
    selfReportedResult: undefined,
    controllerValidationResults: ["pending"],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

test("memory store persists durable goal DAG nodes and subagent registry records", async () => {
  const runtime = new GoalRuntime({ store: new MemoryGoalStore() });
  const first = node();
  const second = node({
    nodeId: "payroll-doctypes",
    slug: "implement-payroll-doctypes",
    objective: "Add Payroll DocType skeletons",
    dependencyNodeIds: ["attendance-doctypes"],
    createdAt: "2026-06-02T00:00:01.000Z",
    updatedAt: "2026-06-02T00:00:01.000Z",
  });
  await runtime.saveGoalDagNode({
    ...first,
    kind: "implementation",
    validation: {
      profile: "code-change",
      artifactLocks: [{ path: "tests/attendance.test.ts", sha256: "b".repeat(64), sourceNodeId: "write-tests" }],
      requiredEvidence: ["validators-ran", "locked-artifacts-unchanged"],
    },
  });
  await runtime.saveGoalDagNode(second);
  await runtime.saveGoalSubagent(subagent());

  const state = await runtime.getGoalOrchestrationState("goal-1");
  assert.deepEqual(state.nodes.map((item) => item.nodeId), ["attendance-doctypes", "payroll-doctypes"]);
  assert.deepEqual(state.nodes[0]?.validation?.requiredEvidence, ["validators-ran", "locked-artifacts-unchanged"]);
  assert.equal(state.nodes[0]?.validation?.artifactLocks?.[0]?.sha256, "b".repeat(64));
  assert.deepEqual(state.nodes[1]?.dependencyNodeIds, ["attendance-doctypes"]);
  assert.deepEqual(state.subagents.map((item) => item.subagentId), ["subagent-1"]);

  // Returned values are defensive copies.
  state.nodes[0]?.dependencyNodeIds.push("mutated");
  state.subagents[0]?.prompts.push("mutated");
  assert.deepEqual((await runtime.getGoalDagNode("goal-1", "attendance-doctypes"))?.dependencyNodeIds, []);
  assert.deepEqual((await runtime.getGoalSubagent("goal-1", "subagent-1"))?.prompts, ["Implement attendance doctypes"]);
});

test("runtime finalizes an active goal when all DAG nodes are complete", async () => {
  let id = 0;
  const runtime = new GoalRuntime({
    store: new MemoryGoalStore(),
    config: { now: () => new Date(now), randomId: () => (id++ === 0 ? "goal-finalize" : `event-${id}`) },
  });
  const created = await runtime.createOrReplaceGoal("session-1", "Complete People Frappe slice", { confirmReplace: false });
  assert.equal(created.goal?.goalId, "goal-finalize");
  await runtime.saveGoalDagNode(node({ goalId: "goal-finalize", status: "complete", lastValidationSummary: "controller validation passed" }));
  await runtime.saveGoalSubagent(subagent({
    goalId: "goal-finalize",
    status: "complete",
    selfReportedResult: "done",
    integrationState: "complete",
    integrationSourceHead: "a".repeat(40),
    integrationCommitSha: "b".repeat(40),
  }));

  const result = await runtime.finalizeGoalFromDagTerminalState("goal-finalize");

  assert.equal(result.terminal, true);
  assert.equal(result.changed, true);
  assert.equal(result.status, "complete");
  assert.equal((await runtime.getGoal("session-1")).goal?.status, "complete");
  const ledger = await runtime.listLedgerEvents("session-1", "goal-finalize");
  assert.equal(ledger.at(-1)?.type, "goal_completed");
  assert.equal(ledger.at(-1)?.details?.source, "controller_dag_terminal_state");
});

test("runtime blocks terminal complete DAGs when required subagent integration is missing", async () => {
  let id = 0;
  const runtime = new GoalRuntime({
    store: new MemoryGoalStore(),
    config: { now: () => new Date(now), randomId: () => (id++ === 0 ? "goal-integration-missing" : `integration-event-${id}`) },
  });
  await runtime.createOrReplaceGoal("session-1", "Complete People Frappe slice", { confirmReplace: false });
  await runtime.saveGoalDagNode(node({ goalId: "goal-integration-missing", status: "complete" }));
  await runtime.saveGoalSubagent(subagent({ goalId: "goal-integration-missing", status: "complete", selfReportedResult: "done" }));

  const result = await runtime.finalizeGoalFromDagTerminalState("goal-integration-missing");

  assert.equal(result.terminal, true);
  assert.equal(result.changed, true);
  assert.equal(result.status, "blocked");
  assert.match(result.reason, /required subagent integration incomplete/);
  assert.equal((await runtime.getGoal("session-1")).goal?.status, "blocked");
});

test("runtime marks an active goal blocked when terminal DAG nodes include failures", async () => {
  let id = 0;
  const runtime = new GoalRuntime({
    store: new MemoryGoalStore(),
    config: { now: () => new Date(now), randomId: () => (id++ === 0 ? "goal-blocked" : `blocked-event-${id}`) },
  });
  await runtime.createOrReplaceGoal("session-1", "Complete People Frappe slice", { confirmReplace: false });
  await runtime.saveGoalDagNode(node({ goalId: "goal-blocked", status: "complete" }));
  await runtime.saveGoalDagNode(node({ goalId: "goal-blocked", nodeId: "payroll", slug: "payroll", status: "failed" }));

  const result = await runtime.finalizeGoalFromDagTerminalState("goal-blocked");

  assert.equal(result.terminal, true);
  assert.equal(result.changed, true);
  assert.equal(result.status, "blocked");
  assert.equal((await runtime.getGoal("session-1")).goal?.status, "blocked");
  const ledger = await runtime.listLedgerEvents("session-1", "goal-blocked");
  assert.equal(ledger.at(-1)?.type, "goal_blocked");
});

test("runtime does not finalize a goal while any DAG node is non-terminal", async () => {
  let id = 0;
  const runtime = new GoalRuntime({
    store: new MemoryGoalStore(),
    config: { now: () => new Date(now), randomId: () => (id++ === 0 ? "goal-running" : `running-event-${id}`) },
  });
  await runtime.createOrReplaceGoal("session-1", "Complete People Frappe slice", { confirmReplace: false });
  await runtime.saveGoalDagNode(node({ goalId: "goal-running", status: "running" }));

  const result = await runtime.finalizeGoalFromDagTerminalState("goal-running");

  assert.equal(result.terminal, false);
  assert.equal(result.changed, false);
  assert.match(result.reason, /non-terminal DAG nodes remain/);
  assert.equal((await runtime.getGoal("session-1")).goal?.status, "active");
});

test("sqlite store persists orchestration state across reopen", async () => {
  const dir = mkdtempSync(join(tmpdir(), "goal-orchestration-state-"));
  const dbPath = join(dir, "goals.sqlite");
  try {
    const firstStore = new SQLiteGoalStore({ dbPath });
    const firstRuntime = new GoalRuntime({ store: firstStore });
    await firstRuntime.saveGoalDagNode(node({
      status: "ready",
      lastValidationSummary: "not validated yet",
      kind: "implementation",
      validation: {
        profile: "code-change",
        testSpecNodeId: "write-tests",
        artifactLocks: [{ path: "tests/attendance.test.ts", sha256: "c".repeat(64), sourceNodeId: "write-tests" }],
        requiredEvidence: ["validators-ran", "implementation-diff-present"],
        diffBaseRef: "main",
      },
    }));
    await firstRuntime.saveGoalSubagent(
      subagent({
        status: "selfReportedComplete",
        selfReportedResult: "implemented and tested",
        controllerValidationResults: ["npm test passed", "controller review pending"],
        commitSha: "abc123",
      }),
    );
    firstStore.close();

    const secondStore = new SQLiteGoalStore({ dbPath });
    const secondRuntime = new GoalRuntime({ store: secondStore });
    const state = await secondRuntime.getGoalOrchestrationState("goal-1");
    assert.equal(state.nodes.length, 1);
    assert.equal(state.nodes[0]?.status, "ready");
    assert.deepEqual(state.nodes[0]?.conflictHints?.modules, ["attendance"]);
    assert.equal(state.nodes[0]?.kind, "implementation");
    assert.equal(state.nodes[0]?.validation?.profile, "code-change");
    assert.deepEqual(state.nodes[0]?.validation?.requiredEvidence, ["validators-ran", "implementation-diff-present"]);
    assert.equal(state.nodes[0]?.validation?.artifactLocks?.[0]?.sha256, "c".repeat(64));
    assert.equal(state.subagents.length, 1);
    assert.equal(state.subagents[0]?.status, "selfReportedComplete");
    assert.deepEqual(state.subagents[0]?.controllerValidationResults, ["npm test passed", "controller review pending"]);
    assert.equal(state.subagents[0]?.commitSha, "abc123");
    secondStore.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
