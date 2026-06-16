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
    running: "running",
    idle: "idle",
    blocked: "blocked",
    warning: "warning",
    complete: "complete",
    ok: "ok",
};
/** Compact single-char display state for narrow terminals. */
export const MONITOR_NODE_DISPLAY_STATE_CHARS = {
    running: "▶",
    idle: "⏸",
    blocked: "✖",
    warning: "⚠",
    complete: "✓",
    ok: "○",
};
// ── User-facing action labels ──
export const ACTION_DISPLAY_LABELS = {
    nodeList: "nodes",
    runnerList: "runners",
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
    const runtimeLabel = formatRuntimeSummaryForOverview(runtimeSummary);
    const progress = formatProgressLabel(goal, dag.nodes, dag.subagents);
    const nextAction = formatNextActionLabel(health, problem, goal);
    const selectedDetail = formatSelectedDetail(goal, dag.nodes, dag.subagents, health, problem);
    const recentEvents = formatRecentEvents(dag.ledgerEvents ?? [], options);
    const nodeDisplayStates = dag.nodes.map((node) => ({
        nodeId: node.nodeId,
        slug: node.slug || node.nodeId,
        displayState: formatNodeDisplayState(node, dag.subagents),
        summary: formatNodeOverviewSummary(node, dag.subagents),
    }));
    return {
        title: `Goal ${goal.shortGoalId}`,
        statusLabel: `${goal.status}${goal.activityState ? ` · ${goal.activityState}` : ""}`,
        health,
        problemLabel: problem,
        progressLabel: progress,
        runtimeLabel,
        nextActionLabel: nextAction,
        selectedDetail,
        recentEvents,
        nodeDisplayStates,
    };
}
// ── Updated deriveMonitorHealth with new taxonomy priority ──
/**
 * Derive a monitor health status from the runtime summary, goal, subagents
 * and DAG state.  The new taxonomy gives priority to goal terminal states
 * first, then node/subagent status, then runtime activity.
 */
