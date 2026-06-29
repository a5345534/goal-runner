import test from "node:test";
import assert from "node:assert/strict";
import type { GoalModelBindingCatalog, GoalModelResolution } from "goal-contract";
import {
  GoalRuntime,
  MemoryGoalStore,
  createDefaultControllerExceptionHandler,
  resolveGoalModelForHarness,
  type GoalDagNode,
  type GoalSubagentRecord,
  type HarnessSubagentAdapter,
  type HarnessSubagentPromptRequest,
  type HarnessSubagentSessionState,
  type HarnessSubagentStartRequest,
  type HarnessSubagentStartResult,
} from "../core/index.js";

const now = "2026-06-02T00:00:00.000Z";

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

test("controller tick starts ready DAG nodes through the subagent adapter", async () => {
  const { runtime } = await runtimeWithPlan([{ nodeId: "build", objective: "Build feature", validators: ["npm test"], validation: { allowedPaths: ["src/**"], forbiddenPaths: ["infra/**"] } }]);
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
  assert.match(adapter.starts[0]?.initialPrompt ?? "", /CONTROLLER EXECUTION POLICY/);
  assert.match(adapter.starts[0]?.initialPrompt ?? "", /Allowed changed paths: src\/\*\*/);
  assert.match(adapter.starts[0]?.initialPrompt ?? "", /Forbidden changed paths: infra\/\*\*/);
  assert.equal((await runtime.getGoalDagNode("goal-1", "build"))?.status, "running");
  assert.equal((await runtime.getGoalSubagent("goal-1", tick.started[0]?.subagentId ?? ""))?.workspacePath, "/repo/.worktrees/build-feature");
});

test("controller tick blocks ready nodes when workspace allocation fails", async () => {
  const { runtime } = await runtimeWithPlan([{ nodeId: "build", objective: "Build feature" }]);
  const adapter = new FakeSubagentAdapter();

  const tick = await runtime.runGoalControllerTick("goal-1", {
    adapter,
    workspaceAllocator: () => {
      throw new Error("seed workspace is not inside a Git repository");
    },
  });

  assert.equal(tick.blocked.length, 1);
  assert.equal(adapter.starts.length, 0);
  assert.equal((await runtime.getGoalDagNode("goal-1", "build"))?.status, "blocked");
  assert.match((await runtime.getGoalDagNode("goal-1", "build"))?.lastValidationSummary ?? "", /workspace allocation failed/);
});

test("controller retries stale initial workspace allocation blockers after the stale threshold", async () => {
  const { runtime } = await runtimeWithPlan([{ nodeId: "build", objective: "Build feature" }]);
  const original = await runtime.getGoalDagNode("goal-1", "build") as GoalDagNode;
  await runtime.saveGoalDagNode({
    ...original,
    status: "blocked",
    lifecyclePhase: "terminal",
    lastValidationSummary: "workspace allocation failed: bound subagent worktree has uncommitted changes; cannot reuse safely:\nM module-a",
    updatedAt: now,
  });
  const adapter = new FakeSubagentAdapter();

  const early = await runtime.runGoalControllerTick("goal-1", {
    adapter,
    now: "2026-06-02T00:09:00.000Z",
    staleStateThresholdMs: 10 * 60_000,
    workspaceAllocator: ({ node }) => ({ subagentId: "subagent-1", cwd: `/repo/.worktrees/${node.slug}`, branch: `feat/${node.slug}` }),
  });

  assert.equal(early.started.length, 0);
  assert.equal(adapter.starts.length, 0);
  assert.equal((await runtime.getGoalDagNode("goal-1", "build"))?.status, "blocked");

  const retried = await runtime.runGoalControllerTick("goal-1", {
    adapter,
    now: "2026-06-02T00:11:00.000Z",
    staleStateThresholdMs: 10 * 60_000,
    workspaceAllocator: ({ node }) => ({ subagentId: "subagent-1", cwd: `/repo/.worktrees/${node.slug}`, branch: `feat/${node.slug}` }),
  });

  assert.equal(retried.started.length, 1);
  assert.equal(adapter.starts[0]?.subagentId, "subagent-1");
  assert.equal(adapter.starts[0]?.cwd, "/repo/.worktrees/build-feature");
  assert.equal((await runtime.getGoalDagNode("goal-1", "build"))?.status, "running");
});

test("controller runner launch timeouts remain recoverable through stale runner-start retry", async () => {
  class HangingStartAdapter extends FakeSubagentAdapter {
    override startSession(request: HarnessSubagentStartRequest): Promise<never> {
      this.starts.push(request);
      return new Promise(() => undefined);
    }
  }

  const { runtime } = await runtimeWithPlan([{ nodeId: "build", objective: "Build feature" }]);
  const adapter = new HangingStartAdapter();

  const tick = await runtime.runGoalControllerTick("goal-1", {
    adapter,
    subagentRunnerLaunchTimeoutMs: 1,
    workspaceAllocator: ({ node }) => ({ subagentId: "subagent-1", cwd: `/repo/.worktrees/${node.slug}`, branch: `feat/${node.slug}` }),
  });

  assert.equal(tick.started.length, 0);
  assert.equal(adapter.starts.length, 1);
  const saved = await runtime.getGoalDagNode("goal-1", "build");
  assert.equal(saved?.status, "running");
  assert.equal(saved?.lifecyclePhase, "runnerStarting");
  assert.match(saved?.lastValidationSummary ?? "", /runner launch failed; stale runner-start recovery will retry/);
});

test("controller keeps missing-transcript launch failures recoverable instead of terminal-blocking dependents", async () => {
  class MissingTranscriptStartAdapter extends FakeSubagentAdapter {
    fail = true;
    override startSession(request: HarnessSubagentStartRequest): HarnessSubagentStartResult {
      this.starts.push(request);
      if (this.fail) throw new Error("Detached background Pi runner stopped before accepting prompt and creating session file: /sessions/missing.jsonl: Pi RPC child accepted prompt but did not create session file");
      return {
        sessionId: `session-${request.subagentId}`,
        sessionFile: `/sessions/${request.subagentId}.jsonl`,
        workspacePath: request.cwd,
        branch: request.branch,
        status: "running",
        lastActivityAt: now,
      };
    }
  }

  const { runtime } = await runtimeWithPlan([
    { nodeId: "first", objective: "First node" },
    { nodeId: "second", objective: "Second node", dependencyNodeIds: ["first"] },
  ]);
  const adapter = new MissingTranscriptStartAdapter();

  const firstTick = await runtime.runGoalControllerTick("goal-1", {
    adapter,
    staleStateThresholdMs: 10 * 60_000,
    workspaceAllocator: ({ node }) => ({ subagentId: `subagent-${node.nodeId}`, cwd: `/repo/.worktrees/${node.slug}`, branch: `feat/${node.slug}` }),
  });

  assert.equal(firstTick.blocked.length, 0);
  assert.equal(firstTick.started.length, 0);
  assert.equal(adapter.starts.length, 1);
  const first = await runtime.getGoalDagNode("goal-1", "first");
  const second = await runtime.getGoalDagNode("goal-1", "second");
  assert.equal(first?.status, "running");
  assert.equal(first?.lifecyclePhase, "runnerStarting");
  assert.match(first?.lastValidationSummary ?? "", /did not create session file/);
  assert.equal(second?.status, "planned");

  const earlyRetry = await runtime.runGoalControllerTick("goal-1", {
    adapter,
    now: "2026-06-02T00:00:10.000Z",
    staleStateThresholdMs: 10 * 60_000,
    runnerLaunchRetryDelayMs: 30_000,
  });
  assert.equal(earlyRetry.started.length, 0);
  assert.equal(adapter.starts.length, 1);

  adapter.fail = false;
  const retried = await runtime.runGoalControllerTick("goal-1", {
    adapter,
    now: "2026-06-02T00:00:31.000Z",
    staleStateThresholdMs: 10 * 60_000,
    runnerLaunchRetryDelayMs: 30_000,
  });
  assert.equal(retried.started.length, 1);
  assert.equal(adapter.starts.length, 2);
  assert.equal((await runtime.getGoalDagNode("goal-1", "first"))?.lifecyclePhase, "runnerActive");
  assert.equal((await runtime.getGoalSubagent("goal-1", "subagent-first"))?.status, "running");
});

test("controller tick durably records lifecycle phases before adapter start", async () => {
  const { runtime } = await runtimeWithPlan([{ nodeId: "build", objective: "Build feature" }]);
  const adapter = new FakeSubagentAdapter();
  const phases: Array<GoalDagNode["lifecyclePhase"]> = [];
  const originalSave = runtime.saveGoalDagNode.bind(runtime);
  runtime.saveGoalDagNode = async (saved: GoalDagNode) => {
    phases.push(saved.lifecyclePhase);
    await originalSave(saved);
  };

  await runtime.runGoalControllerTick("goal-1", {
    adapter,
    workspaceAllocator: ({ node }) => ({ subagentId: "subagent-1", cwd: `/repo/.worktrees/${node.slug}`, branch: `feat/${node.slug}` }),
  });

  assert.deepEqual(phases.filter(Boolean).slice(0, 4), [
    "acceptanceDefined",
    "resourcesCreating",
    "resourcesReady",
    "runnerStarting",
  ]);
  assert.equal((await runtime.getGoalDagNode("goal-1", "build"))?.lifecyclePhase, "runnerActive");
  assert.equal(adapter.starts[0]?.preparedResources?.workspacePath, "/repo/.worktrees/build-feature");
});

