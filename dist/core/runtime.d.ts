import { type GoalControllerLoopOptions, type GoalControllerLoopResult, type GoalControllerTickOptions, type GoalControllerTickResult } from "./controller-loop.js";
import { type GoalDagObjectivePlanOptions, type GoalDagPlannedNodesResult } from "./dag-planner.js";
import { type GoalDagPlanNodeInput, type GoalDagPlanOptions, type GoalDagReadyQueue, type GoalDagSchedulingPolicy } from "./dag-scheduler.js";
import { type GoalCommand } from "./parser.js";
import { type HarnessSubagentAdapter, type StartGoalSubagentOptions } from "./subagent-adapter.js";
import type { BlockedAuditEvidence, GoalAdapterCallbacks, GoalDagNode, GoalLedgerEvent, GoalOrchestrationState, GoalReferenceResolution, GoalRuntimeConfig, GoalSessionMetadata, GoalStatusInput, GoalStore, GoalSubagentRecord, GoalSummary, GoalToolResult, WorkspaceProfile, GoalTurnStop, HiddenGoalTurnResult, TurnContext } from "./types.js";
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
    saveGoalSessionMetadata(metadata: GoalSessionMetadata): Promise<void>;
    listGoalSummaries(): Promise<GoalSummary[]>;
    saveGoalDagNode(node: GoalDagNode): Promise<void>;
    getGoalDagNode(goalId: string, nodeId: string): Promise<GoalDagNode | undefined>;
    listGoalDagNodes(goalId: string): Promise<GoalDagNode[]>;
    saveGoalSubagent(subagent: GoalSubagentRecord): Promise<void>;
    getGoalSubagent(goalId: string, subagentId: string): Promise<GoalSubagentRecord | undefined>;
    listGoalSubagents(goalId: string, nodeId?: string): Promise<GoalSubagentRecord[]>;
    getGoalOrchestrationState(goalId: string): Promise<GoalOrchestrationState>;
    planGoalDag(goalId: string, inputs: GoalDagPlanNodeInput[], options?: GoalDagPlanOptions): Promise<GoalDagNode[]>;
    planGoalDagFromObjective(goalId: string, objective: string, options?: GoalDagObjectivePlanOptions): Promise<GoalDagPlannedNodesResult>;
    getGoalDagReadyQueue(goalId: string, policy?: GoalDagSchedulingPolicy): Promise<GoalDagReadyQueue>;
    startGoalSubagent(adapter: HarnessSubagentAdapter, node: GoalDagNode, options: StartGoalSubagentOptions): Promise<GoalSubagentRecord>;
    sendGoalSubagentPrompt(adapter: HarnessSubagentAdapter, subagent: GoalSubagentRecord, prompt: string, options?: {
        metadata?: Record<string, unknown>;
        now?: Date | string;
    }): Promise<GoalSubagentRecord>;
    syncGoalSubagent(adapter: HarnessSubagentAdapter, subagent: GoalSubagentRecord): Promise<GoalSubagentRecord>;
    runGoalControllerTick(goalId: string, options: GoalControllerTickOptions): Promise<GoalControllerTickResult>;
    runGoalControllerLoop(goalId: string, options: GoalControllerLoopOptions): Promise<GoalControllerLoopResult>;
    resolveGoalReference(reference: string): Promise<GoalReferenceResolution>;
    saveWorkspaceProfile(profile: WorkspaceProfile): Promise<void>;
    getWorkspaceProfile(name: string): Promise<WorkspaceProfile | undefined>;
    listWorkspaceProfiles(): Promise<WorkspaceProfile[]>;
    deleteWorkspaceProfile(name: string): Promise<boolean>;
    getCurrentTurnStop(sessionKey: string): GoalTurnStop | undefined;
    createOrReplaceGoal(sessionKey: string, objectiveInput: string, options?: {
        tokenBudget?: number;
        confirmReplace?: boolean;
    }): Promise<GoalToolResult>;
    editGoal(sessionKey: string, objectiveInput: string, options?: {
        tokenBudget?: number;
    }): Promise<GoalToolResult>;
    pauseGoal(sessionKey: string): Promise<GoalToolResult>;
    resumeGoal(sessionKey: string, options?: {
        continueIfIdle?: boolean;
    }): Promise<GoalToolResult>;
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
