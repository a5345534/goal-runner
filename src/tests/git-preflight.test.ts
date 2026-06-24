import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  inspectWorkspacePreflight,
  isWorkspaceDirty,
  isWorkspaceRootDirty,
  isWorkspaceSubmoduleDirty,
  type GitPreflightResult,
} from "../core/index.js";
import { runExecutionWorkspacePreflightGate, type ResolvedWorkspaceBinding } from "../adapters/pi/workspace.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function safeGit(cwd: string, args: string[]): string {
  try {
    return git(cwd, args);
  } catch {
    return "";
  }
}

function createRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "goal-preflight-"));
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "goal@example.test"]);
  git(repo, ["config", "user.name", "Goal Test"]);
  writeFileSync(join(repo, "README.md"), "# fixture\n");
  git(repo, ["add", "README.md"]);
  git(repo, ["commit", "-m", "initial"]);
  return repo;
}

function dirtyFile(repo: string, filename: string, content: string, stage?: boolean) {
  writeFileSync(join(repo, filename), content);
  if (stage) {
    git(repo, ["add", filename]);
  }
}

function commit(repo: string, message: string) {
  git(repo, ["add", "-A"]);
  // Only commit if there's something staged
  const staged = safeGit(repo, ["diff", "--cached", "--name-only"]);
  if (staged.trim()) {
    git(repo, ["commit", "-m", message]);
  }
}

function createSubmoduleFixture() {
  const root = mkdtempSync(join(tmpdir(), "goal-preflight-sm-"));
  const remote = join(root, "sub.git");
  const parent = join(root, "parent");
  const smPath = join(parent, "deps", "sub");

  git(root, ["init", "--bare", remote]);
  // Seed the bare remote with at least one commit so submodule add works
  const seedDir = join(root, "seed");
  mkdirSync(seedDir, { recursive: true });
  git(seedDir, ["init", "-b", "main"]);
  git(seedDir, ["config", "user.email", "goal@example.test"]);
  git(seedDir, ["config", "user.name", "Goal Test"]);
  git(seedDir, ["commit", "--allow-empty", "-m", "seed"]);
  git(seedDir, ["remote", "add", "origin", remote]);
  git(seedDir, ["push", "origin", "main"]);
  rmSync(seedDir, { recursive: true, force: true });

  mkdirSync(parent, { recursive: true });
  git(parent, ["init", "-b", "main"]);
  git(parent, ["config", "user.email", "goal@example.test"]);
  git(parent, ["config", "user.name", "Goal Test"]);
  git(parent, ["commit", "--allow-empty", "-m", "initial"]);

  // Create a cloned submodule (allow file:// protocol for local test repos)
  git(parent, ["-c", "protocol.file.allow=always", "submodule", "add", "-b", "main", remote, "deps/sub"]);
  git(parent, ["commit", "-m", "add submodule"]);

  const sha = git(parent, ["rev-parse", "HEAD:deps/sub"]);

  return { root, remote, parent, smPath, sha };
}

// ── Core inspector tests ──

