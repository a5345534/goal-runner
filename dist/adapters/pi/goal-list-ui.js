import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
const TABS = ["all", "active", "attention", "terminal"];
const SORTS = ["recent", "status", "runtime", "tokens"];
export class GoalListController {
    goals;
    selected = 0;
    tabIndex = 0;
    sortIndex = 0;
    constructor(goals) {
        this.goals = goals;
    }
    get tab() {
        return TABS[this.tabIndex] ?? "all";
    }
    get sort() {
        return SORTS[this.sortIndex] ?? "recent";
    }
    get visibleGoals() {
        return sortGoals(filterGoals(this.goals, this.tab), this.sort);
    }
    handleInput(data) {
        if (matchesKey(data, Key.escape))
            return { kind: "close" };
        if (matchesKey(data, Key.enter))
            return { kind: "select", goal: this.visibleGoals[this.selected] };
        if (matchesKey(data, Key.up)) {
            this.selected = Math.max(0, this.selected - 1);
            return undefined;
        }
        if (matchesKey(data, Key.down)) {
            this.selected = Math.min(Math.max(0, this.visibleGoals.length - 1), this.selected + 1);
            return undefined;
        }
        if (matchesKey(data, Key.left)) {
            this.tabIndex = (this.tabIndex + TABS.length - 1) % TABS.length;
            this.selected = 0;
            return undefined;
        }
        if (matchesKey(data, Key.right)) {
            this.tabIndex = (this.tabIndex + 1) % TABS.length;
            this.selected = 0;
            return undefined;
        }
        if (matchesKey(data, Key.tab)) {
            this.sortIndex = (this.sortIndex + 1) % SORTS.length;
            this.selected = 0;
            return undefined;
        }
        return undefined;
    }
    render(width, theme) {
        const title = theme.bold ? theme.bold("/goal list") : "/goal list";
        const tabs = TABS.map((tab) => (tab === this.tab ? theme.fg("accent", `[${tab}]`) : theme.fg("dim", ` ${tab} `))).join(" ");
        const lines = [
            truncateToWidth(`${theme.fg("accent", title)}  ${tabs}  sort=${theme.fg("accent", this.sort)}`, width),
            truncateToWidth(theme.fg("dim", "↑↓ select • ←→ tab/page • Tab sort • Enter monitor • Esc close"), width),
            truncateToWidth(theme.fg("borderMuted", "─".repeat(Math.max(0, width))), width),
        ];
        const visible = this.visibleGoals;
        if (visible.length === 0) {
            lines.push(truncateToWidth(theme.fg("muted", "No goals in this view"), width));
            return lines;
        }
        visible.forEach((goal, index) => {
            const selected = index === this.selected;
            const marker = selected ? theme.fg("accent", "▶") : " ";
            const status = selected ? theme.fg("accent", goal.status) : goal.status;
            const branch = goal.branch ?? goal.ref ?? "-";
            const workspace = goal.executionWorkspace ?? "legacy";
            const tokens = goal.tokenBudget === undefined ? String(goal.tokensUsed) : `${goal.tokensUsed}/${goal.tokenBudget}`;
            lines.push(truncateToWidth(`${marker} ${goal.shortGoalId} ${status}/${goal.activityState ?? "-"} ${goal.timeUsedSeconds}s ${tokens} ${goal.workspaceStatus ?? "?"} ${branch} ${workspace} — ${goal.objectiveSummary}`, width));
        });
        return lines;
    }
}
export function filterGoals(goals, tab) {
    switch (tab) {
        case "active":
            return goals.filter((goal) => goal.status === "active");
        case "attention":
            return goals.filter((goal) => ["paused", "blocked", "budgetLimited", "usageLimited"].includes(goal.status));
        case "terminal":
            return goals.filter((goal) => goal.status === "complete");
        case "all":
        default:
            return [...goals];
    }
}
export function sortGoals(goals, sort) {
    const sorted = [...goals];
    switch (sort) {
        case "status":
            return sorted.sort((a, b) => statusPriority(a.status) - statusPriority(b.status) || b.lastActivityAt.localeCompare(a.lastActivityAt));
        case "runtime":
            return sorted.sort((a, b) => b.timeUsedSeconds - a.timeUsedSeconds || b.lastActivityAt.localeCompare(a.lastActivityAt));
        case "tokens":
            return sorted.sort((a, b) => b.tokensUsed - a.tokensUsed || b.lastActivityAt.localeCompare(a.lastActivityAt));
        case "recent":
        default:
            return sorted.sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
    }
}
function statusPriority(status) {
    switch (status) {
        case "active":
            return 0;
        case "paused":
        case "blocked":
        case "budgetLimited":
        case "usageLimited":
            return 1;
        case "complete":
            return 2;
        default:
            return 3;
    }
}
//# sourceMappingURL=goal-list-ui.js.map