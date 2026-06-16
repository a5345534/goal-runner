import type { GoalControllerAuditDecision } from "./controller-audit.js";
import type {
  ContinuationReservation,
  GoalDagNode,
  GoalLedgerEvent,
  GoalRecord,
  GoalSessionMetadata,
  GoalStore,
  GoalSubagentRecord,
  GoalSummary,
  WorkspaceProfile,
} from "./types.js";

export interface GoalAuditDecisionRecord {
  decision: GoalControllerAuditDecision;
  finishedAt: string;
  appliedActionNames: string[];
}

export class MemoryGoalStore implements GoalStore {
  private goals = new Map<string, GoalRecord>();
  private reservations = new Map<string, ContinuationReservation>();
  private ledger: GoalLedgerEvent[] = [];
  private metadata = new Map<string, GoalSessionMetadata>();
  private profiles = new Map<string, WorkspaceProfile>();
  private dagNodes = new Map<string, GoalDagNode>();
  private subagents = new Map<string, GoalSubagentRecord>();

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

  async saveGoalDagNode(node: GoalDagNode): Promise<void> {
    this.dagNodes.set(dagNodeKey(node.goalId, node.nodeId), cloneDagNode(node));
  }

  async getGoalDagNode(goalId: string, nodeId: string): Promise<GoalDagNode | undefined> {
    const node = this.dagNodes.get(dagNodeKey(goalId, nodeId));
    return node ? cloneDagNode(node) : undefined;
  }

  async listGoalDagNodes(goalId: string): Promise<GoalDagNode[]> {
    return [...this.dagNodes.values()]
      .filter((node) => node.goalId === goalId)
      .map(cloneDagNode)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.nodeId.localeCompare(b.nodeId));
  }

  async saveGoalSubagent(subagent: GoalSubagentRecord): Promise<void> {
    this.subagents.set(subagentKey(subagent.goalId, subagent.subagentId), cloneSubagent(subagent));
  }

  async getGoalSubagent(goalId: string, subagentId: string): Promise<GoalSubagentRecord | undefined> {
    const subagent = this.subagents.get(subagentKey(goalId, subagentId));
    return subagent ? cloneSubagent(subagent) : undefined;
  }

  async listGoalSubagents(goalId: string, nodeId?: string): Promise<GoalSubagentRecord[]> {
    return [...this.subagents.values()]
      .filter((subagent) => subagent.goalId === goalId && (nodeId === undefined || subagent.nodeId === nodeId))
      .map(cloneSubagent)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.subagentId.localeCompare(b.subagentId));
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

  async pruneLedgerEvents(goalId: string, options: { maxEvents: number }): Promise<number> {
    const goalEvents = this.ledger.filter((event) => event.goalId === goalId);
    if (goalEvents.length <= options.maxEvents) return 0;
    const excess = goalEvents.length - options.maxEvents;
    const toRemove = new Set(goalEvents.slice(0, excess).map((event) => event.eventId));
    this.ledger = this.ledger.filter((event) => !toRemove.has(event.eventId));
    return excess;
  }

  /**
   * Returns the latest controller audit decision and applied action names,
   * or `undefined` when no audit has completed for this goal.
   */
  async getLatestAuditDecision(goalId: string): Promise<GoalAuditDecisionRecord | undefined> {
    const events = this.ledger.filter(
      (event) => event.goalId === goalId,
    );

    // Find the most recent controller_audit_finished event.
    let latestFinished: GoalLedgerEvent | undefined;
    for (const event of events) {
      if (event.type === "controller_audit_finished") {
        latestFinished = event;
      }
    }
    if (!latestFinished) return undefined;

    const details = (latestFinished.details ?? {}) as Record<string, unknown>;
    const decision = details as unknown as GoalControllerAuditDecision;
    if (!decision.risk || !decision.summary) return undefined;

    // Collect applied actions recorded after the finished event.
    const finishedAt = latestFinished.at;
    const appliedActionNames: string[] = [];
    for (const event of events) {
      if (event.type !== "controller_audit_action_applied") continue;
      if (event.at < finishedAt) continue;
      const actionDetails = (event.details ?? {}) as Record<string, unknown>;
      const actionName = (actionDetails.action as string) ?? "pause-goal";
      appliedActionNames.push(actionName);
    }

    return { decision, finishedAt, appliedActionNames };
  }
}

function dagNodeKey(goalId: string, nodeId: string): string {
  return `${goalId}:${nodeId}`;
}

function subagentKey(goalId: string, subagentId: string): string {
  return `${goalId}:${subagentId}`;
}

function cloneLedgerEvent(event: GoalLedgerEvent): GoalLedgerEvent {
  return {
    ...event,
    details: event.details ? { ...event.details } : undefined,
  };
}

function cloneDagNode(node: GoalDagNode): GoalDagNode {
  return {
    ...node,
    validation: node.validation
      ? {
          ...node.validation,
          artifactLocks: node.validation.artifactLocks?.map((lock) => ({ ...lock })),
          requiredEvidence: node.validation.requiredEvidence ? [...node.validation.requiredEvidence] : undefined,
          auditReportPaths: node.validation.auditReportPaths ? [...node.validation.auditReportPaths] : undefined,
          allowedPaths: node.validation.allowedPaths ? [...node.validation.allowedPaths] : undefined,
          forbiddenPaths: node.validation.forbiddenPaths ? [...node.validation.forbiddenPaths] : undefined,
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

function cloneSubagent(subagent: GoalSubagentRecord): GoalSubagentRecord {
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

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
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
    promotionTargetRef: metadata?.promotionTargetRef,
    branchVerificationStatus: metadata?.branchVerificationStatus,
    sessionFile: metadata?.sessionFile,
    sessionName: metadata?.sessionName,
    controllerModelScenario: metadata?.controllerModelScenario,
    controllerModelArg: metadata?.controllerModelArg,
    legacySessionBound: metadata?.legacySessionBound ?? !metadata,
  };
}

function summarizeObjective(objective: string): string {
  return objective.length <= 120 ? objective : `${objective.slice(0, 117)}...`;
}
