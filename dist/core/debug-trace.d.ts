import type { ContinuationReservation, GoalLedgerEvent, GoalOrchestrationState, GoalRecord, GoalStore, GoalSummary, HarnessState } from "./types.js";
export type GoalDebugTraceCategory = "db" | "controller" | "monitor" | "anomaly" | "runtime";
export type GoalDebugSeverity = "debug" | "info" | "warn" | "error";
export interface GoalDebugTraceEvent {
    traceId: string;
    at: string;
    category: GoalDebugTraceCategory;
    operation: string;
    severity: GoalDebugSeverity;
    ok?: boolean;
    durationMs?: number;
    sessionKey?: string;
    goalId?: string;
    nodeId?: string;
    subagentId?: string;
    summary?: string;
    error?: string;
    details?: Record<string, unknown>;
}
export type GoalDebugTraceEventInput = Omit<GoalDebugTraceEvent, "traceId" | "at"> & {
    traceId?: string;
    at?: string;
};
export interface GoalDebugTracer {
    readonly enabled: boolean;
    record(event: GoalDebugTraceEventInput): Promise<void> | void;
    trace<T>(category: GoalDebugTraceCategory, operation: string, context: Omit<GoalDebugTraceEventInput, "category" | "operation" | "ok" | "durationMs" | "error">, action: () => Promise<T> | T): Promise<T>;
    getTraceTarget?(): string | undefined;
}
export interface JsonlGoalDebugTracerOptions {
    traceDir?: string;
    traceFile?: string;
    stateRoot?: string;
    now?: () => Date;
    randomId?: () => string;
}
export declare class JsonlGoalDebugTracer implements GoalDebugTracer {
    readonly enabled = true;
    private readonly traceFile;
    private readonly now;
    private readonly randomId;
    constructor(options?: JsonlGoalDebugTracerOptions);
    getTraceTarget(): string;
    record(input: GoalDebugTraceEventInput): void;
    trace<T>(category: GoalDebugTraceCategory, operation: string, context: Omit<GoalDebugTraceEventInput, "category" | "operation" | "ok" | "durationMs" | "error">, action: () => Promise<T> | T): Promise<T>;
}
export declare function createGoalDebugTracerFromEnv(options?: {
    stateRoot?: string;
    defaultEnabled?: boolean;
}): GoalDebugTracer | undefined;
export declare function instrumentGoalStore(store: GoalStore, tracer: GoalDebugTracer | undefined): GoalStore;
export interface GoalDebugAnomaly {
    code: string;
    severity: "warn" | "error";
    summary: string;
    goalId: string;
    nodeId?: string;
    subagentId?: string;
    details?: Record<string, unknown>;
}
export interface GoalDebugReport {
    generatedAt: string;
    traceTarget?: string;
    goal: {
        goalId: string;
        shortGoalId: string;
        sessionKey: string;
        status: string;
        activityState?: string;
        objectiveSummary: string;
        tokensUsed: number;
        tokenBudget?: number;
        timeUsedSeconds: number;
        executionWorkspace?: string;
        sessionFile?: string;
        updatedAt: string;
    };
    counts: {
        nodes: number;
        subagents: number;
        ledgerEvents: number;
        nodeStatuses: Record<string, number>;
        subagentStatuses: Record<string, number>;
    };
    anomalies: GoalDebugAnomaly[];
    nodes: Array<{
        nodeId: string;
        slug: string;
        status: string;
        lifecyclePhase?: string;
        dependencyNodeIds: string[];
        preparedSubagentId?: string;
        launchFailureCount?: number;
        updatedAt: string;
        lastValidationSummary?: string;
    }>;
    subagents: Array<{
        subagentId: string;
        nodeId: string;
        status: string;
        sessionId?: string;
        hasSessionFile: boolean;
        hasWorkspace: boolean;
        integrationState?: string;
        retryCount?: number;
        updatedAt: string;
        lastActivityAt?: string;
        integrationStatus?: string;
    }>;
    recentEvents: Array<{
        at: string;
        type: string;
        summary?: string;
        nodeId?: string;
        subagentId?: string;
    }>;
}
export declare function buildGoalDebugReport(input: {
    goal: GoalSummary | GoalRecord;
    state: GoalOrchestrationState;
    ledgerEvents?: GoalLedgerEvent[];
    harnessState?: HarnessState;
    reservation?: ContinuationReservation;
    traceTarget?: string;
    now?: Date;
}): GoalDebugReport;
export declare function formatGoalDebugReport(report: GoalDebugReport): string;
export declare function detectGoalDebugAnomalies(input: {
    goal: GoalSummary | GoalRecord;
    state: GoalOrchestrationState;
    ledgerEvents?: GoalLedgerEvent[];
    harnessState?: HarnessState;
    reservation?: ContinuationReservation;
    now?: Date;
}): GoalDebugAnomaly[];
export declare function recordGoalDebugSnapshot(tracer: GoalDebugTracer | undefined, input: {
    source: string;
    goal: GoalSummary | GoalRecord;
    state: GoalOrchestrationState;
    ledgerEvents?: GoalLedgerEvent[];
    harnessState?: HarnessState;
    reservation?: ContinuationReservation;
    now?: Date;
    details?: Record<string, unknown>;
}): void;
