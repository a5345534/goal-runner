export interface BackgroundGoalSessionLaunchRequest {
    cwd: string;
    sessionId?: string;
    sessionFile?: string;
    sessionName: string;
    modelArg?: string;
}
export interface BackgroundGoalSessionHandle {
    sessionFile: string;
    sessionId: string;
    setSessionName(name: string): Promise<void>;
    sendPrompt(prompt: string): Promise<void>;
    stop(): void;
}
export type BackgroundGoalSessionLauncher = (request: BackgroundGoalSessionLaunchRequest) => Promise<BackgroundGoalSessionHandle>;
export declare function launchPiRpcBackgroundGoalSession(request: BackgroundGoalSessionLaunchRequest): Promise<BackgroundGoalSessionHandle>;
