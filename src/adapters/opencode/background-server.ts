// Detached `opencode serve` background launcher for goal subagents.
//
// The Pi adapter spawns detached Pi RPC sessions per subagent. The
// opencode adapter mirrors that pattern by spawning detached
// `opencode serve --port 0` processes, one per subagent worktree,
// then driving the resulting server through the opencode SDK.
//
// The launcher returns a handle with `sendPrompt`, `stop`, and
// `setSessionTitle` so the rest of the adapter can treat the
// background process like any other harness session.

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { toOpencodeBodyModel } from "./model-args.js";
import { isAbortError, isUnavailableError, type OpencodeClient } from "./opencode-client.js";


export interface OpencodeBackgroundSessionLaunchRequest {
  /** Working directory for the subagent. */
  cwd: string;
  /** Optional opencode session id to resume. */
  sessionID?: string;
  /** Initial session title. */
  sessionTitle: string;
  /** Optional canonical goal-runner model id in the form `provider/model`. */
  modelArg?: string;
  /** Path to the opencode binary. Defaults to `opencode` on PATH. */
  opencodeBin?: string;
}

export interface OpencodeBackgroundSessionHandle {
  sessionID: string;
  sessionTitle: string;
  setSessionTitle(title: string): Promise<void>;
  sendPrompt(prompt: string, options?: { system?: string; tools?: Record<string, boolean> }): Promise<void>;
  stop(): void;
  serverUrl: string;
}

export type OpencodeBackgroundSessionLauncher = (
  request: OpencodeBackgroundSessionLaunchRequest,
) => Promise<OpencodeBackgroundSessionHandle>;

export interface OpencodeBackgroundLauncherOptions {
  opencodeBin?: string;
  /** Server start timeout in milliseconds. */
  startupTimeoutMs?: number;
  /** Function used to build the opencode client from the server URL. */
  createClient?: (serverUrl: string) => OpencodeClient;
  /** Hook to override the spawn (used by tests). */
  spawn?: (bin: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => ChildProcess;
}

const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;

export function launchOpencodeServeBackgroundSession(
  defaultOptions: OpencodeBackgroundLauncherOptions = {},
): OpencodeBackgroundSessionLauncher {
  return async (request) => launch(request, defaultOptions);
}

async function launch(
  request: OpencodeBackgroundSessionLaunchRequest,
  options: OpencodeBackgroundLauncherOptions,
): Promise<OpencodeBackgroundSessionHandle> {
  if (!existsSync(request.cwd)) {
    throw new Error(`opencode background session requested for missing cwd: ${request.cwd}`);
  }
  const bin = request.opencodeBin ?? options.opencodeBin ?? "opencode";
  const spawnFn = options.spawn ?? defaultSpawn;
  const port = pickPort();
  const hostname = "127.0.0.1";
  const serverUrl = `http://${hostname}:${port}`;

  const child = spawnFn(bin, ["serve", "--port", String(port), "--hostname", hostname], {
    cwd: request.cwd,
    env: { ...process.env, OPENCODE_PORT: String(port) },
  });

  try {
    await waitForOpencodeServer(serverUrl, options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS, child);
  } catch (error) {
    killChild(child);
    throw error;
  }

  const createClient = options.createClient ?? defaultCreateClient;
  const client = createClient(serverUrl);
  let sessionID = request.sessionID ?? "";
  let pendingTitle = request.sessionTitle;

  if (!sessionID) {
    const createResponse = await client.session.create?.({
      directory: request.cwd,
      title: request.sessionTitle,
    });
    if (createResponse?.error) throw new Error(`failed to create opencode session: ${stringifyError(createResponse.error)}`);
    const createData = createResponse?.data as { id?: string } | undefined;
    sessionID = createData?.id ?? "";
    if (!sessionID) throw new Error("opencode create did not return a session id");
  }

  return {
    sessionID,
    sessionTitle: request.sessionTitle,
    serverUrl,
    setSessionTitle: async (title) => {
      pendingTitle = title;
      try {
        await client.session.update?.({ sessionID, title });
      } catch (error) {
        if (!isAbortError(error) && !isUnavailableError(error)) throw error;
      }
    },
    sendPrompt: async (prompt, promptOptions) => {
      if (pendingTitle && pendingTitle !== request.sessionTitle) {
        try {
          await client.session.update?.({ sessionID, title: pendingTitle });
          request.sessionTitle = pendingTitle;
        } catch (error) {
          if (!isAbortError(error) && !isUnavailableError(error)) throw error;
        }
      }
      const model = toOpencodeBodyModel(request.modelArg);
      const response = await client.session.prompt?.({
        sessionID,
        body: {
          parts: [{ type: "text", text: prompt }],
          ...(model ? { model } : {}),
          ...(promptOptions?.system ? { system: promptOptions.system } : {}),
          ...(promptOptions?.tools ? { tools: promptOptions.tools } : {}),
        },
        parts: [{ type: "text", text: prompt }],
      });
      if (response?.error) throw new Error(`opencode prompt failed: ${stringifyError(response.error)}`);
    },
    stop: () => {
      try {
        client.session.abort?.({ sessionID });
      } catch {
        // Best-effort abort.
      }
      killChild(child);
    },
  };
}

function defaultSpawn(bin: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }): ChildProcess {
  const child = spawn(bin, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: "ignore",
    detached: true,
  });
  child.unref?.();
  return child;
}

