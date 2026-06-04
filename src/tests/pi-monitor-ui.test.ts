import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GoalMonitorController, readGoalTranscript, readGoalTranscriptLines } from "../adapters/pi/monitor-ui.js";
import type { GoalDagNode, GoalSubagentRecord, GoalSummary } from "../core/index.js";

function summary(status: GoalSummary["status"] = "active", sessionFile?: string): GoalSummary {
  return {
    sessionKey: "s1",
    goalId: "abcdef123456",
    shortGoalId: "abcdef12",
    objective: "monitor goal",
    objectiveSummary: "monitor goal",
    status,
    activityState: status === "active" ? "idle-eligible" : status,
    tokensUsed: 1,
    timeUsedSeconds: 2,
    createdAt: "2026-05-31T00:00:00.000Z",
    updatedAt: "2026-05-31T00:00:00.000Z",
    lastActivityAt: "2026-05-31T00:00:00.000Z",
    executionWorkspace: "/workspace",
    workspaceStatus: "configured",
    branch: "feat/a",
    branchVerificationStatus: "verified",
    sessionFile,
    controllerModelScenario: "controller",
    controllerModelArg: "openai-codex/gpt-5.5",
  };
}

test("goal monitor escape closes without lifecycle action", () => {
  const controller = new GoalMonitorController(summary());

  assert.deepEqual(controller.handleInput("\x1b"), { kind: "close" });
});

test("goal monitor exposes state-appropriate lifecycle actions", () => {
  const active = new GoalMonitorController(summary("active"));
  const paused = new GoalMonitorController(summary("paused"));

  assert.deepEqual(active.actions, ["pause", "resume", "clear", "close"]);
  assert.deepEqual(paused.actions, ["resume", "clear", "close"]);
  assert.deepEqual(active.handleInput("\r"), { kind: "action", action: "pause" });
});

