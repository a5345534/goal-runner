import type { GoalControllerAuditDecision } from "./controller-audit.js";
import type { ContinuationReservation, GoalDagNode, GoalLedgerEvent, GoalRecord, GoalSessionMetadata, GoalStore, GoalSubagentRecord, GoalSummary, WorkspaceProfile } from "./types.js";
export interface GoalAuditDecisionRecord {
    decision: GoalControllerAuditDecision;
    finishedAt: string;
    appliedActionNames: string[];
}
export declare class MemoryGoalStore implements GoalStore {
    private goals;
    private reservations;
    private ledger;
    private metadata;
    private profiles;
    private dagNodes;
    private subagents;
    getCurrentGoal(sessionKey: string): Promise<GoalRecord | undefined>;
    saveGoal(goal: GoalRecord): Promise<void>;
    clearGoal(sessionKey: string): Promise<void>;
    getReservation(sessionKey: string): Promise<ContinuationReservation | undefined>;
    saveReservation(reservation: ContinuationReservation): Promise<void>;
    clearReservation(sessionKey: string): Promise<void>;
    clearExpiredReservations(now?: Date): Promise<number>;
    appendLedgerEvent(event: GoalLedgerEvent): Promise<void>;
    listLedgerEvents(sessionKey: string, goalId?: string): Promise<GoalLedgerEvent[]>;
    saveGoalSessionMetadata(metadata: GoalSessionMetadata): Promise<void>;
    getGoalSessionMetadata(sessionKey: string): Promise<GoalSessionMetadata | undefined>;
    listGoalSummaries(): Promise<GoalSummary[]>;
    saveGoalDagNode(node: GoalDagNode): Promise<void>;
    getGoalDagNode(goalId: string, nodeId: string): Promise<GoalDagNode | undefined>;
    listGoalDagNodes(goalId: string): Promise<GoalDagNode[]>;
    saveGoalSubagent(subagent: GoalSubagentRecord): Promise<void>;
    getGoalSubagent(goalId: string, subagentId: string): Promise<GoalSubagentRecord | undefined>;
    listGoalSubagents(goalId: string, nodeId?: string): Promise<GoalSubagentRecord[]>;
    saveWorkspaceProfile(profile: WorkspaceProfile): Promise<void>;
    getWorkspaceProfile(name: string): Promise<WorkspaceProfile | undefined>;
    listWorkspaceProfiles(): Promise<WorkspaceProfile[]>;
    deleteWorkspaceProfile(name: string): Promise<boolean>;
    pruneLedgerEvents(goalId: string, options: {
        maxEvents: number;
    }): Promise<number>;
    /**
     * Returns the latest controller audit decision and applied action names,
     * or `undefined` when no audit has completed for this goal.
     */
    getLatestAuditDecision(goalId: string): Promise<GoalAuditDecisionRecord | undefined>;
}
