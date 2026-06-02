import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import goalPiExtension, { setPiBackgroundGoalSessionLauncherForTests } from "../adapters/pi/index.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
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
    assert.match(notifications.at(-1) ?? "", new RegExp(`Goal ${shortId}`));
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
