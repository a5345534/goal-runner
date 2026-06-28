/**
 * Shared monitor overview view model — pure functions that derive a
 * structured `GoalMonitorOverview` from existing goal, DAG, and
 * runtime-summary data.  Both the Pi TUI and OpenCode monitor adapters
 * import from here so health taxonomy, problem summarisation, runtime
 * labels, and event filtering stay consistent.
 */
export const EXTENDED_MONITOR_HEALTH_LABELS = {
    OK: "OK",
    "Needs attention": "Needs attention",
    Waiting: "Waiting",
    Stalled: "Stalled",
    Blocked: "Blocked",
    Complete: "Complete",
    "Complete with warnings": "Complete with warnings",
    Running: "Running",
};
export const MONITOR_NODE_DISPLAY_STATE_LABELS = {
    pending: "pending",
    running: "running",
    validating: "validating",
    needsFollowup: "follow-up",
    recovering: "recovering",
    blocked: "blocked",
    warning: "warning",
    complete: "complete",
    ok: "ok",
    idle: "pending",
};
/** Compact single-char display state for narrow terminals. */
export const MONITOR_NODE_DISPLAY_STATE_CHARS = {
    pending: "○",
    running: "▶",
    validating: "◌",
    needsFollowup: "…",
    recovering: "↻",
    blocked: "⚠",
    warning: "⚠",
    complete: "✓",
    ok: "●",
    idle: "○",
};
// ── User-facing action labels ──
export const ACTION_DISPLAY_LABELS = {
    nodeList: "nodes",
    runnerList: "runners",
    retryNode: "retry node",
    continueNode: "continue node",
    view: "view",
    back: "back",
    pause: "pause",
    resume: "resume",
    clear: "clear",
    openSession: "open session",
    stop: "stop",
    kill: "kill",
    archive: "archive",
    close: "close",
};
// ── User-facing runtime labels (replacing raw enum values) ──
const RUNTIME_SESSION_USER_LABELS = {
    "active-turn": "active turn",
    idle: "idle",
    missing: "session missing",
    "not-materialized": "session not materialized",
    unknown: "unknown session state",
};
const RUNTIME_HIDDEN_USER_LABELS = {
    eligible: "auto-continue ready",
    suppressed: "auto-continue suppressed",
    reserved: "auto-continue reserved",
    started: "auto-continue started",
    "not-configured": "auto-continue not configured",
    "not-eligible": "auto-continue not eligible",
    unknown: "unknown auto-continue",
};
const RUNTIME_POLL_USER_LABELS = {
    active: "polling",
    leased: "leased",
    skipped: "skipped",
    stopped: "stopped",
    unknown: "unknown poll state",
};
/**
 * Derive a `GoalMonitorOverview` synchronously from existing goal, DAG,
 * subagents, runtime summary, and ledger events.
 */
export function buildGoalMonitorOverview(goal, dag, runtimeSummary, options = {}) {
    const health = deriveMonitorHealth(runtimeSummary, goal, dag.subagents, dag.nodes);
    const problem = summarizeMonitorProblem(goal, dag.nodes, dag.subagents);
    const progress = formatProgressLabel(goal, dag.nodes);
    const workersLabel = formatWorkersLabel(dag.subagents, dag.nodes);
    const duration = buildGoalDurationSummary(goal, dag.ledgerEvents ?? [], options.now ?? new Date());
    const runtimeLabel = [
        duration.goalAgeLabel,
        duration.activeWorkLabel,
        duration.lastEventLabel,
    ].filter(Boolean).join(" · ");
    const nextAction = formatNextActionLabel(health, problem, goal);
    const selectedNode = selectNodeForOverview(dag.nodes, dag.subagents, health);
    const selectedDetail = selectedNode
        ? formatSelectedNodeDetail(selectedNode, dag.subagents, dag.ledgerEvents ?? [], options.now ?? new Date())
        : "";
    const selectedNodeDetailLines = selectedNode
        ? buildNodeSelectedDetailLines(selectedNode, dag.subagents, dag.ledgerEvents ?? [], options.now ?? new Date())
        : undefined;
    const recentEvents = formatRecentEvents(dag.ledgerEvents ?? [], options);
    const subagentsByNode = groupSubagentsByNode(dag.subagents);
    const nodeDisplayStates = dag.nodes.map((node) => ({
        nodeId: node.nodeId,
        slug: node.slug || node.nodeId,
        displayState: formatNodeDisplayState(node, subagentsByNode.get(node.nodeId) ?? []),
        summary: formatNodeExecutionPlanSummary(node, subagentsByNode.get(node.nodeId) ?? [], dag.ledgerEvents ?? [], options.now ?? new Date()),
        duration: buildNodeDurationSummary(node, subagentsByNode.get(node.nodeId) ?? [], dag.ledgerEvents ?? [], options.now ?? new Date()),
    }));
    return {
        title: `Goal ${goal.shortGoalId}`,
        statusLabel: `${goal.status}${goal.activityState ? ` · ${goal.activityState}` : ""}`,
        health,
        problemLabel: problem,
        progressLabel: progress,
        runtimeLabel,
        workersLabel,
        nextActionLabel: nextAction,
        selectedDetail,
        selectedNodeDetailLines,
        recentEvents,
        nodeDisplayStates,
    };
}
// ── Updated deriveMonitorHealth with new taxonomy priority ──
/**
 * Returns true when `other` is a newer running/complete replacement for
 * the same node as `failed`. Compares updatedAt (falling back to createdAt)
 * to ensure an older complete subagent does not mask a newer failed one.
 */
