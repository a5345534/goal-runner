import test from "node:test";
import assert from "node:assert/strict";
import {
  isAuditDue,
  buildControllerAuditSnapshot,
  validateControllerAuditDecision,
  applyAuditActions,
  recordAuditActionEvents,
  formatAuditSummary,
  DEFAULT_AUDIT_INTERVAL_MS,
  DEFAULT_MAX_RECENT_EVENTS,
  DEFAULT_MAX_RECENT_VALIDATION_RESULTS,
  GOAL_CONTROLLER_AUDIT_LEDGER_EVENT_TYPES,
  type GoalControllerAuditOptions,
  type GoalControllerAuditDecision,
  type AuditActionPolicyResult,
  type AuditEventRecorder,
} from "../core/controller-audit.js";
import type {
  GoalOrchestrationState,
  GoalRecord,
  GoalLedgerEvent,
  GoalDagNode,
  GoalSubagentRecord,
} from "../core/types.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const now = "2026-06-15T12:00:00.000Z";

function defaultOptions(
  overrides: Partial<GoalControllerAuditOptions> = {},
): GoalControllerAuditOptions {
  return {
    enabled: true,
    intervalMs: DEFAULT_AUDIT_INTERVAL_MS,
    maxRecentEvents: DEFAULT_MAX_RECENT_EVENTS,
    maxRecentValidationResults: DEFAULT_MAX_RECENT_VALIDATION_RESULTS,
    pauseOnCritical: true,
    includeTranscriptExcerpts: false,
    ...overrides,
  };
}

function makeGoal(overrides: Partial<GoalRecord> = {}): GoalRecord {
  return {
    sessionKey: "ses_audit",
    goalId: "goal-audit-1",
    objective: "audit test goal",
    status: "active",
    tokensUsed: 5000,
    timeUsedSeconds: 600,
    createdAt: "2026-06-15T11:30:00.000Z",
    updatedAt: "2026-06-15T11:55:00.000Z",
    goalTurnsSinceAuditReset: 0,
    ...overrides,
  };
}

function makeNode(overrides: Partial<GoalDagNode> = {}): GoalDagNode {
  return {
    goalId: "goal-audit-1",
    nodeId: overrides.nodeId ?? "node-1",
    slug: "build-feature",
    objective: "Build the feature",
    dependencyNodeIds: [],
    expectedOutputs: [],
    validators: [],
    completionGates: [],
    status: "running",
    lifecyclePhase: "runnerActive",
    lastValidationSummary: "All checks passed",
    createdAt: "2026-06-15T11:31:00.000Z",
    updatedAt: "2026-06-15T11:55:00.000Z",
    ...overrides,
  };
}

function makeSubagent(overrides: Partial<GoalSubagentRecord> = {}): GoalSubagentRecord {
  return {
    goalId: "goal-audit-1",
    nodeId: overrides.nodeId ?? "node-1",
    subagentId: overrides.subagentId ?? "subagent-1",
    harnessAdapterId: "opencode",
    sessionId: "session-1",
    status: "running",
    prompts: ["initial prompt"],
    retryCount: 0,
    lastActivityAt: "2026-06-15T11:54:00.000Z",
    lastAdapterObservation: { adapterId: "opencode", kind: "running", at: "2026-06-15T11:54:00.000Z" },
    integrationState: "pending",
    createdAt: "2026-06-15T11:31:00.000Z",
    updatedAt: "2026-06-15T11:55:00.000Z",
    ...overrides,
  };
}

function makeEvent(
  overrides: Partial<GoalLedgerEvent> = {},
): GoalLedgerEvent {
  return {
    eventId: overrides.eventId ?? `event-${Date.now()}`,
    sessionKey: "ses_audit",
    goalId: "goal-audit-1",
    type: "controller_event",
    at: "2026-06-15T11:55:00.000Z",
    details: { event: "node.complete", nodeId: "node-1" },
    ...overrides,
  };
}

function makeState(overrides: {
  nodes?: GoalDagNode[];
  subagents?: GoalSubagentRecord[];
} = {}): GoalOrchestrationState {
  return {
    goalId: "goal-audit-1",
    nodes: overrides.nodes ?? [makeNode()],
    subagents: overrides.subagents ?? [makeSubagent()],
  };
}

function makeValidDecision(
  overrides: Partial<GoalControllerAuditDecision> = {},
): GoalControllerAuditDecision {
  return {
    risk: "low",
    summary: "Everything looks healthy.",
    findings: [
      {
        kind: "no-progress",
        nodeId: "node-1",
        evidence: ["No new progress in the last 10 minutes"],
        confidence: "low",
      },
    ],
    recommendedActions: [
      {
        action: "noop",
        reason: "No concerning patterns detected.",
        requiresUserApproval: false,
      },
    ],
    ...overrides,
  };
}

/**
 * Builds a critical retry-loop decision matching the audit spec scenario:
 * risk=critical, finding with kind=retry-loop, confidence=high, action=pause-goal.
 */
function makeCriticalRetryLoopDecision(): GoalControllerAuditDecision {
  return makeValidDecision({
    risk: "critical",
    summary:
      "Node node-1 is stuck in a retry loop: 5 retries in 10 minutes with no progress.",
    findings: [
      {
        kind: "retry-loop",
        nodeId: "node-1",
        evidence: [
          "5 retries detected in the last 10 minutes",
          "No node progress between retries",
        ],
        confidence: "high",
      },
    ],
    recommendedActions: [
      {
        action: "pause-goal",
        nodeId: "node-1",
        reason: "Stop token/cost bleed from retry loop.",
        requiresUserApproval: false,
      },
    ],
  });
}

/**
 * Builds a critical cost-spike decision matching the audit spec scenario.
 */
function makeCriticalCostSpikeDecision(): GoalControllerAuditDecision {
  return makeValidDecision({
    risk: "critical",
    summary: "Token cost spiked 5x compared to the previous window.",
    findings: [
      {
        kind: "cost-spike",
        evidence: [
          "Token usage jumped from 10K to 50K in the last window",
          "Estimated cost increased from $0.10 to $0.50",
        ],
        confidence: "high",
      },
    ],
    recommendedActions: [
      {
        action: "pause-goal",
        reason: "Token cost spike detected; pause to prevent budget drain.",
        requiresUserApproval: false,
      },
    ],
  });
}

/**
 * Builds a healthy-progress (noop) decision.
 */
