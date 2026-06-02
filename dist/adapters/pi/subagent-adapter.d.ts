import type { GoalSubagentRecord, HarnessSubagentAbortRequest, HarnessSubagentAdapter, HarnessSubagentPromptRequest, HarnessSubagentSessionState, HarnessSubagentStartRequest, HarnessSubagentStartResult, HarnessSubagentStateRequest } from "../../core/index.js";
import { type BackgroundGoalSessionLauncher } from "./background-session.js";
export interface PiHarnessSubagentAdapterOptions {
    launcher?: BackgroundGoalSessionLauncher;
    modelArg?: string;
    now?: () => Date;
}
export interface PiSubagentSessionInspectionOptions {
    readFile?: (path: string) => string;
    exists?: (path: string) => boolean;
    live?: boolean;
}
export declare class PiHarnessSubagentAdapter implements HarnessSubagentAdapter {
    readonly adapterId = "pi";
    private readonly launcher;
    private readonly modelArg?;
    private readonly now;
    private readonly handles;
    constructor(options?: PiHarnessSubagentAdapterOptions);
    startSession(request: HarnessSubagentStartRequest): Promise<HarnessSubagentStartResult>;
    sendPrompt(request: HarnessSubagentPromptRequest): Promise<void>;
    getSessionState(request: HarnessSubagentStateRequest): HarnessSubagentSessionState;
    abortSession(request: HarnessSubagentAbortRequest): Promise<void>;
    private launchForExistingSubagent;
    private rememberHandle;
    private stopExistingHandle;
}
export declare function createPiHarnessSubagentAdapter(options?: PiHarnessSubagentAdapterOptions): PiHarnessSubagentAdapter;
export declare function renderPiSubagentInitialPrompt(request: HarnessSubagentStartRequest): string;
export declare function readPiSubagentSessionState(subagent: GoalSubagentRecord, options?: PiSubagentSessionInspectionOptions): HarnessSubagentSessionState;
