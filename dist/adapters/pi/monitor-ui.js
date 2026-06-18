import { existsSync, readFileSync, statSync } from "node:fs";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { formatAuditSummary, } from "../../core/index.js";
import { buildGoalMonitorOverview, EXTENDED_MONITOR_HEALTH_LABELS, MONITOR_NODE_DISPLAY_STATE_CHARS, ACTION_DISPLAY_LABELS, buildNodeDurationSummary, buildRunnerDurationSummary, formatAgo, } from "../monitor-overview.js";
import { filterPiBackgroundRunnersForSubagent } from "./runner-ops.js";
// Canonical state labels shared across Pi TUI and OpenCode monitors.
export const SESSION_STATE_LABELS = {
    "active-turn": "ACTIVE-TURN",
    idle: "IDLE",
    missing: "MISSING",
    "not-materialized": "NOT-MATERIALIZED",
    unknown: "UNKNOWN",
};
export const HIDDEN_CONTINUATION_STATE_LABELS = {
    eligible: "ELIGIBLE",
    suppressed: "SUPPRESSED",
    reserved: "RESERVED",
    started: "STARTED",
    "not-configured": "NOT-CONFIGURED",
    "not-eligible": "NOT-ELIGIBLE",
    unknown: "UNKNOWN",
};
export const CONTROLLER_POLL_STATE_LABELS = {
    active: "ACTIVE",
    leased: "LEASED",
    skipped: "SKIPPED",
    stopped: "STOPPED",
    unknown: "UNKNOWN",
};
/**
 * Derive a `GoalMonitorRuntimeSummary` synchronously from existing runtime
 * and adapter state. No async calls — uses only already-loaded data.
 */
export function buildGoalMonitorRuntimeSummary(goal, subagents, options = {}) {
    const harness = options.harnessState;
    const reservation = options.reservation;
    const ledgerEvents = options.ledgerEvents ?? [];
    const bgRunners = options.runners ?? [];
    const pollGraceMs = options.controllerPollGraceMs ?? 30_000;
    // ── Session state ──
    const sessionState = deriveSessionState(goal, harness);
    // ── Hidden continuation state ──
    const hiddenContinuation = deriveHiddenContinuationState(goal, harness, reservation);
    // ── Controller poll state ──
    const controllerPoll = deriveControllerPollState(ledgerEvents, pollGraceMs);
    // ── Runner counts ──
    const runnerCounts = deriveRunnerCounts(subagents, bgRunners);
    return { session: sessionState, hiddenContinuation, controllerPoll, runners: runnerCounts };
}
function renderAlignedColumns(values, widths) {
    return values
        .map((value, index) => {
        const width = widths[index] ?? 0;
        if (!value)
            return "";
        if (width <= 0)
            return value;
        return fitColumn(value, width);
    })
        .join("  ")
        .trimEnd();
}
function fitColumn(value, width) {
    if (value.length <= width)
        return value.padEnd(width, " ");
    if (width <= 1)
        return value.slice(0, width);
    return `${value.slice(0, width - 1)}…`;
}
function deriveSessionState(goal, harness) {
    if (harness) {
        if (harness.activeTurnId)
            return { state: "active-turn", activeTurnId: harness.activeTurnId };
        if (harness.materialized)
            return { state: "idle" };
        return { state: "not-materialized" };
    }
    // Fallback: derive from activityState when harness not available.
    const activity = goal.activityState ?? "";
    if (activity.includes("active-turn"))
        return { state: "active-turn" };
    if (activity.includes("idle"))
        return { state: "idle" };
    if (["complete"].includes(goal.status))
        return { state: "not-materialized" };
    if (!goal.sessionFile || !existsSync(goal.sessionFile))
        return { state: "missing" };
    return { state: "unknown" };
}
function deriveHiddenContinuationState(goal, harness, reservation) {
    // Check reservation first — most authoritative source.
    if (reservation) {
        if (reservation.status === "started") {
            return { state: "started", attemptId: reservation.attemptId };
        }
        if (reservation.status === "pending") {
            return { state: "reserved", attemptId: reservation.attemptId };
        }
    }
    // Check harness for suppressed continuation.
    if (harness) {
        if (harness.continuationSuppressed) {
            const reason = harness.activeTurnId
                ? "active turn running"
                : harness.queuedUserInput
                    ? "queued user input"
                    : harness.queuedTriggerTurn
                        ? "queued trigger turn"
                        : "suppressed by runtime";
            return { state: "suppressed", reason };
        }
        if (harness.materialized && harness.activeTurnId) {
            // Materialized but not suppressed — could be eligible next cycle.
        }
    }
    // Fallback: derive from activityState.
    const activity = goal.activityState ?? "";
    if (activity.includes("suppressed"))
        return { state: "suppressed", reason: "suppressed by runtime" };
    if (activity.includes("eligible") || activity.includes("idle-eligible"))
        return { state: "eligible" };
    if (activity.includes("idle"))
        return { state: "eligible" };
    if (["complete", "blocked", "failed"].includes(goal.status)) {
        return { state: "not-eligible", reason: `goal status is ${goal.status}` };
    }
    return { state: "unknown" };
}
function deriveControllerPollState(ledgerEvents, pollGraceMs) {
    const pollEvents = ledgerEvents
        .filter((event) => {
        const details = event.details ?? {};
        return event.type === "controller_event" && typeof details.event === "string" && details.event.startsWith("poll.");
    })
        .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    if (pollEvents.length === 0) {
        // Check if we have any controller event — if not, poll may not be configured.
        const hasAnyEvents = ledgerEvents.length > 0;
        return { state: hasAnyEvents ? "skipped" : "unknown" };
    }
    const lastEvent = pollEvents[pollEvents.length - 1];
    const details = (lastEvent.details ?? {});
    const eventName = details.event;
    const lastEventAt = Date.parse(lastEvent.at);
    const now = Date.now();
    if (eventName === "poll.started") {
        const age = now - lastEventAt;
        if (age > pollGraceMs * 2) {
            return { state: "stopped", reason: "no poll finished within grace period", lastPollAt: lastEvent.at };
        }
        return { state: "active", lastPollAt: lastEvent.at };
    }
    if (eventName === "poll.finished") {
        if (typeof details.leased === "boolean" && details.leased) {
            const leaseOwner = typeof details.leaseOwner === "string" ? details.leaseOwner : undefined;
            return { state: "leased", leaseOwner, lastPollAt: lastEvent.at };
        }
        const age = now - lastEventAt;
        if (age > pollGraceMs) {
            return { state: "stopped", reason: "last poll stale", lastPollAt: lastEvent.at };
        }
        return { state: "active", lastPollAt: lastEvent.at };
    }
    if (eventName === "poll.stopped") {
        return { state: "stopped", reason: typeof details.reason === "string" ? details.reason : undefined, lastPollAt: lastEvent.at };
    }
    return { state: "unknown" };
}
function deriveRunnerCounts(subagents, runners) {
    const runnerAlive = new Set(runners.filter((r) => r.runnerAlive || r.childAlive).map((r) => r.subagentId ?? r.configPath));
    // Map by subagentId for quick look-up.
    const runnerBySubagent = new Map();
    for (const runner of runners) {
        const key = runner.subagentId ?? runner.configPath;
        const list = runnerBySubagent.get(key) ?? [];
        list.push(runner);
        runnerBySubagent.set(key, list);
    }
    let running = 0;
    let stopped = 0;
    let duplicateStopped = 0;
    let archived = 0;
    let failed = 0;
    for (const subagent of subagents) {
        const subagentRunners = runnerBySubagent.get(subagent.subagentId) ?? [];
        const aliveCount = subagentRunners.filter((r) => r.runnerAlive || r.childAlive).length;
        const totalCount = subagentRunners.length;
        if (aliveCount > 0) {
            running += aliveCount;
            // Any extra non-alive runners for the same subagent are duplicate-stopped.
            if (totalCount > aliveCount)
                duplicateStopped += totalCount - aliveCount;
        }
        else if (totalCount > 0) {
            stopped += totalCount;
        }
        if (["blocked", "failed"].includes(subagent.status)) {
            failed += 1;
        }
        else if (subagent.status === "complete") {
            archived += 1;
        }
    }
    // Also count runners that aren't associated with any known subagent.
    const knownSubagentIds = new Set(subagents.map((s) => s.subagentId));
    for (const runner of runners) {
        if (runner.subagentId && !knownSubagentIds.has(runner.subagentId)) {
            if (runner.runnerAlive || runner.childAlive) {
                running += 1;
            }
        }
    }
    return { running, stopped, duplicateStopped, archived, failed };
}
/**
 * Derive a monitor health status from the runtime summary and DAG state.
 * Returns { health, nextAction } where nextAction is a one-line recommendation.
 */
