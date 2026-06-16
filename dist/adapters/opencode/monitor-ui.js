// Text-based goal monitor for the opencode adapter.
//
// The opencode harness owns the TUI; the opencode adapter cannot mount a
// custom interactive controller. Instead, `/goal monitor [ref]` returns a
// pure-text, multi-line snapshot of:
//
//   * the goal's current status, budget, usage, and elapsed time
//   * each DAG node's status, validation summary, and last activity
//   * each subagent's status, branch, workspace, and self-reported note
//   * the latest controller audit summary, when available
//
// The same renderer is reused by the controller poll loop so the opencode
// session can be sent a refreshed snapshot when a new turn starts.
import { existsSync } from "node:fs";
import { formatAuditSummary, } from "../../core/index.js";
const DEFAULT_MAX_LINE_WIDTH = 96;
export async function readOpencodeGoalMonitorSnapshot(runtime, goal, options = {}) {
    const state = await runtime.getGoalOrchestrationState(goal.goalId);
    // Fetch ledger events for audit summary when not explicitly provided.
    const ledgerEvents = options.ledgerEvents ?? await runtime.listLedgerEvents(goal.sessionKey, goal.goalId);
    const lines = renderOpencodeMonitorLines(goal, state, { ...options, ledgerEvents });
    return { lines, refreshedAt: new Date().toISOString() };
}
export function renderOpencodeMonitorLines(goal, state, options = {}) {
    const maxLineWidth = options.maxLineWidth ?? DEFAULT_MAX_LINE_WIDTH;
    const now = options.now ?? (() => new Date());
    const lines = [];
    lines.push(`Goal ${goal.shortGoalId} monitor — refreshed ${now().toISOString()}`);
    lines.push(`Status: ${goal.status}  Tokens: ${formatTokens(goal)}  Elapsed: ${formatSeconds(goal.timeUsedSeconds)}`);
    lines.push(`Objective: ${truncate(goal.objective ?? goal.objectiveSummary ?? "", maxLineWidth)}`);
    if (goal.executionWorkspace)
        lines.push(`Workspace: ${goal.executionWorkspace}`);
    if (goal.sessionFile)
        lines.push(`Session: ${goal.sessionFile}`);
    // Surface latest controller audit summary when available.
    const auditSummary = extractLatestAuditSummary(options.ledgerEvents);
    if (auditSummary)
        lines.push(`Audit: ${auditSummary}`);
    if (state.nodes.length === 0 && state.subagents.length === 0) {
        lines.push("(no DAG nodes or subagents yet)");
        return lines;
    }
    const subagentsByNode = groupSubagentsByNode(state.subagents);
    state.nodes.forEach((node, index) => {
        lines.push("");
        lines.push(`${index + 1}. [${node.status}] ${truncate(node.slug || node.nodeId, maxLineWidth)} ` +
            `phase=${node.lifecyclePhase ?? "-"} runtime=${formatRuntime(node.createdAt, now())} updated=${formatAgo(node.updatedAt, now())}`);
        if (node.preparedResources) {
            const resourceParts = [
                node.preparedResources.workspacePath ? `workspace=${node.preparedResources.workspacePath}` : undefined,
                node.preparedResources.branch ? `branch=${node.preparedResources.branch}` : undefined,
                node.preparedResources.sessionId ? `session=${node.preparedResources.sessionId}` : undefined,
                node.preparedResources.modelArg ? `model=${node.preparedResources.modelArg}` : undefined,
            ].filter((part) => Boolean(part));
            if (resourceParts.length)
                lines.push(`   resources: ${truncate(resourceParts.join(" "), maxLineWidth - 3)}`);
        }
        if (node.lastAdapterObservation) {
            const observation = `${node.lastAdapterObservation.kind}${node.lastAdapterObservation.error ? ` error=${node.lastAdapterObservation.error}` : node.lastAdapterObservation.summary ? ` summary=${node.lastAdapterObservation.summary}` : ""}`;
            lines.push(`   observation: ${truncate(observation, maxLineWidth - 3)}`);
        }
        if (node.lastRecoveryDecision) {
            const decision = `${node.lastRecoveryDecision.action}${node.lastRecoveryDecision.ruleId ? ` rule=${node.lastRecoveryDecision.ruleId}` : ""}: ${node.lastRecoveryDecision.reason}`;
            lines.push(`   recovery: ${truncate(decision, maxLineWidth - 3)}`);
        }
        if (node.lastValidationSummary)
            lines.push(`   validation: ${truncate(node.lastValidationSummary, maxLineWidth - 3)}`);
        if (node.modelScenario || node.modelArg) {
            const parts = [];
            if (node.modelScenario)
                parts.push(`scenario=${node.modelScenario}`);
            if (node.modelArg)
                parts.push(`model=${node.modelArg}`);
            lines.push(`   model: ${truncate(parts.join(" "), maxLineWidth - 3)}`);
        }
        const subagents = subagentsByNode.get(node.nodeId) ?? [];
        if (subagents.length === 0) {
            lines.push(`   subagents: none`);
            return;
        }
        for (const subagent of subagents) {
            lines.push(`   ↳ [${subagent.status}] ${truncate(subagent.subagentId, maxLineWidth - 6)} ` +
                `runtime=${formatRuntime(subagent.createdAt, now())} last=${formatAgo(subagent.lastActivityAt ?? subagent.updatedAt, now())}`);
            if (subagent.branch)
                lines.push(`      branch: ${truncate(subagent.branch, maxLineWidth - 6)}`);
            if (subagent.workspacePath) {
                const stillExists = subagent.workspacePath && existsSync(subagent.workspacePath);
                lines.push(`      workspace: ${truncate(subagent.workspacePath, maxLineWidth - 6)}${stillExists ? "" : " (missing)"}`);
            }
            if (subagent.lastAdapterObservation)
                lines.push(`      observation: ${truncate(subagent.lastAdapterObservation.kind, maxLineWidth - 6)}`);
            if (subagent.lastRecoveryDecision) {
                const recovery = `${subagent.lastRecoveryDecision.action}${subagent.lastRecoveryDecision.ruleId ? ` rule=${subagent.lastRecoveryDecision.ruleId}` : ""}`;
                lines.push(`      recovery: ${truncate(recovery, maxLineWidth - 6)}`);
            }
            const note = subagent.integrationStatus ?? subagent.selfReportedResult;
            if (note)
                lines.push(`      note: ${truncate(note, maxLineWidth - 6)}`);
        }
    });
    return lines;
}
function groupSubagentsByNode(subagents) {
    const map = new Map();
    for (const subagent of subagents) {
        const list = map.get(subagent.nodeId) ?? [];
        list.push(subagent);
        map.set(subagent.nodeId, list);
    }
    return map;
}
function formatTokens(goal) {
    if (goal.tokenBudget === undefined)
        return `${goal.tokensUsed}`;
    return `${goal.tokensUsed}/${goal.tokenBudget}`;
}
function formatSeconds(seconds) {
    if (seconds < 60)
        return `${seconds}s`;
    if (seconds < 3_600)
        return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
    return `${Math.floor(seconds / 3_600)}h ${Math.floor((seconds % 3_600) / 60)}m`;
}
function formatRuntime(startedAt, now) {
    if (!startedAt)
        return "-";
    const started = Date.parse(startedAt);
    if (!Number.isFinite(started))
        return "-";
    return formatElapsedSeconds(Math.max(0, Math.floor((now.getTime() - started) / 1_000)));
}
function formatAgo(timestamp, now) {
    if (!timestamp)
        return "-";
    const parsed = Date.parse(timestamp);
    if (!Number.isFinite(parsed))
        return "-";
    return `${formatElapsedSeconds(Math.max(0, Math.floor((now.getTime() - parsed) / 1_000)))} ago`;
}
function formatElapsedSeconds(seconds) {
    if (seconds < 60)
        return `${seconds}s`;
    if (seconds < 3_600)
        return `${Math.floor(seconds / 60)}m${seconds % 60 ? ` ${seconds % 60}s` : ""}`;
    return `${Math.floor(seconds / 3_600)}h${Math.floor((seconds % 3_600) / 60) ? ` ${Math.floor((seconds % 3_600) / 60)}m` : ""}`;
}
function truncate(text, maxWidth) {
    if (text.length <= maxWidth)
        return text;
    if (maxWidth <= 4)
        return text.slice(0, maxWidth);
    return `${text.slice(0, maxWidth - 3)}...`;
}
/**
 * Extracts the latest controller audit summary from ledger events.
 * Returns a compact single-line summary suitable for monitor display,
 * or `undefined` when no controller audit has run.
 */