test("controller restarts stale runnerStarting nodes that have prepared resources but no durable subagent", async () => {
  const { runtime } = await runtimeWithPlan([{ nodeId: "build", objective: "Build feature" }]);
  const original = await runtime.getGoalDagNode("goal-1", "build") as GoalDagNode;
  await runtime.saveGoalDagNode({
    ...original,
    status: "running",
    lifecyclePhase: "runnerStarting",
    preparedResources: {
      subagentId: "subagent-1",
      adapterId: "fake",
      workspacePath: "/repo/.worktrees/build",
      branch: "feat/build",
      createdAt: now,
      updatedAt: now,
    },
    updatedAt: now,
  });
  const adapter = new FakeSubagentAdapter();

  const tick = await runtime.runGoalControllerTick("goal-1", {
    adapter,
    now: "2026-06-02T00:20:00.000Z",
  });

  assert.equal(tick.started.length, 1);
  assert.equal(adapter.starts.length, 1);
  assert.equal(adapter.starts[0]?.subagentId, "subagent-1");
  assert.equal(adapter.starts[0]?.cwd, "/repo/.worktrees/build");
  assert.equal(adapter.starts[0]?.branch, "feat/build");
  assert.equal((await runtime.getGoalDagNode("goal-1", "build"))?.lifecyclePhase, "runnerActive");
  assert.equal((await runtime.getGoalSubagent("goal-1", "subagent-1"))?.status, "running");
});

test("controller blocks stale resource-preparation nodes when allocation cannot recover", async () => {
  const { runtime } = await runtimeWithPlan([{ nodeId: "build", objective: "Build feature" }]);
  const original = await runtime.getGoalDagNode("goal-1", "build") as GoalDagNode;
  await runtime.saveGoalDagNode({
    ...original,
    status: "running",
    lifecyclePhase: "resourcesCreating",
    updatedAt: now,
  });
  const adapter = new FakeSubagentAdapter();

  const tick = await runtime.runGoalControllerTick("goal-1", {
    adapter,
    now: "2026-06-02T00:02:00.000Z",
    workspaceAllocator: () => {
      throw new Error("controller workspace missing");
    },
  });

  assert.equal(tick.blocked.length, 1);
  assert.equal(adapter.starts.length, 0);
  assert.equal((await runtime.getGoalDagNode("goal-1", "build"))?.status, "blocked");
  assert.match((await runtime.getGoalDagNode("goal-1", "build"))?.lastValidationSummary ?? "", /recovering stale resourcesCreating state/);
});

test("controller retries stale resource-preparation allocation blocks after cooldown", async () => {
  const { runtime } = await runtimeWithPlan([{ nodeId: "build", objective: "Build feature" }]);
  const original = await runtime.getGoalDagNode("goal-1", "build") as GoalDagNode;
  await runtime.saveGoalDagNode({
    ...original,
    status: "blocked",
    lifecyclePhase: "terminal",
    lastValidationSummary: "workspace allocation failed while recovering stale resourcesCreating state: controller workspace missing",
    updatedAt: now,
  });
  const adapter = new FakeSubagentAdapter();

  const tick = await runtime.runGoalControllerTick("goal-1", {
    adapter,
    now: "2026-06-02T00:02:00.000Z",
    workspaceAllocator: ({ node }) => ({ subagentId: "subagent-1", cwd: `/repo/.worktrees/${node.slug}`, branch: `feat/${node.slug}` }),
  });

  assert.equal(tick.started.length, 1);
  assert.equal(adapter.starts[0]?.cwd, "/repo/.worktrees/build-feature");
  assert.equal((await runtime.getGoalDagNode("goal-1", "build"))?.lifecyclePhase, "runnerActive");
});

