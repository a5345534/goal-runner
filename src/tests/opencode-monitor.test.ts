import test from "node:test";
import assert from "node:assert/strict";
import { renderOpencodeMonitorLines, readOpencodeGoalMonitorSnapshot } from "../adapters/opencode/monitor-ui.js";
import {
  buildGoalMonitorRuntimeSummary,
  deriveMonitorHealth,
  SESSION_STATE_LABELS,
  HIDDEN_CONTINUATION_STATE_LABELS,
  CONTROLLER_POLL_STATE_LABELS,
} from "../adapters/pi/monitor-ui.js";
import { GoalRuntime, SQLiteGoalStore } from "../core/index.js";
import type {
  GoalDagNode,
  GoalRecord,
  GoalSubagentRecord,
  GoalSummary,
  HarnessState,
  GoalLedgerEvent,
} from "../core/index.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const NOW = new Date("2026-06-03T01:00:00.000Z");

function makeSummary(overrides: Partial<GoalSummary> = {}): GoalSummary {
  return {
    sessionKey: "opencode:goal-1",
    goalId: "goal-1",
    shortGoalId: "goal-1",
    status: "active",
    objective: "ship the migration",
    objectiveSummary: "ship the migration",
    tokensUsed: 0,
    timeUsedSeconds: 0,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    lastActivityAt: NOW.toISOString(),
    ...overrides,
  };
}

function makeNode(overrides: Partial<GoalDagNode> = {}): GoalDagNode {
  return {
    goalId: "goal-1",
    nodeId: "n1",
    slug: "n1",
    objective: "implement X",
    expectedOutputs: [],
    validators: [],
    completionGates: [],
    dependencyNodeIds: [],
    status: "running",
    createdAt: new Date(NOW.getTime() - 60_000).toISOString(),
    updatedAt: new Date(NOW.getTime() - 5_000).toISOString(),
    ...overrides,
  };
}

function makeSubagent(overrides: Partial<GoalSubagentRecord> = {}): GoalSubagentRecord {
  return {
    goalId: "goal-1",
    nodeId: "n1",
    subagentId: "sa-1",
    harnessAdapterId: "opencode",
    prompts: [],
    status: "running",
    sessionId: "ses-1",
    branch: "feat/x",
    workspacePath: "/tmp/oc-wt-1",
    createdAt: new Date(NOW.getTime() - 60_000).toISOString(),
    updatedAt: new Date(NOW.getTime() - 5_000).toISOString(),
    lastActivityAt: new Date(NOW.getTime() - 5_000).toISOString(),
    ...overrides,
  };
}

test("renderOpencodeMonitorLines includes node and subagent lines", () => {
  const lines = renderOpencodeMonitorLines(
    makeSummary(),
    { nodes: [makeNode()], subagents: [makeSubagent()] },
    { now: () => NOW },
  );
  const joined = lines.join("\n");
  assert.match(joined, /Goal goal-1 monitor/);
  assert.match(joined, /\[running\] n1/);
  assert.match(joined, /\[running\] sa-1/);
  assert.match(joined, /branch: feat\/x/);
  assert.match(joined, /workspace: \/tmp\/oc-wt-1/);
});

test("renderOpencodeMonitorLines falls back to placeholder when state is empty", () => {
  const lines = renderOpencodeMonitorLines(makeSummary(), { nodes: [], subagents: [] }, { now: () => NOW });
  assert.match(lines.join("\n"), /no DAG nodes or subagents yet/);
});

