import type { GoalSummary } from "../../core/index.js";
export type GoalListTab = "all" | "active" | "attention" | "terminal";
export type GoalListSort = "recent" | "status" | "runtime" | "tokens";
export interface GoalListSelection {
    kind: "select" | "close";
    goal?: GoalSummary;
}
export interface GoalListThemeLike {
    fg(color: string, text: string): string;
    bold?(text: string): string;
}
/** Collapse duplicate status/activity labels into a compact state label. */
export declare function formatGoalListState(goal: GoalSummary): string;
/** Return a compact metric string, omitting all-zero runtime/token pairs. */
export declare function formatGoalListMetrics(goal: GoalSummary): string;
/** Return a compact workspace/branch location label. */
export declare function formatGoalListWhere(goal: GoalSummary): string;
/** Shorten common objective boilerplate to preserve the meaningful change phrase. */
export declare function formatGoalListSummary(goal: GoalSummary): string;
/** Build a compact primary row and apply final display-width truncation. */
export declare function formatGoalListRow(goal: GoalSummary, marker: string, state: string, width: number): string;
export declare class GoalListController {
    private readonly goals;
    private selected;
    private tabIndex;
    private sortIndex;
    constructor(goals: GoalSummary[]);
    get tab(): GoalListTab;
    get sort(): GoalListSort;
    get visibleGoals(): GoalSummary[];
    handleInput(data: string): GoalListSelection | undefined;
    render(width: number, theme: GoalListThemeLike): string[];
}
export declare function filterGoals(goals: GoalSummary[], tab: GoalListTab): GoalSummary[];
export declare function sortGoals(goals: GoalSummary[], sort: GoalListSort): GoalSummary[];
