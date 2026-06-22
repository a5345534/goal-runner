const LIFECYCLE_STATUS_PROJECTION = {
    acceptanceDefined: "ready",
    resourcesCreating: "running",
    resourcesReady: "ready",
    runnerStarting: "running",
    runnerActive: "running",
    controllerJudging: "controllerValidating",
    validating: "controllerValidating",
    integrating: "controllerValidating",
    terminal: "complete",
};
export function projectLifecyclePhaseToNodeStatus(phase, terminalStatus = "complete") {
    return phase === "terminal" ? terminalStatus : LIFECYCLE_STATUS_PROJECTION[phase];
}
export function withGoalDagNodeLifecyclePhase(node, phase, options = {}) {
    const status = options.status ?? projectLifecyclePhaseToNodeStatus(phase, node.status);
    return { ...node, lifecyclePhase: phase, status, updatedAt: toIso(options.now ?? new Date()) };
}
export function attachPreparedResourcesToNode(node, resources, options = {}) {
    const now = toIso(options.now ?? new Date());
    const preparedResources = {
        ...resources,
        createdAt: resources.createdAt ?? now,
        updatedAt: now,
    };
    return {
        ...node,
        modelScenario: preparedResources.modelScenario ?? node.modelScenario,
        modelClass: preparedResources.modelClass ?? node.modelClass,
        modelArg: preparedResources.modelArg ?? node.modelArg,
        modelResolution: preparedResources.modelResolution ?? node.modelResolution,
        preparedResources,
        lifecyclePhase: options.phase ?? node.lifecyclePhase,
        updatedAt: now,
    };
}
export function supersedePreparedResourcesOnNode(node, resources, options = { reason: "superseded" }) {
    const now = toIso(options.now ?? new Date());
    const superseded = node.preparedResources
        ? {
            ...node.preparedResources,
            supersededAt: now,
            supersededBy: options.supersededBy ?? resources.subagentId,
            supersessionReason: options.reason,
        }
        : undefined;
    return attachPreparedResourcesToNode(node, {
        ...resources,
        metadata: {
            ...(resources.metadata ?? {}),
            ...(superseded ? { supersedes: superseded } : {}),
        },
    }, { phase: options.phase ?? node.lifecyclePhase, now });
}
export function recordAdapterObservationOnNode(node, observation, options = {}) {
    const now = toIso(options.now ?? new Date());
    return {
        ...node,
        lastAdapterObservation: { ...observation, at: observation.at ?? now },
        lifecyclePhase: options.phase ?? node.lifecyclePhase,
        updatedAt: now,
    };
}
export function recordRecoveryDecisionOnNode(node, decision, options = {}) {
    const now = toIso(options.now ?? new Date());
    return {
        ...node,
        lastRecoveryDecision: { ...decision, at: decision.at ?? now },
        lifecyclePhase: options.phase ?? node.lifecyclePhase,
        status: options.status ?? node.status,
        lastValidationSummary: decision.reason ?? node.lastValidationSummary,
        updatedAt: now,
    };
}
export function observationKindFromHarnessState(state) {
    switch (state.status) {
        case "starting":
            return "runnerStarting";
        case "running":
            return "running";
        case "idle":
            return "idle";
        case "needsFollowup":
            return state.error ? "protocolViolation" : "protocolViolation";
        case "selfReportedComplete":
            return "selfReportedComplete";
        case "blocked":
            return "selfReportedBlocked";
        case "failed":
            return state.error && /not live|stale|runner/i.test(state.error) ? "runnerLost" : "runnerError";
        case "stopped":
            return "stopped";
    }
}
export function adapterObservationFromHarnessState(adapterId, state, options = {}) {
    return {
        adapterId,
        kind: observationKindFromHarnessState(state),
        at: toIso(options.at ?? new Date()),
        summary: options.summary ?? state.selfReportedResult,
        error: state.error,
        evidence: options.evidence ?? state.metadata,
    };
}
function toIso(value) {
    return typeof value === "string" ? new Date(value).toISOString() : value.toISOString();
}
//# sourceMappingURL=lifecycle.js.map