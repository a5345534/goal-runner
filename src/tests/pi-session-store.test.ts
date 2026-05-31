import test from "node:test";
import assert from "node:assert/strict";
import { MemoryGoalStore, type GoalLedgerEvent, type GoalRecord, type GoalSessionMetadata, type WorkspaceProfile } from "../core/index.js";
import {
  PI_GOAL_SESSION_ENTRY_TYPE,
  PiSessionGoalMirrorStore,
  readPiGoalSessionMirrorEntries,
  type PiGoalSessionEntryData,
} from "../adapters/pi/session-store.js";

const fixedNow = new Date("2026-05-31T00:00:00.000Z");

function makeStore(entries: PiGoalSessionEntryData[] = []): PiSessionGoalMirrorStore {
  return new PiSessionGoalMirrorStore(new MemoryGoalStore(), (data) => entries.push(data), { now: () => fixedNow });
}

test("Pi session mirror appends goal snapshots while delegating canonical reads", async () => {
  const entries: PiGoalSessionEntryData[] = [];
  const store = makeStore(entries);
  const goal: GoalRecord = {
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
  const entries: PiGoalSessionEntryData[] = [];
  const store = makeStore(entries);
  const event: GoalLedgerEvent = {
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
  const goal: GoalRecord = {
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

test("Pi session mirror records goal metadata and workspace profiles", async () => {
  const entries: PiGoalSessionEntryData[] = [];
  const store = makeStore(entries);
  const metadata: GoalSessionMetadata = {
    sessionKey: "pi:goal",
    goalId: "g1",
    originSessionKey: "pi:controller",
    executionWorkspace: "/workspace",
    workspaceStatus: "configured",
    branch: "feat/a",
    branchVerificationStatus: "verified",
    createdAt: fixedNow.toISOString(),
    updatedAt: fixedNow.toISOString(),
  };
  const profile: WorkspaceProfile = {
    name: "prepared",
    path: "/workspace",
    kind: "git",
    branch: "feat/a",
    createdAt: fixedNow.toISOString(),
    updatedAt: fixedNow.toISOString(),
  };

  await store.saveGoalSessionMetadata(metadata);
  await store.saveWorkspaceProfile(profile);
  await store.deleteWorkspaceProfile("prepared");

  assert.deepEqual(await store.getGoalSessionMetadata("pi:goal"), metadata);
  assert.deepEqual(entries.map((entry) => entry.kind), ["goal_session_metadata", "workspace_profile", "workspace_profile_removed"]);
});
