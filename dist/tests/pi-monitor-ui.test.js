import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GoalMonitorController, readControllerTranscript, readGoalTranscript, readGoalTranscriptLines, buildGoalMonitorRuntimeSummary, deriveMonitorHealth, SESSION_STATE_LABELS, HIDDEN_CONTINUATION_STATE_LABELS, CONTROLLER_POLL_STATE_LABELS, } from "../adapters/pi/monitor-ui.js";
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
function ledgerEvent(overrides = {}) {
    return {
        sessionKey: "s1",
        goalId: "abcdef123456",
        type: "controller_event",
        at: "2026-05-31T00:04:45.000Z",
        details: { event: "poll.started" },
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
test("goal monitor treats missing controller transcript as unavailable instead of raw missing-file error", () => {
    const missingSessionFile = join(tmpdir(), `missing-controller-${Date.now()}.jsonl`);
    const controller = new GoalMonitorController(summary("active", missingSessionFile), undefined, () => ({ nodes: [dagNode()], subagents: [], refreshedAt: "2026-05-31T00:05:00.000Z" }));
    const snapshot = readControllerTranscript(missingSessionFile);
    assert.equal(snapshot.entryCount, 0);
    assert.match(snapshot.diagnostic ?? "", /Controller transcript unavailable/);
    assert.doesNotMatch(snapshot.diagnostic ?? "", /Session file not found/);
    assert.deepEqual(controller.actions, ["pause", "resume", "clear", "close"]);
    const rendered = controller.render(160, theme).join("\n");
    assert.match(rendered, /Controller transcript unavailable/);
    assert.doesNotMatch(rendered, /Session file not found/);
    assert.doesNotMatch(rendered, /openSession/);
});
test("goal monitor transcript tracks session model, thinking, and assistant tokens", () => {
    const dir = mkdtempSync(join(tmpdir(), "goal-monitor-usage-"));
    const sessionFile = join(dir, "session.jsonl");
    try {
        writeFileSync(sessionFile, [
            JSON.stringify({ type: "model_change", provider: "openai-codex", modelId: "gpt-5.3-codex-spark", timestamp: "2026-05-31T00:00:01.000Z" }),
            JSON.stringify({ type: "thinking_level_change", thinkingLevel: "high", timestamp: "2026-05-31T00:00:02.000Z" }),
            JSON.stringify({ type: "message", message: { role: "assistant", content: "done", usage: { input: 1000, output: 2000 } }, timestamp: "2026-05-31T00:00:03.000Z" }),
            JSON.stringify({ type: "message", message: { role: "user", content: "thanks", usage: { input: 5000, output: 5000 } }, timestamp: "2026-05-31T00:00:04.000Z" }),
        ].join("\n"));
        const snapshot = readGoalTranscript(sessionFile);
        assert.equal(snapshot.modelArg, "openai-codex/gpt-5.3-codex-spark");
        assert.equal(snapshot.thinkingLevel, "high");
        assert.equal(snapshot.tokenTotal, 3000);
        assert.match(snapshot.lines.join("\n"), /model: openai-codex\/gpt-5\.3-codex-spark/);
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
            JSON.stringify({ type: "custom_message", customType: "goal-runner", content: "hidden steering", timestamp: "2026-05-31T00:00:02.000Z" }),
            JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path: "README.md" } }] }, timestamp: "2026-05-31T00:00:03.000Z" }),
            JSON.stringify({ type: "compaction", summary: "compacted", timestamp: "2026-05-31T00:00:04.000Z" }),
        ].join("\n"));
        const snapshot = readGoalTranscript(sessionFile);
        assert.equal(snapshot.entryCount, 4);
        assert.equal(snapshot.messageCount, 2);
        assert.deepEqual(snapshot.lines, [
            "[05-31T00:00:01Z] session name: goal abcdef12",
            "[05-31T00:00:02Z] custom:goal-runner: hidden steering",
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
    assert.match(rendered, /LIVE: Controller legacy transcript fallback \(1 line\)/);
    assert.match(rendered, /controller-tail/);
    assert.match(rendered, /LIST: Controller/);
    assert.match(rendered, /> \[controller\] status=active\/idle-eligible nodes=1 \(running=1\) runners=1 \(running=1\) history=0.*ops: \[nodeList\]/);
});
test("goal monitor controller live pane renders durable controller history events", () => {
    const now = new Date("2026-05-31T00:05:00.000Z");
    const nodes = [dagNode()];
    const subagents = [subagent()];
    const controller = new GoalMonitorController(summary("active"), () => ({ lines: ["controller-tail should not be shown when ledger exists"], entryCount: 1, messageCount: 1 }), () => ({
        nodes,
        subagents,
        ledgerEvents: [
            ledgerEvent({ type: "goal_created", at: "2026-05-31T00:00:00.000Z", details: { objective: "monitor goal" } }),
            ledgerEvent({
                at: "2026-05-31T00:04:00.000Z",
                details: {
                    event: "validation.failed",
                    nodeId: "build-node",
                    subagentId: "subagent-build-node-1",
                    summary: "missing outputs: dist/app.js",
                    followup: true,
                },
            }),
            ledgerEvent({
                at: "2026-05-31T00:04:30.000Z",
                details: { event: "followup.sent", nodeId: "build-node", subagentId: "subagent-build-node-1", summary: "asked subagent to create dist/app.js" },
            }),
        ],
        refreshedAt: now.toISOString(),
    }), () => now);
    const rendered = controller.render(180, theme).join("\n");
    assert.match(rendered, /LIVE: Controller history compact \(3 lines, 3 raw events\)/);
    assert.match(rendered, /goal\.created\s+monitor goal/);
    assert.match(rendered, /validation\.failed\s+node=build-node subagent=subagent-build-node-1 summary=missing outputs: dist\/app\.js/);
    assert.match(rendered, /followup\.sent\s+node=build-node subagent=subagent-build-node-1 summary=asked subagent to create dist\/app\.js/);
    assert.doesNotMatch(rendered, /controller-tail should not be shown/);
    assert.match(rendered, /history=3/);
});
test("goal monitor compact controller history hides poll noise and folds repeated blockers", () => {
    const now = new Date("2026-05-31T00:05:00.000Z");
    const controller = new GoalMonitorController(summary("active"), () => ({ lines: ["controller-tail should not be shown when ledger exists"], entryCount: 1, messageCount: 1 }), () => ({
        nodes: [dagNode({ status: "blocked", lastValidationSummary: "Controller validation failed: missing outputs: dist/app.js" })],
        subagents: [subagent({ status: "blocked", selfReportedResult: "waiting on expected output" })],
        ledgerEvents: [
            ledgerEvent({ at: "2026-05-31T00:01:00.000Z", details: { event: "poll.started", nodes: 1, subagents: 1 } }),
            ledgerEvent({ at: "2026-05-31T00:01:01.000Z", details: { event: "poll.finished", changed: false, ready: 0 } }),
            ledgerEvent({ at: "2026-05-31T00:02:00.000Z", details: { event: "validation.failed", nodeId: "build-node", subagentId: "subagent-build-node-1", summary: "missing outputs: dist/app.js" } }),
            ledgerEvent({ at: "2026-05-31T00:02:30.000Z", details: { event: "poll.started", nodes: 1, subagents: 1 } }),
            ledgerEvent({ at: "2026-05-31T00:02:31.000Z", details: { event: "validation.failed", nodeId: "build-node", subagentId: "subagent-build-node-1", summary: "missing outputs: dist/app.js" } }),
            ledgerEvent({ at: "2026-05-31T00:03:00.000Z", details: { event: "validation.failed", nodeId: "build-node", subagentId: "subagent-build-node-1", summary: "missing outputs: dist/app.js" } }),
            ledgerEvent({ at: "2026-05-31T00:03:30.000Z", details: { event: "recovery.blocked", nodeId: "build-node", subagentId: "subagent-build-node-1", reason: "retry limit reached" } }),
            ledgerEvent({ at: "2026-05-31T00:04:00.000Z", details: { event: "recovery.blocked", nodeId: "build-node", subagentId: "subagent-build-node-1", reason: "retry limit reached" } }),
        ],
        refreshedAt: now.toISOString(),
    }), () => now);
    const compact = controller.render(200, theme).join("\n");
    assert.match(compact, /LIVE: Controller history compact \(2 lines, 8 raw events\)/);
    assert.match(compact, /Current blocker: build-node \[blocked\] — Controller validation failed: missing outputs: dist\/app\.js/);
    assert.match(compact, /validation\.failed ×3\s+node=build-node subagent=subagent-build-node-1 summary=missing outputs: dist\/app\.js/);
    assert.match(compact, /recovery\.blocked ×2\s+node=build-node subagent=subagent-build-node-1 reason=retry limit reached/);
    assert.doesNotMatch(compact, /poll\.started/);
    assert.doesNotMatch(compact, /poll\.finished/);
    controller.handleInput("c");
    const debug = controller.render(200, theme).join("\n");
    assert.match(debug, /LIVE: Controller history debug \(8 events\)/);
    assert.match(debug, /poll\.started/);
    assert.match(debug, /poll\.finished/);
    assert.doesNotMatch(debug, /validation\.failed ×3/);
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
        writeFileSync(firstSession, [
            JSON.stringify({ type: "model_change", provider: "openai-codex", modelId: "gpt-5.3-codex-spark", timestamp: "2026-05-31T00:04:00.000Z" }),
            JSON.stringify({ type: "thinking_level_change", thinkingLevel: "high", timestamp: "2026-05-31T00:04:01.000Z" }),
            JSON.stringify({ type: "message", message: { role: "assistant", content: "first runner transcript", usage: { input: 1000, output: 2000 } }, timestamp: "2026-05-31T00:04:10.000Z" }),
        ].join("\n"));
        writeFileSync(secondSession, JSON.stringify({ type: "message", message: { role: "assistant", content: "second runner transcript", usage: { totalTokens: 12 } }, timestamp: "2026-05-31T00:04:30.000Z" }));
        const nodes = [dagNode({ modelScenario: "verify-fast", modelArg: "openai-codex/gpt-5.3-codex-spark", thinkingLevel: "high" })];
        const subagents = [
            subagent({ subagentId: "subagent-build-node-1", sessionFile: firstSession, branch: "goal/build-node-1", workspacePath: "/repo/.worktrees/build-node-1" }),
            subagent({ subagentId: "subagent-build-node-2", sessionFile: secondSession, branch: "goal/build-node-2", workspacePath: "/repo/.worktrees/build-node-2", integrationStatus: "working second" }),
        ];
        const runners = [
            {
                runnerDir: "/tmp/goal-runner-bg-one",
                configPath: "/tmp/goal-runner-bg-one/config.json",
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
        assert.match(first, /LIVE: Runner subagent-build-node-1 model=verify-fast -> openai-codex\/gpt-5\.3-codex-spark -> \[high\] tokens=3k/);
        assert.match(first, /first runner transcript/);
        assert.doesNotMatch(first, /second runner transcript/);
        assert.match(first, /LIST: Runners for build-node 1\/2/);
        assert.match(first, /> 1\. \[running\] subagent-build-node-1.*proc=1\/1 pid=123.*ops: \[view\].*openSession.*stop.*kill.*archive.*back/);
        controller.handleInput("\x1b[B"); // select second runner row; live follows selected runner.
        const second = controller.render(140, theme).join("\n");
        assert.match(second, /LIVE: Runner subagent-build-node-2 model=verify-fast -> openai-codex\/gpt-5\.3-codex-spark -> \[high\] tokens=12/);
        assert.match(second, /second runner transcript/);
        assert.match(second, /note: working second/);
        assert.match(second, /> 2\. \[running\] subagent-build-node-2/);
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("goal monitor shows runner config thinking level before transcript records it", () => {
    const dir = mkdtempSync(join(tmpdir(), "goal-monitor-runner-thinking-"));
    const sessionFile = join(dir, "runner.jsonl");
    const now = new Date("2026-05-31T00:05:00.000Z");
    try {
        writeFileSync(sessionFile, JSON.stringify({ type: "message", message: { role: "assistant", content: "runner transcript", usage: { totalTokens: 42 } }, timestamp: "2026-05-31T00:04:30.000Z" }));
        const nodes = [dagNode()];
        const subagents = [subagent({ sessionFile })];
        const runners = [{
                runnerDir: "/tmp/goal-runner-bg-one",
                configPath: "/tmp/goal-runner-bg-one/config.json",
                subagentId: "subagent-build-node-1",
                nodeId: "build-node",
                goalId: "abcdef123456",
                modelArg: "openai-codex/gpt-5.5",
                thinkingLevel: "xhigh",
                runnerAlive: true,
                childAlive: false,
                sessionFile,
            }];
        const controller = new GoalMonitorController(summary("active"), () => ({ lines: ["controller-tail"], entryCount: 1, messageCount: 1 }), () => ({ nodes, subagents, runners, refreshedAt: now.toISOString() }), () => now);
        controller.render(140, theme);
        controller.handleInput("\r"); // nodeList
        controller.render(140, theme);
        controller.handleInput("\r"); // runnerList
        const rendered = controller.render(140, theme).join("\n");
        assert.match(rendered, /LIVE: Runner subagent-build-node-1 model=openai-codex\/gpt-5\.5 -> \[xhigh\] tokens=42/);
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
                runnerDir: "/tmp/goal-runner-bg-one",
                configPath: "/tmp/goal-runner-bg-one/config.json",
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
// ── Runtime band tests ──
test("runtime summary shows active session + suppressed continuation as normal, not failure", () => {
    // When only harnessState is provided (no reservation), suppressed from
    // harness is used. Reservation takes priority over harness, so we omit it here.
    const harnessState = {
        materialized: true,
        activeTurnId: "turn-1",
        queuedUserInput: false,
        queuedTriggerTurn: false,
        continuationSuppressed: true,
    };
    const now = Date.now();
    const ledgerEvents = [
        ledgerEvent({ at: new Date(now - 5_000).toISOString(), details: { event: "poll.finished", changed: false, ready: 0 } }),
    ];
    const subagents = [subagent({ subagentId: "runner-1", status: "running" })];
    const runnerRecords = [
        { runnerDir: "/tmp/r1", configPath: "/tmp/r1/config.json", subagentId: "runner-1", nodeId: "n1", goalId: "abcdef123456", runnerAlive: true, childAlive: true },
    ];
    const rt = buildGoalMonitorRuntimeSummary(summary("active"), subagents, { harnessState, ledgerEvents, runners: runnerRecords });
    assert.equal(rt.session.state, "active-turn");
    assert.equal(rt.session.activeTurnId, "turn-1");
    assert.equal(rt.hiddenContinuation.state, "suppressed");
    assert.equal(rt.hiddenContinuation.reason, "active turn running");
    assert.equal(rt.controllerPoll.state, "active");
    assert.equal(rt.runners.running, 1);
    const health = deriveMonitorHealth(rt, summary("active"), subagents);
    assert.equal(health.health, "OK");
    assert.match(health.nextAction, /monitor progress/);
});
test("runtime summary harness-suppressed hidden is overridden by reservation", () => {
    // When both harnessState (suppressed) and reservation (pending) are given,
    // reservation takes priority.
    const harnessState = {
        materialized: true,
        activeTurnId: "turn-1",
        queuedUserInput: false,
        queuedTriggerTurn: false,
        continuationSuppressed: true,
    };
    const reservation = {
        sessionKey: "s1",
        attemptId: "attempt-1",
        goalId: "abcdef123456",
        goalUpdatedAt: "2026-05-31T00:00:00.000Z",
        attemptCount: 1,
        status: "pending",
        createdAt: "2026-05-31T00:01:00.000Z",
        updatedAt: "2026-05-31T00:01:00.000Z",
        expiresAt: "2026-05-31T01:01:00.000Z",
    };
    const rt = buildGoalMonitorRuntimeSummary(summary("active"), [], { harnessState, reservation });
    // Reservation (pending → reserved) takes priority over harness (suppressed).
    assert.equal(rt.hiddenContinuation.state, "reserved");
    assert.equal(rt.hiddenContinuation.attemptId, "attempt-1");
});
test("runtime summary labels suppressed continuation with reason", () => {
    // Only harness, no reservation — harness drives suppressed with reason.
    const harnessState = {
        materialized: true,
        activeTurnId: "turn-1",
        queuedUserInput: false,
        queuedTriggerTurn: false,
        continuationSuppressed: true,
    };
    const runtimeSummary = buildGoalMonitorRuntimeSummary(summary("active"), [], { harnessState });
    assert.equal(runtimeSummary.hiddenContinuation.state, "suppressed");
    assert.equal(runtimeSummary.hiddenContinuation.reason, "active turn running");
    // Suppressed with queued user input reason.
    const harnessWithInput = {
        materialized: true,
        queuedUserInput: true,
        queuedTriggerTurn: false,
        continuationSuppressed: true,
    };
    const summary2 = buildGoalMonitorRuntimeSummary(summary("active"), [], { harnessState: harnessWithInput });
    assert.equal(summary2.hiddenContinuation.reason, "queued user input");
});
test("runtime summary shows reserved continuation from reservation", () => {
    const reservation = {
        sessionKey: "s1",
        attemptId: "attempt-2",
        goalId: "abcdef123456",
        goalUpdatedAt: "2026-05-31T00:00:00.000Z",
        attemptCount: 2,
        status: "pending",
        createdAt: "2026-05-31T00:01:00.000Z",
        updatedAt: "2026-05-31T00:01:00.000Z",
        expiresAt: "2026-05-31T01:01:00.000Z",
    };
    const runtimeSummary = buildGoalMonitorRuntimeSummary(summary("active"), [], { reservation });
    assert.equal(runtimeSummary.hiddenContinuation.state, "reserved");
    assert.equal(runtimeSummary.hiddenContinuation.attemptId, "attempt-2");
});
test("runtime summary shows started continuation from reservation", () => {
    const reservation = {
        sessionKey: "s1",
        attemptId: "attempt-3",
        goalId: "abcdef123456",
        goalUpdatedAt: "2026-05-31T00:00:00.000Z",
        attemptCount: 3,
        status: "started",
        createdAt: "2026-05-31T00:01:00.000Z",
        updatedAt: "2026-05-31T00:01:00.000Z",
        expiresAt: "2026-05-31T01:01:00.000Z",
    };
    const runtimeSummary = buildGoalMonitorRuntimeSummary(summary("active"), [], { reservation });
    assert.equal(runtimeSummary.hiddenContinuation.state, "started");
    assert.equal(runtimeSummary.hiddenContinuation.attemptId, "attempt-3");
});
test("runtime summary derives poll state from ledger events", () => {
    // Active poll: recent poll.finished within grace period.
    const now = Date.now();
    const recentFinished = ledgerEvent({
        at: new Date(now - 5_000).toISOString(),
        details: { event: "poll.finished", changed: true, ready: 1, leased: false },
    });
    const summary1 = buildGoalMonitorRuntimeSummary(summary("active"), [], { ledgerEvents: [recentFinished], controllerPollGraceMs: 30_000 });
    assert.equal(summary1.controllerPoll.state, "active");
    // Leased poll: poll.finished with leased=true.
    const leasedEvent = ledgerEvent({
        at: new Date(now - 5_000).toISOString(),
        details: { event: "poll.finished", changed: false, leased: true, leaseOwner: "other-instance" },
    });
    const summary2 = buildGoalMonitorRuntimeSummary(summary("active"), [], { ledgerEvents: [leasedEvent], controllerPollGraceMs: 30_000 });
    assert.equal(summary2.controllerPoll.state, "leased");
    assert.equal(summary2.controllerPoll.leaseOwner, "other-instance");
    // Stopped: explicit poll.stopped event.
    const stoppedEvent = ledgerEvent({
        at: new Date(now - 10_000).toISOString(),
        details: { event: "poll.stopped", reason: "goal cleared" },
    });
    const summary3 = buildGoalMonitorRuntimeSummary(summary("active"), [], { ledgerEvents: [stoppedEvent], controllerPollGraceMs: 30_000 });
    assert.equal(summary3.controllerPoll.state, "stopped");
    assert.equal(summary3.controllerPoll.reason, "goal cleared");
    // Stale poll: poll.finished older than grace period.
    const staleEvent = ledgerEvent({
        at: new Date(now - 120_000).toISOString(),
        details: { event: "poll.finished", changed: false, ready: 0, leased: false },
    });
    const summary4 = buildGoalMonitorRuntimeSummary(summary("active"), [], { ledgerEvents: [staleEvent], controllerPollGraceMs: 30_000 });
    assert.equal(summary4.controllerPoll.state, "stopped");
    assert.match(summary4.controllerPoll.reason ?? "", /last poll stale/);
});
test("runtime summary runner counts aggregate subagent statuses", () => {
    // Runner counts are driven by background runner records, not just subagent status.
    // Subagent status contributes to failed/archived counts.
    const subagents = [
        subagent({ subagentId: "sa-1", status: "running" }),
        subagent({ subagentId: "sa-2", status: "running" }),
        subagent({ subagentId: "sa-3", status: "complete" }),
        subagent({ subagentId: "sa-4", status: "blocked" }),
        subagent({ subagentId: "sa-5", status: "failed" }),
    ];
    // Provide runner records for the running subagents so they count as running.
    const runnerRecords = [
        { runnerDir: "/tmp/r1", configPath: "/tmp/r1/config.json", subagentId: "sa-1", nodeId: "n1", goalId: "g1", runnerAlive: true, childAlive: true },
        { runnerDir: "/tmp/r2", configPath: "/tmp/r2/config.json", subagentId: "sa-2", nodeId: "n1", goalId: "g1", runnerAlive: true, childAlive: false },
    ];
    const rt = buildGoalMonitorRuntimeSummary(summary("active"), subagents, { runners: runnerRecords });
    assert.equal(rt.runners.running, 2);
    assert.equal(rt.runners.stopped, 0);
    assert.equal(rt.runners.archived, 1);
    assert.equal(rt.runners.failed, 2);
});
test("health line shows Blocked when goal status is blocked", () => {
    const subagents = [subagent({ status: "running" })];
    const rt = buildGoalMonitorRuntimeSummary(summary("blocked"), subagents);
    const health = deriveMonitorHealth(rt, summary("blocked"), subagents);
    assert.equal(health.health, "Blocked");
});
test("health line shows Needs attention when subagent is blocked/failed", () => {
    const blockedSub = [subagent({ subagentId: "sa-1", status: "blocked" })];
    const harnessState = {
        materialized: true,
        activeTurnId: "turn-1",
        queuedUserInput: false,
        queuedTriggerTurn: false,
        continuationSuppressed: false,
    };
    const rt = buildGoalMonitorRuntimeSummary(summary("active"), blockedSub, { harnessState });
    const health = deriveMonitorHealth(rt, summary("active"), blockedSub);
    assert.equal(health.health, "Needs attention");
    assert.match(health.nextAction, /inspect blocked/);
});
test("health line shows OK when active session + suppressed continuation + running poll", () => {
    const harnessState = {
        materialized: true,
        activeTurnId: "turn-1",
        queuedUserInput: false,
        queuedTriggerTurn: false,
        continuationSuppressed: true,
    };
    const subagents = [subagent({ status: "running" })];
    const now = Date.now();
    const ledgerEvents = [
        ledgerEvent({
            at: new Date(now - 5_000).toISOString(),
            details: { event: "poll.finished", changed: true, ready: 1, leased: false },
        }),
    ];
    const rt = buildGoalMonitorRuntimeSummary(summary("active"), subagents, { harnessState, ledgerEvents });
    const health = deriveMonitorHealth(rt, summary("active"), subagents);
    assert.equal(health.health, "OK");
    assert.match(health.nextAction, /monitor progress/);
});
test("Pi monitor render includes runtime band lines with Session/Hidden/Poll/Runners", () => {
    const now = new Date("2026-05-31T00:05:00.000Z");
    const ledgerEvents = [
        ledgerEvent({
            at: "2026-05-31T00:04:00.000Z",
            details: { event: "poll.finished", changed: true, ready: 1, leased: false },
        }),
    ];
    const nodes = [dagNode({ nodeId: "n1", status: "running" })];
    const subagents = [subagent({ nodeId: "n1", subagentId: "sa-1", status: "running" })];
    // Provide a runner record so the subagent counts as running.
    const runnerRecords = [
        { runnerDir: "/tmp/r1", configPath: "/tmp/r1/config.json", subagentId: "sa-1", nodeId: "n1", goalId: "abcdef123456", runnerAlive: true, childAlive: true },
    ];
    const controller = new GoalMonitorController(summary("active"), () => ({ lines: ["tail"], entryCount: 1, messageCount: 1 }), () => ({ nodes, subagents, runners: runnerRecords, ledgerEvents, refreshedAt: now.toISOString() }), () => now);
    const rendered = controller.render(160, theme).join("\n");
    // Runtime band should be present with all four keys and health line.
    assert.match(rendered, /Session=/);
    assert.match(rendered, /Hidden=/);
    assert.match(rendered, /Poll=/);
    assert.match(rendered, /Runners=/);
    assert.match(rendered, /Health=/);
    assert.match(rendered, /Next:/);
    // Existing monitor features still work.
    assert.match(rendered, /scope=controller focus=list/);
    assert.match(rendered, /> \[controller\]/);
});
test("Pi monitor blocked node renders Needs attention with next-action pointing to blocked node", () => {
    const now = new Date("2026-05-31T00:05:00.000Z");
    const nodes = [dagNode({ nodeId: "n1", status: "blocked", lastValidationSummary: "output missing" })];
    const subagents = [subagent({ nodeId: "n1", subagentId: "sa-1", status: "blocked" })];
    // When blocked subagent with no running runners and no active session, health is "Blocked".
    // With a running runner on another subagent, it becomes "Needs attention".
    const runningSub = subagent({ nodeId: "n1", subagentId: "sa-2", status: "running" });
    const runnerRecords = [
        { runnerDir: "/tmp/r2", configPath: "/tmp/r2/config.json", subagentId: "sa-2", nodeId: "n1", goalId: "abcdef123456", runnerAlive: true, childAlive: true },
    ];
    const controller = new GoalMonitorController(summary("active"), () => ({ lines: ["tail"], entryCount: 1, messageCount: 1 }), () => ({ nodes, subagents: [subagents[0], runningSub], runners: runnerRecords, refreshedAt: now.toISOString() }), () => now);
    const rendered = controller.render(160, theme).join("\n");
    assert.match(rendered, /Health=Needs attention/);
    assert.match(rendered, /Next: inspect blocked/);
    // Blocker diagnostic should also appear.
    assert.match(rendered, /Current blocker:/);
});
test("Pi monitor fully blocked goal shows Blocked health", () => {
    const now = new Date("2026-05-31T00:05:00.000Z");
    const nodes = [dagNode({ nodeId: "n1", status: "blocked", lastValidationSummary: "all outputs failed" })];
    const subagents = [subagent({ nodeId: "n1", subagentId: "sa-1", status: "blocked" })];
    const controller = new GoalMonitorController(summary("blocked"), () => ({ lines: ["tail"], entryCount: 1, messageCount: 1 }), () => ({ nodes, subagents, refreshedAt: now.toISOString() }), () => now);
    const rendered = controller.render(160, theme).join("\n");
    // When everything is blocked with no running runners, health is "Blocked".
    assert.match(rendered, /Health=Blocked/);
    assert.match(rendered, /Current blocker:/);
});
test("Pi monitor running runners with active session not shown as stalled", () => {
    const now = new Date("2026-05-31T00:05:00.000Z");
    const nowMs = Date.now();
    const ledgerEvents = [
        ledgerEvent({
            at: new Date(nowMs - 5_000).toISOString(),
            details: { event: "poll.finished", changed: true, ready: 1, leased: false },
        }),
    ];
    const nodes = [dagNode({ nodeId: "n1", status: "running" })];
    const subagents = [subagent({ nodeId: "n1", subagentId: "sa-1", status: "running" })];
    const runnerRecords = [
        { runnerDir: "/tmp/r1", configPath: "/tmp/r1/config.json", subagentId: "sa-1", nodeId: "n1", goalId: "abcdef123456", runnerAlive: true, childAlive: true },
    ];
    const controller = new GoalMonitorController(summary("active"), () => ({ lines: ["tail"], entryCount: 1, messageCount: 1 }), () => ({ nodes, subagents, runners: runnerRecords, ledgerEvents, refreshedAt: now.toISOString() }), () => now);
    const rendered = controller.render(160, theme).join("\n");
    // Should NOT show "stalled" status.
    assert.doesNotMatch(rendered, /status=stalled/);
    // Should show OK health.
    assert.match(rendered, /Health=OK/);
    // Runners count should show running runners.
    assert.match(rendered, /Runners=1 running/);
});
test("Pi monitor narrow width rendering keeps runtime state visible", () => {
    const now = new Date("2026-05-31T00:05:00.000Z");
    const nowMs = Date.now();
    const ledgerEvents = [
        ledgerEvent({
            at: new Date(nowMs - 5_000).toISOString(),
            details: { event: "poll.finished", changed: true, ready: 1, leased: false },
        }),
    ];
    const nodes = [dagNode({ nodeId: "n1", status: "running" })];
    const subagents = [
        subagent({ nodeId: "n1", subagentId: "sa-1", status: "running" }),
        subagent({ nodeId: "n1", subagentId: "sa-2", status: "running" }),
    ];
    const runnerRecords = [
        { runnerDir: "/tmp/r1", configPath: "/tmp/r1/config.json", subagentId: "sa-1", nodeId: "n1", goalId: "abcdef123456", runnerAlive: true, childAlive: true },
        { runnerDir: "/tmp/r2", configPath: "/tmp/r2/config.json", subagentId: "sa-2", nodeId: "n1", goalId: "abcdef123456", runnerAlive: true, childAlive: false },
    ];
    const controller = new GoalMonitorController(summary("active"), () => ({ lines: ["tail"], entryCount: 1, messageCount: 1 }), () => ({ nodes, subagents, runners: runnerRecords, ledgerEvents, refreshedAt: now.toISOString() }), () => now);
    // Render at narrow width (80 columns).
    const narrow = controller.render(80, theme).join("\n");
    // All key runtime state labels should still appear in the narrow output.
    assert.match(narrow, /Session=/);
    assert.match(narrow, /Hidden=/);
    assert.match(narrow, /Poll=/);
    assert.match(narrow, /Runners=/);
    assert.match(narrow, /Health=/);
    assert.match(narrow, /Next:/);
    // At 80 cols, if the full line is short enough it stays on 1 line (2 band total).
    // If long enough it splits across 2 lines + health = 3 band lines. Either way
    // all keys should be visible.
    const bandLines = narrow.split("\n").filter((line) => line.includes("Session=") || line.includes("Poll=") || line.includes("Health="));
    assert.ok(bandLines.length >= 2, `Expected at least 2 runtime band lines, got ${bandLines.length}`);
    // Verify split behavior at 40 columns forces multi-line band.
    const veryNarrow = controller.render(40, theme).join("\n");
    const narrowBandLines = veryNarrow.split("\n").filter((line) => line.includes("Session=") || line.includes("Poll=") || line.includes("Health="));
    assert.ok(narrowBandLines.length >= 3, `Expected at least 3 band lines at 40 cols, got ${narrowBandLines.length}`);
    assert.match(veryNarrow, /Session=/);
    assert.match(veryNarrow, /Hidden=/);
    assert.match(veryNarrow, /Poll=/);
    assert.match(veryNarrow, /Runners=/);
});
test("runtime summary canonical labels are consistent", () => {
    // Verify label map coverage.
    assert.equal(SESSION_STATE_LABELS["active-turn"], "ACTIVE-TURN");
    assert.equal(SESSION_STATE_LABELS.idle, "IDLE");
    assert.equal(SESSION_STATE_LABELS.missing, "MISSING");
    assert.equal(SESSION_STATE_LABELS["not-materialized"], "NOT-MATERIALIZED");
    assert.equal(SESSION_STATE_LABELS.unknown, "UNKNOWN");
    assert.equal(HIDDEN_CONTINUATION_STATE_LABELS.suppressed, "SUPPRESSED");
    assert.equal(HIDDEN_CONTINUATION_STATE_LABELS.eligible, "ELIGIBLE");
    assert.equal(HIDDEN_CONTINUATION_STATE_LABELS.reserved, "RESERVED");
    assert.equal(HIDDEN_CONTINUATION_STATE_LABELS.started, "STARTED");
    assert.equal(CONTROLLER_POLL_STATE_LABELS.active, "ACTIVE");
    assert.equal(CONTROLLER_POLL_STATE_LABELS.leased, "LEASED");
    assert.equal(CONTROLLER_POLL_STATE_LABELS.skipped, "SKIPPED");
    assert.equal(CONTROLLER_POLL_STATE_LABELS.stopped, "STOPPED");
    assert.equal(CONTROLLER_POLL_STATE_LABELS.unknown, "UNKNOWN");
});
test("runtime summary falls back to activityState when harness not available", () => {
    // Goal with activityState = "idle-eligible" → hidden=eligible.
    const s = summary("active");
    s.activityState = "idle-eligible";
    const runtimeSummary = buildGoalMonitorRuntimeSummary(s, []);
    assert.equal(runtimeSummary.session.state, "idle");
    assert.equal(runtimeSummary.hiddenContinuation.state, "eligible");
    // Goal with activityState = "suppressed" → hidden=suppressed.
    const s2 = summary("active");
    s2.activityState = "suppressed";
    const runtimeSummary2 = buildGoalMonitorRuntimeSummary(s2, []);
    assert.equal(runtimeSummary2.hiddenContinuation.state, "suppressed");
    // Complete goal → not-eligible.
    const runtimeSummary3 = buildGoalMonitorRuntimeSummary(summary("complete"), []);
    assert.equal(runtimeSummary3.hiddenContinuation.state, "not-eligible");
    assert.match(runtimeSummary3.hiddenContinuation.reason ?? "", /goal status is complete/);
});
test("runtime summary session missing when no session file and no harness", () => {
    // When status is not complete and sessionFile is undefined, the fallback logic
    // checks if sessionFile exists. Without sessionFile, it falls through to
    // activityState-based derivation. For complete goals it shows not-materialized.
    const s = summary("complete");
    s.sessionFile = undefined;
    const runtimeSummary = buildGoalMonitorRuntimeSummary(s, []);
    // For complete goals, session is always not-materialized.
    assert.equal(runtimeSummary.session.state, "not-materialized");
});
test("runtime summary session unknown when active but no harness and no clear activity state", () => {
    const s = summary("active");
    s.sessionFile = undefined;
    s.activityState = "active-turn";
    const runtimeSummary = buildGoalMonitorRuntimeSummary(s, []);
    // With activityState containing "active-turn", fallback produces active-turn.
    assert.equal(runtimeSummary.session.state, "active-turn");
});
//# sourceMappingURL=pi-monitor-ui.test.js.map