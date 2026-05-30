import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GoalRuntime, MemoryGoalStore, SQLiteGoalStore, type HiddenGoalTurnRequest } from "../core/index.js";

test("runtime keeps one current goal per session", async () => {
  const runtime = new GoalRuntime({ store: new MemoryGoalStore() });
  await runtime.createOrReplaceGoal("s1", "first");
  await runtime.createOrReplaceGoal("s1", "second");
  const result = await runtime.getGoal("s1");
  assert.equal(result.goal?.objective, "second");
  assert.equal(result.goal?.status, "active");
});

test("update_goal only accepts complete or blocked", async () => {
  const runtime = new GoalRuntime({ store: new MemoryGoalStore() });
  await runtime.createOrReplaceGoal("s1", "finish");
  await assert.rejects(() => runtime.toolUpdateGoal("s1", "paused"), /only accepts/);
  await runtime.toolUpdateGoal("s1", "complete");
  assert.equal((await runtime.getGoal("s1")).goal?.status, "complete");
});

test("blocked requires three goal turns", async () => {
  const runtime = new GoalRuntime({ store: new MemoryGoalStore(), config: { retryBaseDelayMs: 0, retryJitterMs: 0 } });
  await runtime.createOrReplaceGoal("s1", "blocked test");
  await runtime.turnStarted({ sessionKey: "s1", turnId: "t1" });
  await assert.rejects(() => runtime.toolUpdateGoal("s1", "blocked"), /3 consecutive/);
  await runtime.turnStarted({ sessionKey: "s1", turnId: "t2" });
  await runtime.turnStarted({ sessionKey: "s1", turnId: "t3" });
  await runtime.toolUpdateGoal("s1", "blocked");
  assert.equal((await runtime.getGoal("s1")).goal?.status, "blocked");
});

test("blocked audit evidence can reject non-matching blockers even after three turns", async () => {
  const runtime = new GoalRuntime({ store: new MemoryGoalStore(), config: { retryBaseDelayMs: 0, retryJitterMs: 0 } });
  await runtime.createOrReplaceGoal("s1", "blocked evidence test");
  await runtime.turnStarted({ sessionKey: "s1", turnId: "t1" });
  await runtime.turnStarted({ sessionKey: "s1", turnId: "t2" });
  await runtime.turnStarted({ sessionKey: "s1", turnId: "t3" });

  await assert.rejects(
    () =>
      runtime.toolUpdateGoal("s1", "blocked", {
        blockedAuditEvidence: {
          inspectedGoalTurns: 3,
          consecutiveMatchingTurns: 1,
          blockerSignature: "tool:error-a",
          reason: "recent blocker signatures are not the same",
          source: "test",
        },
      }),
    /matching blocker evidence/,
  );

  await runtime.toolUpdateGoal("s1", "blocked", {
    blockedAuditEvidence: {
      inspectedGoalTurns: 3,
      consecutiveMatchingTurns: 3,
      blockerSignature: "tool:error-a",
      source: "test",
    },
  });
  assert.equal((await runtime.getGoal("s1")).goal?.status, "blocked");
});

test("idle active goal starts hidden continuation once", async () => {
  const store = new MemoryGoalStore();
  const requests: HiddenGoalTurnRequest[] = [];
  const runtime = new GoalRuntime({
    store,
    config: { retryBaseDelayMs: 0, retryJitterMs: 0 },
    callbacks: {
      readHarnessState: () => ({
        materialized: true,
        queuedUserInput: false,
        queuedTriggerTurn: false,
        continuationSuppressed: false,
      }),
      startHiddenGoalTurn: (request) => {
        requests.push(request);
        return { kind: "started", hostTurnId: "h1" };
      },
    },
  });
  await runtime.createOrReplaceGoal("s1", "continue me");
  assert.equal(requests.length, 1);
  const second = await runtime.maybeContinueIfIdle("s1");
  assert.deepEqual(second, { kind: "notEligible", reason: "continuation already reserved" });
  assert.equal(requests.length, 1);
});

