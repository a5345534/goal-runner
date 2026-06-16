export const GOAL_CONTROLLER_AUDIT_LEDGER_EVENT_TYPES = [
  "controller_audit_started",
  "controller_audit_finished",
  "controller_audit_invalid_output",
  "controller_audit_action_applied",
  "controller_audit_action_skipped",
  "goal_paused_by_controller_audit",
] as const;

export type GoalControllerAuditLedgerEventType = (typeof GOAL_CONTROLLER_AUDIT_LEDGER_EVENT_TYPES)[number];

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
    kind:
      | "retry-loop"
      | "no-progress"
      | "invalid-contract-suspected"
      | "cost-spike"
      | "stale-runner"
      | "repeated-validation-failure"
      | "integration-loop"
      | "provider-or-quota-issue"
      | "unknown";
    nodeId?: string;
    subagentId?: string;
    evidence: string[];
    confidence: "low" | "medium" | "high";
  }>;
  recommendedActions: Array<{
    action:
      | "noop"
      | "pause-goal"
      | "cap-retries"
      | "stop-launching-new-subagents"
      | "reduce-concurrency"
      | "request-user-intervention"
      | "open-diagnostic-report"
      | "run-deterministic-contract-check"
      | "mark-node-blocked";
    nodeId?: string;
    subagentId?: string;
    reason: string;
    requiresUserApproval: boolean;
  }>;
}
