import test from "node:test";
import assert from "node:assert/strict";
import {
  GoalRuntime,
  MemoryGoalStore,
  type GoalDagNode,
  type GoalSubagentRecord,
  type HarnessSubagentAdapter,
  type HarnessSubagentPromptRequest,
  type HarnessSubagentSessionState,
  type HarnessSubagentStartRequest,
} from "../core/index.js";

const now = "2026-06-02T00:00:00.000Z";

class FakeSubagentAdapter implements HarnessSubagentAdapter {
  readonly adapterId = "fake";
  readonly starts: HarnessSubagentStartRequest[] = [];
  readonly prompts: HarnessSubagentPromptRequest[] = [];
  readonly states = new Map<string, HarnessSubagentSessionState>();

  startSession(request: HarnessSubagentStartRequest) {
    this.starts.push(request);
    return {
      sessionId: `session-${request.subagentId}`,
      sessionFile: `/sessions/${request.subagentId}.jsonl`,
      workspacePath: request.cwd,
      branch: request.branch,
      ref: request.ref,
      status: "running" as const,
      lastActivityAt: now,
    };
  }

  sendPrompt(request: HarnessSubagentPromptRequest): void {
    this.prompts.push(request);
  }

  getSessionState(request: { subagent: GoalSubagentRecord }): HarnessSubagentSessionState {
    return this.states.get(request.subagent.subagentId) ?? { status: "running", lastActivityAt: now };
  }

  abortSession(): void {}
}

async function runtimeWithPlan(inputs: Parameters<GoalRuntime["planGoalDag"]>[1]) {
  const runtime = new GoalRuntime({ store: new MemoryGoalStore(), config: { now: () => new Date(now), randomId: () => "goal-1" } });
  const nodes = await runtime.planGoalDag("goal-1", inputs, { now });
  return { runtime, nodes };
}

