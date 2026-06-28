import { type GoalControllerLoopOptions, type GoalControllerLoopResult, type GoalControllerTickOptions, type GoalControllerTickResult } from "./controller-loop.js";
import { type GoalDagObjectivePlanOptions, type GoalDagPlannedNodesResult } from "./dag-planner.js";
import { type GoalDagFileDocument, type GoalDagFilePlanOptions } from "./dag-file.js";
import { type GoalDagPlanNodeInput, type GoalDagPlanOptions, type GoalDagReadyQueue, type GoalDagSchedulingPolicy } from "./dag-scheduler.js";
import { type GoalDebugTraceEventInput, type GoalDebugTracer } from "./debug-trace.js";
import { type GoalCommand } from "./parser.js";
import { type HarnessSubagentAdapter, type StartGoalSubagentOptions } from "./subagent-adapter.js";
import type { BlockedAuditEvidence, ContinuationReservation, GoalAdapterCallbacks, GoalDagNode, GoalLedgerEvent, GoalOrchestrationState, GoalRecord, GoalReferenceResolution, GoalRuntimeConfig, GoalSessionMetadata, GoalStatusInput, GoalStore, GoalSubagentRecord, GoalSummary, GoalToolResult, WorkspaceProfile, GoalTurnStop, HarnessState, HiddenGoalTurnResult, TurnContext } from "./types.js";
export interface GoalDagTerminalFinalizationResult {
    goalId: string;
    terminal: boolean;
    changed: boolean;
    reason: string;
    status?: GoalRecord["status"];
    goal?: GoalRecord;
}
export declare class GoalRuntime {
    private readonly store;
    private readonly callbacks;
    private readonly debugTracer?;
    private readonly config;
    private readonly activeTurns;
    constructor(options: {
        store: GoalStore;
        callbacks?: GoalAdapterCallbacks;
        config?: GoalRuntimeConfig;
        debugTracer?: GoalDebugTracer;
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
    recordControllerEvent(goalId: string, details: Record<string, unknown>, options?: {
        at?: Date | string;
    }): Promise<void>;
    pruneLedgerEvents(goalId: string, options: {
        maxEvents: number;
    }): Promise<number>;
    getGoalRecord(goalId: string): Promise<GoalRecord>;
    listGoalLedgerEvents(goalId: string): Promise<GoalLedgerEvent[]>;
    auditPauseGoal(goalId: string, reason: string): Promise<void>;
    saveGoalSessionMetadata(metadata: GoalSessionMetadata): Promise<void>;
    listGoalSummaries(): Promise<GoalSummary[]>;
    getGoalById(goalId: string): Promise<GoalRecord | undefined>;
    finalizeGoalFromDagTerminalState(goalId: string): Promise<GoalDagTerminalFinalizationResult>;
    blockGoalFromControllerCloseout(goalId: string, reason: string, details?: Record<string, unknown>): Promise<GoalDagTerminalFinalizationResult>;
    saveGoalDagNode(node: GoalDagNode): Promise<void>;
    getGoalDagNode(goalId: string, nodeId: string): Promise<GoalDagNode | undefined>;
    listGoalDagNodes(goalId: string): Promise<GoalDagNode[]>;
    saveGoalSubagent(subagent: GoalSubagentRecord): Promise<void>;
    getGoalSubagent(goalId: string, subagentId: string): Promise<GoalSubagentRecord | undefined>;
    listGoalSubagents(goalId: string, nodeId?: string): Promise<GoalSubagentRecord[]>;
    getGoalOrchestrationState(goalId: string): Promise<GoalOrchestrationState>;
    planGoalDag(goalId: string, inputs: GoalDagPlanNodeInput[], options?: GoalDagPlanOptions): Promise<GoalDagNode[]>;
    planGoalDagFromObjective(goalId: string, objective: string, options?: GoalDagObjectivePlanOptions): Promise<GoalDagPlannedNodesResult>;
    planGoalDagFromFileDocument(goalId: string, document: GoalDagFileDocument, options?: GoalDagFilePlanOptions): Promise<GoalDagPlannedNodesResult>;
    getGoalDagReadyQueue(goalId: string, policy?: GoalDagSchedulingPolicy): Promise<GoalDagReadyQueue>;
    startGoalSubagent(adapter: HarnessSubagentAdapter, node: GoalDagNode, options: StartGoalSubagentOptions): Promise<GoalSubagentRecord>;
    sendGoalSubagentPrompt(adapter: HarnessSubagentAdapter, subagent: GoalSubagentRecord, prompt: string, options?: {
        metadata?: Record<string, unknown>;
        now?: Date | string;
    }): Promise<GoalSubagentRecord>;
    syncGoalSubagent(adapter: HarnessSubagentAdapter, subagent: GoalSubagentRecord): Promise<GoalSubagentRecord>;
    runGoalControllerTick(goalId: string, options: GoalControllerTickOptions): Promise<GoalControllerTickResult>;
    runGoalControllerLoop(goalId: string, options: GoalControllerLoopOptions): Promise<GoalControllerLoopResult>;
    getDebugTraceTarget(): string | undefined;
    recordDebugTrace(event: GoalDebugTraceEventInput): Promise<void>;
    recordMonitorDebugSnapshot(goal: GoalSummary | GoalRecord, state: GoalOrchestrationState, options?: {
        source: string;
        ledgerEvents?: GoalLedgerEvent[];
        harnessState?: HarnessState;
        reservation?: ContinuationReservation;
        details?: Record<string, unknown>;
    }): Promise<void>;
    private recordGoalDebugSnapshot;
    resolveGoalReference(reference: string): Promise<GoalReferenceResolution>;
    saveWorkspaceProfile(profile: WorkspaceProfile): Promise<void>;
    getWorkspaceProfile(name: string): Promise<WorkspaceProfile | undefined>;
    listWorkspaceProfiles(): Promise<WorkspaceProfile[]>;
    deleteWorkspaceProfile(name: string): Promise<boolean>;
    getCurrentTurnStop(sessionKey: string): GoalTurnStop | undefined;
    createOrReplaceGoal(sessionKey: string, objectiveInput: string, options?: {
        tokenBudget?: number;
        confirmReplace?: boolean;
        continueIfIdle?: boolean;
    }): Promise<GoalToolResult>;
    editGoal(sessionKey: string, objectiveInput: string, options?: {
        tokenBudget?: number;
    }): Promise<GoalToolResult>;
    pauseGoal(sessionKey: string): Promise<GoalToolResult>;
    resumeGoal(sessionKey: string, options?: {
        continueIfIdle?: boolean;
    }): Promise<GoalToolResult>;
    retryGoalDagNodeForSession(sessionKey: string, nodeId: string): Promise<GoalToolResult>;
    retryGoalDagNode(goalId: string, nodeId: string): Promise<GoalToolResult>;
    continueGoalDagNodeInPlaceForSession(sessionKey: string, nodeId: string): Promise<GoalToolResult>;
    continueGoalDagSubagentInPlaceForSession(sessionKey: string, subagentId: string): Promise<GoalToolResult>;
    continueGoalDagNodeInPlace(goalId: string, nodeId: string): Promise<GoalToolResult>;
    continueGoalDagSubagentInPlace(goalId: string, subagentId: string): Promise<GoalToolResult>;
    private continueGoalDagNodeInPlaceInternal;
    getReservation(sessionKey: string): Promise<ContinuationReservation | undefined>;
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
    readHarnessState(sessionKey: string): Promise<HarnessState>;
    private runCompletionAuditIfConfigured;
    private markMeaningfulProgress;
    private markTurnStopped;
    private appendLedger;
    private nowIso;
}