function isNewerReplacement(failed, other) {
    if (other.nodeId !== failed.nodeId)
        return false;
    if (other.subagentId === failed.subagentId)
        return false;
    if (!["running", "complete"].includes(other.status))
        return false;
    const failedTime = Date.parse(failed.updatedAt ?? failed.createdAt);
    const otherTime = Date.parse(other.updatedAt ?? other.createdAt);
    if (!Number.isFinite(failedTime) || !Number.isFinite(otherTime))
        return false;
    return otherTime >= failedTime;
}
/**
 * Shared classifier: a subagent is an unresolved residual issue only when
 * its status is blocked/failed/needsFollowup AND no newer running/complete
 * replacement exists for the same node.
 */
function isUnresolvedResidualIssue(subagent, allSubagents) {
    if (!["blocked", "failed", "needsFollowup"].includes(subagent.status))
        return false;
    return !allSubagents.some((other) => isNewerReplacement(subagent, other));
}
/**
 * Derive a monitor health status from the runtime summary, goal, subagents
 * and DAG state.  The new taxonomy gives priority to goal terminal states
 * first, then node/subagent status, then runtime activity.
 */
export function deriveMonitorHealth(summary, goal, subagents, nodes) {
    // ── 1. Goal terminal states have highest priority ──
    if (goal.status === "complete") {
        // A completed goal is never "Blocked".
        // Check for unresolved residual issues (historical failures without replacement).
        // blockedTerminal is terminal; exclude from warning scan.
        const hasWarnings = subagents.some((s) => isUnresolvedResidualIssue(s, subagents))
            || (nodes?.some((n) => ["blocked", "failed"].includes(n.status)) ?? false);
        return hasWarnings ? "Complete with warnings" : "Complete";
    }
    if (goal.status === "blocked") {
        return "Blocked";
    }
    if (goal.status === "paused") {
        return "Waiting";
    }
    if (goal.status === "budgetLimited" || goal.status === "usageLimited") {
        return "Waiting";
    }
    // ── 2. Active goals: current effective state, not historical failures ──
    const blockedNode = nodes?.find((n) => ["blocked", "failed", "blockedTerminal"].includes(n.status));
    const hasRunning = subagents.some((s) => s.status === "running");
    const hasComplete = subagents.some((s) => s.status === "complete");
    // Only count failed/blocked subagents that don't have a newer replacement.
    const failedSubagentsWithNoReplacement = subagents.filter((s) => isUnresolvedResidualIssue(s, subagents));
    if (blockedNode) {
        if (summary.session.state === "active-turn" || summary.runners.running > 0) {
            return "Needs attention";
        }
        return "Blocked";
    }
    if (failedSubagentsWithNoReplacement.length > 0) {
        if (summary.session.state === "active-turn" || summary.runners.running > 0) {
            return "Needs attention";
        }
        return "Blocked";
    }
    // ── 3. Runtime activity ──
    if (hasRunning) {
        return "Running";
    }
    if (summary.runners.running > 0) {
        return "Running";
    }
    if (!hasRunning && !hasComplete) {
        return "Stalled";
    }
    return "OK";
}
// ── Problem summarisation ──
/**
 * Summarise the current problem into a node-centric short phrase.
 * Never includes full subagent IDs longer than ~48 chars in the overview.
 */
export function summarizeMonitorProblem(goal, nodes, subagents) {
    // Completed goals have no "problem" — residual warnings are covered by health.
    if (goal.status === "complete") {
        const warningNode = findResidualWarningNode(nodes, subagents);
        if (warningNode) {
            return `${truncateSlug(warningNode.slug || warningNode.nodeId, 40)} · residual issues after completion`;
        }
        const hasWarnings = subagents.some((s) => isUnresolvedResidualIssue(s, subagents)) || nodes.some((n) => ["blocked", "failed"].includes(n.status));
        return hasWarnings ? "some node · residual issues after completion" : "none";
    }
    // Blocked nodes first (includes blockedTerminal for active goals).
    const blockedNode = nodes.find((n) => ["blocked", "failed", "blockedTerminal"].includes(n.status));
    if (blockedNode) {
        const reason = blockedNode.lastValidationSummary
            ?? findLatestSubagent(nodes, subagents, blockedNode.nodeId)?.selfReportedResult
            ?? findLatestSubagent(nodes, subagents, blockedNode.nodeId)?.integrationError
            ?? "blocked";
        return `${truncateSlug(blockedNode.slug || blockedNode.nodeId, 40)} · ${truncateReason(reason, 60)}`;
    }
    // Blocked/failed subagents (not associated with blocked node).
    // Only count subagents that don't have a newer replacement.
    const failedWithoutReplacement = subagents.filter((s) => isUnresolvedResidualIssue(s, subagents));
    const blockedSub = failedWithoutReplacement[0];
    if (blockedSub) {
        const reason = blockedSub.selfReportedResult ?? blockedSub.integrationError ?? blockedSub.integrationStatus ?? "blocked";
        const node = nodes.find((n) => n.nodeId === blockedSub.nodeId);
        const slug = node?.slug ?? blockedSub.nodeId;
        return `${truncateSlug(slug, 40)} · ${truncateReason(reason, 60)}`;
    }
    // Integration issues.
    const integrationIssue = subagents.find((s) => s.integrationState === "failed" || s.integrationState === "integrating");
    if (integrationIssue) {
        const reason = integrationIssue.integrationError ?? integrationIssue.integrationStatus ?? "integration pending";
        const node = nodes.find((n) => n.nodeId === integrationIssue.nodeId);
        const slug = node?.slug ?? integrationIssue.nodeId;
        return `${truncateSlug(slug, 40)} · ${truncateReason(reason, 60)}`;
    }
    // Goal-level issues.
    if (goal.status === "blocked")
        return "goal blocked · inspect for details";
    if (goal.status === "paused")
        return "goal paused · resume to continue";
    // No obvious problem.
    const hasRunning = subagents.some((s) => s.status === "running");
    if (hasRunning)
        return "none · running";
    const allComplete = subagents.length > 0 && subagents.every((s) => s.status === "complete");
    if (allComplete)
        return "none · awaiting finalisation";
    if (goal.status === "active")
        return "none · active";
    return "none";
}
// ── Runtime summary formatting (user-facing labels) ──
/**
 * Map internal runtime summary state enums to user-facing labels.
 */
