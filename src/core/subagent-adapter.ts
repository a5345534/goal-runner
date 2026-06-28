import { adapterObservationFromHarnessState } from "./lifecycle.js";
import type { GoalAttemptCursor, GoalControllerActionAttemptRecord, GoalDagNode, GoalNodePreparedResources, GoalSubagentQuestionOutcome, GoalSubagentRecord, GoalSubagentStatus } from "./types.js";

export type HarnessSubagentSessionStatus =
  | "starting"
  | "running"
  | "idle"
  | "needsFollowup"
  | "selfReportedComplete"
  | "blocked"
  | "failed"
  | "stopped";

export interface HarnessSubagentStartRequest {
  goalId: string;
  node: GoalDagNode;
  subagentId: string;
  cwd?: string;
  branch?: string;
  ref?: string;
  systemPrompt?: string;
  initialPrompt: string;
  /** Controller-prepared resources. Legacy adapters may ignore this while honoring cwd/branch/ref/session fields. */
  preparedResources?: GoalNodePreparedResources;
  metadata?: Record<string, unknown>;
}

export interface HarnessSubagentStartResult {
  sessionId?: string;
  sessionFile?: string;
  workspacePath?: string;
  branch?: string;
  ref?: string;
  status?: HarnessSubagentSessionStatus;
  lastActivityAt?: string;
  metadata?: Record<string, unknown>;
}

export interface HarnessSubagentPromptRequest {
  subagent: GoalSubagentRecord;
  prompt: string;
  metadata?: Record<string, unknown>;
}

export interface HarnessSubagentStateRequest {
  subagent: GoalSubagentRecord;
  metadata?: Record<string, unknown>;
}

/** Marker prefix for SUBAGENT_QUESTION, SUBAGENT_RESULT, and SUBAGENT_BLOCKED. */
export const SUBAGENT_MARKER_PREFIXES = ["SUBAGENT_RESULT", "SUBAGENT_BLOCKED", "SUBAGENT_QUESTION"] as const;

/**
 * Regex that matches any SUBAGENT_* marker at the start of a line,
 * optionally preceded by markdown heading/formatting.
 */
