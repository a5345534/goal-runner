import type { GoalDagNode, GoalSubagentRecord, GoalSummary } from "../../core/index.js";
import type { PiBackgroundRunnerRecord } from "./runner-ops.js";
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
}
export interface GoalMonitorDagSnapshot {
    nodes: GoalDagNode[];
    subagents: GoalSubagentRecord[];
    runners?: PiBackgroundRunnerRecord[];
    refreshedAt?: string;
}
export declare class GoalMonitorController {
    private readonly goal;
    private readonly readTranscript;
    private readonly readDagSnapshot;
    private readonly now;
    private activePane;
    private scope;
    private listIndex;
    private listScroll;
    private liveScroll;
    private followLiveTail;
    private rowOperationIndex;
    private lastLiveLineCount;
    private lastListLineCount;
    private lastListItems;
    private lastSelectedOperations;
    constructor(goal: GoalSummary, readTranscript?: () => GoalTranscriptSnapshot, readDagSnapshot?: () => GoalMonitorDagSnapshot, now?: () => Date);
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
    private buildView;
}
export declare function readGoalTranscriptLines(sessionFile: string | undefined): string[];
export declare function readGoalTranscript(sessionFile: string | undefined): GoalTranscriptSnapshot;
