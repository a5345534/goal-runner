import { adapterObservationFromHarnessState } from "./lifecycle.js";
import type { GoalDagNode, GoalNodePreparedResources, GoalSubagentRecord, GoalSubagentStatus } from "./types.js";

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

export interface HarnessSubagentSessionState {
  status: HarnessSubagentSessionStatus;
  lastActivityAt?: string;
  selfReportedResult?: string;
  validationSignals?: string[];
  error?: string;
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
    metadata: { ...(options.metadata ?? {}), ...(options.thinkingLevel ? { thinkingLevel: options.thinkingLevel } : {}) },
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
  await adapter.sendPrompt({ subagent, prompt, metadata: options.metadata });
  const now = toIso(options.now ?? new Date());
  return {
    ...subagent,
    status: "needsFollowup",
    prompts: [...subagent.prompts, prompt],
    lastActivityAt: now,
    updatedAt: now,
  };
}

export async function syncGoalSubagentState(
  adapter: HarnessSubagentAdapter,
  subagent: GoalSubagentRecord,
  options: { metadata?: Record<string, unknown>; now?: Date | string } = {},
): Promise<GoalSubagentRecord> {
  const state = await adapter.getSessionState({ subagent, metadata: options.metadata });
  const now = toIso(options.now ?? new Date());
  const nextStatus = mapHarnessStatusToSubagentStatus(state.status);
  if (isStaleBlockedOutcomeReplay(subagent, state, nextStatus)) return subagent;
  const observation = adapterObservationFromHarnessState(adapter.adapterId, state, { at: now });
  const controllerValidationResults = state.validationSignals?.length
    ? [...(subagent.controllerValidationResults ?? []), ...state.validationSignals]
    : subagent.controllerValidationResults;
  return {
    ...subagent,
    status: nextStatus,
    lastActivityAt: state.lastActivityAt ?? now,
    selfReportedResult: state.selfReportedResult ?? subagent.selfReportedResult,
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

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 10);
}

function toIso(value: Date | string): string {
  return typeof value === "string" ? new Date(value).toISOString() : value.toISOString();
}