export const SUBAGENT_MARKER_RX = /(?:^|\n)\s*(?:#{1,6}\s*)?(?:[-*]\s*)?(?:\*\*)?SUBAGENT_(?:[A-Z_]+)(?:\*\*)?\s*:\s*/i;

/**
 * Regex for SUBAGENT_QUESTION marker specifically.
 * Captures the question body text (everything until the next SUBAGENT_* marker or end of string).
 */
export const QUESTION_MARKER_RX = /(?:^|\n)\s*(?:#{1,6}\s*)?(?:[-*]\s*)?(?:\*\*)?SUBAGENT_QUESTION(?:\*\*)?\s*:\s*([\s\S]*?)(?=\n\s*(?:#{1,6}\s*)?(?:[-*]\s*)?(?:\*\*)?SUBAGENT_[A-Z_]+(?:\*\*)?\s*:|$)/i;

/**
 * Extract the text body of a SUBAGENT_QUESTION marker from assistant output.
 * Returns undefined if no question marker is found.
 */
export function extractQuestionMarker(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const match = text.match(QUESTION_MARKER_RX);
  return match?.[1]?.trim() || undefined;
}

/**
 * Check whether a status line signals question-pending state.
 */
export function isQuestionPendingState(subagent: GoalSubagentRecord): boolean {
  return subagent.status === "needsFollowup" &&
    subagent.selfReportedResult !== undefined &&
    QUESTION_MARKER_RX.test(subagent.selfReportedResult);
}

export interface HarnessSubagentSessionState {
  status: HarnessSubagentSessionStatus;
  lastActivityAt?: string;
  selfReportedResult?: string;
  validationSignals?: string[];
  error?: string;
  /** When a SUBAGENT_QUESTION is detected, the parsed question outcome (if triaged) or raw question text (if pending). */
  questionOutcome?: GoalSubagentQuestionOutcome;
  metadata?: Record<string, unknown>;
}

export interface HarnessSubagentAbortRequest {
  subagent: GoalSubagentRecord;
  reason?: string;
  metadata?: Record<string, unknown>;
}

export type HarnessSubagentEventType =
  | "sessionStarted"
  | "message"
  | "toolCall"
  | "toolResult"
  | "stateChanged"
  | "sessionEnded"
  | "error";

export interface HarnessSubagentEvent {
  type: HarnessSubagentEventType;
  at: string;
  subagentId?: string;
  sessionId?: string;
  data?: Record<string, unknown>;
}

export interface HarnessSubagentEventRequest {
  subagent: GoalSubagentRecord;
  signal?: AbortSignal;
  metadata?: Record<string, unknown>;
}

export interface HarnessSubagentAdapter {
  /** Stable adapter id, e.g. pi, codex, claude-code, opencode, shell-jsonrpc. */
  adapterId: string;
  startSession(request: HarnessSubagentStartRequest): Promise<HarnessSubagentStartResult> | HarnessSubagentStartResult;
  sendPrompt(request: HarnessSubagentPromptRequest): Promise<void> | void;
  getSessionState(request: HarnessSubagentStateRequest): Promise<HarnessSubagentSessionState> | HarnessSubagentSessionState;
  streamEvents?(request: HarnessSubagentEventRequest): AsyncIterable<HarnessSubagentEvent>;
  abortSession(request: HarnessSubagentAbortRequest): Promise<void> | void;
}

export interface StartGoalSubagentOptions {
  subagentId?: string;
  cwd?: string;
  branch?: string;
  ref?: string;
  systemPrompt?: string;
  initialPrompt: string;
  preparedResources?: GoalNodePreparedResources;
  metadata?: Record<string, unknown>;
  now?: Date | string;
  /** Pi thinking level for the subagent session (off|minimal|low|medium|high|xhigh). */
  thinkingLevel?: string;
}

export interface StartedGoalSubagent {
  record: GoalSubagentRecord;
  startResult: HarnessSubagentStartResult;
}

export async function startGoalSubagent(
  adapter: HarnessSubagentAdapter,
  node: GoalDagNode,
  options: StartGoalSubagentOptions,
): Promise<StartedGoalSubagent> {
  const subagentId = options.subagentId ?? `${node.nodeId}-${randomSuffix()}`;
  const startedAt = toIso(options.now ?? new Date());
  const attemptId = metadataString(options.metadata, "attemptId") ?? buildAttemptId(subagentId, startedAt, 1);
  const attemptStartedAt = metadataString(options.metadata, "attemptStartedAt") ?? startedAt;
  const attemptCursor = normalizeAttemptCursor(options.metadata?.attemptCursor, {
    at: attemptStartedAt,
    source: "controller-start",
    promptIndex: 0,
  });
  const launchAttempt = normalizeActionAttempt(options.metadata?.controllerActionAttempt, {
    actionId: buildActionAttemptId("runnerLaunch", node.goalId, subagentId, startedAt),
    actionKind: "runnerLaunch",
    startedAt,
    status: "started",
    evidence: { adapterId: adapter.adapterId, nodeId: node.nodeId },
  });
  const startResult = await adapter.startSession({
    goalId: node.goalId,
    node,
    subagentId,
    cwd: options.cwd,
    branch: options.branch,
    ref: options.ref,
    systemPrompt: options.systemPrompt,
    initialPrompt: options.initialPrompt,
    preparedResources: options.preparedResources,
    metadata: {
      ...(options.metadata ?? {}),
      attemptId,
      attemptStartedAt,
      attemptCursor,
      controllerActionAttempt: launchAttempt,
      ...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}),
    },
  });

  const record: GoalSubagentRecord = {
    goalId: node.goalId,
    nodeId: node.nodeId,
    subagentId,
    harnessAdapterId: adapter.adapterId,
    sessionId: startResult.sessionId,
    sessionFile: startResult.sessionFile,
    workspacePath: startResult.workspacePath ?? options.cwd,
    branch: startResult.branch ?? options.branch,
    ref: startResult.ref ?? options.ref,
    status: mapHarnessStatusToSubagentStatus(startResult.status ?? "starting"),
    integrationState: options.cwd || options.branch || options.ref || options.preparedResources ? "pending" : undefined,
    prompts: [options.initialPrompt],
    lastActivityAt: startResult.lastActivityAt ?? startedAt,
    attemptId,
    attemptStartedAt,
    attemptCursor,
    lastActionAttempt: { ...launchAttempt, status: "succeeded" },
    createdAt: startedAt,
    updatedAt: startedAt,
  };
  return { record, startResult };
}

