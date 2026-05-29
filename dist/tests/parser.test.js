import test from "node:test";
import assert from "node:assert/strict";
import { parseGoalCommand, validateGoalObjective, MAX_GOAL_OBJECTIVE_CHARS } from "../core/index.js";
test("parse /goal forms", () => {
    assert.deepEqual(parseGoalCommand(""), { kind: "show" });
    assert.deepEqual(parseGoalCommand("pause"), { kind: "pause" });
    assert.deepEqual(parseGoalCommand("resume"), { kind: "resume" });
    assert.deepEqual(parseGoalCommand("clear"), { kind: "clear" });
    assert.deepEqual(parseGoalCommand("edit"), { kind: "edit" });
    assert.deepEqual(parseGoalCommand(" finish migration "), { kind: "start", objective: "finish migration" });
});
test("objective validation trims and enforces 4000 chars", () => {
    assert.equal(validateGoalObjective("  hello  "), "hello");
    assert.throws(() => validateGoalObjective("   "), /must not be empty/);
    assert.equal(validateGoalObjective("x".repeat(MAX_GOAL_OBJECTIVE_CHARS)).length, MAX_GOAL_OBJECTIVE_CHARS);
    assert.throws(() => validateGoalObjective("x".repeat(MAX_GOAL_OBJECTIVE_CHARS + 1)), /at most/);
});
//# sourceMappingURL=parser.test.js.map