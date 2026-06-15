import test from "node:test";
import assert from "node:assert/strict";
import { isOpencodeCompletionAuditEnabled, opencodeHeuristicCompletionAudit, } from "../adapters/opencode/completion-audit.js";
import { buildOpencodeBlockedAuditEvidence } from "../adapters/opencode/blocked-audit.js";
const now = "2026-06-02T00:00:00.000Z";
function makeMessage(overrides = {}) {
    return {
        id: overrides.id ?? "m1",
        role: overrides.role ?? "assistant",
        parts: overrides.parts ?? [{ type: "text", text: "no marker" }],
        time: overrides.time ?? { created: Date.parse(now), completed: Date.parse(now) },
        ...overrides,
    };
}
function makeGoal(overrides = {}) {
    return {
        sessionKey: "opencode:ses_1",
        goalId: "goal-1",
        objective: "ship a small migration",
        status: "active",
        tokensUsed: 0,
        timeUsedSeconds: 0,
        createdAt: now,
        updatedAt: now,
        goalTurnsSinceAuditReset: 0,
        ...overrides,
    };
}
function makeRequest(evidence = {}) {
    return {
        goal: makeGoal(),
        ledgerEvents: [],
        completionEvidence: {
            source: "opencode-session-transcript",
            verificationSignals: evidence.verificationSignals ?? [],
            commands: evidence.commands ?? [],
            toolNames: evidence.toolNames ?? [],
        },
    };
}
test("opencode completion heuristic approves transcripts with verification signals", () => {
    const result = opencodeHeuristicCompletionAudit(makeRequest({ commands: ["npm test"] }));
    assert.equal(result.approved, true);
    assert.equal(result.source, "opencode-transcript-heuristic-auditor");
});
test("opencode completion heuristic approves transcripts with task-relevant tool evidence", () => {
    const result = opencodeHeuristicCompletionAudit(makeRequest({ toolNames: ["bash"] }));
    assert.equal(result.approved, true);
});
test("opencode completion heuristic rejects pure self-certification", () => {
    const result = opencodeHeuristicCompletionAudit(makeRequest({}));
    assert.equal(result.approved, false);
    assert.match(result.report ?? "", /Inspect current artifacts/);
});
test("isOpencodeCompletionAuditEnabled defaults to heuristic and respects off switch", () => {
    const previous = process.env.AGENT_GOAL_COMPLETION_AUDIT;
    process.env.AGENT_GOAL_COMPLETION_AUDIT = "off";
    try {
        assert.equal(isOpencodeCompletionAuditEnabled(), false);
    }
    finally {
        if (previous === undefined)
            delete process.env.AGENT_GOAL_COMPLETION_AUDIT;
        else
            process.env.AGENT_GOAL_COMPLETION_AUDIT = previous;
    }
});
test("opencode blocked audit reports insufficient turns when only one goal turn is available", () => {
    const messages = [
        makeMessage({ id: "a1", parts: [{ type: "text", text: "SUBAGENT_BLOCKED: cannot proceed without credentials" }] }),
    ];
    const evidence = buildOpencodeBlockedAuditEvidence({
        messages,
        threshold: 3,
        goalCreatedAt: now,
    });
    assert.equal(evidence.consecutiveMatchingTurns, 0);
    assert.equal(evidence.source, "opencode-session-transcript");
    assert.match(evidence.reason ?? "", /only 1 recent goal turn/);
});
test("opencode blocked audit counts consecutive matching blocker signatures", () => {
    const messages = [
        makeMessage({ id: "a1", parts: [{ type: "text", text: "SUBAGENT_BLOCKED: cannot proceed without credentials" }] }),
        makeMessage({ id: "a2", parts: [{ type: "text", text: "SUBAGENT_BLOCKED: cannot proceed without credentials" }] }),
        makeMessage({ id: "a3", parts: [{ type: "text", text: "SUBAGENT_BLOCKED: cannot proceed without credentials" }] }),
    ];
    const evidence = buildOpencodeBlockedAuditEvidence({
        messages,
        threshold: 3,
        goalCreatedAt: now,
    });
    assert.equal(evidence.consecutiveMatchingTurns, 3);
    assert.equal(evidence.reason, undefined);
    assert.match(evidence.blockerSignature ?? "", /cannot proceed/);
});
test("opencode blocked audit rejects when recent signatures differ", () => {
    const messages = [
        makeMessage({ id: "a1", parts: [{ type: "text", text: "SUBAGENT_BLOCKED: cannot proceed without credentials" }] }),
        makeMessage({ id: "a2", parts: [{ type: "text", text: "SUBAGENT_BLOCKED: missing API key" }] }),
        makeMessage({ id: "a3", parts: [{ type: "text", text: "SUBAGENT_BLOCKED: cannot proceed without credentials" }] }),
    ];
    const evidence = buildOpencodeBlockedAuditEvidence({
        messages,
        threshold: 3,
        goalCreatedAt: now,
    });
    // Only the most recent turn matches the latest signature; the
    // middle turn breaks the streak, so consecutive matches < threshold.
    assert.equal(evidence.consecutiveMatchingTurns, 1);
    assert.match(evidence.reason ?? "", /not the same/);
});
//# sourceMappingURL=opencode-completion-blocked-audit.test.js.map