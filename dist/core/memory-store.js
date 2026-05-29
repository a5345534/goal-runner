export class MemoryGoalStore {
    goals = new Map();
    reservations = new Map();
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
}
//# sourceMappingURL=memory-store.js.map