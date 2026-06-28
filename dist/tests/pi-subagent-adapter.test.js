import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiHarnessSubagentAdapter, readPiSubagentSessionState, renderPiSubagentInitialPrompt, } from "../adapters/pi/index.js";
import { launchPiRpcBackgroundGoalSession } from "../adapters/pi/background-session.js";
const now = "2026-06-02T00:00:00.000Z";
function node(overrides = {}) {
    return {
        goalId: "goal-1",
        nodeId: "attendance",
        slug: "attendance",
        objective: "Implement attendance DocTypes",
        scope: "people-frappe attendance",
        dependencyNodeIds: [],
        expectedOutputs: ["attendance.json"],
        validators: ["npm test"],
        validation: { allowedPaths: ["apps/attendance/**"], forbiddenPaths: ["package-lock.json"] },
        completionGates: ["controller-validation"],
        status: "ready",
        createdAt: now,
        updatedAt: now,
        ...overrides,
    };
}
function subagent(overrides = {}) {
    return {
        goalId: "goal-1",
        nodeId: "attendance",
        subagentId: "subagent-1",
        harnessAdapterId: "pi",
        sessionId: "session-subagent-1",
        sessionFile: "/tmp/session.jsonl",
        workspacePath: "/repo/.worktrees/attendance",
        branch: "feat/attendance",
        status: "idle",
        prompts: ["initial"],
        createdAt: now,
        updatedAt: now,
        ...overrides,
    };
}
function fakeLauncher() {
    const launches = [];
    const prompts = [];
    const stopped = [];
    const launcher = async (request) => {
        launches.push(request);
        const sessionId = request.sessionId ?? "resumed-session";
        return {
            sessionId,
            sessionFile: request.sessionFile ?? `/sessions/${sessionId}.jsonl`,
            setSessionName: async () => undefined,
            sendPrompt: async (prompt) => {
                prompts.push(prompt);
            },
            stop: () => stopped.push(sessionId),
        };
    };
    return { launcher, launches, prompts, stopped };
}
test("Pi background session launcher rejects missing workspaces before spawning", async () => {
    const missing = join(tmpdir(), `goal-runner-missing-${Date.now()}`);
    await assert.rejects(launchPiRpcBackgroundGoalSession({ cwd: missing, sessionId: "missing-cwd", sessionName: "missing cwd" }), /cwd does not exist/);
});
test("Pi harness subagent adapter starts a detached Pi session and sends the initial prompt", async () => {
    const { launcher, launches, prompts } = fakeLauncher();
    const adapter = new PiHarnessSubagentAdapter({ launcher, modelArg: "test/model", now: () => new Date(now) });
    const result = await adapter.startSession({
        goalId: "goal-1",
        node: node(),
        subagentId: "subagent-1",
        cwd: "/repo/.worktrees/attendance",
        branch: "feat/attendance",
        systemPrompt: "system guardrails",
        initialPrompt: "create attendance doctypes",
        metadata: { sessionName: "custom subagent" },
    });
    assert.equal(launches.length, 1);
    assert.equal(launches[0]?.cwd, "/repo/.worktrees/attendance");
    assert.equal(launches[0]?.sessionId, "subagent-subagent-1");
    assert.equal(launches[0]?.sessionName, "custom subagent");
    assert.equal(launches[0]?.modelArg, "test/model");
    assert.equal(result.sessionId, "subagent-subagent-1");
    assert.equal(result.status, "running");
    assert.equal(result.workspacePath, "/repo/.worktrees/attendance");
    assert.match(prompts[0] ?? "", /system guardrails/);
    assert.match(prompts[0] ?? "", /SUBAGENT_RESULT/);
    assert.match(prompts[0] ?? "", /CONTROLLER EXECUTION POLICY/);
    assert.match(prompts[0] ?? "", /Allowed changed paths: apps\/attendance\/\*\*/);
    assert.match(prompts[0] ?? "", /Forbidden changed paths: package-lock\.json/);
    assert.match(prompts[0] ?? "", /create attendance doctypes/);
});
test("Pi harness subagent adapter includes quality profile discipline in initial prompt", () => {
    const prompt = renderPiSubagentInitialPrompt({
        goalId: "goal-1",
        node: node({ qualityProfiles: ["incremental-implementation", "docs-required", "ship-preflight"] }),
        subagentId: "subagent-1",
        cwd: "/repo/.worktrees/attendance",
        initialPrompt: "implement quality-profiled node",
    });
    assert.match(prompt, /QUALITY PROFILE EXECUTION DISCIPLINE/);
    assert.match(prompt, /incremental-implementation, docs-required, ship-preflight/);
    assert.match(prompt, /smallest independently verifiable slice/);
    assert.match(prompt, /required documentation/);
    assert.match(prompt, /release-readiness/);
});
test("Pi harness subagent adapter rejects and stops the handle when initial prompt dispatch fails", async () => {
    const stopped = [];
    const launcher = async () => ({
        sessionId: "failed-session",
        sessionFile: "/sessions/failed-session.jsonl",
        setSessionName: async () => undefined,
        sendPrompt: async () => {
            throw new Error("detached background Pi runner stopped before creating session file");
        },
        stop: () => stopped.push("failed-session"),
    });
    const adapter = new PiHarnessSubagentAdapter({ launcher, now: () => new Date(now) });
    await assert.rejects(adapter.startSession({
        goalId: "goal-1",
        node: node(),
        subagentId: "subagent-1",
        cwd: "/repo/.worktrees/attendance",
        initialPrompt: "initial",
    }), /stopped before creating session file/);
    assert.deepEqual(stopped, ["failed-session"]);
});
test("Pi harness subagent adapter honors controller-prepared resources", async () => {
    const { launcher, launches } = fakeLauncher();
    const adapter = new PiHarnessSubagentAdapter({ launcher, modelArg: "fallback/model", now: () => new Date(now) });
    const result = await adapter.startSession({
        goalId: "goal-1",
        node: node(),
        subagentId: "subagent-1",
        cwd: "/legacy/worktree",
        branch: "legacy/branch",
        initialPrompt: "create attendance doctypes",
        preparedResources: {
            workspacePath: "/repo/.worktrees/prepared",
            branch: "goal/prepared",
            sessionId: "prepared-session",
            sessionFile: "/sessions/prepared.jsonl",
            modelArg: "prepared/model",
        },
    });
    assert.equal(launches[0]?.cwd, "/repo/.worktrees/prepared");
    assert.equal(launches[0]?.sessionId, "prepared-session");
    assert.equal(launches[0]?.sessionFile, "/sessions/prepared.jsonl");
    assert.equal(launches[0]?.modelArg, "prepared/model");
    assert.equal(result.workspacePath, "/repo/.worktrees/prepared");
    assert.equal(result.branch, "goal/prepared");
});
test("Pi harness subagent adapter sanitizes truncated session ids for Pi", async () => {
    const { launcher, launches } = fakeLauncher();
    const adapter = new PiHarnessSubagentAdapter({ launcher, now: () => new Date(now) });
    await adapter.startSession({
        goalId: "goal-1",
        node: node(),
        subagentId: `${"a".repeat(54)}-tail`,
        cwd: "/repo/.worktrees/attendance",
        initialPrompt: "initial",
    });
    const sessionId = launches[0]?.sessionId ?? "";
    assert.equal(sessionId.length <= 64, true);
    assert.match(sessionId, /^[a-zA-Z0-9](?:[a-zA-Z0-9_.-]*[a-zA-Z0-9])?$/);
    assert.doesNotMatch(sessionId, /-$/);
});
test("Pi harness subagent adapter preserves uniqueness for long retry session ids", async () => {
    const { launcher, launches } = fakeLauncher();
    const adapter = new PiHarnessSubagentAdapter({ launcher, now: () => new Date(now) });
    const base = `${"subagent-standardize-attendance-punch-schedule-fallback".repeat(2)}`;
    await adapter.startSession({
        goalId: "goal-1",
        node: node(),
        subagentId: `${base}-retry-1`,
        cwd: "/repo/.worktrees/attendance",
        initialPrompt: "initial",
    });
    await adapter.startSession({
        goalId: "goal-1",
        node: node(),
        subagentId: `${base}-retry-2`,
        cwd: "/repo/.worktrees/attendance",
        initialPrompt: "initial",
    });
    const first = launches[0]?.sessionId ?? "";
    const second = launches[1]?.sessionId ?? "";
    assert.notEqual(first, second);
    assert.equal(first.length <= 64, true);
    assert.equal(second.length <= 64, true);
    assert.match(first, /retry-1$/);
    assert.match(second, /retry-2$/);
});
test("Pi harness subagent adapter treats missing session files as starting only while a runner is live", () => {
    const adapter = new PiHarnessSubagentAdapter({ now: () => new Date(now), runnerAlive: () => true });
    const state = adapter.getSessionState({
        subagent: subagent({
            status: "sessionStarted",
            sessionFile: "/tmp/not-yet-created.jsonl",
        }),
    });
    assert.equal(state.status, "starting");
    assert.match(state.error ?? "", /not found/);
});
test("Pi harness subagent adapter fails missing session files when no runner is live", () => {
    const adapter = new PiHarnessSubagentAdapter({ now: () => new Date(now), runnerAlive: () => false });
    const state = adapter.getSessionState({
        subagent: subagent({
            status: "running",
            sessionFile: "/tmp/not-created-and-runner-dead.jsonl",
        }),
    });
    assert.equal(state.status, "failed");
    assert.match(state.error ?? "", /session file not found/);
});
test("Pi harness subagent adapter does not treat an unverified in-memory handle as liveness", async () => {
    const { launcher } = fakeLauncher();
    const adapter = new PiHarnessSubagentAdapter({ launcher, now: () => new Date(now), runnerAlive: () => false });
    await adapter.startSession({ goalId: "goal-1", node: node(), subagentId: "subagent-1", cwd: "/repo/.worktrees/attendance", initialPrompt: "initial" });
    const state = adapter.getSessionState({
        subagent: subagent({ status: "running", sessionFile: "/sessions/subagent-subagent-1.jsonl" }),
    });
    assert.equal(state.status, "failed");
    assert.match(state.error ?? "", /session file not found/);
});
test("Pi harness subagent adapter resumes an existing session file for follow-up prompts", async () => {
    const { launcher, launches, prompts, stopped } = fakeLauncher();
    const adapter = new PiHarnessSubagentAdapter({ launcher, now: () => new Date(now) });
    await adapter.startSession({
        goalId: "goal-1",
        node: node(),
        subagentId: "subagent-1",
        cwd: "/repo/.worktrees/attendance",
        initialPrompt: "initial",
    });
    const firstSessionFile = "/sessions/subagent-subagent-1.jsonl";
    await adapter.sendPrompt({
        subagent: subagent({ sessionFile: firstSessionFile }),
        prompt: "fix validator failure",
    });
    assert.equal(launches.length, 2);
    assert.equal(launches[1]?.sessionFile, firstSessionFile);
    assert.equal(launches[1]?.cwd, "/repo/.worktrees/attendance");
    assert.deepEqual(prompts, [renderPiSubagentInitialPrompt({ goalId: "goal-1", node: node(), subagentId: "subagent-1", cwd: "/repo/.worktrees/attendance", initialPrompt: "initial" }), "fix validator failure"]);
    assert.deepEqual(stopped, ["subagent-subagent-1"]);
});
test("Pi subagent session inspection maps transcript markers to self-report states", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-subagent-state-"));
    const sessionFile = join(dir, "session.jsonl");
    try {
        writeFileSync(sessionFile, [
            JSON.stringify({ type: "session", cwd: "/repo", timestamp: "2026-06-02T00:00:00.000Z" }),
            JSON.stringify({ type: "message", message: { role: "user", content: "start" }, timestamp: "2026-06-02T00:00:01.000Z" }),
            JSON.stringify({
                type: "message",
                message: { role: "assistant", content: [{ type: "text", text: "Implemented files.\nSUBAGENT_RESULT: attendance doctypes added and tests passed" }] },
                timestamp: "2026-06-02T00:00:02.000Z",
            }),
        ].join("\n"));
        const state = readPiSubagentSessionState(subagent({ sessionFile }));
        assert.equal(state.status, "selfReportedComplete");
        assert.equal(state.selfReportedResult, "attendance doctypes added and tests passed");
        assert.equal(state.lastActivityAt, "2026-06-02T00:00:02.000Z");
        assert.deepEqual(state.metadata, { entryCount: 3, messageCount: 2 });
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("Pi subagent session inspection accepts markdown-decorated markers and rejects placeholders", () => {
    const decorated = readPiSubagentSessionState(subagent({ sessionFile: "/decorated" }), {
        exists: () => true,
        readFile: () => JSON.stringify({
            type: "message",
            message: { role: "assistant", content: "### **SUBAGENT_RESULT:** implemented runtime contracts and tests passed" },
            timestamp: now,
        }),
    });
    assert.equal(decorated.status, "selfReportedComplete");
    assert.equal(decorated.selfReportedResult, "implemented runtime contracts and tests passed");
    const placeholder = readPiSubagentSessionState(subagent({ sessionFile: "/placeholder" }), {
        exists: () => true,
        live: true,
        now: () => new Date(now),
        readFile: () => JSON.stringify({
            type: "message",
            message: { role: "assistant", content: "SUBAGENT_RESULT: <summary>" },
            timestamp: now,
        }),
    });
    assert.equal(placeholder.status, "idle");
    assert.equal(placeholder.selfReportedResult, undefined);
});
test("Pi subagent session inspection streams large files and skips runtime state mirrors", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-subagent-large-state-"));
    const sessionFile = join(dir, "session.jsonl");
    try {
        const hugeMirrorPayload = "x".repeat(256 * 1024);
        const rows = [
            JSON.stringify({ type: "message", message: { role: "user", content: "start" }, timestamp: "2026-06-02T00:00:00.000Z" }),
            JSON.stringify({
                type: "message",
                message: { role: "assistant", content: [{ type: "text", text: "SUBAGENT_RESULT: large session parsed without loading the whole transcript" }] },
                timestamp: "2026-06-02T00:00:01.000Z",
            }),
            ...Array.from({ length: 24 }, (_, index) => JSON.stringify({
                type: "custom",
                customType: "goal-runner-state",
                data: { index, payload: hugeMirrorPayload },
                timestamp: `2026-06-02T00:00:${String(index + 2).padStart(2, "0")}.000Z`,
            })),
        ];
        writeFileSync(sessionFile, rows.join("\n"));
        const state = readPiSubagentSessionState(subagent({ sessionFile }));
        assert.equal(state.status, "selfReportedComplete");
        assert.equal(state.selfReportedResult, "large session parsed without loading the whole transcript");
        assert.equal(state.lastActivityAt, "2026-06-02T00:00:01.000Z");
        assert.deepEqual(state.metadata, { entryCount: 26, messageCount: 2 });
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("Pi subagent session inspection asks for follow-up when pre-compaction error is followed by terminal text without marker", () => {
    const state = readPiSubagentSessionState(subagent({ sessionFile: "/session" }), {
        exists: () => true,
        readFile: () => [
            JSON.stringify({ type: "message", message: { role: "user", content: "start" }, timestamp: now }),
            JSON.stringify({
                type: "message",
                message: {
                    role: "assistant",
                    stopReason: "error",
                    errorMessage: "Codex error: context_length_exceeded: Your input exceeds the context window of this model.",
                    content: [],
                },
                timestamp: "2026-06-02T00:00:01.000Z",
            }),
            JSON.stringify({ type: "compaction", summary: "compacted", firstKeptEntryId: "u1", tokensBefore: 126835, timestamp: "2026-06-02T00:00:02.000Z" }),
            JSON.stringify({
                type: "message",
                message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Implemented files and verification passed, but missing explicit marker." }] },
                timestamp: "2026-06-02T00:00:03.000Z",
            }),
        ].join("\n"),
    });
    assert.equal(state.status, "needsFollowup");
    assert.equal(state.error, undefined);
    assert.match(state.selfReportedResult ?? "", /Implemented files/);
    assert.equal(state.lastActivityAt, "2026-06-02T00:00:03.000Z");
});
test("Pi subagent session inspection keeps live context-overflow errors running while Pi can compact", () => {
    const state = readPiSubagentSessionState(subagent({ sessionFile: "/session" }), {
        exists: () => true,
        live: true,
        now: () => new Date("2026-06-02T00:00:30.000Z"),
        readFile: () => [
            JSON.stringify({ type: "message", message: { role: "user", content: "start" }, timestamp: "2026-06-02T00:00:00.000Z" }),
            JSON.stringify({
                type: "message",
                message: {
                    role: "assistant",
                    stopReason: "error",
                    errorMessage: "Codex error: context_length_exceeded: Your input exceeds the context window of this model.",
                    content: [],
                },
                timestamp: "2026-06-02T00:00:01.000Z",
            }),
        ].join("\n"),
    });
    assert.equal(state.status, "running");
    assert.match(state.error ?? "", /context overflow recovery pending/i);
    assert.equal(state.lastActivityAt, "2026-06-02T00:00:01.000Z");
});
test("Pi subagent session inspection treats post-overflow compaction as recovery evidence", () => {
    const state = readPiSubagentSessionState(subagent({ sessionFile: "/session" }), {
        exists: () => true,
        live: true,
        now: () => new Date("2026-06-02T00:00:30.000Z"),
        readFile: () => [
            JSON.stringify({ type: "message", message: { role: "user", content: "start" }, timestamp: "2026-06-02T00:00:00.000Z" }),
            JSON.stringify({
                type: "message",
                message: {
                    role: "assistant",
                    stopReason: "error",
                    errorMessage: "Codex error: context_length_exceeded: Your input exceeds the context window of this model.",
                    content: [],
                },
                timestamp: "2026-06-02T00:00:01.000Z",
            }),
            JSON.stringify({ type: "compaction", summary: "compacted", firstKeptEntryId: "u1", tokensBefore: 126835, timestamp: "2026-06-02T00:00:02.000Z" }),
        ].join("\n"),
    });
    assert.equal(state.status, "running");
    assert.equal(state.error, undefined);
    assert.equal(state.lastActivityAt, "2026-06-02T00:00:02.000Z");
});
test("Pi subagent session inspection eventually fails stale context-overflow recovery without compaction", () => {
    const state = readPiSubagentSessionState(subagent({ sessionFile: "/session" }), {
        exists: () => true,
        live: true,
        now: () => new Date("2026-06-02T00:20:00.000Z"),
        staleAfterMs: 10 * 60_000,
        readFile: () => [
            JSON.stringify({ type: "message", message: { role: "user", content: "start" }, timestamp: "2026-06-02T00:00:00.000Z" }),
            JSON.stringify({
                type: "message",
                message: {
                    role: "assistant",
                    stopReason: "error",
                    errorMessage: "Codex error: context_length_exceeded: Your input exceeds the context window of this model.",
                    content: [],
                },
                timestamp: "2026-06-02T00:00:01.000Z",
            }),
        ].join("\n"),
    });
    assert.equal(state.status, "failed");
    assert.match(state.error ?? "", /context_length_exceeded/);
});
test("Pi subagent session inspection ignores runtime state mirror timestamps for stale context-overflow recovery", () => {
    const state = readPiSubagentSessionState(subagent({ sessionFile: "/session" }), {
        exists: () => true,
        live: true,
        now: () => new Date("2026-06-02T00:20:00.000Z"),
        staleAfterMs: 10 * 60_000,
        readFile: () => [
            JSON.stringify({ type: "message", message: { role: "user", content: "start" }, timestamp: "2026-06-02T00:00:00.000Z" }),
            JSON.stringify({
                type: "message",
                message: {
                    role: "assistant",
                    stopReason: "error",
                    errorMessage: "Codex error: context_length_exceeded: Your input exceeds the context window of this model.",
                    content: [],
                },
                timestamp: "2026-06-02T00:00:01.000Z",
            }),
            JSON.stringify({ type: "custom", customType: "goal-runner-state", data: { kind: "goal_subagent" }, timestamp: "2026-06-02T00:19:58.000Z" }),
            JSON.stringify({ type: "custom_message", customType: "agent-goal-runtime-state", data: { kind: "goal_subagent" }, timestamp: "2026-06-02T00:19:59.000Z" }),
        ].join("\n"),
    });
    assert.equal(state.status, "failed");
    assert.match(state.error ?? "", /context_length_exceeded/);
    assert.equal(state.lastActivityAt, "2026-06-02T00:00:01.000Z");
});
test("Pi subagent session inspection asks for follow-up when a live session is stale after a tool result", () => {
    const state = readPiSubagentSessionState(subagent({ sessionFile: "/stale" }), {
        exists: () => true,
        now: () => new Date("2026-06-02T00:20:00.000Z"),
        staleAfterMs: 10 * 60_000,
        live: true,
        readFile: () => [
            JSON.stringify({ type: "message", message: { role: "user", content: "start" }, timestamp: "2026-06-02T00:00:00.000Z" }),
            JSON.stringify({ type: "message", message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "git status" } }] }, timestamp: "2026-06-02T00:01:00.000Z" }),
            JSON.stringify({ type: "message", message: { role: "toolResult", toolCallId: "call-1", toolName: "bash", content: [{ type: "text", text: "ok" }] }, timestamp: "2026-06-02T00:01:30.000Z" }),
            JSON.stringify({ type: "custom", customType: "goal-runner-state", data: { kind: "reservation_cleared" }, timestamp: "2026-06-02T00:01:30.000Z" }),
        ].join("\n"),
    });
    assert.equal(state.status, "needsFollowup");
    assert.match(state.error ?? "", /stale-subagent-session/);
    assert.match(state.error ?? "", /role=toolResult/);
});
test("Pi subagent session inspection leaves recent assistant chatter idle but follows up after 10 minutes", () => {
    const transcript = [
        JSON.stringify({ type: "message", message: { role: "user", content: "start" }, timestamp: "2026-06-02T00:00:00.000Z" }),
        JSON.stringify({ type: "message", message: { role: "assistant", stopReason: "stop", content: [{ type: "thinking", thinking: "Let" }] }, timestamp: "2026-06-02T00:01:00.000Z" }),
    ].join("\n");
    const recent = readPiSubagentSessionState(subagent({ sessionFile: "/assistant-recent" }), {
        exists: () => true,
        now: () => new Date("2026-06-02T00:05:00.000Z"),
        staleAfterMs: 10 * 60_000,
        live: true,
        readFile: () => transcript,
    });
    assert.equal(recent.status, "idle");
    const stale = readPiSubagentSessionState(subagent({ sessionFile: "/assistant-stale" }), {
        exists: () => true,
        now: () => new Date("2026-06-02T00:12:00.000Z"),
        staleAfterMs: 10 * 60_000,
        live: true,
        readFile: () => transcript,
    });
    assert.equal(stale.status, "needsFollowup");
    assert.match(stale.error ?? "", /unresolved assistant message/);
    assert.match(stale.error ?? "", /SUBAGENT_RESULT\/SUBAGENT_BLOCKED/);
});
test("Pi subagent session inspection ignores stale assistant errors from earlier reused-session attempts", () => {
    const transcript = [
        JSON.stringify({ type: "message", message: { role: "user", content: "old prompt" }, timestamp: "2026-06-02T00:00:00.000Z" }),
        JSON.stringify({
            type: "message",
            message: { role: "assistant", stopReason: "error", errorMessage: "Connection error.", content: [] },
            timestamp: "2026-06-02T00:01:00.000Z",
        }),
        JSON.stringify({ type: "message", message: { role: "user", content: "recovery prompt" }, timestamp: "2026-06-02T00:20:00.000Z" }),
    ].join("\n");
    const state = readPiSubagentSessionState(subagent({
        sessionFile: "/reused-session-error",
        attemptId: "subagent-1-attempt-2",
        attemptStartedAt: "2026-06-02T00:20:00.000Z",
        attemptCursor: { at: "2026-06-02T00:20:00.000Z", source: "prompt-dispatch" },
        createdAt: "2026-06-02T00:00:00.000Z",
        lastActivityAt: "2026-06-02T00:20:00.000Z",
    }), {
        exists: () => true,
        now: () => new Date("2026-06-02T00:20:30.000Z"),
        live: true,
        readFile: () => transcript,
    });
    assert.equal(state.status, "running");
    assert.equal(state.error, undefined);
    assert.equal(state.metadata?.staleErrorIgnored, true);
});
test("Pi subagent session inspection ignores outcome markers from earlier reused-session attempts", () => {
    const transcript = [
        JSON.stringify({ type: "message", message: { role: "user", content: "old node" }, timestamp: "2026-06-02T00:00:00.000Z" }),
        JSON.stringify({ type: "message", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "SUBAGENT_RESULT: old node complete" }] }, timestamp: "2026-06-02T00:01:00.000Z" }),
    ].join("\n");
    const recentAttempt = subagent({
        sessionFile: "/reused-session",
        createdAt: "2026-06-02T00:20:00.000Z",
        lastActivityAt: "2026-06-02T00:20:00.000Z",
    });
    const recent = readPiSubagentSessionState(recentAttempt, {
        exists: () => true,
        now: () => new Date("2026-06-02T00:21:00.000Z"),
        staleAfterMs: 10 * 60_000,
        live: true,
        readFile: () => transcript,
    });
    assert.notEqual(recent.status, "selfReportedComplete");
    assert.equal(recent.status, "idle");
    assert.equal(recent.lastActivityAt, "2026-06-02T00:20:00.000Z");
    assert.equal(recent.metadata?.staleReplayIgnored, true);
    assert.equal(recent.metadata?.staleReplayMarker, "SUBAGENT_RESULT");
    const stale = readPiSubagentSessionState(recentAttempt, {
        exists: () => true,
        now: () => new Date("2026-06-02T00:31:00.000Z"),
        staleAfterMs: 10 * 60_000,
        live: true,
        readFile: () => transcript,
    });
    assert.equal(stale.status, "needsFollowup");
    assert.match(stale.error ?? "", /no current-attempt transcript activity/);
    assert.equal(stale.metadata?.staleReplayIgnored, true);
});
test("Pi subagent session inspection maps blocked markers and missing sessions", () => {
    const blocked = readPiSubagentSessionState(subagent({ sessionFile: "/blocked" }), {
        exists: () => true,
        readFile: () => JSON.stringify({ type: "message", message: { role: "assistant", content: "SUBAGENT_BLOCKED: merge conflict needs controller input" }, timestamp: now }),
    });
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.selfReportedResult, "merge conflict needs controller input");
    const missing = readPiSubagentSessionState(subagent({ sessionFile: "/missing" }), { exists: () => false, live: true });
    assert.equal(missing.status, "starting");
    assert.match(missing.error ?? "", /not found/);
});
test("Pi harness subagent adapter abort stops tracked detached session handle", async () => {
    const { launcher, stopped } = fakeLauncher();
    const adapter = new PiHarnessSubagentAdapter({ launcher, now: () => new Date(now) });
    await adapter.startSession({ goalId: "goal-1", node: node(), subagentId: "subagent-1", cwd: "/repo", initialPrompt: "initial" });
    await adapter.abortSession({ subagent: subagent({ workspacePath: "/repo" }), reason: "controller cancelled" });
    assert.deepEqual(stopped, ["subagent-subagent-1"]);
});
//# sourceMappingURL=pi-subagent-adapter.test.js.map