export function formatRuntimeSummaryForOverview(summary) {
    const session = RUNTIME_SESSION_USER_LABELS[summary.session.state] ?? summary.session.state;
    const hidden = RUNTIME_HIDDEN_USER_LABELS[summary.hiddenContinuation.state] ?? summary.hiddenContinuation.state;
    const poll = RUNTIME_POLL_USER_LABELS[summary.controllerPoll.state] ?? summary.controllerPoll.state;
    const runners = formatRunnerCountLabel(summary.runners);
    return `session ${session} · ${hidden} · poll ${poll} · runners ${runners}`;
}
function formatRunnerCountLabel(runners) {
    const parts = [];
    if (runners.running > 0)
        parts.push(`${runners.running} running`);
    if (runners.stopped > 0)
        parts.push(`${runners.stopped} stopped`);
    if (runners.duplicateStopped > 0)
        parts.push(`${runners.duplicateStopped} duplicate`);
    if (runners.archived > 0)
        parts.push(`${runners.archived} archived`);
    if (runners.failed > 0)
        parts.push(`${runners.failed} failed`);
    return parts.length > 0 ? parts.join(", ") : "none";
}
// ── Node display state ──
/**
 * Derive a display state for a DAG node based on its own status and the
 * status/history of its associated subagents.
 */
export function formatNodeDisplayState(node, subagents) {
    const nodeSubs = subagents.filter((s) => s.nodeId === node.nodeId);
    // Terminal-ish states first.
    if (node.status === "failed") {
        return hasNodeRecoverySignal(node, nodeSubs) ? "recovering" : "blocked";
    }
    if (node.status === "blocked") {
        return hasNodeRecoverySignal(node, nodeSubs) ? "recovering" : "blocked";
    }
    if (node.status === "blockedTerminal") {
        return hasNodeRecoverySignal(node, nodeSubs) ? "recovering" : "blocked";
    }
    if (node.status === "superseded")
        return "ok";
    // Node is complete but subagents may have residual issues.
    if (node.status === "complete") {
        const hasResidualIssues = nodeSubs.some((s) => isUnresolvedResidualIssue(s, nodeSubs));
        return hasResidualIssues ? "warning" : "complete";
    }
    // Validate/retry state takes priority where evidence is present.
    if (hasNodeRecoverySignal(node, nodeSubs))
        return "recovering";
    // Explicit validator loop.
    if (node.status === "controllerValidating")
        return "validating";
    if (node.lifecyclePhase === "validating")
        return "validating";
    // Running / execution active.
    if (node.status === "running")
        return "running";
    if (nodeSubs.some((subagent) => subagent.status === "running"))
        return "running";
    // Follow-up.
    if (node.status === "needsFollowup")
        return "needsFollowup";
    if (nodeSubs.some((subagent) => subagent.status === "needsFollowup"))
        return "needsFollowup";
    // Planned / pending.
    if (node.status === "planned")
        return "pending";
    if (["ready", "selfReportedComplete"].includes(node.status))
        return "pending";
    return nodeSubs.length > 0 ? "ok" : "pending";
}
function hasNodeRecoverySignal(node, subagents) {
    if (isActiveRecoveryDecision(node.lastRecoveryDecision))
        return true;
    if (containsRecoveryHint(node.lastValidationSummary))
        return true;
    return subagents.some((subagent) => {
        if (subagent.lastRecoveryDecision && isActiveRecoveryDecision(subagent.lastRecoveryDecision))
            return true;
        if (containsRecoveryHint(subagent.integrationStatus))
            return true;
        if (containsRecoveryHint(subagent.selfReportedResult))
            return true;
        if (containsRecoveryHint(subagent.integrationError))
            return true;
        if (subagent.retryCount && subagent.retryCount > 0 && subagent.status !== "complete")
            return true;
        return false;
    });
}
function isActiveRecoveryDecision(decision) {
    if (!decision?.action)
        return false;
    if (["askUser", "markNodeBlocked"].includes(decision.action))
        return false;
    if (typeof decision.maxRetries === "number" && typeof decision.retryCount === "number") {
        return decision.retryCount < decision.maxRetries;
    }
    return true;
}
function containsRecoveryHint(value) {
    if (!value)
        return false;
    return /\b(recovery|retry|recovered|replacing|resurrect|relaunch|prompt|stale|blocked-node|context overflow)\b/i.test(value);
}
// ── Recent events filtering ──
// Events considered "meaningful" for the overview — these are the ones users
// need to see to understand what's happening.  Poll/sync/recovery noise is
// excluded by default.
const MEANINGFUL_EVENT_PREFIXES = [
    "goal.created",
    "goal.replaced",
    "goal.edited",
    "goal.paused",
    "goal.resumed",
    "goal.cleared",
    "goal.completed",
    "goal.blocked",
    "goal.budget_limited",
    "goal.usage_limited",
    "goal.finalized",
    "turn.started",
    "turn.finished",
    "meaningful_progress",
    "continuation.requested",
    "continuation.started",
    "continuation.skipped",
    "validation.failed",
    "validation.passed",
    "validation.result",
    "integration.failed",
    "integration.passed",
    "followup.sent",
    "node.blocked",
    "node.failed",
    "subagent.result",
    "subagent.blocked",
    "subagent.failed",
    "runner.launched",
    "runner.stopped",
    "runner.lost",
    "promotion.started",
    "promotion.passed",
    "promotion.blocked",
    "dag.terminal",
    "controller_audit_finished",
    "recovery.blockedTerminal",
    "staleState.blocked",
];
/**
 * Filter ledger events to 3-8 meaningful events for the overview display.
 * Full history is available in debug/live mode.
 */
