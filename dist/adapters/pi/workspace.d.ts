import type { BranchVerificationStatus, WorkspaceStatus } from "../../core/index.js";
export interface GoalWorkspaceFlags {
    workspace?: string;
    branch?: string;
    ref?: string;
    dagFile?: string;
    modelArg?: string;
    modelRoutingJson?: string;
    modelRoutingFile?: string;
    remainingArgs: string;
}
export interface ResolvedWorkspaceBinding {
    workspace: string;
    branch?: string;
    ref?: string;
    /** Target/base branch or ref for promoting an auto-allocated controller branch before completion. */
    promotionTargetRef?: string;
    profileName?: string;
}
export interface WorkspaceValidationResult {
    ok: boolean;
    workspace: string;
    workspaceStatus: WorkspaceStatus;
    branchVerificationStatus: BranchVerificationStatus;
    isGit: boolean;
    currentBranch?: string;
    currentRef?: string;
    dirty?: boolean;
    untracked?: boolean;
    message?: string;
}
export declare function parseGoalWorkspaceFlags(args: string): GoalWorkspaceFlags;
export declare function resolveWorkspaceBinding(flags: Pick<GoalWorkspaceFlags, "workspace" | "branch" | "ref">, cwd: string): ResolvedWorkspaceBinding;
export declare function validateExecutionWorkspace(binding: ResolvedWorkspaceBinding): WorkspaceValidationResult;
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
export declare function runExecutionWorkspacePreflightGate(binding: ResolvedWorkspaceBinding, isExplicitWorkspace: boolean): string | undefined;
export declare function tokenize(input: string): string[];
