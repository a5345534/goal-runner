import { type NativeGitSubagentCleanupResult, type NativeGitSubagentCleanupPolicy } from "../../core/index.js";
import type { GoalRuntime } from "../../core/index.js";
import type { ResolvedWorkspaceBinding } from "../pi/workspace.js";
export interface OpencodeGoalCloseoutResult {
    terminal: boolean;
    finalizationChanged: boolean;
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
export declare function finalizeOpencodeGoalFromDagTerminalState(runtime: GoalRuntime, goalId: string, binding: ResolvedWorkspaceBinding, options?: OpencodeGoalCloseoutOptions): Promise<OpencodeGoalCloseoutResult>;
/** Format closeout diagnostics suitable for an opencode notification/log line. */
export declare function formatOpencodeCloseoutDiagnostics(result: OpencodeGoalCloseoutResult, shortGoalId: string): string[];
