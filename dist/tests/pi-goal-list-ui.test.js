import test from "node:test";
import assert from "node:assert/strict";
import { GoalListController, filterGoals, sortGoals } from "../adapters/pi/goal-list-ui.js";
function summary(id, status, tokensUsed, timeUsedSeconds, lastActivityAt) {
    return {
        sessionKey: `s-${id}`,
        goalId: id,
        shortGoalId: id.slice(0, 8),
        objective: `objective ${id}`,
        objectiveSummary: `objective ${id}`,
        status,
        activityState: status === "active" ? "idle-eligible" : status,
        tokensUsed,
        timeUsedSeconds,
        createdAt: lastActivityAt,
        updatedAt: lastActivityAt,
        lastActivityAt,
    };
}
test("goal list controller supports tab and sort keyboard operations", () => {
    const active = summary("active111", "active", 10, 5, "2026-05-31T00:00:00.000Z");
    const paused = summary("paused111", "paused", 99, 10, "2026-05-31T00:01:00.000Z");
    const controller = new GoalListController([paused, active]);
    assert.equal(controller.tab, "all");
    assert.equal(controller.visibleGoals[0]?.goalId, "paused111");
    controller.handleInput("\x1b[C"); // right
    assert.equal(controller.tab, "active");
    assert.deepEqual(controller.visibleGoals.map((goal) => goal.goalId), ["active111"]);
    controller.handleInput("\t");
    assert.equal(controller.sort, "status");
});
test("goal list controller enter selects and escape closes without mutation", () => {
    const controller = new GoalListController([summary("goal1111", "active", 1, 1, "2026-05-31T00:00:00.000Z")]);
    assert.deepEqual(controller.handleInput("\r"), { kind: "select", goal: controller.visibleGoals[0] });
    assert.deepEqual(controller.handleInput("\x1b"), { kind: "close" });
});
test("goal list filters and sort cycles use operational metadata", () => {
    const goals = [
        summary("complete", "complete", 1, 30, "2026-05-31T00:00:00.000Z"),
        summary("blocked1", "blocked", 2, 20, "2026-05-31T00:01:00.000Z"),
        summary("active11", "active", 3, 10, "2026-05-31T00:02:00.000Z"),
    ];
    assert.deepEqual(filterGoals(goals, "attention").map((goal) => goal.goalId), ["blocked1"]);
    assert.deepEqual(sortGoals(goals, "status").map((goal) => goal.goalId), ["active11", "blocked1", "complete"]);
    assert.deepEqual(sortGoals(goals, "runtime").map((goal) => goal.goalId), ["complete", "blocked1", "active11"]);
    assert.deepEqual(sortGoals(goals, "tokens").map((goal) => goal.goalId), ["active11", "blocked1", "complete"]);
});
//# sourceMappingURL=pi-goal-list-ui.test.js.map