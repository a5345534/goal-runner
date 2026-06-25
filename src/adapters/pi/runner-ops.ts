import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { GoalSubagentRecord } from "../../core/index.js";
import { resolveDefaultStateRoot } from "../../core/index.js";

export interface PiBackgroundRunnerRecord {
  runnerDir: string;
  configPath: string;
  readyPath?: string;
  commandPath?: string;
  logPath?: string;
  runId?: string;
  sessionName?: string;
  modelArg?: string;
  thinkingLevel?: string;
  cwd?: string;
  sessionFile?: string;
  sessionId?: string;
  runnerPid?: number;
  childPid?: number;
  runnerAlive: boolean;
  childAlive: boolean;
  subagentId?: string;
  nodeId?: string;
  goalId?: string;
}

export interface PiBackgroundRunnerOperationResult {
  operation: "stop" | "kill" | "archive";
  matched: number;
  signaled: number;
  archived: number;
  skippedLive: number;
  archiveDir?: string;
  messages: string[];
}

interface RunnerConfigLike {
  runId?: string;
  cwd?: string;
  sessionFile?: string;
  sessionId?: string;
  sessionName?: string;
  modelArg?: string;
  thinkingLevel?: string;
  readyPath?: string;
  commandPath?: string;
  logPath?: string;
}

interface RunnerReadyLike {
  sessionFile?: string;
  sessionId?: string;
  runnerPid?: number;
  childPid?: number;
}

export const PI_BACKGROUND_RUNNER_DIR_PREFIX = "goal-runner-bg-";
export const PI_LEGACY_BACKGROUND_RUNNER_DIR_PREFIX = "agent-goal-runtime-bg-";

function isPiBackgroundRunnerDirName(entry: string): boolean {
  return entry.startsWith(PI_BACKGROUND_RUNNER_DIR_PREFIX) || entry.startsWith(PI_LEGACY_BACKGROUND_RUNNER_DIR_PREFIX);
}

export function readPiBackgroundRunnerInventory(
  goalId: string,
  subagents: GoalSubagentRecord[],
  options: { tmpRoot?: string; workspaceRoots?: string[]; sessionFiles?: string[] } = {},
): PiBackgroundRunnerRecord[] {
  const tmpRoot = options.tmpRoot ?? os.tmpdir();
  let entries: string[];
  try {
    entries = fs.readdirSync(tmpRoot);
  } catch {
    return [];
  }
  const records: PiBackgroundRunnerRecord[] = [];
  for (const entry of entries) {
    if (!isPiBackgroundRunnerDirName(entry)) continue;
    const runnerDir = path.join(tmpRoot, entry);
    const configPath = path.join(runnerDir, "config.json");
    const config = readJson<RunnerConfigLike>(configPath);
    if (!config) continue;
    const readyPath = config.readyPath ?? path.join(runnerDir, "ready.json");
    const ready = readJson<RunnerReadyLike>(readyPath) ?? {};
    const sessionFile = ready.sessionFile ?? config.sessionFile;
    const sessionId = ready.sessionId ?? config.sessionId;
    const match = matchSubagent(goalId, subagents, {
      sessionName: config.sessionName,
      sessionFile,
      cwd: config.cwd,
      sessionId,
    });
    const workspaceMatch = pathWithinAnyRoot(config.cwd, options.workspaceRoots ?? []);
    const sessionFileMatch = Boolean(sessionFile && (options.sessionFiles ?? []).includes(sessionFile));
    if (!match && !workspaceMatch && !sessionFileMatch && !pathMentionsGoal(config.cwd, goalId) && !pathMentionsGoal(sessionFile, goalId) && !pathMentionsGoal(config.sessionName, goalId)) continue;
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
      thinkingLevel: config.thinkingLevel,
      cwd: config.cwd,
      sessionFile,
      sessionId,
      runnerPid,
      childPid,
      runnerAlive: isPidAlive(runnerPid),
      childAlive: isPidAlive(childPid),
      subagentId: match?.subagentId ?? parseSubagentId(config.sessionName),
      nodeId: match?.nodeId,
      goalId: match?.goalId ?? (workspaceMatch || sessionFileMatch || pathMentionsGoal(config.cwd, goalId) || pathMentionsGoal(sessionFile, goalId) ? goalId : undefined),
    });
  }
  return records.sort((left, right) => left.runnerDir.localeCompare(right.runnerDir));
}

