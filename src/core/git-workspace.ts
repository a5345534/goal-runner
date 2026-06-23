import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { requiredSubagentIntegrationTerminalSuccess } from "./integration.js";
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

// ── Submodule publish and closeout policy types ──

export type NativeGitRemoteCloseoutMode =
  | "local-only"
  | "push-parent"
  | "block-if-cannot-push";

export type NativeGitSubmodulePublishMode =
  | "verify-only"
  | "publish-retained-ref-if-trusted"
  | "block-if-unpublished";

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

export const AUTO_ALLOCATED_DEFAULT_CLOSEOUT_POLICY: NativeGitCloseoutPolicy = {
  remoteCloseoutMode: "block-if-cannot-push",
  submodulePublishMode: "publish-retained-ref-if-trusted",
  cleanupAutoAllocatedWorktrees: true,
  allowExplicitWorkspaceCleanup: false,
  parentRemote: "origin",
  durableRefPatterns: [
    "refs/heads/main",
    "refs/heads/master",
    "refs/heads/release/*",
    "refs/heads/goal-runner/retained/*",
  ],
  trustedSubmoduleUrlPatterns: [],
  verifyNestedSubmodules: true,
  prePushCheckoutSimulation: true,
  postPushRemoteCheckoutVerification: true,
};

export const EXPLICIT_WORKSPACE_DEFAULT_CLOSEOUT_POLICY: NativeGitCloseoutPolicy = {
  remoteCloseoutMode: "local-only",
  submodulePublishMode: "block-if-unpublished",
  cleanupAutoAllocatedWorktrees: false,
  allowExplicitWorkspaceCleanup: false,
  parentRemote: "origin",
  durableRefPatterns: [
    "refs/heads/main",
    "refs/heads/master",
    "refs/heads/release/*",
    "refs/heads/goal-runner/retained/*",
  ],
  trustedSubmoduleUrlPatterns: [],
  verifyNestedSubmodules: true,
  prePushCheckoutSimulation: false,
  postPushRemoteCheckoutVerification: false,
};

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

export class NativeGitWorkspaceManager {
  private readonly options: Required<Omit<NativeGitWorkspaceManagerOptions, "worktreeRoot" | "defaultBaseRef">> & Pick<NativeGitWorkspaceManagerOptions, "worktreeRoot" | "defaultBaseRef">;

  constructor(options: NativeGitWorkspaceManagerOptions = {}) {
    this.options = {
      worktreeRoot: options.worktreeRoot,
      defaultBaseRef: options.defaultBaseRef,
      remote: options.remote ?? "origin",
      branchPrefix: options.branchPrefix ?? "goal",
      fetch: options.fetch ?? true,
    };
  }

  allocateControllerWorkspace(request: ControllerWorkspaceAllocationRequest): NativeGitControllerWorkspaceAllocation {
    const repoRoot = findGitRepositoryRoot(request.invocationCwd);
    if (!repoRoot) {
      throw new Error(`cannot allocate goal workspace: ${request.invocationCwd} is not inside a Git repository`);
    }

    if (this.options.fetch) safeGit(repoRoot, ["fetch", this.options.remote, "--prune"]);

    const baseRef = this.resolveBaseRef(repoRoot, request.baseRef);
    const baseSlug = slugForGoal(request.goalId, request.objective);
    const worktreeRoot = this.resolveWorktreeRoot(repoRoot);
    mkdirSync(worktreeRoot, { recursive: true });

    for (let attempt = 0; attempt < 100; attempt += 1) {
      const slug = attempt === 0 ? baseSlug : `${baseSlug}-${attempt + 1}`;
      const branch = `${this.options.branchPrefix}/${slug}`;
      const worktreePath = resolve(worktreeRoot, slug);
      if (existsSync(worktreePath) || gitRefExists(repoRoot, branch)) continue;
      git(repoRoot, ["worktree", "add", "-b", branch, worktreePath, baseRef]);
      return {
        repoRoot,
        worktreePath,
        branch,
        baseRef,
        slug,
        allocationReason: "workspace-and-branch-omitted",
        created: true,
      };
    }

    throw new Error(`cannot allocate unique goal workspace for objective: ${request.objective}`);
  }

  allocateSubagentWorkspace(request: NativeGitSubagentWorkspaceAllocationRequest): NativeGitSubagentWorkspaceAllocation {
    const seedPath = request.repoRoot ?? request.invocationCwd ?? request.controllerWorkspacePath;
    if (!seedPath) throw new Error("cannot allocate subagent workspace: repoRoot, invocationCwd, or controllerWorkspacePath is required");
    const repoRoot = findGitRepositoryRoot(seedPath);
    if (!repoRoot) throw new Error(`cannot allocate subagent workspace: ${seedPath} is not inside a Git repository`);

    if (this.options.fetch) safeGit(repoRoot, ["fetch", this.options.remote, "--prune"]);

    const baseRef = this.resolveSubagentBaseRef(repoRoot, request);
    const goalPrefix = sanitizeSlug(request.goalId).slice(0, 12);
    const baseSlug = request.worktreeSlug ? assertSafeWorktreeSlug(request.worktreeSlug) : slugForGoalSubagent(request.goalId, request.nodeSlug ?? request.nodeId, request.nodeObjective);
    const baseSubagentId = sanitizeSlug(request.subagentId ?? `subagent-${baseSlug}`);
    const worktreeRoot = this.resolveWorktreeRoot(repoRoot);
    mkdirSync(worktreeRoot, { recursive: true });

    if (request.worktreeSlug || request.branch) {
      const branch = request.branch ?? `${this.options.branchPrefix}/${goalPrefix}/${baseSlug}`;
      assertSafeBranchName(repoRoot, branch);
      return this.ensureBoundSubagentWorkspace({
        repoRoot,
        worktreeRoot,
        worktreePath: resolve(worktreeRoot, baseSlug),
        branch,
        baseRef,
        slug: baseSlug,
        nodeId: request.nodeId,
        subagentId: baseSubagentId,
      });
    }

    for (let attempt = 0; attempt < 100; attempt += 1) {
      const slug = attempt === 0 ? baseSlug : `${baseSlug}-${attempt + 1}`;
      const subagentId = attempt === 0 ? baseSubagentId : `${baseSubagentId}-${attempt + 1}`;
      const branch = `${this.options.branchPrefix}/${goalPrefix}/${slug}`;
      const worktreePath = resolve(worktreeRoot, slug);
      if (existsSync(worktreePath) || gitRefExists(repoRoot, branch)) continue;
      git(repoRoot, ["worktree", "add", "-b", branch, worktreePath, baseRef]);
      return {
        repoRoot,
        worktreePath,
        branch,
        baseRef,
        slug,
        nodeId: request.nodeId,
        subagentId,
        allocationReason: "subagent-dag-node",
        created: true,
      };
    }

    throw new Error(`cannot allocate unique subagent workspace for DAG node: ${request.nodeId}`);
  }

  private ensureBoundSubagentWorkspace(request: {
    repoRoot: string;
    worktreeRoot: string;
    worktreePath: string;
    branch: string;
    baseRef: string;
    slug: string;
    nodeId: string;
    subagentId: string;
  }): NativeGitSubagentWorkspaceAllocation {
    const resolvedRoot = resolve(request.worktreeRoot);
    const resolvedWorktree = resolve(request.worktreePath);
    if (resolvedWorktree !== resolvedRoot && !resolvedWorktree.startsWith(`${resolvedRoot}/`)) {
      throw new Error(`bound subagent worktree must stay under worktree root: ${request.worktreePath}`);
    }

    if (existsSync(resolvedWorktree)) {
      const workspaceRepo = findGitRepositoryRoot(resolvedWorktree);
      if (!workspaceRepo) throw new Error(`bound subagent worktree path exists but is not a Git worktree: ${resolvedWorktree}`);
      const currentBranch = safeGit(resolvedWorktree, ["branch", "--show-current"]);
      if (currentBranch !== request.branch) {
        throw new Error(
          `bound subagent worktree branch mismatch: expected ${request.branch}, got ${currentBranch || "detached"}. ` +
          `This worktree may belong to a different goal or node. Remove it manually or use a different worktreeSlug.`,
        );
      }
      const dirty = gitStatusPorcelain(resolvedWorktree);
      if (dirty) throw new Error(`bound subagent worktree has uncommitted changes; cannot reuse safely:\n${dirty}`);
      return {
        repoRoot: request.repoRoot,
        worktreePath: resolvedWorktree,
        branch: request.branch,
        baseRef: request.baseRef,
        slug: request.slug,
        nodeId: request.nodeId,
        subagentId: request.subagentId,
        allocationReason: "subagent-dag-node",
        created: false,
      };
    }

    if (gitRefExists(request.repoRoot, request.branch)) git(request.repoRoot, ["worktree", "add", resolvedWorktree, request.branch]);
    else git(request.repoRoot, ["worktree", "add", "-b", request.branch, resolvedWorktree, request.baseRef]);
    return {
      repoRoot: request.repoRoot,
      worktreePath: resolvedWorktree,
      branch: request.branch,
      baseRef: request.baseRef,
      slug: request.slug,
      nodeId: request.nodeId,
      subagentId: request.subagentId,
      allocationReason: "subagent-dag-node",
      created: true,
    };
  }

