import test from "node:test";
import assert from "node:assert/strict";
import { MemoryGoalStore } from "../core/index.js";
import { PI_GOAL_SESSION_ENTRY_TYPE, PiSessionGoalMirrorStore, readPiGoalSessionMirrorEntries, } from "../adapters/pi/session-store.js";
const fixedNow = new Date("2026-05-31T00:00:00.000Z");
function makeStore(entries = []) {
    return new PiSessionGoalMirrorStore(new MemoryGoalStore(), (data) => entries.push(data), { now: () => fixedNow });
}
test("Pi session mirror appends goal snapshots while delegating canonical reads", async () => {
    const entries = [];
    const store = makeStore(entries);
    const goal = {
        sessionKey: "pi:s1",
        goalId: "g1",
        objective: "finish",
        status: "active",
        tokensUsed: 0,
        timeUsedSeconds: 0,
        createdAt: fixedNow.toISOString(),
        updatedAt: fixedNow.toISOString(),
        goalTurnsSinceAuditReset: 0,
    };
    await store.saveGoal(goal);
    assert.deepEqual(await store.getCurrentGoal("pi:s1"), goal);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.kind, "goal_snapshot");
    assert.equal(entries[0]?.at, fixedNow.toISOString());
});
test("Pi session mirror records clears and ledger events", async () => {
    const entries = [];
    const store = makeStore(entries);
    const event = {
        eventId: "e1",
        sessionKey: "pi:s1",
        goalId: "g1",
        type: "goal_created",
        at: fixedNow.toISOString(),
    };
    await store.appendLedgerEvent(event);
    await store.clearGoal("pi:s1");
    assert.equal(entries[0]?.kind, "ledger_event");
    assert.equal(entries[1]?.kind, "goal_cleared");
});
test("reads valid Pi custom mirror entries from session entries", () => {
    const mirrored = readPiGoalSessionMirrorEntries([
        {
            type: "custom",
            customType: PI_GOAL_SESSION_ENTRY_TYPE,
            data: { version: 1, kind: "goal_cleared", sessionKey: "pi:s1", at: fixedNow.toISOString() },
        },
        { type: "custom", customType: "other", data: { version: 1, kind: "goal_cleared" } },
        { type: "custom", customType: PI_GOAL_SESSION_ENTRY_TYPE, data: { version: 99, kind: "goal_cleared" } },
    ]);
    assert.deepEqual(mirrored, [
        { version: 1, kind: "goal_cleared", sessionKey: "pi:s1", at: fixedNow.toISOString() },
    ]);
});
test("mirror append failures do not fail canonical store writes", async () => {
    const store = new PiSessionGoalMirrorStore(new MemoryGoalStore(), () => {
        throw new Error("append failed");
    });
    const goal = {
        sessionKey: "pi:s1",
        goalId: "g1",
        objective: "finish",
        status: "active",
        tokensUsed: 0,
        timeUsedSeconds: 0,
        createdAt: fixedNow.toISOString(),
        updatedAt: fixedNow.toISOString(),
        goalTurnsSinceAuditReset: 0,
    };
    await store.saveGoal(goal);
    assert.deepEqual(await store.getCurrentGoal("pi:s1"), goal);
});
//# sourceMappingURL=pi-session-store.test.js.map