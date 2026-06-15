import type { GoalDagNode, GoalOrchestrationState, GoalSubagentRecord } from "./types.js";
export type GoalSubagentIntegrationGateName = "subagent-integration" | "subagent-branch-integration" | "branch-integration" | "native-git-integration" | "worktree-merged-pr" | "post-merge-validation" | "post-merge-validation-ran";
export interface RequiredSubagentIntegrationIssue {
    goalId: string;
    nodeId: string;
    subagentId: string;
    reason: string;
    integrationState?: GoalSubagentRecord["integrationState"];
    integrationStatus?: string;
}
/**
 * Returns true when a subagent's output must be integrated into the
 * controller workspace before the node may be considered complete.
 *
 * Native-git worktree nodes require the gate whenever the subagent record
 * carries branch/workspace evidence, even if the DAG omitted an explicit
 * integration completion gate. DAG authors can also require the gate
 * explicitly with one of the integration completion-gate names above.
 */
export declare function nodeRequiresSubagentIntegration(node: GoalDagNode, subagent?: GoalSubagentRecord): boolean;
export declare function subagentIntegrationTerminalSuccess(subagent: GoalSubagentRecord): boolean;
export declare function requiredSubagentIntegrationTerminalSuccess(subagent: GoalSubagentRecord): boolean;
export declare function nodeRequiredIntegrationsSatisfied(node: GoalDagNode, subagents: GoalSubagentRecord[]): boolean;
export declare function findRequiredSubagentIntegrationIssues(state: GoalOrchestrationState): RequiredSubagentIntegrationIssue[];
