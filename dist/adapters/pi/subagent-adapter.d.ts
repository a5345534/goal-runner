import type { GoalSubagentRecord, HarnessSubagentAbortRequest, HarnessSubagentAdapter, HarnessSubagentPromptRequest, HarnessSubagentSessionState, HarnessSubagentStartRequest, HarnessSubagentStartResult, HarnessSubagentStateRequest } from "../../core/index.js";
import { type BackgroundGoalSessionLauncher } from "./background-session.js";
export interface PiHarnessSubagentAdapterOptions {
    launcher?: BackgroundGoalSessionLauncher;
    modelArg?: string;
    now?: () => Date;
    /** Override for tests or alternate hosts; defaults to /tmp background-runner inventory. */
    runnerAlive?: (subagent: GoalSubagentRecord) => boolean;
}
export interface PiSubagentSessionInspectionOptions {
    readFile?: (path: string) => string;
    exists?: (path: string) => boolean;
    live?: boolean;
    now?: () => Date;
    staleAfterMs?: number;
}
export declare class PiHarnessSubagentAdapter implements HarnessSubagentAdapter {
    readonly adapterId = "pi";
    private readonly launcher;
    private readonly modelArg?;
    private readonly now;
    private readonly runnerAlive;
    private readonly handles;
    constructor(options?: PiHarnessSubagentAdapterOptions);
    startSession(request: HarnessSubagentStartRequest): Promise<HarnessSubagentStartResult>;
    sendPrompt(request: HarnessSubagentPromptRequest): Promise<void>;
    getSessionState(request: HarnessSubagentStateRequest): HarnessSubagentSessionState;
    abortSession(request: HarnessSubagentAbortRequest): Promise<void>;
    /** Stop all tracked subagent background sessions and clear the handle map. */
    abortAll(): void;
    private launchForExistingSubagent;
    private rememberHandle;
    private stopExistingHandle;
}
export declare function createPiHarnessSubagentAdapter(options?: PiHarnessSubagentAdapterOptions): PiHarnessSubagentAdapter;
export declare function renderPiSubagentInitialPrompt(request: HarnessSubagentStartRequest): string;
export declare function readPiSubagentSessionState(subagent: GoalSubagentRecord, options?: PiSubagentSessionInspectionOptions): HarnessSubagentSessionState;
export declare function extractQuestionMarkerFromPi(text: string | undefined): string | undefined;
