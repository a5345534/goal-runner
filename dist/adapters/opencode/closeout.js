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
import { cleanupTerminalSubagentWorkspaces, NativeGitWorkspaceManager } from "../../core/index.js";
/**
 * Inspect a goal's DAG terminal state, finalize the goal if the DAG is
 * terminal, and clean up any subagent / controller worktrees. Returns
 * `terminal: true` when the goal's DAG is fully terminal (and the goal
 * was either already finalized or has just been finalized).
 */
export async function finalizeOpencodeGoalFromDagTerminalState(runtime, goalId, binding, options = {}) {
    const finalization = await runtime.finalizeGoalFromDagTerminalState(goalId);
    if (!finalization.terminal) {
        return {
            terminal: false,
            finalizationChanged: finalization.changed,
            cleanup: [],
            backgroundSessionStopped: false,
        };
    }
    let cleanup = [];
    if (finalization.changed) {
        const state = await runtime.getGoalOrchestrationState(goalId);
        const manager = new NativeGitWorkspaceManager({ fetch: false });
        cleanup = cleanupTerminalSubagentWorkspaces(manager, state, options.cleanupPolicy);
    }
    let controllerCleanupError;
    if (finalization.changed && options.isAutoAllocatedControllerWorkspace?.(binding)) {
        try {
            const manager = new NativeGitWorkspaceManager({ fetch: false });
            manager.cleanupWorkspace({ worktreePath: binding.workspace, branch: binding.branch });
        }
        catch (error) {
            controllerCleanupError = error instanceof Error ? error.message : String(error);
        }
    }
    const backgroundSessionStopped = Boolean(options.stopBackgroundSession);
    if (backgroundSessionStopped)
        options.stopBackgroundSession();
    return {
        terminal: true,
        finalizationChanged: finalization.changed,
        cleanup,
        controllerCleanupError,
        backgroundSessionStopped,
    };
}
/** Format closeout diagnostics suitable for an opencode notification/log line. */
export function formatOpencodeCloseoutDiagnostics(result, shortGoalId) {
    const lines = [];
    if (!result.terminal)
        return lines;
    const errors = result.cleanup.filter((entry) => entry.action === "error");
    if (errors.length > 0) {
        lines.push(`Goal ${shortGoalId} completed but ${errors.length} subagent workspace cleanup(s) failed: ${errors
            .map((entry) => entry.error ?? entry.subagentId)
            .join("; ")}`);
    }
    if (result.controllerCleanupError) {
        lines.push(`Goal ${shortGoalId} completed but controller workspace cleanup failed: ${result.controllerCleanupError}`);
    }
    if (result.backgroundSessionStopped)
        lines.push(`Goal ${shortGoalId} background opencode session stopped.`);
    return lines;
}
//# sourceMappingURL=closeout.js.map