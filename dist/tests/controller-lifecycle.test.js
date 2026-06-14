import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { adapterObservationFromHarnessState, attachPreparedResourcesToNode, buildRecoveryRuleDraft, createDefaultControllerExceptionHandler, FileRecoveryRuleStore, GoalRuntime, MemoryGoalStore, activateRecoveryRule, observationKindFromHarnessState, projectLifecyclePhaseToNodeStatus, recordRecoveryDecisionOnNode, SQLiteGoalStore, withGoalDagNodeLifecyclePhase, } from "../core/index.js";
const now = "2026-06-11T00:00:00.000Z";
function node(overrides = {}) {
    return {
        goalId: "goal-1",
        nodeId: "node-1",
        slug: "node-1",
        objective: "Implement node lifecycle",
        dependencyNodeIds: [],
        expectedOutputs: [],
        validators: [],
        completionGates: ["controller-validation"],
        status: "ready",
        createdAt: now,
        updatedAt: now,
        ...overrides,
    };
}
test("lifecycle phases project to compatible coarse statuses", () => {
    assert.equal(projectLifecyclePhaseToNodeStatus("acceptanceDefined"), "ready");
    assert.equal(projectLifecyclePhaseToNodeStatus("resourcesCreating"), "running");
    assert.equal(projectLifecyclePhaseToNodeStatus("resourcesReady"), "ready");
    assert.equal(projectLifecyclePhaseToNodeStatus("runnerStarting"), "running");
    assert.equal(projectLifecyclePhaseToNodeStatus("runnerActive"), "running");
    assert.equal(projectLifecyclePhaseToNodeStatus("controllerJudging"), "controllerValidating");
    assert.equal(projectLifecyclePhaseToNodeStatus("validating"), "controllerValidating");
    assert.equal(projectLifecyclePhaseToNodeStatus("integrating"), "controllerValidating");
    assert.equal(projectLifecyclePhaseToNodeStatus("terminal", "blocked"), "blocked");
});
test("lifecycle helpers attach prepared resources and recovery decisions", () => {
    const accepted = withGoalDagNodeLifecyclePhase(node(), "acceptanceDefined", { now });
    assert.equal(accepted.lifecyclePhase, "acceptanceDefined");
    assert.equal(accepted.status, "ready");
    const withResources = attachPreparedResourcesToNode(accepted, {
        subagentId: "subagent-node-1",
        adapterId: "pi",
        workspacePath: "/repo/.worktrees/node-1",
        branch: "goal/node-1",
    }, { phase: "resourcesReady", now });
    assert.equal(withResources.lifecyclePhase, "resourcesReady");
    assert.equal(withResources.preparedResources?.workspacePath, "/repo/.worktrees/node-1");
    assert.equal(withResources.preparedResources?.createdAt, now);
    const decided = recordRecoveryDecisionOnNode(withResources, {
        action: "sendPromptToSameSession",
        reason: "protocol marker missing",
        at: now,
    }, { phase: "controllerJudging", now });
    assert.equal(decided.lifecyclePhase, "controllerJudging");
    assert.equal(decided.lastRecoveryDecision?.action, "sendPromptToSameSession");
    assert.equal(decided.lastValidationSummary, "protocol marker missing");
});
test("adapter observations distinguish formal outcomes from abnormal observations", () => {
    assert.equal(observationKindFromHarnessState({ status: "running" }), "running");
    assert.equal(observationKindFromHarnessState({ status: "idle" }), "idle");
    assert.equal(observationKindFromHarnessState({ status: "selfReportedComplete", selfReportedResult: "done" }), "selfReportedComplete");
    assert.equal(observationKindFromHarnessState({ status: "blocked", selfReportedResult: "need input" }), "selfReportedBlocked");
    assert.equal(observationKindFromHarnessState({ status: "needsFollowup", selfReportedResult: "done without marker" }), "protocolViolation");
    assert.equal(observationKindFromHarnessState({ status: "failed", error: "background runner is not live" }), "runnerLost");
    assert.equal(observationKindFromHarnessState({ status: "failed", error: "server_error" }), "runnerError");
    const observation = adapterObservationFromHarnessState("pi", { status: "failed", error: "server_error", metadata: { entryCount: 3 } }, { at: now });
    assert.deepEqual(observation, {
        adapterId: "pi",
        kind: "runnerError",
        at: now,
        summary: undefined,
        error: "server_error",
        evidence: { entryCount: 3 },
    });
});
test("default exception handler returns durable decisions and rule drafts", async () => {
    const handler = createDefaultControllerExceptionHandler({ repeatedFailureRuleThreshold: 2, now: () => new Date(now) });
    const observation = {
        adapterId: "pi",
        kind: "protocolViolation",
        at: now,
        summary: "done without marker",
    };
    const decision = await handler({ goalId: "goal-1", node: node(), observation, now });
    assert.equal(decision.action, "sendPromptToSameSession");
    assert.match(decision.prompt ?? "", /SUBAGENT_RESULT/);
    const repeated = await handler({ goalId: "goal-1", node: node(), observation, recentMatchingFailures: 2, now });
    assert.equal(repeated.action, "proposeRecoveryRule");
    const draft = buildRecoveryRuleDraft({ goalId: "goal-1", node: node(), observation, now }, repeated, { now });
    assert.equal(draft.adapterId, "pi");
    assert.equal(draft.observationKind, "protocolViolation");
    assert.equal(draft.activationState, "proposed");
    assert.equal(draft.proposedDecision.action, "proposeRecoveryRule");
});
test("recovery rules persist as artifacts and require activation policy before automatic use", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-goal-recovery-rules-"));
    try {
        const store = new FileRecoveryRuleStore(dir);
        const observation = {
            adapterId: "pi",
            kind: "protocolViolation",
            at: now,
            summary: "done without marker",
        };
        const proposalHandler = createDefaultControllerExceptionHandler({
            repeatedFailureRuleThreshold: 1,
            recoveryRuleStore: store,
            now: () => new Date(now),
        });
        const proposedDecision = await proposalHandler({ goalId: "goal-1", node: node(), observation, recentMatchingFailures: 1, now });
        assert.equal(proposedDecision.action, "proposeRecoveryRule");
        const proposed = (await store.listRecoveryRules())[0];
        assert.equal(proposed?.activationState, "proposed");
        assert.equal(proposed?.lastValidationResult?.status, "pending");
        const modelCalls = [];
        const inactiveHandler = createDefaultControllerExceptionHandler({
            recoveryRuleStore: store,
            controllerModelDiagnostic: (request) => {
                modelCalls.push(request.signature);
                return { ...request.deterministicDecision, action: "sendPromptToSameSession", prompt: "diagnosed" };
            },
            now: () => new Date(now),
        });
        const inactiveSameSignature = await inactiveHandler({ goalId: "goal-1", node: node(), observation, now });
        assert.equal(inactiveSameSignature.action, "sendPromptToSameSession");
        assert.equal(inactiveSameSignature.ruleId, undefined);
        const inactiveDecision = await inactiveHandler({ goalId: "goal-1", node: node(), observation: { ...observation, kind: "selfReportedBlocked" }, now });
        assert.equal(inactiveDecision.action, "sendPromptToSameSession");
        assert.equal(modelCalls.length, 1);
        const enabled = activateRecoveryRule({
            ...proposed,
            proposedDecision: {
                action: "sendPromptToSameSession",
                reason: "known marker recovery",
                at: now,
                prompt: "Use marker",
            },
            lastValidationResult: { status: "passed", at: now, summary: "reviewed" },
        }, { now });
        await store.upsertRecoveryRule(enabled);
        const ruleHandler = createDefaultControllerExceptionHandler({
            recoveryRuleStore: store,
            controllerModelDiagnostic: () => {
                throw new Error("model should not be called for enabled deterministic rule");
            },
            now: () => new Date(now),
        });
        const ruleDecision = await ruleHandler({ goalId: "goal-1", node: node(), observation, now });
        assert.equal(ruleDecision.action, "sendPromptToSameSession");
        assert.equal(ruleDecision.ruleId, enabled.ruleId);
        assert.equal(ruleDecision.evidence?.activationState, "enabled");
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
test("default exception handler classifies legacy recovery families into durable decisions", async () => {
    const handler = createDefaultControllerExceptionHandler({ now: () => new Date(now) });
    const base = { goalId: "goal-1", node: node(), now, maxRetries: 2 };
    assert.equal((await handler({ ...base, observation: { adapterId: "pi", kind: "runnerError", at: now, error: "timeout" } })).action, "sendPromptToSameSession");
    assert.equal((await handler({ ...base, observation: { adapterId: "pi", kind: "runnerError", at: now, error: "quota exceeded" } })).action, "markNodeBlocked");
    assert.equal((await handler({ ...base, observation: { adapterId: "pi", kind: "runnerError", at: now, error: "context_length_exceeded" } })).action, "invokeControllerModel");
    assert.equal((await handler({ ...base, observation: { adapterId: "pi", kind: "runnerError", at: now, error: "session file not found" } })).action, "restartRunnerSameWorktreeNewSession");
    assert.equal((await handler({ ...base, retryCount: 2, observation: { adapterId: "pi", kind: "runnerError", at: now, error: "terminated" } })).action, "restartRunnerSameWorktreeNewSession");
    assert.equal((await handler({ ...base, observation: { adapterId: "pi", kind: "runnerLost", at: now, error: "background runner is not live" } })).action, "restartRunnerSameSession");
});
test("runtime stores lifecycle/resource/recovery records in memory and sqlite stores", async () => {
    const prepared = attachPreparedResourcesToNode(withGoalDagNodeLifecyclePhase(node(), "resourcesReady", { now }), {
        subagentId: "subagent-node-1",
        adapterId: "pi",
        workspacePath: "/repo/.worktrees/node-1",
        branch: "goal/node-1",
    }, { phase: "resourcesReady", now });
    const enriched = recordRecoveryDecisionOnNode(prepared, {
        action: "restartRunnerSameSession",
        reason: "runner lost",
        at: now,
        evidence: { runnerPid: 123 },
    }, { now });
    const subagent = {
        goalId: "goal-1",
        nodeId: "node-1",
        subagentId: "subagent-node-1",
        harnessAdapterId: "pi",
        status: "running",
        prompts: ["initial"],
        attemptId: "subagent-node-1-attempt-1",
        attemptStartedAt: now,
        attemptCursor: { at: now, source: "controller-start", messageIndex: 10 },
        lastActionAttempt: {
            actionId: "promptDispatch-goal-1-subagent-node-1",
            actionKind: "promptDispatch",
            startedAt: now,
            deadlineAt: "2026-06-11T00:01:00.000Z",
            status: "timedOut",
            error: "timeout",
        },
        recoveryLoopSignature: "pi:protocolViolation:x:sendPromptToSameSession",
        createdAt: now,
        updatedAt: now,
    };
    const memoryRuntime = new GoalRuntime({ store: new MemoryGoalStore() });
    await memoryRuntime.saveGoalDagNode(enriched);
    await memoryRuntime.saveGoalSubagent(subagent);
    const fromMemory = await memoryRuntime.getGoalDagNode("goal-1", "node-1");
    const memorySubagent = await memoryRuntime.getGoalSubagent("goal-1", "subagent-node-1");
    assert.equal(fromMemory?.lifecyclePhase, "resourcesReady");
    assert.equal(fromMemory?.preparedResources?.branch, "goal/node-1");
    assert.equal(fromMemory?.lastRecoveryDecision?.action, "restartRunnerSameSession");
    assert.equal(memorySubagent?.attemptCursor?.messageIndex, 10);
    assert.equal(memorySubagent?.lastActionAttempt?.status, "timedOut");
    const dir = mkdtempSync(join(tmpdir(), "agent-goal-lifecycle-test-"));
    try {
        const sqlite = new SQLiteGoalStore({ dbPath: join(dir, "goals.sqlite") });
        const sqliteRuntime = new GoalRuntime({ store: sqlite });
        await sqliteRuntime.saveGoalDagNode(enriched);
        await sqliteRuntime.saveGoalSubagent(subagent);
        const fromSqlite = await sqliteRuntime.getGoalDagNode("goal-1", "node-1");
        const sqliteSubagent = await sqliteRuntime.getGoalSubagent("goal-1", "subagent-node-1");
        assert.equal(fromSqlite?.lifecyclePhase, "resourcesReady");
        assert.equal(fromSqlite?.preparedResources?.workspacePath, "/repo/.worktrees/node-1");
        assert.equal(fromSqlite?.lastRecoveryDecision?.evidence?.runnerPid, 123);
        assert.equal(sqliteSubagent?.attemptId, "subagent-node-1-attempt-1");
        assert.equal(sqliteSubagent?.attemptCursor?.source, "controller-start");
        assert.equal(sqliteSubagent?.lastActionAttempt?.actionKind, "promptDispatch");
        assert.equal(sqliteSubagent?.recoveryLoopSignature, "pi:protocolViolation:x:sendPromptToSameSession");
        sqlite.close?.();
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
//# sourceMappingURL=controller-lifecycle.test.js.map