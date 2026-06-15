import type { GoalDagNode, GoalRuntime, GoalSubagentRecord, GoalSummary } from "../../core/index.js";
export interface OpencodeMonitorSnapshot {
    lines: string[];
    refreshedAt: string;
}
export interface OpencodeMonitorRendererOptions {
    /** Truncate long free-form text to this width. */
    maxLineWidth?: number;
    /** Custom clock. */
    now?: () => Date;
}
export declare function readOpencodeGoalMonitorSnapshot(runtime: GoalRuntime, goal: GoalSummary, options?: OpencodeMonitorRendererOptions): Promise<OpencodeMonitorSnapshot>;
export declare function renderOpencodeMonitorLines(goal: GoalSummary, state: {
    nodes: GoalDagNode[];
    subagents: GoalSubagentRecord[];
}, options?: OpencodeMonitorRendererOptions): string[];