  cleanupWorkspace(request: NativeGitWorkspaceCleanupRequest): NativeGitWorkspaceCleanupWorkspaceResult {
    const repoRoot = request.repoRoot ?? findGitCommonRepositoryRoot(request.worktreePath) ?? findGitRepositoryRoot(request.worktreePath) ?? process.cwd();

    let reachabilityVerified: boolean | undefined;
    if (request.force && request.verifyReachable) {
      if (!request.integrationSourceHead) {
        throw new Error("cannot force-delete worktree because integrationSourceHead is required for reachability verification");
      }
      reachabilityVerified = branchContainsCommit(repoRoot, request.integrationSourceHead);
      if (!reachabilityVerified) {
        throw new Error(`cannot force-delete worktree for ${request.branch ?? "<unknown branch>"}: integration source ${shortSha(request.integrationSourceHead)} is not reachable from any local branch`);
      }
    }

    if (request.force) {
      git(request.worktreePath, ["clean", "-fd"]);
      git(repoRoot, ["worktree", "remove", "--force", request.worktreePath]);
    } else {
      git(repoRoot, ["worktree", "remove", request.worktreePath]);
    }

    if (request.branch) {
      git(repoRoot, ["branch", request.force ? "-D" : "-d", request.branch]);
    }

    return { reachabilityVerified };
  }

  integrateSubagentBranch(request: NativeGitSubagentBranchIntegrationRequest): NativeGitSubagentBranchIntegrationResult {
    const controllerWorkspacePath = resolve(request.controllerWorkspacePath);
    const controllerRepo = findGitRepositoryRoot(controllerWorkspacePath);
    if (!controllerRepo) {
      return nativeGitIntegrationFailure(request, `controller workspace is not inside a Git repository: ${controllerWorkspacePath}`);
    }

    const source = resolveSubagentIntegrationSource(controllerWorkspacePath, request.subagent);
    if (!source.ok) return nativeGitIntegrationFailure(request, source.error);

    const sourceBranch = source.branch ?? request.subagent.branch;
    const sourceRef = source.ref ?? request.subagent.ref ?? sourceBranch;
    const sourceHead = source.head;
    const controllerDirty = gitStatusPorcelain(controllerWorkspacePath, { ignoreWorktreeRoot: true });
    if (controllerDirty) {
      return nativeGitIntegrationFailure(
        request,
        `controller workspace has uncommitted changes; cannot integrate safely:\n${controllerDirty}`,
        { sourceBranch, sourceRef, sourceHead },
      );
    }

    if (source.workspacePath) {
      const sourceDirty = gitStatusPorcelain(source.workspacePath);
      if (sourceDirty) {
        return nativeGitIntegrationFailure(
          request,
          `subagent workspace has uncommitted changes; commit them on the subagent branch before reporting completion:\n${sourceDirty}`,
          { sourceBranch, sourceRef, sourceHead },
          buildCommitBeforeIntegrationPrompt(request, sourceDirty),
        );
      }
    }

    const controllerHead = safeGit(controllerWorkspacePath, ["rev-parse", "--verify", "HEAD"]);
    if (!controllerHead) return nativeGitIntegrationFailure(request, "controller workspace has no HEAD", { sourceBranch, sourceRef, sourceHead });

    if (sourceHead === controllerHead) {
      const postMergeValidation = runPostMergeValidationIfNeeded(request, controllerWorkspacePath);
      if (!postMergeValidation.ok) {
        if (postMergeValidation.workspaceMutated) cleanPostMergeValidationArtifacts(controllerWorkspacePath);
        return nativeGitIntegrationFailure(
          request,
          postMergeValidation.summary,
          { sourceBranch, sourceRef, sourceHead },
          buildPostMergeValidationFollowupPrompt(request, postMergeValidation.summary),
          postMergeValidation.validationSignals,
        );
      }
      return {
        status: "notRequired",
        summary: appendIntegrationSummary(`subagent branch already matches controller HEAD ${shortSha(controllerHead)}`, postMergeValidation.summary),
        sourceBranch,
        sourceRef,
        sourceHead,
        integrationCommitSha: controllerHead,
        validationSignals: postMergeValidation.validationSignals,
        completedAt: new Date().toISOString(),
      };
    }

    if (gitIsAncestor(controllerWorkspacePath, sourceHead, controllerHead)) {
      const postMergeValidation = runPostMergeValidationIfNeeded(request, controllerWorkspacePath);
      if (!postMergeValidation.ok) {
        if (postMergeValidation.workspaceMutated) cleanPostMergeValidationArtifacts(controllerWorkspacePath);
        return nativeGitIntegrationFailure(
          request,
          postMergeValidation.summary,
          { sourceBranch, sourceRef, sourceHead },
          buildPostMergeValidationFollowupPrompt(request, postMergeValidation.summary),
          postMergeValidation.validationSignals,
        );
      }
      return {
        status: "complete",
        summary: appendIntegrationSummary(`subagent commit ${shortSha(sourceHead)} is already integrated in controller HEAD ${shortSha(controllerHead)}`, postMergeValidation.summary),
        sourceBranch,
        sourceRef,
        sourceHead,
        integrationCommitSha: controllerHead,
        validationSignals: postMergeValidation.validationSignals,
        completedAt: new Date().toISOString(),
      };
    }

    try {
      git(controllerWorkspacePath, ["merge", "--no-ff", "--no-commit", sourceHead]);

      // Integration-time submodule publish gate: scan staged gitlinks and ensure
      // every changed submodule SHA is durably remote-fetchable before the merge
      // commit enters the controller branch history.
      const publish = this.ensureSubmoduleGitlinksDurablyPublished({
        goalId: request.subagent.goalId,
        parentWorkspacePath: controllerWorkspacePath,
        sourceWorkspacePaths: [
          source.workspacePath,
          controllerWorkspacePath,
        ].filter((p): p is string => Boolean(p)),
        baseTreeish: "HEAD",
        targetTreeish: "INDEX",
        phase: "integration",
        policy: AUTO_ALLOCATED_DEFAULT_CLOSEOUT_POLICY,
      });

      if (publish.status === "blocked") {
        abortMergeAndCleanPostMergeValidationArtifacts(controllerWorkspacePath);
        return nativeGitIntegrationFailure(
          request,
          `submodule publish blocked: ${publish.summary}`,
          { sourceBranch, sourceRef, sourceHead },
          `[SYSTEM FOLLOW-UP: SUBMODULE_PUBLISH_BLOCKED]\n${publish.summary}\n\nPush the referenced submodule SHAs to their remotes, or configure closeout policy to allow retained ref publish for trusted submodule URLs. Then retry integration.`,
          publish.blockers.map((b) => `${b.path}: ${b.reason}`),
        );
      }

      const postMergeValidation = runPostMergeValidationIfNeeded(request, controllerWorkspacePath);
      if (!postMergeValidation.ok) {
        abortMergeAndCleanPostMergeValidationArtifacts(controllerWorkspacePath);
        return nativeGitIntegrationFailure(
          request,
          postMergeValidation.summary,
          { sourceBranch, sourceRef, sourceHead },
          buildPostMergeValidationFollowupPrompt(request, postMergeValidation.summary),
          postMergeValidation.validationSignals,
        );
      }
      git(controllerWorkspacePath, ["commit", "--no-edit"]);
      const integrationCommitSha = git(controllerWorkspacePath, ["rev-parse", "--verify", "HEAD"]);
      return {
        status: "complete",
        summary: appendIntegrationSummary(`merged subagent ${request.subagent.subagentId} ${shortSha(sourceHead)} into controller ${shortSha(integrationCommitSha)}`, postMergeValidation.summary),
        sourceBranch,
        sourceRef,
        sourceHead,
        integrationCommitSha,
        validationSignals: postMergeValidation.validationSignals,
        completedAt: new Date().toISOString(),
      };
    } catch (error) {
      safeGit(controllerWorkspacePath, ["merge", "--abort"]);
      const message = `git merge failed while integrating subagent ${request.subagent.subagentId}: ${gitErrorMessage(error)}`;
      return nativeGitIntegrationFailure(
        request,
        message,
        { sourceBranch, sourceRef, sourceHead },
        buildMergeConflictFollowupPrompt(request, message),
      );
    }
  }