export function formatRecentEvents(ledgerEvents, options = {}) {
    const maxEvents = options.maxRecentEvents ?? 8;
    const minEvents = options.minRecentEvents ?? 3;
    const meaningful = ledgerEvents
        .filter(isMeaningfulEvent)
        .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    if (meaningful.length === 0)
        return [];
    // Take the most recent events (up to maxEvents), ensuring we have at least
    // minEvents if available.
    const count = Math.max(minEvents, Math.min(maxEvents, meaningful.length));
    const recent = meaningful.slice(-count);
    return recent.map((event) => formatEventLine(event));
}
function isMeaningfulEvent(event) {
    const eventName = event.type === "controller_event" && typeof event.details?.event === "string"
        ? event.details.event
        : event.type.replace(/_/g, ".");
    return MEANINGFUL_EVENT_PREFIXES.some((prefix) => eventName.startsWith(prefix));
}
function formatEventLine(event) {
    const details = event.details ?? {};
    const eventName = event.type === "controller_event" && typeof details.event === "string"
        ? details.event
        : event.type.replace(/_/g, ".");
    const time = formatCompactTime(event.at);
    const node = typeof details.nodeId === "string" ? ` ${truncateSlug(details.nodeId, 24)}` : "";
    const summary = formatEventSummary(eventName, details);
    return `[${time}] ${eventName}${node}${summary ? ` · ${summary}` : ""}`;
}
function formatCompactTime(isoString) {
    try {
        const d = new Date(isoString);
        const mm = String(d.getMonth() + 1).padStart(2, "0");
        const dd = String(d.getDate()).padStart(2, "0");
        const hh = String(d.getHours()).padStart(2, "0");
        const min = String(d.getMinutes()).padStart(2, "0");
        return `${mm}-${dd} ${hh}:${min}`;
    }
    catch {
        return "??-?? ??:??";
    }
}
function formatEventSummary(eventName, details) {
    if (typeof details.objective === "string")
        return truncateReason(details.objective, 80);
    if (typeof details.summary === "string" && details.summary)
        return truncateReason(details.summary, 80);
    if (typeof details.reason === "string" && details.reason)
        return truncateReason(details.reason, 80);
    if (typeof details.error === "string" && details.error)
        return truncateReason(details.error, 80);
    if (typeof details.status === "string")
        return details.status;
    if (typeof details.action === "string")
        return details.action;
    if (typeof details.to === "string")
        return `→ ${details.to}`;
    return "";
}
// ── Helpers ──
function truncateSlug(slug, maxLen) {
    if (slug.length <= maxLen)
        return slug;
    if (maxLen <= 4)
        return slug.slice(0, maxLen);
    return `${slug.slice(0, maxLen - 3)}...`;
}
function truncateReason(reason, maxLen) {
    const cleaned = reason.replace(/\s+/g, " ").trim();
    if (cleaned.length <= maxLen)
        return cleaned;
    if (maxLen <= 4)
        return cleaned.slice(0, maxLen);
    return `${cleaned.slice(0, maxLen - 3)}...`;
}
function findLatestSubagent(_nodes, subagents, nodeId) {
    return [...subagents]
        .filter((s) => s.nodeId === nodeId)
        .sort((a, b) => {
        const da = Date.parse(a.updatedAt ?? a.createdAt);
        const db = Date.parse(b.updatedAt ?? b.createdAt);
        return db - da;
    })[0];
}
// ── Progress label ──
function formatProgressLabel(_goal, nodes) {
    if (nodes.length === 0)
        return "no DAG nodes planned";
    const complete = nodes.filter((n) => n.status === "complete").length;
    const running = nodes.filter((n) => ["running", "controllerValidating"].includes(n.status)).length;
    const blocked = nodes.filter((n) => ["blocked", "failed"].includes(n.status)).length;
    const planned = nodes.filter((n) => ["planned", "ready"].includes(n.status)).length;
    const parts = [];
    if (complete > 0)
        parts.push(`${complete}/${nodes.length} nodes complete`);
    if (running > 0)
        parts.push(`${running} running`);
    if (blocked > 0)
        parts.push(`${blocked} blocked`);
    if (planned > 0 && running === 0 && blocked === 0)
        parts.push(`${planned} planned`);
    return parts.join(" · ") || "no activity";
}
function formatWorkersLabel(subagents, _nodes) {
    const running = subagents.filter((s) => s.status === "running").length;
    const archived = subagents.filter((s) => ["complete", "superseded"].includes(s.status)).length;
    const failed = subagents.filter((s) => ["blocked", "failed"].includes(s.status)).length;
    const parts = [];
    if (running > 0)
        parts.push(`${running} active`);
    if (archived > 0)
        parts.push(`${archived} archived`);
    if (failed > 0)
        parts.push(`${failed} failed`);
    return parts.join(" · ") || "none";
}
// ── Next action ──
function formatNextActionLabel(health, problem, goal) {
    if (health === "Complete")
        return "goal complete · archive or inspect";
    if (health === "Complete with warnings")
        return "inspect residual issues in execution plan";
    if (health === "Blocked")
        return `inspect blocked items · ${problem}`;
    if (health === "Needs attention")
        return `inspect blocked items · ${problem}`;
    if (health === "Waiting")
        return goal.status === "paused" ? "resume goal to continue" : "goal waiting on budget/usage limit reset";
    if (health === "Stalled")
        return "no running subagents · check controller poll and auto-continue";
    if (health === "Running")
        return "monitor progress";
    return "monitor progress";
}
// ── Selected detail ──
function selectNodeForOverview(nodes, subagents, health) {
    if (nodes.length === 0)
        return undefined;
    if (health === "Blocked" || health === "Needs attention" || health === "Complete with warnings") {
        const warningNode = findResidualWarningNode(nodes, subagents);
        if (warningNode)
            return warningNode;
    }
    return nodes.find((n) => ["running", "controllerValidating"].includes(n.status))
        ?? nodes.find((n) => n.status === "ready")
        ?? nodes[0];
}
function findResidualWarningNode(nodes, subagents) {
    const blockedNode = nodes.find((n) => ["blocked", "failed"].includes(n.status));
    if (blockedNode)
        return blockedNode;
    const failedSubagents = subagents
        .filter((s) => ["blocked", "failed", "needsFollowup"].includes(s.status))
        .filter((s) => !hasReplacementSubagent(s, subagents))
        .sort((left, right) => Date.parse(right.updatedAt ?? right.createdAt) - Date.parse(left.updatedAt ?? left.createdAt));
    if (failedSubagents.length === 0)
        return undefined;
    const relatedNodeId = failedSubagents[0].nodeId;
    return nodes.find((n) => n.nodeId === relatedNodeId);
}
function hasReplacementSubagent(subagent, allSubagents) {
    return allSubagents.some((other) => other.nodeId === subagent.nodeId &&
        other.subagentId !== subagent.subagentId &&
        ["running", "complete"].includes(other.status));
}
function buildNodeSelectedDetailLines(node, subagents, ledgerEvents, now) {
    const relatedSubs = subagents.filter((sub) => sub.nodeId === node.nodeId);
    const duration = buildNodeDurationSummary(node, relatedSubs, ledgerEvents, now);
    const workers = relatedSubs.length;
    const runningWorkers = relatedSubs.filter((s) => s.status === "running").length;
    const model = node.modelScenario || node.modelArg
        ? `${node.modelScenario ? `${node.modelScenario}/` : ""}${node.modelArg ?? ""}`
        : "unknown";
    return [
        `Node: ${truncateSlug(node.slug || node.nodeId, 40)}`,
        `Status: ${node.status}`,
        `Runtime: ${duration.totalLabel}`,
        duration.phaseLabel ? `Phase: ${duration.phaseLabel}` : undefined,
        `Last: ${duration.lastLabel}`,
        `Worker: ${workers} subagent${workers === 1 ? "" : "s"}${runningWorkers > 0 ? ` (${runningWorkers} active)` : ""}`,
        `Model: ${model}`,
    ].filter((line) => Boolean(line)).map((line) => `  ${line}`);
}
function formatSelectedNodeDetail(node, subagents, ledgerEvents, now) {
    const lines = buildNodeSelectedDetailLines(node, subagents, ledgerEvents, now);
    return lines.join(" · ");
}
function formatNodeExecutionPlanSummary(node, relatedSubagents, ledgerEvents, now) {
    const duration = buildNodeDurationSummary(node, relatedSubagents, ledgerEvents, now);
    const isTerminal = ["complete", "blocked", "failed", "superseded"].includes(node.status);
    const parts = [
        duration.totalLabel,
        duration.phaseLabel,
        ...(isTerminal ? [] : [`last ${duration.lastLabel}`]),
    ].filter(Boolean);
    return parts.join(" · ");
}
function buildNodeExecutionPlanSummary(node, relatedSubagents, ledgerEvents, now) {
    return formatNodeExecutionPlanSummary(node, relatedSubagents, ledgerEvents, now);
}
function groupSubagentsByNode(subagents) {
    const map = new Map();
    for (const subagent of subagents) {
        const list = map.get(subagent.nodeId) ?? [];
        list.push(subagent);
        map.set(subagent.nodeId, list);
    }
    for (const list of map.values()) {
        list.sort((left, right) => (parseDate(right.updatedAt)?.getTime() ?? 0) - (parseDate(left.updatedAt)?.getTime() ?? 0));
    }
    return map;
}
function formatCompactNumber(value) {
    if (value >= 1_000_000)
        return `${(value / 1_000_000).toFixed(1)}M`;
    if (value >= 1_000)
        return `${(value / 1_000).toFixed(1)}k`;
    return String(value);
}
function formatElapsedShort(seconds) {
    if (seconds < 60)
        return `${Math.round(seconds)}s`;
    if (seconds < 3_600)
        return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
    return `${Math.floor(seconds / 3_600)}h ${Math.floor((seconds % 3_600) / 60)}m`;
}
export function formatDuration(ms) {
    const seconds = Math.round(Math.abs(ms) / 1000);
    if (seconds < 60)
        return `${seconds}s`;
    if (seconds < 3600)
        return `${Math.floor(seconds / 60)}m`;
    if (seconds < 86400) {
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        return m > 0 ? `${h}h${m}m` : `${h}h`;
    }
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    return h > 0 ? `${d}d${h}h` : `${d}d`;
}
export function formatAgo(date, now) {
    const ms = Math.max(0, now.getTime() - date.getTime());
    const seconds = Math.round(ms / 1000);
    if (seconds < 60)
        return `${seconds}s ago`;
    if (seconds < 3600)
        return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) {
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        return m > 0 ? `${h}h${m}m ago` : `${h}h ago`;
    }
    return `${Math.floor(seconds / 86400)}d ago`;
}
export function classifyStaleness(lastAt, now) {
    const ms = now.getTime() - lastAt.getTime();
    if (ms < 0)
        return "fresh";
    if (ms < 2 * 60_000)
        return "fresh";
    if (ms < 5 * 60_000)
        return "quiet";
    if (ms < 10 * 60_000)
        return "stale";
    if (ms < 30 * 60_000)
        return "stale";
    return "dead";
}
function getEventName(event) {
    const details = event.details ?? {};
    if (typeof details.event === "string")
        return details.event;
    if (typeof details.eventKind === "string")
        return details.eventKind;
    return event.type;
}
function parseDate(value) {
    if (typeof value !== "string")
        return undefined;
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? undefined : d;
}
function matchesNodeEvent(event, nodeId) {
    const details = event.details;
    if (!details || typeof details !== "object")
        return false;
    return details.nodeId === nodeId;
}
function matchesNodeFromSubagent(event, subagent) {
    const details = event.details;
    if (!details || typeof details !== "object")
        return false;
    return details.subagentId === subagent.subagentId || details.subagent_id === subagent.subagentId;
}
function inferNodeEventDate(event) {
    return parseDate(event.at);
}
const NODE_START_EVENTS = new Set([
    "node.started",
    "node.lifecycle.started",
    "subagent.started",
    "validation.started",
    "integration.started",
]);
const NODE_TERMINAL_EVENTS = new Set([
    "node.complete",
    "node.blocked",
    "node.failed",
    "node.superseded",
    "dag.terminal",
]);
const NODE_PHASE_ENTER_EVENTS = new Set([
    "node.phaseChanged",
    "node.lifecycle",
    "validation.started",
    "validation.blocked",
    "integration.started",
    "integration.passed",
    "recovery.actionStarted",
    "subagent.started",
    "subagent.needsFollowup",
]);
const SUBAGENT_STATUS_EVENTS = new Set([
    "subagent.started",
    "subagent.statusChanged",
    "subagent.result",
    "subagent.needsFollowup",
    "subagent.failed",
    "subagent.blocked",
]);
const SUBAGENT_INTEGRATION_EVENTS = new Set([
    "integration.started",
    "integration.passed",
    "integration.failed",
    "integration.followup",
    "integration.blocked",
]);
function inferNodePhaseName(eventName, details) {
    switch (eventName) {
        case "validation.started":
        case "validation.blocked":
        case "validation.passed":
        case "validation.failed":
        case "validation.holding":
        case "validation.followupCapped":
            return "validating";
        case "integration.started":
        case "integration.passed":
        case "integration.failed":
        case "integration.followup":
        case "integration.blocked":
            return "integrating";
        case "subagent.started":
        case "subagent.result":
            return "runnerActive";
        case "subagent.needsFollowup":
            return "needsFollowup";
        case "recovery.actionStarted":
        case "recovery.actionFailed":
        case "recovery.actionTimedOut":
        case "recovery.actionSucceeded":
            return "recovery";
        case "node.phaseChanged":
            return typeof details.to === "string" ? details.to : typeof details.phase === "string" ? details.phase : undefined;
        case "node.lifecycle":
            return typeof details.phase === "string" ? details.phase : undefined;
        case "node.started":
            return "runnerActive";
        case "node.lifecycle.started":
            return typeof details.phase === "string" ? details.phase : "runnerActive";
        default:
            return undefined;
    }
}
function findFirstNodeLedgerEvent(events, nodeId) {
    let result;
    for (const e of events) {
        if (!matchesNodeEvent(e, nodeId))
            continue;
        const eventName = getEventName(e);
        if (!NODE_START_EVENTS.has(eventName))
            continue;
        const at = inferNodeEventDate(e);
        if (!at)
            continue;
        if (!result || at.getTime() < result.at.getTime()) {
            result = { at, confidence: eventName === "node.started" || eventName === "node.lifecycle.started" ? "exact" : "ledger-derived" };
        }
    }
    return result;
}
function findLastNodeLedgerEvent(events, nodeId) {
    let result;
    for (const e of events) {
        if (!matchesNodeEvent(e, nodeId))
            continue;
        const eventName = getEventName(e);
        if (!NODE_TERMINAL_EVENTS.has(eventName))
            continue;
        const at = inferNodeEventDate(e);
        if (!at)
            continue;
        if (!result || at.getTime() > result.at.getTime()) {
            result = { at, confidence: "ledger-derived" };
        }
    }
    return result;
}
function findNodeCurrentPhaseStartAt(events, nodeId, targetPhase) {
    let exact;
    let any;
    for (const e of events) {
        if (!matchesNodeEvent(e, nodeId))
            continue;
        const eventName = getEventName(e);
        if (!NODE_PHASE_ENTER_EVENTS.has(eventName))
            continue;
        const details = (e.details ?? {});
        const phase = inferNodePhaseName(eventName, details);
        if (!phase)
            continue;
        const at = inferNodeEventDate(e);
        if (!at)
            continue;
        const candidate = {
            at,
            phase,
            confidence: (phase === targetPhase ? "exact" : "ledger-derived"),
        };
        if (!any || at.getTime() > any.at.getTime())
            any = candidate;
        if (phase === targetPhase && (!exact || at.getTime() > exact.at.getTime()))
            exact = candidate;
    }
    const best = exact ?? any;
    if (!best)
        return undefined;
    return best;
}
function findLastNodeActivityFromSubagents(subagents) {
    let latest;
    for (const sub of subagents) {
        const candidates = [parseDate(sub.lastActivityAt), parseDate(sub.updatedAt)];
        for (const at of candidates) {
            if (!at)
                continue;
            if (!latest || at.getTime() > latest.getTime())
                latest = at;
        }
    }
    return latest;
}
function findLastNodeActivityAt(node, subagents, events, now) {
    let latest = parseDate(node.updatedAt) ?? now;
    const subLatest = findLastNodeActivityFromSubagents(subagents);
    if (subLatest && subLatest.getTime() > latest.getTime())
        latest = subLatest;
    for (const e of events) {
        if (!matchesNodeEvent(e, node.nodeId))
            continue;
        const at = inferNodeEventDate(e);
        if (!at)
            continue;
        if (at.getTime() > latest.getTime())
            latest = at;
    }
    return latest;
}
export function buildGoalDurationSummary(goal, ledgerEvents, now) {
    const createdAt = parseDate(goal.createdAt) ?? now;
    const goalAge = Math.max(0, now.getTime() - createdAt.getTime());
    let latest;
    for (const e of ledgerEvents) {
        const at = parseDate(e.at);
        if (!at)
            continue;
        if (!latest || at.getTime() > latest.getTime())
            latest = at;
    }
    return {
        goalAgeLabel: `goal age ${formatDuration(goalAge)}`,
        activeWorkLabel: goal.timeUsedSeconds > 0 ? `active work ${formatDuration(goal.timeUsedSeconds * 1_000)}` : undefined,
        lastEventLabel: latest ? `last event ${formatAgo(latest, now)}` : "no events",
        confidence: "ledger-derived",
    };
}
export function buildNodeDurationSummary(node, relatedSubagents, ledgerEvents, now) {
    const createdAt = parseDate(node.createdAt);
    const start = findFirstNodeLedgerEvent(ledgerEvents, node.nodeId);
    const terminal = findLastNodeTerminalEvent(ledgerEvents, node.nodeId);
    const baseAt = start ? start.at : (createdAt ?? now);
    const isTerminal = ["complete", "blocked", "failed", "superseded"].includes(node.status);
    const endAt = isTerminal ? terminal?.at ?? parseDate(node.updatedAt) ?? now : now;
    const totalMs = Math.max(0, endAt.getTime() - baseAt.getTime());
    const phaseTarget = node.lifecyclePhase ?? node.status;
    const phaseStart = findNodeCurrentPhaseStartAt(ledgerEvents, node.nodeId, phaseTarget);
    const lastActivityAt = findLastNodeActivityAt(node, relatedSubagents, ledgerEvents, now);
    const staleLevel = classifyStaleness(lastActivityAt, now);
    let confidence = start ? start.confidence : "fallback";
    if (isTerminal && !terminal && (confidence !== "ledger-derived"))
        confidence = "fallback";
    const totalLabel = isTerminal
        ? `runtime ${formatDuration(totalMs)}`
        : `${confidence === "fallback" ? "age" : "runtime"} ${formatDuration(totalMs)}`;
    const phaseLabel = isTerminal
        ? `completed ${formatAgo(endAt, now)}`
        : phaseStart
            ? `phase ${phaseStart.phase} for ${formatDuration(Math.max(0, now.getTime() - phaseStart.at.getTime()))}`
            : `phase ${phaseTarget} · updated ${formatAgo(lastActivityAt, now)}`;
    return {
        totalLabel,
        phaseLabel,
        statusLabel: `${isTerminal ? "terminal" : "active"} ${formatAgo(lastActivityAt, now)}`,
        lastLabel: formatAgo(lastActivityAt, now),
        staleLevel,
        confidence,
    };
}
function findLastNodeTerminalEvent(events, nodeId) {
    let latest;
    for (const e of events) {
        if (!matchesNodeEvent(e, nodeId))
            continue;
        const eventName = getEventName(e);
        if (!NODE_TERMINAL_EVENTS.has(eventName))
            continue;
        const at = inferNodeEventDate(e);
        if (!at)
            continue;
        if (!latest || at.getTime() > latest.at.getTime()) {
            latest = { at, confidence: "ledger-derived" };
        }
    }
    return latest;
}
function findSubagentStatusTransitionAt(subagent, events) {
    let latest;
    for (const e of events) {
        if (!matchesNodeFromSubagent(e, subagent))
            continue;
        const eventName = getEventName(e);
        if (!SUBAGENT_STATUS_EVENTS.has(eventName))
            continue;
        const at = inferNodeEventDate(e);
        if (!at)
            continue;
        if (!latest || at.getTime() > latest.at.getTime()) {
            latest = { at, confidence: eventName === "subagent.started" ? "exact" : "ledger-derived" };
        }
    }
    return latest;
}
function findSubagentTerminalAt(subagent, events) {
    let latest;
    for (const e of events) {
        if (!matchesNodeFromSubagent(e, subagent))
            continue;
        const eventName = getEventName(e);
        if (eventName !== "subagent.result" && eventName !== "subagent.needsFollowup" && eventName !== "subagent.failed" && eventName !== "subagent.blocked")
            continue;
        const at = inferNodeEventDate(e);
        if (!at)
            continue;
        if (!latest || at.getTime() > latest.at.getTime())
            latest = { at, confidence: "ledger-derived" };
    }
    return latest;
}
function findSubagentIntegrationStartAt(subagent, events) {
    let latest;
    for (const e of events) {
        if (!matchesNodeFromSubagent(e, subagent))
            continue;
        const eventName = getEventName(e);
        if (!SUBAGENT_INTEGRATION_EVENTS.has(eventName))
            continue;
        const at = inferNodeEventDate(e);
        if (!at)
            continue;
        if (!latest || at.getTime() > latest.at.getTime())
            latest = { at, confidence: eventName === "integration.started" ? "exact" : "ledger-derived" };
    }
    return latest;
}
function findLastSubagentEventAt(subagent, events) {
    let latest;
    for (const e of events) {
        if (!matchesNodeFromSubagent(e, subagent))
            continue;
        const at = inferNodeEventDate(e);
        if (!at)
            continue;
        if (!latest || at.getTime() > latest.at.getTime())
            latest = { at, confidence: "ledger-derived" };
    }
    return latest;
}
function findLastSubagentActivityAt(subagent, events, now) {
    let latest = parseDate(subagent.lastActivityAt) ?? parseDate(subagent.updatedAt) ?? now;
    const lastEvent = findLastSubagentEventAt(subagent, events);
    if (lastEvent && lastEvent.at.getTime() > latest.getTime())
        latest = lastEvent.at;
    return latest;
}
export function buildRunnerDurationSummary(subagent, events, now) {
    const createdAt = parseDate(subagent.createdAt) ?? now;
    const createdConfidence = createdAt === now ? "fallback" : "exact";
    const terminal = findSubagentTerminalAt(subagent, events);
    const endAt = terminal?.at ?? now;
    const attemptMs = Math.max(0, endAt.getTime() - createdAt.getTime());
    const statusTransition = findSubagentStatusTransitionAt(subagent, events);
    const lastActivityAt = findLastSubagentActivityAt(subagent, events, now);
    const staleLevel = classifyStaleness(lastActivityAt, now);
    const statusPhase = subagent.integrationState && ["pending", "integrating", "complete", "failed"].includes(subagent.integrationState)
        ? subagent.integrationState
        : undefined;
    const integrationAt = findSubagentIntegrationStartAt(subagent, events);
    const statusAgeLabel = statusTransition
        ? `${subagent.status} for ${formatDuration(Math.max(0, now.getTime() - statusTransition.at.getTime()))}`
        : `${subagent.status} · updated ${formatAgo(lastActivityAt, now)}`;
    const integrationAgeLabel = statusPhase === "pending" || statusPhase === "integrating"
        ? integrationAt
            ? `${statusPhase} for ${formatDuration(Math.max(0, now.getTime() - integrationAt.at.getTime()))}`
            : `${statusPhase}`
        : undefined;
    return {
        attemptRuntimeLabel: createdAt ? `${createdConfidence === "fallback" ? "age" : "attempt"} ${formatDuration(attemptMs)}` : "attempt unknown",
        statusAgeLabel,
        integrationAgeLabel,
        lastActivityLabel: `last activity ${formatAgo(lastActivityAt, now)}`,
        staleLevel,
        confidence: statusTransition ? statusTransition.confidence : createdConfidence,
    };
}
//# sourceMappingURL=monitor-overview.js.map