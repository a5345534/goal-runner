import test from "node:test";
import assert from "node:assert/strict";
import {
  buildNodeDurationSummary,
  buildRunnerDurationSummary,
} from "../adapters/monitor-overview.js";
import type {
  GoalDagNode,
  GoalLedgerEvent,
  GoalSubagentRecord,
} from "../core/index.js";

function makeNode(overrides: Partial<GoalDagNode> = {}): GoalDagNode {
  return {
    goalId: "goal-1",
    nodeId: "n1",
    slug: "n1",
    objective: "Build node",
    dependencyNodeIds: [],
    expectedOutputs: [],
    validators: [],
    completionGates: ["controller-validation"],
    status: "running",
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:10:00.000Z",
    ...overrides,
  };
}

function makeSubagent(overrides: Partial<GoalSubagentRecord> = {}): GoalSubagentRecord {
  return {
    goalId: "goal-1",
    nodeId: "n1",
    subagentId: "subagent-1",
    harnessAdapterId: "pi",
    status: "running",
    prompts: ["start"],
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:10:00.000Z",
    lastActivityAt: "2026-06-01T00:10:00.000Z",
    ...overrides,
  };
}

function ledgerEvent(overrides: Partial<GoalLedgerEvent> = {}): GoalLedgerEvent {
  return {
    sessionKey: "s1",
    goalId: "goal-1",
    type: "controller_event",
    at: "2026-06-01T00:00:00.000Z",
    details: {},
    ...overrides,
  };
}

test("buildNodeDurationSummary uses ledger lifecycle events for precise runtime and terminal age", () => {
  const now = new Date("2026-06-01T00:10:00.000Z");
  const node = makeNode({
    updatedAt: "2026-06-01T00:09:00.000Z",
    status: "failed",
  });
  const summary = buildNodeDurationSummary(
    node,
    [],
    [
      ledgerEvent({
        at: "2026-06-01T00:01:00.000Z",
        details: { event: "node.started", nodeId: "n1" },
      }),
      ledgerEvent({
        at: "2026-06-01T00:09:00.000Z",
        details: { event: "node.failed", nodeId: "n1" },
      }),
    ],
    now,
  );

  assert.equal(summary.confidence, "exact");
  assert.equal(summary.totalLabel, "runtime 8m");
  assert.equal(summary.statusLabel, "terminal 1m ago");
  assert.equal(summary.phaseLabel, "completed 1m ago");
});

test("buildNodeDurationSummary falls back to createdAt when no start event is present", () => {
  const now = new Date("2026-06-01T00:10:00.000Z");
  const node = makeNode({
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:09:59.000Z",
    status: "running",
  });
  const summary = buildNodeDurationSummary(node, [], [], now);

  assert.equal(summary.confidence, "fallback");
  assert.equal(summary.totalLabel, "age 10m");
  assert.equal(summary.phaseLabel, "phase running · updated 1s ago");
});

test("buildNodeDurationSummary uses phase-enter events for phase age and otherwise falls back", () => {
  const now = new Date("2026-06-01T00:10:00.000Z");
  const started = makeNode({
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:09:30.000Z",
    status: "running",
  });

  const withPhaseEvent = buildNodeDurationSummary(
    started,
    [],
    [
      ledgerEvent({
        at: "2026-06-01T00:01:00.000Z",
        details: { event: "node.started", nodeId: "n1" },
      }),
      ledgerEvent({
        at: "2026-06-01T00:07:00.000Z",
        details: { event: "validation.started", nodeId: "n1" },
      }),
    ],
    now,
  );
  assert.equal(withPhaseEvent.phaseLabel, "phase validating for 3m");

  const withoutPhaseEvent = buildNodeDurationSummary(started, [], [
    ledgerEvent({ at: "2026-06-01T00:01:00.000Z", details: { event: "node.started", nodeId: "n1" } }),
  ], now);
  assert.equal(withoutPhaseEvent.phaseLabel, "phase running · updated 30s ago");
});

