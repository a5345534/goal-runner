import { GOAL_STATUSES } from "./types.js";
const STATUS_ALIASES = {
    active: "active",
    paused: "paused",
    blocked: "blocked",
    usageLimited: "usageLimited",
    usage_limited: "usageLimited",
    budgetLimited: "budgetLimited",
    budget_limited: "budgetLimited",
    complete: "complete",
};
export function normalizeGoalStatus(value) {
    const status = STATUS_ALIASES[value];
    if (!status) {
        throw new Error(`unknown goal status: ${value}`);
    }
    return status;
}
export function isGoalStatus(value) {
    return GOAL_STATUSES.includes(value);
}
export function isAutoContinuableStatus(status) {
    return status === "active";
}
export function isStoppedStatus(status) {
    return status === "paused" || status === "blocked" || status === "usageLimited" || status === "budgetLimited" || status === "complete";
}
export function toCodexWireStatus(status) {
    return status;
}
export function fromCodexWireStatus(status) {
    return normalizeGoalStatus(status);
}
//# sourceMappingURL=status.js.map