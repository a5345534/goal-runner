import test from "node:test";
import assert from "node:assert/strict";
import { parseOpencodeGoalCommand, stripSlashPrefix, formatOpencodeGoalToolDescription, OPENCODE_GOAL_TOOL, OPENCODE_GOAL_SLASH, } from "../adapters/opencode/index.js";
test("stripSlashPrefix removes leading /goal and trims", () => {
    assert.equal(stripSlashPrefix(""), "");
    assert.equal(stripSlashPrefix("/goal"), "");
    assert.equal(stripSlashPrefix("/goal  migrate to v2"), "migrate to v2");
    assert.equal(stripSlashPrefix("/Goal list"), "list");
    assert.equal(stripSlashPrefix("list"), "list");
});
test("parseOpencodeGoalCommand recognises subcommands", () => {
    const parsed = parseOpencodeGoalCommand("list");
    assert.equal(parsed.kind, "subcommand");
    assert.equal(parsed.subcommand, "list");
    assert.equal(parsed.remaining, "list");
});
test("parseOpencodeGoalCommand recognises subcommands with goal-ref", () => {
    const parsed = parseOpencodeGoalCommand("pause abc12345");
    assert.equal(parsed.kind, "subcommand");
    assert.equal(parsed.subcommand, "pause");
    assert.equal(parsed.remaining, "pause abc12345");
});
test("parseOpencodeGoalCommand parses start with workspace flags", () => {
    const parsed = parseOpencodeGoalCommand("--workspace ./repo --branch feat/x implement auth");
    assert.equal(parsed.kind, "start");
    assert.equal(parsed.workspace.workspace, "./repo");
    assert.equal(parsed.workspace.branch, "feat/x");
    assert.equal(parsed.remaining, "implement auth");
});
test("parseOpencodeGoalCommand treats bare /goal as show", () => {
    const parsed = parseOpencodeGoalCommand("");
    assert.equal(parsed.kind, "show");
});
test("parseOpencodeGoalCommand exposes the budget subcommand for /goal budget <amount>", () => {
    const parsed = parseOpencodeGoalCommand("budget 200k");
    assert.equal(parsed.kind, "budget");
    assert.equal(parsed.remaining, "budget 200k");
});
test("formatOpencodeGoalToolDescription includes the canonical examples", () => {
    const description = formatOpencodeGoalToolDescription();
    assert.match(description, /Run a \/goal command/);
    assert.match(description, /--workspace/);
    assert.match(description, /pause/);
    assert.match(description, /list/);
});
test("tool and slash identifiers are stable", () => {
    assert.equal(OPENCODE_GOAL_TOOL, "goal_command");
    assert.equal(OPENCODE_GOAL_SLASH, "goal");
});
//# sourceMappingURL=opencode-slash-command.test.js.map