test("node runtime is stable when updatedAt churns", () => {
  const now = new Date("2026-06-01T00:10:00.000Z");
  const started = makeNode({
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:09:30.000Z",
    status: "running",
  });
  const events = [
    ledgerEvent({
      at: "2026-06-01T00:01:00.000Z",
      details: { event: "node.started", nodeId: "n1" },
    }),
  ];

  const summaryA = buildNodeDurationSummary(started, [], events, now);
  const summaryB = buildNodeDurationSummary({
    ...started,
    updatedAt: "2026-06-01T00:07:00.000Z",
  }, [], events, now);

  assert.equal(summaryA.totalLabel, summaryB.totalLabel);
  assert.notEqual(summaryA.lastLabel, summaryB.lastLabel);
});

test("buildRunnerDurationSummary uses status and integration timestamps when available", () => {
  const now = new Date("2026-06-01T00:10:00.000Z");
  const runner = makeSubagent({
    status: "running",
    integrationState: "pending",
    lastActivityAt: "2026-06-01T00:09:00.000Z",
  });
  const summary = buildRunnerDurationSummary(
    runner,
    [
      ledgerEvent({
        at: "2026-06-01T00:03:00.000Z",
        details: { event: "subagent.started", subagentId: "subagent-1" },
      }),
      ledgerEvent({
        at: "2026-06-01T00:06:00.000Z",
        details: { event: "integration.started", subagentId: "subagent-1" },
      }),
    ],
    now,
  );

  assert.equal(summary.confidence, "exact");
  assert.equal(summary.attemptRuntimeLabel, "attempt 10m");
  assert.equal(summary.statusAgeLabel, "running for 7m");
  assert.equal(summary.integrationAgeLabel, "pending for 4m");
});

test("runner attempt runtime is stable when subagent updatedAt churns", () => {
  const now = new Date("2026-06-01T00:10:00.000Z");
  const runner = makeSubagent({
    status: "running",
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:09:00.000Z",
    lastActivityAt: "2026-06-01T00:09:00.000Z",
  });

  const summaryA = buildRunnerDurationSummary(
    runner,
    [
      ledgerEvent({
        at: "2026-06-01T00:03:00.000Z",
        details: { event: "subagent.started", subagentId: "subagent-1" },
      }),
    ],
    now,
  );
  const summaryB = buildRunnerDurationSummary(
    {
      ...runner,
      updatedAt: "2026-06-01T00:03:00.000Z",
      lastActivityAt: "2026-06-01T00:03:00.000Z",
    },
    [
      ledgerEvent({
        at: "2026-06-01T00:03:00.000Z",
        details: { event: "subagent.started", subagentId: "subagent-1" },
      }),
    ],
    now,
  );

  assert.equal(summaryA.attemptRuntimeLabel, summaryB.attemptRuntimeLabel);
  assert.notEqual(summaryA.lastActivityLabel, summaryB.lastActivityLabel);
});

test("buildRunnerDurationSummary falls back to createdAt and records terminal runtime", () => {
  const now = new Date("2026-06-01T00:10:00.000Z");
  const withoutEvidence = buildRunnerDurationSummary(
    makeSubagent({
      updatedAt: "2026-06-01T00:09:59.000Z",
      lastActivityAt: "2026-06-01T00:09:59.000Z",
      status: "running",
    }),
    [],
    now,
  );

  assert.equal(withoutEvidence.attemptRuntimeLabel, "attempt 10m");
  assert.equal(withoutEvidence.statusAgeLabel, "running · updated 1s ago");

  const withTerminal = buildRunnerDurationSummary(
    makeSubagent({
      status: "failed",
      lastActivityAt: "2026-06-01T00:09:00.000Z",
    }),
    [
      ledgerEvent({
        at: "2026-06-01T00:02:00.000Z",
        details: { event: "subagent.started", subagentId: "subagent-1" },
      }),
      ledgerEvent({
        at: "2026-06-01T00:08:00.000Z",
        details: { event: "subagent.failed", subagentId: "subagent-1" },
      }),
    ],
    now,
  );

  assert.equal(withTerminal.confidence, "ledger-derived");
  assert.equal(withTerminal.attemptRuntimeLabel, "attempt 8m");
  assert.equal(withTerminal.statusAgeLabel, "failed for 2m");
});
