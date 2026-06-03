export const GOAL_STATUSES = [
  "active",
  "paused",
  "blocked",
  "usageLimited",
  "budgetLimited",
  "complete",
] as const;

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

export type HiddenGoalTurnResult =
  | { kind: "started"; hostTurnId?: string }
  | { kind: "alreadyStarted"; hostTurnId?: string }
  | { kind: "skipped"; reason: string }
  | { kind: "retryableFailure"; error: string }
  | { kind: "fatalFailure"; error: string };

export interface GoalSteeringContextRequest {
  sessionKey: string;
  goalId: string;
  kind: "budget_limit" | "objective_updated";
  renderedPrompt: string;
}

export type GoalLedgerEventType =
  | "goal_created"
  | "goal_replaced"
  | "goal_edited"
  | "goal_paused"
  | "goal_resumed"
  | "goal_cleared"
  | "turn_started"
  | "turn_finished"
  | "meaningful_progress"
  | "no_progress_continuation_suppressed"
  | "continuation_requested"
  | "continuation_started"
  | "continuation_already_started"
  | "continuation_skipped"
  | "continuation_retryable_failure"
  | "continuation_fatal_failure"
  | "completion_requested"
  | "completion_audit_result"
  | "goal_completed"
  | "goal_blocked"
  | "goal_budget_limited"
  | "goal_usage_limited";

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

export type GoalTurnStopReason =
  | "complete"
  | "blocked"
  | "completionRejected"
  | "pause"
  | "clear"
  | "budgetLimited"
  | "usageLimited";

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
  branchVerificationStatus?: BranchVerificationStatus;
  sessionFile?: string;
  sessionName?: string;
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
  branchVerificationStatus?: BranchVerificationStatus;
  sessionFile?: string;
  sessionName?: string;
  legacySessionBound?: boolean;
}

export type GoalDagNodeStatus =
  | "planned"
  | "ready"
  | "running"
  | "selfReportedComplete"
  | "controllerValidating"
  | "needsFollowup"
  | "complete"
  | "blocked"
  | "failed"
  | "superseded";

export interface GoalDagConflictHints {
  files?: string[];
  modules?: string[];
  capabilities?: string[];
}

export interface GoalDagNode {
  goalId: string;
  nodeId: string;
  slug: string;
  objective: string;
  scope?: string;
  dependencyNodeIds: string[];
  expectedOutputs: string[];
  validators: string[];
  workspaceStrategy?: string;
  risk?: "low" | "medium" | "high";
  /** Model-routing scenario selected for this node, resolved by DAG defaults/rules or explicit node config. */
  modelScenario?: string;
  /** Harness-native model argument selected for this node, persisted for restart-safe scheduling. */
  modelArg?: string;
  conflictHints?: GoalDagConflictHints;
  completionGates: string[];
  status: GoalDagNodeStatus;
  lastValidationSummary?: string;
  createdAt: string;
  updatedAt: string;
}

export type GoalSubagentStatus =
  | "planned"
  | "workspaceCreated"
  | "sessionStarted"
  | "running"
  | "idle"
  | "selfReportedComplete"
  | "controllerValidating"
  | "needsFollowup"
  | "complete"
  | "blocked"
  | "failed";

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
  commitSha?: string;
  integrationStatus?: string;
  createdAt: string;
  updatedAt: string;
}

export interface GoalOrchestrationState {
  goalId: string;
  nodes: GoalDagNode[];
  subagents: GoalSubagentRecord[];
}

export type GoalReferenceResolution =
  | { kind: "found"; goal: GoalSummary }
  | { kind: "notFound"; reference: string }
  | { kind: "ambiguous"; reference: string; matches: GoalSummary[] };

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
