import type { GoalDagNode, GoalOrchestrationState, GoalSubagentRecord } from "./types.js";

export type GoalSubagentIntegrationGateName =
  | "subagent-integration"
  | "subagent-branch-integration"
  | "branch-integration"
  | "native-git-integration"
  | "worktree-merged-pr"
  | "post-merge-validation"
  | "post-merge-validation-ran";

export interface RequiredSubagentIntegrationIssue {
  goalId: string;
  nodeId: string;
  subagentId: string;
  reason: string;
  integrationState?: GoalSubagentRecord["integrationState"];
  integrationStatus?: string;
}

const INTEGRATION_COMPLETION_GATES = new Set<string>([
  "subagent-integration",
  "subagent-branch-integration",
  "branch-integration",
  "native-git-integration",
  "worktree-merged-pr",
  "post-merge-validation",
  "post-merge-validation-ran",
]);

/**
 * Returns true when a subagent's output must be integrated into the
 * controller workspace before the node may be considered complete.
 *
 * Native-git worktree nodes require the gate whenever the subagent record
 * carries branch/workspace evidence, even if the DAG omitted an explicit
 * integration completion gate. DAG authors can also require the gate
 * explicitly with one of the integration completion-gate names above.
 */
export function nodeRequiresSubagentIntegration(node: GoalDagNode, subagent?: GoalSubagentRecord): boolean {
  if (node.completionGates.some((gate) => INTEGRATION_COMPLETION_GATES.has(normalizeGateName(gate)))) return true;
  if (node.validation?.requiredEvidence?.includes("post-merge-validation-ran")) return true;
  if (!subagent) return false;
  const strategy = node.workspaceStrategy?.toLowerCase() ?? "";
  return strategy.includes("native-git") && hasSubagentBranchOrWorkspaceEvidence(subagent);
}

export function subagentIntegrationTerminalSuccess(subagent: GoalSubagentRecord): boolean {
  return subagent.integrationState === "complete" || subagent.integrationState === "not-required";
}

export function requiredSubagentIntegrationTerminalSuccess(subagent: GoalSubagentRecord): boolean {
  if (subagent.integrationState === "complete") return true;
  if (subagent.integrationState !== "not-required") return false;
  // For an explicitly required integration gate, "not-required" is only terminal
  // success when it came from an integrator decision. The controller's generic
  // no-gate path can also write "not-required", but that must not satisfy a DAG
  // contract that explicitly requested branch/worktree integration.
  return Boolean(subagent.integrationCompletedAt);
}

export function nodeRequiredIntegrationsSatisfied(node: GoalDagNode, subagents: GoalSubagentRecord[]): boolean {
  const required = requiredIntegrationCandidateSubagents(node, subagents);
  return required.length === 0 || required.some(requiredSubagentIntegrationTerminalSuccess);
}

export function findRequiredSubagentIntegrationIssues(state: GoalOrchestrationState): RequiredSubagentIntegrationIssue[] {
  const issues: RequiredSubagentIntegrationIssue[] = [];
  for (const node of state.nodes) {
    const required = requiredIntegrationCandidateSubagents(node, state.subagents);
    if (required.length === 0 || required.some(requiredSubagentIntegrationTerminalSuccess)) continue;
    for (const subagent of required) {
      issues.push({
        goalId: subagent.goalId,
        nodeId: subagent.nodeId,
        subagentId: subagent.subagentId,
        reason: requiredIntegrationIssueReason(subagent),
        integrationState: subagent.integrationState,
        integrationStatus: subagent.integrationStatus,
      });
    }
  }
  return issues;
}

function requiredIntegrationCandidateSubagents(node: GoalDagNode, subagents: GoalSubagentRecord[]): GoalSubagentRecord[] {
  return subagents.filter((subagent) => subagent.nodeId === node.nodeId && isIntegrationCandidateSubagent(subagent) && nodeRequiresSubagentIntegration(node, subagent));
}

function requiredIntegrationIssueReason(subagent: GoalSubagentRecord): string {
  if (!subagent.integrationState) return "required subagent integration has no recorded terminal-success state";
  if (subagent.integrationState === "failed") return subagent.integrationError ?? subagent.integrationStatus ?? "required subagent integration failed";
  return `required subagent integration is ${subagent.integrationState}`;
}

export function hasSubagentBranchOrWorkspaceEvidence(subagent: GoalSubagentRecord): boolean {
  return Boolean(subagent.workspacePath || subagent.branch || subagent.ref || subagent.commitSha || subagent.integrationSourceHead);
}

function isIntegrationCandidateSubagent(subagent: GoalSubagentRecord): boolean {
  if (subagent.integrationState) return true;
  return ["selfReportedComplete", "controllerValidating", "complete"].includes(subagent.status);
}

function normalizeGateName(value: string): string {
  return value.trim().toLowerCase().replace(/_/g, "-");
}