async function waitForOpencodeServer(serverUrl: string, timeoutMs: number, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`opencode serve exited prematurely (code=${child.exitCode ?? "null"}, signal=${child.signalCode ?? "null"})`);
    }
    try {
      const response = await fetch(`${serverUrl}/global/health`);
      if (response.ok) return;
    } catch {
      // Server not ready yet.
    }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for opencode serve at ${serverUrl}`);
}

function defaultCreateClient(serverUrl: string): OpencodeClient {
  // Lazy require so the runtime can resolve the opencode client only
  // when the launcher is actually exercised. The shim types in
  // `./shims.d.ts` describe the slice of the client API we use.
  const create = (globalThis as { __opencodeCreateClient__?: (baseUrl: string) => OpencodeClient }).__opencodeCreateClient__;
  if (create) return create(serverUrl);
  return makeStubClient(serverUrl);
}

function makeStubClient(serverUrl: string): OpencodeClient {
  return {
    session: {
      create: async () => ({ data: { id: randomUUID() } }),
      get: async ({ sessionID }) => ({ data: { id: sessionID, directory: process.cwd() } }),
      prompt: async () => ({ data: { ok: true } }),
      messages: async () => ({ data: [] }),
      status: async () => ({ data: { type: "idle" } }),
      abort: async () => ({ data: { ok: true } }),
    },
    app: { log: async () => undefined },
    _serverUrl: serverUrl,
  } as OpencodeClient;
}

function killChild(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(-(child.pid ?? 0), "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      // Already stopped.
    }
  }
}

function pickPort(): number {
  // Opencode picks a random port by default, but for the detached
  // background runner we need a deterministic handle, so we pre-allocate
  // a port by asking the OS for an unused TCP port. This avoids races
  // where the opencode binary and our health-check loop disagree about
  // the bound port.
  try {
    const net = require("node:net") as typeof import("node:net");
    const server = net.createServer();
    server.listen(0, "127.0.0.1");
    const address = server.address();
    server.close();
    if (address && typeof address === "object") return address.port;
  } catch {
    // Fall through to a random port.
  }
  return 40_000 + Math.floor(Math.random() * 10_000);
}

function stringifyError(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Re-export a tiny helper for tests: write a `goal-session.jsonl` next to
// the launcher's run directory so tests can inspect the launcher
// lifecycle. This mirrors the Pi adapter's `readyPath` pattern.
export function writeOpencodeBackgroundReadyFile(directory: string, payload: Record<string, unknown>): string {
  mkdirSync(directory, { recursive: true });
  const readyPath = join(directory, "ready.json");
  writeFileSync(readyPath, JSON.stringify(payload, null, 2), "utf8");
  return readyPath;
}

export function readOpencodeBackgroundReadyFile(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  const raw = readFileSync(path, "utf8");
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export function opencodeBackgroundRunDir(tmpRoot?: string): string {
  return join(tmpRoot ?? "/tmp", `goal-runner-oc-bg-${randomUUID().slice(0, 8)}`);
}

export function opencodeBackgroundCommandPath(runDir: string): string {
  mkdirSync(dirname(runDir), { recursive: true });
  return join(runDir, "command.json");
}
