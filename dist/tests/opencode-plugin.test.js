import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { opencodeGoalPlugin, createOpencodeGoalPluginContext, setOpencodeClientForTests, resetOpencodeClientForTests, setOpencodeBackgroundSessionLauncherForTests, } from "../adapters/opencode/index.js";
import { SQLiteGoalStore } from "../core/index.js";
function git(cwd, args) {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function createGitWorkspace() {
    const repo = mkdtempSync(join(tmpdir(), "goal-opencode-workspace-"));
    git(repo, ["init", "-b", "main"]);
    git(repo, ["config", "user.email", "goal@example.test"]);
    git(repo, ["config", "user.name", "Goal Test"]);
    writeFileSync(join(repo, "README.md"), "# fixture\n");
    git(repo, ["add", "README.md"]);
    git(repo, ["commit", "-m", "initial"]);
    return repo;
}
function makeMessage(id, text, role = "assistant") {
    return {
        id,
        role,
        parts: [{ type: "text", text }],
        time: { created: Date.parse("2026-06-02T00:00:00.000Z"), completed: Date.parse("2026-06-02T00:00:01.000Z") },
    };
}
function makeClient(messages = []) {
    const calls = [];
    return {
        calls,
        session: {
            create: async () => ({ data: { id: "ses_new" } }),
            get: async ({ sessionID }) => ({ data: { id: sessionID, directory: process.cwd() } }),
            prompt: async ({ sessionID, parts }) => {
                calls.push({ sessionID, parts: parts ?? [] });
                return { data: { ok: true } };
            },
            messages: async () => ({ data: messages }),
            status: async () => ({ data: { type: "idle" } }),
            abort: async () => ({ data: { ok: true } }),
        },
    };
}
function makePluginInput(workspace, client) {
    return {
        client,
        project: { id: "test", directory: workspace, worktree: workspace },
        directory: workspace,
        worktree: workspace,
        serverUrl: new URL("http://127.0.0.1:4096"),
        $: (() => Promise.resolve({ stdout: "", stderr: "", exitCode: 0 })),
    };
}
test("opencode adapter registers Codex-compatible goal tools and a goal_command tool", async () => {
    const dir = mkdtempSync(join(tmpdir(), "goal-opencode-tools-"));
    const previousStateHome = process.env.AGENT_GOAL_STATE_HOME;
    process.env.AGENT_GOAL_STATE_HOME = dir;
    const client = makeClient();
    setOpencodeClientForTests(client);
    try {
        const hooks = await opencodeGoalPlugin(makePluginInput(process.cwd(), client));
        assert.ok(hooks.tool);
        const toolNames = Object.keys(hooks.tool ?? {}).sort();
        assert.deepEqual(toolNames, ["create_goal", "get_goal", "goal_command", "update_goal"]);
    }
    finally {
        resetOpencodeClientForTests();
        if (previousStateHome === undefined)
            delete process.env.AGENT_GOAL_STATE_HOME;
        else
            process.env.AGENT_GOAL_STATE_HOME = previousStateHome;
        rmSync(dir, { recursive: true, force: true });
    }
});
test("opencode adapter maps session lifecycle events to runtime turnFinished", async () => {
    const dir = mkdtempSync(join(tmpdir(), "goal-opencode-events-"));
    const previousStateHome = process.env.AGENT_GOAL_STATE_HOME;
    process.env.AGENT_GOAL_STATE_HOME = dir;
    const client = makeClient([
        makeMessage("u1", "start", "user"),
        makeMessage("a1", "working", "assistant"),
    ]);
    setOpencodeClientForTests(client);
    try {
        const hooks = await opencodeGoalPlugin(makePluginInput(process.cwd(), client));
        await hooks.event?.({ event: { type: "session.created", properties: { sessionID: "ses_1" } } });
        await hooks.event?.({ event: { type: "session.idle", properties: { sessionID: "ses_1" } } });
        // The runtime should have materialised a session goal-key and a ledger
        // event for the idle turn. Verify the registry records the activity.
        const store = new SQLiteGoalStore({ stateRoot: dir });
        const events = await store.listLedgerEvents("opencode:ses_1");
        const idleEvent = events.find((event) => event.type === "turn_finished");
        assert.ok(idleEvent, "expected a turn_finished ledger event for session.idle");
        store.close?.();
    }
    finally {
        resetOpencodeClientForTests();
        if (previousStateHome === undefined)
            delete process.env.AGENT_GOAL_STATE_HOME;
        else
            process.env.AGENT_GOAL_STATE_HOME = previousStateHome;
        rmSync(dir, { recursive: true, force: true });
    }
});
test("opencode adapter pauses the active goal on session.error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "goal-opencode-error-"));
    const previousStateHome = process.env.AGENT_GOAL_STATE_HOME;
    process.env.AGENT_GOAL_STATE_HOME = dir;
    const client = makeClient([]);
    setOpencodeClientForTests(client);
    try {
        const hooks = await opencodeGoalPlugin(makePluginInput(process.cwd(), client));
        await hooks.event?.({ event: { type: "session.created", properties: { sessionID: "ses_err" } } });
        const sessionKey = "opencode:ses_err";
        const { createOpencodeGoalPluginContext: _ctxFactory } = await import("../adapters/opencode/index.js");
        void _ctxFactory;
        const store = new SQLiteGoalStore({ stateRoot: dir });
        const goal = {
            sessionKey,
            goalId: "goal-err-1",
            objective: "test",
            status: "active",
            tokensUsed: 0,
            timeUsedSeconds: 0,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            goalTurnsSinceAuditReset: 0,
        };
        await store.saveGoal(goal);
        store.close?.();
        await hooks.event?.({
            event: { type: "session.error", properties: { sessionID: "ses_err", error: "boom" } },
        });
        const store2 = new SQLiteGoalStore({ stateRoot: dir });
        const current = await store2.getCurrentGoal(sessionKey);
        assert.equal(current?.status, "paused");
        store2.close?.();
    }
    finally {
        resetOpencodeClientForTests();
        if (previousStateHome === undefined)
            delete process.env.AGENT_GOAL_STATE_HOME;
        else
            process.env.AGENT_GOAL_STATE_HOME = previousStateHome;
        rmSync(dir, { recursive: true, force: true });
    }
});
test("opencode adapter goal_command tool starts an orchestrated goal with a workspace", async () => {
    const dir = mkdtempSync(join(tmpdir(), "goal-opencode-start-"));
    const workspace = createGitWorkspace();
    const previousStateHome = process.env.AGENT_GOAL_STATE_HOME;
    process.env.AGENT_GOAL_STATE_HOME = dir;
    const client = makeClient();
    setOpencodeClientForTests(client);
    const launches = [];
    setOpencodeBackgroundSessionLauncherForTests(async (request) => {
        launches.push(request);
        return {
            sessionID: `ses_${launches.length}`,
            sessionTitle: request.sessionTitle,
            serverUrl: `http://127.0.0.1:${41000 + launches.length}`,
            setSessionTitle: async () => undefined,
            sendPrompt: async () => undefined,
            stop: () => undefined,
        };
    });
    try {
        const hooks = await opencodeGoalPlugin(makePluginInput(workspace, client));
        await hooks.event?.({ event: { type: "session.created", properties: { sessionID: "ses_start" } } });
        const tool = hooks.tool?.goal_command;
        const response = await tool.execute({ command: `--workspace ${workspace} --branch main Implement opencode goal` }, { sessionID: "ses_start" });
        assert.match(response, /Goal .* started/);
        assert.match(response, new RegExp(`Workspace: ${workspace.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
        const store = new SQLiteGoalStore({ stateRoot: dir });
        const summaries = await store.listGoalSummaries();
        assert.equal(summaries.length, 1);
        assert.equal(summaries[0]?.status, "active");
        // The branch the goal was started with should be persisted; the
        // subagent worktree branch belongs to the DAG node, not the goal.
        assert.equal(summaries[0]?.executionWorkspace, workspace);
        assert.equal(summaries[0]?.workspaceStatus, "configured");
        const metadata = await store.getGoalSessionMetadata(summaries[0].sessionKey);
        assert.equal(metadata?.branch, "main");
        store.close?.();
    }
    finally {
        setOpencodeBackgroundSessionLauncherForTests();
        resetOpencodeClientForTests();
        if (previousStateHome === undefined)
            delete process.env.AGENT_GOAL_STATE_HOME;
        else
            process.env.AGENT_GOAL_STATE_HOME = previousStateHome;
        rmSync(dir, { recursive: true, force: true });
        rmSync(workspace, { recursive: true, force: true });
    }
});
test("opencode adapter get_goal tool returns the current goal summary", async () => {
    const dir = mkdtempSync(join(tmpdir(), "goal-opencode-get-"));
    const previousStateHome = process.env.AGENT_GOAL_STATE_HOME;
    process.env.AGENT_GOAL_STATE_HOME = dir;
    const client = makeClient();
    setOpencodeClientForTests(client);
    try {
        const hooks = await opencodeGoalPlugin(makePluginInput(process.cwd(), client));
        await hooks.event?.({ event: { type: "session.created", properties: { sessionID: "ses_get" } } });
        const store = new SQLiteGoalStore({ stateRoot: dir });
        await store.saveGoal({
            sessionKey: "opencode:ses_get",
            goalId: "goal-get-1",
            objective: "verify the opencode bridge",
            status: "active",
            tokensUsed: 0,
            timeUsedSeconds: 0,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            goalTurnsSinceAuditReset: 0,
        });
        store.close?.();
        const tool = hooks.tool?.get_goal;
        const response = await tool.execute({}, { sessionID: "ses_get" });
        assert.match(response, /verify the opencode bridge/);
        assert.match(response, /active/);
    }
    finally {
        resetOpencodeClientForTests();
        if (previousStateHome === undefined)
            delete process.env.AGENT_GOAL_STATE_HOME;
        else
            process.env.AGENT_GOAL_STATE_HOME = previousStateHome;
        rmSync(dir, { recursive: true, force: true });
    }
});
test("opencode adapter update_goal tool reports incomplete blocked evidence when only one turn is available", async () => {
    const dir = mkdtempSync(join(tmpdir(), "goal-opencode-block-"));
    const previousStateHome = process.env.AGENT_GOAL_STATE_HOME;
    process.env.AGENT_GOAL_STATE_HOME = dir;
    const client = makeClient([makeMessage("a1", "SUBAGENT_BLOCKED: needs controller input")]);
    setOpencodeClientForTests(client);
    try {
        const hooks = await opencodeGoalPlugin(makePluginInput(process.cwd(), client));
        await hooks.event?.({ event: { type: "session.created", properties: { sessionID: "ses_block" } } });
        const store = new SQLiteGoalStore({ stateRoot: dir });
        await store.saveGoal({
            sessionKey: "opencode:ses_block",
            goalId: "goal-block-1",
            objective: "blocked example",
            status: "active",
            tokensUsed: 0,
            timeUsedSeconds: 0,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            goalTurnsSinceAuditReset: 0,
        });
        store.close?.();
        const tool = hooks.tool?.update_goal;
        const response = await tool.execute({ status: "blocked" }, { sessionID: "ses_block" });
        assert.match(response, /3 consecutive/i);
        assert.match(response, /blocked/i);
    }
    finally {
        resetOpencodeClientForTests();
        if (previousStateHome === undefined)
            delete process.env.AGENT_GOAL_STATE_HOME;
        else
            process.env.AGENT_GOAL_STATE_HOME = previousStateHome;
        rmSync(dir, { recursive: true, force: true });
    }
});
test("opencode adapter runtime tracks post-stop turn state for the guard", async () => {
    const dir = mkdtempSync(join(tmpdir(), "goal-opencode-poststop-"));
    const previousStateHome = process.env.AGENT_GOAL_STATE_HOME;
    process.env.AGENT_GOAL_STATE_HOME = dir;
    const client = makeClient();
    setOpencodeClientForTests(client);
    try {
        const ctx = createOpencodeGoalPluginContext({ stateRoot: dir, now: () => new Date() });
        const sessionKey = "opencode:ses_post";
        const goal = {
            sessionKey,
            goalId: "goal-post-1",
            objective: "post-stop guard",
            status: "active",
            tokensUsed: 0,
            timeUsedSeconds: 0,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            goalTurnsSinceAuditReset: 0,
        };
        await ctx.store.saveGoal(goal);
        // The opencode adapter consults `getCurrentTurnStop` in its
        // `tool.execute.before` hook. We assert the public contract that
        // the guard relies on: when no turn has been recorded, the guard
        // sees no stop and allows the tool to proceed.
        const initial = ctx.runtime.getCurrentTurnStop(sessionKey);
        assert.equal(initial, undefined);
        // Recording a turn start and then finishing it as failed should
        // also leave `getCurrentTurnStop` returning undefined because the
        // opencode adapter only sets a stop on a tool-driven guard
        // (e.g. blocked or completion audit).
        await ctx.runtime.turnStarted({ sessionKey, turnId: "turn-1" });
        await ctx.runtime.turnFinished({ sessionKey }, false);
        const afterFailure = ctx.runtime.getCurrentTurnStop(sessionKey);
        assert.equal(afterFailure, undefined);
    }
    finally {
        resetOpencodeClientForTests();
        if (previousStateHome === undefined)
            delete process.env.AGENT_GOAL_STATE_HOME;
        else
            process.env.AGENT_GOAL_STATE_HOME = previousStateHome;
        rmSync(dir, { recursive: true, force: true });
    }
});
test("opencode adapter /goal --dag loads the file and plans from it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "goal-opencode-dag-"));
    const previousStateHome = process.env.AGENT_GOAL_STATE_HOME;
    process.env.AGENT_GOAL_STATE_HOME = dir;
    const workspace = createGitWorkspace();
    const dagFile = join(workspace, "people-frappe.dag.json");
    writeFileSync(dagFile, JSON.stringify({
        version: 1,
        objective: "ship people frappe backend slices",
        modelRouting: {
            controllerScenario: "controller",
            defaultSubagentScenario: "implementation",
            scenarios: {
                controller: { modelClass: "controller" },
                implementation: { modelClass: "implementation" },
            },
        },
        nodes: [
            { id: "attendance", objective: "Add attendance parity" },
            { id: "payroll", objective: "Add payroll doctypes" },
            { id: "integration", objective: "Run integrated validation", after: ["attendance", "payroll"] },
        ],
    }));
    const client = makeClient();
    setOpencodeClientForTests(client);
    const launched = [];
    setOpencodeBackgroundSessionLauncherForTests((async (request) => {
        launched.push(request);
        return {
            sessionID: `ses_bg_${launched.length}`,
            sessionTitle: "test",
            serverUrl: "http://127.0.0.1:0",
            setSessionTitle: async () => undefined,
            sendPrompt: async () => undefined,
            stop: () => undefined,
        };
    }));
    try {
        const hooks = await opencodeGoalPlugin(makePluginInput(workspace, client));
        const goalTool = hooks.tool?.goal_command;
        assert.ok(goalTool, "expected goal_command tool to be registered");
        const extraText = await goalTool.execute({ command: `--workspace ${workspace} --branch main --dag people-frappe.dag.json extra text` }, { sessionID: "ses_dag" });
        assert.match(extraText, /objective must come from the DAG file/);
        const extraTokenText = await goalTool.execute({ command: `--workspace ${workspace} --branch main --dag people-frappe.dag.json --tokens 100k extra` }, { sessionID: "ses_dag" });
        assert.match(extraTokenText, /objective must come from the DAG file/);
        const missingBudgetText = await goalTool.execute({ command: `--workspace ${workspace} --branch main --dag people-frappe.dag.json --tokens` }, { sessionID: "ses_dag" });
        assert.match(missingBudgetText, /objective must come from the DAG file/);
        assert.equal(launched.length, 0);
        const text = await goalTool.execute({ command: `--workspace ${workspace} --branch main --dag ${dagFile} --tokens 100k` }, { sessionID: "ses_dag" });
        assert.match(text, /planned 3 DAG node/i);
        const store = new SQLiteGoalStore({ stateRoot: dir });
        const goalList = await store.listGoalSummaries();
        const dagGoal = goalList.find((goal) => goal.objective.includes("people frappe backend"));
        assert.ok(dagGoal, "expected the DAG objective to be persisted");
        assert.equal(dagGoal.tokenBudget, 100_000);
        store.close?.();
    }
    finally {
        resetOpencodeClientForTests();
        setOpencodeBackgroundSessionLauncherForTests();
        if (previousStateHome === undefined)
            delete process.env.AGENT_GOAL_STATE_HOME;
        else
            process.env.AGENT_GOAL_STATE_HOME = previousStateHome;
        rmSync(dir, { recursive: true, force: true });
        rmSync(workspace, { recursive: true, force: true });
    }
});
test("opencode adapter /goal --model-routing resolves controller through bindings", async () => {
    const dir = mkdtempSync(join(tmpdir(), "goal-opencode-model-"));
    const previousStateHome = process.env.AGENT_GOAL_STATE_HOME;
    process.env.AGENT_GOAL_STATE_HOME = dir;
    const workspace = createGitWorkspace();
    const client = makeClient();
    setOpencodeClientForTests(client);
    setOpencodeBackgroundSessionLauncherForTests((async () => ({
        sessionID: "ses_bg",
        sessionTitle: "test",
        serverUrl: "http://127.0.0.1:0",
        setSessionTitle: async () => undefined,
        sendPrompt: async () => undefined,
        stop: () => undefined,
    })));
    try {
        const hooks = await opencodeGoalPlugin(makePluginInput(workspace, client));
        const goalTool = hooks.tool?.goal_command;
        assert.ok(goalTool, "expected goal_command tool to be registered");
        const text = await goalTool.execute({
            command: `--workspace ${workspace} --branch main --model-routing '{"controllerScenario":"controller","scenarios":{"controller":{"modelClass":"controller"}}}' implement feature`,
        }, { sessionID: "ses_mr" });
        assert.match(text, /Controller model: openai-codex\/gpt-5\.5 via controller/);
        const store = new SQLiteGoalStore({ stateRoot: dir });
        const goalList = await store.listGoalSummaries();
        const goal = goalList.find((entry) => entry.objective.includes("implement feature"));
        assert.ok(goal, "expected the goal to be persisted");
        store.close?.();
    }
    finally {
        resetOpencodeClientForTests();
        setOpencodeBackgroundSessionLauncherForTests();
        if (previousStateHome === undefined)
            delete process.env.AGENT_GOAL_STATE_HOME;
        else
            process.env.AGENT_GOAL_STATE_HOME = previousStateHome;
        rmSync(dir, { recursive: true, force: true });
        rmSync(workspace, { recursive: true, force: true });
    }
});
//# sourceMappingURL=opencode-plugin.test.js.map