  promoteControllerBranch(request: NativeGitControllerBranchPromotionRequest): NativeGitControllerBranchPromotionResult {
    const controllerWorkspacePath = resolve(request.controllerWorkspacePath);
    const controllerRepo = findGitRepositoryRoot(controllerWorkspacePath);
    if (!controllerRepo) {
      return nativeGitPromotionBlocked(request, `controller workspace is not inside a Git repository: ${controllerWorkspacePath}`);
    }

    const controllerBranch = request.controllerBranch ?? (safeGit(controllerWorkspacePath, ["branch", "--show-current"]) || undefined);
    const controllerHead = safeGit(controllerWorkspacePath, ["rev-parse", "--verify", "HEAD"]);
    if (!controllerHead) return nativeGitPromotionBlocked(request, "controller workspace has no HEAD", { controllerBranch });

    const controllerDirty = gitStatusPorcelain(controllerWorkspacePath, { ignoreWorktreeRoot: true });
    if (controllerDirty) {
      return nativeGitPromotionBlocked(request, `controller workspace has uncommitted changes; cannot promote safely:\n${controllerDirty}`, {
        controllerBranch,
        controllerHead,
      });
    }

    const target = resolveControllerPromotionTarget(controllerWorkspacePath, request.targetRef, controllerBranch, this.options.branchPrefix);
    if (!target.ok) return nativeGitPromotionBlocked(request, target.error, { controllerBranch, controllerHead, targetRef: target.targetRef, targetBranch: target.targetBranch });

    const targetDirty = gitStatusPorcelain(target.workspacePath, { ignoreWorktreeRoot: true });
    if (targetDirty) {
      return nativeGitPromotionBlocked(request, `target workspace has uncommitted changes; cannot promote safely:\n${targetDirty}`, {
        controllerBranch,
        controllerHead,
        targetRef: target.targetRef,
        targetBranch: target.targetBranch,
        targetWorkspacePath: target.workspacePath,
        targetHead: target.head,
      });
    }

    if (controllerHead === target.head || gitIsAncestor(target.workspacePath, controllerHead, target.head)) {
      return {
        status: "notRequired",
        summary: `controller ${shortSha(controllerHead)} is already contained in target ${target.targetBranch}`,
        controllerBranch,
        controllerHead,
        targetRef: target.targetRef,
        targetBranch: target.targetBranch,
        targetWorkspacePath: target.workspacePath,
        targetHead: target.head,
        promotionCommitSha: target.head,
      };
    }

    try {
      git(target.workspacePath, ["merge", "--no-ff", "--no-edit", controllerHead]);
      const promotionCommitSha = git(target.workspacePath, ["rev-parse", "--verify", "HEAD"]);
      return {
        status: "complete",
        summary: `merged controller ${controllerBranch ?? shortSha(controllerHead)} ${shortSha(controllerHead)} into target ${target.targetBranch} ${shortSha(promotionCommitSha)}`,
        controllerBranch,
        controllerHead,
        targetRef: target.targetRef,
        targetBranch: target.targetBranch,
        targetWorkspacePath: target.workspacePath,
        targetHead: target.head,
        promotionCommitSha,
      };
    } catch (error) {
      safeGit(target.workspacePath, ["merge", "--abort"]);
      return nativeGitPromotionBlocked(request, `git merge failed while promoting controller branch: ${gitErrorMessage(error)}`, {
        controllerBranch,
        controllerHead,
        targetRef: target.targetRef,
        targetBranch: target.targetBranch,
        targetWorkspacePath: target.workspacePath,
        targetHead: target.head,
      });
    }
  }

  // ── Submodule publish and closeout gate methods ──

  ensureSubmoduleGitlinksDurablyPublished(request: NativeGitSubmodulePublishRequest): NativeGitSubmodulePublishResult {
    const gitlinks = scanChangedSubmoduleGitlinks(request.parentWorkspacePath, request.baseTreeish, request.targetTreeish);

    if (gitlinks.length === 0) {
      return {
        status: "skipped",
        summary: "no changed submodule gitlinks detected",
        phase: request.phase,
        changedGitlinks: [],
        published: [],
        verified: [],
        blockers: [],
      };
    }

    const published: PublishedSubmoduleRef[] = [];
    const verified: VerifiedSubmoduleRef[] = [];
    const blockers: SubmodulePublishBlocker[] = [];

    for (const gitlink of gitlinks) {
      if (gitlink.status === "deleted") {
        continue;
      }

      const newSha = gitlink.newSha;
      if (!newSha) {
        blockers.push({ path: gitlink.path, reason: "changed submodule gitlink has no new SHA" });
        continue;
      }

      // Resolve canonical URL from parent tree .gitmodules
      const url = resolveSubmoduleCanonicalUrl(request.parentWorkspacePath, gitlink.path, request.targetTreeish);
      if (!url) {
        blockers.push({ path: gitlink.path, sha: newSha, reason: `cannot resolve canonical URL for submodule path ${gitlink.path} from .gitmodules` });
        continue;
      }
      gitlink.canonicalUrl = url;

      // Check if SHA is already on a durable remote ref (no trust required for verify)
      const existingRef = findDurableRefContainingSha(url, newSha, request.policy.durableRefPatterns);
      if (existingRef) {
        const fetchOk = verifySubmoduleShaFromIsolatedFetch(url, existingRef, newSha);
        if (fetchOk) {
          verified.push({ path: gitlink.path, sha: newSha, canonicalUrl: url, durableRef: existingRef, isolatedFetchVerified: true });
          continue;
        }
      }

      // Locate the commit object (needed for push)
      const objectSource = locateSubmoduleCommitObject(newSha, request.sourceWorkspacePaths, gitlink.path);
      if (!objectSource) {
        blockers.push({ path: gitlink.path, sha: newSha, reason: `cannot locate submodule commit ${shortSha(newSha)} in any source workspace` });
        continue;
      }

      // Policy-mode check: non-publish modes block here without passing trust check
      if (request.policy.submodulePublishMode === "verify-only" || request.policy.submodulePublishMode === "block-if-unpublished") {
        blockers.push({ path: gitlink.path, sha: newSha, reason: `submodule SHA ${shortSha(newSha)} is not on any durable remote ref and publish mode is ${request.policy.submodulePublishMode}` });
        continue;
      }

      // URL trust check (only gates publish-retained-ref path)
      if (!isSubmoduleUrlTrusted(url, gitlink, request.policy)) {
        blockers.push({ path: gitlink.path, sha: newSha, reason: `submodule URL ${url} is not in trustedSubmoduleUrlPatterns; cannot publish retained ref` });
        continue;
      }

      // Publish retained ref
      const pathSlug = sanitizeSlug(gitlink.path).slice(0, 32) || "submodule";
      const sha12 = shortSha(newSha);
      const durableRef = `refs/heads/goal-runner/retained/${request.goalId}/${pathSlug}-${sha12}`;

      const pushOk = publishShaToRetainedRef(objectSource, gitlink.path, url, newSha, durableRef);
      if (!pushOk) {
        blockers.push({ path: gitlink.path, sha: newSha, reason: `failed to push retained ref ${durableRef} for ${url}` });
        continue;
      }

      // Prove remote availability via isolated fresh fetch after push
      const fetchOk = verifySubmoduleShaFromIsolatedFetch(url, durableRef, newSha);
      if (!fetchOk) {
        blockers.push({ path: gitlink.path, sha: newSha, reason: `pushed retained ref ${durableRef} but cannot fetch/verify SHA ${shortSha(newSha)} from ${url} via isolated fetch` });
        continue;
      }

      verified.push({ path: gitlink.path, sha: newSha, canonicalUrl: url, durableRef, isolatedFetchVerified: true });
      published.push({
        path: gitlink.path,
        sha: newSha,
        canonicalUrl: url,
        durableRef,
        alreadyContained: false,
        sourceWorkspacePath: objectSource,
      });
    }

    const hasBlockers = blockers.length > 0;
    return {
      status: hasBlockers ? "blocked" : "passed",
      summary: hasBlockers
        ? `submodule publish blocked: ${blockers.map((b) => `${b.path}: ${b.reason}`).join("; ")}`
        : `submodule publish passed: ${gitlinks.length} gitlink(s) scanned, ${verified.length} verified, ${published.length} published`,
      phase: request.phase,
      changedGitlinks: gitlinks,
      published,
      verified,
      blockers,
    };
  }

  normalizePromotionTarget(
    request: NativeGitControllerBranchPromotionRequest,
    policy: NativeGitCloseoutPolicy,
  ): { ok: true; value: NormalizedPromotionTarget } | { ok: false; reason: string } {
    const controllerWorkspacePath = resolve(request.controllerWorkspacePath);
    const repoRoot = findGitRepositoryRoot(controllerWorkspacePath);
    if (!repoRoot) return { ok: false, reason: `controller workspace is not inside a Git repository: ${controllerWorkspacePath}` };

    const targetRef = request.targetRef ?? policy.targetBranch;
    if (!targetRef) return { ok: false, reason: "no promotion target ref configured" };

    const remoteName = policy.parentRemote ?? "origin";
    const remoteUrl = safeGit(repoRoot, ["remote", "get-url", remoteName]);
    if (!remoteUrl) return { ok: false, reason: `cannot resolve remote URL for ${remoteName}` };

    const normalized = normalizePromotionTargetRef(controllerWorkspacePath, repoRoot, targetRef, remoteName);
    if (!normalized) return { ok: false, reason: `cannot normalize promotion target ref: ${targetRef}` };

    return { ok: true, value: normalized };
  }

  syncTargetBranchBeforePromotion(
    target: NormalizedPromotionTarget,
  ): { status: "synced" | "blocked"; summary: string } {
    const repoRoot = findGitRepositoryRoot(target.targetWorkspacePath);
    if (!repoRoot) return { status: "blocked", summary: "target workspace is not inside a Git repository" };

    // Fetch latest remote target branch
    const fetchRefspec = `refs/heads/${target.remoteBranch}:refs/remotes/${target.remoteName}/${target.remoteBranch}`;
    safeGit(repoRoot, ["fetch", target.remoteName, fetchRefspec]);

    const remoteHead = safeGit(repoRoot, ["rev-parse", "--verify", `refs/remotes/${target.remoteName}/${target.remoteBranch}`]);
    if (!remoteHead) return { status: "blocked", summary: `cannot resolve remote target branch ${target.remoteName}/${target.remoteBranch}` };

    if (target.targetHead === remoteHead) {
      return { status: "synced", summary: `target ${target.localTargetBranch} is already at remote ${target.remoteName}/${target.remoteBranch}` };
    }

    if (gitIsAncestor(repoRoot, target.targetHead, remoteHead)) {
      // Local is behind remote; fast-forward
      try {
        git(target.targetWorkspacePath, ["merge", "--ff-only", remoteHead]);
        return { status: "synced", summary: `fast-forwarded target ${target.localTargetBranch} to ${target.remoteName}/${target.remoteBranch}` };
      } catch {
        return { status: "blocked", summary: "failed to fast-forward local target to remote" };
      }
    }

    if (gitIsAncestor(repoRoot, remoteHead, target.targetHead)) {
      return { status: "blocked", summary: `local target ${target.localTargetBranch} has unpushed commits; cannot promote` };
    }

    return { status: "blocked", summary: `target ${target.localTargetBranch} and ${target.remoteName}/${target.remoteBranch} have diverged` };
  }