export function deriveMonitorHealth(summary, goal, subagents, nodes) {
    // ── 1. Goal terminal states have highest priority ──
    if (goal.status === "complete") {
        // A completed goal is never "Blocked".
        // Check for residual warnings (blocked/failed subagents or nodes).
        const hasWarnings = subagents.some((s) => ["blocked", "failed", "needsFollowup"].includes(s.status)) || (nodes?.some((n) => ["blocked", "failed"].includes(n.status)) ?? false);
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
    const blockedNode = nodes?.find((n) => ["blocked", "failed"].includes(n.status));
    const hasRunning = subagents.some((s) => s.status === "running");
    const hasComplete = subagents.some((s) => s.status === "complete");
    // Only count failed/blocked subagents that don't have a newer replacement
    // (running or complete) for the same node.
    const failedSubagentsWithNoReplacement = subagents.filter((s) => ["blocked", "failed", "needsFollowup"].includes(s.status)).filter((failed) => {
        // If any subagent for the same node is running or complete, this failure is historical.
        const hasReplacement = subagents.some((other) => other.nodeId === failed.nodeId &&
            other.subagentId !== failed.subagentId &&
            ["running", "complete"].includes(other.status));
        return !hasReplacement;
    });
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
        const hasWarnings = subagents.some((s) => ["blocked", "failed", "needsFollowup"].includes(s.status)) || nodes.some((n) => ["blocked", "failed"].includes(n.status));
        return hasWarnings
            ? `${nodes.find((n) => ["blocked", "failed"].includes(n.status))?.slug ?? "some node"} · residual issues after completion`
            : "none";
    }
    // Blocked nodes first.
    const blockedNode = nodes.find((n) => ["blocked", "failed"].includes(n.status));
    if (blockedNode) {
        const reason = blockedNode.lastValidationSummary
            ?? findLatestSubagent(nodes, subagents, blockedNode.nodeId)?.selfReportedResult
            ?? findLatestSubagent(nodes, subagents, blockedNode.nodeId)?.integrationError
            ?? "blocked";
        return `${truncateSlug(blockedNode.slug || blockedNode.nodeId, 40)} · ${truncateReason(reason, 60)}`;
    }
    // Blocked/failed subagents (not associated with blocked node).
    // Only count subagents that don't have a newer replacement.
    const failedWithoutReplacement = subagents.filter((s) => ["blocked", "failed", "needsFollowup"].includes(s.status)).filter((failed) => {
        const hasReplacement = subagents.some((other) => other.nodeId === failed.nodeId &&
            other.subagentId !== failed.subagentId &&
            ["running", "complete"].includes(other.status));
        return !hasReplacement;
    });
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
 * Derive a display state for a DAG node based on its own status and
 * the status of its associated subagents.
 */
export function formatNodeDisplayState(node, subagents) {
    const nodeSubs = subagents.filter((s) => s.nodeId === node.nodeId);
    // Terminal states first.
    if (["blocked", "failed"].includes(node.status))
        return "blocked";
    if (node.status === "superseded")
        return "blocked";
    // Node is complete but subagents may have residual issues.
    if (node.status === "complete") {
        const hasResidualIssues = nodeSubs.some((s) => ["blocked", "failed", "needsFollowup"].includes(s.status));
        return hasResidualIssues ? "warning" : "complete";
    }
    // Running.
    if (["running", "controllerValidating"].includes(node.status))
        return "running";
    if (nodeSubs.some((s) => s.status === "running"))
        return "running";
    // Ready but not yet started.
    if (["ready", "planned"].includes(node.status))
        return "idle";
    // Self-reported but waiting on controller.
    if (["selfReportedComplete", "needsFollowup"].includes(node.status))
        return "idle";
    return "ok";
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
];
/**
 * Filter ledger events to 3-8 meaningful events for the overview display.
 * Full history is available in debug/live mode.
 */
export function formatRecentEvents(ledgerEvents, options = {}) {
    const maxEvents = options.maxRecentEvents ?? 5;
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
function formatProgressLabel(goal, nodes, subagents) {
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
    const totalSubagents = subagents.length;
    const runningSubs = subagents.filter((s) => s.status === "running").length;
    if (runningSubs > 0)
        parts.push(`${runningSubs}/${totalSubagents} subagents running`);
    const tokens = typeof goal.tokenBudget === "number"
        ? `${formatCompactNumber(goal.tokensUsed)}/${formatCompactNumber(goal.tokenBudget)} tokens`
        : `${formatCompactNumber(goal.tokensUsed)} tokens`;
    return `${parts.join(" · ")}${parts.length ? " · " : ""}${tokens} · ${formatElapsedShort(goal.timeUsedSeconds)}`;
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
function formatSelectedDetail(goal, nodes, subagents, health, problem) {
    if (nodes.length === 0) {
        return `Workspace: ${goal.executionWorkspace ?? "legacy"} · Session: ${goal.sessionFile ?? "none"}`;
    }
    // Find the most important node to highlight based on health.
    let targetNode;
    if (health === "Blocked" || health === "Needs attention") {
        targetNode = nodes.find((n) => ["blocked", "failed"].includes(n.status))
            ?? nodes.find((n) => {
                const subs = subagents.filter((s) => s.nodeId === n.nodeId);
                return subs.some((s) => ["blocked", "failed", "needsFollowup"].includes(s.status));
            });
    }
    if (!targetNode) {
        targetNode = nodes.find((n) => ["running", "controllerValidating"].includes(n.status))
            ?? nodes[0];
    }
    if (!targetNode)
        return "";
    const subs = subagents.filter((s) => s.nodeId === targetNode.nodeId);
    const subCount = subs.length;
    const runningSubs = subs.filter((s) => s.status === "running").length;
    const model = targetNode.modelScenario || targetNode.modelArg
        ? ` · model=${targetNode.modelScenario ? `${targetNode.modelScenario}/` : ""}${targetNode.modelArg ?? ""}`
        : "";
    return `${truncateSlug(targetNode.slug || targetNode.nodeId, 36)} · status=${targetNode.status} · subagents=${subCount}${runningSubs > 0 ? ` (${runningSubs} running)` : ""}${model}`;
}
// ── Node overview summary ──
function formatNodeOverviewSummary(node, subagents) {
    const subs = subagents.filter((s) => s.nodeId === node.nodeId);
    const statuses = new Map();
    for (const s of subs)
        statuses.set(s.status, (statuses.get(s.status) ?? 0) + 1);
    const parts = [];
    for (const [status, count] of [...statuses.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        parts.push(`${status}=${count}`);
    }
    const model = node.modelScenario || node.modelArg
        ? ` model=${node.modelScenario ?? node.modelArg}`
        : "";
    return `subagents: ${parts.join(", ")}${model}`;
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
//# sourceMappingURL=monitor-overview.js.map