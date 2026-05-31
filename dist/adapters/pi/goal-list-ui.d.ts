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