  pushParentTargetBranch(request: NativeGitParentPushRequest): NativeGitParentPushResult {
    try {
      const head = safeGit(request.targetWorkspacePath, ["rev-parse", "--verify", "HEAD"]);
      if (!head) return { status: "blocked", summary: "target workspace has no HEAD", error: "no HEAD" };

      const refspec = `HEAD:refs/heads/${request.remoteBranch}`;
      git(request.targetWorkspacePath, ["push", "--recurse-submodules=check", request.remoteName, refspec]);

      return {
        status: "passed",
        summary: `pushed ${shortSha(head)} to ${request.remoteName}/${request.remoteBranch}`,
        remoteName: request.remoteName,
        remoteBranch: request.remoteBranch,
        pushedHead: head,
      };
    } catch (error) {
      const message = gitErrorMessage(error);
      return {
        status: "blocked",
        summary: `parent push blocked: ${message}`,
        remoteName: request.remoteName,
        remoteBranch: request.remoteBranch,
        error: message,
      };
    }
  }

  verifyRecursiveCheckout(request: NativeGitRecursiveCheckoutVerificationRequest): NativeGitRecursiveCheckoutVerificationResult {
    const tmpDir = resolve("/tmp", `goal-submodule-checkout-${Date.now()}`);
    const uniqueDir = resolve(tmpDir, String(Date.now()));
    try {
      mkdirSync(uniqueDir, { recursive: true });

      if (request.mode === "pre-push-local-commit") {
        if (!request.targetWorkspacePath || !request.targetCommitSha) {
          return { status: "blocked", summary: "pre-push mode requires targetWorkspacePath and targetCommitSha", mode: request.mode };
        }
        // Clone parent remote, then fetch local commit
        git(uniqueDir, ["init", "-b", "main"]);
        safeGit(uniqueDir, ["remote", "add", "origin", request.parentRemoteUrl]);
        git(uniqueDir, ["fetch", request.targetWorkspacePath, request.targetCommitSha]);
        git(uniqueDir, ["checkout", "--detach", "FETCH_HEAD"]);
      } else {
        // Post-push: clone remote branch (clone into a subdir, not the dir itself)
        if (!request.remoteBranch) {
          return { status: "blocked", summary: "post-push mode requires remoteBranch", mode: request.mode };
        }
        git(tmpDir, ["clone", "--branch", request.remoteBranch, "--recurse-submodules", request.parentRemoteUrl, uniqueDir]);
      }

      // Try recursive submodule checkout
      git(uniqueDir, ["submodule", "sync", "--recursive"]);
      git(uniqueDir, ["submodule", "update", "--init", "--recursive"]);

      return { status: "passed", summary: `recursive checkout verification passed (${request.mode})`, mode: request.mode };
    } catch (error) {
      const message = gitErrorMessage(error);
      return {
        status: "blocked",
        summary: `recursive checkout verification failed (${request.mode}): ${message}`,
        mode: request.mode,
        error: message,
      };
    } finally {
      rmRecursiveSafe(uniqueDir);
      rmRecursiveSafe(tmpDir);
    }
  }

  resolveBaseRef(repoRoot: string, overrideBaseRef?: string): string {
    if (overrideBaseRef?.trim()) return resolveExplicitBaseRef(repoRoot, overrideBaseRef.trim());
    if (this.options.defaultBaseRef?.trim()) return resolveExplicitBaseRef(repoRoot, this.options.defaultBaseRef.trim());

    const remoteHead = safeGit(repoRoot, ["symbolic-ref", "--quiet", "--short", `refs/remotes/${this.options.remote}/HEAD`]);
    if (remoteHead) return remoteHead;

    const currentBranch = safeGit(repoRoot, ["branch", "--show-current"]);
    if (currentBranch) return currentBranch;

    const head = safeGit(repoRoot, ["rev-parse", "--verify", "HEAD"]);
    if (head) return head;

    throw new Error("cannot resolve goal workspace base ref: repository has no HEAD");
  }

  private resolveSubagentBaseRef(repoRoot: string, request: NativeGitSubagentWorkspaceAllocationRequest): string {
    if (request.baseRef?.trim()) return resolveExplicitBaseRef(repoRoot, request.baseRef.trim());
    if (request.controllerWorkspacePath?.trim()) {
      const controllerBranch = safeGit(request.controllerWorkspacePath, ["branch", "--show-current"]);
      if (controllerBranch) return controllerBranch;
      const controllerHead = safeGit(request.controllerWorkspacePath, ["rev-parse", "--verify", "HEAD"]);
      if (controllerHead) return controllerHead;
    }
    return this.resolveBaseRef(repoRoot);
  }

  private resolveWorktreeRoot(repoRoot: string): string {
    return resolve(this.options.worktreeRoot ?? resolve(repoRoot, ".worktrees"));
  }
}

export function createNativeGitSubagentWorkspaceAllocator(
  manager: NativeGitWorkspaceManager,
  options: NativeGitSubagentWorkspaceAllocatorOptions = {},
): GoalControllerWorkspaceAllocator {
  return (request) => {
    const allocation = manager.allocateSubagentWorkspace({
      invocationCwd: options.invocationCwd,
      repoRoot: options.repoRoot,
      controllerWorkspacePath: options.controllerWorkspacePath,
      baseRef: request.node.workspace?.baseRef ?? options.baseRef,
      worktreeSlug: request.node.workspace?.worktreeSlug,
      branch: request.node.workspace?.branch,
      goalId: request.goalId,
      nodeId: request.node.nodeId,
      nodeSlug: request.node.slug,
      nodeObjective: request.node.objective,
    });
    return {
      subagentId: allocation.subagentId,
      cwd: allocation.worktreePath,
      branch: allocation.branch,
      systemPrompt: options.systemPrompt,
      initialPrompt: options.initialPrompt?.(request, allocation),
      metadata: {
        ...(options.metadata ?? {}),
        nativeGitWorkspace: allocation,
      },
    };
  };
}

export function createNativeGitSubagentBranchIntegrator(
  manager: NativeGitWorkspaceManager,
  options: NativeGitSubagentBranchIntegratorOptions,
): GoalControllerIntegrator {
  return (request) => {
    const result = manager.integrateSubagentBranch({
      controllerWorkspacePath: options.controllerWorkspacePath,
      node: request.node,
      subagent: request.subagent,
      strategy: options.strategy,
      postMergeValidation: options.postMergeValidation,
    });
    return {
      status: result.status === "notRequired" ? "notRequired" : result.status,
      summary: result.summary,
      followupPrompt: result.followupPrompt,
      sourceBranch: result.sourceBranch,
      sourceRef: result.sourceRef,
      sourceHead: result.sourceHead,
      integrationCommitSha: result.integrationCommitSha,
      error: result.error,
      validationSignals: result.validationSignals,
      completedAt: result.completedAt,
    };
  };
}

export function cleanupTerminalSubagentWorkspaces(
  manager: NativeGitWorkspaceManager,
  state: GoalOrchestrationState,
  policy: NativeGitSubagentCleanupPolicy = {},
): NativeGitSubagentCleanupResult[] {
  return terminalCleanupTargets(state).map((subagent) => cleanupSubagentWorkspace(manager, subagent, policy));
}

function terminalCleanupTargets(state: GoalOrchestrationState): GoalSubagentRecord[] {
  const nodesById = new Map(state.nodes.map((node) => [node.nodeId, node]));
  const targets = state.subagents.map((subagent) => {
    const resources = nodesById.get(subagent.nodeId)?.preparedResources;
    if (!resources) return subagent;
    return {
      ...subagent,
      workspacePath: subagent.workspacePath ?? resources.workspacePath,
      branch: subagent.branch ?? resources.branch,
      ref: subagent.ref ?? resources.ref,
      sessionId: subagent.sessionId ?? resources.sessionId,
      sessionFile: subagent.sessionFile ?? resources.sessionFile,
    };
  });

  const byResource = new Map<string, GoalSubagentRecord[]>();
  for (const target of targets) {
    const key = target.workspacePath ? `workspace:${target.workspacePath}:${target.branch ?? ""}` : `subagent:${target.goalId}:${target.subagentId}`;
    const group = byResource.get(key) ?? [];
    group.push(target);
    byResource.set(key, group);
  }

  return [...byResource.values()].map(selectCleanupRepresentative);
}

function selectCleanupRepresentative(group: GoalSubagentRecord[]): GoalSubagentRecord {
  const completed = group.filter((subagent) => subagent.status === "complete").sort((a, b) => compareIsoDesc(a.updatedAt, b.updatedAt))[0];
  if (completed) return completed;
  return [...group].sort((a, b) => compareIsoDesc(a.updatedAt, b.updatedAt))[0]!;
}

function compareIsoDesc(left: string, right: string): number {
  return right.localeCompare(left);
}

interface NativeGitSubagentCleanupDecision {
  action: NativeGitSubagentCleanupAction;
  forceAuthorized: boolean;
  forceReason: string;
}