function subagent(overrides: Partial<GoalSubagentRecord> = {}): GoalSubagentRecord {
  return {
    goalId: "goal-1",
    nodeId: "build",
    subagentId: "subagent-1",
    harnessAdapterId: "fake",
    sessionId: "session-subagent-1",
    status: "running",
    prompts: ["initial"],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

test("controller tick starts ready DAG nodes through the subagent adapter", async () => {
  const { runtime } = await runtimeWithPlan([{ nodeId: "build", objective: "Build feature", validators: ["npm test"] }]);
  const adapter = new FakeSubagentAdapter();

  const tick = await runtime.runGoalControllerTick("goal-1", {
    adapter,
    schedulingPolicy: { maxConcurrentSubagents: 1 },
    workspaceAllocator: ({ node }) => ({ cwd: `/repo/.worktrees/${node.slug}`, branch: `feat/${node.slug}` }),
  });

  assert.equal(tick.started.length, 1);
  assert.equal(adapter.starts.length, 1);
  assert.equal(adapter.starts[0]?.cwd, "/repo/.worktrees/build-feature");
  assert.equal(adapter.starts[0]?.branch, "feat/build-feature");
  assert.match(adapter.starts[0]?.initialPrompt ?? "", /Build feature/);
  assert.equal((await runtime.getGoalDagNode("goal-1", "build"))?.status, "running");
  assert.equal((await runtime.getGoalSubagent("goal-1", tick.started[0]?.subagentId ?? ""))?.workspacePath, "/repo/.worktrees/build-feature");
});

test("controller tick records durable controller history events when a goal record exists", async () => {
  const runtime = new GoalRuntime({ store: new MemoryGoalStore(), config: { now: () => new Date(now), randomId: () => "goal-1" } });
  const created = await runtime.createOrReplaceGoal("s1", "Build feature");
  assert.ok(created.goal);
  await runtime.planGoalDag(created.goal.goalId, [{ nodeId: "build", objective: "Build feature" }], { now });
  const adapter = new FakeSubagentAdapter();

  await runtime.runGoalControllerTick(created.goal.goalId, {
    adapter,
    workspaceAllocator: ({ node }) => ({ subagentId: "subagent-1", cwd: `/repo/.worktrees/${node.slug}`, branch: `feat/${node.slug}` }),
  });

  const ledger = await runtime.listLedgerEvents("s1", created.goal.goalId);
  const controllerEvents = ledger.filter((event) => event.type === "controller_event");
  assert.deepEqual(controllerEvents.map((event) => event.details?.event), ["poll.started", "node.started", "poll.finished"]);
  assert.equal(controllerEvents[1]?.details?.nodeId, "build");
  assert.equal(controllerEvents[1]?.details?.subagentId, "subagent-1");
});

test("subagent self-report is held for controller validation when no validator is configured", async () => {
  const { runtime } = await runtimeWithPlan([{ nodeId: "build", objective: "Build feature" }]);
  await runtime.saveGoalDagNode({ ...(await runtime.getGoalDagNode("goal-1", "build") as GoalDagNode), status: "running", updatedAt: now });
  await runtime.saveGoalSubagent(subagent());
  const adapter = new FakeSubagentAdapter();
  adapter.states.set("subagent-1", { status: "selfReportedComplete", selfReportedResult: "done", lastActivityAt: "2026-06-02T00:01:00.000Z" });

  const tick = await runtime.runGoalControllerTick("goal-1", { adapter });

  assert.equal(tick.synced.length, 1);
  assert.equal(tick.validating.length, 1);
  assert.equal(tick.completed.length, 0);
  assert.equal((await runtime.getGoalDagNode("goal-1", "build"))?.status, "controllerValidating");
  assert.equal((await runtime.getGoalSubagent("goal-1", "subagent-1"))?.status, "controllerValidating");
});

test("controller validator completion unlocks dependent ready nodes in the same tick", async () => {
  const { runtime } = await runtimeWithPlan([
    { nodeId: "build", objective: "Build feature" },
    { nodeId: "docs", objective: "Document feature", dependencyNodeIds: ["build"] },
  ]);
  await runtime.saveGoalDagNode({ ...(await runtime.getGoalDagNode("goal-1", "build") as GoalDagNode), status: "running", updatedAt: now });
  await runtime.saveGoalSubagent(subagent());
  const adapter = new FakeSubagentAdapter();
  adapter.states.set("subagent-1", { status: "selfReportedComplete", selfReportedResult: "done", lastActivityAt: "2026-06-02T00:01:00.000Z" });

  const tick = await runtime.runGoalControllerTick("goal-1", {
    adapter,
    validator: () => ({ status: "passed", summary: "controller tests passed", validationSignals: ["npm test"] }),
  });

  assert.deepEqual(tick.completed.map((node) => node.nodeId), ["build"]);
  assert.deepEqual(tick.started.map((item) => item.nodeId), ["docs"]);
  assert.equal((await runtime.getGoalDagNode("goal-1", "build"))?.status, "complete");
  assert.equal((await runtime.getGoalDagNode("goal-1", "docs"))?.status, "running");
  assert.deepEqual((await runtime.getGoalSubagent("goal-1", "subagent-1"))?.controllerValidationResults, ["controller tests passed", "npm test"]);
});

test("controller treats worktree-merged-pr as an explicit integration gate", async () => {
  const { runtime } = await runtimeWithPlan([{
    nodeId: "build",
    objective: "Build feature",
    completionGates: ["controller-validation", "worktree-merged-pr"],
  }]);
  await runtime.saveGoalDagNode({
    ...(await runtime.getGoalDagNode("goal-1", "build") as GoalDagNode),
    workspaceStrategy: undefined,
    status: "running",
    updatedAt: now,
  });
  await runtime.saveGoalSubagent(subagent({ workspacePath: "/repo/.worktrees/build", branch: "feat/build" }));
  const adapter = new FakeSubagentAdapter();
  adapter.states.set("subagent-1", { status: "selfReportedComplete", selfReportedResult: "done", lastActivityAt: "2026-06-02T00:01:00.000Z" });

  const tick = await runtime.runGoalControllerTick("goal-1", {
    adapter,
    validator: () => ({ status: "passed", summary: "controller tests passed", validationSignals: ["npm test"] }),
  });

  assert.equal(tick.completed.length, 0);
  assert.equal(tick.blocked.length, 1);
  assert.match(tick.blocked[0]?.lastValidationSummary ?? "", /required subagent branch integration cannot run/);
  assert.equal((await runtime.getGoalDagNode("goal-1", "build"))?.status, "blocked");
  const saved = await runtime.getGoalSubagent("goal-1", "subagent-1");
  assert.equal(saved?.status, "blocked");
  assert.equal(saved?.integrationState, "failed");
  assert.match(saved?.integrationStatus ?? "", /no controller integrator is configured/);
});

test("controller validator failure can send a follow-up prompt instead of completing the node", async () => {
  const { runtime } = await runtimeWithPlan([{ nodeId: "build", objective: "Build feature" }]);
  await runtime.saveGoalDagNode({ ...(await runtime.getGoalDagNode("goal-1", "build") as GoalDagNode), status: "running", updatedAt: now });
  await runtime.saveGoalSubagent(subagent());
  const adapter = new FakeSubagentAdapter();
  adapter.states.set("subagent-1", { status: "selfReportedComplete", selfReportedResult: "done", lastActivityAt: "2026-06-02T00:01:00.000Z" });

  const tick = await runtime.runGoalControllerTick("goal-1", {
    adapter,
    validator: () => ({ status: "failed", summary: "tests failed", followupPrompt: "Fix failing tests" }),
  });

  assert.equal(tick.followups.length, 1);
  assert.equal(adapter.prompts[0]?.prompt, "Fix failing tests");
  assert.equal((await runtime.getGoalDagNode("goal-1", "build"))?.status, "running");
  assert.equal((await runtime.getGoalSubagent("goal-1", "subagent-1"))?.status, "running");
});

test("controller blocks repeated identical validator follow-up failures", async () => {
  const { runtime } = await runtimeWithPlan([{ nodeId: "build", objective: "Build feature" }]);
  await runtime.saveGoalDagNode({ ...(await runtime.getGoalDagNode("goal-1", "build") as GoalDagNode), status: "running", updatedAt: now });
  await runtime.saveGoalSubagent(subagent({ controllerValidationResults: ["tests failed", "tests failed"] }));
  const adapter = new FakeSubagentAdapter();
  adapter.states.set("subagent-1", { status: "selfReportedComplete", selfReportedResult: "done", lastActivityAt: "2026-06-02T00:01:00.000Z" });

  const tick = await runtime.runGoalControllerTick("goal-1", {
    adapter,
    validator: () => ({ status: "failed", summary: "tests failed", followupPrompt: "Fix failing tests" }),
  });

  assert.equal(tick.followups.length, 0);
  assert.equal(adapter.prompts.length, 0);
  assert.equal(tick.blocked.length, 1);
  assert.match(tick.blocked[0]?.lastValidationSummary ?? "", /repeated identical controller validation failure \(3 occurrences\)/);
  assert.equal((await runtime.getGoalDagNode("goal-1", "build"))?.status, "blocked");
  const saved = await runtime.getGoalSubagent("goal-1", "subagent-1");
  assert.equal(saved?.status, "blocked");
  assert.deepEqual(saved?.controllerValidationResults, ["tests failed", "tests failed", "tests failed"]);
});

test("controller re-syncs blocked subagents and accepts late successful results while goal is active", async () => {
  const { runtime } = await runtimeWithPlan([{ nodeId: "build", objective: "Build feature" }]);
  await runtime.saveGoalDagNode({
    ...(await runtime.getGoalDagNode("goal-1", "build") as GoalDagNode),
    status: "blocked",
    updatedAt: now,
    lastValidationSummary: "missing expected outputs",
  });
  await runtime.saveGoalSubagent(subagent({ status: "blocked", selfReportedResult: "missing expected outputs", retryCount: 1 }));
  const adapter = new FakeSubagentAdapter();
  adapter.states.set("subagent-1", {
    status: "selfReportedComplete",
    selfReportedResult: "fixed expected outputs after the controller follow-up",
    lastActivityAt: "2026-06-02T00:02:00.000Z",
  });

  const tick = await runtime.runGoalControllerTick("goal-1", {
    adapter,
    validator: () => ({ status: "passed", summary: "controller validation passed" }),
  });

  assert.equal(adapter.prompts.length, 0);
  assert.equal(tick.completed.length, 1);
  assert.equal((await runtime.getGoalDagNode("goal-1", "build"))?.status, "complete");
  const saved = await runtime.getGoalSubagent("goal-1", "subagent-1");
  assert.equal(saved?.status, "complete");
  assert.equal(saved?.selfReportedResult, "fixed expected outputs after the controller follow-up");
});

test("controller sends same-session recovery prompts for blocked subagents while the goal remains active", async () => {
  const { runtime } = await runtimeWithPlan([{ nodeId: "build", objective: "Build feature" }]);
  await runtime.saveGoalDagNode({
    ...(await runtime.getGoalDagNode("goal-1", "build") as GoalDagNode),
    status: "blocked",
    updatedAt: now,
    lastValidationSummary: "missing expected outputs",
  });
  await runtime.saveGoalSubagent(subagent({ status: "blocked", selfReportedResult: "missing expected outputs", retryCount: 0 }));
  const adapter = new FakeSubagentAdapter();
  adapter.states.set("subagent-1", {
    status: "blocked",
    selfReportedResult: "missing expected outputs",
    lastActivityAt: "2026-06-02T00:01:00.000Z",
  });

  const tick = await runtime.runGoalControllerTick("goal-1", { adapter, maxAutoRetries: 2 });

  assert.equal(tick.followups.length, 1);
  assert.equal(adapter.prompts.length, 1);
  assert.match(adapter.prompts[0]?.prompt ?? "", /BLOCKED_NODE_ACTIVE_GOAL/);
  assert.equal((await runtime.getGoalDagNode("goal-1", "build"))?.status, "running");
  const saved = await runtime.getGoalSubagent("goal-1", "subagent-1");
  assert.equal(saved?.status, "running");
  assert.equal(saved?.retryCount, 1);
  assert.match(saved?.integrationStatus ?? "", /active-goal blocked-node recovery 1\/2/);
});

test("controller does not prompt blocked subagents for provider quota blockers", async () => {
  const { runtime } = await runtimeWithPlan([{ nodeId: "build", objective: "Build feature" }]);
  await runtime.saveGoalDagNode({
    ...(await runtime.getGoalDagNode("goal-1", "build") as GoalDagNode),
    status: "blocked",
    updatedAt: now,
    lastValidationSummary: "insufficient_quota: available balance exhausted",
  });
  await runtime.saveGoalSubagent(subagent({ status: "blocked", integrationStatus: "insufficient_quota: available balance exhausted", retryCount: 0 }));
  const adapter = new FakeSubagentAdapter();
  adapter.states.set("subagent-1", {
    status: "blocked",
    error: "insufficient_quota: available balance exhausted",
    lastActivityAt: "2026-06-02T00:01:00.000Z",
  });

  const tick = await runtime.runGoalControllerTick("goal-1", { adapter, maxAutoRetries: 2 });

  assert.equal(tick.followups.length, 0);
  assert.equal(adapter.prompts.length, 0);
  assert.equal(tick.blocked.length, 1);
  assert.equal((await runtime.getGoalDagNode("goal-1", "build"))?.status, "blocked");
});

test("controller asks idle subagents with terminal text but missing outcome marker to re-report explicitly", async () => {
  const { runtime } = await runtimeWithPlan([{ nodeId: "build", objective: "Build feature" }]);
  await runtime.saveGoalDagNode({ ...(await runtime.getGoalDagNode("goal-1", "build") as GoalDagNode), status: "running", updatedAt: now });
  await runtime.saveGoalSubagent(subagent());
  const adapter = new FakeSubagentAdapter();
  adapter.states.set("subagent-1", { status: "needsFollowup", selfReportedResult: "Implemented files and verification passed, but no marker.", lastActivityAt: "2026-06-02T00:01:00.000Z" });

  const tick = await runtime.runGoalControllerTick("goal-1", { adapter });

  assert.equal(tick.followups.length, 1);
  assert.match(adapter.prompts[0]?.prompt ?? "", /EXPLICIT_OUTCOME_MARKER/);
  assert.match(adapter.prompts[0]?.prompt ?? "", /SUBAGENT_RESULT/);
  assert.match(adapter.prompts[0]?.prompt ?? "", /SUBAGENT_BLOCKED/);
  assert.equal((await runtime.getGoalDagNode("goal-1", "build"))?.status, "running");
  assert.equal((await runtime.getGoalSubagent("goal-1", "subagent-1"))?.status, "running");
});

test("controller sends stale subagent continuation prompt for stale needs-followup sessions", async () => {
  const { runtime } = await runtimeWithPlan([{ nodeId: "build", objective: "Build feature" }]);
  await runtime.saveGoalDagNode({ ...(await runtime.getGoalDagNode("goal-1", "build") as GoalDagNode), status: "running", updatedAt: now });
  await runtime.saveGoalSubagent(subagent({ status: "running", integrationStatus: "stale-subagent-session: no transcript activity for 1200s after last message role=toolResult" }));
  const adapter = new FakeSubagentAdapter();
  adapter.states.set("subagent-1", {
    status: "needsFollowup",
    error: "stale-subagent-session: no transcript activity for 1200s after last message role=toolResult",
    lastActivityAt: "2026-06-02T00:01:00.000Z",
  });

  const tick = await runtime.runGoalControllerTick("goal-1", { adapter });

  assert.equal(tick.followups.length, 1);
  assert.match(adapter.prompts[0]?.prompt ?? "", /STALE_SUBAGENT_SESSION/);
  assert.match(adapter.prompts[0]?.prompt ?? "", /Continue from the existing session transcript/);
  assert.equal((await runtime.getGoalDagNode("goal-1", "build"))?.status, "running");
  assert.equal((await runtime.getGoalSubagent("goal-1", "subagent-1"))?.status, "running");
});

test("controller replaces stale missing-session subagents instead of prompting a nonexistent session", async () => {
  const { runtime } = await runtimeWithPlan([{ nodeId: "build", objective: "Build feature", validators: ["npm test"] }]);
  await runtime.saveGoalDagNode({ ...(await runtime.getGoalDagNode("goal-1", "build") as GoalDagNode), status: "running", updatedAt: now });
  await runtime.saveGoalSubagent(subagent({
    status: "running",
    sessionFile: "/sessions/missing.jsonl",
    workspacePath: "/repo/.worktrees/build",
    branch: "feat/build",
  }));
  const adapter = new FakeSubagentAdapter();
  adapter.states.set("subagent-1", {
    status: "failed",
    error: "Pi subagent session file not found: /sessions/missing.jsonl",
    lastActivityAt: "2026-06-02T00:01:00.000Z",
  });

  const tick = await runtime.runGoalControllerTick("goal-1", { adapter, maxAutoRetries: 2 });

  assert.equal(adapter.prompts.length, 0);
  assert.equal(tick.started.length, 1);
  assert.equal(adapter.starts.length, 1);
  assert.equal(adapter.starts[0]?.subagentId, "subagent-1-retry-1");
  assert.equal(adapter.starts[0]?.cwd, "/repo/.worktrees/build");
  assert.equal(adapter.starts[0]?.branch, "feat/build");
  assert.match(adapter.starts[0]?.initialPrompt ?? "", /STALE_MISSING_SESSION_REPLACEMENT/);
  assert.match(adapter.starts[0]?.initialPrompt ?? "", /npm test/);
  assert.equal((await runtime.getGoalDagNode("goal-1", "build"))?.status, "running");
  const stale = await runtime.getGoalSubagent("goal-1", "subagent-1");
  assert.equal(stale?.status, "failed");
  assert.equal(stale?.retryCount, 1);
  assert.match(stale?.integrationStatus ?? "", /stale subagent attempt terminalized/);
  const replacement = await runtime.getGoalSubagent("goal-1", "subagent-1-retry-1");
  assert.equal(replacement?.status, "running");
  assert.equal(replacement?.retryCount, 1);
  assert.match(replacement?.integrationStatus ?? "", /replacement attempt 1\/2/);
});

test("controller blocks stale missing-session replacement after retry budget is exhausted", async () => {
  const { runtime } = await runtimeWithPlan([{ nodeId: "build", objective: "Build feature" }]);
  await runtime.saveGoalDagNode({ ...(await runtime.getGoalDagNode("goal-1", "build") as GoalDagNode), status: "failed", updatedAt: now, lastValidationSummary: "missing session" });
  await runtime.saveGoalSubagent(subagent({
    status: "failed",
    sessionFile: "/sessions/missing.jsonl",
    workspacePath: "/repo/.worktrees/build",
    branch: "feat/build",
    integrationStatus: "Pi subagent session file not found: /sessions/missing.jsonl",
    retryCount: 2,
  }));
  const adapter = new FakeSubagentAdapter();

  const tick = await runtime.runGoalControllerTick("goal-1", { adapter, maxAutoRetries: 2 });

  assert.equal(tick.started.length, 0);
  assert.equal(adapter.starts.length, 0);
  assert.equal(adapter.prompts.length, 0);
  assert.equal(tick.blocked.length, 1);
  assert.equal((await runtime.getGoalDagNode("goal-1", "build"))?.status, "blocked");
  const saved = await runtime.getGoalSubagent("goal-1", "subagent-1");
  assert.equal(saved?.status, "blocked");
  assert.match(saved?.integrationStatus ?? "", /stale subagent session could not be recovered/);
});

test("controller replaces repeated terminated failures after same-session retries are exhausted", async () => {
  const { runtime } = await runtimeWithPlan([{ nodeId: "build", objective: "Build feature", validators: ["npm test"] }]);
  await runtime.saveGoalDagNode({ ...(await runtime.getGoalDagNode("goal-1", "build") as GoalDagNode), status: "failed", updatedAt: now, lastValidationSummary: "terminated" });
  await runtime.saveGoalSubagent(subagent({
    status: "failed",
    integrationStatus: "terminated",
    retryCount: 2,
    workspacePath: "/repo/.worktrees/build",
    branch: "feat/build",
  }));
  const adapter = new FakeSubagentAdapter();

  const tick = await runtime.runGoalControllerTick("goal-1", { adapter, maxAutoRetries: 2 });

  assert.equal(adapter.prompts.length, 0);
  assert.equal(tick.started.length, 1);
  assert.equal(adapter.starts.length, 1);
  assert.equal(adapter.starts[0]?.subagentId, "subagent-1-retry-3");
  assert.equal(adapter.starts[0]?.cwd, "/repo/.worktrees/build");
  assert.equal(adapter.starts[0]?.branch, "feat/build");
  assert.match(adapter.starts[0]?.initialPrompt ?? "", /TERMINATED_SESSION_REPLACEMENT/);
  assert.match(adapter.starts[0]?.initialPrompt ?? "", /replacement attempt 3\/3/);
  const stale = await runtime.getGoalSubagent("goal-1", "subagent-1");
  assert.equal(stale?.status, "failed");
  assert.equal(stale?.retryCount, 3);
  assert.match(stale?.integrationStatus ?? "", /terminated subagent attempt replaced/);
  const replacement = await runtime.getGoalSubagent("goal-1", "subagent-1-retry-3");
  assert.equal(replacement?.status, "running");
  assert.equal(replacement?.retryCount, 3);
  assert.match(replacement?.integrationStatus ?? "", /fresh replacement attempt 3\/3/);
  assert.equal((await runtime.getGoalDagNode("goal-1", "build"))?.status, "running");
});

test("controller blocks terminated replacement after the extra replacement attempt fails", async () => {
  const { runtime } = await runtimeWithPlan([{ nodeId: "build", objective: "Build feature" }]);
  await runtime.saveGoalDagNode({ ...(await runtime.getGoalDagNode("goal-1", "build") as GoalDagNode), status: "failed", updatedAt: now, lastValidationSummary: "assistant error: terminated" });
  await runtime.saveGoalSubagent(subagent({
    status: "failed",
    subagentId: "subagent-1-retry-3",
    sessionId: "session-subagent-1-retry-3",
    integrationStatus: "assistant error: terminated",
    retryCount: 3,
    workspacePath: "/repo/.worktrees/build",
    branch: "feat/build",
  }));
  const adapter = new FakeSubagentAdapter();

  const tick = await runtime.runGoalControllerTick("goal-1", { adapter, maxAutoRetries: 2 });

  assert.equal(tick.started.length, 0);
  assert.equal(adapter.starts.length, 0);
  assert.equal(adapter.prompts.length, 0);
  assert.equal(tick.blocked.length, 1);
  assert.equal((await runtime.getGoalDagNode("goal-1", "build"))?.status, "blocked");
  const saved = await runtime.getGoalSubagent("goal-1", "subagent-1-retry-3");
  assert.equal(saved?.status, "blocked");
  assert.equal(saved?.retryCount, 3);
  assert.match(saved?.integrationStatus ?? "", /terminated subagent session could not be recovered after replacement attempt 3\/3/);
});

test("controller recovers transient failed subagents in the same session", async () => {
  const { runtime } = await runtimeWithPlan([{ nodeId: "build", objective: "Build feature" }]);
  await runtime.saveGoalDagNode({ ...(await runtime.getGoalDagNode("goal-1", "build") as GoalDagNode), status: "failed", updatedAt: now, lastValidationSummary: "WebSocket error" });
  await runtime.saveGoalSubagent(subagent({ status: "failed", integrationStatus: "WebSocket error", workspacePath: "/repo/.worktrees/build" }));
  const adapter = new FakeSubagentAdapter();

  const tick = await runtime.runGoalControllerTick("goal-1", { adapter, maxAutoRetries: 2 });

  assert.equal(tick.started.length, 0);
  assert.equal(adapter.starts.length, 0);
  assert.equal(tick.followups.length, 1);
  assert.equal(adapter.prompts.length, 1);
  assert.match(adapter.prompts[0]?.prompt ?? "", /same session/);
  assert.equal((await runtime.getGoalDagNode("goal-1", "build"))?.status, "running");
  const saved = await runtime.getGoalSubagent("goal-1", "subagent-1");
  assert.equal(saved?.status, "running");
  assert.equal(saved?.retryCount, 1);
  assert.match(saved?.integrationStatus ?? "", /in-place recovery 1\/2/);
});

test("controller recovers unknown subagent errors in the same session before blocking", async () => {
  const { runtime } = await runtimeWithPlan([{ nodeId: "build", objective: "Build feature" }]);
  await runtime.saveGoalDagNode({ ...(await runtime.getGoalDagNode("goal-1", "build") as GoalDagNode), status: "failed", updatedAt: now, lastValidationSummary: "strange adapter error" });
  await runtime.saveGoalSubagent(subagent({ status: "failed", integrationStatus: "strange adapter error", workspacePath: "/repo/.worktrees/build" }));
  const adapter = new FakeSubagentAdapter();

  const tick = await runtime.runGoalControllerTick("goal-1", { adapter, maxAutoRetries: 2 });

  assert.equal(tick.started.length, 0);
  assert.equal(tick.followups.length, 1);
  assert.match(adapter.prompts[0]?.prompt ?? "", /UNHANDLED_SCENARIO/);
  assert.equal((await runtime.getGoalDagNode("goal-1", "build"))?.status, "running");
  assert.match((await runtime.getGoalSubagent("goal-1", "subagent-1"))?.integrationStatus ?? "", /unhandled-scenario recovery 1\/2/);
});

test("controller blocks provider quota errors instead of failing or spawning replacements", async () => {
  const { runtime } = await runtimeWithPlan([{ nodeId: "build", objective: "Build feature" }]);
  await runtime.saveGoalDagNode({ ...(await runtime.getGoalDagNode("goal-1", "build") as GoalDagNode), status: "failed", updatedAt: now, lastValidationSummary: "quota" });
  await runtime.saveGoalSubagent(subagent({ status: "failed", integrationStatus: "insufficient_quota: available balance exhausted", workspacePath: "/repo/.worktrees/build" }));
  const adapter = new FakeSubagentAdapter();

  const tick = await runtime.runGoalControllerTick("goal-1", { adapter, maxAutoRetries: 2 });

  assert.equal(tick.started.length, 0);
  assert.equal(tick.followups.length, 0);
  assert.equal(tick.blocked.length, 1);
  assert.equal(adapter.prompts.length, 0);
  assert.equal((await runtime.getGoalDagNode("goal-1", "build"))?.status, "blocked");
  const saved = await runtime.getGoalSubagent("goal-1", "subagent-1");
  assert.equal(saved?.status, "blocked");
  assert.match(saved?.integrationStatus ?? "", /quota or billing limit/);
});

test("controller blocks quota errors raised while sending recovery prompts", async () => {
  const { runtime } = await runtimeWithPlan([{ nodeId: "build", objective: "Build feature" }]);
  await runtime.saveGoalDagNode({ ...(await runtime.getGoalDagNode("goal-1", "build") as GoalDagNode), status: "failed", updatedAt: now, lastValidationSummary: "WebSocket error" });
  await runtime.saveGoalSubagent(subagent({ status: "failed", integrationStatus: "WebSocket error", workspacePath: "/repo/.worktrees/build" }));
  const adapter = new FakeSubagentAdapter();
  adapter.sendPrompt = () => {
    throw new Error("Monthly usage limit reached");
  };

  const tick = await runtime.runGoalControllerTick("goal-1", { adapter, maxAutoRetries: 2 });

  assert.equal(tick.started.length, 0);
  assert.equal(tick.followups.length, 0);
  assert.equal(tick.failed.length, 0);
  assert.equal(tick.blocked.length, 1);
  assert.equal((await runtime.getGoalDagNode("goal-1", "build"))?.status, "blocked");
  const saved = await runtime.getGoalSubagent("goal-1", "subagent-1");
  assert.equal(saved?.status, "blocked");
  assert.match(saved?.integrationStatus ?? "", /quota or billing limit/);
});

test("controller does not auto-escalate context overflow while Pi reports recovery as running", async () => {
  const { runtime } = await runtimeWithPlan([{ nodeId: "build", objective: "Build feature", modelArg: "openai-codex/gpt-5.3-codex-spark" }]);
  await runtime.saveGoalDagNode({ ...(await runtime.getGoalDagNode("goal-1", "build") as GoalDagNode), status: "running", updatedAt: now });
  await runtime.saveGoalSubagent(subagent({ status: "running", workspacePath: "/repo/.worktrees/build" }));
  const adapter = new FakeSubagentAdapter();
  adapter.states.set("subagent-1", {
    status: "running",
    error: "Pi context overflow recovery pending: Codex error: context_length_exceeded",
    lastActivityAt: "2026-06-02T00:01:00.000Z",
  });

  const tick = await runtime.runGoalControllerTick("goal-1", { adapter, maxAutoRetries: 2 });

  assert.equal(tick.started.length, 0);
  assert.equal(tick.failed.length, 0);
  assert.equal((await runtime.getGoalDagNode("goal-1", "build"))?.status, "running");
  const saved = await runtime.getGoalSubagent("goal-1", "subagent-1");
  assert.equal(saved?.status, "running");
  assert.match(saved?.integrationStatus ?? "", /context overflow recovery pending/);
});

test("controller tick treats transient database locks as retryable sync skips", async () => {
  const { runtime } = await runtimeWithPlan([{ nodeId: "build", objective: "Build feature" }]);
  await runtime.saveGoalDagNode({ ...(await runtime.getGoalDagNode("goal-1", "build") as GoalDagNode), status: "running", updatedAt: now });
  await runtime.saveGoalSubagent(subagent());
  const adapter = new FakeSubagentAdapter();
  adapter.getSessionState = () => {
    throw new Error("database is locked");
  };

  const tick = await runtime.runGoalControllerTick("goal-1", { adapter });

  assert.equal(tick.changed, false);
  assert.equal(tick.failed.length, 0);
  assert.equal((await runtime.getGoalDagNode("goal-1", "build"))?.status, "running");
  assert.equal((await runtime.getGoalSubagent("goal-1", "subagent-1"))?.status, "running");
});

test("controller loop can run bounded ticks and stop when idle", async () => {
  const { runtime } = await runtimeWithPlan([{ nodeId: "build", objective: "Build feature", status: "complete" }]);
  const adapter = new FakeSubagentAdapter();

  const loop = await runtime.runGoalControllerLoop("goal-1", { adapter, maxTicks: 3, intervalMs: 0 });

  assert.equal(loop.ticks.length, 1);
  assert.equal(loop.ticks[0]?.changed, false);
});