test("inspectWorkspacePreflight returns not-in-git-repo for non-git directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "goal-preflight-nogit-"));
  try {
    const result = inspectWorkspacePreflight(dir);
    assert.equal(result.inGitRepo, false);
    assert.equal(result.clean, false);
    assert.match(result.summary, /not a Git repository/);
    assert.equal(result.entries.length, 0);
    assert.equal(result.rootEntries.length, 0);
    assert.equal(result.error, "not a Git repository");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("inspectWorkspacePreflight reports clean workspace correctly", () => {
  const repo = createRepo();
  try {
    const result = inspectWorkspacePreflight(repo);
    assert.equal(result.inGitRepo, true);
    assert.equal(result.clean, true);
    assert.equal(result.summary, "clean");
    assert.equal(result.entries.length, 0);
    assert.equal(result.rootEntries.length, 0);
    assert.equal(result.workspace.detached, false);
    assert.equal(result.workspace.branch, "main");
    assert.ok(result.workspace.head);
    assert.match(result.workspace.headDescription, /branch main @ [a-f0-9]{12}/);
    assert.equal(result.submodulePaths.length, 0);
    assert.ok(result.inspectedAt);
    assert.equal(result.error, undefined);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("inspectWorkspacePreflight reports detached HEAD correctly", () => {
  const repo = createRepo();
  try {
    writeFileSync(join(repo, "f2.txt"), "second\n");
    git(repo, ["add", "f2.txt"]);
    git(repo, ["commit", "-m", "second"]);
    // Checkout first commit to detach
    const firstSha = git(repo, ["rev-parse", "HEAD~1"]);
    git(repo, ["checkout", "--detach", firstSha]);

    const result = inspectWorkspacePreflight(repo);
    assert.equal(result.workspace.detached, true);
    assert.equal(result.workspace.branch, undefined);
    assert.match(result.workspace.headDescription, /detached HEAD @ [a-f0-9]{12}/);
    assert.ok(result.workspace.head);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("inspectWorkspacePreflight detects unstaged root changes", () => {
  const repo = createRepo();
  try {
    dirtyFile(repo, "unstaged.txt", "hello");

    const result = inspectWorkspacePreflight(repo);
    assert.equal(result.clean, false);
    assert.equal(result.rootEntries.length, 1);
    assert.equal(result.entries.length, 1);

    const entry = result.rootEntries[0]!;
    assert.equal(entry.path, "unstaged.txt");
    assert.equal(entry.kind, "root-untracked");
    assert.equal(entry.worktreeStatus, "?");

    assert.match(result.summary, /1 untracked root file/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("inspectWorkspacePreflight detects staged root changes", () => {
  const repo = createRepo();
  try {
    dirtyFile(repo, "staged.txt", "staged content", true);

    const result = inspectWorkspacePreflight(repo);
    assert.equal(result.clean, false);
    assert.equal(result.rootEntries.length, 1);

    const entry = result.rootEntries[0]!;
    assert.equal(entry.path, "staged.txt");
    assert.equal(entry.kind, "root-staged");
    assert.equal(entry.indexStatus, "A");
    assert.equal(entry.worktreeStatus, " ");

    assert.match(result.summary, /1 staged root change/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("inspectWorkspacePreflight detects modified tracked files", () => {
  const repo = createRepo();
  try {
    writeFileSync(join(repo, "README.md"), "# modified\n");

    const result = inspectWorkspacePreflight(repo);
    assert.equal(result.clean, false);
    assert.equal(result.rootEntries.length, 1);

    const entry = result.rootEntries[0]!;
    assert.equal(entry.path, "README.md");
    assert.equal(entry.worktreeStatus, "M");
    assert.equal(entry.kind, "root-unstaged");

    assert.match(entry.diagnostic!, /README.md/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("inspectWorkspacePreflight detects deleted files", () => {
  const repo = createRepo();
  try {
    rmSync(join(repo, "README.md"), { force: true });

    const result = inspectWorkspacePreflight(repo);
    assert.equal(result.clean, false);
    assert.equal(result.rootEntries.length, 1);

    const entry = result.rootEntries[0]!;
    assert.equal(entry.path, "README.md");
    assert.equal(entry.worktreeStatus, "D");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("inspectWorkspacePreflight distinguishes staged vs unstaged root entries", () => {
  const repo = createRepo();
  try {
    dirtyFile(repo, "staged.txt", "staged", true);
    dirtyFile(repo, "unstaged.txt", "unstaged");

    const result = inspectWorkspacePreflight(repo);
    assert.equal(result.rootEntries.length, 2);

    const staged = result.rootEntries.find((e) => e.path === "staged.txt");
    const unstaged = result.rootEntries.find((e) => e.path === "unstaged.txt");

    assert.ok(staged);
    assert.equal(staged.kind, "root-staged");
    assert.ok(unstaged);
    assert.equal(unstaged.kind, "root-untracked");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ── Submodule preflight tests ──

test("inspectWorkspacePreflight detects clean submodule", () => {
  const fixture = createSubmoduleFixture();
  try {
    const result = inspectWorkspacePreflight(fixture.parent);
    assert.equal(result.clean, true);
    assert.equal(result.submodulePaths.length, 1);
    assert.equal(result.submodulePaths[0], "deps/sub");
    assert.ok(result.submoduleStatuses["deps/sub"]);
    const sm = result.submoduleStatuses["deps/sub"]!;
    assert.equal(sm.shaMismatch, false);
    assert.equal(sm.internalDirty, false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("inspectWorkspacePreflight detects submodule gitlink change", () => {
  const fixture = createSubmoduleFixture();
  try {
    // Make a new commit in the submodule
    writeFileSync(join(fixture.smPath, "feature.txt"), "feature work");
    git(fixture.smPath, ["add", "feature.txt"]);
    git(fixture.smPath, ["commit", "-m", "feature"]);
    const newSha = git(fixture.smPath, ["rev-parse", "HEAD"]);

    // Checkout the new SHA in the parent's submodule (gitlink is now different)
    git(fixture.parent, ["add", "deps/sub"]);
    // Actually, git status should already show this as changed

    const result = inspectWorkspacePreflight(fixture.parent);

    // The submodule should show as dirty - gitlink changed
    const sm = result.submoduleStatuses["deps/sub"];
    assert.ok(sm);
    assert.equal(sm.shaMismatch, true);
    assert.match(result.summary, /dirty submodule/);

    // But the submodule's own worktree should be clean (we committed)
    assert.equal(sm.internalDirty, false);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("inspectWorkspacePreflight detects staged submodule gitlink change", () => {
  const fixture = createSubmoduleFixture();
  try {
    writeFileSync(join(fixture.smPath, "feature.txt"), "feature");
    git(fixture.smPath, ["add", "feature.txt"]);
    git(fixture.smPath, ["commit", "-m", "feature"]);

    // Stage the gitlink change in parent (don't commit)
    git(fixture.parent, ["add", "deps/sub"]);

    const result = inspectWorkspacePreflight(fixture.parent);
    const sm = result.submoduleStatuses["deps/sub"];
    assert.ok(sm);
    assert.equal(sm.shaMismatch, true);

    const gitlinkEntry = sm.gitlinkEntry;
    assert.ok(gitlinkEntry);
    assert.equal(gitlinkEntry.kind, "submodule-gitlink-staged");
    assert.match(gitlinkEntry.diagnostic!, /staged in index/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("inspectWorkspacePreflight detects submodule internal dirtiness", () => {
  const fixture = createSubmoduleFixture();
  try {
    // Create an uncommitted file inside the submodule
    writeFileSync(join(fixture.smPath, "dirty-internal.txt"), "uncommitted work");

    const result = inspectWorkspacePreflight(fixture.parent);
    const sm = result.submoduleStatuses["deps/sub"];
    assert.ok(sm);
    assert.equal(sm.internalDirty, true);
    assert.equal(sm.internalEntries.length, 1);

    const internal = sm.internalEntries[0]!;
    assert.equal(internal.kind, "submodule-internal");
    assert.equal(internal.submodulePath, "deps/sub");
    assert.match(internal.path, /deps\/sub\/dirty-internal.txt/);
    assert.match(internal.diagnostic!, /internal worktree dirtiness/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("inspectWorkspacePreflight detects both gitlink and internal submodule dirtiness", () => {
  const fixture = createSubmoduleFixture();
  try {
    // Make new commit AND leave uncommitted file
    writeFileSync(join(fixture.smPath, "committed.txt"), "committed");
    git(fixture.smPath, ["add", "committed.txt"]);
    git(fixture.smPath, ["commit", "-m", "committed"]);

    writeFileSync(join(fixture.smPath, "dirty.txt"), "uncommitted");

    // Stage the gitlink change in parent
    git(fixture.parent, ["add", "deps/sub"]);

    const result = inspectWorkspacePreflight(fixture.parent);
    const sm = result.submoduleStatuses["deps/sub"];
    assert.ok(sm);
    assert.equal(sm.shaMismatch, true);
    assert.equal(sm.internalDirty, true);

    // Should have both kinds of entries
    const gitlinkEntries = result.entries.filter((e) => e.kind.startsWith("submodule-gitlink"));
    const internalEntries = result.entries.filter((e) => e.kind === "submodule-internal");
    assert.ok(gitlinkEntries.length >= 1);
    assert.ok(internalEntries.length >= 1);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("inspectWorkspacePreflight distinguishes root and submodule entries", () => {
  const fixture = createSubmoduleFixture();
  try {
    // Root dirtiness
    dirtyFile(fixture.parent, "root-dirty.txt", "root change");

    // Submodule internal dirtiness
    writeFileSync(join(fixture.smPath, "sm-dirty.txt"), "sm change");

    const result = inspectWorkspacePreflight(fixture.parent);

    assert.ok(result.rootEntries.length >= 1);
    const rootEntry = result.rootEntries.find((e) => e.path === "root-dirty.txt");
    assert.ok(rootEntry);
    assert.equal(rootEntry.kind, "root-untracked");

    const internalEntries = result.entries.filter((e) => e.kind === "submodule-internal");
    assert.ok(internalEntries.length >= 1);
    assert.match(internalEntries[0]!.path, /deps\/sub\//);

    // Summary should mention both
    assert.match(result.summary, /root/);
    assert.match(result.summary, /submodule/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

// ── Convenience function tests ──

test("isWorkspaceDirty returns true for dirty workspace", () => {
  const repo = createRepo();
  try {
    assert.equal(isWorkspaceDirty(repo), false);
    dirtyFile(repo, "new.txt", "new");
    assert.equal(isWorkspaceDirty(repo), true);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("isWorkspaceDirty returns true for dirty submodule", () => {
  const fixture = createSubmoduleFixture();
  try {
    assert.equal(isWorkspaceDirty(fixture.parent), false);
    writeFileSync(join(fixture.smPath, "dirty.txt"), "dirty");
    assert.equal(isWorkspaceDirty(fixture.parent), true);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("isWorkspaceRootDirty ignores submodule-only dirtiness", () => {
  const fixture = createSubmoduleFixture();
  try {
    assert.equal(isWorkspaceRootDirty(fixture.parent), false);
    // Make submodule dirty only
    writeFileSync(join(fixture.smPath, "dirty.txt"), "dirty");
    assert.equal(isWorkspaceRootDirty(fixture.parent), false);

    // Now make root dirty
    dirtyFile(fixture.parent, "root-dirty.txt", "root");
    assert.equal(isWorkspaceRootDirty(fixture.parent), true);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("isWorkspaceSubmoduleDirty returns true only for submodule dirtiness", () => {
  const fixture = createSubmoduleFixture();
  try {
    assert.equal(isWorkspaceSubmoduleDirty(fixture.parent), false);

    // Root-only dirtiness should NOT trigger submodule dirty
    dirtyFile(fixture.parent, "root-dirty.txt", "root");
    assert.equal(isWorkspaceSubmoduleDirty(fixture.parent), false);

    // Now make submodule dirty
    writeFileSync(join(fixture.smPath, "dirty.txt"), "dirty");
    assert.equal(isWorkspaceSubmoduleDirty(fixture.parent), true);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

// ── Structural tests ──

test("entries always have diagnostic and action-relevant fields", () => {
  const repo = createRepo();
  try {
    dirtyFile(repo, "staged.txt", "staged", true);
    dirtyFile(repo, "unstaged.txt", "unstaged");

    const result = inspectWorkspacePreflight(repo);

    for (const entry of result.entries) {
      assert.ok(entry.kind, `entry ${entry.path} missing kind`);
      assert.ok(entry.xy.length === 2, `entry ${entry.path} missing valid xy`);
      assert.ok(typeof entry.raw === "string" && entry.raw.length > 0, `entry ${entry.path} missing raw`);
      assert.ok(typeof entry.diagnostic === "string" && entry.diagnostic.length > 0, `entry ${entry.path} missing diagnostic`);
      assert.ok(typeof entry.path === "string" && entry.path.length > 0, `entry ${entry.path} missing path`);
    }

    // Verify result structure
    assert.ok(result.workspacePath);
    assert.ok(result.repoRoot);
    assert.ok(result.inGitRepo);
    assert.ok(result.inspectedAt);
    assert.equal(typeof result.clean, "boolean");
    assert.equal(typeof result.summary, "string");
    assert.ok(result.submoduleStatuses && typeof result.submoduleStatuses === "object");
    assert.ok(Array.isArray(result.submodulePaths));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("result fields are populated for all entry types", () => {
  const fixture = createSubmoduleFixture();
  try {
    dirtyFile(fixture.parent, "root-staged.txt", "staged", true);
    dirtyFile(fixture.parent, "root-unstaged.txt", "unstaged");
    writeFileSync(join(fixture.smPath, "sm-dirty.txt"), "dirty");

    const result = inspectWorkspacePreflight(fixture.parent);

    // Each entry should have a kind and diagnostic
    const kinds = result.entries.map((e) => e.kind);
    assert.ok(kinds.includes("root-staged"));
    assert.ok(kinds.includes("root-untracked"));
    assert.ok(kinds.includes("submodule-internal"));

    for (const entry of result.entries) {
      assert.ok(entry.diagnostic && entry.diagnostic.length > 0,
        `${entry.path} (kind=${entry.kind}) should have a non-empty diagnostic`);
    }
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

// ── Edge cases ──

test("inspectWorkspacePreflight handles empty repo after init", () => {
  const dir = mkdtempSync(join(tmpdir(), "goal-preflight-empty-"));
  try {
    git(dir, ["init", "-b", "main"]);
    git(dir, ["config", "user.email", "goal@example.test"]);
    git(dir, ["config", "user.name", "Goal Test"]);
    // No commits yet — HEAD doesn't exist

    const result = inspectWorkspacePreflight(dir);
    assert.equal(result.inGitRepo, true);
    // Empty repo with no HEAD may have branch but no head commit
    assert.ok(result.workspace.headDescription.length > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("inspectWorkspacePreflight reports error string undefined for clean repo", () => {
  const repo = createRepo();
  try {
    const result = inspectWorkspacePreflight(repo);
    assert.equal(result.error, undefined);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ── Submodule summary tests ──

test("summary includes submodule path and dirtiness description", () => {
  const fixture = createSubmoduleFixture();
  try {
    writeFileSync(join(fixture.smPath, "internal.txt"), "dirty");
    git(fixture.parent, ["add", "deps/sub"]);

    const result = inspectWorkspacePreflight(fixture.parent);
    assert.match(result.summary, /deps\/sub/);
    assert.match(result.summary, /dirty submodule/);
    assert.match(result.summary, /gitlink changed/);
    assert.match(result.summary, /internal dirty/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────
// Execution workspace preflight gate regression tests
// ─────────────────────────────────────────────────────────────────

function makeBinding(workspace: string): ResolvedWorkspaceBinding {
  return { workspace, branch: undefined, ref: undefined };
}

test("runExecutionWorkspacePreflightGate passes for clean execution workspace", () => {
  const repo = createRepo();
  try {
    const binding = makeBinding(repo);
    const blocked = runExecutionWorkspacePreflightGate(binding, false);
    assert.equal(blocked, undefined, "clean workspace should pass preflight gate");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("runExecutionWorkspacePreflightGate returns undefined for undefined workspace", () => {
  const blocked = runExecutionWorkspacePreflightGate({ workspace: "" }, false);
  assert.equal(blocked, undefined);
});

test("runExecutionWorkspacePreflightGate blocks non-git workspace", () => {
  const dir = mkdtempSync(join(tmpdir(), "goal-gate-nogit-"));
  try {
    const binding = makeBinding(dir);
    const blocked = runExecutionWorkspacePreflightGate(binding, false);
    assert.ok(blocked, "non-git workspace should block");
    assert.match(blocked!, /not a Git repository/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runExecutionWorkspacePreflightGate blocks explicit workspace with staged root change", () => {
  const repo = createRepo();
  try {
    dirtyFile(repo, "staged.txt", "staged content", true);
    const binding = makeBinding(repo);
    const blocked = runExecutionWorkspacePreflightGate(binding, true);
    assert.ok(blocked, "explicit workspace with staged change should block");
    assert.match(blocked!, /explicit execution workspace has uncommitted changes/);
    assert.match(blocked!, /staged root change/);
    assert.match(blocked!, /staged\.txt/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("runExecutionWorkspacePreflightGate blocks explicit workspace with unstaged root change", () => {
  const repo = createRepo();
  try {
    writeFileSync(join(repo, "README.md"), "# modified\n");
    const binding = makeBinding(repo);
    const blocked = runExecutionWorkspacePreflightGate(binding, true);
    assert.ok(blocked, "explicit workspace with unstaged change should block");
    assert.match(blocked!, /explicit execution workspace has uncommitted changes/);
    assert.match(blocked!, /unstaged root change/);
    assert.match(blocked!, /README\.md/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("runExecutionWorkspacePreflightGate blocks explicit workspace with untracked file", () => {
  const repo = createRepo();
  try {
    dirtyFile(repo, "untracked.txt", "untracked");
    const binding = makeBinding(repo);
    const blocked = runExecutionWorkspacePreflightGate(binding, true);
    assert.ok(blocked, "explicit workspace with untracked file should block");
    assert.match(blocked!, /explicit execution workspace has uncommitted changes/);
    assert.match(blocked!, /untracked root file/);
    assert.match(blocked!, /untracked\.txt/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("runExecutionWorkspacePreflightGate blocks explicit workspace with dirty submodule", () => {
  const fixture = createSubmoduleFixture();
  try {
    // Create uncommitted file inside the submodule
    writeFileSync(join(fixture.smPath, "dirty.txt"), "uncommitted");
    const binding = makeBinding(fixture.parent);
    const blocked = runExecutionWorkspacePreflightGate(binding, true);
    assert.ok(blocked, "explicit workspace with dirty submodule should block");
    assert.match(blocked!, /explicit execution workspace has uncommitted changes/);
    assert.match(blocked!, /submodule deps\/sub/);
    assert.match(blocked!, /internal dirty file/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("runExecutionWorkspacePreflightGate blocks explicit workspace with parent gitlink dirty", () => {
  const fixture = createSubmoduleFixture();
  try {
    // Make new commit in submodule (changes the gitlink)
    writeFileSync(join(fixture.smPath, "feature.txt"), "feature");
    git(fixture.smPath, ["add", "feature.txt"]);
    git(fixture.smPath, ["commit", "-m", "feature"]);
    // Stage the gitlink in parent (don't commit)
    git(fixture.parent, ["add", "deps/sub"]);

    const binding = makeBinding(fixture.parent);
    const blocked = runExecutionWorkspacePreflightGate(binding, true);
    assert.ok(blocked, "explicit workspace with parent gitlink dirty should block");
    assert.match(blocked!, /explicit execution workspace has uncommitted changes/);
    assert.match(blocked!, /submodule deps\/sub/);
    assert.match(blocked!, /gitlink changed/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("runExecutionWorkspacePreflightGate passes for clean explicit workspace with clean submodule", () => {
  const fixture = createSubmoduleFixture();
  try {
    const binding = makeBinding(fixture.parent);
    const blocked = runExecutionWorkspacePreflightGate(binding, true);
    assert.equal(blocked, undefined, "clean explicit workspace with clean submodule should pass");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("runExecutionWorkspacePreflightGate auto-allocated workspace produces distinct diagnostic from explicit", () => {
  const repo = createRepo();
  try {
    dirtyFile(repo, "dirty.txt", "dirty");
    const binding = makeBinding(repo);

    const explicitBlocked = runExecutionWorkspacePreflightGate(binding, true);
    const autoBlocked = runExecutionWorkspacePreflightGate(binding, false);

    assert.ok(explicitBlocked, "explicit should block");
    assert.ok(autoBlocked, "auto-allocated should block");

    // Confirm distinct diagnostic messages
    assert.match(explicitBlocked!, /explicit execution workspace has uncommitted changes/);
    assert.doesNotMatch(explicitBlocked!, /auto-allocated/);

    assert.match(autoBlocked!, /auto-allocated execution workspace/);
    assert.match(autoBlocked!, /unexpected uncommitted changes/);
    assert.doesNotMatch(autoBlocked!, /explicit execution workspace/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────
// Preflight inspector read-only guarantee (no automatic repair)
// ─────────────────────────────────────────────────────────────────

test("inspectWorkspacePreflight does not mutate workspace state (no automatic repair)", () => {
  const repo = createRepo();
  try {
    // Introduce dirtiness
    dirtyFile(repo, "dirty.txt", "should not be cleaned");
    const dirtySHA = safeGit(repo, ["rev-parse", "HEAD"]);

    // Capture git status before preflight
    const beforeStatus = safeGit(repo, ["status", "--porcelain=v1"]);

    // Run preflight
    inspectWorkspacePreflight(repo);

    // Capture git status after preflight
    const afterStatus = safeGit(repo, ["status", "--porcelain=v1"]);
    const afterSHA = safeGit(repo, ["rev-parse", "HEAD"]);

    // Verify no mutating operations were performed
    assert.equal(afterStatus, beforeStatus, "preflight must not modify git working tree");
    assert.equal(afterSHA, dirtySHA, "preflight must not modify HEAD");
    assert.ok(existsSync(join(repo, "dirty.txt")), "dirty file must still exist after preflight");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("inspectWorkspacePreflight does not repair submodule dirtiness (no automatic repair)", () => {
  const fixture = createSubmoduleFixture();
  try {
    // Make submodule dirty
    writeFileSync(join(fixture.smPath, "dirty-internal.txt"), "dirty");
    const beforeSmStatus = safeGit(fixture.smPath, ["status", "--porcelain=v1"]);
    const beforeParentSHA = safeGit(fixture.parent, ["rev-parse", "HEAD"]);

    // Run preflight on parent
    inspectWorkspacePreflight(fixture.parent);

    // Verify no mutating operations were performed
    const afterSmStatus = safeGit(fixture.smPath, ["status", "--porcelain=v1"]);
    const afterParentSHA = safeGit(fixture.parent, ["rev-parse", "HEAD"]);

    assert.equal(afterSmStatus, beforeSmStatus, "preflight must not clean submodule working tree");
    assert.equal(afterParentSHA, beforeParentSHA, "preflight must not modify parent HEAD");
    assert.ok(existsSync(join(fixture.smPath, "dirty-internal.txt")), "dirty submodule file must still exist");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("runExecutionWorkspacePreflightGate does not mutate workspace on block (preserves later Git safety checks)", () => {
  const repo = createRepo();
  try {
    dirtyFile(repo, "dirty.txt", "dirty");
    const beforeSHA = safeGit(repo, ["rev-parse", "HEAD"]);
    const beforeStatus = safeGit(repo, ["status", "--porcelain=v1"]);

    // Run the gate (should block)
    const blocked = runExecutionWorkspacePreflightGate(makeBinding(repo), true);
    assert.ok(blocked, "gate should block dirty workspace");

    // Verify workspace state is preserved for later checks
    const afterSHA = safeGit(repo, ["rev-parse", "HEAD"]);
    const afterStatus = safeGit(repo, ["status", "--porcelain=v1"]);
    assert.equal(afterSHA, beforeSHA, "gate must not change HEAD");
    assert.equal(afterStatus, beforeStatus, "gate must not clean workspace");
    assert.ok(existsSync(join(repo, "dirty.txt")), "dirty file must persist");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────
// Distinct diagnostic coverage for each dirtiness category
// ─────────────────────────────────────────────────────────────────

test("runExecutionWorkspacePreflightGate produces distinct diagnostic for staged vs unstaged vs untracked", () => {
  const repo = createRepo();
  try {
    // Case 1: only staged
    dirtyFile(repo, "staged-only.txt", "staged", true);
    const stagedBlocked = runExecutionWorkspacePreflightGate(makeBinding(repo), true);
    assert.match(stagedBlocked!, /staged root change/);

    // Clean up and test unstaged-only
    git(repo, ["checkout", "--", "staged-only.txt"]);
    writeFileSync(join(repo, "README.md"), "# modified unstaged\n");
    const unstagedBlocked = runExecutionWorkspacePreflightGate(makeBinding(repo), true);
    assert.match(unstagedBlocked!, /unstaged root change/);

    // Clean up and test untracked-only
    git(repo, ["checkout", "--", "README.md"]);
    dirtyFile(repo, "untracked-only.txt", "untracked");
    const untrackedBlocked = runExecutionWorkspacePreflightGate(makeBinding(repo), true);
    assert.match(untrackedBlocked!, /untracked root file/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("runExecutionWorkspacePreflightGate diagnostic includes counts and paths for multiple dirty entries", () => {
  const repo = createRepo();
  try {
    // Staged: explicitly added to index
    dirtyFile(repo, "staged.txt", "staged", true);
    // Unstaged: modify a tracked file without staging
    writeFileSync(join(repo, "README.md"), "# modified unstaged\n");
    // Untracked: new files not in index
    dirtyFile(repo, "untracked-a.txt", "a");
    dirtyFile(repo, "untracked-b.txt", "b");

    const blocked = runExecutionWorkspacePreflightGate(makeBinding(repo), true);
    assert.ok(blocked);
    // Verify all three kinds are mentioned with their file paths
    assert.match(blocked!, /staged root change/);
    assert.match(blocked!, /staged\.txt/);
    assert.match(blocked!, /unstaged root change/);
    assert.match(blocked!, /README\.md/);
    assert.match(blocked!, /untracked root file/);
    assert.match(blocked!, /untracked-a\.txt/);
    assert.match(blocked!, /untracked-b\.txt/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────
// Clean submodule integration gate pass
// ─────────────────────────────────────────────────────────────────

test("runExecutionWorkspacePreflightGate allows clean explicit workspace even when submodules exist", () => {
  const fixture = createSubmoduleFixture();
  try {
    const binding = makeBinding(fixture.parent);
    const blocked = runExecutionWorkspacePreflightGate(binding, true);
    assert.equal(blocked, undefined, "explicit workspace with clean submodules should pass preflight gate");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────
// Auto-created controller workspace behavior
// ─────────────────────────────────────────────────────────────────

test("runExecutionWorkspacePreflightGate passes for auto-allocated clean workspace without controller-start concerns", () => {
  const repo = createRepo();
  try {
    const binding = makeBinding(repo);
    // isExplicitWorkspace = false: auto-allocated mode
    const blocked = runExecutionWorkspacePreflightGate(binding, false);
    assert.equal(blocked, undefined, "auto-allocated clean workspace should pass preflight");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("runExecutionWorkspacePreflightGate auto-allocated diagnostic suggests stale worktree or dirty base ref", () => {
  const repo = createRepo();
  try {
    dirtyFile(repo, "unexpected.txt", "unexpected");
    const binding = makeBinding(repo);
    const blocked = runExecutionWorkspacePreflightGate(binding, false);
    assert.ok(blocked);
    assert.match(blocked!, /auto-allocated execution workspace/);
    assert.match(blocked!, /unexpected uncommitted changes/);
    assert.match(blocked!, /Check for stale worktrees or dirty base refs/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────
// Preflight gate preserves later Git safety checks
// ─────────────────────────────────────────────────────────────────

test("preflight passes for clean repo and git status remains accessible afterward", () => {
  const repo = createRepo();
  try {
    const result = inspectWorkspacePreflight(repo);
    assert.equal(result.clean, true);

    // Git status remains functional after preflight
    const statusOutput = safeGit(repo, ["status", "--porcelain=v1"]);
    assert.equal(statusOutput, "", "repo should still be clean after preflight");

    // Git log is still accessible
    const logOutput = safeGit(repo, ["log", "--oneline"]);
    assert.ok(logOutput.length > 0, "git log should still work after preflight");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("preflight blocks dirty workspace but leaves it intact for later inspection and repair", () => {
  const repo = createRepo();
  try {
    dirtyFile(repo, "pending.txt", "pending work");
    const blockingMessage = runExecutionWorkspacePreflightGate(makeBinding(repo), true);
    assert.ok(blockingMessage);

    // Workspace state is left intact — caller can inspect and repair
    const dirty = isWorkspaceDirty(repo);
    assert.equal(dirty, true, "workspace remains dirty after blocked preflight");

    // Caller can commit to repair
    git(repo, ["add", "pending.txt"]);
    git(repo, ["commit", "-m", "resolve dirtiness"]);
    const clean = isWorkspaceDirty(repo);
    assert.equal(clean, false, "workspace should be clean after manual repair");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────
// Nested submodule and complex dirtiness scenarios
// ─────────────────────────────────────────────────────────────────

test("inspectWorkspacePreflight reports multiple kinds of dirtiness with distinct diagnostics", () => {
  const fixture = createSubmoduleFixture();
  try {
    // Root unstaged: the submodule fixture parent used --allow-empty for initial
    // commit, so there is no README.md to modify. Create a tracked file, then
    // modify it unstaged. Do this BEFORE staging so the commit doesn't consume
    // the staged root entry.
    writeFileSync(join(fixture.parent, "tracked.txt"), "initial");
    git(fixture.parent, ["add", "tracked.txt"]);
    git(fixture.parent, ["commit", "-m", "add tracked file"]);
    writeFileSync(join(fixture.parent, "tracked.txt"), "# modified unstaged\n");
    // Root staged: stage AFTER the commit so it stays staged
    dirtyFile(fixture.parent, "root-staged.txt", "root staged", true);
    // Root untracked
    dirtyFile(fixture.parent, "root-untracked.txt", "root untracked");
    // Submodule internal
    writeFileSync(join(fixture.smPath, "sm-internal.txt"), "sm internal");

    const result = inspectWorkspacePreflight(fixture.parent);
    assert.equal(result.clean, false);

    // Verify distinct diagnostics per entry kind
    const stagedEntries = result.rootEntries.filter((e) => e.kind === "root-staged");
    const unstagedEntries = result.rootEntries.filter((e) => e.kind === "root-unstaged");
    const untrackedEntries = result.rootEntries.filter((e) => e.kind === "root-untracked");
    const internalEntries = result.entries.filter((e) => e.kind === "submodule-internal");

    assert.equal(stagedEntries.length, 1, "should have exactly 1 staged root entry");
    assert.ok(unstagedEntries.length >= 1, "should have at least 1 unstaged root entry");
    assert.ok(untrackedEntries.length >= 1, "should have at least 1 untracked root entry");
    assert.ok(internalEntries.length >= 1, "should have at least 1 submodule internal entry");

    // Each entry type has a distinct diagnostic
    for (const entry of stagedEntries) {
      assert.match(entry.diagnostic!, /staged/);
    }
    for (const entry of unstagedEntries) {
      assert.match(entry.diagnostic!, /worktree has/);
    }
    for (const entry of untrackedEntries) {
      assert.match(entry.diagnostic!, /untracked/);
    }
    for (const entry of internalEntries) {
      assert.match(entry.diagnostic!, /internal worktree dirtiness/);
      assert.ok(entry.submodulePath, "submodule internal entry must have submodulePath");
    }
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("runExecutionWorkspacePreflightGate does not confuse invocation-cwd dirtiness with execution workspace", () => {
  // Create two repos — one "invocation" and one "execution"
  const invocationRepo = createRepo();
  const executionRepo = createRepo();
  try {
    // Dirty the invocation repo (where /goal was typed)
    dirtyFile(invocationRepo, "typezone-dirty.txt", "work in progress");

    // Execution workspace is clean
    const binding = makeBinding(executionRepo);
    const blocked = runExecutionWorkspacePreflightGate(binding, false);
    assert.equal(blocked, undefined,
      "execution workspace preflight must not be affected by invocation-cwd dirtiness");
  } finally {
    rmSync(invocationRepo, { recursive: true, force: true });
    rmSync(executionRepo, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────
// Preflight gate blocked return signals "no controller/subagent start"
// ─────────────────────────────────────────────────────────────────

test("runExecutionWorkspacePreflightGate returns blocking string when dirty — caller must not start controller", () => {
  const repo = createRepo();
  try {
    dirtyFile(repo, "blocking.txt", "this should prevent start");

    const blocked = runExecutionWorkspacePreflightGate(makeBinding(repo), true);
    assert.ok(blocked, "gate must return a blocking diagnostic string");
    assert.equal(typeof blocked, "string");
    assert.ok(blocked!.length > 0);

    // In production, the adapter throws: `throw new Error(preflightBlocked)`
    // When blocked is non-undefined, the controller/subagent must NOT be started.
    // The caller must check the result and block the start.
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────
// Preflight gate combined dirtiness (root + submodule) full block
// ─────────────────────────────────────────────────────────────────

test("runExecutionWorkspacePreflightGate blocks explicit workspace with both root and submodule dirtiness", () => {
  const fixture = createSubmoduleFixture();
  try {
    // Root dirtiness
    dirtyFile(fixture.parent, "root-dirty.txt", "root dirty");
    // Submodule internal dirtiness
    writeFileSync(join(fixture.smPath, "sm-dirty.txt"), "sm dirty");

    const binding = makeBinding(fixture.parent);
    const blocked = runExecutionWorkspacePreflightGate(binding, true);

    assert.ok(blocked, "combined root and submodule dirtiness should block");
    assert.match(blocked!, /explicit execution workspace has uncommitted changes/);
    assert.match(blocked!, /untracked root file/);
    assert.match(blocked!, /submodule deps\/sub/);
    assert.match(blocked!, /internal dirty file/);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