export function cleanupSubagentWorkspace(
  manager: NativeGitWorkspaceManager,
  subagent: GoalSubagentRecord,
  policy: NativeGitSubagentCleanupPolicy = {},
): NativeGitSubagentCleanupResult {
  if (!["complete", "blocked", "failed"].includes(subagent.status)) {
    return cleanupResult(subagent, "skipped", "subagent is not terminal");
  }
  if (!subagent.workspacePath) {
    return cleanupResult(subagent, "skipped", "subagent has no workspacePath");
  }

  const decision = cleanupDecision(subagent, policy);
  if (decision.action === "preserve") {
    return cleanupResult(subagent, "preserved", `policy preserves ${subagent.status} workspaces`, undefined, decision.forceAuthorized, decision.forceReason);
  }

  try {
    const result = manager.cleanupWorkspace({
      worktreePath: subagent.workspacePath,
      branch: subagent.branch,
      force: decision.forceAuthorized,
      integrationSourceHead: subagent.integrationSourceHead,
      verifyReachable: decision.forceAuthorized && policy.verifySourceReachable,
    });
    return cleanupResult(subagent, "removed", undefined, undefined, decision.forceAuthorized, decision.forceReason, result.reachabilityVerified);
  } catch (error) {
    return cleanupResult(
      subagent,
      "error",
      undefined,
      error instanceof Error ? error.message : String(error),
      decision.forceAuthorized,
      decision.forceReason,
    );
  }
}

function isExplicitSubagentWorkspace(subagent: GoalSubagentRecord): boolean {
  // Auto-allocated workspaces have goal/<prefix>/ goal-scoped branches
  // and their worktree directory contains .worktrees/
  const branch = subagent.branch ?? "";
  const ws = subagent.workspacePath ?? "";
  if (!ws || !branch) return true; // No workspace = nothing to cleanup
  const isAutoBranch = branch.startsWith("goal/");
  const isAutoPath = basename(ws).startsWith("goal-") && ws.includes(`${sep}.worktrees${sep}`);
  return !(isAutoBranch && isAutoPath);
}

function cleanupDecision(subagent: GoalSubagentRecord, policy: NativeGitSubagentCleanupPolicy): NativeGitSubagentCleanupDecision {
  // Explicitly-bound workspaces are never auto-cleaned unless policy explicitly allows
  if (!policy.allowExplicitWorkspaceCleanup && isExplicitSubagentWorkspace(subagent)) {
    return {
      action: "preserve",
      forceAuthorized: false,
      forceReason: "explicit workspace cleanup disabled by policy",
    };
  }

  let action: NativeGitSubagentCleanupAction;
  if (subagent.status === "complete") action = policy.completed ?? "remove";
  else if (subagent.status === "blocked") action = policy.blocked ?? "preserve";
  else if (subagent.status === "failed") action = policy.failed ?? "preserve";
  else action = "preserve";

  if (action !== "remove") {
    return {
      action,
      forceAuthorized: false,
      forceReason: "force deletion disabled because cleanup action is preserved",
    };
  }

  if (!policy.force) {
    return {
      action,
      forceAuthorized: false,
      forceReason: "force deletion disabled by policy",
    };
  }

  if (!requiredSubagentIntegrationTerminalSuccess(subagent)) {
    return {
      action,
      forceAuthorized: false,
      forceReason: `cannot force-delete without terminal integration state (got ${subagent.integrationState ?? "undefined"})`,
    };
  }

  if (policy.promotionStatus !== undefined && policy.promotionStatus !== "complete" && policy.promotionStatus !== "notRequired") {
    return {
      action,
      forceAuthorized: false,
      forceReason: `cannot force-delete unless promotion passed (got ${policy.promotionStatus})`,
    };
  }

  return {
    action,
    forceAuthorized: true,
    forceReason: "force-delete authorized",
  };
}

function cleanupResult(
  subagent: GoalSubagentRecord,
  action: NativeGitSubagentCleanupResult["action"],
  reason?: string,
  error?: string,
  forceAuthorized?: boolean,
  forceReason?: string,
  reachabilityVerified?: boolean,
): NativeGitSubagentCleanupResult {
  return {
    subagentId: subagent.subagentId,
    nodeId: subagent.nodeId,
    status: subagent.status,
    action,
    reason,
    workspacePath: subagent.workspacePath,
    branch: subagent.branch,
    error,
    forceAuthorized,
    forceReason,
    reachabilityVerified,
  };
}

type IntegrationSourceResolution =
  | { ok: true; workspacePath?: string; branch?: string; ref?: string; head: string }
  | { ok: false; error: string };

function resolveSubagentIntegrationSource(controllerWorkspacePath: string, subagent: GoalSubagentRecord): IntegrationSourceResolution {
  const workspacePath = subagent.workspacePath ? resolve(subagent.workspacePath) : undefined;
  if (workspacePath && findGitRepositoryRoot(workspacePath)) {
    const head = safeGit(workspacePath, ["rev-parse", "--verify", "HEAD"]);
    if (!head) return { ok: false, error: `subagent workspace has no HEAD: ${workspacePath}` };
    return {
      ok: true,
      workspacePath,
      branch: safeGit(workspacePath, ["branch", "--show-current"]) || subagent.branch,
      ref: subagent.ref,
      head,
    };
  }

  const sourceRef = subagent.branch ?? subagent.ref ?? subagent.commitSha ?? subagent.integrationSourceHead;
  if (!sourceRef) return { ok: false, error: "subagent has no workspace, branch, ref, or commit SHA to integrate" };
  const head = safeGit(controllerWorkspacePath, ["rev-parse", "--verify", `${sourceRef}^{commit}`]);
  if (!head) return { ok: false, error: `cannot resolve subagent integration ref ${sourceRef}` };
  return { ok: true, branch: subagent.branch, ref: sourceRef, head };
}

function nativeGitIntegrationFailure(
  request: NativeGitSubagentBranchIntegrationRequest,
  error: string,
  source: { sourceBranch?: string; sourceRef?: string; sourceHead?: string } = {},
  followupPrompt?: string,
  validationSignals?: string[],
): NativeGitSubagentBranchIntegrationResult {
  return {
    status: "failed",
    summary: error,
    error,
    followupPrompt,
    validationSignals,
    sourceBranch: source.sourceBranch,
    sourceRef: source.sourceRef,
    sourceHead: source.sourceHead,
  };
}

interface NativeGitPostMergeValidationResult {
  ok: boolean;
  summary: string;
  validationSignals: string[];
  workspaceMutated?: boolean;
}

function runPostMergeValidationIfNeeded(
  request: NativeGitSubagentBranchIntegrationRequest,
  controllerWorkspacePath: string,
): NativeGitPostMergeValidationResult {
  const required = nodeRequiresPostMergeValidation(request.node);
  if (!required) return { ok: true, summary: "", validationSignals: [] };
  if (request.postMergeValidation === false) {
    return {
      ok: false,
      summary: "post-merge validation required but disabled by host policy",
      validationSignals: ["post-merge validation required but disabled by host policy"],
    };
  }
  const validators = request.node?.validators ?? [];
  if (validators.length === 0) {
    return {
      ok: false,
      summary: "post-merge validation required but no node validators are configured",
      validationSignals: ["post-merge validation required but no node validators are configured"],
    };
  }

  const beforeStatus = gitStatusPorcelain(controllerWorkspacePath, { ignoreWorktreeRoot: true });
  const beforeIndexTree = safeGit(controllerWorkspacePath, ["write-tree"]);
  const results = validators.map((command) => runPostMergeValidatorCommand(command, controllerWorkspacePath));
  const afterStatus = gitStatusPorcelain(controllerWorkspacePath, { ignoreWorktreeRoot: true });
  const afterIndexTree = safeGit(controllerWorkspacePath, ["write-tree"]);
  const statusChanged = afterStatus !== beforeStatus;
  const indexChanged = Boolean(beforeIndexTree && afterIndexTree && beforeIndexTree !== afterIndexTree);
  const workspaceMutated = statusChanged || indexChanged;
  const validationSignals = results.map((result) => result.ok
    ? `post-merge validator passed: ${result.command}`
    : `post-merge validator failed: ${result.command}${result.output ? `\n${result.output}` : ""}`);
  const failed = results.filter((result) => !result.ok);
  if (workspaceMutated) {
    validationSignals.push(`post-merge validator mutated controller workspace: ${statusDeltaSummary(beforeStatus, afterStatus, indexChanged)}`);
    return {
      ok: false,
      summary: `post-merge validation mutated controller workspace${failed.length ? ` and failed ${failed.length}/${results.length} validator(s)` : ""}: ${statusDeltaSummary(beforeStatus, afterStatus, indexChanged)}`,
      validationSignals,
      workspaceMutated: true,
    };
  }
  if (failed.length === 0) {
    return { ok: true, summary: `post-merge validation passed (${results.length} validator(s))`, validationSignals };
  }
  return {
    ok: false,
    summary: `post-merge validation failed (${failed.length}/${results.length} validator(s)): ${failed.map((result) => result.command).join(", ")}`,
    validationSignals,
  };
}

function nodeRequiresPostMergeValidation(node: GoalDagNode | undefined): boolean {
  if (!node) return false;
  const gates = node.completionGates.map(normalizeCompletionGateName);
  return gates.includes("post-merge-validation") ||
    gates.includes("post-merge-validation-ran") ||
    Boolean(node.validation?.requiredEvidence?.includes("post-merge-validation-ran"));
}

function normalizeCompletionGateName(value: string): string {
  return value.trim().toLowerCase().replace(/_/g, "-");
}

