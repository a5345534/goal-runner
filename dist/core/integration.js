const INTEGRATION_COMPLETION_GATES = new Set([
    "subagent-integration",
    "subagent-branch-integration",
    "branch-integration",
    "native-git-integration",
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
export function nodeRequiresSubagentIntegration(node, subagent) {
    if (node.completionGates.some((gate) => INTEGRATION_COMPLETION_GATES.has(normalizeGateName(gate))))
        return true;
    if (!subagent)
        return false;
    const strategy = node.workspaceStrategy?.toLowerCase() ?? "";
    return strategy.includes("native-git") && hasSubagentBranchOrWorkspaceEvidence(subagent);
}
export function subagentIntegrationTerminalSuccess(subagent) {
    return subagent.integrationState === "complete" || subagent.integrationState === "not-required";
}
export function nodeRequiredIntegrationsSatisfied(node, subagents) {
    const required = subagents.filter((subagent) => subagent.nodeId === node.nodeId && nodeRequiresSubagentIntegration(node, subagent));
    return required.length === 0 || required.every(subagentIntegrationTerminalSuccess);
}
export function findRequiredSubagentIntegrationIssues(state) {
    const nodesById = new Map(state.nodes.map((node) => [node.nodeId, node]));
    const issues = [];
    for (const subagent of state.subagents) {
        const node = nodesById.get(subagent.nodeId);
        if (!node || !nodeRequiresSubagentIntegration(node, subagent))
            continue;
        if (subagentIntegrationTerminalSuccess(subagent))
            continue;
        issues.push({
            goalId: subagent.goalId,
            nodeId: subagent.nodeId,
            subagentId: subagent.subagentId,
            reason: requiredIntegrationIssueReason(subagent),
            integrationState: subagent.integrationState,
            integrationStatus: subagent.integrationStatus,
        });
    }
    return issues;
}
function requiredIntegrationIssueReason(subagent) {
    if (!subagent.integrationState)
        return "required subagent integration has no recorded terminal-success state";
    if (subagent.integrationState === "failed")
        return subagent.integrationError ?? subagent.integrationStatus ?? "required subagent integration failed";
    return `required subagent integration is ${subagent.integrationState}`;
}
function hasSubagentBranchOrWorkspaceEvidence(subagent) {
    return Boolean(subagent.workspacePath || subagent.branch || subagent.ref || subagent.commitSha || subagent.integrationSourceHead);
}
function normalizeGateName(value) {
    return value.trim().toLowerCase().replace(/_/g, "-");
}
//# sourceMappingURL=integration.js.map