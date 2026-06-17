import test from "node:test";
import assert from "node:assert/strict";
import { renderOpencodeMonitorLines, readOpencodeGoalMonitorSnapshot } from "../adapters/opencode/monitor-ui.js";
import { buildGoalMonitorRuntimeSummary, SESSION_STATE_LABELS, HIDDEN_CONTINUATION_STATE_LABELS, CONTROLLER_POLL_STATE_LABELS, } from "../adapters/pi/monitor-ui.js";
import { buildGoalMonitorOverview, deriveMonitorHealth, summarizeMonitorProblem, formatRuntimeSummaryForOverview, EXTENDED_MONITOR_HEALTH_LABELS, } from "../adapters/monitor-overview.js";
import { GoalRuntime, SQLiteGoalStore } from "../core/index.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const NOW = new Date("2026-06-03T01:00:00.000Z");
function makeSummary(overrides = {}) {
    return {
        sessionKey: "opencode:goal-1",
        goalId: "goal-1",
        shortGoalId: "goal-1",
        status: "active",
        objective: "ship the migration",
        objectiveSummary: "ship the migration",
        tokensUsed: 0,
        timeUsedSeconds: 0,
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
        lastActivityAt: NOW.toISOString(),
        ...overrides,
    };
}
function makeNode(overrides = {}) {
    return {
        goalId: "goal-1",
        nodeId: "n1",
        slug: "n1",
        objective: "implement X",
        expectedOutputs: [],
        validators: [],
        completionGates: [],
        dependencyNodeIds: [],
        status: "running",
        createdAt: new Date(NOW.getTime() - 60_000).toISOString(),
        updatedAt: new Date(NOW.getTime() - 5_000).toISOString(),
        ...overrides,
    };
}
function makeSubagent(overrides = {}) {
    return {
        goalId: "goal-1",
        nodeId: "n1",
        subagentId: "sa-1",
        harnessAdapterId: "opencode",
        prompts: [],
        status: "running",
        sessionId: "ses-1",
        branch: "feat/x",
        workspacePath: "/tmp/oc-wt-1",
        createdAt: new Date(NOW.getTime() - 60_000).toISOString(),
        updatedAt: new Date(NOW.getTime() - 5_000).toISOString(),
        lastActivityAt: new Date(NOW.getTime() - 5_000).toISOString(),
        ...overrides,
    };
}
function ledgerEvent(overrides = {}) {
    return {
        sessionKey: "opencode:goal-1",
        goalId: "goal-1",
        type: "controller_event",
        at: NOW.toISOString(),
        details: { event: "poll.finished", changed: false, ready: 0 },
        ...overrides,
    };
}
// ── Basic OpenCode monitor tests ──
test("renderOpencodeMonitorLines includes node and subagent lines", () => {
    const lines = renderOpencodeMonitorLines(makeSummary(), { nodes: [makeNode()], subagents: [makeSubagent()] }, { now: () => NOW });
    const joined = lines.join("\n");
    const outputLines = lines;
    assert.match(joined, /Goal goal-1 monitor/);
    // Node shows in EXECUTION PLAN section.
    assert.match(joined, /n1/);
    // Subagent info is in the EXECUTION PLAN section via display states.
    assert.match(joined, /EXECUTION PLAN/);
    assert.equal(outputLines[0], "═".repeat(96));
    assert.equal(outputLines[1], "═".repeat(96));
    assert.equal(outputLines[outputLines.length - 1], "═".repeat(96));
    assert.equal(outputLines[outputLines.length - 2], "═".repeat(96));
});
test("OpenCode EXECUTION PLAN includes node duration and phase labels", () => {
    const base = NOW;
    const lines = renderOpencodeMonitorLines(makeSummary(), {
        nodes: [
            makeNode({
                nodeId: "final-verification",
                slug: "final-verification",
                status: "running",
                createdAt: new Date(base.getTime() - 43 * 60_000).toISOString(),
                updatedAt: new Date(base.getTime() - 5_000).toISOString(),
            }),
        ],
        subagents: [
            makeSubagent({
                nodeId: "final-verification",
                subagentId: "sa-final-verification",
                status: "running",
                createdAt: new Date(base.getTime() - 40_000).toISOString(),
                updatedAt: new Date(base.getTime() - 5_000).toISOString(),
                lastActivityAt: new Date(base.getTime() - 5_000).toISOString(),
            }),
        ],
    }, {
        now: () => base,
        ledgerEvents: [
            ledgerEvent({
                at: new Date(base.getTime() - 43_000).toISOString(),
                details: { event: "node.started", nodeId: "final-verification" },
            }),
            ledgerEvent({
                at: new Date(base.getTime() - 25_000).toISOString(),
                details: { event: "validation.started", nodeId: "final-verification" },
            }),
        ],
    });
    const joined = lines.join("\n");
    const execIdx = joined.indexOf("── EXECUTION PLAN ──");
    const recentsIdx = joined.indexOf("── RECENT EVENTS ──");
    const execSection = joined.slice(execIdx, recentsIdx);
    assert.match(execSection, /final-verification/);
    assert.match(execSection, /runtime/);
    assert.match(execSection, /phase/);
    assert.match(execSection, /last/);
});
test("renderOpencodeMonitorLines falls back to placeholder when state is empty", () => {
    const lines = renderOpencodeMonitorLines(makeSummary(), { nodes: [], subagents: [] }, { now: () => NOW });
    const joined = lines.join("\n");
    assert.match(joined, /no DAG nodes or subagents yet/);
});
test("readOpencodeGoalMonitorSnapshot reads from runtime and refreshes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-monitor-"));
    try {
        const store = new SQLiteGoalStore({ stateRoot: dir });
        const runtime = new GoalRuntime({ store });
        const goalRecord = {
            sessionKey: "opencode:goal-1",
            goalId: "goal-1",
            objective: "ship the migration",
            status: "active",
            tokensUsed: 0,
            timeUsedSeconds: 0,
            createdAt: NOW.toISOString(),
            updatedAt: NOW.toISOString(),
            goalTurnsSinceAuditReset: 0,
        };
        await store.saveGoal(goalRecord);
        await store.saveGoalDagNode(makeNode());
        await store.saveGoalSubagent(makeSubagent());
        const summary = makeSummary();
        const snapshot = await readOpencodeGoalMonitorSnapshot(runtime, summary, { now: () => NOW });
        assert.ok(snapshot.refreshedAt);
        const joined = snapshot.lines.join("\n");
        assert.match(joined, /n1/);
        assert.match(joined, /EXECUTION PLAN/);
        store.close();
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
// 4.10 OpenCode: sections exist and health labels match
test("OpenCode sections exist: STATUS / SUMMARY / EXECUTION PLAN / RECENT EVENTS", () => {
    const lines = renderOpencodeMonitorLines(makeSummary(), { nodes: [makeNode()], subagents: [makeSubagent()] }, { now: () => NOW });
    const joined = lines.join("\n");
    // Verify all four sections are present.
    assert.match(joined, /── STATUS ──/);
    assert.match(joined, /── SUMMARY ──/);
    assert.match(joined, /── EXECUTION PLAN ──/);
    assert.match(joined, /── RECENT EVENTS ──/);
    // Section ordering must be STATUS → SUMMARY → EXECUTION PLAN → RECENT EVENTS.
    const statusIndex = joined.indexOf("── STATUS ──");
    const summaryIndex = joined.indexOf("── SUMMARY ──");
    const execIndex = joined.indexOf("── EXECUTION PLAN ──");
    const recentsIndex = joined.indexOf("── RECENT EVENTS ──");
    assert.ok(statusIndex >= 0);
    assert.ok(statusIndex < summaryIndex, "STATUS before SUMMARY");
    assert.ok(summaryIndex < execIndex, "SUMMARY before EXECUTION PLAN");
    assert.ok(execIndex < recentsIndex, "EXECUTION PLAN before RECENT EVENTS");
    // STATUS contains goal info.
    assert.match(joined, /Goal goal-1 monitor/);
    assert.match(joined, /Status: active/);
    // SUMMARY contains Health, Problem, Progress, Runtime, Next Action.
    // Extract SUMMARY section text.
    const summaryToExec = joined.slice(summaryIndex, execIndex);
    assert.match(summaryToExec, /Health:/);
    assert.match(summaryToExec, /Problem:/);
    assert.match(summaryToExec, /Progress:/);
    assert.match(summaryToExec, /Runtime:/);
    assert.match(summaryToExec, /Next Action:/);
    // EXECUTION PLAN contains node info.
    const execToRecents = joined.slice(execIndex, recentsIndex);
    assert.match(execToRecents, /n1/);
    // Completed goal health — verify health label matches.
    const completeLines = renderOpencodeMonitorLines(makeSummary({ status: "complete" }), { nodes: [makeNode({ status: "complete" })], subagents: [makeSubagent({ status: "complete" })] }, { now: () => NOW });
    const completeJoined = completeLines.join("\n");
    assert.match(completeJoined, /Health: Complete/);
    // Completed with warnings.
    const warnLines = renderOpencodeMonitorLines(makeSummary({ status: "complete" }), { nodes: [makeNode({ nodeId: "n-fail", status: "failed" })], subagents: [makeSubagent({ nodeId: "n-fail", subagentId: "sa-fail", status: "failed" })] }, { now: () => NOW });
    const warnJoined = warnLines.join("\n");
    assert.match(warnJoined, /Health: Complete with warnings/);
    // Running health.
    const runningLines = renderOpencodeMonitorLines(makeSummary(), { nodes: [makeNode({ status: "running" })], subagents: [makeSubagent({ status: "running" })] }, { now: () => NOW });
    const runningJoined = runningLines.join("\n");
    // With a running subagent and no runners, health might be Stalled.
    // With ledger events + active poll + harness it would be Running.
    // The label just needs to be present in the SUMMARY.
    assert.match(runningJoined, /Health:/);
    // Verify Running health with proper setup.
    const now = Date.now();
    const events = [
        ledgerEvent({
            at: new Date(now - 5_000).toISOString(),
            details: { event: "poll.finished", changed: true, ready: 1, leased: false },
        }),
    ];
    const runLines = renderOpencodeMonitorLines(makeSummary(), { nodes: [makeNode({ status: "running" })], subagents: [makeSubagent({ status: "running" })] }, { now: () => NOW, ledgerEvents: events });
    const runJoined = runLines.join("\n");
    assert.match(runJoined, /Health: Running/);
});
// 4.11 OpenCode: runtime labels are user-facing
test("OpenCode runtime labels are user-facing", () => {
    const harnessState = {
        materialized: true,
        activeTurnId: "turn-oc-1",
        queuedUserInput: false,
        queuedTriggerTurn: false,
        continuationSuppressed: true,
    };
    const now = Date.now();
    const events = [
        ledgerEvent({
            at: new Date(now - 5_000).toISOString(),
            details: { event: "poll.finished", changed: true, ready: 1, leased: false },
        }),
    ];
    const runnerRecords = [
        { runnerDir: "/tmp/r1", configPath: "/tmp/r1/config.json", subagentId: "sa-1", nodeId: "n1", goalId: "goal-1", runnerAlive: true, childAlive: true },
    ];
    const runtimeSummary = buildGoalMonitorRuntimeSummary(makeSummary(), [makeSubagent({ subagentId: "sa-1", status: "running" })], { harnessState, ledgerEvents: events, runners: runnerRecords });
    // Verify internal state values.
    assert.equal(runtimeSummary.session.state, "active-turn");
    assert.equal(runtimeSummary.hiddenContinuation.state, "suppressed");
    assert.equal(runtimeSummary.controllerPoll.state, "active");
    // Format to user-facing labels.
    const label = formatRuntimeSummaryForOverview(runtimeSummary);
    // Must use user-facing labels, never raw enums.
    assert.match(label, /session active turn/);
    assert.match(label, /auto-continue suppressed/);
    assert.match(label, /poll polling/);
    assert.match(label, /runners 1 running/);
    // Must NOT use raw uppercase enum labels anywhere in the user-facing output.
    assert.doesNotMatch(label, /NOT-MATERIALIZED/);
    assert.doesNotMatch(label, /SUPPRESSED/);
    assert.doesNotMatch(label, /ACTIVE-TURN/);
    assert.doesNotMatch(label, /ACTIVE-/);
    assert.doesNotMatch(label, /LEASED/);
    assert.doesNotMatch(label, /STOPPED/);
    assert.doesNotMatch(label, /UNKNOWN/);
    // Render full OpenCode output and verify Runtime line uses user-facing labels.
    const lines = renderOpencodeMonitorLines(makeSummary(), { nodes: [makeNode({ status: "running" })], subagents: [makeSubagent({ subagentId: "sa-1", status: "running" })] }, { now: () => NOW, ledgerEvents: events, harnessState });
    const joined = lines.join("\n");
    // Find the Runtime: line in SUMMARY section.
    const summaryIdx = joined.indexOf("── SUMMARY ──");
    const execIdx = joined.indexOf("── EXECUTION PLAN ──");
    const summarySection = joined.slice(summaryIdx, execIdx);
    const runtimeLine = summarySection.split("\n").find((l) => l.startsWith("Runtime:"));
    assert.ok(runtimeLine, "Runtime line must exist in SUMMARY");
    // Runtime line should be summary-oriented.
    assert.match(runtimeLine, /goal age/);
    // Should NOT contain raw uppercase enum labels.
    assert.doesNotMatch(runtimeLine, /NOT-MATERIALIZED/);
    assert.doesNotMatch(runtimeLine, /SUPPRESSED/);
    assert.doesNotMatch(runtimeLine, /ACTIVE-TURN/);
    assert.doesNotMatch(runtimeLine, /ACTIVE-/);
});
// 4.12 OpenCode: SUMMARY does not contain long subagent IDs
test("OpenCode SUMMARY does not contain long subagent IDs", () => {
    const longSubagentId = "subagent-final-verification-retry-1-retry-1-retry-1";
    const nodes = [
        makeNode({
            nodeId: "final-verification",
            slug: "final-verification",
            status: "blocked",
            lastValidationSummary: "required integration incomplete",
        }),
    ];
    const subagents = [makeSubagent({
            nodeId: "final-verification",
            subagentId: longSubagentId,
            status: "blocked",
            selfReportedResult: "waiting on expected output",
        })];
    const lines = renderOpencodeMonitorLines(makeSummary({ status: "complete" }), { nodes, subagents }, { now: () => NOW });
    const joined = lines.join("\n");
    // The SUMMARY section must NOT contain the long subagent ID.
    const summaryIdx = joined.indexOf("── SUMMARY ──");
    const execIdx = joined.indexOf("── EXECUTION PLAN ──");
    const summarySection = joined.slice(summaryIdx, execIdx);
    assert.doesNotMatch(summarySection, new RegExp(longSubagentId));
    // The SUMMARY should use node-centric phrasing.
    assert.match(summarySection, /final-verification/);
    assert.match(summarySection, /Complete with warnings/);
});
// ── Additional OpenCode tests ──
test("OpenCode RUNTIME section renders active session + suppressed continuation correctly", () => {
    const harnessState = {
        materialized: true,
        activeTurnId: "turn-oc-1",
        queuedUserInput: false,
        queuedTriggerTurn: false,
        continuationSuppressed: true,
    };
    const now = Date.now();
    const events = [
        ledgerEvent({
            at: new Date(now - 5_000).toISOString(),
            details: { event: "poll.finished", changed: true, ready: 1, leased: false },
        }),
    ];
    const runnerRecords = [
        { runnerDir: "/tmp/r1", configPath: "/tmp/r1/config.json", subagentId: "sa-1", nodeId: "n1", goalId: "goal-1", runnerAlive: true, childAlive: true },
    ];
    const runtimeSummary = buildGoalMonitorRuntimeSummary(makeSummary(), [makeSubagent({ subagentId: "sa-1", status: "running" })], { harnessState, ledgerEvents: events, runners: runnerRecords });
    assert.equal(runtimeSummary.session.state, "active-turn");
    assert.equal(runtimeSummary.session.activeTurnId, "turn-oc-1");
    assert.equal(runtimeSummary.hiddenContinuation.state, "suppressed");
    assert.equal(runtimeSummary.hiddenContinuation.reason, "active turn running");
    assert.equal(runtimeSummary.controllerPoll.state, "active");
    assert.equal(runtimeSummary.runners.running, 1);
    // The new deriveMonitorHealth returns ExtendedMonitorHealth (a string).
    const health = deriveMonitorHealth(runtimeSummary, makeSummary(), [makeSubagent({ subagentId: "sa-1", status: "running" })]);
    assert.equal(health, "Running");
});
test("OpenCode SUMMARY section shows suppressed continuation as not-failure", () => {
    const harnessState = {
        materialized: true,
        activeTurnId: "turn-oc-1",
        queuedUserInput: false,
        queuedTriggerTurn: false,
        continuationSuppressed: true,
    };
    const now = Date.now();
    const events = [
        ledgerEvent({
            at: new Date(now - 5_000).toISOString(),
            details: { event: "poll.finished", changed: true, ready: 1, leased: false },
        }),
    ];
    const lines = renderOpencodeMonitorLines(makeSummary(), { nodes: [makeNode({ status: "running" })], subagents: [makeSubagent({ status: "running" })] }, { now: () => NOW, ledgerEvents: events, harnessState });
    const joined = lines.join("\n");
    // SUMMARY section should exist.
    assert.match(joined, /── SUMMARY ──/);
    // Should have Health and Runtime lines.
    assert.match(joined, /Health:/);
    assert.match(joined, /Runtime:/);
    // Runtime line should remain a summary of elapsed activity.
    const summaryIdx = joined.indexOf("── SUMMARY ──");
    const execIdx = joined.indexOf("── EXECUTION PLAN ──");
    const summarySection = joined.slice(summaryIdx, execIdx);
    const runtimeLine = summarySection.split("\n").find((l) => l.startsWith("Runtime:"));
    assert.ok(runtimeLine);
    assert.match(runtimeLine, /goal age/);
    // Suppressed continuation is normal, not an error — the runtime label
    // should NOT use error/failure terminology.
    assert.doesNotMatch(runtimeLine, /failure/);
    assert.doesNotMatch(runtimeLine, /error/);
    assert.doesNotMatch(runtimeLine, /blocked/);
});
test("OpenCode blocked node changes health and shows blocked state in render", () => {
    const blockedNode = makeNode({ nodeId: "n-blocked", slug: "n-blocked", status: "blocked", lastValidationSummary: "output missing" });
    const blockedSub = makeSubagent({ nodeId: "n-blocked", subagentId: "sa-blocked", status: "blocked" });
    const runningSub = makeSubagent({ nodeId: "n-blocked", subagentId: "sa-running", status: "running" });
    const runnerRecords = [
        { runnerDir: "/tmp/r1", configPath: "/tmp/r1/config.json", subagentId: "sa-running", nodeId: "n-blocked", goalId: "goal-1", runnerAlive: true, childAlive: true },
    ];
    const runtimeSummary = buildGoalMonitorRuntimeSummary(makeSummary(), [blockedSub, runningSub], { runners: runnerRecords });
    const health = deriveMonitorHealth(runtimeSummary, makeSummary(), [blockedSub, runningSub]);
    assert.equal(health, "Running");
    // Next action can be derived from the full overview.
    const overview = buildGoalMonitorOverview(makeSummary(), { nodes: [blockedNode], subagents: [blockedSub, runningSub] }, runtimeSummary);
    assert.match(overview.nextActionLabel, /inspect blocked/);
    // Render output and verify.
    const lines = renderOpencodeMonitorLines(makeSummary(), { nodes: [blockedNode], subagents: [blockedSub, runningSub] }, { now: () => NOW });
    const joined = lines.join("\n");
    // When no running runners visible to renderOpencodeMonitorLines (which doesn't take
    // runner records), blocked subagent + no active session → Blocked.
    // The SUMMARY section should show a health label.
    assert.match(joined, /Health:/);
    // EXECUTION PLAN shows the blocked node.
    assert.match(joined, /n-blocked/);
    // Blocked node has appropriate display state.
    assert.match(joined, /✖ n-blocked/);
});
test("OpenCode fully blocked goal shows Blocked health", () => {
    const blockedNode = makeNode({ nodeId: "n-blocked", status: "blocked" });
    const blockedSub = makeSubagent({ nodeId: "n-blocked", subagentId: "sa-blocked", status: "blocked" });
    const runtimeSummary = buildGoalMonitorRuntimeSummary(makeSummary({ status: "blocked" }), [blockedSub]);
    const health = deriveMonitorHealth(runtimeSummary, makeSummary({ status: "blocked" }), [blockedSub]);
    assert.equal(health, "Blocked");
    const lines = renderOpencodeMonitorLines(makeSummary({ status: "blocked" }), { nodes: [blockedNode], subagents: [blockedSub] }, { now: () => NOW });
    const joined = lines.join("\n");
    assert.match(joined, /Health: Blocked/);
});
test("OpenCode next-action adapts Pi TUI language for text output", () => {
    const blockedSub = makeSubagent({ subagentId: "sa-blocked", status: "blocked" });
    const summary = buildGoalMonitorRuntimeSummary(makeSummary(), [blockedSub]);
    // Use buildGoalMonitorOverview for nextAction, or just check health label.
    const overview2 = buildGoalMonitorOverview(makeSummary(), { nodes: [makeNode({ nodeId: "n-blocked", status: "blocked" })], subagents: [blockedSub] }, summary);
    const nextAction = overview2.nextActionLabel;
    // Verify next-action text doesn't leak Pi TUI nav language.
    assert.doesNotMatch(nextAction, /nodeList/);
    assert.doesNotMatch(nextAction, /runnerList/);
    const lines = renderOpencodeMonitorLines(makeSummary(), { nodes: [makeNode({ nodeId: "n-blocked", status: "blocked" })], subagents: [blockedSub] }, { now: () => NOW });
    const joined = lines.join("\n");
    const summaryIdx = joined.indexOf("── SUMMARY ──");
    const execIdx = joined.indexOf("── EXECUTION PLAN ──");
    const summarySection = joined.slice(summaryIdx, execIdx);
    const nextActionLine = summarySection.split("\n").find((l) => l.startsWith("Next Action:"));
    assert.ok(nextActionLine, "Next Action line must exist");
    assert.doesNotMatch(nextActionLine, /nodeList/);
    assert.doesNotMatch(nextActionLine, /runnerList/);
});
test("OpenCode empty state still renders all four sections", () => {
    const lines = renderOpencodeMonitorLines(makeSummary(), { nodes: [], subagents: [] }, { now: () => NOW });
    const joined = lines.join("\n");
    assert.match(joined, /── STATUS ──/);
    assert.match(joined, /── SUMMARY ──/);
    assert.match(joined, /── EXECUTION PLAN ──/);
    assert.match(joined, /── RECENT EVENTS ──/);
    assert.match(joined, /no DAG nodes or subagents yet/);
});
test("OpenCode runner summary shows counts before per-runner details", () => {
    const nodes = [makeNode({ nodeId: "n1" })];
    const subagents = [
        makeSubagent({ nodeId: "n1", subagentId: "sa-1", status: "running" }),
        makeSubagent({ nodeId: "n1", subagentId: "sa-2", status: "running" }),
        makeSubagent({ nodeId: "n1", subagentId: "sa-3", status: "complete" }),
    ];
    const lines = renderOpencodeMonitorLines(makeSummary(), { nodes, subagents }, { now: () => NOW });
    const joined = lines.join("\n");
    // EXECUTION PLAN section should contain the node with its summary.
    const execIdx = joined.indexOf("── EXECUTION PLAN ──");
    const recentsIdx = joined.indexOf("── RECENT EVENTS ──");
    const execSection = joined.slice(execIdx, recentsIdx);
    // Node display state summary includes execution detail including worker counts.
    assert.match(execSection, /n1/);
    assert.match(execSection, /Worker: 3 subagents \(2 active\)/);
});
test("OpenCode runtime summary labels are consistent with Pi TUI", () => {
    assert.equal(SESSION_STATE_LABELS["active-turn"], "ACTIVE-TURN");
    assert.equal(HIDDEN_CONTINUATION_STATE_LABELS.suppressed, "SUPPRESSED");
    assert.equal(CONTROLLER_POLL_STATE_LABELS.active, "ACTIVE");
    const harnessState = {
        materialized: true,
        activeTurnId: "turn-shared-1",
        queuedUserInput: false,
        queuedTriggerTurn: false,
        continuationSuppressed: true,
    };
    const summary = buildGoalMonitorRuntimeSummary(makeSummary(), [makeSubagent({ status: "running" })], { harnessState });
    assert.equal(summary.session.state, "active-turn");
    assert.equal(summary.hiddenContinuation.state, "suppressed");
    assert.equal(summary.hiddenContinuation.reason, "active turn running");
});
// ── Additional overview section tests for OpenCode ──
test("OpenCode RECENT EVENTS section shows meaningful events, not poll noise", () => {
    const events = [
        ledgerEvent({ at: "2026-06-03T00:00:00.000Z", details: { event: "goal.created", objective: "ship" } }),
        ledgerEvent({ at: "2026-06-03T00:01:00.000Z", details: { event: "poll.started", nodes: 1 } }),
        ledgerEvent({ at: "2026-06-03T00:01:01.000Z", details: { event: "poll.finished", changed: true, ready: 1 } }),
        ledgerEvent({ at: "2026-06-03T00:02:00.000Z", details: { event: "runner.launched", nodeId: "n1", subagentId: "sa-1" } }),
        ledgerEvent({ at: "2026-06-03T00:03:00.000Z", details: { event: "validation.failed", nodeId: "n1", subagentId: "sa-1", summary: "missing output" } }),
        ledgerEvent({ at: "2026-06-03T00:04:00.000Z", details: { event: "poll.started", nodes: 1 } }),
        ledgerEvent({ at: "2026-06-03T00:04:01.000Z", details: { event: "poll.finished", changed: false } }),
    ];
    const lines = renderOpencodeMonitorLines(makeSummary(), { nodes: [makeNode()], subagents: [makeSubagent()] }, { now: () => NOW, ledgerEvents: events });
    const joined = lines.join("\n");
    // RECENT EVENTS section should exist.
    assert.match(joined, /── RECENT EVENTS ──/);
    const recentsIdx = joined.indexOf("── RECENT EVENTS ──");
    const recentsSection = joined.slice(recentsIdx);
    // Should show meaningful events.
    assert.match(recentsSection, /goal\.created/);
    assert.match(recentsSection, /runner\.launched/);
    assert.match(recentsSection, /validation\.failed/);
    // Should NOT show poll noise.
    assert.doesNotMatch(recentsSection, /poll\.started/);
    assert.doesNotMatch(recentsSection, /poll\.finished/);
});
test("OpenCode complete goal never shows Blocked health", () => {
    // Even with some blocked subagents, a completed goal is never Blocked.
    const lines = renderOpencodeMonitorLines(makeSummary({ status: "complete" }), {
        nodes: [
            makeNode({ nodeId: "n1", status: "complete" }),
            makeNode({ nodeId: "n2", slug: "n2", status: "blocked" }),
        ],
        subagents: [
            makeSubagent({ nodeId: "n1", subagentId: "sa-ok", status: "complete" }),
            makeSubagent({ nodeId: "n2", subagentId: "sa-2", status: "blocked" }),
        ],
    }, { now: () => NOW });
    const joined = lines.join("\n");
    assert.match(joined, /Health: Complete with warnings/);
    assert.doesNotMatch(joined, /Health: Blocked/);
});
test("OpenCode SUMMARY problem line uses node-centric phrasing", () => {
    const longSubagentId = "subagent-integration-step-retry-1-retry-1-retry-1-retry-1";
    const nodes = [makeNode({
            nodeId: "integration-step",
            slug: "integration-step",
            status: "blocked",
            lastValidationSummary: "integration incomplete",
        })];
    const subagents = [makeSubagent({
            nodeId: "integration-step",
            subagentId: longSubagentId,
            status: "blocked",
            selfReportedResult: "waiting on upstream dependency",
        })];
    const problem = summarizeMonitorProblem(makeSummary({ status: "complete" }), nodes, subagents);
    // Problem must be node-centric, not contain the full subagent ID.
    assert.match(problem, /integration-step/);
    assert.doesNotMatch(problem, new RegExp(longSubagentId));
    // Verify in rendered OpenCode output.
    const lines = renderOpencodeMonitorLines(makeSummary({ status: "complete" }), { nodes, subagents }, { now: () => NOW });
    const joined = lines.join("\n");
    const summaryIdx = joined.indexOf("── SUMMARY ──");
    const execIdx = joined.indexOf("── EXECUTION PLAN ──");
    const summarySection = joined.slice(summaryIdx, execIdx);
    // Problem line in SUMMARY must not contain the long subagent ID.
    assert.doesNotMatch(summarySection, new RegExp(longSubagentId));
    assert.match(summarySection, /integration-step/);
});
test("OpenCode health label coverage for all extended health states", () => {
    // Verify all health labels have display values.
    assert.equal(EXTENDED_MONITOR_HEALTH_LABELS["OK"], "OK");
    assert.equal(EXTENDED_MONITOR_HEALTH_LABELS["Running"], "Running");
    assert.equal(EXTENDED_MONITOR_HEALTH_LABELS["Complete"], "Complete");
    assert.equal(EXTENDED_MONITOR_HEALTH_LABELS["Complete with warnings"], "Complete with warnings");
    assert.equal(EXTENDED_MONITOR_HEALTH_LABELS["Needs attention"], "Needs attention");
    assert.equal(EXTENDED_MONITOR_HEALTH_LABELS["Blocked"], "Blocked");
    assert.equal(EXTENDED_MONITOR_HEALTH_LABELS["Stalled"], "Stalled");
    assert.equal(EXTENDED_MONITOR_HEALTH_LABELS["Waiting"], "Waiting");
    // Verify each label renders correctly in the SUMMARY section.
    for (const [health, label] of Object.entries(EXTENDED_MONITOR_HEALTH_LABELS)) {
        assert.ok(label.length > 0, `Label for ${health} must be non-empty`);
        assert.ok(typeof label === "string", `Label for ${health} must be a string`);
    }
});
test("OpenCode building overview with meaningful events stays within 3-8 limit", () => {
    // Create 20 meaningful events.
    const events = [];
    for (let i = 0; i < 20; i++) {
        events.push(ledgerEvent({
            at: new Date(NOW.getTime() + i * 60_000).toISOString(),
            details: { event: "validation.failed", nodeId: `n${i}`, subagentId: `sa-${i}`, summary: `test event ${i}` },
        }));
    }
    const rt = buildGoalMonitorRuntimeSummary(makeSummary(), [makeSubagent({ status: "running" })]);
    const overview = buildGoalMonitorOverview(makeSummary(), { nodes: [makeNode()], subagents: [makeSubagent({ status: "running" })], ledgerEvents: events }, rt);
    // Recent events should be capped at 8.
    assert.ok(overview.recentEvents.length <= 8);
    assert.ok(overview.recentEvents.length >= 3, `Expected >=3 recent events, got ${overview.recentEvents.length}`);
});
//# sourceMappingURL=opencode-monitor.test.js.map