function runPostMergeValidatorCommand(command: string, cwd: string): { command: string; ok: boolean; output?: string; error?: string } {
  try {
    const output = execFileSync("sh", ["-lc", command], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { command, ok: true, output: truncateForIntegration(output) };
  } catch (error) {
    const record = error as { stdout?: Buffer | string; stderr?: Buffer | string; message?: string };
    const output = `${toText(record.stdout)}${toText(record.stderr)}`.trim();
    return { command, ok: false, output: truncateForIntegration(output), error: record.message ?? String(error) };
  }
}

function statusDeltaSummary(beforeStatus: string, afterStatus: string, indexChanged: boolean): string {
  const parts = [
    indexChanged ? "index tree changed" : undefined,
    beforeStatus ? `before validators:\n${truncateForIntegration(beforeStatus, 1000)}` : "before validators: <clean>",
    afterStatus ? `after validators:\n${truncateForIntegration(afterStatus, 1000)}` : "after validators: <clean>",
  ];
  return parts.filter((part): part is string => Boolean(part)).join("; ");
}

function abortMergeAndCleanPostMergeValidationArtifacts(cwd: string): void {
  safeGit(cwd, ["merge", "--abort"]);
  cleanPostMergeValidationArtifacts(cwd);
}

function cleanPostMergeValidationArtifacts(cwd: string): void {
  safeGit(cwd, ["reset", "--hard", "HEAD"]);
  safeGit(cwd, ["clean", "-fd", "-e", ".worktrees/"]);
}

function buildPostMergeValidationFollowupPrompt(request: NativeGitSubagentBranchIntegrationRequest, failureSummary: string): string {
  return [
    `[SYSTEM FOLLOW-UP: POST_MERGE_VALIDATION]`,
    `Controller validation passed for node "${request.node?.nodeId ?? request.subagent.nodeId}" and the subagent branch merged cleanly in a temporary controller workspace state, but post-merge validation failed before the controller committed the merge.`,
    failureSummary,
    `Fix the issue on your assigned branch (${request.subagent.branch ?? "current branch"}), rerun the relevant validators, commit the result, and report again with SUBAGENT_RESULT: <summary including verification>.`,
  ].join("\n");
}

function appendIntegrationSummary(left: string, right: string): string {
  return right ? `${left}; ${right}` : left;
}

function truncateForIntegration(value: string, maxChars = 4000): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}\n...[truncated ${value.length - maxChars} chars]`;
}

type PromotionTargetResolution =
  | { ok: true; targetRef: string; targetBranch: string; workspacePath: string; head: string }
  | { ok: false; error: string; targetRef?: string; targetBranch?: string };

interface NativeGitWorktreeInfo {
  worktreePath: string;
  head?: string;
  branch?: string;
}

function resolveControllerPromotionTarget(
  controllerWorkspacePath: string,
  requestedTargetRef: string | undefined,
  controllerBranch: string | undefined,
  branchPrefix: string,
): PromotionTargetResolution {
  const worktrees = listGitWorktrees(controllerWorkspacePath);
  const controllerResolvedPath = resolve(controllerWorkspacePath);
  const targetCandidates = promotionTargetBranchCandidates(controllerWorkspacePath, requestedTargetRef, worktrees, controllerBranch, branchPrefix);
  if (targetCandidates.length === 0) {
    return { ok: false, error: "cannot resolve promotion target branch for controller workspace" };
  }

  for (const targetBranch of targetCandidates) {
    if (targetBranch === controllerBranch) continue;
    const target = worktrees.find((item) => item.branch === targetBranch && resolve(item.worktreePath) !== controllerResolvedPath);
    if (!target) continue;
    const head = target.head ?? safeGit(target.worktreePath, ["rev-parse", "--verify", "HEAD"]);
    if (!head) return { ok: false, error: `target branch ${targetBranch} worktree has no HEAD`, targetRef: requestedTargetRef, targetBranch };
    return { ok: true, targetRef: requestedTargetRef ?? targetBranch, targetBranch, workspacePath: target.worktreePath, head };
  }

  const firstCandidate = targetCandidates[0];
  return {
    ok: false,
    error: `promotion target branch ${firstCandidate} does not have a checked-out worktree; cannot merge fail-closed`,
    targetRef: requestedTargetRef,
    targetBranch: firstCandidate,
  };
}

function promotionTargetBranchCandidates(
  cwd: string,
  requestedTargetRef: string | undefined,
  worktrees: NativeGitWorktreeInfo[],
  controllerBranch: string | undefined,
  branchPrefix: string,
): string[] {
  const candidates: string[] = [];
  const add = (value: string | undefined) => {
    const branch = normalizeLocalBranchRef(cwd, value);
    if (branch && branch !== controllerBranch && !candidates.includes(branch)) candidates.push(branch);
  };

  add(requestedTargetRef);
  if (!requestedTargetRef) {
    for (const worktree of worktrees) {
      if (!worktree.branch || worktree.branch === controllerBranch) continue;
      if (worktree.branch.startsWith(`${branchPrefix}/`)) continue;
      add(worktree.branch);
    }
  }
  return candidates;
}

function normalizeLocalBranchRef(cwd: string, value: string | undefined): string | undefined {
  const ref = value?.trim();
  if (!ref) return undefined;
  if (ref.startsWith("refs/heads/")) return ref.slice("refs/heads/".length);
  if (gitRefExists(cwd, ref)) return ref;
  if (ref.startsWith("refs/remotes/")) {
    const parts = ref.split("/");
    const local = parts.slice(3).join("/");
    return local && gitRefExists(cwd, local) ? local : undefined;
  }
  const slash = ref.indexOf("/");
  if (slash > 0) {
    const local = ref.slice(slash + 1);
    return local && gitRefExists(cwd, local) ? local : undefined;
  }
  return undefined;
}

function listGitWorktrees(cwd: string): NativeGitWorktreeInfo[] {
  const output = safeGit(cwd, ["worktree", "list", "--porcelain"]);
  const worktrees: NativeGitWorktreeInfo[] = [];
  let current: NativeGitWorktreeInfo | undefined;
  const push = () => {
    if (current?.worktreePath) worktrees.push(current);
    current = undefined;
  };

  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) {
      push();
      continue;
    }
    if (line.startsWith("worktree ")) {
      push();
      current = { worktreePath: line.slice("worktree ".length) };
      continue;
    }
    if (!current) continue;
    if (line.startsWith("HEAD ")) current.head = line.slice("HEAD ".length);
    if (line.startsWith("branch ")) {
      const ref = line.slice("branch ".length);
      current.branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
    }
  }
  push();
  return worktrees;
}

function nativeGitPromotionBlocked(
  request: NativeGitControllerBranchPromotionRequest,
  error: string,
  context: Partial<NativeGitControllerBranchPromotionResult> = {},
): NativeGitControllerBranchPromotionResult {
  return {
    status: "blocked",
    summary: error,
    error,
    controllerBranch: context.controllerBranch ?? request.controllerBranch,
    controllerHead: context.controllerHead,
    targetRef: context.targetRef ?? request.targetRef,
    targetBranch: context.targetBranch,
    targetWorkspacePath: context.targetWorkspacePath,
    targetHead: context.targetHead,
    promotionCommitSha: context.promotionCommitSha,
  };
}

function gitStatusPorcelain(cwd: string, options: { ignoreWorktreeRoot?: boolean } = {}): string {
  const output = safeGit(cwd, ["status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none"]);
  if (!options.ignoreWorktreeRoot) return output;
  return output
    .split(/\r?\n/)
    .filter((line) => line.trim() && !statusPath(line).startsWith(".worktrees/"))
    .join("\n");
}

function statusPath(line: string): string {
  const raw = line.length > 3 ? line.slice(3).trim() : line.trim();
  const renamed = raw.includes(" -> ") ? raw.split(" -> ").at(-1) ?? raw : raw;
  return renamed.replace(/^"|"$/g, "");
}

function gitIsAncestor(cwd: string, ancestor: string, descendant: string): boolean {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], { cwd, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function branchContainsCommit(cwd: string, commit: string): boolean {
  try {
    return git(cwd, ["branch", "--contains", commit]).trim().length > 0;
  } catch {
    return false;
  }
}

function buildCommitBeforeIntegrationPrompt(request: NativeGitSubagentBranchIntegrationRequest, dirtyStatus: string): string {
  return [
    `[SYSTEM FOLLOW-UP: SUBAGENT_BRANCH_INTEGRATION]`,
    `Controller validation passed for node "${request.node?.nodeId ?? request.subagent.nodeId}", but your subagent worktree cannot be integrated yet because it has uncommitted changes.`,
    `Commit or otherwise persist all intended repository changes on your assigned branch (${request.subagent.branch ?? "current branch"}).`,
    `Current dirty git status:\n${dirtyStatus}`,
    `After committing, report again with SUBAGENT_RESULT: <summary including commit SHA and verification>.`,
  ].join("\n");
}

function buildMergeConflictFollowupPrompt(request: NativeGitSubagentBranchIntegrationRequest, mergeError: string): string {
  return [
    `[SYSTEM FOLLOW-UP: SUBAGENT_BRANCH_INTEGRATION]`,
    `Controller validation passed for node "${request.node?.nodeId ?? request.subagent.nodeId}", but merging your branch into the controller workspace failed.`,
    mergeError,
    `Rebase or merge the latest controller branch into your assigned branch (${request.subagent.branch ?? "current branch"}), resolve conflicts there, rerun relevant validation, commit the result, and report again with SUBAGENT_RESULT: <summary>.`,
  ].join("\n");
}

function gitErrorMessage(error: unknown): string {
  const record = error as { stderr?: Buffer | string; stdout?: Buffer | string; message?: string };
  const output = `${toText(record.stdout)}${toText(record.stderr)}`.trim();
  return output || record.message || String(error);
}

function toText(value: Buffer | string | undefined): string {
  if (value === undefined) return "";
  return typeof value === "string" ? value : value.toString("utf8");
}

function shortSha(value: string): string {
  return value.slice(0, 12);
}

export function findGitRepositoryRoot(startPath: string): string | undefined {
  const output = safeGit(resolve(startPath), ["rev-parse", "--show-toplevel"]);
  return output || undefined;
}

function findGitCommonRepositoryRoot(startPath: string): string | undefined {
  const resolvedStart = resolve(startPath);
  const commonDir = safeGit(resolvedStart, ["rev-parse", "--git-common-dir"]);
  if (!commonDir) return undefined;
  const absoluteCommonDir = isAbsolute(commonDir) ? commonDir : resolve(resolvedStart, commonDir);
  return basename(absoluteCommonDir) === ".git" ? dirname(absoluteCommonDir) : dirname(absoluteCommonDir);
}

function assertSafeWorktreeSlug(value: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value)) {
    throw new Error(`bound subagent worktreeSlug must be a safe single path segment: ${value}`);
  }
  return value;
}

function assertSafeBranchName(repoRoot: string, branch: string): void {
  if (!branch || branch.startsWith("-")) throw new Error(`bound subagent branch is not safe: ${branch}`);
  git(repoRoot, ["check-ref-format", "--branch", branch]);
}

export function slugForGoal(goalId: string, objective: string): string {
  const shortId = sanitizeSlug(goalId).slice(0, 8) || "goal";
  const objectiveSlug = sanitizeSlug(objective).slice(0, 48);
  return objectiveSlug ? `${shortId}-${objectiveSlug}` : shortId;
}

export function slugForGoalSubagent(goalId: string, nodeSlugOrId: string, nodeObjective?: string): string {
  const shortId = sanitizeSlug(goalId).slice(0, 8) || "goal";
  const nodeSlug = sanitizeSlug(nodeSlugOrId).slice(0, 48);
  if (nodeSlug) return `${shortId}-${nodeSlug}`;
  const objectiveSlug = nodeObjective ? sanitizeSlug(nodeObjective).slice(0, 48) : "";
  return objectiveSlug ? `${shortId}-${objectiveSlug}` : shortId;
}

function sanitizeSlug(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  return normalized || sanitizeFallback(value);
}

function sanitizeFallback(value: string): string {
  const fallback = Buffer.from(value).toString("hex").slice(0, 16);
  return fallback || basename(process.cwd()) || "goal";
}

function gitRefExists(repoRoot: string, ref: string): boolean {
  return safeGit(repoRoot, ["show-ref", "--verify", `refs/heads/${ref}`]).length > 0;
}

function resolveExplicitBaseRef(repoRoot: string, ref: string): string {
  if (safeGit(repoRoot, ["rev-parse", "--verify", `${ref}^{commit}`])) return ref;
  throw new Error(`cannot resolve goal workspace base ref: ${ref} is not a commit-ish ref in ${repoRoot}. Fetch or create the branch/ref, or choose an existing base ref.`);
}

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

// ── Submodule publish and closeout helper functions ──

function scanChangedSubmoduleGitlinks(
  parentWorkspacePath: string,
  baseTreeish: string = "HEAD",
  targetTreeish?: string,
): ChangedSubmoduleGitlink[] {
  // When targetTreeish is "INDEX" (integration phase: scan staged vs HEAD):
  //   git diff --raw --abbrev=40 --cached -z HEAD
  // When baseTreeish is "ALL" (scan all gitlinks in target tree):
  //   git ls-tree -r -z targetTreeish (for closeout full-tree verification)
  // When both are commits (closeout phase: scan between two commits):
  //   git diff --raw --abbrev=40 -z baseTreeish targetTreeish
  // -z output produces NUL-terminated records:
  //   :<meta>\0<path>\0         (regular diff)
  //   :<meta>\0<oldPath>\0<newPath>\0  (rename diff)
  const useCached = !targetTreeish || targetTreeish === "INDEX";
  const scanAll = baseTreeish === "ALL";
  const args = scanAll
    ? ["ls-tree", "-r", "-z", targetTreeish!]
    : useCached
    ? ["diff", "--raw", "--abbrev=40", "--cached", "-z", baseTreeish]
    : ["diff", "--raw", "--abbrev=40", "-z", baseTreeish, targetTreeish!];

  let output: string;
  try {
    output = git(parentWorkspacePath, args);
  } catch {
    return [];
  }
  if (!output) return [];

  const gitlinks: ChangedSubmoduleGitlink[] = [];

  if (scanAll) {
    // Parse ls-tree -r -z output: <mode> <type> <sha>\t<path>\0
    const entries = output.split("\0").filter((e) => e.trim());
    for (const entry of entries) {
      const tabIdx = entry.indexOf("\t");
      if (tabIdx === -1) continue;
      const meta = entry.slice(0, tabIdx);
      const p = entry.slice(tabIdx + 1);
      const metaParts = meta.split(/\s+/);
      const mode = metaParts[0];
      if (mode !== "160000") continue;
      const newSha = metaParts[2];
      if (newSha) {
        gitlinks.push({ path: p, status: "added", newSha });
      }
    }
    return gitlinks;
  }

  // Parse diff --raw -z output
  const tokens = output.split("\0");

  let i = 0;
  while (i < tokens.length) {
    const meta = tokens[i];
    if (!meta || !meta.startsWith(":")) { i++; continue; }

    const parts = meta.slice(1).split(/\s+/);
    // parts: [oldMode, newMode, oldSha, newSha, status]
    const oldMode = parts[0];
    const newMode = parts[1];
    const oldShaRaw = parts[2];
    const newShaRaw = parts[3];
    const status = parts[4];

    if (!status) { i++; continue; }

    // Only mode 160000 entries are submodule gitlinks
    if (oldMode !== "160000" && newMode !== "160000") {
      i += status.length > 1 ? 3 : 2; // skip rename (3 tokens) or regular (2)
      continue;
    }

    const oldSha = oldShaRaw !== "0000000000000000000000000000000000000000" ? oldShaRaw : undefined;
    const newSha = newShaRaw !== "0000000000000000000000000000000000000000" ? newShaRaw : undefined;

    let mappedStatus: ChangedSubmoduleGitlink["status"];
    let path: string;
    let oldPath: string | undefined;

    if (status.length > 1) {
      // Rename: R<score>, followed by oldPath then newPath
      mappedStatus = "renamed";
      oldPath = tokens[i + 1] || undefined;
      path = tokens[i + 2] || (tokens[i + 1] ?? "");
      i += 3;
    } else {
      const statusCode = status;
      const p = tokens[i + 1] || "";
      if (statusCode === "A") { mappedStatus = "added"; path = p; }
      else if (statusCode === "D") { mappedStatus = "deleted"; path = p; }
      else { mappedStatus = "modified"; path = p; }
      i += 2;
    }

    if (path) {
      gitlinks.push({ path, status: mappedStatus, oldPath, oldSha, newSha });
    }
  }

  return gitlinks;
}

function resolveSubmoduleCanonicalUrl(
  parentWorkspacePath: string,
  submodulePath: string,
  _treeish: string = "HEAD",
): string | undefined {
  // Parse .gitmodules INI to find the section whose `path` matches submodulePath,
  // then read that section's `url`. Section names in .gitmodules are
  // submodule.<name> where <name> may differ from <path>.
  let config: string;
  try {
    config = readFileSync(join(parentWorkspacePath, ".gitmodules"), "utf8");
  } catch {
    return undefined;
  }

  const lines = config.split(/\r?\n/);
  let currentPath: string | undefined;
  let currentSection: string | undefined;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith(";") || line.startsWith("#")) continue;

    // Section header: [submodule "name"]
    const sectionMatch = line.match(/^\[submodule\s+"([^"]+)"\]$/);
    if (sectionMatch) {
      // Resolve previous section before starting new one
      if (currentSection && currentPath === submodulePath) {
        const key = `submodule.${currentSection}.url`;
        const url = safeGit(parentWorkspacePath, ["config", "-f", ".gitmodules", "--get", key]);
        if (url) return normalizeSubmoduleUrl(url, parentWorkspacePath);
      }
      currentSection = sectionMatch[1];
      currentPath = undefined;
      continue;
    }

    if (!currentSection) continue;

    const kv = line.split(/\s*=\s*/, 2);
    if (kv.length < 2) continue;
    if (kv[0] === "path") currentPath = kv[1];
  }

  // Check last section
  if (currentSection && currentPath === submodulePath) {
    const key = `submodule.${currentSection}.url`;
    const url = safeGit(parentWorkspacePath, ["config", "-f", ".gitmodules", "--get", key]);
    if (url) return normalizeSubmoduleUrl(url, parentWorkspacePath);
  }

  return undefined;
}

function normalizeSubmoduleUrl(url: string, parentWorkspacePath: string): string | undefined {
  if (url.startsWith("./") || url.startsWith("../")) {
    const parentRemoteUrl = safeGit(parentWorkspacePath, ["remote", "get-url", "origin"]);
    if (!parentRemoteUrl) return undefined;
    // Pass the full parent URL (not stripped) to resolveRelativeUrl.
    // For "../sub.git", the first ".." removes the repo name component,
    // giving the correct sibling-repo-in-same-directory result.
    return resolveRelativeUrl(parentRemoteUrl, url);
  }
  return url.trim();
}

function resolveRelativeUrl(base: string, relative: string): string {
  if (relative.startsWith("../")) {
    const baseParts = base.replace(/\/$/, "").split("/");
    const relParts = relative.split("/");
    for (const part of relParts) {
      if (part === "..") baseParts.pop();
      else if (part !== ".") baseParts.push(part);
    }
    return baseParts.join("/");
  }
  if (relative.startsWith("./")) {
    // Remove last path component (the repo filename) for ./ resolution
    const cleanBase = base.replace(/\/[^/]+$/, "");
    const suffix = relative.slice(2);
    return `${cleanBase}/${suffix}`;
  }
  return relative;
}

function isSubmoduleUrlTrusted(
  url: string,
  _gitlink: ChangedSubmoduleGitlink,
  policy: NativeGitCloseoutPolicy,
): boolean {
  // Empty allowlist = fail-closed: no URL is trusted to receive retained ref pushes.
  // Note: verification of SHAs already on durable remote refs does NOT require trust
  // (trust check only gates the publish-retained-ref path).
  if (policy.trustedSubmoduleUrlPatterns.length === 0) {
    return false;
  }
  return policy.trustedSubmoduleUrlPatterns.some((pattern) => {
    if (pattern.endsWith("*")) {
      return url.startsWith(pattern.slice(0, -1));
    }
    return url === pattern;
  });
}

function locateSubmoduleCommitObject(
  sha: string,
  sourceWorkspacePaths: string[],
  submodulePath: string,
): string | undefined {
  for (const workspacePath of sourceWorkspacePaths) {
    if (!workspacePath) continue;
    const submoduleWorktree = resolve(workspacePath, submodulePath);
    const exists = safeGit(submoduleWorktree, ["rev-parse", "--verify", `${sha}^{commit}`]);
    if (exists) return workspacePath;

    const modulesPath = resolve(findGitRepositoryRoot(workspacePath) ?? workspacePath, ".git", "modules", submodulePath);
    const modulesExists = safeGit(modulesPath, ["rev-parse", "--verify", `${sha}^{commit}`]);
    if (modulesExists) return modulesPath;
  }
  return undefined;
}

function findDurableRefContainingSha(
  canonicalUrl: string,
  sha: string,
  durableRefPatterns: string[],
): string | undefined {
  // Collect all remote refs matching durable patterns via ls-remote.
  // For each candidate ref, fetch into a temp bare repo and check if
  // the SHA is reachable. Return the first ref that actually contains
  // the SHA (not just the first candidate).
  for (const pattern of durableRefPatterns) {
    let refsOutput: string;
    try {
      refsOutput = git("/tmp", ["ls-remote", "--refs", canonicalUrl, pattern]);
    } catch {
      continue;
    }
    if (!refsOutput) continue;

    const candidateRefs: string[] = [];
    for (const line of refsOutput.split("\n")) {
      const parts = line.split(/\s+/);
      const ref = parts[1];
      if (ref && !candidateRefs.includes(ref)) candidateRefs.push(ref);
    }

    for (const candidateRef of candidateRefs) {
      const tmpDir = resolve("/tmp", `goal-durable-check-${Date.now()}`);
      try {
        mkdirSync(tmpDir, { recursive: true });
        git(tmpDir, ["init", "--bare"]);
        git(tmpDir, ["fetch", "--no-tags", canonicalUrl, candidateRef]);
        git(tmpDir, ["cat-file", "-e", `${sha}^{commit}`]);
        return candidateRef; // SHA reachable from this durable ref
      } catch {
        // This candidate ref does not contain the SHA — try next
      } finally {
        rmRecursiveSafe(tmpDir);
      }
    }
  }
  return undefined;
}

function publishShaToRetainedRef(
  sourceWorkspacePath: string,
  submodulePath: string,
  canonicalUrl: string,
  sha: string,
  durableRef: string,
): boolean {
  try {
    // Push the specific SHA to the retained ref via canonicalUrl only.
    // Do NOT mutate the submodule workspace's origin remote.
    //
    // The object source may be a regular submodule worktree
    // (resolve(sourceWorkspace, submodulePath)) or a bare git repo
    // at .git/modules/<submodulePath> (use directly).
    let pushRepo: string;
    if (sourceWorkspacePath.includes(`${sep}.git${sep}modules${sep}`)) {
      pushRepo = sourceWorkspacePath;
    } else {
      pushRepo = resolve(sourceWorkspacePath, submodulePath);
      if (!existsSync(pushRepo)) return false;
    }

    // Create-only: refuse to update an existing retained ref with a different SHA.
    try {
      const existing = git("/tmp", ["ls-remote", "--refs", canonicalUrl, durableRef]);
      if (existing) {
        const [existingSha] = existing.split(/\s+/);
        if (existingSha && existingSha === sha) return true; // Already published, same SHA
        return false; // Exists with different SHA — create-only
      }
    } catch {
      // ls-remote unreachable; attempt push below
    }

    execFileSync("git", ["push", "--no-verify", canonicalUrl, `${sha}:${durableRef}`], {
      cwd: pushRepo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}

function verifySubmoduleShaFromIsolatedFetch(
  canonicalUrl: string,
  durableRef: string,
  sha: string,
): boolean {
  const tmpDir = resolve("/tmp", `goal-submodule-fetch-${Date.now()}`);
  try {
    mkdirSync(tmpDir, { recursive: true });
    git(tmpDir, ["init", "--bare"]);
    git(tmpDir, ["remote", "add", "origin", canonicalUrl]);
    git(tmpDir, ["fetch", "--no-tags", "origin", durableRef]);
    // cat-file -e exits 0 with empty output on success; git() returns "".
    // If the object doesn't exist, cat-file -e throws.
    git(tmpDir, ["cat-file", "-e", `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  } finally {
    rmRecursiveSafe(tmpDir);
  }
}

