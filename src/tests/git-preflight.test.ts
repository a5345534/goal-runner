import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  inspectWorkspacePreflight,
  isWorkspaceDirty,
  isWorkspaceRootDirty,
  isWorkspaceSubmoduleDirty,
  type GitPreflightResult,
} from "../core/index.js";

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
