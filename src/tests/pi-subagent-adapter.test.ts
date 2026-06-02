import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PiHarnessSubagentAdapter,
  readPiSubagentSessionState,
  renderPiSubagentInitialPrompt,
  type BackgroundGoalSessionHandle,
  type BackgroundGoalSessionLaunchRequest,
} from "../adapters/pi/index.js";
import type { GoalDagNode, GoalSubagentRecord } from "../core/index.js";

const now = "2026-06-02T00:00:00.000Z";

function node(overrides: Partial<GoalDagNode> = {}): GoalDagNode {
  return {
    goalId: "goal-1",
    nodeId: "attendance",
    slug: "attendance",
    objective: "Implement attendance DocTypes",
    scope: "people-frappe attendance",
    dependencyNodeIds: [],
    expectedOutputs: ["attendance.json"],
    validators: ["npm test"],
    completionGates: ["controller-validation"],
    status: "ready",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function subagent(overrides: Partial<GoalSubagentRecord> = {}): GoalSubagentRecord {
  return {
    goalId: "goal-1",
    nodeId: "attendance",
    subagentId: "subagent-1",
    harnessAdapterId: "pi",
    sessionId: "session-subagent-1",
    sessionFile: "/tmp/session.jsonl",
    workspacePath: "/repo/.worktrees/attendance",
    branch: "feat/attendance",
    status: "idle",
    prompts: ["initial"],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function fakeLauncher() {
  const launches: BackgroundGoalSessionLaunchRequest[] = [];
  const prompts: string[] = [];
  const stopped: string[] = [];
  const launcher = async (request: BackgroundGoalSessionLaunchRequest): Promise<BackgroundGoalSessionHandle> => {
    launches.push(request);
    const sessionId = request.sessionId ?? "resumed-session";
    return {
      sessionId,
      sessionFile: request.sessionFile ?? `/sessions/${sessionId}.jsonl`,
      setSessionName: async () => undefined,
      sendPrompt: async (prompt: string) => {
        prompts.push(prompt);
      },
      stop: () => stopped.push(sessionId),
    };
  };
  return { launcher, launches, prompts, stopped };
}

test("Pi harness subagent adapter starts a detached Pi session and sends the initial prompt", async () => {
  const { launcher, launches, prompts } = fakeLauncher();
  const adapter = new PiHarnessSubagentAdapter({ launcher, modelArg: "test/model", now: () => new Date(now) });
  const result = await adapter.startSession({
    goalId: "goal-1",
    node: node(),
    subagentId: "subagent-1",
    cwd: "/repo/.worktrees/attendance",
    branch: "feat/attendance",
    systemPrompt: "system guardrails",
    initialPrompt: "create attendance doctypes",
    metadata: { sessionName: "custom subagent" },
  });

  assert.equal(launches.length, 1);
  assert.equal(launches[0]?.cwd, "/repo/.worktrees/attendance");
  assert.equal(launches[0]?.sessionId, "subagent-subagent-1");
  assert.equal(launches[0]?.sessionName, "custom subagent");
  assert.equal(launches[0]?.modelArg, "test/model");
  assert.equal(result.sessionId, "subagent-subagent-1");
  assert.equal(result.status, "running");
  assert.equal(result.workspacePath, "/repo/.worktrees/attendance");
  assert.match(prompts[0] ?? "", /system guardrails/);
  assert.match(prompts[0] ?? "", /SUBAGENT_RESULT/);
  assert.match(prompts[0] ?? "", /create attendance doctypes/);
});

test("Pi harness subagent adapter sanitizes truncated session ids for Pi", async () => {
  const { launcher, launches } = fakeLauncher();
  const adapter = new PiHarnessSubagentAdapter({ launcher, now: () => new Date(now) });
  await adapter.startSession({
    goalId: "goal-1",
    node: node(),
    subagentId: `${"a".repeat(54)}-tail`,
    cwd: "/repo/.worktrees/attendance",
    initialPrompt: "initial",
  });

  const sessionId = launches[0]?.sessionId ?? "";
  assert.equal(sessionId.length <= 64, true);
  assert.match(sessionId, /^[a-zA-Z0-9](?:[a-zA-Z0-9_.-]*[a-zA-Z0-9])?$/);
  assert.doesNotMatch(sessionId, /-$/);
});

test("Pi harness subagent adapter treats missing live session files as starting across poll adapters", () => {
  const adapter = new PiHarnessSubagentAdapter({ now: () => new Date(now) });
  const state = adapter.getSessionState({
    subagent: subagent({
      status: "sessionStarted",
      sessionFile: "/tmp/not-yet-created.jsonl",
    }),
  });

  assert.equal(state.status, "starting");
  assert.match(state.error ?? "", /not found/);
});

test("Pi harness subagent adapter resumes an existing session file for follow-up prompts", async () => {
  const { launcher, launches, prompts, stopped } = fakeLauncher();
  const adapter = new PiHarnessSubagentAdapter({ launcher, now: () => new Date(now) });
  await adapter.startSession({
    goalId: "goal-1",
    node: node(),
    subagentId: "subagent-1",
    cwd: "/repo/.worktrees/attendance",
    initialPrompt: "initial",
  });
  const firstSessionFile = "/sessions/subagent-subagent-1.jsonl";
  await adapter.sendPrompt({
    subagent: subagent({ sessionFile: firstSessionFile }),
    prompt: "fix validator failure",
  });

  assert.equal(launches.length, 2);
  assert.equal(launches[1]?.sessionFile, firstSessionFile);
  assert.equal(launches[1]?.cwd, "/repo/.worktrees/attendance");
  assert.deepEqual(prompts, [renderPiSubagentInitialPrompt({ goalId: "goal-1", node: node(), subagentId: "subagent-1", cwd: "/repo/.worktrees/attendance", initialPrompt: "initial" }), "fix validator failure"]);
  assert.deepEqual(stopped, ["subagent-subagent-1"]);
});

test("Pi subagent session inspection maps transcript markers to self-report states", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-subagent-state-"));
  const sessionFile = join(dir, "session.jsonl");
  try {
    writeFileSync(
      sessionFile,
      [
        JSON.stringify({ type: "session", cwd: "/repo", timestamp: "2026-06-02T00:00:00.000Z" }),
        JSON.stringify({ type: "message", message: { role: "user", content: "start" }, timestamp: "2026-06-02T00:00:01.000Z" }),
        JSON.stringify({
          type: "message",
          message: { role: "assistant", content: [{ type: "text", text: "Implemented files.\nSUBAGENT_RESULT: attendance doctypes added and tests passed" }] },
          timestamp: "2026-06-02T00:00:02.000Z",
        }),
      ].join("\n"),
    );
    const state = readPiSubagentSessionState(subagent({ sessionFile }));
    assert.equal(state.status, "selfReportedComplete");
    assert.equal(state.selfReportedResult, "attendance doctypes added and tests passed");
    assert.equal(state.lastActivityAt, "2026-06-02T00:00:02.000Z");
    assert.deepEqual(state.metadata, { entryCount: 3, messageCount: 2 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Pi subagent session inspection maps blocked markers and missing sessions", () => {
  const blocked = readPiSubagentSessionState(subagent({ sessionFile: "/blocked" }), {
    exists: () => true,
    readFile: () => JSON.stringify({ type: "message", message: { role: "assistant", content: "SUBAGENT_BLOCKED: merge conflict needs controller input" }, timestamp: now }),
  });
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.selfReportedResult, "merge conflict needs controller input");

  const missing = readPiSubagentSessionState(subagent({ sessionFile: "/missing" }), { exists: () => false, live: true });
  assert.equal(missing.status, "starting");
  assert.match(missing.error ?? "", /not found/);
});

test("Pi harness subagent adapter abort stops tracked detached session handle", async () => {
  const { launcher, stopped } = fakeLauncher();
  const adapter = new PiHarnessSubagentAdapter({ launcher, now: () => new Date(now) });
  await adapter.startSession({ goalId: "goal-1", node: node(), subagentId: "subagent-1", cwd: "/repo", initialPrompt: "initial" });
  await adapter.abortSession({ subagent: subagent({ workspacePath: "/repo" }), reason: "controller cancelled" });
  assert.deepEqual(stopped, ["subagent-subagent-1"]);
});
