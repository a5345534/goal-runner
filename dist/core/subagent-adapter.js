import { adapterObservationFromHarnessState } from "./lifecycle.js";
/** Marker prefix for SUBAGENT_QUESTION, SUBAGENT_RESULT, and SUBAGENT_BLOCKED. */
export const SUBAGENT_MARKER_PREFIXES = ["SUBAGENT_RESULT", "SUBAGENT_BLOCKED", "SUBAGENT_QUESTION"];
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
export function extractQuestionMarker(text) {
    if (!text)
        return undefined;
    const match = text.match(QUESTION_MARKER_RX);
    return match?.[1]?.trim() || undefined;
}
/**
 * Check whether a status line signals question-pending state.
 */
export function isQuestionPendingState(subagent) {
    return subagent.status === "needsFollowup" &&
        subagent.selfReportedResult !== undefined &&
        QUESTION_MARKER_RX.test(subagent.selfReportedResult);
}
export async function startGoalSubagent(adapter, node, options) {
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
    const record = {
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
export async function sendGoalSubagentPrompt(adapter, subagent, prompt, options = {}) {
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
    const attemptScopedSubagent = { ...subagent, attemptId, attemptStartedAt, attemptCursor, lastActionAttempt: dispatchAttempt };
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
export async function syncGoalSubagentState(adapter, subagent, options = {}) {
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
    if (isStaleBlockedOutcomeReplay(subagent, state, nextStatus))
        return subagent;
    const observation = adapterObservationFromHarnessState(adapter.adapterId, state, { at: now });
    const controllerValidationResults = state.validationSignals?.length
        ? [...(subagent.controllerValidationResults ?? []), ...state.validationSignals]
        : subagent.controllerValidationResults;
    const selfReportedResult = state.selfReportedResult && (nextStatus === "selfReportedComplete" || nextStatus === "blocked" || nextStatus === "needsFollowup")
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
function isStaleBlockedOutcomeReplay(subagent, state, nextStatus) {
    if (subagent.status !== "blocked")
        return false;
    if (nextStatus !== "selfReportedComplete" && nextStatus !== "blocked" && nextStatus !== "failed")
        return false;
    if (hasNewerActivity(state.lastActivityAt, subagent.lastActivityAt))
        return false;
    const sameSelfReport = equivalentOptionalText(state.selfReportedResult, subagent.selfReportedResult);
    const sameError = equivalentOptionalText(state.error, subagent.integrationStatus) || equivalentOptionalText(state.error, subagent.selfReportedResult);
    return sameSelfReport && sameError;
}
function equivalentOptionalText(incoming, current) {
    if (!incoming)
        return true;
    if (!current)
        return false;
    return incoming === current || current.includes(incoming) || incoming.includes(current);
}
function hasNewerActivity(incoming, current) {
    if (!incoming)
        return false;
    if (!current)
        return true;
    const incomingMs = Date.parse(incoming);
    const currentMs = Date.parse(current);
    if (!Number.isFinite(incomingMs))
        return false;
    if (!Number.isFinite(currentMs))
        return true;
    return incomingMs > currentMs;
}
export function mapHarnessStatusToSubagentStatus(status) {
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
function metadataString(metadata, key) {
    const value = metadata?.[key];
    return typeof value === "string" && value.trim() ? value : undefined;
}
function normalizeAttemptCursor(value, fallback) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return fallback;
    const record = value;
    return { ...record, at: typeof record.at === "string" ? record.at : fallback.at, source: typeof record.source === "string" ? record.source : fallback.source };
}
function normalizeActionAttempt(value, fallback) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return fallback;
    const record = value;
    return {
        ...fallback,
        ...record,
        actionId: typeof record.actionId === "string" ? record.actionId : fallback.actionId,
        actionKind: isActionAttemptKind(record.actionKind) ? record.actionKind : fallback.actionKind,
        startedAt: typeof record.startedAt === "string" ? record.startedAt : fallback.startedAt,
        deadlineAt: typeof record.deadlineAt === "string" ? record.deadlineAt : fallback.deadlineAt,
        status: isActionAttemptStatus(record.status) ? record.status : fallback.status,
        error: typeof record.error === "string" ? record.error : fallback.error,
        evidence: record.evidence && typeof record.evidence === "object" && !Array.isArray(record.evidence) ? record.evidence : fallback.evidence,
    };
}
function isActionAttemptKind(value) {
    return typeof value === "string" && ["runnerLaunch", "promptDispatch", "recovery", "validation", "integration", "promotion", "cleanup"].includes(value);
}
function isActionAttemptStatus(value) {
    return typeof value === "string" && ["started", "succeeded", "timedOut", "failed", "degraded"].includes(value);
}
function buildActionAttemptId(kind, goalId, subagentId, at) {
    const timestamp = String(Date.parse(at)).replace(/[^0-9]/g, "") || at.replace(/[^0-9a-zA-Z]+/g, "-");
    return `${kind}-${goalId}-${subagentId}-${timestamp}`;
}
function buildAttemptId(subagentId, at, promptIndex) {
    const timestamp = String(Date.parse(at)).replace(/[^0-9]/g, "") || at.replace(/[^0-9a-zA-Z]+/g, "-");
    return `${subagentId}-attempt-${promptIndex}-${timestamp}`;
}
function randomSuffix() {
    return Math.random().toString(36).slice(2, 10);
}
function toIso(value) {
    return typeof value === "string" ? new Date(value).toISOString() : value.toISOString();
}
//# sourceMappingURL=subagent-adapter.js.map