import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export interface BackgroundGoalSessionLaunchRequest {
  cwd: string;
  sessionId?: string;
  sessionFile?: string;
  sessionName: string;
  modelArg?: string;
}

export interface BackgroundGoalSessionHandle {
  sessionFile: string;
  sessionId: string;
  setSessionName(name: string): Promise<void>;
  sendPrompt(prompt: string): Promise<void>;
  stop(): void;
}

export type BackgroundGoalSessionLauncher = (request: BackgroundGoalSessionLaunchRequest) => Promise<BackgroundGoalSessionHandle>;

const BACKGROUND_SESSION_START_TIMEOUT_MS = 15_000;

export async function launchPiRpcBackgroundGoalSession(request: BackgroundGoalSessionLaunchRequest): Promise<BackgroundGoalSessionHandle> {
  const runId = randomUUID();
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-goal-runtime-bg-"));
  const configPath = path.join(runDir, "config.json");
  const readyPath = path.join(runDir, "ready.json");
  const commandPath = path.join(runDir, "command.json");
  const logPath = path.join(runDir, "runner.log");
  const runnerPath = fileURLToPath(new URL("./background-runner.js", import.meta.url));
  if (!request.sessionId && !request.sessionFile) throw new Error("Background goal session launch requires a session id or session file");
  const config = {
    runId,
    cwd: request.cwd,
    sessionId: request.sessionId,
    sessionFile: request.sessionFile,
    sessionName: request.sessionName,
    modelArg: request.modelArg,
    cliPath: process.argv[1] ?? "pi",
    readyPath,
    commandPath,
    logPath,
  };
  fs.writeFileSync(configPath, JSON.stringify(config), "utf8");

  const runner = spawn(process.execPath, [runnerPath, configPath], {
    cwd: request.cwd,
    env: process.env,
    detached: true,
    stdio: "ignore",
  });
  runner.unref();

  try {
    const ready = await waitForBackgroundRunnerReady(readyPath, logPath, BACKGROUND_SESSION_START_TIMEOUT_MS);
    let pendingSessionName = request.sessionName;
    return {
      sessionFile: ready.sessionFile,
      sessionId: ready.sessionId,
      setSessionName: async (name: string) => {
        pendingSessionName = name;
      },
      sendPrompt: async (prompt: string) => {
        fs.writeFileSync(commandPath, JSON.stringify({ sessionName: pendingSessionName, prompt }), "utf8");
      },
      stop: () => stopDetachedProcessGroup(ready.runnerPid),
    };
  } catch (error) {
    stopDetachedProcessGroup(runner.pid);
    throw error;
  }
}

async function waitForBackgroundRunnerReady(readyPath: string, logPath: string, timeoutMs: number): Promise<{ sessionFile: string; sessionId: string; runnerPid?: number }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const parsed = JSON.parse(fs.readFileSync(readyPath, "utf8")) as Record<string, unknown>;
      if (typeof parsed.sessionFile === "string" && typeof parsed.sessionId === "string") {
        return {
          sessionFile: parsed.sessionFile,
          sessionId: parsed.sessionId,
          runnerPid: typeof parsed.runnerPid === "number" ? parsed.runnerPid : undefined,
        };
      }
    } catch {
      // Not ready yet.
    }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for detached background Pi session to start${readLogTail(logPath)}`);
}

function stopDetachedProcessGroup(pid: number | undefined): void {
  if (!pid) return;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Already stopped.
    }
  }
}

function readLogTail(logPath: string): string {
  try {
    const tail = fs.readFileSync(logPath, "utf8").slice(-2_000).trim();
    return tail ? `: ${tail}` : "";
  } catch {
    return "";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
