/**
 * Restart-safety and fallback evidence tests.
 *
 * Covers:
 *   - Fallback evidence persisting through recovery / replacement subagents
 *   - Candidate chain state surviving across tick boundaries
 *   - Evidence fields on node records after repeated failures
 *   - Restart safety: candidate state persists in preparedResources metadata
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  GoalRuntime,
  MemoryGoalStore,
  type GoalDagNode,
  type GoalModelResolution,
  type GoalSubagentRecord,
  type HarnessSubagentAdapter,
  type HarnessSubagentPromptRequest,
  type HarnessSubagentSessionState,
  type HarnessSubagentStartRequest,
  type HarnessSubagentStartResult,
} from "../core/index.js";

const now = "2026-06-02T00:00:00.000Z";

// ---------------------------------------------------------------------------
// Helpers (mirrors the helpers from controller-loop.test.ts)
// ---------------------------------------------------------------------------

class FakeSubagentAdapter implements HarnessSubagentAdapter {
  readonly adapterId = "fake";
  readonly starts: HarnessSubagentStartRequest[] = [];
  readonly prompts: HarnessSubagentPromptRequest[] = [];
  readonly states = new Map<string, HarnessSubagentSessionState>();

  startSession(request: HarnessSubagentStartRequest): HarnessSubagentStartResult | Promise<HarnessSubagentStartResult> {
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

function candidateChain(attemptedCandidates: Array<{ model: string; status: string }>): GoalModelResolution {
  return {
    schemaVersion: "1.0",
    harness: "pi",
    requested: { modelClass: "sonnet", minimumRequirements: {} },
    compliance: { satisfiesMinimum: true, downgraded: false, missingCapabilities: [] },
    status: "resolved",
    attemptedCandidates: attemptedCandidates.map((c, i) => ({
      candidateIndex: i,
      model: c.model,
      compliance: { satisfiesMinimum: true, downgraded: false, missingCapabilities: [] },
      status: c.status as "succeeded" | "failed" | "skipped" | "error",
    })),
    resolved: { model: attemptedCandidates[0]?.model ?? "model-a", bindingSource: "test", candidateIndex: 0 },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("restart-safety: candidate chain state persists in preparedResources metadata across ticks", async () => {
  const { runtime } = await runtimeWithPlan([{ nodeId: "build", objective: "Build feature", modelArg: "model-a" }]);
  const node = await runtime.getGoalDagNode("goal-1", "build");

  // Simulate first tick failure with candidate index state
  await runtime.saveGoalDagNode({
    ...node as GoalDagNode,
    status: "failed",
    updatedAt: now,
    lastValidationSummary: "context_length_exceeded",
    modelResolution: candidateChain([{ model: "model-a", status: "succeeded" }, { model: "model-b", status: "succeeded" }]),
    preparedResources: {
      subagentId: "subagent-1",
      adapterId: "fake",
      workspacePath: "/repo/.worktrees/build",
      metadata: {
        activeCandidateIndex: 0,
        candidateRetryCount: 0,
        attemptsPerCandidate: 1,
      },
    },
  });

  // Verify state persists
  const afterFirstSave = await runtime.getGoalDagNode("goal-1", "build");
  assert.equal(afterFirstSave?.preparedResources?.metadata?.activeCandidateIndex, 0);
  assert.equal(afterFirstSave?.preparedResources?.metadata?.candidateRetryCount, 0);
  assert.equal(afterFirstSave?.preparedResources?.metadata?.attemptsPerCandidate, 1);

  // Simulate second tick: update candidate index as if a switch happened
  await runtime.saveGoalDagNode({
    ...afterFirstSave as GoalDagNode,
    modelArg: "model-b",
    preparedResources: {
      subagentId: "subagent-2",
      adapterId: "fake",
      workspacePath: "/repo/.worktrees/build",
      modelArg: "model-b",
      metadata: {
        activeCandidateIndex: 1,
        candidateRetryCount: 0,
        attemptsPerCandidate: 1,
      },
    },
  });

  // Verify updated state persists
  const afterSecondSave = await runtime.getGoalDagNode("goal-1", "build");
  assert.equal(afterSecondSave?.preparedResources?.metadata?.activeCandidateIndex, 1);
  assert.equal(afterSecondSave?.modelArg, "model-b");
});

test("restart-safety: modelResolution evidence survives on node across runtime re-creation", async () => {
  const store = new MemoryGoalStore();
  const firstRuntime = new GoalRuntime({
    store,
    config: { now: () => new Date(now), randomId: () => "goal-1" },
  });

  await firstRuntime.createOrReplaceGoal("session-1", "Test restart safety");
  const nodes = await firstRuntime.planGoalDag("goal-1", [
    { nodeId: "build", objective: "Build feature", modelArg: "model-a" },
  ]);

  const resolution: GoalModelResolution = {
    schemaVersion: "1.0",
    harness: "pi",
    requested: { modelClass: "implementation", minimumRequirements: { reasoning: "high" } },
    resolved: { model: "model-b", bindingSource: "test", candidateIndex: 1 },
    compliance: { satisfiesMinimum: true, downgraded: false, missingCapabilities: [] },
    status: "resolved",
    attemptedCandidates: [
      { candidateIndex: 0, model: "model-a", compliance: { satisfiesMinimum: true, downgraded: false, missingCapabilities: [] }, status: "succeeded" as const },
      { candidateIndex: 1, model: "model-b", compliance: { satisfiesMinimum: true, downgraded: false, missingCapabilities: [] }, status: "succeeded" as const },
    ],
    switchEvents: [
      { fromCandidateIndex: 0, fromModel: "model-a", toCandidateIndex: 1, toModel: "model-b", reason: "context_length_exceeded" },
    ],
    exhaustedChain: false,
  };

  await firstRuntime.saveGoalDagNode({
    ...nodes[0]!,
    modelResolution: resolution,
    preparedResources: {
      subagentId: "subagent-2",
      adapterId: "fake",
      workspacePath: "/repo/.worktrees/build",
      modelArg: "model-b",
      metadata: {
        activeCandidateIndex: 1,
        candidateRetryCount: 0,
        attemptsPerCandidate: 1,
      },
    },
  });

  // Re-create runtime from the same store (simulating restart)
  const secondRuntime = new GoalRuntime({ store });

  // Verify the resolution evidence survived
  const node = await secondRuntime.getGoalDagNode("goal-1", "build");
  assert.ok(node?.modelResolution);
  assert.equal(node.modelResolution.resolved?.candidateIndex, 1);
  assert.equal(node.modelResolution.status, "resolved");
  assert.ok(node.modelResolution.switchEvents);
  assert.equal(node.modelResolution.switchEvents.length, 1);
  assert.equal(node.modelResolution.switchEvents[0]?.fromCandidateIndex, 0);
  assert.equal(node.modelResolution.switchEvents[0]?.toCandidateIndex, 1);
  assert.equal(node.modelResolution.exhaustedChain, false);

  // Verify preparedResources state also survived
  assert.equal(node?.preparedResources?.metadata?.activeCandidateIndex, 1);
  assert.equal(node?.preparedResources?.modelArg, "model-b");
});

test("restart-safety: exhaustedChain evidence persists on node across runtime re-creation", async () => {
  const store = new MemoryGoalStore();
  const firstRuntime = new GoalRuntime({
    store,
    config: { now: () => new Date(now), randomId: () => "goal-1" },
  });

  await firstRuntime.createOrReplaceGoal("session-1", "Test exhausted chain persistence");
  const nodes = await firstRuntime.planGoalDag("goal-1", [
    { nodeId: "build", objective: "Build feature", modelArg: "model-a" },
  ]);

  const exhaustedResolution: GoalModelResolution = {
    schemaVersion: "1.0",
    harness: "pi",
    requested: { modelClass: "implementation", minimumRequirements: { reasoning: "high" } },
    resolved: { model: "model-b", bindingSource: "test", candidateIndex: 1 },
    compliance: { satisfiesMinimum: true, downgraded: false, missingCapabilities: [] },
    status: "blocked",
    attemptedCandidates: [
      { candidateIndex: 0, model: "model-a", compliance: { satisfiesMinimum: true, downgraded: false, missingCapabilities: [] }, status: "succeeded" as const },
      { candidateIndex: 1, model: "model-b", compliance: { satisfiesMinimum: true, downgraded: false, missingCapabilities: [] }, status: "succeeded" as const },
    ],
    switchEvents: [
      { fromCandidateIndex: 0, fromModel: "model-a", toCandidateIndex: 1, toModel: "model-b", reason: "context_length_exceeded" },
    ],
    exhaustedChain: true,
    reason: "all candidates exhausted: context_length_exceeded",
  };

  await firstRuntime.saveGoalDagNode({
    ...nodes[0]!,
    status: "blocked",
    lastValidationSummary: "Candidate chain exhausted after all candidates",
    modelResolution: exhaustedResolution,
    preparedResources: {
      subagentId: "subagent-2",
      adapterId: "fake",
      workspacePath: "/repo/.worktrees/build",
      modelArg: "model-b",
      metadata: {
        activeCandidateIndex: 1,
        candidateRetryCount: 1,
        attemptsPerCandidate: 1,
      },
    },
  });

  // Re-create runtime (simulate restart)
  const secondRuntime = new GoalRuntime({ store });
  const node = await secondRuntime.getGoalDagNode("goal-1", "build");

  assert.ok(node?.modelResolution);
  assert.equal(node.modelResolution.exhaustedChain, true);
  assert.equal(node.modelResolution.status, "blocked");
  assert.equal(node.modelResolution.reason, "all candidates exhausted: context_length_exceeded");
  assert.equal(node?.status, "blocked");
  assert.equal(node?.preparedResources?.metadata?.activeCandidateIndex, 1);
  assert.equal(node?.preparedResources?.metadata?.candidateRetryCount, 1);
});

test("restart-safety: candidate state survives across controller-loop ticks via preparedResources", async () => {
  const { runtime } = await runtimeWithPlan([{ nodeId: "build", objective: "Build feature", modelArg: "model-a" }]);
  const node = await runtime.getGoalDagNode("goal-1", "build");

  // Write candidate state as if a first-candidate retry happened
  await runtime.saveGoalDagNode({
    ...node as GoalDagNode,
    status: "running",
    modelResolution: candidateChain([{ model: "model-a", status: "succeeded" }, { model: "model-b", status: "succeeded" }]),
    preparedResources: {
      subagentId: "subagent-1",
      adapterId: "fake",
      workspacePath: "/repo/.worktrees/build",
      modelArg: "model-a",
      metadata: {
        activeCandidateIndex: 0,
        candidateRetryCount: 2,
        attemptsPerCandidate: 3,
      },
    },
  });
  await runtime.saveGoalSubagent(subagent({
    subagentId: "subagent-1",
    status: "running",
    workspacePath: "/repo/.worktrees/build",
    attemptCursor: { at: now, source: "controller-start", promptIndex: 0 },
    retryCount: 2,
  }));

  // Run a tick that syncs but does not change the running subagent
  const adapter = new FakeSubagentAdapter();
  adapter.states.set("subagent-1", { status: "running", lastActivityAt: now });

  const tick = await runtime.runGoalControllerTick("goal-1", { adapter });

  // Tick may produce changed=true because the subagent status was updated during sync
  // (the sync writes updatedAt, which is a non-semantic change)
  // Candidate state should be preserved regardless

  // Candidate state should be preserved
  const savedNode = await runtime.getGoalDagNode("goal-1", "build");
  assert.equal(savedNode?.preparedResources?.metadata?.activeCandidateIndex, 0);
  assert.equal(savedNode?.preparedResources?.metadata?.candidateRetryCount, 2);
  assert.equal(savedNode?.preparedResources?.metadata?.attemptsPerCandidate, 3);
  assert.equal(savedNode?.modelArg, "model-a");
});

test("restart-safety: fallback evidence with switchEvents survives across runtime restart", async () => {
  const store = new MemoryGoalStore();
  const firstRuntime = new GoalRuntime({
    store,
    config: { now: () => new Date(now), randomId: () => "goal-1" },
  });

  await firstRuntime.createOrReplaceGoal("session-1", "Test switchEvents persistence");
  const nodes = await firstRuntime.planGoalDag("goal-1", [
    { nodeId: "build", objective: "Build feature", modelArg: "model-a" },
  ]);

  const resolution: GoalModelResolution = {
    schemaVersion: "1.0",
    harness: "pi",
    requested: { modelClass: "implementation", minimumRequirements: { reasoning: "high" } },
    resolved: { model: "model-c", bindingSource: "test", candidateIndex: 2 },
    compliance: { satisfiesMinimum: true, downgraded: false, missingCapabilities: [] },
    status: "warn",
    attemptedCandidates: [
      { candidateIndex: 0, model: "model-a", compliance: { satisfiesMinimum: true, downgraded: false, missingCapabilities: [] }, status: "succeeded" as const },
      { candidateIndex: 1, model: "model-b", compliance: { satisfiesMinimum: false, downgraded: true, missingCapabilities: [] }, status: "failed" as const },
      { candidateIndex: 2, model: "model-c", compliance: { satisfiesMinimum: true, downgraded: false, missingCapabilities: [] }, status: "succeeded" as const },
    ],
    switchEvents: [
      { fromCandidateIndex: 0, fromModel: "model-a", toCandidateIndex: 1, toModel: "model-b", reason: "context_length_exceeded" },
      { fromCandidateIndex: 1, fromModel: "model-b", toCandidateIndex: 2, toModel: "model-c", reason: "downgraded: reasoning fallback" },
    ],
    exhaustedChain: false,
  };

  await firstRuntime.saveGoalDagNode({
    ...nodes[0]!,
    modelResolution: resolution,
    preparedResources: {
      subagentId: "subagent-c",
      adapterId: "fake",
      workspacePath: "/repo/.worktrees/build",
      modelArg: "model-c",
      metadata: {
        activeCandidateIndex: 2,
        candidateRetryCount: 0,
        attemptsPerCandidate: 1,
      },
    },
  });

  // Simulate runtime restart
  const secondRuntime = new GoalRuntime({ store });
  const node = await secondRuntime.getGoalDagNode("goal-1", "build");

  assert.ok(node?.modelResolution);
  assert.ok(node.modelResolution.switchEvents);
  assert.equal(node.modelResolution.switchEvents.length, 2);
  assert.equal(node.modelResolution.switchEvents[0]?.fromCandidateIndex, 0);
  assert.equal(node.modelResolution.switchEvents[0]?.toCandidateIndex, 1);
  assert.equal(node.modelResolution.switchEvents[1]?.fromCandidateIndex, 1);
  assert.equal(node.modelResolution.switchEvents[1]?.toCandidateIndex, 2);
  assert.equal(node.modelResolution.exhaustedChain, false);
  assert.equal(node.modelResolution.status, "warn");
  assert.equal(node?.preparedResources?.metadata?.activeCandidateIndex, 2);
  assert.equal(node?.preparedResources?.modelArg, "model-c");
});
