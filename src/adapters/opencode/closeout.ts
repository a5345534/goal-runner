// Terminal finalization and workspace cleanup for the opencode adapter.
//
// Mirrors the Pi adapter's `finalizeAndCleanupPiGoalIfDagTerminal` step.
// When the opencode adapter's controller poll detects that a goal's DAG
// is in a terminal state, it calls `finalizeOpencodeGoalFromDagTerminalState`
// to:
//
//   1. promote the goal itself to `complete` / `blocked` via the runtime
//      (`runtime.finalizeGoalFromDagTerminalState`)
//   2. clean up each subagent's native-git worktree through
//      `cleanupTerminalSubagentWorkspaces`
//   3. clean up the auto-allocated controller worktree when applicable
//   4. stop the detached `opencode serve` background session for the goal

import { AUTO_ALLOCATED_DEFAULT_CLOSEOUT_POLICY, cleanupTerminalSubagentWorkspaces, NativeGitWorkspaceManager, type NativeGitSubagentCleanupResult, type NativeGitSubagentCleanupPolicy } from "../../core/index.js";
import type { GoalRuntime } from "../../core/index.js";
import type { ResolvedWorkspaceBinding } from "../pi/workspace.js";

export interface OpencodeGoalCloseoutResult {
  terminal: boolean;
  finalizationChanged: boolean;
  closeoutBlockedReason?: string;
  cleanup: NativeGitSubagentCleanupResult[];
  controllerCleanupError?: string;
  backgroundSessionStopped: boolean;
}

export interface OpencodeGoalCloseoutOptions {
  /** Stop and forget the opencode background session for the goal. */
  stopBackgroundSession?: () => void;
  /** When true, treat `binding.workspace` as an auto-allocated controller workspace and clean it up. */
  isAutoAllocatedControllerWorkspace?: (binding: ResolvedWorkspaceBinding) => boolean;
  /** Cleanup policy forwarded to `cleanupTerminalSubagentWorkspaces`. */
  cleanupPolicy?: NativeGitSubagentCleanupPolicy;
}

/**
 * Inspect a goal's DAG terminal state, finalize the goal if the DAG is
 * terminal, and clean up any subagent / controller worktrees. Returns
 * `terminal: true` when the goal's DAG is fully terminal (and the goal
 * was either already finalized or has just been finalized).
 */
