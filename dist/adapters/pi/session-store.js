export const PI_GOAL_SESSION_ENTRY_TYPE = "agent-goal-runtime-state";
export const PI_GOAL_SESSION_ENTRY_VERSION = 1;
/**
 * Mirrors portable GoalStore writes into Pi custom session entries.
 *
 * The wrapped portable store remains canonical. Pi custom entries are an append-only
 * host-native trace that can follow Pi resume/fork/tree/compaction without making
 * Pi session files mandatory for non-Pi adapters.
 */
export class PiSessionGoalMirrorStore {
    primary;
    appendEntry;
    now;
    onMirrorError;
    constructor(primary, appendEntry, options = {}) {
        this.primary = primary;
        this.appendEntry = appendEntry;
        this.now = options.now ?? (() => new Date());
        this.onMirrorError = options.onMirrorError;
    }
    getCurrentGoal(sessionKey) {
        return this.primary.getCurrentGoal(sessionKey);
    }
    async saveGoal(goal) {
        await this.primary.saveGoal(goal);
        this.mirror({ version: 1, kind: "goal_snapshot", sessionKey: goal.sessionKey, goal, at: this.nowIso() });
    }
    async clearGoal(sessionKey) {
        await this.primary.clearGoal(sessionKey);
        this.mirror({ version: 1, kind: "goal_cleared", sessionKey, at: this.nowIso() });
    }
    getReservation(sessionKey) {
        return this.primary.getReservation(sessionKey);
    }
    async saveReservation(reservation) {
        await this.primary.saveReservation(reservation);
        this.mirror({
            version: 1,
            kind: "reservation_snapshot",
            sessionKey: reservation.sessionKey,
            reservation,
            at: this.nowIso(),
        });
    }
    async clearReservation(sessionKey) {
        await this.primary.clearReservation(sessionKey);
        this.mirror({ version: 1, kind: "reservation_cleared", sessionKey, at: this.nowIso() });
    }
    clearExpiredReservations(now) {
        return this.primary.clearExpiredReservations(now);
    }
    async appendLedgerEvent(event) {
        await this.primary.appendLedgerEvent(event);
        this.mirror({
            version: 1,
            kind: "ledger_event",
            sessionKey: event.sessionKey,
            goalId: event.goalId,
            event,
            at: this.nowIso(),
        });
    }
    listLedgerEvents(sessionKey, goalId) {
        return this.primary.listLedgerEvents(sessionKey, goalId);
    }
    close() {
        return this.primary.close?.();
    }
    mirror(data) {
        try {
            this.appendEntry(data);
        }
        catch (error) {
            this.onMirrorError?.(error);
        }
    }
    nowIso() {
        return this.now().toISOString();
    }
}
export function readPiGoalSessionMirrorEntries(entries) {
    const mirrored = [];
    for (const entry of entries) {
        if (entry.type !== "custom" || entry.customType !== PI_GOAL_SESSION_ENTRY_TYPE)
            continue;
        const data = entry.data;
        if (isPiGoalSessionEntryData(data))
            mirrored.push(data);
    }
    return mirrored;
}
function isPiGoalSessionEntryData(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return false;
    const record = value;
    if (record.version !== PI_GOAL_SESSION_ENTRY_VERSION || typeof record.kind !== "string")
        return false;
    if (typeof record.sessionKey !== "string" || typeof record.at !== "string")
        return false;
    switch (record.kind) {
        case "goal_snapshot":
            return isRecord(record.goal);
        case "goal_cleared":
        case "reservation_cleared":
            return true;
        case "reservation_snapshot":
            return isRecord(record.reservation);
        case "ledger_event":
            return isRecord(record.event);
        default:
            return false;
    }
}
function isRecord(value) {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
//# sourceMappingURL=session-store.js.map