test("active goal starts another hidden continuation after a hidden turn finishes", async () => {
  const requests: HiddenGoalTurnRequest[] = [];
  const runtime = new GoalRuntime({
    store: new MemoryGoalStore(),
    config: { retryBaseDelayMs: 0, retryJitterMs: 0 },
    callbacks: {
      readHarnessState: () => ({
        materialized: true,
        queuedUserInput: false,
        queuedTriggerTurn: false,
        continuationSuppressed: false,
      }),
      startHiddenGoalTurn: (request) => {
        requests.push(request);
        return { kind: "started", hostTurnId: `h${requests.length}` };
      },
    },
  });

  await runtime.createOrReplaceGoal("s1", "continue until done");
  assert.equal(requests.length, 1);

  await runtime.turnStarted({ sessionKey: "s1", turnId: "hidden-1" });
  await runtime.toolCompleted({ sessionKey: "s1", turnId: "hidden-1", toolName: "bash", meaningfulProgress: true });
  await runtime.turnFinished({ sessionKey: "s1", turnId: "hidden-1" }, true);
  assert.equal(requests.length, 2);
  assert.notEqual(requests[0]?.attemptId, requests[1]?.attemptId);
});

test("retryable hidden-turn failure retries within bounds", async () => {
  let attempts = 0;
  const runtime = new GoalRuntime({
    store: new MemoryGoalStore(),
    config: { retryBaseDelayMs: 0, retryJitterMs: 0, maxContinuationAttempts: 3 },
    callbacks: {
      readHarnessState: () => ({
        materialized: true,
        queuedUserInput: false,
        queuedTriggerTurn: false,
        continuationSuppressed: false,
      }),
      startHiddenGoalTurn: () => {
        attempts += 1;
        return attempts < 3 ? { kind: "retryableFailure", error: "temporary" } : { kind: "started", hostTurnId: "h3" };
      },
    },
  });
  await runtime.createOrReplaceGoal("s1", "retry me");
  assert.equal(attempts, 3);
});

test("queued user input suppresses continuation", async () => {
  let attempts = 0;
  const runtime = new GoalRuntime({
    store: new MemoryGoalStore(),
    callbacks: {
      readHarnessState: () => ({
        materialized: true,
        queuedUserInput: true,
        queuedTriggerTurn: false,
        continuationSuppressed: false,
      }),
      startHiddenGoalTurn: () => {
        attempts += 1;
        return { kind: "started" };
      },
    },
  });
  const result = await runtime.createOrReplaceGoal("s1", "wait for user");
  assert.equal(result.goal?.status, "active");
  assert.equal(attempts, 0);
});

test("goal edit can update token budget without resetting usage", async () => {
  const runtime = new GoalRuntime({ store: new MemoryGoalStore() });
  await runtime.createOrReplaceGoal("s1", "old objective", { tokenBudget: 1_000 });
  await runtime.turnStarted({ sessionKey: "s1", turnId: "t1", tokenUsage: { totalTokens: 0 } });
  await runtime.toolCompleted({ sessionKey: "s1", tokenUsage: { totalTokens: 250 } });

  const result = await runtime.executeCommand("s1", "edit --tokens 500 new objective");

  assert.equal(result.goal?.objective, "new objective");
  assert.equal(result.goal?.tokenBudget, 500);
  assert.equal(result.goal?.tokensUsed, 250);
  assert.equal(result.goal?.status, "active");
});

test("goal edit becomes budget-limited when the new budget is already exhausted", async () => {
  const runtime = new GoalRuntime({ store: new MemoryGoalStore() });
  await runtime.createOrReplaceGoal("s1", "old objective", { tokenBudget: 1_000 });
  await runtime.turnStarted({ sessionKey: "s1", turnId: "t1", tokenUsage: { totalTokens: 0 } });
  await runtime.toolCompleted({ sessionKey: "s1", tokenUsage: { totalTokens: 250 } });

  const result = await runtime.executeCommand("s1", "edit --tokens 100 new objective");

  assert.equal(result.goal?.tokenBudget, 100);
  assert.equal(result.goal?.tokensUsed, 250);
  assert.equal(result.goal?.status, "budgetLimited");
});

test("budget-limited resume does not continue while budget remains exhausted", async () => {
  let attempts = 0;
  const runtime = new GoalRuntime({
    store: new MemoryGoalStore(),
    callbacks: {
      readHarnessState: () => ({
        materialized: true,
        queuedUserInput: false,
        queuedTriggerTurn: false,
        continuationSuppressed: false,
      }),
      startHiddenGoalTurn: () => {
        attempts += 1;
        return { kind: "started" };
      },
    },
  });

  await runtime.createOrReplaceGoal("s1", "budgeted", { tokenBudget: 100 });
  await runtime.turnStarted({ sessionKey: "s1", turnId: "t1", tokenUsage: { totalTokens: 0 } });
  await runtime.toolCompleted({ sessionKey: "s1", tokenUsage: { totalTokens: 150 } });
  attempts = 0;

  const result = await runtime.resumeGoal("s1");

  assert.equal(result.goal?.status, "budgetLimited");
  assert.equal(result.message, "Goal token budget is still exhausted.");
  assert.equal(attempts, 0);
});

