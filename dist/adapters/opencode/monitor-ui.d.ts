import type { ContinuationReservation, GoalDagNode, GoalLedgerEvent, GoalRuntime, GoalSubagentRecord, GoalSummary, HarnessState } from "../../core/index.js";
export interface OpencodeMonitorSnapshot {
    lines: string[];
    refreshedAt: string;
}
export interface OpencodeMonitorRendererOptions {
    /** Truncate long free-form text to this width. */
    maxLineWidth?: number;
    /** Custom clock. */
    now?: () => Date;
    /** Ledger events for audit summary extraction. */
    ledgerEvents?: GoalLedgerEvent[];
    /** Optional harness state for precise session/hidden-continuation display. */
    harnessState?: HarnessState;
    /** Optional continuation reservation for hidden-continuation state. */
    reservation?: ContinuationReservation;
}
export declare function readOpencodeGoalMonitorSnapshot(runtime: GoalRuntime, goal: GoalSummary, options?: OpencodeMonitorRendererOptions): Promise<OpencodeMonitorSnapshot>;
export declare function renderOpencodeMonitorLines(goal: GoalSummary, state: {
    nodes: GoalDagNode[];
    subagents: GoalSubagentRecord[];
}, options?: OpencodeMonitorRendererOptions): string[];
