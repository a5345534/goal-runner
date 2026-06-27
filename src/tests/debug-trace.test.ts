import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GoalRuntime,
  JsonlGoalDebugTracer,
  MemoryGoalStore,
  buildGoalDebugReport,
  recordGoalDebugSnapshot,
  type GoalDebugTraceEvent,
} from "../core/index.js";

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function readTrace(path: string): GoalDebugTraceEvent[] {
  return readFileSync(path, "utf8")
    .trim()
    .split(/\n+/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as GoalDebugTraceEvent);
}

test("debug tracer records logical store/database operations without raw objective text", async () => {
  const dir = tempDir("goal-debug-trace-");
  try {
    let traceId = 0;
    const traceFile = join(dir, "trace.jsonl");
    const tracer = new JsonlGoalDebugTracer({
      traceFile,
      now: () => new Date("2026-06-02T00:00:00.000Z"),
      randomId: () => `trace-${++traceId}`,
    });
    const runtime = new GoalRuntime({
      store: new MemoryGoalStore(),
      debugTracer: tracer,
      config: {
        now: () => new Date("2026-06-02T00:00:00.000Z"),
        randomId: () => "goal-debug-1",
      },
    });

    const created = await runtime.createOrReplaceGoal("session-1", "debug objective should not be copied into trace", { continueIfIdle: false });
    assert.equal(created.goal?.goalId, "goal-debug-1");
    await runtime.getGoal("session-1");

    const events = readTrace(traceFile);
    assert.ok(events.some((event) => event.category === "db" && event.operation === "saveGoal" && event.goalId === "goal-debug-1"));
    assert.ok(events.some((event) => event.category === "db" && event.operation === "appendLedgerEvent" && event.details?.type === "goal_created"));
    assert.equal(JSON.stringify(events).includes("debug objective should not be copied into trace"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("debug report detects runner-start launch failure anomalies", async () => {
  const runtime = new GoalRuntime({
    store: new MemoryGoalStore(),
    config: {
      now: () => new Date("2026-06-02T00:00:00.000Z"),
      randomId: () => "goal-debug-2",
    },
  });
  const created = await runtime.createOrReplaceGoal("session-1", "debug runner launch", { continueIfIdle: false });
  const goal = created.goal!;
  const [node] = await runtime.planGoalDag(goal.goalId, [{ nodeId: "implementation", objective: "implement", expectedOutputs: [], validators: [] }]);
  await runtime.saveGoalDagNode({
    ...node,
    status: "running",
    lifecyclePhase: "runnerStarting",
    preparedResources: {
      subagentId: "implementation-runner",
      metadata: {
        runnerLaunchFailureCount: 1,
        lastRunnerLaunchFailureAt: "2026-06-02T00:00:00.000Z",
      },
    },
  });

  const state = await runtime.getGoalOrchestrationState(goal.goalId);
  const report = buildGoalDebugReport({ goal, state, ledgerEvents: [] });
  assert.ok(report.anomalies.some((anomaly) => anomaly.code === "runner-launch-failure-retry-pending"));
  assert.ok(report.anomalies.some((anomaly) => anomaly.code === "runner-starting-without-live-subagent"));
});

test("monitor debug snapshots write monitor and anomaly trace events", async () => {
  const dir = tempDir("goal-debug-snapshot-");
  try {
    const traceFile = join(dir, "trace.jsonl");
    const tracer = new JsonlGoalDebugTracer({
      traceFile,
      now: () => new Date("2026-06-02T00:00:00.000Z"),
      randomId: () => "trace-snapshot",
    });
    const runtime = new GoalRuntime({
      store: new MemoryGoalStore(),
      config: {
        now: () => new Date("2026-06-02T00:00:00.000Z"),
        randomId: () => "goal-debug-3",
      },
    });
    const created = await runtime.createOrReplaceGoal("session-1", "debug snapshot", { continueIfIdle: false });
    const goal = created.goal!;
    const [node] = await runtime.planGoalDag(goal.goalId, [{ nodeId: "blocked-node", objective: "blocked", expectedOutputs: [], validators: [] }]);
    await runtime.saveGoalDagNode({ ...node, status: "blocked", lastValidationSummary: "blocked for test" });
    const state = await runtime.getGoalOrchestrationState(goal.goalId);

    recordGoalDebugSnapshot(tracer, { source: "test.monitor", goal, state });

    const events = readTrace(traceFile);
    assert.ok(events.some((event) => event.category === "monitor" && event.operation === "snapshot" && event.goalId === goal.goalId));
    assert.ok(events.some((event) => event.category === "anomaly" && event.operation === "node-blocked" && event.nodeId === "blocked-node"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Monitor/debug tests for candidate fallback and fallback evidence ──

test("debug report detects exhausted candidate chain anomalies", async () => {
  const runtime = new GoalRuntime({
    store: new MemoryGoalStore(),
    config: {
      now: () => new Date("2026-06-02T00:00:00.000Z"),
      randomId: () => "goal-debug-exhausted",
    },
  });
  const created = await runtime.createOrReplaceGoal("session-1", "debug candidate exhaustion", { continueIfIdle: false });
  const goal = created.goal!;
  const [node] = await runtime.planGoalDag(goal.goalId, [{ nodeId: "build", objective: "Build feature", expectedOutputs: [], validators: [] }]);
  await runtime.saveGoalDagNode({
    ...node,
    status: "blocked",
    lastValidationSummary: "Candidate chain exhausted after candidate 1/model-b (2 attempt(s)): context_length_exceeded",
    modelResolution: {
      schemaVersion: "1.0",
      harness: "pi",
      requested: { modelClass: "implementation", minimumRequirements: { reasoning: "high" } },
      resolved: { model: "model-b", bindingSource: "test", candidateIndex: 1 },
      compliance: { satisfiesMinimum: true, downgraded: false, missingCapabilities: [] },
      status: "blocked" as const,
      attemptedCandidates: [
        { candidateIndex: 0, model: "model-a", compliance: { satisfiesMinimum: true, downgraded: false, missingCapabilities: [] }, status: "succeeded" as const },
        { candidateIndex: 1, model: "model-b", compliance: { satisfiesMinimum: true, downgraded: false, missingCapabilities: [] }, status: "succeeded" as const },
      ],
      switchEvents: [
        { fromCandidateIndex: 0, fromModel: "model-a", toCandidateIndex: 1, toModel: "model-b", reason: "context_length_exceeded" },
      ],
      exhaustedChain: true,
      reason: "all candidates exhausted: context_length_exceeded",
    },
  });

  const state = await runtime.getGoalOrchestrationState(goal.goalId);
  const report = buildGoalDebugReport({ goal, state, ledgerEvents: [] });
  assert.ok(report.anomalies.length > 0, "Expected anomalies for exhausted chain");
  assert.ok(report.anomalies.some((a) => a.code === "node-blocked"), "Expected node-blocked anomaly");
});

test("debug snapshot records candidate fallback switch events as monitor trace", async () => {
  const dir = tempDir("goal-debug-candidate-");
  try {
    const traceFile = join(dir, "trace.jsonl");
    const tracer = new JsonlGoalDebugTracer({
      traceFile,
      now: () => new Date("2026-06-02T00:00:00.000Z"),
      randomId: () => "trace-candidate",
    });
    const runtime = new GoalRuntime({
      store: new MemoryGoalStore(),
      config: {
        now: () => new Date("2026-06-02T00:00:00.000Z"),
        randomId: () => "goal-debug-candidate",
      },
    });
    const created = await runtime.createOrReplaceGoal("session-1", "debug candidate snapshot", { continueIfIdle: false });
    const goal = created.goal!;
    const [node] = await runtime.planGoalDag(goal.goalId, [{ nodeId: "build", objective: "Build feature", expectedOutputs: [], validators: [] }]);
    await runtime.saveGoalDagNode({
      ...node,
      status: "blocked",
      lastValidationSummary: "Candidate chain exhausted",
      modelResolution: {
        schemaVersion: "1.0",
        harness: "pi",
        requested: { modelClass: "implementation", minimumRequirements: { reasoning: "high" } },
        resolved: { model: "model-b", bindingSource: "test", candidateIndex: 1 },
        compliance: { satisfiesMinimum: true, downgraded: false, missingCapabilities: [] },
        status: "blocked" as const,
        attemptedCandidates: [
          { candidateIndex: 0, model: "model-a", compliance: { satisfiesMinimum: true, downgraded: false, missingCapabilities: [] }, status: "succeeded" as const },
          { candidateIndex: 1, model: "model-b", compliance: { satisfiesMinimum: true, downgraded: false, missingCapabilities: [] }, status: "succeeded" as const },
        ],
        switchEvents: [
          { fromCandidateIndex: 0, fromModel: "model-a", toCandidateIndex: 1, toModel: "model-b", reason: "context_length_exceeded" },
        ],
        exhaustedChain: true,
        reason: "all candidates exhausted",
      },
    });
    const state = await runtime.getGoalOrchestrationState(goal.goalId);

    recordGoalDebugSnapshot(tracer, { source: "test.monitor.candidate", goal, state });

    const events = readTrace(traceFile);
    assert.ok(events.some((event) => event.category === "monitor" && event.operation === "snapshot" && event.goalId === goal.goalId));
    assert.ok(events.some((event) => event.category === "anomaly" && event.operation === "node-blocked" && event.nodeId === "build"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("debug tracer records candidate chain anomaly when resolution has exhaustedChain", async () => {
  const dir = tempDir("goal-debug-exhausted-trace-");
  try {
    const traceFile = join(dir, "trace.jsonl");
    const tracer = new JsonlGoalDebugTracer({
      traceFile,
      now: () => new Date("2026-06-02T00:00:00.000Z"),
      randomId: () => "trace-exhausted",
    });
    const runtime = new GoalRuntime({
      store: new MemoryGoalStore(),
      debugTracer: tracer,
      config: {
        now: () => new Date("2026-06-02T00:00:00.000Z"),
        randomId: () => "goal-monitor-exhausted",
      },
    });

    const created = await runtime.createOrReplaceGoal("session-1", "monitor exhausted chain", { continueIfIdle: false });
    const goal = created.goal!;
    const [node] = await runtime.planGoalDag(goal.goalId, [{ nodeId: "build", objective: "Build feature", expectedOutputs: [], validators: [] }]);
    await runtime.saveGoalDagNode({
      ...node,
      status: "blocked",
      lastValidationSummary: "Candidate chain exhausted after all candidates",
      modelResolution: {
        schemaVersion: "1.0",
        harness: "pi",
        requested: { modelClass: "implementation", minimumRequirements: { reasoning: "high" } },
        resolved: { model: "model-b", bindingSource: "test", candidateIndex: 1 },
        compliance: { satisfiesMinimum: true, downgraded: false, missingCapabilities: [] },
        status: "blocked" as const,
        attemptedCandidates: [
          { candidateIndex: 0, model: "model-a", compliance: { satisfiesMinimum: true, downgraded: false, missingCapabilities: [] }, status: "succeeded" as const },
          { candidateIndex: 1, model: "model-b", compliance: { satisfiesMinimum: true, downgraded: false, missingCapabilities: [] }, status: "succeeded" as const },
        ],
        switchEvents: [
          { fromCandidateIndex: 0, fromModel: "model-a", toCandidateIndex: 1, toModel: "model-b", reason: "context_length_exceeded" },
        ],
        exhaustedChain: true,
        reason: "all candidates exhausted",
      },
    });

    const state = await runtime.getGoalOrchestrationState(goal.goalId);
    recordGoalDebugSnapshot(tracer, { source: "test.monitor.exhausted", goal, state });

    const events = readTrace(traceFile);
    assert.ok(events.some((event) => event.category === "anomaly" && event.nodeId === "build"), "Expected anomaly event for build node");
    assert.ok(events.some((event) => event.category === "monitor" && event.operation === "snapshot"), "Expected monitor snapshot");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
