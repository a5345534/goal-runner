import test from "node:test";
import assert from "node:assert/strict";
import { OpencodeHarnessSubagentAdapter, renderOpencodeSubagentInitialPrompt, readOpencodeSubagentSessionState, setOpencodeBackgroundSessionLauncherForTests, } from "../adapters/opencode/index.js";
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
        harnessAdapterId: "opencode",
        sessionId: "ses_subagent-1",
        sessionFile: "http://127.0.0.1:41234",
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
        const sessionID = request.sessionID ?? `ses_${(request.sessionTitle.split(" ")[1] ?? `${launches.length}`).replace(/[:]/g, "")}`;
        return {
            sessionID,
            sessionTitle: request.sessionTitle,
            serverUrl: `http://127.0.0.1:${41000 + launches.length}`,
            setSessionTitle: async (title) => {
                const handle = launches.find((entry) => entry.sessionTitle === request.sessionTitle);
                if (handle)
                    handle.sessionTitle = title;
            },
            sendPrompt: async (prompt) => {
                prompts.push(prompt);
            },
            stop: () => stopped.push(sessionID),
        };
    };
    return { launcher, launches, prompts, stopped };
}
test("Opencode harness subagent adapter starts a detached opencode session and sends the initial prompt", async () => {
    const { launcher, launches, prompts } = fakeLauncher();
    setOpencodeBackgroundSessionLauncherForTests(launcher);
    try {
        const adapter = new OpencodeHarnessSubagentAdapter({ now: () => new Date(now) });
        const result = await adapter.startSession({
            goalId: "goal-1",
            node: node(),
            subagentId: "subagent-1",
            cwd: "/repo/.worktrees/attendance",
            branch: "feat/attendance",
            systemPrompt: "system guardrails",
            initialPrompt: "create attendance doctypes",
        });
        assert.equal(launches.length, 1);
        assert.equal(launches[0]?.cwd, "/repo/.worktrees/attendance");
        assert.match(launches[0]?.sessionTitle ?? "", /subagent subagent-1/);
        assert.equal(result.sessionId, "ses_subagent-1");
        assert.equal(result.status, "running");
        assert.equal(result.workspacePath, "/repo/.worktrees/attendance");
        assert.equal(prompts.length, 1);
        assert.match(prompts[0] ?? "", /system guardrails/);
        assert.match(prompts[0] ?? "", /SUBAGENT_RESULT/);
        assert.match(prompts[0] ?? "", /CONTROLLER EXECUTION POLICY/);
        assert.match(prompts[0] ?? "", /Allowed changed paths: apps\/attendance\/\*\*/);
        assert.match(prompts[0] ?? "", /Forbidden changed paths: package-lock\.json/);
        assert.match(prompts[0] ?? "", /create attendance doctypes/);
    }
    finally {
        setOpencodeBackgroundSessionLauncherForTests();
    }
});
test("Opencode harness subagent adapter includes quality profile discipline in initial prompt", () => {
    const prompt = renderOpencodeSubagentInitialPrompt({
        goalId: "goal-1",
        node: node({ qualityProfiles: ["api-contract-change", "security-sensitive-review"] }),
        subagentId: "subagent-1",
        cwd: "/repo/.worktrees/attendance",
        initialPrompt: "implement quality-profiled node",
    });
    assert.match(prompt, /QUALITY PROFILE EXECUTION DISCIPLINE/);
    assert.match(prompt, /api-contract-change, security-sensitive-review/);
    assert.match(prompt, /public API\/contract compatibility/);
    assert.match(prompt, /security impact/);
});
test("Opencode harness subagent adapter honors controller-prepared resources", async () => {
    const { launcher, launches } = fakeLauncher();
    setOpencodeBackgroundSessionLauncherForTests(launcher);
    try {
        const adapter = new OpencodeHarnessSubagentAdapter({ modelArg: "fallback/model", now: () => new Date(now) });
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
                sessionId: "ses_prepared",
                modelArg: "prepared/model",
            },
        });
        assert.equal(launches[0]?.cwd, "/repo/.worktrees/prepared");
        assert.equal(launches[0]?.sessionID, "ses_prepared");
        assert.equal(launches[0]?.modelArg, "prepared/model");
        assert.equal(result.sessionId, "ses_prepared");
        assert.equal(result.workspacePath, "/repo/.worktrees/prepared");
        assert.equal(result.branch, "goal/prepared");
    }
    finally {
        setOpencodeBackgroundSessionLauncherForTests();
    }
});
test("Opencode harness subagent adapter resumes an existing session for follow-up prompts", async () => {
    const { launcher, launches, prompts, stopped } = fakeLauncher();
    setOpencodeBackgroundSessionLauncherForTests(launcher);
    try {
        const adapter = new OpencodeHarnessSubagentAdapter({ now: () => new Date(now) });
        await adapter.startSession({
            goalId: "goal-1",
            node: node(),
            subagentId: "subagent-1",
            cwd: "/repo/.worktrees/attendance",
            initialPrompt: "initial",
        });
        await adapter.sendPrompt({
            subagent: subagent(),
            prompt: "fix validator failure",
        });
        assert.equal(launches.length, 2);
        assert.equal(launches[1]?.sessionID, "ses_subagent-1");
        assert.equal(launches[1]?.cwd, "/repo/.worktrees/attendance");
        assert.equal(prompts.length, 2);
        assert.match(prompts[1] ?? "", /fix validator failure/);
        assert.deepEqual(stopped, ["ses_subagent-1"]);
    }
    finally {
        setOpencodeBackgroundSessionLauncherForTests();
    }
});
test("Opencode subagent session inspection maps markers to self-report states", async () => {
    const blocked = readOpencodeSubagentSessionState(subagent(), { messages: [
            {
                id: "m1",
                role: "assistant",
                parts: [{ type: "text", text: "SUBAGENT_BLOCKED: merge conflict needs controller input" }],
                time: { created: Date.parse(now), completed: Date.parse(now) },
            },
        ] });
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.selfReportedResult, "merge conflict needs controller input");
    const completed = readOpencodeSubagentSessionState(subagent(), { messages: [
            {
                id: "m1",
                role: "assistant",
                parts: [{ type: "text", text: "SUBAGENT_RESULT: attendance doctypes added and tests passed" }],
                time: { created: Date.parse(now), completed: Date.parse(now) },
            },
        ] });
    assert.equal(completed.status, "selfReportedComplete");
    assert.equal(completed.selfReportedResult, "attendance doctypes added and tests passed");
    const missing = readOpencodeSubagentSessionState(subagent({ sessionId: undefined }));
    assert.equal(missing.status, "failed");
    assert.match(missing.error ?? "", /no sessionId/);
});
test("Opencode harness subagent adapter abort stops tracked detached session handle", async () => {
    const { launcher, stopped } = fakeLauncher();
    setOpencodeBackgroundSessionLauncherForTests(launcher);
    try {
        const adapter = new OpencodeHarnessSubagentAdapter({ now: () => new Date(now) });
        await adapter.startSession({ goalId: "goal-1", node: node(), subagentId: "subagent-1", cwd: "/repo", initialPrompt: "initial" });
        await adapter.abortSession({ subagent: subagent({ workspacePath: "/repo" }), reason: "controller cancelled" });
        assert.deepEqual(stopped, ["ses_subagent-1"]);
    }
    finally {
        setOpencodeBackgroundSessionLauncherForTests();
    }
});
test("renderOpencodeSubagentInitialPrompt renders the SUBAGENT_RESULT/BLOCKED markers and node objective", () => {
    const prompt = renderOpencodeSubagentInitialPrompt({
        goalId: "goal-1",
        node: node(),
        subagentId: "subagent-1",
        cwd: "/repo",
        branch: "feat/attendance",
        systemPrompt: "system guardrails",
        initialPrompt: "create attendance doctypes",
    });
    assert.match(prompt, /system guardrails/);
    assert.match(prompt, /SUBAGENT_RESULT/);
    assert.match(prompt, /SUBAGENT_BLOCKED/);
    assert.match(prompt, /CONTROLLER EXECUTION POLICY/);
    assert.match(prompt, /create attendance doctypes/);
    assert.match(prompt, /attendance DocTypes/);
});
//# sourceMappingURL=opencode-subagent-adapter.test.js.map