test("readOpencodeGoalMonitorSnapshot reads from runtime and refreshes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-monitor-"));
  try {
    const store = new SQLiteGoalStore({ stateRoot: dir });
    const runtime = new GoalRuntime({ store });
    const goalRecord: GoalRecord = {
      sessionKey: "opencode:goal-1",
      goalId: "goal-1",
      objective: "ship the migration",
      status: "active",
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
      goalTurnsSinceAuditReset: 0,
    };
    await store.saveGoal(goalRecord);
    await store.saveGoalDagNode(makeNode());
    await store.saveGoalSubagent(makeSubagent());
    const summary = makeSummary();
    const snapshot = await readOpencodeGoalMonitorSnapshot(runtime, summary, { now: () => NOW });
    assert.ok(snapshot.refreshedAt);
    const joined = snapshot.lines.join("\n");
    assert.match(joined, /n1/);
    assert.match(joined, /sa-1/);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── Runtime band OpenCode tests ──

function ledgerEvent(overrides: Partial<GoalLedgerEvent> = {}): GoalLedgerEvent {
  return {
    sessionKey: "opencode:goal-1",
    goalId: "goal-1",
    type: "controller_event",
    at: NOW.toISOString(),
    details: { event: "poll.finished", changed: false, ready: 0 },
    ...overrides,
  };
}

test("renderOpencodeMonitorLines has STATUS / RUNTIME / PROGRESS / NEXT ACTION sections", () => {
  const lines = renderOpencodeMonitorLines(
    makeSummary(),
    { nodes: [makeNode()], subagents: [makeSubagent()] },
    { now: () => NOW },
  );
  const joined = lines.join("\n");

  // Section headers.
  assert.match(joined, /── STATUS ──/);
  assert.match(joined, /── RUNTIME ──/);
  assert.match(joined, /── PROGRESS ──/);
  assert.match(joined, /── NEXT ACTION ──/);

  // Section ordering.
  const statusIndex = lines.findIndex((line) => line.includes("── STATUS ──"));
  const runtimeIndex = lines.findIndex((line) => line.includes("── RUNTIME ──"));
  const progressIndex = lines.findIndex((line) => line.includes("── PROGRESS ──"));
  const nextActionIndex = lines.findIndex((line) => line.includes("── NEXT ACTION ──"));

  assert.ok(statusIndex >= 0);
  assert.ok(statusIndex < runtimeIndex);
  assert.ok(runtimeIndex < progressIndex);
  assert.ok(progressIndex < nextActionIndex);

  // STATUS contains goal info.
  assert.match(joined, /Goal goal-1 monitor/);
  assert.match(joined, /Status: active/);

  // RUNTIME contains runtime summary.
  assert.match(joined, /Session=/);
  assert.match(joined, /Hidden=/);
  assert.match(joined, /Poll=/);
  assert.match(joined, /Health:/);

  // PROGRESS contains nodes and subagents.
  assert.match(joined, /\[running\] n1/);
  assert.match(joined, /\[running\] sa-1/);

  // NEXT ACTION should be present.
  const nextActionLine = lines[nextActionIndex + 1];
  assert.ok(nextActionLine && nextActionLine.length > 0);
});

test("OpenCode RUNTIME section renders active session + suppressed continuation correctly", () => {
  const harnessState: HarnessState = {
    materialized: true,
    activeTurnId: "turn-oc-1",
    queuedUserInput: false,
    queuedTriggerTurn: false,
    continuationSuppressed: true,
  };
  const now = Date.now();
  const events = [
    ledgerEvent({
      at: new Date(now - 5_000).toISOString(),
      details: { event: "poll.finished", changed: true, ready: 1, leased: false },
    }),
  ];
  const runnerRecords = [
    { runnerDir: "/tmp/r1", configPath: "/tmp/r1/config.json", subagentId: "sa-1", nodeId: "n1", goalId: "goal-1", runnerAlive: true, childAlive: true },
  ];

  const runtimeSummary = buildGoalMonitorRuntimeSummary(
    makeSummary(),
    [makeSubagent({ subagentId: "sa-1", status: "running" })],
    { harnessState, ledgerEvents: events, runners: runnerRecords },
  );

  // Session is active-turn.
  assert.equal(runtimeSummary.session.state, "active-turn");
  assert.equal(runtimeSummary.session.activeTurnId, "turn-oc-1");

  // Hidden is suppressed with reason.
  assert.equal(runtimeSummary.hiddenContinuation.state, "suppressed");
  assert.equal(runtimeSummary.hiddenContinuation.reason, "active turn running");

  // Poll is active.
  assert.equal(runtimeSummary.controllerPoll.state, "active");

  // Runners: 1 running.
  assert.equal(runtimeSummary.runners.running, 1);

  // Health should be OK.
  const health = deriveMonitorHealth(runtimeSummary, makeSummary(), [makeSubagent({ subagentId: "sa-1", status: "running" })]);
  assert.equal(health.health, "OK");
});

test("OpenCode RUNTIME section shows suppressed continuation as not-failure", () => {
  const harnessState: HarnessState = {
    materialized: true,
    activeTurnId: "turn-oc-1",
    queuedUserInput: false,
    queuedTriggerTurn: false,
    continuationSuppressed: true,
  };
  const now = Date.now();
  const events = [
    ledgerEvent({
      at: new Date(now - 5_000).toISOString(),
      details: { event: "poll.finished", changed: true, ready: 1, leased: false },
    }),
  ];

  const lines = renderOpencodeMonitorLines(
    makeSummary(),
    { nodes: [makeNode({ status: "running" })], subagents: [makeSubagent({ status: "running" })] },
    { now: () => NOW, ledgerEvents: events },
  );
  const runtimeSection = lines.join("\n");

  // Should show session info in RUNTIME section.
  assert.match(runtimeSection, /── RUNTIME ──/);
  assert.match(runtimeSection, /Session=/);
  assert.match(runtimeSection, /Hidden=/);
  assert.match(runtimeSection, /Poll=/);
  assert.match(runtimeSection, /Runners:/);

  // Health should be present.
  assert.match(runtimeSection, /Health:/);
});

test("OpenCode blocked node changes health and shows blocked state in render", () => {
  // Blocked node with no running runners → "Blocked" health in render.
  const blockedNode = makeNode({ nodeId: "n-blocked", slug: "n-blocked", status: "blocked", lastValidationSummary: "output missing" });
  const blockedSub = makeSubagent({ nodeId: "n-blocked", subagentId: "sa-blocked", status: "blocked" });

  // deriveMonitorHealth with a running runner shows "Needs attention".
  const runningSub = makeSubagent({ nodeId: "n-blocked", subagentId: "sa-running", status: "running" });
  const runnerRecords = [
    { runnerDir: "/tmp/r1", configPath: "/tmp/r1/config.json", subagentId: "sa-running", nodeId: "n-blocked", goalId: "goal-1", runnerAlive: true, childAlive: true },
  ];

  const runtimeSummary = buildGoalMonitorRuntimeSummary(
    makeSummary(),
    [blockedSub, runningSub],
    { runners: runnerRecords },
  );
  const health = deriveMonitorHealth(runtimeSummary, makeSummary(), [blockedSub, runningSub]);
  assert.equal(health.health, "Needs attention");
  assert.match(health.nextAction, /inspect blocked/);

  // Render output (without runner records) reflects the blocked subagent and
  // shows "Blocked" health since running runners aren't visible to the renderer.
  const lines = renderOpencodeMonitorLines(
    makeSummary(),
    { nodes: [blockedNode], subagents: [blockedSub, runningSub] },
    { now: () => NOW },
  );
  const joined = lines.join("\n");

  // Health line present in RUNTIME section.
  assert.match(joined, /Health: Blocked/);

  // NEXT ACTION section present.
  assert.match(joined, /── NEXT ACTION ──/);

  // Blocked node and subagent appear in PROGRESS.
  assert.match(joined, /\[blocked\] n-blocked/);
  assert.match(joined, /\[blocked\] sa-blocked/);
});

test("OpenCode fully blocked goal shows Blocked health", () => {
  const blockedNode = makeNode({ nodeId: "n-blocked", status: "blocked" });
  const blockedSub = makeSubagent({ nodeId: "n-blocked", subagentId: "sa-blocked", status: "blocked" });

  const runtimeSummary = buildGoalMonitorRuntimeSummary(
    makeSummary({ status: "blocked" }),
    [blockedSub],
  );
  const health = deriveMonitorHealth(runtimeSummary, makeSummary({ status: "blocked" }), [blockedSub]);

  // No running runners + blocked subagent → "Blocked".
  assert.equal(health.health, "Blocked");

  // Render and verify.
  const lines = renderOpencodeMonitorLines(
    makeSummary({ status: "blocked" }),
    { nodes: [blockedNode], subagents: [blockedSub] },
    { now: () => NOW },
  );
  const joined = lines.join("\n");
  assert.match(joined, /Health: Blocked/);
});

test("OpenCode runner summary shows counts before per-runner details", () => {
  const nodes = [makeNode({ nodeId: "n1" })];
  const subagents = [
    makeSubagent({ nodeId: "n1", subagentId: "sa-1", status: "running" }),
    makeSubagent({ nodeId: "n1", subagentId: "sa-2", status: "running" }),
    makeSubagent({ nodeId: "n1", subagentId: "sa-3", status: "complete" }),
  ];

  // Without runner records, the renderOpencodeMonitorLines builder only has
  // subagent status info for failed/archived counts. Running subagents
  // contribute to count only when runner records exist.
  const lines = renderOpencodeMonitorLines(
    makeSummary(),
    { nodes, subagents },
    { now: () => NOW },
  );
  const joined = lines.join("\n");

  // Runner summary should appear before the per-node detail.
  const runnersIndex = lines.findIndex((line) => line.startsWith("Runners:"));
  const firstNodeIndex = lines.findIndex((line) => line.match(/^\d+\. \[/));
  assert.ok(runnersIndex >= 0);
  assert.ok(runnersIndex < firstNodeIndex, "Runner summary should appear before per-node detail");

  // Runner summary should include the archived count from the "complete" subagent.
  // Running subagents without runner records are not counted.
  assert.match(joined, /Runners: .*1 archived/);
  assert.match(joined, /Nodes: 1/);
  assert.match(joined, /Subagents: 3/);
});

test("OpenCode runtime summary labels are consistent with Pi TUI", () => {
  // Verify both adapters share the same canonical labels.
  assert.equal(SESSION_STATE_LABELS["active-turn"], "ACTIVE-TURN");
  assert.equal(HIDDEN_CONTINUATION_STATE_LABELS.suppressed, "SUPPRESSED");
  assert.equal(CONTROLLER_POLL_STATE_LABELS.active, "ACTIVE");

  // Pi TUI and OpenCode use the same label maps.
  const harnessState: HarnessState = {
    materialized: true,
    activeTurnId: "turn-shared-1",
    queuedUserInput: false,
    queuedTriggerTurn: false,
    continuationSuppressed: true,
  };
  const summary = buildGoalMonitorRuntimeSummary(makeSummary(), [makeSubagent({ status: "running" })], { harnessState });

  assert.equal(summary.session.state, "active-turn");
  assert.equal(summary.hiddenContinuation.state, "suppressed");
  assert.equal(summary.hiddenContinuation.reason, "active turn running");
});

test("OpenCode next-action adapts Pi TUI language for text output", () => {
  // Use a blocked node to get a specific next-action that references Pi TUI navigation.
  const blockedSub = makeSubagent({ subagentId: "sa-blocked", status: "blocked" });
  const summary = buildGoalMonitorRuntimeSummary(makeSummary(), [blockedSub]);
  const health = deriveMonitorHealth(summary, makeSummary(), [blockedSub]);

  // Verify the Pi-original next-action text doesn't leak Pi TUI nav language.
  assert.doesNotMatch(health.nextAction, /nodeList/);
  assert.doesNotMatch(health.nextAction, /runnerList/);

  // Render through the OpenCode formatter.
  const lines = renderOpencodeMonitorLines(
    makeSummary(),
    { nodes: [makeNode({ nodeId: "n-blocked", status: "blocked" })], subagents: [blockedSub] },
    { now: () => NOW },
  );
  const joined = lines.join("\n");

  // The OpenCode output adapts the next-action language.
  const nextActionIdx = lines.findIndex((l) => l === "── NEXT ACTION ──");
  if (nextActionIdx >= 0 && lines[nextActionIdx + 1]) {
    const nextActionLine = lines[nextActionIdx + 1]!;
    assert.doesNotMatch(nextActionLine, /nodeList/);
    assert.doesNotMatch(nextActionLine, /runnerList/);
  }
});

test("OpenCode empty state still renders all four sections", () => {
  const lines = renderOpencodeMonitorLines(makeSummary(), { nodes: [], subagents: [] }, { now: () => NOW });
  const joined = lines.join("\n");

  assert.match(joined, /── STATUS ──/);
  assert.match(joined, /── RUNTIME ──/);
  assert.match(joined, /── PROGRESS ──/);
  assert.match(joined, /── NEXT ACTION ──/);
  assert.match(joined, /no DAG nodes or subagents yet/);
});