export function signalPiBackgroundRunners(
  records: PiBackgroundRunnerRecord[],
  operation: "stop" | "kill",
): PiBackgroundRunnerOperationResult {
  const signal = operation === "stop" ? "SIGTERM" : "SIGKILL";
  const messages: string[] = [];
  let signaled = 0;
  const seen = new Set<number>();
  for (const record of records) {
    for (const pid of [record.runnerPid, record.childPid]) {
      if (!pid || seen.has(pid) || !isPidAlive(pid)) continue;
      seen.add(pid);
      try {
        process.kill(pid, signal);
        signaled += 1;
        messages.push(`${signal} pid ${pid}`);
      } catch (error) {
        messages.push(`failed to ${signal} pid ${pid}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  return { operation, matched: records.length, signaled, archived: 0, skippedLive: 0, messages };
}

export function archivePiBackgroundRunnerDirs(
  records: PiBackgroundRunnerRecord[],
  options: { archiveRoot?: string; now?: Date } = {},
): PiBackgroundRunnerOperationResult {
  const archiveRoot = options.archiveRoot ?? path.join(resolveDefaultStateRoot(), "runner-archives");
  const stamp = (options.now ?? new Date()).toISOString().replace(/[:.]/g, "").replace(/Z$/, "Z");
  const archiveDir = path.join(archiveRoot, `${PI_BACKGROUND_RUNNER_DIR_PREFIX}${stamp}-${randomUUID().slice(0, 8)}`);
  const messages: string[] = [];
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
      moveRunnerDirToArchive(record.runnerDir, destination);
      archived += 1;
      messages.push(`archived ${record.runnerDir} -> ${destination}`);
    } catch (error) {
      messages.push(`failed to archive ${record.runnerDir}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { operation: "archive", matched: records.length, signaled: 0, archived, skippedLive, archiveDir, messages };
}

export function filterPiBackgroundRunnersForSubagent(records: PiBackgroundRunnerRecord[], subagentId: string): PiBackgroundRunnerRecord[] {
  return records.filter((record) => record.subagentId === subagentId);
}

function moveRunnerDirToArchive(source: string, destination: string): void {
  try {
    fs.renameSync(source, destination);
  } catch (error) {
    if (!isCrossDeviceRenameError(error)) throw error;
    fs.cpSync(source, destination, { recursive: true, errorOnExist: true, force: false });
    fs.rmSync(source, { recursive: true, force: true });
  }
}

function isCrossDeviceRenameError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "EXDEV";
}

function matchSubagent(
  goalId: string,
  subagents: GoalSubagentRecord[],
  candidate: { sessionName?: string; sessionFile?: string; cwd?: string; sessionId?: string },
): GoalSubagentRecord | undefined {
  const goalSubagents = subagents.filter((subagent) => subagent.goalId === goalId);
  if (candidate.sessionFile) {
    const sessionFileMatch = goalSubagents.find((subagent) => subagent.sessionFile === candidate.sessionFile);
    if (sessionFileMatch) return sessionFileMatch;
  }
  if (candidate.cwd) {
    const cwdMatch = goalSubagents.find((subagent) => subagent.workspacePath === candidate.cwd);
    if (cwdMatch) return cwdMatch;
  }
  if (candidate.sessionId) {
    const sessionIdMatches = goalSubagents.filter((subagent) => subagent.sessionId === candidate.sessionId);
    if (sessionIdMatches.length === 1) return sessionIdMatches[0];
  }

  // Subagent ids are intentionally stable across goal retries/DAG runs (for
  // example "subagent-decide-contract-names").  A stale tmp runner from an
  // older goal can therefore have the same sessionName-derived subagent id as
  // the current goal.  Treat the parsed id as an identity hint only when some
  // goal-scoped evidence corroborates it; otherwise inventory would attach old
  // dead runner dirs to fresh goals.
  const parsedSubagentId = parseSubagentId(candidate.sessionName);
  if (parsedSubagentId && candidateMentionsGoal(candidate, goalId)) {
    const parsedMatch = goalSubagents.find((subagent) => subagent.subagentId === parsedSubagentId);
    if (parsedMatch) return parsedMatch;
  }
  return undefined;
}

function candidateMentionsGoal(candidate: { sessionName?: string; sessionFile?: string; cwd?: string; sessionId?: string }, goalId: string): boolean {
  return pathMentionsGoal(candidate.cwd, goalId)
    || pathMentionsGoal(candidate.sessionFile, goalId)
    || pathMentionsGoal(candidate.sessionName, goalId)
    || pathMentionsGoal(candidate.sessionId, goalId);
}

function parseSubagentId(sessionName: string | undefined): string | undefined {
  return sessionName?.match(/\bsubagent\s+([^:\s]+)(?::|\s|$)/)?.[1];
}

function pathMentionsGoal(value: string | undefined, goalId: string): boolean {
  if (!value) return false;
  return value.includes(goalId) || value.includes(goalId.slice(0, 8)) || value.includes(goalId.slice(0, 12));
}

function pathWithinAnyRoot(value: string | undefined, roots: string[]): boolean {
  if (!value) return false;
  const normalizedValue = path.resolve(value);
  return roots.some((root) => {
    if (!root) return false;
    const normalizedRoot = path.resolve(root);
    return normalizedValue === normalizedRoot || normalizedValue.startsWith(`${normalizedRoot}${path.sep}`);
  });
}

function readJson<T>(file: string | undefined): T | undefined {
  if (!file) return undefined;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isPidAlive(pid: number | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
