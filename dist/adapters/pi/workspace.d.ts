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
export declare function tokenize(input: string): string[];
