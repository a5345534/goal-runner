import type { GoalDagSchedulingPolicy } from "./dag-scheduler.js";
import type { ControllerExceptionHandler } from "./exception-handler.js";
import type { HarnessSubagentAdapter, StartGoalSubagentOptions } from "./subagent-adapter.js";
import type { GoalDagNode, GoalLedgerEvent, GoalOrchestrationState, GoalRecord, GoalSubagentRecord } from "./types.js";
import { type GoalControllerAuditOptions, type GoalControllerAuditSnapshot } from "./controller-audit.js";
export interface GoalControllerRuntimePort {
    getGoalOrchestrationState(goalId: string): Promise<GoalOrchestrationState>;
    getGoalDagReadyQueue(goalId: string, policy?: GoalDagSchedulingPolicy): Promise<{
        ready: GoalDagNode[];
        blocked: Array<{
            node: GoalDagNode;
            reasons: string[];
        }>;
    }>;
    saveGoalDagNode(node: GoalDagNode): Promise<void>;
    saveGoalSubagent(subagent: GoalSubagentRecord): Promise<void>;
    startGoalSubagent(adapter: HarnessSubagentAdapter, node: GoalDagNode, options: StartGoalSubagentOptions): Promise<GoalSubagentRecord>;
    sendGoalSubagentPrompt(adapter: HarnessSubagentAdapter, subagent: GoalSubagentRecord, prompt: string, options?: {
        metadata?: Record<string, unknown>;
        now?: Date | string;
    }): Promise<GoalSubagentRecord>;
    syncGoalSubagent(adapter: HarnessSubagentAdapter, subagent: GoalSubagentRecord): Promise<GoalSubagentRecord>;
    recordControllerEvent?(goalId: string, details: Record<string, unknown>, options?: {
        at?: Date | string;
    }): Promise<void>;
    /** Resolve goal record for the given goalId. Required for controller audit snapshots. */
    getGoalRecord?(goalId: string): Promise<GoalRecord>;
    /** List ledger events for the given goalId. Required for controller audit snapshots. */
    listGoalLedgerEvents?(goalId: string): Promise<GoalLedgerEvent[]>;
    /** Pause the goal with the given reason. Called when audit auto-pauses a goal. */
    auditPauseGoal?(goalId: string, reason: string): Promise<void>;
}
export interface GoalControllerWorkspaceAllocation {
    subagentId?: string;
    cwd?: string;
    branch?: string;
    ref?: string;
    systemPrompt?: string;
    initialPrompt?: string;
    metadata?: Record<string, unknown>;
}
export interface GoalControllerWorkspaceAllocationRequest {
    goalId: string;
    node: GoalDagNode;
    state: GoalOrchestrationState;
    adapterId: string;
    tickStartedAt: string;
}
export type GoalControllerWorkspaceAllocator = (request: GoalControllerWorkspaceAllocationRequest) => Promise<GoalControllerWorkspaceAllocation | undefined> | GoalControllerWorkspaceAllocation | undefined;
export interface GoalControllerValidationRequest {
    goalId: string;
    node: GoalDagNode;
    subagent: GoalSubagentRecord;
    state: GoalOrchestrationState;
    tickStartedAt: string;
}
export type GoalControllerValidationStatus = "passed" | "failed" | "blocked";
export interface GoalControllerValidationResult {
    status: GoalControllerValidationStatus;
    summary?: string;
    followupPrompt?: string;
    validationSignals?: string[];
}
export type GoalControllerValidator = (request: GoalControllerValidationRequest) => Promise<GoalControllerValidationResult> | GoalControllerValidationResult;
export interface GoalControllerIntegrationRequest {
    goalId: string;
    node: GoalDagNode;
    subagent: GoalSubagentRecord;
    state: GoalOrchestrationState;
    validationSummary?: string;
    validationSignals?: string[];
    tickStartedAt: string;
}
export type GoalControllerIntegrationStatus = "complete" | "notRequired" | "failed" | "blocked";
export interface GoalControllerIntegrationResult {
    status: GoalControllerIntegrationStatus;
    summary?: string;
    followupPrompt?: string;
    validationSignals?: string[];
    sourceBranch?: string;
    sourceRef?: string;
    sourceHead?: string;
    integrationCommitSha?: string;
    error?: string;
    completedAt?: string;
}
export type GoalControllerIntegrator = (request: GoalControllerIntegrationRequest) => Promise<GoalControllerIntegrationResult> | GoalControllerIntegrationResult;
export interface GoalControllerInitialPromptRequest {
    goalId: string;
    node: GoalDagNode;
    state: GoalOrchestrationState;
}
export interface GoalControllerTickOptions {
    adapter: HarnessSubagentAdapter;
    schedulingPolicy?: GoalDagSchedulingPolicy;
    workspaceAllocator?: GoalControllerWorkspaceAllocator;
    validator?: GoalControllerValidator;
    /** Integrates repository-changing subagent branches before node completion. */
    integrator?: GoalControllerIntegrator;
    /** Handles abnormal adapter observations/recovery decisions outside the formal adapter path. */
    exceptionHandler?: ControllerExceptionHandler;
    renderInitialPrompt?: (request: GoalControllerInitialPromptRequest) => string;
    maxStartsPerTick?: number;
    /** Maximum auto-retry attempts for transient subagent failures (default 2). */
    maxAutoRetries?: number;
    /** Non-terminal controller/node state age that triggers stale-state intervention (default 10 minutes). */
    staleStateThresholdMs?: number;
    /** Maximum time to wait for adapter prompt dispatch before degrading to recoverable needs-followup (default 60 seconds). */
    subagentPromptDispatchTimeoutMs?: number;
    /** Maximum time to wait for adapter runner launch before recording a recoverable launch timeout (default 60 seconds). */
    subagentRunnerLaunchTimeoutMs?: number;
    systemPrompt?: string;
    metadata?: Record<string, unknown>;
    now?: Date | string | (() => Date | string);
    /** Periodic controller audit configuration. When enabled, each tick checks
     * whether an audit is due and runs one if the interval has elapsed. */
    audit?: GoalControllerAuditOptions;
    /** Invokes the configured audit model with a structured snapshot. The model
     * should return a JSON-parseable {@link GoalControllerAuditDecision}.
     * Called by the controller tick when an audit is due. */
    auditModel?: (snapshot: GoalControllerAuditSnapshot) => Promise<unknown>;
}
export interface GoalControllerTickResult {
    goalId: string;
    started: GoalSubagentRecord[];
    synced: GoalSubagentRecord[];
    validating: GoalDagNode[];
    completed: GoalDagNode[];
    followups: GoalSubagentRecord[];
    blocked: GoalDagNode[];
    failed: GoalDagNode[];
    ready: GoalDagNode[];
    queueBlocked: Array<{
        node: GoalDagNode;
        reasons: string[];
    }>;
    changed: boolean;
    /** Whether a controller audit ran during this tick. */
    auditRun?: boolean;
    /** Compact audit summary when an audit ran. */
    auditSummary?: string;
    /** Whether the audit auto-paused the goal. */
    auditPausedGoal?: boolean;
}
export interface GoalControllerLoopOptions extends GoalControllerTickOptions {
    maxTicks?: number;
    intervalMs?: number;
    stopWhenIdle?: boolean;
    signal?: AbortSignal;
}
export interface GoalControllerLoopResult {
    goalId: string;
    ticks: GoalControllerTickResult[];
}
export declare function runGoalControllerTick(runtime: GoalControllerRuntimePort, goalId: string, options: GoalControllerTickOptions): Promise<GoalControllerTickResult>;
export declare function runGoalControllerLoop(runtime: GoalControllerRuntimePort, goalId: string, options: GoalControllerLoopOptions): Promise<GoalControllerLoopResult>;
