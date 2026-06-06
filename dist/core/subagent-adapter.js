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
        integrationState: options.cwd || options.branch || options.ref ? "pending" : undefined,
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
    const controllerValidationResults = state.validationSignals?.length
        ? [...(subagent.controllerValidationResults ?? []), ...state.validationSignals]
        : subagent.controllerValidationResults;
    return {
        ...subagent,
        status: mapHarnessStatusToSubagentStatus(state.status),
        lastActivityAt: state.lastActivityAt ?? now,
        selfReportedResult: state.selfReportedResult ?? subagent.selfReportedResult,
        controllerValidationResults,
        integrationStatus: state.error,
        updatedAt: now,
    };
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