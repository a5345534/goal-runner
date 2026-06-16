import type { GoalLedgerEvent, GoalOrchestrationState, GoalRecord } from "./types.js";
export declare const GOAL_CONTROLLER_AUDIT_LEDGER_EVENT_TYPES: readonly ["controller_audit_started", "controller_audit_finished", "controller_audit_invalid_output", "controller_audit_action_applied", "controller_audit_action_skipped", "goal_paused_by_controller_audit"];
export type GoalControllerAuditLedgerEventType = (typeof GOAL_CONTROLLER_AUDIT_LEDGER_EVENT_TYPES)[number];
/** Default audit interval: 30 minutes. */
export declare const DEFAULT_AUDIT_INTERVAL_MS: number;
/** Default max recent controller events to include in the snapshot. */
export declare const DEFAULT_MAX_RECENT_EVENTS = 200;
/** Default max recent validation summaries aggregated for the snapshot. */
export declare const DEFAULT_MAX_RECENT_VALIDATION_RESULTS = 50;
export interface GoalControllerAuditOptions {
    enabled?: boolean;
    intervalMs?: number;
    /** Default: 200. */
    maxRecentEvents?: number;
    /** Default: 50. */
    maxRecentValidationResults?: number;
    maxTokensPerAudit?: number;
    /** Default: true. */
    pauseOnCritical?: boolean;
    /** Default: false. */
    includeTranscriptExcerpts?: boolean;
}
export interface GoalControllerAuditSnapshot {
    goal: {
        goalId: string;
        status: string;
        ageMinutes?: number;
        tokensUsed?: number;
        lastProgressAt?: string;
    };
    nodes: Array<{
        nodeId: string;
        status: string;
        lifecyclePhase?: string;
        retryCount?: number;
        lastValidationSummary?: string;
        lastUpdatedAt?: string;
    }>;
    subagents: Array<{
        subagentId: string;
        nodeId: string;
        status: string;
        retryCount?: number;
        lastActivityAt?: string;
        lastAdapterObservation?: string;
        integrationState?: string;
    }>;
    recentControllerEvents: Array<{
        at: string;
        type: string;
        nodeId?: string;
        subagentId?: string;
        summary?: string;
    }>;
    recentValidationSummaries: Array<{
        nodeId: string;
        summary: string;
        countInWindow: number;
    }>;
    progressSignals: {
        completedNodesLastWindow: number;
        validationFailuresLastWindow: number;
        followupsLastWindow: number;
        retriesLastWindow: number;
        integrationsFailedLastWindow: number;
    };
    costSignals?: {
        tokensLastWindow?: number;
        estimatedCostLastWindow?: number;
    };
}
export interface GoalControllerAuditDecision {
    risk: "low" | "medium" | "high" | "critical";
    summary: string;
    findings: Array<{
        kind: "retry-loop" | "no-progress" | "invalid-contract-suspected" | "cost-spike" | "stale-runner" | "repeated-validation-failure" | "integration-loop" | "provider-or-quota-issue" | "unknown";
        nodeId?: string;
        subagentId?: string;
        evidence: string[];
        confidence: "low" | "medium" | "high";
    }>;
    recommendedActions: Array<{
        action: "noop" | "pause-goal" | "cap-retries" | "stop-launching-new-subagents" | "reduce-concurrency" | "request-user-intervention" | "open-diagnostic-report" | "run-deterministic-contract-check" | "mark-node-blocked";
        nodeId?: string;
        subagentId?: string;
        reason: string;
        requiresUserApproval: boolean;
    }>;
}
/** Result returned by {@link applyAuditActions}. */
export interface AuditActionPolicyResult {
    /** Whether the goal should be paused by this audit. */
    shouldPauseGoal: boolean;
    /** Human-readable reason for the pause, if applicable. */
    pauseReason?: string;
    /** Actions that were applied (currently only `pause-goal` may be auto-applied). */
    applied: Array<{
        action: GoalControllerAuditDecision["recommendedActions"][number];
        matchedFinding: GoalControllerAuditDecision["findings"][number];
    }>;
    /** Actions that were skipped with a reason. */
    skipped: Array<{
        action: GoalControllerAuditDecision["recommendedActions"][number];
        reason: string;
    }>;
}
/**
 * Returns `true` when a controller audit is due for the current goal.
 * Audit is due when it is enabled, the configured interval has elapsed since
 * the last audit, or no previous audit has run.
 */
export declare function isAuditDue(options: GoalControllerAuditOptions, lastAuditAt?: string | Date, now?: Date): boolean;
/**
 * Builds a bounded structured {@link GoalControllerAuditSnapshot} from
 * trusted runtime state.  Transcripts are excluded unless
 * `options.includeTranscriptExcerpts` is `true`.
 */
export declare function buildControllerAuditSnapshot(params: {
    state: GoalOrchestrationState;
    goal: GoalRecord;
    recentEvents: GoalLedgerEvent[];
    options: GoalControllerAuditOptions;
    now?: Date;
}): GoalControllerAuditSnapshot;
/**
 * Validates a candidate object against the
 * {@link GoalControllerAuditDecision} schema.
 *
 * Returns `{ valid: true, decision }` when the candidate passes all
 * structural checks, or `{ valid: false, errors }` listing every
 * detected issue.
 */
export declare function validateControllerAuditDecision(candidate: unknown): {
    valid: true;
    decision: GoalControllerAuditDecision;
} | {
    valid: false;
    errors: string[];
};
/**
 * Evaluates a validated audit decision against the safe action policy.
 *
 * ## Policy rules
 *
 * 1. **`pause-goal` auto-action** — applied when ALL hold:
 *    - `decision.risk === "critical"`
 *    - At least one finding has `confidence === "high"`
 *    - `options.pauseOnCritical` is enabled (default `true`)
 *
 * 2. **All other actions** (including `pause-goal` recommendations that do
 *    not meet the auto-pause criteria) are recorded as **skipped** and
 *    require deterministic confirmation before they can be applied.
 *
 * This function is a pure policy evaluator; it does **not** mutate
 * runtime state.  The caller is responsible for pausing the goal and
 * recording ledger events based on the returned result.
 */
export declare function applyAuditActions(decision: GoalControllerAuditDecision, options: GoalControllerAuditOptions): AuditActionPolicyResult;
/** Callback for recording a single audit lifecycle ledger event. */
export type AuditEventRecorder = (eventType: GoalControllerAuditLedgerEventType, details: Record<string, unknown>, at?: Date | string) => void | Promise<void>;
/**
 * Records ledger events for the outcome of {@link applyAuditActions}.
 *
 * - One `controller_audit_action_applied` event per applied action.
 * - One `controller_audit_action_skipped` event per skipped action.
 * - One `goal_paused_by_controller_audit` event when `result.shouldPauseGoal`
 *   is `true`.
 *
 * The caller must supply an {@link AuditEventRecorder} that writes to the
 * durable goal ledger.
 */
export declare function recordAuditActionEvents(result: AuditActionPolicyResult, decision: GoalControllerAuditDecision, recorder: AuditEventRecorder, at?: Date | string): Promise<void>;
/**
 * Renders a compact single-line audit summary suitable for monitor/status
 * display.
 *
 * Format: `Controller audit: <risk> <finding-kinds> on <nodeIds>; <applied actions>`
 */
export declare function formatAuditSummary(decision: GoalControllerAuditDecision, appliedActions: AuditActionPolicyResult["applied"]): string;
