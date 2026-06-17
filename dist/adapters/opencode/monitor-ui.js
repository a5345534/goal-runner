// Text-based goal monitor for the opencode adapter.
//
// The opencode harness owns the TUI; the opencode adapter cannot mount a
// custom interactive controller. Instead, `/goal monitor [ref]` returns a
// pure-text, multi-line snapshot structured into four sections:
//
//   STATUS         — goal identity, status, tokens, elapsed, workspace, activity
//   SUMMARY        — health, problem, progress, runtime, and next-action labels
//   EXECUTION PLAN — per-node display states with symbols and summaries
//   RECENT EVENTS  — filtered meaningful ledger events (3-8)
//
// Full controller history is available on demand (debug mode) but no longer
// dominates the first screen.
//
// The same renderer is reused by the controller poll loop so the opencode
// session can be sent a refreshed snapshot when a new turn starts.
//
// Health taxonomy and problem summarisation are shared with the Pi TUI via
// the `src/adapters/monitor-overview.ts` module.
import { formatAuditSummary, } from "../../core/index.js";
import { buildGoalMonitorRuntimeSummary, } from "../pi/monitor-ui.js";
import { buildGoalMonitorOverview, EXTENDED_MONITOR_HEALTH_LABELS, MONITOR_NODE_DISPLAY_STATE_CHARS, } from "../monitor-overview.js";
const DEFAULT_MAX_LINE_WIDTH = 96;
export async function readOpencodeGoalMonitorSnapshot(runtime, goal, options = {}) {
    const state = await runtime.getGoalOrchestrationState(goal.goalId);
    // Fetch ledger events for audit summary when not explicitly provided.
    const ledgerEvents = options.ledgerEvents ??
        (await runtime.listLedgerEvents(goal.sessionKey, goal.goalId));
    const lines = renderOpencodeMonitorLines(goal, state, {
        ...options,
        ledgerEvents,
    });
    return { lines, refreshedAt: new Date().toISOString() };
}
export function renderOpencodeMonitorLines(goal, state, options = {}) {
    const maxLineWidth = options.maxLineWidth ?? DEFAULT_MAX_LINE_WIDTH;
    const now = options.now ?? (() => new Date());
    const lines = [];
    const uiBoundary = "═".repeat(Math.max(0, maxLineWidth));
    lines.push(uiBoundary);
    lines.push(uiBoundary);
    // ── Build the runtime summary (shared with Pi TUI) ──
    const runtimeSummary = buildGoalMonitorRuntimeSummary(goal, state.subagents, {
        harnessState: options.harnessState,
        reservation: options.reservation,
        ledgerEvents: options.ledgerEvents,
    });
    // ── Build the structured overview model (shared with Pi TUI) ──
    const overview = buildGoalMonitorOverview(goal, {
        nodes: state.nodes,
        subagents: state.subagents,
        ledgerEvents: options.ledgerEvents,
    }, runtimeSummary);
    // ── STATUS section ──
    lines.push("── STATUS ──");
    lines.push(`Goal ${goal.shortGoalId} monitor — refreshed ${now().toISOString()}`);
    lines.push(`Status: ${goal.status}  Tokens: ${formatTokens(goal)}  Elapsed: ${formatSeconds(goal.timeUsedSeconds)}`);
    lines.push(`Objective: ${truncate(goal.objective ?? goal.objectiveSummary ?? "", maxLineWidth)}`);
    if (goal.executionWorkspace)
        lines.push(`Workspace: ${goal.executionWorkspace}`);
    if (goal.sessionFile)
        lines.push(`Session: ${goal.sessionFile}`);
    if (goal.activityState)
        lines.push(`Activity: ${goal.activityState}`);
    // Surface latest controller audit summary when available.
    const auditSummary = extractLatestAuditSummary(options.ledgerEvents);
    if (auditSummary)
        lines.push(`Audit: ${auditSummary}`);
    // ── SUMMARY section ──
    lines.push("");
    lines.push("── SUMMARY ──");
    lines.push(`Health: ${EXTENDED_MONITOR_HEALTH_LABELS[overview.health] ?? overview.health}`);
    lines.push(`Problem: ${overview.problemLabel}`);
    lines.push(`Progress: ${overview.progressLabel}`);
    lines.push(`Runtime: ${overview.runtimeLabel}`);
    lines.push(`Workers: ${overview.workersLabel ?? "none"}`);
    lines.push(`Next Action: ${overview.nextActionLabel}`);
    // ── EXECUTION PLAN section ──
    lines.push("");
    lines.push("── EXECUTION PLAN ──");
    if (overview.nodeDisplayStates.length === 0) {
        lines.push("(no DAG nodes or subagents yet)");
    }
    else {
        for (const nds of overview.nodeDisplayStates) {
            const stateChar = MONITOR_NODE_DISPLAY_STATE_CHARS[nds.displayState] ?? "?";
            lines.push(truncate(`${stateChar} ${nds.slug}: ${nds.summary}`, maxLineWidth));
        }
        // Selected detail — highlights the most important node based on health.
        if (overview.selectedNodeDetailLines?.length) {
            lines.push("");
            for (const detail of overview.selectedNodeDetailLines) {
                lines.push(`Detail: ${truncate(detail, maxLineWidth)}`);
            }
        }
        else if (overview.selectedDetail) {
            lines.push("");
            lines.push(`Detail: ${truncate(overview.selectedDetail, maxLineWidth)}`);
        }
    }
    // ── RECENT EVENTS section ──
    lines.push("");
    lines.push("── RECENT EVENTS ──");
    if (overview.recentEvents.length === 0) {
        lines.push("(no recent meaningful events)");
    }
    else {
        for (const evt of overview.recentEvents) {
            lines.push(truncate(evt, maxLineWidth));
        }
    }
    lines.push(uiBoundary);
    lines.push(uiBoundary);
    return lines;
}
// ── Private helpers ──
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