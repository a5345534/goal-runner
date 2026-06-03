import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import goalPiExtension, { setPiBackgroundGoalSessionLauncherForTests } from "../adapters/pi/index.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function waitForAssertion(assertion: () => void, timeoutMs = 1_500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await delay(20);
    }
  }
  if (lastError) throw lastError;
  assertion();
}

function createGitWorkspace(): string {
  const repo = mkdtempSync(join(tmpdir(), "goal-pi-orchestrate-workspace-"));
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "goal@example.test"]);
  git(repo, ["config", "user.name", "Goal Test"]);
  writeFileSync(join(repo, "README.md"), "# fixture\n");
  git(repo, ["add", "README.md"]);
  git(repo, ["commit", "-m", "initial"]);
  return repo;
}

test("Pi adapter keeps model-visible goal tools Codex-compatible", async () => {
  const dir = mkdtempSync(join(tmpdir(), "goal-tools-"));
  const previousStateHome = process.env.AGENT_GOAL_STATE_HOME;
  process.env.AGENT_GOAL_STATE_HOME = dir;
  const tools: Array<{ name: string }> = [];
  const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
  const pi = {
    registerTool(tool: { name: string }) {
      tools.push(tool);
    },
    registerCommand() {},
    on(event: string, handler: (...args: unknown[]) => unknown) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    appendEntry() {},
    sendMessage() {},
  };

  try {
    goalPiExtension(pi as never);
    assert.deepEqual(tools.map((tool) => tool.name).sort(), ["create_goal", "get_goal", "update_goal"]);
    for (const handler of handlers.get("session_shutdown") ?? []) await handler();
  } finally {
    if (previousStateHome === undefined) delete process.env.AGENT_GOAL_STATE_HOME;
    else process.env.AGENT_GOAL_STATE_HOME = previousStateHome;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Pi orchestrated goal start plans DAG and launches a subagent worktree", async () => {
  const dir = mkdtempSync(join(tmpdir(), "goal-orchestrated-session-"));
  const workspace = createGitWorkspace();
  const previousStateHome = process.env.AGENT_GOAL_STATE_HOME;
  process.env.AGENT_GOAL_STATE_HOME = dir;
  let commandHandler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
  const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
  const prompts: string[] = [];
  const launched: Array<{ cwd: string; sessionId?: string; sessionFile?: string; sessionName: string; modelArg?: string }> = [];
  const mirrored: Array<Record<string, unknown>> = [];
  setPiBackgroundGoalSessionLauncherForTests(async (request) => {
    launched.push(request);
    const index = launched.length;
    return {
      sessionFile: request.sessionFile ?? join(dir, `session-${index}.jsonl`),
      sessionId: request.sessionId ?? `session-${index}`,
      setSessionName: async () => undefined,
      sendPrompt: async (prompt: string) => {
        prompts.push(prompt);
      },
      stop: () => undefined,
    };
  });
  const pi = {
    registerTool() {},
    registerCommand(_name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) {
      commandHandler = options.handler;
    },
    on(event: string, handler: (...args: unknown[]) => unknown) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    appendEntry(_type: string, data: Record<string, unknown>) {
      mirrored.push(data);
    },
    sendMessage() {},
  };
  const notifications: string[] = [];
  const controllerCtx = {
    hasUI: true,
    cwd: workspace,
    model: { provider: "test", id: "model" },
    ui: {
      notify(message: string) {
        notifications.push(message);
      },
      setStatus() {},
      setWidget() {},
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
    goalPiExtension(pi as never);
    assert.ok(commandHandler);
    await commandHandler?.(`--workspace ${workspace} --branch main Implement orchestrated goal`, controllerCtx as never);

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
    for (const handler of handlers.get("session_shutdown") ?? []) await handler({ type: "session_shutdown", reason: "quit" });
  } finally {
    setPiBackgroundGoalSessionLauncherForTests();
    if (previousStateHome === undefined) delete process.env.AGENT_GOAL_STATE_HOME;
    else process.env.AGENT_GOAL_STATE_HOME = previousStateHome;
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
  let commandHandler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
  const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
  const launched: Array<{ cwd: string; sessionId?: string; sessionFile?: string; sessionName: string; modelArg?: string }> = [];
  setPiBackgroundGoalSessionLauncherForTests(async (request) => {
    launched.push(request);
    const index = launched.length;
    const sessionFile = request.sessionFile ?? join(dir, `closeout-session-${index}.jsonl`);
    return {
      sessionFile,
      sessionId: request.sessionId ?? `closeout-session-${index}`,
      setSessionName: async () => undefined,
      sendPrompt: async () => {
        if (!request.sessionName.startsWith("subagent ")) return;
        writeFileSync(
          sessionFile,
          [
            JSON.stringify({ type: "session", timestamp: "2026-06-02T00:00:00.000Z", cwd: request.cwd }),
            JSON.stringify({
              type: "message",
              timestamp: "2026-06-02T00:00:01.000Z",
              message: {
                role: "assistant",
                content: [{ type: "text", text: "SUBAGENT_RESULT: completed and verified" }],
              },
            }),
          ].join("\n"),
        );
      },
      stop: () => undefined,
    };
  });
  const pi = {
    registerTool() {},
    registerCommand(_name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) {
      commandHandler = options.handler;
    },
    on(event: string, handler: (...args: unknown[]) => unknown) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    appendEntry() {},
    sendMessage() {},
  };
  const statuses: string[] = [];
  const widgets: string[][] = [];
  const controllerCtx = {
    hasUI: true,
    cwd: workspace,
    model: { provider: "test", id: "model" },
    ui: {
      notify() {},
      setStatus(_name: string, value?: string) {
        if (value) statuses.push(value);
      },
      setWidget(_name: string, value?: string[]) {
        if (value) widgets.push(value);
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
    goalPiExtension(pi as never);
    assert.ok(commandHandler);
    await commandHandler?.("Implement closeout", controllerCtx as never);

    await waitForAssertion(() => assert.equal(statuses.at(-1), "🎯 complete"));
    assert.equal(launched.length, 2);
    assert.notEqual(launched[0]?.cwd, workspace);
    assert.equal(existsSync(launched[0]?.cwd ?? ""), false);
    assert.equal(existsSync(launched[1]?.cwd ?? ""), false);
    assert.match(widgets.at(-1)?.[0] ?? "", /^\/goal complete:/);
    for (const handler of handlers.get("session_shutdown") ?? []) await handler({ type: "session_shutdown", reason: "quit" });
  } finally {
    setPiBackgroundGoalSessionLauncherForTests();
    if (previousStateHome === undefined) delete process.env.AGENT_GOAL_STATE_HOME;
    else process.env.AGENT_GOAL_STATE_HOME = previousStateHome;
    if (previousPollMs === undefined) delete process.env.AGENT_GOAL_PI_CONTROLLER_POLL_MS;
    else process.env.AGENT_GOAL_PI_CONTROLLER_POLL_MS = previousPollMs;
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
  let commandHandler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
  const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
  const launched: Array<{ cwd: string; sessionId?: string; sessionFile?: string; sessionName: string; modelArg?: string }> = [];
  setPiBackgroundGoalSessionLauncherForTests(async (request) => {
    launched.push(request);
    const index = launched.length;
    const sessionFile = request.sessionFile ?? join(dir, `recovery-session-${index}.jsonl`);
    return {
      sessionFile,
      sessionId: request.sessionId ?? `recovery-session-${index}`,
      setSessionName: async () => undefined,
      sendPrompt: async () => {
        if (!request.sessionName.startsWith("subagent ")) return;
        writeFileSync(
          sessionFile,
          [
            JSON.stringify({ type: "session", timestamp: "2026-06-02T00:00:00.000Z", cwd: request.cwd }),
            JSON.stringify({
              type: "message",
              timestamp: "2026-06-02T00:00:01.000Z",
              message: { role: "assistant", content: [{ type: "text", text: "SUBAGENT_RESULT: recovered closeout" }] },
            }),
          ].join("\n"),
        );
      },
      stop: () => undefined,
    };
  });
  const pi = {
    registerTool() {},
    registerCommand(_name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) {
      commandHandler = options.handler;
    },
    on(event: string, handler: (...args: unknown[]) => unknown) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    appendEntry() {},
    sendMessage() {},
  };
  const statuses: string[] = [];
  const controllerCtx = {
    hasUI: true,
    cwd: workspace,
    model: { provider: "test", id: "model" },
    ui: {
      notify() {},
      setStatus(_name: string, value?: string) {
        if (value) statuses.push(value);
      },
      setWidget() {},
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
    goalPiExtension(pi as never);
    assert.ok(commandHandler);
    await commandHandler?.("Implement recoverable closeout", controllerCtx as never);
    await delay(30);
    assert.notEqual(statuses.at(-1), "🎯 complete");
    assert.notEqual(launched[0]?.cwd, workspace);
    assert.equal(existsSync(launched[0]?.cwd ?? ""), true);

    process.env.AGENT_GOAL_PI_CONTROLLER_POLL_MS = "10";
    for (const handler of handlers.get("session_start") ?? []) await handler({}, controllerCtx as never);

    await waitForAssertion(() => assert.equal(statuses.at(-1), "🎯 complete"));
    assert.equal(existsSync(launched[0]?.cwd ?? ""), false);
    assert.equal(existsSync(launched[1]?.cwd ?? ""), false);
    for (const handler of handlers.get("session_shutdown") ?? []) await handler({ type: "session_shutdown", reason: "quit" });
  } finally {
    setPiBackgroundGoalSessionLauncherForTests();
    if (previousStateHome === undefined) delete process.env.AGENT_GOAL_STATE_HOME;
    else process.env.AGENT_GOAL_STATE_HOME = previousStateHome;
    if (previousPollMs === undefined) delete process.env.AGENT_GOAL_PI_CONTROLLER_POLL_MS;
    else process.env.AGENT_GOAL_PI_CONTROLLER_POLL_MS = previousPollMs;
    rmSync(dir, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("Pi goal start can load an explicit DAG file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "goal-dag-file-session-"));
  const workspace = createGitWorkspace();
  const previousStateHome = process.env.AGENT_GOAL_STATE_HOME;
  process.env.AGENT_GOAL_STATE_HOME = dir;
  let commandHandler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
  const prompts: string[] = [];
  const launched: Array<{ cwd: string; sessionId?: string; sessionFile?: string; sessionName: string; modelArg?: string }> = [];
  const mirrored: Array<Record<string, unknown>> = [];
  const dagFile = join(workspace, "goal.dag.json");
  writeFileSync(
    dagFile,
    JSON.stringify({
      version: 1,
      objective: "Run file DAG",
      nodes: [
        { id: "first-node", objective: "Do first", outputs: ["first.txt"] },
        { id: "second-node", objective: "Do second", after: ["first-node"] },
      ],
    }),
  );
  setPiBackgroundGoalSessionLauncherForTests(async (request) => {
    launched.push(request);
    return {
      sessionFile: request.sessionFile ?? join(dir, `dag-session-${launched.length}.jsonl`),
      sessionId: request.sessionId ?? `dag-session-${launched.length}`,
      setSessionName: async () => undefined,
      sendPrompt: async (prompt: string) => {
        prompts.push(prompt);
      },
      stop: () => undefined,
    };
  });
  const pi = {
    registerTool() {},
    registerCommand(_name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) {
      commandHandler = options.handler;
    },
    on() {},
    appendEntry(_type: string, data: Record<string, unknown>) {
      mirrored.push(data);
    },
    sendMessage() {},
  };
  const notifications: string[] = [];
  const controllerCtx = {
    hasUI: true,
    cwd: workspace,
    model: { provider: "test", id: "model" },
    ui: {
      notify(message: string) {
        notifications.push(message);
      },
      setStatus() {},
      setWidget() {},
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
    goalPiExtension(pi as never);
    assert.ok(commandHandler);
    await commandHandler?.("--dag goal.dag.json", controllerCtx as never);

    assert.equal(launched.length, 2);
    assert.equal(prompts.length, 1);
    assert.match(prompts[0] ?? "", /Do first/);
    assert.doesNotMatch(prompts[0] ?? "", /Do second/);
    assert.match(notifications.at(-1) ?? "", /planned 2 DAG node\(s\); started 1 subagent\(s\)/);
    assert.match(notifications.at(-1) ?? "", /DAG:/);
    const dagNodes = mirrored.filter((entry) => entry.kind === "goal_dag_node");
    assert.equal(dagNodes.length, 3);
  } finally {
    setPiBackgroundGoalSessionLauncherForTests();
    if (previousStateHome === undefined) delete process.env.AGENT_GOAL_STATE_HOME;
    else process.env.AGENT_GOAL_STATE_HOME = previousStateHome;
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
  let commandHandler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
  const launched: Array<{ cwd: string; sessionId?: string; sessionFile?: string; sessionName: string; modelArg?: string }> = [];
  const dagFile = join(workspace, "models.dag.json");
  writeFileSync(
    dagFile,
    JSON.stringify({
      version: 1,
      objective: "Route model scenarios",
      modelRouting: {
        scenarios: {
          controller: { model: "controller/model" },
          implementation: { model: "implementation/model" },
          docs: { model: "docs/model" },
        },
        controllerScenario: "controller",
        defaultSubagentScenario: "implementation",
        rules: [{ scenario: "docs", when: { scopes: ["docs"], risks: ["low"] } }],
      },
      nodes: [{ id: "docs-node", objective: "Update docs", scope: "docs", risk: "low" }],
    }),
  );
  setPiBackgroundGoalSessionLauncherForTests(async (request) => {
    launched.push(request);
    return {
      sessionFile: request.sessionFile ?? join(dir, `model-session-${launched.length}.jsonl`),
      sessionId: request.sessionId ?? `model-session-${launched.length}`,
      setSessionName: async () => undefined,
      sendPrompt: async () => undefined,
      stop: () => undefined,
    };
  });
  const pi = {
    registerTool() {},
    registerCommand(_name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) {
      commandHandler = options.handler;
    },
    on() {},
    appendEntry() {},
    sendMessage() {},
  };
  const controllerCtx = {
    hasUI: true,
    cwd: workspace,
    model: { provider: "fallback", id: "model" },
    ui: {
      notify() {},
      setStatus() {},
      setWidget() {},
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
    goalPiExtension(pi as never);
    assert.ok(commandHandler);
    await commandHandler?.("--dag models.dag.json", controllerCtx as never);

    assert.equal(launched.length, 2);
    assert.equal(launched[0]?.modelArg, "controller/model");
    assert.equal(launched[1]?.modelArg, "docs/model");
  } finally {
    setPiBackgroundGoalSessionLauncherForTests();
    if (previousStateHome === undefined) delete process.env.AGENT_GOAL_STATE_HOME;
    else process.env.AGENT_GOAL_STATE_HOME = previousStateHome;
    if (previousPollMs === undefined) delete process.env.AGENT_GOAL_PI_CONTROLLER_POLL_MS;
    else process.env.AGENT_GOAL_PI_CONTROLLER_POLL_MS = previousPollMs;
    rmSync(dir, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("Pi orchestrated goal start can auto-allocate a controller worktree", async () => {
  const dir = mkdtempSync(join(tmpdir(), "goal-orchestrated-auto-"));
  const workspace = createGitWorkspace();
  const previousStateHome = process.env.AGENT_GOAL_STATE_HOME;
  process.env.AGENT_GOAL_STATE_HOME = dir;
  let commandHandler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
  const launched: Array<{ cwd: string; sessionId?: string; sessionFile?: string; sessionName: string; modelArg?: string }> = [];
  const notifications: string[] = [];
  setPiBackgroundGoalSessionLauncherForTests(async (request) => {
    launched.push(request);
    return {
      sessionFile: request.sessionFile ?? join(dir, `auto-session-${launched.length}.jsonl`),
      sessionId: request.sessionId ?? `auto-session-${launched.length}`,
      setSessionName: async () => undefined,
      sendPrompt: async () => undefined,
      stop: () => undefined,
    };
  });
  const pi = {
    registerTool() {},
    registerCommand(_name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) {
      commandHandler = options.handler;
    },
    on() {},
    appendEntry() {},
    sendMessage() {},
  };
  const controllerCtx = {
    hasUI: true,
    cwd: workspace,
    model: { provider: "test", id: "model" },
    ui: {
      notify(message: string) {
        notifications.push(message);
      },
      setStatus() {},
      setWidget() {},
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
    goalPiExtension(pi as never);
    assert.ok(commandHandler);
    await commandHandler?.("Implement auto workspace", controllerCtx as never);
    assert.equal(launched.length, 2);
    assert.notEqual(launched[0]?.cwd, workspace);
    assert.match(launched[0]?.cwd ?? "", /\.worktrees/);
    assert.match(git(launched[0]?.cwd ?? workspace, ["branch", "--show-current"]), /^goal\//);
    assert.match(notifications.at(-1) ?? "", /planned 1 DAG node\(s\); started 1 subagent\(s\)/);
  } finally {
    setPiBackgroundGoalSessionLauncherForTests();
    if (previousStateHome === undefined) delete process.env.AGENT_GOAL_STATE_HOME;
    else process.env.AGENT_GOAL_STATE_HOME = previousStateHome;
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
  let commandHandler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
  const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
  const prompts: string[] = [];
  const sentMessages: Array<{ customType?: string; content?: string; details?: Record<string, unknown> }> = [];
  const stopped: string[] = [];
  const launched: Array<{ cwd: string; sessionId?: string; sessionFile?: string; sessionName: string; modelArg?: string }> = [];
  setPiBackgroundGoalSessionLauncherForTests(async (request) => {
    launched.push(request);
    return {
      sessionFile: goalSessionFile,
      sessionId: request.sessionId ?? "resumed-session",
      setSessionName: async () => undefined,
      sendPrompt: async (prompt: string) => {
        prompts.push(prompt);
      },
      stop: () => stopped.push(request.sessionId ?? "resumed-session"),
    };
  });
  const pi = {
    registerTool() {},
    registerCommand(_name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) {
      commandHandler = options.handler;
    },
    on(event: string, handler: (...args: unknown[]) => unknown) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    appendEntry() {},
    sendMessage(message: { customType?: string; content?: string; details?: Record<string, unknown> }) {
      sentMessages.push(message);
    },
  };

  const notifications: string[] = [];
  const controllerCtx = {
    hasUI: true,
    cwd: workspace,
    model: { provider: "test", id: "model" },
    ui: {
      notify(message: string) {
        notifications.push(message);
      },
      setStatus() {},
      setWidget() {},
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
    goalPiExtension(pi as never);
    assert.ok(commandHandler);
    await commandHandler?.("history abc123", controllerCtx as never);
    assert.match(notifications.at(-1) ?? "", /history was removed/);
    await commandHandler?.("workspace list", controllerCtx as never);
    assert.match(notifications.at(-1) ?? "", /workspace profiles were removed/);
    await commandHandler?.(`--workspace ${workspace} --branch main write a small story`, controllerCtx as never);
    assert.equal(launched.length, 2);
    assert.equal(launched[0]?.cwd, workspace);
    assert.equal(launched[0]?.modelArg, "test/model");
    assert.equal(prompts.length, 1);
    assert.match(prompts[0] ?? "", /SUBAGENT_RESULT/);
    const shortId = notifications.at(-1)?.match(/\(([0-9a-f]{8})\)/)?.[1];
    assert.match(notifications.at(-1) ?? "", /controller session started/);
    assert.ok(shortId);
    await commandHandler?.("", controllerCtx as never);
    const statusNotification = notifications.at(-1) ?? "";
    assert.match(statusNotification, new RegExp(`Goal ${shortId}`));
    assert.match(statusNotification, /Objective:\n  /);
    assert.match(statusNotification, /Workspace:\n  path:/);
    assert.match(statusNotification, /DAG summary:\n  nodes:/);
    assert.match(statusNotification, /DAG nodes:\n  1\. \[running\]/);
    assert.match(statusNotification, /subagents:\n       - \[running\]/);
    await commandHandler?.(`pause ${shortId}`, controllerCtx as never);
    await commandHandler?.(`resume ${shortId}`, controllerCtx as never);
    assert.equal(launched.length, 3);
    assert.equal(launched[2]?.sessionFile, goalSessionFile);
    assert.equal(prompts.length, 2);
    assert.match(prompts[1] ?? "", /Resume working toward the active goal/);
    for (const handler of handlers.get("session_shutdown") ?? []) await handler({ type: "session_shutdown", reason: "quit" });
    assert.deepEqual(stopped, []);
  } finally {
    setPiBackgroundGoalSessionLauncherForTests();
    if (previousStateHome === undefined) delete process.env.AGENT_GOAL_STATE_HOME;
    else process.env.AGENT_GOAL_STATE_HOME = previousStateHome;
    rmSync(dir, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});
