import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
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
  created: true;
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
}

export interface NativeGitSubagentBranchIntegrationRequest {
  controllerWorkspacePath: string;
  node?: GoalDagNode;
  subagent: GoalSubagentRecord;
  /** Reserved for future strategy selection. Current implementation uses git merge. */
  strategy?: "merge";
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
  completedAt?: string;
}

export interface NativeGitSubagentBranchIntegratorOptions {
  controllerWorkspacePath: string;
  strategy?: "merge";
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
    const baseSlug = slugForGoalSubagent(request.goalId, request.nodeSlug ?? request.nodeId, request.nodeObjective);
    const baseSubagentId = sanitizeSlug(request.subagentId ?? `subagent-${baseSlug}`);
    const worktreeRoot = this.resolveWorktreeRoot(repoRoot);
    mkdirSync(worktreeRoot, { recursive: true });

    for (let attempt = 0; attempt < 100; attempt += 1) {
      const slug = attempt === 0 ? baseSlug : `${baseSlug}-${attempt + 1}`;
      const subagentId = attempt === 0 ? baseSubagentId : `${baseSubagentId}-${attempt + 1}`;
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
        nodeId: request.nodeId,
        subagentId,
        allocationReason: "subagent-dag-node",
        created: true,
      };
    }

    throw new Error(`cannot allocate unique subagent workspace for DAG node: ${request.nodeId}`);
  }

  cleanupWorkspace(request: NativeGitWorkspaceCleanupRequest): void {
    const repoRoot = request.repoRoot ?? findGitCommonRepositoryRoot(request.worktreePath) ?? findGitRepositoryRoot(request.worktreePath) ?? process.cwd();
    const forceFlag = request.force ? "--force" : undefined;
    const removeArgs = ["worktree", "remove", ...(forceFlag ? [forceFlag] : []), request.worktreePath];
    git(repoRoot, removeArgs);
    if (request.branch) {
      const deleteArgs = ["branch", request.force ? "-D" : "-d", request.branch];
      git(repoRoot, deleteArgs);
    }
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
      return {
        status: "notRequired",
        summary: `subagent branch already matches controller HEAD ${shortSha(controllerHead)}`,
        sourceBranch,
        sourceRef,
        sourceHead,
        integrationCommitSha: controllerHead,
        completedAt: new Date().toISOString(),
      };
    }

    if (gitIsAncestor(controllerWorkspacePath, sourceHead, controllerHead)) {
      return {
        status: "complete",
        summary: `subagent commit ${shortSha(sourceHead)} is already integrated in controller HEAD ${shortSha(controllerHead)}`,
        sourceBranch,
        sourceRef,
        sourceHead,
        integrationCommitSha: controllerHead,
        completedAt: new Date().toISOString(),
      };
    }

    try {
      git(controllerWorkspacePath, ["merge", "--no-ff", "--no-edit", sourceHead]);
      const integrationCommitSha = git(controllerWorkspacePath, ["rev-parse", "--verify", "HEAD"]);
      return {
        status: "complete",
        summary: `merged subagent ${request.subagent.subagentId} ${shortSha(sourceHead)} into controller ${shortSha(integrationCommitSha)}`,
        sourceBranch,
        sourceRef,
        sourceHead,
        integrationCommitSha,
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

  resolveBaseRef(repoRoot: string, overrideBaseRef?: string): string {
    if (overrideBaseRef?.trim()) return overrideBaseRef.trim();
    if (this.options.defaultBaseRef?.trim()) return this.options.defaultBaseRef.trim();

    const remoteHead = safeGit(repoRoot, ["symbolic-ref", "--quiet", "--short", `refs/remotes/${this.options.remote}/HEAD`]);
    if (remoteHead) return remoteHead;

    const currentBranch = safeGit(repoRoot, ["branch", "--show-current"]);
    if (currentBranch) return currentBranch;

    const head = safeGit(repoRoot, ["rev-parse", "--verify", "HEAD"]);
    if (head) return head;

    throw new Error("cannot resolve goal workspace base ref: repository has no HEAD");
  }

  private resolveSubagentBaseRef(repoRoot: string, request: NativeGitSubagentWorkspaceAllocationRequest): string {
    if (request.baseRef?.trim()) return request.baseRef.trim();
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
      baseRef: options.baseRef,
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
      completedAt: result.completedAt,
    };
  };
}

export function cleanupTerminalSubagentWorkspaces(
  manager: NativeGitWorkspaceManager,
  state: GoalOrchestrationState,
  policy: NativeGitSubagentCleanupPolicy = {},
): NativeGitSubagentCleanupResult[] {
  return state.subagents.map((subagent) => cleanupSubagentWorkspace(manager, subagent, policy));
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
  if (decision === "preserve") return cleanupResult(subagent, "preserved", `policy preserves ${subagent.status} workspaces`);

  try {
    manager.cleanupWorkspace({ worktreePath: subagent.workspacePath, branch: subagent.branch, force: policy.force });
    return cleanupResult(subagent, "removed");
  } catch (error) {
    return cleanupResult(subagent, "error", undefined, error instanceof Error ? error.message : String(error));
  }
}

function cleanupDecision(subagent: GoalSubagentRecord, policy: NativeGitSubagentCleanupPolicy): NativeGitSubagentCleanupAction {
  if (subagent.status === "complete") return policy.completed ?? "remove";
  if (subagent.status === "blocked") return policy.blocked ?? "preserve";
  if (subagent.status === "failed") return policy.failed ?? "preserve";
  return "preserve";
}

function cleanupResult(
  subagent: GoalSubagentRecord,
  action: NativeGitSubagentCleanupResult["action"],
  reason?: string,
  error?: string,
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
): NativeGitSubagentBranchIntegrationResult {
  return {
    status: "failed",
    summary: error,
    error,
    followupPrompt,
    sourceBranch: source.sourceBranch,
    sourceRef: source.sourceRef,
    sourceHead: source.sourceHead,
  };
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
