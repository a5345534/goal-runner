import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  archivePiBackgroundRunnerDirs,
  filterPiBackgroundRunnersForSubagent,
  readPiBackgroundRunnerInventory,
  signalPiBackgroundRunners,
  type PiBackgroundRunnerRecord,
} from "../adapters/pi/runner-ops.js";
import type { GoalSubagentRecord } from "../core/index.js";

const now = "2026-05-31T00:00:00.000Z";

function subagent(overrides: Partial<GoalSubagentRecord> = {}): GoalSubagentRecord {
  return {
    goalId: "goal-abcdef12",
    nodeId: "build-node",
    subagentId: "subagent-build-node-1",
    harnessAdapterId: "pi",
    sessionFile: "/sessions/subagent-build-node-1.jsonl",
    workspacePath: "/repo/.worktrees/build-node",
    status: "running",
    prompts: ["initial"],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

test("readPiBackgroundRunnerInventory maps tmp runner dirs to durable subagents", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-runner-inventory-"));
  try {
    const runnerDir = join(dir, "goal-runner-bg-one");
    mkdirSync(runnerDir);
    const readyPath = join(runnerDir, "ready.json");
    writeFileSync(join(runnerDir, "config.json"), JSON.stringify({
      runId: "run-1",
      cwd: "/repo/.worktrees/build-node",
      sessionFile: "/sessions/subagent-build-node-1.jsonl",
      sessionName: "subagent subagent-build-node-1: build-node",
      modelArg: "model/a",
      thinkingLevel: "xhigh",
      readyPath,
      commandPath: join(runnerDir, "command.json"),
      logPath: join(runnerDir, "runner.log"),
    }));
    writeFileSync(readyPath, JSON.stringify({
      sessionFile: "/sessions/subagent-build-node-1.jsonl",
      sessionId: "session-1",
      runnerPid: 99999999,
      childPid: 99999998,
    }));

    const records = readPiBackgroundRunnerInventory("goal-abcdef12", [subagent()], { tmpRoot: dir });

    assert.equal(records.length, 1);
    assert.equal(records[0]?.subagentId, "subagent-build-node-1");
    assert.equal(records[0]?.nodeId, "build-node");
    assert.equal(records[0]?.goalId, "goal-abcdef12");
    assert.equal(records[0]?.thinkingLevel, "xhigh");
    assert.equal(records[0]?.runnerAlive, false);
    assert.equal(records[0]?.childAlive, false);
    assert.equal(filterPiBackgroundRunnersForSubagent(records, "subagent-build-node-1").length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readPiBackgroundRunnerInventory recognizes legacy tmp runner dirs", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-runner-legacy-inventory-"));
  try {
    const runnerDir = join(dir, "agent-goal-runtime-bg-one");
    mkdirSync(runnerDir);
    writeFileSync(join(runnerDir, "config.json"), JSON.stringify({
      cwd: "/repo/.worktrees/build-node",
      sessionFile: "/sessions/subagent-build-node-1.jsonl",
      sessionName: "subagent subagent-build-node-1: build-node",
    }));

    const records = readPiBackgroundRunnerInventory("goal-abcdef12", [subagent()], { tmpRoot: dir });

    assert.equal(records.length, 1);
    assert.equal(records[0]?.subagentId, "subagent-build-node-1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readPiBackgroundRunnerInventory does not attach stale same-id runner dirs without goal-scoped evidence", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-runner-stale-same-id-"));
  try {
    const runnerDir = join(dir, "goal-runner-bg-stale");
    mkdirSync(runnerDir);
    writeFileSync(join(runnerDir, "config.json"), JSON.stringify({
      cwd: "/repo/.worktrees/goal-old/.worktrees/build-node",
      sessionFile: "/sessions/old-goal/subagent-build-node-1.jsonl",
      sessionName: "subagent subagent-build-node-1: build-node",
    }));

    const records = readPiBackgroundRunnerInventory("goal-abcdef12", [subagent({
      sessionFile: "/sessions/new-goal/subagent-build-node-1.jsonl",
      workspacePath: "/repo/.worktrees/goal-new/.worktrees/build-node",
    })], { tmpRoot: dir });

    assert.equal(records.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readPiBackgroundRunnerInventory can match goal-owned controller runners by workspace root", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-runner-workspace-inventory-"));
  try {
    const runnerDir = join(dir, "goal-runner-bg-controller");
    mkdirSync(runnerDir);
    const readyPath = join(runnerDir, "ready.json");
    writeFileSync(join(runnerDir, "config.json"), JSON.stringify({
      runId: "run-controller",
      cwd: "/repo/.worktrees/goal-123-feature",
      sessionFile: "/sessions/controller.jsonl",
      sessionName: "goal: Implement feature",
      readyPath,
      commandPath: join(runnerDir, "command.json"),
      logPath: join(runnerDir, "runner.log"),
    }));
    writeFileSync(readyPath, JSON.stringify({
      sessionFile: "/sessions/controller.jsonl",
      sessionId: "controller-session",
      runnerPid: 99999999,
      childPid: 99999998,
    }));

    const withoutWorkspace = readPiBackgroundRunnerInventory("goal-abcdef12", [], { tmpRoot: dir });
    assert.equal(withoutWorkspace.length, 0);

    const records = readPiBackgroundRunnerInventory("goal-abcdef12", [], {
      tmpRoot: dir,
      workspaceRoots: ["/repo/.worktrees/goal-123-feature"],
    });

    assert.equal(records.length, 1);
    assert.equal(records[0]?.goalId, "goal-abcdef12");
    assert.equal(records[0]?.sessionId, "controller-session");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("archivePiBackgroundRunnerDirs moves only stopped runner temp dirs", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-runner-archive-"));
  const archiveRoot = join(dir, "archive");
  try {
    const stoppedDir = join(dir, "goal-runner-bg-stopped");
    mkdirSync(stoppedDir);
    writeFileSync(join(stoppedDir, "config.json"), "{}");
    const liveDir = join(dir, "goal-runner-bg-live");
    mkdirSync(liveDir);
    writeFileSync(join(liveDir, "config.json"), "{}");
    const records: PiBackgroundRunnerRecord[] = [
      { runnerDir: stoppedDir, configPath: join(stoppedDir, "config.json"), runnerAlive: false, childAlive: false, subagentId: "subagent-build-node-1" },
      { runnerDir: liveDir, configPath: join(liveDir, "config.json"), runnerAlive: true, childAlive: false, subagentId: "subagent-build-node-1", runnerPid: process.pid },
    ];

    const result = archivePiBackgroundRunnerDirs(records, { archiveRoot, now: new Date("2026-05-31T00:00:00.000Z") });

    assert.equal(result.matched, 2);
    assert.equal(result.archived, 1);
    assert.equal(result.skippedLive, 1);
    assert.equal(existsSync(stoppedDir), false);
    assert.equal(existsSync(liveDir), true);
    assert.ok(result.archiveDir && existsSync(result.archiveDir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("archivePiBackgroundRunnerDirs falls back for cross-device archive roots", (t) => {
  const sourceRoot = mkdtempSync(join(tmpdir(), "pi-runner-archive-cross-source-"));
  const archiveRoot = mkdtempSync(join(process.cwd(), ".pi-runner-archive-cross-dest-"));
  try {
    if (statSync(sourceRoot).dev === statSync(archiveRoot).dev) {
      t.skip("source and archive roots are on the same device");
      return;
    }
    const stoppedDir = join(sourceRoot, "goal-runner-bg-stopped");
    mkdirSync(stoppedDir);
    writeFileSync(join(stoppedDir, "config.json"), "{}");
    writeFileSync(join(stoppedDir, "runner.log"), "runner output\n");
    const records: PiBackgroundRunnerRecord[] = [
      { runnerDir: stoppedDir, configPath: join(stoppedDir, "config.json"), runnerAlive: false, childAlive: false, subagentId: "subagent-build-node-1" },
    ];

    const result = archivePiBackgroundRunnerDirs(records, { archiveRoot, now: new Date("2026-05-31T00:00:00.000Z") });

    assert.equal(result.archived, 1);
    assert.equal(existsSync(stoppedDir), false);
    assert.ok(result.archiveDir && existsSync(join(result.archiveDir, "goal-runner-bg-stopped", "runner.log")));
  } finally {
    rmSync(sourceRoot, { recursive: true, force: true });
    rmSync(archiveRoot, { recursive: true, force: true });
  }
});

test("signalPiBackgroundRunners ignores missing pids", () => {
  const result = signalPiBackgroundRunners([
    { runnerDir: "/tmp/missing", configPath: "/tmp/missing/config.json", runnerAlive: false, childAlive: false },
  ], "stop");

  assert.equal(result.operation, "stop");
  assert.equal(result.matched, 1);
  assert.equal(result.signaled, 0);
});
