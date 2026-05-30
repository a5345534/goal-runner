import test from "node:test";
import assert from "node:assert/strict";
import { parseGoalCommand, parseTokenBudget, validateGoalObjective, MAX_GOAL_OBJECTIVE_CHARS } from "../core/index.js";
test("parse /goal forms", () => {
    assert.deepEqual(parseGoalCommand(""), { kind: "show" });
    assert.deepEqual(parseGoalCommand("pause"), { kind: "pause" });
    assert.deepEqual(parseGoalCommand("resume"), { kind: "resume" });
    assert.deepEqual(parseGoalCommand("clear"), { kind: "clear" });
    assert.deepEqual(parseGoalCommand("edit"), { kind: "edit" });
    assert.deepEqual(parseGoalCommand("edit ship it"), { kind: "edit", objective: "ship it", tokenBudget: undefined });
    assert.deepEqual(parseGoalCommand(" finish migration "), { kind: "start", objective: "finish migration", tokenBudget: undefined });
    assert.deepEqual(parseGoalCommand("--tokens 100k finish migration"), { kind: "start", objective: "finish migration", tokenBudget: 100_000 });
    assert.deepEqual(parseGoalCommand("edit --tokens 1.5m ship it"), { kind: "edit", objective: "ship it", tokenBudget: 1_500_000 });
});
test("parse token budgets", () => {
    assert.equal(parseTokenBudget("42"), 42);
    assert.equal(parseTokenBudget("100k"), 100_000);
    assert.equal(parseTokenBudget("1.5m"), 1_500_000);
    assert.throws(() => parseTokenBudget("0"), /invalid token budget/);
    assert.throws(() => parseTokenBudget("nope"), /invalid token budget/);
    assert.throws(() => parseGoalCommand("--tokens"), /missing token budget/);
    assert.throws(() => parseGoalCommand("pause now"), /extra arguments/);
});
test("objective validation trims and enforces 4000 chars", () => {
    assert.equal(validateGoalObjective("  hello  "), "hello");
    assert.throws(() => validateGoalObjective("   "), /must not be empty/);
    assert.equal(validateGoalObjective("x".repeat(MAX_GOAL_OBJECTIVE_CHARS)).length, MAX_GOAL_OBJECTIVE_CHARS);
    assert.throws(() => validateGoalObjective("x".repeat(MAX_GOAL_OBJECTIVE_CHARS + 1)), /at most/);
});
//# sourceMappingURL=parser.test.js.map