test("controller retries stale runnerStarting cwd-missing blocks after cooldown", async () => {
  const { runtime } = await runtimeWithPlan([{ nodeId: "build", objective: "Build feature" }]);
  const original = await runtime.getGoalDagNode("goal-1", "build") as GoalDagNode;
  await runtime.saveGoalDagNode({
    ...original,
    status: "blocked",
    lifecyclePhase: "terminal",
    preparedResources: {
      subagentId: "subagent-1",
      adapterId: "fake",
      workspacePath: "/repo/.worktrees/build",
      branch: "feat/build",
      createdAt: now,
      updatedAt: now,
    },
    lastValidationSummary: "blocked: unhandled subagent error after in-place recovery attempts; add a controller recovery handler or provide developer guidance. Error: stale runnerStarting restart failed: Background goal session cwd does not exist: /repo/.worktrees/build",
    updatedAt: now,
  });
  const adapter = new FakeSubagentAdapter();

  const tick = await runtime.runGoalControllerTick("goal-1", {
    adapter,
    now: "2026-06-02T00:02:00.000Z",
  });

  assert.equal(tick.started.length, 1);
  assert.equal(adapter.starts[0]?.subagentId, "subagent-1");
  assert.equal((await runtime.getGoalDagNode("goal-1", "build"))?.lifecyclePhase, "runnerActive");
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
  assert.deepEqual(controllerEvents.map((event) => event.details?.event), ["poll.started", "recovery.actionStarted", "recovery.actionSucceeded", "node.started", "poll.finished"]);
  assert.deepEqual(controllerEvents.map((event) => event.details?.eventCategory), ["poll", "recovery.action", "recovery.action", "node.lifecycle", "poll"]);
  assert.equal(controllerEvents[1]?.details?.actionKind, "runnerLaunch");
  assert.equal(controllerEvents[3]?.details?.nodeId, "build");
  assert.equal(controllerEvents[3]?.details?.subagentId, "subagent-1");
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

test("controller revalidates stale controller-validating states and sends validation follow-up", async () => {
  const staleAt = "2026-06-02T00:00:00.000Z";
  const tickNow = "2026-06-02T00:16:00.000Z";
  const { runtime } = await runtimeWithPlan([{ nodeId: "build", objective: "Build feature", expectedOutputs: ["dist/app.js"] }]);
  await runtime.saveGoalDagNode({ ...(await runtime.getGoalDagNode("goal-1", "build") as GoalDagNode), status: "controllerValidating", updatedAt: staleAt });
  await runtime.saveGoalSubagent(subagent({ status: "controllerValidating", selfReportedResult: "done", updatedAt: staleAt, lastActivityAt: staleAt }));
  const adapter = new FakeSubagentAdapter();

  const tick = await runtime.runGoalControllerTick("goal-1", {
    adapter,
    now: tickNow,
    staleStateThresholdMs: 15 * 60_000,
    validator: () => ({ status: "failed", summary: "missing outputs: dist/app.js", followupPrompt: "Create dist/app.js before reporting done." }),
  });

  assert.equal(tick.validating.length, 1);
  assert.equal(tick.followups.length, 1);
  assert.equal(adapter.prompts.length, 1);
  assert.match(adapter.prompts[0]?.prompt ?? "", /Create dist\/app\.js/);
  assert.equal((await runtime.getGoalDagNode("goal-1", "build"))?.status, "running");
  assert.equal((await runtime.getGoalSubagent("goal-1", "subagent-1"))?.status, "running");
});

test("validation follow-up dispatch failures degrade to needs-followup instead of leaving controller-validating", async () => {
  class FailingPromptAdapter extends FakeSubagentAdapter {
    override sendPrompt(request: HarnessSubagentPromptRequest): void {
      super.sendPrompt(request);
      throw new Error("RPC unavailable");
    }
  }

  const { runtime } = await runtimeWithPlan([{ nodeId: "build", objective: "Build feature", expectedOutputs: ["dist/app.js"] }]);
  await runtime.saveGoalDagNode({ ...(await runtime.getGoalDagNode("goal-1", "build") as GoalDagNode), status: "running", updatedAt: now });
  await runtime.saveGoalSubagent(subagent());
  const adapter = new FailingPromptAdapter();
  adapter.states.set("subagent-1", { status: "selfReportedComplete", selfReportedResult: "done", lastActivityAt: "2026-06-02T00:01:00.000Z" });

  const tick = await runtime.runGoalControllerTick("goal-1", {
    adapter,
    validator: () => ({ status: "failed", summary: "missing outputs: dist/app.js", followupPrompt: "Create dist/app.js before reporting done." }),
  });

  assert.equal(tick.followups.length, 1);
  assert.equal(adapter.prompts.length, 1);
  assert.equal((await runtime.getGoalDagNode("goal-1", "build"))?.status, "needsFollowup");
  const saved = await runtime.getGoalSubagent("goal-1", "subagent-1");
  assert.equal(saved?.status, "needsFollowup");
  assert.match(saved?.integrationStatus ?? "", /follow-up dispatch failed: RPC unavailable/);
});

test("validation follow-up dispatch timeouts degrade to needs-followup instead of hanging the poll", async () => {
  class HangingPromptAdapter extends FakeSubagentAdapter {
    override sendPrompt(request: HarnessSubagentPromptRequest): Promise<void> {
      super.sendPrompt(request);
      return new Promise(() => undefined);
    }
  }

  const { runtime } = await runtimeWithPlan([{ nodeId: "build", objective: "Build feature", expectedOutputs: ["dist/app.js"] }]);
  await runtime.saveGoalDagNode({ ...(await runtime.getGoalDagNode("goal-1", "build") as GoalDagNode), status: "running", updatedAt: now });
  await runtime.saveGoalSubagent(subagent());
  const adapter = new HangingPromptAdapter();
  adapter.states.set("subagent-1", { status: "selfReportedComplete", selfReportedResult: "done", lastActivityAt: "2026-06-02T00:01:00.000Z" });

  const tick = await runtime.runGoalControllerTick("goal-1", {
    adapter,
    subagentPromptDispatchTimeoutMs: 1,
    validator: () => ({ status: "failed", summary: "missing outputs: dist/app.js", followupPrompt: "Create dist/app.js before reporting done." }),
  });

  assert.equal(tick.followups.length, 1);
  assert.equal(adapter.prompts.length, 1);
  assert.equal((await runtime.getGoalDagNode("goal-1", "build"))?.status, "needsFollowup");
  const saved = await runtime.getGoalSubagent("goal-1", "subagent-1");
  assert.equal(saved?.status, "needsFollowup");
  assert.match(saved?.integrationStatus ?? "", /prompt dispatch timed out/);
  assert.equal(saved?.lastActionAttempt?.actionKind, "promptDispatch");
  assert.equal(saved?.lastActionAttempt?.status, "timedOut");
  assert.equal(saved?.attemptCursor?.source, "prompt-dispatch");
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

test("controller integrates upstream nodes with downstream dependents before completing them", async () => {
  const { runtime } = await runtimeWithPlan([
    { nodeId: "build", objective: "Build feature" },
    { nodeId: "docs", objective: "Document feature", dependencyNodeIds: ["build"] },
  ]);
  await runtime.saveGoalDagNode({ ...(await runtime.getGoalDagNode("goal-1", "build") as GoalDagNode), status: "running", updatedAt: now });
  await runtime.saveGoalSubagent(subagent({ workspacePath: "/repo/.worktrees/build", branch: "feat/build" }));
  const adapter = new FakeSubagentAdapter();
  adapter.states.set("subagent-1", { status: "selfReportedComplete", selfReportedResult: "done", lastActivityAt: "2026-06-02T00:01:00.000Z" });
  const integratedNodes: string[] = [];

  const tick = await runtime.runGoalControllerTick("goal-1", {
    adapter,
    validator: () => ({ status: "passed", summary: "controller tests passed" }),
    integrator: (request) => {
      integratedNodes.push(request.node.nodeId);
      return {
        status: "complete",
        summary: "merged build into controller",
        sourceBranch: request.subagent.branch,
        sourceHead: "abc123",
        integrationCommitSha: "merge123",
        completedAt: now,
      };
    },
  });

  assert.deepEqual(integratedNodes, ["build"]);
  assert.deepEqual(tick.completed.map((item) => item.nodeId), ["build"]);
  assert.deepEqual(tick.started.map((item) => item.nodeId), ["docs"]);
  const saved = await runtime.getGoalSubagent("goal-1", "subagent-1");
  assert.equal(saved?.integrationState, "complete");
  assert.equal(saved?.integrationSourceHead, "abc123");
  assert.equal(saved?.integrationCommitSha, "merge123");
  assert.equal(saved?.integrationCompletedAt, now);
});

test("controller safety net integrates legacy upstream before allocating downstream workspace", async () => {
  const { runtime } = await runtimeWithPlan([
    { nodeId: "build", objective: "Build feature" },
    { nodeId: "docs", objective: "Document feature", dependencyNodeIds: ["build"] },
  ]);
  await runtime.saveGoalDagNode({ ...(await runtime.getGoalDagNode("goal-1", "build") as GoalDagNode), status: "complete", updatedAt: now });
  await runtime.saveGoalSubagent(subagent({
    status: "complete",
    workspacePath: "/repo/.worktrees/build",
    branch: "feat/build",
    integrationState: "not-required",
    integrationStatus: "integration not required",
  }));
  const adapter = new FakeSubagentAdapter();
  const order: string[] = [];

  const tick = await runtime.runGoalControllerTick("goal-1", {
    adapter,
    integrator: (request) => {
      order.push(`integrate:${request.node.nodeId}`);
      return {
        status: "complete",
        summary: "merged legacy build",
        sourceBranch: request.subagent.branch,
        sourceHead: "abc123",
        integrationCommitSha: "merge123",
        completedAt: now,
      };
    },
    workspaceAllocator: ({ node }) => {
      order.push(`allocate:${node.nodeId}`);
      return { subagentId: "subagent-docs", cwd: `/repo/.worktrees/${node.slug}`, branch: `feat/${node.slug}` };
    },
  });

  assert.deepEqual(order, ["integrate:build", "allocate:docs"]);
  assert.equal(tick.started.length, 1);
  assert.equal(tick.started[0]?.nodeId, "docs");
  const saved = await runtime.getGoalSubagent("goal-1", "subagent-1");
  assert.equal(saved?.integrationState, "complete");
  assert.equal(saved?.integrationCompletedAt, now);
});

test("controller safety net integrates shared upstream only once for fan-out dependents", async () => {
  const { runtime } = await runtimeWithPlan([
    { nodeId: "build", objective: "Build feature" },
    { nodeId: "docs", objective: "Document feature", dependencyNodeIds: ["build"] },
    { nodeId: "tests", objective: "Add tests", dependencyNodeIds: ["build"] },
  ]);
  await runtime.saveGoalDagNode({ ...(await runtime.getGoalDagNode("goal-1", "build") as GoalDagNode), status: "complete", updatedAt: now });
  await runtime.saveGoalSubagent(subagent({
    status: "complete",
    workspacePath: "/repo/.worktrees/build",
    branch: "feat/build",
    integrationState: "not-required",
    integrationStatus: "integration not required",
  }));
  const adapter = new FakeSubagentAdapter();
  const integratedNodes: string[] = [];

  const tick = await runtime.runGoalControllerTick("goal-1", {
    adapter,
    integrator: (request) => {
      integratedNodes.push(request.node.nodeId);
      return {
        status: "complete",
        summary: "merged shared build",
        sourceBranch: request.subagent.branch,
        sourceHead: "abc123",
        integrationCommitSha: "merge123",
        completedAt: now,
      };
    },
    workspaceAllocator: ({ node }) => ({ subagentId: `subagent-${node.nodeId}`, cwd: `/repo/.worktrees/${node.slug}`, branch: `feat/${node.slug}` }),
  });

  assert.deepEqual(integratedNodes, ["build"]);
  assert.deepEqual(tick.started.map((item) => item.nodeId), ["docs", "tests"]);
});

test("controller safety net blocks downstream when upstream integration fails", async () => {
  const { runtime } = await runtimeWithPlan([
    { nodeId: "build", objective: "Build feature" },
    { nodeId: "docs", objective: "Document feature", dependencyNodeIds: ["build"] },
  ]);
  await runtime.saveGoalDagNode({ ...(await runtime.getGoalDagNode("goal-1", "build") as GoalDagNode), status: "complete", updatedAt: now });
  await runtime.saveGoalSubagent(subagent({
    status: "complete",
    workspacePath: "/repo/.worktrees/build",
    branch: "feat/build",
    integrationState: "not-required",
    integrationStatus: "integration not required",
  }));
  const adapter = new FakeSubagentAdapter();
  let allocated = false;

  const tick = await runtime.runGoalControllerTick("goal-1", {
    adapter,
    integrator: () => ({ status: "failed", summary: "merge conflict in src/core/git-workspace.ts", error: "conflict" }),
    workspaceAllocator: () => {
      allocated = true;
      return { subagentId: "subagent-docs", cwd: "/repo/.worktrees/docs", branch: "feat/docs" };
    },
  });

  assert.equal(allocated, false);
  assert.equal(adapter.starts.length, 0);
  assert.equal(tick.blocked.length, 1);
  assert.equal(tick.blocked[0]?.nodeId, "docs");
  const savedNode = await runtime.getGoalDagNode("goal-1", "docs");
  assert.equal(savedNode?.status, "blocked");
  assert.match(savedNode?.lastValidationSummary ?? "", /dependency build integration failed/);
  assert.match(savedNode?.lastValidationSummary ?? "", /merge conflict/);
  const savedSubagent = await runtime.getGoalSubagent("goal-1", "subagent-1");
  assert.equal(savedSubagent?.integrationState, "failed");
});

test("controller blocks idle subagents with failed integration instead of leaving stale running nodes", async () => {
  const { runtime } = await runtimeWithPlan([{ nodeId: "build", objective: "Build feature" }]);
  const original = await runtime.getGoalDagNode("goal-1", "build") as GoalDagNode;
  await runtime.saveGoalDagNode({
    ...original,
    status: "running",
    lifecyclePhase: "runnerActive",
    lastValidationSummary: "integration follow-up required: post-merge validation failed",
    updatedAt: now,
  });
  await runtime.saveGoalSubagent(subagent({
    status: "idle",
    workspacePath: "/repo/.worktrees/build",
    branch: "feat/build",
    integrationState: "failed",
    integrationStatus: "post-merge validation failed",
  }));
  const adapter = new FakeSubagentAdapter();
  adapter.states.set("subagent-1", { status: "idle", lastActivityAt: now, error: "post-merge validation failed" });

  const tick = await runtime.runGoalControllerTick("goal-1", {
    adapter,
    workspaceAllocator: ({ node }) => ({ subagentId: `subagent-${node.nodeId}`, cwd: `/repo/.worktrees/${node.slug}`, branch: `feat/${node.slug}` }),
  });

  assert.equal(tick.blocked.length, 1);
  const savedNode = await runtime.getGoalDagNode("goal-1", "build");
  assert.equal(savedNode?.status, "blocked");
  assert.equal(savedNode?.lifecyclePhase, "terminal");
  assert.match(savedNode?.lastValidationSummary ?? "", /integration failed while subagent is idle/);
  assert.match(savedNode?.lastValidationSummary ?? "", /post-merge validation failed/);
  const savedSubagent = await runtime.getGoalSubagent("goal-1", "subagent-1");
  assert.equal(savedSubagent?.status, "blocked");
  assert.equal(savedSubagent?.integrationState, "failed");
});

test("controller propagates terminal dependency blockers to downstream planned nodes", async () => {
  const { runtime } = await runtimeWithPlan([
    { nodeId: "build", objective: "Build feature" },
    { nodeId: "docs", objective: "Document feature", dependencyNodeIds: ["build"] },
    { nodeId: "tests", objective: "Test docs", dependencyNodeIds: ["docs"] },
  ]);
  await runtime.saveGoalDagNode({
    ...(await runtime.getGoalDagNode("goal-1", "build") as GoalDagNode),
    status: "blockedTerminal",
    lifecyclePhase: "terminal",
    lastValidationSummary: "controller policy blocked build",
    updatedAt: now,
  });
  const adapter = new FakeSubagentAdapter();

  const tick = await runtime.runGoalControllerTick("goal-1", {
    adapter,
    workspaceAllocator: ({ node }) => ({ subagentId: `subagent-${node.nodeId}`, cwd: `/repo/.worktrees/${node.slug}`, branch: `feat/${node.slug}` }),
  });

  assert.equal(adapter.starts.length, 0);
  assert.equal(tick.started.length, 0);
  assert.deepEqual(tick.blocked.map((node) => node.nodeId), ["docs", "tests"]);
  const docs = await runtime.getGoalDagNode("goal-1", "docs");
  const tests = await runtime.getGoalDagNode("goal-1", "tests");
  assert.equal(docs?.status, "blocked");
  assert.equal(tests?.status, "blocked");
  assert.match(docs?.lastValidationSummary ?? "", /dependency build is blockedTerminal/);
  assert.match(tests?.lastValidationSummary ?? "", /dependency docs is blocked/);
  assert.doesNotMatch(tests?.lastValidationSummary ?? "", /controller policy blocked build.*controller policy blocked build/s);
});

test("controller safety net skips upstream dependencies already integrated into controller", async () => {
  const { runtime } = await runtimeWithPlan([
    { nodeId: "build", objective: "Build feature" },
    { nodeId: "docs", objective: "Document feature", dependencyNodeIds: ["build"] },
  ]);
  await runtime.saveGoalDagNode({ ...(await runtime.getGoalDagNode("goal-1", "build") as GoalDagNode), status: "complete", updatedAt: now });
  await runtime.saveGoalSubagent(subagent({
    status: "complete",
    workspacePath: "/repo/.worktrees/build",
    branch: "feat/build",
    integrationState: "complete",
    integrationCompletedAt: now,
  }));
  const adapter = new FakeSubagentAdapter();

  const tick = await runtime.runGoalControllerTick("goal-1", {
    adapter,
    integrator: () => {
      throw new Error("already-integrated dependency should not be integrated again");
    },
    workspaceAllocator: ({ node }) => ({ subagentId: "subagent-docs", cwd: `/repo/.worktrees/${node.slug}`, branch: `feat/${node.slug}` }),
  });

  assert.equal(tick.started.length, 1);
  assert.equal(tick.started[0]?.nodeId, "docs");
  assert.equal(adapter.starts.length, 1);
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
  assert.equal(saved?.retryCount, 2);
  assert.deepEqual(saved?.controllerValidationResults, ["tests failed", "tests failed", "tests failed"]);
});

test("controller starts a replacement session after validation follow-up cap when resources are reusable", async () => {
  const { runtime } = await runtimeWithPlan([{ nodeId: "build", objective: "Build feature", expectedOutputs: ["dist/app.js"] }]);
  await runtime.saveGoalDagNode({ ...(await runtime.getGoalDagNode("goal-1", "build") as GoalDagNode), status: "running", updatedAt: now });
  await runtime.saveGoalSubagent(subagent({
    workspacePath: "/repo/.worktrees/build",
    branch: "feat/build",
    retryCount: 2,
    controllerValidationResults: ["tests failed", "tests failed"],
  }));
  const adapter = new FakeSubagentAdapter();
  adapter.states.set("subagent-1", { status: "selfReportedComplete", selfReportedResult: "done", lastActivityAt: "2026-06-02T00:01:00.000Z" });

  const tick = await runtime.runGoalControllerTick("goal-1", {
    adapter,
    validator: () => ({ status: "failed", summary: "tests failed", followupPrompt: "Fix failing tests" }),
  });

  assert.equal(tick.blocked.length, 0);
  assert.equal(tick.followups.length, 0);
  assert.equal(tick.started.length, 1);
  assert.equal(adapter.starts.length, 1);
  assert.equal(adapter.starts[0]?.subagentId, "subagent-1-retry-1");
  assert.equal(adapter.starts[0]?.cwd, "/repo/.worktrees/build");
  assert.equal(adapter.starts[0]?.branch, "feat/build");
  assert.match(adapter.starts[0]?.initialPrompt ?? "", /VALIDATION_FOLLOWUP_CAP_REPLACEMENT/);
  assert.match(adapter.starts[0]?.initialPrompt ?? "", /dist\/app\.js/);
  assert.equal((await runtime.getGoalDagNode("goal-1", "build"))?.status, "running");
  assert.equal((await runtime.getGoalSubagent("goal-1", "subagent-1"))?.status, "failed");
  const replacement = await runtime.getGoalSubagent("goal-1", "subagent-1-retry-1");
  assert.equal(replacement?.status, "running");
  assert.equal(replacement?.retryCount, 1);
});

test("controller blocks controller-action-required validation caps instead of replacing the subagent", async () => {
  const policySummary = "Controller validation failed: policy failures: changed files outside allowed paths: repos/goal-runner";
  const { runtime } = await runtimeWithPlan([{
    nodeId: "build",
    objective: "Build feature",
    validation: {
      allowedPaths: [
        "repos/goal-runner/src/adapters/pi/monitor-ui.ts",
        "repos/goal-runner/dist/adapters/pi/monitor-ui.*",
      ],
    },
  }]);
  await runtime.saveGoalDagNode({ ...(await runtime.getGoalDagNode("goal-1", "build") as GoalDagNode), status: "running", updatedAt: now });
  await runtime.saveGoalSubagent(subagent({
    workspacePath: "/repo/.worktrees/build",
    branch: "feat/build",
    retryCount: 2,
    controllerValidationResults: [policySummary, policySummary],
  }));
  const adapter = new FakeSubagentAdapter();
  adapter.states.set("subagent-1", { status: "selfReportedComplete", selfReportedResult: "done", lastActivityAt: "2026-06-02T00:01:00.000Z" });

  const tick = await runtime.runGoalControllerTick("goal-1", {
    adapter,
    validator: () => ({ status: "failed", summary: policySummary, followupPrompt: "Fix path policy failure" }),
  });

  assert.equal(tick.started.length, 0);
  assert.equal(adapter.starts.length, 0);
  assert.equal(adapter.prompts.length, 0);
  assert.equal(tick.blocked.length, 1);
  assert.match(tick.blocked[0]?.lastValidationSummary ?? "", /changed files outside allowed paths: repos\/goal-runner/);
  assert.equal((await runtime.getGoalDagNode("goal-1", "build"))?.status, "blocked");
  const saved = await runtime.getGoalSubagent("goal-1", "subagent-1");
  assert.equal(saved?.status, "blocked");
  assert.match(saved?.integrationStatus ?? "", /repeated identical controller validation failure/);
});

test("controller blocks missing-diff caps after submodule path-policy conflicts instead of replacing the subagent", async () => {
  const policySummary = "Controller validation failed: policy failures: changed files outside allowed paths: repos/goal-runner";
  const missingDiffSummary = "Controller validation failed: missing evidence: implementation-diff-present";
  const { runtime } = await runtimeWithPlan([{
    nodeId: "build",
    objective: "Build feature",
    validation: {
      allowedPaths: [
        "repos/goal-runner/src/adapters/pi/monitor-ui.ts",
        "repos/goal-runner/dist/adapters/pi/monitor-ui.*",
      ],
    },
  }]);
  await runtime.saveGoalDagNode({ ...(await runtime.getGoalDagNode("goal-1", "build") as GoalDagNode), status: "running", updatedAt: now });
  await runtime.saveGoalSubagent(subagent({
    workspacePath: "/repo/.worktrees/build",
    branch: "feat/build",
    retryCount: 2,
    controllerValidationResults: [policySummary, missingDiffSummary, missingDiffSummary],
  }));
  const adapter = new FakeSubagentAdapter();
  adapter.states.set("subagent-1", { status: "selfReportedComplete", selfReportedResult: "done", lastActivityAt: "2026-06-02T00:01:00.000Z" });

  const tick = await runtime.runGoalControllerTick("goal-1", {
    adapter,
    validator: () => ({ status: "failed", summary: missingDiffSummary, followupPrompt: "Restore implementation diff evidence" }),
  });

  assert.equal(tick.started.length, 0);
  assert.equal(adapter.starts.length, 0);
  assert.equal(adapter.prompts.length, 0);
  assert.equal(tick.blocked.length, 1);
  assert.match(tick.blocked[0]?.lastValidationSummary ?? "", /missing evidence: implementation-diff-present/);
  assert.equal((await runtime.getGoalDagNode("goal-1", "build"))?.status, "blocked");
  const saved = await runtime.getGoalSubagent("goal-1", "subagent-1");
  assert.equal(saved?.status, "blocked");
  assert.match(saved?.integrationStatus ?? "", /repeated identical controller validation failure/);
});

test("controller restarts interrupted validation-cap replacement attempts", async () => {
  const cappedSummary = "Controller validation failed: missing outputs: dist/app.js repeated identical controller validation failure (1821 occurrences); automatic same-session follow-ups are capped at 2";
  const { runtime } = await runtimeWithPlan([{ nodeId: "build", objective: "Build feature", expectedOutputs: ["dist/app.js"] }]);
  await runtime.saveGoalDagNode({
    ...(await runtime.getGoalDagNode("goal-1", "build") as GoalDagNode),
    status: "blocked",
    updatedAt: now,
    lastValidationSummary: cappedSummary,
  });
  await runtime.saveGoalSubagent(subagent({
    status: "failed",
    workspacePath: "/repo/.worktrees/build",
    branch: "feat/build",
    retryCount: 2,
    integrationStatus: `stale subagent attempt terminalized: replaced by subagent-1-retry-1: ${cappedSummary}`,
    lastRecoveryDecision: {
      action: "restartRunnerSameWorktreeNewSession",
      reason: cappedSummary,
      at: now,
      ruleId: "validation-followup-cap-replacement",
      retryCount: 1,
      maxRetries: 2,
    },
  }));
  const adapter = new FakeSubagentAdapter();

  const tick = await runtime.runGoalControllerTick("goal-1", { adapter, maxAutoRetries: 2 });

  assert.equal(tick.started.length, 1);
  assert.equal(adapter.starts.length, 1);
  assert.equal(adapter.starts[0]?.subagentId, "subagent-1-retry-1");
  assert.equal(adapter.starts[0]?.cwd, "/repo/.worktrees/build");
  assert.equal((await runtime.getGoalDagNode("goal-1", "build"))?.status, "running");
  assert.equal((await runtime.getGoalSubagent("goal-1", "subagent-1-retry-1"))?.status, "running");
});

test("controller ignores stale self-report replays after validation follow-up cap", async () => {
  const { runtime } = await runtimeWithPlan([{ nodeId: "build", objective: "Build feature" }]);
  await runtime.saveGoalDagNode({ ...(await runtime.getGoalDagNode("goal-1", "build") as GoalDagNode), status: "running", updatedAt: now });
  await runtime.saveGoalSubagent(subagent({ controllerValidationResults: ["tests failed", "tests failed"] }));
  const adapter = new FakeSubagentAdapter();
  adapter.states.set("subagent-1", { status: "selfReportedComplete", selfReportedResult: "done", lastActivityAt: "2026-06-02T00:01:00.000Z" });
  let validationCalls = 0;
  const validator = () => {
    validationCalls += 1;
    return { status: "failed" as const, summary: "tests failed", followupPrompt: "Fix failing tests" };
  };

  await runtime.runGoalControllerTick("goal-1", { adapter, validator });
  const capped = await runtime.getGoalSubagent("goal-1", "subagent-1");
  assert.equal(capped?.status, "blocked");
  assert.equal(capped?.retryCount, 2);

  const replay = await runtime.runGoalControllerTick("goal-1", {
    adapter,
    validator,
    now: "2026-06-02T00:03:00.000Z",
  });

  assert.equal(validationCalls, 1);
  assert.equal(replay.synced.length, 0);
  assert.equal(replay.validating.length, 0);
  assert.equal(replay.followups.length, 0);
  assert.equal((await runtime.getGoalDagNode("goal-1", "build"))?.status, "blocked");
  const saved = await runtime.getGoalSubagent("goal-1", "subagent-1");
  assert.equal(saved?.status, "blocked");
  assert.equal(saved?.selfReportedResult, "done");
  assert.match(saved?.integrationStatus ?? "", /repeated identical controller validation failure/);
});

test("controller does not bypass persisted validation follow-up caps with generic blocked recovery", async () => {
  const cappedSummary = "Controller validation failed: missing outputs repeated identical controller validation failure (1437 occurrences); automatic same-session follow-ups are capped at 2";
  const { runtime } = await runtimeWithPlan([{ nodeId: "build", objective: "Build feature" }]);
  await runtime.saveGoalDagNode({
    ...(await runtime.getGoalDagNode("goal-1", "build") as GoalDagNode),
    status: "blocked",
    updatedAt: now,
    lastValidationSummary: cappedSummary,
  });
  await runtime.saveGoalSubagent(subagent({
    status: "blocked",
    selfReportedResult: "done",
    integrationStatus: cappedSummary,
    lastActivityAt: "2026-06-02T00:01:00.000Z",
  }));
  const adapter = new FakeSubagentAdapter();
  adapter.states.set("subagent-1", { status: "selfReportedComplete", selfReportedResult: "done", lastActivityAt: "2026-06-02T00:01:00.000Z" });

  const tick = await runtime.runGoalControllerTick("goal-1", {
    adapter,
    validator: () => {
      throw new Error("stale self-report should not be revalidated");
    },
    now: "2026-06-02T00:03:00.000Z",
  });

  assert.equal(tick.synced.length, 0);
  assert.equal(tick.validating.length, 0);
  assert.equal(tick.followups.length, 0);
  assert.equal(adapter.prompts.length, 0);
  assert.equal((await runtime.getGoalDagNode("goal-1", "build"))?.status, "blocked");
  const saved = await runtime.getGoalSubagent("goal-1", "subagent-1");
  assert.equal(saved?.status, "blocked");
  assert.equal(saved?.integrationStatus, cappedSummary);
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

test("controller retries dirty-controller integration blockers after the controller workspace is clean", async () => {
  const dirty = "controller workspace has uncommitted changes; cannot integrate safely:\nM projects/frontend/beyourself_frontend";
  const { runtime } = await runtimeWithPlan([{ nodeId: "build", objective: "Build feature", workspaceStrategy: "native-git-worktree" }]);
  await runtime.saveGoalDagNode({
    ...(await runtime.getGoalDagNode("goal-1", "build") as GoalDagNode),
    status: "blocked",
    lifecyclePhase: "terminal",
    updatedAt: now,
    lastValidationSummary: dirty,
  });
  await runtime.saveGoalSubagent(subagent({
    status: "blocked",
    workspacePath: "/repo/.worktrees/build",
    branch: "feat/build",
    commitSha: "abc123",
    integrationState: "failed",
    integrationStatus: dirty,
    integrationError: dirty,
    controllerValidationResults: ["Controller validation passed (1 signal(s))."],
    lastActivityAt: now,
    updatedAt: now,
  }));
  const adapter = new FakeSubagentAdapter();
  adapter.states.set("subagent-1", { status: "blocked", error: dirty, lastActivityAt: now });

  const tick = await runtime.runGoalControllerTick("goal-1", {
    adapter,
    now: "2026-06-02T00:02:00.000Z",
    integrator: () => ({
      status: "complete",
      summary: "integrated cleanly after controller workspace cleanup",
      sourceHead: "abc123",
      integrationCommitSha: "def456",
    }),
  });

  assert.equal(tick.completed.length, 1);
  assert.equal((await runtime.getGoalDagNode("goal-1", "build"))?.status, "complete");
  const saved = await runtime.getGoalSubagent("goal-1", "subagent-1");
  assert.equal(saved?.status, "complete");
  assert.equal(saved?.integrationState, "complete");
  assert.equal(saved?.integrationCommitSha, "def456");
});

test("controller retries terminal submodule publish blockers after retained ref or policy recovery", async () => {
  const reason = "submodule publish blocked: repos/goal-runner: submodule URL https://github.com/a5345534/goal-runner.git is not in trustedSubmoduleUrlPatterns; cannot publish retained ref";
  const { runtime } = await runtimeWithPlan([{ nodeId: "build", objective: "Build feature", workspaceStrategy: "native-git-worktree" }]);
  await runtime.saveGoalDagNode({
    ...(await runtime.getGoalDagNode("goal-1", "build") as GoalDagNode),
    status: "blockedTerminal",
    lifecyclePhase: "terminal",
    updatedAt: now,
    lastValidationSummary: `blockedTerminal: recovery retries exhausted (2/2). ${reason}`,
  });
  await runtime.saveGoalSubagent(subagent({
    status: "blockedTerminal",
    workspacePath: "/repo/.worktrees/build",
    branch: "feat/build",
    commitSha: "abc123",
    integrationState: "failed",
    integrationStatus: `blockedTerminal: recovery retries exhausted (2/2). ${reason}`,
    integrationError: reason,
    controllerValidationResults: ["Controller validation passed (1 signal(s))."],
    retryCount: 2,
    lastActivityAt: now,
    updatedAt: now,
  }));
  const adapter = new FakeSubagentAdapter();

  const early = await runtime.runGoalControllerTick("goal-1", {
    adapter,
    now: "2026-06-02T00:00:30.000Z",
    integrator: () => {
      throw new Error("integrator should not run before cooldown");
    },
  });

  assert.equal(early.completed.length, 0);
  assert.equal((await runtime.getGoalDagNode("goal-1", "build"))?.status, "blockedTerminal");

  const retried = await runtime.runGoalControllerTick("goal-1", {
    adapter,
    now: "2026-06-02T00:02:00.000Z",
    integrator: () => ({
      status: "complete",
      summary: "integrated after retained ref became available",
      sourceHead: "abc123",
      integrationCommitSha: "def456",
    }),
  });

  assert.equal(retried.completed.length, 1);
  assert.equal((await runtime.getGoalDagNode("goal-1", "build"))?.status, "complete");
  const saved = await runtime.getGoalSubagent("goal-1", "subagent-1");
  assert.equal(saved?.status, "complete");
  assert.equal(saved?.integrationState, "complete");
  assert.equal(saved?.integrationCommitSha, "def456");
  assert.match(saved?.integrationStatus ?? "", /integrated after retained ref became available/);
});

test("controller leaves non-retryable terminal blockers terminal", async () => {
  const reason = "blockedTerminal: recovery retries exhausted (2/2). human approval required";
  const { runtime } = await runtimeWithPlan([{ nodeId: "build", objective: "Build feature", workspaceStrategy: "native-git-worktree" }]);
  await runtime.saveGoalDagNode({
    ...(await runtime.getGoalDagNode("goal-1", "build") as GoalDagNode),
    status: "blockedTerminal",
    lifecyclePhase: "terminal",
    updatedAt: now,
    lastValidationSummary: reason,
  });
  await runtime.saveGoalSubagent(subagent({
    status: "blockedTerminal",
    integrationState: "failed",
    integrationStatus: reason,
    integrationError: reason,
    controllerValidationResults: ["Controller validation passed (1 signal(s))."],
    retryCount: 2,
    updatedAt: now,
  }));
  const adapter = new FakeSubagentAdapter();

  const tick = await runtime.runGoalControllerTick("goal-1", {
    adapter,
    now: "2026-06-02T00:20:00.000Z",
    integrator: () => {
      throw new Error("integrator should not run for non-retryable blockers");
    },
  });

  assert.equal(tick.completed.length, 0);
  assert.equal(tick.followups.length, 0);
  assert.equal(tick.blocked.length, 0);
  assert.equal((await runtime.getGoalDagNode("goal-1", "build"))?.status, "blockedTerminal");
  assert.equal((await runtime.getGoalSubagent("goal-1", "subagent-1"))?.status, "blockedTerminal");
});

test("controller does not prompt blocked subagents for provider quota blockers", async () => {
  const { runtime } = await runtimeWithPlan([{ nodeId: "build", objective: "Build feature" }]);
  await runtime.saveGoalDagNode({
    ...(await runtime.getGoalDagNode("goal-1", "build") as GoalDagNode),
    status: "blocked",
    updatedAt: now,
    lastValidationSummary: "insufficient_quota: available balance exhausted",
  });
  await runtime.saveGoalSubagent(subagent({ status: "blocked", integrationStatus: "insufficient_quota: available balance exhausted", retryCount: 0, lastActivityAt: "2026-06-02T00:01:00.000Z" }));
  const adapter = new FakeSubagentAdapter();
  adapter.states.set("subagent-1", {
    status: "blocked",
    error: "insufficient_quota: available balance exhausted",
    lastActivityAt: "2026-06-02T00:01:00.000Z",
  });

  const tick = await runtime.runGoalControllerTick("goal-1", { adapter, maxAutoRetries: 2 });

  assert.equal(tick.followups.length, 0);
  assert.equal(adapter.prompts.length, 0);
  assert.equal(tick.blocked.length, 0);
  assert.equal(tick.changed, false);
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
  assert.match(adapter.prompts[0]?.prompt ?? "", /Implemented files and verification passed, but no marker/);
  assert.equal((await runtime.getGoalDagNode("goal-1", "build"))?.status, "running");
  const stored = await runtime.getGoalSubagent("goal-1", "subagent-1");
  assert.equal(stored?.status, "running");
  assert.equal(stored?.selfReportedResult, undefined);
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

test("controller circuit-breaks repeated identical recovery decisions", async () => {
  const { runtime } = await runtimeWithPlan([{ nodeId: "build", objective: "Build feature" }]);
  const loopSignature = "fake:runnerError:fake runnererror boom:sendPromptToSameSession";
  await runtime.saveGoalDagNode({ ...(await runtime.getGoalDagNode("goal-1", "build") as GoalDagNode), status: "failed", updatedAt: now, lastValidationSummary: "boom" });
  await runtime.saveGoalSubagent(subagent({
    status: "failed",
    integrationStatus: "boom",
    workspacePath: "/repo/.worktrees/build",
    lastAdapterObservation: { adapterId: "fake", kind: "runnerError", at: now, error: "boom" },
    lastRecoveryDecision: {
      action: "sendPromptToSameSession",
      reason: "boom",
      at: now,
      evidence: { recoveryLoopSignature: loopSignature },
    },
  }));
  const adapter = new FakeSubagentAdapter();

  const tick = await runtime.runGoalControllerTick("goal-1", {
    adapter,
    maxAutoRetries: 1,
    exceptionHandler: () => ({
      action: "sendPromptToSameSession",
      reason: "boom",
      at: now,
      prompt: "retry boom",
      maxRetries: 1,
    }),
  });

  assert.equal(adapter.prompts.length, 0);
  assert.equal(tick.blocked.length, 1);
  const saved = await runtime.getGoalSubagent("goal-1", "subagent-1");
  assert.equal(saved?.status, "blocked");
  assert.equal(saved?.lastRecoveryDecision?.ruleId, "recovery-circuit-breaker");
  assert.equal(saved?.lastRecoveryDecision?.evidence?.circuitBreakerOpen, true);
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

test("exception-handler same-node recovery reuses prepared resources without allocator duplication", async () => {
  const { runtime } = await runtimeWithPlan([{ nodeId: "build", objective: "Build feature", validators: ["npm test"] }]);
  await runtime.saveGoalDagNode({
    ...(await runtime.getGoalDagNode("goal-1", "build") as GoalDagNode),
    status: "running",
    lifecyclePhase: "runnerActive",
    preparedResources: {
      subagentId: "subagent-1",
      adapterId: "fake",
      workspacePath: "/repo/.worktrees/build",
      branch: "feat/build",
      sessionId: "session-subagent-1",
      sessionFile: "/sessions/missing.jsonl",
      createdAt: now,
      updatedAt: now,
    },
    updatedAt: now,
  });
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
  let allocationCalls = 0;

  const tick = await runtime.runGoalControllerTick("goal-1", {
    adapter,
    maxAutoRetries: 2,
    exceptionHandler: createDefaultControllerExceptionHandler({ now: () => new Date(now) }),
    workspaceAllocator: () => {
      allocationCalls += 1;
      return { cwd: "/repo/.worktrees/duplicate", branch: "feat/duplicate" };
    },
  });

  assert.equal(allocationCalls, 0);
  assert.equal(tick.started.length, 1);
  assert.equal(adapter.starts[0]?.cwd, "/repo/.worktrees/build");
  assert.equal(adapter.starts[0]?.branch, "feat/build");
  assert.notEqual(adapter.starts[0]?.cwd, "/repo/.worktrees/duplicate");
  const savedNode = await runtime.getGoalDagNode("goal-1", "build");
  assert.equal(savedNode?.preparedResources?.workspacePath, "/repo/.worktrees/build");
  assert.equal(savedNode?.preparedResources?.branch, "feat/build");
  assert.equal(savedNode?.lastRecoveryDecision?.action, "restartRunnerSameWorktreeNewSession");
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

// ── SUBAGENT_QUESTION triage tests ──

test("controller triages synced non-blocking SUBAGENT_QUESTION and preserves evidence after follow-up", async () => {
  const { runtime } = await runtimeWithPlan([{ nodeId: "build", objective: "Build feature" }]);
  await runtime.saveGoalDagNode({ ...(await runtime.getGoalDagNode("goal-1", "build") as GoalDagNode), status: "running", updatedAt: now });
  await runtime.saveGoalSubagent(subagent({ status: "running" }));
  const adapter = new FakeSubagentAdapter();
  adapter.states.set("subagent-1", {
    status: "needsFollowup",
    lastActivityAt: now,
    selfReportedResult: [
      "SUBAGENT_QUESTION:",
      "- question: Which logging style should I use?",
      "- why it matters: consistency of implementation details",
      "- options:",
      "  - A: Existing console-style logging",
      "  - B: Add a new logging wrapper",
      "- recommended default: A",
      "- blocking: no",
    ].join("\n"),
  });

  const tick = await runtime.runGoalControllerTick("goal-1", { adapter });

  assert.equal(tick.followups.length, 1);
  assert.match(adapter.prompts[0]?.prompt ?? "", /Approved recommended default: A/);
  assert.match(adapter.prompts[0]?.prompt ?? "", /Existing console-style logging/);
  const saved = await runtime.getGoalSubagent("goal-1", "subagent-1");
  assert.equal(saved?.status, "running");
  assert.equal(saved?.questionResults?.[0]?.triageKind, "approvedAssumption");
  assert.equal(saved?.questionResults?.[0]?.selectedOption, "A");
  assert.match(saved?.lastRecoveryDecision?.ruleId ?? "", /question-triage-approvedAssumption/);
});

test("controller answers blocking SUBAGENT_QUESTION from node context and preserves triage evidence", async () => {
  const { runtime } = await runtimeWithPlan([{
    nodeId: "build",
    objective: "Implement provider integration",
    scope: "Use Stripe for payment processing; PayPal integration is out of scope.",
  }]);
  await runtime.saveGoalDagNode({ ...(await runtime.getGoalDagNode("goal-1", "build") as GoalDagNode), status: "running", updatedAt: now });
  await runtime.saveGoalSubagent(subagent({ status: "running" }));
  const adapter = new FakeSubagentAdapter();
  adapter.states.set("subagent-1", {
    status: "needsFollowup",
    lastActivityAt: now,
    selfReportedResult: [
      "SUBAGENT_QUESTION:",
      "- question: Should payment processing use Stripe?",
      "- why it matters: provider choice affects API compatibility",
      "- options:",
      "  - A: Use Stripe",
      "  - B: Use PayPal",
      "- recommended default: A",
      "- blocking: yes",
    ].join("\n"),
  });

  const tick = await runtime.runGoalControllerTick("goal-1", { adapter });

  assert.equal(tick.followups.length, 1);
  assert.match(adapter.prompts[0]?.prompt ?? "", /From the node scope: Use Stripe/);
  const saved = await runtime.getGoalSubagent("goal-1", "subagent-1");
  assert.equal(saved?.status, "running");
  assert.equal(saved?.questionResults?.[0]?.triageKind, "answeredFromContext");
  assert.equal(saved?.questionResults?.[0]?.blocking, true);
});

test("controller escalates blocking SUBAGENT_QUESTION with options and durable evidence", async () => {
  const { runtime } = await runtimeWithPlan([{ nodeId: "build", objective: "Build feature" }]);
  await runtime.saveGoalDagNode({ ...(await runtime.getGoalDagNode("goal-1", "build") as GoalDagNode), status: "running", updatedAt: now });
  await runtime.saveGoalSubagent(subagent({ status: "running" }));
  const adapter = new FakeSubagentAdapter();
  adapter.states.set("subagent-1", {
    status: "needsFollowup",
    lastActivityAt: now,
    selfReportedResult: [
      "SUBAGENT_QUESTION:",
      "- question: Should we break public API compatibility?",
      "- why it matters: existing consumers may fail",
      "- options:",
      "  - A: Version endpoint and keep compatibility",
      "  - B: Break the existing endpoint",
      "- recommended default: A",
      "- blocking: yes",
    ].join("\n"),
  });

  const tick = await runtime.runGoalControllerTick("goal-1", { adapter });

  assert.equal(tick.blocked.length, 1);
  assert.equal(adapter.prompts.length, 0);
  const saved = await runtime.getGoalSubagent("goal-1", "subagent-1");
  assert.equal(saved?.status, "blocked");
  assert.equal(saved?.questionResults?.[0]?.triageKind, "escalatedToHuman");
  assert.match(saved?.lastRecoveryDecision?.ruleId ?? "", /question-triage-escalatedToHuman/);
  assert.match(saved?.integrationStatus ?? "", /Options:/);
  assert.match(saved?.integrationStatus ?? "", /Version endpoint and keep compatibility/);
  assert.match((await runtime.getGoalDagNode("goal-1", "build"))?.lastValidationSummary ?? "", /HUMAN|human input|Options:/i);
});

// ── Durable candidate fallback tests ──

function candidateChain(attemptedCandidates: Array<{ model: string; status: string }>, retryPolicyAttempts?: number): GoalModelResolution {
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
    candidatePlan: attemptedCandidates.map((c, i) => ({
      candidateIndex: i,
      model: c.model,
      compliance: { satisfiesMinimum: true, downgraded: false, missingCapabilities: [] },
      eligible: true,
    })),
    ...(retryPolicyAttempts ? { retryPolicy: { attemptsPerCandidate: retryPolicyAttempts } } : {}),
    resolved: { model: attemptedCandidates[0]?.model ?? "model-a", bindingSource: "test", candidateIndex: 0 },
  };
}

async function setupCandidateSwitchTest() {
  const runtime = new GoalRuntime({
    store: new MemoryGoalStore(),
    config: { now: () => new Date(now), randomId: () => "goal-1" },
  });
  await runtime.createOrReplaceGoal("session-1", "Test goal");
  const nodes = await runtime.planGoalDag("goal-1", [
    { nodeId: "build", objective: "Build feature", modelArg: "model-a" },
  ]);
  const node = nodes[0]!;
  return { runtime, node };
}

function modelSwitchableAdapter(
  errorMessage: string = "context_length_exceeded",
  states: Record<string, HarnessSubagentSessionState> = {},
): FakeSubagentAdapter {
  const adapter = new FakeSubagentAdapter();
  for (const [key, state] of Object.entries(states)) {
    adapter.states.set(key, state);
  }
  return adapter;
}

test("candidate fallback: no candidate chain preserves existing blocking behavior for context-exceeded", async () => {
  const { runtime } = await runtimeWithPlan([{ nodeId: "build", objective: "Build feature", modelArg: "model-a" }]);
  await runtime.saveGoalDagNode({ ...(await runtime.getGoalDagNode("goal-1", "build") as GoalDagNode), status: "failed", updatedAt: now, lastValidationSummary: "context_length_exceeded" });
  await runtime.saveGoalSubagent(subagent({ status: "failed", integrationStatus: "context_length_exceeded", workspacePath: "/repo/.worktrees/build" }));
  const adapter = new FakeSubagentAdapter();

  const tick = await runtime.runGoalControllerTick("goal-1", { adapter, maxAutoRetries: 2 });

  // No candidate chain, so should block as before
  assert.equal(tick.started.length, 0);
  assert.equal(tick.followups.length, 0);
  assert.equal(tick.failed.length, 0);
  assert.equal(tick.blocked.length, 1);
  const saved = await runtime.getGoalSubagent("goal-1", "subagent-1");
  assert.equal(saved?.status, "blocked");
  assert.match(saved?.integrationStatus ?? "", /context fallback/);
});

test("candidate fallback: non-switchable error (provider limit) preserves existing blocking behavior", async () => {
  const { runtime } = await runtimeWithPlan([{ nodeId: "build", objective: "Build feature", modelArg: "model-a" }]);
  await runtime.saveGoalDagNode({ ...(await runtime.getGoalDagNode("goal-1", "build") as GoalDagNode), status: "failed", updatedAt: now, lastValidationSummary: "insufficient_quota" });
  await runtime.saveGoalSubagent(subagent({ status: "failed", integrationStatus: "insufficient_quota", workspacePath: "/repo/.worktrees/build" }));
  const adapter = new FakeSubagentAdapter();

  // Set up a candidate chain - but since the error is non-switchable, should still block
  const node = await runtime.getGoalDagNode("goal-1", "build");
  await runtime.saveGoalDagNode({
    ...node as GoalDagNode,
    modelResolution: candidateChain([{ model: "model-a", status: "succeeded" }, { model: "model-b", status: "succeeded" }]),
  });

  const tick = await runtime.runGoalControllerTick("goal-1", { adapter, maxAutoRetries: 2 });

  assert.equal(tick.started.length, 0);
  assert.equal(tick.followups.length, 0);
  assert.equal(tick.blocked.length, 1);
  assert.match((await runtime.getGoalSubagent("goal-1", "subagent-1"))?.integrationStatus ?? "", /quota or billing limit/);
});

test("candidate fallback: switches to next candidate after context-exceeded on first candidate", async () => {
  const { runtime } = await runtimeWithPlan([{ nodeId: "build", objective: "Build feature", modelArg: "model-a" }]);
  const node = await runtime.getGoalDagNode("goal-1", "build");
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
  await runtime.saveGoalSubagent(subagent({
    status: "failed",
    integrationStatus: "context_length_exceeded",
    workspacePath: "/repo/.worktrees/build",
    retryCount: 1,
  }));
  const adapter = new FakeSubagentAdapter();

  const tick = await runtime.runGoalControllerTick("goal-1", { adapter, maxAutoRetries: 2 });

  // Should start a candidate-switched replacement subagent
  assert.equal(tick.blocked.length, 0);
  assert.equal(tick.started.length, 1);
  assert.equal(tick.failed.length, 0);
  assert.equal(adapter.starts.length, 1);
  const startRequest = adapter.starts[0];
  assert.match(startRequest?.initialPrompt ?? "", /CANDIDATE_SWITCH/);
  assert.match(startRequest?.initialPrompt ?? "", /model-b/);
});

test("candidate fallback: switches using resolver-produced candidatePlan", async () => {
  const bindingCatalog: GoalModelBindingCatalog = {
    version: 2,
    harness: "pi",
    bindings: {
      implementation: {
        candidates: [
          { model: "model-a", declaredCapabilities: { reasoning: "high" } },
          { model: "model-b", declaredCapabilities: { reasoning: "high" } },
        ],
        retryPolicy: { attemptsPerCandidate: 1 },
      },
    },
  };
  const classCatalog = {
    version: 1 as const,
    modelClasses: {
      implementation: {
        minimumRequirements: { reasoning: "high" as const },
        fallbackPolicy: { allowDowngrade: false, onUnavailable: "block" as const },
      },
    },
  };
  const resolution = resolveGoalModelForHarness({
    harness: "pi",
    modelClass: "implementation",
    classCatalog,
    bindingCatalog,
    bindingSource: "resolver-plan-test",
  });
  assert.equal(resolution.evidence.attemptedCandidates?.length, 1);
  assert.equal(resolution.evidence.candidatePlan?.length, 2);

  const { runtime } = await runtimeWithPlan([{ nodeId: "build", objective: "Build feature", modelArg: resolution.modelArg }]);
  const node = await runtime.getGoalDagNode("goal-1", "build");
  await runtime.saveGoalDagNode({
    ...node as GoalDagNode,
    status: "failed",
    updatedAt: now,
    lastValidationSummary: "context_length_exceeded",
    modelResolution: resolution.evidence,
    preparedResources: {
      subagentId: "subagent-1",
      adapterId: "fake",
      workspacePath: "/repo/.worktrees/build",
      metadata: { activeCandidateIndex: 0, candidateRetryCount: 0 },
    },
  });
  await runtime.saveGoalSubagent(subagent({
    status: "failed",
    integrationStatus: "context_length_exceeded",
    workspacePath: "/repo/.worktrees/build",
    retryCount: 1,
  }));
  const adapter = new FakeSubagentAdapter();

  const tick = await runtime.runGoalControllerTick("goal-1", { adapter, maxAutoRetries: 2 });

  assert.equal(tick.started.length, 1);
  assert.match(adapter.starts[0]?.initialPrompt ?? "", /CANDIDATE_SWITCH/);
  assert.match(adapter.starts[0]?.initialPrompt ?? "", /model-b/);
});

test("candidate fallback: retryPolicy from resolver evidence controls same-candidate retry", async () => {
  const { runtime } = await runtimeWithPlan([{ nodeId: "build", objective: "Build feature", modelArg: "model-a" }]);
  const node = await runtime.getGoalDagNode("goal-1", "build");
  await runtime.saveGoalDagNode({
    ...node as GoalDagNode,
    status: "failed",
    updatedAt: now,
    lastValidationSummary: "context_length_exceeded",
    modelResolution: candidateChain([{ model: "model-a", status: "succeeded" }, { model: "model-b", status: "succeeded" }], 3),
    preparedResources: {
      subagentId: "subagent-1",
      adapterId: "fake",
      workspacePath: "/repo/.worktrees/build",
      metadata: { activeCandidateIndex: 0, candidateRetryCount: 0 },
    },
  });
  await runtime.saveGoalSubagent(subagent({
    status: "failed",
    integrationStatus: "context_length_exceeded",
    workspacePath: "/repo/.worktrees/build",
    retryCount: 1,
  }));
  const adapter = new FakeSubagentAdapter();

  const tick = await runtime.runGoalControllerTick("goal-1", { adapter, maxAutoRetries: 2 });

  assert.equal(tick.started.length, 0);
  assert.equal(tick.followups.length, 1);
  assert.equal(adapter.prompts.length, 1);
  assert.match(adapter.prompts[0]?.prompt ?? "", /candidate retry 1\/3/i);
});

test("candidate fallback: retries same candidate when attemptsPerCandidate > 1", async () => {
  const { runtime } = await runtimeWithPlan([{ nodeId: "build", objective: "Build feature", modelArg: "model-a" }]);
  const node = await runtime.getGoalDagNode("goal-1", "build");
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
        attemptsPerCandidate: 3,
      },
    },
  });
  await runtime.saveGoalSubagent(subagent({
    status: "failed",
    integrationStatus: "context_length_exceeded",
    workspacePath: "/repo/.worktrees/build",
    retryCount: 1,
  }));
  const adapter = new FakeSubagentAdapter();

  const tick = await runtime.runGoalControllerTick("goal-1", { adapter, maxAutoRetries: 2 });

  // Should retry the same candidate (not start a new one)
  assert.equal(tick.blocked.length, 0);
  assert.equal(tick.started.length, 0);
  assert.equal(tick.followups.length, 1);
  assert.equal(adapter.starts.length, 0);
  assert.equal(adapter.prompts.length, 1);
  assert.match(adapter.prompts[0]?.prompt ?? "", /CANDIDATE_RETRY/);
  assert.match(adapter.prompts[0]?.prompt ?? "", /model-a/);
});

test("candidate fallback: blocks with exhaustion after all candidates exhausted", async () => {
  const { runtime } = await runtimeWithPlan([{ nodeId: "build", objective: "Build feature", modelArg: "model-a" }]);
  const node = await runtime.getGoalDagNode("goal-1", "build");
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
        activeCandidateIndex: 1,
        candidateRetryCount: 1,
        attemptsPerCandidate: 1,
      },
    },
  });
  await runtime.saveGoalSubagent(subagent({
    status: "failed",
    integrationStatus: "context_length_exceeded",
    workspacePath: "/repo/.worktrees/build",
    retryCount: 2,
  }));
  const adapter = new FakeSubagentAdapter();

  const tick = await runtime.runGoalControllerTick("goal-1", { adapter, maxAutoRetries: 2 });

  // All candidates exhausted - should block
  assert.equal(tick.started.length, 0);
  assert.equal(tick.followups.length, 0);
  assert.ok(tick.blocked.length >= 1, "Expected at least 1 blocked node for exhausted chain");
  assert.match((await runtime.getGoalSubagent("goal-1", "subagent-1"))?.integrationStatus ?? "", /Candidate chain exhausted/);
});

test("candidate fallback: persists candidate state in preparedResources metadata", async () => {
  const { runtime } = await runtimeWithPlan([{ nodeId: "build", objective: "Build feature", modelArg: "model-a" }]);
  const node = await runtime.getGoalDagNode("goal-1", "build");
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
        attemptsPerCandidate: 2,
      },
    },
  });
  await runtime.saveGoalSubagent(subagent({
    status: "failed",
    integrationStatus: "context_length_exceeded",
    workspacePath: "/repo/.worktrees/build",
    retryCount: 1,
  }));
  const adapter = new FakeSubagentAdapter();

  await runtime.runGoalControllerTick("goal-1", { adapter, maxAutoRetries: 2 });

  // Should retry - candidateRetryCount should be incremented
  const updatedNode = await runtime.getGoalDagNode("goal-1", "build");
  assert.equal(updatedNode?.preparedResources?.metadata?.activeCandidateIndex, 0);
  assert.equal(updatedNode?.preparedResources?.metadata?.candidateRetryCount, 1);
  assert.equal(updatedNode?.preparedResources?.metadata?.attemptsPerCandidate, 2);
});

