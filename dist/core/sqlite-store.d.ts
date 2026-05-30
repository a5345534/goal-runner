import type { ContinuationReservation, GoalLedgerEvent, GoalRecord, GoalStore } from "./types.js";
export declare class SQLiteGoalStore implements GoalStore {
    readonly dbPath: string;
    private db;
    constructor(options?: {
        stateRoot?: string;
        dbPath?: string;
    });
    getCurrentGoal(sessionKey: string): Promise<GoalRecord | undefined>;
    saveGoal(goal: GoalRecord): Promise<void>;
    clearGoal(sessionKey: string): Promise<void>;
    getReservation(sessionKey: string): Promise<ContinuationReservation | undefined>;
    saveReservation(reservation: ContinuationReservation): Promise<void>;
    clearReservation(sessionKey: string): Promise<void>;
    clearExpiredReservations(now?: Date): Promise<number>;
    appendLedgerEvent(event: GoalLedgerEvent): Promise<void>;
    listLedgerEvents(sessionKey: string, goalId?: string): Promise<GoalLedgerEvent[]>;
    close(): void;
    private migrate;
}
