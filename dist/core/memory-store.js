export class MemoryGoalStore {
    goals = new Map();
    reservations = new Map();
    ledger = [];
    metadata = new Map();
    profiles = new Map();
    dagNodes = new Map();
    subagents = new Map();
    async getCurrentGoal(sessionKey) {
        const goal = this.goals.get(sessionKey);
        return goal ? { ...goal } : undefined;
    }
    async saveGoal(goal) {
        this.goals.set(goal.sessionKey, { ...goal });
    }
    async clearGoal(sessionKey) {
        this.goals.delete(sessionKey);
        this.reservations.delete(sessionKey);
    }
    async getReservation(sessionKey) {
        const reservation = this.reservations.get(sessionKey);
        return reservation ? { ...reservation } : undefined;
    }
    async saveReservation(reservation) {
        this.reservations.set(reservation.sessionKey, { ...reservation });
    }
    async clearReservation(sessionKey) {
        this.reservations.delete(sessionKey);
    }
    async clearExpiredReservations(now = new Date()) {
        let cleared = 0;
        for (const [sessionKey, reservation] of this.reservations.entries()) {
            if (new Date(reservation.expiresAt).getTime() <= now.getTime()) {
                this.reservations.delete(sessionKey);
                cleared += 1;
            }
        }
        return cleared;
    }
    async appendLedgerEvent(event) {
        this.ledger.push(cloneLedgerEvent(event));
    }
    async listLedgerEvents(sessionKey, goalId) {
        return this.ledger
            .filter((event) => event.sessionKey === sessionKey && (goalId === undefined || event.goalId === goalId))
            .map(cloneLedgerEvent);
    }
    async saveGoalSessionMetadata(metadata) {
        this.metadata.set(metadata.sessionKey, { ...metadata });
    }
    async getGoalSessionMetadata(sessionKey) {
        const metadata = this.metadata.get(sessionKey);
        return metadata ? { ...metadata } : undefined;
    }
    async listGoalSummaries() {
        const summaries = [...this.goals.values()].map((goal) => goalToSummary(goal, this.metadata.get(goal.sessionKey)));
        return summaries.sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
    }
    async saveGoalDagNode(node) {
        this.dagNodes.set(dagNodeKey(node.goalId, node.nodeId), cloneDagNode(node));
    }
    async getGoalDagNode(goalId, nodeId) {
        const node = this.dagNodes.get(dagNodeKey(goalId, nodeId));
        return node ? cloneDagNode(node) : undefined;
    }
    async listGoalDagNodes(goalId) {
        return [...this.dagNodes.values()]
            .filter((node) => node.goalId === goalId)
            .map(cloneDagNode)
            .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.nodeId.localeCompare(b.nodeId));
    }
    async saveGoalSubagent(subagent) {
        this.subagents.set(subagentKey(subagent.goalId, subagent.subagentId), cloneSubagent(subagent));
    }
    async getGoalSubagent(goalId, subagentId) {
        const subagent = this.subagents.get(subagentKey(goalId, subagentId));
        return subagent ? cloneSubagent(subagent) : undefined;
    }
    async listGoalSubagents(goalId, nodeId) {
        return [...this.subagents.values()]
            .filter((subagent) => subagent.goalId === goalId && (nodeId === undefined || subagent.nodeId === nodeId))
            .map(cloneSubagent)
            .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.subagentId.localeCompare(b.subagentId));
    }
    async saveWorkspaceProfile(profile) {
        this.profiles.set(profile.name, { ...profile });
    }
    async getWorkspaceProfile(name) {
        const profile = this.profiles.get(name);
        return profile ? { ...profile } : undefined;
    }
    async listWorkspaceProfiles() {
        return [...this.profiles.values()].map((profile) => ({ ...profile })).sort((a, b) => a.name.localeCompare(b.name));
    }
    async deleteWorkspaceProfile(name) {
        return this.profiles.delete(name);
    }
    async pruneLedgerEvents(goalId, options) {
        const goalEvents = this.ledger.filter((event) => event.goalId === goalId);
        if (goalEvents.length <= options.maxEvents)
            return 0;
        const excess = goalEvents.length - options.maxEvents;
        const toRemove = new Set(goalEvents.slice(0, excess).map((event) => event.eventId));
        this.ledger = this.ledger.filter((event) => !toRemove.has(event.eventId));
        return excess;
    }
}
function dagNodeKey(goalId, nodeId) {
    return `${goalId}:${nodeId}`;
}
function subagentKey(goalId, subagentId) {
    return `${goalId}:${subagentId}`;
}
function cloneLedgerEvent(event) {
    return {
        ...event,
        details: event.details ? { ...event.details } : undefined,
    };
}
function cloneDagNode(node) {
    return {
        ...node,
        validation: node.validation
            ? {
                ...node.validation,
                artifactLocks: node.validation.artifactLocks?.map((lock) => ({ ...lock })),
                requiredEvidence: node.validation.requiredEvidence ? [...node.validation.requiredEvidence] : undefined,
                auditReportPaths: node.validation.auditReportPaths ? [...node.validation.auditReportPaths] : undefined,
            }
            : undefined,
        dependencyNodeIds: [...node.dependencyNodeIds],
        expectedOutputs: [...node.expectedOutputs],
        validators: [...node.validators],
        workspace: node.workspace ? { ...node.workspace } : undefined,
        preparedResources: node.preparedResources ? cloneJson(node.preparedResources) : undefined,
        lastAdapterObservation: node.lastAdapterObservation ? cloneJson(node.lastAdapterObservation) : undefined,
        lastRecoveryDecision: node.lastRecoveryDecision ? cloneJson(node.lastRecoveryDecision) : undefined,
        conflictHints: node.conflictHints
            ? {
                files: node.conflictHints.files ? [...node.conflictHints.files] : undefined,
                modules: node.conflictHints.modules ? [...node.conflictHints.modules] : undefined,
                capabilities: node.conflictHints.capabilities ? [...node.conflictHints.capabilities] : undefined,
            }
            : undefined,
        completionGates: [...node.completionGates],
    };
}
function cloneSubagent(subagent) {
    return {
        ...subagent,
        prompts: [...subagent.prompts],
        controllerValidationResults: subagent.controllerValidationResults ? [...subagent.controllerValidationResults] : undefined,
        attemptCursor: subagent.attemptCursor ? cloneJson(subagent.attemptCursor) : undefined,
        lastActionAttempt: subagent.lastActionAttempt ? cloneJson(subagent.lastActionAttempt) : undefined,
        lastAdapterObservation: subagent.lastAdapterObservation ? cloneJson(subagent.lastAdapterObservation) : undefined,
        lastRecoveryDecision: subagent.lastRecoveryDecision ? cloneJson(subagent.lastRecoveryDecision) : undefined,
    };
}
function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
}
function goalToSummary(goal, metadata) {
    return {
        sessionKey: goal.sessionKey,
        goalId: goal.goalId,
        shortGoalId: goal.goalId.slice(0, 8),
        objective: goal.objective,
        objectiveSummary: summarizeObjective(goal.objective),
        status: goal.status,
        activityState: goal.status === "active" ? "idle-eligible" : goal.status,
        tokenBudget: goal.tokenBudget,
        tokensUsed: goal.tokensUsed,
        timeUsedSeconds: goal.timeUsedSeconds,
        createdAt: goal.createdAt,
        updatedAt: goal.updatedAt,
        lastActivityAt: metadata?.updatedAt ?? goal.updatedAt,
        originSessionKey: metadata?.originSessionKey,
        executionWorkspace: metadata?.executionWorkspace,
        workspaceStatus: metadata?.workspaceStatus ?? (metadata ? undefined : "legacy"),
        branch: metadata?.branch,
        ref: metadata?.ref,
        promotionTargetRef: metadata?.promotionTargetRef,
        branchVerificationStatus: metadata?.branchVerificationStatus,
        sessionFile: metadata?.sessionFile,
        sessionName: metadata?.sessionName,
        controllerModelScenario: metadata?.controllerModelScenario,
        controllerModelArg: metadata?.controllerModelArg,
        legacySessionBound: metadata?.legacySessionBound ?? !metadata,
    };
}
function summarizeObjective(objective) {
    return objective.length <= 120 ? objective : `${objective.slice(0, 117)}...`;
}
//# sourceMappingURL=memory-store.js.map