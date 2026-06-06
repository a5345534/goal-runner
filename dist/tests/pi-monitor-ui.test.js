import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GoalMonitorController, readGoalTranscript, readGoalTranscriptLines } from "../adapters/pi/monitor-ui.js";
function summary(status = "active", sessionFile) {
    return {
        sessionKey: "s1",
        goalId: "abcdef123456",
        shortGoalId: "abcdef12",
        objective: "monitor goal",
        objectiveSummary: "monitor goal",
        status,
        activityState: status === "active" ? "idle-eligible" : status,
        tokensUsed: 1,
        timeUsedSeconds: 2,
        createdAt: "2026-05-31T00:00:00.000Z",
        updatedAt: "2026-05-31T00:00:00.000Z",
        lastActivityAt: "2026-05-31T00:00:00.000Z",
        executionWorkspace: "/workspace",
        workspaceStatus: "configured",
        branch: "feat/a",
        branchVerificationStatus: "verified",
        sessionFile,
        controllerModelScenario: "controller",
        controllerModelArg: "openai-codex/gpt-5.5",
    };
}
function dagNode(overrides = {}) {
    return {
        goalId: "abcdef123456",
        nodeId: "build-node",
        slug: "build-node",
        objective: "Build node",
        dependencyNodeIds: [],
        expectedOutputs: [],
        validators: [],
        completionGates: ["controller-validation"],
        status: "running",
        createdAt: "2026-05-31T00:00:00.000Z",
        updatedAt: "2026-05-31T00:04:00.000Z",
        ...overrides,
    };
}
function subagent(overrides = {}) {
    return {
        goalId: "abcdef123456",
        nodeId: "build-node",
        subagentId: "subagent-build-node-1",
        harnessAdapterId: "pi",
        status: "running",
        prompts: ["initial"],
        createdAt: "2026-05-31T00:01:00.000Z",
        updatedAt: "2026-05-31T00:04:30.000Z",
        lastActivityAt: "2026-05-31T00:04:30.000Z",
        ...overrides,
    };
}
const theme = { fg: (_color, text) => text, bold: (text) => text };
test("goal monitor escape closes without lifecycle action", () => {
    const controller = new GoalMonitorController(summary());
    assert.deepEqual(controller.handleInput("\x1b"), { kind: "close" });
});
test("goal monitor exposes lifecycle actions as controller row operations", () => {
    const active = new GoalMonitorController(summary("active"), () => ({ lines: ["tail"], entryCount: 1, messageCount: 1 }), () => ({ nodes: [dagNode()], subagents: [], refreshedAt: "2026-05-31T00:05:00.000Z" }));
    const paused = new GoalMonitorController(summary("paused"));
    assert.deepEqual(active.actions, ["pause", "resume", "clear", "close"]);
    assert.deepEqual(paused.actions, ["resume", "clear", "close"]);
    const rendered = active.render(140, theme).join("\n");
    assert.match(rendered, /scope=controller focus=list rowOp=nodeList/);
    assert.match(rendered, /> \[controller\].*ops: \[nodeList\].*pause.*resume.*clear.*close/);
    active.handleInput("\x1b[C"); // select pause operation on the controller row.
    assert.deepEqual(active.handleInput("\r"), { kind: "action", action: "pause" });
});
test("goal monitor row operations remain confirmable from live focus", () => {
    const controller = new GoalMonitorController(summary("active"), () => ({ lines: ["tail"], entryCount: 1, messageCount: 1 }), () => ({ nodes: [dagNode()], subagents: [], refreshedAt: "2026-05-31T00:05:00.000Z" }));
    controller.render(120, theme);
    controller.handleInput("\x1b[C"); // pause
    controller.handleInput("v");
    assert.deepEqual(controller.handleInput("\r"), { kind: "action", action: "pause" });
});
test("goal monitor reads transcript lines without mutating session file", () => {
    const dir = mkdtempSync(join(tmpdir(), "goal-monitor-"));
    const sessionFile = join(dir, "session.jsonl");
    try {
        writeFileSync(sessionFile, [
            JSON.stringify({ type: "session", id: "s", cwd: dir, timestamp: "2026-05-31T00:00:00.000Z" }),
            JSON.stringify({ type: "message", message: { role: "user", content: "hello" } }),
            JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "done" }] } }),
        ].join("\n"));
        assert.deepEqual(readGoalTranscriptLines(sessionFile), [
            `[05-31T00:00:00Z] session start cwd=${dir}`,
            "user: hello",
            "assistant: done",
        ]);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("goal monitor transcript includes custom messages, tool calls, and session metadata", () => {
    const dir = mkdtempSync(join(tmpdir(), "goal-monitor-full-"));
    const sessionFile = join(dir, "session.jsonl");
    try {
        writeFileSync(sessionFile, [
            JSON.stringify({ type: "session_info", name: "goal abcdef12", timestamp: "2026-05-31T00:00:01.000Z" }),
            JSON.stringify({ type: "custom_message", customType: "agent-goal-runtime", content: "hidden steering", timestamp: "2026-05-31T00:00:02.000Z" }),
            JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path: "README.md" } }] }, timestamp: "2026-05-31T00:00:03.000Z" }),
            JSON.stringify({ type: "compaction", summary: "compacted", timestamp: "2026-05-31T00:00:04.000Z" }),
        ].join("\n"));
        const snapshot = readGoalTranscript(sessionFile);
        assert.equal(snapshot.entryCount, 4);
        assert.equal(snapshot.messageCount, 2);
        assert.deepEqual(snapshot.lines, [
            "[05-31T00:00:01Z] session name: goal abcdef12",
            "[05-31T00:00:02Z] custom:agent-goal-runtime: hidden steering",
            '[05-31T00:00:03Z] assistant: [tool call] read {"path":"README.md"}',
            "[05-31T00:00:04Z] compaction: compacted",
        ]);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("goal monitor starts at controller row with explicit nodeList operation", () => {
    const now = new Date("2026-05-31T00:05:00.000Z");
    const nodes = [dagNode({
            nodeId: "people-frappe-attendance-doctypes-long-node-id",
            slug: "people-frappe-attendance-doctypes",
            objective: "Implement attendance DocTypes",
            modelScenario: "implementation-heavy",
            modelArg: "local-aeon/aeon",
        })];
    const subagents = [subagent({
            nodeId: nodes[0].nodeId,
            subagentId: "subagent-abcdef12-attendance",
            sessionFile: "/sessions/subagent.jsonl",
            workspacePath: "/home/shawn/projects/repo/.worktrees/attendance",
            branch: "goal/attendance",
            integrationStatus: "working",
        })];
    const controller = new GoalMonitorController(summary("active"), () => ({ lines: ["controller-tail"], entryCount: 1, messageCount: 1 }), () => ({ nodes, subagents, refreshedAt: now.toISOString() }), () => now);
    const rendered = controller.render(140, theme).join("\n");
    assert.match(rendered, /scope=controller focus=list rowOp=nodeList/);
    assert.match(rendered, /DAG nodes=1 \(running=1\) subagents=1 \(running=1\)/);
    assert.match(rendered, /LIVE: Controller execution \(1 entries \/ 1 messages\)/);
    assert.match(rendered, /controller-tail/);
    assert.match(rendered, /LIST: Controller/);
    assert.match(rendered, /> \[controller\] status=active\/idle-eligible nodes=1 \(running=1\) runners=1 \(running=1\).*ops: \[nodeList\]/);
});
test("goal monitor enters node list with empty live pane and node row runnerList operation", () => {
    const now = new Date("2026-05-31T00:05:00.000Z");
    const nodes = [dagNode({
            status: "controllerValidating",
            expectedOutputs: ["src/output.ts"],
            validators: ["npm test"],
            lastValidationSummary: "validating output",
        })];
    const subagents = [subagent({ status: "controllerValidating" })];
    const controller = new GoalMonitorController(summary("active"), () => ({ lines: ["controller-tail"], entryCount: 1, messageCount: 1 }), () => ({ nodes, subagents, refreshedAt: now.toISOString() }), () => now);
    controller.render(140, theme);
    controller.handleInput("\r"); // confirm controller nodeList operation.
    const rendered = controller.render(140, theme).join("\n");
    assert.match(rendered, /scope=nodes focus=list rowOp=runnerList\(1\)/);
    assert.match(rendered, /LIVE: Node list mode/);
    assert.match(rendered, /No live entries available/);
    assert.doesNotMatch(rendered, /controller-tail/);
    assert.match(rendered, /LIST: Nodes 1\/1/);
    assert.match(rendered, /> 1\. \[controllerValidating\] build-node runners=1 latest=controllerValidating updated=1m ago.*ops: \[runnerList\(1\)\].*back/);
});
test("goal monitor enters runner list and binds live output to selected runner", () => {
    const dir = mkdtempSync(join(tmpdir(), "goal-monitor-runner-list-"));
    const firstSession = join(dir, "runner-1.jsonl");
    const secondSession = join(dir, "runner-2.jsonl");
    const now = new Date("2026-05-31T00:05:00.000Z");
    try {
        writeFileSync(firstSession, JSON.stringify({ type: "message", message: { role: "assistant", content: "first runner transcript" }, timestamp: "2026-05-31T00:04:10.000Z" }));
        writeFileSync(secondSession, JSON.stringify({ type: "message", message: { role: "assistant", content: "second runner transcript" }, timestamp: "2026-05-31T00:04:30.000Z" }));
        const nodes = [dagNode()];
        const subagents = [
            subagent({ subagentId: "subagent-build-node-1", sessionFile: firstSession, branch: "goal/build-node-1", workspacePath: "/repo/.worktrees/build-node-1" }),
            subagent({ subagentId: "subagent-build-node-2", sessionFile: secondSession, branch: "goal/build-node-2", workspacePath: "/repo/.worktrees/build-node-2", integrationStatus: "working second" }),
        ];
        const runners = [
            {
                runnerDir: "/tmp/agent-goal-runtime-bg-one",
                configPath: "/tmp/agent-goal-runtime-bg-one/config.json",
                subagentId: "subagent-build-node-1",
                nodeId: "build-node",
                goalId: "abcdef123456",
                runnerPid: 123,
                childPid: 124,
                runnerAlive: true,
                childAlive: true,
                sessionFile: firstSession,
            },
        ];
        const controller = new GoalMonitorController(summary("active"), () => ({ lines: ["controller-tail"], entryCount: 1, messageCount: 1 }), () => ({ nodes, subagents, runners, refreshedAt: now.toISOString() }), () => now);
        controller.render(140, theme);
        controller.handleInput("\r"); // nodeList
        controller.render(140, theme);
        controller.handleInput("\r"); // runnerList for selected node
        const first = controller.render(140, theme).join("\n");
        assert.match(first, /scope=runners\/build-node focus=list rowOp=view/);
        assert.match(first, /LIVE: Runner subagent-build-node-1/);
        assert.match(first, /first runner transcript/);
        assert.doesNotMatch(first, /second runner transcript/);
        assert.match(first, /LIST: Runners for build-node 1\/2/);
        assert.match(first, /> 1\. \[running\] subagent-build-node-1.*proc=1\/1 pid=123.*ops: \[view\].*openSession.*stop.*kill.*archive.*back/);
        controller.handleInput("\x1b[B"); // select second runner row; live follows selected runner.
        const second = controller.render(140, theme).join("\n");
        assert.match(second, /LIVE: Runner subagent-build-node-2/);
        assert.match(second, /second runner transcript/);
        assert.match(second, /note: working second/);
        assert.match(second, /> 2\. \[running\] subagent-build-node-2/);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("goal monitor confirms selected runner row operations", () => {
    const dir = mkdtempSync(join(tmpdir(), "goal-monitor-runner-ops-"));
    const sessionFile = join(dir, "runner.jsonl");
    const now = new Date("2026-05-31T00:05:00.000Z");
    try {
        writeFileSync(sessionFile, JSON.stringify({ type: "message", message: { role: "assistant", content: "runner transcript" }, timestamp: "2026-05-31T00:04:30.000Z" }));
        const nodes = [dagNode()];
        const subagents = [subagent({ sessionFile })];
        const runners = [{
                runnerDir: "/tmp/agent-goal-runtime-bg-one",
                configPath: "/tmp/agent-goal-runtime-bg-one/config.json",
                subagentId: "subagent-build-node-1",
                nodeId: "build-node",
                goalId: "abcdef123456",
                runnerPid: 123,
                runnerAlive: true,
                childAlive: false,
                sessionFile,
            }];
        const controller = new GoalMonitorController(summary("active"), () => ({ lines: ["controller-tail"], entryCount: 1, messageCount: 1 }), () => ({ nodes, subagents, runners, refreshedAt: now.toISOString() }), () => now);
        controller.render(140, theme);
        controller.handleInput("\r"); // nodeList
        controller.render(140, theme);
        controller.handleInput("\r"); // runnerList
        controller.render(140, theme);
        controller.handleInput("\x1b[C"); // openSession
        assert.deepEqual(controller.handleInput("\r"), { kind: "runnerOperation", operation: "openSession", subagentId: "subagent-build-node-1" });
        controller.handleInput("\x1b[C"); // stop
        assert.deepEqual(controller.handleInput("\r"), { kind: "runnerOperation", operation: "stop", subagentId: "subagent-build-node-1" });
        controller.handleInput("\x1b[C"); // kill
        assert.deepEqual(controller.handleInput("\r"), { kind: "runnerOperation", operation: "kill", subagentId: "subagent-build-node-1" });
        controller.handleInput("\x1b[C"); // archive
        assert.deepEqual(controller.handleInput("\r"), { kind: "runnerOperation", operation: "archive", subagentId: "subagent-build-node-1" });
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("goal monitor back navigation returns runner list to nodes to controller scopes", () => {
    const now = new Date("2026-05-31T00:05:00.000Z");
    const nodes = [dagNode()];
    const subagents = [subagent()];
    const controller = new GoalMonitorController(summary("active"), () => ({ lines: ["controller-tail"], entryCount: 1, messageCount: 1 }), () => ({ nodes, subagents, refreshedAt: now.toISOString() }), () => now);
    controller.render(140, theme);
    controller.handleInput("\r"); // controller -> nodes
    controller.render(140, theme);
    controller.handleInput("\r"); // nodes -> runners
    assert.match(controller.render(140, theme).join("\n"), /scope=runners\/build-node/);
    controller.handleInput("b");
    assert.match(controller.render(140, theme).join("\n"), /scope=nodes/);
    controller.handleInput("\x7f");
    assert.match(controller.render(140, theme).join("\n"), /scope=controller/);
});
test("goal monitor scrolls overflowing node list after entering node scope", () => {
    const now = new Date("2026-05-31T00:05:00.000Z");
    const nodes = Array.from({ length: 20 }, (_, index) => dagNode({
        nodeId: `dag-node-${String(index + 1).padStart(2, "0")}`,
        slug: `dag-node-${String(index + 1).padStart(2, "0")}`,
        objective: `Do DAG node ${index + 1}`,
        status: "planned",
        updatedAt: "2026-05-31T00:00:00.000Z",
    }));
    const controller = new GoalMonitorController(summary("active"), () => ({ lines: ["tail"], entryCount: 1, messageCount: 1 }), () => ({ nodes, subagents: [], refreshedAt: now.toISOString() }), () => now);
    controller.render(140, theme);
    controller.handleInput("\r"); // nodeList
    const firstPage = controller.render(140, theme).join("\n");
    assert.match(firstPage, /scope=nodes/);
    assert.match(firstPage, /Rows: 1-14\/20 selected=1 • active • 6 more rows/);
    assert.doesNotMatch(firstPage, /dag-node-20/);
    controller.handleInput("\x1b[6~"); // PageDown moves selection through the node list.
    const secondPage = controller.render(140, theme).join("\n");
    assert.match(secondPage, /dag-node-14/);
    assert.match(secondPage, /Rows: 1-14\/20 selected=14 • active • 6 more rows/);
});
test("goal monitor live scroll remains available from controller scope", () => {
    const lines = Array.from({ length: 25 }, (_, index) => `transcript-${String(index + 1).padStart(2, "0")}`);
    const controller = new GoalMonitorController(summary("active"), () => ({ lines, entryCount: lines.length, messageCount: lines.length }));
    const initial = controller.render(120, theme).join("\n");
    assert.match(initial, /scope=controller focus=list/);
    assert.match(initial, /transcript-25/);
    controller.handleInput("v");
    controller.handleInput("\x1b[H"); // Home scrolls the live pane after focus switch.
    const top = controller.render(120, theme).join("\n");
    assert.match(top, /focus=live/);
    assert.match(top, /transcript-01/);
    assert.doesNotMatch(top, /transcript-25/);
    assert.match(top, /Live lines: 1-18\/25 • active • 7 more live lines/);
    controller.handleInput("\x1b[F"); // End restores live tail.
    const tail = controller.render(120, theme).join("\n");
    assert.match(tail, /transcript-25/);
    assert.match(tail, /Live lines: 8-25\/25 • active • live • 7 previous live lines/);
});
test("goal monitor render auto-follows controller live transcript tail", () => {
    let lines = ["one"];
    const controller = new GoalMonitorController(summary("active"), () => ({ lines, entryCount: lines.length, messageCount: lines.length }));
    assert.ok(controller.render(120, theme).some((line) => line.includes("one")));
    lines = ["one", "two"];
    assert.ok(controller.render(120, theme).some((line) => line.includes("two")));
});
//# sourceMappingURL=pi-monitor-ui.test.js.map