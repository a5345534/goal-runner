import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { PI_BACKGROUND_RUNNER_DIR_PREFIX } from "./runner-ops.js";
const BACKGROUND_SESSION_START_TIMEOUT_MS = 60_000;
const BACKGROUND_PROMPT_ACCEPT_TIMEOUT_MS = 30_000;
export async function launchPiRpcBackgroundGoalSession(request) {
    const runId = randomUUID();
    const runDir = fs.mkdtempSync(path.join(os.tmpdir(), PI_BACKGROUND_RUNNER_DIR_PREFIX));
    const configPath = path.join(runDir, "config.json");
    const readyPath = path.join(runDir, "ready.json");
    const commandPath = path.join(runDir, "command.json");
    const commandAckPath = path.join(runDir, "command-ack.json");
    const logPath = path.join(runDir, "runner.log");
    const runnerPath = fileURLToPath(new URL("./background-runner.js", import.meta.url));
    if (!request.sessionId && !request.sessionFile)
        throw new Error("Background goal session launch requires a session id or session file");
    if (!fs.existsSync(request.cwd))
        throw new Error(`Background goal session cwd does not exist: ${request.cwd}`);
    const config = {
        runId,
        cwd: request.cwd,
        sessionId: request.sessionId,
        sessionFile: request.sessionFile,
        sessionName: request.sessionName,
        modelArg: request.modelArg,
        thinkingLevel: request.thinkingLevel,
        cliPath: process.argv[1] ?? "pi",
        readyPath,
        commandPath,
        commandAckPath,
        logPath,
    };
    fs.writeFileSync(configPath, JSON.stringify(config), "utf8");
    const runner = spawn(process.execPath, [runnerPath, configPath], {
        cwd: request.cwd,
        env: process.env,
        detached: true,
        stdio: "ignore",
    });
    const spawnError = new Promise((_resolve, reject) => {
        runner.once("error", reject);
    });
    const runnerExit = new Promise((_resolve, reject) => {
        runner.once("exit", (code, signal) => {
            reject(new Error(`Detached background Pi runner exited before ready (code=${code ?? "null"}, signal=${signal ?? "null"})${readLogTail(logPath)}`));
        });
    });
    runner.unref();
    try {
        const ready = await Promise.race([
            waitForBackgroundRunnerReady(readyPath, logPath, BACKGROUND_SESSION_START_TIMEOUT_MS),
            spawnError,
            runnerExit,
        ]);
        let pendingSessionName = request.sessionName;
        return {
            sessionFile: ready.sessionFile,
            sessionId: ready.sessionId,
            setSessionName: async (name) => {
                pendingSessionName = name;
            },
            sendPrompt: async (prompt, options = {}) => {
                const commandId = randomUUID();
                const requireSessionFile = options.requireSessionFile !== false;
                try {
                    fs.rmSync(commandAckPath, { force: true });
                }
                catch { /* best-effort stale ack cleanup */ }
                fs.writeFileSync(commandPath, JSON.stringify({ commandId, sessionName: pendingSessionName, prompt, requireSessionFile }), "utf8");
                await waitForBackgroundPromptAccepted({
                    commandAckPath,
                    commandId,
                    sessionFile: ready.sessionFile,
                    requireSessionFile,
                    logPath,
                    runnerPid: ready.runnerPid,
                    childPid: ready.childPid,
                    timeoutMs: BACKGROUND_PROMPT_ACCEPT_TIMEOUT_MS,
                });
            },
            isAlive: () => isPidAlive(ready.runnerPid),
            stop: () => stopDetachedProcessGroup(ready.runnerPid),
        };
    }
    catch (error) {
        stopDetachedProcessGroup(runner.pid);
        throw error;
    }
}
async function waitForBackgroundRunnerReady(readyPath, logPath, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const parsed = JSON.parse(fs.readFileSync(readyPath, "utf8"));
            if (typeof parsed.sessionFile === "string" && typeof parsed.sessionId === "string") {
                return {
                    sessionFile: parsed.sessionFile,
                    sessionId: parsed.sessionId,
                    runnerPid: typeof parsed.runnerPid === "number" ? parsed.runnerPid : undefined,
                    childPid: typeof parsed.childPid === "number" ? parsed.childPid : undefined,
                };
            }
        }
        catch {
            // Not ready yet.
        }
        await sleep(100);
    }
    throw new Error(`Timed out waiting for detached background Pi session to start${readLogTail(logPath)}`);
}
async function waitForBackgroundPromptAccepted(request) {
    const deadline = Date.now() + request.timeoutMs;
    while (Date.now() < deadline) {
        try {
            const parsed = JSON.parse(fs.readFileSync(request.commandAckPath, "utf8"));
            if (parsed.commandId === request.commandId && parsed.ok === true) {
                if (!request.requireSessionFile || sessionFileExists(request.sessionFile))
                    return;
                throw new Error(`Detached background Pi session reported prompt accepted but session file is missing: ${request.sessionFile}${readLogTail(request.logPath)}`);
            }
        }
        catch (error) {
            if (error instanceof SyntaxError) {
                // Ack is being written; retry.
            }
            else if (error instanceof Error && !isMissingFileError(error)) {
                throw error;
            }
        }
        const runnerAlive = isPidAlive(request.runnerPid);
        const childAlive = isPidAlive(request.childPid);
        if (!runnerAlive && !childAlive && (!request.requireSessionFile || !sessionFileExists(request.sessionFile))) {
            throw new Error(`Detached background Pi runner stopped before accepting prompt${request.requireSessionFile ? ` and creating session file: ${request.sessionFile}` : ""}${readLogTail(request.logPath)}`);
        }
        await sleep(100);
    }
    throw new Error(`Timed out waiting for detached background Pi session to accept prompt and create session file: ${request.sessionFile}${readLogTail(request.logPath)}`);
}
function sessionFileExists(sessionFile) {
    try {
        const stats = fs.statSync(sessionFile);
        return stats.isFile() && stats.size > 0;
    }
    catch {
        return false;
    }
}
function isMissingFileError(error) {
    return error.code === "ENOENT";
}
function stopDetachedProcessGroup(pid) {
    if (!pid)
        return;
    try {
        process.kill(-pid, "SIGTERM");
    }
    catch {
        try {
            process.kill(pid, "SIGTERM");
        }
        catch {
            // Already stopped.
        }
    }
}
function isPidAlive(pid) {
    if (!pid || pid <= 0)
        return false;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
function readLogTail(logPath) {
    try {
        const tail = fs.readFileSync(logPath, "utf8").slice(-2_000).trim();
        return tail ? `: ${tail}` : "";
    }
    catch {
        return "";
    }
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
//# sourceMappingURL=background-session.js.map