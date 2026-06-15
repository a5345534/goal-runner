import type { GoalSubagentRecord, HarnessSubagentAbortRequest, HarnessSubagentAdapter, HarnessSubagentPromptRequest, HarnessSubagentSessionState, HarnessSubagentStartRequest, HarnessSubagentStartResult, HarnessSubagentStateRequest } from "../../core/index.js";
import type { OpencodeBackgroundSessionLauncher } from "./background-server.js";
import { readOpencodeSessionMessages } from "./session-transcript.js";
export interface OpencodeHarnessSubagentAdapterOptions {
    launcher?: OpencodeBackgroundSessionLauncher;
    modelArg?: string;
    now?: () => Date;
}
export declare function setOpencodeBackgroundSessionLauncherForTests(launcher?: OpencodeBackgroundSessionLauncher): void;
export declare class OpencodeHarnessSubagentAdapter implements HarnessSubagentAdapter {
    readonly adapterId = "opencode";
    private readonly launcher;
    private readonly modelArg?;
    private readonly now;
    private readonly handles;
    constructor(options?: OpencodeHarnessSubagentAdapterOptions);
    private pickLauncher;
    startSession(request: HarnessSubagentStartRequest): Promise<HarnessSubagentStartResult>;
    sendPrompt(request: HarnessSubagentPromptRequest): Promise<void>;
    getSessionState(request: HarnessSubagentStateRequest): HarnessSubagentSessionState;
    abortSession(request: HarnessSubagentAbortRequest): Promise<void>;
    private launchForExistingSubagent;
    private stopExistingHandle;
}
export declare function createOpencodeHarnessSubagentAdapter(options?: OpencodeHarnessSubagentAdapterOptions): OpencodeHarnessSubagentAdapter;
export declare function renderOpencodeSubagentInitialPrompt(request: HarnessSubagentStartRequest): string;
export declare function readOpencodeSubagentSessionState(subagent: GoalSubagentRecord, options?: {
    live?: boolean;
    messages?: Awaited<ReturnType<typeof readOpencodeSessionMessages>>;
}): HarnessSubagentSessionState;