// ── Additional controller-loop switchable failure, deterministic blocker, and fallback evidence tests ──

test("candidate fallback: transient server error switches to next candidate", async () => {
  const { runtime } = await runtimeWithPlan([{ nodeId: "build", objective: "Build feature", modelArg: "model-a" }]);
  const node = await runtime.getGoalDagNode("goal-1", "build");
  await runtime.saveGoalDagNode({
    ...node as GoalDagNode,
    status: "failed",
    updatedAt: now,
    lastValidationSummary: "server_error",
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
  await runtime.saveGoalSubagent(subagent({
    status: "failed",
    integrationStatus: "server_error",
    workspacePath: "/repo/.worktrees/build",
    retryCount: 1,
  }));
  const adapter = new FakeSubagentAdapter();

  const tick = await runtime.runGoalControllerTick("goal-1", { adapter, maxAutoRetries: 2 });

  // Transient errors are switchable — should start a candidate-switched replacement
  assert.equal(tick.blocked.length, 0);
  assert.equal(tick.started.length, 1);
  assert.equal(tick.failed.length, 0);
  assert.equal(adapter.starts.length, 1);
  assert.match(adapter.starts[0]?.initialPrompt ?? "", /CANDIDATE_SWITCH/);
  assert.match(adapter.starts[0]?.initialPrompt ?? "", /model-b/);
});

test("candidate fallback: gateway timeout triggers candidate switch", async () => {
  const { runtime } = await runtimeWithPlan([{ nodeId: "build", objective: "Build feature", modelArg: "model-a" }]);
  const node = await runtime.getGoalDagNode("goal-1", "build");
  await runtime.saveGoalDagNode({
    ...node as GoalDagNode,
    status: "failed",
    updatedAt: now,
    lastValidationSummary: "Gateway Timeout",
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
  await runtime.saveGoalSubagent(subagent({
    status: "failed",
    integrationStatus: "Gateway Timeout",
    workspacePath: "/repo/.worktrees/build",
    retryCount: 1,
  }));
  const adapter = new FakeSubagentAdapter();

  const tick = await runtime.runGoalControllerTick("goal-1", { adapter, maxAutoRetries: 2 });

  assert.equal(tick.blocked.length, 0);
  assert.equal(tick.started.length, 1);
});

test("candidate fallback: deterministic provider-limit blocker after candidate switch preserves block", async () => {
  // First candidate failed with context-exceeded (switchable).
  // After switch to second candidate, failure is provider-limit (deterministic).
  // Should block, not keep switching.
  const { runtime } = await runtimeWithPlan([{ nodeId: "build", objective: "Build feature", modelArg: "model-a" }]);
  const node = await runtime.getGoalDagNode("goal-1", "build");
  await runtime.saveGoalDagNode({
    ...node as GoalDagNode,
    status: "failed",
    updatedAt: now,
    lastValidationSummary: "insufficient_quota",
    modelResolution: candidateChain([{ model: "model-a", status: "succeeded" }, { model: "model-b", status: "succeeded" }, { model: "model-c", status: "succeeded" }]),
    preparedResources: {
      subagentId: "subagent-1",
      adapterId: "fake",
      workspacePath: "/repo/.worktrees/build",
      metadata: {
        activeCandidateIndex: 1,
        candidateRetryCount: 1,
        attemptsPerCandidate: 1,
      },
    },
  });
  await runtime.saveGoalSubagent(subagent({
    status: "failed",
    integrationStatus: "insufficient_quota",
    workspacePath: "/repo/.worktrees/build",
    retryCount: 2,
  }));
  const adapter = new FakeSubagentAdapter();

  const tick = await runtime.runGoalControllerTick("goal-1", { adapter, maxAutoRetries: 2 });

  // Provider limit is non-switchable — should block regardless of remaining candidates
  assert.equal(tick.started.length, 0);
  assert.equal(tick.followups.length, 0);
  assert.equal(tick.blocked.length, 1);
  assert.match((await runtime.getGoalSubagent("goal-1", "subagent-1"))?.integrationStatus ?? "", /quota or billing limit/);
});

test("candidate fallback: records candidate_retried fallback evidence on retry", async () => {
  // Verify that candidate state is updated when retrying the same candidate.
  const { runtime } = await runtimeWithPlan([{ nodeId: "build", objective: "Build feature", modelArg: "model-a" }]);
  const node = await runtime.getGoalDagNode("goal-1", "build");
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
        attemptsPerCandidate: 2,
      },
    },
  });
  await runtime.saveGoalSubagent(subagent({
    status: "failed",
    integrationStatus: "context_length_exceeded",
    workspacePath: "/repo/.worktrees/build",
    retryCount: 1,
  }));
  const adapter = new FakeSubagentAdapter();

  const tick = await runtime.runGoalControllerTick("goal-1", { adapter, maxAutoRetries: 2 });

  // Should retry same candidate (attemptsPerCandidate=2)
  assert.equal(tick.started.length, 0);
  assert.equal(tick.followups.length, 1);

  // Verify the candidate state was updated (candidateRetryCount incremented)
  const updatedNode = await runtime.getGoalDagNode("goal-1", "build");
  assert.equal(updatedNode?.preparedResources?.metadata?.activeCandidateIndex, 0);
  assert.equal(updatedNode?.preparedResources?.metadata?.candidateRetryCount, 1);
});

