import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { inspectWorkspacePreflight } from "../../core/index.js";
export function parseGoalWorkspaceFlags(args) {
    const tokens = tokenize(args);
    const remaining = [];
    let workspace;
    let branch;
    let ref;
    let dagFile;
    let modelArg;
    let modelRoutingJson;
    let modelRoutingFile;
    for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index];
        if (token === "--workspace") {
            workspace = requireFlagValue(tokens, ++index, "--workspace");
            continue;
        }
        if (token === "--branch") {
            branch = requireFlagValue(tokens, ++index, "--branch");
            continue;
        }
        if (token === "--ref") {
            ref = requireFlagValue(tokens, ++index, "--ref");
            continue;
        }
        if (token === "--dag") {
            dagFile = requireFlagValue(tokens, ++index, "--dag");
            continue;
        }
        if (token === "--model") {
            modelArg = requireFlagValue(tokens, ++index, "--model");
            continue;
        }
        if (token === "--model-routing") {
            modelRoutingJson = requireFlagValue(tokens, ++index, "--model-routing");
            continue;
        }
        if (token === "--model-routing-file") {
            modelRoutingFile = requireFlagValue(tokens, ++index, "--model-routing-file");
            continue;
        }
        if (token === "--legacy-session")
            throw new Error("--legacy-session was removed; /goal always creates an orchestrated goal-owned session.");
        if (token === "--orchestrate")
            throw new Error("--orchestrate was removed; /goal <objective> orchestrates by default.");
        remaining.push(token);
    }
    if (branch && ref)
        throw new Error("only one of --branch or --ref may be supplied");
    return { workspace, branch, ref, dagFile, modelArg, modelRoutingJson, modelRoutingFile, remainingArgs: remaining.join(" ") };
}
export function resolveWorkspaceBinding(flags, cwd) {
    if (!flags.workspace)
        throw new Error("/goal requires --workspace <path> when an explicit workspace is supplied");
    const workspace = resolve(cwd, flags.workspace);
    const branch = flags.branch;
    const ref = flags.ref;
    if (branch && ref)
        throw new Error("only one of --branch or --ref may be supplied");
    return { workspace, branch, ref };
}
export function validateExecutionWorkspace(binding) {
    const allowedRoots = readAllowedWorkspaceRoots();
    if (allowedRoots.length > 0 && !isUnderAllowedRoot(binding.workspace, allowedRoots)) {
        return failure(binding, "notAllowed", "notApplicable", false, `execution workspace is outside allowed roots: ${binding.workspace}`);
    }
    if (!existsSync(binding.workspace)) {
        return failure(binding, "missing", "notApplicable", false, `execution workspace does not exist: ${binding.workspace}`);
    }
    if (!statSync(binding.workspace).isDirectory()) {
        return failure(binding, "inaccessible", "notApplicable", false, `execution workspace is not a directory: ${binding.workspace}`);
    }
    const isGit = isGitWorkspace(binding.workspace);
    if (!isGit) {
        if (binding.branch || binding.ref) {
            return failure(binding, "configured", "notGit", false, "--branch/--ref was supplied for a non-git workspace");
        }
        return {
            ok: true,
            workspace: binding.workspace,
            workspaceStatus: "configured",
            branchVerificationStatus: "notApplicable",
            isGit: false,
        };
    }
    if (!binding.branch && !binding.ref) {
        return failure(binding, "configured", "unknown", true, "git-backed execution workspace requires --branch or --ref");
    }
    const currentBranch = safeGitOutput(binding.workspace, ["branch", "--show-current"]);
    const currentRef = safeGitOutput(binding.workspace, ["rev-parse", "HEAD"]);
    const expectedMatches = binding.branch ? currentBranch === binding.branch : currentRef === binding.ref;
    const status = gitOutput(binding.workspace, ["status", "--porcelain"]);
    const dirty = status.split("\n").some((line) => line.length > 0 && !line.startsWith("??"));
    const untracked = status.split("\n").some((line) => line.startsWith("??"));
    return {
        ok: expectedMatches,
        workspace: binding.workspace,
        workspaceStatus: "configured",
        branchVerificationStatus: expectedMatches ? "verified" : "mismatch",
        isGit: true,
        currentBranch: currentBranch || undefined,
        currentRef: currentRef || undefined,
        dirty,
        untracked,
        message: expectedMatches ? undefined : `workspace branch/ref mismatch: expected ${binding.branch ?? binding.ref}, got ${currentBranch || currentRef}`,
    };
}
function failure(binding, workspaceStatus, branchVerificationStatus, isGit, message) {
    return { ok: false, workspace: binding.workspace, workspaceStatus, branchVerificationStatus, isGit, message };
}
function readAllowedWorkspaceRoots() {
    return (process.env.AGENT_GOAL_ALLOWED_WORKSPACE_ROOTS ?? "")
        .split(process.platform === "win32" ? ";" : ":")
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map((entry) => resolve(entry));
}
function isUnderAllowedRoot(workspace, allowedRoots) {
    const resolvedWorkspace = resolve(workspace);
    return allowedRoots.some((root) => resolvedWorkspace === root || resolvedWorkspace.startsWith(`${root}/`));
}
function isGitWorkspace(cwd) {
    try {
        return gitOutput(cwd, ["rev-parse", "--is-inside-work-tree"]) === "true";
    }
    catch {
        return false;
    }
}
function safeGitOutput(cwd, args) {
    try {
        return gitOutput(cwd, args);
    }
    catch {
        return "";
    }
}
function gitOutput(cwd, args) {
    return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}
