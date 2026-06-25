import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { normalizePiModelArg } from "./model-args.js";
import { isPiGoalSessionEntryType } from "./session-store.js";
const TERMINAL_GOAL_STATUSES = new Set(["complete", "blocked", "paused", "budgetLimited", "usageLimited"]);
const configPath = process.argv[2];
if (!configPath) {
    process.stderr.write("Missing background runner config path\n");
    process.exit(1);
}
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
function log(message) {
    try {
        fs.appendFileSync(config.logPath, `[${new Date().toISOString()}] ${message}\n`, "utf8");
    }
    catch {
        // Ignore logging failures; the parent will time out if startup fails.
    }
}
class RpcClient {
    child;
    nextId = 0;
    stdoutBuffer = "";
    stderrTail = "";
    pending = new Map();
    constructor(child) {
        this.child = child;
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk) => this.handleStdout(chunk));
        child.stderr.on("data", (chunk) => this.captureStderr(chunk));
        child.on("error", (error) => this.rejectAll(error instanceof Error ? error : new Error(String(error))));
        child.on("exit", (code, signal) => {
            this.rejectAll(new Error(`Pi RPC child exited (code=${code ?? "null"}, signal=${signal ?? "null"})${this.stderrTail ? `: ${this.stderrTail}` : ""}`));
            process.exit(code ?? (signal ? 1 : 0));
        });
    }
    request(command, params = {}, timeoutMs = 60_000) {
        const id = `goal-runner-${++this.nextId}`;
        const payload = { id, type: command, ...params };
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`Timed out waiting for Pi RPC command '${command}'${this.stderrTail ? `: ${this.stderrTail}` : ""}`));
            }, timeoutMs);
            this.pending.set(id, { resolve, reject, timer });
            this.child.stdin.write(`${JSON.stringify(payload)}\n`, (error) => {
                if (!error)
                    return;
                clearTimeout(timer);
                this.pending.delete(id);
                reject(error instanceof Error ? error : new Error(String(error)));
            });
        });
    }
    stop() {
        for (const item of this.pending.values())
            clearTimeout(item.timer);
        this.pending.clear();
        this.child.stdin.end();
        setTimeout(() => {
            if (!this.child.killed)
                this.child.kill("SIGTERM");
        }, 1_000).unref?.();
    }
    handleStdout(chunk) {
        this.stdoutBuffer += chunk;
        let newline = this.stdoutBuffer.indexOf("\n");
        while (newline >= 0) {
            const line = this.stdoutBuffer.slice(0, newline).trim();
            this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
            if (line)
                this.handleLine(line);
            newline = this.stdoutBuffer.indexOf("\n");
        }
    }
    handleLine(line) {
        let parsed;
        try {
            parsed = JSON.parse(line);
        }
        catch {
            return;
        }
        if (parsed.type === "response" && typeof parsed.id === "string") {
            const pending = this.pending.get(parsed.id);
            if (!pending)
                return;
            clearTimeout(pending.timer);
            this.pending.delete(parsed.id);
            if (parsed.success === false)
                pending.reject(new Error(parsed.error ?? `Pi RPC command '${parsed.command ?? parsed.id}' failed`));
            else
                pending.resolve(parsed);
            return;
        }
        if (isTerminalGoalStateEvent(parsed)) {
            log("Goal reached terminal state; stopping background runner");
            this.stop();
            process.exit(0);
        }
    }
    captureStderr(chunk) {
        this.stderrTail = `${this.stderrTail}${chunk}`.slice(-2_000).trim();
        if (chunk.trim())
            log(`stderr: ${chunk.trim()}`);
    }
    rejectAll(error) {
        log(error.message);
        for (const item of this.pending.values()) {
            clearTimeout(item.timer);
            item.reject(error);
        }
        this.pending.clear();
    }
}
function isTerminalGoalStateEvent(event) {
    if (event.type !== "custom" || !isPiGoalSessionEntryType(event.customType))
        return false;
    const data = event.data;
    if (!data || typeof data !== "object")
        return false;
    if (data.kind === "goal_cleared")
        return true;
    if (data.kind !== "goal_snapshot")
        return false;
    const goal = data.goal;
    return typeof goal?.status === "string" && TERMINAL_GOAL_STATUSES.has(goal.status);
}
async function waitForCommand() {
    for (;;) {
        try {
            const parsed = JSON.parse(fs.readFileSync(config.commandPath, "utf8"));
            if (typeof parsed.commandId === "string" && typeof parsed.prompt === "string") {
                return {
                    commandId: parsed.commandId,
                    sessionName: typeof parsed.sessionName === "string" ? parsed.sessionName : undefined,
                    prompt: parsed.prompt,
                };
            }
        }
        catch {
            // Parent has not written the command yet.
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
}
async function waitForSessionFile(sessionFile, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const stats = fs.statSync(sessionFile);
            if (stats.isFile() && stats.size > 0)
                return;
        }
        catch {
            // Session file not created yet.
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Pi RPC child accepted prompt but did not create session file: ${sessionFile}`);
}
function writeCommandAck(commandId, payload) {
    fs.writeFileSync(config.commandAckPath, JSON.stringify({ commandId, ...payload }), "utf8");
}
function shutdown(client) {
    client.stop();
    setTimeout(() => process.exit(0), 1_200).unref?.();
}
async function main() {
    log(`Starting detached goal runner ${config.runId}`);
    const args = [config.cliPath, "--mode", "rpc"];
    if (config.sessionFile)
        args.push("--session", config.sessionFile);
    else if (config.sessionId)
        args.push("--session-id", config.sessionId);
    else
        throw new Error("Background runner config requires sessionId or sessionFile");
    args.push("--name", config.sessionName);
    const modelArg = normalizePiModelArg(config.modelArg);
    if (modelArg)
        args.push("--model", modelArg);
    if (config.thinkingLevel)
        args.push("--thinking", config.thinkingLevel);
    const child = spawn(process.execPath, args, {
        cwd: config.cwd,
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
    });
    const client = new RpcClient(child);
    process.on("SIGTERM", () => shutdown(client));
    process.on("SIGINT", () => shutdown(client));
    process.on("SIGHUP", () => shutdown(client));
    const state = await client.request("get_state", {}, 15_000);
    const sessionFile = typeof state.data?.sessionFile === "string" ? state.data.sessionFile : undefined;
    const sessionId = typeof state.data?.sessionId === "string" ? state.data.sessionId : (config.sessionId ?? "");
    if (!sessionFile)
        throw new Error("Pi RPC child did not report a session file");
    fs.writeFileSync(config.readyPath, JSON.stringify({ sessionFile, sessionId, runnerPid: process.pid, childPid: child.pid }), "utf8");
    const command = await waitForCommand();
    if (command.sessionName)
        await client.request("set_session_name", { name: command.sessionName });
    await client.request("prompt", { message: command.prompt });
    await waitForSessionFile(sessionFile, 10_000);
    writeCommandAck(command.commandId, { ok: true, sessionFile, sessionId });
    log("Initial goal prompt accepted by background Pi RPC session");
    await new Promise(() => undefined);
}
main().catch((error) => {
    log(error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error));
    process.exit(1);
});
//# sourceMappingURL=background-runner.js.map