/**
 * Shared monitor overview view model — pure functions that derive a
 * structured `GoalMonitorOverview` from existing goal, DAG, and
 * runtime-summary data.  Both the Pi TUI and OpenCode monitor adapters
 * import from here so health taxonomy, problem summarisation, runtime
 * labels, and event filtering stay consistent.
 */
import type { GoalDagNode, GoalLedgerEvent, GoalSubagentRecord, GoalSummary } from "../core/index.js";
import type { GoalMonitorRuntimeSummary, MonitorHealth } from "./pi/monitor-ui.js";
export type { GoalMonitorRuntimeSummary, MonitorHealth, } from "./pi/monitor-ui.js";
export type ExtendedMonitorHealth = MonitorHealth | "Complete" | "Complete with warnings" | "Running";
export declare const EXTENDED_MONITOR_HEALTH_LABELS: Record<ExtendedMonitorHealth, string>;
export type MonitorNodeDisplayState = "running" | "idle" | "blocked" | "warning" | "complete" | "ok";
export declare const MONITOR_NODE_DISPLAY_STATE_LABELS: Record<MonitorNodeDisplayState, string>;
/** Compact single-char display state for narrow terminals. */
export declare const MONITOR_NODE_DISPLAY_STATE_CHARS: Record<MonitorNodeDisplayState, string>;
export interface GoalMonitorOverview {
    title: string;
    statusLabel: string;
    health: ExtendedMonitorHealth;
    problemLabel: string;
    progressLabel: string;
    runtimeLabel: string;
    workersLabel: string;
    nextActionLabel: string;
    selectedDetail: string;
    selectedNodeDetailLines?: string[];
    recentEvents: string[];
    nodeDisplayStates: Array<{
        nodeId: string;
        slug: string;
        displayState: MonitorNodeDisplayState;
        summary: string;
        duration: MonitorDurationSummary;
        qualityProfile?: string;
        gatesPassed: number;
        gatesFailed: number;
    }>;
    qualityProfileSummary?: {
        nodesWithProfile: number;
        totalGates: number;
        gatesPassed: number;
        gatesFailed: number;
        totalEvidenceEvaluations: number;
        evidencePassed: number;
        evidenceFailed: number;
    };
}
export declare const ACTION_DISPLAY_LABELS: Record<string, string>;
export interface BuildGoalMonitorOverviewOptions {
    maxRecentEvents?: number;
    minRecentEvents?: number;
    now?: Date;
}
/**
 * Derive a `GoalMonitorOverview` synchronously from existing goal, DAG,
 * subagents, runtime summary, and ledger events.
 */
export declare function buildGoalMonitorOverview(goal: GoalSummary, dag: {
    nodes: GoalDagNode[];
    subagents: GoalSubagentRecord[];
    ledgerEvents?: GoalLedgerEvent[];
}, runtimeSummary: GoalMonitorRuntimeSummary, options?: BuildGoalMonitorOverviewOptions): GoalMonitorOverview;
/**
 * Derive a monitor health status from the runtime summary, goal, subagents
 * and DAG state.  The new taxonomy gives priority to goal terminal states
 * first, then node/subagent status, then runtime activity.
 */
export declare function deriveMonitorHealth(summary: GoalMonitorRuntimeSummary, goal: GoalSummary, subagents: GoalSubagentRecord[], nodes?: GoalDagNode[]): ExtendedMonitorHealth;
/**
 * Summarise the current problem into a node-centric short phrase.
 * Never includes full subagent IDs longer than ~48 chars in the overview.
 */
export declare function summarizeMonitorProblem(goal: GoalSummary, nodes: GoalDagNode[], subagents: GoalSubagentRecord[]): string;
/**
 * Map internal runtime summary state enums to user-facing labels.
 */
export declare function formatRuntimeSummaryForOverview(summary: GoalMonitorRuntimeSummary): string;
/**
 * Derive a display state for a DAG node based on its own status and
 * the status of its associated subagents.
 */
export declare function formatNodeDisplayState(node: GoalDagNode, subagents: GoalSubagentRecord[]): MonitorNodeDisplayState;
/**
 * Filter ledger events to 3-8 meaningful events for the overview display.
 * Full history is available in debug/live mode.
 */
export declare function formatRecentEvents(ledgerEvents: GoalLedgerEvent[], options?: {
    maxRecentEvents?: number;
    minRecentEvents?: number;
}): string[];
export type StaleLevel = "fresh" | "quiet" | "stale" | "dead" | "unknown";
export type DurationConfidence = "exact" | "ledger-derived" | "fallback";
export interface MonitorDurationSummary {
    totalLabel: string;
    phaseLabel?: string;
    statusLabel?: string;
    lastLabel: string;
    staleLevel: StaleLevel;
    confidence: DurationConfidence;
}
export interface GoalDurationSummary {
    goalAgeLabel: string;
    activeWorkLabel?: string;
    lastEventLabel: string;
    confidence: DurationConfidence;
}
export interface RunnerDurationSummary {
    attemptRuntimeLabel: string;
    statusAgeLabel?: string;
    integrationAgeLabel?: string;
    processSeenLabel?: string;
    lastActivityLabel: string;
    staleLevel: StaleLevel;
    confidence: DurationConfidence;
}
export declare function formatDuration(ms: number): string;
export declare function formatAgo(date: Date, now: Date): string;
export declare function classifyStaleness(lastAt: Date, now: Date): StaleLevel;
export declare function buildGoalDurationSummary(goal: {
    createdAt: string;
    timeUsedSeconds: number;
    updatedAt: string;
}, ledgerEvents: GoalLedgerEvent[], now: Date): GoalDurationSummary;
export declare function buildNodeDurationSummary(node: GoalDagNode, relatedSubagents: GoalSubagentRecord[], ledgerEvents: GoalLedgerEvent[], now: Date): MonitorDurationSummary;
export declare function buildRunnerDurationSummary(subagent: GoalSubagentRecord, events: GoalLedgerEvent[], now: Date): RunnerDurationSummary;