test("goal monitor reads transcript lines without mutating session file", () => {
  const dir = mkdtempSync(join(tmpdir(), "goal-monitor-"));
  const sessionFile = join(dir, "session.jsonl");
  try {
    writeFileSync(
      sessionFile,
      [
        JSON.stringify({ type: "session", id: "s", cwd: dir, timestamp: "2026-05-31T00:00:00.000Z" }),
        JSON.stringify({ type: "message", message: { role: "user", content: "hello" } }),
        JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "done" }] } }),
      ].join("\n"),
    );

    assert.deepEqual(readGoalTranscriptLines(sessionFile), [
      `[05-31T00:00:00Z] session start cwd=${dir}`,
      "user: hello",
      "assistant: done",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("goal monitor transcript includes custom messages, tool calls, and session metadata", () => {
  const dir = mkdtempSync(join(tmpdir(), "goal-monitor-full-"));
  const sessionFile = join(dir, "session.jsonl");
  try {
    writeFileSync(
      sessionFile,
      [
        JSON.stringify({ type: "session_info", name: "goal abcdef12", timestamp: "2026-05-31T00:00:01.000Z" }),
        JSON.stringify({ type: "custom_message", customType: "agent-goal-runtime", content: "hidden steering", timestamp: "2026-05-31T00:00:02.000Z" }),
        JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path: "README.md" } }] }, timestamp: "2026-05-31T00:00:03.000Z" }),
        JSON.stringify({ type: "compaction", summary: "compacted", timestamp: "2026-05-31T00:00:04.000Z" }),
      ].join("\n"),
    );

    const snapshot = readGoalTranscript(sessionFile);

    assert.equal(snapshot.entryCount, 4);
    assert.equal(snapshot.messageCount, 2);
    assert.deepEqual(snapshot.lines, [
      "[05-31T00:00:01Z] session name: goal abcdef12",
      "[05-31T00:00:02Z] custom:agent-goal-runtime: hidden steering",
      '[05-31T00:00:03Z] assistant: [tool call] read {"path":"README.md"}',
      "[05-31T00:00:04Z] compaction: compacted",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("goal monitor renders live DAG and subagent dashboard", () => {
  const now = new Date("2026-05-31T00:05:00.000Z");
  const nodes: GoalDagNode[] = [
    {
      goalId: "abcdef123456",
      nodeId: "people-frappe-attendance-doctypes-long-node-id",
      slug: "people-frappe-attendance-doctypes",
      objective: "Implement attendance DocTypes",
      dependencyNodeIds: [],
      expectedOutputs: [],
      validators: [],
      completionGates: ["controller-validation"],
      status: "running",
      modelScenario: "implementation-heavy",
      modelArg: "local-aeon/aeon",
      createdAt: "2026-05-31T00:00:00.000Z",
      updatedAt: "2026-05-31T00:04:00.000Z",
    },
  ];
  const subagents: GoalSubagentRecord[] = [
    {
      goalId: "abcdef123456",
      nodeId: nodes[0]!.nodeId,
      subagentId: "subagent-abcdef12-attendance",
      harnessAdapterId: "pi",
      sessionFile: "/sessions/subagent.jsonl",
      workspacePath: "/home/shawn/projects/repo/.worktrees/attendance",
      branch: "goal/attendance",
      status: "running",
      prompts: ["initial"],
      integrationStatus: "working",
      createdAt: "2026-05-31T00:01:00.000Z",
      updatedAt: "2026-05-31T00:04:30.000Z",
      lastActivityAt: "2026-05-31T00:04:30.000Z",
    },
  ];
  const controller = new GoalMonitorController(
    summary("active"),
    () => ({ lines: ["tail"], entryCount: 1, messageCount: 1 }),
    () => ({ nodes, subagents, refreshedAt: now.toISOString() }),
    () => now,
  );
  const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

  const rendered = controller.render(140, theme).join("\n");

  assert.match(rendered, /DAG nodes=1 \(running=1\) subagents=1 \(running=1\)/);
  assert.match(rendered, /controllerModel=controller -> openai-codex\/gpt-5\.5/);
  assert.match(rendered, /DAG \/ Subagents/);
  assert.match(rendered, /\[running\] people-frappe-attendance-doctypes runtime=5m updated=1m ago/);
  assert.match(rendered, /model: implementation-heavy -> local-aeon\/aeon/);
  assert.match(rendered, /↳ \[running\] subagent-abcdef12-attendance runtime=4m last=30s ago/);
  assert.match(rendered, /branch: goal\/attendance/);
  assert.match(rendered, /note: working/);
  assert.match(rendered, /Transcript tail/);
});

test("goal monitor scrolls overflowing DAG lines", () => {
  const now = new Date("2026-05-31T00:05:00.000Z");
  const nodes: GoalDagNode[] = Array.from({ length: 12 }, (_, index) => ({
    goalId: "abcdef123456",
    nodeId: `dag-node-${String(index + 1).padStart(2, "0")}`,
    slug: `dag-node-${String(index + 1).padStart(2, "0")}`,
    objective: `Do DAG node ${index + 1}`,
    dependencyNodeIds: [],
    expectedOutputs: [],
    validators: [],
    completionGates: ["controller-validation"],
    status: "planned",
    createdAt: "2026-05-31T00:00:00.000Z",
    updatedAt: "2026-05-31T00:00:00.000Z",
  }));
  const controller = new GoalMonitorController(
    summary("active"),
    () => ({ lines: ["tail"], entryCount: 1, messageCount: 1 }),
    () => ({ nodes, subagents: [], refreshedAt: now.toISOString() }),
    () => now,
  );
  const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

  const firstPage = controller.render(140, theme).join("\n");
  assert.match(firstPage, /pane=dag/);
  assert.match(firstPage, /DAG lines: 1-18\/24 • active • 6 more DAG lines/);
  assert.doesNotMatch(firstPage, /dag-node-12/);

  controller.handleInput("\x1b[6~"); // PageDown scrolls the active DAG pane.
  const secondPage = controller.render(140, theme).join("\n");

  assert.match(secondPage, /dag-node-12/);
  assert.match(secondPage, /DAG lines: 7-24\/24 • active • 6 previous DAG lines/);
});

test("goal monitor transcript scroll remains available after switching panes", () => {
  const lines = Array.from({ length: 25 }, (_, index) => `transcript-${String(index + 1).padStart(2, "0")}`);
  const controller = new GoalMonitorController(summary("active"), () => ({ lines, entryCount: lines.length, messageCount: lines.length }));
  const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

  const initial = controller.render(120, theme).join("\n");
  assert.match(initial, /pane=dag/);
  assert.match(initial, /transcript-25/);

  controller.handleInput("t");
  controller.handleInput("\x1b[H"); // Home scrolls the transcript pane after focus switch.
  const top = controller.render(120, theme).join("\n");

  assert.match(top, /pane=transcript/);
  assert.match(top, /transcript-01/);
  assert.doesNotMatch(top, /transcript-25/);
  assert.match(top, /1-18\/25 active/);

  controller.handleInput("\x1b[F"); // End restores transcript live tail.
  const tail = controller.render(120, theme).join("\n");

  assert.match(tail, /transcript-25/);
  assert.match(tail, /8-25\/25 active • live/);
});

test("goal monitor render auto-follows live transcript tail", () => {
  let lines = ["one"];
  const controller = new GoalMonitorController(summary("active"), () => ({ lines, entryCount: lines.length, messageCount: lines.length }));
  const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

  assert.ok(controller.render(120, theme).some((line) => line.includes("one")));
  lines = ["one", "two"];
  assert.ok(controller.render(120, theme).some((line) => line.includes("two")));
});
