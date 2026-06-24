import { readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";
// ── Public API ──
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
export function inspectWorkspacePreflight(workspacePath, options = {}) {
    const resolved = resolve(workspacePath);
    const now = new Date().toISOString();
    const recurse = options.recurseSubmodules !== false;
    const maxDepth = options.maxSubmoduleDepth ?? 8;
    const includeUntracked = options.includeUntracked !== false;
    const untrackedFlag = includeUntracked ? "--untracked-files=all" : "--untracked-files=no";
    // Resolve repo root — fail early if not in a Git repo
    const repoRoot = safeGit(resolved, ["rev-parse", "--show-toplevel"]);
    if (!repoRoot) {
        return {
            workspacePath: resolved,
            repoRoot: "",
            inGitRepo: false,
            summary: "not a Git repository",
            clean: false,
            workspace: { detached: true, headDescription: "no repository" },
            entries: [],
            rootEntries: [],
            submoduleStatuses: {},
            submodulePaths: [],
            inspectedAt: now,
            error: "not a Git repository",
        };
    }
    // Workspace state (branch, HEAD)
    const branch = safeGit(resolved, ["branch", "--show-current"]) || undefined;
    const head = safeGit(resolved, ["rev-parse", "--verify", "HEAD"]) || undefined;
    const detached = !branch;
    let headDescription;
    if (branch) {
        headDescription = `branch ${branch} @ ${shortSha(head ?? "unknown")}`;
    }
    else if (head) {
        headDescription = `detached HEAD @ ${shortSha(head)}`;
    }
    else {
        headDescription = "no HEAD";
    }
    const workspace = {
        branch,
        head,
        detached,
        headDescription,
    };
    // Collect submodule paths from .gitmodules and optionally recurse
    const submodulePaths = collectSubmodulePaths(resolved, repoRoot, recurse, maxDepth);
    // Run git status on the parent repo — this gives root entries and gitlink entries.
    // Submodule-internal dirtiness is NOT visible from the parent; we inspect each
    // submodule worktree separately below.
    const parentStatusOutput = safeGit(resolved, ["status", "--porcelain=v1", "--ignore-submodules=none", untrackedFlag]);
    const parentEntries = parsePorcelainStatus(resolved, parentStatusOutput, submodulePaths);
    // Inspect each submodule worktree for internal dirtiness
    const smInternalEntries = collectSubmoduleInternalEntries(repoRoot, submodulePaths, untrackedFlag);
    // Merge entries: parent entries first, then submodule internal entries
    const entries = [...parentEntries, ...smInternalEntries];
    // Build submodule statuses
    const submoduleStatuses = buildSubmoduleStatuses(submodulePaths, entries);
    // Classify entries
    const rootEntries = entries.filter((e) => e.kind.startsWith("root-"));
    // Build summary
    const clean = entries.length === 0;
    const summary = buildPreflightSummary(entries, rootEntries, submoduleStatuses, submodulePaths);
    return {
        workspacePath: resolved,
        repoRoot,
        inGitRepo: true,
        summary,
        clean,
        workspace,
        entries,
        rootEntries,
        submoduleStatuses,
        submodulePaths,
        inspectedAt: now,
    };
}
// ── Internal helpers ──
function collectSubmodulePaths(workspacePath, repoRoot, recurse, maxDepth) {
    const paths = [];
    const gitmodulesPath = join(repoRoot, ".gitmodules");
    if (!existsSync(gitmodulesPath))
        return paths;
    try {
        const config = readFileSync(gitmodulesPath, "utf8");
        const directPaths = parseSubmodulePathsFromGitmodules(config);
        paths.push(...directPaths);
        if (recurse) {
            for (const smPath of directPaths) {
                const smWorktree = join(repoRoot, smPath);
                if (!existsSync(smWorktree))
                    continue;
                const smGitmodules = join(smWorktree, ".gitmodules");
                if (!existsSync(smGitmodules))
                    continue;
                try {
                    const smConfig = readFileSync(smGitmodules, "utf8");
                    const nestedPaths = parseSubmodulePathsFromGitmodules(smConfig);
                    for (const nested of nestedPaths) {
                        const fullPath = `${smPath}/${nested}`;
                        if (paths.includes(fullPath))
                            continue;
                        const depth = fullPath.split("/").filter(Boolean).length;
                        if (depth <= maxDepth)
                            paths.push(fullPath);
                    }
                }
                catch {
                    // Best-effort nested submodule discovery
                }
            }
        }
    }
    catch {
        // Best-effort
    }
    return paths;
}
function collectSubmoduleInternalEntries(repoRoot, submodulePaths, untrackedFlag) {
    const entries = [];
    for (const smPath of submodulePaths) {
        const smWorktree = join(repoRoot, smPath);
        // Only inspect if the worktree exists and is a valid git repo
        if (!existsSync(smWorktree))
            continue;
        const smGitDir = join(smWorktree, ".git");
        if (!existsSync(smGitDir))
            continue;
        const smStatusOutput = safeGit(smWorktree, ["status", "--porcelain=v1", untrackedFlag]);
        if (!smStatusOutput.trim())
            continue;
        const smEntries = parsePorcelainStatus(smWorktree, smStatusOutput, []);
        for (const entry of smEntries) {
            // Reclassify as submodule-internal and prefix path with submodule path
            entry.kind = "submodule-internal";
            entry.submodulePath = smPath;
            entry.path = `${smPath}/${entry.path}`;
            entry.diagnostic = `submodule ${smPath}: internal worktree dirtiness — ${entry.path} (${describePorcelainStatus(entry.indexStatus, entry.worktreeStatus)})`;
        }
        entries.push(...smEntries);
    }
    return entries;
}
function describePorcelainStatus(index, worktree) {
    const parts = [];
    if (index !== " ")
        parts.push(`staged as ${index}`);
    if (worktree !== " ")
        parts.push(`worktree ${worktree === "?" ? "untracked" : worktree}`);
    return parts.join(", ") || "unknown";
}
function parseSubmodulePathsFromGitmodules(config) {
    const paths = [];
    let inSection = false;
    for (const raw of config.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith(";") || line.startsWith("#"))
            continue;
        if (/^\[submodule\s+/.test(line)) {
            inSection = true;
            continue;
        }
        if (line.startsWith("[") && inSection) {
            inSection = false;
            continue;
        }
        if (!inSection)
            continue;
        const eq = line.indexOf("=");
        if (eq === -1)
            continue;
        const key = line.slice(0, eq).trim();
        if (key !== "path")
            continue;
        const value = line.slice(eq + 1).trim();
        if (value && !paths.includes(value))
            paths.push(value);
    }
    return paths;
}
function parsePorcelainStatus(workspacePath, statusOutput, submodulePaths) {
    if (!statusOutput.trim())
        return [];
    // Build an index of submodule paths sorted by depth (deepest first)
    // so we match the most specific submodule path first
    const sortedSmPaths = [...submodulePaths].sort((a, b) => b.split("/").length - a.split("/").length);
    const entries = [];
    const lines = statusOutput.split(/\r?\n/).filter((line) => line.trim());
    for (const line of lines) {
        const parsed = parseStatusLine(line);
        if (!parsed)
            continue;
        // Classify: is this a submodule gitlink or internal entry?
        const smClassification = classifySubmoduleEntry(parsed.path, parsed.xy, sortedSmPaths);
        let entry;
        if (smClassification) {
            entry = {
                path: parsed.path,
                indexStatus: parsed.indexStatus,
                worktreeStatus: parsed.worktreeStatus,
                xy: parsed.xy,
                raw: parsed.raw,
                oldPath: parsed.oldPath,
                kind: smClassification.kind,
                submodulePath: smClassification.submodulePath,
                diagnostic: buildSubmoduleDiagnostic(smClassification),
            };
        }
        else {
            entry = {
                path: parsed.path,
                indexStatus: parsed.indexStatus,
                worktreeStatus: parsed.worktreeStatus,
                xy: parsed.xy,
                raw: parsed.raw,
                oldPath: parsed.oldPath,
                kind: classifyRootKind(parsed),
                diagnostic: buildRootDiagnostic(parsed.path, parsed.indexStatus, parsed.worktreeStatus, parsed.oldPath),
            };
        }
        entries.push(entry);
    }
    return entries;
}
function parseStatusLine(line) {
    // Porcelain v1 format: XY<SPACE><path>
    // Where XY is exactly 2 bytes (index status, worktree status) at positions 0-1,
    // followed by a mandatory space separator at position 2,
    // and the path starts at position 3.
    if (line.length < 4)
        return null;
    const xy = line.slice(0, 2);
    const rawPath = line.slice(3).trim();
    if (!rawPath)
        return null;
    const indexChar = xy[0];
    const worktreeChar = xy[1];
    const indexStatus = porcelainCodeToStatus(indexChar);
    const worktreeStatus = porcelainCodeToStatus(worktreeChar);
    // Handle renames: "R  old -> new"
    let path;
    let oldPath;
    if (worktreeChar === " " && rawPath.includes(" -> ")) {
        // V1 rename format (R with score, like "R085" doesn't exist in V1; V1 uses plain R)
        // Actually V1 renames look like: "R  oldpath -> newpath"
        const arrowIdx = rawPath.indexOf(" -> ");
        if (arrowIdx !== -1) {
            oldPath = rawPath.slice(0, arrowIdx);
            path = rawPath.slice(arrowIdx + 4);
        }
        else {
            path = rawPath;
        }
    }
    else {
        path = rawPath;
        // Strip surrounding quotes that git adds for paths with special chars
        if (path.startsWith('"') && path.endsWith('"')) {
            path = path.slice(1, -1);
        }
    }
    return {
        path,
        indexStatus,
        worktreeStatus,
        xy,
        raw: line,
        oldPath,
        kind: "root-untracked", // default, will be reclassified
    };
}
function classifySubmoduleEntry(entryPath, xy, sortedSmPaths) {
    for (const smPath of sortedSmPaths) {
        if (entryPath === smPath) {
            // Exact match: gitlink entry for this submodule
            const staged = xy[0] !== " ";
            return {
                kind: staged ? "submodule-gitlink-staged" : "submodule-gitlink-unstaged",
                submodulePath: smPath,
            };
        }
        if (entryPath.startsWith(`${smPath}/`)) {
            // File within a submodule
            return {
                kind: "submodule-internal",
                submodulePath: smPath,
            };
        }
    }
    return null;
}
function porcelainCodeToStatus(code) {
    switch (code) {
        case "M": return "M";
        case "A": return "A";
        case "D": return "D";
        case "R": return "R";
        case "C": return "C";
        case "U": return "U";
        case "?": return "?";
        case "!": return "!";
        case "T": return "T";
        case " ": return " ";
        default: return "X";
    }
}
function classifyRootKind(entry) {
    // '?' in the index position means the file is untracked (not in index at all),
    // not that it's staged. Only actual modifications in the index count as staged.
    if (isStagedStatus(entry.indexStatus))
        return "root-staged";
    if (entry.worktreeStatus === "?" || entry.indexStatus === "?")
        return "root-untracked";
    return "root-unstaged";
}
function isStagedStatus(code) {
    return code === "M" || code === "A" || code === "D" || code === "R" || code === "C" || code === "U" || code === "T";
}
function buildRootDiagnostic(path, indexStatus, worktreeStatus, oldPath) {
    const parts = [`root worktree: ${path}`];
    if (indexStatus !== " ")
        parts.push(`staged as ${indexStatus}`);
    if (worktreeStatus !== " ")
        parts.push(`worktree has ${worktreeStatus}`);
    if (oldPath)
        parts.push(`(renamed from ${oldPath})`);
    return parts.join(", ");
}
function buildSubmoduleDiagnostic(classification) {
    const { kind, submodulePath } = classification;
    switch (kind) {
        case "submodule-gitlink-staged":
            return `submodule ${submodulePath}: gitlink change staged in index (will be part of next commit)`;
        case "submodule-gitlink-unstaged":
            return `submodule ${submodulePath}: gitlink change in worktree (different commit checked out or not committed)`;
        case "submodule-internal":
            return `submodule ${submodulePath}: internal worktree dirtiness (file changed within submodule)`;
    }
}
function buildSubmoduleStatuses(submodulePaths, entries) {
    const statuses = {};
    for (const smPath of submodulePaths) {
        const gitlinkEntry = entries.find((e) => e.submodulePath === smPath && e.kind.startsWith("submodule-gitlink"));
        const internalEntries = entries.filter((e) => e.submodulePath === smPath && e.kind === "submodule-internal");
        statuses[smPath] = {
            path: smPath,
            shaMismatch: Boolean(gitlinkEntry),
            internalDirty: internalEntries.length > 0,
            internalEntries,
            gitlinkEntry,
        };
    }
    return statuses;
}
function buildPreflightSummary(entries, rootEntries, submoduleStatuses, submodulePaths) {
    if (entries.length === 0)
        return "clean";
    const parts = [];
    const stagedRoot = rootEntries.filter((e) => e.indexStatus !== " ");
    const unstagedRoot = rootEntries.filter((e) => e.worktreeStatus !== " " && e.indexStatus === " ");
    const untrackedRoot = rootEntries.filter((e) => e.worktreeStatus === "?");
    if (stagedRoot.length > 0)
        parts.push(`${stagedRoot.length} staged root change(s)`);
    if (unstagedRoot.length > 0)
        parts.push(`${unstagedRoot.length} unstaged root change(s)`);
    if (untrackedRoot.length > 0)
        parts.push(`${untrackedRoot.length} untracked root file(s)`);
    const dirtySubmodules = Object.values(submoduleStatuses).filter((s) => s.shaMismatch || s.internalDirty);
    if (dirtySubmodules.length > 0) {
        const smParts = [];
        for (const sm of dirtySubmodules) {
            const smParts2 = [];
            if (sm.shaMismatch)
                smParts2.push("gitlink changed");
            if (sm.internalDirty)
                smParts2.push(`${sm.internalEntries.length} internal dirty file(s)`);
            smParts.push(`${sm.path}: ${smParts2.join(", ")}`);
        }
        parts.push(`${dirtySubmodules.length} dirty submodule(s): ${smParts.join("; ")}`);
    }
    return parts.join("; ");
}
// ── Utility functions (read-only Git operations) ──
function git(cwd, args) {
    // Use trimEnd instead of trim to preserve leading whitespace.
    // Leading spaces are significant in porcelain status output
    // (e.g., " M README.md" where the leading space is the index status).
    return execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
    }).replace(/[\r\n]+$/, "");
}
function safeGit(cwd, args) {
    try {
        return git(cwd, args);
    }
    catch {
        return "";
    }
}
function shortSha(value) {
    return value.slice(0, 12);
}
// ── Convenience inspectors ──
/**
 * Returns true when the workspace has **any** uncommitted changes
 * (root worktree, submodule gitlinks, or submodule internal).
 * Use `inspectWorkspacePreflight` for full diagnostic details.
 */
export function isWorkspaceDirty(workspacePath) {
    const output = safeGit(resolve(workspacePath), [
        "status",
        "--porcelain=v1",
        "--ignore-submodules=none",
        "--untracked-files=all",
    ]);
    return output.trim().length > 0;
}
/**
 * Returns true when the workspace has root-level uncommitted changes
 * (ignoring submodule internal dirtiness).
 */
export function isWorkspaceRootDirty(workspacePath) {
    const result = inspectWorkspacePreflight(workspacePath);
    return result.rootEntries.length > 0;
}
/**
 * Returns true when the workspace has any dirty submodule
 * (gitlink changes or internal dirtiness).
 */
export function isWorkspaceSubmoduleDirty(workspacePath) {
    const result = inspectWorkspacePreflight(workspacePath);
    const dirtySubmodules = Object.values(result.submoduleStatuses).filter((s) => s.shaMismatch || s.internalDirty);
    return dirtySubmodules.length > 0;
}
//# sourceMappingURL=git-preflight.js.map