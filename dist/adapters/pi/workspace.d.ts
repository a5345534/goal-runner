import type { BranchVerificationStatus, WorkspaceProfile, WorkspaceStatus } from "../../core/index.js";
export interface GoalWorkspaceFlags {
    workspace?: string;
    branch?: string;
    ref?: string;
    remainingArgs: string;
}
export interface ResolvedWorkspaceBinding {
    workspace: string;
    branch?: string;
    ref?: string;
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
export type WorkspaceProfileCommand = {
    kind: "add";
    profile: Omit<WorkspaceProfile, "createdAt" | "updatedAt">;
} | {
    kind: "list";
} | {
    kind: "show";
    name: string;
} | {
    kind: "remove";
    name: string;
};
export declare function parseGoalWorkspaceFlags(args: string): GoalWorkspaceFlags;
export declare function parseWorkspaceProfileCommand(args: string, cwd: string): WorkspaceProfileCommand | undefined;
export declare function resolveWorkspaceBinding(flags: Pick<GoalWorkspaceFlags, "workspace" | "branch" | "ref">, profiles: WorkspaceProfile[], cwd: string): ResolvedWorkspaceBinding;
export declare function validateExecutionWorkspace(binding: ResolvedWorkspaceBinding): WorkspaceValidationResult;
export declare function tokenize(input: string): string[];