test("unfinished failed turns do not auto-continue", async () => {
  let attempts = 0;
  const runtime = new GoalRuntime({
    store: new MemoryGoalStore(),
    callbacks: {
      readHarnessState: () => ({
        materialized: true,
        queuedUserInput: true,
        queuedTriggerTurn: false,
        continuationSuppressed: false,
      }),
      startHiddenGoalTurn: () => {
        attempts += 1;
        return { kind: "started" };
      },
    },
  });

  await runtime.createOrReplaceGoal("s1", "do not continue on abort");
  await runtime.turnStarted({ sessionKey: "s1", turnId: "t1" });
  await runtime.turnFinished({ sessionKey: "s1", turnId: "t1" }, false);

  assert.equal(attempts, 0);
  assert.equal((await runtime.getGoal("s1")).goal?.status, "active");
});

test("completed turns without meaningful progress do not auto-continue", async () => {
  let attempts = 0;
  const store = new MemoryGoalStore();
  const runtime = new GoalRuntime({
    store,
    callbacks: {
      readHarnessState: () => ({
        materialized: true,
        queuedUserInput: false,
        queuedTriggerTurn: false,
        continuationSuppressed: false,
      }),
      startHiddenGoalTurn: () => {
        attempts += 1;
        return { kind: "started" };
      },
    },
  });

  await runtime.createOrReplaceGoal("s1", "continue only after progress");
  assert.equal(attempts, 1);
  await runtime.turnStarted({ sessionKey: "s1", turnId: "t1" });
  await runtime.turnFinished({ sessionKey: "s1", turnId: "t1" }, true);

  assert.equal(attempts, 1);
  const ledger = await store.listLedgerEvents("s1");
  assert.equal(ledger.some((event) => event.type === "no_progress_continuation_suppressed"), true);
});

test("completion audit rejection keeps goal active and records evidence", async () => {
  const store = new MemoryGoalStore();
  const runtime = new GoalRuntime({
    store,
    callbacks: {
      collectCompletionEvidence: () => ({ source: "test", summary: "no tests" }),
      auditCompletion: () => ({ approved: false, source: "test-auditor", summary: "missing verification" }),
    },
  });

  await runtime.createOrReplaceGoal("s1", "finish with evidence");
  await runtime.turnStarted({ sessionKey: "s1", turnId: "t1" });
  const result = await runtime.toolUpdateGoal("s1", "complete");

  assert.equal(result.goal?.status, "active");
  assert.match(result.message, /rejected/);
  assert.equal(runtime.getCurrentTurnStop("s1")?.reason, "completionRejected");
  const ledger = await store.listLedgerEvents("s1", result.goal?.goalId);
  assert.equal(ledger.some((event) => event.type === "completion_audit_result" && event.details?.approved === false), true);
});

test("completion audit approval marks complete and records terminal event", async () => {
  const store = new MemoryGoalStore();
  const runtime = new GoalRuntime({
    store,
    callbacks: {
      collectCompletionEvidence: () => ({ source: "test", verificationSignals: ["npm test passed"] }),
      auditCompletion: () => ({ approved: true, source: "test-auditor", summary: "verified" }),
    },
  });

  await runtime.createOrReplaceGoal("s1", "finish with evidence");
  const result = await runtime.toolUpdateGoal("s1", "complete");

  assert.equal(result.goal?.status, "complete");
  const ledger = await store.listLedgerEvents("s1", result.goal?.goalId);
  assert.equal(ledger.some((event) => event.type === "goal_completed"), true);
});

test("sqlite store persists ledger events across reopen", async () => {
  const root = mkdtempSync(join(tmpdir(), "agent-goal-runtime-test-"));
  const dbPath = join(root, "goals.sqlite");
  try {
    const store = new SQLiteGoalStore({ dbPath });
    const runtime = new GoalRuntime({ store });
    const created = await runtime.createOrReplaceGoal("s1", "persist ledger");
    store.close();

    const reopened = new SQLiteGoalStore({ dbPath });
    const ledger = await reopened.listLedgerEvents("s1", created.goal?.goalId);
    assert.equal(ledger.some((event) => event.type === "goal_created"), true);
    reopened.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
