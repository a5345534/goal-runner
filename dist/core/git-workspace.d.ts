import type { GoalControllerIntegrator, GoalControllerWorkspaceAllocator, GoalControllerWorkspaceAllocationRequest } from "./controller-loop.js";
import type { GoalDagNode, GoalOrchestrationState, GoalSubagentRecord } from "./types.js";
export interface NativeGitWorkspaceManagerOptions {
    /** Directory inside the repository where goal worktrees are created. Defaults to <repo>/.worktrees. */
    worktreeRoot?: string;
    /** Default base ref for new worktrees. If omitted, the remote default branch is preferred. */
    defaultBaseRef?: string;
    /** Remote used for default-branch discovery and optional fetch. Defaults to origin. */
    remote?: string;
    /** Prefix for generated branches. Defaults to goal. */
    branchPrefix?: string;
    /** Whether to run git fetch <remote> before resolving refs. Defaults to true. */
    fetch?: boolean;
}
export interface ControllerWorkspaceAllocationRequest {
    /** Directory where the user invoked the goal command. */
    invocationCwd: string;
    goalId: string;
    objective: string;
    /** Optional caller-supplied base ref overriding manager defaults. */
    baseRef?: string;
}
export interface NativeGitWorkspaceAllocation {
    repoRoot: string;
    worktreePath: string;
    branch: string;
    baseRef: string;
    slug: string;
    allocationReason: "workspace-and-branch-omitted" | "subagent-dag-node";
    created: boolean;
}
export interface NativeGitControllerWorkspaceAllocation extends NativeGitWorkspaceAllocation {
    allocationReason: "workspace-and-branch-omitted";
}
export interface NativeGitSubagentWorkspaceAllocation extends NativeGitWorkspaceAllocation {
    allocationReason: "subagent-dag-node";
    nodeId: string;
    subagentId: string;
}
export interface NativeGitSubagentWorkspaceAllocationRequest {
    /** Stable Git repository checkout to use for creating the worktree. */
    invocationCwd?: string;
    /** Optional already-known repository root, used before invocationCwd/controllerWorkspacePath. */
    repoRoot?: string;
    /** Controller workspace whose current branch/HEAD should be used as the default base ref. */
    controllerWorkspacePath?: string;
    goalId: string;
    nodeId: string;
    nodeSlug?: string;
    nodeObjective?: string;
    /** Optional caller-supplied base ref overriding controller branch/manager defaults. */
    baseRef?: string;
    /** Optional deterministic worktree directory name under the worktree root. */
    worktreeSlug?: string;
    /** Optional exact branch name to create/reuse for this subagent worktree. */
    branch?: string;
    /** Optional stable subagent id; otherwise generated from goal/node and collision suffix. */
    subagentId?: string;
}
export interface NativeGitSubagentWorkspaceAllocatorOptions {
    invocationCwd?: string;
    repoRoot?: string;
    controllerWorkspacePath?: string;
    baseRef?: string;
    systemPrompt?: string;
    initialPrompt?: (request: GoalControllerWorkspaceAllocationRequest, allocation: NativeGitSubagentWorkspaceAllocation) => string;
    metadata?: Record<string, unknown>;
}
export interface NativeGitWorkspaceCleanupRequest {
    worktreePath: string;
    branch?: string;
    repoRoot?: string;
    force?: boolean;
    /** Commit HEAD to verify before force-deleting the subagent branch/worktree. */
    integrationSourceHead?: string;
    /** Verify that integrationSourceHead is still referenced by a local branch before force-deleting. */
    verifyReachable?: boolean;
}
interface NativeGitWorkspaceCleanupWorkspaceResult {
    reachabilityVerified?: boolean;
}
export type NativeGitSubagentCleanupAction = "remove" | "preserve";
export interface NativeGitSubagentCleanupPolicy {
    /** Completed subagent worktrees are removed by default. */
    completed?: NativeGitSubagentCleanupAction;
    /** Blocked subagent worktrees are preserved by default for inspection. */
    blocked?: NativeGitSubagentCleanupAction;
    /** Failed subagent worktrees are preserved by default for inspection. */
    failed?: NativeGitSubagentCleanupAction;
    /** Force-remove worktrees and branches when cleanup action is remove. Defaults false. */
    force?: boolean;
    /** Require promotion to a terminal-success status before force deletion. */
    promotionStatus?: NativeGitControllerBranchPromotionStatus;
    /** Verify that the subagent source commit is still reachable before force deletion. */
    verifySourceReachable?: boolean;
    /** Allow cleanup of explicitly-bound (non-auto-allocated) workspaces. Defaults false. */
    allowExplicitWorkspaceCleanup?: boolean;
}
export interface NativeGitSubagentBranchIntegrationRequest {
    controllerWorkspacePath: string;
    node?: GoalDagNode;
    subagent: GoalSubagentRecord;
    /** Reserved for future strategy selection. Current implementation uses git merge. */
    strategy?: "merge";
    /** Host policy for post-merge validation. Required gates fail closed when this is false. */
    postMergeValidation?: boolean;
}
export type NativeGitSubagentBranchIntegrationStatus = "complete" | "notRequired" | "failed";
export interface NativeGitSubagentBranchIntegrationResult {
    status: NativeGitSubagentBranchIntegrationStatus;
    summary: string;
    sourceBranch?: string;
    sourceRef?: string;
    sourceHead?: string;
    integrationCommitSha?: string;
    error?: string;
    followupPrompt?: string;
    validationSignals?: string[];
    completedAt?: string;
}
export interface NativeGitSubagentBranchIntegratorOptions {
    controllerWorkspacePath: string;
    strategy?: "merge";
    /** Host policy for post-merge validation. Required gates fail closed when this is false. */
    postMergeValidation?: boolean;
}
export interface NativeGitControllerBranchPromotionRequest {
    controllerWorkspacePath: string;
    controllerBranch?: string;
    /** Goal id used for durable submodule retained-ref names when promotion resolves gitlink conflicts. */
    goalId?: string;
    /** Target/base branch or ref that should receive the controller branch before goal completion. */
    targetRef?: string;
    strategy?: "merge";
}
export type NativeGitControllerBranchPromotionStatus = "complete" | "notRequired" | "blocked";
export interface NativeGitControllerBranchPromotionResult {
    status: NativeGitControllerBranchPromotionStatus;
    summary: string;
    controllerBranch?: string;
    controllerHead?: string;
    targetRef?: string;
    targetBranch?: string;
    targetWorkspacePath?: string;
    targetHead?: string;
    targetRemoteHead?: string;
    targetSyncSummary?: string;
    promotionCommitSha?: string;
    error?: string;
}
export interface NativeGitSubagentCleanupResult {
    subagentId: string;
    nodeId: string;
    status: GoalSubagentRecord["status"];
    action: "removed" | "preserved" | "skipped" | "error";
    reason?: string;
    workspacePath?: string;
    branch?: string;
    error?: string;
    forceAuthorized?: boolean;
    forceReason?: string;
    reachabilityVerified?: boolean;
}
export type NativeGitRemoteCloseoutMode = "local-only" | "push-parent" | "block-if-cannot-push";
export type NativeGitSubmodulePublishMode = "verify-only" | "publish-retained-ref-if-trusted" | "block-if-unpublished";
export interface NativeGitCloseoutPolicy {
    remoteCloseoutMode: NativeGitRemoteCloseoutMode;
    submodulePublishMode: NativeGitSubmodulePublishMode;
    cleanupAutoAllocatedWorktrees: boolean;
    allowExplicitWorkspaceCleanup: false;
    parentRemote?: string;
    targetBranch?: string;
    durableRefPrefix?: string;
    durableRefPatterns: string[];
    trustedSubmoduleUrlPatterns: string[];
    verifyNestedSubmodules: boolean;
    prePushCheckoutSimulation: boolean;
    postPushRemoteCheckoutVerification: boolean;
}
export interface NativeGitCloseoutPolicyResolutionOptions {
    env?: NodeJS.ProcessEnv;
    trustedSubmoduleUrlPatterns?: string[];
}
export declare const TRUSTED_SUBMODULE_URL_PATTERNS_ENV = "AGENT_GOAL_NATIVE_GIT_TRUSTED_SUBMODULE_URL_PATTERNS";
export declare const AUTO_ALLOCATED_DEFAULT_CLOSEOUT_POLICY: NativeGitCloseoutPolicy;
export declare const EXPLICIT_WORKSPACE_DEFAULT_CLOSEOUT_POLICY: NativeGitCloseoutPolicy;
export declare function resolveNativeGitCloseoutPolicy(policy: NativeGitCloseoutPolicy, options?: NativeGitCloseoutPolicyResolutionOptions): NativeGitCloseoutPolicy;
export declare function parseTrustedSubmoduleUrlPatterns(value: string | undefined): string[];
export interface ChangedSubmoduleGitlink {
    path: string;
    status: "added" | "modified" | "deleted" | "renamed";
    oldPath?: string;
    oldSha?: string;
    newSha?: string;
    canonicalUrl?: string;
    oldCanonicalUrl?: string;
}
export interface NativeGitSubmodulePublishRequest {
    goalId: string;
    parentWorkspacePath: string;
    sourceWorkspacePaths: string[];
    baseTreeish?: string;
    targetTreeish?: string;
    phase: "integration" | "closeout";
    policy: NativeGitCloseoutPolicy;
}
export interface NativeGitSubmodulePublishResult {
    status: "passed" | "skipped" | "blocked";
    summary: string;
    phase: "integration" | "closeout";
    changedGitlinks: ChangedSubmoduleGitlink[];
    published: PublishedSubmoduleRef[];
    verified: VerifiedSubmoduleRef[];
    blockers: SubmodulePublishBlocker[];
}
export interface PublishedSubmoduleRef {
    path: string;
    sha: string;
    canonicalUrl: string;
    durableRef: string;
    alreadyContained: boolean;
    sourceWorkspacePath?: string;
}
export interface VerifiedSubmoduleRef {
    path: string;
    sha: string;
    canonicalUrl: string;
    durableRef: string;
    isolatedFetchVerified: boolean;
    nestedVerified?: boolean;
}
export interface SubmodulePublishBlocker {
    path: string;
    sha?: string;
    reason: string;
    error?: string;
}
export interface NormalizedPromotionTarget {
    remoteName: string;
    remoteBranch: string;
    localTargetBranch: string;
    targetWorkspacePath: string;
    targetHead: string;
    remoteHead?: string;
}
export interface NativeGitTargetBranchSyncResult {
    status: "synced" | "skipped" | "blocked";
    summary: string;
    targetHead?: string;
    remoteHead?: string;
    error?: string;
}
export interface NativeGitPromotionTargetPreflightRequest {
    /** Directory where the user invoked /goal before an auto-allocated controller worktree is created. */
    invocationCwd: string;
    /** Optional caller-supplied base ref; when omitted the manager resolves the normal controller base ref. */
    baseRef?: string;
    /** Optional explicit promotion target ref; defaults to the resolved base ref. */
    targetRef?: string;
}
export interface NativeGitPromotionTargetPreflightResult {
    status: "passed" | "skipped" | "blocked";
    summary: string;
    targetRef?: string;
    targetBranch?: string;
    targetWorkspacePath?: string;
    targetHead?: string;
    targetRemoteHead?: string;
    remoteName?: string;
    remoteBranch?: string;
    error?: string;
}
export interface NativeGitParentPushRequest {
    targetWorkspacePath: string;
    remoteName: string;
    remoteBranch: string;
    recurseSubmodules: "check";
}
export interface NativeGitParentPushResult {
    status: "passed" | "blocked" | "skipped";
    summary: string;
    remoteName?: string;
    remoteBranch?: string;
    pushedHead?: string;
    error?: string;
}
export interface NativeGitRecursiveCheckoutVerificationRequest {
    parentRemoteUrl: string;
    targetWorkspacePath?: string;
    targetCommitSha?: string;
    remoteBranch?: string;
    mode: "pre-push-local-commit" | "post-push-remote-branch";
}
export interface NativeGitRecursiveCheckoutVerificationResult {
    status: "passed" | "blocked" | "skipped";
    summary: string;
    mode: "pre-push-local-commit" | "post-push-remote-branch";
    error?: string;
}
export interface NativeGitSubmoduleCheckoutSyncRequest {
    targetWorkspacePath: string;
    recursive?: boolean;
    /**
     * Permit unrelated root worktree/index changes while aligning submodule checkouts.
     * Only use after the caller has already verified the root worktree was clean,
     * such as during an in-progress no-commit merge whose root changes are expected.
     */
    allowRootWorktreeChanges?: boolean;
}
export interface NativeGitSubmoduleCheckoutSyncResult {
    status: "passed" | "blocked" | "skipped";
    summary: string;
    targetWorkspacePath: string;
    changedPaths: string[];
    updatedPaths: string[];
    blockers: Array<{
        path: string;
        reason: string;
    }>;
    error?: string;
}
export declare class NativeGitWorkspaceManager {
    private readonly options;
    constructor(options?: NativeGitWorkspaceManagerOptions);
    allocateControllerWorkspace(request: ControllerWorkspaceAllocationRequest): NativeGitControllerWorkspaceAllocation;
    allocateSubagentWorkspace(request: NativeGitSubagentWorkspaceAllocationRequest): NativeGitSubagentWorkspaceAllocation;
    private ensureBoundSubagentWorkspace;
    cleanupWorkspace(request: NativeGitWorkspaceCleanupRequest): NativeGitWorkspaceCleanupWorkspaceResult;
    syncSubmoduleWorktreesToHeadPins(request: NativeGitSubmoduleCheckoutSyncRequest): NativeGitSubmoduleCheckoutSyncResult;
    integrateSubagentBranch(request: NativeGitSubagentBranchIntegrationRequest): NativeGitSubagentBranchIntegrationResult;
    promoteControllerBranch(request: NativeGitControllerBranchPromotionRequest): NativeGitControllerBranchPromotionResult;
    ensureSubmoduleGitlinksDurablyPublished(request: NativeGitSubmodulePublishRequest): NativeGitSubmodulePublishResult;
    preflightPromotionTargetBeforeControllerStart(request: NativeGitPromotionTargetPreflightRequest): NativeGitPromotionTargetPreflightResult;
    normalizePromotionTarget(request: NativeGitControllerBranchPromotionRequest, policy: NativeGitCloseoutPolicy): {
        ok: true;
        value: NormalizedPromotionTarget;
    } | {
        ok: false;
        reason: string;
    };
    syncTargetBranchBeforePromotion(target: NormalizedPromotionTarget): NativeGitTargetBranchSyncResult;
    pushParentTargetBranch(request: NativeGitParentPushRequest): NativeGitParentPushResult;
    verifyRecursiveCheckout(request: NativeGitRecursiveCheckoutVerificationRequest): NativeGitRecursiveCheckoutVerificationResult;
    resolveBaseRef(repoRoot: string, overrideBaseRef?: string): string;
    private resolveSubagentBaseRef;
    private resolveWorktreeRoot;
}
export declare function createNativeGitSubagentWorkspaceAllocator(manager: NativeGitWorkspaceManager, options?: NativeGitSubagentWorkspaceAllocatorOptions): GoalControllerWorkspaceAllocator;
export declare function createNativeGitSubagentBranchIntegrator(manager: NativeGitWorkspaceManager, options: NativeGitSubagentBranchIntegratorOptions): GoalControllerIntegrator;
export declare function cleanupTerminalSubagentWorkspaces(manager: NativeGitWorkspaceManager, state: GoalOrchestrationState, policy?: NativeGitSubagentCleanupPolicy): NativeGitSubagentCleanupResult[];
export declare function cleanupSubagentWorkspace(manager: NativeGitWorkspaceManager, subagent: GoalSubagentRecord, policy?: NativeGitSubagentCleanupPolicy): NativeGitSubagentCleanupResult;
export declare function findGitRepositoryRoot(startPath: string): string | undefined;
export declare function slugForGoal(goalId: string, objective: string): string;
export declare function slugForGoalSubagent(goalId: string, nodeSlugOrId: string, nodeObjective?: string): string;
export {};
