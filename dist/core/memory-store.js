export class MemoryGoalStore {
    goals = new Map();
    reservations = new Map();
    ledger = [];
    metadata = new Map();
    profiles = new Map();
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
}
function cloneLedgerEvent(event) {
    return {
        ...event,
        details: event.details ? { ...event.details } : undefined,
    };
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
        branchVerificationStatus: metadata?.branchVerificationStatus,
        sessionFile: metadata?.sessionFile,
        sessionName: metadata?.sessionName,
        legacySessionBound: metadata?.legacySessionBound ?? !metadata,
    };
}
function summarizeObjective(objective) {
    return objective.length <= 120 ? objective : `${objective.slice(0, 117)}...`;
}
//# sourceMappingURL=memory-store.js.map