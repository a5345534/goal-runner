export class MemoryGoalStore {
    goals = new Map();
    reservations = new Map();
    ledger = [];
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
}
function cloneLedgerEvent(event) {
    return {
        ...event,
        details: event.details ? { ...event.details } : undefined,
    };
}
//# sourceMappingURL=memory-store.js.map