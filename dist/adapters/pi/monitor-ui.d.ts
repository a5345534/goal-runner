import type { ContinuationReservation, GoalDagNode, GoalLedgerEvent, GoalSubagentRecord, GoalSummary, HarnessState } from "../../core/index.js";
import { type PiBackgroundRunnerRecord } from "./runner-ops.js";
import type { GoalListThemeLike } from "./goal-list-ui.js";
export type GoalMonitorAction = "close" | "pause" | "resume" | "clear" | "openSession";
export type GoalMonitorRunnerOperation = "openSession" | "stop" | "kill" | "archive";
export type GoalMonitorSelection = {
    kind: "action";
    action: GoalMonitorAction;
} | {
    kind: "runnerOperation";
    operation: GoalMonitorRunnerOperation;
    subagentId: string;
} | {
    kind: "close";
};
export interface GoalTranscriptSnapshot {
    lines: string[];
    diagnostic?: string;
    entryCount: number;
    messageCount: number;
    tokenTotal?: number;
    modelArg?: string;
    thinkingLevel?: string;
}
export interface GoalMonitorDagSnapshot {
    nodes: GoalDagNode[];
    subagents: GoalSubagentRecord[];
    runners?: PiBackgroundRunnerRecord[];
    ledgerEvents?: GoalLedgerEvent[];
    harnessState?: HarnessState;
    reservation?: ContinuationReservation;
    refreshedAt?: string;
}
export type MonitorSessionState = "active-turn" | "idle" | "missing" | "not-materialized" | "unknown";
export type MonitorHiddenContinuationState = "eligible" | "suppressed" | "reserved" | "started" | "not-configured" | "not-eligible" | "unknown";
export type MonitorControllerPollState = "active" | "leased" | "skipped" | "stopped" | "unknown";
export interface GoalMonitorRuntimeSummary {
    session: {
        state: MonitorSessionState;
        activeTurnId?: string;
    };
    hiddenContinuation: {
        state: MonitorHiddenContinuationState;
        reason?: string;
        attemptId?: string;
    };
    controllerPoll: {
        state: MonitorControllerPollState;
        reason?: string;
        leaseOwner?: string;
        lastPollAt?: string;
    };
    runners: {
        running: number;
        stopped: number;
        duplicateStopped: number;
        archived: number;
        failed: number;
    };
}
export type MonitorHealth = "OK" | "Needs attention" | "Waiting" | "Stalled" | "Blocked" | "Running" | "Complete" | "Complete with warnings";
export declare const SESSION_STATE_LABELS: Record<MonitorSessionState, string>;
export declare const HIDDEN_CONTINUATION_STATE_LABELS: Record<MonitorHiddenContinuationState, string>;
export declare const CONTROLLER_POLL_STATE_LABELS: Record<MonitorControllerPollState, string>;
/** Options passed to `buildGoalMonitorRuntimeSummary`. */
export interface BuildRuntimeSummaryOptions {
    harnessState?: HarnessState;
    reservation?: ContinuationReservation;
    ledgerEvents?: GoalLedgerEvent[];
    runners?: PiBackgroundRunnerRecord[];
    controllerPollGraceMs?: number;
}
/**
 * Derive a `GoalMonitorRuntimeSummary` synchronously from existing runtime
 * and adapter state. No async calls — uses only already-loaded data.
 */
export declare function buildGoalMonitorRuntimeSummary(goal: GoalSummary, subagents: GoalSubagentRecord[], options?: BuildRuntimeSummaryOptions): GoalMonitorRuntimeSummary;
/**
 * Derive a monitor health status from the runtime summary and DAG state.
 * Returns { health, nextAction } where nextAction is a one-line recommendation.
 *
 * @deprecated This is a compatibility wrapper. New code should use
 * deriveMonitorHealth from monitor-overview.ts (ExtendedMonitorHealth).
 */
export declare function deriveMonitorHealth(summary: GoalMonitorRuntimeSummary, goal: GoalSummary, subagents: GoalSubagentRecord[], nodes?: GoalDagNode[]): {
    health: MonitorHealth;
    nextAction: string;
};
export declare class GoalMonitorController {
    private goal;
    private readonly readTranscript;
    private readonly readDagSnapshot;
    private readonly now;
    private activePane;
    private scope;
    private listIndex;
    private listScroll;
    private liveScroll;
    private followLiveTail;
    private controllerHistoryMode;
    private rowOperationIndex;
    private lastLiveLineCount;
    private lastListLineCount;
    private lastListItems;
    private lastSelectedOperations;
    constructor(goal: GoalSummary, readTranscript?: () => GoalTranscriptSnapshot, readDagSnapshot?: () => GoalMonitorDagSnapshot, now?: () => Date);
    updateGoal(goal: GoalSummary): void;
    get actions(): GoalMonitorAction[];
    handleInput(data: string): GoalMonitorSelection | undefined;
    private activePageSize;
    private moveActivePane;
    private moveActivePaneToTop;
    private moveActivePaneToEnd;
    private moveListSelection;
    private keepSelectedListRowVisible;
    private moveRowOperation;
    private confirmSelectedOperation;
    private enterNodeList;
    private enterRunnerList;
    private goBack;
    private resetListAndLive;
    render(width: number, theme: GoalListThemeLike): string[];
    private formatMonitorKeysHelp;
    private buildView;
}
export declare function readGoalTranscriptLines(sessionFile: string | undefined): string[];
export declare function readControllerTranscript(sessionFile: string | undefined): GoalTranscriptSnapshot;
export declare function readGoalTranscript(sessionFile: string | undefined): GoalTranscriptSnapshot;
