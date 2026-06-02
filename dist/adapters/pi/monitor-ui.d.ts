import type { GoalDagNode, GoalSubagentRecord, GoalSummary } from "../../core/index.js";
import type { GoalListThemeLike } from "./goal-list-ui.js";
export type GoalMonitorAction = "close" | "pause" | "resume" | "clear" | "openSession";
export interface GoalMonitorSelection {
    kind: "action" | "close";
    action?: GoalMonitorAction;
}
export interface GoalTranscriptSnapshot {
    lines: string[];
    diagnostic?: string;
    entryCount: number;
    messageCount: number;
}
export interface GoalMonitorDagSnapshot {
    nodes: GoalDagNode[];
    subagents: GoalSubagentRecord[];
    refreshedAt?: string;
}
export declare class GoalMonitorController {
    private readonly goal;
    private readonly readTranscript;
    private readonly readDagSnapshot;
    private readonly now;
    private buttonIndex;
    private scroll;
    private followTail;
    constructor(goal: GoalSummary, readTranscript?: () => GoalTranscriptSnapshot, readDagSnapshot?: () => GoalMonitorDagSnapshot, now?: () => Date);
    get actions(): GoalMonitorAction[];
    handleInput(data: string): GoalMonitorSelection | undefined;
    render(width: number, theme: GoalListThemeLike): string[];
}
export declare function readGoalTranscriptLines(sessionFile: string | undefined): string[];
export declare function readGoalTranscript(sessionFile: string | undefined): GoalTranscriptSnapshot;