function normalizePromotionTargetRef(
  controllerWorkspacePath: string,
  repoRoot: string,
  targetRef: string,
  remoteName: string,
): NormalizedPromotionTarget | undefined {
  const ref = targetRef.trim();

  // Normalize canonical remote refs: refs/remotes/<remote>/<branch> → treat as remoteRef
  if (ref.startsWith("refs/remotes/")) {
    const afterRemotes = ref.slice("refs/remotes/".length);
    const remotePrefix = `${remoteName}/`;
    if (afterRemotes.startsWith(remotePrefix)) {
      const remoteBranch = afterRemotes.slice(remotePrefix.length);
      const head = safeGit(repoRoot, ["rev-parse", "--verify", "HEAD"]);
      if (!head) return undefined;
      const worktrees = listGitWorktrees(repoRoot);
      const target = worktrees.find((w) => w.branch === remoteBranch);
      return {
        remoteName,
        remoteBranch,
        localTargetBranch: remoteBranch,
        targetWorkspacePath: target?.worktreePath ?? controllerWorkspacePath,
        targetHead: target?.head ?? head,
      };
    }
    return undefined;
  }

  // Normalize canonical local refs: refs/heads/<branch>
  if (ref.startsWith("refs/heads/")) {
    const localBranch = ref.slice("refs/heads/".length);
    const head = safeGit(repoRoot, ["rev-parse", "--verify", `refs/heads/${localBranch}`]);
    if (!head) return undefined;
    const worktrees = listGitWorktrees(repoRoot);
    const target = worktrees.find((w) => w.branch === localBranch);
    return {
      remoteName,
      remoteBranch: localBranch,
      localTargetBranch: localBranch,
      targetWorkspacePath: target?.worktreePath ?? controllerWorkspacePath,
      targetHead: target?.head ?? head,
    };
  }

  // Check if this is a known branch or remote ref BEFORE trying commit-ish.
  // (rev-parse <name>^{commit} succeeds for both branch names and commit SHAs,
  // so we must distinguish: use show-ref to check if it's a branch first.)
  const isRemoteRef = ref.startsWith(`${remoteName}/`);
  const isKnownLocalBranch = gitRefExists(repoRoot, ref);

  // Is it a bare commit SHA or tag (not a known branch/remote ref)?
  if (!isRemoteRef && !isKnownLocalBranch) {
    try {
      const type = git(repoRoot, ["cat-file", "-t", ref]);
      if (type === "commit" || type === "tag") return undefined; // Detached commit/tag
    } catch {
      // Not a valid ref at all
    }
    return undefined;
  }

  if (isRemoteRef) {
    const remoteBranch = ref.slice(remoteName.length + 1);
    const head = safeGit(repoRoot, ["rev-parse", "--verify", "HEAD"]);
    if (!head) return undefined;
    // Find local worktree for this branch
    const worktrees = listGitWorktrees(repoRoot);
    const target = worktrees.find((w) => w.branch === remoteBranch);
    return {
      remoteName,
      remoteBranch,
      localTargetBranch: remoteBranch,
      targetWorkspacePath: target?.worktreePath ?? controllerWorkspacePath,
      targetHead: target?.head ?? head,
    };
  }

  // Local branch name
  const localBranch = ref.replace(/^refs\/heads\//, "");
  const remoteBranch = localBranch;
  const head = safeGit(repoRoot, ["rev-parse", "--verify", `refs/heads/${localBranch}`]);
  if (!head) return undefined;

  const worktrees = listGitWorktrees(repoRoot);
  const target = worktrees.find((w) => w.branch === localBranch);
  const targetWs = target?.worktreePath ?? controllerWorkspacePath;
  const targetHead = target?.head ?? head;

  return {
    remoteName,
    remoteBranch,
    localTargetBranch: localBranch,
    targetWorkspacePath: targetWs,
    targetHead,
  };
}

function rmRecursiveSafe(path: string): void {
  try {
    execFileSync("rm", ["-rf", path], { stdio: "ignore" });
  } catch {
    // Best effort
  }
}