function requireFlagValue(tokens, index, flag) {
    const value = tokens[index];
    if (!value || value.startsWith("--"))
        throw new Error(`${flag} requires a value`);
    return value;
}
/**
 * Runs the Git preflight inspector on the execution workspace and enforces
 * managed execution workspace context semantics:
 *
 * - **Explicit dirty execution workspaces block**: When the user explicitly
 *   supplies `--workspace`, any uncommitted changes in that workspace
 *   (root worktree or submodule) cause the start to be rejected.
 * - **Runner-created controller worktrees are evaluated as the execution
 *   context**: The preflight is always run on `binding.workspace`. For
 *   auto-allocated workspaces this is a freshly-created worktree that
 *   should be clean by construction.
 * - **Unrelated invocation-checkout dirtiness does not block auto-allocated
 *   runs**: The invocation checkout (where the user ran the command) is
 *   never inspected by this gate. Only the execution workspace is checked.
 *
 * @returns `undefined` when the workspace passes preflight, or a diagnostic
 *          string describing why the preflight gate is closed.
 */
export function runExecutionWorkspacePreflightGate(binding, isExplicitWorkspace) {
    if (!binding.workspace)
        return undefined;
    const preflight = inspectWorkspacePreflight(binding.workspace, {
        recurseSubmodules: true,
        includeUntracked: true,
    });
    if (!preflight.inGitRepo) {
        return `execution workspace is not a Git repository: ${binding.workspace}`;
    }
    if (preflight.clean)
        return undefined;
    // For explicit workspaces, any dirtiness blocks.
    if (isExplicitWorkspace) {
        const parts = [];
        const stagedRoot = preflight.rootEntries.filter((e) => e.indexStatus !== " ");
        const unstagedRoot = preflight.rootEntries.filter((e) => e.worktreeStatus !== " " && e.indexStatus === " ");
        const untrackedRoot = preflight.rootEntries.filter((e) => e.worktreeStatus === "?");
        if (stagedRoot.length > 0) {
            parts.push(`${stagedRoot.length} staged root change(s): ${stagedRoot.map((e) => e.path).join(", ")}`);
        }
        if (unstagedRoot.length > 0) {
            parts.push(`${unstagedRoot.length} unstaged root change(s): ${unstagedRoot.map((e) => e.path).join(", ")}`);
        }
        if (untrackedRoot.length > 0) {
            parts.push(`${untrackedRoot.length} untracked root file(s): ${untrackedRoot.map((e) => e.path).join(", ")}`);
        }
        const dirtySubmodules = Object.values(preflight.submoduleStatuses).filter((s) => s.shaMismatch || s.internalDirty);
        if (dirtySubmodules.length > 0) {
            for (const sm of dirtySubmodules) {
                const smParts = [];
                if (sm.shaMismatch)
                    smParts.push("gitlink changed");
                if (sm.internalDirty)
                    smParts.push(`${sm.internalEntries.length} internal dirty file(s)`);
                parts.push(`submodule ${sm.path}: ${smParts.join(", ")}`);
            }
        }
        return `explicit execution workspace has uncommitted changes; commit, stash, or clean before starting a goal controller here:\n${parts.join("\n")}`;
    }
    // Auto-allocated workspace should be clean by construction, but we still
    // verify and produce a diagnostic if it isn't (e.g., a worktree collision
    // or a pre-creation dirtiness from an unsafe ref).
    return `auto-allocated execution workspace has unexpected uncommitted changes:\n${preflight.summary}\nWorkspace: ${binding.workspace}\nThe worktree should be clean after creation. Check for stale worktrees or dirty base refs.`;
}
export function tokenize(input) {
    const tokens = [];
    let current = "";
    let quote;
    let escaped = false;
    for (const char of input) {
        if (escaped) {
            current += char;
            escaped = false;
            continue;
        }
        if (char === "\\") {
            escaped = true;
            continue;
        }
        if (quote) {
            if (char === quote)
                quote = undefined;
            else
                current += char;
            continue;
        }
        if (char === "'" || char === '"') {
            quote = char;
            continue;
        }
        if (/\s/u.test(char)) {
            if (current) {
                tokens.push(current);
                current = "";
            }
            continue;
        }
        current += char;
    }
    if (quote)
        throw new Error("unterminated quote in /goal command");
    if (escaped)
        current += "\\";
    if (current)
        tokens.push(current);
    return tokens;
}
//# sourceMappingURL=workspace.js.map