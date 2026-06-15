import { type ChildProcess } from "node:child_process";
import { type OpencodeClient } from "./opencode-client.js";
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
    sendPrompt(prompt: string, options?: {
        system?: string;
        tools?: Record<string, boolean>;
    }): Promise<void>;
    stop(): void;
    serverUrl: string;
}
export type OpencodeBackgroundSessionLauncher = (request: OpencodeBackgroundSessionLaunchRequest) => Promise<OpencodeBackgroundSessionHandle>;
export interface OpencodeBackgroundLauncherOptions {
    opencodeBin?: string;
    /** Server start timeout in milliseconds. */
    startupTimeoutMs?: number;
    /** Function used to build the opencode client from the server URL. */
    createClient?: (serverUrl: string) => OpencodeClient;
    /** Hook to override the spawn (used by tests). */
    spawn?: (bin: string, args: string[], options: {
        cwd: string;
        env: NodeJS.ProcessEnv;
    }) => ChildProcess;
}
export declare function launchOpencodeServeBackgroundSession(defaultOptions?: OpencodeBackgroundLauncherOptions): OpencodeBackgroundSessionLauncher;
export declare function writeOpencodeBackgroundReadyFile(directory: string, payload: Record<string, unknown>): string;
export declare function readOpencodeBackgroundReadyFile(path: string): Record<string, unknown> | undefined;
export declare function opencodeBackgroundRunDir(tmpRoot?: string): string;
export declare function opencodeBackgroundCommandPath(runDir: string): string;
