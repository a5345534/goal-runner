import { type GoalCommand } from "./parser.js";
import type { BlockedAuditEvidence, GoalAdapterCallbacks, GoalLedgerEvent, GoalRuntimeConfig, GoalStatusInput, GoalStore, GoalToolResult, GoalTurnStop, HiddenGoalTurnResult, TurnContext } from "./types.js";
export declare class GoalRuntime {
    private readonly store;
    private readonly callbacks;
    private readonly config;
    private readonly activeTurns;
    constructor(options: {
        store: GoalStore;
        callbacks?: GoalAdapterCallbacks;
        config?: GoalRuntimeConfig;
    });
    executeCommand(sessionKey: string, args: string, options?: {
        editObjective?: string;
        confirmReplace?: boolean;
    }): Promise<GoalToolResult>;
    executeParsedCommand(sessionKey: string, command: GoalCommand, options?: {
        editObjective?: string;
        confirmReplace?: boolean;
    }): Promise<GoalToolResult>;
    getGoal(sessionKey: string): Promise<GoalToolResult>;
    listLedgerEvents(sessionKey: string, goalId?: string): Promise<GoalLedgerEvent[]>;
    getCurrentTurnStop(sessionKey: string): GoalTurnStop | undefined;
    createOrReplaceGoal(sessionKey: string, objectiveInput: string, options?: {
        tokenBudget?: number;
        confirmReplace?: boolean;
    }): Promise<GoalToolResult>;
    editGoal(sessionKey: string, objectiveInput: string, options?: {
        tokenBudget?: number;
    }): Promise<GoalToolResult>;
    pauseGoal(sessionKey: string): Promise<GoalToolResult>;
    resumeGoal(sessionKey: string): Promise<GoalToolResult>;
    clearGoal(sessionKey: string): Promise<GoalToolResult>;
    toolGetGoal(sessionKey: string): Promise<GoalToolResult>;
    toolCreateGoal(sessionKey: string, objective: string, tokenBudget?: number): Promise<GoalToolResult>;
    toolUpdateGoal(sessionKey: string, statusInput: GoalStatusInput, options?: {
        blockedAuditEvidence?: BlockedAuditEvidence;
    }): Promise<GoalToolResult>;
    turnStarted(context: TurnContext): Promise<void>;
    toolCompleted(context: TurnContext): Promise<void>;
    turnFinished(context: TurnContext, completed?: boolean): Promise<void>;
    taskAborted(sessionKey: string): Promise<void>;
    usageLimitReached(sessionKey: string): Promise<GoalToolResult>;
    sessionResumed(sessionKey: string): Promise<void>;
    maybeContinueIfIdle(sessionKey: string): Promise<HiddenGoalTurnResult | {
        kind: "notEligible";
        reason: string;
    }>;
    private requireGoal;
    private setGoalStatus;
    private accountUsage;
    private readHarnessState;
    private runCompletionAuditIfConfigured;
    private markMeaningfulProgress;
    private markTurnStopped;
    private appendLedger;
    private nowIso;
}
