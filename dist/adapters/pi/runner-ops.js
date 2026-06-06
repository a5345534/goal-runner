import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveDefaultStateRoot } from "../../core/index.js";
export function readPiBackgroundRunnerInventory(goalId, subagents, options = {}) {
    const tmpRoot = options.tmpRoot ?? os.tmpdir();
    let entries;
    try {
        entries = fs.readdirSync(tmpRoot);
    }
    catch {
        return [];
    }
    const records = [];
    for (const entry of entries) {
        if (!entry.startsWith("agent-goal-runtime-bg-"))
            continue;
        const runnerDir = path.join(tmpRoot, entry);
        const configPath = path.join(runnerDir, "config.json");
        const config = readJson(configPath);
        if (!config)
            continue;
        const readyPath = config.readyPath ?? path.join(runnerDir, "ready.json");
        const ready = readJson(readyPath) ?? {};
        const sessionFile = ready.sessionFile ?? config.sessionFile;
        const sessionId = ready.sessionId ?? config.sessionId;
        const match = matchSubagent(goalId, subagents, {
            sessionName: config.sessionName,
            sessionFile,
            cwd: config.cwd,
            sessionId,
        });
        if (!match && !pathMentionsGoal(config.cwd, goalId) && !pathMentionsGoal(sessionFile, goalId) && !pathMentionsGoal(config.sessionName, goalId))
            continue;
        const runnerPid = numberOrUndefined(ready.runnerPid);
        const childPid = numberOrUndefined(ready.childPid);
        records.push({
            runnerDir,
            configPath,
            readyPath,
            commandPath: config.commandPath,
            logPath: config.logPath,
            runId: config.runId,
            sessionName: config.sessionName,
            modelArg: config.modelArg,
            cwd: config.cwd,
            sessionFile,
            sessionId,
            runnerPid,
            childPid,
            runnerAlive: isPidAlive(runnerPid),
            childAlive: isPidAlive(childPid),
            subagentId: match?.subagentId ?? parseSubagentId(config.sessionName),
            nodeId: match?.nodeId,
            goalId: match?.goalId ?? (pathMentionsGoal(config.cwd, goalId) || pathMentionsGoal(sessionFile, goalId) ? goalId : undefined),
        });
    }
    return records.sort((left, right) => left.runnerDir.localeCompare(right.runnerDir));
}
export function signalPiBackgroundRunners(records, operation) {
    const signal = operation === "stop" ? "SIGTERM" : "SIGKILL";
    const messages = [];
    let signaled = 0;
    const seen = new Set();
    for (const record of records) {
        for (const pid of [record.runnerPid, record.childPid]) {
            if (!pid || seen.has(pid) || !isPidAlive(pid))
                continue;
            seen.add(pid);
            try {
                process.kill(pid, signal);
                signaled += 1;
                messages.push(`${signal} pid ${pid}`);
            }
            catch (error) {
                messages.push(`failed to ${signal} pid ${pid}: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }
    return { operation, matched: records.length, signaled, archived: 0, skippedLive: 0, messages };
}
export function archivePiBackgroundRunnerDirs(records, options = {}) {
    const archiveRoot = options.archiveRoot ?? path.join(resolveDefaultStateRoot(), "runner-archives");
    const stamp = (options.now ?? new Date()).toISOString().replace(/[:.]/g, "").replace(/Z$/, "Z");
    const archiveDir = path.join(archiveRoot, `agent-goal-runtime-bg-${stamp}-${randomUUID().slice(0, 8)}`);
    const messages = [];
    let archived = 0;
    let skippedLive = 0;
    for (const record of records) {
        if (isPidAlive(record.runnerPid) || isPidAlive(record.childPid)) {
            skippedLive += 1;
            messages.push(`skip live runner dir ${record.runnerDir}`);
            continue;
        }
        try {
            fs.mkdirSync(archiveDir, { recursive: true });
            const destination = path.join(archiveDir, path.basename(record.runnerDir));
            fs.renameSync(record.runnerDir, destination);
            archived += 1;
            messages.push(`archived ${record.runnerDir} -> ${destination}`);
        }
        catch (error) {
            messages.push(`failed to archive ${record.runnerDir}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    return { operation: "archive", matched: records.length, signaled: 0, archived, skippedLive, archiveDir, messages };
}
export function filterPiBackgroundRunnersForSubagent(records, subagentId) {
    return records.filter((record) => record.subagentId === subagentId);
}
function matchSubagent(goalId, subagents, candidate) {
    const goalSubagents = subagents.filter((subagent) => subagent.goalId === goalId);
    const parsedSubagentId = parseSubagentId(candidate.sessionName);
    if (parsedSubagentId) {
        const parsedMatch = goalSubagents.find((subagent) => subagent.subagentId === parsedSubagentId);
        if (parsedMatch)
            return parsedMatch;
    }
    if (candidate.sessionFile) {
        const sessionFileMatch = goalSubagents.find((subagent) => subagent.sessionFile === candidate.sessionFile);
        if (sessionFileMatch)
            return sessionFileMatch;
    }
    if (candidate.cwd) {
        const cwdMatch = goalSubagents.find((subagent) => subagent.workspacePath === candidate.cwd);
        if (cwdMatch)
            return cwdMatch;
    }
    if (candidate.sessionId) {
        const sessionIdMatches = goalSubagents.filter((subagent) => subagent.sessionId === candidate.sessionId);
        if (sessionIdMatches.length === 1)
            return sessionIdMatches[0];
    }
    return undefined;
}
function parseSubagentId(sessionName) {
    return sessionName?.match(/\bsubagent\s+([^:\s]+)(?::|\s|$)/)?.[1];
}
function pathMentionsGoal(value, goalId) {
    if (!value)
        return false;
    return value.includes(goalId) || value.includes(goalId.slice(0, 8));
}
function readJson(file) {
    if (!file)
        return undefined;
    try {
        return JSON.parse(fs.readFileSync(file, "utf8"));
    }
    catch {
        return undefined;
    }
}
function numberOrUndefined(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
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
//# sourceMappingURL=runner-ops.js.map