export async function finalizeOpencodeGoalFromDagTerminalState(
  runtime: GoalRuntime,
  goalId: string,
  binding: ResolvedWorkspaceBinding,
  options: OpencodeGoalCloseoutOptions = {},
): Promise<OpencodeGoalCloseoutResult> {
  let closeoutBlockedReason: string | undefined;

  // Closeout-time submodule publish re-verification BEFORE finalizing.
  // For auto-allocated controller workspaces, scan ALL submodule gitlinks
  // in the current HEAD tree (not just the last commit diff) and verify
  // each is durably reachable.
  // This must run before finalizeGoalFromDagTerminalState so a blocked
  // re-verify prevents the goal from being marked complete.
  if (options.isAutoAllocatedControllerWorkspace?.(binding)) {
    const manager = new NativeGitWorkspaceManager({ fetch: false });

    // Gate 1: submodule publish re-verification (full tree scan)
    const reverify = manager.ensureSubmoduleGitlinksDurablyPublished({
      goalId,
      parentWorkspacePath: binding.workspace,
      sourceWorkspacePaths: [binding.workspace],
      baseTreeish: "ALL",
      targetTreeish: "HEAD",
      phase: "closeout",
      policy: { ...AUTO_ALLOCATED_DEFAULT_CLOSEOUT_POLICY, submodulePublishMode: "block-if-unpublished" },
    });
    if (reverify.status === "blocked") {
      closeoutBlockedReason = `closeout submodule re-verification blocked: ${reverify.summary}`;
      try {
        await runtime.blockGoalFromControllerCloseout(goalId, closeoutBlockedReason, {
          closeoutGate: "submodulePublish",
          blockers: reverify.blockers.map((b) => ({ path: b.path, reason: b.reason })),
        });
      } catch { /* Best-effort */ }
    }

    // Gate 2: parent push with --recurse-submodules=check (if target ref configured)
    if (!closeoutBlockedReason && binding.promotionTargetRef) {
      const pushTarget = manager.normalizePromotionTarget(
        { controllerWorkspacePath: binding.workspace, controllerBranch: binding.branch, targetRef: binding.promotionTargetRef },
        { ...AUTO_ALLOCATED_DEFAULT_CLOSEOUT_POLICY, remoteCloseoutMode: "push-parent" },
      );
      if (pushTarget.ok) {
        const parentPush = manager.pushParentTargetBranch({
          targetWorkspacePath: pushTarget.value.targetWorkspacePath,
          remoteName: pushTarget.value.remoteName,
          remoteBranch: pushTarget.value.remoteBranch,
          recurseSubmodules: "check",
        });
        if (parentPush.status === "blocked") {
          closeoutBlockedReason = `parent push blocked: ${parentPush.summary}`;
          try {
            await runtime.blockGoalFromControllerCloseout(goalId, closeoutBlockedReason, {
              closeoutGate: "parentPush",
              remoteName: pushTarget.value.remoteName,
              remoteBranch: pushTarget.value.remoteBranch,
            });
          } catch { /* Best-effort */ }
        }
      } else if (pushTarget.reason !== "no promotion target ref configured") {
        // Target ref was provided but normalization failed — block
        closeoutBlockedReason = `parent push target normalization blocked: ${pushTarget.reason}`;
        try {
          await runtime.blockGoalFromControllerCloseout(goalId, closeoutBlockedReason, {
            closeoutGate: "parentPush",
            reason: pushTarget.reason,
          });
        } catch { /* Best-effort */ }
      }
    }
  }

  const finalization = await runtime.finalizeGoalFromDagTerminalState(goalId);
  if (!finalization.terminal) {
    return {
      terminal: false,
      finalizationChanged: finalization.changed,
      closeoutBlockedReason,
      cleanup: [],
      backgroundSessionStopped: false,
    };
  }

  let cleanup: NativeGitSubagentCleanupResult[] = [];

  if (finalization.changed) {
    const state = await runtime.getGoalOrchestrationState(goalId);
    const manager = new NativeGitWorkspaceManager({ fetch: false });

    // Only cleanup if closeout gates passed
    if (!closeoutBlockedReason) {
      cleanup = cleanupTerminalSubagentWorkspaces(manager, state, options.cleanupPolicy);
    }
  }

  let controllerCleanupError: string | undefined;
  if (finalization.changed && !closeoutBlockedReason && options.isAutoAllocatedControllerWorkspace?.(binding)) {
    try {
      const manager = new NativeGitWorkspaceManager({ fetch: false });
      manager.cleanupWorkspace({ worktreePath: binding.workspace, branch: binding.branch });
    } catch (error) {
      controllerCleanupError = error instanceof Error ? error.message : String(error);
    }
  }

  const backgroundSessionStopped = Boolean(options.stopBackgroundSession);
  if (backgroundSessionStopped) options.stopBackgroundSession!();

  return {
    terminal: true,
    finalizationChanged: finalization.changed,
    closeoutBlockedReason,
    cleanup,
    controllerCleanupError,
    backgroundSessionStopped,
  };
}

/** Format closeout diagnostics suitable for an opencode notification/log line. */
export function formatOpencodeCloseoutDiagnostics(
  result: OpencodeGoalCloseoutResult,
  shortGoalId: string,
): string[] {
  const lines: string[] = [];
  if (!result.terminal) return lines;
  if (result.closeoutBlockedReason) {
    lines.push(`Goal ${shortGoalId} closeout blocked: ${result.closeoutBlockedReason}`);
  }
  const errors = result.cleanup.filter((entry) => entry.action === "error");
  if (errors.length > 0) {
    lines.push(
      `Goal ${shortGoalId} completed but ${errors.length} subagent workspace cleanup(s) failed: ${errors
        .map((entry) => entry.error ?? entry.subagentId)
        .join("; ")}`,
    );
  }
  if (result.controllerCleanupError) {
    lines.push(`Goal ${shortGoalId} completed but controller workspace cleanup failed: ${result.controllerCleanupError}`);
  }
  if (result.backgroundSessionStopped) lines.push(`Goal ${shortGoalId} background opencode session stopped.`);
  return lines;
}
