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
/**
 * Controls which submodules have their target branches enforced during
 * closeout of an auto-allocated remote.
 *
 * - "final-tree": Every submodule gitlink reachable in the final treeish
 *   (the parent commit being pushed) is enforced. This is the default for
 *   auto-allocated remote closeout.
 * - "changed-gitlinks": Compatibility mode that only enforces gitlinks changed
 *   by the current promotion diff. It does not repair pre-existing retained-only
 *   pins in the final parent tree.
 * - "none": No target-branch enforcement; submodule gitlinks are published
 *   without target-branch verification.
 */
export type NativeGitTargetBranchEnforcementScope = "final-tree" | "changed-gitlinks" | "none";
/**
 * Maps a submodule path to a specific target branch for publication.
 * When no mapping exists for a submodule, the default branch of its
 * remote is used as the target.
 */
export interface NativeGitSubmoduleTargetBranchMapping {
    /** Submodule path relative to parent repository root. Supports glob patterns. */
    path: string;
    /** The target branch to enforce for this submodule's gitlink publication. */
    targetBranch: string;
    /** Optional remote override; defaults to the parent remote. */
    remote?: string;
}
/**
 * Policy that controls how submodule target-branch publication is enforced
 * during closeout of an auto-allocated remote or promotion.
 *
 * This is a separate concern from {@link NativeGitCloseoutPolicy}: the
 * closeout policy controls *whether* submodule SHAs are durably published
 * (retained-ref or remote check), while the target-branch policy controls
 * *which branch* is used for that durable publication.
 */
export interface NativeGitSubmoduleTargetBranchPolicy {
    /**
     * Controls which submodules have their target branches enforced.
     * Defaults to "final-tree" for auto-allocated remote closeout.
     */
    enforcementScope: NativeGitTargetBranchEnforcementScope;
    /**
     * Maps submodule paths to specific target branches. When empty or
     * unmapped, default branch discovery is used per submodule.
     */
    branchMappings: NativeGitSubmoduleTargetBranchMapping[];
    /**
     * URL patterns for submodules whose remote URLs are trusted to receive
     * target-branch pushes. This is intentionally separate from retained-ref
     * publication trust.
     */
    trustedSubmoduleTargetBranchUrlPatterns: string[];
    /**
     * Whether the parent target branch may be used when no mapping,
     * `.gitmodules` branch, or remote default branch resolves. Defaults to false.
     */
    allowParentTargetBranchFallback: boolean;
    /**
     * Whether to verify that the published target-branch commit is reachable
     * on the remote after push. Defaults to true.
     */
    verifyRemoteReachability: boolean;
}
/**
 * Diagnostic record for each submodule evaluated during target-branch
 * policy enforcement. Includes the source object ref for traceability
 * and the enforcement decision.
 */
export interface NativeGitSubmoduleTargetBranchDiagnostic {
    /** Submodule path relative to parent repository root. */
    path: string;
    /**
     * The source object ref (full SHA) that was evaluated. This is the
     * gitlink SHA from the parent treeish being pushed.
     */
    sourceObjectRef: string;
    /** Canonical remote URL for the submodule. */
    canonicalUrl: string;
    /** The resolved mapped target branch from branchMappings, if any. */
    mappedBranch?: string;
    /** Whether the enforcement scope included this submodule. */
    enforcementMatched: boolean;
    /** Whether the target-branch ref was successfully published. */
    published: boolean;
    /** Error detail if publication or verification failed. */
    error?: string;
}
/**
 * Result of evaluating and applying the target-branch publication policy.
 */
export interface NativeGitSubmoduleTargetBranchResult {
    status: "passed" | "blocked" | "skipped";
    summary: string;
    /** Submodule refs successfully published to target branches. */
    published: Array<{
        path: string;
        sha: string;
        canonicalUrl: string;
        targetBranch: string;
    }>;
    /** Submodule refs that could not be published to target branches. */
    blocked: Array<{
        path: string;
        sha: string;
        reason: string;
    }>;
    /** Per-submodule diagnostic records. */
    diagnostics: NativeGitSubmoduleTargetBranchDiagnostic[];
}
/**
 * Environment variable that can supply additional trusted submodule URL
 * patterns for target-branch publication, layered on top of the policy's
 * built-in patterns. Value may be a JSON array of strings or a
 * newline/comma-delimited list.
 */
export declare const TRUSTED_SUBMODULE_TARGET_BRANCH_URL_PATTERNS_ENV = "AGENT_GOAL_NATIVE_GIT_TRUSTED_SUBMODULE_TARGET_BRANCH_URL_PATTERNS";
/**
 * Default target-branch policy for auto-allocated remote closeout.
 * - enforcementScope is "final-tree": only submodules in the final tree
 *   are enforced.
 * - branchMappings is empty: the default remote branch is used for all
 *   submodules.
 * - trustedSubmoduleTargetBranchUrlPatterns is empty: no target branch
 *   mutation is allowed until target-branch-specific trust is configured.
 * - verifyRemoteReachability is true: fails if remote verification fails.
 */
export declare const DEFAULT_SUBMODULE_TARGET_BRANCH_POLICY: NativeGitSubmoduleTargetBranchPolicy;
/**
 * Resolves a {@link NativeGitSubmoduleTargetBranchPolicy} by merging
 * environment-configured trusted URL patterns.
 */