test("candidate fallback: candidate index advances on switch to next candidate", async () => {
  // After a candidate 0 retry budget is exhausted, switching to candidate 1
  // should persist activeCandidateIndex=1 in preparedResources metadata.
  const { runtime } = await runtimeWithPlan([{ nodeId: "build", objective: "Build feature", modelArg: "model-a" }]);
  const node = await runtime.getGoalDagNode("goal-1", "build");
  await runtime.saveGoalDagNode({
    ...node as GoalDagNode,
    status: "failed",
    updatedAt: now,
    lastValidationSummary: "server_error",
    modelResolution: candidateChain([{ model: "model-a", status: "succeeded" }, { model: "model-b", status: "succeeded" }]),
    preparedResources: {
      subagentId: "subagent-1",
      adapterId: "fake",
      workspacePath: "/repo/.worktrees/build",
      modelArg: "model-a",
      metadata: {
        activeCandidateIndex: 0,
        candidateRetryCount: 1,
        attemptsPerCandidate: 1,
      },
    },
  });
  await runtime.saveGoalSubagent(subagent({
    status: "failed",
    integrationStatus: "server_error",
    workspacePath: "/repo/.worktrees/build",
    retryCount: 2,
  }));
  const adapter = new FakeSubagentAdapter();

  const tick = await runtime.runGoalControllerTick("goal-1", { adapter, maxAutoRetries: 2 });

  // Should have switched to candidate 1
  assert.equal(tick.started.length, 1);
  const updatedNode = await runtime.getGoalDagNode("goal-1", "build");
  assert.equal(updatedNode?.preparedResources?.metadata?.activeCandidateIndex, 1);
  assert.equal(updatedNode?.preparedResources?.metadata?.candidateRetryCount, 0);
  // modelArg should now point to the new candidate's model
  assert.equal(updatedNode?.modelArg, "model-b");
});

