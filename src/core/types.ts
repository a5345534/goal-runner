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

export interface GoalAdapterCallbacks {
  resolveSessionKey?: () => Promise<string> | string;
  readHarnessState?: (sessionKey: string) => Promise<HarnessState> | HarnessState;
  startHiddenGoalTurn?: (request: HiddenGoalTurnRequest) => Promise<HiddenGoalTurnResult> | HiddenGoalTurnResult;
  injectSteeringContext?: (request: GoalSteeringContextRequest) => Promise<void> | void;
  notifyGoalUpdated?: (goal: GoalRecord) => Promise<void> | void;
  notifyGoalCleared?: (sessionKey: string) => Promise<void> | void;
  notifyGoalWarning?: (sessionKey: string, message: string) => Promise<void> | void;
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

export interface GoalStore {
  getCurrentGoal(sessionKey: string): Promise<GoalRecord | undefined>;
  saveGoal(goal: GoalRecord): Promise<void>;
  clearGoal(sessionKey: string): Promise<void>;
  getReservation(sessionKey: string): Promise<ContinuationReservation | undefined>;
  saveReservation(reservation: ContinuationReservation): Promise<void>;
  clearReservation(sessionKey: string): Promise<void>;
  clearExpiredReservations(now?: Date): Promise<number>;
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
  /** Where the evidence came from, e.g. pi-session-transcript. */
  source: string;
}

export interface GoalToolResult {
  goal?: GoalRecord;
  message: string;
}
