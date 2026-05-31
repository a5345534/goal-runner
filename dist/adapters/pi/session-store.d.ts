import type { ContinuationReservation, GoalLedgerEvent, GoalRecord, GoalSessionMetadata, GoalStore, GoalSummary, WorkspaceProfile } from "../../core/index.js";
export declare const PI_GOAL_SESSION_ENTRY_TYPE = "agent-goal-runtime-state";
export declare const PI_GOAL_SESSION_ENTRY_VERSION = 1;
export type PiGoalSessionEntryData = {
    version: 1;
    kind: "goal_snapshot";
    sessionKey: string;
    goal: GoalRecord;
    at: string;
} | {
    version: 1;
    kind: "goal_cleared";
    sessionKey: string;
    at: string;
} | {
    version: 1;
    kind: "reservation_snapshot";
    sessionKey: string;
    reservation: ContinuationReservation;
    at: string;
} | {
    version: 1;
    kind: "reservation_cleared";
    sessionKey: string;
    at: string;
} | {
    version: 1;
    kind: "ledger_event";
    sessionKey: string;
    goalId?: string;
    event: GoalLedgerEvent;
    at: string;
} | {
    version: 1;
    kind: "goal_session_metadata";
    sessionKey: string;
    goalId: string;
    metadata: GoalSessionMetadata;
    at: string;
} | {
    version: 1;
    kind: "workspace_profile";
    profile: WorkspaceProfile;
    at: string;
} | {
    version: 1;
    kind: "workspace_profile_removed";
    name: string;
    at: string;
};
export interface PiSessionGoalMirrorStoreOptions {
    now?: () => Date;
    onMirrorError?: (error: unknown) => void;
}
/**
 * Mirrors portable GoalStore writes into Pi custom session entries.
 *
 * The wrapped portable store remains canonical. Pi custom entries are an append-only
 * host-native trace that can follow Pi resume/fork/tree/compaction without making
 * Pi session files mandatory for non-Pi adapters.
 */
export declare class PiSessionGoalMirrorStore implements GoalStore {
    private readonly primary;
    private readonly appendEntry;
    private readonly now;
    private readonly onMirrorError?;
    constructor(primary: GoalStore, appendEntry: (data: PiGoalSessionEntryData) => void, options?: PiSessionGoalMirrorStoreOptions);
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
    saveWorkspaceProfile(profile: WorkspaceProfile): Promise<void>;
    getWorkspaceProfile(name: string): Promise<WorkspaceProfile | undefined>;
    listWorkspaceProfiles(): Promise<WorkspaceProfile[]>;
    deleteWorkspaceProfile(name: string): Promise<boolean>;
    close(): Promise<void> | void;
    private mirror;
    private nowIso;
}
export declare function readPiGoalSessionMirrorEntries(entries: Array<Record<string, unknown>>): PiGoalSessionEntryData[];