test("candidate fallback: non-switchable missing-session error blocks even with candidate chain", async () => {
  // Missing-session errors are NOT switchable (not context-exceeded or transient).
  // Should trigger the missing-session replacement flow, not candidate switch.
  const { runtime } = await runtimeWithPlan([{ nodeId: "build", objective: "Build feature", modelArg: "model-a" }]);
  const node = await runtime.getGoalDagNode("goal-1", "build");
  await runtime.saveGoalDagNode({
    ...node as GoalDagNode,
    status: "failed",
    updatedAt: now,
    lastValidationSummary: "session file not found",
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
  await runtime.saveGoalSubagent(subagent({
    status: "failed",
    integrationStatus: "session file not found",
    workspacePath: "/repo/.worktrees/build",
    retryCount: 1,
  }));
  const adapter = new FakeSubagentAdapter();

  const tick = await runtime.runGoalControllerTick("goal-1", { adapter, maxAutoRetries: 2 });

  // Missing-session is not switchable — should trigger stale replacement instead.
  // We verify it didn't do a candidate switch by checking that a replacement
  // subagent was started (stale-session replacement) rather than a candidate switch.
  assert.equal(tick.started.length, 1);
  // The replacement prompt should contain "STALE_MISSING_SESSION_REPLACEMENT" not "CANDIDATE_SWITCH"
  if (adapter.starts.length > 0) {
    assert.doesNotMatch(adapter.starts[0]?.initialPrompt ?? "", /CANDIDATE_SWITCH/);
    assert.match(adapter.starts[0]?.initialPrompt ?? "", /STALE_MISSING_SESSION_REPLACEMENT/);
  }
});
