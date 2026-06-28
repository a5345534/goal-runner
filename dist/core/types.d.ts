import type { GoalControllerAuditLedgerEventType } from "./controller-audit.js";
export declare const GOAL_STATUSES: readonly ["active", "paused", "blocked", "usageLimited", "budgetLimited", "complete"];
export type GoalStatus = (typeof GOAL_STATUSES)[number];
export type GoalStatusInput = GoalStatus | "usage_limited" | "budget_limited";
export interface GoalRecord {
    sessionKey: string;
    goalId: string;
    objective: string;
    status: GoalStatus;
    tokenBudget?: number;
    tokensUsed: number;
    timeUsedSeconds: number;
    createdAt: string;
    updatedAt: string;
    goalTurnsSinceAuditReset: number;
}
export interface TokenUsageSnapshot {
    totalTokens?: number;
    inputTokens?: number;
    outputTokens?: number;
}
export interface TurnContext {
    sessionKey: string;
    turnId?: string;
    tokenUsage?: TokenUsageSnapshot;
    hiddenGoalAttemptId?: string;
    now?: Date;
    /** Host tool name for tool-completion events, when available. */
    toolName?: string;
    /** Whether this event materially progressed the current goal. Defaults to true for generic tool-completed calls. */
    meaningfulProgress?: boolean;
    /** Optional human/debug summary for progress ledger entries. */
    progressSummary?: string;
}
export interface HarnessState {
    materialized: boolean;
    activeTurnId?: string;
    queuedUserInput: boolean;
    queuedTriggerTurn: boolean;
    continuationSuppressed: boolean;
}
export interface HiddenGoalTurnRequest {
    attemptId: string;
    sessionKey: string;
    goalId: string;
    goalUpdatedAt: string;
    attemptCount: number;
    hiddenContextKind: "goal_continuation";
    renderedPrompt: string;
    policyContext?: string;
}
export type HiddenGoalTurnResult = {
    kind: "started";
    hostTurnId?: string;
} | {
    kind: "alreadyStarted";
    hostTurnId?: string;
} | {
    kind: "skipped";
    reason: string;
} | {
    kind: "retryableFailure";
    error: string;
} | {
    kind: "fatalFailure";
    error: string;
};
export interface GoalSteeringContextRequest {
    sessionKey: string;
    goalId: string;
    kind: "budget_limit" | "objective_updated";
    renderedPrompt: string;
}
export type GoalLedgerEventType = "goal_created" | "goal_replaced" | "goal_edited" | "goal_paused" | "goal_resumed" | "goal_node_retry_requested" | "goal_node_continue_requested" | "goal_cleared" | "turn_started" | "turn_finished" | "meaningful_progress" | "no_progress_continuation_suppressed" | "continuation_requested" | "continuation_started" | "continuation_already_started" | "continuation_skipped" | "continuation_retryable_failure" | "continuation_fatal_failure" | "completion_requested" | "completion_audit_result" | "controller_event" | "goal_completed" | "goal_blocked" | "goal_budget_limited" | "goal_usage_limited" | GoalControllerAuditLedgerEventType | "candidate_selected" | "candidate_retried" | "candidate_switched" | "candidate_exhausted" | "candidate_blocked";
export interface GoalLedgerEvent {
    eventId?: string;
    sessionKey: string;
    goalId?: string;
    type: GoalLedgerEventType;
    at: string;
    details?: Record<string, unknown>;
}
export interface GoalDecisionEvidence {
    /** Where this evidence came from, e.g. pi-session-transcript, openspec-policy, auditor. */
    source: string;
    /** Human-readable summary safe to show in status/completion output. */
    summary?: string;
    /** Verification signals such as commands, passed checks, or inspected artifacts. */
    verificationSignals?: string[];
    /** Relevant command lines when the adapter can derive them. */
    commands?: string[];
    /** Relevant file/artifact paths when the adapter can derive them. */
    artifacts?: string[];
    /** Extra adapter-specific evidence. */
    [key: string]: unknown;
}
export interface CompletionAuditRequest {
    goal: GoalRecord;
    ledgerEvents: GoalLedgerEvent[];
    completionEvidence?: GoalDecisionEvidence;
    policyContext?: Record<string, unknown> | string;
}
export interface CompletionAuditResult {
    approved: boolean;
    /** Short verdict summary. */
    summary?: string;
    /** Detailed auditor report, if any. */
    report?: string;
    /** Source of the verdict, e.g. pi-independent-auditor, heuristic, host-policy. */
    source: string;
    evidence?: GoalDecisionEvidence | Record<string, unknown>;
}
export type GoalTurnStopReason = "complete" | "blocked" | "completionRejected" | "pause" | "clear" | "budgetLimited" | "usageLimited";
export interface GoalTurnStop {
    sessionKey: string;
    goalId?: string;
    reason: GoalTurnStopReason;
    at: string;
    message?: string;
}
export interface GoalAdapterCallbacks {
    resolveSessionKey?: () => Promise<string> | string;
    readHarnessState?: (sessionKey: string) => Promise<HarnessState> | HarnessState;
    startHiddenGoalTurn?: (request: HiddenGoalTurnRequest) => Promise<HiddenGoalTurnResult> | HiddenGoalTurnResult;
    injectSteeringContext?: (request: GoalSteeringContextRequest) => Promise<void> | void;
    notifyGoalUpdated?: (goal: GoalRecord) => Promise<void> | void;
    notifyGoalCleared?: (sessionKey: string) => Promise<void> | void;
    notifyGoalWarning?: (sessionKey: string, message: string) => Promise<void> | void;
    collectCompletionEvidence?: (goal: GoalRecord) => Promise<GoalDecisionEvidence | undefined> | GoalDecisionEvidence | undefined;
    getCompletionPolicyContext?: (goal: GoalRecord) => Promise<Record<string, unknown> | string | undefined> | Record<string, unknown> | string | undefined;
    auditCompletion?: (request: CompletionAuditRequest) => Promise<CompletionAuditResult> | CompletionAuditResult;
}
export interface ContinuationReservation {
    sessionKey: string;
    attemptId: string;
    goalId: string;
    goalUpdatedAt: string;
    attemptCount: number;
    status: "pending" | "started";
    hostTurnId?: string;
    createdAt: string;
    updatedAt: string;
    expiresAt: string;
}
export type WorkspaceStatus = "configured" | "missing" | "inaccessible" | "notAllowed" | "legacy" | "notConfigured";
export type BranchVerificationStatus = "verified" | "mismatch" | "notGit" | "notApplicable" | "unknown";
export type WorkspaceProfileKind = "git" | "nonGit";
export interface GoalSessionMetadata {
    sessionKey: string;
    goalId: string;
    originSessionKey?: string;
    executionWorkspace?: string;
    workspaceStatus?: WorkspaceStatus;
    branch?: string;
    ref?: string;
    /** Target/base branch or ref that an auto-allocated controller branch must promote into before complete. */
    promotionTargetRef?: string;
    branchVerificationStatus?: BranchVerificationStatus;
    sessionFile?: string;
    sessionName?: string;
    /** Model-routing scenario selected for the controller session. */
    controllerModelScenario?: string;
    /** Abstract model class requested for the controller session. */
    controllerModelClass?: string;
    /** Concrete provider/model id resolved from harness bindings for the controller session. */
    controllerModelArg?: string;
    /** Durable model-resolution evidence for the controller session. */
    controllerModelResolution?: GoalModelResolution;
    legacySessionBound?: boolean;
    createdAt: string;
    updatedAt: string;
}
export interface GoalSummary {
    sessionKey: string;
    goalId: string;
    shortGoalId: string;
    objective: string;
    objectiveSummary: string;
    status: GoalStatus;
    activityState?: string;
    tokenBudget?: number;
    tokensUsed: number;
    timeUsedSeconds: number;
    createdAt: string;
    updatedAt: string;
    lastActivityAt: string;
    originSessionKey?: string;
    executionWorkspace?: string;
    workspaceStatus?: WorkspaceStatus;
    branch?: string;
    ref?: string;
    /** Target/base branch or ref that an auto-allocated controller branch must promote into before complete. */
    promotionTargetRef?: string;
    branchVerificationStatus?: BranchVerificationStatus;
    sessionFile?: string;
    sessionName?: string;
    controllerModelScenario?: string;
    controllerModelClass?: string;
    controllerModelArg?: string;
    controllerModelResolution?: GoalModelResolution;
    legacySessionBound?: boolean;
}
export type GoalDagNodeStatus = "planned" | "ready" | "running" | "selfReportedComplete" | "controllerValidating" | "needsFollowup" | "complete" | "blocked" | "blockedTerminal" | "failed" | "superseded";
export type GoalDagNodeLifecyclePhase = "acceptanceDefined" | "resourcesCreating" | "resourcesReady" | "runnerStarting" | "runnerActive" | "controllerJudging" | "validating" | "integrating" | "terminal";
export type GoalSubagentObservationKind = "runnerStarting" | "running" | "idle" | "selfReportedComplete" | "selfReportedBlocked" | "protocolViolation" | "runnerError" | "runnerLost" | "stopped";
export interface GoalNodePreparedResources {
    subagentId?: string;
    adapterId?: string;
    workspacePath?: string;
    branch?: string;
    ref?: string;
    sessionId?: string;
    sessionFile?: string;
    modelScenario?: string;
    modelClass?: string;
    modelArg?: string;
    modelResolution?: GoalModelResolution;
    thinkingLevel?: string;
    metadata?: Record<string, unknown>;
    supersededAt?: string;
    supersededBy?: string;
    supersessionReason?: string;
    createdAt?: string;
    updatedAt?: string;
}
export interface GoalAdapterObservationRecord {
    adapterId: string;
    kind: GoalSubagentObservationKind;
    at: string;
    summary?: string;
    error?: string;
    evidence?: Record<string, unknown>;
}
export type GoalRecoveryDecisionAction = "sendPromptToSameSession" | "restartRunnerSameSession" | "restartRunnerSameWorktreeNewSession" | "markNodeBlocked" | "askUser" | "invokeControllerModel" | "proposeRecoveryRule" | "supersedeResourcesAndRestart" | "delegateToLegacyRecovery";
export interface GoalRecoveryDecisionRecord {
    decisionId?: string;
    action: GoalRecoveryDecisionAction;
    reason: string;
    at: string;
    ruleId?: string;
    confidence?: "low" | "medium" | "high";
    prompt?: string;
    retryCount?: number;
    maxRetries?: number;
    evidence?: Record<string, unknown>;
}
export type GoalControllerTypedEventCategory = "poll" | "node.lifecycle" | "node.staleDetected" | "recovery.decision" | "recovery.action" | "recovery.rule" | "transcript" | "validation.result" | "integration.result" | "promotion.result" | "cleanup.result" | "diagnostic";
export type GoalControllerActionAttemptKind = "runnerLaunch" | "promptDispatch" | "recovery" | "validation" | "integration" | "promotion" | "cleanup";
export type GoalControllerActionAttemptStatus = "started" | "succeeded" | "timedOut" | "failed" | "degraded";
export interface GoalAttemptCursor {
    /** Timestamp boundary used by adapters that can only inspect transcripts by message time. */
    at?: string;
    /** Adapter-specific transcript entry id, when available. */
    entryId?: string;
    /** Adapter-specific message index, when available. */
    messageIndex?: number;
    /** Adapter-specific byte offset, when available. */
    byteOffset?: number;
    /** Human/debug label for the cursor source, e.g. controller-start or prompt-dispatch. */
    source?: string;
    [key: string]: unknown;
}
export interface GoalControllerActionAttemptRecord {
    actionId: string;
    actionKind: GoalControllerActionAttemptKind;
    startedAt: string;
    deadlineAt?: string;
    status: GoalControllerActionAttemptStatus;
    decisionId?: string;
    error?: string;
    evidence?: Record<string, unknown>;
}
import type { GoalDagConflictHints, GoalDagNodeKind, GoalValidationArtifactLock, GoalDagValidationContract, GoalDagNodeWorkspaceBinding, GoalModelResolution, GoalQualityProfile } from "goal-contract";
export type { GoalDagConflictHints, GoalDagNodeKind, GoalValidationArtifactLock, GoalDagValidationContract, GoalDagNodeWorkspaceBinding, GoalModelResolution, GoalQualityProfile, };
export interface GoalDagNode {
    goalId: string;
    nodeId: string;
    slug: string;
    objective: string;
    scope?: string;
    kind?: GoalDagNodeKind;
    validation?: GoalDagValidationContract;
    /** Resolved quality profiles from DAG defaults and node-level config. */
    qualityProfiles?: GoalQualityProfile[];
    dependencyNodeIds: string[];
    expectedOutputs: string[];
    validators: string[];
    workspaceStrategy?: string;
    /** Workspace binding hints consumed by adapters that support deterministic node worktrees. */
    workspace?: GoalDagNodeWorkspaceBinding;
    risk?: "low" | "medium" | "high";
    /** Model-routing scenario selected for this node, resolved by DAG defaults/rules or explicit node config. */
    modelScenario?: string;
    /** Abstract model class selected for this node before harness binding resolution. */
    modelClass?: string;
    /** Concrete provider/model id resolved from harness bindings and persisted for restart-safe scheduling. */
    modelArg?: string;
    /** Durable model-resolution evidence for this node. */
    modelResolution?: GoalModelResolution;
    /** Pi thinking level (off|minimal|low|medium|high|xhigh) selected for this node. */
    thinkingLevel?: string;
    conflictHints?: GoalDagConflictHints;
    completionGates: string[];
    status: GoalDagNodeStatus;
    /** Detailed controller-owned execution lifecycle phase. Coarse status remains for compatibility. */
    lifecyclePhase?: GoalDagNodeLifecyclePhase;
    /** Controller-prepared branch/worktree/session/resource binding for this node. */
    preparedResources?: GoalNodePreparedResources;
    /** Last normalized adapter observation recorded for diagnostics/recovery. */
    lastAdapterObservation?: GoalAdapterObservationRecord;
    /** Last controller recovery decision recorded for abnormal observations. */
    lastRecoveryDecision?: GoalRecoveryDecisionRecord;
    lastValidationSummary?: string;
    createdAt: string;
    updatedAt: string;
}
export type GoalSubagentStatus = "planned" | "workspaceCreated" | "sessionStarted" | "running" | "idle" | "selfReportedComplete" | "controllerValidating" | "needsFollowup" | "complete" | "blocked" | "blockedTerminal" | "failed";
export type GoalSubagentIntegrationState = "pending" | "integrating" | "complete" | "failed" | "not-required";
export interface GoalSubagentRecord {
    goalId: string;
    nodeId: string;
    subagentId: string;
    harnessAdapterId: string;
    sessionId?: string;
    sessionFile?: string;
    workspacePath?: string;
    branch?: string;
    ref?: string;
    status: GoalSubagentStatus;
    prompts: string[];
    lastActivityAt?: string;
    selfReportedResult?: string;
    controllerValidationResults?: string[];
    /** Source commit produced by the subagent branch/worktree, when known. */
    commitSha?: string;
    /** Human-readable integration note retained for legacy monitor/status displays. */
    integrationStatus?: string;
    /** Controller-side branch/worktree integration state for repository-changing subagents. */
    integrationState?: GoalSubagentIntegrationState;
    integrationSourceBranch?: string;
    integrationSourceRef?: string;
    integrationSourceHead?: string;
    integrationCommitSha?: string;
    integrationError?: string;
    integrationCompletedAt?: string;
    /** Number of automatic retries attempted for this subagent. */
    retryCount?: number;
    /** Current controller attempt id for transcript/outcome scoping. */
    attemptId?: string;
    /** Timestamp when the current controller attempt started. */
    attemptStartedAt?: string;
    /** Adapter-neutral transcript cursor for the current controller attempt. */
    attemptCursor?: GoalAttemptCursor;
    /** Last durable controller action attempt involving this subagent. */
    lastActionAttempt?: GoalControllerActionAttemptRecord;
    /** Last normalized recovery loop signature involving this subagent. */
    recoveryLoopSignature?: string;
    /** Last normalized adapter observation recorded for this subagent. */
    lastAdapterObservation?: GoalAdapterObservationRecord;
    /** Last controller recovery decision involving this subagent. */
    lastRecoveryDecision?: GoalRecoveryDecisionRecord;
    createdAt: string;
    updatedAt: string;
}
export interface GoalOrchestrationState {
    goalId: string;
    nodes: GoalDagNode[];
    subagents: GoalSubagentRecord[];
}
export type GoalReferenceResolution = {
    kind: "found";
    goal: GoalSummary;
} | {
    kind: "notFound";
    reference: string;
} | {
    kind: "ambiguous";
    reference: string;
    matches: GoalSummary[];
};
export interface WorkspaceProfile {
    name: string;
    path: string;
    kind: WorkspaceProfileKind;
    branch?: string;
    ref?: string;
    createdAt: string;
    updatedAt: string;
}
export interface GoalStore {
    getCurrentGoal(sessionKey: string): Promise<GoalRecord | undefined>;
    saveGoal(goal: GoalRecord): Promise<void>;
    clearGoal(sessionKey: string): Promise<void>;
    getReservation(sessionKey: string): Promise<ContinuationReservation | undefined>;
    saveReservation(reservation: ContinuationReservation): Promise<void>;
    clearReservation(sessionKey: string): Promise<void>;
    clearExpiredReservations(now?: Date): Promise<number>;
    appendLedgerEvent(event: GoalLedgerEvent): Promise<void>;
    listLedgerEvents(sessionKey: string, goalId?: string): Promise<GoalLedgerEvent[]>;
    saveGoalSessionMetadata(metadata: GoalSessionMetadata): Promise<void>;
    getGoalSessionMetadata(sessionKey: string): Promise<GoalSessionMetadata | undefined>;
    listGoalSummaries(): Promise<GoalSummary[]>;
    saveGoalDagNode(node: GoalDagNode): Promise<void>;
    getGoalDagNode(goalId: string, nodeId: string): Promise<GoalDagNode | undefined>;
    listGoalDagNodes(goalId: string): Promise<GoalDagNode[]>;
    saveGoalSubagent(subagent: GoalSubagentRecord): Promise<void>;
    getGoalSubagent(goalId: string, subagentId: string): Promise<GoalSubagentRecord | undefined>;
    listGoalSubagents(goalId: string, nodeId?: string): Promise<GoalSubagentRecord[]>;
    saveWorkspaceProfile(profile: WorkspaceProfile): Promise<void>;
    getWorkspaceProfile(name: string): Promise<WorkspaceProfile | undefined>;
    listWorkspaceProfiles(): Promise<WorkspaceProfile[]>;
    deleteWorkspaceProfile(name: string): Promise<boolean>;
    pruneLedgerEvents?(goalId: string, options: {
        maxEvents: number;
    }): Promise<number>;
    close?(): Promise<void> | void;
}
export interface GoalRuntimeConfig {
    defaultTokenBudget?: number;
    blockedTurnsThreshold?: number;
    maxContinuationAttempts?: number;
    continuationReservationTtlMs?: number;
    retryBaseDelayMs?: number;
    retryJitterMs?: number;
    now?: () => Date;
    randomId?: () => string;
}
export interface BlockedAuditEvidence {
    /** Number of recent goal turns inspected by the adapter. */
    inspectedGoalTurns: number;
    /** Number of consecutive recent goal turns carrying the same blocker signature. */
    consecutiveMatchingTurns: number;
    /** Stable adapter-derived description of the repeated blocker. */
    blockerSignature?: string;
    /** Human-readable explanation for diagnostics/rejections. */
    reason?: string;
    /** Suggested next user/system action, if the adapter can derive it. */
    suggestedAction?: string;
    /** Where the evidence came from, e.g. pi-session-transcript. */
    source: string;
}
export interface GoalToolResult {
    goal?: GoalRecord;
    message: string;
}
