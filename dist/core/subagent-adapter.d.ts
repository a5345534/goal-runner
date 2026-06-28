import type { GoalDagNode, GoalNodePreparedResources, GoalSubagentQuestionOutcome, GoalSubagentRecord, GoalSubagentStatus } from "./types.js";
export type HarnessSubagentSessionStatus = "starting" | "running" | "idle" | "needsFollowup" | "selfReportedComplete" | "blocked" | "failed" | "stopped";
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
export declare const SUBAGENT_MARKER_PREFIXES: readonly ["SUBAGENT_RESULT", "SUBAGENT_BLOCKED", "SUBAGENT_QUESTION"];
/**
 * Regex that matches any SUBAGENT_* marker at the start of a line,
 * optionally preceded by markdown heading/formatting.
 */
export declare const SUBAGENT_MARKER_RX: RegExp;
/**
 * Regex for SUBAGENT_QUESTION marker specifically.
 * Captures the question body text (everything until the next SUBAGENT_* marker or end of string).
 */
export declare const QUESTION_MARKER_RX: RegExp;
/**
 * Extract the text body of a SUBAGENT_QUESTION marker from assistant output.
 * Returns undefined if no question marker is found.
 */
export declare function extractQuestionMarker(text: string | undefined): string | undefined;
/**
 * Check whether a status line signals question-pending state.
 */
export declare function isQuestionPendingState(subagent: GoalSubagentRecord): boolean;
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
export type HarnessSubagentEventType = "sessionStarted" | "message" | "toolCall" | "toolResult" | "stateChanged" | "sessionEnded" | "error";
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
export declare function startGoalSubagent(adapter: HarnessSubagentAdapter, node: GoalDagNode, options: StartGoalSubagentOptions): Promise<StartedGoalSubagent>;
export declare function sendGoalSubagentPrompt(adapter: HarnessSubagentAdapter, subagent: GoalSubagentRecord, prompt: string, options?: {
    metadata?: Record<string, unknown>;
    now?: Date | string;
}): Promise<GoalSubagentRecord>;
export declare function syncGoalSubagentState(adapter: HarnessSubagentAdapter, subagent: GoalSubagentRecord, options?: {
    metadata?: Record<string, unknown>;
    now?: Date | string;
}): Promise<GoalSubagentRecord>;
export declare function mapHarnessStatusToSubagentStatus(status: HarnessSubagentSessionStatus): GoalSubagentStatus;