function makeHealthyNoopDecision(): GoalControllerAuditDecision {
  return makeValidDecision({
    risk: "low",
    summary: "Steady progress: 2 nodes completed in the last window.",
    findings: [
      {
        kind: "unknown",
        evidence: ["Steady node completion rate"],
        confidence: "low",
      },
    ],
    recommendedActions: [
      {
        action: "noop",
        reason: "No concerning patterns detected.",
        requiresUserApproval: false,
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// 1. isAuditDue – scheduling tests
// ---------------------------------------------------------------------------

test("isAuditDue returns false when audit is disabled", () => {
  const opts = defaultOptions({ enabled: false });
  assert.equal(isAuditDue(opts, undefined, new Date(now)), false);
  assert.equal(
    isAuditDue(opts, "2026-06-15T11:00:00.000Z", new Date(now)),
    false,
  );
});

test("isAuditDue returns true when enabled and no previous audit has run", () => {
  const opts = defaultOptions({ enabled: true });
  assert.equal(isAuditDue(opts, undefined, new Date(now)), true);
  assert.equal(isAuditDue(opts, null as unknown as string, new Date(now)), true);
});

test("isAuditDue returns true when the interval has elapsed", () => {
  const opts = defaultOptions({ intervalMs: 60_000 }); // 1 minute
  // Last audit was 2 minutes ago
  assert.equal(
    isAuditDue(opts, "2026-06-15T11:58:00.000Z", new Date(now)),
    true,
  );
});

test("isAuditDue returns false when the interval has not elapsed", () => {
  const opts = defaultOptions({ intervalMs: 60_000 }); // 1 minute
  // Last audit was 10 seconds ago
  assert.equal(
    isAuditDue(opts, "2026-06-15T11:59:50.000Z", new Date(now)),
    false,
  );
});

test("isAuditDue returns true exactly at the interval boundary", () => {
  const opts = defaultOptions({ intervalMs: 60_000 });
  // Last audit exactly 1 minute ago
  assert.equal(
    isAuditDue(opts, "2026-06-15T11:59:00.000Z", new Date(now)),
    true,
  );
});

test("isAuditDue handles Date object for lastAuditAt", () => {
  const opts = defaultOptions({ intervalMs: 60_000 });
  // 2 minutes ago via Date object
  assert.equal(
    isAuditDue(
      opts,
      new Date("2026-06-15T11:58:00.000Z"),
      new Date(now),
    ),
    true,
  );
});

test("isAuditDue returns true when lastAuditAt is an invalid date string", () => {
  const opts = defaultOptions({ intervalMs: 60_000 });
  assert.equal(
    isAuditDue(opts, "not-a-date", new Date(now)),
    true,
  );
});

test("isAuditDue respects the default interval when intervalMs is not set", () => {
  const opts = defaultOptions({ intervalMs: undefined });
  // Last audit just now, so interval has not elapsed
  assert.equal(
    isAuditDue(opts, now, new Date(now)),
    false,
  );
  // With default 30-minute interval, an audit 31 minutes ago is due
  const nowDate = new Date(now);
  const thirtyOneMinAgo = new Date(nowDate.getTime() - 31 * 60_000);
  assert.equal(
    isAuditDue(opts, thirtyOneMinAgo, nowDate),
    true,
  );
});

test("isAuditDue uses current time when now is not provided", () => {
  const opts = defaultOptions({ enabled: true, intervalMs: 60_000 });
  // With no last audit and no explicit now, should return true
  assert.equal(isAuditDue(opts, undefined), true);
});

// ---------------------------------------------------------------------------
// 2. buildControllerAuditSnapshot – bounded output without transcripts
// ---------------------------------------------------------------------------

test("buildControllerAuditSnapshot includes goal summary fields", () => {
  const goal = makeGoal({
    tokensUsed: 12345,
    status: "active",
  });
  const snapshot = buildControllerAuditSnapshot({
    state: makeState(),
    goal,
    recentEvents: [],
    options: defaultOptions(),
  });

  assert.equal(snapshot.goal.goalId, "goal-audit-1");
  assert.equal(snapshot.goal.status, "active");
  assert.equal(snapshot.goal.tokensUsed, 12345);
  assert.ok(typeof snapshot.goal.ageMinutes === "number");
  assert.equal(snapshot.goal.lastProgressAt, goal.updatedAt);
});

test("buildControllerAuditSnapshot includes node fields", () => {
  const node = makeNode({
    nodeId: "node-1",
    status: "running",
    lifecyclePhase: "runnerActive",
    lastValidationSummary: "OK",
  });
  const snapshot = buildControllerAuditSnapshot({
    state: makeState({ nodes: [node] }),
    goal: makeGoal(),
    recentEvents: [],
    options: defaultOptions(),
  });

  assert.equal(snapshot.nodes.length, 1);
  assert.equal(snapshot.nodes[0].nodeId, "node-1");
  assert.equal(snapshot.nodes[0].status, "running");
  assert.equal(snapshot.nodes[0].lifecyclePhase, "runnerActive");
  assert.equal(snapshot.nodes[0].lastValidationSummary, "OK");
  assert.equal(snapshot.nodes[0].lastUpdatedAt, node.updatedAt);
});

test("buildControllerAuditSnapshot picks latest subagent retry count per node", () => {
  const node1 = makeNode({ nodeId: "node-1" });
  const sub1 = makeSubagent({
    subagentId: "sub-1",
    nodeId: "node-1",
    retryCount: 1,
    createdAt: "2026-06-15T11:31:00.000Z",
  });
  const sub2 = makeSubagent({
    subagentId: "sub-2",
    nodeId: "node-1",
    retryCount: 3,
    createdAt: "2026-06-15T11:45:00.000Z",
  });
  const snapshot = buildControllerAuditSnapshot({
    state: makeState({ nodes: [node1], subagents: [sub1, sub2] }),
    goal: makeGoal(),
    recentEvents: [],
    options: defaultOptions(),
  });

  assert.equal(snapshot.nodes.length, 1);
  // The latest subagent (by createdAt) should set the retry count
  assert.equal(snapshot.nodes[0].retryCount, 3);
});

test("buildControllerAuditSnapshot includes subagent fields", () => {
  const sub = makeSubagent({
    subagentId: "sub-1",
    nodeId: "node-1",
    status: "running",
    retryCount: 2,
    lastActivityAt: "2026-06-15T11:54:00.000Z",
    lastAdapterObservation: {
      adapterId: "opencode",
      kind: "running",
      at: "2026-06-15T11:54:00.000Z",
    },
    integrationState: "pending",
  });
  const snapshot = buildControllerAuditSnapshot({
    state: makeState({ subagents: [sub] }),
    goal: makeGoal(),
    recentEvents: [],
    options: defaultOptions(),
  });

  assert.equal(snapshot.subagents.length, 1);
  assert.equal(snapshot.subagents[0].subagentId, "sub-1");
  assert.equal(snapshot.subagents[0].nodeId, "node-1");
  assert.equal(snapshot.subagents[0].status, "running");
  assert.equal(snapshot.subagents[0].retryCount, 2);
  assert.equal(snapshot.subagents[0].lastActivityAt, "2026-06-15T11:54:00.000Z");
  assert.equal(snapshot.subagents[0].lastAdapterObservation, "running");
  assert.equal(snapshot.subagents[0].integrationState, "pending");
});

test("buildControllerAuditSnapshot default snapshot does NOT include transcripts", () => {
  const snapshot = buildControllerAuditSnapshot({
    state: makeState(),
    goal: makeGoal(),
    recentEvents: [],
    options: defaultOptions({ includeTranscriptExcerpts: false }),
  });

  // The snapshot shape does not have a transcripts field
  assert.ok(!("transcripts" in snapshot));
  assert.ok(!("transcriptExcerpts" in snapshot));
});

test("buildControllerAuditSnapshot respects maxRecentEvents", () => {
  const events: GoalLedgerEvent[] = [];
  for (let i = 0; i < 10; i++) {
    events.push(
      makeEvent({
        eventId: `e${i}`,
        type: "controller_event",
        at: `2026-06-15T11:5${i}:00.000Z`,
        details: { event: "node.complete", nodeId: `node-${i}` },
      }),
    );
  }
  const snapshot = buildControllerAuditSnapshot({
    state: makeState(),
    goal: makeGoal(),
    recentEvents: events,
    options: defaultOptions({ maxRecentEvents: 5 }),
  });

  assert.ok(snapshot.recentControllerEvents.length <= 5);
  // Should keep the most recent events
  assert.equal(
    snapshot.recentControllerEvents[snapshot.recentControllerEvents.length - 1]
      .type,
    "node.complete",
  );
});

test("buildControllerAuditSnapshot respects maxRecentValidationResults", () => {
  const nodes: GoalDagNode[] = [];
  for (let i = 0; i < 10; i++) {
    nodes.push(
      makeNode({
        nodeId: `node-${i}`,
        lastValidationSummary: `Summary ${i}`,
      }),
    );
  }
  const snapshot = buildControllerAuditSnapshot({
    state: makeState({ nodes }),
    goal: makeGoal(),
    recentEvents: [],
    options: defaultOptions({ maxRecentValidationResults: 3 }),
  });

  assert.ok(snapshot.recentValidationSummaries.length <= 3);
});

test("buildControllerAuditSnapshot only includes controller_event typed events", () => {
  const events = [
    makeEvent({
      type: "controller_event",
      details: { event: "node.complete", nodeId: "node-1" },
    }),
    makeEvent({
      type: "turn_started",
      details: {},
    }),
    makeEvent({
      type: "goal_created",
      details: {},
    }),
  ];
  const snapshot = buildControllerAuditSnapshot({
    state: makeState(),
    goal: makeGoal(),
    recentEvents: events,
    options: defaultOptions(),
  });

  // Only controller_event entries appear in the snapshot
  const types = snapshot.recentControllerEvents.map((e) => e.type);
  assert.ok(types.includes("node.complete"));
  assert.ok(!types.includes("turn_started"));
  assert.ok(!types.includes("goal_created"));
});

test("buildControllerAuditSnapshot progressSignals counts completed nodes", () => {
  const events: GoalLedgerEvent[] = [
    makeEvent({
      type: "controller_event",
      details: { event: "node.complete", nodeId: "node-1" },
    }),
    makeEvent({
      type: "controller_event",
      details: { event: "node.complete", nodeId: "node-2" },
    }),
    makeEvent({
      type: "controller_event",
      details: { event: "validation.failed", nodeId: "node-3" },
    }),
  ];
  const snapshot = buildControllerAuditSnapshot({
    state: makeState(),
    goal: makeGoal(),
    recentEvents: events,
    options: defaultOptions(),
  });

  assert.equal(snapshot.progressSignals.completedNodesLastWindow, 2);
  assert.equal(snapshot.progressSignals.validationFailuresLastWindow, 1);
});

test("buildControllerAuditSnapshot progressSignals counts retries and followups", () => {
  const events: GoalLedgerEvent[] = [
    makeEvent({
      type: "continuation_retryable_failure",
      details: {},
    }),
    makeEvent({
      type: "continuation_retryable_failure",
      details: {},
    }),
    makeEvent({
      type: "controller_event",
      details: { event: "recovery.decision", nodeId: "node-1" },
    }),
    makeEvent({
      type: "controller_event",
      details: { event: "followup.required", nodeId: "node-2" },
    }),
  ];
  const snapshot = buildControllerAuditSnapshot({
    state: makeState(),
    goal: makeGoal(),
    recentEvents: events,
    options: defaultOptions(),
  });

  // retriesLastWindow counts continuation_retryable_failure + recovery.* events
  assert.equal(snapshot.progressSignals.retriesLastWindow, 3);
  // followupsLastWindow counts events starting with "followup."
  assert.equal(snapshot.progressSignals.followupsLastWindow, 1);
});

test("buildControllerAuditSnapshot progressSignals counts integration failures", () => {
  const events: GoalLedgerEvent[] = [
    makeEvent({
      type: "controller_event",
      details: { event: "integration.failed", nodeId: "node-1" },
    }),
    makeEvent({
      type: "controller_event",
      details: { event: "integration.result", nodeId: "node-2" },
    }),
  ];
  const snapshot = buildControllerAuditSnapshot({
    state: makeState({ subagents: [] }),
    goal: makeGoal(),
    recentEvents: events,
    options: defaultOptions(),
  });

  assert.equal(
    snapshot.progressSignals.integrationsFailedLastWindow,
    2,
  );
});

test("buildControllerAuditSnapshot costSignals aggregates token data from turn_finished events", () => {
  const events: GoalLedgerEvent[] = [
    makeEvent({
      type: "turn_finished",
      details: { tokensUsedDelta: 1500 },
    }),
    makeEvent({
      type: "turn_finished",
      details: { tokensUsedDelta: 2500 },
    }),
    makeEvent({
      type: "turn_finished",
      // no tokensUsedDelta detail
      details: { other: true },
    }),
  ];
  const snapshot = buildControllerAuditSnapshot({
    state: makeState(),
    goal: makeGoal(),
    recentEvents: events,
    options: defaultOptions(),
  });

  assert.ok(snapshot.costSignals);
  assert.equal(snapshot.costSignals!.tokensLastWindow, 4000);
  // estimatedCostLastWindow = (4000 / 1000) * 0.01 = 0.04
  assert.equal(snapshot.costSignals!.estimatedCostLastWindow, 0.04);
});

test("buildControllerAuditSnapshot costSignals is undefined when no turn_finished events have token data", () => {
  const snapshot = buildControllerAuditSnapshot({
    state: makeState(),
    goal: makeGoal(),
    recentEvents: [],
    options: defaultOptions(),
  });
  assert.equal(snapshot.costSignals, undefined);
});

test("buildControllerAuditSnapshot handles empty state gracefully", () => {
  const snapshot = buildControllerAuditSnapshot({
    state: { goalId: "goal-audit-1", nodes: [], subagents: [] },
    goal: makeGoal(),
    recentEvents: [],
    options: defaultOptions(),
  });

  assert.equal(snapshot.nodes.length, 0);
  assert.equal(snapshot.subagents.length, 0);
  assert.equal(snapshot.recentControllerEvents.length, 0);
  assert.equal(snapshot.recentValidationSummaries.length, 0);
  assert.equal(snapshot.progressSignals.completedNodesLastWindow, 0);
  assert.equal(snapshot.progressSignals.retriesLastWindow, 0);
});

test("buildControllerAuditSnapshot validation summaries sort by count descending", () => {
  const events: GoalLedgerEvent[] = [
    makeEvent({
      type: "controller_event",
      details: { event: "validation.passed", nodeId: "node-a" },
    }),
    makeEvent({
      type: "controller_event",
      details: { event: "validation.passed", nodeId: "node-a" },
    }),
    makeEvent({
      type: "controller_event",
      details: { event: "validation.passed", nodeId: "node-a" },
    }),
    makeEvent({
      type: "controller_event",
      details: { event: "validation.passed", nodeId: "node-b" },
    }),
  ];
  const nodes: GoalDagNode[] = [
    makeNode({ nodeId: "node-a", lastValidationSummary: "A summary" }),
    makeNode({ nodeId: "node-b", lastValidationSummary: "B summary" }),
  ];
  const snapshot = buildControllerAuditSnapshot({
    state: makeState({ nodes }),
    goal: makeGoal(),
    recentEvents: events,
    options: defaultOptions(),
  });

  assert.equal(snapshot.recentValidationSummaries.length, 2);
  // node-a should come first with count 3, then node-b with count 1
  assert.equal(snapshot.recentValidationSummaries[0].nodeId, "node-a");
  assert.equal(snapshot.recentValidationSummaries[0].countInWindow, 3);
  assert.equal(snapshot.recentValidationSummaries[1].nodeId, "node-b");
  assert.equal(snapshot.recentValidationSummaries[1].countInWindow, 1);
});

test("buildControllerAuditSnapshot integration failure fallback counts subagents with failed integration", () => {
  // No integration events in the window, but subagents with failed integration
  const subagents = [
    makeSubagent({ subagentId: "sub-1", nodeId: "node-1", integrationState: "failed" }),
    makeSubagent({ subagentId: "sub-2", nodeId: "node-2", integrationState: "failed" }),
    makeSubagent({ subagentId: "sub-3", nodeId: "node-3", integrationState: "complete" }),
  ];
  const snapshot = buildControllerAuditSnapshot({
    state: makeState({ subagents }),
    goal: makeGoal(),
    recentEvents: [],
    options: defaultOptions(),
  });

  assert.equal(snapshot.progressSignals.integrationsFailedLastWindow, 2);
});

// ---------------------------------------------------------------------------
// 3. validateControllerAuditDecision – valid & invalid JSON
// ---------------------------------------------------------------------------

test("validateControllerAuditDecision accepts a valid minimal decision", () => {
  const decision = makeValidDecision();
  const result = validateControllerAuditDecision(decision);
  assert.equal(result.valid, true);
  if (result.valid) {
    assert.equal(result.decision.risk, "low");
    assert.equal(result.decision.summary, "Everything looks healthy.");
    assert.equal(result.decision.findings.length, 1);
    assert.equal(result.decision.recommendedActions.length, 1);
  }
});

test("validateControllerAuditDecision accepts a decision with all valid risk levels", () => {
  for (const risk of ["low", "medium", "high", "critical"] as const) {
    const result = validateControllerAuditDecision(
      makeValidDecision({ risk }),
    );
    assert.equal(result.valid, true, `should accept risk=${risk}`);
  }
});

test("validateControllerAuditDecision accepts a decision with all valid finding kinds", () => {
  const kinds = [
    "retry-loop",
    "no-progress",
    "invalid-contract-suspected",
    "cost-spike",
    "stale-runner",
    "repeated-validation-failure",
    "integration-loop",
    "provider-or-quota-issue",
    "unknown",
  ] as const;
  for (const kind of kinds) {
    const decision = makeValidDecision({
      findings: [
        {
          kind,
          evidence: ["test"],
          confidence: "medium",
        },
      ],
    });
    const result = validateControllerAuditDecision(decision);
    assert.equal(
      result.valid,
      true,
      `should accept finding kind=${kind}`,
    );
  }
});

test("validateControllerAuditDecision accepts a decision with all valid action types", () => {
  const actions = [
    "noop",
    "pause-goal",
    "cap-retries",
    "stop-launching-new-subagents",
    "reduce-concurrency",
    "request-user-intervention",
    "open-diagnostic-report",
    "run-deterministic-contract-check",
    "mark-node-blocked",
  ] as const;
  for (const action of actions) {
    const decision = makeValidDecision({
      recommendedActions: [
        {
          action,
          reason: "test reason",
          requiresUserApproval: action !== "noop",
        },
      ],
    });
    const result = validateControllerAuditDecision(decision);
    assert.equal(
      result.valid,
      true,
      `should accept action=${action}`,
    );
  }
});

test("validateControllerAuditDecision accepts a decision with multiple findings and actions", () => {
  const decision: GoalControllerAuditDecision = {
    risk: "critical",
    summary: "Multiple issues detected.",
    findings: [
      {
        kind: "retry-loop",
        nodeId: "node-1",
        evidence: ["5 retries"],
        confidence: "high",
      },
      {
        kind: "cost-spike",
        nodeId: "node-2",
        subagentId: "sub-2",
        evidence: ["Token spike 5x"],
        confidence: "medium",
      },
    ],
    recommendedActions: [
      {
        action: "pause-goal",
        nodeId: "node-1",
        reason: "Stop retry loop.",
        requiresUserApproval: false,
      },
      {
        action: "reduce-concurrency",
        reason: "Reduce cost.",
        requiresUserApproval: true,
      },
    ],
  };
  const result = validateControllerAuditDecision(decision);
  assert.equal(result.valid, true);
});

test("validateControllerAuditDecision rejects null", () => {
  const result = validateControllerAuditDecision(null);
  assert.equal(result.valid, false);
  if (!result.valid) {
    assert.ok(result.errors.some((e) => e.includes("null or undefined")));
  }
});

test("validateControllerAuditDecision rejects undefined", () => {
  const result = validateControllerAuditDecision(undefined);
  assert.equal(result.valid, false);
  if (!result.valid) {
    assert.ok(result.errors.some((e) => e.includes("null or undefined")));
  }
});

test("validateControllerAuditDecision rejects non-object", () => {
  const result = validateControllerAuditDecision("just a string");
  assert.equal(result.valid, false);
  if (!result.valid) {
    assert.ok(result.errors.some((e) => e.includes("not an object")));
  }
});

test("validateControllerAuditDecision rejects invalid risk value", () => {
  const decision = makeValidDecision({ risk: "super-bad" as any });
  const result = validateControllerAuditDecision(decision);
  assert.equal(result.valid, false);
  if (!result.valid) {
    assert.ok(result.errors.some((e) => e.includes("risk must be one of")));
  }
});

test("validateControllerAuditDecision rejects missing risk", () => {
  const decision = { summary: "ok", findings: [], recommendedActions: [] };
  const result = validateControllerAuditDecision(decision);
  assert.equal(result.valid, false);
  if (!result.valid) {
    assert.ok(result.errors.some((e) => e.includes("risk must be one of")));
  }
});

test("validateControllerAuditDecision rejects missing summary", () => {
  const decision = makeValidDecision({ summary: "" });
  const result = validateControllerAuditDecision(decision);
  assert.equal(result.valid, false);
  if (!result.valid) {
    assert.ok(
      result.errors.some((e) => e.includes("summary must be a non-empty")),
    );
  }
});

test("validateControllerAuditDecision rejects non-string summary", () => {
  const decision = { risk: "low", summary: 42, findings: [], recommendedActions: [] };
  const result = validateControllerAuditDecision(decision);
  assert.equal(result.valid, false);
  if (!result.valid) {
    assert.ok(
      result.errors.some((e) => e.includes("summary must be a non-empty")),
    );
  }
});

test("validateControllerAuditDecision rejects findings not an array", () => {
  const decision = {
    risk: "low",
    summary: "ok",
    findings: "not-array",
    recommendedActions: [],
  };
  const result = validateControllerAuditDecision(decision);
  assert.equal(result.valid, false);
  if (!result.valid) {
    assert.ok(
      result.errors.some((e) => e.includes("findings must be an array")),
    );
  }
});

test("validateControllerAuditDecision rejects invalid finding kind", () => {
  const decision = makeValidDecision({
    findings: [{ kind: "invented-kind" as any, evidence: [], confidence: "low" }],
  });
  const result = validateControllerAuditDecision(decision);
  assert.equal(result.valid, false);
  if (!result.valid) {
    assert.ok(
      result.errors.some((e) => e.includes("findings[0].kind must be one of")),
    );
  }
});

test("validateControllerAuditDecision rejects invalid finding confidence", () => {
  const decision = makeValidDecision({
    findings: [{ kind: "no-progress", evidence: [], confidence: "unknown" as any }],
  });
  const result = validateControllerAuditDecision(decision);
  assert.equal(result.valid, false);
  if (!result.valid) {
    assert.ok(
      result.errors.some((e) =>
        e.includes("findings[0].confidence must be one of"),
      ),
    );
  }
});

test("validateControllerAuditDecision rejects finding with non-array evidence", () => {
  const decision = makeValidDecision({
    findings: [
      {
        kind: "no-progress",
        evidence: "not-array" as any,
        confidence: "low",
      },
    ],
  });
  const result = validateControllerAuditDecision(decision);
  assert.equal(result.valid, false);
  if (!result.valid) {
    assert.ok(
      result.errors.some((e) => e.includes("findings[0].evidence must be an array")),
    );
  }
});

test("validateControllerAuditDecision rejects evidence entries that are not strings", () => {
  const decision = makeValidDecision({
    findings: [
      {
        kind: "no-progress",
        evidence: [123 as any],
        confidence: "low",
      },
    ],
  });
  const result = validateControllerAuditDecision(decision);
  assert.equal(result.valid, false);
  if (!result.valid) {
    assert.ok(
      result.errors.some((e) =>
        e.includes("findings[0].evidence entries must be strings"),
      ),
    );
  }
});

test("validateControllerAuditDecision rejects incorrect nodeId type in finding", () => {
  const decision = makeValidDecision({
    findings: [
      {
        kind: "no-progress",
        evidence: [],
        confidence: "low",
        nodeId: 42 as any,
      },
    ],
  });
  const result = validateControllerAuditDecision(decision);
  assert.equal(result.valid, false);
  if (!result.valid) {
    assert.ok(
      result.errors.some((e) =>
        e.includes("findings[0].nodeId must be a string"),
      ),
    );
  }
});

test("validateControllerAuditDecision rejects incorrect subagentId type in finding", () => {
  const decision = makeValidDecision({
    findings: [
      {
        kind: "no-progress",
        evidence: [],
        confidence: "low",
        subagentId: true as any,
      },
    ],
  });
  const result = validateControllerAuditDecision(decision);
  assert.equal(result.valid, false);
  if (!result.valid) {
    assert.ok(
      result.errors.some((e) =>
        e.includes("findings[0].subagentId must be a string"),
      ),
    );
  }
});

test("validateControllerAuditDecision rejects recommendedActions not an array", () => {
  const decision = {
    risk: "low",
    summary: "ok",
    findings: [],
    recommendedActions: "not-array",
  };
  const result = validateControllerAuditDecision(decision);
  assert.equal(result.valid, false);
  if (!result.valid) {
    assert.ok(
      result.errors.some((e) =>
        e.includes("recommendedActions must be an array"),
      ),
    );
  }
});

test("validateControllerAuditDecision rejects invalid action type", () => {
  const decision = makeValidDecision({
    recommendedActions: [
      {
        action: "complete-goal" as any,
        reason: "bad",
        requiresUserApproval: false,
      },
    ],
  });
  const result = validateControllerAuditDecision(decision);
  assert.equal(result.valid, false);
  if (!result.valid) {
    assert.ok(
      result.errors.some((e) =>
        e.includes("recommendedActions[0].action must be one of"),
      ),
    );
  }
});

test("validateControllerAuditDecision rejects missing reason in action", () => {
  const decision = makeValidDecision({
    recommendedActions: [
      {
        action: "noop",
        reason: "",
        requiresUserApproval: false,
      },
    ],
  });
  const result = validateControllerAuditDecision(decision);
  assert.equal(result.valid, false);
  if (!result.valid) {
    assert.ok(
      result.errors.some((e) =>
        e.includes("recommendedActions[0].reason must be a non-empty"),
      ),
    );
  }
});

test("validateControllerAuditDecision rejects missing requiresUserApproval", () => {
  const decision = makeValidDecision({
    recommendedActions: [
      {
        action: "noop",
        reason: "ok",
        requiresUserApproval: "yes" as any,
      },
    ],
  });
  const result = validateControllerAuditDecision(decision);
  assert.equal(result.valid, false);
  if (!result.valid) {
    assert.ok(
      result.errors.some((e) =>
        e.includes("recommendedActions[0].requiresUserApproval must be a boolean"),
      ),
    );
  }
});

test("validateControllerAuditDecision rejects incorrect nodeId type in action", () => {
  const decision = makeValidDecision({
    recommendedActions: [
      {
        action: "pause-goal",
        reason: "test",
        requiresUserApproval: false,
        nodeId: 99 as any,
      },
    ],
  });
  const result = validateControllerAuditDecision(decision);
  assert.equal(result.valid, false);
  if (!result.valid) {
    assert.ok(
      result.errors.some((e) =>
        e.includes("recommendedActions[0].nodeId must be a string"),
      ),
    );
  }
});

test("validateControllerAuditDecision rejects incorrect subagentId type in action", () => {
  const decision = makeValidDecision({
    recommendedActions: [
      {
        action: "noop",
        reason: "test",
        requiresUserApproval: false,
        subagentId: [] as any,
      },
    ],
  });
  const result = validateControllerAuditDecision(decision);
  assert.equal(result.valid, false);
  if (!result.valid) {
    assert.ok(
      result.errors.some((e) =>
        e.includes(
          "recommendedActions[0].subagentId must be a string",
        ),
      ),
    );
  }
});

test("validateControllerAuditDecision returns all errors for a deeply invalid object", () => {
  const decision = {
    risk: "unknown",
    // summary missing
    findings: [
      { kind: "bad-kind", confidence: "none", evidence: "not-array" },
    ],
    recommendedActions: [
      { action: "bad-action", reason: "", requiresUserApproval: "no" },
    ],
  };
  const result = validateControllerAuditDecision(decision);
  assert.equal(result.valid, false);
  if (!result.valid) {
    // Should have multiple errors from different validation passes
    assert.ok(result.errors.length >= 3, `got ${result.errors.length} errors: ${result.errors.join("; ")}`);
  }
});

test("validateControllerAuditDecision accepts finding with undefined optional fields", () => {
  const decision = makeValidDecision({
    findings: [
      {
        kind: "no-progress",
        evidence: [],
        confidence: "low",
        // nodeId and subagentId intentionally omitted
      },
    ],
  });
  const result = validateControllerAuditDecision(decision);
  assert.equal(result.valid, true);
});

test("validateControllerAuditDecision allows empty evidence array", () => {
  const decision = makeValidDecision({
    findings: [
      {
        kind: "unknown",
        evidence: [],
        confidence: "low",
      },
    ],
  });
  const result = validateControllerAuditDecision(decision);
  assert.equal(result.valid, true);
});

test("validateControllerAuditDecision accepts a finding that is null inside findings array", () => {
  // null items in the array are caught as "not an object"
  const decision = {
    risk: "low",
    summary: "ok",
    findings: [null],
    recommendedActions: [],
  };
  const result = validateControllerAuditDecision(decision);
  assert.equal(result.valid, false);
  if (!result.valid) {
    assert.ok(
      result.errors.some((e) => e.includes("findings[0] is not an object")),
    );
  }
});

// ---------------------------------------------------------------------------
// 4. applyAuditActions – pause-goal on critical+high, skip otherwise
// ---------------------------------------------------------------------------

test("applyAuditActions auto-pauses on critical risk + high confidence + pauseOnCritical enabled", () => {
  const decision = makeCriticalRetryLoopDecision();
  const result = applyAuditActions(decision, defaultOptions({ pauseOnCritical: true }));

  assert.equal(result.shouldPauseGoal, true);
  assert.ok(result.pauseReason?.includes("Controller audit"));
  assert.ok(result.pauseReason?.includes("critical"));
  assert.equal(result.applied.length, 1);
  assert.equal(result.applied[0].action.action, "pause-goal");
  assert.equal(result.applied[0].matchedFinding.kind, "retry-loop");
  assert.equal(result.applied[0].matchedFinding.confidence, "high");
  assert.equal(result.skipped.length, 0);
});

test("applyAuditActions auto-pauses on cost-spike critical+high", () => {
  const decision = makeCriticalCostSpikeDecision();
  const result = applyAuditActions(decision, defaultOptions({ pauseOnCritical: true }));

  assert.equal(result.shouldPauseGoal, true);
  assert.equal(result.applied.length, 1);
  assert.equal(result.applied[0].action.action, "pause-goal");
});

test("applyAuditActions does NOT pause on medium risk even with high confidence", () => {
  const decision = makeValidDecision({
    risk: "medium",
    findings: [
      {
        kind: "retry-loop",
        nodeId: "node-1",
        evidence: ["some retries"],
        confidence: "high",
      },
    ],
    recommendedActions: [
      {
        action: "pause-goal",
        reason: "Consider pausing.",
        requiresUserApproval: true,
      },
    ],
  });
  const result = applyAuditActions(decision, defaultOptions({ pauseOnCritical: true }));

  assert.equal(result.shouldPauseGoal, false);
  assert.equal(result.applied.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.ok(
    result.skipped[0].reason.includes('risk is "medium"'),
  );
});

test("applyAuditActions does NOT pause on critical risk with low confidence", () => {
  const decision = makeValidDecision({
    risk: "critical",
    findings: [
      {
        kind: "retry-loop",
        nodeId: "node-1",
        evidence: ["possible retries"],
        confidence: "low",
      },
    ],
    recommendedActions: [
      {
        action: "pause-goal",
        reason: "Check manually.",
        requiresUserApproval: true,
      },
    ],
  });
  const result = applyAuditActions(decision, defaultOptions({ pauseOnCritical: true }));

  assert.equal(result.shouldPauseGoal, false);
  assert.equal(result.applied.length, 0);
  assert.ok(result.skipped.length >= 1);
  assert.ok(
    result.skipped.some((s) => s.reason.includes("no finding has high confidence")),
  );
});

test("applyAuditActions does NOT pause when pauseOnCritical is disabled", () => {
  const decision = makeCriticalRetryLoopDecision();
  const result = applyAuditActions(decision, defaultOptions({ pauseOnCritical: false }));

  assert.equal(result.shouldPauseGoal, false);
  assert.equal(result.applied.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.ok(
    result.skipped[0].reason.includes("pauseOnCritical is disabled"),
  );
});

test("applyAuditActions skips non-pause actions (mark-node-blocked, cap-retries, etc.)", () => {
  const decision = makeValidDecision({
    risk: "critical",
    findings: [
      {
        kind: "retry-loop",
        nodeId: "node-1",
        evidence: ["5 retries"],
        confidence: "high",
      },
    ],
    recommendedActions: [
      {
        action: "pause-goal",
        nodeId: "node-1",
        reason: "Stop loop.",
        requiresUserApproval: false,
      },
      {
        action: "mark-node-blocked",
        nodeId: "node-1",
        reason: "Block the node.",
        requiresUserApproval: true,
      },
      {
        action: "cap-retries",
        nodeId: "node-1",
        reason: "Limit retries.",
        requiresUserApproval: true,
      },
      {
        action: "stop-launching-new-subagents",
        reason: "Prevent more work.",
        requiresUserApproval: true,
      },
    ],
  });
  const result = applyAuditActions(decision, defaultOptions({ pauseOnCritical: true }));

  assert.equal(result.shouldPauseGoal, true);
  assert.equal(result.applied.length, 1);
  assert.equal(result.applied[0].action.action, "pause-goal");
  // The three non-pause actions should all be skipped
  assert.equal(result.skipped.length, 3);
  const skippedActions = result.skipped.map((s) => s.action.action);
  assert.ok(skippedActions.includes("mark-node-blocked"));
  assert.ok(skippedActions.includes("cap-retries"));
  assert.ok(skippedActions.includes("stop-launching-new-subagents"));
  // Verify skip reasons mention deterministic confirmation
  for (const skip of result.skipped) {
    assert.ok(
      skip.reason.includes("deterministic confirmation"),
      `skip reason for ${skip.action.action}: ${skip.reason}`,
    );
  }
});

test("applyAuditActions neither applies nor skips noop actions", () => {
  const decision = makeHealthyNoopDecision();
  const result = applyAuditActions(decision, defaultOptions());

  assert.equal(result.shouldPauseGoal, false);
  assert.equal(result.applied.length, 0);
  assert.equal(result.skipped.length, 0);
});

test("applyAuditActions handles empty recommendedActions", () => {
  const decision = makeValidDecision({
    risk: "critical",
    findings: [{ kind: "unknown", evidence: [], confidence: "high" }],
    recommendedActions: [],
  });
  const result = applyAuditActions(decision, defaultOptions({ pauseOnCritical: true }));

  assert.equal(result.shouldPauseGoal, false);
  assert.equal(result.applied.length, 0);
  assert.equal(result.skipped.length, 0);
});

test("applyAuditActions defaults pauseOnCritical to true when omitted", () => {
  const decision = makeCriticalRetryLoopDecision();
  const result = applyAuditActions(decision, { enabled: true });
  // pauseOnCritical defaults to true
  assert.equal(result.shouldPauseGoal, true);
});

test("applyAuditActions handles multiple findings with mixed confidence", () => {
  const decision = makeValidDecision({
    risk: "critical",
    findings: [
      {
        kind: "no-progress",
        nodeId: "node-1",
        evidence: [],
        confidence: "low",
      },
      {
        kind: "retry-loop",
        nodeId: "node-2",
        evidence: ["3 retries"],
        confidence: "high",
      },
    ],
    recommendedActions: [
      {
        action: "pause-goal",
        nodeId: "node-2",
        reason: "Stop retry bleeding.",
        requiresUserApproval: false,
      },
    ],
  });
  const result = applyAuditActions(decision, defaultOptions({ pauseOnCritical: true }));

  assert.equal(result.shouldPauseGoal, true);
  assert.equal(result.applied.length, 1);
  // The matched finding should be the high-confidence one
  assert.equal(result.applied[0].matchedFinding.kind, "retry-loop");
  assert.equal(result.applied[0].matchedFinding.confidence, "high");
});

// ---------------------------------------------------------------------------
// 5. Pause-goal does NOT mark complete
// ---------------------------------------------------------------------------

test("applyAuditActions does not return shouldComplete or any complete signal", () => {
  const decision = makeCriticalRetryLoopDecision();
  const result = applyAuditActions(decision, defaultOptions());

  assert.equal(result.shouldPauseGoal, true);
  // The result type has no `shouldComplete` property
  assert.ok(!("shouldComplete" in result));
  // The applied action is "pause-goal", not any complete action
  for (const entry of result.applied) {
    assert.notEqual(entry.action.action, "complete");
    assert.notEqual(entry.action.action, "mark-node-blocked");
  }
});

test("applyAuditActions never recommends completion or merging", () => {
  // Even with a healthy noop decision, no completion is triggered
  const decision = makeHealthyNoopDecision();
  const result = applyAuditActions(decision, defaultOptions());
  assert.equal(result.shouldPauseGoal, false);
  assert.equal(result.applied.length, 0);
});

test("recordAuditActionEvents records pause-goal events correctly", async () => {
  const events: Array<{ type: string; details: Record<string, unknown> }> = [];
  const recorder: AuditEventRecorder = (type, details) => {
    events.push({ type, details });
  };

  const decision = makeCriticalRetryLoopDecision();
  const result = applyAuditActions(decision, defaultOptions());

  await recordAuditActionEvents(result, decision, recorder, now);

  // Should have: recommended event + goal_paused event
  const recommendedEvents = events.filter(
    (e) => e.type === "controller_audit_action_recommended",
  );
  const pausedEvents = events.filter(
    (e) => e.type === "goal_paused_by_controller_audit",
  );

  assert.equal(recommendedEvents.length, 1);
  assert.equal(recommendedEvents[0].details.action, "pause-goal");
  assert.equal(recommendedEvents[0].details.matchedFindingKind, "retry-loop");
  assert.equal(recommendedEvents[0].details.matchedFindingConfidence, "high");

  assert.equal(pausedEvents.length, 1);
  assert.equal(pausedEvents[0].details.risk, "critical");
  assert.ok(
    (pausedEvents[0].details.summary as string).includes("retry loop"),
  );
  assert.ok(
    (pausedEvents[0].details.appliedActions as string[]).includes("pause-goal"),
  );
  assert.ok(
    (pausedEvents[0].details.findingKinds as string[]).includes("retry-loop"),
  );
});

test("recordAuditActionEvents records skipped events", async () => {
  const events: Array<{ type: string; details: Record<string, unknown> }> = [];
  const recorder: AuditEventRecorder = (type, details) => {
    events.push({ type, details });
  };

  const decision = makeValidDecision({
    risk: "medium",
    findings: [
      {
        kind: "retry-loop",
        nodeId: "node-1",
        evidence: ["some retries"],
        confidence: "low",
      },
    ],
    recommendedActions: [
      {
        action: "pause-goal",
        reason: "Consider pausing.",
        requiresUserApproval: true,
      },
      {
        action: "cap-retries",
        reason: "Limit retries.",
        requiresUserApproval: true,
      },
    ],
  });
  const result = applyAuditActions(decision, defaultOptions());

  // Clear previous events
  events.length = 0;
  await recordAuditActionEvents(result, decision, recorder, now);

  // No recommended or paused events (shouldPauseGoal is false, so no pause-goal is recommended)
  assert.equal(
    events.filter((e) => e.type === "controller_audit_action_recommended").length,
    0,
  );
  assert.equal(
    events.filter((e) => e.type === "goal_paused_by_controller_audit").length,
    0,
  );
  // Both actions should be recorded as skipped
  const skippedEvents = events.filter(
    (e) => e.type === "controller_audit_action_skipped",
  );
  assert.equal(skippedEvents.length, 2);
  assert.equal(skippedEvents[0].details.action, "pause-goal");
  assert.equal(skippedEvents[1].details.action, "cap-retries");
});

test("recordAuditActionEvents records no events for all-noop", async () => {
  const events: Array<{ type: string; details: Record<string, unknown> }> = [];
  const recorder: AuditEventRecorder = (type, details) => {
    events.push({ type, details });
  };

  const decision = makeHealthyNoopDecision();
  const result = applyAuditActions(decision, defaultOptions());

  await recordAuditActionEvents(result, decision, recorder, now);

  assert.equal(events.length, 0);
});

test("recordAuditActionEvents skips goal_paused when shouldPauseGoal is false", async () => {
  const events: Array<{ type: string; details: Record<string, unknown> }> = [];
  const recorder: AuditEventRecorder = (type, details) => {
    events.push({ type, details });
  };

  // Critical but low confidence, so no auto-pause
  const decision = makeValidDecision({
    risk: "critical",
    findings: [
      {
        kind: "no-progress",
        evidence: [],
        confidence: "low",
      },
    ],
    recommendedActions: [
      {
        action: "pause-goal",
        reason: "recommended",
        requiresUserApproval: true,
      },
    ],
  });
  const result = applyAuditActions(decision, defaultOptions());

  await recordAuditActionEvents(result, decision, recorder, now);

  assert.equal(
    events.filter((e) => e.type === "goal_paused_by_controller_audit").length,
    0,
  );
  assert.equal(
    events.filter((e) => e.type === "controller_audit_action_skipped").length,
    1,
  );
});

// ---------------------------------------------------------------------------
// 6. Scenario tests
// ---------------------------------------------------------------------------

test("scenario: retry-loop triggers pause (spec: Critical high-confidence retry-loop triggers auto pause)", () => {
  // Build a snapshot that simulates a retry-loop scenario
  const node = makeNode({
    nodeId: "looping-node",
    status: "running",
    lifecyclePhase: "runnerActive",
  });
  const sub = makeSubagent({
    subagentId: "sub-loop",
    nodeId: "looping-node",
    retryCount: 5,
  });
  const events: GoalLedgerEvent[] = [
    // 5 retry failures
    ...Array.from({ length: 5 }, (_, i) =>
      makeEvent({
        eventId: `retry-${i}`,
        type: "continuation_retryable_failure",
        details: { nodeId: "looping-node" },
        at: `2026-06-15T11:5${i}:00.000Z`,
      }),
    ),
    // One recovery event for each
    ...Array.from({ length: 5 }, (_, i) =>
      makeEvent({
        eventId: `recovery-${i}`,
        type: "controller_event",
        details: {
          event: "recovery.decision",
          nodeId: "looping-node",
          summary: `Retry attempt ${i + 1}`,
        },
        at: `2026-06-15T11:5${i}:30.000Z`,
      }),
    ),
  ];

  const snapshot = buildControllerAuditSnapshot({
    state: makeState({ nodes: [node], subagents: [sub] }),
    goal: makeGoal(),
    recentEvents: events,
    options: defaultOptions(),
  });

  // Verify snapshot signals retry-loop
  assert.equal(snapshot.nodes[0].nodeId, "looping-node");
  assert.equal(snapshot.nodes[0].retryCount, 5);
  assert.equal(snapshot.progressSignals.retriesLastWindow, 10); // 5 retryable + 5 recovery
  assert.equal(snapshot.progressSignals.completedNodesLastWindow, 0);

  // Simulate audit decision that would be produced by the model
  const decision: GoalControllerAuditDecision = {
    risk: "critical",
    summary:
      "Node looping-node is stuck in a retry loop: 5 retries in window with no progress.",
    findings: [
      {
        kind: "retry-loop",
        nodeId: "looping-node",
        evidence: [
          "5 retry failures in the last window",
          "5 recovery decisions without progress",
          "No node completions in window",
        ],
        confidence: "high",
      },
    ],
    recommendedActions: [
      {
        action: "pause-goal",
        nodeId: "looping-node",
        reason: "Stop token/cost bleed from retry loop.",
        requiresUserApproval: false,
      },
    ],
  };

  // Validate the decision
  const validation = validateControllerAuditDecision(decision);
  assert.equal(validation.valid, true);

  // Apply action policy
  const result = applyAuditActions(
    validation.valid ? validation.decision : decision,
    defaultOptions({ pauseOnCritical: true }),
  );
  assert.equal(result.shouldPauseGoal, true);
  assert.equal(result.applied.length, 1);
  assert.equal(result.applied[0].action.action, "pause-goal");
  assert.ok(result.pauseReason?.includes("retry loop"));
});

test("scenario: cost-spike triggers pause (spec: Critical cost-spike triggers auto pause)", () => {
  // Build snapshot with cost-spike signals
  const events: GoalLedgerEvent[] = [
    makeEvent({
      type: "turn_finished",
      details: { tokensUsedDelta: 25000 },
      at: "2026-06-15T11:50:00.000Z",
    }),
    makeEvent({
      type: "turn_finished",
      details: { tokensUsedDelta: 30000 },
      at: "2026-06-15T11:52:00.000Z",
    }),
  ];
  const goal = makeGoal({ tokensUsed: 55000 });

  const snapshot = buildControllerAuditSnapshot({
    state: makeState(),
    goal,
    recentEvents: events,
    options: defaultOptions(),
  });

  // Verify cost signals reflect the spike
  assert.ok(snapshot.costSignals);
  assert.equal(snapshot.costSignals!.tokensLastWindow, 55000);
  assert.equal(
    snapshot.costSignals!.estimatedCostLastWindow,
    Math.round((55000 / 1000) * 0.01 * 100) / 100,
  );
  assert.equal(snapshot.goal.tokensUsed, 55000);

  // Simulate audit model decision for cost-spike
  const decision: GoalControllerAuditDecision = {
    risk: "critical",
    summary:
      "Token usage spiked to 55K in the last window; estimated cost $0.55.",
    findings: [
      {
        kind: "cost-spike",
        evidence: [
          "Token usage jumped 5x compared to prior windows",
          "Estimated cost $0.55 in single window vs typical $0.10",
        ],
        confidence: "high",
      },
    ],
    recommendedActions: [
      {
        action: "pause-goal",
        reason: "Token cost spike detected; pause to prevent budget drain.",
        requiresUserApproval: false,
      },
    ],
  };

  const validation = validateControllerAuditDecision(decision);
  assert.equal(validation.valid, true);

  const result = applyAuditActions(
    validation.valid ? validation.decision : decision,
    defaultOptions({ pauseOnCritical: true }),
  );
  assert.equal(result.shouldPauseGoal, true);
  assert.equal(result.applied[0].action.action, "pause-goal");
});

test("scenario: healthy progress returns noop (spec: Steady progress returns noop)", () => {
  // Build snapshot with healthy progress signals
  const nodes: GoalDagNode[] = [
    makeNode({
      nodeId: "node-1",
      status: "complete",
      lifecyclePhase: "terminal",
    }),
    makeNode({
      nodeId: "node-2",
      status: "running",
      lifecyclePhase: "runnerActive",
    }),
  ];
  const events: GoalLedgerEvent[] = [
    makeEvent({
      type: "controller_event",
      details: { event: "node.complete", nodeId: "node-1" },
      at: "2026-06-15T11:45:00.000Z",
    }),
    makeEvent({
      type: "controller_event",
      details: { event: "node.complete", nodeId: "node-3" },
      at: "2026-06-15T11:54:00.000Z",
    }),
    makeEvent({
      type: "turn_finished",
      details: { tokensUsedDelta: 500 },
      at: "2026-06-15T11:50:00.000Z",
    }),
  ];

  const snapshot = buildControllerAuditSnapshot({
    state: makeState({ nodes }),
    goal: makeGoal(),
    recentEvents: events,
    options: defaultOptions(),
  });

  // Verify healthy signals
  assert.equal(snapshot.progressSignals.completedNodesLastWindow, 2);
  assert.equal(snapshot.progressSignals.retriesLastWindow, 0);
  assert.equal(snapshot.progressSignals.validationFailuresLastWindow, 0);
  assert.ok(snapshot.costSignals);
  assert.equal(snapshot.costSignals!.tokensLastWindow, 500);

  // Simulate healthy audit decision
  const decision = makeHealthyNoopDecision();
  const validation = validateControllerAuditDecision(decision);
  assert.equal(validation.valid, true);

  const result = applyAuditActions(
    validation.valid ? validation.decision : decision,
    defaultOptions(),
  );
  assert.equal(result.shouldPauseGoal, false);
  assert.equal(result.applied.length, 0);
  assert.equal(result.skipped.length, 0);
});

test("scenario: invalid audit output is detected and produces no side effects", () => {
  // When the "model" returns garbage
  const invalidDecision = {
    risk: "unknown-risk",
    // missing summary
    findings: "not-an-array",
    recommendedActions: [{}],
  };
  const result = validateControllerAuditDecision(invalidDecision);
  assert.equal(result.valid, false);
  if (!result.valid) {
    assert.ok(result.errors.length > 0);
    // Validate that we detect specific problems
    const errorText = result.errors.join(" ");
    assert.ok(errorText.includes("risk"), "should report risk error");
    assert.ok(
      errorText.includes("summary") || errorText.includes("findings"),
      "should report summary or findings error",
    );
  }

  // Even if we tried to apply actions from invalid output, we shouldn't
  // (the caller is responsible for checking valid first)
});

// ---------------------------------------------------------------------------
// 7. Monitor display – audit summary rendering
// ---------------------------------------------------------------------------

test("formatAuditSummary renders critical finding with applied action", () => {
  const decision = makeCriticalRetryLoopDecision();
  const result = applyAuditActions(decision, defaultOptions());
  const summary = formatAuditSummary(decision, result.applied);

  assert.ok(summary.startsWith("Controller audit:"));
  assert.ok(summary.includes("critical"));
  assert.ok(summary.includes("retry-loop"));
  assert.ok(summary.includes("node-1"));
  assert.ok(summary.includes("pause-goal"));
  assert.ok(summary.includes("applied"));
});

test("formatAuditSummary renders healthy noop finding compactly", () => {
  const decision = makeHealthyNoopDecision();
  const result = applyAuditActions(decision, defaultOptions());
  const summary = formatAuditSummary(decision, result.applied);

  assert.ok(summary.startsWith("Controller audit:"));
  assert.ok(summary.includes("low"));
  assert.ok(summary.includes("unknown"));
  // No "applied" suffix since there are no applied actions
  assert.ok(!summary.includes("applied"));
});

test("formatAuditSummary deduplicates finding kinds", () => {
  const decision = makeValidDecision({
    risk: "high",
    summary: "Multiple issues.",
    findings: [
      { kind: "retry-loop", nodeId: "node-1", evidence: [], confidence: "high" },
      { kind: "retry-loop", nodeId: "node-2", evidence: [], confidence: "high" },
      { kind: "cost-spike", evidence: [], confidence: "medium" },
    ],
    recommendedActions: [
      {
        action: "pause-goal",
        nodeId: "node-1",
        reason: "Stop retry.",
        requiresUserApproval: false,
      },
    ],
  });
  const result = applyAuditActions(decision, defaultOptions());
  const summary = formatAuditSummary(decision, result.applied);

  // "retry-loop" should appear only once
  const firstRetry = summary.indexOf("retry-loop");
  const lastRetry = summary.lastIndexOf("retry-loop");
  assert.equal(firstRetry, lastRetry, "retry-loop should appear only once");
  assert.ok(summary.includes("cost-spike"));
});

test("formatAuditSummary shows all node IDs when multiple nodes are affected", () => {
  const decision = makeValidDecision({
    risk: "critical",
    summary: "Multiple nodes stuck.",
    findings: [
      {
        kind: "no-progress",
        nodeId: "node-1",
        evidence: [],
        confidence: "high",
      },
      {
        kind: "retry-loop",
        nodeId: "node-2",
        evidence: [],
        confidence: "high",
      },
      {
        kind: "retry-loop",
        nodeId: "node-3",
        evidence: [],
        confidence: "high",
      },
    ],
    recommendedActions: [
      {
        action: "pause-goal",
        reason: "Pause for safety.",
        requiresUserApproval: false,
      },
    ],
  });
  const result = applyAuditActions(decision, defaultOptions());
  const summary = formatAuditSummary(decision, result.applied);

  assert.ok(summary.includes("node-1"));
  assert.ok(summary.includes("node-2"));
  assert.ok(summary.includes("node-3"));
  // nodeIds should be comma-separated
  assert.ok(summary.includes("node-1, node-2, node-3") || summary.includes("node-1, node-3, node-2"));
});

test("formatAuditSummary handles empty findings gracefully", () => {
  const decision = makeValidDecision({
    risk: "low",
    summary: "No issues.",
    findings: [],
    recommendedActions: [{ action: "noop", reason: "all good", requiresUserApproval: false }],
  });
  const result = applyAuditActions(decision, defaultOptions());
  const summary = formatAuditSummary(decision, result.applied);

  assert.ok(summary.includes("none"));
  assert.ok(!summary.includes(" on ")); // No node IDs
});

test("formatAuditSummary handles findings without nodeId", () => {
  const decision = makeCriticalCostSpikeDecision();
  const result = applyAuditActions(decision, defaultOptions());
  const summary = formatAuditSummary(decision, result.applied);

  assert.ok(summary.includes("cost-spike"));
  // No " on " segment when no nodeIds
  assert.ok(!summary.includes(" on "));
  assert.ok(summary.includes("pause-goal"));
  assert.ok(summary.includes("applied"));
});

// ---------------------------------------------------------------------------
// 8. Ledger event type constants
// ---------------------------------------------------------------------------

test("GOAL_CONTROLLER_AUDIT_LEDGER_EVENT_TYPES includes all required event types", () => {
  const requiredTypes = [
    "controller_audit_started",
    "controller_audit_finished",
    "controller_audit_invalid_output",
    "controller_audit_action_recommended",
    "controller_audit_action_applied",
    "controller_audit_action_skipped",
    "controller_audit_action_failed",
    "goal_paused_by_controller_audit",
  ];
  for (const t of requiredTypes) {
    assert.ok(
      GOAL_CONTROLLER_AUDIT_LEDGER_EVENT_TYPES.includes(t as any),
      `missing event type: ${t}`,
    );
  }
});

// ---------------------------------------------------------------------------
// 9. Default constants
// ---------------------------------------------------------------------------

test("DEFAULT_AUDIT_INTERVAL_MS is 30 minutes", () => {
  assert.equal(DEFAULT_AUDIT_INTERVAL_MS, 30 * 60 * 1000);
});

test("DEFAULT_MAX_RECENT_EVENTS is 200", () => {
  assert.equal(DEFAULT_MAX_RECENT_EVENTS, 200);
});

test("DEFAULT_MAX_RECENT_VALIDATION_RESULTS is 50", () => {
  assert.equal(DEFAULT_MAX_RECENT_VALIDATION_RESULTS, 50);
});