export async function sendGoalSubagentPrompt(
  adapter: HarnessSubagentAdapter,
  subagent: GoalSubagentRecord,
  prompt: string,
  options: { metadata?: Record<string, unknown>; now?: Date | string } = {},
): Promise<GoalSubagentRecord> {
  const now = toIso(options.now ?? new Date());
  const attemptId = metadataString(options.metadata, "attemptId") ?? buildAttemptId(subagent.subagentId, now, subagent.prompts.length + 1);
  const attemptStartedAt = metadataString(options.metadata, "attemptStartedAt") ?? now;
  const attemptCursor = normalizeAttemptCursor(options.metadata?.attemptCursor, {
    at: attemptStartedAt,
    source: "prompt-dispatch",
    promptIndex: subagent.prompts.length,
  });
  const dispatchAttempt = normalizeActionAttempt(options.metadata?.controllerActionAttempt, {
    actionId: buildActionAttemptId("promptDispatch", subagent.goalId, subagent.subagentId, now),
    actionKind: "promptDispatch",
    startedAt: now,
    status: "started",
    evidence: { adapterId: adapter.adapterId, nodeId: subagent.nodeId, promptIndex: subagent.prompts.length },
  });
  const attemptScopedSubagent: GoalSubagentRecord = { ...subagent, attemptId, attemptStartedAt, attemptCursor, lastActionAttempt: dispatchAttempt };
  await adapter.sendPrompt({
    subagent: attemptScopedSubagent,
    prompt,
    metadata: { ...(options.metadata ?? {}), attemptId, attemptStartedAt, attemptCursor, controllerActionAttempt: dispatchAttempt },
  });
  return {
    ...attemptScopedSubagent,
    status: "needsFollowup",
    prompts: [...subagent.prompts, prompt],
    lastActionAttempt: { ...dispatchAttempt, status: "succeeded" },
    lastActivityAt: now,
    updatedAt: now,
  };
}

export async function syncGoalSubagentState(
  adapter: HarnessSubagentAdapter,
  subagent: GoalSubagentRecord,
  options: { metadata?: Record<string, unknown>; now?: Date | string } = {},
): Promise<GoalSubagentRecord> {
  const state = await adapter.getSessionState({
    subagent,
    metadata: {
      ...(options.metadata ?? {}),
      attemptId: subagent.attemptId,
      attemptStartedAt: subagent.attemptStartedAt,
      attemptCursor: subagent.attemptCursor,
    },
  });
  const now = toIso(options.now ?? new Date());
  const nextStatus = mapHarnessStatusToSubagentStatus(state.status);
  if (isStaleBlockedOutcomeReplay(subagent, state, nextStatus)) return subagent;
  const observation = adapterObservationFromHarnessState(adapter.adapterId, state, { at: now });
  const controllerValidationResults = state.validationSignals?.length
    ? [...(subagent.controllerValidationResults ?? []), ...state.validationSignals]
    : subagent.controllerValidationResults;
  const selfReportedResult = state.selfReportedResult && (nextStatus === "selfReportedComplete" || nextStatus === "blocked")
    ? state.selfReportedResult
    : subagent.selfReportedResult;
  return {
    ...subagent,
    status: nextStatus,
    lastActivityAt: state.lastActivityAt ?? now,
    selfReportedResult,
    controllerValidationResults,
    integrationStatus: state.error,
    lastAdapterObservation: observation,
    updatedAt: now,
  };
}

