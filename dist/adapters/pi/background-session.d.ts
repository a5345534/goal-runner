export interface BackgroundGoalSessionLaunchRequest {
    cwd: string;
    sessionId?: string;
    sessionFile?: string;
    sessionName: string;
    modelArg?: string;
    thinkingLevel?: string;
}
export interface BackgroundGoalSessionHandle {
    sessionFile: string;
    sessionId: string;
    setSessionName(name: string): Promise<void>;
    sendPrompt(prompt: string, options?: {
        requireSessionFile?: boolean;
    }): Promise<void>;
    /** True while the detached background runner process is still alive. */
    isAlive?(): boolean;
    stop(): void;
}
export type BackgroundGoalSessionLauncher = (request: BackgroundGoalSessionLaunchRequest) => Promise<BackgroundGoalSessionHandle>;
export declare function launchPiRpcBackgroundGoalSession(request: BackgroundGoalSessionLaunchRequest): Promise<BackgroundGoalSessionHandle>;
