import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GoalMonitorController, readGoalTranscript, readGoalTranscriptLines } from "../adapters/pi/monitor-ui.js";
import type { GoalSummary } from "../core/index.js";

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
  };
}

test("goal monitor escape closes without lifecycle action", () => {
  const controller = new GoalMonitorController(summary());

  assert.deepEqual(controller.handleInput("\x1b"), { kind: "close" });
});

test("goal monitor exposes state-appropriate lifecycle actions", () => {
  const active = new GoalMonitorController(summary("active"));
  const paused = new GoalMonitorController(summary("paused"));

  assert.deepEqual(active.actions, ["pause", "clear", "close"]);
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

test("goal monitor render auto-follows live transcript tail", () => {
  let lines = ["one"];
  const controller = new GoalMonitorController(summary("active"), () => ({ lines, entryCount: lines.length, messageCount: lines.length }));
  const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

  assert.ok(controller.render(120, theme).some((line) => line.includes("one")));
  lines = ["one", "two"];
  assert.ok(controller.render(120, theme).some((line) => line.includes("two")));
});
