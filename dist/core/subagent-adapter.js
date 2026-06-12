import { adapterObservationFromHarnessState } from "./lifecycle.js";
export async function startGoalSubagent(adapter, node, options) {
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
        createdAt: startedAt,
        updatedAt: startedAt,
    };
    return { record, startResult };
}
export async function sendGoalSubagentPrompt(adapter, subagent, prompt, options = {}) {
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
export async function syncGoalSubagentState(adapter, subagent, options = {}) {
    const state = await adapter.getSessionState({ subagent, metadata: options.metadata });
    const now = toIso(options.now ?? new Date());
    const nextStatus = mapHarnessStatusToSubagentStatus(state.status);
    if (isStaleBlockedOutcomeReplay(subagent, state, nextStatus))
        return subagent;
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
function randomSuffix() {
    return Math.random().toString(36).slice(2, 10);
}
function toIso(value) {
    return typeof value === "string" ? new Date(value).toISOString() : value.toISOString();
}
//# sourceMappingURL=subagent-adapter.js.map