function isStaleBlockedOutcomeReplay(
  subagent: GoalSubagentRecord,
  state: HarnessSubagentSessionState,
  nextStatus: GoalSubagentStatus,
): boolean {
  if (subagent.status !== "blocked") return false;
  if (nextStatus !== "selfReportedComplete" && nextStatus !== "blocked" && nextStatus !== "failed") return false;
  if (hasNewerActivity(state.lastActivityAt, subagent.lastActivityAt)) return false;
  const sameSelfReport = equivalentOptionalText(state.selfReportedResult, subagent.selfReportedResult);
  const sameError = equivalentOptionalText(state.error, subagent.integrationStatus) || equivalentOptionalText(state.error, subagent.selfReportedResult);
  return sameSelfReport && sameError;
}

function equivalentOptionalText(incoming: string | undefined, current: string | undefined): boolean {
  if (!incoming) return true;
  if (!current) return false;
  return incoming === current || current.includes(incoming) || incoming.includes(current);
}

function hasNewerActivity(incoming: string | undefined, current: string | undefined): boolean {
  if (!incoming) return false;
  if (!current) return true;
  const incomingMs = Date.parse(incoming);
  const currentMs = Date.parse(current);
  if (!Number.isFinite(incomingMs)) return false;
  if (!Number.isFinite(currentMs)) return true;
  return incomingMs > currentMs;
}

export function mapHarnessStatusToSubagentStatus(status: HarnessSubagentSessionStatus): GoalSubagentStatus {
  switch (status) {
    case "starting":
      return "sessionStarted";
    case "running":
      return "running";
    case "idle":
      return "idle";
    case "needsFollowup":
      return "needsFollowup";
    case "selfReportedComplete":
      return "selfReportedComplete";
    case "blocked":
      return "blocked";
    case "failed":
      return "failed";
    case "stopped":
      return "complete";
  }
}

function metadataString(metadata: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function normalizeAttemptCursor(value: unknown, fallback: GoalAttemptCursor): GoalAttemptCursor {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fallback;
  const record = value as Record<string, unknown>;
  return { ...record, at: typeof record.at === "string" ? record.at : fallback.at, source: typeof record.source === "string" ? record.source : fallback.source };
}

function normalizeActionAttempt(value: unknown, fallback: GoalControllerActionAttemptRecord): GoalControllerActionAttemptRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fallback;
  const record = value as Record<string, unknown>;
  return {
    ...fallback,
    ...record,
    actionId: typeof record.actionId === "string" ? record.actionId : fallback.actionId,
    actionKind: isActionAttemptKind(record.actionKind) ? record.actionKind : fallback.actionKind,
    startedAt: typeof record.startedAt === "string" ? record.startedAt : fallback.startedAt,
    deadlineAt: typeof record.deadlineAt === "string" ? record.deadlineAt : fallback.deadlineAt,
    status: isActionAttemptStatus(record.status) ? record.status : fallback.status,
    error: typeof record.error === "string" ? record.error : fallback.error,
    evidence: record.evidence && typeof record.evidence === "object" && !Array.isArray(record.evidence) ? record.evidence as Record<string, unknown> : fallback.evidence,
  };
}

function isActionAttemptKind(value: unknown): value is GoalControllerActionAttemptRecord["actionKind"] {
  return typeof value === "string" && ["runnerLaunch", "promptDispatch", "recovery", "validation", "integration", "promotion", "cleanup"].includes(value);
}

function isActionAttemptStatus(value: unknown): value is GoalControllerActionAttemptRecord["status"] {
  return typeof value === "string" && ["started", "succeeded", "timedOut", "failed", "degraded"].includes(value);
}

function buildActionAttemptId(kind: GoalControllerActionAttemptRecord["actionKind"], goalId: string, subagentId: string, at: string): string {
  const timestamp = String(Date.parse(at)).replace(/[^0-9]/g, "") || at.replace(/[^0-9a-zA-Z]+/g, "-");
  return `${kind}-${goalId}-${subagentId}-${timestamp}`;
}

function buildAttemptId(subagentId: string, at: string, promptIndex: number): string {
  const timestamp = String(Date.parse(at)).replace(/[^0-9]/g, "") || at.replace(/[^0-9a-zA-Z]+/g, "-");
  return `${subagentId}-attempt-${promptIndex}-${timestamp}`;
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 10);
}

function toIso(value: Date | string): string {
  return typeof value === "string" ? new Date(value).toISOString() : value.toISOString();
}
