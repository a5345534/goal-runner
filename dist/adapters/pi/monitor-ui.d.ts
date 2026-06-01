import type { GoalSummary } from "../../core/index.js";
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
export declare class GoalMonitorController {
    private readonly goal;
    private readonly readTranscript;
    private buttonIndex;
    private scroll;
    private followTail;
    constructor(goal: GoalSummary, readTranscript?: () => GoalTranscriptSnapshot);
    get actions(): GoalMonitorAction[];
    handleInput(data: string): GoalMonitorSelection | undefined;
    render(width: number, theme: GoalListThemeLike): string[];
}
export declare function readGoalTranscriptLines(sessionFile: string | undefined): string[];
export declare function readGoalTranscript(sessionFile: string | undefined): GoalTranscriptSnapshot;
