import type { GoalSubagentRecord } from "../../core/index.js";
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
export declare const PI_BACKGROUND_RUNNER_DIR_PREFIX = "goal-runner-bg-";
export declare const PI_LEGACY_BACKGROUND_RUNNER_DIR_PREFIX = "agent-goal-runtime-bg-";
export declare function readPiBackgroundRunnerInventory(goalId: string, subagents: GoalSubagentRecord[], options?: {
    tmpRoot?: string;
    workspaceRoots?: string[];
    sessionFiles?: string[];
}): PiBackgroundRunnerRecord[];
export declare function signalPiBackgroundRunners(records: PiBackgroundRunnerRecord[], operation: "stop" | "kill"): PiBackgroundRunnerOperationResult;
export declare function archivePiBackgroundRunnerDirs(records: PiBackgroundRunnerRecord[], options?: {
    archiveRoot?: string;
    now?: Date;
}): PiBackgroundRunnerOperationResult;
export declare function filterPiBackgroundRunnersForSubagent(records: PiBackgroundRunnerRecord[], subagentId: string): PiBackgroundRunnerRecord[];