export function deriveMonitorHealth(summary, goal, subagents, nodes) {
    // DAG node status has priority over subagent status for health.
    const blockedNode = nodes?.find((n) => ["blocked", "failed"].includes(n.status));
    const hasBlockedOrFailedSubagent = subagents.some((s) => ["blocked", "failed", "needsFollowup"].includes(s.status));
    const hasRunning = subagents.some((s) => s.status === "running");
    const hasComplete = subagents.some((s) => s.status === "complete");
    if (blockedNode) {
        if (summary.session.state === "active-turn" || summary.runners.running > 0) {
            return { health: "Needs attention", nextAction: `inspect blocked node ${blockedNode.nodeId}` };
        }
        return { health: "Blocked", nextAction: `inspect blocked node ${blockedNode.nodeId} or pause/clear goal` };
    }
    if (hasBlockedOrFailedSubagent) {
        if (summary.session.state === "active-turn" || summary.runners.running > 0) {
            return { health: "Needs attention", nextAction: "inspect blocked/failed nodes via nodeList → runnerList" };
        }
        return { health: "Blocked", nextAction: "inspect blocked nodes or pause/clear goal" };
    }
    if (goal.status === "blocked") {
        return { health: "Blocked", nextAction: "inspect goal status or take manual action" };
    }
    if (goal.status === "paused") {
        return { health: "Waiting", nextAction: "resume goal to continue" };
    }
    if (goal.status === "budgetLimited" || goal.status === "usageLimited") {
        return { health: "Waiting", nextAction: "goal waiting on budget/usage limit reset" };
    }
    if (goal.status === "complete") {
        return { health: "OK", nextAction: "goal complete — archive or inspect" };
    }
    if (hasRunning && summary.controllerPoll.state === "active") {
        return { health: "OK", nextAction: "monitor progress" };
    }
    if (summary.runners.running > 0 && summary.controllerPoll.state === "unknown") {
        return { health: "OK", nextAction: "monitor progress" };
    }
    if (!hasRunning && !hasComplete) {
        return { health: "Stalled", nextAction: "no running subagents — check controller poll and hidden continuation" };
    }
    return { health: "OK", nextAction: "monitor progress" };
}
const DEFAULT_VISIBLE_LIVE_LINES = 18;
const DEFAULT_VISIBLE_LIST_LINES = 14;
export class GoalMonitorController {
    goal;
    readTranscript;
    readDagSnapshot;
    now;
    activePane = "list";
    scope = { kind: "controller" };
    listIndex = 0;
    listScroll = 0;
    liveScroll = 0;
    followLiveTail = true;
    controllerHistoryMode = "compact";
    rowOperationIndex = 0;
    lastLiveLineCount = 0;
    lastListLineCount = 0;
    lastListItems = [];
    lastSelectedOperations = [];
    constructor(goal, readTranscript = () => readControllerTranscript(this.goal.sessionFile), readDagSnapshot = () => ({ nodes: [], subagents: [] }), now = () => new Date()) {
        this.goal = goal;
        this.readTranscript = readTranscript;
        this.readDagSnapshot = readDagSnapshot;
        this.now = now;
    }
    get actions() {
        return controllerActions(this.goal);
    }
    handleInput(data) {
        if (matchesKey(data, Key.escape))
            return { kind: "close" };
        if (matchesKey(data, Key.left)) {
            this.moveRowOperation(-1);
            return undefined;
        }
        if (matchesKey(data, Key.right)) {
            this.moveRowOperation(1);
            return undefined;
        }
        if (matchesKey(data, Key.tab)) {
            this.activePane = this.activePane === "live" ? "list" : "live";
            return undefined;
        }
        if (data === "l" || data === "L" || data === "d" || data === "D") {
            this.activePane = "list";
            return undefined;
        }
        if (data === "v" || data === "V" || data === "t" || data === "T") {
            this.activePane = "live";
            return undefined;
        }
        if (data === "b" || data === "B" || matchesKey(data, Key.backspace)) {
            this.goBack();
            return undefined;
        }
        if (data === "c" || data === "C") {
            this.controllerHistoryMode = this.controllerHistoryMode === "compact" ? "debug" : "compact";
            this.followLiveTail = true;
            return undefined;
        }
        if (matchesKey(data, Key.up)) {
            this.moveActivePane(-1);
            return undefined;
        }
        if (matchesKey(data, Key.down)) {
            this.moveActivePane(1);
            return undefined;
        }
        if (matchesKey(data, Key.pageUp)) {
            this.moveActivePane(-this.activePageSize());
            return undefined;
        }
        if (matchesKey(data, Key.pageDown)) {
            this.moveActivePane(this.activePageSize());
            return undefined;
        }
        if (matchesKey(data, Key.home)) {
            this.moveActivePaneToTop();
            return undefined;
        }
        if (matchesKey(data, Key.end)) {
            this.moveActivePaneToEnd();
            return undefined;
        }
        if (matchesKey(data, Key.enter)) {
            return this.confirmSelectedOperation();
        }
        return undefined;
    }
    activePageSize() {
        const visibleCount = this.activePane === "list" ? DEFAULT_VISIBLE_LIST_LINES : DEFAULT_VISIBLE_LIVE_LINES;
        return Math.max(1, visibleCount - 1);
    }
    moveActivePane(delta) {
        if (this.activePane === "list") {
            this.moveListSelection(delta);
            return;
        }
        this.followLiveTail = false;
        this.liveScroll = Math.max(0, this.liveScroll + delta);
    }
    moveActivePaneToTop() {
        if (this.activePane === "list") {
            this.listIndex = 0;
            this.listScroll = 0;
            return;
        }
        this.followLiveTail = false;
        this.liveScroll = 0;
    }
    moveActivePaneToEnd() {
        if (this.activePane === "list") {
            this.listIndex = Math.max(0, this.lastListLineCount - 1);
            this.listScroll = Math.max(0, this.lastListLineCount - DEFAULT_VISIBLE_LIST_LINES);
            return;
        }
        this.followLiveTail = true;
        this.liveScroll = Math.max(0, this.lastLiveLineCount - DEFAULT_VISIBLE_LIVE_LINES);
    }
    moveListSelection(delta) {
        if (this.lastListLineCount <= 0)
            return;
        this.listIndex = Math.min(Math.max(0, this.listIndex + delta), this.lastListLineCount - 1);
        this.rowOperationIndex = 0;
        this.keepSelectedListRowVisible();
    }
    keepSelectedListRowVisible() {
        if (this.listIndex < this.listScroll)
            this.listScroll = this.listIndex;
        if (this.listIndex >= this.listScroll + DEFAULT_VISIBLE_LIST_LINES)
            this.listScroll = this.listIndex - DEFAULT_VISIBLE_LIST_LINES + 1;
    }
    moveRowOperation(delta) {
        const count = this.lastSelectedOperations.length;
        if (count <= 0)
            return;
        this.rowOperationIndex = (this.rowOperationIndex + delta + count) % count;
    }
    confirmSelectedOperation() {
        const operation = this.lastSelectedOperations[this.rowOperationIndex];
        if (!operation)
            return undefined;
        if (operation.kind === "action") {
            return operation.action === "close" ? { kind: "close" } : { kind: "action", action: operation.action };
        }
        if (operation.kind === "runner") {
            return { kind: "runnerOperation", operation: operation.operation, subagentId: operation.subagentId };
        }
        switch (operation.operation) {
            case "nodeList":
                this.enterNodeList();
                return undefined;
            case "runnerList": {
                const selected = this.lastListItems[Math.min(this.listIndex, this.lastListItems.length - 1)];
                if (selected?.kind === "node")
                    this.enterRunnerList(selected.nodeId);
                return undefined;
            }
            case "back":
                this.goBack();
                return undefined;
            case "view":
                return undefined;
        }
    }
    enterNodeList() {
        this.scope = { kind: "nodes" };
        this.resetListAndLive({ followLiveTail: false });
    }
    enterRunnerList(nodeId) {
        this.scope = { kind: "runners", nodeId };
        this.resetListAndLive({ followLiveTail: true });
    }
    goBack() {
        if (this.scope.kind === "controller")
            return;
        this.scope = this.scope.kind === "runners" ? { kind: "nodes" } : { kind: "controller" };
        this.resetListAndLive({ followLiveTail: this.scope.kind !== "nodes" });
    }
    resetListAndLive(options) {
        this.activePane = "list";
        this.listIndex = 0;
        this.listScroll = 0;
        this.liveScroll = 0;
        this.rowOperationIndex = 0;
        this.followLiveTail = options.followLiveTail;
    }
    render(width, theme) {
        const controllerTranscript = this.readTranscript();
        const dag = this.readDagSnapshot();
        // ── Runtime summary ──
        const runtimeSummary = buildGoalMonitorRuntimeSummary(this.goal, dag.subagents, {
            harnessState: dag.harnessState,
            reservation: dag.reservation,
            ledgerEvents: dag.ledgerEvents,
            runners: dag.runners,
        });
        // ── Build the structured overview model (shared with OpenCode adapter) ──
        const overview = buildGoalMonitorOverview(this.goal, { nodes: dag.nodes, subagents: dag.subagents, ledgerEvents: dag.ledgerEvents }, runtimeSummary, { now: new Date() });
        const view = this.buildView(dag, controllerTranscript, overview);
        const visibleLiveCount = DEFAULT_VISIBLE_LIVE_LINES;
        const visibleListCount = DEFAULT_VISIBLE_LIST_LINES;
        this.lastListItems = view.listItems;
        this.lastListLineCount = view.listRows.length;
        const previousLiveLineCount = this.lastLiveLineCount;
        this.lastLiveLineCount = view.liveLines.length;
        this.listIndex = Math.min(Math.max(0, this.listIndex), Math.max(0, view.listRows.length - 1));
        this.keepSelectedListRowVisible();
        this.listScroll = clampScroll(this.listScroll, view.listRows.length, visibleListCount);
        this.lastSelectedOperations = operationsForListItem(this.lastListItems[this.listIndex], this.goal, dag);
        this.rowOperationIndex = Math.min(Math.max(0, this.rowOperationIndex), Math.max(0, this.lastSelectedOperations.length - 1));
        const previousLiveTail = Math.max(0, previousLiveLineCount - visibleLiveCount);
        if (view.liveFollowsTail && (this.followLiveTail || this.liveScroll >= previousLiveTail)) {
            this.followLiveTail = true;
            this.liveScroll = Math.max(0, view.liveLines.length - visibleLiveCount);
        }
        else {
            this.followLiveTail = view.liveFollowsTail ? this.followLiveTail : false;
            this.liveScroll = clampScroll(this.liveScroll, view.liveLines.length, visibleLiveCount);
        }
        const isNarrow = width <= 80;
        const lines = [];
        const uiBoundaryLine = truncateToWidth(theme.fg("borderMuted", "═".repeat(Math.max(0, width))), width);
        lines.push(uiBoundaryLine);
        // ── OVERVIEW HEADER ──
        lines.push(...renderOverviewHeader(overview, runtimeSummary, width, isNarrow, theme));
        // ── EXECUTION PLAN (controller scope only) ──
        if (this.scope.kind === "controller") {
            lines.push(...renderExecutionPlanSection(overview, dag, width, isNarrow, theme));
        }
        // ── RECENT EVENTS (controller scope only, after execution plan) ──
        if (this.scope.kind === "controller" && overview.recentEvents.length > 0) {
            lines.push(truncateToWidth(theme.fg("borderMuted", "─".repeat(Math.max(0, width))), width));
            lines.push(truncateToWidth(theme.fg("accent", `RECENT EVENTS (${overview.recentEvents.length} meaningful, ${dag.ledgerEvents?.length ?? 0} raw · c toggles debug history in LIVE pane)`), width));
            for (const evt of overview.recentEvents) {
                lines.push(truncateToWidth(theme.fg("dim", evt), width));
            }
        }
        // ── RUNTIME BAND + DEBUG META ──
        const showDebugMeta = this.controllerHistoryMode === "debug" || this.activePane === "live";
        if (showDebugMeta) {
            lines.push(...formatRuntimeBandLines(runtimeSummary, { health: overview.health, nextAction: overview.nextActionLabel }, width, theme));
        }
        const compactMeta = isNarrow
            ? `scope=${view.scopeLabel} focus=${this.activePane} rowOp=${formatPlainOperation(this.lastSelectedOperations[this.rowOperationIndex])}`
            : `scope=${view.scopeLabel} focus=${this.activePane} rowOp=${formatPlainOperation(this.lastSelectedOperations[this.rowOperationIndex])} status=${derivedMonitorStatus(this.goal, dag)} tokens=${formatMonitorTokens(this.goal)} DAG nodes=${formatStatusCounts(dag.nodes.map((node) => node.status))} subagents=${formatStatusCounts(dag.subagents.map((subagent) => subagent.status))} elapsed=${formatElapsedSeconds(this.goal.timeUsedSeconds)}`;
        // ── LIVE PANE ──
        // Always use the original live view (compact/debug controller history or runner transcript).
        // Recent events from the overview are shown above as a dedicated section.
        const liveTitle = view.liveTitle;
        lines.push(truncateToWidth(theme.fg("borderMuted", "─".repeat(Math.max(0, width))), width));
        lines.push(truncateToWidth(theme.fg(this.activePane === "live" ? "accent" : "muted", `${this.activePane === "live" ? "▶ " : "  "}LIVE: ${liveTitle}`), width));
        const liveLines = view.liveLines;
        const liveDiag = view.liveDiagnostic;
        const liveFollowsTail = view.liveFollowsTail;
        const auditSummary = this.scope.kind === "controller" ? extractLatestAuditSummary(dag.ledgerEvents) : undefined;
        if (auditSummary)
            lines.push(truncateToWidth(theme.fg("warning", auditSummary), width));
        if (liveDiag)
            lines.push(truncateToWidth(theme.fg("warning", liveDiag), width));
        if (liveLines.length === 0)
            lines.push(truncateToWidth(theme.fg("muted", "No live entries available"), width));
        const followTail = liveFollowsTail && this.followLiveTail;
        const liveScrollVal = followTail
            ? Math.max(0, liveLines.length - visibleLiveCount)
            : clampScroll(this.liveScroll, liveLines.length, visibleLiveCount);
        const liveStart = liveScrollVal;
        const liveEnd = Math.min(liveLines.length, liveStart + visibleLiveCount);
        for (const line of liveLines.slice(liveStart, liveEnd))
            lines.push(truncateToWidth(line, width));
        // ── LIST PANE ──
        lines.push(truncateToWidth(theme.fg("borderMuted", "─".repeat(Math.max(0, width))), width));
        lines.push(truncateToWidth(theme.fg(this.activePane === "list" ? "accent" : "muted", `${this.activePane === "list" ? "▶ " : "  "}LIST: ${view.listTitle}`), width));
        if (view.listRows.length === 0) {
            lines.push(truncateToWidth(theme.fg("muted", "No selectable rows for this scope"), width));
            lines.push(truncateToWidth(theme.fg("borderMuted", "─".repeat(Math.max(0, width))), width));
            lines.push(truncateToWidth(theme.fg("dim", this.formatMonitorKeysHelp(this.activePane)), width));
            if (showDebugMeta) {
                lines.push(truncateToWidth(theme.fg("dim", `Debug: ${compactMeta}`), width));
            }
            lines.push(uiBoundaryLine);
            return lines;
        }
        const listStart = this.listScroll;
        const listEnd = Math.min(view.listRows.length, listStart + visibleListCount);
        for (let index = listStart; index < listEnd; index += 1) {
            const row = view.listRows[index] ?? "";
            const selected = index === this.listIndex;
            const ops = selected ? formatRowOperations(this.lastSelectedOperations, this.rowOperationIndex, theme) : "";
            lines.push(truncateToWidth(selected ? theme.fg("accent", `> ${row}${ops ? `  ops: ${ops}` : ""}`) : `  ${row}`, width));
        }
        // ── FOOTER: keys (+ optional debug metadata) ──
        lines.push(truncateToWidth(theme.fg("borderMuted", "─".repeat(Math.max(0, width))), width));
        lines.push(truncateToWidth(theme.fg("dim", this.formatMonitorKeysHelp(this.activePane)), width));
        if (showDebugMeta) {
            lines.push(truncateToWidth(theme.fg("dim", `Debug: ${compactMeta}`), width));
        }
        lines.push(uiBoundaryLine);
        return lines;
    }
    formatMonitorKeysHelp(activePane) {
        // Keep behavior stable on normal keys and add explicit Home/End navigation hints.
        // Home always jumps to top in list or live view; End jumps to bottom or live tail.
        const scopeLabel = activePane === "live" ? "LIVE" : "LIST";
        const endMeaning = activePane === "live" ? "live tail" : "bottom";
        return `Keys: ←→ select action · ↑↓/PgUp/PgDn scroll ${scopeLabel} · Home top · End ${endMeaning} · Enter confirm · b back · Tab switch · c debug · Esc close`;
    }
    buildView(dag, controllerTranscript, overview) {
        const now = this.now();
        const nodesById = new Map(dag.nodes.map((node) => [node.nodeId, node]));
        const subagentsByNode = groupSubagentsByNode(dag.subagents);
        let scope = this.scope;
        if (scope.kind === "runners" && !nodesById.has(scope.nodeId))
            scope = { kind: "nodes" };
        this.scope = scope;
        if (scope.kind === "controller") {
            const historyLines = renderControllerHistoryLines(this.goal, dag, controllerTranscript, this.controllerHistoryMode);
            return {
                scopeLabel: "controller",
                liveTitle: formatControllerLiveTitle(dag, historyLines, controllerTranscript, this.controllerHistoryMode),
                liveLines: historyLines,
                liveDiagnostic: currentControllerBlockerDiagnostic(this.goal, dag) ?? (historyLines.length > 0 ? undefined : controllerTranscript.diagnostic),
                liveFollowsTail: true,
                listTitle: "Controller",
                listRows: [renderControllerListRow(this.goal, dag)],
                listItems: [{ kind: "controller" }],
            };
        }
        if (scope.kind === "nodes") {
            const selectedNode = dag.nodes.length
                ? dag.nodes[Math.min(Math.max(0, this.listIndex), dag.nodes.length - 1)]
                : undefined;
            const durationByNode = new Map(overview.nodeDisplayStates.map((state) => [state.nodeId, state.duration]));
            return {
                scopeLabel: "nodes",
                liveTitle: "Node list mode",
                liveLines: selectedNode
                    ? [
                        `selected node: ${shortenMiddle(selectedNode.slug || selectedNode.nodeId, 50)}`,
                        `status: ${selectedNode.status}`,
                        durationByNode.get(selectedNode.nodeId)?.totalLabel ? `runtime: ${durationByNode.get(selectedNode.nodeId).totalLabel}` : undefined,
                        durationByNode.get(selectedNode.nodeId)?.phaseLabel ? `phase: ${durationByNode.get(selectedNode.nodeId).phaseLabel}` : undefined,
                        durationByNode.get(selectedNode.nodeId)?.lastLabel ? `last: ${durationByNode.get(selectedNode.nodeId).lastLabel}` : undefined,
                    ].filter((line) => Boolean(line))
                    : [],
                liveFollowsTail: false,
                listTitle: `Nodes ${dag.nodes.length ? `${Math.min(this.listIndex + 1, dag.nodes.length)}/${dag.nodes.length}` : "0"}`,
                listRows: dag.nodes.map((node, index) => {
                    const duration = durationByNode.get(node.nodeId);
                    return renderNodeListRow(node, subagentsByNode.get(node.nodeId) ?? [], index, now, duration);
                }),
                listItems: dag.nodes.map((node) => ({ kind: "node", nodeId: node.nodeId })),
            };
        }
        const node = nodesById.get(scope.nodeId);
        const nodeSubagents = subagentsByNode.get(node.nodeId) ?? [];
        const selectedIndex = Math.min(Math.max(0, this.listIndex), Math.max(0, nodeSubagents.length - 1));
        const runner = nodeSubagents[selectedIndex];
        if (!runner) {
            return {
                scopeLabel: `runners/${shortenMiddle(node.slug || node.nodeId, 40)}`,
                liveTitle: `Runner live for ${node.nodeId}`,
                liveLines: [],
                liveDiagnostic: "No runners recorded for selected node",
                liveFollowsTail: false,
                listTitle: `Runners for ${shortenMiddle(node.slug || node.nodeId, 48)} 0`,
                listRows: [],
                listItems: [],
            };
        }
        const transcript = readGoalTranscript(runner.sessionFile);
        const runnerRecords = (dag.runners ?? []).filter((record) => record.subagentId === runner.subagentId);
        const runnerSummary = buildRunnerDurationSummary(runner, dag.ledgerEvents ?? [], now);
        const enrichedSummary = enrichRunnerSummaryWithProcess(runnerSummary, runnerRecords, now);
        return {
            scopeLabel: `runners/${shortenMiddle(node.slug || node.nodeId, 40)}`,
            liveTitle: formatRunnerLiveTitle(node, runner, transcript, runnerRecords),
            liveLines: renderRunnerLiveLines(node, runner, transcript, enrichedSummary),
            liveDiagnostic: transcript.diagnostic,
            liveFollowsTail: false,
            listTitle: `Runners for ${shortenMiddle(node.slug || node.nodeId, 48)} ${nodeSubagents.length ? `${Math.min(this.listIndex + 1, nodeSubagents.length)}/${nodeSubagents.length}` : "0"}`,
            listRows: nodeSubagents.map((subagent, index) => {
                const summary = buildRunnerDurationSummary(subagent, dag.ledgerEvents ?? [], now);
                const matching = filterPiBackgroundRunnersForSubagent(dag.runners ?? [], subagent.subagentId);
                const enriched = enrichRunnerSummaryWithProcess(summary, matching, now);
                return renderRunnerListRow(subagent, index, now, enriched);
            }),
            listItems: nodeSubagents.map((subagent) => ({ kind: "runner", nodeId: node.nodeId, subagentId: subagent.subagentId })),
        };
    }
}
function clampScroll(scroll, totalLines, visibleLines) {
    return Math.min(Math.max(0, scroll), Math.max(0, totalLines - visibleLines));
}
function controllerActions(goal) {
    const actions = [];
    if (goal.status === "active")
        actions.push("pause");
    if (["active", "paused", "blocked", "budgetLimited", "usageLimited"].includes(goal.status))
        actions.push("resume");
    actions.push("clear");
    if (goal.sessionFile && existsSync(goal.sessionFile))
        actions.push("openSession");
    actions.push("close");
    return actions;
}
function operationsForListItem(item, goal, dag) {
    if (!item)
        return [];
    if (item.kind === "controller") {
        return [
            { kind: "internal", operation: "nodeList", label: userActionLabel("nodeList") },
            ...controllerActions(goal).map((action) => ({ kind: "action", action, label: userActionLabel(action) })),
        ];
    }
    if (item.kind === "node") {
        const runnerCount = dag.subagents.filter((subagent) => subagent.nodeId === item.nodeId).length;
        return [
            { kind: "internal", operation: "runnerList", label: `${userActionLabel("runnerList")}(${runnerCount})` },
            { kind: "internal", operation: "back", label: userActionLabel("back") },
        ];
    }
    const subagent = dag.subagents.find((record) => record.subagentId === item.subagentId);
    const runnerRecords = (dag.runners ?? []).filter((runner) => runner.subagentId === item.subagentId);
    const hasLiveRunner = runnerRecords.some((runner) => runner.runnerAlive || runner.childAlive);
    const operations = [{ kind: "internal", operation: "view", label: userActionLabel("view") }];
    if (subagent?.sessionFile)
        operations.push({ kind: "runner", operation: "openSession", subagentId: item.subagentId, label: userActionLabel("openSession") });
    if (hasLiveRunner)
        operations.push({ kind: "runner", operation: "stop", subagentId: item.subagentId, label: userActionLabel("stop") });
    if (hasLiveRunner)
        operations.push({ kind: "runner", operation: "kill", subagentId: item.subagentId, label: userActionLabel("kill") });
    if (runnerRecords.length > 0)
        operations.push({ kind: "runner", operation: "archive", subagentId: item.subagentId, label: userActionLabel("archive") });
    operations.push({ kind: "internal", operation: "back", label: userActionLabel("back") });
    return operations;
}
/** Map an operation ID to its user-facing label using ACTION_DISPLAY_LABELS. */
function userActionLabel(operationId) {
    return ACTION_DISPLAY_LABELS[operationId] ?? operationId;
}
function formatPlainOperation(operation) {
    if (!operation)
        return "-";
    // Return the raw operation ID for the compact meta line, not the user-facing label.
    if (operation.kind === "internal")
        return operation.operation;
    if (operation.kind === "action")
        return operation.action;
    if (operation.kind === "runner")
        return operation.operation;
    return "-";
}
function formatRowOperations(operations, selectedIndex, theme) {
    return operations
        .map((operation, index) => index === selectedIndex ? theme.fg("accent", `[${operation.label}]`) : theme.fg("dim", ` ${operation.label} `))
        .join(" ");
}
function buildMonitorActionsLine(operations, selectedIndex, theme) {
    if (operations.length === 0)
        return theme.fg("dim", "Actions: none");
    const labels = operations
        .map((operation, index) => {
        const text = `[${operation.label}]`;
        return index === selectedIndex ? theme.fg("accent", text) : theme.fg("dim", text);
    })
        .join(" ");
    return `${theme.fg("dim", "Actions:")} ${labels}`;
}
function groupSubagentsByNode(subagents) {
    const grouped = new Map();
    for (const subagent of subagents) {
        const list = grouped.get(subagent.nodeId) ?? [];
        list.push(subagent);
        grouped.set(subagent.nodeId, list);
    }
    for (const list of grouped.values()) {
        list.sort((left, right) => compareIso(left.createdAt, right.createdAt) || left.subagentId.localeCompare(right.subagentId));
    }
    return grouped;
}
function latestSubagent(subagents) {
    return [...subagents].sort((left, right) => compareIso(right.updatedAt, left.updatedAt) || compareIso(right.lastActivityAt, left.lastActivityAt))[0];
}
function compareIso(left, right) {
    return Date.parse(left ?? "") - Date.parse(right ?? "");
}
function renderControllerListRow(goal, dag) {
    return `[controller] status=${goal.status}/${goal.activityState ?? "-"} nodes=${formatStatusCounts(dag.nodes.map((node) => node.status))} runners=${formatStatusCounts(dag.subagents.map((subagent) => subagent.status))} history=${dag.ledgerEvents?.length ?? 0}`;
}
function formatControllerLiveTitle(dag, lines, controllerTranscript, mode) {
    const events = dag.ledgerEvents ?? [];
    if (events.length > 0) {
        if (mode === "debug")
            return `Controller history debug (${events.length} event${events.length === 1 ? "" : "s"})`;
        return `Controller history compact (${lines.length} line${lines.length === 1 ? "" : "s"}, ${events.length} raw event${events.length === 1 ? "" : "s"})`;
    }
    if (controllerTranscript.lines.length > 0)
        return `Controller legacy transcript fallback (${lines.length} line${lines.length === 1 ? "" : "s"})`;
    return "Controller history (0 events)";
}
function renderControllerHistoryLines(_goal, dag, controllerTranscript, mode) {
    const events = dag.ledgerEvents ?? [];
    if (events.length === 0)
        return controllerTranscript.lines;
    if (mode === "debug")
        return events.map((event) => renderControllerHistoryEvent(event));
    return renderCompactControllerHistoryEvents(events);
}
function renderCompactControllerHistoryEvents(events) {
    const folds = [];
    for (const event of events) {
        const eventName = controllerHistoryEventName(event);
        const details = event.details ?? {};
        if (!isCompactControllerHistoryEvent(eventName, details))
            continue;
        const fingerprint = controllerHistoryFingerprint(eventName, details);
        const previous = folds[folds.length - 1];
        if (previous?.fingerprint === fingerprint) {
            previous.count += 1;
            previous.event = event;
            continue;
        }
        folds.push({ fingerprint, event, count: 1 });
    }
    return folds.map((fold) => renderControllerHistoryEvent(fold.event, fold.count));
}
function controllerHistoryEventName(event) {
    const details = event.details ?? {};
    return event.type === "controller_event" && typeof details.event === "string" ? details.event : event.type.replace(/_/g, ".");
}
function isCompactControllerHistoryEvent(eventName, details = {}) {
    if (details.eventCategory === "poll")
        return false;
    return ![
        "poll.started",
        "poll.finished",
        "subagent.synced",
        "validation.started",
        "validation.holding",
        "recovery.started",
        "recovery.actionSucceeded",
    ].includes(eventName);
}
function controllerHistoryFingerprint(eventName, details) {
    return JSON.stringify({
        eventName,
        nodeId: details.nodeId,
        subagentId: details.subagentId,
        from: details.from,
        to: details.to,
        status: details.status,
        summary: normalizeHistoryFingerprintValue(details.summary),
        reason: normalizeHistoryFingerprintValue(details.reason),
        error: normalizeHistoryFingerprintValue(details.error),
        targetRef: details.targetRef,
        branch: details.branch ?? details.controllerBranch,
    });
}
function normalizeHistoryFingerprintValue(value) {
    if (value === undefined || value === null)
        return undefined;
    const text = typeof value === "string" ? value : Array.isArray(value) ? value.join(",") : String(value);
    const normalized = text.replace(/\s+/g, " ").trim();
    return normalized || undefined;
}
function renderControllerHistoryEvent(event, repeatCount = 1) {
    const details = event.details ?? {};
    const eventName = controllerHistoryEventName(event);
    const label = repeatCount > 1 ? `${eventName} ×${repeatCount}` : eventName;
    const renderedDetails = formatControllerHistoryDetails(eventName, details);
    return `[${compactTimestamp(event.at)}] ${label.padEnd(24)}${renderedDetails ? ` ${renderedDetails}` : ""}`;
}
function currentControllerBlockerDiagnostic(goal, dag) {
    const nodesByUpdated = [...dag.nodes].sort((left, right) => compareIso(right.updatedAt, left.updatedAt));
    const blockedNode = nodesByUpdated.find((node) => ["blocked", "failed"].includes(node.status));
    if (blockedNode) {
        const relatedSubagents = dag.subagents.filter((subagent) => subagent.nodeId === blockedNode.nodeId);
        const latest = latestSubagent(relatedSubagents);
        const reason = blockedNode.lastValidationSummary ?? latest?.integrationError ?? latest?.integrationStatus ?? latest?.selfReportedResult;
        return `Current blocker: ${blockedNode.nodeId} [${blockedNode.status}]${reason ? ` — ${shortenMiddle(reason.replace(/\s+/g, " ").trim(), 180)}` : ""}`;
    }
    const blockedSubagent = latestSubagent(dag.subagents.filter((subagent) => ["blocked", "failed", "needsFollowup"].includes(subagent.status)));
    if (blockedSubagent) {
        const reason = blockedSubagent.integrationError ?? blockedSubagent.integrationStatus ?? blockedSubagent.selfReportedResult;
        return `Current blocker: ${blockedSubagent.nodeId}/${blockedSubagent.subagentId} [${blockedSubagent.status}]${reason ? ` — ${shortenMiddle(reason.replace(/\s+/g, " ").trim(), 180)}` : ""}`;
    }
    if (["blocked", "failed", "budgetLimited", "usageLimited"].includes(goal.status))
        return `Current blocker: goal status=${goal.status}`;
    return undefined;
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
function formatControllerHistoryDetails(eventName, details) {
    if (eventName === "goal.created" && typeof details.objective === "string")
        return shortenMiddle(details.objective, 140);
    const parts = [];
    const append = (label, value, max = 96) => {
        if (value === undefined || value === null || value === "")
            return;
        const text = typeof value === "string" ? value : Array.isArray(value) ? value.join(",") : String(value);
        if (!text)
            return;
        parts.push(`${label}=${shortenMiddle(text.replace(/\s+/g, " ").trim(), max)}`);
    };
    append("node", details.nodeId, 56);
    append("subagent", details.subagentId, 56);
    append("from", details.from, 32);
    append("to", details.to, 32);
    append("status", details.status, 32);
    append("summary", details.summary, 140);
    append("reason", details.reason, 140);
    append("error", details.error, 140);
    append("observation", details.observation, 48);
    append("action", details.action, 48);
    append("rule", details.ruleId, 72);
    append("category", details.eventCategory, 32);
    append("activation", details.activationState, 32);
    for (const key of ["started", "synced", "validating", "completed", "followups", "blocked", "failed", "ready", "queueBlocked", "nodes", "subagents", "validators", "expectedOutputs", "retry", "maxRetries", "signals", "changed", "allComplete", "integrationIssues", "subagentCleanupErrors"]) {
        append(key, details[key], 32);
    }
    append("branch", details.branch ?? details.controllerBranch, 72);
    append("target", details.targetRef, 72);
    append("workspace", details.workspace, 96);
    append("head", details.head ?? details.sourceHead, 40);
    append("merge", details.integrationCommitSha, 40);
    append("model", details.model, 72);
    append("scenario", details.scenario, 48);
    return parts.join(" ");
}
function renderNodeListRow(node, subagents, index, now, durationSummary) {
    const summary = durationSummary ?? buildNodeDurationSummary(node, subagents, [], now);
    const workers = subagents.length;
    const phaseLabel = summary.phaseLabel ?? `phase ${node.lifecyclePhase ?? node.status}`;
    const model = formatNodeMonitorModel(node);
    const lastText = formatDurationWithoutAgo(summary.lastLabel);
    return renderAlignedColumns([
        `${index + 1}.`,
        shortenMiddle(node.slug || node.nodeId, 30),
        node.status,
        summary.totalLabel,
        phaseLabel,
        `last ${lastText}`,
        `${workers} runner${workers === 1 ? "" : "s"}`,
        model ? `model=${model}` : "",
    ], [3, 30, 9, 9, 16, 10, 9, 16]);
}
function renderRunnerListRow(subagent, index, now, summary) {
    const statusText = normalizeRunnerStatusAgeLabel(summary.statusAgeLabel, renderRunnerStatus(subagent));
    const lastText = formatDurationWithoutAgo(summary.lastActivityLabel).replace(/^last activity\s+/, "last ");
    return renderAlignedColumns([
        `${index + 1}.`,
        shortenMiddle(subagent.subagentId, 40),
        statusText,
        summary.attemptRuntimeLabel,
        lastText,
        summary.integrationAgeLabel ?? "",
        `process ${formatRunnerProcessLabel(summary.processSeenLabel ?? "unknown")}`,
    ], [4, 40, 16, 10, 10, 14, 0]);
}
function normalizeRunnerStatusAgeLabel(statusAgeLabel, fallback) {
    if (!statusAgeLabel)
        return fallback;
    return statusAgeLabel.replace(/^status\s+/, "");
}
function formatDurationWithoutAgo(value) {
    return value.replace(/ ago$/u, "");
}
function formatRunnerProcessLabel(value) {
    if (value.startsWith("alive"))
        return "alive";
    if (value.startsWith("not alive"))
        return "not alive";
    return value;
}
function formatRunnerLiveTitle(node, subagent, transcript, runners) {
    const runnerRuntime = runners.find((runner) => runner.modelArg || runner.thinkingLevel);
    const scenario = node.preparedResources?.modelScenario ?? node.modelScenario;
    const modelArg = transcript.modelArg ?? runnerRuntime?.modelArg ?? node.preparedResources?.modelArg ?? node.modelArg;
    const thinkingLevel = transcript.thinkingLevel ?? runnerRuntime?.thinkingLevel ?? node.preparedResources?.thinkingLevel ?? node.thinkingLevel;
    const model = formatMonitorModel(scenario, modelArg, thinkingLevel);
    return `Runner ${subagent.subagentId} model=${model} tokens=${formatCompactNumber(transcript.tokenTotal ?? 0)}`;
}
function renderRunnerLiveLines(node, subagent, transcript, summary) {
    const integration = formatSubagentIntegration(subagent);
    const note = subagent.integrationStatus ?? subagent.selfReportedResult;
    const prepared = formatPreparedResources(node);
    return [
        "RUNNER SUMMARY",
        `Status: ${renderRunnerStatus(subagent)}`,
        `Runtime: ${summary.attemptRuntimeLabel}`,
        summary.statusAgeLabel ? `Status age: ${summary.statusAgeLabel}` : undefined,
        `Activity: ${summary.lastActivityLabel}`,
        summary.processSeenLabel ? `Process: ${summary.processSeenLabel}` : "Process: unknown",
        summary.integrationAgeLabel ? `Integration: ${summary.integrationAgeLabel}` : undefined,
        `Model: ${formatNodeMonitorModel(node) ?? "unknown"}`,
        `Issue: ${formatMonitorValidationContract(node)}`,
        `Node: ${node.nodeId} (${node.status})`,
        node.preparedResources ? `prepared: ${prepared}` : undefined,
        subagent.branch ? `branch: ${subagent.branch}` : undefined,
        subagent.workspacePath ? `workspace: ${shortenPath(subagent.workspacePath)}` : undefined,
        subagent.sessionFile ? `session: ${shortenPath(subagent.sessionFile)}` : undefined,
        subagent.lastAdapterObservation ? `observation: ${formatObservation(subagent.lastAdapterObservation.kind, subagent.lastAdapterObservation.error ?? subagent.lastAdapterObservation.summary)}` : undefined,
        subagent.lastRecoveryDecision ? `recovery: ${formatRecoveryDecision(subagent.lastRecoveryDecision.action, subagent.lastRecoveryDecision.ruleId, subagent.lastRecoveryDecision.reason)}` : undefined,
        integration ? `integration: ${integration}` : undefined,
        note ? `note: ${note}` : undefined,
        "transcript:",
        ...transcript.lines,
    ].filter((line) => Boolean(line));
}
function enrichRunnerSummaryWithProcess(summary, runners, now) {
    if (runners.length === 0)
        return summary;
    const liveCount = runners.filter((runner) => runner.runnerAlive || runner.childAlive).length;
    const latestSeen = runners
        .map((runner) => readRunnerRecordModifiedAt(runner))
        .reduce((acc, at) => {
        if (!at)
            return acc;
        if (!acc || at.getTime() > acc.getTime())
            return at;
        return acc;
    }, undefined);
    const status = liveCount > 0
        ? `alive (${liveCount}/${runners.length})`
        : `not alive (${runners.length})`;
    const seen = latestSeen ? ` · seen ${formatAgo(latestSeen, now)}` : "";
    return {
        ...summary,
        processSeenLabel: `${status}${seen}`,
    };
}
function readRunnerRecordModifiedAt(record) {
    const candidates = [record.readyPath, record.configPath, record.commandPath, record.logPath, record.runnerDir];
    let latest;
    for (const file of candidates) {
        if (!file || !existsSync(file))
            continue;
        try {
            const stat = statSync(file);
            const candidate = stat.mtime;
            if (Number.isFinite(candidate.getTime()) && (!latest || candidate.getTime() > latest.getTime()))
                latest = candidate;
        }
        catch {
            // ignore
        }
    }
    return latest;
}
function renderRunnerStatus(subagent) {
    if (subagent.status === "running")
        return "running";
    if (subagent.status === "idle") {
        if (subagent.integrationState === "integrating")
            return "waiting for integration";
        return "idle";
    }
    if (subagent.status === "needsFollowup")
        return "needs follow-up";
    if (subagent.integrationState === "pending" && subagent.status !== "complete")
        return "waiting for integration";
    return subagent.status;
}
function formatPreparedResources(node) {
    const resources = node.preparedResources;
    if (!resources)
        return "-";
    return [
        resources.workspacePath ? `workspace=${shortenPath(resources.workspacePath)}` : undefined,
        resources.branch ? `branch=${resources.branch}` : undefined,
        resources.sessionId ? `session=${shortenMiddle(resources.sessionId, 32)}` : undefined,
        resources.modelArg ? `model=${shortenMiddle(resources.modelArg, 48)}` : undefined,
        resources.thinkingLevel ? `thinking=${resources.thinkingLevel}` : undefined,
    ].filter((part) => Boolean(part)).join(" ") || "-";
}
function formatObservation(kind, detail) {
    return detail ? `${kind} — ${shortenMiddle(detail.replace(/\s+/g, " ").trim(), 140)}` : kind;
}
function formatRecoveryDecision(action, ruleId, reason) {
    return `${action}${ruleId ? ` rule=${shortenMiddle(ruleId, 48)}` : ""} — ${shortenMiddle(reason.replace(/\s+/g, " ").trim(), 140)}`;
}
function formatSubagentIntegration(subagent) {
    if (!subagent.integrationState && !subagent.integrationCommitSha && !subagent.integrationSourceHead && !subagent.integrationError)
        return undefined;
    const parts = [
        subagent.integrationState ?? "unknown",
        subagent.integrationSourceHead ? `source=${shortSha(subagent.integrationSourceHead)}` : undefined,
        subagent.integrationCommitSha ? `controller=${shortSha(subagent.integrationCommitSha)}` : undefined,
        subagent.integrationError ? `error=${subagent.integrationError}` : undefined,
    ].filter((part) => Boolean(part));
    return parts.join(" ");
}
function shortSha(value) {
    return value.slice(0, 12);
}
function derivedMonitorStatus(goal, dag) {
    const nodeStatuses = dag.nodes.map((node) => node.status);
    if (goal.status === "active" && nodeStatuses.length > 0 && nodeStatuses.every((status) => ["failed", "blocked", "superseded"].includes(status))) {
        return "stalled";
    }
    return `${goal.status}/${goal.activityState ?? "-"}`;
}
function formatStatusCounts(statuses) {
    if (statuses.length === 0)
        return "0";
    const counts = new Map();
    for (const status of statuses)
        counts.set(status, (counts.get(status) ?? 0) + 1);
    return `${statuses.length} (${[...counts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([status, count]) => `${status}=${count}`).join(",")})`;
}
function formatMonitorTokens(goal) {
    return goal.tokenBudget === undefined ? formatCompactNumber(goal.tokensUsed) : `${formatCompactNumber(goal.tokensUsed)}/${formatCompactNumber(goal.tokenBudget)}`;
}
function formatNodeMonitorModel(node) {
    const scenario = node.preparedResources?.modelScenario ?? node.modelScenario;
    const model = node.preparedResources?.modelArg ?? node.modelArg;
    const thinkingLevel = node.preparedResources?.thinkingLevel ?? node.thinkingLevel;
    const rendered = formatMonitorModel(scenario, model, thinkingLevel);
    return rendered === "-" ? undefined : rendered;
}
function formatMonitorModel(scenario, model, thinkingLevel) {
    const parts = [scenario, model, thinkingLevel ? `[${thinkingLevel}]` : undefined].filter((p) => Boolean(p));
    return parts.join(" -> ") || "-";
}
function formatMonitorValidationContract(node) {
    const parts = [
        node.kind ? `kind=${node.kind}` : undefined,
        node.validation?.profile ? `profile=${node.validation.profile}` : undefined,
        node.validation?.requiredEvidence?.length ? `evidence=${node.validation.requiredEvidence.join(",")}` : undefined,
        node.validation?.artifactLocks?.length ? `locks=${node.validation.artifactLocks.length}` : undefined,
    ].filter((part) => Boolean(part));
    return parts.length ? shortenMiddle(parts.join(" "), 120) : "-";
}
function formatCompactNumber(value) {
    if (value < 1_000)
        return `${value}`;
    if (value < 1_000_000)
        return `${Number.isInteger(value / 1_000) ? value / 1_000 : (value / 1_000).toFixed(1)}k`;
    return `${Number.isInteger(value / 1_000_000) ? value / 1_000_000 : (value / 1_000_000).toFixed(1)}m`;
}
function formatElapsedSeconds(seconds) {
    if (seconds < 60)
        return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60)
        return `${minutes}m${seconds % 60 ? `${seconds % 60}s` : ""}`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h${minutes % 60 ? `${minutes % 60}m` : ""}`;
}
function shortenPath(value) {
    const home = process.env.HOME;
    const normalized = home && value.startsWith(`${home}/`) ? `~/${value.slice(home.length + 1)}` : value;
    return shortenMiddle(normalized, 98);
}
function shortenMiddle(value, maxLength) {
    if (value.length <= maxLength)
        return value;
    const keep = Math.max(1, maxLength - 1);
    const head = Math.ceil(keep * 0.6);
    const tail = Math.floor(keep * 0.4);
    return `${value.slice(0, head)}…${value.slice(value.length - tail)}`;
}
/**
 * Render the runtime summary as 2-3 compact lines for the Pi TUI header band.
 * Uses short labels and double-space separators to fit narrow terminals.
 */
/**
 * Render the structured overview header for the Pi TUI monitor.
 * Shows Goal title, Health, Problem, Progress, Runtime, and Next Action.
 * Adapts layout for narrow (≤80 cols) terminals.
 */
function renderOverviewHeader(overview, _runtimeSummary, width, isNarrow, theme) {
    const healthLabel = EXTENDED_MONITOR_HEALTH_LABELS[overview.health] ?? overview.health;
    const healthColor = overview.health === "OK" || overview.health === "Complete" ? "success" :
        overview.health === "Needs attention" || overview.health === "Complete with warnings" ? "warning" :
            overview.health === "Blocked" ? "error" :
                overview.health === "Running" ? "success" : "dim";
    const lines = [];
    // Goal title line.
    const titleLine = theme.bold
        ? theme.bold(`${overview.title} · ${overview.statusLabel}`)
        : `${overview.title} · ${overview.statusLabel}`;
    lines.push(truncateToWidth(theme.fg("accent", titleLine), width));
    if (isNarrow) {
        // Narrow layout: stack key fields vertically.
        lines.push(truncateToWidth(theme.fg(healthColor, `Health: ${healthLabel}`), width));
        if (overview.problemLabel !== "none") {
            lines.push(truncateToWidth(theme.fg("warning", `Problem: ${overview.problemLabel}`), width));
        }
        lines.push(truncateToWidth(theme.fg("dim", `Progress: ${overview.progressLabel}`), width));
        lines.push(truncateToWidth(theme.fg("dim", `Runtime: ${overview.runtimeLabel}`), width));
        lines.push(truncateToWidth(theme.fg("dim", `Workers: ${overview.workersLabel ?? "none"}`), width));
        lines.push(truncateToWidth(theme.fg("dim", `Next: ${overview.nextActionLabel}`), width));
    }
    else {
        // Wide layout: Health + Problem on one line, Progress on next, Runtime on next, Next on last.
        const problemPart = overview.problemLabel !== "none"
            ? `  Problem: ${overview.problemLabel}`
            : "";
        lines.push(truncateToWidth(`${theme.fg(healthColor, `Health: ${healthLabel}`)}${problemPart ? theme.fg("warning", problemPart) : ""}`, width));
        lines.push(truncateToWidth(theme.fg("dim", `Progress: ${overview.progressLabel}`), width));
        lines.push(truncateToWidth(theme.fg("dim", `Runtime: ${overview.runtimeLabel}`), width));
        lines.push(truncateToWidth(theme.fg("dim", `Workers: ${overview.workersLabel ?? "none"}`), width));
        lines.push(truncateToWidth(theme.fg("dim", `Next: ${overview.nextActionLabel}`), width));
    }
    return lines;
}
/**
 * Render the Execution Plan section with node display states.
 * Uses single-char icons for narrow terminals.
 */
function renderExecutionPlanSection(overview, dag, width, isNarrow, theme) {
    const lines = [];
    lines.push(truncateToWidth(theme.fg("borderMuted", "─".repeat(Math.max(0, width))), width));
    if (overview.nodeDisplayStates.length === 0) {
        lines.push(truncateToWidth(theme.fg("muted", "EXECUTION PLAN  (no DAG nodes yet)"), width));
        return lines;
    }
    lines.push(truncateToWidth(theme.fg("accent", "EXECUTION PLAN"), width));
    for (const nds of overview.nodeDisplayStates) {
        const stateChar = MONITOR_NODE_DISPLAY_STATE_CHARS[nds.displayState] ?? "?";
        const nodeColor = nds.displayState === "blocked" ? "error" :
            nds.displayState === "warning" ? "warning" :
                nds.displayState === "running" ? "success" :
                    nds.displayState === "complete" ? "success" : "dim";
        if (isNarrow) {
            lines.push(truncateToWidth(theme.fg(nodeColor, `${stateChar} ${nds.slug}`), width));
            continue;
        }
        const parts = parseExecutionPlanSummary(nds.summary);
        const row = renderAlignedColumns([
            `${stateChar}`,
            shortenMiddle(nds.slug, 30),
            parts.runtime,
            parts.phase,
            parts.last,
        ], [2, 30, 14, 28, 14]);
        lines.push(truncateToWidth(theme.fg(nodeColor, row), width));
    }
    return lines;
}
function parseExecutionPlanSummary(summary) {
    const parts = summary.split(" · ").filter(Boolean);
    return {
        runtime: parts[0] ?? "",
        phase: parts[1] ?? "",
        last: parts.slice(2).join(" · "),
    };
}
/** Truncate text for narrow terminals preserving key fields. */
function truncateNarrow(text, maxLen) {
    if (text.length <= maxLen)
        return text;
    // Try to keep node slug and status by removing less important fields.
    const parts = text.split(" · ");
    if (parts.length <= 1)
        return `${text.slice(0, maxLen - 3)}...`;
    // Keep first two parts (slug + status), drop extras.
    let result = parts.slice(0, 2).join(" · ");
    if (result.length > maxLen)
        result = `${result.slice(0, maxLen - 3)}...`;
    return result;
}
function formatRuntimeBandLines(summary, health, width, theme) {
    const sessionLabel = SESSION_STATE_LABELS[summary.session.state];
    const hiddenLabel = HIDDEN_CONTINUATION_STATE_LABELS[summary.hiddenContinuation.state];
    const pollLabel = CONTROLLER_POLL_STATE_LABELS[summary.controllerPoll.state];
    const sessionPart = `Session=${sessionLabel}`;
    const hiddenPart = `Hidden=${hiddenLabel}${summary.hiddenContinuation.reason ? `(${summary.hiddenContinuation.reason})` : ""}`;
    const pollPart = `Poll=${pollLabel}${summary.controllerPoll.reason ? `(${summary.controllerPoll.reason})` : ""}`;
    const runnersPart = `Runners=${formatRunnerSummary(summary.runners)}`;
    const fullLine = [sessionPart, hiddenPart, pollPart, runnersPart].join("  ");
    const healthColor = health.health === "OK" || health.health === "Complete" || health.health === "Running" ? "success" :
        health.health === "Needs attention" || health.health === "Complete with warnings" ? "warning" :
            health.health === "Blocked" ? "error" : "dim";
    const healthLine = `Health=${health.health}  Next: ${health.nextAction}`;
    // Narrow terminal: split key=value pairs across 2 lines so all four
    // states (Session, Hidden, Poll, Runners) remain visible at 80 columns.
    if (fullLine.length > width && width > 0) {
        const lineA = [sessionPart, hiddenPart].join("  ");
        const lineB = [pollPart, runnersPart].join("  ");
        return [
            truncateToWidth(theme.fg("dim", lineA), width),
            truncateToWidth(theme.fg("dim", lineB), width),
            truncateToWidth(theme.fg(healthColor, healthLine), width),
        ];
    }
    return [
        truncateToWidth(theme.fg("dim", fullLine), width),
        truncateToWidth(theme.fg(healthColor, healthLine), width),
    ];
}
function formatRunnerSummary(runners) {
    const parts = [];
    if (runners.running > 0)
        parts.push(`${runners.running} running`);
    if (runners.stopped > 0)
        parts.push(`${runners.stopped} stopped`);
    if (runners.duplicateStopped > 0)
        parts.push(`${runners.duplicateStopped} dup`);
    if (runners.archived > 0)
        parts.push(`${runners.archived} archived`);
    if (runners.failed > 0)
        parts.push(`${runners.failed} failed`);
    return parts.length > 0 ? parts.join(" ") : "none";
}
export function readGoalTranscriptLines(sessionFile) {
    return readGoalTranscript(sessionFile).lines;
}
export function readControllerTranscript(sessionFile) {
    const transcript = readGoalTranscript(sessionFile);
    if (!sessionFile) {
        return {
            ...transcript,
            diagnostic: "Controller transcript unavailable: this runtime-owned controller has no Pi session file; inspect DAG nodes and runner live panes for active work.",
        };
    }
    if (!existsSync(sessionFile)) {
        return {
            ...transcript,
            diagnostic: "Controller transcript unavailable: Pi did not create a JSONL file for this runtime-owned controller; inspect DAG nodes and runner live panes for active work.",
        };
    }
    return transcript;
}
export function readGoalTranscript(sessionFile) {
    if (!sessionFile)
        return { lines: [], diagnostic: "Goal metadata has no sessionFile; use openSession or recreate the goal with the current runtime.", entryCount: 0, messageCount: 0, tokenTotal: 0 };
    if (!existsSync(sessionFile))
        return { lines: [], diagnostic: `Session file not found: ${sessionFile}`, entryCount: 0, messageCount: 0, tokenTotal: 0 };
    const lines = [];
    let entryCount = 0;
    let messageCount = 0;
    let tokenTotal = 0;
    let modelArg;
    let thinkingLevel;
    for (const rawLine of readFileSync(sessionFile, "utf8").split("\n")) {
        if (!rawLine.trim())
            continue;
        try {
            const entry = JSON.parse(rawLine);
            entryCount += 1;
            const rendered = renderSessionEntry(entry);
            if (entry.type === "model_change") {
                const provider = typeof entry.provider === "string" ? entry.provider : undefined;
                const modelId = typeof entry.modelId === "string" ? entry.modelId : undefined;
                modelArg = provider && modelId ? `${provider}/${modelId}` : modelId ?? modelArg;
            }
            if (entry.type === "thinking_level_change" && typeof entry.thinkingLevel === "string")
                thinkingLevel = entry.thinkingLevel;
            if (entry.type === "message") {
                const message = entry.message;
                if (message?.role === "assistant")
                    tokenTotal += normalizeSessionAssistantUsage(message.usage);
            }
            if (rendered.length === 0)
                continue;
            if (entry.type === "message" || entry.type === "custom_message")
                messageCount += 1;
            lines.push(...rendered);
        }
        catch {
            lines.push("[malformed session entry]");
        }
    }
    return { lines, entryCount, messageCount, tokenTotal, modelArg, thinkingLevel };
}
function normalizeSessionAssistantUsage(usage) {
    if (!usage || typeof usage !== "object" || Array.isArray(usage))
        return 0;
    const record = usage;
    const input = tokenChannelValue(record.input ?? record.inputTokens);
    const output = tokenChannelValue(record.output ?? record.outputTokens);
    if (input !== undefined || output !== undefined)
        return (input ?? 0) + (output ?? 0);
    return tokenChannelValue(record.totalTokens ?? record.total) ?? 0;
}
function tokenChannelValue(value) {
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : undefined;
}
function renderSessionEntry(entry) {
    const timestamp = typeof entry.timestamp === "string" ? entry.timestamp : undefined;
    const prefix = timestamp ? `[${compactTimestamp(timestamp)}] ` : "";
    switch (entry.type) {
        case "session": {
            const cwd = typeof entry.cwd === "string" ? ` cwd=${entry.cwd}` : "";
            return [`${prefix}session start${cwd}`];
        }
        case "session_info": {
            const name = typeof entry.name === "string" ? entry.name : "(unnamed)";
            return [`${prefix}session name: ${name}`];
        }
        case "message": {
            const message = entry.message;
            if (!message)
                return [];
            const role = typeof message.role === "string" ? message.role : "message";
            const text = textFromMessage(message);
            const toolName = typeof message.toolName === "string" ? ` ${message.toolName}` : "";
            const stopReason = typeof message.stopReason === "string" ? ` stop=${message.stopReason}` : "";
            return splitDisplayText(`${prefix}${role}${toolName}${stopReason}: ${text || summarizeObject(message)}`);
        }
        case "custom_message": {
            const customType = typeof entry.customType === "string" ? entry.customType : "custom";
            const text = textFromContent(entry.content);
            return splitDisplayText(`${prefix}custom:${customType}: ${text}`);
        }
        case "compaction": {
            const summary = typeof entry.summary === "string" ? entry.summary : "";
            return splitDisplayText(`${prefix}compaction: ${summary}`);
        }
        case "branch_summary": {
            const summary = typeof entry.summary === "string" ? entry.summary : "";
            return splitDisplayText(`${prefix}branch summary: ${summary}`);
        }
        case "model_change": {
            return [`${prefix}model: ${String(entry.provider ?? "?")}/${String(entry.modelId ?? "?")}`];
        }
        case "thinking_level_change": {
            return [`${prefix}thinking: ${String(entry.thinkingLevel ?? "?")}`];
        }
        case "label": {
            return [`${prefix}label: ${String(entry.label ?? "(cleared)")}`];
        }
        default:
            return [];
    }
}
function textFromMessage(message) {
    const contentText = textFromContent(message.content);
    const fields = [];
    if (contentText)
        fields.push(contentText);
    const error = typeof message.errorMessage === "string" ? message.errorMessage : undefined;
    if (error)
        fields.push(`error=${error}`);
    const result = typeof message.result === "string" ? message.result : undefined;
    if (result)
        fields.push(result);
    return fields.join(" ").replace(/\s+/g, " ").trim();
}
function textFromContent(content) {
    if (typeof content === "string")
        return content.replace(/\s+/g, " ").trim();
    if (!Array.isArray(content))
        return "";
    return content
        .map((part) => {
        if (typeof part === "string")
            return part;
        if (!part || typeof part !== "object")
            return "";
        const record = part;
        if (typeof record.text === "string")
            return record.text;
        if (typeof record.thinking === "string")
            return `[thinking] ${record.thinking}`;
        if (record.type === "toolCall")
            return `[tool call] ${String(record.name ?? "unknown")} ${summarizeObject(record.arguments)}`;
        if (record.type === "image")
            return "[image]";
        return summarizeObject(record);
    })
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
}
function splitDisplayText(text) {
    return text.split("\n").map((line) => line.trim()).filter(Boolean);
}
function compactTimestamp(timestamp) {
    return timestamp.replace(/^\d{4}-/, "").replace(/\.\d{3}Z$/, "Z");
}
function summarizeObject(value) {
    if (value === undefined || value === null)
        return "";
    try {
        return JSON.stringify(value);
    }
    catch {
        return String(value);
    }
}
//# sourceMappingURL=monitor-ui.js.map