function extractLatestAuditSummary(ledgerEvents) {
    if (!ledgerEvents || ledgerEvents.length === 0)
        return undefined;
    // Find the most recent controller_audit_finished event.
    let latestFinished;
    for (const event of ledgerEvents) {
        if (event.type === "controller_audit_finished") {
            latestFinished = event;
        }
    }
    if (!latestFinished)
        return undefined;
    const details = latestFinished.details ?? {};
    const decision = details;
    if (!decision.risk || !decision.summary)
        return undefined;
    // Collect applied-action events that occurred at or after the finished event.
    const finishedAt = latestFinished.at;
    const appliedActions = [];
    for (const event of ledgerEvents) {
        if (event.type !== "controller_audit_action_applied")
            continue;
        if (event.at < finishedAt)
            continue;
        const actionDetails = (event.details ?? {});
        const actionKind = actionDetails.action ?? "pause-goal";
        const findingKind = actionDetails.matchedFindingKind ?? "unknown";
        const findingConfidence = actionDetails.matchedFindingConfidence ?? "high";
        appliedActions.push({
            action: {
                action: actionKind,
                reason: actionDetails.reason ?? "",
                requiresUserApproval: false,
                nodeId: actionDetails.nodeId,
                subagentId: actionDetails.subagentId,
            },
            matchedFinding: {
                kind: findingKind,
                nodeId: actionDetails.nodeId,
                subagentId: actionDetails.subagentId,
                evidence: [],
                confidence: findingConfidence,
            },
        });
    }
    try {
        return formatAuditSummary(decision, appliedActions);
    }
    catch {
        return undefined;
    }
}
//# sourceMappingURL=monitor-ui.js.map