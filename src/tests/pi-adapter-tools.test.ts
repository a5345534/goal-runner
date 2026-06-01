import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import goalPiExtension from "../adapters/pi/index.js";

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

test("Pi goal-owned session creation binds callbacks to replacement session context", async () => {
  const dir = mkdtempSync(join(tmpdir(), "goal-session-context-"));
  const workspace = mkdtempSync(join(tmpdir(), "goal-workspace-"));
  const previousStateHome = process.env.AGENT_GOAL_STATE_HOME;
  process.env.AGENT_GOAL_STATE_HOME = dir;
  let commandHandler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
  const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
  const sentMessages: string[] = [];
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

  let controllerInvalid = false;
  const stale = () => {
    if (controllerInvalid) throw new Error("stale controller context used");
  };
  const ui = {
    notify: () => stale(),
    setStatus: () => stale(),
    setWidget: () => stale(),
    confirm: async () => true,
    editor: async () => undefined,
    select: async () => undefined,
    custom: async () => undefined,
  };
  const controllerCtx = {
    hasUI: true,
    cwd: workspace,
    ui,
    sessionManager: {
      getSessionFile: () => "/controller/session.jsonl",
      getSessionName: () => "controller",
    },
    isIdle: () => {
      stale();
      return true;
    },
    hasPendingMessages: () => {
      stale();
      return false;
    },
    newSession: async (options: { setup?: (sessionManager: { appendSessionInfo(name: string): void }) => Promise<void>; withSession?: (ctx: unknown) => Promise<void> }) => {
      await options.setup?.({ appendSessionInfo() {} });
      controllerInvalid = true;
      const goalCtx = {
        hasUI: true,
        cwd: workspace,
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
          getSessionFile: () => "/goal/session.jsonl",
          getSessionName: () => "goal",
          appendSessionInfo() {},
        },
        isIdle: () => true,
        hasPendingMessages: () => false,
        sendUserMessage: async (content: string) => {
          sentMessages.push(content);
        },
      };
      await options.withSession?.(goalCtx);
      return { cancelled: false };
    },
  };

  try {
    goalPiExtension(pi as never);
    assert.ok(commandHandler);
    await commandHandler?.(`--workspace ${workspace} write a small story`, controllerCtx as never);
    assert.equal(sentMessages.length, 1);
    assert.match(sentMessages[0] ?? "", /Execution workspace binding/);
    for (const handler of handlers.get("session_shutdown") ?? []) await handler();
  } finally {
    if (previousStateHome === undefined) delete process.env.AGENT_GOAL_STATE_HOME;
    else process.env.AGENT_GOAL_STATE_HOME = previousStateHome;
    rmSync(dir, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});