export declare function resolveSubmoduleTargetBranchPolicy(policy: NativeGitSubmoduleTargetBranchPolicy, options?: {
    env?: NodeJS.ProcessEnv;
}): NativeGitSubmoduleTargetBranchPolicy;
/**
 * Resolves the target branch for a submodule by checking, in order:
 * 1. Explicit {@link NativeGitSubmoduleTargetBranchMapping.branchMappings} entries
 *    (direct path match or trailing glob `*` match, with longest match winning).
 * 2. The `branch` key in the submodule&#39;s `.gitmodules` entry (versioned in the
 *    parent tree).
 * 3. The remote default branch of the submodule&#39;s canonical URL
 *    (via `git ls-remote --symref`).
 * 4. The parent target branch, only when policy explicitly allows fallback.
 *
 * Returns the resolved branch name or undefined when no resolution strategy
 * produces a result.
 */
export declare function resolveSubmoduleTargetBranch(submodulePath: string, policy: NativeGitSubmoduleTargetBranchPolicy, parentWorkspacePath: string, treeish?: string, parentTargetBranch?: string): string | undefined;
/**
 * Resolves the `branch` key from the submodule&#39;s section in `.gitmodules`.
 * Reads from the versioned treeish (HEAD/INDEX) or the WORKTREE file.
 */
export declare function resolveGitmodulesSubmoduleBranch(parentWorkspacePath: string, submodulePath: string, treeish?: string): string | undefined;
/**
 * Resolves the default branch of a remote Git repository using
 * `git ls-remote --symref`. Returns the branch name or undefined.
 */
export declare function resolveRemoteDefaultBranch(canonicalUrl: string): string | undefined;
/**
 * Checks whether a remote branch already contains a given commit SHA,
 * without requiring any publish trust. Uses an isolated bare clone to
 * fetch the candidate branch and runs `git merge-base --is-ancestor`.
 *
 * This is the non-trusting containment check: the caller does not need
 * push access or trust; they only need fetch access to inspect.
 */
export declare function branchContainsCommitRemotely(canonicalUrl: string, sha: string, targetBranch: string): {
    contained: boolean;
    error?: string;
};
/**
 * Ensures a submodule commit SHA is available in the submodule worktree
 * by locating it in source workspaces or fetching from remote.
 *
 * This extends {@link ensureSubmoduleCommitAvailable} with target-branch-
 * specific fetch sources: it first checks retained/durable refs, then
 * source workspaces, then falls back to fetching the target branch itself.
 *
 * Returns true when the SHA object is available in `submoduleWorktree`
 * after the operation.
 */
export declare function ensureSubmoduleTargetShaAvailable(submoduleWorktree: string, submodulePath: string, sha: string, sourceWorkspacePaths: string[], canonicalUrl?: string, targetBranch?: string): boolean;
/**
 * Publishes a SHA to a submodule target branch using fast-forward-only
 * semantics. The operation:
 *
 * 1. Requires target-branch-specific trust URL check.
 * 2. Verifies ancestor proof: the SHA must be a descendant of the
 *    current target branch tip (fast-forward check).
 * 3. Uses an explicit non-force refspec (`<sha>:refs/heads/<branch>`)
 *    so the remote will reject non-fast-forward pushes.
 * 4. Verifies remote reachability after push when policy requires it.
 *
 * Returns a structured result with the publication status and diagnostics.
 */
export interface TargetBranchPublishResult {
    published: boolean;
    alreadyContained: boolean;
    error?: string;
    verificationError?: string;
}
export declare function publishShaToSubmoduleTargetBranch(submoduleWorktree: string, canonicalUrl: string, sha: string, targetBranch: string, policy: NativeGitSubmoduleTargetBranchPolicy): TargetBranchPublishResult;
/**
 * Evaluates and applies the target-branch publication policy for a set of
 * changed submodule gitlinks. This is the main entry point for target-branch
 * enforcement during closeout or integration.
 *
 * For each submodule in the enforcement scope:
 * 1. Resolves the target branch via policy, .gitmodules, remote default.
 * 2. Checks if the branch already contains the target SHA (containment).
 * 3. Ensures the SHA object is available in the submodule push source.
 * 4. Publishes only with fast-forward proof and non-force refspec.
 * 5. Blocks on: missing branch, ambiguous branch, divergence,
 *    missing target object, missing trust, protected branch, push rejection.
 */
export declare function evaluateSubmoduleTargetBranchPolicy(parentWorkspacePath: string, policy: NativeGitSubmoduleTargetBranchPolicy, submoduleGitlinks: ChangedSubmoduleGitlink[], sourceWorkspacePaths: string[], options?: {
    /** Treeish to read .gitmodules from for branch resolution. Defaults to HEAD. */
    treeish?: string;
    /** The parent target branch for fallback resolution. */
    parentTargetBranch?: string;
    /** Remote name used for URL resolution. Defaults to origin. */
    remoteName?: string;
}): NativeGitSubmoduleTargetBranchResult;
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
export interface NativeGitSubmoduleTargetBranchPublicationRequest {
    parentWorkspacePath: string;
    sourceWorkspacePaths: string[];
    /** Base tree for changed-gitlinks compatibility mode. Ignored for final-tree. */
    baseTreeish?: string;
    /** Final promoted treeish to verify/publish. Defaults to HEAD. */
    targetTreeish?: string;
    /** Parent target branch, only used when policy.allowParentTargetBranchFallback is true. */
    parentTargetBranch?: string;
    policy: NativeGitSubmoduleTargetBranchPolicy;
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
    enforceSubmoduleTargetBranchPublication(request: NativeGitSubmoduleTargetBranchPublicationRequest): NativeGitSubmoduleTargetBranchResult;
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
