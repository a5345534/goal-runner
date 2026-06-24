export type GitPreflightEntryKind = "root-staged" | "root-unstaged" | "root-untracked" | "submodule-gitlink-staged" | "submodule-gitlink-unstaged" | "submodule-internal";
export type GitPreflightEntryStatus = "M" | "A" | "D" | "R" | "C" | "U" | "?" | "!" | "T" | "X";
export interface GitPreflightEntry {
    /** The path relative to the workspace root. */
    path: string;
    /** Kind classification of this entry. */
    kind: GitPreflightEntryKind;
    /** Index (staging area) status: ' ' = unmodified, 'M' = modified, 'A' = added, 'D' = deleted, etc. */
    indexStatus: GitPreflightEntryStatus | " ";
    /** Worktree status: ' ' = unmodified, 'M' = modified, 'D' = deleted, '?' = untracked, etc. */
    worktreeStatus: GitPreflightEntryStatus | " ";
    /** The XY status code pair from `git status --porcelain=v1`. */
    xy: string;
    /** Original porcelain line, useful for debugging. */
    raw: string;
    /** For renamed/copied entries, the original path. */
    oldPath?: string;
    /** For submodule gitlink entries, the containing submodule path. */
    submodulePath?: string;
    /** Diagnostic message for this entry, if actionable. */
    diagnostic?: string;
}
export interface GitPreflightSubmoduleStatus {
    path: string;
    /** The SHA recorded in the parent repo's gitlink (the expected SHA). */
    expectedSha?: string;
    /** The SHA currently checked out in the submodule worktree. */
    currentSha?: string;
    /** Whether the submodule gitlink differs from the expected SHA. */
    shaMismatch: boolean;
    /** Whether the submodule has uncommitted changes in its own worktree. */
    internalDirty: boolean;
    /** Dirty entries within this submodule's worktree. */
    internalEntries: GitPreflightEntry[];
    /** The gitlink entry from the parent status, if present. */
    gitlinkEntry?: GitPreflightEntry;
}
export interface GitPreflightWorkspaceState {
    /** Current branch name, or undefined if detached HEAD. */
    branch?: string;
    /** Current HEAD SHA. */
    head?: string;
    /** Whether HEAD is detached. */
    detached: boolean;
    /** Human-readable HEAD description. */
    headDescription: string;
}
export interface GitPreflightResult {
    /** The workspace path that was inspected. */
    workspacePath: string;
    /** Repository root (from git rev-parse --show-toplevel). */
    repoRoot: string;
    /** Whether the workspace is inside a Git repository. */
    inGitRepo: boolean;
    /** Overall summary: "clean" or describes the kinds of dirtiness found. */
    summary: string;
    /** Whether the workspace is clean (no dirtiness anywhere). */
    clean: boolean;
    /** Workspace state (branch, HEAD, detached). */
    workspace: GitPreflightWorkspaceState;
    /** All dirty entries across root and submodules. */
    entries: GitPreflightEntry[];
    /** Root worktree entries (non-submodule paths). */
    rootEntries: GitPreflightEntry[];
    /** Submodule statuses, keyed by submodule path. */
    submoduleStatuses: Record<string, GitPreflightSubmoduleStatus>;
    /** Submodule paths as listed in .gitmodules. */
    submodulePaths: string[];
    /** When the inspection was performed. */
    inspectedAt: string;
    /** Error message if the inspection itself failed (e.g., not a git repo). */
    error?: string;
}
export interface GitPreflightInspectorOptions {
    /** Whether to recurse into nested submodules. Defaults to true. */
    recurseSubmodules?: boolean;
    /** Maximum submodule recursion depth. Defaults to 8. */
    maxSubmoduleDepth?: number;
    /** Whether to include ignored files in the report. Defaults to false. */
    includeIgnored?: boolean;
    /** Whether to include untracked files. Defaults to true. */
    includeUntracked?: boolean;
}
/**
 * Core local Git preflight inspector for the execution root worktree
 * and relevant local submodule worktree/gitlink dirtiness.
 *
 * The inspector runs **only read-only Git commands** and never runs
 * Git-mutating repair commands. It distinguishes:
 *  - Dirty root worktree entries (staged, unstaged, untracked)
 *  - Dirty submodule gitlink entries (the submodule pointer changed)
 *  - Dirty submodule internal entries (files within a submodule worktree changed)
 *
 * Each entry carries actionable diagnostic fields so callers can
 * build repair instructions or block integration/promotion without
 * inspecting raw `git status` output.
 */
export declare function inspectWorkspacePreflight(workspacePath: string, options?: GitPreflightInspectorOptions): GitPreflightResult;
/**
 * Returns true when the workspace has **any** uncommitted changes
 * (root worktree, submodule gitlinks, or submodule internal).
 * Use `inspectWorkspacePreflight` for full diagnostic details.
 */
export declare function isWorkspaceDirty(workspacePath: string): boolean;
/**
 * Returns true when the workspace has root-level uncommitted changes
 * (ignoring submodule internal dirtiness).
 */
export declare function isWorkspaceRootDirty(workspacePath: string): boolean;
/**
 * Returns true when the workspace has any dirty submodule
 * (gitlink changes or internal dirtiness).
 */
export declare function isWorkspaceSubmoduleDirty(workspacePath: string): boolean;
