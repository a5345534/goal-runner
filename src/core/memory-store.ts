import type {
  ContinuationReservation,
  GoalLedgerEvent,
  GoalRecord,
  GoalSessionMetadata,
  GoalStore,
  GoalSummary,
  WorkspaceProfile,
} from "./types.js";

export class MemoryGoalStore implements GoalStore {
  private goals = new Map<string, GoalRecord>();
  private reservations = new Map<string, ContinuationReservation>();
  private ledger: GoalLedgerEvent[] = [];
  private metadata = new Map<string, GoalSessionMetadata>();
  private profiles = new Map<string, WorkspaceProfile>();

  async getCurrentGoal(sessionKey: string): Promise<GoalRecord | undefined> {
    const goal = this.goals.get(sessionKey);
    return goal ? { ...goal } : undefined;
  }

  async saveGoal(goal: GoalRecord): Promise<void> {
    this.goals.set(goal.sessionKey, { ...goal });
  }

  async clearGoal(sessionKey: string): Promise<void> {
    this.goals.delete(sessionKey);
    this.reservations.delete(sessionKey);
  }

  async getReservation(sessionKey: string): Promise<ContinuationReservation | undefined> {
    const reservation = this.reservations.get(sessionKey);
    return reservation ? { ...reservation } : undefined;
  }

  async saveReservation(reservation: ContinuationReservation): Promise<void> {
    this.reservations.set(reservation.sessionKey, { ...reservation });
  }

  async clearReservation(sessionKey: string): Promise<void> {
    this.reservations.delete(sessionKey);
  }

  async clearExpiredReservations(now = new Date()): Promise<number> {
    let cleared = 0;
    for (const [sessionKey, reservation] of this.reservations.entries()) {
      if (new Date(reservation.expiresAt).getTime() <= now.getTime()) {
        this.reservations.delete(sessionKey);
        cleared += 1;
      }
    }
    return cleared;
  }

  async appendLedgerEvent(event: GoalLedgerEvent): Promise<void> {
    this.ledger.push(cloneLedgerEvent(event));
  }

  async listLedgerEvents(sessionKey: string, goalId?: string): Promise<GoalLedgerEvent[]> {
    return this.ledger
      .filter((event) => event.sessionKey === sessionKey && (goalId === undefined || event.goalId === goalId))
      .map(cloneLedgerEvent);
  }

  async saveGoalSessionMetadata(metadata: GoalSessionMetadata): Promise<void> {
    this.metadata.set(metadata.sessionKey, { ...metadata });
  }

  async getGoalSessionMetadata(sessionKey: string): Promise<GoalSessionMetadata | undefined> {
    const metadata = this.metadata.get(sessionKey);
    return metadata ? { ...metadata } : undefined;
  }

  async listGoalSummaries(): Promise<GoalSummary[]> {
    const summaries = [...this.goals.values()].map((goal) => goalToSummary(goal, this.metadata.get(goal.sessionKey)));
    return summaries.sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
  }

  async saveWorkspaceProfile(profile: WorkspaceProfile): Promise<void> {
    this.profiles.set(profile.name, { ...profile });
  }

  async getWorkspaceProfile(name: string): Promise<WorkspaceProfile | undefined> {
    const profile = this.profiles.get(name);
    return profile ? { ...profile } : undefined;
  }

  async listWorkspaceProfiles(): Promise<WorkspaceProfile[]> {
    return [...this.profiles.values()].map((profile) => ({ ...profile })).sort((a, b) => a.name.localeCompare(b.name));
  }

  async deleteWorkspaceProfile(name: string): Promise<boolean> {
    return this.profiles.delete(name);
  }
}

function cloneLedgerEvent(event: GoalLedgerEvent): GoalLedgerEvent {
  return {
    ...event,
    details: event.details ? { ...event.details } : undefined,
  };
}

function goalToSummary(goal: GoalRecord, metadata: GoalSessionMetadata | undefined): GoalSummary {
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

function summarizeObjective(objective: string): string {
  return objective.length <= 120 ? objective : `${objective.slice(0, 117)}...`;
}
