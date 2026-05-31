import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  parseGoalWorkspaceFlags,
  parseWorkspaceProfileCommand,
  resolveWorkspaceBinding,
  validateExecutionWorkspace,
} from "../adapters/pi/workspace.js";
import type { WorkspaceProfile } from "../core/index.js";

test("parses inline workspace and branch flags", () => {
  const parsed = parseGoalWorkspaceFlags('--workspace ./prepared --branch feat/a implement "the migration"');

  assert.deepEqual(parsed, {
    workspace: "./prepared",
    branch: "feat/a",
    ref: undefined,
    remainingArgs: "implement the migration",
  });
});

test("resolves workspace profiles before paths and allows inline branch override", () => {
  const profile: WorkspaceProfile = {
    name: "migration",
    path: "/profiles/migration",
    kind: "git",
    branch: "feat/profile",
    createdAt: "2026-05-31T00:00:00.000Z",
    updatedAt: "2026-05-31T00:00:00.000Z",
  };

  const resolved = resolveWorkspaceBinding({ workspace: "migration", branch: "feat/override" }, [profile], "/cwd");

  assert.deepEqual(resolved, {
    workspace: "/profiles/migration",
    branch: "feat/override",
    ref: undefined,
    profileName: "migration",
  });
});

test("parses workspace profile add command", () => {
  const command = parseWorkspaceProfileCommand(
    "workspace add migration --path ./prepared --branch feat/a",
    "/controller",
  );

  assert.deepEqual(command, {
    kind: "add",
    profile: {
      name: "migration",
      path: "/controller/prepared",
      kind: "git",
      branch: "feat/a",
      ref: undefined,
    },
  });
});

test("validates non-git workspace without branch", () => {
  const dir = mkdtempSync(join(tmpdir(), "goal-non-git-"));
  try {
    const validation = validateExecutionWorkspace({ workspace: dir });

    assert.equal(validation.ok, true);
    assert.equal(validation.isGit, false);
    assert.equal(validation.branchVerificationStatus, "notApplicable");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rejects missing workspace without creating it", () => {
  const dir = join(tmpdir(), `goal-missing-${Date.now()}`);

  const validation = validateExecutionWorkspace({ workspace: dir, branch: "feat/a" });

  assert.equal(validation.ok, false);
  assert.equal(validation.workspaceStatus, "missing");
});

test("rejects workspaces outside configured allowed roots", () => {
  const allowed = mkdtempSync(join(tmpdir(), "goal-allowed-"));
  const outside = mkdtempSync(join(tmpdir(), "goal-outside-"));
  const previous = process.env.AGENT_GOAL_ALLOWED_WORKSPACE_ROOTS;
  process.env.AGENT_GOAL_ALLOWED_WORKSPACE_ROOTS = allowed;
  try {
    const validation = validateExecutionWorkspace({ workspace: outside });

    assert.equal(validation.ok, false);
    assert.equal(validation.workspaceStatus, "notAllowed");
  } finally {
    if (previous === undefined) delete process.env.AGENT_GOAL_ALLOWED_WORKSPACE_ROOTS;
    else process.env.AGENT_GOAL_ALLOWED_WORKSPACE_ROOTS = previous;
    rmSync(allowed, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("validates git workspace branch by read-only inspection", () => {
  const dir = mkdtempSync(join(tmpdir(), "goal-git-"));
  try {
    execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
    execFileSync("git", ["checkout", "-b", "feat/a"], { cwd: dir, stdio: "ignore" });

    const ok = validateExecutionWorkspace({ workspace: dir, branch: "feat/a" });
    const mismatch = validateExecutionWorkspace({ workspace: dir, branch: "feat/b" });

    assert.equal(ok.ok, true);
    assert.equal(ok.branchVerificationStatus, "verified");
    assert.equal(mismatch.ok, false);
    assert.equal(mismatch.branchVerificationStatus, "mismatch");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
