import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import goalPiExtension, { setPiBackgroundGoalSessionLauncherForTests } from "../adapters/pi/index.js";
import { GoalRuntime, SQLiteGoalStore } from "../core/index.js";
function git(cwd, args) {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
async function waitForAssertion(assertion, timeoutMs = 5_000) {
    const deadline = Date.now() + timeoutMs;
    let lastError;
    while (Date.now() < deadline) {
        try {
            assertion();
            return;
        }
        catch (error) {
            lastError = error;
            await delay(20);
        }
    }
    if (lastError)
        throw lastError;
    assertion();
}
function createGitWorkspace(options = {}) {
    const repo = mkdtempSync(join(tmpdir(), "goal-pi-orchestrate-workspace-"));
    git(repo, ["init", "-b", "main"]);
    git(repo, ["config", "user.email", "goal@example.test"]);
    git(repo, ["config", "user.name", "Goal Test"]);
    writeFileSync(join(repo, "README.md"), "# fixture\n");
    git(repo, ["add", "README.md"]);
    git(repo, ["commit", "-m", "initial"]);
    if (options.origin !== false) {
        const remote = join(repo, ".git", "test-origin.git");
        git(repo, ["init", "--bare", remote]);
        git(repo, ["remote", "add", "origin", remote]);
        git(repo, ["push", "-u", "origin", "main"]);
        git(remote, ["symbolic-ref", "HEAD", "refs/heads/main"]);
    }
    return repo;
}
test("Pi adapter keeps model-visible goal tools Codex-compatible", async () => {
    const dir = mkdtempSync(join(tmpdir(), "goal-tools-"));
    const previousStateHome = process.env.AGENT_GOAL_STATE_HOME;
    process.env.AGENT_GOAL_STATE_HOME = dir;
    const tools = [];
    const handlers = new Map();
    const pi = {
        registerTool(tool) {
            tools.push(tool);
        },
        registerCommand() { },
        on(event, handler) {
            const list = handlers.get(event) ?? [];
            list.push(handler);
            handlers.set(event, list);
        },
        appendEntry() { },
        sendMessage() { },
    };
    try {
        goalPiExtension(pi);
        assert.deepEqual(tools.map((tool) => tool.name).sort(), ["create_goal", "get_goal", "get_goal_debug", "goal_config", "update_goal"]);
        for (const handler of handlers.get("session_shutdown") ?? [])
            await handler();
    }
    finally {
        if (previousStateHome === undefined)
            delete process.env.AGENT_GOAL_STATE_HOME;
        else
            process.env.AGENT_GOAL_STATE_HOME = previousStateHome;
        rmSync(dir, { recursive: true, force: true });
    }
});
test("Pi orchestrated goal start plans DAG and launches a subagent worktree", async () => {
    const dir = mkdtempSync(join(tmpdir(), "goal-orchestrated-session-"));
    const workspace = createGitWorkspace();
    const previousStateHome = process.env.AGENT_GOAL_STATE_HOME;
    process.env.AGENT_GOAL_STATE_HOME = dir;
    let commandHandler;
    const handlers = new Map();
    const prompts = [];
    const launched = [];
    const mirrored = [];
    setPiBackgroundGoalSessionLauncherForTests(async (request) => {
        launched.push(request);
        const index = launched.length;
        return {
            sessionFile: request.sessionFile ?? join(dir, `session-${index}.jsonl`),
            sessionId: request.sessionId ?? `session-${index}`,
            setSessionName: async () => undefined,
            sendPrompt: async (prompt) => {
                prompts.push(prompt);
            },
            isAlive: () => true,
            stop: () => undefined,
        };
    });
    const pi = {
        registerTool() { },
        registerCommand(_name, options) {
            commandHandler = options.handler;
        },
        on(event, handler) {
            const list = handlers.get(event) ?? [];
            list.push(handler);
            handlers.set(event, list);
        },
        appendEntry(_type, data) {
            mirrored.push(data);
        },
        sendMessage() { },
    };
    const notifications = [];
    const controllerCtx = {
        hasUI: true,
        cwd: workspace,
        model: { provider: "test", id: "model" },
        ui: {
            notify(message) {
                notifications.push(message);
            },
            setStatus() { },
            setWidget() { },
            confirm: async () => true,
            editor: async () => undefined,
            select: async () => undefined,
            custom: async () => undefined,
        },
        sessionManager: {
            getSessionFile: () => "/controller/session.jsonl",
            getSessionName: () => "controller",
        },
        isIdle: () => true,
        hasPendingMessages: () => false,
    };
    try {
        goalPiExtension(pi);
        assert.ok(commandHandler);
        await commandHandler?.(`--workspace ${workspace} --branch main Implement orchestrated goal`, controllerCtx);
        assert.equal(launched.length, 2);
        assert.equal(launched[0]?.cwd, workspace);
        assert.match(launched[0]?.sessionName ?? "", /^goal:/);
        assert.notEqual(launched[1]?.cwd, workspace);
        assert.match(launched[1]?.cwd ?? "", /\.worktrees/);
        assert.match(git(launched[1]?.cwd ?? workspace, ["branch", "--show-current"]), /^goal\//);
        assert.equal(prompts.length, 1);
        assert.match(prompts[0] ?? "", /SUBAGENT_RESULT/);
        assert.match(notifications.at(-1) ?? "", /planned 1 DAG node\(s\); started 1 subagent\(s\)/);
        assert.ok(mirrored.some((entry) => entry.kind === "goal_dag_node"));
        assert.ok(mirrored.some((entry) => entry.kind === "goal_subagent"));
        for (const handler of handlers.get("session_shutdown") ?? [])
            await handler({ type: "session_shutdown", reason: "quit" });
    }
    finally {
        setPiBackgroundGoalSessionLauncherForTests();
        if (previousStateHome === undefined)
            delete process.env.AGENT_GOAL_STATE_HOME;
        else
            process.env.AGENT_GOAL_STATE_HOME = previousStateHome;
        rmSync(dir, { recursive: true, force: true });
        rmSync(workspace, { recursive: true, force: true });
    }
});
test("Pi goal clear removes auto-allocated worktrees and branches", async () => {
    const dir = mkdtempSync(join(tmpdir(), "goal-clear-owned-session-"));
    const workspace = createGitWorkspace();
    const previousStateHome = process.env.AGENT_GOAL_STATE_HOME;
    const previousPollMs = process.env.AGENT_GOAL_PI_CONTROLLER_POLL_MS;
    process.env.AGENT_GOAL_STATE_HOME = dir;
    process.env.AGENT_GOAL_PI_CONTROLLER_POLL_MS = "10000";
    let commandHandler;
    const handlers = new Map();
    const launched = [];
    setPiBackgroundGoalSessionLauncherForTests(async (request) => {
        launched.push(request);
        const index = launched.length;
        return {
            sessionFile: request.sessionFile ?? join(dir, `clear-session-${index}.jsonl`),
            sessionId: request.sessionId ?? `clear-session-${index}`,
            setSessionName: async () => undefined,
            sendPrompt: async () => undefined,
            isAlive: () => true,
            stop: () => undefined,
        };
    });
    const pi = {
        registerTool() { },
        registerCommand(_name, options) {
            commandHandler = options.handler;
        },
        on(event, handler) {
            const list = handlers.get(event) ?? [];
            list.push(handler);
            handlers.set(event, list);
        },
        appendEntry() { },
        sendMessage() { },
    };
    const confirmations = [];
    const notifications = [];
    const controllerCtx = {
        hasUI: true,
        cwd: workspace,
        model: { provider: "test", id: "model" },
        ui: {
            notify(message) {
                notifications.push(message);
            },
            setStatus() { },
            setWidget() { },
            confirm: async (title, message) => {
                confirmations.push({ title, message });
                return true;
            },
            editor: async () => undefined,
            select: async () => undefined,
            custom: async () => undefined,
        },
        sessionManager: {
            getSessionFile: () => "/controller/session.jsonl",
            getSessionName: () => "controller",
        },
        isIdle: () => true,
        hasPendingMessages: () => false,
    };
    try {
        goalPiExtension(pi);
        assert.ok(commandHandler);
        await commandHandler?.("Implement auto clear goal", controllerCtx);
        assert.ok(launched.length >= 1);
        const controllerWorktree = launched[0].cwd;
        const controllerBranch = git(controllerWorktree, ["branch", "--show-current"]);
        const subagentWorktree = launched.find((launch) => launch.cwd !== controllerWorktree)?.cwd;
        const subagentBranch = subagentWorktree ? git(subagentWorktree, ["branch", "--show-current"]) : undefined;
        assert.ok(existsSync(controllerWorktree));
        if (subagentWorktree)
            assert.ok(existsSync(subagentWorktree));
        await commandHandler?.("clear", controllerCtx);
        assert.equal(confirmations.at(-1)?.title, "Clear goal and delete owned resources?");
        assert.match(confirmations.at(-1)?.message ?? "", /Delete controller worktree:/);
        assert.equal(existsSync(controllerWorktree), false);
        if (subagentWorktree)
            assert.equal(existsSync(subagentWorktree), false);
        assert.equal(git(workspace, ["branch", "--list", controllerBranch]), "");
        if (subagentBranch)
            assert.equal(git(workspace, ["branch", "--list", subagentBranch]), "");
        assert.match(notifications.at(-1) ?? "", /Goal cleared\. Cleanup complete/);
        for (const handler of handlers.get("session_shutdown") ?? [])
            await handler({ type: "session_shutdown", reason: "quit" });
    }
    finally {
        setPiBackgroundGoalSessionLauncherForTests();
        if (previousStateHome === undefined)
            delete process.env.AGENT_GOAL_STATE_HOME;
        else
            process.env.AGENT_GOAL_STATE_HOME = previousStateHome;
        if (previousPollMs === undefined)
            delete process.env.AGENT_GOAL_PI_CONTROLLER_POLL_MS;
        else
            process.env.AGENT_GOAL_PI_CONTROLLER_POLL_MS = previousPollMs;
        rmSync(dir, { recursive: true, force: true });
        rmSync(workspace, { recursive: true, force: true });
    }
});
test("Pi goal start serializes the initial controller tick against recovery polling", async () => {
    const dir = mkdtempSync(join(tmpdir(), "goal-start-race-"));
    const workspace = createGitWorkspace();
    const previousStateHome = process.env.AGENT_GOAL_STATE_HOME;
    const previousPollMs = process.env.AGENT_GOAL_PI_CONTROLLER_POLL_MS;
    process.env.AGENT_GOAL_STATE_HOME = dir;
    process.env.AGENT_GOAL_PI_CONTROLLER_POLL_MS = "10000";
    let commandHandler;
    const handlers = new Map();
    const prompts = [];
    const launched = [];
    let subagentLaunchCount = 0;
    let releaseFirstSubagentLaunch;
    const firstSubagentLaunchStarted = new Promise((resolve) => {
        setPiBackgroundGoalSessionLauncherForTests(async (request) => {
            launched.push(request);
            const index = launched.length;
            const sessionFile = request.sessionFile ?? join(dir, `race-session-${index}.jsonl`);
            if (request.sessionName.startsWith("subagent ")) {
                subagentLaunchCount += 1;
                if (subagentLaunchCount === 1) {
                    resolve();
                    await new Promise((release) => {
                        releaseFirstSubagentLaunch = release;
                    });
                }
            }
            return {
                sessionFile,
                sessionId: request.sessionId ?? `race-session-${index}`,
                setSessionName: async () => undefined,
                sendPrompt: async (prompt) => {
                    prompts.push(prompt);
                },
                isAlive: () => true,
                stop: () => undefined,
            };
        });
    });
    const pi = {
        registerTool() { },
        registerCommand(_name, options) {
            commandHandler = options.handler;
        },
        on(event, handler) {
            const list = handlers.get(event) ?? [];
            list.push(handler);
            handlers.set(event, list);
        },
        appendEntry() { },
        sendMessage() { },
    };
    const controllerCtx = {
        hasUI: true,
        cwd: workspace,
        model: { provider: "test", id: "model" },
        ui: {
            notify() { },
            setStatus() { },
            setWidget() { },
            confirm: async () => true,
            editor: async () => undefined,
            select: async () => undefined,
            custom: async () => undefined,
        },
        sessionManager: {
            getSessionFile: () => "/controller/race-session.jsonl",
            getSessionName: () => "controller",
        },
        isIdle: () => true,
        hasPendingMessages: () => false,
    };
    try {
        goalPiExtension(pi);
        assert.ok(commandHandler);
        const commandPromise = commandHandler?.(`--workspace ${workspace} --branch main Implement orchestrated goal`, controllerCtx);
        await firstSubagentLaunchStarted;
        // A goal-owned background controller session can fire session_start while
        // the initial /goal command path is still launching the first subagent.
        // This recovery poll must not start a duplicate runner for the same node.
        await Promise.all((handlers.get("session_start") ?? []).map((handler) => handler({}, controllerCtx)));
        await delay(50);
        assert.equal(subagentLaunchCount, 1);
        releaseFirstSubagentLaunch?.();
        await commandPromise;
        assert.equal(subagentLaunchCount, 1);
        assert.equal(launched.filter((request) => request.sessionName.startsWith("subagent ")).length, 1);
        assert.equal(prompts.length, 1);
        for (const handler of handlers.get("session_shutdown") ?? [])
            await handler({ type: "session_shutdown", reason: "quit" });
    }
    finally {
        releaseFirstSubagentLaunch?.();
        setPiBackgroundGoalSessionLauncherForTests();
        if (previousStateHome === undefined)
            delete process.env.AGENT_GOAL_STATE_HOME;
        else
            process.env.AGENT_GOAL_STATE_HOME = previousStateHome;
        if (previousPollMs === undefined)
            delete process.env.AGENT_GOAL_PI_CONTROLLER_POLL_MS;
        else
            process.env.AGENT_GOAL_PI_CONTROLLER_POLL_MS = previousPollMs;
        rmSync(dir, { recursive: true, force: true });
        rmSync(workspace, { recursive: true, force: true });
    }
});
test("Pi controller poller finalizes completed subagents and removes completed worktrees", async () => {
    const dir = mkdtempSync(join(tmpdir(), "goal-poller-closeout-"));
    const workspace = createGitWorkspace();
    const previousStateHome = process.env.AGENT_GOAL_STATE_HOME;
    const previousPollMs = process.env.AGENT_GOAL_PI_CONTROLLER_POLL_MS;
    process.env.AGENT_GOAL_STATE_HOME = dir;
    process.env.AGENT_GOAL_PI_CONTROLLER_POLL_MS = "10";
    let commandHandler;
    const handlers = new Map();
    const launched = [];
    setPiBackgroundGoalSessionLauncherForTests(async (request) => {
        launched.push(request);
        const index = launched.length;
        const sessionFile = request.sessionFile ?? join(dir, `closeout-session-${index}.jsonl`);
        return {
            sessionFile,
            sessionId: request.sessionId ?? `closeout-session-${index}`,
            setSessionName: async () => undefined,
            sendPrompt: async () => {
                if (!request.sessionName.startsWith("subagent "))
                    return;
                writeFileSync(sessionFile, [
                    JSON.stringify({ type: "session", timestamp: new Date().toISOString(), cwd: request.cwd }),
                    JSON.stringify({
                        type: "message",
                        timestamp: new Date().toISOString(),
                        message: {
                            role: "assistant",
                            content: [{ type: "text", text: "SUBAGENT_RESULT: completed and verified" }],
                        },
                    }),
                ].join("\n"));
            },
            isAlive: () => true,
            stop: () => undefined,
        };
    });
    const pi = {
        registerTool() { },
        registerCommand(_name, options) {
            commandHandler = options.handler;
        },
        on(event, handler) {
            const list = handlers.get(event) ?? [];
            list.push(handler);
            handlers.set(event, list);
        },
        appendEntry() { },
        sendMessage() { },
    };
    const statuses = [];
    const widgets = [];
    const controllerCtx = {
        hasUI: true,
        cwd: workspace,
        model: { provider: "test", id: "model" },
        ui: {
            notify() { },
            setStatus(_name, value) {
                if (value)
                    statuses.push(value);
            },
            setWidget(_name, value) {
                if (value)
                    widgets.push(value);
            },
            confirm: async () => true,
            editor: async () => undefined,
            select: async () => undefined,
            custom: async () => undefined,
        },
        sessionManager: {
            getSessionFile: () => "/controller/session.jsonl",
            getSessionName: () => "controller",
        },
        isIdle: () => true,
        hasPendingMessages: () => false,
    };
    try {
        goalPiExtension(pi);
        assert.ok(commandHandler);
        await commandHandler?.("Implement closeout", controllerCtx);
        await waitForAssertion(() => assert.equal(statuses.at(-1), "🎯 complete"));
        assert.equal(launched.length, 2);
        assert.notEqual(launched[0]?.cwd, workspace);
        assert.equal(existsSync(launched[0]?.cwd ?? ""), false);
        assert.equal(existsSync(launched[1]?.cwd ?? ""), false);
        assert.match(widgets.at(-1)?.[0] ?? "", /^\/goal complete:/);
        for (const handler of handlers.get("session_shutdown") ?? [])
            await handler({ type: "session_shutdown", reason: "quit" });
    }
    finally {
        setPiBackgroundGoalSessionLauncherForTests();
        if (previousStateHome === undefined)
            delete process.env.AGENT_GOAL_STATE_HOME;
        else
            process.env.AGENT_GOAL_STATE_HOME = previousStateHome;
        if (previousPollMs === undefined)
            delete process.env.AGENT_GOAL_PI_CONTROLLER_POLL_MS;
        else
            process.env.AGENT_GOAL_PI_CONTROLLER_POLL_MS = previousPollMs;
        rmSync(dir, { recursive: true, force: true });
        rmSync(workspace, { recursive: true, force: true });
    }
});
test("Pi controller poller promotes controller branch into target before complete", async () => {
    const dir = mkdtempSync(join(tmpdir(), "goal-poller-promote-"));
    const workspace = createGitWorkspace();
    const previousStateHome = process.env.AGENT_GOAL_STATE_HOME;
    const previousPollMs = process.env.AGENT_GOAL_PI_CONTROLLER_POLL_MS;
    process.env.AGENT_GOAL_STATE_HOME = dir;
    process.env.AGENT_GOAL_PI_CONTROLLER_POLL_MS = "10";
    let commandHandler;
    const handlers = new Map();
    const launched = [];
    setPiBackgroundGoalSessionLauncherForTests(async (request) => {
        launched.push(request);
        const index = launched.length;
        const sessionFile = request.sessionFile ?? join(dir, `promote-session-${index}.jsonl`);
        return {
            sessionFile,
            sessionId: request.sessionId ?? `promote-session-${index}`,
            setSessionName: async () => undefined,
            sendPrompt: async () => {
                if (!request.sessionName.startsWith("subagent "))
                    return;
                writeFileSync(join(request.cwd, "promoted.txt"), "promoted\n");
                git(request.cwd, ["add", "promoted.txt"]);
                git(request.cwd, ["commit", "-m", "feat: promoted goal work"]);
                writeFileSync(sessionFile, [
                    JSON.stringify({ type: "session", timestamp: new Date().toISOString(), cwd: request.cwd }),
                    JSON.stringify({
                        type: "message",
                        timestamp: new Date().toISOString(),
                        message: { role: "assistant", content: [{ type: "text", text: "SUBAGENT_RESULT: committed promoted.txt" }] },
                    }),
                ].join("\n"));
            },
            isAlive: () => true,
            stop: () => undefined,
        };
    });
    const pi = {
        registerTool() { },
        registerCommand(_name, options) {
            commandHandler = options.handler;
        },
        on(event, handler) {
            const list = handlers.get(event) ?? [];
            list.push(handler);
            handlers.set(event, list);
        },
        appendEntry() { },
        sendMessage() { },
    };
    const statuses = [];
    const controllerCtx = {
        hasUI: true,
        cwd: workspace,
        model: { provider: "test", id: "model" },
        ui: {
            notify() { },
            setStatus(_name, value) {
                if (value)
                    statuses.push(value);
            },
            setWidget() { },
            confirm: async () => true,
            editor: async () => undefined,
            select: async () => undefined,
            custom: async () => undefined,
        },
        sessionManager: {
            getSessionFile: () => "/controller/session.jsonl",
            getSessionName: () => "controller",
        },
        isIdle: () => true,
        hasPendingMessages: () => false,
    };
    try {
        goalPiExtension(pi);
        assert.ok(commandHandler);
        await commandHandler?.("Implement promoted closeout", controllerCtx);
        await waitForAssertion(() => assert.equal(statuses.at(-1), "🎯 complete"));
        assert.equal(git(workspace, ["show", "HEAD:promoted.txt"]), "promoted");
        assert.equal(launched.length, 2);
        assert.notEqual(launched[0]?.cwd, workspace);
        assert.equal(existsSync(launched[0]?.cwd ?? ""), false);
        assert.equal(existsSync(launched[1]?.cwd ?? ""), false);
        for (const handler of handlers.get("session_shutdown") ?? [])
            await handler({ type: "session_shutdown", reason: "quit" });
    }
    finally {
        setPiBackgroundGoalSessionLauncherForTests();
        if (previousStateHome === undefined)
            delete process.env.AGENT_GOAL_STATE_HOME;
        else
            process.env.AGENT_GOAL_STATE_HOME = previousStateHome;
        if (previousPollMs === undefined)
            delete process.env.AGENT_GOAL_PI_CONTROLLER_POLL_MS;
        else
            process.env.AGENT_GOAL_PI_CONTROLLER_POLL_MS = previousPollMs;
        rmSync(dir, { recursive: true, force: true });
        rmSync(workspace, { recursive: true, force: true });
    }
});
test("Pi /goal blocks unsynced promotion target before launching controller", async () => {
    const dir = mkdtempSync(join(tmpdir(), "goal-promotion-preflight-pi-"));
    const workspace = createGitWorkspace();
    const previousStateHome = process.env.AGENT_GOAL_STATE_HOME;
    process.env.AGENT_GOAL_STATE_HOME = dir;
    writeFileSync(join(workspace, "local-only.txt"), "local only\n");
    git(workspace, ["add", "local-only.txt"]);
    git(workspace, ["commit", "-m", "feat: local target only"]);
    let commandHandler;
    const launched = [];
    setPiBackgroundGoalSessionLauncherForTests(async (request) => {
        launched.push(request);
        throw new Error("controller launcher should not run when promotion target preflight blocks");
    });
    const pi = {
        registerTool() { },
        registerCommand(_name, options) {
            commandHandler = options.handler;
        },
        on() { },
        appendEntry() { },
        sendMessage() { },
    };
    const notifications = [];
    const controllerCtx = {
        hasUI: true,
        cwd: workspace,
        model: { provider: "test", id: "model" },
        ui: {
            notify(message) { notifications.push(message); },
            setStatus() { },
            setWidget() { },
            confirm: async () => true,
            editor: async () => undefined,
            select: async () => undefined,
            custom: async () => undefined,
        },
        sessionManager: {
            getSessionFile: () => "/controller/session.jsonl",
            getSessionName: () => "controller",
        },
        isIdle: () => true,
        hasPendingMessages: () => false,
    };
    try {
        goalPiExtension(pi);
        assert.ok(commandHandler);
        const handler = commandHandler;
        await handler("Implement with unsynced target", controllerCtx);
        assert.match(notifications.join("\n"), /promotion target preflight blocked: local target main has unpushed commits/);
        assert.equal(launched.length, 0, "controller session must not launch after pre-start target-sync block");
        assert.equal(existsSync(join(workspace, ".worktrees")), false, "preflight block must occur before controller worktree allocation");
    }
    finally {
        setPiBackgroundGoalSessionLauncherForTests();
        if (previousStateHome === undefined)
            delete process.env.AGENT_GOAL_STATE_HOME;
        else
            process.env.AGENT_GOAL_STATE_HOME = previousStateHome;
        rmSync(dir, { recursive: true, force: true });
        rmSync(workspace, { recursive: true, force: true });
    }
});
test("Pi controller poller blocks promotion on dirty target and preserves worktrees", async () => {
    const dir = mkdtempSync(join(tmpdir(), "goal-poller-promote-blocked-"));
    const workspace = createGitWorkspace();
    const previousStateHome = process.env.AGENT_GOAL_STATE_HOME;
    const previousPollMs = process.env.AGENT_GOAL_PI_CONTROLLER_POLL_MS;
    process.env.AGENT_GOAL_STATE_HOME = dir;
    process.env.AGENT_GOAL_PI_CONTROLLER_POLL_MS = "10";
    writeFileSync(join(workspace, "dirty.txt"), "do not overwrite\n");
    let commandHandler;
    const handlers = new Map();
    const launched = [];
    setPiBackgroundGoalSessionLauncherForTests(async (request) => {
        launched.push(request);
        const index = launched.length;
        const sessionFile = request.sessionFile ?? join(dir, `promote-blocked-session-${index}.jsonl`);
        return {
            sessionFile,
            sessionId: request.sessionId ?? `promote-blocked-session-${index}`,
            setSessionName: async () => undefined,
            sendPrompt: async () => {
                if (!request.sessionName.startsWith("subagent "))
                    return;
                writeFileSync(join(request.cwd, "blocked-promoted.txt"), "blocked\n");
                git(request.cwd, ["add", "blocked-promoted.txt"]);
                git(request.cwd, ["commit", "-m", "feat: blocked promotion work"]);
                writeFileSync(sessionFile, [
                    JSON.stringify({ type: "session", timestamp: new Date().toISOString(), cwd: request.cwd }),
                    JSON.stringify({
                        type: "message",
                        timestamp: new Date().toISOString(),
                        message: { role: "assistant", content: [{ type: "text", text: "SUBAGENT_RESULT: committed blocked-promoted.txt" }] },
                    }),
                ].join("\n"));
            },
            isAlive: () => true,
            stop: () => undefined,
        };
    });
    const pi = {
        registerTool() { },
        registerCommand(_name, options) {
            commandHandler = options.handler;
        },
        on(event, handler) {
            const list = handlers.get(event) ?? [];
            list.push(handler);
            handlers.set(event, list);
        },
        appendEntry() { },
        sendMessage() { },
    };
    const statuses = [];
    const notifications = [];
    const controllerCtx = {
        hasUI: true,
        cwd: workspace,
        model: { provider: "test", id: "model" },
        ui: {
            notify(message) { notifications.push(message); },
            setStatus(_name, value) {
                if (value)
                    statuses.push(value);
            },
            setWidget() { },
            confirm: async () => true,
            editor: async () => undefined,
            select: async () => undefined,
            custom: async () => undefined,
        },
        sessionManager: {
            getSessionFile: () => "/controller/session.jsonl",
            getSessionName: () => "controller",
        },
        isIdle: () => true,
        hasPendingMessages: () => false,
    };
    try {
        goalPiExtension(pi);
        assert.ok(commandHandler);
        await commandHandler?.("Implement blocked promoted closeout", controllerCtx);
        await waitForAssertion(() => assert.equal(statuses.at(-1), "🎯 blocked"));
        assert.match(notifications.join("\n"), /blocked during final promotion/);
        assert.throws(() => git(workspace, ["show", "HEAD:blocked-promoted.txt"]));
        assert.equal(launched.length, 2);
        assert.equal(existsSync(launched[0]?.cwd ?? ""), true);
        assert.equal(existsSync(launched[1]?.cwd ?? ""), true);
        for (const handler of handlers.get("session_shutdown") ?? [])
            await handler({ type: "session_shutdown", reason: "quit" });
    }
    finally {
        setPiBackgroundGoalSessionLauncherForTests();
        if (previousStateHome === undefined)
            delete process.env.AGENT_GOAL_STATE_HOME;
        else
            process.env.AGENT_GOAL_STATE_HOME = previousStateHome;
        if (previousPollMs === undefined)
            delete process.env.AGENT_GOAL_PI_CONTROLLER_POLL_MS;
        else
            process.env.AGENT_GOAL_PI_CONTROLLER_POLL_MS = previousPollMs;
        rmSync(dir, { recursive: true, force: true });
        rmSync(workspace, { recursive: true, force: true });
    }
});
test("Pi session start recovers active goal pollers from durable state", async () => {
    const dir = mkdtempSync(join(tmpdir(), "goal-poller-recovery-"));
    const workspace = createGitWorkspace();
    const previousStateHome = process.env.AGENT_GOAL_STATE_HOME;
    const previousPollMs = process.env.AGENT_GOAL_PI_CONTROLLER_POLL_MS;
    process.env.AGENT_GOAL_STATE_HOME = dir;
    process.env.AGENT_GOAL_PI_CONTROLLER_POLL_MS = "0";
    let commandHandler;
    const handlers = new Map();
    const launched = [];
    setPiBackgroundGoalSessionLauncherForTests(async (request) => {
        launched.push(request);
        const index = launched.length;
        const sessionFile = request.sessionFile ?? join(dir, `recovery-session-${index}.jsonl`);
        return {
            sessionFile,
            sessionId: request.sessionId ?? `recovery-session-${index}`,
            setSessionName: async () => undefined,
            sendPrompt: async () => {
                if (!request.sessionName.startsWith("subagent "))
                    return;
                writeFileSync(sessionFile, [
                    JSON.stringify({ type: "session", timestamp: new Date().toISOString(), cwd: request.cwd }),
                    JSON.stringify({
                        type: "message",
                        timestamp: new Date().toISOString(),
                        message: { role: "assistant", content: [{ type: "text", text: "SUBAGENT_RESULT: recovered closeout" }] },
                    }),
                ].join("\n"));
            },
            isAlive: () => true,
            stop: () => undefined,
        };
    });
    const pi = {
        registerTool() { },
        registerCommand(_name, options) {
            commandHandler = options.handler;
        },
        on(event, handler) {
            const list = handlers.get(event) ?? [];
            list.push(handler);
            handlers.set(event, list);
        },
        appendEntry() { },
        sendMessage() { },
    };
    const statuses = [];
    const otherStatuses = [];
    const controllerCtx = {
        hasUI: true,
        cwd: workspace,
        model: { provider: "test", id: "model" },
        ui: {
            notify() { },
            setStatus(_name, value) {
                if (value)
                    statuses.push(value);
            },
            setWidget() { },
            confirm: async () => true,
            editor: async () => undefined,
            select: async () => undefined,
            custom: async () => undefined,
        },
        sessionManager: {
            getSessionFile: () => "/controller/session.jsonl",
            getSessionName: () => "controller",
        },
        isIdle: () => true,
        hasPendingMessages: () => false,
    };
    try {
        goalPiExtension(pi);
        assert.ok(commandHandler);
        await commandHandler?.("Implement recoverable closeout", controllerCtx);
        await delay(30);
        assert.notEqual(statuses.at(-1), "🎯 complete");
        assert.notEqual(launched[0]?.cwd, workspace);
        assert.equal(existsSync(launched[0]?.cwd ?? ""), true);
        process.env.AGENT_GOAL_PI_CONTROLLER_POLL_MS = "10";
        const otherCtx = {
            ...controllerCtx,
            sessionManager: {
                getSessionFile: () => "/other/session.jsonl",
                getSessionName: () => "other",
            },
            ui: {
                ...controllerCtx.ui,
                setStatus(_name, value) {
                    if (value)
                        otherStatuses.push(value);
                },
            },
        };
        for (const handler of handlers.get("session_start") ?? [])
            await handler({}, otherCtx);
        await delay(30);
        assert.deepEqual(otherStatuses, []);
        assert.notEqual(statuses.at(-1), "🎯 complete");
        for (const handler of handlers.get("session_start") ?? [])
            await handler({}, controllerCtx);
        await waitForAssertion(() => assert.equal(statuses.at(-1), "🎯 complete"));
        assert.equal(existsSync(launched[0]?.cwd ?? ""), false);
        assert.equal(existsSync(launched[1]?.cwd ?? ""), false);
        for (const handler of handlers.get("session_shutdown") ?? [])
            await handler({ type: "session_shutdown", reason: "quit" });
    }
    finally {
        setPiBackgroundGoalSessionLauncherForTests();
        if (previousStateHome === undefined)
            delete process.env.AGENT_GOAL_STATE_HOME;
        else
            process.env.AGENT_GOAL_STATE_HOME = previousStateHome;
        if (previousPollMs === undefined)
            delete process.env.AGENT_GOAL_PI_CONTROLLER_POLL_MS;
        else
            process.env.AGENT_GOAL_PI_CONTROLLER_POLL_MS = previousPollMs;
        rmSync(dir, { recursive: true, force: true });
        rmSync(workspace, { recursive: true, force: true });
    }
});
test("Pi session start refreshes completed goal-owned session status", async () => {
    const dir = mkdtempSync(join(tmpdir(), "goal-session-complete-refresh-"));
    const previousStateHome = process.env.AGENT_GOAL_STATE_HOME;
    process.env.AGENT_GOAL_STATE_HOME = dir;
    const originFile = "/origin/session.jsonl";
    const executionFile = "/execution/goal-session.jsonl";
    const originSessionKey = `pi:${originFile}`;
    const executionSessionKey = `pi:${executionFile}`;
    const objective = "Finished owner goal";
    const previousMaxSubagents = process.env.AGENT_GOAL_PI_MAX_SUBAGENTS;
    delete process.env.AGENT_GOAL_PI_MAX_SUBAGENTS;
    const seedStore = new SQLiteGoalStore();
    const seedRuntime = new GoalRuntime({ store: seedStore });
    try {
        const created = await seedRuntime.createOrReplaceGoal(executionSessionKey, objective);
        assert.ok(created.goal);
        await seedRuntime.saveGoalSessionMetadata({
            sessionKey: executionSessionKey,
            goalId: created.goal.goalId,
            originSessionKey,
            sessionFile: executionFile,
            sessionName: "goal completed refresh",
            legacySessionBound: false,
            createdAt: created.goal.createdAt,
            updatedAt: created.goal.updatedAt,
        });
        await seedRuntime.toolUpdateGoal(executionSessionKey, "complete");
    }
    finally {
        await seedStore.close?.();
    }
    const handlers = new Map();
    const tools = [];
    const pi = {
        registerTool(tool) {
            tools.push(tool);
        },
        registerCommand() { },
        on(event, handler) {
            const list = handlers.get(event) ?? [];
            list.push(handler);
            handlers.set(event, list);
        },
        appendEntry() { },
        sendMessage() { },
    };
    const makeCtx = (sessionFile, statuses, widgets) => ({
        hasUI: true,
        cwd: dir,
        ui: {
            notify() { },
            setStatus(_name, value) {
                if (value)
                    statuses.push(value);
            },
            setWidget(_name, lines) {
                if (lines?.[0])
                    widgets.push(lines[0]);
            },
            confirm: async () => true,
            editor: async () => undefined,
            select: async () => undefined,
            custom: async () => undefined,
        },
        sessionManager: {
            getSessionFile: () => sessionFile,
            getSessionName: () => sessionFile,
        },
        isIdle: () => true,
        hasPendingMessages: () => false,
    });
    const otherStatuses = [];
    const otherWidgets = [];
    const originStatuses = [];
    const originWidgets = [];
    const executionStatuses = [];
    const executionWidgets = [];
    try {
        goalPiExtension(pi);
        const getGoalTool = tools.find((tool) => tool.name === "get_goal");
        assert.ok(getGoalTool);
        const debugTool = tools.find((tool) => tool.name === "get_goal_debug");
        assert.ok(debugTool);
        const configTool = tools.find((tool) => tool.name === "goal_config");
        assert.ok(configTool);
        const configShowResult = await configTool.execute("call", { action: "show" }, undefined, undefined, makeCtx(originFile, [], []));
        assert.match(configShowResult.content[0]?.text ?? "", /debug-trace/);
        const configSetResult = await configTool.execute("call", { action: "set", key: "max-subagents", value: "2" }, undefined, undefined, makeCtx(originFile, [], []));
        assert.match(configSetResult.content[0]?.text ?? "", /max-subagents set to 2/);
        const configGetResult = await configTool.execute("call", { action: "get", key: "max-subagents" }, undefined, undefined, makeCtx(originFile, [], []));
        assert.match(configGetResult.content[0]?.text ?? "", /2 \(config\)/);
        const configClearResult = await configTool.execute("call", { action: "clear", key: "max-subagents" }, undefined, undefined, makeCtx(originFile, [], []));
        assert.match(configClearResult.content[0]?.text ?? "", /max-subagents cleared/);
        const otherToolResult = await getGoalTool.execute("call", {}, undefined, undefined, makeCtx("/other/session.jsonl", [], []));
        assert.equal(otherToolResult.content[0]?.text, "No current goal.");
        const originToolResult = await getGoalTool.execute("call", {}, undefined, undefined, makeCtx(originFile, [], []));
        assert.match(originToolResult.content[0]?.text ?? "", /Status: complete/);
        const debugToolResult = await debugTool.execute("call", {}, undefined, undefined, makeCtx(originFile, [], []));
        assert.match(debugToolResult.content[0]?.text ?? "", /Goal debug report/);
        assert.match(debugToolResult.content[0]?.text ?? "", /Anomalies:/);
        for (const handler of handlers.get("session_start") ?? [])
            await handler({}, makeCtx("/other/session.jsonl", otherStatuses, otherWidgets));
        assert.deepEqual(otherStatuses, []);
        assert.deepEqual(otherWidgets, []);
        for (const handler of handlers.get("session_start") ?? [])
            await handler({}, makeCtx(originFile, originStatuses, originWidgets));
        assert.equal(originStatuses.at(-1), "🎯 complete");
        assert.equal(originWidgets.at(-1), `/goal complete: ${objective}`);
        for (const handler of handlers.get("session_start") ?? [])
            await handler({}, makeCtx(executionFile, executionStatuses, executionWidgets));
        assert.equal(executionStatuses.at(-1), "🎯 complete");
        assert.equal(executionWidgets.at(-1), `/goal complete: ${objective}`);
        for (const handler of handlers.get("session_shutdown") ?? [])
            await handler({ type: "session_shutdown", reason: "quit" });
    }
    finally {
        if (previousStateHome === undefined)
            delete process.env.AGENT_GOAL_STATE_HOME;
        else
            process.env.AGENT_GOAL_STATE_HOME = previousStateHome;
        if (previousMaxSubagents === undefined)
            delete process.env.AGENT_GOAL_PI_MAX_SUBAGENTS;
        else
            process.env.AGENT_GOAL_PI_MAX_SUBAGENTS = previousMaxSubagents;
        rmSync(dir, { recursive: true, force: true });
    }
});
test("Pi goal start can load an explicit DAG file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "goal-dag-file-session-"));
    const workspace = createGitWorkspace();
    const previousStateHome = process.env.AGENT_GOAL_STATE_HOME;
    process.env.AGENT_GOAL_STATE_HOME = dir;
    let commandHandler;
    const prompts = [];
    const launched = [];
    const mirrored = [];
    const dagFile = join(workspace, "goal.dag.json");
    writeFileSync(dagFile, JSON.stringify({
        version: 1,
        objective: "Run file DAG",
        nodes: [
            { id: "first-node", objective: "Do first", outputs: ["first.txt"] },
            { id: "second-node", objective: "Do second", after: ["first-node"] },
        ],
    }));
    writeFileSync(join(workspace, "goal.trace.json"), JSON.stringify({ traceVersion: 1, dagFile: "goal.dag.json", decisions: [] }));
    setPiBackgroundGoalSessionLauncherForTests(async (request) => {
        launched.push(request);
        return {
            sessionFile: request.sessionFile ?? join(dir, `dag-session-${launched.length}.jsonl`),
            sessionId: request.sessionId ?? `dag-session-${launched.length}`,
            setSessionName: async () => undefined,
            sendPrompt: async (prompt) => {
                prompts.push(prompt);
            },
            isAlive: () => true,
            stop: () => undefined,
        };
    });
    const pi = {
        registerTool() { },
        registerCommand(_name, options) {
            commandHandler = options.handler;
        },
        on() { },
        appendEntry(_type, data) {
            mirrored.push(data);
        },
        sendMessage() { },
    };
    const notifications = [];
    const controllerCtx = {
        hasUI: true,
        cwd: workspace,
        model: { provider: "test", id: "model" },
        ui: {
            notify(message) {
                notifications.push(message);
            },
            setStatus() { },
            setWidget() { },
            confirm: async () => true,
            editor: async () => undefined,
            select: async () => undefined,
            custom: async () => undefined,
        },
        sessionManager: {
            getSessionFile: () => "/controller/session.jsonl",
            getSessionName: () => "controller",
        },
        isIdle: () => true,
        hasPendingMessages: () => false,
    };
    try {
        goalPiExtension(pi);
        assert.ok(commandHandler);
        await commandHandler?.("--dag goal.trace.json", controllerCtx);
        assert.match(notifications.at(-1) ?? "", /Invalid goal DAG file/);
        await commandHandler?.("--dag goal.dag.json extra objective", controllerCtx);
        assert.match(notifications.at(-1) ?? "", /objective must come from the DAG file/);
        assert.equal(launched.length, 0);
        await commandHandler?.("--dag goal.dag.json", controllerCtx);
        assert.equal(launched.length, 2);
        assert.equal(prompts.length, 1);
        assert.match(prompts[0] ?? "", /Do first/);
        assert.doesNotMatch(prompts[0] ?? "", /Do second/);
        assert.match(notifications.at(-1) ?? "", /planned 2 DAG node\(s\); started 1 subagent\(s\)/);
        assert.match(notifications.at(-1) ?? "", /DAG:/);
        const dagNodes = mirrored.filter((entry) => entry.kind === "goal_dag_node");
        assert.equal(dagNodes.length, 7);
        assert.deepEqual(dagNodes.map((entry) => entry.node?.lifecyclePhase).filter(Boolean), ["acceptanceDefined", "resourcesCreating", "resourcesReady", "runnerStarting", "runnerActive"]);
    }
    finally {
        setPiBackgroundGoalSessionLauncherForTests();
        if (previousStateHome === undefined)
            delete process.env.AGENT_GOAL_STATE_HOME;
        else
            process.env.AGENT_GOAL_STATE_HOME = previousStateHome;
        rmSync(dir, { recursive: true, force: true });
        rmSync(workspace, { recursive: true, force: true });
    }
});
test("Pi DAG model routing selects controller and subagent models", async () => {
    const dir = mkdtempSync(join(tmpdir(), "goal-dag-model-routing-"));
    const workspace = createGitWorkspace();
    const previousStateHome = process.env.AGENT_GOAL_STATE_HOME;
    const previousPollMs = process.env.AGENT_GOAL_PI_CONTROLLER_POLL_MS;
    process.env.AGENT_GOAL_STATE_HOME = dir;
    process.env.AGENT_GOAL_PI_CONTROLLER_POLL_MS = "0";
    let commandHandler;
    const launched = [];
    const dagFile = join(workspace, "models.dag.json");
    writeFileSync(dagFile, JSON.stringify({
        version: 1,
        objective: "Route model scenarios",
        modelRouting: {
            scenarios: {
                controller: { modelClass: "controller" },
                implementation: { modelClass: "implementation" },
                docs: { modelClass: "implementation" },
            },
            controllerScenario: "controller",
            defaultSubagentScenario: "implementation",
            rules: [{ scenario: "docs", when: { scopes: ["docs"], risks: ["low"] } }],
        },
        nodes: [{ id: "docs-node", objective: "Update docs", scope: "docs", risk: "low" }],
    }));
    setPiBackgroundGoalSessionLauncherForTests(async (request) => {
        launched.push(request);
        return {
            sessionFile: request.sessionFile ?? join(dir, `model-session-${launched.length}.jsonl`),
            sessionId: request.sessionId ?? `model-session-${launched.length}`,
            setSessionName: async () => undefined,
            sendPrompt: async () => undefined,
            isAlive: () => true,
            stop: () => undefined,
        };
    });
    const pi = {
        registerTool() { },
        registerCommand(_name, options) {
            commandHandler = options.handler;
        },
        on() { },
        appendEntry() { },
        sendMessage() { },
        getThinkingLevel: () => "xhigh",
    };
    const controllerCtx = {
        hasUI: true,
        cwd: workspace,
        model: { provider: "fallback", id: "model" },
        ui: {
            notify() { },
            setStatus() { },
            setWidget() { },
            confirm: async () => true,
            editor: async () => undefined,
            select: async () => undefined,
            custom: async () => undefined,
        },
        sessionManager: {
            getSessionFile: () => "/controller/session.jsonl",
            getSessionName: () => "controller",
        },
        isIdle: () => true,
        hasPendingMessages: () => false,
    };
    try {
        goalPiExtension(pi);
        assert.ok(commandHandler);
        await commandHandler?.("--dag models.dag.json", controllerCtx);
        assert.equal(launched.length, 2);
        assert.equal(launched[0]?.modelArg, "openai-codex/gpt-5.5");
        assert.equal(launched[0]?.thinkingLevel, "xhigh");
        assert.equal(launched[1]?.modelArg, "deepseek/deepseek-v4-flash");
        assert.equal(launched[1]?.thinkingLevel, "xhigh");
    }
    finally {
        setPiBackgroundGoalSessionLauncherForTests();
        if (previousStateHome === undefined)
            delete process.env.AGENT_GOAL_STATE_HOME;
        else
            process.env.AGENT_GOAL_STATE_HOME = previousStateHome;
        if (previousPollMs === undefined)
            delete process.env.AGENT_GOAL_PI_CONTROLLER_POLL_MS;
        else
            process.env.AGENT_GOAL_PI_CONTROLLER_POLL_MS = previousPollMs;
        rmSync(dir, { recursive: true, force: true });
        rmSync(workspace, { recursive: true, force: true });
    }
});
test("Pi orchestrated goal start can auto-allocate a controller worktree", async () => {
    const dir = mkdtempSync(join(tmpdir(), "goal-orchestrated-auto-"));
    const workspace = createGitWorkspace();
    const previousStateHome = process.env.AGENT_GOAL_STATE_HOME;
    process.env.AGENT_GOAL_STATE_HOME = dir;
    let commandHandler;
    const launched = [];
    const notifications = [];
    setPiBackgroundGoalSessionLauncherForTests(async (request) => {
        launched.push(request);
        return {
            sessionFile: request.sessionFile ?? join(dir, `auto-session-${launched.length}.jsonl`),
            sessionId: request.sessionId ?? `auto-session-${launched.length}`,
            setSessionName: async () => undefined,
            sendPrompt: async () => undefined,
            isAlive: () => true,
            stop: () => undefined,
        };
    });
    const pi = {
        registerTool() { },
        registerCommand(_name, options) {
            commandHandler = options.handler;
        },
        on() { },
        appendEntry() { },
        sendMessage() { },
    };
    const controllerCtx = {
        hasUI: true,
        cwd: workspace,
        model: { provider: "test", id: "model" },
        ui: {
            notify(message) {
                notifications.push(message);
            },
            setStatus() { },
            setWidget() { },
            confirm: async () => true,
            editor: async () => undefined,
            select: async () => undefined,
            custom: async () => undefined,
        },
        sessionManager: {
            getSessionFile: () => "/controller/session.jsonl",
            getSessionName: () => "controller",
        },
        isIdle: () => true,
        hasPendingMessages: () => false,
    };
    try {
        goalPiExtension(pi);
        assert.ok(commandHandler);
        await commandHandler?.("Implement auto workspace", controllerCtx);
        assert.equal(launched.length, 2);
        assert.notEqual(launched[0]?.cwd, workspace);
        assert.match(launched[0]?.cwd ?? "", /\.worktrees/);
        assert.match(git(launched[0]?.cwd ?? workspace, ["branch", "--show-current"]), /^goal\//);
        assert.match(notifications.at(-1) ?? "", /planned 1 DAG node\(s\); started 1 subagent\(s\)/);
    }
    finally {
        setPiBackgroundGoalSessionLauncherForTests();
        if (previousStateHome === undefined)
            delete process.env.AGENT_GOAL_STATE_HOME;
        else
            process.env.AGENT_GOAL_STATE_HOME = previousStateHome;
        rmSync(dir, { recursive: true, force: true });
        rmSync(workspace, { recursive: true, force: true });
    }
});
test("Pi goal start defaults to orchestration and target lifecycle commands use goal ids", async () => {
    const dir = mkdtempSync(join(tmpdir(), "goal-session-context-"));
    const workspace = createGitWorkspace();
    const previousStateHome = process.env.AGENT_GOAL_STATE_HOME;
    process.env.AGENT_GOAL_STATE_HOME = dir;
    const goalSessionFile = join(dir, "goal-session.jsonl");
    let commandHandler;
    const handlers = new Map();
    const prompts = [];
    const sentMessages = [];
    const stopped = [];
    const launched = [];
    setPiBackgroundGoalSessionLauncherForTests(async (request) => {
        launched.push(request);
        return {
            sessionFile: goalSessionFile,
            sessionId: request.sessionId ?? "resumed-session",
            setSessionName: async () => undefined,
            sendPrompt: async (prompt) => {
                prompts.push(prompt);
            },
            isAlive: () => true,
            stop: () => stopped.push(request.sessionId ?? "resumed-session"),
        };
    });
    const pi = {
        registerTool() { },
        registerCommand(_name, options) {
            commandHandler = options.handler;
        },
        on(event, handler) {
            const list = handlers.get(event) ?? [];
            list.push(handler);
            handlers.set(event, list);
        },
        appendEntry() { },
        sendMessage(message) {
            sentMessages.push(message);
        },
    };
    const notifications = [];
    const controllerCtx = {
        hasUI: true,
        cwd: workspace,
        model: { provider: "test", id: "model" },
        ui: {
            notify(message) {
                notifications.push(message);
            },
            setStatus() { },
            setWidget() { },
            confirm: async () => true,
            editor: async () => undefined,
            select: async () => undefined,
            custom: async () => undefined,
        },
        sessionManager: {
            getSessionFile: () => "/controller/session.jsonl",
            getSessionName: () => "controller",
        },
        isIdle: () => true,
        hasPendingMessages: () => false,
        newSession: async () => {
            throw new Error("newSession should not be used for background goals");
        },
        switchSession: async () => {
            throw new Error("switchSession should not be used for background goal lifecycle commands");
        },
    };
    try {
        goalPiExtension(pi);
        assert.ok(commandHandler);
        await commandHandler?.("history abc123", controllerCtx);
        assert.match(notifications.at(-1) ?? "", /history was removed/);
        await commandHandler?.("workspace list", controllerCtx);
        assert.match(notifications.at(-1) ?? "", /workspace profiles were removed/);
        await commandHandler?.(`--workspace ${workspace} --branch main write a small story`, controllerCtx);
        assert.equal(launched.length, 2);
        assert.equal(launched[0]?.cwd, workspace);
        assert.equal(launched[0]?.modelArg, "openai-codex/gpt-5.5");
        assert.equal(prompts.length, 1);
        assert.match(prompts[0] ?? "", /SUBAGENT_RESULT/);
        const shortId = notifications.at(-1)?.match(/\(([0-9a-f]{8})\)/)?.[1];
        assert.match(notifications.at(-1) ?? "", /controller session started/);
        assert.ok(shortId);
        await commandHandler?.("", controllerCtx);
        const statusNotification = notifications.at(-1) ?? "";
        assert.match(statusNotification, new RegExp(`Goal ${shortId}`));
        assert.match(statusNotification, /Objective:\n  /);
        assert.match(statusNotification, /Workspace:\n  path:/);
        assert.match(statusNotification, /DAG summary:\n  nodes:/);
        assert.match(statusNotification, /DAG nodes:\n  1\. \[running\]/);
        assert.match(statusNotification, /subagents:\n       - \[running\]/);
        await commandHandler?.(`resume ${shortId}`, controllerCtx);
        assert.equal(launched.length, 2);
        assert.equal(prompts.length, 1);
        assert.match(notifications.at(-1) ?? "", /controller poller recovered/);
        await commandHandler?.(`pause ${shortId}`, controllerCtx);
        await commandHandler?.(`resume ${shortId}`, controllerCtx);
        assert.equal(launched.length, 2);
        assert.equal(prompts.length, 1);
        assert.match(notifications.at(-1) ?? "", /controller poller recovered/);
        for (const handler of handlers.get("session_shutdown") ?? [])
            await handler({ type: "session_shutdown", reason: "quit" });
        // Session shutdown cleans up lingering controller + subagent adapter handles, but DAG resume must not create a duplicate resumed-session handle.
        assert.ok(stopped.length >= 2, `expected at least 2 stopped handles, got ${stopped.length}: ${JSON.stringify(stopped)}`);
        assert.equal(stopped.some((s) => s === "resumed-session"), false, "DAG resume must not launch a duplicate controller session");
        assert.ok(stopped.some((s) => s.startsWith("subagent-")), "expected subagent handle to be stopped");
    }
    finally {
        setPiBackgroundGoalSessionLauncherForTests();
        if (previousStateHome === undefined)
            delete process.env.AGENT_GOAL_STATE_HOME;
        else
            process.env.AGENT_GOAL_STATE_HOME = previousStateHome;
        rmSync(dir, { recursive: true, force: true });
        rmSync(workspace, { recursive: true, force: true });
    }
});
test("goal-owned /goal start does not trigger foreground hidden continuation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "goal-pi-no-continue-"));
    const previousStateHome = process.env.AGENT_GOAL_STATE_HOME;
    process.env.AGENT_GOAL_STATE_HOME = dir;
    const workspace = createGitWorkspace();
    let commandHandler;
    const handlers = new Map();
    const launched = [];
    const prompts = [];
    const sentMessages = [];
    setPiBackgroundGoalSessionLauncherForTests(async (request) => {
        launched.push({ sessionName: request.sessionName ?? "" });
        const sessionFile = join(dir, `subagent-${launched.length}.jsonl`);
        writeFileSync(sessionFile, "");
        return {
            sessionFile,
            sessionId: request.sessionId ?? `subagent-${launched.length}`,
            setSessionName: async () => undefined,
            sendPrompt: async (prompt) => {
                prompts.push(prompt);
                writeFileSync(sessionFile, JSON.stringify({
                    type: "message",
                    timestamp: new Date().toISOString(),
                    message: { role: "assistant", content: [{ type: "text", text: "SUBAGENT_RESULT: done" }] },
                }));
            },
            isAlive: () => true,
            stop: () => undefined,
        };
    });
    const pi = {
        registerTool() { },
        registerCommand(_name, options) {
            commandHandler = options.handler;
        },
        on(event, handler) {
            const list = handlers.get(event) ?? [];
            list.push(handler);
            handlers.set(event, list);
        },
        appendEntry() { },
        sendMessage(_message, options) {
            sentMessages.push({ options });
        },
    };
    const notifications = [];
    const controllerCtx = {
        hasUI: true,
        cwd: workspace,
        model: { provider: "test", id: "model" },
        ui: {
            notify(message) { notifications.push(message); },
            setStatus() { },
            setWidget() { },
            confirm: async () => true,
            editor: async () => undefined,
            select: async () => undefined,
            custom: async () => undefined,
        },
        sessionManager: {
            createSession: async () => ({
                id: `background-${launched.length}`,
                title: "background",
                cwd: workspace,
                resolveSessionFile: () => join(dir, "background.jsonl"),
                async sendPrompt() { },
                async stop() { },
                async setTitle() { },
            }),
            listSessions: async () => [],
            getSession: async () => undefined,
            stopSession: async () => undefined,
        },
        getSessionDirectory: () => dir,
        isIdle: () => true,
        hasPendingMessages: () => false,
        saveSession() { },
        openSession() { },
    };
    try {
        goalPiExtension(pi);
        assert.ok(commandHandler);
        await commandHandler?.(`--workspace ${workspace} --branch main Implement orchestrated goal`, controllerCtx);
        const triggerTurnCalls = sentMessages.filter((entry) => entry.options?.triggerTurn === true);
        assert.equal(triggerTurnCalls.length, 0, "goal-owned start must not trigger foreground hidden continuation");
        assert.ok(prompts.length >= 1, "subagent must be launched");
        assert.match(prompts[0] ?? "", /SUBAGENT_RESULT/);
    }
    finally {
        setPiBackgroundGoalSessionLauncherForTests();
        if (previousStateHome === undefined)
            delete process.env.AGENT_GOAL_STATE_HOME;
        else
            process.env.AGENT_GOAL_STATE_HOME = previousStateHome;
        rmSync(dir, { recursive: true, force: true });
        rmSync(workspace, { recursive: true, force: true });
    }
});
test("goal-owned /goal --dag start does not trigger foreground hidden continuation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "goal-pi-dag-no-continue-"));
    const previousStateHome = process.env.AGENT_GOAL_STATE_HOME;
    process.env.AGENT_GOAL_STATE_HOME = dir;
    const workspace = createGitWorkspace();
    const dagFile = join(workspace, "test.dag.json");
    writeFileSync(dagFile, JSON.stringify({
        version: 1,
        objective: "ship feature",
        nodes: [{ id: "node-1", objective: "Implement feature" }],
    }));
    git(workspace, ["add", "test.dag.json"]);
    git(workspace, ["commit", "-m", "add dag"]);
    let commandHandler;
    const handlers = new Map();
    const launched = [];
    const prompts = [];
    const sentMessages = [];
    setPiBackgroundGoalSessionLauncherForTests(async (request) => {
        launched.push({ sessionName: request.sessionName ?? "" });
        const sessionFile = join(dir, `subagent-${launched.length}.jsonl`);
        writeFileSync(sessionFile, "");
        return {
            sessionFile,
            sessionId: request.sessionId ?? `subagent-${launched.length}`,
            setSessionName: async () => undefined,
            sendPrompt: async (prompt) => {
                prompts.push(prompt);
                writeFileSync(sessionFile, JSON.stringify({
                    type: "message",
                    timestamp: new Date().toISOString(),
                    message: { role: "assistant", content: [{ type: "text", text: "SUBAGENT_RESULT: done" }] },
                }));
            },
            isAlive: () => true,
            stop: () => undefined,
        };
    });
    const pi = {
        registerTool() { },
        registerCommand(_name, options) {
            commandHandler = options.handler;
        },
        on(event, handler) {
            const list = handlers.get(event) ?? [];
            list.push(handler);
            handlers.set(event, list);
        },
        appendEntry() { },
        sendMessage(_message, options) {
            sentMessages.push({ options });
        },
    };
    const notifications = [];
    const controllerCtx = {
        hasUI: true,
        cwd: workspace,
        model: { provider: "test", id: "model" },
        ui: {
            notify(message) { notifications.push(message); },
            setStatus() { },
            setWidget() { },
            confirm: async () => true,
            editor: async () => undefined,
            select: async () => undefined,
            custom: async () => undefined,
        },
        sessionManager: {
            createSession: async () => ({
                id: `background-${launched.length}`,
                title: "background",
                cwd: workspace,
                resolveSessionFile: () => join(dir, "background.jsonl"),
                async sendPrompt() { },
                async stop() { },
                async setTitle() { },
            }),
            listSessions: async () => [],
            getSession: async () => undefined,
            stopSession: async () => undefined,
        },
        getSessionDirectory: () => dir,
        isIdle: () => true,
        hasPendingMessages: () => false,
        saveSession() { },
        openSession() { },
    };
    try {
        goalPiExtension(pi);
        assert.ok(commandHandler);
        await commandHandler?.(`--workspace ${workspace} --branch main --dag test.dag.json`, controllerCtx);
        const triggerTurnCalls = sentMessages.filter((entry) => entry.options?.triggerTurn === true);
        assert.equal(triggerTurnCalls.length, 0, "goal-owned --dag start must not trigger foreground hidden continuation");
        assert.ok(prompts.length >= 1, "subagent must be launched for DAG node");
        assert.match(prompts[0] ?? "", /SUBAGENT_RESULT/);
    }
    finally {
        setPiBackgroundGoalSessionLauncherForTests();
        if (previousStateHome === undefined)
            delete process.env.AGENT_GOAL_STATE_HOME;
        else
            process.env.AGENT_GOAL_STATE_HOME = previousStateHome;
        rmSync(dir, { recursive: true, force: true });
        rmSync(workspace, { recursive: true, force: true });
    }
});
test("goal-owned /goal --dag in print mode hands off to detached controller and preserves runners on shutdown", async () => {
    const dir = mkdtempSync(join(tmpdir(), "goal-pi-dag-print-handoff-"));
    const previousStateHome = process.env.AGENT_GOAL_STATE_HOME;
    process.env.AGENT_GOAL_STATE_HOME = dir;
    const workspace = createGitWorkspace();
    const dagFile = join(workspace, "test.dag.json");
    writeFileSync(dagFile, JSON.stringify({
        version: 1,
        objective: "ship print-mode feature",
        nodes: [{ id: "node-1", objective: "Implement print-mode feature" }],
    }));
    git(workspace, ["add", "test.dag.json"]);
    git(workspace, ["commit", "-m", "add dag"]);
    let commandHandler;
    const handlers = new Map();
    const launched = [];
    const prompts = [];
    const promptOptions = [];
    const stopped = [];
    setPiBackgroundGoalSessionLauncherForTests(async (request) => {
        launched.push({ sessionId: request.sessionId, sessionFile: request.sessionFile, sessionName: request.sessionName ?? "" });
        const index = launched.length;
        const sessionFile = request.sessionFile ?? join(dir, `print-handoff-session-${index}.jsonl`);
        writeFileSync(sessionFile, "");
        const sessionId = request.sessionId ?? `print-handoff-session-${index}`;
        return {
            sessionFile,
            sessionId,
            setSessionName: async () => undefined,
            sendPrompt: async (prompt, options) => {
                prompts.push(prompt);
                promptOptions.push(options);
                writeFileSync(sessionFile, JSON.stringify({
                    type: "message",
                    timestamp: new Date().toISOString(),
                    message: { role: "assistant", content: [{ type: "text", text: "SUBAGENT_RESULT: done" }] },
                }));
            },
            isAlive: () => true,
            stop: () => stopped.push(sessionId),
        };
    });
    const pi = {
        registerTool() { },
        registerCommand(_name, options) {
            commandHandler = options.handler;
        },
        on(event, handler) {
            const list = handlers.get(event) ?? [];
            list.push(handler);
            handlers.set(event, list);
        },
        appendEntry() { },
        sendMessage() { },
    };
    const notifications = [];
    const controllerCtx = {
        mode: "print",
        hasUI: false,
        cwd: workspace,
        model: { provider: "test", id: "model" },
        ui: {
            notify(message) { notifications.push(message); },
            setStatus() { },
            setWidget() { },
            confirm: async () => true,
            editor: async () => undefined,
            select: async () => undefined,
            custom: async () => undefined,
        },
        sessionManager: {
            getSessionFile: () => "/origin/session.jsonl",
            getSessionName: () => "origin",
        },
        isIdle: () => true,
        hasPendingMessages: () => false,
    };
    try {
        goalPiExtension(pi);
        assert.ok(commandHandler);
        await commandHandler?.(`--workspace ${workspace} --branch main --dag test.dag.json`, controllerCtx);
        assert.equal(launched.length, 2, "controller and first subagent runners should launch");
        assert.match(prompts[0] ?? "", /SUBAGENT_RESULT/);
        assert.match(prompts.at(-1) ?? "", /^\/goal resume [0-9a-f-]{36}$/);
        assert.equal(promptOptions.at(-1)?.requireSessionFile, false, "controller handoff is an extension command and must not require a transcript write before staying alive");
        for (const handler of handlers.get("session_shutdown") ?? [])
            await handler({ type: "session_shutdown", reason: "quit" });
        assert.deepEqual(stopped, [], "print-mode foreground shutdown must not stop detached goal runners");
        assert.match(notifications.at(-1) ?? "", /Goal-owned controller session started/);
    }
    finally {
        setPiBackgroundGoalSessionLauncherForTests();
        if (previousStateHome === undefined)
            delete process.env.AGENT_GOAL_STATE_HOME;
        else
            process.env.AGENT_GOAL_STATE_HOME = previousStateHome;
        rmSync(dir, { recursive: true, force: true });
        rmSync(workspace, { recursive: true, force: true });
    }
});
//# sourceMappingURL=pi-adapter-tools.test.js.map